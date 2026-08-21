import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryWikiBridgeService } from './service.js'

const proposalOutput = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    proposalId: { type: 'string' as const, required: true }, status: { type: 'string' as const, required: true },
    version: { type: 'integer' as const, required: true }, expiresAt: { type: 'integer' as const, required: true },
    summary: { type: 'string' as const, required: true }, diff: { type: 'string' as const, required: true },
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

export function registerMemoryWikiBridgeTools(ctx: Context, service: MemoryWikiBridgeService): void {
  ctx.tools.register(defineTool({
    name: 'knowledge_promote',
    description: 'Create an approval-gated derived Wiki proposal from exact selected Memory ids and versions.',
    parameters: {
      memory_ids: { type: 'array', required: true, items: { type: 'string' } },
      principal: { type: 'string', required: true }, title: { type: 'string', required: true },
      page_type: { type: 'string', required: true, enum: ['concept', 'decision', 'meta', 'person', 'project', 'question', 'source'] },
      status: { type: 'string', required: true, enum: ['active', 'archived', 'draft'] },
      tags: { type: 'array', required: true, items: { type: 'string' } },
      aliases: { type: 'array', required: true, items: { type: 'string' } },
      synthesis: { type: 'string', required: true }, operation: { type: 'string', required: true, enum: ['create', 'update'] },
      page_id: { type: 'string' }, expected_revision: { type: 'string' }, ttl_ms: { type: 'integer' },
    },
    output: proposalOutput,
    async execute(args, exec) {
      if (args.operation === 'update' && (args.page_id === undefined || args.expected_revision === undefined)) {
        throw new Error('knowledge_promote update requires page_id and expected_revision')
      }
      const value = service.promote(exec.agent, {
        memoryIds: args.memory_ids, principal: args.principal, title: args.title, type: args.page_type,
        status: args.status, tags: args.tags, aliases: args.aliases, synthesis: args.synthesis,
        target: args.operation === 'create' ? { op: 'create' } : {
          op: 'update', pageId: args.page_id!, expectedRevision: args.expected_revision!,
        },
        ...(args.ttl_ms === undefined ? {} : { ttlMs: args.ttl_ms }),
      })
      return { proposalId: value.proposalId, status: value.status, version: value.version,
        expiresAt: value.expiresAt, summary: value.summary, diff: value.diff }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_pin',
    description: 'Create an approval-gated Memory proposal from one exact Wiki revision and a bounded summary.',
    parameters: {
      wiki_ref: { type: 'string', required: true }, principal: { type: 'string', required: true },
      summary: { type: 'string', required: true }, owner: { type: 'string', required: true, enum: ['user', 'agent'] },
      scope: { type: 'string', required: true, enum: ['user-global', 'workspace'] },
      workspace: { type: 'string' }, agent_preset: { type: 'string' },
      kind: { type: 'string', required: true, enum: ['experience', 'fact', 'instruction', 'preference'] },
      ttl_ms: { type: 'integer' },
    },
    output: proposalOutput,
    async execute(args, exec) {
      const value = service.pin(exec.agent, {
        wikiRef: args.wiki_ref, principal: args.principal, summary: args.summary, kind: args.kind,
        identity: { owner: args.owner, scope: args.scope,
          ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
          ...(args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }) },
        ...(args.ttl_ms === undefined ? {} : { ttlMs: args.ttl_ms }),
      })
      return { proposalId: value.proposalId, status: value.status, version: value.version,
        expiresAt: value.expiresAt, summary: value.summary, diff: value.diff }
    },
  }))
}
