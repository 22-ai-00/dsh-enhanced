/**
 * Chat-window domain helpers for the 文鳐 panel. Everything here operates on the
 * native Session services the Host exposes to a client plugin: the retained Session's
 * durable event window, its `prompt`/`command`/`cancel` verbs, the staged file-upload
 * service, and the Session `permissions` projection. No second agent loop and no
 * message-sending shortcut lives here.
 *
 * Types are structural on purpose: a client package may only import `react` at runtime,
 * so the Host service shapes are declared locally and resolved through `ctx.get()`.
 */

/** One Host snapshot/read face (`getSnapshot` + `subscribe`). */
export type Observable<T> = Readonly<{
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}>

/** Host Remote result: a value or a stable business failure. */
export type RemoteFailure = Readonly<{ code?: string; message?: string }>
export type RemoteResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error?: RemoteFailure }>

/** One prompt content part accepted by the native Session prompt endpoint. */
export type ChatPromptPart =
  | Readonly<{ type: 'text'; text: string }>
  /** A staged file/image receipt; the Host resolves it inside this Session's Agent scope. */
  | Readonly<{ type: 'file'; receiptId: string }>

/** Session lifecycle fields the chat header and composer read. */
export type ChatSessionSnapshot = Readonly<{
  running?: boolean
  openState?: string
  openError?: Readonly<{ code?: string; message?: string }> | null
  removed?: boolean
  blank?: boolean
  promptAttempted?: boolean
  awaitingFirstTurn?: boolean
  lastAgentError?: string | null
}>

