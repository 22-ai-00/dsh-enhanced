import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute, normalize } from 'node:path'
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

function errnoCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function protectedFileFailure(error: unknown): CredentialProviderError {
  if (error instanceof CredentialProviderError) return error
  if (errnoCode(error) === 'ENOENT') {
    return new CredentialProviderError('not-found', 'credential value is missing')
  }
  return new CredentialProviderError('provider-failed', 'protected credential file is unavailable')
}

async function readLinuxProtectedFile(path: string, maxSecretBytes: number): Promise<string> {
  if (process.platform !== 'linux' || !isAbsolute(path) || normalize(path) !== path) {
    throw new CredentialProviderError('provider-failed', 'protected credential file is unavailable')
  }
  const currentUid = process.geteuid?.()
  if (currentUid === undefined) {
    throw new CredentialProviderError('provider-failed', 'protected credential file is unavailable')
  }
  let directory
  try {
    directory = await lstat(dirname(path))
  } catch (error) {
    throw protectedFileFailure(error)
  }
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== currentUid
    || (directory.mode & 0o7777) !== 0o700) {
    throw new CredentialProviderError('provider-failed', 'protected credential directory is unsafe')
  }
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    throw protectedFileFailure(error)
  }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.uid !== currentUid || before.nlink !== 1
      || (before.mode & 0o7777) !== 0o600) {
      throw new CredentialProviderError('provider-failed', 'protected credential file is unsafe')
    }
    if (before.size > maxSecretBytes) {
      throw new CredentialProviderError('oversize', 'credential provider output is too large')
    }
    const buffer = Buffer.alloc(maxSecretBytes + 1)
    try {
      let offset = 0
      while (offset < buffer.byteLength) {
        const result = await file.read(buffer, offset, buffer.byteLength - offset, offset)
        if (result.bytesRead === 0) break
        offset += result.bytesRead
      }
      const after = await file.stat()
      if (offset > maxSecretBytes) {
        throw new CredentialProviderError('oversize', 'credential provider output is too large')
      }
      if (offset !== after.size || after.dev !== before.dev || after.ino !== before.ino
        || !after.isFile() || after.uid !== currentUid || after.nlink !== 1
        || (after.mode & 0o7777) !== 0o600) {
        throw new CredentialProviderError('provider-failed', 'protected credential file changed while being read')
      }
      return normalizeSecret(buffer.subarray(0, offset), maxSecretBytes)
    } finally {
      buffer.fill(0)
    }
  } catch (error) {
    throw protectedFileFailure(error)
  } finally {
    await file.close().catch(() => {})
  }
}

const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const windowsReadCommand = '$credential = Import-Clixml -LiteralPath $args[0]; [Console]::Out.Write($credential.GetNetworkCredential().Password)'

export async function readCredential(handle: CredentialHandle, options: ReadCredentialOptions): Promise<string> {
  if (handle.provider === 'environment') {
    const value = options.env[handle.environmentName]
    if (value === undefined) throw new CredentialProviderError('not-found', 'credential value is missing')
    return normalizeSecret(value, options.maxSecretBytes)
  }
  if (handle.provider === 'linux-protected-file') {
    return readLinuxProtectedFile(handle.path, options.maxSecretBytes)
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
