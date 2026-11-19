import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { KAI_FONT, QUIET_PHRASE } from './art.js'
import { WENYAO_ICON_DATA_URI, WENYAO_SEAL_DATA_URI } from './artwork.js'
import { CUSTOM_MODEL_OPTION, ModelRouteSelects, resolveEffectiveModelCatalog, resolveEffortOptions, cascadeModelChange } from './model-route-ui.js'
import { componentState, DEPENDENCY_BUNDLES, missingRemedy, repairPatch, type ComponentState } from './state.js'
import {
  AUTONOMY_TIER_DEFAULTS,
  type AssistantChatContext, type AutonomyBudgetLimits, type AutonomyBudgetTier, type AutonomySetupAction,
  type AutonomySetupStatus, type CodingToolProbe, type FeishuQrOnboardingSnapshot, type FeishuQrOwnerBinding,
  type GrowthDataState, type IntakeAgreementAvailability,
  type OwnerConsoleAssistantOverview, type OwnerConsoleGrowthReport, type OwnerConsoleIntakeAgreement,
  type OwnerConsoleIntakeAgreementHistory, type OwnerConsoleModelCatalog, type OwnerConsoleStatus,
  type OwnerConsoleTrendSnapshotItem, type OwnerConsoleTrendSnapshots, type OwnerConsoleWriteResult,
  type SelfUpgradePreview, type SelfUpgradeStatus, type SetupDoctorIssue, type SetupDoctorReport,
} from './typert.js'
import {
  accent, actionsStyle, border, buttonStyle, caption, card, danger, dangerButtonStyle, el, field, gridStyle,
  hairline, hintStyle, idle, ink, inputStyle, listStyle, monoFont, monoMuted, muted, pill, placeholder,
  primaryButtonStyle, row, subheadStyle, sunken, surface, tint, type StatusTone,
} from './ui.js'

export function feishuSecretRefs(source: 'env' | 'handle', env: string,
  handle: string): Readonly<{ appSecretEnv: string; credentialHandle: string }> {
  return source === 'env' ? { appSecretEnv: env, credentialHandle: '' } : { appSecretEnv: '', credentialHandle: handle }
}

export function askOwner(confirm: ((message: string) => boolean) | undefined,
  message: string): 'approved' | 'declined' | 'unavailable' {
  if (confirm === undefined) return 'unavailable'
  return confirm(message) ? 'approved' : 'declined'
}

export function confirmationNotice(answer: 'approved' | 'declined' | 'unavailable', message: string): string | undefined {
  if (answer === 'unavailable') return `当前界面没有确认对话框，本次操作未执行：${message}`
  return answer === 'declined' ? '已取消操作' : undefined
}

export function remoteFailureText(error: RemoteFailure | undefined): string {
  if (error === undefined || error.code === '' || error.message === '') return 'Host 返回了未说明的拒绝'
  const message = error.message.length > 600 ? `${error.message.slice(0, 600)}…` : error.message
  return `${error.code}：${message}`
}

export async function installWithApproval(
  remote: Pick<ConsoleRemote, 'installProjectBundle'>,
  spec: string,
  confirm: (message: string) => boolean,
): Promise<RemoteResult<OwnerConsoleWriteResult>> {
  const first = await remote.installProjectBundle(spec, [])
  if (!first.ok || first.value.applied) return first
  const pending = first.value.pendingBuilds ?? []
  if (pending.length === 0) return first
  return confirm(`安装需要允许这些依赖运行构建脚本：${pending.join('、')}。允许并重试？`)
    ? remote.installProjectBundle(spec, pending)
    : first
}

export async function installWithCompanions(
  remote: Pick<ConsoleRemote, 'installProjectBundle'>,
  spec: string,
  companions: readonly string[],
  confirm: (message: string) => boolean,
): Promise<RemoteResult<OwnerConsoleWriteResult>> {
  for (const companion of [...new Set(companions)].filter(name => name !== spec)) {
    const result = await installWithApproval(remote, companion, confirm)
    if (!result.ok || !result.value.applied) return result
  }
  return installWithApproval(remote, spec, confirm)
}

const LARK_CONNECTION_LABELS: Readonly<Record<OwnerConsoleStatus['feishu']['connection'], string>> = {
  absent: '未加载',
  unknown: '已加载，状态未知',
  connected: '已连接',
  'connected-with-gap': '已连接（期间有断档）',
  connecting: '连接中',
  disabled: '已停用',
  disconnected: '未连接',
  reconnecting: '重连中',
}

export function larkConnectionLabel(connection: OwnerConsoleStatus['feishu']['connection'],
  lastErrorCode?: string): string {
  const label = LARK_CONNECTION_LABELS[connection]
  return lastErrorCode === undefined ? label : `${label}（最近错误：${lastErrorCode}）`
}

export function larkConnectionTone(connection: OwnerConsoleStatus['feishu']['connection'],
  lastErrorCode?: string): StatusTone {
  if (connection === 'connected') return lastErrorCode === undefined ? 'ok' : 'warn'
  if (connection === 'disconnected') return 'error'
  if (connection === 'absent' || connection === 'disabled') return lastErrorCode === undefined ? 'neutral' : 'error'
  return 'warn'
}

export const OWN_PACKAGE = '@dsh-enhanced/owner-console'
export const LARK_PACKAGE = '@dsh-enhanced/lark-channel'
export const TRAEX_PACKAGE = '@dsh-enhanced/traex-acp-provider'
export const DREAMING_PACKAGE = '@dsh-enhanced/assistant-dreaming'
export const PROACTIVE_PACKAGE = '@dsh-enhanced/assistant-proactive'
export const GROWTH_PACKAGE = '@dsh-enhanced/assistant-growth-driver'
export const MEMORY_LEARNING_PACKAGE = '@dsh-enhanced/assistant-memory-learning'
const LARK_COMPANION_BUNDLES = ['@dsh-enhanced/assistant-delivery', '@dsh-enhanced/credentials-keychain'] as const

export function boundedLine(text: string, limit = 240): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

export function fiberState(phase: OwnerConsoleStatus['plugins'][number]['fiberPhase'],
  enabled: boolean): Readonly<{ label: string; tone: StatusTone }> {
  if (phase === 'active') return { label: '已加载', tone: 'ok' }
  if (phase === 'failed') return { label: '加载失败', tone: 'error' }
  if (phase === 'pending') return { label: '等待依赖服务', tone: 'warn' }
  if (phase === 'loading') return { label: '加载中', tone: 'warn' }
  if (phase === 'unloading') return { label: '卸载中', tone: 'neutral' }
  return enabled ? { label: '已启用未启动', tone: 'warn' } : { label: '已停用', tone: 'neutral' }
}

