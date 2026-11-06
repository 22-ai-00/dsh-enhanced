/**
 * 文鳐's dedicated chat window. It is a real native Session surface, not a second agent:
 * messages come from the retained Session's durable event window, sending goes through
 * `SessionFace.prompt`, attachments through the staged `fileUpload` service, permission
 * changes through the Host `/permission` command, and stop through `SessionFace.cancel`.
 * A client bundle may only import `react` at runtime, so all Host services arrive through
 * the injected {@link ChatRuntime}.
 */
import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { QUIET_PHRASE } from './art.js'
import { WENYAO_BACKDROP_DATA_URI, WENYAO_ICON_DATA_URI } from './artwork.js'
import {
  boundedText, chatMessages, openDedicatedChatSession, permissionLabel, permissionOptions, permissionValue,
  remoteFailureSummary, requiresPermissionConfirmation, sendChatMessage, streamingAssistantText,
  type ChatBinding, type ChatEventWindow, type ChatMessage, type ChatReference, type ChatRuntime,
  type ChatSessionSnapshot, type PermissionCatalog, type SpeechRecognitionLike,
} from './chat.js'
import {
  accent, actionsStyle, backdropImageStyle, backdropStyle, border, borderStrong, buttonStyle, caption, danger,
  el, hairline, hintStyle, idle, ink, muted, pill, placeholder, primaryButtonStyle, subheadStyle, sunken,
  surface, tint,
} from './ui.js'

type ChatNotice = Readonly<{ tone: 'info' | 'error'; text: string }>

type SessionState =
  | Readonly<{ phase: 'preparing' }>
  | Readonly<{ phase: 'unavailable' }>
  | Readonly<{ phase: 'failed'; error: string }>
  | Readonly<{ phase: 'ready'; reference: ChatReference; binding: ChatBinding }>

/** Renderer seat shapes are structural: the Host injects these props, no package import is needed. */
export type FactoryRenderSlotSeat = (name: string, props: Readonly<Record<string, unknown>>,
  options?: Readonly<{ slots?: Readonly<Record<string, unknown>>, fallback?: unknown }>) => unknown
export type RenderSlotSeat = (name: string, props: Readonly<Record<string, unknown>>,
  options?: Readonly<{ fallback?: unknown }>) => unknown
export type SessionProviderSeat = (props: Readonly<{ session: ChatReference, children?: unknown }>) => unknown
/** Props every renderer-created component receives; only some are needed by this surface. */
export type OwnerConsoleRendererSeat = Readonly<{
  renderFactorySlot?: FactoryRenderSlotSeat
  renderSlot?: RenderSlotSeat
  SessionProvider?: SessionProviderSeat
}>

type ConversationSnapshotLike = Readonly<{ activeTargets: ReadonlySet<string> }>
type SessionListLike = Readonly<{ byId: Readonly<Record<string, Readonly<{ blank?: boolean }> | undefined>> }>
const EMPTY_SESSION: ChatSessionSnapshot = {}
const EMPTY_CONVERSATION: ConversationSnapshotLike = { activeTargets: new Set() }
const EMPTY_SESSION_LIST: SessionListLike = { byId: {} }
const readEmptySession = <T,>(selector: (value: ChatSessionSnapshot) => T): T => selector(EMPTY_SESSION)
const readEmptyConversation = <T,>(selector: (value: ConversationSnapshotLike) => T): T => selector(EMPTY_CONVERSATION)
const readEmptySessionList = <T,>(selector: (value: SessionListLike) => T): T => selector(EMPTY_SESSION_LIST)

type CatalogState =
  | Readonly<{ phase: 'loading' }>
  | Readonly<{ phase: 'absent' }>
  | Readonly<{ phase: 'failed'; error: string }>
  | Readonly<{ phase: 'ok'; catalog: PermissionCatalog }>

const chatRootStyle = { position: 'relative', isolation: 'isolate', height: '100%', minHeight: 0, display: 'flex',
  flexDirection: 'column', overflow: 'hidden', color: ink, fontSize: 13, lineHeight: 1.5 } as const
const chatColumnStyle = { position: 'relative', zIndex: 1, height: '100%', minHeight: 0, width: '100%', maxWidth: 840,
  margin: '0 auto', padding: '16px 18px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10 } as const
const headerStyle = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 14px',
  border: `1px solid ${border}`, borderRadius: 14, background: surface, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)' } as const
const logStyle = { flex: '1 1 auto', minHeight: 96, overflowY: 'auto', overscrollBehavior: 'contain', display: 'grid',
  alignContent: 'start', gap: 10, padding: '12px 12px 14px', border: `1px solid ${border}`, borderRadius: 12,
  background: surface, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)' } as const
