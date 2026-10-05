import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const h = (letter: string): string => letter.repeat(64)
const planId = 'v32-source-plan'
const gapId = 'v32-gap'
const at = 1_800_000_000_000

// Fixed historical v32 source_plans shape (cd85c81, after its v28→v29
// prepared-create migration). This deliberately does not derive the old table
// from the implementation under test.
const V32_SOURCE_PLANS = `CREATE TABLE source_plans_v32_fixture (
  id TEXT PRIMARY KEY,
  plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest) = 64),
  gap_id TEXT NOT NULL,
  gap_snapshot_json TEXT NOT NULL CHECK(json_valid(gap_snapshot_json) AND json_type(gap_snapshot_json) = 'object'),
  repository TEXT NOT NULL,
  worktree TEXT NOT NULL,
  base_commit TEXT NOT NULL CHECK(length(base_commit) = 40),
  plugin_name TEXT NOT NULL,
  generator_digest TEXT NOT NULL CHECK(length(generator_digest) = 64),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json) = 'array'),
  mode TEXT NOT NULL DEFAULT 'create' CHECK(mode IN ('create', 'modify', 'prepared-create')),
  status TEXT NOT NULL CHECK(status IN (
    'expired', 'pending-approval', 'approved', 'running-local-checks', 'ready-for-human-review', 'local-checks-failed',
    'awaiting-pr', 'awaiting-review', 'awaiting-merge', 'awaiting-build', 'awaiting-sign', 'awaiting-publish',
    'awaiting-registry-verify', 'awaiting-catalog-admission', 'release-complete', 'release-failed', 'publish-ambiguous'
  )),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)),
  checked_tree_digest TEXT CHECK(checked_tree_digest IS NULL OR (length(checked_tree_digest) = 64 AND checked_tree_digest NOT GLOB '*[^a-f0-9]*')),
  checked_patch_digest TEXT CHECK(checked_patch_digest IS NULL OR (length(checked_patch_digest) = 64 AND checked_patch_digest NOT GLOB '*[^a-f0-9]*')),
  checked_at INTEGER,
  prepared_evidence_json TEXT CHECK(prepared_evidence_json IS NULL OR
    (json_valid(prepared_evidence_json) AND json_type(prepared_evidence_json) = 'object')),
  creation_json TEXT CHECK(creation_json IS NULL OR (json_valid(creation_json) AND json_type(creation_json) = 'object')),
  release_authorization_json TEXT CHECK(release_authorization_json IS NULL OR (json_valid(release_authorization_json) AND json_type(release_authorization_json) = 'object')),
  release_authorization_digest TEXT CHECK(release_authorization_digest IS NULL OR length(release_authorization_digest) = 64),
  release_id TEXT,
  release_fence INTEGER NOT NULL DEFAULT 0 CHECK(release_fence >= 0),
  release_failure_phase TEXT CHECK(release_failure_phase IS NULL OR release_failure_phase IN (
    'pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'
  )),
  release_failure_code TEXT,
  updated_at INTEGER NOT NULL,
  CHECK((checked_tree_digest IS NULL AND checked_patch_digest IS NULL AND checked_at IS NULL) OR
    (checked_tree_digest IS NOT NULL AND checked_patch_digest IS NOT NULL AND checked_at IS NOT NULL)),
  CHECK(mode = 'create' OR (checked_tree_digest IS NOT NULL AND checked_patch_digest IS NOT NULL AND checked_at IS NOT NULL)),
  CHECK((mode = 'create' AND prepared_evidence_json IS NULL) OR
    (mode IN ('modify', 'prepared-create') AND prepared_evidence_json IS NOT NULL)),
  CHECK((mode = 'prepared-create' AND creation_json IS NOT NULL) OR (mode IN ('create', 'modify') AND creation_json IS NULL)),
  CHECK((release_authorization_json IS NULL AND release_authorization_digest IS NULL) OR
    (release_authorization_json IS NOT NULL AND release_authorization_digest IS NOT NULL)),
  FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
) STRICT`

function temporaryPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'cp-revision-migration-')); roots.push(root)
  const path = join(root, 'control.sqlite')
  closeSync(openSync(path, 'w', 0o600))
  return path
}

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function schema(db: DatabaseSync, table: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string } | undefined)?.sql
}

function rows(db: DatabaseSync, table: string): readonly Record<string, unknown>[] {
  if (!/^[a-z_]+$/u.test(table)) throw Error('bad fixture table')
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Record<string, unknown>[]
}