export type RemoteFailure = Readonly<{ code: string; message: string; details?: unknown }>
export type RemoteResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error?: RemoteFailure }>
export type ConsoleRemote = Readonly<{
  status(): Promise<RemoteResult<OwnerConsoleStatus>>
  trendSnapshots(planId: string, beforeSequence: number, limit: number): Promise<RemoteResult<OwnerConsoleTrendSnapshots>>
  intakeAgreement(workspace: string, preset: string): Promise<RemoteResult<OwnerConsoleIntakeAgreement>>
  intakeAgreementHistory(workspace: string, preset: string, limit: number): Promise<RemoteResult<OwnerConsoleIntakeAgreementHistory>>
  configureFeishu(appId: string, appSecretEnv: string, credentialHandle: string,
    account: string, tenant: string, discoverAppId: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureTraex(enabled: boolean, command: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureBundle(entry: string, config: Readonly<Record<string, unknown>>): Promise<RemoteResult<OwnerConsoleWriteResult>>
  setBundleEnabled(name: string, enabled: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  installProjectBundle(spec: string, approvedBuilds: readonly string[]): Promise<RemoteResult<OwnerConsoleWriteResult>>
  removeProjectBundle(name: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureAgy?(enabled: boolean, command: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  probeCodingTool?(tool: 'traex' | 'agy', command: string, force: boolean): Promise<RemoteResult<CodingToolProbe>>
  setDefaultModelRoute?(provider: string, model: string, reasoningEffort: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  assistantOverview?(workspace: string, preset: string): Promise<RemoteResult<OwnerConsoleAssistantOverview>>
  actDreamingIdea?(ideaId: string, action: 'acknowledge' | 'validate' | 'reject' | 'retire', note: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  actAttentionQuestion?(workspace: string, preset: string, cohortLane: string, cohortSourceId: string,
    questionId: string, choice: 'authorize-once' | 'decline'): Promise<RemoteResult<OwnerConsoleWriteResult>>
  actProactiveDraft?(id: string, action: 'accept' | 'reject' | 'cancel', workspace: string, preset: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  autonomySetupStatus?(): Promise<RemoteResult<AutonomySetupStatus>>
  configureAutonomySetup?(
    action: AutonomySetupAction,
    tier: AutonomyBudgetTier,
    provider: string,
    model: string,
    reasoningEffort: string,
    enableMemoryLearning: boolean,
    enableDreaming: boolean,
    enableGrowth: boolean,
    workItemExperiences: boolean,
    customBudget: AutonomyBudgetLimits,
  ): Promise<RemoteResult<OwnerConsoleWriteResult>>
  checkSelfUpgrade?(force: boolean): Promise<RemoteResult<SelfUpgradeStatus>>
  dryRunSelfUpgrade?(): Promise<RemoteResult<SelfUpgradePreview>>
  runSelfUpgrade?(confirmed: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  growthReport?(workspace: string, preset: string, sinceDays: number): Promise<RemoteResult<OwnerConsoleGrowthReport>>
  setupDoctor?(): Promise<RemoteResult<SetupDoctorReport>>
  applyDoctorRepair?(issueIds: readonly string[]): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureFeishuEasy?(appId: string, appSecret: string, account: string, tenant: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  startFeishuQrOnboarding?(
    domain: 'feishu' | 'lark',
    appName: string,
    existingAppId: string,
    account: string,
    tenant: string,
    calendarReadonly: boolean,
    businessTools: boolean,
  ): Promise<RemoteResult<FeishuQrOnboardingSnapshot>>
  feishuQrOnboardingStatus?(sessionId: string): Promise<RemoteResult<FeishuQrOnboardingSnapshot>>
  cancelFeishuQrOnboarding?(sessionId: string): Promise<RemoteResult<FeishuQrOnboardingSnapshot>>
  modelCatalog?(force: boolean): Promise<RemoteResult<OwnerConsoleModelCatalog>>
  assistantChatContext?(): Promise<RemoteResult<AssistantChatContext>>
  registerAssistantSession?(sessionId: string, makeActive: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
}>

export type OwnerConsoleNavigation = Readonly<{ openConversation(): void; openPlugins(): void }>

// Cross-surface mutation pub/sub keyed by remote identity so changing TraeX/AGY/Default Model
// in General Settings, Models Footer, Plugin Manager, or 文鳐 Console keeps all mounted views synced.
const mutationListeners = new WeakMap<object, Set<() => void>>()
export function subscribeConsoleRefresh(remote: ConsoleRemote, listener: () => void): () => void {
  let set = mutationListeners.get(remote)
  if (set === undefined) {
    set = new Set()
    mutationListeners.set(remote, set)
  }
  set.add(listener)
  return () => { set.delete(listener) }
}
export function notifyConsoleRefresh(remote: ConsoleRemote): void {
  const set = mutationListeners.get(remote)
  if (set === undefined) return
  for (const listener of Array.from(set)) {
    try { listener() } catch { /* ignore detached listener */ }
  }
}

export interface ConsoleController {
  readonly remote: ConsoleRemote
  readonly navigation: OwnerConsoleNavigation
  readonly status: OwnerConsoleStatus | undefined
  readonly overview: OwnerConsoleAssistantOverview | undefined
  readonly autonomySetup: AutonomySetupStatus | undefined
  readonly modelCatalog: OwnerConsoleModelCatalog | undefined
  readonly loadingModelCatalog: boolean
  readonly upgradeStatus: SelfUpgradeStatus | undefined
  readonly upgradePreview: SelfUpgradePreview | undefined
  readonly doctorReport: SetupDoctorReport | undefined
  readonly checkingDoctor: boolean
  readonly traexProbe: CodingToolProbe | undefined
  readonly agyProbe: CodingToolProbe | undefined
  readonly probingTool: 'traex' | 'agy' | undefined
  readonly checkingUpgrade: boolean
  readonly previewingUpgrade: boolean
  readonly busy: boolean
  readonly error: string
  readonly notice: string
  setError(value: string): void
  setNotice(value: string): void
  refresh(): Promise<void>
  refreshModelCatalog(force?: boolean): Promise<void>
  checkDoctor(): Promise<void>
  probeTool(tool: 'traex' | 'agy', command: string, force?: boolean, announce?: boolean): Promise<void>
  checkUpgrade(force?: boolean): Promise<void>
  previewUpgrade(): Promise<void>
  run(action: () => Promise<RemoteResult<OwnerConsoleWriteResult>>): Promise<void>
  runInstall(spec: string): Promise<void>
  confirmOwner(message: string): boolean
}

export function useConsoleActions(
  remote: ConsoleRemote,
  navigation: OwnerConsoleNavigation,
  status: OwnerConsoleStatus | undefined,
  setStatus: (next: OwnerConsoleStatus | undefined) => void,
): ConsoleController {
  const [overview, setOverview] = useState<OwnerConsoleAssistantOverview>()
  const [autonomySetup, setAutonomySetup] = useState<AutonomySetupStatus>()
  const [modelCatalog, setModelCatalog] = useState<OwnerConsoleModelCatalog>()
  const [loadingModelCatalog, setLoadingModelCatalog] = useState(false)
  const [upgradeStatus, setUpgradeStatus] = useState<SelfUpgradeStatus>()
  const [upgradePreview, setUpgradePreview] = useState<SelfUpgradePreview>()
  const [doctorReport, setDoctorReport] = useState<SetupDoctorReport>()
  const [checkingDoctor, setCheckingDoctor] = useState(false)
  const [traexProbe, setTraexProbe] = useState<CodingToolProbe>()
  const [agyProbe, setAgyProbe] = useState<CodingToolProbe>()
  const [probingTool, setProbingTool] = useState<'traex' | 'agy'>()
  const [checkingUpgrade, setCheckingUpgrade] = useState(false)
  const [previewingUpgrade, setPreviewingUpgrade] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refreshModelCatalog = async (force = false) => {
    if (typeof remote.modelCatalog !== 'function') return
    setLoadingModelCatalog(true)
    try {
      const cat = await remote.modelCatalog(force)
      if (mounted.current && cat.ok) setModelCatalog(cat.value)
    } catch {
      // Optional model catalog failure stays non-fatal; fallback catalog still works.
    } finally {
      if (mounted.current) setLoadingModelCatalog(false)
    }
  }

  const refresh = async () => {
    try {
      const statusPromise = typeof remote.status === 'function' ? remote.status() : undefined
      const overviewPromise = typeof remote.assistantOverview === 'function'
        ? remote.assistantOverview('', '') : undefined
      const autonomyPromise = typeof remote.autonomySetupStatus === 'function'
        ? remote.autonomySetupStatus() : undefined
      const upgradePromise = typeof remote.checkSelfUpgrade === 'function'
        ? remote.checkSelfUpgrade(false) : undefined
      const doctorPromise = typeof remote.setupDoctor === 'function'
        ? remote.setupDoctor() : undefined
      void refreshModelCatalog(false)
      if (statusPromise !== undefined) {
        const result = await statusPromise
        if (!mounted.current) return
        if (result.ok) setStatus(result.value)
        else setError(`读取状态失败（${remoteFailureText(result.error)}）`)
      }
      if (overviewPromise !== undefined) {
        const ov = await overviewPromise
        if (mounted.current && ov.ok) setOverview(ov.value)
      }
      if (autonomyPromise !== undefined) {
        const setup = await autonomyPromise
        if (mounted.current && setup.ok) setAutonomySetup(setup.value)
      }
      if (upgradePromise !== undefined) {
        const upg = await upgradePromise
        if (mounted.current && upg.ok) setUpgradeStatus(upg.value)
      }
      if (doctorPromise !== undefined) {
        const doc = await doctorPromise
        if (mounted.current && doc.ok) setDoctorReport(doc.value)
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? `暂时无法读取状态：${cause.message}` : '暂时无法读取状态，稍后重试。')
      }
    }
  }

  useEffect(() => {
    void refresh().catch(() => undefined)
    return subscribeConsoleRefresh(remote, () => { void refresh().catch(() => undefined) })
  }, [remote])

  const checkDoctor = async () => {
    if (typeof remote.setupDoctor !== 'function') return
    setCheckingDoctor(true)
    try {
      const result = await remote.setupDoctor()
      if (!mounted.current) return
      if (result.ok) setDoctorReport(result.value)
      else setError(`系统体检失败（${remoteFailureText(result.error)}）`)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '系统体检失败')
    } finally {
      if (mounted.current) setCheckingDoctor(false)
    }
  }

  const probeTool = async (tool: 'traex' | 'agy', command: string, force = true, announce = force) => {
    if (typeof remote.probeCodingTool !== 'function') {
      if (announce) setError('当前 Host 版本暂未暴露编程工具实时探测接口')
      return
    }
    setProbingTool(tool)
    if (announce) { setError(''); setNotice('') }
    try {
      const result = await remote.probeCodingTool(tool, command, force)
      if (!mounted.current) return
      if (!result.ok) {
        if (announce) setError(`探测失败（${remoteFailureText(result.error)}）`)
        return
      }
      if (tool === 'traex') setTraexProbe(result.value)
      else setAgyProbe(result.value)
      if (announce) setNotice(result.value.summary)
    } catch (cause) {
      if (mounted.current && announce) setError(cause instanceof Error ? cause.message : '探测失败')
    } finally {
      if (mounted.current) setProbingTool(undefined)
    }
  }

  const checkUpgrade = async (force = true) => {
    if (typeof remote.checkSelfUpgrade !== 'function') {
      setError('当前 Host 版本暂未暴露版本检查接口')
      return
    }
    setCheckingUpgrade(true); setError(''); setNotice('')
    try {
      const result = await remote.checkSelfUpgrade(force)
      if (!mounted.current) return
      if (!result.ok) {
        setError(`版本检查失败（${remoteFailureText(result.error)}）`)
        return
      }
      setUpgradeStatus(result.value)
      setNotice(result.value.note)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '版本检查失败')
    } finally {
      if (mounted.current) setCheckingUpgrade(false)
    }
  }

  const previewUpgrade = async () => {
    if (typeof remote.dryRunSelfUpgrade !== 'function') {
      setError('当前 Host 版本暂未暴露升级预演接口')
      return
    }
    setPreviewingUpgrade(true); setError(''); setNotice('')
    try {
      const result = await remote.dryRunSelfUpgrade()
      if (!mounted.current) return
      if (!result.ok) {
        setError(`升级预演失败（${remoteFailureText(result.error)}）`)
        return
      }
      setUpgradePreview(result.value)
      setNotice(result.value.summary)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '升级预演失败')
    } finally {
      if (mounted.current) setPreviewingUpgrade(false)
    }
  }

  const run = async (action: () => Promise<RemoteResult<OwnerConsoleWriteResult>>) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await action()
      if (!mounted.current) return
      if (!result.ok) { setError(`Host 拒绝了这次操作（${remoteFailureText(result.error)}）`); return }
      if (!result.value.applied) { setError(result.value.note); return }
      setError(''); setNotice(result.value.note)
      await refresh()
      notifyConsoleRefresh(remote)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const confirmOwner = (message: string): boolean => {
    const answer = askOwner((globalThis as unknown as { confirm?: (message: string) => boolean }).confirm, message)
    const note = confirmationNotice(answer, message)
    if (note !== undefined) {
      if (answer === 'unavailable') setError(note)
      else setNotice(note)
      return false
    }
    return true
  }

  const runInstall = (spec: string) => run(() => installWithApproval(remote, spec, confirmOwner))

  return {
    remote, navigation, status, overview, autonomySetup, modelCatalog, loadingModelCatalog, upgradeStatus, upgradePreview,
    doctorReport, checkingDoctor,
    traexProbe, agyProbe, probingTool, checkingUpgrade, previewingUpgrade,
    busy, error, notice, setError, setNotice, refresh, refreshModelCatalog, checkDoctor, probeTool, checkUpgrade, previewUpgrade,
    run, runInstall, confirmOwner,
  }
}

export function useStandaloneConsoleController(
  remote: ConsoleRemote,
  navigation: OwnerConsoleNavigation,
): ConsoleController {
  const [status, setStatus] = useState<OwnerConsoleStatus>()
  return useConsoleActions(remote, navigation, status, setStatus)
}

const TREND_PAGE = 10
const shortDigest = (digest: string) => digest.slice(0, 12)
const isoTime = (ms: number) => { try { return new Date(ms).toISOString() } catch { return String(ms) } }
function modelLabel(model: OwnerConsoleTrendSnapshotItem['strata'][number]['model']): string {
  if (model.state !== 'frozen') return model.state === 'missing' ? '模型未冻结' : '模型记录不一致'
  return `${model.provider}/${model.model}${model.reasoningEffort === undefined ? '' : ` · ${model.reasoningEffort}`}`
}
function didLabel(did: OwnerConsoleTrendSnapshotItem['strata'][number]['differenceInDifferences']): string {
  return did.status === 'insufficient' ? '样本不足'
    : `${did.estimate.toFixed(3)}（95%：${did.low.toFixed(3)} ~ ${did.high.toFixed(3)}）`
}

export function trendSnapshotsView(page: OwnerConsoleTrendSnapshots | undefined, failed: boolean,
  older: (beforeSequence: number) => void) {
  if (failed) return el('p', { role: 'alert', style: hintStyle }, '暂时无法读取趋势快照，稍后重试。')
  if (page === undefined) return placeholder('正在读取…')
  if (page.state === 'absent') return placeholder('plugin-control-plane 未加载，没有趋势快照。')
  if (page.state === 'unverifiable') {
    return el('div', { role: 'alert', style: { ...actionsStyle, fontSize: 12, color: muted } }, pill('未通过校验', 'error'),
      '查询被拒绝或已封存的记录被改动；面板不会修复或改写它。')
  }
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
  const items = page.items.length === 0
    ? placeholder('还没有封存的趋势快照。', QUIET_PHRASE)
    : el('ol', { style: { ...listStyle, margin: 0, listStyle: 'none' } }, ...page.items.map(item => el('li', {
      key: item.digest, style: { display: 'grid', gap: 4, padding: '10px 0', borderTop: `1px solid ${hairline}`, minWidth: 0, overflowWrap: 'anywhere' } },
    el('span', { style: actionsStyle },
      el('span', { style: { fontWeight: 500 } }, `#${item.sequence} · ${item.planId}`),
      item.window.complete ? null : pill('末窗未满', 'warn'),
      ...item.flags.filter(flag => flag !== 'partial-window').map(flag => pill(flag, 'neutral'))),
    el('span', { style: { fontSize: 12, color: caption } },
      `封存于 ${isoTime(item.sealedAt)} · 窗口 ${item.window.preWindows}+${item.window.postWindows} × ${Math.round(item.window.windowMs / 3_600_000)}h`
      + ` · (${isoTime(item.window.startExclusive)}, ${isoTime(item.window.endInclusive)}]`),
    el('span', { style: { fontSize: 12, color: muted } },
      `会话：使用 ${item.cohorts.treatedSessions} / 对照 ${item.cohorts.controlSessions}`),
    ...item.strata.map(stratum => el('span', { style: { fontSize: 12 } },
      `${modelLabel(stratum.model)}：DiD ${didLabel(stratum.differenceInDifferences)} · 平行趋势 ${stratum.parallelTrend}`)),
    el('span', { style: { ...mono, fontSize: 11, color: caption } },
      `digest ${shortDigest(item.digest)} · inputs ${shortDigest(item.inputsDigest)} · trend ${shortDigest(item.trendDigest)}`))))
  const next = page.nextBeforeSequence
  return el('div', { style: gridStyle },
    el('p', { style: hintStyle }, '只读：观察性统计（causal: false），不作为采用、晋升或撤销依据；封存由 Host 侧 owner 操作完成。'),
    items,
    next === undefined ? null : el('div', { style: actionsStyle },
      el('button', { style: buttonStyle, onClick: () => older(next) }, '更早的快照')))
}

export function TrendSnapshotsCard({ remote }: Readonly<{ remote: ConsoleRemote }>) {
  const [page, setPage] = useState<OwnerConsoleTrendSnapshots>()
  const [failed, setFailed] = useState(false)
  const load = (beforeSequence: number) => {
    setFailed(false)
    void remote.trendSnapshots('', beforeSequence, TREND_PAGE).then(result => {
      if (result.ok) setPage(result.value)
      else setFailed(true)
    }, () => setFailed(true))
  }
  useEffect(() => { load(0) }, [])
  return card('趋势快照（只读）', trendSnapshotsView(page, failed, load),
    page !== undefined && page.state === 'ok' && page.items.length > 0
      ? el('div', { style: actionsStyle }, el('button', { style: buttonStyle, onClick: () => load(0) }, '回到最新'))
      : null)
}

type IntakeAgreementCell = NonNullable<OwnerConsoleIntakeAgreement['summary']>['intake']
const INTAKE_LEVEL_LABELS: Readonly<Record<NonNullable<OwnerConsoleIntakeAgreement['summary']>['byLevel'][number]['level'], string>> = {
  ignore: 'ignore（忽略）', digest: 'digest（摘要）', notify: 'notify（通知）', accept: 'accept（准入）',
}
function agreementLabel(cell: IntakeAgreementCell): string {
  const rate = cell.agreementPpm === null ? '尚无已决结果' : `${(cell.agreementPpm / 10_000).toFixed(1)}%`
  return `吻合 ${cell.agreed} / 不吻合 ${cell.disagreed} · ${rate}（通知 ${cell.notifications}，工作项 ${cell.items}）`
}

export function intakeAgreementView(result: OwnerConsoleIntakeAgreement | undefined, failed: boolean) {
  if (failed) return el('p', { role: 'alert', style: hintStyle }, '暂时无法读取 intake 吻合度，稍后重试。')
  if (result === undefined) return placeholder('填写 Evaluation 作用域（workspace 与 preset）后读取。')
  if (result.state === 'absent') return placeholder('assistant-evaluation 未加载，没有 intake 吻合度。')
  if (result.state === 'disabled') {
    return el('div', { style: { ...actionsStyle, fontSize: 12, color: muted } }, pill('未启用', 'neutral'),
      'Evaluation 未开启 intakeAttentionAgreementEnabled（默认关，需同时开启 notificationOutcomesEnabled）。')
  }
  const summary = result.summary
  if (result.state === 'unverifiable' || summary === undefined) {
    return el('div', { role: 'alert', style: { ...actionsStyle, fontSize: 12, color: muted } }, pill('未通过校验', 'error'),
      '查询被拒绝或返回的结构不符；面板不会修复或改写它。')
  }
  return el('div', { style: gridStyle },
    el('p', { style: hintStyle }, '只读：观察性统计（causal: false），不是 intake 准确率，不作为采用依据；只统计 auto 准入的工作项。'),
    el('div', { style: listStyle },
      row('窗口', `[${isoTime(summary.fromNotifiedAt)}, ${isoTime(summary.toNotifiedAt)})`),
      row('扫描通知', el('span', { style: actionsStyle }, String(summary.scanned), summary.truncated ? pill('已截断', 'warn') : null)),
      row('intake 准入合计', agreementLabel(summary.intake)),
      ...summary.byLevel.map(entry => row(INTAKE_LEVEL_LABELS[entry.level], agreementLabel(entry.cell))),
      row('非 intake / 无法判断 / 他 scope', `${summary.notIntake} / ${summary.unresolved} / ${summary.foreign}`)),
    summary.provenanceAvailable ? null : el('div', { style: { ...actionsStyle, fontSize: 12, color: muted } },
      pill('WorkItems 未提供来源', 'warn'), '缺少 inspectIntakeProvenance，所有工作项计为无法判断。'))
}

type IntakeAgreementHistoryEntry = NonNullable<OwnerConsoleIntakeAgreementHistory['snapshots']>[number]
const INTAKE_HISTORY_PAGE = 20
const HISTORY_LEVEL_LABELS = INTAKE_LEVEL_LABELS

export function intakeAgreementHistoryView(result: OwnerConsoleIntakeAgreementHistory | undefined, failed: boolean) {
  if (failed) return el('p', { role: 'alert', style: hintStyle }, '暂时无法读取历史快照，稍后重试。')
  if (result === undefined) return placeholder('读取后将显示持久化的历史快照。')
  if (result.state === 'absent') return placeholder('assistant-evaluation 未加载，没有历史快照。')
  if (result.state === 'disabled') {
    return el('div', { style: { ...actionsStyle, fontSize: 12, color: muted } }, pill('未启用', 'neutral'),
      'Evaluation 未开启 intakeAttentionAgreementEnabled（默认关），没有历史快照。')
  }
  if (result.state === 'unverifiable' || result.snapshots === undefined) {
    return el('div', { role: 'alert', style: { ...actionsStyle, fontSize: 12, color: muted } }, pill('未通过校验', 'error'),
      '查询被拒绝或返回的结构不符；面板不会修复或改写它。')
  }
  if (result.snapshots.length === 0) return placeholder('还没有持久化的 intake 吻合度快照（E1 默认关闭）。')
  return el('div', { style: gridStyle },
    el('p', { style: hintStyle }, '只读历史：每行是一个不可改的观察快照（causal: false），不是 intake 准确率，也不能作为授权依据。'),
    el('ol', { style: { ...listStyle, margin: 0, listStyle: 'none' } },
      ...result.snapshots.map((entry: IntakeAgreementHistoryEntry, index) => el('li', {
        key: `${entry.fromNotifiedAt}:${entry.toNotifiedAt}:${index}`,
        style: { display: 'grid', gap: 4, padding: '10px 0', borderTop: `1px solid ${hairline}`, minWidth: 0, overflowWrap: 'anywhere' },
      },
      el('span', { style: actionsStyle },
        el('span', { style: { fontWeight: 500 } }, `窗口 [${isoTime(entry.fromNotifiedAt)}, ${isoTime(entry.toNotifiedAt)})`),
        entry.truncated ? pill('扫描已截断', 'warn') : null,
        entry.provenanceAvailable ? null : pill('WorkItems 未提供来源', 'warn')),
      el('span', { style: { fontSize: 12, color: caption } },
        `观察于 ${isoTime(entry.computedAt)} · 回看 ${Math.round(entry.windowMs / 3_600_000)}h · 扫描上限 ${entry.scanLimit}`),
      el('span', { style: { fontSize: 12 } }, agreementLabel(entry.intake)),
      ...entry.byLevel.map(level => el('span', { style: { fontSize: 12 } },
        `${HISTORY_LEVEL_LABELS[level.level]}：${agreementLabel(level.cell)}`)),
      el('span', { style: { fontSize: 12, color: muted } },
        `非 intake / 无法判断 / 他 scope：${entry.notIntake} / ${entry.unresolved} / ${entry.foreign}`)))))
}

const INTAKE_AVAILABILITY: Readonly<Record<IntakeAgreementAvailability, readonly [string, StatusTone]>> = {
  absent: ['未加载', 'neutral'],
  unknown: ['已加载，开关状态未知', 'warn'],
  disabled: ['未启用', 'neutral'],
  available: ['已启用', 'ok'],
}
export function intakeAvailabilityPill(availability: IntakeAgreementAvailability | undefined) {
  if (availability === undefined) return pill('正在读取…', 'neutral')
  const [label, tone] = INTAKE_AVAILABILITY[availability]
  return pill(label, tone)
}

export function IntakeAgreementCard({ remote, availability }: Readonly<{ remote: ConsoleRemote;
  availability?: IntakeAgreementAvailability | undefined }>) {
  const [workspace, setWorkspace] = useState('')
  const [preset, setPreset] = useState('')
  const [result, setResult] = useState<OwnerConsoleIntakeAgreement>()
  const [history, setHistory] = useState<OwnerConsoleIntakeAgreementHistory>()
  const [failed, setFailed] = useState(false)
  const [historyFailed, setHistoryFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const edit = (set: (value: string) => void) => (value: string) => {
    request.current += 1
    set(value)
    setResult(undefined)
    setHistory(undefined)
    setFailed(false)
    setHistoryFailed(false)
    setBusy(false)
  }
  const load = () => {
    const id = ++request.current
    setFailed(false)
    setHistoryFailed(false)
    setResult(undefined)
    setHistory(undefined)
    setBusy(true)
    void remote.intakeAgreement(workspace, preset).then(read => {
      if (id !== request.current) return
      setBusy(false)
      if (read.ok) setResult(read.value)
      else setFailed(true)
    }, () => {
      if (id !== request.current) return
      setBusy(false)
      setFailed(true)
    })
    void remote.intakeAgreementHistory(workspace, preset, INTAKE_HISTORY_PAGE).then(read => {
      if (id !== request.current) return
      if (read.ok) setHistory(read.value)
      else setHistoryFailed(true)
    }, () => {
      if (id !== request.current) return
      setHistoryFailed(true)
    })
  }
  const blocked = busy || workspace.trim() === '' || preset.trim() === ''
  return card('intake 吻合度（只读）',
    el('div', { style: listStyle }, row('Evaluation 开关', intakeAvailabilityPill(availability))),
    el('div', { style: actionsStyle },
      field('workspace', workspace, edit(setWorkspace), '/absolute/workspace'),
      field('preset', preset, edit(setPreset), 'primary')),
    el('div', { style: actionsStyle },
      el('button', { style: idle(buttonStyle, blocked), disabled: blocked, onClick: load }, busy ? '读取中…' : '读取')),
    intakeAgreementView(result, failed),
    el('p', { style: subheadStyle }, '历史快照（只读）'),
    intakeAgreementHistoryView(history, historyFailed))
}

function copyCommandToClipboard(command: string, ctrl: Pick<ConsoleController, 'setNotice'>): void {
  const nav = (globalThis as unknown as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } }).navigator
  if (typeof nav?.clipboard?.writeText === 'function') {
    void nav.clipboard.writeText(command).then(
      () => { ctrl.setNotice(`已复制命令，请粘贴到本机终端执行：${command}`) },
      () => { ctrl.setNotice(`请在本机终端执行：${command}`) },
    )
    return
  }
  ctrl.setNotice(`请在本机终端执行：${command}`)
}

function commandCopyRow(command: string, ctrl: Pick<ConsoleController, 'setNotice'>, busy: boolean, onRecheck?: () => void) {
  return el('div', { style: { ...actionsStyle, padding: '6px 10px', borderRadius: 8, background: tint(accent, 6), border: `1px solid ${tint(accent, 28)}` } },
    el('code', { style: { fontFamily: monoFont, fontSize: 12, color: ink } }, command),
    el('button', { type: 'button', style: buttonStyle, disabled: busy,
      onClick: () => copyCommandToClipboard(command, ctrl) }, '复制登录命令'),
    onRecheck === undefined ? null : el('button', { type: 'button', style: primaryButtonStyle, disabled: busy,
      onClick: onRecheck }, '我已登录，重新探测'))
}

function repairSection(ctrl: ConsoleController, state: ComponentState, packageName: string) {
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, ctrl.busy)
  return el('div', { style: { display: 'grid', gap: 8 } },
    el('p', { style: hintStyle }, state.stalled
      ? `条目加载后配置表单才会出现。${missingRemedy(state) === '' ? '' : `${missingRemedy(state)}。`}修复依赖后重启 profile。`
      : `该条目当前不可写：${state.label}。`),
    state.missing.length === 0 && typeof ctrl.remote.applyDoctorRepair !== 'function' ? null : el('div', { style: actionsStyle },
      ...state.missing.map(item => el('button', { key: item.bundle, style: btn(buttonStyle), disabled: ctrl.busy,
        onClick: () => void ctrl.runInstall(item.bundle) }, `安装 ${item.bundle}`)),
      typeof ctrl.remote.applyDoctorRepair === 'function' && (state.stalled || state.kind === 'errored')
        ? el('button', { type: 'button', style: btn(primaryButtonStyle), disabled: ctrl.busy,
          onClick: () => void ctrl.run(() => ctrl.remote.applyDoctorRepair!([])) }, '一键自动诊断与修复')
        : null),
    state.stalled || state.kind === 'errored'
      ? el('textarea', { readOnly: true, rows: 4, 'aria-label': `${packageName} 最小修复 patch`, value: repairPatch(state, packageName),
        style: { ...inputStyle, fontFamily: monoFont, fontSize: 11, resize: 'vertical' } })
      : null)
}

function probeTone(probe: CodingToolProbe | undefined): StatusTone {
  if (probe === undefined) return 'neutral'
  if (probe.ready) return 'ok'
  if (probe.state === 'disabled') return 'warn'
  return 'error'
}

function CommandPathControl({
  label,
  defaultBin,
  configured,
  discoveredPath,
  value,
  onChange,
  disabled,
}: Readonly<{
  label: string
  defaultBin: string
  configured: string
  discoveredPath?: string | undefined
  value: string
  onChange: (next: string) => void
  disabled: boolean
}>) {
  const [customMode, setCustomMode] = useState(false)
  const options: Array<{ value: string; label: string }> = []
  const seen = new Set<string>()
  const pushOpt = (optValue: string, optLabel: string) => {
    if (optValue === '' || seen.has(optValue)) return
    seen.add(optValue)
    options.push({ value: optValue, label: optLabel })
  }
  if (configured !== '') {
    pushOpt(configured, configured === discoveredPath
      ? `当前配置（已探测）: ${configured}`
      : `当前配置: ${configured}`)
  }
  if (discoveredPath !== undefined && discoveredPath !== '') {
    pushOpt(discoveredPath, `自动探测路径: ${discoveredPath}`)
  }
  pushOpt(defaultBin, `系统 PATH 默认 (${defaultBin})`)
  const currentValue = value !== '' ? value : (configured || discoveredPath || defaultBin)
  if (!seen.has(currentValue)) {
    pushOpt(currentValue, `自定义: ${currentValue}`)
  }

  return el('div', { style: { display: 'grid', gap: 4, minWidth: 220, flex: '1 1 260px' } },
    el('label', { style: { display: 'grid', gap: 4, fontSize: 12, color: muted } }, label,
      el('select', {
        'aria-label': label,
        'data-command-path-select': defaultBin,
        value: customMode ? CUSTOM_MODEL_OPTION : currentValue,
        disabled,
        style: inputStyle,
        onChange: (event: { target: { value: string } }) => {
          const picked = event.target.value
          if (picked === CUSTOM_MODEL_OPTION) {
            setCustomMode(true)
            return
          }
          setCustomMode(false)
          onChange(picked)
        },
      },
      ...options.map(opt => el('option', { key: opt.value, value: opt.value }, opt.label)),
      el('option', { value: CUSTOM_MODEL_OPTION }, '自定义路径…'))),
    !customMode ? null : el('input', {
      type: 'text',
      'aria-label': `${label}自定义路径`,
      value,
      disabled,
      placeholder: configured || discoveredPath || defaultBin,
      style: inputStyle,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }))
}

export function CodingToolsCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { status, modelCatalog, autonomySetup, loadingModelCatalog, busy, probingTool, traexProbe, agyProbe } = ctrl
  const [traexCommand, setTraexCommand] = useState('')
  const [agyCommand, setAgyCommand] = useState('')
  const [routeProvider, setRouteProvider] = useState('')
  const [routeModel, setRouteModel] = useState('default')
  const [routeEffort, setRouteEffort] = useState('')
  const userEditedRouteRef = useRef(false)
  const autoProbedRef = useRef(false)
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const traexState = componentState(status, TRAEX_PACKAGE)
  const acpEntryReady = status !== undefined && status.traex?.entry !== undefined
  const acpRepair = !acpEntryReady && (traexState.stalled || traexState.missing.length > 0 || traexState.kind === 'errored')
    ? repairSection(ctrl, traexState, TRAEX_PACKAGE) : null

  useEffect(() => {
    if (!acpEntryReady || autoProbedRef.current || typeof ctrl.remote.probeCodingTool !== 'function') return
    autoProbedRef.current = true
    void ctrl.probeTool('traex', status?.traex?.command ?? '', false, false)
    void ctrl.probeTool('agy', status?.agy?.command ?? '', false, false)
  }, [acpEntryReady])

  const effectiveCatalog = resolveEffectiveModelCatalog({ modelCatalog, status, autonomySetup })
  const defaultModel = status?.defaultModel
  const activeProvider = defaultModel?.provider ?? ''
  const activeModel = defaultModel?.model ?? ''
  const activeEffort = defaultModel?.reasoningEffort ?? ''
  const isTraexDefault = activeProvider === 'traex-agent'
  const isAgyDefault = activeProvider === 'agy-agent'

  useEffect(() => {
    if (userEditedRouteRef.current) return
    const defProv = effectiveCatalog.defaultSelection.provider
    const nextProv = defProv || effectiveCatalog.providers[0]?.id || ''
    if (nextProv === '') return
    const provEntry = effectiveCatalog.providers.find(p => p.id === nextProv)
    const isAcp = nextProv === 'traex-agent' || nextProv === 'agy-agent'
    const nextMod = (defProv === nextProv ? effectiveCatalog.defaultSelection.model : '')
      || provEntry?.models[0]?.id
      || (isAcp ? 'default' : '')
    const nextEff = defProv === nextProv ? (effectiveCatalog.defaultSelection.reasoningEffort ?? '') : ''
    setRouteProvider(nextProv)
    setRouteModel(nextMod)
    setRouteEffort(nextEff)
  }, [
    effectiveCatalog.defaultSelection.provider,
    effectiveCatalog.defaultSelection.model,
    effectiveCatalog.defaultSelection.reasoningEffort,
    effectiveCatalog.providers.length,
  ])

  const traexEnabled = status?.traex?.enabled === true
  const agyEnabled = status?.agy?.enabled === true
  const traexCmdDisplay = status === undefined || status.traex?.command === '' ? 'traex（默认）' : status.traex.command
  const agyCmdDisplay = status === undefined || !status.agy || status.agy.command === '' ? 'agy（默认）' : status.agy.command

  const probeButton = (tool: 'traex' | 'agy', cmd: string) => typeof ctrl.remote.probeCodingTool !== 'function' ? null :
    el('button', {
      style: btn(),
      disabled: busy || probingTool !== undefined,
      onClick: () => void ctrl.probeTool(tool, cmd, true, true),
    }, probingTool === tool ? '探测中…' : '探测状态')

  const defaultSwitchAction = (provider: 'traex-agent' | 'agy-agent', label: string) =>
    typeof ctrl.remote.setDefaultModelRoute !== 'function' ? null :
      el('button', {
        style: btn((isTraexDefault && provider === 'traex-agent') || (isAgyDefault && provider === 'agy-agent') ? buttonStyle : primaryButtonStyle),
        disabled: busy,
        onClick: () => {
          userEditedRouteRef.current = false
          void ctrl.run(() => ctrl.remote.setDefaultModelRoute!(provider, 'default', ''))
        },
      }, (provider === 'traex-agent' && isTraexDefault) || (provider === 'agy-agent' && isAgyDefault)
        ? `当前默认（${label}）` : `启用并设为默认`)

  const providerControlRows = acpEntryReady
    ? el('div', { style: { display: 'grid', gap: 14 } },
      // TraeX sub-block
      el('div', { style: { display: 'grid', gap: 8, paddingTop: 4 } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
          el('span', { style: { fontWeight: 600 } }, 'TraeX (`traex-agent`)'),
          el('div', { style: actionsStyle },
            pill(traexEnabled ? '路由已启用' : '路由未启用', traexEnabled ? 'ok' : 'neutral'),
            isTraexDefault ? pill('默认工具', 'ok') : null,
            traexProbe ? pill(traexProbe.state, probeTone(traexProbe)) : null)),
        traexProbe?.discoveredPath && (traexProbe.needsPathPin || !traexEnabled)
          ? el('div', { style: bannerStyle(accent) },
            el('div', { style: { ...actionsStyle, justifyContent: 'space-between' } },
              el('span', {}, `自动检测到本机 TraeX：${traexProbe.discoveredPath}${traexProbe.needsPathPin ? '（建议固定绝对路径，防止桌面端找不到命令）' : ''}`),
              el('button', { type: 'button', style: btn(primaryButtonStyle), disabled: busy,
                onClick: () => void ctrl.run(() => ctrl.remote.configureTraex(true, traexProbe.discoveredPath!)) }, '一键绑定本机路径并启用')))
          : null,
        el('div', { style: { ...actionsStyle, alignItems: 'end' } },
          jsx(CommandPathControl, {
            label: 'TraeX CLI 路径（可选）',
            defaultBin: 'traex',
            configured: status?.traex?.command ?? '',
            discoveredPath: traexProbe?.discoveredPath,
            value: traexCommand,
            onChange: setTraexCommand,
            disabled: busy,
          }),
          el('button', { style: btn(primaryButtonStyle), disabled: busy,
            onClick: () => void ctrl.run(() => ctrl.remote.configureTraex(true, traexCommand || status?.traex?.command || traexProbe?.discoveredPath || '')) }, '启用'),
          el('button', { style: btn(), disabled: busy,
            onClick: () => void ctrl.run(() => ctrl.remote.configureTraex(false, '')) }, '停用'),
          defaultSwitchAction('traex-agent', 'TraeX'),
          probeButton('traex', traexCommand || status?.traex?.command || '')),
        traexProbe === undefined ? null : el('p', { style: hintStyle },
          `${traexProbe.summary}${traexProbe.remediation ? ` · ${traexProbe.remediation}` : ''}`),
        traexProbe?.state === 'auth-required' && traexProbe.loginCommand
          ? commandCopyRow(traexProbe.loginCommand, ctrl, busy, () => void ctrl.probeTool('traex', traexCommand || status?.traex?.command || '', true, true))
          : null),
      // Antigravity (agy) sub-block
      el('div', { style: { display: 'grid', gap: 8, paddingTop: 10, borderTop: `1px solid ${hairline}` } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
          el('span', { style: { fontWeight: 600 } }, 'Antigravity (`agy-agent`)'),
          el('div', { style: actionsStyle },
            pill(agyEnabled ? '路由已启用' : '路由未启用', agyEnabled ? 'ok' : 'neutral'),
            isAgyDefault ? pill('默认工具', 'ok') : null,
            agyProbe ? pill(agyProbe.state, probeTone(agyProbe)) : null)),
        agyProbe?.discoveredPath && (agyProbe.needsPathPin || !agyEnabled) && typeof ctrl.remote.configureAgy === 'function'
          ? el('div', { style: bannerStyle(accent) },
            el('div', { style: { ...actionsStyle, justifyContent: 'space-between' } },
              el('span', {}, `自动检测到本机 Antigravity：${agyProbe.discoveredPath}${agyProbe.needsPathPin ? '（建议固定绝对路径，防止桌面端找不到命令）' : ''}`),
              el('button', { type: 'button', style: btn(primaryButtonStyle), disabled: busy,
                onClick: () => void ctrl.run(() => ctrl.remote.configureAgy!(true, agyProbe.discoveredPath!)) }, '一键绑定本机路径并启用')))
          : null,
        typeof ctrl.remote.configureAgy !== 'function'
          ? el('p', { style: hintStyle }, '当前 Host 暂未提供 Antigravity 配置接口，请升级插件并重启 profile。')
          : el('div', { style: { ...actionsStyle, alignItems: 'end' } },
            jsx(CommandPathControl, {
              label: 'agy CLI 路径（可选）',
              defaultBin: 'agy',
              configured: status?.agy?.command ?? '',
              discoveredPath: agyProbe?.discoveredPath,
              value: agyCommand,
              onChange: setAgyCommand,
              disabled: busy,
            }),
            el('button', { style: btn(primaryButtonStyle), disabled: busy,
              onClick: () => void ctrl.run(() => ctrl.remote.configureAgy!(true, agyCommand || status?.agy?.command || agyProbe?.discoveredPath || '')) }, '启用'),
            el('button', { style: btn(), disabled: busy,
              onClick: () => void ctrl.run(() => ctrl.remote.configureAgy!(false, '')) }, '停用'),
            defaultSwitchAction('agy-agent', 'Antigravity'),
            probeButton('agy', agyCommand || status?.agy?.command || '')),
        agyProbe === undefined ? null : el('p', { style: hintStyle },
          `${agyProbe.summary}${agyProbe.remediation ? ` · ${agyProbe.remediation}` : ''}`),
        agyProbe?.state === 'auth-required' && agyProbe.loginCommand
          ? commandCopyRow(agyProbe.loginCommand, ctrl, busy, () => void ctrl.probeTool('agy', agyCommand || status?.agy?.command || '', true, true))
          : null))
    : status === undefined
      ? placeholder('正在读取…')
      : el('div', { style: { display: 'grid', gap: 10 } },
        el('div', { style: actionsStyle },
          traexState.canInstall
            ? el('button', { style: btn(primaryButtonStyle), disabled: ctrl.busy,
              onClick: () => void ctrl.runInstall(TRAEX_PACKAGE) }, '安装 traex-acp-provider')
            : null,
          traexState.canEnable
            ? el('button', { style: btn(primaryButtonStyle), disabled: ctrl.busy,
              onClick: () => void ctrl.run(() => ctrl.remote.setBundleEnabled(TRAEX_PACKAGE, true)) }, '启用 traex-acp-provider')
            : null),
        acpRepair)

  const trimmedRouteProvider = routeProvider.trim()
  const isAcpSelected = trimmedRouteProvider === 'traex-agent' || trimmedRouteProvider === 'agy-agent'
  const trimmedRouteModel = routeModel.trim()
  const defaultSubmitDisabled = busy || trimmedRouteProvider === '' || (!isAcpSelected && trimmedRouteModel === '')

  const defaultSwitcher = typeof ctrl.remote.setDefaultModelRoute !== 'function' || status === undefined ? null
    : el('div', { style: { marginTop: 4, borderTop: `1px solid ${hairline}`, paddingTop: 12, display: 'grid', gap: 10 } },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
        el('span', { style: { fontSize: 12, fontWeight: 600, color: ink } }, '默认模型与推理强度（同 /model）'),
        typeof ctrl.remote.modelCatalog === 'function'
          ? el('button', {
            type: 'button',
            style: btn(),
            disabled: busy || loadingModelCatalog,
            onClick: () => void ctrl.refreshModelCatalog(true),
          }, loadingModelCatalog ? '刷新中…' : '刷新模型列表')
          : null),
      jsx(ModelRouteSelects, {
        catalog: effectiveCatalog,
        provider: routeProvider,
        model: routeModel,
        reasoningEffort: routeEffort,
        disabled: busy,
        onChange: (next: Readonly<{ provider: string; model: string; reasoningEffort: string }>) => {
          userEditedRouteRef.current = true
          setRouteProvider(next.provider)
          setRouteModel(next.model)
          setRouteEffort(next.reasoningEffort)
        },
      }),
      el('div', { style: actionsStyle },
        el('button', {
          type: 'button',
          style: idle(primaryButtonStyle, defaultSubmitDisabled),
          disabled: defaultSubmitDisabled,
          onClick: () => {
            if (defaultSubmitDisabled) return
            userEditedRouteRef.current = false
            const resolvedModel = isAcpSelected ? (trimmedRouteModel || 'default') : trimmedRouteModel
            void ctrl.run(() => ctrl.remote.setDefaultModelRoute!(trimmedRouteProvider, resolvedModel, routeEffort.trim()))
          },
        }, '设为默认模型')))

  return card('编程工具与默认模型（TraeX / Antigravity）',
    el('p', { style: hintStyle }, '本机 ACP 编程代理与默认模型路由管理；探测仅检查本机安装与登录，不触发付费对话调用。'),
    el('div', { style: listStyle },
      row('入口', el('span', { style: actionsStyle },
        pill(traexState.label, traexState.tone),
        status?.traex?.entry === undefined ? null : el('span', { style: monoMuted }, status.traex.entry))),
      ...(traexState.entry?.diagnostic === undefined ? [] : [row('诊断', boundedLine(traexState.entry.diagnostic))]),
      ...(traexState.error === undefined ? [] : [row('错误', `${traexState.error.code}${traexState.error.diagnostic === undefined ? '' : `：${boundedLine(traexState.error.diagnostic)}`}`)]),
      ...(traexState.missing.length === 0 ? [] : [row('缺少服务', missingRemedy(traexState))]),
      row('TraeX 命令', traexCmdDisplay),
      row('Antigravity 命令', agyCmdDisplay),
      row('当前默认路由', defaultModel?.available
        ? el('span', { style: actionsStyle },
          pill(activeProvider === '' ? '未配置' : `${activeProvider} / ${activeModel || 'default'}${activeEffort ? ` · ${activeEffort}` : ''}`,
            activeProvider === '' ? 'warn' : 'ok'))
        : pill('agent-default-model 未加载', 'neutral'))),
    providerControlRows,
    defaultSwitcher)
}

function feishuQrStateMeta(state: FeishuQrOnboardingSnapshot['state']): Readonly<{ label: string; tone: StatusTone }> {
  switch (state) {
    case 'awaiting-scan': return { label: '等待飞书扫码授权', tone: 'warn' }
    case 'applying': return { label: '授权已确认，正在安全配置…', tone: 'warn' }
    case 'completed': return { label: '扫码接入完成', tone: 'ok' }
    case 'expired': return { label: '二维码已过期', tone: 'warn' }
    case 'denied': return { label: '已拒绝授权', tone: 'warn' }
    case 'cancelled': return { label: '已取消扫码', tone: 'neutral' }
    case 'failed': return { label: '接入未完成', tone: 'error' }
    default: return { label: '未开始', tone: 'neutral' }
  }
}

function feishuQrOwnerBindingTone(binding: FeishuQrOwnerBinding): StatusTone {
  return binding === 'bound-owner' || binding === 'reused-owner' ? 'ok' : 'warn'
}

function feishuQrOwnerBindingText(binding: FeishuQrOwnerBinding | undefined): string {
  switch (binding) {
    case 'bound-owner': return '已自动绑定为主人'
    case 'reused-owner': return '已沿用现有飞书主人'
    case 'linked-to-owner': return '关联身份（仅普通私聊，非主主人）'
    case 'reused-linked': return '已沿用关联身份（仅普通私聊，非主主人）'
    case 'not-returned': return '未返回扫码账号 open_id'
    case 'unmodified': return '仅写入策略（身份表未改写）'
    default: return ''
  }
}

function feishuQrOwnerBindingHint(binding: FeishuQrOwnerBinding | undefined): string | undefined {
  if (binding === 'linked-to-owner' || binding === 'reused-linked') {
    return '普通飞书私聊在重启 profile 后即可正常使用；主人专属命令（/permission、/model、审批卡片、反馈学习与自主授权/工作项准入）仍锚定在现有主主人。如需切换主主人，或在已有自主授权时更换应用，请使用终端向导 dsh-lark-setup。'
  }
  if (binding === 'not-returned' || binding === 'unmodified') {
    return '当前未自动绑定为飞书主主人；请重启 profile 后确认身份状态，如需绑定/切换主主人或在已有自主授权时更换应用，请使用终端向导 dsh-lark-setup。'
  }
  return undefined
}

function isTrustedFeishuUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'feishu.cn'
      || host.endsWith('.feishu.cn')
      || host === 'larksuite.com'
      || host.endsWith('.larksuite.com')
  } catch {
    return false
  }
}

function formatCountdown(expiresAt: number | undefined, nowMs: number): string {
  if (expiresAt === undefined) return ''
  const sec = Math.max(0, Math.ceil((expiresAt - nowMs) / 1_000))
  if (sec === 0) return '已过期'
  const minutes = Math.floor(sec / 60)
  const seconds = sec % 60
  return minutes > 0 ? `剩余 ${minutes} 分 ${seconds} 秒` : `剩余 ${seconds} 秒`
}

export function FeishuCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { status, busy, remote } = ctrl
  const canQrFeishu = typeof remote.startFeishuQrOnboarding === 'function'
    && typeof remote.feishuQrOnboardingStatus === 'function'
  const canEasyFeishu = typeof remote.configureFeishuEasy === 'function'
  const [appId, setAppId] = useState('')
  const [secretSource, setSecretSource] = useState<'qr' | 'easy' | 'env' | 'handle'>(canQrFeishu ? 'qr' : 'easy')
  const [appSecret, setAppSecret] = useState('')
  const [secretEnv, setSecretEnv] = useState('LARK_APP_SECRET')
  const [secretHandle, setSecretHandle] = useState('')
  const [account, setAccount] = useState('')
  const [tenant, setTenant] = useState('')
  const [qrDomain, setQrDomain] = useState<'feishu' | 'lark'>('feishu')
  const [qrAppName, setQrAppName] = useState('文鳐助手')
  const [qrExistingAppId, setQrExistingAppId] = useState('')
  const [qrBusinessTools, setQrBusinessTools] = useState(true)
  const [qrCalendarReadonly, setQrCalendarReadonly] = useState(false)
  const [qrSession, setQrSession] = useState<FeishuQrOnboardingSnapshot | undefined>(undefined)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrCopied, setQrCopied] = useState(false)
  const [qrNowMs, setQrNowMs] = useState(0)
  const completedSessionRef = useRef('')
  const qrActionSeqRef = useRef(0)
  const qrInFlightRef = useRef(false)
  const ctrlRef = useRef(ctrl)
  ctrlRef.current = ctrl

  useEffect(() => {
    if (!canQrFeishu || typeof remote.feishuQrOnboardingStatus !== 'function') return
    let active = true
    const seqAtMount = qrActionSeqRef.current
    void remote.feishuQrOnboardingStatus('').then(res => {
      if (!active || !res.ok || qrActionSeqRef.current !== seqAtMount) return
      const restorable = res.value.state === 'awaiting-scan'
        || res.value.state === 'applying'
        || res.value.state === 'completed'
      if (restorable && res.value.sessionId !== '') {
        setQrSession(res.value)
        setQrNowMs(Date.now())
        if (res.value.state === 'completed') completedSessionRef.current = res.value.sessionId
      }
    }).catch(() => { /* ignore initial QR status restore failure */ })
    return () => { active = false }
  }, [canQrFeishu, remote])

  const activePollSessionId = qrSession !== undefined
    && (qrSession.state === 'awaiting-scan' || qrSession.state === 'applying')
    && qrSession.sessionId !== ''
    ? qrSession.sessionId
    : ''

  useEffect(() => {
    if (!canQrFeishu || activePollSessionId === '' || typeof remote.feishuQrOnboardingStatus !== 'function') return
    let active = true
    let inFlight = false
    const pollOnce = () => {
      if (!active || inFlight) return
      inFlight = true
      void remote.feishuQrOnboardingStatus!(activePollSessionId).then(res => {
        if (!active || !res.ok) return
        const next = res.value
        if (next.sessionId !== '' && next.sessionId !== activePollSessionId) return
        setQrSession(next)
        setQrNowMs(Date.now())
        const currentCtrl = ctrlRef.current
        if (next.state === 'completed' && completedSessionRef.current !== next.sessionId) {
          completedSessionRef.current = next.sessionId
          currentCtrl.setError('')
          currentCtrl.setNotice(next.note)
          notifyConsoleRefresh(remote)
          void currentCtrl.refresh()
        } else if (next.state === 'failed') {
          currentCtrl.setNotice('')
          currentCtrl.setError(next.note)
        } else if (next.state === 'expired' || next.state === 'denied' || next.state === 'cancelled' || next.state === 'idle') {
          currentCtrl.setError('')
          currentCtrl.setNotice(next.note)
        }
      }).catch(() => {
        // Keep polling on transient UI IPC hiccup; Host manages protocol timeout/errors.
      }).finally(() => {
        inFlight = false
      })
    }
    const pollTimer = setInterval(pollOnce, 2_000)
    const clockTimer = setInterval(() => {
      if (active) setQrNowMs(Date.now())
    }, 1_000)
    return () => {
      active = false
      clearInterval(pollTimer)
      clearInterval(clockTimer)
    }
  }, [activePollSessionId, canQrFeishu, remote])

  const startQrOnboarding = async () => {
    if (!canQrFeishu || qrInFlightRef.current) return
    qrInFlightRef.current = true
    qrActionSeqRef.current += 1
    setQrLoading(true)
    setQrCopied(false)
    ctrl.setError('')
    try {
      const res = await remote.startFeishuQrOnboarding!(
        qrDomain,
        qrAppName,
        qrExistingAppId,
        account,
        tenant,
        qrCalendarReadonly,
        qrBusinessTools,
      )
      if (!res.ok) {
        ctrl.setError(remoteFailureText(res.error))
        return
      }
      setQrSession(res.value)
      setQrNowMs(Date.now())
      if (res.value.state === 'failed') {
        ctrl.setNotice('')
        ctrl.setError(res.value.note)
      } else {
        ctrl.setNotice(res.value.note)
      }
    } catch (cause) {
      ctrl.setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      qrInFlightRef.current = false
      setQrLoading(false)
    }
  }

  const cancelQrOnboarding = async () => {
    if (typeof remote.cancelFeishuQrOnboarding !== 'function' || qrInFlightRef.current) return
    qrInFlightRef.current = true
    qrActionSeqRef.current += 1
    setQrLoading(true)
    try {
      const res = await remote.cancelFeishuQrOnboarding(qrSession?.sessionId ?? '')
      if (res.ok) {
        setQrSession(res.value)
        ctrl.setError('')
        ctrl.setNotice(res.value.note)
      } else {
        ctrl.setError(remoteFailureText(res.error))
      }
    } catch (cause) {
      ctrl.setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      qrInFlightRef.current = false
      setQrLoading(false)
    }
  }

  useEffect(() => {
    if (!qrCopied) return
    const timer = setTimeout(() => setQrCopied(false), 2_000)
    return () => clearTimeout(timer)
  }, [qrCopied])

  const copyQrLink = async (url: string) => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(url)
        setQrCopied(true)
        ctrl.setNotice('已复制飞书官方授权链接，可直接粘贴到飞书或浏览器打开。')
        return
      }
    } catch {
      // Fall through to manual guidance.
    }
    ctrl.setNotice('当前环境未开放剪贴板写入，请直接点击「打开飞书授权页」或用飞书扫码。')
  }

  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const pending = status === undefined
  const larkReady = status !== undefined && status.feishu.entry !== undefined
  const larkState = componentState(status, LARK_PACKAGE)
  const installedCompanions = new Set([
    ...(status?.dependencies ?? [])
      .filter(dependency => dependency.available)
      .map(dependency => DEPENDENCY_BUNDLES[dependency.name])
      .filter((bundle): bundle is string => bundle !== undefined),
    ...(status?.bundles ?? [])
      .filter(bundle => bundle.installed && bundle.enabled)
      .map(bundle => bundle.name),
  ])
  const larkCompanions = LARK_COMPANION_BUNDLES.filter(bundle => !installedCompanions.has(bundle))
  const installLark = larkState.canInstall
    ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
      onClick: () => void ctrl.run(() => installWithCompanions(remote, LARK_PACKAGE, larkCompanions, ctrl.confirmOwner)) }, '安装 lark-channel')
    : null
  const enableLark = larkState.canEnable
    ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
      onClick: () => void ctrl.run(() => remote.setBundleEnabled(LARK_PACKAGE, true)) }, '启用 lark-channel')
    : null
  const larkRepair = !larkReady && (larkState.stalled || larkState.missing.length > 0 || larkState.kind === 'errored')
    ? repairSection(ctrl, larkState, LARK_PACKAGE) : null

  const feishuRows = pending
    ? placeholder('正在读取…')
    : el('div', { style: listStyle },
      row('方式', status.feishu.mode === 'env' ? '环境变量 secret' : 'keychain secret'),
      row('入口', el('span', { style: actionsStyle },
        pill(larkState.label, larkState.tone),
        status.feishu.entry === undefined ? null : el('span', { style: monoMuted }, status.feishu.entry))),
      ...(larkState.entry?.diagnostic === undefined ? [] : [row('诊断', boundedLine(larkState.entry.diagnostic))]),
      ...(larkState.error === undefined ? [] : [row('错误', `${larkState.error.code}${larkState.error.diagnostic === undefined ? '' : `：${boundedLine(larkState.error.diagnostic)}`}`)]),
      ...(larkState.missing.length === 0 ? [] : [row('缺少服务', missingRemedy(larkState))]),
      row('连接', pill(larkConnectionLabel(status.feishu.connection, status.feishu.lastErrorCode),
        larkConnectionTone(status.feishu.connection, status.feishu.lastErrorCode))),
      row('appId', pill(status.feishu.appIdConfigured ? '已配置' : '未配置', status.feishu.appIdConfigured ? 'ok' : 'warn')))

  const safeQrDataUrl = qrSession?.qrCodeDataUrl !== undefined
    && qrSession.qrCodeDataUrl.startsWith('data:image/svg+xml;base64,')
    ? qrSession.qrCodeDataUrl
    : undefined
  const safeQrUrl = qrSession?.verificationUrl !== undefined
    && isTrustedFeishuUrl(qrSession.verificationUrl)
    ? qrSession.verificationUrl
    : undefined
  const qrStateMeta = qrSession === undefined ? undefined : feishuQrStateMeta(qrSession.state)
  const countdownText = qrSession?.state === 'awaiting-scan'
    ? formatCountdown(qrSession.expiresAt, qrNowMs > 0 ? qrNowMs : (qrSession.startedAt ?? Date.now()))
    : ''

  const qrOnboardingPanel = el('div', { 'data-feishu-qr-panel': '', style: { display: 'grid', gap: 12 } },
    el('div', {
      style: {
        display: 'grid', gap: 6, padding: '10px 12px', borderRadius: 10,
        border: `1px solid ${border}`, background: sunken, fontSize: 12, color: muted, lineHeight: 1.6,
      },
    },
    el('div', { style: { fontWeight: 600, color: ink } }, '飞书官方一键扫码授权（与安装向导 dsh-lark-setup 相同协议）'),
    el('div', {}, '1. 点击下方按钮向飞书开放平台申请官方设备授权二维码与链接；'),
    el('div', {}, '2. 用飞书扫码（或直接打开授权页），选择已有应用或一键创建新机器人并确认所需权限；'),
    el('div', {}, '3. 确认后 App Secret 仅在 Host 内存加密存入系统凭据库（配置文件零明文），自动写入通道、收发策略与扫码账号绑定；保存后重启一次 profile（重启 DeepSeek Harness.app 或运行 dsh-rsi restart）即可建立新长连接。')),
    qrSession !== undefined && qrSession.state !== 'idle'
      ? el('div', {
        'data-feishu-qr-state': qrSession.state,
        style: {
          display: 'grid', gap: 12, padding: '12px 14px', borderRadius: 12,
          border: `1px solid ${border}`, background: surface,
        },
      },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
        el('div', { style: actionsStyle },
          qrStateMeta === undefined ? null : pill(qrStateMeta.label, qrStateMeta.tone),
          qrSession.state === 'completed' && qrSession.restartRecommended === true
            ? pill('需重启 profile 生效', 'warn')
            : null,
          qrSession.domainSwitched ? pill('已切换 Lark 国际版', 'ok') : null,
          qrSession.appId !== undefined ? el('span', { style: monoMuted }, qrSession.appId) : null),
        countdownText !== '' ? el('span', { style: { fontSize: 12, color: caption, fontFamily: monoFont } }, countdownText) : null),
      qrSession.state === 'awaiting-scan'
        ? el('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' } },
          safeQrDataUrl !== undefined
            ? el('div', {
              style: {
                padding: 10, borderRadius: 12, background: '#ffffff',
                border: `1px solid ${border}`, flex: 'none', lineHeight: 0,
              },
            },
            el('img', {
              src: safeQrDataUrl,
              alt: '飞书官方授权二维码',
              'data-feishu-qr-image': '',
              width: 240,
              height: 240,
              style: { display: 'block', width: 240, height: 240 },
            }))
            : null,
          el('div', { style: { display: 'grid', gap: 10, flex: '1 1 240px', minWidth: 0 } },
            el('p', { style: { margin: 0, fontSize: 13, color: ink, lineHeight: 1.55 } }, qrSession.note),
            el('p', { style: hintStyle },
              '打开手机或电脑端飞书「扫一扫」扫描左侧二维码；若当前就在本机使用飞书，也可以直接点击下方按钮在浏览器中打开授权页。'),
            el('div', { style: actionsStyle },
              safeQrUrl !== undefined
                ? el('a', {
                  href: safeQrUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  'data-feishu-qr-link': '',
                  style: { ...primaryButtonStyle, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
                }, '打开飞书授权页')
                : null,
              safeQrUrl !== undefined
                ? el('button', {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => void copyQrLink(safeQrUrl),
                }, qrCopied ? '已复制链接' : '复制授权链接')
                : null,
              typeof remote.cancelFeishuQrOnboarding === 'function'
                ? el('button', {
                  type: 'button',
                  style: idle(buttonStyle, qrLoading),
                  disabled: qrLoading,
                  onClick: () => void cancelQrOnboarding(),
                }, '取消扫码')
                : null)))
        : qrSession.state === 'completed'
          ? el('div', { style: { display: 'grid', gap: 8 } },
            el('p', { style: { margin: 0, fontSize: 13, color: ink, lineHeight: 1.55 } }, qrSession.note),
            el('div', { style: listStyle },
              qrSession.appId !== undefined ? row('App ID', el('span', { style: monoMuted }, qrSession.appId)) : null,
              row('授权区域', qrSession.domain === 'lark' ? 'Lark 国际版（larksuite.com）' : '飞书中国版（feishu.cn）'),
              qrSession.openId !== undefined ? row('扫码账号', el('span', { style: monoMuted }, qrSession.openId)) : null,
              qrSession.ownerBinding !== undefined
                ? row(
                  '身份授权',
                  el(
                    'span',
                    {
                      'data-feishu-qr-owner-binding': qrSession.ownerBinding,
                      'data-feishu-qr-owner-tone': feishuQrOwnerBindingTone(qrSession.ownerBinding),
                    },
                    pill(feishuQrOwnerBindingText(qrSession.ownerBinding), feishuQrOwnerBindingTone(qrSession.ownerBinding)),
                  ),
                )
                : null),
            feishuQrOwnerBindingHint(qrSession.ownerBinding) !== undefined
              ? el('p', { 'data-feishu-qr-owner-hint': '', style: hintStyle }, feishuQrOwnerBindingHint(qrSession.ownerBinding))
              : null,
            el('div', { style: actionsStyle },
              el('button', {
                type: 'button',
                style: btn(primaryButtonStyle),
                disabled: busy,
                onClick: () => void ctrl.refresh(),
              }, '刷新连接状态'),
              el('button', {
                type: 'button',
                style: idle(buttonStyle, busy || qrLoading),
                disabled: busy || qrLoading,
                onClick: () => void startQrOnboarding(),
              }, '重新扫码 / 更换应用')))
          : el('div', { style: { display: 'grid', gap: 8 } },
            el('p', { style: { margin: 0, fontSize: 13, color: qrSession.state === 'failed' ? danger : ink, lineHeight: 1.55 } }, qrSession.note),
            qrSession.state !== 'applying'
              ? el('div', { style: actionsStyle },
                el('button', {
                  type: 'button',
                  style: idle(primaryButtonStyle, busy || qrLoading),
                  disabled: busy || qrLoading,
                  onClick: () => void startQrOnboarding(),
                }, qrLoading ? '正在生成二维码…' : '重新生成二维码'))
              : null))
      : null,
    el('details', {},
      el('summary', { style: { fontSize: 12, color: muted, cursor: 'pointer' } }, '高级选项（服务区域 / 应用名称 / 更新已有应用 / 附加权限与身份）'),
      el('div', { style: { display: 'grid', gap: 10, marginTop: 10 } },
        el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } },
          el('label', { style: { display: 'grid', gap: 4, fontSize: 12, color: muted } }, '服务区域',
            el('select', {
              'aria-label': '飞书服务区域',
              value: qrDomain,
              disabled: qrLoading || activePollSessionId !== '',
              style: inputStyle,
              onChange: (event: { target: { value: string } }) => setQrDomain(event.target.value === 'lark' ? 'lark' : 'feishu'),
            },
            el('option', { value: 'feishu' }, '飞书中国版（feishu.cn，默认；国际版扫码自动切换）'),
            el('option', { value: 'lark' }, 'Lark 国际版（larksuite.com）'))),
          field('新建应用默认名称', qrAppName, setQrAppName, '文鳐助手'),
          field('更新已有应用 App ID（可选）', qrExistingAppId, setQrExistingAppId, '留空由飞书自选/新建；填 cli_... 可增量补权'),
          field('account（可选）', account, setAccount, '留空自动沿用或使用 primary'),
          field('tenant（可选）', tenant, setTenant, '留空自动沿用或使用 personal')),
        el('div', { style: { display: 'grid', gap: 6, fontSize: 12, color: ink } },
          el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
            el('input', {
              type: 'checkbox',
              checked: qrBusinessTools,
              disabled: qrLoading || activePollSessionId !== '',
              style: { accentColor: accent, margin: 0 },
              onChange: (event: { target: { checked: boolean } }) => setQrBusinessTools(event.target.checked),
            }),
            '包含飞书官方个人助理预设权限（与安装脚本默认一致）'),
          el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
            el('input', {
              type: 'checkbox',
              checked: qrCalendarReadonly,
              disabled: qrLoading || activePollSessionId !== '',
              style: { accentColor: accent, margin: 0 },
              onChange: (event: { target: { checked: boolean } }) => setQrCalendarReadonly(event.target.checked),
            }),
            '同时申请日历只读权限（calendar:calendar:readonly）')))),
    (qrSession === undefined || qrSession.state === 'idle')
      ? el('div', { style: actionsStyle },
        el('button', {
          type: 'button',
          'data-feishu-qr-start': '',
          style: idle(primaryButtonStyle, busy || qrLoading || !canQrFeishu),
          disabled: busy || qrLoading || !canQrFeishu,
          onClick: () => void startQrOnboarding(),
        }, qrLoading ? '正在向飞书申请授权码…' : '一键生成飞书扫码授权'),
        !canQrFeishu ? el('span', { style: hintStyle }, '当前 Host 尚未暴露扫码授权接口，请升级插件或切换手动填入模式。') : null)
      : null)

  const feishuActions = !larkReady && !installLark && !enableLark && larkRepair === null
    ? null
    : el('div', { style: { display: 'grid', gap: 12 } },
      installLark === null && enableLark === null ? null : el('div', { style: actionsStyle }, installLark, enableLark),
      larkRepair,
      ...(larkReady ? [
        el('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }, role: 'radiogroup', 'aria-label': 'secret 引用方式' },
          el('span', { style: subheadStyle }, '配置方式'),
          ...(canQrFeishu ? [
            el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
              el('input', { type: 'radio', name: 'secret-source', checked: secretSource === 'qr', style: { accentColor: accent, margin: 0 },
                onChange: () => setSecretSource('qr') }), '一键扫码接入（推荐）'),
          ] : []),
          el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
            el('input', { type: 'radio', name: 'secret-source', checked: secretSource === 'easy', style: { accentColor: accent, margin: 0 },
              onChange: () => setSecretSource('easy') }), canQrFeishu ? '手动填入凭据' : '极简一键接入（推荐）'),
          el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
            el('input', { type: 'radio', name: 'secret-source', checked: secretSource === 'env', style: { accentColor: accent, margin: 0 },
              onChange: () => setSecretSource('env') }), '环境变量'),
          el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
            el('input', { type: 'radio', name: 'secret-source', checked: secretSource === 'handle', style: { accentColor: accent, margin: 0 },
              onChange: () => setSecretSource('handle') }), 'keychain handle')),
        secretSource === 'qr'
          ? qrOnboardingPanel
          : secretSource === 'easy'
            ? el('div', { style: { display: 'grid', gap: 10 } },
              el('p', { style: hintStyle },
                '只需填入飞书开放平台应用的 App ID 与 App Secret，系统将自动加密存入本机凭据库（macOS 钥匙串 / Linux 受保护文件）并写入通道与访问策略（配置文件绝不存明文）；保存后重启 profile 即可建立长连接。'),
              el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } },
                field('App ID', appId, setAppId, 'cli_0123456789abcdef'),
                el('label', { style: { display: 'grid', gap: 4, fontSize: 12, color: muted } }, 'App Secret（仅存系统凭据库）',
                  el('input', {
                    type: 'password',
                    value: appSecret,
                    placeholder: '粘贴飞书 App Secret',
                    autoComplete: 'off',
                    style: inputStyle,
                    onChange: (event: { target: { value: string } }) => setAppSecret(event.target.value),
                  }))),
              el('details', {},
                el('summary', { style: { fontSize: 12, color: muted, cursor: 'pointer' } }, '高级身份标识（默认留空自动沿用或使用 primary / personal）'),
                el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 8 } },
                  field('account', account, setAccount, 'primary（或留空沿用当前 owner）'),
                  field('tenant', tenant, setTenant, 'personal（或留空沿用当前 owner）'))),
              el('div', { style: actionsStyle },
                el('button', {
                  type: 'button',
                  style: idle(primaryButtonStyle, busy || !canEasyFeishu || appId.trim() === '' || appSecret.trim() === ''),
                  disabled: busy || !canEasyFeishu || appId.trim() === '' || appSecret.trim() === '',
                  onClick: () => {
                    const submittedSecret = appSecret
                    void ctrl.run(async () => {
                      const res = await remote.configureFeishuEasy!(appId, submittedSecret, account, tenant)
                      if (res.ok && res.value.applied) setAppSecret('')
                      return res
                    })
                  },
                }, '一键安全存入凭据并启用飞书'),
                !canEasyFeishu ? el('span', { style: hintStyle }, '当前 Host 未暴露一键接入接口，请切换环境变量或 Handle 模式。') : null))
            : el('div', { style: { display: 'grid', gap: 10 } },
              el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } },
                field('appId', appId, setAppId, 'cli_0123456789abcdef'),
                secretSource === 'env'
                  ? field('secret 环境变量名', secretEnv, setSecretEnv, 'LARK_APP_SECRET')
                  : field('keychain handle', secretHandle, setSecretHandle, 'lark-app-secret'),
                field('account', account, setAccount, '保留当前 owner'),
                field('tenant', tenant, setTenant, '保留当前 owner')),
              el('div', { style: actionsStyle },
                el('button', { style: btn(primaryButtonStyle), disabled: busy,
                  onClick: () => {
                    const refs = feishuSecretRefs(secretSource, secretEnv, secretHandle)
                    void ctrl.run(() => remote.configureFeishu(appId, refs.appSecretEnv, refs.credentialHandle, account, tenant, false))
                  } }, '应用配置'),
                el('button', { style: btn(), disabled: busy,
                  onClick: () => {
                    const refs = feishuSecretRefs(secretSource, secretEnv, secretHandle)
                    void ctrl.run(() => remote.configureFeishu('', refs.appSecretEnv, refs.credentialHandle, account, tenant, true))
                  } }, '一键配置（从 Host 环境探测 appId）')),
              el('p', { style: hintStyle },
                '这里配置的是 lark-channel 通道；secret 引用模式下明文不入配置。'))] : []))

  return card('远程接入（飞书）', feishuRows, feishuActions)
}

