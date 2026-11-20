import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AssistantDreamingService } from '@dsh-enhanced/assistant-dreaming'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { BenchmarkPlan } from '@dsh-enhanced/assistant-evaluation/benchmark'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import type { EventTriggersService } from '@dsh-enhanced/event-triggers'
import type { PersonalMemoryService } from '@dsh-enhanced/personal-memory'
import type { PersonalWikiService } from '@dsh-enhanced/personal-wiki'
import {
  clusterEpisodes,
  detectImplicitSignals,
  listImplicitSignals as queryImplicitSignals,
  listSkillCandidates as querySkillCandidates,
  reportImplicitSignalsToEvaluation,
  type AssocImplicitSignal,
  type AssocSkillCandidate,
  type AssocSkillCandidateStatus,
  type ClusterEpisodesResult,
  type ClusteringConfig,
  type ClusteringEpisodeInput,
  type DetectImplicitSignalsResult,
  type EvaluationAppendPeer,
  type ImplicitSignalKind,
} from './clustering.js'
import { normalizeConfig, Config, type AssociationConfig, type NormalizedAssociationConfig } from './config.js'
import {
  listDreamRuns as queryDreamRuns,
  runDreamingPass,
  sweepExpiredDreamingNodes,
  type DreamIdeaRecord,
  type DreamingDeliveryPeer,
  type ExpiredNodeCleanupTarget,
  type RunDreamingPassResult,
  type StoredDreamRunRow,
} from './dreaming.js'
import {
  listEvalPool as queryEvalPool,
  type EvalPoolEntry,
  type EvalPoolKind,
  type EvalPoolStatus,
} from './eval-pool.js'
import {
  emitAssociationIntakeSignal,
  listIntakeSignals as queryIntakeSignals,
  type EmitAssociationIntakeSignalResult,
  type IntakeSignalNodeRef,
  type IntakeSignalWorkItemsPeer,
  type StoredIntakeSignalRow,
} from './intake-signal.js'
import {
  assembleStepCues,
  consumeSessionTurnToolNames,
  evictNodesFromAgentState,
  foldStepSessionActivation,
  getOrCreateAgentAssocState,
  handleAgentStatus,
  handleInboxClaimed,
  handleInboxDiscarded,
  handleSessionEvent,
  recordTaskExposures,
  recordTurnTaskId,
  resolveOwnerScope,
  resolveTaskId,
  wipeStateOnOwnerRotation,
  type AgentAssocState,
} from './cues.js'
import {
  detectWeakUseNodes,
  selectHop0CoActivationTargets,
  type ExposedNodeEntitiesInput,
} from './hebbian.js'
import { resolveHoldoutSeedKey, evaluateHoldout } from './holdout.js'
import { runHotPathQuery } from './hot-path.js'
import { applyHysteresisAndFormat } from './hysteresis.js'
import {
  buildMemoryIndex,
  rebuildMemoryIndexEdges,
  type AssociationMemoryIndex,
  type MemoryIndexEdgeInput,
  type MemoryIndexNodeInput,
} from './index-memory.js'
import {
  AssociationParamTuningLedger,
  toHotPathProfile,
  type AssocParamCurrent,
  type AssocParamProfileValues,
  type AssocParamRequestResult,
  type AssocParamTickAction,
  type AssocParamTuningStatus,
} from './param-tuning.js'
import { AssociationSourceManager } from './sources.js'
import {
  AssociationStore,
  openAssociationDatabase,
  type WithdrawalCascadeResult,
} from './sqlite.js'
import {
  AssistantAssociationError,
  registerAssociationTools,
  type AssocReadResult,
} from './tools.js'
import {
  WEB_LEARNING_SOURCE_PLUGIN,
  type AssociationOwnerScope,
  type HoldoutDecision,
  type HotPathClock,
  type HotPathProfile,
  type NodeKind,
  type ProvenanceEdgeRef,
  type ScoredAssociationItem,
  type StepMetricRow,
  type StoredAssociationEdge,
  type StoredAssociationNode,
  type StoredAssociationSynonym,
} from './types.js'
import {
  canonicalizeWebSourceUrl,
  computeWebSourceRef,
  getWebLearningBudgetUsage as queryWebLearningBudgetUsage,
  listWebLearningFetches as queryWebLearningFetches,
  listWebLearningRuns as queryWebLearningRuns,
  runWebLearningPass,
  withdrawWebSourceByUrl,
  type RunWebLearningPassResult,
  type StoredWebLearningFetchRow,
  type StoredWebLearningRunRow,
  type WebLearningBudgetUsageRow,
  type WebLearningDeliveryPeer,
} from './web-learning.js'
import {
  type SubprocessWebLearningRunnerOptions,
  type WebLearningRunner,
} from './web-learning-runner.js'
import type { WebLearningWorkerDeps } from './web-learning-worker.js'
import { AssociationWriteQueue, loadGraphSnapshotChunked } from './write-queue.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantAssociation: AssistantAssociationService
  }
}

const COLD_START_SYNC_THRESHOLD = 2_000

export class AssistantAssociationService extends Service {
  static inject = ['assistantPolicy'] as const
  static Config = Config

  private readonly assocConfig: NormalizedAssociationConfig
  private readonly policy: AssistantPolicyService
  private readonly assocStore: AssociationStore | null
  private readonly writeQueue: AssociationWriteQueue | null
  private readonly sourceManager: AssociationSourceManager | null
  private readonly paramLedger: AssociationParamTuningLedger | null
  private readonly holdoutSeedKey: Buffer | null

  private readonly agentStates = new WeakMap<Agent, AgentAssocState>()
  private readonly activeAgents = new Set<Agent>()
  private readonly headlessPrincipals = new WeakMap<Agent, string>()
  private readonly toolNamesBySessionTurn = new Map<string, string[]>()
  private readonly lastActivityByScope = new Map<string, number>()
  private readonly pendingTasks = new Set<Promise<void>>()
  private readonly inFlightWebLearningScopes = new Set<string>()

  private activeIndex: AssociationMemoryIndex | null = null
  private ready = false
  private indexBuildEpoch = 0
  private invalidationGeneration = 0
  private rebuildInFlight: Promise<void> | null = null
  private rebuildQueued = false
  private active = true
  private readonly effectAbortController = new AbortController()
  private hotPathClock: HotPathClock | undefined
  private nowClock: () => number = () => Date.now()

