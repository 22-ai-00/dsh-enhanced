import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

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
        content: block.content.map(serializeBlock),
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
  const request = {
    protocol: 'dsh-traex-acp-provider/v1',
    instruction: 'Continue the conversation as the assistant. Return only the next assistant response. Do not modify files or execute commands.',
    system: options.system ?? null,
    conversation: options.messages.map(serializeMessage),
    constraints: {
      tools: 'DSH tool schemas are not delegated through this text compatibility adapter.',
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
    throw new Error(`serialized DSH request is ${size} bytes; configured limit is ${maxPromptBytes}`)
  }
  return prompt
}
