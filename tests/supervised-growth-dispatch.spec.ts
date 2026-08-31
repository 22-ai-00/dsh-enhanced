import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AutomationQualityEvidenceReceipt } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import {
  AssistantEvaluationService,
  canonicalEvaluationHostScope,
  type StoredOutcome,
  type TrustedAutomationEvaluationClaims,
} from '@dsh-enhanced/assistant-evaluation'
import { AssistantEvolutionService } from '@dsh-enhanced/assistant-evolution'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { RECOVERY_CATALOG_DIGEST } from '@dsh-enhanced/assistant-recovery'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeliveryStore } from '../plugins/assistant-delivery/src/store.ts'
import { TrustedAutomationTestProducer } from '../plugins/assistant-evaluation/tests/trusted-producer-fixture.ts'
import { configureSupervisedGrowthProfilePatch } from '../plugins/lark-channel/src/supervised-growth-profile.ts'

const roots: string[] = []
const contexts = new Set<Context>()

class TrustedAgentAutomationTestProducer extends TrustedAutomationTestProducer {
  readonly #claims = new Map<string, Readonly<TrustedAutomationEvaluationClaims>>()
  readonly #proofs = new WeakSet<object>()

  override append(claims: TrustedAutomationEvaluationClaims): StoredOutcome {
    const outcome = super.append(claims)
    this.#claims.set(claims.runId, Object.freeze({ ...claims, scope: Object.freeze({ ...claims.scope }) }))
    return outcome
  }

  resolveQualityEvidence(input: {
    automationId: string
    runId: string
    expectedScope: { workspace: string; preset: string }
    expectedSituation: string
    expectedOccurredAt: number
    evidenceRef: { kind: 'automation-run'; ref: string }
  }): AutomationQualityEvidenceReceipt | undefined {
    const claims = this.#claims.get(input.runId)
    if (claims === undefined || claims.automationId !== input.automationId
      || claims.scope.workspace !== input.expectedScope.workspace
      || claims.scope.preset !== input.expectedScope.preset
      || claims.situation !== input.expectedSituation
      || claims.occurredAt !== input.expectedOccurredAt
      || input.evidenceRef.kind !== 'automation-run'
      || input.evidenceRef.ref !== input.runId
      || !['failed', 'succeeded', 'timed-out'].includes(claims.executionStatus)) return undefined
    const base = {
      schemaVersion: 1 as const,
      source: 'assistant-automations' as const,
      executionKind: 'agent' as const,
      automationId: claims.automationId,
      runId: claims.runId,
      definitionHash: createHash('sha256').update(`definition\0${claims.automationId}`).digest('hex'),
      status: claims.executionStatus === 'timed-out' ? 'timed_out' as const : claims.executionStatus,
      scope: Object.freeze({ ...claims.scope }),
      situation: claims.situation,
      occurredAt: claims.occurredAt,
      evidenceRef: Object.freeze({ kind: 'automation-run' as const, ref: claims.runId }),
      sessionId: `session:${claims.runId}`,
    }
    const proof = Object.freeze({
      ...base,
      proofDigest: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
    })
    this.#proofs.add(proof)
    return proof
  }

  validateQualityEvidence(receipt: AutomationQualityEvidenceReceipt): boolean {
    return this.#proofs.has(receipt)
  }
}

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
- id: dsh-enhanced-assistant-evaluation
  config:
    databasePath: ${input.root}/evaluation.sqlite
- id: dsh-enhanced-assistant-growth-experiments
  config:
    databasePath: ${input.root}/growth.sqlite
- id: dsh-enhanced-preference-learning
  config:
    enabled: true
    databasePath: ${input.root}/preferences.sqlite
- id: dsh-enhanced-assistant-health
  config:
    requiredProviders: [assistantPolicy, personalMemory, personalWiki, assistantAutomations, assistantGrowthExperiments]
- id: dsh-enhanced-assistant-recovery
  config:
    databasePath: ${input.root}/recovery.sqlite
    jobs: []
    maxStepDurationMs: 10000
`
}

describe('supervised-growth approval dispatch', () => {
  test('a normal owner Agent Evolution proposal remains a pending exact-owner Delivery approval intent', async () => {
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
      activationState: 'preview',
      activationNonce: 'dispatch-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    })
    const rows = parse(patch) as Array<{ id: string; config: Record<string, unknown> }>
    const effectiveRows = parse(effective) as Array<{ id: string; config: Record<string, unknown> }>
    const personal = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!.config
    const delivery = rows.find(row => row.id === 'dsh-enhanced-assistant-delivery')!.config
    const evolution = effectiveRows.find(row => row.id === 'dsh-enhanced-assistant-evolution')!.config
    const evaluation = effectiveRows.find(row => row.id === 'dsh-enhanced-assistant-evaluation')!.config

    const ctx = new Context()
    contexts.add(ctx)
    const evaluationProducer = new TrustedAgentAutomationTestProducer(
      'supervised-growth-dispatch-fixture-v1',
    )
    ctx.provide('assistantAutomations' as never, evaluationProducer as never)
    await ctx.plugin(AssistantPolicyService, personal.assistantPolicy as never)
    await ctx.plugin(AssistantDeliveryService, delivery as never)
    await ctx.plugin(AssistantEvaluationService, evaluation as never)
    await ctx.plugin(AssistantEvolutionService, evolution as never)
    for (let index = 0; index < 4; index += 1) {
      const outcome = evaluationProducer.append({
        scope: { workspace, preset: 'standard' },
        automationId: 'supervised-growth',
        situation: 'automation:supervised-growth',
        runId: `supervised-growth-run:${index}`,
        executionMode: 'production',
        executionStatus: 'failed',
        objectiveStatus: 'not-achieved',
        deliveryStatus: 'not-required',
        metrics: {},
        occurredAt: 1_000 + index,
        idempotencyKey: `supervised-growth-evaluation:${index}`,
        evaluatorVersion: 'terminal-v1',
      })
      await vi.waitFor(async () => {
        expect(await ctx.assistantEvaluation.reconcileProjection({
          scope: canonicalEvaluationHostScope({ workspace, preset: 'standard' }),
          evaluationId: outcome.id,
          operationId: `supervised-growth-projection:${index}`,
        })).toMatchObject({ status: 'recorded' })
      })
    }
    const agent = {
      session: {
        id: 'supervised-heartbeat-session',
        header: { cwd: workspace, agentPreset: 'standard' },
      },
    } as unknown as Agent
    const unbind = ctx.assistantPolicy.bindInitiator(agent, 'external')
    try {
      expect(ctx.assistantEvolution.health()).toMatchObject({
        trustedEpisodes: 4,
        qualityEligibleEpisodes: 4,
      })
      const proposed = ctx.assistantEvolution.propose(agent, {
        mutation: {
          op: 'adopt',
          input: {
            situation: 'automation:supervised-growth',
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
