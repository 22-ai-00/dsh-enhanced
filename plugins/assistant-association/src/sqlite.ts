import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AssociationNodeMetadata,
  AssociationNodeStatus,
  AssociationOwnerMode,
  AssociationOwnerScope,
  AssociationScopeMode,
  AssociationSensitivity,
  AssociationTrust,
  DerivedRefInput,
  EdgeType,
  ExposureRow,
  HoldoutAssignmentRow,
  HoldoutTaskKind,
  IngestCursorRow,
  NodeKind,
  StepMetricRow,
  StoredAssociationEdge,
  StoredAssociationNode,
  StoredAssociationSynonym,
  UpsertEdgeInput,
  UpsertNodeInput,
  UpsertSynonymInput,
} from './types.js'

export const ASSOCIATION_SCHEMA_VERSION = 1

export type AssociationDatabaseErrorCode =
  | 'invalid-path'
  | 'unsafe-file'
  | 'schema-too-new'
  | 'schema-drift'

export class AssociationDatabaseError extends Error {
  constructor(
    readonly code: AssociationDatabaseErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AssociationDatabaseError'
  }
}

export function assertSafePrivateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new AssociationDatabaseError(
      'unsafe-file',
      'association database must be one regular, unlinked file',
    )
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AssociationDatabaseError(
      'unsafe-file',
      'association database permissions must not allow group or other access',
    )
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new AssociationDatabaseError(
      'unsafe-file',
      'association database must be owned by the current OS user',
    )
  }
}

function preparePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    closeSync(fd)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  assertSafePrivateFile(path)
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try {
      assertSafePrivateFile(sidecar)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
}

const walRetryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function enableWal(database: DatabaseSync): void {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      const row = database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }
      if (row.journal_mode.toLowerCase() !== 'wal') {
        throw new Error(`association database refused WAL mode: ${row.journal_mode}`)
      }
      return
    } catch (error) {
      const retryable = error instanceof Error && /database is (?:busy|locked)/i.test(error.message)
      if (!retryable || Date.now() >= deadline) throw error
      Atomics.wait(walRetryWait, 0, 0, 10)
    }
  }
}

