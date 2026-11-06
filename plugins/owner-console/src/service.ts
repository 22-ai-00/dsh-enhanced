import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OwnerConsoleConfig } from './index.js'
import {
  boundedConfig, configFacts, findEntry, isAppId, isEntryId, isEnvName, isProjectBundle, isProjectPackage, isSecretRef,
  type BundleInfoLike, type ChangeResultLike, type LoaderService, type PluginInfoLike, type PluginManagerService,
  type SettingsDescriptor, type SettingsPathOp, type SettingsService,
} from './settings.js'
import {
  INTAKE_AGREEMENT_LEVELS, INTAKE_AGREEMENT_OUTCOMES, LARK_CONNECTIONS, LARK_ERROR_CODES, OwnerConsoleIntakeAgreementSchema,
  OwnerConsoleTrendSnapshotsSchema, TREND_SNAPSHOT_PAGE_MAX,
  type OwnerConsoleIntakeAgreement, type OwnerConsoleStatus, type OwnerConsoleTrendSnapshots, type OwnerConsoleWriteResult,
} from './typert.js'

/** Companions worth surfacing; a missing one is a setup hint, never a hard failure. */
const DEPENDENCIES = ['assistantPolicy', 'assistantDelivery', 'assistantSkills'] as const
const LARK = /(^|[-_/])lark(-channel)?($|[-_/])/u
const TRAEX = /traex/iu
const APP_ID_ENV = ['LARK_APP_ID', 'FEISHU_APP_ID'] as const
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u

/** Read-only status plus owner-clicked, one-step writes through the Host settings service.
 * Only `.volatile()` config fields are editable by that service; every write addresses one
 * entry, uses CAS on its revision, and returns a business reason instead of throwing. */
export class OwnerConsoleService extends TypertRemoteService {
  private readonly host: Context

  constructor(ctx: Context, private readonly config: OwnerConsoleConfig) {
    super(ctx, 'ownerConsole')
    this.host = ctx
  }

  private settings(): SettingsService {
    const settings = this.host.get('settings' as never) as SettingsService | undefined
    if (settings === undefined) throw new Error('Host settings service is unavailable; this console cannot edit configuration')
    return settings
  }

  private descriptors(): readonly SettingsDescriptor[] {
    const settings = this.host.get('settings' as never) as SettingsService | undefined
    return settings?.describe({ redactSecrets: true }) ?? []
  }

  /** Volatile edits update the running fiber references but never re-run apply.
   * A one-step write therefore restarts just this entry with its persisted raw
   * config, so the connector or provider rebuilds from the new plain values. */
  private async reload(entryId: string): Promise<string> {
    const loader = this.host.get('loader' as never) as LoaderService | undefined
    if (loader === undefined) return '；已保存，但 loader 不可用，重启 profile 后生效'
    try {
      const entry = [...loader.entries()].find(candidate => candidate.options.id === entryId || candidate.id === entryId)
      if (entry === undefined) return '；已保存，但未找到该 profile 条目，重启 profile 后生效'
      if (entry.fiber === undefined) {
        await entry.refresh()
        return '；条目已重新加载'
      }
      entry.fiber.update(entry.options.config, true)
      return '；条目已重新加载'
    } catch {
      return '；已保存，但自动重载失败，请重启 profile 后生效'
    }
  }

  private manager(): PluginManagerService {
    const manager = this.host.get('pluginManager' as never) as PluginManagerService | undefined
    if (manager === undefined) throw new Error('Host plugin manager is unavailable; this console cannot manage bundles')
    return manager
  }

