import { spawn } from 'node:child_process'
import type {
  CredentialCommandInput,
  CredentialCommandResult,
  CredentialCommandRunner,
  CredentialHandle,
  CredentialProviderErrorCode,
} from './types.js'

export class CredentialProviderError extends Error {
  constructor(readonly code: CredentialProviderErrorCode, message: string) {
    super(message)
    this.name = 'CredentialProviderError'
  }
}

export interface ReadCredentialOptions {
  env: Readonly<Record<string, string | undefined>>
  run: CredentialCommandRunner
  timeoutMs: number
  maxSecretBytes: number
}

function minimalLinuxEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    ...(env.DBUS_SESSION_BUS_ADDRESS === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS }),
    ...(env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR }),
  }
}

function normalizeSecret(value: string | Buffer, maxSecretBytes: number): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (bytes.byteLength > maxSecretBytes) throw new CredentialProviderError('oversize', 'credential provider output is too large')
  const text = bytes.toString('utf8').replace(/[\r\n]+$/u, '')
  if (text.length === 0) throw new CredentialProviderError('not-found', 'credential value is missing')
  if (text.includes('\0')) throw new CredentialProviderError('invalid-value', 'credential value contains an invalid byte')
  return text
}

const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const windowsReadCommand = '$credential = Import-Clixml -LiteralPath $args[0]; [Console]::Out.Write($credential.GetNetworkCredential().Password)'

export async function readCredential(handle: CredentialHandle, options: ReadCredentialOptions): Promise<string> {
  if (handle.provider === 'environment') {
    const value = options.env[handle.environmentName]
    if (value === undefined) throw new CredentialProviderError('not-found', 'credential value is missing')
    return normalizeSecret(value, options.maxSecretBytes)
  }
  let command: CredentialCommandInput
  if (handle.provider === 'macos-keychain') {
    command = {
        executable: '/usr/bin/security',
        args: ['find-generic-password', '-w', '-s', handle.service, '-a', handle.account],
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxSecretBytes + 1,
      }
  } else if (handle.provider === 'linux-secret-service') {
    command = {
        executable: '/usr/bin/secret-tool',
        args: ['lookup', 'service', handle.service, 'account', handle.account],
        env: minimalLinuxEnv(options.env),
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxSecretBytes + 1,
      }
  } else if (handle.provider === 'windows-dpapi') {
    command = {
      executable: windowsPowerShell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsReadCommand, handle.path],
      env: { PATH: 'C:\\Windows\\System32;C:\\Windows', SystemRoot: 'C:\\Windows' },
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxSecretBytes + 1,
    }
  } else {
    throw new CredentialProviderError('provider-failed', 'credential provider is unsupported')
  }
  let result: CredentialCommandResult
  try {
    result = await options.run(command)
  } catch (error) {
    if (error instanceof CredentialProviderError) throw error
    throw new CredentialProviderError('provider-failed', 'credential provider execution failed')
  }
  if (result.stdout.byteLength > options.maxSecretBytes) {
    throw new CredentialProviderError('oversize', 'credential provider output is too large')
  }
  if (result.code !== 0) throw new CredentialProviderError('provider-failed', 'credential provider returned an error')
  return normalizeSecret(result.stdout, options.maxSecretBytes)
}

export const runCredentialCommand: CredentialCommandRunner = input => new Promise((resolve, reject) => {
  const child = spawn(input.executable, [...input.args], {
    env: { ...input.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let total = 0
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (callback: () => void) => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    callback()
  }
  const append = (target: Buffer[], chunk: Buffer) => {
    total += chunk.byteLength
    if (total > input.maxOutputBytes) {
      child.kill('SIGKILL')
      finish(() => reject(new CredentialProviderError('oversize', 'credential provider output is too large')))
      return
    }
    target.push(Buffer.from(chunk))
  }
  child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
  child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
  child.once('error', () => finish(() => reject(
    new CredentialProviderError('provider-failed', 'credential provider execution failed'),
  )))
  child.once('close', code => finish(() => resolve({
    code: code ?? -1,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  })))
  timer = setTimeout(() => {
    child.kill('SIGKILL')
    finish(() => reject(new CredentialProviderError('timeout', 'credential provider timed out')))
  }, input.timeoutMs)
  timer.unref?.()
})
