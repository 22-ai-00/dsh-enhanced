import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  deriveReportOutcome,
  deriveRetryExhaustedOutcome,
  deriveWithdrawalOutcome,
  expiredOutcome,
  observedOutcome,
  threadClosureOutcome,
  type WorkItemDeferredReportStatus,
  type WorkItemOutcomeDraft,
} from './outcome.ts'
import { truncateUtf8 } from './config.ts'
import type {
  WorkItemClaimRecord,
  WorkItemClaimState,
  WorkItemDeliveryState,
  WorkItemDispatchRecord,
  WorkItemDispatchState,
  WorkItemEventRecord,
  WorkItemEvaluationState,
  WorkItemFollowRecord,
  WorkItemFollowState,
  WorkItemExecutionStatus,
  WorkItemObjectiveStatus,
  WorkItemOutcomeEvidence,
  WorkItemOutcomeEvidenceReason,
  WorkItemOutcomeEvidenceState,
  WorkItemOutcomeRecord,
  WorkItemOutcomeSettledBy,
  WorkItemOutcomeTrust,
  WorkItemOutcomeView,
  WorkItemOwnerEvidence,
  WorkItemProvenance,
  WorkItemAuthorityBasis,
  WorkItemRecord,
  WorkItemReportRecord,
  WorkItemReportStatus,
  WorkItemResumeAttempt,
  WorkItemResumeContext,
  WorkItemResumeOutcome,
  WorkItemResumeReport,
  WorkItemScope,
  WorkItemState,
  WorkItemThreadClosure,
  WorkItemThreadOutcome,
} from './types.ts'
import { CLAIMABLE_STATES, OPEN_STATES, TERMINAL_REPORT_STATUSES, WorkItemError } from './types.ts'

const SCHEMA_VERSION = 8
const WORK_ITEM_TABLE_NAMES = ['work_item', 'work_item_claim', 'work_item_dispatch', 'work_item_event', 'work_item_follow', 'work_item_outcome', 'work_item_report', 'work_item_schema_meta']
const WAITING_RESUME_CURSOR = 'scheduler.waiting-resume.cursor'
const WAITING_RESUME_DUE_INDEX = `CREATE INDEX work_item_dispatch_waiting_due_idx
  ON work_item_dispatch(occurred_at, item_id) WHERE state = 'pending' AND reason = 'waiting-resume'`
const ACTIVE_CLAIM_ITEM_INDEX = `CREATE INDEX work_item_claim_active_item_idx
  ON work_item_claim(item_id) WHERE state = 'active'`
/** Waiting reasons that mean an admission mandate failed revalidation. */
const AUTHORITY_REVOKED = 'authority-revoked'
const AUTHORITY_UNAVAILABLE = 'authority-unavailable'
/** Ambiguous wake failures one generation may retry before the gap stays visible. */
const MAX_UNKNOWN_WAKE_ATTEMPTS = 1
/** Default bounded settlement window: seven days. */
const DEFAULT_SETTLE_WINDOW_MS = 604_800_000
/** Newest prior attempts one resume brief may carry. */
const RESUME_ATTEMPT_LIMIT = 5
/** Newest prior report summaries one resume brief may carry. */
const RESUME_REPORT_LIMIT = 5
/** UTF-8 byte budget for one resume report summary. */
const RESUME_SUMMARY_BYTES = 512
/** Hard row bound for the resume event scan; the newest events win. */
const RESUME_EVENT_SCAN_LIMIT = 500
const MEMORY_DATABASE = ':memory:'
/** Bound parameters for `state IN (...)`, derived from the single state list. */
const OPEN_STATE_PLACEHOLDERS = OPEN_STATES.map(() => '?').join(', ')

/**
 * Append-only outcome ledger.
 *
 * One row per outcome revision; a later observation of the same item appends a
 * wider revision instead of rewriting the earlier one, so a `ready` history is
 * never laundered into a success. The primary key already orders by item and
 * revision, so the only extra indexes support finding pending windows by
 * deadline and replaying outcomes that still owe one trusted Evaluation append.
 */
const OUTCOME_SCHEMA = `CREATE TABLE work_item_outcome (
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL,
        settled_by TEXT NOT NULL CHECK(settled_by IN ('report-ready', 'report-blocked', 'report-failed', 'withdrawn', 'retry-exhausted', 'observed-evidence', 'window-expired', 'closed-by-thread')),
        execution_status TEXT NOT NULL CHECK(execution_status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'unknown')),
        objective_status TEXT NOT NULL CHECK(objective_status IN ('achieved', 'partial', 'not-achieved', 'unknown')),
        trust TEXT NOT NULL CHECK(trust IN ('agent-self-report', 'external-receipt', 'deterministic-check')),
        evidence_state TEXT NOT NULL CHECK(evidence_state IN ('pending', 'observed', 'unverified', 'not-applicable')),
        evidence_reason TEXT CHECK(evidence_reason IN ('no-independent-source', 'evidence-too-large', 'window-expired', 'channel-unavailable', 'closed-by-thread')),
        evidence TEXT, baseline_sequence INTEGER, inbox_id TEXT, authority_hash TEXT, deadline_at INTEGER,
        settled_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
        evaluation_state TEXT NOT NULL DEFAULT 'pending' CHECK(evaluation_state IN ('pending', 'exported', 'skipped')),
        evaluation_digest TEXT, evaluation_recorded_at INTEGER,
        evaluation_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(item_id, revision)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX work_item_outcome_pending_idx ON work_item_outcome(evidence_state, deadline_at);
      CREATE INDEX work_item_outcome_evaluation_idx ON work_item_outcome(evaluation_state, evidence_state);
    `

/**
 * Frozen v3 shape of the outcome ledger. The v3 upgrade block must keep creating
 * exactly this table because later version blocks add their own columns; reusing
 * the current definition there would duplicate those columns on a v1/v2 upgrade.
 */
const OUTCOME_SCHEMA_V3 = `CREATE TABLE work_item_outcome (
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
    `

/**
 * Followed external threads whose closure bounds an item's settlement wait.
 *
 * A row is not authority: it records which host-registered source observed
 * which thread, at which registration generation. The table is append-only in
 * practice (`open` -> `closed` once, CAS-guarded), so a duplicate or
 * out-of-order closure can never reopen or double-settle an item.
 */
const FOLLOW_SCHEMA = `CREATE TABLE work_item_follow (
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('open', 'closed')),
        outcome TEXT CHECK(outcome IN ('succeeded', 'failed', 'cancelled', 'unknown')),
        digest TEXT,
        source TEXT NOT NULL,
        source_generation TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        CHECK((state = 'open' AND outcome IS NULL AND digest IS NULL AND closed_at IS NULL)
          OR (state = 'closed' AND outcome IS NOT NULL AND digest IS NOT NULL AND closed_at IS NOT NULL)),
        PRIMARY KEY(item_id, position)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX work_item_follow_state_idx ON work_item_follow(state, source);
    `

type Row = Record<string, unknown>

/** Every durable item column, in insert order. */
const ITEM_COLUMNS = [
  'id', 'dedup_key', 'dedup_bucket', 'source_id', 'kind', 'external_id', 'title', 'brief', 'brief_truncated',
  'origin_binding_id', 'acceptance_ref', 'workspace', 'agent_preset', 'principal_id', 'principal_record_id',
  'principal_version', 'binding_version', 'owner_generation', 'owner_route_id', 'scope_expires_at', 'worker_automation_id',
  'state', 'state_reason', 'attempt', 'max_attempts', 'lease_until', 'lease_run_id', 'occurrence_id', 'work_dir',
  'last_report_status', 'observed', 'created_at', 'updated_at',
  'authority_basis', 'authority_checked_at',
] as const

/** Same columns projected with camelCase aliases for row decoding. */
const ITEM_ALIASES = ITEM_COLUMNS.map(column => {
  const name = column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
  return name === column ? column : `${column} AS ${name}`
}).join(', ')

const INSERT_ITEM = `INSERT INTO work_item(${ITEM_COLUMNS.join(', ')}) VALUES (${ITEM_COLUMNS.map(() => '?').join(', ')})`

const REPORTABLE_STATES: readonly WorkItemState[] = ['claimed', 'working', 'waiting']

/** Deferred terminal report statuses, the only ones a follow can defer. */
const DEFERRED_REPORT_STATUSES: readonly WorkItemDeferredReportStatus[] = ['ready', 'blocked', 'failed']

/** One validated follow, already resolved to its registered source at admission. */
export interface WorkItemFollowInput {
  readonly kind: string
  readonly ref: string
  /** Registered source key; equals `kind` and is persisted for audit. */
  readonly source: string
  /** Registration generation at admission; a newer one cannot close this row. */
  readonly sourceGeneration: string
}

/**
 * Deterministic external event identity for one dispatch generation.
 *
 * Generation 0 is the admission identity and equals the item id, so existing
 * rows keep their exact `(event_id, occurred_at)` pair. Later generations append
 * a suffix, because the automation intake dedupes occurrences by
 * `(automationId, eventId, occurredAt)` and would replay a completed occurrence
 * instead of starting a new run.
 */
export function dispatchEventId(itemId: string, generation: number): string {
  return generation === 0 ? itemId : `${itemId}#${String(generation)}`
}

function fail(code: ConstructorParameters<typeof WorkItemError>[0], message: string, detail?: string): never {
  throw new WorkItemError(code, message, detail)
}

function privateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
    fail('storage', 'work-item database file is not private')
  }
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
    fail('storage', 'work-item database directory is not private')
  }
}

/** Create a mode-0700 directory and prove it is not a link or group-writable. */
export function preparePrivateDirectory(path: string): void {
  if (!isAbsolute(path)) fail('storage', 'private directory path must be absolute')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  privateDirectory(path)
  chmodSync(path, 0o700)
}

