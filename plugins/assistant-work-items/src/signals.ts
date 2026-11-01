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

/**
 * A source registration handed to the intake by the Host or by a peer plugin.
 *
 * Registration is the only way an out-of-tree producer joins automatic intake:
 * the intake never imports a concrete peer, and a registered source is read on
 * exactly the same bounded path as the built-in adapter. Budgets default to the
 * configured sweep budget, so a deployment can tune one number for every source.
 */
export interface WorkItemSignalRegistration {
  readonly source: WorkItemSignalSource
  /** Minimum interval between two sweeps of this source. */
  readonly intervalMs?: number | undefined
  readonly maxCandidatesPerSweep?: number | undefined
  readonly maxAdmitsPerSweep?: number | undefined
}

/** One source plus the budgets it sweeps under. */
interface ResolvedSignalSource {
  readonly source: WorkItemSignalSource
  readonly intervalMs: number
  readonly maxCandidatesPerSweep: number
  readonly maxAdmitsPerSweep: number
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
  /** Initial registrations supplied by the Host or a test; more may be added. */
  readonly sources?: readonly WorkItemSignalSource[] | undefined
}

/** Must be a subset of the provenance shape admission accepts (`admission.ts`). */
const SIGNAL_SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/
/** Id of the adapter armed by `sources.foregroundFailures`; a registration may shadow it. */
const BUILT_IN_SOURCE_ID = 'owner-foreground-failures'
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
  /** Insertion-ordered registrations, so reports keep a stable order. */
  readonly #registered = new Map<string, ResolvedSignalSource>()

  constructor(dependencies: SignalIntakeDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => Date.now())
    this.#warn = dependencies.warn ?? (() => {})
    for (const source of dependencies.sources ?? []) this.register({ source })
  }

  /**
   * Add one source and return an idempotent disposer.
   *
   * Registration is refused with `invalid-input` for a duplicate id or a
   * malformed registration; a rejected registration leaves the intake intact.
   */
  register(registration: WorkItemSignalRegistration): () => void {
    const resolved = this.#resolve(registration)
    const id = resolved.source.id
    if (this.#registered.has(id)) {
      throw new WorkItemError('invalid-input', `the signal source ${id} is already registered`)
    }
    this.#registered.set(id, resolved)
    return () => {
      // Only retire this exact registration: a stale disposer from a replaced
      // provider must not unregister a newer one that reuses the id.
      if (this.#registered.get(id) === resolved) this.unregister(id)
    }
  }

  /** Drop one source; `false` when it was never registered. */
  unregister(id: string): boolean {
    return this.#registered.delete(id)
  }

  /** Registered source ids, in sweep order. */
  sources(): readonly string[] {
    return Object.freeze([...this.#registered.keys()])
  }

  /** True when at least one adapter is armed, even if a peer is missing. */
  armed(): boolean {
    if (this.#registered.size > 0) return true
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
        this.#warn(`assistant-work-items: signal source ${source.source.id} failed: ${describe(error)}`)
        reports.push(Object.freeze({
          ...emptyReport(source.source.id, null),
          failed: true,
        }))
      }
    }
    return Object.freeze({ sources: Object.freeze(reports) })
  }

  /**
   * The registered sources, then the built-in adapter when the config arms it.
   *
   * The built-in adapter still resolves `assistant-delivery` lazily and skips
   * itself when that peer is absent, so a late-mounted peer stays a no-op
   * instead of an activation failure. A registration may shadow the built-in
   * adapter by reusing its id.
   */
  #sources(): readonly ResolvedSignalSource[] {
    const resolved: ResolvedSignalSource[] = [...this.#registered.values()]
    const config = this.#deps.config
    if (!config.sources.foregroundFailures.enabled || this.#registered.has(BUILT_IN_SOURCE_ID)) return resolved
    const delivery = this.#deps.delivery?.()
    if (delivery === undefined) return resolved
    resolved.push(Object.freeze({
      source: new OwnerForegroundFailureSource(config, delivery),
      intervalMs: config.sources.foregroundFailures.sweepIntervalMs,
      maxCandidatesPerSweep: config.sources.foregroundFailures.maxCandidatesPerSweep,
      maxAdmitsPerSweep: config.sources.foregroundFailures.maxAdmitsPerSweep,
    }))
    return resolved
  }

  /** Validate one registration; throws `invalid-input` instead of half-applying. */
  #resolve(registration: WorkItemSignalRegistration): ResolvedSignalSource {
    const source = registration?.source as WorkItemSignalSource | undefined
    const id = source?.id
    if (typeof id !== 'string' || !SIGNAL_SOURCE_ID.test(id)) {
      throw new WorkItemError('invalid-input', 'a signal source id must be lower-kebab-case and at most 64 bytes')
    }
    if (typeof source?.sourceVersion !== 'string' || source.sourceVersion.length === 0) {
      throw new WorkItemError('invalid-input', `the signal source ${id} needs a non-empty sourceVersion`)
    }
    if (typeof source?.sweep !== 'function') {
      throw new WorkItemError('invalid-input', `the signal source ${id} needs a sweep function`)
    }
    const defaults = this.#deps.config.sources.foregroundFailures
    const pick = (value: number | undefined, fallback: number, field: string): number => {
      if (value === undefined) return fallback
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new WorkItemError('invalid-input', `the signal source ${id} has an invalid ${field}`)
      }
      return value
    }
    return Object.freeze({
      source,
      intervalMs: pick(registration.intervalMs, defaults.sweepIntervalMs, 'intervalMs'),
      maxCandidatesPerSweep: pick(registration.maxCandidatesPerSweep, defaults.maxCandidatesPerSweep, 'maxCandidatesPerSweep'),
      maxAdmitsPerSweep: pick(registration.maxAdmitsPerSweep, defaults.maxAdmitsPerSweep, 'maxAdmitsPerSweep'),
    })
  }

  #sweepSource(resolved: ResolvedSignalSource, force: boolean): WorkItemSignalSourceReport {
    const config = this.#deps.config
    const store = this.#deps.store
    const now = this.#now()
    const source = resolved.source
    const sweptAtRaw = store.meta(`${SWEPT_KEY_PREFIX}${source.id}`)
    const sweptAt = sweptAtRaw === null ? null : Number(sweptAtRaw)
    if (!force && sweptAt !== null && Number.isFinite(sweptAt) && now - sweptAt < resolved.intervalMs) {
      return emptyReport(source.id, 'not-due')
    }
    // Mark the attempt before it starts: a permanently failing adapter must
    // still be bounded by the interval instead of retrying on every claim.
    store.setMeta(`${SWEPT_KEY_PREFIX}${source.id}`, String(now))

    let result: WorkItemSignalSweep
    try {
      result = source.sweep({
        now,
        limit: resolved.maxCandidatesPerSweep,
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
      if (admitted >= resolved.maxAdmitsPerSweep) {
        // Budget is finite per sweep; the cursor still advances so the next
        // sweep sees a different slice instead of the same head forever.
        break
      }
      if (candidate.provenance?.source !== source.id) {
        // A source may only speak for itself: cross-attribution would let one
        // adapter launder another source's provenance into the ledger.
        rejected += 1
        this.#warn(
          `assistant-work-items: signal source ${source.id} dropped a candidate attributed to ${String(candidate.provenance?.source)}`,
        )
        continue
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
  readonly id = BUILT_IN_SOURCE_ID
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
