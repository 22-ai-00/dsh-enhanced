import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  acceptanceCanonicalJson, acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt,
} from '@dsh-enhanced/task-acceptance-contract'
import type { CriterionResult, TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { Config, compileAcceptanceProfiles } from './config.js'
import { verifyAcceptanceCriteria } from './drivers.js'
import type { AcceptanceHandle, AcceptanceTask, TaskAcceptanceProducer, TaskAcceptanceRegistration, VerifierEvaluationRegistration } from './host.js'
import { AcceptanceStore } from './store.js'

export { Config } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context { assistantVerifier: AssistantVerifierService }
}

const producerNames = ['assistantAutomations', 'assistantDelivery'] as const
type ProducerName = typeof producerNames[number]
interface Binding { producer: TaskAcceptanceProducer; generation: string; dispose(): void }

function isProducer(value: unknown): value is TaskAcceptanceProducer {
  const item = value as Partial<TaskAcceptanceProducer> | null
  return item !== null && typeof item === 'object'
    && typeof item.trustedAcceptanceProducerGeneration === 'function'
    && typeof item.registerTaskAcceptanceSink === 'function'
    && typeof item.inspectAcceptedExecution === 'function'
}

/** Host-only verification. There is intentionally no model trusted-write tool. */
export class AssistantVerifierService extends Service<Config> {
  static Config = Config
  readonly #store: AcceptanceStore
  readonly #compiled: ReturnType<typeof compileAcceptanceProfiles>
  readonly #bindings = new Map<ProducerName, Binding>()
  readonly #registrations = new WeakSet<object>()
  readonly #generation = randomUUID()
  readonly #workerId = `verifier-${randomUUID()}`
  readonly #controller = new AbortController()
  readonly #now: () => number
  readonly #requireAcceptance: boolean
  #evaluation: VerifierEvaluationRegistration | undefined
  #running: Promise<void> | undefined
  #awaitingCursor = ''
  #outboxCursor = ''
  #active = true

