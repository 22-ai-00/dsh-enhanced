#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { accessSync, constants, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import type { ExternalPrincipalKey } from '@dsh-enhanced/assistant-delivery'
import { registerApp } from '@larksuiteoapi/node-sdk'
import * as QRCode from 'qrcode'
import { isMap, isSeq, parseDocument, type Node, type YAMLMap, type YAMLSeq } from 'yaml'
import { createOfficialLarkTransport } from './sdk.js'
import { installDshResidentService } from './resident.js'
import { prepareDshSystemdUserService } from './systemd.js'
import { configureLarkProfilePatch, refreshLarkAgentPolicyPatch } from './setup-profile.js'
import {
  assertRawManagedProfileIntegrity,
  materializeManagedProfileOverride,
} from './setup-materialization.js'
import type { LarkMessage, LarkTransport } from './types.js'

type RegisterAppOptions = Parameters<typeof registerApp>[0]
type RegisterAppResult = Awaited<ReturnType<typeof registerApp>>

export interface LarkSetupArgs {
  profile: string
  domain: 'feishu' | 'lark'
  account: string
  accountProvided: boolean
  tenant: string
  appId?: string
  createApp: boolean
  appName: string
  timeoutMs: number
  installServiceOnly: boolean
  refreshAgentPolicy: boolean
  manageService: boolean
  linuxCredentialProvider: 'auto' | 'protected-file' | 'secret-service'
  agentTools: 'disable' | 'enable' | 'preserve'
  help: boolean
}

const setupKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const keychainLocatorPattern = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,255}$/u

function argumentValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`lark-channel setup: ${option} requires a value`)
  return value
}

export function parseLarkSetupArgs(argv: readonly string[]): LarkSetupArgs {
  const result: LarkSetupArgs = {
    profile: 'web',
    domain: 'feishu',
    account: 'primary',
    accountProvided: false,
    tenant: 'personal',
    createApp: false,
    appName: 'DSH Personal Assistant',
    timeoutMs: 300_000,
    installServiceOnly: false,
    refreshAgentPolicy: false,
    manageService: true,
    linuxCredentialProvider: 'auto',
    agentTools: 'preserve',
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!
    if (/secret/iu.test(option)) throw new Error('lark-channel setup: secret arguments are not accepted; use the Keychain prompt')
    if (option === '--help' || option === '-h') {
      result.help = true
      continue
    }
    if (option === '--profile') result.profile = argumentValue(argv, index++, option)
    else if (option === '--domain') result.domain = argumentValue(argv, index++, option) as 'feishu' | 'lark'
    else if (option === '--account') {
      result.account = argumentValue(argv, index++, option)
      result.accountProvided = true
    }
    else if (option === '--tenant') result.tenant = argumentValue(argv, index++, option)
    else if (option === '--app-id') result.appId = argumentValue(argv, index++, option)
    else if (option === '--create-app') result.createApp = true
    else if (option === '--install-service') result.installServiceOnly = true
    else if (option === '--refresh-agent-policy') result.refreshAgentPolicy = true
    else if (option === '--no-service') result.manageService = false
    else if (option === '--linux-credential-provider') {
      result.linuxCredentialProvider = argumentValue(argv, index++, option) as LarkSetupArgs['linuxCredentialProvider']
    }
    else if (option === '--allow-agent-tools' || option === '--disable-agent-tools') {
      if (result.agentTools !== 'preserve') {
        throw new Error('lark-channel setup: --allow-agent-tools and --disable-agent-tools are mutually exclusive')
      }
      result.agentTools = option === '--allow-agent-tools' ? 'enable' : 'disable'
    }
    else if (option === '--app-name') result.appName = argumentValue(argv, index++, option)
    else if (option === '--timeout-ms') result.timeoutMs = Number(argumentValue(argv, index++, option))
    else throw new Error(`lark-channel setup: unknown option: ${option}`)
  }
  if (!setupKeyPattern.test(result.profile)) throw new Error('lark-channel setup: invalid profile')
  if (!setupKeyPattern.test(result.account)) throw new Error('lark-channel setup: invalid account')
  if (!setupKeyPattern.test(result.tenant)) throw new Error('lark-channel setup: invalid tenant')
  if (result.appId !== undefined && !/^cli_[0-9a-fA-F]{16}$/u.test(result.appId)) {
    throw new Error('lark-channel setup: invalid App ID')
  }
  if (!result.help && result.refreshAgentPolicy) {
    const incompatible = [
      '--domain', '--tenant', '--app-id', '--create-app', '--install-service',
      '--no-service', '--linux-credential-provider', '--app-name', '--timeout-ms',
    ].find(option => argv.includes(option))
    if (incompatible !== undefined) {
      throw new Error(`lark-channel setup: --refresh-agent-policy cannot be combined with ${incompatible}`)
    }
    if (result.agentTools === 'preserve') {
      throw new Error('lark-channel setup: --refresh-agent-policy requires --allow-agent-tools or --disable-agent-tools')
    }
  }
  if (result.installServiceOnly && !result.manageService) {
    throw new Error('lark-channel setup: --install-service and --no-service cannot be used together')
  }
  if (result.installServiceOnly && (result.createApp || result.appId !== undefined)) {
    throw new Error('lark-channel setup: --install-service cannot be combined with application setup options')
  }
  if (result.installServiceOnly && argv.includes('--linux-credential-provider')) {
    throw new Error('lark-channel setup: --install-service cannot be combined with --linux-credential-provider')
  }
  if (result.installServiceOnly && result.agentTools !== 'preserve') {
    throw new Error('lark-channel setup: --install-service cannot be combined with agent-tools options')
  }
  const appNameHasControlCharacter = [...result.appName]
    .some(character => character.codePointAt(0)! <= 31 || character.codePointAt(0) === 127)
  if (result.appName.trim().length === 0 || result.appName.length > 64 || appNameHasControlCharacter) {
    throw new Error('lark-channel setup: app-name must be 1..64 characters without control characters')
  }
  if (result.domain !== 'feishu' && result.domain !== 'lark') throw new Error('lark-channel setup: domain must be feishu or lark')
  if (!['auto', 'protected-file', 'secret-service'].includes(result.linuxCredentialProvider)) {
    throw new Error('lark-channel setup: linux-credential-provider must be auto, protected-file, or secret-service')
  }
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 30_000 || result.timeoutMs > 900_000) {
    throw new Error('lark-channel setup: timeout-ms must be an integer from 30000 to 900000')
  }
  return result
}

export interface LarkRegistrationOptionsInput {
  domain: 'feishu' | 'lark'
  appName: string
  appId?: string
  signal: AbortSignal
  onQRCodeReady: RegisterAppOptions['onQRCodeReady']
  onStatusChange: NonNullable<RegisterAppOptions['onStatusChange']>
}

export function createLarkRegistrationOptions(input: LarkRegistrationOptionsInput): RegisterAppOptions {
  return {
    domain: input.domain === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn',
    larkDomain: 'accounts.larksuite.com',
    source: 'dsh-enhanced/lark-channel',
    ...(input.appId === undefined ? {} : { appId: input.appId }),
    signal: input.signal,
    appPreset: {
      name: input.appName,
      desc: '由 DeepSeek Harness 驱动的个人助理',
    },
    addons: {
      preset: false,
      scopes: { tenant: [
        'application:bot.basic_info:read',
        'im:message.group_at_msg:readonly',
        'im:message.p2p_msg:readonly',
        'im:message.reactions:write_only',
        'im:message:send_as_bot',
        'im:resource',
      ] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
      callbacks: { items: ['card.action.trigger'] },
    },
    onQRCodeReady: input.onQRCodeReady,
    onStatusChange: input.onStatusChange,
  }
}

export interface KeychainWriteRequest {
  args: string[]
  input: Buffer
}

export interface SecretWriteRequest {
  executable: string
  args: string[]
  input: Buffer
}

export type SetupCredentialProvider =
  | 'linux-protected-file'
  | 'linux-secret-service'
  | 'macos-keychain'
  | 'windows-dpapi'

export type SetupCredentialLocator =
  | {
    provider: 'linux-secret-service' | 'macos-keychain'
    service: string
    account: string
  }
  | {
    provider: 'linux-protected-file'
    path: string
  }
  | {
    provider: 'windows-dpapi'
    path: string
  }

export interface VersionedCredentialLocatorInput {
  provider: SetupCredentialProvider
  dshHome: string
  profile: string
  account: string
  version?: string
}

const credentialVersionPattern = /^[0-9a-f]{32}$/u

/**
 * Creates a locator which has never been active before. Profile validation can
 * therefore read a candidate secret without replacing the currently active
 * Keychain, Secret Service, or DPAPI value.
 */
export function createVersionedCredentialLocator(input: VersionedCredentialLocatorInput): SetupCredentialLocator {
  if (!isAbsolute(input.dshHome) && !win32.isAbsolute(input.dshHome)) {
    throw new Error('lark-channel setup: dshHome must be absolute')
  }
  if (!setupKeyPattern.test(input.profile)) throw new Error('lark-channel setup: invalid profile')
  if (!setupKeyPattern.test(input.account)) throw new Error('lark-channel setup: invalid account')
  const version = input.version ?? randomBytes(16).toString('hex')
  if (!credentialVersionPattern.test(version)) {
    throw new Error('lark-channel setup: invalid credential version')
  }
  if (input.provider === 'linux-protected-file') {
    return {
      provider: input.provider,
      path: join(input.dshHome, 'credentials-keychain',
        `lark-${input.profile}-${input.account}-${version}.secret`),
    }
  }
  if (input.provider === 'windows-dpapi') {
    return {
      provider: input.provider,
      path: join(input.dshHome, 'credentials-keychain',
        `lark-${input.profile}-${input.account}-${version}.clixml`),
    }
  }
  return {
    provider: input.provider,
    service: `dsh/lark/${input.profile}/${input.account}/versions/${version}`,
    account: input.account,
  }
}

const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const windowsDpapiWriteCommand = "$secret = [Console]::In.ReadToEnd(); $secure = ConvertTo-SecureString $secret -AsPlainText -Force; $credential = [pscredential]::new('dsh-enhanced', $secure); $credential | Export-Clixml -LiteralPath $args[0]"
const windowsDpapiReadCommand = '$credential = Import-Clixml -LiteralPath $args[0]; [Console]::Out.Write($credential.GetNetworkCredential().Password)'

export function credentialProviderForPlatform(platform: NodeJS.Platform): SetupCredentialProvider {
  if (platform === 'darwin') return 'macos-keychain'
  if (platform === 'linux') return 'linux-secret-service'
  if (platform === 'win32') return 'windows-dpapi'
  throw new Error(`lark-channel setup: unsupported platform: ${platform}`)
}

export function createKeychainWriteRequest(service: string, account: string, secret: string): KeychainWriteRequest {
  if (!keychainLocatorPattern.test(service) || !keychainLocatorPattern.test(account)) {
    throw new Error('lark-channel setup: invalid Keychain locator')
  }
  if (secret.length === 0) throw new Error('lark-channel setup: cannot store an empty secret')
  const secretHex = Buffer.from(secret, 'utf8').toString('hex')
  return {
    args: ['-i'],
    input: Buffer.from(`add-generic-password -U -a ${account} -s ${service} -X ${secretHex}\n`, 'utf8'),
  }
}

export function createSecretServiceWriteRequest(service: string, account: string, secret: string): SecretWriteRequest {
  if (!keychainLocatorPattern.test(service) || !keychainLocatorPattern.test(account)) {
    throw new Error('lark-channel setup: invalid Secret Service locator')
  }
  if (secret.length === 0) throw new Error('lark-channel setup: cannot store an empty secret')
  const suffix = service.startsWith('dsh/lark/') ? service.slice('dsh/lark/'.length) : service
  return {
    executable: '/usr/bin/secret-tool',
    args: ['store', `--label=DSH Lark ${suffix}`, 'service', service, 'account', account],
    input: Buffer.from(secret, 'utf8'),
  }
}

export function createWindowsDpapiWriteRequest(path: string, secret: string): SecretWriteRequest {
  if (path.length < 1 || path.length > 1_024 || path.includes('\0')
    || (!isAbsolute(path) && !win32.isAbsolute(path))) {
    throw new Error('lark-channel setup: invalid DPAPI credential path')
  }
  if (secret.length === 0) throw new Error('lark-channel setup: cannot store an empty secret')
  return {
    executable: windowsPowerShell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsDpapiWriteCommand, path],
    input: Buffer.from(secret, 'utf8'),
  }
}

export function matchOwnerHandshake(input: {
  message: LarkMessage
  phrase: string
  account: string
  tenant: string
}): ExternalPrincipalKey | undefined {
  if (input.message.chatType !== 'p2p' || input.message.content.trim() !== input.phrase) return undefined
  return {
    channel: 'lark',
    account: input.account,
    tenant: input.tenant,
    user: input.message.senderId,
  }
}

export function isMainEntry(moduleUrl: string, argvPath: string): boolean {
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath)
  } catch {
    return false
  }
}

function help(): string {
  return `dsh-lark-setup [options]

Safely connect one Feishu/Lark self-built bot to a DSH profile.

Options:
  --profile <name>       DSH profile (default: web)
  --domain <name>        feishu or lark (default: feishu)
  --account <id>         Local channel account id (default: primary)
  --tenant <id>          Local tenant namespace (default: personal)
  --create-app            Select, create, or officially update an app
  --app-name <name>       New app name (default: DSH Personal Assistant)
  --app-id <cli_...>      Existing app id; combine with --create-app to update it
  --install-service       Only install/restart the profile's resident service
  --refresh-agent-policy  Only refresh policy from the existing channel binding
  --no-service            Configure Lark without installing a resident service
  --linux-credential-provider <mode>
                          auto, protected-file, or secret-service (default: auto)
  --allow-agent-tools     Allow mounted foreground/external Agent capabilities
  --disable-agent-tools   Remove setup-managed Agent capability rules
  --timeout-ms <ms>      Owner DM wait, 30000..900000 (default: 300000)
  -h, --help             Show this help

Without --create-app or --app-id, press Enter at the App ID prompt to select or create an app.
App Secret is intentionally not accepted as an argument. It is stored in macOS Keychain,
Linux Secret Service (with an automatic private-file fallback for headless Linux),
or a per-user Windows DPAPI file.`
}

function runSecurity(args: readonly string[], stdio: 'inherit' | 'pipe'): string {
  const result = spawnSync('/usr/bin/security', [...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    maxBuffer: 128 * 1024,
    stdio,
  })
  if (result.status !== 0) throw new Error('lark-channel setup: macOS Keychain operation failed')
  return typeof result.stdout === 'string' ? result.stdout.trimEnd() : ''
}

function linuxCredentialEnv(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    ...(environment.DBUS_SESSION_BUS_ADDRESS === undefined
      ? {} : { DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS }),
    ...(environment.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR }),
  }
}

const linuxSecretTool = '/usr/bin/secret-tool'
/** Bound every Secret Service client call, including transaction recovery. */
const linuxSecretServiceTimeoutMs = 30_000

export interface LinuxSecretServiceCommandResult {
  status: number | null
  signal: string | null
  error?: unknown
  stdout?: string
  stderr?: string
}

export interface LinuxSecretServiceCommandInput {
  executable: string
  args: readonly string[]
  environment: NodeJS.ProcessEnv
  input?: Buffer
  captureStdout?: boolean
}

export interface LinuxSecretServicePreflightOptions {
  environment?: NodeJS.ProcessEnv
  executableAvailable?: (path: string) => boolean
  randomBytes?: (size: number) => Buffer
  run?: (input: LinuxSecretServiceCommandInput) => LinuxSecretServiceCommandResult
}

/** A deliberately static diagnostic: never include a provider's stderr or a secret value. */
class LarkSetupDiagnosticError extends Error {
  constructor(readonly diagnostic: string) {
    super(`lark-channel setup: ${diagnostic}`)
    this.name = 'LarkSetupDiagnosticError'
  }
}

