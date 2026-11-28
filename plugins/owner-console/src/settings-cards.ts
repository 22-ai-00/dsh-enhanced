import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { KAI_FONT, QUIET_PHRASE } from './art.js'
import { WENYAO_ICON_DATA_URI, WENYAO_SEAL_DATA_URI } from './artwork.js'
import { CUSTOM_BUNDLE_OPTION, INSTALL_ALL_AVAILABLE_OPTION, resolveUninstalledBundles } from './bundle-catalog.js'
import { CUSTOM_MODEL_OPTION, ModelRouteSelects, resolveEffectiveModelCatalog, resolveEffortOptions, cascadeModelChange } from './model-route-ui.js'
import type { OwnerSelfIterationAction } from './nl-control.js'
import { componentState, DEPENDENCY_BUNDLES, missingRemedy, repairPatch, type ComponentState } from './state.js'
import {
  AUTONOMY_TIER_DEFAULTS,
  type AssistantChatContext, type AssistantVersionReport, type AutonomyBudgetLimits, type AutonomyBudgetTier, type AutonomySetupAction,
  type AutonomySetupStatus, type CodingToolProbe, type FeishuQrOnboardingSnapshot, type FeishuQrOwnerBinding,
  type GrowthDataState, type IntakeAgreementAvailability,
  type OwnerConsoleAssistantOverview, type OwnerConsoleControlActionResult, type OwnerConsoleGrowthReport, type OwnerConsoleIntakeAgreement,
  type OwnerConsoleIntakeAgreementHistory, type OwnerConsoleModelCatalog, type OwnerConsoleRaySelfState, type OwnerConsoleStatus,
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

export interface BatchInstallProgress {
  readonly total: number
  readonly index: number
  readonly current: string
  readonly completed: readonly string[]
  readonly needsRestart: boolean
  readonly stopping: boolean
}

export interface BatchInstallSummary {
  readonly requested: readonly string[]
  readonly completed: readonly string[]
  readonly needsRestart: boolean
  readonly stoppedByUser: boolean
  readonly failure?: { readonly spec: string; readonly reason: string }
}

export interface BatchInstallHooks {
  readonly shouldCancel?: () => boolean
  readonly onProgress?: (progress: BatchInstallProgress) => void
}

export async function installAvailableBundles(
  remote: Pick<ConsoleRemote, 'installProjectBundle'>,
  specs: readonly string[],
  confirm: (message: string) => boolean,
  hooks: BatchInstallHooks = {},
): Promise<BatchInstallSummary> {
  const targets: string[] = []
  const seen = new Set<string>()
  for (const raw of specs) {
    const trimmed = raw.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    targets.push(trimmed)
  }
  if (targets.length === 0) {
    return { requested: [], completed: [], needsRestart: false, stoppedByUser: false }
  }

  const completed: string[] = []
  let needsRestart = false
  let stoppedByUser = false

  for (let index = 0; index < targets.length; index++) {
    if (hooks.shouldCancel?.() === true) {
      stoppedByUser = true
      break
    }
    const spec = targets[index]!
    hooks.onProgress?.({
      total: targets.length,
      index,
      current: spec,
      completed: [...completed],
      needsRestart,
      stopping: false,
    })

    let cancelledDuringConfirm = false
    const guardedConfirm = (message: string): boolean => {
      if (hooks.shouldCancel?.() === true) {
        cancelledDuringConfirm = true
        return false
      }
      return confirm(message)
    }

    let result: RemoteResult<OwnerConsoleWriteResult>
    try {
      result = await installWithApproval(remote, spec, guardedConfirm)
    } catch (cause) {
      return {
        requested: targets,
        completed,
        needsRestart,
        stoppedByUser: false,
        failure: { spec, reason: cause instanceof Error ? cause.message : String(cause) },
      }
    }

    if (cancelledDuringConfirm) {
      stoppedByUser = true
      break
    }

    if (!result.ok) {
      return {
        requested: targets,
        completed,
        needsRestart,
        stoppedByUser: false,
        failure: { spec, reason: remoteFailureText(result.error) },
      }
    }
    if (!result.value.applied) {
      return {
        requested: targets,
        completed,
        needsRestart,
        stoppedByUser: false,
        failure: { spec, reason: result.value.note || '安装未应用' },
      }
    }

    completed.push(spec)
    if (/restart-required|重启/u.test(result.value.note)) needsRestart = true
    if (index + 1 < targets.length && hooks.shouldCancel?.() === true) {
      stoppedByUser = true
      break
    }
  }

  return {
    requested: targets,
    completed,
    needsRestart,
    stoppedByUser,
  }
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

export const OWN_PACKAGE = '@dsh-ray/owner-console'
export const LARK_PACKAGE = '@dsh-ray/lark-channel'
export const TRAEX_PACKAGE = '@dsh-ray/traex-acp-provider'
export const DREAMING_PACKAGE = '@dsh-ray/assistant-dreaming'
export const PROACTIVE_PACKAGE = '@dsh-ray/assistant-proactive'
export const GROWTH_PACKAGE = '@dsh-ray/assistant-growth-driver'
export const MEMORY_LEARNING_PACKAGE = '@dsh-ray/assistant-memory-learning'
const LARK_COMPANION_BUNDLES = ['@dsh-ray/assistant-delivery', '@dsh-ray/credentials-keychain'] as const

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
  promoteFeishuQrOwner?(sessionId: string, confirmed: boolean): Promise<RemoteResult<FeishuQrOnboardingSnapshot>>
  restartProfile?(confirmed: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  controlSelfIteration?(action: OwnerSelfIterationAction, confirmed: boolean): Promise<RemoteResult<OwnerConsoleControlActionResult>>
  versionInfo?(): Promise<RemoteResult<AssistantVersionReport>>
  modelCatalog?(force: boolean): Promise<RemoteResult<OwnerConsoleModelCatalog>>
  assistantChatContext?(): Promise<RemoteResult<AssistantChatContext>>
  registerAssistantSession?(sessionId: string, makeActive: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  raySelfSnapshot?(): Promise<RemoteResult<OwnerConsoleRaySelfState>>
  vetoRaySelf?(targetEntryId: string, targetCapabilityId: string, reason: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  decideRayKernelProposal?(proposalId: string, decision: 'approved' | 'rejected'): Promise<RemoteResult<OwnerConsoleWriteResult>>
  importRayHome?(sourceDir: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
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
  readonly batchInstall?: BatchInstallProgress | undefined
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
  syncUpgradeStatus?(): Promise<void>
  previewUpgrade(): Promise<void>
  run(action: () => Promise<RemoteResult<OwnerConsoleWriteResult>>): Promise<void>
  runInstall(spec: string): Promise<void>
  runBatchInstall?(specs: readonly string[]): Promise<void>
  cancelBatchInstall?(): void
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
  const [batchInstall, setBatchInstall] = useState<BatchInstallProgress | undefined>(undefined)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const mounted = useRef(true)
  const batchCancelRef = useRef(false)
  const batchRunningRef = useRef(false)
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

  const syncUpgradeStatus = async () => {
    if (typeof remote.checkSelfUpgrade !== 'function') return
    try {
      const result = await remote.checkSelfUpgrade(true)
      if (mounted.current && result.ok) setUpgradeStatus(result.value)
    } catch {
      // Quiet background poll keeps previous UI feedback intact.
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

  const cancelBatchInstall = () => {
    batchCancelRef.current = true
    setBatchInstall(current => current === undefined ? undefined : { ...current, stopping: true })
  }

  const runBatchInstall = async (specs: readonly string[]) => {
    if (batchRunningRef.current) return
    batchRunningRef.current = true
    batchCancelRef.current = false
    setBusy(true); setError(''); setNotice('')
    let blockedConfirmReason: string | undefined
    const batchConfirm = (message: string): boolean => {
      const answer = askOwner((globalThis as unknown as { confirm?: (message: string) => boolean }).confirm, message)
      const note = confirmationNotice(answer, message)
      if (note !== undefined) {
        if (answer === 'unavailable') {
          blockedConfirmReason = note
          setError(note)
        } else {
          blockedConfirmReason = '已取消安装脚本授权'
          setNotice(note)
        }
        return false
      }
      blockedConfirmReason = undefined
      return true
    }
    try {
      const summary = await installAvailableBundles(remote, specs, batchConfirm, {
        shouldCancel: () => batchCancelRef.current || !mounted.current,
        onProgress: progress => {
          if (mounted.current) setBatchInstall(progress)
        },
      })
      if (!mounted.current) return
      setBatchInstall(undefined)
      if (summary.requested.length === 0) {
        setNotice('没有可安装的可用插件。')
        return
      }
      if (summary.completed.length > 0) {
        await refresh()
        notifyConsoleRefresh(remote)
        if (!mounted.current) return
      }
      const restartSuffix = summary.needsRestart ? '，请重启 profile 以激活新插件。' : '。'
      if (summary.failure !== undefined) {
        if (summary.completed.length > 0) {
          setNotice(`已安装 ${summary.completed.length}/${summary.requested.length} 个插件（${summary.completed.join('、')}）${restartSuffix}`)
        }
        setError(`安装 ${summary.failure.spec} 时停止：${blockedConfirmReason ?? summary.failure.reason}`)
        return
      }
      if (summary.stoppedByUser) {
        setError('')
        setNotice(`已停止后续安装：已完成 ${summary.completed.length}/${summary.requested.length} 个（${summary.completed.join('、') || '无'}）${restartSuffix}`)
        return
      }
      setError('')
      setNotice(`已一键安装 ${summary.completed.length} 个可用插件${restartSuffix}`)
    } catch (cause) {
      if (mounted.current) {
        setBatchInstall(undefined)
        setError(cause instanceof Error ? cause.message : '批量安装失败')
      }
    } finally {
      batchRunningRef.current = false
      if (mounted.current) {
        setBatchInstall(undefined)
        setBusy(false)
      }
    }
  }

  return {
    remote, navigation, status, overview, autonomySetup, modelCatalog, loadingModelCatalog, upgradeStatus, upgradePreview,
    doctorReport, checkingDoctor,
    traexProbe, agyProbe, probingTool, checkingUpgrade, previewingUpgrade, batchInstall,
    busy, error, notice, setError, setNotice, refresh, refreshModelCatalog, checkDoctor, probeTool, checkUpgrade, syncUpgradeStatus, previewUpgrade,
    run, runInstall, runBatchInstall, cancelBatchInstall, confirmOwner,
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

function repairSection(
  ctrl: ConsoleController,
  state: ComponentState,
  packageName: string,
  onAfterRepair?: (result: OwnerConsoleWriteResult) => void,
) {
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, ctrl.busy)
  const hasDisabledDep = state.missing.some(item => item.state === 'disabled')
  const depButtons = state.missing.flatMap(item => {
    if (item.state === 'stalled') return []
    if (item.state === 'disabled') {
      const canDoctorRestorePolicy = item.service === 'assistantPolicy'
        && typeof ctrl.remote.applyDoctorRepair === 'function'
      return [el('button', {
        key: `${item.bundle}:enable`,
        type: 'button',
        'data-repair-enable-dep': item.bundle,
        style: btn(primaryButtonStyle),
        disabled: ctrl.busy,
        onClick: () => void ctrl.run(async () => {
          const res = canDoctorRestorePolicy
            ? await ctrl.remote.applyDoctorRepair!(['disabled-core-policy-provider'])
            : await ctrl.remote.setBundleEnabled(item.bundle, true)
          if (res.ok && res.value.applied) onAfterRepair?.(res.value)
          return res
        }),
      }, `启用 ${item.bundle}`)]
    }
    return [el('button', {
      key: item.bundle,
      type: 'button',
      style: btn(buttonStyle),
      disabled: ctrl.busy,
      onClick: () => void ctrl.runInstall(item.bundle),
    }, `安装 ${item.bundle}`)]
  })
  const showDoctorBtn = typeof ctrl.remote.applyDoctorRepair === 'function' && (state.stalled || state.kind === 'errored')
  const waitingOnlyNote = state.missing.filter(item => item.state === 'stalled')
  return el('div', { style: { display: 'grid', gap: 8 } },
    el('p', { style: hintStyle }, state.stalled
      ? hasDisabledDep
        ? `检测到前置组件已安装但未启用：${missingRemedy(state)}。点击下方按钮一键恢复启用后重启 profile 即可恢复${waitingOnlyNote.length > 0 ? `（${waitingOnlyNote.map(i => i.bundle).join('、')} 已启用，无需重复安装）` : ''}。`
        : `条目加载后完整实时配置才会生效。${missingRemedy(state) === '' ? '' : `${missingRemedy(state)}。`}修复依赖后重启 profile。`
      : `该条目当前不可写：${state.label}。`),
    depButtons.length === 0 && !showDoctorBtn ? null : el('div', { style: actionsStyle },
      ...depButtons,
      showDoctorBtn
        ? el('button', {
          type: 'button',
          style: btn(hasDisabledDep ? buttonStyle : primaryButtonStyle),
          disabled: ctrl.busy,
          onClick: () => void ctrl.run(async () => {
            const res = await ctrl.remote.applyDoctorRepair!([])
            if (res.ok && res.value.applied) onAfterRepair?.(res.value)
            return res
          }),
        }, '一键自动诊断与修复')
        : null),
    state.stalled || state.kind === 'errored'
      ? el('details', { style: { marginTop: 2 } },
        el('summary', { style: { fontSize: 11.5, color: caption, cursor: 'pointer' } }, '高级：查看最小故障排查 patch（仅在自动修复无法完成时参考）'),
        el('textarea', {
          readOnly: true,
          rows: 4,
          'aria-label': `${packageName} 最小修复 patch`,
          value: repairPatch(state, packageName),
          style: { ...inputStyle, fontFamily: monoFont, fontSize: 11, resize: 'vertical', marginTop: 6 },
        }))
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
    return '普通飞书私聊在重启 profile 后即可正常使用；主人专属命令（/permission、/model、审批卡片、反馈学习与自主授权/工作项准入）仍锚定在现有主主人。点击下方「一键设为飞书主主人」或「一键设为主主人并重启生效」即可直接完成切换（也可使用终端向导 dsh-lark-setup）。'
  }
  if (binding === 'not-returned' || binding === 'unmodified') {
    return '当前未自动绑定为飞书主主人；请先重启 profile 后确认身份状态，再按需一键切换主主人或使用终端向导 dsh-lark-setup。'
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
  const [activeQrAction, setActiveQrAction] = useState<null | 'promote' | 'restart' | 'promote-and-restart'>(null)
  const [qrRestarted, setQrRestarted] = useState(false)
  const [pendingQrAction, setPendingQrAction] = useState<null | 'promote' | 'restart' | 'promote-and-restart'>(null)
  const qrActionBusy = activeQrAction !== null
  const [qrCopied, setQrCopied] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState<'' | 'restart' | 'business'>('')
  const [qrNowMs, setQrNowMs] = useState(0)
  const [feishuNeedsRestart, setFeishuNeedsRestart] = useState(false)
  const [confirmCardRestart, setConfirmCardRestart] = useState(false)
  const [cardRestarting, setCardRestarting] = useState(false)
  const [confirmGuidePromote, setConfirmGuidePromote] = useState<null | 'promote' | 'promote-and-restart'>(null)
  const [guidePromoting, setGuidePromoting] = useState(false)
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
    setQrRestarted(false)
    setPendingQrAction(null)
    setQrCopied(false)
    setCopiedCmd('')
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

  useEffect(() => {
    if (copiedCmd === '') return
    const timer = setTimeout(() => setCopiedCmd(''), 2_000)
    return () => clearTimeout(timer)
  }, [copiedCmd])

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

  const copyPostScanCommand = async (kind: 'restart' | 'business', command: string) => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(command)
        setCopiedCmd(kind)
        ctrl.setNotice(kind === 'restart'
          ? '已复制重启命令，粘贴到终端运行即可生效。'
          : '已复制业务工具授权命令，粘贴到终端运行即可完成个人云文档/表格/邮件授权。')
        return
      }
    } catch {
      // Fall through to manual guidance.
    }
    ctrl.setNotice(`当前环境未开放剪贴板写入，请手动复制命令：${command}`)
  }

  const executePendingQrAction = async () => {
    const action = pendingQrAction
    if (action === null || qrActionBusy) return
    setPendingQrAction(null)
    if (action === 'restart') {
      if (typeof remote.restartProfile !== 'function') return
      setActiveQrAction('restart')
      ctrl.setError('')
      try {
        const res = await remote.restartProfile(true)
        if (!res.ok) {
          ctrl.setError(remoteFailureText(res.error))
          return
        }
        if (!res.value.applied) {
          ctrl.setError(res.value.note)
          return
        }
        setQrRestarted(true)
        ctrl.setNotice(res.value.note)
      } catch (cause) {
        ctrl.setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setActiveQrAction(null)
      }
      return
    }
    if (typeof remote.promoteFeishuQrOwner !== 'function' || qrSession === undefined) return
    const alsoRestart = action === 'promote-and-restart'
    setActiveQrAction(action)
    ctrl.setError('')
    try {
      const res = await remote.promoteFeishuQrOwner(qrSession.sessionId, true)
      if (!res.ok) {
        ctrl.setError(remoteFailureText(res.error))
        return
      }
      setQrSession(res.value)
      const promotedPrimary = res.value.ownerBinding === 'bound-owner' || res.value.ownerBinding === 'reused-owner'
      if (res.value.errorCode !== undefined || res.value.state !== 'completed' || !promotedPrimary) {
        ctrl.setError(res.value.note)
        return
      }
      ctrl.setNotice(res.value.note)
      notifyConsoleRefresh(remote)
      void ctrl.refresh()
      if (alsoRestart && typeof remote.restartProfile === 'function' && res.value.restartSupported === true) {
        const restartRes = await remote.restartProfile(true)
        if (!restartRes.ok) {
          ctrl.setError(remoteFailureText(restartRes.error))
          return
        }
        if (!restartRes.value.applied) {
          ctrl.setError(restartRes.value.note)
          return
        }
        setQrRestarted(true)
        ctrl.setNotice(`${res.value.note} ${restartRes.value.note}`)
      }
    } catch (cause) {
      ctrl.setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setActiveQrAction(null)
    }
  }

  const triggerCardRestart = async () => {
    if (typeof remote.restartProfile !== 'function' || cardRestarting) return
    setConfirmCardRestart(false)
    setCardRestarting(true)
    ctrl.setError('')
    try {
      const res = await remote.restartProfile(true)
      if (!res.ok) {
        ctrl.setError(remoteFailureText(res.error))
        return
      }
      if (!res.value.applied) {
        ctrl.setError(res.value.note)
        return
      }
      setFeishuNeedsRestart(false)
      ctrl.setNotice(res.value.note)
    } catch (cause) {
      ctrl.setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCardRestarting(false)
    }
  }

  const executeGuidePromote = async (alsoRestart: boolean) => {
    if (typeof remote.applyDoctorRepair !== 'function' || guidePromoting) return
    setConfirmGuidePromote(null)
    setGuidePromoting(true)
    ctrl.setError('')
    try {
      const res = await remote.applyDoctorRepair(['lark-linked-not-primary-owner'])
      if (!res.ok) {
        ctrl.setError(remoteFailureText(res.error))
        return
      }
      if (!res.value.applied) {
        ctrl.setError(res.value.note)
        return
      }
      notifyConsoleRefresh(remote)
      void ctrl.refresh()
      void ctrl.checkDoctor()
      if (alsoRestart && typeof remote.restartProfile === 'function' && ctrl.doctorReport?.frozenSystemdProfile !== true) {
        const restartRes = await remote.restartProfile(true)
        if (!restartRes.ok) {
          ctrl.setError(`${res.value.note}（自动重启失败：${remoteFailureText(restartRes.error)}）`)
          return
        }
        if (!restartRes.value.applied) {
          ctrl.setError(`${res.value.note}（${restartRes.value.note}）`)
          return
        }
        ctrl.setNotice(`${res.value.note} ${restartRes.value.note}`)
        return
      }
      setFeishuNeedsRestart(true)
      ctrl.setNotice(res.value.note)
    } catch (cause) {
      ctrl.setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGuidePromoting(false)
    }
  }

  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy || cardRestarting || guidePromoting)
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
    ? el('button', { style: btn(primaryButtonStyle), disabled: busy || cardRestarting,
      onClick: () => void ctrl.run(async () => {
        const res = await installWithCompanions(remote, LARK_PACKAGE, larkCompanions, ctrl.confirmOwner)
        if (res.ok && res.value.applied) setFeishuNeedsRestart(true)
        return res
      }) }, '安装 lark-channel')
    : null
  const enableLark = larkState.canEnable
    ? el('button', { style: btn(primaryButtonStyle), disabled: busy || cardRestarting,
      onClick: () => void ctrl.run(async () => {
        const res = await remote.setBundleEnabled(LARK_PACKAGE, true)
        if (res.ok && res.value.applied) setFeishuNeedsRestart(true)
        return res
      }) }, '启用 lark-channel')
    : null
  const larkRepair = !larkReady && (larkState.stalled || larkState.missing.length > 0 || larkState.kind === 'errored')
    ? repairSection(ctrl, larkState, LARK_PACKAGE, (res) => {
      if (res.note.includes('重启')) setFeishuNeedsRestart(true)
    })
    : null

  const policyMissing = larkState.missing.find(item => item.service === 'assistantPolicy')
  const deliveryMissing = larkState.missing.find(item => item.service === 'assistantDelivery')
  const hasBundleInventory = status !== undefined && status.host.bundles === 'ok' && status.bundles.length > 0
  const keychainBundle = status?.bundles.find(bundle => bundle.name === '@dsh-ray/credentials-keychain')
  const keychainNeedsEnable = keychainBundle !== undefined && keychainBundle.installed && !keychainBundle.enabled
  const keychainNeedsInstall = hasBundleInventory && (keychainBundle === undefined || !keychainBundle.installed)
  const qrBlockedBundles = (() => {
    if (!hasBundleInventory || status === undefined) return [] as string[]
    const blocked: string[] = []
    for (const pkg of [LARK_PACKAGE, '@dsh-ray/credentials-keychain', '@dsh-ray/assistant-delivery'] as const) {
      const entry = status.bundles.find(candidate => candidate.name === pkg)
      if (entry === undefined || !entry.installed || !entry.enabled || entry.error !== undefined) {
        blocked.push(pkg)
      }
    }
    const policyCandidates = ['@dsh-ray/personal-assistant', '@dsh-ray/assistant-policy']
      .map(pkg => status.bundles.find(candidate => candidate.name === pkg))
      .filter((entry): entry is OwnerConsoleStatus['bundles'][number] => entry !== undefined && entry.installed && entry.error?.code !== 'not-bundle')
    if (policyCandidates.length > 0 && !policyCandidates.some(entry => entry.enabled && entry.error === undefined)) {
      blocked.push(policyCandidates[0]!.name)
    } else if (policyMissing !== undefined && policyMissing.state !== 'stalled' && !blocked.includes(policyMissing.bundle)) {
      blocked.push(policyMissing.bundle)
    }
    return blocked
  })()
  const qrBlockedByBundles = qrBlockedBundles.length > 0
  const step1Done = larkReady && larkState.missing.length === 0 && !keychainNeedsEnable && !keychainNeedsInstall
  const knownAppId = (status?.feishu.appId !== undefined && /^cli_[0-9a-fA-F]{16}$/u.test(status.feishu.appId))
    ? status.feishu.appId
    : (qrSession?.appId !== undefined && /^cli_[0-9a-fA-F]{16}$/u.test(qrSession.appId) ? qrSession.appId : undefined)
  const step2Done = status?.feishu.appIdConfigured === true || qrSession?.state === 'completed'
  const step3NeedsRestart = feishuNeedsRestart || qrSession?.restartRecommended === true || !larkReady
  const step4Done = status?.feishu.connected === true
  const step3Done = step4Done || (step1Done && step2Done && !step3NeedsRestart)
  const canCardRestart = typeof remote.restartProfile === 'function' && ctrl.doctorReport?.frozenSystemdProfile !== true
  const linkedOwnerIssue = ctrl.doctorReport?.issues.find(item => item.id === 'lark-linked-not-primary-owner')
  const showGuidePromoteOwner = linkedOwnerIssue !== undefined
    && qrSession?.state !== 'completed'
    && typeof remote.applyDoctorRepair === 'function'
  const guidePlatformUrl = knownAppId !== undefined
    ? `https://open.feishu.cn/app/${knownAppId}`
    : 'https://open.feishu.cn/app'
  const modeLabel = status?.feishu.mode === 'env'
    ? '环境变量 secret'
    : !larkReady && status?.feishu.appIdConfigured
      ? '系统凭据库（keychain · 已保存配置，待启动生效）'
      : '系统凭据库（keychain）'

  const feishuRows = pending
    ? placeholder('正在读取…')
    : el('div', { style: listStyle },
      row('方式', modeLabel),
      row('入口', el('span', { style: actionsStyle },
        pill(larkState.label, larkState.tone),
        status.feishu.entry === undefined ? null : el('span', { style: monoMuted }, status.feishu.entry))),
      ...(larkState.entry?.diagnostic === undefined ? [] : [row('诊断', boundedLine(larkState.entry.diagnostic))]),
      ...(larkState.error === undefined ? [] : [row('错误', `${larkState.error.code}${larkState.error.diagnostic === undefined ? '' : `：${boundedLine(larkState.error.diagnostic)}`}`)]),
      ...(larkState.missing.length === 0 ? [] : [row('缺少服务', missingRemedy(larkState))]),
      row('连接', pill(larkConnectionLabel(status.feishu.connection, status.feishu.lastErrorCode),
        larkConnectionTone(status.feishu.connection, status.feishu.lastErrorCode))),
      row('appId', el('span', { style: actionsStyle },
        pill(status.feishu.appIdConfigured ? '已配置' : '未配置', status.feishu.appIdConfigured ? 'ok' : 'warn'),
        status.feishu.appId === undefined ? null : el('span', { style: monoMuted }, status.feishu.appId))))

  const safeQrDataUrl = qrSession?.qrCodeDataUrl !== undefined
    && qrSession.qrCodeDataUrl.startsWith('data:image/svg+xml;base64,')
    ? qrSession.qrCodeDataUrl
    : undefined
  const safeQrUrl = qrSession?.verificationUrl !== undefined
    && isTrustedFeishuUrl(qrSession.verificationUrl)
    ? qrSession.verificationUrl
    : undefined
  const safeOpenPlatformUrl = qrSession?.openPlatformUrl !== undefined
    ? (isTrustedFeishuUrl(qrSession.openPlatformUrl) ? qrSession.openPlatformUrl : undefined)
    : (qrSession?.appId !== undefined && /^cli_[0-9a-fA-F]{16}$/u.test(qrSession.appId)
        ? `https://${qrSession.domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'}/app/${qrSession.appId}`
        : undefined)
  const ownerIsPrimary = qrSession?.ownerBinding === 'bound-owner' || qrSession?.ownerBinding === 'reused-owner'
  const canPromoteOwner = typeof remote.promoteFeishuQrOwner === 'function'
    && qrSession?.state === 'completed'
    && !ownerIsPrimary
    && qrSession.openId !== undefined
    && qrSession.openId !== ''
    && qrSession.ownerBinding !== 'not-returned'
  const canOneClickRestart = typeof remote.restartProfile === 'function'
    && qrSession?.state === 'completed'
    && qrSession.restartSupported === true
  const restartBtnLabel = qrSession?.restartMode === 'desktop-app'
    ? '一键重启 DeepSeek Harness 生效'
    : '一键重启常驻服务生效'
  const stepBoxStyle = {
    display: 'grid',
    gap: 6,
    padding: '10px 12px',
    borderRadius: 10,
    border: `1px solid ${border}`,
    background: sunken,
  } as const
  const qrStateMeta = qrSession === undefined ? undefined : feishuQrStateMeta(qrSession.state)
  const countdownText = qrSession?.state === 'awaiting-scan'
    ? formatCountdown(qrSession.expiresAt, qrNowMs > 0 ? qrNowMs : (qrSession.startedAt ?? Date.now()))
    : ''

  const qrOnboardingPanel = el('div', { 'data-feishu-qr-panel': '', style: { display: 'grid', gap: 12 } },
    qrSession?.state === 'completed'
      ? null
      : el('div', {
        style: {
          display: 'grid', gap: 6, padding: '10px 12px', borderRadius: 10,
          border: `1px solid ${border}`, background: sunken, fontSize: 12, color: muted, lineHeight: 1.6,
        },
      },
      el('div', { style: { fontWeight: 600, color: ink } }, '飞书官方一键扫码授权（与安装向导 dsh-lark-setup 相同协议）'),
      el('div', {}, '1. 点击下方按钮向飞书开放平台申请官方设备授权二维码与链接；'),
      el('div', {}, '2. 用飞书扫码（或直接打开授权页），选择已有应用或一键创建新机器人并确认所需权限；'),
      el('div', {}, '3. 确认后 App Secret 仅在 Host 内存加密存入系统凭据库（配置文件零明文），自动写入通道、收发策略与扫码账号绑定；完成后可直接在面板一键切换主主人并重启生效。')),
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
          ? el('div', { style: { display: 'grid', gap: 10 } },
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
            el('div', { 'data-feishu-qr-next-steps': '', style: { display: 'grid', gap: 8 } },
              el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
                el('span', { style: { fontSize: 12.5, fontWeight: 600, color: ink } }, '后续完成指引（按顺序一键搞定）'),
                canPromoteOwner && canOneClickRestart && !qrRestarted
                  ? el('button', {
                    type: 'button',
                    'data-feishu-qr-finish-all': '',
                    style: idle(primaryButtonStyle, busy || qrActionBusy),
                    disabled: busy || qrActionBusy,
                    onClick: () => setPendingQrAction('promote-and-restart'),
                  }, activeQrAction === 'promote-and-restart' ? '正在切换并重启…' : '一键设为主主人并重启生效')
                  : null),
              pendingQrAction !== null
                ? el('div', {
                  role: 'alertdialog',
                  'data-feishu-qr-confirm': pendingQrAction,
                  style: {
                    display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 10,
                    border: `1px solid ${tint(accent, 34)}`, background: tint(accent, 9), fontSize: 12, color: ink, lineHeight: 1.55,
                  },
                },
                el('div', {},
                  pendingQrAction === 'restart'
                    ? `确认立即${qrSession.restartMode === 'desktop-app' ? '退出并重新打开 DeepSeek Harness.app' : '重启当前受管常驻服务'}，以加载新飞书凭据句柄与长连接（约 3–8 秒）？`
                    : pendingQrAction === 'promote-and-restart'
                      ? `确认将扫码账号 ${qrSession.openId ?? ''} 设为本 profile 主主人（将替换旧主主人身份，并解锁 /permission、/model 与审批卡片）后立即重启生效？${qrSession.existingAutonomyAnchored === true ? '（提示：旧主主人仍有自主授权配置，重启并在飞书发一条消息后，可在自主能力向导点击「一键初始化/修复前置项」并重新保存以更新锚定。）' : ''}`
                      : `确认将扫码账号 ${qrSession.openId ?? ''} 设为本 profile 主主人（将替换旧主主人身份，并解锁 /permission、/model 与审批卡片）？${qrSession.existingAutonomyAnchored === true ? '（提示：旧主主人仍有自主授权配置，重启并在飞书发一条消息后，可在自主能力向导点击「一键初始化/修复前置项」并重新保存以更新锚定。）' : ''}`),
                el('div', { style: actionsStyle },
                  el('button', {
                    type: 'button',
                    'data-feishu-qr-confirm-yes': '',
                    style: idle(primaryButtonStyle, qrActionBusy),
                    disabled: qrActionBusy,
                    onClick: () => void executePendingQrAction(),
                  }, pendingQrAction === 'restart' ? '确认立即重启' : pendingQrAction === 'promote-and-restart' ? '确认切换并重启' : '确认设为主主人'),
                  el('button', {
                    type: 'button',
                    'data-feishu-qr-confirm-no': '',
                    style: buttonStyle,
                    disabled: qrActionBusy,
                    onClick: () => setPendingQrAction(null),
                  }, '取消')))
                : null,
              // Step 1: Owner identity binding
              el('div', { 'data-feishu-qr-step': 'owner', style: stepBoxStyle },
                el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 } },
                  el('span', { style: { fontSize: 12.5, fontWeight: 600, color: ink } }, '第 1 步 · 确认主主人身份'),
                  ownerIsPrimary
                    ? pill('已完成', 'ok')
                    : pill(canPromoteOwner ? '可一键切换' : '待确认', 'warn')),
                ownerIsPrimary
                  ? el('p', { style: { margin: 0, fontSize: 12, color: muted, lineHeight: 1.55 } },
                    qrSession.existingAutonomyAnchored === true
                      ? '已绑定为本 profile 飞书主主人（支持 /permission、/model 与审批卡片）。提示：旧主主人仍有自主授权配置，重启并在飞书给机器人发消息后，到「自主能力向导」先点「一键初始化/修复前置项」同步路由再重新保存即可更新锚定。'
                      : '已绑定为本 profile 飞书主主人，重启后即可直接使用 /permission、/model、审批卡片与自主授权。')
                  : el('p', { style: { margin: 0, fontSize: 12, color: muted, lineHeight: 1.55 } },
                    canPromoteOwner
                      ? '检测到该 profile 已有其他主主人（如桌面端 Web 主主人，或更换飞书应用前旧应用的 open_id），当前账号默认先以「关联身份」接入。点击下方按钮即可将其一键设为飞书主主人。'
                      : '当前未能自动绑定为主主人；可先重启 profile，再按需在终端运行 dsh-lark-setup 完成绑定。'),
                canPromoteOwner
                  ? el('div', { style: actionsStyle },
                    el('button', {
                      type: 'button',
                      'data-feishu-qr-promote-owner': '',
                      style: idle(canOneClickRestart ? buttonStyle : primaryButtonStyle, busy || qrActionBusy),
                      disabled: busy || qrActionBusy,
                      onClick: () => setPendingQrAction('promote'),
                    }, activeQrAction === 'promote' ? '正在切换主主人…' : '一键设为飞书主主人'))
                  : null),
              // Step 2: Apply / Restart profile
              el('div', { 'data-feishu-qr-step': 'restart', style: stepBoxStyle },
                el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 } },
                  el('span', { style: { fontSize: 12.5, fontWeight: 600, color: ink } }, '第 2 步 · 重启 Profile 使新凭据与长连接生效'),
                  qrRestarted ? pill('正在重启…', 'ok') : pill('下一步', 'warn')),
                qrRestarted
                  ? el('p', { style: { margin: 0, fontSize: 12, color: ink, lineHeight: 1.55 } },
                    '已触发重启（通常 3–8 秒）；应用重新打开或服务重连后，顶部连接状态将自动切换为新应用。若系统未自动拉起，请手动重新打开 DeepSeek Harness。')
                  : canOneClickRestart
                    ? el('div', { style: { display: 'grid', gap: 8 } },
                      el('p', { style: { margin: 0, fontSize: 12, color: muted, lineHeight: 1.55 } },
                        qrSession.restartMode === 'desktop-app'
                          ? '新凭据句柄与策略已安全落盘，需重启一次 DeepSeek Harness.app 才会建立新应用的飞书长连接。'
                          : '新凭据句柄与策略已安全落盘，需重启一次受管常驻服务才会建立新应用的飞书长连接。'),
                      el('div', { style: actionsStyle },
                        el('button', {
                          type: 'button',
                          'data-feishu-qr-restart': '',
                          style: idle(canPromoteOwner ? buttonStyle : primaryButtonStyle, busy || qrActionBusy),
                          disabled: busy || qrActionBusy,
                          onClick: () => setPendingQrAction('restart'),
                        }, activeQrAction === 'restart' ? '正在触发重启…' : restartBtnLabel)))
                    : el('div', { style: { display: 'grid', gap: 8 } },
                      el('p', { style: { margin: 0, fontSize: 12, color: muted, lineHeight: 1.55 } },
                        '新凭据句柄与策略已写入 cordis.patch.yml；请重启当前 profile（如重启 DeepSeek Harness.app 或运行下方命令）使新长连接生效。'),
                      qrSession.restartCommand !== undefined && qrSession.restartCommand !== ''
                        ? el('div', { style: actionsStyle },
                          el('code', {
                            style: {
                              fontFamily: monoFont, fontSize: 11.5, padding: '4px 8px', borderRadius: 6,
                              background: surface, border: `1px solid ${border}`, color: ink, wordBreak: 'break-all',
                            },
                          }, qrSession.restartCommand),
                          el('button', {
                            type: 'button',
                            'data-feishu-qr-copy-restart': '',
                            style: buttonStyle,
                            onClick: () => void copyPostScanCommand('restart', qrSession.restartCommand!),
                          }, copiedCmd === 'restart' ? '已复制命令' : '复制重启命令'))
                        : null)),
              // Step 3: Verify in Feishu & Open Platform
              el('div', { 'data-feishu-qr-step': 'verify', style: stepBoxStyle },
                el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 } },
                  el('span', { style: { fontSize: 12.5, fontWeight: 600, color: ink } }, '第 3 步 · 在飞书私聊机器人完成验证'),
                  pill('重启后验证', 'neutral')),
                el('p', { style: { margin: 0, fontSize: 12, color: muted, lineHeight: 1.55 } },
                  `重启完成后，打开飞书搜索机器人「${qrSession.appName ?? '文鳐助手'}」发送一句「你好」测试回复；若在飞书中搜不到机器人或收不到回复，请点击下方打开飞书开放平台确认「版本管理与发布」已发布生效。`),
                el('div', { style: actionsStyle },
                  safeOpenPlatformUrl !== undefined
                    ? el('a', {
                      href: safeOpenPlatformUrl,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      'data-feishu-qr-open-platform': '',
                      style: { ...buttonStyle, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
                    }, '打开飞书开放平台')
                    : null,
                  el('button', {
                    type: 'button',
                    style: btn(canOneClickRestart || canPromoteOwner ? buttonStyle : primaryButtonStyle),
                    disabled: busy,
                    onClick: () => void ctrl.refresh(),
                  }, '刷新连接状态'),
                  el('button', {
                    type: 'button',
                    style: idle(buttonStyle, busy || qrLoading || qrActionBusy),
                    disabled: busy || qrLoading || qrActionBusy,
                    onClick: () => void startQrOnboarding(),
                  }, '重新扫码 / 更换应用')),
                qrSession.businessToolsRequested === true && qrSession.businessCliCommand !== undefined
                  ? el('div', {
                    style: {
                      marginTop: 4, paddingTop: 8, borderTop: `1px solid ${hairline}`,
                      display: 'grid', gap: 6, fontSize: 11.5, color: muted,
                    },
                  },
                  el('span', {}, '可选：如需以个人身份读写飞书云文档 / 多维表格 / 邮件（lark-cli 用户 OAuth），可在终端运行一次：'),
                  el('div', { style: actionsStyle },
                    el('code', {
                      style: {
                        fontFamily: monoFont, fontSize: 11, padding: '3px 7px', borderRadius: 6,
                        background: surface, border: `1px solid ${border}`, color: ink, wordBreak: 'break-all',
                      },
                    }, qrSession.businessCliCommand),
                    el('button', {
                      type: 'button',
                      'data-feishu-qr-copy-business': '',
                      style: buttonStyle,
                      onClick: () => void copyPostScanCommand('business', qrSession.businessCliCommand!),
                    }, copiedCmd === 'business' ? '已复制命令' : '复制授权命令')))
                  : null)))
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
          style: idle(primaryButtonStyle, busy || qrLoading || !canQrFeishu || qrBlockedByBundles),
          disabled: busy || qrLoading || !canQrFeishu || qrBlockedByBundles,
          onClick: () => void startQrOnboarding(),
        }, qrLoading ? '正在向飞书申请授权码…' : '一键生成飞书扫码授权'),
        !canQrFeishu
          ? el('span', { style: hintStyle }, '当前 Host 尚未暴露扫码授权接口，请升级插件或切换手动填入模式。')
          : qrBlockedByBundles
            ? el('span', { 'data-feishu-qr-blocked-hint': '', style: hintStyle },
              `请先完成上方第 1 步启用/安装 ${qrBlockedBundles.join('、')} 后，即可发起扫码授权（或切至「手动填入凭据」预先保存）。`)
            : null)
      : null)

  const canPersistWithoutLiveEntry = (canQrFeishu || canEasyFeishu)
    && larkState.kind !== 'absent'
    && larkState.kind !== 'unavailable'
    && larkState.kind !== 'unreadable'
    && larkState.kind !== 'errored'
  const showConfigForms = status !== undefined && (larkReady || canPersistWithoutLiveEntry)
  const effectiveSecretSource: 'qr' | 'easy' | 'env' | 'handle' = !larkReady && (secretSource === 'env' || secretSource === 'handle')
    ? (canQrFeishu ? 'qr' : 'easy')
    : secretSource

  const guideSummaryText = (() => {
    if (status === undefined) return ''
    if (!step1Done) {
      if (policyMissing?.state === 'disabled') {
        return `当前缺少 assistantPolicy 服务：核心组件 ${policyMissing.bundle} 已安装但处于停用状态${deliveryMissing?.state === 'stalled' ? '（assistant-delivery 已启用，正在等待它恢复，无需重复安装）' : ''}。请点击下方「启用 ${policyMissing.bundle}」一键恢复，再重启 profile 即可自动连接飞书。`
      }
      if (larkState.canInstall) {
        return '第 1 步：点击「安装 lark-channel」安装飞书通道与配套组件并重启 profile，即可使用一键扫码接入。'
      }
      if (larkState.canEnable) {
        return '第 1 步：请先点击「启用 lark-channel」启用已安装的飞书通道；启用后即可发起扫码或手动保存凭据，再重启一次 profile 生效。'
      }
      if (keychainNeedsInstall) {
        return '第 1 步：缺少安全凭据组件 @dsh-ray/credentials-keychain，请先点击下方按钮安装后再保存飞书 App Secret。'
      }
      if (keychainNeedsEnable) {
        return '第 1 步：凭据组件 @dsh-ray/credentials-keychain 已安装但未启用，请先启用它以安全保存飞书 App Secret。'
      }
      if (larkState.stalled) {
        return qrBlockedByBundles
          ? `第 1 步：飞书通道正在等待前置组件就绪；请先启用/安装 ${qrBlockedBundles.join('、')}，然后重启 profile 生效。`
          : '第 1 步：基础组件已全部启用，正在等待重启生效；可直接点击「一键重启生效」（或先在下方完成第 2 步扫码/凭据配置后再一并重启）。'
      }
      return '请先确保基础组件已安装并启用，然后重启 profile 生效。'
    }
    if (!step2Done) {
      return '第 2 步：基础组件已就绪。推荐点击下方「一键生成飞书扫码授权」30 秒完成建应用与授权限，或切换到「手动填入凭据」填写已有飞书应用的 App ID 与 App Secret。'
    }
    if (!step4Done) {
      if (step3NeedsRestart) {
        return `第 3 步：飞书配置已保存（${knownAppId ?? '已配置'}），请重启一次 profile（约 3–8 秒）以加载新凭据与策略并建立飞书长连接。`
      }
      return `第 4 步：已加载应用 ${knownAppId ?? ''}，当前连接为「${larkConnectionLabel(status.feishu.connection, status.feishu.lastErrorCode)}」。若刚改过配置请重启 profile；否则请打开飞书开放平台核对「机器人能力」「事件与回调 -> 长连接」及「版本管理与发布」，或确认凭据未失效。`
    }
    if (linkedOwnerIssue !== undefined && qrSession?.state !== 'completed') {
      return `飞书长连接已在线（${knownAppId ?? '已配置'}），但当前飞书账号仍为关联身份（linked），私聊读写长期记忆会提示「无已认证的 owner 命名空间」，且 /permission、/model 不可用；点击下方「一键将当前飞书账号设为主主人」并重启即可解锁。`
    }
    return `飞书长连接已在线（${knownAppId ?? '已配置'}）！现在可直接在飞书私聊机器人发送「你好」、/model 或 /permission；如需更换应用或补齐权限，可在下方重新扫码。`
  })()

  const step3PillLabel = step3Done
    ? '3. 重启生效 ✓'
    : (feishuNeedsRestart || qrSession?.restartRecommended === true || (step2Done && !larkReady))
      ? '3. 重启生效 待重启'
      : '3. 重启生效 待前序'
  const step3PillTone: StatusTone = step3Done
    ? 'ok'
    : (feishuNeedsRestart || qrSession?.restartRecommended === true || (step2Done && !larkReady))
      ? 'warn'
      : 'neutral'
  const step4HasError = status?.feishu.connection === 'disconnected' || status?.feishu.lastErrorCode !== undefined
  const step4PillLabel = step4Done
    ? '4. 飞书验证 已在线'
    : !step3Done
      ? '4. 飞书验证 待连接'
      : status?.feishu.connection === 'connecting' || status?.feishu.connection === 'reconnecting'
        ? '4. 飞书验证 连接中…'
        : step4HasError
          ? '4. 飞书验证 连接异常'
          : '4. 飞书验证 未连接'
  const step4PillTone: StatusTone = step4Done
    ? 'ok'
    : !step3Done
      ? 'neutral'
      : step4HasError
        ? 'error'
        : 'warn'

  const showGuideRestartBtn = canCardRestart
    && qrSession?.state !== 'completed'
    && (feishuNeedsRestart || (!step4Done && (step2Done || !step1Done)))

  const feishuGuide = status === undefined || larkState.kind === 'unavailable' || larkState.kind === 'unreadable'
    ? null
    : el('div', {
      'data-feishu-guide': '',
      style: {
        display: 'grid',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 12,
        border: `1px solid ${step4Done ? tint(accent, 30) : border}`,
        background: sunken,
      },
    },
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
      el('span', { style: { fontSize: 12.5, fontWeight: 600, color: ink } }, '飞书接入引导（4 步完成连接）'),
      el('div', { style: actionsStyle },
        pill(`1. 基础依赖 ${step1Done ? '✓' : '待处理'}`, step1Done ? 'ok' : larkState.kind === 'errored' || larkState.kind === 'failed' ? 'error' : 'warn'),
        pill(`2. 绑定应用 ${step2Done ? '✓' : '待配置'}`, step2Done ? 'ok' : step1Done ? 'warn' : 'neutral'),
        pill(step3PillLabel, step3PillTone),
        pill(step4PillLabel, step4PillTone),
        showGuidePromoteOwner ? pill('身份授权 关联身份（无长期记忆）', 'warn') : null)),
    el('p', { style: { margin: 0, fontSize: 12.5, color: ink, lineHeight: 1.6 } }, guideSummaryText),
    el('div', { style: actionsStyle },
      showGuidePromoteOwner && canCardRestart
        ? el('button', {
          type: 'button',
          'data-feishu-guide-promote-restart': '',
          style: idle(primaryButtonStyle, busy || cardRestarting || guidePromoting),
          disabled: busy || cardRestarting || guidePromoting,
          onClick: () => setConfirmGuidePromote('promote-and-restart'),
        }, guidePromoting ? '正在切换并重启…' : '一键设为主主人并重启生效')
        : null,
      showGuidePromoteOwner
        ? el('button', {
          type: 'button',
          'data-feishu-guide-promote-owner': '',
          style: idle(canCardRestart ? buttonStyle : primaryButtonStyle, busy || cardRestarting || guidePromoting),
          disabled: busy || cardRestarting || guidePromoting,
          onClick: () => setConfirmGuidePromote('promote'),
        }, guidePromoting ? '正在切换主主人…' : '一键将当前飞书账号设为主主人')
        : null,
      keychainNeedsInstall
        ? el('button', {
          type: 'button',
          'data-feishu-guide-install-keychain': '',
          style: btn(primaryButtonStyle),
          disabled: busy || cardRestarting || guidePromoting,
          onClick: () => void ctrl.run(async () => {
            const res = await remote.installProjectBundle('@dsh-ray/credentials-keychain', [])
            if (res.ok && res.value.applied) setFeishuNeedsRestart(true)
            return res
          }),
        }, '安装 @dsh-ray/credentials-keychain')
        : null,
      keychainNeedsEnable
        ? el('button', {
          type: 'button',
          style: btn(primaryButtonStyle),
          disabled: busy || cardRestarting || guidePromoting,
          onClick: () => void ctrl.run(async () => {
            const res = await remote.setBundleEnabled('@dsh-ray/credentials-keychain', true)
            if (res.ok && res.value.applied) setFeishuNeedsRestart(true)
            return res
          }),
        }, '启用 @dsh-ray/credentials-keychain')
        : null,
      showGuideRestartBtn
        ? el('button', {
          type: 'button',
          'data-feishu-guide-restart': '',
          style: idle(feishuNeedsRestart || (step1Done && step2Done && !step4Done) ? primaryButtonStyle : buttonStyle, busy || cardRestarting || guidePromoting),
          disabled: busy || cardRestarting || guidePromoting,
          onClick: () => setConfirmCardRestart(true),
        }, cardRestarting ? '正在触发重启…' : '一键重启生效')
        : null,
      el('a', {
        href: guidePlatformUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        'data-feishu-guide-open-platform': '',
        style: { ...buttonStyle, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
      }, '打开飞书开放平台'),
      el('button', {
        type: 'button',
        style: btn(),
        disabled: busy || cardRestarting || guidePromoting,
        onClick: () => void ctrl.refresh(),
      }, '刷新状态')),
    confirmGuidePromote !== null
      ? el('div', {
        role: 'alertdialog',
        'data-feishu-guide-promote-confirm': confirmGuidePromote,
        style: {
          display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 10,
          border: `1px solid ${tint(accent, 34)}`, background: tint(accent, 9), fontSize: 12, color: ink, lineHeight: 1.55,
        },
      },
      el('div', {},
        `${linkedOwnerIssue?.detail ?? '确认将当前飞书账号设为本 profile 飞书主主人'}（将替换旧主主人身份，立即解锁长期记忆命名空间、/permission、/model 与审批卡片${confirmGuidePromote === 'promote-and-restart' ? '，并随后重启 DeepSeek Harness 生效' : ''}）？`),
      el('div', { style: actionsStyle },
        el('button', {
          type: 'button',
          'data-feishu-guide-promote-yes': '',
          style: idle(primaryButtonStyle, guidePromoting),
          disabled: guidePromoting,
          onClick: () => void executeGuidePromote(confirmGuidePromote === 'promote-and-restart'),
        }, confirmGuidePromote === 'promote-and-restart' ? '确认切换并重启' : '确认设为主主人'),
        el('button', {
          type: 'button',
          'data-feishu-guide-promote-no': '',
          style: buttonStyle,
          disabled: guidePromoting,
          onClick: () => setConfirmGuidePromote(null),
        }, '取消')))
      : null,
    confirmCardRestart
      ? el('div', {
        role: 'alertdialog',
        'data-feishu-guide-restart-confirm': '',
        style: {
          display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 10,
          border: `1px solid ${tint(accent, 34)}`, background: tint(accent, 9), fontSize: 12, color: ink, lineHeight: 1.55,
        },
      },
      el('div', {}, '确认立即重启当前 profile（桌面端将退出并重新打开 DeepSeek Harness.app，约 3–8 秒），以加载修复后的依赖与飞书长连接？'),
      el('div', { style: actionsStyle },
        el('button', {
          type: 'button',
          'data-feishu-guide-restart-yes': '',
          style: idle(primaryButtonStyle, cardRestarting),
          disabled: cardRestarting,
          onClick: () => void triggerCardRestart(),
        }, '确认立即重启'),
        el('button', {
          type: 'button',
          'data-feishu-guide-restart-no': '',
          style: buttonStyle,
          disabled: cardRestarting,
          onClick: () => setConfirmCardRestart(false),
        }, '取消')))
      : null,
    !step4Done
      ? el('details', {},
        el('summary', { style: { fontSize: 12, color: muted, cursor: 'pointer' } }, '常见排查要点（搜不到机器人 / 收不到回复 / 主主人权限）'),
        el('div', { style: { display: 'grid', gap: 4, marginTop: 6, fontSize: 12, color: muted, lineHeight: 1.6 } },
          el('div', {}, '• 搜不到机器人：进入飞书开放平台「版本管理与发布」，确认已创建版本并发布生效（可用范围包含自己）。'),
          el('div', {}, '• 连上但收不到回复：进入「事件与回调」选择「使用长连接接收事件」并订阅 im.message.receive_v1；卡片交互需开启 card.action.trigger。'),
          el('div', {}, '• 权限或 /model 不可用：若该 profile 曾绑定过旧飞书应用或 Web 主主人，扫码完成后点击「一键设为飞书主主人」或运行 dsh-lark-setup。')))
      : null)

  const feishuActions = !showConfigForms && !installLark && !enableLark && larkRepair === null && feishuGuide === null
    ? null
    : el('div', { style: { display: 'grid', gap: 12 } },
      feishuGuide,
      installLark === null && enableLark === null ? null : el('div', { style: actionsStyle }, installLark, enableLark),
      larkRepair,
      ...(showConfigForms ? [
        !larkReady
          ? el('p', { style: hintStyle }, qrBlockedByBundles
            ? '完成上方第 1 步启用/安装基础组件后即可发起一键扫码授权；也可先切换到「手动填入凭据」预先保存 App ID 与 App Secret，最后重启一次 profile 生效。'
            : '基础组件已就绪（待重启加载），当前即可直接通过下方「一键扫码接入」或「手动填入凭据」保存配置，完成后一并重启 profile 上线。')
          : null,
        el('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }, role: 'radiogroup', 'aria-label': 'secret 引用方式' },
          el('span', { style: subheadStyle }, '配置方式'),
          ...(canQrFeishu ? [
            el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
              el('input', { type: 'radio', name: 'secret-source', checked: effectiveSecretSource === 'qr', style: { accentColor: accent, margin: 0 },
                onChange: () => setSecretSource('qr') }), '一键扫码接入（推荐）'),
          ] : []),
          el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
            el('input', { type: 'radio', name: 'secret-source', checked: effectiveSecretSource === 'easy', style: { accentColor: accent, margin: 0 },
              onChange: () => setSecretSource('easy') }), canQrFeishu ? '手动填入凭据' : '极简一键接入（推荐）'),
          ...(larkReady ? [
            el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
              el('input', { type: 'radio', name: 'secret-source', checked: effectiveSecretSource === 'env', style: { accentColor: accent, margin: 0 },
                onChange: () => setSecretSource('env') }), '环境变量'),
            el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
              el('input', { type: 'radio', name: 'secret-source', checked: effectiveSecretSource === 'handle', style: { accentColor: accent, margin: 0 },
                onChange: () => setSecretSource('handle') }), 'keychain handle'),
          ] : [])),
        effectiveSecretSource === 'qr'
          ? qrOnboardingPanel
          : effectiveSecretSource === 'easy'
            ? el('div', { style: { display: 'grid', gap: 10 } },
              el('div', {
                style: {
                  display: 'grid', gap: 4, padding: '10px 12px', borderRadius: 10,
                  border: `1px solid ${border}`, background: sunken, fontSize: 12, color: muted, lineHeight: 1.6,
                },
              },
              el('div', { style: { fontWeight: 600, color: ink } }, '手动接入飞书自建应用指引'),
              el('div', {}, '1. 在飞书开放平台进入你的企业自建应用 →「凭证与基础信息」复制 App ID 与 App Secret；'),
              el('div', {}, '2. 确认「添加应用能力」已开启「机器人」，「事件与回调」选择「使用长连接接收事件」并订阅 im.message.receive_v1；'),
              el('div', {}, '3. 在「版本管理与发布」发布版本后，在此填入凭据保存（App Secret 仅加密存入系统凭据库，配置文件零明文），然后重启 profile 生效。')),
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
                      if (res.ok && res.value.applied) {
                        setAppSecret('')
                        setFeishuNeedsRestart(true)
                      }
                      return res
                    })
                  },
                }, '一键安全存入凭据并启用飞书'),
                !canEasyFeishu ? el('span', { style: hintStyle }, '当前 Host 未暴露一键接入接口，请切换环境变量或 Handle 模式。') : null))
            : el('div', { style: { display: 'grid', gap: 10 } },
              el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } },
                field('appId', appId, setAppId, 'cli_0123456789abcdef'),
                effectiveSecretSource === 'env'
                  ? field('secret 环境变量名', secretEnv, setSecretEnv, 'LARK_APP_SECRET')
                  : field('keychain handle', secretHandle, setSecretHandle, 'lark-app-secret'),
                field('account', account, setAccount, '保留当前 owner'),
                field('tenant', tenant, setTenant, '保留当前 owner')),
              el('div', { style: actionsStyle },
                el('button', { style: btn(primaryButtonStyle), disabled: busy,
                  onClick: () => {
                    const refs = feishuSecretRefs(effectiveSecretSource, secretEnv, secretHandle)
                    void ctrl.run(() => remote.configureFeishu(appId, refs.appSecretEnv, refs.credentialHandle, account, tenant, false))
                  } }, '应用配置'),
                el('button', { style: btn(), disabled: busy,
                  onClick: () => {
                    const refs = feishuSecretRefs(effectiveSecretSource, secretEnv, secretHandle)
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
          row('assistant-work-items', w === undefined
            ? pill('未知', 'neutral')
            : w.state === 'disabled'
              ? pill('未启用（可选）', 'neutral')
              : subsystemPill(w.state)),
          ...(w?.state !== 'disabled' ? [] : [
            row('WorkItems 说明', '可选工作项扩展未启用，不影响主流程；如需启用请在「插件管理」中开启。'),
          ]),
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

export function RaySelfPanelCard({ ctrl, remote }: Readonly<{ ctrl: ConsoleController; remote: ConsoleRemote }>) {
  const [rayState, setRayState] = useState<OwnerConsoleRaySelfState>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState('')
  const [vetoReason, setVetoReason] = useState('')
  const [cloneSource, setCloneSource] = useState('')

  const load = () => {
    if (typeof remote.raySelfSnapshot !== 'function') return
    setLoading(true)
    setFailed('')
    void remote.raySelfSnapshot().then(res => {
      setLoading(false)
      if (res.ok) setRayState(res.value)
      else setFailed(remoteFailureText(res.error))
    }, cause => {
      setLoading(false)
      setFailed(cause instanceof Error ? cause.message : String(cause))
    })
  }

  useEffect(() => {
    load()
    return subscribeConsoleRefresh(remote, load)
  }, [remote])

  const busy = ctrl.busy || loading
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)

  return el('div', { 'data-owner-console-ray-self': '' },
    card('文鳐自我模型与 Ray Home',
      el('p', { style: hintStyle }, '查看独立家目录（Ray Home）、长期理想、阶段目标、自传演化与内核提案；Owner 否决可在 1 轮内立即生效。'),
      failed !== '' ? el('p', { role: 'alert', style: { margin: 0, fontSize: 12, color: danger } }, `读取失败：${failed}`) : null,
      typeof remote.raySelfSnapshot !== 'function'
        ? placeholder('当前 Host 尚未暴露 Ray Self Panel 接口。')
        : rayState === undefined
          ? placeholder(loading ? '正在读取自我模型…' : '暂无自我模型状态。')
          : !rayState.active || rayState.selfModel === null
            ? placeholder('Ray Home 尚未配置（可在 profile 设置 rayHome 或运行 dsh-ray home init）。')
            : el('div', { style: gridStyle },
              el('div', { style: listStyle },
                row('身份 / 版本', `${rayState.selfModel.name}（${rayState.selfModel.aliases.join(' / ')}） · v${rayState.selfModel.version}`),
                row('Ray Home 路径', el('span', { style: monoMuted }, rayState.rayHome ?? '-')),
                row('当前自述', rayState.selfModel.selfSummary),
                row('精力上限（Kernel）', rayState.energy === null ? '-' : `每日 ${rayState.energy.dailyTokenCap} tokens（自由时间 ${(rayState.energy.freeEnergyRatioBp / 100).toFixed(0)}%）`),
                row('长期理想', rayState.selfModel.ideals.map((i, idx) => `${idx + 1}. ${i.title}`).join('；') || '暂无'),
                row('活跃阶段目标', rayState.selfModel.stageGoals.filter(g => g.status === 'active').map(g => `${g.title}（${g.completionCriteria}）`).join('；') || '暂无'),
                row('缺失凭据提醒', rayState.missingCredentials.length === 0
                  ? pill('凭据完整', 'ok')
                  : pill(`需重授权 ${rayState.missingCredentials.length} 项：${rayState.missingCredentials.map(c => c.label ?? c.id).join('、')}`, 'warn'))),
              rayState.pendingProposals.length > 0
                ? el('div', { style: gridStyle },
                  el('p', { style: subheadStyle }, '待 Owner 审批的身体内核提案'),
                  ...rayState.pendingProposals.map(proposal => el('div', {
                    key: proposal.proposalId,
                    style: { ...listStyle, gap: 6, padding: '8px 12px' },
                  },
                  row(`${proposal.section} · ${proposal.proposalId}`, proposal.summary),
                  el('div', { style: actionsStyle },
                    el('button', {
                      type: 'button',
                      style: btn(primaryButtonStyle),
                      disabled: busy,
                      onClick: () => {
                        if (typeof remote.decideRayKernelProposal === 'function') {
                          void ctrl.run(() => remote.decideRayKernelProposal!(proposal.proposalId, 'approved')).then(load)
                        }
                      },
                    }, '批准提案'),
                    el('button', {
                      type: 'button',
                      style: btn(dangerButtonStyle),
                      disabled: busy,
                      onClick: () => {
                        if (typeof remote.decideRayKernelProposal === 'function') {
                          void ctrl.run(() => remote.decideRayKernelProposal!(proposal.proposalId, 'rejected')).then(load)
                        }
                      },
                    }, '拒绝')))))
                : null,
              rayState.recentAutobiography.length > 0
                ? el('div', { style: listStyle },
                  ...rayState.recentAutobiography.slice(-3).reverse().map(entry =>
                    row(`${entry.kind}${entry.vetoed ? '（已否决）' : ''}`, boundedLine(entry.summary, 160))))
                : null,
              el('div', { style: actionsStyle },
                el('input', {
                  type: 'text',
                  value: vetoReason,
                  placeholder: '可选：否决原因（默认回滚最近一次自主演化）',
                  style: { ...inputStyle, flex: '1 1 200px' },
                  onChange: (event: { target: { value: string } }) => setVetoReason(event.target.value),
                }),
                typeof remote.vetoRaySelf === 'function' ? el('button', {
                  type: 'button',
                  style: btn(dangerButtonStyle),
                  disabled: busy,
                  onClick: () => void ctrl.run(() => remote.vetoRaySelf!('', '', vetoReason)).then(load),
                }, '1 轮推翻最近演化') : null,
                el('button', { type: 'button', style: btn(), disabled: busy, onClick: load }, '刷新自我状态')),
              typeof remote.importRayHome === 'function' ? el('div', { style: actionsStyle },
                el('input', {
                  type: 'text',
                  value: cloneSource,
                  placeholder: '明文搬家包路径（如 /Volumes/Disk/ray-export）',
                  style: { ...inputStyle, flex: '1 1 220px' },
                  onChange: (event: { target: { value: string } }) => setCloneSource(event.target.value),
                }),
                el('button', {
                  type: 'button',
                  style: btn(),
                  disabled: busy || cloneSource.trim() === '',
                  onClick: () => void ctrl.run(() => remote.importRayHome!(cloneSource.trim())).then(load),
                }, '导入搬家包')) : null)))
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
  const [installSpec, setInstallSpec] = useState('@dsh-ray/')
  const [installPickerMode, setInstallPickerMode] = useState<'list' | 'all' | 'custom'>('list')
  const installInputRef = useRef<{ focus?: () => void } | null>(null)
  const hasLoadedStatusRef = useRef(false)
  const prevInstalledBundlesRef = useRef<ReadonlySet<string>>(new Set())
  const pending = status === undefined
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const itemStyle = { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${hairline}` }
  const pluginEntries = status?.plugins ?? []

  const uninstalled = resolveUninstalledBundles(status)
  const availableNames = uninstalled.available.map(item => item.name)
  const trimmedInstallSpec = installSpec.trim()
  const selectedBundleItem = uninstalled.all.find(item => item.name === trimmedInstallSpec)
  const installAllMode = installPickerMode === 'all' && uninstalled.ready && availableNames.length > 0

  useEffect(() => {
    if (status === undefined) return
    const currentInstalled = new Set(
      status.bundles.filter(bundle => bundle.installed).map(bundle => bundle.name),
    )
    const wasLoaded = hasLoadedStatusRef.current
    const prevInstalled = prevInstalledBundlesRef.current
    hasLoadedStatusRef.current = true
    prevInstalledBundlesRef.current = currentInstalled

    if (installPickerMode === 'all' && uninstalled.ready && availableNames.length === 0) {
      setInstallPickerMode('list')
    }
    if (
      wasLoaded
      && trimmedInstallSpec !== ''
      && trimmedInstallSpec !== '@dsh-ray/'
      && !prevInstalled.has(trimmedInstallSpec)
      && currentInstalled.has(trimmedInstallSpec)
    ) {
      setInstallSpec('@dsh-ray/')
      setInstallPickerMode('list')
    }
  }, [installPickerMode, uninstalled.ready, availableNames.length, status, trimmedInstallSpec])

  const selectValue = installAllMode
    ? INSTALL_ALL_AVAILABLE_OPTION
    : installPickerMode === 'custom'
      ? CUSTOM_BUNDLE_OPTION
      : selectedBundleItem !== undefined
        ? selectedBundleItem.name
        : trimmedInstallSpec !== '' && trimmedInstallSpec !== '@dsh-ray/'
          ? CUSTOM_BUNDLE_OPTION
          : ''

  const startBatchInstall = (specs: readonly string[]) => {
    if (ctrl.runBatchInstall !== undefined) {
      void ctrl.runBatchInstall(specs)
      return
    }
    void ctrl.run(async () => {
      const summary = await installAvailableBundles(remote, specs, ctrl.confirmOwner)
      if (summary.requested.length === 0) {
        return {
          ok: true,
          value: { applied: true, entry: '', note: '没有可安装的可用插件。' },
        }
      }
      const restartSuffix = summary.needsRestart ? '，请重启 profile 以激活新插件。' : '。'
      if (summary.failure !== undefined) {
        if (summary.completed.length > 0) {
          await ctrl.refresh()
          notifyConsoleRefresh(remote)
        }
        const completedPrefix = summary.completed.length > 0
          ? `已安装 ${summary.completed.length}/${summary.requested.length} 个；`
          : ''
        return {
          ok: false,
          error: {
            code: 'BATCH_INSTALL_FAILED',
            message: `${completedPrefix}${summary.failure.spec}: ${summary.failure.reason}`,
          },
        }
      }
      if (summary.stoppedByUser) {
        if (summary.completed.length > 0) {
          await ctrl.refresh()
          notifyConsoleRefresh(remote)
        }
        return {
          ok: true,
          value: {
            applied: true,
            entry: summary.completed.at(-1) ?? '',
            note: `已停止后续安装：已完成 ${summary.completed.length}/${summary.requested.length} 个（${summary.completed.join('、') || '无'}）${restartSuffix}`,
          },
        }
      }
      return {
        ok: true,
        value: {
          applied: true,
          entry: summary.completed.at(-1) ?? '',
          note: `已一键安装 ${summary.completed.length} 个可用插件${restartSuffix}`,
        },
      }
    })
  }

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
            (bundle.error !== undefined || state.kind === 'bundled') && !bundle.enabled ? null
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
    el('div', { style: { display: 'grid', gap: 10, minWidth: 0 } },
      el('h4', { style: subheadStyle }, 'Bundle 层'),
      bundleRows,
      el('h4', { style: { ...subheadStyle, marginTop: 6 } }, '已加载条目'),
      pluginRows,
      el('div', { style: { display: 'grid', gap: 8, minWidth: 0, marginTop: 6, paddingTop: 10, borderTop: `1px solid ${hairline}` } },
        el('label', { style: { display: 'grid', gap: 4, fontSize: 12, fontWeight: 500, color: muted, minWidth: 0 } },
          el('span', {}, '选择本项目其他未安装插件'),
          el('select', {
            'aria-label': '选择未安装的本项目 bundle',
            'data-bundle-install-select': '',
            value: selectValue,
            disabled: busy,
            style: { ...inputStyle, maxWidth: '100%', textOverflow: 'ellipsis' },
            onChange: (event: { target: { value: string } }) => {
              const picked = event.target.value
              if (picked === '') {
                setInstallPickerMode('list')
                setInstallSpec('@dsh-ray/')
                return
              }
              if (picked === INSTALL_ALL_AVAILABLE_OPTION) {
                setInstallPickerMode('all')
                setInstallSpec('@dsh-ray/')
                return
              }
              if (picked === CUSTOM_BUNDLE_OPTION) {
                setInstallPickerMode('custom')
                if (selectedBundleItem !== undefined || trimmedInstallSpec === '') {
                  setInstallSpec('@dsh-ray/')
                }
                installInputRef.current?.focus?.()
                return
              }
              setInstallPickerMode('list')
              setInstallSpec(picked)
            },
          },
          el('option', { value: '' }, !uninstalled.ready
            ? (uninstalled.hostUnavailable ? 'Host 插件管理器暂不可用，可下方手动输入…' : '正在读取未安装插件列表…')
            : uninstalled.all.length === 0
              ? '所有本项目插件均已安装…'
              : `选择未安装的插件（共 ${uninstalled.all.length} 个未安装）…`),
          uninstalled.ready && availableNames.length > 0
            ? el('option', { value: INSTALL_ALL_AVAILABLE_OPTION },
              `全部可用插件（一键安装全部 ${availableNames.length} 个）`)
            : null,
          uninstalled.ready && uninstalled.available.length > 0
            ? el('optgroup', { label: `可安装插件（${uninstalled.available.length} 个，按依赖顺序）` },
              ...uninstalled.available.map(item => el('option', { key: item.name, value: item.name },
                `${item.name} — ${item.label}`)))
            : null,
          uninstalled.ready && uninstalled.excluded.length > 0
            ? el('optgroup', { label: `专用 / 互斥插件（${uninstalled.excluded.length} 个，不随一键安装）` },
              ...uninstalled.excluded.map(item => el('option', { key: item.name, value: item.name },
                `${item.name} — ${item.label}${item.excludeReason ? `（${item.excludeReason}）` : ''}`)))
            : null,
          el('option', { value: CUSTOM_BUNDLE_OPTION }, '手动输入其他 @dsh-ray/* 包名…'))),
        installAllMode
          ? el('div', {
            'data-bundle-install-all-preview': '',
            style: {
              display: 'grid',
              gap: 6,
              minWidth: 0,
              padding: '8px 10px',
              borderRadius: 8,
              background: sunken,
              border: `1px solid ${hairline}`,
              fontSize: 12,
            },
          },
          el('span', { style: { fontWeight: 500, color: ink } },
            `将按依赖顺序依次安装以下 ${availableNames.length} 个可用插件：`),
          el('span', { style: { fontFamily: monoFont, fontSize: 11, color: muted, overflowWrap: 'anywhere' } },
            availableNames.join('、')),
          uninstalled.excluded.length === 0 ? null : el('span', { style: { fontSize: 11, color: caption } },
            `已自动跳过 ${uninstalled.excluded.length} 个专用 / 互斥插件（${uninstalled.excluded.map(item => item.name).join('、')}），如需单独安装可在上方下拉列表或输入框中指定。`))
          : null,
        el('div', { style: { ...actionsStyle, alignItems: 'end' } },
          el('label', { style: { display: 'grid', gap: 4, fontSize: 12, fontWeight: 500, color: muted, minWidth: 0, flex: '1 1 200px' } },
            el('span', {}, '安装本项目 bundle'),
            el('input', {
              ref: installInputRef,
              'data-bundle-install-input': '',
              value: installSpec,
              disabled: busy,
              placeholder: '@dsh-ray/plugin-name',
              style: inputStyle,
              onChange: (event: { target: { value: string } }) => {
                const next = event.target.value
                const trimmedNext = next.trim()
                setInstallSpec(next)
                if (trimmedNext === '' || trimmedNext === '@dsh-ray/') {
                  setInstallPickerMode('list')
                } else if (uninstalled.all.some(item => item.name === trimmedNext)) {
                  setInstallPickerMode('list')
                } else {
                  setInstallPickerMode('custom')
                }
              },
            })),
          installAllMode
            ? el('button', {
              style: btn(primaryButtonStyle),
              disabled: busy,
              onClick: () => startBatchInstall(availableNames),
            }, `一键安装全部可用插件（${availableNames.length}）`)
            : el('button', {
              style: btn(primaryButtonStyle),
              disabled: busy,
              onClick: () => void ctrl.runInstall(installSpec),
            }, '安装'),
          installAllMode
            ? el('button', {
              style: btn(),
              disabled: busy,
              onClick: () => setInstallPickerMode('list'),
            }, '取消全选')
            : uninstalled.ready
              ? el('button', {
                style: availableNames.length === 0 ? idle(buttonStyle, true) : btn(),
                disabled: busy || availableNames.length === 0,
                onClick: () => startBatchInstall(availableNames),
              }, availableNames.length === 0
                ? '全部可用插件已安装'
                : `一键安装全部可用插件（${availableNames.length}）`)
              : null),
        !installAllMode && selectedBundleItem !== undefined
          ? el('p', { style: !selectedBundleItem.availableForInstallAll && selectedBundleItem.excludeReason !== undefined ? { ...hintStyle, color: accent } : hintStyle },
            !selectedBundleItem.availableForInstallAll && selectedBundleItem.excludeReason !== undefined
              ? `说明：${selectedBundleItem.label} — ${selectedBundleItem.excludeReason}`
              : `已选：${selectedBundleItem.label}`)
          : null,
        ctrl.batchInstall === undefined
          ? null
          : el('div', {
            role: 'status',
            'data-bundle-batch-progress': '',
            style: { ...bannerStyle(accent), justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' },
          },
          el('span', { style: { display: 'grid', gap: 2, minWidth: 0, overflowWrap: 'anywhere' } },
            el('span', { style: { fontWeight: 500 } },
              ctrl.batchInstall.stopping
                ? `正在完成当前包后停止（${ctrl.batchInstall.index + 1}/${ctrl.batchInstall.total}）：${ctrl.batchInstall.current}`
                : `正在批量安装可用插件（${ctrl.batchInstall.index + 1}/${ctrl.batchInstall.total}）：${ctrl.batchInstall.current}`),
            el('span', { style: { fontSize: 12, color: caption } },
              `已完成 ${ctrl.batchInstall.completed.length}/${ctrl.batchInstall.total}`
              + (ctrl.batchInstall.needsRestart ? ' · 安装完成后需要重启 profile' : ''))),
          ctrl.cancelBatchInstall === undefined
            ? null
            : el('button', {
              style: buttonStyle,
              disabled: ctrl.batchInstall.stopping,
              onClick: () => ctrl.cancelBatchInstall?.(),
            }, ctrl.batchInstall.stopping ? '正在停止…' : '停止后续安装'))),
      el('p', { style: hintStyle },
        '安装走 DSH 自身的 pnpm 路径，只装该包及其 pnpm 依赖；单装时其 @dsh-ray peer bundle 与 Host 服务不会自动安装，缺失项会显示在卡片里。'
        + '「一键安装全部可用插件」会跳过本控制台自身、专用冲突包及互斥拆分包，按基础服务到上层能力顺序逐个安装。安装/启用后如提示需要重启 profile，请依提示操作。'),
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
            ? field('entry', bundleEntry, setBundleEntry, 'dsh-ray-...')
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
  const mountedRef = useRef(true)
  const [repairing, setRepairing] = useState(false)
  const [repairFeedback, setRepairFeedback] = useState<Readonly<{ ok: boolean; text: string }> | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

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

  const runPrerequisiteRepair = () => {
    if (typeof remote.applyDoctorRepair !== 'function' || repairing) return
    setRepairing(true)
    setRepairFeedback(null)
    void ctrl.run(async () => {
      try {
        const res = await remote.applyDoctorRepair!([])
        if (mountedRef.current) {
          setRepairFeedback(res.ok
            ? { ok: res.value.applied, text: res.value.note }
            : { ok: false, text: `修复失败（${remoteFailureText(res.error)}）` })
        }
        return res
      } catch (cause) {
        if (mountedRef.current) {
          setRepairFeedback({ ok: false, text: cause instanceof Error ? cause.message : '修复前置项失败' })
        }
        throw cause
      } finally {
        if (mountedRef.current) setRepairing(false)
      }
    })
  }

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
                      style: idle(primaryButtonStyle, busy || repairing),
                      disabled: busy || repairing,
                      onClick: runPrerequisiteRepair,
                    }, repairing ? '正在初始化/修复前置项…' : '一键初始化/修复前置项'))
                  : null))
            : null,
          repairFeedback !== null
            ? el('div', {
              role: repairFeedback.ok ? 'status' : 'alert',
              style: bannerStyle(repairFeedback.ok ? accent : danger),
            }, repairFeedback.text)
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
  const [triggeringUpgrade, setTriggeringUpgrade] = useState(false)
  const [upgradeFeedback, setUpgradeFeedback] = useState<Readonly<{ ok: boolean; text: string }> | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const latestRun = upgradeStatus?.latestRun
  useEffect(() => {
    if (latestRun?.state !== 'running') return undefined
    const poll = typeof ctrl.syncUpgradeStatus === 'function'
      ? ctrl.syncUpgradeStatus
      : (typeof remote.checkSelfUpgrade === 'function' ? () => ctrl.checkUpgrade(true) : undefined)
    if (poll === undefined) return undefined
    const timer = setInterval(() => { void poll() }, 2_000)
    return () => { clearInterval(timer) }
  }, [latestRun?.state, ctrl, remote])

  const canCheck = typeof remote.checkSelfUpgrade === 'function'
  const canDryRun = typeof remote.dryRunSelfUpgrade === 'function'
  const canTrigger = typeof remote.runSelfUpgrade === 'function'
  const isFrozen = Boolean(upgradeStatus?.frozenSystemdProfile || upgradePreview?.frozenSystemdProfile)
  const canArmUpgrade = !isFrozen && Boolean(
    upgradeStatus?.canTriggerDetached || (upgradePreview?.supported && !upgradePreview.frozenSystemdProfile),
  )

  const triggerConfirmedUpgrade = () => {
    if (!canTrigger || !canArmUpgrade || triggeringUpgrade) return
    setUpgradeArmed(false)
    setTriggeringUpgrade(true)
    setUpgradeFeedback(null)
    void ctrl.run(async () => {
      try {
        const res = await remote.runSelfUpgrade!(true)
        if (mountedRef.current) {
          setUpgradeFeedback(res.ok
            ? { ok: res.value.applied, text: res.value.note }
            : { ok: false, text: `启动后台升级失败（${remoteFailureText(res.error)}）` })
        }
        if (!res.ok || !res.value.applied) {
          await ctrl.syncUpgradeStatus?.()
        }
        return res
      } catch (cause) {
        if (mountedRef.current) {
          setUpgradeFeedback({ ok: false, text: cause instanceof Error ? cause.message : '启动后台升级失败' })
        }
        throw cause
      } finally {
        if (mountedRef.current) setTriggeringUpgrade(false)
      }
    })
  }

  const runTone: StatusTone = latestRun?.state === 'failed'
    ? 'error'
    : latestRun?.state === 'succeeded'
      ? 'ok'
      : 'warn'
  const runLabel = latestRun?.state === 'failed'
    ? '后台升级失败'
    : latestRun?.state === 'succeeded'
      ? '后台升级已完成'
      : '后台升级进行中'

  return card(
    '版本检查与自助升级',
    '只读核验当前 @dsh-ray 版本、绑定 Host (@deepseek-ai/dsh) 与 npm 最新版本；支持安全预演与明确确认后的带外后台升级',
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
          detailRow('@dsh-ray 当前 / 最新',
            el('div', { style: monoMuted }, `${upgradeStatus.currentEnhancedVersion} -> ${upgradeStatus.latestEnhancedVersion ?? '离线未知'}`),
            `来源：${upgradeStatus.checkSource}${upgradeStatus.cached ? '（TTL 缓存）' : ''}`),
          detailRow('绑定 Host (@deepseek-ai/dsh)',
            el('div', { style: monoMuted }, `绑定 ${upgradeStatus.boundHostVersion ?? '未绑定 (.dsh-ray-host.json)'} · 运行时 ${upgradeStatus.installedHostVersion ?? '未知'}${upgradeStatus.targetHostVersion ? ` -> ${upgradeStatus.targetHostVersion}` : ''}`),
            upgradeStatus.note),
          upgradeStatus.frozenSystemdProfile
            ? el('div', { style: bannerStyle(muted) }, `受控 Linux systemd profile 引导：${upgradeStatus.upgradeCommand}`)
            : null),
      upgradeFeedback !== null
        ? el('div', {
          role: upgradeFeedback.ok ? 'status' : 'alert',
          style: bannerStyle(upgradeFeedback.ok ? accent : danger),
        }, upgradeFeedback.text)
        : null,
      latestRun !== undefined
        ? el('div', {
          'data-self-upgrade-run-state': latestRun.state,
          role: latestRun.state === 'failed' ? 'alert' : 'status',
          style: { padding: '8px 10px', borderRadius: 8, border: `1px solid ${latestRun.state === 'failed' ? danger : hairline}`, display: 'grid', gap: 6 },
        },
        el('div', { style: actionsStyle },
          pill(runLabel, runTone),
          latestRun.pid !== undefined ? el('span', { style: monoMuted }, `PID ${latestRun.pid}`) : null,
          latestRun.state === 'running' && canCheck
            ? el('button', {
              type: 'button',
              style: idle(buttonStyle, checkingUpgrade),
              disabled: checkingUpgrade,
              onClick: () => void ctrl.checkUpgrade(true),
            }, checkingUpgrade ? '刷新中…' : '刷新升级进度')
            : null),
        el('div', { style: { fontWeight: 500, color: latestRun.state === 'failed' ? danger : ink } }, latestRun.summary),
        latestRun.error !== undefined
          ? el('div', { style: { fontSize: 12, color: danger } }, `错误详情：${latestRun.error}`)
          : null,
        latestRun.logPath !== undefined
          ? el('div', { style: monoMuted }, `升级日志：${latestRun.logPath}`)
          : null,
        latestRun.logTail !== undefined
          ? el('pre', {
            style: {
              margin: 0,
              padding: '6px 8px',
              borderRadius: 6,
              background: sunken,
              fontFamily: monoFont,
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: 160,
              overflowY: 'auto',
            },
          }, latestRun.logTail)
          : null)
        : null,
      upgradePreview === undefined
        ? null
        : el('div', { style: { padding: '8px 10px', borderRadius: 8, border: `1px solid ${hairline}`, display: 'grid', gap: 4 } },
          el('div', { style: { fontWeight: 500 } }, `预演结果：${upgradePreview.summary}`),
          upgradePreview.warnings.length > 0
            ? el('div', { style: { fontSize: 12, color: danger } }, `提示 / 阻塞：${upgradePreview.warnings.join('；')}`)
            : null,
          el('div', { style: monoMuted }, `命令：${upgradePreview.command}`)),
      upgradeArmed && !upgradeStatus?.frozenSystemdProfile && !upgradePreview?.frozenSystemdProfile
        ? el('div', { style: bannerStyle(danger) },
          el('div', { style: { display: 'grid', gap: 8 } },
            el('span', {}, `即将启动独立后台进程执行：${upgradePreview?.command ?? upgradeStatus?.upgradeCommand ?? 'dsh-ray upgrade --yes'}（升级期间将先备份并校验账本，完成后需按日志重启 Host）。`),
            el('div', { style: actionsStyle },
              el('button', { type: 'button', style: idle(dangerButtonStyle, busy || triggeringUpgrade || !canTrigger || !canArmUpgrade), disabled: busy || triggeringUpgrade || !canTrigger || !canArmUpgrade, onClick: triggerConfirmedUpgrade }, triggeringUpgrade ? '正在启动后台升级…' : '确认并启动后台升级'),
              el('button', { type: 'button', style: buttonStyle, disabled: busy || triggeringUpgrade, onClick: () => setUpgradeArmed(false) }, '取消'))))
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
        isFrozen
          ? null
          : el('button', {
            type: 'button',
            style: idle(primaryButtonStyle, busy || triggeringUpgrade || !canTrigger || !canArmUpgrade),
            disabled: busy || triggeringUpgrade || !canTrigger || !canArmUpgrade,
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
        ? placeholder('当前 Host 尚未暴露只读成长计分卡接口；可在终端运行 dsh-ray growth-report --since 7d。')
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
    show('autonomy') ? jsx(RaySelfPanelCard, { ctrl, remote }) : null,
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
  const [repairPendingRestart, setRepairPendingRestart] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const canDoctor = typeof remote.setupDoctor === 'function'
  const canRepair = typeof remote.applyDoctorRepair === 'function'
  const canRestart = typeof remote.restartProfile === 'function' && doctorReport?.frozenSystemdProfile !== true
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy || checkingDoctor || restarting)

  const runDoctorRepair = (issueIds: readonly string[]) => {
    void ctrl.run(async () => {
      const res = await remote.applyDoctorRepair!(issueIds)
      if (res.ok && res.value.applied && res.value.note.includes('重启')) {
        setRepairPendingRestart(true)
      }
      return res
    })
  }

  const triggerDoctorRestart = async () => {
    if (!canRestart || restarting) return
    setConfirmRestart(false)
    setRestarting(true)
    ctrl.setError('')
    try {
      const res = await remote.restartProfile!(true)
      if (!res.ok) {
        ctrl.setError(remoteFailureText(res.error))
        return
      }
      if (!res.value.applied) {
        ctrl.setError(res.value.note)
        return
      }
      setRepairPendingRestart(false)
      ctrl.setNotice(res.value.note)
    } catch (cause) {
      ctrl.setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRestarting(false)
    }
  }

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
        style: idle(primaryButtonStyle, busy || checkingDoctor || restarting),
        disabled: busy || checkingDoctor || restarting,
        onClick: () => runDoctorRepair([]),
      }, `一键全部自动修复（${doctorReport.autoFixableCount} 项）`)
      : null,
    repairPendingRestart && canRestart
      ? el('button', {
        type: 'button',
        'data-doctor-restart': '',
        style: idle(primaryButtonStyle, busy || checkingDoctor || restarting),
        disabled: busy || checkingDoctor || restarting,
        onClick: () => setConfirmRestart(true),
      }, restarting ? '正在重启生效…' : '一键重启生效')
      : null,
    el('button', {
      type: 'button',
      style: btn(),
      disabled: busy || checkingDoctor || restarting,
      onClick: () => void ctrl.checkDoctor(),
    }, checkingDoctor ? '体检中…' : '立即体检'))

  const restartConfirmBanner = !confirmRestart
    ? null
    : el('div', {
      role: 'alertdialog',
      'data-doctor-restart-confirm': '',
      style: {
        display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 10,
        border: `1px solid ${tint(accent, 34)}`, background: tint(accent, 9), fontSize: 12, color: ink, lineHeight: 1.55,
      },
    },
    el('div', {}, '确认立即重启当前 profile（桌面端将退出并重新打开 DeepSeek Harness.app，约 3–8 秒）以激活已修复的插件？'),
    el('div', { style: actionsStyle },
      el('button', {
        type: 'button',
        'data-doctor-restart-confirm-yes': '',
        style: idle(primaryButtonStyle, restarting),
        disabled: restarting,
        onClick: () => void triggerDoctorRestart(),
      }, '确认立即重启'),
      el('button', {
        type: 'button',
        'data-doctor-restart-confirm-no': '',
        style: buttonStyle,
        disabled: restarting,
        onClick: () => setConfirmRestart(false),
      }, '取消')))

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
                disabled: busy || checkingDoctor || restarting,
                onClick: () => runDoctorRepair([issue.id]),
              }, issue.fixLabel)
              : null),
          el('p', { style: hintStyle }, issue.detail),
          issue.copyCommand ? commandCopyRow(issue.copyCommand, ctrl, busy || checkingDoctor) : null)))

  return card('系统体检与一键自动修复',
    el('div', { 'data-owner-console-card': 'doctor-repair', style: { display: 'grid', gap: 10 } },
      headerPills,
      summaryActions,
      restartConfirmBanner,
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
    'data-owner-console-models-provider-card': focusId || 'dsh-ray-traex-acp-provider',
    style: { display: 'grid', gap: 10, paddingTop: 6, color: ink, fontSize: 13 },
  },
  jsx(StatusBanners, { ctrl }),
  status === undefined
    ? placeholder('正在探测本地 TraeX / Antigravity ACP 状态…')
    : el('div', { style: { display: 'grid', gap: 10 } },
      showTraex ? renderTool('traex', 'traex-agent', 'TraeX Agent (local ACP)', status.traex.enabled, status.traex.command, traexProbe) : null,
      showAgy ? renderTool('agy', 'agy-agent', 'Antigravity Agent (local ACP)', status.agy?.enabled === true, status.agy?.command ?? '', agyProbe) : null))
}
