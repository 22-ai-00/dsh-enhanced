import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import * as QRCode from 'qrcode'
import { resolveProfilePaths, type AutonomyHostContext } from './autonomy-setup.js'
import {
  applyFeishuVaultConfig, inspectProfileRestartSupport, PLACEHOLDER_LARK_APP_ID, promoteLarkOwnerInProfile,
  redactVaultSecret,
  type ApplyFeishuVaultResult, type DeleteSecretFn, type InspectProfileRestartInput, type ProfileRestartSupport,
  type PromoteLarkOwnerInput, type PromoteLarkOwnerResult, type StoreSecretFn,
} from './doctor-repair.js'
import {
  hasControlChars, isAppId,
  type BundleInfoLike, type PluginManagerService, type SettingsDescriptor, type SettingsService,
} from './settings.js'
import type { FeishuQrOnboardingSnapshot, FeishuQrOwnerBinding } from './typert.js'
import { detectFrozenSystemdProfile } from './upgrade-probe.js'

const PROTOCOL = 'owner-console/feishu-qr-onboarding/v1' as const
const FEISHU_AUTH_HOST = 'accounts.feishu.cn'
const LARK_AUTH_HOST = 'accounts.larksuite.com'
const REGISTRATION_ENDPOINT = '/oauth/v1/app/registration'
const SETUP_KEY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const LARK_OPEN_ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
const DEFAULT_APP_NAME = '文鳐助手'
const DEFAULT_APP_DESC = '由 DeepSeek Harness 驱动的个人助理'
const REQUEST_TIMEOUT_MS = 15_000
const PREFLIGHT_TIMEOUT_MS = 10_000
const MIN_EXPIRE_SEC = 30
const MAX_EXPIRE_SEC = 3_600
const DEFAULT_EXPIRE_SEC = 600
const MIN_INTERVAL_SEC = 2
const MAX_INTERVAL_SEC = 60
const DEFAULT_INTERVAL_SEC = 5
const SLOW_DOWN_STEP_MS = 5_000
const MAX_POLL_INTERVAL_MS = 60_000
const MAX_CONSECUTIVE_NETWORK_ERRORS = 3

const REQUIRED_FEISHU_BUNDLES = [
  '@dsh-ray/lark-channel',
  '@dsh-ray/credentials-keychain',
  '@dsh-ray/assistant-delivery',
] as const

const BASE_TENANT_SCOPES = [
  'application:bot.basic_info:read',
  'im:message.group_at_msg:readonly',
  'im:message.p2p_msg:readonly',
  'im:message.reactions:write_only',
  'im:message:send_as_bot',
  'im:resource',
] as const

export interface FeishuRegistrationAddons {
  readonly preset: boolean
  readonly scopes: Readonly<{ readonly tenant: readonly string[] }>
  readonly events: Readonly<{ readonly items: Readonly<{ readonly tenant: readonly string[] }> }>
  readonly callbacks: Readonly<{ readonly items: readonly string[] }>
}

/** Matches `@larksuiteoapi/node-sdk` `encodeAddons`: JSON -> gzip -> URL-safe base64 without padding. */
export function encodeFeishuAddons(addons: FeishuRegistrationAddons): string {
  return gzipSync(Buffer.from(JSON.stringify(addons), 'utf8'))
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '')
}

export function buildFeishuAddons(options: Readonly<{
  calendarReadonly: boolean
  businessTools: boolean
}>): FeishuRegistrationAddons {
  return {
    preset: options.businessTools,
    scopes: {
      tenant: [
        ...BASE_TENANT_SCOPES,
        ...(options.calendarReadonly ? ['calendar:calendar:readonly'] : []),
      ],
    },
    events: { items: { tenant: ['im.message.receive_v1'] } },
    callbacks: { items: ['card.action.trigger'] },
  }
}

export function isTrustedFeishuRegistrationUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username !== '' || parsed.password !== '') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'feishu.cn'
      || host.endsWith('.feishu.cn')
      || host === 'larksuite.com'
      || host.endsWith('.larksuite.com')
  } catch {
    return false
  }
}

export function buildFeishuRegistrationUrl(input: Readonly<{
  verificationUriComplete: string
  appName: string
  existingAppId?: string
  calendarReadonly: boolean
  businessTools: boolean
}>): string {
  if (!isTrustedFeishuRegistrationUrl(input.verificationUriComplete)) {
    throw new Error('飞书返回的授权链接域名不受信任，已拒绝展示。')
  }
  const url = new URL(input.verificationUriComplete)
  url.searchParams.set('from', 'sdk')
  url.searchParams.set('source', 'node-sdk/dsh-ray/lark-channel')
  url.searchParams.set('tp', 'sdk')
  url.searchParams.set('name', input.appName)
  url.searchParams.set('desc', DEFAULT_APP_DESC)
  url.searchParams.set('addons', encodeFeishuAddons(buildFeishuAddons({
    calendarReadonly: input.calendarReadonly,
    businessTools: input.businessTools,
  })))
  if (input.existingAppId !== undefined && input.existingAppId !== '') {
    url.searchParams.set('clientID', input.existingAppId)
  }
  return url.toString()
}

export async function renderFeishuQrDataUrl(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    margin: 3,
    width: 240,
    errorCorrectionLevel: 'L',
  })
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

