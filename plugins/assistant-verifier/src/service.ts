import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  acceptanceCanonicalJson, acceptanceDigest, acceptanceProtocolForTask, createTaskAcceptanceContract, createTaskVerificationReceipt,
} from '@dsh-enhanced/task-acceptance-contract'
import type { CriterionResult, TaskAcceptanceContract, TaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { Config, compileAcceptanceProfiles } from './config.js'
import type { AcceptanceProfile } from './config.js'
import { verifyAcceptanceCriteria, type IsolatedVerificationContext } from './drivers.js'
import type { IsolatedVerifierRunner } from '@dsh-enhanced/assistant-isolation'
import type { AcceptanceHandle, AcceptanceTask, TaskAcceptanceProducer, TaskAcceptanceRegistration, VerifierEvaluationRegistration } from './host.js'
import { AcceptanceStore } from './store.js'
import type { Execution } from './store.js'

export { Config } from './config.js'

/** Exact Host-owned key used to inspect a configured acceptance profile. */
export interface AcceptanceProfileSelection extends Pick<AcceptanceProfile, 'scope' | 'owner' | 'objective' | 'taskKind'> {}

/** Exact Host-owned boundary used to discover configured objective text. */
export type AcceptanceObjectivesSelection = Omit<AcceptanceProfileSelection, 'objective'>

/** Immutable, configuration-only profile inspection result. */
export interface AcceptanceProfileInspection {
  readonly profile: AcceptanceProfile
  readonly digest: string
}

declare module '@deepseek-ai/cordis' {
  interface Context { assistantVerifier: AssistantVerifierService }
  interface Events {
    /** Post-commit nudge only; consumers must reread current evidence and authority. */
    'assistant-verifier/receipt'(notice: Readonly<{ contractId: string; contractDigest: string; receiptId: string; receiptDigest: string; taskKind: TaskAcceptanceContract['task']['kind'] }>): void
  }
}

const producerNames = ['assistantAutomations', 'assistantDelivery', 'assistantGoals'] as const
type ProducerName = typeof producerNames[number]
const producerTaskKinds: Readonly<Record<ProducerName, readonly TaskAcceptanceContract['task']['kind'][]>> = Object.freeze({
  assistantAutomations: ['automation-run'], assistantDelivery: ['foreground-turn'], assistantGoals: ['goal-step', 'goal-outcome'],
})
interface Binding { producer: TaskAcceptanceProducer; generation: string; dispose(): void }

const PROFILE_SELECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const PROFILE_SELECTION_PRESET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.getOwnPropertyNames(value).sort().join(',') !== [...keys].sort().join(',')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(property => !property.enumerable || !('value' in property))) {
    throw new Error(`assistant-verifier: invalid ${label} selection`)
  }
  return value as Record<string, unknown>
}

function selectionKey(value: AcceptanceProfileSelection): string {
  const selection = record(value, ['scope', 'owner', 'objective', 'taskKind'], 'profile')
  const scope = record(selection.scope, ['workspace', 'preset'], 'profile scope')
  const owner = record(selection.owner, ['principalRecordId', 'principalVersion'], 'profile owner')
  if (typeof scope.workspace !== 'string' || scope.workspace.includes('\0') || Buffer.byteLength(scope.workspace) > 4_096
    || scope.workspace !== scope.workspace.normalize('NFC').trim() || !isAbsolute(scope.workspace)
    || normalize(scope.workspace) !== scope.workspace || resolve(scope.workspace) !== scope.workspace
    || typeof scope.preset !== 'string' || !PROFILE_SELECTION_PRESET.test(scope.preset)
    || typeof owner.principalRecordId !== 'string' || !PROFILE_SELECTION_ID.test(owner.principalRecordId)
    || typeof owner.principalVersion !== 'number'
    || !Number.isSafeInteger(owner.principalVersion) || owner.principalVersion < 1
    || typeof selection.objective !== 'string' || selection.objective === '' || selection.objective.includes('\0') || Buffer.byteLength(selection.objective) > 65_536
    || (selection.taskKind !== 'automation-run' && selection.taskKind !== 'foreground-turn'
      && selection.taskKind !== 'goal-step' && selection.taskKind !== 'goal-outcome')) {
    throw new Error('assistant-verifier: invalid profile selection')
  }
  return acceptanceCanonicalJson([scope, owner, selection.taskKind, selection.objective])
}

