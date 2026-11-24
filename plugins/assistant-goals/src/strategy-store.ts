import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { acceptanceCanonicalJson, acceptanceDigest, goalDefinitionSituation } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from './types.js'
import type { GoalScope } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'

export type StrategyScope = GoalScope
export type StrategyKind = 'investigate' | 'review' | 'compare' | 'experiment' | 'subagent'
export type StrategyRouteMode = 'direct' | StrategyKind
export type StrategyRequestedKind = 'auto' | StrategyKind
export type StrategyTaskDifficulty = 'trivial' | 'moderate' | 'complex'
export type StrategyFailureType = 'none' | 'tool-failure' | 'reasoning-failure' | 'unknown-execution'

export interface StrategyRoutingSummary {
  difficulty: StrategyTaskDifficulty
  failureType: StrategyFailureType
  selectedStrategy: StrategyRouteMode
  expectedNetBenefit: number
  estimatedCostCalls: number
  rationale: string
}

export interface StrategyExperimentIntent {
  allowedTools: readonly string[]
  maxToolCalls: number
  maxModelCalls: number
  workspaceWriteAllowed: boolean
}

export interface StrategyIntent {
  id: string; goalId: string; parentRunId: string; parentSessionId: string; definitionVersion: number; definitionDigest: string
  scope: GoalScope; kind: StrategyRouteMode; requestDigest: string; provider: string; model: string; maxChildren: number; maxDurationMs: number; createdAt: number; expiresAt: number
  requestedKind?: StrategyRequestedKind
  routing?: StrategyRoutingSummary
  experiment?: StrategyExperimentIntent
}

export type StrategyOutcome = 'advice' | 'experiment' | 'direct-recommended' | 'execution-failed' | 'cancelled' | 'unknown'

export interface StrategyRecord {
  intent: StrategyIntent; state: 'prepared' | 'starting' | 'settled' | 'unknown'; version: number
  children: Array<{ sessionId: string; stopReason: string; quiescent: boolean; diagnostics?: StrategyChildDiagnostics }>
  completedAt?: number; outcome?: StrategyOutcome; outputDigest?: string
  terminationReason?: StrategyTerminationReason
}
export interface StrategyChildDiagnostics {
  toolRejections: number
  output: 'not-observed' | 'accepted' | 'empty-or-oversized'
  failure?: StrategyFailure
  toolCalls?: number
  modelCalls?: number
  executedTools?: readonly string[]
}
export interface StrategyFailure { stage: 'admission' | 'request-limit' | 'meter' | 'reserve' | 'stream' | 'usage' | 'settlement'; dispatched: boolean }
export type StrategyTerminationReason = 'deadline' | 'parent-authority-changed' | 'cancelled' | 'execution-failed' | 'unconfirmed-stop' | 'completed' | 'skipped-direct' | 'recovered-unknown' | 'unknown'

/**
 * Read-only repetition view for one advice *request* within a goal-definition
 * cluster. Only content hashes leave the ledger; advice plaintext never does.
 */
export interface StrategyAdviceRequestRepetition {
  requestDigest: string
  /** Settled advice runs that carried this exact request. */
  occurrences: number
  /** Distinct advice output hashes produced; `occurrences - distinctOutputs` is the repeated-advice count. */
  distinctOutputDigests: number
  lastGoalId: string
  lastCompletedAt: number
}

/**
 * Read-only, cross goal-instance aggregation of settled strategy advice for one
 * content-bound goal definition. `situation` equals the trusted evolution
 * learning situation (`goal-definition:<definitionDigest>`), so an external
 * learning host can correlate advice repetition with trusted failure episodes
 * without either plugin depending on the other.
 */
export interface StrategyAdviceDefinitionSummary {
  situation: string
  definitionDigest: string
  /** Distinct goal instances whose settled advice is covered. */
  goalInstances: number
  adviceRuns: number
  distinctRequests: number
  /** Newest-first, bounded repetition breakdown per request digest. */
  requests: readonly StrategyAdviceRequestRepetition[]
}

export interface StrategyModeTelemetry {
  readonly total: number
  readonly succeeded: number
  readonly failedOrUnknown: number
  readonly avgDurationMs: number
  readonly avgModelCalls: number
  readonly avgToolCalls: number
}

