import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { KAI_FONT, QUIET_PHRASE } from './art.js'
import { TYPERT_REMOTE } from './typert.js'
import { WENYAO_BACKDROP_DATA_URI, WENYAO_HERO_DATA_URI, WENYAO_HERO_HEIGHT, WENYAO_HERO_WIDTH,
  WENYAO_ICON_DATA_URI, WENYAO_SEAL_DATA_URI } from './artwork.js'
import type { IntakeAgreementAvailability, OwnerConsoleIntakeAgreement, OwnerConsoleStatus, OwnerConsoleTrendSnapshotItem,
  OwnerConsoleTrendSnapshots, OwnerConsoleWriteResult } from './typert.js'
import { componentState, missingRemedy, repairPatch, type ComponentState } from './state.js'
import { OwnerConsoleChat, OwnerConsoleConversation, type OwnerConsoleRendererSeat } from './chat-view.js'
import {
  browserLang, browserSpeechRecognition, browserSpeechSynthesisAvailable, browserStorage, speakInBrowser,
  type ChatRuntime, type ChatSessions, type ChatUploads, type PermissionCatalog,
} from './chat.js'
import {
  accent, actionsStyle, backdropImageStyle, backdropStyle, border, buttonStyle, card, caption,
  danger, dangerButtonStyle, el, field, gridStyle, hairline, hintStyle, idle, ink, inputStyle, listStyle, monoFont,
  monoMuted, muted, pill, placeholder, primaryButtonStyle, row, subheadStyle, surface, tint, type StatusTone,
} from './ui.js'

/** Only the reference the owner picked is submitted; the other stays empty. */
export function feishuSecretRefs(source: 'env' | 'handle', env: string,
  handle: string): Readonly<{ appSecretEnv: string, credentialHandle: string }> {
  return source === 'env' ? { appSecretEnv: env, credentialHandle: '' } : { appSecretEnv: '', credentialHandle: handle }
}

/** Browser confirmation channel. Without one the panel never performs a destructive or
 * install-script-authorizing step, and the caller must show that refusal instead of going silent. */
export function askOwner(confirm: ((message: string) => boolean) | undefined,
  message: string): 'approved' | 'declined' | 'unavailable' {
  if (confirm === undefined) return 'unavailable'
  return confirm(message) ? 'approved' : 'declined'
}

/** The visible consequence of a confirmation: an unavailable channel and a decline must not be silent. */
export function confirmationNotice(answer: 'approved' | 'declined' | 'unavailable', message: string): string | undefined {
  if (answer === 'unavailable') return `当前界面没有确认对话框，本次操作未执行：${message}`
  return answer === 'declined' ? '已取消操作' : undefined
}

/** Render a gateway failure verbatim (bounded), keeping its stable code for support. */
export function remoteFailureText(error: RemoteFailure | undefined): string {
  if (error === undefined || error.code === '' || error.message === '') return 'Host 返回了未说明的拒绝'
  const message = error.message.length > 600 ? `${error.message.slice(0, 600)}…` : error.message
  return `${error.code}：${message}`
}

/**
 * One install click, then one explicit confirmation when the Host recorded dependency build
 * scripts. Only the names the Host itself reported as pending are approved on the retry; with no
 * confirmation channel, or a failure that recorded none, the package stays uninstalled.
 */
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

/** Read-only label for `larkChannel.health()`; the error code is shown as its stable identifier. */
export function larkConnectionLabel(connection: OwnerConsoleStatus['feishu']['connection'],
  lastErrorCode?: string): string {
  const label = LARK_CONNECTION_LABELS[connection]
  return lastErrorCode === undefined ? label : `${label}（最近错误：${lastErrorCode}）`
}

/** Read-only tone for the lark-channel connection pill. */
export function larkConnectionTone(connection: OwnerConsoleStatus['feishu']['connection'],
  lastErrorCode?: string): StatusTone {
  if (connection === 'connected') return lastErrorCode === undefined ? 'ok' : 'warn'
  if (connection === 'disconnected') return 'error'
  if (connection === 'absent' || connection === 'disabled') return lastErrorCode === undefined ? 'neutral' : 'error'
  return 'warn'
}

const OWN_PACKAGE = '@dsh-enhanced/owner-console'
const LARK_PACKAGE = '@dsh-enhanced/lark-channel'
const TRAEX_PACKAGE = '@dsh-enhanced/traex-acp-provider'

