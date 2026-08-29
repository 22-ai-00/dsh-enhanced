import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

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
      throw new Error('TraeX ACP provider currently accepts text-only DSH requests')
    default:
      throw new Error(`TraeX ACP provider does not support content block type: ${String((block as { type?: unknown }).type)}`)
  }
}

function serializeMessage(message: Message): TranscriptMessage {
  return { role: message.role, content: message.content.map(serializeBlock) }
}

/** Serialize one provider-neutral DSH call into a stateless TraeX ACP turn. */
export function buildPrompt(options: GenerateOptions, maxPromptBytes: number): string {
  const tools = options.tools ?? []
  const request = {
    protocol: 'dsh-traex-acp-provider/v1',
    instruction: tools.length === 0
      ? 'Continue the conversation as the assistant. Return only the next assistant response. Do not modify files or execute commands.'
      : `Continue the conversation as the assistant. Do not modify files or execute commands inside TraeX and do not invoke TraeX-native tools; they are unavailable in this backend session. Tools can only be used through DSH. If the task requires a tool, request the required tool now instead of merely describing a plan, claiming future work, asking for confirmation, or stopping early. For a tool request, return exactly one JSON object matching constraints.tools.responseFormat. The first output character must be { and the last must be }; do not add a preamble, progress update, explanation, Markdown fence, or any other text before or after the object. When no tool is needed and the task is complete, return only the final assistant response as normal text.`,
    system: options.system ?? null,
    conversation: options.messages.map(serializeMessage),
    constraints: {
      tools: tools.length === 0
        ? { available: [] }
        : {
            responseProtocol: DSH_TOOL_CALL_PROTOCOL,
            responseFormat: {
              protocol: DSH_TOOL_CALL_PROTOCOL,
              calls: [{ name: '<exact available tool name>', arguments: '<JSON object matching that tool parameters schema>' }],
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
    if (!isRecord(call) || typeof call.name !== 'string' || !names.has(call.name) || !isRecord(call.arguments)) {
      throw new Error('TraeX returned an invalid or unavailable DSH tool call', { cause: 'protocol' })
    }
    return { name: call.name, arguments: JSON.stringify(call.arguments) }
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
