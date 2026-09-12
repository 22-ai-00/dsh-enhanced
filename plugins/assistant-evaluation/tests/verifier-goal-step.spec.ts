import { Context } from '@deepseek-ai/cordis'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { AcceptedExecution, AcceptanceTask, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationService } from '../src/service.ts'
import type {
  TrustedDeliveryEvaluationClaims,
  TrustedGoalOutcomeOwnerProof,
} from '../src/types.ts'
import { TrustedDeliveryTestProducer } from './trusted-producer-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class GoalStepProducer implements TaskAcceptanceProducer {
  readonly generation = crypto.randomUUID()
  registration: TaskAcceptanceRegistration | undefined
  proof: AcceptedExecution | null = null
  readonly ownerTargets = new WeakMap<object, Readonly<TrustedGoalOutcomeOwnerProof>>()
  ownerProofResolutions = 0

  trustedAcceptanceProducerGeneration(): string { return this.generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration): () => void {
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedExecution(): Promise<AcceptedExecution | null> { return this.proof }
  issueOwnerTarget(proof: Readonly<TrustedGoalOutcomeOwnerProof>): unknown {
    const capability = Object.freeze(Object.create(null) as object)
    this.ownerTargets.set(capability, proof)
    return capability
  }
  resolveOwnerGoalOutcomeFeedbackTarget(capability: unknown): TrustedGoalOutcomeOwnerProof {
    this.ownerProofResolutions += 1
    if (typeof capability !== 'object' || capability === null) throw new Error('invalid Goals capability')
    const proof = this.ownerTargets.get(capability)
    if (proof === undefined) throw new Error('stale Goals capability')
    return proof
  }
}

