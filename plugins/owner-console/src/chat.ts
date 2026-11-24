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

import type { OwnerSelfIterationAction } from './nl-control.js'
import type {
  AssistantChatContext, OwnerConsoleControlActionResult, OwnerConsoleModelCatalog, OwnerConsoleWriteResult,
} from './typert.js'

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

/** One attachment preview carried by a native local submission echo. */
export type ChatPendingAttachment =
  | Readonly<{ type: 'image'; value: Readonly<{ previewUrl: string; name?: string }> }>
  | Readonly<{ type: 'file'; value: Readonly<{ attachmentId: string; name: string; bytes: number }> }>

/** Native `SessionSnapshot.pendingSubmissions` entry while a prompt awaits durable admission. */
export type ChatPendingSubmission = Readonly<{
  requestId: string
  placement?: 'transcript' | 'queued' | 'steering'
  time?: number
  text: string
  attachments?: readonly ChatPendingAttachment[]
}>

/** Handle returned by native `SessionFace.beginSubmission`. */
export type ChatSubmissionHandle = Readonly<{
  requestId: string
  abandon(): void
}>

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
  pendingSubmissions?: readonly ChatPendingSubmission[]
}>

/** Native `SessionFace` surface used by the panel. */
export type ChatSessionFace = Observable<ChatSessionSnapshot> & Readonly<{
  beginSubmission?(input: Readonly<{
    mode: 'queue' | 'steer'
    text: string
    attachments: readonly ChatPendingAttachment[]
  }>): ChatSubmissionHandle
  prompt(
    content: readonly ChatPromptPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<RemoteResult<Readonly<{ accepted?: boolean }>>>
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

export type ChatMessagePayload = Readonly<{
  id?: string
  role?: string
  content?: readonly ChatContentBlock[]
  /** Tool results carry their paired call id here (`source.callId`); user RPC prompts carry `rpcId`. */
  source?: Readonly<{ kind?: string; callId?: string; rpcId?: string }>
  /** Provider-issued tool-call id on a `tool/result` message, mirroring `source.callId`. */
  toolCallId?: string
  isError?: boolean
}>

export type ChatSurfaceOp = 'append' | Readonly<{ op: string; startSeq?: number; endSeq?: number }>

export type DurableChatEvent = Readonly<{
  type: string
  seq: number
  time?: number
  /** Canonical DSH surface operation (`'append'` for transcript-origin events; replacements are model-only). */
  surfaceOp?: ChatSurfaceOp
  data?: Readonly<{
    turn?: number
    step?: number
    /** Direct `UserMessage` fields on `user/message` (`SessionEvent<'user/message'>.data` IS `UserMessage`). */
    id?: string
    role?: string
    content?: readonly ChatContentBlock[]
    source?: Readonly<{ kind?: string; callId?: string; rpcId?: string }>
    /** Wrapped message payload on `assistant/message` and `tool/result` (`data.message`). */
    message?: ChatMessagePayload
    /** `agent/inbox/spliced` fields tracking pending/claimed human prompts until `user/message` lands. */
    target?: 'next-turn' | 'next-step'
    start?: number
    removedCount?: number
    inserted?: readonly ChatMessagePayload[]
    outcome?: string
    callId?: string
    name?: string
    /** Raw JSON argument string on `tool/call`. */
    arguments?: string
    /** Request model metadata on `request/header` (`data.header.config`) or `request/context`. */
    header?: Readonly<{ config?: Readonly<{ provider?: string; model?: string; reasoningEffort?: string }> }>
    provider?: string
    model?: string
    reason?: Readonly<{ kind?: string; error?: Readonly<{ code?: string; message?: string }> }>
  }>
}>

export type TransientChatEvent = Readonly<{
  seq?: number
  data?: Readonly<{
    attemptId?: string
    turn?: number
    step?: number
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
  | Readonly<{ kind: 'error'; key: string; seq: number; text: string; code?: string; provider?: string; model?: string }>

/** Pending/queued human prompt not yet committed as a durable `user/message` event. */
export type PendingChatUserMessage = Readonly<{
  key: string
  text: string
  queued: boolean
}>

/** Split pending user prompts by turn placement so idle sends stay above thinking/streaming and follow-ups stay below. */
export type PendingChatUserMessages = Readonly<{
  transcript: readonly PendingChatUserMessage[]
  queued: readonly PendingChatUserMessage[]
}>

/** One retained Session generation and the release path that ends this panel's use. */
export type ChatReference = Readonly<{
  /** Exact Session generation this reference retains; required by the native Session Provider. */
  sessionId: string
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
  retain(id: string, options: Readonly<{ source: string; signal?: AbortSignal | undefined }>): ChatReference
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
   * Create the dedicated chat Session. The Host adapter resolves the assistant workspace and
   * registers the session id on Host before use so systemPrompt stays scoped to 文鳐 only.
   */
  createSession?(): Promise<string>
  assistantChatContext?(): Promise<RemoteResult<AssistantChatContext>>
  registerAssistantSession?(sessionId: string, makeActive: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  modelCatalog?(force: boolean): Promise<RemoteResult<OwnerConsoleModelCatalog>>
  selectSessionModel?(sessionId: string, provider: string, model: string, reasoningEffort: string): Promise<RemoteResult<unknown>>
  subscribeRefresh?(listener: () => void): () => void
  controlSelfIteration?(action: OwnerSelfIterationAction, confirmed: boolean): Promise<RemoteResult<OwnerConsoleControlActionResult>>
}>

/** localStorage key for the panel's dedicated chat Session (browser-local only). */
export const CHAT_SESSION_KEY = 'dsh.owner-console.assistant-chat-session.v2'

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
    else if (block.type === 'file') {
      const name = typeof block.attachment?.name === 'string' ? block.attachment.name.trim() : ''
      parts.push(name === '' ? '[文件]' : `[文件：${name}]`)
    }
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

/** Append-origin surface events belong to the human transcript; replacement copies stay model-only. */
const isAppendOrigin = (event: DurableChatEvent): boolean =>
  event.surfaceOp === undefined || event.surfaceOp === 'append'

const nonEmptyId = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/**
 * Project the durable event window into chat rows. Only append-origin human prompts
 * (`event.data` is `UserMessage` directly on `user/message` in DSH) become user bubbles;
 * injected `agent.inject()` / `runtime-context` messages and surface replacement copies
 * stay out of this compact transcript. Assistant text, tool activity, and turn errors remain.
 */
export function isAuthChatError(message: Extract<ChatMessage, { kind: 'error' }>): boolean {
  if (message.code !== undefined && /^(?:auth|unauthorized|unauthenticated|invalid[_-]?api[_-]?key)$/iu.test(message.code.trim())) {
    return true
  }
  return /\b401\b|authentication[_ ]failed|authentication_error|invalid[_ ]token|invalid[_ ]api[_ ]key|unauthorized/iu.test(message.text)
}

export function chatMessages(entries: readonly ChatEntry[] | undefined): readonly ChatMessage[] {
  if (entries === undefined) return []
  const messages: ChatMessage[] = []
  const tools = new Map<string, number>()
  let lastRequestRoute: { provider?: string; model?: string } | undefined
  let lastSelectedRoute: { provider?: string; model?: string } | undefined
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const { event } = entry
    const seq = Number.isFinite(event.seq) ? event.seq : messages.length
    switch (event.type) {
      case 'model/selection': {
        const provider = nonEmptyId(event.data?.provider?.trim())
        const model = nonEmptyId(event.data?.model?.trim())
        if (provider !== undefined || model !== undefined) {
          lastSelectedRoute = {
            ...(provider === undefined ? {} : { provider }),
            ...(model === undefined ? {} : { model }),
          }
        }
        break
      }
      case 'turn/start': {
        lastRequestRoute = undefined
        break
      }
      case 'request/header': {
        const provider = nonEmptyId(event.data?.header?.config?.provider?.trim())
        const model = nonEmptyId(event.data?.header?.config?.model?.trim())
        if (provider !== undefined || model !== undefined) {
          lastRequestRoute = {
            ...(provider === undefined ? {} : { provider }),
            ...(model === undefined ? {} : { model }),
          }
        }
        break
      }
      case 'request/context': {
        const provider = nonEmptyId(event.data?.provider?.trim()) ?? lastRequestRoute?.provider
        const model = nonEmptyId(event.data?.model?.trim()) ?? lastRequestRoute?.model
        if (provider !== undefined || model !== undefined) {
          lastRequestRoute = {
            ...(provider === undefined ? {} : { provider }),
            ...(model === undefined ? {} : { model }),
          }
        }
        break
      }
      case 'user/message': {
        if (!isAppendOrigin(event)) break
        const message = event.data
        if (message?.source?.kind !== 'user') break
        const text = messageText(message)
        if (text !== '') messages.push({ kind: 'user', key: `user:${seq}`, seq, text })
        break
      }
      case 'assistant/message': {
        if (!isAppendOrigin(event)) break
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
        if (!isAppendOrigin(event)) break
        // The result event's own data has no call id or name: the identity lives on the
        // model-facing message (`source.callId`, and `toolCallId` for the same value).
        const message = event.data?.message
        const callId = message?.source?.callId ?? message?.toolCallId
        const status = message?.isError === true ? 'error' : 'ok'
        const index = callId === undefined ? undefined : tools.get(callId)
        const previous = index === undefined ? undefined : messages[index]
        if (previous?.kind === 'tool' && index !== undefined) {
          // Pair with its `tool/call` row: keep that row's name and settle its status.
          messages[index] = { ...previous, status }
          break
        }
        // No paired call in the window (e.g. it aged out); keep the result visible without inventing a name.
        messages.push({ kind: 'tool', key: `tool:${seq}`, seq, name: 'tool', status })
        break
      }
      case 'turn/end': {
        if (event.data?.reason?.kind !== 'error') break
        const error = event.data.reason.error
        const text = boundedText(failureText(error))
        const code = nonEmptyId(error?.code?.trim())
        const route = lastRequestRoute ?? lastSelectedRoute
        messages.push({
          kind: 'error',
          key: `error:${seq}`,
          seq,
          text,
          ...(code === undefined ? {} : { code }),
          ...(route?.provider === undefined ? {} : { provider: route.provider }),
          ...(route?.model === undefined ? {} : { model: route.model }),
        })
        break
      }
      default:
        break
    }
  }
  return messages.length <= CHAT_MESSAGE_LIMIT ? messages : messages.slice(-CHAT_MESSAGE_LIMIT)
}

function pendingSubmissionText(submission: ChatPendingSubmission): string {
  const parts: string[] = []
  if (submission.text.trim() !== '') parts.push(submission.text)
  for (const attachment of submission.attachments ?? []) {
    if (attachment.type === 'image') parts.push('[图片]')
    else if (attachment.type === 'file') {
      const name = attachment.value.name.trim()
      parts.push(name === '' ? '[文件]' : `[文件：${name}]`)
    }
  }
  return parts.join('\n').trim()
}

type InboxTarget = 'next-turn' | 'next-step'

type TrackedInboxEntry = {
  readonly key: string
  readonly target: InboxTarget
  index: number
  readonly message: ChatMessagePayload
}

type ClaimedInboxEntry = {
  readonly key: string
  readonly claimedAtSeq: number
  readonly message: ChatMessagePayload
}

/**
 * Events proving a step/turn moved past `user/message` admission (or closed/forked),
 * expiring any earlier claimed inbox item that was rewritten or dropped before admission.
 * Note: `assistant/message` only counts when append-origin (compaction replacement copies
 * can run inside `pre-step` before the claimed prompt's `user/message` is appended).
 */
const CLAIM_EXPIRY_EVENT_TYPES = new Set([
  'request/header',
  'request/context',
  'assistant/message',
  'assistant/attempt',
  'step/end',
  'turn/end',
  'session/end-seed',
])

/**
 * Reconcile accepted local submission echoes (`snapshot.pendingSubmissions`), claimed-but-not-yet-admitted
 * durable `agent/inbox/spliced` prompts, and the Host's durable `inbox` projection against already-admitted
 * durable `user/message` events. Guarantees immediate display upon send, zero disappearance during `preStep` /
 * `prepareRequest` (including queued follow-ups after `ClientSession` retires their local echo, remounts, or
 * reloads), and seamless zero-duplicate handoff once durable `user/message` arrives on `eventSource`.
 */
export function pendingUserMessages(
  entries: readonly ChatEntry[] | undefined,
  pendingSubmissions: readonly ChatPendingSubmission[] | undefined,
  inboxSnapshot: unknown,
  running = false,
): PendingChatUserMessages {
  const admittedRpcIds = new Set<string>()
  const admittedMessageIds = new Set<string>()
  const trackedInbox = new Map<string, TrackedInboxEntry>()
  const claimedInFlight = new Map<string, ClaimedInboxEntry>()
  const canceledByTarget: Record<InboxTarget, { ids: Set<string>; rpcIds: Set<string> }> = {
    'next-step': { ids: new Set(), rpcIds: new Set() },
    'next-turn': { ids: new Set(), rpcIds: new Set() },
  }
  let syntheticSeq = 0

  for (const entry of entries ?? []) {
    if (entry.type !== 'event') continue
    const { event } = entry
    const seq = Number.isFinite(event.seq) ? event.seq : syntheticSeq++

    if (event.type === 'user/message' && isAppendOrigin(event) && event.data?.source?.kind === 'user') {
      const rpcId = nonEmptyId(event.data.source.rpcId)
      const id = nonEmptyId(event.data.id)
      if (rpcId !== undefined) admittedRpcIds.add(rpcId)
      if (id !== undefined) admittedMessageIds.add(id)
      for (const [key, claimed] of claimedInFlight) {
        const claimedId = nonEmptyId(claimed.message.id)
        const claimedRpcId = nonEmptyId(claimed.message.source?.rpcId)
        if ((id !== undefined && claimedId === id) || (rpcId !== undefined && claimedRpcId === rpcId)) {
          claimedInFlight.delete(key)
        }
      }
      continue
    }

    if (event.type === 'agent/inbox/spliced') {
      const data = event.data
      const target = data?.target
      if (target !== 'next-turn' && target !== 'next-step') continue
      const start = data?.start
      const removedCount = data?.removedCount ?? 0
      const inserted = Array.isArray(data?.inserted) ? data.inserted : []
      if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) continue
      if (typeof removedCount !== 'number' || !Number.isInteger(removedCount) || removedCount < 0) continue
      const canceled = data?.outcome === 'canceled'
      const removedEntries: TrackedInboxEntry[] = []

      for (const [key, tracked] of trackedInbox) {
        if (tracked.target !== target) continue
        if (tracked.index >= start && tracked.index < start + removedCount) {
          trackedInbox.delete(key)
          removedEntries.push(tracked)
        } else if (tracked.index >= start + removedCount) {
          tracked.index += inserted.length - removedCount
        }
      }
      removedEntries.sort((left, right) => left.index - right.index)
      for (const removed of removedEntries) {
        const id = nonEmptyId(removed.message.id)
        const rpcId = nonEmptyId(removed.message.source?.rpcId)
        if (canceled) {
          if (id !== undefined) canceledByTarget[target].ids.add(id)
          if (rpcId !== undefined) canceledByTarget[target].rpcIds.add(rpcId)
          claimedInFlight.delete(removed.key)
        } else {
          claimedInFlight.set(removed.key, { key: removed.key, claimedAtSeq: seq, message: removed.message })
        }
      }

      for (const [offset, raw] of inserted.entries()) {
        if (raw === null || typeof raw !== 'object') continue
        const message = raw as ChatMessagePayload
        if (message.source?.kind !== 'user') continue
        const id = nonEmptyId(message.id)
        const rpcId = nonEmptyId(message.source.rpcId)
        if (id !== undefined) canceledByTarget[target].ids.delete(id)
        if (rpcId !== undefined) canceledByTarget[target].rpcIds.delete(rpcId)
        const key = id ?? rpcId ?? `splice:${seq}:${offset}`
        claimedInFlight.delete(key)
        trackedInbox.set(key, { key, target, index: start + offset, message })
      }
      continue
    }

    if (CLAIM_EXPIRY_EVENT_TYPES.has(event.type) && (event.type !== 'assistant/message' || isAppendOrigin(event))) {
      for (const [key, claimed] of claimedInFlight) {
        if (claimed.claimedAtSeq < seq) claimedInFlight.delete(key)
      }
    }
  }

  const transcript: PendingChatUserMessage[] = []
  const queued: PendingChatUserMessage[] = []
  const transcriptMessageIds = new Set<string>()
  const transcriptRpcIds = new Set<string>()
  const queuedRpcIds = new Set<string>()
  const seenMessageIds = new Set<string>()

  // 1a. Durable prompts already claimed from the Host inbox by the active turn/step,
  //     awaiting `user/message` admission after `preStep` / `prepareRequest`.
  for (const claimed of claimedInFlight.values()) {
    const id = nonEmptyId(claimed.message.id)
    const rpcId = nonEmptyId(claimed.message.source?.rpcId)
    if (id !== undefined && (admittedMessageIds.has(id) || transcriptMessageIds.has(id))) continue
    if (rpcId !== undefined && (admittedRpcIds.has(rpcId) || transcriptRpcIds.has(rpcId))) continue
    const text = messageText(claimed.message)
    if (text === '') continue
    if (id !== undefined) transcriptMessageIds.add(id)
    if (rpcId !== undefined) transcriptRpcIds.add(rpcId)
    transcript.push({ key: `claimed:${id ?? rpcId ?? claimed.key}`, text, queued: false })
  }

  // 1b. Transcript-placed local echoes started an idle turn; keep them above thinking/streaming
  //     even if the Host's inbox projection momentarily still holds the same rpcId.
  for (const submission of pendingSubmissions ?? []) {
    if (submission.placement !== undefined && submission.placement !== 'transcript') continue
    const requestId = nonEmptyId(submission.requestId)
    if (requestId === undefined
      || admittedRpcIds.has(requestId)
      || transcriptRpcIds.has(requestId)
      || canceledByTarget['next-turn'].rpcIds.has(requestId)) {
      continue
    }
    const text = pendingSubmissionText(submission)
    if (text === '') continue
    transcriptRpcIds.add(requestId)
    transcript.push({ key: `pending:${requestId}`, text, queued: false })
  }

  // 2. Host-owned durable inbox projection (`next-step` steering before `next-turn` queued).
  if (inboxSnapshot !== null && typeof inboxSnapshot === 'object') {
    const record = inboxSnapshot as Record<string, unknown>
    for (const bucket of ['next-step', 'next-turn'] as const) {
      const items = record[bucket]
      if (!Array.isArray(items)) continue
      const canceledBucket = canceledByTarget[bucket]
      for (const [index, raw] of items.entries()) {
        if (raw === null || typeof raw !== 'object') continue
        const message = raw as ChatMessagePayload
        if (message.source?.kind !== 'user') continue
        const id = nonEmptyId(message.id)
        const rpcId = nonEmptyId(message.source.rpcId)
        if (id !== undefined && (admittedMessageIds.has(id) || transcriptMessageIds.has(id) || seenMessageIds.has(id) || canceledBucket.ids.has(id))) {
          continue
        }
        if (rpcId !== undefined && (admittedRpcIds.has(rpcId) || transcriptRpcIds.has(rpcId) || queuedRpcIds.has(rpcId) || canceledBucket.rpcIds.has(rpcId))) {
          continue
        }
        const text = messageText(message)
        if (text === '') continue
        if (id !== undefined) seenMessageIds.add(id)
        if (rpcId !== undefined) queuedRpcIds.add(rpcId)
        const key = id !== undefined ? `inbox:${id}` : rpcId !== undefined ? `inbox:${rpcId}` : `inbox:${bucket}:${index}`
        if (running) queued.push({ key, text, queued: true })
        else transcript.push({ key, text, queued: false })
      }
    }
  }

  // 3. Queued/steering local echoes that have not yet appeared in the Host inbox projection.
  for (const submission of pendingSubmissions ?? []) {
    if (submission.placement === undefined || submission.placement === 'transcript') continue
    const requestId = nonEmptyId(submission.requestId)
    if (requestId === undefined || admittedRpcIds.has(requestId) || transcriptRpcIds.has(requestId) || queuedRpcIds.has(requestId)) {
      continue
    }
    const target: InboxTarget = submission.placement === 'steering' ? 'next-step' : 'next-turn'
    if (canceledByTarget[target].rpcIds.has(requestId)) continue
    const text = pendingSubmissionText(submission)
    if (text === '') continue
    queuedRpcIds.add(requestId)
    if (running) queued.push({ key: `pending:${requestId}`, text, queued: true })
    else transcript.push({ key: `pending:${requestId}`, text, queued: false })
  }

  return { transcript, queued }
}

/** Text streamed by the open Assistant attempt, before its durable message settles. */
export function streamingAssistantText(entries: readonly ChatEntry[] | undefined): string {
  if (entries === undefined) return ''
  // ClientAssistantStream retains a successful attempt's transient rows until `step/end` (after tool calls);
  // suppress those chunks once the durable append-origin `assistant/message` for that `(turn, step)` is present.
  const settledSteps = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const { event } = entry
    if (event.type !== 'assistant/message' || !isAppendOrigin(event)) continue
    if (typeof event.data?.turn === 'number' && typeof event.data?.step === 'number') {
      settledSteps.add(`${event.data.turn}:${event.data.step}`)
    }
  }
  const attempts = new Map<string, string>()
  let last: string | undefined
  for (const entry of entries) {
    if (entry.type !== 'transient') continue
    const data = entry.event.data
    const attempt = data?.attemptId
    if (attempt === undefined) continue
    if (typeof data?.turn === 'number' && typeof data?.step === 'number'
      && settledSteps.has(`${data.turn}:${data.step}`)) {
      continue
    }
    if (!attempts.has(attempt)) attempts.set(attempt, '')
    const chunk = data?.chunk
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

/** A retained Session whose history failed to open must be replaced, not shown as ready. */
function chatOpenFailed(reference: ChatReference): boolean {
  try {
    const snapshot = reference.binding.session.getSnapshot()
    return snapshot.openState === 'error' || snapshot.removed === true
  } catch {
    return true
  }
}

/** Abort reason for a cancelled acquisition; falls back when the caller gave the signal no reason. */
function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('会话打开已取消。')
}

/** Read `aborted` through a call so control-flow narrowing is not retained across the awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export interface OpenDedicatedChatOptions {
  readonly forceNew?: boolean
  readonly preferredSessionId?: string | null
  readonly onSessionReady?: (sessionId: string) => Promise<void> | void
}

/**
 * Open the dedicated chat Session: reuse the stored/preferred one when it is still openable (unless
 * `forceNew` is set), otherwise create one through the native Session controller and remember it.
 * `ready` resolves even when the Host failed to open the retained history (`openState: 'error'`), so
 * the snapshot decides. `signal` cancels the acquisition itself (the Host also stops waiting through
 * `retain`), so an unmounted chat surface cannot keep a hung open retained. The caller owns the
 * returned reference and must release it when the chat surface unmounts.
 */
export async function openDedicatedChatSession(
  sessions: ChatSessions,
  storage: ChatStorage | undefined,
  source: string = CHAT_REFERENCE_SOURCE,
  create: (() => Promise<string>) | undefined = undefined,
  signal?: AbortSignal,
  extra: OpenDedicatedChatOptions = {},
): Promise<ChatReference> {
  const candidates = extra.forceNew
    ? []
    : [...new Set([storedChatSession(storage), extra.preferredSessionId?.trim()]
      .filter((id): id is string => typeof id === 'string' && id !== ''))]

  for (const candidateId of candidates) {
    let reference: ChatReference | undefined
    try {
      reference = sessions.retain(candidateId, { source, signal })
      await reference.ready
      if (!chatOpenFailed(reference)) {
        if (isAborted(signal)) throw abortReason(signal)
        rememberChatSession(storage, candidateId)
        try { await extra.onSessionReady?.(candidateId) } catch { /* non-fatal */ }
        return reference
      }
    } catch {
      // A stale generation or a failed open both fall through to the next candidate or a fresh Session.
    }
    if (isAborted(signal)) {
      // Cancellation is not a stale generation: keep the stored id for the next attempt.
      reference?.release()
      throw abortReason(signal)
    }
    reference?.release()
    if (candidateId === storedChatSession(storage)) forgetChatSession(storage)
  }

  const sessionId = create === undefined ? await sessions.create() : await create()
  if (isAborted(signal)) throw abortReason(signal)
  const reference = sessions.retain(sessionId, { source, signal })
  try {
    await reference.ready
  } catch (error) {
    reference.release()
    forgetChatSession(storage)
    throw isAborted(signal) ? abortReason(signal) : error
  }
  if (isAborted(signal)) {
    reference.release()
    forgetChatSession(storage)
    throw abortReason(signal)
  }
  if (chatOpenFailed(reference)) {
    reference.release()
    forgetChatSession(storage)
    throw new Error('新建的会话无法打开，请重试。')
  }
  rememberChatSession(storage, sessionId)
  try { await extra.onSessionReady?.(sessionId) } catch { /* non-fatal */ }
  return reference
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
  session: Pick<ChatSessionFace, 'prompt' | 'beginSubmission'>
  uploads?: ChatUploads | undefined
  text: string
  files?: readonly Blob[] | undefined
  signal?: AbortSignal | undefined
}>): Promise<ChatSendOutcome> {
  if (input.text.trim() === '' && (input.files === undefined || input.files.length === 0)) {
    return { ok: false, error: '消息不能为空。' }
  }
  let submission: ChatSubmissionHandle | undefined
  try {
    const fileParts: ChatPromptPart[] = []
    const pendingAttachments: ChatPendingAttachment[] = []
    for (const file of input.files ?? []) {
      if (input.uploads === undefined) {
        return { ok: false, error: '当前界面未提供附件上传服务（fileUpload 未加载），无法上传附件。' }
      }
      fileParts.push(await stagedPart(input.uploads, input.sessionId, file))
      const name = nameOf(file)
      const mediaType = mediaTypeOf(file)
      if (mediaType !== undefined && PROMPT_IMAGE_TYPES.has(mediaType) && input.uploads.uploadImage !== undefined) {
        pendingAttachments.push({ type: 'image', value: { previewUrl: '', ...(name === undefined ? {} : { name }) } })
      } else {
        pendingAttachments.push({
          type: 'file',
          value: { attachmentId: '', name: name ?? '', bytes: typeof file.size === 'number' ? file.size : 0 },
        })
      }
    }
    const content: ChatPromptPart[] = input.text.trim() === ''
      ? fileParts
      : [{ type: 'text', text: input.text }, ...fileParts]
    submission = input.session.beginSubmission?.({
      mode: 'queue',
      text: input.text.trim() === '' ? '' : input.text,
      attachments: pendingAttachments,
    })
    const result = submission === undefined
      ? await input.session.prompt(content, 'queue', input.signal)
      : await input.session.prompt(content, 'queue', input.signal, submission.requestId)
    if (!result.ok) {
      submission?.abandon()
      return { ok: false, error: `消息未发送（${failureText(result.error)}）` }
    }
    return { ok: true }
  } catch (error) {
    submission?.abandon()
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

/** Current value of the Session `modelSelection` projection (`next`/`pending` override `lastUsed`). */
export function modelSelectionFromProjection(snapshot: unknown): Readonly<{ provider: string; model: string; reasoningEffort?: string }> | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const record = snapshot as { next?: unknown; pending?: unknown; lastUsed?: unknown }
  const pick = (candidate: unknown) => {
    if (candidate === null || typeof candidate !== 'object') return undefined
    const sel = candidate as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof sel.provider !== 'string' || sel.provider.trim() === '' || typeof sel.model !== 'string' || sel.model.trim() === '') {
      return undefined
    }
    const effort = typeof sel.reasoningEffort === 'string' && sel.reasoningEffort.trim() !== '' ? sel.reasoningEffort.trim() : undefined
    return {
      provider: sel.provider.trim(),
      model: sel.model.trim(),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
  }
  return pick(record.next) ?? pick(record.pending) ?? pick(record.lastUsed)
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
