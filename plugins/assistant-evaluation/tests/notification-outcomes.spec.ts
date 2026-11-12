import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationService } from '../src/service.ts'
import { classifyNotificationOutcome, normalizeNotificationOutcomeFact, notificationOutcomeDigest } from '../src/notification-outcomes.ts'
import { notificationDeliveryStates } from '../src/types.ts'

const scope = { workspace: '/work/notify', preset: 'primary' }
const hour = 3_600_000
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

type Fact = Record<string, unknown> & { outboxId: string; auditSequence: number }
function fact(outboxId: string, auditSequence: number, overrides: Record<string, unknown> = {}): Fact {
  return {
    auditSequence, outboxId, bindingId: 'binding-1', scope, lane: 'background', sourceId: 'source-1',
    purpose: 'result', purposeSource: 'lane', verdict: 'would-accept', reasons: [], auditedAt: 1_000,
    transport: { status: 'accepted', acceptedAt: 1_100 },
    ...overrides,
  }
}

/** Structural stand-in for Delivery's WP22 read adapter. */
class FactSource {
  readonly facts = new Map<string, Fact>()
  calls: unknown[] = []
  put(value: Fact) { this.facts.set(value.outboxId, value) }
  inspectNotificationOutcomeFacts(input: { afterSequence?: number; limit?: number; outboxIds?: readonly string[] }) {
    this.calls.push(input)
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

function setup(options: { path?: string; enabled?: boolean; source?: FactSource; clock?: { now: number }; windowMs?: number; horizonMs?: number } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const source = options.source ?? new FactSource()
  const clock = options.clock ?? { now: 2_000 }
  ctx.provide('assistantDelivery' as never, source as never)
  const evaluation = new AssistantEvaluationService(ctx, {
    databasePath: options.path ?? ':memory:', projectionIntervalMs: 0,
    notificationOutcomesEnabled: options.enabled ?? true, notificationResponseWindowMs: options.windowMs ?? hour,
    ...(options.horizonMs === undefined ? {} : { notificationObservationHorizonMs: options.horizonMs }),
  }, { now: () => clock.now })
  return { ctx, source, clock, evaluation }
}

describe('notification outcome classifier', () => {
  const base = normalizeNotificationOutcomeFact(fact('n', 1))
  test('applies judgement > reply > transport > expiry precedence', () => {
    const at = (overrides: Record<string, unknown>, now = 2_000) =>
      classifyNotificationOutcome(normalizeNotificationOutcomeFact(fact('n', 1, overrides)), now, hour).outcome
    expect(classifyNotificationOutcome(base, 2_000, hour).outcome).toBe('delivered')
    expect(classifyNotificationOutcome(base, 1_100 + hour, hour)).toMatchObject({ outcome: 'expired-unhandled', expiry: { at: 1_100 + hour, responseWindowMs: hour } })
    expect(at({ transport: { status: 'pending' } }, 10 * hour)).toBe('pending')
    expect(at({ transport: { status: 'dead' } }, 10 * hour)).toBe('failed')
    expect(at({ reaction: { firstAt: 1_500, count: 2 } }, 10 * hour)).toBe('reacted')
    expect(at({ reaction: { firstAt: 1_500 }, judgement: { source: 'owner-objective', version: 1, objectiveStatus: 'achieved' } })).toBe('accepted')
    expect(at({ reaction: { firstAt: 1_500 }, judgement: { source: 'work-item-feedback', version: 2, objectiveStatus: 'not-achieved' } })).toBe('rejected')
    expect(at({ judgement: { source: 'owner-objective', version: 1, objectiveStatus: 'partial' } })).toBe('reacted')
    const withdrawn = classifyNotificationOutcome(normalizeNotificationOutcomeFact(fact('n', 1, {
      judgement: { source: 'owner-objective', version: 3, objectiveStatus: 'unknown' } })), 2_000, hour)
    expect(withdrawn.outcome).toBe('delivered')
    expect(withdrawn).not.toHaveProperty('judgement')
  })
  test('classifier v2 projects read/ignored/missed without changing the legacy 7-state outcome', () => {
    const classify = (overrides: Record<string, unknown>, now = 2_000) =>
      classifyNotificationOutcome(normalizeNotificationOutcomeFact(fact('n', 1, overrides)), now, hour)
    const read = classify({ transport: { status: 'accepted', acceptedAt: 1_100, readAt: 1_500 }, readReceipts: 'best-effort' })
    expect(read).toMatchObject({ classifier: { version: 2 }, outcome: 'delivered', deliveryState: 'read',
      transport: { readAt: 1_500 } })
    const ignored = classify({ transport: { status: 'accepted', acceptedAt: 1_100, readAt: 1_500 }, readReceipts: 'best-effort' },
      1_100 + hour)
    expect(ignored).toMatchObject({ outcome: 'expired-unhandled', deliveryState: 'ignored', expiry: { at: 1_100 + hour } })
    const missed = classify({ transport: { status: 'accepted', acceptedAt: 1_100 }, readReceipts: 'complete' }, 1_100 + hour)
    expect(missed).toMatchObject({ classifier: { version: 2 }, outcome: 'expired-unhandled', deliveryState: 'missed' })
    const bestEffort = classify({ transport: { status: 'accepted', acceptedAt: 1_100 }, readReceipts: 'best-effort' }, 1_100 + hour)
    expect(bestEffort).toMatchObject({ outcome: 'expired-unhandled' })
    expect(bestEffort).not.toHaveProperty('deliveryState')
    // Complete fact: readAt + owner reply. Owner outcomes win and adopted has no
    // producer yet, so the classifier must never invent 'adopted'.
    const full = classify({ transport: { status: 'read', acceptedAt: 1_100, deliveredAt: 1_200, readAt: 1_300 },
      readReceipts: 'complete', reaction: { firstAt: 1_400, count: 1 } })
    expect(full).toMatchObject({ outcome: 'reacted' })
    expect(full).not.toHaveProperty('deliveryState')
    expect(full.deliveryState).not.toBe('adopted')
    expect(notificationDeliveryStates).toContain('adopted')
    const judged = classify({ transport: { status: 'accepted', acceptedAt: 1_100, readAt: 1_500 },
      readReceipts: 'complete', judgement: { source: 'owner-objective', version: 1, objectiveStatus: 'not-achieved' } }, 1_100 + hour)
    expect(judged).toMatchObject({ outcome: 'rejected' })
    expect(judged).not.toHaveProperty('deliveryState')
    expect(classify({ transport: { status: 'accepted', acceptedAt: 1_100 }, readReceipts: 'complete' })).not.toHaveProperty('deliveryState')
    // Old v1 facts/records stay byte-identical: no readReceipts → classifier v1 and no projection.
    const v1 = classify({ transport: { status: 'accepted', acceptedAt: 1_100, readAt: 1_500 } })
    expect(v1).toMatchObject({ classifier: { version: 1 }, outcome: 'delivered' })
    expect(v1).not.toHaveProperty('deliveryState')
    expect(v1).not.toHaveProperty('readReceipts')
  })

  test('reaction count and text never enter the record', () => {
    const record = classifyNotificationOutcome(normalizeNotificationOutcomeFact(fact('n', 1, { reaction: { firstAt: 1_500, count: 9 } })), 2_000, hour)
    expect(record.reaction).toEqual({ firstAt: 1_500 })
  })
  test('rejects malformed facts', () => {
    for (const bad of [
      fact('n', 1, { verdict: 'maybe' }), fact('n', 1, { transport: { status: 'sent' } }), fact(' n', 1),
      fact('n', -1), fact('n', 1, { judgement: { source: 'owner-objective', version: 0, objectiveStatus: 'achieved' } }),
      fact('n', 1, { scope: { workspace: '', preset: 'x' } }), null, [],
      // Optional linked route: strict shape, never `origin`, never the notification's own binding.
      fact('n', 1, { route: null }), fact('n', 1, { route: 'linked' }), fact('n', 1, { route: { kind: 'origin', originBindingId: 'b0' } }),
      fact('n', 1, { route: { kind: 'linked' } }), fact('n', 1, { route: { kind: 'linked', originBindingId: '' } }),
      fact('n', 1, { route: { kind: 'linked', originBindingId: ' b0' } }), fact('n', 1, { route: { kind: 'linked', originBindingId: 7 } }),
      fact('n', 1, { route: { kind: 'linked', originBindingId: 'binding-1' } }),
      fact('n', 1, { route: { kind: 'linked', originBindingId: 'b0', extra: 1 } }),
    ]) expect(() => normalizeNotificationOutcomeFact(bad), JSON.stringify(bad)).toThrow()
  })
  test('a linked route is carried verbatim and never changes the outcome; route-free digests are pinned', () => {
    const pinned = fact('outbox-pinned', 7, { reasons: ['r'], workItemId: 'item-1', transport: { status: 'delivered', acceptedAt: 1_100, deliveredAt: 1_200 },
      reaction: { firstAt: 1_500, count: 2 }, judgement: { source: 'work-item-feedback', version: 2, objectiveStatus: 'partial' } })
    const expired = fact('outbox-expired', 7, { reasons: ['r'], workItemId: 'item-1' })
    const digest = (input: Fact, now = 2_000) => notificationOutcomeDigest(classifyNotificationOutcome(normalizeNotificationOutcomeFact(input), now, hour))
    // Digests produced by the classifier before the route field existed (classifier v1).
    expect(digest(pinned)).toBe('ae2efca538a99074f5990ceafc08c666598b64887e1feeaee18a556efcf0de0e')
    expect(digest(expired, 10 * hour)).toBe('77177c19c21801ee458fa99424b264ff1d1a9426fd919572c031c86bedc3cc4a')
    const linked = { ...pinned, route: { kind: 'linked', originBindingId: 'binding-origin' } }
    const record = classifyNotificationOutcome(normalizeNotificationOutcomeFact(linked), 2_000, hour)
    expect(record).toMatchObject({ classifier: { version: 1 }, outcome: 'reacted', route: { kind: 'linked', originBindingId: 'binding-origin' } })
    expect(digest(linked)).not.toBe(digest(pinned))
    expect(classifyNotificationOutcome(normalizeNotificationOutcomeFact(pinned), 2_000, hour)).not.toHaveProperty('route')
  })
})

describe('notification outcome ledger', () => {
  test('ingests from the cursor, revises on change, and is a no-op on an unchanged digest', () => {
    const { source, clock, evaluation } = setup()
    source.put(fact('n1', 1))
    source.put(fact('n2', 2, { transport: { status: 'dead' } }))
    expect(evaluation.reconcileNotificationOutcomes()).toEqual({ ingested: 2, refreshed: 2, revised: 2, invalid: 0 })
    expect(evaluation.reconcileNotificationOutcomes()).toEqual({ ingested: 0, refreshed: 2, revised: 0, invalid: 0 })
    expect(evaluation.health()).toMatchObject({ schemaVersion: 18, notificationOutcomes: 2, notificationOutcomeRevisions: 2 })

    source.put(fact('n1', 1, { reaction: { firstAt: 1_900, count: 1 } }))
    clock.now = 3_000
    expect(evaluation.reconcileNotificationOutcomes().revised).toBe(1)
    source.put(fact('n1', 1, { reaction: { firstAt: 1_900, count: 4 } }))
    expect(evaluation.reconcileNotificationOutcomes().revised).toBe(0)
    source.put(fact('n1', 1, { reaction: { firstAt: 1_900 }, judgement: { source: 'owner-objective', version: 1, objectiveStatus: 'achieved' } }))
    expect(evaluation.reconcileNotificationOutcomes().revised).toBe(1)
    // Owner corrects, then withdraws, the judgement.
    source.put(fact('n1', 1, { reaction: { firstAt: 1_900 }, judgement: { source: 'owner-objective', version: 2, objectiveStatus: 'not-achieved' } }))
    evaluation.reconcileNotificationOutcomes()
    source.put(fact('n1', 1, { reaction: { firstAt: 1_900 }, judgement: { source: 'owner-objective', version: 3, objectiveStatus: 'unknown' } }))
    evaluation.reconcileNotificationOutcomes()

    const history = evaluation.inspectNotificationOutcome({ scope, notificationId: 'n1' })!
    expect(history.revisions.map(item => item.record.outcome)).toEqual(['delivered', 'reacted', 'accepted', 'rejected', 'reacted'])
    expect(history.revisions.map(item => item.version)).toEqual([1, 2, 3, 4, 5])
    expect(history.head.version).toBe(5)
    expect(Object.isFrozen(history.head.record)).toBe(true)
    expect(evaluation.inspectNotificationOutcome({ scope: { ...scope, preset: 'other' }, notificationId: 'n1' })).toBeUndefined()
    expect(source.calls.some(call => (call as { outboxIds?: unknown }).outboxIds !== undefined)).toBe(true)
  })

  test('expires an unanswered notification and revises on a late reply', () => {
    const { source, clock, evaluation } = setup()
    source.put(fact('n1', 1))
    evaluation.reconcileNotificationOutcomes()
    clock.now = 1_100 + hour
    evaluation.reconcileNotificationOutcomes()
    expect(evaluation.inspectNotificationOutcome({ scope, notificationId: 'n1' })!.head.record).toMatchObject({
      outcome: 'expired-unhandled', expiry: { at: 1_100 + hour, responseWindowMs: hour } })
    source.put(fact('n1', 1, { reaction: { firstAt: 2 * hour, count: 1 } }))
    clock.now = 3 * hour
    evaluation.reconcileNotificationOutcomes()
    expect(evaluation.inspectNotificationOutcome({ scope, notificationId: 'n1' })!.revisions.map(item => item.record.outcome))
      .toEqual(['delivered', 'expired-unhandled', 'reacted'])
  })

  test('counts invalid facts without blocking the cursor; disabled or missing Delivery is a zero result', () => {
    const { source, evaluation } = setup()
    source.put(fact('bad', 1, { verdict: 'nope' }))
    source.put(fact('ok', 2))
    expect(evaluation.reconcileNotificationOutcomes()).toMatchObject({ ingested: 1, invalid: 1 })
    expect(evaluation.reconcileNotificationOutcomes()).toMatchObject({ ingested: 0, invalid: 0 })

    const disabled = setup({ enabled: false })
    disabled.source.put(fact('n1', 1))
    expect(disabled.evaluation.reconcileNotificationOutcomes()).toEqual({ ingested: 0, refreshed: 0, revised: 0, invalid: 0 })
    expect(disabled.source.calls).toEqual([])

    const ctx = new Context(); contexts.push(ctx)
    const alone = new AssistantEvaluationService(ctx, { databasePath: ':memory:', projectionIntervalMs: 0, notificationOutcomesEnabled: true })
    expect(alone.reconcileNotificationOutcomes()).toEqual({ ingested: 0, refreshed: 0, revised: 0, invalid: 0 })
  })

  test('feed is scope-fenced, restart-safe and returns only current heads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-notify-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const first = setup({ path })
    first.source.put(fact('n1', 1))
    first.source.put(fact('n2', 2))
    first.source.put(fact('other', 3, { scope: { workspace: '/work/other', preset: 'primary' } }))
    first.evaluation.reconcileNotificationOutcomes()
    const page = first.evaluation.notificationOutcomeFeed({ scope, limit: 1 })
    expect(page.items.map(item => item.notificationId)).toEqual(['n1'])
    expect(page).toMatchObject({ hasMore: true, scopeWatermark: 2 })
    first.source.put(fact('n1', 1, { reaction: { firstAt: 1_500, count: 1 } }))
    first.evaluation.reconcileNotificationOutcomes()
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = setup({ path, source: first.source })
    const rest = second.evaluation.notificationOutcomeFeed({ scope, after: page.nextCursor })
    expect(rest.items.map(item => [item.notificationId, item.record.outcome])).toEqual([['n2', 'delivered'], ['n1', 'reacted']])
    expect(rest.hasMore).toBe(false)
    expect(() => second.evaluation.notificationOutcomeFeed({ scope, after: { scopeKey: 'x', watermark: 0 } })).toThrow(/cursor/)
    expect(() => second.evaluation.notificationOutcomeFeed({ scope, after: { ...page.nextCursor, watermark: 99 } })).toThrow(/ahead/)
    // Cursor persisted: no re-ingest of the audit rows after restart.
    expect(second.evaluation.reconcileNotificationOutcomes().ingested).toBe(0)
  })

  test('summary counts current heads by outcome and verdict over notification time', () => {
    const { source, evaluation } = setup()
    source.put(fact('n1', 1, { verdict: 'would-reject', reasons: ['over-word-cap'] }))
    source.put(fact('n2', 2, { reaction: { firstAt: 1_500, count: 1 } }))
    source.put(fact('n3', 3, { auditedAt: 50, transport: { status: 'dead' } }))
    evaluation.reconcileNotificationOutcomes()
    const summary = evaluation.notificationOutcomeSummary({ scope, fromNotifiedAt: 100, toNotifiedAt: 5_000 })
    expect(summary).toMatchObject({ total: 2, outcomes: { delivered: 1, reacted: 1, failed: 0 } })
    expect(summary.byVerdict['would-reject'].delivered).toBe(1)
    expect(summary.byVerdict['would-accept'].reacted).toBe(1)
    expect(evaluation.notificationOutcomeSummary({ scope }).total).toBe(3)
    expect(() => evaluation.notificationOutcomeSummary({ scope, fromNotifiedAt: 10, toNotifiedAt: 5 })).toThrow(/window/)
  })

  test('a linked-route notification is ingested, revised on tagging and counted in feed and summary', () => {
    const { source, evaluation } = setup()
    source.put(fact('n1', 1))
    source.put(fact('n2', 2, { bindingId: 'binding-alias' }))
    evaluation.reconcileNotificationOutcomes()
    // Delivery starts tagging an already-ingested linked report: one new revision.
    source.put(fact('n2', 2, { bindingId: 'binding-alias', route: { kind: 'linked', originBindingId: 'binding-1' } }))
    source.put(fact('n3', 3, { bindingId: 'binding-alias', route: { kind: 'linked', originBindingId: 'binding-1' }, reaction: { firstAt: 1_500 } }))
    evaluation.reconcileNotificationOutcomes()
    const n2 = evaluation.inspectNotificationOutcome({ scope, notificationId: 'n2' })!
    expect(n2.revisions.map(revision => revision.record.route)).toEqual([undefined, { kind: 'linked', originBindingId: 'binding-1' }])
    expect(evaluation.inspectNotificationOutcome({ scope, notificationId: 'n1' })!.head.record).not.toHaveProperty('route')
    expect(evaluation.notificationOutcomeSummary({ scope })).toMatchObject({ total: 3, outcomes: { delivered: 2, reacted: 1 } })
    expect(evaluation.notificationOutcomeFeed({ scope, limit: 10 }).items.map(item => item.notificationId).sort()).toEqual(['n1', 'n2', 'n3'])
  })

  test('piggybacks on the existing projection tick', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const source = new FactSource()
    source.put(fact('n1', 1))
    ctx.provide('assistantDelivery' as never, source as never)
    const evaluation = new AssistantEvaluationService(ctx, { databasePath: ':memory:', projectionIntervalMs: 5, notificationOutcomesEnabled: true })
    await expect.poll(() => evaluation.health().notificationOutcomes, { timeout: 2_000 }).toBe(1)
  })

  test('a response-window change only revises notifications whose expiry classification changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-notify-window-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const clock = { now: 1_100 + 2 * hour }
    const first = setup({ path, clock })
    first.source.put(fact('reacted', 1, { reaction: { firstAt: 1_500, count: 1 } }))
    first.source.put(fact('accepted', 2, { judgement: { source: 'owner-objective', version: 1, objectiveStatus: 'achieved' } }))
    first.source.put(fact('pending', 3, { transport: { status: 'pending' } }))
    first.source.put(fact('expired', 4))
    expect(first.evaluation.reconcileNotificationOutcomes().revised).toBe(4)
    expect(first.evaluation.inspectNotificationOutcome({ scope, notificationId: 'reacted' })!.head.record).not.toHaveProperty('classifier.responseWindowMs')
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = setup({ path, clock, source: first.source, windowMs: 3 * hour })
    expect(second.evaluation.reconcileNotificationOutcomes()).toMatchObject({ refreshed: 4, revised: 1 })
    expect(second.evaluation.inspectNotificationOutcome({ scope, notificationId: 'expired' })!.revisions.map(item => item.record.outcome))
      .toEqual(['expired-unhandled', 'delivered'])
    clock.now = 1_100 + 3 * hour
    expect(second.evaluation.reconcileNotificationOutcomes().revised).toBe(1)
    expect(second.evaluation.inspectNotificationOutcome({ scope, notificationId: 'expired' })!.head.record)
      .toMatchObject({ outcome: 'expired-unhandled', expiry: { at: 1_100 + 3 * hour, responseWindowMs: 3 * hour } })
  })

