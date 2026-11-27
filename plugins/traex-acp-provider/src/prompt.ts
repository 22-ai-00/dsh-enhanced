import type { ContentBlock, GenerateOptions, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'

export const DSH_TOOL_CALL_PROTOCOL = 'dsh-tool-calls/v1'

const MAX_TOOL_RESULT_IMAGE_DESCRIPTION_CHARS = 640
const MAX_ATTACHMENT_ID_DESCRIPTION_CHARS = 192
const MAX_ATTACHMENT_MEDIA_TYPE_DESCRIPTION_CHARS = 48
const MAX_ATTACHMENT_NAME_DESCRIPTION_CHARS = 128

export interface DelegatedToolCall {
  readonly name: string
  readonly arguments: string
}

interface TranscriptBlock {
  type: string
  text?: string
  name?: string
  id?: string
  arguments?: string
  toolCallId?: string
  isError?: boolean
  content?: TranscriptBlock[]
}

interface TranscriptMessage {
  role: RequestMessage['role']
  content: TranscriptBlock[]
}

function boundedDescription(value: unknown, maxChars: number): string {
  const input = String(value)
  let output = ''
  let chars = 0
  for (const character of input) {
    if (chars >= maxChars - 1) return `${output}…`
    output += character
    chars += 1
  }
  return output
}

function boundedQuotedDescription(value: unknown, maxEncodedChars: number): string {
  const input = String(value)
  let output = ''
  for (const character of input) {
    // Encode controls and delimiters exactly as JSON would, without first
    // materializing an unbounded copy of an attacker-controlled metadata field.
    const encoded = JSON.stringify(character).slice(1, -1)
    if (output.length + encoded.length > maxEncodedChars) return `"${output}…"`
    output += encoded
  }
  return `"${output}"`
}

function toolResultImageDescription(block: Extract<ContentBlock, { type: 'image' }>): string {
  const attachment = block.attachment
  const fields = [
    `attachmentId=${boundedQuotedDescription(attachment.attachmentId, MAX_ATTACHMENT_ID_DESCRIPTION_CHARS)}`,
    `mediaType=${boundedQuotedDescription(attachment.mediaType, MAX_ATTACHMENT_MEDIA_TYPE_DESCRIPTION_CHARS)}`,
    `bytes=${boundedDescription(attachment.bytes, 32)}`,
    `width=${boundedDescription(attachment.width, 32)}`,
    `height=${boundedDescription(attachment.height, 32)}`,
    ...(attachment.name === undefined
      ? []
      : [`name=${boundedQuotedDescription(attachment.name, MAX_ATTACHMENT_NAME_DESCRIPTION_CHARS)}`]),
  ]
  return boundedDescription(
    `[DSH image attachment omitted by text-only backend; ${fields.join('; ')}]`,
    MAX_TOOL_RESULT_IMAGE_DESCRIPTION_CHARS,
  )
}

function serializeBlock(block: ContentBlock, agentLabel: string): TranscriptBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning-omitted' }
    case 'tool-call':
      return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }
    case 'image':
      throw new Error(`${agentLabel} ACP provider currently accepts text-only DSH requests`)
    default:
      throw new Error(`${agentLabel} ACP provider does not support content block type: ${String((block as { type?: unknown }).type)}`)
  }
}

function serializeMessage(message: RequestMessage, agentLabel: string): TranscriptMessage {
  if (message.role === 'tool') return { role: 'tool', content: [{
    type: 'tool-result', toolCallId: message.toolCallId,
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    content: message.content.map(block => block.type === 'image'
      ? { type: 'text', text: toolResultImageDescription(block) }
      : serializeBlock(block, agentLabel)),
  }] }
  if (message.role === 'user' && message.source?.kind === 'tool') {
    throw new Error(`${agentLabel} ACP provider received a tool result in a user message`)
  }
  return { role: message.role, content: message.content.map(block => serializeBlock(block, agentLabel)) }
}

