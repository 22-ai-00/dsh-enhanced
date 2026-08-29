import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantEvolutionService } from '@dsh-enhanced/assistant-evolution'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../plugins/assistant-delivery/src/store.ts'
import { configureSupervisedGrowthProfilePatch } from '../plugins/lark-channel/src/supervised-growth-profile.ts'

const roots: string[] = []
const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function effectiveConfig(input: {
  root: string
  workspace: string
  policyPath: string
  deliveryPath: string
  evolutionPath: string
}): string {
  return `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy:
      databasePath: ${input.policyPath}
      proposalMaintenanceIntervalMs: 0
      rules: []
      budgets: []
    assistantAutomations:
      databasePath: ${input.root}/automations.sqlite
      runsPath: ${input.root}/runs
      schedulerEnabled: false
- id: dsh-enhanced-assistant-delivery
  config:
    databasePath: ${input.deliveryPath}
    spoolPath: ${input.root}/spool
    schedulerEnabled: false
    defaultWorkspace: ${input.workspace}
    defaultAgentPreset: standard
    agentProvider: deepseek-official
    agentModel: default
- id: dsh-enhanced-lark-channel
  config: { enabled: true, account: primary, tenant: personal }
- id: dsh-enhanced-traex-acp-provider
  config: { enabled: false, cwd: /tmp/old }
- id: dsh-enhanced-assistant-heartbeat
  config: { heartbeats: [] }
- id: dsh-enhanced-assistant-evolution
  config:
    databasePath: ${input.evolutionPath}
    evaluationWindow: 10
    minSample: 4
    reconcileIntervalMs: 0
`
}

describe('supervised-growth approval dispatch', () => {
  test('a background heartbeat-shaped Evolution proposal becomes a pending exact-owner Delivery approval intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervised-growth-dispatch-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const deliveryPath = join(root, 'delivery.sqlite')
    const policyPath = join(root, 'policy.sqlite')
    const evolutionPath = join(root, 'evolution.sqlite')
    const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
    const conversation = { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm' as const, chat: 'oc_owner' }
    const store = new DeliveryStore({ path: deliveryPath })
    const pairing = store.issuePairing(principal, { ttlMs: 60_000, maxAttempts: 1 })
    store.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const binding = store.createBinding({
      conversation,
      principal,
      workspace,
      agentPreset: 'standard',
      sessionId: 'supervised-heartbeat-session',
      policyRef: 'owner-dm',
    })
    store.close()

    const effective = effectiveConfig({ root, workspace, policyPath, deliveryPath, evolutionPath })
    const patch = configureSupervisedGrowthProfilePatch({
      profilePatch: '[]\n', effectiveConfig: effective, dshHome: root, binding,
    })
    const rows = parse(patch) as Array<{ id: string; config: Record<string, unknown> }>
    const effectiveRows = parse(effective) as Array<{ id: string; config: Record<string, unknown> }>
    const personal = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!.config
    const delivery = rows.find(row => row.id === 'dsh-enhanced-assistant-delivery')!.config
    const evolution = effectiveRows.find(row => row.id === 'dsh-enhanced-assistant-evolution')!.config

    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(AssistantPolicyService, personal.assistantPolicy as never)
    await ctx.plugin(AssistantDeliveryService, delivery as never)
    await ctx.plugin(AssistantEvolutionService, evolution as never)
    for (let index = 0; index < 4; index += 1) {
      ctx.assistantEvolution.recordAutomationOutcome({
        situation: 'heartbeat:supervised-growth', outcome: 'failed', detail: `trusted failure ${index}`,
        workspace, agentPreset: 'standard', occurredAt: 1_000 + index, idempotencyKey: `seed:${index}`,
      })
    }
    const agent = {
      session: {
        id: 'supervised-heartbeat-session',
        header: { cwd: workspace, agentPreset: 'standard' },
      },
    } as unknown as Agent
    const unbind = ctx.assistantPolicy.bindInitiator(agent, 'background')
    try {
      const proposed = ctx.assistantEvolution.propose(agent, {
        mutation: {
          op: 'adopt',
          input: {
            situation: 'heartbeat:supervised-growth',
            guidance: 'Propose only owner-approved, evidence-backed guidance.',
          },
        },
      })
      expect(proposed.status).toBe('pending')
      expect(ctx.assistantPolicy.listPendingApprovalDispatches()).toEqual([
        expect.objectContaining({
          sourceId: 'dsh-enhanced-assistant-evolution',
          workspace,
          principal: 'lark/primary/personal/ou_owner',
          bindingId: binding.id,
          action: 'evolution.adopt',
        }),
      ])
      await ctx.assistantDelivery.tick()
      await ctx.assistantDelivery.whenIdle()
      expect(ctx.assistantDelivery.health().pendingOutbox).toBe(1)
    } finally {
      unbind()
    }
  })
})
