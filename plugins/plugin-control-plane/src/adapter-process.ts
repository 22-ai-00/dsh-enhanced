import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'

/** A deliberately small process owner for descriptor-pinned helpers.
 *
 * `detached` gives the direct child a fresh Linux process group.  This is a
 * cleanup boundary, not a sandbox: a helper which calls setsid(2) can leave
 * that group and is outside the guarantee made here.
 */
export type ControlledProcessErrorCode = 'START' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'NON_ZERO' | 'CLEANUP' | 'ABORTED'

export class ControlledProcessError extends Error {
  constructor(readonly code: ControlledProcessErrorCode, message: string) {
    super(message)
    this.name = 'ControlledProcessError'
  }
}

export interface ControlledProcessOptions {
  signal?: AbortSignal
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  stdio: Array<'pipe' | 'ignore' | number>
  stdin: string | undefined
  timeoutMs: number
  maximumOutput: number
}

const CLEANUP_GRACE_MS = 75
const CLEANUP_SETTLE_MS = 300
const OUTPUT_DRAIN_MS = 100
const POLL_MS = 25
const PROC_CONCURRENCY = 16
const MAX_PROC_ENTRIES = 4_096

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function remaining(deadline: number): number {
  const value = deadline - performance.now()
  if (value <= 0) throw new ControlledProcessError('CLEANUP', 'helper process-group cleanup exceeded its fixed deadline')
  return value
}

async function bounded<T>(work: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    // Observe work even if the deadline expired between starting IO and
    // installing this timer; a late rejection must not become unhandled.
    void work.then(value => { if (timer !== undefined) clearTimeout(timer); resolve(value) },
      error => { if (timer !== undefined) clearTimeout(timer); reject(error) })
    try {
      timer = setTimeout(() => reject(new ControlledProcessError('CLEANUP', 'helper process-group cleanup exceeded its fixed deadline')), remaining(deadline))
    } catch (error) { reject(error) }
  })
}

async function groupMembers(groupId: number, deadline: number): Promise<number[]> {
  let entries: string[]
  try { entries = await bounded(readdir('/proc'), deadline) } catch (error) {
    if (error instanceof ControlledProcessError) throw error
    throw new ControlledProcessError('CLEANUP', 'could not inspect the helper process group')
  }
  const processes = entries.filter(entry => /^\d+$/u.test(entry))
  if (processes.length > MAX_PROC_ENTRIES) throw new ControlledProcessError('CLEANUP', 'too many processes to prove helper process-group cleanup')
  const members: number[] = []
  let next = 0
  const inspect = async (): Promise<void> => {
    for (;;) {
      const entry = processes[next++]
      if (entry === undefined) return
      remaining(deadline)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), remaining(deadline))
      try {
        const source = await readFile(`/proc/${entry}/stat`, { encoding: 'utf8', signal: controller.signal })
        const close = source.lastIndexOf(')')
        // Fields after the comm are state (3), ppid (4), pgrp (5).  A zombie is
        // already dead, so it does not retain helper authority.
        const fields = source.slice(close + 2).trim().split(/\s+/u)
        if (close >= 1 && fields[0] !== 'Z' && Number(fields[2]) === groupId) members.push(Number(entry))
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw new ControlledProcessError('CLEANUP', 'could not inspect the helper process group')
      } finally { clearTimeout(timer) }
    }
  }
  try { await bounded(Promise.all(Array.from({ length: Math.min(PROC_CONCURRENCY, processes.length) }, inspect)).then(() => undefined), deadline) }
  catch (error) {
    if (error instanceof ControlledProcessError) throw error
    throw new ControlledProcessError('CLEANUP', 'could not inspect the helper process group')
  }
  return members
}

function signalGroup(groupId: number, signal: NodeJS.Signals): void {
  try { process.kill(-groupId, signal) } catch (error) {
    // ESRCH means the group disappeared between the inspection and signal.
    if (errorCode(error) !== 'ESRCH') throw new ControlledProcessError('CLEANUP', 'could not signal the helper process group')
  }
}

function groupExists(groupId: number): boolean {
  try { process.kill(-groupId, 0); return true } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    throw new ControlledProcessError('CLEANUP', 'could not inspect the helper process group')
  }
}

function pause(ms: number, deadline?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const wait = deadline === undefined ? ms : Math.min(ms, remaining(deadline))
    setTimeout(() => {
      try { if (deadline !== undefined) remaining(deadline); resolve() } catch (error) { reject(error) }
    }, wait)
  })
}

async function reclaimGroup(groupId: number, deadline: number): Promise<void> {
  // Always reclaim after the leader exits as well.  A successful leader can
  // otherwise leave a same-group writer holding stdout, preventing `close`.
  // ESRCH is the normal leader-exit fast path; it avoids a full /proc scan.
  if (!groupExists(groupId)) return
  try {
    signalGroup(groupId, 'SIGTERM')
    await pause(CLEANUP_GRACE_MS, deadline)
    if (!groupExists(groupId)) return
    // Do not make an observational failure a reason to skip forceful cleanup.
    // The scan only proves that SIGKILL succeeded; it does not gate SIGKILL.
    signalGroup(groupId, 'SIGKILL')
    while (performance.now() < deadline) {
      await pause(POLL_MS, deadline)
      if (!groupExists(groupId)) return
      const members = await groupMembers(groupId, deadline)
      if (members.length === 0) return
    }
    throw new ControlledProcessError('CLEANUP', 'could not prove the helper process group was reclaimed')
  } catch (error) {
    // A final best-effort kill also covers a failed /proc scan or deadline.
    try { signalGroup(groupId, 'SIGKILL') } catch { /* preserve original cleanup failure */ }
    throw error
  }
}

