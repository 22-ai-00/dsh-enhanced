import { createHash } from 'node:crypto'

/**
 * WP20 inferred-candidate model-evaluation contract.
 *
 * A pure, in-process queue: the only outward call is the injected
 * `evaluator`. It never writes storage, delivers, notifies or admits work;
 * every decision is returned to the caller, which owns persistence (the intake
 * ledger) and any effect. Observe mode always yields `effect: 'none'` and only
 * records `wouldAccept`.
 *
 * Composition with the intake ledger's Host strength grade
 * (`explicit | inferred | ignore`): only `inferred` items are enqueued here
 * (`strength: 'inferred'` is required). `explicit` items are admitted by the
 * deterministic gate without a model call, and `ignore` items are filtered.
 */

/** Ordered weakest → strongest. A model verdict may lower, never raise, the Host ceiling. */
export const INTAKE_EVALUATION_LEVELS = ['ignore', 'digest', 'notify', 'accept'] as const
export type IntakeEvaluationLevel = typeof INTAKE_EVALUATION_LEVELS[number]
export type IntakeEvaluationMode = 'observe' | 'auto'

export const INTAKE_EVALUATION_REASONS = [
  'source-unauthenticated',
  'ceiling-ignore',
  'malformed-output',
  'quote-bound-exceeded',
  'quote-missing',
  'quote-not-in-source',
  'upgrade-clamped',
  'consecutive-failures',
] as const
export type IntakeEvaluationReason = typeof INTAKE_EVALUATION_REASONS[number]

/** One inferred candidate matched by one Policy rule. */
export interface InferredIntakeCandidate {
  readonly candidateId: string
  readonly ruleId: string
  /** Host strength grade; only `inferred` is model-evaluated. */
  readonly strength: 'inferred'
  /** Policy version the Host matched `ruleId` and computed `ceiling` under. */
  readonly policyVersion: string
  /** Host-authenticated source text; quotes are checked against exactly this string. */
  readonly sourceText: string
  /** Host-attested SHA-256 hex of the UTF-8 `sourceText`. */
  readonly sourceDigest: string
  /** Host-computed strength; the evaluation result is clamped to it. */
  readonly ceiling: IntakeEvaluationLevel
}

export interface IntakeModelRequest {
  readonly candidateId: string
  readonly ruleId: string
  readonly policyVersion: string
  readonly sourceText: string
  readonly ceiling: IntakeEvaluationLevel
  readonly signal: AbortSignal
}

/** Expected evaluator output shape; anything else is `malformed-output`. */
export interface IntakeModelVerdict {
  readonly level: IntakeEvaluationLevel
  readonly quotes: readonly string[]
}

export type IntakeModelEvaluator = (request: IntakeModelRequest) => Promise<unknown>

export interface IntakeEvaluationDecision {
  readonly candidateId: string
  readonly ruleId: string
  readonly sourceDigest: string
  readonly policyVersion: string
  readonly mode: IntakeEvaluationMode
  readonly status: 'decided' | 'unavailable'
  readonly level: IntakeEvaluationLevel
  /** The model's raw level when it was well-formed, else `null`. */
  readonly proposedLevel: IntakeEvaluationLevel | null
  readonly ceiling: IntakeEvaluationLevel
  /** Only verified quotes; empty whenever any quote failed verification. */
  readonly quotes: readonly string[]
  readonly reasons: readonly IntakeEvaluationReason[]
  readonly wouldAccept: boolean
  /** `apply` only in auto mode for a decided, non-ignore level. */
  readonly effect: 'none' | 'apply'
  readonly attempts: number
  readonly decidedAt: number
}

export type IntakeEnqueueResult =
  | { readonly state: 'queued'; readonly prior?: 'adopted' | 'rejected' }
  | { readonly state: 'duplicate' }
  | { readonly state: 'decided'; readonly decision: IntakeEvaluationDecision }
  | { readonly state: 'rejected'; readonly reason: 'invalid-candidate' | 'stale-policy' | 'conflict' | 'queue-full' }