function createV1Schema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    INSERT INTO schema_meta(key, value) VALUES ('schema-version', '1');

    CREATE TABLE assoc_nodes (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
      kind TEXT NOT NULL CHECK (kind IN (
        'memory', 'goal', 'work-item', 'automation', 'episode',
        'wiki', 'skill', 'event', 'dream', 'abstraction', 'web'
      )),
      source_plugin TEXT NOT NULL CHECK (length(source_plugin) BETWEEN 1 AND 64),
      source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 512),
      source_version INTEGER NOT NULL CHECK (source_version >= 0),
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      owner_mode TEXT NOT NULL CHECK (owner_mode IN ('delivery', 'headless', 'system')),
      principal_digest TEXT CHECK (principal_digest IS NULL OR (length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^0-9a-f]*')),
      principal_record_id TEXT,
      principal_version INTEGER CHECK (principal_version IS NULL OR principal_version >= 1),
      scope_mode TEXT NOT NULL CHECK (scope_mode IN ('user-global', 'workspace')),
      workspace TEXT NOT NULL,
      agent_preset TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'low')),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('private', 'sensitive')),
      title TEXT NOT NULL CHECK (length(title) <= 512),
      body TEXT NOT NULL,
      entities_json TEXT NOT NULL CHECK (json_valid(entities_json)),
      tokens_json TEXT NOT NULL CHECK (json_valid(tokens_json)),
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      ttl_ms INTEGER CHECK (ttl_ms IS NULL OR ttl_ms > 0),
      expires_at INTEGER CHECK (expires_at IS NULL OR expires_at >= 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'suppressed', 'withdrawn')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      UNIQUE (owner_scope_key, source_plugin, kind, source_ref),
      CHECK (
        (owner_mode = 'delivery' AND principal_digest IS NOT NULL AND principal_record_id IS NOT NULL AND principal_record_id <> '' AND principal_version IS NOT NULL)
        OR (owner_mode IN ('headless', 'system') AND principal_record_id IS NULL AND principal_version IS NULL)
      )
    ) STRICT;

    CREATE INDEX assoc_nodes_active_scope ON assoc_nodes(status, owner_scope_key, updated_at DESC);
    CREATE INDEX assoc_nodes_source_lookup ON assoc_nodes(owner_scope_key, source_plugin, source_ref);
    CREATE INDEX assoc_nodes_expires ON assoc_nodes(expires_at) WHERE expires_at IS NOT NULL;

    CREATE TABLE assoc_edges (
      edge_id TEXT PRIMARY KEY CHECK (length(edge_id) = 64 AND edge_id NOT GLOB '*[^0-9a-f]*'),
      a_id TEXT NOT NULL REFERENCES assoc_nodes(id) ON DELETE CASCADE,
      b_id TEXT NOT NULL REFERENCES assoc_nodes(id) ON DELETE CASCADE,
      edge_type TEXT NOT NULL CHECK (edge_type IN ('cooccur', 'entity', 'dream', 'hebbian', 'synonym', 'abstraction')),
      weight REAL NOT NULL CHECK (weight >= 0.0 AND weight <= 10.0),
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'low')),
      reason TEXT NOT NULL CHECK (length(reason) <= 256),
      use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
      last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (a_id <> b_id),
      UNIQUE (a_id, b_id, edge_type)
    ) STRICT;

    CREATE INDEX assoc_edges_a ON assoc_edges(a_id, weight DESC);
    CREATE INDEX assoc_edges_b ON assoc_edges(b_id, weight DESC);

    CREATE TABLE assoc_synonyms (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      surface TEXT NOT NULL CHECK (length(surface) BETWEEN 1 AND 256),
      canonical_entity TEXT NOT NULL CHECK (length(canonical_entity) BETWEEN 1 AND 256),
      source_node_id TEXT REFERENCES assoc_nodes(id) ON DELETE CASCADE,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'low')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      UNIQUE (owner_scope_key, surface, canonical_entity)
    ) STRICT;

    CREATE TABLE assoc_derived_from (
      source_node_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version >= 0),
      target_kind TEXT NOT NULL CHECK (target_kind IN ('node', 'edge', 'synonym')),
      target_id TEXT NOT NULL,
      PRIMARY KEY (source_node_id, source_version, target_kind, target_id)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX assoc_derived_from_target ON assoc_derived_from(target_kind, target_id);

    CREATE TABLE assoc_ingest_cursors (
      source_plugin TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (source_plugin, scope_key)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE assoc_holdout_assignments (
      task_id TEXT PRIMARY KEY CHECK (length(task_id) BETWEEN 1 AND 512),
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      task_kind TEXT NOT NULL CHECK (task_kind IN (
        'foreground-turn', 'automation-run', 'goal-step', 'goal-outcome', 'work-item', 'headless-session'
      )),
      session_id TEXT,
      turn_number INTEGER CHECK (turn_number IS NULL OR turn_number >= 0),
      in_holdout INTEGER NOT NULL CHECK (in_holdout IN (0, 1)),
      bucket_bps INTEGER NOT NULL CHECK (bucket_bps >= 0 AND bucket_bps < 10000),
      rate_bps INTEGER NOT NULL CHECK (rate_bps >= 1000 AND rate_bps <= 1500),
      hmac_digest TEXT NOT NULL CHECK (length(hmac_digest) = 64 AND hmac_digest NOT GLOB '*[^0-9a-f]*'),
      assigned_at INTEGER NOT NULL CHECK (assigned_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_holdout_scope_time ON assoc_holdout_assignments(owner_scope_key, in_holdout, assigned_at DESC);
    CREATE INDEX assoc_holdout_session ON assoc_holdout_assignments(session_id, turn_number) WHERE session_id IS NOT NULL;

    CREATE TABLE assoc_step_metrics (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      in_holdout INTEGER NOT NULL CHECK (in_holdout IN (0, 1)),
      latency_us INTEGER NOT NULL CHECK (latency_us >= 0),
      timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
      fallback_mode TEXT NOT NULL CHECK (fallback_mode IN ('none', 'memory-only', 'cold-start', 'timeout', 'holdout')),
      injected_count INTEGER NOT NULL CHECK (injected_count >= 0),
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      source_counts_json TEXT NOT NULL CHECK (json_valid(source_counts_json)),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT;

    CREATE INDEX assoc_step_metrics_time ON assoc_step_metrics(occurred_at DESC, seq DESC);

    CREATE TABLE assoc_exposures (
      task_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      source_plugin TEXT NOT NULL,
      exposed_at INTEGER NOT NULL CHECK (exposed_at >= 0),
      assoc_read_count INTEGER NOT NULL DEFAULT 0 CHECK (assoc_read_count >= 0),
      weak_use_count INTEGER NOT NULL DEFAULT 0 CHECK (weak_use_count >= 0),
      corrected INTEGER NOT NULL DEFAULT 0 CHECK (corrected IN (0, 1)),
      PRIMARY KEY (task_id, node_id)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX assoc_exposures_scope_time ON assoc_exposures(owner_scope_key, exposed_at DESC);

    CREATE TABLE assoc_withdrawn_sources (
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      source_plugin TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      withdrawn_at INTEGER NOT NULL CHECK (withdrawn_at >= 0),
      PRIMARY KEY (owner_scope_key, source_plugin, source_ref)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE assoc_owner_scopes (
      owner_scope_key TEXT PRIMARY KEY CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      mode TEXT NOT NULL CHECK (mode IN ('delivery', 'headless', 'system')),
      principal_id TEXT NOT NULL,
      principal_digest TEXT NOT NULL CHECK (length(principal_digest) = 64 AND principal_digest NOT GLOB '*[^0-9a-f]*'),
      principal_record_id TEXT,
      principal_version INTEGER CHECK (principal_version IS NULL OR principal_version >= 1),
      workspace TEXT NOT NULL,
      agent_preset TEXT NOT NULL,
      authority_id TEXT,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;
  `)
}

function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (row.user_version > ASSOCIATION_SCHEMA_VERSION) {
      throw new AssociationDatabaseError(
        'schema-too-new',
        `association schema ${row.user_version} is newer than supported schema ${ASSOCIATION_SCHEMA_VERSION}`,
      )
    }
    if (row.user_version === 0) {
      createV1Schema(database)
      database.exec(`PRAGMA user_version = ${ASSOCIATION_SCHEMA_VERSION}`)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function openAssociationDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && (!isAbsolute(path) || resolve(path) !== path)) {
    throw new AssociationDatabaseError(
      'invalid-path',
      'association database path must be :memory: or a canonical absolute path',
    )
  }
  if (path !== ':memory:') {
    preparePrivateFile(path)
  }
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA synchronous = FULL')
    database.exec('PRAGMA secure_delete = ON')
    migrate(database)
    if (path !== ':memory:') {
      enableWal(database)
      chmodSync(path, 0o600)
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        try {
          chmodSync(sidecar, 0o600)
          assertSafePrivateFile(sidecar)
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

interface RawNodeRow {
  id: string
  kind: NodeKind
  source_plugin: string
  source_ref: string
  source_version: number
  owner_scope_key: string
  owner_mode: AssociationOwnerMode
  principal_digest: string | null
  principal_record_id: string | null
  principal_version: number | null
  scope_mode: AssociationScopeMode
  workspace: string
  agent_preset: string
  trust: AssociationTrust
  sensitivity: AssociationSensitivity
  title: string
  body: string
  entities_json: string
  tokens_json: string
  metadata_json: string
  ttl_ms: number | null
  expires_at: number | null
  status: AssociationNodeStatus
  created_at: number
  updated_at: number
}

function mapRawNode(row: RawNodeRow): StoredAssociationNode {
  return {
    id: row.id,
    kind: row.kind,
    sourcePlugin: row.source_plugin,
    sourceRef: row.source_ref,
    sourceVersion: row.source_version,
    ownerScopeKey: row.owner_scope_key,
    ownerMode: row.owner_mode,
    principalDigest: row.principal_digest,
    principalRecordId: row.principal_record_id,
    principalVersion: row.principal_version,
    scopeMode: row.scope_mode,
    workspace: row.workspace,
    agentPreset: row.agent_preset,
    trust: row.trust,
    sensitivity: row.sensitivity,
    title: row.title,
    body: row.body,
    entities: JSON.parse(row.entities_json) as string[],
    tokens: JSON.parse(row.tokens_json) as string[],
    metadata: JSON.parse(row.metadata_json) as AssociationNodeMetadata,
    ttlMs: row.ttl_ms,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface WithdrawalCascadeResult {
  readonly deletedNodeIds: readonly string[]
  readonly suppressedNodeIds: readonly string[]
  readonly deletedEdgeIds: readonly string[]
  readonly deletedSynonymIds: readonly string[]
}

export class AssociationStore {
  readonly #db: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#db = database
  }

  get database(): DatabaseSync {
    return this.#db
  }

  close(): void {
    this.#db.close()
  }

  runInTransaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  upsertBatch(input: {
    readonly nodes: readonly UpsertNodeInput[]
    readonly edges: readonly UpsertEdgeInput[]
    readonly synonyms?: readonly UpsertSynonymInput[]
    readonly derivedRefs: readonly DerivedRefInput[]
    readonly cursor?: {
      readonly sourcePlugin: string
      readonly scopeKey: string
      readonly cursorJson: string
      readonly updatedAt?: number
    }
  }): WithdrawalCascadeResult {
    return this.runInTransaction(() => {
      const selectExisting = this.#db.prepare(
        'SELECT id, source_version FROM assoc_nodes WHERE id = ?',
      )
      const checkWithdrawnStmt = this.#db.prepare(
        'SELECT 1 AS ok FROM assoc_withdrawn_sources WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      const upsertNodeStmt = this.#db.prepare(`
        INSERT INTO assoc_nodes (
          id, kind, source_plugin, source_ref, source_version,
          owner_scope_key, owner_mode, principal_digest, principal_record_id, principal_version,
          scope_mode, workspace, agent_preset, trust, sensitivity,
          title, body, entities_json, tokens_json, metadata_json,
          ttl_ms, expires_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          source_plugin = excluded.source_plugin,
          source_ref = excluded.source_ref,
          source_version = excluded.source_version,
          owner_scope_key = excluded.owner_scope_key,
          owner_mode = excluded.owner_mode,
          principal_digest = excluded.principal_digest,
          principal_record_id = excluded.principal_record_id,
          principal_version = excluded.principal_version,
          scope_mode = excluded.scope_mode,
          workspace = excluded.workspace,
          agent_preset = excluded.agent_preset,
          trust = excluded.trust,
          sensitivity = excluded.sensitivity,
          title = excluded.title,
          body = excluded.body,
          entities_json = excluded.entities_json,
          tokens_json = excluded.tokens_json,
          metadata_json = excluded.metadata_json,
          ttl_ms = excluded.ttl_ms,
          expires_at = excluded.expires_at,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)

      const deletedNodeIds: string[] = []
      const deletedEdgeIds: string[] = []
      const deletedSynonymIds: string[] = []
      const skippedWithdrawnNodeIds = new Set<string>()

      for (const node of input.nodes) {
        if (
          checkWithdrawnStmt.get(node.ownerScopeKey, node.sourcePlugin, node.sourceRef) !==
          undefined
        ) {
          skippedWithdrawnNodeIds.add(node.id)
          continue
        }
        const existing = selectExisting.get(node.id) as
          | { id: string; source_version: number }
          | undefined
        if (existing !== undefined && existing.source_version !== node.sourceVersion) {
          const cascade = this.#cascadeDerivedInCurrentTx([
            { nodeId: node.id, exactVersion: existing.source_version },
          ])
          deletedNodeIds.push(...cascade.deletedNodeIds)
          deletedEdgeIds.push(...cascade.deletedEdgeIds)
          deletedSynonymIds.push(...cascade.deletedSynonymIds)
        }
        upsertNodeStmt.run(
          node.id,
          node.kind,
          node.sourcePlugin,
          node.sourceRef,
          node.sourceVersion,
          node.ownerScopeKey,
          node.ownerMode,
          node.principalDigest,
          node.principalRecordId,
          node.principalVersion,
          node.scopeMode,
          node.workspace,
          node.agentPreset,
          node.trust,
          node.sensitivity,
          node.title.slice(0, 512),
          node.body,
          JSON.stringify(node.entities),
          JSON.stringify(node.tokens),
          JSON.stringify(node.metadata ?? {}),
          node.ttlMs ?? null,
          node.expiresAt ?? null,
          node.status ?? 'active',
          node.createdAt,
          node.updatedAt,
        )
      }

      if (input.edges.length > 0) {
        const checkNodeExists = this.#db.prepare('SELECT 1 AS ok FROM assoc_nodes WHERE id = ?')
        const upsertEdgeStmt = this.#db.prepare(`
          INSERT INTO assoc_edges (
            edge_id, a_id, b_id, edge_type, weight, trust, reason,
            use_count, last_used_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(a_id, b_id, edge_type) DO UPDATE SET
            weight = excluded.weight,
            trust = excluded.trust,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `)
        for (const edge of input.edges) {
          if (edge.aId === edge.bId) continue
          if (
            checkNodeExists.get(edge.aId) === undefined ||
            checkNodeExists.get(edge.bId) === undefined
          ) {
            continue
          }
          const clampedWeight = Math.min(10.0, Math.max(0.0, edge.weight))
          upsertEdgeStmt.run(
            edge.edgeId,
            edge.aId,
            edge.bId,
            edge.edgeType,
            clampedWeight,
            edge.trust,
            edge.reason.slice(0, 256),
            edge.useCount ?? 0,
            edge.lastUsedAt ?? null,
            edge.createdAt,
            edge.updatedAt,
          )
        }
      }

      if (input.synonyms && input.synonyms.length > 0) {
        const upsertSynonymStmt = this.#db.prepare(`
          INSERT INTO assoc_synonyms (
            id, owner_scope_key, surface, canonical_entity, source_node_id, trust, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_scope_key, surface, canonical_entity) DO UPDATE SET
            source_node_id = excluded.source_node_id,
            trust = excluded.trust
        `)
        for (const syn of input.synonyms) {
          upsertSynonymStmt.run(
            syn.id,
            syn.ownerScopeKey,
            syn.surface,
            syn.canonicalEntity,
            syn.sourceNodeId ?? null,
            syn.trust,
            syn.createdAt,
          )
        }
      }

      if (input.derivedRefs.length > 0) {
        const insertDerivedStmt = this.#db.prepare(`
          INSERT OR IGNORE INTO assoc_derived_from (
            source_node_id, source_version, target_kind, target_id
          ) VALUES (?, ?, ?, ?)
        `)
        for (const ref of input.derivedRefs) {
          if (
            skippedWithdrawnNodeIds.has(ref.sourceNodeId) ||
            (ref.targetKind === 'node' && skippedWithdrawnNodeIds.has(ref.targetId))
          ) {
            continue
          }
          insertDerivedStmt.run(
            ref.sourceNodeId,
            ref.sourceVersion,
            ref.targetKind,
            ref.targetId,
          )
        }
      }

      if (input.cursor) {
        this.#db
          .prepare(`
            INSERT INTO assoc_ingest_cursors (source_plugin, scope_key, cursor_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(source_plugin, scope_key) DO UPDATE SET
              cursor_json = excluded.cursor_json,
              updated_at = excluded.updated_at
          `)
          .run(
            input.cursor.sourcePlugin,
            input.cursor.scopeKey,
            input.cursor.cursorJson,
            input.cursor.updatedAt ?? Date.now(),
          )
      }

      return {
        deletedNodeIds,
        suppressedNodeIds: [],
        deletedEdgeIds,
        deletedSynonymIds,
      }
    })
  }

  withdrawSource(input: {
    readonly ownerScopeKey: string
    readonly sourcePlugin: string
    readonly sourceRef: string
    readonly hardDelete: boolean
    readonly maxSourceVersion?: number
    readonly recordWithdrawalTombstone?: boolean
    readonly nowMs?: number
  }): WithdrawalCascadeResult {
    return this.runInTransaction(() => {
      const matchingNodes = this.#db
        .prepare(`
          SELECT id, source_version FROM assoc_nodes
          WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?
        `)
        .all(input.ownerScopeKey, input.sourcePlugin, input.sourceRef) as Array<{
        id: string
        source_version: number
      }>

      const seeds: Array<{ nodeId: string; maxVersion?: number }> = matchingNodes.map((row) =>
        input.maxSourceVersion === undefined
          ? { nodeId: row.id }
          : { nodeId: row.id, maxVersion: input.maxSourceVersion },
      )

      const cascade = this.#cascadeDerivedInCurrentTx(seeds)
      const deletedNodeSet = new Set(cascade.deletedNodeIds)
      const deletedEdgeSet = new Set(cascade.deletedEdgeIds)
      const suppressedNodeIds: string[] = []

      const selectIncidentEdges = this.#db.prepare(
        'SELECT edge_id FROM assoc_edges WHERE a_id = ? OR b_id = ?',
      )
      const deleteEdgeById = this.#db.prepare('DELETE FROM assoc_edges WHERE edge_id = ?')
      const deleteNodeById = this.#db.prepare('DELETE FROM assoc_nodes WHERE id = ?')
      const suppressNodeById = this.#db.prepare(
        "UPDATE assoc_nodes SET status = 'suppressed', updated_at = ? WHERE id = ?",
      )
      const nowMs = input.nowMs ?? Date.now()

      for (const row of matchingNodes) {
        const incident = selectIncidentEdges.all(row.id, row.id) as Array<{ edge_id: string }>
        for (const edge of incident) {
          deletedEdgeSet.add(edge.edge_id)
          deleteEdgeById.run(edge.edge_id)
        }
        if (input.hardDelete) {
          deletedNodeSet.add(row.id)
          deleteNodeById.run(row.id)
        } else {
          suppressedNodeIds.push(row.id)
          suppressNodeById.run(nowMs, row.id)
        }
      }

      if (input.recordWithdrawalTombstone) {
        this.#db
          .prepare(`
            INSERT INTO assoc_withdrawn_sources (owner_scope_key, source_plugin, source_ref, withdrawn_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(owner_scope_key, source_plugin, source_ref) DO UPDATE SET
              withdrawn_at = excluded.withdrawn_at
          `)
          .run(input.ownerScopeKey, input.sourcePlugin, input.sourceRef, nowMs)
      }

      return {
        deletedNodeIds: [...deletedNodeSet],
        suppressedNodeIds,
        deletedEdgeIds: [...deletedEdgeSet],
        deletedSynonymIds: cascade.deletedSynonymIds,
      }
    })
  }

  #cascadeDerivedInCurrentTx(
    seeds: readonly {
      readonly nodeId: string
      readonly maxVersion?: number
      readonly exactVersion?: number
    }[],
  ): {
    readonly deletedNodeIds: string[]
    readonly deletedEdgeIds: string[]
    readonly deletedSynonymIds: string[]
  } {
    if (seeds.length === 0) {
      return { deletedNodeIds: [], deletedEdgeIds: [], deletedSynonymIds: [] }
    }

    const selectAllBySource = this.#db.prepare(
      'SELECT target_kind, target_id FROM assoc_derived_from WHERE source_node_id = ?',
    )
    const selectUpToVersionBySource = this.#db.prepare(
      'SELECT target_kind, target_id FROM assoc_derived_from WHERE source_node_id = ? AND source_version <= ?',
    )
    const selectExactVersionBySource = this.#db.prepare(
      'SELECT target_kind, target_id FROM assoc_derived_from WHERE source_node_id = ? AND source_version = ?',
    )

    const visitedNodes = new Set<string>()
    const deletedNodeIds = new Set<string>()
    const deletedEdgeIds = new Set<string>()
    const deletedSynonymIds = new Set<string>()
    const queue: Array<{
      readonly nodeId: string
      readonly maxVersion?: number
      readonly exactVersion?: number
    }> = [...seeds]

    while (queue.length > 0) {
      const current = queue.shift()!
      const visitKey =
        current.exactVersion !== undefined
          ? `${current.nodeId}:eq:${current.exactVersion}`
          : current.maxVersion !== undefined
            ? `${current.nodeId}:le:${current.maxVersion}`
            : `${current.nodeId}:*`
      if (visitedNodes.has(visitKey)) continue
      visitedNodes.add(visitKey)

      const rows = (
        current.exactVersion !== undefined
          ? selectExactVersionBySource.all(current.nodeId, current.exactVersion)
          : current.maxVersion === undefined
            ? selectAllBySource.all(current.nodeId)
            : selectUpToVersionBySource.all(current.nodeId, current.maxVersion)
      ) as Array<{ target_kind: 'node' | 'edge' | 'synonym'; target_id: string }>

      for (const row of rows) {
        if (row.target_kind === 'edge') {
          deletedEdgeIds.add(row.target_id)
        } else if (row.target_kind === 'synonym') {
          deletedSynonymIds.add(row.target_id)
        } else if (row.target_kind === 'node') {
          if (!deletedNodeIds.has(row.target_id)) {
            deletedNodeIds.add(row.target_id)
            queue.push({ nodeId: row.target_id })
          }
        }
      }
    }

    const deleteDerivedByTarget = this.#db.prepare(
      'DELETE FROM assoc_derived_from WHERE target_kind = ? AND target_id = ?',
    )
    const deleteSynonymById = this.#db.prepare('DELETE FROM assoc_synonyms WHERE id = ?')
    const deleteEdgeById = this.#db.prepare('DELETE FROM assoc_edges WHERE edge_id = ?')
    const selectIncidentEdges = this.#db.prepare(
      'SELECT edge_id FROM assoc_edges WHERE a_id = ? OR b_id = ?',
    )
    const deleteNodeById = this.#db.prepare('DELETE FROM assoc_nodes WHERE id = ?')
    const deleteDerivedBySourceAll = this.#db.prepare(
      'DELETE FROM assoc_derived_from WHERE source_node_id = ?',
    )
    const deleteDerivedBySourceVersion = this.#db.prepare(
      'DELETE FROM assoc_derived_from WHERE source_node_id = ? AND source_version <= ?',
    )
    const deleteDerivedBySourceExact = this.#db.prepare(
      'DELETE FROM assoc_derived_from WHERE source_node_id = ? AND source_version = ?',
    )

    for (const synId of deletedSynonymIds) {
      deleteSynonymById.run(synId)
      deleteDerivedByTarget.run('synonym', synId)
    }

    for (const nodeId of deletedNodeIds) {
      const incident = selectIncidentEdges.all(nodeId, nodeId) as Array<{ edge_id: string }>
      for (const edge of incident) {
        deletedEdgeIds.add(edge.edge_id)
      }
    }

    for (const edgeId of deletedEdgeIds) {
      deleteEdgeById.run(edgeId)
      deleteDerivedByTarget.run('edge', edgeId)
    }

    for (const nodeId of deletedNodeIds) {
      deleteNodeById.run(nodeId)
      deleteDerivedByTarget.run('node', nodeId)
      deleteDerivedBySourceAll.run(nodeId)
    }

    for (const seed of seeds) {
      if (seed.exactVersion !== undefined) {
        deleteDerivedBySourceExact.run(seed.nodeId, seed.exactVersion)
      } else if (seed.maxVersion === undefined) {
        deleteDerivedBySourceAll.run(seed.nodeId)
      } else {
        deleteDerivedBySourceVersion.run(seed.nodeId, seed.maxVersion)
      }
    }

    return {
      deletedNodeIds: [...deletedNodeIds],
      deletedEdgeIds: [...deletedEdgeIds],
      deletedSynonymIds: [...deletedSynonymIds],
    }
  }

  getNodeById(id: string): StoredAssociationNode | null {
    const row = this.#db
      .prepare('SELECT * FROM assoc_nodes WHERE id = ?')
      .get(id) as RawNodeRow | undefined
    return row === undefined ? null : mapRawNode(row)
  }

  attachNodeOutcomeId(nodeId: string, outcomeId: string): boolean {
    const row = this.#db
      .prepare('SELECT metadata_json FROM assoc_nodes WHERE id = ?')
      .get(nodeId) as { metadata_json: string } | undefined
    if (row === undefined) return false
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>
    const prevExtra =
      meta.extra !== null && typeof meta.extra === 'object' && !Array.isArray(meta.extra)
        ? (meta.extra as Record<string, unknown>)
        : {}
    if (prevExtra.outcomeId === outcomeId) return false
    const nextMeta = {
      ...meta,
      extra: {
        ...prevExtra,
        outcomeId,
      },
    }
    this.#db
      .prepare('UPDATE assoc_nodes SET metadata_json = ? WHERE id = ?')
      .run(JSON.stringify(nextMeta), nodeId)
    return true
  }

  isSourceWithdrawn(ownerScopeKey: string, sourcePlugin: string, sourceRef: string): boolean {
    const row = this.#db
      .prepare(
        'SELECT 1 AS ok FROM assoc_withdrawn_sources WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      .get(ownerScopeKey, sourcePlugin, sourceRef) as { ok: number } | undefined
    return row !== undefined
  }

  countActiveNodes(): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS cnt FROM assoc_nodes WHERE status = 'active'")
      .get() as { cnt: number }
    return row.cnt
  }

  loadActiveNodesPage(limit: number, offset: number): StoredAssociationNode[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM assoc_nodes WHERE status = 'active' ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as unknown as RawNodeRow[]
    return rows.map(mapRawNode)
  }

  loadActiveEdgesPage(limit: number, offset: number): StoredAssociationEdge[] {
    const rows = this.#db
      .prepare(`
        SELECT e.edge_id, e.a_id, e.b_id, e.edge_type, e.weight, e.trust, e.reason,
               e.use_count, e.last_used_at, e.created_at, e.updated_at
        FROM assoc_edges e
        JOIN assoc_nodes a ON a.id = e.a_id AND a.status = 'active'
        JOIN assoc_nodes b ON b.id = e.b_id AND b.status = 'active'
        ORDER BY e.edge_id ASC
        LIMIT ? OFFSET ?
      `)
      .all(limit, offset) as Array<{
      edge_id: string
      a_id: string
      b_id: string
      edge_type: EdgeType
      weight: number
      trust: AssociationTrust
      reason: string
      use_count: number
      last_used_at: number | null
      created_at: number
      updated_at: number
    }>
    return rows.map((row) => ({
      edgeId: row.edge_id,
      aId: row.a_id,
      bId: row.b_id,
      edgeType: row.edge_type,
      weight: row.weight,
      trust: row.trust,
      reason: row.reason,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  loadActiveSynonymsPage(limit: number, offset: number): StoredAssociationSynonym[] {
    const rows = this.#db
      .prepare('SELECT * FROM assoc_synonyms ORDER BY id ASC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<{
      id: string
      owner_scope_key: string
      surface: string
      canonical_entity: string
      source_node_id: string | null
      trust: AssociationTrust
      created_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      ownerScopeKey: row.owner_scope_key,
      surface: row.surface,
      canonicalEntity: row.canonical_entity,
      sourceNodeId: row.source_node_id,
      trust: row.trust,
      createdAt: row.created_at,
    }))
  }

  getIngestCursor(sourcePlugin: string, scopeKey: string): IngestCursorRow | null {
    const row = this.#db
      .prepare('SELECT * FROM assoc_ingest_cursors WHERE source_plugin = ? AND scope_key = ?')
      .get(sourcePlugin, scopeKey) as
      | {
          source_plugin: string
          scope_key: string
          cursor_json: string
          updated_at: number
        }
      | undefined
    if (row === undefined) return null
    return {
      sourcePlugin: row.source_plugin,
      scopeKey: row.scope_key,
      cursorJson: row.cursor_json,
      updatedAt: row.updated_at,
    }
  }

  upsertIngestCursor(cursor: IngestCursorRow): void {
    this.#db
      .prepare(`
        INSERT INTO assoc_ingest_cursors (source_plugin, scope_key, cursor_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source_plugin, scope_key) DO UPDATE SET
          cursor_json = excluded.cursor_json,
          updated_at = excluded.updated_at
      `)
      .run(cursor.sourcePlugin, cursor.scopeKey, cursor.cursorJson, cursor.updatedAt)
  }

  upsertOwnerScope(scope: AssociationOwnerScope, nowMs = Date.now()): void {
    this.#db
      .prepare(`
        INSERT INTO assoc_owner_scopes (
          owner_scope_key, mode, principal_id, principal_digest,
          principal_record_id, principal_version, workspace, agent_preset,
          authority_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_scope_key) DO UPDATE SET
          authority_id = COALESCE(excluded.authority_id, assoc_owner_scopes.authority_id),
          updated_at = excluded.updated_at
      `)
      .run(
        scope.ownerScopeKey,
        scope.mode,
        scope.principalId,
        scope.principalDigest,
        scope.principalRecordId,
        scope.principalVersion,
        scope.workspace,
        scope.agentPreset,
        scope.authorityId ?? null,
        nowMs,
      )
  }

  listOwnerScopes(): AssociationOwnerScope[] {
    const rows = this.#db
      .prepare('SELECT * FROM assoc_owner_scopes ORDER BY updated_at DESC, owner_scope_key ASC')
      .all() as Array<{
      owner_scope_key: string
      mode: AssociationOwnerMode
      principal_id: string
      principal_digest: string
      principal_record_id: string | null
      principal_version: number | null
      workspace: string
      agent_preset: string
      authority_id: string | null
    }>
    return rows.map((row) => ({
      mode: row.mode,
      ownerScopeKey: row.owner_scope_key,
      principalId: row.principal_id,
      principalDigest: row.principal_digest,
      principalRecordId: row.principal_record_id,
      principalVersion: row.principal_version,
      workspace: row.workspace,
      agentPreset: row.agent_preset,
      ...(row.authority_id === null ? {} : { authorityId: row.authority_id }),
    }))
  }

  findNodeBySourceRef(
    ownerScopeKey: string,
    sourcePlugin: string,
    sourceRef: string,
  ): StoredAssociationNode | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM assoc_nodes WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      .get(ownerScopeKey, sourcePlugin, sourceRef) as RawNodeRow | undefined
    return row === undefined ? null : mapRawNode(row)
  }

  listCascadeNodeIdsForSource(
    ownerScopeKey: string,
    sourcePlugin: string,
    sourceRef: string,
  ): string[] {
    const matching = this.#db
      .prepare(
        'SELECT id FROM assoc_nodes WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?',
      )
      .all(ownerScopeKey, sourcePlugin, sourceRef) as Array<{ id: string }>
    if (matching.length === 0) return []
    const selectDerivedNodes = this.#db.prepare(
      "SELECT target_id FROM assoc_derived_from WHERE source_node_id = ? AND target_kind = 'node'",
    )
    const visited = new Set<string>()
    const queue: string[] = []
    for (const row of matching) {
      if (!visited.has(row.id)) {
        visited.add(row.id)
        queue.push(row.id)
      }
    }
    while (queue.length > 0) {
      const current = queue.shift()!
      const children = selectDerivedNodes.all(current) as Array<{ target_id: string }>
      for (const child of children) {
        if (!visited.has(child.target_id)) {
          visited.add(child.target_id)
          queue.push(child.target_id)
        }
      }
    }
    return [...visited]
  }

  loadEntityCandidateNodesForScope(
    ownerScopeKey: string,
    limit = 256,
  ): Array<{
    readonly id: string
    readonly sourceVersion: number
    readonly ownerScopeKey: string
    readonly trust: AssociationTrust
    readonly entities: readonly string[]
    readonly updatedAt: number
  }> {
    const rows = this.#db
      .prepare(`
        SELECT id, source_version, owner_scope_key, trust, entities_json, updated_at
        FROM assoc_nodes
        WHERE status = 'active' AND owner_scope_key = ? AND sensitivity = 'private'
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `)
      .all(ownerScopeKey, limit) as Array<{
      id: string
      source_version: number
      owner_scope_key: string
      trust: AssociationTrust
      entities_json: string
      updated_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      sourceVersion: row.source_version,
      ownerScopeKey: row.owner_scope_key,
      trust: row.trust,
      entities: JSON.parse(row.entities_json) as string[],
      updatedAt: row.updated_at,
    }))
  }

  suppressNodeConflict(input: {
    readonly ownerScopeKey: string
    readonly sourcePlugin: string
    readonly sourceRef: string
    readonly objectiveStatus?: string
    readonly nowMs?: number
  }): WithdrawalCascadeResult {
    return this.runInTransaction(() => {
      const matchingNodes = this.#db
        .prepare(`
          SELECT id, source_version, metadata_json FROM assoc_nodes
          WHERE owner_scope_key = ? AND source_plugin = ? AND source_ref = ?
        `)
        .all(input.ownerScopeKey, input.sourcePlugin, input.sourceRef) as Array<{
        id: string
        source_version: number
        metadata_json: string
      }>

      const seeds = matchingNodes.map((row) => ({
        nodeId: row.id,
        maxVersion: row.source_version,
      }))
      const cascade = this.#cascadeDerivedInCurrentTx(seeds)
      const deletedEdgeSet = new Set(cascade.deletedEdgeIds)
      const suppressedNodeIds: string[] = []
      const nowMs = input.nowMs ?? Date.now()

      const selectIncidentEdges = this.#db.prepare(
        'SELECT edge_id FROM assoc_edges WHERE a_id = ? OR b_id = ?',
      )
      const deleteEdgeById = this.#db.prepare('DELETE FROM assoc_edges WHERE edge_id = ?')
      const updateNodeStmt = this.#db.prepare(`
        UPDATE assoc_nodes
        SET status = 'suppressed', trust = 'low', metadata_json = ?, updated_at = ?
        WHERE id = ?
      `)

      for (const row of matchingNodes) {
        const incident = selectIncidentEdges.all(row.id, row.id) as Array<{ edge_id: string }>
        for (const edge of incident) {
          deletedEdgeSet.add(edge.edge_id)
          deleteEdgeById.run(edge.edge_id)
        }
        const prevMeta = JSON.parse(row.metadata_json) as Record<string, unknown>
        const nextMeta: Record<string, unknown> = {
          ...prevMeta,
          conflicted: true,
          ...(input.objectiveStatus !== undefined
            ? { objectiveStatus: input.objectiveStatus }
            : {}),
        }
        updateNodeStmt.run(JSON.stringify(nextMeta), nowMs, row.id)
        suppressedNodeIds.push(row.id)
      }

      return {
        deletedNodeIds: cascade.deletedNodeIds,
        suppressedNodeIds,
        deletedEdgeIds: [...deletedEdgeSet],
        deletedSynonymIds: cascade.deletedSynonymIds,
      }
    })
  }

  recordHoldoutAssignment(row: HoldoutAssignmentRow): void {
    this.#db
      .prepare(`
        INSERT OR IGNORE INTO assoc_holdout_assignments (
          task_id, owner_scope_key, task_kind, session_id, turn_number,
          in_holdout, bucket_bps, rate_bps, hmac_digest, assigned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.taskId,
        row.ownerScopeKey,
        row.taskKind,
        row.sessionId,
        row.turnNumber,
        row.inHoldout ? 1 : 0,
        row.bucketBps,
        row.rateBps,
        row.hmacDigest,
        row.assignedAt,
      )
  }

  getHoldoutAssignment(taskId: string): HoldoutAssignmentRow | null {
    const row = this.#db
      .prepare('SELECT * FROM assoc_holdout_assignments WHERE task_id = ?')
      .get(taskId) as
      | {
          task_id: string
          owner_scope_key: string
          task_kind: HoldoutTaskKind
          session_id: string | null
          turn_number: number | null
          in_holdout: number
          bucket_bps: number
          rate_bps: number
          hmac_digest: string
          assigned_at: number
        }
      | undefined
    if (row === undefined) return null
    return {
      taskId: row.task_id,
      ownerScopeKey: row.owner_scope_key,
      taskKind: row.task_kind,
      sessionId: row.session_id,
      turnNumber: row.turn_number,
      inHoldout: row.in_holdout === 1,
      bucketBps: row.bucket_bps,
      rateBps: row.rate_bps,
      hmacDigest: row.hmac_digest,
      assignedAt: row.assigned_at,
    }
  }

  recordMetricsAndExposures(
    metrics: readonly StepMetricRow[],
    exposures: readonly ExposureRow[],
  ): void {
    if (metrics.length === 0 && exposures.length === 0) return
    this.runInTransaction(() => {
      if (metrics.length > 0) {
        const insertMetric = this.#db.prepare(`
          INSERT INTO assoc_step_metrics (
            task_id, owner_scope_key, in_holdout, latency_us, timed_out,
            fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const m of metrics) {
          insertMetric.run(
            m.taskId,
            m.ownerScopeKey,
            m.inHoldout ? 1 : 0,
            m.latencyUs,
            m.timedOut ? 1 : 0,
            m.fallbackMode,
            m.injectedCount,
            m.candidateCount,
            JSON.stringify(m.sourceCounts),
            m.occurredAt,
          )
        }
      }

      if (exposures.length > 0) {
        const upsertExposure = this.#db.prepare(`
          INSERT INTO assoc_exposures (
            task_id, node_id, owner_scope_key, source_plugin, exposed_at,
            assoc_read_count, weak_use_count, corrected
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id, node_id) DO UPDATE SET
            assoc_read_count = assoc_exposures.assoc_read_count + excluded.assoc_read_count,
            weak_use_count = assoc_exposures.weak_use_count + excluded.weak_use_count,
            corrected = MAX(assoc_exposures.corrected, excluded.corrected)
        `)
        for (const exp of exposures) {
          upsertExposure.run(
            exp.taskId,
            exp.nodeId,
            exp.ownerScopeKey,
            exp.sourcePlugin,
            exp.exposedAt,
            exp.assocReadCount ?? 0,
            exp.weakUseCount ?? 0,
            exp.corrected ? 1 : 0,
          )
        }
      }
    })
  }
}