export interface StrategyOutcomeTelemetry {
  readonly totalRuns: number
  readonly adviceRuns: number
  readonly experimentRuns: number
  readonly directRecommendedRuns: number
  readonly failedOrUnknownRuns: number
  readonly byKind: Readonly<Record<StrategyRouteMode, StrategyModeTelemetry>>
}

type Row = { id: string; intent_json: string; state: string; version: number; children_json: string; completed_at: number | null; outcome: string | null; output_digest: string | null; termination_reason: string | null; scope_key: string; goal_id: string; created_at: number }
type Settlement = { children: Array<{ sessionId: string; stopReason: string; quiescent: boolean; diagnostics: StrategyChildDiagnostics }>; outcome: StrategyOutcome; outputDigest?: string; quiescent: boolean; terminationReason: StrategyTerminationReason }

const idPattern = /^[A-Za-z0-9_.:-]{1,512}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const states = new Set<StrategyRecord['state']>(['prepared', 'starting', 'settled', 'unknown'])
const routeModes = new Set<StrategyRouteMode>(['direct', 'investigate', 'review', 'compare', 'experiment', 'subagent'])
const requestedKinds = new Set<StrategyRequestedKind>(['auto', 'investigate', 'review', 'compare', 'experiment', 'subagent'])
const difficulties = new Set<StrategyTaskDifficulty>(['trivial', 'moderate', 'complex'])
const failureTypes = new Set<StrategyFailureType>(['none', 'tool-failure', 'reasoning-failure', 'unknown-execution'])
const outcomes = new Set<StrategyOutcome>(['advice', 'experiment', 'direct-recommended', 'execution-failed', 'cancelled', 'unknown'])
const terminationReasons = new Set<StrategyTerminationReason>(['deadline', 'parent-authority-changed', 'cancelled', 'execution-failed', 'unconfirmed-stop', 'completed', 'skipped-direct', 'recovered-unknown', 'unknown'])
const failureStages = new Set<StrategyFailure['stage']>(['admission', 'request-limit', 'meter', 'reserve', 'stream', 'usage', 'settlement'])
const baseIntentKeys = ['id', 'goalId', 'parentRunId', 'parentSessionId', 'definitionVersion', 'definitionDigest', 'scope', 'kind', 'requestDigest', 'provider', 'model', 'maxChildren', 'maxDurationMs', 'createdAt', 'expiresAt'] as const
const optionalIntentKeys = new Set(['requestedKind', 'routing', 'experiment'])
function fail(code: ConstructorParameters<typeof GoalStoreError>[0]): never { throw new GoalStoreError(code) }
const parse = (value: string): unknown => { try { return JSON.parse(value) } catch { return fail('schema') } }
const same = (left: unknown, right: unknown): boolean => acceptanceDigest(left) === acceptanceDigest(right)
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value) }; return value }
const clone = <T>(value: T): T => freeze(JSON.parse(JSON.stringify(value)) as T)
const text = (value: unknown, maximum = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum
const nonNegativeInt = (value: unknown, maximum = 1_000_000): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum

function scopeInput(value: unknown): GoalScope {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5) fail('invalid-input')
  const scope = value as GoalScope
  if (!text(scope.principalId) || !text(scope.principalRecordId) || !positive(scope.principalVersion, 1_000_000_000) || !text(scope.workspace, 4096) || !scope.workspace.startsWith('/') || !text(scope.preset)) fail('invalid-input')
  return clone({ principalId: scope.principalId, principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion, workspace: scope.workspace, preset: scope.preset })
}

function routingInput(value: unknown): StrategyRoutingSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input')
  const keys = Object.keys(value)
  if (!same(keys.slice().sort(), ['difficulty', 'estimatedCostCalls', 'expectedNetBenefit', 'failureType', 'rationale', 'selectedStrategy'])) fail('invalid-input')
  const input = value as StrategyRoutingSummary
  if (!difficulties.has(input.difficulty) || !failureTypes.has(input.failureType) || !routeModes.has(input.selectedStrategy)
    || typeof input.expectedNetBenefit !== 'number' || !Number.isFinite(input.expectedNetBenefit)
    || typeof input.estimatedCostCalls !== 'number' || !Number.isFinite(input.estimatedCostCalls) || input.estimatedCostCalls < 0
    || !text(input.rationale, 512)) fail('invalid-input')
  return { difficulty: input.difficulty, failureType: input.failureType, selectedStrategy: input.selectedStrategy, expectedNetBenefit: input.expectedNetBenefit, estimatedCostCalls: input.estimatedCostCalls, rationale: input.rationale }
}

