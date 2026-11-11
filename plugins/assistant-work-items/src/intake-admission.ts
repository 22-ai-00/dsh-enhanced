import { createHash } from 'node:crypto'
import type { NormalizedIntakeAdmit } from './config.ts'
import type { WorkItemIntakeAcceptance, WorkItemIntakeObjective } from './intake.ts'
import type { WorkItemIntakeEvaluationRecord } from './intake-evaluation.ts'
import type { WorkItemStore } from './store.ts'
import type { WorkItemDecisionAdmitResult, WorkItemDecisionRefusal, WorkItemErrorCode, WorkItemExecuteDecision } from './types.ts'
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
  readonly #config: NormalizedIntakeAdmit
  readonly #maxPerRun: number
  readonly #store: () => WorkItemStore | undefined
  readonly #admit: (decision: WorkItemExecuteDecision) => WorkItemDecisionAdmitResult
  readonly #log: (message: string) => void
  readonly #now: () => number
  readonly #hint: ((source: string, sourceEventId: string) => WorkItemIntakeAdmissionHint | undefined) | undefined
  #lastError: string | null = null

  constructor(options: {
    config: NormalizedIntakeAdmit
    maxPerRun: number
    store: () => WorkItemStore | undefined
    admit: (decision: WorkItemExecuteDecision) => WorkItemDecisionAdmitResult
    log: (message: string) => void
    now?: () => number
    /**
     * Producer hint for the objective/acceptance of one candidate. When this
     * option is absent (direct component use), the historical auto behavior is
     * unchanged; the WorkItems service always supplies it, so production auto
     * admission requires an acceptance handle and otherwise records observe.
     */
    hint?: (source: string, sourceEventId: string) => WorkItemIntakeAdmissionHint | undefined
  }) {
    this.#config = options.config
    this.#maxPerRun = options.maxPerRun
    this.#store = options.store
    this.#admit = options.admit
    this.#log = options.log
    this.#now = options.now ?? (() => Date.now())
    this.#hint = options.hint
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

  /** `undefined` leaves the row pending for the next wake (a transient storage failure). */
  #decide(store: WorkItemStore, evaluation: WorkItemIntakeEvaluationRecord): WorkItemIntakeAdmissionRecord | undefined {
    const decisionId = intakeDecisionIdFor(evaluation)
    const key = { source: evaluation.source, sourceEventId: evaluation.sourceEventId, ruleId: evaluation.ruleId, policyVersion: evaluation.policyVersion, decisionId }
    if (this.#config.mode === 'observe') return store.recordIntakeAdmission({ ...key, mode: 'observe', outcome: 'would-admit', reasonCode: null, itemId: null })
    const hint = this.#hint?.(evaluation.source, evaluation.sourceEventId)
    if (this.#hint !== undefined && (hint?.objective === undefined || hint.acceptance === undefined)) {
      // Auto without a real acceptance handle is not allowed to create work. It
      // records the observe row instead, so a later hint cannot retroactively
      // admit this evaluation (the admission ledger is append-only).
      return store.recordIntakeAdmission({ ...key, mode: 'observe', outcome: 'would-admit', reasonCode: null, itemId: null })
    }
    const budget = Math.max(0, this.#config.maxPerHour - store.countIntakeAdmitted(this.#now() - HOUR_MS))
    let result: WorkItemDecisionAdmitResult
    try {
      result = this.#admit(intakeDecisionFor(evaluation, this.#config, budget, hint))
    } catch (error) {
      // A storage fault or a closing service may clear; anything else is a final refusal under its code.
      if (!(error instanceof WorkItemError) || DEFERRED.has(error.code)) { this.#fail(error); return undefined }
      return store.recordIntakeAdmission({ ...key, mode: 'auto', outcome: 'refused', reasonCode: error.code, itemId: null })
    }
    if (result.outcome === 'refused') return store.recordIntakeAdmission({ ...key, mode: 'auto', outcome: 'refused', reasonCode: result.reasonCode, itemId: null })
    // A crash before this write re-runs the same decision id next wake and records `replayed`.
    return store.recordIntakeAdmission({ ...key, mode: 'auto', outcome: result.outcome, reasonCode: null, itemId: result.item.id })
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const repeated = this.#lastError === message
    this.#lastError = message
    if (!repeated) this.#log(`assistant-work-items: intake admission deferred: ${message}`)
  }
}