  test('a scope-conflicting fact is counted and skipped without stalling the cursor or the re-check rotation', () => {
    const { source, evaluation } = setup()
    source.put(fact('n1', 1))
    source.put(fact('n2', 2))
    evaluation.reconcileNotificationOutcomes()
    source.put(fact('n1', 1, { scope: { workspace: '/work/other', preset: 'primary' } }))
    source.put(fact('n3', 3))
    expect(evaluation.reconcileNotificationOutcomes()).toMatchObject({ ingested: 1, invalid: 1 })
    expect(evaluation.inspectNotificationOutcome({ scope, notificationId: 'n1' })!.head.version).toBe(1)
    expect(evaluation.inspectNotificationOutcome({ scope, notificationId: 'n3' })).toBeDefined()
  })

  test('the observation horizon never ends before the response window', () => {
    const clock = { now: 2_000 }
    const { source, evaluation } = setup({ clock, windowMs: 3 * hour, horizonMs: hour })
    source.put(fact('n1', 1))
    evaluation.reconcileNotificationOutcomes()
    clock.now = 1_100 + 3 * hour
    expect(evaluation.reconcileNotificationOutcomes().revised).toBe(1)
    expect(evaluation.inspectNotificationOutcome({ scope, notificationId: 'n1' })!.head.record.outcome).toBe('expired-unhandled')
  })

