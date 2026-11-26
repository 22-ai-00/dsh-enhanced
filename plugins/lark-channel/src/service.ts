import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  type AssistantDeliveryService,
  DeliveryAdapterRegistryStoppedError,
  type OwnerSelfIterationControlRequest,
  type OwnerSelfIterationControlResult,
} from '@dsh-ray/assistant-delivery'
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { LarkDeliveryAdapter } from './adapter.js'
import { Config } from './config.js'
import { createOfficialLarkTransport, type OfficialLarkTransportOptions } from './sdk.js'
import { withDshHomeLifecycleLock } from './setup.js'
import type { LarkChannelHealth, LarkTransport } from './types.js'

const execFileAsync = promisify(execFile)
const requireOptionalPeer = createRequire(import.meta.url)

const SELF_ITERATION_TOGGLE_SPECS = [
  { rowId: 'dsh-ray-assistant-work-items', pkgName: '@dsh-ray/assistant-work-items' },
  { rowId: 'dsh-ray-assistant-proactive', pkgName: '@dsh-ray/assistant-proactive' },
  { rowId: 'dsh-ray-assistant-growth-driver', pkgName: '@dsh-ray/assistant-growth-driver' },
  { rowId: 'dsh-ray-assistant-dreaming', pkgName: '@dsh-ray/assistant-dreaming' },
  { rowId: 'dsh-ray-assistant-memory-learning', pkgName: '@dsh-ray/assistant-memory-learning' },
  { rowId: 'dsh-ray-assistant-association', pkgName: '@dsh-ray/assistant-association' },
  { rowId: 'dsh-ray-assistant-evaluation', pkgName: '@dsh-ray/assistant-evaluation' },
  { rowId: 'dsh-ray-assistant-evolution', pkgName: '@dsh-ray/assistant-evolution' },
  { rowId: 'dsh-ray-preference-learning', pkgName: '@dsh-ray/preference-learning' },
] as const

const SELF_ITERATION_TOGGLE_BY_ID = new Map<string, (typeof SELF_ITERATION_TOGGLE_SPECS)[number]>(
  SELF_ITERATION_TOGGLE_SPECS.map(spec => [spec.rowId, spec]),
)
const SELF_ITERATION_TOGGLE_BY_PKG = new Map<string, (typeof SELF_ITERATION_TOGGLE_SPECS)[number]>(
  SELF_ITERATION_TOGGLE_SPECS.map(spec => [spec.pkgName, spec]),
)

const PROTECTED_CONTROL_ROW_IDS = new Set([
  'dsh-ray-assistant-web-owner',
  'dsh-ray-owner-console',
  'dsh-ray-lark-channel',
  'dsh-ray-assistant-delivery',
  'dsh-ray-personal-assistant',
  'dsh-ray-assistant-policy',
  'dsh-ray-assistant-goals',
])

const PROTECTED_CONTROL_PACKAGE_NAMES = new Set([
  '@dsh-ray/assistant-web-owner',
  '@dsh-ray/owner-console',
  '@dsh-ray/lark-channel',
  '@dsh-ray/assistant-delivery',
  '@dsh-ray/personal-assistant',
  '@dsh-ray/assistant-policy',
  '@dsh-ray/assistant-goals',
])

const DREAMING_REQUIRED_STRING_FIELDS = ['provider', 'model', 'budgetId'] as const
const DREAMING_REQUIRED_SCOPE_FIELDS = ['preset', 'principalId', 'ownerRouteId'] as const
const DREAMING_MAX_BUDGET_AMOUNT = 10_000_000
const PATCH_CUSTOM_TAGS = [
  { tag: '!js', resolve: (value: string) => value },
  { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value },
]

function isYamlJsTag(tag: string | undefined): boolean {
  return tag === '!js' || tag === 'tag:yaml.org,2002:js'
}

