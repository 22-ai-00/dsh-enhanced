import { Context, Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantEvaluationService } from '../src/service.ts'
import { evaluationSchemaVersion, migrateEvaluationDatabase } from '../src/sqlite.ts'
import { createIntakeAttentionAgreementSnapshot } from '../src/intake-attention-agreement.ts'
import { EvaluationStore } from '../src/store.ts'
import { AssistantWorkItemsService } from '../../assistant-work-items/lib/index.js'
import type { Config as WorkItemsConfig } from '../../assistant-work-items/lib/config.js'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { AcceptanceHandle, AcceptanceTask, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'

const scope = { workspace: '/work/agree', preset: 'primary' }
const otherScope = { workspace: '/work/other', preset: 'primary' }
const hour = 3_600_000
const minute = 60_000
const day = 24 * hour
const clockStart = 1_000_020_000 // exactly on an hourly/minute bucket boundary
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

type Fact = Record<string, unknown> & { outboxId: string; auditSequence: number }
function fact(outboxId: string, auditSequence: number, overrides: Record<string, unknown> = {}): Fact {
  return {
    auditSequence, outboxId, bindingId: 'binding-1', scope, lane: 'background', sourceId: 'assistant-work-items',
    purpose: 'result', purposeSource: 'declared', verdict: 'would-accept', reasons: [], auditedAt: clockStart - 10_000,
    transport: { status: 'accepted', acceptedAt: clockStart - 9_000 },
    ...overrides,
  }
}

class FactSource {
  readonly facts = new Map<string, Fact>()
  put(value: Fact) { this.facts.set(value.outboxId, value) }
  inspectNotificationOutcomeFacts(input: { afterSequence?: number; limit?: number; outboxIds?: readonly string[] }) {
    if (input.outboxIds !== undefined) {
      return { protocol: 'assistant-delivery/notification-outcome-facts/v1', hasMore: false, nextAfterSequence: null,
        facts: input.outboxIds.map(id => this.facts.get(id)).filter(item => item !== undefined) }
    }
    const all = [...this.facts.values()].filter(item => item.auditSequence > (input.afterSequence ?? 0))
      .sort((a, b) => a.auditSequence - b.auditSequence)
    const page = all.slice(0, input.limit ?? 100)
    return { protocol: 'assistant-delivery/notification-outcome-facts/v1', facts: page, hasMore: all.length > page.length,
      nextAfterSequence: page.at(-1)?.auditSequence ?? null }
  }
}

class ProvenanceSource {
  readonly items = new Map<string, unknown>()
  readonly failing = new Set<string>()
  inspectIntakeProvenance(itemId: string) {
    if (this.failing.has(itemId)) throw new Error('work items unavailable')
    return this.items.get(itemId)
  }
  admit(itemId: string, itemScope: { workspace: string; preset: string } = scope) {
    this.items.set(itemId, { protocol: 'work-items/intake-provenance/v1', itemId, scope: itemScope, source: 'lark-channel',
      sourceEventId: `om-${itemId}`, ruleId: 'rule-1', policyVersion: 'v1', mode: 'auto', level: 'accept', wouldAccept: true, admittedAt: 900 })
  }
}

function setup(options: {
  path?: string
  interval?: number
  enabled?: boolean
  workItems?: ProvenanceSource | null
  clock?: { now: number }
  projectionIntervalMs?: number
  notificationSyncIntervalMs?: number
} = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const facts = new FactSource()
  const provenance = options.workItems === undefined ? new ProvenanceSource() : options.workItems
  const clock = options.clock ?? { now: clockStart }
  ctx.provide('assistantDelivery' as never, facts as never)
  if (provenance !== null) ctx.provide('assistantWorkItems' as never, provenance as never)
  const evaluation = new AssistantEvaluationService(ctx, {
    databasePath: options.path ?? ':memory:', projectionIntervalMs: options.projectionIntervalMs ?? 0,
    notificationOutcomesEnabled: true, notificationResponseWindowMs: hour,
    ...(options.notificationSyncIntervalMs === undefined ? {} : { notificationSyncIntervalMs: options.notificationSyncIntervalMs }),
    intakeAttentionAgreementEnabled: options.enabled ?? true,
    ...(options.interval === undefined ? {} : { intakeAttentionAgreementPersistIntervalMs: options.interval }),
  }, { now: () => clock.now })
  return { ctx, facts, provenance, clock, evaluation }
}

function accepted(outboxId: string, sequence: number, itemId: string) {
  return fact(outboxId, sequence, { workItemId: itemId, judgement: { source: 'work-item-feedback', version: 1, objectiveStatus: 'achieved' } })
}
function rejected(outboxId: string, sequence: number, itemId: string) {
  return fact(outboxId, sequence, { workItemId: itemId, judgement: { source: 'work-item-feedback', version: 1, objectiveStatus: 'not-achieved' } })
}

function persistedCount(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return (database.prepare('SELECT COUNT(*) AS count FROM evaluation_intake_attention_agreement').get() as { count: number }).count } finally { database.close() }
}