export interface FeishuQrHttpResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export type FeishuQrFetchFn = (
  url: string,
  init: Readonly<{
    method: 'POST'
    headers: Readonly<Record<string, string>>
    body: string
    signal: AbortSignal
  }>,
) => Promise<FeishuQrHttpResponse>

export interface FeishuQrStartRequest {
  readonly domain: 'feishu' | 'lark'
  readonly appName: string
  readonly existingAppId: string
  readonly account: string
  readonly tenant: string
  readonly calendarReadonly: boolean
  readonly businessTools: boolean
}

export interface FeishuQrRuntimeContext {
  readonly host: AutonomyHostContext
  readonly getDescriptors: () => readonly SettingsDescriptor[]
  readonly getSettings?: () => SettingsService | undefined
  readonly listBundles?: () => Promise<readonly BundleInfoLike[]>
  /** Retained for backwards type compatibility; intentionally unused after patch writes (restart required). */
  readonly reloadEntry?: (entryId: string) => Promise<string>
  /** Retained for backwards type compatibility; intentionally unused to avoid stale-connection false positives. */
  readonly isLarkConnected?: () => boolean
}

export interface FeishuQrOnboardingManagerOptions {
  readonly fetchFn?: FeishuQrFetchFn
  readonly renderQrFn?: (url: string) => Promise<string>
  readonly applyVaultFn?: (input: Readonly<{
    host: AutonomyHostContext
    descriptors: readonly SettingsDescriptor[]
    settings?: SettingsService | undefined
    reloadEntry?: (entryId: string) => Promise<string>
    appId: string
    appSecret: string
    account: string
    tenant: string
    domain: 'feishu' | 'lark'
    ownerOpenId?: string
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    now?: number
    storeSecretFn?: StoreSecretFn
    deleteSecretFn?: DeleteSecretFn
  }>) => Promise<ApplyFeishuVaultResult>
  readonly storeSecretFn?: StoreSecretFn
  readonly deleteSecretFn?: DeleteSecretFn
  readonly promoteOwnerFn?: (input: PromoteLarkOwnerInput) => Promise<PromoteLarkOwnerResult>
  readonly inspectRestartFn?: (input: InspectProfileRestartInput) => ProfileRestartSupport
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
}

interface ParsedRegistrationPayload {
  readonly device_code?: string
  readonly verification_uri_complete?: string
  readonly expires_in?: number
  readonly interval?: number
  readonly client_id?: string
  readonly client_secret?: string
  readonly error?: string
  readonly error_description?: string
  readonly user_info?: Readonly<{
    readonly open_id?: string
    readonly tenant_brand?: string
  }>
}

function defaultFetch(
  url: string,
  init: Readonly<{
    method: 'POST'
    headers: Readonly<Record<string, string>>
    body: string
    signal: AbortSignal
  }>,
): Promise<FeishuQrHttpResponse> {
  return fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
    signal: init.signal,
  })
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function boundedNote(text: string, maxLen = 1_800): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean
}

function redactSecret(text: string, secret?: string): string {
  if (secret === undefined || secret === '') return text
  return redactVaultSecret(text, secret)
}

function idleSnapshot(note = '点击「一键生成飞书扫码授权」即可通过飞书官方设备授权创建或绑定应用。'): FeishuQrOnboardingSnapshot {
  return Object.freeze({
    protocol: PROTOCOL,
    sessionId: '',
    state: 'idle',
    domain: 'feishu',
    domainSwitched: false,
    note,
  })
}

function parseRegistrationJson(raw: string): ParsedRegistrationPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('飞书授权接口返回了无法解析的响应')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('飞书授权接口返回了非对象响应')
  }
  const rec = parsed as Record<string, unknown>
  const rawUserInfo = rec['user_info']
  const userInfo = rawUserInfo !== null && typeof rawUserInfo === 'object' && !Array.isArray(rawUserInfo)
    ? {
        ...(typeof (rawUserInfo as Record<string, unknown>)['open_id'] === 'string'
          ? { open_id: (rawUserInfo as Record<string, unknown>)['open_id'] as string }
          : {}),
        ...(typeof (rawUserInfo as Record<string, unknown>)['tenant_brand'] === 'string'
          ? { tenant_brand: (rawUserInfo as Record<string, unknown>)['tenant_brand'] as string }
          : {}),
      }
    : undefined
  return {
    ...(typeof rec['device_code'] === 'string' ? { device_code: rec['device_code'] } : {}),
    ...(typeof rec['verification_uri_complete'] === 'string' ? { verification_uri_complete: rec['verification_uri_complete'] } : {}),
    ...(typeof rec['expires_in'] === 'number' ? { expires_in: rec['expires_in'] } : {}),
    ...(typeof rec['interval'] === 'number' ? { interval: rec['interval'] } : {}),
    ...(typeof rec['client_id'] === 'string' ? { client_id: rec['client_id'] } : {}),
    ...(typeof rec['client_secret'] === 'string' ? { client_secret: rec['client_secret'] } : {}),
    ...(typeof rec['error'] === 'string' ? { error: rec['error'] } : {}),
    ...(typeof rec['error_description'] === 'string' ? { error_description: rec['error_description'] } : {}),
    ...(userInfo === undefined ? {} : { user_info: userInfo }),
  }
}

