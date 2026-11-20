import { buildEntityAutomaton, type AcSynonymEntry, type EntityAutomaton } from './aho-corasick.js'
import { buildBm25Index, type Bm25InvertedIndex } from './bm25.js'
import { normalizeEntityKey } from './tokenize.js'
import {
  EDGE_TYPE_TO_CODE,
  NODE_KIND_TO_CODE,
  computeDeterministicEdgeId,
  type AssociationOwnerMode,
  type AssociationScopeMode,
  type AssociationSensitivity,
  type AssociationTrust,
  type EdgeType,
  type NodeKind,
} from './types.js'

export interface MemoryIndexNodeInput {
  readonly id: string
  readonly kind: NodeKind
  readonly sourcePlugin: string
  readonly sourceRef: string
  readonly ownerScopeKey: string
  readonly ownerMode?: AssociationOwnerMode
  readonly scopeMode: AssociationScopeMode
  readonly workspace: string
  readonly agentPreset: string
  readonly trust: AssociationTrust
  readonly sensitivity: AssociationSensitivity
  readonly title: string
  readonly entities: readonly string[]
  readonly tokens: readonly string[]
  readonly expiresAt: number | null
  readonly updatedAt: number
}

export interface MemoryIndexEdgeInput {
  readonly edgeId?: string
  readonly aId: string
  readonly bId: string
  readonly edgeType: EdgeType
  readonly weight: number
  readonly trust: AssociationTrust
  readonly reason: string
}

export interface HotPathScratchpad {
  readonly capacity: number
  epoch: number
  hopEpoch: number
  cueEpoch: number
  inUse: boolean
  readonly stamp: Uint32Array
  readonly score: Float32Array
  readonly hopReached: Uint8Array
  readonly bestContrib: Float32Array
  readonly reasonType: Uint8Array
  readonly reasonArg: Int32Array
  readonly parentSlot: Int32Array
  readonly parentEdgeIdx: Int32Array
  readonly expandedStamp: Uint32Array
  readonly nextStamp: Uint32Array
  readonly nextScore: Float32Array
  readonly touchedSlots: Uint32Array
  readonly nextSlots: Uint32Array
  readonly frontierSlots: Uint32Array
  readonly frontierScores: Float32Array
  readonly entitySeenStamp: Uint32Array
  readonly intervalStart: Int32Array
  readonly intervalEnd: Int32Array
}

const MAX_INTERVALS = 512

export function createHotPathScratchpad(
  nodeCount: number,
  entityCount: number,
  hopTopN = 128,
): HotPathScratchpad {
  const cap = Math.max(1, nodeCount)
  const entCap = Math.max(1, entityCount)
  const parentSlot = new Int32Array(cap)
  const parentEdgeIdx = new Int32Array(cap)
  parentSlot.fill(-1)
  parentEdgeIdx.fill(-1)
  return {
    capacity: cap,
    epoch: 0,
    hopEpoch: 0,
    cueEpoch: 0,
    inUse: false,
    stamp: new Uint32Array(cap),
    score: new Float32Array(cap),
    hopReached: new Uint8Array(cap),
    bestContrib: new Float32Array(cap),
    reasonType: new Uint8Array(cap),
    reasonArg: new Int32Array(cap),
    parentSlot,
    parentEdgeIdx,
    expandedStamp: new Uint32Array(cap),
    nextStamp: new Uint32Array(cap),
    nextScore: new Float32Array(cap),
    touchedSlots: new Uint32Array(cap),
    nextSlots: new Uint32Array(cap),
    frontierSlots: new Uint32Array(hopTopN),
    frontierScores: new Float32Array(hopTopN),
    entitySeenStamp: new Uint32Array(entCap),
    intervalStart: new Int32Array(MAX_INTERVALS),
    intervalEnd: new Int32Array(MAX_INTERVALS),
  }
}

