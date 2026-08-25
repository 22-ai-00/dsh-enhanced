import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { deliverySchemaVersion, DeliveryDatabaseError, openDeliveryDatabase } from '../src/sqlite.ts'

const roots: string[] = []

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
      'approval_dispatch_cursor',
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
    database.close()
    expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
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
    raw.exec('PRAGMA user_version = 6')
    raw.close()

    const startedAt = performance.now()
    const migrated = openDeliveryDatabase(path)
    const elapsedMs = performance.now() - startedAt
    expect(elapsedMs).toBeLessThan(1_500)
    expect(migrated.prepare(`
      SELECT ordinal FROM delivery_attachments
      WHERE owner_kind = 'inbox' AND owner_id = 'owner-99'
      ORDER BY ordinal DESC LIMIT 1
    `).get()).toEqual({ ordinal: 99 })
    migrated.close()
  })
})
