import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { cleanupIsolationResources } from './cleanup-receipt.js'
import { captureSystemdBinding } from './daemon-binding.js'
import { captureDaemonWitness, processWitness, sameDaemonWitness, type ProcessWitness } from './runtime-witness.js'
import type { IsolationLimits, IsolationProcessResult, IsolationRunInput } from './types.js'

const NAME = /^dsh-isolation-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/
const CLEANUP_GRACE_MS = 45_000

interface SupervisorConfig {
  dockerPath: string
  containerName: string
  image: string
  workspacePath: string
  artifacts: string[]
  command: string
  deadline: number
  limits: IsolationLimits
}

type SupervisorMessage =
  | { type: 'ready' }
  | { type: 'result', result: IsolationProcessResult, settlementProtocol?: string, requestsSettled?: boolean }
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
  const maxima: IsolationLimits = { maxDurationMs: 300_000, maxInputBytes: 1_048_576, maxOutputBytes: 262_144,
    maxArtifactBytes: 1_048_576, maxFiles: 128, memoryMiB: 4096, pidsLimit: 512, cpus: 8, workspaceMiB: 1024, workspaceInodes: 65_536 }
  return Object.entries(maxima).every(([key, maximum]) => {
    const value = limits[key as keyof IsolationLimits]
    return Number.isFinite(value) && value > 0 && value <= maximum && (key === 'cpus' ? value >= 0.1 : Number.isSafeInteger(value))
  })
}

function validate(input: IsolationRunInput): string | undefined {
  if (!NAME.test(input.containerName)) return 'invalid-container-name'
  if (!IMAGE.test(input.image)) return 'image-must-be-a-sha256-digest'
  if (!input.dockerPath.startsWith('/')) return 'docker-path-must-be-absolute'
  if (!input.workspacePath.startsWith('/') || /[\p{Cc},]/u.test(input.workspacePath)) return 'invalid-workspace-path'
  if (input.artifacts !== undefined && (!Array.isArray(input.artifacts) || input.artifacts.length > input.limits.maxFiles || !input.artifacts.every(path => typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !/[\p{Cc}\\]/u.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')))) return 'invalid-artifacts'
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

  const daemonBefore = await captureDaemonWitness({ dockerPath: input.dockerPath })
  const bindingBefore = daemonBefore ? await captureSystemdBinding(daemonBefore) : undefined
  if (input.signal.aborted) return { status: 'cancelled', quiescent: true, stdout: '', stderr: '', reason: 'aborted-before-create' }
  if (Date.now() >= input.deadline) return failure('deadline-expired-before-create')

  const config: SupervisorConfig = {
    dockerPath: input.dockerPath,
    containerName: input.containerName,
    image: input.image,
    workspacePath: input.workspacePath,
    artifacts: input.artifacts ?? [],
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

  let supervisorWitness: ProcessWitness | undefined
  return await new Promise<IsolationProcessResult>((resolve) => {
    let settled = false
    let ready = false
    let finalReceipt = false
    let cancelSent = false
    let grace: NodeJS.Timeout | undefined
    let deadlineTimer: NodeJS.Timeout | undefined

    const settle = (result: IsolationProcessResult): void => {
      if (settled) return
      settled = true
      if (grace !== undefined) clearTimeout(grace)
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
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

    deadlineTimer = setTimeout(() => cancel('deadline-expired'), Math.max(1, input.deadline - Date.now()))
    deadlineTimer.unref()
    input.signal.addEventListener('abort', abort, { once: true })
    supervisor.once('error', (error) => settle(failure(`supervisor-spawn-failed:${error.message}`, false)))
    supervisor.once('exit', (code, signal) => {
      if (!settled && !finalReceipt) settle({ status: 'unknown', quiescent: false, stdout: '', stderr: '', reason: `supervisor-exited:${code ?? signal ?? 'unknown'}` })
    })
    supervisor.on('message', async (message: SupervisorMessage) => {
      if (settled) return
      if (message?.type === 'error') { settle(failure(message.reason, false)); return }
      if (message?.type === 'result') {
        if (finalReceipt) return
        finalReceipt = true
        // Only the supervisor's final receipt brackets the create operations.
        // This is private diagnostic evidence, never by itself a release permit.
        const daemonAfter = message.result.status === 'unknown' && daemonBefore && supervisorWitness
          ? await captureDaemonWitness({ dockerPath: input.dockerPath }) : undefined
        if (daemonBefore && daemonAfter && supervisorWitness && sameDaemonWitness(daemonBefore, daemonAfter)
          && supervisorWitness.bootId === daemonBefore.process.bootId) {
          const bindingAfter = bindingBefore ? await captureSystemdBinding(daemonAfter) : undefined
          const binding = bindingBefore && bindingAfter && JSON.stringify(bindingBefore) === JSON.stringify(bindingAfter) ? bindingAfter : undefined
          settle({ ...message.result, creationWitness: { daemon: daemonAfter, supervisor: supervisorWitness,
            ...(message.settlementProtocol === 'all-cli-closed/v1' && typeof message.requestsSettled === 'boolean' ? { requestsSettled: message.requestsSettled } : {}),
            ...(binding ? { binding } : {}) } })
        } else settle(message.result)
        return
      }
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
    const configure = async (): Promise<void> => {
      supervisorWitness = supervisor.pid === undefined ? undefined : await processWitness(supervisor.pid)
      if (settled) return
      if (cancelSent || input.signal.aborted || Date.now() >= input.deadline) {
        settle({ status: input.signal.aborted ? 'cancelled' : 'timed-out', quiescent: true, stdout: '', stderr: '', reason: 'cancelled-before-configure' })
        return
      }
      if (!send(supervisor, { type: 'configure', config })) settle({ status: 'unknown', quiescent: false, stdout: '', stderr: '', reason: 'supervisor-ipc-closed-before-configure' })
    }
    void configure()
  })
}

/** Removes only names generated by this plugin; arbitrary Docker names are rejected. */
export async function removeIsolatedContainer(dockerPath: string, name: string, options: { socketPath?: string; signal?: AbortSignal } = {}): Promise<boolean> {
  return await cleanupIsolationResources(dockerPath, name, options) !== undefined
}
