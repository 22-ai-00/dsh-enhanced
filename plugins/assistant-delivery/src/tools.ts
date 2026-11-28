import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
    description: 'Import an exported plaintext Ray Home clone directory (or auto-detect and merge a ray-teaching-pack/v1 Teaching Pack) into this Ray instance while excluding raw credentials.',
    parameters: {
      source_dir: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!service.isOwnerSessionAgent(exec.agent)) {
        throw new Error('assistant-delivery: ray_home_import requires an authenticated owner session')
      }
      const raySelf = service.raySelfRuntime()
      if (raySelf === undefined) {
        throw new Error('assistant-delivery: Ray Home runtime is not active')
      }
      if (existsSync(join(args.source_dir, 'teaching-pack.json')) && typeof raySelf.importTeachingPack === 'function') {
        const res = await raySelf.importTeachingPack(args.source_dir)
        return JSON.parse(JSON.stringify({ mode: 'teaching-pack', ...res })) as Record<string, never>
      }
      if (raySelf.importClone === undefined) {
        throw new Error('assistant-delivery: Ray Home clone import is not available')
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

  const rayTeachExportTool = defineTool({
    name: 'ray_teach_export',
    description: 'Export a full-content ray-teaching-pack/v1 directory (plugins, skills, personal memories, episodes, reflections) while excluding raw credentials and Body Kernel.',
    parameters: {
      destination: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!service.isOwnerSessionAgent(exec.agent)) {
        throw new Error('assistant-delivery: ray_teach_export requires an authenticated owner session')
      }
      const raySelf = service.raySelfRuntime()
      if (raySelf?.exportTeachingPack === undefined) {
        throw new Error('assistant-delivery: Ray Home teaching-pack runtime is not active')
      }
      return JSON.parse(JSON.stringify(raySelf.exportTeachingPack(args.destination))) as Record<string, never>
    },
  })

  const rayTeachImportTool = defineTool({
    name: 'ray_teach_import',
    description: 'Import a ray-teaching-pack/v1 Teaching Pack: preserve recipient Ray identity/kernel/autobiography, re-verify taught plugins independently before adoption, stamp taught provenance, and merge capabilities & memories without downgrading newer versions.',
    parameters: {
      source_dir: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!service.isOwnerSessionAgent(exec.agent)) {
        throw new Error('assistant-delivery: ray_teach_import requires an authenticated owner session')
      }
      const raySelf = service.raySelfRuntime()
      if (raySelf?.importTeachingPack === undefined) {
        throw new Error('assistant-delivery: Ray Home teaching-pack runtime is not active')
      }
      return JSON.parse(JSON.stringify(await raySelf.importTeachingPack(args.source_dir))) as Record<string, never>
    },
  })

  if (service.raySelfRuntime() !== undefined) {
    for (const rayTool of [rayVetoTool, rayImportTool, rayTeachExportTool, rayTeachImportTool]) {
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

  const workerTickets = service.workerTicketsRuntime()
  if (workerTickets !== undefined) {
    const ticketDispatchTool = defineTool({
      name: 'ticket_dispatch',
      description: 'Dispatch a long-running or parallelizable task to a persistent recoverable Ray worker session and return immediately so the front conversation remains responsive.',
      parameters: {
        title: { type: 'string', required: true },
        objective: { type: 'string', required: true },
        scope_summary: { type: 'string' },
        token_budget: { type: 'integer' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ticketId: { type: 'string', required: true },
            sessionId: { type: 'string', required: true },
            title: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const ticket = await workerTickets.dispatchTicket(exec.agent, {
          title: args.title,
          objective: args.objective,
          ...(args.scope_summary === undefined ? {} : { scopeSummary: args.scope_summary }),
          ...(args.token_budget === undefined ? {} : { tokenBudget: args.token_budget }),
        })
        return {
          ticketId: ticket.ticketId,
          sessionId: ticket.sessionId,
          title: ticket.title,
          status: ticket.status,
        }
      },
    })

    const ticketListTool = defineTool({
      name: 'ticket_list',
      description: 'List Ray persistent worker tickets across channels with live status, token usage, handback reason, or result summary.',
      parameters: {
        status: { type: 'string', enum: ['running', 'completed', 'handed_back', 'failed'] },
        limit: { type: 'integer' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tickets: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ticketId: { type: 'string', required: true },
                  sessionId: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  usedTokens: { type: 'integer', required: true },
                  resultSummary: { type: 'string' },
                  handbackReason: { type: 'string' },
                  errorMessage: { type: 'string' },
                  narrationText: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (!service.isOwnerSessionAgent(exec.agent)) {
          throw new Error('assistant-delivery: ticket_list requires an authenticated owner front session')
        }
        const tickets = workerTickets.listTickets({
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        })
        return {
          tickets: tickets.map(t => ({
            ticketId: t.ticketId,
            sessionId: t.sessionId,
            title: t.title,
            status: t.status,
            usedTokens: t.usedTokens,
            ...(t.resultSummary === undefined ? {} : { resultSummary: t.resultSummary }),
            ...(t.handbackReason === undefined ? {} : { handbackReason: t.handbackReason }),
            ...(t.errorMessage === undefined ? {} : { errorMessage: t.errorMessage }),
            ...(t.narrationText === undefined ? {} : { narrationText: t.narrationText }),
          })),
        }
      },
    })

    const ticketFollowupTool = defineTool({
      name: 'ticket_followup',
      description: 'Route an owner interruption, clarification, or steering instruction to a persistent worker ticket via steer/followup without cancelling running work.',
      parameters: {
        ticket_id: { type: 'string', required: true },
        message: { type: 'string', required: true },
        mode: { type: 'string', enum: ['steer', 'followup'] },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ticketId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            deliveryMode: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const res = await workerTickets.followupTicket(exec.agent, {
          ticketId: args.ticket_id,
          message: args.message,
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        })
        return {
          ticketId: res.ticket.ticketId,
          status: res.ticket.status,
          deliveryMode: res.deliveryMode,
        }
      },
    })

    const ticketHandbackTool = defineTool({
      name: 'ticket_handback',
      description: 'Hand a worker ticket back to the front consciousness when requirements exceed scope or require owner clarification.',
      parameters: {
        reason: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        suggested_next_step: { type: 'string' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ticketId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            handbackReason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const ticket = await workerTickets.handbackTicket(exec.agent, {
          reason: args.reason,
          summary: args.summary,
          ...(args.suggested_next_step === undefined ? {} : { suggestedNextStep: args.suggested_next_step }),
        })
        return {
          ticketId: ticket.ticketId,
          status: ticket.status,
          handbackReason: ticket.handbackReason ?? args.reason,
        }
      },
    })

    for (const ownerTool of [ticketDispatchTool, ticketListTool, ticketFollowupTool]) {
      ctx.tools.register(ownerTool)
      if (typeof ctx.assistantPolicy?.registerPreauthorizedTool === 'function') {
        ctx.assistantPolicy.registerPreauthorizedTool(
          ctx,
          ownerTool,
          execution => service.isOwnerSessionAgent(execution.agent),
          { denialReason: `assistant-delivery: ${ownerTool.name} is restricted to authenticated owner front sessions` },
        )
      }
    }
    ctx.tools.register(ticketHandbackTool)
    if (typeof ctx.assistantPolicy?.registerPreauthorizedTool === 'function') {
      ctx.assistantPolicy.registerPreauthorizedTool(
        ctx,
        ticketHandbackTool,
        execution => service.ownsWorkerSessionAgent(execution.agent),
        { denialReason: 'assistant-delivery: ticket_handback is restricted to active persistent worker sessions' },
      )
    }
  }
}
