import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const deliverySchemaVersion = 8

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

function migrate(database: DatabaseSync): void {
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
      BEGIN IMMEDIATE;
      ALTER TABLE delivery_attachments ADD COLUMN resource_kind TEXT;
      ALTER TABLE delivery_attachments ADD COLUMN provider_ref TEXT;
      ALTER TABLE delivery_attachments ADD COLUMN file_name TEXT;
      PRAGMA user_version = 2;
      COMMIT;
    `)
    version = 2
  }
  if (version === 2) {
    database.exec(`
      BEGIN IMMEDIATE;
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
      COMMIT;
    `)
    version = 4
  }
  if (version === 3) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE conversation_model_selections ADD COLUMN reasoning_effort TEXT;
      PRAGMA user_version = 4;
      COMMIT;
    `)
    version = 4
  }
  if (version === 4) {
    database.exec(`
      BEGIN IMMEDIATE;
      ${modelPickerStateSchema}
      PRAGMA user_version = 5;
      COMMIT;
    `)
    version = 5
  }
  if (version === 5) {
    database.exec(`
      BEGIN IMMEDIATE;
      ${approvalDispatchCursorSchema}
      PRAGMA user_version = 6;
      COMMIT;
    `)
    version = 6
  }
  if (version === 6) {
    database.exec(`
      BEGIN IMMEDIATE;
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
      COMMIT;
    `)
    version = 7
  }
  if (version === 7) {
    database.exec(`
      BEGIN IMMEDIATE;
      ${deliveryInstanceSchema}
      PRAGMA user_version = 8;
      COMMIT;
    `)
    return
  }
  database.exec(`
    BEGIN IMMEDIATE;
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

    PRAGMA user_version = 8;
    COMMIT;
  `)
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
