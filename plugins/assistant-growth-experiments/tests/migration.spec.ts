import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  growthExperimentsSchemaVersion,
  openGrowthExperimentsDatabase,
} from '../src/sqlite.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const hex = (character: string) => character.repeat(64)

// Minimal but CHECK-faithful v2 schema: growth_experiments exists with the OLD
// state CHECK (no 'proposed-paused') and the old terminal-state compound CHECK.
// Only workflow_candidates (the FK parent) and growth_experiments are needed:
// the v2->v3 migration rebuilds just growth_experiments and leaves everything
// else untouched.
function createV2Database(path: string): void {
  // openGrowthExperimentsDatabase demands a private 0600 file owned by this user.
  closeSync(openSync(path, 'w', 0o600))
  const signature = hex('s')
  const digest = hex('g')
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  database.exec(`
    CREATE TABLE workflow_candidates (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      workspace TEXT NOT NULL,
      preset TEXT NOT NULL,
      owner_binding_id TEXT NOT NULL,
      signature TEXT NOT NULL CHECK (length(signature) = 64),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
      evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
      owner_explicit_count INTEGER NOT NULL CHECK (owner_explicit_count >= 0),
      verified_success_count INTEGER NOT NULL CHECK (verified_success_count >= 0),
      template_json TEXT NOT NULL CHECK (json_valid(template_json) AND json_type(template_json) = 'object'),
      steps_json TEXT NOT NULL CHECK (json_valid(steps_json) AND json_type(steps_json) = 'array'),
      state TEXT NOT NULL CHECK (state IN (
        'conflicted', 'observing', 'promoted', 'ready', 'rejected',
        'retracted', 'rolled-back', 'running'
      )),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE(scope_key, signature)
    ) STRICT;

    CREATE TABLE growth_experiments (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 1),
      candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
      candidate_json TEXT NOT NULL CHECK (
        json_valid(candidate_json) AND json_type(candidate_json) = 'object'
      ),
      state TEXT NOT NULL CHECK (state IN (
        'approval-pending', 'approval-requesting', 'canary-pending', 'conflicted',
        'expired', 'promoted', 'promotion-pending', 'rejected', 'replay-pending',
        'rollback-pending', 'rolled-back', 'shadow-pending'
      )),
      version INTEGER NOT NULL CHECK (version >= 1),
      operation_id TEXT NOT NULL UNIQUE,
      operation_kind TEXT CHECK (operation_kind IS NULL OR operation_kind IN (
        'approval-proposal', 'approval-settlement', 'canary', 'canary-inspection', 'promotion',
        'replay', 'rollback', 'shadow'
      )),
      deadline_at INTEGER NOT NULL CHECK (deadline_at >= 0),
      canary_exposure_count INTEGER NOT NULL CHECK (canary_exposure_count BETWEEN 0 AND 1),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0),
      proposal_id TEXT,
      artifact_id TEXT,
      artifact_version INTEGER CHECK (artifact_version IS NULL OR artifact_version >= 1),
      artifact_digest TEXT CHECK (artifact_digest IS NULL OR length(artifact_digest) = 64),
      terminal_code TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      FOREIGN KEY(candidate_id) REFERENCES workflow_candidates(id) ON DELETE RESTRICT,
      CHECK (
        (artifact_id IS NULL AND artifact_version IS NULL AND artifact_digest IS NULL)
        OR (artifact_id IS NOT NULL AND artifact_version IS NOT NULL AND artifact_digest IS NOT NULL)
      ),
      CHECK (
        (state = 'approval-requesting' AND operation_kind IN ('approval-proposal', 'approval-settlement'))
        OR (state IN ('conflicted', 'expired', 'promoted', 'rejected', 'rolled-back')
          AND operation_kind IS NULL)
        OR state = 'approval-pending'
      )
    ) STRICT;

    INSERT INTO workflow_candidates(
      id, scope_key, workspace, preset, owner_binding_id, signature, revision,
      evidence_digest, evidence_count, owner_explicit_count, verified_success_count,
      template_json, steps_json, state, created_at, updated_at
    ) VALUES (
      'cand-v2', 'scope', '/work/alpha', 'primary', 'owner-main', '${signature}', 1,
      '${digest}', 1, 1, 1,
      '{"templateRef":"workflow.v2"}', '[]', 'running', 100, 100
    );

    INSERT INTO growth_experiments(
      id, candidate_id, candidate_revision, candidate_digest, candidate_json, state, version,
      operation_id, operation_kind, deadline_at, canary_exposure_count, attempt_count, next_attempt_at,
      proposal_id, artifact_id, artifact_version, artifact_digest, terminal_code, created_at, updated_at
    ) VALUES (
      'exp-v2', 'cand-v2', 1, '${digest}', '{"id":"cand-v2"}',
      'approval-requesting', 1, 'exp-v2:approval-request', 'approval-proposal',
      1000, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, 100, 100
    );

    PRAGMA user_version = 2;
  `)
  database.close()
}