export interface AssociationMemoryIndex {
  readonly buildEpoch: number
  readonly builtAt: number
  readonly nodeCount: number
  readonly edgeHalfCount: number
  readonly nodeIds: readonly string[]
  readonly nodeIdToSlot: ReadonlyMap<string, number>
  readonly sourceRefToSlots: ReadonlyMap<string, readonly number[]>
  readonly nodeKind: Uint8Array
  readonly nodeOwnerIdx: Uint32Array
  readonly nodeScopeMode: Uint8Array
  readonly nodeWorkspaceIdx: Uint32Array
  readonly nodePresetIdx: Uint32Array
  readonly nodeTrust: Uint8Array
  readonly nodeSensitivity: Uint8Array
  readonly nodeUpdatedAt: Float64Array
  readonly nodeExpiresAt: Float64Array
  readonly nodeTombstoned: Uint8Array
  readonly nodeTitles: readonly string[]
  readonly nodeSourcePlugins: readonly string[]
  readonly nodeEntities: readonly (readonly string[])[]
  readonly ownerKeys: ReadonlyMap<string, number>
  readonly workspaces: ReadonlyMap<string, number>
  readonly presets: ReadonlyMap<string, number>
  readonly adjOffset: Uint32Array
  readonly adjTarget: Uint32Array
  readonly adjWeight: Float32Array
  readonly adjEdgeType: Uint8Array
  readonly adjTrust: Uint8Array
  readonly adjReasonId: Uint32Array
  readonly adjEdgeIdx: Uint32Array
  readonly edgeIds: readonly string[]
  readonly reasonPool: readonly string[]
  readonly ac: EntityAutomaton
  readonly bm25: Bm25InvertedIndex
  acquireScratchpad(): HotPathScratchpad
  releaseScratchpad(pad: HotPathScratchpad): void
  tombstoneNodeId(nodeId: string): boolean
  tombstoneSourceRef(ownerScopeKey: string, sourcePlugin: string, sourceRef: string): number
}

function internString(map: Map<string, number>, value: string): number {
  const existing = map.get(value)
  if (existing !== undefined) return existing
  const id = map.size
  map.set(value, id)
  return id
}

interface HalfEdgeRecord {
  readonly target: number
  readonly weight: number
  readonly flags: number
  readonly reasonId: number
  readonly edgeIdx: number
}

const EAGER_EDGE_ID_HASH_LIMIT = 20_000

interface CsrAdjacencyResult {
  readonly edgeHalfCount: number
  readonly adjOffset: Uint32Array
  readonly adjTarget: Uint32Array
  readonly adjWeight: Float32Array
  readonly adjEdgeType: Uint8Array
  readonly adjTrust: Uint8Array
  readonly adjReasonId: Uint32Array
  readonly adjEdgeIdx: Uint32Array
  readonly edgeIds: readonly string[]
  readonly reasonPool: readonly string[]
}

