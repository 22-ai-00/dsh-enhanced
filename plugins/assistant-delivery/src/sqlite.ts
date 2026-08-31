import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const deliverySchemaVersion = 16

/**
 * A database-local, durable total order for every admitted Inbox. The trigger
 * deliberately lives in SQLite so an already-open v12 process also receives
 * a cursor after a v13 process migrates the shared database.
 */
const inboxAdmissionSchema = `
  CREATE TABLE IF NOT EXISTS delivery_inbox_admission_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    current_sequence INTEGER NOT NULL CHECK (
      current_sequence BETWEEN 0 AND 9007199254740991
    )
  ) STRICT;
  INSERT INTO delivery_inbox_admission_clock(singleton, current_sequence)
    VALUES (1, 0) ON CONFLICT(singleton) DO NOTHING;

  CREATE TABLE IF NOT EXISTS delivery_inbox_admissions (
    inbox_id TEXT PRIMARY KEY,
    epoch TEXT NOT NULL CHECK (
      length(epoch) = 32 AND epoch NOT GLOB '*[^0-9a-f]*'
    ),
    admission_sequence INTEGER NOT NULL UNIQUE CHECK (
      admission_sequence BETWEEN 1 AND 9007199254740991
    ),
    FOREIGN KEY (inbox_id) REFERENCES inbox_messages(id) ON DELETE CASCADE
  ) STRICT;

  INSERT OR IGNORE INTO delivery_inbox_admissions(inbox_id, epoch, admission_sequence)
  SELECT message.id, instance.instance_id,
    ROW_NUMBER() OVER (ORDER BY message.rowid)
  FROM inbox_messages AS message
  CROSS JOIN delivery_instance AS instance
  WHERE instance.singleton = 1;

  UPDATE delivery_inbox_admission_clock
  SET current_sequence = MAX(current_sequence,
    (SELECT COALESCE(MAX(admission_sequence), 0) FROM delivery_inbox_admissions))
  WHERE singleton = 1;

  CREATE TRIGGER IF NOT EXISTS delivery_inbox_admission_after_insert
  AFTER INSERT ON inbox_messages
  BEGIN
    UPDATE delivery_inbox_admission_clock
    SET current_sequence = current_sequence + 1
    WHERE singleton = 1;
    INSERT INTO delivery_inbox_admissions(inbox_id, epoch, admission_sequence)
    SELECT NEW.id, instance.instance_id, clock.current_sequence
    FROM delivery_instance AS instance
    CROSS JOIN delivery_inbox_admission_clock AS clock
    WHERE instance.singleton = 1 AND clock.singleton = 1;
  END;
`

const preferenceProjectionSchema = `
  CREATE TABLE delivery_preference_projection_outbox (
    batch_key TEXT PRIMARY KEY,
    payload_digest TEXT NOT NULL CHECK (
      length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    events_json TEXT NOT NULL CHECK (
      json_valid(events_json) AND json_type(events_json) = 'array'
      AND json_array_length(events_json) BETWEEN 1 AND 16
    ),
    status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL,
    failure_code TEXT,
    lane_kind TEXT NOT NULL DEFAULT 'unclassified' CHECK (
      lane_kind IN ('exact', 'legacy', 'unclassified')
    ),
    lane_epoch TEXT CHECK (
      lane_epoch IS NULL OR (
        length(lane_epoch) = 32 AND lane_epoch NOT GLOB '*[^0-9a-f]*'
      )
    ),
    lane_workspace TEXT,
    lane_preset TEXT,
    lane_principal_record_id TEXT,
    lane_principal_version INTEGER CHECK (
      lane_principal_version IS NULL OR lane_principal_version >= 1
    ),
    admission_sequence INTEGER CHECK (
      admission_sequence IS NULL OR admission_sequence BETWEEN 1 AND 9007199254740991
    ),
    terminal_at INTEGER CHECK (terminal_at IS NULL OR terminal_at >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX delivery_preference_projection_due
    ON delivery_preference_projection_outbox(
      terminal_at, lane_kind, status, next_attempt_at, updated_at, batch_key
    );
  CREATE INDEX delivery_preference_projection_lane
    ON delivery_preference_projection_outbox(
      terminal_at, lane_epoch, lane_workspace, lane_preset,
      lane_principal_record_id, lane_principal_version, admission_sequence,
      created_at, batch_key
    );
`

