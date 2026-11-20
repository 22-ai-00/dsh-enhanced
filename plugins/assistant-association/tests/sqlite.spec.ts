import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssociationDatabaseError,
  AssociationStore,
  AssociationWriteQueue,
  computeDeterministicEdgeId,
  computeOwnerScopeKey,
  computePrincipalDigest,
  loadGraphSnapshotChunked,
  openAssociationDatabase,
  tokenizeAssociationText,
} from '../src/index.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assoc-sqlite-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('association sqlite, permissions, write queue & derivedFrom cascade', () => {
  test('enforces 0o600 permissions, WAL mode, and rejects symlinks/unsafe modes/schema-too-new', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'nested', 'state.sqlite')

    const db = openAssociationDatabase(dbPath)
    try {
      const modeRow = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      const uvRow = db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(modeRow.journal_mode.toLowerCase()).toBe('wal')
      expect(uvRow.user_version).toBe(1)

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
      const tableNames = tables.map((t) => t.name)
      expect(tableNames).toContain('assoc_nodes')
      expect(tableNames).toContain('assoc_edges')
      expect(tableNames).toContain('assoc_synonyms')
      expect(tableNames).toContain('assoc_derived_from')
      expect(tableNames).toContain('assoc_ingest_cursors')
      expect(tableNames).toContain('assoc_holdout_assignments')
      expect(tableNames).toContain('assoc_step_metrics')
      expect(tableNames).toContain('assoc_exposures')
    } finally {
      db.close()
    }

    expect(statSync(dbPath).mode & 0o777).toBe(0o600)

    // Relative path rejected
    expect(() => openAssociationDatabase('relative.sqlite')).toThrow(AssociationDatabaseError)

    // Unsafe group/other permissions rejected
    chmodSync(dbPath, 0o644)
    expect(() => openAssociationDatabase(dbPath)).toThrow(/permissions/)
    chmodSync(dbPath, 0o600)

    // Symlink rejected
    const linkPath = join(dir, 'link.sqlite')
    symlinkSync(dbPath, linkPath)
    expect(() => openAssociationDatabase(linkPath)).toThrow(/regular, unlinked file/)

    // Fail-closed on schema-too-new
    const rawDb = new DatabaseSync(dbPath)
    rawDb.exec('PRAGMA user_version = 99')
    rawDb.close()
    expect(() => openAssociationDatabase(dbPath)).toThrow(/newer than supported schema/)
  })

  test('processes write queue chunks, immediate tombstones, and multi-hop derivedFrom BFS cascade', async () => {
    const db = openAssociationDatabase(':memory:')
    const store = new AssociationStore(db)
    const mutations: Array<{ withdrawals: number; hasUpserts: boolean }> = []
    const queue = new AssociationWriteQueue(store, {
      maxItemsPerTx: 2,
      flushIntervalMs: 20,
      onGraphMutated: (info) => {
        mutations.push({ withdrawals: info.withdrawals.length, hasUpserts: info.hasUpserts })
      },
    })

    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-1'),
      principalRecordId: 'pr-1',
      principalVersion: 1,
      workspace: '/ws/test',
      agentPreset: 'primary',
    })
    const now = 1_700_000_000_000
    const e12 = computeDeterministicEdgeId('a:m-src', 'a:abs-1', 'abstraction')
    const e23 = computeDeterministicEdgeId('a:abs-1', 'a:dream-2', 'dream')

    queue.enqueue({
      kind: 'upsert-nodes',
      nodes: [
        {
          id: 'a:m-src',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:src',
          sourceVersion: 1,
          ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: computePrincipalDigest('owner-1'),
          principalRecordId: 'pr-1',
          principalVersion: 1,
          scopeMode: 'workspace',
          workspace: '/ws/test',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Source memory',
          body: 'Source memory body',
          entities: ['cgroup.freeze'],
          tokens: tokenizeAssociationText('Source memory body'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:abs-1',
          kind: 'abstraction',
          sourcePlugin: 'assistant-dreaming',
          sourceRef: 'dream:abs-1',
          sourceVersion: 1,
          ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: computePrincipalDigest('owner-1'),
          principalRecordId: 'pr-1',
          principalVersion: 1,
          scopeMode: 'workspace',
          workspace: '/ws/test',
          agentPreset: 'primary',
          trust: 'low',
          sensitivity: 'private',
          title: 'Derived abstraction node',
          body: 'Derived from source memory',
          entities: ['cgroup.freeze'],
          tokens: tokenizeAssociationText('Derived abstraction node'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:dream-2',
          kind: 'dream',
          sourcePlugin: 'assistant-dreaming',
          sourceRef: 'dream:node-2',
          sourceVersion: 1,
          ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: computePrincipalDigest('owner-1'),
          principalRecordId: 'pr-1',
          principalVersion: 1,
          scopeMode: 'workspace',
          workspace: '/ws/test',
          agentPreset: 'primary',
          trust: 'low',
          sensitivity: 'private',
          title: 'Second-hop derived dream node',
          body: 'Derived from abstraction',
          entities: ['watchdog'],
          tokens: tokenizeAssociationText('Second-hop derived dream node'),
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [
        {
          edgeId: e12,
          aId: 'a:m-src',
          bId: 'a:abs-1',
          edgeType: 'abstraction',
          weight: 0.7,
          trust: 'low',
          reason: 'abstraction:source',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: e23,
          aId: 'a:abs-1',
          bId: 'a:dream-2',
          edgeType: 'dream',
          weight: 0.5,
          trust: 'low',
          reason: 'dream:chain',
          createdAt: now,
          updatedAt: now,
        },
      ],
      synonyms: [
        {
          id: 'syn-1',
          ownerScopeKey,
          surface: 'freeze_hang',
          canonicalEntity: 'cgroup.freeze',
          sourceNodeId: 'a:abs-1',
          trust: 'low',
          createdAt: now,
        },
      ],
      derivedRefs: [
        { sourceNodeId: 'a:m-src', sourceVersion: 1, targetKind: 'node', targetId: 'a:abs-1' },
        { sourceNodeId: 'a:m-src', sourceVersion: 1, targetKind: 'edge', targetId: e12 },
        { sourceNodeId: 'a:abs-1', sourceVersion: 1, targetKind: 'node', targetId: 'a:dream-2' },
        { sourceNodeId: 'a:abs-1', sourceVersion: 1, targetKind: 'edge', targetId: e23 },
        { sourceNodeId: 'a:abs-1', sourceVersion: 1, targetKind: 'synonym', targetId: 'syn-1' },
      ],
      cursor: {
        sourcePlugin: 'personal-memory',
        scopeKey: ownerScopeKey,
        cursorJson: JSON.stringify({ seq: 42 }),
      },
    })

    await queue.flush()
    expect(store.countActiveNodes()).toBe(3)
    expect(store.getIngestCursor('personal-memory', ownerScopeKey)?.cursorJson).toBe('{"seq":42}')

    const snap = await loadGraphSnapshotChunked(store, { chunkSize: 1 })
    expect(snap?.nodes).toHaveLength(3)
    expect(snap?.edges).toHaveLength(2)
    expect(snap?.synonyms).toHaveLength(1)

    // Withdraw source -> synchronous tombstone + BFS cascade deletes a:m-src, a:abs-1, a:dream-2, edges & synonyms
    queue.enqueue({
      kind: 'withdraw-source',
      ownerScopeKey,
      sourcePlugin: 'personal-memory',
      sourceRef: 'memory:src',
      hardDelete: true,
      recordWithdrawalTombstone: true,
    })
    expect(queue.isSourceTombstoned(ownerScopeKey, 'personal-memory', 'memory:src')).toBe(true)

    await queue.flush()
    expect(store.countActiveNodes()).toBe(0)
    expect(store.getNodeById('a:abs-1')).toBeNull()
    expect(store.getNodeById('a:dream-2')).toBeNull()
    expect(store.loadActiveEdgesPage(10, 0)).toHaveLength(0)
    expect(store.loadActiveSynonymsPage(10, 0)).toHaveLength(0)
    expect(store.isSourceWithdrawn(ownerScopeKey, 'personal-memory', 'memory:src')).toBe(true)
    expect(mutations.some((m) => m.withdrawals > 0)).toBe(true)

    await queue.dispose()
    store.close()
  })

  test('preserves FIFO add -> withdraw ordering, refuses upsertBatch on withdrawn sources, and keeps pending withdrawal tombstones across concurrent rebuild snapshots', async () => {
    const db = openAssociationDatabase(':memory:')
    const store = new AssociationStore(db)
    const queue = new AssociationWriteQueue(store, {
      maxItemsPerTx: 1,
      flushIntervalMs: 20,
    })

    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-fifo'),
      principalRecordId: 'pr-fifo',
      principalVersion: 1,
      workspace: '/ws/fifo',
      agentPreset: 'primary',
    })
    const now = 1_700_000_000_000
    const makeNode = (id: string, ref: string, kind: 'memory' | 'abstraction' = 'memory') => ({
      id,
      kind,
      sourcePlugin: kind === 'memory' ? 'personal-memory' : 'assistant-dreaming',
      sourceRef: ref,
      sourceVersion: 1,
      ownerScopeKey,
      ownerMode: 'delivery' as const,
      principalDigest: computePrincipalDigest('owner-fifo'),
      principalRecordId: 'pr-fifo',
      principalVersion: 1,
      scopeMode: 'workspace' as const,
      workspace: '/ws/fifo',
      agentPreset: 'primary',
      trust: 'trusted' as const,
      sensitivity: 'private' as const,
      title: `Node ${id}`,
      body: `Body ${id}`,
      entities: ['fifo_entity'],
      tokens: tokenizeAssociationText(`Node ${id}`),
      createdAt: now,
      updatedAt: now,
    })

    // 1. Seed a:m-r1 -> a:abs-r2 in SQLite first
    store.upsertBatch({
      nodes: [
        makeNode('a:m-r1', 'memory:r1', 'memory'),
        makeNode('a:abs-r2', 'dream:r2', 'abstraction'),
      ],
      edges: [],
      derivedRefs: [
        { sourceNodeId: 'a:m-r1', sourceVersion: 1, targetKind: 'node', targetId: 'a:abs-r2' },
      ],
    })

    // 2. Busy writeQueue: enqueue chunked upserts (maxItemsPerTx: 1 -> yields across ticks),
    // simulate an overlapping rebuildIndex snapshot epoch, then enqueue withdraw-source behind the upserts!
    queue.enqueue({
      kind: 'upsert-nodes',
      nodes: [makeNode('a:m-busy1', 'memory:busy1'), makeNode('a:m-busy2', 'memory:busy2')],
      edges: [],
      derivedRefs: [],
    })
    const snapshotEpoch = queue.withdrawalEpoch
    queue.markTombstoneSync({
      nodeIds: ['a:m-r1', 'a:abs-r2'],
      ownerScopeKey,
      sourcePlugin: 'personal-memory',
      sourceRef: 'memory:r1',
    })
    queue.enqueue({
      kind: 'withdraw-source',
      ownerScopeKey,
      sourcePlugin: 'personal-memory',
      sourceRef: 'memory:r1',
      hardDelete: true,
      recordWithdrawalTombstone: false,
    })

    // Concurrent rebuild committing with pre-withdrawal/pending queue MUST NOT wipe derived-node tombstones!
    queue.clearTombstonesForRebuiltGraph(new Set(['a:m-busy1']), snapshotEpoch)
    expect(queue.isNodeTombstoned('a:abs-r2')).toBe(true)
    expect(queue.isNodeTombstoned('a:m-r1')).toBe(true)
    expect(queue.isSourceTombstoned(ownerScopeKey, 'personal-memory', 'memory:r1')).toBe(true)

    await queue.flush()
    expect(store.getNodeById('a:m-r1')).toBeNull()
    expect(store.getNodeById('a:abs-r2')).toBeNull()

    // Post-drain snapshot epoch cleanly clears tombstones
    const cleanEpoch = queue.withdrawalEpoch
    queue.clearTombstonesForRebuiltGraph(new Set(['a:m-busy1', 'a:m-busy2']), cleanEpoch)
    expect(queue.isNodeTombstoned('a:abs-r2')).toBe(false)

    // 3. Same-tick queued add -> withdraw (even with recordWithdrawalTombstone: false) executes in FIFO order without resurrecting!
    queue.enqueue({
      kind: 'upsert-nodes',
      nodes: [makeNode('a:m-rapid1', 'memory:rapid1'), makeNode('a:m-rapid2', 'memory:rapid2')],
      edges: [],
      derivedRefs: [],
    })
    queue.enqueue({
      kind: 'withdraw-source',
      ownerScopeKey,
      sourcePlugin: 'personal-memory',
      sourceRef: 'memory:rapid1',
      hardDelete: true,
      recordWithdrawalTombstone: false,
    })
    await queue.flush()
    expect(store.getNodeById('a:m-rapid1')).toBeNull()
    expect(store.getNodeById('a:m-rapid2')).not.toBeNull()

    // 4. Withdrawn source tombstone in assoc_withdrawn_sources blocks subsequent upsertBatch resurrection
    queue.enqueue({
      kind: 'upsert-nodes',
      nodes: [makeNode('a:m-wd', 'memory:wd')],
      edges: [],
      derivedRefs: [],
    })
    queue.enqueue({
      kind: 'withdraw-source',
      ownerScopeKey,
      sourcePlugin: 'personal-memory',
      sourceRef: 'memory:wd',
      hardDelete: true,
      recordWithdrawalTombstone: true,
    })
    await queue.flush()
    expect(store.isSourceWithdrawn(ownerScopeKey, 'personal-memory', 'memory:wd')).toBe(true)

    store.upsertBatch({
      nodes: [makeNode('a:m-wd', 'memory:wd')],
      edges: [],
      derivedRefs: [],
    })
    expect(store.getNodeById('a:m-wd')).toBeNull()

    await queue.dispose()
    store.close()
  })
})