function experimentIntentInput(value: unknown): StrategyExperimentIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input')
  const keys = Object.keys(value)
  if (!same(keys.slice().sort(), ['allowedTools', 'maxModelCalls', 'maxToolCalls', 'workspaceWriteAllowed'])) fail('invalid-input')
  const input = value as StrategyExperimentIntent
  if (!Array.isArray(input.allowedTools) || input.allowedTools.length > 32 || !input.allowedTools.every(item => text(item, 128))
    || !nonNegativeInt(input.maxToolCalls, 64) || !positive(input.maxModelCalls, 32) || typeof input.workspaceWriteAllowed !== 'boolean') fail('invalid-input')
  return { allowedTools: [...input.allowedTools], maxToolCalls: input.maxToolCalls, maxModelCalls: input.maxModelCalls, workspaceWriteAllowed: input.workspaceWriteAllowed }
}

function intentInput(value: unknown): StrategyIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input')
  const keys = Object.keys(value)
  if (!baseIntentKeys.every(key => keys.includes(key)) || keys.some(key => !(baseIntentKeys as readonly string[]).includes(key) && !optionalIntentKeys.has(key))) fail('invalid-input')
  const input = value as StrategyIntent
  if (![input.id, input.goalId, input.parentRunId, input.parentSessionId].every(item => typeof item === 'string' && idPattern.test(item))
    || !positive(input.definitionVersion, 1_000_000_000) || !digestPattern.test(input.definitionDigest) || !digestPattern.test(input.requestDigest)
    || !routeModes.has(input.kind) || !text(input.provider) || !text(input.model)
    || (input.kind === 'direct' ? input.maxChildren !== 0 : !positive(input.maxChildren, 2))
    || !positive(input.maxDurationMs, 300_000) || !time(input.createdAt) || !time(input.expiresAt)
    || input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > input.maxDurationMs) fail('invalid-input')
  if (input.requestedKind !== undefined && !requestedKinds.has(input.requestedKind)) fail('invalid-input')
  const scope = scopeInput(input.scope)
  const routing = input.routing === undefined ? undefined : routingInput(input.routing)
  const experiment = input.experiment === undefined ? undefined : experimentIntentInput(input.experiment)
  return clone({ id: input.id, goalId: input.goalId, parentRunId: input.parentRunId, parentSessionId: input.parentSessionId, definitionVersion: input.definitionVersion, definitionDigest: input.definitionDigest, scope, kind: input.kind, requestDigest: input.requestDigest, provider: input.provider, model: input.model, maxChildren: input.maxChildren, maxDurationMs: input.maxDurationMs, createdAt: input.createdAt, expiresAt: input.expiresAt,
    ...(input.requestedKind === undefined ? {} : { requestedKind: input.requestedKind }),
    ...(routing === undefined ? {} : { routing }),
    ...(experiment === undefined ? {} : { experiment }) })
}

function diagnosticsInput(value: unknown): StrategyChildDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input')
  const keys = Object.keys(value)
  if (!keys.includes('toolRejections') || !keys.includes('output')
    || keys.some(key => !['toolRejections', 'output', 'failure', 'toolCalls', 'modelCalls', 'executedTools'].includes(key))) fail('invalid-input')
  const input = value as StrategyChildDiagnostics
  if (!nonNegativeInt(input.toolRejections) || !['not-observed', 'accepted', 'empty-or-oversized'].includes(input.output)) fail('invalid-input')
  if (input.failure !== undefined && (!input.failure || typeof input.failure !== 'object' || Array.isArray(input.failure)
    || !same(Object.keys(input.failure).sort(), ['dispatched', 'stage']) || !failureStages.has(input.failure.stage) || typeof input.failure.dispatched !== 'boolean')) fail('invalid-input')
  if (input.toolCalls !== undefined && !nonNegativeInt(input.toolCalls)) fail('invalid-input')
  if (input.modelCalls !== undefined && !nonNegativeInt(input.modelCalls)) fail('invalid-input')
  if (input.executedTools !== undefined && (!Array.isArray(input.executedTools) || input.executedTools.length > 64 || !input.executedTools.every(item => text(item, 128)))) fail('invalid-input')
  return clone({ toolRejections: input.toolRejections, output: input.output,
    ...(input.failure === undefined ? {} : { failure: { stage: input.failure.stage, dispatched: input.failure.dispatched } }),
    ...(input.toolCalls === undefined ? {} : { toolCalls: input.toolCalls }),
    ...(input.modelCalls === undefined ? {} : { modelCalls: input.modelCalls }),
    ...(input.executedTools === undefined ? {} : { executedTools: [...input.executedTools] }) })
}