const historicalTables = ['capability_gaps', 'source_plans', 'gap_plan_claims', 'source_job_authorities', 'source_jobs',
  'source_creation_grants', 'source_creation_verifications', 'source_prepared_artifacts', 'source_prepared_artifact_refs',
  'source_release_operations', 'source_release_dispatches', 'operation_receipts'] as const

function populate(db: DatabaseSync): void {
  db.prepare(`INSERT INTO capability_gaps (id,idempotency_key,input_digest,capability,context,expected_value,frequency,
    estimated_cost,risk,roi,status,candidate_id,revision,created_at,updated_at)
    VALUES (?,?,?,'owner-tool','v32 fixture',2,1,1,0.1,2,'matched',NULL,3,?,?)`)
    .run(gapId, 'gap:v32', h('a'), at, at)
  db.prepare(`INSERT INTO source_plans (id,plan_digest,gap_id,gap_snapshot_json,repository,worktree,base_commit,
    plugin_name,generator_digest,scope_json,mode,status,revision,created_at,expires_at,checked_tree_digest,
    checked_patch_digest,checked_at,prepared_evidence_json,creation_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'prepared-create','pending-approval',3,?,?,?,?,?,?,?,?)`).run(
    planId, h('b'), gapId, '{"legacy":true}', '/repository', '/private-worktree', 'c'.repeat(40),
    'owner-tool', h('d'), '["plugins/owner-tool","plugins/README.md","pnpm-lock.yaml"]',
    at, at + 60_000, h('e'), h('f'), at + 1, '{"checked":"v32"}', '{"grant":"old-creation"}', at + 2)
  db.prepare('INSERT INTO gap_plan_claims (gap_id,plan_id,plan_kind,claimed_at) VALUES (?,? ,\'source\',?)')
    .run(gapId, planId, at)
  db.prepare(`INSERT INTO source_job_authorities (authority_id,authority_digest,expires_at,max_submissions,submissions)
    VALUES ('job-authority',?,?,2,1)`).run(h('1'), at + 60_000)
  db.prepare(`INSERT INTO source_jobs (id,automation_id,authority_id,idempotency_key,intent_json,intent_digest,
    status,revision,created_at,expires_at,definition_hash,occurrence_id,plan_id,updated_at)
    VALUES ('job-v32','automation-v32','job-authority','job:key','{"exact":"intent"}',?,'prepared',4,?,?,?,?,?,?)`)
    .run(h('2'), at, at + 60_000, h('3'), 'occurrence-v32', planId, at + 2)
  db.prepare(`INSERT INTO source_creation_grants (grant_id,grant_digest,expires_at,max_creates,creates)
    VALUES ('creation-grant-v32',?,?,1,1)`).run(h('4'), at + 60_000)
  db.prepare(`INSERT INTO source_creation_verifications
    (plan_id,status,certificate_json,certificate_digest,reason,created_at,updated_at)
    VALUES (?,'verified','{"historical":"certificate"}',?,NULL,?,?)`).run(planId, h('5'), at, at + 2)
  const artifact = Buffer.from([0, 255, 10, 13])
  db.prepare('INSERT INTO source_prepared_artifacts (pack_sha256,size_bytes,bytes,created_at) VALUES (?,?,?,?)')
    .run(h('6'), artifact.length, artifact, at)
  db.prepare('INSERT INTO source_prepared_artifact_refs (plan_id,pack_sha256) VALUES (?,?)').run(planId, h('6'))
  db.prepare(`INSERT INTO source_release_operations (plan_id,phase,release_id,release_fence,attempt,operation_id,
    binding_digest,request_digest,request_json,status,receipt_digest,receipt_json,created_at,completed_at)
    VALUES (?,'pr','release-v32',1,1,'release-operation-v32',?,?,'{"request":"old"}','completed',?,
      '{"receipt":"signed-v32"}',?,?)`).run(planId, h('7'), h('8'), h('9'), at, at + 1)
  db.prepare(`INSERT INTO source_release_dispatches (operation_id,status,claimed_at,completed_at)
    VALUES ('release-operation-v32','completed',?,?)`).run(at, at + 1)
  db.prepare(`INSERT INTO operation_receipts
    (idempotency_key,operation,input_digest,result_json,result_digest,created_at)
    VALUES ('receipt-v32','prepare',?,'{"bytes":"unchanged"}',?,?)`).run(h('0'), h('a'), at)
}

