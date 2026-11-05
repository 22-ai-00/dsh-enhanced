import { createHash } from 'node:crypto'
import type { NormalizedIntakeEvaluation } from './config.ts'
import type { WorkItemIntakeRecord } from './intake.ts'
import {
  INTAKE_EVALUATION_LEVELS,
  InferredIntakeEvaluationQueue,
  type IntakeEvaluationDecision,
  type IntakeEvaluationInspection,
  type IntakeEvaluationLevel,
  type IntakeModelEvaluator,
  type WorkItemIntakeEvaluationRecord,
} from './intake-evaluation.ts'
import type { WorkItemStore } from './store.ts'
import { WorkItemError } from './types.ts'

/**
 * WP20 stage 3: observe-only model evaluation of stored `inferred` intake rows.
 *
 * The ledger stores only a content digest, so the authenticated text exists
 * only on the inbound path. It is held in a bounded in-memory map, never
 * written; persisted results carry quote offsets, not quote text. Evaluation
 * runs on the inbound call (bounded async) and on the existing scheduler wake;
 * this module owns no loop or timer of its own beyond the contract's per-call
 * timeout.
 */

export interface WorkItemIntakeEvaluationRule {
  readonly ruleId: string
  /** Host-computed strongest level this rule allows; the model may only lower it. */
  readonly ceiling: IntakeEvaluationLevel
}

export interface WorkItemIntakeEvaluationPolicy {
  readonly version: string
  readonly rules: readonly WorkItemIntakeEvaluationRule[]
}

/** Host-only injectable supplier: the Policy snapshot and the model call. */
export interface WorkItemIntakeEvaluatorRegistration {
  readonly protocol: 1
  /** Read synchronously at enqueue, dispatch and completion; a changed version re-queues. */
  readonly policy: () => WorkItemIntakeEvaluationPolicy
  readonly evaluate: IntakeModelEvaluator
}

export interface WorkItemIntakeEvaluationHealth extends IntakeEvaluationInspection {
  readonly enabled: true
  readonly registered: boolean
  readonly policyVersion: string | null
  /** Authenticated texts held in memory for (re-)evaluation. */
  readonly heldTexts: number
  /** Inferred rows not queued because the text bound was full of unsettled work. */
  readonly skipped: number
  /** Settled decisions whose store write failed and awaits a backed-off retry. */
  readonly unpersisted: number
  readonly persisted: Readonly<{ decided: number; unavailable: number }>
  readonly lastError: string | null
}

interface HeldText {
  readonly source: string
  readonly sourceEventId: string
  readonly text: string
  readonly digest: string
}

/** A settled decision whose store write failed, with its retry backoff. */
interface UnpersistedDecision {
  readonly decision: IntakeEvaluationDecision
  /** Consecutive failed writes. */
  readonly failures: number
  /** First refresh (by `#refreshes`) that retries the write. */
  readonly retryAt: number
  /** Last failure message; a repeat of it is not logged again. */
  readonly message: string
}

const MAX_RULES = 16
export const MAX_HELD_INTAKE_TEXTS = 256
/** Same bound Delivery applies to the transient inbound text, in UTF-16 code units. */
export const MAX_INTAKE_SOURCE_TEXT = 65_536
const MAX_HELD_TEXTS = MAX_HELD_INTAKE_TEXTS
/** Failed writes back off exponentially in refreshes: 1, 2, 4, … capped at this many. */
const MAX_PERSIST_RETRY_INTERVAL = 64
const POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** `true` when `text` is a bounded string whose SHA-256 is `digest`. */
export function authenticatesIntakeText(text: unknown, digest: string | null | undefined): text is string {
  return typeof text === 'string' && text.length <= MAX_INTAKE_SOURCE_TEXT && typeof digest === 'string' && sha256(text) === digest
}
const candidateIdOf = (source: string, sourceEventId: string) => `${source}:${sourceEventId}`

