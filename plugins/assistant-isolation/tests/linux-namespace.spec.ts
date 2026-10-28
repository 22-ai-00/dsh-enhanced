import { chmod, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { runLinuxNamespace, type LinuxNamespaceInput, type LinuxCandidateIdentity } from '../src/linux-namespace.js'

const available = process.platform === 'linux' && process.getuid?.() !== 0
  && spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--fork', '--net', '/bin/true']).status === 0
  && spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
    '--', '/usr/bin/true']).status === 0

describe.skipIf(!available)('real Linux namespace execution', () => {
  async function run(override: Partial<LinuxNamespaceInput>) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-linux-namespace-test-'))
    const controller = new AbortController()
    const seen: { start?: LinuxCandidateIdentity; exit?: LinuxCandidateIdentity; stopped?: boolean } = {}
    const input: LinuxNamespaceInput = {
      stateRoot, argv: ['/bin/sh', '-c', 'printf hello'], files: [], artifacts: [],
      workspaceBytes: 1024 * 1024, workspaceInodes: 128,
      tmpBytes: 1024 * 1024, tmpInodes: 128, timeoutMs: 5000, maxOutputBytes: 8192,
      profile: 'ordinary', signal: controller.signal,
      beforeKeeperStart: () => {},
      beforeStart: identity => { seen.start = identity },
      afterExit: exit => { seen.exit = exit },
      onStop: () => { seen.stopped = true },
      ...override,
    }
    try { return { result: await runLinuxNamespace(input), seen, controller } }
    finally { await rm(stateRoot, { recursive: true, force: true }) }
  }

  test('runs only after gate admission and exports a bounded text artifact', async () => {
    let admitted = false
    const { result } = await run({
      argv: ['/bin/sh', '-c', 'printf hello; printf saved > report.txt'], artifacts: ['report.txt'],
      beforeStart: async identity => {
        expect(identity.pid).toBeGreaterThan(1)
        expect(identity.startTicks).toBeGreaterThan(0)
        await new Promise(resolve => setTimeout(resolve, 30))
        admitted = true
      },
      afterExit: () => { expect(admitted).toBe(true) },
    })
    expect(result).toMatchObject({ status: 'succeeded', namespaceExited: true, stdout: 'hello',
      artifacts: [{ path: 'report.txt', content: 'saved' }] })
  })

  test('keeps the exact keeper PID outside namespaces and staging until durable admission', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-keeper-admission-'))
    const namespaceId = `${randomUUID()}-${randomBytes(16).toString('hex')}`
    const jobPath = join(stateRoot, `namespace-${namespaceId}`)
    let keeper: LinuxCandidateIdentity | undefined
    try {
      const { result } = await run({ stateRoot, namespaceId,
        files: [{ path: 'staged.txt', content: 'private' }],
        argv: ['/bin/sh', '-c', 'test -f staged.txt && printf admitted'],
        beforeKeeperStart: async identity => {
          keeper = identity
          expect(await readdir(stateRoot)).toEqual([`namespace-${namespaceId}`])
          for (let sample = 0; sample < 2; sample++) {
            expect(await readdir(jobPath)).toEqual([])
            expect(await readFile(`/proc/${identity.pid}/comm`, 'utf8')).toBe('sh\n')
            expect((await readFile(`/proc/${identity.pid}/task/${identity.pid}/children`, 'utf8')).trim()).toBe('')
            for (const name of ['user', 'mnt', 'net']) {
              expect(await readlink(`/proc/${identity.pid}/ns/${name}`)).toBe(await readlink(`/proc/self/ns/${name}`))
            }
            await new Promise(resolve => setTimeout(resolve, 30))
          }
        },
        beforeStart: async () => {
          expect(keeper).toBeDefined()
          expect((await readFile(`/proc/${keeper!.pid}/cmdline`, 'utf8')).startsWith('/usr/bin/unshare\0')).toBe(true)
          const raw = await readFile(`/proc/${keeper!.pid}/stat`, 'utf8')
          expect(Number(raw.slice(raw.lastIndexOf(')') + 2).trim().split(' ')[19])).toBe(keeper!.startTicks)
        },
      })
      expect(result).toMatchObject({ status: 'succeeded', stdout: 'admitted', namespaceExited: true })
      expect(await readdir(stateRoot)).toEqual([])
    } finally { await rm(stateRoot, { recursive: true, force: true }) }
  })

  test.each(['reject', 'timeout', 'abort'] as const)('does not release keeper admission after %s, including a late callback', async mode => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-keeper-revoked-'))
    const controller = new AbortController()
    let late: (() => void) | undefined
    let candidateStarted = false
    let keeper: LinuxCandidateIdentity | undefined
    const before = Date.now()
    try {
      const { result } = await run({ stateRoot, signal: controller.signal,
        timeoutMs: mode === 'timeout' ? 200 : 5000,
        beforeKeeperStart: async identity => {
          keeper = identity
          expect(await readdir(join(stateRoot, (await readdir(stateRoot))[0]!))).toEqual([])
          if (mode === 'reject') throw new Error('keeper admission rejected')
          if (mode === 'abort') setTimeout(() => controller.abort(), 30)
          await new Promise<void>(resolve => { late = resolve })
        },
        beforeStart: () => { candidateStarted = true },
      })
      expect(Date.now() - before).toBeLessThan(3000)
      expect(result).toMatchObject({ status: mode === 'reject' ? 'unknown' : mode === 'abort' ? 'cancelled' : 'timed-out',
        namespaceExited: true, artifacts: [] })
      expect(candidateStarted).toBe(false)
      expect(keeper).toBeDefined()
      expect(spawnSync('/bin/kill', ['-0', String(keeper!.pid)]).status).not.toBe(0)
      late?.()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(candidateStarted).toBe(false)
      expect(await readdir(stateRoot)).toEqual([])
    } finally { late?.(); await rm(stateRoot, { recursive: true, force: true }) }
  })

  test('the waiting keeper exits on Host disconnect before admission completes', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-keeper-host-loss-'))
    const marker = join(stateRoot, 'keeper.json')
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-namespace.ts')).href
    const script = `import {runLinuxNamespace} from ${JSON.stringify(entry)};
import {writeFile} from 'node:fs/promises';
await runLinuxNamespace({stateRoot:${JSON.stringify(stateRoot)},argv:['/usr/bin/true'],files:[],
workspaceBytes:1048576,workspaceInodes:128,tmpBytes:1048576,tmpInodes:128,timeoutMs:20000,maxOutputBytes:8192,
profile:'ordinary',signal:new AbortController().signal,
beforeKeeperStart:async identity=>{await writeFile(${JSON.stringify(marker)},JSON.stringify(identity)); await new Promise(()=>{});},
beforeStart:()=>{throw Error('candidate must not start');},afterExit:()=>{},onStop:()=>{}});`
    const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' } })
    let diagnostic = ''
    host.stderr.on('data', chunk => { diagnostic += String(chunk) })
    let keeper: LinuxCandidateIdentity | undefined
    const live = async (): Promise<boolean> => {
      if (!keeper) return false
      try {
        const raw = await readFile(`/proc/${keeper.pid}/stat`, 'utf8')
        const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(' ')
        return fields[0] !== 'Z' && Number(fields[19]) === keeper.startTicks
      } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error }
    }
    try {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !keeper) {
        try { keeper = JSON.parse(await readFile(marker, 'utf8')) as LinuxCandidateIdentity } catch {}
        if (!keeper) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(keeper, diagnostic).toBeDefined()
      expect(await readFile(`/proc/${keeper!.pid}/comm`, 'utf8')).toBe('sh\n')
      const stopped = new Promise<void>(resolveExit => host.once('close', () => resolveExit()))
      host.kill('SIGKILL')
      await stopped
      const until = Date.now() + 2000
      while (await live() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
      expect(await live()).toBe(false)
      const directories = (await readdir(stateRoot)).filter(name => name.startsWith('namespace-'))
      expect(directories).toHaveLength(1)
      expect(await readdir(join(stateRoot, directories[0]!))).toEqual([])
    } finally {
      host.kill('SIGKILL')
      if (await live()) { try { process.kill(keeper!.pid, 'SIGKILL') } catch {} }
      await rm(stateRoot, { recursive: true, force: true })
    }
  })

  test('stages and exports ordinary paths containing Unicode, spaces and shell syntax as literal filenames', async () => {
    const path = '中文 目录/结果 $(touch escaped).txt'
    const { result } = await run({ files: [{ path, content: '普通输入' }], artifacts: [path],
      argv: ['/usr/bin/python3', '-I', '-S', '-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert p.read_text()=="普通输入"; p.write_text("结果"); assert not pathlib.Path("escaped").exists()', path] })
    expect(result).toMatchObject({ status: 'succeeded', artifacts: [{ path, content: '结果' }] })
  })

  test('enforces the configured total artifact byte limit', async () => {
    const exact = await run({ maxArtifactBytes: 6, artifacts: ['a', 'b'],
      argv: ['/bin/sh', '-c', 'printf abc > a; printf def > b'] })
    expect(exact.result).toMatchObject({ status: 'succeeded', artifacts: [{ path: 'a', content: 'abc' }, { path: 'b', content: 'def' }] })
    const exceeded = await run({ maxArtifactBytes: 5, artifacts: ['a', 'b'],
      argv: ['/bin/sh', '-c', 'printf abc > a; printf def > b'] })
    expect(exceeded.result).toMatchObject({ status: 'unknown', namespaceExited: true, artifacts: [] })
    const large = await run({ maxArtifactBytes: 2, artifacts: ['a'], argv: ['/bin/sh', '-c', 'printf abc > a'] })
    expect(large.result).toMatchObject({ status: 'unknown', namespaceExited: true, artifacts: [] })
  })

  test.each([0, -1, 1_048_577, 1.5, NaN])('rejects invalid artifact byte limit %s before keeper admission', async maxArtifactBytes => {
    await expect(run({ maxArtifactBytes })).rejects.toThrow('invalid limits')
  })

  test.each(['/absolute', '../escape', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'control\nname', 'control\u007fname'])('rejects unsafe input path %j', async path => {
    await expect(run({ files: [{ path, content: 'x' }] })).rejects.toThrow('invalid input file')
    await expect(run({ artifacts: [path] })).rejects.toThrow('invalid artifact path')
  })

  test('rejects duplicate files, file parent collisions and duplicate artifacts', async () => {
    await expect(run({ files: [{ path: 'same', content: 'a' }, { path: 'same', content: 'b' }] })).rejects.toThrow('invalid input file')
    await expect(run({ files: [{ path: 'same', content: 'a' }, { path: 'same/child', content: 'b' }] })).rejects.toThrow('collide')
    await expect(run({ artifacts: ['same', 'same'] })).rejects.toThrow('invalid artifact path')
  })

  test.each(['../escape', randomUUID(), `${randomUUID()}-${'x'.repeat(32)}`, `${randomUUID()}-${'a'.repeat(31)}`])('rejects invalid namespace identity %s', async namespaceId => {
    await expect(run({ namespaceId })).rejects.toThrow('invalid namespace id')
  })

  test('cannot see host Home or sysfs, and network is disconnected', async () => {
    const { result } = await run({ argv: ['/usr/bin/python3', '-c',
      'import os,socket; s=socket.socket();\ntry: s.connect(("1.1.1.1",53)); print("bad")\nexcept OSError: print("isolated")\nprint(os.path.exists("/sys"),os.path.exists("/home"))'],
    })
    expect(result.status).toBe('succeeded')
    expect(result.stdout).toBe('isolated\nFalse False\n')
    const root = await run({ argv: ['/bin/sh', '-c', 'printf x > /escaped'] })
    expect(root.result.status).toBe('failed')
    const device = await run({ argv: ['/bin/sh', '-c', 'printf x > /dev/escaped'] })
    expect(device.result.status).toBe('failed')
  })

  test('loads seccomp for Node, Python and Bash without passing the policy descriptor to candidates', async () => {
    const node = await run({ argv: ['/usr/bin/node', '-e',
      'const fs=require("fs"); const s=fs.readFileSync("/proc/self/status","utf8"); '
        + 'const f=fs.existsSync("/proc/self/fd/4") ? fs.readlinkSync("/proc/self/fd/4") : "closed"; '
        + 'console.log(s.match(/^Seccomp:\\s*(\\d+)/m)[1],f.includes("seccomp.bpf"))'],
    })
    expect(node.result.status).toBe('succeeded')
    expect(node.result.stdout).toBe('2 false\n')
    const python = await run({ argv: ['/usr/bin/python3', '-c',
      'print(next(x.split(":",1)[1].strip() for x in open("/proc/self/status") if x.startswith("Seccomp:")))'],
    })
    expect(python.result).toMatchObject({ status: 'succeeded', stdout: '2\n' })
    const bash = await run({ argv: ['/usr/bin/bash', '-c', 'printf bash'] })
    expect(bash.result).toMatchObject({ status: 'succeeded', stdout: 'bash' })
  })

  test.each(['ordinary', 'repository'] as const)('keeps non-root identity, dropped caps and bounded shared memory for %s', async profile => {
    const { result } = await run({ profile, argv: ['/usr/bin/python3', '-I', '-S', '-c',
      'import os,pwd,pty\nfrom multiprocessing import shared_memory\n'
      + 'assert os.getuid()==65534 and os.getgid()==65534\n'
      + 'assert pwd.getpwuid(os.getuid()).pw_dir=="/workspace"\n'
      + 'assert int(next(x.split(":",1)[1].strip() for x in open("/proc/self/status") if x.startswith("CapEff:")),16)==0\n'
      + 'v=os.statvfs("/dev/shm"); assert v.f_blocks*v.f_frsize==1048576 and v.f_files==4096\n'
      + 's=shared_memory.SharedMemory(create=True,size=4096); s.buf[0]=42\n'
      + 't=shared_memory.SharedMemory(name=s.name); assert t.buf[0]==42\n'
      + 't.close(); s.close(); s.unlink()\n'
      + 'm,s=pty.openpty(); os.close(m); os.close(s)\nprint("compatible")'] })
    expect(result).toMatchObject({ status: 'succeeded', stdout: 'compatible\n' })
  })

  test('settles a gate that exits while external admission is pending', async () => {
    const { result, seen } = await run({ beforeStart: async identity => {
      process.kill(identity.pid, 'SIGKILL')
      await new Promise(resolve => setTimeout(resolve, 50))
    } })
    expect(result.status).toBe('unknown')
    expect(result.namespaceExited).toBe(true)
    expect(seen.stopped).toBe(true)
  })

  test('enforces workspace bytes and inode capacity', async () => {
    const space = await run({ workspaceBytes: 4096,
      argv: ['/usr/bin/python3', '-c', 'with open("big","wb") as f: f.write(b"x"*16384)'],
    })
    expect(space.result.status).toBe('failed')
    const inodes = await run({ workspaceInodes: 16,
      argv: ['/bin/sh', '-c', 'i=0; while [ "$i" -lt 40 ]; do : > "file-$i" || exit 17; i=$((i+1)); done'],
    })
    expect(inodes.result.status).toBe('failed')
  })

  test('rejects a symlink artifact and keeps it out of the result', async () => {
    const { result } = await run({ argv: ['/bin/sh', '-c', 'ln -s /usr/bin/sh report.txt'], artifacts: ['report.txt'] })
    expect(result.status).toBe('unknown')
    expect(result.namespaceExited).toBe(true)
    expect(result.artifacts).toEqual([])
  })

  test('repository candidate cannot remount or change an owner-managed runtime file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-linux-immutable-test-'))
    try {
      await writeFile(join(root, 'marker'), 'original', { mode: 0o444 })
      await chmod(root, 0o555)
      const { result } = await run({ profile: 'repository', readOnlyRoots: [root],
        argv: ['/bin/sh', '-c', 'mount -o remount,rw /runtime/0 >/tmp/remount 2>&1; '
          + 'chmod 600 /runtime/0/marker >/tmp/chmod 2>&1; '
          + 'printf tampered > /runtime/0/marker 2>/tmp/write; cat /runtime/0/marker'],
      })
      expect(result.status).toBe('succeeded')
      expect(result.stdout).toBe('original')
      expect(await readFile(join(root, 'marker'), 'utf8')).toBe('original')
      expect((await stat(join(root, 'marker'))).mode & 0o777).toBe(0o444)
    } finally {
      await chmod(root, 0o700)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('ordinary tasks cannot create another user namespace; repository checks can nest bwrap', async () => {
    const ordinary = await run({ argv: ['/usr/bin/unshare', '--user', '--map-root-user', '/usr/bin/true'] })
    expect(ordinary.result.status).toBe('failed')
    const repository = await run({ profile: 'repository', argv: ['/usr/bin/bwrap', '--unshare-all', '--unshare-user',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--symlink', 'usr/bin', '/bin', '--', '/usr/bin/true'] })
    expect(repository.result.status).toBe('succeeded')
  })

  test('times out a process tree', async () => {
    let started: LinuxCandidateIdentity | undefined
    const { result } = await run({ timeoutMs: 600,
      argv: ['/bin/sh', '-c', 'sleep 20 & wait'],
      beforeStart: identity => { started = identity },
    })
    expect(result.status, JSON.stringify(result)).toBe('timed-out')
    if (started) expect(spawnSync('/bin/kill', ['-0', String(started.pid)]).status).not.toBe(0)
  })

  test('times out an observed descendant tree and checks the captured process identities stopped', async () => {
    let observed: Promise<LinuxCandidateIdentity[]> | undefined
    const capture = async (pid: number, found: LinuxCandidateIdentity[]): Promise<boolean> => {
      try {
        const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
        const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(' ')
        found.push({ pid, startTicks: Number(fields[19]) })
        let sleep = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim() === 'sleep'
        const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim()
        for (const child of children ? children.split(/\s+/u).map(Number) : []) sleep = await capture(child, found) || sleep
        return sleep
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
        throw error
      }
    }
    const { result } = await run({ timeoutMs: 2500, argv: ['/bin/sh', '-c', 'sleep 30 & wait'],
      beforeStart: identity => {
        observed = (async () => {
          const until = Date.now() + 2000
          while (Date.now() < until) {
            const found: LinuxCandidateIdentity[] = []
            if (await capture(identity.pid, found)) return found
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          return []
        })()
      } })
    expect(result.status, JSON.stringify(result)).toBe('timed-out')
    const descendants = await observed
    expect(descendants, JSON.stringify(result)).toBeDefined()
    expect(descendants!.length).toBeGreaterThan(1)
    for (const item of descendants!) {
      try {
        const raw = await readFile(`/proc/${item.pid}/stat`, 'utf8')
        const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(' ')
        expect(fields[0] === 'Z' || fields[0] === 'X' || Number(fields[19]) !== item.startTicks,
          `captured process ${item.pid} is still executing`).toBe(true)
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    }
  }, 8000)

  test('reports cleanup failure as unknown and does not claim a clean stop', async () => {
    const { result } = await run({ timeoutMs: 600,
      argv: ['/bin/sh', '-c', 'sleep 20 & wait'],
      onStop: () => { throw new Error('group cleanup failed') },
    })
    expect(result.status).toBe('unknown')
    expect(result.namespaceExited).toBe(true)
    expect(result.reason).toContain('cleanup unproven: group cleanup failed')
  })

  test('bounds an unresponsive external cleanup callback', async () => {
    const before = Date.now()
    const { result } = await run({ timeoutMs: 300, argv: ['/usr/bin/sleep', '30'],
      onStop: () => new Promise(() => {}) })
    expect(Date.now() - before).toBeLessThan(8000)
    expect(result.status).toBe('unknown')
    expect(result.reason).toContain('cleanup exceeded deadline')
  }, 10_000)

  test('supports the worst-case JSON escaping of legal output and artifacts', async () => {
    const { result } = await run({ timeoutMs: 10_000, workspaceBytes: 2 * 1024 * 1024,
      maxOutputBytes: 1024 * 1024, artifacts: ['control.txt'], argv: ['/usr/bin/python3', '-I', '-S', '-c',
        'import sys; s="\\x01"*(1024*1024); open("control.txt","w").write(s); sys.stdout.write(s)'] })
    expect(result.status).toBe('succeeded')
    expect(result.stdout).toBe('\x01'.repeat(1024 * 1024))
    expect(result.artifacts).toEqual([{ path: 'control.txt', content: '\x01'.repeat(1024 * 1024) }])
  }, 15_000)

  test('omits invalid UTF-8 console bytes without expanding or failing the result', async () => {
    const { result } = await run({ maxOutputBytes: 1,
      argv: ['/usr/bin/python3', '-I', '-S', '-c', 'import os; os.write(1,bytes([255]))'] })
    expect(result).toMatchObject({ status: 'succeeded', stdout: '', stderr: '' })
  })

  test('keeps capability-gated syscalls denied in both profiles', async () => {
    const calls = process.arch === 'x64' ? [250, 321, 298] : [219, 280, 241]
    const script = `import ctypes,errno,json; c=ctypes.CDLL(None,use_errno=True); values=[]
for n in ${JSON.stringify(calls)}:
 ctypes.set_errno(0); v=c.syscall(n,0,0,0,0,0,0); assert v==-1 and ctypes.get_errno()==errno.EPERM; values.append(n)
assert next(x.split(':',1)[1].strip() for x in open('/proc/self/status') if x.startswith('NoNewPrivs:'))=='1'
print('denied')`
    for (const profile of ['ordinary', 'repository'] as const) {
      const { result } = await run({ profile, argv: ['/usr/bin/python3', '-I', '-S', '-c', script] })
      expect(result).toMatchObject({ status: 'succeeded', stdout: 'denied\n' })
    }
  })

  test.each(['SIGKILL', 'SIGSTOP'] as const)('keeper revokes the process tree independently of a Host receiving %s', async hostSignal => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-linux-host-crash-'))
    const marker = join(stateRoot, 'candidate.json')
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-namespace.ts')).href
    const script = `import {runLinuxNamespace} from ${JSON.stringify(entry)};
import {writeFile} from 'node:fs/promises';
await runLinuxNamespace({stateRoot:${JSON.stringify(stateRoot)},argv:['/bin/sh','-c','sleep 30 & wait'],files:[],
workspaceBytes:1048576,workspaceInodes:128,tmpBytes:1048576,tmpInodes:128,timeoutMs:20000,maxOutputBytes:8192,
profile:'ordinary',signal:new AbortController().signal,beforeKeeperStart:()=>{},
beforeStart:identity=>writeFile(${JSON.stringify(marker)},JSON.stringify(identity)),afterExit:()=>{},onStop:()=>{}});`
    const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      hostSignal === 'SIGSTOP' ? script.replace('timeoutMs:20000', 'timeoutMs:2000') : script],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' } })
    let diagnostic = ''
    host.stderr.on('data', chunk => { diagnostic += String(chunk) })
    let candidate: LinuxCandidateIdentity | undefined
    const descendants: LinuxCandidateIdentity[] = []
    const live = async (pid: number, ticks?: number): Promise<boolean> => {
      try { const content = await readFile(`/proc/${pid}/stat`, 'utf8')
        const fields = content.slice(content.lastIndexOf(') ') + 2).split(' ')
        return fields[0] !== 'Z' && (ticks === undefined || Number(fields[19]) === ticks)
      } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error }
    }
    try {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        try {
          candidate = JSON.parse(await readFile(marker, 'utf8')) as LinuxCandidateIdentity
          if ((await readFile(`/proc/${candidate.pid}/cmdline`, 'utf8')).includes('bwrap')) break
        } catch { /* The gate marker and exec are asynchronous. */ }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(candidate, diagnostic).toBeDefined()
      expect((await readFile(`/proc/${candidate!.pid}/cmdline`, 'utf8')).includes('bwrap')).toBe(true)
      const capture = async (pid: number): Promise<void> => {
        try {
          const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
          descendants.push({ pid, startTicks: Number(raw.slice(raw.lastIndexOf(') ') + 2).split(' ')[19]) })
          const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim()
          for (const child of children ? children.split(/\s+/u).map(Number) : []) await capture(child)
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
      }
      const processDeadline = Date.now() + 3000
      let sawSleep = false
      while (Date.now() < processDeadline) {
        descendants.length = 0
        await capture(host.pid!)
        const names = await Promise.all(descendants.map(item => readFile(`/proc/${item.pid}/comm`, 'utf8').catch(() => '')))
        if (names.some(name => name.trim() === 'sleep')) { sawSleep = true; break }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(descendants.length).toBeGreaterThan(4)
      expect(sawSleep).toBe(true)
      const stopped = new Promise<void>(resolveExit => host.once('close', () => resolveExit()))
      host.kill(hostSignal)
      if (hostSignal === 'SIGKILL') await stopped
      const remaining = descendants.filter(item => item.pid !== host.pid)
      const until = Date.now() + 4000
      while ((await Promise.all(remaining.map(item => live(item.pid, item.startTicks)))).some(Boolean) && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      for (const item of remaining) expect(await live(item.pid, item.startTicks), `process ${item.pid} survived Host loss`).toBe(false)
      if (hostSignal === 'SIGSTOP') {
        host.kill('SIGCONT')
        await stopped
      }
    } finally {
      host.kill('SIGKILL')
      // Only this test's still-live gate, identified by start time, may be stopped.
      if (candidate && await live(candidate.pid)) {
        const raw = await readFile(`/proc/${candidate.pid}/stat`, 'utf8')
        if (Number(raw.slice(raw.lastIndexOf(') ') + 2).split(' ')[19]) === candidate.startTicks) {
          try { process.kill(-candidate.pid, 'SIGKILL') } catch {}
        }
      }
      await rm(stateRoot, { recursive: true, force: true })
    }
  }, 15_000)
})
