import { buildEntityAutomaton, type AcSynonymEntry, type EntityAutomaton } from './aho-corasick.js'
import { buildBm25Index, type Bm25InvertedIndex } from './bm25.js'
import {
  EDGE_TYPE_TO_CODE,
  NODE_KIND_TO_CODE,
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
  readonly ownerKeys: ReadonlyMap<string, number>
  readonly workspaces: ReadonlyMap<string, number>
  readonly presets: ReadonlyMap<string, number>
  readonly adjOffset: Uint32Array
  readonly adjTarget: Uint32Array
  readonly adjWeight: Float32Array
  readonly adjEdgeType: Uint8Array
  readonly adjTrust: Uint8Array
  readonly adjReasonId: Uint32Array
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
  readonly edgeType: number
  readonly trust: number
  readonly reasonId: number
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
    nodeEntities[slot] = node.entities
    nodeTokens[slot] = node.tokens
  }

  // Build CSR Adjacency (undirected edges stored as two weight-sorted half-edges)
  const reasonToId = new Map<string, number>()
  const reasonPool: string[] = []
  const adjBuckets: HalfEdgeRecord[][] = Array.from(
    { length: nodeCount },
    (): HalfEdgeRecord[] => [],
  )

  let edgeHalfCount = 0
  for (const edge of snapshot.edges) {
    const aSlot = nodeIdToSlot.get(edge.aId)
    const bSlot = nodeIdToSlot.get(edge.bId)
    if (aSlot === undefined || bSlot === undefined || aSlot === bSlot) continue
    let reasonId = reasonToId.get(edge.reason)
    if (reasonId === undefined) {
      reasonId = reasonPool.length
      reasonToId.set(edge.reason, reasonId)
      reasonPool.push(edge.reason)
    }
    const edgeTypeCode = EDGE_TYPE_TO_CODE[edge.edgeType] ?? 0
    const trustCode = edge.trust === 'trusted' ? 1 : 0
    adjBuckets[aSlot]!.push({
      target: bSlot,
      weight: edge.weight,
      edgeType: edgeTypeCode,
      trust: trustCode,
      reasonId,
    })
    adjBuckets[bSlot]!.push({
      target: aSlot,
      weight: edge.weight,
      edgeType: edgeTypeCode,
      trust: trustCode,
      reasonId,
    })
    edgeHalfCount += 2
  }

  const adjOffset = new Uint32Array(nodeCount + 1)
  const adjTarget = new Uint32Array(edgeHalfCount)
  const adjWeight = new Float32Array(edgeHalfCount)
  const adjEdgeType = new Uint8Array(edgeHalfCount)
  const adjTrust = new Uint8Array(edgeHalfCount)
  const adjReasonId = new Uint32Array(edgeHalfCount)

  let cursor = 0
  for (let u = 0; u < nodeCount; u += 1) {
    adjOffset[u] = cursor
    const bucket = adjBuckets[u]!
    if (bucket.length > 1) {
      bucket.sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight
        return a.target - b.target
      })
    }
    for (let i = 0; i < bucket.length; i += 1) {
      const rec = bucket[i]!
      adjTarget[cursor] = rec.target
      adjWeight[cursor] = rec.weight
      adjEdgeType[cursor] = rec.edgeType
      adjTrust[cursor] = rec.trust
      adjReasonId[cursor] = rec.reasonId
      cursor += 1
    }
  }
  adjOffset[nodeCount] = cursor

  const ac = buildEntityAutomaton({
    nodeCount,
    nodeUpdatedAt,
    nodeEntities,
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

  const primaryScratchpad = createHotPathScratchpad(nodeCount, ac.entityCount)

  return {
    buildEpoch: options?.buildEpoch ?? 1,
    builtAt: options?.builtAt ?? Date.now(),
    nodeCount,
    edgeHalfCount,
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
    ownerKeys,
    workspaces,
    presets,
    adjOffset,
    adjTarget,
    adjWeight,
    adjEdgeType,
    adjTrust,
    adjReasonId,
    reasonPool,
    ac,
    bm25,
    acquireScratchpad(): HotPathScratchpad {
      if (!primaryScratchpad.inUse) {
        primaryScratchpad.inUse = true
        return primaryScratchpad
      }
      const pad = createHotPathScratchpad(nodeCount, ac.entityCount)
      pad.inUse = true
      return pad
    },
    releaseScratchpad(pad: HotPathScratchpad): void {
      pad.inUse = false
    },
    tombstoneNodeId(nodeId: string): boolean {
      const slot = nodeIdToSlot.get(nodeId)
      if (slot === undefined) return false
      nodeTombstoned[slot] = 1
      return true
    },
    tombstoneSourceRef(ownerScopeKey: string, sourcePlugin: string, sourceRef: string): number {
      const slots = sourceRefMap.get(`${ownerScopeKey}\0${sourcePlugin}\0${sourceRef}`)
      if (slots === undefined) return 0
      for (const slot of slots) {
        nodeTombstoned[slot] = 1
      }
      return slots.length
    },
  }
}
