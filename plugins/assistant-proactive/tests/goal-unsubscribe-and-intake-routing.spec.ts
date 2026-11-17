import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import proactive, {
  Config,
  normalizeProactiveIntakeRouteInput,
  parseTerminalGoalChanged,
  planProactiveIntakeRoute,
  toWorkItemIntakePayload,
  type OpportunityInput,
  type OpportunityProfile,
  type ProactiveGoalUnsubscribeEvent,
} from '../src/index.ts'

const eventTriggersSource = new URL('../../event-triggers/src/index.ts', import.meta.url).href
const workItemsSource = new URL('../../assistant-work-items/src/index.ts', import.meta.url).href

const roots: string[] = []
const contexts: Context[] = []
const fibers: Array<{ dispose(): Promise<void> | void }> = []

afterEach(async () => {
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.restart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

const makeScope = (workspace = '/workspace/proactive', preset = 'primary') => ({
  principalId: 'owner:one',
  principalRecordId: 'record-1',
  principalVersion: 1,
  workspace,
  preset,
})

const coalesceProfile: OpportunityProfile = {
  id: 'coalesced-draft',
  mode: 'prepare',
  expectedBenefit: 20,
  successPpm: 900_000,
  executionCost: 1,
  interruptionCost: 1,
  possibleLoss: 1,
  minimumUtility: 1,
  mergeWindowMs: 60_000,
  cooldownMs: 0,
  rejectionCooldownMs: 60_000,
  maxDecisionsPerGoal: 10,
  maxExecutionsPerGoal: 0,
  maxRemindersPerGoal: 0,
}

function opportunityInput(overrides: Partial<OpportunityInput> = {}): OpportunityInput {
  const scope = overrides.scope ?? makeScope()
  return {
    waitId: 'wait-1',
    profileId: coalesceProfile.id,
    scope,
    goalId: 'goal-1',
    sessionId: 'session-1',
    definitionDigest: 'd'.repeat(64),
    objective: 'Watch CI status',
    nativeGoalId: 'native-1',
    nativeRevision: 2,
    ownerRouteId: 'route-1',
    sourceDigest: 's'.repeat(64),
    sourceId: 'event-triggers:ci',
    event: {
      id: 'evt-1',
      sequence: 1,
      digest: 'e'.repeat(64),
      occurredAt: 1_700_000_000_000,
    },
    expiresAt: Date.now() + 120_000,
    ...overrides,
  }
}

describe('assistant-proactive goal unsubscribe lifecycle & intake routing helpers', () => {
  it('parses terminal goal/changed events and routes intake observations deterministically', () => {
    expect(parseTerminalGoalChanged({
      agent: { session: { id: 'sess-1', header: { cwd: '/repo', agentPreset: 'primary' } } },
      change: { operation: 'complete', ref: { id: 'g-1' }, goal: { id: 'g-1', phase: 'complete' } },
    })).toEqual({
      reason: 'completed',
      nativeGoalId: 'g-1',
      sessionId: 'sess-1',
      workspace: '/repo',
      preset: 'primary',
    })
    expect(parseTerminalGoalChanged({
      agent: { session: { id: 'sess-1' } },
      change: { operation: 'clear', ref: { id: 'g-2' } },
    })).toMatchObject({ reason: 'cancelled', nativeGoalId: 'g-2' })
    expect(parseTerminalGoalChanged({ change: { operation: 'pause', goal: { phase: 'paused' } } })).toBeUndefined()

    const validText = 'nightly run finished'
    const digest = sha256(validText)
    const explicitPlan = planProactiveIntakeRoute({
      source: 'event-triggers',
      sourceEventId: 'ci/1',
      kind: 'event',
      senderIsBot: false,
      explicitlyAddressed: true,
      allowlistedSender: true,
      subscribed: true,
      observationDigest: digest,
      occurredAt: 1_700_000_000_000,
      text: validText,
    })
    expect(explicitPlan).toMatchObject({
      strength: 'explicit',
      strengthReason: 'allowlisted-addressed',
      disposition: 'admit-explicit',
      requiresModelEvaluation: false,
      hasVerifiedText: true,
    })
    expect(Object.keys(explicitPlan.workItemInput).sort()).toEqual([
      'addressed',
      'contentDigest',
      'kind',
      'occurredAt',
      'senderAllowlisted',
      'senderIsBot',
      'source',
      'sourceEventId',
      'subscribed',
      'threadFollowUp',
    ])

    // Bot identity caps explicit signals down to inferred
    const botPlan = planProactiveIntakeRoute({
      source: 'lark-channel',
      sourceEventId: 'bot/1',
      kind: 'message',
      senderIsBot: true,
      explicitlyAddressed: true,
      allowlistedSender: true,
      observationDigest: digest,
      occurredAt: 1_700_000_000_000,
    })
    expect(botPlan).toMatchObject({
      strength: 'inferred',
      strengthReason: 'bot-capped',
      disposition: 'observe-only',
    })

    // Fails closed when required addressing boolean is omitted
    expect(() => planProactiveIntakeRoute({
      source: 'event-triggers',
      sourceEventId: 'ci/missing-flag',
      kind: 'event',
      senderIsBot: false,
      allowlistedSender: true,
      subscribed: true,
      occurredAt: 1_700_000_000_000,
    } as never)).toThrow(/explicitlyAddressed/i)

    // Forged text failing SHA-256 verification is dropped before evaluation routing
    const tamperedPlan = planProactiveIntakeRoute({
      source: 'event-triggers',
      sourceEventId: 'ci/2',
      kind: 'event',
      senderIsBot: false,
      explicitlyAddressed: false,
      allowlistedSender: true,
      subscribed: true,
      observationDigest: digest,
      occurredAt: 1_700_000_000_000,
      text: 'forged-text',
    }, {
      evaluationHealth: {
        enabled: true,
        registered: true,
        policyVersion: 'v1-policy',
      },
    })
    expect(tamperedPlan).toMatchObject({
      strength: 'inferred',
      disposition: 'observe-only',
      requiresModelEvaluation: false,
      hasVerifiedText: false,
    })

    // Verified text + active evaluation readiness promotes inferred event to evaluate-inferred
    const readyPlan = planProactiveIntakeRoute({
      source: 'event-triggers',
      sourceEventId: 'ci/3',
      kind: 'event',
      senderIsBot: false,
      explicitlyAddressed: false,
      allowlistedSender: true,
      subscribed: true,
      observationDigest: digest,
      occurredAt: 1_700_000_000_000,
      text: validText,
    }, {
      evaluationHealth: {
        enabled: true,
        registered: true,
        policyVersion: 'v1-policy',
      },
    })
    expect(readyPlan).toMatchObject({
      disposition: 'evaluate-inferred',
      requiresModelEvaluation: true,
      evaluationPolicyVersion: 'v1-policy',
      hasVerifiedText: true,
    })

    // Unsubscribed events stay filtered unless source policy explicitly allows them
    expect(planProactiveIntakeRoute({
      source: 'event-triggers',
      sourceEventId: 'ci/4',
      kind: 'event',
      senderIsBot: false,
      explicitlyAddressed: false,
      allowlistedSender: true,
      subscribed: false,
      observationDigest: digest,
      occurredAt: 1_700_000_000_000,
    }).disposition).toBe('filtered')
    expect(toWorkItemIntakePayload(normalizeProactiveIntakeRouteInput(readyPlan.workItemInput))).toEqual(readyPlan.workItemInput)
  })

  it('triggers bounded source unsubscribe via closeWait, reactive goal/changed, and retireGoalSources without polling timers', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      const ctx = new Context()
      contexts.push(ctx)
      const unsubscribeCalls: Array<Record<string, unknown>> = []
      ctx.provide('eventTriggers' as never, {
        unsubscribeGoalSources: (input: Record<string, unknown>) => {
          unsubscribeCalls.push(input)
          return input.sourceId === 'event-triggers:ci' ? ['ci'] : []
        },
      } as never)

      let goalPhase: 'paused' | 'complete' | 'cleared' = 'paused'
      const scopeA = makeScope('/workspace/a', 'primary')
      const scopeB = makeScope('/workspace/b', 'primary')
      ctx.provide('assistantGoals' as never, {
        inspectGoalLifecycle: ({ scope, goalId }: { scope: typeof scopeA; goalId: string }) =>
          scope.workspace === scopeA.workspace && goalId === 'goal-1'
            ? Object.freeze({ scope, id: goalId, native: { sessionId: 'sess-1', goalId: 'native-1', revision: 3, phase: goalPhase } })
            : scope.workspace === scopeB.workspace && goalId === 'goal-other'
              ? Object.freeze({ scope, id: goalId, native: { sessionId: 'sess-2', goalId: 'native-1', revision: 1, phase: 'paused' } })
              : undefined,
      } as never)

      await ctx.plugin(proactive, { databasePath: ':memory:', profiles: [coalesceProfile] })
      const service = ctx.assistantProactive

      // Preserves --dump-config / empty Config default shape and routes cleanly without enabled evaluator
      expect(Config({})).toEqual({
        databasePath: expect.any(String),
        intakeEvaluation: { enabled: false, rules: [] },
        profiles: [],
      })
      expect(service.routeIntakeObservation({
        source: 'event-triggers',
        sourceEventId: 'ci/10',
        kind: 'event',
        senderIsBot: false,
        explicitlyAddressed: false,
        allowlistedSender: true,
        subscribed: true,
        observationDigest: sha256('ok'),
        occurredAt: 1_700_000_000_000,
        text: 'ok',
      })).toMatchObject({ disposition: 'observe-only', strength: 'inferred' })

      const hooks: ProactiveGoalUnsubscribeEvent[] = []
      service.registerGoalUnsubscribeHook(event => hooks.push(event))

      service.evaluate(opportunityInput({ waitId: 'wait-round-1', scope: scopeA, goalId: 'goal-1', sessionId: 'sess-1', nativeGoalId: 'native-1', sourceId: 'event-triggers:ci' }))
      service.evaluate(opportunityInput({ waitId: 'wait-other', scope: scopeB, goalId: 'goal-other', sessionId: 'sess-2', nativeGoalId: 'native-1', sourceId: 'event-triggers:ci' }))

      // Multi-round paused goal: closing round-1 wait as 'cancelled' while goal stays 'paused' must NOT unsubscribe sources
      service.closeWait('wait-round-1', scopeA, 'cancelled')
      expect(unsubscribeCalls).toEqual([])
      expect(hooks).toEqual([])

      // Round 2 starts; completing goal reactively via goal/changed closes pending decision and unsubscribes ONLY matching scope/session goal
      service.evaluate(opportunityInput({
        waitId: 'wait-round-2',
        scope: scopeA,
        goalId: 'goal-1',
        sessionId: 'sess-1',
        nativeGoalId: 'native-1',
        sourceId: 'event-triggers:ci',
        event: { id: 'evt-2', sequence: 2, digest: 'f'.repeat(64), occurredAt: 1_700_000_001_000 },
      }))
      goalPhase = 'complete'
      ;(ctx as unknown as { emit(event: string, payload: unknown): void }).emit('goal/changed', {
        agent: { session: { id: 'sess-1', header: { cwd: scopeA.workspace, agentPreset: scopeA.preset } } },
        change: { operation: 'complete', ref: { id: 'native-1' }, goal: { id: 'native-1', phase: 'complete' } },
      })

      await vi.waitFor(() => expect(hooks).toHaveLength(1))
      expect(hooks[0]).toMatchObject({ goalId: 'goal-1', sourceId: 'event-triggers:ci', reason: 'completed' })
      expect(unsubscribeCalls).toHaveLength(1)
      expect(unsubscribeCalls[0]).toMatchObject({ scope: scopeA, goalId: 'goal-1', reason: 'completed', sourceId: 'event-triggers:ci' })

      // Duplicate retireGoalSources for the exact same link/reason deduplicates hook notifications
      const repeat = service.retireGoalSources({ scope: scopeA, goalId: 'goal-1', reason: 'completed' })
      expect(repeat).toHaveLength(1)
      expect(repeat[0]?.hooksNotified).toBe(0)

      // Unrelated session's pending wait remains untouched until closed with 'expired'
      service.closeWait('wait-other', scopeB, 'expired')
      expect(hooks).toHaveLength(2)
      expect(hooks[1]).toMatchObject({ goalId: 'goal-other', waitId: 'wait-other', reason: 'expired' })

      // Zero polling timers created by assistant-proactive
      expect(intervalSpy).not.toHaveBeenCalled()
    } finally {
      intervalSpy.mockRestore()
    }
  })

  it('bridges real EventTriggersService + AssistantProactiveService + AssistantWorkItemsService end-to-end across goal completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proactive-events-e2e-'))
    roots.push(root)
    const goalFile = join(root, 'goal.txt')
    const sharedFile = join(root, 'shared.txt')
    await writeFile(goalFile, 'v1')
    await writeFile(sharedFile, 'v1')

    const ctx = new Context()
    contexts.push(ctx)
    const scope = makeScope(root, 'primary')
    const owner = {
      ...scope,
      ownerRouteId: 'route-e2e',
      expiresAt: Date.now() + 120_000,
      budgetId: 'obs-budget',
    }
    let goal = {
      scope,
      id: 'goal-e2e',
      definition: { version: 1, digest: 'c'.repeat(64) },
      native: { sessionId: 'sess-e2e', goalId: 'native-e2e', revision: 1, phase: 'paused' },
    }
    ctx.provide('tools' as never, { register: () => () => {} } as never)
    ctx.provide('agents' as never, { get: () => undefined } as never)
    ctx.provide('assistantDelivery' as never, {
      validateOwnerRoute: () => Object.freeze({
        authorityId: 'route-e2e',
        authorityHash: 'a'.repeat(64),
        receiptVersion: 2 as const,
        principalId: scope.principalId,
        principalRecordId: scope.principalRecordId,
        principalVersion: scope.principalVersion,
        workspace: root,
        agentPreset: scope.preset,
        bindingVersion: 1,
        generation: 1,
      }),
      enqueueOwnerNotification: () => undefined,
    } as never)
    ctx.provide('assistantGoals' as never, {
      inspectGoalLifecycle: ({ scope: reqScope, goalId }: { scope: typeof scope; goalId: string }) =>
        reqScope.workspace === root && goalId === goal.id ? Object.freeze({ ...goal }) : undefined,
    } as never)

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [{ id: 'obs-budget', metric: 'requests', limit: 100, periodMs: 60_000, scope: 'subject' }],
      rules: [
        { id: 'obs-reconcile', effect: 'allow', subject: { kind: 'background', id: 'event-triggers-observer/v1', workspace: root, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
        { id: 'goal-file-obs', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:goal-file', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'filesystem', id: '*' }, context: { initiators: ['background'] }, budget: { id: 'obs-budget', amount: 1 } },
        { id: 'shared-file-obs', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:shared-file', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'filesystem', id: '*' }, context: { initiators: ['background'] }, budget: { id: 'obs-budget', amount: 1 } },
        { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: '*', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } },
      ],
    })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'),
      schedulerEnabled: false,
      reconcileIntervalMs: 0,
      allowUnbudgetedExecution: true,
    })

    const workItemsMod = await import(workItemsSource) as { AssistantWorkItemsService: new (...args: never[]) => unknown }
    const wiFiber = await ctx.plugin(workItemsMod.AssistantWorkItemsService as never, {
      enabled: true,
      mode: 'observe',
      databasePath: join(root, 'work-items.sqlite'),
      workRoot: join(root, 'work-root'),
      intakeLedger: { enabled: true, evaluation: { enabled: false } },
    } as never)
    fibers.push(wiFiber as unknown as { dispose(): Promise<void> | void })

    const llmStub = {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as unknown as LlmRuntime
    ctx.provide('llm' as never, llmStub as never)

    const proactiveFiber = await ctx.plugin(proactive, {
      databasePath: join(root, 'proactive.sqlite'),
      profiles: [coalesceProfile],
    })
    fibers.push(proactiveFiber as unknown as { dispose(): Promise<void> | void })

    const eventsMod = await import(eventTriggersSource) as {
      default: unknown
      EventTriggersService: unknown
    }
    const eventsFiber = await ctx.plugin(eventsMod.default as never, {
      databasePath: join(root, 'events.sqlite'),
      allowedFileRoots: [root],
      pollerEnabled: false,
      triggers: [
        {
          id: 'goal-file',
          kind: 'file',
          automationId: 'auto-goal',
          path: goalFile,
          debounceMs: 0,
          cooldownMs: 0,
          observerLifetime: 'goal',
          observer: owner,
          intake: { enabled: true, summaryLabel: 'goal-watch' },
        },
        {
          id: 'shared-file',
          kind: 'file',
          automationId: 'auto-shared',
          path: sharedFile,
          debounceMs: 0,
          cooldownMs: 0,
          observerLifetime: 'shared',
          observer: owner,
          intake: { enabled: true, summaryLabel: 'shared-watch' },
        },
      ],
    } as never)
    fibers.push(eventsFiber as unknown as { dispose(): Promise<void> | void })

    const eventService = ctx.get('eventTriggers' as never) as unknown as {
      pollOnce(): Promise<void>
      sourceSnapshot(triggerId: string): { sourceId: string; configDigest: string }
      firstEventAfter(snapshot: unknown, seq: number, deadline: number): { sequence: number; envelope: { event: { id: string; occurredAt: number }; observation: { digest: string } } } | undefined
      claimGoalSource(input: unknown): boolean
      isRetiredGoalSource(triggerId: string): boolean
    }
    const workItems = ctx.get('assistantWorkItems' as never) as unknown as {
      inspectIntakeQueue(options?: { limit?: number }): { intakeCounts: { stored: number; duplicate: number; filtered: number } }
    }

    const goalSnap = eventService.sourceSnapshot('goal-file')
    eventService.claimGoalSource({
      triggerId: 'goal-file',
      scope,
      goalId: goal.id,
      definition: goal.definition,
      native: { sessionId: goal.native.sessionId, goalId: goal.native.goalId, revision: goal.native.revision },
      configDigest: goalSnap.configDigest,
      automationId: 'auto-goal',
    })

    // Baseline poll + changed file update
    await eventService.pollOnce()
    await writeFile(goalFile, 'v2-changed')
    await eventService.pollOnce()

    const first = eventService.firstEventAfter(goalSnap, 0, Date.now() + 5_000)
    expect(first).toBeDefined()
    expect(workItems.inspectIntakeQueue().intakeCounts.stored).toBe(1)
    const wiDb = new DatabaseSync(join(root, 'work-items.sqlite'), { readOnly: true })
    try {
      expect((wiDb.prepare("SELECT count(*) AS n FROM work_item_intake WHERE source = 'event-triggers'").get() as { n: number }).n).toBe(1)
      expect((wiDb.prepare('SELECT count(*) AS n FROM work_item').get() as { n: number }).n).toBe(0)
    } finally {
      wiDb.close()
    }

    const evalResult = ctx.assistantProactive.evaluate({
      waitId: 'wait-e2e',
      profileId: coalesceProfile.id,
      scope,
      goalId: goal.id,
      sessionId: goal.native.sessionId,
      definitionDigest: goal.definition.digest,
      objective: 'Observe goal file change',
      nativeGoalId: goal.native.goalId,
      nativeRevision: goal.native.revision,
      ownerRouteId: 'route-e2e',
      sourceDigest: goalSnap.configDigest,
      sourceId: goalSnap.sourceId,
      event: {
        id: first!.envelope.event.id,
        sequence: first!.sequence,
        digest: sha256(first!.envelope.event.id),
        occurredAt: first!.envelope.event.occurredAt,
        observationDigest: first!.envelope.observation.digest,
      },
      expiresAt: Date.now() + 120_000,
    })
    expect(evalResult.disposition).toBe('defer')

    const hookEvents: ProactiveGoalUnsubscribeEvent[] = []
    ctx.assistantProactive.registerGoalUnsubscribeHook(event => hookEvents.push(event))

    // Terminal goal completion event detaches ONLY goal-file, closes proactive wait decision, and leaves shared-file active
    goal = { ...goal, native: { ...goal.native, revision: 2, phase: 'complete' } }
    ;(ctx as unknown as { emit(event: string, payload: unknown): void }).emit('goal/changed', {
      agent: { session: { id: goal.native.sessionId, header: { cwd: root, agentPreset: scope.preset } } },
      change: { operation: 'complete', ref: { id: goal.native.goalId }, goal: { id: goal.native.goalId, phase: 'complete' } },
    })

    await vi.waitFor(() => expect(hookEvents).toHaveLength(1))
    await flush()
    expect(hookEvents[0]).toMatchObject({
      goalId: 'goal-e2e',
      sourceId: 'event-triggers:goal-file',
      reason: 'completed',
    })
    expect(eventService.isRetiredGoalSource('goal-file')).toBe(true)
    expect(eventService.isRetiredGoalSource('shared-file')).toBe(false)
    expect(ctx.assistantAutomations.inspectSystemOwned({ owner: 'event-triggers-observer/v1', automationId: 'auto-goal' }))
      .toMatchObject({ automationStatus: 'paused' })
    expect(ctx.assistantAutomations.inspectSystemOwned({ owner: 'event-triggers-observer/v1', automationId: 'auto-shared' }))
      .toMatchObject({ automationStatus: 'active' })
  })
})