function childrenInput(value: unknown, maximum: number): Array<{ sessionId: string; stopReason: string; quiescent: boolean; diagnostics?: StrategyChildDiagnostics }> {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid-input')
  const children = value.map(child => {
    if (!child || typeof child !== 'object' || Array.isArray(child) || ![3, 4].includes(Object.keys(child).length)) fail('invalid-input')
    const input = child as { sessionId: unknown; stopReason: unknown; quiescent: unknown; diagnostics: unknown }
    if (!Object.keys(input).every(key => key === 'sessionId' || key === 'stopReason' || key === 'quiescent' || key === 'diagnostics')
      || (typeof input.sessionId !== 'string' || !idPattern.test(input.sessionId)) || !text(input.stopReason) || typeof input.quiescent !== 'boolean') fail('invalid-input')
    return { sessionId: input.sessionId as string, stopReason: input.stopReason as string, quiescent: input.quiescent, ...(input.diagnostics === undefined ? {} : { diagnostics: diagnosticsInput(input.diagnostics) }) }
  })
  if (new Set(children.map(child => child.sessionId)).size !== children.length) fail('invalid-input')
  return clone(children)
}

function settlementInput(value: unknown, maxChildren: number): Settlement {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![4, 5].includes(Object.keys(value).length)) fail('invalid-input')
  const input = value as Settlement
  const keys = Object.keys(input)
  if (!keys.every(key => ['children', 'outcome', 'outputDigest', 'quiescent', 'terminationReason'].includes(key)) || !keys.includes('children') || !keys.includes('outcome') || !keys.includes('quiescent') || !keys.includes('terminationReason') || (keys.length === 5 && !keys.includes('outputDigest'))
    || !outcomes.has(input.outcome) || !terminationReasons.has(input.terminationReason) || typeof input.quiescent !== 'boolean' || (input.outputDigest !== undefined && !digestPattern.test(input.outputDigest))) fail('invalid-input')
  const children = childrenInput(input.children, maxChildren)
  if (children.some(child => child.diagnostics === undefined)) fail('invalid-input')
  return clone({ children: children as Settlement['children'], outcome: input.outcome, ...(input.outputDigest === undefined ? {} : { outputDigest: input.outputDigest }), quiescent: input.quiescent, terminationReason: input.terminationReason })
}

function record(row: Row): StrategyRecord {
  const intent = intentInput(parse(row.intent_json))
  if (!states.has(row.state as StrategyRecord['state']) || !positive(row.version, 1_000_000_000) || row.scope_key !== acceptanceCanonicalJson(intent.scope) || row.goal_id !== intent.goalId || row.created_at !== intent.createdAt) fail('schema')
  const children = childrenInput(parse(row.children_json), intent.maxChildren)
  const completedAt = row.completed_at === null ? undefined : time(row.completed_at) ? row.completed_at : fail('schema')
  const outcome = row.outcome === null ? undefined : outcomes.has(row.outcome as StrategyOutcome) ? row.outcome as StrategyOutcome : fail('schema')
  const outputDigest = row.output_digest === null ? undefined : digestPattern.test(row.output_digest) ? row.output_digest : fail('schema')
  const terminationReason = row.termination_reason === null ? undefined : terminationReasons.has(row.termination_reason as StrategyTerminationReason) ? row.termination_reason as StrategyTerminationReason : fail('schema')
  if (row.state === 'prepared' && (children.length !== 0 || completedAt !== undefined || outcome !== undefined || outputDigest !== undefined || terminationReason !== undefined)) fail('schema')
  if (row.state === 'starting' && (completedAt !== undefined || outcome !== undefined || outputDigest !== undefined || terminationReason !== undefined)) fail('schema')
  if ((row.state === 'settled' || row.state === 'unknown') && (completedAt === undefined || outcome === undefined || terminationReason === undefined || completedAt < intent.createdAt)) fail('schema')
  if (row.state === 'unknown' && outcome !== 'unknown') fail('schema')
  return freeze({ intent, state: row.state as StrategyRecord['state'], version: row.version, children, ...(completedAt === undefined ? {} : { completedAt }), ...(outcome === undefined ? {} : { outcome }), ...(outputDigest === undefined ? {} : { outputDigest }), ...(terminationReason === undefined ? {} : { terminationReason }) })
}