const composerStyle = { display: 'grid', gap: 8, padding: '12px 14px', border: `1px solid ${border}`, borderRadius: 14,
  background: surface, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)' } as const
const bubbleStyle = { maxWidth: '86%', padding: '9px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.55,
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const
const assistantBubbleStyle = { ...bubbleStyle, justifySelf: 'start', background: sunken, border: `1px solid ${border}`, color: ink } as const
const userBubbleStyle = { ...bubbleStyle, justifySelf: 'end', background: tint(accent, 12), border: `1px solid ${tint(accent, 28)}`, color: ink } as const
const toolRowStyle = { justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '2px 8px',
  borderRadius: 999, border: `1px solid ${hairline}`, color: caption, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 } as const
const errorRowStyle = { padding: '8px 12px', borderRadius: 10, fontSize: 12, color: ink, background: tint(danger, 10),
  border: `1px solid ${tint(danger, 32)}` } as const
const smallButtonStyle = { ...buttonStyle, padding: '4px 10px', fontSize: 12 } as const
const ghostButtonStyle = { ...buttonStyle, border: '1px solid transparent', color: muted } as const
const gearButtonStyle = { ...buttonStyle, padding: '5px 10px', fontSize: 16, lineHeight: 1.15 } as const

const noticeStyle = (tone: ChatNotice['tone']) => ({ ...(tone === 'error' ? errorRowStyle : { padding: '8px 12px', borderRadius: 10,
  fontSize: 12, color: ink, background: tint(accent, 10), border: `1px solid ${tint(accent, 30)}` }) })

const TOOL_STATUS_LABELS: Readonly<Record<'running' | 'ok' | 'error', string>> = {
  running: '运行中', ok: '完成', error: '失败',
}

/** The factory-local view selection: the native Chat view, exactly as the shipped Conversation uses it. */
function ChatConversationView({ renderSlot }: Readonly<{ renderSlot?: RenderSlotSeat }>) {
  return renderSlot?.('conversation.session', { view: 'chat' }) ?? null
}

export interface OwnerConsoleConversationSeat {
  readonly sessionId?: string
  readonly renderFactorySlot?: FactoryRenderSlotSeat
  readonly useSession?: (selector: (value: ChatSessionSnapshot) => unknown) => unknown
  readonly useConversation?: (selector: (value: ConversationSnapshotLike) => unknown) => unknown
  readonly useSessions?: (selector: (value: SessionListLike) => unknown) => unknown
}

/**
 * Child slot body rendered under the injected SessionProvider. It computes the native
 * Conversation phase from the Session's own snapshots and renders the shipped
 * `conversation.content` factory with `hero:false` so no workspace picker or catalog appears.
 */
export function OwnerConsoleConversation({ sessionId, renderFactorySlot, useSession, useConversation,
  useSessions }: OwnerConsoleConversationSeat) {
  // Hooks are called unconditionally so the fallback functions cannot change hook order.
  const session = (useSession ?? readEmptySession)(value => value) as ChatSessionSnapshot
  const conversation = (useConversation ?? readEmptyConversation)(value => value) as ConversationSnapshotLike
  const summaryBlank = (useSessions ?? readEmptySessionList)(state => state.byId[sessionId ?? '']?.blank)
  if (renderFactorySlot === undefined) return placeholder('原生对话组件未加载，可用右上角「原生会话」进入完整会话。')
  const active = conversation.activeTargets.size > 0
    || (session.blank !== true && session.awaitingFirstTurn !== true)
    || session.running === true
  const shellPhase = active ? 'active' : session.promptAttempted === true ? 'engaging' : 'blank'
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  // The hero layout is deliberately suppressed here; the sticky active composer layout is what
  // remains usable without the workspace picker, so never hand the native surface a hero phase.
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: hero ? 'active' : phase, hero: false }, {
    slots: { views: ChatConversationView },
    fallback: placeholder('原生对话组件未加载，可用右上角「原生会话」进入完整会话。'),
  })
}

