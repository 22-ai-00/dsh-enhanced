import type { Context } from '@deepseek-ai/cordis'
import type { OpportunityDecision } from './types.js'
import { PreparationStore, type PreparationRecord, type PreparationResult } from './preparation-store.js'

interface PreparationPort {
  runPreparation(input: { id: string; goalId: string; scope: OpportunityDecision['scope']; sessionId: string; ownerRouteId: string; objective: string; provider: string; model: string; maxOutputTokens: number; timeoutMs: number; budgetId: string; expiresAt: number }, signal: AbortSignal, assertCurrent: () => void): Promise<PreparationResult>
}
interface GoalPort { assertPreparationCurrent(input: OpportunityDecision): void }

export class PreparationRuntime {
  readonly #abort = new AbortController()
  #operation: Promise<void> | undefined
  #wakeTimer: ReturnType<typeof setTimeout> | undefined
  #active: boolean
  #closed = false
  constructor(private readonly ctx: Context, readonly store: PreparationStore, options: { active?: boolean } = {}) {
    this.#active = options.active ?? true
    ctx.effect(() => {
      const unsubEnqueue = this.store.onEnqueue(() => { this.wake() })
      const injectFork = this.ctx.inject(['assistantAutomations', 'assistantGoals'] as never, () => {
        this.wake()
      }) as { dispose?: () => void } | undefined
      this.wake()
      return async () => {
        this.#closed = true
        this.#clearWake()
        unsubEnqueue()
        injectFork?.dispose?.()
        this.#abort.abort()
        // The Automation runner owns cancellation and joins its Agent before returning.
        await this.#operation?.catch(() => {})
        this.store.close()
      }
    }, 'assistant-proactive.preparations')
  }
  setActive(active: boolean): void {
    if (this.#closed) return
    this.#active = active
    if (active) this.wake()
    else this.#clearWake()
  }
  wake(): void {
    if (this.#closed || !this.#active || this.#operation || this.#wakeTimer !== undefined || !this.available()) return
    if (!this.store.hasPending()) return
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = undefined
      void this.tick().catch(() => {})
    }, 0)
    this.#wakeTimer.unref?.()
  }
  #clearWake(): void {
    if (this.#wakeTimer !== undefined) {
      clearTimeout(this.#wakeTimer)
      this.#wakeTimer = undefined
    }
  }
  available(): boolean { const ports = this.#ports(); return typeof ports.automation?.runPreparation === 'function' && typeof ports.goals?.assertPreparationCurrent === 'function' }
  #ports() { return { automation: this.ctx.get('assistantAutomations' as never, false) as PreparationPort | undefined, goals: this.ctx.get('assistantGoals' as never, false) as GoalPort | undefined } }
  current(record: PreparationRecord): void {
    if (this.#closed || this.#abort.signal.aborted) throw new Error('assistant-proactive: preparation disposed')
    const stored = this.store.get(record.id)
    if (stored?.state !== 'running' || stored.token !== record.token || Date.now() >= Math.min(record.decision.expiresAt, record.deadlineAt)) throw new Error('assistant-proactive: preparation authority ended')
    const goals = this.#ports().goals
    if (typeof goals?.assertPreparationCurrent !== 'function') throw new Error('assistant-proactive: preparation goal service unavailable')
    goals.assertPreparationCurrent(record.decision)
  }
  tick(): Promise<void> {
    this.#clearWake()
    if (this.#closed || !this.available()) return Promise.resolve()
    if (this.#operation) return this.#operation
    if (!this.store.hasPending()) return Promise.resolve()
    const operation = this.#run()
    this.#operation = operation
    void operation.finally(() => {
      if (this.#operation === operation) this.#operation = undefined
      if (!this.#closed && this.#active && this.store.hasPending()) this.wake()
    }).catch(() => {})
    return operation
  }
  async #run(): Promise<void> {
    const pending = this.store.pending()[0]
    if (!pending) return
    const record = this.store.claim(pending.id)
    if (!record) return
    try { this.current(record) } catch { this.store.finish(record, 'cancelled', undefined, 'authority-unavailable'); return }
    const auto = this.#ports().automation!
    const decision = record.decision
    try {
      const result = await auto.runPreparation({ id: record.id, goalId: decision.goalId, scope: decision.scope, sessionId: decision.sessionId, ownerRouteId: decision.ownerRouteId,
        objective: decision.objective, ...record.settings, expiresAt: Math.min(decision.expiresAt, record.deadlineAt) }, this.#abort.signal, () => this.current(record))
      try { this.current(record) } catch { this.store.finish(record, 'cancelled', undefined, 'authority-ended'); return }
      if (result.outcome === 'succeeded' && result.quiescent === true && result.output.trim().length > 0 && Buffer.byteLength(result.output) <= 262_144) {
        this.store.finish(record, 'draft', result, 'unverified-draft')
      } else {
        this.store.finish(record, result.quiescent === true ? 'failed' : 'unknown', Buffer.byteLength(result.output) <= 262_144 ? result : undefined, 'generation-not-completed')
      }
    } catch { this.store.finish(record, 'unknown', undefined, 'generation-unconfirmed') }
  }
}
