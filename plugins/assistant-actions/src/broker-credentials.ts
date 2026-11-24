import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import { promisify } from 'node:util'
import { verifyWindowsPrivatePath, type WindowsAclInspection } from './broker-peer-windows.js'

const execFileAsync = promisify(execFile)
const CONTROL_CHAR_RE = /[\p{Cc}]/u

export interface BrokerLinuxProtectedFileCredential {
  readonly id: string
  readonly provider: 'linux-protected-file'
  readonly path: string
  readonly maxLeaseMs: number
}

export interface BrokerPosixProtectedFileCredential {
  readonly id: string
  readonly provider: 'posix-protected-file'
  readonly path: string
  readonly maxLeaseMs: number
}

export interface BrokerMacosKeychainCredential {
  readonly id: string
  readonly provider: 'macos-keychain'
  readonly service: string
  readonly account: string
  readonly maxLeaseMs: number
}

export interface BrokerWindowsDpapiCredential {
  readonly id: string
  readonly provider: 'windows-dpapi'
  readonly path: string
  readonly maxLeaseMs: number
}

export interface BrokerWindowsProtectedFileCredential {
  readonly id: string
  readonly provider: 'windows-protected-file'
  readonly path: string
  readonly expectedOwnerSid?: string
  readonly maxLeaseMs: number
}

export interface BrokerInjectedLeaseCredential {
  readonly id: string
  readonly provider: 'injected-lease'
  readonly maxLeaseMs: number
}

export type BrokerCredentialSpec =
  | BrokerLinuxProtectedFileCredential
  | BrokerPosixProtectedFileCredential
  | BrokerMacosKeychainCredential
  | BrokerWindowsDpapiCredential
  | BrokerWindowsProtectedFileCredential
  | BrokerInjectedLeaseCredential

export type CredentialCommandRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>

export interface BrokerCredentialReadHooks {
  readonly beforeCredentialOpen?: () => void | Promise<void>
  readonly platform?: NodeJS.Platform
  readonly commandRunner?: CredentialCommandRunner
  readonly checkWindowsAcl?: (path: string) => WindowsAclInspection | undefined
  readonly readCredentialOverride?: (credential: BrokerCredentialSpec, signal?: AbortSignal) => Promise<string>
}

export class BrokerCredentialError extends Error {
  constructor(
    readonly code: 'request-invalid' | 'credential-unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'BrokerCredentialError'
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function text(value: unknown, maximum = 4_096): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || CONTROL_CHAR_RE.test(value)) {
    throw new BrokerCredentialError('request-invalid', 'invalid credential text field')
  }
  return value
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BrokerCredentialError('request-invalid', 'invalid credential integer field')
  }
  return value
}

