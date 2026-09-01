import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { deliverySchemaVersion, DeliveryDatabaseError, openDeliveryDatabase } from '../src/sqlite.ts'

const roots: string[] = []

async function openDeliveryConcurrently(path: string, start: string, count = 12): Promise<void> {
  const moduleUrl = new URL('../src/sqlite.ts', import.meta.url).href
  const childSource = `
    import { existsSync } from 'node:fs';
    while (!existsSync(${JSON.stringify(start)})) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const { openDeliveryDatabase } = await import(${JSON.stringify(moduleUrl)});
    const database = openDeliveryDatabase(${JSON.stringify(path)});
    database.close();
  `
  const openChild = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--no-warnings', '--experimental-transform-types',
      '--input-type=module', '--eval', childSource,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`concurrent Delivery opener exited ${code}: ${stderr}`))
    })
  })
  const openers = Array.from({ length: count }, () => openChild())
  await writeFile(start, 'go', { mode: 0o600 })
  await Promise.all(openers)
}

const deliveryAttachmentsV6Schema = `
  CREATE TABLE delivery_attachments (
    id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('inbox', 'outbox')),
    owner_id TEXT NOT NULL,
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
`

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('delivery SQLite boundary', () => {
  test('creates a private hardened strict schema with all independent ledgers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-db-'))
    roots.push(root)
    await chmod(root, 0o755)
    const path = join(root, 'nested', 'delivery.sqlite')
    const database = openDeliveryDatabase(path)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(database.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map(row => row.name)
    expect(tables).toEqual(expect.arrayContaining([
      'conversation_bindings', 'delivery_attachments', 'delivery_duty_lease', 'delivery_principals',
      'delivery_receipts', 'conversation_model_epochs', 'conversation_model_selections',
      'inbox_attempts', 'inbox_messages', 'outbox_attempts', 'outbox_messages',
      'model_picker_states', 'model_selection_settlements', 'pairing_challenges',
      'approval_dispatch_cursor', 'dead_letter_resolutions',
      'approval_outbox_routes',
      'delivery_preference_projection_outbox',
      'delivery_inbox_admission_clock', 'delivery_inbox_admissions',
    ]))
    const modelColumns = (database.prepare('PRAGMA table_info(conversation_model_selections)').all() as { name: string }[])
      .map(row => row.name)
    expect(modelColumns).toContain('reasoning_effort')
    const attachmentColumns = (database.prepare('PRAGMA table_info(delivery_attachments)').all() as {
      name: string
      notnull: number
    }[])
    expect(attachmentColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ordinal', notnull: 1 }),
    ]))
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'delivery_attachment_owner_ordinal'").get())
      .toEqual({ name: 'delivery_attachment_owner_ordinal' })
    const projectionColumns = (database.prepare(`
      PRAGMA table_info(delivery_preference_projection_outbox)
    `).all() as Array<{ name: string }>).map(column => column.name)
    expect(projectionColumns).toEqual(expect.arrayContaining([
      'lane_kind', 'lane_epoch', 'lane_workspace', 'lane_preset',
      'lane_principal_record_id', 'lane_principal_version', 'admission_sequence', 'terminal_at',
    ]))
    database.close()
    expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('backfills stable Inbox admission cursors when migrating schema v12', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v12-admission-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = openDeliveryDatabase(path)
    raw.exec('DROP TRIGGER delivery_inbox_admission_after_insert')
    raw.exec('DROP TABLE delivery_inbox_admissions')
    raw.exec('DROP TABLE delivery_inbox_admission_clock')
    raw.prepare(`
      INSERT INTO inbox_messages(
        id, channel, account, event_id, envelope_hash, envelope_json, status,
        attempt_count, received_at, updated_at
      ) VALUES (?, 'lark', 'bot', ?, ?, ?, 'received', 0, 10, 10)
    `).run('inbox-old-1', 'event-old-1', 'a'.repeat(64), JSON.stringify({ legacy: 1 }))
    raw.prepare(`
      INSERT INTO inbox_messages(
        id, channel, account, event_id, envelope_hash, envelope_json, status,
        attempt_count, received_at, updated_at
      ) VALUES (?, 'lark', 'bot', ?, ?, ?, 'received', 0, 10, 10)
    `).run('inbox-old-2', 'event-old-2', 'b'.repeat(64), JSON.stringify({ legacy: 2 }))
    raw.exec('PRAGMA user_version = 12')
    raw.close()

    const migrated = openDeliveryDatabase(path)
    const rows = migrated.prepare(`
      SELECT inbox_id, epoch, admission_sequence
      FROM delivery_inbox_admissions ORDER BY admission_sequence
    `).all() as Array<{ inbox_id: string; epoch: string; admission_sequence: number }>
    expect(rows).toEqual([
      { inbox_id: 'inbox-old-1', epoch: expect.stringMatching(/^[0-9a-f]{32}$/u), admission_sequence: 1 },
      { inbox_id: 'inbox-old-2', epoch: expect.stringMatching(/^[0-9a-f]{32}$/u), admission_sequence: 2 },
    ])
    migrated.close()
  })

  test('migrates a live v13 preference outbox to unclassified fail-closed lanes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v13-preference-lane-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX delivery_preference_projection_due
        ON delivery_preference_projection_outbox(status, next_attempt_at, updated_at, batch_key);
      INSERT INTO delivery_preference_projection_outbox(
        batch_key, payload_digest, events_json, status, attempt_count,
        next_attempt_at, failure_code, created_at, updated_at
      ) VALUES ('legacy-batch', '${'a'.repeat(64)}', '[{"legacy":true}]',
        'retry_wait', 1, 200, 'legacy-temporary', 100, 100);
      PRAGMA user_version = 13;
    `)
    raw.close()

    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(migrated.prepare(`
      SELECT lane_kind, lane_epoch, admission_sequence, terminal_at
      FROM delivery_preference_projection_outbox WHERE batch_key = 'legacy-batch'
    `).get()).toEqual({
      lane_kind: 'unclassified',
      lane_epoch: null,
      admission_sequence: null,
      terminal_at: null,
    })
    migrated.close()
  })

  test('adds the immutable approval route receipt ledger when migrating schema v15', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v15-approval-route-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = openDeliveryDatabase(path)
    raw.exec(`
      DROP INDEX approval_outbox_route_binding;
      DROP TABLE approval_outbox_routes;
      PRAGMA user_version = 15;
    `)
    raw.close()

    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect((migrated.prepare('PRAGMA table_info(approval_outbox_routes)').all() as Array<{
      name: string
    }>).map(column => column.name)).toEqual([
      'outbox_id', 'route_version', 'source_id', 'binding_id', 'binding_version',
      'binding_generation', 'workspace', 'principal', 'principal_record_id', 'principal_version',
    ])
    expect(() => migrated.prepare(`
      INSERT INTO approval_outbox_routes(
        outbox_id, route_version, source_id, binding_id, binding_version, binding_generation,
        workspace, principal, principal_record_id, principal_version
      ) VALUES ('missing', 1, 'source', 'binding', 1, 1, '/work/alpha', 'owner', 'principal', 1)
    `).run()).toThrow()
    migrated.close()
  })

  test('serializes concurrent v13 to v14 openers before computing ALTER columns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v13-concurrent-open-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const start = join(root, 'start')
    const raw = new DatabaseSync(path)
    raw.exec(`
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX delivery_preference_projection_due
        ON delivery_preference_projection_outbox(status, next_attempt_at, updated_at, batch_key);
      PRAGMA user_version = 13;
    `)
    raw.close()
    await openDeliveryConcurrently(path, start)

    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    const columns = (migrated.prepare(`
      PRAGMA table_info(delivery_preference_projection_outbox)
    `).all() as Array<{ name: string }>).map(column => column.name)
    expect(columns).toEqual(expect.arrayContaining([
      'lane_kind', 'lane_epoch', 'lane_workspace', 'lane_preset',
      'lane_principal_record_id', 'lane_principal_version', 'admission_sequence', 'terminal_at',
    ]))
    migrated.close()
  })

  test('converges concurrent openers from the published v8 schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v8-concurrent-open-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const start = join(root, 'start')
    openDeliveryDatabase(path).close()
    const raw = new DatabaseSync(path)
    raw.exec(`
      DROP TRIGGER IF EXISTS delivery_inbox_admission_after_insert;
      DROP TABLE IF EXISTS delivery_inbox_admissions;
      DROP TABLE IF EXISTS delivery_inbox_admission_clock;
      DROP TABLE IF EXISTS delivery_preference_projection_outbox;
      DROP TABLE IF EXISTS trusted_delivery_evaluation_outbox;
      DROP TABLE IF EXISTS workflow_trace_commands;
      DROP TABLE IF EXISTS workflow_trace_outbox;
      DROP TABLE IF EXISTS workflow_trace_current;
      DROP TABLE IF EXISTS workflow_trace_revisions;
      DROP TABLE IF EXISTS workflow_template_registry;
      DROP TABLE IF EXISTS workflow_trace_source;
      DROP TABLE IF EXISTS delivery_presentations;
      DROP TRIGGER IF EXISTS dead_letter_inbox_resolution_fence;
      DROP TRIGGER IF EXISTS dead_letter_outbox_resolution_fence;
      DROP TRIGGER IF EXISTS dead_letter_outbox_cancelled_unknown_fence;
      DROP INDEX IF EXISTS dead_letter_resolution_projection;
      DROP TABLE IF EXISTS dead_letter_resolutions;
      PRAGMA user_version = 8;
    `)
    raw.close()

    await openDeliveryConcurrently(path, start)

    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    const tables = (migrated.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual(expect.arrayContaining([
      'dead_letter_resolutions', 'delivery_presentations',
      'workflow_trace_source', 'delivery_preference_projection_outbox',
      'delivery_inbox_admissions',
    ]))
    migrated.close()
  })

  test('rejects relative paths and schemas written by a newer implementation', async () => {
    expect(() => openDeliveryDatabase('state.sqlite')).toThrowError(
      expect.objectContaining<Partial<DeliveryDatabaseError>>({ code: 'invalid-path' }),
    )
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-new-schema-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA user_version = ${deliverySchemaVersion + 1}`)
    raw.close()
    expect(() => openDeliveryDatabase(path)).toThrowError(
      expect.objectContaining<Partial<DeliveryDatabaseError>>({ code: 'schema-too-new' }),
    )
  })

  test('migrates the previous schema forward without replacing its existing tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-old-schema-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE existing_delivery_state (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO existing_delivery_state (id) VALUES ('kept');
      ${deliveryAttachmentsV6Schema}
      CREATE TABLE conversation_model_selections (
        conversation_hash TEXT PRIMARY KEY,
        conversation_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1)
      ) STRICT;
      PRAGMA user_version = 3;
    `)
    raw.close()
    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(migrated.prepare('SELECT id FROM existing_delivery_state').get()).toEqual({ id: 'kept' })
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_model_selections'").get())
      .toEqual({ name: 'conversation_model_selections' })
    expect((migrated.prepare('PRAGMA table_info(conversation_model_selections)').all() as { name: string }[])
      .map(row => row.name)).toContain('reasoning_effort')
    migrated.close()
  })

  test('adds durable model-picker state when migrating schema v4', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v4-schema-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE existing_delivery_state (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO existing_delivery_state (id) VALUES ('kept');
      ${deliveryAttachmentsV6Schema}
      PRAGMA user_version = 4;
    `)
    raw.close()

    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(migrated.prepare('SELECT id FROM existing_delivery_state').get()).toEqual({ id: 'kept' })
    const tables = (migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(row => row.name)
    expect(tables).toEqual(expect.arrayContaining([
      'conversation_model_epochs', 'model_picker_states', 'model_selection_settlements',
    ]))
    migrated.close()
  })

  test('adds the durable approval dispatch cursor when migrating schema v5', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v5-schema-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`
      ${deliveryAttachmentsV6Schema}
      PRAGMA user_version = 5;
    `)
    raw.close()

    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_dispatch_cursor'").get())
      .toEqual({ name: 'approval_dispatch_cursor' })
    migrated.close()
  })

  test('migrates v6 attachments to stable owner-scoped ordinals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v6-schema-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`
      ${deliveryAttachmentsV6Schema}
      INSERT INTO delivery_attachments (
        id, owner_kind, owner_id, media_type, size_bytes, sha256, resource_kind,
        provider_ref, status, created_at
      ) VALUES
        ('a-first', 'inbox', 'owner-a', '', 0, 'a1', 'image', 'image-a-1', 'metadata', 1),
        ('b-first', 'inbox', 'owner-b', '', 0, 'b1', 'image', 'image-b-1', 'metadata', 1),
        ('a-second', 'inbox', 'owner-a', '', 0, 'a2', 'image', 'image-a-2', 'metadata', 1),
        ('b-second', 'inbox', 'owner-b', '', 0, 'b2', 'image', 'image-b-2', 'metadata', 1);
      PRAGMA user_version = 6;
    `)
    raw.close()

    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(migrated.prepare(`
      SELECT owner_id, provider_ref, ordinal FROM delivery_attachments
      ORDER BY owner_id, ordinal
    `).all()).toEqual([
      { owner_id: 'owner-a', provider_ref: 'image-a-1', ordinal: 0 },
      { owner_id: 'owner-a', provider_ref: 'image-a-2', ordinal: 1 },
      { owner_id: 'owner-b', provider_ref: 'image-b-1', ordinal: 0 },
      { owner_id: 'owner-b', provider_ref: 'image-b-2', ordinal: 1 },
    ])
    expect(() => migrated.prepare(`
      INSERT INTO delivery_attachments (
        id, owner_kind, owner_id, ordinal, media_type, size_bytes, sha256,
        resource_kind, provider_ref, status, created_at
      ) VALUES ('duplicate', 'inbox', 'owner-a', 1, '', 0, 'dup', 'image', 'dup', 'metadata', 1)
    `).run()).toThrow()
    expect(() => migrated.prepare(`
      INSERT INTO delivery_attachments (
        id, owner_kind, owner_id, ordinal, media_type, size_bytes, sha256,
        resource_kind, provider_ref, status, created_at
      ) VALUES ('other-owner-kind', 'outbox', 'owner-a', 1, '', 0, 'ok', 'image', 'ok', 'metadata', 1)
    `).run()).not.toThrow()
    migrated.close()
  })

  test('migrates a large interleaved v6 attachment ledger without quadratic scans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v6-linear-schema-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(deliveryAttachmentsV6Schema)
    const insert = raw.prepare(`
      INSERT INTO delivery_attachments (
        id, owner_kind, owner_id, media_type, size_bytes, sha256, resource_kind,
        provider_ref, status, created_at
      ) VALUES (?, 'inbox', ?, '', 0, ?, 'image', ?, 'metadata', 1)
    `)
    raw.exec('BEGIN')
    for (let index = 0; index < 10_000; index += 1) {
      const owner = `owner-${index % 100}`
      insert.run(`attachment-${index}`, owner, `sha-${index}`, `image-${index}`)
    }
    raw.exec('COMMIT')
    const ordinalPlan = raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT ROW_NUMBER() OVER (
        PARTITION BY attachment.owner_kind, attachment.owner_id
        ORDER BY attachment.rowid
      ) - 1
      FROM delivery_attachments AS attachment
    `).all() as { detail: string }[]
    expect(ordinalPlan.map(row => row.detail).join('\n')).not.toMatch(/CORRELATED/u)
    raw.exec('PRAGMA user_version = 6')
    raw.close()

    const startedAt = performance.now()
    const migrated = openDeliveryDatabase(path)
    const elapsedMs = performance.now() - startedAt
    // The query-plan assertion guards the quadratic regression. This wider
    // wall-clock ceiling only catches a runaway migration without coupling the
    // suite to runner contention from the other SQLite-heavy test workers.
    expect(elapsedMs).toBeLessThan(5_000)
    expect(migrated.prepare(`
      SELECT ordinal FROM delivery_attachments
      WHERE owner_kind = 'inbox' AND owner_id = 'owner-99'
      ORDER BY ordinal DESC LIMIT 1
    `).get()).toEqual({ ordinal: 99 })
    migrated.close()
  })

  test('adds the immutable operator-resolution receipt ledger when migrating schema v8', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-v8-schema-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE existing_delivery_state (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO existing_delivery_state (id) VALUES ('kept');
      PRAGMA user_version = 8;
    `)
    raw.close()

    const migrated = openDeliveryDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(migrated.prepare('SELECT id FROM existing_delivery_state').get()).toEqual({ id: 'kept' })
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dead_letter_resolutions'
    `).get()).toEqual({ name: 'dead_letter_resolutions' })
    expect((migrated.prepare('PRAGMA table_info(dead_letter_resolutions)').all() as {
      name: string
      pk: number
    }[])).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'kind', pk: 1 }),
      expect.objectContaining({ name: 'message_id', pk: 2 }),
      expect.objectContaining({ name: 'attempt_count', pk: 3 }),
      expect.objectContaining({ name: 'receipt_version' }),
    ]))
    migrated.close()
  })
})
