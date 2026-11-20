import type { Context } from '@deepseek-ai/cordis'
import type {
  AutomationDefinitionChangeEvent,
  AutomationRecord,
  AssistantAutomationsService,
} from '@dsh-enhanced/assistant-automations'
import type {
  AssistantDeliveryService,
  OwnerForegroundTaskSourceContent,
  OwnerForegroundTaskSourceCursor,
  OwnerRouteScopeSummary,
} from '@dsh-enhanced/assistant-delivery'
import type {
  AssistantEvaluationService,
  TrustedTaskLearningProjectionReceipt,
} from '@dsh-enhanced/assistant-evaluation'
import type {
  AssistantGoalsService,
  GoalRecord,
  GoalRecordChangeEvent,
} from '@dsh-enhanced/assistant-goals'
import type {
  AssistantWorkItemsService,
  WorkItemChangeEvent,
  WorkItemSummaryForHost,
} from '@dsh-enhanced/assistant-work-items'
import type {
  MemoryAgentContext,
  MemoryRecord,
  MemoryRecordChangeEvent,
  PersonalMemoryService,
} from '@dsh-enhanced/personal-memory'
import { buildSharedEntityEdges, extractEntities } from './entities.js'
import type { AssociationStore } from './sqlite.js'
import { tokenizeAssociationText } from './tokenize.js'
import {
  computeOwnerScopeKey,
  computePrincipalDigest,
  normalizeSourceVersion,
  type AssociationOwnerScope,
  type DerivedRefInput,
  type UpsertEdgeInput,
  type UpsertNodeInput,
} from './types.js'
import type { AssociationWriteQueue } from './write-queue.js'

const MAX_ENTITY_PEERS_PER_UPSERT = 64
const MAX_SHARED_EDGES_PER_NODE = 16
const MAX_TITLE_CHARS = 160
const MAX_BODY_CHARS = 8_192

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
  readonly consumeSessionToolNames?: (sessionId: string) => readonly string[]
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
      this.#syncDeliveryEpisodesScope(scope)
      await this.#writeQueue.flush()
      this.#syncEvaluationScope(scope)
      await this.#writeQueue.flush()
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
  ): void {
    if (nodes.length === 0 && cursor === undefined) return
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
    }

    this.#writeQueue.enqueue({
      kind: 'upsert-nodes',
      nodes,
      edges,
      derivedRefs,
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

  #syncDeliveryEpisodesScope(scope: AssociationOwnerScope): void {
    if (
      scope.mode !== 'delivery' ||
      scope.principalRecordId === null ||
      scope.principalVersion === null ||
      scope.authorityId === undefined
    ) {
      return
    }
    const route = this.#routeAuthorities.get(scope.ownerScopeKey)
    if (route === undefined) return
    const delivery = this.#ctx.get('assistantDelivery' as never, false) as
      | AssistantDeliveryService
      | undefined
    if (
      delivery === undefined ||
      typeof delivery.listOwnerForegroundTaskSources !== 'function' ||
      typeof delivery.withOwnerForegroundTaskSourcesFence !== 'function'
    ) {
      return
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

    while (!this.#disposed) {
      let page: ReturnType<AssistantDeliveryService['listOwnerForegroundTaskSources']>
      try {
        page = delivery.listOwnerForegroundTaskSources({
          ...ownerScopeInput,
          ...(after === undefined ? {} : { after }),
          limit: 50,
        })
      } catch {
        return
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
          return
        }
      }

      after = page.nextCursor
      this.#enqueueUpsertWithEdges(scope, upserts, {
        sourcePlugin: 'delivery-foreground',
        scopeKey: scope.ownerScopeKey,
        cursorJson: JSON.stringify(page.nextCursor),
      })

      if (!page.hasMore) break
    }
  }

  #syncEvaluationScope(scope: AssociationOwnerScope): void {
    if (
      scope.mode !== 'delivery' ||
      scope.principalRecordId === null ||
      scope.principalVersion === null
    ) {
      return
    }
    const evaluation = this.#ctx.get('assistantEvaluation' as never, false) as
      | AssistantEvaluationService
      | undefined
    if (
      evaluation === undefined ||
      typeof evaluation.createHostScope !== 'function' ||
      typeof evaluation.listTrustedTaskLearningProjections !== 'function'
    ) {
      return
    }

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

    while (!this.#disposed) {
      let page: ReturnType<AssistantEvaluationService['listTrustedTaskLearningProjections']>
      try {
        page = evaluation.listTrustedTaskLearningProjections({
          scope: hostScope,
          ...(after === undefined ? {} : { after }),
          limit: 100,
        })
      } catch {
        return
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

        // Case 1: Explicit owner withdrawal (action === 'withdraw') -> hard cascade delete + tombstone
        if (revision?.action === 'withdraw') {
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
            sourceRef: `${subjectKind}:${subjectRef}`,
            recordWithdrawalTombstone: true,
          })
          continue
        }

        // Case 2: Conflict retraction (disposition === 'retract' without 'withdraw')
        if (disposition === 'retract') {
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
              `${subjectKind}:${subjectRef}`,
            )
            if (evalNode !== null) {
              const res = this.#store.suppressNodeConflict({
                ownerScopeKey: scope.ownerScopeKey,
                sourcePlugin: 'assistant-evaluation',
                sourceRef: `${subjectKind}:${subjectRef}`,
                objectiveStatus: objStatus,
                nowMs: this.#now(),
              })
              this.#callbacks.onConflictSuppressed({
                nodeIds: [...res.deletedNodeIds, ...res.suppressedNodeIds],
              })
            }
          }
          continue
        }

        // Case 3: Upsert non-foreground or verified episode
        if (disposition === 'upsert') {
          const verified = this.#verifyEvaluationProjectionOwner(receipt, scope)
          if (!verified) continue
          if (subjectKind === 'foreground-turn') {
            // Foreground turns are ingested via Delivery foreground ledger; skip duplicate creation if present
            const existingFg = this.#store.findNodeBySourceRef(
              scope.ownerScopeKey,
              'assistant-delivery',
              `foreground-turn:${subjectRef}`,
            )
            if (existingFg !== null) {
              if (typeof outcomeId === 'string' && outcomeId.length > 0) {
                this.#store.attachNodeOutcomeId(existingFg.id, outcomeId)
              }
              continue
            }
          }
          const sourceRef = `${subjectKind}:${subjectRef}`
          if (this.#store.isSourceWithdrawn(scope.ownerScopeKey, 'assistant-evaluation', sourceRef)) {
            continue
          }
          upserts.push(this.#mapEvaluationReceiptToNode(receipt, scope))
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