export async function executeControlledProcess(options: ControlledProcessOptions): Promise<string> {
  if (options.signal?.aborted) throw new ControlledProcessError('ABORTED', 'helper process cancelled')
  if (process.platform !== 'linux') throw new ControlledProcessError('START', 'controlled helper processes require Linux')
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(options.command, [...options.args], { env: options.env, shell: false, detached: true, stdio: options.stdio })
    } catch {
      reject(new ControlledProcessError('START', 'helper process could not start'))
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let cause: ControlledProcessErrorCode | undefined
    let leaderExited = false
    let settling = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let stdoutEnded = child.stdout === null
    let resolveStdoutEnd: (() => void) | undefined
    const stdoutEnd = new Promise<void>(resolve => { resolveStdoutEnd = resolve })
    let resolveLeaderExit: (() => void) | undefined
    const leaderExit = new Promise<void>(resolve => { resolveLeaderExit = resolve })

    const finish = (error: ControlledProcessError | undefined, output?: string): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
      child.stdout?.destroy()
      child.stdin?.destroy()
      if (error !== undefined) reject(error)
      else resolve(output ?? '')
    }
    const reclaimAndSettle = async (): Promise<void> => {
      if (settling || settled) return
      settling = true
      const groupId = child.pid
      const cleanupDeadline = performance.now() + CLEANUP_GRACE_MS + CLEANUP_SETTLE_MS
      try {
        if (groupId === undefined) throw new ControlledProcessError('START', 'helper process could not start')
        await reclaimGroup(groupId, cleanupDeadline)
        // A missing group is not proof that the direct leader has exited.  Do
        // not accept a scan race as successful termination.
        if (!leaderExited) await bounded(leaderExit, cleanupDeadline)
        if (!leaderExited) throw new ControlledProcessError('CLEANUP', 'could not observe the helper leader exit')
        if (cause === 'ABORTED') finish(new ControlledProcessError('ABORTED', 'helper process cancelled'))
        else if (cause === 'TIMEOUT') finish(new ControlledProcessError('TIMEOUT', 'helper process exceeded its deadline'))
        else if (cause === 'OUTPUT_LIMIT') finish(new ControlledProcessError('OUTPUT_LIMIT', 'helper process exceeded its output bound'))
        else if (cause === 'NON_ZERO') finish(new ControlledProcessError('NON_ZERO', 'helper process returned a non-zero status'))
        else if (cause === 'START') finish(new ControlledProcessError('START', 'helper process could not start or its output failed'))
        else {
          // `exit` can precede final pipe delivery.  The group is already
          // empty, so this is only a bounded drain for a valid receipt, never
          // a lifecycle wait on a descendant-held pipe.
          if (!stdoutEnded) await Promise.race([stdoutEnd, pause(OUTPUT_DRAIN_MS)])
          if (!stdoutEnded) throw new ControlledProcessError('CLEANUP', 'helper stdout did not close after process-group reclamation')
          // The execution deadline remains active through cleanup.  A timer or
          // stream error can therefore win while the bounded receipt drain is
          // pending; never turn that late cause into a successful receipt.
          const finalCause = currentCause()
          if (finalCause === 'ABORTED') finish(new ControlledProcessError('ABORTED', 'helper process cancelled'))
          else if (finalCause === 'TIMEOUT') finish(new ControlledProcessError('TIMEOUT', 'helper process exceeded its deadline'))
          else if (finalCause === 'OUTPUT_LIMIT') finish(new ControlledProcessError('OUTPUT_LIMIT', 'helper process exceeded its output bound'))
          else if (finalCause === 'NON_ZERO') finish(new ControlledProcessError('NON_ZERO', 'helper process returned a non-zero status'))
          else if (finalCause === 'START') finish(new ControlledProcessError('START', 'helper process could not start or its output failed'))
          else finish(undefined, Buffer.concat(chunks).toString('utf8'))
        }
      } catch (error) {
        finish(error instanceof ControlledProcessError ? error : new ControlledProcessError('CLEANUP', 'could not reclaim the helper process group'))
      }
    }
    const terminate = (next: ControlledProcessErrorCode): void => {
      if (cause === undefined) cause = next
      // Begin cleanup immediately; do not wait for `close`, because a child
      // can inherit stdout after the leader has gone away.
      void reclaimAndSettle()
    }
    // A function call intentionally prevents TypeScript from treating `cause`
    // as immutable across an awaited bounded drain.
    const currentCause = (): ControlledProcessErrorCode | undefined => cause

    child.once('error', () => terminate('START'))
    child.stdout?.on('error', () => terminate('START'))
    child.stdout?.once('end', () => { stdoutEnded = true; resolveStdoutEnd?.() })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || cause !== undefined) return
      bytes += chunk.length
      if (bytes > options.maximumOutput) terminate('OUTPUT_LIMIT')
      else chunks.push(chunk)
    })
    child.once('exit', code => {
      leaderExited = true
      resolveLeaderExit?.()
      if (cause === undefined && code !== 0) cause = 'NON_ZERO'
      void reclaimAndSettle()
    })
    // No `close` dependency: it is not a lifecycle proof when descendants
    // inherit stdout.  The group scan and fixed cleanup deadline are.
    child.once('close', () => { if (!leaderExited && cause === undefined) terminate('START') })
    child.stdin?.on('error', () => { /* EPIPE is classified from exit/timeout. */ })
    const onAbort = (): void => terminate('ABORTED')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    timer = setTimeout(() => terminate('TIMEOUT'), options.timeoutMs)
    try { child.stdin?.end(options.stdin, 'utf8') } catch { terminate('START') }
  })
}
