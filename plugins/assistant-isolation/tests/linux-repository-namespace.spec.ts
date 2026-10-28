import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { LINUX_REPOSITORY_INPUT_MOUNT_BYTES, runLinuxNamespace, runLinuxRepositoryNamespace,
  type LinuxRepositoryNamespaceInput } from '../src/linux-namespace.js'

const fixture = vi.hoisted(() => ({ mode: undefined as string | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (!fixture.mode || args[0] !== '/bin/sh') return actual.spawn(...args)
    return actual.spawn(process.execPath, ['-e', `
const fs=require('node:fs'), net=require('node:net'), crypto=require('node:crypto');
const mode=${JSON.stringify(fixture.mode)}, lines=require('node:readline').createInterface({input:process.stdin});
const archive=new net.Socket({fd:4,readable:true,writable:false}); archive.resume();
const gate=new net.Socket({fd:3,readable:true,writable:false}); gate.resume();
const binary=new net.Socket({fd:5,readable:false,writable:true}); binary.on('error',()=>{});
const ticks=Number(fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19]);
const identity={pid:process.pid,startTicks:ticks}; let configured=false;
const say=value=>process.stdout.write(JSON.stringify(value)+'\\n');
lines.on('line',line=>{
 if(!configured){configured=true;if(mode==='early')binary.write(Buffer.from([0,255]));say({type:'READY',...identity});return;}
 if(line==='START')say({type:'EXIT',...identity,code:0,signal:null,exceeded:false});
 if(line==='EXPORT'){
  const bytes=Buffer.from(mode==='short'?[0]:mode==='long'?[0,255,1]:[0,255]);
  const sha=crypto.createHash('sha256').update(Buffer.from([0,255])).digest('hex');
  if(mode!=='missing EOF')binary.end(bytes);else binary.write(bytes);
  say({type:'RESULT',status:'succeeded',stdout:'',stderr:'',artifacts:mode==='empty extra'?[]:
    [{path:'result.bin',size:mode==='metadata'?3:2,sha256:mode==='digest'?'0'.repeat(64):sha}]});
 }
});
lines.on('close',()=>{archive.destroy();gate.destroy();binary.destroy();process.stdin.destroy()});
`], args[2])
  } }
})

const available = process.platform === 'linux' && process.getuid?.() !== 0
  && spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--fork', '--net', '/bin/true']).status === 0
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const source = Buffer.from([0, 255, 128, 10, 9, 65])