function downgradeToV32(path: string, oldTable = V32_SOURCE_PLANS): void {
  const db = new DatabaseSync(path)
  try {
    const columns = (db.prepare('PRAGMA table_info(source_plans)').all() as { name: string }[])
      .map(row => row.name).filter(name => name !== 'revision_json')
    const list = columns.map(name => `"${name}"`).join(',')
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
    try {
      db.exec(`DROP TABLE source_revision_sources; DROP TABLE source_revision_verifications; DROP TABLE source_revision_grants;
        ${oldTable}; INSERT INTO source_plans_v32_fixture (${list}) SELECT ${list} FROM source_plans;
        DROP TABLE source_plans; ALTER TABLE source_plans_v32_fixture RENAME TO source_plans;
        CREATE INDEX source_plans_fixture_status ON source_plans(status,id);
        PRAGMA user_version=32; COMMIT`)
    } catch (error) { db.exec('ROLLBACK'); throw error }
    finally { db.exec('PRAGMA foreign_keys=ON') }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { db.close() }
}

function populatedV32(): string {
  const path = temporaryPath()
  const fresh = openControlPlaneDatabase(path)
  try { populate(fresh) } finally { fresh.close() }
  downgradeToV32(path)
  return path
}

test('populated v32 ledger upgrades without rewriting old plans, quota, jobs, artifacts or receipts', () => {
  const path = populatedV32()
  const before = new DatabaseSync(path)
  const oldColumns = (before.prepare('PRAGMA table_info(source_plans)').all() as { name: string }[]).map(row => row.name)
  const oldRows = new Map(historicalTables.map(table => [table, rows(before, table)]))
  const oldIndex = before.prepare("SELECT sql FROM sqlite_schema WHERE name='source_plans_fixture_status'").get()
  expect(version(before)).toBe(32)
  expect(schema(before, 'source_plans')).toContain("mode IN ('create', 'modify', 'prepared-create')")
  expect(schema(before, 'source_plans')).not.toContain('revision_json')
  before.close()

  const migrated = openControlPlaneDatabase(path)
  try {
    expect(version(migrated)).toBe(controlPlaneSchemaVersion)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    for (const table of historicalTables) {
      if (table === 'source_plans') {
        const selected = oldColumns.map(name => `"${name}"`).join(',')
        expect(migrated.prepare(`SELECT ${selected} FROM source_plans ORDER BY id`).all()).toEqual(oldRows.get(table))
      } else expect(rows(migrated, table)).toEqual(oldRows.get(table))
    }
    expect(migrated.prepare("SELECT sql FROM sqlite_schema WHERE name='source_plans_fixture_status'").get()).toEqual(oldIndex)
    expect(migrated.prepare('SELECT creates,max_creates FROM source_creation_grants').get()).toEqual({ creates: 1, max_creates: 1 })
    expect(() => migrated.prepare('UPDATE source_creation_grants SET creates=2').run()).toThrow()
    expect(migrated.prepare('SELECT hex(bytes) AS bytes FROM source_prepared_artifacts').get()).toEqual({ bytes: '00FF0A0D' })
    expect(schema(migrated, 'source_prepared_artifacts')).toContain('size_bytes <= 33554432')
    expect(migrated.prepare('SELECT revision_json FROM source_plans WHERE id=?').get(planId)).toEqual({ revision_json: null })
    const insertRevision = migrated.prepare(`INSERT INTO source_plans
      (id,plan_digest,gap_id,gap_snapshot_json,repository,worktree,base_commit,plugin_name,generator_digest,
        scope_json,mode,status,revision,created_at,expires_at,checked_tree_digest,checked_patch_digest,checked_at,
        prepared_evidence_json,revision_json,updated_at)
      VALUES (?, ?, ?, '{}','/repository','/revision-worktree',?,'owner-tool',?,
        '["plugins/owner-tool","plugins/README.md","pnpm-lock.yaml"]','prepared-revise','pending-approval',1,
        ?,?,?,?,?,?, ?,?)`)
    insertRevision.run('revision-plan-v33', h('e'), gapId, 'c'.repeat(40), h('d'),
      at, at + 60_000, h('e'), h('f'), at + 1, '{}', '{"parent":"old-plan"}', at + 2)
    expect(migrated.prepare("SELECT revision_json FROM source_plans WHERE id='revision-plan-v33'").get())
      .toEqual({ revision_json: '{"parent":"old-plan"}' })
    expect(() => insertRevision.run('revision-missing-binding', h('f'), gapId, 'c'.repeat(40), h('d'),
      at, at + 60_000, h('e'), h('f'), at + 1, '{}', null, at + 2)).toThrow()
    migrated.prepare(`INSERT INTO source_revision_grants (grant_id,grant_digest,expires_at,max_revisions,revisions)
      VALUES ('revision-grant',?,?,1,1)`).run(h('b'), at + 60_000)
    migrated.prepare(`INSERT INTO source_revision_verifications
      (plan_id,status,certificate_json,certificate_digest,reason,created_at,updated_at)
      VALUES (?,'verified','{"revision":"signed"}',?,NULL,?,?)`).run(planId, h('c'), at, at + 2)
    migrated.prepare(`INSERT INTO source_revision_sources (plan_id,source_json)
      VALUES (?, '{"archive":"exact"}')`).run(planId)
    expect(() => migrated.prepare(`INSERT INTO source_revision_sources (plan_id,source_json)
      VALUES ('missing-plan','{}')`).run()).toThrow()
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { migrated.close() }
  const reopened = openControlPlaneDatabase(path)
  try {
    expect(version(reopened)).toBe(33)
    expect(reopened.prepare('SELECT source_json FROM source_revision_sources WHERE plan_id=?').get(planId))
      .toEqual({ source_json: '{"archive":"exact"}' })
    expect(reopened.prepare('SELECT creates FROM source_creation_grants').get()).toEqual({ creates: 1 })
  } finally { reopened.close() }
})

test('fresh database starts at v33 and v32 unknown table shape fails before a partial migration', () => {
  const freshPath = temporaryPath()
  const fresh = openControlPlaneDatabase(freshPath)
  try {
    expect(version(fresh)).toBe(33)
    expect(schema(fresh, 'source_revision_grants')).toContain('max_revisions')
    expect(schema(fresh, 'source_revision_verifications')).toContain('certificate_json')
    expect(schema(fresh, 'source_revision_sources')).toContain('source_json')
  } finally { fresh.close() }
  const path = populatedV32()
  const db = new DatabaseSync(path)
  try {
    db.exec("DROP INDEX source_plans_fixture_status; ALTER TABLE source_plans RENAME COLUMN creation_json TO alien_json")
  } finally { db.close() }
  expect(() => openControlPlaneDatabase(path)).toThrow(/unknown v32 source plan schema/)
  const preserved = new DatabaseSync(path)
  try {
    expect(version(preserved)).toBe(32)
    expect(rows(preserved, 'source_jobs')).toHaveLength(1)
    expect(schema(preserved, 'source_revision_grants')).toBeUndefined()
    expect(preserved.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { preserved.close() }
})

test('an error after the v32 table copy rolls back its schema, rows and version', () => {
  const path = populatedV32()
  const before = new DatabaseSync(path)
  const oldPlan = rows(before, 'source_plans')
  before.exec('CREATE VIEW source_revision_grants AS SELECT id FROM source_plans')
  before.close()
  expect(() => openControlPlaneDatabase(path)).toThrow()
  const after = new DatabaseSync(path)
  try {
    expect(version(after)).toBe(32)
    expect(rows(after, 'source_plans')).toEqual(oldPlan)
    expect(rows(after, 'source_jobs')).toHaveLength(1)
    expect(schema(after, 'source_plans')).toContain("mode IN ('create', 'modify', 'prepared-create')")
    expect(schema(after, 'source_plans_v33')).toBeUndefined()
    expect(schema(after, 'source_revision_verifications')).toBeUndefined()
    expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { after.close() }
})

test.each([28, 31, 32])('synthetic v33 version rollback to v%i keeps populated rows', lowered => {
  const path = temporaryPath()
  const created = openControlPlaneDatabase(path)
  try { populate(created) } finally { created.close() }
  const db = new DatabaseSync(path)
  const oldJob = rows(db, 'source_jobs')
  const oldPlan = rows(db, 'source_plans')
  db.exec(`PRAGMA user_version=${lowered}`)
  db.close()
  const reopened = openControlPlaneDatabase(path)
  try {
    expect(version(reopened)).toBe(33)
    expect(rows(reopened, 'source_jobs')).toEqual(oldJob)
    expect(rows(reopened, 'source_plans')).toEqual(oldPlan)
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { reopened.close() }
})
