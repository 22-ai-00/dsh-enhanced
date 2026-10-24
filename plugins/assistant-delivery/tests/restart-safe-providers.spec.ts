import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { PersonalMemoryService } from '../../personal-memory/lib/index.js'
import { PersonalWikiService } from '../../personal-wiki/lib/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'

test('real Wiki and Memory providers register exact restart-safe definitions and revoke them on disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-restart-safe-providers-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
      defaultWorkspace: root, defaultAgentPreset: 'primary', agentProvider: 'fixture', agentModel: 'model',
      ownerRoutes: [{ id: 'owner',
        conversation: { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm', chat: 'chat' },
        principal: { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' },
        workspace: root, agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }],
      restart: { databasePath: join(root, 'restart.sqlite'), ownerRouteId: 'owner',
        maxModelRequests: 3, maxToolCalls: 2, taskTimeoutMs: 120_000,
        allowedTools: ['delivery_status', 'wiki_search', 'wiki_read', 'memory_search'] },
    })
    const wiki = await ctx.plugin(PersonalWikiService, {
      vaultRoot: join(root, 'vault'), databasePath: join(root, 'wiki.sqlite'), reconcileIntervalMs: 0,
    })
    const memory = await ctx.plugin(PersonalMemoryService, {
      databasePath: join(root, 'memory.sqlite'), reconcileIntervalMs: 0,
    })
    // Only the public tool registry and Delivery's public predicate are used;
    // no model or Agent lifecycle is needed to inspect this global tool view.
    const viewer = { ctx } as Agent
    const delivery = ctx.assistantDelivery
    for (const name of ['delivery_status', 'wiki_search', 'wiki_read', 'memory_search']) {
      expect(ctx.tools.get(name, viewer), name).toBeDefined()
      expect(delivery.isRestartSafeTool(viewer, name), name).toBe(true)
    }
    await wiki.dispose()
    for (const name of ['wiki_search', 'wiki_read']) {
      expect(ctx.tools.get(name, viewer), name).toBeUndefined()
      expect(delivery.isRestartSafeTool(viewer, name), name).toBe(false)
    }
    expect(delivery.isRestartSafeTool(viewer, 'memory_search')).toBe(true)
    expect(delivery.isRestartSafeTool(viewer, 'delivery_status')).toBe(true)
    await memory.dispose()
    expect(ctx.tools.get('memory_search', viewer)).toBeUndefined()
    expect(delivery.isRestartSafeTool(viewer, 'memory_search')).toBe(false)
    expect(delivery.isRestartSafeTool(viewer, 'delivery_status')).toBe(true)
  } finally {
    await ctx.fiber.restart()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
