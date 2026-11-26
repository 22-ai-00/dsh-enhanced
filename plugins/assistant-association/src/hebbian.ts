import type { TrustedTaskLearningProjectionReceipt } from '@dsh-ray/assistant-evaluation'
import { isBoundaryMatch, stepAcState, type EntityAutomaton } from './aho-corasick.js'
import { extractEntities } from './entities.js'
import { normalizeEntityKey, normalizeForAc } from './tokenize.js'

export const MAX_WEAK_USE_TEXT_CHARS = 32_768
const DEFAULT_MAX_HOP0_TARGETS = 16
const DELTA_EPSILON = 1e-12

export interface ExposedNodeEntitiesInput {
  readonly nodeId: string
  readonly entities: readonly string[]
}

export function computeUniqueExposedEntities(
  exposedNodes: readonly ExposedNodeEntitiesInput[],
  turnPromptEntities: ReadonlySet<string>,
): Map<string, readonly string[]> {
  const promptSet = new Set<string>()
  for (const raw of turnPromptEntities) {
    const key = normalizeEntityKey(raw)
    if (key !== null) {
      promptSet.add(key)
    }
  }

  const nodeEntitySets = new Map<string, Set<string>>()
  for (const node of exposedNodes) {
    let set = nodeEntitySets.get(node.nodeId)
    if (set === undefined) {
      set = new Set<string>()
      nodeEntitySets.set(node.nodeId, set)
    }
    for (const raw of node.entities) {
      const key = normalizeEntityKey(raw)
      if (key !== null) {
        set.add(key)
      }
    }
  }

  const entityNodeCounts = new Map<string, number>()
  for (const set of nodeEntitySets.values()) {
    for (const key of set) {
      entityNodeCounts.set(key, (entityNodeCounts.get(key) ?? 0) + 1)
    }
  }

  const result = new Map<string, readonly string[]>()
  for (const [nodeId, set] of nodeEntitySets) {
    const unique: string[] = []
    for (const key of set) {
      if (!promptSet.has(key) && entityNodeCounts.get(key) === 1) {
        unique.push(key)
      }
    }
    result.set(nodeId, unique)
  }
  return result
}

export interface DetectWeakUseNodesInput {
  readonly assistantText: string
  readonly exposedNodes: readonly ExposedNodeEntitiesInput[]
  readonly turnPromptEntities: ReadonlySet<string>
  readonly entityAutomaton?: EntityAutomaton | null
  readonly ownerScopeKey?: string
  readonly allowLowTrust?: boolean
  readonly extractFallbackEntities?: (text: string) => readonly string[]
}

export function detectWeakUseNodes(input: DetectWeakUseNodesInput): string[] {
  if (input.assistantText.length === 0 || input.exposedNodes.length === 0) {
    return []
  }

  const uniqueByNode = computeUniqueExposedEntities(input.exposedNodes, input.turnPromptEntities)
  let hasAnyUnique = false
  for (const unique of uniqueByNode.values()) {
    if (unique.length > 0) {
      hasAnyUnique = true
      break
    }
  }
  if (!hasAnyUnique) {
    return []
  }

  const boundedText =
    input.assistantText.length > MAX_WEAK_USE_TEXT_CHARS
      ? input.assistantText.slice(0, MAX_WEAK_USE_TEXT_CHARS)
      : input.assistantText

  const matchedEntities = new Set<string>()

  const ac = input.entityAutomaton
  if (ac !== undefined && ac !== null && ac.entityCount > 0) {
    const filterByOwner = input.ownerScopeKey !== undefined
    const acOwnerIdx = filterByOwner ? (ac.ownerKeyToIdx.get(input.ownerScopeKey!) ?? -1) : -1
    const allowLowTrust = input.allowLowTrust ?? true
    const normText = normalizeForAc(boundedText)
    let state = 0
    for (let i = 0; i < normText.length; i += 1) {
      const ch = normText.charCodeAt(i)
      state = stepAcState(ac, state, ch)
      const oStart = ac.outOffset[state]!
      const oEnd = ac.outOffset[state + 1]!
      if (oStart === oEnd) continue
      for (let oi = oStart; oi < oEnd; oi += 1) {
        if (isBoundaryMatch(ac, oi, normText, i) < 0) continue
        if (filterByOwner) {
          const synOwnerIdx = ac.outSynonymOwnerIdx[oi]!
          if (synOwnerIdx >= 0 && synOwnerIdx !== acOwnerIdx) continue
        }
        if (!allowLowTrust && ac.outSynonymTrust[oi] === 0) continue
        const eid = ac.outEntityId[oi]!
        const entName = ac.entityNames[eid]
        if (entName !== undefined) {
          matchedEntities.add(entName)
        }
      }
    }
  }

  const fallbackExtractor =
    input.extractFallbackEntities ?? ((text: string) => extractEntities(text, 256))
  for (const raw of fallbackExtractor(boundedText)) {
    const key = normalizeEntityKey(raw)
    if (key !== null) {
      matchedEntities.add(key)
    }
  }

  if (matchedEntities.size === 0) {
    return []
  }

  const matchedNodeIds: string[] = []
  const seenNodes = new Set<string>()
  for (const node of input.exposedNodes) {
    if (seenNodes.has(node.nodeId)) continue
    seenNodes.add(node.nodeId)
    const unique = uniqueByNode.get(node.nodeId)
    if (unique === undefined || unique.length === 0) continue
    for (let i = 0; i < unique.length; i += 1) {
      if (matchedEntities.has(unique[i]!)) {
        matchedNodeIds.push(node.nodeId)
        break
      }
    }
  }
  return matchedNodeIds
}