/** Native `SessionFace` surface used by the panel. */
export type ChatSessionFace = Observable<ChatSessionSnapshot> & Readonly<{
  prompt(content: readonly ChatPromptPart[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<RemoteResult<Readonly<{ accepted?: boolean }>>>
  command(line: string): Promise<RemoteResult<Readonly<{ matched?: boolean }>>>
  cancel(): Promise<RemoteResult<Readonly<{ accepted?: boolean }>>>
  loadOlder(): Promise<void>
  readonly projections: Readonly<{ faceOf(key: string): Observable<unknown> }>
}>

/** One durable/session-transient entry from the Session event source. */
export type ChatEntry =
  | Readonly<{ type: 'event'; event: DurableChatEvent }>
  | Readonly<{ type: 'transient'; event: TransientChatEvent }>

export type ChatContentBlock = Readonly<{
  type?: string
  text?: string
  attachment?: Readonly<{ name?: string }>
}>

export type DurableChatEvent = Readonly<{
  type: string
  seq: number
  time?: number
  data?: Readonly<{
    message?: Readonly<{
      content?: readonly ChatContentBlock[]
      source?: Readonly<{ kind?: string }>
      isError?: boolean
    }>
    callId?: string
    name?: string
    reason?: Readonly<{ kind?: string; error?: Readonly<{ code?: string; message?: string }> }>
  }>
}>

export type TransientChatEvent = Readonly<{
  seq?: number
  data?: Readonly<{
    attemptId?: string
    chunk?: Readonly<{ type?: string; text?: string }>
  }>
}>

export type ChatEventWindow = Readonly<{
  entries?: readonly ChatEntry[]
  hasMore?: boolean
}>

/** One rendered transcript row; tool rows stay compact and text-only. */
export type ChatMessage =
  | Readonly<{ kind: 'user'; key: string; seq: number; text: string }>
  | Readonly<{ kind: 'assistant'; key: string; seq: number; text: string }>
  | Readonly<{ kind: 'tool'; key: string; seq: number; name: string; status: 'running' | 'ok' | 'error' }>
  | Readonly<{ kind: 'error'; key: string; seq: number; text: string }>

/** One retained Session generation and the release path that ends this panel's use. */
export type ChatReference = Readonly<{
  /** Live binding for the retained generation (history opens through `ready`). */
  binding: ChatBinding
  ready: Promise<ChatBinding>
  release(): void
}>

export type ChatBinding = Readonly<{
  sessionId: string
  session: ChatSessionFace
  eventSource: Observable<ChatEventWindow>
  /** Agent-scoped context used by the native input facade; present on a real binding. */
  ctx?: unknown
}>

/** Native Session controller face used by the panel (create + retain). */
export type ChatSessions = Readonly<{
  create(options?: Readonly<{ workspaceId?: string; cwd?: string; agentPreset?: string }>): Promise<string>
  retain(id: string, options: Readonly<{ source: string; signal?: AbortSignal }>): ChatReference
  connectWorkspace?(workspaceId: string, options?: Readonly<{ agentPreset?: string }>): Promise<string>
}>

/** Host staged-upload service: prompt files and images are uploaded before they are cited. */
export type ChatUploads = Readonly<{
  upload(sessionId: string, data: Blob, name?: string, signal?: AbortSignal): Promise<RemoteResult<Readonly<{ receiptId: string }>>>
  uploadImage?(sessionId: string, data: Blob, mediaType: string, name?: string, signal?: AbortSignal):
  Promise<RemoteResult<Readonly<{ receiptId: string; image?: unknown }>>>
}>

/** Process permission catalog (the selectable presets), separate from the Session's current value. */
export type PermissionCatalog = Readonly<{
  options: readonly Readonly<{ value: string; name: string; description?: string }>[]
  defaultPreset?: string
}>

/** Browser persistence used to keep one dedicated chat Session between page loads. */
export type ChatStorage = Readonly<{
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}>

/* Browser speech APIs. SpeechRecognition is not in TypeScript's DOM lib, and both are
 * optional browser features even where the DOM itself exists. */

export type SpeechRecognitionAlternativeLike = Readonly<{ transcript: string }>
export type SpeechRecognitionResultLike = Readonly<{
  isFinal: boolean
  length: number
  readonly [index: number]: SpeechRecognitionAlternativeLike
}>
export type SpeechRecognitionResultsLike = Readonly<{
  length: number
  readonly [index: number]: SpeechRecognitionResultLike
}>
export type SpeechRecognitionEventLike = Readonly<{ resultIndex: number; results: SpeechRecognitionResultsLike }>
export type SpeechRecognitionErrorLike = Readonly<{ error?: string }>
export type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null
  onend: (() => void) | null
}
export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

/** Everything the chat surface needs from the embedding; each capability is resolved lazily. */
export type ChatRuntime = Readonly<{
  sessions(): ChatSessions | undefined
  fileUploads(): ChatUploads | undefined
  /** `undefined` means the Host exposes no permission-preset remote at all. */
  permissionCatalog(): Promise<RemoteResult<PermissionCatalog>> | undefined
  openNativeSession(sessionId: string): boolean
  startConversation(): void
  storage(): ChatStorage | undefined
  voiceAvailable(): boolean
  createRecognition(): SpeechRecognitionLike | undefined
  recognitionLang(): string
  speakAvailable(): boolean
  speak(text: string): boolean
  /**
   * Write a browser transcript into the native composer draft through
   * `conversation.input.for(actx).setDraft` plus focus. False means this embedding has no native
   * input facade; the caller must show that limitation instead of pretending the draft changed.
   */
  insertDraft?(reference: ChatReference, text: string): boolean
  /**
   * Create the dedicated chat Session. The Host adapter resolves the default Workspace first so
   * the Session is grouped and can be opened natively; absence falls back to `sessions.create()`
   * with the Host default cwd (an ungrouped Session).
   */
  createSession?(): Promise<string>
}>

/** localStorage key for the panel's dedicated chat Session (browser-local only). */
export const CHAT_SESSION_KEY = 'dsh.owner-console.chat-session'

/** Consumer label for the retained reference; a Session value survives page reloads. */
export const CHAT_REFERENCE_SOURCE = 'ownerConsoleChat'

/** Most recent transcript rows kept in memory for rendering. */
export const CHAT_MESSAGE_LIMIT = 200

const textOf = (block: ChatContentBlock): string | undefined => {
  if (block.type !== 'text' || typeof block.text !== 'string') return undefined
  return block.text
}

/** Human-readable transcript text; attachments stay named placeholders, never fabricated content. */
export function messageText(message: Readonly<{ content?: readonly ChatContentBlock[] }> | undefined): string {
  if (message?.content === undefined) return ''
  const parts: string[] = []
  for (const block of message.content) {
    const text = textOf(block)
    if (text !== undefined) {
      parts.push(text)
      continue
    }
    if (block.type === 'image') parts.push('[图片]')
    else if (block.type === 'file') parts.push(block.attachment?.name === undefined ? '[文件]' : `[文件：${block.attachment.name}]`)
  }
  return parts.join('\n').trim()
}

const failureText = (error: RemoteFailure | undefined): string => {
  if (error?.code !== undefined && error.message !== undefined) return `${error.code}：${error.message}`
  if (error?.message !== undefined) return error.message
  return 'Host 未说明的拒绝'
}

/** Display-ready Remote failure, shared by the chat and permission notices. */
export const remoteFailureSummary = failureText

/** Bound an error/notification line so a pathological Host message cannot force a huge DOM node. */
export function boundedText(text: string, limit = 600): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

/**
 * Project the durable event window into chat rows. Only human prompts become user
 * bubbles; injected `agent.inject()` context is not a human message and stays out of
 * this compact transcript. Assistant text, tool activity, and turn errors remain.
 */
export function chatMessages(entries: readonly ChatEntry[] | undefined): readonly ChatMessage[] {
  if (entries === undefined) return []
  const messages: ChatMessage[] = []
  const tools = new Map<string, number>()
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const { event } = entry
    const seq = Number.isFinite(event.seq) ? event.seq : messages.length
    switch (event.type) {
      case 'user/message': {
        if (event.data?.message?.source?.kind !== 'user') break
        const text = messageText(event.data.message)
        if (text !== '') messages.push({ kind: 'user', key: `user:${seq}`, seq, text })
        break
      }
      case 'assistant/message': {
        const text = messageText(event.data?.message)
        if (text !== '') messages.push({ kind: 'assistant', key: `assistant:${seq}`, seq, text })
        break
      }
      case 'tool/call': {
        const callId = event.data?.callId
        const name = event.data?.name === undefined || event.data.name === '' ? 'tool' : event.data.name
        const message: ChatMessage = { kind: 'tool', key: `tool:${seq}`, seq, name, status: 'running' }
        if (callId !== undefined) tools.set(callId, messages.length)
        messages.push(message)
        break
      }
      case 'tool/result': {
        const callId = event.data?.callId
        const index = callId === undefined ? undefined : tools.get(callId)
        if (index === undefined) {
          const name = event.data?.name === undefined || event.data.name === '' ? 'tool' : event.data.name
          messages.push({ kind: 'tool', key: `tool:${seq}`, seq, name, status: event.data?.message?.isError === true ? 'error' : 'ok' })
          break
        }
        const previous = messages[index]
        if (previous?.kind === 'tool') {
          messages[index] = { ...previous, status: event.data?.message?.isError === true ? 'error' : 'ok' }
        }
        break
      }
      case 'turn/end': {
        if (event.data?.reason?.kind !== 'error') break
        const error = event.data.reason.error
        const text = boundedText(failureText(error))
        messages.push({ kind: 'error', key: `error:${seq}`, seq, text })
        break
      }
      default:
        break
    }
  }
  return messages.length <= CHAT_MESSAGE_LIMIT ? messages : messages.slice(-CHAT_MESSAGE_LIMIT)
}

