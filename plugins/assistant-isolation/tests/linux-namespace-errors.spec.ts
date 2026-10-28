import type { ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

const control = vi.hoisted(() => ({
  missingExecutable: undefined as string | undefined,
  children: [] as Array<{
    child: ChildProcess
    closed: Promise<void>
    pipeErrors: string[]
    processErrors: string[]
  }>,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] !== '/usr/bin/unshare') return actual.spawn(...args)
      const child = control.missingExecutable
        ? actual.spawn(control.missingExecutable, [], args[2])
        : actual.spawn(process.execPath, ['-e', 'process.exit(17)'], args[2])
      const pipeErrors: string[] = []
      const processErrors: string[] = []
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
      control.children.push({ child, closed, pipeErrors, processErrors })
      return child
    },
  }
})

import { runLinuxNamespace } from '../src/linux-namespace.js'

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('Linux namespace control pipe failures', () => {
  async function run(missing: boolean) {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-namespace-control-errors-'))
    const beforeStart = vi.fn()
    const afterExit = vi.fn()
    const onStop = vi.fn()
    control.children = []
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

  test('revokes a failed spawn and observes the child close without admission', async () => {
    const { spawned } = await run(true)
    expect(spawned.processErrors).toEqual(['ENOENT'])
    expect(spawned.child.pid).toBeUndefined()
  })
})
