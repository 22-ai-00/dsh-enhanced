import { createHash, randomUUID } from 'node:crypto'
import type {
  TrustedWorkItemEvaluationClaims,
  TrustedWorkItemEvaluationRegistration,
  WorkItemEvaluationEvidenceState as WorkItemEvaluationEvidenceStateContract,
  WorkItemSettledBy as WorkItemEvaluationSettledByContract,
} from '@dsh-enhanced/assistant-evaluation'
import type { WorkItemStore } from './store.js'
import type {
  WorkItemEvaluationState,
  WorkItemOutcomeRecord,
  WorkItemRecord,
} from './types.js'
import { WorkItemError } from './types.js'

/**
 * Protocol identity of the work-item → Evaluation producer seam.
 *
 * The `assistant-evaluation` plugin validates this exact string on the
 * registration it hands back, so the two plugins agree on a versioned contract
 * without either importing the other's implementation.
 */
export const WORK_ITEM_EVALUATION_PROTOCOL = 'assistant-work-items/evaluation/v1'
/** Stable prefix of every Evaluation idempotency key this producer emits. */
export const WORK_ITEM_EVALUATION_ID_PREFIX = 'work-items'
/** Bounded export attempts per settled revision; the row stays `pending`. */
export const WORK_ITEM_EVALUATION_MAX_ATTEMPTS = 5
/** Bounded exports per drain pass, so a busy ledger cannot starve the host. */
export const WORK_ITEM_EVALUATION_MAX_PER_SWEEP = 10

/**
 * Protocol `assistant-work-items/evaluation/v1` enumerates its `settledBy`
 * values and rejects anything else, and it natively carries
 * `closed-by-thread`: a followed-thread closure is an unverified settlement, and
 * the shared vocabulary says so exactly instead of aliasing it to a window
 * expiry. Adding a local reason without widening the shared enum is what makes
 * such a change a coordinated two-package one.
 */

/** Evidence states an exportable settlement can carry; `pending` is excluded. */
export type WorkItemEvaluationEvidenceState = Exclude<WorkItemEvaluationEvidenceStateContract, 'pending'>
/** Alias of the Evaluation contract's settled-by union. */
export type WorkItemSettledBy = WorkItemEvaluationSettledByContract

/** Exact scope identity handed to Evaluation; never includes owner secrets. */
export type WorkItemEvaluationScope = TrustedWorkItemEvaluationClaims['scope']

/**
 * Durable facts exported for one settled outcome revision.
 *
 * This is the exact claims contract from `assistant-evaluation` (type-only
 * import; there is no runtime dependency on the ledger). The claim type is
 * deliberately incapable of asserting an objective: both status fields are
 * literal `'unknown'` and no execution-status field exists, so a work item can
 * contribute evidence but never grade itself through Evaluation. The
 * Evaluation side re-proves the same invariants at runtime.
 */
export type WorkItemEvaluationClaims = TrustedWorkItemEvaluationClaims

/** Registration an Evaluation producer installs back into this plugin. */
export type WorkItemEvaluationRegistration = TrustedWorkItemEvaluationRegistration

/** Structural producer capability consumed by `assistant-evaluation`. */
export interface WorkItemEvaluationProducer {
  trustedWorkItemProducerGeneration(): string
  registerTrustedWorkItemEvaluationSink(registration: Readonly<WorkItemEvaluationRegistration>): () => void
}

/** Runtime guard; `assistant-evaluation` keeps an equivalent local copy. */
export function isWorkItemEvaluationProducer(value: unknown): value is WorkItemEvaluationProducer {
  return typeof value === 'object' && value !== null
    && typeof (value as Partial<WorkItemEvaluationProducer>).trustedWorkItemProducerGeneration === 'function'
    && typeof (value as Partial<WorkItemEvaluationProducer>).registerTrustedWorkItemEvaluationSink === 'function'
}

/** Stable identity of one settled revision for Evaluation's idempotency check. */
export function workItemEvaluationIdempotencyKey(
  itemId: string,
  revision: number,
  evidenceState: WorkItemEvaluationEvidenceState,
): string {
  return `${WORK_ITEM_EVALUATION_ID_PREFIX}/${itemId}/${String(revision)}/${evidenceState}`
}

/**
 * Situation taxonomy shared by every work item of one admitted kind.
 *
 * Grouping by kind (not by item) keeps downstream learning comparable; the
 * per-item identity lives in the idempotency key and evidence refs instead.
 */
export function workItemEvaluationSituation(kind: string): string {
  return `work-item:${kind}`
}

/** Only durable, independently sourced facts; no model prose reaches Evaluation. */
function metricsFor(item: WorkItemRecord | undefined, outcome: WorkItemOutcomeRecord): Readonly<{ latencyMs?: number; retries?: number }> {
  if (item === undefined) return Object.freeze({})
  const latencyMs = Math.max(0, outcome.settledAt - item.createdAt)
  const retries = Math.max(0, item.attempt - 1)
  return Object.freeze(retries > 0 ? { latencyMs, retries } : { latencyMs })
}