const workflowTraceSchema = `
  CREATE TABLE workflow_trace_source (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    contract_version INTEGER NOT NULL CHECK (contract_version = 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    authority_digest TEXT NOT NULL CHECK (
      length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE workflow_template_registry (
    template_ref TEXT PRIMARY KEY,
    template_digest TEXT NOT NULL CHECK (
      length(template_digest) = 64 AND template_digest NOT GLOB '*[^0-9a-f]*'
    ),
    scope_key TEXT NOT NULL,
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    owner_binding_id TEXT NOT NULL,
    content_json TEXT NOT NULL,
    privacy_kind TEXT NOT NULL CHECK (
      privacy_kind IN ('deterministic-deidentification', 'owner-explicit')
    ),
    privacy_attestation_id TEXT NOT NULL UNIQUE,
    privacy_attestation_digest TEXT NOT NULL CHECK (
      length(privacy_attestation_digest) = 64
      AND privacy_attestation_digest NOT GLOB '*[^0-9a-f]*'
    ),
    review_receipt_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    review_inbox_id TEXT NOT NULL,
    source_inbox_id TEXT NOT NULL,
    source_outbox_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    FOREIGN KEY (owner_binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (review_inbox_id) REFERENCES inbox_messages(id),
    FOREIGN KEY (source_inbox_id) REFERENCES inbox_messages(id),
    FOREIGN KEY (source_outbox_id) REFERENCES outbox_messages(id)
  ) STRICT;
  CREATE INDEX workflow_template_scope
    ON workflow_template_registry(scope_key, status, updated_at, template_ref);

  CREATE TABLE workflow_trace_revisions (
    subject_ref TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
    source_authority_digest TEXT NOT NULL CHECK (
      length(source_authority_digest) = 64
      AND source_authority_digest NOT GLOB '*[^0-9a-f]*'
    ),
    scope_key TEXT NOT NULL,
    workspace TEXT NOT NULL,
    preset TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('upsert', 'retract')),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (subject_ref, version)
  ) STRICT;

  CREATE TABLE workflow_trace_current (
    subject_ref TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1),
    digest TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('upsert', 'retract')),
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (subject_ref, version) REFERENCES workflow_trace_revisions(subject_ref, version)
  ) STRICT;

  CREATE TABLE workflow_trace_outbox (
    subject_ref TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'retry_wait')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (subject_ref, version),
    FOREIGN KEY (subject_ref, version) REFERENCES workflow_trace_revisions(subject_ref, version)
  ) STRICT;
  CREATE INDEX workflow_trace_outbox_due
    ON workflow_trace_outbox(status, next_attempt_at, updated_at, subject_ref, version);

  CREATE TABLE workflow_trace_commands (
    operation_id TEXT PRIMARY KEY,
    payload_digest TEXT NOT NULL CHECK (
      length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE trusted_delivery_evaluation_outbox (
    idempotency_key TEXT PRIMARY KEY,
    payload_digest TEXT NOT NULL CHECK (
      length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    claims_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'delivered')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX trusted_delivery_evaluation_due
    ON trusted_delivery_evaluation_outbox(status, next_attempt_at, updated_at, idempotency_key);
`

/**
 * One authenticated owner objective judgement for one ordinary Delivery turn.
 * This is intentionally separate from Evaluation's cross-plugin ledger: the
 * local receipt is the atomic proof coupled to a WorkflowTrace, so a restart
 * cannot leave a supposedly verified trace without its exact owner fence.
 */