/** Read and validate one Policy snapshot; anything malformed is `undefined` (nothing is evaluated). */
function readPolicy(registration: WorkItemIntakeEvaluatorRegistration): WorkItemIntakeEvaluationPolicy | undefined {
  try {
    const raw = registration.policy() as unknown as Record<string, unknown> | null
    if (typeof raw !== 'object' || raw === null) return undefined
    const version = raw['version'], rules = raw['rules']
    if (typeof version !== 'string' || !POLICY_ID.test(version) || !Array.isArray(rules) || rules.length > MAX_RULES) return undefined
    const seen = new Set<string>()
    const copy: WorkItemIntakeEvaluationRule[] = []
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i] as Record<string, unknown> | null
      if (typeof rule !== 'object' || rule === null) return undefined
      const ruleId = rule['ruleId'], ceiling = rule['ceiling']
      if (typeof ruleId !== 'string' || !POLICY_ID.test(ruleId) || seen.has(ruleId)) return undefined
      if (typeof ceiling !== 'string' || !(INTAKE_EVALUATION_LEVELS as readonly string[]).includes(ceiling)) return undefined
      seen.add(ruleId)
      copy.push(Object.freeze({ ruleId, ceiling: ceiling as IntakeEvaluationLevel }))
    }
    return Object.freeze({ version, rules: Object.freeze(copy) })
  } catch {
    return undefined
  }
}

export class WorkItemIntakeEvaluationRuntime {
  readonly #config: NormalizedIntakeEvaluation
  readonly #store: () => WorkItemStore | undefined
  readonly #log: (message: string) => void
  readonly #now: () => number
  readonly #setTimer: ((ms: number, callback: () => void) => () => void) | undefined
  readonly #texts = new Map<string, HeldText>()
  /** Held texts already queued under the current Policy version (cleared when it moves). */
  readonly #enqueued = new Set<string>()
  /** Decisions settled in the queue whose store write failed; retried on a refresh backoff. */
  readonly #unpersisted = new Map<string, UnpersistedDecision>()
  /** Refreshes with a readable Policy; the clock for write-retry backoff. */
  #refreshes = 0
  #registration: WorkItemIntakeEvaluatorRegistration | undefined
  #queue: InferredIntakeEvaluationQueue | undefined
  #version: string | undefined
  #skipped = 0
  #lastError: string | null = null
  #closed = false

  constructor(options: {
    config: NormalizedIntakeEvaluation
    store: () => WorkItemStore | undefined
    log: (message: string) => void
    now?: () => number
    setTimer?: (ms: number, callback: () => void) => () => void
  }) {
    this.#config = options.config
    this.#store = options.store
    this.#log = options.log
    this.#now = options.now ?? (() => Date.now())
    this.#setTimer = options.setTimer
  }