/** Text streamed by the open Assistant attempt, before its durable message settles. */
export function streamingAssistantText(entries: readonly ChatEntry[] | undefined): string {
  if (entries === undefined) return ''
  const attempts = new Map<string, string>()
  let last: string | undefined
  for (const entry of entries) {
    if (entry.type !== 'transient') continue
    const attempt = entry.event.data?.attemptId
    if (attempt === undefined) continue
    if (!attempts.has(attempt)) attempts.set(attempt, '')
    const chunk = entry.event.data?.chunk
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') continue
    attempts.set(attempt, (attempts.get(attempt) ?? '') + chunk.text)
    last = attempt
  }
  if (last === undefined) return ''
  return (attempts.get(last) ?? '').trim()
}

/** Read a stored chat Session id, rejecting empty/whitespace values from a stale store. */
export function storedChatSession(storage: ChatStorage | undefined): string | undefined {
  try {
    const value = storage?.getItem(CHAT_SESSION_KEY)?.trim()
    return value === undefined || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Persist the dedicated chat Session; a browser refusing storage is not fatal to the chat. */
export function rememberChatSession(storage: ChatStorage | undefined, sessionId: string): void {
  try {
    storage?.setItem(CHAT_SESSION_KEY, sessionId)
  } catch {
    // A private-mode/quota failure only loses the reuse convenience, not the Session.
  }
}

/** Remove a stale id after its Session generation could not be opened. */
export function forgetChatSession(storage: ChatStorage | undefined): void {
  try {
    storage?.removeItem(CHAT_SESSION_KEY)
  } catch {
    // Nothing else to release.
  }
}

/**
 * Open the dedicated chat Session: reuse the stored one when it is still openable, otherwise
 * create one through the native Session controller and remember it. The caller owns the
 * returned reference and must release it when the chat surface unmounts.
 */
export async function openDedicatedChatSession(
  sessions: ChatSessions,
  storage: ChatStorage | undefined,
  source: string = CHAT_REFERENCE_SOURCE,
  create: (() => Promise<string>) | undefined = undefined,
): Promise<ChatReference> {
  const stored = storedChatSession(storage)
  if (stored !== undefined) {
    try {
      const reference = sessions.retain(stored, { source })
      try {
        await reference.ready
        return reference
      } catch (error) {
        reference.release()
        throw error
      }
    } catch {
      forgetChatSession(storage)
    }
  }
  const sessionId = create === undefined ? await sessions.create() : await create()
  rememberChatSession(storage, sessionId)
  const reference = sessions.retain(sessionId, { source })
  try {
    await reference.ready
    return reference
  } catch (error) {
    reference.release()
    forgetChatSession(storage)
    throw error
  }
}

/** Supported prompt-image media types; other blobs travel as ordinary files. */
const PROMPT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const nameOf = (file: Blob): string | undefined => {
  const name = (file as Blob & { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : undefined
}

const mediaTypeOf = (file: Blob): string | undefined => {
  const mediaType = (file as Blob & { type?: unknown }).type
  return typeof mediaType === 'string' ? mediaType : undefined
}

/** Upload a file/image and turn it into the native prompt part that cites its staged receipt. */
async function stagedPart(uploads: ChatUploads, sessionId: string, file: Blob): Promise<ChatPromptPart> {
  const name = nameOf(file)
  const mediaType = mediaTypeOf(file)
  if (mediaType !== undefined && PROMPT_IMAGE_TYPES.has(mediaType) && uploads.uploadImage !== undefined) {
    const result = await uploads.uploadImage(sessionId, file, mediaType, name)
    if (!result.ok) throw new ChatSendError(`附件上传被 Host 拒绝（${failureText(result.error)}）`)
    return { type: 'file', receiptId: result.value.receiptId }
  }
  const result = await uploads.upload(sessionId, file, name)
  if (!result.ok) throw new ChatSendError(`附件上传被 Host 拒绝（${failureText(result.error)}）`)
  return { type: 'file', receiptId: result.value.receiptId }
}

/** Local send failure with user-facing text, kept distinct from Host Remote failures. */
export class ChatSendError extends Error {
  override readonly name = 'ChatSendError'

  /** @param message - already display-ready Chinese text. */
  constructor(message: string) {
    super(message)
  }
}

export type ChatSendOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>

/**
 * Upload ordered attachments, then submit one prompt through the native Session.
 * Nothing is reported as sent until the Host accepts the prompt; a failed upload
 * aborts the whole send and keeps the caller's draft/attachment state intact.
 */
export async function sendChatMessage(input: Readonly<{
  sessionId: string
  session: Pick<ChatSessionFace, 'prompt'>
  uploads?: ChatUploads | undefined
  text: string
  files?: readonly Blob[] | undefined
  signal?: AbortSignal | undefined
}>): Promise<ChatSendOutcome> {
  if (input.text.trim() === '' && (input.files === undefined || input.files.length === 0)) {
    return { ok: false, error: '消息不能为空。' }
  }
  try {
    const fileParts: ChatPromptPart[] = []
    for (const file of input.files ?? []) {
      if (input.uploads === undefined) {
        return { ok: false, error: '当前界面未提供附件上传服务（fileUpload 未加载），无法上传附件。' }
      }
      fileParts.push(await stagedPart(input.uploads, input.sessionId, file))
    }
    const content: ChatPromptPart[] = input.text.trim() === ''
      ? fileParts
      : [{ type: 'text', text: input.text }, ...fileParts]
    const result = await input.session.prompt(content, 'queue', input.signal)
    if (!result.ok) return { ok: false, error: `消息未发送（${failureText(result.error)}）` }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? boundedText(error.message) : '消息未发送，稍后重试。' }
  }
}

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全访问',
  'auto': '自动审查',
  'custom': '自定义',
}

/** Display label for one permission value, preferring the product label over a raw key. */
export function permissionLabel(value: string | undefined, catalog?: PermissionCatalog): string {
  if (value === undefined || value === '') return '权限不可用'
  const builtIn = PERMISSION_LABELS[value]
  if (builtIn !== undefined) return builtIn
  const option = catalog?.options.find(item => item.value === value)
  return option === undefined ? value : option.name
}

/** High-risk presets need an explicit in-panel confirmation before the native command runs. */
export function requiresPermissionConfirmation(value: string): boolean {
  return value === 'danger-full-access' || value === 'auto'
}

/** Current value of the Session `permissions` projection; absence means no permission service. */
export function permissionValue(snapshot: unknown): string | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const value = (snapshot as { currentValue?: unknown }).currentValue
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Options for the permission select, including a current value the catalog does not list. */
export function permissionOptions(catalog: PermissionCatalog, current: string | undefined):
readonly Readonly<{ value: string; name: string }>[] {
  const options = catalog.options.map(option => ({ value: option.value, name: option.name }))
  if (current !== undefined && current !== '' && !options.some(option => option.value === current)) {
    return [...options, { value: current, name: permissionLabel(current) }]
  }
  return options
}

/** Browser localStorage when the embedding actually provides a usable one. */
export function browserStorage(): ChatStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: unknown }).localStorage
    if (storage === null || typeof storage !== 'object') return undefined
    const candidate = storage as Partial<ChatStorage>
    if (typeof candidate.getItem !== 'function' || typeof candidate.setItem !== 'function'
      || typeof candidate.removeItem !== 'function') return undefined
    return storage as ChatStorage
  } catch {
    return undefined
  }
}

