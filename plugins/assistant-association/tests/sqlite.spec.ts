import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssociationDatabaseError,
  AssociationParamTuningLedger,
  AssociationStore,
  AssociationWriteQueue,
  DEFAULT_HEBBIAN_CONFIG,
  computeDeterministicEdgeId,
  computeOwnerScopeKey,
  computePrincipalDigest,
  loadGraphSnapshotChunked,
  openAssociationDatabase,
  tokenizeAssociationText,
  type GraphMutationSummary,
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
      expect(uvRow.user_version).toBe(2)

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
      expect(tableNames).toContain('assoc_hebbian_events')
      expect(tableNames).toContain('assoc_read_events')
      expect(tableNames).toContain('assoc_replay_episodes')
      expect(tableNames).toContain('assoc_task_telemetry')
      expect(tableNames).toContain('assoc_param_profile_versions')
      expect(tableNames).toContain('assoc_param_profile_heads')
      expect(tableNames).toContain('assoc_param_profile_events')
      expect(tableNames).toContain('assoc_param_relax_proposals')
      expect(tableNames).toContain('assoc_param_relax_decisions')
      expect(tableNames).toContain('assoc_param_rolled_back_digests')
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

  test('migrates S1 v1 database to v2 preserving existing rows and enforces WP22 immutability triggers', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'v1-state.sqlite')
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-v1'),
      principalRecordId: 'pr-v1',
      principalVersion: 1,
      workspace: '/ws/v1',
      agentPreset: 'primary',
    })
    const now = 1_700_000_000_000
    const edgeId = computeDeterministicEdgeId('a:m-1', 'a:m-2', 'entity')

    const v1Db = new DatabaseSync(dbPath)
    v1Db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta(key, value) VALUES ('schema-version', '1');
      CREATE TABLE assoc_nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_plugin TEXT NOT NULL, source_ref TEXT NOT NULL,
        source_version INTEGER NOT NULL, owner_scope_key TEXT NOT NULL, owner_mode TEXT NOT NULL,
        principal_digest TEXT, principal_record_id TEXT, principal_version INTEGER,
        scope_mode TEXT NOT NULL, workspace TEXT NOT NULL, agent_preset TEXT NOT NULL,
        trust TEXT NOT NULL, sensitivity TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        entities_json TEXT NOT NULL, tokens_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
        ttl_ms INTEGER, expires_at INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE assoc_edges (
        edge_id TEXT PRIMARY KEY, a_id TEXT NOT NULL REFERENCES assoc_nodes(id) ON DELETE CASCADE,
        b_id TEXT NOT NULL REFERENCES assoc_nodes(id) ON DELETE CASCADE, edge_type TEXT NOT NULL,
        weight REAL NOT NULL, trust TEXT NOT NULL, reason TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE assoc_step_metrics (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, owner_scope_key TEXT NOT NULL,
        in_holdout INTEGER NOT NULL, latency_us INTEGER NOT NULL, timed_out INTEGER NOT NULL,
        fallback_mode TEXT NOT NULL, injected_count INTEGER NOT NULL, candidate_count INTEGER NOT NULL,
        source_counts_json TEXT NOT NULL, occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE assoc_exposures (
        task_id TEXT NOT NULL, node_id TEXT NOT NULL, owner_scope_key TEXT NOT NULL,
        source_plugin TEXT NOT NULL, exposed_at INTEGER NOT NULL,
        assoc_read_count INTEGER NOT NULL DEFAULT 0, weak_use_count INTEGER NOT NULL DEFAULT 0,
        corrected INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (task_id, node_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE assoc_holdout_assignments (
        task_id TEXT PRIMARY KEY, owner_scope_key TEXT NOT NULL, task_kind TEXT NOT NULL,
        session_id TEXT, turn_number INTEGER, in_holdout INTEGER NOT NULL,
        bucket_bps INTEGER NOT NULL, rate_bps INTEGER NOT NULL, hmac_digest TEXT NOT NULL,
        assigned_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `)
    v1Db
      .prepare(`
        INSERT INTO assoc_nodes VALUES (
          ?, 'memory', 'personal-memory', ?, 1, ?, 'delivery', ?, 'pr-v1', 1,
          'workspace', '/ws/v1', 'primary', 'trusted', 'private', 'Title', 'Body',
          '["cgroup"]', '["title"]', '{}', NULL, NULL, 'active', ?, ?
        )
      `)
      .run('a:m-1', 'memory:1', ownerScopeKey, computePrincipalDigest('owner-v1'), now, now)
    v1Db
      .prepare(`
        INSERT INTO assoc_nodes VALUES (
          ?, 'memory', 'personal-memory', ?, 1, ?, 'delivery', ?, 'pr-v1', 1,
          'workspace', '/ws/v1', 'primary', 'trusted', 'private', 'Title 2', 'Body 2',
          '["cgroup"]', '["title"]', '{}', NULL, NULL, 'active', ?, ?
        )
      `)
      .run('a:m-2', 'memory:2', ownerScopeKey, computePrincipalDigest('owner-v1'), now, now)
    v1Db
      .prepare(
        "INSERT INTO assoc_edges VALUES (?, 'a:m-1', 'a:m-2', 'entity', 0.8, 'trusted', 'entity:cgroup', 2, ?, ?, ?)",
      )
      .run(edgeId, now, now, now)
    v1Db
      .prepare(
        "INSERT INTO assoc_step_metrics(task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at) VALUES ('t-1', ?, 0, 420, 0, 'none', 1, 2, '{\"memory\":1}', ?)",
      )
      .run(ownerScopeKey, now)
    v1Db
      .prepare(
        "INSERT INTO assoc_step_metrics(task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at) VALUES ('t-2', ?, 0, 430, 0, 'none', 1, 2, '{\"memory\":1}', ?)",
      )
      .run(ownerScopeKey, now)
    v1Db
      .prepare(
        "INSERT INTO assoc_step_metrics(task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at) VALUES ('t-3', ?, 0, 440, 0, 'none', 1, 2, '{\"memory\":1}', ?)",
      )
      .run(ownerScopeKey, now)
    v1Db
      .prepare(
        "INSERT INTO assoc_exposures VALUES ('t-1', 'a:m-1', ?, 'personal-memory', ?, 1, 0, 0)",
      )
      .run(ownerScopeKey, now)
    v1Db
      .prepare(
        "INSERT INTO assoc_exposures VALUES ('t-2', 'a:m-2', ?, 'personal-memory', ?, 0, 1, 0)",
      )
      .run(ownerScopeKey, now)
    v1Db
      .prepare(
        "INSERT INTO assoc_exposures VALUES ('t-3', 'a:m-1', ?, 'personal-memory', ?, 0, 0, 0)",
      )
      .run(ownerScopeKey, now)

    const beforeStats = new AssociationParamTuningLedger(v1Db).stats(
      ownerScopeKey,
      now - 1_000,
      now + 1_000,
    )
    expect(beforeStats.injectedTasks).toBe(3)
    expect(beforeStats.usedTasks).toBe(2)
    expect(beforeStats.sourceExposures.memory).toEqual({ total: 3, unusedOrCorrected: 1 })
    v1Db.close()
    chmodSync(dbPath, 0o600)

    const migrated = openAssociationDatabase(dbPath)
    try {
      const uv = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(uv.user_version).toBe(2)
      const meta = migrated
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema-version'")
        .get() as { value: string }
      expect(meta.value).toBe('2')

      const metric = migrated
        .prepare('SELECT task_id, profile_version FROM assoc_step_metrics WHERE task_id = ?')
        .get('t-1') as { task_id: string; profile_version: number }
      expect(metric.profile_version).toBe(0)

      const exposure = migrated
        .prepare(
          'SELECT was_exposed, hop, provenance_edges_json, strong_used, weak_used, assoc_read_count, weak_use_count FROM assoc_exposures WHERE task_id = ? AND node_id = ?',
        )
        .get('t-1', 'a:m-1') as {
        was_exposed: number
        hop: number
        provenance_edges_json: string
        strong_used: number
        weak_used: number
        assoc_read_count: number
        weak_use_count: number
      }
      expect(exposure.was_exposed).toBe(1)
      expect(exposure.hop).toBe(0)
      expect(exposure.provenance_edges_json).toBe('[]')
      expect(exposure.assoc_read_count).toBe(1)
      expect(exposure.weak_use_count).toBe(0)
      expect(exposure.strong_used).toBe(1)
      expect(exposure.weak_used).toBe(0)

      const weakExposure = migrated
        .prepare(
          'SELECT was_exposed, strong_used, weak_used, assoc_read_count, weak_use_count FROM assoc_exposures WHERE task_id = ? AND node_id = ?',
        )
        .get('t-2', 'a:m-2') as {
        was_exposed: number
        strong_used: number
        weak_used: number
        assoc_read_count: number
        weak_use_count: number
      }
      expect(weakExposure).toEqual({
        was_exposed: 1,
        strong_used: 0,
        weak_used: 1,
        assoc_read_count: 0,
        weak_use_count: 1,
      })

      const unusedExposure = migrated
        .prepare(
          'SELECT was_exposed, strong_used, weak_used, assoc_read_count, weak_use_count FROM assoc_exposures WHERE task_id = ? AND node_id = ?',
        )
        .get('t-3', 'a:m-1') as {
        was_exposed: number
        strong_used: number
        weak_used: number
        assoc_read_count: number
        weak_use_count: number
      }
      expect(unusedExposure).toEqual({
        was_exposed: 1,
        strong_used: 0,
        weak_used: 0,
        assoc_read_count: 0,
        weak_use_count: 0,
      })

      const afterStats = new AssociationParamTuningLedger(migrated).stats(
        ownerScopeKey,
        now - 1_000,
        now + 1_000,
      )
      expect(afterStats.injectedTasks).toBe(beforeStats.injectedTasks)
      expect(afterStats.usedTasks).toBe(beforeStats.usedTasks)
      expect(afterStats.sourceExposures).toEqual(beforeStats.sourceExposures)

      // Already-v2 DB re-open MUST NOT backfill read-before-exposure rows (was_exposed=1, assoc_read_count=1, strong_used=0)
      migrated
        .prepare(
          "INSERT INTO assoc_exposures (task_id, node_id, owner_scope_key, source_plugin, exposed_at, was_exposed, assoc_read_count, weak_use_count, strong_used, weak_used) VALUES ('t-v2-pre', 'a:m-1', ?, 'personal-memory', ?, 1, 1, 0, 0, 0)",
        )
        .run(ownerScopeKey, now)

      // WP22 immutability triggers
      migrated
        .prepare(`
          INSERT INTO assoc_param_profile_versions (
            scope_key, version, parent_version, params_json, params_digest,
            basis_json, change_json, origin, digest, idempotency_key, created_at
          ) VALUES (?, 0, NULL, '{}', 'pd0', '{}', '{}', 'baseline', 'd0', 'idem-0', ?)
        `)
        .run(ownerScopeKey, now)
      expect(() =>
        migrated
          .prepare('UPDATE assoc_param_profile_versions SET digest = ? WHERE scope_key = ?')
          .run('tampered', ownerScopeKey),
      ).toThrow(/immutable/)
      expect(() =>
        migrated
          .prepare('DELETE FROM assoc_param_profile_versions WHERE scope_key = ?')
          .run(ownerScopeKey),
      ).toThrow(/durable/)

      migrated
        .prepare(`
          INSERT INTO assoc_param_profile_heads (
            scope_key, active_version, latest_version, active_digest, state,
            observing_version, observe_from, observe_until, changed_at
          ) VALUES (?, 0, 0, 'd0', 'idle', NULL, NULL, NULL, ?)
        `)
        .run(ownerScopeKey, now)
      expect(() =>
        migrated
          .prepare('DELETE FROM assoc_param_profile_heads WHERE scope_key = ?')
          .run(ownerScopeKey),
      ).toThrow(/durable/)

      migrated
        .prepare(`
          INSERT INTO assoc_param_profile_events (
            scope_key, kind, from_version, to_version, from_digest, to_digest,
            reason, detail_json, idempotency_key, occurred_at
          ) VALUES (?, 'adopted', 0, 1, 'd0', 'd1', 'low-usage', '{}', 'ev-1', ?)
        `)
        .run(ownerScopeKey, now)
      expect(() =>
        migrated
          .prepare('UPDATE assoc_param_profile_events SET reason = ? WHERE idempotency_key = ?')
          .run('changed', 'ev-1'),
      ).toThrow(/immutable/)
      expect(() =>
        migrated
          .prepare('DELETE FROM assoc_param_profile_events WHERE idempotency_key = ?')
          .run('ev-1'),
      ).toThrow(/durable/)

      migrated
        .prepare(`
          INSERT INTO assoc_param_relax_proposals (
            proposal_id, scope_key, parent_version, parent_digest, candidate_json,
            params_digest, change_json, holdout_seal, window_from, window_to,
            basis_json, status, created_at
          ) VALUES ('prop-1', ?, 0, 'd0', '{}', 'pd1', '{}', 'seal-1', 0, 100, '{}', 'pending', ?)
        `)
        .run(ownerScopeKey, now)
      expect(() =>
        migrated
          .prepare("UPDATE assoc_param_relax_proposals SET status = 'adopted' WHERE proposal_id = 'prop-1'")
          .run(),
      ).toThrow(/immutable/)
      expect(() =>
        migrated.prepare("DELETE FROM assoc_param_relax_proposals WHERE proposal_id = 'prop-1'").run(),
      ).toThrow(/durable/)

      migrated
        .prepare(`
          INSERT INTO assoc_param_relax_decisions (
            decision_id, proposal_id, scope_key, status, reason, replay_json, decided_at
          ) VALUES ('dec-1', 'prop-1', ?, 'rejected', 'holdout-failed', '{}', ?)
        `)
        .run(ownerScopeKey, now)
      expect(() =>
        migrated
          .prepare("UPDATE assoc_param_relax_decisions SET status = 'adopted' WHERE decision_id = 'dec-1'")
          .run(),
      ).toThrow(/immutable/)
      expect(() =>
        migrated.prepare("DELETE FROM assoc_param_relax_decisions WHERE decision_id = 'dec-1'").run(),
      ).toThrow(/durable/)
    } finally {
      migrated.close()
    }

    const reopened = openAssociationDatabase(dbPath)
    try {
      const preRow = reopened
        .prepare(
          'SELECT was_exposed, assoc_read_count, weak_use_count, strong_used, weak_used FROM assoc_exposures WHERE task_id = ? AND node_id = ?',
        )
        .get('t-v2-pre', 'a:m-1') as {
        was_exposed: number
        assoc_read_count: number
        weak_use_count: number
        strong_used: number
        weak_used: number
      }
      expect(preRow).toEqual({
        was_exposed: 1,
        assoc_read_count: 1,
        weak_use_count: 0,
        strong_used: 0,
        weak_used: 0,
      })
    } finally {
      reopened.close()
    }
  })

  test('WriteQueue drains coalesced exposures before Hebbian tasks, enforces idempotent +alpha/+alpha/3/correction/decay, and protects was_exposed', async () => {
    const db = openAssociationDatabase(':memory:')
    const store = new AssociationStore(db)
    const mutations: GraphMutationSummary[] = []
    const queue = new AssociationWriteQueue(store, {
      maxItemsPerTx: 20,
      flushIntervalMs: 5_000, // large interval to prove explicit drain before Hebbian tasks
      onGraphMutated: (info) => mutations.push(info),
    })

    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-hebbian'),
      principalRecordId: 'pr-heb',
      principalVersion: 1,
      workspace: '/ws/heb',
      agentPreset: 'primary',
    })
    const now = 1_700_000_000_000
    const makeNode = (id: string, ref: string) => ({
      id,
      kind: 'memory' as const,
      sourcePlugin: 'personal-memory',
      sourceRef: ref,
      sourceVersion: 1,
      ownerScopeKey,
      ownerMode: 'delivery' as const,
      principalDigest: computePrincipalDigest('owner-hebbian'),
      principalRecordId: 'pr-heb',
      principalVersion: 1,
      scopeMode: 'workspace' as const,
      workspace: '/ws/heb',
      agentPreset: 'primary',
      trust: 'trusted' as const,
      sensitivity: 'private' as const,
      title: `Node ${id}`,
      body: `Body ${id}`,
      entities: ['cgroup'],
      tokens: tokenizeAssociationText(`Node ${id}`),
      createdAt: now,
      updatedAt: now,
    })

    const e12 = computeDeterministicEdgeId('a:m-n1', 'a:m-n2', 'entity')
    store.upsertBatch({
      nodes: [
        makeNode('a:m-n1', 'memory:n1'),
        makeNode('a:m-n2', 'memory:n2'),
        makeNode('a:m-n3', 'memory:n3'),
      ],
      edges: [
        {
          edgeId: e12,
          aId: 'a:m-n1',
          bId: 'a:m-n2',
          edgeType: 'entity',
          weight: 0.5,
          trust: 'trusted',
          reason: 'entity:cgroup',
          createdAt: now,
          updatedAt: now,
        },
      ],
      derivedRefs: [],
    })

    // 1. Enqueue coalesced exposure (5s timer!) then immediately enqueue apply-hebbian-use
    queue.enqueue({
      kind: 'record-metrics',
      metrics: [
        {
          taskId: 'foreground-turn:inbox-1',
          ownerScopeKey,
          inHoldout: false,
          latencyUs: 500,
          timedOut: false,
          fallbackMode: 'none',
          injectedCount: 2,
          candidateCount: 3,
          sourceCounts: { memory: 2 },
          profileVersion: 1,
          occurredAt: now,
        },
      ],
      exposures: [
        {
          taskId: 'foreground-turn:inbox-1',
          nodeId: 'a:m-n2',
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now,
          wasExposed: true,
          hop: 1,
          score: 0.9,
          reason: 'entity:cgroup',
          provenanceEdges: [{ edgeId: e12, aId: 'a:m-n1', bId: 'a:m-n2', edgeType: 'entity' }],
          sessionId: 'sess-1',
        },
        {
          taskId: 'foreground-turn:inbox-1',
          nodeId: 'a:m-n3',
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now,
          wasExposed: true,
          hop: 0,
          score: 0.8,
          reason: 'entity:cgroup',
          sessionId: 'sess-1',
        },
      ],
    })

    // Weak use on a:m-n2 (+alpha/3) -> must drain exposure first!
    queue.enqueue({
      kind: 'apply-hebbian-use',
      useKind: 'weak',
      taskId: 'foreground-turn:inbox-1',
      ownerScopeKey,
      nodeId: 'a:m-n2',
      sessionId: 'sess-1',
      nowMs: now + 100,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })
    // Repeated weak use -> idempotent (0 delta)
    queue.enqueue({
      kind: 'apply-hebbian-use',
      useKind: 'weak',
      taskId: 'foreground-turn:inbox-1',
      ownerScopeKey,
      nodeId: 'a:m-n2',
      nowMs: now + 150,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })
    // Weak -> Strong upgrade on a:m-n2: +(alpha - alpha/3), total = +alpha (0.5 + 0.25 = 0.75)
    queue.enqueue({
      kind: 'apply-hebbian-use',
      useKind: 'strong',
      taskId: 'foreground-turn:inbox-1',
      ownerScopeKey,
      nodeId: 'a:m-n2',
      nowMs: now + 200,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })
    // Repeated strong use -> idempotent (0 delta)
    queue.enqueue({
      kind: 'apply-hebbian-use',
      useKind: 'strong',
      taskId: 'foreground-turn:inbox-1',
      ownerScopeKey,
      nodeId: 'a:m-n2',
      nowMs: now + 250,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })

    // Hop-0 co-activation on a:m-n3 with a:m-n2 creates hebbian edge + derivedFrom for both
    queue.enqueue({
      kind: 'apply-hebbian-use',
      useKind: 'strong',
      taskId: 'foreground-turn:inbox-1',
      ownerScopeKey,
      nodeId: 'a:m-n3',
      coActivatedNodeIds: ['a:m-n2'],
      nowMs: now + 300,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })

    await queue.flush()

    const edge12 = store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === e12)!
    expect(edge12.weight).toBeCloseTo(0.75, 6)
    expect(edge12.useCount).toBe(2)

    const hebbian23Id = computeDeterministicEdgeId('a:m-n2', 'a:m-n3', 'hebbian')
    const edge23 = store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === hebbian23Id)!
    expect(edge23).toBeDefined()
    expect(edge23.weight).toBeCloseTo(
      DEFAULT_HEBBIAN_CONFIG.initialHebbianWeight + DEFAULT_HEBBIAN_CONFIG.alpha,
      6,
    )

    expect(
      mutations.some((m) => m.hasEdgeWeightUpdates && !m.hasStructuralGraphChanges),
    ).toBe(true)

    // Unexposed assoc_read MUST NOT overwrite was_exposed = 1 with 0
    store.recordMetricsAndExposures(
      [],
      [
        {
          taskId: 'foreground-turn:inbox-1',
          nodeId: 'a:m-n2',
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now + 400,
          wasExposed: false,
          assocReadCount: 1,
        },
      ],
    )
    expect(store.hasExposedRow('foreground-turn:inbox-1', 'a:m-n2')).toBe(true)

    // Read event, task telemetry & replay episode
    queue.enqueue({
      kind: 'record-read-event',
      event: {
        taskId: 'foreground-turn:inbox-1',
        nodeId: 'a:m-n2',
        ownerScopeKey,
        hit: true,
        reason: 'ok',
        occurredAt: now + 410,
      },
    })
    queue.enqueue({
      kind: 'upsert-task-telemetry',
      telemetry: {
        taskId: 'foreground-turn:inbox-1',
        ownerScopeKey,
        inHoldout: false,
        turnsDelta: 1,
        stepsDelta: 2,
        inputTokensDelta: 120,
        outputTokensDelta: null,
        updatedAt: now + 420,
      },
    })
    queue.enqueue({
      kind: 'upsert-replay-episode',
      episode: {
        taskId: 'foreground-turn:inbox-1',
        ownerScopeKey,
        inHoldout: false,
        cues: [{ kind: 'user', text: 'cgroup', weight: 1.0 }],
        usedNodeIds: ['a:m-n2'],
        profileVersion: 1,
        occurredAt: now + 430,
      },
    })
    await queue.flush()

    const telRow = db
      .prepare('SELECT turns, steps, input_tokens, output_tokens FROM assoc_task_telemetry WHERE task_id = ?')
      .get('foreground-turn:inbox-1') as {
      turns: number
      steps: number
      input_tokens: number | null
      output_tokens: number | null
    }
    expect(telRow).toEqual({ turns: 1, steps: 2, input_tokens: 120, output_tokens: null })

    // Correction -beta on task down-weights e12 & hebbian23Id and sets corrected = 1
    const corr1 = store.applyHebbianCorrection({
      ownerScopeKey,
      taskId: 'foreground-turn:inbox-1',
      nowMs: now + 500,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })
    expect(corr1.correctedExposures).toBe(2)
    expect(corr1.updatedEdges).toBe(2)
    expect(store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === e12)!.weight).toBeCloseTo(
      0.75 - DEFAULT_HEBBIAN_CONFIG.beta,
      6,
    )
    // Idempotent repeat correction
    expect(
      store.applyHebbianCorrection({
        ownerScopeKey,
        taskId: 'foreground-turn:inbox-1',
        nowMs: now + 550,
        hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
      }).correctedExposures,
    ).toBe(0)

    // Semigroup-invariant decay test (t1 -> t2 equals single jump -> t2)
    // e12 was last used at now + 200 (strong upgrade on a:m-n2)
    const e12LastUsed = now + 200
    const grace = 1_000
    const halfLife = 10_000
    const t1 = e12LastUsed + grace + 5_000
    const t2 = e12LastUsed + grace + 12_000
    const wBeforeDecay = store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === e12)!.weight
    const expectedAtT2 =
      wBeforeDecay * Math.exp((-Math.LN2 * (t2 - (e12LastUsed + grace))) / halfLife)

    const d1 = store.applyHebbianDecayBatch({
      nowMs: t1,
      decayHalfLifeMs: halfLife,
      nonUseGraceMs: grace,
      weightMin: 0.05,
      weightMax: 3.0,
      limit: 200,
    })
    expect(d1.decayedEdges).toBe(2)
    const d2 = store.applyHebbianDecayBatch({
      nowMs: t2,
      decayHalfLifeMs: halfLife,
      nonUseGraceMs: grace,
      weightMin: 0.05,
      weightMax: 3.0,
      limit: 200,
    })
    expect(d2.decayedEdges).toBe(2)
    expect(store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === e12)!.weight).toBeCloseTo(
      expectedAtT2,
      8,
    )

    // Withdrawing either endpoint of Hop-0 hebbian edge cascade-deletes the hebbian edge
    store.withdrawSource({
      ownerScopeKey,
      sourcePlugin: 'personal-memory',
      sourceRef: 'memory:n3',
      hardDelete: true,
    })
    expect(store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === hebbian23Id)).toBeUndefined()

    await queue.dispose()
    store.close()
  })

  test('supports findLatestUncorrectedMemoryExposure, session fallback, and chunked decay via WriteQueue', async () => {
    const db = openAssociationDatabase(':memory:')
    const store = new AssociationStore(db)
    const mutations: GraphMutationSummary[] = []
    const queue = new AssociationWriteQueue(store, {
      onGraphMutated: (info) => mutations.push(info),
    })

    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-chunk'),
      principalRecordId: 'pr-chunk',
      principalVersion: 1,
      workspace: '/ws/chunk',
      agentPreset: 'primary',
    })
    const now = 1_700_000_000_000
    const makeNode = (id: string, ref: string) => ({
      id,
      kind: 'memory' as const,
      sourcePlugin: 'personal-memory',
      sourceRef: ref,
      sourceVersion: 1,
      ownerScopeKey,
      ownerMode: 'delivery' as const,
      principalDigest: computePrincipalDigest('owner-chunk'),
      principalRecordId: 'pr-chunk',
      principalVersion: 1,
      scopeMode: 'workspace' as const,
      workspace: '/ws/chunk',
      agentPreset: 'primary',
      trust: 'trusted' as const,
      sensitivity: 'private' as const,
      title: `Node ${id}`,
      body: `Body ${id}`,
      entities: ['chunk'],
      tokens: tokenizeAssociationText(`Node ${id}`),
      createdAt: now,
      updatedAt: now,
    })

    const nodes = ['a:m-0', 'a:m-1', 'a:m-2', 'a:m-3', 'a:m-4', 'a:m-5'].map((id, idx) =>
      makeNode(id, `memory:${idx}`),
    )
    const edges = ['a:m-1', 'a:m-2', 'a:m-3', 'a:m-4', 'a:m-5'].map((target) => ({
      edgeId: computeDeterministicEdgeId('a:m-0', target, 'entity'),
      aId: 'a:m-0',
      bId: target,
      edgeType: 'entity' as const,
      weight: 1.0,
      trust: 'trusted' as const,
      reason: 'entity:chunk',
      createdAt: now,
      updatedAt: now,
    }))
    store.upsertBatch({ nodes, edges, derivedRefs: [] })

    // Unused newer exposure vs used slightly older exposure -> findLatestUncorrectedMemoryExposure prefers used!
    store.recordMetricsAndExposures(
      [],
      [
        {
          taskId: 't-used',
          nodeId: 'a:m-1',
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now + 100,
          wasExposed: true,
          hop: 1,
          provenanceEdges: [
            { edgeId: edges[0]!.edgeId, aId: 'a:m-0', bId: 'a:m-1', edgeType: 'entity' },
          ],
          sessionId: 'sess-chunk',
        },
        {
          taskId: 't-unused',
          nodeId: 'a:m-1',
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now + 200,
          wasExposed: true,
          hop: 0,
          sessionId: 'sess-other',
        },
      ],
    )
    store.applyHebbianUse({
      useKind: 'strong',
      taskId: 't-used',
      ownerScopeKey,
      nodeId: 'a:m-1',
      nowMs: now + 150,
    })

    const latest = store.findLatestUncorrectedMemoryExposure(ownerScopeKey, 'a:m-1', now)
    expect(latest?.taskId).toBe('t-used')

    const bySession = store.findExposuresByTaskOrSession(ownerScopeKey, 'missing-task', 'sess-chunk')
    expect(bySession).toHaveLength(1)
    expect(bySession[0]?.taskId).toBe('t-used')

    // Node-scoped correction hits t-used and reduces edge 0 weight by beta
    const beforeWeight = store
      .loadActiveEdgesPage(10, 0)
      .find((e) => e.edgeId === edges[0]!.edgeId)!.weight
    const nodeCorr = store.applyHebbianCorrection({
      ownerScopeKey,
      nodeId: 'a:m-1',
      minExposedAt: now,
      nowMs: now + 300,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })
    expect(nodeCorr.correctedExposures).toBe(1)
    expect(nodeCorr.updatedEdges).toBe(1)
    expect(
      store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === edges[0]!.edgeId)!.weight,
    ).toBeCloseTo(beforeWeight - DEFAULT_HEBBIAN_CONFIG.beta, 6)

    // Chunked decay across all 5 edges (limit: 2 per tx)
    queue.enqueue({
      kind: 'apply-hebbian-decay',
      nowMs: now + 20_000,
      decayHalfLifeMs: 10_000,
      nonUseGraceMs: 5_000,
      weightMin: 0.05,
      weightMax: 3.0,
      limit: 2,
    })
    await queue.flush()

    const decayedEdges = store.loadActiveEdgesPage(10, 0)
    expect(decayedEdges).toHaveLength(5)
    for (const edge of decayedEdges) {
      expect(edge.lastDecayedAt).toBe(now + 20_000)
      expect(edge.weight).toBeLessThan(1.0)
    }
    expect(mutations.some((m) => m.hasEdgeWeightUpdates && !m.hasStructuralGraphChanges)).toBe(true)

    await queue.dispose()
    store.close()
  })

  test('enforces BUG-3B session fallback boundaries, BUG-3A Hop-0 hebbian event correction, and BUG-4 pre-decay weight clamping', () => {
    const db = openAssociationDatabase(':memory:')
    const store = new AssociationStore(db)
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('owner-bugs'),
      principalRecordId: 'pr-bugs',
      principalVersion: 1,
      workspace: '/ws/bugs',
      agentPreset: 'primary',
    })
    const now = 1_700_000_000_000

    const makeNode = (id: string, kind: 'memory' | 'goal', ref: string) => ({
      id,
      kind,
      sourcePlugin: kind === 'memory' ? 'personal-memory' : 'assistant-goals',
      sourceRef: ref,
      sourceVersion: 1,
      ownerScopeKey,
      ownerMode: 'delivery' as const,
      principalDigest: computePrincipalDigest('owner-bugs'),
      principalRecordId: 'pr-bugs',
      principalVersion: 1,
      scopeMode: 'workspace' as const,
      workspace: '/ws/bugs',
      agentPreset: 'primary',
      trust: 'trusted' as const,
      sensitivity: 'private' as const,
      title: `Node ${id}`,
      body: `Body ${id}`,
      entities: ['bug_ent'],
      tokens: tokenizeAssociationText(`Node ${id}`),
      createdAt: now,
      updatedAt: now,
    })

    const eFg = computeDeterministicEdgeId('a:m-seed', 'a:m-fg', 'entity')
    const eOverMax = computeDeterministicEdgeId('a:m-seed', 'a:m-over', 'entity')
    store.upsertBatch({
      nodes: [
        makeNode('a:m-seed', 'memory', 'memory:seed'),
        makeNode('a:m-fg', 'memory', 'memory:fg'),
        makeNode('a:g-goal-1', 'goal', 'goal:1'),
        makeNode('a:m-over', 'memory', 'memory:over'),
      ],
      edges: [
        {
          edgeId: eFg,
          aId: 'a:m-seed',
          bId: 'a:m-fg',
          edgeType: 'entity',
          weight: 1.0,
          trust: 'trusted',
          reason: 'entity:bug',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: eOverMax,
          aId: 'a:m-seed',
          bId: 'a:m-over',
          edgeType: 'entity',
          weight: 5.0,
          trust: 'trusted',
          reason: 'entity:over',
          createdAt: now,
          updatedAt: now,
        },
      ],
      derivedRefs: [],
    })

    // Record foreground exposure sharing session_id = 'sess-shared' with Hop-0 co-activation to non-exposed a:g-goal-1
    store.recordMetricsAndExposures(
      [],
      [
        {
          taskId: 'foreground-turn:fg-1',
          nodeId: 'a:m-fg',
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now,
          wasExposed: true,
          hop: 0,
          provenanceEdges: [{ edgeId: eFg, aId: 'a:m-seed', bId: 'a:m-fg', edgeType: 'entity' }],
          sessionId: 'sess-shared',
        },
      ],
    )
    store.applyHebbianUse({
      useKind: 'strong',
      taskId: 'foreground-turn:fg-1',
      ownerScopeKey,
      nodeId: 'a:m-fg',
      sessionId: 'sess-shared',
      coActivatedNodeIds: ['a:g-goal-1'],
      nowMs: now + 10,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })

    // Create an explicit Hop-0 hebbian edge from a:m-fg to a:g-goal-1 and record event (simulate Hop-0 strong-use with empty provenanceEdges)
    const eHebGoal = computeDeterministicEdgeId('a:m-fg', 'a:g-goal-1', 'hebbian')
    store.recordMetricsAndExposures(
      [],
      [
        {
          taskId: 'foreground-turn:fg-goal',
          nodeId: 'a:m-fg',
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now + 20,
          wasExposed: true,
          hop: 0,
          sessionId: 'sess-shared',
        },
      ],
    )
    store.applyHebbianUse({
      useKind: 'strong',
      taskId: 'foreground-turn:fg-goal',
      ownerScopeKey,
      nodeId: 'a:m-fg',
      sessionId: 'sess-shared',
      coActivatedNodeIds: ['a:g-goal-1'],
      nowMs: now + 30,
      hebbianConfig: { ...DEFAULT_HEBBIAN_CONFIG, initialHebbianWeight: 0.55, alpha: 0.25 },
    })
    const hebGoalBefore = store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === eHebGoal)!.weight
    expect(hebGoalBefore).toBeCloseTo(0.8, 6)

    // BUG-3B: Non-foreground task with 0 exposures MUST NOT fall back to foreground-turn:% in same session
    expect(
      store.applyHebbianCorrection({
        ownerScopeKey,
        taskId: 'automation-run:empty',
        sessionId: 'sess-shared',
        nowMs: now + 40,
        hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
      }).correctedExposures,
    ).toBe(0)
    // BUG-3B: Different foreground-turn:% task with 0 exposures MUST NOT fall back across foreground turns in same session
    expect(
      store.applyHebbianCorrection({
        ownerScopeKey,
        taskId: 'foreground-turn:fg-other',
        sessionId: 'sess-shared',
        nowMs: now + 45,
        hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
      }).correctedExposures,
    ).toBe(0)
    expect(
      store.findExposuresByTaskOrSession(ownerScopeKey, 'automation-run:empty', 'sess-shared'),
    ).toHaveLength(0)

    // BUG-3A: Correcting foreground-turn:fg-goal MUST penalize eHebGoal even though a:g-goal-1 is not in assoc_exposures!
    const corrGoal = store.applyHebbianCorrection({
      ownerScopeKey,
      taskId: 'foreground-turn:fg-goal',
      nowMs: now + 50,
      hebbianConfig: DEFAULT_HEBBIAN_CONFIG,
    })
    expect(corrGoal.correctedExposures).toBe(1)
    expect(corrGoal.updatedEdges).toBe(1)
    const hebGoalAfter = store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === eHebGoal)!.weight
    expect(hebGoalAfter).toBeCloseTo(0.8 - DEFAULT_HEBBIAN_CONFIG.beta, 6)

    // BUG-4: Edge with weight 5.0 > wMax (2.5) clamps to 2.5 BEFORE exponential decay -> semigroup invariant
    const grace = 1_000
    const halfLife = 10_000
    for (let step = 1; step <= 10; step += 1) {
      store.applyHebbianDecayBatch({
        nowMs: now + grace + step * 1_000,
        decayHalfLifeMs: halfLife,
        nonUseGraceMs: grace,
        weightMin: 0.05,
        weightMax: 2.5,
        limit: 200,
      })
    }
    const overAfter10d = store.loadActiveEdgesPage(10, 0).find((e) => e.edgeId === eOverMax)!.weight
    expect(overAfter10d).toBeCloseTo(1.25, 8)

    store.close()
  })
})