async function postRegistration(
  fetchFn: FeishuQrFetchFn,
  baseUrl: string,
  params: Readonly<Record<string, string>>,
  parentSignal: AbortSignal,
): Promise<ParsedRegistrationPayload> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = AbortSignal.any([parentSignal, timeoutSignal])
  const res = await fetchFn(`${baseUrl}${REGISTRATION_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: combined,
  })
  const text = await res.text()
  // RFC 8628 returns HTTP 400 with structured JSON (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`).
  if (!res.ok && res.status !== 400) {
    throw new Error(`飞书授权服务返回 HTTP ${res.status}`)
  }
  return parseRegistrationJson(text)
}

function ownerBindingDetail(binding: FeishuQrOwnerBinding): string {
  switch (binding) {
    case 'bound-owner':
      return '已自动绑定为飞书主主人'
    case 'reused-owner':
      return '已沿用现有飞书主主人身份'
    case 'linked-to-owner':
      return '已以关联身份（linked）接入现有主主人账户：普通私聊可正常使用，主人专属命令（/permission、/model、审批卡片、反馈学习与自主授权/工作项准入）仍锚定在现有主主人；可直接在下方一键设为飞书主主人（或使用终端向导 dsh-lark-setup）'
    case 'reused-linked':
      return '已沿用已关联飞书身份（linked）：普通私聊可正常使用，主人专属命令（/permission、/model、审批卡片、反馈学习与自主授权/工作项准入）仍锚定在现有主主人；可直接在下方一键设为飞书主主人（或使用终端向导 dsh-lark-setup）'
    case 'not-returned':
      return '飞书未返回扫码账号 open_id，未写入主人身份表；如需绑定或切换主主人，请使用终端向导 dsh-lark-setup'
    case 'unmodified':
      return '消息与工具策略已写入，但 Delivery 身份表未改写；重启 profile 初始化身份表后可一键切换主主人（或使用终端向导 dsh-lark-setup）'
  }
}

async function checkRequiredFeishuBundles(
  runtime: FeishuQrRuntimeContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return undefined
  const listBundles = runtime.listBundles ?? (() => {
    const manager = runtime.host.get('pluginManager') as Partial<PluginManagerService> | undefined
    return typeof manager?.listBundles === 'function' ? manager.listBundles() : undefined
  })
  let maybe: Promise<readonly BundleInfoLike[]> | undefined
  try {
    maybe = listBundles()
  } catch {
    return undefined
  }
  if (maybe === undefined) return undefined

  let bundles: readonly BundleInfoLike[] | undefined
  try {
    // Prevent unhandled rejection if listBundles() rejects after abort/timeout wins the race.
    const safeList = Promise.resolve(maybe).catch(() => undefined)
    bundles = await new Promise<readonly BundleInfoLike[] | undefined>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const settle = (value: readonly BundleInfoLike[] | undefined) => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (onAbort !== undefined) {
          signal.removeEventListener('abort', onAbort)
          onAbort = undefined
        }
        resolve(value)
      }
      onAbort = () => settle(undefined)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => settle(undefined), PREFLIGHT_TIMEOUT_MS)
      timer.unref?.()
      void safeList.then(settle)
    })
  } catch {
    return undefined
  }
  if (signal.aborted || !Array.isArray(bundles)) return undefined

  const uninstalled: string[] = []
  const disabled: string[] = []
  const errored: string[] = []
  for (const pkg of REQUIRED_FEISHU_BUNDLES) {
    const entry = bundles.find(candidate => candidate.name === pkg)
    if (entry === undefined || !entry.installed || entry.error?.code === 'not-bundle') {
      uninstalled.push(pkg)
    } else if (!entry.enabled) {
      disabled.push(pkg)
    } else if (entry.error !== undefined) {
      errored.push(`${pkg}（${entry.error.code ?? 'error'}）`)
    }
  }
  const policyCandidates = ['@dsh-ray/personal-assistant', '@dsh-ray/assistant-policy']
    .map(pkg => bundles.find(candidate => candidate.name === pkg))
    .filter((entry): entry is BundleInfoLike => entry !== undefined && entry.installed && entry.error?.code !== 'not-bundle')
  if (policyCandidates.length > 0 && !policyCandidates.some(entry => entry.enabled && entry.error === undefined)) {
    const erroredPolicy = policyCandidates.find(entry => entry.enabled && entry.error !== undefined)
    if (erroredPolicy !== undefined) {
      errored.push(`${erroredPolicy.name}（${erroredPolicy.error?.code ?? 'error'}）`)
    } else {
      disabled.push(policyCandidates[0]!.name)
    }
  }
  if (uninstalled.length === 0 && disabled.length === 0 && errored.length === 0) return undefined

  const parts: string[] = []
  if (uninstalled.length > 0) parts.push(`未安装：${uninstalled.join('、')}`)
  if (disabled.length > 0) parts.push(`已安装但未启用：${disabled.join('、')}`)
  if (errored.length > 0) parts.push(`状态异常：${errored.join('、')}`)
  return `缺少飞书扫码接入必需组件（${parts.join('；')}）。请先在上方第 1 步或「系统体检」一键恢复启用/安装这些组件并重启 profile，再重新发起扫码授权。`
}

/**
 * Host-side coordinator for Feishu/Lark official OAuth 2.0 Device Authorization Grant (RFC 8628).
 * Keeps `device_code` and `client_secret` strictly inside Host memory; browser only observes
 * sanitized snapshots and an inline SVG QR code data URL.
 */