function commandErrorCode(result: LinuxSecretServiceCommandResult | undefined): string | undefined {
  const error = result?.error
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function hasLinuxSecretServiceSession(environment: NodeJS.ProcessEnv): boolean {
  const dbus = environment.DBUS_SESSION_BUS_ADDRESS?.trim() ?? ''
  const runtimeDirectory = environment.XDG_RUNTIME_DIR?.trim() ?? ''
  return dbus !== '' || runtimeDirectory !== ''
}

function linuxSecretServiceDiagnostic(
  operation: 'preflight' | 'credential store' | 'credential lookup' | 'credential cleanup',
  result: LinuxSecretServiceCommandResult | undefined,
  environment: NodeJS.ProcessEnv,
): LarkSetupDiagnosticError {
  const common = 'Run setup as the target logged-in user (not via sudo or a detached SSH session). '
    + 'For a headless server or container, use the default auto fallback or rerun with '
    + '--linux-credential-provider protected-file.'
  if (commandErrorCode(result) === 'ENOENT') {
    return new LarkSetupDiagnosticError(
      `Linux Secret Service ${operation} cannot find ${linuxSecretTool}. Install libsecret-tools and a Secret Service provider, then retry. ${common}`,
    )
  }
  if (!hasLinuxSecretServiceSession(environment)) {
    return new LarkSetupDiagnosticError(
      `Linux Secret Service ${operation} has no user D-Bus session. Start from the target user's desktop/login session with DBUS_SESSION_BUS_ADDRESS or XDG_RUNTIME_DIR set. ${common}`,
    )
  }
  const wasSignalled = result?.signal !== undefined && result.signal !== null
  if (commandErrorCode(result) === 'ETIMEDOUT' || wasSignalled) {
    return new LarkSetupDiagnosticError(
      `Linux Secret Service ${operation} did not respond. Unlock or start a Secret Service provider such as GNOME Keyring, KWallet, or KeePassXC, then retry. ${common}`,
    )
  }
  return new LarkSetupDiagnosticError(
    `Linux Secret Service ${operation} failed. Ensure ${linuxSecretTool} is installed and an unlocked org.freedesktop.secrets provider is available in this user's session, then retry. ${common}`,
  )
}

function defaultLinuxSecretToolAvailable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function defaultLinuxSecretServiceCommand(input: LinuxSecretServiceCommandInput): LinuxSecretServiceCommandResult {
  const result = spawnSync(input.executable, [...input.args], {
    encoding: 'utf8',
    env: input.environment,
    timeout: linuxSecretServiceTimeoutMs,
    maxBuffer: 128 * 1024,
    ...(input.input === undefined ? {} : { input: input.input }),
    stdio: [input.input === undefined ? 'ignore' : 'pipe', input.captureStdout ? 'pipe' : 'ignore', 'pipe'],
  })
  return {
    status: result.status,
    signal: result.signal,
    ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}),
    ...(typeof result.stderr === 'string' ? { stderr: result.stderr } : {}),
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function captureLinuxSecretServiceCommand(
  run: NonNullable<LinuxSecretServicePreflightOptions['run']>,
  input: LinuxSecretServiceCommandInput,
): LinuxSecretServiceCommandResult {
  try {
    return run(input)
  } catch (error) {
    // Test seams and alternate runners may throw rather than return spawnSync's
    // structured error. Preserve only the error code for static diagnostics;
    // provider messages can contain secret material and must never be rendered.
    return { status: null, signal: null, error }
  }
}

/** libsecret reports a clear with no matching item as status 1 and no diagnostics. */
export function isLinuxSecretServiceClearAbsent(result: LinuxSecretServiceCommandResult): boolean {
  return result.status === 1
    && result.signal === null
    && result.error === undefined
    && typeof result.stderr === 'string'
    && result.stderr.trim() === ''
}

function verifyLinuxSecretServiceWriteCanary(input: {
  environment: NodeJS.ProcessEnv
  random: (size: number) => Buffer
  run: (input: LinuxSecretServiceCommandInput) => LinuxSecretServiceCommandResult
}): void {
  const service = `dsh/lark/setup-preflight/${input.random(16).toString('hex')}`
  const account = 'setup-probe'
  const secret = input.random(32).toString('hex')
  const write = createSecretServiceWriteRequest(service, account, secret)
  let primaryError: unknown
  try {
    const stored = captureLinuxSecretServiceCommand(input.run, {
      executable: linuxSecretTool,
      args: write.args,
      environment: input.environment,
      input: write.input,
    })
    if (stored.status !== 0) {
      throw linuxSecretServiceDiagnostic('credential store', stored, input.environment)
    }
    const read = captureLinuxSecretServiceCommand(input.run, {
      executable: linuxSecretTool,
      args: ['lookup', 'service', service, 'account', account],
      environment: input.environment,
      captureStdout: true,
    })
    if (read.status !== 0) {
      throw linuxSecretServiceDiagnostic('credential lookup', read, input.environment)
    }
    if ((read.stdout ?? '').trimEnd() !== secret) {
      throw new LarkSetupDiagnosticError(
        'Linux Secret Service preflight could not read back its generated test credential. '
          + 'Unlock or repair the Secret Service provider, then retry.',
      )
    }
  } catch (error) {
    primaryError = error
  } finally {
    write.input.fill(0)
  }
  const cleared = captureLinuxSecretServiceCommand(input.run, {
    executable: linuxSecretTool,
    args: ['clear', 'service', service, 'account', account],
    environment: input.environment,
  })
  if (cleared.status !== 0 && !isLinuxSecretServiceClearAbsent(cleared)) {
    const cleanupError = linuxSecretServiceDiagnostic('credential cleanup', cleared, input.environment)
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'lark-channel setup: Linux Secret Service preflight failed and canary cleanup also failed',
      )
    }
    throw cleanupError
  }
  if (primaryError !== undefined) throw primaryError
}

/**
 * Checks the Linux credential prerequisites before an OAuth flow changes a
 * cloud app. It stores, reads, and clears a random non-production canary, and
 * never reads, writes, or prints an application credential.
 */
export function assertLinuxSecretServiceAvailable(options: LinuxSecretServicePreflightOptions = {}): void {
  const environment = linuxCredentialEnv(options.environment ?? process.env)
  const available = options.executableAvailable ?? defaultLinuxSecretToolAvailable
  if (!available(linuxSecretTool)) {
    throw linuxSecretServiceDiagnostic('preflight', {
      status: null, signal: null, error: { code: 'ENOENT' },
    }, environment)
  }
  if (!hasLinuxSecretServiceSession(environment)) {
    throw linuxSecretServiceDiagnostic('preflight', undefined, environment)
  }
  verifyLinuxSecretServiceWriteCanary({
    environment,
    random: options.randomBytes ?? randomBytes,
    run: options.run ?? defaultLinuxSecretServiceCommand,
  })
}

export function preflightLarkCredentialProvider(provider: SetupCredentialProvider): void {
  if (provider === 'linux-secret-service') assertLinuxSecretServiceAvailable()
}

export interface LarkCredentialProviderSelection {
  provider: SetupCredentialProvider
  /** Present only when Linux Secret Service was unavailable and setup selected its private-file fallback. */
  fallbackReason?: unknown
}

export interface LarkCredentialProviderSelectionOptions extends LinuxSecretServicePreflightOptions {
  dshHome: string
  mode?: LarkSetupArgs['linuxCredentialProvider']
}

async function assertLinuxProtectedFileRuntimeSupported(): Promise<void> {
  let providers: unknown
  try {
    const keychain = await import('@dsh-enhanced/credentials-keychain/capabilities')
    providers = keychain.supportedCredentialProviders
  } catch (error) {
    throw new Error(
      'lark-channel setup: cannot load a compatible credentials-keychain package; reinstall matching plugin versions',
      { cause: error },
    )
  }
  if (!Array.isArray(providers) || !providers.includes('linux-protected-file')) {
    throw new Error(
      'lark-channel setup: installed credentials-keychain does not support headless Linux; reinstall matching plugin versions',
    )
  }
}

/** Verifies that the headless backend can survive the same write/read/delete lifecycle as onboarding. */
export async function assertLinuxProtectedFileAvailable(input: {
  dshHome: string
  randomBytes?: (size: number) => Buffer
  afterStore?: (path: string) => void | Promise<void>
}): Promise<void> {
  if (!isAbsolute(input.dshHome)) throw new Error('lark-channel setup: DSH_HOME must be absolute')
  const random = input.randomBytes ?? randomBytes
  const path = join(input.dshHome, 'credentials-keychain',
    `.lark-setup-preflight-${random(16).toString('hex')}.secret`)
  const secret = random(32).toString('hex')
  let stored = false
  let primaryError: unknown
  try {
    await storeLinuxProtectedCredential(path, secret)
    stored = true
    await input.afterStore?.(path)
    if (await readLinuxProtectedCredential(path) !== secret) {
      throw new Error('lark-channel setup: Linux protected credential preflight readback did not match')
    }
  } catch (error) {
    primaryError = error
  }
  if (stored) {
    try {
      await removeCredential({ provider: 'linux-protected-file', path })
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'lark-channel setup: Linux protected credential preflight and cleanup both failed',
        )
      }
      throw cleanupError
    }
  }
  if (primaryError !== undefined) throw primaryError
}

/**
 * Prefers the desktop keyring but lets a headless Linux login continue without
 * weakening the profile to an ambient environment variable. Unexpected setup
 * errors remain fail-closed; only our static Secret Service diagnostics select
 * the protected-file backend.
 */
export async function selectLarkCredentialProvider(
  preferred: SetupCredentialProvider,
  options: LarkCredentialProviderSelectionOptions,
): Promise<LarkCredentialProviderSelection> {
  const mode = options.mode ?? 'auto'
  if (preferred !== 'linux-secret-service') {
    if (mode !== 'auto') {
      throw new Error('lark-channel setup: --linux-credential-provider is only valid on Linux')
    }
    return { provider: preferred }
  }
  if (mode === 'protected-file') {
    await assertLinuxProtectedFileRuntimeSupported()
    await assertLinuxProtectedFileAvailable(options)
    return { provider: 'linux-protected-file' }
  }
  try {
    assertLinuxSecretServiceAvailable(options)
    return { provider: preferred }
  } catch (error) {
    if (mode === 'secret-service' || safeDiagnosticMessages(error).length === 0) throw error
    await assertLinuxProtectedFileRuntimeSupported()
    await assertLinuxProtectedFileAvailable(options)
    return { provider: 'linux-protected-file', fallbackReason: error }
  }
}

function safeDiagnosticMessages(error: unknown): string[] {
  const messages = new Set<string>()
  const visited = new Set<unknown>()
  const walk = (current: unknown): void => {
    if (current === null || typeof current !== 'object' || visited.has(current)) return
    visited.add(current)
    if (current instanceof LarkSetupDiagnosticError) {
      messages.add(current.diagnostic)
      return
    }
    if (current instanceof AggregateError) {
      for (const nested of current.errors) walk(nested)
      return
    }
    if (current instanceof Error) walk(current.cause)
  }
  walk(error)
  return [...messages]
}

/** Adds only static, credential-safe diagnostics to AggregateError CLI output. */
export function formatLarkSetupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (!(error instanceof AggregateError)) return message
  const diagnostics = safeDiagnosticMessages(error)
  return diagnostics.length === 0 ? message : `${message}\n${diagnostics.map(value => `Hint: ${value}`).join('\n')}`
}

const protectedCredentialMaxBytes = 65_536

function currentLinuxCredentialUid(): number {
  const uid = process.getuid?.()
  const effectiveUid = process.geteuid?.()
  if (uid === undefined || effectiveUid === undefined || uid !== effectiveUid) {
    throw new Error('lark-channel setup: Linux protected credentials require matching real and effective user IDs')
  }
  return uid
}

function linuxProtectedCredentialDirectory(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.length > 1_024
    || path.includes('\0') || !path.endsWith('.secret')) {
    throw new Error('lark-channel setup: invalid Linux protected credential path')
  }
  return dirname(path)
}

async function ensureLinuxProtectedCredentialDirectory(path: string): Promise<void> {
  const directory = linuxProtectedCredentialDirectory(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let metadata = await lstat(directory)
  const uid = currentLinuxCredentialUid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== uid) {
    throw new Error('lark-channel setup: Linux protected credential directory is not private to the current user')
  }
  if ((metadata.mode & 0o7777) !== 0o700) {
    await chmod(directory, 0o700)
    metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.uid !== uid || (metadata.mode & 0o7777) !== 0o700) {
      throw new Error('lark-channel setup: Linux protected credential directory could not be secured')
    }
  }
}

async function assertLinuxProtectedCredentialDirectory(path: string): Promise<void> {
  const directory = linuxProtectedCredentialDirectory(path)
  const metadata = await lstat(directory)
  const uid = currentLinuxCredentialUid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== uid || (metadata.mode & 0o7777) !== 0o700) {
    throw new Error('lark-channel setup: Linux protected credential directory failed its security check')
  }
}

async function storeLinuxProtectedCredential(path: string, secret: string): Promise<void> {
  const value = Buffer.from(secret, 'utf8')
  if (value.byteLength < 1 || value.byteLength > protectedCredentialMaxBytes || value.includes(0)) {
    value.fill(0)
    throw new Error('lark-channel setup: Linux protected credential value is invalid')
  }
  let file: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    await ensureLinuxProtectedCredentialDirectory(path)
    // The locator contains a fresh random version, so an existing final item
    // is a collision or interference. O_EXCL avoids following or replacing it.
    file = await open(path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600)
    created = true
    await file.chmod(0o600)
    await file.writeFile(value)
    await file.sync()
    const metadata = await file.stat()
    const uid = currentLinuxCredentialUid()
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== uid || (metadata.mode & 0o7777) !== 0o600
      || metadata.size !== value.byteLength) {
      throw new Error('lark-channel setup: Linux protected credential file failed its security check')
    }
    await file.close()
    file = undefined
    await syncDirectory(dirname(path))
  } catch (error) {
    try {
      await file?.close()
    } catch {}
    file = undefined
    if (created) {
      try {
        await unlink(path)
        await syncDirectory(dirname(path))
      } catch (cleanupError) {
        if (fileSystemErrorCode(cleanupError) !== 'ENOENT') {
          throw new AggregateError(
            [error, cleanupError],
            'lark-channel setup: Linux protected credential write and cleanup both failed',
          )
        }
      }
    }
    throw error
  } finally {
    value.fill(0)
    await file?.close()
  }
}

async function readLinuxProtectedCredential(path: string): Promise<string> {
  await assertLinuxProtectedCredentialDirectory(path)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let value: Buffer | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await file.stat()
    const uid = currentLinuxCredentialUid()
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.uid !== uid || (before.mode & 0o7777) !== 0o600
      || before.size < 1 || before.size > protectedCredentialMaxBytes) {
      throw new Error('lark-channel setup: Linux protected credential file failed its security check')
    }
    value = Buffer.alloc(protectedCredentialMaxBytes + 1)
    let bytesRead = 0
    while (bytesRead < value.byteLength) {
      const result = await file.read(value, bytesRead, value.byteLength - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const after = await file.stat()
    if (bytesRead < 1 || bytesRead > protectedCredentialMaxBytes
      || bytesRead !== after.size
      || after.dev !== before.dev || after.ino !== before.ino
      || !after.isFile() || after.nlink !== 1 || after.uid !== uid || (after.mode & 0o7777) !== 0o600
      || value.subarray(0, bytesRead).includes(0)) {
      throw new Error('lark-channel setup: Linux protected credential value is invalid')
    }
    return value.toString('utf8', 0, bytesRead)
  } catch (error) {
    throw new Error('lark-channel setup: Linux protected credential lookup failed', { cause: error })
  } finally {
    value?.fill(0)
    await file?.close()
  }
}

export interface RawSecretTerminalOptions {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  signals?: {
    once(event: 'SIGHUP' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown
    off(event: 'SIGHUP' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  }
}

export async function readSecretFromRawTerminal(
  prompt: string,
  options: RawSecretTerminalOptions = {},
): Promise<string> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const signals = options.signals ?? process
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('lark-channel setup: no secure interactive terminal is available for the App Secret')
  }
  output.write(prompt)
  return new Promise<string>((resolve, reject) => {
    const bytes: number[] = []
    const wasRaw = input.isRaw
    const wasPaused = input.isPaused()
    let settled = false
    const signalHandlers = new Map<'SIGHUP' | 'SIGINT' | 'SIGTERM', () => void>()
    let onData: (chunk: Buffer | string) => void
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      let restorationError: unknown
      try {
        input.off('data', onData)
        for (const [signal, listener] of signalHandlers) signals.off(signal, listener)
        input.setRawMode(Boolean(wasRaw))
        if (wasPaused) input.pause()
      } catch (caught) {
        restorationError = caught
      } finally {
        output.write('\n')
      }
      const secretBytes = Buffer.from(bytes)
      const secret = secretBytes.toString('utf8')
      secretBytes.fill(0)
      bytes.fill(0)
      if (restorationError !== undefined) {
        reject(new Error('lark-channel setup: failed to restore terminal input mode', { cause: restorationError }))
      } else if (error !== undefined) reject(error)
      else if (secret.length === 0) reject(new Error('lark-channel setup: Linux could not read the App Secret securely'))
      else resolve(secret)
    }
    onData = (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      try {
        for (const byte of value) {
          if (byte === 3) {
            finish(new Error('lark-channel setup: App Secret input was cancelled'))
            return
          }
          if (byte === 10 || byte === 13) {
            finish()
            return
          }
          if (byte === 8 || byte === 127) {
            bytes.pop()
            continue
          }
          if (byte < 32 || bytes.length >= protectedCredentialMaxBytes) {
            finish(new Error('lark-channel setup: App Secret input is invalid or too large'))
            return
          }
          bytes.push(byte)
        }
      } finally {
        value.fill(0)
      }
    }
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
      const listener = (): void => finish(new Error(`lark-channel setup: App Secret input interrupted by ${signal}`))
      signalHandlers.set(signal, listener)
      signals.once(signal, listener)
    }
    try {
      input.setRawMode(true)
      input.on('data', onData)
      input.resume()
    } catch (error) {
      finish(new Error('lark-channel setup: could not enter secure terminal input mode', { cause: error }))
    }
  })
}

