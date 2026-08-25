#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import type { ExternalPrincipalKey } from '@dsh-enhanced/assistant-delivery'
import { registerApp } from '@larksuiteoapi/node-sdk'
import * as QRCode from 'qrcode'
import { createOfficialLarkTransport } from './sdk.js'
import { installDshResidentService } from './resident.js'
import { configureLarkProfilePatch } from './setup-profile.js'
import type { LarkMessage, LarkTransport } from './types.js'

type RegisterAppOptions = Parameters<typeof registerApp>[0]
type RegisterAppResult = Awaited<ReturnType<typeof registerApp>>

export interface LarkSetupArgs {
  profile: string
  domain: 'feishu' | 'lark'
  account: string
  tenant: string
  appId?: string
  createApp: boolean
  appName: string
  timeoutMs: number
  installServiceOnly: boolean
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
    tenant: 'personal',
    createApp: false,
    appName: 'DSH Personal Assistant',
    timeoutMs: 300_000,
    installServiceOnly: false,
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
    else if (option === '--account') result.account = argumentValue(argv, index++, option)
    else if (option === '--tenant') result.tenant = argumentValue(argv, index++, option)
    else if (option === '--app-id') result.appId = argumentValue(argv, index++, option)
    else if (option === '--create-app') result.createApp = true
    else if (option === '--install-service') result.installServiceOnly = true
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
  --no-service            Configure Lark without installing a resident service
  --allow-agent-tools     Allow exact shell/read/search tools for external Agent turns
  --disable-agent-tools   Remove setup-managed external Agent tool rules
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

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = join(dirname(path), `.cordis.patch.yml.lark-setup-${process.pid}`)
  const file = await open(temporary, 'w', 0o600)
  try {
    await file.writeFile(value, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function validateProfile(profile: string): void {
  const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim().slice(0, 2_000) : ''
    throw new Error(`lark-channel setup: DSH rejected the updated profile${detail === '' ? '' : `: ${detail}`}`)
  }
}

export async function runLarkSetup(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseLarkSetupArgs(argv)
  if (args.help) {
    process.stdout.write(`${help()}\n`)
    return
  }
  const credentialProvider = credentialProviderForPlatform(process.platform)
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  if (!isAbsolute(dshHome)) throw new Error('lark-channel setup: DSH_HOME must be absolute')
  if (args.installServiceOnly) {
    validateProfile(args.profile)
    const service = await installDshResidentService({ dshHome, profile: args.profile })
    process.stdout.write(`DSH profile ${args.profile} 已由 ${service.kind} 启动并保持常驻。\n`
      + `状态：${service.statusCommand}\n日志：${service.logCommand}\n`)
    return
  }
  const patchPath = join(dshHome, 'profiles', args.profile, 'cordis.patch.yml')
  const originalPatch = await readFile(patchPath, 'utf8')
  const keychainService = `dsh/lark/${args.profile}/${args.account}`
  const credentialPath = credentialProvider === 'windows-dpapi'
    ? join(dshHome, 'credentials-keychain', `lark-${args.profile}-${args.account}.clixml`)
    : undefined
  if (credentialPath !== undefined) await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 })
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
  if (createApp) {
    process.stdout.write(args.appId === undefined
      ? '\n将通过飞书官方设备授权选择已有应用或创建新应用，并增量申请最小权限。App Secret 不会显示或写入 profile。\n'
      : `\n将通过飞书官方设备授权更新已有应用 ${args.appId}，并增量申请最小权限。App Secret 不会显示或写入 profile。\n`)
    const registration = await registerLarkApplication(args)
    appId = registration.client_id
    resolvedDomain = registration.user_info?.tenant_brand ?? resolvedDomain
    storeGeneratedSecret(credentialProvider, keychainService, args.account, registration.client_secret, credentialPath)
    process.stdout.write(`应用 ${appId} 已完成授权，凭据已写入 ${credentialProvider}。\n`)
  } else {
    if (appId === undefined || !/^cli_[0-9a-fA-F]{16}$/u.test(appId)) {
      throw new Error('lark-channel setup: invalid App ID')
    }
    process.stdout.write(`请确认已有应用已开启机器人、im:message 与 im:resource 权限、长连接事件 im.message.receive_v1，且版本已发布。\n`
      + `控制台：https://open.feishu.cn/app\n`)
    storeSecret(credentialProvider, keychainService, args.account, credentialPath)
  }
  if (appId === undefined) throw new Error('lark-channel setup: Feishu did not return an App ID')
  const configuredAppId = appId
  const appSecret = readSecret(credentialProvider, keychainService, args.account, credentialPath)
  const phrase = `DSH-CONNECT-${randomBytes(4).toString('hex').toUpperCase()}`
  const transport = createOfficialLarkTransport({
    appId: configuredAppId,
    appSecret,
    domain: resolvedDomain,
    handshakeTimeoutMs: 15_000,
    imageDownloadTimeoutMs: 30_000,
  })
  const owner = await discoverOwner(transport, phrase, args.account, args.tenant, args.timeoutMs)
  const updatedPatch = configureLarkProfilePatch({
    profilePatch: originalPatch,
    dshHome,
    appId: configuredAppId,
    account: args.account,
    tenant: args.tenant,
    domain: resolvedDomain,
    ownerUserId: owner.user,
    keychainService,
    keychainAccount: args.account,
    credentialProvider,
    agentTools: args.agentTools,
    ...(credentialPath === undefined ? {} : { credentialPath }),
  })

  const { pairPrincipalLocally } = await import('@dsh-enhanced/assistant-delivery')
  pairPrincipalLocally({ databasePath: join(dshHome, 'assistant-delivery/state.sqlite'), principal: owner })
  await atomicWrite(patchPath, updatedPatch)
  try {
    validateProfile(args.profile)
  } catch (error) {
    await atomicWrite(patchPath, originalPatch)
    throw error
  }
  if (args.manageService) {
    const service = await installDshResidentService({ dshHome, profile: args.profile })
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
