import { normalizeEntityKey } from './tokenize.js'
import type { AssociationTrust } from './types.js'

export interface EntityAutomaton {
  readonly entityCount: number
  readonly entityNames: readonly string[]
  readonly entityIdf: Float32Array
  readonly entityNodeOffset: Uint32Array
  readonly entityNodeSlot: Uint32Array
  readonly stateCount: number
  readonly rootAsciiAndBmp: Int32Array
  readonly fail: Int32Array
  readonly transOffset: Uint32Array
  readonly transChar: Uint16Array
  readonly transNext: Int32Array
  readonly outOffset: Uint32Array
  readonly outEntityId: Uint32Array
  readonly outPatternLen: Uint16Array
  readonly outWordStart: Uint8Array
  readonly outWordEnd: Uint8Array
  readonly outSynonymOwnerIdx: Int32Array
  readonly outSynonymTrust: Uint8Array
  readonly ownerKeys: readonly string[]
  readonly ownerKeyToIdx: ReadonlyMap<string, number>
  readonly entityToId: ReadonlyMap<string, number>
}

export interface AcSynonymEntry {
  readonly surface: string
  readonly canonicalEntity: string
  readonly ownerScopeKey?: string
  readonly trust?: AssociationTrust
}

interface PatternBinding {
  readonly pattern: string
  readonly entityId: number
  readonly isWordStart: number
  readonly isWordEnd: number
  readonly ownerIdx: number
  readonly trust: number
}

function isAsciiAlnumCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122)
}

function findChildInFlatPairs(pairs: readonly number[], ch: number): number {
  for (let i = 0; i < pairs.length; i += 2) {
    if (pairs[i] === ch) return pairs[i + 1]!
  }
  return -1
}

