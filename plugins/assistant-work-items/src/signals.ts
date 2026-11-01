/**
 * Automatic signal intake.
 *
 * Slice 1 only accepted signals that trusted Host code pushed with `admit()`.
 * This module adds the missing read side: a small, bounded source-adapter
 * boundary plus one concrete adapter over an *already authenticated* in-tree
 * surface, so ordinary owner use produces work items without an operator
 * inventing fixed scenarios.
 *
 * Contracts kept here:
 *
 * - Sources are read-only. A source never writes to delivery/automations; the
 *   only write path stays `WorkItemAdmission` + the existing dispatch path.
 * - No timer. A sweep only runs when the host calls `sweepSignals()` or when a
 *   worker claims an item, and a persisted `sweepIntervalMs` gate bounds it.
 * - Missing optional peers degrade to a no-op report, never to an activation
 *   or claim failure.
 * - Every candidate carries provenance and a canonical key; the ledger's dedup
 *   window plus the settled-item fence in admission decide what becomes work.
 */

import { createHash } from 'node:crypto'
import { isActive } from './config.ts'
import type { NormalizedConfig } from './config.ts'
import type { WorkItemAdmission } from './admission.ts'
import type { WorkItemDispatch } from './dispatch.ts'
import type { PeerDeliveryService, PeerOwnerForegroundTaskSource } from './peers.ts'
import type { WorkItemStore } from './store.ts'
import type { WorkItemAdmitResult, WorkItemProvenance, WorkItemRecord } from './types.ts'
import { WorkItemError } from './types.ts'

/** What one adapter sweep is allowed to spend. */
export interface WorkItemSignalSweepInput {
  readonly now: number
  /** Maximum candidates to scan in this sweep. */
  readonly limit: number
  /** Opaque cursor returned by the previous sweep of this source. */
  readonly cursor: unknown
}

/** One candidate an adapter believes is real, already-authenticated work. */
export interface WorkItemSignalCandidate {
  readonly kind: string
  readonly externalId: string
  readonly title: string
  readonly brief: string
  readonly originBindingId: string
  readonly acceptanceRef?: string
  readonly occurredAt: number
  readonly provenance: WorkItemProvenance
  /**
   * `withdrawn` candidates are observed but never admitted: a cancellation or
   * correction must not create work, and admission's settled fence keeps any
   * earlier item settled.
   */
  readonly disposition: 'failure' | 'timeout' | 'withdrawn'
}

/** The read-only contract every automatic source implements. */
export interface WorkItemSignalSource {
  /** Stable lower-kebab id; also the provenance source name. */
  readonly id: string
  /** Protocol/version of the underlying authenticated surface. */
  readonly sourceVersion: string
  /** Read one bounded page. May throw; the intake contains the error. */
  sweep(input: WorkItemSignalSweepInput): WorkItemSignalSweep
}

export interface WorkItemSignalSweep {
  readonly candidates: readonly WorkItemSignalCandidate[]
  /** Cursor for the next sweep; `undefined` restarts from the oldest signal. */
  readonly cursor: unknown
  /**
   * Set when the source could not run this sweep (`missing-dependency`,
   * `owner-route-unavailable`, `unsupported`). Never an exception.
   */
  readonly degraded?: string
}

export type WorkItemSignalSkip = 'disabled' | 'not-due' | 'degraded'

/** One source's contribution to a sweep, kept small enough to log. */
export interface WorkItemSignalSourceReport {
  readonly source: string
  readonly skipped: WorkItemSignalSkip | null
  readonly degraded: string | null
  readonly scanned: number
  readonly admitted: number
  readonly duplicates: number
  readonly fenced: number
  readonly withdrawn: number
  readonly rejected: number
  readonly failed: boolean
}

export interface WorkItemSignalSweepReport {
  readonly sources: readonly WorkItemSignalSourceReport[]
}

export interface SignalIntakeDependencies {
  readonly config: NormalizedConfig
  readonly store: WorkItemStore
  readonly admission: WorkItemAdmission
  /** Resolved lazily so a late-mounted `assistant-delivery` still works. */
  readonly delivery?: (() => PeerDeliveryService | undefined) | undefined
  readonly dispatch?: WorkItemDispatch | undefined
  readonly now?: (() => number) | undefined
  readonly warn?: ((message: string) => void) | undefined
  /** Host/test supply. Absent sources fall back to the built-in adapter. */
  readonly sources?: readonly WorkItemSignalSource[] | undefined
}

