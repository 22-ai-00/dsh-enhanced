/**
 * WP19 attention contract. Stage 1 (always on, audit only): Delivery evaluates
 * every background/owner notification against a Host-side envelope and
 * records the verdict. Stage 2b (opt-in `attentionAttachOverCap`, default off):
 * over-cap notices become a short body plus a text attachment and split bursts
 * are rejected; see `convertOverCapAttention` and `assessAttentionSplit`.
 */
import type { OutboundTextAttachment } from './types.js'

export type AttentionPurpose = 'result' | 'attention' | 'answer'

/** Exactly one structured question per attention notice. */
export interface AttentionQuestion {
  id: string
  prompt: string
  choices?: readonly string[]
}

export type AttentionEnvelope =
  | Readonly<{ purpose: 'result'; workItemId?: string }>
  | Readonly<{ purpose: 'attention'; workItemId: string; question: Readonly<AttentionQuestion> }>
  | Readonly<{ purpose: 'answer'; questionId: string; workItemId?: string }>

export type AttentionLane =
  | 'background' | 'background-route' | 'owner-notification'
  | 'automation-result' | 'work-item-report' | 'scheduled-goal-result'

/** `declared` by the caller, derived from a typed Host `lane`, or the legacy `default`. */
export type AttentionPurposeSource = 'declared' | 'lane' | 'default'

export type AttentionVerdict = 'would-accept' | 'would-attach' | 'would-reject'

export const attentionAuditReasons = [
  'missing-purpose',
  'invalid-envelope',
  'attention-missing-work-item',
  'attention-question-invalid',
  'attention-question-not-current',
  'attention-question-already-answered',
  'answer-missing-question',
  'answer-unknown-question',
  'answer-already-used',
  'answer-work-item-mismatch',
  'attention-question-reused',
  'over-word-cap',
  'over-grapheme-cap',
  'text-exposes-estimate',
  'text-exposes-identifier',
] as const
export type AttentionAuditReason = typeof attentionAuditReasons[number]

const rejectReasons: ReadonlySet<AttentionAuditReason> = new Set([
  'invalid-envelope', 'attention-missing-work-item', 'attention-question-invalid', 'attention-question-not-current',
  'attention-question-already-answered', 'answer-missing-question', 'answer-unknown-question', 'answer-already-used',
  'answer-work-item-mismatch', 'attention-question-reused',
])

/**
 * Hard word caps per purpose. A result may carry a short summary; attention is
 * one question with its minimum context; an answer settles one question.
 * With stage 2b enabled, over-cap text moves to an attachment.
 */
export const attentionWordCaps: Readonly<Record<AttentionPurpose, number>> = Object.freeze({
  result: 400,
  attention: 120,
  answer: 200,
})

/**
 * Secondary length guard: non-whitespace graphemes, about six per capped word.
 * It catches content the word segmenter undercounts, such as one unbroken
 * multi-kilobyte token (one word-like segment) or long emoji runs.
 */
export const attentionGraphemeCaps: Readonly<Record<AttentionPurpose, number>> = Object.freeze({
  result: 2400,
  attention: 720,
  answer: 1200,
})

/** Legacy callers that declare nothing are audited as `result`, the least restrictive purpose. */
export const defaultAttentionPurpose: AttentionPurpose = 'result'

// Fixed locale keeps counts independent of Host locale. CJK runs use ICU
// dictionary segmentation; link text and URLs are part of the raw text, so a
// URL counts by its word-like parts and cannot be used to hide length.
// Segmentation follows the ICU data of the running Node.js, so counts may
// shift across Node/ICU upgrades; recorded verdicts are never recomputed.
const wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' })
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
/** Whitespace, punctuation and ASCII separators (URL/code syntax) are not counted as symbols. */
const uncountedGrapheme = /^(?:\s|\p{P}|\p{ASCII})+$/u

export interface AttentionTextMeasure {
  /** `isWordLike` word segments. */
  words: number
  /** Non-word graphemes other than whitespace, punctuation and ASCII, e.g. emoji or pictographs. */
  symbols: number
  /** All non-whitespace graphemes. */
  graphemes: number
}

export function measureAttentionText(text: string): AttentionTextMeasure {
  let words = 0
  let symbols = 0
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike === true) { words += 1; continue }
    for (const grapheme of graphemeSegmenter.segment(segment.segment)) if (!uncountedGrapheme.test(grapheme.segment)) symbols += 1
  }
  let graphemes = 0
  for (const grapheme of graphemeSegmenter.segment(text)) if (!/^\s+$/u.test(grapheme.segment)) graphemes += 1
  return { words, symbols, graphemes }
}

/** Audited word count: word-like segments plus symbol graphemes, so an emoji wall cannot count as zero. */
export function countAttentionWords(text: string): number {
  const measure = measureAttentionText(text)
  return measure.words + measure.symbols
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const estimatePattern = /配置估值|净收益|预期收益|成功系数|执行成本|打扰成本|潜在损失|\butility\b/iu
const exposedIdPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32,}\b/iu

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value)
}

