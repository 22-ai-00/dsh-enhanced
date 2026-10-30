import type { ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

const control = vi.hoisted(() => ({
  missingExecutable: undefined as string | undefined,
  closeKeeperGate: false,
  protocolFixture: undefined as 'waiting' | 'ready' | 'complete' | undefined,
  onSpawn: undefined as (() => void) | undefined,
  onOutput: undefined as ((chunk: string) => void) | undefined,
  children: [] as Array<{
    child: ChildProcess
    closed: Promise<void>
    pipeErrors: string[]
    processErrors: string[]
    keeperPipeErrors: string[]
    ready: Promise<void>
  }>,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] !== '/bin/sh') return actual.spawn(...args)
      const child = control.missingExecutable
        ? actual.spawn(control.missingExecutable, [], args[2])
        : control.protocolFixture
          ? actual.spawn(process.execPath, ['-e', `
const fs=require('node:fs'), lines=require('node:readline').createInterface({input:process.stdin});
const ticks=Number(fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19]);
const identity={pid:process.pid,startTicks:ticks}; let configured=false;
const say=value=>process.stdout.write(JSON.stringify(value)+'\\n');
lines.on('line',line=>{
 if(!configured){configured=true; if(${JSON.stringify(control.protocolFixture)}!=='waiting')say({type:'READY',...identity});return;}
 if(line==='EXPIRE'){say({type:'ERROR',reason:'fixture worker deadline'});process.exitCode=1;lines.close();process.stdin.destroy();}
 if(line==='FAULT'){process.stdout.write('invalid protocol\\n');}
 if(line==='START')say({type:'EXIT',...identity,code:0,signal:null,exceeded:false});
 if(line==='EXPORT')say({type:'RESULT',status:'succeeded',stdout:'fixture',stderr:'',artifacts:[]});
});
lines.on('close',()=>process.stdin.destroy());
`], args[2])
        : control.closeKeeperGate
          ? actual.spawn('/bin/sh', ['-c', 'printf gate-ready >&2; exec /usr/bin/cat >/dev/null'], args[2])
          : actual.spawn(process.execPath, ['-e', 'process.exit(17)'], args[2])
      control.onSpawn?.()
      if (child.stdout && control.onOutput) {
        const stdout = child.stdout, emit = stdout.emit
        vi.spyOn(stdout, 'emit').mockImplementation((event, ...values) => {
          if (event === 'data') control.onOutput?.(String(values[0]))
          return emit.call(stdout, event, ...values)
        })
      }
      if (control.protocolFixture) {
        if (child.stdin) vi.spyOn(child.stdin, 'write')
        if (child.stdio[3]) vi.spyOn(child.stdio[3] as import('node:stream').Writable, 'end')
      }
      const pipeErrors: string[] = []
      const processErrors: string[] = []
      const keeperPipeErrors: string[] = []
      const ready = new Promise<void>(resolve => { child.stderr?.once('data', () => resolve()) })
      const keeperGate = child.stdio[3]
      if (keeperGate) {
        const emit = keeperGate.emit
        vi.spyOn(keeperGate, 'emit').mockImplementation((event, ...values) => {
          if (event === 'error') keeperPipeErrors.push((values[0] as NodeJS.ErrnoException).code ?? '')
          return emit.call(keeperGate, event, ...values)
        })
      }
      // Observe the real events without registering an error listener: removing
      // the production handler must still cause an unhandled Writable error.
      if (child.stdin) {
        const stdin = child.stdin
        const emit = stdin.emit
        vi.spyOn(stdin, 'emit').mockImplementation((event, ...values) => {
          if (event === 'error') pipeErrors.push((values[0] as NodeJS.ErrnoException).code ?? '')
          return emit.call(stdin, event, ...values)
        })
      }
      const emitter: EventEmitter = child
      const emit = emitter.emit
      vi.spyOn(emitter, 'emit').mockImplementation((event, ...values) => {
        if (event === 'error') processErrors.push((values[0] as NodeJS.ErrnoException).code ?? '')
        return emit.call(child, event, ...values)
      })
      const closed = new Promise<void>(resolve => { child.once('close', () => resolve()) })
      control.children.push({ child, closed, pipeErrors, processErrors, keeperPipeErrors, ready })
      return child
    },
  }
})