const CURSOR_KEY_PREFIX = 'signal.cursor:'
const SWEPT_KEY_PREFIX = 'signal.sweptAt:'
const REJECTION_CODES = new Set(['cooldown', 'rate-limited', 'capacity', 'kind-rejected', 'source-rejected'])

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function emptyReport(source: string, skipped: WorkItemSignalSkip | null, degraded: string | null = null): WorkItemSignalSourceReport {
  return Object.freeze({
    source,
    skipped,
    degraded,
    scanned: 0,
    admitted: 0,
    duplicates: 0,
    fenced: 0,
    withdrawn: 0,
    rejected: 0,
    failed: false,
  })
}

/**
 * Bounded sweep driver: gate → adapter → admission → persist cursor.
 *
 * The intake owns no timer and no queue. It is intentionally synchronous so it
 * can be called from the worker's claim path without adding a background task.
 */
export class WorkItemSignalIntake {
  readonly #deps: SignalIntakeDependencies
  readonly #now: () => number
  readonly #warn: (message: string) => void

  constructor(dependencies: SignalIntakeDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => Date.now())
    this.#warn = dependencies.warn ?? (() => {})
  }

  /** True when at least one adapter is armed, even if a peer is missing. */
  armed(): boolean {
    const sources = this.#deps.sources
    if (sources !== undefined) return sources.length > 0
    return this.#deps.config.sources.foregroundFailures.enabled
  }

  /**
   * Sweep every armed source once.
   *
   * Never throws: adapter failures are contained per source, and admission
   * rejections are counted as skips. `force` bypasses the persisted interval,
   * which only the explicit host call does.
   */
  sweep(force = false): WorkItemSignalSweepReport {
    const config = this.#deps.config
    if (!config.enabled || !this.armed()) return Object.freeze({ sources: [] })
    const sources = this.#sources()
    const reports: WorkItemSignalSourceReport[] = []
    for (const source of sources) {
      try {
        reports.push(this.#sweepSource(source, force))
      } catch (error) {
        // A programming error in one adapter must not take down a claim.
        this.#warn(`assistant-work-items: signal source ${source.id} failed: ${describe(error)}`)
        reports.push(Object.freeze({
          ...emptyReport(source.id, null),
          failed: true,
        }))
      }
    }
    return Object.freeze({ sources: Object.freeze(reports) })
  }

  #sources(): readonly WorkItemSignalSource[] {
    const supplied = this.#deps.sources
    if (supplied !== undefined) return supplied
    const config = this.#deps.config
    if (!config.sources.foregroundFailures.enabled) return []
    const delivery = this.#deps.delivery?.()
    if (delivery === undefined) return []
    return [new OwnerForegroundFailureSource(config, delivery)]
  }

  #sweepSource(source: WorkItemSignalSource, force: boolean): WorkItemSignalSourceReport {
    const config = this.#deps.config
    const store = this.#deps.store
    const now = this.#now()
    const interval = config.sources.foregroundFailures.sweepIntervalMs
    const sweptAtRaw = store.meta(`${SWEPT_KEY_PREFIX}${source.id}`)
    const sweptAt = sweptAtRaw === null ? null : Number(sweptAtRaw)
    if (!force && sweptAt !== null && Number.isFinite(sweptAt) && now - sweptAt < interval) {
      return emptyReport(source.id, 'not-due')
    }
    // Mark the attempt before it starts: a permanently failing adapter must
    // still be bounded by the interval instead of retrying on every claim.
    store.setMeta(`${SWEPT_KEY_PREFIX}${source.id}`, String(now))

    let result: WorkItemSignalSweep
    try {
      result = source.sweep({
        now,
        limit: config.sources.foregroundFailures.maxCandidatesPerSweep,
        cursor: this.#readCursor(source.id),
      })
    } catch (error) {
      // Cursor epoch/scope changes make delivery reject the old cursor. Reset
      // it so the next sweep restarts at the oldest signal; dedupe makes the
      // overlap harmless.
      store.setMeta(`${CURSOR_KEY_PREFIX}${source.id}`, '')
      this.#warn(`assistant-work-items: signal source ${source.id} sweep failed: ${describe(error)}`)
      return Object.freeze({ ...emptyReport(source.id, null), failed: true })
    }

    if (result.degraded !== undefined) {
      return emptyReport(source.id, 'degraded', result.degraded)
    }

    let scanned = 0
    let admitted = 0
    let duplicates = 0
    let fenced = 0
    let withdrawn = 0
    let rejected = 0
    for (const candidate of result.candidates) {
      scanned += 1
      if (candidate.disposition === 'withdrawn') {
        withdrawn += 1
        continue
      }
      if (admitted >= config.sources.foregroundFailures.maxAdmitsPerSweep) {
        // Budget is finite per sweep; the cursor still advances so the next
        // sweep sees a different slice instead of the same head forever.
        break
      }
      let outcome: WorkItemAdmitResult
      try {
        outcome = this.#deps.admission.admit({
          kind: candidate.kind,
          externalId: candidate.externalId,
          title: candidate.title,
          brief: candidate.brief,
          originBindingId: candidate.originBindingId,
          ...(candidate.acceptanceRef === undefined ? {} : { acceptanceRef: candidate.acceptanceRef }),
          provenance: candidate.provenance,
        })
      } catch (error) {
        if (error instanceof WorkItemError && REJECTION_CODES.has(error.code)) {
          rejected += 1
          continue
        }
        this.#warn(`assistant-work-items: admission of a ${source.id} signal failed: ${describe(error)}`)
        rejected += 1
        continue
      }
      if (!outcome.created) {
        if (outcome.reason === 'fenced') fenced += 1
        else duplicates += 1
        continue
      }
      admitted += 1
      if (isActive(config)) this.#wake(outcome.item)
    }

    this.#writeCursor(source.id, result.cursor)
    return Object.freeze({
      source: source.id,
      skipped: null,
      degraded: null,
      scanned,
      admitted,
      duplicates,
      fenced,
      withdrawn,
      rejected,
      failed: false,
    })
  }

  #wake(item: WorkItemRecord): void {
    const dispatch = this.#deps.dispatch
    if (dispatch === undefined) return
    try {
      dispatch.wake(item)
    } catch (error) {
      this.#warn(`assistant-work-items: worker wake failed: ${describe(error)}`)
    }
  }

  #readCursor(source: string): unknown {
    const raw = this.#deps.store.meta(`${CURSOR_KEY_PREFIX}${source}`)
    if (raw === null || raw === '') return undefined
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  }

  #writeCursor(source: string, cursor: unknown): void {
    if (cursor === undefined || cursor === null) {
      this.#deps.store.setMeta(`${CURSOR_KEY_PREFIX}${source}`, '')
      return
    }
    try {
      this.#deps.store.setMeta(`${CURSOR_KEY_PREFIX}${source}`, JSON.stringify(cursor))
    } catch (error) {
      this.#warn(`assistant-work-items: could not persist the ${source} cursor: ${describe(error)}`)
    }
  }
}

