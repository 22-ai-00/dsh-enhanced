import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BenchmarkPlan } from '@dsh-ray/assistant-evaluation/benchmark'
import type { OutcomeEnvelope } from '@dsh-ray/assistant-evaluation'
import { growthObjectDigest } from '@dsh-ray/assistant-growth-contract'
import { DEFAULT_HOLDOUT_RATE_BPS, evaluateHoldout } from './holdout.js'
import { normalizeEntityKey } from './tokenize.js'
import type { AssociationNodeMetadata } from './types.js'

export const WP04_CANDIDATE_ORIGIN_PROTOCOL = 'assistant-association/wp04-candidate-origin/v1' as const

export const IMPLICIT_SIGNAL_KINDS = ['re-ask', 'redo', 'owner-correction'] as const
export type ImplicitSignalKind = (typeof IMPLICIT_SIGNAL_KINDS)[number]

export const SKILL_CANDIDATE_STATUSES = ['pending', 'staged', 'dismissed'] as const
export type AssocSkillCandidateStatus = (typeof SKILL_CANDIDATE_STATUSES)[number]

const UNACHIEVED_OBJECTIVE_STATUSES = new Set([
  'failed',
  'partial',
  'blocked',
  'abandoned',
  'not-achieved',
])

export type Wp04OriginErrorCode =
  | 'missing-holdout-seed'
  | 'holdout-episode'
  | 'mixed-owner-scope'
  | 'invalid-benchmark-plan'
  | 'benchmark-guard-unavailable'

export class Wp04OriginError extends Error {
  constructor(
    readonly code: Wp04OriginErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'Wp04OriginError'
  }
}

export interface ClusteringConfig {
  readonly entityWeight?: number
  readonly toolWeight?: number
  readonly minSimilarity?: number
  readonly minClusterSize?: number
  readonly reAskWindowMs?: number
  readonly reAskMinEntityJaccard?: number
}

export interface NormalizedClusteringConfig {
  readonly entityWeight: number
  readonly toolWeight: number
  readonly minSimilarity: number
  readonly minClusterSize: number
  readonly reAskWindowMs: number
  readonly reAskMinEntityJaccard: number
}

export const DEFAULT_CLUSTERING_CONFIG: NormalizedClusteringConfig = Object.freeze({
  entityWeight: 0.4,
  toolWeight: 0.6,
  minSimilarity: 0.55,
  minClusterSize: 3,
  reAskWindowMs: 3_600_000,
  reAskMinEntityJaccard: 0.5,
})

export interface ClusteringEpisodeInput {
  readonly id: string
  readonly taskId: string
  readonly ownerScopeKey: string
  readonly entities: readonly string[]
  readonly toolNames: readonly string[]
  readonly createdAt: number
  readonly updatedAt?: number
  readonly title?: string
  readonly objectiveStatus?: string
  readonly corrected?: boolean
  readonly inHoldout?: boolean
  readonly metadata?: AssociationNodeMetadata
}

export interface EpisodeGoalLocator {
  readonly goalId: string
  readonly sessionId: string
}

export interface EpisodeCluster {
  readonly clusterId: string
  readonly ownerScopeKey: string
  readonly signatureDigest: string
  readonly toolSequence: readonly string[]
  readonly sharedEntities: readonly string[]
  readonly memberTaskIds: readonly string[]
  readonly goalLocators: readonly EpisodeGoalLocator[]
  readonly similarity: number
  readonly episodes: readonly ClusteringEpisodeInput[]
}

