import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PluginControlPlaneService } from './service.js'

export function registerPluginControlTools(ctx: Context, service: PluginControlPlaneService): void {
  ctx.tools.register(defineTool({ name: 'plugin_discover', description: 'Find signed-catalog plugin candidates by capability. Read-only; never installs anything.',
    parameters: { capability: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return { candidates: await service.discover(args.capability) } as never },
  }))
  ctx.tools.register(defineTool({ name: 'plugin_activation_plan', description: 'Create an owner-approval plan for one exact catalog candidate. It never installs, edits, or reloads a production profile.',
    parameters: { candidate_id: { type: 'string', required: true }, profile: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return await service.plan(args.candidate_id, args.profile) as never },
  }))
}
