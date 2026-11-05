import { createHash } from 'node:crypto'

/**
 * WP20 inferred-candidate model-evaluation contract.
 *
 * A pure, in-process queue: the only outward call is the injected
 * `evaluator`. It never writes storage, delivers, notifies or admits work;
 * every decision is returned to the caller, which owns persistence (the intake
 * ledger) and any effect. Observe mode always yields `effect: 'none'` and only
 * records `wouldAccept`.
 */

/** Ordered weakest → strongest. A model verdict may lower, never raise, the Host ceiling. */
export const INTAKE_EVALUATION_LEVELS = ['ignore', 'digest', 'notify', 'accept'] as const
export type IntakeEvaluationLevel = typeof INTAKE_EVALUATION_LEVELS[number]
export type IntakeEvaluationMode = 'observe' | 'auto'

export type IntakeEvaluationReason =
  | 'source-unauthenticated'
  | 'malformed-output'
  | 'quote-bound-exceeded'
  | 'quote-missing'
  | 'quote-not-in-source'
  | 'upgrade-clamped'
  | 'consecutive-failures'

/** One inferred candidate matched by one Policy rule. */
export interface InferredIntakeCandidate {
  readonly candidateId: string
  readonly ruleId: string
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
  | { readonly state: 'queued' | 'duplicate' }
  | { readonly state: 'decided'; readonly decision: IntakeEvaluationDecision }
  | { readonly state: 'rejected'; readonly reason: 'invalid-candidate' | 'conflict' | 'queue-full' }

export interface IntakeEvaluationOptions {
  readonly evaluator: IntakeModelEvaluator
  /** Current Policy version, read at dispatch and again at completion. */
  readonly policyVersion: () => string
  readonly mode: () => IntakeEvaluationMode
  readonly now?: () => number
  readonly setTimer?: (ms: number, callback: () => void) => () => void
  readonly timeoutMs?: number
  readonly maxConsecutiveFailures?: number
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  /** Sliding-window call budget; timed-out and failed calls count. */
  readonly budget?: { readonly maxCalls: number; readonly windowMs: number }
  readonly maxPerRun?: number
  readonly maxPending?: number
  readonly maxQuotes?: number
  readonly maxQuoteChars?: number
}

export interface IntakeEvaluationInspection {
  readonly queued: number
  readonly decided: number
  readonly unavailable: number
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

const rank = (level: IntakeEvaluationLevel) => INTAKE_EVALUATION_LEVELS.indexOf(level)
const isLevel = (value: unknown): value is IntakeEvaluationLevel =>
  typeof value === 'string' && (INTAKE_EVALUATION_LEVELS as readonly string[]).includes(value)
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
 *   exhausted, due items stay queued untouched.
 * - Failure (timeout, throw, rejection): re-queued with exponential backoff
 *   capped at `backoffMaxMs`; the `maxConsecutiveFailures`-th consecutive
 *   failure settles as `unavailable` (level `ignore`, no effect).
 * - Policy staleness: a result whose Policy version changed during the call is
 *   discarded and re-queued; settled decisions on an older version are
 *   re-queued at the start of the next `runDue`.
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
    this.#timeoutMs = positive(options.timeoutMs, 30_000)
    this.#maxFailures = positive(options.maxConsecutiveFailures, 3)
    this.#backoffBaseMs = positive(options.backoffBaseMs, 1_000)
    this.#backoffMaxMs = Math.max(this.#backoffBaseMs, positive(options.backoffMaxMs, 60_000))
    this.#maxCalls = positive(options.budget?.maxCalls, 20)
    this.#windowMs = positive(options.budget?.windowMs, 3_600_000)
    this.#maxPerRun = positive(options.maxPerRun, 5)
    this.#maxPending = positive(options.maxPending, 1_000)
    this.#maxQuotes = positive(options.maxQuotes, 4)
    this.#maxQuoteChars = positive(options.maxQuoteChars, 280)
  }