const COMPACTION_TEXT_BLOCK_MAX_BYTES = 8_192
const COMPACTION_TEXT_TRUNCATION_SUFFIX = '…[truncated for compaction]'
const COMPACTION_OMISSION_MARKER: TranscriptMessage = {
  role: 'user',
  content: [{
    type: 'text',
    text: '[Earlier conversation messages omitted to fit local ACP prompt byte limit during compaction.]',
  }],
}

const COMPACTED_TOOL_DESCRIPTION_MAX_CHARS = 160
const COMPACTED_PARAM_DESCRIPTION_MAX_CHARS = 80
const TIGHT_TOOL_DESCRIPTION_MAX_CHARS = 80
const LARGE_TOOL_CATALOG_BYTES_THRESHOLD = 24_576
const PROMPT_COMPACT_PRESSURE_RATIO = 0.65
const NON_STRUCTURAL_SCHEMA_KEYS = new Set(['$schema', '$id', '$comment', 'title', 'examples'])

const EARLIER_TOOL_RESULT_TRUNCATION_SUFFIX =
  '…[earlier tool output truncated to fit local ACP prompt byte limit; re-read specific line range if needed]'
const EARLIER_TOOL_RESULT_BYTE_CAPS = [2_048, 1_024, 512, 256, 0] as const

interface ToolSchemaCompactionPolicy {
  readonly toolDescriptionMaxChars: number
  readonly paramDescriptionMaxChars: number
  readonly stripParamDescriptionsFromDepth: number
}

const DEFAULT_TOOL_SCHEMA_COMPACTION: ToolSchemaCompactionPolicy = {
  toolDescriptionMaxChars: COMPACTED_TOOL_DESCRIPTION_MAX_CHARS,
  paramDescriptionMaxChars: COMPACTED_PARAM_DESCRIPTION_MAX_CHARS,
  stripParamDescriptionsFromDepth: 2,
}

const TIGHT_TOOL_SCHEMA_COMPACTION: ToolSchemaCompactionPolicy = {
  toolDescriptionMaxChars: TIGHT_TOOL_DESCRIPTION_MAX_CHARS,
  paramDescriptionMaxChars: 0,
  stripParamDescriptionsFromDepth: 1,
}

function compactDescription(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || maxChars <= 0) return ''
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length === 0) return ''
  let codePoints = 0
  for (const _character of normalized) {
    codePoints += 1
    if (codePoints > maxChars) return boundedDescription(normalized, maxChars)
  }
  return normalized
}

function compactSchemaNode(
  node: unknown,
  depth: number,
  policy: ToolSchemaCompactionPolicy,
): unknown {
  if (Array.isArray(node)) {
    return node.map(item => compactSchemaNode(item, depth, policy))
  }
  if (!isRecord(node)) return node

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (NON_STRUCTURAL_SCHEMA_KEYS.has(key)) continue
    if (key === 'description') {
      // Root `parameters.description` duplicates `tool.description`, and deep sub-descriptions
      // bloat large tool catalogs without changing argument schema validation.
      if (depth === 0 || depth >= policy.stripParamDescriptionsFromDepth) continue
      const summary = compactDescription(value, policy.paramDescriptionMaxChars)
      if (summary.length > 0) result[key] = summary
      continue
    }
    if (key === 'properties' && isRecord(value)) {
      const properties: Record<string, unknown> = {}
      for (const [propName, propSchema] of Object.entries(value)) {
        properties[propName] = compactSchemaNode(propSchema, depth + 1, policy)
      }
      result[key] = properties
      continue
    }
    if (key === 'items') {
      result[key] = compactSchemaNode(value, depth + 1, policy)
      continue
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      result[key] = value.map(branch => compactSchemaNode(branch, depth + 1, policy))
      continue
    }
    if ((key === 'not' || key === 'if' || key === 'then' || key === 'else' || key === 'propertyNames')
      && isRecord(value)) {
      result[key] = compactSchemaNode(value, depth + 1, policy)
      continue
    }
    if ((key === '$defs' || key === 'definitions' || key === 'patternProperties' || key === 'dependentSchemas')
      && isRecord(value)) {
      const defs: Record<string, unknown> = {}
      for (const [defName, defSchema] of Object.entries(value)) {
        defs[defName] = compactSchemaNode(defSchema, depth + 1, policy)
      }
      result[key] = defs
      continue
    }
    if (key === 'additionalProperties' && isRecord(value)) {
      result[key] = compactSchemaNode(value, depth + 1, policy)
      continue
    }
    result[key] = value
  }
  return result
}

