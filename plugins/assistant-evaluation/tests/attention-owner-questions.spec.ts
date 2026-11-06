import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantEvaluationService } from '../src/service.ts'
import { migrateEvaluationDatabase } from '../src/sqlite.ts'
import { defaultAttentionTuningParameters, type AttentionTuningParameters } from '../src/attention-tuning.ts'
import {
  ATTENTION_OWNER_QUESTION_SOURCE_ID,
  attentionOwnerQuestionIdempotencyKey,
  attentionOwnerQuestionText,
} from '../src/attention-owner-questions.ts'

const scope = { workspace: '/work/attention', preset: 'primary' }
const cohort = { lane: 'owner-notification', sourceId: 'assistant-proactive/v1' }
const owner = { ownerRouteId: 'owner-route-1', principalId: 'owner-1' }
const hour = 3_600_000
const day = 24 * hour
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const tuned = (overrides: Partial<AttentionTuningParameters>): AttentionTuningParameters => ({ ...defaultAttentionTuningParameters, ...overrides })
const tightest = tuned({ interruptionCostDelta: 100, minimumUtilityDelta: 100, quietExtensionMinutes: 120, muted: true })

type Fact = Record<string, unknown> & { outboxId: string; auditSequence: number }
type Enqueue = { sourceId: string; ownerRouteId: string; scope: Record<string, unknown>; sessionId: string; idempotencyKey: string; text: string; expiresAt: number; attention: unknown; withdrawable?: boolean }
type Withdrawal = { sourceId: string; isWithdrawn(idempotencyKey: string): boolean }

/**
 * Text-free Delivery facts plus a fake owner-notification path that dedupes by
 * idempotency key and intent hash like the real Outbox, with the real
 * send-time withdrawal registry and source-scoped inspect.
 */