function objectivesSelectionKey(value: AcceptanceObjectivesSelection): string {
  const selection = record(value, ['scope', 'owner', 'taskKind'], 'profile')
  const scope = record(selection.scope, ['workspace', 'preset'], 'profile scope')
  const owner = record(selection.owner, ['principalRecordId', 'principalVersion'], 'profile owner')
  if (typeof scope.workspace !== 'string' || scope.workspace.includes('\0') || Buffer.byteLength(scope.workspace) > 4_096
    || scope.workspace !== scope.workspace.normalize('NFC').trim() || !isAbsolute(scope.workspace)
    || normalize(scope.workspace) !== scope.workspace || resolve(scope.workspace) !== scope.workspace
    || typeof scope.preset !== 'string' || !PROFILE_SELECTION_PRESET.test(scope.preset)
    || typeof owner.principalRecordId !== 'string' || !PROFILE_SELECTION_ID.test(owner.principalRecordId)
    || typeof owner.principalVersion !== 'number'
    || !Number.isSafeInteger(owner.principalVersion) || owner.principalVersion < 1
    || (selection.taskKind !== 'automation-run' && selection.taskKind !== 'foreground-turn'
      && selection.taskKind !== 'goal-step' && selection.taskKind !== 'goal-outcome')) {
    throw new Error('assistant-verifier: invalid profile selection')
  }
  return acceptanceCanonicalJson([scope, owner, selection.taskKind])
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freeze((value as Record<PropertyKey, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

function profileCopy(profile: AcceptanceProfile): AcceptanceProfile {
  return freeze(structuredClone(profile))
}

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
  readonly #isolatedRunners = new Map<string, Promise<IsolatedVerifierRunner>>()
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
      await Promise.allSettled([...this.#isolatedRunners.values()].map(async runner => (await runner).close()))
      this.#store.close()
    }, 'assistant-verifier.database')
  }

  ownsTaskAcceptanceRegistration = (registration: TaskAcceptanceRegistration): boolean => {
    return this.#active && this.#registrations.has(registration)
  }

  trustedVerificationProducerGeneration = (): string => { this.#assertActive(); return this.#generation }

  /**
   * Host-only configuration inspection for preflight. It never creates a
   * contract, registers a producer, or authorizes/starts execution.
   */
  supportsPreauthorizedGoalAcceptance = (selection: AcceptanceProfileSelection): boolean => {
    const selected = this.inspectAcceptanceProfile(selection)
    return selected !== null && ['goal-step', 'goal-outcome'].includes(selection.taskKind) && selected.profile.criteria.every(criterion => {
      if (criterion.kind === 'isolated-process-behavior') return true
      return selection.taskKind === 'goal-outcome' && criterion.kind === 'target-readback'
        && criterion.expected.some(value => value.pointer === '/ready' && value.value === true)
        && this.#compiled.authorities.some(authority => (authority.kind === 'repository-readback' || authority.kind === 'repository-commit-readback') && authority.id === criterion.authority.id && authority.digest === criterion.authority.digest && criterion.objectId === `${authority.repository}:${authority.branch}`)
    })
  }

  /** Host-only binding: the caller cannot supply a contract, grant or replacement target. */
  inspectRepositoryReadbackAuthority = (contractId: string, authorityId: string, authorityDigest: string) => {
    this.#assertActive()
    const contract = this.#store.getContract(contractId)
    const authority = this.#compiled.authorities.find(item => item.id === authorityId && item.digest === authorityDigest)
    if (!contract || contract.task.kind !== 'goal-outcome' || (authority?.kind !== 'repository-readback' && authority?.kind !== 'repository-commit-readback')
      || !contract.criteria.some(item => item.kind === 'target-readback' && item.authority.id === authorityId && item.authority.digest === authorityDigest && item.objectId === `${authority.repository}:${authority.branch}`)
      || contract.expiresAt <= this.#now()) throw new Error('assistant-verifier: repository acceptance binding unavailable')
    return freeze({ contract, authority })
  }

  inspectAcceptanceProfile = (selection: AcceptanceProfileSelection): Readonly<AcceptanceProfileInspection> | null => {
    this.#assertActive()
    const key = selectionKey(selection)
    const selected = this.#compiled.profiles.find(({ profile }) => acceptanceCanonicalJson([
      profile.scope, profile.owner, profile.taskKind, profile.objective,
    ]) === key)
    return selected === undefined ? null : Object.freeze({
      profile: profileCopy(selected.profile), digest: selected.digest,
    })
  }

  /**
   * Host-only objective discovery for preflight. It only returns configured
   * objective text within the exact scope, owner, and task-kind boundary.
   */
  inspectAcceptanceObjectives = (selection: AcceptanceObjectivesSelection): readonly string[] => {
    this.#assertActive()
    const key = objectivesSelectionKey(selection)
    return Object.freeze([...new Set(this.#compiled.profiles.flatMap(({ profile }) =>
      acceptanceCanonicalJson([profile.scope, profile.owner, profile.taskKind]) === key ? [profile.objective] : []))])
  }

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

  /** Exact immutable contract plus its current validated state for Host feedback loops. */
  inspectAcceptedTask = (contractId: string): Readonly<{
    contract: TaskAcceptanceContract
    state: 'awaiting-execution' | 'pending' | 'verifying' | 'done' | 'needs-attention'
    attempts: number
    reason: string | null
    receipt: TaskVerificationReceipt | null
    execution: Execution | null
  }> | null => {
    this.#assertActive()
    const contract = this.#store.getContract(contractId)
    const state = this.#store.getState(contractId)
    return contract === null || state === null ? null : Object.freeze({ contract, ...state })
  }

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
        if (!producerTaskKinds[name].includes(input.task.kind)) throw new Error('assistant-verifier: wrong Host task kind')
        const accepted = this.#prepare(input)
        if (accepted === null) return null
        const handle = Object.freeze({ contractId: accepted.id, contractDigest: accepted.digest })
        handles.set(handle, accepted)
        return handle
      },
      prepareGoalAssessment: (input: AcceptanceTask, template: AcceptanceHandle): AcceptanceHandle => {
        current()
        if (name !== 'assistantGoals') throw new Error('assistant-verifier: wrong Host assessment producer')
        const accepted = this.#prepareGoalAssessment(input, template)
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
      if (acceptanceDigest(previous.task) !== acceptanceDigest(input.task) || previous.objective !== input.objective || selected?.digest !== previous.profile.digest
        || previous.expiresAt <= this.#now()) throw new Error('assistant-verifier: accepted task changed or expired')
      return previous
    }
    if (selected === undefined) {
      if (this.#requireAcceptance) throw new Error('assistant-verifier: no Host-approved acceptance profile matches this exact task')
      return null
    }
    const now = this.#now()
    return this.#store.accept(createTaskAcceptanceContract({ protocol: acceptanceProtocolForTask(input.task, selected.profile.criteria),
      id: `acceptance-${acceptanceDigest([input.scope, input.owner, input.task])}`, ...input,
      profile: { id: selected.profile.id, version: selected.profile.version, digest: selected.digest },
      issuedAt: now, expiresAt: now + selected.profile.validityMs,
      criteria: selected.profile.criteria, bounds: selected.profile.bounds }))
  }

  #prepareGoalAssessment(input: AcceptanceTask, template: AcceptanceHandle): TaskAcceptanceContract {
    const original = this.#store.getContract(template.contractId)
    if (original?.digest !== template.contractDigest || original.task.kind !== 'goal-outcome'
      || input.task.kind !== 'goal-outcome') throw new Error('assistant-verifier: invalid goal conditions template')
    const identity = (task: typeof input.task) => {
      if (task.kind !== 'goal-outcome') throw new Error('assistant-verifier: whole goal required')
      const { assessmentId: _assessmentId, ...goal } = task.goal
      return goal
    }
    if (acceptanceDigest([original.scope, original.owner, original.objective, identity(original.task)])
      !== acceptanceDigest([input.scope, input.owner, input.objective, identity(input.task)])) {
      throw new Error('assistant-verifier: goal assessment changed its definition or owner')
    }
    const selected = this.#compiled.profiles.find(({ digest }) => digest === original.profile.digest)
    const now = this.#now()
    if (selected === undefined || now + original.bounds.maxDurationMs >= original.expiresAt) {
      throw new Error('assistant-verifier: original goal conditions unavailable or expired')
    }
    const previous = this.#store.getTaskContract(input)
    if (previous !== null) {
      if (acceptanceDigest(previous.task) !== acceptanceDigest(input.task) || previous.objective !== input.objective
        || acceptanceDigest([previous.profile, previous.criteria, previous.bounds, previous.expiresAt])
        !== acceptanceDigest([original.profile, original.criteria, original.bounds, original.expiresAt])) {
        throw new Error('assistant-verifier: goal assessment changed its frozen conditions')
      }
      return previous
    }
    return this.#store.accept(createTaskAcceptanceContract({ protocol: acceptanceProtocolForTask(input.task, original.criteria),
      id: `acceptance-${acceptanceDigest([input.scope, input.owner, input.task])}`, ...input,
      profile: original.profile, criteria: original.criteria, bounds: original.bounds,
      issuedAt: now, expiresAt: original.expiresAt }))
  }

  /** Resolve provenance through the live Host producer and its immutable step contract. */
  #isolatedContext(binding: Binding | undefined): IsolatedVerificationContext {
    const current = () => {
      this.#assertActive()
      if (binding === undefined || this.#bindings.get('assistantGoals') !== binding
        || binding.producer.trustedAcceptanceProducerGeneration() !== binding.generation) {
        throw new Error('assistant-verifier: artifact producer changed')
      }
      return binding.producer
    }
    return {
      readArtifact: async (contract, path) => {
        if (contract.protocol !== 'task-acceptance/v4') throw new Error('assistant-verifier: isolated contract required')
        const producer = current()
        const handle = await producer.inspectAcceptedArtifactSource?.(contract)
        current()
        const source = handle === undefined || handle === null ? null : this.#store.getContract(handle.contractId)
        if (source === null || source.digest !== handle?.contractDigest || source.task.kind !== 'goal-step'
          || source.protocol !== 'task-acceptance/v4'
          || acceptanceDigest([source.scope, source.owner, source.objective]) !== acceptanceDigest([contract.scope, contract.owner, contract.objective])) {
          throw new Error('assistant-verifier: artifact acceptance unavailable')
        }
        const definition = (task: typeof contract.task | typeof source.task) => {
          const { id, definitionVersion, definitionDigest, sessionId, nativeGoalId } = task.goal
          return { id, definitionVersion, definitionDigest, sessionId, nativeGoalId }
        }
        if (acceptanceDigest(definition(source.task)) !== acceptanceDigest(definition(contract.task))
          || contract.task.kind === 'goal-step' && source.digest !== contract.digest) {
          throw new Error('assistant-verifier: artifact belongs to another goal')
        }
        const isolation = this.ctx.get('assistantIsolation' as never, false) as unknown as {
          readAcceptedArtifact?(contract: TaskAcceptanceContract, path: string): Awaited<ReturnType<IsolatedVerificationContext['readArtifact']>>
        } | undefined
        if (typeof isolation?.readAcceptedArtifact !== 'function') throw new Error('assistant-verifier: Isolation unavailable')
        const artifact = isolation.readAcceptedArtifact(source, path)
        current()
        return artifact
      },
      run: async (authority, key, artifact, stdin, signal) => {
        current()
        let pending = this.#isolatedRunners.get(authority.digest)
        if (pending === undefined) {
          pending = import('@dsh-enhanced/assistant-isolation').then(({ IsolatedVerifierRunner }) => {
            this.#assertActive()
            return new IsolatedVerifierRunner({ stateRoot: authority.stateRoot, image: authority.image,
              dockerPath: authority.dockerPath, authorityDigest: authority.digest, command: authority.command,
              expiresAt: authority.expiresAt, maxRuns: authority.maxRuns, maxTotalDurationMs: authority.maxTotalDurationMs,
              maxDurationMs: authority.maxDurationMs, maxOutputBytes: authority.maxOutputBytes })
          })
          this.#isolatedRunners.set(authority.digest, pending)
        }
        const runner = await pending
        current()
        return runner.run(key, artifact, stdin, signal)
      },
    }
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
      const name: ProducerName = contract.task.kind === 'automation-run'
        ? 'assistantAutomations'
        : contract.task.kind === 'foreground-turn' ? 'assistantDelivery' : 'assistantGoals'
      const binding = this.#bindings.get(name)
      if (binding !== undefined) await this.#reconcileExecution(name, binding, contract)
    }
    if (!this.#active) return
    // One job per tick bounds both background load and work admitted during shutdown.
    const claimed = this.#store.claimDue({ workerId: this.#workerId, now: this.#now(), leaseMs: 305_000 })
    if (claimed !== null) {
      const { contract, job, execution } = claimed
      const requiresLiveGoal = contract.task.kind === 'goal-outcome' || contract.protocol === 'task-acceptance/v4'
      const outcomeBinding = requiresLiveGoal ? this.#bindings.get('assistantGoals') : undefined
      const startedAt = this.#now()
      const unknown = (reason: string): readonly CriterionResult[] => contract.criteria.map(criterion => ({
        criterionId: criterion.id, status: 'unknown', reason, evidence: [],
      }))
      let results: readonly CriterionResult[] = unknown('verification-unavailable')
      if (!execution.quiescent) results = unknown('execution-not-quiescent')
      else {
        try { results = await this.#bounded(verifyAcceptanceCriteria(contract, this.#compiled.authorities, this.#controller.signal, this.#isolatedContext(outcomeBinding), { read: async (accepted, authority, signal) => {
          type RepositoryReader = { repositoryReadbackGeneration(): string; readRepositoryGoalOutcome(input: { contractId: string; authorityId: string; authorityDigest: string }, signal: AbortSignal): Promise<unknown> }
          const reader = this.ctx.get('assistantActions' as never, false) as RepositoryReader | undefined
          if (typeof reader?.readRepositoryGoalOutcome !== 'function' || typeof reader.repositoryReadbackGeneration !== 'function') throw new Error('repository broker unavailable')
          const generation = reader.repositoryReadbackGeneration()
          const result = await reader.readRepositoryGoalOutcome({ contractId: accepted.id, authorityId: authority.id, authorityDigest: authority.digest }, signal)
          const current = this.ctx.get('assistantActions' as never, false) as RepositoryReader | undefined
          if (current?.repositoryReadbackGeneration() !== generation) throw new Error('repository broker changed')
          return result
        } }), contract.bounds.maxDurationMs) }
        catch { results = unknown('verification-unavailable') }
      }
      if (requiresLiveGoal && execution.quiescent) {
        try {
          if (outcomeBinding === undefined) throw new Error('whole-goal producer unavailable')
          const proof = await this.#bounded(outcomeBinding.producer.inspectAcceptedExecution(contract), 5_000)
          if (this.#bindings.get('assistantGoals') !== outcomeBinding
            || outcomeBinding.producer.trustedAcceptanceProducerGeneration() !== outcomeBinding.generation
            || proof === null || proof.contractId !== contract.id || proof.contractDigest !== contract.digest
            || proof.dispatchedAt < contract.issuedAt || proof.dispatchedAt > execution.completedAt
            || acceptanceDigest({ status: proof.status, quiescent: proof.quiescent, completedAt: proof.completedAt, executionRef: proof.executionRef }) !== acceptanceDigest(execution)) {
            throw new Error('whole-goal assessment authority changed')
          }
        } catch { results = unknown('whole-goal-assessment-authority-changed') }
      }
      if (!this.#active || this.#controller.signal.aborted) return
      const now = this.#now()
      let receipt = null
      if (now < contract.expiresAt && now >= startedAt) {
        const payload = { protocol: contract.protocol === 'task-acceptance/v4' ? 'task-verification/v4' as const : contract.protocol === 'task-acceptance/v3' ? 'task-verification/v3' as const : contract.protocol === 'task-acceptance/v2' ? 'task-verification/v2' as const : 'task-verification/v1' as const, id: `verification-${contract.id}-${job.fencingToken}`,
          contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner,
          task: contract.task, results, startedAt, completedAt: now, validUntil: Math.min(contract.expiresAt, ...contract.criteria.flatMap(criterion => {
            const authority = this.#compiled.authorities.find(item => item.id === criterion.authority.id && item.digest === criterion.authority.digest)
            return authority?.kind === 'repository-readback' || authority?.kind === 'repository-commit-readback' ? [startedAt + authority.freshnessMs] : []
          })) }
        try { receipt = createTaskVerificationReceipt(contract, payload) }
        catch {
          try { receipt = createTaskVerificationReceipt(contract, { ...payload, results: unknown('evidence-invalid-or-oversize') }) }
          catch { /* A budget too small even for unknown evidence cannot mint a receipt. */ }
        }
      }
      this.#store.finish({ contractId: contract.id, workerId: this.#workerId, fencingToken: job.fencingToken,
        now, receipt, reason: receipt?.objectiveStatus === 'achieved' ? 'verified' : receipt?.objectiveStatus ?? 'contract-expired',
        ...(execution.quiescent && (receipt === null || receipt.objectiveStatus === 'unknown') ? { retryAt: now + 5_000 * job.attempt } : {}) })
      if (receipt !== null) {
        try { this.ctx.emit('assistant-verifier/receipt', Object.freeze({ contractId: contract.id, contractDigest: contract.digest, receiptId: receipt.id, receiptDigest: receipt.digest, taskKind: contract.task.kind })) }
        catch { /* A best-effort nudge must not interrupt the durable Evaluation outbox. */ }
      }
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
