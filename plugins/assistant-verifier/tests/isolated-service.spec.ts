import { Context } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService } from '../src/service.ts'
import { createVerifierAuthorities } from '../src/drivers.ts'
import type { AcceptanceHandle, AcceptanceTask, AcceptedExecution, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '../src/host.ts'

const roots: string[] = []
const contexts: Context[] = []
const sha = 'a'.repeat(64)
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.restart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class GoalsProducer implements TaskAcceptanceProducer {
  registration: TaskAcceptanceRegistration | undefined
  #generation = crypto.randomUUID()
  source: AcceptanceHandle | null = null
  changeGenerationDuringSource = false
  readonly proofs = new Map<string, AcceptedExecution>()
  trustedAcceptanceProducerGeneration() { return this.#generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration) {
    const owner = registration.owner as AssistantVerifierService
    if (!owner.ownsTaskAcceptanceRegistration(registration)) throw new Error('foreign registration')
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedArtifactSource(_contract: TaskAcceptanceContract) {
    const source = this.source
    if (this.changeGenerationDuringSource) this.#generation = crypto.randomUUID()
    return source
  }
  async inspectAcceptedExecution(contract: TaskAcceptanceContract) { return this.proofs.get(contract.id) ?? null }
  complete(handle: AcceptanceHandle, ref: string) {
    this.proofs.set(handle.contractId, { ...handle, dispatchedAt: 2_000, completedAt: 2_000, status: 'succeeded', quiescent: true, executionRef: ref })
  }
}

type GoalStepTask = AcceptanceTask & { readonly task: Extract<AcceptanceTask['task'], { kind: 'goal-step' }> }
function step(ref = 'run-1', owner = 'owner-1', definitionDigest = sha): GoalStepTask {
  return { scope: { workspace: '', preset: 'primary' }, owner: { principalRecordId: owner, principalVersion: 1 },
    task: { kind: 'goal-step', ref, goal: { id: 'goal-1', definitionVersion: 1, definitionDigest, stepId: 'step-1', runId: ref, sessionId: 'session-1', nativeGoalId: 'native-1', nativeRevision: 1 } },
    objective: 'verify isolated behavior' }
}
async function harness(withIsolation = true) {
  const root = await mkdtemp(join(tmpdir(), 'verifier-isolated-service-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx); const producer = new GoalsProducer(); ctx.provide('assistantGoals' as never, producer as never)
  let artifactReads = 0
  if (withIsolation) ctx.provide('assistantIsolation' as never, {
    readAcceptedArtifact: () => { artifactReads += 1; throw new Error('artifact-read-sentinel') },
  } as never)
  const authority = { kind: 'isolated-runner' as const, id: 'isolation-runner', stateRoot: root, image: `sha256:${sha}`,
    dockerPath: realpathSync(process.execPath), command: '/bin/sh /workspace/artifact < /workspace/input', expiresAt: Date.now() + 60_000,
    maxRuns: 2, maxTotalDurationMs: 60_000, maxDurationMs: 1_000, maxOutputBytes: 4_096,
    testSets: [{ id: 'private-set', cases: [{ stdin: 'private-input', expectedStdout: 'private-output', expectedExitCode: 0 }] }] }
  const [compiled] = createVerifierAuthorities({ authorities: [authority] })
  if (compiled?.kind !== 'isolated-runner') throw new Error('missing isolated authority')
  const main = { ...step(), scope: { workspace: root, preset: 'primary' } }
  const foreignOwner = { ...step('run-owner', 'owner-foreign'), scope: main.scope }
  const foreignDefinition = { ...step('run-definition', 'owner-1', 'b'.repeat(64)), scope: main.scope }
  const outcome: AcceptanceTask = { ...main, task: { kind: 'goal-outcome', ref: 'assessment-1', goal: { id: 'goal-1', definitionVersion: 1, definitionDigest: sha, assessmentId: 'assessment-1', sessionId: 'session-1', nativeGoalId: 'native-1' } } }
  const profiles = [main, foreignOwner, outcome].map((task, index) => ({ id: `profile-${index}`, version: 1, scope: task.scope, owner: task.owner, taskKind: task.task.kind, objective: task.objective,
    validityMs: 10_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
    criteria: [{ id: 'isolated', kind: 'isolated-process-behavior' as const, authority: { id: compiled.id, digest: compiled.digest }, artifactPath: 'artifacts/result.sh', testSetId: 'private-set' }] }))
  const service = new AssistantVerifierService(ctx, { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority], profiles }, { now: () => 2_000 })
  const prepare = (task: AcceptanceTask) => producer.registration!.prepare(task)!
  const finish = async (handle: AcceptanceHandle, task: AcceptanceTask) => { producer.complete(handle, task.task.ref); await producer.registration!.completed(handle); await service.tick(); return service.inspect(handle.contractId) }
  return { producer, service, main, outcome, foreignOwner, foreignDefinition, artifactReads: () => artifactReads, prepare, finish }
}

describe('v4 isolated service provenance', () => {
  it('uses an exact goal-step source handle before Isolation rejects the artifact read', async () => {
    const { producer, main, artifactReads, prepare, finish } = await harness(); const handle = prepare(main)
    producer.source = handle
    const state = await finish(handle, main)
    expect(state).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown', results: [{ status: 'unknown' }] } })
    expect(artifactReads()).toBeGreaterThan(0)
  })

  it('does not let a foreign owner, definition, or run source pass for the current v4 step', async () => {
    for (const sourceKind of ['owner', 'definition', 'run'] as const) {
      const { producer, main, foreignOwner, foreignDefinition, artifactReads, prepare, finish } = await harness()
      const target = prepare(main)
      const foreign = sourceKind === 'owner' ? foreignOwner : sourceKind === 'definition' ? foreignDefinition
        : { ...main, task: { ...main.task, ref: 'run-other', goal: { ...main.task.goal, runId: 'run-other' } } }
      producer.source = prepare(foreign)
      const state = await finish(target, main)
      expect(state).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown', results: [{ status: 'unknown' }] } })
      expect(artifactReads()).toBe(0)
    }
  })

  it('fails closed when the source is absent or the Goals producer generation changes', async () => {
    const { producer, main, artifactReads, prepare, finish } = await harness(); const missing = prepare(main)
    producer.source = null
    expect(await finish(missing, main)).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown' } })
    expect(artifactReads()).toBe(0)
    const changed = prepare({ ...main, task: { ...main.task, ref: 'run-changed', goal: { ...main.task.goal, runId: 'run-changed' } } })
    producer.source = changed; producer.changeGenerationDuringSource = true
    expect(await finish(changed, { ...main, task: { ...main.task, ref: 'run-changed', goal: { ...main.task.goal, runId: 'run-changed' } } })).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown' } })
    expect(artifactReads()).toBe(0)
  })

  it('emits an unknown v4 receipt when Isolation is missing after valid source provenance', async () => {
    const { producer, main, artifactReads, prepare, finish } = await harness(false); const handle = prepare(main)
    producer.source = handle
    expect(await finish(handle, main)).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown' } })
    expect(artifactReads()).toBe(0)
  })

  it('requires a whole-goal v4 assessment to point at its real goal-step source', async () => {
    const { producer, main, outcome, artifactReads, prepare, finish } = await harness()
    const source = prepare(main); const assessment = prepare(outcome)
    producer.source = source
    expect(await finish(assessment, outcome)).toMatchObject({ receipt: { protocol: 'task-verification/v4', task: { kind: 'goal-outcome', ref: 'assessment-1' }, objectiveStatus: 'unknown' } })
    expect(artifactReads()).toBeGreaterThan(0)
  })
})