function projectAvailableTools(
  tools: readonly ToolSchema[],
  policy: ToolSchemaCompactionPolicy,
): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    const description = compactDescription(tool.description, policy.toolDescriptionMaxChars)
    return {
      ...(tool.deferLoading === undefined ? {} : { deferLoading: tool.deferLoading }),
      name: tool.name,
      ...(description.length === 0 ? {} : { description }),
      parameters: compactSchemaNode(tool.parameters, 0, policy),
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeCodeUnitBoundary(text: string, index: number): number {
  if (index <= 0) return 0
  if (index >= text.length) return text.length
  const prev = text.charCodeAt(index - 1)
  const curr = text.charCodeAt(index)
  if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
    return index - 1
  }
  return index
}

function sliceUtf8Bounded(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const rawMid = (low + high + 1) >>> 1
    const mid = safeCodeUnitBoundary(text, rawMid)
    if (mid <= low) {
      const candidate = safeCodeUnitBoundary(text, high)
      if (candidate > low && Buffer.byteLength(text.slice(0, candidate), 'utf8') <= maxBytes) {
        low = candidate
      }
      break
    }
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return text.slice(0, safeCodeUnitBoundary(text, low))
}

function isRuntimeContextSnapshot(message: RequestMessage): boolean {
  if (message.role !== 'user' || !isRecord(message.source)) return false
  const source = message.source as { kind?: unknown; form?: unknown }
  return source.kind === 'runtime-context' && source.form === 'snapshot'
}

function skillCatalogSource(message: RequestMessage): { update?: unknown } | undefined {
  if (message.role !== 'user' || !isRecord(message.source)) return undefined
  const source = message.source as { kind?: unknown; form?: unknown; update?: unknown; entries?: unknown }
  if (source.kind !== 'skill-catalog' || source.form !== 'catalog' || !Array.isArray(source.entries)) {
    return undefined
  }
  for (const entry of source.entries) {
    if (!isRecord(entry)) return undefined
    const fields = entry as { name?: unknown; description?: unknown }
    if (typeof fields.name !== 'string' || fields.name.length === 0 || typeof fields.description !== 'string') {
      return undefined
    }
  }
  return source
}

/**
 * Each ACP invocation runs in a fresh stateless process without cross-step KV cache, so drop
 * superseded `runtime-context` snapshots and replaced `skill-catalog` messages before serializing.
 */
function effectiveMessages(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  let newestRuntimeContext = -1
  let newestCatalog = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (newestRuntimeContext < 0 && isRuntimeContextSnapshot(message)) {
      newestRuntimeContext = index
    }
    if (newestCatalog < 0 && skillCatalogSource(message) !== undefined) {
      newestCatalog = index
    }
    if (newestRuntimeContext >= 0 && newestCatalog >= 0) break
  }
  const dropOlderCatalogs = newestCatalog >= 0 && skillCatalogSource(messages[newestCatalog]!)?.update === true
  if (newestRuntimeContext < 0 && !dropOlderCatalogs) return messages
  return messages.filter((message, index) => {
    if (newestRuntimeContext >= 0 && index < newestRuntimeContext && isRuntimeContextSnapshot(message)) {
      return false
    }
    if (dropOlderCatalogs && index !== newestCatalog && skillCatalogSource(message) !== undefined) {
      return false
    }
    return true
  })
}

function boundTranscriptBlock(block: TranscriptBlock): TranscriptBlock {
  if (block.type === 'text' && typeof block.text === 'string') {
    if (Buffer.byteLength(block.text, 'utf8') <= COMPACTION_TEXT_BLOCK_MAX_BYTES) return block
    return {
      ...block,
      text: `${sliceUtf8Bounded(block.text, COMPACTION_TEXT_BLOCK_MAX_BYTES)}${COMPACTION_TEXT_TRUNCATION_SUFFIX}`,
    }
  }
  if (block.type === 'tool-result' && Array.isArray(block.content)) {
    return { ...block, content: block.content.map(boundTranscriptBlock) }
  }
  return block
}

