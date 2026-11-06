import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { CloudMark, KAI_FONT, QUIET_PHRASE } from './art.js'
import { TYPERT_REMOTE } from './typert.js'
import { WENYAO_BACKDROP_DATA_URI, WENYAO_HERO_DATA_URI, WENYAO_HERO_HEIGHT, WENYAO_HERO_WIDTH,
  WENYAO_ICON_DATA_URI, WENYAO_SEAL_DATA_URI } from './artwork.js'
import type { IntakeAgreementAvailability, OwnerConsoleIntakeAgreement, OwnerConsoleStatus, OwnerConsoleTrendSnapshotItem, OwnerConsoleTrendSnapshots,
  OwnerConsoleWriteResult } from './typert.js'

/** The installed Host supplies remote and the slot registry. */
export const inject = ['remote', 'slots']

type RemoteResult<T> = Readonly<{ ok: true, value: T }> | Readonly<{ ok: false }>
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
  installProjectBundle(spec: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  removeProjectBundle(name: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
}>
type SlotRuntime = {
  readonly remote: Readonly<{ ownerConsole: ConsoleRemote }>
  readonly slots: {
    inject(name: string, factory: () => unknown): () => void
    register(options: unknown, component: unknown): () => void
  }
}
type ClientContext = {
  readonly remote: { readonly $mount: (value: unknown) => Promise<() => Promise<void>> }
  readonly get: <T>(name: string) => T | undefined
  inject(dependencies: readonly string[], callback: (runtime: SlotRuntime) => unknown): { dispose(): Promise<void> }
}

type Props = Record<string, unknown>
const el = (tag: string, props: Props, ...children: readonly unknown[]) => children.length === 0
  ? jsx(tag as never, props as never)
  : jsx(tag as never, { ...props, children: children.length === 1 ? children[0] : children } as never)

/** Only the reference the owner picked is submitted; the other stays empty. */
export function feishuSecretRefs(source: 'env' | 'handle', env: string,
  handle: string): Readonly<{ appSecretEnv: string, credentialHandle: string }> {
  return source === 'env' ? { appSecretEnv: env, credentialHandle: '' } : { appSecretEnv: '', credentialHandle: handle }
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

/** Status tone for a pill; every pill also carries a text label, so tone is never the only signal. */
export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral'

/** Read-only tone for the lark-channel connection pill. */
export function larkConnectionTone(connection: OwnerConsoleStatus['feishu']['connection'],
  lastErrorCode?: string): StatusTone {
  if (connection === 'connected') return lastErrorCode === undefined ? 'ok' : 'warn'
  if (connection === 'disconnected') return 'error'
  if (connection === 'absent' || connection === 'disabled') return lastErrorCode === undefined ? 'neutral' : 'error'
  return 'warn'
}

const OWN_PACKAGE = '@dsh-enhanced/owner-console'

/*
 * Theme tokens: only Host `--dsw-alias-*` variables (light/dark switch with the shell), each
 * with a light-theme fallback so an embedding without the token set still reads correctly.
 */
const ink = 'var(--dsw-alias-label-primary, #0f1115)'
const muted = 'var(--dsw-alias-label-secondary, #61666b)'
const caption = 'var(--dsw-alias-label-tertiary, #81858c)'
const hairline = 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04))'
const border = 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))'
const borderStrong = 'var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))'
const surface = 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent))'
const sunken = 'var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06))'
const accent = 'var(--dsw-alias-state-business-primary, #4176e6)'
const danger = 'var(--dsw-alias-state-error-primary, #ec1313)'
const toneColor: Readonly<Record<StatusTone, string>> = {
  ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
  warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  error: danger,
  neutral: 'var(--dsw-alias-state-idle-primary, #a3a3a3)',
}
/** A translucent wash of a token colour; works in both themes because it mixes with transparent. */
const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`

/**
 * The Host main slot is a fixed-height pane; the panel owns its own vertical scroll so
 * the lower cards stay reachable on short windows. `minHeight: 0` lets a flex/grid
 * parent shrink this root below its content height instead of clipping it.
 */
export const scrollRootStyle = { height: '100%', minHeight: 0, flex: '1 1 auto', overflowY: 'auto', boxSizing: 'border-box' } as const
const panelStyle = { position: 'relative', isolation: 'isolate', padding: '28px 24px 40px', maxWidth: 840, margin: '0 auto', display: 'grid', gap: 16, color: ink, fontSize: 13, lineHeight: 1.5 } as const
/** The artwork layer sits behind the content; `user-select`/pointer events stay off the decoration. */
const backdropStyle = { position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none', userSelect: 'none' } as const
const backdropImageStyle = { display: 'block', width: '100%', height: 'auto', opacity: 0.2,
  maskImage: 'linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, 0.55) 55%, transparent 94%)',
  WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, 0.55) 55%, transparent 94%)' } as const
const cardStyle = { border: `1px solid ${border}`, borderRadius: 12, padding: '16px 18px', background: surface, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)', display: 'grid', gap: 12, minWidth: 0 }
const inputStyle = { padding: '7px 10px', borderRadius: 8, border: `1px solid ${borderStrong}`, background: 'transparent', color: 'inherit', fontSize: 13, lineHeight: 1.4, width: '100%', minWidth: 0, boxSizing: 'border-box' }
/** Secondary button: outlined, quiet. */
const buttonStyle = { padding: '6px 12px', borderRadius: 8, border: `1px solid ${borderStrong}`, background: 'transparent', color: ink, fontSize: 13, fontWeight: 500, lineHeight: 1.4, cursor: 'pointer', whiteSpace: 'nowrap' }
/** Primary button: the shell's own primary fill so it inverts with the theme. */
const primaryButtonStyle = { ...buttonStyle, border: '1px solid transparent', background: 'var(--dsw-alias-button-primary-fill, #0f1115)', color: 'var(--dsw-alias-label-primary-foreground, #ffffff)' }
const dangerButtonStyle = { ...buttonStyle, color: danger, border: `1px solid ${tint(danger, 40)}` }
const gridStyle = { display: 'grid', gap: 8 }
/** Grouped read-only rows sit on a sunken well so they read as one block. */
const listStyle = { display: 'grid', background: sunken, borderRadius: 10, padding: '2px 12px' }
const actionsStyle = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
const hintStyle = { margin: 0, fontSize: 12, color: caption }
const subheadStyle = { margin: 0, fontSize: 12, fontWeight: 600, color: muted, letterSpacing: '0.02em' }

/** Disabled buttons keep their <button> semantics; this only dims them while a write is in flight. */
const idle = (style: Readonly<Record<string, unknown>>, busy: boolean) =>
  busy ? { ...style, opacity: 0.5, cursor: 'not-allowed' } : style

function pill(label: string, tone: StatusTone) {
  const color = toneColor[tone]
  return el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '1px 10px 1px 8px', borderRadius: 999,
    fontSize: 12, fontWeight: 500, lineHeight: '20px', color: ink, background: tint(color, 14), border: `1px solid ${tint(color, 32)}`, whiteSpace: 'nowrap' } },
  el('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: 999, background: color, flex: 'none' } }), label)
}

/** Empty/pending state; an empty list may add a short classical line under the plain message. */
function placeholder(text: string, phrase?: string) {
  return el('div', { style: { padding: '14px 12px', borderRadius: 10, border: `1px dashed ${border}`, color: caption, fontSize: 12, textAlign: 'center', display: 'grid', gap: 2 } },
    el('p', { style: { margin: 0 } }, text),
    phrase === undefined ? null : el('p', { style: { margin: 0, fontFamily: KAI_FONT, fontSize: 13, color: muted, letterSpacing: '0.12em' } }, phrase))
}

function row(label: string, value: unknown) {
  return el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: `1px solid ${hairline}`, minWidth: 0 } },
    el('span', { style: { color: muted, flex: 'none' } }, label),
    el('span', { style: { textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' } }, value))
}

/** Every card shares one frame: a titled header followed by evenly spaced body blocks. */
function card(title: string, ...body: readonly unknown[]) {
  return el('div', { style: cardStyle },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      el('span', { style: { color: accent, opacity: 0.75 } }, jsx(CloudMark, {})),
      el('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: ink, whiteSpace: 'nowrap' } }, title),
      el('span', { 'aria-hidden': true, style: { flex: 1, height: 1, minWidth: 24, background: `linear-gradient(90deg, ${border}, transparent)` } })),
    ...body)
}

function field(label: string, value: string, onChange: (next: string) => void, placeholderText = '') {
  return el('label', { style: { display: 'grid', gap: 4, fontSize: 12, fontWeight: 500, color: muted, minWidth: 0, flex: '1 1 200px' } },
    el('span', {}, label),
    el('input', { value, placeholder: placeholderText, style: inputStyle,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value) }))
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

export function OwnerConsolePanel({ remote, navigation }: Readonly<{
  remote: ConsoleRemote
  navigation: Readonly<{ openConversation(): void, openPlugins(): void }>
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
      else setError('Host 没有返回状态；请确认 settings 服务已加载。')
    } catch {
      setError('暂时无法读取状态，稍后重试。')
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
      if (!result.ok) { setError('Host 拒绝了这次操作，请检查输入。'); return }
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

  const pending = status === undefined
  const larkReady = status !== undefined && status.feishu.entry !== undefined
  const btn = (style: Readonly<Record<string, unknown>> = buttonStyle) => idle(style, busy)
  const feishuRows = pending
    ? placeholder('正在读取…')
    : el('div', { style: listStyle },
      row('方式', status.feishu.mode === 'env' ? '环境变量 secret' : 'keychain secret'),
      row('入口', status.feishu.entry ?? (status.feishu.installed ? 'lark-channel 已安装但未启用' : '未安装 lark-channel')),
      row('连接', pill(larkConnectionLabel(status.feishu.connection, status.feishu.lastErrorCode),
        larkConnectionTone(status.feishu.connection, status.feishu.lastErrorCode))),
      row('appId', pill(status.feishu.appIdConfigured ? '已配置' : '未配置', status.feishu.appIdConfigured ? 'ok' : 'warn')))
  const installLark = status !== undefined && !status.feishu.installed && status.feishu.entry === undefined
    ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
      onClick: () => void run(() => remote.installProjectBundle('@dsh-enhanced/lark-channel')) },
    '安装 lark-channel（含依赖）')
    : null
  const enableLark = status !== undefined && status.feishu.installed && status.feishu.entry === undefined
    ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
      onClick: () => void run(() => remote.setBundleEnabled('@dsh-enhanced/lark-channel', true)) },
    '启用 lark-channel')
    : null
  const feishuActions = !larkReady && !installLark && !enableLark
    ? null
    : el('div', { style: { display: 'grid', gap: 12 } },
      installLark === null && enableLark === null ? null : el('div', { style: actionsStyle }, installLark, enableLark),
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
  const traexRows = el('div', { style: gridStyle },
    el('div', { style: listStyle },
      row('入口', status?.traex.entry ?? (status?.traex.installed ? 'traex-acp-provider 已安装但未启用' : '未安装 traex-acp-provider')),
      row('状态', pill(status?.traex.enabled === true ? '已启用' : '未启用', status?.traex.enabled === true ? 'ok' : 'neutral')),
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
        : el('div', { style: actionsStyle }, !status.traex.installed
          ? el('button', { style: btn(primaryButtonStyle), disabled: busy,
            onClick: () => void run(() => remote.installProjectBundle('@dsh-enhanced/traex-acp-provider')) },
          '安装 traex-acp-provider（含依赖）')
          : el('button', { style: btn(primaryButtonStyle), disabled: busy,
            onClick: () => void run(() => remote.setBundleEnabled('@dsh-enhanced/traex-acp-provider', true)) },
          '启用 traex-acp-provider')))

  const itemStyle = { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${hairline}` }
  const bundleRows = pending
    ? placeholder('正在读取…')
    : status.bundles.length === 0
      ? placeholder('本 profile 中没有本项目的 bundle。', QUIET_PHRASE)
      : el('div', { style: listStyle }, ...status.bundles.map(bundle => el('div', { style: itemStyle },
        el('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, minWidth: 0, overflowWrap: 'anywhere' } },
          el('span', { style: { fontWeight: 500 } }, bundle.name),
          bundle.version === undefined ? null : el('span', { style: { fontSize: 12, color: caption } }, `@${bundle.version}`)),
        el('span', { style: actionsStyle },
          bundle.installed ? null : pill('未安装', 'warn'),
          pill(bundle.enabled ? '已启用' : '已停用', bundle.enabled ? 'ok' : 'neutral'),
          el('button', { style: btn(), disabled: busy,
            onClick: () => void run(() => remote.setBundleEnabled(bundle.name, !bundle.enabled)) },
          bundle.enabled ? '停用' : '启用'),
          bundle.removable && bundle.name !== OWN_PACKAGE
            ? el('button', { style: btn(dangerButtonStyle), disabled: busy,
              onClick: () => {
                const ask = (globalThis as unknown as { confirm?: (message: string) => boolean }).confirm
                // Without a confirmation channel the panel never performs the destructive step.
                if (ask !== undefined && ask(`移除 ${bundle.name}？重新安装可用面板的安装入口。`)) {
                  void run(() => remote.removeProjectBundle(bundle.name))
                }
              } }, '移除')
            : null))))
  const pluginRows = pending || status.plugins.length === 0
    ? placeholder(pending ? '正在读取…' : '没有已加载的本项目插件条目。', pending ? undefined : QUIET_PHRASE)
    : el('div', { style: listStyle }, ...status.plugins.map(plugin => el('div', { style: itemStyle },
      el('span', { style: { display: 'grid', minWidth: 0, overflowWrap: 'anywhere' } },
        el('span', { style: { fontWeight: 500 } }, plugin.moduleName),
        el('span', { style: { fontSize: 12, color: caption, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } },
          `${plugin.entryId} · ${plugin.fiberPhase ?? 'null'}`)),
      el('span', { style: actionsStyle },
        pill(plugin.enabled ? '已启用' : '已禁用', plugin.enabled ? 'ok' : 'neutral'),
        el('button', { style: btn(), disabled: busy,
          onClick: () => void run(() => remote.setPluginEnabled(plugin.entryId, !plugin.enabled)) },
        plugin.enabled ? '禁用' : '启用')))))
  const bundles = el('div', { style: { display: 'grid', gap: 10 } },
    el('h4', { style: subheadStyle }, 'Bundle 层'),
    bundleRows,
    el('h4', { style: { ...subheadStyle, marginTop: 6 } }, '已加载条目'),
    pluginRows,
    el('div', { style: { ...actionsStyle, alignItems: 'end', marginTop: 6 } },
      field('安装本项目 bundle（含依赖）', installSpec, setInstallSpec, '@dsh-enhanced/plugin-name'),
      el('button', { style: btn(primaryButtonStyle), disabled: busy,
        onClick: () => void run(() => remote.installProjectBundle(installSpec)) }, '安装')),
    el('p', { style: hintStyle }, '安装使用 DSH 自身的 pnpm 路径，会一并安装该包声明的依赖；安装/启用后如提示需要重启 profile，请依提示操作。'),
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

  return el('section', { 'aria-label': '文鳐（主人控制台）', style: panelStyle },
    // 11 深海觉醒 background on the panel's own surface, not only the header. The whale sits
    // at low opacity behind every card and fades out before the lower rows; text stays on the
    // theme's card surface, so light/dark contrast is untouched.
    el('div', { style: backdropStyle },
      el('img', { src: WENYAO_BACKDROP_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false,
        'data-owner-console-art': 'backdrop', width: 960, height: 960, style: backdropImageStyle })),
    el('div', { 'data-owner-console-content': '', style: { position: 'relative', zIndex: 1, display: 'grid', gap: 16 } },
      header(navigation),
      error === '' ? null : el('p', { role: 'alert', style: { ...bannerStyle(danger), fontWeight: 500 } },
        el('span', { 'aria-hidden': true, style: { color: danger, fontWeight: 700 } }, '!'), error),
      notice === '' ? null : el('p', { role: 'status', style: bannerStyle(accent) },
        el('span', { 'aria-hidden': true, style: { color: accent, fontWeight: 700 } }, 'i'), notice),
      card('远程接入（飞书）', feishuRows, feishuActions),
      card('TraeX', traexRows),
      card('本项目插件管理', bundles),
      jsx(TrendSnapshotsCard, { remote }),
      jsx(IntakeAgreementCard, { remote, availability: status?.evaluation.intakeAgreement })))
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
function header(navigation: Readonly<{ openConversation(): void, openPlugins(): void }>) {
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

/** Main-slot root: a scroll container around the panel. */
export function OwnerConsoleMain(props: Parameters<typeof OwnerConsolePanel>[0]) {
  return el('div', { 'data-owner-console-scroll': '', style: scrollRootStyle }, jsx(OwnerConsolePanel, props))
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
      const panel = () => jsx(OwnerConsoleMain, { remote, navigation })
      const sidebar = runtime.slots.inject('sidebar.panellist', () => runtime.slots.register(
        { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: () => '文鳐' }, OwnerConsoleIcon))
      const main = runtime.slots.inject('main', () => runtime.slots.register(
        { name: 'main', key: 'owner-console' }, panel))
      // Cordis effects accept a function: dispose the slot registrations in reverse order.
      return () => { main(); sidebar() }
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
