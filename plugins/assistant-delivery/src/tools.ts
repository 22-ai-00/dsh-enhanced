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

  const rayVetoTool = defineTool({
    name: 'ray_owner_veto',
    description: 'Execute an owner-authorized 1-turn veto against Ray recent self-evolution or self-authored capability and restore prior state immediately.',
    parameters: {
      target_entry_id: { type: 'string' },
      target_capability_id: { type: 'string' },
      reason: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          version: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
          revertedCapabilityId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!service.isOwnerSessionAgent(exec.agent)) {
        throw new Error('assistant-delivery: ray_owner_veto requires an authenticated owner session')
      }
      const raySelf = service.raySelfRuntime()
      if (raySelf?.vetoByOwner === undefined) {
        throw new Error('assistant-delivery: Ray Home runtime is not active')
      }
      const res = await raySelf.vetoByOwner({
        ...(args.target_entry_id ? { targetEntryId: args.target_entry_id } : {}),
        ...(args.target_capability_id ? { targetCapabilityId: args.target_capability_id } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
        ownerProof: `owner:tool:${String(exec.agent?.session?.id ?? 'unknown')}`,
      })
      return {
        ok: res.ok,
        name: res.selfModel.name,
        version: res.selfModel.version,
        summary: res.autobiographyEntry.summary,
        ...(res.revertedCapabilityId === undefined ? {} : { revertedCapabilityId: res.revertedCapabilityId }),
      }
    },
  })

  const rayImportTool = defineTool({
    name: 'ray_home_import',
    description: 'Import an exported plaintext Ray Home clone directory into this Ray instance while excluding raw credentials and listing any credentials requiring owner re-authentication.',
    parameters: {
      source_dir: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rayId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          importedFiles: { type: 'integer', required: true },
          missingCredentials: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                service: { type: 'string', required: true },
                label: { type: 'string' },
                required: { type: 'boolean', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!service.isOwnerSessionAgent(exec.agent)) {
        throw new Error('assistant-delivery: ray_home_import requires an authenticated owner session')
      }
      const raySelf = service.raySelfRuntime()
      if (raySelf?.importClone === undefined) {
        throw new Error('assistant-delivery: Ray Home runtime is not active')
      }
      const res = raySelf.importClone(args.source_dir)
      return {
        ok: res.ok,
        rayId: res.rayId,
        name: res.name,
        importedFiles: res.importedFiles,
        missingCredentials: res.missingCredentials.map(c => ({
          id: c.id,
          service: c.service,
          ...(c.label === undefined ? {} : { label: c.label }),
          required: c.required,
          reason: c.reason,
        })),
      }
    },
  })

  if (service.raySelfRuntime() !== undefined) {
    for (const rayTool of [rayVetoTool, rayImportTool]) {
      ctx.tools.register(rayTool)
      if (typeof ctx.assistantPolicy?.registerPreauthorizedTool === 'function') {
        ctx.assistantPolicy.registerPreauthorizedTool(
          ctx,
          rayTool,
          execution => service.isOwnerSessionAgent(execution.agent),
          { denialReason: `assistant-delivery: ${rayTool.name} is restricted to authenticated owner sessions` },
        )
      }
    }
  }
}