function isNonEmptyPlainStringNode(node: unknown): boolean {
  if (isScalar(node)) {
    if (isYamlJsTag(node.tag)) return false
    return typeof node.value === 'string' && node.value.trim().length > 0
  }
  return typeof node === 'string' && node.trim().length > 0
}

function isCanonicalAbsolutePathOrJsNode(node: unknown): boolean {
  if (isScalar(node)) {
    if (isYamlJsTag(node.tag)) {
      return typeof node.value === 'string' && node.value.trim().length > 0
    }
    const val = node.value
    return typeof val === 'string' && val.length >= 1 && isAbsolute(val) && resolve(val) === val
  }
  return typeof node === 'string' && node.length >= 1 && isAbsolute(node) && resolve(node) === node
}

function hasDreamingRequiredFields(config: YAMLMap): boolean {
  const scopeNode = config.get('scope', true)
  if (!isMap(scopeNode)) return false
  if (!isCanonicalAbsolutePathOrJsNode(scopeNode.get('workspace', true))) return false
  for (const subKey of DREAMING_REQUIRED_SCOPE_FIELDS) {
    if (!isNonEmptyPlainStringNode(scopeNode.get(subKey, true))) return false
  }
  if (!isCanonicalAbsolutePathOrJsNode(config.get('databasePath', true))) return false
  for (const field of DREAMING_REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyPlainStringNode(config.get(field, true))) return false
  }
  const budgetNode = config.get('budgetAmount', true)
  const budgetAmount = isScalar(budgetNode)
    ? (isYamlJsTag(budgetNode.tag) ? undefined : budgetNode.value)
    : budgetNode
  return typeof budgetAmount === 'number'
    && Number.isSafeInteger(budgetAmount)
    && budgetAmount >= 1
    && budgetAmount <= DREAMING_MAX_BUDGET_AMOUNT
}

export interface LarkChannelServiceOptions {
  env?: Readonly<Record<string, string | undefined>>
  createTransport?: (options: OfficialLarkTransportOptions) => LarkTransport
  writeLifecycleMarker?: (marker: LarkLifecycleMarker) => void
  dshHome?: string
  profile?: string
  runUpgrade?: (
    options: Readonly<{ dshHome: string; profile: string }>,
  ) => Promise<OwnerSelfIterationControlResult>
}

export type LarkLifecycleMarker = 'lark-channel: connected' | 'lark-channel: disconnected'

/** Emit one exact marker to stdout so systemd captures it in this Invocation's journal. */
export function writeLarkLifecycleMarker(marker: LarkLifecycleMarker): void {
  console.info(marker)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    larkChannel: LarkChannelService
  }
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