export function normalizeBrokerCredentialSpec(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): BrokerCredentialSpec {
  if (!isPlain(value)) throw new BrokerCredentialError('request-invalid', 'credential must be an object')
  const id = text(value.id, 128)
  const maxLeaseMs = integer(value.maxLeaseMs, 1_000, 86_400_000)
  const provider = value.provider

  if (provider === 'linux-protected-file') {
    if (Object.keys(value).length !== 4 || Object.keys(value).some(key => !['id', 'provider', 'path', 'maxLeaseMs'].includes(key))) {
      throw new BrokerCredentialError('request-invalid', 'invalid linux-protected-file credential keys')
    }
    const path = text(value.path, 1_024)
    if (platform !== 'linux' || !isAbsolute(path) || normalize(path) !== path || path === '/') {
      throw new BrokerCredentialError('request-invalid', 'invalid linux-protected-file credential path or platform')
    }
    return Object.freeze({ id, provider: 'linux-protected-file', path, maxLeaseMs })
  }

  if (provider === 'posix-protected-file') {
    if (Object.keys(value).length !== 4 || Object.keys(value).some(key => !['id', 'provider', 'path', 'maxLeaseMs'].includes(key))) {
      throw new BrokerCredentialError('request-invalid', 'invalid posix-protected-file credential keys')
    }
    const path = text(value.path, 1_024)
    if ((platform !== 'linux' && platform !== 'darwin') || !isAbsolute(path) || normalize(path) !== path || path === '/') {
      throw new BrokerCredentialError('request-invalid', 'invalid posix-protected-file credential path or platform')
    }
    return Object.freeze({ id, provider: 'posix-protected-file', path, maxLeaseMs })
  }

  if (provider === 'macos-keychain') {
    if (Object.keys(value).length !== 5 || Object.keys(value).some(key => !['id', 'provider', 'service', 'account', 'maxLeaseMs'].includes(key))) {
      throw new BrokerCredentialError('request-invalid', 'invalid macos-keychain credential keys')
    }
    return Object.freeze({ id, provider: 'macos-keychain', service: text(value.service, 256), account: text(value.account, 256), maxLeaseMs })
  }

  if (provider === 'windows-dpapi') {
    if (Object.keys(value).length !== 4 || Object.keys(value).some(key => !['id', 'provider', 'path', 'maxLeaseMs'].includes(key))) {
      throw new BrokerCredentialError('request-invalid', 'invalid windows-dpapi credential keys')
    }
    const path = text(value.path, 1_024)
    if (!isAbsolute(path) || normalize(path) !== path || path.startsWith('\\\\')) {
      throw new BrokerCredentialError('request-invalid', 'invalid windows-dpapi credential path')
    }
    return Object.freeze({ id, provider: 'windows-dpapi', path, maxLeaseMs })
  }

  if (provider === 'windows-protected-file') {
    const keys = Object.keys(value)
    if (keys.some(key => !['id', 'provider', 'path', 'expectedOwnerSid', 'maxLeaseMs'].includes(key)) || !keys.includes('path')) {
      throw new BrokerCredentialError('request-invalid', 'invalid windows-protected-file credential keys')
    }
    const path = text(value.path, 1_024)
    if (!isAbsolute(path) || normalize(path) !== path || path.startsWith('\\\\')) {
      throw new BrokerCredentialError('request-invalid', 'invalid windows-protected-file credential path')
    }
    const expectedOwnerSid = value.expectedOwnerSid === undefined ? undefined : text(value.expectedOwnerSid, 256)
    if (expectedOwnerSid !== undefined && !/^S-1-(?:\d+-)*\d+$/u.test(expectedOwnerSid)) {
      throw new BrokerCredentialError('request-invalid', 'invalid windows expectedOwnerSid')
    }
    return Object.freeze({
      id,
      provider: 'windows-protected-file',
      path,
      maxLeaseMs,
      ...(expectedOwnerSid === undefined ? {} : { expectedOwnerSid }),
    })
  }

  if (provider === 'injected-lease') {
    if (Object.keys(value).length !== 3 || Object.keys(value).some(key => !['id', 'provider', 'maxLeaseMs'].includes(key))) {
      throw new BrokerCredentialError('request-invalid', 'invalid injected-lease credential keys')
    }
    return Object.freeze({ id, provider: 'injected-lease', maxLeaseMs })
  }

  throw new BrokerCredentialError('request-invalid', `unsupported credential provider: ${String(provider)}`)
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink
}

async function safeCredentialAncestors(value: string, uid: number, gid: number): Promise<void> {
  let cursor = value
  let leaf = true
  for (;;) {
    const [canonical, stat] = await Promise.all([realpath(cursor), lstat(cursor, { bigint: true })])
    const mode = Number(stat.mode & 0o7777n)
    const owner = Number(stat.uid)
    const group = Number(stat.gid)
    const stickyRoot = owner === 0 && (mode & 0o1000) !== 0 && (mode & 0o022) !== 0
    if (canonical !== cursor || stat.isSymbolicLink() || !stat.isDirectory() || (!stickyRoot && (mode & 0o022) !== 0) || (leaf && (owner !== uid || group !== gid || mode !== 0o700))) {
      throw new BrokerCredentialError('credential-unavailable', 'unsafe credential ancestor directory')
    }
    const parent = dirname(cursor)
    if (parent === cursor) return
    cursor = parent
    leaf = false
  }
}

