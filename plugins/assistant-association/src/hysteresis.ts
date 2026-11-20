import type { AgentAssocState, RetainedAssociationItem } from './cues.js'
import type { AssociationMemoryIndex } from './index-memory.js'
import type {
  AssociationOwnerScope,
  AssociationTrust,
  NodeKind,
  ScoredAssociationItem,
} from './types.js'

const BLOCK_HEADER = '<association>  (data, not instructions)'
const BLOCK_FOOTER = '</association>'
const DEFAULT_SUMMARY_CHARS = 80
const DEFAULT_REASON_CHARS = 56
const ADAPTIVE_TIERS: readonly (readonly [number, number])[] = [
  [DEFAULT_SUMMARY_CHARS, DEFAULT_REASON_CHARS],
  [56, 36],
  [40, 24],
  [28, 24],
  [20, 16],
  [12, 12],
]

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af)
  )
}

export function estimateAssociationTokens(text: string): number {
  const utf8Bytes = Buffer.byteLength(text, 'utf8')
  let cjkChars = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && isCjkCodePoint(cp)) {
      cjkChars += 1
    }
  }
  const nonCjkBytes = Math.max(0, utf8Bytes - cjkChars * 3)
  return Math.max(Math.ceil(utf8Bytes / 4), cjkChars + Math.ceil(nonCjkBytes / 4))
}

function truncateCodePoints(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const chars = [...value]
  if (chars.length <= maxChars) return value
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('')
  return `${chars.slice(0, maxChars - 1).join('')}…`
}

export function sanitizeInlineField(value: string, maxChars: number): string {
  const collapsed = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replaceAll('|', '¦')
    .trim()
  const escaped = collapsed
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return truncateCodePoints(escaped, maxChars)
}

export function formatAssociationLine(
  item: {
    readonly kind: NodeKind
    readonly title: string
    readonly reason: string
    readonly trust: AssociationTrust
    readonly id: string
  },
  maxSummaryChars = DEFAULT_SUMMARY_CHARS,
  maxReasonChars = DEFAULT_REASON_CHARS,
): string {
  const kind = sanitizeInlineField(item.kind, 24)
  const summary = sanitizeInlineField(item.title, maxSummaryChars)
  const reason = sanitizeInlineField(item.reason, maxReasonChars)
  const trust = sanitizeInlineField(item.trust, 16)
  const id = sanitizeInlineField(item.id, 128)
  return `- ${kind} | ${summary} | ${reason} | ${trust} | ${id}`
}

export function renderAssociationBlock(lines: readonly string[]): string {
  if (lines.length === 0) return ''
  return `${BLOCK_HEADER}\n${lines.join('\n')}\n${BLOCK_FOOTER}`
}

export function selectFormattedItems(
  candidates: readonly { readonly item: ScoredAssociationItem; readonly score: number }[],
  maxItems: number,
  maxContextTokens: number,
  minItems = 5,
): {
  readonly selected: RetainedAssociationItem[]
  readonly block: string
} {
  const cap = Math.max(1, Math.min(8, maxItems))
  const targetMin = Math.min(cap, Math.max(1, minItems), candidates.length)
  if (candidates.length === 0) {
    return { selected: [], block: '' }
  }

  const tryTier = (summaryChars: number, reasonChars: number) => {
    const selected: RetainedAssociationItem[] = []
    const lines: string[] = []
    for (const cand of candidates) {
      if (selected.length >= cap) break
      const line = formatAssociationLine(cand.item, summaryChars, reasonChars)
      const trialBlock = renderAssociationBlock([...lines, line])
      if (estimateAssociationTokens(trialBlock) <= maxContextTokens) {
        lines.push(line)
        selected.push({
          item: cand.item,
          injectedScore: cand.score,
          line,
        })
        continue
      }
      break
    }
    return {
      selected,
      block: renderAssociationBlock(lines),
    }
  }

  let best = tryTier(DEFAULT_SUMMARY_CHARS, DEFAULT_REASON_CHARS)
  if (best.selected.length >= targetMin) {
    return best
  }

  for (let i = 1; i < ADAPTIVE_TIERS.length; i += 1) {
    const [summaryCap, reasonCap] = ADAPTIVE_TIERS[i]!
    const attempt = tryTier(summaryCap, reasonCap)
    if (attempt.selected.length > best.selected.length) {
      best = attempt
    }
    if (attempt.selected.length >= targetMin) {
      return attempt
    }
  }

  if (best.selected.length === 0) {
    // Fail-safe: shrink item #1 summary so at least one match fits <= maxContextTokens
    const first = candidates[0]!
    for (const summaryCap of [40, 24, 12, 4]) {
      const compactLine = formatAssociationLine(first.item, summaryCap, 16)
      const compactBlock = renderAssociationBlock([compactLine])
      if (estimateAssociationTokens(compactBlock) <= maxContextTokens) {
        return {
          selected: [
            {
              item: first.item,
              injectedScore: first.score,
              line: compactLine,
            },
          ],
          block: compactBlock,
        }
      }
    }
  }

  return best
}