  test('timer-driven sync is throttled independently of the projection tick', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const source = new FactSource()
    source.put(fact('n1', 1))
    ctx.provide('assistantDelivery' as never, source as never)
    const clock = { now: 10_000 }
    const evaluation = new AssistantEvaluationService(ctx, { databasePath: ':memory:', projectionIntervalMs: 5,
      notificationOutcomesEnabled: true, notificationSyncIntervalMs: hour }, { now: () => clock.now })
    await expect.poll(() => evaluation.health().notificationOutcomes, { timeout: 2_000 }).toBe(1)
    const calls = source.calls.length
    source.put(fact('n2', 2))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(source.calls.length).toBe(calls)
    clock.now += hour
    await expect.poll(() => evaluation.health().notificationOutcomes, { timeout: 2_000 }).toBe(2)
  })

  test('heads must mirror their revision, identities are immutable and the re-check scan is horizon-bounded', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-notify-integrity-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const first = setup({ path })
    first.source.put(fact('n1', 1))
    first.evaluation.reconcileNotificationOutcomes()
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const db = new DatabaseSync(path)
    try {
      for (const statement of [
        "UPDATE evaluation_notification_outcome_heads SET outcome='accepted'",
        "UPDATE evaluation_notification_outcome_heads SET digest='" + 'f'.repeat(64) + "'",
        'UPDATE evaluation_notification_outcome_heads SET occurred_at=occurred_at+1',
        "UPDATE evaluation_notification_outcome_heads SET scope_key='x'",
        'UPDATE evaluation_notification_outcome_heads SET version=version+1',
        `INSERT INTO evaluation_notification_outcome_heads VALUES ('n9','k',1,'${'a'.repeat(64)}','delivered',0,9,0)`,
        'UPDATE evaluation_notification_watermarks SET watermark=watermark-1',
        'DELETE FROM evaluation_notification_watermarks',
        'UPDATE evaluation_notification_sync_cursor SET after_sequence=0',
        'DELETE FROM evaluation_notification_sync_cursor',
        'DELETE FROM evaluation_notification_outcome_revisions',
      ]) expect(() => db.exec(statement), statement).toThrow()
      expect(() => db.exec('UPDATE evaluation_notification_outcome_heads SET last_checked_at=last_checked_at+1')).not.toThrow()
      const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT notification_id FROM evaluation_notification_outcome_heads
        WHERE occurred_at >= ? ORDER BY last_checked_at, notification_id LIMIT ?`).all(0, 10) as { detail: string }[])
        .map(row => row.detail).join('\n')
      expect(plan).toMatch(/evaluation_notification_outcome_heads_due \(occurred_at>\?\)/)
    } finally { db.close() }
  })

  test('migrates a schema-13 database without touching existing rows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-notify-mig-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const first = setup({ path })
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const legacy = new DatabaseSync(path)
    for (const table of ['evaluation_attention_owner_question_replies', 'evaluation_attention_owner_question_deliveries', 'evaluation_attention_owner_questions', 'evaluation_attention_loosening_decisions',
      'evaluation_attention_loosening_proposals', 'evaluation_attention_loosening_grants', 'evaluation_attention_tuning_events', 'evaluation_attention_tuning_heads', 'evaluation_attention_tuning_versions',
      'evaluation_notification_outcome_heads', 'evaluation_notification_outcome_revisions',
      'evaluation_notification_watermarks', 'evaluation_notification_sync_cursor']) legacy.exec(`DROP TABLE ${table}`)
    legacy.exec("UPDATE evaluation_schema_meta SET value='13' WHERE key='schema-version'; PRAGMA user_version = 13")
    const tables = (legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'evaluation_schema_meta' ORDER BY name").all() as { name: string }[]).map(row => row.name)
    const snapshot = (db: DatabaseSync) => Object.fromEntries(tables.map(name => [name, db.prepare('SELECT * FROM ' + name).all().map(row => JSON.stringify(row)).sort()]))
    const before = snapshot(legacy)
    legacy.close()
    const current = setup({ path })
    expect(current.evaluation.health()).toMatchObject({ schemaVersion: 18, notificationOutcomes: 0 })
    current.source.put(fact('n1', 1))
    expect(current.evaluation.reconcileNotificationOutcomes().revised).toBe(1)
    await current.ctx.fiber.restart(); contexts.splice(contexts.indexOf(current.ctx), 1)
    const migrated = new DatabaseSync(path, { readOnly: true })
    expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 })
    expect(snapshot(migrated)).toEqual(before)
    expect(() => migrated.prepare('SELECT 1').get()).not.toThrow()
    migrated.close()
    const writable = new DatabaseSync(path)
    expect(() => writable.exec("UPDATE evaluation_notification_outcome_revisions SET outcome='failed'")).toThrow()
    expect(() => writable.exec('DELETE FROM evaluation_notification_outcome_heads')).toThrow()
    writable.close()
  })
})