async function settleCordis(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('trusted Verifier goal-step Evaluation sink', () => {
  test('projects a real v2 goal-step receipt into its own goal definition situation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-evaluation-verifier-goal-'))
    roots.push(root)
    await writeFile(join(root, 'report.md'), 'Verified goal step\n')
    const ctx = new Context(); contexts.push(ctx)
    const producer = new GoalStepProducer()
    ctx.provide('assistantGoals' as never, producer as never)
    let now = 1_000
    const evaluation = new AssistantEvaluationService(ctx, {
      databasePath: ':memory:', projectionIntervalMs: 0,
    }, { now: () => now })
    const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
    const authorities = createVerifierAuthorities({ authorities: [authority] })
    const task: AcceptanceTask = {
      scope: { workspace: root, preset: 'primary' },
      owner: { principalRecordId: 'owner-1', principalVersion: 1 },
      task: { kind: 'goal-step', ref: 'goal-run-1', goal: {
        id: 'goal-42', definitionVersion: 7, definitionDigest: 'a'.repeat(64), stepId: 'step-1',
        runId: 'goal-run-1', sessionId: 'session-1', nativeGoalId: 'native-goal-1', nativeRevision: 3,
      } },
      objective: 'Verify the goal step',
    }
    const verifier = new AssistantVerifierService(ctx, {
      databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true,
      authorities: [authority], profiles: [{
        id: 'goal-profile', version: 1, scope: task.scope, owner: task.owner, taskKind: 'goal-step',
        objective: task.objective, validityMs: 60_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
        criteria: [{ id: 'document', kind: 'document-citations', authority: { id: 'sources', digest: authorities[0]!.digest }, artifactPath: 'report.md', requiredText: ['Verified goal step'], quotes: [] }],
      }],
    }, { now: () => now })
    await settleCordis()

    const handle = producer.registration!.prepare(task)!
    now = 2_000
    producer.proof = { ...handle, dispatchedAt: 1_000, completedAt: now, status: 'succeeded', quiescent: true, executionRef: task.task.ref }
    await producer.registration!.completed(handle)
    await verifier.tick()

    expect(verifier.inspect(handle.contractId)).toMatchObject({
      receipt: { protocol: 'task-verification/v2', task: task.task, objectiveStatus: 'achieved' },
    })
    const goalSituation = 'goal:goal-42:definition:7'
    expect(evaluation.queryTasks({ scope: task.scope, situation: goalSituation, limit: 10 })).toEqual([
      expect.objectContaining({ situation: goalSituation, projection: expect.objectContaining({ subjectKind: 'goal-step', subjectRef: 'goal-run-1' }) }),
    ])
    expect(evaluation.queryTasks({ scope: task.scope, situation: 'foreground:goal-run-1', limit: 10 })).toEqual([])
  })

  test('projects v3 whole-goal receipts by assessment, preserves unknown, and isolates definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-evaluation-verifier-goal-outcome-'))
    roots.push(root)
    await writeFile(join(root, 'report.md'), 'Verified whole goal\n')
    const ctx = new Context(); contexts.push(ctx)
    const producer = new GoalStepProducer()
    ctx.provide('assistantGoals' as never, producer as never)
    let now = 1_000
    const evaluation = new AssistantEvaluationService(ctx, {
      databasePath: ':memory:', projectionIntervalMs: 0,
    }, { now: () => now })
    const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
    const authorities = createVerifierAuthorities({ authorities: [authority] })
    const scope = { workspace: root, preset: 'primary' }
    const owner = { principalRecordId: 'owner-1', principalVersion: 1 }
    const objective = 'Verify the whole business goal'
    const verifier = new AssistantVerifierService(ctx, {
      databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true,
      authorities: [authority], profiles: [{
        id: 'whole-goal-profile', version: 1, scope, owner, taskKind: 'goal-outcome', objective,
        validityMs: 60_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
        criteria: [{ id: 'document', kind: 'document-citations', authority: { id: 'sources', digest: authorities[0]!.digest }, artifactPath: 'report.md', requiredText: ['Verified whole goal'], quotes: [] }],
      }],
    }, { now: () => now })
    await settleCordis()

    const task = (assessmentId: string, definitionVersion: number, definitionDigest: string): AcceptanceTask => ({
      scope, owner, objective,
      task: { kind: 'goal-outcome', ref: assessmentId, goal: {
        id: 'goal-42', definitionVersion, definitionDigest, assessmentId,
        sessionId: 'session-1', nativeGoalId: 'native-goal-1',
      } },
    })
    const complete = async (input: AcceptanceTask, proof: Pick<AcceptedExecution, 'status' | 'quiescent'>) => {
      const handle = producer.registration!.prepare(input)!
      const dispatchedAt = now
      now += 1_000
      producer.proof = { ...handle, dispatchedAt, completedAt: now, executionRef: input.task.ref, ...proof }
      await producer.registration!.completed(handle)
      await verifier.tick()
      return handle
    }

    const achieved = await complete(task('assessment-achieved', 7, 'a'.repeat(64)), { status: 'succeeded', quiescent: true })
    const hostScope = evaluation.canonicalHostScope(scope)
    const staleAchieved = evaluation.getTrustedGoalOutcomeLearningProjection({
      scope: hostScope, assessmentId: 'assessment-achieved',
    })!
    expect(evaluation.isTrustedTaskLearningProjectionReceipt(staleAchieved)).toBe(true)
    const unknown = await complete(task('assessment-unknown', 7, 'a'.repeat(64)), { status: 'unknown', quiescent: false })
    const oldDefinition = await complete(task('assessment-old-definition', 6, 'b'.repeat(64)), { status: 'succeeded', quiescent: true })

    expect(verifier.inspect(achieved.contractId)).toMatchObject({
      receipt: { protocol: 'task-verification/v3', task: task('assessment-achieved', 7, 'a'.repeat(64)).task, objectiveStatus: 'achieved' },
    })
    expect(verifier.inspect(unknown.contractId)).toMatchObject({
      receipt: { protocol: 'task-verification/v3', objectiveStatus: 'unknown' },
    })
    expect(evaluation.queryTasks({ scope, situation: 'goal:goal-42:definition:7', limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ projection: expect.objectContaining({ subjectKind: 'goal-outcome', subjectRef: 'assessment-achieved' }), objectiveStatus: 'achieved' }),
      expect.objectContaining({ projection: expect.objectContaining({ subjectKind: 'goal-outcome', subjectRef: 'assessment-unknown' }), objectiveStatus: 'unknown' }),
    ]))
    expect(evaluation.queryTasks({ scope, situation: 'goal:goal-42:definition:6', limit: 10 })).toEqual([
      expect.objectContaining({ projection: expect.objectContaining({ subjectKind: 'goal-outcome', subjectRef: 'assessment-old-definition' }), objectiveStatus: 'achieved' }),
    ])
    const achievedProjection = evaluation.getTrustedGoalOutcomeLearningProjection({
      scope: hostScope,
      assessmentId: 'assessment-achieved',
    })!
    expect(achievedProjection).toMatchObject({
      scope,
      projection: {
        subjectKind: 'goal-outcome',
        subjectRef: 'assessment-achieved',
        disposition: 'upsert',
      },
      objective: { status: 'achieved' },
    })
    expect(evaluation.isTrustedTaskLearningProjectionReceipt(achievedProjection)).toBe(true)
    expect(evaluation.isTrustedTaskLearningProjectionReceipt(staleAchieved)).toBe(false)
    const withdrawn = evaluation.getTrustedGoalOutcomeLearningProjection({
      scope: hostScope,
      assessmentId: 'assessment-unknown',
    })!
    expect(withdrawn).toMatchObject({
      scope,
      projection: {
        subjectKind: 'goal-outcome',
        subjectRef: 'assessment-unknown',
        disposition: 'retract',
      },
      objective: { status: 'unknown' },
    })
    expect(evaluation.isTrustedTaskLearningProjectionReceipt(withdrawn)).toBe(true)
    const altered = (change: Record<string, unknown>) => ({
      ...structuredClone(withdrawn),
      ...change,
    }) as typeof withdrawn
    for (const candidate of [
      altered({ scopeKey: JSON.stringify([root, 'other']) }),
      altered({ situation: 'goal:goal-42:definition:999' }),
      altered({ projection: { ...withdrawn.projection, version: withdrawn.projection.version + 1 } }),
      altered({ projection: { ...withdrawn.projection, digest: '0'.repeat(64) } }),
      altered({ projection: { ...withdrawn.projection, disposition: 'upsert' } }),
      altered({ objective: { ...withdrawn.objective!, status: 'malformed' } }),
    ]) {
      expect(evaluation.isTrustedTaskLearningProjectionReceipt(candidate)).toBe(false)
    }
    expect(() => evaluation.isTrustedTaskLearningProjectionReceipt(null as never)).not.toThrow()
    expect(evaluation.isTrustedTaskLearningProjectionReceipt(null as never)).toBe(false)
    const fencedRetraction = evaluation.withTrustedCanonicalTaskWriterFence({
      scope: hostScope,
      scopeWatermark: withdrawn.scopeWatermark,
      evidence: [{
        subjectKind: withdrawn.projection.subjectKind,
        subjectRef: withdrawn.projection.subjectRef,
        version: withdrawn.projection.version,
        digest: withdrawn.projection.digest,
        disposition: withdrawn.projection.disposition,
      }],
    }, () => 'invalidated')
    expect(fencedRetraction).toEqual({ matched: true, value: 'invalidated' })
    expect(() => evaluation.withTrustedCanonicalTaskWriterFence({
      scope: hostScope,
      scopeWatermark: withdrawn.scopeWatermark,
      evidence: [{
        subjectKind: withdrawn.projection.subjectKind,
        subjectRef: withdrawn.projection.subjectRef,
        version: withdrawn.projection.version,
        digest: withdrawn.projection.digest,
        disposition: withdrawn.projection.disposition,
      }],
    }, async () => 'escaped')).toThrow(/synchronous/i)
    expect(() => evaluation.withTrustedCanonicalLearningWriterFence({
      scope: hostScope,
      scopeWatermark: withdrawn.scopeWatermark,
      evidence: [{
        subjectKind: withdrawn.projection.subjectKind,
        subjectRef: withdrawn.projection.subjectRef,
        version: withdrawn.projection.version,
        digest: withdrawn.projection.digest,
        disposition: withdrawn.projection.disposition,
      }],
    } as Parameters<typeof evaluation.withTrustedCanonicalLearningWriterFence>[0], () => 'must-not-run'))
      .toThrow(/evidence.*invalid/i)
    expect(evaluation.getTrustedGoalOutcomeLearningProjection({
      scope: hostScope,
      assessmentId: 'missing-assessment',
    })).toBeUndefined()
    expect(evaluation.getTrustedGoalOutcomeLearningProjection({
      scope: evaluation.canonicalHostScope({ workspace: root, preset: 'other' }),
      assessmentId: 'assessment-achieved',
    })).toBeUndefined()
    expect(verifier.inspect(oldDefinition.contractId)?.receipt?.task.kind).toBe('goal-outcome')

    // An authenticated owner record only selects an exact profile. It cannot
    // turn a foreign whole-goal assessment into a trusted verifier receipt.
    expect(() => producer.registration!.prepare({
      ...task('assessment-foreign-owner', 7, 'a'.repeat(64)),
      owner: { principalRecordId: 'owner-2', principalVersion: 1 },
    })).toThrow(/acceptance profile/i)
    expect(evaluation.queryTasks({ scope, situation: 'goal:goal-42:definition:7', limit: 10 }))
      .toHaveLength(2)
  })

  test('adopts a current Goals whole-goal receipt as owner revision one and applies direct corrections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-evaluation-goal-owner-'))
    roots.push(root)
    await writeFile(join(root, 'report.md'), 'Verified whole goal\n')
    const ctx = new Context(); contexts.push(ctx)
    const producer = new GoalStepProducer()
    const delivery = new TrustedDeliveryTestProducer('goal-owner-delivery')
    ctx.provide('assistantGoals' as never, producer as never)
    ctx.provide('assistantDelivery' as never, delivery as never)
    let now = 1_000
    const evaluation = new AssistantEvaluationService(ctx, {
      databasePath: ':memory:', projectionIntervalMs: 0,
    }, { now: () => now })
    const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
    const authorities = createVerifierAuthorities({ authorities: [authority] })
    const scope = { workspace: root, preset: 'primary' }
    const owner = { principalRecordId: 'owner-record', principalVersion: 2 }
    const objective = 'Verify the whole business goal'
    const verifier = new AssistantVerifierService(ctx, {
      databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true,
      authorities: [authority], profiles: [{
        id: 'whole-goal-profile', version: 4, scope, owner, taskKind: 'goal-outcome', objective,
        validityMs: 60_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
        criteria: [{ id: 'document', kind: 'document-citations', authority: { id: 'sources', digest: authorities[0]!.digest }, artifactPath: 'report.md', requiredText: ['Verified whole goal'], quotes: [] }],
      }],
    }, { now: () => now })
    await settleCordis()
    const task: AcceptanceTask = {
      scope, owner, objective,
      task: { kind: 'goal-outcome', ref: 'assessment-owner', goal: {
        id: 'goal-owner', definitionVersion: 3, definitionDigest: 'a'.repeat(64),
        assessmentId: 'assessment-owner', sessionId: 'session-owner', nativeGoalId: 'native-owner',
      } },
    }
    const handle = producer.registration!.prepare(task)!
    now = 2_000
    producer.proof = { ...handle, dispatchedAt: 1_000, completedAt: now,
      executionRef: task.task.ref, status: 'succeeded', quiescent: true }
    await producer.registration!.completed(handle)
    await verifier.tick()
    const accepted = verifier.inspectAcceptedTask(handle.contractId)!
    const locator = {
      protocol: 'assistant-goals/owner-goal-outcome-locator/v1' as const, ownerRouteId: 'route-owner',
      principalId: 'principal-owner', principalRecordId: owner.principalRecordId,
      principalVersion: owner.principalVersion, workspace: scope.workspace, preset: scope.preset,
      bindingId: 'binding-owner', bindingVersion: 5, bindingGeneration: 8,
      sessionId: 'session-owner', goalId: 'goal-owner', assessmentId: 'assessment-owner',
    }
    const unsigned = {
      protocol: 'assistant-goals/owner-goal-outcome-feedback/v1' as const, locator,
      goal: { definitionVersion: 3, definitionDigest: 'a'.repeat(64), nativeGoalId: 'native-owner', phase: 'complete' as const },
      runId: 'goal-run-owner', profile: accepted.contract.profile,
      contract: { id: accepted.contract.id, digest: accepted.contract.digest },
      receipt: { id: accepted.receipt!.id, digest: accepted.receipt!.digest,
        objectiveStatus: 'achieved' as const, completedAt: accepted.receipt!.completedAt, validUntil: accepted.receipt!.validUntil },
    }
    const proof: TrustedGoalOutcomeOwnerProof = { ...unsigned, proofDigest: acceptanceDigest(unsigned) }
    const goalOutcomeCapability = producer.issueOwnerTarget(proof)
    const registration = delivery.currentRegistration()!
    expect(registration.ownerRevisionProtocol).toBe('owner-objective-revision/v2')
    const base = {
      scope, situation: 'goal:goal-owner:definition:3', subjectKind: 'goal-outcome' as const,
      subjectRef: 'assessment-owner', runId: 'assessment-owner', outboxId: 'outbox-owner',
      chatId: 'chat-owner', principalId: 'principal-owner', bindingId: 'binding-owner',
      occurredAt: 2_100, goalOutcomeCapability,
    }
    const initialCommand = { operationId: 'goal-owner:validate', ...owner, action: 'initial' as const }
    expect(() => registration.issueCapability({ ...base, goalOutcomeCapability: structuredClone(proof),
      objectiveStatus: 'achieved', idempotencyKey: 'goal-owner:serialized', ownerCommand: initialCommand }))
      .toThrow(/Goals .*capability/i)
    const foreignProducer = new GoalStepProducer()
    expect(() => registration.issueCapability({ ...base, goalOutcomeCapability: foreignProducer.issueOwnerTarget(proof),
      objectiveStatus: 'achieved', idempotencyKey: 'goal-owner:foreign', ownerCommand: initialCommand }))
      .toThrow(/Goals .*capability/i)
    const proofVariant = (change: Partial<TrustedGoalOutcomeOwnerProof>): TrustedGoalOutcomeOwnerProof => {
      const changed = { ...unsigned, ...change }
      return { ...changed, proofDigest: acceptanceDigest(changed) } as TrustedGoalOutcomeOwnerProof
    }
    const locatorVariant = (change: Partial<typeof locator>) => proofVariant({ locator: { ...locator, ...change } })
    for (const [label, invalidProof] of [
      ['scope', locatorVariant({ workspace: `${root}-other` })],
      ['assessment', locatorVariant({ assessmentId: 'assessment-other' })],
      ['lineage', locatorVariant({ principalRecordId: 'owner-other' })],
      ['situation', locatorVariant({ goalId: 'goal-other' })],
      ['profile', proofVariant({ profile: { ...proof.profile, id: 'profile-other' } })],
    ] as const) {
      expect(() => registration.issueCapability({ ...base, goalOutcomeCapability: producer.issueOwnerTarget(invalidProof),
        objectiveStatus: 'achieved', idempotencyKey: `goal-owner:wrong-${label}`, ownerCommand: initialCommand }))
        .toThrow(/proof|claims|Verifier/i)
    }
    const correction: TrustedDeliveryEvaluationClaims = {
      ...base, objectiveStatus: 'not-achieved', idempotencyKey: 'goal-owner:correct',
      ownerCommand: { operationId: 'goal-owner:correct', ...owner, action: 'correct',
        expectedVersion: 1, previousStatus: 'achieved' },
    }
    const correctionCapability = registration.issueCapability(correction)
    expect(registration.inspect!(correctionCapability)).toEqual({ version: 1, objectiveStatus: 'achieved' })
    const corrected = registration.append({ capabilityReceipt: correctionCapability, runId: base.runId,
      outboxId: base.outboxId, chatId: base.chatId, principalId: base.principalId,
      bindingId: base.bindingId, idempotencyKey: correction.idempotencyKey })
    expect(corrected.ownerFeedbackState).toEqual({ version: 2, objectiveStatus: 'not-achieved' })
    expect(evaluation.queryTasks({ scope, limit: 10 })[0]).toMatchObject({
      objectiveStatus: 'not-achieved', projection: { subjectKind: 'goal-outcome',
        subjectRef: 'assessment-owner', learningDisposition: 'upsert' },
    })

    const withdrawal: TrustedDeliveryEvaluationClaims = {
      ...base, objectiveStatus: 'unknown', idempotencyKey: 'goal-owner:withdraw',
      ownerCommand: { operationId: 'goal-owner:withdraw', ...owner, action: 'withdraw',
        expectedVersion: 2, previousStatus: 'not-achieved' },
    }
    const withdrawalCapability = registration.issueCapability(withdrawal)
    const withdrawn = registration.append({ capabilityReceipt: withdrawalCapability, runId: base.runId,
      outboxId: base.outboxId, chatId: base.chatId, principalId: base.principalId,
      bindingId: base.bindingId, idempotencyKey: withdrawal.idempotencyKey })
    expect(withdrawn.ownerFeedbackState).toEqual({ version: 3, objectiveStatus: 'unknown' })
    expect(evaluation.queryTasks({ scope, limit: 10 })[0]).toMatchObject({
      objectiveStatus: 'unknown', projection: { learningDisposition: 'retract' },
    })

    const recovery: TrustedDeliveryEvaluationClaims = {
      ...base, objectiveStatus: 'achieved', idempotencyKey: 'goal-owner:recover',
      ownerCommand: { operationId: 'goal-owner:recover', ...owner, action: 'correct',
        expectedVersion: 3, previousStatus: 'unknown' },
    }
    const recoveryCapability = registration.issueCapability(recovery)
    const recoveredInput = { capabilityReceipt: recoveryCapability, runId: base.runId,
      outboxId: base.outboxId, chatId: base.chatId, principalId: base.principalId,
      bindingId: base.bindingId, idempotencyKey: recovery.idempotencyKey }
    const recovered = registration.append(recoveredInput)
    expect(registration.append(recoveredInput).id).toBe(recovered.id)
    expect(recovered.ownerFeedbackState).toEqual({ version: 4, objectiveStatus: 'achieved' })
    expect(evaluation.queryTasks({ scope, limit: 10 })[0]).toMatchObject({
      objectiveStatus: 'achieved', projection: { learningDisposition: 'upsert' },
    })
    expect(producer.ownerProofResolutions).toBeGreaterThanOrEqual(7)

    const stale: TrustedDeliveryEvaluationClaims = {
      ...base, objectiveStatus: 'not-achieved', idempotencyKey: 'goal-owner:stale',
      ownerCommand: { operationId: 'goal-owner:stale', ...owner, action: 'correct',
        expectedVersion: 1, previousStatus: 'achieved' },
    }
    const staleCapability = registration.issueCapability(stale)
    expect(() => registration.append({ ...recoveredInput, capabilityReceipt: staleCapability,
      idempotencyKey: stale.idempotencyKey })).toThrow(/judgement changed/i)
    expect(() => registration.append({ ...recoveredInput, capabilityReceipt: staleCapability,
      idempotencyKey: stale.idempotencyKey })).toThrow(/judgement changed/i)

    const currentCapability = registration.issueCapability({ ...base, objectiveStatus: 'achieved',
      idempotencyKey: 'goal-owner:replacement', ownerCommand: { operationId: 'goal-owner:replacement',
        ...owner, action: 'initial' } })
    const verifierGeneration = verifier.trustedVerificationProducerGeneration()
    ctx.set('assistantVerifier' as never, {
      trustedVerificationProducerGeneration: () => verifierGeneration,
      inspectAcceptedTask: (contractId: string) => verifier.inspectAcceptedTask(contractId),
    } as never)
    await settleCordis()
    expect(() => registration.inspect!(currentCapability)).toThrow(/Verifier .*unavailable/i)
    ctx.set('assistantVerifier' as never, verifier as never)
    await settleCordis()
    ctx.set('assistantGoals' as never, {
      resolveOwnerGoalOutcomeFeedbackTarget: () => { throw new Error('replacement does not own capability') },
    } as never)
    expect(() => registration.inspect!(currentCapability)).toThrow(/Goals .*capability/i)
    expect(() => registration.append({ ...recoveredInput, capabilityReceipt: currentCapability,
      idempotencyKey: 'goal-owner:replacement' })).toThrow(/Goals .*capability/i)
    expect(() => registration.issueCapability({ ...base, objectiveStatus: 'achieved',
      idempotencyKey: 'goal-owner:replacement-issue', ownerCommand: {
        operationId: 'goal-owner:replacement-issue', ...owner, action: 'initial' } })).toThrow(/Goals .*capability/i)
    ctx.set('assistantGoals' as never, undefined)
    expect(() => registration.inspect!(currentCapability)).toThrow(/Goals .*resolver/i)
  })

  test('recovers an expired whole-goal baseline after Evaluation was offline and restarted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-evaluation-goal-owner-offline-'))
    roots.push(root)
    await writeFile(join(root, 'report.md'), 'Verified whole goal while Evaluation is offline\n')
    const verifierPath = join(root, 'verifier.sqlite')
    const evaluationPath = join(root, 'evaluation.sqlite')
    const scope = { workspace: root, preset: 'primary' }
    const owner = { principalRecordId: 'owner-offline', principalVersion: 3 }
    const objective = 'Verify the offline whole business goal'
    const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
    const authorities = createVerifierAuthorities({ authorities: [authority] })
    const verifierConfig = {
      databasePath: verifierPath, tickIntervalMs: 0, requireAcceptance: true,
      authorities: [authority], profiles: [{
        id: 'whole-goal-offline-profile', version: 1, scope, owner, taskKind: 'goal-outcome' as const, objective,
        validityMs: 3_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
        criteria: [{ id: 'document', kind: 'document-citations' as const, authority: { id: 'sources', digest: authorities[0]!.digest }, artifactPath: 'report.md', requiredText: ['Verified whole goal'], quotes: [] }],
      }],
    }
    let now = 1_000
    const bootstrapCtx = new Context(); contexts.push(bootstrapCtx)
    new AssistantEvaluationService(bootstrapCtx, {
      databasePath: evaluationPath, projectionIntervalMs: 0,
    }, { now: () => now })
    await bootstrapCtx.fiber.restart(); contexts.splice(contexts.indexOf(bootstrapCtx), 1)

    const offlineCtx = new Context(); contexts.push(offlineCtx)
    const offlineGoals = new GoalStepProducer()
    offlineCtx.provide('assistantGoals' as never, offlineGoals as never)
    const offlineVerifier = new AssistantVerifierService(offlineCtx, verifierConfig, { now: () => now })
    await settleCordis()
    const task: AcceptanceTask = {
      scope, owner, objective,
      task: { kind: 'goal-outcome', ref: 'assessment-offline', goal: {
        id: 'goal-offline', definitionVersion: 2, definitionDigest: 'b'.repeat(64),
        assessmentId: 'assessment-offline', sessionId: 'session-offline', nativeGoalId: 'native-offline',
      } },
    }
    const handle = offlineGoals.registration!.prepare(task)!
    now = 2_000
    offlineGoals.proof = { ...handle, dispatchedAt: 1_000, completedAt: now,
      executionRef: task.task.ref, status: 'succeeded', quiescent: true }
    await offlineGoals.registration!.completed(handle)
    await offlineVerifier.tick()
    expect(offlineVerifier.health()).toMatchObject({ evaluationConnected: false, pendingReceipts: 1 })
    now = 5_000
    expect(offlineVerifier.health()).toMatchObject({ expiredReceipts: 1 })
    await offlineCtx.fiber.restart(); contexts.splice(contexts.indexOf(offlineCtx), 1)

    const restartedCtx = new Context(); contexts.push(restartedCtx)
    const restartedGoals = new GoalStepProducer()
    const restartedDelivery = new TrustedDeliveryTestProducer('goal-owner-offline-delivery')
    restartedCtx.provide('assistantGoals' as never, restartedGoals as never)
    restartedCtx.provide('assistantDelivery' as never, restartedDelivery as never)
    const restartedVerifier = new AssistantVerifierService(restartedCtx, verifierConfig, { now: () => now })
    const evaluation = new AssistantEvaluationService(restartedCtx, {
      databasePath: evaluationPath, projectionIntervalMs: 0,
    }, { now: () => now })
    await settleCordis()
    await restartedVerifier.tick()
    expect(restartedVerifier.health()).toMatchObject({
      evaluationConnected: true, pendingReceipts: 1, expiredReceipts: 1,
    })
    expect(evaluation.queryTasks({ scope, limit: 10 })).toEqual([])

    const accepted = restartedVerifier.inspectAcceptedTask(handle.contractId)!
    expect(accepted.receipt!.validUntil).toBeLessThan(now)
    const locator = {
      protocol: 'assistant-goals/owner-goal-outcome-locator/v1' as const, ownerRouteId: 'route-offline',
      principalId: 'principal-offline', principalRecordId: owner.principalRecordId,
      principalVersion: owner.principalVersion, workspace: scope.workspace, preset: scope.preset,
      bindingId: 'binding-offline', bindingVersion: 2, bindingGeneration: 4,
      sessionId: 'session-offline', goalId: 'goal-offline', assessmentId: 'assessment-offline',
    }
    const unsigned = {
      protocol: 'assistant-goals/owner-goal-outcome-feedback/v1' as const, locator,
      goal: { definitionVersion: 2, definitionDigest: 'b'.repeat(64), nativeGoalId: 'native-offline', phase: 'complete' as const },
      runId: 'goal-run-offline', profile: accepted.contract.profile,
      contract: { id: accepted.contract.id, digest: accepted.contract.digest },
      receipt: { id: accepted.receipt!.id, digest: accepted.receipt!.digest,
        objectiveStatus: 'achieved' as const, completedAt: accepted.receipt!.completedAt, validUntil: accepted.receipt!.validUntil },
    }
    const proof: TrustedGoalOutcomeOwnerProof = { ...unsigned, proofDigest: acceptanceDigest(unsigned) }
    const registration = restartedDelivery.currentRegistration()!
    const base = {
      scope, situation: 'goal:goal-offline:definition:2', subjectKind: 'goal-outcome' as const,
      subjectRef: 'assessment-offline', runId: 'assessment-offline', outboxId: 'outbox-offline',
      chatId: 'chat-offline', principalId: 'principal-offline', bindingId: 'binding-offline',
      occurredAt: now, goalOutcomeCapability: restartedGoals.issueOwnerTarget(proof),
    }
    const statusClaims: TrustedDeliveryEvaluationClaims = {
      ...base, objectiveStatus: 'achieved', idempotencyKey: 'goal-offline:status',
      ownerCommand: { operationId: 'goal-offline:status', ...owner, action: 'initial' },
    }
    const firstStatus = registration.issueCapability(statusClaims)
    const replayedStatus = registration.issueCapability(statusClaims)
    expect(registration.inspect!(firstStatus)).toEqual({ version: 1, objectiveStatus: 'achieved' })
    expect(registration.inspect!(replayedStatus)).toEqual({ version: 1, objectiveStatus: 'achieved' })
    expect(evaluation.queryTasks({ scope, limit: 10 })).toHaveLength(1)
    expect(evaluation.queryTasks({ scope, limit: 10 })[0]).toMatchObject({
      objectiveStatus: 'achieved', projection: { subjectKind: 'goal-outcome',
        subjectRef: 'assessment-offline', learningDisposition: 'upsert' },
      evidence: expect.arrayContaining([
        { kind: 'verification-receipt', ref: proof.receipt.id, digest: proof.receipt.digest },
      ]),
    })

    const correction: TrustedDeliveryEvaluationClaims = {
      ...base, objectiveStatus: 'not-achieved', idempotencyKey: 'goal-offline:correct',
      ownerCommand: { operationId: 'goal-offline:correct', ...owner, action: 'correct',
        expectedVersion: 1, previousStatus: 'achieved' },
    }
    const correctionCapability = registration.issueCapability(correction)
    const correctionInput = { capabilityReceipt: correctionCapability, runId: base.runId,
      outboxId: base.outboxId, chatId: base.chatId, principalId: base.principalId,
      bindingId: base.bindingId, idempotencyKey: correction.idempotencyKey }
    const corrected = registration.append(correctionInput)
    expect(registration.append(correctionInput).id).toBe(corrected.id)
    expect(corrected.ownerFeedbackState).toEqual({ version: 2, objectiveStatus: 'not-achieved' })
    const stale = registration.issueCapability({ ...correction, idempotencyKey: 'goal-offline:stale',
      ownerCommand: { ...correction.ownerCommand!, operationId: 'goal-offline:stale' } })
    expect(() => registration.append({ ...correctionInput, capabilityReceipt: stale,
      idempotencyKey: 'goal-offline:stale' })).toThrow(/judgement changed/i)
  })

  test('rejects a non-Goals producer task kind before it can create a verifier receipt', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const producer = new GoalStepProducer()
    ctx.provide('assistantGoals' as never, producer as never)
    const evaluation = new AssistantEvaluationService(ctx, { databasePath: ':memory:', projectionIntervalMs: 0 }, { now: () => 1_000 })
    new AssistantVerifierService(ctx, {
      databasePath: ':memory:', tickIntervalMs: 0, requireAcceptance: false, authorities: [], profiles: [],
    }, { now: () => 1_000 })
    await settleCordis()
    expect(() => producer.registration!.prepare({
      scope: { workspace: '/work/goal', preset: 'primary' }, owner: { principalRecordId: 'owner-1', principalVersion: 1 },
      task: { kind: 'foreground-turn', ref: 'borrowed-owner-turn' }, objective: 'must not run',
    })).toThrow(/wrong Host task kind/i)
    expect(evaluation.queryTasks({ scope: { workspace: '/work/goal', preset: 'primary' }, limit: 10 })).toEqual([])
  })
})
