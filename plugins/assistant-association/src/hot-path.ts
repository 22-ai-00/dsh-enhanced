import { isBoundaryMatch, stepAcState } from './aho-corasick.js'
import type { AssociationMemoryIndex, HotPathScratchpad } from './index-memory.js'
import { normalizeEntityKey, normalizeForAc, tokenizeAssociationText } from './tokenize.js'
import {
  CODE_TO_NODE_KIND,
  type HotPathClock,
  type HotPathCue,
  type HotPathFilter,
  type HotPathProfile,
  type HotPathResult,
  type ScoredAssociationItem,
  type SessionActivationEntry,
} from './types.js'

const LN2 = Math.LN2
const REASON_ENTITY = 1
const REASON_BM25 = 2
const REASON_SESSION = 3
const REASON_EDGE = 4

const DEFAULT_BM25_MAX_POSTINGS = 2_000
const DEFAULT_BM25_QUERY_BUDGET = 4_000

const sourceWeightsCache = new WeakMap<Record<string, number>, Float32Array>()

function getSourceWeightsByCode(sourceWeights: Record<string, number>): Float32Array {
  let cached = sourceWeightsCache.get(sourceWeights)
  if (cached !== undefined) return cached
  cached = new Float32Array(CODE_TO_NODE_KIND.length)
  for (let k = 0; k < CODE_TO_NODE_KIND.length; k += 1) {
    cached[k] = sourceWeights[CODE_TO_NODE_KIND[k]!] ?? 1.0
  }
  sourceWeightsCache.set(sourceWeights, cached)
  return cached
}

function defaultClock(): number {
  return performance.now()
}

function selectTopN(
  slots: Uint32Array,
  count: number,
  scores: Float32Array,
  updatedAt: Float64Array,
  n: number,
  outSlots: Uint32Array,
  outScores: Float32Array,
): number {
  if (count === 0 || n <= 0) return 0
  const cap = Math.min(n, outSlots.length, count)
  let size = 0

  for (let i = 0; i < count; i += 1) {
    const slot = slots[i]!
    const sc = scores[slot]!
    if (sc <= 0) continue

    if (size < cap) {
      let pos = size
      const slotUpd = updatedAt[slot]!
      while (pos > 0) {
        const prevSlot = outSlots[pos - 1]!
        const prevSc = outScores[pos - 1]!
        if (sc < prevSc || (sc === prevSc && slotUpd <= updatedAt[prevSlot]!)) break
        outSlots[pos] = prevSlot
        outScores[pos] = prevSc
        pos -= 1
      }
      outSlots[pos] = slot
      outScores[pos] = sc
      size += 1
    } else {
      const minSc = outScores[size - 1]!
      const minSlot = outSlots[size - 1]!
      if (sc < minSc || (sc === minSc && updatedAt[slot]! <= updatedAt[minSlot]!)) {
        continue
      }
      let pos = size - 1
      const slotUpd = updatedAt[slot]!
      while (pos > 0) {
        const prevSlot = outSlots[pos - 1]!
        const prevSc = outScores[pos - 1]!
        if (sc < prevSc || (sc === prevSc && slotUpd <= updatedAt[prevSlot]!)) break
        outSlots[pos] = prevSlot
        outScores[pos] = prevSc
        pos -= 1
      }
      outSlots[pos] = slot
      outScores[pos] = sc
    }
  }
  return size
}

function formatReason(
  index: AssociationMemoryIndex,
  pad: HotPathScratchpad,
  slot: number,
): string {
  const rType = pad.reasonType[slot]!
  const rArg = pad.reasonArg[slot]!
  if (rType === REASON_ENTITY) {
    return `entity:${index.ac.entityNames[rArg] ?? ''}`
  }
  if (rType === REASON_BM25) {
    return `keyword:${index.bm25.tokenNames[rArg] ?? ''}`
  }
  if (rType === REASON_SESSION) {
    return 'session:active'
  }
  if (rType === REASON_EDGE && rArg >= 0) {
    const reasonId = index.adjReasonId[rArg]!
    return index.reasonPool[reasonId] ?? 'graph:link'
  }
  return 'assoc'
}

