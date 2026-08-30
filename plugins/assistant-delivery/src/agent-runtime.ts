import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDescriptor, CommandRuntime } from '@deepseek-ai/dsh-commands'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import {
  contentHasImage,
  createUserMessage,
  ReasoningEffortId,
  type ContentBlock,
  type LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import { effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { isAppendSurfaceEvent, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  effectiveApprovalPolicy,
  setApprovalPolicy,
  type ApprovalService,
} from '@deepseek-ai/dsh-user-approval'
import {
  approvalReviewerOf,
  setApprovalReviewer,
  waitForApprovalReviewerSessionEventReady,
  type ApprovalReviewer,
  type AssistantPolicyService,
} from '@dsh-enhanced/assistant-policy'
import { resolveLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
import type {
  InboundPrepareContext,
  InboundPrepareResult,
  InboundNotProcessedResult,
  InboundProcessResult,
  MarkInboundDispatching,
  PreparedInboundMessage,
} from './coordinator.js'
import { externalPrincipalId } from './canonical.js'
import {
  feedbackSignalInput,
  feedbackUsage,
  parseFeedbackCommand,
} from './feedback-command.js'
import type { FeedbackSignalSelection } from './feedback-command.js'
import type { InboundImageMaterializer } from './inbound-images.js'
import type { DeliveryInboundRuntime } from './service.js'
import {
  isExactDeliveryCommand,
  parseDeliveryCommand,
  permissionDispatchRecoveryCode,
  type ParsedDeliveryCommand,
  type PermissionDispatchRecovery,
} from './session-commands.js'
import { DeliveryStoreError } from './store.js'
import type {
  ConversationBinding,
  ConversationModelSelection,
  ConversationRef,
  DeliveryProgressUpdate,
  DeliveryPreferenceFeedback,
  InboundEnvelope,
  ModelPickerIntent,
  ModelRouteRef,
  PermissionPickerIntent,
  PermissionPickerLevel,
} from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    delivery: {
      kind: 'delivery'
      channel: string
      account: string
      eventId: string
      trust: 'untrusted'
    }
  }
}

interface DshDeliveryRuntimeOptions {
  sessionNamespace: string
  workspace: string
  agentPreset: string
  getAgentPresets(): Pick<AgentPresets, 'mount' | 'resolve'> | undefined
  policyRef: string
  provider: string
  model: string
  maxOutputTokens: number
  permissionPickerTtlMs: number
  getModelSelection(conversation: ConversationRef): ConversationModelSelection | undefined
  /** Atomically remove a stale explicit effort without overwriting a newer model choice. */
  clearStaleModelReasoningEffort(
    conversation: ConversationRef,
    expected: ConversationModelSelection,
  ): { applied: false } | { applied: true; selection: ConversationModelSelection }
  imageMaterializer: Pick<InboundImageMaterializer, 'materialize'>
  isInboundAuthorized(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
  ): boolean
  isPermissionController(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
  ): boolean
  isOwnerFeedbackController(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
  ): boolean
  authorizeOwnerPreferenceFeedback(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    selections: readonly Readonly<FeedbackSignalSelection>[],
  ): { occurredAt: number } | undefined
  dispatchPreferenceFeedback(
    events: readonly Readonly<DeliveryPreferenceFeedback>[],
  ): Promise<'recorded' | 'unavailable' | 'unknown'>
  /** Durably reserve the exact terminal reply authorization before permission state can change. */
  authorizePermissionReply(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
  ): boolean
  beginModelCommand(conversation: ConversationRef): number
  commitModelCommand(input: {
    conversation: ConversationRef
    expectedEpoch: number
    route?: ModelRouteRef
  }): { applied: false } | { applied: true; selection?: ConversationModelSelection }
  modelPickerTtlMs: number
  progress(
    binding: Readonly<ConversationBinding>,
    eventId: string,
    update: DeliveryProgressUpdate,
  ): Promise<void>
  replyCommand(
    binding: Readonly<ConversationBinding>,
    eventId: string,
    input: ModelCommandReply,
    idempotencyKey?: string,
  ): void
  reply(agent: Agent, eventId: string, input: ModelCommandReply): void
}

interface ModelCommandReply {
  text: string
  format?: 'markdown' | 'model-picker' | 'permission-picker' | 'plain'
  modelPicker?: ModelPickerIntent
  permissionPicker?: PermissionPickerIntent
  fallbackText?: string
}

const SAFE_NATIVE_COMMANDS = new Set(['compact'])

class UserSessionCancellation extends Error {
  constructor(readonly command: 'new' | 'stop') {
    super(`assistant-delivery: session task cancelled by /${command}`)
    this.name = 'UserSessionCancellation'
  }
}

interface ActiveSessionControl {
  controller: AbortController
  command?: 'new' | 'stop'
  cancelRequested: Promise<void>
  replySafe: Promise<void>
  removeOuterAbort(): void
  resolveCancelRequested(): void
  resolveReplySafe(): void
}

const MAX_CATALOG_MODELS = 50
const MAX_PROGRESS_TODOS = 20
const MAX_PROGRESS_TEXT_CHARS = 240
const MAX_PROGRESS_TOOL_PREVIEW_CHARS = 1_500
const MAX_PROGRESS_JSON_INPUT_CHARS = 32_768
const MAX_PROGRESS_JSON_DEPTH = 16
const MAX_PROGRESS_JSON_NODES = 500
const MAX_PROGRESS_RESULT_BLOCKS = 100
const REDACTED_PROGRESS_VALUE = '[REDACTED]'
const TRUNCATED_PROGRESS_VALUE = '[TRUNCATED]'
const PROGRESS_ASSIGNMENT_KEY = '([A-Za-z_][A-Za-z0-9_.-]{0,127})'
const PROGRESS_ASSIGNMENT_START = new RegExp(
  `(^|[^A-Za-z0-9_])(["']?)${PROGRESS_ASSIGNMENT_KEY}\\2(\\s*[:=]\\s*)`,
  'giu',
)
const ESCAPED_QUOTED_PROGRESS_ASSIGNMENT_START = new RegExp(
  `(^|[^A-Za-z0-9_])\\\\+(["'])${PROGRESS_ASSIGNMENT_KEY}\\\\+\\2(\\s*[:=]\\s*)`,
  'giu',
)

type InboundAuthorizationState = 'authorized' | 'revoked' | 'check-failed'

class DurableAgentIdentityError extends Error {}

class ApprovalReviewerReaderUnavailableError extends Error {
  constructor(cause: unknown) {
    super('assistant-delivery: approval reviewer persistence reader is not proven', { cause })
    this.name = 'ApprovalReviewerReaderUnavailableError'
  }
}

class AdapterToolCallProtocolError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    readonly presetId: string,
  ) {
    super(`assistant-delivery: adapter ${provider}/${model} declares no DSH tool-call protocol`)
    this.name = 'AdapterToolCallProtocolError'
  }
}

class ImageCapabilityAdmissionError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
  ) {
    super(`assistant-delivery: ${provider}/${model} does not declare image input support`)
    this.name = 'ImageCapabilityAdmissionError'
  }
}

function requireAdapterToolCallProtocol(
  llm: LlmRuntime,
  provider: string,
  model: string,
  presetId: string,
  toolCount: number,
): void {
  if (toolCount === 0) return
  if (resolveLlmRouteCapability(llm, provider, model)?.toolCalls === 'none') {
    throw new AdapterToolCallProtocolError(provider, model, presetId)
  }
}

function adapterToolCallProtocolReply(error: AdapterToolCallProtocolError): ModelCommandReply {
  return {
    text: `当前路由 ${error.provider}/${error.model} 的 adapter 明确声明未实现统一 DSH tool-call 协议，`
      + `因此无法承载 preset “${error.presetId}” 已挂载的工具。`
      + '这不是模型权限差异；请升级或修复该 provider adapter，使其实现 native/bridge 协议。',
    format: 'plain',
  }
}

function imageCapabilityReply(error: ImageCapabilityAdmissionError): ModelCommandReply {
  return {
    text: `当前模型 ${error.provider}/${error.model} 不支持图片输入。`
      + '请发送 /model 切换到明确支持图片的模型后重新发送图片。',
    format: 'plain',
  }
}

async function requireImageCapability(
  llm: LlmRuntime,
  provider: string,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (info.inputModalities?.includes('image') !== true) {
    throw new ImageCapabilityAdmissionError(provider, model)
  }
}

function boundedProgressText(value: string): string {
  return [...value].slice(0, MAX_PROGRESS_TEXT_CHARS).join('')
}

function boundedProgressToolPreview(value: string): string {
  const trimmed = value.trim()
  const characters = [...trimmed]
  return characters.length <= MAX_PROGRESS_TOOL_PREVIEW_CHARS
    ? trimmed
    : `${characters.slice(0, MAX_PROGRESS_TOOL_PREVIEW_CHARS - 1).join('')}…`
}

function redactProgressText(value: string): string {
  const common = redactEscapedKeyProgressAssignments(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/giu,
      '[REDACTED PRIVATE KEY]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu, '$1[REDACTED]@')
    .replace(/\b((?:proxy-)?authorization\s*[:=]\s*)(?:basic|bearer)\s+[^\s,;]+/giu,
      '$1[REDACTED]')
  return redactProgressAssignments(common)
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:sk|xai)-[A-Za-z0-9_-]{8,})\b/gu,
      REDACTED_PROGRESS_VALUE)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      REDACTED_PROGRESS_VALUE)
}

function isSensitiveProgressKey(key: string): boolean {
  const words = key.normalize('NFKC')
    .replace(/([a-z\d])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .split(/[^a-z\d]+/gu)
    .filter(Boolean)
  const joined = words.join('')
  return words.some(word => [
    'auth', 'authorization', 'bearer', 'cookie', 'cookies', 'credential', 'credentials',
    'password', 'passwd', 'secret', 'session', 'token',
  ].includes(word))
    || ['apikey', 'accesskey', 'privatekey'].some(phrase => joined.includes(phrase))
    || words.some((word, index) => ['api', 'access', 'private'].includes(word) && words[index + 1] === 'key')
}

/**
 * Text credentials have no trustworthy terminator: quotes may be malformed or multiply escaped,
 * while spaces, semicolons, and nested assignments can still belong to the value. Once a key is
 * recognized, fail closed through the logical line instead of exposing an arbitrary suffix.
 */
function redactProgressAssignments(value: string): string {
  let retainedIndex = 0
  let redacted = ''
  PROGRESS_ASSIGNMENT_START.lastIndex = 0
  for (let match = PROGRESS_ASSIGNMENT_START.exec(value); match !== null;
    match = PROGRESS_ASSIGNMENT_START.exec(value)) {
    const key = match[3]
    if (key === undefined || !isSensitiveProgressKey(key)) {
      // The prefix regex consumes the separator of an innocent outer field. Resume inside that
      // match so nested assignments on the same line remain visible to this scanner.
      PROGRESS_ASSIGNMENT_START.lastIndex = match.index + 1
      continue
    }
    const valueStart = match.index + match[0].length
    const lineEnd = progressRedactionEnd(value, valueStart)
    redacted += value.slice(retainedIndex, valueStart) + REDACTED_PROGRESS_VALUE
    retainedIndex = lineEnd
    PROGRESS_ASSIGNMENT_START.lastIndex = lineEnd
  }
  PROGRESS_ASSIGNMENT_START.lastIndex = 0
  return redacted + value.slice(retainedIndex)
}

/** Escaped JSON keys inside a log string cannot be parsed as the outer text; fail closed by line. */
function redactEscapedKeyProgressAssignments(value: string): string {
  let retainedIndex = 0
  let redacted = ''
  ESCAPED_QUOTED_PROGRESS_ASSIGNMENT_START.lastIndex = 0
  for (let match = ESCAPED_QUOTED_PROGRESS_ASSIGNMENT_START.exec(value); match !== null;
    match = ESCAPED_QUOTED_PROGRESS_ASSIGNMENT_START.exec(value)) {
    const key = match[3]
    if (key === undefined || !isSensitiveProgressKey(key)) {
      ESCAPED_QUOTED_PROGRESS_ASSIGNMENT_START.lastIndex = match.index + 1
      continue
    }
    const valueStart = match.index + match[0].length
    const lineEnd = progressRedactionEnd(value, valueStart)
    redacted += value.slice(retainedIndex, valueStart) + REDACTED_PROGRESS_VALUE
    retainedIndex = lineEnd
    ESCAPED_QUOTED_PROGRESS_ASSIGNMENT_START.lastIndex = lineEnd
  }
  ESCAPED_QUOTED_PROGRESS_ASSIGNMENT_START.lastIndex = 0
  return redacted + value.slice(retainedIndex)
}

function progressRedactionEnd(value: string, start: number): number {
  let cursor = start
  while (cursor < value.length) {
    const carriageReturn = value.indexOf('\r', cursor)
    const lineFeed = value.indexOf('\n', cursor)
    const candidates = [carriageReturn, lineFeed].filter(index => index >= 0)
    if (candidates.length === 0) return value.length
    const boundary = Math.min(...candidates)
    if (value[boundary - 1] !== '\\') return boundary
    cursor = boundary + (value[boundary] === '\r' && value[boundary + 1] === '\n' ? 2 : 1)
  }
  return value.length
}

function redactProgressJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): unknown {
  state.nodes += 1
  if (depth > MAX_PROGRESS_JSON_DEPTH || state.nodes > MAX_PROGRESS_JSON_NODES) {
    return TRUNCATED_PROGRESS_VALUE
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map(item => redactProgressJson(item, state, depth + 1))
    if (value.length > items.length) items.push(TRUNCATED_PROGRESS_VALUE)
    return items
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      isSensitiveProgressKey(key)
        ? REDACTED_PROGRESS_VALUE
        : redactProgressJson(item, state, depth + 1),
    ])
    if (Object.keys(value).length > entries.length) entries.push(['…', TRUNCATED_PROGRESS_VALUE])
    return Object.fromEntries(entries)
  }
  return typeof value === 'string' ? redactProgressText(value) : value
}

