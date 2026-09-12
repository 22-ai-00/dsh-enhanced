import type { SkillRepairContinuation, SkillRepairState } from './store.js'
import { SkillStore } from './store.js'

export interface RepairRuntimePorts {
  inspectTrigger(record: SkillRepairContinuation, signal: AbortSignal): Promise<unknown | undefined>
  createRepair(record: SkillRepairContinuation, evidence: unknown, signal: AbortSignal): Promise<{ sessionId: string; goalId: string }>
  inspectRepair(record: SkillRepairContinuation, signal: AbortSignal): Promise<'running' | 'achieved' | 'rejected'>
  capture(record: SkillRepairContinuation, signal: AbortSignal): Promise<{ candidateId: string }>
  compare(record: SkillRepairContinuation, signal: AbortSignal): Promise<{ deploymentId: string }>
  inspectDeployment(record: SkillRepairContinuation, signal: AbortSignal): Promise<'watching' | 'complete' | 'rejected'>
  assertCurrent(record: SkillRepairContinuation): void
}

const uncertain = new Set<SkillRepairState>(['creating-repair', 'capturing', 'comparing'])
const terminal = new Set<SkillRepairState>(['complete', 'rejected', 'revoked', 'expired', 'unknown'])
const checkpoint = (record: SkillRepairContinuation, extra: Record<string, unknown>) => ({ ...record.checkpoint, ...extra })
const validRepair = (value: unknown): value is { sessionId: string; goalId: string } => !!value && typeof value === 'object'
  && typeof (value as { sessionId?: unknown }).sessionId === 'string' && typeof (value as { goalId?: unknown }).goalId === 'string'
  && (value as { sessionId: string }).sessionId.length > 0 && (value as { goalId: string }).goalId.length > 0
function validId(value: unknown, key: 'candidateId' | 'deploymentId'): value is Record<typeof key, string> {
  const id = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return typeof id === 'string' && id.length > 0
}

/**
 * Host-owned finite continuation driver. It never creates a new iteration;
 * callers must validate durable lineage before using SkillStore.nextRepairIteration.
 */
export class RepairContinuationRuntime {
  readonly #lifecycle = new AbortController()
  readonly #inflight = new Map<string, Promise<SkillRepairContinuation>>()
  #disposed = false
  #tickAll: Promise<readonly SkillRepairContinuation[]> | undefined
  #disposing: Promise<void> | undefined

  constructor(readonly store: SkillStore, readonly ports: RepairRuntimePorts) {}

