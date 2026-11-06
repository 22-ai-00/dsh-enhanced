import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationService } from '../src/service.ts'
import {
  attentionGrantExceeded,
  attentionHoldoutMember,
  attentionHoldoutModulus,
  attentionLooseningChange,
  defaultAttentionTuningParameters,
  normalizeAttentionLooseningGrant,
  replayAttentionLoosening,
  type AttentionReplayRecord,
  type AttentionTuningParameters,
} from '../src/attention-tuning.ts'

const scope = { workspace: '/work/attention', preset: 'primary' }
const cohort = { lane: 'owner-notification', sourceId: 'assistant-proactive/v1' }
const hour = 3_600_000
const day = 24 * hour
const policy = { minSample: 20, negativeRatePpm: 600_000, muteRatePpm: 900_000, regressionMarginPpm: 100_000 }
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const tuned = (overrides: Partial<AttentionTuningParameters>): AttentionTuningParameters => ({ ...defaultAttentionTuningParameters, ...overrides })
const tightest = tuned({ interruptionCostDelta: 100, minimumUtilityDelta: 100, quietExtensionMinutes: 120, muted: true })
const holdoutIds = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`).filter(attentionHoldoutMember)

type Fact = Record<string, unknown> & { outboxId: string; auditSequence: number }

class FactSource {
  readonly facts = new Map<string, Fact>()
  sequence = 0
  put(value: Fact) { this.facts.set(value.outboxId, value) }
  /** Notification `${prefix}-${index}` is owner-rejected when `negative` says so (first N, or a predicate on the id); otherwise accepted. */
  batch(prefix: string, count: number, negative: number | ((id: string) => boolean), at: number) {
    for (let index = 0; index < count; index += 1) {
      const id = `${prefix}-${index}`
      const rejected = typeof negative === 'number' ? index < negative : negative(id)
      this.sequence += 1
      this.put({
        auditSequence: this.sequence, outboxId: id, bindingId: 'binding-1', scope, ...cohort,
        purpose: 'attention', purposeSource: 'lane', verdict: 'would-accept', reasons: [], auditedAt: at,
        transport: { status: 'delivered', acceptedAt: at + 1, deliveredAt: at + 2 },
        judgement: { source: 'owner-objective', version: 1, objectiveStatus: rejected ? 'not-achieved' : 'achieved' },
      })
    }
  }
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

function setup(options: { path?: string; loosening?: boolean | undefined; source?: FactSource; clock?: { now: number } } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const source = options.source ?? new FactSource()
  const clock = options.clock ?? { now: 10_000 }
  ctx.provide('assistantDelivery' as never, source as never)
  const evaluation = new AssistantEvaluationService(ctx, {
    databasePath: options.path ?? ':memory:', projectionIntervalMs: 0,
    notificationOutcomesEnabled: true, notificationResponseWindowMs: hour, notificationSyncBatchSize: 500,
    attentionTuningAutoAdopt: true, attentionTuningObservationMs: day,
    ...(options.loosening === undefined ? {} : { attentionLooseningEnabled: options.loosening }),
  }, { now: () => clock.now })
  const sync = () => {
    while (evaluation.reconcileNotificationOutcomes().ingested > 0) { /* drain */ }
    return evaluation.reconcileAttentionTuning()
  }
  const request = (parameters: AttentionTuningParameters) => evaluation.requestAttentionTuning({ scope, cohort, parameters })
  const grant = (overrides: Record<string, unknown> = {}) => evaluation.grantAttentionLoosening({ scope, cohort, grant: {
    grantId: 'grant-1', lowerBound: defaultAttentionTuningParameters, upperBound: tightest,
    maxStepsPerAdoption: 1, maxAdoptions: 1, expiresAt: clock.now + 7 * day, ...overrides,
  } })
  const status = () => evaluation.attentionLooseningStatus({ scope, cohort })
  return { ctx, source, clock, evaluation, sync, request, grant, status }
}

/** 200 owner-accepted notifications under the default, then an owner-requested tightening to ICD 10 that settles. */
function tightenedParent(f: ReturnType<typeof setup>, negative: number | ((id: string) => boolean) = 0) {
  f.source.batch('a', 200, negative, 1_000)
  f.sync()
  expect(f.request(tuned({ interruptionCostDelta: 10 }))).toMatchObject({ status: 'adopted', version: 1 })
  f.clock.now += day
  expect(f.sync()).toMatchObject([{ result: { action: 'settled', version: 1 } }])
}

describe('pure loosening replay', () => {
  test('holdout partition is a fixed hash of the notification id', () => {
    const ids = Array.from({ length: 4_000 }, (_, index) => `n-${index}`)
    const members = ids.filter(attentionHoldoutMember)
    expect(members).toEqual(ids.filter(attentionHoldoutMember))
    expect(attentionHoldoutModulus).toBe(4)
    expect(members.length).toBeGreaterThan(900)
    expect(members.length).toBeLessThan(1_100)
    expect(holdoutIds('a', 200).length).toBeGreaterThanOrEqual(20)
  })

  test('a loosening is exactly one parameter moved toward the default by whole steps', () => {
    expect(attentionLooseningChange(tuned({ interruptionCostDelta: 30 }), tuned({ interruptionCostDelta: 10 })))
      .toEqual({ parameter: 'interruptionCostDelta', from: 30, to: 10, steps: 2 })
    expect(attentionLooseningChange(tuned({ muted: true }), tuned({}))).toEqual({ parameter: 'muted', from: true, to: false, steps: 1 })
    expect(attentionLooseningChange(tuned({ interruptionCostDelta: 10 }), tuned({ interruptionCostDelta: 20 }))).toBeUndefined()
    expect(attentionLooseningChange(tuned({ interruptionCostDelta: 10, minimumUtilityDelta: 10 }), tuned({}))).toBeUndefined()
    expect(attentionLooseningChange(tuned({ interruptionCostDelta: 10 }), tuned({ interruptionCostDelta: 5 }))).toBeUndefined()
  })

  test('replay compares parent and candidate false positives and misses against fixed thresholds', () => {
    const parent = tuned({ interruptionCostDelta: 10 })
    const candidate = tuned({})
    const records = (shared: [number, number], discriminating: [number, number]): AttentionReplayRecord[] => [
      ...Array.from({ length: shared[0] }, () => ({ era: parent, outcome: 'accepted' as const })),
      ...Array.from({ length: shared[1] }, () => ({ era: tuned({ interruptionCostDelta: 20 }), outcome: 'rejected' as const })),
      ...Array.from({ length: discriminating[0] }, () => ({ era: candidate, outcome: 'accepted' as const })),
      ...Array.from({ length: discriminating[1] }, () => ({ era: candidate, outcome: 'expired-unhandled' as const })),
    ]
    const pass = replayAttentionLoosening(records([10, 2], [30, 5]), parent, candidate, policy)
    expect(pass).toMatchObject({
      verdict: 'pass', shared: { decided: 12, positive: 10, negative: 2 }, discriminating: { decided: 35, positive: 30, negative: 5 },
      parent: { falsePositives: 2, misses: 30 }, candidate: { falsePositives: 7, misses: 0 },
      thresholds: { minSample: 20, maxDiscriminatingNegativeRatePpm: 500_000, maxCandidateNegativeRatePpm: 600_000 },
    })
    expect(pass).not.toHaveProperty('reason')
    expect(replayAttentionLoosening(records([10, 0], [15, 4]), parent, candidate, policy)).toMatchObject({ verdict: 'fail', reason: 'insufficient-holdout' })
    expect(replayAttentionLoosening(records([0, 0], [10, 11]), parent, candidate, policy)).toMatchObject({ verdict: 'fail', reason: 'extra-interruptions' })
    expect(replayAttentionLoosening(records([0, 60], [20, 10]), parent, candidate, policy)).toMatchObject({ verdict: 'fail', reason: 'candidate-negative-rate' })
    expect(replayAttentionLoosening(records([0, 0], [10, 10]), tuned({ interruptionCostDelta: 10 }), candidate,
      { ...policy, regressionMarginPpm: 0 })).toMatchObject({ verdict: 'fail', reason: 'no-net-benefit' })
    // Records sent under an era looser than the candidate are reported but never counted.
    expect(replayAttentionLoosening([{ era: candidate, outcome: 'rejected' }], parent, tuned({ minimumUtilityDelta: 0, interruptionCostDelta: 10 }), policy))
      .toMatchObject({ unattributable: { decided: 1 } })
    expect(replayAttentionLoosening(records([10, 2], [30, 5]), parent, candidate, policy)).toEqual(pass)
  })

  test('grants are exact and every limit is reported', () => {
    const grant = normalizeAttentionLooseningGrant({ grantId: 'g', lowerBound: tuned({ interruptionCostDelta: 10 }), upperBound: tightest,
      maxStepsPerAdoption: 1, maxAdoptions: 2, expiresAt: 100 })
    expect(() => normalizeAttentionLooseningGrant({ ...grant, extra: true })).toThrow(/exactly/)
    expect(() => normalizeAttentionLooseningGrant({ ...grant, lowerBound: tightest, upperBound: tuned({}) })).toThrow(/at least as tight/)
    expect(() => normalizeAttentionLooseningGrant({ ...grant, lowerBound: tuned({ interruptionCostDelta: 5 }) })).toThrow(/grid/)
    expect(() => normalizeAttentionLooseningGrant({ ...grant, maxAdoptions: 11 })).toThrow(/maxAdoptions/)
    const parent = tuned({ interruptionCostDelta: 30 })
    expect(attentionGrantExceeded(grant, 0, parent, tuned({ interruptionCostDelta: 20 }), 1, 50)).toEqual([])
    expect(attentionGrantExceeded(undefined, 0, parent, tuned({ interruptionCostDelta: 20 }), 1, 50)).toEqual(['no-grant'])
    expect(attentionGrantExceeded(grant, 2, parent, tuned({}), 3, 100)).toEqual(['grant-expired', 'grant-exhausted', 'outside-bounds', 'step-too-large'])
  })
})

describe('attention loosening service', () => {
  test('switch off: behaviour is exactly slice 2 and nothing is sealed or recorded', () => {
    const run = (loosening: boolean | undefined) => {
      const f = setup({ loosening })
      tightenedParent(f)
      const rejected = f.request(tuned({}))
      f.source.batch('b', 30, 30, f.clock.now)
      f.clock.now += 1
      return { f, rejected, tick: f.sync(), tuning: f.evaluation.attentionTuningStatus({ scope, cohort }) }
    }
    const absent = run(undefined)
    const off = run(false)
    expect(absent.rejected).toEqual({ status: 'rejected', reason: 'loosening-requires-holdout' })
    expect(off.rejected).toEqual(absent.rejected)
    expect(off.tick).toEqual(absent.tick)
    expect(off.tuning).toEqual(absent.tuning)
    expect(absent.tick).toMatchObject([{ result: { action: 'adopted', version: 2 } }])
    expect(off.f.grant()).toEqual({ status: 'rejected', reason: 'loosening-disabled' })
    expect(off.f.status()).toEqual({ enabled: false, grant: null, proposals: [], questions: [] })
    expect(() => new AssistantEvaluationService(new Context(), {
      databasePath: ':memory:', notificationOutcomesEnabled: true, attentionLooseningEnabled: true,
    })).toThrow(/requires attentionTuningAutoAdopt/)
  })

  test('sealed proposal: proposer sees training data only and the holdout is named by digest', () => {
    const f = setup({ loosening: true })
    // Training notifications are all rejected, holdout ones all accepted: the
    // automatic tightener must react to training evidence only.
    f.source.batch('a', 200, id => !attentionHoldoutMember(id), 1_000)
    const holdout = holdoutIds('a', 200)
    const [tick] = f.sync()
    expect(tick).toMatchObject({ result: { action: 'adopted', version: 1 } })
    const version = f.evaluation.attentionTuningStatus({ scope, cohort }).versions[0]!
    expect(version.basis.stats).toMatchObject({ decided: 200 - holdout.length, negative: 200 - holdout.length })
    f.clock.now += day
    f.sync()
    const proposed = f.request(tuned({}))
    expect(proposed).toMatchObject({ status: 'proposed', holdout: { modulus: 4, count: holdout.length } })
    const [entry] = f.status().proposals
    expect(entry).toMatchObject({ decision: null, proposal: { parentVersion: 1, change: { parameter: 'interruptionCostDelta', from: 10, to: 0 }, steps: 1 } })
    expect(entry!.proposal.basis.stats).toMatchObject({ decided: 200 - holdout.length, accepted: 0 })
    const sealed = JSON.stringify(entry!.proposal)
    for (const id of holdout) expect(sealed).not.toContain(`"${id}"`)
    // Same data and clock in an independent database yields the same seal.
    const g = setup({ loosening: true })
    g.source.batch('a', 200, id => !attentionHoldoutMember(id), 1_000)
    g.sync(); g.clock.now += day; g.sync()
    expect(g.request(tuned({}))).toEqual(proposed)
  })

  test('replay pass inside the grant adopts with the exact parent; rollback and restart never refund quota', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-loosen-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const source = new FactSource()
    const clock = { now: 10_000 }
    const first = setup({ path, source, clock, loosening: true })
    tightenedParent(first)
    expect(first.grant()).toMatchObject({ status: 'granted', grantId: 'grant-1' })
    expect(first.grant()).toMatchObject({ status: 'granted' })
    expect(first.grant({ maxAdoptions: 2 })).toEqual({ status: 'rejected', reason: 'grant-conflict' })
    const proposed = first.request(tuned({}))
    expect(proposed).toMatchObject({ status: 'proposed' })
    expect(first.request(tuned({}))).toEqual({ status: 'rejected', reason: 'proposal-pending' })
    // The sealed proposal survives restart and is decided by the next tick.
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = setup({ path, source, clock, loosening: true })
    const v1 = second.evaluation.currentAttentionTuning({ scope, cohort })!
    const [decided] = second.sync()
    expect(decided).toMatchObject({ result: { action: 'loosening-adopted', version: 2, grantId: 'grant-1',
      change: { parameter: 'interruptionCostDelta', from: 10, to: 0 } } })
    const tuning = second.evaluation.attentionTuningStatus({ scope, cohort })
    expect(tuning.versions[1]).toMatchObject({ version: 2, parentVersion: 1, parentDigest: v1.digest, parameters: defaultAttentionTuningParameters, origin: 'request' })
    expect(tuning.events.at(-1)).toMatchObject({ kind: 'adopted', reason: 'holdout-accepted', detail: { grantId: 'grant-1' } })
    expect(tuning.state).toBe('observing')
    const looseningStatus = second.status()
    expect(looseningStatus.grant).toMatchObject({ used: 1, remaining: 0 })
    expect(looseningStatus.proposals[0]!.decision).toMatchObject({ decision: 'adopted', version: 2,
      replay: { verdict: 'pass', discriminating: { decided: holdoutIds('a', 200).length, negative: 0 }, shared: { decided: 0 } } })
    // Observation continues across restart; positive evidence keeps it, a negative flood rolls back to the exact parent.
    await second.ctx.fiber.restart(); contexts.splice(contexts.indexOf(second.ctx), 1)
    const third = setup({ path, source, clock, loosening: true })
    source.batch('ok', 30, 0, clock.now)
    clock.now += 1
    expect(third.sync()).toMatchObject([{ result: { action: 'observing', version: 2 } }])
    source.batch('b', 40, 40, clock.now)
    clock.now += 1
    expect(third.sync()).toMatchObject([{ result: { action: 'rolled-back', fromVersion: 2, toVersion: 1 } }])
    expect(third.evaluation.currentAttentionTuning({ scope, cohort })).toEqual(v1)
    expect(third.status().grant).toMatchObject({ used: 1, remaining: 0 })
    // Quota is spent: the next holdout pass becomes a recorded owner question, not an adoption.
    expect(third.request(tuned({}))).toMatchObject({ status: 'proposed' })
    const [question] = third.sync()
    expect(question).toMatchObject({ result: { action: 'owner-question', exceeded: ['grant-exhausted'] } })
    expect(third.evaluation.currentAttentionTuning({ scope, cohort })).toEqual(v1)
    expect(third.request(tuned({}))).toEqual({ status: 'rejected', reason: 'owner-question-pending' })
    // A fresh owner grant reopens the path.
    expect(third.grant({ grantId: 'grant-2' })).toMatchObject({ status: 'granted' })
    expect(third.request(tuned({}))).toMatchObject({ status: 'proposed' })
    expect(third.sync()).toMatchObject([{ result: { action: 'loosening-adopted', version: 3, grantId: 'grant-2' } }])
    await third.ctx.fiber.restart(); contexts.splice(contexts.indexOf(third.ctx), 1)
    const database = new DatabaseSync(path)
    expect(() => database.exec("UPDATE evaluation_attention_loosening_decisions SET decision='rejected'")).toThrow(/immutable/)
    expect(() => database.exec('DELETE FROM evaluation_attention_loosening_grants')).toThrow(/durable/)
    expect(() => database.exec('DELETE FROM evaluation_attention_owner_questions')).toThrow(/durable/)
    database.close()
  })

  test('outside the grant a structured owner question is recorded, never sent, and nothing is adopted', () => {
    const f = setup({ loosening: true })
    tightenedParent(f)
    f.request(tuned({}))
    const [noGrant] = f.sync()
    expect(noGrant).toMatchObject({ result: { action: 'owner-question', exceeded: ['no-grant'] } })
    const [entry] = f.status().questions
    expect(entry!.question).toMatchObject({
      protocol: 'assistant-evaluation/attention-owner-question/v1', kind: 'attention-loosening-authorization',
      parentVersion: 1, parent: tuned({ interruptionCostDelta: 10 }), candidate: defaultAttentionTuningParameters,
      replay: { verdict: 'pass' }, exceeded: ['no-grant'], grantId: null, choices: ['authorize-once', 'decline'], delivery: 'not-sent',
    })
    expect(f.status().proposals[0]!.decision).toMatchObject({ decision: 'owner-question', reason: 'loosening-requires-owner', version: null })
    expect(f.evaluation.attentionTuningStatus({ scope, cohort }).events.at(-1)).toMatchObject({ kind: 'request-rejected', reason: 'loosening-requires-owner' })
    // A grant whose lower bound the candidate would cross.
    expect(f.request(tuned({}))).toEqual({ status: 'rejected', reason: 'owner-question-pending' })
    f.grant({ lowerBound: tuned({ interruptionCostDelta: 10 }) })
    expect(f.request(tuned({}))).toMatchObject({ status: 'proposed' })
    expect(f.sync()).toMatchObject([{ result: { action: 'owner-question', exceeded: ['outside-bounds'] } }])
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1 })
  })

  test('holdout replay failure is rejected even when training data looks good', () => {
    const f = setup({ loosening: true })
    // Training all accepted, holdout all rejected: only the sealed replay sees the harm.
    tightenedParent(f, attentionHoldoutMember)
    f.grant()
    f.request(tuned({}))
    const [result] = f.sync()
    expect(result).toMatchObject({ result: { action: 'loosening-rejected', reason: 'holdout-failed' } })
    expect(f.status().proposals[0]!.decision).toMatchObject({ decision: 'rejected', replay: { verdict: 'fail', reason: 'extra-interruptions' } })
    expect(f.status().grant).toMatchObject({ used: 0 })
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1 })
  })

  test('drift fails closed: late holdout members or a moved parent reject', () => {
    const f = setup({ loosening: true })
    tightenedParent(f)
    f.grant({ maxAdoptions: 3 })
    f.request(tuned({}))
    // Notified inside the frozen window but ingested after sealing.
    f.source.batch('late', 100, 0, 2_000)
    expect(holdoutIds('late', 100).length).toBeGreaterThan(0)
    expect(f.sync()).toMatchObject([{ result: { action: 'loosening-rejected', reason: 'holdout-drifted' } }])
    f.request(tuned({}))
    expect(f.request(tuned({ interruptionCostDelta: 20 }))).toMatchObject({ status: 'adopted', version: 2 })
    f.clock.now += day
    f.sync()
    expect(f.sync()).toMatchObject([{ result: { action: 'loosening-rejected', reason: 'stale-parent' } }])
  })

  test('a tampered proposal or grant is never trusted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-loosen-tamper-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const source = new FactSource()
    const clock = { now: 10_000 }
    const first = setup({ path, source, clock, loosening: true })
    tightenedParent(first)
    first.grant()
    first.request(tuned({}))
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const database = new DatabaseSync(path)
    database.exec(`DROP TRIGGER evaluation_attention_loosening_proposals_immutable;
      UPDATE evaluation_attention_loosening_proposals SET proposal_json=replace(proposal_json, '"steps":1', '"steps":2');
      DROP TRIGGER evaluation_attention_loosening_grants_immutable;
      UPDATE evaluation_attention_loosening_grants SET grant_json=replace(grant_json, '"maxAdoptions":1', '"maxAdoptions":9')`)
    database.close()
    const second = setup({ path, source, clock, loosening: true })
    expect(second.sync()).toMatchObject([{ result: { action: 'loosening-rejected', reason: 'proposal-unverifiable' } }])
    expect(second.status().grant).toBeNull()
    expect(second.request(tuned({}))).toMatchObject({ status: 'proposed' })
    expect(second.sync()).toMatchObject([{ result: { action: 'owner-question', exceeded: ['grant-unverifiable'] } }])
    expect(second.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1 })
  })

  test('migrates a schema-15 database append-only and refuses a newer schema', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-loosen-mig-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const source = new FactSource()
    const clock = { now: 10_000 }
    const first = setup({ path, source, clock })
    tightenedParent(first)
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const legacy = new DatabaseSync(path)
    for (const table of ['evaluation_attention_owner_questions', 'evaluation_attention_loosening_decisions',
      'evaluation_attention_loosening_proposals', 'evaluation_attention_loosening_grants']) legacy.exec(`DROP TABLE ${table}`)
    legacy.exec("UPDATE evaluation_schema_meta SET value='15' WHERE key='schema-version'; PRAGMA user_version = 15")
    const tables = (legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'evaluation_schema_meta' ORDER BY name").all() as { name: string }[]).map(row => row.name)
    const snapshot = (db: DatabaseSync) => Object.fromEntries(tables.map(name => [name, db.prepare('SELECT * FROM ' + name).all().map(row => JSON.stringify(row)).sort()]))
    const before = snapshot(legacy)
    expect(before.evaluation_attention_tuning_versions).toHaveLength(1)
    legacy.close()
    const current = setup({ path, source, clock, loosening: true })
    expect(current.evaluation.health()).toMatchObject({ schemaVersion: 16 })
    expect(current.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1 })
    expect(current.status()).toEqual({ enabled: true, grant: null, proposals: [], questions: [] })
    await current.ctx.fiber.restart(); contexts.splice(contexts.indexOf(current.ctx), 1)
    const migrated = new DatabaseSync(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 16 })
    expect(snapshot(migrated)).toEqual(before)
    migrated.exec('PRAGMA user_version = 17')
    migrated.close()
    expect(() => setup({ path, source, clock, loosening: true })).toThrow(/schema/)
  })
})