function progressArgumentsPlaceholder(value: string): string {
  const characters = [...redactProgressText(value.slice(0, MAX_PROGRESS_JSON_INPUT_CHARS))]
  let retained = Math.min(characters.length, MAX_PROGRESS_TOOL_PREVIEW_CHARS)
  while (retained >= 0) {
    const encoded = JSON.stringify({
      truncated: true,
      preview: characters.slice(0, retained).join(''),
    })
    if ([...encoded].length <= MAX_PROGRESS_TOOL_PREVIEW_CHARS) return encoded
    retained = retained === 0 ? -1 : Math.floor(retained * 0.75)
  }
  return '{"truncated":true}'
}

function progressArgumentsPreview(value: string): string {
  if (value.trim() === '') return '{}'
  // Never publish raw malformed or oversized model output. Normal tool calls are valid JSON; when
  // that invariant fails, a status marker is more useful than a best-effort secret scrubber.
  if (value.length > MAX_PROGRESS_JSON_INPUT_CHARS) return '{"truncated":true}'
  try {
    const encoded = JSON.stringify(redactProgressJson(JSON.parse(value), { nodes: 0 }), null, 2)
    if (encoded === undefined) return '{"invalidJson":true}'
    return [...encoded].length <= MAX_PROGRESS_TOOL_PREVIEW_CHARS
      ? encoded
      : progressArgumentsPlaceholder(encoded)
  } catch {
    return '{"invalidJson":true}'
  }
}

function redactProgressResultText(value: string): string {
  if (value.length > MAX_PROGRESS_JSON_INPUT_CHARS) return '{"truncated":true}'
  const trimmed = value.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const encoded = JSON.stringify(redactProgressJson(JSON.parse(trimmed), { nodes: 0 }), null, 2)
      if (encoded !== undefined) return encoded
    } catch {
      // Fall through to conservative line-oriented handling for JSON-like logs and fragments.
    }
  }
  return redactProgressText(value)
}

function progressResultPreview(content: readonly ContentBlock[], depth = 0): string {
  if (depth > 4) return TRUNCATED_PROGRESS_VALUE
  const parts: string[] = []
  let approximateLength = 0
  const append = (value: string): void => {
    if (approximateLength >= MAX_PROGRESS_TOOL_PREVIEW_CHARS * 2 || value === '') return
    const retained = value.slice(0, MAX_PROGRESS_TOOL_PREVIEW_CHARS * 2 - approximateLength)
    parts.push(retained)
    approximateLength += retained.length
  }
  let blockCount = 0
  for (const block of content) {
    if (approximateLength >= MAX_PROGRESS_TOOL_PREVIEW_CHARS * 2) break
    if (blockCount >= MAX_PROGRESS_RESULT_BLOCKS) {
      append(TRUNCATED_PROGRESS_VALUE)
      break
    }
    blockCount += 1
    if (block.type === 'text') append(redactProgressResultText(block.text))
    else if (block.type === 'image') append('[图片]')
    else if (block.type === 'tool-call') {
      append(`${block.name}\n${progressArgumentsPreview(block.arguments)}`)
    } else if (block.type === 'tool-result') {
      append(progressResultPreview(block.content, depth + 1))
    }
  }
  return boundedProgressToolPreview(redactProgressText(parts.join('\n')))
}

/**
 * Convert one durable session fact into a bounded, user-visible progress update.
 * Reasoning/thinking content and provider error messages never cross this boundary. Tool calls/results
 * contribute bounded previews with common credential shapes redacted; the channel still decides
 * whether its current audience is private enough to render those previews.
 *
 * A DSH `reasoning` block is explicitly thinking content and is not guaranteed to be a public
 * summary, even after assembly into `assistant/message`. `step/start` therefore provides the only
 * reasoning-independent phase label, so a turn reports progress without exposing hidden thought.
 */
export function deliveryProgressFromSessionEvent(event: SessionEvent): DeliveryProgressUpdate | undefined {
  if (event.type === 'step/start') {
    const step = Number(event.data.step)
    return {
      kind: 'step',
      text: Number.isSafeInteger(step) && step > 1 ? `正在继续处理（第 ${step} 步）…` : '正在处理请求…',
    }
  }
  if (event.type === 'assistant/message') {
    return undefined
  }
  if (event.type === 'tool/call') {
    const argumentsPreview = progressArgumentsPreview(event.data.arguments)
    return {
      kind: 'tool-started',
      callId: String(event.data.callId),
      toolName: boundedProgressText(event.data.name),
      ...(argumentsPreview === '' ? {} : { argumentsPreview }),
    }
  }
  if (event.type === 'tool/result') {
    // Replacement copies belong only to the model-visible surface (for example after compaction).
    // Human progress is an append-origin transcript, so projecting a replacement would make an
    // old tool result look like a tool invocation from the active turn.
    if (!isAppendSurfaceEvent(event)) return undefined
    const block = event.data.message.content.find(value => value.type === 'tool-result')
    const callId = block?.type === 'tool-result'
      ? block.toolCallId
      : event.data.message.source?.callId
    if (callId === undefined) return undefined
    const resultPreview = block?.type === 'tool-result'
      ? progressResultPreview(block.content)
      : ''
    const code = event.data.error?.code
    return {
      kind: 'tool-finished',
      callId: String(callId),
      failed: event.data.error !== undefined || (block?.type === 'tool-result' && block.isError === true),
      ...(resultPreview === '' ? {} : { resultPreview }),
      ...(code === undefined ? {} : { code: boundedProgressText(code) }),
    }
  }
  if (event.type === 'todo/write') {
    return { kind: 'todos', todos: event.data.todos.slice(0, MAX_PROGRESS_TODOS).map(todo => ({
      content: boundedProgressText(todo.content),
      status: todo.status,
    })) }
  }
  return undefined
}

function parseModelRoute(value: string): ModelRouteRef | undefined {
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) return undefined
  const provider = value.slice(0, separator).trim()
  const model = value.slice(separator + 1).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(provider)
    || model.length > 512 || /[\s\p{Cc}]/u.test(model)) return undefined
  return { provider, model }
}

function modelCommand(command: ParsedDeliveryCommand | undefined): string | undefined {
  return command?.name === 'model' ? command.rawInput.trim() : undefined
}

function permissionCommand(command: ParsedDeliveryCommand | undefined): string | undefined {
  return command?.name === 'permission' || command?.name === 'permissions'
    ? command.rawInput.trim()
    : undefined
}

type PermissionCommandAction =
  | { kind: 'show' }
  | { kind: 'warn-full' }
  | { kind: 'switch'; level: 'ask' | 'auto' | 'full' }
  | { kind: 'invalid' }

function parsePermissionCommand(argument: string): PermissionCommandAction {
  const tokens = argument === '' ? [] : argument.split(/\s+/u)
  if (tokens.length === 0) return { kind: 'show' }
  if (tokens.length === 1 && tokens[0] === 'ask') return { kind: 'switch', level: 'ask' }
  if (tokens.length === 1 && tokens[0] === 'auto') return { kind: 'switch', level: 'auto' }
  if (tokens.length === 1 && tokens[0] === 'full') return { kind: 'warn-full' }
  if (tokens.length === 2 && tokens[0] === 'full' && tokens[1] === 'confirm') {
    return { kind: 'switch', level: 'full' }
  }
  return { kind: 'invalid' }
}

const PERMISSION_PICKER_OPERATION_METADATA = 'permission-picker-operation'
const PERMISSION_PICKER_STATE_METADATA = 'permission-picker-state'
const PERMISSION_PICKER_EXPIRY_METADATA = 'permission-picker-expires-at'
const PERMISSION_PICKER_EMERGENCY_VERSION_METADATA = 'permission-picker-emergency-version'

function permissionPickerGuard(envelope: Readonly<InboundEnvelope>):
{ operationId: string; expectedStateHash: string; expiresAt: number; emergencyStopVersion: number } | 'invalid' | undefined {
  const operationId = envelope.metadata?.[PERMISSION_PICKER_OPERATION_METADATA]
  const expectedStateHash = envelope.metadata?.[PERMISSION_PICKER_STATE_METADATA]
  const expiresAtText = envelope.metadata?.[PERMISSION_PICKER_EXPIRY_METADATA]
  const emergencyStopVersionText = envelope.metadata?.[PERMISSION_PICKER_EMERGENCY_VERSION_METADATA]
  if (operationId === undefined && expectedStateHash === undefined && expiresAtText === undefined
    && emergencyStopVersionText === undefined) return undefined
  if (operationId === undefined || expectedStateHash === undefined || expiresAtText === undefined
    || emergencyStopVersionText === undefined
    || !/^permission-picker-[a-f0-9]{32}$/u.test(operationId)
    || !/^[a-f0-9]{64}$/u.test(expectedStateHash)
    || !/^[1-9][0-9]{0,15}$/u.test(expiresAtText)
    || !/^(?:0|[1-9][0-9]{0,15})$/u.test(emergencyStopVersionText)) return 'invalid'
  const expiresAt = Number(expiresAtText)
  const emergencyStopVersion = Number(emergencyStopVersionText)
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(emergencyStopVersion)) return 'invalid'
  return { operationId, expectedStateHash, expiresAt, emergencyStopVersion }
}

type PermissionPresets = Pick<PermissionPresetService, 'current' | 'names' | 'resolve' | 'set'>

interface PermissionPresetTargets {
  ask: string
  auto: string
  full: string
  tableFingerprint: string
}

function permissionPresetTargets(service: PermissionPresets): Partial<PermissionPresetTargets> {
  const workspace: string[] = []
  const full: string[] = []
  const table: Array<readonly [string, string, string]> = []
  for (const name of service.names) {
    const spec = service.resolve(name)
    table.push([name, spec.sandbox, spec.approval])
    if (spec.sandbox === 'workspace-write' && spec.approval === 'ask') workspace.push(name)
    if (spec.sandbox === 'danger-full-access' && spec.approval === 'never') full.push(name)
  }
  if (workspace.length > 2 || full.length > 1) {
    throw new Error('ambiguous permission preset table')
  }
  const ask = workspace[0]
  const auto = workspace[1] ?? ask
  return {
    ...(ask === undefined ? {} : { ask, auto: auto! }),
    ...(full[0] === undefined ? {} : { full: full[0] }),
    tableFingerprint: createHash('sha256').update(JSON.stringify(table)).digest('hex'),
  }
}