  recover(scope: object, id: string): SkillRepairContinuation | undefined {
    const record = this.store.getRepairContinuation(scope, id)
    // Recovery never races a local dispatcher and never mutates after disposal.
    if (this.#disposed || this.#inflight.has(id)) return record
    if (!record || !uncertain.has(record.state)) return record
    return this.store.transitionRepairContinuation(scope, record.id, record.revision, 'unknown', checkpoint(record, { recovery: 'uncertain-dispatch' }))
  }

  tick(scope: object, id: string): Promise<SkillRepairContinuation> {
    if (this.#disposed) return Promise.reject(new Error('assistant-skills: repair runtime disposed'))
    const existing = this.#inflight.get(id)
    if (existing) return existing
    const task = this.#tick(scope, id).finally(() => this.#inflight.delete(id))
    this.#inflight.set(id, task)
    return task
  }

  tickAll(): Promise<readonly SkillRepairContinuation[]> {
    if (this.#disposed) throw new Error('assistant-skills: repair runtime disposed')
    return this.#tickAll ??= this.#tickAllRun().finally(() => { this.#tickAll = undefined })
  }
  async #tickAllRun(): Promise<readonly SkillRepairContinuation[]> {
    const records = this.store.listRepairContinuations().filter(record => !terminal.has(record.state))
    const results: SkillRepairContinuation[] = []
    const errors: unknown[] = []
    // Store authorization limits iterations to four; process only four owned
    // tasks at once so a Host restart cannot fan out unbounded work.
    for (let start = 0; start < records.length; start += 4) {
      const settled = await Promise.allSettled(records.slice(start, start + 4).map(record => this.tick(record.scope, record.id)))
      for (const result of settled) {
        if (result.status === 'fulfilled') results.push(result.value)
        else errors.push(result.reason)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'assistant-skills: repair continuation tick failed')
    return results
  }

  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing
    this.#disposed = true; this.#lifecycle.abort()
    return this.#disposing = Promise.allSettled(this.#inflight.values()).then(() => undefined)
  }

  #current(record: SkillRepairContinuation, signal: AbortSignal): void {
    signal.throwIfAborted(); this.#lifecycle.signal.throwIfAborted()
    if (record.authorization.expiresAt <= Date.now()) throw new Error('assistant-skills: repair continuation expired')
    this.ports.assertCurrent(record)
  }
  #transition(record: SkillRepairContinuation, state: SkillRepairState, extra: Record<string, unknown>): SkillRepairContinuation {
    return this.store.transitionRepairContinuation(record.scope, record.id, record.revision, state, checkpoint(record, extra))
  }
  #ended(record: SkillRepairContinuation, state: 'rejected' | 'unknown' | 'expired', reason: string): SkillRepairContinuation {
    return this.#transition(record, state, { failure: reason })
  }
  async #dispatch<T>(record: SkillRepairContinuation, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    this.#current(record, signal)
    const value = await action()
    this.#current(record, signal)
    return value
  }
  async #tick(scope: object, id: string): Promise<SkillRepairContinuation> {
    let record = this.store.getRepairContinuation(scope, id)
    if (!record) throw new Error('assistant-skills: repair continuation missing')
    if (terminal.has(record.state)) return record
    const signal = AbortSignal.any([this.#lifecycle.signal])
    try {
      this.#current(record, signal)
      switch (record.state) {
        case 'armed': {
          const evidence = await this.#dispatch(record, signal, () => this.ports.inspectTrigger(record!, signal))
          if (evidence === undefined) return record
          return this.#transition(record, 'source-confirmed', { trigger: evidence })
        }
        case 'source-confirmed': {
          record = this.#transition(record, 'creating-repair', {}) // checkpoint before external creation
          const repair = await this.#dispatch(record, signal, () => this.ports.createRepair(record!, record!.checkpoint.trigger, signal))
          if (!validRepair(repair)) throw new Error('assistant-skills: repair creation response invalid')
          return this.#transition(record, 'repairing', { repair })
        }
        case 'repairing': {
          const status = await this.#dispatch(record, signal, () => this.ports.inspectRepair(record!, signal))
          if (status === 'running') return record
          return status === 'achieved' ? this.#transition(record, 'repair-achieved', {}) : this.#ended(record, 'rejected', 'repair-rejected')
        }
        case 'repair-achieved': {
          record = this.#transition(record, 'capturing', {}) // checkpoint before candidate capture
          const captured = await this.#dispatch(record, signal, () => this.ports.capture(record!, signal))
          if (!validId(captured, 'candidateId')) throw new Error('assistant-skills: repair capture response invalid')
          return this.#transition(record, 'candidate-staged', { candidateId: captured.candidateId })
        }
        case 'candidate-staged': {
          record = this.#transition(record, 'comparing', {}) // checkpoint before canary dispatch
          const compared = await this.#dispatch(record, signal, () => this.ports.compare(record!, signal))
          if (!validId(compared, 'deploymentId')) throw new Error('assistant-skills: repair comparison response invalid')
          return this.#transition(record, 'watching', { deploymentId: compared.deploymentId })
        }
        case 'watching': {
          const status = await this.#dispatch(record, signal, () => this.ports.inspectDeployment(record!, signal))
          if (status === 'watching') return record
          return status === 'complete' ? this.#transition(record, 'complete', {}) : this.#ended(record, 'rejected', 'deployment-rejected')
        }
        default: return record
      }
    } catch (error) {
      // A revoke/expiry/revision replacement during an await owns the record.
      // Never overwrite it or advance a late candidate/deployment result.
      const current = this.store.getRepairContinuation(scope, id)
      if (!current || terminal.has(current.state) || current.revision !== record.revision) throw error
      const expired = current.authorization.expiresAt <= Date.now()
      // Work that was checkpointed as dispatched is uncertain; failures before
      // a dispatch are a rejection of the finite authority.
      this.#ended(current, expired ? 'expired' : uncertain.has(current.state) ? 'unknown' : 'rejected', expired ? 'expired' : uncertain.has(current.state) ? 'dispatch-uncertain' : 'authority-or-port-failed')
      throw error
    }
  }
}
