import type { AssociationStore, WithdrawalCascadeResult } from './sqlite.js'
import type {
  ExposureRow,
  HoldoutAssignmentRow,
  StepMetricRow,
  StoredAssociationEdge,
  StoredAssociationNode,
  StoredAssociationSynonym,
  WriteTask,
} from './types.js'

function yieldImmediate(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

export interface GraphMutationSummary {
  readonly withdrawals: readonly WithdrawalCascadeResult[]
  readonly hasUpserts: boolean
  readonly hasEdgeWeightUpdates: boolean
  readonly hasStructuralGraphChanges: boolean
}

export interface AssociationWriteQueueOptions {
  readonly maxItemsPerTx?: number
  readonly flushIntervalMs?: number
  readonly coalesceBatchLimit?: number
  readonly onGraphMutated?: (info: GraphMutationSummary) => void
  readonly onError?: (error: unknown) => void
}

export class AssociationWriteQueue {
  readonly #store: AssociationStore
  readonly #maxItemsPerTx: number
  readonly #flushIntervalMs: number
  readonly #coalesceBatchLimit: number
  readonly #onGraphMutated?: (info: GraphMutationSummary) => void
  readonly #onError?: (error: unknown) => void

  readonly #queue: WriteTask[] = []
  readonly #pendingMetricRows: StepMetricRow[] = []
  readonly #pendingExposures: ExposureRow[] = []
  readonly #pendingHoldouts: HoldoutAssignmentRow[] = []

  // Immediate synchronous withdrawal tombstones checked by hot path & assoc_read
  // before the async SQLite transaction & index rebuild completes.
  readonly #tombstonedNodeIds = new Set<string>()
  readonly #tombstonedSourceRefs = new Set<string>()

  #running: Promise<void> | null = null
  #coalesceTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false
  #withdrawalEpoch = 0
  #pendingWithdrawalCount = 0

  constructor(store: AssociationStore, options?: AssociationWriteQueueOptions) {
    this.#store = store
    this.#maxItemsPerTx = Math.max(1, options?.maxItemsPerTx ?? 200)
    this.#flushIntervalMs = Math.max(10, options?.flushIntervalMs ?? 250)
    this.#coalesceBatchLimit = Math.max(1, options?.coalesceBatchLimit ?? 32)
    if (options?.onGraphMutated !== undefined) {
      this.#onGraphMutated = options.onGraphMutated
    }
    if (options?.onError !== undefined) {
      this.#onError = options.onError
    }
  }

  get withdrawalEpoch(): number {
    return this.#withdrawalEpoch
  }

  get hasPendingWithdrawals(): boolean {
    return this.#pendingWithdrawalCount > 0
  }

  markTombstoneSync(input: {
    readonly nodeIds?: readonly string[]
    readonly ownerScopeKey?: string
    readonly sourcePlugin?: string
    readonly sourceRef?: string
  }): void {
    this.#withdrawalEpoch += 1
    if (input.nodeIds) {
      for (const id of input.nodeIds) {
        this.#tombstonedNodeIds.add(id)
      }
    }
    if (
      input.ownerScopeKey !== undefined &&
      input.sourcePlugin !== undefined &&
      input.sourceRef !== undefined
    ) {
      this.#tombstonedSourceRefs.add(
        `${input.ownerScopeKey}\0${input.sourcePlugin}\0${input.sourceRef}`,
      )
    }
  }

  clearTombstonesForRebuiltGraph(
    activeNodeIds: ReadonlySet<string>,
    snapshotWithdrawalEpoch?: number,
  ): void {
    if (this.#pendingWithdrawalCount > 0) return
    if (
      snapshotWithdrawalEpoch !== undefined &&
      snapshotWithdrawalEpoch !== this.#withdrawalEpoch
    ) {
      return
    }
    for (const id of this.#tombstonedNodeIds) {
      if (!activeNodeIds.has(id)) {
        this.#tombstonedNodeIds.delete(id)
      }
    }
    this.#tombstonedSourceRefs.clear()
  }

  isNodeTombstoned(nodeId: string): boolean {
    return this.#tombstonedNodeIds.has(nodeId)
  }

  isSourceTombstoned(ownerScopeKey: string, sourcePlugin: string, sourceRef: string): boolean {
    return this.#tombstonedSourceRefs.has(`${ownerScopeKey}\0${sourcePlugin}\0${sourceRef}`)
  }

  enqueue(task: WriteTask): void {
    if (this.#disposed) return
    if (task.kind === 'record-holdout') {
      this.#pendingHoldouts.push(task.row)
      this.#scheduleCoalescedFlush()
      return
    }
    if (task.kind === 'record-metrics') {
      this.#pendingMetricRows.push(...task.metrics)
      this.#pendingExposures.push(...task.exposures)
      this.#scheduleCoalescedFlush()
      return
    }
    // Drain coalesced exposure/metric/holdout buffers first so causal ordering
    // holds between step exposures and subsequent Hebbian/telemetry/graph tasks.
    this.#drainCoalescedBuffers()
    if (task.kind === 'withdraw-source') {
      this.markTombstoneSync({
        ownerScopeKey: task.ownerScopeKey,
        sourcePlugin: task.sourcePlugin,
        sourceRef: task.sourceRef,
      })
      this.#pendingWithdrawalCount += 1
      // Preserve strict FIFO causal ordering with queued upsert-nodes tasks
      this.#queue.push(task)
      this.#ensureRunning()
      return
    }
    this.#queue.push(task)
    this.#ensureRunning()
  }

  async flush(): Promise<void> {
    this.#drainCoalescedBuffers()
    if (this.#running !== null) {
      await this.#running
    }
    while (this.#queue.length > 0 || this.#hasCoalescedPending()) {
      this.#drainCoalescedBuffers()
      this.#ensureRunning()
      if (this.#running !== null) {
        await this.#running
      }
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#coalesceTimer !== null) {
      clearTimeout(this.#coalesceTimer)
      this.#coalesceTimer = null
    }
    await this.flush()
  }

  #hasCoalescedPending(): boolean {
    return (
      this.#pendingHoldouts.length > 0 ||
      this.#pendingMetricRows.length > 0 ||
      this.#pendingExposures.length > 0
    )
  }

  #scheduleCoalescedFlush(): void {
    const totalPending =
      this.#pendingHoldouts.length +
      this.#pendingMetricRows.length +
      this.#pendingExposures.length
    if (totalPending >= this.#coalesceBatchLimit) {
      this.#drainCoalescedBuffers()
      this.#ensureRunning()
      return
    }
    if (this.#coalesceTimer === null && !this.#disposed) {
      this.#coalesceTimer = setTimeout(() => {
        this.#coalesceTimer = null
        this.#drainCoalescedBuffers()
        this.#ensureRunning()
      }, this.#flushIntervalMs)
      this.#coalesceTimer.unref?.()
    }
  }

  #drainCoalescedBuffers(): void {
    if (this.#coalesceTimer !== null) {
      clearTimeout(this.#coalesceTimer)
      this.#coalesceTimer = null
    }
    if (this.#pendingHoldouts.length > 0) {
      const holdouts = this.#pendingHoldouts.splice(0, this.#pendingHoldouts.length)
      for (const row of holdouts) {
        this.#queue.push({ kind: 'record-holdout', row })
      }
    }
    if (this.#pendingMetricRows.length > 0 || this.#pendingExposures.length > 0) {
      const metrics = this.#pendingMetricRows.splice(0, this.#pendingMetricRows.length)
      const exposures = this.#pendingExposures.splice(0, this.#pendingExposures.length)
      this.#queue.push({ kind: 'record-metrics', metrics, exposures })
    }
  }

  #ensureRunning(): void {
    if (this.#running !== null || this.#queue.length === 0) return
    this.#running = this.#drainLoop().finally(() => {
      this.#running = null
      if (this.#queue.length > 0 && !this.#disposed) {
        this.#ensureRunning()
      }
    })
  }

  async #drainLoop(): Promise<void> {
    while (this.#queue.length > 0) {
      const task = this.#queue.shift()!
      let hasUpserts = false
      let hasEdgeWeightUpdates = false
      let hasStructuralGraphChanges = false
      const withdrawals: WithdrawalCascadeResult[] = []

      try {
        if (task.kind === 'upsert-nodes') {
          hasUpserts = true
          hasStructuralGraphChanges = true
          await this.#executeChunkedUpsert(task, withdrawals)
        } else if (task.kind === 'withdraw-source') {
          hasStructuralGraphChanges = true
          try {
            const result = this.#store.withdrawSource({
              ownerScopeKey: task.ownerScopeKey,
              sourcePlugin: task.sourcePlugin,
              sourceRef: task.sourceRef,
              hardDelete: task.hardDelete,
              ...(task.maxSourceVersion !== undefined
                ? { maxSourceVersion: task.maxSourceVersion }
                : {}),
              ...(task.recordWithdrawalTombstone !== undefined
                ? { recordWithdrawalTombstone: task.recordWithdrawalTombstone }
                : {}),
            })
            for (const id of result.deletedNodeIds) this.#tombstonedNodeIds.add(id)
            for (const id of result.suppressedNodeIds) this.#tombstonedNodeIds.add(id)
            withdrawals.push(result)
          } finally {
            this.#pendingWithdrawalCount = Math.max(0, this.#pendingWithdrawalCount - 1)
            this.#withdrawalEpoch += 1
          }
        } else if (task.kind === 'record-holdout') {
          this.#store.runInTransaction(() => {
            this.#store.recordHoldoutAssignment(task.row)
          })
        } else if (task.kind === 'record-metrics') {
          for (let i = 0; i < task.metrics.length || i < task.exposures.length; i += this.#maxItemsPerTx) {
            const mSlice = task.metrics.slice(i, i + this.#maxItemsPerTx)
            const eSlice = task.exposures.slice(i, i + this.#maxItemsPerTx)
            this.#store.recordMetricsAndExposures(mSlice, eSlice)
            if (i + this.#maxItemsPerTx < Math.max(task.metrics.length, task.exposures.length)) {
              await yieldImmediate()
            }
          }
        } else if (task.kind === 'record-read-event') {
          this.#store.recordReadEvent(task.event)
        } else if (task.kind === 'upsert-task-telemetry') {
          this.#store.upsertTaskTelemetry(task.telemetry)
        } else if (task.kind === 'upsert-replay-episode') {
          this.#store.upsertReplayEpisode(task.episode)
        } else if (task.kind === 'apply-hebbian-use') {
          const res = this.#store.applyHebbianUse(task)
          if (res.updatedEdges > 0 || res.createdEdges > 0) {
            hasEdgeWeightUpdates = true
          }
        } else if (task.kind === 'apply-hebbian-correction') {
          const res = this.#store.applyHebbianCorrection(task)
          if (res.updatedEdges > 0) {
            hasEdgeWeightUpdates = true
          }
        } else if (task.kind === 'apply-hebbian-decay') {
          const chunkLimit = Math.min(200, Math.max(1, Math.trunc(task.limit ?? 200)))
          let decayedAny = false
          while (!this.#disposed) {
            const res = this.#store.applyHebbianDecayBatch({
              nowMs: task.nowMs,
              decayHalfLifeMs: task.decayHalfLifeMs,
              nonUseGraceMs: task.nonUseGraceMs,
              weightMin: task.weightMin,
              weightMax: task.weightMax,
              limit: chunkLimit,
            })
            if (res.decayedEdges > 0) {
              decayedAny = true
            }
            if (!res.hasMore || res.decayedEdges === 0) break
            await yieldImmediate()
          }
          if (decayedAny) {
            hasEdgeWeightUpdates = true
          }
        }
      } catch (error) {
        this.#onError?.(error)
      }

      if (hasUpserts || withdrawals.length > 0 || hasEdgeWeightUpdates) {
        this.#onGraphMutated?.({
          withdrawals,
          hasUpserts,
          hasEdgeWeightUpdates,
          hasStructuralGraphChanges,
        })
      }

      if (this.#queue.length > 0) {
        await yieldImmediate()
      }
    }
  }

  #hasQueuedWithdrawalFor(
    ownerScopeKey: string,
    sourcePlugin: string,
    sourceRef: string,
    nodeId: string,
  ): boolean {
    for (const queued of this.#queue) {
      if (queued.kind !== 'withdraw-source') continue
      if (
        queued.ownerScopeKey === ownerScopeKey &&
        queued.sourcePlugin === sourcePlugin &&
        queued.sourceRef === sourceRef
      ) {
        return true
      }
    }
    void nodeId
    return false
  }

  async #executeChunkedUpsert(
    task: Extract<WriteTask, { readonly kind: 'upsert-nodes' }>,
    withdrawals: WithdrawalCascadeResult[],
  ): Promise<void> {
    const chunkSize = this.#maxItemsPerTx
    for (let i = 0; i < task.nodes.length; i += chunkSize) {
      const nodeChunk = task.nodes.slice(i, i + chunkSize)
      const isLastNodeChunk = i + chunkSize >= task.nodes.length
      const res = this.#store.upsertBatch({
        nodes: nodeChunk,
        edges: isLastNodeChunk && task.edges.length <= chunkSize ? task.edges : [],
        synonyms: isLastNodeChunk && (task.synonyms?.length ?? 0) <= chunkSize ? (task.synonyms ?? []) : [],
        derivedRefs: isLastNodeChunk && task.derivedRefs.length <= chunkSize ? task.derivedRefs : [],
        ...(isLastNodeChunk && task.cursor !== undefined ? { cursor: task.cursor } : {}),
      })
      for (const node of nodeChunk) {
        if (
          !this.#hasQueuedWithdrawalFor(
            node.ownerScopeKey,
            node.sourcePlugin,
            node.sourceRef,
            node.id,
          ) &&
          !this.#store.isSourceWithdrawn(node.ownerScopeKey, node.sourcePlugin, node.sourceRef)
        ) {
          this.#tombstonedNodeIds.delete(node.id)
          this.#tombstonedSourceRefs.delete(
            `${node.ownerScopeKey}\0${node.sourcePlugin}\0${node.sourceRef}`,
          )
        }
      }
      if (res.deletedNodeIds.length > 0 || res.deletedEdgeIds.length > 0) {
        withdrawals.push(res)
      }
      if (!isLastNodeChunk) {
        await yieldImmediate()
      }
    }

    if (task.nodes.length === 0) {
      const res = this.#store.upsertBatch({
        nodes: [],
        edges: task.edges.length <= chunkSize ? task.edges : [],
        synonyms: (task.synonyms?.length ?? 0) <= chunkSize ? (task.synonyms ?? []) : [],
        derivedRefs: task.derivedRefs.length <= chunkSize ? task.derivedRefs : [],
        ...(task.cursor !== undefined ? { cursor: task.cursor } : {}),
      })
      if (res.deletedNodeIds.length > 0 || res.deletedEdgeIds.length > 0) {
        withdrawals.push(res)
      }
    }

    if (task.edges.length > chunkSize) {
      for (let i = 0; i < task.edges.length; i += chunkSize) {
        this.#store.upsertBatch({
          nodes: [],
          edges: task.edges.slice(i, i + chunkSize),
          derivedRefs: [],
        })
        if (i + chunkSize < task.edges.length) await yieldImmediate()
      }
    }

    if (task.synonyms && task.synonyms.length > chunkSize) {
      for (let i = 0; i < task.synonyms.length; i += chunkSize) {
        this.#store.upsertBatch({
          nodes: [],
          edges: [],
          synonyms: task.synonyms.slice(i, i + chunkSize),
          derivedRefs: [],
        })
        if (i + chunkSize < task.synonyms.length) await yieldImmediate()
      }
    }

    if (task.derivedRefs.length > chunkSize) {
      for (let i = 0; i < task.derivedRefs.length; i += chunkSize) {
        this.#store.upsertBatch({
          nodes: [],
          edges: [],
          derivedRefs: task.derivedRefs.slice(i, i + chunkSize),
        })
        if (i + chunkSize < task.derivedRefs.length) await yieldImmediate()
      }
    }
  }
}

