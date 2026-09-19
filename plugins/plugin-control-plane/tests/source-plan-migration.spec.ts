import { closeSync, openSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../src/store.ts'

// 工程层、非真实供应商证据：本文件只用 SQLite 行级 fixture 验证 v12→v13
// 迁移的形状与 CHECK，不涉及任何真实构建或外部平台。

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const hex = (character: string) => character.repeat(64)

// The exact v12 source_plans DDL (25 columns, no mode / prepared_evidence_json),
// kept verbatim from the pre-v13 schema so the fixture is a genuine old-shaped
// database rather than a v13 table with renamed columns.
const V12_SOURCE_PLANS_DDL = `
  CREATE TABLE source_plans_v12_fixture (
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
    status TEXT NOT NULL CHECK(status IN (
      'pending-approval', 'approved', 'running-local-checks', 'ready-for-human-review', 'local-checks-failed',
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
    CHECK((release_authorization_json IS NULL AND release_authorization_digest IS NULL) OR
      (release_authorization_json IS NOT NULL AND release_authorization_digest IS NOT NULL)),
    FOREIGN KEY(gap_id) REFERENCES capability_gaps(id) ON DELETE RESTRICT
  ) STRICT`

// Rebuild a genuinely old-shaped source_plans table: copy the v13 rows' 25
// shared columns verbatim, dropping mode/prepared_evidence_json entirely.
function downgradeToV12(path: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ${V12_SOURCE_PLANS_DDL};
      INSERT INTO source_plans_v12_fixture (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree, base_commit,
        plugin_name, generator_digest, scope_json, status, revision, created_at, expires_at, approval_json,
        checked_tree_digest, checked_patch_digest, checked_at,
        release_authorization_json, release_authorization_digest, release_id, release_fence,
        release_failure_phase, release_failure_code, updated_at)
      SELECT id, plan_digest, gap_id, gap_snapshot_json, repository, worktree, base_commit,
        plugin_name, generator_digest, scope_json, status, revision, created_at, expires_at, approval_json,
        checked_tree_digest, checked_patch_digest, checked_at,
        release_authorization_json, release_authorization_digest, release_id, release_fence,
        release_failure_phase, release_failure_code, updated_at FROM source_plans;
      DROP TABLE source_plans;
      ALTER TABLE source_plans_v12_fixture RENAME TO source_plans;
      PRAGMA user_version = 12;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `)
  } finally { database.close() }
}

const evidenceJson = JSON.stringify({ schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
  environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v22', pnpmVersion: '9' },
  commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 10, logDigest: hex('l') }],
  pack: { name: 'p.tgz', version: '1.0.0', sizeBytes: 1, sha256: hex('p') }, preparedAt: 100 })

describe('control-plane sqlite v12 -> v13 migration (engineering-layer fixture, not vendor evidence)', () => {
  it('backfills mode=create, keeps plan digests untouched and preserves checked columns', () => {
    const root = mkdtempSync(join(tmpdir(), 'cp-migrate13-')); roots.push(root)
    const path = join(root, 'state.sqlite'); closeSync(openSync(path, 'w', 0o600))
    const now = 1_800_000_000_000

    // Build genuine v13 rows through the store so gap snapshots and immutable
    // plan digests are real values the store can re-read after migration.
    const store = new ControlPlaneStore({ path, now: () => now })
    const gapA = store.recordGap({ idempotencyKey: 'gap:pending', capability: 'health', context: 'ctx a',
      expectedValue: 100, frequency: 10, estimatedCost: 50, risk: 0.2 })
    const gapB = store.recordGap({ idempotencyKey: 'gap:ready', capability: 'health', context: 'ctx b',
      expectedValue: 100, frequency: 10, estimatedCost: 50, risk: 0.2 })
    const planPendingId = store.createSourcePlan({ gapId: gapA.id, repository: '/canonical/repository',
      worktree: '/canonical/worktree-pending', baseCommit: 'a'.repeat(40), name: 'health-helper',
      generatorDigest: hex('b'), scope: ['plugins/README.md', 'plugins/health-helper'],
      ttlMs: 60_000, idempotencyKey: 'source:create:pending' }).result.id
    const planReadyId = store.createSourcePlan({ gapId: gapB.id, repository: '/canonical/repository',
      worktree: '/canonical/worktree-ready', baseCommit: 'a'.repeat(40), name: 'health-helper',
      generatorDigest: hex('c'), scope: ['plugins/README.md', 'plugins/health-helper'],
      ttlMs: 60_000, idempotencyKey: 'source:create:ready' }).result.id
    store.close()
    // Simulate a create plan that has already passed its scaffold checks.
    const raw = new DatabaseSync(path)
    try {
      raw.prepare(`UPDATE source_plans SET status = 'ready-for-human-review', revision = 4,
        checked_tree_digest = ?, checked_patch_digest = ?, checked_at = ? WHERE id = ?`)
        .run(hex('7'), hex('8'), now + 500, planReadyId)
      // Production child rows must survive the parent-table rebuild and retain
      // foreign keys that point at the replacement source_plans table.
      raw.prepare(`INSERT INTO source_release_operations (plan_id, phase, release_id, release_fence, attempt, operation_id,
        binding_digest, request_digest, request_json, status, created_at)
        VALUES (?, 'pr', 'release-fixture', 1, 1, 'operation-fixture', ?, ?, '{}', 'pending', ?)`)
        .run(planReadyId, hex('a'), hex('b'), now)
      raw.prepare(`INSERT INTO source_publish_reconciliations (plan_id, release_id, release_fence, attempt, operation_id,
        binding_digest, request_digest, request_json, status, created_at)
        VALUES (?, 'release-fixture', 1, 1, 'reconcile-fixture', ?, ?, '{}', 'pending', ?)`)
        .run(planReadyId, hex('c'), hex('d'), now)
    } finally { raw.close() }
    // Re-open through the store once for a clean checkpointed shutdown state.
    const closer = new ControlPlaneStore({ path, now: () => now }); closer.close()

    downgradeToV12(path)

    const migrated = openControlPlaneDatabase(path)
    try {
      expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
      // No foreign-key relationships were broken by the table rebuild.
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(migrated.prepare('SELECT count(*) AS n FROM source_release_operations WHERE plan_id = ?').get(planReadyId))
        .toEqual({ n: 1 })
      expect(migrated.prepare('SELECT count(*) AS n FROM source_publish_reconciliations WHERE plan_id = ?').get(planReadyId))
        .toEqual({ n: 1 })

      const pending = migrated.prepare('SELECT * FROM source_plans WHERE id = ?').get(planPendingId) as Record<string, unknown>
      expect(pending['mode']).toBe('create')
      expect(pending['prepared_evidence_json']).toBeNull()
      expect(pending['status']).toBe('pending-approval')
      const ready = migrated.prepare('SELECT * FROM source_plans WHERE id = ?').get(planReadyId) as Record<string, unknown>
      expect(ready['mode']).toBe('create')
      expect(ready['status']).toBe('ready-for-human-review')
      expect(ready['checked_tree_digest']).toBe(hex('7'))
      expect(ready['checked_patch_digest']).toBe(hex('8'))
      expect(ready['checked_at']).toBe(now + 500)
      expect(ready['prepared_evidence_json']).toBeNull()
      expect(migrated.prepare('SELECT count(*) AS n FROM capability_gaps').get() as { n: number }).toMatchObject({ n: 2 })

      // The store layer reads migrated rows as ordinary create plans, and the
      // untouched plan_digest still validates against the recomputed immutable
      // binding (mode deliberately stays out of the digest).
      const reopened = new ControlPlaneStore({ path, now: () => now })
      try {
        const roundTripPending = reopened.getSourcePlan(planPendingId)
        expect(roundTripPending.mode).toBe('create')
        expect(roundTripPending.preparedEvidence).toBeUndefined()
        expect(roundTripPending.sourceCheck).toBeUndefined()
        const roundTripReady = reopened.getSourcePlan(planReadyId)
        expect(roundTripReady.mode).toBe('create')
        expect(roundTripReady.sourceCheck).toEqual({ treeDigest: hex('7'), patchDigest: hex('8'), checkedAt: now + 500 })
        // The matched gap claims survive the migration untouched.
        expect(reopened.listGaps().every(gap => gap.status === 'matched')).toBe(true)
      } finally { reopened.close() }

      // New v13 CHECKs are live on the rebuilt table: modify rows must carry
      // prepared evidence in lockstep with their checked columns.
      const gapId = migrated.prepare('SELECT gap_id FROM source_plans WHERE id = ?').get(planPendingId) as { gap_id: string }
      const modifyWithoutEvidence = `INSERT INTO source_plans (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree,
        base_commit, plugin_name, generator_digest, scope_json, mode, status, revision, created_at, expires_at,
        checked_tree_digest, checked_patch_digest, checked_at, prepared_evidence_json, updated_at)
        VALUES ('plan-bad1', ?, ?, '{"revision":1,"inputDigest":"${hex('g')}","roi":10,"capability":"health"}', '/repo', '/wt',
          ?, 'health-helper', ?, ?, 'modify', 'pending-approval', 1, ?, ?, ?, ?, ?, NULL, ?)`
      expect(() => migrated.prepare(modifyWithoutEvidence).run(
        hex('3'), gapId['gap_id'], 'a'.repeat(40), MODIFY_GENERATOR_DIGEST,
        JSON.stringify(['plugins/health-helper']), now, now + 60_000, hex('7'), hex('8'), now + 500, now)).toThrow()

      // create rows must never carry prepared evidence.
      const createWithEvidence = `INSERT INTO source_plans (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree,
        base_commit, plugin_name, generator_digest, scope_json, mode, status, revision, created_at, expires_at,
        prepared_evidence_json, updated_at)
        VALUES ('plan-bad2', ?, ?, '{"revision":1,"inputDigest":"${hex('g')}","roi":10,"capability":"health"}', '/repo', '/wt',
          ?, 'health-helper', ?, ?, 'create', 'pending-approval', 1, ?, ?, ?, ?)`
      expect(() => migrated.prepare(createWithEvidence).run(
        hex('4'), gapId['gap_id'], 'a'.repeat(40), hex('b'),
        JSON.stringify(['plugins/README.md', 'plugins/health-helper']), now, now + 60_000, evidenceJson, now)).toThrow()

      // A fully-evidenced modify row is admitted by the new table shape.
      migrated.prepare(`INSERT INTO source_plans (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree,
        base_commit, plugin_name, generator_digest, scope_json, mode, status, revision, created_at, expires_at,
        checked_tree_digest, checked_patch_digest, checked_at, prepared_evidence_json, updated_at)
        VALUES ('plan-modify', ?, ?, '{"revision":1,"inputDigest":"${hex('g')}","roi":10,"capability":"health"}', '/repo', '/wt',
          ?, 'health-helper', ?, ?, 'modify', 'pending-approval', 1, ?, ?, ?, ?, ?, ?, ?)`).run(
        hex('5'), gapId['gap_id'], 'a'.repeat(40), MODIFY_GENERATOR_DIGEST,
        JSON.stringify(['plugins/health-helper']), now, now + 60_000, hex('7'), hex('8'), now + 500, evidenceJson, now)
      const modifyRow = migrated.prepare('SELECT mode, prepared_evidence_json FROM source_plans WHERE id = ?')
        .get('plan-modify') as { mode: string; prepared_evidence_json: string }
      expect(modifyRow.mode).toBe('modify')
      expect(JSON.parse(modifyRow.prepared_evidence_json).kind).toBe('dsh-source-prepared-evidence')
    } finally { migrated.close() }
  })
})
