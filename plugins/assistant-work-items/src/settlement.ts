/**
 * Bounded, passive outcome settlement.
 *
 * This module is the only place that turns a pending outcome window into an
 * observation or an expiry. It is deliberately *not* a background loop and not
 * a model tool: it is driven by ordinary host activity (`claim()` and an
 * explicit host call), reads the delivery surface the same authenticated way the
 * intake does, and can only ever add a wider revision — never rewrite history,
 * never admit an item, never wake or notify anyone.
 *
 * Bounds, all enforced here:
 * - `sweepIntervalMs` skips repeated passes unless the host forces one;
 * - `maxPendingPerSweep` bounds the candidate windows read from SQLite;
 * - `maxSourcesPerSweep` bounds one delivery page's size (`limit`);
 * - `maxSettlementsPerSweep` bounds every append, observation and expiry alike.
 *
 * Degradation is data, not an exception: a missing peer, a revoked owner route
 * or a throwing page yields a degraded report, still expires the windows that
 * elapsed, and leaves everything else pending for the next pass.
 */
import type { PeerDeliveryService, PeerOwnerRouteReceipt, PeerOwnerForegroundTaskSource } from './peers.ts'
import { matchesOutcomeEvidence, outcomeEvidenceFor } from './outcome.ts'
import type { WorkItemStore } from './store.ts'
import type { WorkItemOutcomeRecord, WorkItemOutcomeEvidenceReason, WorkItemSettlementReport } from './types.ts'

/** Canonical meta keys for the settlement cursors; both survive a restart. */
const SWEPT_AT_META = 'settlement.sweptAt'
const CURSOR_META = 'settlement.cursor'

export interface SettlementScope {
  readonly ownerRouteId: string
  readonly principalId: string
  readonly workspace: string
  readonly preset: string
}

export interface SettlementOptions {
  readonly store: WorkItemStore
  readonly delivery: PeerDeliveryService | undefined
  /** Configured owner scope, or `null` while the owner route is not configured. */
  readonly scope: SettlementScope | null
  readonly sweepIntervalMs: number
  readonly maxSourcesPerSweep: number
  readonly maxPendingPerSweep: number
  readonly maxSettlementsPerSweep: number
  readonly now?: () => number
  readonly warn?: (message: string) => void
}

export interface SettlementResult {
  readonly report: WorkItemSettlementReport
  /** Item ids whose pending window resolved to an observed receipt this pass. */
  readonly observedItemIds: readonly string[]
}

function emptyReport(): WorkItemSettlementReport {
  return Object.freeze({
    skipped: null,
    degraded: null,
    failed: false,
    scanned: 0,
    settled: 0,
    expired: 0,
    observedItemIds: Object.freeze([]),
  })
}

/**
 * One bounded settlement pass.
 *
 * The pending windows are read *before* the delivery surface so a slow or broken
 * peer can never widen the candidate set, and the sweep timestamp advances even
 * on failure so a degraded channel does not busy-retry on every claim.
 */
