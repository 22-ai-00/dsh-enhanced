import { fork, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IsolationLimits, IsolationProcessResult, IsolationRunInput } from './types.js'

const DOCKER_SOCKET = 'unix:///var/run/docker.sock'
const NAME = /^dsh-isolation-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/
const CLEANUP_GRACE_MS = 45_000

interface SupervisorConfig {
  dockerPath: string
  containerName: string
  image: string
  workspacePath: string
  command: string
  deadline: number
  limits: IsolationLimits
}

type SupervisorMessage =
  | { type: 'ready' }
  | { type: 'result', result: IsolationProcessResult }
  | { type: 'error', reason: string }

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH === undefined || process.env.PATH === '' ? '/usr/bin:/bin' : process.env.PATH,
    LANG: 'C',
    LC_ALL: 'C',
  }
}

function failure(reason: string, quiescent = true): IsolationProcessResult {
  return { status: quiescent ? 'failed' : 'unknown', quiescent, stdout: '', stderr: '', reason }
}

function validLimits(limits: IsolationLimits): boolean {
  return [limits.maxDurationMs, limits.maxInputBytes, limits.maxOutputBytes, limits.maxArtifactBytes,
    limits.maxFiles, limits.memoryMiB, limits.pidsLimit, limits.cpus]
    .every(value => Number.isFinite(value) && value > 0)
}

function validate(input: IsolationRunInput): string | undefined {
  if (!NAME.test(input.containerName)) return 'invalid-container-name'
  if (!IMAGE.test(input.image)) return 'image-must-be-a-sha256-digest'
  if (!input.dockerPath.startsWith('/')) return 'docker-path-must-be-absolute'
  if (!input.workspacePath.startsWith('/') || /[\p{Cc},]/u.test(input.workspacePath)) return 'invalid-workspace-path'
  if (typeof input.command !== 'string' || input.command.length === 0) return 'invalid-command'
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= Date.now()) return 'deadline-expired'
  if (!validLimits(input.limits)) return 'invalid-limits'
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) return 'non-root-linux-host-required'
  return undefined
}

function send(child: ChildProcess, message: object): boolean {
  if (!child.connected) return false
  try { return child.send(message) } catch { return false }
}

/**
 * Starts a one-shot supervisor. The supervisor owns Docker after creation so a
 * Host crash closes IPC and causes container cleanup instead of an orphaned job.
 */