export interface IntakeEvaluationOptions {
  readonly evaluator: IntakeModelEvaluator
  /** Current Policy version, read at enqueue, dispatch and completion. */
  readonly policyVersion: () => string
  readonly mode: () => IntakeEvaluationMode
  readonly now?: () => number
  readonly setTimer?: (ms: number, callback: () => void) => () => void
  /** Capped at the 32-bit timer maximum so it never wraps to an immediate timeout. */
  readonly timeoutMs?: number
  readonly maxConsecutiveFailures?: number
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  /** Sliding-window call budget; timed-out and failed calls count. */
  readonly budget?: { readonly maxCalls: number; readonly windowMs: number }
  readonly maxPerRun?: number
  /** Bound on not-yet-decided candidates for the current Policy version. */
  readonly maxPending?: number
  /** Bound on all retained entries; the oldest settled or stale entries are evicted first. */
  readonly maxRetained?: number
  readonly maxQuotes?: number
  /** Per-quote bound in UTF-16 code units. */
  readonly maxQuoteChars?: number
}

export interface IntakeEvaluationInspection {
  readonly queued: number
  readonly decided: number
  readonly unavailable: number
  /** Entries matched under an older Policy version; re-enqueue under the current one to re-evaluate. */
  readonly awaitingRematch: number
  readonly callsInWindow: number
  readonly budgetExhausted: boolean
}

interface Entry {
  readonly candidate: InferredIntakeCandidate
  readonly seq: number
  state: 'queued' | 'inflight' | 'decided'
  failures: number
  attempts: number
  nextAt: number
  decision: IntakeEvaluationDecision | undefined
}

type QuoteRead =
  | { readonly ok: true; readonly quotes: string[] }
  | { readonly ok: false; readonly reason: 'malformed-output' | 'quote-bound-exceeded' }

const MAX_TIMER_MS = 2_147_483_647
const rank = (level: IntakeEvaluationLevel) => INTAKE_EVALUATION_LEVELS.indexOf(level)
const isLevel = (value: unknown): value is IntakeEvaluationLevel =>
  typeof value === 'string' && (INTAKE_EVALUATION_LEVELS as readonly string[]).includes(value)
const isReason = (value: unknown): value is IntakeEvaluationReason =>
  typeof value === 'string' && (INTAKE_EVALUATION_REASONS as readonly string[]).includes(value)
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const keyOf = (c: { candidateId: string; ruleId: string }) => `${c.candidateId}\0${c.ruleId}`
const positive = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback

