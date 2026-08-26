#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, win32 } from 'node:path'
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
      '--no-service', '--app-name', '--timeout-ms',
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
  if (result.installServiceOnly && result.agentTools !== 'preserve') {
    throw new Error('lark-channel setup: --install-service cannot be combined with agent-tools options')
  }
  const appNameHasControlCharacter = [...result.appName]
    .some(character => character.codePointAt(0)! <= 31 || character.codePointAt(0) === 127)
  if (result.appName.trim().length === 0 || result.appName.length > 64 || appNameHasControlCharacter) {
    throw new Error('lark-channel setup: app-name must be 1..64 characters without control characters')
  }
  if (result.domain !== 'feishu' && result.domain !== 'lark') throw new Error('lark-channel setup: domain must be feishu or lark')
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

export type SetupCredentialProvider = 'linux-secret-service' | 'macos-keychain' | 'windows-dpapi'

export type SetupCredentialLocator =
  | {
    provider: 'linux-secret-service' | 'macos-keychain'
    service: string
    account: string
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
  --allow-agent-tools     Allow mounted foreground/external Agent capabilities
  --disable-agent-tools   Remove setup-managed Agent capability rules
  --timeout-ms <ms>      Owner DM wait, 30000..900000 (default: 300000)
  -h, --help             Show this help

Without --create-app or --app-id, press Enter at the App ID prompt to select or create an app.
App Secret is intentionally not accepted as an argument. It is stored in macOS Keychain,
Linux Secret Service, or a per-user Windows DPAPI file.`
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

function linuxCredentialEnv(): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined
      ? {} : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }),
    ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
  }
}

function executeSecretWrite(request: SecretWriteRequest, env: NodeJS.ProcessEnv, failure: string): void {
  try {
    const result = spawnSync(request.executable, request.args, {
      encoding: 'utf8',
      env,
      input: request.input,
      maxBuffer: 128 * 1024,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    if (result.status !== 0) throw new Error(failure)
  } finally {
    request.input.fill(0)
  }
}

function storeSecret(
  provider: SetupCredentialProvider,
  service: string,
  account: string,
  credentialPath?: string,
): void {
  if (provider === 'macos-keychain') {
    process.stdout.write('\n请在 macOS Keychain 的安全提示中输入 App Secret（输入不会回显）：\n')
    runSecurity(['add-generic-password', '-U', '-a', account, '-s', service, '-w'], 'inherit')
    return
  }
  if (provider === 'linux-secret-service') {
    const prompt = spawnSync('/usr/bin/systemd-ask-password', ['飞书 App Secret：'], {
      encoding: 'utf8', env: linuxCredentialEnv(), maxBuffer: 128 * 1024, stdio: ['inherit', 'pipe', 'inherit'],
    })
    const secret = typeof prompt.stdout === 'string' ? prompt.stdout.replace(/[\r\n]+$/u, '') : ''
    if (prompt.status !== 0 || secret.length === 0) {
      throw new Error('lark-channel setup: Linux could not read the App Secret securely')
    }
    executeSecretWrite(createSecretServiceWriteRequest(service, account, secret), linuxCredentialEnv(),
      'lark-channel setup: Linux Secret Service operation failed')
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

function storeGeneratedSecret(
  provider: SetupCredentialProvider,
  service: string,
  account: string,
  secret: string,
  credentialPath?: string,
): void {
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
    executeSecretWrite(createSecretServiceWriteRequest(service, account, secret), linuxCredentialEnv(),
      'lark-channel setup: Linux Secret Service operation failed')
    return
  }
  if (credentialPath === undefined) throw new Error('lark-channel setup: missing DPAPI credential path')
  executeSecretWrite(createWindowsDpapiWriteRequest(credentialPath, secret), {
    PATH: 'C:\\Windows\\System32;C:\\Windows', SystemRoot: 'C:\\Windows',
  }, 'lark-channel setup: Windows DPAPI operation failed')
}

function readSecret(
  provider: SetupCredentialProvider,
  service: string,
  account: string,
  credentialPath?: string,
): string {
  let value = ''
  if (provider === 'macos-keychain') {
    value = runSecurity(['find-generic-password', '-w', '-a', account, '-s', service], 'pipe')
  } else if (provider === 'linux-secret-service') {
    const result = spawnSync('/usr/bin/secret-tool', ['lookup', 'service', service, 'account', account], {
      encoding: 'utf8', env: linuxCredentialEnv(), maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) throw new Error('lark-channel setup: Linux Secret Service lookup failed')
    value = typeof result.stdout === 'string' ? result.stdout.trimEnd() : ''
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
  const expectedKeys = provider === 'windows-dpapi'
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
  if (locator.provider === 'windows-dpapi') return handle.get('path') === locator.path
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
  if ((provider !== 'macos-keychain' && provider !== 'linux-secret-service' && provider !== 'windows-dpapi')
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
  if (provider === 'windows-dpapi') {
    const path = handle.get('path')
    if (typeof path !== 'string') return undefined
    const directory = platformJoin(input.dshHome, 'credentials-keychain')
    const legacyPath = platformJoin(directory, `lark-${input.profile}-${account}.clixml`)
    const versionPrefix = platformJoin(directory, `lark-${input.profile}-${account}-`)
    const version = path.startsWith(versionPrefix) && path.endsWith('.clixml')
      ? path.slice(versionPrefix.length, -'.clixml'.length)
      : undefined
    if (path !== legacyPath && (version === undefined || !credentialVersionPattern.test(version))) return undefined
    const locator: SetupCredentialLocator = { provider, path }
    if (handles.items.some(item => item !== handle && credentialHandleAliasesLocator(item, locator))) return undefined
    return locator
  }
  return undefined
}

async function removeCredential(locator: SetupCredentialLocator): Promise<void> {
  if (locator.provider === 'windows-dpapi') {
    try {
      await unlink(locator.path)
    } catch (error) {
      if (fileSystemErrorCode(error) !== 'ENOENT') {
        throw new Error('lark-channel setup: Windows DPAPI credential cleanup failed', { cause: error })
      }
    }
    return
  }
  const result = locator.provider === 'macos-keychain'
    ? spawnSync('/usr/bin/security', [
      'delete-generic-password', '-a', locator.account, '-s', locator.service,
    ], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, maxBuffer: 128 * 1024, stdio: ['ignore', 'ignore', 'pipe'],
    })
    : spawnSync('/usr/bin/secret-tool', [
      'clear', 'service', locator.service, 'account', locator.account,
    ], {
      encoding: 'utf8', env: linuxCredentialEnv(), maxBuffer: 128 * 1024, stdio: ['ignore', 'ignore', 'pipe'],
    })
  const missingMacosItem = locator.provider === 'macos-keychain' && result.status === 44
  const missingItemMessage = typeof result.stderr === 'string'
    && /(?:could not be found|not found|no matching|no such)/iu.test(result.stderr)
  if (result.status !== 0 && !missingMacosItem && !missingItemMessage) {
    throw new Error(`lark-channel setup: ${locator.provider} credential cleanup failed`)
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

async function retirePreviousCredentialBestEffort(
  locator: SetupCredentialLocator,
  operation: NonNullable<ValidatedLarkOwnerSetupOperations['removeCredential']>,
): Promise<void> {
  try {
    await removeCredentialIdempotently(locator, operation)
  } catch {
    // The profile and Delivery owner already reference the staged credential.
    // Retaining an inactive old secret is safer than blocking all future setup
    // recovery or falsely reporting that the committed rotation failed.
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
  try {
    const file = await open(temporary, 'w', 0o600)
    try {
      await file.writeFile(value, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await rm(temporary, { force: true })
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
}

function setupJournalPath(patchPath: string): string {
  return `${patchPath}.lark-setup.journal.json`
}

function textSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function credentialLocatorEquals(left: SetupCredentialLocator, right: SetupCredentialLocator): boolean {
  if (left.provider !== right.provider) return false
  if (left.provider === 'windows-dpapi' && right.provider === 'windows-dpapi') return left.path === right.path
  if (left.provider === 'windows-dpapi' || right.provider === 'windows-dpapi') return false
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
  if (locator.provider === 'windows-dpapi') {
    if (typeof locator.path !== 'string') {
      throw new Error('lark-channel setup: setup journal DPAPI locator is invalid')
    }
    const directory = platformJoin(input.dshHome, 'credentials-keychain')
    if (dirname(locator.path) !== directory) {
      throw new Error('lark-channel setup: setup journal DPAPI locator is outside the credential directory')
    }
    const name = locator.path.slice(directory.length + 1)
    const profile = escapeRegularExpression(input.profile)
    const account = input.stagedAccount === undefined
      ? '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
      : escapeRegularExpression(input.stagedAccount)
    const versioned = new RegExp(`^lark-${profile}-${account}-[0-9a-f]{32}\\.clixml$`, 'u')
    const legacy = new RegExp(`^lark-${profile}-${account}\\.clixml$`, 'u')
    if (!versioned.test(name) && (input.stagedAccount !== undefined || !legacy.test(name))) {
      throw new Error('lark-channel setup: setup journal DPAPI locator is not setup-managed')
    }
    return { provider: locator.provider, path: locator.path }
  }
  throw new Error('lark-channel setup: setup journal credential provider is invalid')
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
    await removeCredentialIdempotently(journal.stagedCredential!, remove)
    await clearLarkSetupJournal(input.patchPath)
    return true
  }
  if (journal.phase === 'candidate' || journal.phase === 'aborting') {
    if (current === journal.updatedPatch) await atomicWrite(input.patchPath, journal.originalPatch)
    else if (current !== journal.originalPatch) {
      throw new Error('lark-channel setup: candidate recovery refused because the live profile diverged')
    }
    if (journal.stagedCredential !== undefined) {
      await removeCredentialIdempotently(journal.stagedCredential, remove)
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
      await retirePreviousCredentialBestEffort(journal.previousCredential, remove)
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
    try {
      await remove(previous)
    } catch {
      // The profile and owner are already committed. Keep the now-inactive
      // credential rather than reporting a false setup failure or rolling back
      // a successful handoff; a later setup can retire the orphan safely.
      process.stderr.write('lark-channel setup: previous credential cleanup failed after commit\n')
    }
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
    if (stagedCredential.provider === 'windows-dpapi') {
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
            ...(stagedCredential.provider === 'windows-dpapi' ? { credentialPath: stagedCredential.path } : {}),
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
      await retirePreviousCredentialBestEffort(previousCredential, remove)
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
  journalOperations?: RecoverLarkSetupJournalOperations
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
  // Resolve a prior crash before prompting the user or mutating a cloud app.
  // The mutation transaction repeats this check after registration to close
  // the gap against a different setup process that completed in the meantime.
  await withProfileSetupLock(patchPath, async () => {
    await recoverLarkSetupJournalUnlocked({
      patchPath,
      dshHome,
      profile: args.profile,
      operations: recoveryOperations,
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
  const credentialProvider = credentialProviderForPlatform(process.platform)
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
      storeCredential(locator) {
        const service = locator.provider === 'windows-dpapi'
          ? `dsh/lark/${args.profile}/${args.account}/versions/windows-dpapi`
          : locator.service
        const credentialPath = locator.provider === 'windows-dpapi' ? locator.path : undefined
        if (generatedSecret === undefined) {
          storeSecret(credentialProvider, service, args.account, credentialPath)
        } else {
          storeGeneratedSecret(credentialProvider, service, args.account, generatedSecret, credentialPath)
        }
        process.stdout.write(`候选凭据已安全暂存到 ${credentialProvider}；旧凭据仍保持有效。\n`)
      },
      readCredential(locator) {
        const service = locator.provider === 'windows-dpapi'
          ? `dsh/lark/${args.profile}/${args.account}/versions/windows-dpapi`
          : locator.service
        return readSecret(
          credentialProvider,
          service,
          args.account,
          locator.provider === 'windows-dpapi' ? locator.path : undefined,
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