  private async inventory(): Promise<Readonly<{ bundles: readonly BundleInfoLike[], plugins: readonly PluginInfoLike[] }>> {
    const manager = this.host.get('pluginManager' as never) as PluginManagerService | undefined
    if (manager === undefined) return Object.freeze({ bundles: [], plugins: [] })
    const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()])
    return Object.freeze({
      // A dependency row without a bundle patch (`not-bundle`) is not manageable here.
      bundles: Object.freeze(bundles.filter(bundle => isProjectPackage(bundle.name) && bundle.error === undefined)),
      plugins: Object.freeze(plugins.filter(plugin => isProjectPackage(plugin.moduleName))),
    })
  }

  async status(): Promise<OwnerConsoleStatus> {
    const entries = this.descriptors()
    const inventory = await this.inventory()
    const lark = findEntry(entries, ns => LARK.test(ns))
    const traex = findEntry(entries, ns => TRAEX.test(ns))
    const larkValue = configFacts(lark?.value)
    const traexValue = configFacts(traex?.value)
    const installed = (name: string) => inventory.bundles.some(bundle =>
      bundle.name === name && bundle.installed && bundle.error === undefined)
    const larkHealth = readLarkHealth(this.host.get('larkChannel' as never))
    return Object.freeze({
      feishu: Object.freeze({
        ...(lark === undefined ? {} : { entry: lark.ns }),
        mode: larkValue['secretSource'] === 'handle' || (larkValue['secretSource'] === undefined && typeof larkValue['credentialHandle'] === 'string') ? 'handle' : 'env',
        installed: installed('@dsh-enhanced/lark-channel'),
        enabled: larkValue['enabled'] === true,
        appIdConfigured: isAppId(larkValue['appId']),
        ...larkHealth,
      }),
      traex: Object.freeze({
        ...(traex === undefined ? {} : { entry: traex.ns }),
        installed: installed('@dsh-enhanced/traex-acp-provider'),
        enabled: traexValue['enabled'] === true,
        command: typeof traexValue['command'] === 'string' ? traexValue['command'] : '',
      }),
      dependencies: Object.freeze(DEPENDENCIES.map(name => Object.freeze({
        name, available: this.host.get(name as never) !== undefined,
      }))),
      bundles: Object.freeze(inventory.bundles.map(bundle => Object.freeze({
        name: bundle.name,
        ...(bundle.version === undefined ? {} : { version: bundle.version }),
        enabled: bundle.enabled,
        installed: bundle.installed,
        removable: bundle.removable,
      }))),
      plugins: Object.freeze(inventory.plugins.map(plugin => Object.freeze({
        entryId: plugin.entryId,
        moduleName: plugin.moduleName,
        enabled: plugin.enabled,
        fiberPhase: plugin.fiberPhase,
      }))),
    })
  }

  /** Read-only page of sealed ordinary-use trend snapshots from the control plane. It never seals,
   * so viewing cannot change the ledger; `planId: ''` lists every plan and `beforeSequence: 0` starts
   * at the newest row. Any refusal or tampered row is reported as `unverifiable`, never repaired. */
  async trendSnapshots(planId: string, beforeSequence: number, limit: number): Promise<OwnerConsoleTrendSnapshots> {
    return readTrendSnapshots(this.host.get('pluginControlPlane' as never), planId, beforeSequence, limit)
  }

  /** Read-only agreement between intake judgments and owner notification outcomes for one exact
   * Evaluation scope (workspace + preset), over Evaluation's default window. It never writes, adopts
   * or sends; a disabled switch is reported as `disabled`, any refusal or odd shape as `unverifiable`. */
  async intakeAgreement(workspace: string, preset: string): Promise<OwnerConsoleIntakeAgreement> {
    return readIntakeAgreement(this.host.get('assistantEvaluation' as never), workspace, preset)
  }

  /** Select or remove one installed project bundle layer; dependencies stay installed. */
  async setBundleEnabled(name: string, enabled: boolean): Promise<OwnerConsoleWriteResult> {
    if (!isProjectPackage(name)) return refuse('', '只允许管理本项目的 @dsh-enhanced/* bundle')
    return applyChange(this.manager(), await this.manager().setBundleEnabled(name, enabled))
  }

  /** Enable or disable one loaded entry of a project bundle. */
  async setPluginEnabled(entryId: string, enabled: boolean): Promise<OwnerConsoleWriteResult> {
    const manager = this.manager()
    if (entryId.trim() === '') return refuse('', 'entryId 不能为空')
    const inventory = await this.inventory()
    const entry = inventory.plugins.find(plugin => plugin.entryId === entryId)
    if (entry === undefined) return refuse(entryId, '该条目不属于本项目的插件，或尚未安装')
    return applyChange(manager, await manager.setPluginEnabled(entryId, enabled))
  }

  /** Remove one project bundle layer after the owner confirms the destructive step. */
  async removeProjectBundle(name: string): Promise<OwnerConsoleWriteResult> {
    if (!isProjectPackage(name)) return refuse('', '只允许移除本项目的 @dsh-enhanced/* bundle')
    return applyChange(this.manager(), await this.manager().removeBundle(name))
  }

  /** Install one project bundle with its declared dependencies, then activate it. */
  async installProjectBundle(spec: string): Promise<OwnerConsoleWriteResult> {
    const trimmed = spec.trim()
    if (!isProjectPackage(trimmed)) {
      return refuse('', '只允许安装本项目的 @dsh-enhanced/<name> 包；本地路径和 git 地址不在此面板处理')
    }
    return applyChange(this.manager(), await this.manager().installBundle(trimmed, { enabled: true, saveExact: true }))
  }

  /** Feishu: one owner click, two ways to pair the bot. No plaintext secret is ever accepted. */
  async configureFeishu(appId: string, appSecretEnv: string, credentialHandle: string,
    account: string, tenant: string, discoverAppId: boolean): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    const lark = findEntry(this.descriptors(), ns => LARK.test(ns))
    if (lark === undefined) {
      return refuse('', 'lark-channel 未安装，或它没有声明任何可实时修改的配置字段')
    }
    const current = configFacts(lark.value)
    const configured = isAppId(this.config.feishuAppId) ? this.config.feishuAppId : undefined
    const discovered = appId.trim() === '' && discoverAppId
      ? APP_ID_ENV.map(name => process.env[name]).find(value => isAppId(value)) ?? configured
      : undefined
    const resolvedAppId = appId.trim() === '' ? discovered : appId.trim()
    if (!isAppId(resolvedAppId)) {
      return refuse(lark.ns, discoverAppId
        ? '一键模式需要 Host 环境中的 LARK_APP_ID 或 FEISHU_APP_ID；否则请填写 appId'
        : 'appId 必须形如 cli_0123456789abcdef')
    }
    const envName = appSecretEnv.trim()
    const handle = credentialHandle.trim()
    if ((envName === '') === (handle === '')) {
      return refuse(lark.ns, 'secret 引用必须二选一：环境变量名或 keychain handle')
    }
    if (envName !== '' && !isEnvName(envName)) return refuse(lark.ns, 'appSecretEnv 必须是环境变量名')
    if (handle !== '' && !isSecretRef(handle)) return refuse(lark.ns, 'credentialHandle 格式无效')
    if (envName !== '' && process.env[envName] === undefined) {
      return refuse(lark.ns, `Host 进程中不存在环境变量 ${envName}；请先设置它，或改用 keychain handle`)
    }
    if (handle !== '' && this.host.get('credentialsKeychain' as never) === undefined) {
      return refuse(lark.ns, 'credentials-keychain 未加载；无法引用 keychain secret')
    }
    const resolvedAccount = account.trim() === '' ? current['account'] : account.trim()
    const resolvedTenant = tenant.trim() === '' ? current['tenant'] : tenant.trim()
    if (typeof resolvedAccount !== 'string' || !ACCOUNT.test(resolvedAccount)) {
      return refuse(lark.ns, 'account 缺失或格式无效；请填写当前 owner 的 account，避免更换身份')
    }
    if (typeof resolvedTenant !== 'string' || !ACCOUNT.test(resolvedTenant)) {
      return refuse(lark.ns, 'tenant 缺失或格式无效；请填写当前 owner 的 tenant，避免更换身份')
    }
    await settings.mutate(lark.ns, [
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['appId'], value: resolvedAppId },
      { op: 'set', path: ['account'], value: resolvedAccount },
      { op: 'set', path: ['tenant'], value: resolvedTenant },
      envName === '' ? { op: 'unset', path: ['appSecretEnv'] } : { op: 'set', path: ['appSecretEnv'], value: envName },
      { op: 'set', path: ['secretSource'], value: handle === '' ? 'env' : 'handle' },
      handle === '' ? { op: 'unset', path: ['credentialHandle'] } : { op: 'set', path: ['credentialHandle'], value: handle },
    ], lark.revision)
    const reloaded = await this.reload(lark.ns)
    return Object.freeze({ applied: true, entry: lark.ns,
      note: (handle === '' ? `secret 来自环境变量 ${envName}` : 'secret 保留在 credentials keychain') + reloaded })
  }

  /** TraeX: one owner click toggles the local provider row; command is optional. */
  async configureTraex(enabled: boolean, command: string): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    const traex = findEntry(this.descriptors(), ns => TRAEX.test(ns))
    if (traex === undefined) return refuse('', 'traex-acp-provider 未安装，或它没有声明可实时修改的配置字段')
    const value = command.trim()
    if (value !== '' && (value.length > 1_024 || /[\r\n]/u.test(value))) {
      return refuse(traex.ns, 'command 必须是单行且不超过 1024 字符')
    }
    const ops: SettingsPathOp[] = [{ op: 'set', path: ['enabled'], value: enabled }]
    if (value !== '') ops.push({ op: 'set', path: ['command'], value })
    await settings.mutate(traex.ns, ops, traex.revision)
    const reloaded = await this.reload(traex.ns)
    return Object.freeze({ applied: true, entry: traex.ns, note: (enabled ? 'TraeX 行已启用' : 'TraeX 行已停用') + reloaded })
  }

  /** Project bundles only: merge one bounded JSON object into fields the entry exposes live. */
  async configureBundle(entry: string, config: Readonly<Record<string, unknown>>): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    if (!isEntryId(entry) || !isProjectBundle(entry)) {
      return refuse('', '只允许修改本项目的 dsh-enhanced 条目')
    }
    const target = findEntry(this.descriptors(), ns => ns === entry)
    if (target === undefined) {
      return refuse(entry, '该条目未安装，或它没有声明可实时修改的配置字段')
    }
    let patch: Readonly<Record<string, unknown>>
    try {
      patch = boundedConfig(config)
    } catch (cause) {
      return refuse(entry, cause instanceof Error ? cause.message : '配置无效')
    }
    const ops: SettingsPathOp[] = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }))
    if (ops.length === 0) return refuse(entry, '配置为空，没有可写入的字段')
    await settings.mutate(entry, ops, target.revision)
    const reloaded = await this.reload(entry)
    return Object.freeze({ applied: true, entry, note: '已合并写入' + reloaded })
  }
}