async function readLinuxManualSecret(): Promise<string> {
  if (defaultLinuxSecretToolAvailable('/usr/bin/systemd-ask-password')) {
    const prompt = spawnSync('/usr/bin/systemd-ask-password', ['飞书 App Secret：'], {
      encoding: 'utf8', env: linuxCredentialEnv(), maxBuffer: 128 * 1024, stdio: ['inherit', 'pipe', 'inherit'],
    })
    const secret = typeof prompt.stdout === 'string' ? prompt.stdout.replace(/[\r\n]+$/u, '') : ''
    if (prompt.status !== 0 || secret.length === 0) {
      throw new Error('lark-channel setup: Linux could not read the App Secret securely')
    }
    return secret
  }
  return readSecretFromRawTerminal('\n飞书 App Secret（输入不会回显）：')
}

function executeSecretWrite(
  request: SecretWriteRequest,
  env: NodeJS.ProcessEnv,
  failure: string | ((result: LinuxSecretServiceCommandResult) => Error),
): void {
  try {
    const result = spawnSync(request.executable, request.args, {
      encoding: 'utf8',
      env,
      ...(request.executable === linuxSecretTool ? { timeout: linuxSecretServiceTimeoutMs } : {}),
      input: request.input,
      maxBuffer: 128 * 1024,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    if (result.status !== 0) {
      throw typeof failure === 'string' ? new Error(failure) : failure(result)
    }
  } finally {
    request.input.fill(0)
  }
}

async function storeSecret(
  provider: SetupCredentialProvider,
  service: string,
  account: string,
  credentialPath?: string,
): Promise<void> {
  if (provider === 'macos-keychain') {
    process.stdout.write('\n请在 macOS Keychain 的安全提示中输入 App Secret（输入不会回显）：\n')
    runSecurity(['add-generic-password', '-U', '-a', account, '-s', service, '-w'], 'inherit')
    return
  }
  if (provider === 'linux-secret-service' || provider === 'linux-protected-file') {
    const secret = await readLinuxManualSecret()
    if (provider === 'linux-protected-file') {
      if (credentialPath === undefined) throw new Error('lark-channel setup: missing Linux protected credential path')
      await storeLinuxProtectedCredential(credentialPath, secret)
    } else {
      const environment = linuxCredentialEnv()
      executeSecretWrite(createSecretServiceWriteRequest(service, account, secret), environment,
        result => linuxSecretServiceDiagnostic('credential store', result, environment))
    }
    return
  }
  if (credentialPath === undefined || (!isAbsolute(credentialPath) && !win32.isAbsolute(credentialPath))) {
    throw new Error('lark-channel setup: invalid DPAPI credential path')
  }
  const manualCommand = "$secure = Read-Host 'Feishu App Secret' -AsSecureString; $credential = [pscredential]::new('dsh-enhanced', $secure); $credential | Export-Clixml -LiteralPath $args[0]"
  const result = spawnSync(windowsPowerShell, [
    '-NoLogo', '-NoProfile', '-Command', manualCommand, credentialPath,
  ], { encoding: 'utf8', env: { PATH: 'C:\\Windows\\System32;C:\\Windows', SystemRoot: 'C:\\Windows' }, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('lark-channel setup: Windows DPAPI operation failed')
}

async function storeGeneratedSecret(
  provider: SetupCredentialProvider,
  service: string,
  account: string,
  secret: string,
  credentialPath?: string,
): Promise<void> {
  if (provider === 'macos-keychain') {
    const request = createKeychainWriteRequest(service, account, secret)
    try {
      const result = spawnSync('/usr/bin/security', request.args, {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, input: request.input,
        maxBuffer: 128 * 1024, stdio: ['pipe', 'ignore', 'pipe'],
      })
      if (result.status !== 0) throw new Error('lark-channel setup: macOS Keychain operation failed')
    } finally {
      request.input.fill(0)
    }
    return
  }
  if (provider === 'linux-secret-service') {
    const environment = linuxCredentialEnv()
    executeSecretWrite(createSecretServiceWriteRequest(service, account, secret), environment,
      result => linuxSecretServiceDiagnostic('credential store', result, environment))
    return
  }
  if (provider === 'linux-protected-file') {
    if (credentialPath === undefined) throw new Error('lark-channel setup: missing Linux protected credential path')
    await storeLinuxProtectedCredential(credentialPath, secret)
    return
  }
  if (credentialPath === undefined) throw new Error('lark-channel setup: missing DPAPI credential path')
  executeSecretWrite(createWindowsDpapiWriteRequest(credentialPath, secret), {
    PATH: 'C:\\Windows\\System32;C:\\Windows', SystemRoot: 'C:\\Windows',
  }, 'lark-channel setup: Windows DPAPI operation failed')
}

async function readSecret(
  provider: SetupCredentialProvider,
  service: string,
  account: string,
  credentialPath?: string,
): Promise<string> {
  let value = ''
  if (provider === 'macos-keychain') {
    value = runSecurity(['find-generic-password', '-w', '-a', account, '-s', service], 'pipe')
  } else if (provider === 'linux-secret-service') {
    const environment = linuxCredentialEnv()
    const result = spawnSync(linuxSecretTool, ['lookup', 'service', service, 'account', account], {
      encoding: 'utf8', env: environment, timeout: linuxSecretServiceTimeoutMs,
      maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) throw linuxSecretServiceDiagnostic('credential lookup', result, environment)
    value = typeof result.stdout === 'string' ? result.stdout.trimEnd() : ''
  } else if (provider === 'linux-protected-file') {
    if (credentialPath === undefined) throw new Error('lark-channel setup: missing Linux protected credential path')
    value = await readLinuxProtectedCredential(credentialPath)
  } else {
    if (credentialPath === undefined) throw new Error('lark-channel setup: missing DPAPI credential path')
    const result = spawnSync(windowsPowerShell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsDpapiReadCommand, credentialPath,
    ], {
      encoding: 'utf8', env: { PATH: 'C:\\Windows\\System32;C:\\Windows', SystemRoot: 'C:\\Windows' },
      maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) throw new Error('lark-channel setup: Windows DPAPI lookup failed')
    value = typeof result.stdout === 'string' ? result.stdout : ''
  }
  if (value.length === 0) throw new Error('lark-channel setup: credential store returned an empty secret')
  return value
}

function findYamlRow(rows: ReturnType<typeof parseDocument>['contents'], id: string): YAMLMap | undefined {
  if (!isSeq(rows)) return undefined
  return rows.items.find(item => isMap(item) && item.get('id') === id) as YAMLMap | undefined
}

function platformJoin(root: string, ...segments: string[]): string {
  return !isAbsolute(root) && win32.isAbsolute(root) ? win32.join(root, ...segments) : join(root, ...segments)
}

function setupRowIsEnabled(row: YAMLMap): boolean {
  const disabled = row.get('disabled')
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    throw new Error('lark-channel setup: effective profile row has a non-boolean disabled value')
  }
  return disabled !== true
}

function exactYamlStringSequence(node: Node | undefined, expected: readonly string[]): boolean {
  if (!isSeq(node) || node.items.length !== expected.length) return false
  return node.items.every((item, index) => (item as Node | null)?.toJSON() === expected[index])
}

function exactManagedCredentialHandleShape(handle: YAMLMap, provider: SetupCredentialProvider): boolean {
  const expectedKeys = provider === 'windows-dpapi' || provider === 'linux-protected-file'
    ? ['consumers', 'id', 'maxLeaseMs', 'path', 'provider', 'purposes']
    : ['account', 'consumers', 'id', 'maxLeaseMs', 'provider', 'purposes', 'service']
  const value = handle.toJSON() as Record<string, unknown>
  return Object.keys(value).sort().join('\0') === expectedKeys.join('\0')
    && exactYamlStringSequence(handle.get('consumers', true) as Node | undefined, ['dsh-enhanced-lark-channel'])
    && exactYamlStringSequence(handle.get('purposes', true) as Node | undefined, ['connect'])
    && handle.get('maxLeaseMs') === 86_400_000
}

function credentialHandleAliasesLocator(handle: unknown, locator: SetupCredentialLocator): boolean {
  if (!isMap(handle) || handle.get('provider') !== locator.provider) return false
  if (locator.provider === 'windows-dpapi' || locator.provider === 'linux-protected-file') {
    return handle.get('path') === locator.path
  }
  return handle.get('service') === locator.service && handle.get('account') === locator.account
}

export interface ManagedCredentialLocatorInput {
  profilePatch: string
  dshHome: string
  profile: string
}

/**
 * Returns only locators whose complete shape matches a setup-owned Lark
 * credential. Ambiguous or user-authored handles are intentionally retained.
 */
export function findManagedLarkCredentialLocator(
  input: ManagedCredentialLocatorInput,
): SetupCredentialLocator | undefined {
  const document = parseDocument(input.profilePatch)
  if (document.errors.length > 0 || !isSeq(document.contents)) return undefined
  const larkRow = findYamlRow(document.contents, 'dsh-enhanced-lark-channel')
  const credentialRow = findYamlRow(document.contents, 'dsh-enhanced-credentials-keychain')
  if (larkRow === undefined || credentialRow === undefined) return undefined
  const channel = larkRow.get('config', true) as Node | undefined
  const credentialConfig = credentialRow.get('config', true) as Node | undefined
  if (!isMap(channel) || !isMap(credentialConfig)) return undefined
  const account = channel.get('account')
  const handleId = channel.get('credentialHandle')
  if (typeof account !== 'string'
    || !setupKeyPattern.test(account)
    || handleId !== `lark-app-secret-${account}`) return undefined
  const handles = credentialConfig.get('handles', true) as Node | undefined
  if (!isSeq(handles)) return undefined
  const matchingHandles = handles.items.filter(item => isMap(item) && item.get('id') === handleId)
  if (matchingHandles.length !== 1) return undefined
  const handle = matchingHandles[0]
  if (!isMap(handle)) return undefined
  const provider = handle.get('provider')
  if ((provider !== 'macos-keychain'
      && provider !== 'linux-protected-file'
      && provider !== 'linux-secret-service'
      && provider !== 'windows-dpapi')
    || !exactManagedCredentialHandleShape(handle, provider)) return undefined
  if (provider === 'macos-keychain' || provider === 'linux-secret-service') {
    const service = handle.get('service')
    const credentialAccount = handle.get('account')
    const baseService = `dsh/lark/${input.profile}/${account}`
    const version = typeof service === 'string' && service.startsWith(`${baseService}/versions/`)
      ? service.slice(`${baseService}/versions/`.length)
      : undefined
    if (typeof service !== 'string'
      || credentialAccount !== account
      || (service !== baseService && (version === undefined || !credentialVersionPattern.test(version)))) {
      return undefined
    }
    const locator: SetupCredentialLocator = { provider, service, account }
    if (handles.items.some(item => item !== handle && credentialHandleAliasesLocator(item, locator))) return undefined
    return locator
  }
  if (provider === 'windows-dpapi' || provider === 'linux-protected-file') {
    const path = handle.get('path')
    if (typeof path !== 'string') return undefined
    const directory = platformJoin(input.dshHome, 'credentials-keychain')
    const extension = provider === 'windows-dpapi' ? '.clixml' : '.secret'
    const legacyPath = platformJoin(directory, `lark-${input.profile}-${account}${extension}`)
    const versionPrefix = platformJoin(directory, `lark-${input.profile}-${account}-`)
    const version = path.startsWith(versionPrefix) && path.endsWith(extension)
      ? path.slice(versionPrefix.length, -extension.length)
      : undefined
    const acceptsLegacy = provider === 'windows-dpapi' && path === legacyPath
    if (!acceptsLegacy && (version === undefined || !credentialVersionPattern.test(version))) return undefined
    const locator: SetupCredentialLocator = { provider, path }
    if (handles.items.some(item => item !== handle && credentialHandleAliasesLocator(item, locator))) return undefined
    return locator
  }
  return undefined
}

async function removeCredential(locator: SetupCredentialLocator): Promise<void> {
  if (locator.provider === 'windows-dpapi' || locator.provider === 'linux-protected-file') {
    try {
      await unlink(locator.path)
      if (locator.provider === 'linux-protected-file') await syncDirectory(dirname(locator.path))
    } catch (error) {
      if (fileSystemErrorCode(error) !== 'ENOENT') {
        const backend = locator.provider === 'windows-dpapi' ? 'Windows DPAPI' : 'Linux protected file'
        throw new Error(`lark-channel setup: ${backend} credential cleanup failed`, { cause: error })
      }
    }
    return
  }
  if (locator.provider === 'linux-secret-service') {
    const environment = linuxCredentialEnv()
    const result = spawnSync(linuxSecretTool, [
      'clear', 'service', locator.service, 'account', locator.account,
    ], {
      encoding: 'utf8', env: environment, timeout: linuxSecretServiceTimeoutMs,
      maxBuffer: 128 * 1024, stdio: ['ignore', 'ignore', 'pipe'],
    })
    if (result.status !== 0 && !isLinuxSecretServiceClearAbsent(result)) {
      throw linuxSecretServiceDiagnostic('credential cleanup', result, environment)
    }
    return
  }
  const result = spawnSync('/usr/bin/security', [
    'delete-generic-password', '-a', locator.account, '-s', locator.service,
  ], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, maxBuffer: 128 * 1024, stdio: ['ignore', 'ignore', 'pipe'],
  })
  const missingMacosItem = result.status === 44
  const missingItemMessage = typeof result.stderr === 'string'
    && /(?:could not be found|not found|no matching|no such)/iu.test(result.stderr)
  if (result.status !== 0 && !missingMacosItem && !missingItemMessage) {
    throw new Error('lark-channel setup: macos-keychain credential cleanup failed')
  }
}

function credentialIsAlreadyAbsent(error: unknown): boolean {
  const code = fileSystemErrorCode(error)
  return code === 'ENOENT' || code === 'not-found'
}

async function removeCredentialIdempotently(
  locator: SetupCredentialLocator,
  operation: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>,
): Promise<void> {
  try {
    await operation(locator)
  } catch (error) {
    if (!credentialIsAlreadyAbsent(error)) throw error
  }
}

async function retirePreviousCredential(
  locator: SetupCredentialLocator,
  operation: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>,
): Promise<void> {
  try {
    await removeCredentialIdempotently(locator, operation)
  } catch (error) {
    // The profile and Delivery owner already reference the staged credential,
    // so rollback is unsafe. Callers retain their paired journal and retry the
    // exact old locator before allowing another credential rotation.
    throw new AggregateError(
      [error],
      'lark-channel setup: profile and owner were committed, but previous credential cleanup is pending; repair the credential provider and rerun setup',
    )
  }
}

/**
 * Compatibility behavior for the legacy non-journal commit helper below.
 * Full onboarding uses retirePreviousCredential directly so it can retain its
 * paired journal and retry the exact locator on the next invocation.
 */
async function retirePreviousCredentialBestEffort(
  locator: SetupCredentialLocator,
  operation: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>,
): Promise<void> {
  try {
    await retirePreviousCredential(locator, operation)
  } catch {
    process.stderr.write('lark-channel setup: previous credential cleanup failed after commit\n')
  }
}

async function registerLarkApplication(args: LarkSetupArgs): Promise<RegisterAppResult> {
  const abortController = new AbortController()
  const abort = (): void => abortController.abort()
  process.once('SIGINT', abort)
  let qrRender = Promise.resolve()
  try {
    return await registerApp(createLarkRegistrationOptions({
      domain: args.domain,
      appName: args.appName,
      ...(args.appId === undefined ? {} : { appId: args.appId }),
      signal: abortController.signal,
      onQRCodeReady(info) {
        process.stdout.write(`\n请在飞书中打开以下链接，选择已有应用或创建新应用（${info.expireIn} 秒内有效）：\n${info.url}\n\n`)
        qrRender = QRCode.toString(info.url, { type: 'terminal', small: true })
          .then(code => { process.stdout.write(`${code}\n`) })
          .catch(() => { process.stdout.write('终端二维码生成失败，请直接打开上面的链接。\n') })
      },
      onStatusChange(info) {
        if (info.status === 'domain_switched') process.stdout.write('已切换到 Lark 国际版授权域。\n')
        if (info.status === 'slow_down') process.stdout.write('飞书要求降低授权轮询频率，正在继续等待确认…\n')
      },
    }))
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
    if (code === 'access_denied') throw new Error('lark-channel setup: app creation was denied in Feishu')
    if (code === 'expired_token') throw new Error('lark-channel setup: the app creation link expired; run the wizard again')
    if (code === 'abort') throw new Error('lark-channel setup: app creation was cancelled')
    throw new Error('lark-channel setup: Feishu could not create the application')
  } finally {
    await qrRender
    process.removeListener('SIGINT', abort)
  }
}

async function discoverOwner(
  transport: LarkTransport,
  phrase: string,
  account: string,
  tenant: string,
  timeoutMs: number,
): Promise<ExternalPrincipalKey> {
  let finish!: (principal: ExternalPrincipalKey) => void
  let fail!: (error: Error) => void
  const owner = new Promise<ExternalPrincipalKey>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const timer = setTimeout(() => fail(new Error('lark-channel setup: timed out waiting for the owner DM')), timeoutMs)
  const unsubscribe = transport.subscribe({
    async message(message) {
      const principal = matchOwnerHandshake({ message, phrase, account, tenant })
      if (principal !== undefined) finish(principal)
    },
    async cardAction() {},
    reconnecting() {},
    reconnected() {},
    error() { fail(new Error('lark-channel setup: Lark WebSocket disconnected during owner discovery')) },
  })
  try {
    await transport.connect()
    process.stdout.write(`\n连接成功。现在请在飞书中私聊该机器人，原样发送：\n\n  ${phrase}\n\n`)
    return await owner
  } finally {
    clearTimeout(timer)
    unsubscribe()
    await transport.disconnect().catch(() => {})
  }
}

export interface ProfileSetupLockOptions {
  timeoutMs?: number
  pollMs?: number
  staleMs?: number
  heartbeatMs?: number
}

const defaultProfileSetupLockOptions = {
  timeoutMs: 30_000,
  pollMs: 100,
  staleMs: 120_000,
  heartbeatMs: 10_000,
} as const

function fileSystemErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

function normalizedProfileSetupLockOptions(options: ProfileSetupLockOptions): Required<ProfileSetupLockOptions> {
  const normalized = { ...defaultProfileSetupLockOptions, ...options }
  if (!Number.isSafeInteger(normalized.timeoutMs) || normalized.timeoutMs < 1 || normalized.timeoutMs > 300_000) {
    throw new Error('lark-channel setup: invalid profile lock timeout')
  }
  if (!Number.isSafeInteger(normalized.pollMs) || normalized.pollMs < 1 || normalized.pollMs > 5_000) {
    throw new Error('lark-channel setup: invalid profile lock poll interval')
  }
  if (!Number.isSafeInteger(normalized.staleMs) || normalized.staleMs < 100 || normalized.staleMs > 3_600_000) {
    throw new Error('lark-channel setup: invalid profile lock stale interval')
  }
  if (!Number.isSafeInteger(normalized.heartbeatMs) || normalized.heartbeatMs < 10
    || normalized.heartbeatMs >= normalized.staleMs) {
    throw new Error('lark-channel setup: invalid profile lock heartbeat interval')
  }
  return normalized
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

function sqliteDatabaseIsBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (('errcode' in error && error.errcode === 5)
      || ('errstr' in error && error.errstr === 'database is locked'))
}

async function acquireProfileSetupLock(
  patchPath: string,
  options: Required<ProfileSetupLockOptions>,
): Promise<() => Promise<void>> {
  const lockPath = `${normalizeSetupResourcePath(patchPath)}.lark-setup-lock.sqlite`
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const seed = await open(lockPath, 'a', 0o600)
  await seed.close()
  await chmod(lockPath, 0o600)
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const database = new DatabaseSync(lockPath)
    try {
      database.exec('PRAGMA busy_timeout = 0')
      database.exec('BEGIN IMMEDIATE')
    } catch (error) {
      database.close()
      if (!sqliteDatabaseIsBusy(error)) throw error
      if (Date.now() >= deadline) {
        throw new Error('lark-channel setup: another setup is already running for this profile')
      }
      await delay(Math.min(options.pollMs, Math.max(1, deadline - Date.now())))
      continue
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        database.exec('COMMIT')
      } finally {
        database.close()
      }
    }
  }
}

/**
 * Serializes every profile mutation through a SQLite write transaction. The
 * OS releases its file lock if a process is killed, avoiding stale-lock and
 * rename ABA races while preserving bounded non-blocking acquisition.
 */
export async function withProfileSetupLock<T>(
  patchPath: string,
  operation: () => Promise<T>,
  options: ProfileSetupLockOptions = {},
): Promise<T> {
  if (!isAbsolute(patchPath) && !win32.isAbsolute(patchPath)) {
    throw new Error('lark-channel setup: profile patch path must be absolute')
  }
  const release = await acquireProfileSetupLock(patchPath, normalizedProfileSetupLockOptions(options))
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await operation() }
  } catch (error) {
    outcome = { ok: false, error }
  }
  let releaseError: unknown
  try {
    await release()
  } catch (error) {
    releaseError = error
  }
  if (!outcome.ok) throw outcome.error
  if (releaseError !== undefined) throw releaseError
  return outcome.value
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = join(dirname(path),
    `.cordis.patch.yml.lark-setup-${process.pid}-${randomBytes(8).toString('hex')}`)
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try {
      await file.chmod(0o600)
      await file.writeFile(value, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    if (created) await rm(temporary, { force: true })
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined
  try {
    directory = await open(path, 'r')
    await directory.sync()
  } catch (error) {
    if (process.platform !== 'win32') throw error
  } finally {
    await directory?.close()
  }
}

export type LarkSetupJournalPhase = 'staging' | 'candidate' | 'validated' | 'paired' | 'aborting'

export interface PersistLarkSetupJournalInput {
  patchPath: string
  dshHome: string
  profile: string
  operation: 'full' | 'refresh'
  phase: LarkSetupJournalPhase
  originalPatch: string
  updatedPatch?: string
  databasePath?: string
  account?: string
  principal?: ExternalPrincipalKey
  stagedCredential?: SetupCredentialLocator
  previousCredential?: SetupCredentialLocator
  installService: boolean
  transactionId?: string
}

interface StoredLarkSetupJournal extends PersistLarkSetupJournalInput {
  version: 1
  transactionId: string
  originalSha256: string
  updatedSha256?: string
}

export interface RecoverLarkSetupJournalOperations {
  pairPrincipal?: NonNullable<ValidatedLarkOwnerSetupOperations['pairPrincipal']>
  removeCredential?: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>
  installService?: () => void | Promise<void>
  readEffectiveProfile?: (profile: string) => string | Promise<string>
}

export interface RecoverLarkSetupJournalInput {
  patchPath: string
  dshHome: string
  profile: string
  profileLockOptions?: ProfileSetupLockOptions
  operations?: RecoverLarkSetupJournalOperations
  allowDeferredSecretServiceCleanup?: boolean
}

function setupJournalPath(patchPath: string): string {
  return `${patchPath}.lark-setup.journal.json`
}

function deferredCredentialCleanupPath(patchPath: string): string {
  return `${patchPath}.lark-credential-cleanup.json`
}

function textSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function credentialLocatorEquals(left: SetupCredentialLocator, right: SetupCredentialLocator): boolean {
  if (left.provider !== right.provider) return false
  if ((left.provider === 'windows-dpapi' && right.provider === 'windows-dpapi')
    || (left.provider === 'linux-protected-file' && right.provider === 'linux-protected-file')) {
    return left.path === right.path
  }
  if (left.provider === 'windows-dpapi'
    || left.provider === 'linux-protected-file'
    || right.provider === 'windows-dpapi'
    || right.provider === 'linux-protected-file') return false
  return left.service === right.service && left.account === right.account
}

function validateJournalCredentialLocator(input: {
  locator: unknown
  dshHome: string
  profile: string
  stagedAccount?: string
}): SetupCredentialLocator {
  if (typeof input.locator !== 'object' || input.locator === null || !('provider' in input.locator)) {
    throw new Error('lark-channel setup: setup journal credential locator is invalid')
  }
  const locator = input.locator as Partial<SetupCredentialLocator>
  if (locator.provider === 'macos-keychain' || locator.provider === 'linux-secret-service') {
    if (typeof locator.service !== 'string' || typeof locator.account !== 'string'
      || !setupKeyPattern.test(locator.account)
      || (input.stagedAccount !== undefined && locator.account !== input.stagedAccount)) {
      throw new Error('lark-channel setup: setup journal credential locator is invalid')
    }
    const base = `dsh/lark/${input.profile}/${locator.account}`
    const versionPrefix = `${base}/versions/`
    const version = locator.service.startsWith(versionPrefix) ? locator.service.slice(versionPrefix.length) : undefined
    if (input.stagedAccount === undefined) {
      if (locator.service !== base && (version === undefined || !credentialVersionPattern.test(version))) {
        throw new Error('lark-channel setup: setup journal credential locator is not setup-managed')
      }
    } else if (version === undefined || !credentialVersionPattern.test(version)) {
      throw new Error('lark-channel setup: staged journal credential must use a versioned locator')
    }
    return { provider: locator.provider, service: locator.service, account: locator.account }
  }
  if (locator.provider === 'windows-dpapi' || locator.provider === 'linux-protected-file') {
    if (typeof locator.path !== 'string') {
      throw new Error('lark-channel setup: setup journal file credential locator is invalid')
    }
    const directory = platformJoin(input.dshHome, 'credentials-keychain')
    if (dirname(locator.path) !== directory) {
      throw new Error('lark-channel setup: setup journal file credential locator is outside the credential directory')
    }
    const name = locator.path.slice(directory.length + 1)
    const profile = escapeRegularExpression(input.profile)
    const account = input.stagedAccount === undefined
      ? '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
      : escapeRegularExpression(input.stagedAccount)
    const extension = locator.provider === 'windows-dpapi' ? 'clixml' : 'secret'
    const versioned = new RegExp(`^lark-${profile}-${account}-[0-9a-f]{32}\\.${extension}$`, 'u')
    const legacy = new RegExp(`^lark-${profile}-${account}\\.clixml$`, 'u')
    const acceptsLegacy = locator.provider === 'windows-dpapi'
      && input.stagedAccount === undefined
      && legacy.test(name)
    if (!versioned.test(name) && !acceptsLegacy) {
      throw new Error('lark-channel setup: setup journal file credential locator is not setup-managed')
    }
    return { provider: locator.provider, path: locator.path }
  }
  throw new Error('lark-channel setup: setup journal credential provider is invalid')
}

interface StoredDeferredCredentialCleanup {
  version: 1
  patchPath: string
  dshHome: string
  profile: string
  locators: SetupCredentialLocator[]
  sha256: string
}

function profileReferencesCredentialLocator(profilePatch: string, locator: SetupCredentialLocator): boolean {
  const document = parseDocument(profilePatch, { uniqueKeys: true })
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    throw new Error('lark-channel setup: cannot prove a deferred credential is inactive in an invalid profile')
  }
  const rows = document.contents.items.filter(item => isMap(item)
    && (item.get('id') as unknown) === 'dsh-enhanced-credentials-keychain') as YAMLMap[]
  for (const row of rows) {
    const config = row.get('config', true) as Node | undefined
    if (!isMap(config)) {
      throw new Error('lark-channel setup: cannot prove a deferred credential is inactive in malformed credentials config')
    }
    const handles = config.get('handles', true) as Node | undefined
    if (handles === undefined) continue
    if (!isSeq(handles)) {
      throw new Error('lark-channel setup: cannot prove a deferred credential is inactive in malformed handles config')
    }
    if (handles.items.some(handle => credentialHandleAliasesLocator(handle, locator))) return true
  }
  return false
}

