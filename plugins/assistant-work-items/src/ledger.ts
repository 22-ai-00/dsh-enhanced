import type { NormalizedLimits } from './config.ts'
import { truncateUtf8 } from './config.ts'
import type { ClaimResult, ReportResult, ReclaimResult, WorkItemStore } from './store.ts'
import type {
  WorkItemClaimRecord,
  WorkItemDispatchRecord,
  WorkItemDeliveryState,
  WorkItemEventRecord,
  WorkItemRecord,
  WorkItemReportRecord,
  WorkItemReportStatus,
  WorkItemState,
} from './types.ts'
import { WorkItemError } from './types.ts'
import type { WorkItemWorkspace } from './workspace.ts'

/** A point-in-time view of one item and everything attached to it. */
export interface WorkItemDetail {
  readonly item: WorkItemRecord
  readonly events: readonly WorkItemEventRecord[]
  readonly claim: WorkItemClaimRecord | undefined
  readonly reports: readonly WorkItemReportRecord[]
  readonly dispatch: WorkItemDispatchRecord | undefined
}

export interface ClaimRequest {
  readonly itemId: string
  readonly runId: string
  readonly occurrenceId: string
}

export interface ReportRequest {
  readonly itemId: string
  readonly runId: string
  readonly status: WorkItemReportStatus
  readonly summary: string
  readonly artifactPaths: readonly string[]
  readonly idempotencyKey: string
}

function fail(code: ConstructorParameters<typeof WorkItemError>[0], message: string, detail?: string): never {
  throw new WorkItemError(code, message, detail)
}

/** The exact summary representation persisted by report and checked on replay. */
export function normalizeWorkItemReportSummary(value: string, maxBytes: number): Readonly<{ summary: string; truncated: boolean }> {
  const summary = value.trim()
  if (summary.length === 0) fail('invalid-input', 'report summary must not be empty')
  const bounded = truncateUtf8(summary, maxBytes)
  return Object.freeze({ summary: bounded.value, truncated: bounded.truncated })
}

/**
 * Lifecycle orchestration on top of the durable store.
 *
 * The ledger owns sequencing and limits (lease, attempt budget, report size,
 * artifact containment) while the store owns atomicity. Nothing here schedules
 * work: every transition is triggered by an admission, a tool call or startup
 * recovery, so the plugin adds no loop or timer to the host.
 */
export class WorkItemLedger {
  readonly #store: WorkItemStore
  readonly #workspace: WorkItemWorkspace
  readonly #limits: NormalizedLimits
  readonly #now: () => number
  readonly #diagnosis: boolean

  constructor(options: {
    store: WorkItemStore
    workspace: WorkItemWorkspace
    limits: NormalizedLimits
    diagnosis?: boolean
    now?: () => number
  }) {
    this.#store = options.store
    this.#workspace = options.workspace
    this.#limits = options.limits
    this.#diagnosis = options.diagnosis ?? false
    this.#now = options.now ?? (() => Date.now())
  }

  get store(): WorkItemStore {
    return this.#store
  }

  get workspace(): WorkItemWorkspace {
    return this.#workspace
  }

