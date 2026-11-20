import { createHash } from 'node:crypto'

export const NODE_KINDS = [
  'memory',
  'goal',
  'work-item',
  'automation',
  'episode',
  'wiki',
  'skill',
  'event',
  'dream',
  'abstraction',
  'web',
] as const

export type NodeKind = (typeof NODE_KINDS)[number]

export const NODE_KIND_TO_CODE: Readonly<Record<NodeKind, number>> = Object.freeze({
  memory: 0,
  goal: 1,
  'work-item': 2,
  automation: 3,
  episode: 4,
  wiki: 5,
  skill: 6,
  event: 7,
  dream: 8,
  abstraction: 9,
  web: 10,
})

export const CODE_TO_NODE_KIND: readonly NodeKind[] = NODE_KINDS

export const EDGE_TYPES = [
  'cooccur',
  'entity',
  'dream',
  'hebbian',
  'synonym',
  'abstraction',
] as const

export type EdgeType = (typeof EDGE_TYPES)[number]

export const EDGE_TYPE_TO_CODE: Readonly<Record<EdgeType, number>> = Object.freeze({
  cooccur: 0,
  entity: 1,
  dream: 2,
  hebbian: 3,
  synonym: 4,
  abstraction: 5,
})

export const CODE_TO_EDGE_TYPE: readonly EdgeType[] = EDGE_TYPES

export const OWNER_MODES = ['delivery', 'headless', 'system'] as const
export type AssociationOwnerMode = (typeof OWNER_MODES)[number]

export const SCOPE_MODES = ['user-global', 'workspace'] as const
export type AssociationScopeMode = (typeof SCOPE_MODES)[number]

export const TRUST_LEVELS = ['trusted', 'low'] as const
export type AssociationTrust = (typeof TRUST_LEVELS)[number]

export const SENSITIVITY_LEVELS = ['private', 'sensitive'] as const
export type AssociationSensitivity = (typeof SENSITIVITY_LEVELS)[number]

export const NODE_STATUSES = ['active', 'suppressed', 'withdrawn'] as const
export type AssociationNodeStatus = (typeof NODE_STATUSES)[number]

export const HOLDOUT_TASK_KINDS = [
  'foreground-turn',
  'automation-run',
  'goal-step',
  'goal-outcome',
  'work-item',
  'headless-session',
] as const
export type HoldoutTaskKind = (typeof HOLDOUT_TASK_KINDS)[number]

export const FALLBACK_MODES = [
  'none',
  'memory-only',
  'cold-start',
  'timeout',
  'holdout',
] as const
export type FallbackMode = (typeof FALLBACK_MODES)[number]

export interface AssociationOwnerScope {
  readonly mode: AssociationOwnerMode
  readonly ownerScopeKey: string
  readonly principalId: string
  readonly principalDigest: string
  readonly principalRecordId: string | null
  readonly principalVersion: number | null
  readonly workspace: string
  readonly agentPreset: string
  readonly authorityId?: string
}

export interface AssociationNodeMetadata {
  readonly toolNames?: readonly string[]
  readonly objectiveStatus?: string
  readonly conflicted?: boolean
  readonly memoryOwner?: 'user' | 'agent'
  readonly memoryScope?: AssociationScopeMode
  readonly sourceUrl?: string
  readonly fetchedAt?: number
  readonly extra?: Readonly<Record<string, unknown>>
}