function applyChange(manager: PluginManagerService, result: ChangeResultLike): OwnerConsoleWriteResult {
  void manager
  const reason = result.error === undefined
    ? result.application === 'restart-required'
      ? '需要重启 profile 后生效'
      : result.application === 'overridden' ? '被更高优先级的覆盖项接管' : ''
    : `${result.error.code}${result.error.diagnostic === undefined ? '' : `：${result.error.diagnostic}`}`
  const warnings = (result.warnings ?? []).length === 0 ? '' : `；警告：${(result.warnings ?? []).join('；')}`
  const builds = (result.pendingBuilds ?? []).length === 0 ? ''
    : `；需要在设置页批准构建脚本：${(result.pendingBuilds ?? []).join('、')}`
  return Object.freeze({
    // A persisted change that only needs a profile restart is still applied;
    // failed/cancelled results and validation refusals stay not applied.
    applied: result.application === 'applied' || result.application === 'restart-required',
    entry: result.target,
    note: `${result.changed ? '已变更' : '无变化'}（${result.application}）${reason === '' ? '' : `；${reason}`}${warnings}${builds}`,
  })
}

function refuse(entry: string, note: string): OwnerConsoleWriteResult {
  return Object.freeze({ applied: false, entry, note })
}

type LarkHealthFacts = Pick<OwnerConsoleStatus['feishu'], 'connected' | 'connection' | 'lastErrorCode'>
const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

