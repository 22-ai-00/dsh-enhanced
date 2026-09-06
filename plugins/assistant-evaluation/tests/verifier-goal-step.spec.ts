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
})