interface CredentialLeaseService {
  withSecret<T>(
    caller: Context,
    request: { handleId: string; purpose: string; ttlMs: number; idempotencyKey: string },
    callback: (value: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T>
}

function credentialLeaseAbortCode(reason: unknown): 'disposed' | 'expired' | 'revoked' | undefined {
  if (reason === null || typeof reason !== 'object') return undefined
  const value = reason as { name?: unknown; code?: unknown }
  if (value.name !== 'CredentialLeaseAbortError') return undefined
  return value.code === 'disposed' || value.code === 'expired' || value.code === 'revoked'
    ? value.code
    : undefined
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function waitForAbort(signals: readonly AbortSignal[]): Promise<void> {
  if (signals.some(signal => signal.aborted)) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      for (const signal of signals) signal.removeEventListener('abort', done)
      resolve()
    }
    for (const signal of signals) signal.addEventListener('abort', done, { once: true })
  })
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export class LarkChannelService extends Service {
  static Config = Config

  private readonly ready = deferred()
  private readonly stopController = new AbortController()
  private readonly lifecycle: Promise<void>
  private adapter: LarkDeliveryAdapter | undefined
  private transport: LarkTransport | undefined
  private transportSignal: AbortSignal | undefined
  private readonly allowedCalendarIds: ReadonlySet<string>
  private disabled = false
  private active = true
  private startupFailed = false

  constructor(ctx: Context, input: import('./config.js').Config, options: LarkChannelServiceOptions = {}) {
    super(ctx, 'larkChannel')
    const delivery = ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    if (delivery === undefined) throw new Error('lark-channel: assistantDelivery service is required')
    const config = Config(input) as Required<Omit<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>>
      & Pick<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>
    this.allowedCalendarIds = new Set(config.allowedCalendarIds)
    if (!config.enabled) {
      this.disabled = true
      this.lifecycle = Promise.resolve()
      this.ready.resolve()
      ctx.effect(() => () => { this.active = false }, 'lark-channel.disabled')
      return
    }
    const createTransport = options.createTransport ?? createOfficialLarkTransport
    const lifecycleMarker = options.writeLifecycleMarker ?? writeLarkLifecycleMarker
    if (typeof (delivery as { registerOwnerSelfIterationHandler?: unknown }).registerOwnerSelfIterationHandler === 'function') {
      ctx.effect(() => delivery.registerOwnerSelfIterationHandler!(
        request => this.handleOwnerSelfIterationControl(ctx, delivery, request, options),
      ), 'lark-channel.self-iteration-control')
    }
    if (config.credentialHandle !== undefined) {
      const credentials = ctx.get('credentialsKeychain') as CredentialLeaseService | undefined
      if (credentials === undefined) {
        throw new Error('lark-channel: credentialsKeychain service is required for credentialHandle')
      }
      this.lifecycle = this.runCredentialLifecycle(
        ctx, credentials, delivery, config, createTransport, lifecycleMarker,
      )
    } else {
      const envName = config.appSecretEnv
      const appSecret = envName === undefined ? undefined : (options.env ?? process.env)[envName]
      if (appSecret === undefined || appSecret.trim().length === 0) {
        throw new Error(`lark-channel: secret environment variable ${String(envName)} is missing or empty`)
      }
      this.lifecycle = this.runAdapter(delivery, config, createTransport, appSecret, undefined, lifecycleMarker)
    }
    void this.lifecycle.catch(error => this.rejectReady(error))
    ctx.effect(() => async () => {
      this.active = false
      // Teardown can reject an unobserved readiness promise while the Host is
      // already unwinding. Observe only this disposal race; genuine startup
      // failures before disposal must remain visible to the Host.
      if (!this.startupFailed) void this.ready.promise.catch(() => {})
      this.stopController.abort(new Error('lark-channel stopped'))
      await this.lifecycle.catch(() => {})
    }, 'lark-channel.transport')
  }

  async whenReady(): Promise<void> {
    this.assertActive()
    await this.ready.promise
  }

  health(): LarkChannelHealth {
    this.assertActive()
    return this.adapter?.health() ?? {
      state: this.disabled ? 'disabled' : this.stopController.signal.aborted ? 'disconnected' : 'connecting',
      gapGeneration: 0,
    }
  }

  /** Read one exact Calendar v4 page without disclosing the app credential. */
  async readCalendarEventPage(input: Readonly<{
    calendarId: string
    startTime: number
    endTime: number
    pageSize: number
    pageToken?: string
    signal: AbortSignal
  }>): Promise<unknown> {
    this.assertActive()
    this.assertCalendarAccess(input.calendarId)
    await awaitWithAbort(this.ready.promise, AbortSignal.any([input.signal, this.stopController.signal]))
    this.assertActive()
    this.assertCalendarAccess(input.calendarId)
    if (input.signal.aborted) throw input.signal.reason
    const transport = this.transport, transportSignal = this.transportSignal
    if (transport?.readCalendarEventPage === undefined || transportSignal === undefined) {
      throw new Error('lark-channel: Calendar v4 read capability is unavailable')
    }
    const signal = AbortSignal.any([input.signal, this.stopController.signal, transportSignal])
    signal.throwIfAborted()
    const result = await transport.readCalendarEventPage({ ...input, signal })
    signal.throwIfAborted()
    if (this.transport !== transport || this.transportSignal !== transportSignal) throw new Error('lark-channel: Calendar credential generation ended')
    this.assertActive()
    this.assertCalendarAccess(input.calendarId)
    if (input.signal.aborted) throw input.signal.reason
    return result
  }

  private async runAdapter(
    delivery: AssistantDeliveryService,
    config: Required<Omit<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>>
      & Pick<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>,
    createTransport: (options: OfficialLarkTransportOptions) => LarkTransport,
    appSecret: string,
    credentialSignal?: AbortSignal,
    lifecycleMarker: (marker: LarkLifecycleMarker) => void = writeLarkLifecycleMarker,
  ): Promise<void> {
    const transport = createTransport({
      appId: config.appId,
      appSecret,
      domain: config.domain,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      imageDownloadTimeoutMs: config.imageDownloadTimeoutMs,
    })
    const generation = new AbortController()
    this.transportSignal = AbortSignal.any([generation.signal, this.stopController.signal, ...(credentialSignal ? [credentialSignal] : [])])
    this.transport = transport
    const adapter = new LarkDeliveryAdapter({
      account: config.account,
      tenant: config.tenant,
      requireMentionInGroups: config.requireMentionInGroups,
      groupTopicThreads: config.groupTopicThreads,
      maxTextBytes: config.maxTextBytes,
      staleAfterMs: config.staleAfterMs,
    }, transport, {
      // These exact stdout markers are consumed from one fresh systemd
      // Invocation journal. Cordis' built-in logger only buffers unless a
      // console exporter is installed, so it cannot be the readiness source.
      onConnected: () => lifecycleMarker('lark-channel: connected'),
      onDisconnected: () => lifecycleMarker('lark-channel: disconnected'),
      approvalSecret: appSecret,
      progressCredentialFingerprint: createHash('sha256')
        .update(JSON.stringify([config.appId, config.domain, appSecret])).digest('hex'),
      showProgress: config.showProgress,
      progressDetails: config.progressDetails,
      showBackgroundProgress: config.showBackgroundProgress,
      statusReactions: config.statusReactions,
      userQuestionTtlMs: config.userQuestionTtlMs,
      settleApproval: value => delivery.settleApproval(value),
      recoverApprovalSettlement: value => delivery.recoverApprovalSettlement(value),
      settleModelSelection: value => delivery.settleModelSelection(value),
      awaitModelSelection: (value, signal) => delivery.awaitModelSelection(value, signal),
      settlePermissionSelection: value => delivery.settlePermissionSelection(value),
      loadModelPicker: value => delivery.getModelPickerForCallback(value),
      advanceModelPicker: value => delivery.advanceModelPickerForCallback(value),
    })
    this.adapter = adapter
    let unregister: (() => Promise<void>) | undefined
    try {
      unregister = await delivery.registerAdapter(adapter)
      this.ready.resolve()
      await waitForAbort(credentialSignal === undefined
        ? [this.stopController.signal]
        : [this.stopController.signal, credentialSignal])
    } catch (error) {
      // A stopped registry means the whole plugin tree is tearing down (often
      // because an earlier plugin failed to load, e.g. the web server hit
      // EADDRINUSE). Registering our adapter into that teardown is not the real
      // failure, so do not re-throw it as this service's fatal cause and mask
      // the true one; settle ready and unwind quietly.
      if (error instanceof DeliveryAdapterRegistryStoppedError) {
        this.ready.resolve()
        return
      }
      this.rejectReady(error)
      throw error
    } finally {
      generation.abort(new Error('lark-channel credential generation ended'))
      if (this.transport === transport) { this.transport = undefined; this.transportSignal = undefined }
      await unregister?.()
    }
  }

  private async runCredentialLifecycle(
    ctx: Context,
    credentials: CredentialLeaseService,
    delivery: AssistantDeliveryService,
    config: Required<Omit<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>>
      & Pick<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>,
    createTransport: (options: OfficialLarkTransportOptions) => LarkTransport,
    lifecycleMarker: (marker: LarkLifecycleMarker) => void,
  ): Promise<void> {
    while (!this.stopController.signal.aborted) {
      let renew = false
      await credentials.withSecret(ctx, {
        handleId: config.credentialHandle!,
        purpose: config.credentialPurpose,
        ttlMs: config.credentialLeaseMs,
        idempotencyKey: `lark-channel:${config.account}:lease:${randomUUID()}`,
      }, async (appSecret, credentialSignal) => {
        await this.runAdapter(delivery, config, createTransport, appSecret, credentialSignal, lifecycleMarker)
        renew = credentialSignal.aborted && credentialLeaseAbortCode(credentialSignal.reason) === 'expired'
      })
      if (!renew) return
    }
  }

  private assertActive(): void {
    if (!this.active) throw new Error('lark-channel service is disposed')
  }

  private rejectReady(error: unknown): void {
    if (this.active && !this.stopController.signal.aborted) this.startupFailed = true
    this.ready.reject(error)
  }

  private assertCalendarAccess(calendarId: string): void {
    if (!this.allowedCalendarIds.has(calendarId)) {
      throw new Error('lark-channel: Calendar ID is not explicitly authorized')
    }
  }

  private async handleOwnerSelfIterationControl(
    ctx: Context,
    delivery: AssistantDeliveryService,
    request: Readonly<OwnerSelfIterationControlRequest>,
    options: LarkChannelServiceOptions,
  ): Promise<OwnerSelfIterationControlResult> {
    const ownerConsole = ctx.get('ownerConsole' as never) as Readonly<{
      controlSelfIteration?: (
        action: OwnerSelfIterationControlRequest['action'],
        confirmed: boolean,
      ) => Promise<Readonly<{
        ok: boolean
        state?: 'enabled' | 'disabled' | 'upgraded'
        error?: string
        reason?: string
        note?: string
        message?: string
      }>>
      handleControlAction?: (req: Readonly<Record<string, unknown>>) => Promise<OwnerSelfIterationControlResult>
    }> | undefined
    if (typeof ownerConsole?.controlSelfIteration === 'function') {
      const result = await ownerConsole.controlSelfIteration(request.action, true)
      const message = result.note ?? result.message
      return {
        ok: result.ok,
        ...(result.state === undefined ? {} : { state: result.state }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(message === undefined ? {} : { message }),
      }
    }
    if (typeof ownerConsole?.handleControlAction === 'function') {
      return await ownerConsole.handleControlAction(Object.freeze({
        ownerAuthorized: true,
        action: request.action,
      }))
    }
    const env = options.env ?? process.env
    const reloadProfilePath = (delivery as unknown as { config?: { inProcessReload?: { profilePath?: string } } })
      .config?.inProcessReload?.profilePath
    const inferred = typeof reloadProfilePath === 'string' && isAbsolute(reloadProfilePath)
      && basename(dirname(reloadProfilePath)) === 'profiles'
      ? { dshHome: dirname(dirname(reloadProfilePath)), profile: basename(reloadProfilePath) }
      : undefined
    const dshHome = options.dshHome ?? env.DSH_HOME ?? inferred?.dshHome
    const profile = options.profile ?? env.DSH_PROFILE ?? inferred?.profile
    if (!dshHome || !isAbsolute(dshHome) || !profile || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) {
      return {
        ok: false,
        error: '未配置有效的 DSH_HOME 或 profile，且当前未加载 ownerConsole；本次自迭代控制未执行。',
        reason: 'control-target-unconfigured',
      }
    }
    if (request.action === 'enableSelfIteration' || request.action === 'disableSelfIteration') {
      return await applySelfIterationProfileToggle({
        dshHome,
        profile,
        enable: request.action === 'enableSelfIteration',
      })
    }
    if (typeof options.runUpgrade === 'function') {
      return await options.runUpgrade({ dshHome, profile })
    }
    return await runDefaultAssistantUpgrade({ dshHome, profile, env })
  }
}

async function atomicWriteControlPatch(path: string, value: string): Promise<void> {
  const temporary = join(dirname(path),
    `.cordis.patch.yml.lark-control-${process.pid}-${randomBytes(8).toString('hex')}`)
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
    const dir = await open(dirname(path), 'r')
    try { await dir.sync() }
    finally { await dir.close() }
  } catch (error) {
    if (created) await rm(temporary, { force: true })
    throw error
  }
}

async function assertRealNonSymlinkDirectory(targetPath: string, label: string): Promise<void> {
  const st = await lstat(targetPath)
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${label} 必须是真实目录（禁止符号链接）：${targetPath}`)
  }
}

async function assertRealNonSymlinkFile(targetPath: string, label: string): Promise<void> {
  const st = await lstat(targetPath)
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`${label} 必须是普通文件（禁止符号链接）：${targetPath}`)
  }
}

/** Toggle Contract 1 self-iteration rows in `cordis.patch.yml` while leaving protected rows & ownerRoutes intact. */
export async function applySelfIterationProfileToggle(input: Readonly<{
  dshHome: string
  profile: string
  enable: boolean
}>): Promise<OwnerSelfIterationControlResult> {
  if (!isAbsolute(input.dshHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile)) {
    return { ok: false, error: '无效的 dshHome 或 profile。', reason: 'invalid-target' }
  }
  const resolvedHome = resolve(input.dshHome)
  try {
    await assertRealNonSymlinkDirectory(resolvedHome, 'dshHome')
    const canonicalHome = await realpath(resolvedHome)
    return await withDshHomeLifecycleLock(canonicalHome, async () => {
      const profilesDir = join(canonicalHome, 'profiles')
      await assertRealNonSymlinkDirectory(profilesDir, 'profiles 目录')
      const profileDir = join(profilesDir, input.profile)
      await assertRealNonSymlinkDirectory(profileDir, `profile 目录 (${input.profile})`)
      const patchPath = join(profileDir, 'cordis.patch.yml')
      await assertRealNonSymlinkFile(patchPath, 'cordis.patch.yml')
      const source = await readFile(patchPath, 'utf8')
      const document = parseDocument(source, { uniqueKeys: true, customTags: PATCH_CUSTOM_TAGS })
      if (document.errors.length > 0 || !isSeq(document.contents)) {
        return { ok: false, error: '目标 profile 的 cordis.patch.yml 格式无效，已中止修改。', reason: 'invalid-patch' }
      }
      const rowsToToggle: Array<{ row: YAMLMap; rowId: string }> = []
      const seen = new Set<YAMLMap>()
      const collectRow = (candidate: unknown) => {
        if (!isMap(candidate) || seen.has(candidate)) return
        const id = candidate.get('id')
        const name = candidate.get('name')
        if (typeof id === 'string' && PROTECTED_CONTROL_ROW_IDS.has(id)) return
        if (typeof name === 'string' && PROTECTED_CONTROL_PACKAGE_NAMES.has(name)) return
        const spec = (typeof id === 'string' ? SELF_ITERATION_TOGGLE_BY_ID.get(id) : undefined)
          ?? (typeof name === 'string' ? SELF_ITERATION_TOGGLE_BY_PKG.get(name) : undefined)
        if (spec === undefined) return
        seen.add(candidate)
        rowsToToggle.push({ row: candidate, rowId: spec.rowId })
      }
      for (const item of document.contents.items) {
        collectRow(item)
        if (isMap(item)) {
          const inserted = item.get('insert', true)
          if (isSeq(inserted)) {
            for (const sub of inserted.items) collectRow(sub)
          }
        }
      }
      let updatedCount = 0
      for (const { row, rowId } of rowsToToggle) {
        updatedCount += 1
        const cfg = row.get('config', true)
        if (input.enable) {
          row.delete('disabled')
          if (isMap(cfg)) {
            const cfgMap = cfg as YAMLMap
            if (rowId === 'dsh-ray-assistant-dreaming') {
              if (hasDreamingRequiredFields(cfgMap)) {
                cfgMap.set('enabled', true)
              }
              if (cfgMap.has('retired')) {
                cfgMap.delete('retired')
              }
            } else if (cfgMap.get('enabled') === false || rowId === 'dsh-ray-assistant-work-items') {
              cfgMap.set('enabled', true)
            }
          } else if (rowId === 'dsh-ray-assistant-work-items') {
            row.set('config', document.createNode({ enabled: true }))
          }
        } else {
          row.set('disabled', true)
          if (isMap(cfg)) {
            if (rowId === 'dsh-ray-assistant-work-items' || cfg.has('enabled')) {
              (cfg as YAMLMap).set('enabled', false)
            }
          } else if (rowId === 'dsh-ray-assistant-work-items') {
            row.set('config', document.createNode({ enabled: false }))
          }
        }
      }
      if (updatedCount === 0) {
        return { ok: false, error: '目标 profile 中未找到可切换的自迭代组件配置。', reason: 'no-toggle-targets' }
      }
      await assertRealNonSymlinkFile(patchPath, 'cordis.patch.yml')
      await atomicWriteControlPatch(patchPath, document.toString({ lineWidth: 0 }))
      return {
        ok: true,
        state: input.enable ? 'enabled' : 'disabled',
        message: input.enable
          ? `已开启 profile ${input.profile} 的自迭代能力（更新 ${updatedCount} 项配置，受保护交互与路由保持不变）。`
          : `已关闭 profile ${input.profile} 的自迭代能力（更新 ${updatedCount} 项配置，受保护交互与路由保持可用）。`,
      }
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      reason: 'toggle-failed',
    }
  }
}

async function runDefaultAssistantUpgrade(input: Readonly<{
  dshHome: string
  profile: string
  env: Readonly<Record<string, string | undefined>>
}>): Promise<OwnerSelfIterationControlResult> {
  try {
    const cliPath = requireOptionalPeer.resolve('@dsh-ray/cli')
    const cliMod = await import(cliPath) as {
      upgradeAssistantAndRecover?: (opts: Record<string, unknown>) => Promise<{
        ok: boolean
        healthy?: boolean
        upgraded?: boolean
        restarted?: boolean
        error?: string
      }>
    }
    if (typeof cliMod.upgradeAssistantAndRecover === 'function') {
      const outcome = await cliMod.upgradeAssistantAndRecover({
        dshHome: input.dshHome,
        profile: input.profile,
        yes: true,
        env: input.env,
      })
      if (outcome.ok && outcome.healthy !== false) {
        return {
          ok: true,
          state: 'upgraded',
          message: `已完成 profile ${input.profile} 的整体助手升级、健康检查与恢复。`,
        }
      }
      return {
        ok: false,
        error: outcome.error ?? '升级或健康检查未通过，服务未处于健康就绪状态。',
        reason: 'upgrade-unhealthy',
      }
    }
  } catch {
    // Fall back to invoking `dsh-ray` CLI executable when programmatic import is unavailable.
  }
  try {
    const { stdout } = await execFileAsync(
      'dsh-ray',
      ['upgrade', '--profile', input.profile, '--dsh-home', input.dshHome, '--yes', '--json'],
      { env: input.env as NodeJS.ProcessEnv, timeout: 120_000 },
    )
    const parsed = JSON.parse(stdout.trim() || '{}') as { ok?: boolean; healthy?: boolean; error?: string }
    if (parsed.ok === true && parsed.healthy !== false) {
      return {
        ok: true,
        state: 'upgraded',
        message: `已完成 profile ${input.profile} 的整体助手升级、健康检查与恢复。`,
      }
    }
    return {
      ok: false,
      error: parsed.error ?? 'dsh-ray upgrade 未返回健康就绪状态。',
      reason: 'upgrade-failed',
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      reason: 'upgrade-command-failed',
    }
  }
}

export const LarkConfig = Config