describe.skipIf(!available)('private Linux repository binary namespace', () => {
  async function run(override: Partial<LinuxRepositoryNamespaceInput> = {}) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-repository-namespace-'))
    const input: LinuxRepositoryNamespaceInput = {
      stateRoot, archive: { bytes: source, sha256: digest(source) },
      argv: ['/bin/sh', '-c', 'cat /input/source.tar > result.bin'], artifacts: ['result.bin'],
      workspaceBytes: 1024 ** 2, workspaceInodes: 128, tmpBytes: 1024 ** 2, tmpInodes: 128,
      timeoutMs: 5000, maxOutputBytes: 8192, signal: new AbortController().signal,
      beforeKeeperStart: () => {}, beforeStart: () => {}, afterExit: () => {}, onStop: () => {}, ...override,
    }
    try { return await runLinuxRepositoryNamespace(input) }
    finally { await rm(stateRoot, { recursive: true, force: true }) }
  }

  test('roundtrips binary NUL/non-UTF8 only after both admission gates and exit proof', async () => {
    const phases: string[] = []
    const result = await run({
      beforeKeeperStart: async () => { phases.push('keeper'); await new Promise(resolve => setTimeout(resolve, 20)) },
      beforeStart: () => { phases.push('candidate') },
      afterExit: async () => { phases.push('proof'); await new Promise(resolve => setTimeout(resolve, 30)) },
    })
    expect(result.status, JSON.stringify(result)).toBe('succeeded')
    expect(phases).toEqual(['keeper', 'candidate', 'proof'])
    expect(result.artifacts).toEqual([{ path: 'result.bin', bytes: source, sha256: digest(source) }])
  })

  test('uses a fixed bounded read-only archive mount and does not leak transport fds', async () => {
    const result = await run({ artifacts: [], argv: ['/usr/bin/python3', '-I', '-S', '-c',
      `import os
assert not os.path.exists('/proc/self/fd/4')
assert not os.path.exists('/proc/self/fd/5')
s=os.statvfs('/input/source.tar'); assert s.f_blocks*s.f_frsize==${LINUX_REPOSITORY_INPUT_MOUNT_BYTES}; assert s.f_files==16
try: open('/input/source.tar','wb'); raise AssertionError('writable archive')
except OSError: pass
print('bounded')`] })
    expect(result).toMatchObject({ status: 'succeeded', stdout: 'bounded\n', artifacts: [] })
  })

  test('allows 8GiB workspace and 4GiB executable tmp with nested bwrap', async () => {
    const result = await run({ workspaceBytes: 8 * 1024 ** 3, tmpBytes: 4 * 1024 ** 3,
      artifacts: [], argv: ['/bin/sh', '-ec',
        "cp /bin/true /tmp/true; /tmp/true; cp /bin/true /workspace/true; /workspace/true; "
        + 'bwrap --unshare-all --unshare-user --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 '
        + '--symlink usr/bin /bin -- /usr/bin/true'] })
    expect(result.status, JSON.stringify(result)).toBe('succeeded')
  })

  test('retains hard workspace and tmp inode limits', async () => {
    const result = await run({ workspaceInodes: 16, tmpInodes: 16, artifacts: [],
      argv: ['/usr/bin/python3', '-I', '-S', '-c', `import errno,os
for root in ['/workspace','/tmp']:
 count=0
 try:
  for n in range(32):
   open(root+'/'+str(n),'wb').close(); count+=1
 except OSError as e: assert e.errno==errno.ENOSPC
 assert count<16
print('bounded')`] })
    expect(result).toMatchObject({ status: 'succeeded', stdout: 'bounded\n' })
  })

  test.each(['ln -s /etc/passwd result.bin', 'touch result.bin; ln result.bin second',
    'mkdir result.bin', 'mkfifo result.bin'])('rejects unsafe artifact: %s', async command => {
    const result = await run({ argv: ['/bin/sh', '-ec', command] })
    expect(result.status).toBe('unknown')
    expect(result.artifacts).toEqual([])
  })

  test('rejects symlink artifact parents', async () => {
    const result = await run({ artifacts: ['linked/result.bin'],
      argv: ['/bin/sh', '-ec', 'mkdir actual; printf x > actual/result.bin; ln -s actual linked'] })
    expect(result.status).toBe('unknown')
    expect(result.artifacts).toEqual([])
  })

  test('rejects aggregate output limit plus one and returns no partial bytes', async () => {
    const result = await run({ artifacts: ['first', 'second'], maxArtifactBytes: 6,
      argv: ['/bin/sh', '-ec', 'printf 123 > first; printf 4567 > second'] })
    expect(result.status).toBe('unknown')
    expect(result.artifacts).toEqual([])
  })

  test('exports exact binary output limit and an empty artifact', async () => {
    const result = await run({ artifacts: ['result.bin', 'empty'], maxArtifactBytes: source.length,
      argv: ['/bin/sh', '-ec', 'cat /input/source.tar > result.bin; touch empty'] })
    expect(result.status, JSON.stringify(result)).toBe('succeeded')
    expect(result.artifacts[1]).toEqual({ path: 'empty', bytes: Buffer.alloc(0), sha256: digest(Buffer.alloc(0)) })
  })

  test('exports no bytes when the candidate fails or exit proof rejects', async () => {
    for (const override of [{ argv: ['/bin/sh', '-c', 'printf secret > result.bin; exit 3'] },
      { afterExit: () => { throw new Error('proof rejected') } }]) {
      const result = await run(override)
      expect(result.status).not.toBe('succeeded')
      expect(result.artifacts).toEqual([])
    }
  })

  test('aborts during archive admission and bounds one absolute deadline', async () => {
    const controller = new AbortController()
    const result = await run({ archive: { bytes: Buffer.alloc(8 * 1024 ** 2), sha256: digest(Buffer.alloc(8 * 1024 ** 2)) },
      signal: controller.signal, beforeStart: () => { controller.abort() } })
    expect(result.status).toBe('cancelled')
    expect(result.artifacts).toEqual([])
    const timed = await run({ timeoutMs: 200, beforeKeeperStart: () => new Promise(() => {}) })
    expect(timed.status).toBe('timed-out')
    expect(timed.artifacts).toEqual([])
  })

  test('rejects archive digest, empty/oversized input, unsafe paths and oversized output before spawning', async () => {
    const bad = [
      { archive: { bytes: source, sha256: '0'.repeat(64) } },
      { archive: { bytes: Buffer.alloc(0), sha256: digest(Buffer.alloc(0)) } },
      { archive: { bytes: Buffer.alloc(64 * 1024 ** 2 + 1), sha256: '0'.repeat(64) } },
      { artifacts: ['../escape'] }, { artifacts: ['nul\0path'] }, { maxArtifactBytes: 32 * 1024 ** 2 + 1 },
    ]
    for (const override of bad) await expect(run(override)).rejects.toThrow('linux namespace:')
  })

  test.each(['digest', 'short', 'long', 'metadata', 'early', 'empty extra', 'missing EOF'] as const)(
    'Host independently rejects %s binary transport', async mode => {
      fixture.mode = mode
      try {
        const result = await run({ timeoutMs: 500, artifacts: mode === 'empty extra' ? [] : ['result.bin'] })
        expect(result.status).not.toBe('succeeded')
        expect(result.artifacts).toEqual([])
        expect(result.namespaceExited).toBe(true)
      } finally { fixture.mode = undefined }
    })

  test('does not expand the legacy text repository API limits', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-legacy-repository-'))
    try {
      await expect(runLinuxNamespace({ stateRoot, files: [], argv: ['/bin/true'], profile: 'repository',
        workspaceBytes: 8 * 1024 ** 3, workspaceInodes: 16, tmpBytes: 4096, tmpInodes: 16,
        timeoutMs: 1000, maxOutputBytes: 10, signal: new AbortController().signal,
        beforeKeeperStart: () => {}, beforeStart: () => {}, afterExit: () => {}, onStop: () => {},
      })).rejects.toThrow('invalid limits')
    } finally { await rm(stateRoot, { recursive: true, force: true }) }
  })

  test('copies a 2MiB archive through both binary pipes end to end', async () => {
    const bytes = Buffer.alloc(2 * 1024 ** 2, 255)
    const result = await run({ archive: { bytes, sha256: digest(bytes) }, workspaceBytes: 4 * 1024 ** 2,
      argv: ['/bin/sh', '-ec', 'cp /input/source.tar result.bin'] })
    expect(result.status, JSON.stringify({ ...result, artifacts: [] })).toBe('succeeded')
    expect(result.artifacts).toEqual([{ path: 'result.bin', bytes, sha256: digest(bytes) }])
  })

  test('streams the maximum archive and binary output bounds without JSON expansion', async () => {
    const bytes = Buffer.alloc(64 * 1024 ** 2, 255)
    const result = await run({ archive: { bytes, sha256: digest(bytes) }, workspaceBytes: 40 * 1024 ** 2,
      timeoutMs: 10000, argv: ['/usr/bin/python3', '-I', '-S', '-c',
        "import shutil; f=open('/input/source.tar','rb'); o=open('result.bin','wb'); shutil.copyfileobj(f,o,65536)"],
      maxArtifactBytes: 32 * 1024 ** 2 })
    // Input reaches the candidate, but the kernel workspace byte limit stops a
    // 64MiB copy before export and no prefix can escape as a successful result.
    expect(result.status).toBe('failed')
    expect(result.artifacts).toEqual([])
    const maximum = await run({ workspaceBytes: 40 * 1024 ** 2, timeoutMs: 10000,
      argv: ['/usr/bin/python3', '-I', '-S', '-c',
        "f=open('result.bin','wb'); b=bytes([0,255])*32768; [f.write(b) for _ in range(512)]"] })
    expect(maximum.status, JSON.stringify({ ...maximum, artifacts: [] })).toBe('succeeded')
    expect(maximum.artifacts[0]!.bytes.length).toBe(32 * 1024 ** 2)
    expect(maximum.artifacts[0]!.sha256).toBe(digest(maximum.artifacts[0]!.bytes))
  }, 15000)

  async function rawWorker(overrides: Record<string, unknown> = {}, bytes: Buffer | null = source) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-raw-repository-'))
    const jobPath = join(stateRoot, 'job')
    await mkdir(jobPath, { mode: 0o700 })
    const worker = fileURLToPath(new URL('../runtime/linux-namespace-worker.mjs', import.meta.url))
    const child = spawn('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--fork',
      '--kill-child=SIGKILL', '--net', '--ipc', '--uts', process.execPath, worker],
    { stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } })
    let output = ''
    child.stdout!.on('data', chunk => { output += String(chunk) })
    child.stderr!.resume()
    const binary = (child.stdio as unknown as import('node:stream').Readable[])[5]!
    const archivePipe = child.stdio[4] as import('node:stream').Writable
    archivePipe.on('error', () => {})
    const closed = new Promise<number | null>(resolve => child.once('close', resolve))
    child.stdin!.on('error', () => {})
    child.stdin!.write(JSON.stringify({ schemaVersion: 2, profile: 'repository', jobPath,
      archive: { size: source.length, sha256: digest(source) },
      workspaceBytes: 40 * 1024 ** 2, workspaceInodes: 128, tmpBytes: 1048576, tmpInodes: 128,
      maxOutputBytes: 8192, maxArtifactBytes: 32 * 1024 ** 2, argv: ['/bin/true'], files: [], artifacts: [],
      readOnlyRoots: [], deadline: Date.now() + 5000, ...overrides }) + '\n')
    if (bytes) archivePipe.end(bytes)
    const message = async (type: string): Promise<Record<string, unknown>> => {
      const until = Date.now() + 5500
      while (Date.now() < until) {
        const found = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
          .find(value => value.type === type)
        if (found) return found
        if (child.exitCode !== null) throw new Error(output)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`message ${type} missing: ${output}`)
    }
    return { child, jobPath, binary, archivePipe, closed, message, output: () => output,
      cleanup: async () => { child.kill('SIGKILL'); archivePipe.destroy(); binary.destroy(); await closed; await rm(stateRoot, { recursive: true, force: true }) } }
  }

  test.each(['truncated', 'overflow', 'digest'] as const)('keeper independently rejects %s archive transport', async fault => {
    const raw = await rawWorker({ archive: { size: fault === 'overflow' ? source.length - 1 : source.length,
      sha256: fault === 'digest' ? '0'.repeat(64) : digest(source) } }, fault === 'truncated' ? source.subarray(0, -1) : source)
    raw.binary.resume()
    try {
      expect(await raw.closed).toBe(1)
      expect(raw.output()).toContain('archive input')
      expect(raw.output()).not.toContain('READY')
      expect(await readdir(raw.jobPath)).toContain('input')
    } finally { await raw.cleanup() }
  })

  test('keeper sends no early binary bytes and requires explicit EXPORT after EXIT', async () => {
    const raw = await rawWorker({ artifacts: ['out'], argv: ['/bin/sh', '-c', 'printf secret > out'] })
    let count = 0
    raw.binary.on('data', bytes => { count += bytes.length })
    try {
      await raw.message('READY')
      raw.child.stdin!.write('START\n')
      await raw.message('EXIT')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(count).toBe(0)
      expect(raw.output()).not.toContain('RESULT')
      raw.child.stdin!.write('EXPORT\n')
      expect(await raw.closed).toBe(0)
      expect(count).toBe(6)
      expect((await raw.message('RESULT')).artifacts).toEqual([{ path: 'out', size: 6, sha256: digest(Buffer.from('secret')) }])
    } finally { await raw.cleanup() }
  })

  test.each(['input disconnect', 'input stalled', 'output disconnect', 'output backpressure'] as const)('keeper bounds %s', async fault => {
    const raw = await rawWorker({ deadline: Date.now() + 700, artifacts: ['out'],
      argv: ['/usr/bin/python3', '-I', '-S', '-c', "f=open('out','wb'); b=bytes(65536); [f.write(b) for _ in range(512)]"] },
    fault.startsWith('input') ? null : source)
    try {
      if (fault.startsWith('input')) {
        raw.archivePipe.write(source.subarray(0, 1))
        if (fault === 'input disconnect') { raw.child.stdin!.destroy(); raw.archivePipe.destroy() }
      } else {
        await raw.message('READY')
        raw.child.stdin!.write('START\n')
        await raw.message('EXIT')
        raw.child.stdin!.write('EXPORT\n')
        if (fault === 'output disconnect') raw.binary.destroy()
        // Leave the binary pipe unread until the keeper's own watchdog fires.
        if (fault === 'output backpressure') { await raw.message('ERROR'); raw.binary.resume() }
      }
      expect(await raw.closed).toBe(1)
      expect(raw.output()).not.toContain('RESULT')
    } finally { await raw.cleanup() }
  })

  test('keeper rejects same-size artifact mutation during a backpressured export', async () => {
    const raw = await rawWorker({ artifacts: ['out'],
      argv: ['/usr/bin/python3', '-I', '-S', '-c', "f=open('out','wb'); b=bytes(65536); [f.write(b) for _ in range(512)]"] })
    try {
      const ready = await raw.message('READY')
      const status = await readFile(`/proc/${ready.pid}/status`, 'utf8')
      const keeper = Number(status.match(/^PPid:\s+(\d+)/mu)![1])
      raw.child.stdin!.write('START\n')
      await raw.message('EXIT')
      const first = new Promise<void>(resolve => raw.binary.once('data', () => { raw.binary.pause(); resolve() }))
      raw.child.stdin!.write('EXPORT\n')
      await Promise.race([first, raw.closed.then(() => { throw new Error(raw.output()) })])
      const file = await open(`/proc/${keeper}/root${raw.jobPath}/workspace/out`, 'r+')
      try { await file.write(Buffer.from([255]), 0, 1, 0) } finally { await file.close() }
      raw.binary.resume()
      expect(await raw.closed).toBe(1)
      expect(raw.output()).toContain('artifact metadata changed')
      expect(raw.output()).not.toContain('RESULT')
    } finally { await raw.cleanup() }
  })
})