function missingPermissionBundle(targets: Partial<PermissionPresetTargets>): string | undefined {
  if (targets.ask === undefined || targets.auto === undefined) return 'workspace-write + ask'
  return targets.full === undefined ? 'danger-full-access + never' : undefined
}

function explicitSandboxMode(events: readonly SessionEvent[]): 'workspace-write' | 'danger-full-access' | undefined {
  const event = events.findLast(candidate => candidate.type === 'sandbox/mode')
  if (event?.data.mode === 'workspace-write' || event?.data.mode === 'danger-full-access') return event.data.mode
  return undefined
}

function explicitApprovalPolicy(events: readonly SessionEvent[]): 'ask' | 'never' | undefined {
  const event = events.findLast(candidate => candidate.type === 'approval/policy')
  if (event?.data.policy === 'ask' || event?.data.policy === 'never') return event.data.policy
  return undefined
}

async function appendApprovalReviewer(
  session: Session,
  reviewer: ApprovalReviewer,
): Promise<boolean> {
  try {
    await waitForApprovalReviewerSessionEventReady(session)
    return setApprovalReviewer(session, reviewer)
  } catch (error) {
    throw new ApprovalReviewerReaderUnavailableError(error)
  }
}

function currentPermissionLevel(
  service: PermissionPresets,
  targets: PermissionPresetTargets,
  events: readonly SessionEvent[],
): 'ask' | 'auto' | 'full' | 'custom' {
  const current = service.current(events)
  if (current === targets.full) {
    return effectiveSandboxMode(events) === 'danger-full-access'
      && effectiveApprovalPolicy(events) === 'never'
      && approvalReviewerOf(events) === 'none'
      ? 'full'
      : 'custom'
  }
  if (effectiveSandboxMode(events) !== 'workspace-write' || effectiveApprovalPolicy(events) !== 'ask') return 'custom'
  const reviewer = approvalReviewerOf(events)
  if (targets.ask === targets.auto && current === targets.ask) return reviewer === 'auto-review' ? 'auto' : 'ask'
  if (current === targets.ask) return reviewer === 'user' ? 'ask' : 'custom'
  if (current === targets.auto) return reviewer === 'auto-review' ? 'auto' : 'custom'
  return 'custom'
}

function canonicalPresetReviewer(name: string): ApprovalReviewer | undefined {
  if (name === 'workspace-write') return 'user'
  if (name === 'auto') return 'auto-review'
  if (name === 'danger-full-access') return 'none'
  return undefined
}

async function ensurePermissionReviewer(
  session: Session,
  preset: string,
  reviewer: ApprovalReviewer,
): Promise<void> {
  if (approvalReviewerOf(session.events) === reviewer) return
  if (canonicalPresetReviewer(preset) === reviewer) {
    // PermissionPresetService deliberately makes a net-zero selection a no-op.
    // Re-append its official event when an older legacy reviewer event would
    // otherwise remain newer and incorrectly win the durable fold.
    session.append('permission/preset', { preset })
    return
  }
  await appendApprovalReviewer(session, reviewer)
}

function ensureSandboxMode(
  session: Session,
  mode: Parameters<typeof setSandboxMode>[1],
): void {
  if (explicitSandboxMode(session.events) === mode) return
  setSandboxMode(session, mode)
  if (explicitSandboxMode(session.events) !== mode) session.append('sandbox/mode', { mode })
}

function ensureApprovalPolicy(
  session: Session,
  policy: Parameters<typeof setApprovalPolicy>[1],
): void {
  if (explicitApprovalPolicy(session.events) === policy) return
  setApprovalPolicy(session, policy)
  if (explicitApprovalPolicy(session.events) !== policy) session.append('approval/policy', { policy })
}

function permissionLevelLabel(level: 'ask' | 'auto' | 'full' | 'custom'): string {
  if (level === 'ask') return '请求批准（ask）'
  if (level === 'auto') return '帮我批准（auto）'
  if (level === 'full') return '完全访问权限（full）'
  return '自定义安全组合（custom）'
}

export function permissionStateHash(events: readonly SessionEvent[], tableFingerprint = ''): string {
  const facts = events
    .filter(event => [
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
      'assistant-policy/approval-reviewer',
    ].includes(String(event.type)))
    .map(event => ({ seq: event.seq, type: String(event.type), data: event.data }))
  return createHash('sha256')
    .update('assistant-delivery:permission-state:v2\0')
    .update(JSON.stringify([tableFingerprint, facts]))
    .digest('hex')
}

export function permissionPickerOperationId(conversation: Readonly<ConversationRef>, eventId: string): string {
  return `permission-picker-${createHash('sha256').update(JSON.stringify({
    channel: conversation.channel,
    account: conversation.account,
    tenant: conversation.tenant,
    kind: conversation.kind,
    chat: conversation.chat,
    thread: conversation.thread ?? null,
    eventId,
  })).digest('hex').slice(0, 32)}`
}

function permissionOverview(level: PermissionPickerLevel, picker?: PermissionPickerIntent): ModelCommandReply {
  const text = [
    `当前权限：${permissionLevelLabel(level)}`,
    '',
    '三档说明：',
    '- 请求批准（ask）：仅可写工作区；需要授权时由你确认。',
    '- 帮我批准（auto）：仅可写工作区；由自动审核器处理授权请求。',
    '- 完全访问权限（full）：🟠 Host sandbox 可访问网络及任意文件，且不再请求批准；管理员 Policy 硬门仍生效。',
    '',
    '档位只控制运行权限，不会安装或挂载技能/插件；已挂载工具还必须有 Policy 可达规则。',
    'full 仍不绕过显式 Policy 拒绝、紧急停止、身份和预算硬门。',
    '',
    '切换：/permission ask、/permission auto、/permission full confirm',
  ].join('\n')
  return {
    text,
    format: picker === undefined ? 'plain' : 'permission-picker',
    ...(picker === undefined ? {} : { permissionPicker: picker, fallbackText: text }),
  }
}

const PERMISSION_USAGE: ModelCommandReply = {
  text: '用法：/permission、/permission ask、/permission auto、/permission full confirm',
  format: 'plain',
}

const PERMISSION_FULL_WARNING: ModelCommandReply = {
  text: '🟠 危险：full 会启用 danger-full-access，可访问网络及任意文件，并关闭批准请求。'
    + '管理员 Policy 的显式拒绝、紧急停止、身份和预算硬门仍生效。'
    + '如确需切换，请明确发送 /permission full confirm。当前权限未改变。',
  format: 'plain',
}

