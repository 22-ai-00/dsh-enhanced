import type { AutomationArtifactStore } from './artifacts.js'
import { AutomationStoreError, type AutomationStore } from './store.js'
import type {
  AutomationOccurrence,
  AutomationRecord,
  AutomationRun,
  AutomationRunStatus,
  AutomationTask,
} from './types.js'

export interface AutomationRunnerInput {
  automation: AutomationRecord
  occurrence: AutomationOccurrence
  task: AutomationTask
  sessionId: string
  signal: AbortSignal
}

export interface AutomationRunnerResult {
  outcome: AutomationRunStatus
  sessionId?: string
  output: string
  usage: Readonly<Record<string, unknown>>
}

export interface AutomationRunner {
  run(input: AutomationRunnerInput): Promise<AutomationRunnerResult>
}

export interface AutomationDeliveryDispatcher {
  enqueueBackground(input: {
    sourceId: string
    workspace: string
    bindingId: string
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'plain'
  }): { id: string; status: string }
}

export class AutomationRunnerAmbiguousError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AutomationRunnerAmbiguousError'
  }
}

export interface AutomationCoordinatorOptions {
  store: AutomationStore
  artifacts: AutomationArtifactStore
  runner: AutomationRunner
  ownerId: string
  now?: () => number
  dutyLeaseMs: number
  taskLeaseMs: number
  misfireGraceMs: number
  maxCatchUp: number
  maxConcurrency: number
  tickIntervalMs?: number
}

function sessionId(task: AutomationTask): string {
  return `automation-${task.occurrenceId}-${task.attemptCount + 1}`
}

function preview(value: string, maximumBytes = 8_192): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maximumBytes) return value
  return bytes.subarray(0, maximumBytes).toString('utf8').replace(/\uFFFD$/u, '')
}

export class AutomationCoordinator {
  private readonly store: AutomationStore
  private readonly artifacts: AutomationArtifactStore
  private readonly runner: AutomationRunner
  private readonly ownerId: string
  private readonly now: () => number
  private readonly dutyLeaseMs: number
  private readonly taskLeaseMs: number
  private readonly misfireGraceMs: number
  private readonly maxCatchUp: number
  private readonly maxConcurrency: number
  private readonly tickIntervalMs: number
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private delivery: AutomationDeliveryDispatcher | undefined
  private fencingToken: number | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false