function deferredCleanupChecksum(locators: readonly SetupCredentialLocator[]): string {
  return textSha256(JSON.stringify(locators))
}

async function readDeferredCredentialCleanup(input: {
  patchPath: string
  dshHome: string
  profile: string
}): Promise<StoredDeferredCredentialCleanup | undefined> {
  const path = deferredCredentialCleanupPath(input.patchPath)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let buffer: Buffer | undefined
  let text: string
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await file.stat()
    const uid = currentLinuxCredentialUid()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid
      || (before.mode & 0o7777) !== 0o600 || before.size < 1 || before.size > 1024 * 1024) {
      throw new Error('lark-channel setup: deferred credential cleanup record failed its security check')
    }
    buffer = Buffer.alloc(1024 * 1024 + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const after = await file.stat()
    if (bytesRead !== after.size || after.dev !== before.dev || after.ino !== before.ino
      || !after.isFile() || after.nlink !== 1 || after.uid !== uid || (after.mode & 0o7777) !== 0o600) {
      throw new Error('lark-channel setup: deferred credential cleanup record changed while being read')
    }
    text = buffer.toString('utf8', 0, bytesRead)
  } catch (error) {
    if (fileSystemErrorCode(error) === 'ENOENT') return undefined
    throw error
  } finally {
    buffer?.fill(0)
    await file?.close()
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('lark-channel setup: deferred credential cleanup record is not valid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lark-channel setup: deferred credential cleanup record is invalid')
  }
  const record = value as Partial<StoredDeferredCredentialCleanup>
  const keys = Object.keys(record).sort()
  if (keys.join('\0') !== ['dshHome', 'locators', 'patchPath', 'profile', 'sha256', 'version'].join('\0')
    || record.version !== 1
    || record.patchPath !== input.patchPath
    || record.dshHome !== input.dshHome
    || record.profile !== input.profile
    || !Array.isArray(record.locators)
    || record.locators.length < 1
    || record.locators.length > 256) {
    throw new Error('lark-channel setup: deferred credential cleanup record identity is invalid')
  }
  const locators = record.locators.map(locator => validateJournalCredentialLocator({
    locator,
    dshHome: input.dshHome,
    profile: input.profile,
  }))
  if (record.sha256 !== deferredCleanupChecksum(locators)
    || new Set(locators.map(locator => JSON.stringify(locator))).size !== locators.length) {
    throw new Error('lark-channel setup: deferred credential cleanup record checksum or entries are invalid')
  }
  return { version: 1, ...input, locators, sha256: record.sha256 }
}

async function persistDeferredCredentialCleanup(input: {
  patchPath: string
  dshHome: string
  profile: string
  locators: readonly SetupCredentialLocator[]
}): Promise<void> {
  const identifiers = new Set<string>()
  const locators = input.locators.map(locator => validateJournalCredentialLocator({
    locator,
    dshHome: input.dshHome,
    profile: input.profile,
  })).filter(locator => {
    const identifier = JSON.stringify(locator)
    if (identifiers.has(identifier)) return false
    identifiers.add(identifier)
    return true
  })
  const path = deferredCredentialCleanupPath(input.patchPath)
  if (locators.length === 0) {
    try {
      await unlink(path)
      await syncDirectory(dirname(path))
    } catch (error) {
      if (fileSystemErrorCode(error) !== 'ENOENT') throw error
    }
    return
  }
  if (locators.length > 256) throw new Error('lark-channel setup: too many deferred credential cleanup entries')
  const record: StoredDeferredCredentialCleanup = {
    version: 1,
    patchPath: input.patchPath,
    dshHome: input.dshHome,
    profile: input.profile,
    locators,
    sha256: deferredCleanupChecksum(locators),
  }
  await atomicWrite(path, `${JSON.stringify(record)}\n`)
}

function canDeferSecretServiceCleanup(locator: SetupCredentialLocator, error: unknown): boolean {
  return locator.provider === 'linux-secret-service' && safeDiagnosticMessages(error).length > 0
}

async function deferInactiveCredentialCleanup(input: {
  patchPath: string
  dshHome: string
  profile: string
  profilePatch: string
  locator: SetupCredentialLocator
}): Promise<void> {
  if (profileReferencesCredentialLocator(input.profilePatch, input.locator)) {
    throw new Error('lark-channel setup: refusing to defer cleanup for a credential still referenced by the profile')
  }
  const current = await readDeferredCredentialCleanup(input)
  await persistDeferredCredentialCleanup({
    patchPath: input.patchPath,
    dshHome: input.dshHome,
    profile: input.profile,
    locators: [...(current?.locators ?? []), input.locator],
  })
}

