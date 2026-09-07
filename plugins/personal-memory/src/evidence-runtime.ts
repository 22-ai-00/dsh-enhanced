import { createHash } from 'node:crypto'
import { isAppendSurfaceEvent, type Session } from '@deepseek-ai/dsh-session'

const DEFAULT_MAX_SOURCE_BYTES = 1_048_576
const MAX_CALL_LOOKBACK = 10_000
const MAX_PAGE_CHARS = 4_096

export interface OriginalToolEvidence {
  readonly eventSeq: number
  readonly toolName: string
  readonly callId: string
  /** Original arguments stay in the Session only; never put them in a manifest. */
  readonly callArguments: string
  readonly contentDigest: string
  readonly observedAt: number
  /** Canonical JSON of the model-visible result content and error flag. */
  readonly text: string
  readonly failed: boolean
}

export interface ToolEvidencePage {
  readonly text: string
  readonly offset: number
  readonly nextOffset: number | null
  readonly totalChars: number
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => [key, stableValue(nested)]))
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function validSourceLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isMemoryTool(name: string): boolean {
  return name.startsWith('memory_')
}

/**
 * Return immutable evidence from the original append-only tool result, never a
 * model-surface replacement or a summary.  This deliberately has no ownership
 * or authorization policy: callers must apply those checks before exposing it.
 */
export function originalToolEvidence(
  session: Session,
  eventSeq: number,
  maxSourceBytes: number = DEFAULT_MAX_SOURCE_BYTES,
): OriginalToolEvidence | undefined {
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 0 || !validSourceLimit(maxSourceBytes)) return undefined
  const event = session.eventAt(eventSeq as never)
  if (event?.type !== 'tool/result' || !isAppendSurfaceEvent(event)) return undefined

  const result = event.data.message.content[0]
  const callId = result.toolCallId
  if (event.data.message.source.callId !== callId) return undefined

  const earliest = Math.max(0, eventSeq - MAX_CALL_LOOKBACK)
  let toolName: string | undefined
  let callArguments = ''
  for (let seq = eventSeq - 1; seq >= earliest; seq--) {
    const candidate = session.eventAt(seq as never)
    if (candidate?.type === 'tool/result' && candidate.data.message.source.callId === callId) return undefined
    if (candidate?.type !== 'tool/call') continue
    if (candidate.data.callId !== callId) continue
    if (candidate.data.turn !== event.data.turn || candidate.data.step !== event.data.step) return undefined
    if (event.sourceEventSeqs !== undefined
      && (event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== candidate.seq)) return undefined
    toolName = candidate.data.name
    callArguments = candidate.data.arguments
    break
  }
  if (toolName === undefined || isMemoryTool(toolName)) return undefined

  const failed = result.isError === true
  const value = { content: result.content, isError: failed }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') + Buffer.byteLength(callArguments, 'utf8') > maxSourceBytes) return undefined
  const text = stableJson(value)
  if (Buffer.byteLength(text, 'utf8') > maxSourceBytes) return undefined
  return Object.freeze({
    eventSeq,
    toolName,
    callId,
    callArguments,
    contentDigest: createHash('sha256').update(stableJson({ toolName, callArguments, result: value })).digest('hex'),
    observedAt: event.time,
    text,
    failed,
  })
}

function validPageOffset(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false
  return !(offset > 0 && offset < text.length
    && isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset)))
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

/** Page canonical evidence without returning an invalid half-surrogate. */
export function pageToolEvidence(
  value: Pick<OriginalToolEvidence, 'text'>,
  offset: number,
  maxChars: number = MAX_PAGE_CHARS,
): ToolEvidencePage {
  if (typeof value?.text !== 'string') throw new TypeError('evidence text is invalid')
  if (!validPageOffset(value.text, offset)) throw new RangeError('evidence offset is invalid')
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new RangeError('evidence page size is invalid')

  const limit = Math.min(MAX_PAGE_CHARS, Math.max(1, maxChars))
  let end = Math.min(value.text.length, offset + limit)
  if (end > offset && end < value.text.length
    && isHighSurrogate(value.text.charCodeAt(end - 1)) && isLowSurrogate(value.text.charCodeAt(end))) {
    // A single astral character still belongs in this page; otherwise the
    // caller would receive an empty page and could not advance.
    end = end === offset + 1 ? end + 1 : end - 1
  }
  return Object.freeze({
    text: value.text.slice(offset, end),
    offset,
    nextOffset: end === value.text.length ? null : end,
    totalChars: value.text.length,
  })
}