class FakeDelivery {
  readonly facts = new Map<string, Fact>()
  readonly enqueued: Enqueue[] = []
  readonly outbox = new Map<string, { id: string; intent: string; sourceId: string; status: string; withdrawable: boolean }>()
  readonly withdrawals = new Map<string, Withdrawal>()
  sequence = 0
  routeWorkspace = scope.workspace
  failEnqueue = false
  failInspect = false
  registerOwnerNotificationWithdrawal(registration: Withdrawal) {
    if (this.withdrawals.has(registration.sourceId)) throw new Error('already registered')
    this.withdrawals.set(registration.sourceId, registration)
    return () => { if (this.withdrawals.get(registration.sourceId) === registration) this.withdrawals.delete(registration.sourceId) }
  }
  inspectOwnerNotification(input: { sourceId: string; idempotencyKey: string }) {
    if (this.failInspect) throw new Error('store unavailable')
    const record = this.outbox.get(input.idempotencyKey)
    return record === undefined || record.sourceId !== input.sourceId ? undefined : { outboxId: record.id, status: record.status }
  }
  /** Mirror of Delivery's send-time guard for withdrawable notices. */
  sendDue(): void {
    for (const [key, record] of this.outbox) {
      if (record.status !== 'pending' || !record.withdrawable) continue
      const check = this.withdrawals.get(record.sourceId)
      if (check === undefined) continue
      let withdrawn: boolean
      try { withdrawn = check.isWithdrawn(key) } catch { continue }
      record.status = withdrawn === false ? 'accepted' : 'dead'
    }
  }
  put(value: Fact) { this.facts.set(value.outboxId, value) }
  batch(prefix: string, count: number, at: number) {
    for (let index = 0; index < count; index += 1) {
      this.sequence += 1
      this.put({
        auditSequence: this.sequence, outboxId: `${prefix}-${index}`, bindingId: 'binding-1', scope, ...cohort,
        purpose: 'attention', purposeSource: 'lane', verdict: 'would-accept', reasons: [], auditedAt: at,
        transport: { status: 'delivered', acceptedAt: at + 1, deliveredAt: at + 2 },
        judgement: { source: 'owner-objective', version: 1, objectiveStatus: 'achieved' },
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
  validateOwnerRoute(input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) {
    if (input.authorityId !== owner.ownerRouteId || input.principalId !== owner.principalId || input.workspace !== this.routeWorkspace) throw new Error('route mismatch')
    return { principalRecordId: 'principal-record-1', principalVersion: 3 }
  }
  resolveOwnerRoute(authorityId: string) {
    if (authorityId !== owner.ownerRouteId) throw new Error('missing binding')
    return { binding: { sessionId: 'session-1' } }
  }
  enqueueOwnerNotification(input: Enqueue) {
    if (this.failEnqueue) throw new Error('policy denied')
    this.enqueued.push(input)
    const intent = createHash('sha256').update(JSON.stringify({ ...input, idempotencyKey: undefined })).digest('hex')
    const existing = this.outbox.get(input.idempotencyKey)
    if (existing !== undefined) {
      if (existing.intent !== intent) throw new Error('idempotency conflict')
      return { id: existing.id }
    }
    const record = { id: `outbox-${this.outbox.size + 1}`, intent, sourceId: input.sourceId, status: 'pending', withdrawable: input.withdrawable === true }
    this.outbox.set(input.idempotencyKey, record)
    return { id: record.id }
  }
}

function setup(options: { path?: string; delivery?: FakeDelivery; clock?: { now: number }; enabled?: boolean; provide?: boolean; projectionIntervalMs?: number; ttl?: number } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const delivery = options.delivery ?? new FakeDelivery()
  const clock = options.clock ?? { now: 10_000 }
  if (options.provide !== false) ctx.provide('assistantDelivery' as never, delivery as never)
  const enabled = options.enabled ?? true
  const evaluation = new AssistantEvaluationService(ctx, {
    databasePath: options.path ?? ':memory:', projectionIntervalMs: options.projectionIntervalMs ?? 0,
    notificationOutcomesEnabled: true, notificationResponseWindowMs: hour, notificationSyncBatchSize: 500, notificationSyncIntervalMs: 0,
    attentionTuningAutoAdopt: true, attentionTuningObservationMs: day, attentionLooseningEnabled: true,
    ...(enabled ? { attentionOwnerQuestionDeliveryEnabled: true, attentionOwnerQuestionOwner: owner } : {}),
    ...(options.ttl === undefined ? {} : { attentionOwnerQuestionNoticeTtlMs: options.ttl }),
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
  const deliver = () => evaluation.reconcileAttentionOwnerQuestions()
  const status = () => evaluation.attentionOwnerQuestionStatus({ scope, cohort })
  return { ctx, delivery, clock, evaluation, sync, request, grant, deliver, status }
}

/** A settled tightened parent, then a loosening request outside any grant: one recorded owner question. */
function withQuestion(f: ReturnType<typeof setup>): string {
  f.delivery.batch('a', 200, 1_000)
  f.sync()
  expect(f.request(tuned({ interruptionCostDelta: 10 }))).toMatchObject({ status: 'adopted', version: 1 })
  f.clock.now += day
  expect(f.sync()).toMatchObject([{ result: { action: 'settled', version: 1 } }])
  f.request(tuned({}))
  const [result] = f.sync()
  expect(result).toMatchObject({ result: { action: 'owner-question', exceeded: ['no-grant'] } })
  return (result!.result as { questionId: string }).questionId
}

/** Simulate a crash between enqueue and the ledger write: enqueue directly as the tick would under `ttl`. */
function crashEnqueue(f: ReturnType<typeof setup>, delivery: FakeDelivery, questionId: string, ttl: number) {
  const question = f.evaluation.attentionLooseningStatus({ scope, cohort }).questions[0]!.question
  return delivery.enqueueOwnerNotification({ sourceId: ATTENTION_OWNER_QUESTION_SOURCE_ID, ownerRouteId: owner.ownerRouteId,
    scope: { principalId: owner.principalId, principalRecordId: 'principal-record-1', principalVersion: 3, ...scope }, sessionId: 'session-1',
    idempotencyKey: attentionOwnerQuestionIdempotencyKey(questionId), text: attentionOwnerQuestionText(question, scope),
    expiresAt: question.createdAt + ttl, attention: { purpose: 'result' }, withdrawable: true })
}

/** A genuine schema-16 database built by the unchanged 0..16 migration chain. */
function schema16Database(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  chmodSync(path, 0o600)
  database.exec('PRAGMA foreign_keys = ON')
  migrateEvaluationDatabase(database, 16)
  expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 })
  return database
}

function schemaObjects(path: string): unknown[] {
  const database = new DatabaseSync(path)
  try {
    return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      .map(row => ({ ...row, sql: (row as { sql: string | null }).sql?.replace(/\s+/g, ' ') }))
  } finally {
    database.close()
  }
}

describe('attention owner question delivery', () => {
  test('off by default: questions stay recorded-only and nothing is enqueued', () => {
    const f = setup({ enabled: false })
    const questionId = withQuestion(f)
    expect(f.deliver()).toEqual([])
    expect(f.delivery.enqueued).toEqual([])
    expect(f.status()).toEqual({ enabled: false, deliveries: [], replies: [] })
    expect(f.evaluation.recordAttentionOwnerQuestionReply({ scope, cohort, questionId, choice: 'decline' }))
      .toEqual({ status: 'rejected', reason: 'delivery-disabled' })
    expect(f.evaluation.attentionLooseningStatus({ scope, cohort }).questions[0]!.question).toMatchObject({ delivery: 'not-sent' })
  })

  test('configuration requires slice 3 and an owner route', () => {
    const base = { databasePath: ':memory:', projectionIntervalMs: 0, notificationOutcomesEnabled: true, attentionTuningAutoAdopt: true }
    expect(() => new AssistantEvaluationService(new Context(), { ...base, attentionOwnerQuestionDeliveryEnabled: true, attentionOwnerQuestionOwner: owner }))
      .toThrow('attentionOwnerQuestionDeliveryEnabled requires attentionLooseningEnabled')
    expect(() => new AssistantEvaluationService(new Context(), { ...base, attentionLooseningEnabled: true, attentionOwnerQuestionDeliveryEnabled: true }))
      .toThrow('attentionOwnerQuestionDeliveryEnabled requires attentionOwnerQuestionOwner')
  })

  test('queues the open question once through the owner route with a result attention purpose', () => {
    const f = setup()
    const questionId = withQuestion(f)
    expect(f.deliver()).toMatchObject([{ result: { action: 'queued', questionId, outboxId: 'outbox-1' } }])
    expect(f.delivery.enqueued).toHaveLength(1)
    const [call] = f.delivery.enqueued
    expect(call).toMatchObject({
      sourceId: ATTENTION_OWNER_QUESTION_SOURCE_ID, ownerRouteId: owner.ownerRouteId, sessionId: 'session-1',
      scope: { principalId: owner.principalId, principalRecordId: 'principal-record-1', principalVersion: 3, ...scope },
      idempotencyKey: attentionOwnerQuestionIdempotencyKey(questionId), attention: { purpose: 'result' }, withdrawable: true,
    })
    const question = f.evaluation.attentionLooseningStatus({ scope, cohort }).questions[0]!.question
    expect(call!.expiresAt).toBe(question.createdAt + day)
    expect(call!.text).toBe(attentionOwnerQuestionText(question, scope))
    expect(f.deliver()).toEqual([])
    expect(f.delivery.enqueued).toHaveLength(1)
    expect(f.status()).toMatchObject({ enabled: true, deliveries: [{ questionId, status: 'queued', outboxId: 'outbox-1' }], replies: [] })
  })

  test('notice text stays inside the Delivery result audit and names no ids or estimates', () => {
    const f = setup()
    withQuestion(f)
    f.deliver()
    const text = f.delivery.enqueued[0]!.text
    expect(text).toContain('interruption cost offset from 10 to 0 (1 step)')
    expect(text).toContain('no owner grant is active')
    // No inbound reply parsing exists, so the notice must not invite a reply as the way to authorize.
    expect(text).toContain('record an owner grant through the host configuration')
    expect(text).toContain('Replies to this message are not read')
    expect(text).not.toMatch(/authorize once|reply "/iu)
    expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32,}\b/iu)
    expect(text).not.toMatch(/配置估值|净收益|预期收益|成功系数|执行成本|打扰成本|潜在损失|\butility\b/iu)
    expect(text.split(/\s+/u).length).toBeLessThan(400)
    expect(text.length).toBeLessThan(2_400)
  })

  test('never resends across a restart, and a crash before the ledger write adopts the same Outbox record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-owner-q-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const delivery = new FakeDelivery()
    const clock = { now: 10_000 }
    const first = setup({ path, delivery, clock })
    const questionId = withQuestion(first)
    crashEnqueue(first, delivery, questionId, day)
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = setup({ path, delivery, clock })
    expect(second.deliver()).toMatchObject([{ result: { action: 'queued', questionId, outboxId: 'outbox-1' } }])
    expect(delivery.enqueued).toHaveLength(1)
    expect(delivery.outbox.size).toBe(1)
    await second.ctx.fiber.restart(); contexts.splice(contexts.indexOf(second.ctx), 1)
    const third = setup({ path, delivery, clock })
    expect(third.deliver()).toEqual([])
    expect(delivery.enqueued).toHaveLength(1)
    expect(delivery.outbox.size).toBe(1)
  })

  test('crash after enqueue, then a newer grant, then restart: the row is adopted and withdrawn, never sent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-owner-q-crash-grant-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const delivery = new FakeDelivery()
    const clock = { now: 10_000 }
    const first = setup({ path, delivery, clock })
    const questionId = withQuestion(first)
    crashEnqueue(first, delivery, questionId, day)
    expect(first.grant()).toMatchObject({ status: 'granted' })
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    expect(delivery.withdrawals.size).toBe(0)
    const second = setup({ path, delivery, clock })
    // Adopted as queued (not recorded closed while an unsent Outbox row exists) and no second enqueue.
    expect(second.deliver()).toMatchObject([{ result: { action: 'queued', questionId, outboxId: 'outbox-1' } }])
    expect(second.status().deliveries).toMatchObject([{ questionId, status: 'queued', outboxId: 'outbox-1' }])
    expect(delivery.enqueued).toHaveLength(1)
    delivery.sendDue()
    expect(delivery.outbox.get(attentionOwnerQuestionIdempotencyKey(questionId))).toMatchObject({ status: 'dead' })
  })

  test('a notice-TTL change after a crash adopts the existing row instead of conflicting', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-owner-q-ttl-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const delivery = new FakeDelivery()
    const clock = { now: 10_000 }
    const first = setup({ path, delivery, clock })
    const questionId = withQuestion(first)
    crashEnqueue(first, delivery, questionId, day)
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = setup({ path, delivery, clock, ttl: 2 * day })
    expect(second.deliver()).toMatchObject([{ result: { action: 'queued', questionId, outboxId: 'outbox-1' } }])
    expect(delivery.enqueued).toHaveLength(1)
    // The fake Outbox hashes the intent: a re-enqueue under the new TTL would have conflicted.
    expect(() => crashEnqueue(second, delivery, questionId, 2 * day)).toThrow('idempotency conflict')
    delivery.sendDue()
    expect(delivery.outbox.get(attentionOwnerQuestionIdempotencyKey(questionId))).toMatchObject({ status: 'accepted' })
  })

  test('a question closed after queueing is withdrawn at send time; an open one is sent', () => {
    const f = setup()
    const questionId = withQuestion(f)
    expect(f.deliver()).toMatchObject([{ result: { action: 'queued', questionId } }])
    const check = f.delivery.withdrawals.get(ATTENTION_OWNER_QUESTION_SOURCE_ID)!
    const key = attentionOwnerQuestionIdempotencyKey(questionId)
    expect(check.isWithdrawn(key)).toBe(false)
    expect(check.isWithdrawn(attentionOwnerQuestionIdempotencyKey('f'.repeat(64)))).toBe(true)
    expect(check.isWithdrawn('unrelated-key')).toBe(true)
    f.grant()
    expect(check.isWithdrawn(key)).toBe(true)
    f.delivery.sendDue()
    expect(f.delivery.outbox.get(key)).toMatchObject({ status: 'dead' })

    const g = setup()
    const other = withQuestion(g)
    g.deliver()
    const otherCheck = g.delivery.withdrawals.get(ATTENTION_OWNER_QUESTION_SOURCE_ID)!
    g.evaluation.recordAttentionOwnerQuestionReply({ scope, cohort, questionId: other, choice: 'decline' })
    expect(otherCheck.isWithdrawn(attentionOwnerQuestionIdempotencyKey(other))).toBe(true)

    const h = setup()
    const sent = withQuestion(h)
    h.deliver()
    h.delivery.sendDue()
    expect(h.delivery.outbox.get(attentionOwnerQuestionIdempotencyKey(sent))).toMatchObject({ status: 'accepted' })
    h.clock.now += day
    expect(h.delivery.withdrawals.get(ATTENTION_OWNER_QUESTION_SOURCE_ID)!.isWithdrawn(attentionOwnerQuestionIdempotencyKey(sent))).toBe(true)
  })

  test('the withdrawal check is registered only when enabled and is released on stop', async () => {
    const off = setup({ enabled: false })
    expect(off.delivery.withdrawals.size).toBe(0)
    const on = setup()
    expect(on.delivery.withdrawals.size).toBe(1)
    await on.ctx.fiber.restart(); contexts.splice(contexts.indexOf(on.ctx), 1)
    expect(on.delivery.withdrawals.size).toBe(0)
  })

  test('a newer grant closes the question before it is sent', () => {
    const f = setup()
    const questionId = withQuestion(f)
    expect(f.grant()).toMatchObject({ status: 'granted' })
    expect(f.deliver()).toMatchObject([{ result: { action: 'closed', questionId } }])
    expect(f.delivery.enqueued).toEqual([])
    expect(f.status().deliveries).toMatchObject([{ questionId, status: 'closed', outboxId: null }])
    expect(f.deliver()).toEqual([])
  })

  test('an expired question is never sent', () => {
    const f = setup()
    const questionId = withQuestion(f)
    f.clock.now += day
    expect(f.deliver()).toMatchObject([{ result: { action: 'expired', questionId } }])
    expect(f.delivery.enqueued).toEqual([])
  })

  test('unavailable Delivery, a mismatched route or a failed enqueue defer without a ledger row and retry later', () => {
    const f = setup()
    const questionId = withQuestion(f)
    f.delivery.routeWorkspace = '/work/other'
    expect(f.deliver()).toMatchObject([{ result: { action: 'deferred', questionId, reason: 'route-mismatch' } }])
    f.delivery.routeWorkspace = scope.workspace
    f.delivery.failEnqueue = true
    expect(f.deliver()).toMatchObject([{ result: { action: 'deferred', questionId, reason: 'enqueue-failed' } }])
    expect(f.status().deliveries).toEqual([])
    f.delivery.failEnqueue = false
    f.delivery.failEnqueue = false
    f.delivery.failInspect = true
    expect(f.deliver()).toMatchObject([{ result: { action: 'deferred', questionId, reason: 'delivery-unavailable' } }])
    f.delivery.failInspect = false
    expect(f.deliver()).toMatchObject([{ result: { action: 'queued', questionId } }])

    expect(setup({ provide: false }).deliver()).toEqual([])
    // A Delivery without the Outbox lookup is treated as absent: nothing terminal is recorded, even for a closed question.
    const legacy = new FakeDelivery()
    Object.assign(legacy, { inspectOwnerNotification: undefined })
    const g = setup({ delivery: legacy })
    const unsent = withQuestion(g)
    g.grant()
    expect(g.deliver()).toMatchObject([{ result: { action: 'deferred', questionId: unsent, reason: 'delivery-unavailable' } }])
    expect(g.status().deliveries).toEqual([])
  })

  test('an expired question takes no reply', () => {
    const f = setup()
    const questionId = withQuestion(f)
    f.deliver()
    f.clock.now += day
    expect(f.evaluation.recordAttentionOwnerQuestionReply({ scope, cohort, questionId, choice: 'decline' }))
      .toEqual({ status: 'rejected', reason: 'question-expired' })

    const g = setup()
    const other = withQuestion(g)
    g.clock.now += day
    expect(g.deliver()).toMatchObject([{ result: { action: 'expired', questionId: other } }])
    expect(g.evaluation.recordAttentionOwnerQuestionReply({ scope, cohort, questionId: other, choice: 'authorize-once' }))
      .toEqual({ status: 'rejected', reason: 'question-expired' })
    expect(g.status().replies).toEqual([])
  })

  test('replies are record-only, idempotent, conflict-checked and never grant', () => {
    const f = setup()
    const questionId = withQuestion(f)
    f.deliver()
    const reply = (choice: unknown, id = questionId) => f.evaluation.recordAttentionOwnerQuestionReply({ scope, cohort, questionId: id, choice })
    expect(reply('authorize-once', 'f'.repeat(64))).toEqual({ status: 'rejected', reason: 'unknown-question' })
    expect(() => reply('maybe')).toThrow(/choice/)
    const recorded = reply('authorize-once')
    expect(recorded).toMatchObject({ status: 'recorded', questionId, choice: 'authorize-once' })
    expect(reply('authorize-once')).toEqual(recorded)
    expect(reply('decline')).toEqual({ status: 'rejected', reason: 'reply-conflict' })
    expect(f.status().replies).toMatchObject([{ questionId, choice: 'authorize-once' }])
    expect(f.evaluation.attentionLooseningStatus({ scope, cohort }).grant).toBeNull()
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1 })
  })

  test('a reply before delivery closes the question unsent; a closed question takes no new reply', () => {
    const f = setup()
    const questionId = withQuestion(f)
    expect(f.evaluation.recordAttentionOwnerQuestionReply({ scope, cohort, questionId, choice: 'decline' })).toMatchObject({ status: 'recorded' })
    expect(f.deliver()).toMatchObject([{ result: { action: 'closed', questionId } }])
    expect(f.delivery.enqueued).toEqual([])

    const g = setup()
    const other = withQuestion(g)
    g.grant()
    expect(g.evaluation.recordAttentionOwnerQuestionReply({ scope, cohort, questionId: other, choice: 'decline' }))
      .toEqual({ status: 'rejected', reason: 'question-closed' })
  })

  test('a tampered question is never sent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-owner-q-tamper-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const delivery = new FakeDelivery()
    const clock = { now: 10_000 }
    const first = setup({ path, delivery, clock })
    withQuestion(first)
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const database = new DatabaseSync(path)
    database.exec(`DROP TRIGGER evaluation_attention_owner_questions_immutable;
      UPDATE evaluation_attention_owner_questions SET question_json=replace(question_json, '"steps":1', '"steps":2')`)
    database.close()
    const second = setup({ path, delivery, clock })
    expect(second.deliver()).toMatchObject([{ result: { action: 'unverifiable' } }])
    expect(delivery.enqueued).toEqual([])
    expect(second.status().deliveries).toEqual([])
  })

  test('the ledger is append-only and durable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-owner-q-ledger-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const first = setup({ path })
    const questionId = withQuestion(first)
    first.deliver()
    first.evaluation.recordAttentionOwnerQuestionReply({ scope, cohort, questionId, choice: 'decline' })
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const database = new DatabaseSync(path)
    expect(() => database.exec("UPDATE evaluation_attention_owner_question_deliveries SET status='closed', outbox_id=NULL")).toThrow(/immutable/)
    expect(() => database.exec('DELETE FROM evaluation_attention_owner_question_deliveries')).toThrow(/durable/)
    expect(() => database.exec("UPDATE evaluation_attention_owner_question_replies SET choice='authorize-once'")).toThrow(/immutable/)
    expect(() => database.exec('DELETE FROM evaluation_attention_owner_question_replies')).toThrow(/durable/)
    database.close()
  })

  test('rides the existing projection tick when enabled', async () => {
    const f = setup({ projectionIntervalMs: 10 })
    withQuestion(f)
    await vi.waitFor(() => expect(f.delivery.enqueued).toHaveLength(1), { timeout: 5_000, interval: 10 })
  })

  test('migrates a genuine schema-16 database to the same schema as a fresh one and refuses a newer schema', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-owner-q-mig-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const freshPath = join(directory, 'fresh.sqlite')
    schema16Database(path).close()
    const delivery = new FakeDelivery()
    const clock = { now: 10_000 }
    const current = setup({ path, delivery, clock })
    expect(current.evaluation.health()).toMatchObject({ schemaVersion: 17 })
    const questionId = withQuestion(current)
    expect(current.deliver()).toMatchObject([{ result: { action: 'queued', questionId } }])
    await current.ctx.fiber.restart(); contexts.splice(contexts.indexOf(current.ctx), 1)
    const fresh = setup({ path: freshPath, delivery: new FakeDelivery(), clock })
    await fresh.ctx.fiber.restart(); contexts.splice(contexts.indexOf(fresh.ctx), 1)
    expect(schemaObjects(path)).toEqual(schemaObjects(freshPath))
    const newer = new DatabaseSync(path)
    newer.exec("UPDATE evaluation_schema_meta SET value='18' WHERE key='schema-version'; PRAGMA user_version = 18")
    newer.close()
    expect(() => setup({ path, delivery, clock })).toThrow()
  })

  test('drift: a schema-16 database that already holds the owner-question tables fails closed and stays at 16', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-owner-q-drift16-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const legacy = schema16Database(path)
    legacy.exec('CREATE TABLE evaluation_attention_owner_question_deliveries (question_id TEXT PRIMARY KEY, status TEXT) STRICT')
    legacy.close()
    expect(() => setup({ path })).toThrow(expect.objectContaining({ code: 'schema-drift' }))
    const database = new DatabaseSync(path)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 })
    database.close()
  })

  test('drift: a schema-17 database missing a table or trigger, or with an altered table, fails closed on open', async () => {
    const drifts = [
      'DROP TABLE evaluation_attention_owner_question_replies',
      'DROP TRIGGER evaluation_attention_owner_question_deliveries_immutable',
      'ALTER TABLE evaluation_attention_owner_question_deliveries ADD COLUMN note TEXT',
      'CREATE TRIGGER evaluation_attention_owner_question_replies_extra AFTER INSERT ON evaluation_attention_owner_question_replies BEGIN SELECT 1; END',
    ]
    for (const [index, drift] of drifts.entries()) {
      const directory = mkdtempSync(join(tmpdir(), `dsh-eval-owner-q-drift17-${index}-`)); directories.push(directory)
      const path = join(directory, 'evaluation.sqlite')
      const first = setup({ path })
      await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
      const database = new DatabaseSync(path)
      database.exec(drift)
      database.close()
      expect(() => setup({ path }), drift).toThrow(expect.objectContaining({ code: 'schema-drift' }))
    }
  })
})
