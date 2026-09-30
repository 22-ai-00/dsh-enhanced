import { AdoptionCoordinatorRuntime, validateAdoptionCoordinatorConfig, type AdoptionCoordinatorConfig } from './adoption-coordinator.js'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import type { AssistantDeliveryService, ForegroundTaskObservationRegistration, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { sourceGrowthRunDigest, validateCreationAcceptanceAuthorityRef, verifyPluginCreationVerificationCertificate,
  validateSourceGrowthRunBinding, type CreationAcceptanceAuthorityRef, type PluginCreationVerificationCertificate,
  type PluginCreationVerificationRequest, type PluginCreationVerificationResult,
  type SourceGrowthRunBinding, type SourceGrowthRunProducer } from '@dsh-enhanced/assistant-growth-contract'
import { TaskObservationRuntime, validateTaskObservationConfig } from './task-observation-runtime.js'
import { LiveQualificationRuntime, validateLiveQualificationConfig, type LiveQualificationConfig } from './live-qualification-runtime.js'
import type { TaskObservationConfig } from './task-observation-types.js'
import { rollbackPluginWatch } from './cli.js'
import type { AssistantVerifierService } from '@dsh-enhanced/assistant-verifier'
import { OwnerTaskFailureGaps } from './owner-task-gaps.js'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { discover, loadCatalogWithMetadata, type CatalogEntry } from './catalog.js'
import { ControlPlaneCliError } from './errors.js'
import {
  assertPluginModificationAllowed,
  createIsolatedWorktree,
  gcPreparedModifyWorktrees,
  inspectPreparedCreationPatch,
  runLocalCommand,
  validateScopedPluginFiles,
  verifyPreparedSourceWorktree,
  writeScopedPluginFiles,
  type ScopedPluginFile,
} from './source-workspace.js'
import { assertManagedVersionPaths, managedPatchVersionFiles, verifyManagedPatchVersion } from './source-versioning.js'
import { requestSourceApproval, validateSourceApprovalClientConfig, type SourceApprovalClientConfig } from './source-approval-client.js'
import { requestSourceReleaseAuthorization, validateSourceReleaseClientConfig, type SourceReleaseClientConfig } from './source-release-client.js'
import { Ed25519SourceReleaseAuthorizationAuthority } from './release.js'
import { advanceSourceRelease, sourceReleaseAuthorities, validateSourceReleaseExecutionConfig, type SourceReleaseExecutionConfig } from './source-release-runner.js'
import { adoptSourceRelease, validateSourceAdoptionConfig, type SourceAdoptionConfig } from './source-adoption-runner.js'
import { Ed25519ApprovalAuthority } from './approval.js'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST, controlPlaneDigest } from './store.js'
import { runDockerPreparedChecks, validateSourceBuildConfig, type SourceBuildConfig } from './source-build.js'
import { awaitSourceSignal, inspectSourceContext, type SourceInspection } from './source-context.js'
import { inspectSourceCreationContext, prepareCreatedPluginWorkspace, validateSourceCreationFiles, verifyCreatedPluginWorkspace } from './source-creation.js'
import { resolveSourceBaseline } from './source-baseline.js'
import { inheritedEnvironment, loadTrustConfig, resolveTrustKey } from './trust.js'
import type { CapabilityGapInput, PluginActivationPlan, PluginControlPlaneHealth, PluginSourcePlan, StoredCapabilityGap } from './types.js'
import { registerPluginControlTools } from './tools.js'
import { SourceGrowthRunUnavailableError, SourceJobRuntime, validateSourceJobsConfig, type EnqueueSourceJobInput, type SourceJobCaller, type SourceJobPorts } from './source-jobs.js'
import type { SourceJobOwnerReceipt, SourceJobProjection, SourceJobRecord, SourceJobsConfig } from './source-job-types.js'
import { installRuntimeObserver, validateRuntimeObserverConfig, type RuntimeObserverConfig } from './runtime-observer.js'
import { installReplayEndpoint, validateReplayEndpointConfig, type ReplayEndpointConfig } from './replay-endpoint.js'
import { readPrivateRuntimeObserverKey } from './runtime-observer-protocol.js'
import { createForegroundDeploymentObserver, foregroundTrustSnapshot, queueRuntimeEpoch, validateForegroundDeploymentConfig, type ForegroundDeploymentConfig } from './foreground-deployment-runtime.js'
import { captureRetainedDeploymentReadiness } from './deployment-readiness.js'
import { installHostReadiness, onHostReady } from './host-readiness.js'
import type { ForegroundDeploymentRecord } from './foreground-deployment.js'

export interface Config {
  catalogPath: string
  statePath: string
  trustPath: string
  proposalTtlMs?: number
  /** Optional for legacy deployments; required by prepareModifySourcePlan. */
  sourceBuild?: SourceBuildConfig
  /** Explicit, expiring Host authority for work that outlives a model wake. */
  sourceJobs?: SourceJobsConfig
  /** Signed independent creation checks, bound to the pre-author owner policy. */
  creationVerifications?: { authority: CreationAcceptanceAuthorityRef; publicKey: string }
  /** Optional finite owner authority; only approves prepared task-bound source, never deploys it. */
  sourceApprovals?: SourceApprovalClientConfig
  /** Optional separate finite authority for entering the local release state machine. */
  sourceReleases?: SourceReleaseClientConfig
  /** Explicit local phase execution, optionally requesting separately authorized review. */
  sourceReleaseExecution?: SourceReleaseExecutionConfig
  /** Finite owner adoption of an exact completed repair into a configured profile. */
  sourceAdoptions?: SourceAdoptionConfig
  /** External Host only: advance signed handoffs until target-owned final commit. */
  adoptionCoordinator?: AdoptionCoordinatorConfig
  /** Explicit owner-only observation channel; no signing or activation authority. */
  runtimeObserver?: RuntimeObserverConfig
  /** Capture real owner foreground tasks against signed, currently loaded deployments. */
  foregroundDeployments?: ForegroundDeploymentConfig
  /** Finite trusted task feedback observations scheduled by native Automations. */
  taskObservations?: TaskObservationConfig
  /** Finite pre-adoption real-task qualification under the installed owner authority. */
  liveQualification?: LiveQualificationConfig
  /** Owner-pinned finite native replay; separate from the read-only observer. */
  replayEndpoint?: ReplayEndpointConfig
}
type CreationVerifierPort = {
  verifyPluginCreation(request: PluginCreationVerificationRequest, signal?: AbortSignal): Promise<PluginCreationVerificationResult>
}
const CREATION_UNKNOWN_CODES = new Set(['schema-observation-unknown', 'case-observation-unknown', 'contract-insufficient',
  'interrupted', 'stale-source', 'verification-unknown', 'previous-unknown'])
const CREATION_REJECTED_CODES = new Set(['case-mismatch', 'source-review-rejected', 'request-invalid'])
export type NormalizedControlPlaneConfig = Required<Omit<Config, 'sourceBuild' | 'sourceJobs' | 'creationVerifications' | 'sourceApprovals' | 'sourceReleases' | 'sourceReleaseExecution' | 'sourceAdoptions' | 'adoptionCoordinator' | 'runtimeObserver' | 'foregroundDeployments' | 'taskObservations' | 'liveQualification' | 'replayEndpoint'>>
  & Pick<Config, 'sourceBuild' | 'sourceJobs' | 'creationVerifications' | 'sourceApprovals' | 'sourceReleases' | 'sourceReleaseExecution' | 'sourceAdoptions' | 'adoptionCoordinator' | 'runtimeObserver' | 'foregroundDeployments' | 'taskObservations' | 'liveQualification' | 'replayEndpoint'>
const schema = Schema.object({
  catalogPath: Schema.string().required(), statePath: Schema.string().required(), trustPath: Schema.string().required(),
  proposalTtlMs: Schema.number().step(1).min(60_000).max(86_400_000).default(900_000),
  sourceBuild: Schema.any(),
  sourceJobs: Schema.any(),
  creationVerifications: Schema.any(),
  sourceApprovals: Schema.any(),
  sourceReleases: Schema.any(),
  sourceReleaseExecution: Schema.any(),
  sourceAdoptions: Schema.any(),
  adoptionCoordinator: Schema.any(),
  runtimeObserver: Schema.any(),
  foregroundDeployments: Schema.any(),
  taskObservations: Schema.any(),
  liveQualification: Schema.any(),
  replayEndpoint: Schema.any(),
}) as Schema<Config>

declare module '@deepseek-ai/cordis' { interface Context { pluginControlPlane: PluginControlPlaneService } }

async function canonicalTarget(dshHome: string, profile: string): Promise<PluginActivationPlan['target']> {
  const profiles = join(dshHome, 'profiles')
  if (await realpath(profiles) !== resolve(profiles)) throw new Error('plugin-control-plane: profiles directory is not canonical')
  const profilePath = join(profiles, profile)
  try {
    const metadata = await lstat(profilePath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(profilePath) !== resolve(profilePath)) throw new Error('plugin-control-plane: target profile must be a canonical directory')
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
    if (await realpath(dirname(profilePath)) !== resolve(dirname(profilePath)) || basename(profilePath) !== profile) throw new Error('plugin-control-plane: missing target parent is not canonical')
  }
  return Object.freeze({ dshHome, profile, profilePath })
}

/**
 * Read-only deployment preflight for profile installers. It validates and clones
 * control-plane configuration without opening a ledger, mounting a service,
 * starting effects, or creating runtime resources. Existing path/key validators
 * may read deployment files.
 */
