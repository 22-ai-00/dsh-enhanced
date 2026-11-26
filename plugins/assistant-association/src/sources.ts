import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AutomationDefinitionChangeEvent,
  AutomationRecord,
  AssistantAutomationsService,
} from '@dsh-ray/assistant-automations'
import type {
  AssistantDeliveryService,
  OwnerForegroundTaskSourceContent,
  OwnerForegroundTaskSourceCursor,
  OwnerRouteScopeSummary,
} from '@dsh-ray/assistant-delivery'
import type { AssistantDreamingService } from '@dsh-ray/assistant-dreaming'
import type {
  AssistantEvaluationService,
  TrustedTaskLearningProjectionReceipt,
} from '@dsh-ray/assistant-evaluation'
import type {
  AssistantGoalsService,
  GoalRecord,
  GoalRecordChangeEvent,
} from '@dsh-ray/assistant-goals'
import type { AssistantSkillsService } from '@dsh-ray/assistant-skills'
import type {
  AssistantWorkItemsService,
  WorkItemChangeEvent,
  WorkItemSummaryForHost,
} from '@dsh-ray/assistant-work-items'
import type {
  EventTriggersService,
  OwnerOutboxEventSummary,
} from '@dsh-ray/event-triggers'
import type {
  MemoryAgentContext,
  MemoryRecord,
  MemoryRecordChangeEvent,
  PersonalMemoryService,
} from '@dsh-ray/personal-memory'
import type {
  PersonalWikiService,
  WikiPage,
  WikiPageChangeEvent,
} from '@dsh-ray/personal-wiki'
import {
  DEFAULT_ASSOCIATION_DREAMING_CONFIG,
  projectDreamIdeasToAssociation,
  type AssociationDreamingNormalizedConfig,
  type DreamIdeaRecord,
} from './dreaming.js'
import { buildSharedEntityEdges, extractEntities } from './entities.js'
import {
  retractEvalPoolTask,
  upsertEvalPoolFromReceipt,
  withdrawEvalPoolTask,
  type EvalPoolVerifierPeer,
} from './eval-pool.js'
import { clampEdgeWeight, classifyEvaluationCorrection } from './hebbian.js'
import type { AssociationStore } from './sqlite.js'
import { normalizeEntityKey, tokenizeAssociationText } from './tokenize.js'
import {
  computeDeterministicEdgeId,
  computeDeterministicSynonymId,
  computeOwnerScopeKey,
  computePrincipalDigest,
  DEFAULT_HEBBIAN_CONFIG,
  normalizeSourceVersion,
  type AssociationOwnerScope,
  type DerivedRefInput,
  type NormalizedHebbianConfig,
  type UpsertEdgeInput,
  type UpsertNodeInput,
  type UpsertSynonymInput,
} from './types.js'
import type { AssociationWriteQueue } from './write-queue.js'

const MAX_ENTITY_PEERS_PER_UPSERT = 64
const MAX_SHARED_EDGES_PER_NODE = 16
const MAX_TITLE_CHARS = 160
const MAX_BODY_CHARS = 8_192

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sanitizeEventSummaryText(raw: string): string {
  return raw
    .replace(/\b(?:sk|pk|tok|token|secret|bearer)[_-]?[A-Za-z0-9._-]{12,}\b/giu, '[redacted]')
    .replace(/\bauthorization\s*:\s*\S+/giu, 'authorization:[redacted]')
}