/** Best-effort retry for already proven-inactive credentials. Call while holding the profile lock. */
export async function retryDeferredLarkCredentialCleanup(input: {
  patchPath: string
  dshHome: string
  profile: string
  removeCredential?: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>
}): Promise<number> {
  const pending = await readDeferredCredentialCleanup(input)
  if (pending === undefined) return 0
  const profilePatch = await readFile(input.patchPath, 'utf8')
  const remove = input.removeCredential ?? removeCredential
  const remaining: SetupCredentialLocator[] = []
  for (const locator of pending.locators) {
    if (profileReferencesCredentialLocator(profilePatch, locator)) {
      throw new Error('lark-channel setup: a deferred credential cleanup entry became active; refusing cleanup')
    }
    try {
      await removeCredentialIdempotently(locator, remove)
    } catch {
      remaining.push(locator)
    }
  }
  await persistDeferredCredentialCleanup({ ...input, locators: remaining })
  return remaining.length
}

function normalizeSetupJournalInput(input: PersistLarkSetupJournalInput): PersistLarkSetupJournalInput {
  if ((!isAbsolute(input.patchPath) && !win32.isAbsolute(input.patchPath))
    || (!isAbsolute(input.dshHome) && !win32.isAbsolute(input.dshHome))
    || !setupKeyPattern.test(input.profile)
    || input.patchPath !== platformJoin(input.dshHome, 'profiles', input.profile, 'cordis.patch.yml')) {
    throw new Error('lark-channel setup: setup journal profile identity is invalid')
  }
  if (!['full', 'refresh'].includes(input.operation)
    || !['staging', 'candidate', 'validated', 'paired', 'aborting'].includes(input.phase)
    || typeof input.originalPatch !== 'string'
    || input.originalPatch.length > 16 * 1024 * 1024
    || (input.updatedPatch !== undefined
      && (typeof input.updatedPatch !== 'string' || input.updatedPatch.length > 16 * 1024 * 1024))) {
    throw new Error('lark-channel setup: setup journal payload is invalid')
  }
  const transactionId = input.transactionId ?? randomBytes(16).toString('hex')
  if (!credentialVersionPattern.test(transactionId)) {
    throw new Error('lark-channel setup: setup journal transaction id is invalid')
  }
  if (input.operation === 'refresh') {
    if (input.phase === 'staging' || input.phase === 'paired'
      || input.updatedPatch === undefined
      || input.databasePath !== undefined
      || input.account !== undefined
      || input.principal !== undefined
      || input.stagedCredential !== undefined
      || input.previousCredential !== undefined
      || input.installService) {
      throw new Error('lark-channel setup: refresh journal payload is invalid')
    }
    return { ...input, transactionId }
  }
  if (typeof input.databasePath !== 'string'
    || (!isAbsolute(input.databasePath) && !win32.isAbsolute(input.databasePath))
    || input.stagedCredential === undefined) {
    throw new Error('lark-channel setup: full setup journal payload is incomplete')
  }
  const stagedAccount = input.account ?? input.principal?.account
  if (stagedAccount === undefined || !setupKeyPattern.test(stagedAccount)
    || (input.principal !== undefined && input.principal.account !== stagedAccount)) {
    throw new Error('lark-channel setup: full setup journal account is invalid')
  }
  const stagedCredential = validateJournalCredentialLocator({
    locator: input.stagedCredential,
    dshHome: input.dshHome,
    profile: input.profile,
    ...(stagedAccount === undefined ? {} : { stagedAccount }),
  })
  const previousCredential = input.previousCredential === undefined
    ? undefined
    : validateJournalCredentialLocator({
      locator: input.previousCredential,
      dshHome: input.dshHome,
      profile: input.profile,
    })
  if (input.phase === 'staging') {
    if (input.updatedPatch !== undefined || input.principal !== undefined) {
      throw new Error('lark-channel setup: staging journal cannot contain a candidate owner')
    }
  } else {
    const principal = input.principal
    if (input.updatedPatch === undefined
      || principal?.channel !== 'lark'
      || !setupKeyPattern.test(principal.account)
      || !setupKeyPattern.test(principal.tenant)
      || typeof principal.user !== 'string'
      || principal.user.length < 1
      || principal.user.length > 256) {
      throw new Error('lark-channel setup: setup journal owner is invalid')
    }
  }
  return {
    ...input,
    account: stagedAccount,
    transactionId,
    stagedCredential,
    ...(previousCredential === undefined ? {} : { previousCredential }),
  }
}

/** Persists one crash-recovery phase. Callers must already hold the profile lock. */
export async function persistLarkSetupJournal(input: PersistLarkSetupJournalInput): Promise<void> {
  const normalized = normalizeSetupJournalInput(input)
  const stored: StoredLarkSetupJournal = {
    ...normalized,
    version: 1,
    transactionId: normalized.transactionId!,
    originalSha256: textSha256(normalized.originalPatch),
    ...(normalized.updatedPatch === undefined ? {} : { updatedSha256: textSha256(normalized.updatedPatch) }),
  }
  await atomicWrite(setupJournalPath(normalized.patchPath), `${JSON.stringify(stored)}\n`)
}

async function readLarkSetupJournal(input: {
  patchPath: string
  dshHome: string
  profile: string
}): Promise<StoredLarkSetupJournal | undefined> {
  let text
  try {
    text = await readFile(setupJournalPath(input.patchPath), 'utf8')
  } catch (error) {
    if (fileSystemErrorCode(error) === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('lark-channel setup: setup journal is not valid JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('lark-channel setup: setup journal is invalid')
  }
  const stored = value as Partial<StoredLarkSetupJournal>
  if (stored.version !== 1
    || stored.patchPath !== input.patchPath
    || stored.dshHome !== input.dshHome
    || stored.profile !== input.profile
    || typeof stored.originalSha256 !== 'string'
    || stored.originalSha256 !== textSha256(String(stored.originalPatch ?? ''))
    || (stored.updatedPatch !== undefined
      && stored.updatedSha256 !== textSha256(String(stored.updatedPatch)))) {
    throw new Error('lark-channel setup: setup journal identity or checksum is invalid')
  }
  return {
    ...normalizeSetupJournalInput(stored as PersistLarkSetupJournalInput),
    version: 1,
    transactionId: stored.transactionId!,
    originalSha256: stored.originalSha256,
    ...(stored.updatedSha256 === undefined ? {} : { updatedSha256: stored.updatedSha256 }),
  }
}

async function clearLarkSetupJournal(patchPath: string): Promise<void> {
  try {
    await unlink(setupJournalPath(patchPath))
  } catch (error) {
    if (fileSystemErrorCode(error) !== 'ENOENT') throw error
  }
  await syncDirectory(dirname(patchPath))
}

function journalPersistInput(
  journal: StoredLarkSetupJournal,
  phase: LarkSetupJournalPhase,
): PersistLarkSetupJournalInput {
  return {
    patchPath: journal.patchPath,
    dshHome: journal.dshHome,
    profile: journal.profile,
    operation: journal.operation,
    phase,
    originalPatch: journal.originalPatch,
    ...(journal.updatedPatch === undefined ? {} : { updatedPatch: journal.updatedPatch }),
    ...(journal.databasePath === undefined ? {} : { databasePath: journal.databasePath }),
    ...(journal.account === undefined ? {} : { account: journal.account }),
    ...(journal.principal === undefined ? {} : { principal: journal.principal }),
    ...(journal.stagedCredential === undefined ? {} : { stagedCredential: journal.stagedCredential }),
    ...(journal.previousCredential === undefined ? {} : { previousCredential: journal.previousCredential }),
    installService: journal.installService,
    transactionId: journal.transactionId,
  }
}

function normalizeSetupResourcePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const windowsPath = !isAbsolute(path) && win32.isAbsolute(path)
    const parent = windowsPath ? win32.dirname(path) : dirname(path)
    if (parent === path) return windowsPath ? win32.normalize(path) : join(path)
    const name = windowsPath ? win32.basename(path) : basename(path)
    return platformJoin(normalizeSetupResourcePath(parent), name)
  }
}

function dshEffectiveDataPath(value: unknown, dshHome: string, field: string): string {
  const expression = /^dshHomePath\((['"])([^'"\\]+)\1\)$/u
  if (typeof value === 'string') {
    const matched = expression.exec(value)
    if (matched !== null) {
      const relative = matched[2]!
      if (relative.split(/[\\/]/u).some(segment => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`lark-channel setup: ${field} has an unsafe dshHomePath expression`)
      }
      return platformJoin(dshHome, ...relative.split(/[\\/]/u))
    }
  }
  if (typeof value !== 'string' || (!isAbsolute(value) && !win32.isAbsolute(value))) {
    throw new Error(`lark-channel setup: ${field} must be an absolute path or dshHomePath expression`)
  }
  return value
}

/** Resolves the exact Delivery database used by the composed profile. */
export function deliveryDatabasePathFromEffectiveProfile(effectiveProfile: string, dshHome: string): string {
  const document = parseDocument(effectiveProfile, { uniqueKeys: true })
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    throw new Error('lark-channel setup: effective profile must be a valid YAML sequence')
  }
  const deliveries = document.contents.items.filter(item => isMap(item)
    && (item.get('id') as unknown) === 'dsh-enhanced-assistant-delivery') as YAMLMap[]
  const delivery = deliveries[0]
  if (deliveries.length !== 1
    || delivery?.get('name') !== '@dsh-enhanced/assistant-delivery'
    || !setupRowIsEnabled(delivery)) {
    throw new Error('lark-channel setup: effective profile has no enabled assistant-delivery row')
  }
  const config = delivery.get('config', true) as Node | undefined
  if (!isMap(config)) throw new Error('lark-channel setup: effective assistant-delivery config must be a mapping')
  return dshEffectiveDataPath(config.get('databasePath'), dshHome, 'assistant-delivery databasePath')
}

function effectiveProfileHasEnabledLarkChannel(effectiveProfile: string, profile: string): boolean {
  const document = parseDocument(effectiveProfile, { uniqueKeys: true })
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    throw new Error(`lark-channel setup: cannot verify effective Lark ownership in profile ${profile}`)
  }
  const rows = document.contents.items.filter(item => isMap(item)
    && (item.get('id') as unknown) === 'dsh-enhanced-lark-channel') as YAMLMap[]
  if (rows.length === 0) return false
  const lark = rows[0]!
  if (rows.length !== 1 || lark.get('name') !== '@dsh-enhanced/lark-channel') {
    throw new Error(`lark-channel setup: profile ${profile} has an invalid effective Lark package row`)
  }
  if (!setupRowIsEnabled(lark)) return false
  const config = lark.get('config', true) as Node | undefined
  if (config === undefined) return true
  if (!isMap(config)) throw new Error(`lark-channel setup: profile ${profile} has an invalid Lark config`)
  return config.get('enabled') !== false
}

interface EffectiveLarkOwnerBinding {
  account: string
  tenant: string
  appId: string
  domain: 'feishu' | 'lark'
  credentialHandle: string
  credentialPurpose: string
  credentialLeaseMs: number
  managedPolicyRules: string
}

function externalPrincipalKeyId(principal: ExternalPrincipalKey): string {
  return [principal.channel, principal.account, principal.tenant, principal.user]
    .map(component => encodeURIComponent(component))
    .join('/')
}

function exactYamlMapKeys(node: YAMLMap, expected: readonly string[]): boolean {
  const value = node.toJSON() as Record<string, unknown>
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

const managedPolicyRulePrefixes = [
  'lark-channel-credential-',
  'lark-owner-approval-',
  'lark-owner-ingress-',
  'lark-owner-preference-signal-',
  'lark-owner-preference-snapshot-',
  'lark-owner-reply-',
  'lark-owner-capability-',
  'lark-owner-tool-',
  'dsh-enhanced-foreground-capability-',
  'dsh-enhanced-foreground-tool-',
  'lark-foreground-capability-',
  'lark-foreground-tool-',
] as const

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableJsonValue(entry)]))
}