export interface UpsertNodeInput {
  readonly id: string
  readonly kind: NodeKind
  readonly sourcePlugin: string
  readonly sourceRef: string
  readonly sourceVersion: number
  readonly ownerScopeKey: string
  readonly ownerMode: AssociationOwnerMode
  readonly principalDigest: string | null
  readonly principalRecordId: string | null
  readonly principalVersion: number | null
  readonly scopeMode: AssociationScopeMode
  readonly workspace: string
  readonly agentPreset: string
  readonly trust: AssociationTrust
  readonly sensitivity: AssociationSensitivity
  readonly title: string
  readonly body: string
  readonly entities: readonly string[]
  readonly tokens: readonly string[]
  readonly metadata?: AssociationNodeMetadata
  readonly ttlMs?: number | null
  readonly expiresAt?: number | null
  readonly status?: AssociationNodeStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface UpsertEdgeInput {
  readonly edgeId: string
  readonly aId: string
  readonly bId: string
  readonly edgeType: EdgeType
  readonly weight: number
  readonly trust: AssociationTrust
  readonly reason: string
  readonly useCount?: number
  readonly lastUsedAt?: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface UpsertSynonymInput {
  readonly id: string
  readonly ownerScopeKey: string
  readonly surface: string
  readonly canonicalEntity: string
  readonly sourceNodeId?: string | null
  readonly trust: AssociationTrust
  readonly createdAt: number
}

export interface DerivedRefInput {
  readonly sourceNodeId: string
  readonly sourceVersion: number
  readonly targetKind: 'node' | 'edge' | 'synonym'
  readonly targetId: string
}

export interface StoredAssociationNode {
  readonly id: string
  readonly kind: NodeKind
  readonly sourcePlugin: string
  readonly sourceRef: string
  readonly sourceVersion: number
  readonly ownerScopeKey: string
  readonly ownerMode: AssociationOwnerMode
  readonly principalDigest: string | null
  readonly principalRecordId: string | null
  readonly principalVersion: number | null
  readonly scopeMode: AssociationScopeMode
  readonly workspace: string
  readonly agentPreset: string
  readonly trust: AssociationTrust
  readonly sensitivity: AssociationSensitivity
  readonly title: string
  readonly body: string
  readonly entities: readonly string[]
  readonly tokens: readonly string[]
  readonly metadata: AssociationNodeMetadata
  readonly ttlMs: number | null
  readonly expiresAt: number | null
  readonly status: AssociationNodeStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface StoredAssociationEdge {
  readonly edgeId: string
  readonly aId: string
  readonly bId: string
  readonly edgeType: EdgeType
  readonly weight: number
  readonly trust: AssociationTrust
  readonly reason: string
  readonly useCount: number
  readonly lastUsedAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface StoredAssociationSynonym {
  readonly id: string
  readonly ownerScopeKey: string
  readonly surface: string
  readonly canonicalEntity: string
  readonly sourceNodeId: string | null
  readonly trust: AssociationTrust
  readonly createdAt: number
}

export interface IngestCursorRow {
  readonly sourcePlugin: string
  readonly scopeKey: string
  readonly cursorJson: string
  readonly updatedAt: number
}

export interface HoldoutAssignmentRow {
  readonly taskId: string
  readonly ownerScopeKey: string
  readonly taskKind: HoldoutTaskKind
  readonly sessionId: string | null
  readonly turnNumber: number | null
  readonly inHoldout: boolean
  readonly bucketBps: number
  readonly rateBps: number
  readonly hmacDigest: string
  readonly assignedAt: number
}

export interface StepMetricRow {
  readonly taskId: string | null
  readonly ownerScopeKey: string
  readonly inHoldout: boolean
  readonly latencyUs: number
  readonly timedOut: boolean
  readonly fallbackMode: FallbackMode
  readonly injectedCount: number
  readonly candidateCount: number
  readonly sourceCounts: Readonly<Record<string, number>>
  readonly occurredAt: number
}

export interface ExposureRow {
  readonly taskId: string
  readonly nodeId: string
  readonly ownerScopeKey: string
  readonly sourcePlugin: string
  readonly exposedAt: number
  readonly assocReadCount?: number
  readonly weakUseCount?: number
  readonly corrected?: boolean
}

export type WriteTask =
  | {
      readonly kind: 'upsert-nodes'
      readonly nodes: readonly UpsertNodeInput[]
      readonly edges: readonly UpsertEdgeInput[]
      readonly synonyms?: readonly UpsertSynonymInput[]
      readonly derivedRefs: readonly DerivedRefInput[]
      readonly cursor?: {
        readonly sourcePlugin: string
        readonly scopeKey: string
        readonly cursorJson: string
      }
    }
  | {
      readonly kind: 'withdraw-source'
      readonly ownerScopeKey: string
      readonly sourcePlugin: string
      readonly sourceRef: string
      readonly hardDelete: boolean
      readonly maxSourceVersion?: number
      readonly recordWithdrawalTombstone?: boolean
    }
  | {
      readonly kind: 'record-holdout'
      readonly row: HoldoutAssignmentRow
    }
  | {
      readonly kind: 'record-metrics'
      readonly metrics: readonly StepMetricRow[]
      readonly exposures: readonly ExposureRow[]
    }

export type HotPathCueKind = 'user' | 'goal' | 'tool-entity' | 'session'

export interface HotPathCue {
  readonly kind: HotPathCueKind
  readonly text: string
  readonly entities?: readonly string[]
  readonly weight: number
}

export interface SessionActivationEntry {
  readonly nodeId: string
  readonly score: number
  readonly updatedAt: number
}

export interface HotPathFilter {
  readonly ownerScopeKey: string
  readonly workspace: string
  readonly agentPreset: string
  readonly allowLowTrust: boolean
  readonly allowSensitive: boolean
  readonly nowMs: number
}

export interface HotPathProfile {
  readonly maxHops: number
  readonly hopTopN: number
  readonly maxFanoutPerNode: number
  readonly maxItems: number
  readonly decayHalfLifeMs: number
  readonly budgetMs: number
  readonly sourceWeights: Readonly<Record<NodeKind, number>>
}

export interface ScoredAssociationItem {
  readonly slot: number
  readonly id: string
  readonly kind: NodeKind
  readonly title: string
  readonly trust: AssociationTrust
  readonly sensitivity: AssociationSensitivity
  readonly score: number
  readonly reason: string
  readonly hop: number
  readonly sourcePlugin: string
  readonly updatedAt: number
}

export interface HotPathResult {
  readonly timedOut: boolean
  readonly elapsedMs: number
  readonly items: readonly ScoredAssociationItem[]
  readonly candidateCount: number
}

export type HotPathClock = () => number

export interface HoldoutDecision {
  readonly taskId: string
  readonly inHoldout: boolean
  readonly bucketBps: number
  readonly rateBps: number
  readonly hmacDigest: string
}

export const DEFAULT_SOURCE_WEIGHTS: Readonly<Record<NodeKind, number>> = Object.freeze({
  memory: 1.0,
  goal: 1.15,
  'work-item': 1.0,
  automation: 0.95,
  episode: 1.0,
  wiki: 0.95,
  skill: 1.05,
  event: 0.9,
  dream: 0.75,
  abstraction: 0.85,
  web: 0.7,
})

export function computePrincipalDigest(principalId: string): string {
  return createHash('sha256').update(principalId, 'utf8').digest('hex')
}

export function computeOwnerScopeKey(input: {
  readonly mode: AssociationOwnerMode
  readonly principalDigest: string | null
  readonly principalRecordId: string | null
  readonly principalVersion: number | null
  readonly workspace: string
  readonly agentPreset: string
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.mode,
        input.principalDigest ?? '',
        input.principalRecordId ?? '',
        input.principalVersion ?? 0,
        input.workspace,
        input.agentPreset,
      ]),
      'utf8',
    )
    .digest('hex')
}

export function computeDeterministicEdgeId(
  aId: string,
  bId: string,
  edgeType: EdgeType,
): string {
  const [left, right] = aId <= bId ? [aId, bId] : [bId, aId]
  return createHash('sha256')
    .update(`${left}\0${right}\0${edgeType}`, 'utf8')
    .digest('hex')
}

export function normalizeSourceVersion(version: number | string): number {
  if (typeof version === 'number') {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(`assistant-association: invalid numeric sourceVersion: ${version}`)
    }
    return version
  }
  const parsed = Number.parseInt(version.replace(/^v/u, ''), 10)
  if (Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === version.replace(/^v/u, '')) {
    return parsed
  }
  const digest = createHash('sha256').update(version, 'utf8').digest()
  const hi = digest.readUInt32BE(0) & 0x001f_ffff
  const lo = digest.readUInt32BE(4)
  return hi * 0x1_0000_0000 + lo
}