const V3_TABLE_SQL = `(id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','starting','settled','unknown')), version INTEGER NOT NULL, children_json TEXT NOT NULL, completed_at INTEGER, outcome TEXT CHECK(outcome IN ('advice','experiment','direct-recommended','execution-failed','cancelled','unknown')), output_digest TEXT, scope_key TEXT NOT NULL, goal_id TEXT NOT NULL, created_at INTEGER NOT NULL, termination_reason TEXT CHECK(termination_reason IN ('deadline','parent-authority-changed','cancelled','execution-failed','unconfirmed-stop','completed','skipped-direct','recovered-unknown','unknown'))) STRICT`

/** Private durable ledger. A recovered intent is terminally unknown and is never replayed. */
export class GoalStrategyStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      if (version === 0 && tables.length === 0) this.#database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE goal_strategy_records ${V3_TABLE_SQL};
        CREATE INDEX goal_strategy_scope_goal_created ON goal_strategy_records(scope_key, goal_id, created_at DESC, id ASC);
        PRAGMA user_version = 3; COMMIT;`)
      else if ((version === 1 || version === 2) && same(tables, ['goal_strategy_records'])) {
        this.#database.exec('BEGIN IMMEDIATE;')
        try {
          this.#validate(version === 1)
          const terminationExpr = version === 1 ? "CASE WHEN state IN ('settled', 'unknown') THEN 'unknown' ELSE NULL END" : 'termination_reason'
          this.#database.exec(`
            CREATE TABLE goal_strategy_records_v3 ${V3_TABLE_SQL};
            INSERT INTO goal_strategy_records_v3(id, intent_json, state, version, children_json, completed_at, outcome, output_digest, scope_key, goal_id, created_at, termination_reason)
            SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, scope_key, goal_id, created_at, ${terminationExpr}
            FROM goal_strategy_records;
            DROP TABLE goal_strategy_records;
            ALTER TABLE goal_strategy_records_v3 RENAME TO goal_strategy_records;
            CREATE INDEX goal_strategy_scope_goal_created ON goal_strategy_records(scope_key, goal_id, created_at DESC, id ASC);
            PRAGMA user_version = 3;`)
          this.#validate(false)
          this.#database.exec('COMMIT;')
        } catch (error) { try { this.#database.exec('ROLLBACK;') } catch {}; throw error }
      }
      else if (version !== 3 || !same(tables, ['goal_strategy_records'])) fail('schema')
      this.#validate(false)
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }
  #validate(legacyV1 = false): void {
    const columns = (this.#database.prepare('PRAGMA table_info(goal_strategy_records)').all() as Array<{ name: string }>).map(row => row.name)
    const schema = this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_strategy_records'").get() as { sql: string } | undefined
    if (!schema || !same(columns, ['id', 'intent_json', 'state', 'version', 'children_json', 'completed_at', 'outcome', 'output_digest', 'scope_key', 'goal_id', 'created_at', ...(legacyV1 ? [] : ['termination_reason'])]) || !/\bSTRICT\b/u.test(schema.sql)) fail('schema')
    const index = this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'goal_strategy_scope_goal_created'").get() as { name: string } | undefined
    if (!index) fail('schema')
    const check = this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string }; if (check.quick_check !== 'ok') fail('schema')
    for (const row of this.#database.prepare(`SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, ${legacyV1 ? "CASE WHEN state IN ('settled', 'unknown') THEN 'unknown' ELSE NULL END AS termination_reason" : 'termination_reason'}, scope_key, goal_id, created_at FROM goal_strategy_records`).all() as Row[]) { const value = record(row); if (value.intent.id !== row.id) fail('schema') }
  }
  #get(id: string): StrategyRecord | undefined {
    const row = this.#database.prepare('SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, termination_reason, scope_key, goal_id, created_at FROM goal_strategy_records WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : record(row)
  }
  #write(sql: string, ...values: SQLInputValue[]): number { try { return Number(this.#database.prepare(sql).run(...values).changes) } catch { fail('conflict') } }
  prepare(input: StrategyIntent): { record: StrategyRecord; created: boolean } {
    const intent = intentInput(input)
    this.#database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = this.#get(intent.id)
      if (existing) { if (!same(existing.intent, intent)) fail('conflict'); this.#database.exec('COMMIT;'); return freeze({ record: existing, created: false }) }
      this.#write("INSERT INTO goal_strategy_records(id, intent_json, state, version, children_json, scope_key, goal_id, created_at) VALUES (?, ?, 'prepared', 1, '[]', ?, ?, ?)", intent.id, JSON.stringify(intent), acceptanceCanonicalJson(intent.scope), intent.goalId, intent.createdAt)
      const result = this.#get(intent.id)!; this.#database.exec('COMMIT;'); return freeze({ record: result, created: true })
    } catch (error) { try { this.#database.exec('ROLLBACK;') } catch {} throw error }
  }
  /** Persists the provider-construction attempt before the native driver starts it. */
  dispatch(id: string, expectedVersion: number, now: number): StrategyRecord {
    if (!idPattern.test(id) || !positive(expectedVersion, 1_000_000_000) || !time(now)) fail('invalid-input')
    const found = this.#get(id); if (!found) fail('not-found')
    if (found.state !== 'prepared' || found.version !== expectedVersion || now < found.intent.createdAt || now >= found.intent.expiresAt) fail('conflict')
    if (this.#write("UPDATE goal_strategy_records SET state = 'starting', version = version + 1 WHERE id = ? AND state = 'prepared' AND version = ?", id, expectedVersion) !== 1) fail('conflict')
    return this.#get(id)!
  }
  bindChild(id: string, expectedVersion: number, sessionId: string, now: number): StrategyRecord {
    if (!idPattern.test(id) || !positive(expectedVersion, 1_000_000_000) || !idPattern.test(sessionId) || !time(now)) fail('invalid-input')
    const found = this.#get(id); if (!found) fail('not-found')
    if (found.state !== 'starting' || found.version !== expectedVersion || now < found.intent.createdAt || now >= found.intent.expiresAt || found.children.length >= found.intent.maxChildren || found.children.some(child => child.sessionId === sessionId)) fail('conflict')
    const children = [...found.children, { sessionId, stopReason: 'pending', quiescent: false, diagnostics: { toolRejections: 0, output: 'not-observed' as const } }]
    if (this.#write("UPDATE goal_strategy_records SET children_json = ?, version = version + 1 WHERE id = ? AND state = 'starting' AND version = ?", JSON.stringify(children), id, expectedVersion) !== 1) fail('conflict')
    return this.#get(id)!
  }
  settle(id: string, expectedVersion: number, input: Settlement, now: number): StrategyRecord {
    if (!idPattern.test(id) || !positive(expectedVersion, 1_000_000_000) || !time(now)) fail('invalid-input')
    const found = this.#get(id); if (!found) fail('not-found')
    const value = settlementInput(input, found.intent.maxChildren)
    if (found.state !== 'starting' || found.version !== expectedVersion || now < found.intent.createdAt) fail('conflict')
    const bound = new Set(found.children.map(child => child.sessionId)); const settled = new Set(value.children.map(child => child.sessionId))
    if (bound.size !== settled.size || [...bound].some(sessionId => !settled.has(sessionId)) || (bound.size === 0 && (value.outcome === 'advice' || value.outcome === 'experiment'))) fail('conflict')
    const incomplete = value.children.some(child => child.stopReason === 'pending' || !child.quiescent)
    const state = value.quiescent && !incomplete && value.outcome !== 'unknown' ? 'settled' : 'unknown'
    const outcome = state === 'settled' ? value.outcome : 'unknown'
    const outputDigest = state === 'settled' ? value.outputDigest ?? null : null
    if (this.#write('UPDATE goal_strategy_records SET state = ?, version = version + 1, children_json = ?, completed_at = ?, outcome = ?, output_digest = ?, termination_reason = ? WHERE id = ? AND state = \'starting\' AND version = ?', state, JSON.stringify(value.children), now, outcome, outputDigest, value.terminationReason, id, expectedVersion) !== 1) fail('conflict')
    return this.#get(id)!
  }
  inspect(scope: StrategyScope, id: string): StrategyRecord | undefined {
    if (!idPattern.test(id)) fail('invalid-input'); const key = acceptanceCanonicalJson(scopeInput(scope))
    const row = this.#database.prepare('SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, termination_reason, scope_key, goal_id, created_at FROM goal_strategy_records WHERE id = ? AND scope_key = ?').get(id, key) as Row | undefined
    return row === undefined ? undefined : record(row)
  }
  list(scope: StrategyScope, goalId: string, limit = 20): readonly StrategyRecord[] {
    if (!idPattern.test(goalId) || !positive(limit, 100)) fail('invalid-input'); const key = acceptanceCanonicalJson(scopeInput(scope))
    const rows = this.#database.prepare('SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, termination_reason, scope_key, goal_id, created_at FROM goal_strategy_records WHERE scope_key = ? AND goal_id = ? ORDER BY created_at DESC, id ASC LIMIT ?').all(key, goalId, limit) as Row[]
    return freeze(rows.map(record))
  }
  /**
   * Read-only cross-instance aggregation for the learning host. Groups every
   * settled advice run in one scope by the goal definition's content digest
   * (which is exactly the trusted evolution situation key), and reports how
   * often identical advice *requests* recur and whether they keep producing the
   * same output. Advice plaintext is never stored here, so only hashes leave.
   * Purely observational: it takes no writer lock and never mutates the ledger.
   */
  summarizeAdviceByDefinition(scope: StrategyScope, options: { limit?: number; requestLimit?: number } = {}): readonly StrategyAdviceDefinitionSummary[] {
    const key = acceptanceCanonicalJson(scopeInput(scope))
    const limit = options.limit ?? 100
    const requestLimit = options.requestLimit ?? 20
    if (!positive(limit, 200) || !positive(requestLimit, 100)) fail('invalid-input')
    const rows = this.#database.prepare(`
      SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest,
        termination_reason, scope_key, goal_id, created_at
      FROM goal_strategy_records
      WHERE scope_key = ? AND state = 'settled' AND outcome = 'advice' AND output_digest IS NOT NULL
      ORDER BY completed_at DESC, id DESC
      LIMIT ?
    `).all(key, limit) as Row[]
    interface RequestAgg { requestDigest: string; occurrences: number; outputs: Set<string>; lastGoalId: string; lastCompletedAt: number }
    interface DefinitionAgg { definitionDigest: string; goals: Set<string>; adviceRuns: number; requests: Map<string, RequestAgg> }
    const byDefinition = new Map<string, DefinitionAgg>()
    for (const row of rows) {
      const value = record(row)
      if (value.outcome !== 'advice' || value.outputDigest === undefined || value.completedAt === undefined) continue
      let agg = byDefinition.get(value.intent.definitionDigest)
      if (agg === undefined) {
        agg = { definitionDigest: value.intent.definitionDigest, goals: new Set(), adviceRuns: 0, requests: new Map() }
        byDefinition.set(value.intent.definitionDigest, agg)
      }
      agg.goals.add(value.intent.goalId)
      agg.adviceRuns += 1
      let requestAgg = agg.requests.get(value.intent.requestDigest)
      if (requestAgg === undefined) {
        requestAgg = { requestDigest: value.intent.requestDigest, occurrences: 0, outputs: new Set(), lastGoalId: value.intent.goalId, lastCompletedAt: value.completedAt }
        agg.requests.set(value.intent.requestDigest, requestAgg)
      }
      requestAgg.occurrences += 1
      requestAgg.outputs.add(value.outputDigest)
      if (value.completedAt > requestAgg.lastCompletedAt) {
        requestAgg.lastCompletedAt = value.completedAt
        requestAgg.lastGoalId = value.intent.goalId
      }
    }
    return freeze([...byDefinition.values()].map(agg => {
      const requests = [...agg.requests.values()]
        .sort((left, right) => right.occurrences - left.occurrences
          || right.lastCompletedAt - left.lastCompletedAt
          || left.requestDigest.localeCompare(right.requestDigest))
        .slice(0, requestLimit)
        .map(item => freeze({
          requestDigest: item.requestDigest,
          occurrences: item.occurrences,
          distinctOutputDigests: item.outputs.size,
          lastGoalId: item.lastGoalId,
          lastCompletedAt: item.lastCompletedAt,
        }))
      return freeze({
        situation: goalDefinitionSituation(agg.definitionDigest),
        definitionDigest: agg.definitionDigest,
        goalInstances: agg.goals.size,
        adviceRuns: agg.adviceRuns,
        distinctRequests: agg.requests.size,
        requests,
      })
    }).sort((left, right) => right.adviceRuns - left.adviceRuns
      || left.situation.localeCompare(right.situation)))
  }

  /**
   * Read-only telemetry aggregation of settled and unknown strategy runs for
   * coordination cost/benefit optimization. Emits only counts and averages;
   * never returns plaintext.
   */
  summarizeStrategyOutcomes(scope: StrategyScope, options: { definitionDigest?: string; limit?: number } = {}): StrategyOutcomeTelemetry {
    const key = acceptanceCanonicalJson(scopeInput(scope))
    const limit = options.limit ?? 100
    if (!positive(limit, 200)) fail('invalid-input')
    if (options.definitionDigest !== undefined && !digestPattern.test(options.definitionDigest)) fail('invalid-input')
    const rows = this.#database.prepare(`
      SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest,
        termination_reason, scope_key, goal_id, created_at
      FROM goal_strategy_records
      WHERE scope_key = ? AND state IN ('settled', 'unknown')
      ORDER BY completed_at DESC, id DESC
      LIMIT ?
    `).all(key, limit) as Row[]

    const empty = () => ({ total: 0, succeeded: 0, failedOrUnknown: 0, durationSum: 0, modelCallsSum: 0, toolCallsSum: 0 })
    const buckets: Record<StrategyRouteMode, ReturnType<typeof empty>> = {
      direct: empty(), investigate: empty(), review: empty(), compare: empty(), experiment: empty(), subagent: empty(),
    }
    let totalRuns = 0
    let adviceRuns = 0
    let experimentRuns = 0
    let directRecommendedRuns = 0
    let failedOrUnknownRuns = 0

    for (const row of rows) {
      const value = record(row)
      if (options.definitionDigest !== undefined && value.intent.definitionDigest !== options.definitionDigest) continue
      if (value.completedAt === undefined || value.outcome === undefined) continue
      totalRuns += 1
      const bucket = buckets[value.intent.kind]
      bucket.total += 1
      bucket.durationSum += Math.max(0, value.completedAt - value.intent.createdAt)
      let modelCalls = 0
      let toolCalls = 0
      for (const child of value.children) {
        modelCalls += child.diagnostics?.modelCalls ?? (child.stopReason === 'completed' ? 1 : 0)
        toolCalls += child.diagnostics?.toolCalls ?? 0
      }
      bucket.modelCallsSum += modelCalls
      bucket.toolCallsSum += toolCalls
      if (value.outcome === 'advice') {
        adviceRuns += 1
        bucket.succeeded += 1
      } else if (value.outcome === 'experiment') {
        experimentRuns += 1
        bucket.succeeded += 1
      } else if (value.outcome === 'direct-recommended') {
        directRecommendedRuns += 1
        bucket.succeeded += 1
      } else {
        failedOrUnknownRuns += 1
        bucket.failedOrUnknown += 1
      }
    }

    const finalize = (mode: StrategyRouteMode): StrategyModeTelemetry => {
      const bucket = buckets[mode]
      return freeze({
        total: bucket.total,
        succeeded: bucket.succeeded,
        failedOrUnknown: bucket.failedOrUnknown,
        avgDurationMs: bucket.total === 0 ? 0 : Math.round(bucket.durationSum / bucket.total),
        avgModelCalls: bucket.total === 0 ? 0 : Number((bucket.modelCallsSum / bucket.total).toFixed(3)),
        avgToolCalls: bucket.total === 0 ? 0 : Number((bucket.toolCallsSum / bucket.total).toFixed(3)),
      })
    }

    return freeze({
      totalRuns,
      adviceRuns,
      experimentRuns,
      directRecommendedRuns,
      failedOrUnknownRuns,
      byKind: freeze({
        direct: finalize('direct'),
        investigate: finalize('investigate'),
        review: finalize('review'),
        compare: finalize('compare'),
        experiment: finalize('experiment'),
        subagent: finalize('subagent'),
      }),
    })
  }

  recoverIncomplete(now: number): void {
    if (!time(now)) fail('invalid-input')
    this.#write("UPDATE goal_strategy_records SET state = 'unknown', version = version + 1, completed_at = ?, outcome = 'unknown', output_digest = NULL, termination_reason = 'recovered-unknown' WHERE state IN ('prepared', 'starting')", now)
  }
  close(): void { this.#database.close() }
}