  /**
   * Queue one candidate/rule. `prior` re-seeds a decision persisted by the
   * caller (e.g. after restart) so the rule is not evaluated again; a prior on
   * a stale Policy version is re-queued by the next `runDue`.
   */
  enqueue(candidate: InferredIntakeCandidate, prior?: IntakeEvaluationDecision): IntakeEnqueueResult {
    if (!validCandidate(candidate)) return { state: 'rejected', reason: 'invalid-candidate' }
    const frozen: InferredIntakeCandidate = Object.freeze({ ...candidate })
    const key = keyOf(frozen)
    const existing = this.#entries.get(key)
    if (existing) {
      return existing.candidate.sourceDigest === frozen.sourceDigest && existing.candidate.ceiling === frozen.ceiling
        ? { state: 'duplicate' }
        : { state: 'rejected', reason: 'conflict' }
    }
    if (this.#entries.size >= this.#maxPending) return { state: 'rejected', reason: 'queue-full' }
    const entry: Entry = { candidate: frozen, seq: this.#seq++, state: 'queued', failures: 0, attempts: 0, nextAt: this.#now(), decision: undefined }
    this.#entries.set(key, entry)
    if (sha256(frozen.sourceText) !== frozen.sourceDigest) {
      return { state: 'decided', decision: this.#settle(entry, this.#policyVersion(), 'decided', 'ignore', null, [], ['source-unauthenticated']) }
    }
    if (prior && keyOf(prior) === key && prior.sourceDigest === frozen.sourceDigest && prior.ceiling === frozen.ceiling
      && rank(prior.level) <= rank(frozen.ceiling) && prior.quotes.every(q => q.length > 0 && frozen.sourceText.includes(q))) {
      entry.state = 'decided'
      entry.decision = prior
      entry.attempts = prior.attempts
    }
    return { state: 'queued' }
  }

  /** Current-version decision for one candidate/rule, if settled. */
  decision(candidateId: string, ruleId: string): IntakeEvaluationDecision | undefined {
    const decision = this.#entries.get(keyOf({ candidateId, ruleId }))?.decision
    return decision && decision.policyVersion === this.#policyVersion() ? decision : undefined
  }

  inspect(): IntakeEvaluationInspection {
    this.#pruneCalls()
    let queued = 0, decided = 0, unavailable = 0
    for (const entry of this.#entries.values()) {
      if (entry.state !== 'decided') queued++
      else if (entry.decision?.status === 'unavailable') unavailable++
      else decided++
    }
    return { queued, decided, unavailable, callsInWindow: this.#calls.length, budgetExhausted: this.#calls.length >= this.#maxCalls }
  }

  /**
   * Evaluate up to `maxPerRun` due items sequentially and return the
   * decisions settled in this run. Re-entrant calls return `[]`.
   */
  async runDue(): Promise<IntakeEvaluationDecision[]> {
    if (this.#running) return []
    this.#running = true
    try {
      const version = this.#policyVersion()
      for (const entry of this.#entries.values()) {
        if (entry.state === 'decided' && entry.decision?.policyVersion !== version
          && !entry.decision?.reasons.includes('source-unauthenticated')) this.#requeue(entry)
      }
      const now = this.#now()
      const due = [...this.#entries.values()]
        .filter(entry => entry.state === 'queued' && entry.nextAt <= now)
        .sort((a, b) => a.nextAt - b.nextAt || a.seq - b.seq)
        .slice(0, this.#maxPerRun)
      const settled: IntakeEvaluationDecision[] = []
      for (const entry of due) {
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
    const version = this.#policyVersion()
    entry.state = 'inflight'
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
      // The Policy changed under the call: the verdict is for a dead version.
      this.#requeue(entry)
      return undefined
    }
    if (output === TIMEOUT) {
      entry.failures++
      if (entry.failures >= this.#maxFailures) {
        return this.#settle(entry, version, 'unavailable', 'ignore', null, [], ['consecutive-failures'])
      }
      entry.state = 'queued'
      entry.nextAt = this.#now() + Math.min(this.#backoffBaseMs * 2 ** (entry.failures - 1), this.#backoffMaxMs)
      return undefined
    }
    entry.failures = 0
    const verdict = this.#judge(candidate, output)
    return this.#settle(entry, version, 'decided', verdict.level, verdict.proposed, verdict.quotes, verdict.reasons)
  }

  #judge(candidate: InferredIntakeCandidate, output: unknown): {
    level: IntakeEvaluationLevel; proposed: IntakeEvaluationLevel | null; quotes: string[]; reasons: IntakeEvaluationReason[]
  } {
    const ignore = (proposed: IntakeEvaluationLevel | null, reason: IntakeEvaluationReason) =>
      ({ level: 'ignore' as const, proposed, quotes: [], reasons: [reason] })
    if (typeof output !== 'object' || output === null) return ignore(null, 'malformed-output')
    const { level, quotes } = output as Record<string, unknown>
    if (!isLevel(level) || !Array.isArray(quotes) || !quotes.every(q => typeof q === 'string' && q.length > 0)) {
      return ignore(null, 'malformed-output')
    }
    const strings = quotes as string[]
    if (strings.length > this.#maxQuotes || strings.some(q => q.length > this.#maxQuoteChars)) return ignore(level, 'quote-bound-exceeded')
    if (!strings.every(q => candidate.sourceText.includes(q))) return ignore(level, 'quote-not-in-source')
    if (level !== 'ignore' && strings.length === 0) return ignore(level, 'quote-missing')
    if (rank(level) > rank(candidate.ceiling)) {
      return { level: candidate.ceiling, proposed: level, quotes: [...strings], reasons: ['upgrade-clamped'] }
    }
    return { level, proposed: level, quotes: [...strings], reasons: [] }
  }

  #settle(
    entry: Entry,
    policyVersion: string,
    status: IntakeEvaluationDecision['status'],
    level: IntakeEvaluationLevel,
    proposedLevel: IntakeEvaluationLevel | null,
    quotes: readonly string[],
    reasons: readonly IntakeEvaluationReason[],
  ): IntakeEvaluationDecision {
    const mode = this.#mode() === 'auto' ? 'auto' : 'observe'
    const decision: IntakeEvaluationDecision = Object.freeze({
      candidateId: entry.candidate.candidateId,
      ruleId: entry.candidate.ruleId,
      sourceDigest: entry.candidate.sourceDigest,
      policyVersion,
      mode,
      status,
      level,
      proposedLevel,
      ceiling: entry.candidate.ceiling,
      quotes: Object.freeze([...quotes]),
      reasons: Object.freeze([...reasons]),
      wouldAccept: status === 'decided' && level === 'accept',
      effect: mode === 'auto' && status === 'decided' && level !== 'ignore' ? 'apply' : 'none',
      attempts: entry.attempts,
      decidedAt: this.#now(),
    })
    entry.state = 'decided'
    entry.decision = decision
    return decision
  }

  #requeue(entry: Entry): void {
    entry.state = 'queued'
    entry.decision = undefined
    entry.failures = 0
    entry.nextAt = this.#now()
  }

  #pruneCalls(): void {
    const floor = this.#now() - this.#windowMs
    this.#calls = this.#calls.filter(at => at > floor)
  }
}

function validCandidate(candidate: InferredIntakeCandidate): boolean {
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.candidateId === 'string' && candidate.candidateId.length > 0
    && typeof candidate.ruleId === 'string' && candidate.ruleId.length > 0
    && typeof candidate.sourceText === 'string'
    && typeof candidate.sourceDigest === 'string' && /^[0-9a-f]{64}$/.test(candidate.sourceDigest)
    && isLevel(candidate.ceiling)
}
