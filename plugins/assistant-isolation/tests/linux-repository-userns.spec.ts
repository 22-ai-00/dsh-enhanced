import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { describe, expect, test, vi } from 'vitest'
import { LinuxCgroupLease } from '../src/linux-cgroups.js'
import { runLinuxRepositoryNamespace, type LinuxCandidateIdentity, type LinuxRepositoryNamespaceInput } from '../src/linux-namespace.js'
import { inspectLinuxRepositoryCandidate, inspectLinuxUserNamespace,
  readLinuxUserNamespaceMapping, type LinuxRepositoryCandidateWitness, type LinuxUserNamespaceWitness } from '../src/linux-user-namespace.js'
import type { LinuxSystemSnapshot } from '../src/linux-system-snapshot.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const snapshotFile = process.env.DSH_LINUX_SYSTEM_SNAPSHOT_JSON
const enabled = process.platform === 'linux' && process.env.DSH_NATIVE_CGROUP_REAL === '1' && !!snapshotFile
const fixture = vi.hoisted(() => ({ keeper: undefined as import('node:child_process').ChildProcess | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args)
    if (args[0] === '/bin/sh' && Array.isArray(args[1]) && args[1].includes('dsh-keeper-gate')) fixture.keeper = child
    return child
  } }
})
const roots = { mode: 'v1' as const, cpu: '/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-1001',
  memory: '/sys/fs/cgroup/memory/dsh-native/uid-1001', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1001',
  freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1001' }

describe('repository dual identity input boundary', () => {
  test('requires both metadata objects and both independent gates before any process', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-userns-shape-'))
    let started = false
    try {
      const bytes = Buffer.from('archive')
      const base: LinuxRepositoryNamespaceInput = { stateRoot, archive: { bytes, sha256: digest(bytes) },
        argv: ['/bin/true'], workspaceBytes: 4096, workspaceInodes: 16, tmpBytes: 4096, tmpInodes: 16,
        timeoutMs: 1000, maxOutputBytes: 4096, signal: new AbortController().signal,
        beforeKeeperStart: () => { started = true }, beforeStart: () => {}, afterExit: () => {}, onStop: () => {} }
      for (const extra of [{ userNamespace: {} }, { systemSnapshot: {} }, { onUserNamespaceReady: () => {} },
        { beforeCandidateExec: () => {} }]) {
        await expect(runLinuxRepositoryNamespace({ ...base, ...extra } as LinuxRepositoryNamespaceInput)).rejects.toThrow('both gates')
      }
      expect(started).toBe(false)
      expect(await readdir(stateRoot)).toEqual([])
    } finally { await rm(stateRoot, { recursive: true, force: true }) }
  })
})