const workflowVerifiedTaskFeedbackSchema = `
  CREATE TABLE IF NOT EXISTS workflow_verified_task_feedback (
    source_outbox_id TEXT PRIMARY KEY,
    source_inbox_id TEXT NOT NULL UNIQUE,
    feedback_inbox_id TEXT NOT NULL UNIQUE,
    binding_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
    principal_record_id TEXT NOT NULL,
    objective_status TEXT NOT NULL CHECK (
      objective_status IN ('achieved', 'partial', 'not-achieved')
    ),
    task_ref TEXT NOT NULL CHECK (
      length(task_ref) = 64 AND task_ref NOT GLOB '*[^0-9a-f]*'
    ),
    task_evidence_digest TEXT NOT NULL CHECK (
      length(task_evidence_digest) = 64
      AND task_evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
    trace_subject_ref TEXT CHECK (
      trace_subject_ref IS NULL
      OR (length(trace_subject_ref) = 64 AND trace_subject_ref NOT GLOB '*[^0-9a-f]*')
    ),
    trace_version INTEGER CHECK (trace_version IS NULL OR trace_version >= 1),
    trace_digest TEXT CHECK (
      trace_digest IS NULL
      OR (length(trace_digest) = 64 AND trace_digest NOT GLOB '*[^0-9a-f]*')
    ),
    template_ref TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
      (trace_subject_ref IS NOT NULL AND trace_version IS NOT NULL
        AND trace_digest IS NOT NULL AND template_ref IS NOT NULL)
      OR
      (trace_subject_ref IS NULL AND trace_version IS NULL
        AND trace_digest IS NULL AND template_ref IS NULL)
    ),
    FOREIGN KEY (source_outbox_id) REFERENCES outbox_messages(id),
    FOREIGN KEY (source_inbox_id) REFERENCES inbox_messages(id),
    FOREIGN KEY (feedback_inbox_id) REFERENCES inbox_messages(id),
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (principal_record_id) REFERENCES delivery_principals(id),
    FOREIGN KEY (template_ref) REFERENCES workflow_template_registry(template_ref),
    FOREIGN KEY (trace_subject_ref, trace_version)
      REFERENCES workflow_trace_revisions(subject_ref, version)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workflow_verified_task_feedback_binding
    ON workflow_verified_task_feedback(binding_id, created_at, source_outbox_id);
`

const deliveryPresentationSchema = `
  CREATE TABLE IF NOT EXISTS delivery_presentations (
    presentation_key TEXT PRIMARY KEY,
    original_outbox_idempotency_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'attempting', 'presented', 'retry_wait', 'dead')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    presented_revision INTEGER NOT NULL DEFAULT 0 CHECK (presented_revision >= 0),
    next_attempt_at INTEGER,
    claimed_by TEXT,
    fencing_token INTEGER,
    lease_until INTEGER,
    provider_message_id TEXT,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS delivery_presentation_claim
    ON delivery_presentations(status, next_attempt_at, lease_until, created_at, presentation_key);
`

const deadLetterResolutionSchema = `
  CREATE TABLE dead_letter_resolutions (
    kind TEXT NOT NULL CHECK (kind IN ('inbox', 'outbox')),
    message_id TEXT NOT NULL,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
    resolution TEXT NOT NULL CHECK (resolution IN ('cancel', 'retry')),
    original_status TEXT NOT NULL CHECK (
      (kind = 'inbox' AND original_status = 'dead_letter')
      OR (kind = 'outbox' AND original_status IN ('dead', 'unknown_after_send'))
    ),
    original_failure_code TEXT,
    operator_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, message_id, attempt_count)
  ) STRICT;
  CREATE INDEX dead_letter_resolution_projection
    ON dead_letter_resolutions(kind, resolution, message_id, attempt_count);
`