function digestOf(claims: Omit<WorkItemEvaluationClaims, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify([
    claims.scope.workspace,
    claims.scope.preset,
    claims.itemId,
    claims.outcomeRevision,
    claims.settledBy,
    claims.evidenceState,
    claims.situation,
    claims.objectiveStatus,
    claims.deliveryStatus,
    claims.occurredAt,
    claims.idempotencyKey,
    claims.metrics,
  ])).digest('hex')
}

/**
 * Project one store outcome into the exact claims Evaluation accepts.
 *
 * Returns `null` for revisions that are not exportable at all: a window still
 * `pending` can change, so publishing it would contradict a later revision.
 */
export function workItemEvaluationClaims(
  outcome: WorkItemOutcomeRecord,
  scope: WorkItemEvaluationScope,
  item: WorkItemRecord | undefined,
): WorkItemEvaluationClaims | null {
  if (outcome.evidenceState === 'pending') return null
  const evidenceState = outcome.evidenceState
  const base: Omit<WorkItemEvaluationClaims, 'digest'> = {
    scope: Object.freeze({ workspace: scope.workspace, preset: scope.preset }),
    itemId: outcome.itemId,
    outcomeRevision: outcome.revision,
    settledBy: outcome.settledBy,
    evidenceState,
    situation: workItemEvaluationSituation(item?.kind ?? 'work-item'),
    occurredAt: outcome.settledAt,
    idempotencyKey: workItemEvaluationIdempotencyKey(outcome.itemId, outcome.revision, evidenceState),
    metrics: metricsFor(item, outcome),
    objectiveStatus: 'unknown',
    deliveryStatus: 'unknown',
  }
  return Object.freeze({ ...base, digest: digestOf(base) })
}

export interface WorkItemEvaluationExporterOptions {
  /** Lazily resolved so a disabled intake never opens the ledger for export. */
  store: () => WorkItemStore | undefined
  /** Exact scope, or `null` when this deployment has no owner route. */
  scope: () => WorkItemEvaluationScope | null
  /** Export only from an active intake with settlement armed. */
  enabled: () => boolean
  now: () => number
  maxPerSweep?: number
  warn?: (message: string) => void
}

/**
 * Bounded work-item → Evaluation exporter.
 *
 * Evaluation owns the append; this class owns only its own outbox columns. A
 * pass is bounded by `maxPerSweep`, never runs on a timer (it is triggered by
 * registration and by the transaction boundaries that can create a new settled
 * revision), and a failed append leaves the row `pending` with a capped attempt
 * count that health can surface instead of silently dropping evidence.
 */
export class WorkItemEvaluationExporter implements WorkItemEvaluationProducer {
  readonly #options: WorkItemEvaluationExporterOptions
  readonly #generation = randomUUID()
  #registration: WorkItemEvaluationRegistration | undefined
  #draining: Promise<void> | undefined
  #degraded: string | null = null

  constructor(options: WorkItemEvaluationExporterOptions) {
    this.#options = options
  }

  get generation(): string {
    return this.#generation
  }

  get connected(): boolean {
    return this.#registration !== undefined
  }

  get degraded(): string | null {
    return this.#degraded
  }

  /** Capability consumed by `assistant-evaluation`; stable for this instance. */
  trustedWorkItemProducerGeneration(): string {
    return this.#generation
  }