/** Browser voice/read-aloud controls used beside the native composer (outside its single-occupant slots). */
function NativeToolbar({ voiceAvailable, listening, speakAvailable, speakReady, onVoice, onSpeak }: Readonly<{
  voiceAvailable: boolean
  listening: boolean
  speakAvailable: boolean
  speakReady: boolean
  onVoice: () => void
  onSpeak: () => void
}>) {
  return el('div', { 'data-owner-console-voice-toolbar': '', style: { ...actionsStyle, padding: '0 2px' } },
    el('button', { type: 'button', style: voiceAvailable ? smallButtonStyle : idle(smallButtonStyle, true),
      'aria-label': voiceAvailable ? (listening ? '停止语音对话' : '语音对话') : '语音对话（当前浏览器不支持）',
      'aria-pressed': listening,
      title: voiceAvailable
        ? '语音转写会写入原生草稿；识别由浏览器 SpeechRecognition 提供，音频可能发送给浏览器厂商的语音服务，不属于 DSH 权限模型或审计范围'
        : '当前浏览器未提供 SpeechRecognition，语音输入不可用；该功能由浏览器提供，不是 DSH 模型功能',
      disabled: !voiceAvailable, onClick: onVoice },
    listening ? '停止语音' : '语音对话'),
    el('button', { type: 'button', style: speakAvailable && speakReady ? smallButtonStyle : idle(smallButtonStyle, true),
      'aria-label': '朗读最近一条回复', title: speakAvailable
        ? '用浏览器 SpeechSynthesis 朗读最近一条回复；远端语音可能把文本发送给浏览器厂商，不是 DSH 模型'
        : '当前浏览器未提供 SpeechSynthesis，朗读不可用',
      disabled: !speakAvailable || !speakReady, onClick: onSpeak }, '朗读'),
    el('span', { style: { ...hintStyle, fontSize: 11 } },
      '语音转写只写入本会话的原生草稿；语音识别/合成由浏览器提供，音频或文本可能发送给浏览器厂商的语音服务，不是 DSH 模型功能。'))
}