describe.skipIf(!enabled)('real repository dual identity namespace', () => {
  async function run(change: (input: LinuxRepositoryNamespaceInput, phases: string[]) => void = () => {}) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-repository-userns-'))
    const mapping = await readLinuxUserNamespaceMapping()
    const decoded = JSON.parse(await readFile(snapshotFile!, 'utf8')) as { snapshot?: LinuxSystemSnapshot } & LinuxSystemSnapshot
    const systemSnapshot = decoded.snapshot ?? decoded
    const deadline = Date.now() + 30_000
    const create = () => LinuxCgroupLease.create({ roots, jobId: randomUUID(), nonce: randomBytes(16).toString('hex'),
      limits: { memoryMiB: 256, cpus: 1, pidsLimit: 64 }, deadline })
    const keeper = await create(), candidate = await create(), phases: string[] = []
    let witness: LinuxUserNamespaceWitness | undefined, outside: LinuxCandidateIdentity | undefined
    let candidateWitness: LinuxRepositoryCandidateWitness | undefined
    let keeperMemoryPeakBytes = 0
    const cleanup = async (lease: LinuxCgroupLease): Promise<void> => {
      if (lease === keeper) keeperMemoryPeakBytes = Math.max(keeperMemoryPeakBytes,
        Number((await readFile(join(keeper.snapshot.directories.memory!.path, 'memory.max_usage_in_bytes'), 'utf8')
          .catch(() => String(keeperMemoryPeakBytes))).trim()))
      const observed = await lease.observe()
      if (!observed.quiescent) {
        expect(await lease.terminateAndProve(3000)).toBe(true)
      }
      expect((await lease.observe()).quiescent).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
    }
    const bytes = Buffer.from([0, 255, 128, 10])
    const input: LinuxRepositoryNamespaceInput = { stateRoot, archive: { bytes, sha256: digest(bytes) },
      argv: ['/bin/sh', '-ec', 'cat /input/source.tar > result.bin; chmod 600 result.bin'], artifacts: ['result.bin'],
      workspaceBytes: 8 * 1024 ** 2, workspaceInodes: 128, tmpBytes: 8 * 1024 ** 2, tmpInodes: 128,
      timeoutMs: 20_000, maxOutputBytes: 16_384, signal: new AbortController().signal, userNamespace: mapping, systemSnapshot,
      beforeKeeperStart: async identity => {
        phases.push('keeper'); outside = identity
        await keeper.admit({ ...identity, startTicks: String(identity.startTicks), uid: mapping.ownerUid, bootId: keeper.snapshot.bootId })
      },
      onUserNamespaceReady: async identity => {
        witness = await inspectLinuxUserNamespace(mapping, identity)
        keeper.bindUserNamespace({ witness, outsideGate: { ...outside!, startTicks: String(outside!.startTicks),
          uid: mapping.ownerUid, bootId: keeper.snapshot.bootId } })
        candidate.bindUserNamespace({ witness })
        phases.push('namespace')
      },
      beforeStart: async identity => {
        phases.push('bwrap')
        await candidate.admit({ ...identity, startTicks: String(identity.startTicks), uid: mapping.ownerUid, bootId: candidate.snapshot.bootId })
      },
      beforeCandidateExec: async identity => {
        expect(witness).toBeDefined(); candidateWitness = await inspectLinuxRepositoryCandidate(witness!, identity); phases.push('entry')
      },
      afterExit: async () => { phases.push('proof'); await cleanup(candidate) },
      onStop: async () => { await cleanup(candidate); await cleanup(keeper) },
    }
    change(input, phases)
    try {
      const result = await runLinuxRepositoryNamespace(input)
      await cleanup(candidate); await cleanup(keeper)
      expect(await readdir(stateRoot)).toEqual([])
      if (process.env.DSH_LINUX_USERNS_EVIDENCE_PATH) await appendFile(process.env.DSH_LINUX_USERNS_EVIDENCE_PATH,
        JSON.stringify({ phases, witness, candidateWitness, keeperMemoryPeakBytes, keeper: keeper.snapshot, candidate: candidate.snapshot,
          archive: { size: input.archive.bytes.length, sha256: input.archive.sha256 },
          result: { ...result, artifacts: result.artifacts.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: file.sha256 })) },
          cleaned: true }) + '\n')
      return { result, phases, keeperMemoryPeakBytes }
    } finally {
      await cleanup(candidate); await cleanup(keeper)
      await rm(stateRoot, { recursive: true, force: true })
    }
  }

  test('binds both independent kernel witnesses and exports subordinate-owned binary after proof', async () => {
    const { result, phases, keeperMemoryPeakBytes } = await run()
    expect(result.status, JSON.stringify(result)).toBe('succeeded')
    expect(result.artifacts[0]?.bytes.equals(Buffer.from([0, 255, 128, 10]))).toBe(true)
    expect(phases).toEqual(['keeper', 'namespace', 'bwrap', 'entry', 'proof'])
    expect(keeperMemoryPeakBytes).toBeGreaterThan(0)
    expect(keeperMemoryPeakBytes).toBeLessThanOrEqual(256 * 1024 ** 2)
    console.info('dual identity keeper peak bytes', keeperMemoryPeakBytes)
  }, 30_000)

  test('transfers 2MiB without a structural Buffer assertion hiding transport duration', async () => {
    const bytes = Buffer.alloc(2 * 1024 ** 2, 255)
    const started = Date.now()
    const { result } = await run(input => { input.archive = { bytes, sha256: digest(bytes) } })
    expect(result.status, JSON.stringify({ ...result, artifacts: [] })).toBe('succeeded')
    expect(result.artifacts[0]?.bytes.equals(bytes)).toBe(true)
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 30_000)

  test('retains ownership, zero capabilities, syscall fence, private fds and nested readonly bwrap', async () => {
    const { result } = await run(input => {
      input.artifacts = []
      input.argv = ['/usr/bin/python3', '-I', '-S', '-c', `import errno,os,shutil,stat,subprocess
assert os.getresuid()==(65534,)*3 and os.getresgid()==(65534,)*3 and os.getgroups()==[]
s=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
assert all(int(s[k],16)==0 for k in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])
assert s['NoNewPrivs'].strip()=='1' and s['Seccomp'].strip()=='2'
assert os.stat('/usr/bin/bwrap').st_uid==0 and not os.access('/usr/bin/bwrap',os.W_OK)
assert os.stat('/tmp').st_uid==0 and stat.S_IMODE(os.stat('/tmp').st_mode)==0o1777
assert os.stat('/workspace').st_uid==65534 and os.stat('/dev/shm').st_uid==65534
assert open('/etc/hostname').read()=='dsh-sandbox\\n' and os.uname().nodename=='dsh-sandbox'
assert os.stat('/etc/hostname').st_uid==0 and stat.S_IMODE(os.stat('/etc/hostname').st_mode)==0o444
assert os.statvfs('/tmp').f_files==128
assert os.statvfs('/etc').f_files==16384 and os.statvfs('/etc').f_blocks*os.statvfs('/etc').f_frsize==8*1024**2
assert all(int(fd)<3 or not os.path.exists('/proc/self/fd/'+fd) for fd in os.listdir('/proc/self/fd'))
for p in ['/data00/home/jiataorui','/proc/self/root/data00/home/jiataorui','/proc/1/root/data00/home/jiataorui']:
 try: os.stat(p); raise AssertionError('Host visible')
 except OSError as e: assert e.errno in [errno.ENOENT,errno.EACCES]
try: os.setresuid(0,0,0); raise AssertionError('root regained')
except PermissionError: pass
try: open('/input/source.tar','wb'); raise AssertionError('input writable')
except OSError: pass
assert all('lo:' in line or ':' not in line for line in open('/proc/net/dev'))
shutil.copyfile('/usr/bin/true','/tmp/true'); os.chmod('/tmp/true',0o755)
subprocess.run(['/tmp/true'],check=True)
nested = ${JSON.stringify("import errno,os\nassert os.stat('/run').st_mode\ntry:\n open('/run/no','w')\n raise AssertionError('writable')\nexcept OSError as e:\n assert e.errno==errno.EROFS")}
subprocess.run(['/usr/bin/bwrap','--unshare-all','--uid','0','--gid','0','--ro-bind','/','/','--ro-bind','/run','/run','--proc','/proc','--dev','/dev','/usr/bin/python3','-I','-S','-c',nested],check=True)
assert [list(map(int,line.split())) for line in open('/proc/self/uid_map')]==[[0,${input.userNamespace!.ownerUid},1],[65534,${input.userNamespace!.candidateUid},1]]
print('bounded dual identity')`]
    })
    expect(result.status, JSON.stringify(result)).toBe('succeeded')
    expect(result.stdout).toBe('bounded dual identity\n')
  }, 30_000)

  test('times out an unresolved candidate binding without granting exec', async () => {
    const { result, phases } = await run(input => {
      // Both complete snapshot verifications belong to this same deadline.
      input.timeoutMs = 20_000
      const observe = input.beforeCandidateExec!
      input.beforeCandidateExec = async identity => { await observe(identity); return await new Promise(() => {}) }
    })
    expect(result.status, JSON.stringify(result)).toBe('timed-out')
    expect(result.artifacts).toEqual([])
    expect(phases).toContain('entry')
    expect(phases).not.toContain('proof')
  }, 30_000)

  test('fails closed when the Host control pipe closes at the dropped entry gate', async () => {
    const { result, phases } = await run(input => {
      const observe = input.beforeCandidateExec!
      input.beforeCandidateExec = async identity => {
        await observe(identity)
        expect(fixture.keeper?.stdin).toBeDefined()
        fixture.keeper!.stdin!.end()
      }
    })
    expect(result.status).toBe('unknown')
    expect(result.namespaceExited).toBe(true)
    expect(result.artifacts).toEqual([])
    expect(phases).toContain('entry')
    expect(phases).not.toContain('proof')
  }, 30_000)

  test.each(['namespace', 'entry'] as const)('revokes at %s binding without executing candidate code', async phase => {
    const controller = new AbortController()
    const { result, phases } = await run(input => {
      input.signal = controller.signal
      input.argv = ['/bin/sh', '-c', 'printf forbidden; touch ran']
      const original = phase === 'namespace' ? input.onUserNamespaceReady! : input.beforeCandidateExec!
      const hold = async (identity: LinuxCandidateIdentity) => {
        await original(identity)
        if (phase === 'entry') {
          const path = `/proc/${identity.pid}/cmdline`, before = await readFile(path)
          expect(before.toString()).toContain('/dsh-candidate-entry.py')
          await pause(30)
          expect((await readFile(path)).equals(before)).toBe(true)
        }
        controller.abort()
      }
      if (phase === 'namespace') input.onUserNamespaceReady = hold
      else input.beforeCandidateExec = hold
    })
    expect(result.status, JSON.stringify(result)).toBe('cancelled')
    expect(result.artifacts).toEqual([])
    expect(phases.includes('proof')).toBe(false)
    if (phase === 'namespace') expect(phases).not.toContain('bwrap')
  }, 30_000)

  test.each(['mapping', 'helper', 'snapshot'] as const)('rejects invalid %s before keeper admission', async kind => {
    let started = false
    await expect(run(input => {
      input.beforeKeeperStart = () => { started = true }
      if (kind === 'mapping') input.userNamespace = { ...input.userNamespace!, candidateUid: input.userNamespace!.ownerUid }
      if (kind === 'helper') input.userNamespace = { ...input.userNamespace!, helpers: { ...input.userNamespace!.helpers,
        uid: { path: '/usr/bin/newuidmap', sha256: '0'.repeat(64) } } }
      if (kind === 'snapshot') input.systemSnapshot = { ...input.systemSnapshot!, manifestSha256: '0'.repeat(64) }
    })).rejects.toThrow()
    expect(started).toBe(false)
  }, 30_000)
})