// These triggers are a rolling-upgrade fence for a v8 process that opened the
// database before v9 changed PRAGMA user_version. SQLite does not evict that
// already-open writer. A v9 writer first persists the exact operator receipt
// in the same transaction, so any receipt-less v8 resolution is rejected.
const deadLetterResolutionCompatibilitySchema = `
  CREATE TRIGGER dead_letter_inbox_resolution_fence
  BEFORE UPDATE ON inbox_messages
  WHEN OLD.status = 'dead_letter' AND NEW.attempt_count = OLD.attempt_count AND (
    NEW.status = 'queued'
    OR (NEW.status = 'dead_letter' AND NEW.failure_code = 'operator-cancelled')
  ) AND NOT EXISTS (
    SELECT 1 FROM dead_letter_resolutions AS resolution
    WHERE resolution.kind = 'inbox' AND resolution.message_id = OLD.id
      AND resolution.attempt_count = OLD.attempt_count
      AND resolution.resolution = CASE WHEN NEW.status = 'queued' THEN 'retry' ELSE 'cancel' END
      AND resolution.original_status = OLD.status
      AND resolution.original_failure_code IS OLD.failure_code
  )
  BEGIN
    SELECT RAISE(ABORT, 'inbox resolution requires an exact v9 receipt');
  END;

  CREATE TRIGGER dead_letter_outbox_resolution_fence
  BEFORE UPDATE ON outbox_messages
  WHEN OLD.status IN ('dead', 'unknown_after_send')
    AND NEW.attempt_count = OLD.attempt_count AND (
      NEW.status = 'pending'
      OR (NEW.status = 'dead' AND NEW.failure_code = 'operator-cancelled')
      OR (NEW.status = 'unknown_after_send' AND NEW.failure_code = 'operator-cancelled-unknown')
    ) AND NOT EXISTS (
    SELECT 1 FROM dead_letter_resolutions AS resolution
    WHERE resolution.kind = 'outbox' AND resolution.message_id = OLD.id
      AND resolution.attempt_count = OLD.attempt_count
      AND resolution.resolution = CASE WHEN NEW.status = 'pending' THEN 'retry' ELSE 'cancel' END
      AND resolution.original_status = OLD.status
      AND resolution.original_failure_code IS OLD.failure_code
  )
  BEGIN
    SELECT RAISE(ABORT, 'outbox resolution requires an exact v9 receipt');
  END;

  CREATE TRIGGER dead_letter_outbox_cancelled_unknown_fence
  BEFORE UPDATE ON outbox_messages
  WHEN OLD.status = 'unknown_after_send' AND EXISTS (
    SELECT 1 FROM dead_letter_resolutions AS resolution
    WHERE resolution.kind = 'outbox' AND resolution.message_id = OLD.id
      AND resolution.attempt_count = OLD.attempt_count AND resolution.resolution = 'cancel'
      AND resolution.original_status = 'unknown_after_send'
  ) AND NOT (
    NEW.attempt_count = OLD.attempt_count AND (
      (NEW.status = 'unknown_after_send' AND NEW.failure_code = 'operator-cancelled-unknown')
      OR (
        NEW.status IN ('accepted', 'delivered', 'read') AND EXISTS (
          SELECT 1 FROM delivery_receipts AS receipt
          WHERE receipt.channel = OLD.channel AND receipt.account = OLD.account
            AND receipt.provider_message_id = OLD.provider_message_id
            AND receipt.status = NEW.status
        )
      )
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'cancelled unknown outbox attempt cannot be reclaimed');
  END;
`

const deliveryInstanceSchema = `
  CREATE TABLE delivery_instance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    instance_id TEXT NOT NULL UNIQUE CHECK (
      length(instance_id) = 32 AND instance_id NOT GLOB '*[^0-9a-f]*'
    )
  ) STRICT;
  INSERT INTO delivery_instance (singleton, instance_id)
    VALUES (1, lower(hex(randomblob(16))));
`

const approvalDispatchCursorSchema = `
  CREATE TABLE approval_dispatch_cursor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    after_created_at INTEGER CHECK (after_created_at IS NULL OR after_created_at >= 0),
    after_proposal_id TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    updated_at INTEGER NOT NULL,
    CHECK ((after_created_at IS NULL) = (after_proposal_id IS NULL))
  ) STRICT;
`

/** Immutable v2 route receipt coupled to the approval Outbox insertion. */
const approvalOutboxRouteSchema = `
  CREATE TABLE IF NOT EXISTS approval_outbox_routes (
    outbox_id TEXT PRIMARY KEY,
    route_version INTEGER NOT NULL CHECK (route_version = 2),
    source_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
    binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
    workspace TEXT NOT NULL,
    principal TEXT NOT NULL,
    principal_record_id TEXT NOT NULL,
    principal_version INTEGER NOT NULL CHECK (principal_version >= 1),
    FOREIGN KEY (outbox_id) REFERENCES outbox_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (principal_record_id) REFERENCES delivery_principals(id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS approval_outbox_route_binding
    ON approval_outbox_routes(binding_id, binding_version, binding_generation);
`

