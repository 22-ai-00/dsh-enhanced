import { createHash } from 'node:crypto'
import type { NormalizedIntakeAdmit } from './config.ts'
import type { WorkItemIntakeAcceptance, WorkItemIntakeObjective } from './intake.ts'
import type { WorkItemIntakeEvaluationRecord } from './intake-evaluation.ts'
import type { WorkItemStore } from './store.ts'
import type { WorkItemDecisionAdmitResult, WorkItemDecisionRefusal, WorkItemErrorCode, WorkItemExecuteDecision, WorkItemIntakeObserveReason } from './types.ts'
import { WorkItemError } from './types.ts'

/**
 * WP21 slice 3: the first caller of `admitDecision`.
 *
 * Reads persisted WP20 evaluation rows (only `inferred` intake is evaluated)
 * whose verdict would accept and that have no admission row yet. In `auto`
 * mode each one becomes one execute decision under a deterministic id; in
 * `observe` mode it is recorded as `would-admit` and nothing is admitted.
 * Every outcome is one append-only row, so a replay or restart never decides
 * the same evaluation twice and a refusal is final (no retry). Runs on the
 * existing scheduler wake; it owns no loop or timer.
 */

/**
 * Producer-supplied objective and optional acceptance handle for one inferred
 * candidate. The bridge only reads it from the bounded in-memory hint; it is
 * never persisted in the intake ledger. Auto admission requires both; without
 * them the pass records the same `would-admit` row an observe deployment does.
 */
export interface WorkItemIntakeAdmissionHint {
  readonly objective: WorkItemIntakeObjective
  readonly acceptance?: WorkItemIntakeAcceptance
  readonly confidencePpm?: number
  readonly utility?: number
}

export type WorkItemIntakeAdmissionOutcome = 'would-admit' | 'admitted' | 'replayed' | 'refused'

export interface WorkItemIntakeAdmissionRecord {
  readonly source: string
  readonly sourceEventId: string
  readonly ruleId: string
  readonly policyVersion: string
  readonly mode: 'observe' | 'auto'
  readonly outcome: WorkItemIntakeAdmissionOutcome
  /** Refusal value or admission error code; set only for `refused`. */
  readonly reasonCode: WorkItemDecisionRefusal | WorkItemErrorCode | null
  readonly decisionId: string
  /** The one item the decision owns; set only for `admitted` and `replayed`. */
  readonly itemId: string | null
  readonly recordedAt: number
}

const HOUR_MS = 3_600_000
/** Error codes that leave the evaluation pending instead of recording a final refusal. */
const DEFERRED: ReadonlySet<WorkItemErrorCode> = new Set(['storage', 'disabled'])
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Stable decision id over the evaluated row, rule and Policy version; never the text. */
export function intakeDecisionIdFor(record: Pick<WorkItemIntakeEvaluationRecord, 'source' | 'sourceEventId' | 'ruleId' | 'policyVersion'>): string {
  return `intake:${sha256(JSON.stringify(['work-items/intake-decision/v1', record.source, record.sourceEventId, record.ruleId, record.policyVersion]))}`
}

/**
 * The execute decision for one accepted evaluation.
 *
 * Without a producer hint the mandate keeps the historical metadata-only brief.
 * The auto bridge only calls this with a hint whose objective and acceptance
 * are both present; the original objective becomes the mandate brief and the
 * verifier handle rides the decision so `admitDecision` can freeze the real
 * contract summary into the item.
 */
export function intakeDecisionFor(record: WorkItemIntakeEvaluationRecord, config: NormalizedIntakeAdmit,
  budgetRemaining: number, hint?: WorkItemIntakeAdmissionHint): WorkItemExecuteDecision {
  const ref = `${record.source}/${record.sourceEventId}/${record.ruleId}@${record.policyVersion}`
  return Object.freeze({
    protocol: 'work-items/execute-decision/v1',
    decisionId: intakeDecisionIdFor(record),
    verdict: 'execute',
    origin: 'inferred',
    mode: 'auto',
    policyRuleId: record.ruleId,
    budgetRemaining,
    mandate: Object.freeze({
      kind: config.kind,
      title: `Intake ${record.source}:${record.sourceEventId}`,
      brief: hint?.objective.text ?? `Inferred intake ${record.source} event ${record.sourceEventId} was accepted by rule ${record.ruleId} under Policy ${record.policyVersion}.`,
      originBindingId: config.originBindingId,
      acceptanceRef: `intake-evaluation:${ref}`,
    }),
    ...(hint?.acceptance === undefined ? {} : { acceptance: hint.acceptance }),
  })
}