/** Read-only: `larkChannel.health()` is a synchronous snapshot with no I/O. Only the
 * enumerated state and error code pass through; anything else becomes `unknown`. */
function readLarkHealth(provider: unknown): LarkHealthFacts {
  if (provider === undefined || provider === null) return { connected: false, connection: 'absent' }
  let state: unknown
  let code: unknown
  try {
    const read = (provider as { health?: unknown }).health
    const health = typeof read === 'function' ? read.call(provider) as { state?: unknown, lastErrorCode?: unknown } | null : undefined
    state = health?.state
    code = health?.lastErrorCode
  } catch {
    // An inactive or failing provider is reported, never thrown into the panel.
    state = undefined
  }
  if (!includes(LARK_CONNECTIONS, state) || state === 'absent' || state === 'unknown') {
    return { connected: false, connection: 'unknown' }
  }
  return {
    connected: state === 'connected' || state === 'connected-with-gap',
    connection: state,
    ...(includes(LARK_ERROR_CODES, code) ? { lastErrorCode: code } : {}),
  }
}

type TrendSnapshotProvider = { inspectCreatedCapabilityOrdinaryUseTrendSnapshots?: (query: {
  planId?: string, beforeSequence?: number, limit?: number }) => unknown }
const UNVERIFIABLE: OwnerConsoleTrendSnapshots = Object.freeze({ state: 'unverifiable', causal: false, items: Object.freeze([]) })
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []

/** Project one control-plane snapshot page onto the bounded panel summary; content-free digests and counts only. */
export function readTrendSnapshots(provider: unknown, planId: string, beforeSequence: number,
  limit: number): OwnerConsoleTrendSnapshots {
  if (provider === undefined || provider === null) return Object.freeze({ state: 'absent', causal: false, items: Object.freeze([]) })
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TREND_SNAPSHOT_PAGE_MAX
    || !Number.isSafeInteger(beforeSequence) || beforeSequence < 0) return UNVERIFIABLE
  try {
    const read = (provider as TrendSnapshotProvider).inspectCreatedCapabilityOrdinaryUseTrendSnapshots
    if (typeof read !== 'function') return UNVERIFIABLE
    const page = record(read.call(provider, {
      ...(planId.trim() === '' ? {} : { planId: planId.trim() }),
      ...(beforeSequence === 0 ? {} : { beforeSequence }),
      limit,
    }))
    if (page['causal'] !== false || !Array.isArray(page['items'])) return UNVERIFIABLE
    const items = page['items'].map(item => {
      const row = record(item)
      const snapshot = record(row['snapshot'])
      const trend = record(snapshot['trend'])
      if (snapshot['causal'] !== false || trend['causal'] !== false) throw new Error('causal snapshot')
      return {
        sequence: row['sequence'], sealedAt: row['sealedAt'], planId: snapshot['planId'], digest: snapshot['digest'],
        inputsDigest: snapshot['inputsDigest'], trendDigest: snapshot['trendDigest'], window: snapshot['window'],
        cohorts: trend['cohorts'], flags: snapshot['flags'],
        strata: list(trend['strata']).map(value => {
          const stratum = record(value)
          const did = record(stratum['differenceInDifferences'])
          const interval = record(did['interval95'])
          return {
            model: stratum['model'],
            differenceInDifferences: did['status'] === 'estimated'
              ? { status: 'estimated', estimate: did['estimate'], low: interval['low'], high: interval['high'] }
              : { status: 'insufficient' },
            parallelTrend: record(stratum['parallelTrend'])['status'],
          }
        }),
      }
    })
    const parsed = OwnerConsoleTrendSnapshotsSchema.safeParse({ state: 'ok', causal: false, items,
      ...(page['nextBeforeSequence'] === undefined ? {} : { nextBeforeSequence: page['nextBeforeSequence'] }) })
    return parsed.success ? Object.freeze(parsed.data) : UNVERIFIABLE
  } catch {
    return UNVERIFIABLE
  }
}

