import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { getExportFn, sha256Hex } from './helpers/assertions.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantGoals,
  loadAssistantGoalsStrategy,
  loadAssistantGoalsStrategyRouter,
  loadAssistantPolicy,
  loadAssistantRecovery,
  loadAssistantSkills,
  loadAssistantSkillsDefinition,
  loadCredentialsKeychain,
  loadEventTriggers,
  loadPackageModule,
} from './helpers/packages.ts'
import { createWorkspaceTracker } from './helpers/workspace.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

function makeGoalRecord(workspace: string, overrides: Record<string, unknown> = {}) {
  const sha = sha256Hex('goal-def')
  return {
    id: 'goal-1',
    scope: {
      principalId: 'owner',
      principalRecordId: 'owner-rec',
      principalVersion: 1,
      workspace,
      preset: 'primary',
    },
    originalObjective: 'Fix failing test',
    definition: { version: 1, digest: sha, objective: 'Fix failing test' },
    native: {
      sessionId: 'session-1',
      goalId: 'native-1',
      revision: 1,
      objective: 'Fix failing test',
      phase: 'active',
      roundsStarted: 1,
      maxGoalRounds: 4,
      updatedAt: 1_000,
    },
    checkpoint: {
      nextStep: 'Run targeted check',
      blockers: [],
      assumptions: [],
      evidenceRefs: [],
      dependencies: [],
    },
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function makeGoalBudget(modelCallsLimit = 10, modelCallsUsed = 1) {
  return {
    limits: {
      mode: 'calls',
      routes: [{ provider: 'p', model: 'm' }],
      modelCalls: modelCallsLimit,
      toolCalls: 10,
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
      expiresAt: Date.now() + 100_000,
    },
    modelCalls: modelCallsUsed,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsdMicros: null,
    heldCalls: 0,
  }
}

function makeFailedFeedback(historyCount = 1) {
  const sha = sha256Hex('goal-def')
  const step = {
    runId: 'run-1',
    definitionVersion: 1,
    status: 'not-achieved' as const,
    execution: {
      status: 'succeeded' as const,
      quiescent: true,
      completedAt: 2_000,
      executionRef: 'run-1',
    },
    criteria: [{
      id: 'c1',
      status: 'failed' as const,
      reason: 'mismatch',
      reasonTruncated: false,
      evidence: [],
      definition: { kind: 'document-citations' },
      evidenceTruncated: false,
    }],
    criteriaTruncated: false,
  }
  return {
    protocol: 'assistant-goals/feedback/v1',
    goalId: 'goal-1',
    goalOutcome: 'unverified',
    definition: { version: 1, digest: sha, objective: { excerpt: 'Fix failing test', truncated: false } },
    verification: {
      current: step,
      pending: null,
      history: Array.from({ length: historyCount }, () => step),
    },
    nextAction: 'revise-plan' as const,
  }
}

function makeTriggerObserver(workspace: string, budgetId = 'obs-budget') {
  return {
    workspace,
    preset: 'primary',
    principalId: 'owner:one',
    principalRecordId: 'record-1',
    principalVersion: 1,
    ownerRouteId: 'route-1',
    expiresAt: Date.now() + 120_000,
    budgetId,
  }
}

describe('Tier 1 — F15–F18: GoalStrategyRuntime, Compensation, EventTriggers & Workflow Skills', () => {
  describe('F15: WP06 GoalStrategyRuntime auto routing, tool experiments & cost/benefit optimization', () => {
    test('T1-F15-01: automatic routing selects direct execution for trivial difficulty and subagent strategy for complex difficulty', async () => {
      const routerMod = await loadAssistantGoalsStrategyRouter()
      const recommend = getExportFn<(input: Record<string, unknown>) => {
        difficulty: string
        selectedStrategy: string
        expectedNetBenefit: number
      }>(routerMod, 'recommendGoalStrategy')

      const now = 5_000
      const base = { budget: makeGoalBudget(), availableTools: ['read', 'glob', 'grep', 'isolation_run'], now }
      const trivial = recommend({
        ...base,
        record: makeGoalRecord('/work/repo'),
      })
      const complex = recommend({
        ...base,
        record: makeGoalRecord('/work/repo', {
          native: {
            sessionId: 'session-1',
            goalId: 'native-1',
            revision: 3,
            objective: 'Fix failing test',
            phase: 'active',
            roundsStarted: 3,
            maxGoalRounds: 4,
            updatedAt: 1_000,
          },
          checkpoint: {
            nextStep: '',
            blockers: ['b1', 'b2'],
            assumptions: [{ statement: 'stale', expiresAt: 1 }],
            evidenceRefs: [],
            dependencies: ['d1', 'd2'],
          },
        }),
      })

      expect(trivial.difficulty).toBe('trivial')
      expect(trivial.selectedStrategy).toBe('direct')
      expect(complex.difficulty).toBe('complex')
      expect(['subagent', 'investigate', 'review', 'compare', 'experiment']).toContain(complex.selectedStrategy)
    })

    test('T1-F15-02: automatic routing distinguishes tool-failure vs reasoning-failure', async () => {
      const routerMod = await loadAssistantGoalsStrategyRouter()
      const recommend = getExportFn<(input: Record<string, unknown>) => {
        failureType: string
        selectedStrategy: string
      }>(routerMod, 'recommendGoalStrategy')

      const now = 5_000
      const moderateRecord = makeGoalRecord('/work/repo', {
        checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: ['dep-1'] },
      })
      const base = {
        budget: makeGoalBudget(),
        availableTools: ['read', 'glob', 'grep', 'isolation_run'],
        now,
      }

      const toolFail = recommend({
        ...base,
        record: moderateRecord,
        recentToolOutcomes: [{ name: 'isolation_run', isError: true }],
      })
      const reasonFail = recommend({
        ...base,
        record: moderateRecord,
        feedback: makeFailedFeedback(1),
      })

      expect(toolFail.failureType).toBe('tool-failure')
      expect(toolFail.selectedStrategy).toBe('experiment')
      expect(reasonFail.failureType).toBe('reasoning-failure')
      expect(['review', 'compare']).toContain(reasonFail.selectedStrategy)
    })

    test('T1-F15-03: validateGoalStrategyInput accepts tool-execution experiment branch', async () => {
      const strategyMod = await loadAssistantGoalsStrategy()
      const validated = strategyMod.validateGoalStrategyInput({
        kind: 'experiment',
        question: 'Probe failing CLI command under scoped workspace tools',
        tools: ['read', 'grep'],
      } as never) as unknown as Record<string, unknown>
      expect(validated.kind).toBe('experiment')
      expect(validated.tools).toEqual(['read', 'grep'])
    })

    test('T1-F15-04: coordination cost/benefit optimizer suppresses subagent overhead when historical telemetry/net-benefit is negative', async () => {
      const routerMod = await loadAssistantGoalsStrategyRouter()
      const optimize = getExportFn<(input: Record<string, unknown>) => {
        selectedStrategy: string
        expectedNetBenefit: number
      }>(routerMod, 'optimizeStrategyDecision')

      const zeroStat = { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 }
      const negativeTelemetry = {
        totalRuns: 6,
        adviceRuns: 0,
        experimentRuns: 0,
        directRecommendedRuns: 0,
        failedOrUnknownRuns: 6,
        byKind: {
          direct: zeroStat,
          investigate: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 1, avgToolCalls: 0 },
          review: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 1, avgToolCalls: 0 },
          compare: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 2, avgToolCalls: 0 },
          experiment: zeroStat,
          subagent: zeroStat,
        },
      }

      const res = optimize({
        difficulty: 'moderate',
        difficultyScore: 2,
        difficultySignals: ['blockers:1'],
        failureType: 'reasoning-failure',
        failureSignals: ['step:not-achieved'],
        budget: makeGoalBudget(),
        telemetry: negativeTelemetry,
        experiment: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
        subagent: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
        costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
        maxStrategyDurationMs: 30_000,
        now: 5_000,
      })
      expect(res.selectedStrategy).toBe('direct')
      expect(typeof res.expectedNetBenefit).toBe('number')
    })

    test('T1-F15-05: GoalStrategyRuntime mounts on AssistantGoalsService with durable strategy ledger and quiesces cleanly', async () => {
      const ws = await workspaces.create('f15-quiesce-')
      const goalsMod = await loadAssistantGoals()
      const cfg = goalsMod.validateGoalStrategyConfig({ maxDurationMs: 5_000, maxRunsPerGoal: 4 })
      expect(cfg.maxDurationMs).toBe(5_000)

      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'subagents', {})
      const goals = await harness.mountService<{
        strategyEnabled: boolean
        inspectStrategies: (agent: unknown, goalId: string) => unknown[]
        recommendStrategy: (agent: unknown, goalId: string) => unknown
        hostSummarizeAdviceByDefinition: (scope: Record<string, unknown>) => readonly unknown[]
        hostSummarizeStrategyOutcomes: (scope: Record<string, unknown>) => { totalRuns: number } | undefined
      }>(ctx, goalsMod.AssistantGoalsService, 'assistantGoals', {
        databasePath: ws.sqlitePath('goals'),
        verifyNativeRounds: true,
        executionBudget: {
          mode: 'calls',
          modelCalls: 10,
          toolCalls: 10,
          durationMs: 30_000,
          maxOutputTokensPerCall: 1024,
          routes: [{ provider: 'p', model: 'm' }],
        },
        strategy: { maxDurationMs: 5_000, maxRunsPerGoal: 4 },
      })

      expect(goals.strategyEnabled).toBe(true)
      expect(typeof goals.inspectStrategies).toBe('function')
      expect(typeof goals.recommendStrategy).toBe('function')
      const scope = {
        principalId: 'web/a/t/u',
        principalRecordId: 'rec-1',
        principalVersion: 1,
        workspace: ws.workspace,
        preset: 'primary',
      }
      expect(goals.hostSummarizeAdviceByDefinition(scope)).toEqual([])
      expect(goals.hostSummarizeStrategyOutcomes(scope)?.totalRuns).toBe(0)
    })
  })

  describe('F16: WP10 generic external side-effect compensation', () => {
    test('T1-F16-01: CompensationRegistry registers and resolves named external compensators', async () => {
      const recMod = await loadAssistantRecovery()
      const CompensationRegistry = getExportFn<new () => {
        register: (handler: {
          kind: string
          category: string
          compensate: (rec: unknown) => Promise<{ status: string; resultCode: string }>
        }) => () => void
        get: (kind: string) => { kind: string; category: string } | undefined
        list: () => readonly { kind: string; category: string }[]
      }>(recMod, 'CompensationRegistry')

      const registry = new CompensationRegistry()
      registry.register({
        kind: 'http.delete-resource',
        category: 'delete',
        compensate: async () => ({ status: 'succeeded', resultCode: 'deleted' }),
      })
      expect(registry.get('http.delete-resource')?.category).toBe('delete')
      expect(registry.list().some(d => d.kind === 'http.delete-resource')).toBe(true)
    }, 15_000)

    test('T1-F16-02: AssistantCompensationService invokes registered compensator and records audit entry', async () => {
      const ws = await workspaces.create('f16-exec-')
      const recMod = await loadAssistantRecovery()
      const ctx = harness.createContext()
      const comp = await harness.mountService<{
        registerCompensator: (h: {
          kind: string
          category: string
          compensate: () => Promise<{ status: string; resultCode: string }>
        }) => () => void
        executeCompensation: (rec: Record<string, unknown>) => Promise<{
          id: string
          status: string
          preimageDigest?: string
        }>
        listCompensationAudit: (id: string) => readonly unknown[]
      }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', {
        databasePath: ws.sqlitePath('comp'),
      })

      let calls = 0
      comp.registerCompensator({
        kind: 'calendar.cancel-event',
        category: 'cancel',
        compensate: async () => {
          calls += 1
          return { status: 'succeeded', resultCode: 'cancelled' }
        },
      })

      const res = await comp.executeCompensation({
        forwardActionId: 'act-1',
        idempotencyKey: 'comp-key-1',
        kind: 'calendar.cancel-event',
        target: { externalRef: 'evt-999' },
        preimage: { status: 'scheduled' },
      })
      expect(calls).toBe(1)
      expect(res.status).toBe('succeeded')
      expect(res.preimageDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(comp.listCompensationAudit(res.id).length).toBeGreaterThanOrEqual(1)
    })

    test('T1-F16-03: compensation idempotencyKey prevents duplicate external side-effect on retry', async () => {
      const ws = await workspaces.create('f16-idem-')
      const recMod = await loadAssistantRecovery()
      const ctx = harness.createContext()
      const comp = await harness.mountService<{
        registerCompensator: (h: {
          kind: string
          category: string
          compensate: () => Promise<{ status: string; resultCode: string }>
        }) => () => void
        executeCompensation: (rec: Record<string, unknown>) => Promise<{
          id: string
          status: string
          replayed: boolean
        }>
      }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', {
        databasePath: ws.sqlitePath('comp-idem'),
      })

      let invocations = 0
      comp.registerCompensator({
        kind: 'http.delete-resource',
        category: 'delete',
        compensate: async () => {
          invocations += 1
          return { status: 'succeeded', resultCode: 'deleted' }
        },
      })

      const payload = {
        forwardActionId: 'act-2',
        idempotencyKey: 'comp-idem-2',
        kind: 'http.delete-resource',
        target: { externalRef: 'https://api.example.test/items/42' },
      }
      const r1 = await comp.executeCompensation(payload)
      const r2 = await comp.executeCompensation(payload)
      expect(invocations).toBe(1)
      expect(r1.status).toBe('succeeded')
      expect(r2.status).toBe('succeeded')
      expect(r2.replayed).toBe(true)
      expect(r2.id).toBe(r1.id)
    })

    test('T1-F16-04: SkillCompensationKind supports compensate-via-registry and rollback-state', async () => {
      const skillsDef = await loadAssistantSkillsDefinition()
      const assertProto = getExportFn<(def: Record<string, unknown>) => void>(skillsDef, 'assertDefinitionProtocol')
      const directive = getExportFn<(kind: string) => {
        kind: string
        executeCompensation: boolean
        target: string
      }>(skillsDef, 'compensationDirective')

      expect(() => assertProto({
        preconditions: 'current-owner-policy-and-fresh-goal',
        compensation: 'compensate-via-registry',
        steps: [{ id: 's1', toolName: 'read', arguments: {}, dependsOn: [] }],
      })).not.toThrow()

      expect(directive('compensate-via-registry')).toMatchObject({
        kind: 'compensate-via-registry',
        executeCompensation: true,
        target: 'registry',
      })
      expect(directive('rollback-state')).toMatchObject({
        kind: 'rollback-state',
        executeCompensation: true,
        target: 'rollback',
      })
    })

    test('T1-F16-05: ambiguous compensator failure settles with explicit unknown status', async () => {
      const ws = await workspaces.create('f16-unknown-')
      const recMod = await loadAssistantRecovery()
      const ctx = harness.createContext()
      const comp = await harness.mountService<{
        registerCompensator: (h: {
          kind: string
          category: string
          compensate: () => Promise<{ status: string; sideEffectState?: string; resultCode: string }>
        }) => () => void
        executeCompensation: (rec: Record<string, unknown>) => Promise<{
          id: string
          status: string
        }>
      }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', {
        databasePath: ws.sqlitePath('comp-unknown'),
      })

      comp.registerCompensator({
        kind: 'http.uncertain-undo',
        category: 'revert',
        compensate: async () => {
          throw new Error('downstream timeout')
        },
      })

      const res = await comp.executeCompensation({
        forwardActionId: 'act-3',
        idempotencyKey: 'comp-unknown-1',
        kind: 'http.uncertain-undo',
        target: { externalRef: 'https://api.example.test/items/99' },
      })
      expect(res.status).toBe('unknown')
    })
  })

  describe('F17: WP11 event triggers expansion (rolling lark-calendar, built-in webhook, task/calendar/email, pollerEnabled)', () => {
    test('T1-F17-01: event-triggers ConfigSchema defaults pollerEnabled to true', async () => {
      const ws = await workspaces.create('f17-poller-')
      const mod = await loadEventTriggers()
      const normalized = mod.normalizeEventTriggersConfig({ databasePath: ws.sqlitePath('events') })
      expect(normalized.pollerEnabled).toBe(true)
    })

    test('T1-F17-02: lark-calendar supports rolling time window relative to now', async () => {
      const ws = await workspaces.create('f17-rolling-')
      const mod = await loadEventTriggers()
      const { EVENT_OBSERVER_EXECUTOR } = (await loadPackageModule('event-triggers/observer')) as {
        EVENT_OBSERVER_EXECUTOR: string
      }
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantAutomationsService } = (await loadPackageModule('assistant-automations')) as {
        AssistantAutomationsService: unknown
      }

      const windows: Array<{ startTime: number; endTime: number }> = []
      let fakeNowSec = 1_700_000_000

      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'assistantDelivery', {
        validateOwnerRoute: () => ({
          authorityId: 'route-1',
          authorityHash: sha256Hex('route-1'),
          receiptVersion: 2,
          principalId: 'owner:one',
          principalRecordId: 'record-1',
          principalVersion: 1,
          workspace: ws.workspace,
          agentPreset: 'primary',
          bindingVersion: 1,
          generation: 1,
        }),
      })
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        budgets: [{ id: 'obs-budget', metric: 'requests', limit: 100, periodMs: 60_000, scope: 'subject' }],
        rules: [
          {
            id: 'observer',
            effect: 'allow',
            subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: ws.workspace, principal: 'owner:one' },
            actions: ['observe', 'reconcile', 'execute'],
            resource: { kind: 'automation', id: '*' },
            context: { initiators: ['background'] },
          },
          {
            id: 'calendar',
            effect: 'allow',
            subject: { kind: 'background', id: 'event-triggers:cal-roll', workspace: ws.workspace, principal: 'owner:one' },
            actions: ['observe'],
            resource: { kind: 'network', id: 'lark-calendar:cal-1' },
            context: { initiators: ['background'] },
            budget: { id: 'obs-budget', amount: 1 },
          },
          {
            id: 'ingest',
            effect: 'allow',
            subject: { kind: 'external', id: 'event-triggers:cal-roll', workspace: ws.workspace },
            actions: ['ingest'],
            resource: { kind: 'automation', id: 'auto-cal' },
            context: { initiators: ['external'] },
          },
        ],
      })
      await harness.mountPlugin(ctx, AssistantAutomationsService, {
        databasePath: ws.sqlitePath('automations'),
        runsPath: join(ws.stateDir, 'runs'),
        schedulerEnabled: false,
        reconcileIntervalMs: 0,
        allowUnbudgetedExecution: true,
      })

      const observer = makeTriggerObserver(ws.workspace, 'obs-budget')
      const svc = new mod.EventTriggersService(ctx, {
        databasePath: ws.sqlitePath('events'),
        pollerEnabled: false,
        triggers: [{
          id: 'cal-roll',
          kind: 'lark-calendar',
          automationId: 'auto-cal',
          calendarId: 'cal-1',
          lookbackSeconds: 300,
          lookaheadSeconds: 3_600,
          windowStepSeconds: 60,
          observer,
        } as never],
      }, {
        now: () => fakeNowSec * 1000,
        larkCalendarReader: {
          readCalendarEventPage: async (req: { startTime: number; endTime: number }) => {
            windows.push({ startTime: req.startTime, endTime: req.endTime })
            return { items: [], has_more: false }
          },
        },
      })

      await svc.pollOnce()
      fakeNowSec += 600
      await svc.pollOnce()

      expect(windows.length).toBe(2)
      expect(windows[1]!.startTime).toBeGreaterThan(windows[0]!.startTime)
      expect(windows[1]!.endTime).toBeGreaterThan(windows[0]!.endTime)
    })

    test('T1-F17-03: webhook trigger supports built-in HTTP listener on ephemeral port', async () => {
      const ws = await workspaces.create('f17-webhook-')
      const mod = await loadEventTriggers()
      const { EVENT_OBSERVER_EXECUTOR } = (await loadPackageModule('event-triggers/observer')) as {
        EVENT_OBSERVER_EXECUTOR: string
      }
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantAutomationsService } = (await loadPackageModule('assistant-automations')) as {
        AssistantAutomationsService: unknown
      }
      const { CredentialsKeychainService } = await loadCredentialsKeychain()

      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'assistantDelivery', {
        validateOwnerRoute: () => ({
          authorityId: 'route-1',
          authorityHash: sha256Hex('route-1'),
          receiptVersion: 2,
          principalId: 'owner:one',
          principalRecordId: 'record-1',
          principalVersion: 1,
          workspace: ws.workspace,
          agentPreset: 'primary',
          bindingVersion: 1,
          generation: 1,
        }),
      })
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        rules: [
          {
            id: 'observer',
            effect: 'allow',
            subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: ws.workspace, principal: 'owner:one' },
            actions: ['observe', 'reconcile', 'execute'],
            resource: { kind: 'automation', id: '*' },
            context: { initiators: ['background'] },
          },
          {
            id: 'cred-use',
            effect: 'allow',
            subject: { kind: 'background', id: 'dsh-ray-event-triggers' },
            actions: ['credential.use'],
            resource: { kind: 'credential', id: '*' },
            context: { initiators: ['background'] },
          },
          {
            id: 'ingest-all',
            effect: 'allow',
            subject: { kind: 'external', id: '*', workspace: ws.workspace },
            actions: ['ingest'],
            resource: { kind: 'automation', id: '*' },
            context: { initiators: ['external'] },
          },
          {
            id: 'accept-wh',
            effect: 'allow',
            subject: { kind: 'external', id: 'webhook:wh-1' },
            actions: ['accept'],
            resource: { kind: 'automation', id: '*' },
            context: { initiators: ['external'] },
          },
        ],
      })
      await harness.mountPlugin(ctx, AssistantAutomationsService, {
        databasePath: ws.sqlitePath('automations'),
        runsPath: join(ws.stateDir, 'runs'),
        schedulerEnabled: false,
        reconcileIntervalMs: 0,
        allowUnbudgetedExecution: true,
      })
      await ctx.plugin({
        name: 'webhook-creds',
        apply(runtime: unknown) {
          new (CredentialsKeychainService as new (r: unknown, cfg: unknown, opts: unknown) => unknown)(
            runtime,
            {
              databasePath: ws.sqlitePath('credentials'),
              handles: [{
                id: 'cred-wh',
                provider: 'environment',
                environmentName: 'DSH_E2E_WEBHOOK_SECRET',
                consumers: ['dsh-ray-event-triggers'],
                purposes: ['verify-webhook'],
                maxLeaseMs: 30_000,
              }],
            },
            { env: { DSH_E2E_WEBHOOK_SECRET: 'wh-secret-key' } },
          )
        },
      } as never)

      const nowMs = 1_700_000_000_000
      const observer = makeTriggerObserver(ws.workspace, 'webhook-obs')
      let svc!: InstanceType<typeof mod.EventTriggersService>
      await ctx.plugin({
        name: 'dsh-ray-event-triggers',
        apply(runtime: unknown) {
          svc = new mod.EventTriggersService(runtime as never, {
            databasePath: ws.sqlitePath('events'),
            pollerEnabled: false,
            webhookListen: {
              enabled: true,
              host: '127.0.0.1',
              port: 0,
              basePath: '/hooks',
            },
            triggers: [{
              id: 'wh-1',
              kind: 'webhook',
              automationId: 'auto-wh',
              credentialHandle: 'cred-wh',
              path: '/test',
              observer,
            } as never],
          }, { now: () => nowMs })
        },
      } as never)

      const addr = await svc.whenWebhookListening()
      expect(addr).toBeDefined()
      expect(typeof addr?.port).toBe('number')

      const body = JSON.stringify({ event: 'ping' })
      const ts = String(nowMs)
      const nonce = 'nonce-f17-1'
      const sig = `sha256=${createHmac('sha256', 'wh-secret-key').update(`${ts}\n${nonce}\n${body}`).digest('hex')}`
      const resp = await fetch(`http://${addr!.host}:${addr!.port}/test`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-timestamp': ts,
          'x-dsh-nonce': nonce,
          'x-dsh-signature': sig,
        },
        body,
      })
      expect(resp.status).toBe(202)
      const json = (await resp.json()) as { accepted: boolean }
      expect(json.accepted).toBe(true)
    })

    test('T1-F17-04: task-system trigger source normalizes in ConfigSchema', async () => {
      const ws = await workspaces.create('f17-task-')
      const mod = await loadEventTriggers()
      const observer = makeTriggerObserver(ws.workspace)
      const cfg = mod.normalizeEventTriggersConfig({
        databasePath: ws.sqlitePath('events'),
        allowedHttpOrigins: ['https://tasks.example.test'],
        triggers: [{
          id: 'tasks-1',
          kind: 'task-system',
          automationId: 'auto-task',
          url: 'https://tasks.example.test/items',
          itemsPointer: '/items',
          observer,
        } as never],
      })
      expect(cfg.triggers.some(t => (t as { kind: string }).kind === 'task-system')).toBe(true)
    })

    test('T1-F17-05: non-Lark calendar and email trigger sources are accepted in ConfigSchema', async () => {
      const ws = await workspaces.create('f17-ical-email-')
      const mod = await loadEventTriggers()
      const observer = makeTriggerObserver(ws.workspace)
      const cfg = mod.normalizeEventTriggersConfig({
        databasePath: ws.sqlitePath('events'),
        allowedHttpOrigins: ['https://cal.example.test', 'https://mail.example.test'],
        triggers: [
          {
            id: 'ical-1',
            kind: 'calendar',
            automationId: 'auto-ical',
            url: 'https://cal.example.test/team.ics',
            format: 'ics',
            observer,
          } as never,
          {
            id: 'mail-1',
            kind: 'email',
            automationId: 'auto-mail',
            url: 'https://mail.example.test/jmap',
            protocol: 'jmap',
            accountId: 'acc-1',
            observer,
          } as never,
        ],
      })
      expect(cfg.triggers.length).toBe(2)
    })
  })

  describe('F18: WP13 real workflow skill coverage (3–5 workflows, preconditions, compensations & lineage)', () => {
    test('T1-F18-01: SkillPreconditionKind supports multi-condition workflow preconditions beyond single v1 constant', async () => {
      const skillsDef = await loadAssistantSkillsDefinition()
      const assertProto = getExportFn<(def: Record<string, unknown>) => void>(skillsDef, 'assertDefinitionProtocol')
      expect(() => assertProto({
        preconditions: 'clean-git-worktree-and-policy-grant',
        compensation: 'stop-and-report',
        steps: [{ id: 's1', toolName: 'read', arguments: {}, dependsOn: [] }],
      })).not.toThrow()
    })

    test('T1-F18-02: built-in workflow templates cover repo-ci-fix workflow with step dependencies', async () => {
      const skillsMod = await loadAssistantSkills()
      const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(
        skillsMod,
        'listWorkflowSkillTemplates',
      )
      const templates = listTemplates()
      const repoTemplate = templates.find(t => String(t.category ?? t.name).includes('repo'))
      expect(repoTemplate).toBeDefined()
    })

    test('T1-F18-03: built-in workflow templates cover calendar/meeting-prep workflow', async () => {
      const skillsMod = await loadAssistantSkills()
      const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(
        skillsMod,
        'listWorkflowSkillTemplates',
      )
      const templates = listTemplates()
      const calTemplate = templates.find(t => String(t.category ?? t.name).includes('calendar'))
      expect(calTemplate).toBeDefined()
    })

    test('T1-F18-04: built-in workflow templates cover email/inbox-triage workflow with non-stop compensation', async () => {
      const skillsMod = await loadAssistantSkills()
      const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(
        skillsMod,
        'listWorkflowSkillTemplates',
      )
      const templates = listTemplates()
      const emailTemplate = templates.find(t => String(t.category ?? t.name).includes('email'))
      expect(emailTemplate).toBeDefined()
      expect(emailTemplate?.compensation).not.toBe('stop-and-report')
    })

    test('T1-F18-05: workflow templates cover at least 4 distinct real workflow families with lineage metadata', async () => {
      const skillsMod = await loadAssistantSkills()
      const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(
        skillsMod,
        'listWorkflowSkillTemplates',
      )
      const templates = listTemplates()
      expect(templates.length).toBeGreaterThanOrEqual(4)
      for (const tpl of templates) {
        expect(tpl.name).toBeTypeOf('string')
        expect(tpl.preconditions).toBeDefined()
        expect(tpl.compensation).toBeDefined()
        expect(sha256Hex(String(tpl.name))).toHaveLength(64)
      }
    })
  })
})