export class WorkItemIntakeAdmissionBridge {
  static readonly MAX_OBSERVE_REASONS = 1_024
  readonly #config: NormalizedIntakeAdmit
  readonly #mode: () => 'observe' | 'auto'
  readonly #ruleState: ((ruleId: string) => Readonly<{
    enabled: boolean
    mode?: 'observe' | 'auto'
    confidenceThresholdPpm?: number
    minUtility?: number
  }> | undefined) | undefined
  readonly #maxPerRun: number
  readonly #store: () => WorkItemStore | undefined
  readonly #admit: (decision: WorkItemExecuteDecision) => WorkItemDecisionAdmitResult
  readonly #log: (message: string) => void
  readonly #now: () => number
  readonly #hint: ((source: string, sourceEventId: string) => WorkItemIntakeAdmissionHint | undefined) | undefined
  readonly #onSettled: ((source: string, sourceEventId: string) => void) | undefined
  readonly #observeReasons = new Map<string, WorkItemIntakeObserveReason>()
  #lastError: string | null = null

  constructor(options: {
    config: NormalizedIntakeAdmit
    mode?: () => 'observe' | 'auto'
    ruleState?: (ruleId: string) => Readonly<{
      enabled: boolean
      mode?: 'observe' | 'auto'
      confidenceThresholdPpm?: number
      minUtility?: number
    }> | undefined
    maxPerRun: number
    store: () => WorkItemStore | undefined
    admit: (decision: WorkItemExecuteDecision) => WorkItemDecisionAdmitResult
    log: (message: string) => void
    now?: () => number
    /**
     * Producer hint for the objective/acceptance of one candidate. When this
     * option is absent (direct component use), the historical auto behavior is
     * unchanged; the WorkItems service always supplies it (reading in-memory
     * cache with encrypted SQLite staging fallback on restart), so production
     * auto admission requires an acceptance handle and otherwise records observe.
     */
    hint?: (source: string, sourceEventId: string) => WorkItemIntakeAdmissionHint | undefined
    onSettled?: (source: string, sourceEventId: string) => void
  }) {
    this.#config = options.config
    this.#mode = options.mode ?? (() => this.#config.mode)
    this.#ruleState = options.ruleState
    this.#maxPerRun = options.maxPerRun
    this.#store = options.store
    this.#admit = options.admit
    this.#log = options.log
    this.#now = options.now ?? (() => Date.now())
    this.#hint = options.hint
    this.#onSettled = options.onSettled
  }

  /** One bounded pass over accepting evaluations without an admission row; never throws. */
  run(): readonly WorkItemIntakeAdmissionRecord[] {
    const store = this.#store()
    if (store === undefined) return []
    const written: WorkItemIntakeAdmissionRecord[] = []
    try {
      for (const evaluation of store.pendingIntakeAdmissions(this.#maxPerRun)) {
        const record = this.#decide(store, evaluation)
        if (record !== undefined) written.push(record)
      }
    } catch (error) {
      this.#fail(error)
    }
    return Object.freeze(written)
  }

  lastError(): string | null {
    return this.#lastError
  }

  observeReasonOf(record: Pick<WorkItemIntakeAdmissionRecord, 'source' | 'sourceEventId' | 'ruleId' | 'policyVersion' | 'outcome'>): WorkItemIntakeObserveReason | undefined {
    if (record.outcome !== 'would-admit') return undefined
    const existing = this.#observeReasons.get(this.#reasonKey(record))
    if (existing !== undefined) return existing
    const effectiveMode = this.#ruleState?.(record.ruleId)?.mode ?? this.#mode()
    return effectiveMode === 'observe' ? 'configured-observe' : 'missing-acceptance'
  }

  #reasonKey(record: Pick<WorkItemIntakeAdmissionRecord, 'source' | 'sourceEventId' | 'ruleId' | 'policyVersion'>): string {
    return `${record.source}\u0000${record.sourceEventId}\u0000${record.ruleId}\u0000${record.policyVersion}`
  }

  #rememberObserveReason(record: Pick<WorkItemIntakeAdmissionRecord, 'source' | 'sourceEventId' | 'ruleId' | 'policyVersion'>, reason: WorkItemIntakeObserveReason): void {
    const key = this.#reasonKey(record)
    this.#observeReasons.delete(key)
    this.#observeReasons.set(key, reason)
    while (this.#observeReasons.size > WorkItemIntakeAdmissionBridge.MAX_OBSERVE_REASONS) {
      const oldest = this.#observeReasons.keys().next().value
      if (oldest === undefined) break
      this.#observeReasons.delete(oldest)
    }
  }

  /** `undefined` leaves the row pending for the next wake (a transient storage failure). */
  #decide(store: WorkItemStore, evaluation: WorkItemIntakeEvaluationRecord): WorkItemIntakeAdmissionRecord | undefined {
    const ruleOverride = this.#ruleState?.(evaluation.ruleId)
    if (ruleOverride?.enabled === false) return undefined
    const effectiveMode = ruleOverride?.mode ?? this.#mode()
    const decisionId = intakeDecisionIdFor(evaluation)
    const key = { source: evaluation.source, sourceEventId: evaluation.sourceEventId, ruleId: evaluation.ruleId, policyVersion: evaluation.policyVersion, decisionId }
    if (effectiveMode === 'observe') {
      const written = store.recordIntakeAdmission({ ...key, mode: 'observe', outcome: 'would-admit', reasonCode: null, itemId: null })
      this.#rememberObserveReason(key, 'configured-observe')
      this.#pruneIfSettled(store, evaluation.source, evaluation.sourceEventId)
      return written
    }
    const hint = this.#hint?.(evaluation.source, evaluation.sourceEventId)
    if (ruleOverride !== undefined && hint !== undefined) {
      const belowConfidence = ruleOverride.confidenceThresholdPpm !== undefined
        && hint.confidencePpm !== undefined
        && hint.confidencePpm < ruleOverride.confidenceThresholdPpm
      const belowUtility = ruleOverride.minUtility !== undefined
        && hint.utility !== undefined
        && hint.utility < ruleOverride.minUtility
      if (belowConfidence || belowUtility) {
        const written = store.recordIntakeAdmission({ ...key, mode: 'observe', outcome: 'would-admit', reasonCode: null, itemId: null })
        this.#rememberObserveReason(key, 'configured-observe')
        this.#pruneIfSettled(store, evaluation.source, evaluation.sourceEventId)
        return written
      }
    }
    if (this.#hint !== undefined && (hint?.objective === undefined || hint.acceptance === undefined)) {
      // Auto without both an objective and a real verifier contract handle fails
      // closed to observe; an append-only row guarantees replays never bypass it.
      const reason: WorkItemIntakeObserveReason = hint?.objective === undefined ? 'missing-objective' : 'missing-acceptance'
      const written = store.recordIntakeAdmission({ ...key, mode: 'observe', outcome: 'would-admit', reasonCode: null, itemId: null })
      this.#rememberObserveReason(key, reason)
      this.#pruneIfSettled(store, evaluation.source, evaluation.sourceEventId)
      return written
    }
    const budget = Math.max(0, this.#config.maxPerHour - store.countIntakeAdmitted(this.#now() - HOUR_MS))
    let result: WorkItemDecisionAdmitResult
    try {
      result = this.#admit(intakeDecisionFor(evaluation, this.#config, budget, hint))
    } catch (error) {
      // A storage fault or a closing service may clear; anything else is a final refusal under its code.
      if (!(error instanceof WorkItemError) || DEFERRED.has(error.code)) { this.#fail(error); return undefined }
      const written = store.recordIntakeAdmission({ ...key, mode: 'auto', outcome: 'refused', reasonCode: error.code, itemId: null })
      this.#pruneIfSettled(store, evaluation.source, evaluation.sourceEventId)
      return written
    }
    if (result.outcome === 'refused') {
      const written = store.recordIntakeAdmission({ ...key, mode: 'auto', outcome: 'refused', reasonCode: result.reasonCode, itemId: null })
      this.#pruneIfSettled(store, evaluation.source, evaluation.sourceEventId)
      return written
    }
    // A crash before this write re-runs the same decision id next wake and records `replayed`.
    const written = store.recordIntakeAdmission({ ...key, mode: 'auto', outcome: result.outcome, reasonCode: null, itemId: result.item.id })
    this.#pruneIfSettled(store, evaluation.source, evaluation.sourceEventId)
    return written
  }

  #pruneIfSettled(store: WorkItemStore, source: string, sourceEventId: string): void {
    try {
      if (store.pruneIntakeStagingAfterAdmission(source, sourceEventId)) {
        this.#onSettled?.(source, sourceEventId)
      }
    } catch {
      // Best-effort cleanup; expired/settled staging will also be pruned on wake.
    }
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const repeated = this.#lastError === message
    this.#lastError = message
    if (!repeated) this.#log(`assistant-work-items: intake admission deferred: ${message}`)
  }
}
