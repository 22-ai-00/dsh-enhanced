import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import {
  AssistantEvaluationError,
  AssistantEvaluationService,
  type Config as AssistantEvaluationConfig,
} from '../src/service.ts'
import { evaluationSchemaVersion, migrateEvaluationDatabase } from '../src/sqlite.ts'
import {
  attentionHoldoutMember,
  defaultAttentionTuningParameters,
  type AttentionTuningParameters,
} from '../src/attention-tuning.ts'
import {
  WORK_ITEM_INTAKE_EVALUATION_FEED_PROTOCOL,
  intakeEvaluationCanonicalId,
} from '../src/intake-evaluation-agreement.ts'
import type {
  TrustedDeliveryEvaluationClaims,
  TrustedDeliveryEvaluationRegistration,
  TrustedWorkItemEvaluationRegistration,
  TrustedWorkItemOwnerFeedbackProof,
} from '../src/types.ts'
import { AssistantWorkItemsService } from '../../assistant-work-items/lib/index.js'
import { classifyIntake } from '../../assistant-work-items/lib/intake.js'
import { WorkItemStore } from '../../assistant-work-items/lib/store.js'
import { TrustedDeliveryTestProducer } from './trusted-producer-fixture.ts'

const scope = { workspace: '/work/intake-eval', preset: 'primary' }
const cohort = { lane: 'intake', sourceId: 'lark-channel' }
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const hour = 3_600_000
const day = 24 * hour
const tuned = (overrides: Partial<AttentionTuningParameters>): AttentionTuningParameters => ({
  ...defaultAttentionTuningParameters,
  ...overrides,
})
const tightest = tuned({ interruptionCostDelta: 100, minimumUtilityDelta: 100, quietExtensionMinutes: 120, muted: true })

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart().catch(() => {})))
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface ScriptedFeedItem {
  readonly eventId: string
  readonly source?: string
  readonly ruleId?: string
  readonly policyVersion?: string
  readonly evaluatedAt: number
  readonly recordedAt: number
  readonly wouldAccept: boolean
  readonly level?: 'ignore' | 'digest' | 'notify' | 'accept'
  readonly mode?: 'observe' | 'auto'
  readonly itemId?: string | null
  readonly itemScope?: { workspace: string; preset: string } | null
  readonly outcome?: {
    revision: number
    settledBy: string
    executionStatus: string
    objectiveStatus: string
    trust: string
    evidenceState: string
    evidenceReason: null
    settledAt: number
    recordedAt: number
    ownerWithdrawn: boolean
  } | null
  readonly acceptanceVerdict?: {
    objectiveStatus: 'achieved' | 'not-achieved' | 'unknown'
    receiptDigest: string
    completedAt: number
    recordedAt: number
  } | null
  readonly ownerCorrection?: {
    kind: 'withdrawn'
    stateReason: string | null
    recordedAt: number
  } | null
  readonly extraFields?: Record<string, unknown>
}

class ScriptedFeedWorkItems {
  readonly items: Array<Record<string, unknown> & { seq: number; id: string; recordedAt: number }> = []
  readonly calls: Array<Record<string, unknown>> = []
  generation = 'wi-gen-1'
  registration: Readonly<TrustedWorkItemEvaluationRegistration> | undefined
  readonly capabilities = new WeakMap<object, TrustedWorkItemOwnerFeedbackProof>()
  disabled = false

  add(item: ScriptedFeedItem): string {
    const source = item.source ?? 'lark-channel'
    const ruleId = item.ruleId ?? 'triage'
    const policyVersion = item.policyVersion ?? 'v1'
    const id = sha256(JSON.stringify([source, item.eventId, ruleId, policyVersion]))
    const existingIndex = this.items.findIndex(existing => existing.id === id)
    const seq = existingIndex >= 0 ? this.items.length + 1 : this.items.length + 1
    const level = item.level ?? (item.wouldAccept ? 'accept' : 'notify')
    const payload = {
      seq,
      id,
      recordedAt: item.recordedAt,
      evaluatedAt: item.evaluatedAt,
      source,
      sourceEventId: item.eventId,
      ruleId,
      policyVersion,
      intakeKind: 'message',
      intakeStrength: 'inferred',
      contentDigest: sha256(`content:${item.eventId}`),
      metadataDigest: sha256(`meta:${item.eventId}`),
      sourceDigest: sha256(`content:${item.eventId}`),
      occurredAt: item.evaluatedAt,
      mode: item.mode ?? 'auto',
      status: 'decided',
      evaluationLevel: level,
      proposedLevel: level,
      ceiling: 'accept',
      wouldAccept: item.wouldAccept,
      evaluationReasons: [],
      admission: item.itemId ? {
        mode: item.mode ?? 'auto',
        outcome: 'admitted',
        reasonCode: null,
        decisionId: `dec-${item.eventId}`,
        itemId: item.itemId,
        recordedAt: item.evaluatedAt,
      } : null,
      itemId: item.itemId ?? null,
      scope: item.itemScope === undefined ? scope : item.itemScope,
      itemState: null,
      itemStateReason: null,
      itemObserved: null,
      outcome: item.outcome ?? null,
      acceptanceVerdict: item.acceptanceVerdict ?? null,
      ownerCorrection: item.ownerCorrection ?? null,
      ...item.extraFields,
    }
    if (existingIndex >= 0) this.items.splice(existingIndex, 1)
    this.items.push(payload)
    // Re-number sequential snapshots monotonically
    this.items.sort((a, b) => (a.recordedAt !== b.recordedAt ? a.recordedAt - b.recordedAt : a.id < b.id ? -1 : 1))
    this.items.forEach((entry, index) => { entry.seq = index + 1 })
    return id
  }

