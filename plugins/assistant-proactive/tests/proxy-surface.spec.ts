import { createHash } from 'node:crypto'
import { Context, symbols } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantProactiveService, IntakeEvaluationError, type IntakeWorkItemsRegistration } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
})

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('AssistantProactiveService live Cordis Proxy surface (T3-EW-02 & F03)', () => {
  test('all public methods operate via ctx.get("assistantProactive") and child Context Proxies, and intakeRuleUpdates disables rules live without bumping policyVersion', async () => {
    const ctx = new Context()
    contexts.push(ctx)

    let registered: IntakeWorkItemsRegistration | undefined
    const listeners = new Set<(event: Record<string, unknown>) => void>()
    const agent = {
      id: 'agent-1',
      ctx,
      session: {
        id: 'sess-1',
        header: { ownerPrincipal: 'web/a/t/u', cwd: '/w', agentPreset: 'primary' },
      },
    }
    ctx.provide('agents' as never, {
      get: (id: string) => (id === 'agent-1' ? agent : undefined),
    } as never)
    ctx.provide('assistantPolicy' as never, {
      evaluateAgent: () => ({ effect: 'allow' }),
      authorizeAgent: () => ({ effect: 'allow' }),
    } as never)
    ctx.provide('assistantDelivery' as never, {
      enqueueOwnerNotification: () => ({ id: 'out-1' }),
      preferencePrincipalForAgent: () => ({
        principalId: 'web/a/t/u',
        principalLineage: { principalRecordId: 'rec-1', principalVersion: 1 },
        scope: { workspace: '/w', preset: 'primary' },
      }),
    } as never)
    ctx.provide('llm' as never, {
      stream: async function* () {},
    } as never)
    ctx.provide('assistantWorkItems' as never, {
      registerIntakeEvaluator: (reg: IntakeWorkItemsRegistration) => {
        registered = reg
        return () => { registered = undefined }
      },
    } as never)
    ctx.provide('assistantEvaluation' as never, {
      onAttentionTuningChanged: (cb: (event: Record<string, unknown>) => void) => {
        listeners.add(cb)
        return () => { listeners.delete(cb) }
      },
    } as never)

    await ctx.plugin(AssistantProactiveService, {
      databasePath: ':memory:',
      intakeEvaluation: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        rules: [{ ruleId: 'dsh-intake-github-mention-or-review', ceiling: 'accept' }],
      },
      profiles: [{
        id: 'remind-1',
        mode: 'remind',
        expectedBenefit: 80,
        successPpm: 850_000,
        executionCost: 10,
        interruptionCost: 10,
        possibleLoss: 5,
        minimumUtility: 10,
        mergeWindowMs: 0,
        cooldownMs: 1_000,
        rejectionCooldownMs: 1_000,
        maxDecisionsPerGoal: 10,
        maxExecutionsPerGoal: 5,
        maxRemindersPerGoal: 5,
      }],
    })

    const proxy = ctx.get('assistantProactive')!
    const childProxy = ctx.extend({}).assistantProactive
    expect(proxy).toBeDefined()
    expect((proxy as unknown as Record<symbol, unknown>)[symbols.original]).not.toBe(proxy)
    expect((childProxy as unknown as Record<symbol, unknown>)[symbols.original]).toBe(
      (proxy as unknown as Record<symbol, unknown>)[symbols.original],
    )

    const initialHealth = proxy.intakeEvaluationHealth()
    expect(initialHealth.enabled).toBe(true)
    expect(initialHealth.registered).toBe(true)
    const initialPolicyVersion = initialHealth.policyVersion!
    expect(initialPolicyVersion).toBeTruthy()

    proxy.assertProfile('remind-1')
    expect(proxy.preauthorizeStatus({ signal: new AbortController().signal, arguments: {} } as never)).toBe(false)

    const evalRes = proxy.evaluate({
      waitId: 'wait-1',
      profileId: 'remind-1',
      scope: { principalId: 'web/a/t/u', principalRecordId: 'rec-1', principalVersion: 1, workspace: '/w', preset: 'primary' },
      goalId: 'goal-1',
      sessionId: 'sess-1',
      definitionDigest: sha256('def'),
      objective: 'Check deadline',
      nativeGoalId: 'ng-1',
      nativeRevision: 1,
      ownerRouteId: 'route-1',
      sourceDigest: sha256('src'),
      sourceId: 'src-1',
      event: { id: 'evt-1', sequence: 1, digest: sha256('evt-1'), occurredAt: 1_700_000_000_000 },
      expiresAt: 1_900_000_000_000,
    })
    expect(evalRes.decision.state).toBe('decided')

    const unsubHook = proxy.registerGoalUnsubscribeHook(() => {})
    expect(childProxy.retireGoalSources({
      scope: { principalId: 'web/a/t/u', principalRecordId: 'rec-1', principalVersion: 1, workspace: '/w', preset: 'primary' },
      goalId: 'goal-1',
      reason: 'completed',
    })).toMatchObject([{ goalId: 'goal-1', sourceId: 'src-1', reason: 'completed', hooksNotified: 1 }])
    unsubHook()

    proxy.closeWait('wait-1', { principalId: 'web/a/t/u', principalRecordId: 'rec-1', principalVersion: 1, workspace: '/w', preset: 'primary' }, 'cancelled')

    const routed = proxy.routeIntakeObservation({
      source: 'lark-channel',
      sourceEventId: 'evt-route-1',
      kind: 'message',
      senderAllowlisted: true,
      addressed: false,
      threadFollowUp: false,
      senderIsBot: false,
      groupMessage: true,
      text: 'hello',
      contentDigest: sha256('hello'),
      occurredAt: 1_700_000_000_000,
    }, { sourcePolicy: { unaddressedGroupMessages: true } })
    expect(routed.disposition).toBe('evaluate-inferred')

    expect(proxy.inspectAttentionQuestions({ scope: { workspace: '/w', preset: 'primary' } })).toEqual([])
    expect(proxy.resolveAttentionQuestion({
      scope: { workspace: '/w', preset: 'primary' },
      questionId: 'q-missing',
      choice: 'decline',
    }).status).toBe('rejected')
    await expect(proxy.reconcilePreparations()).resolves.toBeUndefined()

    expect(proxy.availableProfiles(agent as never)).toHaveLength(1)
    expect(childProxy.inspect(agent as never, 'goal-1').length).toBeGreaterThan(0)
    expect(proxy.inspectDrafts(agent as never)).toEqual([])
    expect(proxy.inspectOpportunities(agent as never)).toHaveLength(1)
    expect(proxy.resolveDraft({ id: 'missing', action: 'reject' })).toBeUndefined()
    expect(() => proxy.feedback(agent as never, 'missing', 'accepted')).toThrow()

    // Evaluation tuning event pushes intakeRuleUpdates live without bumping policyVersion
    expect(listeners.size).toBe(1)
    for (const emit of listeners) {
      emit({
        action: 'tightened',
        intakeRuleUpdates: [
          { ruleId: 'dsh-intake-github-mention-or-review', enabled: false, mode: 'observe', confidenceThresholdPpm: 900_000, minUtility: 20 },
        ],
      })
    }
    expect(proxy.intakeRuleOverrides()).toEqual([
      { ruleId: 'dsh-intake-github-mention-or-review', enabled: false, mode: 'observe', confidenceThresholdPpm: 900_000, minUtility: 20 },
    ])
    expect(proxy.intakeEvaluationHealth().policyVersion).toBe(initialPolicyVersion)

    // Disabled rule is rejected before any LLM call
    await expect(registered!.evaluate({
      candidateId: 'lark-channel:ev-1',
      ruleId: 'dsh-intake-github-mention-or-review',
      policyVersion: initialPolicyVersion,
      sourceText: 'please review PR #42',
      ceiling: 'accept',
      signal: new AbortController().signal,
    })).rejects.toThrow(IntakeEvaluationError)

    // Re-enabling via Proxy restores live rule
    const reenabled = childProxy.applyIntakeRuleUpdates([
      { ruleId: 'dsh-intake-github-mention-or-review', enabled: true, mode: 'auto' },
    ])
    expect(reenabled[0]).toMatchObject({
      ruleId: 'dsh-intake-github-mention-or-review',
      enabled: true,
      mode: 'auto',
      confidenceThresholdPpm: 900_000,
      minUtility: 20,
    })

    // Authoritative `loosening-adopted`, `tightened`, and `rolled-back` on proactive cohorts do NOT wipe intake cohort rules
    for (const sourceId of ['assistant-proactive', 'owner-notification'] as const) {
      for (const action of ['loosening-adopted', 'tightened', 'rolled-back'] as const) {
        for (const emit of listeners) {
          emit({
            action,
            scope: { workspace: '/w', preset: 'primary' },
            cohort: { lane: 'proactive', sourceId },
            version: action === 'rolled-back' ? 0 : 1,
            parameters: { interruptionCostDelta: action === 'tightened' ? 10 : 0 },
          })
        }
        expect(proxy.intakeRuleOverrides()).toHaveLength(1)
      }
    }

    // Authoritative `rolled-back` on intake cohort clears thresholds and removed rules without bumping policyVersion
    for (const emit of listeners) {
      emit({
        action: 'rolled-back',
        scope: { workspace: '/w', preset: 'primary' },
        cohort: { lane: 'intake', sourceId: 'assistant-work-items' },
        version: 0,
        intakeRuleUpdates: [{ ruleId: 'dsh-intake-github-mention-or-review' }],
        parameters: { interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
      })
    }
    expect(proxy.intakeRuleOverrides()).toEqual([])
    expect(proxy.intakeEvaluationHealth().policyVersion).toBe(initialPolicyVersion)

    // Authoritative `loosening-adopted` on intake cohort replaces overrides cleanly (clearing removed rules)
    childProxy.reconcileIntakeRuleUpdates([
      { ruleId: 'dsh-intake-github-mention-or-review', enabled: false, confidenceThresholdPpm: 850_000, minUtility: 12 },
    ])
    expect(proxy.intakeRuleOverrides()).toEqual([
      { ruleId: 'dsh-intake-github-mention-or-review', enabled: false, confidenceThresholdPpm: 850_000, minUtility: 12 },
    ])
    for (const emit of listeners) {
      emit({
        action: 'loosening-adopted',
        scope: { workspace: '/w', preset: 'primary' },
        cohort: { lane: 'intake', sourceId: 'assistant-work-items' },
        version: 2,
        parameters: { interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
      })
    }
    expect(proxy.intakeRuleOverrides()).toEqual([])
    expect(proxy.intakeEvaluationHealth().policyVersion).toBe(initialPolicyVersion)
  })
})