/** Create the SQLite file with mode 0600 before SQLite opens it. */
export function prepareDatabaseFile(path: string): void {
  if (!isAbsolute(path)) fail('storage', 'database path must be absolute')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  privateDirectory(dirname(path))
  let present = false
  try {
    lstatSync(path)
    present = true
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') fail('storage', 'database path is unsafe')
  }
  if (!present) {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    closeSync(descriptor)
    chmodSync(path, 0o600)
  }
  privateFile(path)
  for (const suffix of ['-wal', '-shm']) {
    try {
      privateFile(`${path}${suffix}`)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
  }
}

function validateSchema(database: DatabaseSync): void {
  const version = (database.prepare('PRAGMA user_version').get() as Row)['user_version'] as number
  const objects = database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").all() as Row[]
  // Reject unowned objects before migrations can fire a trigger or update a
  // foreign schema. `_` is literal here: sqliteXshadow is an application name.
  if (version !== 0 && objects.some(row => String(row['type']) !== 'index'
    && (String(row['type']) !== 'table' || !WORK_ITEM_TABLE_NAMES.includes(String(row['name']))))) {
    fail('storage', 'work-item database contains an unexpected schema object')
  }
  if (version === 0) {
    if (objects.length !== 0) fail('storage', 'new work-item database is not empty')
    database.exec(`
      BEGIN IMMEDIATE;
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
        authority_basis TEXT, authority_checked_at INTEGER,
        UNIQUE(dedup_key, dedup_bucket)
      ) STRICT;
      CREATE TABLE work_item_event (
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
        detail TEXT, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(item_id, sequence)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE work_item_claim (
        claim_id INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
        leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX work_item_claim_run_idx ON work_item_claim(run_id);
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
      ${OUTCOME_SCHEMA}
      CREATE TABLE work_item_dispatch (
        item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE RESTRICT,
        automation_id TEXT NOT NULL, event_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        wake_attempts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('pending', 'dispatched', 'failed')),
        occurrence_id TEXT, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(automation_id, event_id)
      ) STRICT;
      ${FOLLOW_SCHEMA}
      ${WAITING_RESUME_DUE_INDEX};
      ${ACTIVE_CLAIM_ITEM_INDEX};
      CREATE TABLE work_item_schema_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      INSERT INTO work_item_schema_meta(key, value) VALUES ('schema_version', '8');
      PRAGMA user_version = 8;
      COMMIT;
    `)
    return
  }
  if (version === 1) {
    // A run may legitimately reclaim an expired lease, which needs a fresh claim
    // row for the same run. Rebuild the claim table without the (item, run) key
    // and add a surrogate `claim_id`; every existing row maps to a new id.
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE work_item_claim RENAME TO work_item_claim_v1;
      CREATE TABLE work_item_claim (
        claim_id INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
        leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO work_item_claim(item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at)
        SELECT item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at FROM work_item_claim_v1;
      DROP TABLE work_item_claim_v1;
      CREATE INDEX work_item_claim_run_idx ON work_item_claim(run_id);
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }
  if (version === 1 || version === 2) {
    // v3 adds the append-only outcome ledger. No existing table changes, so the
    // upgrade is a pure table creation that keeps every stored report intact.
    database.exec(`
      BEGIN IMMEDIATE;
      ${OUTCOME_SCHEMA_V3}
      UPDATE work_item_schema_meta SET value = '3' WHERE key = 'schema_version';
      PRAGMA user_version = 3;
      COMMIT;
    `)
  }
  if (version === 1 || version === 2 || version === 3) {
    // v4 scopes a dispatch row to one delivery generation. Existing rows are
    // generation 0, whose identity is exactly the stored `event_id` /
    // `occurred_at`; no value is rewritten, so an in-flight wake stays valid.
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE work_item_dispatch ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE work_item_dispatch ADD COLUMN wake_attempts INTEGER NOT NULL DEFAULT 0;
      UPDATE work_item_schema_meta SET value = '4' WHERE key = 'schema_version';
      PRAGMA user_version = 4;
      COMMIT;
    `)
  }
  if (version === 1 || version === 2 || version === 3 || version === 4) {
    // v5 records the trusted Evaluation export state per settled outcome. Legacy
    // rows default to `pending`, so an upgraded database replays exactly the
    // settlements that have not reached Evaluation yet; no existing column is
    // rewritten and no prior revision is dropped.
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE work_item_outcome ADD COLUMN evaluation_state TEXT NOT NULL DEFAULT 'pending' CHECK(evaluation_state IN ('pending', 'exported', 'skipped'));
      ALTER TABLE work_item_outcome ADD COLUMN evaluation_digest TEXT;
      ALTER TABLE work_item_outcome ADD COLUMN evaluation_recorded_at INTEGER;
      ALTER TABLE work_item_outcome ADD COLUMN evaluation_attempts INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX work_item_outcome_evaluation_idx ON work_item_outcome(evaluation_state, evidence_state);
      UPDATE work_item_schema_meta SET value = '5' WHERE key = 'schema_version';
      PRAGMA user_version = 5;
      COMMIT;
    `)
  }
  if (version === 1 || version === 2 || version === 3 || version === 4 || version === 5) {
    // v6 adds followed-thread settlement. Two of its enum values land on the
    // append-only outcome ledger, and SQLite cannot alter a CHECK, so the ledger
    // is rebuilt: RENAME, create the widened shape, copy every row column for
    // column, drop the old table, recreate both indexes. No row is dropped and
    // no stored value changes; only the two CHECK lists gain `closed-by-thread`.
    // The follow table itself is a pure additive creation.
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE work_item_outcome RENAME TO work_item_outcome_v5;
      DROP INDEX work_item_outcome_pending_idx;
      DROP INDEX work_item_outcome_evaluation_idx;
      ${OUTCOME_SCHEMA}
      INSERT INTO work_item_outcome(item_id, revision, settled_by, execution_status, objective_status, trust, evidence_state, evidence_reason, evidence, baseline_sequence, inbox_id, authority_hash, deadline_at, settled_at, recorded_at, evaluation_state, evaluation_digest, evaluation_recorded_at, evaluation_attempts)
        SELECT item_id, revision, settled_by, execution_status, objective_status, trust, evidence_state, evidence_reason, evidence, baseline_sequence, inbox_id, authority_hash, deadline_at, settled_at, recorded_at, evaluation_state, evaluation_digest, evaluation_recorded_at, evaluation_attempts FROM work_item_outcome_v5;
      DROP TABLE work_item_outcome_v5;
      ${FOLLOW_SCHEMA}
      UPDATE work_item_schema_meta SET value = '6' WHERE key = 'schema_version';
      PRAGMA user_version = 6;
      COMMIT;
    `)
  }
  if (version >= 1 && version <= 6) {
    // v7 persists the audit-only admission mandate so claim and wake can replay
    // the identical policy decision. Both columns are nullable and additive:
    // pre-v7 rows stay `NULL` and are reported as legacy, never re-authorized
    // from the current configuration.
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE work_item ADD COLUMN authority_basis TEXT;
      ALTER TABLE work_item ADD COLUMN authority_checked_at INTEGER;
      UPDATE work_item_schema_meta SET value = '7' WHERE key = 'schema_version';
      PRAGMA user_version = 7;
      COMMIT;
    `)
  }
  if (version >= 1 && version <= 7) {
    // Add only bounded scheduler lookup indexes. No stored task, report,
    // occurrence, attempt, authority or budget value is rewritten.
    database.exec(`BEGIN IMMEDIATE;
      ${WAITING_RESUME_DUE_INDEX};
      ${ACTIVE_CLAIM_ITEM_INDEX};
      UPDATE work_item_schema_meta SET value = '8' WHERE key = 'schema_version';
      PRAGMA user_version = 8;
      COMMIT;`)
  }
  if (!Number.isSafeInteger(version) || version < 1 || version > SCHEMA_VERSION) fail('storage', `unsupported work-item schema version ${String(version)}`)
  const expected = JSON.stringify(WORK_ITEM_TABLE_NAMES)
  const tables = (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as Row[]).map(row => String(row['name']))
  if (JSON.stringify(tables) !== expected) fail('storage', 'work-item database schema is not the expected shape')
  for (const [name, sql] of [['work_item_dispatch_waiting_due_idx', WAITING_RESUME_DUE_INDEX], ['work_item_claim_active_item_idx', ACTIVE_CLAIM_ITEM_INDEX]]) {
    const row = database.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get('index', name!) as Row | undefined
    if (typeof row?.['sql'] !== 'string' || row['sql'].replace(/\s+/gu, ' ').trim() !== sql!.replace(/\s+/gu, ' ').trim()) {
      fail('storage', 'work-item scheduler indexes do not match the expected shape')
    }
  }
}