  listIntakeEvaluationFeed(options: {
    afterSeq?: number
    afterRecordedAt?: number
    afterId?: string
    limit?: number
  } = {}) {
    if (this.disabled) {
      const error = new Error('work items disabled') as Error & { code?: string }
      error.code = 'disabled'
      throw error
    }
    this.calls.push({ ...options })
    const limit = Math.min(options.limit ?? 50, 500)
    const filtered = this.items.filter(item => {
      if (options.afterRecordedAt !== undefined) {
        if (item.recordedAt > options.afterRecordedAt) return true
        if (item.recordedAt < options.afterRecordedAt) return false
        return options.afterId !== undefined ? item.id > options.afterId : false
      }
      if (options.afterSeq !== undefined) return item.seq > options.afterSeq
      return true
    })
    const pageItems = filtered.slice(0, limit)
    const last = pageItems.at(-1)
    return {
      protocol: WORK_ITEM_INTAKE_EVALUATION_FEED_PROTOCOL,
      items: pageItems,
      hasMore: filtered.length > limit,
      nextCursor: last === undefined ? null : {
        afterSeq: last.seq,
        afterRecordedAt: last.recordedAt,
        afterId: last.id,
      },
    }
  }

  trustedWorkItemProducerGeneration(): string { return this.generation }
  registerTrustedWorkItemEvaluationSink(registration: Readonly<TrustedWorkItemEvaluationRegistration>) {
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  issueOwnerProof(itemId: string): object {
    const value: Omit<TrustedWorkItemOwnerFeedbackProof, 'proofDigest'> = {
      protocol: 'assistant-work-items/owner-report-feedback/v1',
      itemId,
      reportRevision: 1,
      reportDigest: 'a'.repeat(64),
      sourceId: 'owner-intake',
      itemKind: 'owner-continuation',
      scope,
      owner: { ownerRouteId: 'route-owner', principalId: 'owner-1', principalRecordId: 'owner-rec', principalVersion: 1 },
      originBindingId: 'origin-binding-1',
      production: {
        automationId: 'continuation',
        occurrenceId: `occ-${itemId}`,
        runId: `run-${itemId}`,
        definitionHash: 'b'.repeat(64),
        definitionVersion: 1,
        executionStatus: 'succeeded',
        completedAt: 2_000,
        quiescent: true,
        budgetSettlementState: 'finalized',
      },
      supplier: { provider: 'local', model: 'frozen', reasoningEffort: 'high' },
      planDigest: 'c'.repeat(64),
      task: { brief: 'Work item brief', briefTruncated: false },
      report: { status: 'ready', text: 'Done', truncated: false, recordedAt: 1_900 },
    }
    const proof = { ...value, proofDigest: acceptanceDigest(value) }
    const cap = Object.freeze({})
    this.capabilities.set(cap, proof)
    return cap
  }
  resolveOwnerWorkItemFeedbackTarget(capability: unknown): TrustedWorkItemOwnerFeedbackProof | undefined {
    return capability && typeof capability === 'object' ? this.capabilities.get(capability) : undefined
  }
}

class DeliveryWithNotifications extends TrustedDeliveryTestProducer {
  readonly facts = new Map<string, Record<string, unknown> & { outboxId: string; auditSequence: number }>()
  sequence = 0

  putNotification(input: {
    outboxId: string
    workItemId?: string
    accepted?: boolean
    rejected?: boolean
    at: number
    lane?: string
    sourceId?: string
  }) {
    this.sequence += 1
    this.facts.set(input.outboxId, {
      auditSequence: this.sequence,
      outboxId: input.outboxId,
      bindingId: 'binding-1',
      scope,
      lane: input.lane ?? 'owner-notification',
      sourceId: input.sourceId ?? 'assistant-proactive/v1',
      purpose: 'result',
      purposeSource: 'declared',
      verdict: 'would-accept',
      reasons: [],
      auditedAt: input.at,
      ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
      transport: { status: 'delivered', acceptedAt: input.at + 1, deliveredAt: input.at + 2 },
      ...(input.accepted === true
        ? { judgement: { source: 'owner-objective', version: 1, objectiveStatus: 'achieved' } }
        : input.rejected === true
          ? { judgement: { source: 'owner-objective', version: 1, objectiveStatus: 'not-achieved' } }
          : {}),
    })
  }

  inspectNotificationOutcomeFacts(input: { afterSequence?: number; limit?: number; outboxIds?: readonly string[] }) {
    if (input.outboxIds !== undefined) {
      return {
        protocol: 'assistant-delivery/notification-outcome-facts/v1',
        hasMore: false,
        nextAfterSequence: null,
        facts: input.outboxIds.map(id => this.facts.get(id)).filter(item => item !== undefined),
      }
    }
    const all = [...this.facts.values()]
      .filter(item => item.auditSequence > (input.afterSequence ?? 0))
      .sort((a, b) => a.auditSequence - b.auditSequence)
    const page = all.slice(0, input.limit ?? 100)
    return {
      protocol: 'assistant-delivery/notification-outcome-facts/v1',
      facts: page,
      hasMore: all.length > page.length,
      nextAfterSequence: page.at(-1)?.auditSequence ?? null,
    }
  }

