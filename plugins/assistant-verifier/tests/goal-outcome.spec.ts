import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService } from '../src/service.ts'
import { createVerifierAuthorities } from '../src/drivers.ts'
import type { AcceptedExecution, AcceptanceHandle, AcceptanceTask, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '../src/host.ts'

const roots: string[] = []
const contexts: Context[] = []
const sha = 'a'.repeat(64)
type GoalOutcomeTask = AcceptanceTask & { readonly task: Extract<AcceptanceTask['task'], { kind: 'goal-outcome' }> }

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.restart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A minimal trusted Goals Host: it owns persisted terminal execution proof, never a verdict. */
class GoalsProducer implements TaskAcceptanceProducer {
  registration: TaskAcceptanceRegistration | undefined
  readonly generation = crypto.randomUUID()
  readonly proofs = new Map<string, AcceptedExecution>()
  trustedAcceptanceProducerGeneration(): string { return this.generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration) {
    const owner = registration.owner as AssistantVerifierService
    if (!owner.ownsTaskAcceptanceRegistration(registration)) throw new Error('foreign registration')
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedExecution(contract: TaskAcceptanceContract) { return this.proofs.get(contract.id) ?? null }
  complete(handle: AcceptanceHandle, executionRef: string, now: number) {
    this.proofs.set(handle.contractId, { ...handle, dispatchedAt: now - 10, completedAt: now,
      status: 'succeeded', quiescent: true, executionRef })
  }
}

function outcome(assessmentId = 'assessment-1'): GoalOutcomeTask {
  return {
    scope: { workspace: '', preset: 'primary' },
    owner: { principalRecordId: 'owner-1', principalVersion: 1 },
    task: { kind: 'goal-outcome', ref: assessmentId, goal: {
      id: 'goal-1', definitionVersion: 2, definitionDigest: sha, assessmentId,
      sessionId: 'session-1', nativeGoalId: 'native-goal-1',
    } },
    objective: 'Publish a confirmed report',
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'verifier-goal-outcome-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  const producer = new GoalsProducer()
  ctx.provide('assistantGoals' as never, producer as never)
  const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
  const [verifiedAuthority] = createVerifierAuthorities({ authorities: [authority] })
  const task = outcome()
  const scoped = { ...task, scope: { ...task.scope, workspace: root } }
  let now = 1_000
  const config = {
    databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority],
    profiles: [{ id: 'goal-outcome-profile', version: 1, scope: scoped.scope, owner: scoped.owner,
      taskKind: 'goal-outcome' as const, objective: scoped.objective, validityMs: 10_000,
      bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
      criteria: [{ id: 'report', kind: 'document-citations' as const,
        authority: { id: 'sources', digest: verifiedAuthority!.digest }, artifactPath: 'report.md',
        requiredText: ['Confirmed result'], quotes: [] }] }],
  }
  const service = new AssistantVerifierService(ctx, config, { now: () => now })
  const assessment = (id: string) => ({ ...scoped, task: { ...scoped.task, ref: id, goal: { ...scoped.task.goal, assessmentId: id } } })
  return { root, ctx, producer, service, config, template: scoped, assessment, time: (value: number) => { now = value }, now: () => now }
}

describe('goal outcome v3 acceptance', () => {
  it('freezes whole-goal conditions, then independently grades a later assessment after the artifact is repaired', async () => {
    const { root, producer, service, template, assessment, now, time } = await harness()
    const registration = producer.registration!
    const conditions = registration.prepare(template)!
    expect(service.inspectAcceptedTask(conditions.contractId)?.contract).toMatchObject({
      protocol: 'task-acceptance/v3', task: { kind: 'goal-outcome', ref: 'assessment-1' },
    })

    await writeFile(join(root, 'report.md'), 'The model claimed success.')
    time(1_100)
    producer.complete(conditions, 'assessment-1', now())
    await registration.completed(conditions)
    await service.tick()
    expect(service.inspect(conditions.contractId)).toMatchObject({ state: 'done', receipt: {
      protocol: 'task-verification/v3', task: { kind: 'goal-outcome' }, objectiveStatus: 'not-achieved',
    } })

    await writeFile(join(root, 'report.md'), 'Confirmed result\n')
    const retry = registration.prepareGoalAssessment!(assessment('assessment-2'), conditions)
    const frozen = service.inspectAcceptedTask(conditions.contractId)!.contract
    expect(service.inspectAcceptedTask(retry.contractId)!.contract).toMatchObject({
      profile: frozen.profile, criteria: frozen.criteria, bounds: frozen.bounds, expiresAt: frozen.expiresAt,
    })
    time(1_200)
    producer.complete(retry, 'assessment-2', now())
    await registration.completed(retry)
    await service.tick()
    expect(service.inspect(retry.contractId)).toMatchObject({ state: 'done', receipt: {
      protocol: 'task-verification/v3', task: { kind: 'goal-outcome', ref: 'assessment-2' }, objectiveStatus: 'achieved',
    } })
  })

  it('rejects a changed goal definition, owner, or frozen template conditions', async () => {
    const { producer, service, template, assessment } = await harness()
    const registration = producer.registration!
    const conditions = registration.prepare(template)!
    expect(() => registration.prepare({ ...template, task: { ...template.task, goal: { ...template.task.goal, id: 'other-goal' } } })).toThrow(/changed|identity|binding differs/i)
    expect(() => registration.prepareGoalAssessment!(assessment('assessment-2'), { ...conditions, contractDigest: 'b'.repeat(64) })).toThrow(/template/i)
    expect(() => registration.prepareGoalAssessment!({ ...assessment('assessment-2'), owner: { principalRecordId: 'owner-2', principalVersion: 1 } }, conditions)).toThrow(/definition or owner/i)
    expect(() => registration.prepareGoalAssessment!({ ...assessment('assessment-2'), task: { ...assessment('assessment-2').task, goal: { ...assessment('assessment-2').task.goal, definitionDigest: 'b'.repeat(64) } } }, conditions)).toThrow(/definition or owner/i)
    expect(() => registration.prepareGoalAssessment!({ ...assessment('assessment-2'), task: { ...assessment('assessment-2').task, goal: { ...assessment('assessment-2').task.goal, id: 'other-goal' } } }, conditions)).toThrow(/definition or owner/i)

    const original = service.inspectAcceptedTask(conditions.contractId)!.contract
    expect(() => registration.prepareGoalAssessment!(assessment('assessment-2'), { contractId: conditions.contractId, contractDigest: original.digest.slice(0, -1) + (original.digest.endsWith('b') ? 'c' : 'b') })).toThrow(/template/i)
  })

  it('does not let a current profile replacement or elapsed absolute validity regrade the template', async () => {
    const { producer, template, assessment, time } = await harness()
    const registration = producer.registration!
    const conditions = registration.prepare(template)!
    time(10_000)
    expect(() => registration.prepareGoalAssessment!(assessment('assessment-2'), conditions)).toThrow(/unavailable or expired/i)
  })

  it('rejects an assessment when the original profile digest is no longer configured', async () => {
    const { ctx, producer, config, template, assessment } = await harness()
    const conditions = producer.registration!.prepare(template)!
    await ctx.fiber.restart()
    contexts.splice(contexts.indexOf(ctx), 1)
    const next = new Context(); contexts.push(next)
    next.provide('assistantGoals' as never, producer as never)
    const changedProfile = { ...config, profiles: config.profiles.map(profile => ({ ...profile,
      criteria: [{ ...profile.criteria[0]!, requiredText: ['A replacement grader condition'] }],
    })) }
    new AssistantVerifierService(next, changedProfile, { now: () => 2_000 })
    expect(() => producer.registration!.prepareGoalAssessment!(assessment('assessment-2'), conditions)).toThrow(/unavailable or expired/i)
  })

  it('does not expose whole-goal assessment preparation to Delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verifier-goal-outcome-delivery-')); roots.push(root)
    const ctx = new Context(); contexts.push(ctx)
    const delivery = new GoalsProducer()
    ctx.provide('assistantDelivery' as never, delivery as never)
    const task = outcome()
    const scoped = { ...task, scope: { ...task.scope, workspace: root } }
    const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
    const [verifiedAuthority] = createVerifierAuthorities({ authorities: [authority] })
    new AssistantVerifierService(ctx, { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: false, authorities: [authority], profiles: [{ id: 'delivery-profile', version: 1, scope: scoped.scope, owner: scoped.owner, taskKind: 'foreground-turn', objective: scoped.objective, validityMs: 10_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 }, criteria: [{ id: 'report', kind: 'document-citations', authority: { id: 'sources', digest: verifiedAuthority!.digest }, artifactPath: 'report.md', requiredText: ['Confirmed result'], quotes: [] }] }] })
    expect(() => delivery.registration!.prepareGoalAssessment!(scoped, { contractId: 'missing', contractDigest: sha })).toThrow(/wrong Host assessment producer/i)
  })

  it('rebinds a durable template after service reload without extending its absolute expiry', async () => {
    const { ctx, producer, config, template, assessment, time, now } = await harness()
    const first = producer.registration!.prepare(template)!
    time(2_000)
    await ctx.fiber.restart()
    contexts.splice(contexts.indexOf(ctx), 1)
    const next = new Context(); contexts.push(next)
    next.provide('assistantGoals' as never, producer as never)
    const reopened = new AssistantVerifierService(next, config, { now })
    const rebound = producer.registration!.prepareGoalAssessment!(assessment('assessment-2'), first)
    expect(reopened.inspectAcceptedTask(rebound.contractId)?.contract).toMatchObject({
      expiresAt: 11_000, profile: { id: 'goal-outcome-profile' }, criteria: [{ id: 'report' }],
    })
    time(10_000)
    expect(() => producer.registration!.prepareGoalAssessment!(assessment('assessment-3'), first)).toThrow(/unavailable or expired/i)
  })

  it('records unknown when the durable whole-goal proof disappears after the real document grader runs', async () => {
    const { root, producer, service, template, now, time } = await harness()
    await writeFile(join(root, 'report.md'), 'Confirmed result\n')
    const handle = producer.registration!.prepare(template)!
    time(1_100)
    producer.complete(handle, 'assessment-1', now())
    const inspect = producer.inspectAcceptedExecution.bind(producer)
    let reads = 0
    producer.inspectAcceptedExecution = async contract => {
      reads += 1
      return reads === 1 ? inspect(contract) : null
    }
    await producer.registration!.completed(handle)
    await service.tick()
    expect(reads).toBe(2)
    expect(service.inspect(handle.contractId)).toMatchObject({ receipt: {
      protocol: 'task-verification/v3', objectiveStatus: 'unknown',
      results: [{ reason: 'whole-goal-assessment-authority-changed' }],
    } })
  })

  it('records unknown when the durable proof changes after the real document grader runs', async () => {
    const { root, producer, service, template, now, time } = await harness()
    await writeFile(join(root, 'report.md'), 'Confirmed result\n')
    const handle = producer.registration!.prepare(template)!
    time(1_100)
    producer.complete(handle, 'assessment-1', now())
    const inspect = producer.inspectAcceptedExecution.bind(producer)
    let reads = 0
    producer.inspectAcceptedExecution = async contract => {
      reads += 1
      const proof = await inspect(contract)
      return reads === 1 || proof === null ? proof : { ...proof, executionRef: 'assessment-1-replaced' }
    }
    await producer.registration!.completed(handle)
    await service.tick()
    expect(reads).toBe(2)
    expect(service.inspect(handle.contractId)).toMatchObject({ receipt: {
      protocol: 'task-verification/v3', objectiveStatus: 'unknown',
      results: [{ reason: 'whole-goal-assessment-authority-changed' }],
    } })
  })

  it('records unknown when the Goals registration becomes stale after the real document grader runs', async () => {
    const { root, producer, service, template, now, time } = await harness()
    await writeFile(join(root, 'report.md'), 'Confirmed result\n')
    const handle = producer.registration!.prepare(template)!
    time(1_100)
    producer.complete(handle, 'assessment-1', now())
    const inspect = producer.inspectAcceptedExecution.bind(producer)
    let reads = 0
    producer.inspectAcceptedExecution = async contract => {
      reads += 1
      const proof = await inspect(contract)
      if (reads === 2) producer.trustedAcceptanceProducerGeneration = () => 'revoked-goals-registration'
      return proof
    }
    await producer.registration!.completed(handle)
    await service.tick()
    expect(reads).toBe(2)
    expect(service.inspect(handle.contractId)).toMatchObject({ receipt: {
      protocol: 'task-verification/v3', objectiveStatus: 'unknown',
      results: [{ reason: 'whole-goal-assessment-authority-changed' }],
    } })
  })
})