export class FeishuQrOnboardingManager {
  private readonly fetchFn: FeishuQrFetchFn
  private readonly renderQrFn: (url: string) => Promise<string>
  private readonly applyVaultFn: NonNullable<FeishuQrOnboardingManagerOptions['applyVaultFn']>
  private readonly storeSecretFn: StoreSecretFn | undefined
  private readonly deleteSecretFn: DeleteSecretFn | undefined
  private readonly promoteOwnerFn: (input: PromoteLarkOwnerInput) => Promise<PromoteLarkOwnerResult>
  private readonly inspectRestartFn: (input: InspectProfileRestartInput) => ProfileRestartSupport
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv | undefined

  private generation = 0
  private activeAbort: AbortController | undefined
  private startingGen: number | undefined
  private snapshot: FeishuQrOnboardingSnapshot = idleSnapshot()
  private disposed = false

  constructor(options: FeishuQrOnboardingManagerOptions = {}) {
    this.fetchFn = options.fetchFn ?? defaultFetch
    this.renderQrFn = options.renderQrFn ?? renderFeishuQrDataUrl
    this.applyVaultFn = options.applyVaultFn ?? applyFeishuVaultConfig
    this.storeSecretFn = options.storeSecretFn
    this.deleteSecretFn = options.deleteSecretFn
    this.promoteOwnerFn = options.promoteOwnerFn ?? promoteLarkOwnerInProfile
    this.inspectRestartFn = options.inspectRestartFn ?? inspectProfileRestartSupport
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
    this.platform = options.platform ?? process.platform
    this.env = options.env
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    const wasStarting = this.startingGen !== undefined
    this.startingGen = undefined
    this.activeAbort?.abort()
    this.activeAbort = undefined
    if (this.snapshot.state === 'awaiting-scan' || wasStarting) {
      this.snapshot = Object.freeze({
        ...this.snapshot,
        state: 'cancelled',
        note: '控制台已卸载，飞书扫码授权会话已停止。',
      })
    }
  }

  status(sessionId: string): FeishuQrOnboardingSnapshot {
    const requested = sessionId.trim()
    if (requested !== '' && this.snapshot.sessionId !== requested) {
      return idleSnapshot('未找到该扫码授权会话（可能已被新会话替换或已结束）。')
    }
    if (
      this.snapshot.state === 'awaiting-scan'
      && this.snapshot.expiresAt !== undefined
      && this.now() >= this.snapshot.expiresAt
    ) {
      // Bump generation before aborting so an in-flight poll that just received credentials cannot slip into applyAuthorizedApp().
      this.generation += 1
      this.activeAbort?.abort()
      this.activeAbort = undefined
      this.snapshot = Object.freeze({
        ...this.snapshot,
        state: 'expired',
        errorCode: 'expired_token',
        note: '本次飞书授权二维码已过期，请点击「重新生成二维码」。',
      })
    }
    return this.snapshot
  }

  cancel(sessionId: string): FeishuQrOnboardingSnapshot {
    const requested = sessionId.trim()
    if (requested !== '' && this.snapshot.sessionId !== requested) {
      return this.status(requested)
    }
    if (this.snapshot.state === 'applying') {
      return Object.freeze({
        ...this.snapshot,
        note: '飞书授权已完成，正在写入加密凭据与策略，请稍候片刻即可完成。',
      })
    }
    const wasStarting = this.startingGen !== undefined
    this.generation += 1
    this.startingGen = undefined
    this.activeAbort?.abort()
    this.activeAbort = undefined
    if (this.snapshot.state === 'awaiting-scan' || wasStarting) {
      this.snapshot = Object.freeze({
        protocol: PROTOCOL,
        sessionId: this.snapshot.state === 'awaiting-scan' ? this.snapshot.sessionId : '',
        state: 'cancelled',
        domain: this.snapshot.domain,
        domainSwitched: this.snapshot.domainSwitched,
        note: '已取消本次飞书扫码授权，可随时重新发起。',
      })
    }
    return this.snapshot
  }

