import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService } from '../src/service.ts'
import { createVerifierAuthorities } from '../src/drivers.ts'
import type { AcceptedExecution, AcceptanceHandle, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '../src/host.ts'

const roots: string[] = []
const contexts: Context[] = []
const sha = 'a'.repeat(64)

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.restart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class GoalsProducer implements TaskAcceptanceProducer {
  registration: TaskAcceptanceRegistration | undefined
  readonly generation = crypto.randomUUID()
  readonly proofs = new Map<string, AcceptedExecution>()
  trustedAcceptanceProducerGeneration(): string { return this.generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration) {
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedExecution(contract: TaskAcceptanceContract) { return this.proofs.get(contract.id) ?? null }
  complete(handle: AcceptanceHandle, now: number) {
    this.proofs.set(handle.contractId, { ...handle, dispatchedAt: now - 10, completedAt: now, status: 'succeeded', quiescent: true, executionRef: 'run-1' })
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'verifier-owner-prepared-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  const producer = new GoalsProducer()
  ctx.provide('assistantGoals' as never, producer as never)
  const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
  const [installed] = createVerifierAuthorities({ authorities: [authority] })
  let now = 1_000
  const config = { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority] }
  const service = new AssistantVerifierService(ctx, config, { now: () => now })
  const task = { kind: 'goal-outcome' as const, ref: 'assessment-1', goal: { id: 'goal-1', definitionVersion: 2, definitionDigest: sha, assessmentId: 'assessment-1', sessionId: 'session-1', nativeGoalId: 'native-goal-1' } }
  const prepared = (overrides: Record<string, unknown> = {}) => ({
    scope: { workspace: root, preset: 'primary' },
    owner: { principalRecordId: 'owner-1', principalVersion: 1 },
    task,
    objective: 'Publish a confirmed report',
    criteria: [{ id: 'report', kind: 'document-citations' as const, authority: { id: 'sources', digest: installed!.digest },
      artifactPath: 'report.md', requiredText: ['Confirmed result'], quotes: [] }],
    bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
    validityMs: 10_000,
    preparer: { id: 'criteria-preparer', digest: sha },
    ...overrides,
  })
  return { root, producer, service, prepared, time: (value: number) => { now = value }, registration: () => producer.registration! }
}

describe('owner-prepared goal acceptance', () => {
  it('seals Host-prepared criteria without a configured profile and re-reads the same contract on replay', async () => {
    const { producer, service, prepared } = await harness()
    const registration = producer.registration!
    expect(typeof registration.prepareOwnerContract).toBe('function')
    const input = prepared()
    const handle = registration.prepareOwnerContract!(input as never)
    const read = service.inspectAcceptedTask(handle.contractId)!
    expect(read.contract).toMatchObject({ task: { kind: 'goal-outcome', ref: 'assessment-1' }, objective: 'Publish a confirmed report',
      profile: { id: 'owner-prepared', version: 1 }, criteria: [{ id: 'report', kind: 'document-citations' }] })
    expect(read.state).toBe('awaiting-execution')
    const replay = registration.prepareOwnerContract!(input as never)
    expect(replay).toEqual(handle)
  })

  it('rejects a criterion no installed authority can decide', async () => {
    const { producer, prepared } = await harness()
    const input = prepared()
    const unknown = [{ ...(input.criteria as unknown[])[0] as object, authority: { id: 'sources', digest: 'b'.repeat(64) } }]
    expect(() => producer.registration!.prepareOwnerContract!(prepared({ criteria: unknown }) as never)).toThrow(/authority is unavailable or changed/u)
    // Right id+digest but the wrong driver kind for this criterion is equally undecidable.
    const authority = (input.criteria as Array<{ authority: unknown }>)[0]!.authority
    const wrongKind = [{ id: 'run', kind: 'process-behavior', authority, artifactPath: 'bin/tool', stdin: '', expectedStdout: '', expectedExitCode: 0 }]
    expect(() => producer.registration!.prepareOwnerContract!(prepared({ criteria: wrongKind }) as never)).toThrow(/authority is unavailable or changed/u)
  })

  it('requires the seal to outlive the verification window', async () => {
    const { producer, prepared } = await harness()
    expect(() => producer.registration!.prepareOwnerContract!(prepared({ validityMs: 1_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 } }) as never))
      .toThrow(/validity must exceed verification duration/u)
  })

  it('refuses to change the sealed criteria for the same task identity', async () => {
    const { producer, prepared } = await harness()
    const registration = producer.registration!
    const first = prepared()
    const handle = registration.prepareOwnerContract!(first as never)
    const changed = [{ ...(first.criteria as unknown[])[0] as object, requiredText: ['Different clause'] }]
    expect(() => registration.prepareOwnerContract!(prepared({ criteria: changed }) as never)).toThrow(/changed for this task/u)
    // A different validity window keeps the same identity: the original seal wins.
    expect(registration.prepareOwnerContract!(prepared({ validityMs: 20_000 }) as never)).toEqual(handle)
  })

  it('keeps a prepared seal usable without any configured profile and across assessment preparation', async () => {
    const { producer, service, prepared } = await harness()
    const registration = producer.registration!
    const task = (prepared() as { task: Record<string, unknown> }).task
    const input = prepared()
    const handle = registration.prepareOwnerContract!(input as never)
    // The same task identity now resolves through the prepared seal, not a profile.
    expect(registration.prepare(input as never)).toEqual(handle)
    const base = input as { scope: unknown; owner: unknown; objective: string }
    const assessment = { scope: base.scope, owner: base.owner, objective: base.objective,
      task: { ...task, ref: 'assessment-2', goal: { ...(task.goal as Record<string, unknown>), assessmentId: 'assessment-2' } } }
    const later = registration.prepareGoalAssessment!(assessment as never, handle)
    const read = service.inspectAcceptedTask(later.contractId)!
    expect(read.contract).toMatchObject({ task: { kind: 'goal-outcome', ref: 'assessment-2' }, profile: { id: 'owner-prepared', version: 1 } })
    expect(read.contract.expiresAt).toBe(service.inspectAcceptedTask(handle.contractId)!.contract.expiresAt)
  })

  it('validates the input shape, task kind, validity and preparer provenance', async () => {
    const { producer, prepared } = await harness()
    const registration = producer.registration!
    expect(() => registration.prepareOwnerContract!({ ...prepared(), extra: true } as never)).toThrow(/invalid owner-prepared contract input/u)
    expect(() => registration.prepareOwnerContract!(prepared({ task: { kind: 'foreground-turn', ref: 'turn-1' } }) as never)).toThrow(/goal task/u)
    expect(() => registration.prepareOwnerContract!(prepared({ validityMs: 0 }) as never)).toThrow(/invalid owner-prepared validity/u)
    expect(() => registration.prepareOwnerContract!(prepared({ preparer: { id: 'x', digest: 'nope' } }) as never)).toThrow(/invalid owner-prepared preparer/u)
    expect(() => registration.prepareOwnerContract!(prepared({ objective: '  ' }) as never)).toThrow(/invalid owner-prepared objective/u)
  })


  it('exposes a sanitized, read-only acceptance authority catalog for the exact owner scope', async () => {
    const { root, service } = await harness()
    const catalog = service.inspectAcceptanceAuthorities({ scope: { workspace: root, preset: 'primary' },
      owner: { principalRecordId: 'owner-1', principalVersion: 1 } })
    expect(catalog.protocol).toBe('assistant-verifier/acceptance-authorities/v1')
    expect(catalog.authorities).toHaveLength(1)
    expect(catalog.authorities[0]).toMatchObject({ id: 'sources', digest: expect.stringMatching(/^[a-f0-9]{64}$/u), kind: 'document',
      sourceIds: ['source'] })
    // Case URLs (which may carry query tokens) must never appear in a catalog.
    expect(JSON.stringify(catalog)).not.toContain('example.org')
    expect(catalog.authorities[0]!.note).toMatch(/stay inside the verifier/u)
    const text = JSON.stringify(catalog)
    expect(text).not.toMatch(/environment|executable|stateRoot|grantId|timeoutMs|maxResponseBytes/iu)
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.authorities[0])).toBe(true)
    // Invalid selections are rejected without reflecting any authority data.
    for (const selection of [
      { scope: { workspace: 'relative', preset: 'primary' }, owner: { principalRecordId: 'owner-1', principalVersion: 1 } },
      { scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: '', principalVersion: 1 } },
      { scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'owner-1', principalVersion: 0 } },
      { scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'owner-1', principalVersion: 1 }, extra: true },
    ]) expect(() => service.inspectAcceptanceAuthorities(selection as never)).toThrow(/invalid acceptance authority catalog selection/u)
  })

  it('expires the seal instead of silently accepting it later', async () => {
    const { producer, prepared, time } = await harness()
    const registration = producer.registration!
    const handle = registration.prepareOwnerContract!(prepared() as never)
    time(11_000)
    expect(() => registration.prepareOwnerContract!(prepared() as never)).toThrow(/expired/u)
    expect(handle.contractDigest).toHaveLength(64)
  })
})
