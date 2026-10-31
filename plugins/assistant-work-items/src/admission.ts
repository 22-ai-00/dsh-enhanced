import { createHash, randomUUID } from 'node:crypto'
import type { NormalizedConfig } from './config.ts'
import { byteLength, isActive, truncateUtf8 } from './config.ts'
import type { WorkItemLedger } from './ledger.ts'
import type { PeerDeliveryService, PeerOwnerRouteReceipt, PeerPolicyService } from './peers.ts'
import type { WorkItemStore } from './store.ts'
import type {
  WorkItemAdmitInput,
  WorkItemAdmitResult,
  WorkItemDispatchRecord,
  WorkItemOwnerEvidence,
  WorkItemRecord,
} from './types.ts'
import { WorkItemError } from './types.ts'
import type { WorkItemWorkspace } from './workspace.ts'

const KIND = /^[a-z][a-z0-9-]{0,63}$/
const EXTERNAL_ID = /^[\x20-\x7e]{1,256}$/
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/
const HOUR_MS = 3_600_000

function fail(code: ConstructorParameters<typeof WorkItemError>[0], message: string, detail?: string): never {
  throw new WorkItemError(code, message, detail)
}

function text(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') fail('invalid-input', `${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0) fail('invalid-input', `${field} must not be empty`)
  if (byteLength(normalized) > maxBytes) fail('invalid-input', `${field} exceeds ${maxBytes} bytes`)
  return normalized
}

/** Stable per-source dedup identity for one external work signal. */
export function dedupKeyFor(sourceId: string, kind: string, externalId: string): string {
  return createHash('sha256').update(`${sourceId}\u0000${kind}\u0000${externalId}`, 'utf8').digest('hex')
}

export function dedupBucketFor(createdAt: number, windowMs: number): number {
  return Math.floor(createdAt / windowMs)
}

export interface AdmissionDependencies {
  readonly config: NormalizedConfig
  readonly store: WorkItemStore
  readonly ledger: WorkItemLedger
  readonly workspace: WorkItemWorkspace
  readonly policy: PeerPolicyService | undefined
  readonly delivery: PeerDeliveryService | undefined
  readonly now?: () => number
  readonly newId?: () => string
}

/** What an admission would have done, recorded so observe mode is legible. */
export interface AdmissionGateReport {
  readonly wouldReject: readonly string[]
}

/**
 * The only write path for external work signals.
 *
 * Gate order is fixed and cheap-first, and every rejection happens before any
 * durable write: an invalid owner route, a duplicate, an unlisted kind, a
 * cooldown, the hourly rate or the open-item cap all leave the ledger
 * untouched. In `observe` mode the same pipeline still records the item as
 * `dropped`/`observe-only` with `observed = 1`, and never calls automations or
 * delivery.
 */
export class WorkItemAdmission {
  readonly #deps: AdmissionDependencies
  readonly #config: NormalizedConfig
  readonly #now: () => number
  readonly #newId: () => string

  constructor(dependencies: AdmissionDependencies) {
    this.#deps = dependencies
    this.#config = dependencies.config
    this.#now = dependencies.now ?? (() => Date.now())
    this.#newId = dependencies.newId ?? (() => `wi-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
  }

