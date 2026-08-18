import { execFile as nodeExecFile } from 'node:child_process'
import { buildTraexEnv } from './acp-client.js'

export interface AuthCommandResult {
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export interface VerifyTraexAuthOptions {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly extraEnvNames: readonly string[]
  readonly signal?: AbortSignal
}

export type AuthCommandRunner = (
  command: string,
  args: readonly string[],
  options: VerifyTraexAuthOptions,
) => Promise<AuthCommandResult>

export type TraexAuthVerifier = (options: VerifyTraexAuthOptions) => Promise<void>

export class TraexAuthError extends Error {
  constructor(message = 'TraeX is not logged in with Trae') {
    super(message, { cause: 'auth' })
    this.name = 'TraexAuthError'
  }
}

/** Require the active TraeX credential source to be the Trae tool account. */
export async function verifyTraexAuth(
  options: VerifyTraexAuthOptions,
  runCommand: AuthCommandRunner = runAuthCommand,
): Promise<void> {
  const result = await runCommand(options.command, ['login', 'status'], options)
  if (result.exitCode !== 0 || result.signal !== null || result.stdout.trim() !== 'Logged in using Trae') {
    throw new TraexAuthError()
  }
}

export const runAuthCommand: AuthCommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  nodeExecFile(command, [...args], {
    cwd: options.cwd,
    env: buildTraexEnv(options.extraEnvNames),
    encoding: 'utf8',
    maxBuffer: options.maxOutputBytes,
    timeout: options.timeoutMs,
    signal: options.signal,
    shell: false,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error === null) {
      resolve({ exitCode: 0, signal: null, stdout, stderr })
      return
    }
    if (options.signal?.aborted) {
      reject(new Error('TraeX authentication probe aborted', { cause: 'abort' }))
      return
    }
    if (error.killed) {
      reject(new Error('TraeX authentication probe timed out', { cause: 'timeout' }))
      return
    }
    if (error.code === 'ENOENT') {
      reject(error)
      return
    }
    if (typeof error.code === 'number') {
      resolve({
        exitCode: error.code,
        signal: error.signal as NodeJS.Signals | null,
        stdout,
        stderr,
      })
      return
    }
    reject(new TraexAuthError('TraeX authentication probe returned too much or invalid output'))
  })
})