  /** One supplier at a time; the returned disposer drops the queue (persisted results stay). */
  register(registration: WorkItemIntakeEvaluatorRegistration): () => void {
    if (this.#closed) throw new WorkItemError('disabled', 'intake evaluation is closed')
    if (registration === null || typeof registration !== 'object' || registration.protocol !== 1
      || typeof registration.policy !== 'function' || typeof registration.evaluate !== 'function') {
      throw new WorkItemError('invalid-input', 'intake evaluator registration is invalid')
    }
    if (this.#registration !== undefined) throw new WorkItemError('invalid-state', 'an intake evaluator is already registered')
    const evaluate = registration.evaluate
    this.#registration = registration
    this.#version = undefined
    this.#queue = new InferredIntakeEvaluationQueue({
      evaluator: request => evaluate(request),
      // An unreadable Policy maps to a version no candidate carries, so nothing runs.
      policyVersion: () => readPolicy(registration)?.version ?? '\0unavailable',
      mode: () => 'observe',
      now: this.#now,
      ...(this.#setTimer === undefined ? {} : { setTimer: this.#setTimer }),
      timeoutMs: this.#config.timeoutMs,
      maxConsecutiveFailures: this.#config.maxConsecutiveFailures,
      maxPerRun: this.#config.maxPerRun,
      budget: { maxCalls: this.#config.maxCallsPerHour, windowMs: 3_600_000 },
      maxPending: MAX_HELD_TEXTS * MAX_RULES,
      maxRetained: MAX_HELD_TEXTS * MAX_RULES,
    })
    let live = true
    return () => {
      if (!live) return
      live = false
      if (this.#registration !== registration) return
      this.#registration = undefined
      this.#queue = undefined
      this.#version = undefined
      // Without a supplier nothing can evaluate the held texts; do not keep bodies around.
      this.#texts.clear()
      this.#enqueued.clear()
      this.#unpersisted.clear()
    }
  }

  /**
   * Inbound path: queue every current rule for one stored `inferred` row whose
   * digest the text matches, then kick one bounded run. Synchronous enqueue,
   * asynchronous evaluation; never throws.
   */
  observe(record: WorkItemIntakeRecord, text: string): void {
    try {
      if (this.#closed || this.#queue === undefined) return
      if (record.decision !== 'stored' || record.strength !== 'inferred') return
      if (!authenticatesIntakeText(text, record.contentDigest)) return
      const id = candidateIdOf(record.source, record.sourceEventId)
      const held: HeldText = Object.freeze({ source: record.source, sourceEventId: record.sourceEventId, text, digest: record.contentDigest! })
      if (!this.#texts.has(id) && !this.#makeRoom()) { this.#skipped++; return }
      this.#texts.delete(id)
      this.#texts.set(id, held)
      // Queues this text (and any held text not yet queued under the current Policy).
      this.#refresh()
      void this.run()
    } catch (error) {
      this.#fail(error)
    }
  }

  /** Scheduler wake or Host drive: re-match on a Policy change, run due items, persist results. */
  async run(): Promise<readonly WorkItemIntakeEvaluationRecord[]> {
    const queue = this.#queue
    if (this.#closed || queue === undefined) return []
    try {
      this.#refresh()
      // Snapshot the texts this run may persist, so an unregister mid-run does not drop its results.
      const texts = new Map(this.#texts)
      const decisions = await queue.runDue()
      const persisted = decisions.flatMap(decision => this.#persist(decision, texts))
      // A Policy change during the run left entries awaiting re-match; queue them now for the next run.
      if (this.#queue === queue) this.#refresh()
      else {
        // Unregistered or replaced mid-run: no refresh of this queue will retry these writes,
        // so drop the ones this run left behind instead of holding their quotes indefinitely.
        for (const decision of decisions) {
          const key = keyOf(decision)
          if (this.#unpersisted.get(key)?.decision === decision) this.#unpersisted.delete(key)
        }
      }
      return Object.freeze(persisted)
    } catch (error) {
      this.#fail(error)
      return []
    }
  }

  health(): WorkItemIntakeEvaluationHealth {
    const empty: IntakeEvaluationInspection = { queued: 0, decided: 0, unavailable: 0, awaitingRematch: 0, callsInWindow: 0, budgetExhausted: false }
    let persisted = { decided: 0, unavailable: 0 }
    try { persisted = { ...(this.#store()?.countIntakeEvaluations() ?? persisted) } } catch { /* reported as zero */ }
    return Object.freeze({
      ...(this.#queue?.inspect() ?? empty),
      enabled: true as const,
      registered: this.#registration !== undefined,
      policyVersion: this.#registration === undefined ? null : readPolicy(this.#registration)?.version ?? null,
      heldTexts: this.#texts.size,
      skipped: this.#skipped,
      unpersisted: this.#unpersisted.size,
      persisted: Object.freeze(persisted),
      lastError: this.#lastError,
    })
  }

  close(): void {
    this.#closed = true
    this.#registration = undefined
    this.#queue = undefined
    this.#texts.clear()
    this.#enqueued.clear()
    this.#unpersisted.clear()
  }

  /**
   * Idempotently queue every held text not yet queued under the current
   * Policy version: a version move re-queues all of them, and a text held
   * while the Policy was unreadable is queued once it is readable again.
   */
  #refresh(): void {
    const registration = this.#registration
    if (registration === undefined) return
    const policy = readPolicy(registration)
    if (policy === undefined) { this.#lastError = 'policy-unavailable'; return }
    if (this.#lastError === 'policy-unavailable') this.#lastError = null
    const refresh = ++this.#refreshes
    for (const entry of this.#unpersisted.values()) if (entry.retryAt <= refresh) this.#persist(entry.decision)
    if (policy.version !== this.#version) { this.#version = policy.version; this.#enqueued.clear() }
    for (const [id, held] of this.#texts) {
      if (!this.#enqueued.has(id) && this.#enqueue(held, policy)) this.#enqueued.add(id)
    }
  }

  /** `false` when the text could not be fully queued and must be retried on the next refresh. */
  #enqueue(held: HeldText, policy: WorkItemIntakeEvaluationPolicy): boolean {
    const queue = this.#queue
    const store = this.#store()
    if (queue === undefined || store === undefined) return false
    const candidateId = candidateIdOf(held.source, held.sourceEventId)
    let complete = true
    for (const rule of policy.rules) {
      const candidate = Object.freeze({
        candidateId, ruleId: rule.ruleId, strength: 'inferred' as const, policyVersion: policy.version,
        sourceText: held.text, sourceDigest: held.digest, ceiling: rule.ceiling,
      })
      const stored = store.getIntakeEvaluation(held.source, held.sourceEventId, rule.ruleId, policy.version)
      // A persisted result re-seeds the queue so the same row and rule is never evaluated twice.
      const result = queue.enqueue(candidate, stored === undefined ? undefined : priorOf(candidateId, stored, held.text))
      if (result.state === 'decided' && !result.decision.reasons.includes('source-unauthenticated')) this.#persist(result.decision)
      else if (result.state === 'rejected') {
        complete = false
        if (result.reason !== 'stale-policy') this.#lastError = `enqueue-${result.reason}`
      }
    }
    return complete
  }

  #persist(decision: IntakeEvaluationDecision, texts: ReadonlyMap<string, HeldText> = this.#texts): WorkItemIntakeEvaluationRecord[] {
    const key = keyOf(decision)
    const held = texts.get(decision.candidateId)
    const store = this.#store()
    if (held === undefined || store === undefined) { this.#unpersisted.delete(key); this.#lastError = 'persist-unavailable'; return [] }
    try {
      const quoteSpans = decision.quotes.map(quote => {
        const start = held.text.indexOf(quote)
        return Object.freeze([start, start + quote.length] as const)
      })
      const { record } = store.recordIntakeEvaluation({
        source: held.source, sourceEventId: held.sourceEventId, ruleId: decision.ruleId, policyVersion: decision.policyVersion,
        sourceDigest: decision.sourceDigest, mode: decision.mode, status: decision.status, level: decision.level,
        proposedLevel: decision.proposedLevel, ceiling: decision.ceiling, quoteSpans, reasons: decision.reasons,
        wouldAccept: decision.wouldAccept, attempts: decision.attempts, decidedAt: Math.trunc(decision.decidedAt),
      })
      this.#unpersisted.delete(key)
      return [record]
    } catch (error) {
      // A transient failure (e.g. SQLITE_BUSY) is retried; a row that exists after all is final.
      // An unreadable check counts as not written, so it never escapes into the caller's run.
      let written = false
      try { written = store.getIntakeEvaluation(held.source, held.sourceEventId, decision.ruleId, decision.policyVersion) !== undefined } catch { /* not written */ }
      const prior = this.#unpersisted.get(key)
      const message = messageOf(error)
      if (written) this.#unpersisted.delete(key)
      else {
        const failures = (prior?.failures ?? 0) + 1
        const retryAt = this.#refreshes + Math.min(2 ** (failures - 1), MAX_PERSIST_RETRY_INTERVAL)
        this.#unpersisted.set(key, Object.freeze({ decision, failures, retryAt, message }))
      }
      this.#fail(error, prior?.message === message)
      return []
    }
  }

  /**
   * Evict the oldest held text whose every current rule already has a
   * persisted row. A decision settled in the queue but not yet written (an
   * in-flight run persists only when it returns) does not count, so its
   * text stays held until the result is on disk.
   */
  #makeRoom(): boolean {
    if (this.#texts.size < MAX_HELD_TEXTS) return true
    const policy = this.#registration === undefined ? undefined : readPolicy(this.#registration)
    const store = this.#store()
    if (policy === undefined || store === undefined) return false
    for (const [id, held] of this.#texts) {
      const persisted = policy.rules.every(rule => store.getIntakeEvaluation(held.source, held.sourceEventId, rule.ruleId, policy.version) !== undefined)
      if (persisted) { this.#texts.delete(id); this.#enqueued.delete(id); return true }
    }
    return false
  }

  /** `repeated` suppresses the log line for a retry that failed with the same message as before. */
  #fail(error: unknown, repeated = false): void {
    this.#lastError = error instanceof WorkItemError ? error.code : 'evaluation-failed'
    if (!repeated) this.#log(`assistant-work-items: intake evaluation failed: ${messageOf(error)}`)
  }
}

const keyOf = (decision: IntakeEvaluationDecision) => `${decision.candidateId}\0${decision.ruleId}\0${decision.policyVersion}`
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Rebuild a persisted result as a queue prior; quote spans are re-read from the held text. */
function priorOf(candidateId: string, record: WorkItemIntakeEvaluationRecord, text: string): IntakeEvaluationDecision {
  return Object.freeze({
    candidateId, ruleId: record.ruleId, sourceDigest: record.sourceDigest, policyVersion: record.policyVersion,
    mode: record.mode, status: record.status, level: record.level, proposedLevel: record.proposedLevel, ceiling: record.ceiling,
    quotes: Object.freeze(record.quoteSpans.map(([start, end]) => text.slice(start, end))),
    reasons: record.reasons, wouldAccept: record.wouldAccept, effect: 'none' as const,
    attempts: record.attempts, decidedAt: record.decidedAt,
  })
}
