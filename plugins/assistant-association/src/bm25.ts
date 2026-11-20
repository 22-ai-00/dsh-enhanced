export interface Bm25InvertedIndex {
  readonly tokenCount: number
  readonly tokenToId: ReadonlyMap<string, number>
  readonly tokenNames: readonly string[]
  readonly tokenPostingsOffset: Uint32Array
  readonly tokenPostingsSlot: Uint32Array
  readonly tokenIdf: Float32Array
  readonly docLen: Uint16Array
  readonly docNorm: Float32Array
  readonly avgDocLen: number
}

const BM25_K1 = 1.2
const BM25_B = 0.75

export function buildBm25Index(input: {
  readonly nodeCount: number
  readonly nodeUpdatedAt: Float64Array
  readonly nodeTokens: readonly (readonly string[])[]
}): Bm25InvertedIndex {
  const nodeCount = input.nodeCount
  const docLen = new Uint16Array(nodeCount)
  const docNorm = new Float32Array(nodeCount)
  const tokenToId = new Map<string, number>()
  const tokenNames: string[] = []
  const postingsLists: number[][] = []

  let totalTokens = 0
  for (let slot = 0; slot < nodeCount; slot += 1) {
    const tokens = input.nodeTokens[slot]
    const len = tokens ? Math.min(65_535, tokens.length) : 0
    docLen[slot] = len
    totalTokens += len
    if (!tokens || tokens.length === 0) continue
    for (const token of tokens) {
      let tid = tokenToId.get(token)
      if (tid === undefined) {
        tid = tokenNames.length
        tokenToId.set(token, tid)
        tokenNames.push(token)
        postingsLists.push([])
      }
      postingsLists[tid]!.push(slot)
    }
  }

  const avgDocLen = nodeCount > 0 ? Math.max(1, totalTokens / nodeCount) : 1
  for (let slot = 0; slot < nodeCount; slot += 1) {
    const dl = docLen[slot]!
    docNorm[slot] = (1 + BM25_K1) / (1 + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDocLen)))
  }

  const tokenCount = tokenNames.length
  const tokenIdf = new Float32Array(tokenCount)
  const tokenPostingsOffset = new Uint32Array(tokenCount + 1)
  let totalPostings = 0

  const updatedAt = input.nodeUpdatedAt
  for (let tid = 0; tid < tokenCount; tid += 1) {
    const slots = postingsLists[tid]!
    const df = slots.length
    tokenIdf[tid] = Math.log(1 + (nodeCount - df + 0.5) / (df + 0.5))
    if (slots.length > 1) {
      slots.sort((a, b) => {
        const diff = updatedAt[b]! - updatedAt[a]!
        return diff !== 0 ? diff : a - b
      })
    }
    tokenPostingsOffset[tid] = totalPostings
    totalPostings += slots.length
  }
  tokenPostingsOffset[tokenCount] = totalPostings

  const tokenPostingsSlot = new Uint32Array(totalPostings)
  for (let tid = 0; tid < tokenCount; tid += 1) {
    const slots = postingsLists[tid]!
    const base = tokenPostingsOffset[tid]!
    for (let i = 0; i < slots.length; i += 1) {
      tokenPostingsSlot[base + i] = slots[i]!
    }
  }

  return {
    tokenCount,
    tokenToId,
    tokenNames,
    tokenPostingsOffset,
    tokenPostingsSlot,
    tokenIdf,
    docLen,
    docNorm,
    avgDocLen,
  }
}
