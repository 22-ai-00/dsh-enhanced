import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { acceptanceDigest, type TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { AcceptedExecution, AcceptanceHandle, AcceptanceTask, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'
import { classifyIntake, intakeAcceptanceOf, intakeObjectiveOf } from '../src/intake.ts'
import { WorkItemIntakeAdmissionBridge } from '../src/intake-admission.ts'
import { settleAcceptance } from '../src/acceptance-binding.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import { claim, harness, PRESET, report, type Harness } from './fixtures.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const OBJECTIVE = 'Publish the confirmed release report'
const SHA = 'a'.repeat(64)

/** Real verifier producer for a goal-outcome contract; it never supplies a verdict. */
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
    this.proofs.set(handle.contractId, { ...handle, dispatchedAt: now, completedAt: now,
      status: 'succeeded', quiescent: true, executionRef })
  }
}

async function verifierSetup(root: string) {
  const ctx = new Context(); contexts.push(ctx)
  const producer = new GoalsProducer()
  ctx.provide('assistantGoals' as never, producer as never)
  const authority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
  const [installed] = createVerifierAuthorities({ authorities: [authority] })
  let now = Date.now()
  const service = new AssistantVerifierService(ctx, {
    databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority],
    profiles: [{
      id: 'intake-objective', version: 1, scope: { workspace: root, preset: PRESET },
      owner: { principalRecordId: 'principal-1', principalVersion: 7 },
      taskKind: 'goal-outcome' as const, objective: OBJECTIVE, validityMs: 600_000,
      bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
      criteria: [{ id: 'report', kind: 'document-citations' as const,
        authority: { id: installed!.id, digest: installed!.digest }, artifactPath: 'report.md',
        requiredText: ['Verified'], quotes: [] }],
    }],
  }, { now: () => now })
  const prepare = (ref = 'assessment-1') => producer.registration!.prepare({
    scope: { workspace: root, preset: PRESET }, owner: { principalRecordId: 'principal-1', principalVersion: 7 },
    task: { kind: 'goal-outcome', ref, goal: { id: 'goal-1', definitionVersion: 2, definitionDigest: SHA,
      assessmentId: ref, sessionId: 'session-1', nativeGoalId: 'native-goal-1' } },
    objective: OBJECTIVE,
  } as AcceptanceTask)!
  const complete = async (handle: AcceptanceHandle, ref = 'assessment-1') => {
    producer.complete(handle, ref, now)
    await producer.registration!.completed(handle)
    await service.tick()
    return service.inspectAcceptedTask(handle.contractId)!
  }
  return { service, prepare, complete }
}

function seeded(fixture: Harness, sourceEventId = 'om-1') {
  const text = 'please publish the confirmed release report'
  const digest = sha256(text)
  fixture.store.recordIntake(classifyIntake({ source: 'lark-channel', sourceEventId, kind: 'message',
    senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
    contentDigest: digest, occurredAt: 1_700_000_000_000 }))
  const evaluation = fixture.store.recordIntakeEvaluation({ source: 'lark-channel', sourceEventId,
    ruleId: 'triage', policyVersion: 'v1', sourceDigest: digest, mode: 'observe', status: 'decided',
    level: 'accept', proposedLevel: 'accept', ceiling: 'accept', quoteSpans: [], reasons: [],
    wouldAccept: true, attempts: 1, decidedAt: fixture.now() }).record
  return { text, digest, evaluation }
}

function bridge(fixture: Harness, hint: (source: string, sourceEventId: string) => unknown) {
  const admit = fixture.config.intakeLedger!.evaluation!.admit!
  return new WorkItemIntakeAdmissionBridge({
    config: admit, maxPerRun: 5, store: () => fixture.store,
    admit: decision => fixture.admission.admitDecision(decision),
    log: () => undefined, now: fixture.now, hint: hint as never,
  })
}

