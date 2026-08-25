import {
  CallId,
  offloadRequestImages,
  type ContentBlock,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 24 * 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024
const MAX_PROVIDER_ID_BYTES = 4 * 1024
const MAX_CALL_ID_BYTES = 4 * 1024
const MAX_TOOL_NAME_BYTES = 1024
const MAX_JSON_DEPTH = 64

type ImageBlock = Extract<ContentBlock, { type: 'image' }>
type ImageAttachmentRef = ImageBlock['attachment']

export interface CodexDirectImageReader {
  readImage(
    ref: ImageAttachmentRef,
    signal?: AbortSignal,
  ): Promise<{ readonly data: Uint8Array; readonly ref: ImageAttachmentRef }>
}

/** The sole authenticated capability accepted by this transport. */
export type CodexResponsesRequester = (body: string, signal: AbortSignal) => Promise<Response>

export interface CodexDirectResponsesDependencies {
  readonly request: CodexResponsesRequester
  readonly attachments?: CodexDirectImageReader
  /** Optional lifecycle signal; adapters normally also place it on `GenerateOptions.signal`. */
  readonly signal?: AbortSignal
  readonly maxRequestBytes?: number
  readonly maxRequestImageBytes?: number
  readonly maxResponseBytes?: number
  readonly maxSseEventBytes?: number
}

/** Auditable wire shape. Authentication and endpoint selection live outside this module. */
export interface CodexResponsesRequest {
  readonly model: string
  readonly instructions: string
  readonly input: readonly unknown[]
  readonly stream: true
  readonly store: false
  readonly include: readonly ['reasoning.encrypted_content']
  readonly tools?: readonly unknown[]
  readonly tool_choice: 'auto'
  readonly parallel_tool_calls: true
  readonly reasoning: Readonly<{ effort: string; summary: 'auto' }> | null
}

export class CodexDirectResponsesError extends Error {
  readonly status: number | undefined

  constructor(
    message: string,
    cause:
      | 'protocol'
      | 'prompt-limit'
      | 'subscription-auth'
      | 'provider-http'
      | 'provider-failure'
      | 'context-window'
      | 'quota'
      | 'content-filter'
      | 'empty-response',
    status?: number,
  ) {
    super(message, { cause })
    this.name = 'CodexDirectResponsesError'
    this.status = status
  }
}

interface ReplayResponse {
  readonly kind: 'codex-private-responses'
  readonly version: 2 | 3
  readonly provider: string
  readonly model: string
  readonly responseId: string
  readonly output: readonly unknown[]
  readonly blockOrder: readonly string[]
}

interface TextState {
  readonly key: string
  readonly kind: 'text' | 'reasoning'
  readonly index: number
  readonly itemId: string
  readonly outputIndex: number
  readonly partIndex: number
  readonly nativeType: 'output_text' | 'refusal' | 'summary_text'
  text: string
  closed: boolean
}

interface ToolState {
  readonly key: string
  readonly kind: 'tool-call'
  readonly index: number
  readonly itemId: string
  readonly outputIndex: number
  readonly callId: string
  readonly name: string
  arguments: string
  argumentsDone: boolean
  closed: boolean
}

type BlockState = TextState | ToolState

interface ItemState {
  /** Internal replay/block key; never written into the provider-native item. */
  readonly id: string
  providerId?: string
  readonly outputIndex: number
  readonly type: string
  readonly parts: Map<number, TextState['nativeType']>
  readonly addedParts: Set<number>
  streamedParts: boolean
  provisional: boolean
  doneItem?: Record<string, unknown>
}

interface NativeProjection {
  readonly blocks: ContentBlock[]
  readonly hiddenReasoning: boolean
}

type ItemFinalizeContext = 'stream-item' | 'completed-terminal' | 'max-tokens-terminal'

/**
 * Translate one DSH call to Codex's private Responses dialect and stream only
 * provider-neutral chunks. It never reads credentials and never executes tools.
 */
export async function* runCodexDirectResponses(
  options: GenerateOptions,
  dependencies: CodexDirectResponsesDependencies,
): AsyncIterable<StreamChunk> {
  const signal = combineSignals(options.signal, dependencies.signal)
  throwIfAborted(signal)
  const limits = resolveLimits(dependencies)
  if (options.stop !== undefined && options.stop.length > 0) {
    throw protocolError('Codex private Responses does not support stop sequences')
  }
  if (options.temperature !== undefined) {
    throw protocolError('Codex private Responses does not support temperature')
  }
  if (options.maxTokens !== undefined) {
    throw protocolError('Codex private Responses does not support max tokens')
  }

  const toolNames = validateToolSchemas(options)
  const request = await buildRequest(options, dependencies, limits.maxRequestImageBytes, signal)
  let serialized: string
  try {
    serialized = JSON.stringify(request)
  } catch {
    throw protocolError('Codex private Responses request is not serializable')
  }
  if (Buffer.byteLength(serialized, 'utf8') > limits.maxRequestBytes) {
    throw new CodexDirectResponsesError(
      'Codex private Responses request exceeds the configured request limit',
      'prompt-limit',
    )
  }

  const response = await dependencies.request(serialized, signal)
  if (signal.aborted) {
    cancelBody(response.body)
    throwIfAborted(signal)
  }
  if (!response.ok) {
    cancelBody(response.body)
    if (response.status === 401) {
      throw new CodexDirectResponsesError(
        'Codex private Responses rejected the ChatGPT subscription session',
        'subscription-auth',
        401,
      )
    }
    throw new CodexDirectResponsesError(
      `Codex private Responses returned HTTP ${response.status}`,
      'provider-http',
      response.status,
    )
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('text/event-stream')) {
    cancelBody(response.body)
    throw protocolError('Codex private Responses returned a non-SSE response')
  }

  const processor = new ResponseStreamProcessor(options, toolNames)
  let preliminaryTerminal: { readonly type: 'response.incomplete' | 'response.failed'; readonly event: Record<string, unknown> } | undefined
  for await (const payload of parseSse(response, signal, limits.maxResponseBytes, limits.maxSseEventBytes)) {
    if (payload === '[DONE]') {
      if (preliminaryTerminal === undefined) {
        throw protocolError('Codex private Responses ended before a terminal event')
      }
      for (const chunk of processor.accept(preliminaryTerminal.type, preliminaryTerminal.event)) yield chunk
      return
    }
    const event = requireRecord(payload, 'SSE event')
    const type = requireBoundedString(event.type, 'event type', MAX_PROVIDER_ID_BYTES)
    if (type === 'response.completed') {
      for (const chunk of processor.accept(type, event)) yield chunk
      return
    }
    if (type === 'response.incomplete' || type === 'response.failed') {
      if (preliminaryTerminal !== undefined) {
        throw protocolError('Codex private Responses repeated a preliminary terminal event')
      }
      preliminaryTerminal = { type, event }
      continue
    }
    if (preliminaryTerminal !== undefined && isOfficialPrivateNoopEvent(type)) continue
    if (preliminaryTerminal !== undefined) {
      throw protocolError('Codex private Responses emitted semantic data after a preliminary terminal event')
    }
    for (const chunk of processor.accept(type, event)) yield chunk
  }
  if (preliminaryTerminal !== undefined) {
    for (const chunk of processor.accept(preliminaryTerminal.type, preliminaryTerminal.event)) yield chunk
    return
  }
  throw protocolError('Codex private Responses stream ended without a terminal event')
}

async function buildRequest(
  options: GenerateOptions,
  dependencies: CodexDirectResponsesDependencies,
  maxRequestImageBytes: number,
  signal: AbortSignal,
): Promise<CodexResponsesRequest> {
  const input = await buildInput(options, dependencies.attachments, maxRequestImageBytes, signal)
  const tools = options.tools?.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }))
  return {
    model: options.model,
    instructions: options.system ?? '',
    input,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: options.reasoningEffort === undefined
      ? null
      : {
          effort: String(options.reasoningEffort) === 'ultra' ? 'max' : String(options.reasoningEffort),
          summary: 'auto',
        },
  }
}

