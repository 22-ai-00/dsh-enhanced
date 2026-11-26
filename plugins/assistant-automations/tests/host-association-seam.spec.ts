import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantAutomationsService } from '../src/service.ts'
import type { AutomationDefinitionChangeEvent } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function agentAutomationDef(overrides: {
  name: string
  workspace?: string
  agentPreset?: string
  principal?: string
}) {
  return {
    name: overrides.name,
    prompt: 'Run scheduled review.',
    schedule: { kind: 'at' as const, at: '2035-01-01T00:00:00.000Z' },
    workspace: overrides.workspace ?? '/work/alpha',
    agentPreset: overrides.agentPreset ?? 'primary',
    provider: 'mock',
    model: 'mock-model',
    allowedTools: [],
    timeoutMs: 60_000,
    maxOutputTokens: 256,
    maxToolCalls: 0,
    misfire: { kind: 'latest' as const },
    overlap: 'skip' as const,
    retrySafety: 'never' as const,
    maxRetries: 0,
    principal: overrides.principal ?? 'owner:lark:1',
  }
}

describe('assistant-automations host association seam', () => {
  test('inspectOwnerAutomations filters strictly by (workspace, agentPreset, principalId) and onDefinitionChange fires post-commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-host-'))
    roots.push(root)
    const ctx = new Context()
    new AssistantPolicyService(ctx, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [{
        id: 'allow-reconcile',
        effect: 'allow',
        subject: { kind: 'background', id: 'sys-owner', workspace: '/work/alpha', principal: 'owner:lark:1' },
        actions: ['reconcile'],
        resource: { kind: 'automation', id: '*' },
        context: { initiators: ['background'] },
      }],
    })
    const service = new AssistantAutomationsService(ctx, {
      databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'),
      schedulerEnabled: false,
      reconcileIntervalMs: 0,
    })

    const events: AutomationDefinitionChangeEvent[] = []
    const unsub = service.onDefinitionChange(event => events.push(event))

    const store = (service as unknown as {
      store: {
        createApproved: (input: { automationId: string; idempotencyKey: string; definition: unknown }) => { id: string; version: number }
        getDefinitionHash: (id: string) => string
        changeApproved: (input: { automationId: string; operation: 'delete' | 'pause' | 'resume'; expectedVersion: number; idempotencyKey: string }) => { id: string; version: number; status: string }
      }
    }).store

    const created1 = store.createApproved({
      automationId: 'auto-owner-1',
      idempotencyKey: 'create-1',
      definition: agentAutomationDef({ name: 'Owner 1 job' }),
    })
    store.createApproved({
      automationId: 'auto-other-owner',
      idempotencyKey: 'create-2',
      definition: agentAutomationDef({ name: 'Owner 2 job', principal: 'owner:lark:2' }),
    })
    store.createApproved({
      automationId: 'auto-other-workspace',
      idempotencyKey: 'create-3',
      definition: agentAutomationDef({ name: 'Other ws job', workspace: '/work/beta' }),
    })

    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({
      automationId: 'auto-owner-1',
      status: 'active',
      version: 1,
      workspace: '/work/alpha',
      agentPreset: 'primary',
      principal: 'owner:lark:1',
    })

    const inspected = service.inspectOwnerAutomations({
      principalId: 'owner:lark:1',
      workspace: '/work/alpha',
      preset: 'primary',
    })
    expect(inspected.map(r => r.id)).toEqual(['auto-owner-1'])

    // System-owned reconcile + pause + delete
    const sys = service.reconcileSystem({
      owner: 'sys-owner',
      automationId: 'sys-auto-1',
      idempotencyKey: 'reconcile-1',
      desiredStatus: 'active',
      definition: agentAutomationDef({ name: 'System job' }),
    })
    expect(events).toHaveLength(4)
    expect(events[3]?.automationId).toBe('sys-auto-1')

    service.pauseSystemOwned({
      owner: 'sys-owner',
      operationId: 'pause-1',
      automationId: 'sys-auto-1',
      definitionHash: store.getDefinitionHash('sys-auto-1'),
      expectedVersion: sys.version,
    })
    expect(events).toHaveLength(5)
    expect(events[4]).toMatchObject({ automationId: 'sys-auto-1', status: 'paused', version: 2 })

    // User automation delete
    store.changeApproved({
      automationId: 'auto-owner-1',
      operation: 'delete',
      expectedVersion: created1.version,
      idempotencyKey: 'del-1',
    })
    expect(events).toHaveLength(6)
    expect(events[5]).toMatchObject({ automationId: 'auto-owner-1', status: 'deleted', version: 2 })

    unsub()
    await ctx.fiber.dispose()
  })
})