function findTrans(
  transOffset: Uint32Array,
  transChar: Uint16Array,
  transNext: Int32Array,
  state: number,
  ch: number,
): number {
  const start = transOffset[state]!
  const end = transOffset[state + 1]!
  const len = end - start
  if (len <= 8) {
    for (let i = start; i < end; i += 1) {
      const c = transChar[i]!
      if (c === ch) return transNext[i]!
      if (c > ch) return -1
    }
    return -1
  }
  let lo = start
  let hi = end - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const c = transChar[mid]!
    if (c === ch) return transNext[mid]!
    if (c < ch) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

export function buildEntityAutomaton(input: {
  readonly nodeCount: number
  readonly nodeUpdatedAt: Float64Array
  readonly nodeEntities: readonly (readonly string[])[]
  readonly synonyms?: readonly AcSynonymEntry[]
  readonly ownerKeys?: ReadonlyMap<string, number> | readonly string[]
  readonly maxEntityPostings?: number
}): EntityAutomaton {
  const maxEntityPostings = input.maxEntityPostings ?? 1_000
  const entityToId = new Map<string, number>()
  const entityNames: string[] = []
  const entityPostings: number[][] = []
  const ownerKeyToIdx = new Map<string, number>()
  const ownerKeys: string[] = []
  if (input.ownerKeys !== undefined) {
    if (input.ownerKeys instanceof Map) {
      for (const [key, idx] of input.ownerKeys) {
        ownerKeyToIdx.set(key, idx)
        ownerKeys[idx] = key
      }
    } else {
      for (const key of input.ownerKeys as readonly string[]) {
        if (!ownerKeyToIdx.has(key)) {
          ownerKeyToIdx.set(key, ownerKeys.length)
          ownerKeys.push(key)
        }
      }
    }
  }
  const internOwner = (key: string): number => {
    const existing = ownerKeyToIdx.get(key)
    if (existing !== undefined) return existing
    const idx = ownerKeys.length
    ownerKeys.push(key)
    ownerKeyToIdx.set(key, idx)
    return idx
  }

  for (let slot = 0; slot < input.nodeCount; slot += 1) {
    const entities = input.nodeEntities[slot]
    if (!entities || entities.length === 0) continue
    const seenInNode = new Set<number>()
    for (const raw of entities) {
      const key = normalizeEntityKey(raw)
      if (key === null) continue
      let eid = entityToId.get(key)
      if (eid === undefined) {
        eid = entityNames.length
        entityToId.set(key, eid)
        entityNames.push(key)
        entityPostings.push([])
      }
      if (!seenInNode.has(eid)) {
        seenInNode.add(eid)
        entityPostings[eid]!.push(slot)
      }
    }
  }

  const entityCount = entityNames.length
  const entityIdf = new Float32Array(entityCount)
  const entityNodeOffset = new Uint32Array(entityCount + 1)
  let totalEntityPostings = 0

  const updatedAt = input.nodeUpdatedAt
  for (let eid = 0; eid < entityCount; eid += 1) {
    const slots = entityPostings[eid]!
    const df = slots.length
    entityIdf[eid] = Math.log(1 + input.nodeCount / (1 + df))
    if (slots.length > 1) {
      slots.sort((a, b) => {
        const diff = updatedAt[b]! - updatedAt[a]!
        return diff !== 0 ? diff : a - b
      })
    }
    const kept = Math.min(slots.length, maxEntityPostings)
    entityNodeOffset[eid] = totalEntityPostings
    totalEntityPostings += kept
  }
  entityNodeOffset[entityCount] = totalEntityPostings

  const entityNodeSlot = new Uint32Array(totalEntityPostings)
  for (let eid = 0; eid < entityCount; eid += 1) {
    const slots = entityPostings[eid]!
    const start = entityNodeOffset[eid]!
    const end = entityNodeOffset[eid + 1]!
    const kept = end - start
    for (let i = 0; i < kept; i += 1) {
      entityNodeSlot[start + i] = slots[i]!
    }
  }

  // Collect patterns (canonical entity names + optional synonym surfaces)
  const patternBindings: PatternBinding[] = []
  const seenPatternPair = new Set<string>()

  const addPattern = (
    pattern: string,
    eid: number,
    ownerIdx: number,
    trust: number,
  ): void => {
    const key = `${pattern}\0${eid}\0${ownerIdx}\0${trust}`
    if (seenPatternPair.has(key)) return
    seenPatternPair.add(key)
    const firstCode = pattern.charCodeAt(0)
    const lastCode = pattern.charCodeAt(pattern.length - 1)
    patternBindings.push({
      pattern,
      entityId: eid,
      isWordStart: isAsciiAlnumCode(firstCode) ? 1 : 0,
      isWordEnd: isAsciiAlnumCode(lastCode) ? 1 : 0,
      ownerIdx,
      trust,
    })
  }

  for (let eid = 0; eid < entityCount; eid += 1) {
    addPattern(entityNames[eid]!, eid, -1, 1)
  }

  if (input.synonyms) {
    for (const syn of input.synonyms) {
      const surface = normalizeEntityKey(syn.surface)
      const canonical = normalizeEntityKey(syn.canonicalEntity)
      if (surface === null || canonical === null) continue
      const eid = entityToId.get(canonical)
      if (eid !== undefined) {
        const ownerIdx =
          syn.ownerScopeKey !== undefined ? internOwner(syn.ownerScopeKey) : -1
        const trust = syn.trust === 'low' ? 0 : 1
        addPattern(surface, eid, ownerIdx, trust)
      }
    }
  }

  // Build Trie: state 0 uses rootAsciiAndBmp[0..65535]; states >= 1 use flat [ch, child] pairs
  const rootAsciiAndBmp = new Int32Array(65_536)
  const stateChildren: number[][] = [[]]
  const directOutIndices: number[][] = [[]]

  for (let pIdx = 0; pIdx < patternBindings.length; pIdx += 1) {
    const { pattern } = patternBindings[pIdx]!
    const firstCh = pattern.charCodeAt(0)
    let state = rootAsciiAndBmp[firstCh]!
    if (state === 0) {
      state = stateChildren.length
      stateChildren.push([])
      directOutIndices.push([])
      rootAsciiAndBmp[firstCh] = state
    }

    for (let i = 1; i < pattern.length; i += 1) {
      const ch = pattern.charCodeAt(i)
      const pairs = stateChildren[state]!
      let next = findChildInFlatPairs(pairs, ch)
      if (next === -1) {
        next = stateChildren.length
        stateChildren.push([])
        directOutIndices.push([])
        pairs.push(ch, next)
      }
      state = next
    }
    directOutIndices[state]!.push(pIdx)
  }

  const stateCount = stateChildren.length
  const transOffset = new Uint32Array(stateCount + 1)
  let totalTrans = 0
  for (let s = 1; s < stateCount; s += 1) {
    transOffset[s] = totalTrans
    totalTrans += stateChildren[s]!.length >>> 1
  }
  transOffset[stateCount] = totalTrans

  const transChar = new Uint16Array(totalTrans)
  const transNext = new Int32Array(totalTrans)
  const tempPairs: Array<{ readonly ch: number; readonly next: number }> = []

  for (let s = 1; s < stateCount; s += 1) {
    const pairs = stateChildren[s]!
    const count = pairs.length >>> 1
    if (count === 0) continue
    tempPairs.length = 0
    for (let i = 0; i < pairs.length; i += 2) {
      tempPairs.push({ ch: pairs[i]!, next: pairs[i + 1]! })
    }
    if (count > 1) {
      tempPairs.sort((a, b) => a.ch - b.ch)
    }
    const base = transOffset[s]!
    for (let i = 0; i < count; i += 1) {
      const item = tempPairs[i]!
      transChar[base + i] = item.ch
      transNext[base + i] = item.next
    }
  }

  // BFS failure links & flattened output propagation
  const fail = new Int32Array(stateCount)
  const bfsQueue: number[] = []
  const allOutputs: number[][] = Array.from({ length: stateCount }, () => [])

  // Collect all depth-1 states from root transitions
  for (let ch = 0; ch < 65_536; ch += 1) {
    const child = rootAsciiAndBmp[ch]!
    if (child !== 0) {
      fail[child] = 0
      allOutputs[child] = directOutIndices[child]!.slice()
      bfsQueue.push(child)
    }
  }

  let qHead = 0
  while (qHead < bfsQueue.length) {
    const u = bfsQueue[qHead]!
    qHead += 1
    const start = transOffset[u]!
    const end = transOffset[u + 1]!
    for (let idx = start; idx < end; idx += 1) {
      const ch = transChar[idx]!
      const v = transNext[idx]!
      let f = fail[u]!
      while (f > 0) {
        const candidate = findTrans(transOffset, transChar, transNext, f, ch)
        if (candidate !== -1) {
          f = candidate
          break
        }
        f = fail[f]!
      }
      if (f === 0) {
        const rootCandidate = rootAsciiAndBmp[ch]!
        // Only jump to rootCandidate if fail[u] actually reached 0 and didn't already match via trans
        const directFromZero = findTrans(transOffset, transChar, transNext, 0, ch)
        fail[v] = directFromZero !== -1 ? directFromZero : rootCandidate
      } else {
        fail[v] = f
      }

      const failState = fail[v]!
      const direct = directOutIndices[v]!
      const inherited = allOutputs[failState]!
      if (direct.length === 0) {
        allOutputs[v] = inherited
      } else if (inherited.length === 0) {
        allOutputs[v] = direct.slice()
      } else {
        allOutputs[v] = [...direct, ...inherited]
      }
      bfsQueue.push(v)
    }
  }

  // Flatten outputs into CSR
  const outOffset = new Uint32Array(stateCount + 1)
  let totalOutputs = 0
  for (let s = 0; s < stateCount; s += 1) {
    outOffset[s] = totalOutputs
    totalOutputs += allOutputs[s]!.length
  }
  outOffset[stateCount] = totalOutputs

  const outEntityId = new Uint32Array(totalOutputs)
  const outPatternLen = new Uint16Array(totalOutputs)
  const outWordStart = new Uint8Array(totalOutputs)
  const outWordEnd = new Uint8Array(totalOutputs)
  const outSynonymOwnerIdx = new Int32Array(totalOutputs)
  const outSynonymTrust = new Uint8Array(totalOutputs)

  for (let s = 0; s < stateCount; s += 1) {
    const list = allOutputs[s]!
    const base = outOffset[s]!
    for (let i = 0; i < list.length; i += 1) {
      const binding = patternBindings[list[i]!]!
      outEntityId[base + i] = binding.entityId
      outPatternLen[base + i] = binding.pattern.length
      outWordStart[base + i] = binding.isWordStart
      outWordEnd[base + i] = binding.isWordEnd
      outSynonymOwnerIdx[base + i] = binding.ownerIdx
      outSynonymTrust[base + i] = binding.trust
    }
  }

  return {
    entityCount,
    entityNames,
    entityIdf,
    entityNodeOffset,
    entityNodeSlot,
    stateCount,
    rootAsciiAndBmp,
    fail,
    transOffset,
    transChar,
    transNext,
    outOffset,
    outEntityId,
    outPatternLen,
    outWordStart,
    outWordEnd,
    outSynonymOwnerIdx,
    outSynonymTrust,
    ownerKeys,
    ownerKeyToIdx,
    entityToId,
  }
}

export function stepAcState(ac: EntityAutomaton, state: number, ch: number): number {
  if (state === 0) {
    return ac.rootAsciiAndBmp[ch] ?? 0
  }
  let cur = state
  while (cur > 0) {
    const next = findTrans(ac.transOffset, ac.transChar, ac.transNext, cur, ch)
    if (next !== -1) return next
    cur = ac.fail[cur]!
  }
  return ac.rootAsciiAndBmp[ch] ?? 0
}

export function isBoundaryMatch(
  ac: EntityAutomaton,
  outIdx: number,
  normText: string,
  endPos: number,
): number {
  const len = ac.outPatternLen[outIdx]!
  const startPos = endPos - len + 1
  if (startPos < 0) return -1
  if (ac.outWordStart[outIdx] === 1 && startPos > 0) {
    if (isAsciiAlnumCode(normText.charCodeAt(startPos - 1))) return -1
  }
  if (ac.outWordEnd[outIdx] === 1 && endPos + 1 < normText.length) {
    if (isAsciiAlnumCode(normText.charCodeAt(endPos + 1))) return -1
  }
  return startPos
}