/** Round 11 深海觉醒 whale mark used by the chat header. */
function ChatMark() {
  return el('img', { src: WENYAO_ICON_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false,
    'data-owner-console-art': 'chat-mark', width: 34, height: 34,
    style: { display: 'block', width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', flex: 'none' } })
}

/** One compact transcript row; every visual state also carries a text label. */
function ChatMessageRow({ message }: Readonly<{ message: ChatMessage }>) {
  if (message.kind === 'tool') {
    return el('div', { 'data-chat-message-kind': 'tool', style: toolRowStyle, role: 'status',
      'aria-label': `工具 ${message.name}：${TOOL_STATUS_LABELS[message.status]}` },
    el('span', {}, message.name),
    el('span', { 'aria-hidden': true }, '·'),
    el('span', {}, TOOL_STATUS_LABELS[message.status]))
  }
  if (message.kind === 'error') {
    return el('div', { 'data-chat-message-kind': 'error', role: 'alert', style: errorRowStyle }, message.text)
  }
  return el('div', { 'data-chat-message-kind': message.kind, style: message.kind === 'user' ? userBubbleStyle : assistantBubbleStyle },
    el('span', { style: { display: 'block', fontSize: 11, color: caption, marginBottom: 3 } }, message.kind === 'user' ? '你' : '文鳐'),
    message.text)
}

/** Session lifecycle as a text pill; absence means the chat is still preparing. */
function sessionPill(snapshot: ChatSessionSnapshot, ready: boolean) {
  if (!ready) return pill('准备中', 'neutral')
  if (snapshot.openState === 'error') return pill('会话不可用', 'error')
  if (snapshot.removed === true) return pill('会话已移除', 'error')
  if (snapshot.running === true) return pill('回复中', 'warn')
  if (snapshot.openState === 'loading' || snapshot.openState === 'cold') return pill('连接中', 'neutral')
  return pill('就绪', 'ok')
}

/** Permission value pill: full access is visibly risky even though text carries the meaning. */
function permissionTone(value: string | undefined) {
  if (value === undefined) return 'neutral' as const
  if (value === 'danger-full-access') return 'error' as const
  if (value === 'auto') return 'warn' as const
  return 'ok' as const
}

interface PermissionBarProps {
  readonly session: ChatBinding['session'] | undefined
  readonly permission: string | undefined
  readonly catalog: CatalogState
  readonly switching: boolean
  readonly pending: string | undefined
  readonly notice: string
  readonly request: (value: string) => void
  readonly confirm: (value: string) => void
  readonly cancel: () => void
}

/** Current permission plus the catalog selector; every write goes through the native command. */
function PermissionBar({ session, permission, catalog, switching, pending, notice, request, confirm, cancel }: PermissionBarProps) {
  // Keep the selector mounted while a switch is in flight (disabled), so a rerender cannot
  // replace the user's focused control with the notice line.
  const selectable = session !== undefined && permission !== undefined && catalog.phase === 'ok'
  const options = catalog.phase === 'ok' ? permissionOptions(catalog.catalog, permission) : []
  return el('div', { 'data-owner-console-permissions': '', style: { display: 'flex', alignItems: 'center', gap: 8,
    flexWrap: 'wrap', padding: '0 2px', minHeight: 26 } },
  el('span', { style: subheadStyle }, '权限'),
  permission === undefined ? pill('权限不可用', 'neutral') : pill(permissionLabel(permission, catalog.phase === 'ok' ? catalog.catalog : undefined), permissionTone(permission)),
  selectable
    ? el('select', { 'aria-label': '切换权限预设', title: '切换通过 Host 的 /permission 命令完成，权限策略仍然生效',
      value: permission, disabled: switching, onChange: (event: { target: { value: string } }) => request(event.target.value),
      style: { padding: '4px 8px', borderRadius: 8, border: `1px solid ${borderStrong}`, background: 'transparent',
        color: 'inherit', fontSize: 12, maxWidth: 260 } },
    ...options.map(option => el('option', { key: option.value, value: option.value }, `${option.name}（${option.value}）`)))
    : catalog.phase === 'loading'
      ? el('span', { style: hintStyle }, '正在读取权限目录…')
      : catalog.phase === 'failed'
        ? el('span', { style: hintStyle }, `权限目录读取失败：${boundedText(catalog.error, 120)}；只能显示当前值。`)
        : permission === undefined
          ? el('span', { style: hintStyle }, '未加载权限服务；这里不会绕过 Host 策略。')
          : null,
  catalog.phase === 'ok' && catalog.catalog.defaultPreset !== undefined
    ? el('span', { style: { fontSize: 11, color: caption } }, `新会话默认：${permissionLabel(catalog.catalog.defaultPreset, catalog.catalog)}`)
    : null,
  pending === undefined ? null : el('div', { role: 'alertdialog', 'aria-label': '确认切换权限',
    style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 10px', borderRadius: 10,
      fontSize: 12, background: tint(danger, 10), border: `1px solid ${tint(danger, 32)}` } },
  `切换到「${permissionLabel(pending, catalog.phase === 'ok' ? catalog.catalog : undefined)}」会扩大文鳐的权限，确认？`,
  el('button', { type: 'button', style: smallButtonStyle, onClick: () => confirm(pending) }, '确认切换'),
  el('button', { type: 'button', style: smallButtonStyle, onClick: cancel }, '取消')),
  notice === '' ? null : el('span', { role: 'status', style: { fontSize: 12, color: muted } }, notice))
}

interface ComposerProps {
  readonly disabled: boolean
  readonly sending: boolean
  readonly draft: string
  readonly files: readonly Blob[]
  readonly running: boolean
  readonly cancelling: boolean
  readonly voiceAvailable: boolean
  readonly listening: boolean
  readonly speakAvailable: boolean
  readonly speakReady: boolean
  readonly onDraft: (value: string) => void
  readonly onSubmit: (event: { preventDefault(): void }) => void
  readonly onKeyDown: (event: KeyboardEventLike) => void
  readonly onFiles: (files: ArrayLike<Blob> | null) => void
  readonly onRemoveFile: (index: number) => void
  readonly onVoice: () => void
  readonly onSpeak: () => void
  readonly onStop: () => void
}

type KeyboardEventLike = {
  readonly key?: string
  readonly shiftKey?: boolean
  readonly nativeEvent?: { readonly isComposing?: boolean }
  preventDefault(): void
}

/** Composer: real text, staged attachments, browser speech, stop, and one send path. */
function Composer(props: ComposerProps) {
  const input = useRef<HTMLInputElement | null>(null)
  const blocked = props.disabled || props.sending || (props.draft.trim() === '' && props.files.length === 0)
  return el('form', { 'data-owner-console-composer': '', style: composerStyle, 'aria-label': '消息输入',
    onSubmit: props.onSubmit },
  props.files.length === 0 ? null : el('ul', { 'aria-label': '待发送附件', style: { ...actionsStyle, listStyle: 'none', margin: 0, padding: 0 } },
    ...props.files.map((file, index) => {
      const name = (file as Blob & { name?: string }).name ?? `附件 ${index + 1}`
      return el('li', { key: `${name}:${index}`, style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px',
        borderRadius: 999, border: `1px solid ${border}`, fontSize: 12, background: sunken } },
      el('span', { style: { maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
      el('button', { type: 'button', style: { ...ghostButtonStyle, padding: '0 2px', fontSize: 14 },
        'aria-label': `移除附件 ${name}`, onClick: () => props.onRemoveFile(index) }, '×'))
    })),
  el('textarea', { value: props.draft, rows: 3, 'aria-label': '给文鳐的消息', placeholder: '对文鳐说点什么…（Enter 发送，Shift+Enter 换行）',
    disabled: props.disabled || props.sending, onChange: (event: { target: { value: string } }) => props.onDraft(event.target.value),
    onKeyDown: props.onKeyDown,
    style: { ...buttonlessInputStyle, resize: 'vertical', minHeight: 72 } }),
  el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
    el('input', { ref: input, type: 'file', multiple: true, 'aria-label': '选择附件', tabIndex: -1,
      style: { display: 'none' }, onChange: (event: { target: { files?: ArrayLike<Blob> | null; value?: string } }) => {
        props.onFiles(event.target.files ?? null)
        if (event.target.value !== undefined) event.target.value = ''
      } }),
    el('button', { type: 'button', style: smallButtonStyle, onClick: () => input.current?.click(),
      'aria-label': '添加附件', title: '附件会先上传到本会话，再随消息发送' }, '附件'),
    el('button', { type: 'button', style: props.voiceAvailable ? smallButtonStyle : idle(smallButtonStyle, true),
      'aria-label': props.voiceAvailable ? (props.listening ? '停止语音对话' : '语音对话') : '语音对话（当前浏览器不支持）',
      'aria-pressed': props.listening,
      title: props.voiceAvailable
        ? '语音输入由浏览器 SpeechRecognition 提供，音频可能发送给浏览器厂商的语音服务，不属于 DSH 权限模型或审计范围'
        : '当前浏览器未提供 SpeechRecognition，语音输入不可用；该功能由浏览器提供，不是 DSH 模型功能',
      disabled: !props.voiceAvailable || props.sending, onClick: props.onVoice },
    props.listening ? '停止语音' : '语音对话'),
    el('button', { type: 'button', style: props.speakAvailable && props.speakReady ? smallButtonStyle : idle(smallButtonStyle, true),
      'aria-label': '朗读最近一条回复', title: props.speakAvailable
        ? '用浏览器 SpeechSynthesis 朗读最近一条回复；远端语音可能把文本发送给浏览器厂商，不是 DSH 模型'
        : '当前浏览器未提供 SpeechSynthesis，朗读不可用',
      disabled: !props.speakAvailable || !props.speakReady || props.sending, onClick: props.onSpeak }, '朗读'),
    el('span', { 'aria-hidden': true, style: { flex: '1 1 20px' } }),
    props.running ? el('button', { type: 'button', style: smallButtonStyle, disabled: props.cancelling, onClick: props.onStop },
      props.cancelling ? '停止中…' : '停止') : null,
    el('button', { type: 'submit', style: idle(primaryButtonStyle, blocked), disabled: blocked,
      'aria-label': props.sending ? '正在发送消息' : '发送消息' }, props.sending ? '发送中…' : '发送')),
  el('p', { style: { ...hintStyle, fontSize: 11 } },
    '消息经由 DSH 会话发送；附件先上传到本会话。语音输入与朗读由浏览器提供，音频或文本可能发送给浏览器厂商的语音服务，不是 DSH 模型功能。'))
}

/** One-line textarea style: same input shell without the single-line padding assumptions. */
const buttonlessInputStyle = { padding: '8px 10px', borderRadius: 10, border: `1px solid ${borderStrong}`,
  background: 'transparent', color: 'inherit', fontSize: 13, lineHeight: 1.5, width: '100%', minWidth: 0,
  boxSizing: 'border-box' } as const

export interface OwnerConsoleChatProps {
  readonly runtime: ChatRuntime
  readonly onOpenSettings: () => void
  /** Renderer-injected seats from the Host; absence selects the self-contained compact fallback. */
  readonly renderer?: OwnerConsoleRendererSeat
}

/** The sidebar's 文鳐 panel: a native-Session chat window with a settings gear. */
export function OwnerConsoleChat({ runtime, onOpenSettings, renderer }: OwnerConsoleChatProps) {
  const [state, setState] = useState<SessionState>({ phase: 'preparing' })
  const [attempt, setAttempt] = useState(0)
  const [snapshot, setSnapshot] = useState<ChatSessionSnapshot>({})
  const [window, setWindow] = useState<ChatEventWindow>({})
  const [permission, setPermission] = useState<string>()
  const [catalog, setCatalog] = useState<CatalogState>({ phase: 'loading' })
  const [pendingPermission, setPendingPermission] = useState<string>()
  const [switching, setSwitching] = useState(false)
  const [permissionNotice, setPermissionNotice] = useState('')
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<readonly Blob[]>([])
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [notice, setNotice] = useState<ChatNotice>()
  const [listening, setListening] = useState(false)
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const log = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // Acquire one retained native Session; release it exactly when the chat surface unmounts.
  useEffect(() => {
    alive.current = true
    let disposed = false
    let reference: ChatReference | undefined
    const controller = new AbortController()
    const sessions = runtime.sessions()
    if (sessions === undefined) {
      setState({ phase: 'unavailable' })
      return () => { disposed = true }
    }
    setState({ phase: 'preparing' })
    void (async () => {
      try {
        reference = await openDedicatedChatSession(sessions, runtime.storage(), undefined, runtime.createSession, controller.signal)
        if (disposed) {
          reference.release()
          return
        }
        setState({ phase: 'ready', reference, binding: reference.binding })
      } catch (error) {
        if (disposed) return
        setState({ phase: 'failed', error: error instanceof Error ? boundedText(error.message) : '无法打开对话。' })
      }
    })()
    return () => {
      disposed = true
      // Cancelling the acquisition stops the Host waiting on a hung open, so this panel
      // cannot leak its retention after unmount.
      controller.abort()
      reference?.release()
    }
  }, [runtime, attempt])

  const binding = state.phase === 'ready' ? state.binding : undefined
  const reference = state.phase === 'ready' ? state.reference : undefined
  const nativeSurface = reference !== undefined && renderer?.SessionProvider !== undefined && renderer.renderSlot !== undefined
    ? { reference, provider: renderer.SessionProvider, renderSlot: renderer.renderSlot }
    : undefined
  const native = nativeSurface !== undefined

  // Session lifecycle and durable transcript subscriptions.
  useEffect(() => {
    if (binding === undefined) {
      setSnapshot({})
      setWindow({})
      return
    }
    const syncSession = () => setSnapshot(binding.session.getSnapshot())
    const syncEvents = () => setWindow(binding.eventSource.getSnapshot())
    syncSession()
    syncEvents()
    const stopSession = binding.session.subscribe(syncSession)
    const stopEvents = binding.eventSource.subscribe(syncEvents)
    return () => { stopSession(); stopEvents() }
  }, [binding])

  // Current permission comes from the native Session projection, never from a local guess.
  useEffect(() => {
    if (binding === undefined) {
      setPermission(undefined)
      return
    }
    const face = binding.session.projections.faceOf('permissions')
    const sync = () => setPermission(permissionValue(face.getSnapshot()))
    sync()
    return face.subscribe(sync)
  }, [binding])

  // Selectable presets come from the Host's process catalog Remote.
  useEffect(() => {
    let disposed = false
    let pending: ReturnType<ChatRuntime['permissionCatalog']>
    try {
      pending = runtime.permissionCatalog()
    } catch (error) {
      setCatalog({ phase: 'failed', error: error instanceof Error ? error.message : '权限目录读取失败' })
      return () => { disposed = true }
    }
    if (pending === undefined) {
      setCatalog({ phase: 'absent' })
      return () => { disposed = true }
    }
    setCatalog({ phase: 'loading' })
    void pending.then(result => {
      if (disposed) return
      if (result.ok) setCatalog({ phase: 'ok', catalog: result.value })
      else setCatalog({ phase: 'failed', error: remoteFailureSummary(result.error) })
    }, (error: unknown) => {
      if (!disposed) setCatalog({ phase: 'failed', error: error instanceof Error ? error.message : '权限目录读取失败' })
    })
    return () => { disposed = true }
  }, [runtime])

  const messages = chatMessages(window.entries)
  const streaming = streamingAssistantText(window.entries)
  const lastAssistant = [...messages].reverse().find(message => message.kind === 'assistant')
  const voiceAvailable = runtime.voiceAvailable()
  const speakAvailable = runtime.speakAvailable()
  // The native composer already owns the canonical permission chip. Show our own bar only when
  // that native seat is unavailable (no renderer surface, or no permission-preset remote).
  const showPermissionBar = !native || catalog.phase === 'absent' || catalog.phase === 'failed'

  // Follow new output only while the reader is already at the bottom.
  useEffect(() => {
    const node = log.current
    if (node !== null && stick.current) node.scrollTop = node.scrollHeight
  }, [messages, streaming, binding])

  useEffect(() => () => {
    const active = recognition.current
    recognition.current = null
    try { active?.stop() } catch { /* a browser may already have ended it */ }
  }, [])

  const submit = () => {
    if (binding === undefined || sending) return
    if (draft.trim() === '' && files.length === 0) return
    setSending(true)
    setNotice(undefined)
    void sendChatMessage({ sessionId: binding.sessionId, session: binding.session, uploads: runtime.fileUploads(),
      text: draft, files }).then(outcome => {
      if (!alive.current) return
      setSending(false)
      if (!outcome.ok) {
        setNotice({ tone: 'error', text: outcome.error })
        return
      }
      setDraft('')
      setFiles([])
    }, (error: unknown) => {
      if (!alive.current) return
      setSending(false)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '消息未发送，稍后重试。' })
    })
  }

  const stop = () => {
    if (binding === undefined || cancelling) return
    setCancelling(true)
    setNotice(undefined)
    void binding.session.cancel().then(result => {
      if (!alive.current) return
      setCancelling(false)
      if (!result.ok) setNotice({ tone: 'error', text: `停止失败（${remoteFailureSummary(result.error)}）` })
    }, (error: unknown) => {
      if (!alive.current) return
      setCancelling(false)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '停止失败。' })
    })
  }

  const applyPermission = (value: string) => {
    if (binding === undefined || switching) return
    setPendingPermission(undefined)
    setSwitching(true)
    setPermissionNotice('')
    void binding.session.command(`/permission ${value}`).then(result => {
      if (!alive.current) return
      setSwitching(false)
      if (!result.ok) {
        setPermissionNotice(`权限切换被拒绝（${remoteFailureSummary(result.error)}）`)
        return
      }
      if (result.value.matched === false) {
        setPermissionNotice('Host 没有提供 /permission 命令，权限未改变。')
        return
      }
      setPermissionNotice(`已请求切换到「${permissionLabel(value, catalog.phase === 'ok' ? catalog.catalog : undefined)}」；以会话权限投影为准。`)
    }, (error: unknown) => {
      if (!alive.current) return
      setSwitching(false)
      setPermissionNotice(error instanceof Error ? boundedText(error.message) : '权限切换失败。')
    })
  }

  const requestPermission = (value: string) => {
    if (value === permission) return
    if (requiresPermissionConfirmation(value)) {
      setPendingPermission(value)
      return
    }
    applyPermission(value)
  }

  const toggleVoice = () => {
    if (listening) {
      const active = recognition.current
      recognition.current = null
      setListening(false)
      try { active?.stop() } catch { /* already ended */ }
      return
    }
    const created = runtime.createRecognition()
    if (created === undefined) {
      setNotice({ tone: 'error', text: '当前浏览器未提供 SpeechRecognition，语音输入不可用；语音识别由浏览器提供，不是 DSH 模型功能。' })
      return
    }
    created.lang = runtime.recognitionLang()
    created.interimResults = true
    created.continuous = false
    created.onresult = event => {
      // A late result from a stopped/replaced recognizer (or after unmount) must not touch the draft.
      if (!alive.current || recognition.current !== created) return
      let finalText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result?.isFinal === true) finalText += result[0]?.transcript ?? ''
      }
      if (finalText === '') return
      if (native && reference !== undefined) {
        const inserted = runtime.insertDraft?.(reference, finalText) ?? false
        if (!inserted) {
          setNotice({ tone: 'error', text: '当前界面未提供原生草稿写入接口（conversation.input 未加载），语音文字未写入。' })
        }
        return
      }
      setDraft(previous => previous === '' ? finalText : `${previous} ${finalText}`)
    }
    created.onerror = event => {
      if (!alive.current || recognition.current !== created) return
      recognition.current = null
      setListening(false)
      setNotice({ tone: 'error', text: `语音识别失败：${event.error ?? '未知错误'}。语音识别由浏览器提供，不是 DSH 模型功能。` })
    }
    created.onend = () => {
      // A stopped/replaced recognizer must not clear the instance that replaced it.
      if (!alive.current || recognition.current !== created) return
      recognition.current = null
      setListening(false)
    }
    recognition.current = created
    try {
      created.start()
      setListening(true)
      setNotice(undefined)
    } catch {
      recognition.current = null
      setNotice({ tone: 'error', text: '浏览器拒绝启动语音识别。' })
    }
  }

  const speak = () => {
    if (lastAssistant === undefined) {
      setNotice({ tone: 'info', text: '还没有可朗读的回复。' })
      return
    }
    if (!runtime.speak(lastAssistant.text)) {
      setNotice({ tone: 'error', text: '浏览器语音合成不可用。' })
    }
  }

  const addFiles = (chosen: ArrayLike<Blob> | null) => {
    if (runtime.fileUploads() === undefined) {
      setNotice({ tone: 'error', text: '当前界面未提供附件上传服务（fileUpload 未加载），无法上传附件。' })
      return
    }
    const next = [...files]
    for (const file of Array.from(chosen ?? [])) next.push(file)
    if (next.length > 10) {
      setNotice({ tone: 'error', text: '一次最多附加 10 个文件。' })
    }
    setFiles(next.slice(0, 10))
  }

  const openNative = () => {
    if (binding !== undefined && runtime.openNativeSession(binding.sessionId)) return
    setNotice({ tone: 'error', text: '当前界面未提供原生会话视图（uiWorkspace 未加载）；文鳐仍在这个窗口中对话。' })
  }

  const keyDown = (event: KeyboardEventLike) => {
    if (event.key !== 'Enter' || event.shiftKey === true || event.nativeEvent?.isComposing === true) return
    event.preventDefault()
    submit()
  }

  const ready = binding !== undefined
  const disabled = !ready || sending
  const scroll = (event: { currentTarget: { scrollHeight: number; scrollTop: number; clientHeight: number } }) => {
    stick.current = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 48
  }

  let transcript: unknown
  if (state.phase === 'preparing') transcript = placeholder('正在准备对话…')
  else if (state.phase === 'unavailable') {
    transcript = el('div', { style: { display: 'grid', gap: 10, justifyItems: 'start' } },
      placeholder('当前界面未提供会话服务（sessions 未加载），无法在这里对话。可以进入原生会话界面继续。'),
      el('button', { type: 'button', style: primaryButtonStyle, onClick: () => runtime.startConversation() }, '进入原生会话'))
  } else if (state.phase === 'failed') {
    transcript = el('div', { style: { display: 'grid', gap: 10, justifyItems: 'start' } },
      el('p', { role: 'alert', style: { ...hintStyle, color: danger } }, `无法打开对话：${state.error}`),
      el('button', { type: 'button', style: primaryButtonStyle, onClick: () => setAttempt(value => value + 1) }, '重试'))
  } else if (messages.length === 0 && streaming === '') {
    transcript = placeholder('和文鳐说点什么吧。', QUIET_PHRASE)
  } else {
    transcript = [
      window.hasMore === true ? el('button', { key: 'older', type: 'button', style: smallButtonStyle,
        onClick: () => { void state.binding.session.loadOlder() } }, '载入更早的消息') : null,
      ...messages.map(message => jsx(ChatMessageRow, { message }, message.key)),
      streaming === '' ? null : el('div', { key: 'streaming', 'data-chat-message-kind': 'streaming', style: assistantBubbleStyle, 'aria-live': 'polite' },
        el('span', { style: { display: 'block', fontSize: 11, color: caption, marginBottom: 3 } }, '文鳐正在回复…'),
        streaming),
    ]
  }

  return el('section', { 'aria-label': '文鳐对话', 'data-owner-console-chat': '', style: chatRootStyle },
    el('div', { style: backdropStyle },
      el('img', { src: WENYAO_BACKDROP_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false,
        'data-owner-console-art': 'backdrop', width: 960, height: 960, style: backdropImageStyle })),
    el('div', { style: chatColumnStyle },
      el('header', { 'data-owner-console-chat-header': '', style: headerStyle },
        jsx(ChatMark, {}),
        el('div', { style: { display: 'grid', gap: 2, minWidth: 0, flex: '1 1 220px' } },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            el('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '0.02em' } }, '文鳐 Ray'),
            sessionPill(snapshot, ready)),
          el('p', { style: { margin: 0, fontSize: 12, color: muted, fontFamily: "'STKaiti', 'KaiTi', 'Songti SC', 'STSong', serif", letterSpacing: '0.04em' } },
            '你的个人助手小鳐 · 小鳐小鳐，游而化飞')),
        el('div', { style: { ...actionsStyle, marginLeft: 'auto' } },
          el('button', { type: 'button', style: smallButtonStyle, onClick: openNative, 'aria-label': '在原生会话中打开' }, '原生会话'),
          el('button', { type: 'button', style: gearButtonStyle, onClick: onOpenSettings, 'aria-label': '打开设置',
            title: '配置、飞书 / TraeX 与插件管理' }, el('span', { 'aria-hidden': true }, '⚙')))),
      showPermissionBar
        ? jsx(PermissionBar, { session: binding?.session, permission, catalog, switching, pending: pendingPermission,
          notice: permissionNotice, request: requestPermission, confirm: applyPermission, cancel: () => setPendingPermission(undefined) })
        : null,
      notice === undefined ? null : el('p', { role: notice.tone === 'error' ? 'alert' : 'status', style: noticeStyle(notice.tone) },
        notice.text),
      ...(nativeSurface === undefined
        ? [
            el('div', { ref: log, 'data-owner-console-chat-log': '', role: 'log', 'aria-label': '对话消息',
              'aria-live': 'polite', style: logStyle, onScroll: scroll }, transcript),
            jsx(Composer, { disabled, sending, draft, files, running: snapshot.running === true, cancelling,
              voiceAvailable, listening, speakAvailable, speakReady: lastAssistant !== undefined,
              onDraft: setDraft, onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); submit() },
              onKeyDown: keyDown, onFiles: addFiles,
              onRemoveFile: (index: number) => setFiles(files.filter((_file, at) => at !== index)),
              onVoice: toggleVoice, onSpeak: speak, onStop: stop }),
          ]
        : [
            jsx(NativeToolbar, { voiceAvailable, listening, speakAvailable, speakReady: lastAssistant !== undefined,
              onVoice: toggleVoice, onSpeak: speak }),
            el('div', { 'data-owner-console-native-conversation': '',
              style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
            jsx(nativeSurface.provider as never, {
              session: nativeSurface.reference,
              children: nativeSurface.renderSlot('owner-console.conversation',
                { sessionId: nativeSurface.reference.binding.sessionId },
                { fallback: placeholder('正在载入原生对话…') }),
            } as never)),
          ])))
}
