import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssistantDeliveryService } from './service.js'

export function registerDeliveryTools(ctx: Context, service: AssistantDeliveryService): void {
  if (service.supportsPlannedRestart) {
    const restart = defineTool({
    name: 'delivery_request_restart',
    description: 'Request one owner-authorized planned restart of the serving Host. Saves the current task and resumes it automatically after readiness. Use only when a restart is necessary; never restart the serving process through a shell. This successful tool ends the current turn.',
    parameters: { reason: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, status: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const result = service.requestRestart(exec.agent, args.reason)
      exec.concludeTurn()
      return result
    },
    })
    ctx.tools.register(restart)
    ctx.assistantPolicy.registerPreauthorizedTool(ctx, restart,
      execution => service.canRequestRestart(execution.agent),
      { denialReason: 'assistant-delivery: planned restart is outside the current owner task authority' })
  }
  ctx.tools.register(defineTool({
    name: 'delivery_reply',
    description: 'Persist one reply to the current verified channel binding. The target cannot be overridden.',
    parameters: {
      idempotency_key: { type: 'string', required: true },
      text: { type: 'string', required: true },
      format: { type: 'string', enum: ['plain', 'markdown'] },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, status: { type: 'string', required: true },
        createdAt: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const value = service.reply(exec.agent, { idempotencyKey: args.idempotency_key, text: args.text,
        format: args.format ?? 'plain' })
      return { id: value.id, status: value.status, createdAt: value.createdAt }
    },
  }))

  const status = defineTool({
    name: 'delivery_status',
    description: 'Read bounded status metadata for the current binding without message bodies or route identifiers.',
    parameters: { limit: { type: 'integer' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        generation: { type: 'integer', required: true },
        inbox: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, status: { type: 'string', required: true },
          receivedAt: { type: 'integer', required: true }, failureCode: { type: 'string' },
        } } },
        outbox: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, status: { type: 'string', required: true },
          createdAt: { type: 'integer', required: true }, failureCode: { type: 'string' },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const value = service.history(exec.agent, args.limit === undefined ? {} : { limit: args.limit })
      return {
        generation: value.binding.generation,
        inbox: value.inbox.map(item => ({ id: item.id, status: item.status, receivedAt: item.receivedAt,
          ...(item.failureCode === undefined ? {} : { failureCode: item.failureCode }) })),
        outbox: value.outbox.map(item => ({ id: item.id, status: item.status, createdAt: item.createdAt,
          ...(item.failureCode === undefined ? {} : { failureCode: item.failureCode }) })),
      }
    },
  })
  ctx.tools.register(status)
  service.registerRestartSafeTool(ctx, status)
}
