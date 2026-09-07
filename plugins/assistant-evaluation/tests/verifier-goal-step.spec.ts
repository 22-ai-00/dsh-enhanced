import { Context } from '@deepseek-ai/cordis'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { AcceptedExecution, AcceptanceTask, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationService } from '../src/service.ts'

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

  trustedAcceptanceProducerGeneration(): string { return this.generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration): () => void {
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedExecution(): Promise<AcceptedExecution | null> { return this.proof }
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
