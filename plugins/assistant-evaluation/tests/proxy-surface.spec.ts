import { Context, symbols } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantEvaluationService,
  Config,
  attentionHoldoutMember,
  canonicalEvaluationHostScope,
  defaultAttentionTuningParameters,
  normalizeAttentionTuningParameters,
  type AttentionLooseningConsumerEvent,
} from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
})

const scope = { workspace: '/work/proxy-eval', preset: 'primary' }
const cohort = { lane: 'owner-notification', sourceId: 'assistant-proactive/v1' }
const owner = { ownerRouteId: 'route-1', principalId: 'web/a/t/u' }
const hour = 3_600_000
const day = 24 * hour

describe('AssistantEvaluationService live Cordis Proxy surface (T3-EW-02, F03, F07c)', () => {
  test('R3 schema defaults enable all 6 WP22 switches and minimal ctx.plugin mounts without owner route', async () => {
    const parsed = Config({ databasePath: ':memory:' })
    expect(parsed.notificationOutcomesEnabled).toBe(true)
    expect(parsed.attentionTuningAutoAdopt).toBe(true)
    expect(parsed.intakeAttentionAgreementEnabled).toBe(true)
    expect(parsed.attentionLooseningEnabled).toBe(true)
    expect(parsed.attentionOwnerQuestionDeliveryEnabled).toBe(true)
    expect(parsed.intakeEvaluationAgreementEnabled).toBe(true)

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AssistantEvaluationService, { databasePath: ':memory:', projectionIntervalMs: 0 })
    const proxy = ctx.get('assistantEvaluation')!
    expect(proxy.health().ready).toBe(true)
    expect(proxy.attentionOwnerQuestionStatus({ scope, cohort })).toEqual({
      enabled: false,
      deliveries: [],
      replies: [],
    })
  })

  test('all 12 previously broken WP22 methods, delivery callbacks, and F03 consumer hooks work via Cordis Proxy', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const ctx = new Context()
    contexts.push(ctx)
    const withdrawals = new Map<string, { handle: string; isWithdrawn: (key: string) => boolean }>()
    const replyConsumers = new Map<string, { consume: (input: { idempotencyKey: string; text: string }) => string }>()
    const facts: Array<Record<string, unknown>> = []
    let seq = 0
    for (let i = 0; i < 200; i++) {
      seq += 1
      const id = `n-${i}`
      const neg = !attentionHoldoutMember(id)
      facts.push({
        auditSequence: seq,
        outboxId: id,
        bindingId: 'binding-1',
        scope,
        ...cohort,
        purpose: 'attention',
        purposeSource: 'lane',
        verdict: 'would-accept',
        reasons: [],
        auditedAt: 1_000,
        transport: { status: 'delivered', acceptedAt: 1_001, deliveredAt: 1_002 },
        judgement: { source: 'owner-objective', version: 1, objectiveStatus: neg ? 'not-achieved' : 'achieved' },
      })
    }

    ctx.provide('assistantDelivery' as never, {
      inspectNotificationOutcomeFacts: (input: { afterSequence?: number; limit?: number; outboxIds?: readonly string[] }) => {
        if (input.outboxIds !== undefined) {
          return {
            protocol: 'assistant-delivery/notification-outcome-facts/v1',
            hasMore: false,
            nextAfterSequence: null,
            facts: facts.filter(f => input.outboxIds!.includes(f.outboxId as string)),
          }
        }
        const page = facts.filter(f => (f.auditSequence as number) > (input.afterSequence ?? 0)).slice(0, input.limit ?? 100)
        return {
          protocol: 'assistant-delivery/notification-outcome-facts/v1',
          facts: page,
          hasMore: page.length > 0 && (page.at(-1)!.auditSequence as number) < facts.length,
          nextAfterSequence: page.at(-1)?.auditSequence ?? null,
        }
      },
      registerOwnerNotificationWithdrawal: (reg: { sourceId: string; isWithdrawn: (k: string) => boolean }) => {
        const handle = `wh-${withdrawals.size + 1}`
        withdrawals.set(reg.sourceId, { handle, isWithdrawn: reg.isWithdrawn })
        return { handle, unregister: () => { withdrawals.delete(reg.sourceId) } }
      },
      registerOwnerNotificationReply: (reg: { sourceId: string; consume: (i: { idempotencyKey: string; text: string }) => string }) => {
        replyConsumers.set(reg.sourceId, { consume: reg.consume })
        return { unregister: () => { replyConsumers.delete(reg.sourceId) } }
      },
      validateOwnerRoute: (v: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
        receiptVersion: 2,
        ...v,
        principalRecordId: 'pr-1',
        principalVersion: 1,
      }),
      resolveOwnerRoute: () => ({ binding: { sessionId: 'sess-1' } }),
      inspectOwnerNotification: () => undefined,
      enqueueOwnerNotification: () => ({ id: 'outbox-q-1' }),
    } as never)

    await ctx.plugin(AssistantEvaluationService, {
      databasePath: ':memory:',
      projectionIntervalMs: 0,
      notificationSyncIntervalMs: 0,
      notificationResponseWindowMs: hour,
      attentionTuningObservationMs: day,
      attentionOwnerQuestionOwner: owner,
      intakeAttentionAgreementPersistIntervalMs: 60_000,
    })

    const proxy = ctx.get('assistantEvaluation')!
    const childProxy = ctx.extend({}).assistantEvaluation
    expect((proxy as unknown as Record<symbol, unknown>)[symbols.original]).not.toBe(proxy)
    expect((childProxy as unknown as Record<symbol, unknown>)[symbols.original]).toBe(
      (proxy as unknown as Record<symbol, unknown>)[symbols.original],
    )

    // Core methods via proxy
    expect(proxy.limits().maxQueryLimit).toBe(100)
    const hostScope = proxy.canonicalHostScope(scope)
    expect(hostScope.workspace).toBe(scope.workspace)
    expect(childProxy.createHostScope(scope)).toEqual(hostScope)
    expect(canonicalEvaluationHostScope(scope).preset).toBe(scope.preset)
    expect(proxy.query({ scope, limit: 5 })).toEqual([])
    expect(childProxy.queryTasks({ scope, limit: 5 })).toEqual([])
    expect(proxy.summary({ scope })).toMatchObject({ total: 0 })
    const unsubTask = proxy.onTrustedTaskChange(() => {})
    unsubTask()
    await expect(proxy.reconcileProjections()).resolves.toMatchObject({ attempted: 0 })
    await expect(childProxy.whenProjectionIdle()).resolves.toBeUndefined()

    // Notification outcomes + tuning + loosening + owner questions through proxy
    while (proxy.reconcileNotificationOutcomes().ingested > 0) { /* drain */ }
    expect(proxy.notificationOutcomeFeed({ scope, limit: 5 }).items.length).toBe(5)
    expect(childProxy.notificationOutcomeSummary({ scope }).total).toBe(200)
    expect(proxy.inspectNotificationOutcome({ scope, notificationId: 'n-0' })).toBeDefined()

    expect(proxy.inspectIntakeAttentionAgreement({ scope })).toBeDefined()
    expect(childProxy.reconcileIntakeAttentionAgreementPersistence()).toMatchObject({ recorded: false })
    expect(proxy.inspectIntakeAttentionAgreementHistory({ scope })?.snapshots).toEqual([])
    expect(proxy.reconcileIntakeEvaluationAgreement().enabled).toBe(true)
    expect(proxy.intakeEvaluationFeedCursor().afterSeq).toBe(0)
    expect(proxy.inspectIntakeEvaluationAgreement({ evalId: 'missing' })).toBeUndefined()
    expect(proxy.intakeEvaluationAgreementSummary({ scope })?.total).toBe(0)
    expect(proxy.listIntakeEvaluationAgreements({ scope }).items).toEqual([])

    const adoptedEvents: AttentionLooseningConsumerEvent[] = []
    const allEvents: AttentionLooseningConsumerEvent[] = []
    const unsubAdopted = proxy.onAttentionLooseningAdopted(event => { adoptedEvents.push(event) })
    const unsubChanged = childProxy.onAttentionTuningChanged(event => { allEvents.push(event) })

    // Sync tuning (auto-adopts v1), then settle and request loosening -> owner question
    const firstTick = proxy.reconcileAttentionTuning()
    expect(firstTick[0]).toMatchObject({ result: { action: 'adopted', version: 1 } })
    expect(childProxy.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1 })
    expect(proxy.attentionTuningStatus({ scope, cohort }).versions).toHaveLength(1)

    vi.advanceTimersByTime(day)
    expect(proxy.reconcileAttentionTuning()[0]).toMatchObject({ result: { action: 'settled', version: 1 } })

    const req = childProxy.requestAttentionTuning({
      scope,
      cohort,
      parameters: normalizeAttentionTuningParameters({
        ...defaultAttentionTuningParameters,
      }) as never,
    })
    expect(req.status).toBe('proposed')

    const qTick = proxy.reconcileAttentionTuning()
    expect(qTick[0]).toMatchObject({ result: { action: 'owner-question' } })
    const questionId = (qTick[0]!.result as { questionId: string }).questionId

    const deliveries = proxy.reconcileAttentionOwnerQuestions()
    expect(deliveries[0]).toMatchObject({ result: { action: 'queued', questionId } })
    expect(proxy.attentionOwnerQuestionStatus({ scope, cohort }).deliveries).toHaveLength(1)

    // Verify Delivery-captured withdrawal & reply callbacks work without #private receiver errors
    const withdrawal = [...withdrawals.values()][0]!
    expect(withdrawal.isWithdrawn(`attention-owner-question:${questionId}`)).toBe(false)
    const replyConsumer = [...replyConsumers.values()][0]!
    expect(replyConsumer.consume({
      idempotencyKey: `attention-owner-question:${questionId}`,
      text: 'authorize-once',
    })).toBe('applied')
    expect(proxy.recordAttentionOwnerQuestionReply({ scope, cohort, questionId, choice: 'authorize-once' })).toMatchObject({
      status: 'recorded',
      choice: 'authorize-once',
    })
    expect(childProxy.applyAttentionOwnerQuestionReply({ scope, cohort, questionId, choice: 'authorize-once' })).toMatchObject({
      status: 'applied',
    })
    expect(proxy.attentionLooseningStatus({ scope, cohort }).grant).not.toBeNull()
    expect(proxy.grantAttentionLoosening({
      scope,
      cohort,
      grant: {
        grantId: 'explicit-grant',
        lowerBound: defaultAttentionTuningParameters,
        upperBound: { ...defaultAttentionTuningParameters, interruptionCostDelta: 20 },
        maxStepsPerAdoption: 1,
        maxAdoptions: 1,
        expiresAt: Date.now() + day,
      },
    }).status).toBe('granted')

    // Emit manual F03 consumer event through proxy (including optional overlay deltas)
    const emitted = proxy.emitLooseningToConsumers({
      workItemsMode: 'auto',
      intakeRuleUpdates: [{ ruleId: 'dsh-intake-github-mention-or-review', enabled: true, mode: 'auto', confidenceThresholdPpm: 800_000, minUtility: 10 }],
      interruptionCostDelta: 20,
    })
    expect(emitted.workItemsMode).toBe('auto')
    expect(emitted.interruptionCostDelta).toBe(20)
    expect(emitted.parameters?.interruptionCostDelta).toBe(20)
    expect(adoptedEvents).toHaveLength(1)
    expect(allEvents).toHaveLength(1)

    unsubAdopted()
    unsubChanged()
  })
})
