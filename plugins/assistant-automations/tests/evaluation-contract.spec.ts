import { Context } from '@deepseek-ai/cordis'
import {
  AssistantEvaluationError,
  AssistantEvaluationService,
  TRUSTED_EVALUATION_PRODUCER_PROTOCOL,
  type OutcomeEnvelope,
  type StoredOutcome,
  type TrustedAutomationEvaluationRegistration,
  type TrustedEvaluationRegistrationOwner,
} from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantAutomationsError,
  AssistantAutomationsService,
} from '../src/service.ts'
import type { HostAutomationDefinition } from '../src/types.ts'

const contexts: Context[] = []
const roots: string[] = []
const owner = 'automation-evaluation-contract'
const scope = Object.freeze({ workspace: '/work/alpha', preset: 'primary' })
const catalogDigest = 'a'.repeat(64)

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function baseHarness() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automation-evaluation-contract-'))
  const ctx = new Context()
  roots.push(root)
  contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      {
        id: 'allow-contract-owner', effect: 'allow',
        subject: { kind: 'background', id: owner, workspace: scope.workspace },
        actions: ['reconcile', 'run-dry'], resource: { kind: 'automation', id: '*' },
        context: { initiators: ['background'] },
      },
      {
        id: 'allow-contract-execution', effect: 'allow',
        subject: { kind: 'background', id: '*', workspace: scope.workspace },
        actions: ['execute'], resource: { kind: 'automation', id: '*' },
        context: { initiators: ['background'] },
      },
    ],
  })
  return {
    ctx,
    root,
    evaluationPath: join(root, 'evaluation.sqlite'),
  }
}

async function installAutomations(fixture: Awaited<ReturnType<typeof baseHarness>>) {
  const fiber = await fixture.ctx.plugin(AssistantAutomationsService, {
    databasePath: join(fixture.root, 'automations.sqlite'),
    runsPath: join(fixture.root, 'runs'),
    schedulerEnabled: false,
    reconcileIntervalMs: 0,
    allowUnbudgetedExecution: true,
  })
  const execute = vi.fn(async () => ({
    outcome: 'succeeded' as const,
    failureClass: 'none' as const,
    failurePhase: 'none' as const,
    failureCode: 'none',
    sideEffectState: 'none' as const,
    retryability: 'safe' as const,
  }))
  const disposeExecutor = fixture.ctx.assistantAutomations.registerHostExecutor({
    descriptor: { executorId: owner, contractVersion: 1, catalogDigest },
    accepts: spec => spec.runbookId === 'contract/run' && spec.runbookVersion === 1,
    execute,
  })
  return { fiber, service: fixture.ctx.assistantAutomations, execute, disposeExecutor }
}

async function installEvaluation(fixture: Awaited<ReturnType<typeof baseHarness>>) {
  const fiber = await fixture.ctx.plugin(AssistantEvaluationService, {
    databasePath: fixture.evaluationPath,
    projectionIntervalMs: 0,
  })
  return { fiber, service: fixture.ctx.assistantEvaluation }
}

function hostDefinition(at: string, automationId: string): HostAutomationDefinition {
  return {
    name: `Evaluation contract ${automationId}`,
    schedule: { kind: 'at', at },
    workspace: scope.workspace,
    agentPreset: scope.preset,
    timeoutMs: 60_000,
    misfire: { kind: 'latest' },
    overlap: 'skip',
    retrySafety: 'never',
    maxRetries: 0,
    principal: 'owner:local:test',
    execution: {
      kind: 'host',
      executorId: owner,
      executorContractVersion: 1,
      runbookId: 'contract/run',
      runbookVersion: 1,
      catalogDigest,
      targetScope: scope,
      scopeDigest: '0'.repeat(64),
      ownerRouteId: 'local/owner',
      activationNonce: `activation-${automationId}`,
    },
  }
}

