import {
  chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  withPreferenceMemoryPromotionCancellationDigest,
  withPreferenceMemoryPromotionCancellationReceiptDigest,
  withPreferenceMemoryPromotionResultDigest,
  withPreferenceMemoryPromotionSubmissionDigest,
} from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, describe, expect, test } from 'vitest'
import {
  openPreferenceDatabase,
  preferencePromotionCancellationUpgradeBindingDigest,
  preferenceSchemaVersion,
} from '../src/sqlite.ts'
import { PreferenceStore, PreferenceStoreError } from '../src/store.ts'
import type { PreferenceSignalInput } from '../src/types.ts'

const roots: string[] = []
const OWNER_LINEAGE = Object.freeze({ principalRecordId: 'delivery-principal-owner', principalVersion: 1 })
const ADMISSION_EPOCH = '0123456789abcdef0123456789abcdef'
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function lineage(principalRecordId: string, principalVersion = 1) {
  return Object.freeze({ principalRecordId, principalVersion })
}

function cursor(sequence: number, epoch = ADMISSION_EPOCH) {
  return Object.freeze({ epoch, sequence })
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'preference-learning-store-'))
  roots.push(value)
  return value
}

function store(now: () => number = () => 10_000, path = ':memory:') {
  return new PreferenceStore({
    path,
    now,
    signalTtlMs: 100_000,
    hypothesisTtlMs: 50_000,
    minSignalsForActivation: 2,
    minConfidenceBps: 7_500,
    maxContradictionBps: 2_500,
    maxActiveOverlays: 2,
    maxReviewHypotheses: 10,
    maxOverlayBytes: 2_048,
  })
}

function signal(overrides: Partial<PreferenceSignalInput> = {}): PreferenceSignalInput {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    preferenceKey: 'response.verbosity',
    candidateValue: 'concise',
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: 'typed-feedback',
    source: 'direct-owner-feedback',
    occurredAt: 10_000,
    idempotencyKey: 'signal-1',
    ...overrides,
  }
}

function promotionSignals(scope = { workspace: '/work/alpha', preset: 'primary' }) {
  return [
    signal({
      scope, preferenceKey: 'memory.retention', candidateValue: 'long-term',
      interpretationTrust: 'typed-feedback', source: 'direct-owner-feedback',
      occurredAt: 9_997, idempotencyKey: 'promotion-support-1',
    }),
    signal({
      scope, preferenceKey: 'memory.retention', candidateValue: 'long-term',
      interpretationTrust: 'explicit-selection', source: 'direct-owner-feedback',
      occurredAt: 9_998, idempotencyKey: 'promotion-support-2',
    }),
    signal({
      scope, preferenceKey: 'memory.retention', candidateValue: 'long-term',
      interpretationTrust: 'typed-feedback', source: 'signed-ui-feedback',
      occurredAt: 9_999, idempotencyKey: 'promotion-support-3',
    }),
  ] satisfies PreferenceSignalInput[]
}