function managedPolicyFingerprint(rules: Node): string {
  if (!isSeq(rules)) throw new Error('profile does not have assistant policy rules')
  return JSON.stringify(rules.items
    .filter(item => {
      if (!isMap(item)) return false
      const id = item.get('id')
      return typeof id === 'string' && managedPolicyRulePrefixes.some(prefix => id.startsWith(prefix))
    })
    .map(item => stableJsonValue((item as YAMLMap).toJSON()))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

function assertEffectiveManagedPolicyMatchesCandidate(input: {
  candidatePatch: string
  effectiveProfile: string
}): void {
  const fingerprint = (profilePatch: string, effective: boolean): string => {
    const document = parseDocument(profilePatch, { uniqueKeys: true })
    if (document.errors.length > 0 || !isSeq(document.contents)) {
      throw new Error('profile is not a valid YAML sequence')
    }
    const rows = document.contents.items.filter(item => isMap(item)
      && (item.get('id') as unknown) === 'dsh-enhanced-personal-assistant') as YAMLMap[]
    const personal = rows[0]
    if (rows.length !== 1 || personal === undefined) {
      throw new Error('profile does not have the expected enabled personal-assistant package')
    }
    if (!setupRowIsEnabled(personal)
      || (effective && personal.get('name') !== '@dsh-enhanced/personal-assistant')) {
      throw new Error('profile does not have the expected enabled personal-assistant package')
    }
    const config = personal.get('config', true) as Node | undefined
    const policy = isMap(config) ? config.get('assistantPolicy', true) as Node | undefined : undefined
    const rules = isMap(policy) ? policy.get('rules', true) as Node | undefined : undefined
    if (rules === undefined) throw new Error('profile does not have assistant policy rules')
    return managedPolicyFingerprint(rules)
  }
  if (fingerprint(input.candidatePatch, false) !== fingerprint(input.effectiveProfile, true)) {
    throw new Error('lark-channel setup: effective Agent policy does not match the validated candidate')
  }
}

function uniqueProfileRow(rows: YAMLSeq, id: string, label: string): YAMLMap | undefined {
  const matches = rows.items.filter(item => isMap(item) && (item.get('id') as unknown) === id) as YAMLMap[]
  if (matches.length > 1) throw new Error(`lark-channel setup: ${label} has duplicate ${id} rows`)
  return matches[0]
}

function requireEffectivePackageRow(
  rows: YAMLSeq,
  id: string,
  packageName: string,
  optional = false,
): YAMLMap | undefined {
  const row = uniqueProfileRow(rows, id, 'effective profile')
  if (row === undefined) {
    if (optional) return undefined
    throw new Error(`lark-channel setup: effective profile has no ${id} row`)
  }
  if (row.get('name') !== packageName) {
    throw new Error(`lark-channel setup: effective ${id} row does not mount ${packageName}`)
  }
  if (!setupRowIsEnabled(row)) {
    if (optional) return undefined
    throw new Error(`lark-channel setup: effective ${id} row is disabled`)
  }
  return row
}

function policyRulesOf(row: YAMLMap, label: string): YAMLSeq {
  const config = row.get('config', true) as Node | undefined
  const policy = isMap(config) ? config.get('assistantPolicy', true) as Node | undefined : undefined
  const rules = isMap(policy) ? policy.get('rules', true) as Node | undefined : undefined
  if (!isSeq(rules)) throw new Error(`lark-channel setup: ${label} has no assistant policy rules`)
  return rules
}

function replaceProfileRow(rows: YAMLSeq, id: string, replacement?: YAMLMap): void {
  for (let index = rows.items.length - 1; index >= 0; index -= 1) {
    const item = rows.items[index]
    if (isMap(item) && (item.get('id') as unknown) === id) rows.items.splice(index, 1)
  }
  if (replacement !== undefined) rows.add(replacement.clone())
}

/**
 * Computes only the policy delta from composed Lark semantics. The temporary
 * working profile receives effective channel/account/owner and Delivery agent
 * identity, while the returned patch retains raw channel and credential rows.
 * A policy refresh therefore cannot pin an inherited channel or delete a
 * credential override which it does not own.
 */
function refreshLarkAgentPolicyFromEffective(input: {
  profilePatch: string
  effectiveProfile: string
  dshHome: string
  agentTools: 'disable' | 'enable'
  account?: string
}): string {
  // Effective rows determine active channel semantics, but may never conceal
  // malformed raw overrides which remain on disk after this policy-only edit.
  assertRawManagedProfileIntegrity(input.profilePatch)
  const working = parseDocument(input.profilePatch, { uniqueKeys: true })
  const effective = parseDocument(input.effectiveProfile, { uniqueKeys: true })
  if (working.errors.length > 0 || !isSeq(working.contents)) {
    throw new Error('lark-channel setup: policy refresh candidate must be a valid YAML sequence')
  }
  if (effective.errors.length > 0 || !isSeq(effective.contents)) {
    throw new Error('lark-channel setup: effective policy refresh profile must be a valid YAML sequence')
  }
  const workingPersonal = uniqueProfileRow(
    working.contents,
    'dsh-enhanced-personal-assistant',
    'policy refresh candidate',
  )
  if (workingPersonal === undefined) {
    throw new Error('lark-channel setup: policy refresh candidate has no personal-assistant row')
  }
  const effectivePersonal = requireEffectivePackageRow(
    effective.contents,
    'dsh-enhanced-personal-assistant',
    '@dsh-enhanced/personal-assistant',
  )!
  const workingPolicy = workingPersonal.get('config', true) as Node | undefined
  const assistantPolicy = isMap(workingPolicy)
    ? workingPolicy.get('assistantPolicy', true) as Node | undefined
    : undefined
  if (!isMap(assistantPolicy)) {
    throw new Error('lark-channel setup: policy refresh candidate has no assistantPolicy config')
  }
  assistantPolicy.set('rules', policyRulesOf(effectivePersonal, 'effective personal-assistant').clone())

  const effectiveDelivery = requireEffectivePackageRow(
    effective.contents,
    'dsh-enhanced-assistant-delivery',
    '@dsh-enhanced/assistant-delivery',
  )!
  replaceProfileRow(working.contents, 'dsh-enhanced-assistant-delivery', effectiveDelivery)
  const effectiveLark = requireEffectivePackageRow(
    effective.contents,
    'dsh-enhanced-lark-channel',
    '@dsh-enhanced/lark-channel',
    true,
  )
  const effectiveLarkConfig = effectiveLark?.get('config', true) as Node | undefined
  const channelEnabled = isMap(effectiveLarkConfig) && effectiveLarkConfig.get('enabled') === true
  replaceProfileRow(
    working.contents,
    'dsh-enhanced-lark-channel',
    channelEnabled ? effectiveLark : undefined,
  )

  const refreshed = refreshLarkAgentPolicyPatch({
    profilePatch: working.toString({ lineWidth: 0 }),
    dshHome: input.dshHome,
    agentTools: input.agentTools,
    ...(input.account === undefined ? {} : { account: input.account }),
  })
  const refreshedDocument = parseDocument(refreshed, { uniqueKeys: true })
  const result = parseDocument(input.profilePatch, { uniqueKeys: true })
  if (!isSeq(refreshedDocument.contents) || !isSeq(result.contents)) {
    throw new Error('lark-channel setup: policy refresh produced an invalid profile sequence')
  }
  const refreshedPersonal = uniqueProfileRow(
    refreshedDocument.contents,
    'dsh-enhanced-personal-assistant',
    'refreshed profile',
  )!
  const resultPersonal = uniqueProfileRow(
    result.contents,
    'dsh-enhanced-personal-assistant',
    'policy refresh result',
  )!
  const resultConfig = resultPersonal.get('config', true) as Node | undefined
  const resultPolicy = isMap(resultConfig) ? resultConfig.get('assistantPolicy', true) as Node | undefined : undefined
  if (!isMap(resultPolicy)) throw new Error('lark-channel setup: policy refresh result has no assistantPolicy config')
  resultPolicy.set('rules', policyRulesOf(refreshedPersonal, 'refreshed personal-assistant').clone())
  return result.toString({ lineWidth: 0 })
}

function inspectLarkOwnerBinding(input: {
  profilePatch: string
  dshHome: string
  profile: string
  principal: ExternalPrincipalKey
  stagedCredential: SetupCredentialLocator
  effective: boolean
}): EffectiveLarkOwnerBinding {
  const document = parseDocument(input.profilePatch, { uniqueKeys: true })
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    throw new Error('profile is not a valid YAML sequence')
  }
  const larkRows = document.contents.items
    .filter(item => isMap(item) && (item.get('id') as unknown) === 'dsh-enhanced-lark-channel') as YAMLMap[]
  if (larkRows.length !== 1 || !setupRowIsEnabled(larkRows[0]!)) {
    throw new Error('profile does not have exactly one enabled Lark channel row')
  }
  if (input.effective && larkRows[0]!.get('name') !== '@dsh-enhanced/lark-channel') {
    throw new Error('effective Lark row does not mount the expected package')
  }
  const channel = larkRows[0]!.get('config', true) as Node | undefined
  if (!isMap(channel) || channel.get('enabled') !== true) {
    throw new Error('profile does not have an enabled Lark channel config')
  }
  const account = channel.get('account')
  const tenant = channel.get('tenant')
  const appId = channel.get('appId')
  const domain = channel.get('domain')
  const credentialHandle = channel.get('credentialHandle')
  const credentialPurpose = channel.get('credentialPurpose')
  const credentialLeaseMs = channel.get('credentialLeaseMs')
  if (account !== input.principal.account
    || tenant !== input.principal.tenant
    || typeof appId !== 'string'
    || (domain !== 'feishu' && domain !== 'lark')
    || credentialHandle !== `lark-app-secret-${input.principal.account}`
    || credentialPurpose !== 'connect'
    || credentialLeaseMs !== 86_400_000) {
    throw new Error('Lark channel config does not match the setup owner')
  }
  const locator = findManagedLarkCredentialLocator({
    profilePatch: input.profilePatch,
    dshHome: input.dshHome,
    profile: input.profile,
  })
  if (locator === undefined || !credentialLocatorEquals(locator, input.stagedCredential)) {
    throw new Error('Lark channel credential does not match the staged setup credential')
  }
  const credentialRows = document.contents.items
    .filter(item => isMap(item) && (item.get('id') as unknown) === 'dsh-enhanced-credentials-keychain') as YAMLMap[]
  if (credentialRows.length !== 1
    || !setupRowIsEnabled(credentialRows[0]!)
    || (input.effective && credentialRows[0]!.get('name') !== '@dsh-enhanced/credentials-keychain')) {
    throw new Error('profile does not have the expected enabled credentials-keychain package')
  }
  const personalRows = document.contents.items
    .filter(item => isMap(item) && (item.get('id') as unknown) === 'dsh-enhanced-personal-assistant') as YAMLMap[]
  if (personalRows.length !== 1 || !setupRowIsEnabled(personalRows[0]!)) {
    throw new Error('profile does not have exactly one enabled personal-assistant row')
  }
  if (input.effective && personalRows[0]!.get('name') !== '@dsh-enhanced/personal-assistant') {
    throw new Error('effective personal-assistant row does not mount the expected package')
  }
  const personal = personalRows[0]!.get('config', true) as Node | undefined
  const policy = isMap(personal) ? personal.get('assistantPolicy', true) as Node | undefined : undefined
  const rules = isMap(policy) ? policy.get('rules', true) as Node | undefined : undefined
  if (!isSeq(rules)) throw new Error('profile does not have assistant policy rules')
  const ownerRuleId = `lark-owner-ingress-${input.principal.account}`
  const ownerRules = rules.items.filter(item => isMap(item) && item.get('id') === ownerRuleId) as YAMLMap[]
  const ownerRule = ownerRules[0]
  const subject = ownerRule?.get('subject', true) as Node | undefined
  const resource = ownerRule?.get('resource', true) as Node | undefined
  const context = ownerRule?.get('context', true) as Node | undefined
  if (ownerRules.length !== 1
    || ownerRule?.get('effect') !== 'allow'
    || !isMap(subject)
    || !exactYamlMapKeys(subject, ['kind', 'id'])
    || subject.get('kind') !== 'external'
    || subject.get('id') !== externalPrincipalKeyId(input.principal)
    || !exactYamlStringSequence(ownerRule.get('actions', true) as Node | undefined, ['approval.decide', 'ingest'])
    || !isMap(resource)
    || !exactYamlMapKeys(resource, ['kind', 'id'])
    || resource.get('kind') !== 'message'
    || resource.get('id') !== '*'
    || !isMap(context)
    || !exactYamlMapKeys(context, ['initiators'])
    || !exactYamlStringSequence(context.get('initiators', true) as Node | undefined, ['external'])) {
    throw new Error('assistant policy does not contain the exact setup owner ingress')
  }
  return {
    account,
    tenant,
    appId,
    domain,
    credentialHandle,
    credentialPurpose,
    credentialLeaseMs,
    managedPolicyRules: managedPolicyFingerprint(rules),
  }
}

function assertEffectiveLarkOwnerBinding(input: {
  effectiveProfile: string
  candidatePatch: string
  dshHome: string
  profile: string
  principal: ExternalPrincipalKey
  stagedCredential: SetupCredentialLocator
  context: 'journal' | 'validation'
}): void {
  let candidate: EffectiveLarkOwnerBinding
  try {
    candidate = inspectLarkOwnerBinding({
      profilePatch: input.candidatePatch,
      dshHome: input.dshHome,
      profile: input.profile,
      principal: input.principal,
      stagedCredential: input.stagedCredential,
      effective: false,
    })
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(`lark-channel setup: candidate profile does not represent the setup owner${detail}`, { cause: error })
  }
  let effective: EffectiveLarkOwnerBinding
  try {
    effective = inspectLarkOwnerBinding({
      profilePatch: input.effectiveProfile,
      dshHome: input.dshHome,
      profile: input.profile,
      principal: input.principal,
      stagedCredential: input.stagedCredential,
      effective: true,
    })
  } catch (error) {
    const suffix = input.context === 'journal' ? 'journal owner' : 'validated setup owner'
    throw new Error(`lark-channel setup: effective Lark binding no longer represents the ${suffix}`, { cause: error })
  }
  if (JSON.stringify(effective) !== JSON.stringify(candidate)) {
    const suffix = input.context === 'journal' ? 'journal owner' : 'validated setup owner'
    throw new Error(`lark-channel setup: effective Lark binding no longer represents the ${suffix}`)
  }
}

async function assertNoOtherLarkProfileSharesDelivery(input: {
  dshHome: string
  profile: string
  databasePath: string
  readEffectiveProfile: (profile: string) => string | Promise<string>
}): Promise<void> {
  let entries
  try {
    entries = await readdir(platformJoin(input.dshHome, 'profiles'), { withFileTypes: true })
  } catch (error) {
    if (fileSystemErrorCode(error) === 'ENOENT') return
    throw error
  }
  const databasePath = normalizeSetupResourcePath(input.databasePath)
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === input.profile
      || (!entry.isDirectory() && !entry.isSymbolicLink())
      || !setupKeyPattern.test(entry.name)) continue
    const patchPath = platformJoin(input.dshHome, 'profiles', entry.name, 'cordis.patch.yml')
    // A profile can inherit Lark entirely from a lower bundle while its raw
    // override contains no channel row. Activation and database identity must
    // therefore come from effective config whenever that profile composes.
    try {
      await readFile(patchPath, 'utf8')
    } catch (error) {
      if (fileSystemErrorCode(error) === 'ENOENT') continue
      throw error
    }
    let effective
    try {
      effective = await input.readEffectiveProfile(entry.name)
    } catch (error) {
      // Raw absence cannot prove absence: Lark may be inherited from a lower
      // bundle and a resident using the last valid composition may still run.
      // Without a durable ownership registry, an unverifiable real profile is
      // therefore a fail-closed handoff boundary.
      throw new Error(`lark-channel setup: cannot verify effective Lark ownership in profile ${entry.name}`, {
        cause: error,
      })
    }
    if (!effectiveProfileHasEnabledLarkChannel(effective, entry.name)) continue
    const otherDatabasePath = deliveryDatabasePathFromEffectiveProfile(effective, input.dshHome)
    if (normalizeSetupResourcePath(otherDatabasePath) === databasePath) {
      throw new Error(
        `lark-channel setup: profile ${entry.name} already owns Lark for the same assistant-delivery database; `
        + 'refusing to revoke its owner from another profile',
      )
    }
  }
}

async function withDeliveryOwnerSetupLock<T>(
  databasePath: string,
  operation: () => Promise<T>,
  options: ProfileSetupLockOptions = {},
): Promise<T> {
  const resourcePath = normalizeSetupResourcePath(databasePath)
  await mkdir(dirname(resourcePath), { recursive: true, mode: 0o700 })
  return withProfileSetupLock(`${resourcePath}.lark-owner`, operation, options)
}

async function removeInactiveCredentialForRecovery(input: {
  recovery: RecoverLarkSetupJournalInput
  locator: SetupCredentialLocator
  profilePatch: string
  remove: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>
}): Promise<void> {
  try {
    await removeCredentialIdempotently(input.locator, input.remove)
  } catch (error) {
    if (!input.recovery.allowDeferredSecretServiceCleanup
      || !canDeferSecretServiceCleanup(input.locator, error)) throw error
    await deferInactiveCredentialCleanup({
      patchPath: input.recovery.patchPath,
      dshHome: input.recovery.dshHome,
      profile: input.recovery.profile,
      profilePatch: input.profilePatch,
      locator: input.locator,
    })
  }
}

async function recoverLarkSetupJournalRecordUnlocked(
  input: RecoverLarkSetupJournalInput,
  journal: StoredLarkSetupJournal,
): Promise<boolean> {
  const remove = input.operations?.removeCredential ?? removeCredential
  const pair = input.operations?.pairPrincipal ?? defaultPairPrincipal
  const install = input.operations?.installService
    ?? (async () => { await installDshResidentService({ dshHome: input.dshHome, profile: input.profile }) })
  const current = await readFile(input.patchPath, 'utf8')
  if (journal.phase === 'staging') {
    if (current !== journal.originalPatch) {
      throw new Error('lark-channel setup: staging journal conflicts with the live profile')
    }
    await removeInactiveCredentialForRecovery({
      recovery: input,
      locator: journal.stagedCredential!,
      profilePatch: current,
      remove,
    })
    await clearLarkSetupJournal(input.patchPath)
    return true
  }
  if (journal.phase === 'candidate' || journal.phase === 'aborting') {
    if (current === journal.updatedPatch) await atomicWrite(input.patchPath, journal.originalPatch)
    else if (current !== journal.originalPatch) {
      throw new Error('lark-channel setup: candidate recovery refused because the live profile diverged')
    }
    if (journal.stagedCredential !== undefined) {
      await removeInactiveCredentialForRecovery({
        recovery: input,
        locator: journal.stagedCredential,
        profilePatch: journal.originalPatch,
        remove,
      })
    }
    await clearLarkSetupJournal(input.patchPath)
    return true
  }
  if (journal.updatedPatch === undefined) {
    throw new Error('lark-channel setup: validated journal has no candidate profile')
  }
  if (current === journal.originalPatch) await atomicWrite(input.patchPath, journal.updatedPatch)
  else if (current !== journal.updatedPatch) {
    throw new Error('lark-channel setup: validated recovery refused because the live profile diverged')
  }
  if (journal.operation === 'full') {
    await pair({ databasePath: journal.databasePath!, principal: journal.principal! })
    if (journal.phase !== 'paired') await persistLarkSetupJournal(journalPersistInput(journal, 'paired'))
    if (journal.previousCredential !== undefined
      && !credentialLocatorEquals(journal.previousCredential, journal.stagedCredential!)) {
      try {
        await retirePreviousCredential(journal.previousCredential, remove)
      } catch (error) {
        const migratingToProtectedFile = journal.stagedCredential?.provider === 'linux-protected-file'
        if ((!input.allowDeferredSecretServiceCleanup && !migratingToProtectedFile)
          || !canDeferSecretServiceCleanup(journal.previousCredential, error)) throw error
        await deferInactiveCredentialCleanup({
          patchPath: input.patchPath,
          dshHome: input.dshHome,
          profile: input.profile,
          profilePatch: journal.updatedPatch!,
          locator: journal.previousCredential,
        })
      }
    }
    if (journal.installService) await install()
  }
  await clearLarkSetupJournal(input.patchPath)
  return true
}

async function recoverValidatedRefreshJournalUnlocked(
  input: RecoverLarkSetupJournalInput,
  journal: StoredLarkSetupJournal,
): Promise<boolean> {
  const updatedPatch = journal.updatedPatch!
  const current = await readFile(input.patchPath, 'utf8')
  if (current === journal.originalPatch) await atomicWrite(input.patchPath, updatedPatch)
  else if (current !== updatedPatch) {
    throw new Error('lark-channel setup: validated refresh recovery refused because the live profile diverged')
  }
  try {
    assertRawManagedProfileIntegrity(updatedPatch)
    const readEffectiveProfile = input.operations?.readEffectiveProfile ?? dumpProfile
    assertEffectiveManagedPolicyMatchesCandidate({
      candidatePatch: updatedPatch,
      effectiveProfile: await readEffectiveProfile(input.profile),
    })
  } catch (error) {
    try {
      await persistLarkSetupJournal(journalPersistInput(journal, 'aborting'))
    } catch (journalError) {
      throw new AggregateError(
        [error, journalError],
        'lark-channel setup: refresh recovery failed before rollback intent could be persisted',
      )
    }
    if (await rollbackCandidatePatch({
      patchPath: input.patchPath,
      originalPatch: journal.originalPatch,
      updatedPatch,
    }) === 'conflict') {
      throw new Error('lark-channel setup: refresh recovery rollback refused because the profile changed concurrently', {
        cause: error,
      })
    }
    await clearLarkSetupJournal(input.patchPath)
    throw error
  }
  await clearLarkSetupJournal(input.patchPath)
  return true
}

