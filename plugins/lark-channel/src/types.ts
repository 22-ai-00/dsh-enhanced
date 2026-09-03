export interface LarkInboundConfig {
  account: string
  tenant: string
  requireMentionInGroups: boolean
  maxTextBytes: number
  staleAfterMs: number
}

export interface LarkResource {
  type: 'audio' | 'file' | 'image' | 'sticker' | 'video'
  fileKey: string
  fileName?: string
  durationMs?: number
  coverImageKey?: string
}

export interface LarkMessage {
  messageId: string
  chatId: string
  chatType: 'group' | 'p2p'
  senderId: string
  content: string
  rawContentType: string
  resources: readonly LarkResource[]
  mentionAll: boolean
  mentionedBot: boolean
  rootId?: string
  threadId?: string
  replyToMessageId?: string
  createTime: number
  raw?: unknown
}

export interface LarkApprovalCard {
  title: string
  body: string
  approveValue: { approval: string }
  rejectValue: { approval: string }
}

export interface LarkApprovalResultCard {
  decision: 'approved' | 'rejected'
  proposalId: string
}

export interface LarkApprovalApplicationCard {
  status: 'applied' | 'conflicted' | 'expired' | 'rejected'
  operation: 'adopt' | 'owner-undo' | 'retire'
  policyProposalId: string
  localProposalId: string
  terminalAt: number
  ruleId?: string
  resultingRuleVersion?: number
  ruleStatus?: 'active' | 'retired'
}

export interface LarkToolApprovalCard {
  title: string
  toolName: string
  reason?: string
  arguments: string
  allowValue: { toolApproval: string }
  rejectValue: { toolApproval: string }
}

/** One immediately actionable choice on a Lark user-question card. */
export interface LarkUserQuestionOption {
  /** Untrusted, user-visible option text. Rendered only as CardKit plain text. */
  label: string
  /** Optional untrusted supporting text. Rendered only as CardKit plain text. */
  description?: string
  /** Presentation-only recommendation; it never implies that the option is selected. */
  recommended?: boolean
  /** Current selection state, used by a multi-select card while it remains open. */
  selected?: boolean
  /** Signed, opaque callback value owned by the question bridge. */
  value: { userQuestion: string }
}

/** One answered item shown while a multi-question request advances. */
export interface LarkUserQuestionAnsweredItem {
  /** Untrusted question heading. Rendered only as CardKit plain text. */
  title: string
  /** Untrusted answer summary. Rendered only as CardKit plain text. */
  answer: string
}

/** One currently pending user question rendered as a CardKit 2.0 card. */
export interface LarkUserQuestionCard {
  /** Untrusted, user-visible title. Rendered only as CardKit plain text. */
  title: string
  /** Untrusted question text. Rendered only as CardKit plain text. */
  question: string
  /** Optional untrusted supporting detail. Rendered only as CardKit plain text. */
  detail?: string
  /** One-based position of this question within the pending request batch. */
  position: number
  /** Total questions in the pending request batch. */
  total: number
  /** Whether option clicks build a selection that must be submitted explicitly. */
  multiSelect: boolean
  /** Whether the user may answer with free text by replying to this card. */
  expectsText: boolean
  options: readonly LarkUserQuestionOption[]
  /** Optional signed callback that confirms the current multi-select state. */
  submitValue?: { userQuestion: string }
  /** Optional signed callback that cancels the pending question request. */
  cancelValue?: { userQuestion: string }
  /** Earlier answers in the same request batch, shown as a plain-text summary. */
  answered?: readonly LarkUserQuestionAnsweredItem[]
}

/** A terminal projection for a previously pending Lark user-question card. */
export interface LarkUserQuestionResultCard {
  status: 'answered' | 'cancelled' | 'resolved'
  /** Untrusted, user-visible terminal summary. Rendered only as CardKit plain text. */
  summary: string
}

export interface LarkModelPickerCard {
  title: string
  body: string
  providerOptions: readonly LarkSelectOption[]
  modelOptions: readonly LarkSelectOption[]
  effortOptions: readonly LarkSelectOption[]
  initialProvider?: string
  initialModel?: string
  initialEffort?: string
  callbackValues: Readonly<Record<'confirm' | 'effort' | 'model' | 'provider', { modelPicker: string }>>
}