export async function runIsolatedProcess(input: IsolationRunInput): Promise<IsolationProcessResult> {
  const invalid = validate(input)
  if (invalid !== undefined) return failure(invalid)
  if (input.signal.aborted) return { status: 'cancelled', quiescent: true, stdout: '', stderr: '', reason: 'aborted-before-create' }

  const config: SupervisorConfig = {
    dockerPath: input.dockerPath,
    containerName: input.containerName,
    image: input.image,
    workspacePath: input.workspacePath,
    command: input.command,
    deadline: input.deadline,
    limits: input.limits,
  }
  const supervisor = fork(new URL('../runtime/supervisor.mjs', import.meta.url), [], {
    detached: true,
    execArgv: [],
    env: safeEnvironment(),
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  // The supervisor uses IPC for control. Drain diagnostics so an unexpected
  // Node warning cannot block its pipe, but do not mix it with worker output.
  supervisor.stdout?.resume()
  supervisor.stderr?.resume()

  return await new Promise<IsolationProcessResult>((resolve) => {
    let settled = false
    let ready = false
    let cancelSent = false
    let grace: NodeJS.Timeout | undefined

    const settle = (result: IsolationProcessResult): void => {
      if (settled) return
      settled = true
      if (grace !== undefined) clearTimeout(grace)
      input.signal.removeEventListener('abort', abort)
      supervisor.removeAllListeners('message')
      supervisor.removeAllListeners('error')
      supervisor.removeAllListeners('exit')
      if (supervisor.connected) supervisor.disconnect()
      resolve(result)
    }
    const cancel = (reason: string): void => {
      if (cancelSent) return
      cancelSent = true
      send(supervisor, { type: 'cancel', reason })
      grace = setTimeout(() => settle({ status: 'unknown', quiescent: false, stdout: '', stderr: '', reason: 'supervisor-cleanup-unconfirmed' }), CLEANUP_GRACE_MS)
      grace.unref()
    }
    const abort = (): void => cancel('aborted')

    input.signal.addEventListener('abort', abort, { once: true })
    supervisor.once('error', (error) => settle(failure(`supervisor-spawn-failed:${error.message}`, false)))
    supervisor.once('exit', (code, signal) => {
      if (!settled) settle({ status: 'unknown', quiescent: false, stdout: '', stderr: '', reason: `supervisor-exited:${code ?? signal ?? 'unknown'}` })
    })
    supervisor.on('message', async (message: SupervisorMessage) => {
      if (settled) return
      if (message?.type === 'error') { settle(failure(message.reason, false)); return }
      if (message?.type === 'result') { settle(message.result); return }
      if (message?.type !== 'ready' || ready) return
      ready = true
      if (input.signal.aborted || Date.now() >= input.deadline) { cancel(input.signal.aborted ? 'aborted' : 'deadline-expired'); return }
      let allowed = false
      try { allowed = await input.authorizeStart() } catch { allowed = false }
      if (!allowed || input.signal.aborted || Date.now() >= input.deadline) {
        cancel(!allowed ? 'authorization-denied' : (input.signal.aborted ? 'aborted' : 'deadline-expired'))
        return
      }
      if (!send(supervisor, { type: 'start' })) settle({ status: 'unknown', quiescent: false, stdout: '', stderr: '', reason: 'supervisor-ipc-closed-before-start' })
    })
    if (!send(supervisor, { type: 'configure', config })) settle({ status: 'unknown', quiescent: false, stdout: '', stderr: '', reason: 'supervisor-ipc-closed-before-configure' })
  })
}

/** Removes only names generated by this plugin; arbitrary Docker names are rejected. */
export async function removeIsolatedContainer(dockerPath: string, name: string): Promise<boolean> {
  if (!NAME.test(name) || !dockerPath.startsWith('/')) return false
  let configDirectory: string | undefined
  try {
    configDirectory = await mkdtemp(join(tmpdir(), 'dsh-isolation-docker-'))
    await chmod(configDirectory, 0o700)
    const invoke = async (args: readonly string[], captureStderr = false): Promise<{ code: number | null, stderr: string, timedOut: boolean }> => await new Promise(resolve => {
      let child: ReturnType<typeof spawn>
      let timer: NodeJS.Timeout | undefined
      let settled = false
      let stderr = ''
      const finish = (code: number | null, timedOut: boolean): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve({ code, stderr, timedOut })
      }
      try {
        child = spawn(dockerPath, ['--config', configDirectory!, '-H', DOCKER_SOCKET, ...args], { shell: false, env: safeEnvironment(), stdio: ['ignore', 'ignore', captureStderr ? 'pipe' : 'ignore'] })
      } catch { finish(null, false); return }
      if (captureStderr) child.stderr?.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stderr) < 4096) stderr += chunk.subarray(0, 4096 - Buffer.byteLength(stderr)).toString('utf8') })
      child.once('error', () => finish(null, false))
      child.once('exit', code => finish(code, false))
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(null, true) }, 10_000)
      timer.unref()
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      const removed = await invoke(['rm', '-f', name])
      if (removed.code === 0 && !removed.timedOut) return true
      const observed = await invoke(['inspect', '--type', 'container', name], true)
      if (!observed.timedOut && observed.code !== 0 && /no such (object|container)/i.test(observed.stderr)) return true
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  } catch { return false } finally {
    if (configDirectory !== undefined) await rm(configDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}
