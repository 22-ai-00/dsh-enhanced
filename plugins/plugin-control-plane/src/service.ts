import { lstat, realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
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
import { inheritedEnvironment, loadTrustConfig, resolveTrustKey } from './trust.js'
import type { CapabilityGapInput, PluginActivationPlan, PluginControlPlaneHealth, PluginSourcePlan, StoredCapabilityGap } from './types.js'
import { registerPluginControlTools } from './tools.js'
import { SourceJobRuntime, validateSourceJobsConfig, type EnqueueSourceJobInput, type SourceJobCaller, type SourceJobPorts } from './source-jobs.js'
import type { SourceJobProjection, SourceJobRecord, SourceJobsConfig } from './source-job-types.js'
import { installRuntimeObserver, validateRuntimeObserverConfig, type RuntimeObserverConfig } from './runtime-observer.js'
import { installReplayEndpoint, validateReplayEndpointConfig, type ReplayEndpointConfig } from './replay-endpoint.js'
import { readPrivateRuntimeObserverKey } from './runtime-observer-protocol.js'

export interface Config {
  catalogPath: string
  statePath: string
  trustPath: string
  proposalTtlMs?: number
  /** Optional for legacy deployments; required by prepareModifySourcePlan. */
  sourceBuild?: SourceBuildConfig
  /** Explicit, expiring Host authority for work that outlives a model wake. */
  sourceJobs?: SourceJobsConfig
  /** Optional finite owner authority; only approves prepared task-bound source, never deploys it. */
  sourceApprovals?: SourceApprovalClientConfig
  /** Optional separate finite authority for entering the local release state machine. */
  sourceReleases?: SourceReleaseClientConfig
  /** Explicit local phase execution, optionally requesting separately authorized review. */
  sourceReleaseExecution?: SourceReleaseExecutionConfig
  /** Finite owner adoption of an exact completed repair into a configured profile. */
  sourceAdoptions?: SourceAdoptionConfig
  /** Explicit owner-only observation channel; no signing or activation authority. */
  runtimeObserver?: RuntimeObserverConfig
  /** Owner-pinned finite native replay; separate from the read-only observer. */
  replayEndpoint?: ReplayEndpointConfig
}
const schema = Schema.object({
  catalogPath: Schema.string().required(), statePath: Schema.string().required(), trustPath: Schema.string().required(),
  proposalTtlMs: Schema.number().step(1).min(60_000).max(86_400_000).default(900_000),
  sourceBuild: Schema.any(),
  sourceJobs: Schema.any(),
  sourceApprovals: Schema.any(),
  sourceReleases: Schema.any(),
  sourceReleaseExecution: Schema.any(),
  sourceAdoptions: Schema.any(),
  runtimeObserver: Schema.any(),
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

export class PluginControlPlaneService extends Service {
  static Config = schema
  private readonly config: Required<Omit<Config, 'sourceBuild' | 'sourceJobs' | 'sourceApprovals' | 'sourceReleases' | 'sourceReleaseExecution' | 'sourceAdoptions' | 'runtimeObserver' | 'replayEndpoint'>> & Pick<Config, 'sourceBuild' | 'sourceJobs' | 'sourceApprovals' | 'sourceReleases' | 'sourceReleaseExecution' | 'sourceAdoptions' | 'runtimeObserver' | 'replayEndpoint'>
  private readonly store: ControlPlaneStore
  private readonly taskGaps: OwnerTaskFailureGaps
  private readonly abort = new AbortController()
  private readonly sourceBuilds = new Set<Promise<unknown>>()
  private readonly sourceInspections = new Set<Promise<unknown>>()
  private readonly sourceApprovalFlights = new Set<Promise<unknown>>()
  private readonly sourceReleaseFlights = new Set<Promise<unknown>>()
  private readonly sourceReleaseAdvances = new Map<string, Promise<PluginSourcePlan>>()
  private readonly sourceAdoptionFlights = new Map<string, Promise<PluginActivationPlan>>()
  private sourceRuntime: SourceJobRuntime | undefined
  private readonly sourceRuntimes = new Set<SourceJobRuntime>()

  constructor(ctx: Context, input: Config) {
    super(ctx, 'pluginControlPlane')
    this.config = structuredClone(schema(input)) as typeof this.config
    if (this.config.runtimeObserver !== undefined) validateRuntimeObserverConfig(this.config.runtimeObserver)
    if (this.config.replayEndpoint !== undefined) {
      validateReplayEndpointConfig(this.config.replayEndpoint)
      if (this.config.runtimeObserver !== undefined) {
        const observer = this.config.runtimeObserver, replay = this.config.replayEndpoint.runtime
        if (observer.socketPath === replay.socketPath || observer.keyPath === replay.keyPath) throw new Error('plugin-control-plane: replay requires a separate socket and key')
        const observerKey = readPrivateRuntimeObserverKey(observer.keyPath), replayKey = readPrivateRuntimeObserverKey(replay.keyPath)
        try { if (observerKey.equals(replayKey)) throw new Error('plugin-control-plane: replay requires distinct key material') }
        finally { observerKey.fill(0); replayKey.fill(0) }
      }
    }
    if (this.config.sourceApprovals !== undefined) validateSourceApprovalClientConfig(this.config.sourceApprovals)
    if (this.config.sourceBuild !== undefined) validateSourceBuildConfig(this.config.sourceBuild)
    if (this.config.sourceReleases !== undefined) {
      validateSourceReleaseClientConfig(this.config.sourceReleases)
      if (!this.config.sourceApprovals || this.config.sourceBuild?.versioning !== 'patch') throw new Error('plugin-control-plane: sourceReleases requires sourceApprovals and Host patch versioning')
    }
    if (this.config.sourceReleaseExecution !== undefined) {
      validateSourceReleaseExecutionConfig(this.config.sourceReleaseExecution)
      if (!this.config.sourceReleases) throw new Error('plugin-control-plane: sourceReleaseExecution requires sourceReleases')
    }
    if (this.config.sourceAdoptions !== undefined) {
      validateSourceAdoptionConfig(this.config.sourceAdoptions)
      if (!this.config.sourceReleaseExecution) throw new Error('plugin-control-plane: sourceAdoptions requires sourceReleaseExecution')
    }
    if (this.config.sourceJobs !== undefined) {
      validateSourceJobsConfig(this.config.sourceJobs, this.config.sourceBuild)
      if (realpathSync(this.config.sourceJobs.repository) !== this.config.sourceJobs.repository) throw new Error('plugin-control-plane: sourceJobs.repository must be canonical')
    }
    if (![this.config.catalogPath, this.config.statePath, this.config.trustPath].every(isAbsolute)) throw new Error('plugin-control-plane: catalogPath, statePath and trustPath must be absolute')
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
    ctx.inject(['tools'], toolsCtx => registerPluginControlTools(toolsCtx, this))
    if (this.config.runtimeObserver !== undefined) installRuntimeObserver(ctx, this.config.runtimeObserver)
    if (this.config.replayEndpoint !== undefined) installReplayEndpoint(ctx, this.config.replayEndpoint)
    if (this.config.sourceJobs !== undefined) ctx.inject(['assistantAutomations' as never, 'assistantDelivery' as never,
      ...(this.config.sourceApprovals ? ['assistantEvaluation' as never] : []),
      ...(this.config.sourceReleaseExecution?.independentReview ? ['assistantVerifier', 'agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy'] as never[] : [])], jobsCtx => {
      jobsCtx.effect(() => {
        const current = <K extends keyof SourceJobPorts>(key: K): SourceJobPorts[K] => jobsCtx.get((key === 'automations' ? 'assistantAutomations' : 'assistantDelivery') as never) as unknown as SourceJobPorts[K]
        for (const method of ['registerHostExecutor', 'reconcileSystem', 'inspectSystemOwnedActivation', 'inspectSystemOwned'] as const) {
          if (typeof current('automations')[method] !== 'function') throw new Error(`plugin-control-plane: durable source jobs require assistantAutomations.${method}`)
        }
        if (typeof current('delivery').validateOwnerRoute !== 'function') throw new Error('plugin-control-plane: durable source jobs require Delivery v2 owner validation')
        const runtime = new SourceJobRuntime({ config: this.config.sourceJobs!, build: this.config.sourceBuild!, statePath: this.config.statePath, store: this.store,
          ports: {
            automations: {
              registerHostExecutor: executor => current('automations').registerHostExecutor(executor),
              reconcileSystem: request => current('automations').reconcileSystem(request),
              inspectSystemOwnedActivation: request => current('automations').inspectSystemOwnedActivation(request),
              inspectSystemOwned: request => current('automations').inspectSystemOwned(request),
            },
            delivery: { validateOwnerRoute: request => current('delivery').validateOwnerRoute(request) },
          }, withGapSourceFence: (gapId, owner, callback) => this.taskGaps.withCurrent(gapId, owner, callback),
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
        runtime.start()
        this.sourceRuntimes.add(runtime)
        this.sourceRuntime = runtime
        return async () => {
          if (this.sourceRuntime === runtime) this.sourceRuntime = undefined
          await runtime.close()
          this.sourceRuntimes.delete(runtime)
        }
      }, 'plugin-control-plane.source-jobs')
    })
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
        idempotencyKey: `source-release-authorization:${authorization.authorizationId}`, withSourceFence })).result
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
    const operation = this.prepareModifySourcePlanOwned({ gapId: intent.gapId, name: intent.name, repository: intent.repository, files: intent.files,
      idempotencyKey: `source-job-plan:${job.id}`, expectedBaseCommit: intent.baseCommit, ttlMs: intent.ttlMs, timeoutMs: intent.build.timeoutMs, offline: true, signal, assertCurrent }, job)
    this.sourceBuilds.add(operation)
    try { return await operation } finally { this.sourceBuilds.delete(operation) }
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
    return inspectSourceContext({ ...input, environment: inheritedEnvironment(trust), signal, assertCurrent })
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
    const operation = this.prepareModifySourcePlanOwned(input)
    this.sourceBuilds.add(operation)
    void operation.then(() => this.sourceBuilds.delete(operation), () => this.sourceBuilds.delete(operation))
    return operation
  }

  private async prepareModifySourcePlanOwned(input: Parameters<PluginControlPlaneService['prepareModifySourcePlan']>[0], sourceJob?: SourceJobRecord): Promise<PluginSourcePlan> {
    const signal = input.signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, input.signal])
    const gapOwner = sourceJob?.intent.owner ?? input.owner
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted(); await input.assertCurrent?.(); signal.throwIfAborted()
      this.taskGaps.withCurrent(input.gapId, gapOwner, () => {})
    }
    await assertCurrent()
    const trust = await this.boundTrust()
    const name = input.name.normalize('NFC').trim()
    if (!/^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'plugin name is invalid')
    assertPluginModificationAllowed(name)
    validateScopedPluginFiles(input.files)
    if (this.config.sourceBuild?.versioning === 'patch') assertManagedVersionPaths(input.files)
    // Re-validate the gap reservation immediately before doing the work: the
    // store re-checks under BEGIN IMMEDIATE, but failing early avoids building
    // a patch against a gap that is already matched or closed.
    const gap = this.store.getGap(input.gapId)
    if (gap.status !== 'open' || gap.candidateId !== undefined) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'only an unreserved pre-existing control-plane open gap can receive a modify proposal')
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
    const baseCommit = (await runLocalCommand('git', ['rev-parse', 'HEAD'], repository, environment, { capture: true })).trim()
    await assertCurrent()
    if (!/^[a-f0-9]{40}$/u.test(baseCommit)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository HEAD is not a 40-hex commit id')
    if (input.expectedBaseCommit !== undefined && input.expectedBaseCommit !== baseCommit) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared source base commit is stale')

    const stateRoot = join(this.config.statePath, 'source-worktrees')
    const isolated = await createIsolatedWorktree({ stateRoot, repository, baseCommit, environment,
      ...(sourceJob === undefined ? {} : { worktreeName: basename(sourceJob.intent.worktree) }) })
    try {
      await writeScopedPluginFiles({ worktree: isolated.worktree, name, files: input.files })
      await assertCurrent()
      if (this.config.sourceBuild === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'isolated source build runner is not configured')
      if (!offline) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'isolated source builds must remain offline')
      const configured = this.config.sourceBuild
      const versionInput = { worktree: isolated.worktree, baseCommit, name, environment, signal, assertCurrent }
      const managed = configured.versioning === 'patch' ? await managedPatchVersionFiles(versionInput) : undefined
      if (managed !== undefined) {
        await assertCurrent()
        await writeScopedPluginFiles({ worktree: isolated.worktree, name, files: managed.files })
        await verifyManagedPatchVersion(versionInput)
      }
      const checked = await runDockerPreparedChecks({ config: { ...configured, timeoutMs: Math.min(timeoutMs, configured.timeoutMs) },
        worktree: isolated.worktree, baseCommit, name, scope: [`plugins/${name}`], environment, signal,
        assertCurrent, preparedAt: Date.now(), ...(sourceJob === undefined ? {} : { sourceJob: { id: sourceJob.id, containerName: sourceJob.intent.containerName } }) })
      await assertCurrent()
      if (managed !== undefined) {
        await verifyManagedPatchVersion(versionInput)
        if (checked.evidence.pack.version !== managed.version) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared artifact does not carry the Host-managed version')
      }
      // The worktree survives success: the owner recomputes its digests on this
      // exact directory during `source verify-prepared`.
      return this.taskGaps.withCurrent(input.gapId, gapOwner, () => this.store.createSourcePlan({ gapId: input.gapId, repository, worktree: isolated.worktree, baseCommit,
        name, generatorDigest: MODIFY_GENERATOR_DIGEST, scope: [`plugins/${name}`], mode: 'modify', ttlMs,
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
