import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryStore, MemoryStoreError } from '../src/store.ts'
import type { MemoryEntryInput, MemoryIdentity } from '../src/types.ts'

const temporaryRoots: string[] = []

async function temporaryPath(name = 'memory.sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-store-'))
  temporaryRoots.push(root)
  return join(root, 'private', name)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const userGlobal: MemoryIdentity = { owner: 'user', scope: 'user-global' }
const userWorkspace: MemoryIdentity = {
  owner: 'user',
  scope: 'workspace',
  workspace: '/work/alpha',
}
const agentGlobal: MemoryIdentity = {
  owner: 'agent',
  scope: 'user-global',
  agentPreset: 'primary',
}
const agentWorkspace: MemoryIdentity = {
  owner: 'agent',
  scope: 'workspace',
  workspace: '/work/alpha',
  agentPreset: 'primary',
}

function entry(content: string, overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    kind: 'fact',
    content,
    sensitivity: 'private',
    trust: 'user-confirmed',
    confidence: 1,
    provenance: { source: 'user', observedAt: 10_000 },
    ...overrides,
  }
}

describe('personal memory store', () => {
  test('creates a private forward-versioned SQLite schema', async () => {
    const path = await temporaryPath()
    new MemoryStore({ path }).close()

    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const database = new DatabaseSync(path)
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number }
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as { name: string }[]
    database.close()

    expect(version.user_version).toBe(1)
    expect(tables.map(table => table.name)).toEqual([
      'memory_audit',
      'memory_proposals',
      'memory_records',
      'memory_tokens',
      'schema_meta',
    ])
  })

  test('keeps all four owner and scope combinations isolated', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), now: () => 10_000 })
    const identities = [userGlobal, userWorkspace, agentGlobal, agentWorkspace]
    for (const [index, identity] of identities.entries()) {
      store.applyApprovedMutation({
        op: 'add',
        idempotencyKey: `add-${index}`,
        identity,
        entry: entry(`memory-${index}`),
      })
    }

    for (const [index, identity] of identities.entries()) {
      expect(store.list(identity).map(record => record.content)).toEqual([`memory-${index}`])
    }
    expect(store.list({ ...agentWorkspace, workspace: '/work/beta' })).toEqual([])
    expect(store.list({ ...agentWorkspace, agentPreset: 'secondary' })).toEqual([])
    store.close()
  })

  test('rejects ambiguous or non-absolute identity scopes', async () => {
    const store = new MemoryStore({ path: await temporaryPath() })
    const invalid: MemoryIdentity[] = [
      { owner: 'agent', scope: 'workspace', workspace: '/work/alpha' },
      { owner: 'user', scope: 'workspace', workspace: 'relative' },
      { owner: 'user', scope: 'user-global', workspace: '/unexpected' },
      { owner: 'agent', scope: 'user-global', agentPreset: '' },
    ]

    for (const identity of invalid) {
      expect(() => store.list(identity))
        .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'invalid-identity' }))
    }
    store.close()
  })

  test('excludes expired and removed records from ordinary reads', async () => {
    let now = 10_000
    const store = new MemoryStore({ path: await temporaryPath(), now: () => now })
    const expiring = store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'expiring',
      identity: userGlobal,
      entry: entry('temporary', { expiresAt: 11_000 }),
    })
    const removed = store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'remove-me',
      identity: userGlobal,
      entry: entry('remove me'),
    })
    store.applyApprovedMutation({
      op: 'remove',
      idempotencyKey: 'remove-me-approved',
      identity: userGlobal,
      id: removed.id,
      expectedVersion: removed.version,
    })
    now = 11_000

    expect(store.get(userGlobal, expiring.id)).toBeUndefined()
    expect(store.get(userGlobal, removed.id)).toBeUndefined()
    expect(store.list(userGlobal)).toEqual([])
    expect(store.list(userGlobal, { includeRemoved: true }).map(record => record.status)).toEqual(['removed'])
    store.close()
  })

  test('applies replace with compare-and-set and records supersession', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), now: () => 20_000 })
    const original = store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'add-editor',
      identity: userGlobal,
      entry: entry('Preferred editor is Vim', { kind: 'preference' }),
    })

    const replaced = store.applyApprovedMutation({
      op: 'replace',
      idempotencyKey: 'replace-editor',
      identity: userGlobal,
      id: original.id,
      expectedVersion: original.version,
      entry: entry('Preferred editor is Helix', {
        kind: 'preference',
        supersedes: original.contentHash,
      }),
    })

    expect(replaced).toMatchObject({
      id: original.id,
      content: 'Preferred editor is Helix',
      version: 2,
      supersedes: original.contentHash,
    })
    expect(() => store.applyApprovedMutation({
      op: 'replace',
      idempotencyKey: 'stale-replace',
      identity: userGlobal,
      id: original.id,
      expectedVersion: 1,
      entry: entry('stale'),
    })).toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'version-conflict' }))
    store.close()
  })

  test('replays mutation idempotency without creating duplicate records', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), now: () => 30_000 })
    const mutation = {
      op: 'add' as const,
      idempotencyKey: 'stable-add',
      identity: userGlobal,
      entry: entry('Stable fact'),
    }

    const created = store.applyApprovedMutation(mutation)
    const replay = store.applyApprovedMutation(mutation)

    expect(replay).toEqual(created)
    expect(store.list(userGlobal)).toHaveLength(1)
    store.close()
  })

  test('rejects oversized content and duplicate active content', async () => {
    const store = new MemoryStore({
      path: await temporaryPath(),
      maxContentBytes: 16,
      now: () => 40_000,
    })
    store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'first',
      identity: userGlobal,
      entry: entry('same fact'),
    })

    expect(() => store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'duplicate',
      identity: userGlobal,
      entry: entry('same fact'),
    })).toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'duplicate-content' }))
    expect(() => store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'oversized',
      identity: userGlobal,
      entry: entry('this content is too large'),
    })).toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'content-too-large' }))
    store.close()
  })

  test('refuses a database created by a newer schema', async () => {
    const path = await temporaryPath()
    await mkdir(join(path, '..'), { recursive: true })
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version = 99')
    database.close()

    expect(() => new MemoryStore({ path }))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'schema-too-new' }))
  })
})
