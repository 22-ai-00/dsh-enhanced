import { describe, expect, it } from 'vitest'
import {
  assessTaskDifficulty,
  classifyGoalFailureType,
  extractRecentSessionToolOutcomes,
  filterPermittedStrategyTools,
  isForbiddenStrategyTool,
  isWriteMutationTool,
  optimizeStrategyDecision,
  recommendGoalStrategy,
} from '../src/strategy-router.ts'
import type { GoalBudgetSnapshot } from '../src/budget-store.ts'
import type { GoalFeedback } from '../src/feedback.ts'
import type { StrategyOutcomeTelemetry, StrategyRecord } from '../src/strategy-store.ts'
import type { GoalRecord } from '../src/types.ts'

const sha = 'a'.repeat(64)
const scope = { principalId: 'owner', principalRecordId: 'owner-rec', principalVersion: 1, workspace: '/work/repo', preset: 'primary' }

function makeRecord(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'goal-1',
    scope,
    originalObjective: 'Fix failing test',
    definition: { version: 1, digest: sha, objective: 'Fix failing test' },
    native: { sessionId: 'session-1', goalId: 'native-1', revision: 1, objective: 'Fix failing test', phase: 'active', roundsStarted: 1, maxGoalRounds: 4, updatedAt: 1_000 },
    checkpoint: { nextStep: 'Run targeted check', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] },
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function makeBudget(overrides: Partial<GoalBudgetSnapshot> = {}): GoalBudgetSnapshot {
  return {
    limits: { mode: 'calls', routes: [{ provider: 'p', model: 'm' }], modelCalls: 10, toolCalls: 10, inputTokens: null, outputTokens: null, costUsdMicros: null, expiresAt: 100_000 },
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsdMicros: null,
    heldCalls: 0,
    ...overrides,
  }
}

function makeFeedback(nextAction: GoalFeedback['nextAction'], status: 'achieved' | 'not-achieved' | 'unknown' | 'invalid' = 'achieved', historyCount = 0): GoalFeedback {
  const step = {
    runId: 'run-1',
    definitionVersion: 1,
    status,
    execution: { status: status === 'unknown' ? 'unknown' as const : 'succeeded' as const, quiescent: status !== 'unknown', completedAt: 2_000, executionRef: 'run-1' },
    criteria: status === 'not-achieved' ? [{ id: 'c1', status: 'failed' as const, reason: 'mismatch', reasonTruncated: false, evidence: [], definition: { kind: 'document-citations' }, evidenceTruncated: false }] : [],
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
      history: Array.from({ length: Math.max(1, historyCount) }, () => step),
    },
    nextAction,
  }
}

const emptyTelemetry: StrategyOutcomeTelemetry = {
  totalRuns: 0,
  adviceRuns: 0,
  experimentRuns: 0,
  directRecommendedRuns: 0,
  failedOrUnknownRuns: 0,
  byKind: {
    direct: { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 },
    investigate: { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 },
    review: { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 },
    compare: { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 },
    experiment: { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 },
    subagent: { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 },
  },
}

