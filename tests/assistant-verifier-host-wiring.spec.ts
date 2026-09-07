import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { AssistantPolicyService } from '../plugins/assistant-policy/src/service.ts'
import { AssistantAutomationsService } from '../plugins/assistant-automations/src/service.ts'
import { AssistantDeliveryService } from '../plugins/assistant-delivery/src/service.ts'
import { AssistantEvaluationService } from '../plugins/assistant-evaluation/src/service.ts'
import { AssistantVerifierService } from '../plugins/assistant-verifier/src/service.ts'
import { AssistantGoalsService } from '../plugins/assistant-goals/src/service.ts'
import { AssistantHealthService } from '../plugins/assistant-health/src/service.ts'

test('actual Cordis Host services bind the verifier and Evaluation without model authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifier-host-wiring-'))
  const ctx = new Context()
  try {
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite') })
    await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'), schedulerEnabled: false,
      defaultWorkspace: root, defaultAgentPreset: 'primary' })
    await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
    await ctx.plugin(AssistantEvaluationService, { databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
    await ctx.plugin(AssistantVerifierService, { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0 })
    expect(ctx.assistantVerifier.health()).toMatchObject({ ready: true, profiles: 0,
      hostProducers: ['assistantAutomations', 'assistantDelivery'], evaluationConnected: true })
    await ctx.assistantVerifier.tick()
    expect(ctx.assistantEvaluation.health().outcomes).toBe(0)
    expect(() => ctx.assistantAutomations.registerTaskAcceptanceSink({ protocol: 'assistant-verifier/host-producer/v1',
      generation: ctx.assistantAutomations.trustedAcceptanceProducerGeneration(),
      owner: { ownsTaskAcceptanceRegistration: () => true }, requiresAcceptance: false,
      prepare: () => null, completed: async () => {} })).toThrow('invalid')
    // Read the real Verifier's three-producer vocabulary through Health, not a
    // hand-written health fixture that can lag behind runtime registrations.
    const goals = await ctx.plugin(AssistantGoalsService, { databasePath: join(root, 'goals.sqlite'), verifyNativeRounds: true, verifyGoalOutcome: true })
    await ctx.plugin(AssistantHealthService, { requiredProviders: ['assistantVerifier'] })
    expect(ctx.assistantVerifier.health().hostProducers).toEqual(['assistantAutomations', 'assistantDelivery', 'assistantGoals'])
    expect(ctx.assistantHealth.readiness().ready).toBe(true)
    expect(ctx.assistantHealth.readiness().warnings).not.toContain('provider-error:assistantVerifier')
    expect(ctx.assistantHealth.readiness().warnings).not.toContain('provider-error:assistantGoals')
    expect(ctx.assistantHealth.readiness().warnings).toContain('provider-degraded:assistantGoals:context-unavailable')
    await goals.dispose()
    expect(ctx.assistantVerifier.health().hostProducers).toEqual(['assistantAutomations', 'assistantDelivery'])
    expect(ctx.assistantHealth.readiness().ready).toBe(true)
  } finally {
    await ctx.fiber.restart()
    await rm(root, { recursive: true, force: true })
  }
})