  async start(runtime: FeishuQrRuntimeContext, request: FeishuQrStartRequest): Promise<FeishuQrOnboardingSnapshot> {
    if (this.disposed) {
      return this.failSnapshot(request.domain, 'disposed', '控制台服务已停止，无法发起飞书扫码授权。')
    }
    if (this.snapshot.state === 'applying') {
      return Object.freeze({
        ...this.snapshot,
        note: '上一次飞书授权正在完成凭据与策略写入，请稍候完成。',
      })
    }

    const domain: 'feishu' | 'lark' = request.domain === 'lark' ? 'lark' : 'feishu'
    const env = this.env ?? process.env
    const paths = resolveProfilePaths(runtime.host, env)
    if (detectFrozenSystemdProfile(paths.dshHome, paths.profileName, this.platform, env)) {
      return this.failSnapshot(domain, 'frozen-profile', '当前为受控 Linux systemd 冻结实例，拒绝在线改写系统凭据或通道策略。')
    }
    if (!paths.writable || paths.patchPath === null || paths.canonicalHome === null) {
      return this.failSnapshot(domain, 'unwritable-profile', '当前 profile 的 cordis.patch.yml 或 DSH_HOME 不可写入，无法保存飞书授权凭据。')
    }
    if (!SETUP_KEY_TOKEN.test(paths.profileName)) {
      return this.failSnapshot(domain, 'invalid-profile-name', '当前 profile 名称含不受支持的字符，无法安全生成系统凭据句柄。')
    }
    if (this.platform !== 'darwin' && this.platform !== 'linux' && this.storeSecretFn === undefined) {
      return this.failSnapshot(domain, 'unsupported-platform', `当前系统（${this.platform}）暂不支持控制台一键写入系统凭据库，请改用终端向导 dsh-lark-setup 或环境变量/Handle 模式。`)
    }

    const appName = request.appName.trim() === '' ? DEFAULT_APP_NAME : request.appName.trim()
    if (appName.length > 64 || hasControlChars(appName)) {
      return this.failSnapshot(domain, 'invalid-app-name', '应用名称须为 1..64 个有效字符且不含控制字符。')
    }

    const existingAppId = request.existingAppId.trim()
    if (existingAppId !== '' && (!isAppId(existingAppId) || existingAppId === PLACEHOLDER_LARK_APP_ID)) {
      return this.failSnapshot(domain, 'invalid-app-id', '已有 App ID 必须形如 cli_0123456789abcdef（留空则由飞书页面选择已有应用或创建新应用）。')
    }

    const account = request.account.trim()
    if (account !== '' && (!SETUP_KEY_TOKEN.test(account) || account.includes('-legacy-'))) {
      return this.failSnapshot(domain, 'invalid-account', 'account 格式无效（需 1..64 位字母/数字/._-，且不能包含 -legacy-）。')
    }
    const tenant = request.tenant.trim()
    if (tenant !== '' && !SETUP_KEY_TOKEN.test(tenant)) {
      return this.failSnapshot(domain, 'invalid-tenant', 'tenant 格式无效（需 1..64 位字母/数字/._-）。')
    }

    // Claim generation and abort controller synchronously before any await (preflight or begin)
    // so cancel()/dispose()/supersede immediately aborts an in-flight start.
    this.generation += 1
    const gen = this.generation
    this.startingGen = gen
    this.activeAbort?.abort()
    const controller = new AbortController()
    this.activeAbort = controller

    const bundleIssue = await checkRequiredFeishuBundles(runtime, controller.signal)
    if (this.generation !== gen || controller.signal.aborted) {
      if (this.startingGen === gen) this.startingGen = undefined
      return this.snapshot
    }
    if (bundleIssue !== undefined) {
      if (this.startingGen === gen) this.startingGen = undefined
      return this.commitSnapshot(gen, this.failSnapshot(domain, 'missing-required-bundles', bundleIssue))
    }

    const baseUrl = `https://${domain === 'lark' ? LARK_AUTH_HOST : FEISHU_AUTH_HOST}`
    let beginRes: ParsedRegistrationPayload
    try {
      beginRes = await postRegistration(this.fetchFn, baseUrl, {
        action: 'begin',
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id',
      }, controller.signal)
    } catch (error: unknown) {
      if (this.startingGen === gen) this.startingGen = undefined
      if (this.generation !== gen || controller.signal.aborted) return this.snapshot
      const reason = error instanceof Error ? error.message : String(error)
      return this.commitSnapshot(gen, this.failSnapshot(
        domain,
        'begin-failed',
        `无法连接飞书官方设备授权接口（${boundedNote(reason, 240)}）；请检查网络连接后重试。`,
      ))
    }

    if (this.generation !== gen || controller.signal.aborted) {
      if (this.startingGen === gen) this.startingGen = undefined
      return this.snapshot
    }

    const deviceCode = beginRes.device_code?.trim() ?? ''
    const rawVerifyUrl = beginRes.verification_uri_complete?.trim() ?? ''
    if (deviceCode === '' || rawVerifyUrl === '') {
      if (this.startingGen === gen) this.startingGen = undefined
      const desc = beginRes.error_description || beginRes.error || '缺少 device_code 或授权链接'
      return this.commitSnapshot(gen, this.failSnapshot(
        domain,
        beginRes.error ?? 'invalid-begin-response',
        `飞书授权初始化失败：${boundedNote(desc, 240)}`,
      ))
    }

    let verificationUrl: string
    try {
      verificationUrl = buildFeishuRegistrationUrl({
        verificationUriComplete: rawVerifyUrl,
        appName,
        ...(existingAppId === '' ? {} : { existingAppId }),
        calendarReadonly: request.calendarReadonly,
        businessTools: request.businessTools,
      })
    } catch (error: unknown) {
      if (this.startingGen === gen) this.startingGen = undefined
      return this.commitSnapshot(gen, this.failSnapshot(
        domain,
        'untrusted-url',
        error instanceof Error ? error.message : '飞书授权链接校验失败。',
      ))
    }

    let qrCodeDataUrl: string | undefined
    try {
      qrCodeDataUrl = await this.renderQrFn(verificationUrl)
    } catch {
      qrCodeDataUrl = undefined
    }

    if (this.startingGen === gen) this.startingGen = undefined
    if (this.generation !== gen || controller.signal.aborted) return this.snapshot

    const startedAt = Math.max(0, Math.trunc(this.now()))
    const expireSec = clampInt(beginRes.expires_in, DEFAULT_EXPIRE_SEC, MIN_EXPIRE_SEC, MAX_EXPIRE_SEC)
    const intervalSec = clampInt(beginRes.interval, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)
    const expiresAt = startedAt + expireSec * 1_000
    const pollIntervalMs = intervalSec * 1_000
    const sessionId = `feishu-qr-${randomUUID()}`

    const initial: FeishuQrOnboardingSnapshot = Object.freeze({
      protocol: PROTOCOL,
      sessionId,
      state: 'awaiting-scan',
      domain,
      domainSwitched: false,
      appName,
      verificationUrl,
      ...(qrCodeDataUrl === undefined ? {} : { qrCodeDataUrl }),
      startedAt,
      expiresAt,
      pollIntervalMs,
      businessToolsRequested: request.businessTools,
      note: existingAppId === ''
        ? '请用飞书扫描二维码（或点击下方链接），选择已有应用或一键创建新应用并确认权限。'
        : `请用飞书扫描二维码（或点击下方链接），确认更新应用 ${existingAppId} 并授予所需权限。`,
    })
    this.snapshot = initial

    void this.runPollingLoop({
      gen,
      sessionId,
      runtime,
      controller,
      baseUrl,
      domain,
      appName,
      businessTools: request.businessTools,
      deviceCode,
      pollIntervalMs,
      expiresAt,
      account,
      tenant,
    })

    return initial
  }

