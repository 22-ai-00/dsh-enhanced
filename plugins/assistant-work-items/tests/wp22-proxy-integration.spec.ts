import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import {
  AssistantEvaluationService,
  attentionHoldoutMember,
  defaultAttentionTuningParameters,
  normalizeAttentionTuningParameters,
} from '@dsh-ray/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { createTaskAcceptanceContract } from '@dsh-ray/task-acceptance-contract'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantWorkItemsService } from '../src/index.ts'

const proactiveSource = new URL('../../assistant-proactive/src/index.ts', import.meta.url).href

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const hour = 3_600_000
const day = 24 * hour

describe('4-Service Live Cordis Proxy Integration (T3-EW-02 + F03 WP22 closed loop)', () => {
  test('Policy + Evaluation + Proactive + WorkItems interact strictly via live Cordis Proxies across loosening, dynamic rules, rollback, and restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)

    const dir = mkdtempSync(join(tmpdir(), 'dsh-wp22-4svc-'))
    dirs.push(dir)
    const policyDb = join(dir, 'policy.sqlite')
    const evalDb = join(dir, 'eval.sqlite')
    const proDb = join(dir, 'proactive.sqlite')
    const wiDb = join(dir, 'work-items.sqlite')

    const { AssistantProactiveService, OpportunityEngine, proactiveAttentionCohort } = await import(proactiveSource) as {
      AssistantProactiveService: new (...args: unknown[]) => unknown
      OpportunityEngine: new (dbPath: string, profiles: readonly unknown[]) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): { decision: { utility: number } }
        close(): void
      }
      proactiveAttentionCohort: { lane: string; sourceId: string }
    }

    const scope = { workspace: dir, preset: 'primary' }
    const proactiveProfile = {
      id: 'prof-1',
      mode: 'remind',
      expectedBenefit: 100,
      successPpm: 800_000,
      executionCost: 10,
      interruptionCost: 15,
      possibleLoss: 5,
      minimumUtility: 30,
      mergeWindowMs: 0,
      cooldownMs: 1_000,
      rejectionCooldownMs: 1_000,
      maxDecisionsPerGoal: 10,
      maxExecutionsPerGoal: 5,
      maxRemindersPerGoal: 5,
    }
    const baseEngine = new OpportunityEngine(join(dir, 'baseline-eng.sqlite'), [proactiveProfile])
    const baseInput = (seq: number) => ({
      waitId: `wait-${seq}`,
      profileId: 'prof-1',
      scope: { principalId: 'web/a/t/u', principalRecordId: 'owner-1', principalVersion: 1, workspace: dir, preset: 'primary' },
      goalId: 'goal-1',
      sessionId: 'sess-1',
      definitionDigest: sha256('def'),
      objective: 'Check upcoming deadline',
      nativeGoalId: 'ng-1',
      nativeRevision: 1,
      ownerRouteId: 'route-1',
      sourceDigest: sha256('src'),
      sourceId: 'src-1',
      event: { id: `evt-${seq}`, sequence: seq, digest: sha256(`evt-${seq}`), occurredAt: 1_700_000_000_000 + seq },
      expiresAt: 1_900_000_000_000,
    })
    const baselineUtility = baseEngine.evaluate(baseInput(1), undefined, { userActive: false, urgencyPpm: 700_000 }).decision.utility
    baseEngine.close()

    const objectiveText = 'Remediate live proxy integration workflow'
    const digest = sha256(objectiveText)
    const now = Date.now()
    const contract = createTaskAcceptanceContract({
      protocol: 'task-acceptance/v1',
      id: 'c-4svc-1',
      scope,
      owner: { principalRecordId: 'owner-1', principalVersion: 1 },
      task: { kind: 'automation-run', ref: 'run-c-4svc-1' },
      objective: objectiveText,
      profile: { id: 'intake-profile', version: 1, digest: sha256('intake-profile') },
      issuedAt: now - 1_000,
      expiresAt: now + 6 * day,
      criteria: [{
        id: 'result',
        kind: 'process-behavior',
        authority: { id: 'intake-runner', digest: sha256('intake-runner') },
        artifactPath: 'result.txt',
        stdin: '',
        expectedStdout: '',
        expectedExitCode: 0,
      }],
      bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
    })

    // Scripted Delivery facts for Evaluation holdout loosening replay
    const facts: Array<Record<string, unknown>> = []
    let factSeq = 0
    const addFactBatch = (prefix: string, count: number, negativeFn: (id: string) => boolean, at: number) => {
      for (let i = 0; i < count; i++) {
        factSeq += 1
        const id = `${prefix}-${i}`
        facts.push({
          auditSequence: factSeq,
          outboxId: id,
          bindingId: 'b-1',
          scope,
          lane: 'intake',
          sourceId: 'assistant-work-items',
          purpose: 'attention',
          purposeSource: 'lane',
          verdict: 'would-accept',
          reasons: [],
          auditedAt: at,
          transport: { status: 'delivered', acceptedAt: at + 1, deliveredAt: at + 2 },
          judgement: { source: 'owner-objective', version: 1, objectiveStatus: negativeFn(id) ? 'not-achieved' : 'achieved' },
        })
      }
    }

    const mockDelivery = {
      isMaintenanceDraining: () => true,
      validateOwnerRoute: (v: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
        receiptVersion: 2,
        ...v,
        authorityHash: sha256('auth'),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        bindingVersion: 1,
        generation: 1,
      }),
      enqueueBackground: async () => ({ id: 'out-bg-1' }),
      enqueueOwnerNotification: () => ({ id: 'out-notice-1' }),
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
    }

    const mockLlm = {
      stream: async function* () {
        const text = JSON.stringify({
          ruleId: 'dsh-intake-github-mention-or-review',
          level: 'accept',
          quotes: ['Remediate live proxy'],
        })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }

    const workItemsCfg = {
      enabled: true,
      mode: 'active' as const,
      databasePath: wiDb,
      workRoot: dir,
      workerAutomationId: 'worker-1',
      scope: {
        workspace: dir,
        preset: 'primary',
        principalId: 'web/a/t/u',
        ownerRouteId: 'route-1',
        expiresAt: now + 30 * day,
      },
      admission: { allowedKinds: ['intake-inferred'], maxOpenItems: 100, maxAdmitsPerHour: 100, cooldownMs: 0 },
      intakeLedger: {
        enabled: true,
        sources: { 'lark-channel': { unaddressedGroupMessages: true, unsubscribedEvents: false } },
        evaluation: {
          enabled: true,
          admit: { enabled: true, mode: 'observe' as const, kind: 'intake-inferred', originBindingId: 'b-1' },
        },
      },
    }

    const ctx1 = new Context()
    contexts.push(ctx1)
    ctx1.provide('assistantDelivery' as never, mockDelivery as never)
    ctx1.provide('assistantVerifier' as never, {
      inspectAcceptedTask: (id: string) => (id === contract.id
        ? { contract, state: 'awaiting-execution', attempts: 0, reason: null, receipt: null }
        : null),
    } as never)
    ctx1.provide('llm' as never, mockLlm as never)

    await ctx1.plugin(AssistantPolicyService, {
      databasePath: policyDb,
      rules: [{
        id: 'dsh-intake-github-mention-or-review',
        effect: 'allow',
        subject: { kind: 'background', id: 'work-items/v1', workspace: dir, principal: 'web/a/t/u' },
        actions: ['admit'],
        resource: { kind: 'automation', id: 'worker-1' },
        context: { initiators: ['background'] },
      }],
    })
    await ctx1.plugin(AssistantEvaluationService, {
      databasePath: evalDb,
      projectionIntervalMs: 0,
      notificationSyncIntervalMs: 0,
      notificationResponseWindowMs: hour,
      intakeEvaluationAgreementEnabled: false,
      attentionTuningObservationMs: day,
      attentionTuningCohorts: [
        proactiveAttentionCohort,
        { lane: 'intake', sourceId: 'assistant-work-items' },
      ],
    })
    await ctx1.plugin(AssistantWorkItemsService, workItemsCfg)
    await ctx1.plugin(AssistantProactiveService as never, {
      databasePath: proDb,
      profiles: [{ ...proactiveProfile, minimumUtility: baselineUtility - 5 }],
      intakeEvaluation: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        rules: [{ ruleId: 'dsh-intake-github-mention-or-review', ceiling: 'accept' }],
      },
    } as never)

    const evalProxy = ctx1.get('assistantEvaluation')!
    const wiProxy = ctx1.get('assistantWorkItems')!
    const proProxy = ctx1.get('assistantProactive' as never) as unknown as {
      evaluate: (input: unknown, rc?: unknown) => { decision: { utility: number; reason: string } }
      intakeRuleOverrides: () => readonly { ruleId: string; enabled: boolean; mode?: string }[]
      intakeEvaluationHealth: () => { policyVersion: string | null; registered: boolean }
    }

    // Flow A (T3-EW-02): Evaluation Proxy tightens proactive cohort -> Proactive reads live Proxy overlay -> utility drops by 10
    const tightenRes = evalProxy.requestAttentionTuning({
      scope,
      cohort: proactiveAttentionCohort,
      parameters: normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, interruptionCostDelta: 10 }),
    })
    expect(tightenRes.status).toBe('adopted')
    const proEval = proProxy.evaluate(baseInput(2), { userActive: false, urgencyPpm: 700_000 })
    expect(proEval.decision.utility).toBe(baselineUtility - 10)
    expect(proEval.decision.reason).toBe('below-threshold')

    // Flow B (F03): WP22 loosening adoption propagates automatically to WorkItems + Proactive without manual restart
    expect(wiProxy.intakeAdmissionMode()).toBe('observe')
    const intakeCohort = { lane: 'intake', sourceId: 'assistant-work-items' }
    let holdIdx = 0
    addFactBatch('hold', 200, id => !attentionHoldoutMember(id) && (holdIdx++ % 4 !== 0), now - 5_000)
    while (evalProxy.reconcileNotificationOutcomes().ingested > 0) { /* drain */ }
    expect(evalProxy.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result).toMatchObject({ action: 'adopted', version: 1 })
    vi.advanceTimersByTime(day)
    expect(evalProxy.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result).toMatchObject({ action: 'settled', version: 1 })

    const loosenParams = normalizeAttentionTuningParameters({
      ...defaultAttentionTuningParameters,
    })
    const grantRes = evalProxy.grantAttentionLoosening({
      scope,
      cohort: intakeCohort,
      grant: {
        grantId: 'g-wp22-auto',
        lowerBound: loosenParams,
        upperBound: { ...defaultAttentionTuningParameters, interruptionCostDelta: 10 },
        maxStepsPerAdoption: 1,
        maxAdoptions: 1,
        expiresAt: Date.now() + 7 * day,
      },
    })
    expect(grantRes.status).toBe('granted')
    expect(evalProxy.requestAttentionTuning({ scope, cohort: intakeCohort, parameters: loosenParams }).status).toBe('proposed')

    // Tick adopts holdout-verified loosening (v2) AND fires onAttentionLooseningAdopted -> then broadcast workItemsMode: 'auto' + rule overrides!
    const adoptedEvents: unknown[] = []
    const unsubLoosen = evalProxy.onAttentionLooseningAdopted(ev => { adoptedEvents.push(ev) })
    const loosenTick = evalProxy.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')
    expect(loosenTick?.result).toMatchObject({ action: 'loosening-adopted', version: 2 })
    expect(adoptedEvents).toHaveLength(1)
    unsubLoosen()

    // Broadcast dynamic workItemsMode: 'auto' & intakeRuleUpdates via Evaluation Proxy -> both WorkItems and Proactive adopt live without bumping policyVersion
    const initialPolicyVer = proProxy.intakeEvaluationHealth().policyVersion
    evalProxy.emitLooseningToConsumers({
      workItemsMode: 'auto',
      intakeRuleUpdates: [
        { ruleId: 'dsh-intake-github-mention-or-review', enabled: true, mode: 'auto', confidenceThresholdPpm: 800_000, minUtility: 10 },
      ],
    })
    expect(wiProxy.intakeAdmissionMode()).toBe('auto')
    expect(proProxy.intakeEvaluationHealth().policyVersion).toBe(initialPolicyVer)
    expect(proProxy.intakeRuleOverrides()[0]).toMatchObject({
      ruleId: 'dsh-intake-github-mention-or-review',
      enabled: true,
      mode: 'auto',
    })
    expect(wiProxy.intakeTuning().rules[0]).toMatchObject({
      ruleId: 'dsh-intake-github-mention-or-review',
      enabled: true,
      mode: 'auto',
    })

    // Record inferred intake -> evaluated by real Proactive LLM producer -> admitted via real Policy into SQLite work_item!
    wiProxy.recordIntake({
      source: 'lark-channel',
      sourceEventId: 'evt-wp22-1',
      kind: 'message',
      senderAllowlisted: true,
      addressed: false,
      threadFollowUp: false,
      senderIsBot: false,
      groupMessage: true,
      contentDigest: digest,
      occurredAt: Date.now(),
      objective: objectiveText,
      objectiveDigest: digest,
      acceptance: { contractId: contract.id, contractDigest: contract.digest },
    }, objectiveText)
    await vi.advanceTimersByTimeAsync(10)
    await wiProxy.runIntakeEvaluation()
    const adm = wiProxy.runIntakeAdmission()
    expect(adm[0]).toMatchObject({ outcome: 'admitted', mode: 'auto' })
    expect(adm[0]?.itemId).not.toBeNull()

    // Flow C (WP22 regression rollback): negative flood rolls back version 2 -> 1 AND tuning change propagation reverts auto -> observe!
    vi.advanceTimersByTime(1_000)
    addFactBatch('regress', 40, () => true, Date.now() - 10)
    while (evalProxy.reconcileNotificationOutcomes().ingested > 0) { /* drain */ }
    const rollbackTick = evalProxy.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')
    expect(rollbackTick?.result).toMatchObject({ action: 'rolled-back', fromVersion: 2, toVersion: 1 })
    evalProxy.emitLooseningToConsumers({ action: 'rolled-back', workItemsMode: 'observe' })
    expect(wiProxy.intakeAdmissionMode()).toBe('observe')

    // Re-adopt auto mode before restart, then verify restart persistence with static mode: 'observe'
    evalProxy.emitLooseningToConsumers({ workItemsMode: 'auto' })
    expect(wiProxy.intakeAdmissionMode()).toBe('auto')
    await ctx1.fiber.restart()
    contexts.splice(contexts.indexOf(ctx1), 1)

    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(AssistantPolicyService, { databasePath: policyDb })
    await ctx2.plugin(AssistantWorkItemsService, workItemsCfg)
    const wiProxy2 = ctx2.get('assistantWorkItems')!
    expect(wiProxy2.intakeAdmissionMode()).toBe('auto')
    expect(wiProxy2.intakeTuning().rules[0]).toMatchObject({
      ruleId: 'dsh-intake-github-mention-or-review',
      mode: 'auto',
    })
  }, 20_000)

  test('offline and live Evaluation rollbacks reconcile workItemsMode and intakeRuleUpdates cleanly without regressing manual auto promotion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)

    const createEnv = (label: string) => {
      const dir = mkdtempSync(join(tmpdir(), `dsh-wp22-rollback-${label}-`))
      dirs.push(dir)
      const scope = { workspace: dir, preset: 'primary' }
      const evalDb = join(dir, 'eval.sqlite')
      const wiDb = join(dir, 'wi.sqlite')
      const policyDb = join(dir, 'policy.sqlite')
      const intakeCohort = { lane: 'intake', sourceId: 'assistant-work-items' }
      const wiConfig = {
        enabled: true,
        mode: 'active' as const,
        databasePath: wiDb,
        workRoot: dir,
        workerAutomationId: 'worker-1',
        scope: {
          workspace: dir,
          preset: 'primary',
          principalId: 'web/a/t/u',
          ownerRouteId: 'route-1',
          expiresAt: Date.now() + 30 * day,
        },
        admission: { allowedKinds: ['intake-inferred'], maxOpenItems: 50, maxAdmitsPerHour: 50, cooldownMs: 0 },
        intakeLedger: {
          enabled: true,
          sources: { 'lark-channel': { unaddressedGroupMessages: true, unsubscribedEvents: false } },
          evaluation: {
            enabled: true,
            admit: { enabled: true, mode: 'observe' as const, kind: 'intake-inferred', originBindingId: 'b-1' },
          },
        },
      }
      const feedItems: Array<Record<string, unknown>> = []
      let feedSeq = 0
      const addFeedItem = (opts: {
        eventId: string
        ruleId?: string
        wouldAccept: boolean
        achieved: boolean
        at: number
      }) => {
        feedSeq += 1
        feedItems.push({
          seq: feedSeq,
          id: `feed-${feedSeq}`,
          scope,
          source: 'assistant-work-items',
          sourceEventId: opts.eventId,
          ruleId: opts.ruleId ?? 'r1',
          policyVersion: 'v1',
          mode: 'observe',
          evaluationLevel: opts.wouldAccept ? 'accept' : 'digest',
          wouldAccept: opts.wouldAccept,
          evaluationReasons: [],
          metadataDigest: sha256(`meta-${feedSeq}`),
          sourceDigest: sha256(`src-${feedSeq}`),
          contentDigest: sha256(`content-${feedSeq}`),
          evaluatedAt: opts.at,
          recordedAt: opts.at,
          admission: null,
          outcome: null,
          acceptanceVerdict: {
            objectiveStatus: opts.achieved ? 'achieved' : 'not-achieved',
            receiptDigest: sha256(`r-${feedSeq}`),
            completedAt: opts.at + 1,
            recordedAt: opts.at + 1,
          },
          ownerCorrection: null,
        })
      }
      const feedMockWorkItems = {
        listIntakeEvaluationFeed: (opts: { afterSeq?: number; limit?: number }) => {
          const items = feedItems.filter(item => (item.seq as number) > (opts.afterSeq ?? 0)).slice(0, opts.limit ?? 200)
          const last = items.at(-1)
          return {
            protocol: 'work-items/intake-evaluation-feed/v1',
            items,
            hasMore: items.length > 0 && (last!.seq as number) < feedItems.length,
            nextCursor: last
              ? { afterSeq: last.seq, afterRecordedAt: last.recordedAt, afterId: last.id }
              : null,
          }
        },
      }
      const deliveryMock = {
        isMaintenanceDraining: () => true,
        validateOwnerRoute: (v: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
          receiptVersion: 2,
          ...v,
          authorityHash: sha256('auth'),
          principalRecordId: 'owner-1',
          principalVersion: 1,
          bindingVersion: 1,
          generation: 1,
        }),
        enqueueBackground: async () => ({ id: 'out-bg-1' }),
      }
      const evalConfig = {
        databasePath: evalDb,
        projectionIntervalMs: 0,
        notificationSyncIntervalMs: 0,
        notificationResponseWindowMs: hour,
        notificationOutcomesEnabled: true,
        attentionTuningAutoAdopt: true,
        attentionLooseningEnabled: true,
        intakeEvaluationAgreementEnabled: true,
        intakeAttentionAgreementEnabled: false,
        attentionTuningMinSample: 10,
        attentionTuningObservationMs: day,
        attentionTuningCohorts: [intakeCohort],
      }
      return { dir, scope, evalDb, wiDb, policyDb, intakeCohort, wiConfig, evalConfig, addFeedItem, feedMockWorkItems, deliveryMock }
    }

    // 1. Case 5c: v2 (workItemsMode: 'auto') -> v1 (workItemsMode: undefined) offline rollback
    {
      const env = createEnv('5c')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      const evalSeed = ctxSeed.get('assistantEvaluation')!
      // Seed training negative outcomes -> v0 tightens to v1 (interruptionCostDelta: 10, workItemsMode: undefined)
      for (let i = 0; i < 60; i += 1) {
        env.addFeedItem({ eventId: `base-${i}`, wouldAccept: true, achieved: i >= 48, at: Date.now() - 10_000 + i * 10 })
      }
      evalSeed.reconcileIntakeEvaluationAgreement()
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'adopted', version: 1 })
      vi.advanceTimersByTime(day)
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'settled', version: 1 })

      // Seed counterfactual positives under v1 so v1 -> v2 (workItemsMode: 'auto') passes holdout replay
      for (let i = 0; i < 80; i += 1) {
        env.addFeedItem({ eventId: `cf-${i}`, wouldAccept: false, achieved: true, at: Date.now() + 10 + i * 10 })
      }
      vi.advanceTimersByTime(2_000)
      evalSeed.reconcileIntakeEvaluationAgreement()
      const v1Params = evalSeed.currentAttentionTuning({ scope: env.scope, cohort: env.intakeCohort })!.parameters
      expect(v1Params.workItemsMode).toBeUndefined()
      const v2Params = normalizeAttentionTuningParameters({ ...v1Params, workItemsMode: 'auto' })
      expect(evalSeed.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-5c',
          lowerBound: v2Params,
          upperBound: v1Params,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v2Params }).status).toBe('proposed')
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 2 })
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      // Mount real Evaluation + WorkItems so WorkItems adopts and persists v2 ('auto')
      const ctxOnline = new Context()
      contexts.push(ctxOnline)
      ctxOnline.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxOnline.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxOnline.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxOnline.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxOnline.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('auto')
      await ctxOnline.fiber.restart()
      contexts.splice(contexts.indexOf(ctxOnline), 1)

      // While WorkItems is offline, roll back v2 -> v1 on Evaluation
      const ctxEvalOnly = new Context()
      contexts.push(ctxEvalOnly)
      ctxEvalOnly.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxEvalOnly.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxEvalOnly.plugin(AssistantEvaluationService, env.evalConfig)
      const evalOffline = ctxEvalOnly.get('assistantEvaluation')!
      vi.advanceTimersByTime(1_000)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg5c-${i}`, wouldAccept: true, achieved: false, at: Date.now() - 100 + i })
      }
      evalOffline.reconcileIntakeEvaluationAgreement()
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 2, toVersion: 1 })
      await ctxEvalOnly.fiber.restart()
      contexts.splice(contexts.indexOf(ctxEvalOnly), 1)

      // Remount Evaluation + WorkItems -> Case 5c must revert 'auto' -> 'observe'
      const ctxRestart1 = new Context()
      contexts.push(ctxRestart1)
      ctxRestart1.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxRestart1.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestart1.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxRestart1.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestart1.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('observe')
      await ctxRestart1.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestart1), 1)

      // Second restart (without Evaluation) confirms 'observe' was persisted in SQLite meta
      const ctxRestart2 = new Context()
      contexts.push(ctxRestart2)
      await ctxRestart2.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestart2.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestart2.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('observe')
      await ctxRestart2.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestart2), 1)
    }

    // 2. Case 5d: v1 -> v0 offline rollback followed by trailing request-rejected event
    {
      const env = createEnv('5d')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      const evalSeed = ctxSeed.get('assistantEvaluation')!
      for (let i = 0; i < 80; i += 1) {
        env.addFeedItem({ eventId: `cf5d-${i}`, wouldAccept: false, achieved: true, at: Date.now() - 5_000 + i * 10 })
      }
      evalSeed.reconcileIntakeEvaluationAgreement()
      const v1Params = normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, workItemsMode: 'auto' })
      expect(evalSeed.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-5d',
          lowerBound: v1Params,
          upperBound: defaultAttentionTuningParameters,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1Params }).status).toBe('proposed')
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 1 })
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      // WorkItems goes online and persists v1 ('auto')
      const ctxOnline = new Context()
      contexts.push(ctxOnline)
      ctxOnline.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxOnline.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxOnline.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxOnline.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxOnline.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('auto')
      await ctxOnline.fiber.restart()
      contexts.splice(contexts.indexOf(ctxOnline), 1)

      // While WorkItems is offline: roll back v1 -> v0, then append a trailing request-rejected event
      const ctxEvalOnly = new Context()
      contexts.push(ctxEvalOnly)
      ctxEvalOnly.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxEvalOnly.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxEvalOnly.plugin(AssistantEvaluationService, env.evalConfig)
      const evalOffline = ctxEvalOnly.get('assistantEvaluation')!
      vi.advanceTimersByTime(1_000)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg5d-${i}`, wouldAccept: true, achieved: false, at: Date.now() - 100 + i })
      }
      evalOffline.reconcileIntakeEvaluationAgreement()
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 1, toVersion: 0 })
      expect(evalOffline.requestAttentionTuning({
        scope: env.scope,
        cohort: env.intakeCohort,
        parameters: normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, interruptionCostDelta: 15 }),
      })).toEqual({ status: 'rejected', reason: 'out-of-bounds' })
      expect(evalOffline.attentionTuningStatus({ scope: env.scope, cohort: env.intakeCohort }).events.at(-1)?.kind)
        .toBe('request-rejected')
      await ctxEvalOnly.fiber.restart()
      contexts.splice(contexts.indexOf(ctxEvalOnly), 1)

      // Remount Evaluation + WorkItems -> Case 5d must revert 'auto' -> 'observe'
      const ctxRestart1 = new Context()
      contexts.push(ctxRestart1)
      ctxRestart1.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxRestart1.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestart1.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxRestart1.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestart1.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('observe')
      await ctxRestart1.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestart1), 1)
    }

    // 3a. Offline rollback of intakeRuleUpdates (v1 -> v0, even when workItemsMode was never 'auto')
    {
      const env = createEnv('rules-v1-v0')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      for (let i = 0; i < 20; i += 1) {
        env.addFeedItem({ eventId: `base-r1-${i}`, wouldAccept: true, achieved: true, at: Date.now() - 5_000 + i * 10 })
      }
      ctxSeed.get('assistantEvaluation')!.reconcileIntakeEvaluationAgreement()
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      const ctxOnline = new Context()
      contexts.push(ctxOnline)
      ctxOnline.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxOnline.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxOnline.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxOnline.plugin(AssistantWorkItemsService, env.wiConfig)
      const evalProxy = ctxOnline.get('assistantEvaluation')!
      const wiProxy = ctxOnline.get('assistantWorkItems')!

      // Tighten v0 -> v1 with rule override r1, keeping workItemsMode at 'observe'
      const r1Params = normalizeAttentionTuningParameters({
        ...defaultAttentionTuningParameters,
        intakeRuleUpdates: [{ ruleId: 'r1', enabled: false, confidenceThresholdPpm: 800_000, minUtility: 10 }],
      })
      expect(evalProxy.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: r1Params }))
        .toMatchObject({ status: 'adopted', version: 1 })
      // Persist rule override in WorkItems (including mode: 'auto') while global mode stays 'observe'
      wiProxy.applyIntakeTuning({
        intakeRuleUpdates: [{ ruleId: 'r1', enabled: false, mode: 'auto', confidenceThresholdPpm: 800_000, minUtility: 10 }],
      })
      expect(wiProxy.intakeAdmissionMode()).toBe('observe')
      expect(wiProxy.intakeTuning().rules).toHaveLength(1)
      await ctxOnline.fiber.restart()
      contexts.splice(contexts.indexOf(ctxOnline), 1)

      // While WorkItems is offline, roll back v1 -> v0 on Evaluation
      const ctxEvalOnly = new Context()
      contexts.push(ctxEvalOnly)
      ctxEvalOnly.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxEvalOnly.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxEvalOnly.plugin(AssistantEvaluationService, env.evalConfig)
      const evalOffline = ctxEvalOnly.get('assistantEvaluation')!
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg-r1-${i}`, wouldAccept: true, achieved: false, at: Date.now() + 10 + i })
      }
      vi.advanceTimersByTime(1_000)
      evalOffline.reconcileIntakeEvaluationAgreement()
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 1, toVersion: 0 })
      await ctxEvalOnly.fiber.restart()
      contexts.splice(contexts.indexOf(ctxEvalOnly), 1)

      // Restart Evaluation + WorkItems -> stale rule override r1 is cleared!
      const ctxRestart1 = new Context()
      contexts.push(ctxRestart1)
      ctxRestart1.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxRestart1.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestart1.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxRestart1.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestart1.get('assistantWorkItems')!.intakeTuning()).toEqual({ mode: 'observe', rules: [] })
      await ctxRestart1.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestart1), 1)

      // Second restart (without Evaluation) confirms cleared rules persisted in SQLite meta
      const ctxRestart2 = new Context()
      contexts.push(ctxRestart2)
      await ctxRestart2.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestart2.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestart2.get('assistantWorkItems')!.intakeTuning()).toEqual({ mode: 'observe', rules: [] })
      await ctxRestart2.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestart2), 1)
    }

    // 3b. Offline rollback of intakeRuleUpdates (v2 -> v1)
    {
      const env = createEnv('rules-v2-v1')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      const evalSeed = ctxSeed.get('assistantEvaluation')!
      // v0 -> v1: tighten r1 and r2
      const v1Params = normalizeAttentionTuningParameters({
        ...defaultAttentionTuningParameters,
        intakeRuleUpdates: [
          { ruleId: 'r1', enabled: true, mode: 'observe', confidenceThresholdPpm: 900_000, minUtility: 10 },
          { ruleId: 'r2', enabled: false },
        ],
      })
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1Params }))
        .toMatchObject({ status: 'adopted', version: 1 })
      vi.advanceTimersByTime(day)
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'settled', version: 1 })

      // Seed counterfactual positives under v1 so v1 -> v2 loosening on intakeRuleUpdates passes holdout replay
      for (let i = 0; i < 80; i += 1) {
        env.addFeedItem({ eventId: `cf-r2-${i}`, wouldAccept: false, achieved: true, at: Date.now() + 10 + i * 10 })
      }
      vi.advanceTimersByTime(2_000)
      evalSeed.reconcileIntakeEvaluationAgreement()
      const v2Params = normalizeAttentionTuningParameters({
        ...defaultAttentionTuningParameters,
        intakeRuleUpdates: [
          { ruleId: 'r1', enabled: true, mode: 'auto', confidenceThresholdPpm: 500_000, minUtility: 5 },
          { ruleId: 'r2', enabled: true, mode: 'auto' },
        ],
      })
      expect(evalSeed.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-rules-v2',
          lowerBound: v2Params,
          upperBound: v1Params,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v2Params }).status).toBe('proposed')
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 2 })
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      // WorkItems goes online and receives/persists v2 rules
      const ctxOnline = new Context()
      contexts.push(ctxOnline)
      ctxOnline.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxOnline.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxOnline.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxOnline.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxOnline.get('assistantWorkItems')!.intakeTuning().rules).toHaveLength(2)
      await ctxOnline.fiber.restart()
      contexts.splice(contexts.indexOf(ctxOnline), 1)

      // While WorkItems is offline, roll back v2 -> v1
      const ctxEvalOnly = new Context()
      contexts.push(ctxEvalOnly)
      ctxEvalOnly.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxEvalOnly.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxEvalOnly.plugin(AssistantEvaluationService, env.evalConfig)
      const evalOffline = ctxEvalOnly.get('assistantEvaluation')!
      vi.advanceTimersByTime(1_000)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg-r2-${i}`, wouldAccept: true, achieved: false, at: Date.now() - 100 + i })
      }
      evalOffline.reconcileIntakeEvaluationAgreement()
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 2, toVersion: 1 })
      await ctxEvalOnly.fiber.restart()
      contexts.splice(contexts.indexOf(ctxEvalOnly), 1)

      // Restart Evaluation + WorkItems -> rules match v1 exactly (r1 reverted to v1 thresholds/mode, r2 reverted to disabled)
      const ctxRestart1 = new Context()
      contexts.push(ctxRestart1)
      ctxRestart1.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxRestart1.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestart1.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxRestart1.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestart1.get('assistantWorkItems')!.intakeTuning().rules).toEqual([
        { ruleId: 'r1', enabled: true, mode: 'observe', confidenceThresholdPpm: 900_000, minUtility: 10 },
        { ruleId: 'r2', enabled: false },
      ])
      await ctxRestart1.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestart1), 1)

      // Second restart confirms v1 rules persisted cleanly
      const ctxRestart2 = new Context()
      contexts.push(ctxRestart2)
      await ctxRestart2.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestart2.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestart2.get('assistantWorkItems')!.intakeTuning().rules).toEqual([
        { ruleId: 'r1', enabled: true, mode: 'observe', confidenceThresholdPpm: 900_000, minUtility: 10 },
        { ruleId: 'r2', enabled: false },
      ])
      await ctxRestart2.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestart2), 1)
    }

    // 4. Live rollback of intakeRuleUpdates (v1 -> v0) clears rule overrides in-memory and in SQLite meta
    {
      const env = createEnv('rules-live-v1-v0')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      for (let i = 0; i < 20; i += 1) {
        env.addFeedItem({ eventId: `base-live-${i}`, wouldAccept: true, achieved: true, at: Date.now() - 5_000 + i * 10 })
      }
      ctxSeed.get('assistantEvaluation')!.reconcileIntakeEvaluationAgreement()
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      const ctxLive = new Context()
      contexts.push(ctxLive)
      ctxLive.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxLive.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxLive.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxLive.plugin(AssistantWorkItemsService, env.wiConfig)
      const evalProxy = ctxLive.get('assistantEvaluation')!
      const wiProxy = ctxLive.get('assistantWorkItems')!

      // Use requestAttentionTuning tightening v0 -> v1 with rule override, apply on WorkItems, then regress & roll back live.
      const v1Params = normalizeAttentionTuningParameters({
        ...defaultAttentionTuningParameters,
        intakeRuleUpdates: [{ ruleId: 'r1', enabled: false, confidenceThresholdPpm: 800_000, minUtility: 10 }],
      })
      expect(evalProxy.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1Params }))
        .toMatchObject({ status: 'adopted', version: 1 })
      wiProxy.applyIntakeTuning({
        intakeRuleUpdates: [{ ruleId: 'r1', enabled: false, mode: 'auto', confidenceThresholdPpm: 800_000, minUtility: 10 }],
      })
      expect(wiProxy.intakeTuning().rules).toHaveLength(1)

      // Inject negative feed outcomes into Evaluation DB via mock WorkItems on a side Context sharing evalDb, then tick live!
      await ctxLive.fiber.restart()
      contexts.splice(contexts.indexOf(ctxLive), 1)
      const ctxFeed = new Context()
      contexts.push(ctxFeed)
      ctxFeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxFeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxFeed.plugin(AssistantEvaluationService, env.evalConfig)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg-live-${i}`, wouldAccept: true, achieved: false, at: Date.now() + 10 + i })
      }
      ctxFeed.get('assistantEvaluation')!.reconcileIntakeEvaluationAgreement()
      await ctxFeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxFeed), 1)

      // Reopen live Evaluation + WorkItems (WorkItems still has r1 from SQLite meta, Evaluation is still observing v1)
      const ctxLive2 = new Context()
      contexts.push(ctxLive2)
      ctxLive2.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxLive2.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxLive2.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxLive2.plugin(AssistantWorkItemsService, env.wiConfig)
      const evalLive2 = ctxLive2.get('assistantEvaluation')!
      const wiLive2 = ctxLive2.get('assistantWorkItems')!
      expect(wiLive2.intakeTuning().rules).toHaveLength(1)
      vi.advanceTimersByTime(1_000)
      expect(evalLive2.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 1, toVersion: 0 })
      expect(wiLive2.intakeTuning()).toEqual({ mode: 'observe', rules: [] })
      await ctxLive2.fiber.restart()
      contexts.splice(contexts.indexOf(ctxLive2), 1)

      const ctxLive3 = new Context()
      contexts.push(ctxLive3)
      await ctxLive3.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxLive3.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxLive3.get('assistantWorkItems')!.intakeTuning()).toEqual({ mode: 'observe', rules: [] })
      await ctxLive3.fiber.restart()
      contexts.splice(contexts.indexOf(ctxLive3), 1)
    }

    // 5. Case 5a non-regression: manual emitLooseningToConsumers({ workItemsMode: 'auto' }) with zero Evaluation rollbacks stays 'auto' across restart
    {
      const env = createEnv('5a-nonreg')
      const ctx1 = new Context()
      contexts.push(ctx1)
      ctx1.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctx1.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctx1.plugin(AssistantEvaluationService, env.evalConfig)
      await ctx1.plugin(AssistantWorkItemsService, env.wiConfig)
      ctx1.get('assistantEvaluation')!.emitLooseningToConsumers({ workItemsMode: 'auto' })
      expect(ctx1.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('auto')
      await ctx1.fiber.restart()
      contexts.splice(contexts.indexOf(ctx1), 1)

      const ctx2 = new Context()
      contexts.push(ctx2)
      ctx2.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctx2.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctx2.plugin(AssistantEvaluationService, env.evalConfig)
      await ctx2.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctx2.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('auto')
      await ctx2.fiber.restart()
      contexts.splice(contexts.indexOf(ctx2), 1)
    }

    // 6. Multi-rollback offline history (v1 auto -> v0, v2 cost -> v0, v3 minUtility adopted) -> reconnect reverts to 'observe'
    {
      const env = createEnv('multi-rb')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      const evalSeed = ctxSeed.get('assistantEvaluation')!
      for (let i = 0; i < 80; i += 1) {
        env.addFeedItem({ eventId: `cf-multi-${i}`, wouldAccept: false, achieved: true, at: Date.now() - 5_000 + i * 10 })
      }
      evalSeed.reconcileIntakeEvaluationAgreement()
      const v1AutoParams = normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, workItemsMode: 'auto' })
      expect(evalSeed.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-multi-1',
          lowerBound: v1AutoParams,
          upperBound: defaultAttentionTuningParameters,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1AutoParams }).status).toBe('proposed')
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 1 })
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      // WorkItems connects and persists v1 ('auto')
      const ctxOnline = new Context()
      contexts.push(ctxOnline)
      ctxOnline.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxOnline.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxOnline.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxOnline.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxOnline.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('auto')
      await ctxOnline.fiber.restart()
      contexts.splice(contexts.indexOf(ctxOnline), 1)

      // While WorkItems is offline: rollback v1 -> v0, tighten v2 (interruptionCostDelta) -> rollback v2 -> v0, tighten v3 (minimumUtilityDelta)
      const ctxEvalOnly = new Context()
      contexts.push(ctxEvalOnly)
      ctxEvalOnly.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxEvalOnly.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxEvalOnly.plugin(AssistantEvaluationService, env.evalConfig)
      const evalOffline = ctxEvalOnly.get('assistantEvaluation')!
      vi.advanceTimersByTime(1_000)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg-multi1-${i}`, wouldAccept: true, achieved: false, at: Date.now() - 100 + i })
      }
      evalOffline.reconcileIntakeEvaluationAgreement()
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 1, toVersion: 0 })

      // Advance past v1->v0 negative window and seed positive basis before adopting v2 -> v0 rollback
      vi.advanceTimersByTime(2_000)
      for (let i = 0; i < 30; i += 1) {
        env.addFeedItem({ eventId: `pos-multi2-${i}`, wouldAccept: true, achieved: true, at: Date.now() - 100 + i })
      }
      evalOffline.reconcileIntakeEvaluationAgreement()
      const v2CostParams = normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, interruptionCostDelta: 10 })
      expect(evalOffline.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v2CostParams }))
        .toMatchObject({ status: 'adopted', version: 2 })
      vi.advanceTimersByTime(1_000)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg-multi2-${i}`, wouldAccept: true, achieved: false, at: Date.now() - 100 + i })
      }
      evalOffline.reconcileIntakeEvaluationAgreement()
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 2, toVersion: 0 })

      const v3MinUtilParams = normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, minimumUtilityDelta: 10 })
      expect(evalOffline.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v3MinUtilParams }))
        .toMatchObject({ status: 'adopted', version: 3 })
      await ctxEvalOnly.fiber.restart()
      contexts.splice(contexts.indexOf(ctxEvalOnly), 1)

      // WorkItems reconnects -> must detect earlier v1 -> v0 rollback and revert to 'observe'
      const ctxReconnect = new Context()
      contexts.push(ctxReconnect)
      ctxReconnect.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxReconnect.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxReconnect.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxReconnect.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxReconnect.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('observe')
      await ctxReconnect.fiber.restart()
      contexts.splice(contexts.indexOf(ctxReconnect), 1)

      // Second restart without Evaluation confirms 'observe' persisted
      const ctxReconnect2 = new Context()
      contexts.push(ctxReconnect2)
      await ctxReconnect2.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxReconnect2.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxReconnect2.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('observe')
      await ctxReconnect2.fiber.restart()
      contexts.splice(contexts.indexOf(ctxReconnect2), 1)
    }

    // 7a. Partial-restart fail-closed (Case 6a): omitted `admit` during rollback cleanup clears rules in memory and SQLite meta
    {
      const env = createEnv('partial-6a')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      const evalSeed = ctxSeed.get('assistantEvaluation')!
      for (let i = 0; i < 80; i += 1) {
        env.addFeedItem({ eventId: `cf-6a-${i}`, wouldAccept: false, achieved: true, at: Date.now() - 10_000 + i * 10 })
      }
      evalSeed.reconcileIntakeEvaluationAgreement()
      const v1Params = normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, workItemsMode: 'auto' })
      expect(evalSeed.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-6a-1',
          lowerBound: v1Params,
          upperBound: defaultAttentionTuningParameters,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1Params }).status).toBe('proposed')
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 1 })
      vi.advanceTimersByTime(day)
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'settled', version: 1 })

      const v2Params = normalizeAttentionTuningParameters({
        ...v1Params,
        intakeRuleUpdates: [{ ruleId: 'r1', mode: 'auto' }],
      })
      expect(evalSeed.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-6a-2',
          lowerBound: v2Params,
          upperBound: v1Params,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v2Params }).status).toBe('proposed')
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 2 })
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      // Online WorkItems persists v2 (workItemsMode: 'auto', r1: { mode: 'auto' })
      const ctxOnline = new Context()
      contexts.push(ctxOnline)
      ctxOnline.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxOnline.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxOnline.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxOnline.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxOnline.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('auto')
      expect(ctxOnline.get('assistantWorkItems')!.intakeTuning().rules).toEqual([{ ruleId: 'r1', mode: 'auto' }])
      await ctxOnline.fiber.restart()
      contexts.splice(contexts.indexOf(ctxOnline), 1)

      // Offline rollback v2 -> v1
      const ctxEvalOnly = new Context()
      contexts.push(ctxEvalOnly)
      ctxEvalOnly.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxEvalOnly.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxEvalOnly.plugin(AssistantEvaluationService, env.evalConfig)
      vi.advanceTimersByTime(1_000)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg-6a-${i}`, wouldAccept: true, achieved: false, at: Date.now() - 100 + i })
      }
      const evalOffline = ctxEvalOnly.get('assistantEvaluation')!
      evalOffline.reconcileIntakeEvaluationAgreement()
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 2, toVersion: 1 })
      await ctxEvalOnly.fiber.restart()
      contexts.splice(contexts.indexOf(ctxEvalOnly), 1)

      // Restart WorkItems with `admit` omitted -> fail-closed still clears stale `r1` in memory + SQLite meta
      const wiConfigNoAdmit = {
        ...env.wiConfig,
        intakeLedger: {
          enabled: true,
          sources: env.wiConfig.intakeLedger.sources,
          evaluation: { enabled: true },
        },
      }
      const ctxNoAdmit = new Context()
      contexts.push(ctxNoAdmit)
      ctxNoAdmit.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxNoAdmit.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxNoAdmit.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxNoAdmit.plugin(AssistantWorkItemsService, wiConfigNoAdmit)
      expect(ctxNoAdmit.get('assistantWorkItems')!.intakeTuning().rules).toEqual([])
      await ctxNoAdmit.fiber.restart()
      contexts.splice(contexts.indexOf(ctxNoAdmit), 1)

      const wiDbCheck = new DatabaseSync(env.wiDb, { readOnly: true })
      const row = wiDbCheck.prepare("SELECT value FROM work_item_schema_meta WHERE key = 'intake.tuning.override/v1'").get() as { value: string }
      wiDbCheck.close()
      expect(JSON.parse(row.value)).toEqual({ workItemsMode: 'observe', rules: [] })
    }

    // 7b. Partial-restart fail-closed (Case 6b): `allowedKinds` exclusion during rollback clears persisted 'auto' in SQLite meta
    {
      const env = createEnv('partial-6b')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      const evalSeed = ctxSeed.get('assistantEvaluation')!
      for (let i = 0; i < 80; i += 1) {
        env.addFeedItem({ eventId: `cf-6b-${i}`, wouldAccept: false, achieved: true, at: Date.now() - 5_000 + i * 10 })
      }
      evalSeed.reconcileIntakeEvaluationAgreement()
      const v1Params = normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, workItemsMode: 'auto' })
      expect(evalSeed.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-6b',
          lowerBound: v1Params,
          upperBound: defaultAttentionTuningParameters,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1Params }).status).toBe('proposed')
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 1 })
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      // Online WorkItems persists v1 ('auto')
      const ctxOnline = new Context()
      contexts.push(ctxOnline)
      ctxOnline.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxOnline.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxOnline.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxOnline.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxOnline.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('auto')
      await ctxOnline.fiber.restart()
      contexts.splice(contexts.indexOf(ctxOnline), 1)

      // Offline rollback v1 -> v0
      const ctxEvalOnly = new Context()
      contexts.push(ctxEvalOnly)
      ctxEvalOnly.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxEvalOnly.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxEvalOnly.plugin(AssistantEvaluationService, env.evalConfig)
      vi.advanceTimersByTime(1_000)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg-6b-${i}`, wouldAccept: true, achieved: false, at: Date.now() - 100 + i })
      }
      const evalOffline = ctxEvalOnly.get('assistantEvaluation')!
      evalOffline.reconcileIntakeEvaluationAgreement()
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 1, toVersion: 0 })
      await ctxEvalOnly.fiber.restart()
      contexts.splice(contexts.indexOf(ctxEvalOnly), 1)

      // Restart once with allowedKinds excluding 'intake-inferred' alongside Evaluation -> SQLite meta must revert to 'observe'
      const ctxDisallowed = new Context()
      contexts.push(ctxDisallowed)
      ctxDisallowed.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxDisallowed.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxDisallowed.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxDisallowed.plugin(AssistantWorkItemsService, {
        ...env.wiConfig,
        admission: { ...env.wiConfig.admission, allowedKinds: ['other'] },
      })
      expect(ctxDisallowed.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('observe')
      await ctxDisallowed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxDisallowed), 1)

      const wiDbCheck = new DatabaseSync(env.wiDb, { readOnly: true })
      const row = wiDbCheck.prepare("SELECT value FROM work_item_schema_meta WHERE key = 'intake.tuning.override/v1'").get() as { value: string }
      wiDbCheck.close()
      expect(JSON.parse(row.value).workItemsMode).toBe('observe')

      // Restart with allowedKinds restored without Evaluation -> stays 'observe' (never resurrects 'auto')
      const ctxRestored = new Context()
      contexts.push(ctxRestored)
      await ctxRestored.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestored.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestored.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('observe')
      await ctxRestored.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestored), 1)
    }

    // 8. Live `loosening-adopted` rule removal (Case 7b) & live `rolled-back` threshold clearing in WorkItems + Proactive
    {
      const env = createEnv('live-7b-pro')
      const { AssistantProactiveService } = await import(proactiveSource) as {
        AssistantProactiveService: new (...args: unknown[]) => unknown
      }
      const proDb = join(env.dir, 'pro.sqlite')
      const mockLlm = { stream: async function* () {} }

      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      for (let i = 0; i < 80; i += 1) {
        env.addFeedItem({ eventId: `cf-7b-${i}`, wouldAccept: false, achieved: true, at: Date.now() - 5_000 + i * 10 })
      }
      ctxSeed.get('assistantEvaluation')!.reconcileIntakeEvaluationAgreement()
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      const ctxLive = new Context()
      contexts.push(ctxLive)
      ctxLive.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxLive.provide('llm' as never, mockLlm as never)
      await ctxLive.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxLive.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxLive.plugin(AssistantWorkItemsService, env.wiConfig)
      await ctxLive.plugin(AssistantProactiveService as never, {
        databasePath: proDb,
        intakeEvaluation: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          rules: [{ ruleId: 'r1', ceiling: 'accept' }],
        },
      } as never)
      const evalProxy = ctxLive.get('assistantEvaluation')!
      const wiProxy = ctxLive.get('assistantWorkItems')!
      const proProxy = ctxLive.get('assistantProactive' as never) as unknown as {
        intakeRuleOverrides: () => readonly { ruleId: string; enabled: boolean; confidenceThresholdPpm?: number; minUtility?: number }[]
        applyIntakeRuleUpdates: (u: readonly unknown[]) => unknown[]
        intakeEvaluationHealth: () => { policyVersion: string | null }
      }
      const initialPolicyVersion = proProxy.intakeEvaluationHealth().policyVersion

      // v0 -> v1: tighten with r1 disabled + thresholds; sync to WorkItems + Proactive, then settle v1
      const v1Params = normalizeAttentionTuningParameters({
        ...defaultAttentionTuningParameters,
        intakeRuleUpdates: [{ ruleId: 'r1', enabled: false, confidenceThresholdPpm: 800_000, minUtility: 15 }],
      })
      expect(evalProxy.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1Params }))
        .toMatchObject({ status: 'adopted', version: 1 })
      wiProxy.applyIntakeTuning({ intakeRuleUpdates: v1Params.intakeRuleUpdates ?? [] })
      proProxy.applyIntakeRuleUpdates(v1Params.intakeRuleUpdates ?? [])
      expect(wiProxy.intakeTuning().rules).toEqual([{ ruleId: 'r1', enabled: false, confidenceThresholdPpm: 800_000, minUtility: 15 }])
      expect(proProxy.intakeRuleOverrides()).toEqual([{ ruleId: 'r1', enabled: false, confidenceThresholdPpm: 800_000, minUtility: 15 }])

      vi.advanceTimersByTime(day)
      expect(evalProxy.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'settled', version: 1 })

      // v1 -> v2: loosening-adopted removes r1 (defaultAttentionTuningParameters, intakeRuleUpdates: undefined)
      expect(evalProxy.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-7b',
          lowerBound: defaultAttentionTuningParameters,
          upperBound: v1Params,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalProxy.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: defaultAttentionTuningParameters }).status)
        .toBe('proposed')
      expect(evalProxy.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 2 })
      expect(wiProxy.intakeTuning().rules).toEqual([])
      expect(proProxy.intakeRuleOverrides()).toEqual([])
      expect(proProxy.intakeEvaluationHealth().policyVersion).toBe(initialPolicyVersion)
      await ctxLive.fiber.restart()
      contexts.splice(contexts.indexOf(ctxLive), 1)
    }

    // 8b. Live `rolled-back` (v1 -> v0) clears `confidenceThresholdPpm` and `minUtility` in Proactive and rules in WorkItems
    {
      const env = createEnv('live-rb-pro')
      const { AssistantProactiveService } = await import(proactiveSource) as {
        AssistantProactiveService: new (...args: unknown[]) => unknown
      }
      const proDb = join(env.dir, 'pro.sqlite')
      const mockLlm = { stream: async function* () {} }

      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      for (let i = 0; i < 20; i += 1) {
        env.addFeedItem({ eventId: `base-pro-rb-${i}`, wouldAccept: true, achieved: true, at: Date.now() - 5_000 + i * 10 })
      }
      ctxSeed.get('assistantEvaluation')!.reconcileIntakeEvaluationAgreement()
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      const ctxLive = new Context()
      contexts.push(ctxLive)
      ctxLive.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxLive.provide('llm' as never, mockLlm as never)
      await ctxLive.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxLive.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxLive.plugin(AssistantWorkItemsService, env.wiConfig)
      await ctxLive.plugin(AssistantProactiveService as never, {
        databasePath: proDb,
        intakeEvaluation: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          rules: [{ ruleId: 'r1', ceiling: 'accept' }],
        },
      } as never)
      const evalProxy = ctxLive.get('assistantEvaluation')!
      const wiProxy = ctxLive.get('assistantWorkItems')!
      const proProxy = ctxLive.get('assistantProactive' as never) as unknown as {
        intakeRuleOverrides: () => readonly { ruleId: string; enabled: boolean; confidenceThresholdPpm?: number; minUtility?: number }[]
        applyIntakeRuleUpdates: (u: readonly unknown[]) => unknown[]
        intakeEvaluationHealth: () => { policyVersion: string | null }
      }
      const initialPolicyVersion = proProxy.intakeEvaluationHealth().policyVersion

      const v1Params = normalizeAttentionTuningParameters({
        ...defaultAttentionTuningParameters,
        intakeRuleUpdates: [{ ruleId: 'r1', enabled: true, confidenceThresholdPpm: 800_000, minUtility: 15 }],
      })
      expect(evalProxy.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1Params }))
        .toMatchObject({ status: 'adopted', version: 1 })
      wiProxy.applyIntakeTuning({ intakeRuleUpdates: v1Params.intakeRuleUpdates ?? [] })
      proProxy.applyIntakeRuleUpdates(v1Params.intakeRuleUpdates ?? [])
      expect(proProxy.intakeRuleOverrides()).toEqual([{ ruleId: 'r1', enabled: true, confidenceThresholdPpm: 800_000, minUtility: 15 }])

      await ctxLive.fiber.restart()
      contexts.splice(contexts.indexOf(ctxLive), 1)

      // Feed negative outcomes into evalDb via side Context
      const ctxFeed = new Context()
      contexts.push(ctxFeed)
      ctxFeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxFeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxFeed.plugin(AssistantEvaluationService, env.evalConfig)
      for (let i = 0; i < 40; i += 1) {
        env.addFeedItem({ eventId: `reg-pro-rb-${i}`, wouldAccept: true, achieved: false, at: Date.now() + 10 + i })
      }
      ctxFeed.get('assistantEvaluation')!.reconcileIntakeEvaluationAgreement()
      await ctxFeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxFeed), 1)

      // Reopen live Evaluation + WorkItems + Proactive -> tick live rollback v1 -> v0 clears thresholds in Proactive + rules in WorkItems
      const ctxLive2 = new Context()
      contexts.push(ctxLive2)
      ctxLive2.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxLive2.provide('llm' as never, mockLlm as never)
      await ctxLive2.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxLive2.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxLive2.plugin(AssistantWorkItemsService, env.wiConfig)
      await ctxLive2.plugin(AssistantProactiveService as never, {
        databasePath: proDb,
        intakeEvaluation: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          rules: [{ ruleId: 'r1', ceiling: 'accept' }],
        },
      } as never)
      const evalLive2 = ctxLive2.get('assistantEvaluation')!
      const wiLive2 = ctxLive2.get('assistantWorkItems')!
      const proLive2 = ctxLive2.get('assistantProactive' as never) as unknown as {
        intakeRuleOverrides: () => readonly { ruleId: string; enabled: boolean; confidenceThresholdPpm?: number; minUtility?: number }[]
        applyIntakeRuleUpdates: (u: readonly unknown[]) => unknown[]
        intakeEvaluationHealth: () => { policyVersion: string | null }
      }
      proLive2.applyIntakeRuleUpdates([{ ruleId: 'r1', enabled: true, confidenceThresholdPpm: 800_000, minUtility: 15 }])
      expect(proLive2.intakeRuleOverrides()).toEqual([{ ruleId: 'r1', enabled: true, confidenceThresholdPpm: 800_000, minUtility: 15 }])
      vi.advanceTimersByTime(1_000)
      expect(evalLive2.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'rolled-back', fromVersion: 1, toVersion: 0 })
      expect(wiLive2.intakeTuning().rules).toEqual([])
      expect(proLive2.intakeRuleOverrides()).toEqual([])
      expect(proLive2.intakeEvaluationHealth().policyVersion).toBe(initialPolicyVersion)
    }

    // 9. Cohort isolation: authoritative `tightened` and `rolled-back` on proactive cohorts leave intake `workItemsMode` & rules intact
    {
      const env = createEnv('proactive-cohort-isolation')
      const { AssistantProactiveService } = await import(proactiveSource) as {
        AssistantProactiveService: new (...args: unknown[]) => unknown
      }
      const proDb = join(env.dir, 'pro.sqlite')
      const mockLlm = { stream: async function* () {} }

      const ctxLive = new Context()
      contexts.push(ctxLive)
      ctxLive.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxLive.provide('llm' as never, mockLlm as never)
      await ctxLive.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxLive.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxLive.plugin(AssistantWorkItemsService, env.wiConfig)
      await ctxLive.plugin(AssistantProactiveService as never, {
        databasePath: proDb,
        intakeEvaluation: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          rules: [{ ruleId: 'r1', ceiling: 'accept' }],
        },
      } as never)
      const evalProxy = ctxLive.get('assistantEvaluation')!
      const wiProxy = ctxLive.get('assistantWorkItems')!
      const proProxy = ctxLive.get('assistantProactive' as never) as unknown as {
        intakeRuleOverrides: () => readonly { ruleId: string; enabled: boolean; minUtility?: number }[]
      }

      evalProxy.emitLooseningToConsumers({
        workItemsMode: 'auto',
        intakeRuleUpdates: [{ ruleId: 'r1', enabled: false, minUtility: 15 }],
      })
      expect(wiProxy.intakeAdmissionMode()).toBe('auto')
      expect(wiProxy.intakeTuning().rules).toEqual([{ ruleId: 'r1', enabled: false, minUtility: 15 }])
      expect(proProxy.intakeRuleOverrides()).toEqual([{ ruleId: 'r1', enabled: false, minUtility: 15 }])

      for (const sourceId of ['owner-notification', 'assistant-proactive'] as const) {
        evalProxy.emitLooseningToConsumers({
          action: 'tightened',
          scope: env.scope,
          cohort: { lane: 'proactive', sourceId },
          version: 1,
          parameters: { interruptionCostDelta: 10, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
        })
        expect(wiProxy.intakeAdmissionMode()).toBe('auto')
        expect(wiProxy.intakeTuning().rules).toEqual([{ ruleId: 'r1', enabled: false, minUtility: 15 }])
        expect(proProxy.intakeRuleOverrides()).toEqual([{ ruleId: 'r1', enabled: false, minUtility: 15 }])

        evalProxy.emitLooseningToConsumers({
          action: 'rolled-back',
          scope: env.scope,
          cohort: { lane: 'proactive', sourceId },
          version: 0,
          parameters: { interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
        })
        expect(wiProxy.intakeAdmissionMode()).toBe('auto')
        expect(wiProxy.intakeTuning().rules).toEqual([{ ruleId: 'r1', enabled: false, minUtility: 15 }])
        expect(proProxy.intakeRuleOverrides()).toEqual([{ ruleId: 'r1', enabled: false, minUtility: 15 }])
      }
      await ctxLive.fiber.restart()
      contexts.splice(contexts.indexOf(ctxLive), 1)
    }

    // 10. Offline `v1 (auto) -> v2 (observe)` tightening masked by subsequent `v3 (interruptionCostDelta)` + partial restart (`admit` omitted)
    {
      const env = createEnv('masked-mode-tighten')
      const ctxSeed = new Context()
      contexts.push(ctxSeed)
      ctxSeed.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxSeed.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxSeed.plugin(AssistantEvaluationService, env.evalConfig)
      const evalSeed = ctxSeed.get('assistantEvaluation')!
      for (let i = 0; i < 80; i += 1) {
        env.addFeedItem({ eventId: `cf-mask-${i}`, wouldAccept: false, achieved: true, at: Date.now() - 5_000 + i * 10 })
      }
      evalSeed.reconcileIntakeEvaluationAgreement()
      const v1AutoParams = normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, workItemsMode: 'auto' })
      expect(evalSeed.grantAttentionLoosening({
        scope: env.scope,
        cohort: env.intakeCohort,
        grant: {
          grantId: 'g-mask-1',
          lowerBound: v1AutoParams,
          upperBound: defaultAttentionTuningParameters,
          maxStepsPerAdoption: 1,
          maxAdoptions: 1,
          expiresAt: Date.now() + 7 * day,
        },
      }).status).toBe('granted')
      expect(evalSeed.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v1AutoParams }).status).toBe('proposed')
      expect(evalSeed.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'loosening-adopted', version: 1 })
      await ctxSeed.fiber.restart()
      contexts.splice(contexts.indexOf(ctxSeed), 1)

      // Online WorkItems persists v1 ('auto')
      const ctxOnline = new Context()
      contexts.push(ctxOnline)
      ctxOnline.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxOnline.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxOnline.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxOnline.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxOnline.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('auto')
      await ctxOnline.fiber.restart()
      contexts.splice(contexts.indexOf(ctxOnline), 1)

      // While WorkItems is offline: settle v1, tighten v2 (workItemsMode: 'observe'), settle v2, tighten v3 (interruptionCostDelta: 10)
      const ctxEvalOnly = new Context()
      contexts.push(ctxEvalOnly)
      ctxEvalOnly.provide('assistantDelivery' as never, env.deliveryMock as never)
      ctxEvalOnly.provide('assistantWorkItems' as never, env.feedMockWorkItems as never)
      await ctxEvalOnly.plugin(AssistantEvaluationService, env.evalConfig)
      const evalOffline = ctxEvalOnly.get('assistantEvaluation')!
      vi.advanceTimersByTime(day)
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'settled', version: 1 })
      const v2ObserveParams = normalizeAttentionTuningParameters({ ...defaultAttentionTuningParameters, workItemsMode: 'observe' })
      expect(evalOffline.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v2ObserveParams }))
        .toMatchObject({ status: 'adopted', version: 2 })
      vi.advanceTimersByTime(day)
      expect(evalOffline.reconcileAttentionTuning().find(r => r.cohort.lane === 'intake')?.result)
        .toMatchObject({ action: 'settled', version: 2 })
      const v3CostParams = normalizeAttentionTuningParameters({ ...v2ObserveParams, interruptionCostDelta: 10 })
      expect(evalOffline.requestAttentionTuning({ scope: env.scope, cohort: env.intakeCohort, parameters: v3CostParams }))
        .toMatchObject({ status: 'adopted', version: 3 })
      await ctxEvalOnly.fiber.restart()
      contexts.splice(contexts.indexOf(ctxEvalOnly), 1)

      // Partial restart with `admit` omitted alongside Evaluation -> must strip persisted 'auto' to 'observe' in SQLite meta
      const wiConfigNoAdmit = {
        ...env.wiConfig,
        intakeLedger: {
          enabled: true,
          sources: env.wiConfig.intakeLedger.sources,
          evaluation: { enabled: true },
        },
      }
      const ctxNoAdmit = new Context()
      contexts.push(ctxNoAdmit)
      ctxNoAdmit.provide('assistantDelivery' as never, env.deliveryMock as never)
      await ctxNoAdmit.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxNoAdmit.plugin(AssistantEvaluationService, env.evalConfig)
      await ctxNoAdmit.plugin(AssistantWorkItemsService, wiConfigNoAdmit)
      await ctxNoAdmit.fiber.restart()
      contexts.splice(contexts.indexOf(ctxNoAdmit), 1)

      const wiDbCheck = new DatabaseSync(env.wiDb, { readOnly: true })
      const row = wiDbCheck.prepare("SELECT value FROM work_item_schema_meta WHERE key = 'intake.tuning.override/v1'").get() as { value: string }
      wiDbCheck.close()
      expect(JSON.parse(row.value).workItemsMode).toBe('observe')

      // Restart with `admit` restored without Evaluation -> stays 'observe'
      const ctxRestored = new Context()
      contexts.push(ctxRestored)
      await ctxRestored.plugin(AssistantPolicyService, { databasePath: env.policyDb })
      await ctxRestored.plugin(AssistantWorkItemsService, env.wiConfig)
      expect(ctxRestored.get('assistantWorkItems')!.intakeAdmissionMode()).toBe('observe')
      await ctxRestored.fiber.restart()
      contexts.splice(contexts.indexOf(ctxRestored), 1)
    }
  }, 45_000)
})
