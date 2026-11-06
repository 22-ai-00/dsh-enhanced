import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemOutcomeRecord, WorkItemProvenance } from '../src/types.ts'
import {
  admitted,
  claim,
  harness,
  report,
  SETTLE_WINDOW,
  signal,
  withoutProvenance,
} from './fixtures.ts'

const ITEM_DDL = `
CREATE TABLE work_item (
  id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL, dedup_bucket INTEGER NOT NULL,
  source_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
  title TEXT NOT NULL, brief TEXT NOT NULL, brief_truncated INTEGER NOT NULL CHECK(brief_truncated IN (0, 1)),
  origin_binding_id TEXT NOT NULL, acceptance_ref TEXT,
  workspace TEXT NOT NULL, agent_preset TEXT NOT NULL,
  principal_id TEXT NOT NULL, principal_record_id TEXT NOT NULL, principal_version INTEGER NOT NULL,
  binding_version INTEGER NOT NULL, owner_generation INTEGER NOT NULL, owner_route_id TEXT NOT NULL,
  scope_expires_at INTEGER NOT NULL,
  worker_automation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'claimed', 'working', 'waiting', 'ready', 'blocked', 'failed', 'dropped')),
  state_reason TEXT,
  attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
  lease_until INTEGER, lease_run_id TEXT, occurrence_id TEXT,
  work_dir TEXT NOT NULL,
  last_report_status TEXT CHECK(last_report_status IN ('progress', 'waiting', 'ready', 'blocked', 'failed')),
  observed INTEGER NOT NULL CHECK(observed IN (0, 1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(dedup_key, dedup_bucket)
) STRICT;
CREATE TABLE work_item_event (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  detail TEXT, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, sequence)
) STRICT, WITHOUT ROWID;
CREATE TABLE work_item_report (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('progress', 'waiting', 'ready', 'blocked', 'failed')),
  summary TEXT NOT NULL, truncated INTEGER NOT NULL CHECK(truncated IN (0, 1)),
  artifact_paths TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  delivery_key TEXT NOT NULL UNIQUE,
  delivery_state TEXT CHECK(delivery_state IN ('pending', 'sent', 'failed', 'unknown')),
  delivery_id TEXT, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, revision)
) STRICT;
CREATE TABLE work_item_dispatch (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE RESTRICT,
  automation_id TEXT NOT NULL, event_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'dispatched', 'failed')),
  occurrence_id TEXT, reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(automation_id, event_id)
) STRICT;
CREATE TABLE work_item_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
`

const ITEM_ROW = `
INSERT INTO work_item(id, dedup_key, dedup_bucket, source_id, kind, external_id, title, brief, brief_truncated,
  origin_binding_id, acceptance_ref, workspace, agent_preset, principal_id, principal_record_id, principal_version,
  binding_version, owner_generation, owner_route_id, scope_expires_at, worker_automation_id, state, state_reason,
  attempt, max_attempts, lease_until, lease_run_id, occurrence_id, work_dir, last_report_status, observed,
  created_at, updated_at)
VALUES ('item-legacy', 'dedup-legacy', 0, 'work-items/v1', 'review', 'ext-legacy', 'Legacy item', 'Legacy brief', 0,
  'binding-origin-1', NULL, '/work/alpha', 'primary', 'owner:me', 'principal-1', 7,
  3, 2, 'route-1', 1700086400000, 'work-items-worker', 'blocked', NULL,
  1, 3, NULL, NULL, NULL, '/work/alpha/item-legacy', 'blocked', 1,
  1700000000000, 1700000000000);
INSERT INTO work_item_report(item_id, revision, status, summary, truncated, artifact_paths, idempotency_key,
  delivery_key, delivery_state, delivery_id, recorded_at)
VALUES ('item-legacy', 1, 'blocked', 'Legacy report', 0, '[]', 'legacy-idem', 'legacy-delivery', 'sent', 'outbox-legacy', 1700000000000);
`

/**
 * Write a literal version 4 database: the outcome ledger and dispatch witness
 * columns already exist, but no Evaluation projection columns do.
 */
