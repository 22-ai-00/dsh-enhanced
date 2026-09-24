import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/** A channel may answer only its own authenticated scope, otherwise it delegates. */
export type HumanApprovalAnswerer = (
  request: Readonly<ApprovalRequest>,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>

/**
 * Composition inside the native approval waterfall, not another approval store.
 * Risk review stays outermost; owner channels run before the generic Web remote.
 * Registrations must be owned by the channel's Cordis effect. A dispatch snapshots
 * order but checks membership at use time, so an unloaded channel is never called.
 */
export class HumanApprovalRouter {
  readonly #answerers = new Set<HumanApprovalAnswerer>()

  register(answerer: HumanApprovalAnswerer): () => void {
    // A distinct registration wrapper makes independently mounted consumers
    // independent even when they deliberately share a callback function.
    const registration: HumanApprovalAnswerer = (request, next) => answerer(request, next)
    this.#answerers.add(registration)
    return () => { this.#answerers.delete(registration) }
  }

  dispatch(request: Readonly<ApprovalRequest>, fallback: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const queue = [...this.#answerers]
    const next = (): Promise<ApprovalOutcome> => {
      if (request.signal?.aborted) return Promise.resolve('cancelled')
      let answerer: HumanApprovalAnswerer | undefined
      while ((answerer = queue.shift()) !== undefined) {
        if (this.#answerers.has(answerer)) {
          let delegated = false
          const current = answerer
          return Promise.resolve().then(() => !this.#answerers.has(current) ? next() : current(request, () => {
            if (delegated) return Promise.resolve('unavailable')
            delegated = true
            return next()
          })).then(outcome => request.signal?.aborted ? 'cancelled'
            : outcome === 'allowed-once' && !this.#answerers.has(current) ? 'unavailable' : outcome)
        }
      }
      return fallback()
    }
    return next()
  }
}