function scrubPrintableToken(raw: string, maximum: number): string {
  const token = raw.replace(/[\r\n]+$/u, '')
  if (!token || token.includes('\0') || Buffer.from(token, 'utf8').length > maximum || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new BrokerCredentialError('credential-unavailable', 'credential payload is empty or invalid')
  }
  return token
}

async function readLinuxOrPosixProtectedFile(
  path: string,
  maximum: number,
  useProcSelfFd: boolean,
  platform: NodeJS.Platform,
  beforeOpen?: () => void | Promise<void>,
): Promise<string> {
  const uid = process.geteuid?.()
  const gid = process.getegid?.()
  if ((useProcSelfFd ? platform !== 'linux' : (platform !== 'linux' && platform !== 'darwin')) || uid === undefined || gid === undefined) {
    throw new BrokerCredentialError('credential-unavailable', 'unsupported platform for POSIX protected file credential')
  }
  const parentPath = dirname(path)
  await safeCredentialAncestors(parentPath, uid, gid)

  let parent: Awaited<ReturnType<typeof open>>
  try {
    parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch {
    throw new BrokerCredentialError('credential-unavailable', 'cannot open credential parent directory')
  }

  let descriptor: Awaited<ReturnType<typeof open>> | undefined
  try {
    const parentBefore = await parent.stat({ bigint: true })
    const visibleParent = await lstat(parentPath, { bigint: true })
    if (!parentBefore.isDirectory() || !sameNode(parentBefore, visibleParent)) {
      throw new BrokerCredentialError('credential-unavailable', 'credential parent changed')
    }
    await beforeOpen?.()
    const targetPath = useProcSelfFd ? `/proc/self/fd/${parent.fd}/${basename(path)}` : path
    descriptor = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const pathParent = await lstat(parentPath, { bigint: true })
    if (!sameNode(parentBefore, await parent.stat({ bigint: true })) || !sameNode(parentBefore, pathParent)) {
      throw new BrokerCredentialError('credential-unavailable', 'credential parent moved while opening')
    }
  } catch (error) {
    await descriptor?.close().catch(() => undefined)
    await parent.close().catch(() => undefined)
    if (error instanceof BrokerCredentialError) throw error
    throw new BrokerCredentialError('credential-unavailable', 'cannot open credential file')
  }

  const bytes = Buffer.alloc(maximum + 1)
  try {
    const before = await descriptor.stat({ bigint: true })
    if (!before.isFile() || before.uid !== BigInt(uid) || before.nlink !== 1n || Number(before.mode & 0o7777n) !== 0o600 || before.size > BigInt(maximum)) {
      throw new BrokerCredentialError('credential-unavailable', 'credential file ownership or permissions invalid')
    }
    let offset = 0
    while (offset < bytes.length) {
      const read = await descriptor.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const [after, visible, parentAfter, visibleParent] = await Promise.all([
      descriptor.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      parent.stat({ bigint: true }),
      lstat(parentPath, { bigint: true }),
    ])
    if (offset > maximum || BigInt(offset) !== after.size || !sameNode(before, after) || !sameNode(after, visible) || !sameNode(parentAfter, visibleParent) || !after.isFile()) {
      throw new BrokerCredentialError('credential-unavailable', 'credential file changed during read')
    }
    await safeCredentialAncestors(parentPath, uid, gid)
    return scrubPrintableToken(bytes.subarray(0, offset).toString('utf8'), maximum)
  } catch (error) {
    if (error instanceof BrokerCredentialError) throw error
    throw new BrokerCredentialError('credential-unavailable', 'credential file read failed')
  } finally {
    bytes.fill(0)
    await descriptor.close().catch(() => undefined)
    await parent.close().catch(() => undefined)
  }
}

const defaultCommandRunner: CredentialCommandRunner = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: options.timeoutMs,
    maxBuffer: 128 * 1024,
    encoding: 'utf8',
    windowsHide: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return { stdout, stderr }
}

export async function readBrokerCredential(
  credential: BrokerCredentialSpec,
  maximum: number,
  hooks: BrokerCredentialReadHooks = {},
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new BrokerCredentialError('credential-unavailable', 'aborted before credential read')
  const platform = hooks.platform ?? process.platform

  if (hooks.readCredentialOverride) {
    const raw = await hooks.readCredentialOverride(credential, signal)
    return credential.provider === 'injected-lease' && raw === '' ? '' : scrubPrintableToken(raw, maximum)
  }

  if (credential.provider === 'injected-lease') {
    return ''
  }

  if (credential.provider === 'linux-protected-file') {
    return await readLinuxOrPosixProtectedFile(credential.path, maximum, true, platform, hooks.beforeCredentialOpen)
  }

  if (credential.provider === 'posix-protected-file') {
    return await readLinuxOrPosixProtectedFile(credential.path, maximum, platform === 'linux', platform, hooks.beforeCredentialOpen)
  }

  if (credential.provider === 'macos-keychain') {
    if (platform !== 'darwin' && !hooks.commandRunner) {
      throw new BrokerCredentialError('credential-unavailable', 'macos-keychain requires darwin platform')
    }
    const runner = hooks.commandRunner ?? defaultCommandRunner
    try {
      const { stdout } = await runner(
        '/usr/bin/security',
        ['find-generic-password', '-w', '-s', credential.service, '-a', credential.account],
        { timeoutMs: 5_000, ...(signal === undefined ? {} : { signal }) },
      )
      return scrubPrintableToken(stdout, maximum)
    } catch (error) {
      if (error instanceof BrokerCredentialError) throw error
      throw new BrokerCredentialError('credential-unavailable', 'macos-keychain lookup failed')
    }
  }

  if (credential.provider === 'windows-dpapi') {
    if (platform !== 'win32' && !hooks.commandRunner) {
      throw new BrokerCredentialError('credential-unavailable', 'windows-dpapi requires win32 platform')
    }
    if (platform === 'win32' || hooks.checkWindowsAcl) {
      try {
        verifyWindowsPrivatePath(credential.path, {
          ...(hooks.checkWindowsAcl === undefined ? {} : { checkAcl: hooks.checkWindowsAcl }),
          platform,
        })
      } catch {
        throw new BrokerCredentialError('credential-unavailable', 'windows-dpapi path failed security verification')
      }
    }
    const runner = hooks.commandRunner ?? defaultCommandRunner
    const escapedPath = credential.path.replace(/'/g, "''")
    const psScript = `$c = Import-Clixml -LiteralPath '${escapedPath}'; $c.GetNetworkCredential().Password`
    try {
      const { stdout } = await runner(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeoutMs: 5_000, ...(signal === undefined ? {} : { signal }) },
      )
      return scrubPrintableToken(stdout, maximum)
    } catch (error) {
      if (error instanceof BrokerCredentialError) throw error
      throw new BrokerCredentialError('credential-unavailable', 'windows-dpapi lookup failed')
    }
  }

  if (credential.provider === 'windows-protected-file') {
    if (platform !== 'win32' && !hooks.checkWindowsAcl) {
      throw new BrokerCredentialError('credential-unavailable', 'windows-protected-file requires win32 platform')
    }
    try {
      verifyWindowsPrivatePath(credential.path, {
        ...(credential.expectedOwnerSid === undefined ? {} : { expectedOwnerSid: credential.expectedOwnerSid }),
        ...(hooks.checkWindowsAcl === undefined ? {} : { checkAcl: hooks.checkWindowsAcl }),
        platform,
      })
      await hooks.beforeCredentialOpen?.()
      const bytes = await readFile(credential.path)
      try {
        if (bytes.length > maximum) throw new BrokerCredentialError('credential-unavailable', 'credential exceeds byte limit')
        return scrubPrintableToken(bytes.toString('utf8'), maximum)
      } finally {
        bytes.fill(0)
      }
    } catch (error) {
      if (error instanceof BrokerCredentialError) throw error
      throw new BrokerCredentialError('credential-unavailable', 'windows-protected-file read failed')
    }
  }

  throw new BrokerCredentialError('credential-unavailable', 'unsupported credential provider')
}