function assertApprovalOutboxRouteSchema(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(approval_outbox_routes)').all() as Array<{
    name: string
    type: string
    notnull: number
    pk: number
  }>
  const expected = [
    ['outbox_id', 'TEXT', 1, 1],
    ['route_version', 'INTEGER', 1, 0],
    ['source_id', 'TEXT', 1, 0],
    ['binding_id', 'TEXT', 1, 0],
    ['binding_version', 'INTEGER', 1, 0],
    ['binding_generation', 'INTEGER', 1, 0],
    ['workspace', 'TEXT', 1, 0],
    ['principal', 'TEXT', 1, 0],
    ['principal_record_id', 'TEXT', 1, 0],
    ['principal_version', 'INTEGER', 1, 0],
  ] as const
  if (columns.length !== expected.length || expected.some((entry, index) => {
    const column = columns[index]
    return column === undefined || column.name !== entry[0] || column.type !== entry[1]
      || column.notnull !== entry[2] || column.pk !== entry[3]
  })) {
    throw new Error('delivery approval route receipt schema is invalid')
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_list(approval_outbox_routes)').all() as Array<{
    from: string
    table: string
    to: string
  }>
  const expectedForeignKeys = [
    ['binding_id', 'conversation_bindings', 'id'],
    ['outbox_id', 'outbox_messages', 'id'],
    ['principal_record_id', 'delivery_principals', 'id'],
  ]
  const actualForeignKeys = foreignKeys.map(row => [row.from, row.table, row.to]).sort()
  if (JSON.stringify(actualForeignKeys) !== JSON.stringify(expectedForeignKeys)) {
    throw new Error('delivery approval route receipt foreign keys are invalid')
  }
}

const modelPickerStateSchema = `
  CREATE TABLE conversation_model_epochs (
    conversation_hash TEXT PRIMARY KEY,
    conversation_json TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch >= 1),
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE model_picker_states (
    operation_id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id)
  ) STRICT;

  CREATE TABLE model_selection_settlements (
    operation_id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    conversation_hash TEXT NOT NULL,
    command_epoch INTEGER NOT NULL CHECK (command_epoch >= 1),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
    result_json TEXT,
    outbox_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    claimed_by TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id),
    FOREIGN KEY (conversation_hash) REFERENCES conversation_model_epochs(conversation_hash),
    FOREIGN KEY (outbox_id) REFERENCES outbox_messages(id)
  ) STRICT;
  CREATE INDEX model_selection_claim
    ON model_selection_settlements(status, lease_until, created_at, operation_id);
`

export class DeliveryDatabaseError extends Error {
  constructor(readonly code: 'invalid-path' | 'schema-too-new', message: string) {
    super(message)
    this.name = 'DeliveryDatabaseError'
  }
}

function hasTable(database: DatabaseSync, name: string): boolean {
  return database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name) !== undefined
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some(entry => entry.name === column)
}

function migratePreferenceProjectionLane(database: DatabaseSync): void {
  const lockedVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version
  if (lockedVersion >= 14) return
  if (lockedVersion !== 13) {
    throw new Error(`delivery preference lane migration expected schema 13, received ${lockedVersion}`)
  }
  if (!hasTable(database, 'delivery_preference_projection_outbox')) {
    database.exec('PRAGMA user_version = 14')
    return
  }
    const additions = [
      ['lane_kind', `TEXT NOT NULL DEFAULT 'unclassified' CHECK (
        lane_kind IN ('exact', 'legacy', 'unclassified')
      )`],
      ['lane_epoch', `TEXT CHECK (
        lane_epoch IS NULL OR (
          length(lane_epoch) = 32 AND lane_epoch NOT GLOB '*[^0-9a-f]*'
        )
      )`],
      ['lane_workspace', 'TEXT'],
      ['lane_preset', 'TEXT'],
      ['lane_principal_record_id', 'TEXT'],
      ['lane_principal_version', `INTEGER CHECK (
        lane_principal_version IS NULL OR lane_principal_version >= 1
      )`],
      ['admission_sequence', `INTEGER CHECK (
        admission_sequence IS NULL OR admission_sequence BETWEEN 1 AND 9007199254740991
      )`],
      ['terminal_at', 'INTEGER CHECK (terminal_at IS NULL OR terminal_at >= 0)'],
    ] as const
    const alter = additions
      .filter(([column]) => !hasColumn(database, 'delivery_preference_projection_outbox', column))
      .map(([column, definition]) => `
        ALTER TABLE delivery_preference_projection_outbox
        ADD COLUMN ${column} ${definition};
      `)
      .join('')
  database.exec(`
    ${alter}
    DROP INDEX IF EXISTS delivery_preference_projection_due;
    CREATE INDEX delivery_preference_projection_due
      ON delivery_preference_projection_outbox(
        terminal_at, lane_kind, status, next_attempt_at, updated_at, batch_key
      );
    CREATE INDEX IF NOT EXISTS delivery_preference_projection_lane
      ON delivery_preference_projection_outbox(
        terminal_at, lane_epoch, lane_workspace, lane_preset,
        lane_principal_record_id, lane_principal_version, admission_sequence,
        created_at, batch_key
      );
    PRAGMA user_version = 14;
  `)
}