describe('inferred intake carries objective and real acceptance', () => {
  test('auto admission binds a real verifier contract and settleAcceptance reads its receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-items-intake-acceptance-')); roots.push(root)
    await writeFile(join(root, 'report.md'), 'Verified\n')
    const { service: verifier, prepare, complete } = await verifierSetup(root)
    const handle = prepare()
    const fixture = await harness({ scope: { workspace: root, preset: PRESET, principalId: 'owner:one',
      ownerRouteId: 'route-1', expiresAt: fixtureExpiry() },
      intakeLedger: { enabled: true, evaluation: { enabled: true,
        admit: { enabled: true, mode: 'auto', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 5 } } } },
      { verifier: () => verifier })
    fixture.policy.decision = { effect: 'allow', reasonCode: 'rule-allow', ruleId: 'triage' }
    const { evaluation, digest } = seeded(fixture)
    const record = bridge(fixture, () => ({ objective: { text: OBJECTIVE, digest: sha256(OBJECTIVE) },
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest } })).run()
    expect(record).toMatchObject([{ outcome: 'admitted', source: 'lark-channel', sourceEventId: 'om-1' }])
    const item = fixture.store.findItemById(record[0]!.itemId!)!
    expect(item.brief).toBe(OBJECTIVE)
    expect(item.briefTruncated).toBe(false)
    const binding = item.authority?.mandate?.acceptance
    expect(binding).toMatchObject({ protocol: 'work-items/acceptance-binding/v1', verifier: 'assistant-verifier',
      author: 'assistant-goals', contractId: handle.contractId, contractDigest: handle.contractDigest,
      taskKind: 'goal-outcome', criteria: 1 })
    expect(binding?.objectiveDigest).toBe(acceptanceDigest(OBJECTIVE))
    // The real verifier must produce the done receipt the frozen contract names.
    const done = await complete(handle)
    expect(done).toMatchObject({ state: 'done', contract: { id: handle.contractId, digest: handle.contractDigest } })
    claim(fixture, item.id, 'run-1')
    report(fixture, item.id, 'ready', 'run-1')
    const current = fixture.store.findItemById(item.id)!
    const settled = settleAcceptance(fixture.store, verifier, current, binding!, undefined, false)
    expect(settled).toMatchObject({ outcome: 'verified', verdict: { objectiveStatus: 'achieved' } })
    expect(evaluation).toMatchObject({ wouldAccept: true, mode: 'observe' })
    expect(digest).toHaveLength(64)
  })

  test('the WorkItems service keeps the objective/acceptance hint through real intake evaluation and admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-items-intake-service-')); roots.push(root)
    await writeFile(join(root, 'report.md'), 'Verified\n')
    const { service: verifier, prepare } = await verifierSetup(root)
    const handle = prepare()
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantVerifier' as never, verifier as never)
    ctx.provide('assistantPolicy' as never, {
      authorize: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'triage' }),
      evaluate: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'triage' }),
    } as never)
    ctx.provide('assistantDelivery' as never, {
      isMaintenanceDraining: () => false,
      validateOwnerRoute: (value: Record<string, unknown>) => ({ receiptVersion: 2, ...value, authorityHash: 'sha256:owner',
        principalRecordId: 'principal-1', principalVersion: 7, bindingVersion: 1, generation: 1 }),
      enqueueBackground: async () => ({ id: 'outbox-1' }),
    } as never)
    const service = new AssistantWorkItemsService(ctx, {
      enabled: true, mode: 'active', databasePath: join(root, 'items.sqlite'), workRoot: join(root, 'work'),
      workerAutomationId: 'worker', scope: { workspace: root, preset: PRESET, principalId: 'owner:one',
        ownerRouteId: 'route-1', expiresAt: fixtureExpiry() },
      admission: { allowedKinds: ['review'], maxOpenItems: 10, maxAdmitsPerHour: 10, cooldownMs: 0 },
      intakeLedger: { enabled: true, evaluation: { enabled: true,
        admit: { enabled: true, mode: 'auto', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 5 } } },
    })
    try {
      service.registerIntakeEvaluator({ protocol: 1, policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
        evaluate: () => Promise.resolve({ level: 'accept', quotes: ['release report'] }) })
      const text = 'please publish the release report'
      const digest = sha256(text)
      service.recordIntake({ source: 'lark-channel', sourceEventId: 'om-service', kind: 'message',
        senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
        contentDigest: digest, occurredAt: 1_700_000_000_000, objective: text, objectiveDigest: digest,
        acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest } }, text)
      await vi.waitFor(() => expect(service.intakeEvaluations('lark-channel', 'om-service')).toHaveLength(1), { timeout: 5_000 })
      const records = service.runIntakeAdmission()
      expect(records).toMatchObject([{ outcome: 'admitted', mode: 'auto' }])
      const admitted = records[0]!
      expect(admitted.itemId).toEqual(expect.any(String))
      expect(service.intakeAdmissions('lark-channel', 'om-service'))
        .toMatchObject([{ outcome: 'admitted', itemId: admitted.itemId }])
    } finally { service.close() }
  })

  test('without an acceptance handle auto stays observe and creates no item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-items-intake-no-handle-')); roots.push(root)
    const fixture = await harness({ scope: { workspace: root, preset: PRESET, principalId: 'owner:one',
      ownerRouteId: 'route-1', expiresAt: fixtureExpiry() },
      intakeLedger: { enabled: true, evaluation: { enabled: true,
        admit: { enabled: true, mode: 'auto', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 5 } } } })
    seeded(fixture)
    const record = bridge(fixture, () => ({ objective: { text: OBJECTIVE, digest: sha256(OBJECTIVE) } })).run()
    expect(record).toMatchObject([{ mode: 'observe', outcome: 'would-admit', itemId: null }])
    expect(fixture.store.countItemsSince(0)).toBe(0)
  })

  test('a mismatched acceptance digest fails closed and creates no item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-items-intake-mismatch-')); roots.push(root)
    await writeFile(join(root, 'report.md'), 'Verified\n')
    const { service: verifier, prepare } = await verifierSetup(root)
    const handle = prepare()
    const fixture = await harness({ scope: { workspace: root, preset: PRESET, principalId: 'owner:one',
      ownerRouteId: 'route-1', expiresAt: fixtureExpiry() },
      intakeLedger: { enabled: true, evaluation: { enabled: true,
        admit: { enabled: true, mode: 'auto', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 5 } } } },
      { verifier: () => verifier })
    seeded(fixture)
    const wrong = (handle.contractDigest.endsWith('b') ? 'c' : 'b').repeat(64)
    const record = bridge(fixture, () => ({ objective: { text: OBJECTIVE, digest: sha256(OBJECTIVE) },
      acceptance: { contractId: handle.contractId, contractDigest: wrong } })).run()
    expect(record).toMatchObject([{ outcome: 'refused', reasonCode: 'acceptance-mismatch', itemId: null }])
    expect(fixture.store.countItemsSince(0)).toBe(0)
  })

  test('malformed acceptance shapes and digest binding are rejected before any ledger write', () => {
    const digest = sha256('the owner asked for this')
    const base = { source: 'lark-channel', sourceEventId: 'om-shape', kind: 'message' as const,
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: digest, occurredAt: 1_700_000_000_000, objective: 'the owner asked for this', objectiveDigest: digest }
    const good = { contractId: 'acceptance-shape-1', contractDigest: 'a'.repeat(64) }
    expect(intakeAcceptanceOf({ ...base, acceptance: good } as never)).toEqual(good)
    expect(() => intakeAcceptanceOf({ ...base, acceptance: { contractId: 'acceptance-shape-1' } } as never)).toThrow(/exactly/u)
    expect(() => intakeAcceptanceOf({ ...base, acceptance: { ...good, extra: true } } as never)).toThrow(/exactly/u)
    expect(() => intakeAcceptanceOf({ ...base, acceptance: { ...good, contractId: 'bad id!' } } as never)).toThrow(/contractId/u)
    expect(() => intakeAcceptanceOf({ ...base, acceptance: { ...good, contractDigest: 'a'.repeat(63) } } as never)).toThrow(/contractDigest/u)
    expect(() => intakeObjectiveOf({ ...base, objectiveDigest: sha256('other') } as never, 'the owner asked for this'))
      .toThrow(/objectiveDigest/u)
  })

  test('a restart loses the in-memory hint and auto fails closed to observe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-items-intake-restart-')); roots.push(root)
    await writeFile(join(root, 'report.md'), 'Verified\n')
    const { service: verifier, prepare } = await verifierSetup(root)
    const handle = prepare()
    const make = (ctx: Context) => {
      ctx.provide('assistantVerifier' as never, verifier as never)
      ctx.provide('assistantPolicy' as never, {
        authorize: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'triage' }),
        evaluate: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'triage' }),
      } as never)
      ctx.provide('assistantDelivery' as never, {
        isMaintenanceDraining: () => false,
        validateOwnerRoute: (value: Record<string, unknown>) => ({ receiptVersion: 2, ...value, authorityHash: 'sha256:owner',
          principalRecordId: 'principal-1', principalVersion: 7, bindingVersion: 1, generation: 1 }),
        enqueueBackground: async () => ({ id: 'outbox-1' }),
      } as never)
      return new AssistantWorkItemsService(ctx, {
        enabled: true, mode: 'active', databasePath: join(root, 'items.sqlite'), workRoot: join(root, 'work'),
        workerAutomationId: 'worker', scope: { workspace: root, preset: PRESET, principalId: 'owner:one',
          ownerRouteId: 'route-1', expiresAt: fixtureExpiry() },
        admission: { allowedKinds: ['review'], maxOpenItems: 10, maxAdmitsPerHour: 10, cooldownMs: 0 },
        intakeLedger: { enabled: true, evaluation: { enabled: true,
          admit: { enabled: true, mode: 'auto', kind: 'review', originBindingId: 'binding-origin-1', maxPerHour: 5 } } },
      })
    }
    const firstCtx = new Context(); contexts.push(firstCtx)
    const first = make(firstCtx)
    first.registerIntakeEvaluator({ protocol: 1, policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: () => Promise.resolve({ level: 'accept', quotes: ['release report'] }) })
    const text = 'please publish the release report'
    const digest = sha256(text)
    first.recordIntake({ source: 'lark-channel', sourceEventId: 'om-restart', kind: 'message',
      senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
      contentDigest: digest, occurredAt: 1_700_000_000_000, objective: text, objectiveDigest: digest,
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest } }, text)
    await vi.waitFor(() => expect(first.intakeEvaluations('lark-channel', 'om-restart')).toHaveLength(1), { timeout: 5_000 })
    first.close()
    const secondCtx = new Context(); contexts.push(secondCtx)
    const second = make(secondCtx)
    try {
      expect(second.runIntakeAdmission()).toMatchObject([{ mode: 'observe', outcome: 'would-admit', itemId: null }])
      expect(second.intakeAdmissions('lark-channel', 'om-restart')).toMatchObject([{ outcome: 'would-admit', itemId: null }])
    } finally { second.close() }
  })

  test('over-limit objective and mismatched digest are rejected at intake, never truncated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-items-intake-bound-')); roots.push(root)
    const ctx = new Context(); contexts.push(ctx)
    const service = new AssistantWorkItemsService(ctx, {
      enabled: true, mode: 'observe', databasePath: join(root, 'state.sqlite'), workRoot: join(root, 'work'),
      intakeLedger: { enabled: true },
    } as never)
    try {
      const text = 'x'.repeat(2_500)
      const digest = sha256(text)
      const input = { source: 'lark-channel', sourceEventId: 'om-long', kind: 'message' as const,
        senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
        contentDigest: digest, occurredAt: 1_700_000_000_000, objective: text, objectiveDigest: digest }
      expect(() => service.recordIntake(input, text)).toThrow(/objective/u)
      const short = 'the owner asked for this'
      expect(() => service.recordIntake({ ...input, sourceEventId: 'om-mismatch', contentDigest: sha256(short),
        objective: short, objectiveDigest: sha256('other') }, short)).toThrow(/objectiveDigest|SHA-256/u)
    } finally { service.close() }
  })
})

function fixtureExpiry(): number { return Date.now() + 86_400_000 }