  constructor(ctx: Context, config: Config, options: { now?: () => number } = {}) {
    super(ctx, 'assistantVerifier')
    const normalized = Config(config)
    this.#compiled = compileAcceptanceProfiles(normalized)
    this.#now = options.now ?? Date.now
    this.#requireAcceptance = normalized.requireAcceptance ?? false
    this.#store = new AcceptanceStore(normalized.databasePath)
    for (const name of producerNames) {
      const current = ctx.get(name as never) as unknown
      if (isProducer(current)) this.#bind(name, current)
      ctx.inject([name as never], injected => {
        const producer = injected.get(name as never) as unknown
        if (isProducer(producer)) return this.#bind(name, producer)
      })
    }
    const interval = normalized.tickIntervalMs ?? 5_000
    const timer = interval === 0 ? undefined : setInterval(() => { void this.tick().catch(error => {
      ctx.logger.warn('assistant-verifier reconciliation failed: %s', error instanceof Error ? error.message : 'unknown')
    }) }, interval)
    timer?.unref?.()
    ctx.effect(() => async () => {
      this.#active = false
      this.#controller.abort(new Error('assistant-verifier disposed'))
      if (timer !== undefined) clearInterval(timer)
      for (const binding of this.#bindings.values()) binding.dispose()
      this.#evaluation = undefined
      await this.#running?.catch(() => {})
      this.#store.close()
    }, 'assistant-verifier.database')
  }

  ownsTaskAcceptanceRegistration = (registration: TaskAcceptanceRegistration): boolean => {
    return this.#active && this.#registrations.has(registration)
  }

  trustedVerificationProducerGeneration = (): string => { this.#assertActive(); return this.#generation }

  registerTrustedVerifierEvaluationSink = (registration: VerifierEvaluationRegistration): (() => void) => {
    this.#assertActive()
    const evaluation = this.ctx.get('assistantEvaluation' as never, false) as unknown as
      { ownsTrustedVerifierEvaluationRegistration?(value: VerifierEvaluationRegistration): boolean } | undefined
    if (registration.protocol !== 'assistant-verifier/evaluation/v1' || registration.generation !== this.#generation
      || typeof registration.append !== 'function'
      || typeof evaluation?.ownsTrustedVerifierEvaluationRegistration !== 'function'
      || evaluation.ownsTrustedVerifierEvaluationRegistration(registration) !== true
      || this.#evaluation !== undefined) throw new Error('assistant-verifier: invalid Evaluation registration')
    this.#evaluation = registration
    return () => { if (this.#evaluation === registration) this.#evaluation = undefined }
  }

  /** Inspection contains explicit pending work; an execution completion is not a success verdict. */
  inspect = (contractId: string) => { this.#assertActive(); return this.#store.getState(contractId) }

  continuations = () => { this.#assertActive(); return this.#store.listAttention() }

  health = () => {
    this.#assertActive()
    return Object.freeze({ ready: true, profiles: this.#compiled.profiles.length,
      requireAcceptance: this.#requireAcceptance,
      hostProducers: Object.freeze([...this.#bindings.keys()].sort()),
      evaluationConnected: this.#evaluation !== undefined,
      ...this.#store.counts(this.#now()) })
  }

  tick = (): Promise<void> => {
    this.#assertActive()
    if (this.#running !== undefined) return this.#running
    const promise = this.#tick()
    this.#running = promise
    void promise.finally(() => { if (this.#running === promise) this.#running = undefined }).catch(() => {})
    return promise
  }

  #bind(name: ProducerName, producer: TaskAcceptanceProducer): () => void {
    const generation = producer.trustedAcceptanceProducerGeneration()
    const prior = this.#bindings.get(name)
    if (prior?.generation === generation) return prior.dispose
    if (typeof generation !== 'string' || generation.length < 1 || generation.length > 256) throw new Error('assistant-verifier: invalid Host generation')
    let live = true
    const handles = new WeakMap<object, TaskAcceptanceContract>()
    const current = () => {
      this.#assertActive()
      if (!live || this.#bindings.get(name)?.producer !== producer
        || this.#bindings.get(name)?.generation !== generation
        || producer.trustedAcceptanceProducerGeneration() !== generation) throw new Error('assistant-verifier: stale Host registration')
    }
    const registration: TaskAcceptanceRegistration = Object.freeze({
      protocol: 'assistant-verifier/host-producer/v1', generation, owner: this, requiresAcceptance: this.#requireAcceptance,
      prepare: (input: AcceptanceTask): AcceptanceHandle | null => {
        current()
        if ((name === 'assistantAutomations') !== (input.task.kind === 'automation-run')) throw new Error('assistant-verifier: wrong Host task kind')
        const accepted = this.#prepare(input)
        if (accepted === null) return null
        const handle = Object.freeze({ contractId: accepted.id, contractDigest: accepted.digest })
        handles.set(handle, accepted)
        return handle
      },
      completed: async (handle: AcceptanceHandle): Promise<void> => {
        current()
        const contract = handles.get(handle)
        if (contract === undefined) throw new Error('assistant-verifier: foreign acceptance handle')
        await this.#reconcileExecution(name, binding, contract)
      },
    })
    this.#registrations.add(registration)
    let detach: (() => void) | undefined
    const binding: Binding = { producer, generation, dispose: () => {
      live = false; this.#registrations.delete(registration)
      if (this.#bindings.get(name) === binding) this.#bindings.delete(name)
      detach?.()
    } }
    this.#bindings.set(name, binding)
    try {
      detach = producer.registerTaskAcceptanceSink(registration)
      if (typeof detach !== 'function') throw new Error('assistant-verifier: Host registration lacks disposer')
    } catch (error) {
      binding.dispose()
      if (prior !== undefined) this.#bindings.set(name, prior)
      throw error
    }
    prior?.dispose()
    return binding.dispose
  }

  #prepare(input: AcceptanceTask): TaskAcceptanceContract | null {
    const match = acceptanceCanonicalJson([input.scope, input.owner, input.task.kind, input.objective])
    const selected = this.#compiled.profiles.find(({ profile }) => acceptanceCanonicalJson([
      profile.scope, profile.owner, profile.taskKind, profile.objective,
    ]) === match)
    const previous = this.#store.getTaskContract(input)
    if (previous !== null) {
      if (previous.objective !== input.objective || selected?.digest !== previous.profile.digest
        || previous.expiresAt <= this.#now()) throw new Error('assistant-verifier: accepted task changed or expired')
      return previous
    }
    if (selected === undefined) {
      if (this.#requireAcceptance) throw new Error('assistant-verifier: no Host-approved acceptance profile matches this exact task')
      return null
    }
    const now = this.#now()
    return this.#store.accept(createTaskAcceptanceContract({ protocol: 'task-acceptance/v1',
      id: `acceptance-${acceptanceDigest([input.scope, input.owner, input.task])}`, ...input,
      profile: { id: selected.profile.id, version: selected.profile.version, digest: selected.digest },
      issuedAt: now, expiresAt: now + selected.profile.validityMs,
      criteria: selected.profile.criteria, bounds: selected.profile.bounds }))
  }

  async #reconcileExecution(name: ProducerName, binding: Binding, contract: TaskAcceptanceContract): Promise<void> {
    const proof = await this.#bounded(binding.producer.inspectAcceptedExecution(contract), 5_000)
    if (!this.#active || proof === null) return
    if (this.#bindings.get(name) !== binding
      || binding.producer.trustedAcceptanceProducerGeneration() !== binding.generation) {
      throw new Error('assistant-verifier: stale Host execution proof')
    }
    if (proof.contractId !== contract.id || proof.contractDigest !== contract.digest
      || proof.executionRef !== contract.task.ref
      || !Number.isSafeInteger(proof.dispatchedAt) || proof.dispatchedAt < contract.issuedAt
      || proof.completedAt < proof.dispatchedAt || proof.completedAt > this.#now()) {
      throw new Error('assistant-verifier: actual execution does not bind prior acceptance')
    }
    this.#store.markExecutionFinished(contract.id, { status: proof.status, quiescent: proof.quiescent,
      completedAt: proof.completedAt, executionRef: proof.executionRef })
  }

  async #tick(): Promise<void> {
    this.#store.expireAwaiting(this.#now())
    let awaiting = this.#store.awaitingExecution(100, this.#awaitingCursor)
    if (awaiting.length === 0 && this.#awaitingCursor !== '') {
      this.#awaitingCursor = ''
      awaiting = this.#store.awaitingExecution(100)
    }
    for (const contract of awaiting) {
      this.#awaitingCursor = contract.id
      const name = contract.task.kind === 'automation-run' ? 'assistantAutomations' : 'assistantDelivery'
      const binding = this.#bindings.get(name)
      if (binding !== undefined) await this.#reconcileExecution(name, binding, contract)
    }
    if (!this.#active) return
    // One job per tick bounds both background load and work admitted during shutdown.
    const claimed = this.#store.claimDue({ workerId: this.#workerId, now: this.#now(), leaseMs: 305_000 })
    if (claimed !== null) {
      const { contract, job, execution } = claimed
      const startedAt = this.#now()
      const unknown = (reason: string): readonly CriterionResult[] => contract.criteria.map(criterion => ({
        criterionId: criterion.id, status: 'unknown', reason, evidence: [],
      }))
      let results: readonly CriterionResult[] = unknown('verification-unavailable')
      if (!execution.quiescent) results = unknown('execution-not-quiescent')
      else {
        try { results = await this.#bounded(verifyAcceptanceCriteria(contract, this.#compiled.authorities, this.#controller.signal), contract.bounds.maxDurationMs) }
        catch { results = unknown('verification-unavailable') }
      }
      if (!this.#active || this.#controller.signal.aborted) return
      const now = this.#now()
      let receipt = null
      if (now < contract.expiresAt && now >= startedAt) {
        const payload = { protocol: 'task-verification/v1', id: `verification-${contract.id}-${job.fencingToken}`,
          contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner,
          task: contract.task, results, startedAt, completedAt: now, validUntil: contract.expiresAt }
        try { receipt = createTaskVerificationReceipt(contract, payload) }
        catch {
          try { receipt = createTaskVerificationReceipt(contract, { ...payload, results: unknown('evidence-invalid-or-oversize') }) }
          catch { /* A budget too small even for unknown evidence cannot mint a receipt. */ }
        }
      }
      this.#store.finish({ contractId: contract.id, workerId: this.#workerId, fencingToken: job.fencingToken,
        now, receipt, reason: receipt?.objectiveStatus === 'achieved' ? 'verified' : receipt?.objectiveStatus ?? 'contract-expired',
        ...(execution.quiescent && (receipt === null || receipt.objectiveStatus === 'unknown') ? { retryAt: now + 5_000 * job.attempt } : {}) })
    }
    let pendingReceipts = this.#store.pendingReceipts(100, this.#outboxCursor)
    if (pendingReceipts.length === 0 && this.#outboxCursor !== '') {
      this.#outboxCursor = ''
      pendingReceipts = this.#store.pendingReceipts(100)
    }
    for (const pending of pendingReceipts) {
      if (!this.#active) return
      const sink = this.#evaluation
      if (sink === undefined) return
      this.#outboxCursor = pending.receipt.id
      // Expired deliveries remain visible in the outbox; they never acquire fresh authority.
      if (pending.receipt.validUntil <= this.#now()) continue
      const execution = this.#store.getState(pending.contract.id)?.execution
      if (execution === null || execution === undefined) throw new Error('assistant-verifier: receipt lost execution binding')
      await this.#bounded(sink.append({ ...pending, execution }), 5_000)
      if (this.#evaluation !== sink || !this.#active) return
      this.#store.acknowledgeReceipt(pending.receipt.id, pending.receipt.digest)
    }
  }

  /** Stop waiting on an unavailable Host without granting late results authority. */
  #bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const signal = this.#controller.signal
      const finish = (error: Error | undefined, value?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve(value as T)
      }
      const abort = () => finish(new Error('assistant-verifier: operation cancelled'))
      const timer = setTimeout(() => finish(new Error('assistant-verifier: Host operation deadline exceeded')), timeoutMs)
      timer.unref?.()
      operation.then(value => finish(undefined, value), error => finish(error instanceof Error ? error : new Error('assistant-verifier: Host operation failed')))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }

  #assertActive(): void { if (!this.#active) throw new Error('assistant-verifier: disposed') }
}