describe('intake attention agreement persistence (WP22 E1)', () => {
  test('writes one immutable snapshot, replays the same bucket, and appends the next bucket', async () => {
    const f = setup({ interval: minute })
    f.provenance!.admit('item-a'); f.provenance!.admit('item-b'); f.provenance!.admit('item-c')
    f.facts.put(accepted('n1', 1, 'item-a'))
    f.facts.put(fact('n2', 2, { workItemId: 'item-b', reaction: { firstAt: clockStart - 8_000 } }))
    f.facts.put(rejected('n3', 3, 'item-c'))
    expect(f.evaluation.reconcileNotificationOutcomes().revised).toBe(3)
    const first = f.evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(first.recorded).toBe(true)
    expect(first.replayed).toBe(false)
    expect(first.reason).toBeUndefined()
    expect(first.snapshot).toMatchObject({
      protocol: 'assistant-evaluation/intake-attention-agreement-snapshot/v1', causal: false, scope,
      truncated: false, provenanceAvailable: true, notIntake: 0, unresolved: 0, foreign: 0,
      intake: { notifications: 3, items: 3, agreed: 2, disagreed: 1, agreementPpm: 666_667,
        outcomes: { pending: 0, delivered: 0, reacted: 1, accepted: 1, rejected: 1, 'expired-unhandled': 0, failed: 0 } },
    })
    expect(first.snapshot!.digest).toMatch(/^[a-f0-9]{64}$/u)
    const history = f.evaluation.inspectIntakeAttentionAgreementHistory({ scope })!
    expect(history).toMatchObject({ protocol: 'assistant-evaluation/intake-attention-agreement-history/v1', causal: false, scope })
    expect(history.snapshots).toHaveLength(1)
    expect(history.snapshots[0]!.digest).toBe(first.snapshot!.digest)

    // Same bucket, later clock: replay writes nothing and keeps the first computedAt.
    f.clock.now += 10_000
    const replay = f.evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(replay).toMatchObject({ recorded: false, replayed: true })
    expect(f.evaluation.inspectIntakeAttentionAgreementHistory({ scope })!.snapshots).toHaveLength(1)

    // Next bucket appends a new immutable window; the earlier row is untouched.
    f.clock.now = clockStart + minute
    const next = f.evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(next.recorded).toBe(true)
    const grown = f.evaluation.inspectIntakeAttentionAgreementHistory({ scope })!
    expect(grown.snapshots).toHaveLength(2)
    expect(grown.snapshots[0]!.toNotifiedAt).toBeGreaterThan(grown.snapshots[1]!.toNotifiedAt)
    expect(grown.snapshots[1]!.digest).toBe(first.snapshot!.digest)
  })

  test('a late owner revision in the same window appends a new digest instead of rewriting', async () => {
    const f = setup({ interval: minute })
    f.provenance!.admit('item-a')
    f.facts.put(accepted('n1', 1, 'item-a'))
    f.evaluation.reconcileNotificationOutcomes()
    expect(f.evaluation.reconcileIntakeAttentionAgreementPersistence().recorded).toBe(true)
    f.facts.put(rejected('n1', 1, 'item-a'))
    f.evaluation.reconcileNotificationOutcomes()
    const revised = f.evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(revised.recorded).toBe(true)
    const snapshots = f.evaluation.inspectIntakeAttentionAgreementHistory({ scope })!.snapshots
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]!.toNotifiedAt).toBe(snapshots[1]!.toNotifiedAt)
    expect(snapshots[0]!.intake.outcomes.rejected).toBe(1)
    expect(snapshots[1]!.intake.outcomes.accepted).toBe(1)
  })

  test('restart replays the same bucket and keeps the durable history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-agree-restart-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const first = setup({ path, interval: minute })
    first.provenance!.admit('item-a')
    first.facts.put(accepted('n1', 1, 'item-a'))
    first.evaluation.reconcileNotificationOutcomes()
    expect(first.evaluation.reconcileIntakeAttentionAgreementPersistence().recorded).toBe(true)
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = setup({ path, interval: minute })
    second.provenance!.admit('item-a')
    const replayed = second.evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(replayed).toMatchObject({ recorded: false, replayed: true })
    const history = second.evaluation.inspectIntakeAttentionAgreementHistory({ scope })!
    expect(history.snapshots).toHaveLength(1)
    expect(persistedCount(path)).toBe(1)
  })

  test('default off: no rows, no history, and enabled-without-prerequisites is rejected', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-agree-off-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const f = setup({ path })
    f.provenance!.admit('item-a')
    f.facts.put(accepted('n1', 1, 'item-a'))
    f.evaluation.reconcileNotificationOutcomes()
    expect(f.evaluation.reconcileIntakeAttentionAgreementPersistence()).toEqual({ recorded: false, replayed: false, reason: 'disabled' })
    expect(f.evaluation.inspectIntakeAttentionAgreementHistory({ scope })!.snapshots).toEqual([])
    expect(persistedCount(path)).toBe(0)
    expect(() => setup({ enabled: false, interval: minute })).toThrow(/requires intakeAttentionAgreementEnabled/)
    expect(() => setup({ interval: 59_999 })).toThrow()
    const disabled = setup({ enabled: false })
    expect(disabled.evaluation.inspectIntakeAttentionAgreementHistory({ scope })).toBeUndefined()
  })

  test('writes no snapshot without a WorkItems peer, but counts a throwing peer item as unresolved', async () => {
    const absent = setup({ interval: minute, workItems: null })
    absent.facts.put(accepted('n1', 1, 'item-a'))
    absent.evaluation.reconcileNotificationOutcomes()
    expect(absent.evaluation.reconcileIntakeAttentionAgreementPersistence())
      .toEqual({ recorded: false, replayed: false, reason: 'work-items-unavailable' })
    expect(absent.evaluation.inspectIntakeAttentionAgreementHistory({ scope })!.snapshots).toEqual([])

    const throwing = setup({ interval: minute })
    throwing.provenance!.failing.add('item-a')
    throwing.facts.put(accepted('n1', 1, 'item-a'))
    throwing.evaluation.reconcileNotificationOutcomes()
    const result = throwing.evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(result.recorded).toBe(true)
    expect(result.snapshot).toMatchObject({ provenanceAvailable: true, unresolved: 1, intake: { notifications: 0 } })
  })

  test('records truncated scans and never attributes a foreign scope', async () => {
    const truncated = setup({ interval: minute })
    for (let index = 0; index < 1_001; index++) {
      const itemId = `item-${index}`
      truncated.provenance!.admit(itemId)
      truncated.facts.put(accepted(`n${index}`, index + 1, itemId))
    }
    for (let round = 0; round < 11; round++) truncated.evaluation.reconcileNotificationOutcomes()
    const result = truncated.evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(result.recorded).toBe(true)
    expect(result.snapshot).toMatchObject({ truncated: true, intake: { notifications: 1_000 } })

    const foreign = setup({ interval: minute })
    foreign.provenance!.admit('item-a', otherScope)
    foreign.facts.put(accepted('n1', 1, 'item-a'))
    foreign.evaluation.reconcileNotificationOutcomes()
    const foreignResult = foreign.evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(foreignResult.snapshot).toMatchObject({ foreign: 1, notIntake: 0, intake: { notifications: 0 } })
  })

  test('rides the existing notification tick when enabled', async () => {
    const f = setup({ interval: minute, projectionIntervalMs: 10, notificationSyncIntervalMs: 0 })
    f.provenance!.admit('item-a')
    f.facts.put(accepted('n1', 1, 'item-a'))
    await vi.waitFor(() => expect(f.evaluation.inspectIntakeAttentionAgreementHistory({ scope })!.snapshots).toHaveLength(1),
      { timeout: 5_000, interval: 10 })
  })

  test('migrates schema 17 to 18, keeps old rows, refuses a newer schema and fails closed on drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-agree-mig-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const legacy = new DatabaseSync(path)
    migrateEvaluationDatabase(legacy, 17)
    expect(legacy.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 17 })
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evaluation_intake_attention_agreement'").get()).toBeUndefined()
    legacy.exec("INSERT INTO evaluation_schema_meta(key, value) VALUES ('legacy-probe', 'kept')")
    legacy.close()
    chmodSync(path, 0o600)
    const current = setup({ path, interval: minute })
    expect(current.evaluation.health()).toMatchObject({ schemaVersion: 18 })
    current.provenance!.admit('item-a')
    current.facts.put(accepted('n1', 1, 'item-a'))
    current.evaluation.reconcileNotificationOutcomes()
    expect(current.evaluation.reconcileIntakeAttentionAgreementPersistence().recorded).toBe(true)
    const database = new DatabaseSync(path)
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 })
    expect(database.prepare("SELECT value FROM evaluation_schema_meta WHERE key='legacy-probe'").get()).toMatchObject({ value: 'kept' })
    expect(() => database.exec('UPDATE evaluation_intake_attention_agreement SET truncated = 1')).toThrow(/immutable/)
    expect(() => database.exec('DELETE FROM evaluation_intake_attention_agreement')).toThrow(/durable/)
    database.close()

    const newerPath = join(directory, 'newer.sqlite')
    const newer = new DatabaseSync(newerPath)
    migrateEvaluationDatabase(newer, 17)
    newer.exec('PRAGMA user_version = 19')
    newer.close()
    chmodSync(newerPath, 0o600)
    expect(() => setup({ path: newerPath })).toThrow(/newer than supported/u)

    const driftPath = join(directory, 'drift.sqlite')
    const drift = new DatabaseSync(driftPath)
    migrateEvaluationDatabase(drift, 17)
    drift.exec('CREATE TABLE evaluation_intake_attention_agreement (x TEXT)')
    drift.close()
    chmodSync(driftPath, 0o600)
    expect(() => setup({ path: driftPath })).toThrow(expect.objectContaining({ code: 'schema-drift' }))
  })

  test('rejects a poisoned byLevel before it can enter the append-only ledger', () => {
    const outcomes = { pending: 0, delivered: 0, reacted: 1, accepted: 1, rejected: 0, 'expired-unhandled': 0, failed: 0 }
    const cell = { notifications: 2, items: 1, outcomes, agreed: 2, disagreed: 0, agreementPpm: 1_000_000 }
    const agreement = { protocol: 'assistant-evaluation/intake-attention-agreement/v1' as const, causal: false as const,
      scope: { workspace: '/work/agree', preset: 'primary' }, fromNotifiedAt: 1_000, toNotifiedAt: 2_000, scanned: 2,
      truncated: false, provenanceAvailable: true, notIntake: 0, unresolved: 0, foreign: 0, intake: cell, byLevel: { accept: cell } }
    const snapshot = createIntakeAttentionAgreementSnapshot({ agreement, computedAt: 3_000, windowMs: minute, scanLimit: 1_000 })
    const store = new EvaluationStore({ path: ':memory:' })
    try {
      expect(() => store.intakeAttentionAgreement.record(scope, snapshot)).not.toThrow()
      expect(() => store.intakeAttentionAgreement.record(scope, { ...snapshot,
        byLevel: { accept: { ...cell, agreed: 99 } } })).toThrow(/invalid/u)
      expect(() => store.intakeAttentionAgreement.record(scope, { ...snapshot,
        byLevel: { bogus: cell } } as never)).toThrow(/invalid/u)
      expect(() => store.intakeAttentionAgreement.record(scope, { ...snapshot,
        byLevel: { accept: { ...cell, notifications: 99 } } })).toThrow(/invalid/u)
      expect(store.intakeAttentionAgreement.list(scope, 10)).toHaveLength(1)
    } finally { store.close() }
  })

  test('history is scope-fenced, bounded and input-checked', () => {
    const f = setup({ interval: minute })
    f.provenance!.admit('item-a')
    f.facts.put(accepted('n1', 1, 'item-a'))
    f.evaluation.reconcileNotificationOutcomes()
    expect(f.evaluation.reconcileIntakeAttentionAgreementPersistence().recorded).toBe(true)
    expect(f.evaluation.inspectIntakeAttentionAgreementHistory({ scope: otherScope })).toMatchObject({ snapshots: [] })
    expect(f.evaluation.inspectIntakeAttentionAgreementHistory({ scope, limit: 1 })!.snapshots).toHaveLength(1)
    expect(() => f.evaluation.inspectIntakeAttentionAgreementHistory({ scope, limit: 0 })).toThrow(/limit/)
    expect(() => f.evaluation.inspectIntakeAttentionAgreementHistory({ scope, limit: 101 })).toThrow(/limit/)
    const empty = setup({ interval: minute })
    expect(empty.evaluation.reconcileIntakeAttentionAgreementPersistence())
      .toEqual({ recorded: false, replayed: false, reason: 'no-work-item-notifications' })
  })

  test('requires flag combinations and writes no snapshot when the flag is off', () => {
    expect(evaluationSchemaVersion).toBe(18)
    expect(() => setup({ interval: minute, enabled: false })).toThrow(/requires intakeAttentionAgreementEnabled/)
    const off = setup({ enabled: false })
    expect(off.evaluation.inspectIntakeAttentionAgreement({ scope })).toBeUndefined()
    expect(off.evaluation.reconcileIntakeAttentionAgreementPersistence()).toMatchObject({ reason: 'disabled' })
  })
})