describe('strategy-router', () => {
  it('extracts bounded operational tool outcomes and ignores goal_strategy', () => {
    const outcomes = extractRecentSessionToolOutcomes([
      { type: 'tool/call', data: { callId: 'c1', name: 'read_file' } },
      { type: 'tool/result', data: { message: { role: 'tool', source: { callId: 'c1' }, isError: false, content: 'secret content' } } },
      { type: 'tool/call', data: { callId: 'c2', name: 'goal_strategy' } },
      { type: 'tool/result', data: { message: { role: 'tool', source: { callId: 'c2' }, isError: true } } },
      { type: 'tool/call', data: { callId: 'c3', name: 'isolation_run' } },
      { type: 'tool/result', data: { message: { role: 'user', source: { callId: 'c3' }, content: [{ type: 'tool-result', toolCallId: 'c3', isError: true }] } } },
    ])
    expect(outcomes).toEqual([
      { name: 'read_file', isError: false },
      { name: 'isolation_run', isError: true },
    ])
  })

  it('distinguishes unknown-execution, tool-failure, reasoning-failure, and none deterministically', () => {
    expect(classifyGoalFailureType({ feedback: makeFeedback('reconcile-execution', 'unknown') }).failureType).toBe('unknown-execution')
    expect(classifyGoalFailureType({
      feedback: makeFeedback('revise-plan', 'not-achieved'),
      recentToolOutcomes: [{ name: 'isolation_run', isError: true }],
    }).failureType).toBe('tool-failure')

    const failedStrategyChild: StrategyRecord = {
      intent: { id: 's1', goalId: 'goal-1', parentRunId: 'run-1', parentSessionId: 'session-1', definitionVersion: 1, definitionDigest: sha, scope, kind: 'investigate', requestDigest: sha, provider: 'p', model: 'm', maxChildren: 1, maxDurationMs: 1_000, createdAt: 1, expiresAt: 1_001 },
      state: 'settled',
      version: 3,
      children: [{ sessionId: 'c1', stopReason: 'error', quiescent: true, diagnostics: { toolRejections: 0, output: 'not-observed', failure: { stage: 'stream', dispatched: true } } }],
      completedAt: 100,
      outcome: 'execution-failed',
      terminationReason: 'execution-failed',
    }
    expect(classifyGoalFailureType({ recentStrategies: [failedStrategyChild] }).failureType).toBe('tool-failure')
    expect(classifyGoalFailureType({ feedback: makeFeedback('revise-plan', 'not-achieved') }).failureType).toBe('reasoning-failure')
    expect(classifyGoalFailureType({ feedback: makeFeedback('review-remaining-criteria', 'achieved') }).failureType).toBe('none')
    expect(classifyGoalFailureType({ failureHint: 'tool-failure' }).failureType).toBe('tool-failure')
  })

  it('classifies task difficulty across trivial, moderate, and complex signals', () => {
    const trivial = assessTaskDifficulty({ record: makeRecord(), now: 5_000 })
    expect(trivial.difficulty).toBe('trivial')

    const moderate = assessTaskDifficulty({
      record: makeRecord({
        checkpoint: { nextStep: '', blockers: ['missing env'], assumptions: [{ statement: 'stale', expiresAt: 1_000 }], evidenceRefs: [], dependencies: ['dep-1'] },
      }),
      now: 5_000,
    })
    expect(moderate.difficulty).toBe('moderate')

    const complex = assessTaskDifficulty({
      record: makeRecord({
        native: { sessionId: 'session-1', goalId: 'native-1', revision: 2, objective: 'Fix failing test', phase: 'active', roundsStarted: 3, maxGoalRounds: 4, updatedAt: 1_000 },
        checkpoint: { nextStep: '', blockers: ['b1', 'b2'], assumptions: [{ statement: 'stale', expiresAt: 1_000 }], evidenceRefs: [], dependencies: ['d1', 'd2'] },
      }),
      feedback: makeFeedback('revise-plan', 'not-achieved', 2),
      now: 5_000,
    })
    expect(complex.difficulty).toBe('complex')
  })

  it('routes trivial tasks to direct, tool-failure to experiment, moderate reasoning-failure to review, complex reasoning-failure to compare, and complex clean tasks to subagent', () => {
    const base = {
      budget: makeBudget(),
      availableTools: ['read', 'glob', 'grep', 'isolation_run'],
      now: 5_000,
    }
    expect(recommendGoalStrategy({ ...base, record: makeRecord() }).selectedStrategy).toBe('direct')

    const moderateRecord = makeRecord({
      checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: ['dep-1'] },
    })
    expect(recommendGoalStrategy({
      ...base,
      record: moderateRecord,
      recentToolOutcomes: [{ name: 'isolation_run', isError: true }],
    }).selectedStrategy).toBe('experiment')

    expect(recommendGoalStrategy({
      ...base,
      record: moderateRecord,
      feedback: makeFeedback('revise-plan', 'not-achieved', 1),
    }).selectedStrategy).toBe('review')

    const complexRecord = makeRecord({
      native: { sessionId: 'session-1', goalId: 'native-1', revision: 3, objective: 'Fix failing test', phase: 'active', roundsStarted: 3, maxGoalRounds: 4, updatedAt: 1_000 },
      checkpoint: { nextStep: '', blockers: ['b1', 'b2'], assumptions: [{ statement: 's', expiresAt: 1 }], evidenceRefs: [], dependencies: ['d1', 'd2'] },
    })
    expect(recommendGoalStrategy({
      ...base,
      record: complexRecord,
      feedback: makeFeedback('revise-plan', 'not-achieved', 2),
    }).selectedStrategy).toBe('compare')

    expect(recommendGoalStrategy({
      ...base,
      record: complexRecord,
    }).selectedStrategy).toBe('subagent')
  })

  it('downgrades or suppresses redundant/negative-EV branching based on budget headroom and telemetry', () => {
    // Tight budget (2 model calls remaining, minRemainingParentCalls=1 -> cannot afford 2-child compare; downgrades to review)
    const tightCompare = optimizeStrategyDecision({
      difficulty: 'complex',
      difficultyScore: 5,
      difficultySignals: ['dependencies:2', 'failed-history:2'],
      failureType: 'reasoning-failure',
      failureSignals: ['step:not-achieved'],
      budget: makeBudget({ limits: { mode: 'calls', routes: [{ provider: 'p', model: 'm' }], modelCalls: 3, toolCalls: 0, inputTokens: null, outputTokens: null, costUsdMicros: null, expiresAt: 100_000 }, modelCalls: 1 }),
      experiment: { enabled: true, allowedTools: ['read'], maxToolCalls: 2, maxModelCalls: 2, workspaceWriteAllowed: false },
      subagent: { enabled: true, allowedTools: ['read'], maxToolCalls: 4, maxModelCalls: 3, workspaceWriteAllowed: false },
      availableTools: ['read'],
      costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
      maxStrategyDurationMs: 30_000,
      now: 5_000,
    })
    expect(tightCompare.selectedStrategy).toBe('review')

    // Negative historical telemetry on compare + review + investigate -> suppresses to direct
    const negativeTelemetry: StrategyOutcomeTelemetry = {
      ...emptyTelemetry,
      totalRuns: 6,
      failedOrUnknownRuns: 6,
      byKind: {
        ...emptyTelemetry.byKind,
        compare: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 2, avgToolCalls: 0 },
        review: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 1, avgToolCalls: 0 },
        investigate: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 1, avgToolCalls: 0 },
      },
    }
    const suppressed = optimizeStrategyDecision({
      difficulty: 'moderate',
      difficultyScore: 2,
      difficultySignals: ['blockers:1'],
      failureType: 'reasoning-failure',
      failureSignals: ['step:not-achieved'],
      budget: makeBudget(),
      telemetry: negativeTelemetry,
      experiment: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
      subagent: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
      costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
      maxStrategyDurationMs: 30_000,
      now: 5_000,
    })
    expect(suppressed.selectedStrategy).toBe('direct')

    // Advice saturation shifts away from pure advice to experiment when tools exist
    const saturated = optimizeStrategyDecision({
      difficulty: 'complex',
      difficultyScore: 4,
      difficultySignals: ['dependencies:2'],
      failureType: 'reasoning-failure',
      failureSignals: ['step:not-achieved'],
      budget: makeBudget(),
      requestDigest: sha,
      adviceSummary: {
        situation: 'goal-definition:x',
        definitionDigest: sha,
        goalInstances: 1,
        adviceRuns: 3,
        distinctRequests: 1,
        requests: [{ requestDigest: sha, occurrences: 3, distinctOutputDigests: 1, lastGoalId: 'goal-1', lastCompletedAt: 4_000 }],
      },
      experiment: { enabled: true, allowedTools: ['read'], maxToolCalls: 4, maxModelCalls: 3, workspaceWriteAllowed: false },
      subagent: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
      availableTools: ['read'],
      costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
      maxStrategyDurationMs: 30_000,
      now: 5_000,
    })
    expect(saturated.selectedStrategy).toBe('experiment')
  })

  it('filters forbidden and write-mutating tools when workspaceWriteAllowed is false', () => {
    const tools = filterPermittedStrategyTools(
      {
        enabled: true,
        allowedTools: [
          'read', 'write', 'write_file', 'edit_file', 'delete_file', 'create_file', 'remove_file',
          'bash', 'run_code', 'goal_strategy', 'create_goal', 'update_goal', 'get_goal', 'goal_context',
          'action_shell_exec', 'action_github_commit', 'action_github_create_pr', 'action_github_inspect',
          'isolation_run',
        ],
        maxToolCalls: 4,
        maxModelCalls: 3,
        workspaceWriteAllowed: false,
      },
      [
        'read', 'write', 'write_file', 'edit_file', 'delete_file', 'create_file', 'remove_file',
        'bash', 'isolation_run', 'goal_strategy', 'create_goal', 'update_goal', 'get_goal', 'goal_context',
        'action_shell_exec', 'action_github_commit', 'action_github_create_pr', 'action_github_inspect',
      ],
    )
    expect(tools).toEqual(['read', 'action_github_inspect', 'isolation_run'])
    expect(filterPermittedStrategyTools(
      { enabled: true, allowedTools: ['read', 'isolation_run'], maxToolCalls: 0, maxModelCalls: 2, workspaceWriteAllowed: false },
      ['read', 'isolation_run'],
    )).toEqual([])
    expect(isForbiddenStrategyTool('goal_custom_tool')).toBe(true)
    expect(isForbiddenStrategyTool('create_goal')).toBe(true)
    expect(isWriteMutationTool('action_custom_mutate')).toBe(true)
    expect(isWriteMutationTool('action_github_inspect')).toBe(false)
    expect(isWriteMutationTool('isolation_run')).toBe(false)
  })

  it('scopes session tool outcomes to the active goal round and clears recovered tool errors', () => {
    const events = [
      // Pre-goal turn 1 error, recovered in pre-goal turn 2
      { type: 'turn/start', time: 100, data: { turn: 1 } },
      { type: 'tool/call', time: 101, data: { callId: 'pre-1', name: 'probe_err' } },
      { type: 'tool/result', time: 102, data: { message: { role: 'tool', source: { callId: 'pre-1' }, isError: true } } },
      { type: 'turn/end', time: 103, data: { turn: 1 } },
      { type: 'turn/start', time: 110, data: { turn: 2 } },
      { type: 'tool/call', time: 111, data: { callId: 'pre-2', name: 'probe_err' } },
      { type: 'tool/result', time: 112, data: { message: { role: 'tool', source: { callId: 'pre-2' }, isError: false } } },
      { type: 'turn/end', time: 113, data: { turn: 2 } },
      // Goal created
      { type: 'goal/change', time: 200, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'native-1' } } },
      // Goal round 1 had an error
      { type: 'turn/start', time: 210, data: { turn: 3 } },
      { type: 'user/message', time: 211, data: { source: { kind: 'goal', goalId: 'native-1', revision: 1, round: 1 } } },
      { type: 'tool/call', time: 212, data: { callId: 'r1-1', name: 'probe_err' } },
      { type: 'tool/result', time: 213, data: { message: { role: 'tool', source: { callId: 'r1-1' }, isError: true } } },
      { type: 'turn/end', time: 214, data: { turn: 3 } },
      // Goal round 2 had a transient error on read_file that recovered cleanly
      { type: 'turn/start', time: 300, data: { turn: 4 } },
      { type: 'user/message', time: 301, data: { source: { kind: 'goal', goalId: 'native-1', revision: 1, round: 2 } } },
      { type: 'tool/call', time: 302, data: { callId: 'r2-1', name: 'read_file' } },
      { type: 'tool/result', time: 303, data: { message: { role: 'tool', source: { callId: 'r2-1' }, isError: true } } },
      { type: 'tool/call', time: 304, data: { callId: 'r2-2', name: 'read_file' } },
      { type: 'tool/result', time: 305, data: { message: { role: 'tool', source: { callId: 'r2-2' }, isError: false } } },
      { type: 'turn/end', time: 306, data: { turn: 4 } },
    ]
    expect(extractRecentSessionToolOutcomes(events, { nativeGoalId: 'native-1' })).toEqual([
      { name: 'read_file', isError: false },
    ])
    expect(extractRecentSessionToolOutcomes(events, { nativeGoalId: 'native-1', afterGoalRound: 2, sinceTime: 306 })).toEqual([])
  })

  it('bounds extraction to target goal round and prevents bleed from subsequent user turns or goals', () => {
    // EDGE_7A: Goal A Round 1 achieved, followed by Goal B Round 1 hitting failing_tool_b
    const events7A = [
      { type: 'goal/change', time: 100, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'gA' } } },
      { type: 'turn/start', time: 110, data: { turn: 1 } },
      { type: 'user/message', time: 111, data: { source: { kind: 'goal', goalId: 'gA', revision: 1, round: 1 } } },
      { type: 'tool/call', time: 112, data: { callId: 'a1', name: 'read_file' } },
      { type: 'tool/result', time: 113, data: { message: { role: 'tool', source: { callId: 'a1' }, isError: false } } },
      { type: 'turn/end', time: 114, data: { turn: 1 } },
      { type: 'goal/change', time: 150, data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'gA', revision: 1 }, clearedAt: 150 } },
      { type: 'goal/change', time: 200, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'gB' } } },
      { type: 'turn/start', time: 210, data: { turn: 2 } },
      { type: 'user/message', time: 211, data: { source: { kind: 'goal', goalId: 'gB', revision: 1, round: 1 } } },
      { type: 'tool/call', time: 212, data: { callId: 'b1', name: 'failing_tool_b' } },
      { type: 'tool/result', time: 213, data: { message: { role: 'tool', source: { callId: 'b1' }, isError: true } } },
      { type: 'turn/end', time: 214, data: { turn: 2 } },
    ]
    expect(extractRecentSessionToolOutcomes(events7A, { nativeGoalId: 'gA', afterGoalRound: 1, sinceTime: 115 })).toEqual([])

    // EDGE_7B: Goal A Round 1 unachieved, followed by Goal B Round 1 hitting failing_tool_b
    expect(extractRecentSessionToolOutcomes(events7A, { nativeGoalId: 'gA' })).toEqual([
      { name: 'read_file', isError: false },
    ])

    // EDGE_7C: Goal A Round 1 achieved, followed by regular non-goal user turn hitting user_turn_err
    const events7C = [
      { type: 'goal/change', time: 100, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'gA' } } },
      { type: 'turn/start', time: 110, data: { turn: 1 } },
      { type: 'user/message', time: 111, data: { source: { kind: 'goal', goalId: 'gA', revision: 1, round: 1 } } },
      { type: 'turn/end', time: 114, data: { turn: 1 } },
      { type: 'turn/start', time: 210, data: { turn: 2 } },
      { type: 'user/message', time: 211, data: { source: { kind: 'user' } } },
      { type: 'tool/call', time: 212, data: { callId: 'u1', name: 'user_turn_err' } },
      { type: 'tool/result', time: 213, data: { message: { role: 'tool', source: { callId: 'u1' }, isError: true } } },
      { type: 'turn/end', time: 214, data: { turn: 2 } },
    ]
    expect(extractRecentSessionToolOutcomes(events7C, { nativeGoalId: 'gA', afterGoalRound: 1, sinceTime: 114 })).toEqual([])
    expect(extractRecentSessionToolOutcomes(events7C, { nativeGoalId: 'gA' })).toEqual([])

    // EDGE_7D: Goal A Round 2 ran cleanly after Round 1 achieved, followed by Goal B Round 1 hitting failing_tool_b
    const events7D = [
      ...events7A.slice(0, 6),
      { type: 'turn/start', time: 120, data: { turn: 2 } },
      { type: 'user/message', time: 121, data: { source: { kind: 'goal', goalId: 'gA', revision: 1, round: 2 } } },
      { type: 'user/message', time: 122, data: { source: { kind: 'runtime-context', form: 'snapshot', sections: [] } } },
      { type: 'tool/call', time: 123, data: { callId: 'a2', name: 'read_file' } },
      { type: 'tool/result', time: 124, data: { message: { role: 'tool', source: { callId: 'a2' }, isError: false } } },
      { type: 'turn/end', time: 125, data: { turn: 2 } },
      ...events7A.slice(6),
    ]
    expect(extractRecentSessionToolOutcomes(events7D, { nativeGoalId: 'gA', afterGoalRound: 1, sinceTime: 114 })).toEqual([
      { name: 'read_file', isError: false },
    ])

    // Unrecovered Goal A Round 1 error is still detected when followed by Goal B
    const eventsUnrecovered = [
      { type: 'goal/change', time: 100, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'gA' } } },
      { type: 'turn/start', time: 110, data: { turn: 1 } },
      { type: 'user/message', time: 111, data: { source: { kind: 'goal', goalId: 'gA', revision: 1, round: 1 } } },
      { type: 'tool/call', time: 112, data: { callId: 'a-err', name: 'err_a' } },
      { type: 'tool/result', time: 113, data: { message: { role: 'tool', source: { callId: 'a-err' }, isError: true } } },
      { type: 'turn/end', time: 114, data: { turn: 1 } },
      { type: 'goal/change', time: 150, data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'gA', revision: 1 }, clearedAt: 150 } },
      { type: 'goal/change', time: 200, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'gB' } } },
      { type: 'turn/start', time: 210, data: { turn: 2 } },
      { type: 'user/message', time: 211, data: { source: { kind: 'goal', goalId: 'gB', revision: 1, round: 1 } } },
      { type: 'tool/call', time: 212, data: { callId: 'b-ok', name: 'err_a' } },
      { type: 'tool/result', time: 213, data: { message: { role: 'tool', source: { callId: 'b-ok' }, isError: false } } },
      { type: 'turn/end', time: 214, data: { turn: 2 } },
    ]
    expect(extractRecentSessionToolOutcomes(eventsUnrecovered, { nativeGoalId: 'gA' })).toEqual([
      { name: 'err_a', isError: true },
    ])

    // Unwrapped stream without turn/start or turn/end still bounds at subsequent user/message, and respects sinceTime
    const unwrapped = [
      { type: 'user/message', time: 111, data: { source: { kind: 'goal', goalId: 'gA', revision: 1, round: 1 } } },
      { type: 'tool/call', time: 112, data: { callId: 'u-old', name: 'old_err' } },
      { type: 'tool/result', time: 113, data: { message: { role: 'tool', source: { callId: 'u-old' }, isError: true } } },
      { type: 'tool/call', time: 116, data: { callId: 'u-ok', name: 'read_file' } },
      { type: 'tool/result', time: 117, data: { message: { role: 'tool', source: { callId: 'u-ok' }, isError: false } } },
      { type: 'user/message', time: 211, data: { source: { kind: 'user' } } },
      { type: 'tool/call', time: 212, data: { callId: 'u-after', name: 'user_turn_err' } },
      { type: 'tool/result', time: 213, data: { message: { role: 'tool', source: { callId: 'u-after' }, isError: true } } },
    ]
    expect(extractRecentSessionToolOutcomes(unwrapped, { nativeGoalId: 'gA', sinceTime: 115 })).toEqual([
      { name: 'read_file', isError: false },
    ])
  })

  it('does not misclassify recovered tool errors, empty-output zero-tool advice failures, or unknown whole-goal acceptance', () => {
    // Recovered tool error + quiescent succeeded + failed criteria => reasoning-failure
    const recoveredResult = classifyGoalFailureType({
      recentToolOutcomes: [{ name: 'read_file', isError: true }, { name: 'read_file', isError: false }],
      feedback: makeFeedback('revise-plan', 'not-achieved'),
    })
    expect(recoveredResult.failureType).toBe('reasoning-failure')

    // Zero-tool investigate execution-failed without operational failure stage => reasoning-failure (not tool-failure)
    const emptyInvestigate: StrategyRecord = {
      intent: { id: 's-empty', goalId: 'goal-1', parentRunId: 'run-1', parentSessionId: 'session-1', definitionVersion: 1, definitionDigest: sha, scope, kind: 'investigate', requestDigest: sha, provider: 'p', model: 'm', maxChildren: 1, maxDurationMs: 1_000, createdAt: 1, expiresAt: 1_001 },
      state: 'settled',
      version: 3,
      children: [{ sessionId: 'c1', stopReason: 'completed', quiescent: true, diagnostics: { toolRejections: 0, output: 'empty-or-oversized' } }],
      completedAt: 100,
      outcome: 'execution-failed',
      terminationReason: 'execution-failed',
    }
    expect(classifyGoalFailureType({
      recentStrategies: [emptyInvestigate],
      feedback: makeFeedback('revise-plan', 'not-achieved'),
    }).failureType).toBe('reasoning-failure')

    // Tool-enabled experiment execution-failed still classifies as tool-failure
    const failedExperiment: StrategyRecord = {
      ...emptyInvestigate,
      intent: { ...emptyInvestigate.intent, id: 's-exp', kind: 'experiment' },
    }
    expect(classifyGoalFailureType({
      recentStrategies: [failedExperiment],
      feedback: makeFeedback('revise-plan', 'not-achieved'),
    }).failureType).toBe('tool-failure')

    // goalAcceptance.status === 'unknown' classifies as unknown-execution
    const unknownGoal = classifyGoalFailureType({
      goalAcceptance: { status: 'unknown', definitionVersion: 1 },
    })
    expect(unknownGoal.failureType).toBe('unknown-execution')
    expect(unknownGoal.signals).toContain('whole-goal:unknown')
  })
})