/** Browser SpeechRecognition constructor, including the WebKit-prefixed spelling. */
export function browserSpeechRecognition(): SpeechRecognitionConstructor | undefined {
  try {
    const scope = globalThis as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }
    for (const candidate of [scope.SpeechRecognition, scope.webkitSpeechRecognition]) {
      if (typeof candidate === 'function') return candidate as SpeechRecognitionConstructor
    }
  } catch {
    // A locked-down embedding may deny access to the global; treat it as unsupported.
  }
  return undefined
}

/** Document language used for recognition/synthesis; a safe Chinese default. */
export function browserLang(): string {
  try {
    const document = (globalThis as { document?: { documentElement?: { lang?: string } } }).document
    const lang = document?.documentElement?.lang
    return typeof lang === 'string' && lang !== '' ? lang : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

type SpeechSynthesisLike = Readonly<{ speak(utterance: unknown): void; cancel(): void }>
type UtteranceConstructor = new (text: string) => { text: string; lang: string }

/** Speak text with the browser's built-in synthesis; false means this browser cannot. */
export function speakInBrowser(text: string): boolean {
  try {
    const synthesis = (globalThis as { speechSynthesis?: SpeechSynthesisLike }).speechSynthesis
    const Utterance = (globalThis as { SpeechSynthesisUtterance?: UtteranceConstructor }).SpeechSynthesisUtterance
    if (synthesis === undefined || typeof Utterance !== 'function' || text.trim() === '') return false
    synthesis.cancel()
    const utterance = new Utterance(text)
    utterance.lang = browserLang()
    synthesis.speak(utterance)
    return true
  } catch {
    return false
  }
}

/** Whether browser speech synthesis is installed; keeps the read-aloud button honest. */
export function browserSpeechSynthesisAvailable(): boolean {
  try {
    const scope = globalThis as { speechSynthesis?: unknown; SpeechSynthesisUtterance?: unknown }
    return typeof scope.speechSynthesis === 'object' && scope.speechSynthesis !== null
      && typeof scope.SpeechSynthesisUtterance === 'function'
  } catch {
    return false
  }
}