function validQuestion(value: unknown): value is AttentionQuestion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const question = value as Partial<AttentionQuestion>
  if (!isIdentifier(question.id) || typeof question.prompt !== 'string' || question.prompt.trim().length === 0
    || question.prompt.length > 1000) return false
  if (question.choices === undefined) return true
  return Array.isArray(question.choices) && question.choices.length >= 2 && question.choices.length <= 8
    && question.choices.every(choice => typeof choice === 'string' && choice.trim().length > 0 && choice.length <= 200)
    && new Set(question.choices).size === question.choices.length
}

/** Prior audited state needed for single-question and single-use checks, scoped to one binding. */
export interface AttentionLedgerView {
  /** An accepted attention notice asked this question on this binding. */
  questionAsked(questionId: string): boolean
  /** An accepted answer already settled this question on this binding. */
  questionAnswered(questionId: string): boolean
  /** Accepted, still unanswered question ids open for this work item on this binding. */
  openQuestions(workItemId: string): readonly string[]
  /** Work item of the first accepted attention notice that asked this question on this binding. */
  questionWorkItem(questionId: string): string | undefined
}

export interface AttentionAssessment {
  purpose: AttentionPurpose
  purposeSource: AttentionPurposeSource
  workItemId?: string
  questionId?: string
  answersQuestionId?: string
  wordCount: number
  wordCap: number
  verdict: AttentionVerdict
  reasons: readonly AttentionAuditReason[]
}

/**
 * Pure and deterministic for one (input, ledger) pair. Reasons are emitted in
 * the fixed `attentionAuditReasons` order.
 */
export function assessAttention(input: Readonly<{
  text: string
  envelope?: unknown
  lanePurpose?: Readonly<{ purpose: AttentionPurpose; workItemId?: string }>
  ledger: AttentionLedgerView
}>): AttentionAssessment {
  const reasons = new Set<AttentionAuditReason>()
  let purpose: AttentionPurpose = defaultAttentionPurpose
  let purposeSource: AttentionPurposeSource = 'default'
  let workItemId: string | undefined
  let questionId: string | undefined
  let answersQuestionId: string | undefined
  const envelope = input.envelope as Partial<Record<string, unknown>> | undefined
  if (input.envelope === undefined) {
    if (input.lanePurpose === undefined) reasons.add('missing-purpose')
    else {
      purpose = input.lanePurpose.purpose; purposeSource = 'lane'
      if (isIdentifier(input.lanePurpose.workItemId)) workItemId = input.lanePurpose.workItemId
    }
  } else if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)
    || !['result', 'attention', 'answer'].includes(envelope.purpose as string)) {
    reasons.add('invalid-envelope')
  } else {
    purpose = envelope.purpose as AttentionPurpose; purposeSource = 'declared'
    if (envelope.workItemId !== undefined) {
      if (isIdentifier(envelope.workItemId)) workItemId = envelope.workItemId
      else reasons.add('invalid-envelope')
    }
    if (purpose === 'attention') {
      if (workItemId === undefined) reasons.add('attention-missing-work-item')
      if (!validQuestion(envelope.question) || 'questions' in envelope) reasons.add('attention-question-invalid')
      else questionId = envelope.question.id
      if (questionId !== undefined) {
        if (input.ledger.questionAnswered(questionId)) reasons.add('attention-question-already-answered')
        const askedFor = input.ledger.questionWorkItem(questionId)
        if (askedFor !== undefined && askedFor !== workItemId) reasons.add('attention-question-reused')
        if (workItemId !== undefined && input.ledger.openQuestions(workItemId).some(open => open !== questionId)) {
          reasons.add('attention-question-not-current')
        }
      }
    } else if (purpose === 'answer') {
      if (!isIdentifier(envelope.questionId)) reasons.add('answer-missing-question')
      else {
        answersQuestionId = envelope.questionId
        if (!input.ledger.questionAsked(answersQuestionId)) reasons.add('answer-unknown-question')
        else {
          if (input.ledger.questionAnswered(answersQuestionId)) reasons.add('answer-already-used')
          // An answer belongs to its question's work item; an undeclared item is taken from the question.
          const askedFor = input.ledger.questionWorkItem(answersQuestionId)
          if (askedFor !== undefined) {
            if (workItemId === undefined) workItemId = askedFor
            else if (workItemId !== askedFor) reasons.add('answer-work-item-mismatch')
          }
        }
      }
    }
  }
  const measure = measureAttentionText(input.text)
  const wordCount = measure.words + measure.symbols
  const wordCap = attentionWordCaps[purpose]
  if (wordCount > wordCap) reasons.add('over-word-cap')
  if (measure.graphemes > attentionGraphemeCaps[purpose]) reasons.add('over-grapheme-cap')
  if (estimatePattern.test(input.text)) reasons.add('text-exposes-estimate')
  if (exposedIdPattern.test(input.text)) reasons.add('text-exposes-identifier')
  const ordered = attentionAuditReasons.filter(reason => reasons.has(reason))
  const verdict: AttentionVerdict = ordered.some(reason => rejectReasons.has(reason)) ? 'would-reject'
    : reasons.has('over-word-cap') || reasons.has('over-grapheme-cap') ? 'would-attach' : 'would-accept'
  return {
    purpose, purposeSource,
    ...(workItemId === undefined ? {} : { workItemId }),
    ...(questionId === undefined ? {} : { questionId }),
    ...(answersQuestionId === undefined ? {} : { answersQuestionId }),
    wordCount, wordCap, verdict, reasons: Object.freeze(ordered),
  }
}

