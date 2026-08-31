import { DatabaseSync } from 'node:sqlite'
import { chmod, link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { withPreferenceMemoryPromotionCancellationDigest } from '@dsh-enhanced/assistant-growth-contract'
import {
  hashMemoryProposalIntent,
  hashMemoryMutation,
  memoryOwnerNamespaceKey,
  memoryPrincipalDigest,
  MemoryStore,
  MemoryStoreError,
  missingPolicyProposalId,
} from '../src/store.ts'
import { openMemoryDatabase } from '../src/sqlite.ts'
import type {
  MemoryEntryInput, MemoryIdentity, MemoryOwnerNamespace, MemoryProposalInput,
} from '../src/types.ts'

const temporaryRoots: string[] = []

async function temporaryPath(name = 'memory.sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-store-'))
  temporaryRoots.push(root)
  return join(root, 'private', name)
}

afterEach(async () => {
  vi.restoreAllMocks()
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
const namespaceA: MemoryOwnerNamespace = {
  mode: 'delivery',
  principalDigest: 'a'.repeat(64),
  principalRecordId: 'principal-a',
  principalVersion: 1,
}
const namespaceB: MemoryOwnerNamespace = {
  mode: 'delivery',
  principalDigest: 'b'.repeat(64),
  principalRecordId: 'principal-b',
  principalVersion: 1,
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
    const database = openMemoryDatabase(path)

    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number }
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as { name: string }[]
    expect(version.user_version).toBe(4)
    expect(tables.map(table => table.name)).toEqual([
      'memory_audit',
      'memory_promotion_cancellations',
      'memory_promotion_compensations',
      'memory_promotion_results',
      'memory_proposal_intents',
      'memory_proposals',
      'memory_records',
      'memory_tokens',
      'schema_meta',
    ])
    for (const table of ['memory_records', 'memory_proposals', 'memory_proposal_intents', 'memory_audit']) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      expect(columns.map(column => column.name)).not.toContain('owner_generation')
    }
    expect((database.prepare('PRAGMA table_info(memory_promotion_results)').all() as Array<{ name: string }>)
      .map(column => column.name)).toContain('owner_generation')
    expect((database.prepare('PRAGMA table_info(memory_promotion_cancellations)').all() as Array<{ name: string }>)
      .map(column => column.name)).toContain('owner_generation')
    expect((database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2)
    expect((database.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete).toBe(1)
    database.exec("INSERT INTO schema_meta(key, value) VALUES ('sidecar-probe', 'written')")
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-shm`)).mode & 0o777).toBe(0o600)
    database.close()
  })

  test('migrates v2 records, proposals, intents, and audit receipts into an unclaimable quarantine', async () => {
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
    database.exec(`
      CREATE INDEX memory_proposals_reconcile
        ON memory_proposals(status, updated_at, id);
      CREATE TABLE memory_proposal_intents (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        principal TEXT NOT NULL,
        mutation_hash TEXT NOT NULL,
        mutation_json TEXT NOT NULL,
        ttl_ms INTEGER NOT NULL CHECK (ttl_ms > 0),
        dispatch_source_id TEXT,
        dispatch_binding_id TEXT,
        dispatch_workspace TEXT,
        dispatch_principal TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX memory_proposal_intents_reconcile
        ON memory_proposal_intents(updated_at, id);
      UPDATE schema_meta SET value = '2' WHERE key = 'schema-version';
      PRAGMA user_version = 2;
    `)
    database.prepare(`
      INSERT INTO memory_proposal_intents(
        id, idempotency_key, requester, principal, mutation_hash, mutation_json, ttl_ms,
        dispatch_source_id, dispatch_binding_id, dispatch_workspace, dispatch_principal,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 60000, NULL, NULL, NULL, NULL, 1000, 1000)
    `).run('legacy-intent', 'legacy-intent-key', 'legacy-requester', 'legacy-principal',
      hashMemoryMutation(mutation), JSON.stringify(mutation))
    database.prepare(`
      INSERT INTO memory_audit(
        idempotency_key, mutation_hash, operation, memory_id, result_version, occurred_at
      ) VALUES (?, ?, 'add', ?, 1, 1000)
    `).run('legacy-audit-key', hashMemoryMutation(mutation), 'legacy-memory')
    database.close()
    await chmod(path, 0o600)

    const store = new MemoryStore({ path, now: () => 2_000 })
    expect(store.get(namespaceA, userGlobal, 'legacy-memory')).toBeUndefined()
    expect(() => store.settleProposal({
      proposalId: 'legacy-proposal',
      policyStatus: 'approved',
      policyVersion: 2,
    })).toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'invalid-identity' }))
    expect(store.list(namespaceA, userGlobal, { includeRemoved: true })).toEqual([])
    expect(store.listProposalIntents(10)).toEqual([])
    store.close()

    const migrated = new DatabaseSync(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect(migrated.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema-version'))
      .toEqual({ value: '4' })
    expect(migrated.prepare('SELECT value FROM legacy_marker').get()).toEqual({ value: 'preserved' })
    expect(migrated.prepare(`
      SELECT namespace_mode, namespace_key FROM memory_records WHERE id = 'legacy-memory'
    `).get()).toEqual({ namespace_mode: 'legacy-quarantine', namespace_key: 'legacy-v2' })
    expect(migrated.prepare(`
      SELECT namespace_mode, status, version FROM memory_proposals WHERE id = 'legacy-proposal'
    `).get()).toEqual({ namespace_mode: 'legacy-quarantine', status: 'conflicted', version: 2 })
    expect(migrated.prepare(`
      SELECT namespace_mode, namespace_key FROM memory_proposal_intents WHERE id = 'legacy-intent'
    `).get()).toEqual({ namespace_mode: 'legacy-quarantine', namespace_key: 'legacy-v2' })
    expect(migrated.prepare(`
      SELECT namespace_mode, namespace_key FROM memory_audit WHERE idempotency_key = 'legacy-audit-key'
    `).get()).toEqual({ namespace_mode: 'legacy-quarantine', namespace_key: 'legacy-v2' })
    migrated.close()
  })

  test('keeps all four owner and scope combinations isolated', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), now: () => 10_000 })
    const identities = [userGlobal, userWorkspace, agentGlobal, agentWorkspace]
    for (const [index, identity] of identities.entries()) {
      store.applyApprovedMutation({
        op: 'add',
        idempotencyKey: `add-${index}`,
        namespace: namespaceA,
        identity,
        entry: entry(`memory-${index}`),
      })
    }

    for (const [index, identity] of identities.entries()) {
      expect(store.list(namespaceA, identity).map(record => record.content)).toEqual([`memory-${index}`])
    }
    expect(store.list(namespaceA, { ...agentWorkspace, workspace: '/work/beta' })).toEqual([])
    expect(store.list(namespaceA, { ...agentWorkspace, agentPreset: 'secondary' })).toEqual([])
    store.close()
  })

  test('scopes records, duplicate detection, and mutation receipts to exact owner lineage', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), now: () => 10_000 })
    const firstA = store.applyApprovedMutation({
      op: 'add', idempotencyKey: 'same-key', namespace: namespaceA, identity: userGlobal, entry: entry('same fact'),
    })
    const firstB = store.applyApprovedMutation({
      op: 'add', idempotencyKey: 'same-key', namespace: namespaceB, identity: userGlobal, entry: entry('same fact'),
    })
    const namespaceA3: MemoryOwnerNamespace = { ...namespaceA, principalVersion: 3 }
    const newA = store.applyApprovedMutation({
      op: 'add', idempotencyKey: 'same-key', namespace: namespaceA3, identity: userGlobal, entry: entry('same fact'),
    })

    expect(firstA.id).not.toBe(firstB.id)
    expect(newA.id).not.toBe(firstA.id)
    expect(store.get(namespaceA3, userGlobal, firstA.id)).toBeUndefined()
    expect(store.list(namespaceA3, userGlobal).map(record => record.id)).toEqual([newA.id])
    store.close()
  })

  test('keeps the namespace stable across binding generations but rotates on principal version', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), now: () => 10_000 })
    const firstBinding = {
      principalDigest: namespaceA.principalDigest,
      principalRecordId: namespaceA.principalRecordId,
      principalVersion: namespaceA.principalVersion,
      bindingGeneration: 11,
    }
    const afterNewBinding = { ...firstBinding, bindingGeneration: 12 }
    const namespaceFromBinding = (binding: typeof firstBinding): MemoryOwnerNamespace => ({
      mode: 'delivery',
      principalDigest: binding.principalDigest,
      principalRecordId: binding.principalRecordId,
      principalVersion: binding.principalVersion,
    })
    const beforeNew = namespaceFromBinding(firstBinding)
    const afterNew = namespaceFromBinding(afterNewBinding)
    const first = store.applyApprovedMutation({
      op: 'add', idempotencyKey: 'binding-generation-independent', namespace: beforeNew,
      identity: userGlobal, entry: entry('survives slash-new'),
    })

    // Binding generation belongs to proposal/promotion fencing and is intentionally
    // absent from MemoryOwnerNamespace, so a new session/binding sees this record.
    expect(afterNewBinding.bindingGeneration).not.toBe(firstBinding.bindingGeneration)
    expect(memoryOwnerNamespaceKey(afterNew)).toBe(memoryOwnerNamespaceKey(beforeNew))
    expect(store.get(afterNew, userGlobal, first.id)?.content).toBe('survives slash-new')
    const renamedPrincipal: MemoryOwnerNamespace = {
      ...afterNew,
      principalDigest: 'f'.repeat(64),
    }
    expect(memoryOwnerNamespaceKey(renamedPrincipal)).toBe(memoryOwnerNamespaceKey(beforeNew))
    expect(store.get(renamedPrincipal, userGlobal, first.id)?.id).toBe(first.id)

    const rotated: MemoryOwnerNamespace = { ...namespaceA, principalVersion: 2 }
    expect(store.get(rotated, userGlobal, first.id)).toBeUndefined()
    expect(store.list(rotated, userGlobal)).toEqual([])
    store.close()
  })

  test('durably tombstones cancellation before submit and rejects changed or delayed work', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), now: () => 10_000 })
    const principal = 'lark/main/tenant/owner'
    const namespace: MemoryOwnerNamespace = {
      mode: 'delivery',
      principalDigest: memoryPrincipalDigest(principal),
      principalRecordId: 'principal-row-owner',
      principalVersion: 4,
    }
    const promotion = {
      promotionId: 'promotion-cancel-before-submit',
      promotionGeneration: 2,
      requestDigest: 'd'.repeat(64),
      scope: { workspace: '/work/alpha', preset: 'primary' },
      ownerGeneration: 9,
    } as const
    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const,
      promotionId: promotion.promotionId,
      promotionGeneration: promotion.promotionGeneration,
      requestDigest: promotion.requestDigest,
      principalLineage: {
        principalRecordId: namespace.principalRecordId,
        principalVersion: namespace.principalVersion,
      },
      ownerGeneration: promotion.ownerGeneration,
      reason: 'forget' as const,
      occurredAt: 9_999,
    })

    expect(store.cancelPromotionBeforeOrAfterSubmit(cancellation).outcome).toBe('cancelled')
    expect(store.cancelPromotionBeforeOrAfterSubmit(cancellation).outcome).toBe('replayed')

    const input = {
      proposalId: 'cancelled-memory-proposal',
      idempotencyKey: 'cancelled-memory-idempotency',
      requester: 'preference-learning',
      principal,
      namespace,
      ttlMs: 60_000,
      notAfter: 70_000,
      promotion,
      mutation: { op: 'add', identity: userWorkspace, entry: entry('must never be proposed') },
    } satisfies MemoryProposalInput & { proposalId: string; notAfter: number }
    expect(store.prepareProposalIntent({ ...input, mutationHash: hashMemoryProposalIntent(input) }))
      .toMatchObject({ kind: 'cancelled', receipt: { outcome: 'replayed' } })
    expect(store.getProposalIntent(input.proposalId)).toBeUndefined()

    const changed = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const,
      promotionId: cancellation.promotionId,
      promotionGeneration: cancellation.promotionGeneration,
      requestDigest: cancellation.requestDigest,
      principalLineage: { ...cancellation.principalLineage, principalVersion: 5 },
      ownerGeneration: cancellation.ownerGeneration,
      reason: cancellation.reason,
      occurredAt: cancellation.occurredAt,
    })
    expect(() => store.cancelPromotionBeforeOrAfterSubmit(changed))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'idempotency-conflict' }))
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
      expect(() => store.list(namespaceA, identity))
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
      namespace: namespaceA,
      identity: userGlobal,
      entry: entry('temporary', { expiresAt: 11_000 }),
    })
    const removed = store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'remove-me',
      namespace: namespaceA,
      identity: userGlobal,
      entry: entry('remove me'),
    })
    store.applyApprovedMutation({
      op: 'remove',
      idempotencyKey: 'remove-me-approved',
      namespace: namespaceA,
      identity: userGlobal,
      id: removed.id,
      expectedVersion: removed.version,
    })
    now = 11_000

    expect(store.get(namespaceA, userGlobal, expiring.id)).toBeUndefined()
    expect(store.get(namespaceA, userGlobal, removed.id)).toBeUndefined()
    expect(store.list(namespaceA, userGlobal)).toEqual([])
    expect(store.list(namespaceA, userGlobal, { includeRemoved: true }).map(record => record.status))
      .toEqual(['removed'])
    store.close()
  })

  test('applies replace with compare-and-set and records supersession', async () => {
    const store = new MemoryStore({ path: await temporaryPath(), now: () => 20_000 })
    const original = store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'add-editor',
      namespace: namespaceA,
      identity: userGlobal,
      entry: entry('Preferred editor is Vim', { kind: 'preference' }),
    })

    const replaced = store.applyApprovedMutation({
      op: 'replace',
      idempotencyKey: 'replace-editor',
      namespace: namespaceA,
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
      namespace: namespaceA,
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
      namespace: namespaceA,
      identity: userGlobal,
      entry: entry('Stable fact'),
    }

    const created = store.applyApprovedMutation(mutation)
    const replay = store.applyApprovedMutation(mutation)

    expect(replay).toEqual(created)
    expect(store.list(namespaceA, userGlobal)).toHaveLength(1)
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
      namespace: namespaceA,
      identity: userGlobal,
      entry: entry('same fact'),
    })

    expect(() => store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'duplicate',
      namespace: namespaceA,
      identity: userGlobal,
      entry: entry('same fact'),
    })).toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'duplicate-content' }))
    expect(() => store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'oversized',
      namespace: namespaceA,
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
    await chmod(path, 0o600)

    expect(() => new MemoryStore({ path }))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'schema-too-new' }))
  })

  test('rejects unsafe existing database files and sidecars', async () => {
    const publicPath = await temporaryPath('public.sqlite')
    await mkdir(join(publicPath, '..'), { recursive: true })
    await writeFile(publicPath, '')
    await chmod(publicPath, 0o644)
    expect(() => new MemoryStore({ path: publicPath }))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'unsafe-file' }))

    const target = await temporaryPath('target.sqlite')
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, '')
    await chmod(target, 0o600)
    const symbolic = await temporaryPath('symbolic.sqlite')
    await mkdir(join(symbolic, '..'), { recursive: true })
    await symlink(target, symbolic)
    expect(() => new MemoryStore({ path: symbolic }))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'unsafe-file' }))

    const hard = await temporaryPath('hard.sqlite')
    await mkdir(join(hard, '..'), { recursive: true })
    await link(target, hard)
    expect(() => new MemoryStore({ path: target }))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'unsafe-file' }))

    const owned = await temporaryPath('wrong-owner.sqlite')
    await mkdir(join(owned, '..'), { recursive: true })
    await writeFile(owned, '')
    await chmod(owned, 0o600)
    const uid = process.getuid?.()
    if (uid !== undefined) {
      vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
      expect(() => new MemoryStore({ path: owned }))
        .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'unsafe-file' }))
      vi.restoreAllMocks()
    }

    const sidecarPath = await temporaryPath('sidecar.sqlite')
    await mkdir(join(sidecarPath, '..'), { recursive: true })
    await writeFile(sidecarPath, '')
    await chmod(sidecarPath, 0o600)
    await writeFile(`${sidecarPath}-wal`, '')
    await chmod(`${sidecarPath}-wal`, 0o644)
    expect(() => new MemoryStore({ path: sidecarPath }))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'unsafe-file' }))
  })
})