const defaultTimer = (ms: number, callback: () => void) => {
  const handle = setTimeout(callback, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

const TIMEOUT = Symbol('timeout')

/**
 * Evaluates each (candidate, rule) exactly once per Policy version.
 *
 * - Budget: at most `budget.maxCalls` evaluator calls per sliding window; when
 *   exhausted, due items stay queued untouched. Late results after a timeout
 *   are discarded; the call was already charged at dispatch.
 * - Failure (timeout, throw, rejection): re-queued with exponential backoff
 *   capped at `backoffMaxMs`; the `maxConsecutiveFailures`-th consecutive
 *   failure settles as `unavailable` (level `ignore`, no effect).
 * - Policy staleness: a candidate carries the Policy version its rule and
 *   ceiling were matched under. A result whose Policy version changed during
 *   the call is discarded; entries (settled or not) on an older version are
 *   never evaluated or returned and wait for the Host to re-enqueue the
 *   candidate as re-matched under the current version, which replaces them.
 */
export class InferredIntakeEvaluationQueue {
  readonly #evaluator: IntakeModelEvaluator
  readonly #policyVersion: () => string
  readonly #mode: () => IntakeEvaluationMode
  readonly #now: () => number
  readonly #setTimer: (ms: number, callback: () => void) => () => void
  readonly #timeoutMs: number
  readonly #maxFailures: number
  readonly #backoffBaseMs: number
  readonly #backoffMaxMs: number
  readonly #maxCalls: number
  readonly #windowMs: number
  readonly #maxPerRun: number
  readonly #maxPending: number
  readonly #maxRetained: number
  readonly #maxQuotes: number
  readonly #maxQuoteChars: number
  readonly #entries = new Map<string, Entry>()
  #calls: number[] = []
  #seq = 0
  #running = false

  constructor(options: IntakeEvaluationOptions) {
    this.#evaluator = options.evaluator
    this.#policyVersion = options.policyVersion
    this.#mode = options.mode
    this.#now = options.now ?? (() => Date.now())
    this.#setTimer = options.setTimer ?? defaultTimer
    this.#timeoutMs = Math.min(positive(options.timeoutMs, 30_000), MAX_TIMER_MS)
    this.#maxFailures = positive(options.maxConsecutiveFailures, 3)
    this.#backoffBaseMs = positive(options.backoffBaseMs, 1_000)
    this.#backoffMaxMs = Math.max(this.#backoffBaseMs, positive(options.backoffMaxMs, 60_000))
    this.#maxCalls = positive(options.budget?.maxCalls, 20)
    this.#windowMs = positive(options.budget?.windowMs, 3_600_000)
    this.#maxPerRun = positive(options.maxPerRun, 5)
    this.#maxPending = positive(options.maxPending, 1_000)
    this.#maxRetained = Math.max(this.#maxPending, positive(options.maxRetained, 10_000))
    this.#maxQuotes = positive(options.maxQuotes, 4)
    this.#maxQuoteChars = positive(options.maxQuoteChars, 280)
  }

  /**
   * Queue one candidate/rule matched under the current Policy version.
   * `prior` re-seeds a decision persisted by the caller (e.g. after restart)
   * so the rule is not evaluated again. It is not authenticated (the caller's
   * ledger is the trust root) but must be internally consistent with this
   * candidate; it is rebuilt from its checked fields, and an inconsistent
   * prior is reported as `prior: 'rejected'` and the candidate is evaluated.
   */
  enqueue(candidate: InferredIntakeCandidate, prior?: IntakeEvaluationDecision): IntakeEnqueueResult {
    const frozen = snapshotCandidate(candidate)
    if (!frozen) return { state: 'rejected', reason: 'invalid-candidate' }
    const version = this.#policyVersion()
    if (frozen.policyVersion !== version) return { state: 'rejected', reason: 'stale-policy' }
    if (sha256(frozen.sourceText) !== frozen.sourceDigest) {
      // Not retained: an authentic re-enqueue for the same key must not be blocked.
      return { state: 'decided', decision: this.#build(frozen, 0, 'decided', 'ignore', null, [], ['source-unauthenticated']) }
    }
    const key = keyOf(frozen)
    const existing = this.#entries.get(key)
    if (existing && existing.candidate.policyVersion === version) {
      const same = existing.candidate.sourceText === frozen.sourceText
        && existing.candidate.sourceDigest === frozen.sourceDigest
        && existing.candidate.ceiling === frozen.ceiling
      return same ? { state: 'duplicate' } : { state: 'rejected', reason: 'conflict' }
    }
    // Any existing entry is from an older Policy version: the re-match replaces it.
    const adopted = prior === undefined ? undefined : this.#adoptPrior(frozen, prior)
    const settlesNow = adopted !== undefined || frozen.ceiling === 'ignore'
    if (!settlesNow && this.#pendingCount(version) >= this.#maxPending) return { state: 'rejected', reason: 'queue-full' }
    if (existing) this.#entries.delete(key)
    else if (!this.#makeRoom(version)) return { state: 'rejected', reason: 'queue-full' }
    const entry: Entry = { candidate: frozen, seq: this.#seq++, state: 'queued', failures: 0, attempts: 0, nextAt: this.#now(), decision: undefined }
    this.#entries.set(key, entry)
    if (adopted) {
      entry.state = 'decided'
      entry.decision = adopted
      entry.attempts = adopted.attempts
      return { state: 'queued', prior: 'adopted' }
    }
    if (frozen.ceiling === 'ignore') {
      // Nothing a downgrade-only model could change; do not spend budget.
      return { state: 'decided', decision: this.#settle(entry, 'decided', 'ignore', null, [], ['ceiling-ignore']) }
    }
    return prior === undefined ? { state: 'queued' } : { state: 'queued', prior: 'rejected' }
  }

  /**
   * Current-version decision for one candidate/rule, if settled. `effect`
   * reflects the current mode: outside auto mode it is always `none`.
   */
  decision(candidateId: string, ruleId: string): IntakeEvaluationDecision | undefined {
    const entry = this.#entries.get(keyOf({ candidateId, ruleId }))
    const decision = entry?.state === 'decided' ? entry.decision : undefined
    if (!decision || entry?.candidate.policyVersion !== this.#policyVersion()) return undefined
    return decision.effect === 'apply' && this.#mode() !== 'auto' ? Object.freeze({ ...decision, effect: 'none' as const }) : decision
  }

  inspect(): IntakeEvaluationInspection {
    this.#pruneCalls()
    const version = this.#policyVersion()
    let queued = 0, decided = 0, unavailable = 0, awaitingRematch = 0
    for (const entry of this.#entries.values()) {
      if (entry.candidate.policyVersion !== version) awaitingRematch++
      else if (entry.state !== 'decided') queued++
      else if (entry.decision?.status === 'unavailable') unavailable++
      else decided++
    }
    return { queued, decided, unavailable, awaitingRematch, callsInWindow: this.#calls.length, budgetExhausted: this.#calls.length >= this.#maxCalls }
  }

  /**
   * Evaluate up to `maxPerRun` due current-version items sequentially and
   * return the decisions settled in this run. Re-entrant calls return `[]`.
   */
  async runDue(): Promise<IntakeEvaluationDecision[]> {
    if (this.#running) return []
    this.#running = true
    try {
      const version = this.#policyVersion()
      const now = this.#now()
      const due = [...this.#entries.values()]
        .filter(entry => entry.state === 'queued' && entry.candidate.policyVersion === version && entry.nextAt <= now)
        .sort((a, b) => a.nextAt - b.nextAt || a.seq - b.seq)
        .slice(0, this.#maxPerRun)
      const settled: IntakeEvaluationDecision[] = []
      for (const entry of due) {
        // Re-check after every await: the entry may have been replaced or the Policy moved on.
        if (this.#entries.get(keyOf(entry.candidate)) !== entry || entry.state !== 'queued'
          || entry.candidate.policyVersion !== this.#policyVersion()) continue
        this.#pruneCalls()
        if (this.#calls.length >= this.#maxCalls) break
        const decision = await this.#evaluate(entry)
        if (decision) settled.push(decision)
      }
      return settled
    } finally {
      this.#running = false
    }
  }

  async #evaluate(entry: Entry): Promise<IntakeEvaluationDecision | undefined> {
    const { candidate } = entry
    const version = candidate.policyVersion
    entry.state = 'inflight'
    try {
      entry.attempts++
      this.#calls.push(this.#now())
      const controller = new AbortController()
      let cancel = () => {}
      const timeout = new Promise<typeof TIMEOUT>(resolve => {
        cancel = this.#setTimer(this.#timeoutMs, () => { controller.abort(); resolve(TIMEOUT) })
      })
      let output: unknown
      try {
        output = await Promise.race([
          Promise.resolve().then(() => this.#evaluator({
            candidateId: candidate.candidateId,
            ruleId: candidate.ruleId,
            policyVersion: version,
            sourceText: candidate.sourceText,
            ceiling: candidate.ceiling,
            signal: controller.signal,
          })),
          timeout,
        ])
      } catch {
        output = TIMEOUT
      } finally {
        cancel()
      }
      if (this.#policyVersion() !== version) {
        // The Policy changed under the call: the verdict, rule match and
        // ceiling all belong to a dead version. Wait for the Host's re-match.
        entry.state = 'queued'
        entry.failures = 0
        return undefined
      }
      if (output === TIMEOUT) {
        entry.failures++
        if (entry.failures >= this.#maxFailures) {
          return this.#settle(entry, 'unavailable', 'ignore', null, [], ['consecutive-failures'])
        }
        entry.nextAt = this.#now() + Math.min(this.#backoffBaseMs * 2 ** (entry.failures - 1), this.#backoffMaxMs)
        entry.state = 'queued'
        return undefined
      }
      entry.failures = 0
      const verdict = this.#judge(candidate, output)
      return this.#settle(entry, 'decided', verdict.level, verdict.proposed, verdict.quotes, verdict.reasons)
    } finally {
      // A throwing Host callback must not strand the entry in flight forever.
      if (entry.state === 'inflight') entry.state = 'queued'
    }
  }

  #judge(candidate: InferredIntakeCandidate, output: unknown): {
    level: IntakeEvaluationLevel; proposed: IntakeEvaluationLevel | null; quotes: string[]; reasons: IntakeEvaluationReason[]
  } {
    const ignore = (proposed: IntakeEvaluationLevel | null, reason: IntakeEvaluationReason) =>
      ({ level: 'ignore' as const, proposed, quotes: [], reasons: [reason] })
    let level: unknown
    let read: QuoteRead
    try {
      if (typeof output !== 'object' || output === null) return ignore(null, 'malformed-output')
      // Read each field exactly once so getters/proxies cannot change answers between checks.
      const record = output as Record<string, unknown>
      level = record.level
      if (!isLevel(level)) return ignore(null, 'malformed-output')
      read = this.#readQuotes(record.quotes)
    } catch {
      return ignore(null, 'malformed-output')
    }
    if (!read.ok) return ignore(read.reason === 'malformed-output' ? null : level, read.reason)
    const quotes = read.quotes
    if (!quotes.every(q => candidate.sourceText.includes(q))) return ignore(level, 'quote-not-in-source')
    if (level !== 'ignore' && quotes.length === 0) return ignore(level, 'quote-missing')
    if (rank(level) > rank(candidate.ceiling)) {
      return { level: candidate.ceiling, proposed: level, quotes, reasons: ['upgrade-clamped'] }
    }
    return { level, proposed: level, quotes, reasons: [] }
  }

  /**
   * Copy a quote list once by index (so sparse arrays cannot skip checks).
   * Each quote must be a well-formed (no lone surrogate) string containing at
   * least one non-whitespace character; bounds are count and UTF-16 length.
   */
  #readQuotes(value: unknown): QuoteRead {
    if (!Array.isArray(value)) return { ok: false, reason: 'malformed-output' }
    const length = value.length
    if (length > this.#maxQuotes) return { ok: false, reason: 'quote-bound-exceeded' }
    const quotes: string[] = []
    for (let i = 0; i < length; i++) {
      const quote: unknown = value[i]
      if (typeof quote !== 'string' || !quote.isWellFormed() || !/\S/u.test(quote)) return { ok: false, reason: 'malformed-output' }
      if (quote.length > this.#maxQuoteChars) return { ok: false, reason: 'quote-bound-exceeded' }
      quotes.push(quote)
    }
    return { ok: true, quotes }
  }

  #adoptPrior(candidate: InferredIntakeCandidate, prior: unknown): IntakeEvaluationDecision | undefined {
    try {
      if (typeof prior !== 'object' || prior === null) return undefined
      const p = prior as Record<string, unknown>
      const { mode, status, level, proposedLevel, attempts, decidedAt } = p
      if (p.candidateId !== candidate.candidateId || p.ruleId !== candidate.ruleId || p.sourceDigest !== candidate.sourceDigest
        || p.policyVersion !== candidate.policyVersion || p.ceiling !== candidate.ceiling) return undefined
      if (mode !== 'observe' && mode !== 'auto') return undefined
      if (status !== 'decided' && status !== 'unavailable') return undefined
      if (!isLevel(level) || rank(level) > rank(candidate.ceiling)) return undefined
      if (proposedLevel !== null && !isLevel(proposedLevel)) return undefined
      if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) return undefined
      if (typeof decidedAt !== 'number' || !Number.isFinite(decidedAt)) return undefined
      const read = this.#readQuotes(p.quotes)
      if (!read.ok || !read.quotes.every(q => candidate.sourceText.includes(q))) return undefined
      const rawReasons = p.reasons
      if (!Array.isArray(rawReasons)) return undefined
      const reasons: IntakeEvaluationReason[] = []
      for (let i = 0; i < rawReasons.length; i++) {
        const reason: unknown = rawReasons[i]
        if (!isReason(reason) || reason === 'source-unauthenticated') return undefined
        reasons.push(reason)
      }
      const failedOut = reasons.includes('consecutive-failures')
      if ((status === 'unavailable') !== failedOut) return undefined
      if (status === 'unavailable' && (level !== 'ignore' || read.quotes.length > 0 || reasons.length !== 1)) return undefined
      if (status === 'decided' && level !== 'ignore' && read.quotes.length === 0) return undefined
      return this.#build(candidate, attempts, status, level, proposedLevel, read.quotes, reasons, mode, decidedAt)
    } catch {
      return undefined
    }
  }

  #build(
    candidate: InferredIntakeCandidate,
    attempts: number,
    status: IntakeEvaluationDecision['status'],
    level: IntakeEvaluationLevel,
    proposedLevel: IntakeEvaluationLevel | null,
    quotes: readonly string[],
    reasons: readonly IntakeEvaluationReason[],
    mode: IntakeEvaluationMode = this.#mode() === 'auto' ? 'auto' : 'observe',
    decidedAt: number = this.#now(),
  ): IntakeEvaluationDecision {
    return Object.freeze({
      candidateId: candidate.candidateId,
      ruleId: candidate.ruleId,
      sourceDigest: candidate.sourceDigest,
      policyVersion: candidate.policyVersion,
      mode,
      status,
      level,
      proposedLevel,
      ceiling: candidate.ceiling,
      quotes: Object.freeze([...quotes]),
      reasons: Object.freeze([...reasons]),
      wouldAccept: status === 'decided' && level === 'accept',
      effect: mode === 'auto' && status === 'decided' && level !== 'ignore' ? 'apply' : 'none',
      attempts,
      decidedAt,
    })
  }

  #settle(
    entry: Entry,
    status: IntakeEvaluationDecision['status'],
    level: IntakeEvaluationLevel,
    proposedLevel: IntakeEvaluationLevel | null,
    quotes: readonly string[],
    reasons: readonly IntakeEvaluationReason[],
  ): IntakeEvaluationDecision {
    const decision = this.#build(entry.candidate, entry.attempts, status, level, proposedLevel, quotes, reasons)
    entry.state = 'decided'
    entry.decision = decision
    return decision
  }

  #pendingCount(version: string): number {
    let pending = 0
    for (const entry of this.#entries.values()) {
      if (entry.state !== 'decided' && entry.candidate.policyVersion === version) pending++
    }
    return pending
  }

  /** Evict the oldest settled or stale entry when at `maxRetained`. */
  #makeRoom(version: string): boolean {
    if (this.#entries.size < this.#maxRetained) return true
    for (const [key, entry] of this.#entries) {
      if (entry.state === 'decided' || entry.candidate.policyVersion !== version) {
        this.#entries.delete(key)
        return true
      }
    }
    return false
  }

  #pruneCalls(): void {
    const floor = this.#now() - this.#windowMs
    this.#calls = this.#calls.filter(at => at > floor)
  }
}

/** Read each field once into a frozen copy, then validate the copy. */
function snapshotCandidate(candidate: unknown): InferredIntakeCandidate | undefined {
  try {
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const c = candidate as Record<string, unknown>
    const copy = {
      candidateId: c.candidateId,
      ruleId: c.ruleId,
      strength: c.strength,
      policyVersion: c.policyVersion,
      sourceText: c.sourceText,
      sourceDigest: c.sourceDigest,
      ceiling: c.ceiling,
    }
    const valid = typeof copy.candidateId === 'string' && copy.candidateId.length > 0
      && typeof copy.ruleId === 'string' && copy.ruleId.length > 0
      && copy.strength === 'inferred'
      && typeof copy.policyVersion === 'string' && copy.policyVersion.length > 0
      && typeof copy.sourceText === 'string'
      && typeof copy.sourceDigest === 'string' && /^[0-9a-f]{64}$/u.test(copy.sourceDigest)
      && isLevel(copy.ceiling)
    return valid ? Object.freeze(copy as InferredIntakeCandidate) : undefined
  } catch {
    return undefined
  }
}