  /**
   * Claim one item for one occurrence run.
   *
   * Creates the private scratch directory before the CAS so a worker never sees
   * a claimed item without a place to write. The store decides the conflict.
   */
  claim(request: ClaimRequest): ClaimResult {
    const item = this.#store.findItemById(request.itemId)
    if (item === undefined) {
      const viaOccurrence = this.#store.findItemByOccurrence(request.occurrenceId)
      if (viaOccurrence === undefined) fail('not-found', 'no work item is bound to this run')
      fail('identity-mismatch', 'reported item does not match the dispatched occurrence')
    }
    const directory = this.#workspace.ensureDirectory(item.id)
    if (item.workDir !== directory) {
      // The item was admitted before its directory existed; keep the stored
      // path authoritative and refuse a silently relocated workspace.
      if (!this.#workspace.contains(item.workDir)) fail('storage', 'stored work directory escapes workRoot')
      this.#workspace.ensureDirectory(item.id)
    }
    return this.#store.claim({ itemId: item.id, runId: request.runId, occurrenceId: request.occurrenceId, leaseMs: this.#limits.leaseMs, ...(this.#diagnosis ? { reclaimExpired: false } : {}) })
  }

  /**
   * Park an item whose admission mandate failed revalidation.
   *
   * The item stays open and resumable: no claim is started, no dispatch is
   * retired, and the same item is claimed or woken unchanged once policy allows
   * the identical mandate again.
   */
  parkAuthority(
    item: WorkItemRecord,
    reason: 'authority-revoked' | 'authority-unavailable',
    detail: Readonly<Record<string, unknown>> = {},
  ): WorkItemRecord {
    return this.#store.parkAuthority(item.id, reason, detail, this.#now())
  }

  /** Record a successful revalidation, lifting only this gate's own wait. */
  restoreAuthority(item: WorkItemRecord): WorkItemRecord {
    return this.#store.restoreAuthority(item.id, this.#now())
  }

  /** Mint a fresh wake after a claim-time revalidation denial left no run. */
  rearmAuthority(item: WorkItemRecord): void {
    this.#store.rearmAuthority(item.id)
  }

  /**
   * Append a report revision under the active claim.
   *
   * The summary is truncated to `maxReportBytes` rather than rejected, because
   * a long report is still evidence; artifact paths are validated strictly.
   * Idempotent by `idempotencyKey`, so a retried tool call is safe.
   */
  report(request: ReportRequest): ReportResult {
    const item = this.#store.findItemById(request.itemId)
    if (item === undefined) fail('not-found', 'work item does not exist')
    const claim = this.#store.findClaimByRun(request.runId)
    if (claim === undefined) fail('claim-conflict', 'claim this item before reporting')
    const bounded = normalizeWorkItemReportSummary(request.summary, this.#limits.maxReportBytes)
    const artifacts = this.#workspace.validateArtifacts(item, request.artifactPaths)
    return this.#store.report({
      itemId: item.id,
      runId: request.runId,
      status: request.status,
      summary: bounded.summary,
      truncated: bounded.truncated,
      artifactPaths: artifacts,
      idempotencyKey: request.idempotencyKey,
      maxReports: this.#limits.maxReportsPerItem,
      leaseMs: this.#limits.leaseMs,
      waitingResumeMs: this.#limits.waitingResumeMs,
    })
  }

  /** Record the outcome of one delivery attempt for a report revision. */
  recordDelivery(itemId: string, revision: number, state: WorkItemDeliveryState, deliveryId: string | null): void {
    this.#store.setReportDelivery(itemId, revision, state, deliveryId)
  }

  /** Lazy lease recovery, invoked on startup and every admission/claim. */
  recover(): ReclaimResult {
    if (this.#diagnosis) return Object.freeze({ requeued: Object.freeze([]), blocked: Object.freeze([]) })
    return this.#store.reclaimExpired()
  }

  detail(itemId: string): WorkItemDetail | undefined {
    const item = this.#store.findItemById(itemId)
    if (item === undefined) return undefined
    return Object.freeze({
      item,
      events: this.#store.events(item.id),
      claim: this.#store.activeClaim(item.id),
      reports: this.#store.reports(item.id),
      dispatch: this.#store.getDispatch(item.id),
    })
  }

  list(states?: readonly WorkItemState[], limit?: number): readonly WorkItemRecord[] {
    return this.#store.listItems({ ...(states === undefined ? {} : { states }), ...(limit === undefined ? {} : { limit }) })
  }

  claimedRun(itemId: string, runId: string): WorkItemClaimRecord | undefined {
    const claim = this.#store.findClaimByRun(runId)
    return claim !== undefined && claim.itemId === itemId ? claim : undefined
  }

  now(): number {
    return this.#now()
  }
}