  /**
   * Validate and (maybe) admit one signal.
   *
   * Returns `created: false` with the existing item when the same signal was
   * already admitted inside the dedup window.
   */
  admit(input: WorkItemAdmitInput): WorkItemAdmitResult {
    const config = this.#config
    if (!config.enabled) fail('disabled', 'the work-item intake is disabled')
    const now = this.#now()
    const normalized = this.#normalize(input)
    const receipt = this.#validateOwnerRoute(now)
    const active = isActive(config)

    // Lazy recovery keeps the open-item count honest without a timer.
    this.#deps.ledger.recover()

    const dedupKey = dedupKeyFor(config.intakeSourceId, normalized.kind, normalized.externalId)
    const dedupBucket = dedupBucketFor(now, config.admission.dedupWindowMs)
    const existing = this.#deps.store.findItemByDedup(dedupKey, dedupBucket)
    if (existing !== undefined) {
      const dispatch = this.#deps.store.getDispatch(existing.id)
      if (dispatch === undefined) fail('storage', 'admitted item is missing its dispatch row')
      return Object.freeze({ item: existing, created: false, dispatch })
    }

    const wouldReject = this.#gateReasons(normalized.kind, now)
    if (active) {
      const rejection = wouldReject[0]
      if (rejection !== undefined) fail(rejectionCode(rejection), rejectionMessage(rejection))
      this.#authorize(active, receipt, normalized.kind, dedupKey, dedupBucket)
    }

    const id = this.#newId()
    const directory = this.#deps.workspace.directoryFor(id)
    const truncatedBrief = byteLength(normalized.brief) > config.admission.maxBriefBytes
    const brief = truncatedBrief ? truncateUtf8(normalized.brief, config.admission.maxBriefBytes).value : normalized.brief
    const owner: WorkItemOwnerEvidence = Object.freeze({
      principalRecordId: receipt.principalRecordId,
      principalVersion: receipt.principalVersion,
      workspace: receipt.workspace,
      agentPreset: receipt.agentPreset,
      bindingVersion: receipt.bindingVersion,
      generation: receipt.generation,
    })
    const scope = config.scope
    if (scope === null) fail('owner-route-unavailable', 'active admission requires a configured owner scope')
    const item: WorkItemRecord = Object.freeze({
      id,
      dedupKey,
      dedupBucket,
      sourceId: config.intakeSourceId,
      kind: normalized.kind,
      externalId: normalized.externalId,
      title: normalized.title,
      brief,
      briefTruncated: truncatedBrief,
      originBindingId: normalized.originBindingId,
      acceptanceRef: normalized.acceptanceRef,
      scope,
      owner,
      workerAutomationId: config.workerAutomationId ?? '',
      state: active ? 'queued' : 'dropped',
      stateReason: active ? null : 'observe-only',
      attempt: 0,
      maxAttempts: config.limits.maxAttempts,
      leaseUntil: null,
      leaseRunId: null,
      occurrenceId: null,
      workDir: directory,
      lastReportStatus: null,
      observed: !active,
      createdAt: now,
      updatedAt: now,
    })
    const dispatch: WorkItemDispatchRecord = Object.freeze({
      itemId: id,
      automationId: config.workerAutomationId ?? '',
      eventId: id,
      occurredAt: now,
      state: active ? 'pending' : 'failed',
      occurrenceId: null,
      reason: active ? null : 'observe-only',
      createdAt: now,
      updatedAt: now,
    })
    this.#deps.store.admitItem(
      item,
      {
        kind: active ? 'admitted' : 'observed',
        actor: 'admission',
        detail: active ? { kind: normalized.kind, dedupBucket } : { kind: normalized.kind, dedupBucket, wouldReject },
      },
      dispatch,
    )
    return Object.freeze({ item, created: true, dispatch })
  }

  /** Gates that would reject this kind right now; empty when it may proceed. */
  #gateReasons(kind: string, now: number): readonly string[] {
    const config = this.#config
    const reasons: string[] = []
    if (!config.admission.allowedKinds.includes(kind)) reasons.push('kind-rejected')
    const lastSameKind = this.#deps.store.lastAdmitAt(kind)
    if (lastSameKind !== null && now - lastSameKind < config.admission.cooldownMs) reasons.push('cooldown')
    if (this.#deps.store.countItemsSince(now - HOUR_MS) >= config.admission.maxAdmitsPerHour) reasons.push('rate-limited')
    if (this.#deps.store.countOpenItems() >= config.admission.maxOpenItems) reasons.push('capacity')
    return Object.freeze(reasons)
  }

  #authorize(active: boolean, receipt: PeerOwnerRouteReceipt, kind: string, dedupKey: string, dedupBucket: number): void {
    if (!active) return
    const policy = this.#deps.policy
    if (policy === undefined) fail('missing-dependency', 'assistantPolicy is required for active admission')
    const scope = this.#config.scope
    if (scope === null) fail('owner-route-unavailable', 'active admission requires a configured owner scope')
    const decision = policy.authorize({
      subject: {
        kind: 'background',
        id: this.#config.intakeSourceId,
        workspace: receipt.workspace,
        principal: receipt.principalId,
      },
      action: 'admit',
      resource: { kind: 'automation', id: this.#config.workerAutomationId ?? '' },
      context: { initiator: 'background' },
    }, { idempotencyKey: `work-item-admit:${dedupKey}:${String(dedupBucket)}` })
    if (decision.effect !== 'allow') {
      fail('source-rejected', `policy denied admission (${decision.reasonCode})`, kind)
    }
  }

  /** Re-anchor the configured owner scope against the live delivery route. */
  #validateOwnerRoute(now: number): PeerOwnerRouteReceipt {
    const scope = this.#config.scope
    if (scope === null) fail('owner-route-unavailable', 'no owner scope is configured')
    if (scope.expiresAt <= now) fail('owner-route-expired', 'the configured owner scope expired')
    const delivery = this.#deps.delivery
    if (delivery === undefined) fail('owner-route-unavailable', 'assistantDelivery is required to validate the owner route')
    let receipt: Readonly<PeerOwnerRouteReceipt>
    try {
      receipt = delivery.validateOwnerRoute({
        authorityId: scope.ownerRouteId,
        principalId: scope.principalId,
        workspace: scope.workspace,
        agentPreset: scope.preset,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const code = error !== null && typeof error === 'object' && 'code' in error && error.code === 'missing-binding'
        ? 'owner-route-invalid'
        : 'owner-route-unavailable'
      fail(code, 'owner route validation failed', detail)
    }
    if (receipt.receiptVersion !== 2) fail('owner-route-invalid', 'owner route receipt has an unsupported version')
    if (receipt.authorityId !== scope.ownerRouteId || receipt.workspace !== scope.workspace
      || receipt.agentPreset !== scope.preset || receipt.principalId !== scope.principalId) {
      fail('owner-route-invalid', 'owner route receipt does not match the configured scope')
    }
    if (receipt.principalRecordId === '' || !Number.isSafeInteger(receipt.principalVersion)) {
      fail('owner-route-invalid', 'owner route receipt is missing its durable principal identity')
    }
    return receipt
  }

  #normalize(input: WorkItemAdmitInput): {
    kind: string
    externalId: string
    title: string
    brief: string
    originBindingId: string
    acceptanceRef: string | null
  } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid-input', 'admission input must be an object')
    const allowed = ['kind', 'externalId', 'title', 'brief', 'originBindingId', 'acceptanceRef'] as const
    for (const key of Object.keys(input)) {
      if (!(allowed as readonly string[]).includes(key)) fail('invalid-input', `admission input contains unknown field ${key}`)
    }
    const kind = text(input.kind, 'kind', 64)
    if (!KIND.test(kind)) fail('kind-rejected', 'kind has an invalid shape')
    const externalId = text(input.externalId, 'externalId', 256)
    if (!EXTERNAL_ID.test(externalId) || externalId.includes('\u0000')) fail('invalid-input', 'externalId has an invalid shape')
    const title = text(input.title, 'title', 512)
    const brief = text(input.brief, 'brief', Math.min(this.#config.admission.maxBriefBytes * 4, 262_144))
    const originBindingId = text(input.originBindingId, 'originBindingId', 256)
    if (!BINDING_ID.test(originBindingId)) fail('invalid-input', 'originBindingId has an invalid shape')
    const acceptanceRef = input.acceptanceRef === undefined ? null : text(input.acceptanceRef, 'acceptanceRef', 1_024)
    return { kind, externalId, title, brief, originBindingId, acceptanceRef }
  }
}

function rejectionCode(reason: string): ConstructorParameters<typeof WorkItemError>[0] {
  switch (reason) {
    case 'kind-rejected': return 'kind-rejected'
    case 'cooldown': return 'cooldown'
    case 'rate-limited': return 'rate-limited'
    case 'capacity': return 'capacity'
    default: return 'invalid-input'
  }
}

function rejectionMessage(reason: string): string {
  switch (reason) {
    case 'kind-rejected': return 'this work-item kind is not admitted'
    case 'cooldown': return 'this work-item kind is inside its admission cooldown'
    case 'rate-limited': return 'the hourly admission rate is exhausted'
    case 'capacity': return 'the open work-item cap is reached'
    default: return 'admission rejected the signal'
  }
}