class PolicyPeer extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorize() { return { effect: 'allow' as const, reasonCode: 'rule-allow', ruleId: 'triage' } }
  evaluate() { return this.authorize() }
}

class SchedulerPeer extends Service {
  readonly listeners = new Set<() => void>()
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  onSchedulerWake(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  wake(): void { for (const listener of Array.from(this.listeners)) listener() }
}

/** Real verifier producer for one goal-outcome contract; it never supplies a verdict. */
class GoalsProducer implements TaskAcceptanceProducer {
  registration: TaskAcceptanceRegistration | undefined
  readonly generation = crypto.randomUUID()
  trustedAcceptanceProducerGeneration(): string { return this.generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration) {
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedExecution() { return null }
}

describe('intake agreement persistence with the real WorkItems service', () => {
  test('persists a snapshot from a real auto-admitted item provenance and real Evaluation service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-agree-real-')); directories.push(root)
    const ctx = new Context(); contexts.push(ctx)
    const clock = { now: 1_700_000_000_000 }
    const facts: Fact[] = []
    const delivery = {
      isMaintenanceDraining: () => true,
      validateOwnerRoute: (value: Record<string, unknown>) => ({ receiptVersion: 2, ...value, authorityHash: 'sha256:owner',
        principalRecordId: 'owner-1', principalVersion: 1, bindingVersion: 1, generation: 1 }),
      enqueueBackground: async () => ({ id: 'outbox-1' }),
      inspectNotificationOutcomeFacts: (input: { afterSequence?: number; limit?: number; outboxIds?: readonly string[] }) => {
        if (input.outboxIds !== undefined) {
          return { protocol: 'assistant-delivery/notification-outcome-facts/v1', hasMore: false, nextAfterSequence: null,
            facts: input.outboxIds.map(id => facts.find(item => item.outboxId === id)).filter(item => item !== undefined) }
        }
        const page = facts.filter(item => item.auditSequence > (input.afterSequence ?? 0)).slice(0, input.limit ?? 100)
        return { protocol: 'assistant-delivery/notification-outcome-facts/v1', facts: page,
          hasMore: facts.length > page.length, nextAfterSequence: page.at(-1)?.auditSequence ?? null }
      },
    }
    ctx.provide('assistantDelivery' as never, delivery as never)
    await ctx.plugin(PolicyPeer)
    await ctx.plugin(SchedulerPeer)
    const intakeText = 'the build is red again, can someone look'
    const authority = { kind: 'document' as const, id: 'sources',
      sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
    const [installed] = createVerifierAuthorities({ authorities: [authority] })
    const producer = new GoalsProducer()
    ctx.provide('assistantGoals' as never, producer as never)
    const verifier = new AssistantVerifierService(ctx, {
      databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority],
      profiles: [{ id: 'intake-agreement', version: 1, scope: { workspace: root, preset: 'primary' },
        owner: { principalRecordId: 'owner-1', principalVersion: 1 },
        taskKind: 'goal-outcome' as const, objective: intakeText, validityMs: 600_000,
        bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
        criteria: [{ id: 'report', kind: 'document-citations' as const,
          authority: { id: installed!.id, digest: installed!.digest }, artifactPath: 'report.md',
          requiredText: ['Verified'], quotes: [] }] }],
    })
    const handle: AcceptanceHandle = producer.registration!.prepare({
      scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'owner-1', principalVersion: 1 },
      task: { kind: 'goal-outcome', ref: 'assessment-1', goal: { id: 'goal-1', definitionVersion: 2,
        definitionDigest: 'a'.repeat(64), assessmentId: 'assessment-1', sessionId: 'session-1',
        nativeGoalId: 'native-goal-1' } },
      objective: intakeText,
    } as AcceptanceTask)!
    expect(handle.contractDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(verifier.inspectAcceptedTask(handle.contractId)).toMatchObject({ state: 'awaiting-execution', receipt: null })
    const workItemsConfig: WorkItemsConfig = {
      enabled: true, mode: 'active', databasePath: join(root, 'work-items.sqlite'), workRoot: join(root, 'work'),
      workerAutomationId: 'worker',
      scope: { workspace: root, preset: 'primary', principalId: 'owner:one', ownerRouteId: 'route-1',
        expiresAt: Date.now() + day },
      admission: { allowedKinds: ['triage'], maxOpenItems: 100, maxAdmitsPerHour: 100, cooldownMs: 0 },
      intakeLedger: { enabled: true, evaluation: { enabled: true,
        admit: { enabled: true, mode: 'auto', kind: 'triage', originBindingId: 'binding-origin-1', maxPerHour: 5 } } },
    }
    await ctx.plugin(AssistantWorkItemsService, workItemsConfig)
    const workItems = ctx.get('assistantWorkItems' as never) as unknown as AssistantWorkItemsService
    workItems.registerIntakeEvaluator({ protocol: 1, policy: () => ({ version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'accept' }] }),
      evaluate: () => Promise.resolve({ level: 'accept', quotes: ['someone look'] }) })
    const intakeDigest = createHash('sha256').update(intakeText).digest('hex')
    workItems.recordIntake({ source: 'lark-channel', sourceEventId: 'om_1', kind: 'message', senderAllowlisted: true,
      addressed: false, threadFollowUp: false, senderIsBot: false, occurredAt: clock.now - 60_000,
      contentDigest: intakeDigest, objective: intakeText, objectiveDigest: intakeDigest,
      acceptance: { contractId: handle.contractId, contractDigest: handle.contractDigest } }, intakeText)
    await vi.waitFor(() => expect(workItems.intakeEvaluations('lark-channel', 'om_1').length).toBe(1), { timeout: 5_000 })
    const admissions = workItems.runIntakeAdmission()
    expect(admissions).toHaveLength(1)
    expect(admissions[0]!.outcome).toBe('admitted')
    const itemId = admissions[0]!.itemId!
    expect(workItems.inspectIntakeProvenance(itemId)).toMatchObject({ itemId, wouldAccept: true, level: 'accept', mode: 'auto' })

