import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { deliverySchemaVersion, DeliveryDatabaseError, openDeliveryDatabase } from '../src/sqlite.ts'

const roots: string[] = []

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
      'delivery_receipts', 'conversation_model_selections', 'inbox_attempts', 'inbox_messages', 'outbox_attempts', 'outbox_messages',
      'pairing_challenges',
    ]))
    const modelColumns = (database.prepare('PRAGMA table_info(conversation_model_selections)').all() as { name: string }[])
      .map(row => row.name)
    expect(modelColumns).toContain('reasoning_effort')
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
})
