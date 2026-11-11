import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from './types.js'
import type { GoalRecord } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'
import { validateGoalOwnerIntent, type GoalOwnerIntent, type GoalOwnerIntentSupplier } from './owner-intent.js'

type Row = {
  goal_id: string; intent_json: string; intent_digest: string; definition_digest: string; recorded_at: number
}
type StoredIntent = Readonly<{ intent: GoalOwnerIntent; definitionDigest: string }>
const HEX = /^[a-f0-9]{64}$/u
const goalId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function fail(code: ConstructorParameters<typeof GoalStoreError>[0]): never { throw new GoalStoreError(code) }
function parse(value: string): unknown { try { return JSON.parse(value) } catch { return fail('schema') } }

/**
 * Budget-facing supplier lookup for one business goal.
 *
 * A missing ledger or a missing row means "no frozen owner intent" and never
 * rejects. A row whose definition digest no longer matches the live goal
 * definition means the binding expired (for example after an out-of-band native
 * edit); that must fail closed instead of silently dropping the supplier pin.
 */
export function goalOwnerIntentSupplier(store: GoalOwnerIntentStore | undefined,
  record: Pick<GoalRecord, 'id' | 'definition'>): GoalOwnerIntentSupplier | undefined {
  if (store === undefined) return undefined
  const stored = store.inspect(record.id)
  if (stored === undefined) return undefined
  if (stored.definitionDigest !== record.definition.digest) {
    throw new Error('assistant-goals: frozen owner intent is stale for the current goal definition')
  }
  return stored.intent.supplier
}

/**
 * Side ledger binding one frozen owner intent to one business goal id.
 *
 * The intent digest and the goal definition digest are recorded separately:
 * the intent is immutable, while the definition digest fences the exact
 * objective revision the owner authorized at creation time. Reopening the
 * database revalidates every row, so an edited or truncated side file fails
 * closed instead of silently producing a different objective.
 */
export class GoalOwnerIntentStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      if (version === 0 && tables.length === 0) this.#database.exec(`BEGIN IMMEDIATE; CREATE TABLE goal_owner_intents (goal_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, intent_digest TEXT NOT NULL, definition_digest TEXT NOT NULL, recorded_at INTEGER NOT NULL) STRICT; PRAGMA user_version = 1; COMMIT;`)
      else if (version !== 1 || tables.length !== 1 || tables[0] !== 'goal_owner_intents') fail('schema')
      const columns = (this.#database.prepare('PRAGMA table_info(goal_owner_intents)').all() as Array<{ name: string }>).map(row => row.name)
      const sql = (this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_owner_intents'").get() as { sql: string } | undefined)?.sql
      if (JSON.stringify(columns) !== JSON.stringify(['goal_id', 'intent_json', 'intent_digest', 'definition_digest', 'recorded_at']) || !sql || !/\bSTRICT\b/u.test(sql)) fail('schema')
      const check = this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string }; if (check.quick_check !== 'ok') fail('schema')
      for (const row of this.#database.prepare('SELECT goal_id, intent_json, intent_digest, definition_digest, recorded_at FROM goal_owner_intents').all() as Row[]) this.#row(row)
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }

  #row(row: Row): StoredIntent {
    if (!goalId(row.goal_id) || typeof row.intent_digest !== 'string' || !HEX.test(row.intent_digest)
      || typeof row.definition_digest !== 'string' || !HEX.test(row.definition_digest) || !integer(row.recorded_at)) fail('schema')
    let intent: GoalOwnerIntent
    try { intent = validateGoalOwnerIntent(parse(row.intent_json)) } catch { fail('schema') }
    if (acceptanceDigest(intent) !== row.intent_digest) fail('schema')
    return Object.freeze({ intent, definitionDigest: row.definition_digest })
  }

  #get(id: string): StoredIntent | undefined {
    const row = this.#database.prepare('SELECT goal_id, intent_json, intent_digest, definition_digest, recorded_at FROM goal_owner_intents WHERE goal_id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : this.#row(row)
  }

  /** Idempotent by exact intent and definition digest; a different frozen intent conflicts. */
  record(intent: GoalOwnerIntent, id: string, definitionDigest: string): GoalOwnerIntent {
    let value: GoalOwnerIntent
    try { value = validateGoalOwnerIntent(intent) } catch { fail('invalid-input') }
    if (!goalId(id) || typeof definitionDigest !== 'string' || !HEX.test(definitionDigest)) fail('invalid-input')
    return this.#transaction(() => {
      const existing = this.#get(id)
      if (existing !== undefined) {
        if (acceptanceDigest(existing.intent) !== acceptanceDigest(value) || existing.definitionDigest !== definitionDigest) fail('conflict')
        return existing.intent
      }
      try {
        this.#database.prepare('INSERT INTO goal_owner_intents(goal_id, intent_json, intent_digest, definition_digest, recorded_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, JSON.stringify(value), acceptanceDigest(value), definitionDigest, Date.now())
      } catch { fail('conflict') }
      return this.#get(id)!.intent
    })
  }

  get(id: string): GoalOwnerIntent | undefined { return goalId(id) ? this.#get(id)?.intent : fail('invalid-input') }
  /** Row plus the exact definition digest it was frozen against; undefined when absent. */
  inspect(id: string): StoredIntent | undefined { return goalId(id) ? this.#get(id) : fail('invalid-input') }
  #transaction<T>(operation: () => T): T { this.#database.exec('BEGIN IMMEDIATE'); try { const result = operation(); this.#database.exec('COMMIT'); return result } catch (error) { this.#database.exec('ROLLBACK'); throw error } }
  close(): void { this.#database.close() }
}