    const evaluation = new AssistantEvaluationService(ctx, {
      databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0,
      notificationOutcomesEnabled: true, notificationResponseWindowMs: hour,
      intakeAttentionAgreementEnabled: true, intakeAttentionAgreementPersistIntervalMs: minute,
    }, { now: () => clock.now })
    facts.push({ auditSequence: 1, outboxId: 'n1', bindingId: 'binding-1', scope: { workspace: root, preset: 'primary' },
      lane: 'background', sourceId: 'assistant-work-items', purpose: 'result', purposeSource: 'declared',
      verdict: 'would-accept', reasons: [], auditedAt: clock.now - 50_000,
      transport: { status: 'accepted', acceptedAt: clock.now - 40_000 }, workItemId: itemId,
      judgement: { source: 'work-item-feedback', version: 1, objectiveStatus: 'achieved' } })
    expect(evaluation.reconcileNotificationOutcomes().revised).toBe(1)
    const persisted = evaluation.reconcileIntakeAttentionAgreementPersistence()
    expect(persisted.recorded).toBe(true)
    expect(persisted.snapshot).toMatchObject({ provenanceAvailable: true,
      intake: { notifications: 1, outcomes: { accepted: 1 }, agreed: 1, disagreed: 0, agreementPpm: 1_000_000 } })
    expect(evaluation.inspectIntakeAttentionAgreementHistory({ scope: { workspace: root, preset: 'primary' } })!
      .snapshots[0]!.intake.outcomes.accepted).toBe(1)
  })
})