async function runProduction(
  automations: AssistantAutomationsService,
  automationId: string,
): Promise<void> {
  automations.reconcileSystem({
    owner,
    automationId,
    idempotencyKey: `reconcile:${automationId}`,
    definition: hostDefinition(new Date(Date.now() - 1).toISOString(), automationId),
  })
  await automations.tick()
  await automations.whenIdle()
}

describe('Automations to Evaluation private capability', () => {
  test('writes a real production terminal outbox through Cordis as trusted evidence', async () => {
    const fixture = await baseHarness()
    const evaluation = await installEvaluation(fixture)
    const automations = await installAutomations(fixture)

    await runProduction(automations.service, 'contract-production')

    expect(automations.execute).toHaveBeenCalledOnce()
    expect(automations.service.health()).toMatchObject({
      pendingEvaluations: 0,
      failedEvaluationAttempts: 0,
      deadLetterEvaluations: 0,
    })
    expect(evaluation.service.query({ scope, limit: 10 })).toEqual([
      expect.objectContaining({
        situation: 'automation:contract-production',
        executionStatus: 'succeeded',
        objectiveStatus: 'achieved',
        deliveryStatus: 'not-required',
        source: { kind: 'automation', id: 'assistant-automations' },
        trust: 'trusted',
        evidence: [expect.objectContaining({ kind: 'automation-run' })],
        evaluator: { id: 'assistant-automations', version: 'host-runbook-v1' },
      }),
    ])
  })

  test('backfills a durable pending outbox after late install and Evaluation restart without rerunning work', async () => {
    const fixture = await baseHarness()
    const automations = await installAutomations(fixture)

    await runProduction(automations.service, 'late-evaluation')
    expect(automations.execute).toHaveBeenCalledTimes(1)
    expect(automations.service.health()).toMatchObject({ pendingEvaluations: 1 })

    const firstEvaluation = await installEvaluation(fixture)
    await automations.service.whenIdle()
    expect(automations.service.health()).toMatchObject({ pendingEvaluations: 0 })
    expect(firstEvaluation.service.query({ scope, limit: 10 })).toHaveLength(1)

    await firstEvaluation.fiber.dispose()
    await runProduction(automations.service, 'evaluation-restart')
    expect(automations.execute).toHaveBeenCalledTimes(2)
    expect(automations.service.health()).toMatchObject({ pendingEvaluations: 1 })

    const restartedEvaluation = await installEvaluation(fixture)
    await automations.service.whenIdle()
    expect(restartedEvaluation.service.query({ scope, limit: 10 }).map(outcome => outcome.situation).sort())
      .toEqual(['automation:evaluation-restart', 'automation:late-evaluation'])
    expect(automations.service.health()).toMatchObject({ pendingEvaluations: 0 })

    await automations.service.tick()
    await automations.service.whenIdle()
    await automations.service.tick()
    await automations.service.whenIdle()
    expect(restartedEvaluation.service.query({ scope, limit: 10 })).toHaveLength(2)
    expect(automations.execute).toHaveBeenCalledTimes(2)
  })

  test('replays idempotently when Evaluation commits before its acknowledgement is lost', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-31T02:00:00.000Z'))
    try {
      const fixture = await baseHarness()
      const evaluation = await installEvaluation(fixture)
      const automations = await installAutomations(fixture)
      // Fault injection only: the production setup and assertions stay on the
      // public service seams. The first append commits durably, then loses its
      // acknowledgement before Automations can settle its own outbox row.
      const evaluationStore = (evaluation.service as unknown as {
        store: { append(input: OutcomeEnvelope): StoredOutcome }
      }).store
      const durableAppend = evaluationStore.append.bind(evaluationStore)
      const append = vi.spyOn(evaluationStore, 'append').mockImplementationOnce(input => {
        durableAppend(input)
        throw Object.assign(new Error('acknowledgement lost'), { code: 'ack-lost' })
      })

      await runProduction(automations.service, 'acknowledgement-loss')

      expect(automations.execute).toHaveBeenCalledOnce()
      expect(automations.service.health()).toMatchObject({
        pendingEvaluations: 1,
        retryingEvaluations: 1,
        failedEvaluationAttempts: 1,
      })
      expect(evaluation.service.query({ scope, limit: 10 })).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1_000)
      await automations.service.tick()
      await automations.service.whenIdle()

      expect(append).toHaveBeenCalledTimes(2)
      expect(automations.service.health()).toMatchObject({ pendingEvaluations: 0 })
      expect(evaluation.service.query({ scope, limit: 10 })).toHaveLength(1)
      expect(automations.execute).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps previews out of trusted Evaluation even when the private sink is attached', async () => {
    const fixture = await baseHarness()
    const automations = await installAutomations(fixture)
    const evaluation = await installEvaluation(fixture)
    const automationId = 'preview-is-not-evidence'
    automations.service.reconcileSystem({
      owner,
      automationId,
      idempotencyKey: `reconcile:${automationId}`,
      definition: hostDefinition('2035-01-01T00:00:00.000Z', automationId),
    })
    const projection = automations.service.inspectSystemOwned({ owner, automationId })

    const result = await automations.service.runSystemDry({
      owner,
      automationId,
      definitionHash: projection.definitionHash,
      idempotencyKey: 'preview-one',
    })
    await automations.service.whenIdle()

    expect(result).toMatchObject({
      occurrence: { dryRun: true },
      run: { status: 'succeeded', executionMode: 'preview' },
    })
    expect(automations.service.health()).toMatchObject({ pendingEvaluations: 0 })
    expect(evaluation.service.query({ scope, limit: 10 })).toEqual([])
  })

  test('rejects public trusted writes and malformed or stale producer registrations', async () => {
    const fixture = await baseHarness()
    const automations = await installAutomations(fixture)
    const generation = automations.service.trustedEvaluationProducerGeneration()
    const fakeOwner = {
      ownsTrustedAutomationEvaluationRegistration: vi.fn(() => false),
      ownsTrustedDeliveryEvaluationRegistration: vi.fn(() => false),
    } satisfies TrustedEvaluationRegistrationOwner
    const fakeRegistration = {
      protocol: TRUSTED_EVALUATION_PRODUCER_PROTOCOL,
      producer: 'assistant-automations' as const,
      generation: `${generation}:stale`,
      owner: fakeOwner,
      issueCapability: vi.fn(() => Object.freeze({})),
      append: vi.fn(() => { throw new Error('must not be called') }),
    } satisfies TrustedAutomationEvaluationRegistration

    expect(() => automations.service.registerTrustedAutomationEvaluationSink(fakeRegistration))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'runtime-conflict' }))
    expect(fakeRegistration.issueCapability).not.toHaveBeenCalled()
    expect(fakeRegistration.append).not.toHaveBeenCalled()

    const exactShapeFake = { ...fakeRegistration, generation }
    expect(() => automations.service.registerTrustedAutomationEvaluationSink(exactShapeFake))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'runtime-conflict' }))
    expect(fakeOwner.ownsTrustedAutomationEvaluationRegistration).toHaveBeenCalledWith(exactShapeFake)
    expect(exactShapeFake.issueCapability).not.toHaveBeenCalled()
    expect(exactShapeFake.append).not.toHaveBeenCalled()

    const evaluation = await installEvaluation(fixture)
    expect(() => evaluation.service.append({
      scope,
      situation: 'automation:forged',
      executionStatus: 'succeeded',
      objectiveStatus: 'achieved',
      deliveryStatus: 'not-required',
      source: { kind: 'automation', id: 'assistant-automations' },
      trust: 'trusted',
      evidence: [{ kind: 'automation-run', ref: 'forged-run' }],
      metrics: {},
      occurredAt: Date.now(),
      idempotencyKey: 'forged-trusted-outcome',
      evaluator: { id: 'assistant-automations', version: 'host-runbook-v1' },
    })).toThrowError(expect.objectContaining<Partial<AssistantEvaluationError>>({ code: 'forbidden' }))

    expect(() => automations.service.registerTrustedAutomationEvaluationSink({
      ...fakeRegistration,
      generation,
    })).toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'runtime-conflict' }))
  })
})