function v4Database(): { path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'work-items-v4-'))
  chmodSync(root, 0o700)
  const path = join(root, 'v4.sqlite')
  const raw = new DatabaseSync(path)
  chmodSync(path, 0o600)
  raw.exec(ITEM_DDL)
  raw.exec(`CREATE TABLE work_item_claim (
      claim_id INTEGER PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
      leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX work_item_claim_run_idx ON work_item_claim(run_id);
    CREATE TABLE work_item_outcome (
      item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL,
      settled_by TEXT NOT NULL CHECK(settled_by IN ('report-ready', 'report-blocked', 'report-failed', 'withdrawn', 'retry-exhausted', 'observed-evidence', 'window-expired')),
      execution_status TEXT NOT NULL CHECK(execution_status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'unknown')),
      objective_status TEXT NOT NULL CHECK(objective_status IN ('achieved', 'partial', 'not-achieved', 'unknown')),
      trust TEXT NOT NULL CHECK(trust IN ('agent-self-report', 'external-receipt', 'deterministic-check')),
      evidence_state TEXT NOT NULL CHECK(evidence_state IN ('pending', 'observed', 'unverified', 'not-applicable')),
      evidence_reason TEXT CHECK(evidence_reason IN ('no-independent-source', 'evidence-too-large', 'window-expired', 'channel-unavailable')),
      evidence TEXT, baseline_sequence INTEGER, inbox_id TEXT, authority_hash TEXT, deadline_at INTEGER,
      settled_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
      PRIMARY KEY(item_id, revision)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX work_item_outcome_pending_idx ON work_item_outcome(evidence_state, deadline_at);
    ALTER TABLE work_item_dispatch ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE work_item_dispatch ADD COLUMN wake_attempts INTEGER NOT NULL DEFAULT 0;`)
  raw.exec(ITEM_ROW)
  raw.exec(`INSERT INTO work_item_claim(item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at)
    VALUES ('item-legacy', 'run-legacy', 'occ-legacy', 'active', 1700086400000, 1700000000000, 1700000000000);`)
  raw.exec(`INSERT INTO work_item_dispatch(item_id, automation_id, event_id, occurred_at, state, occurrence_id, reason, created_at, updated_at, generation, wake_attempts)
    VALUES ('item-legacy', 'work-items-worker', 'item-legacy', 1700000000000, 'dispatched', 'occ-legacy', NULL, 1700000000000, 1700000000000, 2, 1);
    INSERT INTO work_item_outcome(item_id, revision, settled_by, execution_status, objective_status, trust,
      evidence_state, evidence_reason, evidence, baseline_sequence, inbox_id, authority_hash, deadline_at, settled_at, recorded_at)
    VALUES ('item-legacy', 2, 'observed-evidence', 'succeeded', 'unknown', 'external-receipt',
      'observed', NULL, NULL, 5, 'inbox-1', 'sha256:authority', NULL, 1700000001000, 1700000001000);`)
  raw.exec(`INSERT INTO work_item_schema_meta(key, value) VALUES ('schema_version', '4');
    PRAGMA user_version = 4;`)
  raw.close()
  return { path, root }
}

/**
 * Write a literal pre-v3 database: schema *and* data exist independently of the
 * current store, so the upgrade path is exercised as a real old file would be.
 */
function legacyDatabase(version: 1 | 2 | 3): { path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'work-items-legacy-'))
  chmodSync(root, 0o700)
  const path = join(root, 'legacy.sqlite')
  const raw = new DatabaseSync(path)
  chmodSync(path, 0o600)
  raw.exec(ITEM_DDL)
  raw.exec(version === 2
    ? `CREATE TABLE work_item_claim (
        claim_id INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
        leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX work_item_claim_run_idx ON work_item_claim(run_id);`
    : `CREATE TABLE work_item_claim (
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
        leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(item_id, run_id)
      ) STRICT;`)
  raw.exec(ITEM_ROW)
  if (version === 3) {
    raw.exec(`CREATE TABLE work_item_outcome (
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL,
        settled_by TEXT NOT NULL CHECK(settled_by IN ('report-ready', 'report-blocked', 'report-failed', 'withdrawn', 'retry-exhausted', 'observed-evidence', 'window-expired')),
        execution_status TEXT NOT NULL CHECK(execution_status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'unknown')),
        objective_status TEXT NOT NULL CHECK(objective_status IN ('achieved', 'partial', 'not-achieved', 'unknown')),
        trust TEXT NOT NULL CHECK(trust IN ('agent-self-report', 'external-receipt', 'deterministic-check')),
        evidence_state TEXT NOT NULL CHECK(evidence_state IN ('pending', 'observed', 'unverified', 'not-applicable')),
        evidence_reason TEXT CHECK(evidence_reason IN ('no-independent-source', 'evidence-too-large', 'window-expired', 'channel-unavailable')),
        evidence TEXT, baseline_sequence INTEGER, inbox_id TEXT, authority_hash TEXT, deadline_at INTEGER,
        settled_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(item_id, revision)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX work_item_outcome_pending_idx ON work_item_outcome(evidence_state, deadline_at);
      INSERT INTO work_item_dispatch(item_id, automation_id, event_id, occurred_at, state, occurrence_id, reason, created_at, updated_at)
        VALUES ('item-legacy', 'work-items-worker', 'item-legacy', 1700000000000, 'dispatched', 'occ-legacy', NULL, 1700000000000, 1700000000000);`)
  }
  raw.exec(`INSERT INTO work_item_claim(item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at)
    VALUES ('item-legacy', 'run-legacy', 'occ-legacy', 'active', 1700086400000, 1700000000000, 1700000000000);`)
  raw.exec(`INSERT INTO work_item_schema_meta(key, value) VALUES ('schema_version', '${String(version)}');
    PRAGMA user_version = ${String(version)};`)
  raw.close()
  return { path, root }
}

