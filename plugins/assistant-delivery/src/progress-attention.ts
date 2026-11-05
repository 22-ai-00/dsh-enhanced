/**
 * WP19 stage 2c: attention audit for progress updates. Audit only.
 *
 * Progress is presentation-only and never becomes an Outbox row, so the v31
 * `delivery_attention_audit` table (keyed by `outbox_id` with an Outbox
 * foreign key and a closed `lane` CHECK) cannot hold it without a schema bump.
 * This ledger is therefore process-local, bounded and non-durable: it resets
 * on Host restart and keeps only the most recent entries.
 *
 * Every progress update is assessed as `purpose: result` (`purposeSource:
 * lane`) against an empty question ledger, because progress never asks or
 * answers an attention question. The verdict is computed on the cumulative
 * owner-visible text of one progress run (`bindingId` + `eventId` + origin),
 * so splitting text across many bubbles cannot dodge the cap. The measured
 * text is the upper bound an adapter may render (tool previews included even
 * when an adapter hides details). Message text is never stored.
 */
import { assessAttention, attentionAuditReasons, attentionGraphemeCaps, attentionWordCaps, measureAttentionText } from './attention.js'
import type { AttentionAuditReason, AttentionLedgerView, AttentionPurpose, AttentionPurposeSource, AttentionVerdict } from './attention.js'
import type { DeliveryProgressOrigin, DeliveryProgressUpdate } from './types.js'

export interface ProgressAttentionAuditEntry {
  /** Process-local read cursor, strictly increasing from 1. */
  sequence: number
  bindingId: string
  eventId: string
  origin: DeliveryProgressOrigin
  updateKind: DeliveryProgressUpdate['kind']
  purpose: AttentionPurpose
  purposeSource: AttentionPurposeSource
  /** Audited words (word-like segments plus symbol graphemes) of this update. */
  wordCount: number
  /** Cumulative audited words of this progress run, including this update. */
  runWordCount: number
  /** Cumulative non-whitespace graphemes of this progress run. */
  runGraphemeCount: number
  wordCap: number
  /** Verdict of the run so far; `would-attach` once the run exceeds a cap. */
  verdict: AttentionVerdict
  /** Run-level reasons in `attentionAuditReasons` order. */
  reasons: readonly AttentionAuditReason[]
  recordedAt: number
}

export interface ProgressAttentionAuditPage {
  entries: readonly ProgressAttentionAuditEntry[]
  hasMore: boolean
  nextAfterSequence: number | null
  /** Always false: entries live in this Host process only. */
  durable: false
  /** Entries evicted from the bounded ring since this Host started. */
  evicted: number
}

const progressPurpose: AttentionPurpose = 'result'

const emptyLedger: AttentionLedgerView = Object.freeze({
  questionAsked: () => false,
  questionAnswered: () => false,
  openQuestions: () => [],
  questionWorkItem: () => undefined,
})

/** Upper bound of the owner-visible text one update can add to a progress surface. */
export function progressAttentionText(update: DeliveryProgressUpdate): string {
  switch (update.kind) {
    case 'step': return update.text
    case 'tool-started': return [update.toolName, update.argumentsPreview].filter(part => part !== undefined).join('\n')
    case 'tool-finished': return [update.resultPreview, update.code].filter(part => part !== undefined).join('\n')
    case 'todos': return update.todos.map(todo => todo.content).join('\n')
    case 'failed': return update.code ?? ''
    case 'started':
    case 'completed':
    case 'paused':
      return ''
  }
}

interface RunState {
  words: number
  graphemes: number
  flags: Set<AttentionAuditReason>
}

const flagReasons: ReadonlySet<AttentionAuditReason> = new Set(['text-exposes-estimate', 'text-exposes-identifier'])

export class ProgressAttentionAudit {
  private readonly entries: ProgressAttentionAuditEntry[] = []
  private readonly runs = new Map<string, RunState>()
  private sequence = 0
  private evictedEntries = 0

  constructor(
    private readonly maxEntries = 1000,
    private readonly maxRuns = 256,
    private readonly now: () => number = Date.now,
  ) {}

  /** Deterministic for one ordered update stream; `recordedAt` is the only clock-derived field. */
  record(input: Readonly<{ bindingId: string; eventId: string; origin: DeliveryProgressOrigin; update: DeliveryProgressUpdate }>): ProgressAttentionAuditEntry {
    const text = progressAttentionText(input.update)
    const assessment = assessAttention({ text, lanePurpose: { purpose: progressPurpose }, ledger: emptyLedger })
    const measure = measureAttentionText(text)
    const key = JSON.stringify([input.bindingId, input.eventId, input.origin])
    let run = this.runs.get(key)
    if (run === undefined) {
      run = { words: 0, graphemes: 0, flags: new Set() }
      this.runs.set(key, run)
      // Insertion order is age order; drop the oldest unterminated run.
      while (this.runs.size > this.maxRuns) this.runs.delete(this.runs.keys().next().value!)
    }
    run.words += assessment.wordCount
    run.graphemes += measure.graphemes
    for (const reason of assessment.reasons) if (flagReasons.has(reason)) run.flags.add(reason)
    const wordCap = attentionWordCaps[progressPurpose]
    const reasons = new Set<AttentionAuditReason>(run.flags)
    if (run.words > wordCap) reasons.add('over-word-cap')
    if (run.graphemes > attentionGraphemeCaps[progressPurpose]) reasons.add('over-grapheme-cap')
    const ordered = Object.freeze(attentionAuditReasons.filter(reason => reasons.has(reason)))
    const verdict: AttentionVerdict = reasons.has('over-word-cap') || reasons.has('over-grapheme-cap') ? 'would-attach' : 'would-accept'
    this.sequence += 1
    const entry: ProgressAttentionAuditEntry = Object.freeze({
      sequence: this.sequence,
      bindingId: input.bindingId,
      eventId: input.eventId,
      origin: input.origin,
      updateKind: input.update.kind,
      purpose: assessment.purpose,
      purposeSource: assessment.purposeSource,
      wordCount: assessment.wordCount,
      runWordCount: run.words,
      runGraphemeCount: run.graphemes,
      wordCap,
      verdict,
      reasons: ordered,
      recordedAt: this.now(),
    })
    this.entries.push(entry)
    while (this.entries.length > this.maxEntries) { this.entries.shift(); this.evictedEntries += 1 }
    const kind = input.update.kind
    // A terminal ends the whole inbound run. Delivery only emits foreground
    // terminals, so also release the sibling background run state instead of
    // leaving it to crowd live runs out of the bounded map.
    if (kind === 'completed' || kind === 'failed' || kind === 'paused') {
      for (const origin of ['foreground', 'background'] as const) this.runs.delete(JSON.stringify([input.bindingId, input.eventId, origin]))
    }
    return entry
  }

  /** `afterSequence`/`limit` are validated by the caller. */
  list(afterSequence: number, limit: number): ProgressAttentionAuditPage {
    const start = this.entries.findIndex(entry => entry.sequence > afterSequence)
    const remaining = start < 0 ? [] : this.entries.slice(start)
    const entries = Object.freeze(remaining.slice(0, limit))
    const hasMore = remaining.length > limit
    return Object.freeze({
      entries,
      hasMore,
      nextAfterSequence: hasMore ? entries.at(-1)!.sequence : null,
      durable: false as const,
      evicted: this.evictedEntries,
    })
  }
}
