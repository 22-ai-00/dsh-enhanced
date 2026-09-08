import { chmodSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { GoalBudgetStore } from '../src/budget-store.ts'
import { validateGoalBudgetConfig } from '../src/budget.ts'
import { GoalStoreError } from '../src/types.ts'

const scope = { principalId: 'owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'default' }
const binding = { scope, goalId: 'goal-a' }
const limits = (expiresAt = 100): { modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsdMicros: number | null; expiresAt: number } => ({ modelCalls: 2, toolCalls: 2, inputTokens: 10, outputTokens: 10, costUsdMicros: 50, expiresAt })
const request = (id = 'request-a') => ({ id, runId: 'run-a', inputTokens: 6, outputTokens: 4, costUsdMicros: 30 })

describe('GoalBudgetStore', () => {
  it('persists calls-only authority and retains failed dispatch reservations across restart', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-budget-calls-')), 'budget.sqlite')
    const calls = { mode: 'calls' as const, routes: [{ provider: 'relay', model: 'alwaysday1' }], modelCalls: 1, toolCalls: 1, inputTokens: null, outputTokens: null, costUsdMicros: null, expiresAt: 100 }
    const first = new GoalBudgetStore(path)
    first.configure(binding, calls)
    first.reserve(binding, { id: 'calls-failed-dispatch', runId: 'run-a', inputTokens: 0, outputTokens: 0, costUsdMicros: null }, 1)
    expect(first.snapshot(binding)).toMatchObject({ modelCalls: 1, heldCalls: 1, inputTokens: null, outputTokens: null, costUsdMicros: null, limits: { mode: 'calls', routes: calls.routes } })
    expect(() => first.configure(binding, { ...calls, routes: [{ provider: 'relay', model: 'other' }] })).toThrow(GoalStoreError)
    first.close()
    const second = new GoalBudgetStore(path)
    try {
      expect(second.runUsage(binding, 'run-a')).toEqual({ modelCalls: 1, heldCalls: 1, inputTokens: null, outputTokens: null, costUsdMicros: null })
      expect(() => second.reserve(binding, { id: 'calls-retry', runId: 'run-a', inputTokens: 0, outputTokens: 0, costUsdMicros: null }, 2)).toThrow(GoalStoreError)
    } finally { second.close() }
  })

  it('rejects mixed calls-only configuration and retains legacy token defaults', () => {
    expect(validateGoalBudgetConfig({ modelCalls: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, maxOutputTokensPerCall: 1 })).toMatchObject({ inputTokens: 1, outputTokens: 1 })
    expect(() => validateGoalBudgetConfig({ mode: 'calls', modelCalls: 1, toolCalls: 0, durationMs: 1, maxOutputTokensPerCall: 1, routes: [{ provider: 'relay', model: 'alwaysday1' }], inputTokens: 1 } as never)).toThrow(/execution budget/)
  })

  it('attributes settled and uncertain child cost within the exact parent goal budget', () => {
    const store = new GoalBudgetStore(':memory:')
    store.configure(binding, limits())
    store.reserve(binding, { ...request(), runId: 'strategy-child' }, 1)
    store.settle('request-a', { inputTokens: 2, outputTokens: 1, costUsdMicros: 5 }, 2)
    store.reserve(binding, { ...request('request-b'), runId: 'strategy-child' }, 3)
    expect(store.runUsage(binding, 'strategy-child')).toEqual({ modelCalls: 2, heldCalls: 1, inputTokens: 8, outputTokens: 5, costUsdMicros: 35 })
    expect(store.runUsage(binding, 'parent-run')).toEqual({ modelCalls: 0, heldCalls: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: 0 })
    const other = { ...binding, goalId: 'other-goal' }
    store.configure(other, { ...limits(), costUsdMicros: null })
    expect(store.runUsage(other, 'strategy-child')).toEqual({ modelCalls: 0, heldCalls: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: null })
    expect(() => store.runUsage({ ...binding, scope: { ...scope, principalVersion: 2 } }, 'strategy-child')).toThrow(GoalStoreError)
    expect(store.snapshot(binding)).toMatchObject({ modelCalls: 2, heldCalls: 1, inputTokens: 8 })
    store.close()
  })
  it('makes per-goal limits immutable and scope reads exact', () => {
    const store = new GoalBudgetStore(':memory:')
    expect(store.configure(binding, limits())).toMatchObject({ limits: limits(), modelCalls: 0, heldCalls: 0 })
    expect(Object.isFrozen(store.snapshot(binding))).toBe(true)
    expect(store.configure(binding, limits())).toEqual(store.snapshot(binding))
    expect(() => store.configure(binding, { ...limits(), modelCalls: 3 })).toThrow(GoalStoreError)
    expect(() => store.snapshot({ scope: { ...scope, principalId: 'other' }, goalId: 'goal-a' })).toThrow(GoalStoreError)
    store.close()
  })

  it('previews candidate limits without configuring them and retains held reservations in an existing view', () => {
    const store = new GoalBudgetStore(':memory:')
    expect(store.preview(binding, limits())).toMatchObject({ limits: limits(), modelCalls: 0, toolCalls: 0, heldCalls: 0 })
    // Preview is used by a Policy predicate: it must not materialize a budget row.
    expect(() => store.snapshot(binding)).toThrow(GoalStoreError)

    store.configure(binding, limits())
    store.reserve(binding, request(), 1)
    expect(store.preview(binding, limits())).toMatchObject({ modelCalls: 1, inputTokens: 6, outputTokens: 4, heldCalls: 1 })
    expect(() => store.preview(binding, { ...limits(), outputTokens: 11 })).toThrow(GoalStoreError)
    store.close()
  })

  it('rejects replayed global request ids and over-budget reservations', () => {
    const store = new GoalBudgetStore(':memory:'); store.configure(binding, limits())
    store.reserve(binding, request(), 1)
    expect(() => store.reserve(binding, request(), 2)).toThrow(GoalStoreError)
    expect(() => store.consumeTool(binding, 'request-a', 2)).toThrow(GoalStoreError)
    expect(() => store.reserve(binding, request('request-b'), 2)).toThrow(GoalStoreError)
    expect(() => store.reserve(binding, { ...request('cost'), inputTokens: 1, outputTokens: 1, costUsdMicros: null }, 2)).toThrow(GoalStoreError)
    expect(() => store.reserve(binding, { ...request('large'), inputTokens: 11 }, 2)).toThrow(GoalStoreError)
    store.close()
  })

  it('uses actual settled values, including partial return, and makes exact settles idempotent', () => {
    const store = new GoalBudgetStore(':memory:'); store.configure(binding, limits())
    expect(store.reserve(binding, request(), 1)).toMatchObject({ state: 'held', inputTokens: 6 })
    expect(store.settle('request-a', { inputTokens: 2, outputTokens: 1, costUsdMicros: 5 }, 2)).toMatchObject({ state: 'settled', inputTokens: 2, costUsdMicros: 5 })
    expect(store.settle('request-a', { inputTokens: 2, outputTokens: 1, costUsdMicros: 5 }, 3)).toMatchObject({ state: 'settled' })
    expect(() => store.settle('request-a', { inputTokens: 3, outputTokens: 1, costUsdMicros: 5 }, 3)).toThrow(GoalStoreError)
    store.reserve(binding, { ...request('request-b'), inputTokens: 8, outputTokens: 9, costUsdMicros: 45 }, 3)
    expect(store.snapshot(binding)).toMatchObject({ modelCalls: 2, inputTokens: 10, outputTokens: 10, costUsdMicros: 50, heldCalls: 1 })
    store.close()
  })

  it('rejects settlement times before their reservation', () => {
    const store = new GoalBudgetStore(':memory:'); store.configure(binding, limits())
    store.reserve(binding, request(), 10)
    expect(() => store.settle('request-a', { inputTokens: 1, outputTokens: 1, costUsdMicros: 1 }, 9)).toThrow(GoalStoreError)
    store.close()
  })

  it('atomically fences competing connections and charges tools separately', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-budget-')), 'budget.sqlite')
    const first = new GoalBudgetStore(path); first.configure(binding, { ...limits(), modelCalls: 1, toolCalls: 1 })
    const second = new GoalBudgetStore(path)
    try {
      first.reserve(binding, request(), 1)
      expect(() => second.reserve(binding, request('request-b'), 1)).toThrow(GoalStoreError)
      second.consumeTool(binding, 'tool-a', 1)
      expect(() => first.consumeTool(binding, 'tool-b', 1)).toThrow(GoalStoreError)
    } finally { first.close(); second.close() }
  })

  it('retains held reservations across restart and enforces deadline', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-budget-')), 'budget.sqlite')
    const first = new GoalBudgetStore(path); first.configure(binding, { ...limits(), modelCalls: 1, expiresAt: 5 }); first.reserve(binding, request(), 1); first.close()
    const second = new GoalBudgetStore(path)
    try {
      expect(second.snapshot(binding)).toMatchObject({ modelCalls: 1, heldCalls: 1, inputTokens: 6 })
      expect(() => second.reserve(binding, request('request-b'), 4)).toThrow(GoalStoreError)
      expect(() => second.consumeTool(binding, 'tool-a', 5)).toThrow(GoalStoreError)
    } finally { second.close() }
  })

  it('migrates v1 ledgers as strict token budgets without releasing crash holds', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-budget-v1-')), 'budget.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`CREATE TABLE goal_budget_limits (scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, model_calls INTEGER NOT NULL, tool_calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd_micros INTEGER, expires_at INTEGER NOT NULL, PRIMARY KEY(scope_json, goal_id)) STRICT, WITHOUT ROWID;
      CREATE TABLE goal_budget_reservations (id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, run_id TEXT NOT NULL, input_tokens_reserved INTEGER NOT NULL, output_tokens_reserved INTEGER NOT NULL, cost_usd_micros_reserved INTEGER, state TEXT NOT NULL CHECK(state IN ('held','settled')), reserved_at INTEGER NOT NULL, input_tokens_actual INTEGER, output_tokens_actual INTEGER, cost_usd_micros_actual INTEGER, settled_at INTEGER, FOREIGN KEY(scope_json, goal_id) REFERENCES goal_budget_limits(scope_json, goal_id)) STRICT;
      CREATE TABLE goal_budget_tools (id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, consumed_at INTEGER NOT NULL, FOREIGN KEY(scope_json, goal_id) REFERENCES goal_budget_limits(scope_json, goal_id)) STRICT;
      CREATE TABLE goal_budget_request_ids (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('reserve','tool'))) STRICT;
      CREATE INDEX goal_budget_reservations_scope_goal ON goal_budget_reservations(scope_json, goal_id);
      CREATE INDEX goal_budget_tools_scope_goal ON goal_budget_tools(scope_json, goal_id); PRAGMA user_version = 1;`)
    const scopeJson = acceptanceCanonicalJson(scope)
    database.prepare('INSERT INTO goal_budget_limits VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(scopeJson, 'goal-a', 1, 0, 10, 10, null, 100)
    database.prepare("INSERT INTO goal_budget_request_ids VALUES (?, 'reserve')").run('legacy-held')
    database.prepare("INSERT INTO goal_budget_reservations(id, scope_json, goal_id, run_id, input_tokens_reserved, output_tokens_reserved, cost_usd_micros_reserved, state, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)").run('legacy-held', scopeJson, 'goal-a', 'run-a', 10, 10, null, 1)
    database.close(); chmodSync(path, 0o600)
    const migrated = new GoalBudgetStore(path)
    try {
      expect(migrated.snapshot(binding)).toMatchObject({ limits: { mode: 'tokens', routes: [], inputTokens: 10, outputTokens: 10 }, modelCalls: 1, heldCalls: 1 })
      expect(() => migrated.reserve(binding, { id: 'after-migration', runId: 'run-a', inputTokens: 0, outputTokens: 0, costUsdMicros: null }, 2)).toThrow(GoalStoreError)
      const callsBinding = { ...binding, goalId: 'calls-after-v1' }
      const calls = { mode: 'calls' as const, routes: [{ provider: 'relay', model: 'auto_model/alwaysday1' }], modelCalls: 1, toolCalls: 0, inputTokens: null, outputTokens: null, costUsdMicros: null, expiresAt: 100 }
      migrated.configure(callsBinding, calls)
      migrated.reserve(callsBinding, { id: 'calls-after-v1-request', runId: 'run-a', inputTokens: 0, outputTokens: 0, costUsdMicros: null }, 2)
      expect(migrated.snapshot(callsBinding)).toMatchObject({ limits: { mode: 'calls' }, modelCalls: 1, inputTokens: null, outputTokens: null })
    } finally { migrated.close() }
    const reopened = new GoalBudgetStore(path)
    try { expect(reopened.snapshot({ ...binding, goalId: 'calls-after-v1' })).toMatchObject({ limits: { mode: 'calls', routes: [{ provider: 'relay', model: 'auto_model/alwaysday1' }] }, heldCalls: 1, inputTokens: null }) } finally { reopened.close() }
  })

  it('rejects invalid payloads and corrupt persisted schemas', async () => {
    const store = new GoalBudgetStore(':memory:')
    expect(() => store.configure(binding, { ...limits(), inputTokens: -1 })).toThrow(GoalStoreError)
    expect(() => store.configure({ ...binding, goalId: '' }, limits())).toThrow(GoalStoreError)
    store.close()
    const path = join(await mkdtemp(join(tmpdir(), 'goal-budget-corrupt-')), 'budget.sqlite')
    const database = new DatabaseSync(path)
    database.exec('CREATE TABLE unexpected (id TEXT) STRICT; PRAGMA user_version = 1;')
    database.close(); chmodSync(path, 0o600)
    expect(() => new GoalBudgetStore(path)).toThrow(GoalStoreError)
  })

  it('rejects persisted priced reservations with an unknown cost', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-budget-corrupt-row-')), 'budget.sqlite')
    const store = new GoalBudgetStore(path); store.configure(binding, limits()); store.close()
    const database = new DatabaseSync(path)
    const scopeJson = (database.prepare('SELECT scope_json FROM goal_budget_limits WHERE goal_id = ?').get('goal-a') as { scope_json: string }).scope_json
    database.prepare("INSERT INTO goal_budget_request_ids(id, kind) VALUES (?, 'reserve')").run('corrupt-request')
    database.prepare("INSERT INTO goal_budget_reservations(id, scope_json, goal_id, run_id, input_tokens_reserved, output_tokens_reserved, cost_usd_micros_reserved, state, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)")
      .run('corrupt-request', scopeJson, 'goal-a', 'run-a', 1, 1, null, 1)
    database.close()
    expect(() => new GoalBudgetStore(path)).toThrow(GoalStoreError)
  })
})
