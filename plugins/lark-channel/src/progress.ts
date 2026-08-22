import type { DeliveryProgressIntent, DeliveryProgressUpdate } from '@dsh-enhanced/assistant-delivery'
import type { LarkProgressEvent, LarkProgressHandle, LarkTransport } from './types.js'

const MAX_EVENT_CONTENT_CHARS = 4_096
const MAX_VISIBLE_TEXT_CHARS = 1_500
let lastTimestamp = 0

function bounded(value: string, limit = MAX_VISIBLE_TEXT_CHARS): string {
  const characters = [...value]
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join('')}…`
}

function progressEvent(eventType: string, content: object): LarkProgressEvent {
  const encoded = JSON.stringify(content)
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
  return {
    eventType,
    content: encoded.length <= MAX_EVENT_CONTENT_CHARS
      ? encoded
      : JSON.stringify({ truncated: true }),
    timestamp: String(lastTimestamp),
  }
}

function textEvents(messageId: string, text: string): LarkProgressEvent[] {
  return [
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
): LarkProgressEvent[] {
  if (update.kind === 'started') return [
    progressEvent('RUN_STARTED', { threadId: chatId, runId: `delivery-${sequence}` }),
    ...textEvents(`status-${sequence}`, '正在分析请求并制定执行步骤…'),
  ]
  if (update.kind === 'step') {
    // A reasoning-only turn produces no tool or todo event, so this is the only content the panel
    // would ever get. Each step needs its own messageId: reusing one id would make every later
    // step overwrite the previous bubble instead of appending a new one.
    return update.text === '' ? [] : textEvents(`step-${sequence}-${step}`, update.text)
  }
  if (update.kind === 'tool-started') {
    const callId = bounded(update.callId, 256)
    const toolName = bounded(update.toolName, 240)
    return [
      progressEvent('TOOL_CALL_START', {
        toolCallId: callId,
        icon: 'default',
        title: `正在使用 ${toolName}`,
        toolCallName: toolName,
      }),
      progressEvent('TOOL_CALL_END', { toolCallId: callId }),
    ]
  }
  if (update.kind === 'tool-finished') return [progressEvent('TOOL_CALL_RESULT', {
    messageId: `result-${bounded(update.callId, 256)}`,
    toolCallId: bounded(update.callId, 256),
    role: 'tool',
    content: { type: 'code', code: update.failed ? '执行失败' : '已完成' },
    ...(update.failed ? { error: 'TOOL_FAILED' } : {}),
  })]
  if (update.kind === 'todos') {
    const text = todoText(update)
    return text === '' ? [] : textEvents(`todos-${sequence}-${step}`, text)
  }
  if (update.kind === 'completed') return [progressEvent('RUN_FINISHED', {
    threadId: chatId, runId: `delivery-${sequence}`, status: 'done',
  })]
  // A failed turn may have produced no step at all (the provider can fail before any output), so
  // state the failure in the panel body too; RUN_ERROR alone leaves the surface on its opening line.
  const code = update.code === undefined ? undefined : bounded(update.code, 80)
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
}

/** Serial, best-effort renderer for Feishu's native agent progress message. */
export class LarkProgressPresenter {
  private readonly runs = new Map<string, LiveProgress>()
  private readonly queues = new Map<string, Promise<void>>()
  private sequence = 0

  constructor(
    private readonly transport: LarkTransport,
    private readonly enabled: boolean,
    private readonly onFailure: (error: unknown) => void,
  ) {}

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
      const run = { handle, chatId: intent.target.conversation.chat, sequence: ++this.sequence, step: 0 }
      this.runs.set(key, run)
      await this.transport.writeProgress(handle, updateEvents(intent.update, run.chatId, run.sequence, run.step))
      return
    }
    const run = this.runs.get(key)
    if (run === undefined) return
    const terminal = intent.update.kind === 'completed' || intent.update.kind === 'failed'
    try {
      const events = updateEvents(intent.update, run.chatId, run.sequence, ++run.step)
      if (events.length > 0) await this.transport.writeProgress(run.handle, events)
    } finally {
      if (terminal) this.runs.delete(key)
    }
  }
}