interface SerializedPromptRequest {
  protocol: string
  instruction: string
  constraints: Record<string, unknown>
  system: string | null
  conversation: TranscriptMessage[]
}

function renderPrompt(request: SerializedPromptRequest): string {
  return `Act as a text model backend for DeepSeek Harness. The JSON request follows.\n${JSON.stringify(request)}`
}

function boundCompactionConversation(
  request: SerializedPromptRequest,
  maxPromptBytes: number,
): string | undefined {
  const { conversation } = request
  if (conversation.length < 2) return undefined
  const head = conversation[0]?.role === 'system' ? [conversation[0]] : []
  const directive = conversation.at(-1)!
  const body = conversation.slice(head.length, -1)
  if (body.length === 0) return undefined

  const boundedBody: TranscriptMessage[] = body.map(message => ({
    ...message,
    content: message.content.map(boundTranscriptBlock),
  }))
  const pass1Prompt = renderPrompt({ ...request, conversation: [...head, ...boundedBody, directive] })
  if (Buffer.byteLength(pass1Prompt, 'utf8') <= maxPromptBytes) return pass1Prompt

  const minimalPrompt = renderPrompt({ ...request, conversation: [...head, COMPACTION_OMISSION_MARKER, directive] })
  if (Buffer.byteLength(minimalPrompt, 'utf8') > maxPromptBytes) return undefined

  let low = 1
  let high = boundedBody.length
  let bestPrompt = minimalPrompt
  while (low <= high) {
    const mid = (low + high) >>> 1
    const candidate = renderPrompt({
      ...request,
      conversation: [...head, COMPACTION_OMISSION_MARKER, ...boundedBody.slice(mid), directive],
    })
    if (Buffer.byteLength(candidate, 'utf8') <= maxPromptBytes) {
      bestPrompt = candidate
      high = mid - 1
    } else {
      low = mid + 1
    }
  }
  return bestPrompt
}

function boundEarlierToolResultBlock(block: TranscriptBlock, maxBytes: number): TranscriptBlock {
  if (block.type === 'text' && typeof block.text === 'string') {
    const originalBytes = Buffer.byteLength(block.text, 'utf8')
    if (originalBytes <= maxBytes) return block
    const truncated = `${sliceUtf8Bounded(block.text, maxBytes)}${EARLIER_TOOL_RESULT_TRUNCATION_SUFFIX}`
    if (Buffer.byteLength(truncated, 'utf8') >= originalBytes) return block
    return { ...block, text: truncated }
  }
  if (block.type === 'tool-result' && Array.isArray(block.content)) {
    return { ...block, content: block.content.map(child => boundEarlierToolResultBlock(child, maxBytes)) }
  }
  return block
}

function boundEarlierToolResults(
  request: SerializedPromptRequest,
  maxPromptBytes: number,
): string | undefined {
  const { conversation } = request
  let lastAssistantIdx = -1
  let lastToolIdx = -1
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const role = conversation[index]?.role
    if (lastToolIdx < 0 && role === 'tool') lastToolIdx = index
    if (lastAssistantIdx < 0 && role === 'assistant') lastAssistantIdx = index
    if (lastToolIdx >= 0 && lastAssistantIdx >= 0) break
  }
  if (lastToolIdx < 0) return undefined

  let latestBatchStart = lastToolIdx
  while (latestBatchStart > 0 && conversation[latestBatchStart - 1]?.role === 'tool') {
    latestBatchStart -= 1
  }

  const candidateLimits: number[] = []
  if (latestBatchStart > 0 && conversation.slice(0, latestBatchStart).some(message => message.role === 'tool')) {
    candidateLimits.push(latestBatchStart)
  }
  // If the assistant already responded after the last tool result, there is no pending
  // trailing tool batch, so all historical tool results are eligible when earlier batches alone fail.
  if (lastToolIdx < lastAssistantIdx) {
    candidateLimits.push(lastToolIdx + 1)
  }

  for (const boundExclusiveEnd of candidateLimits) {
    for (const byteCap of EARLIER_TOOL_RESULT_BYTE_CAPS) {
      const boundedConversation = conversation.map((message, index) => (
        message.role === 'tool' && index < boundExclusiveEnd
          ? { ...message, content: message.content.map(block => boundEarlierToolResultBlock(block, byteCap)) }
          : message
      ))
      const candidate = renderPrompt({ ...request, conversation: boundedConversation })
      if (Buffer.byteLength(candidate, 'utf8') <= maxPromptBytes) return candidate
    }
  }
  return undefined
}