type IntakeAgreementProvider = { inspectIntakeAttentionAgreement?: (input: { scope: { workspace: string, preset: string } }) => unknown }
const INTAKE_UNVERIFIABLE: OwnerConsoleIntakeAgreement = Object.freeze({ state: 'unverifiable', causal: false })

function intakeAgreementCell(value: unknown) {
  const cell = record(value)
  const outcomes = record(cell['outcomes'])
  return {
    notifications: cell['notifications'], items: cell['items'], agreed: cell['agreed'], disagreed: cell['disagreed'],
    agreementPpm: cell['agreementPpm'],
    outcomes: Object.fromEntries(INTAKE_AGREEMENT_OUTCOMES.map(outcome => [outcome, outcomes[outcome]])),
  }
}

/** Project Evaluation's intake attention agreement onto the panel summary; counts only, no ids or content. */
export function readIntakeAgreement(provider: unknown, workspace: string, preset: string): OwnerConsoleIntakeAgreement {
  if (provider === undefined || provider === null) return Object.freeze({ state: 'absent', causal: false })
  const scope = { workspace: workspace.trim(), preset: preset.trim() }
  if (scope.workspace === '' || scope.preset === '') return INTAKE_UNVERIFIABLE
  try {
    const read = (provider as IntakeAgreementProvider).inspectIntakeAttentionAgreement
    if (typeof read !== 'function') return INTAKE_UNVERIFIABLE
    const result = read.call(provider, { scope })
    if (result === undefined) return Object.freeze({ state: 'disabled', causal: false })
    const agreement = record(result)
    if (agreement['protocol'] !== 'assistant-evaluation/intake-attention-agreement/v1' || agreement['causal'] !== false) return INTAKE_UNVERIFIABLE
    const byLevel = record(agreement['byLevel'])
    const parsed = OwnerConsoleIntakeAgreementSchema.safeParse({ state: 'ok', causal: false, summary: {
      fromNotifiedAt: agreement['fromNotifiedAt'], toNotifiedAt: agreement['toNotifiedAt'], scanned: agreement['scanned'],
      truncated: agreement['truncated'], provenanceAvailable: agreement['provenanceAvailable'], notIntake: agreement['notIntake'],
      unresolved: agreement['unresolved'], foreign: agreement['foreign'], intake: intakeAgreementCell(agreement['intake']),
      byLevel: INTAKE_AGREEMENT_LEVELS.filter(level => byLevel[level] !== undefined)
        .map(level => ({ level, cell: intakeAgreementCell(byLevel[level]) })),
    } })
    return parsed.success && intakeAgreementConsistent(parsed.data.summary!) ? Object.freeze(parsed.data) : INTAKE_UNVERIFIABLE
  } catch {
    return INTAKE_UNVERIFIABLE
  }
}

type IntakeAgreementSummary = NonNullable<OwnerConsoleIntakeAgreement['summary']>

/** Evaluation's own arithmetic, re-checked so a self-contradicting answer is never shown as `ok`. */
function intakeAgreementConsistent(summary: IntakeAgreementSummary): boolean {
  const cellConsistent = (cell: IntakeAgreementSummary['intake']) => {
    const o = cell.outcomes
    const total = INTAKE_AGREEMENT_OUTCOMES.reduce((sum, outcome) => sum + o[outcome], 0)
    const decided = cell.agreed + cell.disagreed
    return total === cell.notifications && cell.items <= cell.notifications
      && cell.agreed === o.accepted + o.reacted && cell.disagreed === o.rejected + o['expired-unhandled']
      && cell.agreementPpm === (decided === 0 ? null : Math.round(cell.agreed * 1_000_000 / decided))
  }
  const levels = summary.byLevel.map(entry => entry.cell)
  return summary.fromNotifiedAt < summary.toNotifiedAt
    && summary.intake.notifications + summary.notIntake + summary.unresolved + summary.foreign <= summary.scanned
    && cellConsistent(summary.intake) && levels.every(cellConsistent)
    && levels.reduce((sum, cell) => sum + cell.notifications, 0) === summary.intake.notifications
}