function fastNormalizeEntityKey(raw: string): string | null {
  const len = raw.length
  if (len >= 2 && len <= 128) {
    let clean = true
    for (let i = 0; i < len; i += 1) {
      const c = raw.charCodeAt(i)
      const ok =
        (c >= 97 && c <= 122) || // a-z
        (c >= 48 && c <= 57) || // 0-9
        (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
        c === 95 || // _
        c === 46 || // .
        c === 45 || // -
        c === 58 || // :
        c === 47 // /
      if (!ok) {
        clean = false
        break
      }
    }
    if (clean) return raw
  }
  return normalizeEntityKey(raw)
}

function normalizeNodeEntityList(entities: readonly string[]): readonly string[] {
  const len = entities.length
  if (len === 0) return []
  if (len === 1) {
    const key = fastNormalizeEntityKey(entities[0]!)
    return key === null ? [] : [key]
  }
  const out: string[] = []
  if (len <= 6) {
    for (let i = 0; i < len; i += 1) {
      const key = fastNormalizeEntityKey(entities[i]!)
      if (key !== null && !out.includes(key)) {
        out.push(key)
      }
    }
    return out
  }
  const seen = new Set<string>()
  for (let i = 0; i < len; i += 1) {
    const key = fastNormalizeEntityKey(entities[i]!)
    if (key === null || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function buildCsrAdjacency(
  nodeCount: number,
  nodeIdToSlot: ReadonlyMap<string, number>,
  edges: readonly MemoryIndexEdgeInput[],
  maxFanoutPerNode?: number,
): CsrAdjacencyResult {
  const reasonToId = new Map<string, number>()
  const reasonPool: string[] = []
  // eslint-disable-next-line unicorn/no-new-array
  const edgeIds: string[] = new Array<string>(edges.length)
  let validEdgeCount = 0
  const eagerHash = edges.length <= EAGER_EDGE_ID_HASH_LIMIT
  const adjBuckets: HalfEdgeRecord[][] = Array.from(
    { length: nodeCount },
    (): HalfEdgeRecord[] => [],
  )

  for (const edge of edges) {
    const aSlot = nodeIdToSlot.get(edge.aId)
    const bSlot = nodeIdToSlot.get(edge.bId)
    if (aSlot === undefined || bSlot === undefined || aSlot === bSlot) continue
    let reasonId = reasonToId.get(edge.reason)
    if (reasonId === undefined) {
      reasonId = reasonPool.length
      reasonToId.set(edge.reason, reasonId)
      reasonPool.push(edge.reason)
    }
    const edgeIdx = validEdgeCount
    validEdgeCount += 1
    if (edge.edgeId !== undefined) {
      edgeIds[edgeIdx] = edge.edgeId
    } else if (eagerHash) {
      edgeIds[edgeIdx] = computeDeterministicEdgeId(edge.aId, edge.bId, edge.edgeType)
    }
    const edgeTypeCode = EDGE_TYPE_TO_CODE[edge.edgeType] ?? 0
    const trustCode = edge.trust === 'trusted' ? 1 : 0
    const flags = (edgeTypeCode << 1) | trustCode
    adjBuckets[aSlot]!.push({
      target: bSlot,
      weight: edge.weight,
      flags,
      reasonId,
      edgeIdx,
    })
    adjBuckets[bSlot]!.push({
      target: aSlot,
      weight: edge.weight,
      flags,
      reasonId,
      edgeIdx,
    })
  }
  edgeIds.length = validEdgeCount

  const fanoutCap =
    maxFanoutPerNode !== undefined && maxFanoutPerNode >= 0
      ? Math.floor(maxFanoutPerNode)
      : Number.POSITIVE_INFINITY

  let edgeHalfCount = 0
  for (let u = 0; u < nodeCount; u += 1) {
    const bucket = adjBuckets[u]!
    if (bucket.length > 1) {
      bucket.sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight
        return a.target - b.target
      })
    }
    if (bucket.length > fanoutCap) {
      bucket.length = fanoutCap
    }
    edgeHalfCount += bucket.length
  }

  const adjOffset = new Uint32Array(nodeCount + 1)
  const adjTarget = new Uint32Array(edgeHalfCount)
  const adjWeight = new Float32Array(edgeHalfCount)
  const adjEdgeType = new Uint8Array(edgeHalfCount)
  const adjTrust = new Uint8Array(edgeHalfCount)
  const adjReasonId = new Uint32Array(edgeHalfCount)
  const adjEdgeIdx = new Uint32Array(edgeHalfCount)

  let cursor = 0
  for (let u = 0; u < nodeCount; u += 1) {
    adjOffset[u] = cursor
    const bucket = adjBuckets[u]!
    for (let i = 0; i < bucket.length; i += 1) {
      const rec = bucket[i]!
      adjTarget[cursor] = rec.target
      adjWeight[cursor] = rec.weight
      adjEdgeType[cursor] = rec.flags >>> 1
      adjTrust[cursor] = rec.flags & 1
      adjReasonId[cursor] = rec.reasonId
      adjEdgeIdx[cursor] = rec.edgeIdx
      cursor += 1
    }
  }
  adjOffset[nodeCount] = cursor

  return {
    edgeHalfCount,
    adjOffset,
    adjTarget,
    adjWeight,
    adjEdgeType,
    adjTrust,
    adjReasonId,
    adjEdgeIdx,
    edgeIds,
    reasonPool,
  }
}

function createIndexObject(fields: {
  readonly buildEpoch: number
  readonly builtAt: number
  readonly nodeCount: number
  readonly nodeIds: readonly string[]
  readonly nodeIdToSlot: ReadonlyMap<string, number>
  readonly sourceRefToSlots: ReadonlyMap<string, readonly number[]>
  readonly nodeKind: Uint8Array
  readonly nodeOwnerIdx: Uint32Array
  readonly nodeScopeMode: Uint8Array
  readonly nodeWorkspaceIdx: Uint32Array
  readonly nodePresetIdx: Uint32Array
  readonly nodeTrust: Uint8Array
  readonly nodeSensitivity: Uint8Array
  readonly nodeUpdatedAt: Float64Array
  readonly nodeExpiresAt: Float64Array
  readonly nodeTombstoned: Uint8Array
  readonly nodeTitles: readonly string[]
  readonly nodeSourcePlugins: readonly string[]
  readonly nodeEntities: readonly (readonly string[])[]
  readonly ownerKeys: ReadonlyMap<string, number>
  readonly workspaces: ReadonlyMap<string, number>
  readonly presets: ReadonlyMap<string, number>
  readonly csr: CsrAdjacencyResult
  readonly ac: EntityAutomaton
  readonly bm25: Bm25InvertedIndex
}): AssociationMemoryIndex {
  const primaryScratchpad = createHotPathScratchpad(fields.nodeCount, fields.ac.entityCount)
  return {
    buildEpoch: fields.buildEpoch,
    builtAt: fields.builtAt,
    nodeCount: fields.nodeCount,
    edgeHalfCount: fields.csr.edgeHalfCount,
    nodeIds: fields.nodeIds,
    nodeIdToSlot: fields.nodeIdToSlot,
    sourceRefToSlots: fields.sourceRefToSlots,
    nodeKind: fields.nodeKind,
    nodeOwnerIdx: fields.nodeOwnerIdx,
    nodeScopeMode: fields.nodeScopeMode,
    nodeWorkspaceIdx: fields.nodeWorkspaceIdx,
    nodePresetIdx: fields.nodePresetIdx,
    nodeTrust: fields.nodeTrust,
    nodeSensitivity: fields.nodeSensitivity,
    nodeUpdatedAt: fields.nodeUpdatedAt,
    nodeExpiresAt: fields.nodeExpiresAt,
    nodeTombstoned: fields.nodeTombstoned,
    nodeTitles: fields.nodeTitles,
    nodeSourcePlugins: fields.nodeSourcePlugins,
    nodeEntities: fields.nodeEntities,
    ownerKeys: fields.ownerKeys,
    workspaces: fields.workspaces,
    presets: fields.presets,
    adjOffset: fields.csr.adjOffset,
    adjTarget: fields.csr.adjTarget,
    adjWeight: fields.csr.adjWeight,
    adjEdgeType: fields.csr.adjEdgeType,
    adjTrust: fields.csr.adjTrust,
    adjReasonId: fields.csr.adjReasonId,
    adjEdgeIdx: fields.csr.adjEdgeIdx,
    edgeIds: fields.csr.edgeIds,
    reasonPool: fields.csr.reasonPool,
    ac: fields.ac,
    bm25: fields.bm25,
    acquireScratchpad(): HotPathScratchpad {
      if (!primaryScratchpad.inUse) {
        primaryScratchpad.inUse = true
        return primaryScratchpad
      }
      const pad = createHotPathScratchpad(fields.nodeCount, fields.ac.entityCount)
      pad.inUse = true
      return pad
    },
    releaseScratchpad(pad: HotPathScratchpad): void {
      pad.inUse = false
    },
    tombstoneNodeId(nodeId: string): boolean {
      const slot = fields.nodeIdToSlot.get(nodeId)
      if (slot === undefined) return false
      fields.nodeTombstoned[slot] = 1
      return true
    },
    tombstoneSourceRef(ownerScopeKey: string, sourcePlugin: string, sourceRef: string): number {
      const slots = fields.sourceRefToSlots.get(`${ownerScopeKey}\0${sourcePlugin}\0${sourceRef}`)
      if (slots === undefined) return 0
      for (const slot of slots) {
        fields.nodeTombstoned[slot] = 1
      }
      return slots.length
    },
  }
}

export function buildMemoryIndex(
  snapshot: {
    readonly nodes: readonly MemoryIndexNodeInput[]
    readonly edges: readonly MemoryIndexEdgeInput[]
    readonly synonyms?: readonly AcSynonymEntry[]
  },
  options?: {
    readonly buildEpoch?: number
    readonly builtAt?: number
    readonly maxEntityPostings?: number
    readonly maxFanoutPerNode?: number
  },
): AssociationMemoryIndex {
  const nodes = snapshot.nodes
  const nodeCount = nodes.length

  const nodeIds: string[] = Array.from({ length: nodeCount })
  const nodeIdToSlot = new Map<string, number>()
  const sourceRefMap = new Map<string, number[]>()

  const nodeKind = new Uint8Array(nodeCount)
  const nodeOwnerIdx = new Uint32Array(nodeCount)
  const nodeScopeMode = new Uint8Array(nodeCount)
  const nodeWorkspaceIdx = new Uint32Array(nodeCount)
  const nodePresetIdx = new Uint32Array(nodeCount)
  const nodeTrust = new Uint8Array(nodeCount)
  const nodeSensitivity = new Uint8Array(nodeCount)
  const nodeUpdatedAt = new Float64Array(nodeCount)
  const nodeExpiresAt = new Float64Array(nodeCount)
  const nodeTombstoned = new Uint8Array(nodeCount)
  const nodeTitles: string[] = Array.from({ length: nodeCount })
  const nodeSourcePlugins: string[] = Array.from({ length: nodeCount })
  const nodeEntities: Array<readonly string[]> = Array.from({ length: nodeCount })
  const nodeTokens: Array<readonly string[]> = Array.from({ length: nodeCount })

  const ownerKeys = new Map<string, number>()
  const workspaces = new Map<string, number>()
  const presets = new Map<string, number>()

  for (let slot = 0; slot < nodeCount; slot += 1) {
    const node = nodes[slot]!
    nodeIds[slot] = node.id
    nodeIdToSlot.set(node.id, slot)

    const srcKey = `${node.ownerScopeKey}\0${node.sourcePlugin}\0${node.sourceRef}`
    let refSlots = sourceRefMap.get(srcKey)
    if (refSlots === undefined) {
      refSlots = []
      sourceRefMap.set(srcKey, refSlots)
    }
    refSlots.push(slot)

    nodeKind[slot] = NODE_KIND_TO_CODE[node.kind] ?? 0
    nodeOwnerIdx[slot] = internString(ownerKeys, node.ownerScopeKey)
    nodeScopeMode[slot] = node.scopeMode === 'workspace' ? 1 : 0
    nodeWorkspaceIdx[slot] = internString(workspaces, node.workspace)
    nodePresetIdx[slot] = internString(presets, node.agentPreset)
    nodeTrust[slot] = node.trust === 'trusted' ? 1 : 0
    nodeSensitivity[slot] = node.sensitivity === 'sensitive' ? 1 : 0
    nodeUpdatedAt[slot] = node.updatedAt
    nodeExpiresAt[slot] = node.expiresAt ?? 0
    nodeTombstoned[slot] = 0
    nodeTitles[slot] = node.title
    nodeSourcePlugins[slot] = node.sourcePlugin
    nodeEntities[slot] = normalizeNodeEntityList(node.entities)
    nodeTokens[slot] = node.tokens
  }

  const csr = buildCsrAdjacency(
    nodeCount,
    nodeIdToSlot,
    snapshot.edges,
    options?.maxFanoutPerNode,
  )

  const ac = buildEntityAutomaton({
    nodeCount,
    nodeUpdatedAt,
    nodeEntities,
    ownerKeys,
    ...(snapshot.synonyms !== undefined ? { synonyms: snapshot.synonyms } : {}),
    ...(options?.maxEntityPostings !== undefined
      ? { maxEntityPostings: options.maxEntityPostings }
      : {}),
  })

  const bm25 = buildBm25Index({
    nodeCount,
    nodeUpdatedAt,
    nodeTokens,
  })

  return createIndexObject({
    buildEpoch: options?.buildEpoch ?? 1,
    builtAt: options?.builtAt ?? Date.now(),
    nodeCount,
    nodeIds,
    nodeIdToSlot,
    sourceRefToSlots: sourceRefMap,
    nodeKind,
    nodeOwnerIdx,
    nodeScopeMode,
    nodeWorkspaceIdx,
    nodePresetIdx,
    nodeTrust,
    nodeSensitivity,
    nodeUpdatedAt,
    nodeExpiresAt,
    nodeTombstoned,
    nodeTitles,
    nodeSourcePlugins,
    nodeEntities,
    ownerKeys,
    workspaces,
    presets,
    csr,
    ac,
    bm25,
  })
}

export function rebuildMemoryIndexEdges(
  baseIndex: AssociationMemoryIndex,
  edges: readonly MemoryIndexEdgeInput[],
  options?: {
    readonly buildEpoch?: number
    readonly builtAt?: number
    readonly maxFanoutPerNode?: number
  },
): AssociationMemoryIndex {
  const csr = buildCsrAdjacency(
    baseIndex.nodeCount,
    baseIndex.nodeIdToSlot,
    edges,
    options?.maxFanoutPerNode,
  )
  const nodeTombstoned = new Uint8Array(baseIndex.nodeTombstoned)

  return createIndexObject({
    buildEpoch: options?.buildEpoch ?? baseIndex.buildEpoch + 1,
    builtAt: options?.builtAt ?? Date.now(),
    nodeCount: baseIndex.nodeCount,
    nodeIds: baseIndex.nodeIds,
    nodeIdToSlot: baseIndex.nodeIdToSlot,
    sourceRefToSlots: baseIndex.sourceRefToSlots,
    nodeKind: baseIndex.nodeKind,
    nodeOwnerIdx: baseIndex.nodeOwnerIdx,
    nodeScopeMode: baseIndex.nodeScopeMode,
    nodeWorkspaceIdx: baseIndex.nodeWorkspaceIdx,
    nodePresetIdx: baseIndex.nodePresetIdx,
    nodeTrust: baseIndex.nodeTrust,
    nodeSensitivity: baseIndex.nodeSensitivity,
    nodeUpdatedAt: baseIndex.nodeUpdatedAt,
    nodeExpiresAt: baseIndex.nodeExpiresAt,
    nodeTombstoned,
    nodeTitles: baseIndex.nodeTitles,
    nodeSourcePlugins: baseIndex.nodeSourcePlugins,
    nodeEntities: baseIndex.nodeEntities,
    ownerKeys: baseIndex.ownerKeys,
    workspaces: baseIndex.workspaces,
    presets: baseIndex.presets,
    csr,
    ac: baseIndex.ac,
    bm25: baseIndex.bm25,
  })
}
