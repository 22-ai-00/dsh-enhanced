import { LinuxVerifierRunner, type LinuxVerifierRunnerConfig } from './linux-verifier-runner.js'
import {
  NativeCommandVerifierRunner,
  type MacosSeatbeltVerifierRunnerConfig,
  type WindowsJobVerifierRunnerConfig,
} from './native-command-verifier-runner.js'
import { resolveIsolationBackend } from './platform.js'
import type { IsolationResult } from './types.js'

export type AutoVerifierRunnerConfig =
  | (Omit<LinuxVerifierRunnerConfig, 'backend'> & { backend?: 'auto' })
  | (Omit<MacosSeatbeltVerifierRunnerConfig, 'backend'> & { backend?: 'auto' })
  | (Omit<WindowsJobVerifierRunnerConfig, 'backend'> & { backend?: 'auto' })

export type IsolatedVerifierRunnerConfig =
  | LinuxVerifierRunnerConfig
  | MacosSeatbeltVerifierRunnerConfig
  | WindowsJobVerifierRunnerConfig
  | AutoVerifierRunnerConfig

export class IsolatedVerifierRunner {
  readonly #runner: LinuxVerifierRunner | NativeCommandVerifierRunner

  constructor(
    input: IsolatedVerifierRunnerConfig,
    options: { platform?: NodeJS.Platform; uid?: number; allowHostPaths?: boolean } = {},
  ) {
    if (!input || typeof input !== 'object') {
      throw new Error('assistant-isolation: invalid verifier configuration')
    }
    const resolved = resolveIsolationBackend(input.backend ?? 'auto', options.platform ?? process.platform)
    if (resolved === 'linux-native') {
      this.#runner = new LinuxVerifierRunner({ ...input, backend: 'linux-native' } as LinuxVerifierRunnerConfig)
    } else if (resolved === 'macos-seatbelt') {
      this.#runner = new NativeCommandVerifierRunner({ ...input, backend: 'macos-seatbelt' } as MacosSeatbeltVerifierRunnerConfig, options)
    } else {
      this.#runner = new NativeCommandVerifierRunner({ ...input, backend: 'windows-job' } as WindowsJobVerifierRunnerConfig, options)
    }
  }

  run = (key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<IsolationResult> =>
    this.#runner.run(key, artifact, stdin, signal)

  close = (): Promise<void> => this.#runner.close()
}

export type {
  LinuxVerifierRunnerConfig,
  MacosSeatbeltVerifierRunnerConfig,
  WindowsJobVerifierRunnerConfig,
  IsolationResult,
}