export function settleOutcomes(options: SettlementOptions, force = false): SettlementResult {
  const now = (options.now ?? (() => Date.now()))()
  const { store } = options
  const since = store.meta(SWEPT_AT_META)
  if (!force && since !== null) {
    const last = Number(since)
    if (Number.isSafeInteger(last) && now - last < options.sweepIntervalMs) {
      return Object.freeze({ report: Object.freeze({ ...emptyReport(), skipped: 'not-due' as const }), observedItemIds: Object.freeze([]) })
    }
  }
  store.setMeta(SWEPT_AT_META, String(now))
  const pending = store.pendingOutcomes(options.maxPendingPerSweep)
  if (pending.length === 0) {
    return Object.freeze({ report: Object.freeze({ ...emptyReport(), skipped: 'no-pending' as const }), observedItemIds: Object.freeze([]) })
  }

  let degraded: WorkItemSettlementReport['degraded'] = null
  let failed = false
  let receipt: PeerOwnerRouteReceipt | undefined
  let sources: readonly PeerOwnerForegroundTaskSource[] = []

  if (options.scope === null || options.delivery === undefined) {
    degraded = 'missing-dependency'
  } else if (options.delivery.listOwnerForegroundTaskSources === undefined) {
    degraded = 'missing-dependency'
  } else {
    try {
      receipt = options.delivery.validateOwnerRoute({
        authorityId: options.scope.ownerRouteId,
        principalId: options.scope.principalId,
        workspace: options.scope.workspace,
        agentPreset: options.scope.preset,
      })
    } catch (error) {
      options.warn?.(`settlement owner route unavailable: ${message(error)}`)
      degraded = 'owner-route-unavailable'
    }
    if (receipt !== undefined && options.scope !== null) {
      const list = options.delivery.listOwnerForegroundTaskSources
      const cursor = readCursor(store)
      try {
        const page = list.call(options.delivery, {
          authorityId: options.scope.ownerRouteId,
          principalId: options.scope.principalId,
          workspace: options.scope.workspace,
          agentPreset: options.scope.preset,
          expectedOwner: {
            authorityHash: receipt.authorityHash,
            principalRecordId: receipt.principalRecordId,
            principalVersion: receipt.principalVersion,
          },
          ...(cursor === undefined ? {} : { after: cursor }),
          limit: options.maxSourcesPerSweep,
        })
        sources = page.items
        // Only a real continuation token is worth persisting; a `hasMore` page
        // without one restarts from the top rather than storing JSON `null`.
        if (page.hasMore && page.nextCursor != null) store.setMeta(CURSOR_META, JSON.stringify(page.nextCursor))
        else store.deleteMeta(CURSOR_META)
      } catch (error) {
        // A transient page failure must not pin the cursor: clearing it lets the
        // next pass start from the top instead of skipping past unseen evidence.
        store.deleteMeta(CURSOR_META)
        options.warn?.(`settlement delivery page failed: ${message(error)}`)
        failed = true
      }
    }
  }

  const byInbox = new Map<string, PeerOwnerForegroundTaskSource>()
  for (const source of sources) {
    const existing = byInbox.get(source.inboxId)
    if (existing === undefined || source.completionSequence > existing.completionSequence) byInbox.set(source.inboxId, source)
  }

  let settled = 0
  let expired = 0
  const observedItemIds: string[] = []
  for (const outcome of pending) {
    if (settled + expired >= options.maxSettlementsPerSweep) break
    const item = store.findItemById(outcome.itemId)
    const source = outcome.inboxId === null ? undefined : byInbox.get(outcome.inboxId)
    if (source !== undefined && item !== undefined && receipt !== undefined && matchesOutcomeEvidence({
      item,
      outcome,
      source,
      authorityHash: receipt.authorityHash,
    })) {
      const derived = outcomeEvidenceFor(source)
      store.settleOutcome({
        itemId: outcome.itemId,
        revision: outcome.revision,
        evidence: derived.evidence,
        reason: derived.reason,
        degraded: false,
        expired: false,
      })
      settled += 1
      observedItemIds.push(outcome.itemId)
      continue
    }
    // The window is still open *at* its deadline; it closes strictly after it,
    // so a sweep that lands exactly on the boundary cannot prematurely expire.
    if (outcome.deadlineAt === null || outcome.deadlineAt >= now) continue
    store.settleOutcome({
      itemId: outcome.itemId,
      revision: outcome.revision,
      evidence: null,
      reason: expiredReason(degraded, failed),
      degraded: degraded !== null || failed,
      expired: true,
    })
    expired += 1
  }

  const observed = Object.freeze(observedItemIds)
  return Object.freeze({
    report: Object.freeze({
      skipped: null,
      degraded,
      failed,
      scanned: pending.length,
      settled,
      expired,
      observedItemIds: observed,
    }),
    observedItemIds: observed,
  })
}

/** Why a window expired: a degraded channel is not the same as a healthy silence. */
function expiredReason(
  degraded: WorkItemSettlementReport['degraded'],
  failed: boolean,
): WorkItemOutcomeEvidenceReason {
  return degraded !== null || failed ? 'channel-unavailable' : 'window-expired'
}

function readCursor(store: WorkItemStore): unknown {
  const raw = store.meta(CURSOR_META)
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    // `null` is never a cursor; treating it as absent keeps `after` unset.
    return parsed === null ? undefined : parsed
  } catch {
    return undefined
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-export the outcome record shape for host-side callers. */
export type { WorkItemOutcomeRecord }