/** One bounded line of Host-provided diagnostic text for a row. */
export function boundedLine(text: string, limit = 240): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

/** A plugin row's status comes from its fiber, not from the persisted enable flag. */
export function fiberState(phase: OwnerConsoleStatus['plugins'][number]['fiberPhase'],
  enabled: boolean): Readonly<{ label: string, tone: StatusTone }> {
  if (phase === 'active') return { label: '已加载', tone: 'ok' }
  if (phase === 'failed') return { label: '加载失败', tone: 'error' }
  if (phase === 'pending') return { label: '等待依赖服务', tone: 'warn' }
  if (phase === 'loading') return { label: '加载中', tone: 'warn' }
  if (phase === 'unloading') return { label: '卸载中', tone: 'neutral' }
  return enabled ? { label: '已启用未启动', tone: 'warn' } : { label: '已停用', tone: 'neutral' }
}

const settingsSectionStyle = { position: 'relative', isolation: 'isolate', height: '100%', minHeight: 0 } as const
const settingsScrollStyle = { position: 'relative', zIndex: 1, height: '100%', overflowY: 'auto', boxSizing: 'border-box' } as const
const panelStyle = { padding: '28px 24px 40px', maxWidth: 840, margin: '0 auto', display: 'grid', gap: 16, color: ink,
  fontSize: 13, lineHeight: 1.5 } as const
/** The Host main slot is a fixed-height pane; the chat view fills it and the settings view scrolls inside. */
const mainRootStyle = { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxSizing: 'border-box' } as const

export type { StatusTone } from './ui.js'

/** The installed Host supplies remote and the slot registry. */
export const inject = ['remote', 'slots']

/** The gateway's failure result keeps the business code and unchanged message; the panel must show
 * both instead of one generic sentence. `error` stays optional so a minimal transport result is legal. */