/** Admit an item whose admission provenance is malformed for settlement. */
function malformedProvenance(): WorkItemProvenance {
  return {
    ...signal().provenance!,
    evidence: { inboxId: 'inbox-1', executionStatus: 'failed' },
  }
}

describe('work-item outcome ledger', () => {
  test('ready with a settleable admission appends one pending revision above the baseline', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    const outcomes = fixture.store.outcomes(item.id)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      revision: 1,
      settledBy: 'report-ready',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      trust: 'agent-self-report',
      evidenceState: 'pending',
      evidenceReason: null,
      evidence: null,
      baselineSequence: 4,
      inboxId: 'inbox-1',
      authorityHash: 'sha256:authority',
      deadlineAt: fixture.now() + SETTLE_WINDOW,
    })
    expect(fixture.store.pendingOutcomes(10)).toHaveLength(1)
    expect(fixture.store.stats()).toMatchObject({ outcomes: 1, pendingOutcomes: 1, unverifiedOutcomes: 0 })
  })

  test('ready without a settleable admission is not-applicable rather than pending', async () => {
    const fixture = await harness()
    const item = fixture.admission.admit(withoutProvenance(signal())).item
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      evidenceState: 'not-applicable',
      evidenceReason: 'no-independent-source',
      inboxId: null,
      baselineSequence: null,
      deadlineAt: null,
      objectiveStatus: 'unknown',
    })
    expect(fixture.store.pendingOutcomes(10)).toHaveLength(0)
  })

  test('a malformed settleable provenance falls back to not-applicable', async () => {
    const fixture = await harness()
    const item = await admitted(fixture, { provenance: malformedProvenance() })
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      evidenceState: 'not-applicable',
      evidenceReason: 'no-independent-source',
    })
  })

  test('blocked and failed reports settle immediately with no window', async () => {
    const fixture = await harness()
    const blocked = await admitted(fixture)
    claim(fixture, blocked.id)
    report(fixture, blocked.id, 'blocked')
    expect(fixture.store.latestOutcome(blocked.id)).toMatchObject({
      settledBy: 'report-blocked',
      objectiveStatus: 'not-achieved',
      evidenceState: 'not-applicable',
      deadlineAt: null,
    })

    const failed = await admitted(fixture)
    claim(fixture, failed.id)
    report(fixture, failed.id, 'failed')
    expect(fixture.store.latestOutcome(failed.id)).toMatchObject({
      settledBy: 'report-failed',
      executionStatus: 'failed',
      objectiveStatus: 'not-achieved',
    })
  })

  test('progress and waiting report revisions append no outcome', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id)
    report(fixture, item.id, 'progress')
    report(fixture, item.id, 'waiting')
    expect(fixture.store.outcomes(item.id)).toHaveLength(0)
    expect(fixture.store.outcomeView(item.id)).toBeUndefined()
  })

  test('retry exhaustion and withdrawal append their own terminal revisions', async () => {
    const exhausted = await harness()
    const limited = await admitted(exhausted, { provenance: malformedProvenance() })
    // Exhaust the attempt budget: claim, let the lease lapse, recover, repeat.
    let attempt = 1
    claim(exhausted, limited.id, `occ-attempt-${attempt}`)
    while (attempt < exhausted.config.limits.maxAttempts) {
      exhausted.advance(exhausted.config.limits.leaseMs + 1)
      exhausted.ledger.recover()
      attempt += 1
      claim(exhausted, limited.id, `occ-attempt-${attempt}`)
    }
    exhausted.advance(exhausted.config.limits.leaseMs + 1)
    exhausted.ledger.recover()
    expect(exhausted.store.outcomes(limited.id).map(outcome => outcome.settledBy)).toContain('retry-exhausted')
    expect(exhausted.store.latestOutcome(limited.id)).toMatchObject({
      executionStatus: 'unknown',
      objectiveStatus: 'not-achieved',
      evidenceState: 'not-applicable',
    })

    const withdrawn = await harness()
    const item = await admitted(withdrawn)
    withdrawn.store.withdrawByDedupKey(item.dedupKey)
    expect(withdrawn.store.latestOutcome(item.id)).toMatchObject({
      settledBy: 'withdrawn',
      executionStatus: 'cancelled',
      evidenceState: 'not-applicable',
    })
  })

  test('settleOutcome appends revision N+1 and only the latest revision is pending', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    const pending = fixture.store.latestOutcome(item.id) as WorkItemOutcomeRecord
    expect(fixture.store.settleOutcome({
      itemId: item.id,
      revision: pending.revision,
      evidence: { inboxId: 'inbox-1', completionSequence: 5 } as never,
      reason: null,
      degraded: false,
      expired: false,
    })).toMatchObject({ revision: 2, evidenceState: 'observed', trust: 'external-receipt', objectiveStatus: 'unknown', deadlineAt: null })
    expect(fixture.store.outcomes(item.id).map(outcome => outcome.revision)).toEqual([1, 2])
    expect(fixture.store.pendingOutcomes(10)).toHaveLength(0)
    expect(fixture.store.stats()).toMatchObject({ outcomes: 2, pendingOutcomes: 0 })
  })

  test('a stale revision or already-settled window is rejected without a new append', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    const pending = fixture.store.latestOutcome(item.id) as WorkItemOutcomeRecord
    fixture.store.settleOutcome({ itemId: item.id, revision: pending.revision, evidence: null, reason: 'window-expired', degraded: false, expired: true })
    expect(() => fixture.store.settleOutcome({
      itemId: item.id,
      revision: pending.revision,
      evidence: null,
      reason: 'window-expired',
      degraded: false,
      expired: true,
    })).toThrowError(/revision moved before settlement/)
    // Revision 1 is a historical record; settling it again must not rewrite it.
    expect(fixture.store.outcomes(item.id).map(outcome => outcome.revision)).toEqual([1, 2])
  })

  test('expiry records why the window closed and keeps the reported status', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    const pending = fixture.store.latestOutcome(item.id) as WorkItemOutcomeRecord
    fixture.advance(SETTLE_WINDOW + 1)
    fixture.store.settleOutcome({
      itemId: item.id,
      revision: pending.revision,
      evidence: null,
      reason: 'window-expired',
      degraded: false,
      expired: true,
    })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      revision: 2,
      settledBy: 'window-expired',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      evidenceState: 'unverified',
      evidenceReason: 'window-expired',
      deadlineAt: null,
    })
  })

  test('a replayed ready report appends exactly one outcome revision', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id)
    const first = report(fixture, item.id, 'ready')
    const replay = report(fixture, item.id, 'ready')
    expect(replay.report.revision).toBe(first.report.revision)
    expect(replay.replayed).toBe(true)
    expect(fixture.store.outcomes(item.id)).toHaveLength(1)
  })

  test('a corrupted stored evidence payload decodes as absent, not as a throw', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    const pending = fixture.store.latestOutcome(item.id) as WorkItemOutcomeRecord
    fixture.store.settleOutcome({
      itemId: item.id,
      revision: pending.revision,
      evidence: { inboxId: 'inbox-1', completionSequence: 5 } as never,
      reason: null,
      degraded: false,
      expired: false,
    })
    const raw = new DatabaseSync(fixture.config.databasePath)
    try {
      raw.prepare("UPDATE work_item_outcome SET evidence = 'not json' WHERE item_id = ?").run(item.id)
    } finally {
      raw.close()
    }
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'observed', evidence: null })
  })

  test('outcomeView attaches the last report revision only to report-backed outcomes', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    const view = fixture.store.outcomeView(item.id)
    expect(view?.outcome).toMatchObject({ revision: 1, settledBy: 'report-ready' })
    expect(view?.deliveryState).toBeNull()
    expect(view?.reportRevision).toBe(1)
  })

  test('an item with no outcome projects as undefined', async () => {
    const fixture = await harness()
    const item = await admitted(fixture)
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()
    expect(fixture.store.outcomeView(item.id)).toBeUndefined()
  })

  test('upgrades a literal version 2 database by adding the outcome ledger', () => {
    const { path, root } = legacyDatabase(2)
    const reopened = new WorkItemStore(path)
    try {
      expect(reopened.stats()).toMatchObject({ schemaVersion: 12, items: 1, outcomes: 0, pendingOutcomes: 0 })
      // The old item and its report survive untouched, claims keep their id.
      expect(reopened.findItemById('item-legacy')).toMatchObject({ state: 'blocked' })
      expect(reopened.reports('item-legacy')).toHaveLength(1)
      expect(reopened.findClaimByRun('run-legacy')).toMatchObject({ claimId: 1, runId: 'run-legacy' })
      // The new table is usable immediately, with no backfill rows.
      expect(reopened.outcomes('item-legacy')).toHaveLength(0)
      reopened.setMeta('probe', 'ok')
      expect(reopened.meta('probe')).toBe('ok')
    } finally {
      reopened.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

    test('upgrades a literal version 3 database by scoping dispatch rows to generation 0', () => {
    const { path, root } = legacyDatabase(3)
    const reopened = new WorkItemStore(path)
    try {
      expect(reopened.stats()).toMatchObject({ schemaVersion: 12, items: 1, dispatches: 1, outcomes: 0 })
      // The stored identity is preserved verbatim: generation 0 is the
      // admission event, so an in-flight wake stays valid across the upgrade.
      expect(reopened.getDispatch('item-legacy')).toMatchObject({
        eventId: 'item-legacy',
        occurredAt: 1_700_000_000_000,
        generation: 0,
        wakeAttempts: 0,
        state: 'dispatched',
        occurrenceId: 'occ-legacy',
      })
      expect(reopened.findItemById('item-legacy')).toMatchObject({ state: 'blocked' })
      reopened.setMeta('probe', 'ok')
      expect(reopened.meta('probe')).toBe('ok')
    } finally {
      reopened.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('upgrades a literal version 4 database by adding the Evaluation projection state', () => {
    const { path, root } = v4Database()
    const reopened = new WorkItemStore(path)
    try {
      expect(reopened.stats()).toMatchObject({ schemaVersion: 12, items: 1, outcomes: 1, evaluationPending: 1 })
      // Existing rows keep their ledger facts and default to an unexported state.
      expect(reopened.latestOutcome('item-legacy')).toMatchObject({
        revision: 2,
        evidenceState: 'observed',
        evaluationState: 'pending',
        evaluationDigest: null,
        evaluationRecordedAt: null,
        evaluationAttempts: 0,
      })
      // The V4 witness columns are untouched by the additive migration.
      expect(reopened.getDispatch('item-legacy')).toMatchObject({
        generation: 2,
        wakeAttempts: 1,
        state: 'dispatched',
      })
      // A legacy observed settlement is immediately exportable.
      expect(reopened.outcomesAwaitingEvaluation(10).map(outcome => outcome.revision)).toEqual([2])
      reopened.markOutcomeExported('item-legacy', 2, 'a'.repeat(64), 1_700_000_002_000)
      expect(reopened.stats()).toMatchObject({ evaluationPending: 0, evaluationExported: 1 })
    } finally {
      reopened.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('upgrades a literal version 1 database through the claim rebuild into v5', () => {
    const { path, root } = legacyDatabase(1)
    const reopened = new WorkItemStore(path)
    try {
      expect(reopened.stats()).toMatchObject({ schemaVersion: 12, items: 1, outcomes: 0 })
      expect(reopened.reports('item-legacy')).toHaveLength(1)
      // v1 had no surrogate key; the rebuild assigns a fresh claim_id.
      const claimRow = reopened.findClaimByRun('run-legacy')
      expect(claimRow).toMatchObject({ runId: 'run-legacy', state: 'active' })
      expect(claimRow?.claimId).toBeGreaterThan(0)
    } finally {
      reopened.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