  withOwnerWorkItemFeedbackWriterFence<T>(
    registration: Readonly<TrustedDeliveryEvaluationRegistration>,
    _claims: Readonly<TrustedDeliveryEvaluationClaims>,
    _proofDigest: string,
    callback: () => T,
  ): T {
    if (registration !== this.currentRegistration()) throw new Error('stale registration')
    return callback()
  }
}

function setupService(options: {
  path?: string
  config?: Partial<AssistantEvaluationConfig>
  workItems?: ScriptedFeedWorkItems
  delivery?: DeliveryWithNotifications
  clock?: { now: number }
} = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const workItems = options.workItems ?? new ScriptedFeedWorkItems()
  const delivery = options.delivery ?? new DeliveryWithNotifications()
  const clock = options.clock ?? { now: 50_000 }
  ctx.provide('assistantWorkItems' as never, workItems as never)
  ctx.provide('assistantDelivery' as never, delivery as never)
  const evaluation = new AssistantEvaluationService(ctx, {
    databasePath: options.path ?? ':memory:',
    projectionIntervalMs: 0,
    ...options.config,
  }, { now: () => clock.now })
  return { ctx, workItems, delivery, clock, evaluation }
}

describe('WP20 would-accept feed -> WP22 evaluation agreement & loosening', () => {
  test('disabled parity: zero feed reads, zero SQLite writes, undefined summaries and intake cohort isolated', () => {
    const f = setupService({
      config: { notificationOutcomesEnabled: true, attentionTuningAutoAdopt: true, intakeEvaluationAgreementEnabled: false },
    })
    f.workItems.add({
      eventId: 'ev-off-1', evaluatedAt: 1_000, recordedAt: 1_000, wouldAccept: true, itemId: 'wi-off',
      ownerCorrection: { kind: 'withdrawn', stateReason: 'signal-withdrawn', recordedAt: 1_100 },
    })

    expect(f.evaluation.reconcileIntakeEvaluationAgreement()).toEqual({
      enabled: false,
      available: false,
      ingested: 0,
      correlated: 0,
      revised: 0,
      invalid: 0,
      cursor: { afterSeq: 0, afterRecordedAt: 0, afterId: '' },
    })
    expect(f.workItems.calls).toEqual([])
    expect(f.evaluation.intakeEvaluationFeedCursor()).toEqual({ afterSeq: 0, afterRecordedAt: 0, afterId: '' })
    expect(f.evaluation.intakeEvaluationAgreementSummary({ scope })).toBeUndefined()
    expect(f.evaluation.listIntakeEvaluationAgreements({ scope })).toEqual({
      enabled: false,
      items: [],
      hasMore: false,
      nextCursor: null,
    })
    expect(f.evaluation.inspectIntakeEvaluationAgreement({
      source: 'lark-channel', sourceEventId: 'ev-off-1', ruleId: 'triage', policyVersion: 'v1',
    })).toBeUndefined()
    expect(f.evaluation.health().intakeEvaluations).toBe(0)
    expect(() => f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 10 }) }))
      .toThrow(AssistantEvaluationError)
  })

  test('connects to real AssistantWorkItemsService end-to-end, resumes durable cursor after restart, and counts invalid/leaky rows safely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-wi-e2e-')); directories.push(dir)
    const wiDb = join(dir, 'work-items.sqlite')
    const wiWorkRoot = join(dir, 'work')
    const evalDb = join(dir, 'eval.sqlite')
    const clock = { now: 10_000 }

    const rawStore = new WorkItemStore(wiDb, { now: () => clock.now })
    try {
      for (const [idx, ts] of [1_000, 2_000, 3_000].entries()) {
        clock.now = ts
        const eventId = `real-ev-${idx + 1}`
        const digest = sha256(`text:${eventId}`)
        rawStore.recordIntake(classifyIntake({
          source: 'lark-channel', sourceEventId: eventId, kind: 'message',
          senderAllowlisted: true, addressed: false, threadFollowUp: false, senderIsBot: false,
          contentDigest: digest, occurredAt: ts,
        }))
        rawStore.recordIntakeEvaluation({
          source: 'lark-channel', sourceEventId: eventId, ruleId: 'triage', policyVersion: 'v1',
          sourceDigest: digest, mode: 'observe', status: 'decided',
          level: idx === 2 ? 'notify' : 'accept',
          proposedLevel: idx === 2 ? 'notify' : 'accept',
          ceiling: 'accept', quoteSpans: [], reasons: [], wouldAccept: idx !== 2,
          attempts: 1, decidedAt: ts,
        })
      }
    } finally {
      rawStore.close()
    }

    const ctx1 = new Context(); contexts.push(ctx1)
    ctx1.provide('assistantDelivery' as never, {
      validateOwnerRoute: () => ({ receiptVersion: 2, authorityId: 'r1', authorityHash: 'h', principalId: 'p', principalRecordId: 'pr', principalVersion: 1, workspace: scope.workspace, agentPreset: scope.preset, bindingVersion: 1, generation: 1 }),
      registerInboundIntakeObserver: () => () => {},
      enqueueBackground: () => Promise.resolve({ id: 'o1' }),
    } as never)
    await ctx1.plugin(AssistantWorkItemsService, {
      enabled: true,
      mode: 'observe',
      databasePath: wiDb,
      workRoot: wiWorkRoot,
      intakeLedger: { enabled: true, evaluation: { enabled: true } },
    }).await()
    const eval1 = new AssistantEvaluationService(ctx1, {
      databasePath: evalDb,
      projectionIntervalMs: 0,
      intakeEvaluationAgreementEnabled: true,
      intakeEvaluationFeedBatchSize: 2,
    }, { now: () => clock.now })

    const page1 = eval1.reconcileIntakeEvaluationAgreement()
    expect(page1).toMatchObject({ enabled: true, available: true, ingested: 2, revised: 2, invalid: 0 })
    expect(page1.cursor.afterSeq).toBe(2)

    await ctx1.fiber.restart()
    contexts.splice(contexts.indexOf(ctx1), 1)

    // Cold restart with same SQLite DB: cursor persists and pulls remaining item 3
    const ctx2 = new Context(); contexts.push(ctx2)
    ctx2.provide('assistantDelivery' as never, {
      validateOwnerRoute: () => ({ receiptVersion: 2, authorityId: 'r1', authorityHash: 'h', principalId: 'p', principalRecordId: 'pr', principalVersion: 1, workspace: scope.workspace, agentPreset: scope.preset, bindingVersion: 1, generation: 1 }),
      registerInboundIntakeObserver: () => () => {},
      enqueueBackground: () => Promise.resolve({ id: 'o1' }),
    } as never)
    await ctx2.plugin(AssistantWorkItemsService, {
      enabled: true,
      mode: 'observe',
      databasePath: wiDb,
      workRoot: wiWorkRoot,
      intakeLedger: { enabled: true, evaluation: { enabled: true } },
    }).await()
    const eval2 = new AssistantEvaluationService(ctx2, {
      databasePath: evalDb,
      projectionIntervalMs: 0,
      intakeEvaluationAgreementEnabled: true,
      intakeEvaluationFeedBatchSize: 2,
    }, { now: () => clock.now })

    expect(eval2.intakeEvaluationFeedCursor().afterSeq).toBe(2)
    const page2 = eval2.reconcileIntakeEvaluationAgreement()
    expect(page2).toMatchObject({ enabled: true, available: true, ingested: 1, revised: 1, invalid: 0 })
    expect(page2.cursor.afterSeq).toBe(3)
    expect(eval2.health().intakeEvaluations).toBe(3)

    // Subsequent tick with no new rows is a clean no-op
    expect(eval2.reconcileIntakeEvaluationAgreement()).toMatchObject({ ingested: 0, revised: 0 })

    // Scripted peer returning a forbidden body-leak field counts invalid without stalling cursor
    const scripted = new ScriptedFeedWorkItems()
    scripted.add({ eventId: 'leaky-1', evaluatedAt: 4_000, recordedAt: 4_000, wouldAccept: true, extraFields: { text: 'leaked body!' } })
    scripted.add({ eventId: 'clean-2', evaluatedAt: 5_000, recordedAt: 5_000, wouldAccept: true })
    const mem = setupService({
      workItems: scripted,
      config: { intakeEvaluationAgreementEnabled: true },
    })
    expect(mem.evaluation.reconcileIntakeEvaluationAgreement()).toMatchObject({ ingested: 1, revised: 1, invalid: 1 })
    expect(mem.evaluation.intakeEvaluationFeedCursor().afterSeq).toBe(2)
  })

  test('correlates would-accept against notification outcomes, owner withdrawals, verdicts, and subsequent owner feedback revisions', () => {
    const f = setupService({
      config: {
        notificationOutcomesEnabled: true,
        notificationResponseWindowMs: hour,
        intakeEvaluationAgreementEnabled: true,
      },
    })

    // 1. wouldAccept=true + notification accepted -> true-positive
    f.workItems.add({ eventId: 'tp-notif', evaluatedAt: 1_000, recordedAt: 1_000, wouldAccept: true, itemId: 'wi-tp' })
    f.delivery.putNotification({ outboxId: 'out-tp', workItemId: 'wi-tp', accepted: true, at: 1_100 })

    // 2. wouldAccept=true + notification rejected -> false-positive
    f.workItems.add({ eventId: 'fp-notif', evaluatedAt: 1_200, recordedAt: 1_200, wouldAccept: true, itemId: 'wi-fp' })
    f.delivery.putNotification({ outboxId: 'out-fp', workItemId: 'wi-fp', rejected: true, at: 1_300 })

    // 3. wouldAccept=true + initially verdict achieved -> true-positive, then later withdrawn -> revised to false-positive!
    f.workItems.add({
      eventId: 'rev-withdraw', evaluatedAt: 1_400, recordedAt: 1_400, wouldAccept: true, itemId: 'wi-withdraw',
      acceptanceVerdict: { objectiveStatus: 'achieved', receiptDigest: 'a'.repeat(64), completedAt: 1_450, recordedAt: 1_450 },
    })

    // 4. wouldAccept=false + owner achieved -> false-negative; wouldAccept=false + owner rejected -> true-negative
    f.workItems.add({
      eventId: 'fn-verdict', evaluatedAt: 1_500, recordedAt: 1_500, wouldAccept: false, itemId: 'wi-fn',
      acceptanceVerdict: { objectiveStatus: 'achieved', receiptDigest: 'b'.repeat(64), completedAt: 1_550, recordedAt: 1_550 },
    })
    f.workItems.add({
      eventId: 'tn-verdict', evaluatedAt: 1_600, recordedAt: 1_600, wouldAccept: false, itemId: 'wi-tn',
      acceptanceVerdict: { objectiveStatus: 'not-achieved', receiptDigest: 'c'.repeat(64), completedAt: 1_650, recordedAt: 1_650 },
    })

    // 5. wouldAccept=true, no outcome yet -> pending, later superseded by trusted Delivery owner feedback not-achieved!
    f.workItems.add({ eventId: 'owner-fb', evaluatedAt: 1_700, recordedAt: 1_700, wouldAccept: true, itemId: 'wi-fb' })
    // 6. wouldAccept=true, initially pending -> later local notification rejected (no new feed rows needed!)
    f.workItems.add({ eventId: 'late-notif', evaluatedAt: 1_800, recordedAt: 1_800, wouldAccept: true, itemId: 'wi-late-notif' })

    f.evaluation.reconcileNotificationOutcomes()
    const sync1 = f.evaluation.reconcileIntakeEvaluationAgreement()
    expect(sync1.ingested).toBe(7)

    expect(f.evaluation.inspectIntakeEvaluationAgreement({
      source: 'lark-channel', sourceEventId: 'rev-withdraw', ruleId: 'triage', policyVersion: 'v1',
    })?.head).toMatchObject({ agreementStatus: 'true-positive', outcomeSource: 'work-item-verdict', version: 1 })
    expect(f.evaluation.inspectIntakeEvaluationAgreement({
      source: 'lark-channel', sourceEventId: 'owner-fb', ruleId: 'triage', policyVersion: 'v1',
    })?.head).toMatchObject({ agreementStatus: 'pending', outcomeSource: 'none', version: 1 })
    expect(f.evaluation.inspectIntakeEvaluationAgreement({
      source: 'lark-channel', sourceEventId: 'late-notif', ruleId: 'triage', policyVersion: 'v1',
    })?.head).toMatchObject({ agreementStatus: 'pending', outcomeSource: 'none', version: 1 })

    // Late withdrawal arrives on feed + trusted owner feedback arrives via Delivery on wi-fb
    // + late notification outcome arrives locally for wi-late-notif (zero new feed items!)
    f.clock.now = 61_000
    f.delivery.putNotification({ outboxId: 'out-late', workItemId: 'wi-late-notif', rejected: true, at: 60_200 })
    f.evaluation.reconcileNotificationOutcomes()
    f.workItems.add({
      eventId: 'rev-withdraw', evaluatedAt: 1_400, recordedAt: 60_000, wouldAccept: true, itemId: 'wi-withdraw',
      ownerCorrection: { kind: 'withdrawn', stateReason: 'signal-withdrawn', recordedAt: 60_000 },
    })
    const cap = f.workItems.issueOwnerProof('wi-fb')
    f.delivery.append({
      scope,
      situation: 'work-item:owner-continuation',
      subjectKind: 'work-item',
      subjectRef: 'wi-fb',
      runId: 'run-wi-fb',
      outboxId: 'outbox-fb',
      chatId: 'owner-chat',
      principalId: 'owner-1',
      bindingId: 'origin-binding-1',
      objectiveStatus: 'not-achieved',
      metrics: {},
      occurredAt: 60_500,
      idempotencyKey: 'fb-wi-fb',
      workItemOutcomeCapability: cap,
      ownerCommand: {
        principalRecordId: 'owner-rec',
        principalVersion: 1,
        operationId: 'op-fb-1',
        action: 'initial',
      },
    } as TrustedDeliveryEvaluationClaims)

    f.evaluation.reconcileIntakeEvaluationAgreement()
    const withdrawHist = f.evaluation.inspectIntakeEvaluationAgreement({
      source: 'lark-channel', sourceEventId: 'rev-withdraw', ruleId: 'triage', policyVersion: 'v1',
    })!
    expect(withdrawHist.head).toMatchObject({ agreementStatus: 'false-positive', outcomeSource: 'owner-withdrawal', version: 2 })
    expect(withdrawHist.revisions.map(r => [r.version, r.agreementStatus])).toEqual([
      [1, 'true-positive'],
      [2, 'false-positive'],
    ])

    const fbHist = f.evaluation.inspectIntakeEvaluationAgreement({
      source: 'lark-channel', sourceEventId: 'owner-fb', ruleId: 'triage', policyVersion: 'v1',
    })!
    expect(fbHist.head).toMatchObject({ agreementStatus: 'false-positive', outcomeSource: 'owner-feedback', version: 2 })
    expect(f.evaluation.inspectIntakeEvaluationAgreement({
      source: 'lark-channel', sourceEventId: 'late-notif', ruleId: 'triage', policyVersion: 'v1',
    })?.head).toMatchObject({ agreementStatus: 'false-positive', outcomeSource: 'notification-outcome', version: 2 })

    const summary = f.evaluation.intakeEvaluationAgreementSummary({ scope, fromEvaluatedAt: 0, toEvaluatedAt: 100_000 })!
    expect(summary).toMatchObject({
      total: 7,
      truePositive: 1,
      falsePositive: 4,
      falseNegative: 1,
      trueNegative: 1,
      pending: 0,
      agreed: 2,
      disagreed: 5,
      decided: 7,
    })

    // Cursor pagination over canonical stored agreement records
    const listPage1 = f.evaluation.listIntakeEvaluationAgreements({ scope, limit: 3 })
    const listPage2 = f.evaluation.listIntakeEvaluationAgreements({
      scope,
      limit: 10,
      afterEvaluatedAt: listPage1.nextCursor!.afterEvaluatedAt,
      afterEvalId: listPage1.nextCursor!.afterEvalId,
    })
    expect(listPage1.items.length + listPage2.items.length).toBe(7)
    expect(new Set([...listPage1.items, ...listPage2.items].map(i => i.evalId)).size).toBe(7)
  })

  test('feeds sealed holdout replay & bounded loosening while preserving single-step, holdout-split and owner pre-authorization gates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-intake-loosen-')); directories.push(dir)
    const dbPath = join(dir, 'eval.sqlite')
    const f = setupService({
      path: dbPath,
      config: {
        notificationOutcomesEnabled: true,
        notificationResponseWindowMs: hour,
        attentionTuningAutoAdopt: true,
        attentionLooseningEnabled: true,
        attentionTuningMinSample: 10,
        attentionTuningObservationMs: day,
        intakeEvaluationAgreementEnabled: true,
        intakeEvaluationFeedBatchSize: 500,
      },
    })

    // Seed 120 baseline accepted items so parent tightens ICD 0 -> 10, then 20
    let seqTime = 1_000
    for (let i = 0; i < 60; i += 1) {
      seqTime += 10
      f.workItems.add({
        eventId: `base-fp-${i}`, evaluatedAt: seqTime, recordedAt: seqTime, wouldAccept: true, itemId: `wi-base-${i}`,
        acceptanceVerdict: { objectiveStatus: i < 48 ? 'not-achieved' : 'achieved', receiptDigest: '1'.repeat(64), completedAt: seqTime + 1, recordedAt: seqTime + 1 },
      })
    }
    f.clock.now = seqTime + 100
    f.evaluation.reconcileIntakeEvaluationAgreement()

    // Automatic cohort discovery picks up { lane: 'intake', sourceId: 'lark-channel' } and tightens 0 -> 10
    const autoTight = f.evaluation.reconcileAttentionTuning()
    expect(autoTight.some(r => r.cohort.lane === 'intake' && r.result.action === 'adopted' && r.result.version === 1)).toBe(true)
    f.clock.now += day
    expect(f.evaluation.reconcileAttentionTuning()).toContainEqual({
      scopeKey: expect.any(String),
      cohort,
      result: { action: 'settled', version: 1 },
    })

    // Owner requests second tightening step ICD 10 -> 20
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 20 }) }))
      .toMatchObject({ status: 'adopted', version: 2 })
    f.clock.now += day
    expect(f.evaluation.reconcileAttentionTuning()).toContainEqual({
      scopeKey: expect.any(String),
      cohort,
      result: { action: 'settled', version: 2 },
    })

    // Seed 100 counterfactual suppressed items (wouldAccept=false):
    // In training (!holdout): ALWAYS positive (missed opportunity!) -> training looks spotless!
    // In holdout (attentionHoldoutMember(evalId)): test BOTH holdout failure vs holdout success cleanly!
    const badStart = f.clock.now + 100
    const holdoutOnlyDir = mkdtempSync(join(tmpdir(), 'dsh-eval-holdout-fail-')); directories.push(holdoutOnlyDir)
    const badSetup = setupService({
      config: {
        notificationOutcomesEnabled: true,
        notificationResponseWindowMs: hour,
        attentionTuningAutoAdopt: true,
        attentionLooseningEnabled: true,
        attentionTuningMinSample: 10,
        attentionTuningObservationMs: day,
        intakeEvaluationAgreementEnabled: true,
        intakeEvaluationFeedBatchSize: 500,
      },
    })
    for (let i = 0; i < 80; i += 1) {
      const evId = `hf-${i}`
      const evalId = intakeEvaluationCanonicalId('lark-channel', evId, 'triage', 'v1')
      const inHoldout = attentionHoldoutMember(evalId)
      const t = badStart + i * 10
      badSetup.workItems.add({
        eventId: evId, evaluatedAt: t, recordedAt: t, wouldAccept: false, itemId: `wi-hf-${i}`,
        // Holdout mostly true-negative (not-achieved = would cause extra interruptions), training all positive!
        acceptanceVerdict: { objectiveStatus: inHoldout ? 'not-achieved' : 'achieved', receiptDigest: '2'.repeat(64), completedAt: t + 1, recordedAt: t + 1 },
      })
    }
    badSetup.clock.now = badStart + 2_000
    badSetup.evaluation.reconcileIntakeEvaluationAgreement()
    // Even with a full owner grant, holdout failure MUST reject!
    badSetup.evaluation.grantAttentionLoosening({
      scope, cohort,
      grant: { grantId: 'bad-grant', lowerBound: defaultAttentionTuningParameters, upperBound: tightest, maxStepsPerAdoption: 1, maxAdoptions: 2, expiresAt: badSetup.clock.now + 7 * day },
    })
    // First tighten to ICD 10 cleanly
    expect(badSetup.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 10 }) })).toMatchObject({ status: 'adopted', version: 1 })
    badSetup.clock.now += day
    badSetup.evaluation.reconcileAttentionTuning()
    // Now propose loosening ICD 10 -> 0: training has 0 negatives, holdout has all negatives -> REJECTED!
    expect(badSetup.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({}) })).toMatchObject({ status: 'proposed' })
    const badDecision = badSetup.evaluation.reconcileAttentionTuning().find(r => r.cohort.sourceId === 'lark-channel')!
    expect(badDecision.result).toMatchObject({ action: 'loosening-rejected', reason: 'holdout-failed' })
    expect(badSetup.evaluation.attentionLooseningStatus({ scope, cohort }).proposals[0]!.decision).toMatchObject({
      decision: 'rejected',
      reason: 'holdout-failed',
      replay: { verdict: 'fail', reason: 'extra-interruptions' },
    })

    // Now on primary fixture `f`: seed positive counterfactual items (mostly false-negative in BOTH splits)
    let goodTime = f.clock.now + 100
    for (let i = 0; i < 80; i += 1) {
      goodTime += 10
      f.workItems.add({
        eventId: `good-fn-${i}`, evaluatedAt: goodTime, recordedAt: goodTime, wouldAccept: false, itemId: `wi-good-${i}`,
        acceptanceVerdict: { objectiveStatus: 'achieved', receiptDigest: '3'.repeat(64), completedAt: goodTime + 1, recordedAt: goodTime + 1 },
      })
    }
    f.clock.now = goodTime + 100
    f.evaluation.reconcileIntakeEvaluationAgreement()

    // 1) Without owner pre-authorization grant, loosening 20 -> 10 passes holdout replay cleanly,
    //    records an owner-question, and NEVER bypasses pre-authorization!
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 10 }) }))
      .toMatchObject({ status: 'proposed' })
    const ungranted = f.evaluation.reconcileAttentionTuning().find(r => r.cohort.sourceId === 'lark-channel')!
    expect(ungranted.result).toMatchObject({ action: 'owner-question', exceeded: ['no-grant'] })
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })?.version).toBe(2)

    // 2) Grant with maxStepsPerAdoption = 1: requesting 2-step loosening 20 -> 0 fails step bound (step-too-large)
    //    and records an owner-question instead of auto-adopting!
    f.evaluation.grantAttentionLoosening({
      scope, cohort,
      grant: {
        grantId: 'intake-grant-1',
        lowerBound: defaultAttentionTuningParameters,
        upperBound: tightest,
        maxStepsPerAdoption: 1,
        maxAdoptions: 1,
        expiresAt: f.clock.now + 7 * day,
      },
    })
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({}) }))
      .toMatchObject({ status: 'proposed' })
    const twoStep = f.evaluation.reconcileAttentionTuning().find(r => r.cohort.sourceId === 'lark-channel')!
    expect(twoStep.result).toMatchObject({ action: 'owner-question', exceeded: ['step-too-large'] })
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })?.version).toBe(2)

    // Pending owner question blocks new proposals until a fresh grant closes the open question
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 10 }) }))
      .toEqual({ status: 'rejected', reason: 'owner-question-pending' })

    // 3) Issue a valid 1-step owner grant (closing the open question) and adopt 20 -> 10 via sealed holdout replay!
    f.evaluation.grantAttentionLoosening({
      scope, cohort,
      grant: {
        grantId: 'intake-grant-2',
        lowerBound: defaultAttentionTuningParameters,
        upperBound: tightest,
        maxStepsPerAdoption: 1,
        maxAdoptions: 1,
        expiresAt: f.clock.now + 7 * day,
      },
    })
    const sealed = f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 10 }) })
    expect(sealed).toMatchObject({ status: 'proposed' })
    const adopted = f.evaluation.reconcileAttentionTuning().find(r => r.cohort.sourceId === 'lark-channel')!
    expect(adopted.result).toMatchObject({
      action: 'loosening-adopted',
      version: 3,
      change: { parameter: 'interruptionCostDelta', from: 20, to: 10 },
      grantId: 'intake-grant-2',
    })
    expect(f.evaluation.attentionLooseningStatus({ scope, cohort }).grant).toMatchObject({ used: 1, remaining: 0 })

    // 4) Post-adoption regression: surge of false-positives in observation window rolls back cleanly to exact parent (version 2)!
    const regStart = f.clock.now + 50
    for (let i = 0; i < 16; i += 1) {
      const t = regStart + i * 10
      f.workItems.add({
        eventId: `post-fp-${i}`, evaluatedAt: t, recordedAt: t, wouldAccept: true, itemId: `wi-reg-${i}`,
        ownerCorrection: { kind: 'withdrawn', stateReason: 'signal-withdrawn', recordedAt: t + 1 },
      })
    }
    f.clock.now = regStart + 500
    f.evaluation.reconcileIntakeEvaluationAgreement()
    const rollback = f.evaluation.reconcileAttentionTuning().find(r => r.cohort.sourceId === 'lark-channel')!
    expect(rollback.result).toEqual({ action: 'rolled-back', fromVersion: 3, toVersion: 2 })
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })?.version).toBe(2)
  })

  test('migrates schema 18 -> 19 cleanly, fails closed on drift or newer schema, and enforces SQLite immutability triggers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-s19-')); directories.push(dir)
    const path18 = join(dir, 'v18.sqlite')
    const freshPath = join(dir, 'fresh.sqlite')

    const legacy = new DatabaseSync(path18)
    migrateEvaluationDatabase(legacy, 18)
    expect(legacy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 18 })
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evaluation_intake_evaluation_heads'").get()).toBeUndefined()
    legacy.close()
    chmodSync(path18, 0o600)

    const migrated = setupService({
      path: path18,
      config: { intakeEvaluationAgreementEnabled: true },
    })
    expect(migrated.evaluation.health().schemaVersion).toBe(evaluationSchemaVersion)
    migrated.workItems.add({ eventId: 'mig-1', evaluatedAt: 1_000, recordedAt: 1_000, wouldAccept: true, itemId: 'wi-m1' })
    expect(migrated.evaluation.reconcileIntakeEvaluationAgreement().ingested).toBe(1)
    await migrated.ctx.fiber.restart(); contexts.splice(contexts.indexOf(migrated.ctx), 1)

    const fresh = setupService({ path: freshPath })
    await fresh.ctx.fiber.restart(); contexts.splice(contexts.indexOf(fresh.ctx), 1)

    const objects = (dbPath: string) => {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        return (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{
          type: string; name: string; tbl_name: string; sql: string | null
        }>).map(r => JSON.stringify([r.type, r.name, r.tbl_name, r.sql?.replace(/\s+/g, ' ').trim() ?? null]))
      } finally {
        db.close()
      }
    }
    expect(objects(path18)).toEqual(objects(freshPath))

    // Enforce SQLite monotonic & immutability triggers
    const writable = new DatabaseSync(path18)
    try {
      expect(() => writable.exec('UPDATE evaluation_intake_evaluation_sync_cursor SET after_recorded_at = 0')).toThrow(/must advance/)
      expect(() => writable.exec('DELETE FROM evaluation_intake_evaluation_sync_cursor')).toThrow(/durable/)
      expect(() => writable.exec('UPDATE evaluation_intake_evaluation_heads SET would_accept = 0')).toThrow(/must advance/)
      expect(() => writable.exec('DELETE FROM evaluation_intake_evaluation_heads')).toThrow(/durable/)
      expect(() => writable.exec("UPDATE evaluation_intake_evaluation_revisions SET agreement_status = 'pending'")).toThrow(/immutable/)
      expect(() => writable.exec('DELETE FROM evaluation_intake_evaluation_revisions')).toThrow(/durable/)
    } finally {
      writable.close()
    }

    // Newer schema fails closed
    const newerPath = join(dir, 'newer.sqlite')
    const newer = new DatabaseSync(newerPath)
    migrateEvaluationDatabase(newer, 19)
    newer.exec(`PRAGMA user_version = ${evaluationSchemaVersion + 1}`)
    newer.close()
    chmodSync(newerPath, 0o600)
    expect(() => setupService({ path: newerPath })).toThrow(/newer than supported/u)

    // Drifted schema 19 fails closed
    const driftPath = join(dir, 'drift.sqlite')
    const drift = new DatabaseSync(driftPath)
    migrateEvaluationDatabase(drift, 19)
    drift.exec('DROP TRIGGER evaluation_intake_evaluation_revisions_immutable')
    drift.close()
    chmodSync(driftPath, 0o600)
    expect(() => setupService({ path: driftPath })).toThrow(/schema does not match schema 19/u)

    // Pre-created drifted object at schema 18 stays at 18 and fails closed
    const preDriftPath = join(dir, 'pre-drift.sqlite')
    const preDrift = new DatabaseSync(preDriftPath)
    migrateEvaluationDatabase(preDrift, 18)
    preDrift.exec('CREATE TABLE evaluation_intake_evaluation_heads (eval_id TEXT PRIMARY KEY) STRICT')
    preDrift.close()
    chmodSync(preDriftPath, 0o600)
    expect(() => setupService({ path: preDriftPath })).toThrow(/schema does not match schema 19/u)
    const verifyPreDrift = new DatabaseSync(preDriftPath, { readOnly: true })
    expect(verifyPreDrift.prepare('PRAGMA user_version').get()).toEqual({ user_version: 18 })
    verifyPreDrift.close()
  })

  test('rides the existing projection tick safely when intakeEvaluationAgreementEnabled is enabled', async () => {
    const f = setupService({
      config: {
        projectionIntervalMs: 10,
        notificationSyncIntervalMs: 0,
        intakeEvaluationAgreementEnabled: true,
      },
    })
    f.workItems.add({
      eventId: 'tick-1', evaluatedAt: 1_000, recordedAt: 1_000, wouldAccept: true, itemId: 'wi-tick',
      acceptanceVerdict: { objectiveStatus: 'achieved', receiptDigest: '9'.repeat(64), completedAt: 1_100, recordedAt: 1_100 },
    })
    await vi.waitFor(() => {
      expect(f.evaluation.health().intakeEvaluations).toBe(1)
    }, { timeout: 5_000, interval: 10 })
    expect(f.evaluation.intakeEvaluationAgreementSummary({ scope, fromEvaluatedAt: 0, toEvaluatedAt: 100_000 })).toMatchObject({
      truePositive: 1,
      agreed: 1,
    })
  })
})