export function clampEdgeWeight(weight: number, weightMin: number, weightMax: number): number {
  const lo = Math.min(weightMin, weightMax)
  const hi = Math.max(weightMin, weightMax)
  if (!Number.isFinite(weight)) return lo
  if (weight <= lo) return lo
  if (weight >= hi) return hi
  return weight
}

export interface HebbianUseDeltaInput {
  readonly useKind: 'strong' | 'weak'
  readonly strongUsed: boolean
  readonly weakUsed: boolean
  readonly hebbianDeltaApplied: number
  readonly alpha: number
  readonly weakRatio: number
}

export function computeHebbianUseDelta(input: HebbianUseDeltaInput): number {
  const alpha = Number.isFinite(input.alpha) && input.alpha > 0 ? input.alpha : 0
  const weakRatio =
    Number.isFinite(input.weakRatio) && input.weakRatio > 0 ? Math.min(1, input.weakRatio) : 0
  if (alpha === 0) return 0

  const applied =
    Number.isFinite(input.hebbianDeltaApplied) && input.hebbianDeltaApplied > 0
      ? input.hebbianDeltaApplied
      : 0

  if (input.useKind === 'strong') {
    if (input.strongUsed) return 0
    const prior = Math.max(applied, input.weakUsed ? alpha * weakRatio : 0)
    const delta = alpha - prior
    return delta > DELTA_EPSILON ? delta : 0
  }

  if (input.strongUsed || input.weakUsed) return 0
  const weakTarget = alpha * weakRatio
  const delta = weakTarget - applied
  return delta > DELTA_EPSILON ? delta : 0
}

export interface ExponentialDecayWeightInput {
  readonly weight: number
  readonly anchorAt: number
  readonly lastDecayedAt: number | null | undefined
  readonly nowMs: number
  readonly nonUseGraceMs: number
  readonly decayHalfLifeMs: number
  readonly weightMin: number
  readonly weightMax: number
}

export function computeExponentialDecayWeight(input: ExponentialDecayWeightInput): number {
  const baseWeight = clampEdgeWeight(input.weight, input.weightMin, input.weightMax)
  if (!Number.isFinite(input.decayHalfLifeMs) || input.decayHalfLifeMs <= 0) {
    return baseWeight
  }
  const graceMs = Number.isFinite(input.nonUseGraceMs) && input.nonUseGraceMs > 0
    ? input.nonUseGraceMs
    : 0
  const decayStart = Math.max(input.lastDecayedAt ?? 0, input.anchorAt + graceMs)
  const dt = Math.max(0, input.nowMs - decayStart)
  if (dt === 0) {
    return baseWeight
  }
  const nextWeight = baseWeight * Math.exp((-Math.LN2 * dt) / input.decayHalfLifeMs)
  return clampEdgeWeight(nextWeight, input.weightMin, input.weightMax)
}

export interface Hop0CoActivationTargetsInput {
  readonly nodeId: string
  readonly coExposedNodeIds?: readonly string[]
  readonly goalNodeId?: string | null
  readonly sessionNodeIds?: readonly string[]
  readonly episodeNodeId?: string | null
  readonly maxTargets?: number
}

export function selectHop0CoActivationTargets(input: Hop0CoActivationTargetsInput): string[] {
  const limit =
    input.maxTargets !== undefined && input.maxTargets >= 0
      ? Math.floor(input.maxTargets)
      : DEFAULT_MAX_HOP0_TARGETS
  if (limit === 0) return []

  const seen = new Set<string>([input.nodeId])
  const targets: string[] = []

  const push = (candidate: string | null | undefined): void => {
    if (targets.length >= limit) return
    if (typeof candidate !== 'string' || candidate.length === 0) return
    if (seen.has(candidate)) return
    seen.add(candidate)
    targets.push(candidate)
  }

  push(input.goalNodeId)
  push(input.episodeNodeId)
  if (input.coExposedNodeIds !== undefined) {
    for (const id of input.coExposedNodeIds) {
      if (targets.length >= limit) break
      push(id)
    }
  }
  if (input.sessionNodeIds !== undefined) {
    for (const id of input.sessionNodeIds) {
      if (targets.length >= limit) break
      push(id)
    }
  }
  return targets
}

export interface EvaluationOwnerRevisionLike {
  readonly action?: 'initial' | 'correct' | 'withdraw'
  readonly objectiveStatus?: string
}

export function classifyEvaluationCorrection(
  receipt: TrustedTaskLearningProjectionReceipt,
  revision?: EvaluationOwnerRevisionLike | null,
): boolean {
  if (revision?.action === 'withdraw') return true
  if (receipt.projection.disposition === 'retract') return true
  if (receipt.projection.disposition !== 'upsert') return false
  if (revision?.action === 'correct' && revision.objectiveStatus !== 'achieved') {
    return true
  }
  const obj = receipt.objective
  if (obj !== undefined && obj.source.kind === 'user-feedback' && obj.status === 'not-achieved') {
    return true
  }
  return false
}