import { runLinuxNamespace } from '../src/linux-namespace.js'

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('Linux namespace control pipe failures', () => {
  async function run(missing: boolean, closeKeeperGate = false) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-namespace-control-errors-'))
    const beforeStart = vi.fn()
    const afterExit = vi.fn()
    const onStop = vi.fn()
    control.children = []
    control.closeKeeperGate = closeKeeperGate
    control.missingExecutable = missing ? join(stateRoot, 'missing-unshare') : undefined
    try {
      const result = await runLinuxNamespace({
        stateRoot, argv: ['/usr/bin/true'],
        // More than a pipe buffer, so an early exit interrupts a pending write.
        files: [{ path: 'input.txt', content: 'x'.repeat(1_048_576) }],
        workspaceBytes: 1024 * 1024, workspaceInodes: 128,
        tmpBytes: 1024 * 1024, tmpInodes: 128,
        timeoutMs: 5000, maxOutputBytes: 8192,
        profile: 'ordinary', signal: new AbortController().signal,
        beforeKeeperStart: async () => {
          if (!closeKeeperGate) return
          const spawned = control.children[0]!
          await spawned.ready
          spawned.child.kill('SIGKILL')
          // Keep the parent event loop ahead of the close event while the kernel
          // closes the peer. Node exposes this descriptor as a socket: the
          // pending read can observe ECONNRESET before the START write's EPIPE.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        },
        beforeStart, afterExit, onStop,
      })
      expect(control.children).toHaveLength(1)
      const spawned = control.children[0]!
      await spawned.closed
      expect(spawned.child.stdin?.destroyed).toBe(true)
      expect(result).toMatchObject({ status: 'unknown', stdout: '', stderr: '', artifacts: [] })
      expect(onStop).toHaveBeenCalledExactlyOnceWith(undefined)
      expect(beforeStart).not.toHaveBeenCalled()
      expect(afterExit).not.toHaveBeenCalled()
      return { result, spawned, remaining: await readdir(stateRoot) }
    } finally {
      for (const { child } of control.children) child.kill('SIGKILL')
      control.missingExecutable = undefined
      control.closeKeeperGate = false
      await rm(stateRoot, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  }

  test('revokes an early worker exit with a real EPIPE and survives the Writable error', async () => {
    const { result, spawned, remaining } = await run(false)
    expect(spawned.pipeErrors).toContain('EPIPE')
    expect(spawned.processErrors).toEqual([])
    expect(spawned.child.exitCode !== null || spawned.child.signalCode !== null).toBe(true)
    expect(result.namespaceExited).toBe(true)
    expect(remaining).toEqual([])
  })

  test('revokes a real keeper gate disconnect without an unhandled private-descriptor error', async () => {
    const { result, spawned, remaining } = await run(false, true)
    expect(spawned.keeperPipeErrors.length).toBeGreaterThan(0)
    expect(spawned.keeperPipeErrors.every(code => code === 'EPIPE' || code === 'ECONNRESET')).toBe(true)
    expect(spawned.child.stdio[3]?.destroyed).toBe(true)
    expect(spawned.processErrors).toEqual([])
    expect(spawned.child.exitCode !== null || spawned.child.signalCode !== null).toBe(true)
    expect(result.namespaceExited).toBe(true)
    expect(remaining).toEqual([])
  })

  test('revokes a failed spawn and observes the child close without admission', async () => {
    const { spawned } = await run(true)
    expect(spawned.processErrors).toEqual(['ENOENT'])
    expect(spawned.child.pid).toBeUndefined()
  })
})

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('Linux namespace shared deadline ordering', () => {
  type Scenario = 'worker-deadline' | 'setup-expired' | 'setup-partial' | 'keeper-expired'
    | 'candidate-expired' | 'protocol-before-deadline' | 'success-after-deadline' | 'deadline-cleanup-failed'
  async function run(scenario: Scenario) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-namespace-deadline-order-'))
    const clock = { now: 1_000_000 }, timeoutMs = 1234, deadline = clock.now + timeoutMs
    // Only Host wall-clock classification and timer dispatch are controlled.
    // Child pipes, exit/close events and /proc PID/start-time identities are real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    const timers = vi.spyOn(globalThis, 'setTimeout')
    control.children = []
    control.protocolFixture = ['worker-deadline', 'protocol-before-deadline', 'deadline-cleanup-failed'].includes(scenario)
      ? 'waiting' : 'complete'
    control.onSpawn = () => {
      if (scenario === 'setup-expired') clock.now = deadline + 1
      if (scenario === 'setup-partial') clock.now += 500
    }
    control.onOutput = chunk => {
      if (chunk.includes('fixture worker deadline') || scenario === 'success-after-deadline' && chunk.includes('RESULT')) {
        clock.now = deadline
      }
    }
    const beforeKeeperStart = vi.fn(() => {
      if (scenario === 'keeper-expired') { clock.now = deadline; return }
      if (scenario === 'setup-partial') throw new Error('pre-deadline setup failure')
      if (control.protocolFixture === 'waiting') {
        setImmediate(() => control.children[0]!.child.stdin?.write(scenario === 'protocol-before-deadline' ? 'FAULT\n' : 'EXPIRE\n'))
      }
    })
    const beforeStart = vi.fn(() => { if (scenario === 'candidate-expired') clock.now = deadline })
    const onStop = vi.fn(() => {
      if (scenario === 'protocol-before-deadline') clock.now = deadline + 1
      if (scenario === 'deadline-cleanup-failed') throw new Error('cleanup evidence unavailable')
    })
    try {
      const result = await runLinuxNamespace({ stateRoot, argv: ['/usr/bin/true'], files: [],
        workspaceBytes: 1048576, workspaceInodes: 128, tmpBytes: 1048576, tmpInodes: 128,
        timeoutMs, maxOutputBytes: 8192, profile: 'ordinary', signal: new AbortController().signal,
        beforeKeeperStart, beforeStart, afterExit: () => {}, onStop })
      const child = control.children[0]!.child
      const keeper = child.stdio[3] as import('node:stream').Writable
      return { result, beforeKeeperStart, beforeStart, onStop, hostDelay: timers.mock.calls[0]?.[1],
        candidateReleased: vi.mocked(child.stdin!.write).mock.calls.some(call => String(call[0]) === 'START\n'),
        keeperReleased: vi.mocked(keeper.end).mock.calls.some(call => String(call[0]) === 'START\n') }
    } finally {
      for (const { child, closed } of control.children) { child.kill('SIGKILL'); await closed }
      control.protocolFixture = undefined; control.onSpawn = undefined; control.onOutput = undefined
      vi.useRealTimers(); vi.restoreAllMocks()
      await rm(stateRoot, { recursive: true, force: true })
    }
  }

  test('classifies a worker deadline ERROR/close before the delayed Host timer as timed-out', async () => {
    const { result, onStop } = await run('worker-deadline')
    expect(result).toMatchObject({ status: 'timed-out', namespaceExited: true })
    expect(onStop).toHaveBeenCalledOnce()
  })

  test('arms the Host timer for the shared deadline remaining after setup', async () => {
    const { result, hostDelay } = await run('setup-partial')
    expect(hostDelay).toBe(734)
    expect(result).toMatchObject({ status: 'unknown', namespaceExited: true })
  })

  test('expires setup before keeper admission even when the Host timer has not dispatched', async () => {
    const { result, beforeKeeperStart, hostDelay, keeperReleased } = await run('setup-expired')
    expect(hostDelay).toBe(1)
    expect(result).toMatchObject({ status: 'timed-out', namespaceExited: true })
    expect(beforeKeeperStart).not.toHaveBeenCalled()
    expect(keeperReleased).toBe(false)
  })

  test.each(['keeper-expired', 'candidate-expired'] as const)('fences %s admission before releasing START', async scenario => {
    const { result, keeperReleased, candidateReleased } = await run(scenario)
    expect(result).toMatchObject({ status: 'timed-out', namespaceExited: true })
    expect(candidateReleased).toBe(false)
    if (scenario === 'keeper-expired') expect(keeperReleased).toBe(false)
  })

  test('keeps a protocol fault observed before the deadline unknown after cleanup crosses the deadline', async () => {
    const { result } = await run('protocol-before-deadline')
    expect(result).toMatchObject({ status: 'unknown', namespaceExited: true })
  })

  test('does not accept a late successful protocol result ahead of the delayed Host timer', async () => {
    const { result } = await run('success-after-deadline')
    expect(result).toMatchObject({ status: 'timed-out', namespaceExited: true })
  })

  test('retains unknown when cleanup evidence fails after a worker deadline', async () => {
    const { result } = await run('deadline-cleanup-failed')
    expect(result).toMatchObject({ status: 'unknown', namespaceExited: true })
    expect(result.reason).toContain('cleanup unproven: cleanup evidence unavailable')
  })
})