  async promoteOwner(
    runtime: FeishuQrRuntimeContext,
    sessionId: string,
    confirmed: boolean,
  ): Promise<FeishuQrOnboardingSnapshot> {
    if (this.disposed) {
      return this.failSnapshot(this.snapshot.domain, 'disposed', '控制台服务已停止，无法切换飞书主主人。')
    }
    const requested = sessionId.trim()
    if (requested !== '' && this.snapshot.sessionId !== requested) {
      return Object.freeze({
        ...idleSnapshot('未找到该扫码授权会话（可能已被新会话替换或已结束），无法切换主主人。'),
        errorCode: 'session-mismatch',
      })
    }
    if (this.snapshot.state !== 'completed') {
      return Object.freeze({
        ...this.snapshot,
        errorCode: 'invalid-state',
      })
    }
    const genAtCall = this.generation
    if (confirmed !== true) {
      return Object.freeze({
        ...this.snapshot,
        errorCode: 'confirmation-required',
        note: '切换飞书主主人需要明确确认后才能执行。',
      })
    }
    const openId = this.snapshot.openId?.trim() ?? ''
    if (openId === '' || !LARK_OPEN_ID_TOKEN.test(openId)) {
      return Object.freeze({
        ...this.snapshot,
        errorCode: 'missing-open-id',
        note: '本次扫码未返回账号 open_id，无法一键设为飞书主主人；请重启后使用 dsh-lark-setup 完成主主人绑定。',
      })
    }

    let result: PromoteLarkOwnerResult
    try {
      result = await this.promoteOwnerFn({
        host: runtime.host,
        descriptors: runtime.getDescriptors(),
        openId,
        account: this.snapshot.account ?? 'primary',
        tenant: this.snapshot.tenant ?? 'personal',
        confirmed: true,
        platform: this.platform,
        ...(this.env === undefined ? {} : { env: this.env }),
        now: this.now(),
      })
    } catch (error: unknown) {
      return Object.freeze({
        ...this.snapshot,
        errorCode: 'promote-failed',
        note: `一键切换飞书主主人失败：${boundedNote(error instanceof Error ? error.message : String(error), 400)}`,
      })
    }

    if (this.disposed || this.generation !== genAtCall) return this.snapshot
    if (!result.applied) {
      return Object.freeze({
        ...this.snapshot,
        existingAutonomyAnchored: result.existingAutonomyAnchored,
        errorCode: result.errorCode ?? 'promote-refused',
        note: boundedNote(result.note, 1_800),
      })
    }

    const { errorCode: _clearedError, ...rest } = this.snapshot
    void _clearedError
    const updated: FeishuQrOnboardingSnapshot = Object.freeze({
      ...rest,
      ownerBinding: result.ownerBinding,
      ownerPromoted: true,
      existingAutonomyAnchored: result.existingAutonomyAnchored,
      restartRecommended: true,
      note: boundedNote(result.note, 1_800),
    })
    return this.commitSnapshot(genAtCall, updated)
  }