/**
 * Concrete adapter: the owner's own failed/timed-out foreground requests.
 *
 * Evidence (`file:line` at implementation time):
 * - `plugins/assistant-delivery/src/service.ts:5098` declares
 *   `listOwnerForegroundTaskSources`, owner-route authenticated and read-only.
 * - `plugins/assistant-delivery/src/types.ts` defines the source/page protocol
 *   (`assistant-delivery/owner-foreground-source/v1`).
 * - `plugins/assistant-delivery/src/acceptance.ts:20` defines the execution
 *   statuses used here.
 *
 * It only reads: the page already carries authenticated owner identity,
 * canonical digests and a completion cursor. Title/brief are derived from that
 * metadata, never from raw owner text (which is not part of this page).
 */
export class OwnerForegroundFailureSource implements WorkItemSignalSource {
  readonly id = 'owner-foreground-failures'
  readonly sourceVersion = 'assistant-delivery/owner-foreground-source/v1'
  readonly #config: NormalizedConfig
  readonly #delivery: PeerDeliveryService

  constructor(config: NormalizedConfig, delivery: PeerDeliveryService) {
    this.#config = config
    this.#delivery = delivery
  }

  sweep(input: WorkItemSignalSweepInput): WorkItemSignalSweep {
    const list = this.#delivery.listOwnerForegroundTaskSources
    if (list === undefined) return { candidates: [], cursor: input.cursor, degraded: 'unsupported' }
    const scope = this.#config.scope
    if (scope === null) return { candidates: [], cursor: input.cursor, degraded: 'owner-route-unavailable' }
    let receipt
    try {
      receipt = this.#delivery.validateOwnerRoute({
        authorityId: scope.ownerRouteId,
        principalId: scope.principalId,
        workspace: scope.workspace,
        agentPreset: scope.preset,
      })
    } catch {
      return { candidates: [], cursor: input.cursor, degraded: 'owner-route-unavailable' }
    }
    const page = list.call(this.#delivery, {
      authorityId: scope.ownerRouteId,
      principalId: scope.principalId,
      workspace: scope.workspace,
      agentPreset: scope.preset,
      expectedOwner: {
        authorityHash: receipt.authorityHash,
        principalRecordId: receipt.principalRecordId,
        principalVersion: receipt.principalVersion,
      },
      ...(input.cursor === undefined ? {} : { after: input.cursor }),
      limit: input.limit,
    })
    const candidates: WorkItemSignalCandidate[] = []
    for (const source of page.items) {
      const candidate = this.#candidate(source, receipt.authorityHash, input)
      if (candidate !== null) candidates.push(candidate)
    }
    const cursor = page.hasMore ? page.nextCursor : undefined
    return { candidates, cursor }
  }

  #candidate(
    source: PeerOwnerForegroundTaskSource,
    authorityHash: string,
    input: WorkItemSignalSweepInput,
  ): WorkItemSignalCandidate | null {
    const scope = this.#config.scope
    if (scope === null) return null
    // Re-anchor every row to the configured scope and to the receipt we just
    // validated; a page from another owner is discarded, not admitted.
    if (source.scope.workspace !== scope.workspace || source.scope.preset !== scope.preset) return null
    if (source.principalId !== scope.principalId || source.authorityHash !== authorityHash) return null
    const config = this.#config.sources.foregroundFailures
    const status = source.execution.status
    const disposition = status === 'failed'
      ? 'failure'
      : status === 'timed-out'
        ? (config.includeTimedOut ? 'timeout' : null)
        : status === 'cancelled'
          ? 'withdrawn'
          : null
    if (disposition === null) return null
    const completedAt = source.execution.completedAt
    if (typeof completedAt !== 'number' || !Number.isSafeInteger(completedAt) || completedAt <= 0) return null
    const bindingId = source.binding.id
    if (bindingId === '') return null
    // Canonical key over durable, authenticated identities (not the text): the
    // same execution revision maps to the same ledger dedup key forever.
    const canonical = sha256([
      this.id,
      source.inboxId,
      bindingId,
      String(source.binding.version),
      String(source.binding.generation),
      source.execution.executionRef,
      disposition,
    ].join('\u0000'))
    const subject = disposition === 'withdrawn' ? 'cancelled' : disposition === 'timeout' ? 'timed-out' : 'failed'
    const title = `Repair a ${subject} owner request`
    const brief = [
      `The owner's foreground request in inbox ${source.inboxId} finished as ${subject}.`,
      `Completed at ${new Date(completedAt).toISOString()} in workspace ${source.scope.workspace} (binding ${bindingId}, version ${String(source.binding.version)}, generation ${String(source.binding.generation)}).`,
      'Read the delivery history for this inbox and its execution, work out what went wrong or what the owner still needs,',
      'then make the smallest bounded repair you can justify and report exactly what you inspected, changed and could not change.',
      'Never re-send a message, guess the owner intent, or act outside this workspace.',
    ].join(' ')
    return Object.freeze({
      kind: config.kind,
      externalId: `owner-foreground:${canonical}`,
      title,
      brief,
      originBindingId: bindingId,
      occurredAt: completedAt,
      disposition,
      provenance: Object.freeze({
        source: this.id,
        sourceVersion: this.sourceVersion,
        signalDigest: `sha256:${sha256(source.sourceDigest)}`,
        observedAt: input.now,
        evidence: Object.freeze({
          inboxId: source.inboxId,
          executionStatus: status,
          completionSequence: source.completionSequence,
          bindingVersion: source.binding.version,
          completedAt,
        }),
      }),
    })
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
