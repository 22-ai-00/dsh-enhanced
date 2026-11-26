import { createHmac } from 'node:crypto'
import { mkdir, symlink } from 'node:fs/promises'
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

function makeGoalBudget(overrides: Record<string, unknown> = {}) {
  return {
    limits: {
      mode: 'calls',
      routes: [{ provider: 'p', model: 'm' }],
      modelCalls: 10,
      toolCalls: 10,
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
      expiresAt: Date.now() + 100_000,
      ...(overrides.limits as Record<string, unknown> | undefined),
    },
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsdMicros: null,
    heldCalls: 0,
    ...overrides,
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

describe('Tier 2 — F15–F18: GoalStrategy, Compensation, EventTriggers & Skills Boundary Cases', () => {
  describe('F15: WP06 GoalStrategyRuntime deterministic tie-breaks, budget limits & failure routing boundaries', () => {
    test('T2-F15-01: optimizeStrategyDecision breaks ties deterministically by lower cost and picks direct on netBenefit tie with direct', async () => {
      const routerMod = await loadAssistantGoalsStrategyRouter()
      const optimize = getExportFn<(input: Record<string, unknown>) => {
        selectedStrategy: string
        candidates: readonly { mode: string; feasible: boolean; netBenefit: number; estimatedCostCalls: number }[]
      }>(routerMod, 'optimizeStrategyDecision')

      const zeroStat = { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 }
      const neutralTelemetry = {
        totalRuns: 0,
        adviceRuns: 0,
        experimentRuns: 0,
        directRecommendedRuns: 0,
        failedOrUnknownRuns: 0,
        byKind: {
          direct: zeroStat,
          investigate: zeroStat,
          review: zeroStat,
          compare: zeroStat,
          experiment: zeroStat,
          subagent: zeroStat,
        },
      }

      // When minNetBenefit exceeds every candidate's netBenefit, direct wins deterministically.
      const highThreshold = optimize({
        difficulty: 'moderate',
        difficultyScore: 2,
        difficultySignals: ['dependencies:1'],
        failureType: 'reasoning-failure',
        failureSignals: ['step:not-achieved'],
        budget: makeGoalBudget(),
        telemetry: neutralTelemetry,
        experiment: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
        subagent: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
        costBenefit: { minNetBenefit: 99, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
        maxStrategyDurationMs: 30_000,
        now: 5_000,
      })
      expect(highThreshold.selectedStrategy).toBe('direct')

      // Check sorted feasible non-direct branches preserve lower-cost tie-break order.
      const normal = optimize({
        difficulty: 'moderate',
        difficultyScore: 2,
        difficultySignals: ['dependencies:1'],
        failureType: 'reasoning-failure',
        failureSignals: ['step:not-achieved'],
        budget: makeGoalBudget(),
        telemetry: neutralTelemetry,
        experiment: { enabled: true, allowedTools: ['read'], maxToolCalls: 2, maxModelCalls: 1, workspaceWriteAllowed: false },
        subagent: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
        costBenefit: { minNetBenefit: 0, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
        maxStrategyDurationMs: 30_000,
        now: 5_000,
      })
      const feasibleNonDirect = normal.candidates.filter(c => c.mode !== 'direct' && c.feasible)
      expect(feasibleNonDirect.length).toBeGreaterThanOrEqual(2)
      const sortedCheck = [...feasibleNonDirect].sort((l, r) => r.netBenefit - l.netBenefit || l.estimatedCostCalls - r.estimatedCostCalls)
      expect(sortedCheck[0]?.mode).toBe(normal.selectedStrategy)
    })

    test('T2-F15-02: budget headroom boundaries (remainingMs < 1000, remainingModelCalls < minRemainingParentCalls, token exhaustion & unknown-execution) force direct', async () => {
      const routerMod = await loadAssistantGoalsStrategyRouter()
      const optimize = getExportFn<(input: Record<string, unknown>) => {
        selectedStrategy: string
        rationale: string
        candidates: readonly { mode: string; feasible: boolean; reason?: string }[]
      }>(routerMod, 'optimizeStrategyDecision')

      const base = {
        difficulty: 'complex',
        difficultyScore: 5,
        difficultySignals: ['blockers:2'],
        failureType: 'reasoning-failure',
        failureSignals: ['step:not-achieved'],
        experiment: { enabled: true, allowedTools: ['read'], maxToolCalls: 2, maxModelCalls: 1, workspaceWriteAllowed: false },
        subagent: { enabled: true, allowedTools: ['read'], maxToolCalls: 2, maxModelCalls: 1, workspaceWriteAllowed: false },
        costBenefit: { minNetBenefit: 0, minRemainingParentCalls: 2, maxAdviceRepetitions: 2 },
        maxStrategyDurationMs: 30_000,
        now: 10_000,
      }

      const lowTime = optimize({
        ...base,
        budget: makeGoalBudget({ limits: { mode: 'calls', routes: [{ provider: 'p', model: 'm' }], modelCalls: 10, toolCalls: 10, inputTokens: null, outputTokens: null, costUsdMicros: null, expiresAt: 10_999 } }),
      })
      expect(lowTime.selectedStrategy).toBe('direct')
      expect(lowTime.candidates.filter(c => c.mode !== 'direct').every(c => !c.feasible)).toBe(true)

      const lowCalls = optimize({
        ...base,
        budget: makeGoalBudget({
          modelCalls: 9,
          limits: { mode: 'calls', routes: [{ provider: 'p', model: 'm' }], modelCalls: 10, toolCalls: 10, inputTokens: null, outputTokens: null, costUsdMicros: null, expiresAt: 100_000 },
        }),
      })
      expect(lowCalls.selectedStrategy).toBe('direct')

      const tokenExhausted = optimize({
        ...base,
        budget: {
          limits: { mode: 'tokens', routes: [{ provider: 'p', model: 'm' }], modelCalls: null, toolCalls: 10, inputTokens: 100, outputTokens: 100, costUsdMicros: 500, expiresAt: 100_000 },
          modelCalls: 1,
          toolCalls: 0,
          inputTokens: 50,
          outputTokens: 100,
          costUsdMicros: 500,
          heldCalls: 0,
        },
      })
      expect(tokenExhausted.selectedStrategy).toBe('direct')

      const unknownExec = optimize({
        ...base,
        failureType: 'unknown-execution',
        budget: makeGoalBudget(),
      })
      expect(unknownExec.selectedStrategy).toBe('direct')
      expect(unknownExec.rationale).toContain('unknown-execution')
    })

    test('T2-F15-03: tool recovery clears tool-failure and empty/degenerate history returns direct', async () => {
      const routerMod = await loadAssistantGoalsStrategyRouter()
      const recommend = getExportFn<(input: Record<string, unknown>) => {
        failureType: string
        difficulty: string
        selectedStrategy: string
      }>(routerMod, 'recommendGoalStrategy')
      const extractOutcomes = getExportFn<(events: unknown[], opts?: Record<string, unknown>) => unknown[]>(
        routerMod,
        'extractRecentSessionToolOutcomes',
      )

      expect(extractOutcomes([])).toEqual([])
      expect(extractOutcomes([{ type: 'tool', name: 'bash', isError: true }], { limit: 0 })).toEqual([])

      const recovered = recommend({
        record: makeGoalRecord('/work/repo'),
        budget: makeGoalBudget(),
        availableTools: ['read', 'isolation_run'],
        recentToolOutcomes: [
          { name: 'isolation_run', isError: true },
          { name: 'isolation_run', isError: false },
        ],
        now: 5_000,
      })
      expect(recovered.failureType).toBe('none')
      expect(recovered.difficulty).toBe('trivial')
      expect(recovered.selectedStrategy).toBe('direct')
    })

    test('T2-F15-04: validateGoalStrategyConfig & validateGoalStrategyInput enforce integer bounds, unknown keys & forbidden tools', async () => {
      const strategyMod = await loadAssistantGoalsStrategy()

      expect(() => strategyMod.validateGoalStrategyConfig({ maxDurationMs: 1_000, maxRunsPerGoal: 1 })).not.toThrow()
      expect(() => strategyMod.validateGoalStrategyConfig({ maxDurationMs: 300_000, maxRunsPerGoal: 32 })).not.toThrow()
      expect(() => strategyMod.validateGoalStrategyConfig({ maxDurationMs: 999 })).toThrow(/invalid strategy configuration/)
      expect(() => strategyMod.validateGoalStrategyConfig({ maxDurationMs: 300_001 })).toThrow(/invalid strategy configuration/)
      expect(() => strategyMod.validateGoalStrategyConfig({ maxRunsPerGoal: 0 })).toThrow(/invalid strategy configuration/)
      expect(() => strategyMod.validateGoalStrategyConfig({ maxRunsPerGoal: 33 })).toThrow(/invalid strategy configuration/)
      expect(() => strategyMod.validateGoalStrategyConfig({ costBenefit: { minNetBenefit: Number.NaN } })).toThrow(/invalid strategy configuration/)
      expect(() => strategyMod.validateGoalStrategyConfig({ unknownField: true } as never)).toThrow(/invalid strategy configuration/)
      expect(() => strategyMod.validateGoalStrategyConfig({ experiment: { allowedTools: ['goal_create'] } } as never)).toThrow(/invalid strategy configuration/)

      expect(() => strategyMod.validateGoalStrategyInput({
        kind: 'experiment',
        question: 'Attempt forbidden tool',
        tools: ['run_code'],
      } as never)).toThrow(/invalid strategy input/)
    })

    test('T2-F15-05: filterPermittedStrategyTools strips forbidden goal_* and write-mutation tools when workspaceWriteAllowed=false', async () => {
      const routerMod = await loadAssistantGoalsStrategyRouter()
      const filterTools = getExportFn<(
        cfg: Record<string, unknown>,
        parentTools: readonly string[] | undefined,
        requestedTools: readonly string[] | undefined,
      ) => readonly string[]>(routerMod, 'filterPermittedStrategyTools')

      const filtered = filterTools(
        {
          enabled: true,
          allowedTools: ['read', 'grep', 'write_file', 'bash', 'goal_create', 'run_code'],
          maxToolCalls: 4,
          maxModelCalls: 2,
          workspaceWriteAllowed: false,
        },
        ['read', 'grep', 'write_file', 'bash', 'goal_create', 'run_code'],
        ['read', 'write_file', 'bash', 'goal_create', 'run_code'],
      )
      expect(filtered).toEqual(['read'])
    })

    test('T2-F15-06: GoalStrategyRuntime rejects kind=auto when autoRoute=false and enforces maxRunsPerGoal / unavailable parent', async () => {
      const ws = await workspaces.create('f15-autoroute-off-')
      const goalsMod = await loadAssistantGoals()
      const { GoalStrategyRuntime } = (await loadPackageModule('assistant-goals/strategy')) as {
        GoalStrategyRuntime: new (
          ctx: unknown,
          cfg: unknown,
          callbacks: Record<string, unknown>,
        ) => {
          run: (agent: unknown, input: unknown, signal: AbortSignal) => Promise<unknown>
          dispose?: () => void
        }
      }

      const ctx = harness.createContext()
      const agent = {
        id: 'agent-f15',
        options: { provider: 'p', model: 'm' },
        session: {
          id: 'sess-f15',
          header: { id: 'sess-f15', cwd: ws.workspace, agentPreset: 'primary' },
          snapshotEvents: () => [],
        },
        ctx,
        status: 'idle',
      }
      harness.provideMockService(ctx, 'agents', { get: (id: string) => (id === agent.id ? agent : undefined), list: () => [agent] })

      const cfg = goalsMod.validateGoalStrategyConfig({ autoRoute: false, maxRunsPerGoal: 1, maxDurationMs: 5_000 })
      const runtime = new (GoalStrategyRuntime as unknown as new (
        c: unknown,
        path: string,
        cfgObj: unknown,
        callbacks: Record<string, unknown>,
      ) => {
        run: (agent: unknown, input: unknown, signal: AbortSignal) => Promise<unknown>
        dispose?: () => void
      })(ctx, ws.sqlitePath('strat'), cfg, {
        current: () => ({
          record: makeGoalRecord(ws.workspace),
          run: { intent: { runId: 'r1', admission: { expiresAt: Date.now() + 60_000 } } },
        }),
        budget: {
          inspect: () => makeGoalBudget(),
        },
      })
      try {
        await expect(runtime.run(agent, { kind: 'auto', question: 'Should fail when autoRoute=false' }, new AbortController().signal))
          .rejects.toThrow(/automatic strategy routing is disabled/)
      } finally {
        runtime.dispose?.()
      }

      const runtimeAuto = new (GoalStrategyRuntime as unknown as new (
        c: unknown,
        path: string,
        cfgObj: unknown,
        callbacks: Record<string, unknown>,
      ) => {
        run: (a: unknown, req: Record<string, unknown>, sig: AbortSignal) => Promise<unknown>
        dispose?: () => void
      })(ctx, ws.sqlitePath('strat-auto'), goalsMod.validateGoalStrategyConfig({
        autoRoute: true,
        maxRunsPerGoal: 1,
        maxDurationMs: 5_000,
      }), {
        current: () => ({
          record: makeGoalRecord(ws.workspace),
          run: { intent: { runId: 'r1', admission: { expiresAt: Date.now() + 60_000 } } },
        }),
        budget: {
          inspect: () => makeGoalBudget(),
        },
      })
      try {
        // First auto-routed run succeeds (resolves to 'direct'), then maxRunsPerGoal=1 blocks 2nd run
        await expect(runtimeAuto.run(agent, { kind: 'auto', question: 'Run 1' }, new AbortController().signal)).resolves.toBeDefined()
        await expect(runtimeAuto.run(agent, { kind: 'auto', question: 'Run 2 exceeds maxRunsPerGoal' }, new AbortController().signal))
          .rejects.toThrow(/strategy admission unavailable/)
      } finally {
        runtimeAuto.dispose?.()
      }
    })
  })

  describe('F16: WP10 generic compensation registry, conflict, partial failure & audit boundaries', () => {
    test('T2-F16-01: CompensationRegistry rejects invalid kind/category/description and duplicate kind without replace=true', async () => {
      const recMod = await loadAssistantRecovery()
      const CompensationRegistry = getExportFn<new () => {
        register: (h: Record<string, unknown>, opts?: { replace?: boolean }) => () => void
        get: (kind: string) => unknown
      }>(recMod, 'CompensationRegistry')

      const reg = new CompensationRegistry()
      const validHandler = {
        kind: 'http.delete-resource',
        category: 'delete',
        compensate: async () => ({ status: 'succeeded', resultCode: 'ok' }),
      }

      expect(() => reg.register({ ...validHandler, kind: 'BadUpperCase' })).toThrow(/compensator kind|invalid/i)
      expect(() => reg.register({ ...validHandler, kind: '' })).toThrow(/compensator kind|invalid/i)
      expect(() => reg.register({ ...validHandler, category: 'unknown-cat' })).toThrow(/category|invalid/i)
      expect(() => reg.register({ ...validHandler, description: 'line1\nline2' })).toThrow(/description|invalid/i)
      expect(() => reg.register({ ...validHandler, description: 'x'.repeat(513) })).toThrow(/description|invalid/i)

      reg.register(validHandler)
      expect(() => reg.register(validHandler)).toThrow(/already registered|conflict/i)
      expect(() => reg.register(validHandler, { replace: true })).not.toThrow()
    }, 15_000)

    test('T2-F16-02: executeCompensation rejects idempotency-conflict and duplicate forwardActionId conflict while replaying identical retries', async () => {
      const ws = await workspaces.create('f16-conflict-')
      const recMod = await loadAssistantRecovery()
      const ctx = harness.createContext()
      const comp = await harness.mountService<{
        registerCompensator: (h: Record<string, unknown>) => () => void
        executeCompensation: (rec: Record<string, unknown>) => Promise<{ id: string; replayed: boolean }>
        listCompensationAudit: (id: string) => readonly { event: string }[]
      }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', {
        databasePath: ws.sqlitePath('comp-conflict'),
      })

      let calls = 0
      comp.registerCompensator({
        kind: 'http.delete-resource',
        category: 'delete',
        compensate: async () => {
          calls += 1
          return { status: 'succeeded', resultCode: 'deleted' }
        },
      })

      const first = await comp.executeCompensation({
        forwardActionId: 'fwd-1',
        idempotencyKey: 'idem-a',
        kind: 'http.delete-resource',
        target: { externalRef: 'item-1' },
      })
      const replay = await comp.executeCompensation({
        forwardActionId: 'fwd-1',
        idempotencyKey: 'idem-a',
        kind: 'http.delete-resource',
        target: { externalRef: 'item-1' },
      })
      expect(calls).toBe(1)
      expect(replay.id).toBe(first.id)
      expect(replay.replayed).toBe(true)
      expect(comp.listCompensationAudit(first.id).some(a => a.event === 'replayed')).toBe(true)

      await expect(comp.executeCompensation({
        forwardActionId: 'fwd-1',
        idempotencyKey: 'idem-a',
        kind: 'http.delete-resource',
        target: { externalRef: 'item-DIFFERENT' },
      })).rejects.toThrow(/idempotency/i)

      await expect(comp.executeCompensation({
        forwardActionId: 'fwd-1',
        idempotencyKey: 'idem-b',
        kind: 'http.delete-resource',
        target: { externalRef: 'item-1' },
      })).rejects.toThrow(/forwardActionId|forward action|conflict/i)
    })

    test('T2-F16-03: executeCompensation fails closed on unregistered handler, invalid input, expiry, unauthorized & capturePreimage failure', async () => {
      const ws = await workspaces.create('f16-errors-')
      const recMod = await loadAssistantRecovery()
      const ctx = harness.createContext()
      const comp = await harness.mountService<{
        registerCompensator: (h: Record<string, unknown>) => () => void
        executeCompensation: (rec: Record<string, unknown>) => Promise<unknown>
      }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', {
        databasePath: ws.sqlitePath('comp-err'),
      })

      await expect(comp.executeCompensation({
        idempotencyKey: 'missing-h',
        kind: 'never.registered',
        target: { externalRef: 'x' },
      })).rejects.toThrow(/no compensator registered|not registered/i)

      comp.registerCompensator({
        kind: 'lark.unsend',
        category: 'delete',
        authorize: () => false,
        compensate: async () => ({ status: 'succeeded', resultCode: 'ok' }),
      })
      await expect(comp.executeCompensation({
        idempotencyKey: 'unauth-1',
        kind: 'lark.unsend',
        target: { externalRef: 'msg-1' },
      })).rejects.toThrow(/authorization denied|unauthorized|not authorized/i)

      comp.registerCompensator({
        kind: 'http.capture-boom',
        category: 'revert',
        capturePreimage: async () => { throw new Error('preimage read failed') },
        compensate: async () => ({ status: 'succeeded', resultCode: 'ok' }),
      })
      await expect(comp.executeCompensation({
        idempotencyKey: 'cap-1',
        kind: 'http.capture-boom',
        target: { externalRef: 'obj-1' },
      })).rejects.toThrow(/capture|preimage/i)

      await expect(comp.executeCompensation({
        idempotencyKey: '',
        kind: 'http.capture-boom',
        target: { externalRef: 'obj-1' },
      })).rejects.toThrow(/invalid|idempotencyKey/i)

      await expect(comp.executeCompensation({
        idempotencyKey: 'exp-1',
        kind: 'http.capture-boom',
        target: { externalRef: 'obj-1' },
        expiresAt: Date.now() - 10_000,
      })).rejects.toThrow(/expired/i)
    })

    test('T2-F16-04: failed sideEffectState=possible settles to unknown with audit trail and disposed service rejects execution', async () => {
      const ws = await workspaces.create('f16-disposed-')
      const recMod = await loadAssistantRecovery()
      const ctx = harness.createContext()
      const comp = await harness.mountService<{
        registerCompensator: (h: Record<string, unknown>) => () => void
        executeCompensation: (rec: Record<string, unknown>) => Promise<{ id: string; status: string }>
        listCompensationAudit: (id: string) => readonly { event: string; status: string }[]
      }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', {
        databasePath: ws.sqlitePath('comp-disp'),
      })

      comp.registerCompensator({
        kind: 'http.possible-fail',
        category: 'revert',
        compensate: async () => ({ status: 'failed', sideEffectState: 'possible', resultCode: 'ambiguous' }),
      })
      const settled = await comp.executeCompensation({
        idempotencyKey: 'poss-1',
        kind: 'http.possible-fail',
        target: { externalRef: 'x' },
      })
      expect(settled.status).toBe('unknown')
      expect(comp.listCompensationAudit(settled.id).some(a => a.status === 'unknown')).toBe(true)

      await harness.disposeAll()
      await expect(comp.executeCompensation({
        idempotencyKey: 'after-dispose',
        kind: 'http.possible-fail',
        target: { externalRef: 'x' },
      })).rejects.toThrow(/disposed/i)
    })

    test('T2-F16-05: compensateFailedSkillRun continues reverse compensation across remaining steps when one step fails', async () => {
      const ws = await workspaces.create('f16-partial-skill-')
      const { compensateFailedSkillRun } = (await loadPackageModule('assistant-skills/compensation')) as {
        compensateFailedSkillRun: (input: Record<string, unknown>) => Promise<readonly { stepId: string; status: string }[]>
      }
      const { SkillStore } = (await loadPackageModule('assistant-skills/store')) as {
        SkillStore: new (path: string) => { close?: () => void }
      }
      const skillsDef = await loadAssistantSkillsDefinition()
      const directive = getExportFn<(k: string) => Record<string, unknown>>(skillsDef, 'compensationDirective')('compensate-via-registry')

      const ctx = harness.createContext()
      const compensatedOrder: string[] = []
      harness.provideMockService(ctx, 'assistantCompensation', {
        executeCompensation: async (rec: { stepId?: string }) => {
          compensatedOrder.push(String(rec.stepId))
          if (rec.stepId === 's2') {
            throw new Error('s2 external compensator timeout')
          }
          return { id: `comp-${rec.stepId}`, status: 'succeeded', resultCode: 'reverted' }
        },
      })

      const store = new SkillStore(ws.sqlitePath('skills-comp'))
      try {
        const scope = {
          principalId: 'owner',
          principalRecordId: 'owner-rec',
          principalVersion: 1,
          workspace: ws.workspace,
          preset: 'primary',
        }
        const records = await compensateFailedSkillRun({
          ctx,
          store,
          scope,
          runId: 'run-partial-1',
          definition: {
            name: 'multi-step-undo',
            version: 1,
            preconditions: 'current-owner-policy-and-fresh-goal',
            compensation: 'compensate-via-registry',
            compensationPlan: {
              entries: [
                { stepId: 's1', compensatorKey: 'skill.undo.s1' },
                { stepId: 's2', compensatorKey: 'skill.undo.s2' },
              ],
            },
            steps: [
              { id: 's1', toolName: 'write', arguments: { file_path: 'a.txt', content: '1' }, dependsOn: [] },
              { id: 's2', toolName: 'write', arguments: { file_path: 'b.txt', content: '2' }, dependsOn: ['s1'] },
              { id: 's3', toolName: 'write', arguments: { file_path: 'c.txt', content: '3' }, dependsOn: ['s2'] },
            ],
          },
          directive,
          completed: [
            { id: 's1', state: 'succeeded' },
            { id: 's2', state: 'succeeded' },
            { id: 's3', state: 'failed' },
          ],
          preimages: new Map(),
          allowedTools: ['write'],
          toolsCtx: undefined,
          exec: {},
          signal: new AbortController().signal,
          localHandlers: new Map(),
        })

        expect(compensatedOrder).toEqual(['s2', 's1'])
        const byStep = new Map(records.map(r => [r.stepId, r.status]))
        expect(byStep.get('s2')).toBe('unknown')
        expect(byStep.get('s1')).toBe('succeeded')
      } finally {
        store.close?.()
      }
    })

    test('T2-F16-06: compensateFailedSkillRun skips speculative compensation (skipped-unknown) when step outcome is unknown', async () => {
      const ws = await workspaces.create('f16-skip-unk-')
      const { compensateFailedSkillRun } = (await loadPackageModule('assistant-skills/compensation')) as {
        compensateFailedSkillRun: (input: Record<string, unknown>) => Promise<readonly { stepId: string; status: string }[]>
      }
      const { SkillStore } = (await loadPackageModule('assistant-skills/store')) as {
        SkillStore: new (path: string) => { close?: () => void }
      }
      const skillsDef = await loadAssistantSkillsDefinition()
      const directive = getExportFn<(k: string) => Record<string, unknown>>(skillsDef, 'compensationDirective')('compensate-via-registry')

      const ctx = harness.createContext()
      let compensatorInvoked = 0
      harness.provideMockService(ctx, 'assistantCompensation', {
        executeCompensation: async () => {
          compensatorInvoked += 1
          return { id: 'never', status: 'succeeded', resultCode: 'ok' }
        },
      })

      const store = new SkillStore(ws.sqlitePath('skills-unk'))
      try {
        const records = await compensateFailedSkillRun({
          ctx,
          store,
          scope: { principalId: 'owner', principalRecordId: 'owner-rec', principalVersion: 1, workspace: ws.workspace, preset: 'primary' },
          runId: 'run-unk-1',
          definition: {
            name: 'unk-undo',
            version: 1,
            preconditions: 'current-owner-policy-and-fresh-goal',
            compensation: 'compensate-via-registry',
            compensationPlan: { entries: [{ stepId: 's1', compensatorKey: 'skill.undo.s1' }] },
            steps: [{ id: 's1', toolName: 'write', arguments: { file_path: 'a.txt', content: '1' }, dependsOn: [] }],
          },
          directive,
          completed: [{ id: 's1', state: 'unknown' }],
          preimages: new Map(),
          allowedTools: ['write'],
          toolsCtx: undefined,
          exec: {},
          signal: new AbortController().signal,
          localHandlers: new Map(),
        })
        expect(compensatorInvoked).toBe(0)
        expect(records[0]?.status).toBe('skipped-unknown')
      } finally {
        store.close?.()
      }
    })
  })

  describe('F17: WP11 webhook HMAC/skew/replay, rolling window & trigger config boundaries', () => {
    async function mountWebhookFixture(
      ws: Awaited<ReturnType<typeof workspaces.create>>,
      nowFn: () => number,
      triggerOverrides: Record<string, unknown> = {},
      serviceOverrides: Record<string, unknown> = {},
    ) {
      const mod = await loadEventTriggers()
      const { EVENT_OBSERVER_EXECUTOR } = (await loadPackageModule('event-triggers/observer')) as { EVENT_OBSERVER_EXECUTOR: string }
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantAutomationsService } = (await loadPackageModule('assistant-automations')) as { AssistantAutomationsService: unknown }
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
          { id: 'obs', effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: ws.workspace, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
          { id: 'cred', effect: 'allow', subject: { kind: 'background', id: 'dsh-ray-event-triggers' }, actions: ['credential.use'], resource: { kind: 'credential', id: '*' }, context: { initiators: ['background'] } },
          { id: 'ing', effect: 'allow', subject: { kind: 'external', id: '*', workspace: ws.workspace }, actions: ['ingest'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } },
          { id: 'acc', effect: 'allow', subject: { kind: 'external', id: 'webhook:wh-1' }, actions: ['accept'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } },
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
        name: 'wh-creds',
        apply(runtime: unknown) {
          new (CredentialsKeychainService as new (r: unknown, cfg: unknown, opts: unknown) => unknown)(
            runtime,
            {
              databasePath: ws.sqlitePath('credentials'),
              handles: [{
                id: 'cred-wh',
                provider: 'environment',
                environmentName: 'DSH_E2E_WH_T2_SECRET',
                consumers: ['dsh-ray-event-triggers'],
                purposes: ['verify-webhook'],
                maxLeaseMs: 30_000,
              }],
            },
            { env: { DSH_E2E_WH_T2_SECRET: 't2-wh-secret' } },
          )
        },
      } as never)

      let svc!: InstanceType<typeof mod.EventTriggersService>
      await ctx.plugin({
        name: 'dsh-ray-event-triggers',
        apply(runtime: unknown) {
          svc = new mod.EventTriggersService(runtime as never, {
            databasePath: ws.sqlitePath('events'),
            pollerEnabled: false,
            webhookListen: { enabled: true, host: '127.0.0.1', port: 0, basePath: '/hooks' },
            ...serviceOverrides,
            triggers: [{
              id: 'wh-1',
              kind: 'webhook',
              automationId: 'auto-wh',
              credentialHandle: 'cred-wh',
              path: '/test',
              observer: makeTriggerObserver(ws.workspace, 'wh-obs'),
              ...triggerOverrides,
            } as never],
          }, { now: nowFn })
        },
      } as never)

      const addr = await svc.whenWebhookListening()
      return { svc, baseUrl: `http://${addr!.host}:${addr!.port}` }
    }

    test('T2-F17-01: webhook listener rejects missing headers (400), invalid/wrong-secret HMAC (401), GET (405) & unknown route (404)', async () => {
      const ws = await workspaces.create('f17-hmac-')
      const nowMs = 1_700_000_000_000
      const { baseUrl } = await mountWebhookFixture(ws, () => nowMs)
      const body = '{"ok":1}'
      const ts = String(nowMs)

      const missingSig = await fetch(`${baseUrl}/test`, {
        method: 'POST',
        headers: { 'x-dsh-timestamp': ts, 'x-dsh-nonce': 'n1' },
        body,
      })
      expect(missingSig.status).toBe(401)

      const missingTs = await fetch(`${baseUrl}/test`, {
        method: 'POST',
        headers: { 'x-dsh-nonce': 'n1', 'x-dsh-signature': 'sha256=' + '0'.repeat(64) },
        body,
      })
      expect(missingTs.status).toBe(400)

      const wrongSecretSig = `sha256=${createHmac('sha256', 'wrong-secret').update(`${ts}\nn1\n${body}`).digest('hex')}`
      const badSecret = await fetch(`${baseUrl}/test`, {
        method: 'POST',
        headers: { 'x-dsh-timestamp': ts, 'x-dsh-nonce': 'n1', 'x-dsh-signature': wrongSecretSig },
        body,
      })
      expect(badSecret.status).toBe(401)

      const badMethod = await fetch(`${baseUrl}/test`, { method: 'GET' })
      expect(badMethod.status).toBe(405)

      const notFound = await fetch(`${baseUrl}/unknown-route`, { method: 'POST', body })
      expect(notFound.status).toBe(404)
    })

    test('T2-F17-02: webhook enforces exact maxSkewMs clock-skew boundary and rejects duplicate nonce replay (409)', async () => {
      const ws = await workspaces.create('f17-skew-replay-')
      const nowMs = 1_700_000_000_000
      const { baseUrl } = await mountWebhookFixture(ws, () => nowMs, { maxSkewMs: 5_000 })
      const body = '{"seq":1}'

      const sign = (ts: string, nonce: string) =>
        `sha256=${createHmac('sha256', 't2-wh-secret').update(`${ts}\n${nonce}\n${body}`).digest('hex')}`

      // Stale by maxSkewMs + 1 -> 401 timestamp
      const staleTs = String(nowMs - 5_001)
      const staleResp = await fetch(`${baseUrl}/test`, {
        method: 'POST',
        headers: { 'x-dsh-timestamp': staleTs, 'x-dsh-nonce': 'nonce-stale', 'x-dsh-signature': sign(staleTs, 'nonce-stale') },
        body,
      })
      expect(staleResp.status).toBe(401)
      expect((await staleResp.json() as { error: string }).error).toBe('timestamp')

      // Future skew by maxSkewMs + 1 -> 401 timestamp
      const futureTs = String(nowMs + 5_001)
      const futureResp = await fetch(`${baseUrl}/test`, {
        method: 'POST',
        headers: { 'x-dsh-timestamp': futureTs, 'x-dsh-nonce': 'nonce-future', 'x-dsh-signature': sign(futureTs, 'nonce-future') },
        body,
      })
      expect(futureResp.status).toBe(401)

      // Exact boundary Math.abs(now - ts) === maxSkewMs -> 202
      const exactTs = String(nowMs - 5_000)
      const exactResp = await fetch(`${baseUrl}/test`, {
        method: 'POST',
        headers: { 'x-dsh-timestamp': exactTs, 'x-dsh-nonce': 'nonce-exact', 'x-dsh-signature': sign(exactTs, 'nonce-exact') },
        body,
      })
      expect(exactResp.status).toBe(202)

      // Replaying same nonce -> 409 replay
      const replayResp = await fetch(`${baseUrl}/test`, {
        method: 'POST',
        headers: { 'x-dsh-timestamp': exactTs, 'x-dsh-nonce': 'nonce-exact', 'x-dsh-signature': sign(exactTs, 'nonce-exact') },
        body,
      })
      expect(replayResp.status).toBe(409)
      expect((await replayResp.json() as { error: string }).error).toBe('replay')
    })

    test('T2-F17-03: webhook rejects oversized payload (413), cooldown/maxFires limit (429), and expired ttl (410)', async () => {
      const ws = await workspaces.create('f17-limits-')
      let currentNow = 1_700_000_000_000
      const { baseUrl } = await mountWebhookFixture(ws, () => currentNow, {
        cooldownMs: 1_000,
        maxFires: 1,
        ttlMs: 10_000,
      }, { maxBodyBytes: 64 })

      const postSigned = async (nonce: string, body: string) => {
        const ts = String(currentNow)
        const sig = `sha256=${createHmac('sha256', 't2-wh-secret').update(`${ts}\n${nonce}\n${body}`).digest('hex')}`
        return fetch(`${baseUrl}/test`, {
          method: 'POST',
          headers: { 'x-dsh-timestamp': ts, 'x-dsh-nonce': nonce, 'x-dsh-signature': sig },
          body,
        })
      }

      const tooLarge = await postSigned('n-big', 'x'.repeat(128))
      expect(tooLarge.status).toBe(413)

      const firstOk = await postSigned('n-1', '{"ok":true}')
      expect(firstOk.status).toBe(202)

      const inCooldown = await postSigned('n-2', '{"ok":true}')
      expect(inCooldown.status).toBe(429)

      currentNow += 2_000
      const overMaxFires = await postSigned('n-3', '{"ok":true}')
      expect(overMaxFires.status).toBe(429)

      currentNow += 20_000
      const pastTtl = await postSigned('n-4', '{"ok":true}')
      expect(pastTtl.status).toBe(410)
    })

    test('T2-F17-04: lark-calendar rejects mixed fixed/rolling window bounds, empty rolling window at t=0 & honors pollerEnabled=false', async () => {
      const ws = await workspaces.create('f17-cal-edge-')
      const mod = await loadEventTriggers()
      const observer = makeTriggerObserver(ws.workspace)

      expect(() => mod.normalizeEventTriggersConfig({
        databasePath: ws.sqlitePath('events-1'),
        triggers: [{
          id: 'cal-mix',
          kind: 'lark-calendar',
          automationId: 'auto-1',
          calendarId: 'cal-1',
          startTime: 100,
          lookbackSeconds: 60,
          observer,
        } as never],
      })).toThrow(/Lark calendar/i)

      expect(() => mod.normalizeEventTriggersConfig({
        databasePath: ws.sqlitePath('events-2'),
        triggers: [{
          id: 'cal-step',
          kind: 'lark-calendar',
          automationId: 'auto-1',
          calendarId: 'cal-1',
          lookbackSeconds: 10,
          lookaheadSeconds: 10,
          windowStepSeconds: 30,
          observer,
        } as never],
      })).toThrow(/Lark calendar/i)

      const ctx = harness.createContext()
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantAutomationsService } = (await loadPackageModule('assistant-automations')) as { AssistantAutomationsService: unknown }
      const { EVENT_OBSERVER_EXECUTOR } = (await loadPackageModule('event-triggers/observer')) as { EVENT_OBSERVER_EXECUTOR: string }
      harness.provideMockService(ctx, 'assistantDelivery', {
        validateOwnerRoute: () => ({
          authorityId: 'route-1', authorityHash: sha256Hex('route-1'), receiptVersion: 2,
          principalId: 'owner:one', principalRecordId: 'record-1', principalVersion: 1,
          workspace: ws.workspace, agentPreset: 'primary', bindingVersion: 1, generation: 1,
        }),
      })
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        rules: [
          { id: 'obs', effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: ws.workspace, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
          { id: 'cal', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:cal-zero', workspace: ws.workspace, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'lark-calendar:cal-1' }, context: { initiators: ['background'] } },
        ],
      })
      await harness.mountPlugin(ctx, AssistantAutomationsService, {
        databasePath: ws.sqlitePath('automations'),
        runsPath: join(ws.stateDir, 'runs'),
        schedulerEnabled: false,
        reconcileIntervalMs: 0,
        allowUnbudgetedExecution: true,
      })

      let pollCount = 0
      const svc = new mod.EventTriggersService(ctx, {
        databasePath: ws.sqlitePath('events-3'),
        pollerEnabled: false,
        triggers: [{
          id: 'cal-zero',
          kind: 'lark-calendar',
          automationId: 'auto-1',
          calendarId: 'cal-1',
          lookbackSeconds: 60,
          lookaheadSeconds: 0,
          windowStepSeconds: 60,
          observer,
        } as never],
      }, {
        now: () => 0,
        larkCalendarReader: {
          readCalendarEventPage: async () => {
            pollCount += 1
            return { items: [], has_more: false }
          },
        },
      })
      await expect(svc.pollOnce()).rejects.toThrow(/rolling window is empty/i)
      expect(pollCount).toBe(0)
    })

    test('T2-F17-05: config & task-system/calendar/email sensors reject non-HTTPS, non-loopback listen, missing accountId & non-array payload', async () => {
      const ws = await workspaces.create('f17-sensors-err-')
      const mod = await loadEventTriggers()
      const observer = makeTriggerObserver(ws.workspace)

      expect(() => mod.normalizeEventTriggersConfig({
        databasePath: ws.sqlitePath('e1'),
        allowedHttpOrigins: ['http://insecure.example.test'],
      })).toThrow(/HTTPS/i)

      expect(() => mod.normalizeEventTriggersConfig({
        databasePath: ws.sqlitePath('e2'),
        webhookListen: { enabled: true, host: '0.0.0.0', port: 0 },
      })).toThrow(/loopback/i)

      expect(() => mod.normalizeEventTriggersConfig({
        databasePath: ws.sqlitePath('e3'),
        allowedHttpOrigins: ['https://cal.example.test'],
        triggers: [{
          id: 'ical-bad',
          kind: 'calendar',
          automationId: 'a1',
          url: 'https://cal.example.test/team.ics',
          format: 'ics',
          itemsPointer: '/items',
          observer,
        } as never],
      })).toThrow()

      expect(() => mod.normalizeEventTriggersConfig({
        databasePath: ws.sqlitePath('e4'),
        allowedHttpOrigins: ['https://mail.example.test'],
        triggers: [{
          id: 'mail-bad',
          kind: 'email',
          automationId: 'a1',
          url: 'https://mail.example.test/jmap',
          protocol: 'jmap',
          observer,
        } as never],
      })).toThrow(/accountId/i)

      const taskSensorMod = (await loadPackageModule('event-triggers/task-system-sensor')) as {
        readTaskSystemObservation: (input: Record<string, unknown>) => Promise<unknown>
      }
      await expect(taskSensorMod.readTaskSystemObservation({
        url: 'https://tasks.example.test/items',
        itemsPointer: '/items',
        maxItems: 10,
        maxBodyBytes: 65_536,
        timeoutMs: 2_000,
        allowedHosts: new Set(['tasks.example.test']),
        allowedOrigins: new Set(['https://tasks.example.test']),
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetcher: async () => new Response(JSON.stringify({ items: 'not-an-array' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      })).rejects.toThrow(/array/i)
    })
  })

  describe('F18: WP13 workflow skill preconditions, step DAG, compensation & template boundaries', () => {
    test('T2-F18-01: evaluatePreconditions and assertDefinitionProtocol reject unmet owner scope, stale goal & unsupported preconditions', async () => {
      const skillsDef = await loadAssistantSkillsDefinition()
      const evalPre = getExportFn<(kind: string, dec: Record<string, unknown>) => void>(skillsDef, 'evaluatePreconditions')
      const assertProto = getExportFn<(def: Record<string, unknown>) => void>(skillsDef, 'assertDefinitionProtocol')

      expect(() => evalPre('current-owner-policy-and-fresh-goal', {
        ownerScopeDigest: 'scope-a',
        currentScopeDigest: 'scope-b',
        goalId: 'g-2',
        sourceGoalId: 'g-1',
      })).toThrow(/fresh owner Goal required/i)

      expect(() => evalPre('current-owner-policy-and-fresh-goal', {
        ownerScopeDigest: 'scope-a',
        currentScopeDigest: 'scope-a',
        goalId: 'g-1',
        sourceGoalId: 'g-1',
      })).toThrow(/fresh owner Goal required/i)

      expect(() => assertProto({
        preconditions: 'totally-unsupported-precondition',
        compensation: 'stop-and-report',
        steps: [{ id: 's1', toolName: 'read', arguments: {}, dependsOn: [] }],
      })).toThrow(/unsupported skill preconditions/i)
    })

    test('T2-F18-02: validateStepGraph rejects cyclic/forward dependencies, duplicate step IDs & >32 steps', async () => {
      const skillsDef = await loadAssistantSkillsDefinition()
      const validateGraph = getExportFn<(steps: readonly Record<string, unknown>[]) => void>(skillsDef, 'validateStepGraph')

      expect(() => validateGraph([
        { id: 's1', toolName: 'read', arguments: {}, dependsOn: ['s2'] },
        { id: 's2', toolName: 'read', arguments: {}, dependsOn: [] },
      ])).toThrow(/topologically ordered/i)

      expect(() => validateGraph([
        { id: 's1', toolName: 'read', arguments: {}, dependsOn: ['s1'] },
      ])).toThrow(/topologically ordered/i)

      expect(() => validateGraph([
        { id: 'dup', toolName: 'read', arguments: {}, dependsOn: [] },
        { id: 'dup', toolName: 'read', arguments: {}, dependsOn: [] },
      ])).toThrow()

      const tooMany = Array.from({ length: 33 }, (_, i) => ({ id: `s${i}`, toolName: 'read', arguments: {}, dependsOn: [] }))
      expect(() => validateGraph(tooMany)).toThrow()
    })

    test('T2-F18-03: assertDefinitionProtocol & instantiate reject conflicting compensationPlan & mismatched/unknown inputs', async () => {
      const skillsDef = await loadAssistantSkillsDefinition()
      const assertProto = getExportFn<(def: Record<string, unknown>) => void>(skillsDef, 'assertDefinitionProtocol')
      const createDef = getExportFn<(
        source: Record<string, unknown>,
        opts: Record<string, unknown>,
        allowedTools: readonly string[],
      ) => Record<string, unknown>>(skillsDef, 'createDefinition')
      const instantiate = getExportFn<(def: Record<string, unknown>, inputs: Record<string, unknown>) => unknown>(skillsDef, 'instantiate')

      expect(() => assertProto({
        preconditions: 'current-owner-policy-and-fresh-goal',
        compensation: 'stop-and-report',
        compensationPlan: { entries: [{ stepId: 's1' }] },
        steps: [{ id: 's1', toolName: 'read', arguments: {}, dependsOn: [] }],
      })).toThrow()

      expect(() => assertProto({
        preconditions: 'current-owner-policy-and-fresh-goal',
        compensation: 'compensating-action',
        steps: [{ id: 's1', toolName: 'write', arguments: {}, dependsOn: [] }],
      })).toThrow()

      const source = {
        protocol: 'assistant-goals/verified-workflow-source/v1',
        scope: { principalId: 'owner', principalRecordId: 'r1', principalVersion: 1, workspace: '/work/a', preset: 'primary' },
        goal: { id: 'g1', definition: { version: 1, digest: sha256Hex('def'), objective: 'Read a file' }, sessionId: 'sess1', nativeGoalId: 'ng1' },
        runId: 'run-1',
        turn: 1,
        acceptance: { contractId: 'c1', contractDigest: sha256Hex('c'), receiptDigest: sha256Hex('rcpt'), verifiedAt: 1, validUntil: 2 },
        steps: [{ id: 's1', toolName: 'read', arguments: { file_path: 'a.txt', limit: 10 } }],
      }
      const def = createDef(source, {
        name: 'typed-skill',
        description: 'Typed skill test',
        bindings: [{ name: 'limit', stepId: 's1', path: '/limit' }],
      }, ['read'])

      expect(() => instantiate(def, { limit: 'wrong-type' })).toThrow(/type|mismatch|invalid/i)
      expect(() => instantiate(def, { limit: 1, extraUnknown: true })).toThrow(/unknown|input/i)
    })

    test('T2-F18-04: replaySkill fails closed on relative stateRoot, symlinked stateRoot, missing file read & path traversal outside workspace', async () => {
      const ws = await workspaces.create('f18-replay-fail-')
      const { replaySkill } = (await loadPackageModule('assistant-skills/replay')) as {
        replaySkill: (input: Record<string, unknown>) => Promise<{ outcome: string }>
      }
      const skillsDef = await loadAssistantSkillsDefinition()
      const createDef = getExportFn<(
        source: Record<string, unknown>,
        opts: Record<string, unknown>,
        allowedTools: readonly string[],
      ) => Record<string, unknown>>(skillsDef, 'createDefinition')

      const baseSource = {
        protocol: 'assistant-goals/verified-workflow-source/v1',
        scope: { principalId: 'owner', principalRecordId: 'r1', principalVersion: 1, workspace: ws.workspace, preset: 'primary' },
        goal: { id: 'g1', definition: { version: 1, digest: sha256Hex('def'), objective: 'Read workspace file' }, sessionId: 'sess1', nativeGoalId: 'ng1' },
        runId: 'run-1',
        turn: 1,
        acceptance: { contractId: 'c1', contractDigest: sha256Hex('c'), receiptDigest: sha256Hex('rcpt'), verifiedAt: 1, validUntil: 2 },
      }
      const defMissing = createDef(
        { ...baseSource, steps: [{ id: 's1', toolName: 'read', arguments: { file_path: 'missing.txt' } }] },
        { name: 'replay-fail-missing', description: 'Replay missing file test' },
        ['read'],
      )
      const defOk = createDef(
        { ...baseSource, steps: [{ id: 's1', toolName: 'read', arguments: { file_path: 'ok.txt' } }] },
        { name: 'replay-fail-traversal', description: 'Replay path traversal test' },
        ['read'],
      )

      await expect(replaySkill({
        definition: defMissing,
        inputs: {},
        files: [],
        artifactPath: 'ok.txt',
        stateRoot: 'relative/state',
        maxToolCalls: 4,
        maxBytes: 4096,
        signal: new AbortController().signal,
        authorize: () => {},
      })).rejects.toThrow(/invalid input/i)

      const realStateDir = join(ws.stateDir, 'replay-priv')
      await mkdir(realStateDir, { recursive: true, mode: 0o700 })
      const symStateDir = join(ws.stateDir, 'replay-sym')
      await symlink(realStateDir, symStateDir)

      await expect(replaySkill({
        definition: defOk,
        inputs: {},
        files: [{ path: 'ok.txt', content: 'hi' }],
        artifactPath: 'ok.txt',
        stateRoot: symStateDir,
        maxToolCalls: 4,
        maxBytes: 4096,
        signal: new AbortController().signal,
        authorize: () => {},
      })).rejects.toThrow(/private state root required/i)

      await expect(replaySkill({
        definition: defMissing,
        inputs: {},
        files: [],
        artifactPath: 'ok.txt',
        stateRoot: realStateDir,
        maxToolCalls: 4,
        maxBytes: 4096,
        signal: new AbortController().signal,
        authorize: () => {},
      })).rejects.toThrow(/replay read failed/i)

      await expect(replaySkill({
        definition: defOk,
        inputs: {},
        files: [{ path: '../escape.txt', content: 'x' }],
        artifactPath: 'ok.txt',
        stateRoot: realStateDir,
        maxToolCalls: 4,
        maxBytes: 4096,
        signal: new AbortController().signal,
        authorize: () => {},
      })).rejects.toThrow(/invalid path|external path/i)
    })

    test('T2-F18-05: WP13 multi-condition SkillPreconditionKind fails closed when unmet and workflow templates have unique non-conflicting names', async () => {
      const skillsMod = await loadAssistantSkills()
      const skillsDef = await loadAssistantSkillsDefinition()
      const evalPre = getExportFn<(kind: string, dec: Record<string, unknown>) => void>(skillsDef, 'evaluatePreconditions')
      const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(skillsMod, 'listWorkflowSkillTemplates')

      expect(() => evalPre('clean-git-worktree-and-policy-grant', {
        ownerScopeDigest: 'scope-a',
        currentScopeDigest: 'scope-a',
        goalId: 'g-2',
        sourceGoalId: 'g-1',
        cleanGitWorktree: false,
        policyGrantValid: true,
      })).toThrow()

      const templates = listTemplates()
      const names = templates.map(t => String(t.name))
      expect(new Set(names).size).toBe(names.length)
      expect(templates.length).toBeGreaterThanOrEqual(4)
    })
  })
})