/**
 * WP19 stage 2b (opt-in, Delivery config `attentionAttachOverCap`): an
 * over-cap background/owner notification is sent as a short inline body plus
 * one text attachment carrying the full original text, never as several
 * messages. Everything below is pure and deterministic.
 */
/** Inline body budget for a converted notice, before the fixed attachment notice. */
export const attentionAttachmentSummaryWords = 60
export const attentionAttachmentSummaryGraphemes = 360

/**
 * Bodies that are cut keep URLs and Markdown links whole: a link is either
 * entirely inline (and counted) or entirely left to the attachment.
 */
const atomicLinkPattern = /\[[^\]\n]*\]\([^)\s]*\)|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/gu

function overCap(measure: AttentionTextMeasure, purpose: AttentionPurpose): boolean {
  return measure.words + measure.symbols > attentionWordCaps[purpose] || measure.graphemes > attentionGraphemeCaps[purpose]
}

/** True when the text exceeds the word or grapheme cap of its purpose. */
export function attentionOverCap(text: string, purpose: AttentionPurpose): boolean {
  return overCap(measureAttentionText(text), purpose)
}

function* attentionUnits(text: string): Generator<string> {
  let offset = 0
  for (const match of text.matchAll(atomicLinkPattern)) {
    if (match.index > offset) for (const segment of wordSegmenter.segment(text.slice(offset, match.index))) yield segment.segment
    yield match[0]
    offset = match.index + match[0].length
  }
  if (offset < text.length) for (const segment of wordSegmenter.segment(text.slice(offset))) yield segment.segment
}

/** Longest prefix of whole units within the summary budget; links are atomic. */
function attentionSummaryPrefix(text: string): string {
  let prefix = ''
  let words = 0
  let graphemes = 0
  for (const unit of attentionUnits(text)) {
    const measure = measureAttentionText(unit)
    if (words + measure.words + measure.symbols > attentionAttachmentSummaryWords
      || graphemes + measure.graphemes > attentionAttachmentSummaryGraphemes) return prefix.trimEnd()
    prefix += unit
    words += measure.words + measure.symbols
    graphemes += measure.graphemes
  }
  return prefix.trimEnd()
}

/**
 * Convert one over-cap notice to a short plain body plus a text attachment.
 * The attachment name derives from the content digest only, so a replay of the
 * same notice converts byte-identically. Callers decide whether to convert.
 */
export function convertOverCapAttention(input: Readonly<{ text: string; format: 'markdown' | 'plain'; digest: (text: string) => string }>): {
  text: string; format: 'plain'; attachment: OutboundTextAttachment
} {
  const sha256 = input.digest(input.text)
  const markdown = input.format === 'markdown'
  const name = `notice-${sha256.slice(0, 12)}.${markdown ? 'md' : 'txt'}`
  const prefix = attentionSummaryPrefix(input.text)
  const measure = measureAttentionText(input.text)
  const notice = `（全文较长，共 ${measure.words + measure.symbols} 词，已转为附件 ${name}）`
  return {
    text: prefix.length === 0 ? notice : `${prefix}…\n\n${notice}`,
    format: 'plain',
    attachment: Object.freeze({ kind: 'text', name, mediaType: markdown ? 'text/markdown' : 'text/plain', text: input.text, sha256 }),
  }
}

/**
 * Split-evasion window. Inline notices queued by the same source on the same
 * binding and lane within this window are measured together; when their sum
 * exceeds the cap of the new notice's purpose the new notice is rejected. The
 * remedy is one notice, which the over-cap path converts to an attachment.
 */
export const attentionSplitWindowMs = 300_000

export type AttentionSplitVerdict = Readonly<{ split: false } | { split: true; words: number; graphemes: number; priorNotices: number }>

/** Pure: `priorInlineTexts` are the inline bodies already queued in the window, current excluded. */
export function assessAttentionSplit(input: Readonly<{ text: string; purpose: AttentionPurpose; priorInlineTexts: readonly string[] }>): AttentionSplitVerdict {
  if (input.priorInlineTexts.length === 0) return { split: false }
  let words = 0
  let graphemes = 0
  for (const text of [...input.priorInlineTexts, input.text]) {
    const measure = measureAttentionText(text)
    words += measure.words + measure.symbols
    graphemes += measure.graphemes
  }
  return words > attentionWordCaps[input.purpose] || graphemes > attentionGraphemeCaps[input.purpose]
    ? { split: true, words, graphemes, priorNotices: input.priorInlineTexts.length }
    : { split: false }
}

/** One durable audit row; `sequence` is the read cursor. */
export interface AttentionAuditEntry extends AttentionAssessment {
  sequence: number
  outboxId: string
  bindingId: string
  lane: AttentionLane
  sourceId: string
  recordedAt: number
}