function subsystemPill(state: 'absent' | 'disabled' | 'ok' | 'error') {
  if (state === 'ok') return pill('运行中', 'ok')
  if (state === 'disabled') return pill('已安装未启用', 'warn')
  if (state === 'error') return pill('读取异常', 'error')
  return pill('未加载', 'neutral')
}

export function DreamingCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { status, overview, busy, remote } = ctrl
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const dreamState = componentState(status, DREAMING_PACKAGE)
  const d = overview?.dreaming
  const installOrEnable = el('div', { style: actionsStyle },
    dreamState.canInstall ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
      onClick: () => void ctrl.runInstall(DREAMING_PACKAGE) }, '安装 assistant-dreaming') : null,
    dreamState.canEnable ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
      onClick: () => void ctrl.run(() => remote.setBundleEnabled(DREAMING_PACKAGE, true)) }, '启用 assistant-dreaming') : null)

  const body = d === undefined
    ? (status === undefined ? placeholder('正在读取做梦子系统…') : placeholder('Host 暂未返回做梦概览。', QUIET_PHRASE))
    : el('div', { style: gridStyle },
      el('div', { style: listStyle },
        row('状态', subsystemPill(d.state)),
        ...(d.health === undefined ? [] : [
          row('调度器', pill(d.health.scheduler, d.health.scheduler === 'active' ? 'ok' : 'neutral')),
          row('运行 / 想法（待审）', `${d.health.runs} 次 · 共 ${d.health.ideas} 条（待审 ${d.health.recorded}）`),
          ...(d.health.lastRunOutcome === undefined && d.health.lastSkipReason === undefined
            ? [] : [row('最近结果 / 跳过原因', `${d.health.lastRunOutcome ?? '—'}${d.health.lastSkipReason ? ` (${d.health.lastSkipReason})` : ''}`)]),
        ]),
        ...(d.missingPrerequisites.length === 0 ? [] : [row('启用前提缺失', d.missingPrerequisites.join(', '))]),
        ...(d.note === undefined ? [] : [row('说明', d.note)])),
      installOrEnable,
      typeof remote.actDreamingIdea === 'function' && d.canRetire && d.state === 'ok'
        ? el('div', { style: actionsStyle },
          el('button', { style: btn(dangerButtonStyle), disabled: busy,
            onClick: () => {
              if (ctrl.confirmOwner('休眠 assistant-dreaming 后台调度？已生成的想法将保留在本地账本中。')) {
                void ctrl.run(() => remote.actDreamingIdea!('', 'retire', 'owner-console retire'))
              }
            } }, '休眠做梦调度'))
        : null,
      d.ideas.length === 0
        ? placeholder('暂无待审或已记录的 Dreaming 想法。', QUIET_PHRASE)
        : el('div', { style: listStyle }, ...d.ideas.map(idea => el('div', {
          key: idea.id,
          style: { padding: '10px 0', borderTop: `1px solid ${hairline}`, display: 'grid', gap: 6 },
        },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          el('span', { style: { fontWeight: 500 } }, idea.summary || idea.id),
          pill(idea.state, idea.state === 'validated' ? 'ok' : idea.state === 'rejected' || idea.state === 'withdrawn' ? 'neutral' : 'warn')),
        idea.detail === '' ? null : el('p', { style: { margin: 0, fontSize: 12, color: muted } }, idea.detail),
        el('div', { style: monoMuted }, `${idea.dayKey || isoTime(idea.createdAt)} · evidence ${idea.evidenceCount}`),
        typeof remote.actDreamingIdea !== 'function' || idea.state === 'validated' || idea.state === 'rejected' || idea.state === 'withdrawn'
          ? null
          : el('div', { style: actionsStyle },
            d.canAcknowledge && idea.state === 'recorded'
              ? el('button', { style: btn(), disabled: busy,
                onClick: () => void ctrl.run(() => remote.actDreamingIdea!(idea.id, 'acknowledge', 'owner-acknowledged')) }, '已阅确认')
              : null,
            d.canValidate
              ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
                onClick: () => void ctrl.run(() => remote.actDreamingIdea!(idea.id, 'validate', 'owner-validated')) }, '验证通过')
              : null,
            d.canReject
              ? el('button', { style: btn(dangerButtonStyle), disabled: busy,
                onClick: () => void ctrl.run(() => remote.actDreamingIdea!(idea.id, 'reject', 'owner-rejected')) }, '拒绝')
              : null,
            d.canReject && idea.state === 'recorded'
              ? el('button', { style: btn(), disabled: busy,
                onClick: () => void ctrl.run(() => remote.actDreamingIdea!(idea.id, 'retire', 'owner-retired')) }, '撤回')
              : null)))))

  return card('自主做梦（assistant-dreaming）',
    el('p', { style: hintStyle }, 'L0 空闲思考：仅经主人显式验证通过后才会成为候选能力输入，绝不绕过验收与预算上限。'),
    body)
}

