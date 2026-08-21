import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssistantHeartbeatService } from './service.js'

const output = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    id: { type: 'string' as const, required: true },
    automationId: { type: 'string' as const, required: true },
    status: { type: 'string' as const, required: true },
    empty: { type: 'boolean' as const, required: true },
    revision: { type: 'string' as const, required: true },
    automationVersion: { type: 'integer' as const, required: true },
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

export function registerHeartbeatTools(ctx: Context, service: AssistantHeartbeatService): void {
  ctx.tools.register(defineTool({
    name: 'heartbeat_status',
    description: 'Read content-free heartbeat state and the scratch revision for this exact Agent identity.',
    parameters: { heartbeat_id: { type: 'string', required: true } },
    output,
    async execute(args, exec) { return service.status(exec.agent, args.heartbeat_id) },
  }))
  ctx.tools.register(defineTool({
    name: 'heartbeat_scratch_update',
    description: 'Replace an owner heartbeat checklist using exact revision CAS. Policy authorization is required.',
    parameters: {
      heartbeat_id: { type: 'string', required: true },
      expected_revision: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output,
    async execute(args, exec) {
      return service.updateScratch(exec.agent, {
        heartbeatId: args.heartbeat_id,
        expectedRevision: args.expected_revision,
        content: args.content,
      })
    },
  }))
}
