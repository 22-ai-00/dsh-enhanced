import type {
  ContentBlock as AcpContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from '@agentclientprotocol/sdk'
import type { ContentBlock as DshContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-todo'

export interface SessionEventMapper {
  map(event: SessionEvent): SessionUpdate[]
}

function rawMeta(event: SessionEvent): NonNullable<SessionUpdate['_meta']> {
  return { dsh: { event } }
}

function textContent(text: string): AcpContentBlock {
  return { type: 'text', text }
}

function imageFallback(block: Extract<DshContentBlock, { type: 'image' }>): AcpContentBlock {
  return {
    type: 'text',
    text: `[DSH image attachment ${block.attachment.attachmentId}]`,
    _meta: { dsh: { attachment: block.attachment } },
  }
}

function toolContent(block: DshContentBlock): ToolCallContent | undefined {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return { type: 'content', content: textContent(block.text) }
    case 'image':
      return { type: 'content', content: imageFallback(block) }
    case 'tool-call':
    case 'tool-result':
      return undefined
    default:
      return undefined
  }
}

function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase()
  if (/(^|_)(read|view|get|open)(_|$)/.test(normalized)) return 'read'
  if (/(^|_)(write|edit|patch|replace|create)(_|$)/.test(normalized)) return 'edit'
  if (/(^|_)(delete|remove)(_|$)/.test(normalized)) return 'delete'
  if (/(^|_)(move|rename)(_|$)/.test(normalized)) return 'move'
  if (/(^|_)(search|find|grep|glob|list)(_|$)/.test(normalized)) return 'search'
  if (/(^|_)(exec|execute|shell|bash|terminal|command|run)(_|$)/.test(normalized)) return 'execute'
  if (/(^|_)(fetch|web|http|download)(_|$)/.test(normalized)) return 'fetch'
  if (/(^|_)(think|todo|plan)(_|$)/.test(normalized)) return 'think'
  if (/(^|_)(mode|switch)(_|$)/.test(normalized)) return 'switch_mode'
  return 'other'
}

function rawInput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function traceOnly(event: SessionEvent, includeRawEvents: boolean): SessionUpdate[] {
  return includeRawEvents
    ? [{ sessionUpdate: 'session_info_update', _meta: rawMeta(event) }]
    : []
}

export function createSessionEventMapper(
  config: { includeRawEvents: boolean },
): SessionEventMapper {
  let contextWindow: number | undefined

  return {
    map(event): SessionUpdate[] {
      switch (event.type) {
        case 'request/context':
          contextWindow = event.data.contextWindow
          return traceOnly(event, config.includeRawEvents)

        case 'assistant/message': {
          const updates: SessionUpdate[] = []
          for (const block of event.data.message.content) {
            if (block.type === 'text' && block.text.length > 0) {
              updates.push({
                sessionUpdate: 'agent_message_chunk',
                content: textContent(block.text),
                messageId: event.data.message.id,
                _meta: rawMeta(event),
              })
            } else if (block.type === 'reasoning' && block.text.length > 0) {
              updates.push({
                sessionUpdate: 'agent_thought_chunk',
                content: textContent(block.text),
                messageId: event.data.message.id,
                _meta: rawMeta(event),
              })
            } else if (block.type === 'image') {
              updates.push({
                sessionUpdate: 'agent_message_chunk',
                content: imageFallback(block),
                messageId: event.data.message.id,
                _meta: rawMeta(event),
              })
            }
          }
          const usage = event.data.usage
          if (usage !== undefined) {
            const used = usage.inputTokens
              + usage.outputTokens
              + (usage.cacheReadTokens ?? 0)
              + (usage.cacheWriteTokens ?? 0)
            updates.push({
              sessionUpdate: 'usage_update',
              size: Math.max(contextWindow ?? used, used),
              used,
              _meta: { dsh: { event, usage } },
            })
          }
          return updates.length > 0 ? updates : traceOnly(event, config.includeRawEvents)
        }

        case 'tool/call':
          return [{
            sessionUpdate: 'tool_call',
            toolCallId: event.data.callId,
            title: event.data.name,
            kind: toolKind(event.data.name),
            status: 'in_progress',
            rawInput: rawInput(event.data.arguments),
            _meta: rawMeta(event),
          }]

        case 'tool/result': {
          const result = event.data.message.content[0]
          const content = result.content.flatMap((block) => {
            const mapped = toolContent(block)
            return mapped === undefined ? [] : [mapped]
          })
          return [{
            sessionUpdate: 'tool_call_update',
            toolCallId: result.toolCallId,
            status: result.isError === true || event.data.error !== undefined ? 'failed' : 'completed',
            content,
            rawOutput: {
              message: event.data.message,
              ...(event.data.error === undefined ? {} : { error: event.data.error }),
              ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
            },
            _meta: rawMeta(event),
          }]
        }

        case 'todo/write':
          return [{
            sessionUpdate: 'plan',
            entries: event.data.todos.map(todo => ({
              content: todo.content,
              status: todo.status,
              priority: 'medium',
            })),
            _meta: rawMeta(event),
          }]

        case 'agent-preset/selected':
          return [{
            sessionUpdate: 'current_mode_update',
            currentModeId: event.data.agentPreset,
            _meta: rawMeta(event),
          }]

        case 'session/title':
          return [{
            sessionUpdate: 'session_info_update',
            title: event.data.title,
            updatedAt: new Date(event.time).toISOString(),
            _meta: rawMeta(event),
          }]

        default:
          return traceOnly(event, config.includeRawEvents)
      }
    },
  }
}
