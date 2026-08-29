import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

export const DSH_TOOL_CALL_PROTOCOL = 'dsh-tool-calls/v1'

const MAX_DELEGATED_TOOL_CALLS = 64
const MAX_DELEGATED_JSON_DEPTH = 64
const MAX_DELEGATED_JSON_NODES = 100_000
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
  role: Message['role']
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

function serializeToolResultContent(block: ContentBlock): TranscriptBlock {
  if (block.type === 'image') {
    return { type: 'text', text: toolResultImageDescription(block) }
  }
  return serializeBlock(block)
}

function serializeBlock(block: ContentBlock): TranscriptBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      // Do not republish hidden provider reasoning into another provider's prompt.
      return { type: 'reasoning-omitted' }
    case 'tool-call':
      return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: block.toolCallId,
        ...(block.isError === undefined ? {} : { isError: block.isError }),
        content: block.content.map(serializeToolResultContent),
      }
    case 'image':
      throw new Error('coding subscription providers currently accept text-only DSH requests')
    default:
      return { type: `unsupported:${String((block as { type?: unknown }).type)}` }
  }
}

function serializeMessage(message: Message): TranscriptMessage {
  return { role: message.role, content: message.content.map(serializeBlock) }
}

function skillCatalogSource(message: Message): { update?: unknown } | undefined {
  const source = message.source as { kind?: unknown; form?: unknown; update?: unknown; entries?: unknown }
  if (source.kind !== 'skill-catalog' || source.form !== 'catalog' || !Array.isArray(source.entries)) return undefined
  for (const entry of source.entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const fields = entry as { name?: unknown; description?: unknown }
    if (typeof fields.name !== 'string' || fields.name.length === 0 || typeof fields.description !== 'string') return undefined
  }
  return source
}

/**
 * A skill-catalog update is a complete replacement, but durable history retains the catalogs it
 * supersedes. Compatibility providers do not serialize message sources, so remove only the older
 * catalogs when the newest catalog explicitly carries the replacement marker.
 */
function effectiveMessages(messages: readonly Message[]): readonly Message[] {
  let newestCatalog = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (skillCatalogSource(messages[index]!) !== undefined) {
      newestCatalog = index
      break
    }
  }
  if (newestCatalog < 0 || skillCatalogSource(messages[newestCatalog]!)?.update !== true) return messages
  return messages.filter((message, index) => index === newestCatalog || skillCatalogSource(message) === undefined)
}

/** Serialize one provider-neutral DSH call into a stateless coding-agent task. */
export function buildPrompt(options: GenerateOptions, maxPromptBytes: number): string {
  const tools = options.tools ?? []
  const request = {
    protocol: 'dsh-coding-subscription-provider/v1',
    instruction: tools.length === 0
      ? 'Continue the conversation as the assistant. Return only the next assistant response. Do not modify files or execute commands.'
      : `Continue the conversation as the assistant. Do not modify files, read files, execute commands, or invoke tools inside the coding CLI; treat CLI-native tools as unavailable in this backend session. Tools can only be used through DSH. If the task requires a tool, request the required tool now instead of describing a plan, claiming future work, asking for confirmation, or stopping early. For a tool request, return exactly one JSON object matching constraints.tools.responseFormat. The first output character must be { and the last must be }; do not add a preamble, progress update, explanation, Markdown fence, or any other text before or after the object. Do not supply a tool-call id; DSH assigns the trusted call id. When no tool is needed and the task is complete, return only the final assistant response as normal text.`,
    system: options.system ?? null,
    conversation: effectiveMessages(options.messages).map(serializeMessage),
    constraints: {
      tools: tools.length === 0
        ? { available: [] }
        : {
            responseProtocol: DSH_TOOL_CALL_PROTOCOL,
            responseFormat: {
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [{
                name: '<exact available tool name>',
                arguments: { '<argument name>': '<value matching that tool parameters schema>' },
              }],
            },
            available: tools,
          },
      stop: options.stop ?? null,
      maxTokens: options.maxTokens ?? null,
      temperature: options.temperature ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
      purpose: options.purpose ?? null,
    },
  }
  const prompt = `Act as a text model backend for DeepSeek Harness. The JSON request follows.\n${JSON.stringify(request)}`
  const size = Buffer.byteLength(prompt, 'utf8')
  if (size > maxPromptBytes) {
    throw new Error(
      `serialized DSH request is ${size} bytes; configured limit is ${maxPromptBytes}. `
      + 'Raise `maxPromptBytes` for this plugin if the request is legitimately this large.',
      { cause: 'prompt-limit' },
    )
  }
  return prompt
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function isLosslessJson(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const { value: current, depth } = pending.pop()!
    nodes += 1
    if (nodes > MAX_DELEGATED_JSON_NODES) return false
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      // JSON.parse rounds integers outside IEEE-754's safe range before the
      // ToolRuntime can validate them. Reject instead of silently changing an
      // identifier, timestamp, byte offset, or other exact tool argument.
      if (!Number.isFinite(current) || (Number.isInteger(current) && !Number.isSafeInteger(current))) return false
      continue
    }
    if (depth >= MAX_DELEGATED_JSON_DEPTH) return false
    if (Array.isArray(current)) {
      for (const item of current) pending.push({ value: item, depth: depth + 1 })
      continue
    }
    if (isRecord(current)) {
      for (const item of Object.values(current)) pending.push({ value: item, depth: depth + 1 })
      continue
    }
    return false
  }
  return true
}