interface LarkModelSelectionRoute {
  provider: string
  model: string
  effort: string
}

export type LarkModelSelectionResultCard =
  | ({ status: 'pending' } & LarkModelSelectionRoute)
  | ({ status: 'selected' } & LarkModelSelectionRoute)
  | ({ status: 'rejected'; explanation: string } & LarkModelSelectionRoute)

export type LarkPermissionLevel = 'ask' | 'auto' | 'full'

export interface LarkPermissionPickerCard {
  title: string
  body: string
  current: LarkPermissionLevel | 'custom'
  callbackValues: Readonly<Record<LarkPermissionLevel, { permissionPicker: string }>>
}

export interface LarkSelectOption {
  value: string
  label: string
}

export interface LarkAutomationIncidentCard {
  incidentId: string
  automationId: string
  definitionHash: string
  stage: 'claim' | 'materialize' | 'terminal'
  state: 'open' | 'recovering' | 'resolved'
  failureClass: string
  failurePhase: string
  failureCode: string
  sideEffectState: 'none' | 'possible' | 'unknown'
  retryability: 'after-intervention' | 'safe' | 'unsafe' | 'unknown'
  lifecycleGeneration: number
  incidentRevision: number
  openedAt: number
  updatedAt: number
  resolvedAt?: number
}

export type LarkSendInput =
  | { approval: LarkApprovalCard }
  | { approvalApplication: LarkApprovalApplicationCard }
  | { approvalResult: LarkApprovalResultCard }
  | { automationIncident: LarkAutomationIncidentCard }
  | { markdown: string }
  | { modelPicker: LarkModelPickerCard }
  | { modelSelectionResult: LarkModelSelectionResultCard }
  | { permissionPicker: LarkPermissionPickerCard }
  | { text: string }
  | { toolApproval: LarkToolApprovalCard }
  | { userQuestion: LarkUserQuestionCard }
  | { userQuestionResult: LarkUserQuestionResultCard }

export interface LarkSendOptions {
  replyTo?: string
  replyInThread?: boolean
  requestKey?: string
}

export interface LarkSendResult {
  messageId: string
  chunkIds?: readonly string[]
}

export interface LarkProgressHandle {
  cotId: string
  messageId: string
}

export interface LarkProgressEvent {
  eventType: string
  content: string
  timestamp: string
}

export interface LarkInboundImage {
  data: Uint8Array
  mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
}

export type LarkTransportErrorCode =
  | 'format_error'
  | 'not_connected'
  | 'permission_denied'
  | 'rate_limited'
  | 'send_timeout'
  | 'ssrf_blocked'
  | 'target_revoked'
  | 'unknown'
  | 'upload_failed'

export class LarkTransportError extends Error {
  constructor(
    readonly code: LarkTransportErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'LarkTransportError'
  }
}

export interface LarkTransportHandlers {
  message(message: LarkMessage): Promise<void>
  cardAction(action: LarkCardAction): Promise<unknown>
  reconnecting(): void
  reconnected(): void
  error(error: LarkTransportError): void
}

export interface LarkCardAction {
  messageId: string
  chatId: string
  operatorId: string
  value: unknown
  tag?: string
  name?: string
  option?: string
}

export interface LarkTransport {
  subscribe(handlers: LarkTransportHandlers): () => void
  connect(): Promise<void>
  disconnect(): Promise<void>
  addReaction(messageId: string, emojiType: string): Promise<string>
  createProgress(chatId: string, options: { replyTo: string; hidden: boolean }): Promise<LarkProgressHandle>
  writeProgress(handle: LarkProgressHandle, events: readonly LarkProgressEvent[]): Promise<void>
  /** Replace the exact bot-authored card message. Presentation failure must not affect durable state. */
  updateRawCard?(
    messageId: string,
    card: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void>
  downloadMessageImage?(
    messageId: string,
    fileKey: string,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<LarkInboundImage>
  send(chatId: string, input: LarkSendInput, options?: LarkSendOptions): Promise<LarkSendResult>
}

export type LarkConnectionState =
  | 'connected'
  | 'connected-with-gap'
  | 'connecting'
  | 'disabled'
  | 'disconnected'
  | 'reconnecting'

export interface LarkChannelHealth {
  state: LarkConnectionState
  gapGeneration: number
  lastErrorCode?: LarkTransportErrorCode
}
