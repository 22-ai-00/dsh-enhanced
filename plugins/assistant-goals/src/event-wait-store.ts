import { DatabaseSync } from 'node:sqlite'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { canonicalExternalEventEnvelope, externalEventDigest, parseExternalEventEnvelope, type ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import { GoalStoreError, type GoalScope } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'
import { validateGoalWakeIntent, type GoalWakeIntent } from './wake-store.js'

export interface GoalEventSourceSnapshot {
  protocol: 'dsh-event-source/v1'
  sourceId: string
  kind: 'file' | 'http-json' | 'webhook' | 'github-repository' | 'lark-calendar'
  version: string
  configDigest: string
  target: { automationId: string }
  highWaterSequence: number
}
export interface GoalEventWaitIntent {
  id: string
  wake: Omit<GoalWakeIntent, 'id' | 'at' | 'expiresAt'>
  source: GoalEventSourceSnapshot
  createdAt: number
  expiresAt: number
  runTimeoutMs: number
  /** Frozen owner-selected opportunity profile. Absent preserves the original wait semantics. */
  opportunityProfile?: string
}
export interface GoalEventWait {
  intent: GoalEventWaitIntent
  state: 'waiting' | 'matched' | 'materialized' | 'terminal'
  reason?: 'denied' | 'expired' | 'source-changed' | 'invalid-current' | 'settled'
  match?: { sequence: number; envelope: Readonly<ExternalEventEnvelope>; digest: string; wake: GoalWakeIntent }
}
type Row = { id: string; intent_json: string; state: GoalEventWait['state']; reason: string | null; sequence: number | null; envelope_canonical: string | null; envelope_digest: string | null; wake_json: string | null; scope_key: string; goal_id: string; session_id: string; native_goal_id: string; native_revision: number; source_cursor: number }
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u
const digest = /^[a-f0-9]{64}$/u
function fail(code: ConstructorParameters<typeof GoalStoreError>[0] = 'invalid-input'): never { throw new GoalStoreError(code) }
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && id.test(value)
const same = (a: unknown, b: unknown) => acceptanceDigest(a) === acceptanceDigest(b)
const freeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value) }; return value }
const parse = (value: string): unknown => { try { return JSON.parse(value) } catch { return fail('schema') } }
function source(value: unknown): GoalEventSourceSnapshot {
  if (!exact(value, ['protocol', 'sourceId', 'kind', 'version', 'configDigest', 'target', 'highWaterSequence']) || value.protocol !== 'dsh-event-source/v1'
    || !text(value.sourceId) || !['file', 'http-json', 'webhook', 'github-repository', 'lark-calendar'].includes(value.kind as string) || !text(value.version, 200)
    || typeof value.configDigest !== 'string' || !digest.test(value.configDigest) || !exact(value.target, ['automationId']) || !text(value.target.automationId)
    || !integer(value.highWaterSequence)) fail()
  const input = value as Record<string, unknown>; const target = input.target as Record<string, unknown>
  return freeze({ protocol: input.protocol as 'dsh-event-source/v1', sourceId: input.sourceId as string, kind: input.kind as GoalEventSourceSnapshot['kind'], version: input.version as string, configDigest: input.configDigest as string, target: { automationId: target.automationId as string }, highWaterSequence: input.highWaterSequence as number })
}
export function validateGoalEventWaitIntent(value: GoalEventWaitIntent): GoalEventWaitIntent {
  const keys = Object.hasOwn(value, 'opportunityProfile') ? ['id', 'wake', 'source', 'createdAt', 'expiresAt', 'runTimeoutMs', 'opportunityProfile'] : ['id', 'wake', 'source', 'createdAt', 'expiresAt', 'runTimeoutMs']
  if (!exact(value, keys) || !text(value.id) || !integer(value.createdAt) || !integer(value.expiresAt) || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 31 * 86_400_000 || !integer(value.runTimeoutMs) || value.runTimeoutMs < 1_000 || value.runTimeoutMs > 300_000 || (Object.hasOwn(value, 'opportunityProfile') && !text(value.opportunityProfile))) fail()
  const wake = value.wake as GoalWakeIntent
  // Use the wake ledger's authoritative validator, with temporary valid scheduling fields.
  const validated = validateGoalWakeIntent({ ...wake, id: `event-validate:${value.id}`, at: value.createdAt, expiresAt: value.createdAt + value.runTimeoutMs })
  const snapshot = source(value.source)
  return freeze({ id: value.id, wake: (({ id: _id, at: _at, expiresAt: _expiresAt, ...rest }) => rest)(validated), source: snapshot, createdAt: value.createdAt, expiresAt: value.expiresAt, runTimeoutMs: value.runTimeoutMs, ...(value.opportunityProfile === undefined ? {} : { opportunityProfile: value.opportunityProfile }) })
}
function matchedInput(intent: GoalEventWaitIntent, sequence: number, envelopeInput: unknown, wakeInput: GoalWakeIntent, code: ConstructorParameters<typeof GoalStoreError>[0]): { envelope: Readonly<ExternalEventEnvelope>; wake: GoalWakeIntent } {
  if (!integer(sequence, intent.source.highWaterSequence + 1)) fail(code)
  let envelope: Readonly<ExternalEventEnvelope>; let wake: GoalWakeIntent
  try { envelope = parseExternalEventEnvelope(envelopeInput); wake = validateGoalWakeIntent(wakeInput) } catch { fail(code) }
  const { id: _id, at: _at, expiresAt: _expiresAt, ...base } = wake
  if (envelope.source.id !== intent.source.sourceId || envelope.source.kind !== intent.source.kind || envelope.source.version !== intent.source.version
    || envelope.source.configDigest !== intent.source.configDigest || envelope.target.automationId !== intent.source.target.automationId
    || envelope.event.receivedAt > intent.expiresAt
    || !same(base, intent.wake) || wake.id !== `goal-event-wake-${intent.id}` || wake.at < intent.createdAt
    || wake.expiresAt !== Math.min(intent.expiresAt, wake.at + intent.runTimeoutMs)) fail(code)
  return { envelope, wake }
}
function wait(row: Row): GoalEventWait {
  const intent = validateGoalEventWaitIntent(parse(row.intent_json) as GoalEventWaitIntent)
  if (row.id !== intent.id || row.scope_key !== acceptanceCanonicalJson(intent.wake.scope) || row.goal_id !== intent.wake.goalId || row.session_id !== intent.wake.native.sessionId || row.native_goal_id !== intent.wake.native.goalId || row.native_revision !== intent.wake.native.revision || !integer(row.source_cursor, intent.source.highWaterSequence)) fail('schema')
  if (!['waiting', 'matched', 'materialized', 'terminal'].includes(row.state)) fail('schema')
  const hasMatch = row.sequence !== null || row.envelope_canonical !== null || row.envelope_digest !== null || row.wake_json !== null
  const completeMatch = row.sequence !== null && row.envelope_canonical !== null && row.envelope_digest !== null && row.wake_json !== null
  if (hasMatch !== completeMatch || (row.state === 'waiting' && hasMatch) || ((row.state === 'matched' || row.state === 'materialized') && !completeMatch)) fail('schema')
  if (row.state === 'terminal') { if (!['denied', 'expired', 'source-changed', 'invalid-current', 'settled'].includes(row.reason ?? '')) fail('schema') } else if (row.reason !== null) fail('schema')
  if (!completeMatch) return freeze({ intent, state: row.state, ...(row.reason === null ? {} : { reason: row.reason as NonNullable<GoalEventWait['reason']> }) })
  if (!integer(row.sequence!, 1) || !digest.test(row.envelope_digest!)) fail('schema')
  const envelope = parseExternalEventEnvelope(parse(row.envelope_canonical!))
  if (canonicalExternalEventEnvelope(envelope) !== row.envelope_canonical || externalEventDigest(envelope) !== row.envelope_digest!) fail('schema')
  const matchedWake = validateGoalWakeIntent(parse(row.wake_json!) as GoalWakeIntent)
  matchedInput(intent, row.sequence!, envelope, matchedWake, 'schema')
  return freeze({ intent, state: row.state, ...(row.reason === null ? {} : { reason: row.reason as NonNullable<GoalEventWait['reason']> }), match: { sequence: row.sequence!, envelope, digest: row.envelope_digest!, wake: matchedWake } })
}