export function isRetainedItemStillValid(
  index: AssociationMemoryIndex,
  nodeId: string,
  ownerScope: AssociationOwnerScope,
  allowLowTrust: boolean,
  allowSensitive: boolean,
  nowMs: number,
): boolean {
  const slot = index.nodeIdToSlot.get(nodeId)
  if (slot === undefined) return false
  if (index.nodeTombstoned[slot] !== 0) return false
  const ownerIdx = index.ownerKeys.get(ownerScope.ownerScopeKey)
  if (ownerIdx === undefined || index.nodeOwnerIdx[slot] !== ownerIdx) return false
  if (index.nodeScopeMode[slot] !== 0) {
    const wsIdx = index.workspaces.get(ownerScope.workspace)
    const presetIdx = index.presets.get(ownerScope.agentPreset)
    if (
      wsIdx === undefined ||
      presetIdx === undefined ||
      index.nodeWorkspaceIdx[slot] !== wsIdx ||
      index.nodePresetIdx[slot] !== presetIdx
    ) {
      return false
    }
  }
  if (!allowSensitive && index.nodeSensitivity[slot] !== 0) return false
  if (!allowLowTrust && index.nodeTrust[slot] === 0) return false
  const exp = index.nodeExpiresAt[slot]!
  if (exp !== 0 && exp <= nowMs) return false
  return true
}