async function recoverLarkSetupJournalUnlocked(input: RecoverLarkSetupJournalInput): Promise<boolean> {
  await retryDeferredLarkCredentialCleanup({
    patchPath: input.patchPath,
    dshHome: input.dshHome,
    profile: input.profile,
    ...(input.operations?.removeCredential === undefined
      ? {}
      : { removeCredential: input.operations.removeCredential }),
  })
  const journal = await readLarkSetupJournal(input)
  if (journal === undefined) return false
  if (journal.operation === 'refresh' && journal.phase === 'validated') {
    return recoverValidatedRefreshJournalUnlocked(input, journal)
  }
  if (journal.operation !== 'full'
    || journal.phase === 'staging'
    || journal.phase === 'candidate'
    || journal.phase === 'aborting') {
    return recoverLarkSetupJournalRecordUnlocked(input, journal)
  }
  const databasePath = journal.databasePath!
  const readEffectiveProfile = input.operations?.readEffectiveProfile ?? dumpProfile
  return withDeliveryOwnerSetupLock(databasePath, async () => {
    const effectiveProfile = await readEffectiveProfile(input.profile)
    const effectiveDatabasePath = deliveryDatabasePathFromEffectiveProfile(effectiveProfile, input.dshHome)
    if (normalizeSetupResourcePath(effectiveDatabasePath) !== normalizeSetupResourcePath(databasePath)) {
      throw new Error('lark-channel setup: effective assistant-delivery database changed since the setup journal')
    }
    assertEffectiveManagedPolicyMatchesCandidate({
      candidatePatch: journal.updatedPatch!,
      effectiveProfile,
    })
    assertEffectiveLarkOwnerBinding({
      effectiveProfile,
      candidatePatch: journal.updatedPatch!,
      dshHome: input.dshHome,
      profile: input.profile,
      principal: journal.principal!,
      stagedCredential: journal.stagedCredential!,
      context: 'journal',
    })
    await assertNoOtherLarkProfileSharesDelivery({
      dshHome: input.dshHome,
      profile: input.profile,
      databasePath,
      readEffectiveProfile,
    })
    return recoverLarkSetupJournalRecordUnlocked(input, journal)
  }, input.profileLockOptions)
}

/** Recovers one abandoned setup transaction under the same profile lock. */
export async function recoverLarkSetupJournal(input: RecoverLarkSetupJournalInput): Promise<void> {
  await withProfileSetupLock(input.patchPath, async () => {
    await recoverLarkSetupJournalUnlocked(input)
  }, input.profileLockOptions)
}

function dumpProfile(profile: string): string {
  const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim().slice(0, 2_000) : ''
    throw new Error(`lark-channel setup: DSH rejected the updated profile${detail === '' ? '' : `: ${detail}`}`)
  }
  return typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '')
}

function validateProfile(profile: string): void {
  void dumpProfile(profile)
}

export interface ValidatedLarkOwnerSetupInput {
  patchPath: string
  originalPatch: string
  updatedPatch: string
  profile: string
  databasePath: string
  principal: ExternalPrincipalKey
  credentialTransition?: {
    staged: SetupCredentialLocator
    previous?: SetupCredentialLocator
  }
  operations?: ValidatedLarkOwnerSetupOperations
}

export interface ValidatedLarkOwnerSetupOperations {
  validateProfile?: (profile: string) => void | Promise<void>
  pairPrincipal?: (input: {
    databasePath: string
    principal: ExternalPrincipalKey
  }) => void | Promise<void>
  removeCredential?: (locator: SetupCredentialLocator) => void | Promise<void>
}

async function defaultPairPrincipal(input: {
  databasePath: string
  principal: ExternalPrincipalKey
}): Promise<void> {
  // Load the local-only control plane only after the candidate profile has
  // passed composition/schema validation. A rejected profile therefore has
  // no opportunity to mutate pairing state.
  const { pairPrincipalLocally } = await import('@dsh-enhanced/assistant-delivery')
  pairPrincipalLocally(input)
}

async function cleanupFailedCandidateCredential(
  transition: ValidatedLarkOwnerSetupInput['credentialTransition'],
  operation: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>,
  setupError: unknown,
): Promise<never> {
  if (transition === undefined) throw setupError
  try {
    await operation(transition.staged)
  } catch (cleanupError) {
    throw new AggregateError(
      [setupError, cleanupError],
      'lark-channel setup: setup failed and staged credential cleanup also failed',
    )
  }
  throw setupError
}

interface CandidatePatchTransition {
  patchPath: string
  originalPatch: string
  updatedPatch: string
}

async function rollbackCandidatePatch(input: CandidatePatchTransition): Promise<'restored' | 'conflict'> {
  const current = await readFile(input.patchPath, 'utf8')
  if (current === input.originalPatch) return 'restored'
  if (current !== input.updatedPatch) return 'conflict'
  await atomicWrite(input.patchPath, input.originalPatch)
  return 'restored'
}

/**
 * Makes profile validation a precondition of Delivery owner rotation. The
 * candidate patch is restored on either validation or handoff failure, while
 * the store performs the old-owner retirement and replacement promotion in one
 * database transaction.
 */
export async function commitValidatedLarkOwnerSetup(input: ValidatedLarkOwnerSetupInput): Promise<void> {
  const validate = input.operations?.validateProfile ?? validateProfile
  const pair = input.operations?.pairPrincipal ?? defaultPairPrincipal
  const remove = input.operations?.removeCredential ?? removeCredential
  const before = await readFile(input.patchPath, 'utf8')
  if (before !== input.originalPatch) {
    await cleanupFailedCandidateCredential(
      input.credentialTransition,
      remove,
      new Error('lark-channel setup: profile changed concurrently before candidate commit'),
    )
  }
  try {
    await atomicWrite(input.patchPath, input.updatedPatch)
  } catch (error) {
    await cleanupFailedCandidateCredential(input.credentialTransition, remove, error)
  }
  try {
    await validate(input.profile)
  } catch (error) {
    if (await rollbackCandidatePatch(input) === 'conflict') {
      throw new Error('lark-channel setup: rollback refused because the profile changed concurrently', { cause: error })
    }
    await cleanupFailedCandidateCredential(input.credentialTransition, remove, error)
  }
  if (await readFile(input.patchPath, 'utf8') !== input.updatedPatch) {
    throw new Error('lark-channel setup: candidate profile changed concurrently before owner handoff')
  }
  try {
    await pair({ databasePath: input.databasePath, principal: input.principal })
  } catch (error) {
    if (await rollbackCandidatePatch(input) === 'conflict') {
      throw new Error('lark-channel setup: rollback refused because the profile changed concurrently', { cause: error })
    }
    await cleanupFailedCandidateCredential(input.credentialTransition, remove, error)
  }
  const previous = input.credentialTransition?.previous
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(input.credentialTransition?.staged)) {
    await retirePreviousCredentialBestEffort(previous, remove)
  }
}

export interface LarkSetupProfileTransactionOperations {
  storeCredential: (locator: SetupCredentialLocator) => void | Promise<void>
  readCredential: (locator: SetupCredentialLocator) => string | Promise<string>
  discoverOwner: (input: {
    appId: string
    appSecret: string
    domain: 'feishu' | 'lark'
    account: string
    tenant: string
    timeoutMs: number
  }) => ExternalPrincipalKey | Promise<ExternalPrincipalKey>
  validateProfile?: ValidatedLarkOwnerSetupOperations['validateProfile']
  readEffectiveProfile?: (profile: string) => string | Promise<string>
  pairPrincipal?: ValidatedLarkOwnerSetupOperations['pairPrincipal']
  removeCredential?: ValidatedLarkOwnerSetupOperations['removeCredential']
  afterCommit?: () => void | Promise<void>
}

export interface LarkSetupProfileTransactionInput {
  args: LarkSetupArgs
  dshHome: string
  patchPath: string
  application: {
    appId: string
    domain: 'feishu' | 'lark'
  }
  credentialProvider: SetupCredentialProvider
  profileLockOptions?: ProfileSetupLockOptions
  operations: LarkSetupProfileTransactionOperations
}

async function abortStagingJournal(input: {
  patchPath: string
  originalPatch: string
  stagedCredential: SetupCredentialLocator
  remove: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>
  setupError: unknown
}): Promise<never> {
  const current = await readFile(input.patchPath, 'utf8')
  if (current !== input.originalPatch) {
    throw new Error('lark-channel setup: staging abort refused because the live profile diverged', {
      cause: input.setupError,
    })
  }
  if (input.stagedCredential.provider === 'linux-protected-file'
    && fileSystemErrorCode(input.setupError) === 'EEXIST') {
    // O_EXCL proves this setup never created the colliding path. Removing it
    // here would delete somebody else's file merely because our random locator
    // collided (or was deliberately pre-created). Clear only our journal; the
    // next invocation will generate a new versioned locator.
    try {
      await clearLarkSetupJournal(input.patchPath)
    } catch (journalError) {
      throw new AggregateError(
        [input.setupError, journalError],
        'lark-channel setup: protected credential path collided and setup journal cleanup also failed',
      )
    }
    throw new Error('lark-channel setup: protected credential path collision; rerun setup', {
      cause: input.setupError,
    })
  }
  try {
    await removeCredentialIdempotently(input.stagedCredential, input.remove)
    await clearLarkSetupJournal(input.patchPath)
  } catch (cleanupError) {
    throw new AggregateError(
      [input.setupError, cleanupError],
      'lark-channel setup: setup failed and staged credential cleanup also failed',
    )
  }
  throw input.setupError
}

async function abortCandidateJournal(input: {
  patchPath: string
  originalPatch: string
  updatedPatch: string
  stagedCredential: SetupCredentialLocator
  remove: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>
  setupError: unknown
}): Promise<never> {
  if (await rollbackCandidatePatch(input) === 'conflict') {
    throw new Error('lark-channel setup: rollback refused because the profile changed concurrently', {
      cause: input.setupError,
    })
  }
  try {
    await removeCredentialIdempotently(input.stagedCredential, input.remove)
    await clearLarkSetupJournal(input.patchPath)
  } catch (cleanupError) {
    throw new AggregateError(
      [input.setupError, cleanupError],
      'lark-channel setup: setup rollback completed but staged credential cleanup failed',
    )
  }
  throw input.setupError
}

/**
 * Executes the mutation-bearing portion of onboarding while holding the
 * profile lock. Credential staging, owner discovery, candidate composition,
 * validation, and the Delivery owner handoff therefore observe one serialized
 * profile generation.
 */
export async function executeLarkSetupProfileTransaction(
  input: LarkSetupProfileTransactionInput,
): Promise<void> {
  const remove = input.operations.removeCredential ?? removeCredential
  const pair = input.operations.pairPrincipal ?? defaultPairPrincipal
  const validate = input.operations.validateProfile ?? validateProfile
  const readEffectiveProfile = input.operations.readEffectiveProfile ?? dumpProfile
  await withProfileSetupLock(input.patchPath, async () => {
    await recoverLarkSetupJournalUnlocked({
      patchPath: input.patchPath,
      dshHome: input.dshHome,
      profile: input.args.profile,
      operations: {
        pairPrincipal: pair,
        removeCredential: remove,
        readEffectiveProfile,
        ...(input.operations.afterCommit === undefined ? {} : { installService: input.operations.afterCommit }),
      },
      allowDeferredSecretServiceCleanup: input.credentialProvider === 'linux-protected-file',
    })
    const originalPatch = await readFile(input.patchPath, 'utf8')
    const effectiveProfile = await readEffectiveProfile(input.args.profile)
    const databasePath = deliveryDatabasePathFromEffectiveProfile(
      effectiveProfile,
      input.dshHome,
    )
    const materializedPatch = materializeManagedProfileOverride({
      profilePatch: originalPatch,
      effectiveProfile,
    })
    await withDeliveryOwnerSetupLock(databasePath, async () => {
      await assertNoOtherLarkProfileSharesDelivery({
        dshHome: input.dshHome,
        profile: input.args.profile,
        databasePath,
        readEffectiveProfile,
      })
    const previousCredential = findManagedLarkCredentialLocator({
      profilePatch: originalPatch,
      dshHome: input.dshHome,
      profile: input.args.profile,
    })
    const stagedCredential = createVersionedCredentialLocator({
      provider: input.credentialProvider,
      dshHome: input.dshHome,
      profile: input.args.profile,
      account: input.args.account,
    })
    if (stagedCredential.provider === 'windows-dpapi'
      || stagedCredential.provider === 'linux-protected-file') {
      await mkdir(dirname(stagedCredential.path), { recursive: true, mode: 0o700 })
    }
    const transactionId = randomBytes(16).toString('hex')
    const stagingJournal: PersistLarkSetupJournalInput = {
      patchPath: input.patchPath,
      dshHome: input.dshHome,
      profile: input.args.profile,
      operation: 'full',
      phase: 'staging',
      originalPatch,
      databasePath,
      account: input.args.account,
      stagedCredential,
      ...(previousCredential === undefined ? {} : { previousCredential }),
      installService: input.operations.afterCommit !== undefined,
      transactionId,
    }
    await persistLarkSetupJournal(stagingJournal)
    const { updatedPatch, owner } = await (async (): Promise<{
      updatedPatch: string
      owner: ExternalPrincipalKey
    }> => {
      try {
        await input.operations.storeCredential(stagedCredential)
        const appSecret = await input.operations.readCredential(stagedCredential)
        if (appSecret.length === 0) throw new Error('lark-channel setup: credential store returned an empty secret')
        const owner = await input.operations.discoverOwner({
          appId: input.application.appId,
          appSecret,
          domain: input.application.domain,
          account: input.args.account,
          tenant: input.args.tenant,
          timeoutMs: input.args.timeoutMs,
        })
        if (owner.channel !== 'lark'
          || owner.account !== input.args.account
          || owner.tenant !== input.args.tenant) {
          throw new Error('lark-channel setup: discovered owner does not match the setup account and tenant')
        }
        const keychainService = stagedCredential.provider === 'windows-dpapi'
          ? `dsh/lark/${input.args.profile}/${input.args.account}/versions/windows-dpapi`
          : stagedCredential.provider === 'linux-protected-file'
            ? `dsh/lark/${input.args.profile}/${input.args.account}/versions/linux-protected-file`
            : stagedCredential.service
        return {
          owner,
          updatedPatch: configureLarkProfilePatch({
            profilePatch: materializedPatch,
            dshHome: input.dshHome,
            appId: input.application.appId,
            account: input.args.account,
            tenant: input.args.tenant,
            domain: input.application.domain,
            ownerUserId: owner.user,
            keychainService,
            keychainAccount: input.args.account,
            credentialProvider: input.credentialProvider,
            agentTools: input.args.agentTools,
            ...(stagedCredential.provider === 'windows-dpapi'
                || stagedCredential.provider === 'linux-protected-file'
              ? { credentialPath: stagedCredential.path }
              : {}),
          }),
        }
      } catch (error) {
        return abortStagingJournal({
          patchPath: input.patchPath,
          originalPatch,
          stagedCredential,
          remove,
          setupError: error,
        })
      }
    })()
    const candidateJournal: PersistLarkSetupJournalInput = {
      ...stagingJournal,
      phase: 'candidate',
      updatedPatch,
      principal: owner,
    }
    try {
      await persistLarkSetupJournal(candidateJournal)
    } catch (error) {
      await abortStagingJournal({
        patchPath: input.patchPath,
        originalPatch,
        stagedCredential,
        remove,
        setupError: error,
      })
    }
    try {
      await atomicWrite(input.patchPath, updatedPatch)
      await validate(input.args.profile)
      const validatedEffectiveProfile = await readEffectiveProfile(input.args.profile)
      const validatedDatabasePath = deliveryDatabasePathFromEffectiveProfile(validatedEffectiveProfile, input.dshHome)
      if (normalizeSetupResourcePath(validatedDatabasePath) !== normalizeSetupResourcePath(databasePath)) {
        throw new Error('lark-channel setup: effective assistant-delivery database changed during validation')
      }
      assertEffectiveManagedPolicyMatchesCandidate({
        candidatePatch: updatedPatch,
        effectiveProfile: validatedEffectiveProfile,
      })
      assertEffectiveLarkOwnerBinding({
        effectiveProfile: validatedEffectiveProfile,
        candidatePatch: updatedPatch,
        dshHome: input.dshHome,
        profile: input.args.profile,
        principal: owner,
        stagedCredential,
        context: 'validation',
      })
    } catch (error) {
      await abortCandidateJournal({
        patchPath: input.patchPath,
        originalPatch,
        updatedPatch,
        stagedCredential,
        remove,
        setupError: error,
      })
    }
    if (await readFile(input.patchPath, 'utf8') !== updatedPatch) {
      await abortCandidateJournal({
        patchPath: input.patchPath,
        originalPatch,
        updatedPatch,
        stagedCredential,
        remove,
        setupError: new Error('lark-channel setup: candidate profile changed after validation'),
      })
    }
    // Do not roll back if this phase write reports an error: rename may already
    // have made the validated record durable. Recovery reads the actual record
    // and deterministically chooses forward commit or rollback.
    await persistLarkSetupJournal({ ...candidateJournal, phase: 'validated' })
    try {
      await pair({ databasePath, principal: owner })
    } catch (error) {
      // The rollback direction must be durable before profile or credential
      // rollback starts. A crash after deleting the staged secret can therefore
      // never replay the old validated record and activate a missing secret.
      try {
        await persistLarkSetupJournal({ ...candidateJournal, phase: 'aborting' })
      } catch (journalError) {
        throw new AggregateError(
          [error, journalError],
          'lark-channel setup: owner handoff failed before rollback intent could be persisted',
        )
      }
      await abortCandidateJournal({
        patchPath: input.patchPath,
        originalPatch,
        updatedPatch,
        stagedCredential,
        remove,
        setupError: error,
      })
    }
    // Once owner handoff returns, rollback is no longer safe. If this durable
    // phase write fails, leave the validated journal so the next entry repeats
    // the idempotent exact-owner handoff and converges forward.
    await persistLarkSetupJournal({ ...candidateJournal, phase: 'paired' })
    if (previousCredential !== undefined && !credentialLocatorEquals(previousCredential, stagedCredential)) {
      try {
        await retirePreviousCredential(previousCredential, remove)
      } catch (error) {
        if (input.credentialProvider !== 'linux-protected-file'
          || !canDeferSecretServiceCleanup(previousCredential, error)) throw error
        await deferInactiveCredentialCleanup({
          patchPath: input.patchPath,
          dshHome: input.dshHome,
          profile: input.args.profile,
          profilePatch: updatedPatch,
          locator: previousCredential,
        })
      }
    }
    await input.operations.afterCommit?.()
    await clearLarkSetupJournal(input.patchPath)
    }, input.profileLockOptions)
  }, input.profileLockOptions)
}