export async function loadGraphSnapshotChunked(
  store: AssociationStore,
  options?: {
    readonly chunkSize?: number
    readonly isCancelled?: () => boolean
  },
): Promise<{
  readonly nodes: readonly StoredAssociationNode[]
  readonly edges: readonly StoredAssociationEdge[]
  readonly synonyms: readonly StoredAssociationSynonym[]
} | null> {
  const chunkSize = Math.max(100, options?.chunkSize ?? 2_000)
  const nodes: StoredAssociationNode[] = []
  const edges: StoredAssociationEdge[] = []
  const synonyms: StoredAssociationSynonym[] = []

  let offset = 0
  while (true) {
    if (options?.isCancelled?.()) return null
    const page = store.loadActiveNodesPage(chunkSize, offset)
    if (page.length === 0) break
    nodes.push(...page)
    if (page.length < chunkSize) break
    offset += chunkSize
    await yieldImmediate()
  }

  offset = 0
  while (true) {
    if (options?.isCancelled?.()) return null
    const page = store.loadActiveEdgesPage(chunkSize, offset)
    if (page.length === 0) break
    edges.push(...page)
    if (page.length < chunkSize) break
    offset += chunkSize
    await yieldImmediate()
  }

  offset = 0
  while (true) {
    if (options?.isCancelled?.()) return null
    const page = store.loadActiveSynonymsPage(chunkSize, offset)
    if (page.length === 0) break
    synonyms.push(...page)
    if (page.length < chunkSize) break
    offset += chunkSize
    await yieldImmediate()
  }

  return { nodes, edges, synonyms }
}