function optString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function optNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** Positive safe integer or `null`; malformed detail never throws. */
function optCount(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Decode one event detail object; absent or malformed JSON yields `null`. */
function eventDetail(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null
  try {
    const parsed = JSON.parse(String(value)) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Decode the persisted advisory basis.
 *
 * Unreadable JSON is returned as a structurally unusable sentinel rather than
 * `null`: `null` means a legitimate pre-v7 row that must keep its legacy
 * behaviour, while a malformed stored basis must be revalidated as revoked.
 */
function authorityBasisFromRow(value: unknown): WorkItemAuthorityBasis | null {
  if (value === null || value === undefined) return null
  try {
    const parsed = JSON.parse(String(value)) as unknown
    if (parsed === null || typeof parsed !== 'object') return {} as WorkItemAuthorityBasis
    return Object.freeze(parsed as WorkItemAuthorityBasis)
  } catch {
    return {} as WorkItemAuthorityBasis
  }
}

function itemFromRow(row: Row): WorkItemRecord {
  const scope: WorkItemScope = Object.freeze({
    workspace: String(row['workspace']),
    preset: String(row['agentPreset']),
    principalId: String(row['principalId']),
    ownerRouteId: String(row['ownerRouteId']),
    expiresAt: Number(row['scopeExpiresAt']),
  })
  const owner: WorkItemOwnerEvidence = Object.freeze({
    principalRecordId: String(row['principalRecordId']),
    principalVersion: Number(row['principalVersion']),
    workspace: String(row['workspace']),
    agentPreset: String(row['agentPreset']),
    bindingVersion: Number(row['bindingVersion']),
    generation: Number(row['ownerGeneration']),
  })
  return Object.freeze({
    id: String(row['id']),
    dedupKey: String(row['dedupKey']),
    dedupBucket: Number(row['dedupBucket']),
    sourceId: String(row['sourceId']),
    kind: String(row['kind']),
    externalId: String(row['externalId']),
    title: String(row['title']),
    brief: String(row['brief']),
    briefTruncated: Number(row['briefTruncated']) === 1,
    originBindingId: String(row['originBindingId']),
    acceptanceRef: optString(row['acceptanceRef']),
    scope,
    owner,
    workerAutomationId: String(row['workerAutomationId']),
    authority: authorityBasisFromRow(row['authorityBasis']),
    state: String(row['state']) as WorkItemState,
    stateReason: optString(row['stateReason']),
    attempt: Number(row['attempt']),
    maxAttempts: Number(row['maxAttempts']),
    leaseUntil: optNumber(row['leaseUntil']),
    leaseRunId: optString(row['leaseRunId']),
    occurrenceId: optString(row['occurrenceId']),
    workDir: String(row['workDir']),
    lastReportStatus: optString(row['lastReportStatus']) as WorkItemReportStatus | null,
    observed: Number(row['observed']) === 1,
    createdAt: Number(row['createdAt']),
    updatedAt: Number(row['updatedAt']),
  })
}

function claimFromRow(row: Row): WorkItemClaimRecord {
  return Object.freeze({
    claimId: Number(row['claim_id']),
    itemId: String(row['item_id']),
    runId: String(row['run_id']),
    occurrenceId: String(row['occurrence_id']),
    state: String(row['state']) as WorkItemClaimState,
    leasedUntil: Number(row['leased_until']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  })
}

function reportFromRow(row: Row): WorkItemReportRecord {
  return Object.freeze({
    itemId: String(row['item_id']),
    revision: Number(row['revision']),
    status: String(row['status']) as WorkItemReportStatus,
    summary: String(row['summary']),
    truncated: Number(row['truncated']) === 1,
    artifactPaths: Object.freeze(JSON.parse(String(row['artifact_paths'])) as string[]),
    idempotencyKey: String(row['idempotency_key']),
    deliveryKey: String(row['delivery_key']),
    deliveryState: optString(row['delivery_state']) as WorkItemDeliveryState | null,
    deliveryId: optString(row['delivery_id']),
    recordedAt: Number(row['recorded_at']),
  })
}

function dispatchFromRow(row: Row): WorkItemDispatchRecord {
  return Object.freeze({
    itemId: String(row['item_id']),
    automationId: String(row['automation_id']),
    eventId: String(row['event_id']),
    occurredAt: Number(row['occurred_at']),
    generation: Number(row['generation'] ?? 0),
    wakeAttempts: Number(row['wake_attempts'] ?? 0),
    state: String(row['state']) as WorkItemDispatchState,
    occurrenceId: optString(row['occurrence_id']),
    reason: optString(row['reason']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  })
}

/** Decode stored evidence; malformed JSON fails closed to `null`. */
function parseEvidence(stored: string): WorkItemOutcomeEvidence | null {
  try {
    return Object.freeze(JSON.parse(stored) as WorkItemOutcomeEvidence)
  } catch {
    return null
  }
}

function outcomeFromRow(row: Row): WorkItemOutcomeRecord {
  const evidence = optString(row['evidence'])
  return Object.freeze({
    itemId: String(row['item_id']),
    revision: Number(row['revision']),
    settledBy: String(row['settled_by']) as WorkItemOutcomeSettledBy,
    executionStatus: String(row['execution_status']) as WorkItemExecutionStatus,
    objectiveStatus: String(row['objective_status']) as WorkItemObjectiveStatus,
    trust: String(row['trust']) as WorkItemOutcomeTrust,
    evidenceState: String(row['evidence_state']) as WorkItemOutcomeEvidenceState,
    evidenceReason: optString(row['evidence_reason']) as WorkItemOutcomeEvidenceReason | null,
    // Malformed stored evidence is treated as absent rather than thrown: an
    // unreadable receipt can never prove successful repair.
    evidence: evidence === null ? null : parseEvidence(evidence),
    baselineSequence: optNumber(row['baseline_sequence']),
    inboxId: optString(row['inbox_id']),
    authorityHash: optString(row['authority_hash']),
    deadlineAt: optNumber(row['deadline_at']),
    settledAt: Number(row['settled_at']),
    recordedAt: Number(row['recorded_at']),
    evaluationState: String(row['evaluation_state'] ?? 'pending') as WorkItemEvaluationState,
    evaluationDigest: optString(row['evaluation_digest']),
    evaluationRecordedAt: optNumber(row['evaluation_recorded_at']),
    evaluationAttempts: Number(row['evaluation_attempts'] ?? 0),
  })
}

/** Latest outcome revision per item; older revisions stay as immutable history. */
function followFromRow(row: Row): WorkItemFollowRecord {
  return Object.freeze({
    itemId: String(row['item_id']),
    position: Number(row['position']),
    kind: String(row['kind']),
    ref: String(row['ref']),
    state: String(row['state']) as WorkItemFollowState,
    outcome: optString(row['outcome']) as WorkItemThreadOutcome | null,
    digest: optString(row['digest']),
    source: String(row['source']),
    sourceGeneration: String(row['source_generation']),
    openedAt: Number(row['opened_at']),
    closedAt: optNumber(row['closed_at']),
  })
}

const LATEST_OUTCOME = 'SELECT item_id, MAX(revision) AS revision FROM work_item_outcome GROUP BY item_id'

export interface ClaimResult {
  readonly item: WorkItemRecord
  readonly claim: WorkItemClaimRecord
  readonly replayed: boolean
}

export interface ReportResult {
  readonly item: WorkItemRecord
  readonly report: WorkItemReportRecord
  readonly replayed: boolean
}

export interface ReclaimResult {
  readonly requeued: readonly string[]
  readonly blocked: readonly string[]
}

/** Which signal drove a withdrawal; recorded on every retired item's event. */
export interface WithdrawAttribution {
  readonly sourceId: string
  readonly externalId: string
  readonly observedAt: number
}

/** Result of retiring every open item of one canonical dedup key. */
export interface WithdrawDedupResult {
  readonly outcome: 'withdrawn' | 'settled' | 'absent'
  /** Items actually retired (`withdrawn`), the newest item (`settled`), or none. */
  readonly items: readonly WorkItemRecord[]
}

export interface WorkItemStoreStats {
  readonly schemaVersion: number
  readonly items: number
  readonly openItems: number
  readonly reports: number
  readonly dispatches: number
  readonly outcomes: number
  readonly pendingOutcomes: number
  readonly unverifiedOutcomes: number
  /** Latest settled revisions still waiting for one trusted Evaluation append. */
  readonly evaluationPending: number
  readonly evaluationExported: number
  readonly evaluationSkipped: number
  /** Persisted followed-thread rows (open and closed). */
  readonly follows: number
  /** Open items admitted before the revalidation basis existed (schema < v7). */
  readonly authorityLegacy: number
  /** Open items parked because their admission mandate failed revalidation. */
  readonly authorityParked: number
}

/**
 * Durable execution facts one work item can contribute to an Evaluation claim.
 *
 * Only counts the ledger already records are exposed. No provider token/cost
 * usage is read here: this ledger owns no run-usage contract, while the
 * automation side records those figures for the same run scope, so copying them
 * would double-count cost. Zero counts are omitted so a quiet item stays compact.
 */
export interface WorkItemExecutionMetrics {
  readonly latencyMs: number
  readonly retries?: number
  readonly claims?: number
  readonly reports?: number
  readonly waitingReports?: number
  readonly unknownDispatches?: number
  readonly claimExpiries?: number
}

/**
 * Single-writer SQLite ledger.
 *
 * Every mutation runs inside `BEGIN IMMEDIATE`; the database file is created
 * 0600 next to a 0700 directory, WAL keeps readers unblocked, and schema
 * upgrades are bounded to the single-writer upgrade boundary at open time.
 */
export class WorkItemStore {
  readonly #database: DatabaseSync
  readonly #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  readonly #now: () => number
  readonly #settleWindowMs: number
  #closed = false

  constructor(path: string, options: { now?: () => number; settleWindowMs?: number } = {}) {
    this.#now = options.now ?? (() => Date.now())
    const settleWindowMs = options.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS
    if (!Number.isSafeInteger(settleWindowMs) || settleWindowMs <= 0) fail('invalid-input', 'settleWindowMs must be a positive integer')
    this.#settleWindowMs = settleWindowMs
    if (path !== MEMORY_DATABASE) prepareDatabaseFile(path)
    this.#database = new DatabaseSync(path)
    if (path !== MEMORY_DATABASE) {
      this.#database.exec('PRAGMA journal_mode = WAL;')
      this.#database.exec('PRAGMA synchronous = FULL;')
    }
    this.#database.exec('PRAGMA foreign_keys = ON;')
    this.#database.exec('PRAGMA busy_timeout = 5000;')
    try {
      validateSchema(this.#database)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  #statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    const cached = this.#statements.get(sql)
    if (cached !== undefined) return cached
    const statement = this.#database.prepare(sql)
    this.#statements.set(sql, statement)
    return statement
  }

  #transaction<T>(work: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Keep the original failure; a broken transaction is surfaced via health.
      }
      throw error
    }
  }

  #appendEvent(itemId: string, kind: string, actor: string, detail: unknown, now: number): void {
    const next = this.#statement('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM work_item_event WHERE item_id = ?').get(itemId) as Row
    this.#statement('INSERT INTO work_item_event(item_id, sequence, kind, actor, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(itemId, Number(next['next']), kind, actor, detail === undefined ? null : JSON.stringify(detail), now)
  }

  #requireItem(itemId: string): WorkItemRecord {
    const item = this.findItemById(itemId)
    if (item === undefined) fail('not-found', 'work item does not exist')
    return item
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#statements.clear()
    this.#database.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  stats(): WorkItemStoreStats {
    const count = (sql: string): number => Number((this.#statement(sql).get() as Row)['count'])
    const evaluations = this.countEvaluations()
    return Object.freeze({
      schemaVersion: Number((this.#database.prepare('PRAGMA user_version').get() as Row)['user_version']),
      items: count('SELECT COUNT(*) AS count FROM work_item'),
      openItems: count(`SELECT COUNT(*) AS count FROM work_item WHERE observed = 0 AND state IN ('queued', 'claimed', 'working', 'waiting')`),
      reports: count('SELECT COUNT(*) AS count FROM work_item_report'),
      dispatches: count('SELECT COUNT(*) AS count FROM work_item_dispatch'),
      outcomes: count('SELECT COUNT(*) AS count FROM work_item_outcome'),
      pendingOutcomes: count(`SELECT COUNT(*) AS count FROM work_item_outcome o JOIN (${LATEST_OUTCOME}) latest ON latest.item_id = o.item_id AND latest.revision = o.revision WHERE o.evidence_state = 'pending'`),
      unverifiedOutcomes: count(`SELECT COUNT(*) AS count FROM work_item_outcome o JOIN (${LATEST_OUTCOME}) latest ON latest.item_id = o.item_id AND latest.revision = o.revision WHERE o.evidence_state = 'unverified'`),
      evaluationPending: evaluations.pending,
      evaluationExported: evaluations.exported,
      evaluationSkipped: evaluations.skipped,
      follows: count('SELECT COUNT(*) AS count FROM work_item_follow'),
      authorityLegacy: this.countAuthorityLegacy(),
      authorityParked: this.countAuthorityParked(),
    })
  }

  findItemById(itemId: string): WorkItemRecord | undefined {
    const row = this.#statement(`SELECT ${ITEM_ALIASES} FROM work_item WHERE id = ?`).get(itemId) as Row | undefined
    return row === undefined ? undefined : itemFromRow(row)
  }

  findItemByDedup(dedupKey: string, dedupBucket: number): WorkItemRecord | undefined {
    const row = this.#statement(`SELECT ${ITEM_ALIASES} FROM work_item WHERE dedup_key = ? AND dedup_bucket = ?`).get(dedupKey, dedupBucket) as Row | undefined
    return row === undefined ? undefined : itemFromRow(row)
  }

  /**
   * Latest item admitted for one canonical dedup key, across all windows.
   *
   * The dedup window forgets history when a bucket rolls over; this lookup is
   * what lets a correction or withdrawal of an already-settled signal stay
   * settled instead of reviving a completed item.
   */
  findLatestItemByDedupKey(dedupKey: string): WorkItemRecord | undefined {
    const row = this.#statement(`SELECT ${ITEM_ALIASES} FROM work_item WHERE dedup_key = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(dedupKey) as Row | undefined
    return row === undefined ? undefined : itemFromRow(row)
  }

  /** Read one durable key/value row from the schema-meta table. */
  meta(key: string): string | null {
    const row = this.#statement('SELECT value FROM work_item_schema_meta WHERE key = ?').get(key) as Row | undefined
    return row === undefined ? null : String(row['value'])
  }

  /** Persist one durable key/value row; no schema change is required for it. */
  setMeta(key: string, value: string): void {
    this.#statement(
      'INSERT INTO work_item_schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  /** Drop one durable key/value row when its cursor no longer applies. */
  deleteMeta(key: string): void {
    this.#statement('DELETE FROM work_item_schema_meta WHERE key = ?').run(key)
  }

  /** Count latest outcome revisions in one evidence state. */
  countLatestOutcomes(evidenceState: WorkItemOutcomeEvidenceState): number {
    const row = this.#statement(`
      SELECT COUNT(*) AS count FROM work_item_outcome o
      JOIN (${LATEST_OUTCOME}) latest ON latest.item_id = o.item_id AND latest.revision = o.revision
      WHERE o.evidence_state = ?
    `).get(evidenceState) as Row
    return Number(row['count'])
  }

  findItemByOccurrence(occurrenceId: string): WorkItemRecord | undefined {
    const row = this.#statement(`SELECT ${ITEM_ALIASES} FROM work_item WHERE occurrence_id = ?`).get(occurrenceId) as Row | undefined
    if (row !== undefined) return itemFromRow(row)
    const dispatch = this.#statement('SELECT item_id FROM work_item_dispatch WHERE occurrence_id = ?').get(occurrenceId) as Row | undefined
    return dispatch === undefined ? undefined : this.findItemById(String(dispatch['item_id']))
  }

  listItems(options: { states?: readonly WorkItemState[]; includeObserved?: boolean; limit?: number } = {}): readonly WorkItemRecord[] {
    const limit = options.limit ?? 50
    const states = options.states
    const includeObserved = options.includeObserved ?? false
    let sql = `SELECT ${ITEM_ALIASES} FROM work_item`
    const conditions: string[] = []
    const parameters: Array<string | number> = []
    if (states !== undefined && states.length > 0) {
      conditions.push(`state IN (${states.map(() => '?').join(', ')})`)
      parameters.push(...states)
    }
    if (!includeObserved) conditions.push('observed = 0')
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'
    parameters.push(limit)
    return Object.freeze((this.#statement(sql).all(...parameters) as Row[]).map(itemFromRow))
  }

  lastAdmitAt(kind?: string): number | null {
    const row = kind === undefined
      ? this.#statement('SELECT MAX(created_at) AS latest FROM work_item').get() as Row
      : this.#statement('SELECT MAX(created_at) AS latest FROM work_item WHERE kind = ?').get(kind) as Row
    return optNumber(row['latest'])
  }

  /** Latest successful dispatch timestamp, for bounded health reporting. */
  lastDispatchedAt(): number | null {
    const row = this.#statement(
      "SELECT MAX(updated_at) AS latest FROM work_item_dispatch WHERE state = 'dispatched'",
    ).get() as Row
    return optNumber(row['latest'])
  }

  countItemsSince(createdAt: number): number {
    const row = this.#statement('SELECT COUNT(*) AS count FROM work_item WHERE created_at >= ? AND observed = 0').get(createdAt) as Row
    return Number(row['count'])
  }

  countOpenItems(): number {
    const row = this.#statement(`SELECT COUNT(*) AS count FROM work_item WHERE observed = 0 AND state IN ('queued', 'claimed', 'working', 'waiting')`).get() as Row
    return Number(row['count'])
  }

  /** Open items admitted before schema v7, i.e. with no persisted mandate. */
  countAuthorityLegacy(): number {
    const row = this.#statement(`
      SELECT COUNT(*) AS count FROM work_item
      WHERE observed = 0 AND state IN (${OPEN_STATE_PLACEHOLDERS}) AND authority_basis IS NULL
    `).get(...OPEN_STATES) as Row
    return Number(row['count'])
  }

  /** Open items parked because their admission mandate failed revalidation. */
  countAuthorityParked(): number {
    const row = this.#statement(`
      SELECT COUNT(*) AS count FROM work_item
      WHERE observed = 0 AND state = 'waiting' AND state_reason IN ('${AUTHORITY_REVOKED}', '${AUTHORITY_UNAVAILABLE}')
    `).get() as Row
    return Number(row['count'])
  }

  /** Follows of one item, in admission order (their stable position). */
  follows(itemId: string): readonly WorkItemFollowRecord[] {
    return Object.freeze((this.#statement('SELECT * FROM work_item_follow WHERE item_id = ? ORDER BY position ASC').all(itemId) as Row[]).map(followFromRow))
  }

  countOpenFollows(itemId: string): number {
    const row = this.#statement("SELECT COUNT(*) AS count FROM work_item_follow WHERE item_id = ? AND state = 'open'").get(itemId) as Row
    return Number(row['count'])
  }

  /** Global follow counts for health reporting (open rows of live items only). */
  countFollows(): { open: number; closed: number } {
    const liveStates = OPEN_STATES.map(() => '?').join(', ')
    const open = this.#statement(`
      SELECT COUNT(*) AS count FROM work_item_follow AS follow
      JOIN work_item AS item ON item.id = follow.item_id
      WHERE follow.state = 'open' AND item.observed = 0 AND item.state IN (${liveStates})
    `).get(...OPEN_STATES) as Row
    const closed = this.#statement("SELECT COUNT(*) AS count FROM work_item_follow WHERE state = 'closed'").get() as Row
    return { open: Number(open['count']), closed: Number(closed['count']) }
  }

  /**
   * Identity of every open follow on a live item, for health projections.
   *
   * A follow row outlives the item it parked when that item is withdrawn or
   * otherwise settled by another path (no resolver ever observed those threads).
   * Reporting those rows as gaps would make health permanently degraded over
   * dead items, so only follows of still-open items count.
   */
  openFollowIdentities(): readonly { readonly source: string; readonly sourceGeneration: string }[] {
    const liveStates = OPEN_STATES.map(() => '?').join(', ')
    const rows = this.#statement(`
      SELECT follow.source, follow.source_generation FROM work_item_follow AS follow
      JOIN work_item AS item ON item.id = follow.item_id
      WHERE follow.state = 'open' AND item.observed = 0 AND item.state IN (${liveStates})
    `).all(...OPEN_STATES) as Row[]
    return Object.freeze(rows.map(row => Object.freeze({
      source: String(row['source']),
      sourceGeneration: String(row['source_generation']),
    })))
  }

  /** Open follows across live items, oldest first, bounded for diagnostics. */
  listOpenFollows(limit: number): readonly WorkItemFollowRecord[] {
    const liveStates = OPEN_STATES.map(() => '?').join(', ')
    const rows = this.#statement(`
      SELECT follow.* FROM work_item_follow AS follow
      JOIN work_item AS item ON item.id = follow.item_id
      WHERE follow.state = 'open' AND item.observed = 0 AND item.state IN (${liveStates})
      ORDER BY follow.opened_at ASC, follow.item_id ASC, follow.position ASC LIMIT ?
    `).all(...OPEN_STATES, limit) as Row[]
    return Object.freeze(rows.map(followFromRow))
  }

  /**
   * Close one open follow exactly once.
   *
   * The CAS on `state = 'open'` is what makes duplicate and out-of-order
   * closures harmless: a second observation of the same closure changes no row
   * and reports `undefined`, so no settlement signal can be produced twice.
   */
  closeFollow(itemId: string, position: number, closure: WorkItemThreadClosure, now = this.#now()): WorkItemFollowRecord | undefined {
    if (closure.state !== 'closed') fail('invalid-input', 'only a closed thread observation can close a follow')
    return this.#transaction(() => {
      const changes = this.#statement(`
        UPDATE work_item_follow SET state = 'closed', outcome = ?, digest = ?, closed_at = ?
        WHERE item_id = ? AND position = ? AND state = 'open'
      `).run(closure.outcome, closure.digest, now, itemId, position)
      if (Number(changes.changes) === 0) return undefined
      return this.follows(itemId)[position]
    })
  }

  /**
   * Waiting items that owe a thread-closure settlement.
   *
   * `waiting` with a terminal `last_report_status` is produced only by the
   * deferred report branch, so this is exactly the deferred set. Selecting on
   * the report status rather than on open follow rows keeps the sweep
   * crash-safe: a crash after closing the last follow but before appending the
   * outcome still finds the item on the next pass. A live lease is excluded
   * (additionally to the state check) so a re-claimed item is never settled
   * underneath its new worker.
   */
  itemsAwaitingThreadClosure(limit: number): readonly WorkItemRecord[] {
    const rows = this.#statement(`
      SELECT ${ITEM_ALIASES} FROM work_item
      WHERE observed = 0 AND state = 'waiting' AND lease_until IS NULL
        AND last_report_status IN ('ready', 'blocked', 'failed')
      ORDER BY updated_at ASC, id ASC LIMIT ?
    `).all(limit) as Row[]
    return Object.freeze(rows.map(itemFromRow))
  }

  /**
   * Settle one deferred item because every followed thread is closed.
   *
   * This appends at most one outcome revision, and a second call is a no-op.
   * The transition reuses the recorded terminal report status, so the item
   * still ends in the state the worker reported; the closure itself is never
   * treated as evidence of objective achievement.
   */
  settleThreadClosure(itemId: string): WorkItemOutcomeRecord | undefined {
    return this.#transaction(() => {
      const item = this.#requireItem(itemId)
      if (item.state !== 'waiting') fail('invalid-state', `item is ${item.state}, not awaiting thread closure`)
      if (item.observed) fail('invalid-state', 'observed items never settle from a thread closure')
      const status = item.lastReportStatus
      if (status === null || !DEFERRED_REPORT_STATUSES.includes(status as WorkItemDeferredReportStatus)) {
        fail('invalid-state', 'item has no deferred terminal report to settle')
      }
      if (this.countOpenFollows(item.id) > 0) fail('invalid-state', 'item still follows an open thread')
      // Exactly-once: a settlement revision that already exists is authoritative,
      // so a replay (duplicate closure, or a second sweep) appends nothing.
      if (this.latestOutcome(item.id) !== undefined) return undefined
      const now = this.#now()
      const nextState: WorkItemState = status === 'ready' ? 'ready' : status === 'blocked' ? 'blocked' : 'failed'
      const reason = status === 'blocked' ? 'reported-blocked' : status === 'failed' ? 'reported-failed' : null
      this.#statement('UPDATE work_item SET state = ?, state_reason = ?, lease_until = NULL, updated_at = ? WHERE id = ?')
        .run(nextState, reason, now, item.id)
      this.#statement("UPDATE work_item_claim SET state = 'released', updated_at = ? WHERE item_id = ? AND state = 'active'")
        .run(now, item.id)
      this.#appendEvent(item.id, 'settled', 'settlement', { reason: 'closed-by-thread', reportStatus: status }, now)
      const draft = threadClosureOutcome({
        status: status as WorkItemDeferredReportStatus,
        provenance: this.#admissionProvenance(item.id),
        now,
      })
      return this.#insertOutcome(item.id, draft, now)
    })
  }

  /**
   * Ambiguous sends that still describe an actionable gap.
   *
   * A failed row is dead weight once its item is terminal or observed (for
   * example a withdrawal after an ambiguous send): no retry is owed and the
   * owner already settled the item, so counting it would report a permanent
   * false gap. The gate mirrors `wakePending()`'s eligibility check.
   */
  countDispatchUnknown(): number {
    const row = this.#statement(`
      SELECT COUNT(*) AS count FROM work_item_dispatch d
      JOIN work_item i ON i.id = d.item_id
      WHERE d.state = 'failed' AND d.reason = 'unknown_after_send'
        AND i.observed = 0 AND i.state IN (${OPEN_STATE_PLACEHOLDERS})
    `).get(...OPEN_STATES) as Row
    return Number(row['count'])
  }

  /**
   * Park one item whose admission mandate failed revalidation.
   *
   * Parking is never terminal: the item stays `waiting` with a typed reason, its
   * pending dispatch row is left intact, and it becomes claimable/wakeable again
   * as soon as the identical mandate allows. Repeating the same park only
   * refreshes the audit timestamp, so a sweep that observes the same denial on
   * every tick does not flood the event log.
   */
  parkAuthority(
    itemId: string,
    reason: typeof AUTHORITY_REVOKED | typeof AUTHORITY_UNAVAILABLE,
    detail: Readonly<Record<string, unknown>>,
    now: number,
  ): WorkItemRecord {
    return this.#transaction(() => {
      const item = this.#requireItem(itemId)
      if (item.state === 'waiting' && item.stateReason === reason) {
        this.#statement('UPDATE work_item SET authority_checked_at = ?, updated_at = ? WHERE id = ?').run(now, now, itemId)
        return this.#requireItem(itemId)
      }
      this.#statement(`
        UPDATE work_item
        SET state = 'waiting', state_reason = ?, authority_checked_at = ?, updated_at = ?
        WHERE id = ?
      `).run(reason, now, now, itemId)
      this.#appendEvent(itemId, reason, 'authority', {
        ...detail,
        previousState: item.state,
        previousReason: item.stateReason,
      }, now)
      return this.#requireItem(itemId)
    })
  }

  /**
   * Record a successful revalidation of one item's mandate.
   *
   * Only a wait this gate itself created is lifted; a slice-9
   * `following-thread` wait is a different concern and stays untouched.
   */
  restoreAuthority(itemId: string, now: number): WorkItemRecord {
    return this.#transaction(() => {
      const item = this.#requireItem(itemId)
      this.#statement('UPDATE work_item SET authority_checked_at = ?, updated_at = ? WHERE id = ?').run(now, now, itemId)
      if (item.state !== 'waiting' || (item.stateReason !== AUTHORITY_REVOKED && item.stateReason !== AUTHORITY_UNAVAILABLE)) {
        return this.#requireItem(itemId)
      }
      this.#statement("UPDATE work_item SET state = 'queued', state_reason = NULL, updated_at = ? WHERE id = ?").run(now, itemId)
      this.#appendEvent(itemId, 'authority-restored', 'authority', { previousReason: item.stateReason }, now)
      return this.#requireItem(itemId)
    })
  }

  /** Latest authority denial for bounded health reporting. */
  lastAuthorityDenial(): { readonly at: number; readonly reason: string } | null {
    const row = this.#statement(`
      SELECT kind, detail, recorded_at FROM work_item_event
      WHERE kind IN ('${AUTHORITY_REVOKED}', '${AUTHORITY_UNAVAILABLE}')
      ORDER BY recorded_at DESC, sequence DESC LIMIT 1
    `).get() as Row | undefined
    if (row === undefined) return null
    const detail = optString(row['detail'])
    let reason: string = String(row['kind'])
    if (detail !== null) {
      try {
        const parsed = JSON.parse(detail) as { reason?: unknown }
        if (typeof parsed.reason === 'string' && parsed.reason.length > 0) reason = parsed.reason
      } catch {
        // Keep the event kind as the bounded fallback.
      }
    }
    return Object.freeze({ at: Number(row['recorded_at']), reason })
  }

  /**
   * Insert one admitted item, its lifecycle event and its single dispatch row
   * in one transaction. A crash between these writes is impossible.
   */
  admitItem(
    record: WorkItemRecord,
    event: { kind: string; actor: string; detail?: unknown },
    dispatch: WorkItemDispatchRecord,
    follows: readonly WorkItemFollowInput[] = [],
  ): void {
    this.#transaction(() => {
      this.#statement(INSERT_ITEM).run(
        record.id, record.dedupKey, record.dedupBucket, record.sourceId, record.kind, record.externalId,
        record.title, record.brief, record.briefTruncated ? 1 : 0, record.originBindingId, record.acceptanceRef,
        record.scope.workspace, record.scope.preset, record.scope.principalId,
        record.owner.principalRecordId, record.owner.principalVersion, record.owner.bindingVersion, record.owner.generation,
        record.scope.ownerRouteId, record.scope.expiresAt, record.workerAutomationId, record.state, record.stateReason,
        record.attempt, record.maxAttempts, record.leaseUntil, record.leaseRunId, record.occurrenceId,
        record.workDir, record.lastReportStatus, record.observed ? 1 : 0, record.createdAt, record.updatedAt,
        record.authority === null ? null : JSON.stringify(record.authority), null,
      )
      this.#appendEvent(record.id, event.kind, event.actor, event.detail, record.createdAt)
      this.#statement(`
        INSERT INTO work_item_dispatch(item_id, automation_id, event_id, occurred_at, generation, wake_attempts, state, occurrence_id, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(dispatch.itemId, dispatch.automationId, dispatch.eventId, dispatch.occurredAt, dispatch.generation, dispatch.wakeAttempts, dispatch.state, dispatch.occurrenceId, dispatch.reason, dispatch.createdAt, dispatch.updatedAt)
      // Follows are inserted in the same transaction as the item, so a crash can
      // never leave an admitted item whose bounded wait is unbounded by accident.
      follows.forEach((follow, position) => {
        this.#statement(`
          INSERT INTO work_item_follow(item_id, position, kind, ref, state, outcome, digest, source, source_generation, opened_at, closed_at)
          VALUES (?, ?, ?, ?, 'open', NULL, NULL, ?, ?, ?, NULL)
        `).run(record.id, position, follow.kind, follow.ref, follow.source, follow.sourceGeneration, record.createdAt)
      })
    })
  }

  /**
   * Retire every open item a canonical signal produced, because it was withdrawn.
   *
   * This is the only lifecycle transition driven by the read side of autonomy
   * rather than by a worker report. It is deliberately narrow: the items stop
   * being open, their active claim (if any) is released so the current run
   * cannot keep reporting, and a still-pending wake-up is failed rather than
   * re-armed. A wake-up already handed to the automation is left alone —
   * delivery to a running occurrence cannot be recalled from here.
   *
   * Withdrawal targets the whole dedup key, not the newest row, because the
   * dedup window is a freshness bound: once it rolls, a still-open item can be
   * re-admitted under the same key with a different bucket. Retiring only the
   * newest row would leave the older one winnable by `wakePending()` on the next
   * host start, i.e. cancelled work could still be woken. All rows of the key
   * therefore settle together in one transaction.
   *
   * Idempotent: an already-terminal key is returned unchanged (`settled`) with
   * no new event, so a repeated withdrawn revision never rewrites history.
   */
  withdrawByDedupKey(dedupKey: string, attribution?: WithdrawAttribution): WithdrawDedupResult {
    const now = this.#now()
    return this.#transaction(() => {
      const rows = this.#statement(`
        SELECT ${ITEM_ALIASES} FROM work_item
        WHERE dedup_key = ? AND state IN (${OPEN_STATE_PLACEHOLDERS})
        ORDER BY created_at ASC, id ASC
      `).all(dedupKey, ...OPEN_STATES) as Row[]
      if (rows.length === 0) {
        const latest = this.findLatestItemByDedupKey(dedupKey)
        return latest === undefined
          ? Object.freeze({ outcome: 'absent' as const, items: Object.freeze([]) })
          : Object.freeze({ outcome: 'settled' as const, items: Object.freeze([latest]) })
      }
      const retired: WorkItemRecord[] = []
      for (const row of rows) {
        const item = itemFromRow(row)
        this.#statement(`
          UPDATE work_item
          SET state = 'dropped', state_reason = 'signal-withdrawn', lease_until = NULL, lease_run_id = NULL,
              occurrence_id = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, item.id)
        this.#statement("UPDATE work_item_claim SET state = 'released', updated_at = ? WHERE item_id = ? AND state = 'active'")
          .run(now, item.id)
        this.#statement("UPDATE work_item_dispatch SET state = 'failed', reason = 'signal-withdrawn', updated_at = ? WHERE item_id = ? AND state = 'pending'")
          .run(now, item.id)
        this.#appendEvent(item.id, 'withdrawn', 'signal-intake', {
          stateReason: 'signal-withdrawn',
          previousState: item.state,
          ...(attribution === undefined ? {} : { sourceId: attribution.sourceId, externalId: attribution.externalId, observedAt: attribution.observedAt }),
        }, now)
        this.#insertOutcome(item.id, deriveWithdrawalOutcome(now), now)
        retired.push(this.#requireItem(item.id))
      }
      return Object.freeze({ outcome: 'withdrawn' as const, items: Object.freeze(retired) })
    })
  }

  /**
   * Provenance of the admission that created this item.
   *
   * The event detail is the only durable place the signal evidence lives, and
   * reading it inside the terminal transaction keeps baseline extraction atomic
   * with the outcome it fences.
   */
  #admissionProvenance(itemId: string): WorkItemProvenance | null {
    const row = this.#statement("SELECT detail FROM work_item_event WHERE item_id = ? AND kind IN ('admitted', 'observed') ORDER BY sequence ASC LIMIT 1")
      .get(itemId) as Row | undefined
    const detail = row === undefined ? null : optString(row['detail'])
    if (detail === null) return null
    try {
      const parsed = JSON.parse(detail) as { provenance?: WorkItemProvenance }
      return parsed.provenance ?? null
    } catch {
      // A malformed event is no baseline, so the item settles as
      // `not-applicable` instead of opening an unverifiable window.
      return null
    }
  }

  /** Append one outcome revision; the revision number is derived, never supplied. */
  #insertOutcome(itemId: string, draft: WorkItemOutcomeDraft, now: number): WorkItemOutcomeRecord {
    const latest = this.latestOutcome(itemId)
    const revision = latest === undefined ? 1 : latest.revision + 1
    this.#statement(`
      INSERT INTO work_item_outcome(item_id, revision, settled_by, execution_status, objective_status, trust,
        evidence_state, evidence_reason, evidence, baseline_sequence, inbox_id, authority_hash, deadline_at, settled_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      itemId, revision, draft.settledBy, draft.executionStatus, draft.objectiveStatus, draft.trust,
      draft.evidenceState, draft.evidenceReason,
      draft.evidence === null ? null : JSON.stringify(draft.evidence),
      draft.baselineSequence, draft.inboxId, draft.authorityHash, draft.deadlineAt, draft.settledAt, now,
    )
    const row = this.#statement('SELECT * FROM work_item_outcome WHERE item_id = ? AND revision = ?').get(itemId, revision) as Row | undefined
    if (row === undefined) fail('storage', 'outcome row disappeared after insert')
    return outcomeFromRow(row)
  }

  latestOutcome(itemId: string): WorkItemOutcomeRecord | undefined {
    const row = this.#statement('SELECT * FROM work_item_outcome WHERE item_id = ? ORDER BY revision DESC LIMIT 1').get(itemId) as Row | undefined
    return row === undefined ? undefined : outcomeFromRow(row)
  }

  /** Every outcome revision for one item, oldest first. */
  outcomes(itemId: string): readonly WorkItemOutcomeRecord[] {
    return Object.freeze((this.#statement('SELECT * FROM work_item_outcome WHERE item_id = ? ORDER BY revision ASC').all(itemId) as Row[]).map(outcomeFromRow))
  }

  /**
   * Latest outcome plus the report delivery state it depends on.
   *
   * `reportRevision` is the terminal report that caused a report-derived
   * transition; observation and expiry revisions keep pointing at it, while
   * withdrawal and retry exhaustion never had a report.
   */
  outcomeView(itemId: string): WorkItemOutcomeView | undefined {
    const outcome = this.latestOutcome(itemId)
    if (outcome === undefined) return undefined
    const reportBacked = outcome.settledBy === 'report-ready'
      || outcome.settledBy === 'report-blocked'
      || outcome.settledBy === 'report-failed'
      || outcome.settledBy === 'observed-evidence'
      || outcome.settledBy === 'window-expired'
      || outcome.settledBy === 'closed-by-thread'
    const report = reportBacked ? this.lastReport(itemId) : undefined
    return Object.freeze({
      outcome,
      deliveryState: report?.deliveryState ?? null,
      reportRevision: report?.revision ?? null,
    })
  }

  /** Latest outcomes, newest first, optionally filtered by evidence state. */
  listOutcomes(options: { limit?: number; evidenceState?: WorkItemOutcomeEvidenceState } = {}): readonly WorkItemOutcomeView[] {
    const limit = options.limit ?? 20
    const conditions = ['1 = 1']
    const parameters: Array<string | number> = []
    if (options.evidenceState !== undefined) {
      conditions.push('o.evidence_state = ?')
      parameters.push(options.evidenceState)
    }
    parameters.push(limit)
    const rows = this.#statement(`
      SELECT o.* FROM work_item_outcome o
      JOIN (${LATEST_OUTCOME}) latest ON latest.item_id = o.item_id AND latest.revision = o.revision
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.settled_at DESC, o.item_id ASC LIMIT ?
    `).all(...parameters) as Row[]
    return Object.freeze(rows.map(row => {
      const view = this.outcomeView(String(row['item_id']))
      if (view === undefined) fail('storage', 'outcome view disappeared while listing')
      return view
    }))
  }

  /**
   * Latest outcome revisions still waiting for evidence, soonest deadline first.
   *
   * Only the newest revision per item is considered: an older revision that was
   * superseded still says `pending` in the immutable row, but it is history, not
   * an open window.
   */
  pendingOutcomes(limit: number): readonly WorkItemOutcomeRecord[] {
    const rows = this.#statement(`
      SELECT o.* FROM work_item_outcome o
      JOIN (${LATEST_OUTCOME}) latest ON latest.item_id = o.item_id AND latest.revision = o.revision
      WHERE o.evidence_state = 'pending' AND o.deadline_at IS NOT NULL
      ORDER BY o.deadline_at ASC, o.item_id ASC LIMIT ?
    `).all(limit) as Row[]
    return Object.freeze(rows.map(outcomeFromRow))
  }

  /**
   * Append the settling revision for one pending outcome.
   *
   * Compare-and-swap on the revision number: a concurrent pass that already
   * settled the item fails here instead of overwriting its history.
   *
   * This intentionally appends no `work_item_event`: the outcome ledger is its
   * own append-only audit trail, and duplicating every revision into the event
   * log would mix worker lifecycle with independently sourced evidence.
   */
  settleOutcome(input: {
    itemId: string
    revision: number
    evidence: WorkItemOutcomeEvidence | null
    reason: WorkItemOutcomeEvidenceReason | null
    degraded: boolean
    expired: boolean
  }): WorkItemOutcomeRecord {
    return this.#transaction(() => {
      const now = this.#now()
      const latest = this.latestOutcome(input.itemId)
      if (latest === undefined) fail('invalid-state', 'cannot settle an item without an outcome')
      if (latest.revision !== input.revision) fail('invalid-state', 'outcome revision moved before settlement')
      if (latest.evidenceState !== 'pending') fail('invalid-state', `outcome is ${latest.evidenceState}, not pending`)
      const draft = input.expired
        ? expiredOutcome(latest, now, input.degraded)
        : observedOutcome(latest, input.evidence, input.reason, now)
      return this.#insertOutcome(input.itemId, draft, now)
    })
  }

  /**
   * Latest outcome revisions that still owe exactly one trusted Evaluation
   * append.
   *
   * Only the newest revision per item is exportable, and only once it carries a
   * settled evidence state: an unresolved `pending` window is still changing, so
   * exporting it early would publish a claim that later revisions contradict.
   */
  outcomesAwaitingEvaluation(limit: number, attemptBound = Number.MAX_SAFE_INTEGER): readonly WorkItemOutcomeRecord[] {
    // A row that exhausted its bounded export attempts stays `pending` for
    // health, but it must not keep a slot in every later sweep: otherwise an
    // unreachable sink would permanently starve newer settlements behind the
    // same handful of oldest rows.
    const rows = this.#statement(`
      SELECT o.* FROM work_item_outcome o
      JOIN (${LATEST_OUTCOME}) latest ON latest.item_id = o.item_id AND latest.revision = o.revision
      WHERE o.evaluation_state = 'pending' AND o.evidence_state != 'pending'
        AND o.evaluation_attempts < ?
      ORDER BY o.settled_at ASC, o.item_id ASC LIMIT ?
    `).all(attemptBound, limit) as Row[]
    return Object.freeze(rows.map(outcomeFromRow))
  }

  /** Count settled revisions that used up their bounded export attempts. */
  countExhaustedEvaluations(attemptBound: number): number {
    const row = this.#statement(`
      SELECT COUNT(*) AS count FROM work_item_outcome o
      JOIN (${LATEST_OUTCOME}) latest ON latest.item_id = o.item_id AND latest.revision = o.revision
      WHERE o.evaluation_state = 'pending' AND o.evidence_state != 'pending'
        AND o.evaluation_attempts >= ?
    `).get(attemptBound) as Row
    return Number(row['count'])
  }

  /** Count latest export-eligible revisions per Evaluation export state. */
  countEvaluations(): { pending: number; exported: number; skipped: number } {
    const rows = this.#statement(`
      SELECT o.evaluation_state AS state, COUNT(*) AS count FROM work_item_outcome o
      JOIN (${LATEST_OUTCOME}) latest ON latest.item_id = o.item_id AND latest.revision = o.revision
      WHERE o.evidence_state != 'pending'
      GROUP BY o.evaluation_state
    `).all() as Row[]
    let pending = 0
    let exported = 0
    let skipped = 0
    for (const row of rows) {
      const count = Number(row['count'])
      const state = String(row['state'])
      if (state === 'exported') exported = count
      else if (state === 'skipped') skipped = count
      else pending = count
    }
    return { pending, exported, skipped }
  }

  /**
   * Bounded, read-only execution facts for one item at a settlement instant.
   *
   * Every counter is a COUNT over durable rows this ledger already keeps for
   * the item; nothing is re-derived from live process state. `settledAt` bounds
   * each read because rows recorded after the settled revision belong to a
   * later observation and must not inflate an earlier claim. An absent item row
   * returns `undefined` so the caller can keep the live-record fallback.
   *
   * Claims are counted from `claimed` ledger events rather than claim rows:
   * each committed claim appends exactly one such event in the same transaction
   * as the claim row and the `item.attempt` increment (the replay branch appends
   * neither, retry-exhausted appends `blocked` only, and nothing deletes either
   * record), while `work_item_claim` has no `item_id` index. `work_item_event`
   * is `WITHOUT ROWID` keyed by `(item_id, sequence)`, so its count is an
   * indexed prefix search instead of a scan of every claim ever recorded.
   */
  workItemExecutionMetrics(itemId: string, settledAt: number): WorkItemExecutionMetrics | undefined {
    const item = this.findItemById(itemId)
    if (item === undefined) return undefined
    const row = this.#statement(`
      SELECT
        (SELECT COUNT(*) FROM work_item_event WHERE item_id = ? AND kind = 'claimed' AND recorded_at <= ?) AS claims,
        (SELECT COUNT(*) FROM work_item_report WHERE item_id = ? AND recorded_at <= ?) AS reports,
        (SELECT COUNT(*) FROM work_item_report WHERE item_id = ? AND recorded_at <= ? AND status = 'waiting') AS waiting_reports,
        (SELECT COUNT(*) FROM work_item_event WHERE item_id = ? AND kind = 'dispatch-unknown' AND recorded_at <= ?) AS unknown_dispatches,
        (SELECT COUNT(*) FROM work_item_event WHERE item_id = ? AND kind = 'claim-expired' AND recorded_at <= ?) AS claim_expiries
    `).get(
      itemId, settledAt,
      itemId, settledAt,
      itemId, settledAt,
      itemId, settledAt,
      itemId, settledAt,
    ) as Row
    const count = (value: unknown): number => {
      const parsed = Number(value)
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
    }
    const elapsed = settledAt - item.createdAt
    const latencyMs = Number.isSafeInteger(elapsed) ? Math.max(0, elapsed) : 0
    const claims = count(row['claims'])
    // Each committed claim appends exactly one `claimed` event and increments
    // `attempt` atomically, so the settlement-bounded event count is the attempt
    // count at `settledAt` — unlike the mutable `item.attempt`, it cannot absorb
    // retries that happen after the settled revision.
    const retries = Math.max(0, claims - 1)
    const reports = count(row['reports'])
    const waitingReports = count(row['waiting_reports'])
    const unknownDispatches = count(row['unknown_dispatches'])
    const claimExpiries = count(row['claim_expiries'])
    return Object.freeze({
      latencyMs,
      ...(retries > 0 ? { retries } : {}),
      ...(claims > 0 ? { claims } : {}),
      ...(reports > 0 ? { reports } : {}),
      ...(waitingReports > 0 ? { waitingReports } : {}),
      ...(unknownDispatches > 0 ? { unknownDispatches } : {}),
      ...(claimExpiries > 0 ? { claimExpiries } : {}),
    })
  }

  /**
   * Bounded, read-only resume brief for one item at a claim instant.
   *
   * Everything is derived from the item's own append-only ledger rows, so a
   * fresh occurrence can continue without replaying a prior model's memory.
   * Absent items return `undefined` (mirroring `workItemExecutionMetrics`) so
   * the caller never invents an empty context for a row that vanished.
   *
   * The event read is a bounded newest-first scan of one item's primary-key
   * prefix; it reconstructs prior attempts from the `claimed` event that
   * records `{runId, attempt}` and the recovery/report events that end one.
   * Malformed or absent detail JSON is skipped, never thrown. Reports are read
   * newest-first through the same primary-key prefix and capped at five, with
   * each summary cut to a safe UTF-8 byte boundary.
   */
  workItemResumeContext(itemId: string, now: number = this.#now()): WorkItemResumeContext | undefined {
    const item = this.findItemById(itemId)
    if (item === undefined) return undefined
    const priorAttempts = Math.max(0, item.attempt - 1)
    const eventRows = (this.#statement(`
      SELECT sequence, kind, detail, recorded_at
      FROM work_item_event
      WHERE item_id = ? AND recorded_at <= ? AND kind IN ('claimed', 'claim-expired', 'reclaimed', 'blocked', 'reported', 'settled')
      ORDER BY sequence DESC
      LIMIT ${String(RESUME_EVENT_SCAN_LIMIT)}
    `).all(itemId, now) as Row[]).reverse()
    interface AttemptDraft {
      readonly attempt: number
      readonly runId: string | null
      readonly startedAt: number
      ended: WorkItemResumeAttempt['ended']
      terminalStatus: WorkItemReportStatus | null
    }
    const byAttempt = new Map<number, AttemptDraft>()
    const openNewest = (): AttemptDraft | undefined => {
      const drafts = [...byAttempt.values()]
      for (let index = drafts.length - 1; index >= 0; index -= 1) {
        const draft = drafts[index]
        if (draft !== undefined && draft.ended === null) return draft
      }
      return undefined
    }
    for (const row of eventRows) {
      const kind = String(row['kind'])
      const detail = eventDetail(row['detail'])
      const recordedAt = Number(row['recorded_at'])
      if (kind === 'claimed') {
        const attempt = optCount(detail?.['attempt'])
        if (attempt === null || attempt >= item.attempt || byAttempt.has(attempt)) continue
        byAttempt.set(attempt, {
          attempt,
          runId: typeof detail?.['runId'] === 'string' ? detail['runId'] : null,
          startedAt: recordedAt,
          ended: null,
          terminalStatus: null,
        })
        continue
      }
      // An end event names its attempt when it can; otherwise it ends the most
      // recently started attempt still open. `reclaimExpired()` emits
      // `claim-expired` then `reclaimed` for the same attempt, so the second
      // event is ignored once the attempt is already closed.
      const hinted = optCount(detail?.['attempt'])
      const target = hinted === null
        ? openNewest()
        : (byAttempt.get(hinted)?.ended === null ? byAttempt.get(hinted) : undefined)
      if (target === undefined) continue
      if (kind === 'claim-expired') target.ended = 'expired'
      else if (kind === 'reclaimed') target.ended = 'reclaimed'
      else if (kind === 'blocked') {
        if (detail?.['reason'] !== 'retry-exhausted') continue
        target.ended = 'attempt-exhausted'
      } else if (kind === 'reported') {
        const status = typeof detail?.['status'] === 'string' ? detail['status'] as WorkItemReportStatus : null
        if (status === null || !TERMINAL_REPORT_STATUSES.includes(status)) continue
        target.ended = 'reported'
        target.terminalStatus = status
      } else if (kind === 'settled') target.ended = 'settled'
    }
    const attempts = Object.freeze([...byAttempt.values()]
      .sort((left, right) => left.attempt - right.attempt)
      .slice(-RESUME_ATTEMPT_LIMIT)
      .map(draft => Object.freeze({
        attempt: draft.attempt,
        runId: draft.runId,
        startedAt: draft.startedAt,
        ended: draft.ended,
        terminalStatus: draft.terminalStatus,
      })))
    const reportRows = (this.#statement(`
      SELECT revision, status, summary, truncated, recorded_at
      FROM work_item_report
      WHERE item_id = ? AND recorded_at <= ?
      ORDER BY revision DESC
      LIMIT ${String(RESUME_REPORT_LIMIT)}
    `).all(itemId, now) as Row[]).reverse()
    const reports: readonly WorkItemResumeReport[] = Object.freeze(reportRows.map(row => {
      const cut = truncateUtf8(String(row['summary']), RESUME_SUMMARY_BYTES)
      return Object.freeze({
        revision: Number(row['revision']),
        status: String(row['status']) as WorkItemReportStatus,
        summary: cut.value,
        summaryTruncated: Number(row['truncated']) === 1 || cut.truncated,
        recordedAt: Number(row['recorded_at']),
      })
    }))
    const reportsTotal = this.reportCount(itemId)
    const settled = this.latestOutcome(itemId)
    const latestOutcome: WorkItemResumeOutcome | null = settled === undefined
      ? null
      : Object.freeze({
        revision: settled.revision,
        settledBy: settled.settledBy,
        executionStatus: settled.executionStatus,
        objectiveStatus: settled.objectiveStatus,
        evidenceState: settled.evidenceState,
        evidenceReason: settled.evidenceReason,
        settledAt: settled.settledAt,
      })
    return Object.freeze({
      resumed: priorAttempts > 0 || reports.length > 0 || latestOutcome !== null,
      priorAttempts,
      attempts,
      reports,
      reportsTotal,
      latestOutcome,
      truncated: priorAttempts > attempts.length || reportsTotal > reports.length,
    })
  }

  /** Mark one settled revision exported; CAS on `pending` so a replay is refused. */
  markOutcomeExported(itemId: string, revision: number, digest: string, recordedAt: number): WorkItemOutcomeRecord {
    const changes = this.#statement(`
      UPDATE work_item_outcome SET evaluation_state = 'exported', evaluation_digest = ?, evaluation_recorded_at = ?
      WHERE item_id = ? AND revision = ? AND evaluation_state = 'pending'
    `).run(digest, recordedAt, itemId, revision).changes
    if (changes !== 1) fail('invalid-state', 'outcome evaluation state moved before export')
    return this.#requireOutcome(itemId, revision)
  }

  /** Mark one settled revision skipped; CAS on `pending`. */
  markOutcomeSkipped(itemId: string, revision: number, recordedAt: number): WorkItemOutcomeRecord {
    const changes = this.#statement(`
      UPDATE work_item_outcome SET evaluation_state = 'skipped', evaluation_recorded_at = ?
      WHERE item_id = ? AND revision = ? AND evaluation_state = 'pending'
    `).run(recordedAt, itemId, revision).changes
    if (changes !== 1) fail('invalid-state', 'outcome evaluation state moved before skip')
    return this.#requireOutcome(itemId, revision)
  }

  /** Count one failed export attempt, saturated at the caller's bound. */
  recordOutcomeEvaluationAttempt(itemId: string, revision: number, maxAttempts: number): WorkItemOutcomeRecord {
    this.#statement(`
      UPDATE work_item_outcome SET evaluation_attempts = MIN(evaluation_attempts + 1, ?)
      WHERE item_id = ? AND revision = ? AND evaluation_state = 'pending'
    `).run(maxAttempts, itemId, revision)
    return this.#requireOutcome(itemId, revision)
  }

  #requireOutcome(itemId: string, revision: number): WorkItemOutcomeRecord {
    const row = this.#statement('SELECT * FROM work_item_outcome WHERE item_id = ? AND revision = ?').get(itemId, revision) as Row | undefined
    if (row === undefined) fail('storage', 'outcome row disappeared after update')
    return outcomeFromRow(row)
  }

  appendEvent(itemId: string, kind: string, actor: string, detail?: unknown): void {
    const now = this.#now()
    this.#transaction(() => {
      this.#requireItem(itemId)
      this.#appendEvent(itemId, kind, actor, detail, now)
    })
  }

  events(itemId: string): readonly WorkItemEventRecord[] {
    return Object.freeze((this.#statement('SELECT item_id, sequence, kind, actor, detail, recorded_at FROM work_item_event WHERE item_id = ? ORDER BY sequence').all(itemId) as Row[]).map(row => Object.freeze({
      itemId: String(row['item_id']),
      sequence: Number(row['sequence']),
      kind: String(row['kind']),
      actor: String(row['actor']),
      detail: optString(row['detail']),
      recordedAt: Number(row['recorded_at']),
    })))
  }

  getDispatch(itemId: string): WorkItemDispatchRecord | undefined {
    const row = this.#statement('SELECT * FROM work_item_dispatch WHERE item_id = ?').get(itemId) as Row | undefined
    return row === undefined ? undefined : dispatchFromRow(row)
  }

  /**
   * Pending dispatches whose due time has arrived.
   *
   * `occurred_at` doubles as the due time: admission sets it to the admit
   * instant, a lease reclaim re-arms it at the reclaim instant, and a `waiting`
   * report re-arms it at `now + limits.waitingResumeMs`. Filtering here keeps
   * recovery lazy and prevents an early wake of a deliberately delayed resume.
   */
  listOpenDispatches(limit: number): readonly WorkItemDispatchRecord[] {
    return Object.freeze((this.#statement(`
      SELECT * FROM work_item_dispatch
      WHERE state = 'pending' AND occurred_at <= ?
      ORDER BY occurred_at ASC, created_at ASC LIMIT ?
    `).all(this.#now(), limit) as Row[]).map(dispatchFromRow))
  }

  /** At most ten due waiting resumes, with durable keyset round-robin fairness. */
  listDueWaitingResumes(limit = 10): readonly WorkItemDispatchRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail('invalid-input', 'waiting resume limit must be between 1 and 10')
    let cursor: { occurredAt: number; itemId: string } | null = null
    const stored = this.meta(WAITING_RESUME_CURSOR)
    if (stored !== null) {
      try {
        const value = JSON.parse(stored) as Record<string, unknown>
        if (value === null || typeof value !== 'object' || Array.isArray(value)
          || !Number.isSafeInteger(value['occurredAt']) || Number(value['occurredAt']) < 0
          || typeof value['itemId'] !== 'string' || !/^[a-z0-9-]{1,200}$/u.test(value['itemId'])) throw new Error('cursor')
        cursor = { occurredAt: Number(value['occurredAt']), itemId: value['itemId'] }
      } catch { fail('storage', 'waiting resume cursor is malformed') }
    }
    const select = (comparison: '>' | '<=', count: number): WorkItemDispatchRecord[] => (this.#statement(`
      SELECT d.* FROM work_item_dispatch d INDEXED BY work_item_dispatch_waiting_due_idx
      WHERE d.state = 'pending' AND d.reason = 'waiting-resume' AND d.occurred_at <= ?
        AND (d.occurred_at, d.item_id) ${comparison} (?, ?)
      ORDER BY d.occurred_at ASC, d.item_id ASC LIMIT ?
    `).all(this.#now(), cursor?.occurredAt ?? 0, cursor?.itemId ?? '', count) as Row[]).map(dispatchFromRow)
    const rows = select('>', limit)
    if (cursor !== null && rows.length < limit) rows.push(...select('<=', limit - rows.length))
    return Object.freeze(rows)
  }

  /** Advance even past denied/expired-owner rows so later items are not starved. */
  advanceWaitingResumeCursor(dispatch: WorkItemDispatchRecord): void {
    this.setMeta(WAITING_RESUME_CURSOR, JSON.stringify({ occurredAt: dispatch.occurredAt, itemId: dispatch.itemId }))
  }

  /**
   * Failed dispatches whose wake outcome is unknown and that still own one
   * bounded retry inside the same generation.
   */
  listRetryableUnknownDispatches(limit: number): readonly WorkItemDispatchRecord[] {
    return Object.freeze((this.#statement(`
      SELECT d.* FROM work_item_dispatch d
      JOIN work_item i ON i.id = d.item_id
      WHERE d.state = 'failed' AND d.reason = 'unknown_after_send'
        AND i.observed = 0 AND i.state IN (${OPEN_STATE_PLACEHOLDERS})
        AND d.wake_attempts <= ?
      ORDER BY d.updated_at ASC LIMIT ?
    `).all(...OPEN_STATES, MAX_UNKNOWN_WAKE_ATTEMPTS, limit) as Row[]).map(dispatchFromRow))
  }

  markDispatchDispatched(itemId: string, occurrenceId: string): void {
    const now = this.#now()
    this.#transaction(() => {
      this.#requireItem(itemId)
      // Guarded transition: a wake-up that already committed must not be
      // rewritten by a late bookkeeping write, and a withdrawal that failed the
      // row in between must stay failed instead of masquerading as dispatched.
      const changed = this.#statement("UPDATE work_item_dispatch SET state = 'dispatched', occurrence_id = ?, reason = NULL, updated_at = ? WHERE item_id = ? AND state = 'pending'")
        .run(occurrenceId, now, itemId)
      if (Number(changed.changes) !== 1) fail('invalid-state', 'work item dispatch is no longer pending')
      this.#statement('UPDATE work_item SET occurrence_id = ?, updated_at = ? WHERE id = ?').run(occurrenceId, now, itemId)
      this.#appendEvent(itemId, 'dispatched', 'admission', { occurrenceId }, now)
    })
  }

  markDispatchFailed(itemId: string, reason: string): void {
    const now = this.#now()
    this.#transaction(() => {
      this.#requireItem(itemId)
      this.#statement("UPDATE work_item_dispatch SET state = 'failed', reason = ?, updated_at = ? WHERE item_id = ?").run(reason, now, itemId)
      this.#appendEvent(itemId, 'dispatch-failed', 'admission', { reason }, now)
    })
  }

  /**
   * Record an ambiguous wake failure: the peer may or may not have committed
   * the occurrence, so the row is failed with `unknown_after_send` and the
   * generation's retry budget is spent once.
   *
   * The identity is preserved, so a retry resolves the same occurrence instead
   * of minting a second run.
   */
  markDispatchUnknown(itemId: string): WorkItemDispatchRecord {
    const now = this.#now()
    return this.#transaction(() => {
      this.#requireItem(itemId)
      const current = this.getDispatch(itemId)
      if (current === undefined) fail('storage', 'work item has no dispatch row')
      const attempts = current.wakeAttempts + 1
      this.#statement("UPDATE work_item_dispatch SET state = 'failed', reason = 'unknown_after_send', wake_attempts = ?, updated_at = ? WHERE item_id = ?")
        .run(attempts, now, itemId)
      this.#appendEvent(itemId, 'dispatch-unknown', 'admission', { generation: current.generation, attempts, eventId: current.eventId }, now)
      return this.getDispatch(itemId) as WorkItemDispatchRecord
    })
  }

  /**
   * Re-arm one failed-with-unknown row inside the *same* generation.
   *
   * The persisted event id and occurred-at are reused verbatim, so the retry is
   * idempotent against the automation intake: if the first attempt did commit,
   * the retry resolves that occurrence; if it did not, the retry creates it.
   */
  retryUnknownDispatch(itemId: string): WorkItemDispatchRecord {
    return this.#transaction(() => {
      this.#requireItem(itemId)
      const current = this.getDispatch(itemId)
      if (current === undefined) fail('storage', 'work item has no dispatch row')
      if (current.state !== 'failed' || current.reason !== 'unknown_after_send') fail('invalid-state', 'dispatch is not awaiting an unknown-outcome retry')
      if (current.wakeAttempts > MAX_UNKNOWN_WAKE_ATTEMPTS) fail('invalid-state', 'dispatch unknown retry budget is spent')
      this.#writeRearm(current, current.generation, current.eventId, current.occurredAt, current.wakeAttempts, 'unknown_after_send')
      return this.getDispatch(itemId) as WorkItemDispatchRecord
    })
  }

  /**
   * Re-arm a fresh wake after a claim-time revalidation denial.
   *
   * At claim time the occurrence already exists, so parking alone would leave
   * the item without any future wake. A new generation is minted because the
   * denied run never claimed the item; once the mandate allows again, the
   * ordinary wake path hands the same item to a fresh occurrence.
   */
  rearmAuthority(itemId: string): void {
    this.#transaction(() => {
      const current = this.getDispatch(itemId)
      if (current === undefined || current.state !== 'dispatched') return
      const now = this.#now()
      const generation = current.generation + 1
      this.#writeRearm(current, generation, dispatchEventId(itemId, generation), now, 0, 'authority-resume')
    })
  }

  #writeRearm(
    current: WorkItemDispatchRecord,
    generation: number,
    eventId: string,
    occurredAt: number,
    wakeAttempts: number,
    reason: string,
  ): void {
    const now = this.#now()
    this.#statement(`
      UPDATE work_item_dispatch
      SET event_id = ?, occurred_at = ?, generation = ?, wake_attempts = ?, state = 'pending', occurrence_id = NULL, reason = ?, updated_at = ?
      WHERE item_id = ?
    `).run(eventId, occurredAt, generation, wakeAttempts, reason, now, current.itemId)
    this.#appendEvent(current.itemId, 'dispatch-rearmed', 'recovery', { reason, generation, eventId, occurredAt, wakeAttempts }, now)
  }

  /**
   * Reclaim every claim whose lease elapsed. Lazy by design: no timer owns
   * recovery, so a host that was down simply reclaims on the next touch.
   *
   * The expired claim is retired explicitly, the item returns to `queued` and
   * its dispatch row is re-armed so the normal wake path can hand the item to a
   * fresh occurrence. A re-queued item that nobody wakes would otherwise stay
   * queued forever, counted against `maxOpenItems`.
   */
  reclaimExpired(): ReclaimResult {
    const now = this.#now()
    const rows = this.#statement(`
      SELECT ${ITEM_ALIASES} FROM work_item
      WHERE state IN ('claimed', 'working') AND lease_until IS NOT NULL AND lease_until <= ?
      ORDER BY lease_until ASC
    `).all(now) as Row[]
    const requeued: string[] = []
    const blocked: string[] = []
    for (const row of rows) {
      const item = itemFromRow(row)
      const tryReclaim = (): 'requeued' | 'blocked' | 'skipped' => this.#transaction(() => {
        const current = this.#requireItem(item.id)
        if (current.leaseUntil === null || current.leaseUntil > now) return 'skipped'
        if (current.state !== 'claimed' && current.state !== 'working') return 'skipped'
        const exhausted = current.attempt >= current.maxAttempts
        const expiredRunIds = (this.#statement("SELECT run_id FROM work_item_claim WHERE item_id = ? AND state = 'active'").all(current.id) as Row[])
          .map(claim => String(claim['run_id']))
        this.#statement("UPDATE work_item_claim SET state = 'expired', updated_at = ? WHERE item_id = ? AND state = 'active'").run(now, current.id)
        this.#appendEvent(current.id, 'claim-expired', 'recovery', { reason: 'lease-expired', runIds: expiredRunIds, attempt: current.attempt }, now)
        if (exhausted) {
          this.#statement("UPDATE work_item SET state = 'blocked', state_reason = 'retry-exhausted', lease_until = NULL, lease_run_id = NULL, updated_at = ? WHERE id = ?")
            .run(now, current.id)
          this.#appendEvent(current.id, 'blocked', 'recovery', { reason: 'retry-exhausted', attempt: current.attempt }, now)
          this.#insertOutcome(current.id, deriveRetryExhaustedOutcome(now), now)
          return 'blocked'
        }
        this.#statement("UPDATE work_item SET state = 'queued', state_reason = 'lease-expired', lease_until = NULL, lease_run_id = NULL, updated_at = ? WHERE id = ?")
          .run(now, current.id)
        // Put the dispatch row back in the only state `wakePending()` scans, so
        // recovery is driven by the ordinary wake path rather than a side door.
        // A new generation is owed here: the previous occurrence completed (or
        // died), so re-waking the old identity would be a silent no-op.
        const dispatch = this.getDispatch(current.id)
        if (dispatch !== undefined) {
          const generation = dispatch.generation + 1
          this.#writeRearm(dispatch, generation, dispatchEventId(current.id, generation), now, 0, 'lease-expired')
        }
        this.#appendEvent(current.id, 'reclaimed', 'recovery', { reason: 'lease-expired', attempt: current.attempt }, now)
        return 'requeued'
      })
      const outcome = tryReclaim()
      if (outcome === 'requeued') requeued.push(item.id)
      else if (outcome === 'blocked') blocked.push(item.id)
    }
    return Object.freeze({ requeued: Object.freeze(requeued), blocked: Object.freeze(blocked) })
  }

  /** Latest claim for one run; a re-claim after expiry appends a newer row. */
  findClaimByRun(runId: string): WorkItemClaimRecord | undefined {
    const row = this.#statement('SELECT * FROM work_item_claim WHERE run_id = ? ORDER BY claim_id DESC LIMIT 1').get(runId) as Row | undefined
    return row === undefined ? undefined : claimFromRow(row)
  }

  activeClaim(itemId: string): WorkItemClaimRecord | undefined {
    const row = this.#statement("SELECT * FROM work_item_claim WHERE item_id = ? AND state = 'active'").get(itemId) as Row | undefined
    return row === undefined ? undefined : claimFromRow(row)
  }

  /**
   * Compare-and-swap claim.
   *
   * A repeated claim from the same run replays the existing claim only while
   * that claim is still active, so a tool retry after transport loss is safe.
   * Once the lease elapsed the claim is retired and the same run obtains a new
   * claim row (and a new attempt), instead of replaying a dead lease forever.
   * A competing run loses with `claim-conflict`.
   */
  claim(input: { itemId: string; runId: string; occurrenceId: string; leaseMs: number }): ClaimResult {
    this.reclaimExpired()
    const outcome = this.#transaction(() => {
      const item = this.#requireItem(input.itemId)
      if (item.observed) fail('invalid-state', 'observed items cannot be claimed')
      const now = this.#now()
      const existing = this.findClaimByRun(input.runId)
      if (existing !== undefined && existing.itemId !== item.id) fail('claim-conflict', 'run already claimed another item')
      if (existing !== undefined && existing.state === 'active' && existing.leasedUntil > now) {
        return { exhausted: false as const, result: Object.freeze({ item, claim: existing, replayed: true }) }
      }
      if (existing !== undefined && existing.state === 'active') {
        // Retire the dead lease before a new row is appended, so the item never
        // carries two active claims.
        this.#statement("UPDATE work_item_claim SET state = 'expired', updated_at = ? WHERE claim_id = ?").run(now, existing.claimId)
        this.#appendEvent(item.id, 'claim-expired', 'worker', { reason: 'lease-expired', runId: input.runId, claimId: existing.claimId }, now)
      }
      if (!CLAIMABLE_STATES.includes(item.state)) fail('claim-conflict', `item is ${item.state}, not claimable`)
      if (item.attempt >= item.maxAttempts) {
        this.#statement("UPDATE work_item SET state = 'blocked', state_reason = 'retry-exhausted', updated_at = ? WHERE id = ?").run(now, item.id)
        this.#appendEvent(item.id, 'blocked', 'claim', { reason: 'retry-exhausted' }, now)
        this.#insertOutcome(item.id, deriveRetryExhaustedOutcome(now), now)
        // Commit the terminal transition, then fail: throwing inside the
        // transaction would roll the durable blocked state back.
        return { exhausted: true as const }
      }
      const attempt = item.attempt + 1
      const leasedUntil = now + input.leaseMs
      this.#statement(`
        UPDATE work_item SET state = 'claimed', state_reason = NULL, attempt = ?, lease_until = ?, lease_run_id = ?, updated_at = ?
        WHERE id = ?
      `).run(attempt, leasedUntil, input.runId, now, item.id)
      this.#statement(`
        INSERT INTO work_item_claim(item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(item.id, input.runId, input.occurrenceId, leasedUntil, now, now)
      this.#appendEvent(item.id, 'claimed', 'worker', { runId: input.runId, occurrenceId: input.occurrenceId, attempt }, now)
      const claim = this.findClaimByRun(input.runId)
      if (claim === undefined) fail('storage', 'claim row disappeared after insert')
      return { exhausted: false as const, result: Object.freeze({ item: this.#requireItem(item.id), claim, replayed: false }) }
    })
    if (outcome.exhausted) fail('retry-exhausted', 'work item exhausted its attempt budget')
    return outcome.result
  }

  reportCount(itemId: string): number {
    const row = this.#statement('SELECT COUNT(*) AS count FROM work_item_report WHERE item_id = ?').get(itemId) as Row
    return Number(row['count'])
  }

  lastReport(itemId: string): WorkItemReportRecord | undefined {
    const row = this.#statement('SELECT * FROM work_item_report WHERE item_id = ? ORDER BY revision DESC LIMIT 1').get(itemId) as Row | undefined
    return row === undefined ? undefined : reportFromRow(row)
  }

  reports(itemId: string): readonly WorkItemReportRecord[] {
    return Object.freeze((this.#statement('SELECT * FROM work_item_report WHERE item_id = ? ORDER BY revision ASC').all(itemId) as Row[]).map(reportFromRow))
  }

  /** Exact report and adjacent references, using the existing item/revision key. */
  reportByRevision(itemId: string, revision: number): Readonly<{
    report: WorkItemReportRecord
    previousRevision: number | null
    nextRevision: number | null
  }> | undefined {
    const row = this.#statement(`
      SELECT report.*,
        (SELECT MAX(revision) FROM work_item_report WHERE item_id = ? AND revision < ?) AS previous_revision,
        (SELECT MIN(revision) FROM work_item_report WHERE item_id = ? AND revision > ?) AS next_revision
      FROM work_item_report AS report WHERE item_id = ? AND revision = ?
    `).get(itemId, revision, itemId, revision, itemId, revision) as Row | undefined
    if (row === undefined) return undefined
    return Object.freeze({
      report: reportFromRow(row),
      previousRevision: row['previous_revision'] === null ? null : Number(row['previous_revision']),
      nextRevision: row['next_revision'] === null ? null : Number(row['next_revision']),
    })
  }

  /**
   * Append one report revision under the active claim, then apply the state
   * transition for that status.
   *
   * The caller's idempotency key is scoped to the claim row, so identical text
   * reported by different claims (or different items) is not mistaken for a
   * replay, while a retried call on the same claim returns the stored revision.
   */
  report(input: {
    itemId: string
    runId: string
    status: WorkItemReportStatus
    summary: string
    truncated: boolean
    artifactPaths: readonly string[]
    idempotencyKey: string
    maxReports: number
    leaseMs: number
    waitingResumeMs: number
  }): ReportResult {
    return this.#transaction(() => {
      const item = this.#requireItem(input.itemId)
      const claim = this.findClaimByRun(input.runId)
      if (claim === undefined || claim.itemId !== item.id) {
        fail('claim-conflict', 'report requires a claim for this item')
      }
      const idempotencyKey = `${input.idempotencyKey}\0${item.id}\0${String(claim.claimId)}`
      const duplicate = this.#statement('SELECT * FROM work_item_report WHERE idempotency_key = ?').get(idempotencyKey) as Row | undefined
      if (duplicate !== undefined) {
        const report = reportFromRow(duplicate)
        if (report.itemId !== item.id) fail('claim-conflict', 'idempotency key already belongs to another item')
        return Object.freeze({ item, report, replayed: true })
      }
      const now = this.#now()
      if (claim.state === 'expired') fail('claim-expired', 'claim lease elapsed; reclaim the item before reporting')
      if (claim.state !== 'active') fail('claim-conflict', 'report requires the active claim for this item')
      if (item.leaseRunId !== input.runId || item.leaseUntil === null || item.leaseUntil <= now) {
        fail('claim-expired', 'claim lease elapsed; reclaim the item before reporting')
      }
      if (!REPORTABLE_STATES.includes(item.state)) fail('invalid-state', `item is ${item.state}, not reportable`)
      if (this.reportCount(item.id) >= input.maxReports) fail('report-limit', 'work item reached maxReportsPerItem')
      const next = this.#statement('SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM work_item_report WHERE item_id = ?').get(item.id) as Row
      const revision = Number(next['next'])
      const deliveryKey = `work-item-report:${item.id}:${String(revision)}`
      this.#statement(`
        INSERT INTO work_item_report(item_id, revision, status, summary, truncated, artifact_paths, idempotency_key, delivery_key, delivery_state, delivery_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(item.id, revision, input.status, input.summary, input.truncated ? 1 : 0, JSON.stringify(input.artifactPaths), idempotencyKey, deliveryKey, now)

      let nextState: WorkItemState
      let reason: string | null = null
      // A terminal report whose item still follows an open thread is parked in
      // `waiting` instead of settling: the report is recorded and its status is
      // remembered, but no outcome revision exists yet and the worker's run is
      // complete. Settlement is deferred to a later bounded pass, so a closure
      // that arrived before the report can never end the item early.
      const followed = this.countOpenFollows(item.id) > 0
      const deferred = followed && DEFERRED_REPORT_STATUSES.includes(input.status as WorkItemDeferredReportStatus) && !item.observed
      switch (input.status) {
        case 'progress':
          nextState = 'working'
          break
        case 'waiting':
          nextState = 'waiting'
          break
        case 'ready':
          nextState = 'ready'
          break
        case 'blocked':
          nextState = 'blocked'
          reason = 'reported-blocked'
          break
        case 'failed':
          nextState = 'failed'
          reason = 'reported-failed'
          break
      }
      if (nextState === 'working') {
        const lease = now + input.leaseMs
        this.#statement('UPDATE work_item SET state = ?, state_reason = NULL, lease_until = ?, last_report_status = ?, updated_at = ? WHERE id = ?')
          .run(nextState, lease, input.status, now, item.id)
        this.#statement('UPDATE work_item_claim SET leased_until = ?, updated_at = ? WHERE claim_id = ?')
          .run(lease, now, claim.claimId)
      } else {
        const storedState = deferred ? 'waiting' : nextState
        const storedReason = deferred ? 'following-thread' : reason
        this.#statement('UPDATE work_item SET state = ?, state_reason = ?, lease_until = NULL, last_report_status = ?, updated_at = ? WHERE id = ?')
          .run(storedState, storedReason, input.status, now, item.id)
        this.#statement('UPDATE work_item_claim SET state = ?, updated_at = ? WHERE claim_id = ?')
          .run(input.status === 'waiting' && !deferred ? 'released' : 'completed', now, claim.claimId)
      }
      this.#appendEvent(item.id, 'reported', 'worker', { revision, status: input.status }, now)
      // `waiting` is not terminal: the item stays claimable, but nobody holds
      // the lease and no event is owed, so a waiting item would never resume
      // unless the report itself schedules the next generation. Resume is
      // delayed by `waitingResumeMs` and bounded by the attempt budget, so a
      // worker cannot spin occurrences by reporting `waiting` repeatedly.
      const resume = input.status === 'waiting'
        && !item.observed
        && item.attempt < item.maxAttempts
        && this.getDispatch(item.id) !== undefined
      if (resume) {
        const dispatch = this.getDispatch(item.id) as WorkItemDispatchRecord
        const generation = dispatch.generation + 1
        this.#writeRearm(dispatch, generation, dispatchEventId(item.id, generation), now + input.waitingResumeMs, 0, 'waiting-resume')
      }
      // The outcome revision is derived in the same transaction as the terminal
      // state change, so a crash can never leave a `ready` item with no outcome.
      const outcome = deriveReportOutcome({
        status: input.status,
        provenance: this.#admissionProvenance(item.id),
        now,
        windowMs: this.#settleWindowMs,
      })
      // Deferred items deliberately get no outcome row here: the single outcome
      // is appended by `settleThreadClosure()` once every follow is closed.
      if (outcome !== null && !deferred) this.#insertOutcome(item.id, outcome, now)
      const stored = this.#statement('SELECT * FROM work_item_report WHERE item_id = ? AND revision = ?').get(item.id, revision) as Row
      return Object.freeze({ item: this.#requireItem(item.id), report: reportFromRow(stored), replayed: false })
    })
  }

  setReportDelivery(itemId: string, revision: number, state: WorkItemDeliveryState, deliveryId: string | null): void {
    this.#transaction(() => {
      this.#statement('UPDATE work_item_report SET delivery_state = ?, delivery_id = ? WHERE item_id = ? AND revision = ?')
        .run(state, deliveryId, itemId, revision)
    })
  }

  /** Terminal item states map to terminal claim states. */
  static claimStateFor(report: WorkItemReportStatus): WorkItemClaimState {
    return report === 'waiting' ? 'released' : report === 'progress' ? 'active' : 'completed'
  }

  /** Open states are exposed for admission accounting and tests. */
  static openStates(): readonly WorkItemState[] {
    return OPEN_STATES
  }
}