describe('preference database', () => {
  test('creates a private WAL/FULL database and rejects unsafe paths', () => {
    const path = join(root(), 'private', 'preferences.sqlite')
    const database = openPreferenceDatabase(path)
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(preferenceSchemaVersion)
    expect((database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2)
    database.close()
    expect(statSync(path).mode & 0o777).toBe(0o600)

    expect(() => openPreferenceDatabase('relative.sqlite')).toThrowError(/absolute/i)
    const unsafe = join(root(), 'unsafe.sqlite')
    closeSync(openSync(unsafe, 'w', 0o666))
    chmodSync(unsafe, 0o644)
    expect(() => openPreferenceDatabase(unsafe)).toThrowError(/permission/i)
  })

  test('rejects a database created by a newer implementation', () => {
    const path = join(root(), 'future.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`PRAGMA user_version = ${preferenceSchemaVersion + 1}`)
    database.close()
    chmodSync(path, 0o600)
    expect(() => openPreferenceDatabase(path)).toThrowError(/newer/i)
  })

  test('migrates schema v1 by adding durable Host maintenance and activation receipts', () => {
    const path = join(root(), 'v1.sqlite')
    const legacy = openPreferenceDatabase(path)
    legacy.exec(`
      DROP TABLE preference_host_maintenance_receipts;
      DROP TABLE preference_host_activation_receipts;
      DROP TABLE preference_owner_control_receipts;
      DROP TABLE preference_exposure_corrections;
      DROP TABLE preference_exposures;
      DROP TABLE preference_scope_principals;
      DROP TABLE preference_memory_promotion_cancellations;
      DROP TABLE preference_memory_promotion_results;
      DROP TABLE preference_memory_promotion_outbox;
      DROP TABLE preference_memory_promotions;
      UPDATE preference_schema_meta SET value = '1' WHERE key = 'schema-version';
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = openPreferenceDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(preferenceSchemaVersion)
    expect((migrated.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'preference_host_maintenance_receipts'
    `).get() as { count: number }).count).toBe(1)
    expect((migrated.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'preference_host_activation_receipts'
    `).get() as { count: number }).count).toBe(1)
    migrated.close()
  })

  test('preserves committed v7 owner-control receipts while adding explain and rollback fields', () => {
    const path = join(root(), 'v7-control-receipt.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const first = store(() => 10_000, path)
    const owner = first.ensureScopePrincipal(scope, 'owner:A', 9_000, OWNER_LINEAGE, cursor(1))
    const pause = first.setScopeLearningPaused(
      scope, owner, true, cursor(2), 10_000, 'preserved-v7-pause',
    )
    first.close()

    const downgrade = new DatabaseSync(path)
    downgrade.exec(`
      DROP TABLE preference_memory_promotion_cancellations;
      DROP TABLE preference_memory_promotion_results;
      DROP TABLE preference_memory_promotion_outbox;
      DROP TABLE preference_memory_promotions;
      DROP INDEX preference_owner_control_scope_time;
      CREATE TABLE preference_owner_control_receipts_v7 (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL,
        generation INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('forget', 'pause', 'resume', 'status')),
        admission_cursor_epoch TEXT NOT NULL,
        admission_cursor_sequence INTEGER NOT NULL,
        result_applied INTEGER NOT NULL,
        result_paused INTEGER NOT NULL,
        result_control_version INTEGER NOT NULL,
        result_admission_high_water INTEGER,
        result_ignore_events_through_sequence INTEGER,
        result_signals INTEGER NOT NULL,
        result_hypotheses INTEGER NOT NULL,
        result_active_overlays INTEGER NOT NULL,
        result_shadow_hypotheses INTEGER NOT NULL,
        result_deleted_signals INTEGER NOT NULL,
        result_deleted_hypotheses INTEGER NOT NULL,
        result_forgotten_through INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO preference_owner_control_receipts_v7
      SELECT idempotency_key, payload_hash, scope_digest, principal_digest, generation,
        action, admission_cursor_epoch, admission_cursor_sequence, result_applied,
        result_paused, result_control_version, result_admission_high_water,
        result_ignore_events_through_sequence, result_signals, result_hypotheses,
        result_active_overlays, result_shadow_hypotheses,
        result_deleted_signals, result_deleted_hypotheses,
        result_forgotten_through, occurred_at
      FROM preference_owner_control_receipts;
      DROP TABLE preference_owner_control_receipts;
      ALTER TABLE preference_owner_control_receipts_v7
        RENAME TO preference_owner_control_receipts;
      CREATE INDEX preference_owner_control_scope_time
        ON preference_owner_control_receipts(
          scope_digest, admission_cursor_epoch, admission_cursor_sequence DESC, idempotency_key
        );
      UPDATE preference_schema_meta SET value = '7' WHERE key = 'schema-version';
      PRAGMA user_version = 7;
    `)
    downgrade.close()

    const upgraded = store(() => 10_100, path)
    expect(upgraded.setScopeLearningPaused(
      scope, owner, true, cursor(2), 10_000, 'preserved-v7-pause',
    )).toEqual({ ...pause, replayed: true })
    upgraded.close()
  })

  test('preserves v8 explain, pause, and rollback receipts across the v9 migration', () => {
    const path = join(root(), 'v8-control-receipts.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const first = store(() => 20_000, path)
    const owner = first.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))
    first.appendSignals([
      signal({ idempotencyKey: 'v8-migration-ready-1' }),
      signal({ idempotencyKey: 'v8-migration-ready-2' }),
    ], { ownerFence: owner, admissionCursor: cursor(2) })
    const ready = first.list(scope, 10, 'owner:A', OWNER_LINEAGE)[0]!
    const active = first.activate(scope, ready.id, ready.version, owner)
    const explained = first.explainScopeLearning(
      scope, owner, cursor(3), 20_000, 'v8-migration-explain',
    )
    const paused = first.setScopeLearningPaused(
      scope, owner, true, cursor(4), 20_001, 'v8-migration-pause',
    )
    const rolledBack = first.rollbackScopeLearningKey(
      scope, owner, 'response.verbosity', cursor(5), 20_002, 'v8-migration-rollback',
    )
    expect(explained).toMatchObject({
      applied: true, replayed: false,
      state: {
        mode: 'active', activeOverlays: 1, storedActiveOverlays: 1,
        controlVersion: 1, admissionHighWater: cursor(2),
      },
      explanation: [{
        key: 'response.verbosity', value: 'concise', state: 'active', version: active.version,
      }],
    })
    expect(paused).toMatchObject({
      applied: true, replayed: false,
      state: {
        mode: 'paused', activeOverlays: 0, storedActiveOverlays: 1,
        controlVersion: 2, admissionHighWater: cursor(4), ignoreEventsThrough: cursor(4),
      },
    })
    expect(rolledBack).toMatchObject({
      applied: true, replayed: false, rolledBack: true, rolledBackVersion: active.version + 1,
      state: {
        mode: 'paused', activeOverlays: 0, storedActiveOverlays: 0,
        controlVersion: 3, admissionHighWater: cursor(5), ignoreEventsThrough: cursor(5),
      },
    })
    first.close()

    // Recreate the exact schema-v8 receipt table around real API-produced
    // receipts. Opening it below must exercise the production v8 -> v9 copy.
    const downgrade = new DatabaseSync(path)
    downgrade.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE preference_memory_promotion_cancellations;
      DROP TABLE preference_memory_promotion_results;
      DROP TABLE preference_memory_promotion_outbox;
      DROP TABLE preference_memory_promotions;
      ALTER TABLE preference_owner_control_receipts
        RENAME TO preference_owner_control_receipts_v9;
      DROP INDEX preference_owner_control_scope_time;
      CREATE TABLE preference_owner_control_receipts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        action TEXT NOT NULL CHECK (action IN (
          'explain', 'forget', 'pause', 'resume', 'rollback', 'status'
        )),
        target_preference_key TEXT,
        admission_cursor_epoch TEXT NOT NULL,
        admission_cursor_sequence INTEGER NOT NULL CHECK (admission_cursor_sequence >= 1),
        result_applied INTEGER NOT NULL CHECK (result_applied IN (0, 1)),
        result_paused INTEGER NOT NULL CHECK (result_paused IN (0, 1)),
        result_control_version INTEGER NOT NULL CHECK (result_control_version >= 1),
        result_admission_high_water INTEGER
          CHECK (result_admission_high_water IS NULL OR result_admission_high_water >= 1),
        result_ignore_events_through_sequence INTEGER
          CHECK (result_ignore_events_through_sequence IS NULL
            OR result_ignore_events_through_sequence >= 1),
        result_signals INTEGER NOT NULL CHECK (result_signals >= 0),
        result_hypotheses INTEGER NOT NULL CHECK (result_hypotheses >= 0),
        result_active_overlays INTEGER NOT NULL CHECK (result_active_overlays >= 0),
        result_stored_active_overlays INTEGER NOT NULL DEFAULT 0
          CHECK (result_stored_active_overlays >= 0),
        result_shadow_hypotheses INTEGER NOT NULL CHECK (result_shadow_hypotheses >= 0),
        result_deleted_signals INTEGER NOT NULL DEFAULT 0 CHECK (result_deleted_signals >= 0),
        result_deleted_hypotheses INTEGER NOT NULL DEFAULT 0 CHECK (result_deleted_hypotheses >= 0),
        result_forgotten_through INTEGER NOT NULL DEFAULT -1 CHECK (result_forgotten_through >= -1),
        result_explanation_json TEXT,
        result_rolled_back INTEGER NOT NULL DEFAULT 0 CHECK (result_rolled_back IN (0, 1)),
        result_rolled_back_version INTEGER
          CHECK (result_rolled_back_version IS NULL OR result_rolled_back_version >= 2),
        occurred_at INTEGER NOT NULL,
        CHECK ((action = 'rollback' AND target_preference_key IS NOT NULL)
          OR (action != 'rollback' AND target_preference_key IS NULL)),
        CHECK ((action = 'explain' AND result_explanation_json IS NOT NULL)
          OR (action != 'explain' AND result_explanation_json IS NULL)),
        CHECK (result_rolled_back = 0 OR action = 'rollback')
      ) STRICT;
      INSERT INTO preference_owner_control_receipts
        SELECT * FROM preference_owner_control_receipts_v9;
      DROP TABLE preference_owner_control_receipts_v9;
      CREATE INDEX preference_owner_control_scope_time
        ON preference_owner_control_receipts(
          scope_digest, admission_cursor_epoch, admission_cursor_sequence DESC, idempotency_key
        );
      UPDATE preference_schema_meta SET value = '8' WHERE key = 'schema-version';
      PRAGMA user_version = 8;
      COMMIT;
    `)
    const v8Receipts = downgrade.prepare(`
      SELECT * FROM preference_owner_control_receipts ORDER BY action
    `).all()
    expect(v8Receipts.map(row => (row as { action: string }).action))
      .toEqual(['explain', 'pause', 'rollback'])
    downgrade.close()

    const upgraded = store(() => 20_100, path)
    const audit = new DatabaseSync(path, { readOnly: true })
    expect((audit.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(preferenceSchemaVersion)
    expect(audit.prepare(`
      SELECT * FROM preference_owner_control_receipts ORDER BY action
    `).all()).toEqual(v8Receipts)
    const principalBeforeReplay = audit.prepare(`
      SELECT learning_paused, control_version, admission_high_water,
        admission_high_water_kind, ignore_events_through_sequence
      FROM preference_scope_principals
    `).get()
    audit.close()

    expect(upgraded.explainScopeLearning(
      scope, owner, cursor(3), 20_000, 'v8-migration-explain',
    )).toEqual({ ...explained, replayed: true })
    expect(upgraded.setScopeLearningPaused(
      scope, owner, true, cursor(4), 20_001, 'v8-migration-pause',
    )).toEqual({ ...paused, replayed: true })
    expect(upgraded.rollbackScopeLearningKey(
      scope, owner, 'response.verbosity', cursor(5), 20_002, 'v8-migration-rollback',
    )).toEqual({ ...rolledBack, replayed: true })

    const afterReplay = new DatabaseSync(path, { readOnly: true })
    expect(afterReplay.prepare(`
      SELECT effect_state, version FROM preference_hypotheses WHERE id = ?
    `).get(active.id)).toEqual({ effect_state: 'rolled-back', version: active.version + 1 })
    expect(afterReplay.prepare(`
      SELECT COUNT(*) AS count FROM preference_transitions
      WHERE hypothesis_id = ? AND reason = 'owner-rejected'
    `).get(active.id)).toEqual({ count: 1 })
    expect(afterReplay.prepare(`
      SELECT learning_paused, control_version, admission_high_water,
        admission_high_water_kind, ignore_events_through_sequence
      FROM preference_scope_principals
    `).get()).toEqual(principalBeforeReplay)
    afterReplay.close()
    upgraded.close()
  })

  test('migrates an existing schema-v9 database without changing export receipts', () => {
    const path = join(root(), 'v9-promotion-migration.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const first = store(() => 20_000, path)
    const owner = first.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))
    first.appendSignals([
      signal({ idempotencyKey: 'v9-export-1' }),
      signal({ idempotencyKey: 'v9-export-2' }),
    ], { ownerFence: owner, admissionCursor: cursor(2) })
    const exported = first.exportScopeLearning(
      scope, owner, cursor(3), 20_000, 'v9-export-receipt',
    )
    first.close()

    const downgrade = new DatabaseSync(path)
    downgrade.exec(`
      DROP TABLE preference_memory_promotion_cancellations;
      DROP TABLE preference_memory_promotion_results;
      DROP TABLE preference_memory_promotion_outbox;
      DROP TABLE preference_memory_promotions;
      UPDATE preference_schema_meta SET value = '9' WHERE key = 'schema-version';
      PRAGMA user_version = 9;
    `)
    const receiptBefore = downgrade.prepare(`
      SELECT * FROM preference_owner_control_receipts WHERE action = 'export'
    `).get()
    downgrade.close()

    const upgraded = store(() => 20_100, path)
    expect(upgraded.exportScopeLearning(
      scope, owner, cursor(3), 20_000, 'v9-export-receipt',
    )).toEqual({ ...exported, replayed: true })
    const audit = new DatabaseSync(path, { readOnly: true })
    expect((audit.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(preferenceSchemaVersion)
    expect(audit.prepare(`
      SELECT * FROM preference_owner_control_receipts WHERE action = 'export'
    `).get()).toEqual(receiptBefore)
    expect((audit.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'preference_memory_promotion%'
    `).get() as { count: number }).count).toBe(4)
    audit.close()
    upgraded.close()
  })

  test('reopens legacy privacy already-confirmed receipts for compensation only', () => {
    const path = join(root(), 'v11-cancellation-compensation.sqlite')
    const target = store(() => 10_000, path)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1))
    target.appendSignals(promotionSignals(scope), { ownerFence: owner, admissionCursor: cursor(2) })
    const request = target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)[0]!.request
    target.settleMemoryPromotionSubmission({ request, receipt: withPreferenceMemoryPromotionSubmissionDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      outcome: 'accepted' as const, memoryProposalId: 'memory-proposal-v10',
    }) })
    target.forgetScope(scope, 'forget-v10-promotion', {
      ownerFence: owner, admissionCursor: cursor(3), occurredAt: 10_000,
    })
    target.close()
    const legacy = new DatabaseSync(path)
    legacy.prepare(`
      UPDATE preference_memory_promotion_cancellations
      SET state = 'already-confirmed', receipt_digest = ?
      WHERE promotion_id = ? AND promotion_generation = ?
    `).run('a'.repeat(64), request.promotionId, request.promotionGeneration)
    legacy.exec(`
      ALTER TABLE preference_memory_promotion_cancellations
        DROP COLUMN upgrade_binding_digest;
      UPDATE preference_schema_meta SET value = '11' WHERE key = 'schema-version';
      PRAGMA user_version = 11;
    `)
    legacy.close()

    const reopened = store(() => 10_100, path)
    expect(reopened.listPendingMemoryPromotionCancellations(10))
      .toEqual([expect.objectContaining({
        promotionId: request.promotionId, reason: 'forget',
      })])
    reopened.close()
  })

  test('fails closed migrating a redacted supersede cancellation after its promotion was purged', () => {
    const path = join(root(), 'v11-unrecoverable-supersede.sqlite')
    const target = store(() => 10_000, path)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1))
    target.appendSignals(promotionSignals(scope), { ownerFence: owner, admissionCursor: cursor(2) })
    const request = target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)[0]!.request
    target.close()
    const legacy = new DatabaseSync(path)
    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      principalLineage: request.principalLineage, ownerGeneration: request.ownerGeneration,
      reason: 'superseded' as const, occurredAt: 10_000,
    })
    legacy.exec(`
      ALTER TABLE preference_memory_promotion_cancellations
        DROP COLUMN upgrade_binding_digest;
      UPDATE preference_schema_meta SET value = '11' WHERE key = 'schema-version';
      PRAGMA user_version = 11;
    `)
    legacy.prepare(`
      INSERT INTO preference_memory_promotion_cancellations(
        promotion_id, promotion_generation, request_digest, principal_lineage_id,
        principal_lineage_version, owner_generation, reason, cancelled_at, cancellation_digest,
        state, attempt_count, next_attempt_at, receipt_digest, updated_at
      ) VALUES (?, ?, ?, ?, 1, 1, 'superseded', ?, ?, 'already-confirmed', 1, ?, ?, ?)
    `).run(
      request.promotionId, request.promotionGeneration, request.requestDigest,
      `redacted-${'a'.repeat(64)}`, cancellation.occurredAt, cancellation.cancellationDigest,
      10_000, 'b'.repeat(64), 10_000,
    )
    legacy.prepare('DELETE FROM preference_memory_promotions WHERE promotion_id = ?')
      .run(request.promotionId)
    legacy.close()

    expect(() => store(() => 10_100, path)).toThrow(/cannot be safely upgraded/iu)
  })
})

describe('preference store', () => {
  test('atomically creates only an allowlisted multi-signal T2 promotion and proposal outbox', () => {
    const target = store(() => 10_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1))
    const events = promotionSignals(scope)
    target.appendSignals(events.slice(0, 2), { ownerFence: owner, admissionCursor: cursor(2) })
    expect(target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)).toEqual([])
    target.appendSignals([events[2]!], { ownerFence: owner, admissionCursor: cursor(3) })

    const [created] = target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)
    expect(created).toMatchObject({
      state: 'pending',
      request: {
        promotionGeneration: 1, ownerGeneration: owner.generation,
        rendererId: 'memory.retention.long-term/v1',
        hypothesis: {
          key: 'memory.retention', value: 'long-term', supportingSignals: 3,
          distinctSignalSources: 3, confidenceBps: expect.any(Number),
        },
      },
    })
    expect(created!.request.hypothesis.confidenceBps).toBeGreaterThanOrEqual(8_500)
    expect(created!.request.hypothesis.contradictionBps).toBeLessThanOrEqual(1_500)
    expect(target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)).toEqual([])
    expect(target.listPendingMemoryPromotions(10)).toEqual([expect.objectContaining({
      request: created!.request, state: 'pending', attemptCount: 0,
    })])
    target.close()
  })

  test('persists submission retry and projects distinct terminal Memory results idempotently', () => {
    let now = 10_000
    const target = store(() => now)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1))
    target.appendSignals(promotionSignals(scope), { ownerFence: owner, admissionCursor: cursor(2) })
    const request = target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)[0]!.request

    target.settleMemoryPromotionSubmission({ request, retryError: 'memory-unavailable' })
    expect(target.listPendingMemoryPromotions(10)).toEqual([])
    now = 10_250
    expect(target.listPendingMemoryPromotions(10)[0]).toMatchObject({ attemptCount: 1, state: 'retry_wait' })
    const submission = withPreferenceMemoryPromotionSubmissionDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      outcome: 'accepted' as const, memoryProposalId: 'memory-proposal-1',
    })
    expect(target.settleMemoryPromotionSubmission({ request, receipt: submission })).toMatchObject({
      state: 'submitted', memoryProposalId: 'memory-proposal-1',
    })
    const confirmed = withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 1, status: 'confirmed' as const, memoryProposalId: 'memory-proposal-1',
      memoryProposalVersion: 2, memoryRecordId: 'memory-record-1', memoryRecordVersion: 1,
      memoryRecordDigest: 'a'.repeat(64), occurredAt: now,
    })
    expect(target.projectMemoryPromotionResult(confirmed).outcome).toBe('applied')
    expect(target.projectMemoryPromotionResult(confirmed).outcome).toBe('replayed')
    expect(target.getMemoryPromotion(request.promotionId, request.promotionGeneration))
      .toMatchObject({ state: 'confirmed', terminalReceiptDigest: confirmed.receiptDigest })
    expect(target.get(scope, request.hypothesis.id, 'owner:A', OWNER_LINEAGE))
      .toMatchObject({ claimState: 'confirmed', effectState: 'inactive' })
    const rejected = withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 2, status: 'rejected' as const, rejectionKind: 'owner-explicit' as const,
      memoryProposalId: 'memory-proposal-1', memoryProposalVersion: 3, occurredAt: now,
    })
    expect(() => target.projectMemoryPromotionResult(rejected)).toThrow(/terminal result changed/iu)
    target.close()
  })

  test('does not supersede a confirmed promotion when later evidence advances its hypothesis', () => {
    let now = 10_000
    const target = store(() => now)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1))
    target.appendSignals(promotionSignals(scope), { ownerFence: owner, admissionCursor: cursor(2) })
    const request = target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)[0]!.request
    const submission = withPreferenceMemoryPromotionSubmissionDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      outcome: 'accepted' as const, memoryProposalId: 'memory-proposal-confirmed',
    })
    target.settleMemoryPromotionSubmission({ request, receipt: submission })
    const confirmed = withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 1, status: 'confirmed' as const,
      memoryProposalId: 'memory-proposal-confirmed', memoryProposalVersion: 2,
      memoryRecordId: 'memory-record-confirmed', memoryRecordVersion: 1,
      memoryRecordDigest: 'c'.repeat(64), occurredAt: now,
    })
    target.projectMemoryPromotionResult(confirmed)
    const confirmedVersion = target.get(
      scope, request.hypothesis.id, 'owner:A', OWNER_LINEAGE,
    )!.version

    now += 1
    target.appendSignals([signal({
      scope, preferenceKey: 'memory.retention', candidateValue: 'long-term',
      interpretationTrust: 'explicit-selection', source: 'signed-ui-feedback',
      occurredAt: now, idempotencyKey: 'promotion-support-after-confirmation',
    })], { ownerFence: owner, admissionCursor: cursor(3) })

    expect(target.get(scope, request.hypothesis.id, 'owner:A', OWNER_LINEAGE)).toMatchObject({
      claimState: 'confirmed', version: confirmedVersion + 1,
    })
    expect(target.getMemoryPromotion(request.promotionId, request.promotionGeneration))
      .toMatchObject({ state: 'confirmed', terminalReceiptDigest: confirmed.receiptDigest })
    expect(target.listPendingMemoryPromotionCancellations(10)).toEqual([])
    target.close()
  })

  test('checks a saved terminal receipt before a legacy supersede cancellation', () => {
    const path = join(root(), 'terminal-before-cancellation.sqlite')
    const target = store(() => 10_000, path)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1))
    target.appendSignals(promotionSignals(scope), { ownerFence: owner, admissionCursor: cursor(2) })
    const request = target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)[0]!.request
    const submission = withPreferenceMemoryPromotionSubmissionDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      outcome: 'accepted' as const, memoryProposalId: 'memory-proposal-terminal-first',
    })
    target.settleMemoryPromotionSubmission({ request, receipt: submission })
    const confirmed = withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 1, status: 'confirmed' as const,
      memoryProposalId: 'memory-proposal-terminal-first', memoryProposalVersion: 2,
      memoryRecordId: 'memory-record-terminal-first', memoryRecordVersion: 1,
      memoryRecordDigest: 'd'.repeat(64), occurredAt: 10_000,
    })
    target.projectMemoryPromotionResult(confirmed)
    target.close()

    // Recreate the valid coexistence left by the previous implementation,
    // which superseded a confirmed promotion after its hypothesis refreshed.
    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      principalLineage: request.principalLineage, ownerGeneration: request.ownerGeneration,
      reason: 'superseded' as const, occurredAt: 10_000,
    })
    const upgradeBindingDigest = preferencePromotionCancellationUpgradeBindingDigest({
      promotionId: cancellation.promotionId,
      promotionGeneration: cancellation.promotionGeneration,
      requestDigest: cancellation.requestDigest,
      principalLineageId: cancellation.principalLineage.principalRecordId,
      principalLineageVersion: cancellation.principalLineage.principalVersion,
      ownerGeneration: cancellation.ownerGeneration,
    })
    const legacy = new DatabaseSync(path)
    legacy.prepare(`
      INSERT INTO preference_memory_promotion_cancellations(
        promotion_id, promotion_generation, request_digest, principal_lineage_id,
        principal_lineage_version, owner_generation, reason, cancelled_at,
        cancellation_digest, state, attempt_count, next_attempt_at, upgrade_binding_digest, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      cancellation.promotionId, cancellation.promotionGeneration, cancellation.requestDigest,
      cancellation.principalLineage.principalRecordId,
      cancellation.principalLineage.principalVersion, cancellation.ownerGeneration,
      cancellation.reason, cancellation.occurredAt, cancellation.cancellationDigest,
      10_000, upgradeBindingDigest, 10_000,
    )
    legacy.close()

    const reopened = store(() => 10_000, path)
    expect(reopened.projectMemoryPromotionResult(confirmed).outcome).toBe('replayed')
    const changed = withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 2, status: 'confirmed' as const,
      memoryProposalId: 'memory-proposal-terminal-first', memoryProposalVersion: 3,
      memoryRecordId: 'memory-record-terminal-changed', memoryRecordVersion: 2,
      memoryRecordDigest: 'e'.repeat(64), occurredAt: 10_000,
    })
    expect(() => reopened.projectMemoryPromotionResult(changed))
      .toThrow(/terminal result changed/iu)
    reopened.close()
  })

  test('a forget cancellation dominates a previously projected result replay', () => {
    const target = store(() => 10_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1))
    target.appendSignals(promotionSignals(scope), { ownerFence: owner, admissionCursor: cursor(2) })
    const request = target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)[0]!.request
    target.settleMemoryPromotionSubmission({ request, receipt: withPreferenceMemoryPromotionSubmissionDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      outcome: 'accepted' as const, memoryProposalId: 'memory-proposal-cancel-after-project',
    }) })
    const confirmed = withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 1, status: 'confirmed' as const,
      memoryProposalId: 'memory-proposal-cancel-after-project', memoryProposalVersion: 2,
      memoryRecordId: 'memory-record-cancel-after-project', memoryRecordVersion: 1,
      memoryRecordDigest: 'f'.repeat(64), occurredAt: 10_000,
    })
    expect(target.projectMemoryPromotionResult(confirmed).outcome).toBe('applied')

    target.forgetScope(scope, 'forget-after-project', {
      ownerFence: owner, admissionCursor: cursor(3), occurredAt: 10_000,
    })
    const cancellation = target.listPendingMemoryPromotionCancellations(10)[0]!
    const receipt = withPreferenceMemoryPromotionCancellationReceiptDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      cancellationDigest: cancellation.cancellationDigest, outcome: 'cancelled' as const,
    })
    expect(() => target.projectMemoryPromotionResult(confirmed))
      .toThrow(/compensation is not complete/iu)
    target.settleMemoryPromotionCancellation({ request: cancellation, receipt })

    expect(target.projectMemoryPromotionResult(confirmed).outcome).toBe('cancelled')
    expect(target.listPendingMemoryPromotionCancellations(10)).toEqual([])
    target.close()
  })

  test('forget cancels a submitted promotion and permanently ACK-cancels a delayed result', () => {
    const target = store(() => 10_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1))
    target.appendSignals(promotionSignals(scope), { ownerFence: owner, admissionCursor: cursor(2) })
    const request = target.enqueueEligibleMemoryPromotions(scope, 'owner:A', owner)[0]!.request
    const submission = withPreferenceMemoryPromotionSubmissionDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      outcome: 'accepted' as const, memoryProposalId: 'memory-proposal-2',
    })
    target.settleMemoryPromotionSubmission({ request, receipt: submission })
    target.forgetScope(scope, 'forget-promotion', {
      ownerFence: owner, admissionCursor: cursor(3), occurredAt: 10_000,
    })
    const cancellation = target.listPendingMemoryPromotionCancellations(10)[0]!
    expect(cancellation).toMatchObject({
      promotionId: request.promotionId, requestDigest: request.requestDigest,
      ownerGeneration: owner.generation, reason: 'forget',
    })
    const cancellationReceipt = withPreferenceMemoryPromotionCancellationReceiptDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      cancellationDigest: cancellation.cancellationDigest, outcome: 'cancelled' as const,
    })
    target.settleMemoryPromotionCancellation({ request: cancellation, receipt: cancellationReceipt })
    expect(target.listPendingMemoryPromotionCancellations(10)).toEqual([])

    const delayed = withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 1, status: 'confirmed' as const, memoryProposalId: 'memory-proposal-2',
      memoryProposalVersion: 2, memoryRecordId: 'memory-record-late', memoryRecordVersion: 1,
      memoryRecordDigest: 'b'.repeat(64), occurredAt: 10_000,
    })
    expect(target.projectMemoryPromotionResult(delayed).outcome).toBe('cancelled')
    target.close()
  })

  test('list and get require the exact lineage when the same external owner returns', () => {
    const target = store(() => 10_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const ownerA1 = target.ensureScopePrincipal(
      scope, 'owner:A', 9_900, lineage('principal-a', 1), cursor(1),
    )
    target.appendSignals([
      signal({ idempotencyKey: 'lineage-isolation-1', occurredAt: 9_999 }),
      signal({ idempotencyKey: 'lineage-isolation-2', occurredAt: 10_000 }),
    ], { ownerFence: ownerA1, admissionCursor: cursor(2) })
    const a1 = target.list(scope, 10, 'owner:A', lineage('principal-a', 1))[0]!
    expect(a1).toBeDefined()
    expect(target.get(scope, a1.id, 'owner:A', lineage('principal-a', 1))).toEqual(a1)

    // Delivery has already authenticated the returning A3, while Preference
    // has not yet admitted its first event. Matching only owner:A would expose
    // the still-current A1 scope during this handoff window.
    expect(target.list(scope, 10, 'owner:A', lineage('principal-a', 3))).toEqual([])
    expect(target.get(scope, a1.id, 'owner:A', lineage('principal-a', 3))).toBeUndefined()
    expect(target.list(scope, 10, 'owner:B', lineage('principal-a', 1))).toEqual([])
    target.close()
  })

  test('fails closed when a schema-v5 principal first claims an exact lineage', () => {
    const path = join(root(), 'v5-lineage-adoption.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const first = store(() => 20_000, path)
    const legacyOwner = first.ensureScopePrincipal(scope, 'owner:A', 9_000, OWNER_LINEAGE, cursor(1))
    first.appendSignals([
      signal({ idempotencyKey: 'v5-adoption-signal-1', occurredAt: 9_100 }),
      signal({ idempotencyKey: 'v5-adoption-signal-2', occurredAt: 9_200 }),
    ], { ownerFence: legacyOwner, admissionCursor: cursor(2) })
    const ready = first.list(scope, 10, 'owner:A', OWNER_LINEAGE)[0]!
    const activation = first.activateHostOnce(
      scope, ready.id, ready.version, 'v5-adoption-activation', legacyOwner,
    )
    first.recordExposure({
      scope,
      ownerFence: legacyOwner,
      hypothesisId: ready.id,
      hypothesisVersion: activation.resultVersion,
      sessionId: 'v5-session',
      sourceEventId: 'v5-event',
    })
    first.maintainScopeOnce(scope, 'v5-adoption-maintenance', legacyOwner)
    first.close()

    // Recreate only the version-5 shapes, retaining the live rows that an
    // in-place upgrade would encounter. Migration 6 will add NULL lineage.
    const downgrade = new DatabaseSync(path)
    downgrade.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP TABLE preference_memory_promotion_cancellations;
      DROP TABLE preference_memory_promotion_results;
      DROP TABLE preference_memory_promotion_outbox;
      DROP TABLE preference_memory_promotions;
      CREATE TABLE preference_scope_principals_v5 (
        scope_key TEXT PRIMARY KEY,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        claimed_at INTEGER NOT NULL,
        purge_pending INTEGER NOT NULL CHECK (purge_pending IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO preference_scope_principals_v5
        SELECT scope_key, scope_digest, principal_digest, generation,
          claimed_at, purge_pending, updated_at
        FROM preference_scope_principals;
      DROP TABLE preference_scope_principals;
      ALTER TABLE preference_scope_principals_v5 RENAME TO preference_scope_principals;
      CREATE INDEX preference_scope_principals_digest
        ON preference_scope_principals(scope_digest, principal_digest);

      CREATE TABLE preference_host_activation_receipts_v5 (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
        result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
        occurred_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO preference_host_activation_receipts_v5
        SELECT idempotency_key, payload_hash, scope_digest, hypothesis_id,
          expected_version, result_version, occurred_at
        FROM preference_host_activation_receipts;
      DROP TABLE preference_host_activation_receipts;
      ALTER TABLE preference_host_activation_receipts_v5
        RENAME TO preference_host_activation_receipts;
      CREATE INDEX preference_host_activation_scope_time
        ON preference_host_activation_receipts(scope_digest, occurred_at DESC, idempotency_key);

      CREATE TABLE preference_host_maintenance_receipts_v5 (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        deleted_signals INTEGER NOT NULL CHECK (deleted_signals IN (0, 1)),
        occurred_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO preference_host_maintenance_receipts_v5
        SELECT idempotency_key, payload_hash, scope_digest, deleted_signals, occurred_at
        FROM preference_host_maintenance_receipts;
      DROP TABLE preference_host_maintenance_receipts;
      ALTER TABLE preference_host_maintenance_receipts_v5
        RENAME TO preference_host_maintenance_receipts;
      CREATE INDEX preference_host_maintenance_scope_time
        ON preference_host_maintenance_receipts(scope_digest, occurred_at DESC, idempotency_key);

      DROP TABLE preference_owner_control_receipts;
      UPDATE preference_schema_meta SET value = '5' WHERE key = 'schema-version';
      PRAGMA user_version = 5;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `)
    downgrade.close()

    const upgraded = store(() => 20_000, path)
    const seededControl = new DatabaseSync(path)
    seededControl.exec(`
      INSERT INTO preference_owner_control_receipts(
        idempotency_key, payload_hash, scope_digest, principal_digest, generation,
        action, admission_cursor_epoch, admission_cursor_sequence, result_applied,
        result_paused, result_control_version, result_admission_high_water,
        result_ignore_events_through_sequence, result_signals, result_hypotheses,
        result_active_overlays, result_shadow_hypotheses, occurred_at
      )
      SELECT 'legacy-control-receipt', '${'0'.repeat(64)}', scope_digest,
        principal_digest, generation, 'pause', 'legacy-unknown-epoch', 1,
        1, 1, 2, 1, 1, 2, 1, 1, 1, 9500
      FROM preference_scope_principals;
    `)
    seededControl.close()
    const beforeAdoption = new DatabaseSync(path, { readOnly: true })
    expect(beforeAdoption.prepare(`
      SELECT generation, principal_lineage_id, principal_lineage_version
      FROM preference_scope_principals
    `).get()).toEqual({
      generation: 1,
      principal_lineage_id: null,
      principal_lineage_version: null,
    })
    expect(beforeAdoption.prepare('SELECT COUNT(*) AS count FROM preference_signals').get())
      .toEqual({ count: 2 })
    expect(beforeAdoption.prepare('SELECT COUNT(*) AS count FROM preference_hypotheses').get())
      .toEqual({ count: 1 })
    expect(beforeAdoption.prepare('SELECT COUNT(*) AS count FROM preference_exposures').get())
      .toEqual({ count: 1 })
    expect(beforeAdoption.prepare('SELECT COUNT(*) AS count FROM preference_host_activation_receipts').get())
      .toEqual({ count: 1 })
    expect(beforeAdoption.prepare('SELECT COUNT(*) AS count FROM preference_host_maintenance_receipts').get())
      .toEqual({ count: 1 })
    expect(beforeAdoption.prepare('SELECT COUNT(*) AS count FROM preference_owner_control_receipts').get())
      .toEqual({ count: 1 })
    expect(upgraded.overlaySnapshot(
      scope,
      'owner:A',
      lineage('delivery-principal-a', 7),
    ).text).toBeUndefined()
    beforeAdoption.close()

    const adopted = upgraded.ensureScopePrincipal(
      scope, 'owner:A', 10_000, lineage('delivery-principal-a', 7), cursor(3),
    )
    expect(adopted).toMatchObject({ accepted: true, generation: 2, reset: true })
    expect(upgraded.health()).toMatchObject({ signals: 0, hypotheses: 0, active: 0 })
    const afterAdoption = new DatabaseSync(path, { readOnly: true })
    expect(afterAdoption.prepare('SELECT COUNT(*) AS count FROM preference_exposures').get())
      .toEqual({ count: 0 })
    expect(afterAdoption.prepare('SELECT COUNT(*) AS count FROM preference_host_activation_receipts').get())
      .toEqual({ count: 0 })
    expect(afterAdoption.prepare('SELECT COUNT(*) AS count FROM preference_host_maintenance_receipts').get())
      .toEqual({ count: 0 })
    expect(afterAdoption.prepare('SELECT COUNT(*) AS count FROM preference_owner_control_receipts').get())
      .toEqual({ count: 0 })
    afterAdoption.close()

    const replacement = upgraded.ensureScopePrincipal(
      scope, 'owner:B', 11_000, lineage('delivery-principal-b', 1), cursor(4),
    )
    expect(replacement).toMatchObject({ accepted: true, generation: 3, reset: true })
    expect(upgraded.health()).toMatchObject({ signals: 0, hypotheses: 0, active: 0 })
    upgraded.close()
  })

  test('preserves an exact-lineage v6 pause while purging legacy learned state', () => {
    const path = join(root(), 'v6-paused-upgrade.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const first = store(() => 20_000, path)
    const owner = first.ensureScopePrincipal(scope, 'owner:A', 9_000, OWNER_LINEAGE, cursor(1))
    first.appendSignals([signal({ idempotencyKey: 'v6-paused-evidence' })], {
      ownerFence: owner, admissionCursor: cursor(2),
    })
    first.setScopeLearningPaused(scope, owner, true, cursor(3), 10_000, 'v6-pause')
    first.close()

    const downgrade = new DatabaseSync(path)
    downgrade.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP TABLE preference_memory_promotion_cancellations;
      DROP TABLE preference_memory_promotion_results;
      DROP TABLE preference_memory_promotion_outbox;
      DROP TABLE preference_memory_promotions;
      CREATE TABLE preference_scope_principals_v6 (
        scope_key TEXT PRIMARY KEY,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        claimed_at INTEGER NOT NULL,
        purge_pending INTEGER NOT NULL CHECK (purge_pending IN (0, 1)),
        updated_at INTEGER NOT NULL,
        principal_lineage_id TEXT,
        principal_lineage_version INTEGER,
        learning_paused INTEGER NOT NULL DEFAULT 0 CHECK (learning_paused IN (0, 1)),
        paused_at INTEGER,
        control_version INTEGER NOT NULL DEFAULT 1 CHECK (control_version >= 1),
        ignore_events_through INTEGER NOT NULL DEFAULT -1 CHECK (ignore_events_through >= -1)
      ) STRICT;
      INSERT INTO preference_scope_principals_v6
        SELECT scope_key, scope_digest, principal_digest, generation,
          claimed_at, purge_pending, updated_at,
          principal_lineage_id, principal_lineage_version,
          learning_paused, paused_at, control_version, ignore_events_through
        FROM preference_scope_principals;
      DROP TABLE preference_scope_principals;
      ALTER TABLE preference_scope_principals_v6 RENAME TO preference_scope_principals;
      CREATE INDEX preference_scope_principals_digest
        ON preference_scope_principals(scope_digest, principal_digest);

      DROP TABLE preference_owner_control_receipts;
      CREATE TABLE preference_owner_control_receipts (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        principal_digest TEXT NOT NULL CHECK (
          length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^a-f0-9]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        action TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
        result_paused INTEGER NOT NULL CHECK (result_paused IN (0, 1)),
        result_control_version INTEGER NOT NULL CHECK (result_control_version >= 1),
        result_ignore_events_through INTEGER NOT NULL CHECK (result_ignore_events_through >= -1),
        occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX preference_owner_control_scope_time
        ON preference_owner_control_receipts(scope_digest, occurred_at DESC, idempotency_key);
      UPDATE preference_schema_meta SET value = '6' WHERE key = 'schema-version';
      PRAGMA user_version = 6;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `)
    downgrade.close()

    const upgraded = store(() => 20_000, path)
    const beforeClaim = new DatabaseSync(path, { readOnly: true })
    expect(beforeClaim.prepare(`
      SELECT learning_paused, principal_lineage_id, principal_lineage_version,
        admission_cursor_epoch
      FROM preference_scope_principals
    `).get()).toEqual({
      learning_paused: 1,
      principal_lineage_id: OWNER_LINEAGE.principalRecordId,
      principal_lineage_version: OWNER_LINEAGE.principalVersion,
      admission_cursor_epoch: null,
    })
    beforeClaim.close()
    expect(upgraded.overlaySnapshot(scope, 'owner:A', OWNER_LINEAGE).text).toBeUndefined()

    const upgradedOwner = upgraded.ensureScopePrincipal(
      scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(4),
    )
    expect(upgradedOwner).toMatchObject({ generation: 2, reset: true })
    expect(upgraded.scopeLearningStatus(scope, upgradedOwner)).toMatchObject({
      mode: 'paused', signals: 0, hypotheses: 0, activeOverlays: 0,
    })
    upgraded.close()
  })

  test('fences interleaved old-owner writes and monotonically ignores their delayed replay', () => {
    const target = store(() => 10_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const ownerA = target.ensureScopePrincipal(scope, 'owner:A', 9_000, lineage('principal-a'), cursor(1))
    const ownerB = target.ensureScopePrincipal(scope, 'owner:B', 9_500, lineage('principal-b'), cursor(3))
    expect(ownerB).toMatchObject({ accepted: true, generation: 2, reset: true })

    expect(() => target.appendSignals([signal({
      idempotencyKey: 'interleaved-owner-a',
      occurredAt: 9_100,
    })], { ownerFence: ownerA, admissionCursor: cursor(2) })).toThrowError(/principal fence changed/iu)
    expect(target.ensureScopePrincipal(
      scope, 'owner:A', 9_250, lineage('principal-a'), cursor(2),
    )).toMatchObject({
      accepted: false,
      generation: 2,
      reset: false,
    })
    expect(target.appendSignals([signal({
      candidateValue: 'detailed',
      idempotencyKey: 'interleaved-owner-b',
      occurredAt: 9_600,
    })], { ownerFence: ownerB, admissionCursor: cursor(4) })).toHaveLength(1)
    expect(target.list(scope)).toEqual([
      expect.objectContaining({ candidateValue: 'detailed', supportingSignals: 1 }),
    ])
    target.close()
  })

  test('recovers a committed completed-turn streak with bounded autonomous activation after restart', () => {
    const path = join(root(), 'autonomous-recovery.sqlite')
    const first = store(() => 10_000, path)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const ownerFence = first.ensureScopePrincipal(scope, 'owner:A', 9_999, OWNER_LINEAGE, cursor(1))
    for (let index = 1; index <= 6; index += 1) {
      first.appendSignals([signal({
        preferenceKey: 'response.language',
        candidateValue: 'zh-CN',
        interpretationTrust: 'behavioral-inference',
        source: 'delivery-observation',
        occurredAt: 10_000,
        idempotencyKey: `completed-owner-turn-${index}`,
      })], { ownerFence, admissionCursor: cursor(index + 1) })
    }
    expect(first.list(scope, 10, 'owner:A', OWNER_LINEAGE)[0])
      .toMatchObject({ effectState: 'shadow', supportingSignals: 6 })
    first.close()

    const restarted = store(() => 10_001, path)
    expect(restarted.activateReadyScopes(10)).toBe(1)
    expect(restarted.overlaySnapshot(scope, 'owner:A').text)
      .toContain('Simplified Chinese')
    expect(restarted.activateReadyScopes(10)).toBe(0)
    restarted.close()
  })

  test('does not autonomously activate legacy ownerless rows or a stale owner generation', () => {
    const target = store(() => 10_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    for (let index = 1; index <= 6; index += 1) {
      target.appendSignal(signal({
        preferenceKey: 'response.language',
        candidateValue: 'zh-CN',
        interpretationTrust: 'behavioral-inference',
        source: 'delivery-observation',
        occurredAt: 9_000 + index,
        idempotencyKey: `legacy-ownerless-${index}`,
      }))
    }
    expect(target.activateReadyScopes(10)).toBe(0)
    expect(target.list(scope)[0]).toMatchObject({ effectState: 'shadow' })

    // The first authenticated owner claim physically removes legacy rows.
    const ownerA = target.ensureScopePrincipal(scope, 'owner:A', 9_500, lineage('principal-a'), cursor(1))
    expect(target.list(scope, 10, 'owner:A', lineage('principal-a'))).toEqual([])
    for (let index = 1; index <= 6; index += 1) {
      target.appendSignals([signal({
        preferenceKey: 'response.language',
        candidateValue: 'zh-CN',
        interpretationTrust: 'behavioral-inference',
        source: 'delivery-observation',
        occurredAt: 9_600 + index,
        idempotencyKey: `owner-a-current-${index}`,
      })], { ownerFence: ownerA, admissionCursor: cursor(index + 1) })
    }
    const ownerB = target.ensureScopePrincipal(scope, 'owner:B', 9_700, lineage('principal-b'), cursor(8))
    expect(ownerB.generation).toBe(ownerA.generation + 1)
    expect(() => target.activateReady(scope, 2, ownerA)).toThrowError(/principal fence changed/iu)
    expect(target.activateReadyScopes(10)).toBe(0)
    expect(target.list(scope, 10, 'owner:B', lineage('principal-b'))).toEqual([])
    target.close()
  })

  test('replays a committed Host activation after restart and rejects operation aliasing', () => {
    const path = join(root(), 'host-activation.sqlite')
    const first = store(() => 10_000, path)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const ownerFence = first.ensureScopePrincipal(scope, 'owner:A', 9_998, OWNER_LINEAGE, cursor(1))
    first.appendSignals([
      signal({ idempotencyKey: 'host-activation-signal-1', occurredAt: 9_999 }),
      signal({ idempotencyKey: 'host-activation-signal-2', occurredAt: 10_000 }),
    ], { ownerFence, admissionCursor: cursor(2) })
    const ready = first.list({ workspace: '/work/alpha', preset: 'primary' })[0]!

    // Simulate commit followed by a lost response: discard the returned value
    // and close before the fixed runbook can persist its outer receipt.
    first.activateHostOnce(
      ready.scope, ready.id, ready.version, 'growth-run:activate:exact', ownerFence,
    )
    first.close()

    const restarted = store(() => 10_001, path)
    expect(restarted.activateHostOnce(
      ready.scope, ready.id, ready.version, 'growth-run:activate:exact', ownerFence,
    )).toEqual({
      hypothesisId: ready.id,
      expectedVersion: ready.version,
      resultVersion: ready.version + 1,
      ownerGeneration: ownerFence.generation,
      principalLineageId: ownerFence.principalLineageId,
      principalLineageVersion: ownerFence.principalLineageVersion,
      replayed: true,
    })
    expect(() => restarted.activateHostOnce(
      ready.scope, 'hypothesis-another-target', ready.version, 'growth-run:activate:exact', ownerFence,
    )).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({
      code: 'idempotency-conflict',
    }))
    expect(() => restarted.activateHostOnce(
      ready.scope, ready.id, ready.version, 'growth-run:activate:another-operation', ownerFence,
    )).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'conflict' }))
    restarted.close()
  })

  test('replays an exact committed Host activation after owner pause or global disable', () => {
    const target = store(() => 10_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const ownerFence = target.ensureScopePrincipal(
      scope, 'owner:A', 9_900, OWNER_LINEAGE, cursor(1),
    )
    target.appendSignals([
      signal({ idempotencyKey: 'pause-replay-signal-1', occurredAt: 9_999 }),
      signal({ idempotencyKey: 'pause-replay-signal-2', occurredAt: 10_000 }),
    ], { ownerFence, admissionCursor: cursor(2) })
    const ready = target.list(scope, 10, 'owner:A', OWNER_LINEAGE)[0]!
    const committed = target.activateHostOnce(
      scope, ready.id, ready.version, 'growth-run:activate-before-pause', ownerFence,
    )

    target.setScopeLearningPaused(
      scope, ownerFence, true, cursor(3), 10_000, 'pause-after-activation-commit',
    )
    expect(target.activateHostOnce(
      scope, ready.id, ready.version, 'growth-run:activate-before-pause', ownerFence,
    )).toEqual({ ...committed, replayed: true })
    expect(target.activateHostOnce(
      scope, ready.id, ready.version, 'growth-run:activate-before-pause', ownerFence, false,
    )).toEqual({ ...committed, replayed: true })

    expect(() => target.activateHostOnce(
      scope, ready.id, ready.version + 1, 'growth-run:new-activation-while-paused', ownerFence,
    )).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({
      code: 'learning-paused',
    }))
    expect(() => target.activateHostOnce(
      scope, ready.id, ready.version + 1, 'growth-run:new-activation-while-disabled', ownerFence, false,
    )).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'disabled' }))
    target.close()
  })

  test('never replays a generation-1 Host activation receipt as generation 3', () => {
    const target = store(() => 20_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const ownerA1 = target.ensureScopePrincipal(
      scope, 'owner:A', 9_000, lineage('principal-a', 1), cursor(1),
    )
    target.appendSignals([
      signal({ idempotencyKey: 'generation-1-ready-1', occurredAt: 9_010 }),
      signal({ idempotencyKey: 'generation-1-ready-2', occurredAt: 9_020 }),
    ], { ownerFence: ownerA1, admissionCursor: cursor(2) })
    const generation1Ready = target.list(scope, 10, 'owner:A', lineage('principal-a', 1))[0]!
    const generation1Receipt = target.activateHostOnce(
      scope,
      generation1Ready.id,
      generation1Ready.version,
      'host-activate-reused-after-owner-return',
      ownerA1,
    )
    expect(generation1Receipt).toMatchObject({ ownerGeneration: 1, replayed: false })

    target.ensureScopePrincipal(scope, 'owner:B', 10_000, lineage('principal-b', 2), cursor(3))
    const ownerA3 = target.ensureScopePrincipal(
      scope, 'owner:A', 11_000, lineage('principal-a', 3), cursor(4),
    )
    expect(ownerA3.generation).toBe(3)
    target.appendSignals([
      signal({ idempotencyKey: 'generation-3-ready-1', occurredAt: 11_010 }),
      signal({ idempotencyKey: 'generation-3-ready-2', occurredAt: 11_020 }),
    ], { ownerFence: ownerA3, admissionCursor: cursor(5) })
    const generation3Ready = target.list(scope, 10, 'owner:A', lineage('principal-a', 3))[0]!

    expect(() => target.activateHostOnce(
      scope,
      generation3Ready.id,
      generation3Ready.version,
      'host-activate-reused-after-owner-return',
      ownerA1,
    )).toThrowError(/principal fence changed/iu)
    expect(target.activateHostOnce(
      scope,
      generation3Ready.id,
      generation3Ready.version,
      'host-activate-reused-after-owner-return',
      ownerA3,
    )).toMatchObject({
      hypothesisId: generation3Ready.id,
      ownerGeneration: 3,
      principalLineageId: 'principal-a',
      principalLineageVersion: 3,
      replayed: false,
    })
    expect(target.overlaySnapshot(scope, 'owner:A', lineage('principal-a', 3)).text)
      .toContain('concise')
    target.close()
  })

  test('persists pause across restart and blocks collection, activation, and overlay injection', () => {
    const path = join(root(), 'learning-paused.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    let now = 10_000
    const first = store(() => now, path)
    const owner = first.ensureScopePrincipal(scope, 'owner:A', 9_000, OWNER_LINEAGE, cursor(1))
    first.appendSignals([
      signal({ idempotencyKey: 'paused-active-1', occurredAt: 9_100 }),
      signal({ idempotencyKey: 'paused-active-2', occurredAt: 9_200 }),
    ], { ownerFence: owner, admissionCursor: cursor(2) })
    const ready = first.list(scope, 10, 'owner:A', OWNER_LINEAGE)[0]!
    first.activate(scope, ready.id, ready.version, owner)
    first.appendSignals([signal({
      preferenceKey: 'response.structure', candidateValue: 'bullets',
      idempotencyKey: 'paused-shadow-1', occurredAt: 9_300,
    })], { ownerFence: owner, admissionCursor: cursor(3) })
    expect(first.overlaySnapshot(scope, 'owner:A', OWNER_LINEAGE).text).toContain('concise')

    expect(first.setScopeLearningPaused(scope, owner, true, cursor(4), 10_000, 'pause-learning'))
      .toMatchObject({ replayed: false, state: { mode: 'paused', signals: 3 } })
    now = 10_001
    expect(first.appendSignals([signal({
      preferenceKey: 'response.structure', candidateValue: 'bullets',
      idempotencyKey: 'paused-must-not-collect', occurredAt: 10_001,
    })], { ownerFence: owner, admissionCursor: cursor(5) })).toEqual([])
    expect(first.activateReadyScopes(10)).toBe(0)
    expect(first.overlaySnapshot(scope, 'owner:A', OWNER_LINEAGE).text).toBeUndefined()
    expect(first.health().signals).toBe(3)
    first.close()

    const restarted = store(() => 10_100, path)
    expect(restarted.scopeLearningStatus(scope, owner)).toMatchObject({
      mode: 'paused', signals: 3, activeOverlays: 0, shadowHypotheses: 1,
    })
    expect(restarted.overlaySnapshot(scope, 'owner:A', OWNER_LINEAGE).text).toBeUndefined()
    expect(restarted.activateReadyScopes(10)).toBe(0)
    restarted.close()
  })

  test('replays the exact stored control result after later resume and evidence', () => {
    const target = store(() => 20_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))
    target.appendSignals([signal({ idempotencyKey: 'receipt-before-pause' })], {
      ownerFence: owner, admissionCursor: cursor(2),
    })
    const paused = target.setScopeLearningPaused(
      scope, owner, true, cursor(3), 10_000, 'exact-pause-receipt',
    )
    expect(paused).toMatchObject({ applied: true, replayed: false, state: {
      mode: 'paused', signals: 1, hypotheses: 1,
    } })

    target.setScopeLearningPaused(scope, owner, false, cursor(4), 10_000, 'later-resume')
    target.appendSignals([signal({
      preferenceKey: 'response.structure', candidateValue: 'bullets',
      idempotencyKey: 'receipt-after-resume',
    })], { ownerFence: owner, admissionCursor: cursor(5) })
    expect(target.scopeLearningStatus(scope, owner)).toMatchObject({
      mode: 'active', signals: 2, hypotheses: 2,
    })

    const replay = target.setScopeLearningPaused(
      scope, owner, true, cursor(3), 10_000, 'exact-pause-receipt',
    )
    expect(replay).toEqual({ ...paused, replayed: true })
    target.close()
  })

  test('orders controls and same-millisecond events by durable admission cursor', () => {
    const target = store(() => 20_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))
    target.appendSignals([signal({ idempotencyKey: 'ordered-before-pause' })], {
      ownerFence: owner, admissionCursor: cursor(2),
    })
    target.setScopeLearningPaused(scope, owner, true, cursor(4), 10_000, 'ordered-pause')

    const delayedResume = target.setScopeLearningPaused(
      scope, owner, false, cursor(3), 19_000, 'delayed-older-resume',
    )
    expect(delayedResume).toMatchObject({ applied: false, state: { mode: 'paused' } })
    expect(target.setScopeLearningPaused(
      scope, owner, false, cursor(5), 10_000, 'ordered-resume',
    )).toMatchObject({ applied: true, state: { mode: 'active' } })

    expect(target.appendSignals([signal({
      preferenceKey: 'response.structure', candidateValue: 'bullets', occurredAt: 10_000,
      idempotencyKey: 'same-millisecond-after-resume',
    })], { ownerFence: owner, admissionCursor: cursor(6) })).toHaveLength(1)
    expect(target.scopeLearningStatus(scope, owner)).toMatchObject({ signals: 2 })
    target.close()
  })

  test('keeps status read-only so an earlier in-flight projection remains admissible', () => {
    const target = store(() => 20_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))

    expect(target.recordScopeLearningStatus(
      scope, owner, cursor(3), 20_000, 'read-only-status',
    )).toMatchObject({ applied: true, replayed: false, state: { signals: 0 } })
    expect(target.appendSignals([signal({
      idempotencyKey: 'in-flight-before-status', occurredAt: 19_999,
    })], { ownerFence: owner, admissionCursor: cursor(2) })).toHaveLength(1)
    expect(target.scopeLearningStatus(scope, owner)).toMatchObject({
      signals: 1,
      admissionHighWater: { epoch: ADMISSION_EPOCH, sequence: 2 },
    })
    target.close()
  })

  test('explains exact-lineage T1 state read-only and durably rolls back one catalog key', () => {
    const path = join(root(), 'learning-explain-rollback.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const target = store(() => 20_000, path)
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))
    target.appendSignals([
      signal({ idempotencyKey: 'rollback-ready-1' }),
      signal({ idempotencyKey: 'rollback-ready-2' }),
    ], { ownerFence: owner, admissionCursor: cursor(2) })
    const ready = target.list(scope, 10, 'owner:A', OWNER_LINEAGE)[0]!
    const active = target.activate(scope, ready.id, ready.version, owner)

    const explained = target.explainScopeLearning(
      scope, owner, cursor(4), 20_000, 'explain-active-t1',
    )
    expect(explained).toMatchObject({
      applied: true,
      replayed: false,
      state: { admissionHighWater: { epoch: ADMISSION_EPOCH, sequence: 2 } },
      explanation: [{
        key: 'response.verbosity', value: 'concise', state: 'active',
        version: active.version, supportingSignals: 2, contradictingSignals: 0,
      }],
    })
    // Explain at sequence 4 did not fence a projection that was already in flight at sequence 3.
    expect(target.appendSignals([signal({
      preferenceKey: 'response.structure', candidateValue: 'bullets',
      idempotencyKey: 'in-flight-before-explain', occurredAt: 19_999,
    })], { ownerFence: owner, admissionCursor: cursor(3) })).toHaveLength(1)

    const rolledBack = target.rollbackScopeLearningKey(
      scope, owner, 'response.verbosity', cursor(5), 20_000, 'rollback-active-t1',
    )
    expect(rolledBack).toMatchObject({
      applied: true, replayed: false, rolledBack: true,
      rolledBackVersion: active.version + 1,
      state: {
        activeOverlays: 0, storedActiveOverlays: 0,
        admissionHighWater: { epoch: ADMISSION_EPOCH, sequence: 5 },
        ignoreEventsThrough: { epoch: ADMISSION_EPOCH, sequence: 5 },
      },
    })
    expect(target.appendSignals([signal({
      idempotencyKey: 'projection-before-rollback', occurredAt: 19_999,
    })], { ownerFence: owner, admissionCursor: cursor(4) })).toEqual([])
    target.close()

    const restarted = store(() => 20_001, path)
    expect(restarted.rollbackScopeLearningKey(
      scope, owner, 'response.verbosity', cursor(5), 20_000, 'rollback-active-t1',
    )).toEqual({ ...rolledBack, replayed: true })
    const receiptAudit = new DatabaseSync(path, { readOnly: true })
    expect(receiptAudit.prepare(`
      SELECT COUNT(*) AS count FROM preference_transitions
      WHERE hypothesis_id = ? AND reason = 'owner-rejected'
    `).get(active.id)).toEqual({ count: 1 })
    receiptAudit.close()
    const noActive = restarted.rollbackScopeLearningKey(
      scope, owner, 'response.verbosity', cursor(6), 20_001, 'rollback-no-active-t1',
    )
    expect(noActive).toMatchObject({ applied: true, replayed: false, rolledBack: false })
    expect(noActive).not.toHaveProperty('rolledBackVersion')
    expect(() => restarted.rollbackScopeLearningKey(
      scope, owner, 'memory.retention', cursor(7), 20_001, 'rollback-wrong-tier',
    )).toThrowError(/T1/iu)
    expect(restarted.ensureScopePrincipal(
      scope, 'owner:B', 20_001, lineage('delivery-principal-b'), cursor(8),
    )).toMatchObject({ accepted: true, reset: true })
    expect(() => restarted.rollbackScopeLearningKey(
      scope, owner, 'response.verbosity', cursor(9), 20_001, 'rollback-stale-owner',
    )).toThrowError(/principal fence changed/iu)
    restarted.close()
  })

  test('exports a durable content-free T1 snapshot without advancing admission order', () => {
    const path = join(root(), 'learning-export.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const first = store(() => 20_000, path)
    const owner = first.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))
    first.appendSignals([
      signal({ idempotencyKey: 'export-ready-1' }),
      signal({ idempotencyKey: 'export-ready-2' }),
    ], { ownerFence: owner, admissionCursor: cursor(2) })
    const ready = first.list(scope, 10, 'owner:A', OWNER_LINEAGE)[0]!
    first.activate(scope, ready.id, ready.version, owner)

    const exported = first.exportScopeLearning(
      scope, owner, cursor(4), 20_000, 'export-active-t1',
    )
    expect(exported).toMatchObject({
      applied: true, replayed: false,
      state: { admissionHighWater: { epoch: ADMISSION_EPOCH, sequence: 2 } },
      records: [{
        key: 'response.verbosity', value: 'concise', state: 'active',
        supportingSignals: 2, contradictingSignals: 0,
      }],
    })
    expect(JSON.stringify(exported.records)).not.toMatch(/work|owner|principal|lineage|idempot|inbox|outbox/iu)
    expect(first.appendSignals([signal({
      preferenceKey: 'response.structure', candidateValue: 'bullets',
      idempotencyKey: 'in-flight-before-export', occurredAt: 19_999,
    })], { ownerFence: owner, admissionCursor: cursor(3) })).toHaveLength(1)
    expect(first.exportScopeLearning(
      scope, owner, cursor(4), 20_000, 'export-active-t1',
    )).toEqual({ ...exported, replayed: true })
    first.close()

    const restarted = store(() => 20_001, path)
    expect(restarted.exportScopeLearning(
      scope, owner, cursor(4), 20_000, 'export-active-t1',
    )).toEqual({ ...exported, replayed: true })
    restarted.close()
  })

  test('resume admits only events newer than its durable cutoff', () => {
    const target = store(() => 20_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 9_000, OWNER_LINEAGE, cursor(1))
    target.appendSignals([signal({ idempotencyKey: 'before-pause', occurredAt: 9_500 })], {
      ownerFence: owner, admissionCursor: cursor(2),
    })
    target.setScopeLearningPaused(scope, owner, true, cursor(3), 10_000, 'pause-before-resume')
    target.setScopeLearningPaused(scope, owner, false, cursor(4), 11_000, 'resume-learning')

    expect(target.scopeAcceptsEvent(scope, owner, cursor(3))).toBe(false)
    expect(target.appendSignals([signal({
      idempotencyKey: 'queued-before-resume', occurredAt: 10_500,
    })], { ownerFence: owner, admissionCursor: cursor(3) })).toEqual([])
    expect(target.scopeAcceptsEvent(scope, owner, cursor(5))).toBe(true)
    expect(target.appendSignals([signal({
      idempotencyKey: 'new-after-resume', occurredAt: 11_001,
    })], { ownerFence: owner, admissionCursor: cursor(5) })).toHaveLength(1)
    expect(target.scopeLearningStatus(scope, owner)).toMatchObject({ mode: 'active', signals: 2 })
    target.close()
  })

  test('forget advances the projection cutoff without clearing a paused owner state', () => {
    const path = join(root(), 'learning-forget-paused.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    let now = 10_000
    const first = store(() => now, path)
    const owner = first.ensureScopePrincipal(scope, 'owner:A', 9_000, OWNER_LINEAGE, cursor(1))
    first.appendSignals([signal({ idempotencyKey: 'forget-existing', occurredAt: 9_500 })], {
      ownerFence: owner, admissionCursor: cursor(2),
    })
    first.setScopeLearningPaused(scope, owner, true, cursor(3), 10_000, 'pause-before-forget')
    now = 10_100
    expect(first.forgetScope(scope, 'forget-confirmed', {
      ownerFence: owner, admissionCursor: cursor(4), occurredAt: 10_100,
    })).toMatchObject({
      replayed: false, deletedSignals: 1, deletedHypotheses: 1, forgottenThrough: 10_100,
    })
    expect(first.scopeLearningStatus(scope, owner)).toMatchObject({
      mode: 'paused', signals: 0, hypotheses: 0,
      ignoreEventsThrough: { epoch: ADMISSION_EPOCH, sequence: 4 },
    })
    expect(first.appendSignals([signal({
      idempotencyKey: 'old-durable-projection', occurredAt: 10_050,
    })], { ownerFence: owner, admissionCursor: cursor(3) })).toEqual([])
    first.close()

    const restarted = store(() => 10_200, path)
    expect(restarted.scopeLearningStatus(scope, owner)).toMatchObject({
      mode: 'paused', signals: 0, hypotheses: 0,
      ignoreEventsThrough: { epoch: ADMISSION_EPOCH, sequence: 4 },
    })
    expect(restarted.appendSignals([signal({
      idempotencyKey: 'old-durable-projection-retry', occurredAt: 10_050,
    })], { ownerFence: owner, admissionCursor: cursor(3) })).toEqual([])
    expect(restarted.list(scope, 10, 'owner:A', OWNER_LINEAGE)).toEqual([])
    restarted.close()
  })

  test('admits an owner event after forget in the same millisecond when its cursor is newer', () => {
    const target = store(() => 10_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))
    target.appendSignals([signal({ idempotencyKey: 'same-ms-before-forget' })], {
      ownerFence: owner, admissionCursor: cursor(2),
    })
    expect(target.forgetScope(scope, 'same-ms-forget', {
      ownerFence: owner, admissionCursor: cursor(3), occurredAt: 10_000,
    })).toMatchObject({ applied: true, deletedSignals: 1 })
    expect(target.appendSignals([signal({
      idempotencyKey: 'same-ms-after-forget', occurredAt: 10_000,
    })], { ownerFence: owner, admissionCursor: cursor(4) })).toHaveLength(1)
    expect(target.health()).toMatchObject({ signals: 1, hypotheses: 1 })
    target.close()
  })

  test('forget removes historical control snapshots and older scope tombstones', () => {
    const path = join(root(), 'learning-forget-privacy.sqlite')
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const target = store(() => 20_000, path)
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 10_000, OWNER_LINEAGE, cursor(1))
    target.appendSignals([signal({ idempotencyKey: 'privacy-before-forget' })], {
      ownerFence: owner, admissionCursor: cursor(2),
    })
    target.recordScopeLearningStatus(scope, owner, cursor(3), 20_000, 'privacy-old-status')
    target.setScopeLearningPaused(scope, owner, true, cursor(4), 20_000, 'privacy-old-pause')
    target.forgetScope(scope, 'privacy-first-forget', {
      ownerFence: owner, admissionCursor: cursor(5), occurredAt: 20_000,
    })
    target.setScopeLearningPaused(scope, owner, false, cursor(6), 20_001, 'privacy-resume')
    target.appendSignals([signal({ idempotencyKey: 'privacy-second-signal', occurredAt: 20_000 })], {
      ownerFence: owner, admissionCursor: cursor(7),
    })
    target.forgetScope(scope, 'privacy-second-forget', {
      ownerFence: owner, admissionCursor: cursor(8), occurredAt: 20_003,
    })
    target.close()

    const database = new DatabaseSync(path, { readOnly: true })
    expect(database.prepare(`
      SELECT action, result_signals, result_hypotheses
      FROM preference_owner_control_receipts
    `).all()).toEqual([{ action: 'forget', result_signals: 0, result_hypotheses: 0 }])
    expect(database.prepare(`
      SELECT deleted_signals, deleted_hypotheses
      FROM preference_scope_tombstones
    `).all()).toEqual([{ deleted_signals: 1, deleted_hypotheses: 1 }])
    database.close()

    // Replaying an old read after the privacy boundary must not reconstruct a
    // snapshot from either the deleted generation or later learned data.
    const restarted = store(() => 20_004, path)
    expect(restarted.recordScopeLearningStatus(
      scope, owner, cursor(3), 20_000, 'privacy-old-status',
    )).toMatchObject({ applied: false, replayed: false, state: { signals: 0, hypotheses: 0 } })
    restarted.close()
  })

  test('never rebuilds a forgotten export request from post-forget preferences', () => {
    const target = store(() => 30_000)
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const owner = target.ensureScopePrincipal(scope, 'owner:A', 20_000, OWNER_LINEAGE, cursor(1))
    target.appendSignals([signal({ idempotencyKey: 'export-before-forget' })], {
      ownerFence: owner, admissionCursor: cursor(2),
    })
    const before = target.exportScopeLearning(
      scope, owner, cursor(3), 30_000, 'old-export-request',
    )
    expect(before.records).toEqual([expect.objectContaining({
      key: 'response.verbosity', value: 'concise',
    })])

    expect(target.forgetScope(scope, 'forget-after-export', {
      ownerFence: owner, admissionCursor: cursor(4), occurredAt: 30_001,
    })).toMatchObject({ applied: true })
    target.appendSignals([signal({
      preferenceKey: 'response.structure', candidateValue: 'bullets',
      idempotencyKey: 'post-forget-preference', occurredAt: 30_000,
    })], { ownerFence: owner, admissionCursor: cursor(5) })

    expect(target.exportScopeLearning(
      scope, owner, cursor(3), 30_000, 'old-export-request',
    )).toMatchObject({ applied: false, replayed: false, records: [] })
    expect(target.exportScopeLearning(
      scope, owner, cursor(6), 30_003, 'new-export-request',
    )).toMatchObject({
      applied: true,
      records: [expect.objectContaining({
        key: 'response.structure', value: 'bullets',
      })],
    })
    target.close()
  })

  test('records typed signals idempotently without retaining the raw idempotency key', () => {
    const target = store()
    const first = target.appendSignal(signal())
    expect(first.idempotencyKey).toMatch(/^pref-idem-[a-f0-9]{64}$/u)
    expect(first.idempotencyKey).not.toContain('signal-1')
    expect(target.appendSignal(signal())).toEqual(first)
    expect(() => target.appendSignal(signal({ candidateValue: 'detailed' })))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'idempotency-conflict' }))
    target.close()
  })

  test('rolls back the whole producer batch when any durable receipt would be invalid', () => {
    const target = store()
    target.appendSignal(signal({ idempotencyKey: 'already-recorded' }))

    expect(() => target.appendSignals([
      signal({
        preferenceKey: 'response.structure', candidateValue: 'bullets',
        idempotencyKey: 'must-not-partially-record',
      }),
      signal({ candidateValue: 'detailed', idempotencyKey: 'already-recorded' }),
    ])).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({
      code: 'idempotency-conflict',
    }))

    expect(target.health().signals).toBe(1)
    expect(target.list({ workspace: '/work/alpha', preset: 'primary' }))
      .not.toContainEqual(expect.objectContaining({ preferenceKey: 'response.structure' }))
    target.close()
  })

  test('keeps T0 observational, makes T2 proposal-only, and forbids T3', () => {
    const target = store()
    target.appendSignal(signal({
      preferenceKey: 'feedback.response', candidateValue: 'helpful', idempotencyKey: 'feedback',
    }))
    expect(target.list({ workspace: '/work/alpha', preset: 'primary' })).toEqual([])

    target.appendSignal(signal({
      preferenceKey: 'memory.retention', candidateValue: 'long-term', idempotencyKey: 'memory',
    }))
    const proposed = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    expect(proposed).toMatchObject({ riskTier: 'T2', claimState: 'proposed', effectState: 'inactive' })
    expect(() => target.activate(proposed.scope, proposed.id, proposed.version))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'forbidden-tier' }))

    expect(() => target.appendSignal(signal({
      preferenceKey: 'policy.approval_boundary', candidateValue: 'host-defined', idempotencyKey: 'policy',
    }))).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'forbidden-tier' }))
    target.close()
  })

  test('computes bounded confidence, activates only ready T1, and rolls back on newer owner correction', () => {
    const target = store()
    target.appendSignal(signal({ idempotencyKey: 'support-1', occurredAt: 9_900 }))
    let hypothesis = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    expect(hypothesis).toMatchObject({
      riskTier: 'T1', claimState: 'tentative', effectState: 'shadow', supportingSignals: 1,
    })
    expect(() => target.activate(hypothesis.scope, hypothesis.id, hypothesis.version))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'not-ready' }))

    target.appendSignal(signal({ idempotencyKey: 'support-2', occurredAt: 9_901 }))
    hypothesis = target.list(hypothesis.scope)[0]!
    expect(hypothesis.confidenceBps).toBeGreaterThanOrEqual(9_900)
    hypothesis = target.activate(hypothesis.scope, hypothesis.id, hypothesis.version)
    expect(hypothesis).toMatchObject({ effectState: 'active' })
    expect(target.overlay(hypothesis.scope)).toContain('Prefer concise responses.')

    target.appendSignal(signal({
      candidateValue: 'detailed', idempotencyKey: 'contradiction', occurredAt: 10_000,
    }))
    const rolledBack = target.get(hypothesis.scope, hypothesis.id)!
    expect(rolledBack).toMatchObject({
      claimState: 'rejected', effectState: 'rolled-back', version: hypothesis.version + 1,
    })
    expect(target.overlay(hypothesis.scope)).toBeUndefined()
    target.close()
  })

  test('never rolls back a newer active owner preference for delayed older feedback', () => {
    const target = store()
    target.appendSignal(signal({ idempotencyKey: 'newer-owner-1', occurredAt: 9_990 }))
    target.appendSignal(signal({ idempotencyKey: 'newer-owner-2', occurredAt: 9_991 }))
    const ready = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    const active = target.activate(ready.scope, ready.id, ready.version)

    target.appendSignal(signal({
      candidateValue: 'detailed',
      idempotencyKey: 'delayed-older-owner-selection',
      occurredAt: 9_000,
    }))

    expect(target.get(active.scope, active.id)).toMatchObject({
      claimState: 'tentative', effectState: 'active',
    })
    expect(target.overlay(active.scope)).toContain('concise')
    target.close()
  })

  test('never activates from unverified or model-inferred repetition alone', () => {
    const target = store()
    for (let index = 0; index < 30; index += 1) {
      target.appendSignal(signal({
        scope: { workspace: '/work/unverified', preset: 'primary' },
        actorTrust: 'unverified',
        interpretationTrust: 'typed-feedback',
        source: 'system-observation',
        idempotencyKey: `unverified-${index}`,
      }))
      target.appendSignal(signal({
        scope: { workspace: '/work/model', preset: 'primary' },
        actorTrust: 'owner-authenticated',
        interpretationTrust: 'model-inference',
        source: 'system-observation',
        idempotencyKey: `model-${index}`,
      }))
    }
    for (const workspace of ['/work/unverified', '/work/model']) {
      const hypothesis = target.list({ workspace, preset: 'primary' })[0]!
      expect(hypothesis).toMatchObject({ effectState: 'shadow', supportingSignals: 0 })
      expect(() => target.activate(hypothesis.scope, hypothesis.id, hypothesis.version))
        .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'not-ready' }))
    }
    target.close()
  })

  test('never lets low-trust inference roll back an active owner preference', () => {
    const target = store()
    target.appendSignal(signal({ idempotencyKey: 'owner-1' }))
    target.appendSignal(signal({ idempotencyKey: 'owner-2', occurredAt: 9_999 }))
    const ready = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    const active = target.activate(ready.scope, ready.id, ready.version)

    for (let index = 0; index < 20; index += 1) {
      target.appendSignal(signal({
        candidateValue: 'detailed',
        actorTrust: 'owner-authenticated',
        interpretationTrust: 'model-inference',
        source: 'system-observation',
        occurredAt: 9_900 - index,
        idempotencyKey: `low-trust-contradiction-${index}`,
      }))
    }
    expect(target.get(active.scope, active.id)).toMatchObject({
      claimState: 'tentative', effectState: 'active', confidenceBps: expect.any(Number),
    })
    expect(target.overlay(active.scope)).toContain('concise')
    target.close()
  })

  test('gives the latest explicit owner selection precedence over accumulated old choices', () => {
    const target = store()
    for (let index = 0; index < 4; index += 1) {
      target.appendSignal(signal({
        occurredAt: 9_900 + index,
        idempotencyKey: `old-concise-${index}`,
      }))
    }
    target.appendSignal(signal({
      candidateValue: 'detailed', occurredAt: 10_000, idempotencyKey: 'latest-detailed',
    }))
    const hypotheses = target.list({ workspace: '/work/alpha', preset: 'primary' })
    const concise = hypotheses.find(item => item.candidateValue === 'concise')!
    const detailed = hypotheses.find(item => item.candidateValue === 'detailed')!
    expect(() => target.activate(concise.scope, concise.id, concise.version))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'not-ready' }))
    expect(() => target.activate(detailed.scope, detailed.id, detailed.version))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'not-ready' }))
    target.close()
  })

  test('isolates exact Agent scopes and enforces one active value per catalog key', () => {
    const target = store()
    for (let index = 1; index <= 2; index += 1) {
      target.appendSignal(signal({ idempotencyKey: `alpha-${index}`, occurredAt: 10_000 - index }))
      target.appendSignal(signal({
        scope: { workspace: '/work/beta', preset: 'primary' },
        idempotencyKey: `beta-${index}`,
        occurredAt: 10_000 - index,
      }))
    }
    const alpha = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    const beta = target.list({ workspace: '/work/beta', preset: 'primary' })[0]!
    target.activate(alpha.scope, alpha.id, alpha.version)
    expect(target.overlay(alpha.scope)).toContain('concise')
    expect(target.overlay(beta.scope)).toBeUndefined()
    expect(target.get(beta.scope, alpha.id)).toBeUndefined()
    target.close()
  })

  test('expires decayed hypotheses deterministically', () => {
    let now = 1_000
    const target = new PreferenceStore({
      path: ':memory:', now: () => now, signalTtlMs: 10_000, hypothesisTtlMs: 2_000,
      minSignalsForActivation: 2, minConfidenceBps: 7_500, maxContradictionBps: 2_500,
      maxActiveOverlays: 2, maxReviewHypotheses: 10, maxOverlayBytes: 2_048,
    })
    target.appendSignal(signal({ occurredAt: 1_000, idempotencyKey: 'expiring' }))
    now = 3_001
    expect(target.list({ workspace: '/work/alpha', preset: 'primary' })[0]).toMatchObject({
      claimState: 'expired', effectState: 'inactive', confidenceBps: expect.any(Number),
    })
    target.close()
  })

  test('forgets an exact scope durably while leaving other scopes intact', () => {
    let now = 10_000
    const target = store(() => now)
    target.appendSignal(signal({ idempotencyKey: 'old-alpha' }))
    target.appendSignal(signal({
      scope: { workspace: '/work/beta', preset: 'primary' }, idempotencyKey: 'beta',
    }))
    const forgotten = target.forgetScope({ workspace: '/work/alpha', preset: 'primary' }, 'forget-alpha')
    expect(forgotten).toMatchObject({ replayed: false, deletedSignals: 1, deletedHypotheses: 1 })
    expect(target.forgetScope({ workspace: '/work/alpha', preset: 'primary' }, 'forget-alpha'))
      .toEqual({ ...forgotten, replayed: true })
    expect(target.list({ workspace: '/work/alpha', preset: 'primary' })).toEqual([])
    expect(target.list({ workspace: '/work/beta', preset: 'primary' })).toHaveLength(1)
    expect(() => target.appendSignal(signal({ idempotencyKey: 'replayed-old' })))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'scope-forgotten' }))
    now = 20_000
    expect(target.appendSignal(signal({ occurredAt: 20_000, idempotencyKey: 'new-alpha' }))).toBeDefined()
    target.close()
  })

  test('does not report privacy forget success while exact scope bytes remain in DB or WAL files', () => {
    const directory = root()
    const path = join(directory, 'privacy.sqlite')
    const secretWorkspace = '/work/SECRET_SCOPE_6c8d899a6f13'
    const target = store(() => 10_000, path)
    target.appendSignal(signal({
      scope: { workspace: secretWorkspace, preset: 'primary' },
      idempotencyKey: 'privacy-scan-signal',
    }))
    const files = [path, `${path}-wal`, `${path}-shm`]
    const secretBytes = Buffer.from(secretWorkspace)
    expect(files.some(file => existsSync(file) && readFileSync(file).includes(secretBytes))).toBe(true)

    expect(target.forgetScope(
      { workspace: secretWorkspace, preset: 'primary' },
      'privacy-scan-forget',
    )).toMatchObject({ replayed: false, deletedSignals: 1, deletedHypotheses: 1 })
    expect(files.every(file => !existsSync(file) || !readFileSync(file).includes(secretBytes))).toBe(true)
    if (existsSync(`${path}-wal`)) expect(statSync(`${path}-wal`).size).toBe(0)
    target.close()
  })

  test('Host maintenance receipts retain only a scope digest across a later privacy forget', () => {
    let now = 10_000
    const directory = root()
    const path = join(directory, 'maintenance-privacy.sqlite')
    const secretWorkspace = '/work/MAINTENANCE_SECRET_SCOPE_7b216f49'
    const target = store(() => now, path)
    const scope = { workspace: secretWorkspace, preset: 'primary' }
    const ownerFence = target.ensureScopePrincipal(scope, 'owner:A', now, OWNER_LINEAGE, cursor(1))
    target.appendSignals([
      signal({ scope, idempotencyKey: 'maintenance-private-signal' }),
    ], { ownerFence, admissionCursor: cursor(2) })
    now = 110_001
    expect(target.maintainScopeOnce(scope, 'maintenance-private-operation', ownerFence))
      .toEqual({
        deletedSignals: 1, replayed: false, ownerGeneration: ownerFence.generation,
        principalLineageId: ownerFence.principalLineageId,
        principalLineageVersion: ownerFence.principalLineageVersion,
      })
    expect(target.forgetScope(scope, 'maintenance-private-forget'))
      .toMatchObject({ deletedSignals: 0, deletedHypotheses: 1 })

    const receiptDatabase = new DatabaseSync(path, { readOnly: true })
    const receipt = receiptDatabase.prepare(`
      SELECT scope_digest FROM preference_host_maintenance_receipts
      WHERE idempotency_key LIKE 'pref-host-maint-idem-%'
    `).get() as { scope_digest: string }
    expect(receipt.scope_digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.scope_digest).not.toContain(secretWorkspace)
    receiptDatabase.close()
    expect(target.maintainScopeOnce(scope, 'maintenance-private-operation', ownerFence))
      .toEqual({
        deletedSignals: 1, replayed: true, ownerGeneration: ownerFence.generation,
        principalLineageId: ownerFence.principalLineageId,
        principalLineageVersion: ownerFence.principalLineageVersion,
      })
    target.close()
  })

  test('reports content-free aggregate health only', () => {
    const target = store()
    target.appendSignal(signal())
    const health = target.health()
    expect(health).toMatchObject({ ready: true, enabled: true, signals: 1, hypotheses: 1, shadow: 1 })
    expect(JSON.stringify(health)).not.toMatch(/workspace|verbosity|concise|primary/u)
    target.close()
  })

  test('physically purges expired signal rows in bounded maintenance batches', () => {
    let now = 10_000
    const target = store(() => now)
    target.appendSignal(signal({ idempotencyKey: 'retained-1' }))
    target.appendSignal(signal({ idempotencyKey: 'retained-2' }))
    now = 110_001
    expect(target.maintain(1)).toEqual({ deletedSignals: 1 })
    expect(target.health().signals).toBe(1)
    expect(target.maintain(1)).toEqual({ deletedSignals: 1 })
    expect(target.health().signals).toBe(0)
    expect(target.maintain(1)).toEqual({ deletedSignals: 0 })
    target.close()
  })

  test('Host maintenance receipt cannot be replayed against another scope', () => {
    let now = 10_000
    const target = store(() => now)
    const alphaScope = { workspace: '/work/alpha', preset: 'primary' }
    const betaScope = { workspace: '/work/beta', preset: 'primary' }
    const alphaOwner = target.ensureScopePrincipal(
      alphaScope, 'owner:A', now, lineage('principal-a'), cursor(1),
    )
    const betaOwner = target.ensureScopePrincipal(
      betaScope, 'owner:B', now, lineage('principal-b'), cursor(1),
    )
    target.appendSignals([
      signal({ idempotencyKey: 'host-maintenance-alpha' }),
    ], { ownerFence: alphaOwner, admissionCursor: cursor(2) })
    target.appendSignals([signal({
      scope: betaScope,
      idempotencyKey: 'host-maintenance-beta',
    })], { ownerFence: betaOwner, admissionCursor: cursor(2) })
    now = 110_001
    expect(target.maintainScopeOnce(
      { workspace: '/work/alpha', preset: 'primary' },
      'same-host-maintenance-operation',
      alphaOwner,
    )).toEqual({
      deletedSignals: 1, replayed: false, ownerGeneration: alphaOwner.generation,
      principalLineageId: alphaOwner.principalLineageId,
      principalLineageVersion: alphaOwner.principalLineageVersion,
    })
    expect(() => target.maintainScopeOnce(
      { workspace: '/work/beta', preset: 'primary' },
      'same-host-maintenance-operation',
      betaOwner,
    )).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({
      code: 'idempotency-conflict',
    }))
    expect(target.health().signals).toBe(1)
    target.close()
  })

  test('does not report TTL deletion success while expired signal bytes remain in DB or WAL files', () => {
    let now = 10_000
    const directory = root()
    const path = join(directory, 'retention.sqlite')
    const expiredWorkspace = '/work/EXPIRED_SCOPE_e0c1ce2fb1e2'
    const target = store(() => now, path)
    target.appendSignal(signal({
      scope: { workspace: expiredWorkspace, preset: 'primary' },
      preferenceKey: 'feedback.response',
      candidateValue: 'helpful',
      idempotencyKey: 'retention-scan-signal',
    }))
    const files = [path, `${path}-wal`, `${path}-shm`]
    const expiredBytes = Buffer.from(expiredWorkspace)
    expect(files.some(file => existsSync(file) && readFileSync(file).includes(expiredBytes))).toBe(true)

    now = 110_001
    expect(target.maintain()).toEqual({ deletedSignals: 1 })
    expect(files.every(file => !existsSync(file) || !readFileSync(file).includes(expiredBytes))).toBe(true)
    if (existsSync(`${path}-wal`)) expect(statSync(`${path}-wal`).size).toBe(0)
    target.close()
  })
})
