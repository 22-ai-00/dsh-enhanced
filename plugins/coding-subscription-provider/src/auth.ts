import { execFile as nodeExecFile } from 'node:child_process'
import { buildSubscriptionEnv } from './process.js'
import type { ProviderId } from './providers.js'

export interface AuthCommandResult {
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export interface AuthCommandOptions {
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly extraEnvNames: readonly string[]
  readonly signal?: AbortSignal
}

export type AuthCommandRunner = (
  command: string,
  args: readonly string[],
  options: AuthCommandOptions,
) => Promise<AuthCommandResult>

export interface VerifySubscriptionAuthOptions extends AuthCommandOptions {
  readonly command: string
  readonly userVerifiedSubscription?: boolean
}

export type SubscriptionAuthVerifier = (
  provider: ProviderId,
  options: VerifySubscriptionAuthOptions,
) => Promise<void>

export class SubscriptionAuthError extends Error {
  readonly provider: ProviderId

  constructor(provider: ProviderId, message: string) {
    super(message, { cause: 'subscription-auth' })
    this.name = 'SubscriptionAuthError'
    this.provider = provider
  }
}

const authArgs: Readonly<Partial<Record<ProviderId, readonly string[]>>> = {
  codex: ['login', 'status'],
  claude: ['auth', 'status', '--json'],
  cursor: ['status'],
}

/**
 * Fail closed unless the official CLI reports a subscription-compatible login.
 * Grok headless cannot prove its effective credential source, so its MVP route
 * requires an explicit local-user attestation; Phase 2 will keep one ACP
 * `cached_token` connection for authentication and prompting.
 */
export async function verifySubscriptionAuth(
  provider: ProviderId,
  options: VerifySubscriptionAuthOptions,
  runCommand: AuthCommandRunner = runAuthCommand,
): Promise<void> {
  if (provider === 'grok') {
    if (!options.userVerifiedSubscription) {
      throw new SubscriptionAuthError(provider, 'Grok subscription use requires explicit local verification')
    }
    return
  }

  const args = authArgs[provider]
  if (args === undefined) throw new SubscriptionAuthError(provider, 'No subscription authentication probe is available')
  const result = await runCommand(options.command, args, options)
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new SubscriptionAuthError(provider, `${provider} subscription authentication probe failed`)
  }

  if (provider === 'codex') {
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map(line => line.trim())
    if (!lines.includes('Logged in using ChatGPT')) {
      throw new SubscriptionAuthError(provider, 'Codex is not logged in with ChatGPT')
    }
    return
  }

  if (provider === 'claude') {
    const status = jsonObject(result.stdout)
    const method = typeof status?.authMethod === 'string' ? status.authMethod : undefined
    if (status?.loggedIn !== true || status.apiProvider !== 'firstParty' || (method !== 'claude.ai' && method !== 'oauth_token')) {
      throw new SubscriptionAuthError(provider, 'Claude Code did not report a first-party subscription OAuth login')
    }
    return
  }

  // Cursor's status command only proves that some authentication exists. The
  // model stream must additionally report system/init apiKeySource="login".
}

export const runAuthCommand: AuthCommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  nodeExecFile(command, [...args], {
    cwd: options.cwd,
    env: buildSubscriptionEnv(options.extraEnvNames),
    encoding: 'utf8',
    maxBuffer: options.maxOutputBytes,
    timeout: options.timeoutMs,
    signal: options.signal,
    shell: false,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    const output = stdout
    const diagnostic = stderr
    if (error === null) {
      resolve({ exitCode: 0, signal: null, stdout: output, stderr: diagnostic })
      return
    }
    if (options.signal?.aborted) {
      reject(new Error('subscription authentication probe aborted', { cause: 'abort' }))
      return
    }
    if (error.killed) {
      reject(new Error('subscription authentication probe timed out', { cause: 'timeout' }))
      return
    }
    if (error.code === 'ENOENT') {
      reject(error)
      return
    }
    if (typeof error.code === 'number') {
      resolve({ exitCode: error.code, signal: error.signal as NodeJS.Signals | null, stdout: output, stderr: diagnostic })
      return
    }
    reject(new Error('subscription authentication probe exceeded its safety limit', { cause: 'subscription-auth' }))
  })
})

function jsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}
