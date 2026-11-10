import type { ControlPlaneStore } from './store.js'
import type { SourceOwnerInstructionRequest } from './source-job-types.js'

/**
 * Admission performed inside the running service's trust boundary. It must
 * re-validate the owner route (e.g. via Delivery) before enqueueing; the drain
 * never writes source_jobs itself. Throwing rejects or retries the request
 * depending on whether the error is transient.
 */
export type OwnerInstructionAdmit = (
  request: SourceOwnerInstructionRequest,
  assertCurrent: () => void,
) => Promise<{ instructionId: string; jobId: string }>

/** Maps a terminal admission error to a bounded failure code persisted on the row. */
function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('owner instruction request expired')) return 'request-expired'
  if (message.includes('expired')) return 'revision-grant-expired'
  if (message.includes('source-job-registration-rejected')) return 'source-job-registration-rejected'
  if (message.includes('does not match the adopted parent')) return 'parent-mismatch'
  if (message.includes('require source jobs')) return 'drain-unavailable'
  if (message.includes('owner route') || message.includes('validateOwnerRoute')) return 'owner-route-unavailable'
  return 'instruction-admission-rejected'
}

/**
 * Fail-closed transient allowlist: only conditions that a later pass can
 * legitimately outlive return the claim to pending. Anything outside this list
 * is a terminal rejection, so an unexpected error never loops forever. A retried
 * row is still bounded by its own `expires_at`, after which the pending query no
 * longer returns it.
 */
export function isTransientAdmissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true
  const message = error.message
  return message.includes('durable source jobs unavailable')
    || message.includes('another source operation is draining')
    || message.includes('SQLITE_BUSY')
    || message.includes('database is locked')
    || message.includes('source operation is draining')
}

/**
 * A claim is considered orphaned once it has outlived five drain intervals.
 * The single-process service settles every claim in well under a second, so a
 * claim this old can only belong to a process that died before settling.
 */
export const OWNER_INSTRUCTION_CLAIM_TIMEOUT_MS = 300_000

export interface OwnerInstructionDrainResult {
  /** Requests claimed and accepted this pass. */
  accepted: SourceOwnerInstructionRequest[]
  /** Requests terminally rejected this pass, with a bounded failure code. */
  rejected: { request: SourceOwnerInstructionRequest; failureCode: string }[]
  /** Claims returned to pending after a transient failure; retried next pass. */
  retried: SourceOwnerInstructionRequest[]
  /** Orphaned claims from a crashed process that were returned to pending. */
  reclaimed: number
  /** Corrupt pending rows terminally quarantined so they cannot starve the queue. */
  quarantined: number
}

/**
 * Drains pending CLI-written owner-instruction requests. Stale claims left by a
 * process that crashed between the CAS and the settle are requeued first. Each
 * request is then claimed with a store CAS so two ticks can never drain the
 * same row; an admitted request is passed to the trusted `admit` callback and
 * the row is marked accepted, rejected (terminal) or requeued (transient). This
 * is pure orchestration over the store and the injected admission — it has no
 * timers or Cordis access and is unit testable without the full service.
 */
export async function drainOwnerInstructionRequests(input: {
  store: Pick<ControlPlaneStore,
    'readOwnerInstructionDrainBatch' | 'claimOwnerInstructionRequest'
    | 'acceptOwnerInstructionRequest' | 'rejectOwnerInstructionRequest'
    | 'releaseOwnerInstructionRequestClaim' | 'reclaimOrphanedOwnerInstructionRequests'
    | 'getOwnerInstructionRequest' | 'expireOwnerInstructionRequests'>
  admit: OwnerInstructionAdmit
  now: number
  readNow?: () => number
  signal?: AbortSignal
  /** Bounds the number of requests handled in one drain pass. */
  maxPerPass?: number
}): Promise<OwnerInstructionDrainResult> {
  const maxPerPass = input.maxPerPass ?? 16
  const readNow = input.readNow ?? (() => input.now)
  input.signal?.throwIfAborted()
  input.store.expireOwnerInstructionRequests(input.now)
  const reclaimed = input.store.reclaimOrphanedOwnerInstructionRequests(input.now, OWNER_INSTRUCTION_CLAIM_TIMEOUT_MS)
  const { pending, quarantined } = input.store.readOwnerInstructionDrainBatch(input.now, maxPerPass)
  const result: OwnerInstructionDrainResult = { accepted: [], rejected: [], retried: [], reclaimed, quarantined }
  for (const request of pending) {
    input.signal?.throwIfAborted()
    const generation = input.store.claimOwnerInstructionRequest(request.requestId, readNow())
    if (generation === undefined) continue
    const assertCurrent = () => {
      input.signal?.throwIfAborted()
      const current = input.store.getOwnerInstructionRequest(request.requestId)
      if (current?.status !== 'claimed' || current.claimGeneration !== generation) {
        throw new DOMException('owner instruction claim changed', 'AbortError')
      }
      if (current.expiresAt <= readNow()) throw new Error('owner instruction request expired')
    }
    let receipt: Awaited<ReturnType<OwnerInstructionAdmit>>
    try {
      assertCurrent()
      receipt = await input.admit(request, assertCurrent)
      assertCurrent()
    } catch (error) {
      if (input.signal?.aborted || isTransientAdmissionError(error)) {
        if (input.store.releaseOwnerInstructionRequestClaim(request.requestId, generation)) result.retried.push(request)
        input.signal?.throwIfAborted()
      } else {
        const code = failureCode(error)
        if (input.store.rejectOwnerInstructionRequest(request.requestId, generation, code)) {
          result.rejected.push({ request, failureCode: code })
        }
      }
      continue
    }
    // A failure during settlement is not an admission rejection. Leave the
    // claim recoverable so a later occurrence can reconcile the same job.
    if (input.store.acceptOwnerInstructionRequest(request.requestId, generation, receipt)) result.accepted.push(request)
  }
  return result
}
