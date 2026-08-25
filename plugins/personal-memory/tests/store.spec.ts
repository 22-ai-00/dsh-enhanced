import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  hashMemoryMutation,
  MemoryStore,
  MemoryStoreError,
  missingPolicyProposalId,
} from '../src/store.ts'
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
  test('canonicalizes dispatch field order in synthetic conflict fingerprints', () => {
    const canonical = {
      sourceId: 'dsh-enhanced-personal-memory',
      bindingId: 'binding-owner-dm',
      workspace: '/work/alpha',
      principal: 'owner:lark:123',
    }
    const reordered = {
      principal: canonical.principal,
      workspace: canonical.workspace,
      bindingId: canonical.bindingId,
      sourceId: canonical.sourceId,
    }

    expect(missingPolicyProposalId('memory-proposal', 60_000, reordered))
      .toBe(missingPolicyProposalId('memory-proposal', 60_000, canonical))
  })

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

    expect(version.user_version).toBe(2)
    expect(tables.map(table => table.name)).toEqual([
      'memory_audit',
      'memory_proposal_intents',
      'memory_proposals',
      'memory_records',
      'memory_tokens',
      'schema_meta',
    ])
  })

  test('migrates a v1 database without destructive recreation', async () => {
    const path = await temporaryPath()
    await mkdir(join(path, '..'), { recursive: true })
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta(key, value) VALUES ('schema-version', '1');

      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK (owner IN ('user', 'agent')),
        scope TEXT NOT NULL CHECK (scope IN ('user-global', 'workspace')),
        workspace TEXT NOT NULL,
        agent_preset TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'instruction', 'experience')),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('private', 'sensitive')),
        trust TEXT NOT NULL CHECK (trust IN ('user-confirmed', 'agent-observed', 'external')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        provenance_json TEXT NOT NULL,
        supersedes TEXT,
        expires_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1)
      ) STRICT;
      CREATE INDEX memory_records_scope
        ON memory_records(owner, scope, workspace, agent_preset, status, updated_at DESC);
      CREATE INDEX memory_records_hash
        ON memory_records(owner, scope, workspace, agent_preset, content_hash, status);

      CREATE TABLE memory_tokens (
        memory_id TEXT NOT NULL,
        token TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        PRIMARY KEY (memory_id, token),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX memory_tokens_token ON memory_tokens(token, memory_id);

      CREATE TABLE memory_proposals (
        id TEXT PRIMARY KEY,
        policy_proposal_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        principal TEXT NOT NULL,
        mutation_hash TEXT NOT NULL,
        mutation_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'conflicted')),
        expires_at INTEGER NOT NULL,
        result_memory_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;

      CREATE TABLE memory_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        mutation_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        result_version INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE legacy_marker (value TEXT NOT NULL) STRICT;
      INSERT INTO legacy_marker(value) VALUES ('preserved');
      PRAGMA user_version = 1;
    `)

    const mutation = {
      op: 'remove' as const,
      identity: userGlobal,
      id: 'legacy-memory',
      expectedVersion: 1,
    }
    database.prepare(`
      INSERT INTO memory_records(
        id, owner, scope, workspace, agent_preset, kind, content, content_hash,
        sensitivity, trust, confidence, provenance_json, supersedes, expires_at,
        status, created_at, updated_at, version
      ) VALUES (?, 'user', 'user-global', '', '', 'fact', ?, ?, 'private',
        'user-confirmed', 1, ?, NULL, NULL, 'active', 1000, 1000, 1)
    `).run(
      'legacy-memory',
      'preserve me through migration',
      'b47cbade897585feb719c0b5508c17889683d8c75b5e29b9d8778c33f0c5f38d',
      JSON.stringify({ source: 'user', observedAt: 1000 }),
    )
    database.prepare(`
      INSERT INTO memory_proposals(
        id, policy_proposal_id, idempotency_key, requester, principal,
        mutation_hash, mutation_json, status, expires_at, result_memory_id,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 1000, 1000, 1)
    `).run(
      'legacy-proposal',
      'legacy-policy-proposal',
      'legacy-idempotency',
      'legacy-requester',
      'legacy-principal',
      hashMemoryMutation(mutation),
      JSON.stringify(mutation),
      100_000,
    )
    database.close()

    const store = new MemoryStore({ path, now: () => 2_000 })
    expect(store.get(userGlobal, 'legacy-memory')?.content).toBe('preserve me through migration')
    expect(store.getProposal('legacy-proposal')).toEqual(expect.objectContaining({
      proposalId: 'legacy-proposal',
      policyProposalId: 'legacy-policy-proposal',
      status: 'pending',
      mutation,
      version: 1,
    }))
    const settled = store.settleProposal({
      proposalId: 'legacy-proposal',
      policyStatus: 'approved',
      policyVersion: 2,
    })
    expect(settled.proposal).toEqual(expect.objectContaining({ status: 'approved', version: 2 }))
    expect(store.get(userGlobal, 'legacy-memory')).toBeUndefined()
    expect(store.list(userGlobal, { includeRemoved: true })).toEqual([
      expect.objectContaining({ id: 'legacy-memory', status: 'removed', version: 2 }),
    ])
    store.close()

    const migrated = new DatabaseSync(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect(migrated.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema-version'))
      .toEqual({ value: '2' })
    expect(migrated.prepare('SELECT value FROM legacy_marker').get()).toEqual({ value: 'preserved' })
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_proposal_intents'
    `).get()).toEqual({ name: 'memory_proposal_intents' })
    migrated.close()
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