function migrateObserved(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = row.user_version
  if (version > deliverySchemaVersion) {
    throw new DeliveryDatabaseError(
      'schema-too-new',
      `delivery schema ${version} is newer than supported schema ${deliverySchemaVersion}`,
    )
  }
  if (version === deliverySchemaVersion) return
  if (version === 1) {
    database.exec(`
      ALTER TABLE delivery_attachments ADD COLUMN resource_kind TEXT;
      ALTER TABLE delivery_attachments ADD COLUMN provider_ref TEXT;
      ALTER TABLE delivery_attachments ADD COLUMN file_name TEXT;
      PRAGMA user_version = 2;
    `)
    version = 2
  }
  if (version === 2) {
    database.exec(`
      CREATE TABLE conversation_model_selections (
        conversation_hash TEXT PRIMARY KEY,
        conversation_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1)
      ) STRICT;
      PRAGMA user_version = 4;
    `)
    version = 4
  }
  if (version === 3) {
    database.exec(`
      ALTER TABLE conversation_model_selections ADD COLUMN reasoning_effort TEXT;
      PRAGMA user_version = 4;
    `)
    version = 4
  }
  if (version === 4) {
    database.exec(`
      ${modelPickerStateSchema}
      PRAGMA user_version = 5;
    `)
    version = 5
  }
  if (version === 5) {
    database.exec(`
      ${approvalDispatchCursorSchema}
      PRAGMA user_version = 6;
    `)
    version = 6
  }
  if (version === 6) {
    database.exec(`
      CREATE TABLE delivery_attachments_v7 (
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('inbox', 'outbox')),
        owner_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL,
        spool_ref TEXT,
        resource_kind TEXT,
        provider_ref TEXT,
        file_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('metadata', 'quarantined', 'ready', 'expired')),
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO delivery_attachments_v7 (
        id, owner_kind, owner_id, ordinal, media_type, size_bytes, sha256, spool_ref,
        resource_kind, provider_ref, file_name, status, expires_at, created_at
      )
      SELECT attachment.id, attachment.owner_kind, attachment.owner_id,
        ROW_NUMBER() OVER (
          PARTITION BY attachment.owner_kind, attachment.owner_id
          ORDER BY attachment.rowid
        ) - 1,
        attachment.media_type, attachment.size_bytes, attachment.sha256, attachment.spool_ref,
        attachment.resource_kind, attachment.provider_ref, attachment.file_name, attachment.status,
        attachment.expires_at, attachment.created_at
      FROM delivery_attachments AS attachment;
      DROP TABLE delivery_attachments;
      ALTER TABLE delivery_attachments_v7 RENAME TO delivery_attachments;
      CREATE UNIQUE INDEX delivery_attachment_owner_ordinal
        ON delivery_attachments(owner_kind, owner_id, ordinal);
      PRAGMA user_version = 7;
    `)
    version = 7
  }
  if (version === 7) {
    database.exec(`
      ${deliveryInstanceSchema}
      PRAGMA user_version = 8;
    `)
    version = 8
  }
  if (version === 8) {
    // v8 represented an operator cancel only by overwriting failure_code. A
    // plain table creation would revive those terminal attempts as actionable
    // and allow an old ambiguous send to be retried after upgrade. Preserve
    // the lost decision as an immutable legacy receipt before publishing v9.
    const hasInbox = hasTable(database, 'inbox_messages')
    const hasOutbox = hasTable(database, 'outbox_messages')
    const hasInboxAttempts = hasTable(database, 'inbox_attempts')
    const hasOutboxAttempts = hasTable(database, 'outbox_attempts')
    const inboxOriginalFailure = hasInboxAttempts ? `COALESCE((
          SELECT attempt.failure_code FROM inbox_attempts AS attempt
          WHERE attempt.inbox_id = message.id
            AND attempt.attempt_number = message.attempt_count
            AND attempt.failure_code IS NOT NULL
          ORDER BY attempt.rowid DESC LIMIT 1
        ), 'legacy-unknown')` : `'legacy-unknown'`
    const outboxOriginalFailure = hasOutboxAttempts ? `COALESCE((
          SELECT attempt.failure_code FROM outbox_attempts AS attempt
          WHERE attempt.outbox_id = message.id
            AND attempt.attempt_number = message.attempt_count
            AND attempt.failure_code IS NOT NULL
          ORDER BY attempt.rowid DESC LIMIT 1
        ), 'legacy-unknown')` : `'legacy-unknown'`
    const inboxBackfill = hasInbox ? `
      INSERT INTO dead_letter_resolutions (
        kind, message_id, attempt_count, receipt_version, resolution, original_status,
        original_failure_code, operator_id, created_at
      )
      SELECT 'inbox', message.id, message.attempt_count, 1, 'cancel', 'dead_letter',
        ${inboxOriginalFailure}, 'legacy-v8-migration', message.updated_at
      FROM inbox_messages AS message
      WHERE message.status = 'dead_letter' AND message.failure_code = 'operator-cancelled';
    ` : ''
    const outboxBackfill = hasOutbox ? `
      INSERT INTO dead_letter_resolutions (
        kind, message_id, attempt_count, receipt_version, resolution, original_status,
        original_failure_code, operator_id, created_at
      )
      SELECT 'outbox', message.id, message.attempt_count, 1, 'cancel',
        CASE WHEN ${hasOutboxAttempts ? `EXISTS (
          SELECT 1 FROM outbox_attempts AS attempt
          WHERE attempt.outbox_id = message.id
            AND attempt.attempt_number = message.attempt_count
            AND attempt.status = 'unknown_after_send'
        )` : '0'} THEN 'unknown_after_send' ELSE 'dead' END,
        ${outboxOriginalFailure}, 'legacy-v8-migration', message.updated_at
      FROM outbox_messages AS message
      WHERE message.status = 'dead' AND message.failure_code = 'operator-cancelled';

      UPDATE outbox_messages AS message
      SET status = 'unknown_after_send', failure_code = 'operator-cancelled-unknown'
      WHERE message.status = 'dead' AND message.failure_code = 'operator-cancelled'
        AND EXISTS (
          SELECT 1 FROM dead_letter_resolutions AS resolution
          WHERE resolution.kind = 'outbox' AND resolution.message_id = message.id
            AND resolution.attempt_count = message.attempt_count
            AND resolution.original_status = 'unknown_after_send'
        );
    ` : ''
    database.exec(`
      ${deadLetterResolutionSchema}
      ${inboxBackfill}
      ${outboxBackfill}
      ${hasInbox && hasOutbox ? deadLetterResolutionCompatibilitySchema : ''}
      PRAGMA user_version = 9;
    `)
    version = 9
  }
  if (version === 9) {
    database.exec(`
      ${deliveryPresentationSchema}
      PRAGMA user_version = 10;
    `)
    version = 10
  }
  if (version === 10) {
    database.exec(`
      ${workflowTraceSchema}
      PRAGMA user_version = 11;
    `)
    version = 11
  }
  if (version === 11) {
    database.exec(`
      ${preferenceProjectionSchema}
      PRAGMA user_version = 12;
    `)
    version = 12
  }
  if (version === 12) {
    database.exec(hasTable(database, 'inbox_messages')
      && hasTable(database, 'delivery_instance')
      ? `
        ${inboxAdmissionSchema}
        PRAGMA user_version = 13;
      `
      : `
        PRAGMA user_version = 13;
      `)
    version = 13
  }
  if (version === 13) {
    migratePreferenceProjectionLane(database)
    version = 14
  }
  if (version === 14) {
    database.exec(`
      ${workflowVerifiedTaskFeedbackSchema}
      PRAGMA user_version = 15;
    `)
    version = 15
  }
  if (version === 15) {
    database.exec(`
      ${approvalOutboxRouteSchema}
      PRAGMA user_version = 16;
    `)
    assertApprovalOutboxRouteSchema(database)
    version = 16
  }
  if (version === deliverySchemaVersion) return
  database.exec(`
    ${deliveryInstanceSchema}
    CREATE TABLE delivery_principals (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      principal_json TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'linked')),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      linked_to_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      FOREIGN KEY (linked_to_id) REFERENCES delivery_principals(id)
    ) STRICT;

    CREATE TABLE pairing_challenges (
      id TEXT PRIMARY KEY,
      principal_hash TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'locked')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX pairing_active ON pairing_challenges(principal_hash, status, expires_at);

    CREATE TABLE conversation_bindings (
      id TEXT PRIMARY KEY,
      conversation_hash TEXT NOT NULL,
      conversation_json TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      principal_json TEXT NOT NULL,
      workspace TEXT NOT NULL,
      agent_preset TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      policy_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      UNIQUE (conversation_hash, generation),
      FOREIGN KEY (principal_id) REFERENCES delivery_principals(id)
    ) STRICT;
    CREATE UNIQUE INDEX binding_one_active ON conversation_bindings(conversation_hash) WHERE status = 'active';

    CREATE TABLE conversation_model_selections (
      conversation_hash TEXT PRIMARY KEY,
      conversation_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_effort TEXT,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1)
    ) STRICT;

    CREATE TABLE inbox_messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      account TEXT NOT NULL,
      event_id TEXT NOT NULL,
      envelope_hash TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('received', 'authorized', 'queued', 'claimed', 'processed', 'retry_wait', 'dead_letter')),
      binding_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER,
      claimed_by TEXT,
      fencing_token INTEGER,
      lease_until INTEGER,
      failure_code TEXT,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (channel, account, event_id),
      FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id)
    ) STRICT;
    CREATE INDEX inbox_claim ON inbox_messages(status, next_attempt_at, received_at, id);

    CREATE TABLE inbox_attempts (
      id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'processed', 'retry_wait', 'dead_letter', 'lost')),
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE (inbox_id, attempt_number),
      FOREIGN KEY (inbox_id) REFERENCES inbox_messages(id)
    ) STRICT;

    CREATE TABLE outbox_messages (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      binding_id TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      channel TEXT NOT NULL,
      account TEXT NOT NULL,
      lane_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'attempting', 'accepted', 'delivered', 'read', 'retry_wait', 'dead', 'unknown_after_send')),
      provider_message_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER,
      claimed_by TEXT,
      fencing_token INTEGER,
      lease_until INTEGER,
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (binding_id) REFERENCES conversation_bindings(id)
    ) STRICT;
    CREATE INDEX outbox_claim ON outbox_messages(status, next_attempt_at, created_at, id);
    CREATE INDEX outbox_lane ON outbox_messages(lane_hash, created_at, id);
    CREATE UNIQUE INDEX outbox_provider_message ON outbox_messages(channel, account, provider_message_id)
      WHERE provider_message_id IS NOT NULL;

    CREATE TABLE outbox_attempts (
      id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('send', 'reconcile')),
      status TEXT NOT NULL CHECK (status IN ('attempting', 'accepted', 'retry_wait', 'dead', 'unknown_after_send', 'reconciled')),
      provider_message_id TEXT,
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE (outbox_id, attempt_number),
      FOREIGN KEY (outbox_id) REFERENCES outbox_messages(id)
    ) STRICT;

    CREATE TABLE delivery_receipts (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      account TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'delivered', 'read')),
      receipt_hash TEXT NOT NULL UNIQUE,
      receipt_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (channel, account, provider_message_id, status)
    ) STRICT;

    CREATE TABLE delivery_attachments (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('inbox', 'outbox')),
      owner_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      sha256 TEXT NOT NULL,
      spool_ref TEXT,
      resource_kind TEXT,
      provider_ref TEXT,
      file_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('metadata', 'quarantined', 'ready', 'expired')),
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX delivery_attachment_owner_ordinal
      ON delivery_attachments(owner_kind, owner_id, ordinal);

    CREATE TABLE approval_settlements (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    ${modelPickerStateSchema}

    CREATE TABLE delivery_duty_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
      lease_until INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    ${approvalDispatchCursorSchema}

    ${approvalOutboxRouteSchema}

    ${deadLetterResolutionSchema}

    ${deadLetterResolutionCompatibilitySchema}

    ${deliveryPresentationSchema}

    ${workflowTraceSchema}

    ${workflowVerifiedTaskFeedbackSchema}

    ${preferenceProjectionSchema}

    ${inboxAdmissionSchema}

    PRAGMA user_version = 16;
  `)
}

/** Serialize the complete forward migration chain across every Host process. */
function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    migrateObserved(database)
    assertApprovalOutboxRouteSchema(database)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  }
}

export function openDeliveryDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) {
    throw new DeliveryDatabaseError('invalid-path', 'delivery database path must be absolute')
  }
  if (path !== ':memory:') {
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA synchronous = FULL')
    migrate(database)
    if (path !== ':memory:') {
      database.exec('PRAGMA journal_mode = WAL')
      chmodSync(path, 0o600)
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
