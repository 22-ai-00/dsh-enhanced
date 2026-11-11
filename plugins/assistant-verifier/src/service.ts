import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  acceptanceCanonicalJson, acceptanceDigest, acceptanceProtocolForTask, createTaskAcceptanceContract, createTaskVerificationReceipt,
} from '@dsh-enhanced/task-acceptance-contract'
import type { CriterionResult, TaskAcceptanceContract, TaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { Config, assertCriteriaDecidable, compileAcceptanceProfiles } from './config.js'
import type { AcceptanceProfile } from './config.js'
import { verifyAcceptanceCriteria, type IsolatedVerificationContext, type VerifierAuthority } from './drivers.js'
import type { IsolatedVerifierRunner } from '@dsh-enhanced/assistant-isolation'
import type { AcceptanceAuthorityCatalog, AcceptanceAuthorityCatalogEntry, AcceptanceHandle, AcceptanceTask, OwnerPreparedContractInput, TaskAcceptanceProducer, TaskAcceptanceRegistration, VerifierEvaluationRegistration } from './host.js'
import { AcceptanceStore } from './store.js'
import type { Execution } from './store.js'
import { SourceReviewRuntime, validateSourceReviewConfig, type SourceReviewInput, type SourceReviewSelection } from './source-review.js'
import { MemoryReviewRuntime, validateMemoryReviewConfig } from './memory-review.js'
import type { MemoryReviewConfig, MemoryReviewAvailability } from './memory-review.js'
import type { MemoryLearningOwner, MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import type { PluginCreationVerificationRequest, PluginCreationVerificationResult,
  PluginRevisionVerificationRequest, PluginRevisionVerificationResult,
  PluginRevisionRegressionRequest, PluginRevisionRegressionResult } from '@dsh-enhanced/assistant-growth-contract'
import { CreationReviewRuntime, validateCreationReviewConfig } from './creation-review.js'
import type { CreationReviewConfig, CreationReviewAuthorityInspection } from './creation-review.js'
import { RevisionReviewRuntime, validateRevisionReviewConfig } from './revision-review.js'
import type { RevisionReviewConfig, RevisionReviewAuthorityInspection } from './revision-review.js'
import { RevisionRegressionReviewRuntime, validateRevisionRegressionReviewConfig } from './revision-regression-review.js'
import type { RevisionRegressionReviewConfig, RevisionRegressionReviewAuthorityInspection } from './revision-regression-review.js'

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
const PREPARED_PROFILE_ID = 'owner-prepared'
const PREPARED_PROFILE_VERSION = 1
/**
 * Prepared profiles derive from the sealed criteria and bounds alone. That lets
 * a restart re-verify a seal from the stored contract without another table,
 * while static config profiles keep their own digests.
 */
const preparedProfileDigest = (criteria: TaskAcceptanceContract['criteria'], bounds: TaskAcceptanceContract['bounds']): string =>
  acceptanceDigest({ protocol: 'assistant-goals/prepared-profile/v1', criteria, bounds })
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

/** Sanitized entry for one installed authority; never credentials or environment. */
function authorityCatalogEntry(authority: VerifierAuthority): AcceptanceAuthorityCatalogEntry {
  switch (authority.kind) {
    case 'runner': return freeze({ id: authority.id, digest: authority.digest, kind: 'runner',
      artifactPath: 'workspace-relative',
      note: 'process-behavior artifactPath must be a workspace-relative path; expected stdout and exit code are compared with this fixed runner executable.' })
    case 'isolated-runner': return freeze({ id: authority.id, digest: authority.digest, kind: 'isolated-runner',
      artifactPath: 'workspace-relative',
      testSetIds: Object.freeze(authority.testSets.map(testSet => testSet.id)),
      note: 'isolated-process-behavior criteria bind exactly one testSetId from this list.' })
    case 'document': return freeze({ id: authority.id, digest: authority.digest, kind: 'document',
      sourceIds: Object.freeze(authority.sources.map(source => source.id)),
      note: 'document-citations requiredText quotes may cite these source ids; case URLs stay inside the verifier.' })
    case 'readback': return freeze({ id: authority.id, digest: authority.digest, kind: 'readback',
      objectIdPointer: authority.objectIdPointer,
      note: 'target-readback objectId is a Host-configured object id resolved through this JSON pointer.' })
    case 'repository-readback':
    case 'repository-commit-readback': return freeze({ id: authority.id, digest: authority.digest, kind: authority.kind,
      objectId: `${authority.repository}:${authority.branch}`,
      note: 'target-readback objectId must be exactly "<repository>:<branch>" as shown; expected pointers use the readback response shape.' })
  }
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
  #sourceReviewer: SourceReviewRuntime | undefined
  readonly #sourceReviewers = new Set<SourceReviewRuntime>()
  #memoryReviewer: MemoryReviewRuntime | undefined
  readonly #memoryReviewConfig: MemoryReviewConfig | undefined
  readonly #memoryReviewers = new Set<MemoryReviewRuntime>()
  #creationReviewer: CreationReviewRuntime | undefined
  readonly #creationReviewers = new Set<CreationReviewRuntime>()
  #revisionReviewer: RevisionReviewRuntime | undefined
  readonly #revisionReviewers = new Set<RevisionReviewRuntime>()
  #revisionRegressionReviewer: RevisionRegressionReviewRuntime | undefined
  readonly #revisionRegressionReviewers = new Set<RevisionRegressionReviewRuntime>()

  constructor(ctx: Context, config: Config, options: { now?: () => number } = {}) {
    super(ctx, 'assistantVerifier')
    const normalized = Config(config)
    const sourceReviews = normalized.sourceReviews === undefined ? undefined : validateSourceReviewConfig(normalized.sourceReviews)
    const memoryReviews = normalized.memoryReviews === undefined ? undefined : validateMemoryReviewConfig(normalized.memoryReviews)
    const creationReviews = normalized.creationReviews === undefined ? undefined : validateCreationReviewConfig(normalized.creationReviews)
    const revisionReviews = normalized.revisionReviews === undefined ? undefined : validateRevisionReviewConfig(normalized.revisionReviews)
    const revisionRegressions = normalized.revisionRegressions === undefined ? undefined
      : validateRevisionRegressionReviewConfig(normalized.revisionRegressions)
    this.#memoryReviewConfig = memoryReviews
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
      // Abort both review lanes before awaiting unrelated acceptance teardown.
      const reviews = [...this.#sourceReviewers, ...this.#memoryReviewers, ...this.#creationReviewers,
        ...this.#revisionReviewers, ...this.#revisionRegressionReviewers].map(reviewer => reviewer.close())
      await this.#running?.catch(() => {})
      await Promise.allSettled([...this.#isolatedRunners.values()].map(async runner => (await runner).close()))
      await Promise.allSettled(reviews)
      this.#store.close()
    }, 'assistant-verifier.database')
    if (sourceReviews) ctx.inject(['agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy'], injected => {
      injected.effect(() => {
        if (!this.#active) return () => {}
        const reviewer = new SourceReviewRuntime(injected, sourceReviews, normalized.databasePath)
        this.#sourceReviewer = reviewer; this.#sourceReviewers.add(reviewer)
        return async () => {
          if (this.#sourceReviewer === reviewer) this.#sourceReviewer = undefined
          await reviewer.close(); this.#sourceReviewers.delete(reviewer)
        }
      }, 'assistant-verifier.source-review')
    })
    if (memoryReviews) ctx.inject(['agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy', 'assistantDelivery', 'assistantEvaluation'], injected => {
      injected.effect(() => {
        if (!this.#active) return () => {}
        const reviewer = new MemoryReviewRuntime(injected, memoryReviews, normalized.databasePath)
        this.#memoryReviewer = reviewer; this.#memoryReviewers.add(reviewer)
        return async () => {
          if (this.#memoryReviewer === reviewer) this.#memoryReviewer = undefined
          await reviewer.close(); this.#memoryReviewers.delete(reviewer)
        }
      }, 'assistant-verifier.memory-review')
    })
    if (creationReviews) ctx.inject(['agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy', 'pluginControlPlane' as never], injected => {
      injected.effect(() => {
        if (!this.#active) return () => {}
        const reviewer = new CreationReviewRuntime(injected, creationReviews, normalized.databasePath)
        this.#creationReviewer = reviewer; this.#creationReviewers.add(reviewer)
        return async () => {
          if (this.#creationReviewer === reviewer) this.#creationReviewer = undefined
          await reviewer.close(); this.#creationReviewers.delete(reviewer)
        }
      }, 'assistant-verifier.creation-review')
    })
    if (revisionReviews) ctx.inject(['agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy', 'pluginControlPlane' as never], injected => {
      injected.effect(() => {
        if (!this.#active) return () => {}
        const reviewer = new RevisionReviewRuntime(injected, revisionReviews, normalized.databasePath)
        this.#revisionReviewer = reviewer; this.#revisionReviewers.add(reviewer)
        return async () => {
          if (this.#revisionReviewer === reviewer) this.#revisionReviewer = undefined
          await reviewer.close(); this.#revisionReviewers.delete(reviewer)
        }
      }, 'assistant-verifier.revision-review')
    })
    if (revisionRegressions) ctx.inject(['pluginControlPlane' as never], injected => {
      injected.effect(() => {
        if (!this.#active) return () => {}
        const reviewer = new RevisionRegressionReviewRuntime(injected, revisionRegressions, normalized.databasePath,
          parent => this.#creationReviewer?.readRetainedCases(parent))
        this.#revisionRegressionReviewer = reviewer; this.#revisionRegressionReviewers.add(reviewer)
        return async () => {
          if (this.#revisionRegressionReviewer === reviewer) this.#revisionRegressionReviewer = undefined
          await reviewer.close(); this.#revisionRegressionReviewers.delete(reviewer)
        }
      }, 'assistant-verifier.revision-regression-review')
    })
  }

  /** Frozen public acceptance authority; unavailable until the private Host peers are active. */
  inspectCreationAcceptanceAuthority = (input: { owner: CreationReviewConfig['owner'] }): CreationReviewAuthorityInspection | undefined => {
    this.#assertActive()
    return this.#creationReviewer?.inspect(input)
  }

  /** Pure, current WorkItem creation reviewer capability; never allocates a runner or claim. */
  inspectWorkItemCreationReviewReadiness = () => {
    if (!this.#active) return undefined
    return this.#creationReviewer?.inspectWorkItemCreationReviewReadiness()
  }

  /** Private Host continuation only. Source, artifact and owner are re-read through Control Plane. */
  verifyPluginCreation = (request: PluginCreationVerificationRequest, signal?: AbortSignal): Promise<PluginCreationVerificationResult> => {
    this.#assertActive()
    return this.#creationReviewer?.run(request, signal)
      ?? Promise.resolve({ status: 'unknown', reason: 'verification-unavailable' })
  }

  /** Frozen revision authority; independent of the creation grant and quota. */
  inspectRevisionAcceptanceAuthority = (input: { owner: RevisionReviewConfig['owner'] }): RevisionReviewAuthorityInspection | undefined => {
    this.#assertActive()
    return this.#revisionReviewer?.inspect(input)
  }

  /** Private Host continuation for a new task's candidate revision. It grants no execution authority. */
  verifyPluginRevision = (request: PluginRevisionVerificationRequest, signal?: AbortSignal): Promise<PluginRevisionVerificationResult> => {
    this.#assertActive()
    return this.#revisionReviewer?.run(request, signal)
      ?? Promise.resolve({ status: 'unknown', reason: 'verification-unavailable' })
  }

  /** Host-only parent behavior regression; no candidate execution or version switch authority. */
  inspectRevisionRegressionAcceptanceAuthority = (input: { owner: RevisionRegressionReviewConfig['owner'] }): RevisionRegressionReviewAuthorityInspection | undefined => {
    this.#assertActive()
    return this.#revisionRegressionReviewer?.inspect(input)
  }

  verifyPluginRevisionRegression = (request: PluginRevisionRegressionRequest, signal?: AbortSignal): Promise<PluginRevisionRegressionResult> => {
    this.#assertActive()
    return this.#revisionRegressionReviewer?.run(request, signal)
      ?? Promise.resolve({ status: 'unknown', reason: 'verification-unavailable' })
  }

  /** Host-only review. Source text and verdicts cannot be supplied by the caller. */
  reviewMemoryLearning = (request: MemoryLearningReviewRequest, signal?: AbortSignal) => {
    this.#assertActive()
    if (!this.#memoryReviewer) throw new Error('assistant-verifier: memory review services unavailable')
    return this.#memoryReviewer.run(request, signal)
  }

  lookupMemoryLearningReview = (request: MemoryLearningReviewRequest) => {
    this.#assertActive()
    return this.#memoryReviewer?.lookup(request)
  }

  /** Host-only read of current authority and unclaimed review capacity. */
  inspectMemoryLearningReviewAvailability = (input: { owner: MemoryLearningOwner }): MemoryReviewAvailability | undefined => {
    this.#assertActive()
    const config = this.#memoryReviewConfig
    if (!config) return undefined
    return this.#memoryReviewer?.inspectAvailability(input) ?? Object.freeze({ authorityId: config.authorityId,
      authorityDigest: acceptanceDigest(config), expiresAt: config.expiresAt, remainingReviews: 0, available: false })
  }

  /** Host-only capability probe, including the exact decision directory. */
  canReviewSourceRepair = (input: SourceReviewSelection): boolean => this.#active && this.#sourceReviewer?.available(input) === true

  /** No model tool exposes this entry or the private decision writer. */
  reviewSourceRepair = (input: SourceReviewInput) => {
    this.#assertActive()
    if (!this.#sourceReviewer) throw new Error('assistant-verifier: source review services unavailable')
    return this.#sourceReviewer.run(input)
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

  /**
   * Host-only read-only catalog of installed acceptance authorities for one
   * owner scope. It never registers a model tool, writes state, or exposes
   * credentials, environment, executable/state paths or grant identities; the
   * kind-specific bindings are guidance for constructing decidable criteria.
   */
  inspectAcceptanceAuthorities = (input: Readonly<{
    scope: Readonly<{ workspace: string; preset: string }>
    owner: Readonly<{ principalRecordId: string; principalVersion: number }>
  }>): AcceptanceAuthorityCatalog => {
    this.#assertActive()
    const selection = record(input, ['scope', 'owner'], 'acceptance authority catalog')
    const scope = record(selection.scope, ['workspace', 'preset'], 'acceptance authority catalog scope')
    const owner = record(selection.owner, ['principalRecordId', 'principalVersion'], 'acceptance authority catalog owner')
    if (typeof scope.workspace !== 'string' || scope.workspace.includes('\0') || Buffer.byteLength(scope.workspace) > 4_096
      || scope.workspace !== scope.workspace.normalize('NFC').trim() || !isAbsolute(scope.workspace)
      || normalize(scope.workspace) !== scope.workspace || resolve(scope.workspace) !== scope.workspace
      || typeof scope.preset !== 'string' || !PROFILE_SELECTION_PRESET.test(scope.preset)
      || typeof owner.principalRecordId !== 'string' || !PROFILE_SELECTION_ID.test(owner.principalRecordId)
      || typeof owner.principalVersion !== 'number' || !Number.isSafeInteger(owner.principalVersion) || owner.principalVersion < 1) {
      throw new Error('assistant-verifier: invalid acceptance authority catalog selection')
    }
    return freeze({ protocol: 'assistant-verifier/acceptance-authorities/v1' as const,
      authorities: freeze(this.#compiled.authorities.map(authorityCatalogEntry)) })
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
      ...(name === 'assistantGoals' ? { prepareOwnerContract: (input: OwnerPreparedContractInput): AcceptanceHandle => {
        current()
        const accepted = this.#prepareOwnerContract(input)
        const handle = Object.freeze({ contractId: accepted.id, contractDigest: accepted.digest })
        handles.set(handle, accepted)
        return handle
      } } : {}),
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
      // A prepared seal is self-describing: re-derive its profile digest from the
      // frozen criteria instead of requiring a matching static config profile.
      const prepared = previous.profile.id === PREPARED_PROFILE_ID && previous.profile.version === PREPARED_PROFILE_VERSION
        && preparedProfileDigest(previous.criteria, previous.bounds) === previous.profile.digest
      if (acceptanceDigest(previous.task) !== acceptanceDigest(input.task) || previous.objective !== input.objective
        || (!prepared && selected?.digest !== previous.profile.digest)
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

  /**
   * Seal Host-prepared criteria for one owner goal. The contract carries a
   * prepared profile digest instead of a configured profile, so the frozen
   * criteria stay outside worker write authority; every criterion must be
   * decidable by an authority this deployment actually installed.
   */
  #prepareOwnerContract(input: OwnerPreparedContractInput): TaskAcceptanceContract {
    const keys = ['scope', 'owner', 'task', 'objective', 'criteria', 'bounds', 'validityMs', 'preparer'].sort()
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.getOwnPropertyNames(input).sort().join(',') !== keys.join(',')) {
      throw new Error('assistant-verifier: invalid owner-prepared contract input')
    }
    const { scope, owner, task, objective, criteria, bounds, validityMs, preparer } = input
    if (typeof objective !== 'string' || objective.trim().length === 0 || objective.length > 16_384) {
      throw new Error('assistant-verifier: invalid owner-prepared objective')
    }
    if (task.kind !== 'goal-step' && task.kind !== 'goal-outcome') {
      throw new Error('assistant-verifier: owner-prepared contracts require a goal task')
    }
    if (!Number.isSafeInteger(validityMs) || validityMs < 1_000 || validityMs > 86_400_000) {
      throw new Error('assistant-verifier: invalid owner-prepared validity')
    }
    if (preparer === null || typeof preparer !== 'object' || Array.isArray(preparer)
      || Object.getOwnPropertyNames(preparer).sort().join(',') !== 'digest,id'
      || typeof preparer.id !== 'string' || !PROFILE_SELECTION_ID.test(preparer.id)
      || typeof preparer.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(preparer.digest)) {
      throw new Error('assistant-verifier: invalid owner-prepared preparer')
    }
    const profileDigest = preparedProfileDigest(criteria, bounds)
    const previous = this.#store.getTaskContract({ scope, owner, task })
    if (previous !== null) {
      if (acceptanceDigest(previous.task) !== acceptanceDigest(task) || previous.objective !== objective
        || acceptanceDigest(previous.criteria) !== acceptanceDigest(criteria)
        || acceptanceDigest(previous.bounds) !== acceptanceDigest(bounds)
        || previous.profile.digest !== profileDigest) {
        throw new Error('assistant-verifier: owner-prepared contract changed for this task')
      }
      if (previous.expiresAt <= this.#now()) throw new Error('assistant-verifier: owner-prepared contract expired')
      return previous
    }
    if (validityMs <= bounds.maxDurationMs) {
      throw new Error('assistant-verifier: owner-prepared validity must exceed verification duration')
    }
    const now = this.#now()
    const contract = createTaskAcceptanceContract({
      protocol: acceptanceProtocolForTask(task, criteria),
      id: `acceptance-${acceptanceDigest([scope, owner, task])}`,
      scope, owner, task, objective,
      profile: { id: 'owner-prepared', version: 1, digest: profileDigest },
      issuedAt: now, expiresAt: now + validityMs, criteria, bounds,
    })
    // Fail closed before sealing: a criterion no installed authority can decide
    // (wrong driver kind, missing isolated test set or repository object) must
    // never reach a worker run.
    assertCriteriaDecidable(contract, this.#compiled.authorities)
    return this.#store.accept(contract)
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
    // Prepared goal conditions stay usable after a restart or a config change: the
    // seal carries everything needed to re-derive its profile identity.
    const prepared = original.profile.id === PREPARED_PROFILE_ID && original.profile.version === PREPARED_PROFILE_VERSION
      && preparedProfileDigest(original.criteria, original.bounds) === original.profile.digest
    const now = this.#now()
    if ((!prepared && selected === undefined) || now + original.bounds.maxDurationMs >= original.expiresAt) {
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
            if (authority.backend !== 'linux-native') {
              throw new Error('assistant-verifier: only the linux-native isolation backend is supported')
            }
            return new IsolatedVerifierRunner({ stateRoot: authority.stateRoot,
              backend: 'linux-native' as const, runtime: authority.runtime, cgroupRoots: authority.cgroupRoots,
              authorityDigest: authority.digest, command: authority.command,
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