export function ProactiveWorkItemsCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { overview, busy, remote } = ctrl
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const p = overview?.proactive
  const w = overview?.workItems
  const scope = overview?.resolvedScope

  return card('主动协同、工作项与注意力授权',
    el('p', { style: hintStyle }, '查看未验证草稿（unverified-draft）、WP22 注意力放宽请求，以及 WorkItems observe / would-admit 准入队列。'),
    p === undefined && w === undefined
      ? placeholder('正在读取主动与工作项状态…')
      : el('div', { style: gridStyle },
        el('div', { style: listStyle },
          row('assistant-proactive', p === undefined ? pill('未知', 'neutral') : subsystemPill(p.state)),
          ...(p?.intakeEvaluation === undefined ? [] : [
            row('Intake 评估', `${p.intakeEvaluation.enabled ? '已启用' : '未启用'} · 本小时 ${p.intakeEvaluation.callsLastHour} 次 · 连续失败 ${p.intakeEvaluation.consecutiveFailures}`),
          ]),
          row('assistant-work-items', w === undefined ? pill('未知', 'neutral') : subsystemPill(w.state)),
          ...(w?.health === undefined ? [] : [
            row('WorkItems 模式', `${w.health.mode} · 打开项 ${w.health.openItems} · worker ${w.health.workerConnected ? '已连' : '未连'}`),
            ...(w.health.admitMode === undefined && w.health.pendingAdmissions === undefined ? [] : [
              row('准入状态', `admit=${w.health.admitMode ?? '—'} · objective=${w.health.hasAcceptanceObjective ? '就绪' : '未配置'} · 待审 ${w.health.pendingAdmissions ?? 0}`),
            ]),
          ])),
        // WP22 Attention Owner Questions
        p !== undefined && p.attentionQuestions.length > 0
          ? el('div', { style: { display: 'grid', gap: 6 } },
            el('h4', { style: subheadStyle }, 'WP22 注意力放宽提问'),
            el('div', { style: listStyle }, ...p.attentionQuestions.map(q => {
              const qWs = q.workspace ?? scope?.workspace ?? ''
              const qPr = q.preset ?? scope?.preset ?? ''
              const canAct = q.replyChoice === undefined && q.actionable !== false
                && typeof remote.actAttentionQuestion === 'function' && qWs !== '' && qPr !== ''
              return el('div', {
                key: q.questionId,
                style: { padding: '8px 0', borderTop: `1px solid ${hairline}`, display: 'grid', gap: 6 },
              },
              el('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
                el('span', { style: { fontWeight: 500 } }, q.questionSummary ?? `${q.cohortSourceId} (${q.cohortLane})`),
                pill(q.replyChoice ?? q.deliveryStatus, q.replyChoice === 'authorize-once' ? 'ok' : q.replyChoice === 'decline' ? 'neutral' : 'warn')),
              el('div', { style: monoMuted }, `${q.questionId} · ${isoTime(q.recordedAt)}`),
              !canAct ? null : el('div', { style: actionsStyle },
                el('button', { style: btn(primaryButtonStyle), disabled: busy,
                  onClick: () => void ctrl.run(() => remote.actAttentionQuestion!(
                    qWs, qPr, q.cohortLane, q.cohortSourceId, q.questionId, 'authorize-once')) }, '仅本次授权'),
                el('button', { style: btn(dangerButtonStyle), disabled: busy,
                  onClick: () => void ctrl.run(() => remote.actAttentionQuestion!(
                    qWs, qPr, q.cohortLane, q.cohortSourceId, q.questionId, 'decline')) }, '拒绝')))
            })))
          : null,
        // Proactive Drafts (`unverified-draft`)
        p !== undefined && p.drafts.length > 0
          ? el('div', { style: { display: 'grid', gap: 6 } },
            el('h4', { style: subheadStyle }, 'Proactive 草稿（unverified-draft）'),
            el('div', { style: listStyle }, ...p.drafts.map(draft => {
              const dWs = scope?.workspace ?? ''
              const dPr = scope?.preset ?? ''
              const canAct = p.canResolveDraft && typeof remote.actProactiveDraft === 'function' && draft.feedback === undefined
              return el('div', {
                key: draft.id,
                style: { padding: '8px 0', borderTop: `1px solid ${hairline}`, display: 'grid', gap: 4 },
              },
              el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
                el('span', { style: { fontWeight: 500 } }, draft.objective || draft.goalId || draft.id),
                pill(draft.feedback ?? `${draft.state}${draft.verified ? '' : ' · 未验证'}`,
                  draft.feedback === 'accepted' ? 'ok' : draft.state === 'draft' ? 'warn' : 'neutral')),
              draft.outputPreview === undefined ? null : el('p', { style: { margin: 0, fontSize: 12, color: muted } }, draft.outputPreview),
              !canAct ? null : el('div', { style: actionsStyle },
                draft.state === 'draft' ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
                  onClick: () => void ctrl.run(() => remote.actProactiveDraft!(draft.id, 'accept', dWs, dPr)) }, '接受草稿') : null,
                draft.state === 'queued' || draft.state === 'running' || draft.state === 'draft'
                  ? el('button', { style: btn(dangerButtonStyle), disabled: busy,
                    onClick: () => void ctrl.run(() => remote.actProactiveDraft!(draft.id, 'reject', dWs, dPr)) }, '拒绝')
                  : null,
                draft.state === 'queued' || draft.state === 'running'
                  ? el('button', { style: btn(), disabled: busy,
                    onClick: () => void ctrl.run(() => remote.actProactiveDraft!(draft.id, 'cancel', dWs, dPr)) }, '取消')
                  : null))
            })))
          : null,
        // WorkItems observe/would-admit queue
        w === undefined || w.queue.length === 0
          ? placeholder('当前没有待观察或待准入（observe / would-admit）的 WorkItems 记录。', QUIET_PHRASE)
          : el('div', { style: { display: 'grid', gap: 6 } },
            el('h4', { style: subheadStyle }, 'WorkItems 观察 / 准入队列'),
            el('div', { style: listStyle }, ...w.queue.map(item => el('div', {
              key: `${item.entryKind ?? 'row'}-${item.id}`,
              style: { padding: '8px 0', borderTop: `1px solid ${hairline}`, display: 'grid', gap: 4 },
            },
            el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
              el('span', { style: { fontWeight: 500 } }, item.summary || item.id),
              pill(item.outcome, item.outcome === 'admitted' ? 'ok' : item.outcome === 'refused' ? 'error' : 'warn')),
            el('div', { style: monoMuted },
              `${item.source ?? 'host'}${item.observeReason ? ` · ${item.observeReason}` : item.reasonCode ? ` · ${item.reasonCode}` : ''} · ${isoTime(item.recordedAt)}`)))))))
}

