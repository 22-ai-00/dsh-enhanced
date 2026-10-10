import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (digit: string): string => digit.repeat(64)
const at = 1_800_000_000_000
const creationPlan = 'created-v33'
const revisionPlan = 'revised-v33'
const historicalTables = ['capability_gaps', 'activation_plans', 'source_plans', 'source_adoptions',
  'source_job_authorities', 'source_jobs', 'source_creation_grants', 'source_creation_verifications',
  'source_revision_grants', 'source_revision_verifications', 'source_revision_sources',
  'source_prepared_artifacts', 'source_prepared_artifact_refs', 'operation_receipts'] as const

function path(): string {
  const root = mkdtempSync(join(tmpdir(), 'cp-regression-migration-')); roots.push(root)
  const database = join(root, 'control.sqlite')
  closeSync(openSync(database, 'w', 0o600))
  return database
}

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function schema(db: DatabaseSync, name: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name) as { sql: string } | undefined)?.sql
}

function rows(db: DatabaseSync, table: typeof historicalTables[number]): readonly Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Record<string, unknown>[]
}

type Value = string | number | Buffer | null
function insert(db: DatabaseSync, table: typeof historicalTables[number], data: Record<string, Value>): void {
  const columns = Object.keys(data)
  db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...Object.values(data))
}

/** Populate real constrained v33 tables, then remove only the v34 addition. */
function populatedV33(): string {
  const location = path()
  const db = openControlPlaneDatabase(location)
  try {
    insert(db, 'capability_gaps', { id: 'gap-v33', idempotency_key: 'gap:key', input_digest: hash('a'),
      capability: 'owner-tool', context: 'old accepted capability', expected_value: 2, frequency: 1,
      estimated_cost: 1, risk: 0.1, roi: 2, status: 'matched', candidate_id: null,
      revision: 3, created_at: at, updated_at: at })
    const commonPlan = { gap_id: 'gap-v33', gap_snapshot_json: '{"historical":true}', repository: '/repository',
      base_commit: 'c'.repeat(40), plugin_name: 'owner-tool', generator_digest: hash('d'),
      scope_json: '["plugins/owner-tool","plugins/README.md","pnpm-lock.yaml"]',
      status: 'pending-approval', revision: 3, created_at: at, expires_at: at + 60_000,
      checked_tree_digest: hash('e'), checked_patch_digest: hash('f'), checked_at: at + 1,
      prepared_evidence_json: '{"checked":"v33"}', updated_at: at + 2 }
    insert(db, 'source_plans', { id: creationPlan, plan_digest: hash('1'), ...commonPlan,
      worktree: '/creation-worktree', mode: 'prepared-create', creation_json: '{"grant":"old"}', revision_json: null })
    insert(db, 'source_plans', { id: revisionPlan, plan_digest: hash('2'), ...commonPlan,
      worktree: '/revision-worktree', mode: 'prepared-revise', creation_json: null, revision_json: '{"parent":"created-v33"}' })
    insert(db, 'activation_plans', { id: 'activation-v33', plan_digest: hash('3'), gap_id: 'gap-v33',
      gap_snapshot_json: '{}', profile: 'web', candidate_json: '{}', dossier_json: '{}',
      installation_id: 'install-v33', ledger_id: 'ledger-v33', ledger_path: '/ledger', dsh_home: '/dsh',
      target_path: '/target', executor_id: 'executor-v33', executor_version: 'v1', executor_path: '/executor',
      executor_digest: hash('4'), status: 'activated', revision: 2, created_at: at,
      expires_at: at + 60_000, updated_at: at + 2 })
    insert(db, 'source_adoptions', { source_plan_id: creationPlan, activation_plan_id: 'activation-v33',
      binding_json: '{"adopted":"old"}', binding_digest: hash('5'), created_at: at + 2 })
    insert(db, 'source_job_authorities', { authority_id: 'job-authority-v33', authority_digest: hash('6'),
      expires_at: at + 60_000, max_submissions: 2, submissions: 1 })
    insert(db, 'source_jobs', { id: 'job-v33', automation_id: 'automation-v33', authority_id: 'job-authority-v33',
      idempotency_key: 'job:key', intent_json: '{"old":"intent"}', intent_digest: hash('7'), status: 'prepared',
      revision: 2, created_at: at, expires_at: at + 60_000, definition_hash: hash('8'),
      occurrence_id: 'occurrence-v33', plan_id: revisionPlan, updated_at: at + 2 })
    insert(db, 'source_creation_grants', { grant_id: 'creation-grant-v33', grant_digest: hash('9'),
      expires_at: at + 60_000, max_creates: 1, creates: 1 })
    insert(db, 'source_revision_grants', { grant_id: 'revision-grant-v33', grant_digest: hash('a'),
      expires_at: at + 60_000, max_revisions: 2, revisions: 1 })
    for (const [table, plan, digest] of [
      ['source_creation_verifications', creationPlan, hash('b')],
      ['source_revision_verifications', revisionPlan, hash('c')],
    ] as const) {
      insert(db, table, { plan_id: plan, status: 'verified', certificate_json: '{"signed":"old"}',
        certificate_digest: digest, reason: null, created_at: at, updated_at: at + 2 })
    }
    insert(db, 'source_revision_sources', { plan_id: revisionPlan, source_json: '{"archive":"exact"}' })
    const bytes = Buffer.from([0, 255, 10, 13])
    insert(db, 'source_prepared_artifacts', { pack_sha256: hash('d'), size_bytes: bytes.length, bytes, created_at: at })
    insert(db, 'source_prepared_artifact_refs', { plan_id: revisionPlan, pack_sha256: hash('d') })
    insert(db, 'operation_receipts', { idempotency_key: 'receipt-v33', operation: 'prepare',
      input_digest: hash('e'), result_json: '{"retained":"receipt"}', result_digest: hash('f'), created_at: at })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.exec('BEGIN IMMEDIATE; DROP TABLE source_revision_regressions; PRAGMA user_version=33; COMMIT')
    expect(version(db)).toBe(33)
    expect(schema(db, 'source_revision_regressions')).toBeUndefined()
  } finally { db.close() }
  return location
}