export function runHotPathQuery(
  index: AssociationMemoryIndex,
  cues: readonly HotPathCue[],
  filter: HotPathFilter,
  profile: HotPathProfile,
  options?: {
    readonly sessionActivations?: readonly SessionActivationEntry[]
    readonly clock?: HotPathClock
    readonly bm25MaxPostingsScan?: number
  },
): HotPathResult {
  const clock = options?.clock ?? defaultClock
  const t0 = clock()
  const deadline = t0 + profile.budgetMs

  if (profile.budgetMs <= 0 || clock() >= deadline) {
    return {
      timedOut: true,
      elapsedMs: Math.max(0, clock() - t0),
      items: [],
      candidateCount: 0,
    }
  }

  if (index.nodeCount === 0) {
    return {
      timedOut: false,
      elapsedMs: Math.max(0, clock() - t0),
      items: [],
      candidateCount: 0,
    }
  }

  const ownerIdx = index.ownerKeys.get(filter.ownerScopeKey)
  if (ownerIdx === undefined) {
    return {
      timedOut: false,
      elapsedMs: Math.max(0, clock() - t0),
      items: [],
      candidateCount: 0,
    }
  }

  const wsIdx = index.workspaces.get(filter.workspace) ?? 0xffff_ffff
  const presetIdx = index.presets.get(filter.agentPreset) ?? 0xffff_ffff
  const allowSensitive = filter.allowSensitive
  const allowLowTrust = filter.allowLowTrust
  const nowMs = filter.nowMs
  const halfLife = Math.max(1, profile.decayHalfLifeMs)
  const bm25ScanCap = options?.bm25MaxPostingsScan ?? DEFAULT_BM25_MAX_POSTINGS

  const sourceWeightsByCode = getSourceWeightsByCode(profile.sourceWeights)

  const {
    nodeTombstoned,
    nodeOwnerIdx,
    nodeScopeMode,
    nodeWorkspaceIdx,
    nodePresetIdx,
    nodeSensitivity,
    nodeTrust,
    nodeExpiresAt,
    nodeUpdatedAt,
    nodeKind,
    adjOffset,
    adjTarget,
    adjWeight,
    adjTrust,
    ac,
    bm25,
  } = index

  const isEligible = (slot: number): boolean => {
    if (nodeTombstoned[slot] !== 0) return false
    if (nodeOwnerIdx[slot] !== ownerIdx) return false
    if (nodeScopeMode[slot] !== 0) {
      if (nodeWorkspaceIdx[slot] !== wsIdx || nodePresetIdx[slot] !== presetIdx) return false
    }
    if (!allowSensitive && nodeSensitivity[slot] !== 0) return false
    if (!allowLowTrust && nodeTrust[slot] === 0) return false
    const exp = nodeExpiresAt[slot]!
    if (exp !== 0 && exp <= nowMs) return false
    return true
  }

  const pad = index.acquireScratchpad()
  try {
    pad.epoch += 1
    if (pad.epoch >= 0xffff_fffe) {
      pad.stamp.fill(0)
      pad.expandedStamp.fill(0)
      pad.epoch = 1
    }
    const epoch = pad.epoch
    let touchedCount = 0

    const addScore = (
      slot: number,
      contrib: number,
      hop: number,
      reasonType: number,
      reasonArg: number,
    ): void => {
      if (contrib <= 0) return
      if (pad.stamp[slot] !== epoch) {
        pad.stamp[slot] = epoch
        pad.score[slot] = contrib
        pad.hopReached[slot] = hop
        pad.bestContrib[slot] = contrib
        pad.reasonType[slot] = reasonType
        pad.reasonArg[slot] = reasonArg
        pad.touchedSlots[touchedCount] = slot
        touchedCount += 1
      } else {
        pad.score[slot] = pad.score[slot]! + contrib
        if (contrib > pad.bestContrib[slot]!) {
          pad.bestContrib[slot] = contrib
          pad.reasonType[slot] = reasonType
          pad.reasonArg[slot] = reasonArg
        }
      }
    }

    const abortTimeout = (): HotPathResult => ({
      timedOut: true,
      elapsedMs: Math.max(0, clock() - t0),
      items: [],
      candidateCount: touchedCount,
    })

    let bm25QueryBudget = Math.max(bm25ScanCap, DEFAULT_BM25_QUERY_BUDGET)

    // Hop 0: Seed assembly from cues
    for (let c = 0; c < cues.length; c += 1) {
      if (clock() >= deadline) return abortTimeout()
      const cue = cues[c]!
      if (cue.weight <= 0) continue

      if (cue.kind === 'tool-entity' && cue.entities !== undefined) {
        for (let e = 0; e < cue.entities.length; e += 1) {
          if ((e & 15) === 0 && clock() >= deadline) return abortTimeout()
          const entKey = normalizeEntityKey(cue.entities[e]!)
          if (entKey === null) continue
          const eid = ac.entityToId.get(entKey)
          if (eid === undefined) continue
          const idf = ac.entityIdf[eid]!
          const pStart = ac.entityNodeOffset[eid]!
          const pEnd = ac.entityNodeOffset[eid + 1]!
          for (let p = pStart; p < pEnd; p += 1) {
            if ((p & 255) === 0 && clock() >= deadline) return abortTimeout()
            const slot = ac.entityNodeSlot[p]!
            if (!isEligible(slot)) continue
            const dt = nowMs - nodeUpdatedAt[slot]!
            const decay = dt > 0 ? Math.exp((-LN2 * dt) / halfLife) : 1.0
            const sw = sourceWeightsByCode[nodeKind[slot]!]!
            addScore(slot, cue.weight * idf * sw * decay, 0, REASON_ENTITY, eid)
          }
        }
        continue
      }

      if (cue.text.length === 0) continue

      pad.cueEpoch += 1
      if (pad.cueEpoch >= 0xffff_fffe) {
        pad.entitySeenStamp.fill(0)
        pad.cueEpoch = 1
      }
      const cueEpoch = pad.cueEpoch

      const normText = normalizeForAc(cue.text)
      let state = 0

      for (let i = 0; i < normText.length; i += 1) {
        if ((i & 255) === 0 && clock() >= deadline) return abortTimeout()
        const ch = normText.charCodeAt(i)
        state = stepAcState(ac, state, ch)

        const oStart = ac.outOffset[state]!
        const oEnd = ac.outOffset[state + 1]!
        if (oStart === oEnd) continue

        for (let oi = oStart; oi < oEnd; oi += 1) {
          const startPos = isBoundaryMatch(ac, oi, normText, i)
          if (startPos < 0) continue

          const eid = ac.outEntityId[oi]!
          if (pad.entitySeenStamp[eid] === cueEpoch) continue
          pad.entitySeenStamp[eid] = cueEpoch

          const idf = ac.entityIdf[eid]!
          const pStart = ac.entityNodeOffset[eid]!
          const pEnd = ac.entityNodeOffset[eid + 1]!
          for (let p = pStart; p < pEnd; p += 1) {
            if ((p & 255) === 0 && clock() >= deadline) return abortTimeout()
            const slot = ac.entityNodeSlot[p]!
            if (!isEligible(slot)) continue
            const dt = nowMs - nodeUpdatedAt[slot]!
            const decay = dt > 0 ? Math.exp((-LN2 * dt) / halfLife) : 1.0
            const sw = sourceWeightsByCode[nodeKind[slot]!]!
            addScore(slot, cue.weight * idf * sw * decay, 0, REASON_ENTITY, eid)
          }
        }
      }

      if (normText.trim().length > 0 && bm25QueryBudget > 0) {
        const tokens = tokenizeAssociationText(normText)
        const matchedTids: number[] = []
        for (let t = 0; t < tokens.length; t += 1) {
          const tid = bm25.tokenToId.get(tokens[t]!)
          if (tid !== undefined) {
            matchedTids.push(tid)
          }
        }
        if (matchedTids.length > 1) {
          matchedTids.sort((a, b) => bm25.tokenIdf[b]! - bm25.tokenIdf[a]!)
        }
        for (let t = 0; t < matchedTids.length && bm25QueryBudget > 0; t += 1) {
          if (clock() >= deadline) return abortTimeout()
          const tid = matchedTids[t]!
          const idf = bm25.tokenIdf[tid]!
          const pStart = bm25.tokenPostingsOffset[tid]!
          const postingsLen = bm25.tokenPostingsOffset[tid + 1]! - pStart
          const remainingTokens = matchedTids.length - t
          const perTokenBudget = Math.min(
            bm25ScanCap,
            bm25QueryBudget,
            Math.max(128, Math.floor(bm25QueryBudget / remainingTokens)),
          )
          const scanLen = Math.min(postingsLen, perTokenBudget)
          const pEnd = pStart + scanLen
          bm25QueryBudget -= scanLen
          for (let p = pStart; p < pEnd; p += 1) {
            if ((p & 255) === 0 && clock() >= deadline) return abortTimeout()
            const slot = bm25.tokenPostingsSlot[p]!
            if (!isEligible(slot)) continue
            const dt = nowMs - nodeUpdatedAt[slot]!
            const decay = dt > 0 ? Math.exp((-LN2 * dt) / halfLife) : 1.0
            const sw = sourceWeightsByCode[nodeKind[slot]!]!
            addScore(
              slot,
              cue.weight * idf * bm25.docNorm[slot]! * sw * decay,
              0,
              REASON_BM25,
              tid,
            )
          }
        }
      }
    }

    if (options?.sessionActivations) {
      for (let i = 0; i < options.sessionActivations.length; i += 1) {
        if ((i & 31) === 0 && clock() >= deadline) return abortTimeout()
        const act = options.sessionActivations[i]!
        const slot = index.nodeIdToSlot.get(act.nodeId)
        if (slot === undefined || !isEligible(slot)) continue
        const dt = nowMs - act.updatedAt
        const decay = dt > 0 ? Math.exp((-LN2 * dt) / halfLife) : 1.0
        addScore(slot, 0.5 * act.score * decay, 0, REASON_SESSION, 0)
      }
    }

    const hopTopN = Math.min(profile.hopTopN, pad.frontierSlots.length)
    let frontierCount = selectTopN(
      pad.touchedSlots,
      touchedCount,
      pad.score,
      nodeUpdatedAt,
      hopTopN,
      pad.frontierSlots,
      pad.frontierScores,
    )

    const maxHops = Math.min(2, Math.max(0, profile.maxHops))
    const maxFanout = Math.max(1, profile.maxFanoutPerNode)

    for (let hop = 1; hop <= maxHops; hop += 1) {
      if (frontierCount === 0) break
      pad.hopEpoch += 1
      if (pad.hopEpoch >= 0xffff_fffe) {
        pad.nextStamp.fill(0)
        pad.hopEpoch = 1
      }
      const hopEpoch = pad.hopEpoch
      let nextCount = 0

      for (let f = 0; f < frontierCount; f += 1) {
        if (clock() >= deadline) return abortTimeout()
        const u = pad.frontierSlots[f]!
        const uScore = pad.frontierScores[f]!
        pad.expandedStamp[u] = epoch

        const eStart = adjOffset[u]!
        const eEnd = Math.min(adjOffset[u + 1]!, eStart + maxFanout)
        for (let e = eStart; e < eEnd; e += 1) {
          if ((e & 63) === 0 && clock() >= deadline) return abortTimeout()
          if (!allowLowTrust && adjTrust[e] === 0) continue
          const v = adjTarget[e]!
          if (!isEligible(v)) continue

          const dt = nowMs - nodeUpdatedAt[v]!
          const decay = dt > 0 ? Math.exp((-LN2 * dt) / halfLife) : 1.0
          const sw = sourceWeightsByCode[nodeKind[v]!]!
          const prop = uScore * adjWeight[e]! * sw * decay
          if (prop <= 0) continue

          if (pad.stamp[v] !== epoch) {
            pad.stamp[v] = epoch
            pad.score[v] = prop
            pad.hopReached[v] = hop
            pad.bestContrib[v] = prop
            pad.reasonType[v] = REASON_EDGE
            pad.reasonArg[v] = e
            pad.touchedSlots[touchedCount] = v
            touchedCount += 1
          } else {
            const cur = pad.score[v]!
            const updated = prop > cur ? prop : cur
            pad.score[v] = updated
            if (prop > pad.bestContrib[v]!) {
              pad.bestContrib[v] = prop
              pad.reasonType[v] = REASON_EDGE
              pad.reasonArg[v] = e
            }
          }

          if (pad.expandedStamp[v] !== epoch) {
            if (pad.nextStamp[v] !== hopEpoch) {
              pad.nextStamp[v] = hopEpoch
              pad.nextScore[v] = prop
              pad.nextSlots[nextCount] = v
              nextCount += 1
            } else if (prop > pad.nextScore[v]!) {
              pad.nextScore[v] = prop
            }
          }
        }
      }

      if (hop < maxHops) {
        frontierCount = selectTopN(
          pad.nextSlots,
          nextCount,
          pad.nextScore,
          nodeUpdatedAt,
          hopTopN,
          pad.frontierSlots,
          pad.frontierScores,
        )
      }
    }

    const finalCap = Math.min(profile.maxItems, pad.frontierSlots.length)
    const winnerCount = selectTopN(
      pad.touchedSlots,
      touchedCount,
      pad.score,
      nodeUpdatedAt,
      finalCap,
      pad.frontierSlots,
      pad.frontierScores,
    )

    const items: ScoredAssociationItem[] = []
    for (let i = 0; i < winnerCount; i += 1) {
      const slot = pad.frontierSlots[i]!
      items.push({
        slot,
        id: index.nodeIds[slot]!,
        kind: CODE_TO_NODE_KIND[nodeKind[slot]!]!,
        title: index.nodeTitles[slot]!,
        trust: nodeTrust[slot] === 1 ? 'trusted' : 'low',
        sensitivity: nodeSensitivity[slot] === 1 ? 'sensitive' : 'private',
        score: pad.score[slot]!,
        reason: formatReason(index, pad, slot),
        hop: pad.hopReached[slot]!,
        sourcePlugin: index.nodeSourcePlugins[slot]!,
        updatedAt: nodeUpdatedAt[slot]!,
      })
    }

    return {
      timedOut: false,
      elapsedMs: Math.max(0, clock() - t0),
      items,
      candidateCount: touchedCount,
    }
  } finally {
    index.releaseScratchpad(pad)
  }
}