async function buildInput(
  options: GenerateOptions,
  attachments: CodexDirectImageReader | undefined,
  maxRequestImageBytes: number,
  signal: AbortSignal,
): Promise<unknown[]> {
  const messages = offloadRequestImages(options.messages, maxRequestImageBytes)
  const input: unknown[] = []
  for (const message of messages) {
    const replay = matchingReplay(message, options.provider, options.model)
    if (replay !== undefined) {
      input.push(...replay.output)
      continue
    }
    await appendGenericMessage(input, message, attachments, signal)
  }
  return input
}

function matchingReplay(message: Message, provider: string, model: string): ReplayResponse | undefined {
  if (message.role !== 'assistant' || message.source.kind !== 'model') return undefined
  // The durable source retains the user-facing model alias (`default`) while
  // replay records the concrete model sent on the wire. The replay's own model
  // identity plus exact durable-content projection is the safe comparison.
  if (message.source.provider !== provider) return undefined
  const envelope = message.source.replayState
  if (!isRecord(envelope)) return undefined
  const response = envelope.response
  if (!isRecord(response)
    || response.kind !== 'codex-private-responses'
    || (response.version !== 2 && response.version !== 3)
    || response.provider !== provider
    || response.model !== model
    || !isBoundedString(response.responseId, MAX_PROVIDER_ID_BYTES)
    || !Array.isArray(response.output)
    || !isLosslessJson(response.output)
    || !Array.isArray(response.blockOrder)
    || !isLosslessJson(response.blockOrder)) return undefined

  let projected: NativeProjection
  try {
    projected = projectNativeOutput(response.output, response.blockOrder)
  } catch {
    return undefined
  }
  if (!contentEquals(projected.blocks, message.content)) return undefined
  return response as unknown as ReplayResponse
}

async function appendGenericMessage(
  input: unknown[],
  message: Message,
  attachments: CodexDirectImageReader | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (message.role === 'assistant') {
    let content: unknown[] = []
    const flush = () => {
      if (content.length === 0) return
      input.push({ role: 'assistant', content })
      content = []
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          content.push({ type: 'input_text', text: block.text })
          break
        case 'tool-call':
          flush()
          input.push({
            type: 'function_call',
            call_id: String(block.id),
            name: block.name,
            arguments: block.arguments,
          })
          break
        case 'image':
        case 'tool-result':
          throw protocolError(`Codex private Responses cannot serialize ${block.type} in an assistant message`)
        default:
          throw protocolError('Codex private Responses encountered an unknown assistant content block')
      }
    }
    flush()
    return
  }

  const role = message.role === 'system' ? 'system' : 'user'
  let content: unknown[] = []
  const flush = () => {
    if (content.length === 0) return
    input.push({ role, content })
    content = []
  }
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        content.push({ type: 'input_text', text: block.text })
        break
      case 'image':
        if (message.role === 'system') {
          throw protocolError('Codex private Responses cannot serialize an image in a system message')
        }
        content.push(await inputImage(block.attachment, attachments, signal))
        break
      case 'tool-result':
        flush()
        input.push({
          type: 'function_call_output',
          call_id: String(block.toolCallId),
          output: await functionOutput(block.content, block.isError === true, attachments, signal),
        })
        break
      case 'tool-call':
        throw protocolError(`Codex private Responses cannot serialize ${block.type} in a ${message.role} message`)
      default:
        throw protocolError('Codex private Responses encountered an unknown input content block')
    }
  }
  flush()
}

async function functionOutput(
  content: readonly ContentBlock[],
  isError: boolean,
  attachments: CodexDirectImageReader | undefined,
  signal: AbortSignal | undefined,
): Promise<string | unknown[]> {
  const parts: unknown[] = isError ? [{ type: 'input_text', text: '[tool_error]' }] : []
  for (const block of content) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        parts.push({ type: 'input_text', text: block.text })
        break
      case 'image':
        parts.push(await inputImage(block.attachment, attachments, signal))
        break
      case 'tool-call':
      case 'tool-result':
        throw protocolError('Codex private Responses cannot nest a tool block inside a tool result')
      default:
        throw protocolError('Codex private Responses encountered an unknown tool-result content block')
    }
  }
  if (parts.length === 0) return ''
  if (parts.length === 1 && isRecord(parts[0]) && parts[0].type === 'input_text') return String(parts[0].text)
  return parts
}

