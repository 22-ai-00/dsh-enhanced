// Non-live replacement for the assistant-isolation plugin.
//
// Mounting the real plugin performs a full native runtime-tree verification,
// which ordinary unit tests cannot provide. These tests only need the plugin's
// global tool surface to exist (Agent tool restriction rejects unknown names),
// so this module registers a bounded synthetic isolation_run tool and never
// starts a process. Live tests keep the real module.
import { defineTool } from '@deepseek-ai/dsh-tools'
import type * as isolation from '@dsh-enhanced/assistant-isolation'

export function syntheticIsolationModule(actual: typeof isolation): typeof isolation {
  return {
    ...actual,
    default: {
      name: 'synthetic-assistant-isolation',
      Config: actual.Config,
      inject: ['tools'],
      apply: async (ctx: { tools: { register(tool: unknown): void } }) => {
        ctx.tools.register(defineTool({
          name: 'isolation_run',
          description: 'Synthetic benchmark isolation runner for non-live tests. It records no process and produces no artifact.',
          parameters: {
            grant_id: { type: 'string', required: true },
            idempotency_key: { type: 'string', required: true },
            command: { type: 'string', required: true },
          },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
            render: () => [{ type: 'text', text: 'synthetic isolation result' }],
          },
          execute: async () => ({ result: 'synthetic isolation unavailable' }),
        }))
      },
    },
  } as unknown as typeof isolation
}