  constructor(ctx: Context, input: AssociationConfig = {}) {
    super(ctx, 'assistantAssociation')
    const normalized = normalizeConfig(input)
    this.assocConfig = normalized

    const policy = ctx.get('assistantPolicy' as never) as AssistantPolicyService | undefined
    if (policy === undefined) {
      throw new Error('assistant-association: assistantPolicy service is required')
    }
    this.policy = policy

    if (!normalized.enabled) {
      this.assocStore = null
      this.writeQueue = null
      this.sourceManager = null
      this.paramLedger = null
      this.holdoutSeedKey = null
      ctx.effect(() => () => {
        this.active = false
        this.effectAbortController.abort()
      }, 'assistant-association.disabled')
      return
    }

    const db = openAssociationDatabase(normalized.databasePath!)
    const store = new AssociationStore(db)
    this.assocStore = store

    try {
      this.holdoutSeedKey = resolveHoldoutSeedKey({
        databasePath: normalized.databasePath!,
        holdoutSeed: normalized.holdoutSeed,
        holdoutSeedPath: normalized.holdoutSeedPath,
      })
    } catch (error) {
      store.close()
      throw error
    }

    const pt = normalized.paramTuning
    this.paramLedger = new AssociationParamTuningLedger(store.database, {
      baseConfig: {
        decayHalfLifeMs: normalized.decayHalfLifeMs,
        maxHops: normalized.maxHops,
        maxItems: normalized.maxItems,
        minItems: normalized.minItems,
        hysteresisDelta: normalized.hysteresisDelta,
        sourceWeights: normalized.sourceWeights,
        hopTopN: normalized.hopTopN,
        maxFanoutPerNode: normalized.maxFanoutPerNode,
        hotPathBudgetMs: normalized.hotPathBudgetMs,
      },
      policy: {
        minSample: pt.minSample,
        minStepSample: pt.minStepSample,
        minSourceSample: pt.minSourceSample,
        minHoldoutSamples: pt.minHoldoutSamples,
        maxTimeoutRatePpm: pt.maxTimeoutRatePpm,
        lowUsageRatePpm: pt.lowUsageRatePpm,
        healthyUsageRatePpm: pt.healthyUsageRatePpm,
        highCorrectionRatePpm: pt.highCorrectionRatePpm,
        noisySourceRatePpm: pt.noisySourceRatePpm,
        regressionMarginPpm: pt.regressionMarginPpm,
        timeoutMarginPpm: pt.timeoutMarginPpm,
        maxTimeoutMarginPpm: pt.maxTimeoutMarginPpm,
        usageDropMarginPpm: pt.usageDropMarginPpm,
        observationMs: pt.observationMs,
        evaluationWindowMs: pt.evaluationWindowMs,
        relaxReplayWindowMs: pt.relaxationReplayWindowMs,
        rollbackCooldownMs: pt.rollbackCooldownMs,
        hotPathBudgetMs: normalized.hotPathBudgetMs,
        minItems: normalized.minItems,
        autoTightenEnabled: pt.enabled,
        relaxationReplayEnabled: pt.relaxationReplayEnabled,
      },
      now: () => this.nowClock(),
      hotPathClock: () => (this.hotPathClock !== undefined ? this.hotPathClock() : performance.now()),
    })

    const writeQueue = new AssociationWriteQueue(store, {
      onGraphMutated: (info) => {
        const evicted = new Set<string>()
        for (const w of info.withdrawals) {
          for (const id of w.deletedNodeIds) evicted.add(id)
          for (const id of w.suppressedNodeIds) evicted.add(id)
        }
        if (evicted.size > 0) {
          this.evictNodesAcrossActiveAgents(evicted)
        }
        if (info.hasStructuralGraphChanges || info.hasUpserts || info.withdrawals.length > 0) {
          void this.rebuildIndex()
        } else if (
          info.hasEdgeWeightUpdates &&
          this.activeIndex !== null &&
          !this.writeQueue?.hasPendingWithdrawals
        ) {
          this.rebuildEdgesOnly()
        }
      },
      onError: (error) => {
        this.ctx.logger.warn?.('assistant-association write queue error', { error: String(error) })
      },
    })
    this.writeQueue = writeQueue

    const sourceManager = new AssociationSourceManager(ctx, store, writeQueue, {
      onImmediateWithdraw: ({ ownerScopeKey, sourcePlugin, sourceRef, nodeIds }) => {
        const evicted = new Set(nodeIds)
        if (this.activeIndex !== null) {
          this.activeIndex.tombstoneSourceRef(ownerScopeKey, sourcePlugin, sourceRef)
          for (const id of nodeIds) {
            this.activeIndex.tombstoneNodeId(id)
          }
          const slots = this.activeIndex.sourceRefToSlots.get(
            `${ownerScopeKey}\0${sourcePlugin}\0${sourceRef}`,
          )
          if (slots !== undefined) {
            for (const slot of slots) {
              const nid = this.activeIndex.nodeIds[slot]
              if (nid !== undefined) evicted.add(nid)
            }
          }
        }
        this.evictNodesAcrossActiveAgents(evicted)
      },
      onConflictSuppressed: ({ nodeIds }) => {
        const evicted = new Set(nodeIds)
        if (this.activeIndex !== null) {
          for (const id of nodeIds) {
            this.activeIndex.tombstoneNodeId(id)
          }
        }
        this.evictNodesAcrossActiveAgents(evicted)
        void this.rebuildIndex()
      },
      onTaskCorrected: ({ ownerScopeKey, taskId, nodeIds, nowMs }) => {
        if (!this.active || this.writeQueue === null || nodeIds.length === 0) return
        if (this.isTaskInHoldout(taskId).inHoldout) return
        this.writeQueue.enqueue({
          kind: 'upsert-replay-episode',
          episode: {
            taskId,
            ownerScopeKey,
            inHoldout: false,
            cues: [],
            correctedNodeIds: nodeIds,
            occurredAt: nowMs,
          },
        })
      },
      hebbianConfig: normalized.hebbian,
      dreamingConfig: normalized.dreaming,
      holdoutSeedKey: this.holdoutSeedKey,
      holdoutRateBps: normalized.holdoutRateBps,
      consumeSessionToolNames: (sessionId) =>
        consumeSessionTurnToolNames(this.toolNamesBySessionTurn, sessionId),
      onEpisodesSynced: (scope) => {
        this.scheduleClusteringForScope(scope)
      },
      onError: (error) => {
        this.ctx.logger.warn?.('assistant-association source sync error', { error: String(error) })
      },
      now: () => this.nowClock(),
    })
    this.sourceManager = sourceManager

    // Initialize in-memory double-buffered index
    if (store.countActiveNodes() <= COLD_START_SYNC_THRESHOLD) {
      this.rebuildIndexSync()
    } else {
      void this.rebuildIndex()
    }

    // Subscribe to runtime agent/session/goal events
    ctx.on('agent/created', ({ agent }) => {
      if (!this.active) return
      this.activeAgents.add(agent)
      const scope = this.resolveAgentScope(agent)
      if (scope !== undefined && sourceManager.registerScope(scope)) {
        sourceManager.scheduleSync(0)
      }
    })

    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (!this.active) return
      this.activeAgents.add(agent)
      const state = getOrCreateAgentAssocState(this.agentStates, agent)
      handleInboxClaimed(state, message, turn, this.activeIndex)
    })

    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      if (!this.active) return
      const state = getOrCreateAgentAssocState(this.agentStates, agent)
      handleInboxDiscarded(state, message)
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (!this.active) return
      const state = getOrCreateAgentAssocState(this.agentStates, agent)
      handleAgentStatus(state, status)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      this.activeAgents.delete(agent)
      this.agentStates.delete(agent)
    })

    ctx.on('session/event', (session, event) => {
      if (!this.active) return
      const agents = this.ctx.get('agents', false) as { get(id: unknown): Agent | undefined } | undefined
      const agent = agents?.get(session.id)
      if (agent === undefined || agent.session !== session) return
      this.activeAgents.add(agent)
      const state = getOrCreateAgentAssocState(this.agentStates, agent)
      const outcome = handleSessionEvent(
        state,
        session,
        event,
        this.activeIndex,
        this.toolNamesBySessionTurn,
      )
      if (outcome.telemetry !== undefined || outcome.assistantText !== undefined) {
        const ownerScope = this.resolveAgentScope(agent)
        if (ownerScope !== undefined) {
          const turnNum = outcome.telemetry?.turn ?? outcome.assistantTurn ?? -1
          let taskId = state.turnTaskIds.get(turnNum)
          if (taskId === undefined) {
            taskId = resolveTaskId(this.ctx, agent, state, ownerScope).taskId
            if (turnNum >= 0) {
              recordTurnTaskId(state, turnNum, taskId)
            }
          }
          const holdout = this.isTaskInHoldout(taskId)
          const nowMs = this.nowClock()
          if (outcome.telemetry !== undefined && this.writeQueue !== null) {
            this.writeQueue.enqueue({
              kind: 'upsert-task-telemetry',
              telemetry: {
                taskId,
                ownerScopeKey: ownerScope.ownerScopeKey,
                inHoldout: holdout.inHoldout,
                turnsDelta: outcome.telemetry.turnsDelta,
                stepsDelta: outcome.telemetry.stepsDelta,
                inputTokensDelta: outcome.telemetry.inputTokensDelta,
                outputTokensDelta: outcome.telemetry.outputTokensDelta,
                costUsdMicrosDelta: outcome.telemetry.costUsdMicrosDelta,
                updatedAt: nowMs,
              },
            })
          }
          if (
            outcome.assistantText !== undefined &&
            outcome.assistantText.length > 0 &&
            !holdout.inHoldout &&
            this.assocConfig.hebbian.enabled &&
            this.activeIndex !== null &&
            this.writeQueue !== null
          ) {
            this.processWeakUseFromAssistantText(
              agent,
              state,
              ownerScope,
              taskId,
              outcome.assistantText,
              nowMs,
            )
          }
        }
      }
    })

    ctx.on('goal/changed' as never, ({ agent }: { readonly agent?: Agent }) => {
      if (!this.active || agent === undefined) return
      const state = getOrCreateAgentAssocState(this.agentStates, agent)
      state.inputNonce += 1
    })

    // Register synchronous systemPrompt.context hook (order: 239, before personal-memory:task-context at 240; interpolate: false)
    ctx.inject(['systemPrompt'], (promptCtx) =>
      promptCtx.systemPrompt.context({
        name: 'assistant-association:context',
        order: 239,
        interpolate: false,
        text: ({ agent }) => this.contextSnapshot(agent),
      }),
    )

    // Register assoc_read tool
    const unregisterTools = registerAssociationTools(ctx, {
      readById: (exec, id) => this.readById(exec, id),
    })

    // Start source ingestion & periodic reconcile
    sourceManager.start()
    const syncTimer = setInterval(() => {
      if (this.active) {
        sourceManager.scheduleSync(0)
        if (this.assocConfig.paramTuning.enabled) {
          try {
            this.reconcileParamTuning()
          } catch (error) {
            this.ctx.logger.warn?.('assistant-association param tuning error', {
              error: String(error),
            })
          }
        }
        this.trackBackgroundTask(
          this.runPeriodicS3Maintenance().catch((error) => {
            this.ctx.logger.warn?.('assistant-association s3 maintenance error', {
              error: String(error),
            })
          }),
        )
        if (
          this.active &&
          this.assocConfig.enabled &&
          this.assocConfig.webLearning.enabled &&
          !this.writeQueue?.hasPendingWithdrawals
        ) {
          this.trackBackgroundTask(
            this.runPeriodicS4WebLearning().catch((error) => {
              this.ctx.logger.warn?.('assistant-association web learning error', {
                error: String(error),
              })
            }),
          )
        }
      }
    }, normalized.syncIntervalMs)
    syncTimer.unref?.()

    const decayTimer = normalized.hebbian.enabled
      ? setInterval(() => {
          if (this.active) {
            this.enqueueHebbianDecayPass()
          }
        }, normalized.hebbian.decayIntervalMs)
      : null
    decayTimer?.unref?.()

    ctx.effect(
      () => async () => {
        this.active = false
        this.effectAbortController.abort()
        clearInterval(syncTimer)
        if (decayTimer !== null) {
          clearInterval(decayTimer)
        }
        unregisterTools()
        sourceManager.dispose()
        await writeQueue.dispose()
        if (this.pendingTasks.size > 0) {
          await Promise.allSettled(this.pendingTasks)
        }
        this.activeAgents.clear()
        try {
          store.close()
        } catch {
          // Ignore already closed
        }
      },
      'assistant-association.lifecycle',
    )
  }

  get enabled(): boolean {
    return this.assocConfig.enabled
  }

  get indexReady(): boolean {
    return this.ready
  }

  get store(): AssociationStore | null {
    return this.assocStore
  }

  bindHeadlessPrincipal(agent: Agent, principalId: string): void {
    this.headlessPrincipals.set(agent, principalId)
    this.activeAgents.add(agent)
  }

  setHotPathClock(clock?: HotPathClock): void {
    this.hotPathClock = clock
  }

  setNowClock(now?: () => number): void {
    this.nowClock = now ?? (() => Date.now())
  }

  isTaskInHoldout(taskId: string): HoldoutDecision {
    if (this.holdoutSeedKey === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return evaluateHoldout(this.holdoutSeedKey, taskId, this.assocConfig.holdoutRateBps)
  }

  shouldSuppressMemoryKeywordHits(agent: Agent | undefined): boolean {
    if (!this.active || !this.assocConfig.enabled || !this.ready) return false
    if (agent === undefined) return false
    const scope = this.resolveAgentScope(agent)
    if (scope === undefined) return false
    try {
      const decision = this.policy.authorizeAgent(agent, 'snapshot', {
        kind: 'tool',
        id: 'assistant-association:context',
      })
      if (decision.effect !== 'allow') return false
    } catch {
      return false
    }
    const state = getOrCreateAgentAssocState(this.agentStates, agent)
    const { taskId } = resolveTaskId(this.ctx, agent, state, scope)
    if (this.isTaskInHoldout(taskId).inHoldout) {
      return false
    }
    if (
      state.lastStepOutcome !== undefined &&
      state.lastStepOutcome.nonce === state.inputNonce &&
      state.lastStepOutcome.taskId === taskId &&
      state.lastStepOutcome.outcome !== 'injected'
    ) {
      return false
    }
    return true
  }

  contextSnapshot(agent: Agent | undefined): string {
    if (!this.active || !this.assocConfig.enabled || !this.ready || agent === undefined) {
      return ''
    }
    const activeIndex = this.activeIndex
    if (activeIndex === null) return ''

    const ownerScope = this.resolveAgentScope(agent)
    if (ownerScope === undefined) return ''

    try {
      const decision = this.policy.authorizeAgent(agent, 'snapshot', {
        kind: 'tool',
        id: 'assistant-association:context',
      })
      if (decision.effect !== 'allow') return ''
    } catch {
      return ''
    }

    this.activeAgents.add(agent)
    const state = getOrCreateAgentAssocState(this.agentStates, agent)
    if (wipeStateOnOwnerRotation(state, ownerScope.ownerScopeKey)) {
      this.sourceManager?.registerScope(ownerScope)
    }

    const { taskId, taskKind, turnNumber, goalContext } = resolveTaskId(
      this.ctx,
      agent,
      state,
      ownerScope,
    )
    recordTurnTaskId(state, turnNumber, taskId)

    const holdout = this.isTaskInHoldout(taskId)
    const nowMs = this.nowClock()
    const prevActivity = this.lastActivityByScope.get(ownerScope.ownerScopeKey) ?? 0
    if (nowMs > prevActivity) {
      this.lastActivityByScope.set(ownerScope.ownerScopeKey, nowMs)
    }
    this.recordHoldoutOnce(state, taskId, ownerScope.ownerScopeKey, taskKind, agent, turnNumber, holdout, nowMs)

    if (holdout.inHoldout) {
      state.lastStepOutcome = { nonce: state.inputNonce, taskId, outcome: 'holdout' }
      return ''
    }

    const activeProfile = this.paramLedger?.current(ownerScope.ownerScopeKey)
    const profileVersion = activeProfile?.version ?? 0
    const useProfileParams =
      activeProfile !== undefined &&
      (this.assocConfig.paramTuning.enabled || activeProfile.version > 0)
    const resolvedHotPath = useProfileParams
      ? toHotPathProfile(activeProfile.parameters, {
          hopTopN: this.assocConfig.hopTopN,
          maxFanoutPerNode: this.assocConfig.maxFanoutPerNode,
          hotPathBudgetMs: this.assocConfig.hotPathBudgetMs,
        })
      : undefined
    const effectiveMaxItems = resolvedHotPath?.maxItems ?? this.assocConfig.maxItems
    const effectiveMinItems = Math.min(this.assocConfig.minItems, effectiveMaxItems)
    const effectiveHysteresisDelta =
      resolvedHotPath?.hysteresisDelta ?? this.assocConfig.hysteresisDelta
    const profile: HotPathProfile = resolvedHotPath ?? {
      maxHops: this.assocConfig.maxHops,
      hopTopN: this.assocConfig.hopTopN,
      maxFanoutPerNode: this.assocConfig.maxFanoutPerNode,
      maxItems: this.assocConfig.maxItems,
      decayHalfLifeMs: this.assocConfig.decayHalfLifeMs,
      budgetMs: this.assocConfig.hotPathBudgetMs,
      sourceWeights: this.assocConfig.sourceWeights,
    }

    const goalKey =
      goalContext === undefined
        ? 'none'
        : `${goalContext.goal.id}:${goalContext.goal.definition.version}:${goalContext.goal.native.revision}:${goalContext.checkpoint.nextStep.slice(0, 64)}`

    const epochKey = `${state.inputNonce}:${state.invalidationNonce}:${ownerScope.ownerScopeKey}:${taskId}:${goalKey}:${activeIndex.buildEpoch}:${this.invalidationGeneration}:${profileVersion}`
    if (state.memo !== undefined && state.memo.epochKey === epochKey) {
      return state.memo.renderedBlock
    }

    const shouldDecaySession = state.lastEvaluatedNonce !== state.inputNonce
    state.lastEvaluatedNonce = state.inputNonce

    const { cues, sessionActivations } = assembleStepCues({
      agent,
      state,
      goalContext,
      turnNumber,
      nowMs,
      shouldDecaySession,
      activeIndex,
    })

    if (cues.length === 0 && sessionActivations.length === 0 && state.retainedItems.size === 0) {
      state.lastStepOutcome = { nonce: state.inputNonce, taskId, outcome: 'injected' }
      state.memo = { epochKey, renderedBlock: '' }
      return ''
    }

    const result = runHotPathQuery(
      activeIndex,
      cues,
      {
        ownerScopeKey: ownerScope.ownerScopeKey,
        workspace: ownerScope.workspace,
        agentPreset: ownerScope.agentPreset,
        allowLowTrust: this.assocConfig.allowLowTrust,
        allowSensitive: this.assocConfig.allowSensitive,
        nowMs,
      },
      profile,
      {
        sessionActivations,
        ...(this.hotPathClock === undefined ? {} : { clock: this.hotPathClock }),
      },
    )

    if (result.timedOut) {
      state.lastStepOutcome = { nonce: state.inputNonce, taskId, outcome: 'timeout' }
      this.ctx.logger.warn?.('assoc-timeout', {
        taskId,
        ownerScopeKey: ownerScope.ownerScopeKey,
        elapsedMs: result.elapsedMs,
        candidateCount: result.candidateCount,
      })
      if (state.lastMetricNonce !== state.inputNonce) {
        state.lastMetricNonce = state.inputNonce
        this.enqueueStepMetrics(
          taskId,
          ownerScope.ownerScopeKey,
          false,
          result.elapsedMs,
          true,
          'timeout',
          [],
          result.candidateCount,
          nowMs,
          profileVersion,
          String(agent.session.id),
        )
      }
      state.memo = { epochKey, renderedBlock: '' }
      return ''
    }

    const formatted = applyHysteresisAndFormat({
      state,
      index: activeIndex,
      ownerScope,
      candidates: result.items,
      maxItems: effectiveMaxItems,
      minItems: effectiveMinItems,
      maxContextTokens: this.assocConfig.maxContextTokens,
      hysteresisDelta: effectiveHysteresisDelta,
      allowLowTrust: this.assocConfig.allowLowTrust,
      allowSensitive: this.assocConfig.allowSensitive,
      nowMs,
    })

    state.lastStepOutcome = { nonce: state.inputNonce, taskId, outcome: 'injected' }
    if (state.lastMetricNonce !== state.inputNonce) {
      state.lastMetricNonce = state.inputNonce
      foldStepSessionActivation(state, formatted.injectedItems, nowMs)
      recordTaskExposures(state, taskId, formatted.injectedItems)
      this.enqueueStepMetrics(
        taskId,
        ownerScope.ownerScopeKey,
        false,
        result.elapsedMs,
        false,
        'none',
        formatted.injectedItems.map((i) => ({
          id: i.id,
          sourcePlugin: i.sourcePlugin,
          kind: i.kind,
          hop: i.hop,
          score: i.score,
          reason: i.reason,
          ...(i.provenanceEdges !== undefined ? { provenanceEdges: i.provenanceEdges } : {}),
        })),
        result.candidateCount,
        nowMs,
        profileVersion,
        String(agent.session.id),
      )
      if (cues.length > 0) {
        this.writeQueue?.enqueue({
          kind: 'upsert-replay-episode',
          episode: {
            taskId,
            ownerScopeKey: ownerScope.ownerScopeKey,
            inHoldout: false,
            cues,
            profileVersion,
            occurredAt: nowMs,
          },
        })
      }
      if (this.assocConfig.intakeSignal.enabled && result.items.length > 0) {
        const candidate = this.findIntakeSignalCandidate(
          ownerScope,
          result.items,
          goalContext?.goal.id,
          nowMs,
        )
        if (candidate !== null) {
          this.scheduleIntakeSignal(ownerScope, candidate, nowMs)
        }
      }
    }

    state.memo = { epochKey, renderedBlock: formatted.block }
    return formatted.block
  }

  async readById(exec: ToolExecution, rawId: string): Promise<AssocReadResult> {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null || this.writeQueue === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }

    const trimmedRaw = rawId.trim()
    const nowMs = this.nowClock()

    if (exec.signal.aborted) {
      const earlyScope = this.resolveReadEventScopeSafe(exec.agent)
      if (earlyScope !== undefined) {
        const earlyTaskId = resolveTaskId(
          this.ctx,
          exec.agent!,
          getOrCreateAgentAssocState(this.agentStates, exec.agent!),
          earlyScope,
        ).taskId
        this.recordReadEvent(earlyScope.ownerScopeKey, earlyTaskId, trimmedRaw, false, 'policy-denied', nowMs)
      }
      throw new AssistantAssociationError('policy-denied', 'association read was cancelled')
    }

    const id = trimmedRaw
    if (id.length === 0 || Buffer.byteLength(id, 'utf8') > 256) {
      const earlyScope = this.resolveReadEventScopeSafe(exec.agent)
      if (earlyScope !== undefined) {
        const earlyTaskId = resolveTaskId(
          this.ctx,
          exec.agent!,
          getOrCreateAgentAssocState(this.agentStates, exec.agent!),
          earlyScope,
        ).taskId
        this.recordReadEvent(earlyScope.ownerScopeKey, earlyTaskId, id, false, 'invalid-input', nowMs)
      }
      throw new AssistantAssociationError('invalid-input', 'association id is invalid')
    }

    const agent = exec.agent
    if (agent === undefined) {
      throw new AssistantAssociationError('missing-identity', 'assoc_read requires a live agent')
    }
    const agents = this.ctx.get('agents', false) as { get(id: unknown): Agent | undefined } | undefined
    if (agents !== undefined && agents.get(agent.id) !== agent) {
      throw new AssistantAssociationError('missing-identity', 'assoc_read requires a registered agent')
    }
    const sessions = this.ctx.get('sessions', false) as { get(id: unknown): unknown } | undefined
    if (sessions !== undefined && sessions.get(agent.session.id) !== agent.session) {
      throw new AssistantAssociationError('missing-identity', 'assoc_read requires a live session')
    }

    const ownerScope = this.resolveAgentScope(agent)
    if (ownerScope === undefined) {
      throw new AssistantAssociationError('missing-identity', 'assoc_read requires an owner scope')
    }

    const state = getOrCreateAgentAssocState(this.agentStates, agent)
    const taskInfo = resolveTaskId(this.ctx, agent, state, ownerScope)
    const { taskId } = taskInfo

    const toolDecision = this.policy.authorizeAgent(
      agent,
      'read',
      { kind: 'tool', id: 'assoc_read' },
      { idempotencyKey: `assoc-read:${String(exec.rootCallId)}:${String(exec.callId)}` },
    )
    if (toolDecision.effect !== 'allow') {
      this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'policy-denied', nowMs)
      throw new AssistantAssociationError('policy-denied', 'assoc_read denied by policy')
    }

    if (this.writeQueue.isNodeTombstoned(id)) {
      this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
      throw new AssistantAssociationError('not-found', 'association item is unavailable')
    }

    const row = this.assocStore.getNodeById(id)
    if (
      row === null ||
      row.status !== 'active' ||
      (row.expiresAt !== null && row.expiresAt <= nowMs) ||
      this.writeQueue.isSourceTombstoned(row.ownerScopeKey, row.sourcePlugin, row.sourceRef) ||
      this.assocStore.isSourceWithdrawn(row.ownerScopeKey, row.sourcePlugin, row.sourceRef)
    ) {
      this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
      throw new AssistantAssociationError('not-found', 'association item is unavailable')
    }

    // Fail-closed sensitivity, trust & owner lineage check (zero cross-owner / ABA oracle)
    if (row.sensitivity !== 'private') {
      this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
      throw new AssistantAssociationError('not-found', 'association item is unavailable')
    }
    if (!this.assocConfig.allowLowTrust && row.trust === 'low') {
      this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
      throw new AssistantAssociationError('not-found', 'association item is unavailable')
    }
    if (
      row.ownerScopeKey !== ownerScope.ownerScopeKey ||
      row.ownerMode !== ownerScope.mode ||
      row.principalDigest !== ownerScope.principalDigest
    ) {
      this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
      throw new AssistantAssociationError('not-found', 'association item is unavailable')
    }
    if (
      ownerScope.mode === 'delivery' &&
      (row.principalRecordId !== ownerScope.principalRecordId ||
        row.principalVersion !== ownerScope.principalVersion)
    ) {
      this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
      throw new AssistantAssociationError('not-found', 'association item is unavailable')
    }
    if (
      row.scopeMode === 'workspace' &&
      (row.workspace !== ownerScope.workspace || row.agentPreset !== ownerScope.agentPreset)
    ) {
      this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
      throw new AssistantAssociationError('not-found', 'association item is unavailable')
    }

    // Source-specific policy check
    const sourceResource = this.sourcePolicyResource(row.kind, row.sourceRef)
    if (sourceResource !== undefined) {
      const srcDecision = this.policy.authorizeAgent(agent, 'read', sourceResource, {
        idempotencyKey: `assoc-read-src:${String(exec.rootCallId)}:${String(exec.callId)}`,
      })
      if (srcDecision.effect !== 'allow') {
        this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'policy-denied', nowMs)
        throw new AssistantAssociationError('policy-denied', 'association source read denied by policy')
      }
    }

    // Live source validity re-check
    if (row.sourcePlugin === 'personal-memory') {
      const pm = this.ctx.get('personalMemory' as never, false) as
        | PersonalMemoryService
        | undefined
      if (pm !== undefined && typeof pm.read === 'function') {
        const memoryId = row.sourceRef.replace(/^memory:/u, '')
        let records: ReturnType<PersonalMemoryService['read']>
        try {
          records = pm.read(agent, { ids: [memoryId] })
        } catch (error) {
          if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'policy-denied'
          ) {
            this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'policy-denied', nowMs)
            throw new AssistantAssociationError('policy-denied', 'memory source read denied')
          }
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
        const liveRec = records[0]
        if (
          liveRec === undefined ||
          liveRec.status !== 'active' ||
          liveRec.sensitivity !== 'private' ||
          (liveRec.expiresAt !== undefined && liveRec.expiresAt <= nowMs)
        ) {
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
      }
    }

    if (row.kind === 'episode') {
      if (row.metadata.conflicted === true) {
        this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
        throw new AssistantAssociationError('not-found', 'association item is unavailable')
      }
      const outcomeId = row.metadata.extra?.outcomeId
      const evaluation = this.ctx.get('assistantEvaluation' as never, false) as
        | AssistantEvaluationService
        | undefined
      if (
        typeof outcomeId === 'string' &&
        ownerScope.mode === 'delivery' &&
        ownerScope.principalRecordId !== null &&
        ownerScope.principalVersion !== null &&
        evaluation !== undefined &&
        typeof evaluation.createHostScope === 'function' &&
        typeof evaluation.inspectTrustedTaskOwnerRevision === 'function'
      ) {
        try {
          const rev = evaluation.inspectTrustedTaskOwnerRevision({
            scope: evaluation.createHostScope({
              workspace: ownerScope.workspace,
              preset: ownerScope.agentPreset,
            }),
            outcomeId,
            principalRecordId: ownerScope.principalRecordId,
            principalVersion: ownerScope.principalVersion,
          })
          if (rev?.action === 'withdraw') {
            this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
            this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
            throw new AssistantAssociationError('not-found', 'association item is unavailable')
          }
        } catch (error) {
          if (error instanceof AssistantAssociationError) throw error
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
      }
    }

    if (row.kind === 'wiki' || row.sourcePlugin === 'personal-wiki') {
      const wiki = this.ctx.get('personalWiki' as never, false) as PersonalWikiService | undefined
      if (wiki !== undefined && typeof wiki.inspectHostPages === 'function') {
        const pageId = row.sourceRef.replace(/^wiki:/u, '')
        let pages: ReturnType<PersonalWikiService['inspectHostPages']>
        try {
          pages = wiki.inspectHostPages({ includeArchived: false })
        } catch {
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
        const livePage = pages.find((p) => p.metadata.id === pageId)
        if (livePage === undefined || livePage.metadata.status === 'archived') {
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
      }
    }

    if (row.kind === 'skill' || row.sourcePlugin === 'assistant-skills') {
      const skills = this.ctx.get('assistantSkills' as never, false) as
        | AssistantSkillsService
        | undefined
      if (skills !== undefined && typeof skills.inspectOwnerActiveSkills === 'function') {
        if (
          ownerScope.mode !== 'delivery' ||
          ownerScope.principalRecordId === null ||
          ownerScope.principalVersion === null
        ) {
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
        const skillName = row.sourceRef.replace(/^skill:/u, '')
        let activeSkills: ReturnType<AssistantSkillsService['inspectOwnerActiveSkills']>
        try {
          activeSkills = skills.inspectOwnerActiveSkills({
            principalId: ownerScope.principalId,
            principalRecordId: ownerScope.principalRecordId,
            principalVersion: ownerScope.principalVersion,
            workspace: ownerScope.workspace,
            preset: ownerScope.agentPreset,
          })
        } catch {
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
        const liveSkill = activeSkills.find(
          (s) => s.name === skillName && (s as { readonly retired?: boolean }).retired !== true,
        )
        if (liveSkill === undefined) {
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
      }
    }

    if (row.kind === 'event' || row.sourcePlugin === 'event-triggers') {
      const triggers = this.ctx.get('eventTriggers' as never, false) as
        | EventTriggersService
        | undefined
      const triggerId = row.metadata.extra?.triggerId
      if (
        triggers !== undefined &&
        typeof triggers.inspectOwnerSources === 'function' &&
        typeof triggerId === 'string' &&
        triggerId.length > 0 &&
        ownerScope.mode === 'delivery' &&
        ownerScope.principalRecordId !== null &&
        ownerScope.principalVersion !== null
      ) {
        let activeSources: ReturnType<EventTriggersService['inspectOwnerSources']>
        try {
          activeSources = triggers.inspectOwnerSources({
            principalId: ownerScope.principalId,
            principalRecordId: ownerScope.principalRecordId,
            principalVersion: ownerScope.principalVersion,
            workspace: ownerScope.workspace,
            preset: ownerScope.agentPreset,
          })
        } catch {
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
        const liveSource = activeSources.find((s) => s.triggerId === triggerId)
        if (
          liveSource === undefined ||
          (liveSource.expiresAt !== undefined && liveSource.expiresAt <= nowMs)
        ) {
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
      }
    }

    if (row.kind === 'dream' || row.kind === 'abstraction') {
      if (row.sourcePlugin === 'assistant-dreaming' && row.sourceRef.startsWith('dream-idea:')) {
        const dreaming = this.ctx.get('assistantDreaming' as never, false) as
          | AssistantDreamingService
          | undefined
        if (dreaming !== undefined && typeof dreaming.inspectIdeas === 'function') {
          const ideaId = row.sourceRef.slice('dream-idea:'.length)
          try {
            const ideas = dreaming.inspectIdeas(500)
            const matched = ideas.find((idea) => idea.id === ideaId)
            if (
              matched !== undefined &&
              (matched.state === 'rejected' || matched.state === 'withdrawn')
            ) {
              this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
              this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
              throw new AssistantAssociationError('not-found', 'association item is unavailable')
            }
          } catch (error) {
            if (error instanceof AssistantAssociationError) throw error
          }
        }
      }
      const derivedParents = this.assocStore.database
        .prepare(
          "SELECT source_node_id FROM assoc_derived_from WHERE target_kind = 'node' AND target_id = ?",
        )
        .all(row.id) as Array<{ source_node_id: string }>
      for (const parentRef of derivedParents) {
        const parentNode = this.assocStore.getNodeById(parentRef.source_node_id)
        if (
          parentNode === null ||
          parentNode.status !== 'active' ||
          (parentNode.expiresAt !== null && parentNode.expiresAt <= nowMs) ||
          this.writeQueue.isNodeTombstoned(parentNode.id)
        ) {
          this.triggerInvalidation(row.ownerScopeKey, row.sourcePlugin, row.sourceRef, row.id)
          this.recordReadEvent(ownerScope.ownerScopeKey, taskId, id, false, 'not-found', nowMs)
          throw new AssistantAssociationError('not-found', 'association item is unavailable')
        }
      }
    }

    // Record read hit & S2 Hebbian strong use (+α) ONLY for active exposed non-holdout items
    this.recordReadEvent(ownerScope.ownerScopeKey, taskId, row.id, true, 'ok', nowMs)

    const inHoldout = this.isTaskInHoldout(taskId).inHoldout
    const taskExpMap = state.taskExposures.get(taskId)
    const expEntry = taskExpMap?.get(row.id)
    const inRetained =
      state.lastStepOutcome?.taskId === taskId &&
      state.lastStepOutcome.outcome === 'injected' &&
      state.retainedItems.has(row.id)
    const isExposed =
      !inHoldout &&
      (expEntry !== undefined || inRetained || this.assocStore.hasExposedRow(taskId, row.id))

    if (isExposed && this.assocConfig.hebbian.enabled) {
      if (expEntry !== undefined) {
        expEntry.strongUsed = true
      }
      const provenanceEdges = expEntry?.provenanceEdges ?? []
      const coActivatedNodeIds =
        provenanceEdges.length === 0 && (expEntry?.hop ?? 0) === 0
          ? selectHop0CoActivationTargets({
              nodeId: row.id,
              coExposedNodeIds: taskExpMap !== undefined ? [...taskExpMap.keys()] : [],
              goalNodeId:
                taskInfo.goalContext !== undefined
                  ? `a:g-${taskInfo.goalContext.goal.id}`
                  : null,
              sessionNodeIds: [...state.sessionActivation.keys()],
              episodeNodeId:
                taskInfo.taskKind === 'foreground-turn'
                  ? `a:e-fg-${taskId.slice('foreground-turn:'.length)}`
                  : null,
            })
          : []
      this.writeQueue.enqueue({
        kind: 'apply-hebbian-use',
        useKind: 'strong',
        taskId,
        ownerScopeKey: row.ownerScopeKey,
        nodeId: row.id,
        sessionId: String(agent.session.id),
        ...(provenanceEdges.length > 0 ? { provenanceEdges } : {}),
        ...(coActivatedNodeIds.length > 0 ? { coActivatedNodeIds } : {}),
        nowMs,
        hebbianConfig: this.assocConfig.hebbian,
      })
      this.writeQueue.enqueue({
        kind: 'upsert-replay-episode',
        episode: {
          taskId,
          ownerScopeKey: row.ownerScopeKey,
          inHoldout: false,
          cues: [],
          usedNodeIds: [row.id],
          occurredAt: nowMs,
        },
      })
    } else {
      this.writeQueue.enqueue({
        kind: 'record-metrics',
        metrics: [],
        exposures: [
          {
            taskId,
            nodeId: row.id,
            ownerScopeKey: row.ownerScopeKey,
            sourcePlugin: row.sourcePlugin,
            exposedAt: nowMs,
            wasExposed: isExposed,
            strongUsed: isExposed,
            sessionId: String(agent.session.id),
            assocReadCount: 1,
          },
        ],
      })
    }

    return Object.freeze({
      id: row.id,
      kind: row.kind,
      trust: row.trust,
      sensitivity: 'private',
      sourceRef: row.sourceRef,
      sourceVersion: `v${row.sourceVersion}`,
      title: row.title,
      content: row.body,
      entities: [...row.entities],
      updatedAt: row.updatedAt,
      ...(row.metadata.sourceUrl !== undefined ? { sourceUrl: row.metadata.sourceUrl } : {}),
      ...(row.metadata.fetchedAt !== undefined ? { fetchedAt: row.metadata.fetchedAt } : {}),
    })
  }

  currentParamProfile(scopeKey: string): AssocParamCurrent {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.paramLedger === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return this.paramLedger.current(scopeKey)
  }

  paramTuningStatus(scopeKey: string, eventLimit = 50): AssocParamTuningStatus {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.paramLedger === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return this.paramLedger.status(scopeKey, eventLimit)
  }

  requestParamTuning(input: {
    readonly scopeKey: string
    readonly candidate: AssocParamProfileValues
    readonly reason: string
    readonly idempotencyKey?: string
    readonly nowMs?: number
  }): AssocParamRequestResult {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.paramLedger === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return this.paramLedger.requestChange(input)
  }

  reconcileParamTuning(scopeKey: string, nowMs?: number): AssocParamTickAction
  reconcileParamTuning(
    scopeKey?: undefined,
    nowMs?: number,
  ): Readonly<Record<string, AssocParamTickAction>>
  reconcileParamTuning(
    scopeKey?: string,
    nowMs?: number,
  ): AssocParamTickAction | Readonly<Record<string, AssocParamTickAction>> {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.paramLedger === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    const filterTemplate = {
      allowLowTrust: this.assocConfig.allowLowTrust,
      allowSensitive: this.assocConfig.allowSensitive,
    }
    if (scopeKey !== undefined) {
      return this.paramLedger.tick({
        scopeKey,
        ...(nowMs === undefined ? {} : { nowMs }),
        ...(this.activeIndex === null ? {} : { index: this.activeIndex }),
        filterTemplate,
      })
    }
    const allScopes = new Set<string>(this.paramLedger.listScopeKeys())
    if (this.sourceManager !== null) {
      for (const scope of this.sourceManager.listScopes()) {
        allScopes.add(scope.ownerScopeKey)
      }
    }
    const results: Record<string, AssocParamTickAction> = {}
    for (const key of allScopes) {
      results[key] = this.paramLedger.tick({
        scopeKey: key,
        ...(nowMs === undefined ? {} : { nowMs }),
        ...(this.activeIndex === null ? {} : { index: this.activeIndex }),
        filterTemplate,
      })
    }
    return Object.freeze(results)
  }

  async runHebbianDecayPass(nowMs?: number): Promise<void> {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.writeQueue === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    if (!this.assocConfig.hebbian.enabled) return
    this.enqueueHebbianDecayPass(nowMs)
    await this.flush()
  }

  async syncAll(): Promise<void> {
    if (this.sourceManager !== null) {
      await this.sourceManager.syncAll()
    }
    await this.flush()
  }

  async syncScope(scope: AssociationOwnerScope): Promise<void> {
    if (this.sourceManager !== null) {
      this.sourceManager.registerScope(scope)
      await this.sourceManager.syncScope(scope)
    }
    await this.flush()
  }

  async flush(): Promise<void> {
    if (this.pendingTasks.size > 0) {
      await Promise.allSettled(this.pendingTasks)
    }
    if (this.writeQueue !== null) {
      await this.writeQueue.flush()
    }
    if (this.pendingTasks.size > 0) {
      await Promise.allSettled(this.pendingTasks)
    }
    if (this.rebuildInFlight !== null) {
      await this.rebuildInFlight
    }
  }

  async refreshIndex(): Promise<void> {
    await this.flush()
    await this.rebuildIndex()
  }

  async runDreamingNow(
    scope: AssociationOwnerScope,
    options?: {
      readonly nowMs?: number
      readonly lastActivityAt?: number | null
      readonly hasRunningAgent?: boolean
      readonly weightMin?: number
      readonly weightMax?: number
      readonly nodeLimit?: number
    },
  ): Promise<RunDreamingPassResult> {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null || this.writeQueue === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    await this.writeQueue.flush()
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }

    const nowMs = options?.nowMs ?? this.nowClock()
    const delivery = this.ctx.get('assistantDelivery' as never, false) as
      | DreamingDeliveryPeer
      | undefined
    const dreaming = this.ctx.get('assistantDreaming' as never, false) as
      | AssistantDreamingService
      | undefined
    let ideas: DreamIdeaRecord[] | undefined
    if (dreaming !== undefined && typeof dreaming.inspectIdeas === 'function') {
      try {
        ideas = dreaming.inspectIdeas(200).map((idea) => ({
          id: idea.id,
          lane: idea.lane,
          runId: idea.runId,
          createdAt: idea.createdAt,
          dayKey: idea.dayKey,
          state: idea.state,
          summary: idea.summary,
          detail: idea.detail,
          evidenceRefs: [...idea.evidenceRefs],
        }))
      } catch {
        ideas = undefined
      }
    }

    const evictedNodeIds = new Set<string>()
    const resolvedLastActivity =
      options?.lastActivityAt !== undefined
        ? options.lastActivityAt
        : this.lastActivityByScope.get(scope.ownerScopeKey)
    const hasRunningAgent =
      options?.hasRunningAgent ?? this.hasRunningAgentForScope(scope.ownerScopeKey)

    const result = runDreamingPass({
      db: this.assocStore.database,
      scope,
      config: this.assocConfig.dreaming,
      policy: this.policy,
      ...(delivery === undefined ? {} : { delivery }),
      hasRunningAgent,
      ...(resolvedLastActivity !== undefined ? { lastActivityAt: resolvedLastActivity } : {}),
      nowMs,
      ...(ideas === undefined ? {} : { ideas }),
      weightMin: options?.weightMin ?? this.assocConfig.hebbian.weightMin,
      weightMax: options?.weightMax ?? this.assocConfig.hebbian.weightMax,
      ...(options?.nodeLimit !== undefined ? { nodeLimit: options.nodeLimit } : {}),
      writer: {
        upsertBatch: (batch) => {
          const res = this.assocStore!.upsertBatch(batch)
          for (const id of res.deletedNodeIds) evictedNodeIds.add(id)
          for (const id of res.suppressedNodeIds) evictedNodeIds.add(id)
          return res
        },
        withdrawSource: (w) => {
          const res = this.assocStore!.withdrawSource({ ...w, hardDelete: true })
          for (const id of res.deletedNodeIds) evictedNodeIds.add(id)
          for (const id of res.suppressedNodeIds) evictedNodeIds.add(id)
          return res
        },
      },
    })

    if (evictedNodeIds.size > 0) {
      if (this.activeIndex !== null) {
        for (const id of evictedNodeIds) {
          this.activeIndex.tombstoneNodeId(id)
        }
      }
      this.evictNodesAcrossActiveAgents(evictedNodeIds)
    }

    if (
      result.ran &&
      (result.edgesCreated > 0 ||
        result.abstractionsCreated > 0 ||
        result.synonymsCreated > 0 ||
        result.expiredSwept > 0 ||
        result.ideasProjected > 0 ||
        result.ideasWithdrawn > 0)
    ) {
      await this.rebuildIndex()
    }

    return result
  }

  listDreamRuns(ownerScopeKey: string, limit = 20): readonly StoredDreamRunRow[] {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return queryDreamRuns(this.assocStore.database, ownerScopeKey, limit)
  }

  async sweepExpiredNodesNow(nowMs?: number): Promise<readonly ExpiredNodeCleanupTarget[]> {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null || this.writeQueue === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    await this.writeQueue.flush()
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    const effectiveNow = nowMs ?? this.nowClock()
    const evicted = new Set<string>()
    const swept = sweepExpiredDreamingNodes(this.assocStore.database, {
      nowMs: effectiveNow,
      withdrawSource: (w) => {
        const res = this.assocStore!.withdrawSource({ ...w, hardDelete: true })
        for (const id of res.deletedNodeIds) evicted.add(id)
        for (const id of res.suppressedNodeIds) evicted.add(id)
        return res
      },
    })
    for (const target of swept) {
      evicted.add(target.id)
    }
    if (evicted.size > 0) {
      if (this.activeIndex !== null) {
        for (const id of evicted) {
          this.activeIndex.tombstoneNodeId(id)
        }
      }
      this.evictNodesAcrossActiveAgents(evicted)
      await this.rebuildIndex()
    }
    return swept
  }

  emitIntakeSignalNow(input: {
    readonly scope: AssociationOwnerScope
    readonly goalNode: IntakeSignalNodeRef
    readonly targetNode: IntakeSignalNodeRef
    readonly score: number
    readonly reason?: string
    readonly inHoldout: boolean
    readonly nowMs?: number
  }): EmitAssociationIntakeSignalResult {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    const assistantWorkItems = this.ctx.get('assistantWorkItems' as never, false) as
      | IntakeSignalWorkItemsPeer
      | undefined
    return emitAssociationIntakeSignal({
      db: this.assocStore.database,
      scope: input.scope,
      config: this.assocConfig.intakeSignal,
      goalNode: input.goalNode,
      targetNode: input.targetNode,
      score: input.score,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      inHoldout: input.inHoldout,
      policy: this.policy,
      ...(assistantWorkItems === undefined ? {} : { assistantWorkItems }),
      nowMs: input.nowMs ?? this.nowClock(),
    })
  }

  listIntakeSignals(ownerScopeKey: string, limit = 50): readonly StoredIntakeSignalRow[] {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return queryIntakeSignals(this.assocStore.database, ownerScopeKey, limit)
  }

  async runClusteringNow(
    scope: AssociationOwnerScope | string,
    options?: {
      readonly episodes?: readonly ClusteringEpisodeInput[]
      readonly config?: ClusteringConfig
      readonly benchmarkPlan?: BenchmarkPlan
      readonly nowMs?: number
      readonly persist?: boolean
      readonly reportImplicitSignals?: boolean
    },
  ): Promise<{
    readonly clustering: ClusterEpisodesResult
    readonly implicitSignals: DetectImplicitSignalsResult
    readonly reportedImplicitSignals: { readonly reported: number; readonly skipped: number }
  }> {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    await this.writeQueue?.flush()
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    const ownerScopeKey = typeof scope === 'string' ? scope : scope.ownerScopeKey
    const nowMs = options?.nowMs ?? this.nowClock()
    const cfg = options?.config ?? this.assocConfig.clustering
    const persist = options?.persist ?? true

    const clustering = await clusterEpisodes(this.assocStore.database, {
      ownerScopeKey,
      holdoutSeedKey: this.holdoutSeedKey,
      holdoutRateBps: this.assocConfig.holdoutRateBps,
      config: cfg,
      ...(options?.episodes !== undefined ? { episodes: options.episodes } : {}),
      ...(options?.benchmarkPlan !== undefined ? { benchmarkPlan: options.benchmarkPlan } : {}),
      nowMs,
      persist,
    })

    const implicitSignals = detectImplicitSignals(this.assocStore.database, {
      ownerScopeKey,
      holdoutSeedKey: this.holdoutSeedKey,
      holdoutRateBps: this.assocConfig.holdoutRateBps,
      config: cfg,
      ...(options?.episodes !== undefined ? { episodes: options.episodes } : {}),
      nowMs,
      persist,
    })

    let reportedImplicitSignals: { readonly reported: number; readonly skipped: number } = {
      reported: 0,
      skipped: 0,
    }
    if (
      options?.reportImplicitSignals !== false &&
      implicitSignals.signals.length > 0 &&
      this.active
    ) {
      const resolvedScope =
        typeof scope === 'string'
          ? this.sourceManager?.listScopes().find((s) => s.ownerScopeKey === ownerScopeKey)
          : scope
      if (resolvedScope !== undefined) {
        const evalPeer = this.ctx.get('assistantEvaluation' as never, false) as
          | EvaluationAppendPeer
          | undefined
        reportedImplicitSignals = reportImplicitSignalsToEvaluation(
          evalPeer,
          implicitSignals.signals,
          { workspace: resolvedScope.workspace, preset: resolvedScope.agentPreset },
        )
      }
    }

    return Object.freeze({
      clustering,
      implicitSignals,
      reportedImplicitSignals,
    })
  }

  listSkillCandidates(
    ownerScopeKey: string,
    options?: { readonly status?: AssocSkillCandidateStatus; readonly limit?: number },
  ): AssocSkillCandidate[] {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return querySkillCandidates(this.assocStore.database, ownerScopeKey, options)
  }

  listImplicitSignals(
    ownerScopeKey: string,
    options?: {
      readonly kind?: ImplicitSignalKind
      readonly clusterId?: string
      readonly limit?: number
    },
  ): AssocImplicitSignal[] {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return queryImplicitSignals(this.assocStore.database, ownerScopeKey, options)
  }

  listEvalPool(
    ownerScopeKey: string,
    options?: {
      readonly poolKind?: EvalPoolKind
      readonly status?: EvalPoolStatus
      readonly includeRetracted?: boolean
      readonly limit?: number
    },
  ): EvalPoolEntry[] {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return queryEvalPool(this.assocStore.database, ownerScopeKey, options)
  }

  async runWebLearningNow(
    scope: AssociationOwnerScope,
    options?: {
      readonly now?: number
      readonly nowMs?: number
      readonly lastActivityAt?: number | null
      readonly hasRunningAgent?: boolean
      readonly ignoreIdle?: boolean
      readonly runner?: WebLearningRunner
      readonly workerDeps?: WebLearningWorkerDeps
      readonly subprocessOptions?: SubprocessWebLearningRunnerOptions
      readonly signal?: AbortSignal
    },
  ): Promise<RunWebLearningPassResult> {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null || this.writeQueue === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }

    const nowMs = options?.nowMs ?? options?.now ?? this.nowClock()
    if (this.inFlightWebLearningScopes.has(scope.ownerScopeKey)) {
      return {
        ran: false,
        runId: null,
        status: 'skipped',
        reason: 'run-in-progress',
        topicsConsidered: 0,
        requestsUsed: 0,
        pagesFetched: 0,
        bytesFetched: 0,
        nodesWritten: 0,
        edgesWritten: 0,
        writtenNodeIds: [],
        interests: [],
        fetches: [],
        dailyUsage: queryWebLearningBudgetUsage(
          this.assocStore.database,
          scope.ownerScopeKey,
          nowMs,
        ),
      }
    }

    const store = this.assocStore
    const writeQueue = this.writeQueue
    this.inFlightWebLearningScopes.add(scope.ownerScopeKey)

    const execution = (async (): Promise<RunWebLearningPassResult> => {
      await writeQueue.flush()
      if (!this.active) {
        throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
      }
      if (writeQueue.hasPendingWithdrawals) {
        await writeQueue.flush()
      }
      if (!this.active) {
        throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
      }

      const delivery = this.ctx.get('assistantDelivery' as never, false) as
        | WebLearningDeliveryPeer
        | undefined
      const resolvedLastActivity =
        options?.lastActivityAt !== undefined
          ? options.lastActivityAt
          : this.lastActivityByScope.get(scope.ownerScopeKey)
      const hasRunningAgent =
        options?.hasRunningAgent ?? this.hasRunningAgentForScope(scope.ownerScopeKey)
      const effectiveSignal =
        options?.signal !== undefined
          ? AbortSignal.any([this.effectAbortController.signal, options.signal])
          : this.effectAbortController.signal

      const result = await runWebLearningPass({
        store,
        scope,
        rootEnabled: this.assocConfig.enabled,
        config: this.assocConfig.webLearning,
        policy: this.policy,
        ...(delivery === undefined ? {} : { delivery }),
        hasRunningAgent,
        ...(resolvedLastActivity !== undefined ? { lastActivityAt: resolvedLastActivity } : {}),
        ...(options?.ignoreIdle !== undefined ? { ignoreIdle: options.ignoreIdle } : {}),
        nowMs,
        ...(options?.runner !== undefined ? { runner: options.runner } : {}),
        ...(options?.workerDeps !== undefined ? { workerDeps: options.workerDeps } : {}),
        ...(options?.subprocessOptions !== undefined
          ? { subprocessOptions: options.subprocessOptions }
          : {}),
        signal: effectiveSignal,
        enqueueUpsertNodes: async (batch) => {
          if (!this.active || this.writeQueue === null || effectiveSignal.aborted) return
          this.writeQueue.enqueue({
            kind: 'upsert-nodes',
            nodes: batch.nodes,
            edges: batch.edges,
            derivedRefs: batch.derivedRefs,
          })
          await this.writeQueue.flush()
        },
      })

      if (this.active && (result.nodesWritten > 0 || result.edgesWritten > 0)) {
        await this.rebuildIndex()
      }

      return result
    })().finally(() => {
      this.inFlightWebLearningScopes.delete(scope.ownerScopeKey)
    })

    this.trackBackgroundTask(execution.then(() => {}, () => {}))
    return await execution
  }

  listWebLearningRuns(ownerScopeKey: string, limit = 20): readonly StoredWebLearningRunRow[] {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return queryWebLearningRuns(this.assocStore.database, ownerScopeKey, limit)
  }

  listWebLearningFetches(
    ownerScopeKey: string,
    limit = 50,
  ): readonly StoredWebLearningFetchRow[] {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    return queryWebLearningFetches(this.assocStore.database, ownerScopeKey, limit)
  }

  getWebLearningBudgetUsage(
    ownerScopeKey: string,
    utcDay?: string | number,
  ): WebLearningBudgetUsageRow {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    let effectiveNowMs: number
    if (typeof utcDay === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(utcDay)) {
        throw new AssistantAssociationError(
          'invalid-input',
          'utcDay must be formatted as YYYY-MM-DD',
        )
      }
      const parsed = Date.parse(`${utcDay}T00:00:00.000Z`)
      if (!Number.isFinite(parsed)) {
        throw new AssistantAssociationError('invalid-input', 'utcDay is not a valid UTC date')
      }
      effectiveNowMs = parsed
    } else {
      effectiveNowMs = utcDay ?? this.nowClock()
    }
    return queryWebLearningBudgetUsage(this.assocStore.database, ownerScopeKey, effectiveNowMs)
  }

  async withdrawWebSource(
    scope: Pick<AssociationOwnerScope, 'ownerScopeKey'>,
    sourceUrl: string,
    nowMs?: number,
  ): Promise<WithdrawalCascadeResult> {
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    if (!this.assocConfig.enabled || this.assocStore === null || this.writeQueue === null) {
      throw new AssistantAssociationError('disabled', 'assistant-association is disabled')
    }
    await this.writeQueue.flush()
    if (!this.active) {
      throw new AssistantAssociationError('disposed', 'assistant-association service is disposed')
    }
    const canonicalUrl = canonicalizeWebSourceUrl(sourceUrl)
    const sourceRef = computeWebSourceRef(canonicalUrl)
    this.writeQueue.markTombstoneSync({
      ownerScopeKey: scope.ownerScopeKey,
      sourcePlugin: WEB_LEARNING_SOURCE_PLUGIN,
      sourceRef,
    })
    this.activeIndex?.tombstoneSourceRef(
      scope.ownerScopeKey,
      WEB_LEARNING_SOURCE_PLUGIN,
      sourceRef,
    )
    const result = withdrawWebSourceByUrl(
      this.assocStore,
      scope,
      sourceUrl,
      nowMs ?? this.nowClock(),
    )
    const evicted = new Set<string>([...result.deletedNodeIds, ...result.suppressedNodeIds])
    if (evicted.size > 0) {
      if (this.activeIndex !== null) {
        for (const id of evicted) {
          this.activeIndex.tombstoneNodeId(id)
        }
      }
      this.evictNodesAcrossActiveAgents(evicted)
    }
    await this.rebuildIndex()
    return result
  }

  private resolveAgentScope(agent: Agent): AssociationOwnerScope | undefined {
    return resolveOwnerScope(this.ctx, agent, {
      allowHeadlessScope: this.assocConfig.allowHeadlessScope,
      headlessPrincipals: this.headlessPrincipals,
    })
  }

  private resolveReadEventScopeSafe(agent: Agent | undefined): AssociationOwnerScope | undefined {
    if (agent === undefined) return undefined
    const agents = this.ctx.get('agents', false) as { get(id: unknown): Agent | undefined } | undefined
    if (agents !== undefined && agents.get(agent.id) !== agent) return undefined
    const sessions = this.ctx.get('sessions', false) as { get(id: unknown): unknown } | undefined
    if (sessions !== undefined && sessions.get(agent.session.id) !== agent.session) return undefined
    return this.resolveAgentScope(agent)
  }

  private recordReadEvent(
    ownerScopeKey: string,
    taskId: string | null,
    nodeId: string,
    hit: boolean,
    reason: string,
    occurredAt: number,
  ): void {
    if (this.writeQueue === null) return
    this.writeQueue.enqueue({
      kind: 'record-read-event',
      event: {
        taskId,
        nodeId: nodeId.length > 0 ? nodeId.slice(0, 256) : '<invalid>',
        ownerScopeKey,
        hit,
        reason,
        occurredAt,
      },
    })
  }

  private processWeakUseFromAssistantText(
    agent: Agent,
    state: AgentAssocState,
    ownerScope: AssociationOwnerScope,
    taskId: string,
    assistantText: string,
    nowMs: number,
  ): void {
    const activeIndex = this.activeIndex
    if (activeIndex === null || this.writeQueue === null) return
    const taskExpMap = state.taskExposures.get(taskId)
    if (taskExpMap === undefined || taskExpMap.size === 0) return

    const exposedNodes: ExposedNodeEntitiesInput[] = []
    let hasUnusedExposed = false
    for (const entry of taskExpMap.values()) {
      const slot = activeIndex.nodeIdToSlot.get(entry.nodeId)
      if (slot === undefined || activeIndex.nodeTombstoned[slot] !== 0) continue
      if (!entry.strongUsed && !entry.weakUsed) {
        hasUnusedExposed = true
      }
      exposedNodes.push({
        nodeId: entry.nodeId,
        entities: activeIndex.nodeEntities[slot] ?? [],
      })
    }
    if (!hasUnusedExposed || exposedNodes.length === 0) return

    const matchedIds = detectWeakUseNodes({
      assistantText,
      exposedNodes,
      turnPromptEntities: state.turnPromptEntities,
      entityAutomaton: activeIndex.ac,
      ownerScopeKey: ownerScope.ownerScopeKey,
      allowLowTrust: this.assocConfig.allowLowTrust,
    })
    if (matchedIds.length === 0) return

    const goalContext = resolveTaskId(this.ctx, agent, state, ownerScope).goalContext
    const goalNodeId = goalContext !== undefined ? `a:g-${goalContext.goal.id}` : null
    const episodeNodeId = taskId.startsWith('foreground-turn:')
      ? `a:e-fg-${taskId.slice('foreground-turn:'.length)}`
      : null
    const usedNodeIds: string[] = []
    for (const nodeId of matchedIds) {
      const expEntry = taskExpMap.get(nodeId)
      if (expEntry === undefined || expEntry.strongUsed || expEntry.weakUsed) continue
      expEntry.weakUsed = true
      usedNodeIds.push(nodeId)
      const provenanceEdges = expEntry.provenanceEdges
      const coActivatedNodeIds =
        provenanceEdges.length === 0 && expEntry.hop === 0
          ? selectHop0CoActivationTargets({
              nodeId,
              coExposedNodeIds: [...taskExpMap.keys()],
              goalNodeId,
              sessionNodeIds: [...state.sessionActivation.keys()],
              episodeNodeId,
            })
          : []
      this.writeQueue.enqueue({
        kind: 'apply-hebbian-use',
        useKind: 'weak',
        taskId,
        ownerScopeKey: ownerScope.ownerScopeKey,
        nodeId,
        sessionId: String(agent.session.id),
        ...(provenanceEdges.length > 0 ? { provenanceEdges } : {}),
        ...(coActivatedNodeIds.length > 0 ? { coActivatedNodeIds } : {}),
        nowMs,
        hebbianConfig: this.assocConfig.hebbian,
      })
    }

    if (usedNodeIds.length > 0) {
      this.writeQueue.enqueue({
        kind: 'upsert-replay-episode',
        episode: {
          taskId,
          ownerScopeKey: ownerScope.ownerScopeKey,
          inHoldout: false,
          cues: [],
          usedNodeIds,
          occurredAt: nowMs,
        },
      })
    }
  }

  private enqueueHebbianDecayPass(nowMs?: number): void {
    if (!this.active || !this.assocConfig.hebbian.enabled || this.writeQueue === null) return
    const heb = this.assocConfig.hebbian
    this.writeQueue.enqueue({
      kind: 'apply-hebbian-decay',
      nowMs: nowMs ?? this.nowClock(),
      decayHalfLifeMs: heb.decayHalfLifeMs,
      nonUseGraceMs: heb.nonUseGraceMs,
      weightMin: heb.weightMin,
      weightMax: heb.weightMax,
      limit: 200,
    })
  }

  private rebuildEdgesOnly(): void {
    if (!this.active || this.assocStore === null || this.activeIndex === null) return
    if (this.writeQueue?.hasPendingWithdrawals) return
    if (this.rebuildInFlight !== null) {
      this.rebuildQueued = true
      return
    }
    const baseIndex = this.activeIndex
    const nowMs = this.nowClock()
    const edges: StoredAssociationEdge[] = []
    let offset = 0
    const pageSize = 10_000
    while (true) {
      const page = this.assocStore.loadActiveEdgesPage(pageSize, offset)
      if (page.length === 0) break
      edges.push(...page)
      if (page.length < pageSize) break
      offset += pageSize
    }
    const indexEdges: MemoryIndexEdgeInput[] = []
    for (const e of edges) {
      if (!baseIndex.nodeIdToSlot.has(e.aId) || !baseIndex.nodeIdToSlot.has(e.bId)) continue
      indexEdges.push({
        edgeId: e.edgeId,
        aId: e.aId,
        bId: e.bId,
        edgeType: e.edgeType,
        weight: e.weight,
        trust: e.trust,
        reason: e.reason,
      })
    }
    this.indexBuildEpoch += 1
    this.activeIndex = rebuildMemoryIndexEdges(baseIndex, indexEdges, {
      buildEpoch: this.indexBuildEpoch,
      builtAt: nowMs,
      maxFanoutPerNode: this.assocConfig.maxFanoutPerNode,
    })
  }

  private sourcePolicyResource(
    kind: NodeKind,
    sourceRef: string,
  ):
    | { readonly kind: 'memory' | 'goal' | 'automation' | 'wiki'; readonly id: string }
    | undefined {
    if (kind === 'memory') return { kind: 'memory', id: 'selected' }
    if (kind === 'goal') return { kind: 'goal', id: 'business-context' }
    if (kind === 'automation') {
      return { kind: 'automation', id: sourceRef.replace(/^automation:/u, '') || 'catalog' }
    }
    if (kind === 'wiki') {
      return { kind: 'wiki', id: sourceRef.replace(/^wiki:/u, '') || 'visible' }
    }
    return undefined
  }

  private triggerInvalidation(
    ownerScopeKey: string,
    sourcePlugin: string,
    sourceRef: string,
    nodeId: string,
  ): void {
    this.writeQueue?.markTombstoneSync({
      nodeIds: [nodeId],
      ownerScopeKey,
      sourcePlugin,
      sourceRef,
    })
    this.activeIndex?.tombstoneNodeId(nodeId)
    this.evictNodesAcrossActiveAgents(new Set([nodeId]))
    this.writeQueue?.enqueue({
      kind: 'withdraw-source',
      ownerScopeKey,
      sourcePlugin,
      sourceRef,
      hardDelete: true,
    })
  }

  private evictNodesAcrossActiveAgents(nodeIds: ReadonlySet<string>): void {
    if (nodeIds.size === 0) return
    this.invalidationGeneration += 1
    for (const agent of this.activeAgents) {
      const state = this.agentStates.get(agent)
      if (state !== undefined) {
        evictNodesFromAgentState(state, nodeIds)
      }
    }
  }

  private recordHoldoutOnce(
    state: AgentAssocState,
    taskId: string,
    ownerScopeKey: string,
    taskKind: ReturnType<typeof resolveTaskId>['taskKind'],
    agent: Agent,
    turnNumber: number,
    holdout: HoldoutDecision,
    nowMs: number,
  ): void {
    if (this.writeQueue === null) return
    if (state.recordedTaskIds.has(taskId)) return
    state.recordedTaskIds.add(taskId)
    while (state.recordedTaskIds.size > 256) {
      const oldest = state.recordedTaskIds.values().next().value
      if (oldest === undefined) break
      state.recordedTaskIds.delete(oldest)
    }

    this.writeQueue.enqueue({
      kind: 'record-holdout',
      row: {
        taskId,
        ownerScopeKey,
        taskKind,
        sessionId: String(agent.session.id),
        turnNumber,
        inHoldout: holdout.inHoldout,
        bucketBps: holdout.bucketBps,
        rateBps: holdout.rateBps,
        hmacDigest: holdout.hmacDigest,
        assignedAt: nowMs,
      },
    })
    if (holdout.inHoldout) {
      const profileVersion = this.paramLedger?.current(ownerScopeKey).version ?? 0
      this.writeQueue.enqueue({
        kind: 'record-metrics',
        metrics: [
          {
            taskId,
            ownerScopeKey,
            inHoldout: true,
            latencyUs: 0,
            timedOut: false,
            fallbackMode: 'holdout',
            injectedCount: 0,
            candidateCount: 0,
            sourceCounts: {},
            profileVersion,
            occurredAt: nowMs,
          },
        ],
        exposures: [],
      })
    }
  }

  private enqueueStepMetrics(
    taskId: string,
    ownerScopeKey: string,
    inHoldout: boolean,
    elapsedMs: number,
    timedOut: boolean,
    fallbackMode: StepMetricRow['fallbackMode'],
    injected: readonly {
      readonly id: string
      readonly sourcePlugin: string
      readonly kind: NodeKind
      readonly hop: number
      readonly score: number
      readonly reason: string
      readonly provenanceEdges?: readonly ProvenanceEdgeRef[]
    }[],
    candidateCount: number,
    nowMs: number,
    profileVersion = 0,
    sessionId?: string | null,
  ): void {
    if (this.writeQueue === null) return
    const sourceCounts: Record<string, number> = {}
    for (const item of injected) {
      sourceCounts[item.kind] = (sourceCounts[item.kind] ?? 0) + 1
    }
    this.writeQueue.enqueue({
      kind: 'record-metrics',
      metrics: [
        {
          taskId,
          ownerScopeKey,
          inHoldout,
          latencyUs: Math.max(0, Math.round(elapsedMs * 1_000)),
          timedOut,
          fallbackMode,
          injectedCount: injected.length,
          candidateCount,
          sourceCounts,
          profileVersion,
          occurredAt: nowMs,
        },
      ],
      exposures: injected.map((item) => ({
        taskId,
        nodeId: item.id,
        ownerScopeKey,
        sourcePlugin: item.sourcePlugin,
        exposedAt: nowMs,
        wasExposed: true,
        hop: item.hop,
        score: item.score,
        reason: item.reason,
        provenanceEdges: item.provenanceEdges ?? [],
        sessionId: sessionId ?? null,
      })),
    })
  }

  private rebuildIndexSync(): void {
    if (this.assocStore === null) return
    const snapshotWithdrawalEpoch = this.writeQueue?.withdrawalEpoch ?? 0
    const nowMs = this.nowClock()
    const total = this.assocStore.countActiveNodes()
    const nodes = total === 0 ? [] : this.assocStore.loadActiveNodesPage(Math.max(1, total), 0)
    const edges = total === 0 ? [] : this.assocStore.loadActiveEdgesPage(1_000_000, 0)
    const synonyms = total === 0 ? [] : this.assocStore.loadActiveSynonymsPage(100_000, 0)
    this.commitRebuiltIndex(nodes, edges, synonyms, nowMs, snapshotWithdrawalEpoch)
  }

  private async rebuildIndex(): Promise<void> {
    if (!this.active || this.assocStore === null) return
    if (this.rebuildInFlight !== null) {
      this.rebuildQueued = true
      await this.rebuildInFlight
      return
    }

    const run = async (): Promise<void> => {
      do {
        this.rebuildQueued = false
        if (!this.active || this.assocStore === null) return
        const snapshotWithdrawalEpoch = this.writeQueue?.withdrawalEpoch ?? 0
        const snap = await loadGraphSnapshotChunked(this.assocStore, {
          chunkSize: 2_000,
          isCancelled: () => !this.active,
        })
        if (snap === null || !this.active) return
        this.commitRebuiltIndex(
          snap.nodes,
          snap.edges,
          snap.synonyms,
          this.nowClock(),
          snapshotWithdrawalEpoch,
        )
      } while (this.rebuildQueued && this.active)
    }

    this.rebuildInFlight = run().finally(() => {
      this.rebuildInFlight = null
    })
    await this.rebuildInFlight
  }

  private commitRebuiltIndex(
    nodes: readonly StoredAssociationNode[],
    edges: readonly StoredAssociationEdge[],
    synonyms: readonly StoredAssociationSynonym[],
    nowMs: number,
    snapshotWithdrawalEpoch?: number,
  ): void {
    const activeIds = new Set<string>()
    const indexNodes: MemoryIndexNodeInput[] = []
    for (const n of nodes) {
      if (n.status !== 'active') continue
      if (this.writeQueue?.isNodeTombstoned(n.id)) continue
      if (this.writeQueue?.isSourceTombstoned(n.ownerScopeKey, n.sourcePlugin, n.sourceRef)) continue
      activeIds.add(n.id)
      indexNodes.push({
        id: n.id,
        kind: n.kind,
        sourcePlugin: n.sourcePlugin,
        sourceRef: n.sourceRef,
        ownerScopeKey: n.ownerScopeKey,
        ownerMode: n.ownerMode,
        scopeMode: n.scopeMode,
        workspace: n.workspace,
        agentPreset: n.agentPreset,
        trust: n.trust,
        sensitivity: n.sensitivity,
        title: n.title,
        entities: n.entities,
        tokens: n.tokens,
        expiresAt: n.expiresAt,
        updatedAt: n.updatedAt,
      })
    }

    const indexEdges: MemoryIndexEdgeInput[] = []
    for (const e of edges) {
      if (!activeIds.has(e.aId) || !activeIds.has(e.bId)) continue
      indexEdges.push({
        edgeId: e.edgeId,
        aId: e.aId,
        bId: e.bId,
        edgeType: e.edgeType,
        weight: e.weight,
        trust: e.trust,
        reason: e.reason,
      })
    }

    this.indexBuildEpoch += 1
    const nextIndex = buildMemoryIndex(
      {
        nodes: indexNodes,
        edges: indexEdges,
        synonyms: synonyms
          .filter((s) => s.sourceNodeId === null || activeIds.has(s.sourceNodeId))
          .map((s) => ({
            surface: s.surface,
            canonicalEntity: s.canonicalEntity,
            ownerScopeKey: s.ownerScopeKey,
            trust: s.trust,
          })),
      },
      {
        buildEpoch: this.indexBuildEpoch,
        builtAt: nowMs,
        maxFanoutPerNode: this.assocConfig.maxFanoutPerNode,
      },
    )

    this.activeIndex = nextIndex
    this.ready = true
    this.writeQueue?.clearTombstonesForRebuiltGraph(activeIds, snapshotWithdrawalEpoch)
  }

  private trackBackgroundTask(promise: Promise<void>): void {
    this.pendingTasks.add(promise)
    void promise.finally(() => {
      this.pendingTasks.delete(promise)
    })
  }

  private hasRunningAgentForScope(ownerScopeKey: string): boolean {
    for (const agent of this.activeAgents) {
      if (agent.status !== 'running') continue
      const scope = this.resolveAgentScope(agent)
      if (scope?.ownerScopeKey === ownerScopeKey) {
        return true
      }
    }
    return false
  }

  private scheduleClusteringForScope(scope: AssociationOwnerScope): void {
    if (!this.active || !this.assocConfig.enabled || this.holdoutSeedKey === null) return
    this.trackBackgroundTask(
      this.runClusteringNow(scope).then(
        () => {},
        (error) => {
          this.ctx.logger.warn?.('assistant-association clustering error', {
            error: String(error),
          })
        },
      ),
    )
  }

  private async runPeriodicS3Maintenance(): Promise<void> {
    if (!this.active || !this.assocConfig.enabled) return
    if (!this.writeQueue?.hasPendingWithdrawals) {
      await this.sweepExpiredNodesNow()
    }
    if (!this.active || !this.assocConfig.dreaming.enabled || this.sourceManager === null) return
    for (const scope of this.sourceManager.listScopes()) {
      if (!this.active) return
      await this.runDreamingNow(scope)
    }
  }

  private async runPeriodicS4WebLearning(): Promise<void> {
    if (
      !this.active ||
      !this.assocConfig.enabled ||
      !this.assocConfig.webLearning.enabled ||
      this.sourceManager === null ||
      this.writeQueue?.hasPendingWithdrawals
    ) {
      return
    }
    for (const scope of this.sourceManager.listScopes()) {
      if (!this.active || this.writeQueue?.hasPendingWithdrawals) return
      if (this.inFlightWebLearningScopes.has(scope.ownerScopeKey)) continue
      try {
        await this.runWebLearningNow(scope)
      } catch (error) {
        if (error instanceof AssistantAssociationError && error.code === 'disposed') {
          return
        }
        throw error
      }
    }
  }

  private findIntakeSignalCandidate(
    ownerScope: AssociationOwnerScope,
    items: readonly ScoredAssociationItem[],
    activeGoalId: string | undefined,
    nowMs: number,
  ): {
    readonly goalNode: IntakeSignalNodeRef
    readonly targetNode: IntakeSignalNodeRef
    readonly score: number
    readonly reason: string
  } | null {
    if (this.assocStore === null) return null
    const minScore = this.assocConfig.intakeSignal.minScore
    const isEligibleStored = (node: StoredAssociationNode | null): node is StoredAssociationNode =>
      node !== null &&
      node.status === 'active' &&
      node.sensitivity === 'private' &&
      node.ownerScopeKey === ownerScope.ownerScopeKey &&
      (node.expiresAt === null || node.expiresAt > nowMs)

    for (const item of items) {
      if (item.kind !== 'goal' || item.score < minScore) continue
      const goalNode = this.assocStore.getNodeById(item.id)
      if (!isEligibleStored(goalNode) || goalNode.kind !== 'goal') continue

      let targetNode: StoredAssociationNode | null = null
      if (item.provenanceEdges !== undefined) {
        for (const edge of item.provenanceEdges) {
          const otherId = edge.aId === goalNode.id ? edge.bId : edge.aId
          if (otherId === goalNode.id) continue
          const cand = this.assocStore.getNodeById(otherId)
          if (isEligibleStored(cand)) {
            targetNode = cand
            break
          }
        }
      }
      if (targetNode === null) {
        for (const other of items) {
          if (other.id === goalNode.id || other.kind === 'goal') continue
          const cand = this.assocStore.getNodeById(other.id)
          if (isEligibleStored(cand)) {
            targetNode = cand
            break
          }
        }
      }
      if (targetNode === null) {
        for (const other of items) {
          if (other.id === goalNode.id) continue
          const cand = this.assocStore.getNodeById(other.id)
          if (isEligibleStored(cand)) {
            targetNode = cand
            break
          }
        }
      }
      if (targetNode !== null) {
        return {
          goalNode,
          targetNode,
          score: item.score,
          reason: item.reason,
        }
      }
    }

    if (activeGoalId !== undefined) {
      const goalNode = this.assocStore.getNodeById(`a:g-${activeGoalId}`)
      if (isEligibleStored(goalNode) && goalNode.kind === 'goal') {
        for (const other of items) {
          if (other.id === goalNode.id || other.score < minScore) continue
          const targetNode = this.assocStore.getNodeById(other.id)
          if (isEligibleStored(targetNode)) {
            return {
              goalNode,
              targetNode,
              score: other.score,
              reason: other.reason,
            }
          }
        }
      }
    }

    return null
  }

  private scheduleIntakeSignal(
    ownerScope: AssociationOwnerScope,
    candidate: {
      readonly goalNode: IntakeSignalNodeRef
      readonly targetNode: IntakeSignalNodeRef
      readonly score: number
      readonly reason: string
    },
    nowMs: number,
  ): void {
    const task = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        try {
          if (this.active && this.assocConfig.enabled && this.assocStore !== null) {
            this.emitIntakeSignalNow({
              scope: ownerScope,
              goalNode: candidate.goalNode,
              targetNode: candidate.targetNode,
              score: candidate.score,
              reason: candidate.reason,
              inHoldout: false,
              nowMs,
            })
          }
        } catch (error) {
          this.ctx.logger.warn?.('assistant-association intake signal error', {
            error: String(error),
          })
        } finally {
          resolve()
        }
      })
    })
    this.trackBackgroundTask(task)
  }
}