async function inputImage(
  ref: ImageAttachmentRef,
  attachments: CodexDirectImageReader | undefined,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  if (attachments === undefined) throw protocolError('Codex private Responses requires attachment storage for image input')
  throwIfAborted(signal)
  const stored = await attachments.readImage(ref, signal)
  throwIfAborted(signal)
  if (!(stored.data instanceof Uint8Array)
    || stored.data.byteLength !== ref.bytes
    || stored.ref === undefined
    || !sameImageRef(ref, stored.ref)) {
    throw protocolError('Codex private Responses received an invalid stored image')
  }
  return {
    type: 'input_image',
    detail: 'auto',
    image_url: `data:${ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
  }
}

function sameImageRef(left: ImageAttachmentRef, right: ImageAttachmentRef): boolean {
  return left.attachmentId === right.attachmentId
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.width === right.width
    && left.height === right.height
}

class ResponseStreamProcessor {
  readonly #items = new Map<string, ItemState>()
  readonly #providerItems = new Map<string, string>()
  readonly #outputIndexes = new Map<number, string>()
  readonly #doneItems = new Map<number, Record<string, unknown>>()
  readonly #blocks = new Map<string, BlockState>()
  readonly #callIds = new Map<string, string>()
  readonly #toolNames: ReadonlySet<string>
  readonly #options: GenerateOptions
  #nextIndex = 0
  #hasVisibleOutput = false
  #activeItemId: string | undefined
  #createdSeen = false
  #createdResponseId: string | undefined

  constructor(options: GenerateOptions, toolNames: ReadonlySet<string>) {
    this.#options = options
    this.#toolNames = toolNames
  }

  accept(type: string, event: Record<string, unknown>): StreamChunk[] {
    switch (type) {
      case 'response.created':
        return this.#created(event)
      case 'response.queued':
      case 'response.in_progress':
      case 'response.output_text.annotation.added':
      case 'codex.response.metadata':
      case 'response.metadata':
      case 'responsesapi.websocket_timing':
      case 'response.custom_tool_call_input.done':
        return []
      case 'response.output_item.added':
        return this.#outputItemAdded(event)
      case 'response.output_item.done':
        return this.#outputItemDone(event)
      case 'response.content_part.added':
        if (!hasRichPartIdentity(event)) return []
        return this.#contentPart(event, false)
      case 'response.content_part.done':
        if (!hasRichPartIdentity(event)) return []
        return this.#contentPart(event, true)
      case 'response.output_text.delta':
        return this.#textDelta(event, 'output_text')
      case 'response.output_text.done':
        if (!hasRichPartIdentity(event)) return []
        return this.#textDone(event, 'output_text')
      case 'response.refusal.delta':
        return this.#textDelta(event, 'refusal')
      case 'response.refusal.done':
        return this.#textDone(event, 'refusal')
      case 'response.reasoning_summary_part.added':
        return this.#reasoningPart(event, false)
      case 'response.reasoning_summary_part.done':
        if (event.item_id === undefined && event.output_index === undefined) return []
        return this.#reasoningPart(event, true)
      case 'response.reasoning_summary_text.delta':
        return this.#textDelta(event, 'summary_text')
      case 'response.reasoning_summary_text.done':
        return this.#textDone(event, 'summary_text')
      case 'response.function_call_arguments.delta':
        if (event.item_id === undefined && event.output_index === undefined) return []
        return this.#functionDelta(event)
      case 'response.function_call_arguments.done':
        if (event.item_id === undefined && event.output_index === undefined) return []
        return this.#functionDone(event)
      case 'response.reasoning_text.delta':
        return this.#rawReasoning(event, false)
      case 'response.reasoning_text.done':
        return this.#rawReasoning(event, true)
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
        return this.#terminal(type, event)
      case 'error':
        throw new CodexDirectResponsesError('Codex private Responses request failed', 'provider-failure')
      default:
        throw protocolError('Codex private Responses emitted an unsupported event type')
    }
  }

  #created(event: Record<string, unknown>): StreamChunk[] {
    const response = requireRecord(event.response, 'created response')
    const responseId = optionalBoundedString(response.id, 'created response id', MAX_PROVIDER_ID_BYTES)
    if (this.#createdSeen) {
      throw protocolError('Codex private Responses repeated its created event')
    }
    this.#createdSeen = true
    this.#createdResponseId = responseId
    return []
  }

  #outputItemAdded(event: Record<string, unknown>): StreamChunk[] {
    const item = requireRecord(event.item, 'output item')
    if (!isLosslessJson(item)) throw protocolError('Codex private Responses output item is invalid')
    const explicitIndex = optionalIndex(event.output_index, 'output index')
    const itemType = requireBoundedString(item.type, 'output item type', MAX_PROVIDER_ID_BYTES)
    validateOutputItem(item, 'streamed output item', true)
    const active = this.#activeItemId === undefined ? undefined : this.#items.get(this.#activeItemId)
    if (explicitIndex === undefined && active !== undefined && !(active.provisional && itemType === 'message')) {
      throw protocolError('Codex private Responses overlapped active output items')
    }
    const outputIndex = explicitIndex ?? active?.outputIndex ?? this.#outputIndexes.size
    const itemState = this.#registerItem(item, outputIndex, itemType)
    itemState.provisional = false
    if (this.#activeItemId === undefined) this.#activeItemId = itemState.id
    const chunks: StreamChunk[] = []
    this.#seedAddedItem(item, itemState, chunks)
    return chunks
  }

  #outputItemDone(event: Record<string, unknown>): StreamChunk[] {
    const item = requireRecord(event.item, 'completed output item')
    if (!isLosslessJson(item)) throw protocolError('Codex private Responses completed output item is invalid')
    const explicitIndex = optionalIndex(event.output_index, 'output index')
    const itemType = requireBoundedString(item.type, 'output item type', MAX_PROVIDER_ID_BYTES)
    const providerId = optionalBoundedString(item.id, 'output item id', MAX_PROVIDER_ID_BYTES)
    const providerKey = providerId === undefined ? undefined : this.#providerItems.get(providerId)
    let outputIndex: number
    if (explicitIndex !== undefined) {
      outputIndex = explicitIndex
    } else if (providerKey !== undefined) {
      const known = this.#items.get(providerKey)
      if (known === undefined) throw protocolError('Codex private Responses lost an output item')
      outputIndex = known.outputIndex
    } else {
      const candidates = this.#unfinishedItems(itemType)
      if (candidates.length > 1) {
        throw protocolError('Codex private Responses emitted an ambiguous identity-less completed item')
      }
      outputIndex = candidates[0]?.outputIndex ?? this.#outputIndexes.size
    }
    if (outputIndex !== this.#doneItems.size) {
      throw protocolError('Codex private Responses completed output items out of order')
    }
    const chunks: StreamChunk[] = []
    const state = this.#finalizeItem(item, outputIndex, chunks, 'stream-item')
    if (this.#activeItemId !== undefined) {
      if (state.id !== this.#activeItemId) {
        throw protocolError('Codex private Responses completed a different active output item')
      }
      this.#activeItemId = undefined
    }
    if (state.doneItem !== undefined && !jsonEquals(state.doneItem, item)) {
      throw protocolError('Codex private Responses changed an already completed output item')
    }
    state.doneItem = item
    this.#doneItems.set(outputIndex, item)
    return chunks
  }

  #seedAddedItem(item: Record<string, unknown>, state: ItemState, chunks: StreamChunk[]): void {
    switch (state.type) {
      case 'message': {
        if (item.content === undefined) return
        if (!Array.isArray(item.content)) throw protocolError('Codex private Responses message content is invalid')
        item.content.forEach((value, contentIndex) => {
          const part = requireRecord(value, 'message content part')
          if (part.type !== 'output_text' && part.type !== 'refusal') {
            throw protocolError('Codex private Responses emitted an unsupported message content part')
          }
          const text = requireString(part.type === 'refusal' ? part.refusal : part.text, 'message content prefix')
          const block = this.#ensureText(state.id, state.outputIndex, contentIndex, part.type, chunks, true, true)
          this.#appendText(block, text, chunks)
        })
        return
      }
      case 'reasoning': {
        if (item.summary === undefined) return
        if (!Array.isArray(item.summary)) throw protocolError('Codex private Responses reasoning summary is invalid')
        item.summary.forEach((value, summaryIndex) => {
          const part = requireRecord(value, 'reasoning summary part')
          if (part.type !== 'summary_text') throw protocolError('Codex private Responses emitted an unsupported reasoning summary')
          const block = this.#ensureText(state.id, state.outputIndex, summaryIndex, 'summary_text', chunks, true, true)
          this.#appendText(block, requireString(part.text, 'reasoning summary prefix'), chunks)
        })
        return
      }
      case 'function_call':
        this.#ensureTool(item, state, chunks)
        return
      default:
        throw protocolError('Codex private Responses emitted an unsupported output item')
    }
  }

  #resolveItem(
    event: Record<string, unknown>,
    expectedType: string,
    label: string,
    allowProvisionalMessage = false,
  ): ItemState {
    const providerId = optionalBoundedString(event.item_id, `${label} item id`, MAX_PROVIDER_ID_BYTES)
    const outputIndex = optionalIndex(event.output_index, `${label} output index`)
    const providerKey = providerId === undefined ? undefined : this.#providerItems.get(providerId)
    const indexedKey = outputIndex === undefined ? undefined : this.#outputIndexes.get(outputIndex)
    if (providerKey !== undefined && indexedKey !== undefined && providerKey !== indexedKey) {
      throw protocolError('Codex private Responses changed an output item identity')
    }
    let key = providerKey ?? indexedKey
    if (key === undefined && providerId === undefined && outputIndex === undefined) {
      const candidates = this.#unfinishedItems(expectedType)
      if (candidates.length > 1) {
        throw protocolError('Codex private Responses emitted ambiguous identity-less item data')
      }
      key = candidates[0]?.id
    }
    if (key === undefined && allowProvisionalMessage && expectedType === 'message'
      && providerId === undefined && outputIndex === undefined && this.#activeItemId === undefined) {
      const provisional = this.#registerItem({ type: 'message', role: 'assistant' }, this.#outputIndexes.size, 'message')
      provisional.provisional = true
      this.#activeItemId = provisional.id
      key = provisional.id
    }
    const state = key === undefined ? undefined : this.#items.get(key)
    if (state === undefined || state.type !== expectedType) {
      throw protocolError(`Codex private Responses emitted ${label} for an unknown or incompatible output item`)
    }
    if (providerId !== undefined && state.providerId !== providerId) {
      throw protocolError('Codex private Responses changed an output item identity')
    }
    if (outputIndex !== undefined && state.outputIndex !== outputIndex) {
      throw protocolError('Codex private Responses changed an output item index')
    }
    return state
  }

  #unfinishedItems(expectedType: string): ItemState[] {
    return [...this.#items.values()].filter(state => state.type === expectedType && state.doneItem === undefined)
  }

  #contentPart(event: Record<string, unknown>, done: boolean): StreamChunk[] {
    const part = requireRecord(event.part, 'content part')
    const nativeType = part.type
    if (nativeType !== 'output_text' && nativeType !== 'refusal') {
      throw protocolError('Codex private Responses emitted an unsupported message content part')
    }
    const item = this.#resolveItem(event, 'message', 'message content')
    const contentIndex = requireIndex(event.content_index, 'content index')
    const chunks: StreamChunk[] = []
    const state = this.#ensureText(item.id, item.outputIndex, contentIndex, nativeType, chunks, true, !done)
    const value = requireString(nativeType === 'refusal' ? part.refusal : part.text, 'content part text')
    if (done) this.#finishText(state, value, chunks)
    else this.#appendText(state, value, chunks)
    return chunks
  }

  #reasoningPart(event: Record<string, unknown>, done: boolean): StreamChunk[] {
    const part = event.part === undefined
      ? { type: 'summary_text', text: '' }
      : requireRecord(event.part, 'reasoning summary part')
    if (part.type !== 'summary_text') {
      throw protocolError('Codex private Responses emitted an unsupported reasoning summary part')
    }
    const item = this.#resolveItem(event, 'reasoning', 'reasoning summary')
    const summaryIndex = requireIndex(event.summary_index, 'summary index')
    const chunks: StreamChunk[] = []
    const state = this.#ensureText(item.id, item.outputIndex, summaryIndex, 'summary_text', chunks, true, !done)
    const value = requireString(part.text, 'reasoning summary part text')
    if (done) this.#finishText(state, value, chunks)
    else this.#appendText(state, value, chunks)
    return chunks
  }

  #textDelta(
    event: Record<string, unknown>,
    nativeType: TextState['nativeType'],
  ): StreamChunk[] {
    const expectedType = nativeType === 'summary_text' ? 'reasoning' : 'message'
    const item = this.#resolveItem(
      event,
      expectedType,
      nativeType === 'summary_text' ? 'reasoning summary' : 'text',
      nativeType === 'output_text',
    )
    const rawPartIndex = nativeType === 'summary_text' ? event.summary_index : event.content_index
    const partIndex = rawPartIndex === undefined && nativeType !== 'summary_text'
      ? 0
      : requireIndex(rawPartIndex, nativeType === 'summary_text' ? 'summary index' : 'content index')
    const delta = requireString(event.delta, 'text delta')
    const chunks: StreamChunk[] = []
    const state = this.#ensureText(item.id, item.outputIndex, partIndex, nativeType, chunks, true)
    if (state.closed) throw protocolError('Codex private Responses emitted text after closing its content part')
    state.text += delta
    if (delta.length > 0) {
      chunks.push(state.kind === 'text'
        ? { type: 'text-delta', index: state.index, text: delta }
        : { type: 'reasoning-delta', index: state.index, text: delta })
    }
    return chunks
  }

  #textDone(
    event: Record<string, unknown>,
    nativeType: TextState['nativeType'],
  ): StreamChunk[] {
    const expectedType = nativeType === 'summary_text' ? 'reasoning' : 'message'
    const item = this.#resolveItem(event, expectedType, nativeType === 'summary_text' ? 'reasoning summary' : 'text')
    const rawPartIndex = nativeType === 'summary_text' ? event.summary_index : event.content_index
    const partIndex = rawPartIndex === undefined && nativeType !== 'summary_text'
      ? 0
      : requireIndex(rawPartIndex, nativeType === 'summary_text' ? 'summary index' : 'content index')
    const value = nativeType === 'refusal' ? event.refusal : event.text
    const text = requireString(value, 'completed text')
    const chunks: StreamChunk[] = []
    const state = this.#ensureText(item.id, item.outputIndex, partIndex, nativeType, chunks, true)
    this.#finishText(state, text, chunks)
    return chunks
  }

  #functionDelta(event: Record<string, unknown>): StreamChunk[] {
    const item = this.#resolveItem(event, 'function_call', 'function arguments')
    const delta = requireString(event.delta, 'function arguments delta')
    const state = this.#toolForItem(item.id, item.outputIndex)
    if (state.closed) throw protocolError('Codex private Responses emitted arguments after closing a function call')
    state.arguments += delta
    return delta.length === 0
      ? []
      : [{ type: 'tool-call-delta', index: state.index, id: CallId(state.callId), argumentsDelta: delta }]
  }

  #functionDone(event: Record<string, unknown>): StreamChunk[] {
    const item = this.#resolveItem(event, 'function_call', 'function arguments')
    const state = this.#toolForItem(item.id, item.outputIndex)
    const finalArguments = requireString(event.arguments, 'function arguments')
    if (state.argumentsDone || state.closed) {
      throw protocolError('Codex private Responses repeated completed function arguments')
    }
    const chunks: StreamChunk[] = []
    this.#reconcileToolArguments(state, finalArguments, chunks)
    state.argumentsDone = true
    return chunks
  }

  #rawReasoning(event: Record<string, unknown>, done: boolean): StreamChunk[] {
    this.#resolveItem(event, 'reasoning', 'raw reasoning')
    requireIndex(event.content_index, 'reasoning content index')
    requireString(done ? event.text : event.delta, done ? 'completed raw reasoning' : 'raw reasoning delta')
    return []
  }

  #terminal(type: string, event: Record<string, unknown>): StreamChunk[] {
    const response = requireRecord(event.response, 'terminal response')
    const expectedStatus = type.slice('response.'.length)
    if (response.status !== undefined && response.status !== expectedStatus) {
      throw protocolError('Codex private Responses terminal status does not match its event')
    }
    if (type === 'response.failed') {
      const code = isRecord(response.error) && typeof response.error.code === 'string'
        && Buffer.byteLength(response.error.code, 'utf8') <= MAX_PROVIDER_ID_BYTES
        ? response.error.code
        : undefined
      if (code === 'context_length_exceeded') {
        throw new CodexDirectResponsesError(
          'Codex private Responses exceeded the model context window',
          'context-window',
        )
      }
      if (code === 'insufficient_quota') {
        throw new CodexDirectResponsesError(
          'Codex private Responses subscription quota is unavailable',
          'quota',
        )
      }
      throw new CodexDirectResponsesError('Codex private Responses request failed', 'provider-failure')
    }

    const responseId = requireBoundedString(response.id, 'response id', MAX_PROVIDER_ID_BYTES)
    if (this.#createdResponseId !== undefined && this.#createdResponseId !== responseId) {
      throw protocolError('Codex private Responses changed its response id')
    }
    if (response.end_turn !== undefined && typeof response.end_turn !== 'boolean') {
      throw protocolError('Codex private Responses end-turn flag is invalid')
    }

    let incomplete = false
    if (type === 'response.incomplete') {
      const details = requireRecord(response.incomplete_details, 'incomplete response details')
      if (details.reason === 'content_filter') {
        throw new CodexDirectResponsesError('Codex private Responses output was filtered', 'content-filter')
      }
      if (details.reason !== 'max_output_tokens') {
        throw protocolError('Codex private Responses ended in an unsupported incomplete state')
      }
      incomplete = true
    }

    let terminalOutput: unknown[] | undefined
    if (response.output !== undefined) {
      if (!Array.isArray(response.output) || !isLosslessJson(response.output)) {
        throw protocolError('Codex private Responses terminal output is invalid')
      }
      terminalOutput = response.output
    }
    const chunks: StreamChunk[] = []
    let output: readonly unknown[]
    const observed = [...this.#doneItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item)

    if (terminalOutput?.length === 0 && observed.length > 0) terminalOutput = undefined

    const active = this.#activeItemId === undefined ? undefined : this.#items.get(this.#activeItemId)
    if (terminalOutput !== undefined && observed.length === 0 && active?.provisional === true) {
      if (terminalOutput.length !== 1) {
        throw protocolError('Codex private Responses terminal output conflicts with provisional text')
      }
      const placeholder = requireRecord(terminalOutput[0], 'terminal provisional message')
      if (placeholder.type !== 'message' || placeholder.role !== 'assistant'
        || !Array.isArray(placeholder.content) || placeholder.content.length !== 0) {
        throw protocolError('Codex private Responses terminal output conflicts with provisional text')
      }
      const text = this.#blocks.get(`text:${active.id}:0`)
      if (active.type !== 'message' || text?.kind !== 'text' || text.nativeType !== 'output_text') {
        throw protocolError('Codex private Responses completed an invalid provisional message')
      }
      terminalOutput = [{
        ...placeholder,
        content: [{ type: 'output_text', text: text.text }],
      }]
    }

    if (terminalOutput !== undefined && observed.length > 0) {
      if (terminalOutput.length !== observed.length
        || terminalOutput.some((item, index) => !jsonEquals(item, observed[index]))) {
        throw protocolError('Codex private Responses terminal output disagrees with completed items')
      }
      output = terminalOutput
    } else if (terminalOutput !== undefined) {
      output = terminalOutput
    } else if (observed.length > 0) {
      output = observed
    } else if (this.#activeItemId !== undefined && incomplete) {
      output = []
    } else if (this.#activeItemId !== undefined) {
      const active = this.#items.get(this.#activeItemId)
      if (active === undefined || !active.provisional || active.type !== 'message') {
        throw protocolError('Codex private Responses completed with an active output item')
      }
      const state = this.#blocks.get(`text:${active.id}:0`)
      if (state?.kind !== 'text' || state.nativeType !== 'output_text') {
        throw protocolError('Codex private Responses completed an invalid provisional message')
      }
      output = [{
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: state.text }],
      }]
    } else {
      output = []
    }

    if (!isLosslessJson(output)) throw protocolError('Codex private Responses terminal output is invalid')
    if (this.#activeItemId !== undefined && !incomplete) {
      const active = this.#items.get(this.#activeItemId)
      if (active === undefined || (!active.provisional && observed.length === 0)) {
        throw protocolError('Codex private Responses completed with an active output item')
      }
    }

    output.forEach((value, outputIndex) => {
      const item = requireRecord(value, 'terminal output item')
      const state = this.#finalizeItem(item, outputIndex, chunks, incomplete ? 'max-tokens-terminal' : 'completed-terminal')
      if (state.doneItem !== undefined && !jsonEquals(state.doneItem, item)) {
        throw protocolError('Codex private Responses terminal output disagrees with its completed item')
      }
      state.doneItem = item
      this.#doneItems.set(outputIndex, item)
    })
    if (incomplete) {
      for (const state of this.#blocks.values()) {
        if (state.closed) continue
        if (state.kind === 'tool-call') this.#finishTool(state, state.arguments, chunks)
        else this.#finishText(state, state.text, chunks)
      }
    } else {
      if (this.#items.size !== output.length) {
        throw protocolError('Codex private Responses terminal output omitted a streamed item')
      }
      for (const state of this.#items.values()) {
        if (state.doneItem === undefined) throw protocolError('Codex private Responses terminal output omitted a streamed item')
      }
    }
    this.#activeItemId = undefined
    const blockOrder = [...this.#blocks.values()]
      .sort(compareBlockOrder)
      .map(state => state.key)
    if (!incomplete) projectNativeOutput(output, blockOrder)
    const usage = parseUsage(response.usage)
    if (!incomplete && !this.#hasVisibleOutput) {
      throw new CodexDirectResponsesError('Codex private Responses returned no visible output', 'empty-response')
    }
    if (usage !== undefined) chunks.push({ type: 'usage', usage })

    if (incomplete) {
      chunks.push({ type: 'finish', reason: { kind: 'max-tokens' } })
      return chunks
    }

    const replay: ReplayResponse = {
      kind: 'codex-private-responses',
      version: 3,
      provider: this.#options.provider,
      model: this.#options.model,
      responseId,
      output,
      blockOrder,
    }
    chunks.push({
      type: 'finish',
      reason: this.#callIds.size > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
      replayState: { response: replay },
    })
    return chunks
  }

  #finalizeItem(
    item: Record<string, unknown>,
    outputIndex: number,
    chunks: StreamChunk[],
    context: ItemFinalizeContext,
  ): ItemState {
    const type = requireBoundedString(item.type, 'output item type', MAX_PROVIDER_ID_BYTES)
    validateOutputItem(item, 'completed output item')
    if (context === 'completed-terminal' && item.status !== undefined && item.status !== 'completed') {
      throw protocolError('Codex private Responses completed with an incomplete output item')
    }
    const itemState = this.#registerItem(item, outputIndex, type)
    itemState.provisional = false
    const itemId = itemState.id
    switch (type) {
      case 'message': {
        if (!Array.isArray(item.content)) throw protocolError('Codex private Responses message content is invalid')
        this.#validateTerminalParts(itemState, item.content, 'message')
        item.content.forEach((value, contentIndex) => {
          const part = requireRecord(value, 'message content part')
          if (part.type !== 'output_text' && part.type !== 'refusal') {
            throw protocolError('Codex private Responses returned an unsupported message content part')
          }
          const state = this.#ensureText(itemId, outputIndex, contentIndex, part.type, chunks, false)
          const text = requireString(part.type === 'refusal' ? part.refusal : part.text, 'message text')
          this.#finishText(state, text, chunks)
        })
        return itemState
      }
      case 'reasoning': {
        if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
          requireString(item.encrypted_content, 'encrypted reasoning')
        }
        if (item.summary === undefined) {
          if (itemState.streamedParts) {
            throw protocolError('Codex private Responses terminal reasoning omitted streamed summary parts')
          }
          return itemState
        }
        if (!Array.isArray(item.summary)) throw protocolError('Codex private Responses reasoning summary is invalid')
        this.#validateTerminalParts(itemState, item.summary, 'reasoning')
        item.summary.forEach((value, summaryIndex) => {
          const part = requireRecord(value, 'reasoning summary')
          if (part.type !== 'summary_text') throw protocolError('Codex private Responses returned an unsupported reasoning summary')
          const state = this.#ensureText(itemId, outputIndex, summaryIndex, 'summary_text', chunks, false)
          this.#finishText(state, requireString(part.text, 'reasoning summary text'), chunks)
        })
        return itemState
      }
      case 'function_call': {
        const argumentsValue = requireString(item.arguments, 'function arguments')
        const state = this.#ensureTool(item, itemState, chunks)
        if (context === 'max-tokens-terminal') {
          this.#finishTool(state, argumentsValue, chunks)
          return itemState
        }
        if (item.status !== undefined && item.status !== 'completed') {
          throw protocolError('Codex private Responses returned an incomplete function call')
        }
        if (context === 'stream-item') {
          this.#reconcileToolArguments(state, argumentsValue, chunks)
          state.argumentsDone = true
          return itemState
        }
        this.#finishTool(state, argumentsValue, chunks)
        return itemState
      }
      default:
        throw protocolError('Codex private Responses returned an unsupported output item')
    }
  }

  #registerItem(item: Record<string, unknown>, outputIndex: number, type: string): ItemState {
    const providerId = optionalBoundedString(item.id, 'output item id', MAX_PROVIDER_ID_BYTES)
    const indexedKey = this.#outputIndexes.get(outputIndex)
    const providerKey = providerId === undefined ? undefined : this.#providerItems.get(providerId)
    if (indexedKey !== undefined && providerKey !== undefined && indexedKey !== providerKey) {
      throw protocolError('Codex private Responses changed an output item identity')
    }
    const existingKey = indexedKey ?? providerKey
    const existing = existingKey === undefined ? undefined : this.#items.get(existingKey)
    if (existing !== undefined) {
      if (existing.outputIndex !== outputIndex || existing.type !== type) {
        throw protocolError('Codex private Responses changed an output item identity')
      }
      if (providerId !== undefined) {
        if (existing.providerId !== undefined && existing.providerId !== providerId) {
          throw protocolError('Codex private Responses changed an output item identity')
        }
        existing.providerId = providerId
        this.#providerItems.set(providerId, existing.id)
      }
      return existing
    }
    if (outputIndex !== this.#outputIndexes.size) {
      throw protocolError('Codex private Responses registered output items out of order')
    }
    const itemId = `@output:${outputIndex}`
    if (this.#items.has(itemId)) throw protocolError('Codex private Responses repeated an output item id')
    const state: ItemState = {
      id: itemId,
      ...(providerId === undefined ? {} : { providerId }),
      outputIndex,
      type,
      parts: new Map(),
      addedParts: new Set(),
      streamedParts: false,
      provisional: false,
    }
    this.#items.set(itemId, state)
    if (providerId !== undefined) this.#providerItems.set(providerId, itemId)
    this.#outputIndexes.set(outputIndex, itemId)
    return state
  }

  #ensureText(
    itemId: string,
    outputIndex: number,
    partIndex: number,
    nativeType: TextState['nativeType'],
    chunks: StreamChunk[],
    fromStream: boolean,
    added = false,
  ): TextState {
    const kind = nativeType === 'summary_text' ? 'reasoning' : 'text'
    const item = this.#items.get(itemId)
    const expectedItemType = kind === 'reasoning' ? 'reasoning' : 'message'
    if (item === undefined || item.type !== expectedItemType || item.outputIndex !== outputIndex) {
      throw protocolError('Codex private Responses emitted content for an unknown or incompatible output item')
    }
    if (fromStream) {
      const registeredType = item.parts.get(partIndex)
      if (registeredType !== undefined && registeredType !== nativeType) {
        throw protocolError('Codex private Responses changed a content part type')
      }
      if (added && item.addedParts.has(partIndex)) {
        throw protocolError('Codex private Responses repeated a content part index')
      }
      if (registeredType === undefined && partIndex !== item.parts.size) {
        throw protocolError('Codex private Responses registered content parts out of order')
      }
      item.parts.set(partIndex, nativeType)
      if (added) item.addedParts.add(partIndex)
      item.streamedParts = true
    }
    const key = `${kind}:${itemId}:${partIndex}`
    const existing = this.#blocks.get(key)
    if (existing !== undefined) {
      if (existing.kind === 'tool-call' || existing.kind !== kind || existing.nativeType !== nativeType) {
        throw protocolError('Codex private Responses changed a content part type')
      }
      return existing
    }
    if (fromStream && outputIndex !== this.#outputIndexes.size - 1) {
      throw protocolError('Codex private Responses registered visible content out of order')
    }
    if (!fromStream && [...this.#blocks.values()].some(block => block.outputIndex > outputIndex)) {
      throw protocolError('Codex private Responses synthesized visible content out of order')
    }
    const state: TextState = {
      key,
      kind,
      index: this.#nextIndex,
      itemId,
      outputIndex,
      partIndex,
      nativeType,
      text: '',
      closed: false,
    }
    this.#nextIndex += 1
    this.#blocks.set(key, state)
    chunks.push({ type: 'block-start', index: state.index, blockType: kind })
    return state
  }

  #validateTerminalParts(
    item: ItemState,
    values: readonly unknown[],
    kind: 'message' | 'reasoning',
  ): void {
    if (!item.streamedParts) return
    if (values.length !== item.parts.size) {
      throw protocolError(`Codex private Responses terminal ${kind} parts do not cover streamed part indexes`)
    }
    values.forEach((value, partIndex) => {
      const part = requireRecord(value, `${kind} content part`)
      const nativeType = kind === 'reasoning' ? 'summary_text' : part.type
      if (item.parts.get(partIndex) !== nativeType) {
        throw protocolError(`Codex private Responses terminal ${kind} changed a streamed part type`)
      }
    })
  }

  #finishText(state: TextState, finalText: string, chunks: StreamChunk[]): void {
    if (state.closed) {
      if (state.text !== finalText) throw protocolError('Codex private Responses changed completed text')
      return
    }
    if (state.text.length === 0 && finalText.length > 0) {
      chunks.push(state.kind === 'text'
        ? { type: 'text-delta', index: state.index, text: finalText }
        : { type: 'reasoning-delta', index: state.index, text: finalText })
      state.text = finalText
    } else if (state.text !== finalText) {
      throw protocolError('Codex private Responses text deltas disagree with completed text')
    }
    state.closed = true
    if (state.text.length > 0) this.#hasVisibleOutput = true
    chunks.push({
      type: 'block-end',
      index: state.index,
      block: state.kind === 'text'
        ? { type: 'text', text: state.text }
        : { type: 'reasoning', text: state.text },
    })
  }

  #appendText(state: TextState, value: string, chunks: StreamChunk[]): void {
    if (state.closed) throw protocolError('Codex private Responses emitted text after closing its content part')
    state.text += value
    if (value.length === 0) return
    chunks.push(state.kind === 'text'
      ? { type: 'text-delta', index: state.index, text: value }
      : { type: 'reasoning-delta', index: state.index, text: value })
  }

  #ensureTool(item: Record<string, unknown>, itemState: ItemState, chunks: StreamChunk[]): ToolState {
    const itemId = itemState.id
    const outputIndex = itemState.outputIndex
    const callId = requireBoundedString(item.call_id, 'function call id', MAX_CALL_ID_BYTES)
    const name = requireBoundedString(item.name, 'function name', MAX_TOOL_NAME_BYTES)
    if (!this.#toolNames.has(name)) throw protocolError('Codex private Responses requested an unknown tool')
    const key = `tool:${itemId}`
    const existing = this.#blocks.get(key)
    if (existing !== undefined) {
      if (existing.kind !== 'tool-call' || existing.callId !== callId || existing.name !== name) {
        throw protocolError('Codex private Responses changed a function call identity')
      }
      return existing
    }
    const duplicate = this.#callIds.get(callId)
    if (duplicate !== undefined && duplicate !== itemId) {
      throw protocolError('Codex private Responses repeated a function call id')
    }
    const initialArguments = item.arguments === undefined ? '' : requireString(item.arguments, 'function arguments')
    const state: ToolState = {
      key,
      kind: 'tool-call',
      index: this.#nextIndex,
      itemId,
      outputIndex,
      callId,
      name,
      arguments: initialArguments,
      argumentsDone: false,
      closed: false,
    }
    this.#nextIndex += 1
    this.#hasVisibleOutput = true
    this.#blocks.set(key, state)
    this.#callIds.set(callId, itemState.id)
    chunks.push(
      { type: 'block-start', index: state.index, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: state.index,
        id: CallId(callId),
        name,
        argumentsDelta: initialArguments,
      },
    )
    return state
  }

  #toolForItem(itemId: string, outputIndex: number): ToolState {
    const state = this.#blocks.get(`tool:${itemId}`)
    if (state?.kind !== 'tool-call' || state.outputIndex !== outputIndex) {
      throw protocolError('Codex private Responses emitted function arguments before the function item')
    }
    return state
  }

  #finishTool(state: ToolState, finalArguments: string, chunks: StreamChunk[]): void {
    if (state.closed) {
      if (state.arguments !== finalArguments) throw protocolError('Codex private Responses changed completed function arguments')
      return
    }
    this.#reconcileToolArguments(state, finalArguments, chunks)
    state.argumentsDone = true
    state.closed = true
    chunks.push({
      type: 'block-end',
      index: state.index,
      block: {
        type: 'tool-call',
        id: CallId(state.callId),
        name: state.name,
        arguments: state.arguments,
      },
    })
  }

  #reconcileToolArguments(state: ToolState, finalArguments: string, chunks: StreamChunk[]): void {
    if (state.arguments.length === 0 && finalArguments.length > 0) {
      chunks.push({
        type: 'tool-call-delta',
        index: state.index,
        id: CallId(state.callId),
        argumentsDelta: finalArguments,
      })
      state.arguments = finalArguments
    } else if (state.arguments !== finalArguments) {
      throw protocolError('Codex private Responses argument deltas disagree with completed arguments')
    }
  }
}

function compareBlockOrder(left: BlockState, right: BlockState): number {
  return left.outputIndex - right.outputIndex || blockPartIndex(left) - blockPartIndex(right)
}

function blockPartIndex(state: BlockState): number {
  return state.kind === 'tool-call' ? 0 : state.partIndex
}

function validateOutputItem(item: Record<string, unknown>, label: string, allowInProgress = false): void {
  const type = requireBoundedString(item.type, `${label} type`, MAX_PROVIDER_ID_BYTES)
  if (type !== 'message' && type !== 'reasoning' && type !== 'function_call') {
    throw protocolError(`Codex private Responses ${label} type is unsupported`)
  }
  if (item.status !== undefined
    && item.status !== 'completed'
    && item.status !== 'incomplete'
    && !(allowInProgress && item.status === 'in_progress')) {
    throw protocolError(`Codex private Responses ${label} status is unsupported`)
  }
  if (type === 'message' && item.role !== 'assistant') {
    throw protocolError(`Codex private Responses ${label} role is unsupported`)
  }
}

function projectNativeOutput(output: readonly unknown[], blockOrder: readonly unknown[]): NativeProjection {
  const blocksByKey = new Map<string, ContentBlock>()
  const legacyAliases = new Map<string, string>()
  let hiddenReasoning = false
  const callIds = new Set<string>()
  for (const [outputIndex, value] of output.entries()) {
    const item = requireRecord(value, 'replay output item')
    validateOutputItem(item, 'replay output item')
    const providerId = optionalBoundedString(item.id, 'replay output item id', MAX_PROVIDER_ID_BYTES)
    const itemId = `@output:${outputIndex}`
    switch (item.type) {
      case 'message': {
        if (!Array.isArray(item.content)) throw protocolError('Replay message content is invalid')
        for (const [contentIndex, value] of item.content.entries()) {
          const part = requireRecord(value, 'replay message content')
          if (part.type === 'output_text') {
            blocksByKey.set(`text:${itemId}:${contentIndex}`, {
              type: 'text', text: requireString(part.text, 'replay output text'),
            })
            if (providerId !== undefined) {
              legacyAliases.set(`text:${providerId}:${contentIndex}`, `text:${itemId}:${contentIndex}`)
            }
          } else if (part.type === 'refusal') {
            blocksByKey.set(`text:${itemId}:${contentIndex}`, {
              type: 'text', text: requireString(part.refusal, 'replay refusal'),
            })
            if (providerId !== undefined) {
              legacyAliases.set(`text:${providerId}:${contentIndex}`, `text:${itemId}:${contentIndex}`)
            }
          } else {
            throw protocolError('Replay message content type is unsupported')
          }
        }
        break
      }
      case 'reasoning': {
        if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
          requireString(item.encrypted_content, 'replay encrypted reasoning')
          hiddenReasoning = true
        }
        if (item.summary === undefined) break
        if (!Array.isArray(item.summary)) throw protocolError('Replay reasoning summary is invalid')
        for (const [summaryIndex, value] of item.summary.entries()) {
          const part = requireRecord(value, 'replay reasoning summary')
          if (part.type !== 'summary_text') throw protocolError('Replay reasoning summary type is unsupported')
          blocksByKey.set(`reasoning:${itemId}:${summaryIndex}`, {
            type: 'reasoning', text: requireString(part.text, 'replay reasoning summary text'),
          })
          if (providerId !== undefined) {
            legacyAliases.set(`reasoning:${providerId}:${summaryIndex}`, `reasoning:${itemId}:${summaryIndex}`)
          }
        }
        break
      }
      case 'function_call': {
        const callId = requireBoundedString(item.call_id, 'replay function call id', MAX_CALL_ID_BYTES)
        if (callIds.has(callId)) throw protocolError('Replay repeated a function call id')
        callIds.add(callId)
        blocksByKey.set(`tool:${itemId}`, {
          type: 'tool-call',
          id: CallId(callId),
          name: requireBoundedString(item.name, 'replay function name', MAX_TOOL_NAME_BYTES),
          arguments: requireString(item.arguments, 'replay function arguments'),
        })
        if (providerId !== undefined) legacyAliases.set(`tool:${providerId}`, `tool:${itemId}`)
        break
      }
      default:
        throw protocolError('Replay output item type is unsupported')
    }
  }
  if (blockOrder.length !== blocksByKey.size) throw protocolError('Replay block order is incomplete')
  const seen = new Set<string>()
  const blocks = blockOrder.map(value => {
    const suppliedKey = requireBoundedString(value, 'replay block key', MAX_PROVIDER_ID_BYTES * 2)
    const key = legacyAliases.get(suppliedKey) ?? suppliedKey
    if (seen.has(key)) throw protocolError('Replay block order contains a duplicate key')
    seen.add(key)
    const block = blocksByKey.get(key)
    if (block === undefined) throw protocolError('Replay block order references an unknown key')
    return block
  })
  return { blocks, hiddenReasoning }
}

function contentEquals(left: readonly ContentBlock[], right: readonly ContentBlock[]): boolean {
  if (left.length !== right.length) return false
  return left.every((block, index) => {
    const candidate = right[index]
    if (candidate === undefined || candidate.type !== block.type) return false
    switch (block.type) {
      case 'text':
      case 'reasoning':
        return candidate.type === block.type && candidate.text === block.text
      case 'tool-call':
        return candidate.type === 'tool-call'
          && candidate.id === block.id
          && candidate.name === block.name
          && candidate.arguments === block.arguments
      case 'image':
        return candidate.type === 'image' && sameImageRef(candidate.attachment, block.attachment)
      case 'tool-result':
        return candidate.type === 'tool-result'
          && candidate.toolCallId === block.toolCallId
          && candidate.isError === block.isError
          && contentEquals(candidate.content, block.content)
      default:
        return false
    }
  })
}

async function* parseSse(
  response: Response,
  signal: AbortSignal,
  maxResponseBytes: number,
  maxEventBytes: number,
): AsyncIterable<unknown | '[DONE]'> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw protocolError('Codex private Responses returned an empty SSE body')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let dataLines: string[] = []
  let eventBytes = 0
  let totalBytes = 0
  let naturalEof = false

  const dispatch = (): unknown | '[DONE]' | undefined => {
    if (dataLines.length === 0) return undefined
    const data = dataLines.join('\n')
    dataLines = []
    eventBytes = 0
    if (data === '[DONE]') return '[DONE]'
    try {
      return JSON.parse(data) as unknown
    } catch {
      throw protocolError('Codex private Responses emitted invalid SSE JSON')
    }
  }

  const consumeLine = (rawLine: string): unknown | '[DONE]' | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') return dispatch()
    if (line.startsWith(':')) return undefined
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field !== 'data') return undefined
    eventBytes += Buffer.byteLength(value, 'utf8') + (dataLines.length === 0 ? 0 : 1)
    if (eventBytes > maxEventBytes) throw protocolError('Codex private Responses SSE event exceeded its safety limit')
    dataLines.push(value)
    return undefined
  }

  try {
    while (true) {
      throwIfAborted(signal)
      const part = await waitForAbort(reader.read(), signal)
      if (part.done) break
      totalBytes += part.value.byteLength
      if (totalBytes > maxResponseBytes) throw protocolError('Codex private Responses stream exceeded its safety limit')
      try {
        buffer += decoder.decode(part.value, { stream: true })
      } catch {
        throw protocolError('Codex private Responses SSE was not valid UTF-8')
      }
      const payloads: Array<unknown | '[DONE]'> = []
      let doneParsed = false
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const rawLine = buffer.slice(0, newline)
        const normalizedLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (doneParsed && normalizedLine !== '') {
          throw protocolError('Codex private Responses emitted data after DONE')
        }
        const payload = consumeLine(rawLine)
        buffer = buffer.slice(newline + 1)
        if (payload !== undefined) payloads.push(payload)
        if (payload === '[DONE]') doneParsed = true
        newline = buffer.indexOf('\n')
      }
      const doneIndex = payloads.indexOf('[DONE]')
      if (doneIndex !== -1) {
        if (payloads.lastIndexOf('[DONE]') !== doneIndex) {
          throw protocolError('Codex private Responses emitted a duplicate DONE marker')
        }
        if (doneIndex !== payloads.length - 1) {
          throw protocolError('Codex private Responses emitted data after DONE')
        }
        if (buffer.length > 0 || dataLines.length > 0) {
          throw protocolError('Codex private Responses emitted data after DONE')
        }
      }
      const terminalIndexes = payloads.flatMap((payload, index) => {
        if (!isRecord(payload) || !isTerminalEvent(payload.type as string)) return []
        return [index]
      })
      if (terminalIndexes.length > 1) {
        throw protocolError('Codex private Responses emitted a duplicate terminal event')
      }
      const terminalIndex = terminalIndexes[0]
      if (terminalIndex !== undefined) {
        const trailing = payloads.slice(terminalIndex + 1)
        if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '[DONE]')) {
          throw protocolError('Codex private Responses emitted data after its terminal event')
        }
        if (buffer.length > 0 || dataLines.length > 0) {
          throw protocolError('Codex private Responses emitted data after its terminal event')
        }
      }
      for (const payload of payloads) yield payload
      if (Buffer.byteLength(buffer, 'utf8') + eventBytes > maxEventBytes) {
        throw protocolError('Codex private Responses SSE line exceeded its safety limit')
      }
    }
    try {
      buffer += decoder.decode()
    } catch {
      throw protocolError('Codex private Responses SSE ended with invalid UTF-8')
    }
    if (buffer.length > 0 || dataLines.length > 0) {
      throw protocolError('Codex private Responses SSE ended with an unterminated event')
    }
    naturalEof = true
  } finally {
    if (!naturalEof) cancelReader(reader)
    try {
      reader.releaseLock()
    } catch {
      // Cancellation is best effort; prompt completion and the original failure win.
    }
  }
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (value === undefined || value === null) return undefined
  const usage = requireRecord(value, 'usage')
  const inputTokens = requireTokenCount(usage.input_tokens, 'input token count')
  const outputTokens = requireTokenCount(usage.output_tokens, 'output token count')
  const inputDetails = usage.input_tokens_details === undefined || usage.input_tokens_details === null
    ? {}
    : requireRecord(usage.input_tokens_details, 'input token details')
  const outputDetails = usage.output_tokens_details === undefined || usage.output_tokens_details === null
    ? {}
    : requireRecord(usage.output_tokens_details, 'output token details')
  const cacheReadTokens = optionalTokenCount(inputDetails.cached_tokens, 'cache read token count') ?? 0
  const cacheWriteTokens = optionalTokenCount(inputDetails.cache_write_tokens, 'cache write token count') ?? 0
  const reasoningTokens = optionalTokenCount(outputDetails.reasoning_tokens, 'reasoning token count')
  if (cacheReadTokens + cacheWriteTokens > inputTokens) {
    throw protocolError('Codex private Responses usage cache tokens exceed input tokens')
  }
  if (reasoningTokens !== undefined && reasoningTokens > outputTokens) {
    throw protocolError('Codex private Responses reasoning tokens exceed output tokens')
  }
  if (usage.total_tokens !== undefined
    && requireTokenCount(usage.total_tokens, 'total token count') !== inputTokens + outputTokens) {
    throw protocolError('Codex private Responses total token count is inconsistent')
  }
  return {
    inputTokens: inputTokens - cacheReadTokens - cacheWriteTokens,
    outputTokens,
    ...(cacheReadTokens === 0 ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === 0 ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function validateToolSchemas(options: GenerateOptions): ReadonlySet<string> {
  const names = new Set<string>()
  for (const tool of options.tools ?? []) {
    const name = requireBoundedString(tool.name, 'tool name', MAX_TOOL_NAME_BYTES)
    if (names.has(name)) throw protocolError('Codex private Responses received duplicate tool schemas')
    names.add(name)
    if (!isLosslessJson(tool.parameters)) throw protocolError('Codex private Responses received invalid tool parameters')
  }
  return names
}

function resolveLimits(dependencies: CodexDirectResponsesDependencies): {
  maxRequestBytes: number
  maxRequestImageBytes: number
  maxResponseBytes: number
  maxSseEventBytes: number
} {
  return {
    maxRequestBytes: positiveLimit(dependencies.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 'request'),
    maxRequestImageBytes: positiveLimit(
      dependencies.maxRequestImageBytes,
      DEFAULT_MAX_REQUEST_IMAGE_BYTES,
      'image request',
    ),
    maxResponseBytes: positiveLimit(dependencies.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 'response'),
    maxSseEventBytes: positiveLimit(dependencies.maxSseEventBytes, DEFAULT_MAX_SSE_EVENT_BYTES, 'SSE event'),
  }
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw protocolError(`Codex private Responses ${label} limit is invalid`)
  return resolved
}

function requireIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocolError(`Codex private Responses ${label} is invalid`)
  return value as number
}

function optionalIndex(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requireIndex(value, label)
}

function optionalBoundedString(value: unknown, label: string, maxBytes: number): string | undefined {
  return value === undefined ? undefined : requireBoundedString(value, label, maxBytes)
}

function hasRichPartIdentity(event: Record<string, unknown>): boolean {
  return event.item_id !== undefined || event.output_index !== undefined || event.content_index !== undefined
}

function requireTokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocolError(`Codex private Responses ${label} is invalid`)
  return value as number
}

function optionalTokenCount(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requireTokenCount(value, label)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw protocolError(`Codex private Responses ${label} is invalid`)
  return value
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (!isBoundedString(value, maxBytes)) throw protocolError(`Codex private Responses ${label} is invalid`)
  return value
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError(`Codex private Responses ${label} is invalid`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLosslessJson(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth >= MAX_JSON_DEPTH || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => isLosslessJson(item, depth + 1, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every(item => isLosslessJson(item, depth + 1, seen))
  seen.delete(value)
  return valid
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEquals(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && jsonEquals(left[key], right[key]))
}

function isTerminalEvent(type: string): boolean {
  return type === 'response.completed'
}

function isOfficialPrivateNoopEvent(type: string): boolean {
  return type === 'response.queued'
    || type === 'codex.response.metadata'
    || type === 'response.content_part.added'
    || type === 'response.content_part.done'
    || type === 'response.custom_tool_call_input.done'
    || type === 'response.function_call_arguments.delta'
    || type === 'response.function_call_arguments.done'
    || type === 'response.in_progress'
    || type === 'response.metadata'
    || type === 'response.output_text.done'
    || type === 'response.output_text.annotation.added'
    || type === 'response.reasoning_summary_part.done'
    || type === 'responsesapi.websocket_timing'
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return
  try {
    void body.cancel().catch(() => {})
  } catch {
    // Cancellation is best effort; never delay or replace the classified outcome.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {})
  } catch {
    // Cancellation is best effort; never delay or replace the classified outcome.
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error('Codex private Responses request was aborted', { cause: 'abort' })
}

function combineSignals(request: AbortSignal | undefined, lifecycle: AbortSignal | undefined): AbortSignal {
  if (request === undefined) return lifecycle ?? new AbortController().signal
  if (lifecycle === undefined || lifecycle === request) return request
  return AbortSignal.any([request, lifecycle])
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortReason(signal))
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted)).catch(() => {})
  })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Codex private Responses request was aborted', { cause: 'abort' })
}

function protocolError(message: string): CodexDirectResponsesError {
  return new CodexDirectResponsesError(message, 'protocol')
}