  private async runPollingLoop(input: Readonly<{
    gen: number
    sessionId: string
    runtime: FeishuQrRuntimeContext
    controller: AbortController
    baseUrl: string
    domain: 'feishu' | 'lark'
    appName: string
    businessTools: boolean
    deviceCode: string
    pollIntervalMs: number
    expiresAt: number
    account: string
    tenant: string
  }>): Promise<void> {
    let currentBaseUrl = input.baseUrl
    let currentDomain: 'feishu' | 'lark' = input.domain
    let domainSwitched = false
    let intervalMs = input.pollIntervalMs
    let consecutiveNetworkErrors = 0
    let skipInitialWait = false
    const { gen, controller } = input

    while (!this.disposed && this.generation === gen && !controller.signal.aborted) {
      if (!skipInitialWait) {
        const waitMs = Math.min(intervalMs, Math.max(0, input.expiresAt - this.now()))
        if (waitMs > 0) {
          try {
            await this.sleep(waitMs, controller.signal)
          } catch {
            if (this.disposed || this.generation !== gen || controller.signal.aborted) return
          }
        }
        if (this.disposed || this.generation !== gen || controller.signal.aborted) return
      }
      skipInitialWait = false

      const remainingMs = input.expiresAt - this.now()
      if (remainingMs <= 0) {
        this.commitSnapshot(gen, Object.freeze({
          ...this.snapshot,
          state: 'expired',
          errorCode: 'expired_token',
          note: '本次飞书授权二维码已过期，请点击「重新生成二维码」。',
        }))
        return
      }

      let pollRes: ParsedRegistrationPayload
      try {
        pollRes = await postRegistration(this.fetchFn, currentBaseUrl, {
          action: 'poll',
          device_code: input.deviceCode,
        }, controller.signal)
        consecutiveNetworkErrors = 0
      } catch (error: unknown) {
        if (this.disposed || this.generation !== gen || controller.signal.aborted) return
        consecutiveNetworkErrors += 1
        if (consecutiveNetworkErrors > MAX_CONSECUTIVE_NETWORK_ERRORS) {
          const reason = error instanceof Error ? error.message : String(error)
          this.commitSnapshot(gen, Object.freeze({
            ...this.snapshot,
            state: 'failed',
            errorCode: 'network-error',
            note: `轮询飞书授权状态失败：${boundedNote(reason, 240)}`,
          }))
          return
        }
        continue
      }

      if (this.disposed || this.generation !== gen || controller.signal.aborted) return

      const clientId = pollRes.client_id?.trim() ?? ''
      const clientSecret = pollRes.client_secret?.trim() ?? ''

      // Official SDK behavior: switch once to accounts.larksuite.com when Feishu identifies an international Lark user.
      if (clientId === '' && clientSecret === '' && pollRes.user_info?.tenant_brand === 'lark' && !domainSwitched && currentDomain !== 'lark') {
        currentBaseUrl = `https://${LARK_AUTH_HOST}`
        currentDomain = 'lark'
        domainSwitched = true
        skipInitialWait = true
        this.commitSnapshot(gen, Object.freeze({
          ...this.snapshot,
          domain: 'lark',
          domainSwitched: true,
          note: '检测到 Lark 国际版账号，已自动切换到国际版授权域，正在继续等待确认…',
        }))
        continue
      }

      if (clientId !== '' && clientSecret !== '') {
        const finalDomain: 'feishu' | 'lark' = pollRes.user_info?.tenant_brand === 'lark'
          ? 'lark'
          : pollRes.user_info?.tenant_brand === 'feishu'
            ? 'feishu'
            : currentDomain
        const switched = domainSwitched || finalDomain !== input.domain
        const rawOpenId = pollRes.user_info?.open_id?.trim() ?? ''
        const openId = rawOpenId !== '' && LARK_OPEN_ID_TOKEN.test(rawOpenId) ? rawOpenId : undefined
        await this.applyAuthorizedApp({
          gen,
          signal: controller.signal,
          runtime: input.runtime,
          appName: input.appName,
          businessTools: input.businessTools,
          appId: clientId,
          appSecret: clientSecret,
          domain: finalDomain,
          domainSwitched: switched,
          ...(openId === undefined ? {} : { openId }),
          account: input.account,
          tenant: input.tenant,
        })
        return
      }

      if (pollRes.error === 'authorization_pending' || pollRes.error === undefined) {
        continue
      }
      if (pollRes.error === 'slow_down') {
        intervalMs = Math.min(MAX_POLL_INTERVAL_MS, intervalMs + SLOW_DOWN_STEP_MS)
        this.commitSnapshot(gen, Object.freeze({
          ...this.snapshot,
          pollIntervalMs: intervalMs,
          note: '飞书要求降低轮询频率，正在继续等待扫码确认…',
        }))
        continue
      }
      if (pollRes.error === 'access_denied') {
        this.commitSnapshot(gen, Object.freeze({
          ...this.snapshot,
          state: 'denied',
          errorCode: 'access_denied',
          note: '你在飞书中取消了应用授权，可随时重新生成二维码。',
        }))
        return
      }
      if (pollRes.error === 'expired_token') {
        this.commitSnapshot(gen, Object.freeze({
          ...this.snapshot,
          state: 'expired',
          errorCode: 'expired_token',
          note: '本次飞书授权二维码已过期，请点击「重新生成二维码」。',
        }))
        return
      }

      const desc = pollRes.error_description ? `：${boundedNote(pollRes.error_description, 240)}` : ''
      this.commitSnapshot(gen, Object.freeze({
        ...this.snapshot,
        state: 'failed',
        errorCode: boundedNote(pollRes.error, 64),
        note: `飞书授权未完成（${boundedNote(pollRes.error, 64)}${desc}）。`,
      }))
      return
    }
  }