export interface AssocSkillCandidate {
  readonly candidateId: string
  readonly ownerScopeKey: string
  readonly clusterId: string
  readonly signatureDigest: string
  readonly name: string
  readonly description: string
  readonly toolSequence: readonly string[]
  readonly sharedEntities: readonly string[]
  readonly memberTaskIds: readonly string[]
  readonly goalLocators: readonly EpisodeGoalLocator[]
  readonly similarity: number
  readonly wp04Verified: boolean
  readonly status: AssocSkillCandidateStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AssocImplicitSignal {
  readonly signalId: string
  readonly ownerScopeKey: string
  readonly clusterId: string
  readonly kind: ImplicitSignalKind
  readonly trust: 'low'
  readonly candidateOnly: true
  readonly reportOnly: true
  readonly evidence: Readonly<Record<string, unknown>>
  readonly createdAt: number
}

export interface EvaluationAppendPeer {
  append(input: OutcomeEnvelope): unknown
}

export function normalizeClusteringConfig(
  input?: ClusteringConfig,
): NormalizedClusteringConfig {
  const entityWeight =
    input?.entityWeight !== undefined && Number.isFinite(input.entityWeight) && input.entityWeight >= 0
      ? input.entityWeight
      : DEFAULT_CLUSTERING_CONFIG.entityWeight
  const toolWeight =
    input?.toolWeight !== undefined && Number.isFinite(input.toolWeight) && input.toolWeight >= 0
      ? input.toolWeight
      : DEFAULT_CLUSTERING_CONFIG.toolWeight
  const minSimilarity =
    input?.minSimilarity !== undefined &&
    Number.isFinite(input.minSimilarity) &&
    input.minSimilarity >= 0 &&
    input.minSimilarity <= 1
      ? input.minSimilarity
      : DEFAULT_CLUSTERING_CONFIG.minSimilarity
  const minClusterSize =
    input?.minClusterSize !== undefined &&
    Number.isSafeInteger(input.minClusterSize) &&
    input.minClusterSize >= 2
      ? input.minClusterSize
      : DEFAULT_CLUSTERING_CONFIG.minClusterSize
  const reAskWindowMs =
    input?.reAskWindowMs !== undefined &&
    Number.isFinite(input.reAskWindowMs) &&
    input.reAskWindowMs >= 0
      ? input.reAskWindowMs
      : DEFAULT_CLUSTERING_CONFIG.reAskWindowMs
  const reAskMinEntityJaccard =
    input?.reAskMinEntityJaccard !== undefined &&
    Number.isFinite(input.reAskMinEntityJaccard) &&
    input.reAskMinEntityJaccard >= 0 &&
    input.reAskMinEntityJaccard <= 1
      ? input.reAskMinEntityJaccard
      : DEFAULT_CLUSTERING_CONFIG.reAskMinEntityJaccard

  return Object.freeze({
    entityWeight,
    toolWeight,
    minSimilarity,
    minClusterSize,
    reAskWindowMs,
    reAskMinEntityJaccard,
  })
}

export function ensureClusteringSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assoc_skill_candidates (
      candidate_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      signature_digest TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      tool_sequence_json TEXT NOT NULL,
      shared_entities_json TEXT NOT NULL,
      member_task_ids_json TEXT NOT NULL,
      goal_locators_json TEXT NOT NULL,
      similarity REAL NOT NULL,
      wp04_verified INTEGER NOT NULL CHECK (wp04_verified IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'staged', 'dismissed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assoc_skill_candidates_scope_time
      ON assoc_skill_candidates(owner_scope_key, updated_at DESC);

    CREATE INDEX IF NOT EXISTS assoc_skill_candidates_cluster
      ON assoc_skill_candidates(cluster_id);

    CREATE TABLE IF NOT EXISTS assoc_implicit_signals (
      signal_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('re-ask', 'redo', 'owner-correction')),
      trust TEXT NOT NULL CHECK (trust = 'low'),
      candidate_only INTEGER NOT NULL DEFAULT 1 CHECK (candidate_only = 1),
      report_only INTEGER NOT NULL DEFAULT 1 CHECK (report_only = 1),
      evidence_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assoc_implicit_signals_scope_time
      ON assoc_implicit_signals(owner_scope_key, created_at DESC);

    CREATE INDEX IF NOT EXISTS assoc_implicit_signals_cluster
      ON assoc_implicit_signals(cluster_id);
  `)
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined
  return row !== undefined
}

function normalizeEntities(entities: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of entities) {
    const key = normalizeEntityKey(raw) ?? raw.normalize('NFKC').toLocaleLowerCase('en-US').trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function normalizeTools(tools: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of tools) {
    const trimmed = raw.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

export function computeEntityJaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(normalizeEntities(a))
  const setB = new Set(normalizeEntities(b))
  if (setA.size === 0 && setB.size === 0) return 0
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

export function computeToolSequenceLcs(
  a: readonly string[],
  b: readonly string[],
): string[] {
  const seqA = normalizeTools(a)
  const seqB = normalizeTools(b)
  const m = seqA.length
  const n = seqB.length
  if (m === 0 || n === 0) return []

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  )

  for (let i = 1; i <= m; i += 1) {
    const row = dp[i]!
    const prevRow = dp[i - 1]!
    const itemA = seqA[i - 1]!
    for (let j = 1; j <= n; j += 1) {
      if (itemA === seqB[j - 1]) {
        row[j] = (prevRow[j - 1] ?? 0) + 1
      } else {
        const up = prevRow[j] ?? 0
        const left = row[j - 1] ?? 0
        row[j] = up >= left ? up : left
      }
    }
  }

  const out: string[] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (seqA[i - 1] === seqB[j - 1]) {
      out.push(seqA[i - 1]!)
      i -= 1
      j -= 1
    } else if ((dp[i - 1]?.[j] ?? 0) >= (dp[i]?.[j - 1] ?? 0)) {
      i -= 1
    } else {
      j -= 1
    }
  }
  out.reverse()
  return out
}

export function computeToolSequenceSimilarity(
  a: readonly string[],
  b: readonly string[],
): number {
  const seqA = normalizeTools(a)
  const seqB = normalizeTools(b)
  const maxLen = Math.max(seqA.length, seqB.length)
  if (seqA.length === 0 || seqB.length === 0 || maxLen === 0) return 0
  const lcs = computeToolSequenceLcs(seqA, seqB)
  return lcs.length / maxLen
}

export function computeEpisodeSimilarity(
  a: Pick<ClusteringEpisodeInput, 'entities' | 'toolNames'>,
  b: Pick<ClusteringEpisodeInput, 'entities' | 'toolNames'>,
  weights?: { readonly entityWeight?: number; readonly toolWeight?: number },
): number {
  const entityWeight = weights?.entityWeight ?? DEFAULT_CLUSTERING_CONFIG.entityWeight
  const toolWeight = weights?.toolWeight ?? DEFAULT_CLUSTERING_CONFIG.toolWeight
  const jaccard = computeEntityJaccard(a.entities, b.entities)
  const lcsNorm = computeToolSequenceSimilarity(a.toolNames, b.toolNames)
  return entityWeight * jaccard + toolWeight * lcsNorm
}

export function loadHoldoutTaskIdSet(
  db: DatabaseSync,
  taskIds?: readonly string[],
): Set<string> {
  const holdoutSet = new Set<string>()
  const tables = [
    'assoc_holdout_assignments',
    'assoc_replay_episodes',
    'assoc_eval_pool',
  ] as const

  const uniqueTaskIds =
    taskIds === undefined
      ? undefined
      : [...new Set(taskIds.filter((t) => t.length > 0))]

  if (uniqueTaskIds !== undefined && uniqueTaskIds.length === 0) {
    return holdoutSet
  }

  for (const table of tables) {
    if (!hasTable(db, table)) continue
    if (uniqueTaskIds === undefined) {
      const rows = db
        .prepare(`SELECT task_id FROM ${table} WHERE in_holdout = 1`)
        .all() as Array<{ task_id: string }>
      for (const row of rows) {
        holdoutSet.add(row.task_id)
      }
    } else {
      const chunkSize = 200
      for (let i = 0; i < uniqueTaskIds.length; i += chunkSize) {
        const chunk = uniqueTaskIds.slice(i, i + chunkSize)
        const placeholders = chunk.map(() => '?').join(', ')
        const rows = db
          .prepare(
            `SELECT task_id FROM ${table} WHERE in_holdout = 1 AND task_id IN (${placeholders})`,
          )
          .all(...chunk) as Array<{ task_id: string }>
        for (const row of rows) {
          holdoutSet.add(row.task_id)
        }
      }
    }
  }

  return holdoutSet
}

export interface Wp04CandidateOriginInput {
  readonly db?: DatabaseSync
  readonly holdoutSeedKey: Buffer | null
  readonly holdoutRateBps?: number
  readonly episodes: readonly Pick<
    ClusteringEpisodeInput,
    'taskId' | 'ownerScopeKey' | 'inHoldout'
  >[]
  readonly ownerScopeKey?: string
  readonly benchmarkPlan?: BenchmarkPlan
}

export async function assertWp04CandidateOrigin(
  input: Wp04CandidateOriginInput,
): Promise<void> {
  if (
    input.holdoutSeedKey === null ||
    !Buffer.isBuffer(input.holdoutSeedKey) ||
    input.holdoutSeedKey.length === 0
  ) {
    throw new Wp04OriginError(
      'missing-holdout-seed',
      'WP04 guard: holdoutSeedKey is required before candidate generation',
    )
  }

  if (input.benchmarkPlan !== undefined) {
    let assertCandidateGenerationInput: ((plan: BenchmarkPlan) => unknown) | undefined
    try {
      const mod = await import('@dsh-ray/assistant-evaluation/benchmark')
      assertCandidateGenerationInput = mod.assertCandidateGenerationInput
    } catch {
      throw new Wp04OriginError(
        'benchmark-guard-unavailable',
        'WP04 guard: @dsh-ray/assistant-evaluation/benchmark is unavailable',
      )
    }
    if (typeof assertCandidateGenerationInput !== 'function') {
      throw new Wp04OriginError(
        'benchmark-guard-unavailable',
        'WP04 guard: assertCandidateGenerationInput is unavailable',
      )
    }
    assertCandidateGenerationInput(input.benchmarkPlan)
  }

  const rateBps = input.holdoutRateBps ?? DEFAULT_HOLDOUT_RATE_BPS
  const scopes = new Set<string>()
  const taskIds: string[] = []

  for (const ep of input.episodes) {
    if (ep.ownerScopeKey.trim().length === 0) {
      throw new Wp04OriginError(
        'mixed-owner-scope',
        'WP04 guard: episode ownerScopeKey must be non-empty',
      )
    }
    scopes.add(ep.ownerScopeKey)
    if (input.ownerScopeKey !== undefined && ep.ownerScopeKey !== input.ownerScopeKey) {
      throw new Wp04OriginError(
        'mixed-owner-scope',
        `WP04 guard: episode ${ep.taskId} belongs to a different ownerScopeKey`,
      )
    }
    if (ep.inHoldout === true) {
      throw new Wp04OriginError(
        'holdout-episode',
        `WP04 guard: holdout episode ${ep.taskId} is excluded from candidate generation`,
      )
    }
    const decision = evaluateHoldout(input.holdoutSeedKey, ep.taskId, rateBps)
    if (decision.inHoldout !== false) {
      throw new Wp04OriginError(
        'holdout-episode',
        `WP04 guard: task ${ep.taskId} evaluates into sealed holdout`,
      )
    }
    taskIds.push(ep.taskId)
  }

  if (scopes.size > 1) {
    throw new Wp04OriginError(
      'mixed-owner-scope',
      'WP04 guard: candidate cluster must belong to a single ownerScopeKey',
    )
  }

  if (input.db !== undefined && taskIds.length > 0) {
    const dbHoldouts = loadHoldoutTaskIdSet(input.db, taskIds)
    for (const taskId of taskIds) {
      if (dbHoldouts.has(taskId)) {
        throw new Wp04OriginError(
          'holdout-episode',
          `WP04 guard: task ${taskId} is marked in_holdout = 1 in SQLite`,
        )
      }
    }
  }
}

interface RawEpisodeNodeRow {
  readonly id: string
  readonly source_ref: string
  readonly owner_scope_key: string
  readonly title: string
  readonly entities_json: string
  readonly metadata_json: string
  readonly created_at: number
  readonly updated_at: number
}

function loadCorrectedTaskIdSet(
  db: DatabaseSync,
  ownerScopeKey: string,
): Set<string> {
  const corrected = new Set<string>()
  if (hasTable(db, 'assoc_exposures')) {
    const rows = db
      .prepare(
        'SELECT DISTINCT task_id FROM assoc_exposures WHERE owner_scope_key = ? AND corrected = 1',
      )
      .all(ownerScopeKey) as Array<{ task_id: string }>
    for (const row of rows) {
      corrected.add(row.task_id)
    }
  }
  if (hasTable(db, 'assoc_replay_episodes')) {
    const rows = db
      .prepare(
        'SELECT task_id, corrected_node_ids_json FROM assoc_replay_episodes WHERE owner_scope_key = ?',
      )
      .all(ownerScopeKey) as Array<{ task_id: string; corrected_node_ids_json: string }>
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.corrected_node_ids_json) as unknown
        if (Array.isArray(parsed) && parsed.length > 0) {
          corrected.add(row.task_id)
        }
      } catch {
        // Ignore malformed JSON rows
      }
    }
  }
  return corrected
}

export function loadClusteringEpisodesFromDb(
  db: DatabaseSync,
  ownerScopeKey: string,
  options?: { readonly limit?: number },
): ClusteringEpisodeInput[] {
  const limit = Math.max(1, Math.min(5_000, Math.trunc(options?.limit ?? 1_000)))
  const holdouts = loadHoldoutTaskIdSet(db)
  const correctedTasks = loadCorrectedTaskIdSet(db, ownerScopeKey)

  const poolInfoByTask = new Map<
    string,
    {
      readonly objectiveStatus: string | null
      readonly entities: readonly string[]
      readonly toolNames: readonly string[]
    }
  >()
  if (hasTable(db, 'assoc_eval_pool')) {
    const poolRows = db
      .prepare(
        `SELECT task_id, objective_status, entities_json, tool_names_json
         FROM assoc_eval_pool
         WHERE owner_scope_key = ? AND status = 'active'`,
      )
      .all(ownerScopeKey) as Array<{
      task_id: string
      objective_status: string | null
      entities_json: string
      tool_names_json: string
    }>
    for (const row of poolRows) {
      let entities: string[] = []
      let toolNames: string[] = []
      try {
        const e = JSON.parse(row.entities_json) as unknown
        if (Array.isArray(e)) {
          entities = e.filter((v): v is string => typeof v === 'string')
        }
      } catch {
        entities = []
      }
      try {
        const t = JSON.parse(row.tool_names_json) as unknown
        if (Array.isArray(t)) {
          toolNames = t.filter((v): v is string => typeof v === 'string')
        }
      } catch {
        toolNames = []
      }
      poolInfoByTask.set(row.task_id, {
        objectiveStatus: row.objective_status,
        entities,
        toolNames,
      })
    }
  }

  if (!hasTable(db, 'assoc_nodes')) {
    return []
  }

  const rows = db
    .prepare(
      `SELECT id, source_ref, owner_scope_key, title, entities_json, metadata_json, created_at, updated_at
       FROM assoc_nodes
       WHERE owner_scope_key = ? AND kind = 'episode' AND status = 'active'
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(ownerScopeKey, limit) as unknown as RawEpisodeNodeRow[]

  const out: ClusteringEpisodeInput[] = []
  for (const row of rows) {
    let entities: string[] = []
    let metadata: AssociationNodeMetadata = {}
    try {
      const parsedEntities = JSON.parse(row.entities_json) as unknown
      if (Array.isArray(parsedEntities)) {
        entities = parsedEntities.filter((v): v is string => typeof v === 'string')
      }
    } catch {
      entities = []
    }
    try {
      const parsedMeta = JSON.parse(row.metadata_json) as unknown
      if (parsedMeta !== null && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)) {
        metadata = parsedMeta as AssociationNodeMetadata
      }
    } catch {
      metadata = {}
    }

    const extraTaskId = metadata.extra?.taskId
    const taskId =
      typeof extraTaskId === 'string' && extraTaskId.length > 0
        ? extraTaskId
        : row.source_ref

    const poolInfo = poolInfoByTask.get(taskId)
    const rawTools = Array.isArray(metadata.toolNames)
      ? metadata.toolNames.filter((v): v is string => typeof v === 'string')
      : []
    const toolNames = rawTools.length > 0 ? rawTools : (poolInfo?.toolNames ?? [])
    const mergedEntities =
      entities.length > 0 ? entities : (poolInfo?.entities ?? [])
    const objectiveStatus =
      typeof metadata.objectiveStatus === 'string' && metadata.objectiveStatus.length > 0
        ? metadata.objectiveStatus
        : (poolInfo?.objectiveStatus ?? undefined)

    const isCorrected =
      metadata.conflicted === true || correctedTasks.has(taskId)
    const isInHoldout = holdouts.has(taskId)

    out.push({
      id: row.id,
      taskId,
      ownerScopeKey: row.owner_scope_key,
      entities: mergedEntities,
      toolNames,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      ...(objectiveStatus === undefined ? {} : { objectiveStatus }),
      corrected: isCorrected,
      inHoldout: isInHoldout,
      metadata,
    })
  }

  return out
}

function filterNonHoldoutEpisodes(
  db: DatabaseSync,
  ownerScopeKey: string,
  episodes: readonly ClusteringEpisodeInput[],
  holdoutSeedKey: Buffer | null,
  holdoutRateBps: number,
): {
  readonly eligible: ClusteringEpisodeInput[]
  readonly excludedHoldoutCount: number
} {
  if (
    holdoutSeedKey === null ||
    !Buffer.isBuffer(holdoutSeedKey) ||
    holdoutSeedKey.length === 0
  ) {
    throw new Wp04OriginError(
      'missing-holdout-seed',
      'WP04 guard: holdoutSeedKey is required before clustering or implicit signal detection',
    )
  }

  const taskIds = episodes.map((e) => e.taskId)
  const dbHoldouts = loadHoldoutTaskIdSet(db, taskIds)
  const eligible: ClusteringEpisodeInput[] = []
  let excludedHoldoutCount = 0

  for (const ep of episodes) {
    if (ep.ownerScopeKey !== ownerScopeKey) continue
    if (ep.inHoldout === true || dbHoldouts.has(ep.taskId)) {
      excludedHoldoutCount += 1
      continue
    }
    const decision = evaluateHoldout(holdoutSeedKey, ep.taskId, holdoutRateBps)
    if (decision.inHoldout !== false) {
      excludedHoldoutCount += 1
      continue
    }
    eligible.push(ep)
  }

  eligible.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id.localeCompare(b.id)
  })

  return { eligible, excludedHoldoutCount }
}

