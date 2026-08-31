import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PluginControlPlaneService } from './service.js'

export function registerPluginControlTools(ctx: Context, service: PluginControlPlaneService): void {
  ctx.tools.register(defineTool({ name: 'plugin_discover', description: 'Find owner-provided integrity-pinned plugin candidates by capability. The catalog is not claimed to be signature-verified; this tool never installs anything.',
    parameters: { capability: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return { candidates: await service.discover(args.capability) } as never },
  }))
  ctx.tools.register(defineTool({ name: 'plugin_capability_gap', description: 'Record one durable capability gap and its bounded ROI inputs. This never installs or modifies a profile.',
    parameters: {
      idempotency_key: { type: 'string', required: true }, capability: { type: 'string', required: true },
      context: { type: 'string', required: true }, expected_value: { type: 'number', required: true },
      frequency: { type: 'number', required: true }, estimated_cost: { type: 'number', required: true }, risk: { type: 'number', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return service.recordGap({
      idempotencyKey: args.idempotency_key, capability: args.capability, context: args.context,
      expectedValue: args.expected_value, frequency: args.frequency, estimatedCost: args.estimated_cost, risk: args.risk,
    }) as never },
  }))
  ctx.tools.register(defineTool({ name: 'plugin_gap_rankings', description: 'List durable open capability gaps in bounded descending ROI order. Read-only.',
    parameters: { limit: { type: 'number', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { gaps: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return { gaps: service.gaps(args.limit) } as never },
  }))
  ctx.tools.register(defineTool({ name: 'plugin_activation_plan', description: 'Create an owner-approval plan for one exact catalog candidate. It never installs, edits, or reloads a production profile.',
    parameters: { candidate_id: { type: 'string', required: true }, profile: { type: 'string', required: true },
      idempotency_key: { type: 'string', required: true }, gap_id: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return await service.plan(args.candidate_id, args.profile, args.idempotency_key, args.gap_id) as never },
  }))
}
