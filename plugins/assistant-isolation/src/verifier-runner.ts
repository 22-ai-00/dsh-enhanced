import type { IsolationResult } from './types.js'
import { LinuxVerifierRunner, type LinuxVerifierRunnerConfig } from './linux-verifier-runner.js'

/**
 * The isolated verifier only supports the native linux-native backend now.
 * The Docker-backed verifier was removed so the project keeps a single,
 * auditable isolation boundary; callers must provide the validated Linux
 * runtime and cgroup roots instead of an image and docker executable.
 */
export class IsolatedVerifierRunner {
  readonly #runner: LinuxVerifierRunner
  constructor(input: LinuxVerifierRunnerConfig) {
    if (input.backend !== 'linux-native') throw new Error('assistant-isolation: only the linux-native verifier backend is supported')
    this.#runner = new LinuxVerifierRunner(input)
  }
  run = (key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> =>
    this.#runner.run(key, artifact, stdin, signal)
  close = (): Promise<void> => this.#runner.close()
}

export type { LinuxVerifierRunnerConfig, IsolationResult }
