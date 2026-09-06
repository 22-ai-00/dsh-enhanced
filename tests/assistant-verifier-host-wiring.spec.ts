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
  } finally {
    await ctx.fiber.restart()
    await rm(root, { recursive: true, force: true })
  }
})