/** Private, immutable ledger for source observations which may authorize one wake. */
export class GoalEventWaitStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      if (version === 0 && tables.length === 0) this.#database.exec("BEGIN IMMEDIATE; CREATE TABLE goal_event_waits (id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('waiting','matched','materialized','terminal')), reason TEXT, sequence INTEGER, envelope_canonical TEXT, envelope_digest TEXT, wake_json TEXT, scope_key TEXT NOT NULL, goal_id TEXT NOT NULL, session_id TEXT NOT NULL, native_goal_id TEXT NOT NULL, native_revision INTEGER NOT NULL, source_cursor INTEGER NOT NULL) STRICT; CREATE UNIQUE INDEX goal_event_wait_native_once ON goal_event_waits(scope_key, session_id, native_goal_id, native_revision); CREATE INDEX goal_event_wait_pending ON goal_event_waits(state, id); PRAGMA user_version = 2; COMMIT;")
      else if (version === 1 && same(tables, ['goal_event_waits'])) this.#database.exec('BEGIN IMMEDIATE; ALTER TABLE goal_event_waits ADD COLUMN source_cursor INTEGER NOT NULL DEFAULT 0; UPDATE goal_event_waits SET source_cursor = json_extract(intent_json, \'$.source.highWaterSequence\'); PRAGMA user_version = 2; COMMIT;')
      else if (version !== 2 || !same(tables, ['goal_event_waits'])) fail('schema')
      const columns = (this.#database.prepare('PRAGMA table_info(goal_event_waits)').all() as Array<{ name: string }>).map(row => row.name)
      if (!same(columns, ['id', 'intent_json', 'state', 'reason', 'sequence', 'envelope_canonical', 'envelope_digest', 'wake_json', 'scope_key', 'goal_id', 'session_id', 'native_goal_id', 'native_revision', 'source_cursor'])) fail('schema')
      const table = (this.#database.prepare('PRAGMA table_list').all() as Array<{ name: string; strict: number }>).find(row => row.name === 'goal_event_waits')
      const indexes = this.#database.prepare('PRAGMA index_list(goal_event_waits)').all() as Array<{ name: string; unique: number; partial: number }>
      if (table?.strict !== 1 || !indexes.some(row => row.name === 'goal_event_wait_native_once' && row.unique === 1 && row.partial === 0)) fail('schema')
      const uniqueColumns = (this.#database.prepare('PRAGMA index_info(goal_event_wait_native_once)').all() as Array<{ name: string }>).map(row => row.name)
      if (!same(uniqueColumns, ['scope_key', 'session_id', 'native_goal_id', 'native_revision'])) fail('schema')
      if ((this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check !== 'ok') fail('schema')
      for (const row of this.#allRows()) wait(row)
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }
  #allRows(): Row[] { return this.#database.prepare('SELECT id, intent_json, state, reason, sequence, envelope_canonical, envelope_digest, wake_json, scope_key, goal_id, session_id, native_goal_id, native_revision, source_cursor FROM goal_event_waits').all() as Row[] }
  #get(idValue: string): GoalEventWait | undefined { const row = this.#database.prepare('SELECT id, intent_json, state, reason, sequence, envelope_canonical, envelope_digest, wake_json, scope_key, goal_id, session_id, native_goal_id, native_revision, source_cursor FROM goal_event_waits WHERE id = ?').get(idValue) as Row | undefined; return row === undefined ? undefined : wait(row) }
  get(idValue: string): GoalEventWait | undefined { return text(idValue) ? this.#get(idValue) : fail() }
  /** Exact indexed lookup; callers must still validate the returned immutable intent. */
  forNative(scope: GoalScope, goalId: string, native: Readonly<{ sessionId: string; goalId: string; revision: number }>): GoalEventWait | undefined {
    if (!scope || typeof scope !== 'object' || !text(goalId) || !text(native?.sessionId) || !text(native?.goalId) || !integer(native?.revision, 1)) fail()
    const row = this.#database.prepare('SELECT id, intent_json, state, reason, sequence, envelope_canonical, envelope_digest, wake_json, scope_key, goal_id, session_id, native_goal_id, native_revision, source_cursor FROM goal_event_waits WHERE scope_key = ? AND goal_id = ? AND session_id = ? AND native_goal_id = ? AND native_revision = ?').get(
      acceptanceCanonicalJson(scope), goalId, native.sessionId, native.goalId, native.revision,
    ) as Row | undefined
    return row === undefined ? undefined : wait(row)
  }
  prepare(input: GoalEventWaitIntent): GoalEventWait { const intent = validateGoalEventWaitIntent(input); return this.#tx(() => { const old = this.#get(intent.id); if (old) { if (!same(old.intent, intent)) fail('conflict'); return old }; try { this.#database.prepare("INSERT INTO goal_event_waits(id, intent_json, state, scope_key, goal_id, session_id, native_goal_id, native_revision, source_cursor) VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?)").run(intent.id, JSON.stringify(intent), acceptanceCanonicalJson(intent.wake.scope), intent.wake.goalId, intent.wake.native.sessionId, intent.wake.native.goalId, intent.wake.native.revision, intent.source.highWaterSequence) } catch { fail('conflict') }; return this.#get(intent.id)! }) }
  cursor(idValue: string): number { const row = this.#get(idValue); if (!row) fail('not-found'); const value = this.#database.prepare('SELECT source_cursor FROM goal_event_waits WHERE id = ?').get(idValue) as { source_cursor: number }; return value.source_cursor }
  advanceCursor(idValue: string, sequence: number): GoalEventWait { if (!text(idValue) || !integer(sequence, 1)) fail(); return this.#tx(() => { const old = this.#get(idValue); if (!old || old.state !== 'waiting' || sequence <= old.intent.source.highWaterSequence) fail('conflict'); const current = this.cursor(idValue); if (sequence < current) fail('conflict'); if (sequence > current && Number(this.#database.prepare("UPDATE goal_event_waits SET source_cursor = ? WHERE id = ? AND state = 'waiting' AND source_cursor = ?").run(sequence, idValue, current).changes) !== 1) fail('conflict'); return this.#get(idValue)! }) }
  match(idValue: string, input: { sequence: number; envelope: ExternalEventEnvelope; wake: GoalWakeIntent }): GoalEventWait { if (!text(idValue) || !integer(input.sequence, 1)) fail(); return this.#tx(() => { const old = this.#get(idValue); if (!old) fail('not-found'); const { envelope, wake } = matchedInput(old.intent, input.sequence, input.envelope, input.wake, 'invalid-input'); if (old.state === 'matched' || old.state === 'materialized') { if (old.match!.sequence !== input.sequence || !same(old.match!.wake, wake) || old.match!.digest !== externalEventDigest(envelope)) fail('conflict'); return old }; if (old.state !== 'waiting') fail('conflict'); if (Number(this.#database.prepare("UPDATE goal_event_waits SET state = 'matched', sequence = ?, envelope_canonical = ?, envelope_digest = ?, wake_json = ? WHERE id = ? AND state = 'waiting'").run(input.sequence, canonicalExternalEventEnvelope(envelope), externalEventDigest(envelope), JSON.stringify(wake), idValue).changes) !== 1) fail('conflict'); return this.#get(idValue)! }) }
  materialized(idValue: string): GoalEventWait { return this.#tx(() => { const old = this.#get(idValue); if (!old) fail('not-found'); if (old.state === 'materialized') return old; if (old.state !== 'matched' || Number(this.#database.prepare("UPDATE goal_event_waits SET state = 'materialized' WHERE id = ? AND state = 'matched'").run(idValue).changes) !== 1) fail('conflict'); return this.#get(idValue)! }) }
  terminal(idValue: string, reason: NonNullable<GoalEventWait['reason']>): GoalEventWait { return this.#tx(() => { const old = this.#get(idValue); if (!old) fail('not-found'); if (old.state === 'terminal') { if (old.reason !== reason) fail('conflict'); return old }; if (!['denied', 'expired', 'source-changed', 'invalid-current', 'settled'].includes(reason)) fail('conflict'); if (Number(this.#database.prepare("UPDATE goal_event_waits SET state = 'terminal', reason = ? WHERE id = ? AND state IN ('waiting','matched','materialized')").run(reason, idValue).changes) !== 1) fail('conflict'); return this.#get(idValue)! }) }
  pending(afterId = '', limit = 32): readonly GoalEventWait[] { if (typeof afterId !== 'string' || !integer(limit, 1) || limit > 100) fail(); return freeze((this.#database.prepare("SELECT id FROM goal_event_waits WHERE state IN ('waiting','matched','materialized') AND id > ? ORDER BY id LIMIT ?").all(afterId, limit) as Array<{ id: string }>).map(row => this.#get(row.id)!)) }
  list(scope: GoalScope, goalId: string, limit = 20): readonly GoalEventWait[] { if (!text(goalId) || !integer(limit, 1) || limit > 100) fail(); return freeze((this.#database.prepare('SELECT id FROM goal_event_waits WHERE scope_key = ? AND goal_id = ? ORDER BY id DESC LIMIT ?').all(acceptanceCanonicalJson(scope), goalId, limit) as Array<{ id: string }>).map(row => this.#get(row.id)!)) }
  #tx<T>(operation: () => T): T { this.#database.exec('BEGIN IMMEDIATE'); try { const value = operation(); this.#database.exec('COMMIT'); return value } catch (error) { this.#database.exec('ROLLBACK'); throw error } }
  close(): void { this.#database.close() }
}