function routeLabel(route: ModelRouteRef): string {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `，effort：${route.reasoningEffort}`}`
}

function displayName(value: string): string {
  return [...value].slice(0, 120).join('')
}

export function modelPickerOperationId(conversation: Readonly<ConversationRef>, eventId: string): string {
  return `model-picker-${createHash('sha256').update(JSON.stringify({
    channel: conversation.channel,
    account: conversation.account,
    tenant: conversation.tenant,
    kind: conversation.kind,
    chat: conversation.chat,
    thread: conversation.thread ?? null,
    eventId,
  })).digest('hex').slice(0, 32)}`
}

function toModelRoute(route: ModelRouteRef): ModelRouteRef {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

function agentSelection(route: ModelRouteRef) {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
  }
}

function errorHasCode(error: unknown, code: string): boolean {
  let current = error
  const visited = new Set<unknown>()
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current)
    if ('code' in current && (current as { code?: unknown }).code === code) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

async function modelCatalog(
  llm: LlmRuntime,
  conversation: ConversationRef,
  current: ModelRouteRef,
  isDefault: boolean,
  eventId: string,
  expiresAt: number,
  signal: AbortSignal,
): Promise<ModelCommandReply> {
  const providers = llm.listProviders()
  const catalogs = await Promise.all(providers.map(async provider => {
    try {
      return { provider, models: await llm.listModels(provider.id) }
    } catch {
      return { provider, models: undefined }
    }
  }))
  const fallback = [
    `当前模型：${routeLabel(current)}${isDefault ? '（默认）' : ''}`,
    '',
    '可用模型（来自 DSH 实时目录）：',
  ]
  const models: ModelPickerIntent['models'][number][] = []
  const visibleProviders = new Map<string, ModelPickerIntent['providers'][number]>()
  let shown = 0
  let hidden = 0
  for (const catalog of catalogs) {
    fallback.push(`${catalog.provider.name} [${catalog.provider.id}]`)
    if (catalog.models === undefined) {
      fallback.push('- 目录暂不可用')
      continue
    }
    if (catalog.models.length === 0) {
      fallback.push('- 未提供可枚举模型')
      continue
    }
    for (const model of catalog.models) {
      if (shown >= MAX_CATALOG_MODELS) {
        hidden += 1
        continue
      }
      const route = `${catalog.provider.id}/${model.id}`
      const marker = catalog.provider.id === current.provider && model.id === current.model ? '（当前）' : ''
      const display = model.name === model.id ? '' : ` — ${model.name}`
      fallback.push(`- ${route}${display}${marker}`)
      visibleProviders.set(catalog.provider.id, {
        id: catalog.provider.id,
        name: displayName(catalog.provider.name),
      })
      models.push({ provider: catalog.provider.id, id: model.id, name: displayName(model.name), effortIds: [] })
      shown += 1
    }
  }
  if (providers.length === 0) fallback.push('- 当前没有已注册的模型 provider')
  if (hidden > 0) fallback.push(`- 另有 ${hidden} 个模型未展示`)
  fallback.push('', '切换：/model use <provider/model>', '恢复默认：/model reset')
  if (models.length === 0) return { text: fallback.join('\n'), format: 'plain' }
  const resolved = await Promise.allSettled(models.map(model => llm.resolveModelInfo(model.provider, model.id, signal)))
  const efforts = new Map<string, string>()
  const linkedModels = models.map((model, index) => {
    const result = resolved[index]
    if (result?.status !== 'fulfilled') return model
    const effortIds = new Set<string>()
    for (const effort of result.value.reasoning?.efforts ?? []) {
      const id = String(effort.id)
      if (!efforts.has(id) && efforts.size >= 20) continue
      efforts.set(id, displayName(effort.name))
      if (effortIds.size < 20) effortIds.add(id)
    }
    return { ...model, effortIds: [...effortIds] }
  })
  return {
    text: `当前模型：${routeLabel(current)}${isDefault ? '（默认）' : ''}`,
    format: 'model-picker',
    modelPicker: {
      operationId: modelPickerOperationId(conversation, eventId),
      expiresAt,
      current,
      providers: [...visibleProviders.values()],
      models: linkedModels,
      efforts: [...efforts].map(([id, name]) => ({ id, name })),
    },
    fallbackText: fallback.join('\n'),
  }
}

async function runModelCommand(
  argument: string,
  llm: LlmRuntime,
  conversation: ConversationRef,
  defaults: ModelRouteRef,
  options: DshDeliveryRuntimeOptions,
  signal: AbortSignal,
  eventId: string,
): Promise<ModelCommandReply> {
  const current = options.getModelSelection(conversation)
  const route = toModelRoute(current ?? defaults)
  if (argument === '') {
    return modelCatalog(
      llm,
      conversation,
      route,
      current === undefined,
      eventId,
      Date.now() + options.modelPickerTtlMs,
      signal,
    )
  }
  if (argument === 'reset') {
    const epoch = options.beginModelCommand(conversation)
    const committed = options.commitModelCommand({ conversation, expectedEpoch: epoch })
    if (!committed.applied) return { text: '模型选择已被更晚的操作取代，请重新发送 /model。' }
    const changed = current !== undefined
    return { text: changed
      ? `已恢复默认模型 ${routeLabel(defaults)}。\n下一条消息起生效，上下文保留。`
      : `本会话已在使用默认模型 ${routeLabel(defaults)}。` }
  }
  if (!argument.startsWith('use ')) {
    return { text: '用法：/model、/model use <provider/model>、/model reset' }
  }
  const target = argument.slice('use '.length).trim()
  const selected = parseModelRoute(target)
  if (selected === undefined) return { text: '用法：/model use <provider/model>' }
  if (!llm.listProviders().some(provider => provider.id === selected.provider)) {
    return { text: `没有注册 provider “${selected.provider}”。发送 /model 查看当前可用模型。` }
  }
  const epoch = options.beginModelCommand(conversation)
  try {
    await llm.resolveModelInfo(selected.provider, selected.model, signal)
  } catch (error) {
    if (signal.aborted) throw error
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof (error as { code: unknown }).code === 'string'
      ? `（${(error as { code: string }).code}）`
      : ''
    return { text: `模型 ${routeLabel(selected)} 当前不可用${code}。发送 /model 重新选择。` }
  }
  const changed = current?.provider !== selected.provider || current.model !== selected.model
  if (!changed && current.reasoningEffort === undefined) return { text: `本会话已在使用 ${routeLabel(selected)}。` }
  const committed = options.commitModelCommand({ conversation, expectedEpoch: epoch, route: selected })
  if (!committed.applied) return { text: '模型选择已被更晚的操作取代，请重新发送 /model。' }
  return { text: `已切换到 ${routeLabel(selected)}。\n下一条消息起生效，上下文保留。` }
}

function modelCommandFailure(error: unknown): InboundProcessResult {
  const deterministic = error instanceof DeliveryStoreError
    && (error.code === 'invalid-intent' || error.code === 'invalid-binding')
  return {
    outcome: 'not-processed',
    failureCode: deterministic ? 'model-command-invalid' : 'model-command-failed',
    retryable: !deterministic,
  }
}

function sessionId(
  namespace: string,
  conversation: InboundEnvelope['conversation'],
  generation: number,
): SessionId {
  const hash = createHash('sha256')
    .update(JSON.stringify({ namespace, conversation, generation }))
    .digest('hex')
    .slice(0, 32)
  return SessionId(`delivery-${hash}-g${generation}`)
}

async function ensureWorkspace(workspace: string): Promise<void> {
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(`assistant-delivery: failed to ensure workspace "${workspace}": ${String(error)}`, {
      cause: error,
    })
  }
}

async function requireWorkspace(workspace: string): Promise<void> {
  try {
    const metadata = await stat(workspace)
    if (!metadata.isDirectory()) throw new Error('path is not a directory')
  } catch (error) {
    throw new Error(`assistant-delivery: durable workspace "${workspace}" is unavailable: ${String(error)}`, {
      cause: error,
    })
  }
}

function causedByDurableIdentity(error: unknown): boolean {
  let current = error
  const visited = new Set<unknown>()
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof DurableAgentIdentityError) return true
    visited.add(current)
    current = current.cause
  }
  return false
}

function causedByUserCancellation(error: unknown): boolean {
  let current = error
  const visited = new Set<unknown>()
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof UserSessionCancellation) return true
    visited.add(current)
    current = current.cause
  }
  return false
}

function errorChainHasName(error: unknown, expected: string): boolean {
  let current = error
  const visited = new Set<unknown>()
  while (current instanceof Error && !visited.has(current)) {
    if (current.name === expected) return true
    visited.add(current)
    current = current.cause
  }
  return false
}

function assertAdoptableUnstartedSession(
  session: Session,
  workspace: string,
  presetId: string,
): void {
  if (session.header.cwd !== workspace || session.header.agentPreset !== presetId) {
    throw new DurableAgentIdentityError(
      'assistant-delivery: durable orphan session identity does not match the requested generation',
    )
  }
  if (session.events.some(event => event.type === 'turn/start' || event.type === 'user/message')
    || session.deriveMessages().length > 0) {
    throw new DurableAgentIdentityError(
      'assistant-delivery: refusing to adopt a deterministic session that already started a user turn',
    )
  }
}

function sessionResumeFailureCode(error: unknown): string {
  if (causedByDurableIdentity(error)) return 'agent-identity-mismatch'
  if (errorChainHasName(error, 'SessionFormatUnsupportedError')) return 'session-format-unsupported'
  if (errorChainHasName(error, 'SessionPersistenceCorruptionError')) return 'session-persistence-corrupt'
  return 'session-resume-unavailable'
}

function sessionFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function finalAssistant(
  events: readonly SessionEvent[],
  from: number,
  expectedTurn: number | undefined,
): { text: string; completed: boolean; stopped: boolean; failureCode?: string } {
  if (expectedTurn === undefined) return { text: '', completed: false, stopped: false }
  let text = ''
  let completed = false
  let stopped = false
  let failureCode: string | undefined
  for (const event of events.slice(from)) {
    if (event.type === 'assistant/message' && event.data.turn === expectedTurn) {
      text = event.data.message.content.filter(block => block.type === 'text')
        .map(block => block.type === 'text' ? block.text : '').join('')
    }
    if (event.type === 'turn/end' && event.data.turn === expectedTurn) {
      const reason = event.data.reason
      completed = typeof reason === 'object' && reason !== null && 'kind' in reason
        && ['completed', 'max-tokens'].includes((reason as { kind: string }).kind)
      stopped = typeof reason === 'object' && reason !== null
        && (reason as { kind?: unknown }).kind === 'aborted'
        && typeof (reason as { reason?: unknown }).reason === 'object'
        && (reason as { reason?: { kind?: unknown } }).reason?.kind === 'user'
      // Keep only the short upstream code: the provider message can quote the prompt or payload.
      const error = typeof reason === 'object' && reason !== null && 'error' in reason
        ? (reason as { error?: { code?: unknown } }).error
        : undefined
      failureCode = completed || typeof error?.code !== 'string' ? undefined : error.code
    }
  }
  return { text, completed, stopped, ...(failureCode === undefined ? {} : { failureCode }) }
}

export class DshDeliveryRuntime implements DeliveryInboundRuntime {
  readonly dispatchControl = 'explicit' as const
  private readonly activeSessionControls = new Map<string, ActiveSessionControl>()

  constructor(
    private readonly ctx: Context,
    private readonly policy: AssistantPolicyService,
    private readonly options: DshDeliveryRuntimeOptions,
  ) {}

  async cancelActive(binding: Readonly<ConversationBinding>, command: 'new' | 'stop'): Promise<boolean> {
    const sessionId = binding.sessionId
    const control = this.activeSessionControls.get(sessionId)
    const agents = this.ctx.get('agents')
    const agent = agents?.get(SessionId(sessionId))
    const activeAgent = agent !== undefined && agent.status !== 'idle'
    if (control === undefined && !activeAgent) return false
    if (control !== undefined) {
      // A generation boundary is stronger than a stop acknowledgement. Never
      // let a later `/stop` downgrade an in-flight `/new` cancellation.
      control.command = control.command === 'new' || command === 'new' ? 'new' : 'stop'
      control.resolveCancelRequested()
      if (!control.controller.signal.aborted) {
        control.controller.abort(new UserSessionCancellation(control.command))
      }
    }
    // rc.8 `whenIdle()` follows every later wakeup. Waiting on it here lets an
    // unrelated followup keep `/stop` or `/new` alive forever. Clear pending
    // input and wait only for Delivery's exact reply-scheduling boundary.
    if (activeAgent) agent.cancel({ kind: 'user' })
    if (control !== undefined) await control.replySafe
    return true
  }

  private beginSessionControl(sessionId: string, outer: AbortSignal): ActiveSessionControl {
    if (this.activeSessionControls.has(sessionId)) {
      throw new Error(`assistant-delivery: session ${sessionFingerprint(sessionId)} is already processing an inbound`)
    }
    const controller = new AbortController()
    let resolveCancelRequested!: () => void
    let resolveReplySafe!: () => void
    const cancelRequested = new Promise<void>(resolve => { resolveCancelRequested = resolve })
    const replySafe = new Promise<void>(resolve => { resolveReplySafe = resolve })
    const abort = (): void => controller.abort(outer.reason)
    outer.addEventListener('abort', abort, { once: true })
    if (outer.aborted) abort()
    const control: ActiveSessionControl = {
      controller,
      cancelRequested,
      replySafe,
      removeOuterAbort: () => outer.removeEventListener('abort', abort),
      resolveCancelRequested,
      resolveReplySafe,
    }
    this.activeSessionControls.set(sessionId, control)
    return control
  }

  private endSessionControl(sessionId: string, control: ActiveSessionControl): void {
    control.removeOuterAbort()
    control.resolveReplySafe()
    if (this.activeSessionControls.get(sessionId) === control) this.activeSessionControls.delete(sessionId)
  }

  private async disposeAfterReplyBoundary(sessionId: string, handle: AgentHandle | undefined): Promise<void> {
    const control = this.activeSessionControls.get(sessionId)
    control?.resolveReplySafe()
    if (handle === undefined) return
    const disposal = Promise.resolve().then(() => handle.dispose())
    const disposition = control === undefined
      ? await disposal.then(() => 'disposed' as const)
      : await Promise.race([
          disposal.then(() => 'disposed' as const),
          control.cancelRequested.then(() => 'cancelled' as const),
        ])
    if (disposition === 'cancelled') {
      // The Delivery turn is already cancelled and cannot enqueue another
      // reply. Teardown remains owned, but a third-party disposer must not
      // hold the conversation transition or its fresh generation hostage.
      void disposal.catch(error => {
        this.ctx.logger.warn(
          `assistant-delivery: cancelled session disposer failed for ${sessionFingerprint(sessionId)}: ${String(error)}`,
        )
      })
      return
    }
  }

  /** Wait for only the turn that claims Delivery's exact message identity. */
  private followupTurn(
    agent: Agent,
    message: ReturnType<typeof createUserMessage>,
  ): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      let claimedTurn: number | undefined
      let settled = false
      const cleanup = (): void => {
        removeClaimed()
        removeDiscarded()
        removeSessionEvent()
      }
      const settle = (turn: number | undefined): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(turn)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const removeClaimed = this.ctx.on('agent/inbox/claimed', event => {
        if (event.agent === agent && event.message.id === message.id) claimedTurn = event.turn
      })
      const removeDiscarded = this.ctx.on('agent/inbox/discarded', event => {
        if (event.agent === agent && event.message.id === message.id) settle(undefined)
      })
      const removeSessionEvent = this.ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'turn/end' && event.data.turn === claimedTurn) {
          settle(claimedTurn)
        }
      })
      try {
        agent.followup(message)
      } catch (error) {
        fail(error)
      }
    })
  }

  private async setupAgent(
    agentCtx: Agent['ctx'],
    workspace: string,
    presetId: string,
    principal: string,
    selected: ModelSelection,
    agentPresets: Pick<AgentPresets, 'mount'> | undefined,
  ): Promise<void> {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('assistant-delivery: unpublished Agent identity is missing')
    if (agent.session.header.cwd !== workspace || agent.session.header.agentPreset !== presetId) {
      throw new DurableAgentIdentityError(
        'assistant-delivery: durable Agent identity does not match its conversation binding',
      )
    }
    const unbind = this.policy.bindInitiator(agent, 'external', principal)
    agentCtx.effect(() => unbind, 'assistant-delivery.external-initiator')
    installModelSelection(agentCtx, { current: selected, assembled: undefined })
    await agentPresets?.mount(agentCtx, presetId)
  }

  /**
   * DSH validates an explicit reasoning effort before calling an adapter. That is normally the
   * right contract, but a persisted external-channel selection can outlive a provider's live
   * model directory. Clear only that stale persisted effort before a prompt crosses the durable
   * dispatch boundary; TraeX still rechecks the newly created ACP session afterwards.
   */
  private async resolveExecutionRoute(
    conversation: ConversationRef,
    persisted: ConversationModelSelection | undefined,
    route: ModelRouteRef,
    signal: AbortSignal,
  ): Promise<{ route: ModelRouteRef } | { retry: true }> {
    if (route.reasoningEffort === undefined) return { route }
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('assistant-delivery: llm service is required')
    try {
      await llm.resolveCallConfig({
        provider: route.provider,
        model: route.model,
        reasoningEffort: ReasoningEffortId(route.reasoningEffort),
      }, signal)
      return { route }
    } catch (error) {
      if (signal.aborted || !errorHasCode(error, 'UNSUPPORTED_REASONING_EFFORT')) throw error
      const fallback = { provider: route.provider, model: route.model }
      // Do not turn an invalid model/default into a silent recovery. This is the same core
      // preflight without the stale explicit effort, still before an Agent turn is dispatched.
      await llm.resolveCallConfig(fallback, signal)
      if (persisted === undefined) {
        this.ctx.logger.warn(`assistant-delivery: using provider default after unsupported reasoning effort for ${route.provider}/${route.model}`)
        return { route: fallback }
      }
      const recovered = this.options.clearStaleModelReasoningEffort(conversation, persisted)
      if (!recovered.applied) return { retry: true }
      this.ctx.logger.warn(`assistant-delivery: cleared stale reasoning effort for ${route.provider}/${route.model} before dispatch`)
      return { route: toModelRoute(recovered.selection) }
    }
  }

  private async reconcileNativeFullPermissionReviewer(session: Session): Promise<void> {
    const result = await this.policy.reconcileNativeFullReviewer(session)
    if (result === 'unavailable') {
      throw new ApprovalReviewerReaderUnavailableError(
        new Error('assistant-policy: native full reviewer reconciliation is unavailable'),
      )
    }
  }

  private async runPermissionCommand(
    argument: string,
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    signal: AbortSignal,
    markDispatching: MarkInboundDispatching,
    recovery?: PermissionDispatchRecovery,
  ): Promise<InboundProcessResult> {
    let dispatchMarked = false
    const markPermissionDispatch = (): void => {
      signal.throwIfAborted()
      if (dispatchMarked) return
      markDispatching()
      dispatchMarked = true
    }
    const checkController = (): InboundAuthorizationState => {
      try {
        return this.options.isPermissionController(binding, envelope) ? 'authorized' : 'revoked'
      } catch {
        return 'check-failed'
      }
    }
    const checkEmergencyStopVersion = (expected: number | undefined): InboundAuthorizationState => {
      if (expected === undefined) return 'authorized'
      try {
        const emergencyStop = this.policy.getEmergencyStop()
        return !emergencyStop.enabled && emergencyStop.version === expected ? 'authorized' : 'revoked'
      } catch {
        return 'check-failed'
      }
    }
    const authorizationFailure = (
      state: Exclude<InboundAuthorizationState, 'authorized'>,
      committed = false,
    ): InboundProcessResult => state === 'revoked'
      ? { outcome: 'not-processed', failureCode: 'permission-authorization-revoked', retryable: false }
      : { outcome: 'not-processed', failureCode: 'permission-authorization-check-failed', retryable: !committed }
    const reply = (input: ModelCommandReply, committed = false): InboundProcessResult => {
      const authorization = checkController()
      if (authorization !== 'authorized') return authorizationFailure(authorization, committed)
      markPermissionDispatch()
      signal.throwIfAborted()
      try {
        this.options.replyCommand(binding, envelope.eventId, input)
        return { outcome: 'processed' }
      } catch {
        if (input.format === 'permission-picker' && input.fallbackText !== undefined) {
          try {
            this.options.replyCommand(binding, envelope.eventId, { text: input.fallbackText, format: 'plain' })
            return { outcome: 'processed' }
          } catch {}
        }
        return { outcome: 'not-processed', failureCode: 'permission-command-reply-failed', retryable: !committed }
      }
    }
    const retryPermissionRecovery = (
      mode: PermissionDispatchRecovery = recovery ?? 'failure-notice',
    ): InboundProcessResult => ({
      outcome: 'not-processed',
      failureCode: permissionDispatchRecoveryCode(mode),
      retryable: true,
    })
    const preservePermissionRecovery = (
      result: InboundProcessResult,
      mode: PermissionDispatchRecovery,
    ): InboundProcessResult => result.outcome === 'processed' ? result : retryPermissionRecovery(mode)
    const authorizeTerminalReply = (): boolean => {
      try {
        return this.options.authorizePermissionReply(binding, envelope)
      } catch {
        return false
      }
    }

    const action = parsePermissionCommand(argument)
    if (recovery === undefined) {
      const initialAuthorization = checkController()
      if (initialAuthorization !== 'authorized') return authorizationFailure(initialAuthorization)
      if (!authorizeTerminalReply()) {
        return {
          outcome: 'not-processed',
          failureCode: 'permission-reply-authorization-denied',
          retryable: false,
        }
      }
    }
    if (recovery === undefined && action.kind === 'invalid') return reply(PERMISSION_USAGE)
    if (recovery === undefined && action.kind === 'warn-full') return reply(PERMISSION_FULL_WARNING)
    const parsedPickerGuard = permissionPickerGuard(envelope)
    if (parsedPickerGuard === 'invalid' && recovery === undefined) {
      return reply({ text: '权限卡片来源无效；当前权限未改变。请重新发送 /permissions。', format: 'plain' })
    }
    const pickerGuard = parsedPickerGuard === 'invalid' ? undefined : parsedPickerGuard
    if (pickerGuard !== undefined && Date.now() >= pickerGuard.expiresAt && recovery === undefined) {
      return reply({ text: '权限卡片已过期；当前权限未改变。请重新发送 /permissions。', format: 'plain' })
    }

    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    const permissionPresets = this.ctx.get('permissionPresets') as PermissionPresets | undefined
    const approval = this.ctx.get('approval') as ApprovalService | undefined
    if (agents === undefined || sessions === undefined || permissionPresets === undefined || approval === undefined) {
      if (recovery !== undefined) return retryPermissionRecovery(recovery)
      return reply({ text: '权限服务不可用，当前权限未改变。', format: 'plain' })
    }

    let partialTargets: Partial<PermissionPresetTargets>
    try {
      partialTargets = permissionPresetTargets(permissionPresets)
    } catch {
      if (recovery !== undefined) return retryPermissionRecovery(recovery)
      return reply({ text: '权限服务不可用，无法安全解析权限组合；当前权限未改变。', format: 'plain' })
    }
    if (recovery === undefined) {
      const afterResolutionAuthorization = checkController()
      if (afterResolutionAuthorization !== 'authorized') return authorizationFailure(afterResolutionAuthorization)
    }
    const missingBundle = missingPermissionBundle(partialTargets)
    if (missingBundle !== undefined) {
      if (recovery !== undefined) return retryPermissionRecovery(recovery)
      return reply({ text: `权限配置缺少 ${missingBundle} 组合，已拒绝切换。`, format: 'plain' })
    }
    const targets = partialTargets as PermissionPresetTargets

    const selected = agentSelection(toModelRoute(this.options.getModelSelection(envelope.conversation)
      ?? { provider: this.options.provider, model: this.options.model }))
    let handle: AgentHandle | undefined
    let mutationAttempted = false
    let compensateToAsk: (() => Promise<boolean>) | undefined
    try {
      const agentPresets = this.options.getAgentPresets()
      const presetId = agentPresets === undefined
        ? binding.agentPreset
        : (await agentPresets.resolve(binding.agentPreset)).id
      signal.throwIfAborted()
      await requireWorkspace(binding.workspace)
      signal.throwIfAborted()
      handle = await agents.resume({
        resumeSessionId: SessionId(binding.sessionId),
        signal,
        agentOptions: {
          provider: selected.provider,
          model: selected.model,
          maxTokens: this.options.maxOutputTokens,
        },
        setup: async agentCtx => {
          await this.setupAgent(
            agentCtx,
            binding.workspace,
            presetId,
            externalPrincipalId(binding.principal),
            selected,
            agentPresets,
          )
        },
      })
      signal.throwIfAborted()
      if (recovery === undefined) {
        const afterResumeAuthorization = checkController()
        if (afterResumeAuthorization !== 'authorized') return authorizationFailure(afterResumeAuthorization)
      }

      const agent = handle.agent
      const session = agent.session
      await this.reconcileNativeFullPermissionReviewer(session)
      compensateToAsk = async (): Promise<boolean> => {
        // Try the bundle first for its audit marker, then independently force
        // both execution knobs through their canonical writers. This remains
        // fail-closed even when a preset observer throws partway through.
        // Every operation is best-effort because the original mutation has
        // already become ambiguous.
        try {
          permissionPresets.set(session, targets.ask)
        } catch {}
        try {
          ensureSandboxMode(session, 'workspace-write')
        } catch {}
        try {
          ensureApprovalPolicy(session, 'ask')
        } catch {}
        let reviewerReady = true
        try {
          await ensurePermissionReviewer(session, targets.ask, 'user')
        } catch {
          reviewerReady = false
        }
        try {
          const flushed = await sessions.flush(session)
          return reviewerReady
            && flushed
            && currentPermissionLevel(permissionPresets, targets, session.events) === 'ask'
        } catch {
          return false
        }
      }
      const recoveryReply = (
        input: ModelCommandReply,
        mode: PermissionDispatchRecovery,
      ): InboundProcessResult => {
        if (!authorizeTerminalReply()) return retryPermissionRecovery(mode)
        return preservePermissionRecovery(reply(input, true), mode)
      }
      const reportPermissionFailure = (safeAskPersisted: boolean): InboundProcessResult => {
        if (!safeAskPersisted) return retryPermissionRecovery('failure-notice')
        return preservePermissionRecovery(reply({
          text: '权限切换失败；已安全恢复并持久化为请求批准（ask）。请重新发送 /permissions 核对。',
          format: 'plain',
        }, true), 'failure-notice')
      }
      const reportCommittedReplyFailure = (safeAskPersisted: boolean): InboundProcessResult => {
        if (!safeAskPersisted) return retryPermissionRecovery('failure-notice')
        const authorization = checkController()
        if (authorization !== 'authorized') return retryPermissionRecovery('failure-notice')
        signal.throwIfAborted()
        try {
          this.options.replyCommand(binding, envelope.eventId, {
            text: '权限切换的成功回复入队失败；为避免静默保留新权限，已安全恢复并持久化为请求批准（ask）。请重新发送 /permissions 核对。',
            format: 'plain',
          }, `inbound:${envelope.eventId}:reply`)
          return { outcome: 'processed' }
        } catch {
          return retryPermissionRecovery('failure-notice')
        }
      }
      if (recovery === 'cancelled' || recovery === 'failure-notice') {
        mutationAttempted = true
        const safeAskPersisted = await compensateToAsk()
        signal.throwIfAborted()
        if (!safeAskPersisted) return retryPermissionRecovery(recovery)
        return recoveryReply({
          text: recovery === 'cancelled'
            ? '权限切换已停止；已安全恢复并持久化为请求批准（ask）。'
            : '权限切换未完成；已安全恢复并持久化为请求批准（ask）。请重新发送 /permissions 核对。',
          format: 'plain',
        }, recovery)
      }
      if (recovery === 'commit' && action.kind !== 'switch') {
        mutationAttempted = true
        const safeAskPersisted = await compensateToAsk()
        signal.throwIfAborted()
        if (!safeAskPersisted) return retryPermissionRecovery('commit')
        return recoveryReply({
          text: '权限恢复记录无效；已安全保持并持久化为请求批准（ask）。请重新选择。',
          format: 'plain',
        }, 'commit')
      }
      if (action.kind === 'invalid' || action.kind === 'warn-full') {
        return retryPermissionRecovery(recovery ?? 'failure-notice')
      }
      const currentStateHash = permissionStateHash(session.events, targets.tableFingerprint)
      const beforeLevel = currentPermissionLevel(permissionPresets, targets, session.events)
      const recoveredCommittedTarget = recovery === 'commit'
        && action.kind === 'switch'
        && beforeLevel === action.level
      if (recovery === 'commit' && action.kind === 'switch') {
        if (recoveredCommittedTarget) {
          if (!authorizeTerminalReply()) {
            mutationAttempted = true
            await compensateToAsk()
            signal.throwIfAborted()
            return retryPermissionRecovery('commit')
          }
          const recoveredReply = reply({
            text: `已恢复确认：当前为 ${permissionLevelLabel(beforeLevel)}。`,
            format: 'plain',
          }, true)
          if (recoveredReply.outcome === 'processed') return recoveredReply
          mutationAttempted = true
          await compensateToAsk()
          signal.throwIfAborted()
          return retryPermissionRecovery('commit')
        }
        // The dispatch fence may have been written before the first permission
        // event. Only an already-durable target proves that replay is a
        // terminal reconciliation. Otherwise converge to ask; never recreate
        // a possibly cancelled elevation from the original command text. This
        // recovery decision deliberately precedes picker TTL/state checks:
        // stale callback metadata must not strand a partial permission state.
        mutationAttempted = true
        const safeAskPersisted = await compensateToAsk()
        signal.throwIfAborted()
        if (!safeAskPersisted) return retryPermissionRecovery('commit')
        return recoveryReply({
          text: '权限切换在确认持久化前中断；已安全保持并持久化为请求批准（ask）。请重新选择。',
          format: 'plain',
        }, 'commit')
      }
      if (pickerGuard !== undefined && !recoveredCommittedTarget
        && currentStateHash !== pickerGuard.expectedStateHash) {
        return reply({ text: '权限卡片已过期或状态已变化；当前权限未改变。请重新发送 /permissions。', format: 'plain' })
      }
      if (action.kind === 'show') {
        const level = currentPermissionLevel(permissionPresets, targets, session.events)
        const emergencyStop = this.policy.getEmergencyStop()
        if (emergencyStop.enabled) return authorizationFailure('revoked')
        const issuedAt = Date.now()
        const picker: PermissionPickerIntent | undefined = envelope.conversation.kind !== 'dm'
          ? undefined
          : {
              operationId: permissionPickerOperationId(envelope.conversation, envelope.eventId),
              issuedAt,
              expiresAt: issuedAt + this.options.permissionPickerTtlMs,
              current: level,
              expectedStateHash: permissionStateHash(session.events, targets.tableFingerprint),
              emergencyStopVersion: emergencyStop.version,
              bindingVersion: binding.version,
              sessionId: binding.sessionId,
            }
        return reply(permissionOverview(level, picker))
      }

      if (pickerGuard !== undefined && !recoveredCommittedTarget && Date.now() >= pickerGuard.expiresAt) {
        return reply({ text: '权限卡片已过期；当前权限未改变。请重新发送 /permissions。', format: 'plain' })
      }
      const beforeMutationAuthorization = checkController()
      if (beforeMutationAuthorization !== 'authorized') return authorizationFailure(beforeMutationAuthorization)
      markPermissionDispatch()
      signal.throwIfAborted()
      const fencedAuthorization = checkController()
      if (fencedAuthorization !== 'authorized') return authorizationFailure(fencedAuthorization)
      const emergencyFence = checkEmergencyStopVersion(pickerGuard?.emergencyStopVersion)
      if (emergencyFence !== 'authorized') return authorizationFailure(emergencyFence)
      // A callback can enter the durable Inbox just before its deadline and
      // then wait on workspace/preset/session I/O. Recheck at the final fence,
      // immediately before any permission event is appended.
      if (pickerGuard !== undefined && Date.now() >= pickerGuard.expiresAt) {
        return reply({ text: '权限卡片已过期；当前权限未改变。请重新发送 /permissions。', format: 'plain' })
      }
      mutationAttempted = true
      if (action.level === 'full') {
        // Close approval before widening the sandbox. Canonical full derives
        // reviewer=none from its official preset; legacy dynamic bundles add
        // their compatibility reviewer only after both execution knobs match.
        ensureApprovalPolicy(session, 'never')
        permissionPresets.set(session, targets.full)
        // Preset setters intentionally omit overrides that equal deployment
        // defaults. Persist the exact execution facts anyway so full access
        // cannot depend on an implicit default or a future default change.
        ensureSandboxMode(session, 'danger-full-access')
        await ensurePermissionReviewer(session, targets.full, 'none')
      } else {
        // Confinement comes first when leaving full access. The preset setter
        // writes sandbox before approval; only then may the reviewer be enabled.
        const target = action.level === 'auto' ? targets.auto : targets.ask
        permissionPresets.set(session, target)
        // Legacy/seeded sessions may have no explicit knob events even when
        // their effective defaults match this preset. Materialize both facts
        // before enabling either reviewer so auto is a coherent, replayable
        // ask + workspace-write state rather than an inference from defaults.
        ensureSandboxMode(session, 'workspace-write')
        ensureApprovalPolicy(session, 'ask')
        const reviewer: ApprovalReviewer = action.level === 'auto' ? 'auto-review' : 'user'
        await ensurePermissionReviewer(session, target, reviewer)
      }
      const afterReviewerEmergencyFence = checkEmergencyStopVersion(pickerGuard?.emergencyStopVersion)
      if (afterReviewerEmergencyFence !== 'authorized') {
        await compensateToAsk()
        signal.throwIfAborted()
        return retryPermissionRecovery('failure-notice')
      }
      const flushed = await sessions.flush(session)
      signal.throwIfAborted()
      if (!flushed) {
        const safeAskPersisted = await compensateToAsk()
        signal.throwIfAborted()
        return reportPermissionFailure(safeAskPersisted)
      }
      const finalAuthorization = checkController()
      const finalEmergencyFence = checkEmergencyStopVersion(pickerGuard?.emergencyStopVersion)
      if (finalAuthorization !== 'authorized' || finalEmergencyFence !== 'authorized') {
        await compensateToAsk()
        signal.throwIfAborted()
        return retryPermissionRecovery('failure-notice')
      }
      const afterLevel = currentPermissionLevel(permissionPresets, targets, session.events)
      if (afterLevel !== action.level) {
        const safeAskPersisted = await compensateToAsk()
        signal.throwIfAborted()
        return reportPermissionFailure(safeAskPersisted)
      }
      const successReply = reply({
        text: beforeLevel === afterLevel
          ? `当前已是 ${permissionLevelLabel(afterLevel)}。`
          : `已切换到 ${permissionLevelLabel(afterLevel)}。`,
        format: 'plain',
      }, true)
      if (successReply.outcome === 'processed') return successReply
      const safeAskPersisted = await compensateToAsk()
      signal.throwIfAborted()
      return reportCommittedReplyFailure(safeAskPersisted)
    } catch (error) {
      if (recovery !== undefined) {
        if (mutationAttempted) await compensateToAsk?.()
        return retryPermissionRecovery(recovery)
      }
      if (mutationAttempted) {
        const safeAskPersisted = await compensateToAsk?.() ?? false
        if (signal.aborted || causedByUserCancellation(error)) {
          return {
            outcome: 'not-processed',
            failureCode: permissionDispatchRecoveryCode('cancelled'),
            retryable: true,
          }
        }
        if (errorChainHasName(error, 'ApprovalReviewerReaderUnavailableError')) {
          return retryPermissionRecovery('failure-notice')
        }
        if (!safeAskPersisted) return retryPermissionRecovery('failure-notice')
        return preservePermissionRecovery(reply({
          text: '权限切换失败；已安全恢复并持久化为请求批准（ask）。请重新发送 /permissions 核对。',
          format: 'plain',
        }, true), 'failure-notice')
      }
      if (signal.aborted) throw error
      if (errorChainHasName(error, 'ApprovalReviewerReaderUnavailableError')) {
        return {
          outcome: 'not-processed',
          failureCode: 'permission-reviewer-reader-unavailable',
          retryable: true,
        }
      }
      const finalAuthorization = checkController()
      if (finalAuthorization !== 'authorized') return authorizationFailure(finalAuthorization)
      if (causedByDurableIdentity(error)) {
        return { outcome: 'not-processed', failureCode: 'permission-session-mismatch', retryable: false }
      }
      return reply({
        text: '权限命令未完成；当前权限保持或收紧，未确认任何权限提升。',
        format: 'plain',
      })
    } finally {
      await this.disposeAfterReplyBoundary(binding.sessionId, handle)
    }
  }

  async createSession(input: {
    envelope: Readonly<InboundEnvelope>
    generation: number
    previous?: Readonly<ConversationBinding>
    signal: AbortSignal
  }): Promise<{ sessionId: string; workspace: string; agentPreset: string; policyRef: string }> {
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    if (agents === undefined || sessions === undefined) throw new Error('assistant-delivery: agents and sessions services are required')
    const id = sessionId(this.options.sessionNamespace, input.envelope.conversation, input.generation)
    const workspace = input.previous?.workspace ?? this.options.workspace
    const requestedPreset = input.previous?.agentPreset ?? this.options.agentPreset
    const agentPresets = this.options.getAgentPresets()
    const presetId = agentPresets === undefined
      ? requestedPreset
      : (await agentPresets.resolve(requestedPreset)).id
    await ensureWorkspace(workspace)
    const selected = agentSelection(toModelRoute(this.options.getModelSelection(input.envelope.conversation)
      ?? { provider: this.options.provider, model: this.options.model }))
    const setup = async (agentCtx: Agent['ctx']): Promise<void> => {
      await this.setupAgent(
        agentCtx,
        workspace,
        presetId,
        externalPrincipalId(input.envelope.principal),
        selected,
        agentPresets,
      )
    }
    let handle: AgentHandle | undefined
    let adopted = false
    try {
      const agentOptions = {
        provider: selected.provider,
        model: selected.model,
        maxTokens: this.options.maxOutputTokens,
      }
      const persistence = this.ctx.get('sessionPersistence') as undefined | {
        list(signal?: AbortSignal): Promise<readonly { id: SessionId }[]>
      }
      const persisted = persistence === undefined
        ? false
        : (await persistence.list(input.signal)).some(header => String(header.id) === String(id))
      if (persisted) {
        handle = await agents.resume({
          resumeSessionId: id,
          agentOptions,
          signal: input.signal,
          setup,
        })
        adopted = true
      }
      if (handle === undefined) {
        handle = await agents.create({
          sessionId: id,
          meta: { cwd: workspace, agentPreset: presetId },
          agentOptions,
          signal: input.signal,
          setup,
        })
      }
      const session = handle.agent.session
      if (adopted) assertAdoptableUnstartedSession(session, workspace, presetId)
      await this.reconcileNativeFullPermissionReviewer(session)
      if (!await sessions.flush(session)) {
        throw new Error('assistant-delivery: newly created Agent session was not durable')
      }
      return { sessionId: String(id), workspace, agentPreset: presetId,
        policyRef: input.previous?.policyRef ?? this.options.policyRef }
    } finally {
      await handle?.dispose()
    }
  }

  async prepare(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    signal: AbortSignal,
    context: Readonly<InboundPrepareContext>,
  ): Promise<InboundPrepareResult> {
    const imageCount = (envelope.attachments ?? [])
      .filter(attachment => attachment.resourceType === 'image').length
    if (envelope.kind === 'command') {
      return { outcome: 'prepared', message: {
        imageAttachments: [],
        ...(context.permissionDispatchRecovery === undefined
          ? {}
          : { permissionDispatchRecovery: context.permissionDispatchRecovery }),
      } }
    }
    const selected = toModelRoute(this.options.getModelSelection(envelope.conversation)
      ?? { provider: this.options.provider, model: this.options.model })
    if (imageCount === 0) {
      return { outcome: 'prepared', message: { imageAttachments: [], modelRoute: selected } }
    }
    if (!this.options.isInboundAuthorized(binding, envelope)) {
      return { outcome: 'not-processed', failureCode: 'image-authorization-revoked', retryable: false }
    }

    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      return { outcome: 'not-processed', failureCode: 'model-directory-unavailable', retryable: true }
    }
    try {
      await requireImageCapability(llm, selected.provider, selected.model, signal)
    } catch (error) {
      if (signal.aborted) throw error
      if (!(error instanceof ImageCapabilityAdmissionError)) {
        return { outcome: 'not-processed', failureCode: 'image-model-unavailable', retryable: true }
      }
      try {
        this.options.replyCommand(binding, envelope.eventId, imageCapabilityReply(error))
      } catch {
        return { outcome: 'not-processed', failureCode: 'image-capability-notice-failed', retryable: true }
      }
      return { outcome: 'not-processed', failureCode: 'model-image-input-unsupported', retryable: false }
    }

    const result = await this.options.imageMaterializer.materialize({
      ...context,
      binding,
      envelope,
      signal,
    })
    return result.outcome === 'ready'
      ? { outcome: 'prepared', message: { imageAttachments: result.imageAttachments, modelRoute: selected } }
      : { outcome: 'not-processed', failureCode: result.failureCode, retryable: result.retryable,
          ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) }
  }

  private replySessionCommand(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    reply: ModelCommandReply,
    signal: AbortSignal,
    markDispatching: MarkInboundDispatching | undefined,
  ): InboundProcessResult {
    if (markDispatching === undefined) {
      return { outcome: 'not-processed', failureCode: 'dispatch-gate-unavailable', retryable: true }
    }
    signal.throwIfAborted()
    markDispatching()
    signal.throwIfAborted()
    this.options.replyCommand(binding, envelope.eventId, reply)
    return { outcome: 'processed' }
  }

  private async runFeedbackCommand(
    command: ParsedDeliveryCommand,
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    signal: AbortSignal,
    markDispatching: MarkInboundDispatching | undefined,
  ): Promise<InboundProcessResult> {
    const parsed = parseFeedbackCommand(command.rawInput)
    if (parsed.kind === 'invalid') {
      return this.replySessionCommand(binding, envelope, {
        text: feedbackUsage,
        format: 'plain',
      }, signal, markDispatching)
    }
    if ((envelope.attachments?.length ?? 0) > 0) {
      return this.replySessionCommand(binding, envelope, {
        text: '反馈命令不接受文件、图片或其他附件；本次反馈未记录。请只发送 /feedback 文字命令。',
        format: 'plain',
      }, signal, markDispatching)
    }
    let authorized: boolean
    try {
      authorized = this.options.isOwnerFeedbackController(binding, envelope)
    } catch {
      return {
        outcome: 'not-processed',
        failureCode: 'feedback-authorization-check-failed',
        retryable: true,
      }
    }
    if (!authorized) {
      return this.replySessionCommand(binding, envelope, {
        text: '当前身份不能提交偏好反馈；本次反馈未记录。',
        format: 'plain',
      }, signal, markDispatching)
    }
    if (markDispatching === undefined) {
      return { outcome: 'not-processed', failureCode: 'dispatch-gate-unavailable', retryable: true }
    }
    signal.throwIfAborted()
    markDispatching()
    signal.throwIfAborted()

    // The dispatch fence proves the exact Inbox/binding snapshot. Recheck the
    // mutable owner and consume an audited preference-signal authorization
    // immediately before the authoritative sink receives the batch.
    let attestation: { occurredAt: number } | undefined
    try {
      attestation = this.options.authorizeOwnerPreferenceFeedback(
        binding,
        envelope,
        parsed.selections,
      )
    } catch {
      return {
        outcome: 'not-processed',
        failureCode: 'feedback-authorization-check-failed-after-dispatch',
        retryable: false,
      }
    }
    if (attestation === undefined) {
      return {
        outcome: 'not-processed',
        failureCode: 'feedback-authorization-revoked',
        retryable: false,
      }
    }

    const events = parsed.selections.map(selection => feedbackSignalInput(
      binding,
      envelope,
      selection,
      attestation.occurredAt,
    ))
    const result = await this.options.dispatchPreferenceFeedback(Object.freeze(events))
    signal.throwIfAborted()
    if (result === 'unavailable') {
      this.options.replyCommand(binding, envelope.eventId, {
        text: '偏好学习服务尚未启用；本次反馈未记录。请联系管理员安装或启用 preference-learning。',
        format: 'plain',
      })
      return { outcome: 'processed' }
    }
    if (result === 'unknown') {
      this.options.replyCommand(binding, envelope.eventId, {
        text: '反馈记录状态未知；请不要为同一回答重复提交。系统只会在收到匹配的持久回执后确认成功。',
        format: 'plain',
      })
      return { outcome: 'processed' }
    }
    signal.throwIfAborted()
    this.options.replyCommand(binding, envelope.eventId, {
      text: parsed.selections.length === 1
        ? '已记录反馈。它只作用于当前工作区与 preset。'
        : '已记录反馈及对应的回复长度偏好。它们只作用于当前工作区与 preset。',
      format: 'plain',
    })
    return { outcome: 'processed' }
  }

  private sessionHelp(native: readonly CommandDescriptor[]): string {
    const lines = [
      '会话命令：',
      '- /new（/clear）：开始空白新会话；旧会话保留。',
      '- /stop：停止当前任务；当前会话与已完成上下文保留。',
      '- /status（/session）：查看当前 session、上下文与模型。',
      '- /model：查看或切换模型；上下文保留。',
      '- /permission：查看或切换运行权限。',
      '- /feedback：提交结构化反馈或低风险回复偏好；不进入模型。',
      '- /help：显示当前实际可用命令。',
    ]
    const visible = native.filter(command => SAFE_NATIVE_COMMANDS.has(command.name))
    if (visible.length > 0) {
      lines.push('', 'DSH / 当前 preset 命令：')
      for (const command of visible) lines.push(`- /${command.name}：${command.description}`)
    }
    return lines.join('\n')
  }

  private async runSessionCommand(
    command: ParsedDeliveryCommand,
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    signal: AbortSignal,
    markDispatching: MarkInboundDispatching | undefined,
  ): Promise<InboundProcessResult> {
    const args = command.rawInput.trim()
    const local = new Set(['clear', 'help', 'new', 'session', 'status', 'stop'])
    if (local.has(command.name) && args !== '') {
      return this.replySessionCommand(binding, envelope, {
        text: `/${command.name} 不接受参数。发送 /help 查看用法。`,
        format: 'plain',
      }, signal, markDispatching)
    }
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    if (agents === undefined || sessions === undefined) {
      return { outcome: 'not-processed', failureCode: 'agent-runtime-unavailable', retryable: true }
    }
    const selectedRoute = toModelRoute(this.options.getModelSelection(envelope.conversation)
      ?? { provider: this.options.provider, model: this.options.model })
    const selected = agentSelection(selectedRoute)
    let handle: AgentHandle | undefined
    let resumed = false
    let nativeDispatchStarted = false
    const authorizationFailure = (): InboundNotProcessedResult | undefined => {
      try {
        return this.options.isInboundAuthorized(binding, envelope)
          ? undefined
          : { outcome: 'not-processed', failureCode: 'inbound-authorization-revoked', retryable: false }
      } catch {
        return { outcome: 'not-processed', failureCode: 'inbound-authorization-check-failed', retryable: true }
      }
    }
    try {
      const agentPresets = this.options.getAgentPresets()
      const presetId = agentPresets === undefined
        ? binding.agentPreset
        : (await agentPresets.resolve(binding.agentPreset)).id
      await requireWorkspace(binding.workspace)
      handle = await agents.resume({
        resumeSessionId: SessionId(binding.sessionId),
        signal,
        agentOptions: {
          provider: selected.provider,
          model: selected.model,
          maxTokens: this.options.maxOutputTokens,
        },
        setup: async agentCtx => {
          await this.setupAgent(
            agentCtx,
            binding.workspace,
            presetId,
            externalPrincipalId(binding.principal),
            selected,
            agentPresets,
          )
        },
      })
      resumed = true
      signal.throwIfAborted()
      const agent = handle.agent
      const commands = this.ctx.get('commands') as CommandRuntime | undefined
      const native = commands?.list(agent) ?? []
      const revoked = authorizationFailure()
      if (revoked !== undefined) return revoked
      if (command.name === 'help') {
        return this.replySessionCommand(binding, envelope, {
          text: this.sessionHelp(native),
          format: 'plain',
        }, signal, markDispatching)
      }
      if (command.name === 'status' || command.name === 'session') {
        const messages = agent.session.deriveMessages().length
        const turns = agent.session.events.filter(event => event.type === 'turn/end').length
        return this.replySessionCommand(binding, envelope, {
          text: [
            '当前会话',
            `- 第 ${binding.generation} 代（${sessionFingerprint(binding.sessionId)}）`,
            `- 状态：${agent.status === 'idle' ? '空闲' : '运行中'}`,
            `- 上下文消息：${messages}`,
            `- 已记录轮次：${turns}`,
            `- 模型：${routeLabel(selectedRoute)}`,
            '',
            '/new 会开始空白新 session 并保留旧会话；/stop 只停止当前任务，不清空上下文。',
          ].join('\n'),
          format: 'plain',
        }, signal, markDispatching)
      }
      const descriptor = SAFE_NATIVE_COMMANDS.has(command.name)
        ? native.find(candidate => candidate.name === command.name)
        : undefined
      if (commands === undefined || descriptor === undefined) {
        return this.replySessionCommand(binding, envelope, {
          text: `未知命令 /${command.name}。发送 /help 查看当前实际可用命令。`,
          format: 'plain',
        }, signal, markDispatching)
      }
      if ((envelope.attachments?.length ?? 0) > 0) {
        return this.replySessionCommand(binding, envelope, {
          text: `当前渠道暂不支持为 /${command.name} 附带文件或图片。`,
          format: 'plain',
        }, signal, markDispatching)
      }
      if (markDispatching === undefined) {
        return { outcome: 'not-processed', failureCode: 'dispatch-gate-unavailable', retryable: true }
      }
      signal.throwIfAborted()
      const preExecutionAuthorization = authorizationFailure()
      if (preExecutionAuthorization !== undefined) return preExecutionAuthorization
      markDispatching()
      nativeDispatchStarted = true
      const execution = await commands.execute(agent, envelope.text, [], signal)
      signal.throwIfAborted()
      if (execution === undefined) {
        return {
          outcome: 'not-processed',
          failureCode: 'native-command-unresolved-after-dispatch',
          retryable: false,
        }
      }
      if (!await sessions.flush(agent.session)) {
        return {
          outcome: 'not-processed',
          failureCode: 'command-session-flush-failed',
          retryable: false,
        }
      }
      signal.throwIfAborted()
      const finalAuthorization = authorizationFailure()
      if (finalAuthorization !== undefined) return { ...finalAuthorization, retryable: false }
      const result = execution.result
      this.options.replyCommand(binding, envelope.eventId, {
        text: result?.text ?? (result?.kind === 'error'
          ? `/${command.name} 未完成。`
          : `/${command.name} 已完成。`),
        format: 'plain',
      })
      return { outcome: 'processed' }
    } catch (error) {
      if (signal.aborted || causedByUserCancellation(error)) throw error
      if (nativeDispatchStarted) {
        this.ctx.logger.warn(
          `assistant-delivery: native command /${command.name} became ambiguous for session `
          + sessionFingerprint(binding.sessionId),
        )
        return {
          outcome: 'not-processed',
          failureCode: 'native-command-execution-ambiguous',
          retryable: false,
        }
      }
      if (resumed) {
        return {
          outcome: 'not-processed',
          failureCode: 'session-command-runtime-failed',
          retryable: true,
        }
      }
      const failureCode = sessionResumeFailureCode(error)
      this.ctx.logger.warn(
        `assistant-delivery: ${failureCode} for session ${sessionFingerprint(binding.sessionId)}`,
      )
      try {
        return this.replySessionCommand(binding, envelope, {
          text: [
            '当前会话暂时无法恢复；原历史未删除。',
            `- 会话：第 ${binding.generation} 代（${sessionFingerprint(binding.sessionId)}）`,
            `- 诊断：${failureCode}`,
            '',
            '请先修复或升级对应 DSH 插件后重试；也可发送 /new 开始空白新会话，旧会话仍会保留。',
          ].join('\n'),
          format: 'plain',
        }, signal, markDispatching)
      } catch {
        return {
          outcome: 'not-processed',
          failureCode: 'session-diagnostic-reply-failed',
          retryable: failureCode !== 'agent-identity-mismatch' && failureCode !== 'session-persistence-corrupt',
        }
      }
    } finally {
      await this.disposeAfterReplyBoundary(binding.sessionId, handle)
    }
  }

  async process(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    outerSignal: AbortSignal,
    prepared?: Readonly<PreparedInboundMessage>,
    markDispatching?: MarkInboundDispatching,
  ): Promise<InboundProcessResult> {
    const sessionCommand = parseDeliveryCommand(envelope)
    if (envelope.kind === 'command' && sessionCommand === undefined) {
      return this.replySessionCommand(binding, envelope, {
        text: '命令格式无效。命令必须以小写 /name 开头，并使用普通空格分隔参数；发送 /help 查看用法。',
        format: 'plain',
      }, outerSignal, markDispatching)
    }
    if (isExactDeliveryCommand(sessionCommand, 'new', 'clear')) {
      return this.replySessionCommand(binding, envelope, {
        text: `已开始新会话（第 ${binding.generation} 代，${sessionFingerprint(binding.sessionId)}）；`
          + '旧会话已保留。新 session 的对话上下文为空。',
        format: 'plain',
      }, outerSignal, markDispatching)
    }
    if (isExactDeliveryCommand(sessionCommand, 'stop')) {
      return this.replySessionCommand(binding, envelope, {
        text: '已处理停止请求；当前 session 与已完成上下文保留。',
        format: 'plain',
      }, outerSignal, markDispatching)
    }
    const control = this.beginSessionControl(binding.sessionId, outerSignal)
    try {
      return await this.processControlled(
        binding,
        envelope,
        control.controller.signal,
        sessionCommand,
        prepared,
        markDispatching,
      )
    } catch (error) {
      if (control.command !== undefined && causedByUserCancellation(error)) {
        return permissionCommand(sessionCommand) === undefined
          ? { outcome: 'processed' }
          : {
              outcome: 'not-processed',
              failureCode: permissionDispatchRecoveryCode('cancelled'),
              retryable: true,
            }
      }
      throw error
    } finally {
      this.endSessionControl(binding.sessionId, control)
    }
  }

  private async processControlled(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    signal: AbortSignal,
    sessionCommand: ParsedDeliveryCommand | undefined,
    prepared?: Readonly<PreparedInboundMessage>,
    markDispatching?: MarkInboundDispatching,
  ): Promise<InboundProcessResult> {
    if (sessionCommand?.name === 'feedback') {
      return await this.runFeedbackCommand(
        sessionCommand,
        binding,
        envelope,
        signal,
        markDispatching,
      )
    }
    const permissions = permissionCommand(sessionCommand)
    if (permissions !== undefined) {
      if (markDispatching === undefined) {
        return { outcome: 'not-processed', failureCode: 'dispatch-gate-unavailable', retryable: true }
      }
      return await this.runPermissionCommand(
        permissions,
        binding,
        envelope,
        signal,
        markDispatching,
        prepared?.permissionDispatchRecovery,
      )
    }
    const command = modelCommand(sessionCommand)
    if (command !== undefined) {
      const llm = this.ctx.get('llm')
      if (llm === undefined) {
        return { outcome: 'not-processed', failureCode: 'model-directory-unavailable', retryable: true }
      }
      let reply: ModelCommandReply | undefined
      try {
        reply = await runModelCommand(command, llm, envelope.conversation, {
          provider: this.options.provider,
          model: this.options.model,
        }, this.options, signal, envelope.eventId)
        this.options.replyCommand(binding, envelope.eventId, reply)
        return { outcome: 'processed' }
      } catch (error) {
        if (signal.aborted || causedByUserCancellation(error)) throw error
        if (reply?.format === 'model-picker' && reply.fallbackText !== undefined
          && error instanceof DeliveryStoreError
          && (error.code === 'invalid-intent' || error.code === 'invalid-binding')) {
          try {
            this.options.replyCommand(binding, envelope.eventId, { text: reply.fallbackText, format: 'plain' })
            return { outcome: 'processed' }
          } catch (fallbackError) {
            return modelCommandFailure(fallbackError)
          }
        }
        return modelCommandFailure(error)
      }
    }
    if (sessionCommand !== undefined) {
      return await this.runSessionCommand(sessionCommand, binding, envelope, signal, markDispatching)
    }
    const imageDescriptorCount = (envelope.attachments ?? [])
      .filter(attachment => attachment.resourceType === 'image').length
    const imageAttachments = prepared?.imageAttachments ?? []
    const checkAuthorization = (): InboundAuthorizationState => {
      try {
        return this.options.isInboundAuthorized(binding, envelope) ? 'authorized' : 'revoked'
      } catch {
        return 'check-failed'
      }
    }
    const preDispatchAuthorizationFailure = (): InboundProcessResult | undefined => {
      const authorization = checkAuthorization()
      if (authorization === 'authorized') return undefined
      return authorization === 'revoked'
        ? { outcome: 'not-processed', failureCode: 'inbound-authorization-revoked', retryable: false }
        : { outcome: 'not-processed', failureCode: 'inbound-authorization-check-failed', retryable: true }
    }
    if (imageAttachments.length !== imageDescriptorCount
      || (imageDescriptorCount > 0 && prepared?.modelRoute === undefined)) {
      return { outcome: 'not-processed', failureCode: 'image-preparation-missing', retryable: false }
    }
    if (imageDescriptorCount > 0) {
      const authorizationFailure = preDispatchAuthorizationFailure()
      if (authorizationFailure !== undefined) return authorizationFailure
    }
    const content: ContentBlock[] = [
      ...(envelope.text === '' ? [] : [{ type: 'text' as const, text: envelope.text }]),
      ...imageAttachments.map(attachment => ({ type: 'image' as const, attachment })),
    ]
    if (content.length === 0) {
      return { outcome: 'not-processed', failureCode: 'inbound-content-empty', retryable: false }
    }
    if (markDispatching === undefined) {
      return { outcome: 'not-processed', failureCode: 'dispatch-gate-unavailable', retryable: true }
    }
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    if (agents === undefined || sessions === undefined) {
      return { outcome: 'not-processed', failureCode: 'agent-runtime-unavailable', retryable: true }
    }
    const persistedSelection = this.options.getModelSelection(envelope.conversation)
    const requestedRoute = toModelRoute(persistedSelection
      ?? prepared?.modelRoute
      ?? { provider: this.options.provider, model: this.options.model })
    const resolvedRoute = await this.resolveExecutionRoute(
      envelope.conversation,
      persistedSelection,
      requestedRoute,
      signal,
    )
    if ('retry' in resolvedRoute) {
      return { outcome: 'not-processed', failureCode: 'model-selection-changed-before-dispatch', retryable: true }
    }
    const selectedRoute = resolvedRoute.route
    const selected = agentSelection(selectedRoute)
    let handle: AgentHandle | undefined
    let dispatched = false
    let removeAbort: (() => void) | undefined
    let removeProgress: (() => void) | undefined
    let progressOpen = true
    let progressQueue = Promise.resolve()
    const publishProgress = (update: DeliveryProgressUpdate): void => {
      if (!progressOpen) return
      progressQueue = progressQueue
        .then(async () => {
          if (checkAuthorization() !== 'authorized') return
          await this.options.progress(binding, envelope.eventId, update)
        })
        // Progress is presentation-only: its provider failure must never retry an Agent turn.
        .catch(() => {})
    }
    try {
      const agentPresets = this.options.getAgentPresets()
      const presetId = agentPresets === undefined
        ? binding.agentPreset
        : (await agentPresets.resolve(binding.agentPreset)).id
      await requireWorkspace(binding.workspace)
      handle = await agents.resume({ resumeSessionId: SessionId(binding.sessionId), signal,
        agentOptions: { provider: selected.provider, model: selected.model,
          maxTokens: this.options.maxOutputTokens },
        setup: async agentCtx => {
          await this.setupAgent(
            agentCtx,
            binding.workspace,
            presetId,
            externalPrincipalId(binding.principal),
            selected,
            agentPresets,
          )
          const llm = this.ctx.get('llm')
          if (llm === undefined) throw new Error('assistant-delivery: llm service is required')
          requireAdapterToolCallProtocol(
            llm,
            selected.provider,
            selected.model,
            presetId,
            agentCtx.tools.schemas(agentCtx.agent).length,
          )
        } })
      const agent = handle.agent
      await this.reconcileNativeFullPermissionReviewer(agent.session)
      signal.throwIfAborted()
      const llm = this.ctx.get('llm')
      if (llm === undefined) throw new Error('assistant-delivery: llm service is required')
      if (agent.session.deriveMessages().some(message => contentHasImage(message.content))
        || imageAttachments.length > 0) {
        await requireImageCapability(llm, selected.provider, selected.model, signal)
      }
      if (imageDescriptorCount > 0) {
        const authorizationFailure = preDispatchAuthorizationFailure()
        if (authorizationFailure !== undefined) return authorizationFailure
      }
      const from = agent.session.events.length
      removeProgress = this.ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        const update = deliveryProgressFromSessionEvent(event)
        if (update !== undefined) publishProgress(update)
      })
      publishProgress({ kind: 'started' })
      const abort = () => {
        const command = this.activeSessionControls.get(binding.sessionId)?.command
        agent.cancel(command === undefined
          ? { kind: 'hook', reason: 'assistant-delivery-signal' }
          : { kind: 'user' })
      }
      signal.addEventListener('abort', abort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', abort)
      signal.throwIfAborted()
      const authorizationFailure = preDispatchAuthorizationFailure()
      if (authorizationFailure !== undefined) return authorizationFailure
      markDispatching()
      // Once the durable marker exists, even a synchronous followup failure is ambiguous:
      // implementations may enqueue before throwing, so no retry is safe.
      dispatched = true
      const message = createUserMessage({ content, source: {
        kind: 'delivery', channel: envelope.channel, account: envelope.account, eventId: envelope.eventId,
        trust: 'untrusted',
      } })
      const deliveryTurn = await this.followupTurn(agent, message)
      const output = finalAssistant(agent.session.events, from, deliveryTurn)
      if (!await sessions.flush(agent.session)) {
        publishProgress({ kind: 'failed', code: 'session-persistence-unavailable' })
        return { outcome: 'not-processed', failureCode: 'session-flush-failed', retryable: false }
      }
      const cancelled = this.activeSessionControls.get(binding.sessionId)?.command
      if (cancelled !== undefined || output.stopped) {
        publishProgress({ kind: 'failed', code: cancelled === 'new' ? 'new-session' : 'user-stopped' })
        return { outcome: 'processed' }
      }
      const finalAuthorization = checkAuthorization()
      if (finalAuthorization !== 'authorized') {
        return finalAuthorization === 'revoked'
          ? { outcome: 'not-processed', failureCode: 'inbound-authorization-revoked', retryable: false }
          : { outcome: 'not-processed', failureCode: 'inbound-authorization-check-failed', retryable: false }
      }
      if (!output.completed) {
        publishProgress({ kind: 'failed', ...(output.failureCode === undefined ? {} : { code: output.failureCode }) })
        return { outcome: 'not-processed', failureCode: 'agent-turn-incomplete', retryable: false }
      }
      // Agent answers are authored as Markdown (tables, bold, inline code), so request Markdown
      // rendering; sending them as plain text shows the raw `|---|` and `**` syntax to the user.
      if (output.text !== '') {
        this.options.reply(agent, envelope.eventId, { text: output.text, format: 'markdown' })
      }
      publishProgress({ kind: 'completed' })
      return { outcome: 'processed' }
    } catch (error) {
      if (causedByUserCancellation(error)) {
        if (handle !== undefined && !await sessions.flush(handle.agent.session)) {
          return { outcome: 'not-processed', failureCode: 'session-flush-failed', retryable: false }
        }
        const command = this.activeSessionControls.get(binding.sessionId)?.command
        publishProgress({ kind: 'failed', code: command === 'new' ? 'new-session' : 'user-stopped' })
        return { outcome: 'processed' }
      }
      if (dispatched) {
        publishProgress({ kind: 'failed' })
        throw new Error(`assistant-delivery: Agent turn became ambiguous: ${String(error)}`, { cause: error })
      }
      if (causedByDurableIdentity(error)) {
        return { outcome: 'not-processed', failureCode: 'agent-identity-mismatch', retryable: false }
      }
      if (error instanceof ImageCapabilityAdmissionError) {
        try {
          this.options.replyCommand(binding, envelope.eventId, imageCapabilityReply(error))
          return { outcome: 'processed' }
        } catch {
          return { outcome: 'not-processed', failureCode: 'image-capability-notice-failed', retryable: true }
        }
      }
      if (error instanceof AdapterToolCallProtocolError) {
        try {
          this.options.replyCommand(binding, envelope.eventId, adapterToolCallProtocolReply(error))
          return { outcome: 'processed' }
        } catch {
          return { outcome: 'not-processed', failureCode: 'adapter-tool-protocol-notice-failed', retryable: true }
        }
      }
      this.ctx.logger.warn(
        `assistant-delivery: ${sessionResumeFailureCode(error)} for session ${sessionFingerprint(binding.sessionId)}`,
      )
      return { outcome: 'not-processed', failureCode: 'agent-resume-failed', retryable: true }
    } finally {
      removeAbort?.()
      removeProgress?.()
      progressOpen = false
      await this.disposeAfterReplyBoundary(binding.sessionId, handle)
    }
  }
}