export interface LarkSetupRuntime {
  profileLockOptions?: ProfileSetupLockOptions
  validateProfile?: NonNullable<ValidatedLarkOwnerSetupOperations['validateProfile']>
  readEffectiveProfile?: (profile: string) => string | Promise<string>
  installResidentService?: typeof installDshResidentService
  prepareResidentService?: typeof prepareDshSystemdUserService
  journalOperations?: RecoverLarkSetupJournalOperations
  preflightCredentialProvider?: (
    provider: SetupCredentialProvider,
  ) => SetupCredentialProvider | void | Promise<SetupCredentialProvider | void>
}

export async function runLarkSetup(
  argv: readonly string[] = process.argv.slice(2),
  runtime: LarkSetupRuntime = {},
): Promise<void> {
  const args = parseLarkSetupArgs(argv)
  if (args.help) {
    process.stdout.write(`${help()}\n`)
    return
  }
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  if (!isAbsolute(dshHome)) throw new Error('lark-channel setup: DSH_HOME must be absolute')
  const patchPath = join(dshHome, 'profiles', args.profile, 'cordis.patch.yml')
  const validate = runtime.validateProfile ?? validateProfile
  const readEffectiveProfile = runtime.readEffectiveProfile ?? dumpProfile
  const installResidentService = runtime.installResidentService ?? installDshResidentService
  const prepareResidentService = runtime.prepareResidentService ?? prepareDshSystemdUserService
  const recoveryOperations: RecoverLarkSetupJournalOperations = {
    ...runtime.journalOperations,
    readEffectiveProfile: runtime.journalOperations?.readEffectiveProfile ?? readEffectiveProfile,
    installService: runtime.journalOperations?.installService
      ?? (async () => { await installResidentService({ dshHome, profile: args.profile }) }),
  }
  if (args.refreshAgentPolicy) {
    await withProfileSetupLock(patchPath, async () => {
      await recoverLarkSetupJournalUnlocked({
        patchPath,
        dshHome,
        profile: args.profile,
        operations: recoveryOperations,
      })
      const effectiveProfile = await readEffectiveProfile(args.profile)
      const databasePath = deliveryDatabasePathFromEffectiveProfile(effectiveProfile, dshHome)
      await withDeliveryOwnerSetupLock(databasePath, async () => {
        await assertNoOtherLarkProfileSharesDelivery({
          dshHome,
          profile: args.profile,
          databasePath,
          readEffectiveProfile,
      })
      const originalPatch = await readFile(patchPath, 'utf8')
      const materializedPatch = materializeManagedProfileOverride({
        profilePatch: originalPatch,
        effectiveProfile,
      })
      const refreshInput = {
        profilePatch: materializedPatch,
        effectiveProfile,
        dshHome,
        agentTools: args.agentTools === 'enable' ? 'enable' : 'disable',
        ...(args.accountProvided ? { account: args.account } : {}),
      } as const
      const updatedPatch = refreshLarkAgentPolicyFromEffective(refreshInput)
      const journal: PersistLarkSetupJournalInput = {
        patchPath,
        dshHome,
        profile: args.profile,
        operation: 'refresh',
        phase: 'candidate',
        originalPatch,
        updatedPatch,
        installService: false,
        transactionId: randomBytes(16).toString('hex'),
      }
      await persistLarkSetupJournal(journal)
      try {
        await atomicWrite(patchPath, updatedPatch)
        await validate(args.profile)
        const validatedEffectiveProfile = await readEffectiveProfile(args.profile)
        const validatedDatabasePath = deliveryDatabasePathFromEffectiveProfile(validatedEffectiveProfile, dshHome)
        if (normalizeSetupResourcePath(validatedDatabasePath) !== normalizeSetupResourcePath(databasePath)) {
          throw new Error('lark-channel setup: effective assistant-delivery database changed during refresh validation')
        }
        const validatedSemanticPatch = refreshLarkAgentPolicyFromEffective({
          ...refreshInput,
          effectiveProfile: validatedEffectiveProfile,
        })
        assertEffectiveManagedPolicyMatchesCandidate({
          candidatePatch: validatedSemanticPatch,
          effectiveProfile: validatedEffectiveProfile,
        })
        assertEffectiveManagedPolicyMatchesCandidate({
          candidatePatch: updatedPatch,
          effectiveProfile: validatedEffectiveProfile,
        })
        if (await readFile(patchPath, 'utf8') !== updatedPatch) {
          throw new Error('lark-channel setup: refreshed profile changed during validation')
        }
      } catch (error) {
        if (await rollbackCandidatePatch({ patchPath, originalPatch, updatedPatch }) === 'conflict') {
          throw new Error('lark-channel setup: rollback refused because the profile changed concurrently', { cause: error })
        }
        await clearLarkSetupJournal(patchPath)
        throw error
      }
      // If this durable phase transition or journal removal reports an error,
      // leave recovery to inspect the on-disk phase. Rolling back here could
      // contradict a validated record already renamed into place.
      await persistLarkSetupJournal({ ...journal, phase: 'validated' })
      await clearLarkSetupJournal(patchPath)
      }, runtime.profileLockOptions)
    }, runtime.profileLockOptions)
    process.stdout.write(`DSH profile ${args.profile} 的 Agent capability policy 已刷新；飞书应用、凭据和 owner 绑定未改动。\n`)
    return
  }
  if (args.installServiceOnly) {
    if (process.platform === 'linux') {
      const prepared = await prepareResidentService({ dshHome, profile: args.profile })
      if (prepared?.enabledLinger) process.stdout.write('已为当前 Linux 用户启用 linger，注销 SSH 后服务仍会保持。\n')
    }
    const service = await withProfileSetupLock(patchPath, async () => {
      await recoverLarkSetupJournalUnlocked({
        patchPath,
        dshHome,
        profile: args.profile,
        operations: recoveryOperations,
      })
      const databasePath = deliveryDatabasePathFromEffectiveProfile(await readEffectiveProfile(args.profile), dshHome)
      return withDeliveryOwnerSetupLock(databasePath, async () => {
        await assertNoOtherLarkProfileSharesDelivery({
          dshHome,
          profile: args.profile,
          databasePath,
          readEffectiveProfile,
        })
        const profileSnapshot = await readFile(patchPath, 'utf8')
        await validate(args.profile)
        const validatedDatabasePath = deliveryDatabasePathFromEffectiveProfile(
          await readEffectiveProfile(args.profile),
          dshHome,
        )
        if (normalizeSetupResourcePath(validatedDatabasePath) !== normalizeSetupResourcePath(databasePath)) {
          throw new Error('lark-channel setup: effective assistant-delivery database changed during service validation')
        }
        if (await readFile(patchPath, 'utf8') !== profileSnapshot) {
          throw new Error('lark-channel setup: profile changed during resident service validation')
        }
        return installResidentService({ dshHome, profile: args.profile })
      }, runtime.profileLockOptions)
    }, runtime.profileLockOptions)
    process.stdout.write(`DSH profile ${args.profile} 已由 ${service.kind} 启动并保持常驻。\n`
      + `状态：${service.statusCommand}\n日志：${service.logCommand}\n`)
    return
  }
  const preferredCredentialProvider = credentialProviderForPlatform(process.platform)
  if (process.platform === 'linux' && args.manageService) {
    const prepared = await prepareResidentService({ dshHome, profile: args.profile })
    if (prepared?.enabledLinger) process.stdout.write('已为当前 Linux 用户启用 linger，注销 SSH 后服务仍会保持。\n')
  }
  let credentialProvider: SetupCredentialProvider
  if (runtime.preflightCredentialProvider === undefined) {
    const selection = await selectLarkCredentialProvider(preferredCredentialProvider, {
      dshHome,
      mode: args.linuxCredentialProvider,
    })
    credentialProvider = selection.provider
    if (selection.fallbackReason !== undefined) {
      process.stdout.write('Linux Secret Service 当前不可用；向导已自动切换到当前用户 0600 私有凭据文件。'
        + '该文件未额外加密，同一 UID 与 root 可读取，但不会进入 profile、命令参数、环境变量或日志。\n')
    }
  } else {
    if (args.linuxCredentialProvider !== 'auto') {
      throw new Error('lark-channel setup: an injected credential preflight cannot be combined with an explicit Linux provider')
    }
    credentialProvider = await runtime.preflightCredentialProvider(preferredCredentialProvider)
      ?? preferredCredentialProvider
  }
  // Resolve a prior crash before prompting the user or mutating a cloud app.
  // The mutation transaction repeats this check after registration to close
  // the gap against a different setup process that completed in the meantime.
  await withProfileSetupLock(patchPath, async () => {
    await recoverLarkSetupJournalUnlocked({
      patchPath,
      dshHome,
      profile: args.profile,
      operations: recoveryOperations,
      allowDeferredSecretServiceCleanup: credentialProvider === 'linux-protected-file',
    })
    const databasePath = deliveryDatabasePathFromEffectiveProfile(await readEffectiveProfile(args.profile), dshHome)
    await withDeliveryOwnerSetupLock(databasePath, async () => {
      await assertNoOtherLarkProfileSharesDelivery({
        dshHome,
        profile: args.profile,
        databasePath,
        readEffectiveProfile,
      })
    }, runtime.profileLockOptions)
  }, runtime.profileLockOptions)
  let appId = args.appId
  let createApp = args.createApp
  if (appId === undefined && !createApp) {
    const prompts = createInterface({ input: process.stdin, output: process.stdout })
    try {
      appId = (await prompts.question('已有飞书 App ID（cli_...；直接回车则打开一键选择/创建）：')).trim()
      createApp = appId.length === 0
    } finally {
      prompts.close()
    }
  }

  let resolvedDomain = args.domain
  let generatedSecret: string | undefined
  if (createApp) {
    process.stdout.write(args.appId === undefined
      ? '\n将通过飞书官方设备授权选择已有应用或创建新应用，并增量申请最小权限。App Secret 不会显示或写入 profile。\n'
      : `\n将通过飞书官方设备授权更新已有应用 ${args.appId}，并增量申请最小权限。App Secret 不会显示或写入 profile。\n`)
    const registration = await registerLarkApplication(args)
    appId = registration.client_id
    resolvedDomain = registration.user_info?.tenant_brand ?? resolvedDomain
    generatedSecret = registration.client_secret
    process.stdout.write(`应用 ${appId} 已完成授权；凭据将在 profile 事务中暂存并激活。\n`)
  } else {
    if (appId === undefined || !/^cli_[0-9a-fA-F]{16}$/u.test(appId)) {
      throw new Error('lark-channel setup: invalid App ID')
    }
    process.stdout.write(`请确认已有应用已开启机器人、im:message 与 im:resource 权限、长连接事件 im.message.receive_v1，且版本已发布。\n`
      + `控制台：https://open.feishu.cn/app\n`)
  }
  if (appId === undefined) throw new Error('lark-channel setup: Feishu did not return an App ID')
  const configuredAppId = appId
  let installedService: Awaited<ReturnType<typeof installDshResidentService>> | undefined
  await executeLarkSetupProfileTransaction({
    args,
    dshHome,
    patchPath,
    application: { appId: configuredAppId, domain: resolvedDomain },
    credentialProvider,
    ...(runtime.profileLockOptions === undefined ? {} : { profileLockOptions: runtime.profileLockOptions }),
    operations: {
      async storeCredential(locator) {
        const service = locator.provider === 'windows-dpapi'
          ? `dsh/lark/${args.profile}/${args.account}/versions/windows-dpapi`
          : locator.provider === 'linux-protected-file'
            ? `dsh/lark/${args.profile}/${args.account}/versions/linux-protected-file`
            : locator.service
        const credentialPath = locator.provider === 'windows-dpapi'
          || locator.provider === 'linux-protected-file' ? locator.path : undefined
        if (generatedSecret === undefined) {
          await storeSecret(credentialProvider, service, args.account, credentialPath)
        } else {
          await storeGeneratedSecret(credentialProvider, service, args.account, generatedSecret, credentialPath)
        }
        process.stdout.write(`候选凭据已暂存到 ${credentialProvider}；旧凭据仍保持有效。\n`)
      },
      readCredential(locator) {
        const service = locator.provider === 'windows-dpapi'
          ? `dsh/lark/${args.profile}/${args.account}/versions/windows-dpapi`
          : locator.provider === 'linux-protected-file'
            ? `dsh/lark/${args.profile}/${args.account}/versions/linux-protected-file`
            : locator.service
        return readSecret(
          credentialProvider,
          service,
          args.account,
          locator.provider === 'windows-dpapi' || locator.provider === 'linux-protected-file'
            ? locator.path
            : undefined,
        )
      },
      readEffectiveProfile,
      async discoverOwner(ownerInput) {
        const phrase = `DSH-CONNECT-${randomBytes(4).toString('hex').toUpperCase()}`
        const transport = createOfficialLarkTransport({
          appId: ownerInput.appId,
          appSecret: ownerInput.appSecret,
          domain: ownerInput.domain,
          handshakeTimeoutMs: 15_000,
          imageDownloadTimeoutMs: 30_000,
        })
        return discoverOwner(
          transport,
          phrase,
          ownerInput.account,
          ownerInput.tenant,
          ownerInput.timeoutMs,
        )
      },
      ...(args.manageService ? {
        async afterCommit() {
          installedService = await installResidentService({ dshHome, profile: args.profile })
        },
      } : {}),
    },
  })
  if (args.manageService) {
    const service = installedService
    if (service === undefined) throw new Error('lark-channel setup: resident service installation did not complete')
    process.stdout.write(`\n飞书 channel 已写入 profile ${args.profile}，owner 已精确绑定。\n`
      + `DSH Host 已由 ${service.kind} 启动并保持常驻，无需再手动运行 dsh web。\n`
      + `状态：${service.statusCommand}\n日志：${service.logCommand}\n`
      + `健康检查：在 Web 会话中调用 assistant_health。\n`)
  } else {
    process.stdout.write(`\n飞书 channel 已写入 profile ${args.profile}，owner 已精确绑定。\n`
      + `本次跳过常驻服务；手动启动：dsh --profile ${args.profile} --no-open\n`
      + `健康检查：在 Web 会话中调用 assistant_health。\n`)
  }
}

if (process.argv[1] !== undefined && isMainEntry(import.meta.url, process.argv[1])) {
  void runLarkSetup().catch(error => {
    process.stderr.write(`${formatLarkSetupError(error)}\n`)
    process.exitCode = 1
  })
}
