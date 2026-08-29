import { createHash } from 'node:crypto'
import type { DeliveryProgressIntent, DeliveryProgressUpdate } from '@dsh-enhanced/assistant-delivery'
import type { LarkProgressEvent, LarkProgressHandle, LarkTransport } from './types.js'

const MAX_EVENT_CONTENT_CHARS = 4_096
const MAX_VISIBLE_TEXT_CHARS = 1_500
let lastTimestamp = 0

function bounded(value: string, limit = MAX_VISIBLE_TEXT_CHARS): string {
  const characters = [...value]
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join('')}…`
}

function boundedLabel(value: string, limit: number): string {
  return bounded(value.replace(/[\p{Cc}\p{Cf}]/gu, '�'), limit)
}

/** Preserve ordinary provider ids while making truncation and control cleanup collision-resistant. */
function progressIdentity(value: string, limit = 240): string {
  const characters = [...value]
  if (value !== '' && characters.length <= limit && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return value
  const safe = value.replace(/[^A-Za-z0-9._:-]/gu, '_')
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16)
  const suffix = `-${digest}`
  const prefix = [...safe].slice(0, Math.max(0, limit - suffix.length)).join('') || 'call'
  return `${prefix}${suffix}`
}

function encodedWithBoundedText(
  value: string,
  replace: (text: string) => Record<string, unknown>,
): string | undefined {
  const characters = [...value]
  let low = 0
  let high = characters.length
  let accepted: string | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const text = middle === characters.length
      ? value
      : `${characters.slice(0, Math.max(0, middle - 1)).join('')}…`
    const encoded = JSON.stringify({ ...replace(text), truncated: true })
    if (encoded.length <= MAX_EVENT_CONTENT_CHARS) {
      accepted = encoded
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return accepted
}

function progressEvent(eventType: string, content: object): LarkProgressEvent {
  let encoded = JSON.stringify(content)
  if (encoded.length > MAX_EVENT_CONTENT_CHARS) {
    const record = content as Record<string, unknown>
    if (typeof record.delta === 'string') {
      encoded = encodedWithBoundedText(record.delta, delta => ({ ...record, delta }))
        ?? JSON.stringify({ truncated: true })
    } else if (record.content !== null && typeof record.content === 'object'
      && typeof (record.content as Record<string, unknown>).code === 'string') {
      const nested = record.content as Record<string, unknown>
      encoded = encodedWithBoundedText(nested.code as string, code => ({
        ...record,
        content: { ...nested, code },
      })) ?? JSON.stringify({ truncated: true })
    } else if (typeof record.message === 'string') {
      encoded = encodedWithBoundedText(record.message, message => ({ ...record, message }))
        ?? JSON.stringify({ truncated: true })
    } else {
      encoded = JSON.stringify({ truncated: true })
    }
  }
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
  return {
    eventType,
    content: encoded,
    timestamp: String(lastTimestamp),
  }
}

function textEvents(messageId: string, text: string): LarkProgressEvent[] {
  return [
    // `message_cot` has two independent payload conventions. Its HTTP envelope
    // is OpenAPI snake_case, while each event's JSON `content` is an AG-UI event
    // payload and therefore uses its camelCase fields. Sending OpenAPI-shaped
    // JSON here makes Feishu render that JSON literally instead of a COT bubble.
    progressEvent('TEXT_MESSAGE_START', { messageId, role: 'assistant' }),
    progressEvent('TEXT_MESSAGE_CONTENT', { messageId, delta: bounded(text) }),
    progressEvent('TEXT_MESSAGE_END', { messageId }),
  ]
}

function todoText(update: Extract<DeliveryProgressUpdate, { kind: 'todos' }>): string {
  const marker = { pending: '⏳', in_progress: '🔄', completed: '✅' } as const
  return update.todos.slice(0, 20)
    .map(todo => `${marker[todo.status]} ${bounded(todo.content, 240)}`)
    .join('\n')
}

function updateEvents(
  update: DeliveryProgressUpdate,
  chatId: string,
  sequence: number,
  step: number,
  showDetails: boolean,
): LarkProgressEvent[] {
  if (update.kind === 'started') return [
    progressEvent('RUN_STARTED', { threadId: chatId, runId: `delivery-${sequence}` }),
    ...textEvents(`status-${sequence}`, '正在分析请求并制定执行步骤…'),
  ]
  if (update.kind === 'step') {
    // A turn may produce no tool or todo event, so its neutral phase can be the only panel content.
    // Each step needs its own messageId: reusing one id would make every later step overwrite the
    // previous bubble instead of appending a new one.
    return update.text === '' ? [] : textEvents(`step-${sequence}-${step}`, update.text)
  }
  if (update.kind === 'tool-started') {
    const callId = progressIdentity(update.callId)
    const toolName = boundedLabel(update.toolName, 240)
    return [
      progressEvent('TOOL_CALL_START', {
        toolCallId: callId,
        icon: 'default',
        title: `正在使用 ${toolName}`,
        toolCallName: toolName,
      }),
      ...(showDetails && update.argumentsPreview !== undefined
        ? [progressEvent('TOOL_CALL_ARGS', {
            toolCallId: callId,
            delta: bounded(update.argumentsPreview),
          })]
        : []),
      progressEvent('TOOL_CALL_END', { toolCallId: callId }),
    ]
  }
  if (update.kind === 'tool-finished') {
    const callId = progressIdentity(update.callId)
    return [progressEvent('TOOL_CALL_RESULT', {
      messageId: `result-${callId}`,
      toolCallId: callId,
      role: 'tool',
      content: {
        type: 'code',
        code: showDetails && update.resultPreview !== undefined
          ? bounded(update.resultPreview)
          : (update.failed ? '执行失败' : '已完成'),
      },
      ...(update.failed ? { error: showDetails
        ? boundedLabel(update.code ?? 'TOOL_FAILED', 80)
        : 'TOOL_FAILED' } : {}),
    })]
  }
  if (update.kind === 'todos') {
    const text = todoText(update)
    return text === '' ? [] : textEvents(`todos-${sequence}-${step}`, text)
  }
  if (update.kind === 'completed') return [progressEvent('RUN_FINISHED', {
    threadId: chatId, runId: `delivery-${sequence}`, status: 'done',
  })]
  // A failed turn may have produced no step at all (the provider can fail before any output), so
  // state the failure in the panel body too; RUN_ERROR alone leaves the surface on its opening line.
  const code = !showDetails || update.code === undefined ? undefined : boundedLabel(update.code, 80)
  return [
    ...textEvents(`failed-${sequence}-${step}`,
      code === undefined ? '任务未完成' : `任务未完成（${code}）`),
    progressEvent('RUN_ERROR', {
      message: code === undefined ? '任务未完成' : `任务未完成：${code}`,
      code: 'TASK_FAILED',
    }),
  ]
}

interface LiveProgress {
  handle: LarkProgressHandle
  chatId: string
  sequence: number
  /** Monotonic per-run counter that keeps each appended step/todo bubble on its own messageId. */
  step: number
  /** Detail authority is fixed when the provider handle is created; later intents cannot widen it. */
  showDetails: boolean
  targetKey: string
}

/** Serial, best-effort renderer for Feishu's native agent progress message. */
export class LarkProgressPresenter {
  private readonly runs = new Map<string, LiveProgress>()
  private readonly queues = new Map<string, Promise<void>>()
  private sequence = 0

  constructor(
    private readonly transport: LarkTransport,
    private readonly enabled: boolean,
    private readonly details: 'off' | 'direct',
    private readonly onFailure: (error: unknown) => void,
  ) {}

  private showDetails(intent: Readonly<DeliveryProgressIntent>): boolean {
    return this.details === 'direct' && intent.target.conversation.kind === 'dm'
  }

  async publish(intent: Readonly<DeliveryProgressIntent>): Promise<void> {
    if (!this.enabled) return
    const key = JSON.stringify([intent.bindingId, intent.eventId])
    const previous = this.queues.get(key) ?? Promise.resolve()
    const current = previous.then(() => this.apply(key, intent)).catch(this.onFailure)
    this.queues.set(key, current)
    await current
    if ((intent.update.kind === 'completed' || intent.update.kind === 'failed')
      && this.queues.get(key) === current) this.queues.delete(key)
  }

  private async apply(key: string, intent: Readonly<DeliveryProgressIntent>): Promise<void> {
    if (intent.update.kind === 'started') {
      if (this.runs.has(key)) return
      const handle = await this.transport.createProgress(intent.target.conversation.chat, {
        replyTo: intent.eventId,
        hidden: false,
      })
      const run = {
        handle,
        chatId: intent.target.conversation.chat,
        sequence: ++this.sequence,
        step: 0,
        showDetails: this.showDetails(intent),
        targetKey: JSON.stringify(intent.target),
      }
      this.runs.set(key, run)
      await this.transport.writeProgress(handle, updateEvents(
        intent.update,
        run.chatId,
        run.sequence,
        run.step,
        run.showDetails,
      ))
      return
    }
    const run = this.runs.get(key)
    if (run === undefined) return
    const terminal = intent.update.kind === 'completed' || intent.update.kind === 'failed'
    try {
      const events = updateEvents(
        intent.update,
        run.chatId,
        run.sequence,
        ++run.step,
        run.showDetails && run.targetKey === JSON.stringify(intent.target),
      )
      if (events.length > 0) await this.transport.writeProgress(run.handle, events)
    } finally {
      if (terminal) this.runs.delete(key)
    }
  }
}
