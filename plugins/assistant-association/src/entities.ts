import { normalizeEntityKey } from './tokenize.js'
import {
  computeDeterministicEdgeId,
  type DerivedRefInput,
  type UpsertEdgeInput,
} from './types.js'

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'have',
  'will', 'are', 'was', 'were', 'not', 'but', 'can', 'use', 'used', 'using',
  'when', 'what', 'which', 'where', 'how', 'all', 'any', 'has', 'had', 'been',
  'true', 'false', 'null', 'undefined',
])

const STRUCTURED_TOKEN_RE = /[a-zA-Z0-9_]+(?:[./:-][a-zA-Z0-9_]+)+/gu
const CONSTANT_CODE_RE = /\b[A-Z][A-Z0-9_]{2,}\b/gu
const CJK_SPAN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,16}/gu
const WORD_RE = /[a-zA-Z][a-zA-Z0-9_-]{2,47}/gu

export function extractEntities(text: string, maxEntities = 32): string[] {
  const normalized = text.normalize('NFKC')
  const seen = new Set<string>()
  const result: string[] = []

  const push = (raw: string): void => {
    if (result.length >= maxEntities) return
    const key = normalizeEntityKey(raw)
    if (key === null || STOPWORDS.has(key) || seen.has(key)) return
    seen.add(key)
    result.push(key)
  }

  for (const match of normalized.matchAll(STRUCTURED_TOKEN_RE)) {
    push(match[0])
  }
  for (const match of normalized.matchAll(CONSTANT_CODE_RE)) {
    push(match[0])
  }
  for (const match of normalized.matchAll(CJK_SPAN_RE)) {
    const span = match[0]
    push(span)
    // Also emit 2-4 char prefixes/sub-phrases for long CJK phrases (>6 chars)
    if (span.length > 6 && result.length < maxEntities) {
      const chars = [...span]
      for (let i = 0; i + 2 <= chars.length && result.length < maxEntities; i += 2) {
        const sub = chars.slice(i, i + 2).join('')
        push(sub)
      }
    }
  }
  for (const match of normalized.matchAll(WORD_RE)) {
    push(match[0])
  }

  return result
}

export interface EntityEdgeCandidateNode {
  readonly id: string
  readonly sourceVersion: number
  readonly ownerScopeKey: string
  readonly trust: 'trusted' | 'low'
  readonly entities: readonly string[]
  readonly updatedAt: number
}

export function buildSharedEntityEdges(
  node: EntityEdgeCandidateNode,
  peers: readonly EntityEdgeCandidateNode[],
  options?: {
    readonly maxEdgesPerNode?: number
    readonly nowMs?: number
  },
): {
  readonly edges: readonly UpsertEdgeInput[]
  readonly derivedRefs: readonly DerivedRefInput[]
} {
  const maxEdges = options?.maxEdgesPerNode ?? 32
  const nowMs = options?.nowMs ?? node.updatedAt
  const nodeEntities = new Set(node.entities)
  if (nodeEntities.size === 0) {
    return { edges: [], derivedRefs: [] }
  }

  const scoredNeighbors: Array<{
    readonly peer: EntityEdgeCandidateNode
    readonly shared: string[]
    readonly weight: number
  }> = []

  for (const peer of peers) {
    if (peer.id === node.id || peer.ownerScopeKey !== node.ownerScopeKey) continue
    const shared: string[] = []
    for (const ent of peer.entities) {
      if (nodeEntities.has(ent)) shared.push(ent)
    }
    if (shared.length === 0) continue
    const weight = Math.min(1.0, 0.35 + 0.15 * Math.min(4, shared.length))
    scoredNeighbors.push({ peer, shared, weight })
  }

  scoredNeighbors.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight
    if (b.peer.updatedAt !== a.peer.updatedAt) return b.peer.updatedAt - a.peer.updatedAt
    return a.peer.id.localeCompare(b.peer.id)
  })

  const edges: UpsertEdgeInput[] = []
  const derivedRefs: DerivedRefInput[] = []
  const limit = Math.min(maxEdges, scoredNeighbors.length)

  for (let i = 0; i < limit; i += 1) {
    const item = scoredNeighbors[i]!
    const [aId, bId] = node.id <= item.peer.id ? [node.id, item.peer.id] : [item.peer.id, node.id]
    const edgeId = computeDeterministicEdgeId(aId, bId, 'entity')
    const reason = `entity:${item.shared.slice(0, 2).join(',')}`.slice(0, 256)
    const trust = node.trust === 'low' || item.peer.trust === 'low' ? 'low' : 'trusted'
    edges.push({
      edgeId,
      aId,
      bId,
      edgeType: 'entity',
      weight: item.weight,
      trust,
      reason,
      createdAt: nowMs,
      updatedAt: nowMs,
    })
    derivedRefs.push(
      {
        sourceNodeId: node.id,
        sourceVersion: node.sourceVersion,
        targetKind: 'edge',
        targetId: edgeId,
      },
      {
        sourceNodeId: item.peer.id,
        sourceVersion: item.peer.sourceVersion,
        targetKind: 'edge',
        targetId: edgeId,
      },
    )
  }

  return { edges, derivedRefs }
}