function computeSharedEntities(episodes: readonly ClusteringEpisodeInput[]): string[] {
  const counts = new Map<string, number>()
  for (const ep of episodes) {
    for (const ent of new Set(normalizeEntities(ep.entities))) {
      counts.set(ent, (counts.get(ent) ?? 0) + 1)
    }
  }
  const threshold = Math.min(episodes.length, Math.max(2, Math.ceil(episodes.length / 2)))
  const shared = [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([ent]) => ent)
  if (shared.length > 0) return shared
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, 8)
    .map(([ent]) => ent)
}

function computeClusterToolSequence(episodes: readonly ClusteringEpisodeInput[]): string[] {
  if (episodes.length === 0) return []
  const first = episodes[0]!
  let common = normalizeTools(first.toolNames)
  for (let i = 1; i < episodes.length; i += 1) {
    common = computeToolSequenceLcs(common, episodes[i]!.toolNames)
    if (common.length === 0) break
  }
  if (common.length > 0) return common
  return normalizeTools(first.toolNames)
}

function extractGoalLocators(episodes: readonly ClusteringEpisodeInput[]): EpisodeGoalLocator[] {
  const seen = new Set<string>()
  const out: EpisodeGoalLocator[] = []
  for (const ep of episodes) {
    const extra = ep.metadata?.extra
    if (extra === undefined) continue
    const goalId = extra.goalId
    const sessionId = extra.sessionId
    if (
      typeof goalId === 'string' &&
      goalId.trim().length > 0 &&
      typeof sessionId === 'string' &&
      sessionId.trim().length > 0
    ) {
      const key = `${goalId}\0${sessionId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(Object.freeze({ goalId, sessionId }))
    }
  }
  out.sort((a, b) =>
    a.goalId !== b.goalId
      ? a.goalId.localeCompare(b.goalId)
      : a.sessionId.localeCompare(b.sessionId),
  )
  return out
}

function computeAveragePairwiseSimilarity(
  episodes: readonly ClusteringEpisodeInput[],
  similarityFn: (a: ClusteringEpisodeInput, b: ClusteringEpisodeInput) => number,
): number {
  if (episodes.length <= 1) return 1
  let sum = 0
  let count = 0
  for (let i = 0; i < episodes.length; i += 1) {
    for (let j = i + 1; j < episodes.length; j += 1) {
      sum += similarityFn(episodes[i]!, episodes[j]!)
      count += 1
    }
  }
  return count === 0 ? 1 : sum / count
}

function deterministicSha256(payload: unknown): string {
  return growthObjectDigest(payload)
}

function truncateCandidateName(raw: string, maxCodePoints = 96, maxBytes = 128): string {
  const safe = raw.toWellFormed().normalize('NFC').trim()
  let out = ''
  let codePoints = 0
  let bytes = 0
  for (const ch of safe) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (codePoints + 1 > maxCodePoints || bytes + chBytes > maxBytes) break
    out += ch
    codePoints += 1
    bytes += chBytes
  }
  return out.trimEnd()
}

function buildCandidateName(
  sharedEntities: readonly string[],
  toolSequence: readonly string[],
  signatureDigest: string,
): string {
  const entityLabel = sharedEntities.slice(0, 2).join('-')
  const toolLabel = toolSequence.slice(0, 2).join('-')
  const base =
    entityLabel.length > 0
      ? `${entityLabel}${toolLabel.length > 0 ? `:${toolLabel}` : ''}`
      : toolLabel.length > 0
        ? toolLabel
        : `cluster-${signatureDigest.slice(0, 8)}`
  return truncateCandidateName(`skill-${base}`, 96, 128)
}

function buildCandidateDescription(
  episodes: readonly ClusteringEpisodeInput[],
  sharedEntities: readonly string[],
  toolSequence: readonly string[],
): string {
  const entitiesSummary =
    sharedEntities.length > 0 ? sharedEntities.slice(0, 5).join(', ') : 'none'
  const toolsSummary = toolSequence.join(' -> ')
  return `Derived from ${episodes.length} verified non-holdout episodes (entities: ${entitiesSummary}; tools: ${toolsSummary}).`
}

export interface ClusterEpisodesOptions {
  readonly ownerScopeKey: string
  readonly holdoutSeedKey: Buffer | null
  readonly holdoutRateBps?: number
  readonly episodes?: readonly ClusteringEpisodeInput[]
  readonly config?: ClusteringConfig
  readonly benchmarkPlan?: BenchmarkPlan
  readonly nowMs?: number
  readonly persist?: boolean
}

export interface ClusterEpisodesResult {
  readonly clusters: readonly EpisodeCluster[]
  readonly candidates: readonly AssocSkillCandidate[]
  readonly excludedHoldoutCount: number
}

export async function clusterEpisodes(
  db: DatabaseSync,
  options: ClusterEpisodesOptions,
): Promise<ClusterEpisodesResult> {
  const cfg = normalizeClusteringConfig(options.config)
  const holdoutRateBps = options.holdoutRateBps ?? DEFAULT_HOLDOUT_RATE_BPS
  const nowMs = options.nowMs ?? Date.now()
  const persist = options.persist ?? true

  // Validate seed and optional benchmarkPlan before touching or reading candidate inputs.
  await assertWp04CandidateOrigin({
    db,
    holdoutSeedKey: options.holdoutSeedKey,
    holdoutRateBps,
    episodes: [],
    ownerScopeKey: options.ownerScopeKey,
    ...(options.benchmarkPlan === undefined ? {} : { benchmarkPlan: options.benchmarkPlan }),
  })

  if (persist) {
    ensureClusteringSchema(db)
  }

  const rawEpisodes =
    options.episodes ?? loadClusteringEpisodesFromDb(db, options.ownerScopeKey)

  const { eligible, excludedHoldoutCount } = filterNonHoldoutEpisodes(
    db,
    options.ownerScopeKey,
    rawEpisodes,
    options.holdoutSeedKey,
    holdoutRateBps,
  )

  // Skill candidate clustering requires non-empty tool sequence (T.length >= 1).
  const toolEpisodes = eligible.filter((ep) => normalizeTools(ep.toolNames).length >= 1)
  const assigned = new Set<string>()
  const clusters: EpisodeCluster[] = []
  const candidates: AssocSkillCandidate[] = []

  const similarityFn = (a: ClusteringEpisodeInput, b: ClusteringEpisodeInput): number =>
    computeEpisodeSimilarity(a, b, {
      entityWeight: cfg.entityWeight,
      toolWeight: cfg.toolWeight,
    })

  for (let i = 0; i < toolEpisodes.length; i += 1) {
    const seed = toolEpisodes[i]!
    if (assigned.has(seed.id)) continue

    const members: ClusteringEpisodeInput[] = [seed]
    for (let j = i + 1; j < toolEpisodes.length; j += 1) {
      const cand = toolEpisodes[j]!
      if (assigned.has(cand.id)) continue
      if (similarityFn(seed, cand) >= cfg.minSimilarity) {
        members.push(cand)
      }
    }

    if (members.length < cfg.minClusterSize) continue

    for (const m of members) {
      assigned.add(m.id)
    }

    await assertWp04CandidateOrigin({
      db,
      holdoutSeedKey: options.holdoutSeedKey,
      holdoutRateBps,
      episodes: members,
      ownerScopeKey: options.ownerScopeKey,
      ...(options.benchmarkPlan === undefined ? {} : { benchmarkPlan: options.benchmarkPlan }),
    })

    const sortedTaskIds = members.map((m) => m.taskId).sort()
    const sharedEntities = computeSharedEntities(members)
    const toolSequence = computeClusterToolSequence(members)
    const goalLocators = extractGoalLocators(members)
    const similarity = computeAveragePairwiseSimilarity(members, similarityFn)

    const signatureDigest = deterministicSha256({
      protocol: 'assistant-association/cluster-signature/v1',
      ownerScopeKey: options.ownerScopeKey,
      toolSequence,
      sharedEntities,
    })
    const clusterId = deterministicSha256({
      protocol: 'assistant-association/cluster/v1',
      ownerScopeKey: options.ownerScopeKey,
      memberTaskIds: sortedTaskIds,
    })
    const candidateId = deterministicSha256({
      protocol: 'assistant-association/skill-candidate/v1',
      ownerScopeKey: options.ownerScopeKey,
      clusterId,
      signatureDigest,
    })

    const cluster: EpisodeCluster = Object.freeze({
      clusterId,
      ownerScopeKey: options.ownerScopeKey,
      signatureDigest,
      toolSequence: Object.freeze(toolSequence),
      sharedEntities: Object.freeze(sharedEntities),
      memberTaskIds: Object.freeze(sortedTaskIds),
      goalLocators: Object.freeze(goalLocators),
      similarity,
      episodes: Object.freeze(members),
    })
    clusters.push(cluster)

    const candidate: AssocSkillCandidate = Object.freeze({
      candidateId,
      ownerScopeKey: options.ownerScopeKey,
      clusterId,
      signatureDigest,
      name: buildCandidateName(sharedEntities, toolSequence, signatureDigest),
      description: buildCandidateDescription(members, sharedEntities, toolSequence),
      toolSequence: cluster.toolSequence,
      sharedEntities: cluster.sharedEntities,
      memberTaskIds: cluster.memberTaskIds,
      goalLocators: cluster.goalLocators,
      similarity,
      wp04Verified: true,
      status: 'pending',
      createdAt: nowMs,
      updatedAt: nowMs,
    })

    if (persist) {
      db.prepare(`
        INSERT INTO assoc_skill_candidates (
          candidate_id, owner_scope_key, cluster_id, signature_digest,
          name, description, tool_sequence_json, shared_entities_json,
          member_task_ids_json, goal_locators_json, similarity,
          wp04_verified, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)
        ON CONFLICT(candidate_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          tool_sequence_json = excluded.tool_sequence_json,
          shared_entities_json = excluded.shared_entities_json,
          member_task_ids_json = excluded.member_task_ids_json,
          goal_locators_json = excluded.goal_locators_json,
          similarity = excluded.similarity,
          wp04_verified = 1,
          updated_at = excluded.updated_at
      `).run(
        candidate.candidateId,
        candidate.ownerScopeKey,
        candidate.clusterId,
        candidate.signatureDigest,
        candidate.name,
        candidate.description,
        JSON.stringify(candidate.toolSequence),
        JSON.stringify(candidate.sharedEntities),
        JSON.stringify(candidate.memberTaskIds),
        JSON.stringify(candidate.goalLocators),
        candidate.similarity,
        candidate.createdAt,
        candidate.updatedAt,
      )

      const storedRow = db
        .prepare('SELECT status, created_at FROM assoc_skill_candidates WHERE candidate_id = ?')
        .get(candidate.candidateId) as { status: AssocSkillCandidateStatus; created_at: number } | undefined
      if (storedRow !== undefined && (storedRow.status !== candidate.status || storedRow.created_at !== candidate.createdAt)) {
        candidates.push(
          Object.freeze({
            ...candidate,
            status: storedRow.status,
            createdAt: storedRow.created_at,
          }),
        )
        continue
      }
    }

    candidates.push(candidate)
  }

  return Object.freeze({
    clusters: Object.freeze(clusters),
    candidates: Object.freeze(candidates),
    excludedHoldoutCount,
  })
}

export interface DetectImplicitSignalsOptions {
  readonly ownerScopeKey: string
  readonly holdoutSeedKey: Buffer | null
  readonly holdoutRateBps?: number
  readonly episodes?: readonly ClusteringEpisodeInput[]
  readonly config?: ClusteringConfig
  readonly nowMs?: number
  readonly persist?: boolean
}

export interface DetectImplicitSignalsResult {
  readonly signals: readonly AssocImplicitSignal[]
  readonly excludedHoldoutCount: number
}

function hasReAskPattern(
  members: readonly ClusteringEpisodeInput[],
  cfg: NormalizedClusteringConfig,
): { readonly matched: boolean; readonly maxEntityJaccard: number } {
  if (members.length < 2) return { matched: false, maxEntityJaccard: 0 }
  let maxJaccard = 0
  let shortWindowMatch = false
  let highOverlapMatch = false
  const normalizedTitles = new Map<string, number>()

  for (let i = 0; i < members.length; i += 1) {
    const a = members[i]!
    const normTitle = (a.title ?? '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
    if (normTitle.length > 0) {
      const count = (normalizedTitles.get(normTitle) ?? 0) + 1
      normalizedTitles.set(normTitle, count)
      if (count >= 2) highOverlapMatch = true
    }
    for (let j = i + 1; j < members.length; j += 1) {
      const b = members[j]!
      const jacc = computeEntityJaccard(a.entities, b.entities)
      if (jacc > maxJaccard) maxJaccard = jacc
      const deltaMs = Math.abs(b.createdAt - a.createdAt)
      if (deltaMs <= cfg.reAskWindowMs && jacc >= cfg.reAskMinEntityJaccard) {
        shortWindowMatch = true
      }
      if (jacc >= 0.75) {
        highOverlapMatch = true
      }
    }
  }

  return {
    matched: shortWindowMatch || highOverlapMatch,
    maxEntityJaccard: maxJaccard,
  }
}

export function detectImplicitSignals(
  db: DatabaseSync,
  options: DetectImplicitSignalsOptions,
): DetectImplicitSignalsResult {
  const cfg = normalizeClusteringConfig(options.config)
  const holdoutRateBps = options.holdoutRateBps ?? DEFAULT_HOLDOUT_RATE_BPS
  const nowMs = options.nowMs ?? Date.now()
  const persist = options.persist ?? true

  if (persist) {
    ensureClusteringSchema(db)
  }

  const rawEpisodes =
    options.episodes ?? loadClusteringEpisodesFromDb(db, options.ownerScopeKey)

  const { eligible, excludedHoldoutCount } = filterNonHoldoutEpisodes(
    db,
    options.ownerScopeKey,
    rawEpisodes,
    options.holdoutSeedKey,
    holdoutRateBps,
  )

  const dbCorrectedTasks = loadCorrectedTaskIdSet(db, options.ownerScopeKey)
  const signalSimilarity = (a: ClusteringEpisodeInput, b: ClusteringEpisodeInput): number => {
    const hasToolsA = normalizeTools(a.toolNames).length >= 1
    const hasToolsB = normalizeTools(b.toolNames).length >= 1
    if (hasToolsA && hasToolsB) {
      return computeEpisodeSimilarity(a, b, {
        entityWeight: cfg.entityWeight,
        toolWeight: cfg.toolWeight,
      })
    }
    return computeEntityJaccard(a.entities, b.entities)
  }

  const assigned = new Set<string>()
  const signalClusters: ClusteringEpisodeInput[][] = []

  for (let i = 0; i < eligible.length; i += 1) {
    const seed = eligible[i]!
    if (assigned.has(seed.id)) continue

    const members: ClusteringEpisodeInput[] = [seed]
    for (let j = i + 1; j < eligible.length; j += 1) {
      const cand = eligible[j]!
      if (assigned.has(cand.id)) continue
      if (signalSimilarity(seed, cand) >= cfg.minSimilarity) {
        members.push(cand)
      }
    }

    const hasCorrection = members.some(
      (m) =>
        m.corrected === true ||
        m.metadata?.conflicted === true ||
        dbCorrectedTasks.has(m.taskId),
    )

    if (members.length >= 2 || hasCorrection) {
      for (const m of members) {
        assigned.add(m.id)
      }
      signalClusters.push(members)
    }
  }

  const signals: AssocImplicitSignal[] = []
  const dbHoldouts = loadHoldoutTaskIdSet(
    db,
    eligible.map((e) => e.taskId),
  )

  for (const members of signalClusters) {
    // Defense-in-depth: re-verify zero holdout episodes in each cluster
    const safeMembers = members.filter(
      (m) =>
        m.inHoldout !== true &&
        !dbHoldouts.has(m.taskId) &&
        evaluateHoldout(options.holdoutSeedKey!, m.taskId, holdoutRateBps).inHoldout === false,
    )
    if (safeMembers.length === 0) continue

    const sortedTaskIds = safeMembers.map((m) => m.taskId).sort()
    const clusterId = deterministicSha256({
      protocol: 'assistant-association/cluster/v1',
      ownerScopeKey: options.ownerScopeKey,
      memberTaskIds: sortedTaskIds,
    })

    const emitSignal = (
      kind: ImplicitSignalKind,
      evidence: Readonly<Record<string, unknown>>,
    ): void => {
      const signalId = deterministicSha256({
        protocol: 'assistant-association/implicit-signal/v1',
        ownerScopeKey: options.ownerScopeKey,
        clusterId,
        kind,
      })
      const signal: AssocImplicitSignal = Object.freeze({
        signalId,
        ownerScopeKey: options.ownerScopeKey,
        clusterId,
        kind,
        trust: 'low',
        candidateOnly: true,
        reportOnly: true,
        evidence: Object.freeze({ ...evidence }),
        createdAt: nowMs,
      })

      if (persist) {
        db.prepare(`
          INSERT INTO assoc_implicit_signals (
            signal_id, owner_scope_key, cluster_id, kind,
            trust, candidate_only, report_only, evidence_json, created_at
          ) VALUES (?, ?, ?, ?, 'low', 1, 1, ?, ?)
          ON CONFLICT(signal_id) DO UPDATE SET
            evidence_json = excluded.evidence_json,
            created_at = excluded.created_at
        `).run(
          signal.signalId,
          signal.ownerScopeKey,
          signal.clusterId,
          signal.kind,
          JSON.stringify(signal.evidence),
          signal.createdAt,
        )
      }

      signals.push(signal)
    }

    // 1. 're-ask'
    const reAsk = hasReAskPattern(safeMembers, cfg)
    if (reAsk.matched) {
      emitSignal('re-ask', {
        taskIds: sortedTaskIds,
        clusterSize: safeMembers.length,
        windowMs: cfg.reAskWindowMs,
        maxEntityJaccard: reAsk.maxEntityJaccard,
      })
    }

    // 2. 'redo'
    const failedIndices: number[] = []
    const failedTaskIds: string[] = []
    const objectiveStatuses: string[] = []
    for (let idx = 0; idx < safeMembers.length; idx += 1) {
      const ep = safeMembers[idx]!
      const st = ep.objectiveStatus?.trim().toLowerCase()
      if (st !== undefined && UNACHIEVED_OBJECTIVE_STATUSES.has(st)) {
        failedIndices.push(idx)
        failedTaskIds.push(ep.taskId)
        objectiveStatuses.push(st)
      }
    }
    if (failedIndices.length > 0) {
      const firstFailedIdx = failedIndices[0]!
      const followUpTaskIds = safeMembers
        .slice(firstFailedIdx + 1)
        .map((m) => m.taskId)
      if (followUpTaskIds.length > 0) {
        emitSignal('redo', {
          taskIds: sortedTaskIds,
          failedTaskIds,
          followUpTaskIds,
          objectiveStatuses,
        })
      }
    }

    // 3. 'owner-correction'
    const correctedTaskIds = safeMembers
      .filter(
        (m) =>
          m.corrected === true ||
          m.metadata?.conflicted === true ||
          dbCorrectedTasks.has(m.taskId),
      )
      .map((m) => m.taskId)
      .sort()
    if (correctedTaskIds.length > 0) {
      emitSignal('owner-correction', {
        taskIds: sortedTaskIds,
        correctedTaskIds,
      })
    }
  }

  return Object.freeze({
    signals: Object.freeze(signals),
    excludedHoldoutCount,
  })
}

interface RawSkillCandidateRow {
  readonly candidate_id: string
  readonly owner_scope_key: string
  readonly cluster_id: string
  readonly signature_digest: string
  readonly name: string
  readonly description: string
  readonly tool_sequence_json: string
  readonly shared_entities_json: string
  readonly member_task_ids_json: string
  readonly goal_locators_json: string
  readonly similarity: number
  readonly wp04_verified: number
  readonly status: AssocSkillCandidateStatus
  readonly created_at: number
  readonly updated_at: number
}

function mapRawCandidate(row: RawSkillCandidateRow): AssocSkillCandidate {
  return Object.freeze({
    candidateId: row.candidate_id,
    ownerScopeKey: row.owner_scope_key,
    clusterId: row.cluster_id,
    signatureDigest: row.signature_digest,
    name: row.name,
    description: row.description,
    toolSequence: Object.freeze(JSON.parse(row.tool_sequence_json) as string[]),
    sharedEntities: Object.freeze(JSON.parse(row.shared_entities_json) as string[]),
    memberTaskIds: Object.freeze(JSON.parse(row.member_task_ids_json) as string[]),
    goalLocators: Object.freeze(JSON.parse(row.goal_locators_json) as EpisodeGoalLocator[]),
    similarity: row.similarity,
    wp04Verified: row.wp04_verified === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function listSkillCandidates(
  db: DatabaseSync,
  ownerScopeKey: string,
  options?: {
    readonly status?: AssocSkillCandidateStatus
    readonly limit?: number
  },
): AssocSkillCandidate[] {
  if (!hasTable(db, 'assoc_skill_candidates')) return []
  const limit = Math.max(1, Math.min(1_000, Math.trunc(options?.limit ?? 100)))
  if (options?.status !== undefined) {
    const rows = db
      .prepare(
        `SELECT * FROM assoc_skill_candidates
         WHERE owner_scope_key = ? AND status = ?
         ORDER BY updated_at DESC, candidate_id ASC
         LIMIT ?`,
      )
      .all(ownerScopeKey, options.status, limit) as unknown as RawSkillCandidateRow[]
    return rows.map(mapRawCandidate)
  }
  const rows = db
    .prepare(
      `SELECT * FROM assoc_skill_candidates
       WHERE owner_scope_key = ?
       ORDER BY updated_at DESC, candidate_id ASC
       LIMIT ?`,
    )
    .all(ownerScopeKey, limit) as unknown as RawSkillCandidateRow[]
  return rows.map(mapRawCandidate)
}

export function updateSkillCandidateStatus(
  db: DatabaseSync,
  ownerScopeKey: string,
  candidateId: string,
  status: AssocSkillCandidateStatus,
  updatedAt = Date.now(),
): boolean {
  if (!hasTable(db, 'assoc_skill_candidates')) return false
  const res = db
    .prepare(
      `UPDATE assoc_skill_candidates
       SET status = ?, updated_at = ?
       WHERE owner_scope_key = ? AND candidate_id = ?`,
    )
    .run(status, updatedAt, ownerScopeKey, candidateId)
  return res.changes > 0
}

interface RawImplicitSignalRow {
  readonly signal_id: string
  readonly owner_scope_key: string
  readonly cluster_id: string
  readonly kind: ImplicitSignalKind
  readonly trust: 'low'
  readonly candidate_only: number
  readonly report_only: number
  readonly evidence_json: string
  readonly created_at: number
}

function mapRawImplicitSignal(row: RawImplicitSignalRow): AssocImplicitSignal {
  return Object.freeze({
    signalId: row.signal_id,
    ownerScopeKey: row.owner_scope_key,
    clusterId: row.cluster_id,
    kind: row.kind,
    trust: 'low',
    candidateOnly: true,
    reportOnly: true,
    evidence: Object.freeze(JSON.parse(row.evidence_json) as Record<string, unknown>),
    createdAt: row.created_at,
  })
}

export function listImplicitSignals(
  db: DatabaseSync,
  ownerScopeKey: string,
  options?: {
    readonly kind?: ImplicitSignalKind
    readonly clusterId?: string
    readonly limit?: number
  },
): AssocImplicitSignal[] {
  if (!hasTable(db, 'assoc_implicit_signals')) return []
  const limit = Math.max(1, Math.min(1_000, Math.trunc(options?.limit ?? 100)))
  const clauses = ['owner_scope_key = ?']
  const params: Array<string | number> = [ownerScopeKey]
  if (options?.kind !== undefined) {
    clauses.push('kind = ?')
    params.push(options.kind)
  }
  if (options?.clusterId !== undefined) {
    clauses.push('cluster_id = ?')
    params.push(options.clusterId)
  }
  params.push(limit)

  const rows = db
    .prepare(
      `SELECT * FROM assoc_implicit_signals
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, signal_id ASC
       LIMIT ?`,
    )
    .all(...params) as unknown as RawImplicitSignalRow[]
  return rows.map(mapRawImplicitSignal)
}

export function reportImplicitSignalsToEvaluation(
  evaluationPeer: EvaluationAppendPeer | undefined,
  signals: readonly AssocImplicitSignal[],
  scope: { readonly workspace: string; readonly preset: string },
): { readonly reported: number; readonly skipped: number } {
  if (evaluationPeer === undefined || typeof evaluationPeer.append !== 'function') {
    return Object.freeze({ reported: 0, skipped: signals.length })
  }

  let reported = 0
  let skipped = 0

  for (const signal of signals) {
    if (signal.trust !== 'low' || !signal.candidateOnly || !signal.reportOnly) {
      throw new Error('assistant-association: implicit signals must remain low-trust, candidateOnly, reportOnly')
    }

    const digest = createHash('sha256')
      .update(JSON.stringify(signal.evidence), 'utf8')
      .digest('hex')

    const envelope: OutcomeEnvelope = {
      scope: {
        workspace: scope.workspace,
        preset: scope.preset,
      },
      situation: `association:implicit-signal:${signal.kind}`,
      executionStatus: 'unknown',
      objectiveStatus:
        signal.kind === 'redo' || signal.kind === 'owner-correction'
          ? 'not-achieved'
          : 'partial',
      deliveryStatus: 'not-required',
      source: {
        kind: 'system',
        id: 'assistant-association',
      },
      // Strictly 'self-reported' (never 'trusted')
      trust: 'self-reported',
      evidence: [
        {
          kind: 'association-cluster',
          ref: signal.clusterId,
          digest,
        },
        {
          kind: 'implicit-signal',
          ref: signal.signalId,
        },
      ],
      metrics: {},
      occurredAt: signal.createdAt,
      idempotencyKey: `assistant-association:implicit-signal:${signal.signalId}`,
      evaluator: {
        id: 'assistant-association',
        version: '1',
      },
    }

    try {
      evaluationPeer.append(envelope)
      reported += 1
    } catch {
      skipped += 1
    }
  }

  return Object.freeze({ reported, skipped })
}