  /**
   * Accept the exact registration Evaluation built for this generation.
   *
   * Exactly one sink may be registered: a second registration is refused so
   * evidence cannot be double-exported under two capabilities, and the returned
   * disposer only clears the registration it owns.
   */
  registerTrustedWorkItemEvaluationSink(registration: Readonly<WorkItemEvaluationRegistration>): () => void {
    if (typeof registration !== 'object' || registration === null || Array.isArray(registration)) {
      fail('invalid-state', 'work-item Evaluation registration is invalid')
    }
    if (registration.protocol !== WORK_ITEM_EVALUATION_PROTOCOL) {
      fail('invalid-state', 'work-item Evaluation registration protocol is mismatched')
    }
    if (registration.generation !== this.#generation) {
      fail('invalid-state', 'work-item Evaluation registration generation is mismatched')
    }
    if (typeof registration.append !== 'function') {
      fail('invalid-state', 'work-item Evaluation registration cannot append')
    }
    const owner = registration.owner
    if (typeof owner !== 'object' || owner === null
      || typeof owner.ownsTrustedWorkItemEvaluationRegistration !== 'function'
      || owner.ownsTrustedWorkItemEvaluationRegistration(registration) !== true) {
      fail('invalid-state', 'work-item Evaluation registration is not owned by its producer host')
    }
    if (this.#registration !== undefined) {
      fail('invalid-state', 'a work-item Evaluation sink is already registered')
    }
    const current = Object.freeze({ ...registration })
    this.#registration = current
    // Registration is itself a boundary that may have missed settlements, so
    // one bounded pass runs immediately; the next transactions keep it fed.
    void this.drain().catch(error => {
      // The registration boundary must not surface a rejection to the producer;
      // the failed pass is already visible through `degraded` health.
      this.#degraded = describe(error)
      this.#options.warn?.(`assistant-work-items: Evaluation export pass failed: ${describe(error)}`)
    })
    return () => {
      if (this.#registration !== current) return
      this.#registration = undefined
      this.#degraded = null
    }
  }

  /** Withdraw any sink on service disposal. */
  dispose(): void {
    this.#registration = undefined
  }

  /**
   * Run bounded export passes serially; a caller never joins a stale pass.
   *
   * A drain that arrives while one is in flight queues exactly one follow-up
   * pass instead of returning the in-flight result: the settlement that
   * prompted the second call may have committed after the first pass read its
   * candidates, and silently joining it would postpone that evidence until the
   * next unrelated transaction.
   *
   * Never rejects: every failure is recorded as degraded health so a caller on
   * a transaction boundary cannot fail because Export is unavailable.
   */
  drain(limit = this.#options.maxPerSweep ?? WORK_ITEM_EVALUATION_MAX_PER_SWEEP): Promise<void> {
    const running = this.#draining
    if (running === undefined) {
      const pass = this.#drainOnce(limit).finally(() => {
        if (this.#draining === pass) this.#draining = undefined
      })
      this.#draining = pass
      return pass
    }
    const follow = running.then(() => this.#drainOnce(limit))
    const tracked = follow.finally(() => {
      if (this.#draining === tracked) this.#draining = undefined
    })
    this.#draining = tracked
    return tracked
  }

  async #drainOnce(limit: number): Promise<void> {
    this.#degraded = null
    if (!this.#options.enabled()) return
    const store = this.#options.store()
    if (store === undefined) return
    const registration = this.#registration
    if (registration === undefined) return
    let candidates: readonly WorkItemOutcomeRecord[]
    try {
      candidates = store.outcomesAwaitingEvaluation(limit, WORK_ITEM_EVALUATION_MAX_ATTEMPTS)
    } catch (error) {
      this.#degraded = describe(error)
      this.#options.warn?.(`assistant-work-items: Evaluation outbox read failed: ${describe(error)}`)
      return
    }
    if (candidates.length === 0) {
      // Nothing sweeps now, but an exhausted row is still a real gap between a
      // settled outcome and the trusted lane; keep it visible in health.
      try {
        if (store.countExhaustedEvaluations(WORK_ITEM_EVALUATION_MAX_ATTEMPTS) > 0) {
          this.#degraded = 'export-attempts-exhausted'
        }
      } catch (error) {
        this.#degraded = describe(error)
      }
      return
    }
    const scope = this.#options.scope()
    if (scope === null) {
      // No exact workspace+preset means no honest Evaluation scope, so the
      // settled revisions are terminally skipped rather than guessed.
      this.#degraded = 'owner-route-unavailable'
      for (const outcome of candidates) {
        try {
          store.markOutcomeSkipped(outcome.itemId, outcome.revision, this.#options.now())
        } catch (error) {
          this.#degraded = describe(error)
        }
      }
      return
    }
    for (const outcome of candidates) {
      if (this.#registration !== registration) return
      let claims: WorkItemEvaluationClaims | null
      try {
        // The item row is read outside the append guard because a store fault
        // here must not reject a pass that other transactions already awaited.
        claims = workItemEvaluationClaims(outcome, scope, store.findItemById(outcome.itemId))
      } catch (error) {
        this.#degraded = describe(error)
        this.#options.warn?.(`assistant-work-items: Evaluation claims read failed: ${describe(error)}`)
        continue
      }
      if (claims === null) continue
      try {
        await registration.append(claims)
      } catch (error) {
        this.#degraded = describe(error)
        this.#options.warn?.(`assistant-work-items: Evaluation export failed: ${describe(error)}`)
        try {
          store.recordOutcomeEvaluationAttempt(outcome.itemId, outcome.revision, WORK_ITEM_EVALUATION_MAX_ATTEMPTS)
        } catch (recordError) {
          this.#degraded = describe(recordError)
        }
        continue
      }
      try {
        store.markOutcomeExported(outcome.itemId, outcome.revision, claims.digest, this.#options.now())
      } catch (error) {
        // The append succeeded, so the row must not be retried; a state race is
        // still reported instead of being erased.
        this.#degraded = describe(error)
        this.#options.warn?.(`assistant-work-items: Evaluation export marker failed: ${describe(error)}`)
      }
    }
  }
}

function fail(code: ConstructorParameters<typeof WorkItemError>[0], message: string): never {
  throw new WorkItemError(code, message)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-exported so tests can assert the exported state machine without a cast. */
export type WorkItemOutcomeEvaluationState = WorkItemEvaluationState