describe('growth-experiments sqlite v2 -> v4 cascaded migration', () => {
  it('rebuilds growth_experiments, preserves every row, and admits proposed-paused', () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-migration-')); roots.push(root)
    const path = join(root, 'growth.sqlite')
    createV2Database(path)

    const database = openGrowthExperimentsDatabase(path)
    try {
      const version = database.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(version.user_version).toBe(growthExperimentsSchemaVersion)

      // All 20 columns of the pre-existing experiment survive the copy verbatim.
      const row = database.prepare('SELECT * FROM growth_experiments WHERE id = ?').get('exp-v2') as Record<string, unknown>
      expect(row).toMatchObject({
        id: 'exp-v2', candidate_id: 'cand-v2', state: 'approval-requesting',
        version: 1, operation_kind: 'approval-proposal', proposal_id: null,
        artifact_id: null, terminal_code: null,
      })
      const candidate = database.prepare('SELECT state FROM workflow_candidates WHERE id = ?').get('cand-v2') as { state: string }
      expect(candidate.state).toBe('running')

      // The rebuilt CHECK admits the new terminal state with a NULL operation kind.
      database.prepare(`
        INSERT INTO growth_experiments(
          id, candidate_id, candidate_revision, candidate_digest, candidate_json, state, version,
          operation_id, operation_kind, deadline_at, canary_exposure_count, attempt_count, next_attempt_at,
          proposal_id, artifact_id, artifact_version, artifact_digest, terminal_code, created_at, updated_at
        ) VALUES (
          'exp-paused', 'cand-v2', 1, ?, '{"id":"cand-v2"}',
          'proposed-paused', 1, 'exp-paused:proposed-paused', NULL,
          1000, 0, 0, 0, 'proposal-1', NULL, NULL, NULL, 'proposed-paused-owner-hold', 100, 100
        )
      `).run(hex('g'))
      const paused = database.prepare('SELECT state, operation_kind FROM growth_experiments WHERE id = ?')
        .get('exp-paused') as { state: string; operation_kind: string | null }
      expect(paused).toEqual({ state: 'proposed-paused', operation_kind: null })

      // The cascaded v3 -> v4 step adds the owner-anchored counter, zeroed for
      // every pre-existing candidate.
      const migratedCandidate = database.prepare('SELECT owner_anchored_count FROM workflow_candidates WHERE id = ?')
        .get('cand-v2') as { owner_anchored_count: number }
      expect(migratedCandidate).toEqual({ owner_anchored_count: 0 })

      // The two named lookup indexes are rebuilt (plus an auto-index for the
      // UNIQUE(operation_id) constraint, whose sqlite-internal suffix may differ
      // after a table rebuild).
      const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'growth_experiments'")
        .all() as { name: string }[]
      const names = indexes.map(item => item.name)
      expect(names).toContain('growth_experiments_active')
      expect(names).toContain('growth_experiments_candidate')
      expect(names.some(name => name.startsWith('sqlite_autoindex_growth_experiments_'))).toBe(true)
    } finally {
      database.close()
    }
  })
})