function compactTitle(raw: string, maxChars = MAX_TITLE_CHARS): string {
  const collapsed = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const chars = [...collapsed]
  if (chars.length <= maxChars) return collapsed
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

function makeMemoryNodeId(
  recordId: string,
  scope: AssociationOwnerScope,
  existingPrimary: boolean,
): string {
  const base = `a:m-${recordId}`
  return existingPrimary ? base : `${base}~${scope.ownerScopeKey.slice(0, 8)}`
}

export interface SourceManagerCallbacks {
  readonly onImmediateWithdraw: (info: {
    readonly ownerScopeKey: string
    readonly sourcePlugin: string
    readonly sourceRef: string
    readonly nodeIds: readonly string[]
  }) => void
  readonly onConflictSuppressed: (info: {
    readonly nodeIds: readonly string[]
  }) => void
  readonly onTaskCorrected?: (info: {
    readonly ownerScopeKey: string
    readonly taskId: string
    readonly nodeIds: readonly string[]
    readonly nowMs: number
  }) => void
  readonly hebbianConfig?: NormalizedHebbianConfig
  readonly dreamingConfig?: AssociationDreamingNormalizedConfig
  readonly holdoutSeedKey?: Buffer | null
  readonly holdoutRateBps?: number
  readonly consumeSessionToolNames?: (sessionId: string) => readonly string[]
  readonly onEpisodesSynced?: (scope: AssociationOwnerScope) => void
  readonly onError?: (error: unknown) => void
  readonly now?: () => number
}

export class AssociationSourceManager {
  readonly #ctx: Context
  readonly #store: AssociationStore
  readonly #writeQueue: AssociationWriteQueue
  readonly #callbacks: SourceManagerCallbacks
  readonly #scopes = new Map<string, AssociationOwnerScope>()
  readonly #routeAuthorities = new Map<string, OwnerRouteScopeSummary>()
  readonly #assignedGlobalMemoryOwners = new Map<string, string>()
  readonly #disposers: Array<() => void> = []

  #syncTimer: ReturnType<typeof setTimeout> | null = null
  #syncInFlight: Promise<void> | null = null
  #syncQueued = false
  #disposed = false

  constructor(
    ctx: Context,
    store: AssociationStore,
    writeQueue: AssociationWriteQueue,
    callbacks: SourceManagerCallbacks,
  ) {
    this.#ctx = ctx
    this.#store = store
    this.#writeQueue = writeQueue
    this.#callbacks = callbacks
  }

  #now(): number {
    return this.#callbacks.now?.() ?? Date.now()
  }

  start(): void {
    // Load persisted scopes from SQLite
    for (const scope of this.#store.listOwnerScopes()) {
      this.#scopes.set(scope.ownerScopeKey, scope)
    }

    // Bind optional Delivery service
    const fDelivery = this.#ctx.inject(['assistantDelivery' as never], (deliveryCtx) => {
      const delivery = deliveryCtx.get('assistantDelivery' as never, false) as
        | AssistantDeliveryService
        | undefined
      if (delivery === undefined) return
      this.#discoverDeliveryScopes(delivery)
      const unsubFg =
        typeof delivery.onForegroundTaskCompletion === 'function'
          ? delivery.onForegroundTaskCompletion(() => {
              this.#discoverDeliveryScopes(delivery)
              this.scheduleSync()
            })
          : undefined
      return () => {
        unsubFg?.()
      }
    })
    this.#disposers.push(() => {
      void fDelivery.dispose()
    })

    // Bind optional PersonalMemory service
    const fMemory = this.#ctx.inject(['personalMemory' as never], (pmCtx) => {
      const pm = pmCtx.get('personalMemory' as never, false) as
        | PersonalMemoryService
        | undefined
      if (pm === undefined) return
      const unsub =
        typeof pm.onRecordChange === 'function'
          ? pm.onRecordChange((event) => {
              this.#handleMemoryRecordChange(event)
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsub?.()
      }
    })
    this.#disposers.push(() => {
      void fMemory.dispose()
    })

    // Bind optional AssistantGoals service
    const fGoals = this.#ctx.inject(['assistantGoals' as never], (goalsCtx) => {
      const goals = goalsCtx.get('assistantGoals' as never, false) as
        | AssistantGoalsService
        | undefined
      if (goals === undefined) return
      const unsub =
        typeof goals.onGoalRecordChange === 'function'
          ? goals.onGoalRecordChange((event) => {
              this.#handleGoalRecordChange(event)
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsub?.()
      }
    })
    this.#disposers.push(() => {
      void fGoals.dispose()
    })

    // Bind optional AssistantWorkItems service
    const fWorkItems = this.#ctx.inject(['assistantWorkItems' as never], (wiCtx) => {
      const workItems = wiCtx.get('assistantWorkItems' as never, false) as
        | AssistantWorkItemsService
        | undefined
      if (workItems === undefined) return
      const unsub =
        typeof workItems.onWorkItemChange === 'function'
          ? workItems.onWorkItemChange((event) => {
              this.#handleWorkItemChange(event)
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsub?.()
      }
    })
    this.#disposers.push(() => {
      void fWorkItems.dispose()
    })

    // Bind optional AssistantAutomations service
    const fAutomations = this.#ctx.inject(['assistantAutomations' as never], (autoCtx) => {
      const automations = autoCtx.get('assistantAutomations' as never, false) as
        | AssistantAutomationsService
        | undefined
      if (automations === undefined) return
      const unsub =
        typeof automations.onDefinitionChange === 'function'
          ? automations.onDefinitionChange((event) => {
              this.#handleAutomationChange(event)
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsub?.()
      }
    })
    this.#disposers.push(() => {
      void fAutomations.dispose()
    })

    // Bind optional AssistantEvaluation service
    const fEvaluation = this.#ctx.inject(['assistantEvaluation' as never], (evalCtx) => {
      const evaluation = evalCtx.get('assistantEvaluation' as never, false) as
        | AssistantEvaluationService
        | undefined
      if (evaluation === undefined) return
      const unsub =
        typeof evaluation.onTrustedTaskChange === 'function'
          ? evaluation.onTrustedTaskChange(() => {
              this.scheduleSync()
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsub?.()
      }
    })
    this.#disposers.push(() => {
      void fEvaluation.dispose()
    })

    // Bind optional PersonalWiki service
    const fWiki = this.#ctx.inject(['personalWiki' as never], (wikiCtx) => {
      const wiki = wikiCtx.get('personalWiki' as never, false) as PersonalWikiService | undefined
      if (wiki === undefined) return
      const unsub =
        typeof wiki.onPageChange === 'function'
          ? wiki.onPageChange((event) => {
              this.#handleWikiPageChange(event)
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsub?.()
      }
    })
    this.#disposers.push(() => {
      void fWiki.dispose()
    })

    // Bind optional AssistantSkills service
    const fSkills = this.#ctx.inject(['assistantSkills' as never], (skillsCtx) => {
      const skills = skillsCtx.get('assistantSkills' as never, false) as
        | AssistantSkillsService
        | undefined
      if (skills === undefined) return
      const unsub =
        typeof skills.onSkillChange === 'function'
          ? skills.onSkillChange(() => {
              this.scheduleSync()
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsub?.()
      }
    })
    this.#disposers.push(() => {
      void fSkills.dispose()
    })

    // Bind optional EventTriggers service
    const fTriggers = this.#ctx.inject(['eventTriggers' as never], (trigCtx) => {
      const triggers = trigCtx.get('eventTriggers' as never, false) as
        | EventTriggersService
        | undefined
      if (triggers === undefined) return
      const unsubChanges =
        typeof triggers.subscribeSourceChanges === 'function'
          ? triggers.subscribeSourceChanges(() => {
              this.scheduleSync()
            })
          : undefined
      const unsubIntake =
        typeof triggers.registerIntakeObserver === 'function'
          ? triggers.registerIntakeObserver({
              protocol: 1,
              observe: () => {
                this.scheduleSync()
              },
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsubChanges?.()
        unsubIntake?.()
      }
    })
    this.#disposers.push(() => {
      void fTriggers.dispose()
    })

    // Bind optional AssistantDreaming service
    const fDreaming = this.#ctx.inject(['assistantDreaming' as never], (dreamCtx) => {
      const dreaming = dreamCtx.get('assistantDreaming' as never, false) as
        | AssistantDreamingService
        | undefined
      if (dreaming === undefined) return
      const unsub =
        typeof dreaming.onIdeaChange === 'function'
          ? dreaming.onIdeaChange(() => {
              this.scheduleSync()
            })
          : undefined
      this.scheduleSync()
      return () => {
        unsub?.()
      }
    })
    this.#disposers.push(() => {
      void fDreaming.dispose()
    })
  }

  dispose(): void {
    this.#disposed = true
    if (this.#syncTimer !== null) {
      clearTimeout(this.#syncTimer)
      this.#syncTimer = null
    }
    while (this.#disposers.length > 0) {
      const dispose = this.#disposers.pop()!
      try {
        dispose()
      } catch {
        // Ignore disposer errors during teardown
      }
    }
  }

  registerScope(scope: AssociationOwnerScope): boolean {
    if (this.#disposed) return false
    const existing = this.#scopes.get(scope.ownerScopeKey)
    if (existing !== undefined && existing.authorityId === scope.authorityId) {
      return false
    }
    this.#scopes.set(scope.ownerScopeKey, scope)
    try {
      this.#store.upsertOwnerScope(scope, this.#now())
    } catch (error) {
      this.#callbacks.onError?.(error)
    }
    return existing === undefined
  }

  listScopes(): readonly AssociationOwnerScope[] {
    return [...this.#scopes.values()]
  }

  scheduleSync(delayMs = 15): void {
    if (this.#disposed) return
    if (this.#syncInFlight !== null) {
      this.#syncQueued = true
      return
    }
    if (this.#syncTimer !== null) return
    this.#syncTimer = setTimeout(() => {
      this.#syncTimer = null
      void this.syncAll()
    }, delayMs)
    this.#syncTimer.unref?.()
  }

  async syncAll(): Promise<void> {
    if (this.#disposed) return
    if (this.#syncInFlight !== null) {
      this.#syncQueued = true
      await this.#syncInFlight
      return
    }
    const run = async (): Promise<void> => {
      do {
        this.#syncQueued = false
        if (this.#syncTimer !== null) {
          clearTimeout(this.#syncTimer)
          this.#syncTimer = null
        }
        const delivery = this.#ctx.get('assistantDelivery' as never, false) as
          | AssistantDeliveryService
          | undefined
        if (delivery !== undefined) {
          this.#discoverDeliveryScopes(delivery)
        }
        for (const scope of Array.from(this.#scopes.values())) {
          if (this.#disposed) return
          await this.syncScope(scope)
        }
        await this.#writeQueue.flush()
        this.#assignedGlobalMemoryOwners.clear()
      } while (this.#syncQueued && !this.#disposed)
    }
    this.#syncInFlight = run().finally(() => {
      this.#syncInFlight = null
    })
    await this.#syncInFlight
  }

  async syncScope(scope: AssociationOwnerScope): Promise<void> {
    if (this.#disposed) return
    try {
      this.#syncPersonalMemoryScope(scope)
      this.#syncGoalsScope(scope)
      this.#syncWorkItemsScope(scope)
      this.#syncAutomationsScope(scope)
      this.#syncWikiScope(scope)
      this.#syncSkillsScope(scope)
      this.#syncEventTriggersScope(scope)
      this.#syncDreamIdeasScope(scope)
      const hadFg = this.#syncDeliveryEpisodesScope(scope)
      await this.#writeQueue.flush()
      if (this.#disposed) return
      const hadEval = this.#syncEvaluationScope(scope)
      await this.#writeQueue.flush()
      if ((hadFg || hadEval) && !this.#disposed) {
        this.#callbacks.onEpisodesSynced?.(scope)
      }
    } catch (error) {
      this.#callbacks.onError?.(error)
    }
  }

  #discoverDeliveryScopes(delivery: AssistantDeliveryService): void {
    if (typeof delivery.listActiveOwnerRouteScopes !== 'function') return
    let routes: readonly OwnerRouteScopeSummary[]
    try {
      routes = delivery.listActiveOwnerRouteScopes()
    } catch {
      return
    }
    for (const route of routes) {
      const principalDigest = computePrincipalDigest(route.principalId)
      const ownerScopeKey = computeOwnerScopeKey({
        mode: 'delivery',
        principalDigest,
        principalRecordId: route.principalRecordId,
        principalVersion: route.principalVersion,
        workspace: route.workspace,
        agentPreset: route.agentPreset,
      })
      this.#routeAuthorities.set(ownerScopeKey, route)
      this.registerScope({
        mode: 'delivery',
        ownerScopeKey,
        principalId: route.principalId,
        principalDigest,
        principalRecordId: route.principalRecordId,
        principalVersion: route.principalVersion,
        workspace: route.workspace,
        agentPreset: route.agentPreset,
        authorityId: route.authorityId,
      })
    }
  }

  #enqueueUpsertWithEdges(
    scope: AssociationOwnerScope,
    nodes: readonly UpsertNodeInput[],
    cursor?: { readonly sourcePlugin: string; readonly scopeKey: string; readonly cursorJson: string },
    extra?: {
      readonly synonyms?: readonly UpsertSynonymInput[]
      readonly extraDerivedRefs?: readonly DerivedRefInput[]
    },
  ): void {
    const extraSynonyms = extra?.synonyms ?? []
    const extraDerivedRefs = extra?.extraDerivedRefs ?? []
    if (
      nodes.length === 0 &&
      cursor === undefined &&
      extraSynonyms.length === 0 &&
      extraDerivedRefs.length === 0
    ) {
      return
    }
    const existingPeers =
      nodes.length > 0
        ? this.#store.loadEntityCandidateNodesForScope(scope.ownerScopeKey, MAX_ENTITY_PEERS_PER_UPSERT)
        : []
    const combinedPeers = [
      ...existingPeers,
      ...nodes
        .filter((n) => n.status !== 'withdrawn' && n.status !== 'suppressed' && n.sensitivity === 'private')
        .map((n) => ({
          id: n.id,
          sourceVersion: n.sourceVersion,
          ownerScopeKey: n.ownerScopeKey,
          trust: n.trust,
          entities: n.entities,
          updatedAt: n.updatedAt,
        })),
    ]
    const seenEdges = new Set<string>()
    const edges: UpsertEdgeInput[] = []
    const derivedRefs: DerivedRefInput[] = []
    const nowMs = this.#now()

    for (const node of nodes) {
      if (node.sensitivity !== 'private' || node.status === 'withdrawn' || node.status === 'suppressed') {
        continue
      }
      const built = buildSharedEntityEdges(
        {
          id: node.id,
          sourceVersion: node.sourceVersion,
          ownerScopeKey: node.ownerScopeKey,
          trust: node.trust,
          entities: node.entities,
          updatedAt: node.updatedAt,
        },
        combinedPeers,
        { maxEdgesPerNode: MAX_SHARED_EDGES_PER_NODE, nowMs },
      )
      for (const edge of built.edges) {
        if (seenEdges.has(edge.edgeId)) continue
        seenEdges.add(edge.edgeId)
        edges.push(edge)
      }
      derivedRefs.push(...built.derivedRefs)

      if (
        node.kind === 'episode' &&
        node.sourcePlugin === 'assistant-delivery' &&
        node.sourceRef.startsWith('foreground-turn:') &&
        this.#callbacks.hebbianConfig?.enabled !== false
      ) {
        const hebbianCfg = this.#callbacks.hebbianConfig ?? DEFAULT_HEBBIAN_CONFIG
        const initWeight = clampEdgeWeight(
          hebbianCfg.initialHebbianWeight,
          hebbianCfg.weightMin,
          hebbianCfg.weightMax,
        )
        const taskExposures = this.#store.findExposuresByTaskOrSession(
          scope.ownerScopeKey,
          node.sourceRef,
        )
        for (const exp of taskExposures) {
          if (
            exp.hop !== 0 ||
            (!exp.strongUsed && !exp.weakUsed) ||
            exp.corrected ||
            exp.nodeId === node.id
          ) {
            continue
          }
          const peerNode = this.#store.getNodeById(exp.nodeId)
          if (
            peerNode === null ||
            peerNode.status !== 'active' ||
            peerNode.ownerScopeKey !== scope.ownerScopeKey ||
            peerNode.sensitivity !== 'private'
          ) {
            continue
          }
          const [aId, bId] = node.id <= peerNode.id ? [node.id, peerNode.id] : [peerNode.id, node.id]
          const edgeId = computeDeterministicEdgeId(aId, bId, 'hebbian')
          if (!seenEdges.has(edgeId)) {
            seenEdges.add(edgeId)
            edges.push({
              edgeId,
              aId,
              bId,
              edgeType: 'hebbian',
              weight: initWeight,
              trust: node.trust === 'low' || peerNode.trust === 'low' ? 'low' : 'trusted',
              reason: 'hebbian:episode-co-use',
              useCount: 1,
              lastUsedAt: nowMs,
              createdAt: nowMs,
              updatedAt: nowMs,
            })
          }
          derivedRefs.push(
            {
              sourceNodeId: node.id,
              sourceVersion: node.sourceVersion,
              targetKind: 'edge',
              targetId: edgeId,
            },
            {
              sourceNodeId: peerNode.id,
              sourceVersion: peerNode.sourceVersion,
              targetKind: 'edge',
              targetId: edgeId,
            },
          )
        }
      }
    }

    this.#writeQueue.enqueue({
      kind: 'upsert-nodes',
      nodes,
      edges,
      ...(extraSynonyms.length > 0 ? { synonyms: extraSynonyms } : {}),
      derivedRefs:
        extraDerivedRefs.length > 0 ? [...derivedRefs, ...extraDerivedRefs] : derivedRefs,
      ...(cursor === undefined ? {} : { cursor }),
    })
  }

  #withdrawImmediate(input: {
    readonly ownerScopeKey: string
    readonly sourcePlugin: string
    readonly sourceRef: string
    readonly recordWithdrawalTombstone: boolean
  }): void {
    const nodeIds = this.#store.listCascadeNodeIdsForSource(
      input.ownerScopeKey,
      input.sourcePlugin,
      input.sourceRef,
    )
    for (const nid of nodeIds) {
      if (this.#assignedGlobalMemoryOwners.get(nid) === input.ownerScopeKey) {
        this.#assignedGlobalMemoryOwners.delete(nid)
      }
    }
    this.#writeQueue.markTombstoneSync({
      nodeIds,
      ownerScopeKey: input.ownerScopeKey,
      sourcePlugin: input.sourcePlugin,
      sourceRef: input.sourceRef,
    })
    this.#callbacks.onImmediateWithdraw({
      ownerScopeKey: input.ownerScopeKey,
      sourcePlugin: input.sourcePlugin,
      sourceRef: input.sourceRef,
      nodeIds,
    })
    this.#writeQueue.enqueue({
      kind: 'withdraw-source',
      ownerScopeKey: input.ownerScopeKey,
      sourcePlugin: input.sourcePlugin,
      sourceRef: input.sourceRef,
      hardDelete: true,
      recordWithdrawalTombstone: input.recordWithdrawalTombstone,
    })
  }

  // ---------------------------------------------------------------------------
  // Source (a): personal-memory
  // ---------------------------------------------------------------------------

  #toMemoryContext(scope: AssociationOwnerScope): MemoryAgentContext {
    if (scope.mode === 'delivery' && scope.principalRecordId !== null && scope.principalVersion !== null) {
      return {
        workspace: scope.workspace,
        agentPreset: scope.agentPreset,
        namespace: {
          mode: 'delivery',
          principalDigest: scope.principalDigest,
          principalRecordId: scope.principalRecordId,
          principalVersion: scope.principalVersion,
        },
      }
    }
    return {
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      namespace: {
        mode: 'headless',
        principalDigest: scope.principalDigest,
        lineageId: `headless:${scope.principalDigest}`,
        lineageVersion: 1,
      },
    }
  }

  #memoryRecordMatchesScope(record: MemoryRecord, scope: AssociationOwnerScope): boolean {
    if (record.namespace.mode === 'delivery') {
      if (
        scope.mode !== 'delivery' ||
        scope.principalDigest !== record.namespace.principalDigest ||
        scope.principalRecordId !== record.namespace.principalRecordId ||
        scope.principalVersion !== record.namespace.principalVersion
      ) {
        return false
      }
    } else if (record.namespace.mode === 'headless') {
      if (
        scope.mode !== 'headless' ||
        scope.principalDigest !== record.namespace.principalDigest
      ) {
        return false
      }
    }
    if (record.scope === 'workspace' && record.workspace !== scope.workspace) return false
    if (record.owner === 'agent' && record.agentPreset !== scope.agentPreset) return false
    return true
  }

  #mapMemoryRecordToNode(
    record: MemoryRecord,
    scope: AssociationOwnerScope,
  ): UpsertNodeInput {
    const baseId = `a:m-${record.id}`
    const pendingOwner = this.#assignedGlobalMemoryOwners.get(baseId)
    const existingGlobal = pendingOwner === undefined ? this.#store.getNodeById(baseId) : null
    const claimedOwner = pendingOwner ?? existingGlobal?.ownerScopeKey
    const canUseBaseId = claimedOwner === undefined || claimedOwner === scope.ownerScopeKey
    if (canUseBaseId) {
      this.#assignedGlobalMemoryOwners.set(baseId, scope.ownerScopeKey)
    }
    const nodeId = makeMemoryNodeId(record.id, scope, canUseBaseId)
    const claimText =
      record.knowledge?.claim !== undefined
        ? `${record.knowledge.claim.key}: ${record.knowledge.claim.value}`
        : ''
    const title = compactTitle(record.content)
    const body = [record.content, claimText].filter((s) => s.length > 0).join('\n').slice(0, MAX_BODY_CHARS)
    const combinedText = `${title}\n${body}`

    return {
      id: nodeId,
      kind: 'memory',
      sourcePlugin: 'personal-memory',
      sourceRef: `memory:${record.id}`,
      sourceVersion: normalizeSourceVersion(record.version),
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.mode === 'delivery' ? scope.principalRecordId : null,
      principalVersion: scope.mode === 'delivery' ? scope.principalVersion : null,
      scopeMode: record.scope,
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: record.trust === 'external' ? 'low' : 'trusted',
      sensitivity: record.sensitivity,
      title,
      body,
      entities: extractEntities(combinedText),
      tokens: tokenizeAssociationText(`${combinedText}\n${record.kind}`),
      metadata: {
        memoryOwner: record.owner,
        memoryScope: record.scope,
      },
      expiresAt: record.expiresAt ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  #syncPersonalMemoryScope(scope: AssociationOwnerScope): void {
    const pm = this.#ctx.get('personalMemory' as never, false) as PersonalMemoryService | undefined
    if (pm === undefined || typeof pm.listActiveRecordsForAssociationSync !== 'function') return

    const cursorRow = this.#store.getIngestCursor('personal-memory', scope.ownerScopeKey)
    let afterUpdatedAt: number | undefined
    let afterId: string | undefined
    if (cursorRow !== null) {
      try {
        const parsed = JSON.parse(cursorRow.cursorJson) as {
          updatedAt?: unknown
          id?: unknown
        }
        if (typeof parsed.updatedAt === 'number') afterUpdatedAt = parsed.updatedAt
        if (typeof parsed.id === 'string') afterId = parsed.id
      } catch {
        // Ignore malformed cursor
      }
    }

    const memCtx = this.#toMemoryContext(scope)
    while (!this.#disposed) {
      let records: readonly MemoryRecord[]
      try {
        records = pm.listActiveRecordsForAssociationSync(memCtx, {
          ...(afterUpdatedAt === undefined ? {} : { afterUpdatedAt }),
          ...(afterId === undefined ? {} : { afterId }),
          limit: 100,
        })
      } catch {
        return
      }
      if (records.length === 0) break

      const upserts: UpsertNodeInput[] = []
      let lastUpdatedAt = afterUpdatedAt ?? 0
      let lastId = afterId ?? ''
      for (const rec of records) {
        lastUpdatedAt = rec.updatedAt
        lastId = rec.id
        if (rec.status !== 'active') continue
        if (rec.expiresAt !== undefined && rec.expiresAt <= this.#now()) continue
        if (this.#store.isSourceWithdrawn(scope.ownerScopeKey, 'personal-memory', `memory:${rec.id}`)) {
          continue
        }
        upserts.push(this.#mapMemoryRecordToNode(rec, scope))
      }

      afterUpdatedAt = lastUpdatedAt
      afterId = lastId
      this.#enqueueUpsertWithEdges(scope, upserts, {
        sourcePlugin: 'personal-memory',
        scopeKey: scope.ownerScopeKey,
        cursorJson: JSON.stringify({ updatedAt: lastUpdatedAt, id: lastId }),
      })

      if (records.length < 100) break
    }
  }

  #handleMemoryRecordChange(event: MemoryRecordChangeEvent): void {
    if (this.#disposed) return
    const rec = event.record
    const hebbianCfg = this.#callbacks.hebbianConfig
    for (const scope of this.#scopes.values()) {
      if (!this.#memoryRecordMatchesScope(rec, scope)) continue
      if (event.op === 'remove' || rec.status === 'removed') {
        this.#withdrawImmediate({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: 'personal-memory',
          sourceRef: `memory:${rec.id}`,
          recordWithdrawalTombstone: event.reason === 'withdrawn',
        })
      } else {
        if (
          hebbianCfg?.enabled !== false &&
          (event.op === 'replace' ||
            (event.op === 'add' && typeof rec.supersedes === 'string' && rec.supersedes.length > 0))
        ) {
          const targetRecordIds = new Set<string>()
          if (event.op === 'replace') {
            targetRecordIds.add(rec.id)
          }
          if (typeof rec.supersedes === 'string' && rec.supersedes.length > 0) {
            targetRecordIds.add(rec.supersedes)
          }
          const nowMs = this.#now()
          const lookbackMs =
            hebbianCfg?.correctionLookbackMs ?? DEFAULT_HEBBIAN_CONFIG.correctionLookbackMs
          const minExposedAt = Math.max(0, nowMs - lookbackMs)
          for (const targetRecordId of targetRecordIds) {
            const existingNode = this.#store.findNodeBySourceRef(
              scope.ownerScopeKey,
              'personal-memory',
              `memory:${targetRecordId}`,
            )
            const targetNodeId = existingNode?.id ?? `a:m-${targetRecordId}`
            const latestExp = this.#store.findLatestUncorrectedMemoryExposure(
              scope.ownerScopeKey,
              targetNodeId,
              minExposedAt,
            )
            this.#writeQueue.enqueue({
              kind: 'apply-hebbian-correction',
              ownerScopeKey: scope.ownerScopeKey,
              nodeId: targetNodeId,
              minExposedAt,
              nowMs,
              ...(hebbianCfg === undefined ? {} : { hebbianConfig: hebbianCfg }),
            })
            if (latestExp !== null) {
              this.#callbacks.onTaskCorrected?.({
                ownerScopeKey: scope.ownerScopeKey,
                taskId: latestExp.taskId,
                nodeIds: [targetNodeId],
                nowMs,
              })
            }
          }
        }
        const node = this.#mapMemoryRecordToNode(rec, scope)
        this.#enqueueUpsertWithEdges(scope, [node])
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Source (b): assistant-goals
  // ---------------------------------------------------------------------------

  #mapGoalRecordToNode(record: GoalRecord, scope: AssociationOwnerScope): UpsertNodeInput {
    const title = compactTitle(`[${record.native.phase}] ${record.definition.objective}`)
    const body = [
      record.definition.objective,
      record.checkpoint.nextStep,
      ...record.checkpoint.blockers,
    ]
      .filter((s) => s.trim().length > 0)
      .join('\n')
      .slice(0, MAX_BODY_CHARS)
    const combinedText = `${title}\n${body}`

    return {
      id: `a:g-${record.id}`,
      kind: 'goal',
      sourcePlugin: 'assistant-goals',
      sourceRef: `goal:${record.id}`,
      sourceVersion: normalizeSourceVersion(`v${record.version}:def${record.definition.version}`),
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.mode === 'delivery' ? scope.principalRecordId : null,
      principalVersion: scope.mode === 'delivery' ? scope.principalVersion : null,
      scopeMode: 'workspace',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: 'trusted',
      sensitivity: 'private',
      title,
      body,
      entities: extractEntities(combinedText),
      tokens: tokenizeAssociationText(combinedText),
      metadata: {
        extra: {
          goalId: record.id,
          phase: record.native.phase,
        },
      },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  #syncGoalsScope(scope: AssociationOwnerScope): void {
    if (
      scope.mode !== 'delivery' ||
      scope.principalRecordId === null ||
      scope.principalVersion === null
    ) {
      return
    }
    const goals = this.#ctx.get('assistantGoals' as never, false) as
      | AssistantGoalsService
      | undefined
    if (goals === undefined || typeof goals.inspectOwnerGoals !== 'function') return

    let records: readonly GoalRecord[]
    try {
      records = goals.inspectOwnerGoals(
        {
          principalId: scope.principalId,
          principalRecordId: scope.principalRecordId,
          principalVersion: scope.principalVersion,
          workspace: scope.workspace,
          preset: scope.agentPreset,
        },
        50,
      )
    } catch {
      return
    }

    const upserts: UpsertNodeInput[] = []
    for (const rec of records) {
      if (rec.native.phase === 'cleared') continue
      if (this.#store.isSourceWithdrawn(scope.ownerScopeKey, 'assistant-goals', `goal:${rec.id}`)) {
        continue
      }
      upserts.push(this.#mapGoalRecordToNode(rec, scope))
    }
    this.#enqueueUpsertWithEdges(scope, upserts)
  }

  #handleGoalRecordChange(event: GoalRecordChangeEvent): void {
    if (this.#disposed) return
    const principalDigest = computePrincipalDigest(event.scope.principalId)
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest,
      principalRecordId: event.scope.principalRecordId,
      principalVersion: event.scope.principalVersion,
      workspace: event.scope.workspace,
      agentPreset: event.scope.preset,
    })
    const scope = this.#scopes.get(ownerScopeKey)
    if (scope === undefined) return

    if (event.clearedGoalId !== undefined || event.record?.native.phase === 'cleared') {
      const goalId = event.clearedGoalId ?? event.record!.id
      this.#withdrawImmediate({
        ownerScopeKey,
        sourcePlugin: 'assistant-goals',
        sourceRef: `goal:${goalId}`,
        recordWithdrawalTombstone: false,
      })
      return
    }

    if (event.record !== undefined) {
      this.#enqueueUpsertWithEdges(scope, [this.#mapGoalRecordToNode(event.record, scope)])
    }
  }

  // ---------------------------------------------------------------------------
  // Source (c): assistant-work-items
  // ---------------------------------------------------------------------------

  #mapWorkItemToNode(
    item: WorkItemSummaryForHost,
    scope: AssociationOwnerScope,
  ): UpsertNodeInput {
    const title = compactTitle(`[${item.state}] ${item.title}`)
    const body = [item.title, item.brief, item.lastReportSummary ?? '']
      .filter((s) => s.trim().length > 0)
      .join('\n')
      .slice(0, MAX_BODY_CHARS)
    const combinedText = `${title}\n${body}`

    return {
      id: `a:w-${item.id}`,
      kind: 'work-item',
      sourcePlugin: 'assistant-work-items',
      sourceRef: `work-item:${item.id}`,
      sourceVersion: normalizeSourceVersion(`u${item.updatedAt}:r${item.revisionCount}:${item.state}`),
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.mode === 'delivery' ? scope.principalRecordId : null,
      principalVersion: scope.mode === 'delivery' ? scope.principalVersion : null,
      scopeMode: 'workspace',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: item.observed ? 'low' : 'trusted',
      sensitivity: 'private',
      title,
      body,
      entities: extractEntities(combinedText),
      tokens: tokenizeAssociationText(combinedText),
      metadata: {
        extra: {
          workItemId: item.id,
          state: item.state,
          observed: item.observed,
        },
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }
  }

  #syncWorkItemsScope(scope: AssociationOwnerScope): void {
    if (
      scope.mode !== 'delivery' ||
      scope.principalRecordId === null ||
      scope.principalVersion === null ||
      scope.authorityId === undefined
    ) {
      return
    }
    const workItems = this.#ctx.get('assistantWorkItems' as never, false) as
      | AssistantWorkItemsService
      | undefined
    if (workItems === undefined || typeof workItems.inspectOwnerWorkItems !== 'function') return

    let items: readonly WorkItemSummaryForHost[]
    try {
      items = workItems.inspectOwnerWorkItems(
        {
          principalId: scope.principalId,
          principalRecordId: scope.principalRecordId,
          principalVersion: scope.principalVersion,
          workspace: scope.workspace,
          preset: scope.agentPreset,
          ownerRouteId: scope.authorityId,
        },
        { limit: 100 },
      )
    } catch {
      return
    }

    const upserts: UpsertNodeInput[] = []
    for (const item of items) {
      if (item.state === 'dropped' && item.stateReason === 'signal-withdrawn') {
        this.#withdrawImmediate({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: 'assistant-work-items',
          sourceRef: `work-item:${item.id}`,
          recordWithdrawalTombstone: true,
        })
        continue
      }
      if (
        this.#store.isSourceWithdrawn(
          scope.ownerScopeKey,
          'assistant-work-items',
          `work-item:${item.id}`,
        )
      ) {
        continue
      }
      upserts.push(this.#mapWorkItemToNode(item, scope))
    }
    this.#enqueueUpsertWithEdges(scope, upserts)
  }

  #handleWorkItemChange(event: WorkItemChangeEvent): void {
    if (this.#disposed) return
    const principalDigest = computePrincipalDigest(event.scope.principalId)
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest,
      principalRecordId: event.scope.principalRecordId,
      principalVersion: event.scope.principalVersion,
      workspace: event.scope.workspace,
      agentPreset: event.scope.preset,
    })
    const scope = this.#scopes.get(ownerScopeKey)
    if (scope === undefined) return

    if (event.op === 'withdraw') {
      this.#withdrawImmediate({
        ownerScopeKey,
        sourcePlugin: 'assistant-work-items',
        sourceRef: `work-item:${event.itemId}`,
        recordWithdrawalTombstone: true,
      })
      return
    }

    this.#syncWorkItemsScope(scope)
  }

  // ---------------------------------------------------------------------------
  // Source (d): assistant-automations
  // ---------------------------------------------------------------------------

  #mapAutomationToNode(
    record: AutomationRecord,
    scope: AssociationOwnerScope,
  ): UpsertNodeInput {
    const def = record.definition
    const scheduleDesc = JSON.stringify(def.schedule)
    const execDesc =
      'execution' in def && def.execution?.kind === 'host'
        ? `runbook:${def.execution.runbookId}`
        : (def as { readonly prompt?: string }).prompt ?? ''
    const title = compactTitle(`[${record.status}] ${def.name}`)
    const body = `${def.name}\n${scheduleDesc}\n${execDesc}`.slice(0, MAX_BODY_CHARS)
    const combinedText = `${title}\n${body}`

    return {
      id: `a:au-${record.id}`,
      kind: 'automation',
      sourcePlugin: 'assistant-automations',
      sourceRef: `automation:${record.id}`,
      sourceVersion: normalizeSourceVersion(`v${record.version}:${record.status}`),
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.mode === 'delivery' ? scope.principalRecordId : null,
      principalVersion: scope.mode === 'delivery' ? scope.principalVersion : null,
      scopeMode: 'workspace',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: 'trusted',
      sensitivity: 'private',
      title,
      body,
      entities: extractEntities(combinedText),
      tokens: tokenizeAssociationText(combinedText),
      metadata: {
        extra: {
          automationId: record.id,
          status: record.status,
        },
      },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  #syncAutomationsScope(scope: AssociationOwnerScope): void {
    const automations = this.#ctx.get('assistantAutomations' as never, false) as
      | AssistantAutomationsService
      | undefined
    if (automations === undefined || typeof automations.inspectOwnerAutomations !== 'function') {
      return
    }

    let records: readonly AutomationRecord[]
    try {
      records = automations.inspectOwnerAutomations({
        principalId: scope.principalId,
        workspace: scope.workspace,
        preset: scope.agentPreset,
        limit: 100,
      })
    } catch {
      return
    }

    const upserts: UpsertNodeInput[] = []
    for (const rec of records) {
      if (rec.status === 'deleted') {
        this.#withdrawImmediate({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: 'assistant-automations',
          sourceRef: `automation:${rec.id}`,
          recordWithdrawalTombstone: true,
        })
        continue
      }
      if (
        this.#store.isSourceWithdrawn(
          scope.ownerScopeKey,
          'assistant-automations',
          `automation:${rec.id}`,
        )
      ) {
        continue
      }
      upserts.push(this.#mapAutomationToNode(rec, scope))
    }
    this.#enqueueUpsertWithEdges(scope, upserts)
  }

  #handleAutomationChange(event: AutomationDefinitionChangeEvent): void {
    if (this.#disposed) return
    for (const scope of this.#scopes.values()) {
      if (
        scope.workspace !== event.workspace ||
        scope.agentPreset !== event.agentPreset ||
        scope.principalId !== event.principal
      ) {
        continue
      }
      if (event.status === 'deleted') {
        this.#withdrawImmediate({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: 'assistant-automations',
          sourceRef: `automation:${event.automationId}`,
          recordWithdrawalTombstone: true,
        })
      } else {
        this.#syncAutomationsScope(scope)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Source (d.1): personal-wiki
  // ---------------------------------------------------------------------------

  #mapWikiPageToNode(
    page: WikiPage,
    scope: AssociationOwnerScope,
  ): {
    readonly node: UpsertNodeInput
    readonly synonyms: readonly UpsertSynonymInput[]
    readonly derivedRefs: readonly DerivedRefInput[]
  } {
    const scope8 = scope.ownerScopeKey.slice(0, 8)
    const rawId = `a:wk-${scope8}-${page.metadata.id}`
    const nodeId =
      rawId.length <= 128 ? rawId : `a:wk-${scope8}-${sha256Hex(page.metadata.id).slice(0, 24)}`
    const title = compactTitle(page.metadata.title)
    const body = page.body.slice(0, MAX_BODY_CHARS)
    const combinedText = `${title}\n${body}\n${page.metadata.tags.join(' ')}\n${page.metadata.aliases.join(' ')}`
    const extracted = extractEntities(combinedText)
    const entitySet = new Set<string>(extracted)
    const normalizedTitle = normalizeEntityKey(page.metadata.title)
    if (normalizedTitle !== null) entitySet.add(normalizedTitle)
    for (const tag of page.metadata.tags) {
      const k = normalizeEntityKey(tag)
      if (k !== null) entitySet.add(k)
    }
    for (const alias of page.metadata.aliases) {
      const k = normalizeEntityKey(alias)
      if (k !== null) entitySet.add(k)
    }
    const entities = [...entitySet]
    const parsedCreated = Date.parse(page.metadata.created)
    const parsedUpdated = Date.parse(page.metadata.updated)
    const nowMs = this.#now()
    const createdAt = Number.isFinite(parsedCreated) && parsedCreated >= 0 ? parsedCreated : nowMs
    const updatedAt = Number.isFinite(parsedUpdated) && parsedUpdated >= 0 ? parsedUpdated : nowMs
    const sourceVersion = normalizeSourceVersion(page.revision)

    const synonyms: UpsertSynonymInput[] = []
    const derivedRefs: DerivedRefInput[] = []
    if (page.metadata.status !== 'draft' && page.metadata.aliases.length > 0) {
      const canonical = normalizedTitle ?? entities[0] ?? null
      if (canonical !== null) {
        for (const alias of page.metadata.aliases) {
          const surface = normalizeEntityKey(alias)
          if (surface === null || surface === canonical) continue
          const synId = computeDeterministicSynonymId(scope.ownerScopeKey, surface, canonical)
          synonyms.push({
            id: synId,
            ownerScopeKey: scope.ownerScopeKey,
            surface,
            canonicalEntity: canonical,
            sourceNodeId: nodeId,
            trust: 'trusted',
            createdAt: updatedAt,
          })
          derivedRefs.push({
            sourceNodeId: nodeId,
            sourceVersion,
            targetKind: 'synonym',
            targetId: synId,
          })
        }
      }
    }

    const node: UpsertNodeInput = {
      id: nodeId,
      kind: 'wiki',
      sourcePlugin: 'personal-wiki',
      sourceRef: `wiki:${page.metadata.id}`,
      sourceVersion,
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.mode === 'delivery' ? scope.principalRecordId : null,
      principalVersion: scope.mode === 'delivery' ? scope.principalVersion : null,
      scopeMode: 'user-global',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: page.metadata.status === 'draft' ? 'low' : 'trusted',
      sensitivity: 'private',
      title,
      body,
      entities,
      tokens: tokenizeAssociationText(combinedText),
      metadata: {
        extra: {
          pageId: page.metadata.id,
          relativePath: page.relativePath,
          status: page.metadata.status,
          authority: page.metadata.authority,
          type: page.metadata.type,
          aliases: [...page.metadata.aliases],
        },
      },
      createdAt,
      updatedAt,
    }
    return { node, synonyms, derivedRefs }
  }

  #syncWikiScope(scope: AssociationOwnerScope): void {
    const wiki = this.#ctx.get('personalWiki' as never, false) as PersonalWikiService | undefined
    if (wiki === undefined || typeof wiki.inspectHostPages !== 'function') return

    let pages: readonly WikiPage[]
    try {
      pages = wiki.inspectHostPages({ includeArchived: false })
    } catch {
      return
    }

    const activeRefs = new Set<string>()
    const upserts: UpsertNodeInput[] = []
    const synonyms: UpsertSynonymInput[] = []
    const extraDerivedRefs: DerivedRefInput[] = []
    for (const page of pages) {
      if (page.metadata.status === 'archived') continue
      const sourceRef = `wiki:${page.metadata.id}`
      activeRefs.add(sourceRef)
      if (this.#store.isSourceWithdrawn(scope.ownerScopeKey, 'personal-wiki', sourceRef)) {
        continue
      }
      const mapped = this.#mapWikiPageToNode(page, scope)
      upserts.push(mapped.node)
      synonyms.push(...mapped.synonyms)
      extraDerivedRefs.push(...mapped.derivedRefs)
    }

    for (const existingRef of this.#store.listActiveSourceRefsForPlugin(
      scope.ownerScopeKey,
      'personal-wiki',
    )) {
      if (!activeRefs.has(existingRef)) {
        this.#withdrawImmediate({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: 'personal-wiki',
          sourceRef: existingRef,
          recordWithdrawalTombstone: false,
        })
      }
    }

    this.#enqueueUpsertWithEdges(scope, upserts, undefined, {
      synonyms,
      extraDerivedRefs,
    })
  }

  #handleWikiPageChange(event: WikiPageChangeEvent): void {
    if (this.#disposed) return
    if (
      event.kind === 'archived' ||
      event.kind === 'deleted' ||
      event.page?.metadata.status === 'archived'
    ) {
      for (const scope of this.#scopes.values()) {
        this.#withdrawImmediate({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: 'personal-wiki',
          sourceRef: `wiki:${event.pageId}`,
          recordWithdrawalTombstone: false,
        })
      }
      return
    }
    this.scheduleSync()
  }

  // ---------------------------------------------------------------------------
  // Source (d.2): assistant-skills
  // ---------------------------------------------------------------------------

  #syncSkillsScope(scope: AssociationOwnerScope): void {
    if (
      scope.mode !== 'delivery' ||
      scope.principalRecordId === null ||
      scope.principalVersion === null
    ) {
      return
    }
    const skills = this.#ctx.get('assistantSkills' as never, false) as
      | AssistantSkillsService
      | undefined
    if (skills === undefined || typeof skills.inspectOwnerActiveSkills !== 'function') return

    let activeSkills: ReturnType<AssistantSkillsService['inspectOwnerActiveSkills']>
    try {
      activeSkills = skills.inspectOwnerActiveSkills({
        principalId: scope.principalId,
        principalRecordId: scope.principalRecordId,
        principalVersion: scope.principalVersion,
        workspace: scope.workspace,
        preset: scope.agentPreset,
      })
    } catch {
      return
    }

    const activeRefs = new Set<string>()
    const upserts: UpsertNodeInput[] = []
    const nowMs = this.#now()

    for (const skill of activeSkills) {
      if ((skill as { readonly retired?: boolean }).retired === true) continue
      const sourceRef = `skill:${skill.name}`
      activeRefs.add(sourceRef)
      if (this.#store.isSourceWithdrawn(scope.ownerScopeKey, 'assistant-skills', sourceRef)) {
        continue
      }
      const toolNames = [
        ...new Set(skill.steps.map((s) => s.toolName).filter((t) => t.trim().length > 0)),
      ]
      const title = compactTitle(`[skill] ${skill.name}: ${skill.description}`)
      const body = [
        skill.name,
        skill.description,
        skill.inputs.length > 0 ? `inputs: ${skill.inputs.map((i) => i.name).join(', ')}` : '',
        toolNames.length > 0 ? `tools: ${toolNames.join(' -> ')}` : '',
      ]
        .filter((s) => s.length > 0)
        .join('\n')
        .slice(0, MAX_BODY_CHARS)
      const combinedText = `${title}\n${body}`
      const entitySet = new Set<string>(extractEntities(combinedText))
      const normName = normalizeEntityKey(skill.name)
      if (normName !== null) entitySet.add(normName)
      for (const tool of toolNames) {
        const normTool = normalizeEntityKey(tool)
        if (normTool !== null) entitySet.add(normTool)
      }
      const skillVersionRaw = (skill as { readonly version?: number }).version
      const definitionDigest = (skill as { readonly definitionDigest?: string }).definitionDigest
      const sourceVersion =
        typeof skillVersionRaw === 'number' && Number.isSafeInteger(skillVersionRaw)
          ? skillVersionRaw
          : normalizeSourceVersion(definitionDigest ?? 1)
      const createdAtRaw = (skill as { readonly createdAt?: number }).createdAt
      const updatedAtRaw = (skill as { readonly updatedAt?: number }).updatedAt
      const createdAt = typeof createdAtRaw === 'number' ? createdAtRaw : nowMs
      const updatedAt = typeof updatedAtRaw === 'number' ? updatedAtRaw : nowMs

      upserts.push({
        id: `a:sk-${scope.ownerScopeKey.slice(0, 8)}-${sha256Hex(skill.name).slice(0, 24)}`,
        kind: 'skill',
        sourcePlugin: 'assistant-skills',
        sourceRef,
        sourceVersion,
        ownerScopeKey: scope.ownerScopeKey,
        ownerMode: scope.mode,
        principalDigest: scope.principalDigest,
        principalRecordId: scope.principalRecordId,
        principalVersion: scope.principalVersion,
        scopeMode: 'workspace',
        workspace: scope.workspace,
        agentPreset: scope.agentPreset,
        trust: 'trusted',
        sensitivity: 'private',
        title,
        body,
        entities: [...entitySet],
        tokens: tokenizeAssociationText(combinedText),
        metadata: {
          ...(toolNames.length > 0 ? { toolNames } : {}),
          extra: {
            skillName: skill.name,
            version: sourceVersion,
          },
        },
        createdAt,
        updatedAt,
      })
    }

    for (const existingRef of this.#store.listActiveSourceRefsForPlugin(
      scope.ownerScopeKey,
      'assistant-skills',
    )) {
      if (!activeRefs.has(existingRef)) {
        this.#withdrawImmediate({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: 'assistant-skills',
          sourceRef: existingRef,
          recordWithdrawalTombstone: false,
        })
      }
    }

    this.#enqueueUpsertWithEdges(scope, upserts)
  }

  // ---------------------------------------------------------------------------
  // Source (d.3): event-triggers
  // ---------------------------------------------------------------------------

  #mapOutboxEventToNode(
    item: OwnerOutboxEventSummary,
    scope: AssociationOwnerScope,
  ): UpsertNodeInput {
    const rawKey = `${item.triggerId}\0${item.eventId}`
    const scope8 = scope.ownerScopeKey.slice(0, 8)
    const nodeId = `a:ev-${scope8}-${sha256Hex(rawKey).slice(0, 24)}`
    const candidateRef = `event:${item.triggerId}:${item.eventId}`
    const sourceRef =
      candidateRef.length <= 512 ? candidateRef : `event:${sha256Hex(rawKey).slice(0, 32)}`
    const sanitizedTitle = sanitizeEventSummaryText(item.title)
    const sanitizedSummary = sanitizeEventSummaryText(item.summary)
    const title = compactTitle(`[event:${item.triggerKind}] ${sanitizedTitle}`)
    const body = `${sanitizedTitle}\n${sanitizedSummary}`.slice(0, MAX_BODY_CHARS)
    const combinedText = `${title}\n${sanitizedSummary}\n${item.entities.join(' ')}`
    const entitySet = new Set<string>(extractEntities(combinedText))
    for (const ent of item.entities) {
      const k = normalizeEntityKey(sanitizeEventSummaryText(ent))
      if (k !== null) entitySet.add(k)
    }
    const ttlMs = item.ttlMs !== undefined && item.ttlMs > 0 ? item.ttlMs : null
    const expiresAt = ttlMs !== null ? item.occurredAt + ttlMs : null

    return {
      id: nodeId,
      kind: 'event',
      sourcePlugin: 'event-triggers',
      sourceRef,
      sourceVersion: Math.max(1, item.sequence),
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.principalRecordId,
      principalVersion: scope.principalVersion,
      scopeMode: 'workspace',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: 'low',
      sensitivity: 'private',
      title,
      body,
      entities: [...entitySet],
      tokens: tokenizeAssociationText(combinedText),
      metadata: {
        extra: {
          triggerId: item.triggerId,
          triggerKind: item.triggerKind,
          automationId: item.automationId,
          eventId: item.eventId,
          sequence: item.sequence,
          envelopeDigest: item.envelopeDigest,
          observationDigest: item.observationDigest,
        },
      },
      ttlMs,
      expiresAt,
      createdAt: item.occurredAt,
      updatedAt: item.occurredAt,
    }
  }

  #syncEventTriggersScope(scope: AssociationOwnerScope): void {
    if (
      scope.mode !== 'delivery' ||
      scope.principalRecordId === null ||
      scope.principalVersion === null
    ) {
      return
    }
    const triggers = this.#ctx.get('eventTriggers' as never, false) as
      | EventTriggersService
      | undefined
    if (triggers === undefined) return

    const ownerScope = {
      principalId: scope.principalId,
      principalRecordId: scope.principalRecordId,
      principalVersion: scope.principalVersion,
      workspace: scope.workspace,
      preset: scope.agentPreset,
    }

    const nowMs = this.#now()
    if (typeof triggers.inspectOwnerSources === 'function') {
      let activeSources: ReturnType<EventTriggersService['inspectOwnerSources']>
      try {
        activeSources = triggers.inspectOwnerSources(ownerScope)
      } catch {
        activeSources = []
      }
      const activeTriggerIds = new Set(activeSources.map((s) => s.triggerId))
      for (const existingNode of this.#store.listActiveNodesBySourcePlugin(
        scope.ownerScopeKey,
        'event-triggers',
      )) {
        const triggerId = existingNode.metadata.extra?.triggerId
        const isExpired = existingNode.expiresAt !== null && existingNode.expiresAt <= nowMs
        if (
          isExpired ||
          (typeof triggerId === 'string' && !activeTriggerIds.has(triggerId))
        ) {
          this.#withdrawImmediate({
            ownerScopeKey: scope.ownerScopeKey,
            sourcePlugin: 'event-triggers',
            sourceRef: existingNode.sourceRef,
            recordWithdrawalTombstone: false,
          })
        }
      }
    }

    if (typeof triggers.inspectOwnerOutboxEvents !== 'function') return

    const cursorRow = this.#store.getIngestCursor('event-triggers', scope.ownerScopeKey)
    let afterSequence = 0
    if (cursorRow !== null) {
      try {
        const parsed = JSON.parse(cursorRow.cursorJson) as { afterSequence?: unknown }
        if (
          typeof parsed.afterSequence === 'number' &&
          Number.isSafeInteger(parsed.afterSequence) &&
          parsed.afterSequence >= 0
        ) {
          afterSequence = parsed.afterSequence
        }
      } catch {
        afterSequence = 0
      }
    }

    while (!this.#disposed) {
      let page: ReturnType<EventTriggersService['inspectOwnerOutboxEvents']>
      try {
        page = triggers.inspectOwnerOutboxEvents({
          scope: ownerScope,
          afterSequence,
          limit: 100,
        })
      } catch {
        return
      }

      if (page.items.length === 0) break

      const upserts: UpsertNodeInput[] = []
      for (const item of page.items) {
        const expiresAt =
          item.ttlMs !== undefined && item.ttlMs > 0 ? item.occurredAt + item.ttlMs : null
        if (expiresAt !== null && expiresAt <= nowMs) continue
        const mapped = this.#mapOutboxEventToNode(item, scope)
        if (
          this.#store.isSourceWithdrawn(
            scope.ownerScopeKey,
            'event-triggers',
            mapped.sourceRef,
          )
        ) {
          continue
        }
        upserts.push(mapped)
      }

      afterSequence = page.nextSequence
      this.#enqueueUpsertWithEdges(scope, upserts, {
        sourcePlugin: 'event-triggers',
        scopeKey: scope.ownerScopeKey,
        cursorJson: JSON.stringify({ afterSequence: page.nextSequence }),
      })

      if (!page.hasMore) break
    }
  }

  // ---------------------------------------------------------------------------
  // Source (d.4): assistant-dreaming ideas
  // ---------------------------------------------------------------------------

  #syncDreamIdeasScope(scope: AssociationOwnerScope): void {
    const dreaming = this.#ctx.get('assistantDreaming' as never, false) as
      | AssistantDreamingService
      | undefined
    if (dreaming === undefined || typeof dreaming.inspectIdeas !== 'function') return

    let rawIdeas: ReturnType<AssistantDreamingService['inspectIdeas']>
    try {
      rawIdeas = dreaming.inspectIdeas(200)
    } catch {
      return
    }
    if (rawIdeas.length === 0) return

    const ideas: DreamIdeaRecord[] = rawIdeas.map((idea) => ({
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

    const cfg = this.#callbacks.dreamingConfig ?? DEFAULT_ASSOCIATION_DREAMING_CONFIG
    const projected = projectDreamIdeasToAssociation(ideas, scope, cfg, this.#now())

    for (const withdrawal of projected.withdrawals) {
      if (
        this.#store.findNodeBySourceRef(
          withdrawal.ownerScopeKey,
          withdrawal.sourcePlugin,
          withdrawal.sourceRef,
        ) !== null
      ) {
        this.#withdrawImmediate({
          ownerScopeKey: withdrawal.ownerScopeKey,
          sourcePlugin: withdrawal.sourcePlugin,
          sourceRef: withdrawal.sourceRef,
          recordWithdrawalTombstone: true,
        })
      }
    }

    const upserts = projected.upserts.filter(
      (node) =>
        !this.#store.isSourceWithdrawn(
          scope.ownerScopeKey,
          node.sourcePlugin,
          node.sourceRef,
        ),
    )
    if (upserts.length > 0) {
      this.#enqueueUpsertWithEdges(scope, upserts)
    }
  }

  // ---------------------------------------------------------------------------
  // Source (e): Episodes (Delivery foreground + Evaluation projections)
  // ---------------------------------------------------------------------------

  #mapDeliveryEpisodeToNode(
    content: OwnerForegroundTaskSourceContent,
    scope: AssociationOwnerScope,
  ): UpsertNodeInput {
    const src = content.source
    const toolNames =
      this.#callbacks.consumeSessionToolNames?.(src.binding.sessionId) ?? []
    const inputFirstLine =
      content.input.text.split(/\r?\n/u).find((l) => l.trim().length > 0) ?? content.input.text
    const title = compactTitle(`[turn] ${inputFirstLine}`)
    const toolSuffix = toolNames.length > 0 ? `\ntools: ${toolNames.join(', ')}` : ''
    const body = `${content.input.text}\n---\n${content.reply.text}${toolSuffix}`.slice(
      0,
      MAX_BODY_CHARS,
    )
    const combinedText = `${title}\n${content.input.text}\n${content.reply.text}`
    const completedAt = src.execution.completedAt ?? this.#now()

    const srcOutcomeId = (src as { readonly outcomeId?: unknown }).outcomeId
    return {
      id: `a:e-fg-${src.inboxId}`,
      kind: 'episode',
      sourcePlugin: 'assistant-delivery',
      sourceRef: `foreground-turn:${src.inboxId}`,
      sourceVersion: normalizeSourceVersion(content.sourceDigest.slice(0, 16)),
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.mode === 'delivery' ? scope.principalRecordId : null,
      principalVersion: scope.mode === 'delivery' ? scope.principalVersion : null,
      scopeMode: 'workspace',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: 'trusted',
      sensitivity: 'private',
      title,
      body,
      entities: extractEntities(combinedText),
      tokens: tokenizeAssociationText(combinedText),
      metadata: {
        ...(toolNames.length > 0 ? { toolNames: [...toolNames] } : {}),
        extra: {
          inboxId: src.inboxId,
          sessionId: src.binding.sessionId,
          ...(typeof srcOutcomeId === 'string' && srcOutcomeId.length > 0
            ? { outcomeId: srcOutcomeId }
            : {}),
        },
      },
      createdAt: completedAt,
      updatedAt: completedAt,
    }
  }

  #syncDeliveryEpisodesScope(scope: AssociationOwnerScope): boolean {
    if (
      scope.mode !== 'delivery' ||
      scope.principalRecordId === null ||
      scope.principalVersion === null ||
      scope.authorityId === undefined
    ) {
      return false
    }
    const route = this.#routeAuthorities.get(scope.ownerScopeKey)
    if (route === undefined) return false
    const delivery = this.#ctx.get('assistantDelivery' as never, false) as
      | AssistantDeliveryService
      | undefined
    if (
      delivery === undefined ||
      typeof delivery.listOwnerForegroundTaskSources !== 'function' ||
      typeof delivery.withOwnerForegroundTaskSourcesFence !== 'function'
    ) {
      return false
    }

    const cursorRow = this.#store.getIngestCursor('delivery-foreground', scope.ownerScopeKey)
    let after: OwnerForegroundTaskSourceCursor | undefined
    if (cursorRow !== null) {
      try {
        after = JSON.parse(cursorRow.cursorJson) as OwnerForegroundTaskSourceCursor
      } catch {
        after = undefined
      }
    }

    const ownerScopeInput = {
      authorityId: route.authorityId,
      principalId: scope.principalId,
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      expectedOwner: {
        authorityHash: route.authorityHash,
        principalRecordId: scope.principalRecordId,
        principalVersion: scope.principalVersion,
      },
    }

    let syncedAny = false
    while (!this.#disposed) {
      let page: ReturnType<AssistantDeliveryService['listOwnerForegroundTaskSources']>
      try {
        page = delivery.listOwnerForegroundTaskSources({
          ...ownerScopeInput,
          ...(after === undefined ? {} : { after }),
          limit: 50,
        })
      } catch {
        return syncedAny
      }

      if (page.items.length === 0) break

      const eligibleRefs = page.items
        .filter(
          (src) =>
            !this.#store.isSourceWithdrawn(
              scope.ownerScopeKey,
              'assistant-delivery',
              `foreground-turn:${src.inboxId}`,
            ),
        )
        .map((src) => ({
          inboxId: src.inboxId,
          expectedSourceDigest: src.sourceDigest,
        }))

      const upserts: UpsertNodeInput[] = []
      if (eligibleRefs.length > 0) {
        try {
          delivery.withOwnerForegroundTaskSourcesFence(
            {
              ...ownerScopeInput,
              sources: eligibleRefs,
            },
            (contents) => {
              for (const item of contents) {
                if (item === undefined) continue
                upserts.push(this.#mapDeliveryEpisodeToNode(item, scope))
              }
            },
          )
        } catch {
          // If owner route rotated or fence failed, skip this batch cleanly
          return syncedAny
        }
      }

      if (upserts.length > 0) {
        syncedAny = true
      }
      after = page.nextCursor
      this.#enqueueUpsertWithEdges(scope, upserts, {
        sourcePlugin: 'delivery-foreground',
        scopeKey: scope.ownerScopeKey,
        cursorJson: JSON.stringify(page.nextCursor),
      })

      if (!page.hasMore) break
    }
    return syncedAny
  }

  #syncEvaluationScope(scope: AssociationOwnerScope): boolean {
    if (
      scope.mode !== 'delivery' ||
      scope.principalRecordId === null ||
      scope.principalVersion === null
    ) {
      return false
    }
    const evaluation = this.#ctx.get('assistantEvaluation' as never, false) as
      | AssistantEvaluationService
      | undefined
    if (
      evaluation === undefined ||
      typeof evaluation.createHostScope !== 'function' ||
      typeof evaluation.listTrustedTaskLearningProjections !== 'function'
    ) {
      return false
    }

    const verifier = this.#ctx.get('assistantVerifier' as never, false) as
      | EvalPoolVerifierPeer
      | undefined
    const holdoutSeedKey = this.#callbacks.holdoutSeedKey ?? null
    const holdoutRateBps = this.#callbacks.holdoutRateBps

    const hostScope = evaluation.createHostScope({
      workspace: scope.workspace,
      preset: scope.agentPreset,
    })

    const cursorScopeKey = `${scope.ownerScopeKey}:eval`
    const cursorRow = this.#store.getIngestCursor('evaluation-canonical', cursorScopeKey)
    let after: { scopeKey: string; watermark: number } | undefined
    if (cursorRow !== null) {
      try {
        after = JSON.parse(cursorRow.cursorJson) as { scopeKey: string; watermark: number }
      } catch {
        after = undefined
      }
    }

    let syncedAny = false
    while (!this.#disposed) {
      let page: ReturnType<AssistantEvaluationService['listTrustedTaskLearningProjections']>
      try {
        page = evaluation.listTrustedTaskLearningProjections({
          scope: hostScope,
          ...(after === undefined ? {} : { after }),
          limit: 100,
        })
      } catch {
        return syncedAny
      }
      if (page.items.length === 0) break

      const upserts: UpsertNodeInput[] = []
      for (const entry of page.items) {
        const receipt = entry.receipt
        const outcomeId =
          receipt.objective?.outcomeId ??
          receipt.projection.evidenceOutcomeId ??
          receipt.triggerOutcomeId
        const revision =
          outcomeId !== undefined && typeof evaluation.inspectTrustedTaskOwnerRevision === 'function'
            ? evaluation.inspectTrustedTaskOwnerRevision({
                scope: hostScope,
                outcomeId,
                principalRecordId: scope.principalRecordId,
                principalVersion: scope.principalVersion,
              })
            : undefined

        const { subjectKind, subjectRef, disposition } = receipt.projection
        const evalTaskId = `${subjectKind}:${subjectRef}`

        // Case 1: Explicit owner withdrawal (action === 'withdraw') -> correction -β then hard cascade delete + tombstone
        if (revision?.action === 'withdraw') {
          this.#triggerEvaluationCorrection(scope, receipt, revision)
          withdrawEvalPoolTask(this.#store.database, scope.ownerScopeKey, evalTaskId, {
            updatedAt: this.#now(),
          })
          if (subjectKind === 'foreground-turn') {
            this.#withdrawImmediate({
              ownerScopeKey: scope.ownerScopeKey,
              sourcePlugin: 'assistant-delivery',
              sourceRef: `foreground-turn:${subjectRef}`,
              recordWithdrawalTombstone: true,
            })
          }
          this.#withdrawImmediate({
            ownerScopeKey: scope.ownerScopeKey,
            sourcePlugin: 'assistant-evaluation',
            sourceRef: evalTaskId,
            recordWithdrawalTombstone: true,
          })
          syncedAny = true
          continue
        }

        // Case 2: Conflict retraction (disposition === 'retract' without 'withdraw')
        if (disposition === 'retract') {
          this.#triggerEvaluationCorrection(scope, receipt, revision)
          retractEvalPoolTask(this.#store.database, scope.ownerScopeKey, evalTaskId, {
            updatedAt: this.#now(),
            projectionVersion: receipt.projection.version,
            projectionDigest: receipt.projection.digest,
          })
          const objStatus = receipt.objective?.status ?? 'retracted'
          if (subjectKind === 'foreground-turn') {
            const fgNode = this.#store.findNodeBySourceRef(
              scope.ownerScopeKey,
              'assistant-delivery',
              `foreground-turn:${subjectRef}`,
            )
            if (fgNode !== null) {
              const res = this.#store.suppressNodeConflict({
                ownerScopeKey: scope.ownerScopeKey,
                sourcePlugin: 'assistant-delivery',
                sourceRef: `foreground-turn:${subjectRef}`,
                objectiveStatus: objStatus,
                nowMs: this.#now(),
              })
              this.#callbacks.onConflictSuppressed({
                nodeIds: [...res.deletedNodeIds, ...res.suppressedNodeIds],
              })
            }
          } else {
            const evalNode = this.#store.findNodeBySourceRef(
              scope.ownerScopeKey,
              'assistant-evaluation',
              evalTaskId,
            )
            if (evalNode !== null) {
              const res = this.#store.suppressNodeConflict({
                ownerScopeKey: scope.ownerScopeKey,
                sourcePlugin: 'assistant-evaluation',
                sourceRef: evalTaskId,
                objectiveStatus: objStatus,
                nowMs: this.#now(),
              })
              this.#callbacks.onConflictSuppressed({
                nodeIds: [...res.deletedNodeIds, ...res.suppressedNodeIds],
              })
            }
          }
          syncedAny = true
          continue
        }

        // Case 3: Upsert non-foreground or verified episode
        if (disposition === 'upsert') {
          const verified = this.#verifyEvaluationProjectionOwner(receipt, scope)
          if (!verified) continue
          this.#triggerEvaluationCorrection(scope, receipt, revision)
          const existingFg =
            subjectKind === 'foreground-turn'
              ? this.#store.findNodeBySourceRef(
                  scope.ownerScopeKey,
                  'assistant-delivery',
                  `foreground-turn:${subjectRef}`,
                )
              : null

          const mappedEvalNode =
            existingFg !== null ||
            this.#store.isSourceWithdrawn(
              scope.ownerScopeKey,
              'assistant-evaluation',
              evalTaskId,
            )
              ? null
              : this.#mapEvaluationReceiptToNode(receipt, scope)

          const poolEntities = existingFg?.entities ?? mappedEvalNode?.entities ?? []
          const poolToolNames =
            existingFg?.metadata.toolNames ?? mappedEvalNode?.metadata?.toolNames ?? []
          if (holdoutSeedKey !== null) {
            upsertEvalPoolFromReceipt(this.#store.database, {
              ownerScopeKey: scope.ownerScopeKey,
              receipt,
              holdoutSeedKey,
              ...(holdoutRateBps === undefined ? {} : { holdoutRateBps }),
              taskId: evalTaskId,
              ...(poolEntities.length > 0 ? { entities: poolEntities } : {}),
              ...(poolToolNames.length > 0 ? { toolNames: poolToolNames } : {}),
              ...(verifier === undefined ? {} : { assistantVerifier: verifier }),
              nowMs: this.#now(),
            })
          }

          if (existingFg !== null) {
            if (typeof outcomeId === 'string' && outcomeId.length > 0) {
              this.#store.attachNodeOutcomeId(existingFg.id, outcomeId)
            }
            syncedAny = true
            continue
          }
          if (mappedEvalNode !== null) {
            upserts.push(mappedEvalNode)
            syncedAny = true
          }
        }
      }

      after = page.nextCursor
      this.#enqueueUpsertWithEdges(scope, upserts, {
        sourcePlugin: 'evaluation-canonical',
        scopeKey: cursorScopeKey,
        cursorJson: JSON.stringify(page.nextCursor),
      })

      if (!page.hasMore) break
    }
    return syncedAny
  }

  #resolveEvaluationSessionId(
    receipt: TrustedTaskLearningProjectionReceipt,
    scope: AssociationOwnerScope,
  ): string | null {
    const { subjectKind, subjectRef } = receipt.projection
    const evidenceLists = [receipt.objective?.evidence, receipt.execution?.evidence]
    for (const list of evidenceLists) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if ((item.kind === 'session' || item.kind === 'session-id') && item.ref.length > 0) {
          return item.ref
        }
      }
    }
    const existing = this.#store.findNodeBySourceRef(
      scope.ownerScopeKey,
      'assistant-evaluation',
      `${subjectKind}:${subjectRef}`,
    )
    const extraSession = existing?.metadata.extra?.sessionId
    if (typeof extraSession === 'string' && extraSession.length > 0) {
      return extraSession
    }
    return subjectRef.length > 0 ? subjectRef : null
  }

  #triggerEvaluationCorrection(
    scope: AssociationOwnerScope,
    receipt: TrustedTaskLearningProjectionReceipt,
    revision: ReturnType<AssistantEvaluationService['inspectTrustedTaskOwnerRevision']> | undefined,
  ): void {
    const hebbianCfg = this.#callbacks.hebbianConfig
    if (hebbianCfg?.enabled === false) return
    if (!classifyEvaluationCorrection(receipt, revision)) return
    const { subjectKind, subjectRef } = receipt.projection
    const taskId = `${subjectKind}:${subjectRef}`
    const sessionId =
      subjectKind !== 'foreground-turn'
        ? this.#resolveEvaluationSessionId(receipt, scope)
        : null
    const nowMs = this.#now()
    const matchedExposures = this.#store.findExposuresByTaskOrSession(
      scope.ownerScopeKey,
      taskId,
      sessionId,
    )
    const uncorrectedNodeIds = matchedExposures
      .filter((e) => !e.corrected)
      .map((e) => e.nodeId)
    this.#writeQueue.enqueue({
      kind: 'apply-hebbian-correction',
      ownerScopeKey: scope.ownerScopeKey,
      taskId,
      ...(sessionId === null ? {} : { sessionId }),
      nowMs,
      ...(hebbianCfg === undefined ? {} : { hebbianConfig: hebbianCfg }),
    })
    if (uncorrectedNodeIds.length > 0) {
      const resolvedTaskId = matchedExposures[0]?.taskId ?? taskId
      this.#callbacks.onTaskCorrected?.({
        ownerScopeKey: scope.ownerScopeKey,
        taskId: resolvedTaskId,
        nodeIds: uncorrectedNodeIds,
        nowMs,
      })
    }
  }

  #verifyEvaluationProjectionOwner(
    receipt: TrustedTaskLearningProjectionReceipt,
    scope: AssociationOwnerScope,
  ): boolean {
    const { subjectKind, subjectRef } = receipt.projection
    const delivery = this.#ctx.get('assistantDelivery' as never, false) as
      | AssistantDeliveryService
      | undefined

    if (subjectKind === 'foreground-turn') {
      const route = this.#routeAuthorities.get(scope.ownerScopeKey)
      if (
        route === undefined ||
        scope.principalRecordId === null ||
        scope.principalVersion === null ||
        delivery === undefined ||
        typeof delivery.inspectOwnerForegroundTaskSource !== 'function'
      ) {
        return false
      }
      try {
        const inspected = delivery.inspectOwnerForegroundTaskSource({
          authorityId: route.authorityId,
          principalId: scope.principalId,
          workspace: scope.workspace,
          agentPreset: scope.agentPreset,
          expectedOwner: {
            authorityHash: route.authorityHash,
            principalRecordId: scope.principalRecordId,
            principalVersion: scope.principalVersion,
          },
          inboxId: subjectRef,
        })
        return inspected !== undefined
      } catch {
        return false
      }
    }

    if (subjectKind === 'work-item') {
      const outcomeId = receipt.objective?.outcomeId ?? receipt.triggerOutcomeId
      if (
        scope.authorityId === undefined ||
        delivery === undefined ||
        typeof delivery.inspectOwnerWorkItemLearningTask !== 'function'
      ) {
        return false
      }
      try {
        const task = delivery.inspectOwnerWorkItemLearningTask({
          authorityId: scope.authorityId,
          principalId: scope.principalId,
          workspace: scope.workspace,
          agentPreset: scope.agentPreset,
          outcomeId,
        })
        return task !== undefined
      } catch {
        return false
      }
    }

    if (subjectKind === 'automation-run') {
      const automations = this.#ctx.get('assistantAutomations' as never, false) as
        | AssistantAutomationsService
        | undefined
      if (automations === undefined || typeof automations.inspectOwnerAutomations !== 'function') {
        return false
      }
      try {
        const list = automations.inspectOwnerAutomations({
          principalId: scope.principalId,
          workspace: scope.workspace,
          preset: scope.agentPreset,
          limit: 200,
        })
        // Require at least one owner automation (and match automationId if embedded in situation/ref)
        return list.some(
          (a) => subjectRef.includes(a.id) || receipt.situation.includes(a.id),
        )
      } catch {
        return false
      }
    }

    if (subjectKind === 'goal-outcome' || subjectKind === 'goal-step') {
      if (scope.principalRecordId === null || scope.principalVersion === null) return false
      const goals = this.#ctx.get('assistantGoals' as never, false) as
        | AssistantGoalsService
        | undefined
      if (goals === undefined || typeof goals.inspectOwnerGoals !== 'function') return false
      try {
        const list = goals.inspectOwnerGoals(
          {
            principalId: scope.principalId,
            principalRecordId: scope.principalRecordId,
            principalVersion: scope.principalVersion,
            workspace: scope.workspace,
            preset: scope.agentPreset,
          },
          50,
        )
        return list.some((g) => subjectRef.includes(g.id) || receipt.situation.includes(g.id))
      } catch {
        return false
      }
    }

    return false
  }

  #mapEvaluationReceiptToNode(
    receipt: TrustedTaskLearningProjectionReceipt,
    scope: AssociationOwnerScope,
  ): UpsertNodeInput {
    const { subjectKind, subjectRef, version, digest } = receipt.projection
    const execStatus = receipt.execution?.status ?? 'unknown'
    const objStatus = receipt.objective?.status ?? 'unknown'
    const title = compactTitle(`[${subjectKind}] ${receipt.situation}`)
    const body = `${receipt.situation}\nexecution: ${execStatus}\nobjective: ${objStatus}`.slice(
      0,
      MAX_BODY_CHARS,
    )
    const combinedText = `${title}\n${receipt.situation}`
    const occurredAt =
      receipt.objective?.occurredAt ?? receipt.execution?.occurredAt ?? this.#now()

    const outcomeId =
      receipt.objective?.outcomeId ??
      receipt.projection.evidenceOutcomeId ??
      receipt.triggerOutcomeId

    return {
      id: `a:e-${subjectKind}-${subjectRef}`,
      kind: 'episode',
      sourcePlugin: 'assistant-evaluation',
      sourceRef: `${subjectKind}:${subjectRef}`,
      sourceVersion: normalizeSourceVersion(`v${version}:${digest.slice(0, 12)}`),
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: scope.mode,
      principalDigest: scope.principalDigest,
      principalRecordId: scope.mode === 'delivery' ? scope.principalRecordId : null,
      principalVersion: scope.mode === 'delivery' ? scope.principalVersion : null,
      scopeMode: 'workspace',
      workspace: scope.workspace,
      agentPreset: scope.agentPreset,
      trust: 'trusted',
      sensitivity: 'private',
      title,
      body,
      entities: extractEntities(combinedText),
      tokens: tokenizeAssociationText(combinedText),
      metadata: {
        objectiveStatus: objStatus,
        extra: {
          subjectKind,
          subjectRef,
          ...(typeof outcomeId === 'string' && outcomeId.length > 0 ? { outcomeId } : {}),
        },
      },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
  }
}