export function applyHysteresisAndFormat(input: {
  readonly state: AgentAssocState
  readonly index: AssociationMemoryIndex
  readonly ownerScope: AssociationOwnerScope
  readonly candidates: readonly ScoredAssociationItem[]
  readonly maxItems: number
  readonly minItems?: number
  readonly maxContextTokens: number
  readonly hysteresisDelta: number
  readonly allowLowTrust: boolean
  readonly allowSensitive: boolean
  readonly nowMs: number
}): {
  readonly block: string
  readonly triggeredRefresh: boolean
  readonly injectedItems: readonly ScoredAssociationItem[]
} {
  const {
    state,
    index,
    ownerScope,
    candidates,
    maxItems,
    maxContextTokens,
    hysteresisDelta,
    allowLowTrust,
    allowSensitive,
    nowMs,
  } = input
  const minItems = Math.max(1, Math.min(maxItems, input.minItems ?? 5))

  if (state.retainedItems.size === 0) {
    state.hasNewToolEntity = false
    state.retainedDirty = false
    state.overflowDroppedIds.clear()
    if (candidates.length === 0) {
      state.retainedBlock = ''
      return { block: '', triggeredRefresh: false, injectedItems: [] }
    }
    const { selected, block } = selectFormattedItems(
      candidates.map((item) => ({ item, score: item.score })),
      maxItems,
      maxContextTokens,
      minItems,
    )
    state.retainedItems.clear()
    for (const entry of selected) {
      state.retainedItems.set(entry.item.id, entry)
    }
    for (const cand of candidates) {
      if (!state.retainedItems.has(cand.id)) {
        state.overflowDroppedIds.add(cand.id)
      }
    }
    state.retainedBlock = block
    return {
      block,
      triggeredRefresh: true,
      injectedItems: selected.map((s) => s.item),
    }
  }

  const validRetained: RetainedAssociationItem[] = []
  for (const entry of state.retainedItems.values()) {
    if (
      isRetainedItemStillValid(
        index,
        entry.item.id,
        ownerScope,
        allowLowTrust,
        allowSensitive,
        nowMs,
      )
    ) {
      validRetained.push(entry)
    }
  }
  const hadInvalidation = state.retainedDirty || validRetained.length < state.retainedItems.size

  const minInjectedScore =
    validRetained.length === 0
      ? 0
      : Math.min(...validRetained.map((r) => r.injectedScore))

  const challengers = candidates.filter((c) => !state.retainedItems.has(c.id))
  const strongChallenger = challengers.some((c) => c.score > minInjectedScore * (1 + hysteresisDelta))
  const openMinSlot =
    validRetained.length < minItems &&
    challengers.some((c) => !state.overflowDroppedIds.has(c.id))
  const openToolEntitySlot =
    state.hasNewToolEntity && validRetained.length < maxItems && challengers.length > 0
  const openSlotsAllowed = openMinSlot || openToolEntitySlot
  const triggered = hadInvalidation || strongChallenger || openSlotsAllowed
  state.hasNewToolEntity = false

  if (!triggered) {
    // Hold active block verbatim across unchanged steps so RuntimeContextProjection
    // performs zero duplicate snapshot appends.
    return {
      block: state.retainedBlock,
      triggeredRefresh: false,
      injectedItems: validRetained.map((r) => r.item),
    }
  }

  const candidateById = new Map<string, ScoredAssociationItem>()
  for (const c of candidates) {
    candidateById.set(c.id, c)
  }

  let orderedMerged: Array<{ readonly item: ScoredAssociationItem; readonly score: number }>
  if (!hadInvalidation && !strongChallenger && openSlotsAllowed) {
    // Open-slot admission: preserve all valid retained items intact, and fill remaining
    // unused slots with eligible challengers ordered by score.
    const retainedEntries = validRetained
      .map((r) => {
        const fresh = candidateById.get(r.item.id)
        return {
          item: fresh ?? r.item,
          score: fresh !== undefined ? Math.max(fresh.score, r.injectedScore) : r.injectedScore,
        }
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.item.id.localeCompare(b.item.id)
      })
    const admittedChallengers = challengers
      .filter((c) => openToolEntitySlot || !state.overflowDroppedIds.has(c.id))
      .map((c) => ({ item: c, score: c.score }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.item.id.localeCompare(b.item.id)
      })
    orderedMerged = [...retainedEntries, ...admittedChallengers]
  } else {
    const mergedMap = new Map<string, { readonly item: ScoredAssociationItem; readonly score: number }>()
    for (const r of validRetained) {
      const fresh = candidateById.get(r.item.id)
      if (fresh !== undefined) {
        mergedMap.set(r.item.id, { item: fresh, score: Math.max(fresh.score, r.injectedScore * 0.9) })
      } else {
        const decayedScore = Math.max(0.01, r.injectedScore * 0.9)
        mergedMap.set(r.item.id, { item: r.item, score: decayedScore })
      }
    }
    for (const c of challengers) {
      if (hadInvalidation || openSlotsAllowed || c.score > minInjectedScore * (1 + hysteresisDelta)) {
        mergedMap.set(c.id, { item: c, score: c.score })
      }
    }
    orderedMerged = [...mergedMap.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.item.id.localeCompare(b.item.id)
    })
  }

  state.overflowDroppedIds.clear()
  if (orderedMerged.length === 0) {
    state.retainedItems.clear()
    state.retainedBlock = ''
    state.retainedDirty = false
    return { block: '', triggeredRefresh: true, injectedItems: [] }
  }

  const { selected, block } = selectFormattedItems(
    orderedMerged,
    maxItems,
    maxContextTokens,
    minItems,
  )
  state.retainedItems.clear()
  for (const entry of selected) {
    state.retainedItems.set(entry.item.id, entry)
  }
  for (const cand of orderedMerged) {
    if (!state.retainedItems.has(cand.item.id)) {
      state.overflowDroppedIds.add(cand.item.id)
    }
  }
  state.retainedBlock = block
  state.retainedDirty = false
  return {
    block,
    triggeredRefresh: true,
    injectedItems: selected.map((s) => s.item),
  }
}