type RemoteFailure = Readonly<{ code: string, message: string, details?: unknown }>
type RemoteResult<T> = Readonly<{ ok: true, value: T }> | Readonly<{ ok: false, error?: RemoteFailure }>
type ConsoleRemote = Readonly<{
  status(): Promise<RemoteResult<OwnerConsoleStatus>>
  trendSnapshots(planId: string, beforeSequence: number, limit: number): Promise<RemoteResult<OwnerConsoleTrendSnapshots>>
  intakeAgreement(workspace: string, preset: string): Promise<RemoteResult<OwnerConsoleIntakeAgreement>>
  configureFeishu(appId: string, appSecretEnv: string, credentialHandle: string,
    account: string, tenant: string, discoverAppId: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureTraex(enabled: boolean, command: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureBundle(entry: string, config: Readonly<Record<string, unknown>>): Promise<RemoteResult<OwnerConsoleWriteResult>>
  setBundleEnabled(name: string, enabled: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  installProjectBundle(spec: string, approvedBuilds: readonly string[]): Promise<RemoteResult<OwnerConsoleWriteResult>>
  removeProjectBundle(name: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
}>
type SlotRuntime = {
  readonly remote: Readonly<{ ownerConsole: ConsoleRemote }>
  readonly slots: {
    inject(name: string, factory: () => unknown): () => void
    register(options: unknown, component: unknown): () => void
  }
}
type PermissionPresetsRemote = Readonly<{ catalog(): Promise<RemoteResult<PermissionCatalog>> }>
type ClientContext = {
  readonly remote: { readonly $mount: (value: unknown) => Promise<() => Promise<void>> }
  readonly get: <T>(name: string) => T | undefined
  inject(dependencies: readonly string[], callback: (runtime: SlotRuntime) => unknown): { dispose(): Promise<void> }
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

/**
 * Hook-free rendering of one read-only snapshot page. The only control is paging to older rows, which
 * re-reads; nothing here seals, edits or deletes a snapshot.
 */
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

/** Read-only trend snapshot card; it only ever calls `trendSnapshots`. */
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

/**
 * Hook-free rendering of one read-only intake agreement result. It shows counts only; nothing here
 * writes, adopts or sends, and a switched-off Evaluation is shown as not enabled.
 */
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
      // Evaluation reads notifications in [from, to).
      row('窗口', `[${isoTime(summary.fromNotifiedAt)}, ${isoTime(summary.toNotifiedAt)})`),
      row('扫描通知', el('span', { style: actionsStyle }, String(summary.scanned), summary.truncated ? pill('已截断', 'warn') : null)),
      row('intake 准入合计', agreementLabel(summary.intake)),
      ...summary.byLevel.map(entry => row(INTAKE_LEVEL_LABELS[entry.level], agreementLabel(entry.cell))),
      row('非 intake / 无法判断 / 他 scope', `${summary.notIntake} / ${summary.unresolved} / ${summary.foreign}`)),
    summary.provenanceAvailable ? null : el('div', { style: { ...actionsStyle, fontSize: 12, color: muted } },
      pill('WorkItems 未提供来源', 'warn'), '缺少 inspectIntakeProvenance，所有工作项计为无法判断。'))
}

const INTAKE_AVAILABILITY: Readonly<Record<IntakeAgreementAvailability, readonly [string, StatusTone]>> = {
  absent: ['未加载', 'neutral'],
  unknown: ['已加载，开关状态未知', 'warn'],
  disabled: ['未启用', 'neutral'],
  available: ['已启用', 'ok'],
}

/** Scope-free pill from `status`; the read below stays authoritative, so it never blocks the button. */
export function intakeAvailabilityPill(availability: IntakeAgreementAvailability | undefined) {
  if (availability === undefined) return pill('正在读取…', 'neutral')
  const [label, tone] = INTAKE_AVAILABILITY[availability]
  return pill(label, tone)
}

/** Read-only intake agreement card; its only control re-reads `intakeAgreement` for the typed scope. */
export function IntakeAgreementCard({ remote, availability }: Readonly<{ remote: ConsoleRemote,
  availability?: IntakeAgreementAvailability }>) {
  const [workspace, setWorkspace] = useState('')
  const [preset, setPreset] = useState('')
  const [result, setResult] = useState<OwnerConsoleIntakeAgreement>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  // The result never echoes its scope, so only the answer to the latest read for the
  // scope still in the fields may be shown: editing a field or a newer read drops it.
  const request = useRef(0)
  const edit = (set: (value: string) => void) => (value: string) => {
    request.current += 1
    set(value)
    setResult(undefined)
    setFailed(false)
    setBusy(false)
  }
  const load = () => {
    const id = ++request.current
    setFailed(false)
    setResult(undefined)
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
  }
  const blocked = busy || workspace.trim() === '' || preset.trim() === ''
  return card('intake 吻合度（只读）',
    el('div', { style: listStyle }, row('Evaluation 开关', intakeAvailabilityPill(availability))),
    el('div', { style: actionsStyle },
      field('workspace', workspace, edit(setWorkspace), '/absolute/workspace'),
      field('preset', preset, edit(setPreset), 'primary')),
    el('div', { style: actionsStyle },
      el('button', { style: idle(buttonStyle, blocked), disabled: blocked, onClick: load }, busy ? '读取中…' : '读取')),
    intakeAgreementView(result, failed))
}

/** Sidebar entry: the 11 深海觉醒 whale mark, cropped square and shown as a round avatar. */
export function OwnerConsoleIcon() {
  return el('span', { 'aria-hidden': true, style: { display: 'block', width: 18, height: 18, borderRadius: '50%', overflow: 'hidden', flex: 'none' } },
    el('img', { src: WENYAO_ICON_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false, 'data-owner-console-art': 'sidebar-icon',
      width: 18, height: 18, style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' } }))
}

export type OwnerConsoleNavigation = Readonly<{ openConversation(): void, openPlugins(): void }>

/** The main-slot panel: chat by default, with the configuration console behind the gear.
 * The renderer's seats arrive as top-level props (no package import); in their absence the
 * compact self-contained chat is the fallback. */
export type OwnerConsolePanelProps = OwnerConsoleRendererSeat & Readonly<{
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
  runtime: ChatRuntime
}>

export function OwnerConsolePanel({ remote, navigation, runtime, ...renderer }: OwnerConsolePanelProps) {
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  return view === 'chat'
    ? jsx(OwnerConsoleChat, { runtime, onOpenSettings: () => setView('settings'), renderer })
    : jsx(OwnerConsoleSettingsPanel, { remote, navigation, onBack: () => setView('chat') })
}

/** The existing configuration console, moved behind the chat header's ⚙ button. */
export function OwnerConsoleSettingsPanel({ remote, navigation, onBack }: Readonly<{
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
  onBack?: () => void
}>) {
  const [status, setStatus] = useState<OwnerConsoleStatus>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [appId, setAppId] = useState('')
  const [secretSource, setSecretSource] = useState<'env' | 'handle'>('env')
  const [secretEnv, setSecretEnv] = useState('LARK_APP_SECRET')
  const [secretHandle, setSecretHandle] = useState('')
  const [account, setAccount] = useState('')
  const [tenant, setTenant] = useState('')
  const [traexCommand, setTraexCommand] = useState('')
  const [bundleEntry, setBundleEntry] = useState('')
  const [bundleJson, setBundleJson] = useState('{}')
  const [installSpec, setInstallSpec] = useState('@dsh-enhanced/')

  const refresh = async () => {
    try {
      const result = await remote.status()
      if (result.ok) setStatus(result.value)
      else setError(`读取状态失败（${remoteFailureText(result.error)}）`)
    } catch (cause) {
      setError(cause instanceof Error ? `暂时无法读取状态：${cause.message}` : '暂时无法读取状态，稍后重试。')
    }
  }
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { void refresh().catch(() => undefined) }, [])

  const run = async (action: () => Promise<RemoteResult<OwnerConsoleWriteResult>>) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await action()
      if (!mounted.current) return
      if (!result.ok) { setError(`Host 拒绝了这次操作（${remoteFailureText(result.error)}）`); return }
      if (!result.value.applied) { setError(result.value.note); return }
      // A persisted change can still need a profile restart; refresh the rows and
      // show the Host note as information, not as a failed action.
      setError(''); setNotice(result.value.note); await refresh()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  /** A confirmation that is unavailable or declined is visible: neither is a silent no-op. */
  const confirmOwner = (message: string): boolean => {
    const answer = askOwner((globalThis as unknown as { confirm?: (message: string) => boolean }).confirm, message)
    const notice = confirmationNotice(answer, message)
    if (notice !== undefined) {
      if (answer === 'unavailable') setError(notice)
      else setNotice(notice)
      return false
    }
    return true
  }

  const runInstall = (spec: string) => run(() => installWithApproval(remote, spec, confirmOwner))

  const pending = status === undefined
  const larkReady = status !== undefined && status.feishu.entry !== undefined
  const larkState = componentState(status, LARK_PACKAGE)
  const traexState = componentState(status, TRAEX_PACKAGE)
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const entryLabel = (entry: string | undefined) => entry === undefined ? null
    : el('span', { style: monoMuted }, entry)
  /** A minimal repair: the exact missing bundles to install and a copyable patch to stop a stuck row. */
  const repairSection = (state: ComponentState, packageName: string) => el('div', { style: { display: 'grid', gap: 8 } },
    el('p', { style: hintStyle }, state.stalled
      ? `条目加载后配置表单才会出现。${missingRemedy(state) === '' ? '' : `${missingRemedy(state)}。`}修复依赖后重启 profile。`
      : `该条目当前不可写：${state.label}。`),
    state.missing.length === 0 ? null : el('div', { style: actionsStyle },
      ...state.missing.map(item => el('button', { key: item.bundle, style: btn(buttonStyle), disabled: busy,
        onClick: () => void runInstall(item.bundle) }, `安装 ${item.bundle}`))),
    state.stalled || state.kind === 'errored'
      ? el('textarea', { readOnly: true, rows: 4, 'aria-label': `${packageName} 最小修复 patch`, value: repairPatch(state, packageName),
        style: { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, resize: 'vertical' } })
      : null)

  const feishuRows = pending
    ? placeholder('正在读取…')
    : el('div', { style: listStyle },
      row('方式', status.feishu.mode === 'env' ? '环境变量 secret' : 'keychain secret'),
      row('入口', el('span', { style: actionsStyle }, pill(larkState.label, larkState.tone), entryLabel(status.feishu.entry))),
      ...(larkState.entry?.diagnostic === undefined ? [] : [row('诊断', boundedLine(larkState.entry.diagnostic))]),
      ...(larkState.error === undefined ? [] : [row('错误', `${larkState.error.code}${larkState.error.diagnostic === undefined ? '' : `：${boundedLine(larkState.error.diagnostic)}`}`)]),
      ...(larkState.missing.length === 0 ? [] : [row('缺少服务', missingRemedy(larkState))]),
      row('连接', pill(larkConnectionLabel(status.feishu.connection, status.feishu.lastErrorCode),
        larkConnectionTone(status.feishu.connection, status.feishu.lastErrorCode))),
      row('appId', pill(status.feishu.appIdConfigured ? '已配置' : '未配置', status.feishu.appIdConfigured ? 'ok' : 'warn')))
  const installLark = larkState.canInstall
    ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
      onClick: () => void runInstall(LARK_PACKAGE) }, '安装 lark-channel')
    : null
  const enableLark = larkState.canEnable
    ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
      onClick: () => void run(() => remote.setBundleEnabled(LARK_PACKAGE, true)) }, '启用 lark-channel')
    : null
  // A stalled or errored card stays actionable: it offers the missing bundles and a repair patch
  // instead of a dead-end "启用" button that would be a no-op on an already enabled bundle.
  const larkRepair = !larkReady && (larkState.stalled || larkState.missing.length > 0 || larkState.kind === 'errored')
    ? repairSection(larkState, LARK_PACKAGE) : null
  const feishuActions = !larkReady && !installLark && !enableLark && larkRepair === null
    ? null
    : el('div', { style: { display: 'grid', gap: 12 } },
      installLark === null && enableLark === null ? null : el('div', { style: actionsStyle }, installLark, enableLark),
      larkRepair,
      ...(larkReady ? [
    el('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }, role: 'radiogroup', 'aria-label': 'secret 引用方式' },
      el('span', { style: subheadStyle }, 'secret 引用'),
      el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
        el('input', { type: 'radio', name: 'secret-source', checked: secretSource === 'env', style: { accentColor: accent, margin: 0 },
          onChange: () => setSecretSource('env') }), '环境变量'),
      el('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
        el('input', { type: 'radio', name: 'secret-source', checked: secretSource === 'handle', style: { accentColor: accent, margin: 0 },
          onChange: () => setSecretSource('handle') }), 'keychain handle')),
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
          void run(() => remote.configureFeishu(appId, refs.appSecretEnv, refs.credentialHandle, account, tenant, false))
        } }, '应用配置'),
      el('button', { style: btn(), disabled: busy,
        onClick: () => {
          const refs = feishuSecretRefs(secretSource, secretEnv, secretHandle)
          void run(() => remote.configureFeishu('', refs.appSecretEnv, refs.credentialHandle, account, tenant, true))
        } }, '一键配置（从 Host 环境探测 appId）')),
    el('p', { style: hintStyle },
      '这里配置的是 lark-channel 通道；secret 只接受环境变量名或 keychain handle，明文不入配置。')] : []))

  const traexReady = status !== undefined && status.traex.entry !== undefined
  const traexRepair = !traexReady && (traexState.stalled || traexState.missing.length > 0 || traexState.kind === 'errored')
    ? repairSection(traexState, TRAEX_PACKAGE) : null
  const traexRows = el('div', { style: gridStyle },
    el('div', { style: listStyle },
      row('入口', el('span', { style: actionsStyle }, pill(traexState.label, traexState.tone), entryLabel(status?.traex.entry))),
      ...(traexState.entry?.diagnostic === undefined ? [] : [row('诊断', boundedLine(traexState.entry.diagnostic))]),
      ...(traexState.error === undefined ? [] : [row('错误', `${traexState.error.code}${traexState.error.diagnostic === undefined ? '' : `：${boundedLine(traexState.error.diagnostic)}`}`)]),
      ...(traexState.missing.length === 0 ? [] : [row('缺少服务', missingRemedy(traexState))]),
      row('命令', status === undefined || status.traex.command === '' ? '（默认）' : status.traex.command)),
    traexReady
      ? el('div', { style: { ...actionsStyle, alignItems: 'end' } },
        field('command（可选）', traexCommand, setTraexCommand, 'traex'),
        el('button', { style: btn(primaryButtonStyle), disabled: busy,
          onClick: () => void run(() => remote.configureTraex(true, traexCommand)) }, '启用'),
        el('button', { style: btn(), disabled: busy,
          onClick: () => void run(() => remote.configureTraex(false, '')) }, '停用'))
      : status === undefined
        ? placeholder('正在读取…')
        : el('div', { style: { display: 'grid', gap: 10 } },
          el('div', { style: actionsStyle },
            traexState.canInstall
              ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
                onClick: () => void runInstall(TRAEX_PACKAGE) }, '安装 traex-acp-provider')
              : null,
            traexState.canEnable
              ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
                onClick: () => void run(() => remote.setBundleEnabled(TRAEX_PACKAGE, true)) }, '启用 traex-acp-provider')
              : null),
          traexRepair))

  const itemStyle = { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${hairline}` }
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
            // A bundle the Host already refused must not offer "启用": the write would not change it.
            bundle.error !== undefined && !bundle.enabled ? null
              : el('button', { style: btn(), disabled: busy,
                onClick: () => void run(() => remote.setBundleEnabled(bundle.name, !bundle.enabled)) },
              bundle.enabled ? '停用' : '启用'),
            bundle.removable && bundle.name !== OWN_PACKAGE
              ? el('button', { style: btn(dangerButtonStyle), disabled: busy,
                onClick: () => {
                  // Without a confirmation channel the panel never performs the destructive step.
                  if (confirmOwner(`移除 ${bundle.name}？重新安装可用面板的安装入口。`)) {
                    void run(() => remote.removeProjectBundle(bundle.name))
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
            onClick: () => void run(() => remote.setPluginEnabled(plugin.entryId, !plugin.enabled)) },
          plugin.enabled ? '禁用' : '启用')))
    }))
  const bundles = el('div', { style: { display: 'grid', gap: 10 } },
    el('h4', { style: subheadStyle }, 'Bundle 层'),
    bundleRows,
    el('h4', { style: { ...subheadStyle, marginTop: 6 } }, '已加载条目'),
    pluginRows,
    el('div', { style: { ...actionsStyle, alignItems: 'end', marginTop: 6 } },
      field('安装本项目 bundle', installSpec, setInstallSpec, '@dsh-enhanced/plugin-name'),
      el('button', { style: btn(primaryButtonStyle), disabled: busy,
        onClick: () => void runInstall(installSpec) }, '安装')),
    el('p', { style: hintStyle }, '安装走 DSH 自身的 pnpm 路径，只装该包及其 pnpm 依赖；它的 @dsh-enhanced peer bundle 与 Host 服务不会自动安装，缺失项会显示在卡片里。安装/启用后如提示需要重启 profile，请依提示操作。'),
    el('details', { style: { marginTop: 4, borderTop: `1px solid ${hairline}`, paddingTop: 10 } },
      el('summary', { style: { fontSize: 12, fontWeight: 500, color: muted, cursor: 'pointer' } }, '高级：合并配置（只对声明了 live 字段的条目生效）'),
      el('div', { style: { display: 'grid', gap: 8, marginTop: 10 } },
        field('entry', bundleEntry, setBundleEntry, 'dsh-enhanced-...'),
        el('textarea', { value: bundleJson, rows: 4, 'aria-label': '合并配置 JSON',
          style: { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, resize: 'vertical' },
          onChange: (event: { target: { value: string } }) => setBundleJson(event.target.value) }),
        el('div', { style: actionsStyle },
          el('button', { style: btn(), disabled: busy, onClick: () => {
            try {
              const parsed = JSON.parse(bundleJson) as Readonly<Record<string, unknown>>
              void run(() => remote.configureBundle(bundleEntry, parsed))
            } catch { setError('配置必须是 JSON 对象') }
          } }, '应用配置')))))

  return el('section', { 'data-owner-console-settings': '', 'aria-label': '文鳐设置（主人控制台）', style: settingsSectionStyle },
    // 11 深海觉醒 background on the settings surface, not only the header. The whale sits
    // at low opacity behind every card and fades out before the lower rows; text stays on the
    // theme's card surface, so light/dark contrast is untouched.
    el('div', { style: backdropStyle },
      el('img', { src: WENYAO_BACKDROP_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false,
        'data-owner-console-art': 'backdrop', width: 960, height: 960, style: backdropImageStyle })),
    el('div', { 'data-owner-console-settings-scroll': '', style: settingsScrollStyle },
      el('div', { 'data-owner-console-content': '', style: panelStyle },
        onBack === undefined ? null : el('div', { 'data-owner-console-settings-bar': '',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        el('button', { type: 'button', style: buttonStyle, onClick: onBack, 'aria-label': '返回对话' }, '← 返回对话'),
        el('h2', { style: { margin: 0, fontSize: 13, fontWeight: 600, color: muted } }, '设置')),
        header(navigation),
        error === '' ? null : el('p', { role: 'alert', style: { ...bannerStyle(danger), fontWeight: 500 } },
          el('span', { 'aria-hidden': true, style: { color: danger, fontWeight: 700 } }, '!'), error),
        // A missing Host service is reported explicitly; the cards below then never read as "not installed".
        status !== undefined && (status.host.settings === false || status.host.pluginManager === false)
          ? el('p', { role: 'status', style: { ...bannerStyle(accent), fontSize: 12 } },
            `Host 服务不完整：settings ${status.host.settings ? '已加载' : '未加载'}、`
            + `pluginManager ${status.host.pluginManager ? '已加载' : '未加载'}；相关卡片只显示不可用，不能写入。`)
          : null,
        notice === '' ? null : el('p', { role: 'status', style: bannerStyle(accent) },
          el('span', { 'aria-hidden': true, style: { color: accent, fontWeight: 700 } }, 'i'), notice),
        card('远程接入（飞书）', feishuRows, feishuActions),
        card('TraeX', traexRows),
        card('本项目插件管理', bundles),
        jsx(TrendSnapshotsCard, { remote }),
        jsx(IntakeAgreementCard, { remote, availability: status?.evaluation.intakeAgreement }))))
}

function bannerStyle(color: string) {
  return { margin: 0, display: 'flex', gap: 10, alignItems: 'baseline', padding: '10px 14px', borderRadius: 10, fontSize: 13,
    color: ink, background: tint(color, 10), border: `1px solid ${tint(color, 30)}` }
}

/**
 * Brand header: the 11 深海觉醒 background cropped to a 3:1 banner (decorative, 108–300px
 * tall so a narrow pane never overflows), then name with the round whale seal, subtitle,
 * and the primary 开始对话 action. Text sits on the card surface below the image, so its
 * contrast follows the theme rather than the artwork.
 */
function header(navigation: OwnerConsoleNavigation) {
  return el('header', { 'data-owner-console-header': '', style: { overflow: 'hidden', borderRadius: 16,
    border: `1px solid ${border}`, color: ink, background: surface, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)' } },
  el('img', { src: WENYAO_HERO_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false, 'data-owner-console-art': 'hero',
    width: WENYAO_HERO_WIDTH, height: WENYAO_HERO_HEIGHT,
    style: { display: 'block', width: '100%', height: 'auto', aspectRatio: `${WENYAO_HERO_WIDTH} / ${WENYAO_HERO_HEIGHT}`,
      minHeight: 108, maxHeight: 300, objectFit: 'cover', objectPosition: 'center', borderBottom: `1px solid ${hairline}` } }),
  el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 18px' } },
    el('div', { style: { display: 'grid', gap: 4, minWidth: 0, flex: '1 1 280px' } },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        el('h2', { style: { margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1.25 } }, '文鳐 Ray'),
        el('img', { src: WENYAO_SEAL_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false, 'data-owner-console-art': 'seal',
          width: 30, height: 30, style: { display: 'block', width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flex: 'none' } })),
      el('p', { style: { margin: 0, fontSize: 13, color: muted, fontFamily: KAI_FONT, letterSpacing: '0.04em' } }, '你的个人助手小鳐 · 小鳐小鳐，游而化飞'),
      el('p', { style: { margin: '2px 0 0', fontSize: 12, color: caption } }, '只显示需要你处理的事；需要直接对话时从这里进入。')),
    el('div', { style: actionsStyle },
      el('button', { style: { ...primaryButtonStyle, padding: '8px 18px', fontSize: 14 }, onClick: () => navigation.openConversation() }, '开始对话'),
      el('button', { style: buttonStyle, onClick: () => navigation.openPlugins() }, '打开插件页'))))
}

/** Main-slot root: fills the fixed-height Host pane; each view owns its own scrolling. */
export function OwnerConsoleMain(props: OwnerConsolePanelProps) {
  return el('div', { 'data-owner-console-scroll': '', style: mainRootStyle }, jsx(OwnerConsolePanel, props))
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  try {
    // Core registration depends only on the remote namespace and the slot registry;
    // navigation services are resolved lazily so an embedding without them still
    // gets the sidebar entry and status page.
    const injection = ctx.inject(['remote.ownerConsole', 'slots'], runtime => {
      const remote = runtime.remote.ownerConsole
      const navigation = {
        openConversation: () => {
          try {
            ctx.get<{ startSession(): void }>('uiWorkspace')?.startSession()
          } catch { /* native shell only; a missing workspace is not an error here */ }
        },
        openPlugins: () => {
          try {
            ctx.get<{ selectPanel(panelId: string): void }>('layout')?.selectPanel('plugins')
          } catch { /* the native plugins page may not be registered in an embedding */ }
        },
      }
      // Every chat capability is resolved lazily from the Host client services; a missing one
      // degrades that control instead of taking the sidebar entry down.
      const chatRuntime: ChatRuntime = {
        sessions: () => ctx.get<ChatSessions>('sessions'),
        fileUploads: () => ctx.get<ChatUploads>('fileUpload'),
        permissionCatalog: () => {
          try {
            // Namespace services are registered as `remote.<namespace>`; `ctx.get` is the
            // canonical lookup and stays undefined when the Host did not compose the domain.
            const presets = ctx.get<PermissionPresetsRemote>('remote.permissionPresets')
            if (presets === undefined || typeof presets.catalog !== 'function') return undefined
            return presets.catalog()
          } catch {
            return undefined
          }
        },
        openNativeSession: sessionId => {
          try {
            const workspace = ctx.get<{ openSession(id: string): void }>('uiWorkspace')
            if (workspace === undefined || typeof workspace.openSession !== 'function') return false
            workspace.openSession(sessionId)
            return true
          } catch {
            return false
          }
        },
        startConversation: () => navigation.openConversation(),
        storage: () => browserStorage(),
        voiceAvailable: () => browserSpeechRecognition() !== undefined,
        createRecognition: () => {
          const Recognition = browserSpeechRecognition()
          return Recognition === undefined ? undefined : new Recognition()
        },
        recognitionLang: () => browserLang(),
        speakAvailable: () => browserSpeechSynthesisAvailable(),
        speak: text => speakInBrowser(text),
        createSession: async () => {
          const sessions = ctx.get<ChatSessions>('sessions')
          if (sessions === undefined) throw new Error('会话服务不可用')
          // A grouped Session can be opened in the native view without landing on a workspace
          // picker. The default Workspace is the only one the client API names; no catalog UI is
          // shown here. Any failure falls back to the previous ungrouped creation path.
          try {
            const workspaces = ctx.get<{
              initializeDefault(signal?: AbortSignal): Promise<Readonly<{ workspaceId?: string }> | undefined>
            }>('workspaces')
            const workspace = await workspaces?.initializeDefault()
            const workspaceId = workspace?.workspaceId
            if (workspaceId !== undefined && workspaceId !== '') {
              if (typeof sessions.connectWorkspace === 'function') {
                return await sessions.connectWorkspace(workspaceId)
              }
              return await sessions.create({ workspaceId })
            }
          } catch {
            // The default Workspace is optional; fall through to the Host default cwd.
          }
          return await sessions.create()
        },
        insertDraft: (reference, text) => {
          try {
            const conversation = ctx.get<{
              input?: {
                for(actx: unknown): {
                  state?: { getSnapshot(): Readonly<{ draft?: string }> }
                  setDraft(value: string): void
                  focus?(): void
                }
              }
            }>('conversation')
            const facade = conversation?.input?.for(reference.binding.ctx)
            if (facade === undefined) return false
            const draft = typeof facade.state?.getSnapshot === 'function' ? facade.state.getSnapshot().draft ?? '' : ''
            facade.setDraft(draft === '' ? text : `${draft} ${text}`)
            facade.focus?.()
            return true
          } catch {
            return false
          }
        },
      }
      const panel = (seats: Readonly<Record<string, unknown>>) =>
        jsx(OwnerConsoleMain, { ...seats, remote, navigation, runtime: chatRuntime })
      const sidebar = runtime.slots.inject('sidebar.panellist', () => runtime.slots.register(
        { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: () => '文鳐' }, OwnerConsoleIcon))
      // The declared session child is what makes the renderer inject SessionProvider and
      // renderSlot; the child body renders the Host's own `conversation.content` factory.
      const main = runtime.slots.inject('main', () => runtime.slots.register(
        { name: 'main', key: 'owner-console',
          children: { 'owner-console.conversation': { kind: 'single', scope: 'session' } } }, panel))
      const conversation = runtime.slots.inject('owner-console.conversation', () => runtime.slots.register(
        { name: 'owner-console.conversation' }, OwnerConsoleConversation))
      // Cordis effects accept a function: dispose the slot registrations in reverse order.
      return () => { conversation(); main(); sidebar() }
    })
    return async () => {
      await injection.dispose()
      await unmount()
    }
  } catch (error) {
    await unmount()
    throw error
  }
}