test('populated v33 source, revision, adoption and consumed quotas survive v34 migration and cold reopen', () => {
  const location = populatedV33()
  const before = new DatabaseSync(location)
  const saved = new Map(historicalTables.map(table => [table, rows(before, table)]))
  const sourceIndex = before.prepare("SELECT sql FROM sqlite_schema WHERE name='source_jobs_created'").get()
  expect(version(before)).toBe(33)
  before.close()

  const migrated = openControlPlaneDatabase(location)
  try {
    expect(version(migrated)).toBe(34)
    for (const table of historicalTables) expect(rows(migrated, table)).toEqual(saved.get(table))
    expect(migrated.prepare("SELECT sql FROM sqlite_schema WHERE name='source_jobs_created'").get()).toEqual(sourceIndex)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const table = migrated.prepare("SELECT wr,strict FROM pragma_table_list WHERE name='source_revision_regressions'")
      .get() as { wr: number; strict: number }
    expect(table).toEqual({ wr: 1, strict: 1 })
    expect(() => migrated.prepare('UPDATE source_creation_grants SET creates=2').run()).toThrow()
    expect(migrated.prepare('SELECT revisions,max_revisions FROM source_revision_grants').get())
      .toEqual({ revisions: 1, max_revisions: 2 })
    migrated.prepare(`INSERT INTO source_revision_regressions
      (plan_id,status,certificate_json,certificate_digest,reason,created_at,updated_at)
      VALUES (?,'verified','{"regression":"signed"}',?,NULL,?,?)`).run(revisionPlan, hash('0'), at, at + 3)
    expect(() => migrated.prepare(`INSERT INTO source_revision_regressions
      (plan_id,status,certificate_json,certificate_digest,reason,created_at,updated_at)
      VALUES ('missing-plan','verified','{}',?,NULL,?,?)`).run(hash('0'), at, at + 3)).toThrow()
    expect(() => migrated.prepare(`UPDATE source_revision_regressions SET status='claimed'
      WHERE plan_id=?`).run(revisionPlan)).toThrow()
  } finally { migrated.close() }

  const reopened = openControlPlaneDatabase(location)
  try {
    expect(version(reopened)).toBe(controlPlaneSchemaVersion)
    expect(reopened.prepare('SELECT status,certificate_json FROM source_revision_regressions WHERE plan_id=?')
      .get(revisionPlan)).toEqual({ status: 'verified', certificate_json: '{"regression":"signed"}' })
    for (const table of historicalTables) expect(rows(reopened, table)).toEqual(saved.get(table))
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { reopened.close() }
})

test('unknown pre-existing v33 regression table is rejected without rewriting old evidence or version', () => {
  const location = populatedV33()
  const before = new DatabaseSync(location)
  before.exec('CREATE TABLE source_revision_regressions(plan_id TEXT PRIMARY KEY, untrusted_json TEXT) STRICT')
  const oldPlan = rows(before, 'source_plans')
  const oldRevision = rows(before, 'source_revision_verifications')
  const oldAdoption = rows(before, 'source_adoptions')
  before.close()
  expect(() => openControlPlaneDatabase(location)).toThrow(/unknown revision regression schema/)
  const after = new DatabaseSync(location)
  try {
    expect(version(after)).toBe(33)
    expect(schema(after, 'source_revision_regressions')).toContain('untrusted_json')
    expect(rows(after, 'source_plans')).toEqual(oldPlan)
    expect(rows(after, 'source_revision_verifications')).toEqual(oldRevision)
    expect(rows(after, 'source_adoptions')).toEqual(oldAdoption)
    expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { after.close() }
})

test('v33 conflicting view rolls back the v34 table creation transaction', () => {
  const location = populatedV33()
  const before = new DatabaseSync(location)
  before.exec('CREATE VIEW source_revision_regressions AS SELECT id AS plan_id FROM source_plans')
  const oldRows = rows(before, 'source_jobs')
  before.close()
  expect(() => openControlPlaneDatabase(location)).toThrow()
  const after = new DatabaseSync(location)
  try {
    expect(version(after)).toBe(33)
    expect(rows(after, 'source_jobs')).toEqual(oldRows)
    expect(schema(after, 'source_revision_regressions')).toBeUndefined()
    expect(after.prepare("SELECT type FROM sqlite_schema WHERE name='source_revision_regressions'").get())
      .toEqual({ type: 'view' })
    expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { after.close() }
})

test.each(['view', 'missing'] as const)('v34 %s regression table fails closed without changing old rows', kind => {
  const location = populatedV33()
  const upgraded = openControlPlaneDatabase(location)
  expect(version(upgraded)).toBe(34)
  upgraded.close()
  const before = new DatabaseSync(location)
  before.exec('DROP TABLE source_revision_regressions')
  if (kind === 'view') before.exec('CREATE VIEW source_revision_regressions AS SELECT id AS plan_id FROM source_plans')
  const oldPlans = rows(before, 'source_plans')
  const oldRevision = rows(before, 'source_revision_verifications')
  const oldAdoption = rows(before, 'source_adoptions')
  before.close()

  expect(() => openControlPlaneDatabase(location)).toThrow(/revision regression schema/)
  const after = new DatabaseSync(location)
  try {
    expect(version(after)).toBe(34)
    expect(schema(after, 'source_revision_regressions')).toBeUndefined()
    expect(after.prepare("SELECT type FROM sqlite_schema WHERE name='source_revision_regressions'").get())
      .toEqual(kind === 'view' ? { type: 'view' } : undefined)
    expect(rows(after, 'source_plans')).toEqual(oldPlans)
    expect(rows(after, 'source_revision_verifications')).toEqual(oldRevision)
    expect(rows(after, 'source_adoptions')).toEqual(oldAdoption)
    expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { after.close() }
})
