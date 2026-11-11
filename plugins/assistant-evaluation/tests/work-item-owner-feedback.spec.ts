import { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantEvaluationService } from '../src/service.ts'
import type { TrustedDeliveryEvaluationClaims, TrustedDeliveryEvaluationRegistration, TrustedWorkItemEvaluationRegistration, TrustedWorkItemOwnerFeedbackProof } from '../src/types.ts'
import { TrustedDeliveryTestProducer } from './trusted-producer-fixture.ts'

const scope = { workspace: '/work/owner', preset: 'primary' }
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function proof(overrides: Partial<TrustedWorkItemOwnerFeedbackProof> = {}): TrustedWorkItemOwnerFeedbackProof {
  const value = {
    protocol: 'assistant-work-items/owner-report-feedback/v1' as const,
    itemId: 'item-parent', reportRevision: 1, reportDigest: 'a'.repeat(64), sourceId: 'owner-intake', itemKind: 'owner-continuation',
    scope, owner: { ownerRouteId: 'route-owner', principalId: 'owner-1', principalRecordId: 'owner-record', principalVersion: 1 },
    originBindingId: 'original-binding',
    production: { automationId: 'continuation', occurrenceId: 'occurrence-1', runId: 'run-1', definitionHash: 'b'.repeat(64),
      definitionVersion: 1, executionStatus: 'succeeded' as const, completedAt: 2_000, quiescent: true as const, budgetSettlementState: 'finalized' as const },
    supplier: { provider: 'local', model: 'frozen-model', reasoningEffort: 'high' }, planDigest: 'c'.repeat(64),
    task: { brief: 'Untrusted task brief', briefTruncated: false },
    report: { status: 'ready' as const, text: 'Untrusted worker says ready', truncated: false, recordedAt: 1_900 },
    ...overrides,
  }
  return { ...value, proofDigest: acceptanceDigest(value) }
}
class WorkItems {
  generation = 'work-items-generation-1'
  registration: Readonly<TrustedWorkItemEvaluationRegistration> | undefined
  readonly capabilities = new WeakMap<object, TrustedWorkItemOwnerFeedbackProof>()
  resolverHook: (() => void) | undefined
  trustedWorkItemProducerGeneration(): string { return this.generation }
  registerTrustedWorkItemEvaluationSink(registration: Readonly<TrustedWorkItemEvaluationRegistration>) {
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  issue(value = proof()): object { const capability = Object.freeze({}); this.capabilities.set(capability, value); return capability }
  resolveOwnerWorkItemFeedbackTarget(capability: unknown): TrustedWorkItemOwnerFeedbackProof | undefined {
    this.resolverHook?.()
    return capability && typeof capability === 'object' ? this.capabilities.get(capability) : undefined
  }
}
class WorkItemDelivery extends TrustedDeliveryTestProducer {
  feedbackAllowed = true
  inWriterFence = false
  fenceHook: (() => void) | undefined
  fenceCommitted = false
  withOwnerWorkItemFeedbackWriterFence<T>(registration: Readonly<TrustedDeliveryEvaluationRegistration>,
    _claims: Readonly<TrustedDeliveryEvaluationClaims>, _proofDigest: string, callback: () => T): T {
    // Unit producer seam: the real Delivery suite proves durable intent, Policy
    // and source checks. Here we prove Evaluation calls its current producer.
    if (registration !== this.currentRegistration() || !registration.owner.ownsTrustedDeliveryEvaluationRegistration(registration)
      || !this.feedbackAllowed) throw new Error('unit Delivery feedback writer fence rejected')
    this.fenceHook?.()
    this.inWriterFence = true
    try {
      const result = callback()
      this.fenceCommitted = true
      return result
    } finally { this.inWriterFence = false }
  }
}
function setup(path = ':memory:') {
  const ctx = new Context(); contexts.push(ctx)
  const workItems = new WorkItems(), delivery = new WorkItemDelivery()
  ctx.provide('assistantWorkItems' as never, workItems as never)
  ctx.provide('assistantDelivery' as never, delivery as never)
  const evaluation = new AssistantEvaluationService(ctx, { databasePath: path, projectionIntervalMs: 0 }, { now: () => 3_000 })
  const hostScope = evaluation.canonicalHostScope(scope)
  return { ctx, workItems, delivery, evaluation, hostScope }
}
function claims(capability: unknown, operation = 'owner-initial', overrides: Partial<TrustedDeliveryEvaluationClaims> = {}): TrustedDeliveryEvaluationClaims {
  return {
    scope, situation: 'work-item:owner-continuation', subjectKind: 'work-item', subjectRef: 'item-parent', runId: 'run-1',
    outboxId: 'outbox-parent', chatId: 'owner-chat', principalId: 'owner-1', bindingId: 'new-session-binding',
    objectiveStatus: 'not-achieved', occurredAt: 2_100, idempotencyKey: operation,
    ownerCommand: { operationId: operation, principalRecordId: 'owner-record', principalVersion: 1, action: 'initial' },
    workItemOutcomeCapability: capability, ...overrides,
  } as TrustedDeliveryEvaluationClaims
}
function appendIssued(delivery: TrustedDeliveryTestProducer, input: TrustedDeliveryEvaluationClaims, capabilityReceipt: unknown) {
  return delivery.currentRegistration()!.append({ capabilityReceipt, runId: input.runId, outboxId: input.outboxId,
    chatId: input.chatId, principalId: input.principalId, bindingId: input.bindingId, idempotencyKey: input.idempotencyKey })
}

describe('authenticated owner results for durable work items', () => {
  test.each(['succeeded','failed','timed-out','cancelled'] as const)('keeps exact %s native execution separate from the owner objective', executionStatus => {
    const { workItems, delivery, evaluation, hostScope } = setup()
    const initial = proof(), value = proof({ production: { ...initial.production, executionStatus } })
    const capability = workItems.issue(value)
    const result = delivery.append(claims(capability))
    expect(result.ownerFeedbackState).toEqual({ version: 1, objectiveStatus: 'not-achieved' })
    const canonical = evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: value.itemId })!
    expect(canonical.projection).toMatchObject({ subjectKind: 'work-item', subjectRef: value.itemId, disposition: 'upsert' })
    expect(canonical.execution).toMatchObject({ status: executionStatus, source: { kind: 'system', id: 'assistant-work-items-owner-proof' } })
    expect(canonical.objective).toMatchObject({ status: 'not-achieved', source: { kind: 'user-feedback' } })
    expect(evaluation.isTrustedTaskLearningProjectionReceipt(canonical)).toBe(true)
    expect(evaluation.listTrustedTaskLearningProjections({ scope: hostScope }).items).toHaveLength(1)
    expect(evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'later-child' })).toBeUndefined()
  })

  test('supports replay, exact correction and withdrawal without duplicate task votes', () => {
    const { workItems, delivery, evaluation, hostScope } = setup()
    const capability = workItems.issue(), initial = claims(capability)
    const result = delivery.append(initial)
    expect(delivery.append(initial).id).toBe(result.id)
    const initialProjection = evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!
    expect(evaluation.withTrustedCanonicalTaskWriterFence({ scope: hostScope, scopeWatermark: initialProjection.scopeWatermark,
      evidence: [initialProjection.projection] }, () => 'current').matched).toBe(true)
    const corrected = delivery.append(claims(capability, 'owner-correct', { objectiveStatus: 'achieved', ownerCommand: {
      operationId: 'owner-correct', principalRecordId: 'owner-record', principalVersion: 1,
      action: 'correct', expectedVersion: 1, previousStatus: 'not-achieved',
    } }))
    expect(corrected.ownerFeedbackState).toEqual({ version: 2, objectiveStatus: 'achieved' })
    expect(evaluation.isTrustedTaskLearningProjectionReceipt(initialProjection)).toBe(false)
    expect(evaluation.withTrustedCanonicalTaskWriterFence({ scope: hostScope, scopeWatermark: initialProjection.scopeWatermark,
      evidence: [initialProjection.projection] }, () => 'stale').matched).toBe(false)
    const withdraw = delivery.append(claims(capability, 'owner-withdraw', { objectiveStatus: 'unknown', ownerCommand: {
      operationId: 'owner-withdraw', principalRecordId: 'owner-record', principalVersion: 1,
      action: 'withdraw', expectedVersion: 2, previousStatus: 'achieved',
    } }))
    expect(withdraw.ownerFeedbackState).toEqual({ version: 3, objectiveStatus: 'unknown' })
    expect(evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!.projection.disposition).toBe('retract')
    expect(evaluation.listTrustedTaskLearningProjections({ scope: hostScope }).items).toHaveLength(1)
    expect(() => delivery.append(claims(capability, 'owner-stale-correct', { objectiveStatus: 'achieved', ownerCommand: {
      operationId: 'owner-stale-correct', principalRecordId: 'owner-record', principalVersion: 1,
      action: 'correct', expectedVersion: 1, previousStatus: 'not-achieved',
    } }))).toThrow(/changed|version/)
    expect(evaluation.inspectTrustedTaskOwnerRevision({ scope: hostScope, outcomeId: result.id,
      principalRecordId: 'owner-record', principalVersion: 1 })).toMatchObject({ version: 3, action: 'withdraw' })
  })

  test('retracts an older report judgement until the owner explicitly confirms the new exact report proof', () => {
    const { workItems, delivery, evaluation, hostScope } = setup()
    delivery.append(claims(workItems.issue()))
    const old = proof(), changed = proof({ reportRevision: 2, reportDigest: 'f'.repeat(64),
      production: { ...old.production, occurrenceId: 'occurrence-2', runId: 'run-2', completedAt: 2_500 },
      report: { ...old.report, text: 'new report', recordedAt: 2_400 } })
    const newTarget = workItems.issue(changed)
    const initial = claims(newTarget, 'new-report-initial', { runId: 'run-2', occurredAt: 2_600 })
    expect(() => delivery.append(initial)).toThrow(/initial judgement|correction/)
    expect(evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!.projection.disposition).toBe('retract')
    const corrected = delivery.append(claims(newTarget, 'new-report-confirm', { runId: 'run-2', occurredAt: 2_600,
      ownerCommand: { operationId: 'new-report-confirm', principalRecordId: 'owner-record', principalVersion: 1,
        action: 'correct', expectedVersion: 1, previousStatus: 'not-achieved' } }))
    expect(corrected.ownerFeedbackState).toEqual({ version: 2, objectiveStatus: 'not-achieved' })
    const current = evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!
    expect(current.projection.disposition).toBe('upsert')
    expect(current.execution!.evidence).toContainEqual({ kind: 'work-item-production-proof', ref: 'run-2', digest: changed.proofDigest })
    expect(current.objective!.evidence).toContainEqual({ kind: 'work-item-production-proof', ref: 'run-2', digest: changed.proofDigest })
    expect(evaluation.listTrustedTaskLearningProjections({ scope: hostScope }).items).toHaveLength(1)
  })

  test('keeps conflicting production proofs for one report revision non-learning', () => {
    const { workItems, delivery, evaluation, hostScope } = setup()
    delivery.append(claims(workItems.issue()))
    const original = proof(), changed = proof({ production: { ...original.production, runId: 'conflicting-run',
      occurrenceId: 'conflicting-occurrence', completedAt: 2_500 } })
    delivery.append(claims(workItems.issue(changed), 'owner-conflicting-proof', { runId: 'conflicting-run', occurredAt: 2_600,
      ownerCommand: { operationId: 'owner-conflicting-proof', principalRecordId: 'owner-record', principalVersion: 1,
        action: 'correct', expectedVersion: 1, previousStatus: 'not-achieved' } }))
    const canonical = evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!
    expect(canonical.objective!.status).toBe('not-achieved')
    expect(canonical.execution).toBeUndefined()
    expect(canonical.projection.disposition).toBe('retract')
  })

  test('keeps a partial owner result non-learning without changing its meaning', () => {
    const { workItems, delivery, evaluation, hostScope } = setup()
    const result = delivery.append(claims(workItems.issue(), 'owner-partial', { objectiveStatus: 'partial' }))
    expect(result.ownerFeedbackState).toEqual({ version: 1, objectiveStatus: 'partial' })
    const canonical = evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!
    expect(canonical.objective!.status).toBe('partial')
    expect(canonical.projection.disposition).toBe('retract')
  })

  test('preserves one current result and lost acknowledgement identity across a cold Evaluation restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-item-owner-evaluation-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const first = setup(path), firstInput = claims(first.workItems.issue())
    const result = first.delivery.append(firstInput)
    const before = first.evaluation.getTrustedWorkItemLearningProjection({ scope: first.hostScope, itemId: 'item-parent' })
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = setup(path)
    expect(second.delivery.append(claims(second.workItems.issue())).id).toBe(result.id)
    expect(second.evaluation.getTrustedWorkItemLearningProjection({ scope: second.hostScope, itemId: 'item-parent' })).toEqual(before)
    expect(second.evaluation.listTrustedTaskLearningProjections({ scope: second.hostScope }).items).toHaveLength(1)
  })

  test('rejects forged, mismatched, nonterminal and changed source capabilities before recording a vote', () => {
    const { workItems, delivery, evaluation } = setup(), registration = delivery.currentRegistration()!
    expect(() => registration.issueCapability(claims(proof()))).toThrow(/stale|invalid/)
    for (const overrides of [
      { owner: { ...proof().owner, principalRecordId: 'another-owner' } },
      { scope: { ...scope, workspace: '/another/workspace' } },
      { itemId: 'another-item' },
      { production: { ...proof().production, quiescent: false } },
      { production: { ...proof().production, budgetSettlementState: 'pending' } },
      { production: { ...proof().production, executionStatus: 'unknown' } },
      { report: { ...proof().report, status: 'progress' } },
    ]) {
      expect(() => registration.issueCapability(claims(workItems.issue(proof(overrides as never))))).toThrow(/proof|capability/)
    }
    const target = workItems.issue(), input = claims(target), issued = registration.issueCapability(input)
    workItems.capabilities.set(target, proof({ reportRevision: 2, reportDigest: 'e'.repeat(64) }))
    expect(() => registration.inspect!(issued)).toThrow(/changed/)
    expect(() => appendIssued(delivery, input, issued)).toThrow(/changed/)
    expect(evaluation.query({ scope, limit: 10 })).toHaveLength(0)
  })

  test('rejects a generation replacement and a resolver that withdraws the Delivery registration during inspection', () => {
    const { workItems, delivery, evaluation } = setup(), registration = delivery.currentRegistration()!
    const input = claims(workItems.issue()), issued = registration.issueCapability(input)
    workItems.generation = 'replacement-generation'
    expect(() => appendIssued(delivery, input, issued)).toThrow(/unavailable|stale/)
    expect(evaluation.query({ scope, limit: 10 })).toHaveLength(0)
    workItems.generation = 'work-items-generation-1'
    const closed = setup(), closeRegistration = closed.delivery.currentRegistration()!
    const closeInput = claims(closed.workItems.issue()), closeIssued = closeRegistration.issueCapability(closeInput)
    const binding = (closed.evaluation as unknown as { deliveryBinding: { dispose(): void } }).deliveryBinding
    closed.workItems.resolverHook = () => { binding.dispose() }
    expect(() => appendIssued(closed.delivery, closeInput, closeIssued)).toThrow()
    expect(closed.evaluation.query({ scope, limit: 10 })).toHaveLength(0)
  })

  test('rejects a WorkItems generation changed inside its own resolver callback', () => {
    const { workItems, delivery, evaluation } = setup()
    const input = claims(workItems.issue())
    workItems.resolverHook = () => { workItems.generation = 'changed-inside-resolve' }
    expect(() => delivery.currentRegistration()!.issueCapability(input)).toThrow(/proof|current/)
    expect(evaluation.query({ scope, limit: 10 })).toHaveLength(0)
  })

  test('rejects registration withdrawal in the final resolve after the execution baseline was persisted', () => {
    const { workItems, delivery, evaluation, hostScope } = setup(), registration = delivery.currentRegistration()!
    const input = claims(workItems.issue()), issued = registration.issueCapability(input)
    const binding = (evaluation as unknown as { deliveryBinding: { dispose(): void } }).deliveryBinding
    let calls = 0
    workItems.resolverHook = () => { if (++calls === 2) binding.dispose() }
    expect(() => appendIssued(delivery, input, issued)).toThrow(/stale/)
    expect(calls).toBe(2)
    const rows = evaluation.query({ scope, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.objectiveStatus).toBe('unknown')
    expect(evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!.projection.disposition).toBe('retract')
  })

  test('migrates the genuine populated v12 database without changing history, owner commands or feed heads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-item-evaluation-v12-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const sql = readFileSync(new URL('./fixtures/evaluation-v12-populated.sql', import.meta.url), 'utf8')
    const legacy = new DatabaseSync(path)
    legacy.exec(sql); chmodSync(path, 0o600)
    expect(legacy.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 12 })
    expect(String(legacy.prepare("SELECT sql FROM sqlite_master WHERE name='evaluation_task_projections'").get()!.sql)).not.toContain("'work-item'")
    const tables = (legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'evaluation_schema_meta' ORDER BY name").all() as { name: string }[]).map(row => row.name)
    const snapshot = (db: DatabaseSync) => Object.fromEntries(tables.map(name => [name,
      db.prepare('SELECT * FROM ' + name).all().map(row => JSON.stringify(row)).sort()]))
    const before = snapshot(legacy)
    expect(before.evaluation_owner_revisions).toHaveLength(2)
    expect(before.evaluation_owner_commands).toHaveLength(2)
    expect(before.evaluation_task_projection_feed_heads).toHaveLength(2)
    expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    legacy.close()
    const current = setup(path)
    expect(current.evaluation.health().schemaVersion).toBe(18)
    const feed = current.evaluation.listTrustedTaskLearningProjections({ scope: current.hostScope })
    expect(feed.items.map(item => item.receipt.projection.subjectKind).sort()).toEqual(['automation-run','outcome'])
    expect(current.evaluation.getTrustedWorkItemLearningProjection({ scope: current.hostScope, itemId: 'legacy-work-item' })).toBeUndefined()
    await current.ctx.fiber.restart(); contexts.splice(contexts.indexOf(current.ctx), 1)
    const migrated = new DatabaseSync(path, { readOnly: true })
    expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 })
    expect(snapshot(migrated)).toEqual(before)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    migrated.close()
    const restarted = setup(path)
    expect(restarted.evaluation.listTrustedTaskLearningProjections({ scope: restarted.hostScope })).toEqual(feed)
  })

  test('requires the new Delivery fence while legacy subjects retain their existing producer protocol', () => {
    const { workItems, delivery, evaluation } = setup()
    Object.defineProperty(delivery, 'withOwnerWorkItemFeedbackWriterFence', { value: undefined })
    expect(() => delivery.currentRegistration()!.issueCapability(claims(workItems.issue()))).toThrow(/writer fence is unavailable/)
    expect(evaluation.query({ scope, limit: 10 })).toHaveLength(0)
    const legacy = claims({}, 'legacy-owner', { subjectKind: 'foreground-turn', subjectRef: 'legacy-inbox', runId: 'legacy-inbox' })
    delete (legacy as unknown as Record<string, unknown>).workItemOutcomeCapability
    expect(delivery.append(legacy).objectiveStatus).toBe('not-achieved')
  })

  test('checks final Delivery feedback Policy after the last WorkItems resolve', () => {
    const { workItems, delivery, evaluation, hostScope } = setup(), registration = delivery.currentRegistration()!
    const input = claims(workItems.issue()), issued = registration.issueCapability(input)
    let calls = 0
    workItems.resolverHook = () => { if (++calls === 2) delivery.feedbackAllowed = false }
    expect(() => appendIssued(delivery, input, issued)).toThrow(/writer fence rejected/)
    expect(calls).toBe(2)
    const current = evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!
    expect(current.projection.disposition).toBe('retract')
    expect(current.objective).toBeUndefined()
    expect(evaluation.query({ scope, limit: 10 }).some(row => row.source.kind === 'user-feedback')).toBe(false)
  })

  test('performs the final local registration check inside the source fence without notifying before commit', () => {
    const first = setup(), input = claims(first.workItems.issue())
    const issued = first.delivery.currentRegistration()!.issueCapability(input)
    const binding = (first.evaluation as unknown as { deliveryBinding: { dispose(): void } }).deliveryBinding
    first.delivery.fenceHook = () => { binding.dispose() }
    expect(() => appendIssued(first.delivery, input, issued)).toThrow(/stale/)
    expect(first.evaluation.query({ scope, limit: 10 }).some(row => row.source.kind === 'user-feedback')).toBe(false)
    const second = setup(), notifications: { inWriterFence: boolean; committed: boolean }[] = []
    second.evaluation.onTrustedTaskChange(() => notifications.push({ inWriterFence: second.delivery.inWriterFence, committed: second.delivery.fenceCommitted }))
    second.delivery.append(claims(second.workItems.issue()))
    expect(notifications).toEqual([{ inWriterFence: false, committed: true }])
  })

  test('keeps unsupported Evolution work out of retries while preserving canonical readers and old foreground projection', async () => {
    const { ctx, workItems, delivery, evaluation, hostScope } = setup()
    const calls: string[] = []
    ctx.provide('assistantEvolution' as never, {
      projectTrustedEvaluationTaskRevision(input: { evaluationId: string }) {
        const current = evaluation.getTrustedTaskLearningProjection({ scope: hostScope, outcomeId: input.evaluationId })!
        calls.push(current.projection.subjectKind)
        if (current.projection.subjectKind === 'work-item') throw new Error('unsupported work-item subject')
        return { triggerOutcomeId: input.evaluationId, ...current.projection, scopeWatermark: current.scopeWatermark,
          status: 'applied' as const }
      },
    } as never)
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    const result = delivery.append(claims(workItems.issue()))
    await evaluation.whenProjectionIdle()
    expect(await evaluation.reconcileProjection({ scope: hostScope, evaluationId: result.id, operationId: 'not-required-reconcile' }))
      .toEqual({ evaluationId: result.id, status: 'not-required', attemptCount: 0 })
    await evaluation.reconcileProjections()
    expect(calls).toEqual([])
    expect(evaluation.health()).toMatchObject({ pendingProjections: 0, retryingProjections: 0, projectionAttempts: 0 })
    const canonical = evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })!
    expect(canonical.projection.disposition).toBe('upsert')
    expect(evaluation.listTrustedTaskLearningProjections({ scope: hostScope }).items).toHaveLength(1)
    expect(evaluation.withTrustedCanonicalTaskWriterFence({ scope: hostScope, scopeWatermark: canonical.scopeWatermark,
      evidence: [canonical.projection] }, () => 'canonical').matched).toBe(true)
    expect(() => evaluation.withTrustedLearningWriterFence({ scope: hostScope, scopeWatermark: canonical.scopeWatermark,
      evidence: [{ ...canonical.projection, disposition: 'upsert' }] }, () => 'evolution')).toThrow(/work-item.*not supported/)
    const foreground = claims({}, 'foreground-projection', { situation: 'foreground:ordinary', subjectKind: 'foreground-turn',
      subjectRef: 'ordinary-inbox', runId: 'ordinary-inbox' })
    delete (foreground as unknown as Record<string, unknown>).workItemOutcomeCapability
    const oldResult = delivery.append(foreground)
    await vi.waitFor(() => expect(calls).toEqual(['foreground-turn']))
    await evaluation.whenProjectionIdle()
    expect(await evaluation.reconcileProjection({ scope: hostScope, evaluationId: oldResult.id, operationId: 'old-foreground-reconcile' }))
      .toEqual({ evaluationId: oldResult.id, status: 'recorded', attemptCount: 0 })
    expect(evaluation.health()).toMatchObject({ pendingProjections: 0, retryingProjections: 0, projectionAttempts: 0 })
  })

  test('keeps historical work-item settlement evidence outside the new canonical subject', async () => {
    const { workItems, evaluation, hostScope } = setup()
    await workItems.registration!.append({ scope, itemId: 'item-parent', outcomeRevision: 1, settledBy: 'report-ready',
      evidenceState: 'unverified', situation: 'work-item:owner-continuation', objectiveStatus: 'unknown', deliveryStatus: 'unknown',
      occurredAt: 2_000, idempotencyKey: 'work-items/item-parent/1/unverified', digest: 'd'.repeat(64), metrics: {} })
    expect(evaluation.getTrustedWorkItemLearningProjection({ scope: hostScope, itemId: 'item-parent' })).toBeUndefined()
    const prior = evaluation.listTrustedTaskLearningProjections({ scope: hostScope }).items[0]!
    expect(prior.receipt.projection).toMatchObject({ subjectKind: 'outcome', disposition: 'retract' })
    await expect(workItems.registration!.append({ scope, itemId: 'item-parent', outcomeRevision: 2, settledBy: 'report-ready',
      evidenceState: 'observed', situation: 'work-item:owner-continuation', objectiveStatus: 'achieved', deliveryStatus: 'unknown',
      occurredAt: 2_000, idempotencyKey: 'work-items/item-parent/2/observed', digest: 'd'.repeat(64), metrics: {} } as never)).rejects.toThrow(/cannot assert/)
  })
})