  private async applyAuthorizedApp(input: Readonly<{
    gen: number
    signal: AbortSignal
    runtime: FeishuQrRuntimeContext
    appName: string
    businessTools: boolean
    appId: string
    appSecret: string
    domain: 'feishu' | 'lark'
    domainSwitched: boolean
    openId?: string
    account: string
    tenant: string
  }>): Promise<void> {
    if (this.disposed || this.generation !== input.gen || input.signal.aborted) return

    if (!isAppId(input.appId) || input.appId === PLACEHOLDER_LARK_APP_ID) {
      this.commitSnapshot(input.gen, Object.freeze({
        ...this.snapshot,
        state: 'failed',
        domain: input.domain,
        domainSwitched: input.domainSwitched,
        errorCode: 'invalid-app-id',
        applied: false,
        note: '飞书返回的 App ID 格式无效，未写入任何配置。',
      }))
      return
    }
    if (input.appSecret.length > 512 || hasControlChars(input.appSecret) || /[\r\n]/u.test(input.appSecret)) {
      this.commitSnapshot(input.gen, Object.freeze({
        ...this.snapshot,
        state: 'failed',
        domain: input.domain,
        domainSwitched: input.domainSwitched,
        appId: input.appId,
        errorCode: 'invalid-secret',
        applied: false,
        note: '飞书返回的 App Secret 格式无效，未写入任何配置。',
      }))
      return
    }

    this.commitSnapshot(input.gen, Object.freeze({
      ...this.snapshot,
      state: 'applying',
      domain: input.domain,
      domainSwitched: input.domainSwitched,
      appId: input.appId,
      ...(input.openId === undefined ? {} : { openId: input.openId }),
      note: `已收到应用 ${input.appId} 的飞书授权，正在将凭据加密存入系统凭据库并配置通道与权限策略…`,
    }))

    let result: ApplyFeishuVaultResult
    try {
      result = await this.applyVaultFn({
        host: input.runtime.host,
        descriptors: input.runtime.getDescriptors(),
        appId: input.appId,
        appSecret: input.appSecret,
        account: input.account,
        tenant: input.tenant,
        domain: input.domain,
        ...(input.openId === undefined ? {} : { ownerOpenId: input.openId }),
        platform: this.platform,
        ...(this.env === undefined ? {} : { env: this.env }),
        now: this.now(),
        ...(this.storeSecretFn === undefined ? {} : { storeSecretFn: this.storeSecretFn }),
        ...(this.deleteSecretFn === undefined ? {} : { deleteSecretFn: this.deleteSecretFn }),
      })
    } catch (error: unknown) {
      const safeReason = redactSecret(error instanceof Error ? error.message : String(error), input.appSecret)
      this.commitSnapshot(input.gen, Object.freeze({
        ...this.snapshot,
        state: 'failed',
        domain: input.domain,
        domainSwitched: input.domainSwitched,
        appId: input.appId,
        ...(input.openId === undefined ? {} : { openId: input.openId }),
        applied: false,
        errorCode: 'apply-failed',
        note: `写入飞书凭据与通道配置失败：${boundedNote(safeReason, 400)}`,
      }))
      return
    }

    const safeNote = redactSecret(result.note, input.appSecret)
    if (!result.applied) {
      this.commitSnapshot(input.gen, Object.freeze({
        ...this.snapshot,
        state: 'failed',
        domain: result.domain,
        domainSwitched: input.domainSwitched,
        appId: input.appId,
        ...(input.openId === undefined ? {} : { openId: input.openId }),
        ownerBinding: result.ownerBinding,
        applied: false,
        errorCode: 'apply-refused',
        note: boundedNote(safeNote, 1_800),
      }))
      return
    }

    // Never hot-reload credentials-keychain / personal-assistant / lark-channel in-process or trust stale lark health;
    // a profile restart is always required to load the new versioned keychain handle and policy cleanly.
    const connected = false
    const restartRecommended = true
    const env = this.env ?? process.env
    const paths = resolveProfilePaths(input.runtime.host, env)
    const restartInfo = this.inspectRestartFn({
      host: input.runtime.host,
      platform: this.platform,
      env,
    })
    const openPlatformHost = result.domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'
    const openPlatformUrl = `https://${openPlatformHost}/app/${input.appId}`
    const resolvedAccount = result.account ?? (input.account || 'primary')
    const resolvedTenant = result.tenant ?? (input.tenant || 'personal')
    const businessCliCommand = input.businessTools && SETUP_KEY_TOKEN.test(paths.profileName)
      ? `dsh-lark-setup --profile ${paths.profileName} --app-id ${input.appId}`
      : undefined
    const bindingSummary = ownerBindingDetail(result.ownerBinding)
    const finalNote = `飞书一键扫码接入配置已保存（App ID ${input.appId}；${bindingSummary}）。App Secret 已加密存入本机凭据库，通道与策略已写入 cordis.patch.yml；请重启一次 profile（重启 DeepSeek Harness.app 或运行 dsh-ray restart）以加载新凭据句柄与策略并建立新的飞书长连接。`

    this.commitSnapshot(input.gen, Object.freeze({
      ...this.snapshot,
      state: 'completed',
      domain: result.domain,
      domainSwitched: input.domainSwitched,
      appName: input.appName,
      appId: input.appId,
      account: resolvedAccount,
      tenant: resolvedTenant,
      ...(input.openId === undefined ? {} : { openId: input.openId }),
      ownerBinding: result.ownerBinding,
      ...(result.existingAutonomyAnchored === true ? { existingAutonomyAnchored: true } : {}),
      applied: true,
      connected,
      restartRecommended,
      restartSupported: restartInfo.supported,
      restartMode: restartInfo.mode,
      restartCommand: restartInfo.command,
      openPlatformUrl,
      businessToolsRequested: input.businessTools,
      ...(businessCliCommand === undefined ? {} : { businessCliCommand }),
      note: finalNote,
    }))
  }

  private commitSnapshot(gen: number, next: FeishuQrOnboardingSnapshot): FeishuQrOnboardingSnapshot {
    if (this.generation === gen) {
      this.snapshot = next
      if (['completed', 'expired', 'denied', 'cancelled', 'failed'].includes(next.state)) {
        this.activeAbort = undefined
      }
    }
    return this.snapshot
  }

  private failSnapshot(domain: 'feishu' | 'lark', errorCode: string, note: string): FeishuQrOnboardingSnapshot {
    return Object.freeze({
      protocol: PROTOCOL,
      sessionId: '',
      state: 'failed',
      domain,
      domainSwitched: false,
      applied: false,
      errorCode,
      note: boundedNote(note, 1_800),
    })
  }
}
