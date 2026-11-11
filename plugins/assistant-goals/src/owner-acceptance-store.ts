import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'
import { validateOwnerAcceptanceSeal, type GoalOwnerAcceptanceSeal } from './owner-acceptance.js'

type Row = { goal_id: string; seal_json: string; seal_digest: string; definition_digest: string; recorded_at: number }
const HEX = /^[a-f0-9]{64}$/u
const goalId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function fail(code: ConstructorParameters<typeof GoalStoreError>[0]): never { throw new GoalStoreError(code) }
function parse(value: string): unknown { try { return JSON.parse(value) } catch { return fail('schema') } }

/**
 * Private side ledger binding one sealed owner acceptance to one business goal.
 *
 * The seal is immutable: criteria, bounds, validity, preparer and the sealed
 * outcome handle are frozen together with the exact goal definition digest they
 * authorize. Reopening the database revalidates every row, so an edited or
 * truncated side file fails closed instead of silently authorizing a different
 * specification.
 */
export class GoalOwnerAcceptanceStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      if (version === 0 && tables.length === 0) this.#database.exec(`BEGIN IMMEDIATE; CREATE TABLE goal_owner_acceptance (goal_id TEXT PRIMARY KEY, seal_json TEXT NOT NULL, seal_digest TEXT NOT NULL, definition_digest TEXT NOT NULL, recorded_at INTEGER NOT NULL) STRICT; PRAGMA user_version = 1; COMMIT;`)
      else if (version !== 1 || tables.length !== 1 || tables[0] !== 'goal_owner_acceptance') fail('schema')
      const columns = (this.#database.prepare('PRAGMA table_info(goal_owner_acceptance)').all() as Array<{ name: string }>).map(row => row.name)
      const sql = (this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_owner_acceptance'").get() as { sql: string } | undefined)?.sql
      if (JSON.stringify(columns) !== JSON.stringify(['goal_id', 'seal_json', 'seal_digest', 'definition_digest', 'recorded_at']) || !sql || !/\bSTRICT\b/u.test(sql)) fail('schema')
      const check = this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string }; if (check.quick_check !== 'ok') fail('schema')
      for (const row of this.#database.prepare('SELECT goal_id, seal_json, seal_digest, definition_digest, recorded_at FROM goal_owner_acceptance').all() as Row[]) this.#row(row)
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }

  #row(row: Row): GoalOwnerAcceptanceSeal {
    if (!goalId(row.goal_id) || typeof row.seal_digest !== 'string' || !HEX.test(row.seal_digest)
      || typeof row.definition_digest !== 'string' || !HEX.test(row.definition_digest) || !integer(row.recorded_at)) fail('schema')
    let seal: GoalOwnerAcceptanceSeal
    try { seal = validateOwnerAcceptanceSeal(parse(row.seal_json)) } catch { fail('schema') }
    if (seal.goalId !== row.goal_id || seal.definition.digest !== row.definition_digest
      || acceptanceDigest(seal) !== row.seal_digest) fail('schema')
    return seal
  }

  #get(id: string): GoalOwnerAcceptanceSeal | undefined {
    const row = this.#database.prepare('SELECT goal_id, seal_json, seal_digest, definition_digest, recorded_at FROM goal_owner_acceptance WHERE goal_id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : this.#row(row)
  }

  /** Idempotent by exact seal; a different seal for the same goal conflicts. */
  record(seal: GoalOwnerAcceptanceSeal): GoalOwnerAcceptanceSeal {
    let value: GoalOwnerAcceptanceSeal
    try { value = validateOwnerAcceptanceSeal(seal) } catch { fail('invalid-input') }
    return this.#transaction(() => {
      const existing = this.#get(value.goalId)
      if (existing !== undefined) {
        if (acceptanceDigest(existing) !== acceptanceDigest(value)) fail('conflict')
        return existing
      }
      try {
        this.#database.prepare('INSERT INTO goal_owner_acceptance(goal_id, seal_json, seal_digest, definition_digest, recorded_at) VALUES (?, ?, ?, ?, ?)')
          .run(value.goalId, JSON.stringify(value), acceptanceDigest(value), value.definition.digest, Date.now())
      } catch { fail('conflict') }
      return this.#get(value.goalId)!
    })
  }

  get(id: string): GoalOwnerAcceptanceSeal | undefined { return goalId(id) ? this.#get(id) : fail('invalid-input') }
  #transaction<T>(operation: () => T): T { this.#database.exec('BEGIN IMMEDIATE'); try { const result = operation(); this.#database.exec('COMMIT'); return result } catch (error) { this.#database.exec('ROLLBACK'); throw error } }
  close(): void { this.#database.close() }
}
