import { LinuxVerifierRunner, type IsolationResult } from '@dsh-enhanced/assistant-isolation'
import type { LinuxPluginBehaviorRunnerConfig } from './plugin-behavior-config.js'
import { LINUX_BEHAVIOR_COMMAND, verifyLinuxPluginBehaviorRuntime } from './linux-behavior-runtime.js'

const MAX_VERIFICATION_MS = 300_000
// A check that precedes ledger lookup proves no new dispatch, not absence of
// resources retained by a historical same-key unknown job.
const unavailable = (reason: string): IsolationResult => ({ jobId: '', status: 'unknown', quiescent: false,
  stdout: '', stderr: '', artifacts: [], reason })

/** Owns observer verification as well as the ordinary runner's durable execution. */
export class LinuxBehaviorRunner {
  readonly #config: LinuxPluginBehaviorRunnerConfig
  readonly #runner: LinuxVerifierRunner
  readonly #abort = new AbortController()
  readonly #calls = new Set<Promise<IsolationResult>>()
  #active = true
  #closePromise: Promise<void> | undefined

  constructor(config: LinuxPluginBehaviorRunnerConfig) {
    this.#config = config
    const { runtime, ...authority } = config
    // The ordinary profile is fixed inside LinuxVerifierRunner. No repository
    // execution policy, caller command, source or mutable resource limits enter.
    this.#runner = new LinuxVerifierRunner({ ...authority, runtime: runtime.runtime, command: LINUX_BEHAVIOR_COMMAND })
  }

  run = (key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> => {
    const call = this.#run(key, artifact, stdin, signal)
    this.#calls.add(call)
    void call.then(() => this.#calls.delete(call), () => this.#calls.delete(call))
    return call
  }

  async #run(key: string, artifact: string, stdin: string, caller: AbortSignal): Promise<IsolationResult> {
    if (!this.#active || caller.aborted || Date.now() >= this.#config.expiresAt)
      return unavailable('plugin-behavior-unavailable')
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), Math.max(1, Math.min(MAX_VERIFICATION_MS, this.#config.expiresAt - Date.now())))
    timer.unref()
    const signal = AbortSignal.any([caller, this.#abort.signal, deadline.signal])
    try {
      try {
        await verifyLinuxPluginBehaviorRuntime(this.#config.runtime, signal)
      } catch {
        return unavailable(signal.aborted ? 'plugin-behavior-unavailable' : 'plugin-behavior-runtime-invalid')
      }
      if (!this.#active || signal.aborted || Date.now() >= this.#config.expiresAt)
        return unavailable('plugin-behavior-unavailable')
      const result = await this.#runner.run(key, artifact, stdin, signal)
      if (!this.#active || signal.aborted) return { ...result, status: 'unknown', reason: 'plugin-behavior-unavailable' }
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  close = async (): Promise<void> => {
    if (this.#closePromise) return await this.#closePromise
    this.#active = false
    this.#abort.abort()
    this.#closePromise = (async () => {
      // Closing the underlying runner cancels admitted work while verification
      // responds to the same abort. Await both; never detach an in-flight check.
      const settled = await Promise.allSettled([this.#runner.close(), ...this.#calls])
      if (settled[0]?.status === 'rejected') throw settled[0].reason
    })()
    return await this.#closePromise
  }
}