export function normalizeControlPlaneConfig(input: Config): NormalizedControlPlaneConfig {
  const config = structuredClone(schema(input)) as NormalizedControlPlaneConfig
  if (config.runtimeObserver !== undefined) validateRuntimeObserverConfig(config.runtimeObserver)
  if (config.foregroundDeployments !== undefined) {
    validateForegroundDeploymentConfig(config.foregroundDeployments)
    if (!config.runtimeObserver) throw new Error('plugin-control-plane: foregroundDeployments requires runtimeObserver')
  }
  if (config.taskObservations !== undefined) {
    validateTaskObservationConfig(config.taskObservations)
    if (!config.foregroundDeployments || config.taskObservations.profilePath !== config.runtimeObserver?.profilePath) {
      throw new Error('plugin-control-plane: taskObservations requires foregroundDeployments on the same profile')
    }
  }
  if (config.liveQualification !== undefined) {
    validateLiveQualificationConfig(config.liveQualification)
    if (!config.foregroundDeployments || config.liveQualification.profilePath !== config.runtimeObserver?.profilePath) {
      throw new Error('plugin-control-plane: liveQualification requires foregroundDeployments on the same profile')
    }
    if (!config.sourceAdoptions?.liveQualification || !config.sourceReleaseExecution?.independentReview
      || !config.taskObservations || config.taskObservations.profilePath !== config.liveQualification.profilePath
      || config.sourceAdoptions.profile !== basename(config.liveQualification.profilePath)) {
      throw new Error('plugin-control-plane: liveQualification requires independently reviewed sourceAdoptions')
    }
  }
  if (config.replayEndpoint !== undefined) {
    validateReplayEndpointConfig(config.replayEndpoint)
    if (config.runtimeObserver !== undefined) {
      const observer = config.runtimeObserver, replay = config.replayEndpoint.runtime
      if (observer.socketPath === replay.socketPath || observer.keyPath === replay.keyPath) throw new Error('plugin-control-plane: replay requires a separate socket and key')
      const observerKey = readPrivateRuntimeObserverKey(observer.keyPath), replayKey = readPrivateRuntimeObserverKey(replay.keyPath)
      try { if (observerKey.equals(replayKey)) throw new Error('plugin-control-plane: replay requires distinct key material') }
      finally { observerKey.fill(0); replayKey.fill(0) }
    }
  }
  if (config.sourceApprovals !== undefined) validateSourceApprovalClientConfig(config.sourceApprovals)
  if (config.sourceBuild !== undefined) validateSourceBuildConfig(config.sourceBuild)
  if (config.sourceReleases !== undefined) {
    validateSourceReleaseClientConfig(config.sourceReleases)
    if (!config.sourceApprovals || config.sourceBuild?.versioning !== 'patch') throw new Error('plugin-control-plane: sourceReleases requires sourceApprovals and Host patch versioning')
  }
  if (config.sourceReleaseExecution !== undefined) {
    validateSourceReleaseExecutionConfig(config.sourceReleaseExecution)
    if (!config.sourceReleases) throw new Error('plugin-control-plane: sourceReleaseExecution requires sourceReleases')
  }
  if (config.adoptionCoordinator !== undefined) {
    validateAdoptionCoordinatorConfig(config.adoptionCoordinator)
    if (config.sourceJobs || config.sourceAdoptions || config.runtimeObserver || config.replayEndpoint) {
      throw new Error('plugin-control-plane: adoptionCoordinator requires a separate Host from target source jobs and observation')
    }
  }
  if (config.sourceAdoptions !== undefined) {
    validateSourceAdoptionConfig(config.sourceAdoptions)
    if (!config.sourceReleaseExecution) throw new Error('plugin-control-plane: sourceAdoptions requires sourceReleaseExecution')
    if (config.sourceAdoptions.liveQualification && !config.liveQualification) {
      throw new Error('plugin-control-plane: bounded-live sourceAdoptions requires liveQualification runtime')
    }
  }
  if (config.sourceJobs !== undefined) {
    validateSourceJobsConfig(config.sourceJobs, config.sourceBuild)
    if (realpathSync(config.sourceJobs.repository) !== config.sourceJobs.repository) throw new Error('plugin-control-plane: sourceJobs.repository must be canonical')
  }
  if (config.creationVerifications !== undefined) {
    const policy = config.creationVerifications
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).sort().join(',') !== 'authority,publicKey'
      || typeof policy.publicKey !== 'string' || policy.publicKey.length > 4096) {
      throw new Error('plugin-control-plane: invalid creation verification configuration')
    }
    validateCreationAcceptanceAuthorityRef(policy.authority)
    let key: ReturnType<typeof createPublicKey>
    try { key = createPublicKey(policy.publicKey) } catch { throw new Error('plugin-control-plane: creation verification public key is invalid') }
    if (!policy.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n') || key.asymmetricKeyType !== 'ed25519' || key.type !== 'public'
      || key.export({ format: 'pem', type: 'spki' }).toString() !== policy.publicKey
      || policy.authority.expiresAt <= Date.now()
      || !config.sourceJobs?.creation || policy.authority.namePrefix !== config.sourceJobs.creation.namePrefix
      || policy.authority.expiresAt > Math.min(config.sourceJobs.creation.expiresAt, config.sourceJobs.expiresAt)) {
      throw new Error('plugin-control-plane: creation verification authority does not match finite source creation grant')
    }
  }
  if (![config.catalogPath, config.statePath, config.trustPath].every(isAbsolute)) throw new Error('plugin-control-plane: catalogPath, statePath and trustPath must be absolute')
  return config
}

export class PluginControlPlaneService extends Service {
  static Config = schema
  private readonly config: NormalizedControlPlaneConfig
  private readonly store: ControlPlaneStore
  private readonly taskGaps: OwnerTaskFailureGaps
  private readonly abort = new AbortController()
  private readonly sourceBuilds = new Set<Promise<unknown>>()
  private readonly sourceInspections = new Set<Promise<unknown>>()
  private readonly sourceApprovalFlights = new Set<Promise<unknown>>()
  private readonly sourceReleaseFlights = new Set<Promise<unknown>>()
  private readonly sourceReleaseAdvances = new Map<string, Promise<PluginSourcePlan>>()
  private readonly sourceAdoptionFlights = new Map<string, Promise<PluginActivationPlan>>()
  private readonly foregroundObservers = new Set<ForegroundTaskObservationRegistration>()
  private liveRuntime: LiveQualificationRuntime | undefined
  private assertLiveRuntime: ((planId: string) => void) | undefined
  private sourceRuntime: SourceJobRuntime | undefined
  private readonly sourceRuntimes = new Set<SourceJobRuntime>()
  private growthRunProducer: SourceGrowthRunProducer | undefined
  private growthProviderDraining = false