function protocolError(message: string): Error {
  return new Error(message, { cause: 'protocol' })
}

interface DecodedEscape {
  readonly character: string
  readonly next: number
}

function decodePotentialJsonEscape(value: string, offset: number): DecodedEscape | undefined {
  const character = value[offset]
  if (character === undefined) return undefined
  if (character !== '\\') return { character, next: offset + 1 }
  const escape = value[offset + 1]
  if (escape === 'u') {
    const hex = value.slice(offset + 2, offset + 6)
    if (!/^[0-9a-f]{4}$/iu.test(hex)) return undefined
    return { character: String.fromCharCode(Number.parseInt(hex, 16)), next: offset + 6 }
  }
  const escapedCharacters: Readonly<Record<string, string>> = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
  }
  const decoded = escape === undefined ? undefined : escapedCharacters[escape]
  return decoded === undefined ? undefined : { character: decoded, next: offset + 2 }
}

function escapedProtocolAt(value: string, start: number): boolean {
  let offset = start
  for (const expected of DSH_TOOL_CALL_PROTOCOL) {
    const decoded = decodePotentialJsonEscape(value, offset)
    if (decoded === undefined || decoded.character !== expected) return false
    offset = decoded.next
  }
  return true
}

/** Detect the marker even in malformed/mixed output and regardless of JSON escapes.
 * This bounded scanner tests at most one fixed-length protocol candidate per byte;
 * it never extracts or accepts fenced output, it only makes such output fail closed. */
function mentionsDelegatedToolProtocol(response: string): boolean {
  // The stable stem also catches malformed double escaping such as `\\/`.
  if (response.includes('dsh-tool-calls')) return true
  for (let start = 0; start < response.length; start += 1) {
    if ((response[start] === 'd' || response[start] === '\\') && escapedProtocolAt(response, start)) return true
  }
  return false
}

/**
 * Decode one model-hidden tool envelope. Ordinary final text returns `undefined`;
 * any response that mentions this protocol but does not match it exactly fails closed.
 */
export function parseDelegatedToolCalls(
  response: string,
  tools: readonly ToolSchema[],
): readonly DelegatedToolCall[] | undefined {
  if (tools.length === 0) {
    if (mentionsDelegatedToolProtocol(response)) {
      throw protocolError('coding subscription provider returned a DSH tool call when no tools were available')
    }
    return undefined
  }

  let value: unknown
  try {
    value = JSON.parse(response.trim()) as unknown
  } catch {
    if (mentionsDelegatedToolProtocol(response)) {
      throw protocolError('coding subscription provider returned a malformed DSH tool-call envelope')
    }
    return undefined
  }

  if (!isRecord(value) || value.protocol !== DSH_TOOL_CALL_PROTOCOL) {
    if (mentionsDelegatedToolProtocol(response)) {
      throw protocolError('coding subscription provider returned an invalid DSH tool-call envelope')
    }
    return undefined
  }
  if (!hasExactKeys(value, ['protocol', 'calls'])
    || !Array.isArray(value.calls)
    || value.calls.length === 0
    || value.calls.length > MAX_DELEGATED_TOOL_CALLS) {
    throw protocolError('coding subscription provider returned an invalid DSH tool-call envelope')
  }

  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.name)) throw protocolError('coding subscription provider received duplicate DSH tool schemas')
    names.add(tool.name)
  }

  return value.calls.map((call): DelegatedToolCall => {
    if (!isRecord(call)
      || !hasExactKeys(call, ['name', 'arguments'])
      || typeof call.name !== 'string'
      || !names.has(call.name)
      || !isRecord(call.arguments)
      || !isLosslessJson(call.arguments)) {
      throw protocolError('coding subscription provider returned an invalid or unavailable DSH tool call')
    }
    return { name: call.name, arguments: JSON.stringify(call.arguments) }
  })
}