  constructor(options: AutomationCoordinatorOptions) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency <= 0 || options.maxConcurrency > 100) {
      throw new Error('assistant-automations: maxConcurrency must be between 1 and 100')
    }
    this.store = options.store
    this.artifacts = options.artifacts
    this.runner = options.runner
    this.ownerId = options.ownerId
    this.now = options.now ?? Date.now
    this.dutyLeaseMs = options.dutyLeaseMs
    this.taskLeaseMs = options.taskLeaseMs
    this.misfireGraceMs = options.misfireGraceMs
    this.maxCatchUp = options.maxCatchUp
    this.maxConcurrency = options.maxConcurrency
    this.tickIntervalMs = options.tickIntervalMs ?? Math.max(1_000, Math.floor(options.dutyLeaseMs / 3))
  }

  start(): void {
    if (this.stopped) throw new Error('assistant-automations coordinator is stopped')
    if (this.timer !== undefined) return
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.tickIntervalMs)
    this.timer.unref?.()
    void this.tick().catch(() => {})
  }

  async tick(): Promise<void> {
    if (this.stopped) throw new Error('assistant-automations coordinator is stopped')
    const now = this.now()
    if (!this.ensureDuty(now)) return
    this.dispatchPendingDeliveries()
    this.store.recoverExpiredTasks({ now, limit: this.maxCatchUp })
    this.store.materializeDue({ now, misfireGraceMs: this.misfireGraceMs, maxCatchUp: this.maxCatchUp })
    while (this.active.size < this.maxConcurrency) {
      const claimed = this.store.claimNextTask({
        ownerId: this.ownerId,
        fencingToken: this.fencingToken!,
        now,
        leaseMs: this.taskLeaseMs,
      })
      if (claimed === undefined) break
      if (claimed.status !== 'claimed') continue
      this.abortRequestedActive()
      this.launch(claimed)
    }
  }

  setDeliveryDispatcher(delivery: AutomationDeliveryDispatcher | undefined): void {
    this.delivery = delivery
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map(value => value.promise))
    }
  }

  async cancel(taskId: string): Promise<void> {
    this.store.requestCancellation({ taskId, now: this.now() })
    this.active.get(taskId)?.controller.abort('cancel-requested')
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (const value of this.active.values()) value.controller.abort('coordinator-stop')
    await this.whenIdle()
  }

  private ensureDuty(now: number): boolean {
    if (this.fencingToken !== undefined) {
      try {
        const renewed = this.store.renewDuty({
          ownerId: this.ownerId,
          fencingToken: this.fencingToken,
          now,
          leaseMs: this.dutyLeaseMs,
        })
        return renewed.acquired
      } catch (error) {
        if (!(error instanceof AutomationStoreError) || error.code !== 'stale-fence') throw error
        this.fencingToken = undefined
      }
    }
    const acquired = this.store.acquireDuty({ ownerId: this.ownerId, now, leaseMs: this.dutyLeaseMs })
    if (acquired.acquired) this.fencingToken = acquired.fencingToken
    return acquired.acquired
  }

  private launch(claimed: AutomationTask): void {
    const controller = new AbortController()
    const promise = this.execute(claimed, controller).finally(() => this.active.delete(claimed.id))
    this.active.set(claimed.id, { controller, promise })
    void promise.catch(() => {})
  }

  private abortRequestedActive(): void {
    for (const [taskId, value] of this.active) {
      if (this.store.getTaskRecord(taskId)?.cancelRequested === true) value.controller.abort('cancel-previous')
    }
  }

  private async execute(claimed: AutomationTask, controller: AbortController): Promise<void> {
    const automation = this.store.get(claimed.automationId)
    const occurrence = this.store.getOccurrence(claimed.occurrenceId)
    if (automation === undefined || occurrence === undefined || this.fencingToken === undefined) {
      throw new Error('assistant-automations: claimed task snapshot is missing')
    }
    const fence = this.fencingToken
    const freshSessionId = sessionId(claimed)
    const started = this.store.startTask({
      taskId: claimed.id,
      ownerId: this.ownerId,
      fencingToken: fence,
      now: this.now(),
      leaseMs: this.taskLeaseMs,
      sessionId: freshSessionId,
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort('timeout')
    }, automation.definition.timeoutMs)
    timeout.unref?.()
    const heartbeat = setInterval(() => {
      try {
        const now = this.now()
        this.store.renewDuty({
          ownerId: this.ownerId,
          fencingToken: fence,
          now,
          leaseMs: this.dutyLeaseMs,
        })
        this.store.heartbeatTask({
          taskId: started.id,
          ownerId: this.ownerId,
          fencingToken: fence,
          now,
          leaseMs: this.taskLeaseMs,
        })
      } catch {
        controller.abort('lease-lost')
      }
    }, Math.max(250, Math.floor(Math.min(this.dutyLeaseMs, this.taskLeaseMs) / 3)))
    heartbeat.unref?.()
    let result: AutomationRunnerResult
    try {
      result = await this.runner.run({
        automation,
        occurrence,
        task: started,
        sessionId: freshSessionId,
        signal: controller.signal,
      })
    } catch (error) {
      result = {
        outcome: controller.signal.aborted
          ? 'cancelled'
          : error instanceof AutomationRunnerAmbiguousError ? 'unknown' : 'failed',
        output: error instanceof Error ? error.message : String(error),
        usage: {},
      }
    } finally {
      clearTimeout(timeout)
      clearInterval(heartbeat)
    }
    const outcome: AutomationRunStatus = timedOut
      ? 'timed_out'
      : controller.signal.aborted ? 'cancelled' : result.outcome
    const outputPreview = preview(result.output)
    const artifactRef = this.artifacts.write(occurrence.id, {
      occurrenceId: occurrence.id,
      automationId: automation.id,
      taskId: started.id,
      outcome,
      sessionId: result.sessionId ?? freshSessionId,
      output: result.output,
      usage: result.usage,
    })
    const run = this.store.completeTask({
      taskId: started.id,
      ownerId: this.ownerId,
      fencingToken: fence,
      now: this.now(),
      outcome,
      sessionId: result.sessionId ?? freshSessionId,
      artifactRef,
      outputPreview,
      usage: result.usage,
    })
    this.dispatchRunDelivery(run)
  }

  private dispatchPendingDeliveries(): void {
    for (const run of this.store.listPendingDeliveries(100)) this.dispatchRunDelivery(run)
  }

  private dispatchRunDelivery(run: AutomationRun): void {
    if (run.deliveryStatus !== 'pending') return
    const automation = this.store.get(run.automationId)
    const bindingId = automation?.definition.deliveryBindingId
    if (automation === undefined || bindingId === undefined) return
    const normalizedOutput = run.outputPreview.normalize('NFC').trim()
    if (normalizedOutput === '' || automation.definition.deliverySuppressExact?.includes(normalizedOutput) === true) {
      this.store.suppressRunDelivery({ runId: run.id, expectedStatus: 'pending', now: this.now() })
      return
    }
    if (this.delivery === undefined) return
    try {
      const outbox = this.delivery.enqueueBackground({
        sourceId: automation.id,
        workspace: automation.definition.workspace,
        bindingId,
        idempotencyKey: `automation:${run.occurrenceId}:${bindingId}`,
        text: run.outputPreview,
        format: 'markdown',
      })
      this.store.completeRunDelivery({
        runId: run.id,
        expectedStatus: 'pending',
        deliveryRef: outbox.id,
        now: this.now(),
      })
    } catch {
      // The successful execution remains authoritative. A later tick repeats the
      // same Delivery idempotency key and cannot create a second outbound intent.
    }
  }
}