export function GrowthMemoryCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { overview, status, busy, remote } = ctrl
  const ml = overview?.memoryLearning
  const gd = overview?.growthDriver
  const mlState = componentState(status, MEMORY_LEARNING_PACKAGE)
  const gdState = componentState(status, GROWTH_PACKAGE)
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)

  return card('经验学习与持续成长（Memory Learning / Growth Driver）',
    el('p', { style: hintStyle }, '查看有限提取额度、三方授权就绪状态与近期能力成长提案；只展示真源状态，不自赋权。'),
    ml === undefined && gd === undefined
      ? placeholder('正在读取学习与成长状态…')
      : el('div', { style: gridStyle },
        el('div', { style: listStyle },
          row('assistant-memory-learning', el('span', { style: actionsStyle },
            ml === undefined ? pill('未知', 'neutral') : subsystemPill(ml.state),
            pill(mlState.label, mlState.tone))),
          ...(ml?.health === undefined ? [] : [
            row('剩余提取额度', `${ml.health.remainingExtractions}（${ml.health.available ? '授权可用' : '额度/授权受限'}）`),
            row('已采纳 / 队列 / 拒绝', `${ml.health.counts['adopted'] ?? 0} / ${(ml.health.counts['queued'] ?? 0) + (ml.health.counts['pending'] ?? 0)} / ${ml.health.counts['rejected'] ?? 0}`),
            ...(ml.health.lastError === undefined ? [] : [row('最近错误', ml.health.lastError)]),
          ]),
          ...(ml?.note === undefined ? [] : [row('说明', ml.note)]),
          row('assistant-growth-driver', el('span', { style: actionsStyle },
            gd === undefined ? pill('未知', 'neutral') : subsystemPill(gd.state),
            pill(gdState.label, gdState.tone))),
          ...(gd?.health === undefined ? [] : [
            row('最近唤醒', `${gd.health.outcome}${gd.health.reason ? ` (${gd.health.reason})` : ''}`),
            row('Usage 学习扫描', `${gd.health.usageEnabled ? (gd.health.usageConnected ? '已连接' : '未连接') : '未启用'}`),
            ...(gd.health.dreamingIntake === undefined ? [] : [
              row('Dreaming 想法输入', `${gd.health.dreamingIntake.enabled ? '已开启' : '未开启'} · 采纳 ${gd.health.dreamingIntake.ingested}/${gd.health.dreamingIntake.considered}`),
            ]),
          ])),
        gd !== undefined && gd.proposals.length > 0
          ? el('div', { style: listStyle }, ...gd.proposals.map(p => row(`${p.kind} · ${p.id}`, `${p.state}${p.summary ? `：${p.summary}` : ''}`)))
          : null,
        el('div', { style: actionsStyle },
          el('button', { style: btn(), disabled: busy, onClick: () => ctrl.navigation.openPlugins() }, '在插件页管理安装/启用'),
          mlState.canEnable ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
            onClick: () => void ctrl.run(() => remote.setBundleEnabled(MEMORY_LEARNING_PACKAGE, true)) }, '启用 memory-learning') : null,
          gdState.canEnable ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
            onClick: () => void ctrl.run(() => remote.setBundleEnabled(GROWTH_PACKAGE, true)) }, '启用 growth-driver') : null)))
}