function buildToolConstraints(
  tools: readonly ToolSchema[],
  purpose: GenerateOptions['purpose'],
  policy: ToolSchemaCompactionPolicy,
): Record<string, unknown> {
  if (purpose === 'compaction') {
    return { available: tools.map(tool => ({ name: tool.name })) }
  }
  if (tools.length === 0) {
    return { available: [] }
  }
  return {
    responseProtocol: DSH_TOOL_CALL_PROTOCOL,
    responseFormat: {
      protocol: DSH_TOOL_CALL_PROTOCOL,
      calls: [{ name: '<exact available tool name>', arguments: { '<parameter name>': '<value matching that parameter schema>' } }],
    },
    available: projectAvailableTools(tools, policy),
  }
}

/** Serialize one provider-neutral DSH call into a stateless ACP turn. */
export function buildPrompt(
  options: GenerateOptions,
  maxPromptBytes: number,
  agentLabel = 'TraeX',
): string {
  const tools = options.tools ?? []
  const planGuard = agentLabel === 'Antigravity'
    ? ' Do not enter or use plan mode and never invoke exit_plan_mode, ask_question, subagents, or swarms; produce the complete response directly in this single turn.'
    : ''
  const baseInstruction = options.purpose === 'compaction'
    ? 'Produce only the requested compaction checkpoint as normal assistant text. Do not request or invoke any tool, and do not emit a DSH tool-call JSON envelope. Tool schemas remain present only so the host can verify that this auxiliary request is an exact projection of the active Agent Loop request.'
    : tools.length === 0
    ? `Continue the conversation as the assistant within the DSH system and user instructions in this request. Return only the next assistant response. Do not modify files or execute commands inside ${agentLabel}.`
    : `Continue the conversation as the assistant within the DSH system and user instructions in this request. Do not modify files or execute commands inside ${agentLabel} and do not invoke ${agentLabel}-native tools; they are unavailable in this backend session. Tools can only be used through DSH. Declared tools describe availability, not authorization: follow the applicable DSH system, user, policy, and prior tool-result constraints before requesting one. If a tool action was rejected or denied by the user, by policy, or because authorization is absent, do not retry it, bypass the rejection, or substitute an equivalent action unless a later authorized user or system instruction explicitly permits it. You may correct invalid arguments through authorized read-only discovery when the tool result recommends it. You may continue independent permitted work, or honestly report that the requested work is blocked; do not claim completion for work that did not occur. When an authorized tool call is needed, request it now instead of merely describing future work: return exactly one JSON object matching constraints.tools.responseFormat. Each call.arguments value must be a JSON object matching that tool's parameter schema, never a JSON-encoded string. The first output character must be { and the last must be }; do not add a preamble, progress update, explanation, Markdown fence, or any other text before or after the object. Otherwise, return only the next assistant response as normal text.`
  const buildRequest = (policy: ToolSchemaCompactionPolicy): SerializedPromptRequest => ({
    protocol: 'dsh-traex-acp-provider/v1',
    instruction: `${baseInstruction}${planGuard}`,
    constraints: {
      tools: buildToolConstraints(tools, options.purpose, policy),
      stop: options.stop ?? null,
      maxTokens: options.maxTokens ?? null,
      temperature: options.temperature ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
      purpose: options.purpose ?? null,
    },
    system: options.system ?? null,
    conversation: effectiveMessages(options.messages).map(message => serializeMessage(message, agentLabel)),
  })

  let request = buildRequest(DEFAULT_TOOL_SCHEMA_COMPACTION)
  let prompt = renderPrompt(request)
  let size = Buffer.byteLength(prompt, 'utf8')

  if (options.purpose !== 'compaction' && tools.length > 0) {
    const available = (request.constraints.tools as { available?: unknown }).available
    const availableBytes = Buffer.byteLength(JSON.stringify(available), 'utf8')
    if (availableBytes > LARGE_TOOL_CATALOG_BYTES_THRESHOLD
      || size > Math.floor(maxPromptBytes * PROMPT_COMPACT_PRESSURE_RATIO)) {
      request = {
        ...request,
        constraints: {
          ...request.constraints,
          tools: buildToolConstraints(tools, options.purpose, TIGHT_TOOL_SCHEMA_COMPACTION),
        },
      }
      prompt = renderPrompt(request)
      size = Buffer.byteLength(prompt, 'utf8')
    }
  }

  if (size <= maxPromptBytes) return prompt

  if (options.purpose === 'compaction') {
    const bounded = boundCompactionConversation(request, maxPromptBytes)
    if (bounded !== undefined) return bounded
  } else {
    const bounded = boundEarlierToolResults(request, maxPromptBytes)
    if (bounded !== undefined) return bounded
  }

  throw new Error(
    `serialized DSH request is ${size} bytes; configured limit is ${maxPromptBytes}. `
    + 'Raise `maxPromptBytes` (or `agyMaxPromptBytes` within Antigravity\'s 190000-byte input cap) or compact the conversation.',
    { cause: 'prompt-limit' },
  )
}