  constructor(ctx: Context, input: Config) {
    super(ctx, 'pluginControlPlane')
    this.config = normalizeControlPlaneConfig(input)
    this.store = new ControlPlaneStore({ path: join(this.config.statePath, 'control.sqlite') })
    this.taskGaps = new OwnerTaskFailureGaps(this.store, () => {
      this.abort.signal.throwIfAborted()
      const delivery = ctx.get('assistantDelivery' as never, false) as AssistantDeliveryService | undefined
      const evaluation = ctx.get('assistantEvaluation' as never, false) as AssistantEvaluationService | undefined
      if (typeof delivery?.inspectOwnerForegroundLearningTask !== 'function'
        || typeof evaluation?.withTrustedCanonicalTaskWriterFence !== 'function') throw new Error('plugin-control-plane: owner task source services unavailable')
      return { delivery, evaluation }
    })
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled([...this.sourceRuntimes].map(runtime => runtime.close()))
      await Promise.allSettled([...this.sourceBuilds, ...this.sourceInspections, ...this.sourceApprovalFlights, ...this.sourceReleaseFlights, ...this.sourceAdoptionFlights.values()])
      this.store.close()
    }, 'plugin-control-plane.store')
    installHostReadiness(ctx)
    ctx.inject(['tools'], toolsCtx => registerPluginControlTools(toolsCtx, this))
    if (this.config.runtimeObserver !== undefined) installRuntimeObserver(ctx, this.config.runtimeObserver,
      this.config.foregroundDeployments ? (observerCtx, sample) => {
        const fiber = observerCtx.inject(['assistantDelivery' as never], deliveryCtx => {
          deliveryCtx.effect(async () => {
            const snapshot = foregroundTrustSnapshot(this.config.trustPath)
            const trust = await this.boundTrust()
            let live = true
            const assertCurrent = () => {
              this.abort.signal.throwIfAborted()
              if (!live || foregroundTrustSnapshot(this.config.trustPath) !== snapshot) throw new Error('foreground deployment trust changed')
            }
            assertCurrent()
            const assertLiveRuntime = (planId: string): void => {
              assertCurrent()
              const plan = this.store.getPlan(planId)
              const operation = this.store.getLiveQualificationReadiness(planId)
              if (!operation.receipt) throw new Error('live qualification has no retained signed readiness')
              const binding = captureRetainedDeploymentReadiness({ plan, operation, receipt: operation.receipt, trust,
                journalPath: this.config.foregroundDeployments!.attestorJournalPath,
                runtime: sample(randomBytes(32).toString('hex')) })
              const window = this.store.getLiveQualificationWindow(planId)
              if (binding.receiptDigest !== window.readinessDigest || binding.hostGeneration !== window.hostGeneration) {
                throw new Error('live qualification runtime differs from retained readiness')
              }
              assertCurrent()
            }
            const requestRuntimeEpoch = (runtime: ReturnType<typeof sample>) => {
              assertCurrent()
              queueRuntimeEpoch(this.store, trust, runtime, (gapId, owner, callback) => this.taskGaps.withCurrent(gapId, owner, callback))
            }
            const registration = createForegroundDeploymentObserver({ config: this.config.foregroundDeployments!,
              profilePath: this.config.runtimeObserver!.profilePath, store: this.store, trust, sample, assertCurrent, owner: this, requestRuntimeEpoch })
            onHostReady(deliveryCtx, () => {
              try { requestRuntimeEpoch(sample(randomBytes(32).toString('hex'))) }
              catch { /* Initial deployment and inactive/retracted sources have no continuity work. */ }
            })
            this.foregroundObservers.add(registration)
            try {
              const delivery = deliveryCtx.get('assistantDelivery' as never) as unknown as AssistantDeliveryService
              const remove = delivery.registerForegroundTaskObserver(registration)
              if (this.config.liveQualification) {
                this.assertLiveRuntime = assertLiveRuntime
                this.liveRuntime?.scan()
              }
              return () => { live = false; if (this.assertLiveRuntime === assertLiveRuntime) this.assertLiveRuntime = undefined;
                this.liveRuntime?.scan()
                this.foregroundObservers.delete(registration); remove() }
            } catch (error) { live = false; if (this.assertLiveRuntime === assertLiveRuntime) this.assertLiveRuntime = undefined;
              this.foregroundObservers.delete(registration); throw error }
          }, 'plugin-control-plane.foreground-deployments')
        })
        return () => fiber.dispose()
      } : undefined)
    if (this.config.replayEndpoint !== undefined) installReplayEndpoint(ctx, this.config.replayEndpoint)
    if (this.config.adoptionCoordinator !== undefined) ctx.inject(['assistantAutomations' as never], coordinatorCtx => {
      coordinatorCtx.effect(async () => {
        const snapshot = foregroundTrustSnapshot(this.config.trustPath), trust = await this.boundTrust()
        this.abort.signal.throwIfAborted()
        const store = new ControlPlaneStore({ path: trust.ledger.path, adoptionCoordinatorId: this.config.adoptionCoordinator!.coordinatorId })
        const automations = () => coordinatorCtx.get('assistantAutomations' as never) as unknown as AssistantAutomationsService
        let runtime: AdoptionCoordinatorRuntime | undefined
        try {
          runtime = new AdoptionCoordinatorRuntime({ config: this.config.adoptionCoordinator!, store, trust,
            assertCurrent: () => {
              this.abort.signal.throwIfAborted()
              if (foregroundTrustSnapshot(this.config.trustPath) !== snapshot) throw new Error('adoption coordinator trust changed')
            },
            automations: {
              registerHostExecutor: input => automations().registerHostExecutor(input),
              reconcileSystem: input => automations().reconcileSystem(input),
              inspectSystemOwnedActivation: input => automations().inspectSystemOwnedActivation(input),
            },
          })
          runtime.start()
          const owner = 'plugin-control-plane-adoption-coordinator'
          const automationId = `adoption-coordinator-${controlPlaneDigest({
            coordinatorId: this.config.adoptionCoordinator!.coordinatorId,
            scope: this.config.adoptionCoordinator!.scope,
          }).slice(0, 40)}`
          const activationNonce = automations().inspectSystemOwnedActivation({ owner, automationId })?.activationNonce
          if (activationNonce === undefined) throw new Error('plugin-control-plane: adoption coordinator registration is missing')
          const stop = automations().registerHostShutdown(coordinatorCtx, { owner, automationId, activationNonce }, () => runtime!.close({ skipPause: true }))
          return stop
        } catch (error) {
          if (runtime) await runtime.close()
          else store.close()
          throw error
        }
      }, 'plugin-control-plane.adoption-coordinator')
    })
    if (this.config.taskObservations !== undefined) ctx.inject(['assistantAutomations', 'assistantDelivery', 'assistantEvaluation'] as never[], observerCtx => {
      observerCtx.effect(async () => {
        const snapshot = foregroundTrustSnapshot(this.config.trustPath), trust = await this.boundTrust()
        this.abort.signal.throwIfAborted()
        const store = new ControlPlaneStore({ path: trust.ledger.path })
        const evaluation = () => observerCtx.get('assistantEvaluation' as never) as unknown as AssistantEvaluationService
        const delivery = () => observerCtx.get('assistantDelivery' as never) as unknown as AssistantDeliveryService
        const automations = () => observerCtx.get('assistantAutomations' as never) as unknown as AssistantAutomationsService
        let runtime: TaskObservationRuntime | undefined
        try {
          runtime = new TaskObservationRuntime({ config: this.config.taskObservations!, store, trust,
            assertCurrent: () => {
              this.abort.signal.throwIfAborted()
              if (foregroundTrustSnapshot(this.config.trustPath) !== snapshot) throw new Error('task observation trust changed')
            },
            evaluation: {
              canonicalHostScope: input => evaluation().canonicalHostScope(input),
              getTrustedForegroundLearningProjection: input => evaluation().getTrustedForegroundLearningProjection(input),
              withTrustedCanonicalTaskWriterFence: (input, callback) => evaluation().withTrustedCanonicalTaskWriterFence(input, callback),
              onTrustedTaskChange: callback => evaluation().onTrustedTaskChange(callback),
            },
            delivery: {
              validateOwnerRoute: input => delivery().validateOwnerRoute(input),
              inspectOwnerForegroundLearningTask: input => delivery().inspectOwnerForegroundLearningTask(input),
            },
            automations: {
              registerHostExecutor: input => automations().registerHostExecutor(input),
              reconcileSystem: input => automations().reconcileSystem(input),
              inspectSystemOwnedActivation: input => automations().inspectSystemOwnedActivation(input),
            },
            rollback: (planId, signal) => rollbackPluginWatch({ store, trust, planId, signal }),
          })
          runtime.start()
          return () => runtime!.close()
        } catch (error) {
          if (runtime) await runtime.close()
          else store.close()
          throw error
        }
      }, 'plugin-control-plane.task-observations')
    })
    if (this.config.liveQualification !== undefined) ctx.inject(['assistantAutomations', 'assistantDelivery', 'assistantEvaluation'] as never[], observerCtx => {
      observerCtx.effect(async () => {
        const snapshot = foregroundTrustSnapshot(this.config.trustPath), trust = await this.boundTrust()
        this.abort.signal.throwIfAborted()
        const store = new ControlPlaneStore({ path: trust.ledger.path })
        const evaluation = () => observerCtx.get('assistantEvaluation' as never) as unknown as AssistantEvaluationService
        const delivery = () => observerCtx.get('assistantDelivery' as never) as unknown as AssistantDeliveryService
        const automations = () => observerCtx.get('assistantAutomations' as never) as unknown as AssistantAutomationsService
        let runtime: LiveQualificationRuntime | undefined
        try {
          runtime = new LiveQualificationRuntime({ config: this.config.liveQualification!, store, trust,
            assertCurrent: () => {
              this.abort.signal.throwIfAborted()
              if (foregroundTrustSnapshot(this.config.trustPath) !== snapshot) throw new Error('live qualification trust changed')
            },
            assertRuntime: planId => {
              if (!this.assertLiveRuntime) throw new Error('live qualification Host observer unavailable')
              this.assertLiveRuntime(planId)
            },
            runtimeAvailable: () => this.assertLiveRuntime !== undefined,
            qualificationSource: planId => {
              const plan = this.store.getPlan(planId)
              const reference = this.store.getOwnerTaskFailureReference(plan.gapId)
              if (!reference) throw new Error('live qualification original owner failure unavailable')
              return this.taskGaps.inspectCurrent(plan.gapId, reference.owner)
            },
            evaluation: {
              canonicalHostScope: input => evaluation().canonicalHostScope(input),
              getTrustedForegroundLearningProjection: input => evaluation().getTrustedForegroundLearningProjection(input),
              withTrustedCanonicalTaskWriterFence: (input, callback) => evaluation().withTrustedCanonicalTaskWriterFence(input, callback),
              onTrustedTaskChange: callback => evaluation().onTrustedTaskChange(callback),
            },
            delivery: {
              validateOwnerRoute: input => delivery().validateOwnerRoute(input),
              inspectOwnerForegroundLearningTask: input => delivery().inspectOwnerForegroundLearningTask(input),
            },
            automations: {
              registerHostExecutor: input => automations().registerHostExecutor(input),
              reconcileSystem: input => automations().reconcileSystem(input),
              inspectSystemOwnedActivation: input => automations().inspectSystemOwnedActivation(input),
            },
          })
          runtime.start()
          this.liveRuntime = runtime
          return async () => {
            if (this.liveRuntime === runtime) this.liveRuntime = undefined
            await runtime!.close()
          }
        } catch (error) {
          if (runtime) await runtime.close()
          else store.close()
          throw error
        }
      }, 'plugin-control-plane.live-qualification')
    })
    if (this.config.sourceJobs !== undefined) ctx.inject(['assistantAutomations' as never, 'assistantDelivery' as never,
      ...(this.config.sourceApprovals ? ['assistantEvaluation' as never] : []),
      ...(this.config.sourceReleaseExecution?.independentReview ? ['assistantVerifier', 'agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy'] as never[] : []),
      ...(this.config.creationVerifications ? ['assistantVerifier' as never] : [])], jobsCtx => {
      jobsCtx.effect(async () => {
        this.abort.signal.throwIfAborted()
        const current = <K extends keyof SourceJobPorts>(key: K): SourceJobPorts[K] => jobsCtx.get((key === 'automations' ? 'assistantAutomations' : 'assistantDelivery') as never) as unknown as SourceJobPorts[K]
        for (const method of ['registerHostExecutor', 'reconcileSystem', 'reconcileSystemExact', 'pauseSystemOwned',
          'inspectSystemOwnedActivation', 'inspectSystemOwned'] as const) {
          if (typeof current('automations')[method] !== 'function') throw new Error(`plugin-control-plane: durable source jobs require assistantAutomations.${method}`)
        }
        if (typeof current('delivery').validateOwnerRoute !== 'function') throw new Error('plugin-control-plane: durable source jobs require Delivery v2 owner validation')
        const runtime = new SourceJobRuntime({ config: this.config.sourceJobs!, build: this.config.sourceBuild!, statePath: this.config.statePath, store: this.store,
          ports: {
            automations: {
              registerHostExecutor: executor => current('automations').registerHostExecutor(executor),
              reconcileSystem: request => current('automations').reconcileSystem(request),
              reconcileSystemExact: request => current('automations').reconcileSystemExact(request),
              pauseSystemOwned: request => current('automations').pauseSystemOwned(request),
              inspectSystemOwnedActivation: request => current('automations').inspectSystemOwnedActivation(request),
              inspectSystemOwned: request => current('automations').inspectSystemOwned(request),
            },
            delivery: { validateOwnerRoute: request => current('delivery').validateOwnerRoute(request) },
          }, withGapSourceFence: (gapId, owner, callback) => this.taskGaps.withCurrent(gapId, owner, callback),
          assertGrowthRun: (run, gapId, owner, generation) => this.assertSourceGrowthRun(run, gapId, owner, generation),
          ...(this.config.creationVerifications ? { verifyPreparedCreation: (job: SourceJobRecord, signal: AbortSignal) =>
            this.verifyPreparedCreation(job, signal, () => jobsCtx.get('assistantVerifier' as never) as unknown as CreationVerifierPort) } : {}),
          ...(this.config.sourceApprovals ? { approvePrepared: async (job: SourceJobRecord, signal: AbortSignal) => {
            if (!job.planId) throw new Error('source job has no prepared plan')
            await this.requestOwnerSourceApproval({ planId: job.planId, signal, expectedTrustDigest: job.intent.trustDigest })
          } } : {}),
          ...(this.config.sourceReleases ? { releasePrepared: async (job: SourceJobRecord, signal: AbortSignal) => {
            if (!job.planId) throw new Error('source job has no prepared plan')
            await this.requestOwnerSourceRelease({ planId: job.planId, signal, expectedTrustDigest: job.intent.trustDigest })
          } } : {}),
          ...(this.config.sourceReleaseExecution ? { releaseTimeoutMs: this.config.sourceReleaseExecution.timeoutMs,
            advanceReleased: async (job: SourceJobRecord, signal: AbortSignal) => {
              if (!job.planId) throw new Error('source job has no release plan')
              await this.advanceOwnerSourceRelease({ planId: job.planId, signal, expectedTrustDigest: job.intent.trustDigest })
            } } : {}),
          ...(this.config.sourceAdoptions ? { adoptionTimeoutMs: this.config.sourceAdoptions.timeoutMs,
            adoptReleased: async (job: SourceJobRecord, signal: AbortSignal, assertCurrent: () => Promise<void>) => {
              if (!job.planId) throw new Error('source job has no released plan')
              await this.adoptOwnerSourceRelease({ sourcePlanId: job.planId, signal, expectedTrustDigest: job.intent.trustDigest, assertCurrent })
            } } : {}),
          trust: () => this.boundTrust(), prepare: (job, signal, assertCurrent) => this.prepareSourceJob(job, signal, assertCurrent),
        })
        this.sourceRuntimes.add(runtime)
        const close = async (): Promise<void> => {
          if (this.sourceRuntime === runtime) this.sourceRuntime = undefined
          try { await runtime.close() }
          finally { this.sourceRuntimes.delete(runtime) }
        }
        try {
          runtime.start()
          this.abort.signal.throwIfAborted()
          this.sourceRuntime = runtime
          return close
        } catch (error) {
          await close()
          throw error
        }
      }, 'plugin-control-plane.source-jobs')
    })
  }

  ownsForegroundTaskObservationRegistration = (registration: ForegroundTaskObservationRegistration): boolean =>
    !this.abort.signal.aborted && this.foregroundObservers.has(registration)

  /** Host-only readback. The current trusted task is reread; no caller rating is accepted. */
  inspectOwnerForegroundDeployment = (input: Parameters<AssistantDeliveryService['inspectOwnerForegroundLearningTask']>[0]): ForegroundDeploymentRecord | undefined => {
    this.abort.signal.throwIfAborted()
    const delivery = this.ctx.get('assistantDelivery' as never, false) as AssistantDeliveryService | undefined
    if (!delivery) throw new Error('foreground deployment Delivery unavailable')
    const source = delivery.inspectOwnerForegroundLearningTask(input)
    if (!source) return undefined
    const record = this.store.getForegroundDeployment(source.source.inboxId)
    if (!record || record.state !== 'observed' || !source.source.quiescent
      || record.task.sessionId !== source.source.sessionId
      || record.task.owner.principalRecordId !== source.owner.principalRecordId
      || record.task.owner.principalVersion !== source.owner.principalVersion
      || record.task.scope.workspace !== source.owner.workspace || record.task.scope.preset !== source.owner.agentPreset) return undefined
    return record
  }

  private async boundTrust(): Promise<Awaited<ReturnType<typeof loadTrustConfig>>> {
    const trust = await loadTrustConfig(this.config.trustPath)
    if (resolve(join(this.config.statePath, 'control.sqlite')) !== trust.ledger.path
      || resolve(this.config.catalogPath) !== trust.catalog.path) {
      throw new Error('plugin-control-plane: configured ledger/catalog do not match the owner trust binding')
    }
    return trust
  }

  async discover(capability: string): Promise<CatalogEntry[]> {
    await this.boundTrust()
    const loaded = await loadCatalogWithMetadata(this.config.catalogPath)
    return discover(loaded.catalog, capability)
  }

  /** Host only: reread the exact source; no caller text or ratings are admitted. */
  recordOwnerTaskFailureGap = (source: OwnerForegroundLearningTask): StoredCapabilityGap => {
    this.abort.signal.throwIfAborted()
    return this.taskGaps.record(source)
  }

  /** Host-only idempotent approval under a preconfigured finite authority. */
  requestOwnerSourceApproval = async (input: { planId: string; signal?: AbortSignal; expectedTrustDigest?: string }): Promise<PluginSourcePlan> => {
    this.abort.signal.throwIfAborted()
    const config = this.config.sourceApprovals
    if (!config) throw new Error('plugin-control-plane: source approval authority unavailable')
    const signal = AbortSignal.any([this.abort.signal, ...(input.signal ? [input.signal] : [])])
    const operation = (async () => {
      const plan = this.store.getSourcePlan(input.planId)
      const source = this.store.getOwnerTaskFailureReference(plan.gapId)
      if (!source || plan.mode !== 'modify' || !plan.sourceCheck || !plan.preparedEvidence) throw new Error('source approval requires a prepared owner task repair')
      signal.throwIfAborted()
      this.taskGaps.withCurrent(plan.gapId, source.owner, () => {})
      if (plan.status === 'approved') return plan
      if (plan.status !== 'pending-approval') throw new Error('source plan is not pending approval')
      const trust = await this.boundTrust()
      if (input.expectedTrustDigest !== undefined && controlPlaneDigest(trust) !== input.expectedTrustDigest) throw new Error('source job approval trust changed')
      const receipt = await requestSourceApproval(config, { protocol: 'dsh-source-approval/v1', planId: plan.id,
        planDigest: plan.digest, sourceReferenceDigest: controlPlaneDigest(source) }, signal)
      signal.throwIfAborted()
      if (controlPlaneDigest(await this.boundTrust()) !== controlPlaneDigest(trust)) throw new Error('source approval trust changed')
      const key = resolveTrustKey(trust, 'approval', receipt.authority, receipt.keyId)
      const result = await this.store.approveSource({ planId: plan.id, expectedRevision: plan.revision, receipt,
        resolveAuthority: () => new Ed25519ApprovalAuthority(key.publicKeyPem, key.authority, key.keyId),
        idempotencyKey: `source-authority:${plan.id}`, withSourceFence: callback => {
          signal.throwIfAborted()
          return this.taskGaps.withCurrent(plan.gapId, source.owner, callback)
        } })
      return result.result
    })()
    // The child has a bounded timeout and is drained before the store closes.
    this.sourceApprovalFlights.add(operation)
    try { return await operation } finally { this.sourceApprovalFlights.delete(operation) }
  }

  /** Host-only: enter the existing release state machine under a separate finite grant. */
  requestOwnerSourceRelease = async (input: { planId: string; signal?: AbortSignal; expectedTrustDigest?: string }): Promise<PluginSourcePlan> => {
    this.abort.signal.throwIfAborted()
    const config = this.config.sourceReleases
    if (!config) throw new Error('plugin-control-plane: source release authority unavailable')
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000), ...(input.signal ? [input.signal] : [])])
    const operation = (async () => {
      let plan = this.store.getSourcePlan(input.planId)
      const source = this.store.getOwnerTaskFailureReference(plan.gapId)
      if (!source || plan.mode !== 'modify' || !plan.sourceCheck || !plan.preparedEvidence) throw new Error('source release requires a prepared owner task repair')
      const withSourceFence = <T>(callback: () => T): T => {
        signal.throwIfAborted()
        return this.taskGaps.withCurrent(plan.gapId, source.owner, callback)
      }
      withSourceFence(() => {})
      const trust = await this.boundTrust()
      if (input.expectedTrustDigest !== undefined && controlPlaneDigest(trust) !== input.expectedTrustDigest) throw new Error('source job release trust changed')
      signal.throwIfAborted()
      if (trust.schemaVersion !== 4 || !trust.releaseRegistry || !trust.releaseRegistry.locator.startsWith('file:')) throw new Error('finite source release requires local schema-v4 release trust')
      // A committed release never requests a new signature, even after restart.
      if (plan.release !== undefined) return withSourceFence(() => plan)
      if (plan.status !== 'approved' && plan.status !== 'ready-for-human-review') throw new Error('source plan is not approved for release preparation')
      const checked = await verifyPreparedSourceWorktree(plan, inheritedEnvironment(trust), signal)
      if (plan.status === 'approved') plan = this.store.verifyPreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision,
        recheckedTreeDigest: checked.checkedTreeDigest, recheckedPatchDigest: checked.checkedPatchDigest, withSourceFence }).result
      withSourceFence(() => {})
      const authorization = await requestSourceReleaseAuthorization(config, { protocol: 'dsh-source-release-authorization/v1',
        planId: plan.id, planDigest: plan.digest, sourceReferenceDigest: controlPlaneDigest(source) }, signal)
      signal.throwIfAborted()
      if (controlPlaneDigest(await this.boundTrust()) !== controlPlaneDigest(trust)) throw new Error('source release trust changed')
      const policy = authorization.releasePolicy
      if (policy.registryId !== trust.releaseRegistry.id || policy.registryLocator !== trust.releaseRegistry.locator
        || policy.catalogId !== trust.catalog.id || policy.catalogPath !== trust.catalog.path
        || policy.packageName !== `@dsh-enhanced/${plan.name}` || policy.packagePath !== `plugins/${plan.name}`
        || policy.packageVersion !== plan.preparedEvidence!.pack.version) throw new Error('source release policy differs from configured trust or prepared package')
      const key = resolveTrustKey(trust, 'release-authorization', authorization.authority, authorization.keyId)
      return (await this.store.startSourceRelease({ planId: plan.id, expectedRevision: plan.revision, authorization,
        resolveAuthority: () => new Ed25519SourceReleaseAuthorizationAuthority(key.publicKeyPem, key.authority, key.keyId),
        idempotencyKey: `source-release-authorization:${authorization.authorizationId}`, withSourceFence, trust })).result
    })()
    this.sourceReleaseFlights.add(operation)
    try { return await operation } finally { this.sourceReleaseFlights.delete(operation) }
  }

  /** Host-only continuation, also used by an independent reviewer after its decision is ready. */
  advanceOwnerSourceRelease = async (input: { planId: string; signal?: AbortSignal; expectedTrustDigest?: string; receipt?: import('./types.js').SourceReleaseReceipt }): Promise<PluginSourcePlan> => {
    this.abort.signal.throwIfAborted()
    const config = this.config.sourceReleaseExecution
    if (!config) throw new Error('plugin-control-plane: source release execution unavailable')
    if (this.sourceReleaseAdvances.has(input.planId)) throw new Error('source release continuation already running')
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(config.timeoutMs), ...(input.signal ? [input.signal] : [])])
    const operation = (async () => {
      const plan = this.store.getSourcePlan(input.planId), source = this.store.getOwnerTaskFailureReference(plan.gapId)
      if (!source || plan.mode !== 'modify' || !plan.release) throw new Error('source release continuation requires an owner repair release')
      const reviewerAvailable = (operationId?: string) => {
        const reviewer = this.ctx.get('assistantVerifier' as never) as AssistantVerifierService | undefined
        const snapshot = this.taskGaps.snapshot(plan.gapId, source.owner)
        return reviewer?.canReviewSourceRepair?.({ decisionRoot: config.reviewDecisionRoot, owner: snapshot.owner, name: plan.name,
          ...(operationId === undefined ? {} : { operationId }),
          ...(snapshot.source.modelSelectionState === 'frozen' && snapshot.source.modelSelection
            ? { modelSelection: snapshot.source.modelSelection } : {}) }) === true
      }
      if (config.independentReview && plan.status === 'awaiting-pr' && !reviewerAvailable() && !input.receipt) return plan
      const withSourceFence = <T>(callback: () => T): T => { signal.throwIfAborted(); return this.taskGaps.withCurrent(plan.gapId, source.owner, callback) }
      withSourceFence(() => {})
      const trust = await this.boundTrust(), trustDigest = controlPlaneDigest(trust)
      if (input.expectedTrustDigest !== undefined && trustDigest !== input.expectedTrustDigest) throw new Error('source release continuation trust changed')
      const assertCurrent = async (): Promise<void> => {
        withSourceFence(() => {})
        if (controlPlaneDigest(await this.boundTrust()) !== trustDigest) throw new Error('source release continuation trust changed')
        withSourceFence(() => {})
      }
      if (input.receipt) {
        if (input.receipt.planId !== plan.id) throw new Error('release reconciliation receipt targets another plan')
        await assertCurrent()
        const { authorize, authority } = sourceReleaseAuthorities(trust)
        await this.store.acceptSourceReleaseReceipt({ operationId: input.receipt.operationId, expectedRevision: plan.revision,
          expectedFence: plan.release.fence, receipt: input.receipt, resolveAuthority: authority,
          resolveAuthorizationAuthority: authorize, withSourceFence })
      }
      return advanceSourceRelease({ store: this.store, planId: plan.id, trust, config, signal, assertCurrent, withSourceFence,
        review: async (request, currentPlan) => {
          const reviewer = this.ctx.get('assistantVerifier' as never) as AssistantVerifierService | undefined
          if (!reviewer || typeof reviewer.reviewSourceRepair !== 'function' || !reviewerAvailable(request.operationId)) return
          const snapshot = this.taskGaps.snapshot(plan.gapId, source.owner)
          await reviewer.reviewSourceRepair({ request: {
            protocol: 'dsh-source-review/v1', operationId: request.operationId,
            planId: currentPlan.id, planDigest: currentPlan.digest, releaseId: request.release.id,
            fence: request.release.fence, revision: request.plan.revision, name: currentPlan.name,
            ...request.input, checkedTreeDigest: request.authorization.checkedTreeDigest,
            checkedPatchDigest: request.authorization.checkedPatchDigest, scope: request.authorization.scope,
            source: { owner: snapshot.owner, outcomeId: source.outcomeId, sourceDigest: source.sourceDigest,
              objective: snapshot.source.objective,
              ...(snapshot.source.modelSelectionState === 'frozen' && snapshot.source.modelSelection
                ? { modelSelection: snapshot.source.modelSelection } : {}) },
          }, signal, withSourceFence })
        } })
    })()
    this.sourceReleaseAdvances.set(input.planId, operation); this.sourceReleaseFlights.add(operation)
    try { return await operation } finally { this.sourceReleaseAdvances.delete(input.planId); this.sourceReleaseFlights.delete(operation) }
  }

  /** Host only. Dedicated connection keeps activation writer locks out of the source job's connection. */
  adoptOwnerSourceRelease = async (input: { sourcePlanId: string; signal?: AbortSignal; expectedTrustDigest?: string; assertCurrent?: () => Promise<void> }): Promise<PluginActivationPlan> => {
    const config = this.config.sourceAdoptions
    if (!config) throw new Error('plugin-control-plane: source adoption authority unavailable')
    if (this.sourceAdoptionFlights.size !== 0) throw new Error('source adoption worker is already running')
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(config.timeoutMs), ...(input.signal ? [input.signal] : [])])
    const operation = (async () => {
      const plan = this.store.getSourcePlan(input.sourcePlanId)
      const source = this.store.getOwnerTaskFailureReference(plan.gapId)
      if (!source || plan.mode !== 'modify' || plan.status !== 'release-complete') throw new Error('source adoption requires a completed owner repair release')
      const current = <T>(callback: () => T): T => {
        signal.throwIfAborted()
        return this.taskGaps.withCurrent(plan.gapId, source.owner, callback)
      }
      const trust = await this.boundTrust(), trustDigest = controlPlaneDigest(trust)
      if (input.expectedTrustDigest !== undefined && trustDigest !== input.expectedTrustDigest) throw new Error('source adoption trust changed')
      const store = new ControlPlaneStore({ path: trust.ledger.path,
        withOwnerActivationFence: (gapId, callback) => {
          if (gapId !== plan.gapId) throw new Error('source adoption escaped its owner task')
          return current(callback)
        },
        withLiveQualificationFence: (planId, callback) => {
          if (!this.liveRuntime) throw new Error('live qualification runtime unavailable')
          return this.liveRuntime.withQualificationFence(planId, callback)
        } })
      const withSourceFence = <T>(callback: () => T): T => current(() => store.withOwnerTaskFailureGapAdmission(plan.gapId, callback))
      try {
        return await adoptSourceRelease({ store, sourcePlanId: plan.id, trust, config, signal, withSourceFence,
          assertCurrent: async () => {
            await input.assertCurrent?.()
            current(() => {})
            if (controlPlaneDigest(await this.boundTrust()) !== trustDigest) throw new Error('source adoption trust changed')
            current(() => {})
          } })
      } finally { store.close() }
    })()
    this.sourceAdoptionFlights.set(input.sourcePlanId, operation)
    try { return await operation } finally { this.sourceAdoptionFlights.delete(input.sourcePlanId) }
  }

  recordGap(input: CapabilityGapInput): StoredCapabilityGap { return this.store.recordGap(input) }
  gaps(limit: number): readonly StoredCapabilityGap[] { return this.store.listGaps(limit) }
  health(): PluginControlPlaneHealth { return this.store.health() }
  canPrepareSource(): boolean { return this.config.sourceBuild !== undefined }
  canEnqueueSource(): boolean { return this.sourceRuntime?.available() === true && !this.abort.signal.aborted }

  /** Host-only durable Usage reader; the caller's binding is always an expectation. */
  registerSourceGrowthRunProducer = (producer: SourceGrowthRunProducer): (() => Promise<void>) => {
    this.abort.signal.throwIfAborted()
    if (producer?.protocol !== 'assistant-growth-source-run-producer/v1' || typeof producer.inspect !== 'function'
      || this.growthRunProducer !== undefined || this.growthProviderDraining) throw new Error('plugin-control-plane: source growth run producer is invalid or already registered')
    this.growthRunProducer = producer
    try { this.sourceRuntime?.reconcileQueued() }
    catch (error) { this.growthRunProducer = undefined; throw error }
    return async () => {
      if (this.growthRunProducer !== producer) return
      this.growthRunProducer = undefined
      this.growthProviderDraining = true
      try { await this.sourceRuntime?.growthProviderDisposed() }
      finally { this.growthProviderDraining = false }
    }
  }

  /** Host readiness nudge after durable Usage becomes available. */
  reconcileSourceGrowthRuns = (): void => {
    this.abort.signal.throwIfAborted()
    if (this.growthRunProducer !== undefined) this.sourceRuntime?.reconcileQueued()
  }

  private assertSourceGrowthRun(expected: SourceGrowthRunBinding, gapId: string, owner: SourceJobOwnerReceipt, generation: boolean): void {
    validateSourceGrowthRunBinding(expected)
    const producer = this.growthRunProducer
    if (!producer) throw new SourceGrowthRunUnavailableError('source growth run producer unavailable')
    const actual = producer.inspect({ runId: expected.runId, intentDigest: expected.intentDigest })
    if (!actual) throw new Error('source growth run is absent or no longer current')
    validateSourceGrowthRunBinding(actual)
    if (sourceGrowthRunDigest(actual) !== sourceGrowthRunDigest(expected)
      || expected.ownerDigest !== controlPlaneDigest(owner)) throw new Error('source growth run immutable binding changed')
    const policy = this.config.creationVerifications?.authority
    if (expected.creationAcceptance !== undefined
      && (policy === undefined || controlPlaneDigest(policy) !== controlPlaneDigest(expected.creationAcceptance))) {
      throw new Error('source growth run creation acceptance policy changed or was not pinned before authoring')
    }
    const reference = this.store.getOwnerTaskFailureReference(gapId)
    if (!reference || expected.source.outcomeId !== reference.outcomeId
      || expected.source.sourceDigest !== reference.sourceDigest
      || controlPlaneDigest(expected.source.projection) !== controlPlaneDigest(reference.projection)
      || expected.ownerDigest !== controlPlaneDigest(reference.owner)) throw new Error('source growth run task reference changed')
    const current = this.taskGaps.inspectCurrent(gapId, owner)
    if (expected.modelOrigin === 'inherited-owner-task'
      && (current.source.modelSelectionState !== 'frozen'
        || controlPlaneDigest(current.source.modelSelection) !== controlPlaneDigest(expected.model))) {
      throw new Error('source growth run inherited model changed')
    }
    if (Date.now() >= expected.expiresAt || (generation && Date.now() >= expected.generationDeadlineAt)) {
      throw new Error('source growth run window expired')
    }
  }

  /** Private Host handoff. Never register this package reader as a model tool. */
  inspectPreparedCreation = (planId: string) => {
    this.abort.signal.throwIfAborted()
    const plan = this.store.getSourcePlan(planId)
    const reference = this.store.getOwnerTaskFailureReference(plan.gapId)
    if (!reference || plan.mode !== 'prepared-create' || plan.status !== 'pending-approval'
      || Date.now() >= plan.expiresAt || !plan.creation || Date.now() >= plan.creation.grant.expiresAt) {
      throw new Error('prepared creation package is unavailable for independent verification')
    }
    return this.taskGaps.withCurrent(plan.gapId, reference.owner, () => {
      this.abort.signal.throwIfAborted()
      const job = this.store.getPreparedSourceJob(plan.id)
      if (!plan.creation?.growthRun || !job.intent.creation?.growthRun) throw new Error('prepared creation lacks a frozen source growth run')
      this.assertSourceGrowthRun(plan.creation.growthRun, plan.gapId, reference.owner, false)
      return {
        protocol: 'dsh-prepared-creation/v1' as const,
        plan: structuredClone(plan), job: structuredClone(job), reference: structuredClone(reference),
        source: this.taskGaps.inspectCurrent(plan.gapId, reference.owner),
        artifact: this.store.readPreparedSourceArtifact(plan.id),
      }
    })
  }

  /** Host-only pre-author policy reference; never grants candidate or model authority. */
  inspectSourceCreationAcceptanceAuthority = (): CreationAcceptanceAuthorityRef | undefined => {
    const policy = this.config.creationVerifications?.authority
    if (this.abort.signal.aborted || !policy || Date.now() >= policy.expiresAt
      || Date.now() >= (this.config.sourceJobs?.creation?.expiresAt ?? 0)
      || Date.now() >= (this.config.sourceJobs?.expiresAt ?? 0)) return undefined
    return structuredClone(policy)
  }

  /** Synchronous Evaluation writer fence for an exact independently reviewed creation. */
  withPreparedCreationFence = <T>(input: { planId: string; planDigest: string; artifactSha256: string;
    growthRunDigest: string; referenceDigest: string }, callback: () => T): T => {
    this.abort.signal.throwIfAborted()
    const policy = this.inspectSourceCreationAcceptanceAuthority()
    if (!policy) throw new Error('creation verification authority unavailable')
    const plan = this.store.getSourcePlan(input.planId)
    const reference = this.store.getOwnerTaskFailureReference(plan.gapId)
    if (!reference) throw new Error('creation verification source unavailable')
    return this.taskGaps.withCurrent(plan.gapId, reference.owner, () => {
      this.abort.signal.throwIfAborted()
      const current = this.store.getSourcePlan(input.planId)
      const job = this.store.getPreparedSourceJob(input.planId)
      if (current.digest !== input.planDigest || current.mode !== 'prepared-create' || !current.creation?.growthRun
        || !job.intent.creation?.growthRun || !current.sourceCheck || !current.preparedEvidence
        || current.preparedEvidence.pack.sha256 !== input.artifactSha256
        || controlPlaneDigest(reference) !== input.referenceDigest
        || sourceGrowthRunDigest(current.creation.growthRun) !== input.growthRunDigest
        || sourceGrowthRunDigest(job.intent.creation.growthRun) !== input.growthRunDigest
        || !current.creation.growthRun.creationAcceptance
        || controlPlaneDigest(current.creation.growthRun.creationAcceptance) !== controlPlaneDigest(policy)
        || controlPlaneDigest(current.creation.grant) !== controlPlaneDigest(this.config.sourceJobs?.creation)) {
        throw new Error('creation verification exact source binding changed')
      }
      this.assertSourceGrowthRun(current.creation.growthRun, current.gapId, reference.owner, false)
      const artifact = this.store.readPreparedSourceArtifact(input.planId)
      if (createHash('sha256').update(artifact).digest('hex') !== input.artifactSha256) {
        throw new Error('creation verification artifact changed')
      }
      return callback()
    })
  }

  /** Independent reviewer reads the actual checked tree through a disposable Git index. */
  inspectPreparedCreationReviewContext = async (planId: string, signal: AbortSignal): Promise<{ patch: string; changedPaths: string[] }> => {
    const combined = AbortSignal.any([this.abort.signal, signal, AbortSignal.timeout(120_000)])
    combined.throwIfAborted()
    const prepared = this.inspectPreparedCreation(planId)
    const current = () => this.withPreparedCreationFence({ planId, planDigest: prepared.plan.digest,
      artifactSha256: prepared.plan.preparedEvidence!.pack.sha256,
      growthRunDigest: sourceGrowthRunDigest(prepared.plan.creation!.growthRun!),
      referenceDigest: controlPlaneDigest(prepared.reference) }, () => undefined)
    current()
    const trust = await this.boundTrust()
    const environment = inheritedEnvironment(trust)
    const job = prepared.job
    await verifyCreatedPluginWorkspace({ worktree: prepared.plan.worktree, baseCommit: prepared.plan.baseCommit,
      name: prepared.plan.name, environment, signal: combined, assertCurrent: current,
      creation: prepared.plan.creation!, files: job.intent.files })
    const review = await inspectPreparedCreationPatch(prepared.plan, environment, combined)
    current()
    return review
  }

  /** Signed behavior evidence over stored pack/checks. Adoption must await async review-context recheck. */
  inspectVerifiedCreation = (planId: string): PluginCreationVerificationCertificate | undefined => {
    const certificate = this.store.getCreationVerification(planId)
    if (!certificate) return undefined
    const config = this.config.creationVerifications
    if (!config || !verifyPluginCreationVerificationCertificate(certificate, config.authority, config.publicKey)) return undefined
    this.withPreparedCreationFence({ planId, planDigest: certificate.plan.digest,
      artifactSha256: certificate.plan.artifactSha256, growthRunDigest: certificate.source.growthRunDigest,
      referenceDigest: certificate.source.referenceDigest }, () => {
      const plan = this.store.getSourcePlan(planId)
      if (!plan.sourceCheck || !plan.preparedEvidence || certificate.plan.name !== plan.name
        || certificate.plan.generatorDigest !== plan.generatorDigest
        || certificate.plan.sourceTreeDigest !== plan.sourceCheck.treeDigest
        || certificate.plan.sourcePatchDigest !== plan.sourceCheck.patchDigest
        || certificate.plan.artifactBytes !== plan.preparedEvidence.pack.sizeBytes) {
        throw new Error('creation verification exact plan evidence changed')
      }
    })
    return structuredClone(certificate)
  }

  /** Private Host diagnostic; no cases, prompts, source bytes or verifier output. */
  inspectCreationVerification = (planId: string): { status: 'claimed' | 'verified' | 'unknown' | 'rejected';
    reason?: string; updatedAt: number } | undefined => {
    this.abort.signal.throwIfAborted()
    const plan = this.store.getSourcePlan(planId)
    const reference = this.store.getOwnerTaskFailureReference(plan.gapId)
    if (!reference || plan.mode !== 'prepared-create') throw new Error('creation verification owner source unavailable')
    return this.taskGaps.withCurrent(plan.gapId, reference.owner, () => {
      const current = this.store.getSourcePlan(planId)
      if (current.mode !== 'prepared-create' || current.digest !== plan.digest) {
        throw new Error('creation verification diagnostic plan changed')
      }
      return this.store.inspectCreationVerificationRecord(planId)
    })
  }

  /** Public naming rule only; never disclose grant identity or mutation authority. */
  getSourceCreationNamespace(): { namePrefix: string } | undefined {
    const config = this.config.sourceJobs
    if (this.abort.signal.aborted || config?.creation === undefined
      || Date.now() >= Math.min(config.expiresAt, config.creation.expiresAt)) return undefined
    return { namePrefix: config.creation.namePrefix }
  }

  // Bind Host entry points: Cordis service proxies must not become resource owners.
  enqueueSourceJob = async (input: EnqueueSourceJobInput): Promise<SourceJobProjection> => {
    this.abort.signal.throwIfAborted()
    const runtime = this.sourceRuntime
    if (runtime === undefined || !runtime.available()) throw new Error('plugin-control-plane: durable source jobs unavailable')
    if (this.sourceBuilds.size !== 0 || this.sourceInspections.size !== 0) throw new Error('plugin-control-plane: another source operation is draining')
    const operation = runtime.enqueue(input)
    this.sourceInspections.add(operation)
    try { return await operation } finally { this.sourceInspections.delete(operation) }
  }

  inspectSourceJob = (input: { id: string; owner: SourceJobCaller }): SourceJobProjection => {
    if (this.sourceRuntime === undefined) throw new Error('plugin-control-plane: durable source jobs unavailable')
    return this.sourceRuntime.inspect(input)
  }

  reconcileSourceJob = (input: { id: string; owner: SourceJobCaller }): Promise<SourceJobProjection> => {
    if (this.sourceRuntime === undefined || this.sourceBuilds.size !== 0) throw new Error('plugin-control-plane: durable source jobs unavailable or still draining')
    return this.sourceRuntime.reconcileUnknown(input)
  }

  private async prepareSourceJob(job: SourceJobRecord, signal: AbortSignal, assertCurrent: () => Promise<void>): Promise<PluginSourcePlan> {
    this.abort.signal.throwIfAborted()
    if (this.sourceBuilds.size !== 0 || this.sourceInspections.size !== 0) throw new Error('plugin-control-plane: another source operation is draining')
    const intent = job.intent
    const operation = this.prepareSourcePlanOwned({ gapId: intent.gapId, name: intent.name, repository: intent.repository, files: intent.files,
      idempotencyKey: `source-job-plan:${job.id}`, expectedBaseCommit: intent.baseCommit, ttlMs: intent.ttlMs, timeoutMs: intent.build.timeoutMs, offline: true, signal, assertCurrent }, job)
    this.sourceBuilds.add(operation)
    try { return await operation } finally { this.sourceBuilds.delete(operation) }
  }

  private async verifyPreparedCreation(job: SourceJobRecord, signal: AbortSignal,
    verifier: () => CreationVerifierPort): Promise<void> {
    signal.throwIfAborted()
    if (!job.planId || !this.config.creationVerifications || this.store.getCreationVerificationStatus(job.planId) !== undefined) return
    const prepared = this.inspectPreparedCreation(job.planId)
    if (prepared.job.id !== job.id || !prepared.plan.creation?.growthRun || !prepared.plan.preparedEvidence) {
      throw new Error('creation verification job is not the exact prepared source')
    }
    const binding = { planId: prepared.plan.id, planDigest: prepared.plan.digest,
      artifactSha256: prepared.plan.preparedEvidence.pack.sha256,
      growthRunDigest: sourceGrowthRunDigest(prepared.plan.creation.growthRun),
      referenceDigest: controlPlaneDigest(prepared.reference) }
    this.withPreparedCreationFence(binding, () => this.store.claimCreationVerification(job.planId!))
    try {
      const current = verifier()
      if (typeof current?.verifyPluginCreation !== 'function') throw new Error('independent creation verifier unavailable')
      const result = await current.verifyPluginCreation({ protocol: 'assistant-growth/creation-verification-request/v1', planId: job.planId }, signal)
      signal.throwIfAborted()
      if (result.status === 'verified' && !verifyPluginCreationVerificationCertificate(result.certificate,
        this.config.creationVerifications.authority, this.config.creationVerifications.publicKey)) {
        throw new Error('creation verification certificate signature or policy invalid')
      }
      if (controlPlaneDigest(await this.boundTrust()) !== job.intent.trustDigest) throw new Error('creation verification trust changed')
      await this.inspectPreparedCreationReviewContext(job.planId, signal)
      this.withPreparedCreationFence(binding, () => {
        if (result.status === 'verified') {
          this.store.recordCreationVerification(result.certificate)
        } else this.store.settleCreationVerification(job.planId!, result.status,
          typeof result.reason === 'string' && (result.status === 'unknown' ? CREATION_UNKNOWN_CODES : CREATION_REJECTED_CODES).has(result.reason)
            ? result.reason : `independent-verifier-${result.status}`)
      })
    } catch (error) {
      // The claimed row is a durable no-replay fence even if the process dies
      // before settlement. A later native tick cannot dispatch another review.
      try { this.withPreparedCreationFence(binding, () => {
        if (this.store.getCreationVerificationStatus(job.planId!) === 'claimed') {
          this.store.settleCreationVerification(job.planId!, 'unknown', 'independent-verification-unsettled')
        }
      }) } catch { /* stale owner/source remains permanently claimed */ }
      throw error
    }
  }

  async inspectSource(input: { repository: string; name: string; paths: readonly string[]; baseCommit?: string; signal?: AbortSignal; assertCurrent?: () => void | Promise<void> }): Promise<SourceInspection> {
    this.abort.signal.throwIfAborted()
    if (this.sourceBuilds.size !== 0 || this.sourceInspections.size !== 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'another source operation is still draining')
    const signal = AbortSignal.any([this.abort.signal, ...(input.signal === undefined ? [] : [input.signal]), AbortSignal.timeout(15_000)])
    const operation = this.inspectSourceOwned({ ...input, signal })
    this.sourceInspections.add(operation)
    void operation.then(() => this.sourceInspections.delete(operation), () => this.sourceInspections.delete(operation))
    return operation
  }

  private async inspectSourceOwned(input: Parameters<PluginControlPlaneService['inspectSource']>[0]): Promise<SourceInspection> {
    const signal = input.signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, input.signal])
    const assertCurrent = async (): Promise<void> => { signal.throwIfAborted(); await awaitSourceSignal(signal, () => input.assertCurrent?.()); signal.throwIfAborted() }
    await assertCurrent()
    const trust = await awaitSourceSignal(signal, () => this.boundTrust())
    const environment = inheritedEnvironment(trust)
    const baseline = this.config.sourceJobs?.repository === input.repository ? this.config.sourceJobs.baseline : undefined
    const baselineCommit = baseline === undefined ? undefined : await resolveSourceBaseline({ repository: input.repository,
      config: baseline, environment, signal, assertCurrent, trust,
      readHistory: () => this.store.getSourceBaselineHistory(input.repository),
      readMaintenance: () => this.store.getSourceMaintenanceRecords(input.repository) })
    return inspectSourceContext({ repository: input.repository, name: input.name, paths: input.paths,
      ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
      ...(baselineCommit === undefined ? {} : { baselineCommit }), environment, signal, assertCurrent })
  }

  async inspectCreateSource(input: Parameters<PluginControlPlaneService['inspectSource']>[0]): Promise<SourceInspection> {
    this.abort.signal.throwIfAborted()
    if (this.sourceBuilds.size !== 0 || this.sourceInspections.size !== 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'another source operation is still draining')
    const signal = AbortSignal.any([this.abort.signal, ...(input.signal === undefined ? [] : [input.signal]), AbortSignal.timeout(15_000)])
    const operation = this.inspectCreateSourceOwned({ ...input, signal })
    this.sourceInspections.add(operation)
    try { return await operation } finally { this.sourceInspections.delete(operation) }
  }

  private async inspectCreateSourceOwned(input: Parameters<PluginControlPlaneService['inspectSource']>[0]): Promise<SourceInspection> {
    const config = this.config.sourceJobs
    if (!config?.creation || config.repository !== input.repository) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin creation authority is not configured for this repository')
    const signal = input.signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, input.signal])
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted(); await awaitSourceSignal(signal, () => input.assertCurrent?.()); signal.throwIfAborted()
      if (Date.now() >= config.creation!.expiresAt || Date.now() >= config.expiresAt) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin creation authority expired')
    }
    await assertCurrent()
    const trust = await awaitSourceSignal(signal, () => this.boundTrust())
    const environment = inheritedEnvironment(trust)
    const baselineCommit = config.baseline === undefined ? undefined : await resolveSourceBaseline({ repository: input.repository,
      config: config.baseline, environment, signal, assertCurrent, trust,
      readHistory: () => this.store.getSourceBaselineHistory(input.repository),
      readMaintenance: () => this.store.getSourceMaintenanceRecords(input.repository) })
    const inspected = await inspectSourceCreationContext({ repository: input.repository, name: input.name, paths: input.paths,
      ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
      ...(baselineCommit === undefined ? {} : { baselineCommit }), environment, signal, assertCurrent, grant: config.creation })
    return { name: inspected.name, baseCommit: inspected.baseCommit, files: inspected.files, contents: inspected.contents }
  }

  async plan(candidateId: string, profile: string, idempotencyKey: string, gapId: string): Promise<PluginActivationPlan> {
    const gap = this.store.getGap(gapId)
    const loaded = await loadCatalogWithMetadata(this.config.catalogPath)
    const matches = discover(loaded.catalog, gap.capability)
    const candidate = matches.find(item => item.id === candidateId)
    if (candidate === undefined) throw new Error('plugin-control-plane: candidate does not match the exact open capability gap')
    const trust = await this.boundTrust()
    if (profile.normalize('NFC').trim() !== profile) throw new Error('plugin-control-plane: profile must already be canonical text')
    const target = await canonicalTarget(trust.dshHome, profile)
    return this.store.createPlan({ candidate, catalog: loaded, matchedCapabilities: candidate.capabilities,
      profile, target, installationId: trust.installationId, ledger: trust.ledger,
      executor: { id: trust.executor.id, version: trust.executor.version, path: trust.executor.path, sha256: trust.executor.sha256 }, ttlMs: this.config.proposalTtlMs,
      gapId, idempotencyKey }).result
  }

  /**
   * Prepare a 'modify' source plan for an pre-existing control-plane open capability gap:
   * write the caller-supplied bounded patch into a fresh isolated worktree and
   * persist a pending plan.  The build gate is deliberately delegated to the
   * configured owner isolation runner; this Host service must never execute
   * proposal-controlled package scripts in its own process environment.
   *
   * This is a proposal-only entry point. It never approves, signs, releases,
   * activates, reloads or touches a production profile; the repository, base
   * commit, environment, timeouts and TTL are host-controlled and cannot be
   * supplied by the proposal caller. On any worktree/build failure the isolated
   * worktree is removed and no plan row is written and no gap is reserved.
   */
  async prepareModifySourcePlan(input: {
    gapId: string
    name: string
    repository: string
    files: readonly ScopedPluginFile[]
    idempotencyKey: string
    ttlMs?: number
    timeoutMs?: number
    offline?: boolean
    expectedBaseCommit?: string
    owner?: SourceJobCaller
    signal?: AbortSignal
    assertCurrent?: () => void | Promise<void>
  }): Promise<PluginSourcePlan> {
    this.abort.signal.throwIfAborted()
    if (this.sourceBuilds.size !== 0 || this.sourceInspections.size !== 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'another source operation is still draining')
    const operation = this.prepareSourcePlanOwned(input)
    this.sourceBuilds.add(operation)
    void operation.then(() => this.sourceBuilds.delete(operation), () => this.sourceBuilds.delete(operation))
    return operation
  }

  private async prepareSourcePlanOwned(input: Parameters<PluginControlPlaneService['prepareModifySourcePlan']>[0], sourceJob?: SourceJobRecord): Promise<PluginSourcePlan> {
    const signal = input.signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, input.signal])
    const gapOwner = sourceJob?.intent.owner ?? input.owner
    const creating = sourceJob?.intent.mode === 'create'
    const creation = creating ? sourceJob!.intent.creation : undefined
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted(); await input.assertCurrent?.(); signal.throwIfAborted()
      this.taskGaps.withCurrent(input.gapId, gapOwner, () => {})
      if (creating && (!creation || !this.config.sourceJobs?.creation || Date.now() >= creation.grant.expiresAt
        || controlPlaneDigest(creation.grant) !== controlPlaneDigest(this.config.sourceJobs.creation))) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'plugin creation authority changed or expired')
      }
    }
    await assertCurrent()
    const trust = await this.boundTrust()
    const name = input.name.normalize('NFC').trim()
    if (!/^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'plugin name is invalid')
    assertPluginModificationAllowed(name)
    if (creating) validateSourceCreationFiles(input.files)
    else {
      validateScopedPluginFiles(input.files)
      if (this.config.sourceBuild?.versioning === 'patch') assertManagedVersionPaths(input.files)
    }
    // Re-validate the gap reservation immediately before doing the work: the
    // store re-checks under BEGIN IMMEDIATE, but failing early avoids building
    // a patch against a gap that is already matched or closed.
    const gap = this.store.getGap(input.gapId)
    if (gap.status !== 'open' || gap.candidateId !== undefined) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'only an unreserved current control-plane open gap can receive a source proposal')
    }
    const repository = await realpath(resolve(input.repository))
    if (resolve(repository) !== repository) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository path must be canonical')
    const ttlMs = input.ttlMs ?? 86_400_000
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 900_000 || ttlMs > 86_400_000) {
      throw new ControlPlaneCliError('INVALID_ARGUMENT', 'ttlMs must be an integer within 900000..86400000')
    }
    const maximumTimeoutMs = this.config.sourceBuild?.profile === 'repository' ? 1_800_000 : 240_000
    const timeoutMs = input.timeoutMs ?? 180_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > maximumTimeoutMs) {
      throw new ControlPlaneCliError('INVALID_ARGUMENT', `timeoutMs must be an integer within 60000..${maximumTimeoutMs}`)
    }
    const offline = input.offline ?? true
    const environment = inheritedEnvironment(trust)
    const baseline = this.config.sourceJobs?.repository === repository ? this.config.sourceJobs.baseline : undefined
    const baseCommit = baseline === undefined
      ? (await runLocalCommand('git', ['rev-parse', 'HEAD'], repository, environment, { capture: true })).trim()
      : await resolveSourceBaseline({ repository, config: baseline, environment, signal, assertCurrent, trust,
        readHistory: () => this.store.getSourceBaselineHistory(repository),
        readMaintenance: () => this.store.getSourceMaintenanceRecords(repository) })
    await assertCurrent()
    if (!/^[a-f0-9]{40}$/u.test(baseCommit)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository HEAD is not a 40-hex commit id')
    if (input.expectedBaseCommit !== undefined && input.expectedBaseCommit !== baseCommit) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared source base commit is stale')

    const stateRoot = join(this.config.statePath, 'source-worktrees')
    const isolated = await createIsolatedWorktree({ stateRoot, repository, baseCommit, environment,
      ...(sourceJob === undefined ? {} : { worktreeName: basename(sourceJob.intent.worktree) }) })
    try {
      const generated = creation === undefined ? undefined : await prepareCreatedPluginWorkspace({ worktree: isolated.worktree,
        baseCommit, name, files: input.files, environment, signal, assertCurrent, creation })
      if (generated === undefined) await writeScopedPluginFiles({ worktree: isolated.worktree, name, files: input.files })
      await assertCurrent()
      if (this.config.sourceBuild === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'isolated source build runner is not configured')
      if (!offline) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'isolated source builds must remain offline')
      const configured = this.config.sourceBuild
      const versionInput = { worktree: isolated.worktree, baseCommit, name, environment, signal, assertCurrent }
      const managed = !creating && configured.versioning === 'patch' ? await managedPatchVersionFiles(versionInput) : undefined
      if (managed !== undefined) {
        await assertCurrent()
        await writeScopedPluginFiles({ worktree: isolated.worktree, name, files: managed.files })
        await verifyManagedPatchVersion(versionInput)
      }
      // Only owner-bound creation jobs retain the exact package for the
      // independent verifier. Ordinary source tools never receive these bytes.
      const capturePack = creating && this.store.getOwnerTaskFailureReference(input.gapId) !== undefined
      const checked = await runDockerPreparedChecks({ config: { ...configured, timeoutMs: Math.min(timeoutMs, configured.timeoutMs) },
        worktree: isolated.worktree, baseCommit, name, scope: generated?.scope ?? [`plugins/${name}`], environment, signal,
        assertCurrent, preparedAt: Date.now(), ...(creation === undefined ? {} : { creation }),
        ...(capturePack ? { capturePack: true } : {}),
        ...(sourceJob === undefined ? {} : { sourceJob: { id: sourceJob.id, containerName: sourceJob.intent.containerName } }) })
      await assertCurrent()
      if (capturePack && checked.packArtifact === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared creation artifact was not captured')
      if (creation !== undefined) {
        await verifyCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
          files: input.files, environment, signal, assertCurrent, creation })
        const manifest = JSON.parse(await readFile(join(isolated.worktree, 'plugins', name, 'package.json'), 'utf8')) as { version: string }
        if (checked.evidence.pack.version !== manifest.version) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin artifact does not carry the generated version')
      }
      if (managed !== undefined) {
        await verifyManagedPatchVersion(versionInput)
        if (checked.evidence.pack.version !== managed.version) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared artifact does not carry the Host-managed version')
      }
      // The worktree survives success: the owner recomputes its digests on this
      // exact directory during `source verify-prepared`.
      return this.taskGaps.withCurrent(input.gapId, gapOwner, () => this.store.createSourcePlan({ gapId: input.gapId, repository, worktree: isolated.worktree, baseCommit,
        name, generatorDigest: generated?.generatorDigest ?? MODIFY_GENERATOR_DIGEST,
        scope: generated?.scope ?? [`plugins/${name}`], mode: creating ? 'prepared-create' : 'modify', ttlMs,
        ...(creation === undefined ? {} : { creation }),
        ...(capturePack && checked.packArtifact !== undefined ? { preparedArtifact: checked.packArtifact } : {}),
        idempotencyKey: input.idempotencyKey,
        ...(sourceJob === undefined ? {} : { sourceJob: { jobId: sourceJob.id, jobRevision: sourceJob.revision, occurrenceId: sourceJob.occurrenceId! } }),
        prepared: { treeDigest: checked.treeDigest, patchDigest: checked.patchDigest, checkedAt: checked.checkedAt, evidence: checked.evidence } }).result)
    } catch (error) {
      await isolated.remove()
      throw error
    }
  }

  /**
   * Garbage-collect prepared modify worktrees whose plans expired while still
   * pending owner action. The trust binding is re-checked first.
   */
  async gcPreparedSourceWorktrees(now: number = Date.now()): Promise<{ removed: readonly string[] }> {
    const trust = await this.boundTrust()
    return gcPreparedModifyWorktrees({ store: this.store,
      statePath: this.config.statePath, environment: inheritedEnvironment(trust), now })
  }
}

export type { PluginActivationPlan } from './types.js'
export const Config = schema