export function BundlesCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { status, busy, remote } = ctrl
  const [bundleEntry, setBundleEntry] = useState('')
  const [customEntryMode, setCustomEntryMode] = useState(false)
  const [bundleJson, setBundleJson] = useState('{}')
  const [installSpec, setInstallSpec] = useState('@dsh-enhanced/')
  const pending = status === undefined
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const itemStyle = { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${hairline}` }
  const pluginEntries = status?.plugins ?? []

  const bundleRows = pending
    ? placeholder('正在读取…')
    : status.bundles.length === 0
      ? placeholder('本 profile 中没有本项目的 bundle。', QUIET_PHRASE)
      : el('div', { style: listStyle }, ...status.bundles.map(bundle => {
        const state = componentState(status, bundle.name)
        return el('div', { key: bundle.name, style: itemStyle },
          el('span', { style: { display: 'grid', gap: 2, minWidth: 0, overflowWrap: 'anywhere' } },
            el('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, minWidth: 0 } },
              el('span', { style: { fontWeight: 500 } }, bundle.name),
              bundle.version === undefined ? null : el('span', { style: { fontSize: 12, color: caption } }, `@${bundle.version}`)),
            bundle.error === undefined ? null : el('span', { style: { fontSize: 11, color: danger, fontFamily: monoFont } },
              `${bundle.error.code}${bundle.error.diagnostic === undefined ? '' : `：${boundedLine(bundle.error.diagnostic)}`}`)),
          el('span', { style: actionsStyle },
            pill(state.label, state.tone),
            bundle.error !== undefined && !bundle.enabled ? null
              : el('button', { style: btn(), disabled: busy,
                onClick: () => void ctrl.run(() => remote.setBundleEnabled(bundle.name, !bundle.enabled)) },
              bundle.enabled ? '停用' : '启用'),
            bundle.removable && bundle.name !== OWN_PACKAGE
              ? el('button', { style: btn(dangerButtonStyle), disabled: busy,
                onClick: () => {
                  if (ctrl.confirmOwner(`移除 ${bundle.name}？重新安装可用面板的安装入口。`)) {
                    void ctrl.run(() => remote.removeProjectBundle(bundle.name))
                  }
                } }, '移除')
              : null))
      }))
  const pluginRows = pending || status.plugins.length === 0
    ? placeholder(pending ? '正在读取…' : '没有已加载的本项目插件条目。', pending ? undefined : QUIET_PHRASE)
    : el('div', { style: listStyle }, ...status.plugins.map(plugin => {
      const fiber = fiberState(plugin.fiberPhase, plugin.enabled)
      return el('div', { key: plugin.entryId, style: itemStyle },
        el('span', { style: { display: 'grid', gap: 2, minWidth: 0, overflowWrap: 'anywhere' } },
          el('span', { style: { fontWeight: 500 } }, plugin.moduleName),
          el('span', { style: monoMuted }, `${plugin.entryId} · ${plugin.fiberPhase ?? 'null'}`),
          plugin.diagnostic === undefined ? null : el('span', { style: { fontSize: 11, color: danger } }, boundedLine(plugin.diagnostic))),
        el('span', { style: actionsStyle },
          pill(fiber.label, fiber.tone),
          el('button', { style: btn(), disabled: busy,
            onClick: () => void ctrl.run(() => remote.setPluginEnabled(plugin.entryId, !plugin.enabled)) },
          plugin.enabled ? '禁用' : '启用')))
    }))

  return card('本项目插件管理',
    el('div', { style: { display: 'grid', gap: 10 } },
      el('h4', { style: subheadStyle }, 'Bundle 层'),
      bundleRows,
      el('h4', { style: { ...subheadStyle, marginTop: 6 } }, '已加载条目'),
      pluginRows,
      el('div', { style: { ...actionsStyle, alignItems: 'end', marginTop: 6 } },
        field('安装本项目 bundle', installSpec, setInstallSpec, '@dsh-enhanced/plugin-name'),
        el('button', { style: btn(primaryButtonStyle), disabled: busy,
          onClick: () => void ctrl.runInstall(installSpec) }, '安装')),
      el('p', { style: hintStyle }, '安装走 DSH 自身的 pnpm 路径，只装该包及其 pnpm 依赖；它的 @dsh-enhanced peer bundle 与 Host 服务不会自动安装，缺失项会显示在卡片里。安装/启用后如提示需要重启 profile，请依提示操作。'),
      el('details', { style: { marginTop: 4, borderTop: `1px solid ${hairline}`, paddingTop: 10 } },
        el('summary', { style: { fontSize: 12, fontWeight: 500, color: muted, cursor: 'pointer' } }, '高级：合并配置（只对声明了 live 字段的条目生效）'),
        el('div', { style: { display: 'grid', gap: 8, marginTop: 10 } },
          el('label', { style: { display: 'grid', gap: 4, fontSize: 12, color: muted } }, '选择插件条目 (entry)',
            el('select', {
              'aria-label': '选择插件条目',
              value: customEntryMode || pluginEntries.length === 0 ? CUSTOM_MODEL_OPTION : bundleEntry,
              disabled: busy,
              style: inputStyle,
              onChange: (event: { target: { value: string } }) => {
                const picked = event.target.value
                if (picked === CUSTOM_MODEL_OPTION) {
                  setCustomEntryMode(true)
                  return
                }
                setCustomEntryMode(false)
                setBundleEntry(picked)
              },
            },
            el('option', { value: '' }, '选择已加载条目…'),
            ...pluginEntries.map(plugin => el('option', { key: plugin.entryId, value: plugin.entryId },
              `${plugin.entryId} (${plugin.moduleName})`)),
            el('option', { value: CUSTOM_MODEL_OPTION }, '手动输入 entry ID…'))),
          customEntryMode || pluginEntries.length === 0
            ? field('entry', bundleEntry, setBundleEntry, 'dsh-enhanced-...')
            : null,
          el('textarea', { value: bundleJson, rows: 4, 'aria-label': '合并配置 JSON',
            style: { ...inputStyle, fontFamily: monoFont, fontSize: 12, resize: 'vertical' },
            onChange: (event: { target: { value: string } }) => setBundleJson(event.target.value) }),
          el('div', { style: actionsStyle },
            el('button', { style: btn(), disabled: busy, onClick: () => {
              try {
                const parsed = JSON.parse(bundleJson) as Readonly<Record<string, unknown>>
                void ctrl.run(() => remote.configureBundle(bundleEntry, parsed))
              } catch { ctrl.setError('配置必须是 JSON 对象') }
            } }, '应用配置'))))))
}

export function bannerStyle(color: string) {
  return { margin: 0, display: 'flex', gap: 10, alignItems: 'baseline', padding: '10px 14px', borderRadius: 10, fontSize: 13,
    color: ink, background: tint(color, 10), border: `1px solid ${tint(color, 30)}` }
}

export function StatusBanners({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { error, notice, status } = ctrl
  return el('div', { style: { display: 'grid', gap: 10 } },
    error === '' ? null : el('p', { role: 'alert', style: { ...bannerStyle(danger), fontWeight: 500 } },
      el('span', { 'aria-hidden': true, style: { color: danger, fontWeight: 700 } }, '!'), error),
    status !== undefined && (status.host.settings === false || status.host.pluginManager === false)
      ? el('p', { role: 'status', style: { ...bannerStyle(accent), fontSize: 12 } },
        `Host 服务不完整：settings ${status.host.settings ? '已加载' : '未加载'}、`
        + `pluginManager ${status.host.pluginManager ? '已加载' : '未加载'}；相关卡片只显示不可用，不能写入。`)
      : null,
    notice === '' ? null : el('p', { role: 'status', style: bannerStyle(accent) },
      el('span', { 'aria-hidden': true, style: { color: accent, fontWeight: 700 } }, 'i'), notice))
}

export function WenyaoSectionIcon(props: Readonly<{ size?: number; active?: boolean }>) {
  const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
  return el('span', {
    'aria-hidden': true,
    style: {
      display: 'block',
      width: size,
      height: size,
      borderRadius: '50%',
      overflow: 'hidden',
      flex: 'none',
      boxShadow: props?.active ? `0 0 0 1.5px ${accent}` : 'none',
    },
  }, el('img', {
    src: WENYAO_ICON_DATA_URI,
    alt: '',
    'aria-hidden': 'true',
    draggable: false,
    width: size,
    height: size,
    style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
  }))
}

function detailRow(label: string, value: unknown, hint?: string) {
  return row(label, hint !== undefined && hint !== ''
    ? el('div', { style: { display: 'grid', gap: 2 } }, value, el('div', { style: { fontSize: 11, color: muted } }, hint))
    : value)
}

function controlField(label: string, control: unknown) {
  return el('label', { style: { display: 'grid', gap: 6 } },
    el('span', { style: { fontSize: 12, color: muted } }, label),
    control)
}

export function AutonomyWizardCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { remote, status, autonomySetup, modelCatalog, loadingModelCatalog, busy } = ctrl
  const initialRoute = autonomySetup?.modelRoute.provider
    ? autonomySetup.modelRoute
    : status?.defaultModel?.provider
      ? status.defaultModel
      : undefined
  const initialProvider = initialRoute?.provider ?? ''
  const [tier, setTier] = useState<AutonomyBudgetTier>(autonomySetup?.activeTier ?? 'conservative')
  const [provider, setProvider] = useState<string>(initialProvider)
  const [model, setModel] = useState<string>(
    initialRoute?.model || (initialProvider === 'traex-agent' || initialProvider === 'agy-agent' ? 'default' : ''),
  )
  const [effort, setEffort] = useState<string>(initialRoute?.reasoningEffort ?? '')
  const [enableMemory, setEnableMemory] = useState<boolean>(
    autonomySetup?.grants.memoryLearning.configured ? autonomySetup.grants.memoryLearning.enabled : true,
  )
  const [enableDreaming, setEnableDreaming] = useState<boolean>(
    autonomySetup?.grants.dreaming.configured ? autonomySetup.grants.dreaming.enabled : true,
  )
  const [enableGrowth, setEnableGrowth] = useState<boolean>(
    autonomySetup?.grants.growthDriver.configured ? autonomySetup.grants.growthDriver.enabled : true,
  )
  const [workItemExp, setWorkItemExp] = useState<boolean>(autonomySetup?.grants.memoryLearning.workItemExperiences ?? false)
  const [customBudget, setCustomBudget] = useState<AutonomyBudgetLimits>(
    autonomySetup?.activeBudgets ?? AUTONOMY_TIER_DEFAULTS.conservative,
  )
  const syncedRef = useRef(false)
  const userEditedRouteRef = useRef(false)

  useEffect(() => {
    if (autonomySetup === undefined || syncedRef.current) return
    syncedRef.current = true
    setTier(autonomySetup.activeTier)
    setCustomBudget(autonomySetup.activeBudgets)
    if (autonomySetup.grants.memoryLearning.configured || autonomySetup.grants.dreaming.configured || autonomySetup.grants.growthDriver.configured) {
      setEnableMemory(autonomySetup.grants.memoryLearning.enabled || !autonomySetup.grants.memoryLearning.configured)
      setEnableDreaming(autonomySetup.grants.dreaming.enabled || !autonomySetup.grants.dreaming.configured)
      setEnableGrowth(autonomySetup.grants.growthDriver.enabled || !autonomySetup.grants.growthDriver.configured)
    }
    setWorkItemExp(autonomySetup.grants.memoryLearning.workItemExperiences)
  }, [autonomySetup])

  useEffect(() => {
    if (userEditedRouteRef.current) return
    const nextProvider = status?.defaultModel?.provider?.trim() ?? ''
    if (nextProvider === '') return
    setProvider(nextProvider)
    setModel(status?.defaultModel?.model?.trim() || (nextProvider === 'traex-agent' || nextProvider === 'agy-agent' ? 'default' : ''))
    setEffort(status?.defaultModel?.reasoningEffort?.trim() ?? '')
  }, [status?.defaultModel?.provider, status?.defaultModel?.model, status?.defaultModel?.reasoningEffort])

  useEffect(() => {
    if (userEditedRouteRef.current) return
    const nextProvider = autonomySetup?.modelRoute.provider?.trim() ?? ''
    if (nextProvider === '') return
    setProvider(nextProvider)
    setModel(autonomySetup?.modelRoute.model?.trim() || (nextProvider === 'traex-agent' || nextProvider === 'agy-agent' ? 'default' : ''))
    setEffort(autonomySetup?.modelRoute.reasoningEffort?.trim() ?? '')
  }, [autonomySetup?.modelRoute.provider, autonomySetup?.modelRoute.model, autonomySetup?.modelRoute.reasoningEffort])

  const effectiveCatalog = resolveEffectiveModelCatalog({ modelCatalog, status, autonomySetup })
  const canSubmitRpc = typeof remote.configureAutonomySetup === 'function'
  const effectiveBudgets = tier === 'custom' ? customBudget : AUTONOMY_TIER_DEFAULTS[tier]
  const isAcpRoute = provider === 'traex-agent' || provider === 'agy-agent'
  const effectiveModel = isAcpRoute && model.trim() === '' ? 'default' : model.trim()

  const applyTier = (nextTier: AutonomyBudgetTier) => {
    setTier(nextTier)
    if (nextTier !== 'custom') setCustomBudget(AUTONOMY_TIER_DEFAULTS[nextTier])
  }

  const updateBudgetNum = (key: keyof AutonomyBudgetLimits, raw: string, min: number, max: number) => {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return
    setTier('custom')
    setCustomBudget(prev => ({ ...prev, [key]: Math.min(max, Math.max(min, parsed)) }))
  }

  const invokeSetup = (action: AutonomySetupAction) => {
    if (!canSubmitRpc) return
    void ctrl.run(async () => {
      const res = await remote.configureAutonomySetup!(
        action, tier, provider.trim(), effectiveModel, effort.trim(),
        enableMemory, enableDreaming, enableGrowth, workItemExp, effectiveBudgets,
      )
      if (res.ok && res.value.applied) userEditedRouteRef.current = false
      return res
    })
  }

  const ownerTone: StatusTone = autonomySetup?.ownerRoute.active ? 'ok' : autonomySetup?.ownerRoute.configured ? 'warn' : 'error'
  const modelTone: StatusTone = autonomySetup?.modelRoute.ready ? 'ok' : 'warn'
  const scopeTone: StatusTone = autonomySetup?.profile.dbPathsScoped === false ? 'error' : 'ok'
  const policyTone: StatusTone = autonomySetup?.grants.assistantPolicy.ready ? 'ok' : 'warn'

  const grantLine = (label: string, ready: boolean, detail: string) => el('div', {
    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, border: `1px solid ${hairline}` },
  },
  el('span', { style: { fontWeight: 500 } }, label),
  el('span', { style: { fontSize: 12, color: muted } }, `${ready ? '已授权' : '未就绪'} · ${detail}`))

  const checkboxRow = (label: string, checked: boolean, onChange: (v: boolean) => void, note: string) => el('label', {
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, border: `1px solid ${hairline}`, cursor: 'pointer' },
  },
  el('input', { type: 'checkbox', checked, onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked) }),
  el('span', { style: { fontWeight: 500 } }, label),
  el('span', { style: { fontSize: 11, color: muted } }, note))

  const hasSetupBlockers = autonomySetup !== undefined && (!autonomySetup.ownerRoute.active || !autonomySetup.profile.dbPathsScoped)

  return card(
    '自主能力、记忆学习与做梦一键授权向导',
    '先检查 owner 路由、模型路线、$DSH_HOME 隔离与有限预算门禁，再一次完成三权分立授权；也可随时安全暂停并保留既有账本',
    el('div', { 'data-owner-console-card': 'autonomy-wizard', style: listStyle },
      el('div', { style: actionsStyle },
        pill(autonomySetup?.ownerRoute.active ? `Owner 路由已激活 (${autonomySetup.ownerRoute.channel})` : autonomySetup?.ownerRoute.configured ? 'Owner 路由待认领' : 'Owner 路由缺失', ownerTone),
        pill(autonomySetup?.modelRoute.ready ? `模型路线 ${autonomySetup.modelRoute.provider}` : '模型路线待配置', modelTone),
        pill(autonomySetup?.profile.dbPathsScoped === false ? 'DB 路径未隔离' : '$DSH_HOME 隔离正常', scopeTone),
        pill(autonomySetup?.grants.assistantPolicy.ready ? `Policy 就绪 · ${autonomySetup.grants.assistantPolicy.rulesCount} 规则` : 'Policy 待写入', policyTone)),
      autonomySetup === undefined
        ? placeholder('正在检测当前 $DSH_HOME profile 与授权状态（或当前 Host 未暴露一键向导 RPC）…')
        : el('div', { style: listStyle },
          detailRow('Profile / $DSH_HOME',
            el('div', { style: monoMuted }, `${autonomySetup.profile.profileName} · ${autonomySetup.profile.dshHome ?? '未检测到 DSH_HOME'}`),
            autonomySetup.profile.patchPath ?? undefined),
          detailRow('Active Owner 路由',
            el('div', { style: monoMuted }, autonomySetup.ownerRoute.authorityId
              ? `${autonomySetup.ownerRoute.authorityId} · ${autonomySetup.ownerRoute.principalId ?? ''}`
              : '未绑定激活的 Owner 路由'),
            autonomySetup.ownerRoute.missingReason ?? undefined),
          autonomySetup.blockingReasons.length > 0
            ? el('div', { style: bannerStyle(danger) },
              el('div', { style: { display: 'grid', gap: 8 } },
                el('span', {}, `前置阻塞：${autonomySetup.blockingReasons.join('；')}`),
                typeof remote.applyDoctorRepair === 'function'
                  ? el('div', { style: actionsStyle },
                    el('button', {
                      type: 'button',
                      style: idle(primaryButtonStyle, busy),
                      disabled: busy,
                      onClick: () => void ctrl.run(() => remote.applyDoctorRepair!([])),
                    }, '一键初始化/修复前置项'))
                  : null))
            : null,
          el('div', { style: gridStyle },
            grantLine('记忆自学习（三权分立）',
              autonomySetup.grants.memoryLearning.enabled && autonomySetup.grants.memoryLearning.threeAuthoritiesIndependent,
              autonomySetup.grants.memoryLearning.expired
                ? '租约已过期'
                : autonomySetup.grants.memoryLearning.threeAuthoritiesIndependent
                  ? 'extract / review / adopt 独立'
                  : '尚未签发三权分立授权'),
            grantLine('自主做梦灵感',
              autonomySetup.grants.dreaming.enabled,
              autonomySetup.grants.dreaming.retired
                ? '已安全暂停（retired）'
                : autonomySetup.grants.dreaming.maxDreamsPerDay !== null
                  ? `上限 ${autonomySetup.grants.dreaming.maxDreamsPerDay}/日`
                  : '未配置'),
            grantLine('技能与工作流演化',
              autonomySetup.grants.growthDriver.enabled,
              autonomySetup.grants.growthDriver.usageEnabled ? '已含 usageLearning' : '未启用')),
          el('div', { style: { display: 'grid', gap: 8 } },
            typeof remote.modelCatalog === 'function'
              ? el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                el('span', { style: { fontSize: 12, color: muted } }, '选择默认模型、编程工具与推理强度（同 /model）'),
                el('button', {
                  type: 'button',
                  style: idle(buttonStyle, busy || loadingModelCatalog),
                  disabled: busy || loadingModelCatalog,
                  onClick: () => void ctrl.refreshModelCatalog(true),
                }, loadingModelCatalog ? '刷新中…' : '刷新模型列表'))
              : null,
            jsx(ModelRouteSelects, {
              catalog: effectiveCatalog,
              provider,
              model,
              reasoningEffort: effort,
              disabled: busy,
              onChange: (next: Readonly<{ provider: string; model: string; reasoningEffort: string }>) => {
                userEditedRouteRef.current = true
                setProvider(next.provider)
                setModel(next.model)
                setEffort(next.reasoningEffort)
              },
            })),
          el('div', { style: actionsStyle },
            el('span', { style: { fontSize: 12, color: muted } }, '有限预算档位：'),
            el('button', { type: 'button', style: tier === 'conservative' ? primaryButtonStyle : buttonStyle, onClick: () => applyTier('conservative') }, '保守 (10/2/5 日配额)'),
            el('button', { type: 'button', style: tier === 'balanced' ? primaryButtonStyle : buttonStyle, onClick: () => applyTier('balanced') }, '均衡 (25/6/15 日配额)'),
            el('button', { type: 'button', style: tier === 'custom' ? primaryButtonStyle : buttonStyle, onClick: () => applyTier('custom') }, '自定义有限配额')),
          tier === 'custom'
            ? el('div', { style: gridStyle },
              controlField('每日记忆提取 (1-10000)', el('input', { type: 'number', value: customBudget.dailyMemoryExtractions, style: inputStyle, onChange: (e: { target: { value: string } }) => updateBudgetNum('dailyMemoryExtractions', e.target.value, 1, 10_000) })),
              controlField('每日做梦上限 (1-24)', el('input', { type: 'number', value: customBudget.dailyDreams, style: inputStyle, onChange: (e: { target: { value: string } }) => updateBudgetNum('dailyDreams', e.target.value, 1, 24) })),
              controlField('每日演化评审 (1-1000)', el('input', { type: 'number', value: customBudget.dailyGrowthReviews, style: inputStyle, onChange: (e: { target: { value: string } }) => updateBudgetNum('dailyGrowthReviews', e.target.value, 1, 1_000) })),
              controlField('授权租期天数 (1-365)', el('input', { type: 'number', value: customBudget.grantLeaseDays, style: inputStyle, onChange: (e: { target: { value: string } }) => updateBudgetNum('grantLeaseDays', e.target.value, 1, 365) })))
            : el('div', { style: hintStyle },
              `当前配额：每日记忆提取 ${effectiveBudgets.dailyMemoryExtractions} / 每日扫描 ${effectiveBudgets.dailyMemoryScans} / 每日做梦 ${effectiveBudgets.dailyDreams} / 每日演化评审 ${effectiveBudgets.dailyGrowthReviews} / 租期 ${effectiveBudgets.grantLeaseDays} 天`),
          el('div', { style: gridStyle },
            checkboxRow('记忆自学习', enableMemory, setEnableMemory, 'extract + independent review + adopt'),
            checkboxRow('做梦灵感', enableDreaming, setEnableDreaming, '受控后台灵感与 owner 处置'),
            checkboxRow('技能演化', enableGrowth, setEnableGrowth, 'workflow + usageLearning'),
            checkboxRow('收录工单经验', workItemExp, setWorkItemExp, '默认关闭；三权配置同步写入')),
          el('div', { style: actionsStyle },
            el('button', {
              type: 'button',
              style: idle(primaryButtonStyle, busy || !canSubmitRpc || hasSetupBlockers),
              disabled: busy || !canSubmitRpc || hasSetupBlockers,
              onClick: () => invokeSetup('enable'),
            }, '授权开启记忆自学习 / 做梦 / 技能演化'),
            el('button', {
              type: 'button',
              style: idle(buttonStyle, busy || !canSubmitRpc),
              disabled: busy || !canSubmitRpc,
              onClick: () => invokeSetup('pause'),
            }, '安全暂停（保留账本）'),
            el('button', {
              type: 'button',
              style: idle(dangerButtonStyle, busy || !canSubmitRpc),
              disabled: busy || !canSubmitRpc,
              onClick: () => invokeSetup('disable'),
            }, '安全停用')))))
}

export function SelfUpgradeCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { remote, upgradeStatus, upgradePreview, checkingUpgrade, previewingUpgrade, busy } = ctrl
  const [upgradeArmed, setUpgradeArmed] = useState(false)
  const canCheck = typeof remote.checkSelfUpgrade === 'function'
  const canDryRun = typeof remote.dryRunSelfUpgrade === 'function'
  const canTrigger = typeof remote.runSelfUpgrade === 'function'

  const triggerConfirmedUpgrade = () => {
    if (!canTrigger) return
    setUpgradeArmed(false)
    void ctrl.run(() => remote.runSelfUpgrade!(true))
  }

  return card(
    '版本检查与自助升级',
    '只读核验当前 @dsh-enhanced 版本、绑定 Host (@deepseek-ai/dsh) 与 npm 最新版本；支持安全预演与明确确认后的带外后台升级',
    el('div', { 'data-owner-console-card': 'self-upgrade', style: listStyle },
      el('div', { style: actionsStyle },
        pill(upgradeStatus?.enhancedUpdateAvailable ? `发现新版本 ${upgradeStatus.latestEnhancedVersion}` : '已检查版本',
          upgradeStatus?.enhancedUpdateAvailable ? 'warn' : upgradeStatus?.offline ? 'neutral' : 'ok'),
        pill(upgradeStatus?.frozenSystemdProfile ? '受控 Linux systemd（仅终端升级）' : '本地 / macOS profile',
          upgradeStatus?.frozenSystemdProfile ? 'warn' : 'ok'),
        upgradeStatus?.offline ? pill('离线回退', 'warn') : null),
      upgradeStatus === undefined
        ? placeholder('尚未获取版本与 Host 绑定状态，点击下方「检查最新版本」可进行有界超时检查。')
        : el('div', { style: listStyle },
          detailRow('@dsh-enhanced 当前 / 最新',
            el('div', { style: monoMuted }, `${upgradeStatus.currentEnhancedVersion} -> ${upgradeStatus.latestEnhancedVersion ?? '离线未知'}`),
            `来源：${upgradeStatus.checkSource}${upgradeStatus.cached ? '（TTL 缓存）' : ''}`),
          detailRow('绑定 Host (@deepseek-ai/dsh)',
            el('div', { style: monoMuted }, `绑定 ${upgradeStatus.boundHostVersion ?? '未绑定 (.dsh-rsi-host.json)'} · 运行时 ${upgradeStatus.installedHostVersion ?? '未知'}${upgradeStatus.targetHostVersion ? ` -> ${upgradeStatus.targetHostVersion}` : ''}`),
            upgradeStatus.note),
          upgradeStatus.frozenSystemdProfile
            ? el('div', { style: bannerStyle(muted) }, `受控 Linux systemd profile 引导：${upgradeStatus.upgradeCommand}`)
            : null),
      upgradePreview === undefined
        ? null
        : el('div', { style: { padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, display: 'grid', gap: 4 } },
          el('div', { style: { fontWeight: 500 } }, `预演结果：${upgradePreview.summary}`),
          upgradePreview.warnings.length > 0
            ? el('div', { style: { fontSize: 12, color: danger } }, `提示 / 阻塞：${upgradePreview.warnings.join('；')}`)
            : null,
          el('div', { style: monoMuted }, `命令：${upgradePreview.command}`)),
      upgradeArmed && upgradeStatus !== undefined && !upgradeStatus.frozenSystemdProfile
        ? el('div', { style: bannerStyle(danger) },
          el('div', { style: { display: 'grid', gap: 8 } },
            el('span', {}, `即将启动独立后台进程执行：${upgradePreview?.command ?? upgradeStatus.upgradeCommand}（升级期间将先备份并校验账本，完成后需按日志重启 Host）。`),
            el('div', { style: actionsStyle },
              el('button', { type: 'button', style: idle(dangerButtonStyle, busy || !canTrigger), disabled: busy || !canTrigger, onClick: triggerConfirmedUpgrade }, '确认并启动后台升级'),
              el('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: () => setUpgradeArmed(false) }, '取消'))))
        : null,
      el('div', { style: actionsStyle },
        el('button', {
          type: 'button',
          style: idle(buttonStyle, checkingUpgrade || !canCheck),
          disabled: checkingUpgrade || !canCheck,
          onClick: () => void ctrl.checkUpgrade(true),
        }, checkingUpgrade ? '检查中…' : '检查最新版本'),
        el('button', {
          type: 'button',
          style: idle(buttonStyle, previewingUpgrade || !canDryRun),
          disabled: previewingUpgrade || !canDryRun,
          onClick: () => void ctrl.previewUpgrade(),
        }, previewingUpgrade ? '预演中…' : '升级预演'),
        upgradeStatus?.frozenSystemdProfile
          ? null
          : el('button', {
            type: 'button',
            style: idle(primaryButtonStyle, busy || !canTrigger || !upgradeStatus?.canTriggerDetached),
            disabled: busy || !canTrigger || !upgradeStatus?.canTriggerDetached,
            onClick: () => setUpgradeArmed(true),
          }, '准备自助升级'))))
}

export function growthDataStatePill(state: GrowthDataState): Readonly<{ label: string; tone: StatusTone }> {
  if (state === 'data') return { label: '有数据', tone: 'ok' }
  if (state === 'zero') return { label: '0（账本就绪，窗口内无记录）', tone: 'neutral' }
  return { label: '无数据（未启用/无账本）', tone: 'warn' }
}

function formatGrowthPct(ratePpm: number | null): string {
  return ratePpm === null ? '—' : `${(ratePpm / 10_000).toFixed(1)}%`
}

function formatGrowthSuppliers(suppliers: OwnerConsoleGrowthReport['suppliers']): string {
  const cost = (suppliers.totalCostUsdMicros / 1_000_000).toFixed(6)
  if (suppliers.suppliers.length === 0) return `运行 ${suppliers.totalRuns} 次 · $${cost}`
  const detail = suppliers.suppliers
    .map(s => `${s.supplier}(${s.runs}次${s.p50LatencyMs === null ? '' : `,p50=${s.p50LatencyMs}ms`})`)
    .join('、')
  return `运行 ${suppliers.totalRuns} 次 · $${cost} · ${detail}`
}

export function GrowthReportCard({ remote }: Readonly<{ remote: ConsoleRemote }>) {
  const [sinceDays, setSinceDays] = useState<7 | 14 | 30>(7)
  const [report, setReport] = useState<OwnerConsoleGrowthReport>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const request = useRef(0)

  const load = (days: 7 | 14 | 30) => {
    if (typeof remote.growthReport !== 'function') return
    const id = ++request.current
    setBusy(true)
    setFailed('')
    void remote.growthReport('', '', days).then(res => {
      if (id !== request.current) return
      setBusy(false)
      if (res.ok) setReport(res.value)
      else setFailed(remoteFailureText(res.error))
    }, cause => {
      if (id !== request.current) return
      setBusy(false)
      setFailed(cause instanceof Error ? cause.message : String(cause))
    })
  }

  useEffect(() => {
    load(sinceDays)
    return subscribeConsoleRefresh(remote, () => load(sinceDays))
  }, [remote, sinceDays])

  const stateBadge = (state: GrowthDataState) => {
    const info = growthDataStatePill(state)
    return pill(info.label, info.tone)
  }

  const windowButton = (days: 7 | 14 | 30, label: string) => el('button', {
    type: 'button',
    style: idle(sinceDays === days ? primaryButtonStyle : buttonStyle, busy),
    disabled: busy,
    onClick: () => setSinceDays(days),
  }, label)

  return el('div', { 'data-owner-console-growth-report': '' },
    card('成长计分卡（只读）',
      el('p', { style: hintStyle }, '只汇总既有只读账本，不修改存储结构；明确区分「无数据（未启用/无账本）」与「数据为 0（窗口内无记录）」。'),
      el('div', { style: actionsStyle },
        windowButton(7, '最近 7 天'),
        windowButton(14, '最近 14 天（验收窗口）'),
        windowButton(30, '最近 30 天'),
        typeof remote.growthReport === 'function' ? el('button', {
          type: 'button',
          style: idle(buttonStyle, busy),
          disabled: busy,
          onClick: () => load(sinceDays),
        }, busy ? '读取中…' : '刷新读数') : null),
      failed !== '' ? el('p', { role: 'alert', style: { margin: 0, fontSize: 12, color: danger } }, `读取计分卡失败：${failed}`) : null,
      typeof remote.growthReport !== 'function'
        ? placeholder('当前 Host 尚未暴露只读成长计分卡接口；可在终端运行 dsh-rsi growth-report --since 7d。')
        : report === undefined
          ? placeholder(busy ? '正在汇总跨账本成长指标…' : '点击“刷新读数”加载最近窗口的成长指标。')
          : el('div', { style: gridStyle },
            el('div', { style: listStyle },
              row('总体数据状态', stateBadge(report.overallState)),
              row('1. 任务与主人反馈', el('span', { style: actionsStyle },
                stateBadge(report.tasks.state),
                report.tasks.state === 'no-data' ? null : el('span', { style: monoMuted },
                  `任务 ${report.tasks.totalTasks} · 纠正率 ${formatGrowthPct(report.tasks.correctionRatePpm)}（${report.tasks.ownerCorrections}） · 重做率 ${formatGrowthPct(report.tasks.reworkRatePpm)} · 撤回率 ${formatGrowthPct(report.tasks.withdrawalRatePpm)} · 趋势 ${report.tasks.trend === 'improving' ? '改善' : report.tasks.trend === 'regressing' ? '退化' : report.tasks.trend === 'flat' ? '持平' : '样本不足'}`))),
              row('2. 记忆与提示词暴露', el('span', { style: actionsStyle },
                stateBadge(report.memory.state),
                report.memory.state === 'no-data' ? null : el('span', { style: monoMuted },
                  `新增 ${report.memory.newMemories}（有来源 ${report.memory.sourcedMemories} / 撤回 ${report.memory.withdrawnOrRemovedMemories}） · 暴露 ${report.memory.promptExposures} 次 · 暴露后同类纠正 ${report.memory.postExposureSameClassCorrections}（${report.memory.sameClassCorrectionTrend === 'reduced' ? '已减少' : report.memory.sameClassCorrectionTrend === 'unchanged' ? '持平' : report.memory.sameClassCorrectionTrend === 'increased' ? '上升' : '样本不足'}）`))),
              row('3. 候选生成与采用', el('span', { style: actionsStyle },
                stateBadge(report.candidates.state),
                report.candidates.state === 'no-data' ? null : el('span', { style: monoMuted },
                  `候选 ${report.candidates.generated} · 通过 ${report.candidates.verificationPassed} · 失败 ${report.candidates.verificationFailed} · 采用 ${report.candidates.adopted} · 回滚 ${report.candidates.rolledBack}`))),
              row('4. 通知与 would-accept 吻合度', el('span', { style: actionsStyle },
                stateBadge(report.notifications.state),
                report.notifications.state === 'no-data' ? null : el('span', { style: monoMuted },
                  `送达 ${report.notifications.delivered}/${report.notifications.total} · 反应 ${report.notifications.reacted + report.notifications.accepted} · 忽略 ${report.notifications.ignoredOrExpired} · 吻合率 ${formatGrowthPct(report.notifications.agreementPpm)}（留出样本 ${report.notifications.holdoutDecidedSamples}/${report.notifications.looseningMinHoldoutSamples}）`))),
              row('5. 成本与延迟（按冻结 Supplier）', el('span', { style: actionsStyle },
                stateBadge(report.suppliers.state),
                report.suppliers.state === 'no-data' ? null : el('span', { style: monoMuted },
                  formatGrowthSuppliers(report.suppliers)))),
              row('记忆通道预登记门控（14d）', pill(
                report.memoryLaneGate.status === 'passed' ? '已达标'
                  : report.memoryLaneGate.status === 'attention-needed' ? '存在冲突待排查'
                    : report.memoryLaneGate.status === 'collecting' ? `采集中（纠正 ${report.memoryLaneGate.authenticatedCorrections}/${report.memoryLaneGate.minAuthenticatedCorrections} · 记忆 ${report.memoryLaneGate.sourcedMemories}/${report.memoryLaneGate.minSourcedMemories} · 暴露 ${report.memoryLaneGate.promptExposures}/${report.memoryLaneGate.minPromptExposures}）`
                      : '尚无账本数据',
                report.memoryLaneGate.status === 'passed' ? 'ok' : report.memoryLaneGate.status === 'attention-needed' ? 'error' : 'neutral',
              ))),
            el('p', { style: { ...hintStyle, fontFamily: monoFont } }, `终端复现命令：${report.cliCommand}`))))
}

export type SettingsCategory = 'all' | 'doctor' | 'models' | 'autonomy' | 'channels' | 'diagnostics'

const SETTINGS_CATEGORIES: readonly Readonly<{ id: SettingsCategory; label: string }>[] = Object.freeze([
  Object.freeze({ id: 'all', label: '全部' }),
  Object.freeze({ id: 'doctor', label: '体检自愈' }),
  Object.freeze({ id: 'models', label: '模型与工具' }),
  Object.freeze({ id: 'autonomy', label: '自主与成长' }),
  Object.freeze({ id: 'channels', label: '飞书与插件' }),
  Object.freeze({ id: 'diagnostics', label: '只读诊断' }),
])

/** Categorized, prioritized card deck shared by `WenyaoSettingsSection` and `OwnerConsoleSettingsPanel`. */
export function SettingsCardsDeck({ ctrl, remote }: Readonly<{ ctrl: ConsoleController; remote: ConsoleRemote }>) {
  const [category, setCategory] = useState<SettingsCategory>('all')
  const show = (target: Exclude<SettingsCategory, 'all'>) => category === 'all' || category === target

  return el('div', { 'data-owner-console-deck': category, style: { display: 'grid', gap: 16 } },
    el('nav', {
      'aria-label': '设置分组筛选',
      'data-owner-console-categories': '',
      style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
    },
    ...SETTINGS_CATEGORIES.map(item => el('button', {
      key: item.id,
      type: 'button',
      'data-owner-console-category': item.id,
      'aria-pressed': category === item.id,
      style: {
        ...(category === item.id ? primaryButtonStyle : buttonStyle),
        padding: '4px 10px',
        fontSize: 12,
      },
      onClick: () => setCategory(item.id),
    }, item.label))),
    show('doctor') ? jsx(DoctorRepairCard, { ctrl }) : null,
    show('models') ? jsx(CodingToolsCard, { ctrl }) : null,
    show('autonomy') ? jsx(AutonomyWizardCard, { ctrl }) : null,
    show('channels') ? jsx(FeishuCard, { ctrl }) : null,
    show('autonomy') ? jsx(GrowthReportCard, { remote }) : null,
    show('doctor') ? jsx(SelfUpgradeCard, { ctrl }) : null,
    show('autonomy') ? jsx(DreamingCard, { ctrl }) : null,
    show('autonomy') ? jsx(ProactiveWorkItemsCard, { ctrl }) : null,
    show('autonomy') ? jsx(GrowthMemoryCard, { ctrl }) : null,
    show('channels') ? jsx(BundlesCard, { ctrl }) : null,
    show('diagnostics') ? jsx(TrendSnapshotsCard, { remote }) : null,
    show('diagnostics') ? jsx(IntakeAgreementCard, { remote, availability: ctrl.status?.evaluation.intakeAgreement }) : null)
}

export function WenyaoSettingsSection({ remote, navigation, close }: Readonly<{
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
  close?: () => void
}>) {
  const ctrl = useStandaloneConsoleController(remote, navigation)
  const leaveThen = (fn: () => void) => () => {
    close?.()
    fn()
  }
  return el('div', {
    'data-owner-console-settings-section': 'wenyao-assistant',
    style: { display: 'grid', gap: 16, paddingBottom: 20, color: ink, fontSize: 13, lineHeight: 1.55 },
  },
  el('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '14px 16px', borderRadius: 12, border: `1px solid ${border}`, background: surface,
    },
  },
  el('div', { style: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 } },
    el('img', {
      src: WENYAO_SEAL_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false,
      width: 32, height: 32, style: { width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flex: 'none' },
    }),
    el('div', { style: { display: 'grid', gap: 2 } },
      el('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, '文鳐 Ray 助手设置'),
      el('p', { style: { margin: 0, fontSize: 12, color: muted, fontFamily: KAI_FONT } }, '小鳐小鳐，游而化飞 · 体检修复、模型路由与自主配置'))),
  el('div', { style: actionsStyle },
    el('button', { style: primaryButtonStyle, onClick: leaveThen(navigation.openConversation) }, '开始对话'),
    el('button', { style: buttonStyle, onClick: leaveThen(navigation.openPlugins) }, '插件页'),
    el('button', { style: buttonStyle, disabled: ctrl.busy, onClick: () => void ctrl.refresh() }, '刷新'))),
  jsx(StatusBanners, { ctrl }),
  jsx(SettingsCardsDeck, { ctrl, remote }))
}

export function GeneralCodingToolItem({ remote, navigation }: Readonly<{
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
}>) {
  const ctrl = useStandaloneConsoleController(remote, navigation)
  const { status, modelCatalog, busy, probingTool, traexProbe, agyProbe } = ctrl
  const activeProvider = status?.defaultModel?.provider ?? ''
  const activeModel = status?.defaultModel?.model ?? ''
  const effectiveCatalog = resolveEffectiveModelCatalog({ modelCatalog, status })
  const apiFallback = (status?.llmProviders ?? []).find(p => p.id !== 'traex-agent' && p.id !== 'agy-agent')
  const apiFallbackModel = apiFallback === undefined
    ? 'default'
    : (activeProvider === apiFallback.id && activeModel !== ''
      ? activeModel
      : (effectiveCatalog.providers.find(p => p.id === apiFallback.id)?.models[0]?.id ?? 'default'))
  const switchBtn = (provider: 'traex-agent' | 'agy-agent', label: string, enabled: boolean) => {
    const selected = activeProvider === provider
    return el('button', {
      type: 'button',
      style: idle(selected ? primaryButtonStyle : buttonStyle, busy),
      disabled: busy || typeof remote.setDefaultModelRoute !== 'function',
      onClick: () => void ctrl.run(() => remote.setDefaultModelRoute!(provider, 'default', '')),
    }, selected ? `${label}（默认）` : enabled ? label : `启用 ${label}`)
  }
  return el('div', {
    'data-owner-console-general-coding-tool': '',
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
      gap: 24, padding: '16px 0', borderBottom: `0.5px solid ${border}`, color: ink,
    },
  },
  el('div', { style: { minWidth: 0, flex: '1 1 260px' } },
    el('div', { style: { fontSize: 14, lineHeight: '20px', fontWeight: 500 } }, '默认编程工具（TraeX / Antigravity）'),
    el('div', { style: { marginTop: 4, color: muted, fontSize: 12, lineHeight: '18px' } },
      status === undefined
        ? '正在读取编程工具与默认模型路由…'
        : `当前默认：${activeProvider || '未配置'}${activeModel ? ` / ${activeModel}` : ''} · TraeX ${status.traex.enabled ? '已启用' : '未启用'} · Antigravity ${status.agy?.enabled ? '已启用' : '未启用'}`),
    ctrl.error === '' ? null : el('div', { role: 'alert', style: { marginTop: 4, fontSize: 12, color: danger } }, ctrl.error),
    ctrl.notice === '' ? null : el('div', { role: 'status', style: { marginTop: 4, fontSize: 12, color: accent } }, ctrl.notice),
    traexProbe ? el('div', { style: hintStyle }, `TraeX：${traexProbe.summary}`) : null,
    agyProbe ? el('div', { style: hintStyle }, `Antigravity：${agyProbe.summary}`) : null),
  el('div', { style: actionsStyle },
    switchBtn('traex-agent', 'TraeX', status?.traex.enabled === true),
    switchBtn('agy-agent', 'Antigravity', status?.agy?.enabled === true),
    apiFallback === undefined || typeof remote.setDefaultModelRoute !== 'function' ? null : el('button', {
      type: 'button',
      style: idle(activeProvider === apiFallback.id ? primaryButtonStyle : buttonStyle, busy),
      disabled: busy,
      onClick: () => void ctrl.run(() => remote.setDefaultModelRoute!(apiFallback.id, apiFallbackModel, '')),
    }, apiFallback.name || apiFallback.id),
    typeof remote.probeCodingTool !== 'function' ? null : el('button', {
      type: 'button',
      style: idle(buttonStyle, busy || probingTool !== undefined),
      disabled: busy || probingTool !== undefined,
      onClick: () => {
        void (async () => {
          await ctrl.probeTool('traex', status?.traex.command ?? '', true)
          await ctrl.probeTool('agy', status?.agy?.command ?? '', true)
        })()
      },
    }, probingTool !== undefined ? '探测中…' : '探测本机 CLI')))
}

export function ModelsCodingAgentsFooter({ remote, navigation }: Readonly<{
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
}>) {
  const ctrl = useStandaloneConsoleController(remote, navigation)
  const { status, busy, probingTool, traexProbe, agyProbe } = ctrl
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const activeProvider = status?.defaultModel?.provider ?? ''

  return el('div', { 'data-owner-console-models-footer': '', style: { marginTop: 16 } },
    card('本地编程工具（ACP：TraeX / Antigravity）',
      el('p', { style: hintStyle }, '本机已安装的编程 Agent 可通过 ACP 作为 DSH 模型路由复用；修改后立即对新会话生效。'),
      jsx(StatusBanners, { ctrl }),
      status === undefined ? placeholder('正在读取 ACP 状态…') : el('div', { style: gridStyle },
        el('div', { style: listStyle },
          row('TraeX (traex-agent)', el('span', { style: actionsStyle },
            pill(status.traex.enabled ? '已启用' : '未启用', status.traex.enabled ? 'ok' : 'neutral'),
            activeProvider === 'traex-agent' ? pill('默认', 'ok') : null,
            traexProbe ? pill(traexProbe.state, probeTone(traexProbe)) : null)),
          row('Antigravity (agy-agent)', el('span', { style: actionsStyle },
            pill(status.agy?.enabled ? '已启用' : '未启用', status.agy?.enabled ? 'ok' : 'neutral'),
            activeProvider === 'agy-agent' ? pill('默认', 'ok') : null,
            agyProbe ? pill(agyProbe.state, probeTone(agyProbe)) : null))),
        el('div', { style: actionsStyle },
          typeof remote.setDefaultModelRoute !== 'function' ? null : el('button', {
            style: btn(activeProvider === 'traex-agent' ? buttonStyle : primaryButtonStyle),
            disabled: busy,
            onClick: () => void ctrl.run(() => remote.setDefaultModelRoute!('traex-agent', 'default', '')),
          }, activeProvider === 'traex-agent' ? 'TraeX 已是默认' : '启用 TraeX 并设为默认'),
          typeof remote.setDefaultModelRoute !== 'function' ? null : el('button', {
            style: btn(activeProvider === 'agy-agent' ? buttonStyle : primaryButtonStyle),
            disabled: busy,
            onClick: () => void ctrl.run(() => remote.setDefaultModelRoute!('agy-agent', 'default', '')),
          }, activeProvider === 'agy-agent' ? 'Antigravity 已是默认' : '启用 Antigravity 并设为默认'),
          typeof remote.probeCodingTool !== 'function' ? null : el('button', {
            style: btn(),
            disabled: busy || probingTool !== undefined,
            onClick: () => {
              void (async () => {
                await ctrl.probeTool('traex', status.traex.command, true)
                await ctrl.probeTool('agy', status.agy?.command ?? '', true)
              })()
            },
          }, probingTool !== undefined ? '探测中…' : '探测就绪状态')),
        traexProbe === undefined ? null : el('p', { style: hintStyle },
          `TraeX：${traexProbe.summary}${traexProbe.remediation ? ` · ${traexProbe.remediation}` : ''}`),
        agyProbe === undefined ? null : el('p', { style: hintStyle },
          `Antigravity：${agyProbe.summary}${agyProbe.remediation ? ` · ${agyProbe.remediation}` : ''}`))))
}

const BUNDLE_CONFIG_SUMMARIES: Readonly<Record<string, string>> = {
  [TRAEX_PACKAGE]: '配置本机 TraeX 与 Antigravity (agy) ACP 编程代理路径与默认路由',
  [LARK_PACKAGE]: '配置飞书/Lark 长连接 appId、secret 引用（环境变量或 keychain）及状态诊断',
  [PROACTIVE_PACKAGE]: '查看主动准备草稿（unverified-draft）与 WP22 注意力放宽请求',
  [DREAMING_PACKAGE]: '管理自主做梦想法状态（已阅确认 / 验证通过 / 拒绝 / 休眠）',
  [GROWTH_PACKAGE]: '查看自主成长唤醒记录、usage 扫描状态与能力候选',
  [MEMORY_LEARNING_PACKAGE]: '查看长期记忆自动学习剩余额度、授权可用性与扫描统计',
}

export function BundleConfigSlotView({ packageName, view, remote, navigation }: Readonly<{
  packageName: string
  view?: 'summary' | 'page'
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
}>) {
  if (view === 'summary') {
    return el('span', {}, BUNDLE_CONFIG_SUMMARIES[packageName] ?? '管理此插件的运行状态与安全配置')
  }
  return jsx(BundleConfigPageBody, { packageName, remote, navigation })
}

function BundleConfigPageBody({ packageName, remote, navigation }: Readonly<{
  packageName: string
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
}>) {
  const ctrl = useStandaloneConsoleController(remote, navigation)
  return el('div', { 'data-owner-console-bundle-config': packageName, style: { display: 'grid', gap: 12, color: ink } },
    jsx(StatusBanners, { ctrl }),
    packageName === TRAEX_PACKAGE ? jsx(CodingToolsCard, { ctrl })
      : packageName === LARK_PACKAGE ? jsx(FeishuCard, { ctrl })
        : packageName === DREAMING_PACKAGE ? jsx(DreamingCard, { ctrl })
          : packageName === PROACTIVE_PACKAGE ? jsx(ProactiveWorkItemsCard, { ctrl })
            : jsx(GrowthMemoryCard, { ctrl }))
}

function doctorSeverityPill(severity: SetupDoctorIssue['severity']) {
  if (severity === 'error') return pill('严重异常', 'error')
  if (severity === 'warn') return pill('建议修复', 'warn')
  return pill('提示', 'neutral')
}

export function DoctorRepairCard({ ctrl }: Readonly<{ ctrl: ConsoleController }>) {
  const { remote, doctorReport, checkingDoctor, busy } = ctrl
  const canDoctor = typeof remote.setupDoctor === 'function'
  const canRepair = typeof remote.applyDoctorRepair === 'function'
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy || checkingDoctor)

  const headerPills = doctorReport === undefined
    ? null
    : el('div', { style: actionsStyle },
      pill(
        doctorReport.healthy ? '体检通过 · 配置与插件健康' : `发现 ${doctorReport.issues.length} 项可关注状态`,
        doctorReport.healthy ? 'ok' : doctorReport.issues.some(i => i.severity === 'error') ? 'error' : 'warn',
      ),
      doctorReport.autoFixableCount > 0 ? pill(`支持一键修复 ${doctorReport.autoFixableCount} 项`, 'warn') : null,
      doctorReport.frozenSystemdProfile ? pill('Linux 受控保护实例', 'neutral') : null)

  const summaryActions = !canDoctor ? null : el('div', { style: actionsStyle },
    doctorReport !== undefined && doctorReport.autoFixableCount > 0 && canRepair
      ? el('button', {
        type: 'button',
        style: idle(primaryButtonStyle, busy || checkingDoctor),
        disabled: busy || checkingDoctor,
        onClick: () => void ctrl.run(() => remote.applyDoctorRepair!([])),
      }, `一键全部自动修复（${doctorReport.autoFixableCount} 项）`)
      : null,
    el('button', {
      type: 'button',
      style: btn(),
      disabled: busy || checkingDoctor,
      onClick: () => void ctrl.checkDoctor(),
    }, checkingDoctor ? '体检中…' : '立即体检'))

  const body = !canDoctor
    ? el('p', { style: hintStyle }, '当前 Host 尚未暴露系统自动体检接口（请升级插件并重启 profile）。')
    : doctorReport === undefined
      ? placeholder('正在扫描插件冲突、Owner 路由与本机 CLI…')
      : doctorReport.issues.length === 0
        ? el('p', { style: hintStyle }, `当前 Profile（${doctorReport.profileName || 'default'}）插件兼容性、数据库隔离与本地路由均正常。`)
        : el('div', { style: { display: 'grid', gap: 10 } },
          ...doctorReport.issues.map(issue => el('div', {
            key: issue.id,
            'data-doctor-issue': issue.id,
            style: { display: 'grid', gap: 6, padding: '10px 12px', borderRadius: 10, border: `1px solid ${border}`, background: sunken },
          },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
            el('div', { style: actionsStyle },
              doctorSeverityPill(issue.severity),
              el('span', { style: { fontWeight: 600, color: ink } }, issue.title)),
            issue.autoFixable && canRepair
              ? el('button', {
                type: 'button',
                style: btn(primaryButtonStyle),
                disabled: busy || checkingDoctor,
                onClick: () => void ctrl.run(() => remote.applyDoctorRepair!([issue.id])),
              }, issue.fixLabel)
              : null),
          el('p', { style: hintStyle }, issue.detail),
          issue.copyCommand ? commandCopyRow(issue.copyCommand, ctrl, busy || checkingDoctor) : null)))

  return card('系统体检与一键自动修复',
    el('div', { 'data-owner-console-card': 'doctor-repair', style: { display: 'grid', gap: 10 } },
      headerPills,
      summaryActions,
      body))
}

export function ModelsProviderSetupCard({ provider, configured, keyConfigured, remote, navigation }: Readonly<{
  provider?: Readonly<{
    id?: string | undefined
    provider?: string | undefined
    name?: string | undefined
    displayName?: string | undefined
    settingsNs?: string | undefined
  }> | undefined
  configured?: boolean | undefined
  keyConfigured?: boolean | undefined
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
}>) {
  const ctrl = useStandaloneConsoleController(remote, navigation)
  const { status, modelCatalog, busy, probingTool, traexProbe, agyProbe } = ctrl
  const [traexModel, setTraexModel] = useState('default')
  const [traexEffort, setTraexEffort] = useState('')
  const [agyModel, setAgyModel] = useState('default')
  const [agyEffort, setAgyEffort] = useState('')
  const editedToolsRef = useRef<{ traex: boolean; agy: boolean }>({ traex: false, agy: false })
  const autoProbedRef = useRef(false)
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)

  const focusId = (provider?.provider?.trim() || provider?.id?.trim()) || undefined
  const showTraex = focusId === undefined || focusId === 'traex-agent'
  const showAgy = focusId === undefined || focusId === 'agy-agent'
  const effectiveCatalog = resolveEffectiveModelCatalog({ modelCatalog, status })

  useEffect(() => {
    if (status === undefined) return
    if (!editedToolsRef.current.traex && status.defaultModel?.provider === 'traex-agent') {
      setTraexModel(status.defaultModel.model || 'default')
      setTraexEffort(status.defaultModel.reasoningEffort ?? '')
    }
    if (!editedToolsRef.current.agy && status.defaultModel?.provider === 'agy-agent') {
      setAgyModel(status.defaultModel.model || 'default')
      setAgyEffort(status.defaultModel.reasoningEffort ?? '')
    }
  }, [status?.defaultModel?.provider, status?.defaultModel?.model, status?.defaultModel?.reasoningEffort])

  useEffect(() => {
    if (status === undefined || autoProbedRef.current || typeof remote.probeCodingTool !== 'function') return
    autoProbedRef.current = true
    if (showTraex) void ctrl.probeTool('traex', status.traex.command, false, false)
    if (showAgy) void ctrl.probeTool('agy', status.agy?.command ?? '', false, false)
  }, [status === undefined])

  const renderTool = (tool: 'traex' | 'agy', routeId: 'traex-agent' | 'agy-agent', label: string, enabled: boolean, command: string, probe: CodingToolProbe | undefined) => {
    const isDefault = status?.defaultModel?.provider === routeId
    const resolvedCmd = probe?.discoveredPath ?? command
    const configureFn = tool === 'traex' ? remote.configureTraex : remote.configureAgy
    const selectedModel = tool === 'traex' ? traexModel : agyModel
    const selectedEffort = tool === 'traex' ? traexEffort : agyEffort
    const setModel = tool === 'traex' ? setTraexModel : setAgyModel
    const setEffort = tool === 'traex' ? setTraexEffort : setAgyEffort
    const isExactDefault = isDefault
      && (selectedModel || 'default') === (status?.defaultModel?.model || 'default')
      && selectedEffort === (status?.defaultModel?.reasoningEffort ?? '')

    const catalogProvider = effectiveCatalog.providers.find(p => p.id === routeId)
    const modelOptions = [...(catalogProvider?.models ?? [])]
    if (!modelOptions.some(m => m.id === 'default')) {
      modelOptions.unshift({ id: 'default', name: `${tool === 'agy' ? 'Antigravity' : 'TraeX'} 默认模型 (default)`, efforts: [] })
    }
    if (selectedModel !== '' && !modelOptions.some(m => m.id === selectedModel)) {
      modelOptions.push({ id: selectedModel, name: `${selectedModel}（当前值）`, efforts: [] })
    }
    const effortInfo = resolveEffortOptions(effectiveCatalog, routeId, selectedModel, selectedEffort)
    const compactSelectStyle = { ...inputStyle, padding: '4px 8px', fontSize: 12, width: 'auto', minWidth: 130 }

    return el('div', {
      key: routeId,
      'data-models-provider-tool': tool,
      style: { display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 10, border: `1px solid ${border}`, background: sunken },
    },
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
      el('span', { style: { fontWeight: 600, color: ink } }, label),
      el('div', { style: actionsStyle },
        pill(enabled ? '路由已启用' : '未启用', enabled ? 'ok' : 'warn'),
        isDefault ? pill('默认模型', 'ok') : null,
        probe ? pill(probe.state, probeTone(probe)) : null)),
    el('p', { style: hintStyle },
      probe !== undefined
        ? `${probe.summary}${probe.discoveredPath ? ` · 路径：${probe.discoveredPath}` : ''}`
        : `当前配置命令：${command || tool}${configured === true ? '（条目已配置）' : ''}${keyConfigured === true ? '（Host 标记已就绪）' : ''}`),
    typeof remote.setDefaultModelRoute !== 'function' ? null : el('div', { style: { ...actionsStyle, alignItems: 'center' } },
      el('select', {
        'aria-label': `${label} 模型选择`,
        'data-model-route-select': 'model',
        value: selectedModel,
        disabled: busy,
        style: compactSelectStyle,
        onChange: (event: { target: { value: string } }) => {
          editedToolsRef.current[tool] = true
          const next = cascadeModelChange(effectiveCatalog, routeId, event.target.value, selectedEffort)
          setModel(next.model)
          setEffort(next.reasoningEffort)
        },
      }, ...modelOptions.map(opt => el('option', { key: opt.id, value: opt.id },
        opt.name !== opt.id ? `${opt.name} (${opt.id})` : opt.id))),
      el('select', {
        'aria-label': `${label} 推理强度`,
        'data-model-route-select': 'effort',
        value: selectedEffort,
        disabled: busy,
        style: compactSelectStyle,
        onChange: (event: { target: { value: string } }) => {
          editedToolsRef.current[tool] = true
          setEffort(event.target.value)
        },
      },
      el('option', { value: '' }, effortInfo.defaultLabel),
      ...effortInfo.options.map(opt => el('option', { key: opt.value, value: opt.value }, opt.label)))),
    el('div', { style: actionsStyle },
      typeof configureFn === 'function' && (!enabled || probe?.needsPathPin)
        ? el('button', {
          type: 'button',
          style: btn(primaryButtonStyle),
          disabled: busy,
          onClick: () => void ctrl.run(() => configureFn(true, resolvedCmd || tool)),
        }, probe?.discoveredPath ? `一键绑定路径并启用 (${tool})` : `启用 ${tool}`)
        : null,
      typeof remote.setDefaultModelRoute === 'function'
        ? el('button', {
          type: 'button',
          style: btn(isExactDefault ? buttonStyle : primaryButtonStyle),
          disabled: busy,
          onClick: () => {
            editedToolsRef.current[tool] = false
            void ctrl.run(() => remote.setDefaultModelRoute!(routeId, selectedModel || 'default', selectedEffort))
          },
        }, isExactDefault ? '当前已是默认' : isDefault ? '更新默认模型' : `设为默认模型 (${routeId})`)
        : null,
      typeof remote.probeCodingTool === 'function'
        ? el('button', {
          type: 'button',
          style: btn(),
          disabled: busy || probingTool !== undefined,
          onClick: () => void ctrl.probeTool(tool, command, true, true),
        }, probingTool === tool ? '探测中…' : '重新探测')
        : null),
    probe?.state === 'auth-required' && probe.loginCommand
      ? commandCopyRow(probe.loginCommand, ctrl, busy, () => void ctrl.probeTool(tool, command, true, true))
      : null)
  }

  return el('div', {
    'data-owner-console-models-provider-card': focusId || 'dsh-enhanced-traex-acp-provider',
    style: { display: 'grid', gap: 10, paddingTop: 6, color: ink, fontSize: 13 },
  },
  jsx(StatusBanners, { ctrl }),
  status === undefined
    ? placeholder('正在探测本地 TraeX / Antigravity ACP 状态…')
    : el('div', { style: { display: 'grid', gap: 10 } },
      showTraex ? renderTool('traex', 'traex-agent', 'TraeX Agent (local ACP)', status.traex.enabled, status.traex.command, traexProbe) : null,
      showAgy ? renderTool('agy', 'agy-agent', 'Antigravity Agent (local ACP)', status.agy?.enabled === true, status.agy?.command ?? '', agyProbe) : null))
}
