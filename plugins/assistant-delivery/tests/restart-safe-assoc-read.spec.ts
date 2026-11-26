import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantDeliveryError, AssistantDeliveryService } from '../src/service.ts'

const roots: string[] = []
const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => {
    await ctx.fiber.restart()
    contexts.delete(ctx)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function makeTool(name: string) {
  return defineTool({
    name,
    description: `Test tool ${name}`,
    parameters: { id: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return { ok: true }
    },
  })
}

async function createRestartDeliveryHarness() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-restart-safe-assoc-'))
  roots.push(root)
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [],
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'),
    schedulerEnabled: false,
    defaultWorkspace: root,
    defaultAgentPreset: 'primary',
    agentProvider: 'fixture',
    agentModel: 'model',
    ownerRoutes: [{
      id: 'owner',
      conversation: { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm', chat: 'chat' },
      principal: { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' },
      workspace: root,
      agentPreset: 'primary',
      policyRef: 'owner-dm',
      minimumGeneration: 1,
    }],
    restart: {
      databasePath: join(root, 'restart.sqlite'),
      ownerRouteId: 'owner',
      maxModelRequests: 3,
      maxToolCalls: 2,
      taskTimeoutMs: 120_000,
      allowedTools: ['delivery_status', 'assoc_read'],
    },
  })
  const delivery = ctx.assistantDelivery
  expect(delivery.supportsPlannedRestart).toBe(true)
  return { ctx, delivery, viewer: { ctx } as Agent }
}

describe('registerRestartSafeTool assoc_read allowlist', () => {
  test('accepts live AssistantAssociationService and dsh-ray-assistant-association callers with idempotent disposer', async () => {
    const { ctx, delivery, viewer } = await createRestartDeliveryHarness()
    const assocRead = makeTool('assoc_read')

    let serviceCallerCtx: Context | undefined
    let loadingStateResult: (() => void) | undefined
    class AssistantAssociationService {
      static inject = ['tools'] as const
      constructor(callerCtx: Context) {
        serviceCallerCtx = callerCtx
        callerCtx.tools.register(assocRead)
        // Also verifies state === 1 (LOADING) during plugin apply/constructor.
        loadingStateResult = delivery.registerRestartSafeTool(callerCtx, assocRead)
      }
    }

    const serviceFiber = await ctx.plugin(AssistantAssociationService)
    expect(serviceCallerCtx?.fiber.name).toBe('AssistantAssociationService')
    expect(serviceCallerCtx?.fiber.state).toBe(2)
    expect(typeof loadingStateResult).toBe('function')
    expect(delivery.isRestartSafeTool(viewer, 'assoc_read')).toBe(true)

    // Calling the returned disposer removes the registration and is idempotent.
    loadingStateResult!()
    expect(delivery.isRestartSafeTool(viewer, 'assoc_read')).toBe(false)
    expect(() => loadingStateResult!()).not.toThrow()
    expect(delivery.isRestartSafeTool(viewer, 'assoc_read')).toBe(false)

    // Re-registering while ACTIVE (state === 2) succeeds and is revoked when fiber disposes.
    const activeDisposer = delivery.registerRestartSafeTool(serviceCallerCtx!, assocRead)
    expect(delivery.isRestartSafeTool(viewer, 'assoc_read')).toBe(true)
    await serviceFiber.dispose()
    expect(delivery.isRestartSafeTool(viewer, 'assoc_read')).toBe(false)
    expect(() => activeDisposer()).not.toThrow()

    // Also verifies module plugin name 'dsh-ray-assistant-association'.
    let moduleCallerCtx: Context | undefined
    const moduleFiber = await ctx.plugin({
      name: 'dsh-ray-assistant-association',
      inject: ['tools'],
      apply(callerCtx: Context) {
        moduleCallerCtx = callerCtx
        callerCtx.tools.register(assocRead)
      },
    })
    expect(moduleCallerCtx?.fiber.name).toBe('dsh-ray-assistant-association')
    expect(moduleCallerCtx?.fiber.state).toBe(2)
    const moduleDisposer = delivery.registerRestartSafeTool(moduleCallerCtx!, assocRead)
    expect(delivery.isRestartSafeTool(viewer, 'assoc_read')).toBe(true)
    moduleDisposer()
    expect(delivery.isRestartSafeTool(viewer, 'assoc_read')).toBe(false)
    expect(() => moduleDisposer()).not.toThrow()
    await moduleFiber.dispose()
  })

  test('rejects spoofed callers, root/disposed callers, and non-whitelisted tool names with runtime-conflict', async () => {
    const { ctx, delivery } = await createRestartDeliveryHarness()
    const assocRead = makeTool('assoc_read')

    // Root context has fiber.uid === null.
    expect(() => delivery.registerRestartSafeTool(ctx, assocRead)).toThrowError(AssistantDeliveryError)
    try {
      delivery.registerRestartSafeTool(ctx, assocRead)
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantDeliveryError)
      expect((error as AssistantDeliveryError).code).toBe('runtime-conflict')
    }

    // Spoofed caller fiber names cannot register 'assoc_read'.
    for (const spoofedName of ['SpoofedAssociationService', 'PersonalMemoryService', 'PersonalWikiService']) {
      let spoofedCtx: Context | undefined
      const fiber = await ctx.plugin({
        name: spoofedName,
        apply(callerCtx: Context) {
          spoofedCtx = callerCtx
        },
      })
      try {
        delivery.registerRestartSafeTool(spoofedCtx!, assocRead)
        expect.unreachable(`expected runtime-conflict for spoofed caller ${spoofedName}`)
      } catch (error) {
        expect(error).toBeInstanceOf(AssistantDeliveryError)
        expect((error as AssistantDeliveryError).code).toBe('runtime-conflict')
      }
      await fiber.dispose()
    }

    // Live trusted association fiber cannot register non-whitelisted tool names.
    let assocCtx: Context | undefined
    const assocFiber = await ctx.plugin({
      name: 'dsh-ray-assistant-association',
      apply(callerCtx: Context) {
        assocCtx = callerCtx
      },
    })
    for (const badToolName of ['assoc_write', 'memory_search', 'wiki_read', 'delivery_status', 'bash']) {
      try {
        delivery.registerRestartSafeTool(assocCtx!, makeTool(badToolName))
        expect.unreachable(`expected runtime-conflict for non-whitelisted tool ${badToolName}`)
      } catch (error) {
        expect(error).toBeInstanceOf(AssistantDeliveryError)
        expect((error as AssistantDeliveryError).code).toBe('runtime-conflict')
      }
    }

    // Disposed association fiber (state neither 1 nor 2) cannot register 'assoc_read'.
    await assocFiber.dispose()
    try {
      delivery.registerRestartSafeTool(assocCtx!, assocRead)
      expect.unreachable('expected runtime-conflict for disposed association fiber')
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantDeliveryError)
      expect((error as AssistantDeliveryError).code).toBe('runtime-conflict')
    }
  })
})