function toolArguments(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const decoded = JSON.parse(value) as unknown
    return isRecord(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

function jsonPayload(value: string): string {
  const trimmed = value.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

function parsedToolEnvelope(
  candidate: string,
  tools: readonly ToolSchema[],
): readonly DelegatedToolCall[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(jsonPayload(candidate)) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.protocol !== DSH_TOOL_CALL_PROTOCOL) return undefined
  if (!Array.isArray(value.calls) || value.calls.length === 0 || value.calls.length > 64) {
    throw new Error('TraeX returned an invalid DSH tool-call envelope', { cause: 'protocol' })
  }
  const names = new Set(tools.map(tool => tool.name))
  return value.calls.map((call): DelegatedToolCall => {
    const argumentsObject = isRecord(call) ? toolArguments(call.arguments) : undefined
    if (!isRecord(call) || typeof call.name !== 'string' || !names.has(call.name) || argumentsObject === undefined) {
      throw new Error('TraeX returned an invalid or unavailable DSH tool call', { cause: 'protocol' })
    }
    return { name: call.name, arguments: JSON.stringify(argumentsObject) }
  })
}

function embeddedToolEnvelope(response: string): string | undefined {
  let searchFrom = 0
  while (searchFrom < response.length) {
    const protocolIndex = response.indexOf(`"protocol"`, searchFrom)
    if (protocolIndex < 0) return undefined
    const start = response.lastIndexOf('{', protocolIndex)
    if (start < 0) return undefined
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < response.length; index += 1) {
      const character = response[index]!
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') quoted = true
      else if (character === '{') depth += 1
      else if (character === '}' && --depth === 0) return response.slice(start, index + 1)
    }
    searchFrom = protocolIndex + 10
  }
  return undefined
}

/** Decode the model-hidden tool envelope; ordinary assistant text returns `undefined`. */
export function parseDelegatedToolCalls(
  response: string,
  tools: readonly ToolSchema[],
): readonly DelegatedToolCall[] | undefined {
  if (tools.length === 0) return undefined
  const exact = parsedToolEnvelope(response, tools)
  if (exact !== undefined) return exact
  const embedded = embeddedToolEnvelope(response)
  return embedded === undefined ? undefined : parsedToolEnvelope(embedded, tools)
}
