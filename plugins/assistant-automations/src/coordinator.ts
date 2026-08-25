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

/**
 * Optional one-way sink for finished-run outcomes, used to feed behavioural
 * learning. Structural interface rather than a service import, so the scheduler
 * stays independent of whether any learning plugin is installed.
 */
export interface AutomationOutcomeRecorder {
  recordAutomationOutcome(input: {
    situation: string
    outcome: 'succeeded' | 'failed'
    detail: string
    idempotencyKey: string
    occurredAt: number
    workspace?: string
    agentPreset?: string
    automationId?: string
    runId?: string
    sessionId?: string
    ruleId?: string
    guidanceVersion?: number
  }): void
  /** Query an authoritative receipt written only after guidance was injected. */
  captureAutomationExposure?(input: {
    workspace: string
    agentPreset: string
    automationId: string
    sessionId: string
  }): Promise<{ ruleId: string; guidanceVersion: number } | undefined>
    | { ruleId: string; guidanceVersion: number }
    | undefined
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

function boundedText(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maximumBytes) return undefined
  return normalized
}

const exposureReceiptTimeoutMs = 2_000

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
  private outcomeRecorder: AutomationOutcomeRecorder | undefined
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
    this.dispatchPendingEvidence()
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

  /**
   * Attach an optional sink for finished-run outcomes.
   *
   * Kept optional and one-way so the scheduler never depends on a learning
   * plugin: if no recorder is attached, or the recorder throws, runs proceed
   * unchanged. Evidence collection must never be able to break execution.
   */
  setOutcomeRecorder(recorder: AutomationOutcomeRecorder | undefined): void {
    this.outcomeRecorder = recorder
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
    }
    try {
      const evidenceSessionId = result.sessionId === freshSessionId ? freshSessionId : undefined
      const exposure = evidenceSessionId === undefined
        ? undefined
        : await this.getExposure(automation, evidenceSessionId)
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
        ...(evidenceSessionId === undefined
          ? {}
          : {
              evidenceAttribution: {
                sessionId: evidenceSessionId,
                ...(exposure === undefined ? {} : exposure),
              },
            }),
      })
      this.dispatchRunDelivery(run)
      this.dispatchRunEvidence(run)
    } finally {
      clearInterval(heartbeat)
    }
  }

  private async getExposure(
    automation: AutomationRecord,
    actualSessionId: string,
  ): Promise<{ ruleId: string; guidanceVersion: number } | undefined> {
    const recorder = this.outcomeRecorder
    if (recorder?.captureAutomationExposure === undefined) return undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const captured = await Promise.race([
        Promise.resolve(recorder.captureAutomationExposure({
          workspace: automation.definition.workspace,
          agentPreset: automation.definition.agentPreset,
          automationId: automation.id,
          sessionId: actualSessionId,
        })),
        new Promise<undefined>(resolve => {
          timeout = setTimeout(() => resolve(undefined), exposureReceiptTimeoutMs)
        }),
      ])
      if (captured === undefined) return undefined
      const ruleId = boundedText(captured.ruleId, 200)
      if (
        ruleId === undefined
        || !Number.isSafeInteger(captured.guidanceVersion)
        || captured.guidanceVersion < 1
        || captured.guidanceVersion > 1_000_000_000
      ) {
        return undefined
      }
      return { ruleId, guidanceVersion: captured.guidanceVersion }
    } catch {
      return undefined
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private dispatchPendingEvidence(): void {
    if (this.outcomeRecorder === undefined) return
    for (const run of this.store.listPendingEvidence(100)) this.dispatchRunEvidence(run)
  }

  private dispatchRunEvidence(run: AutomationRun): void {
    const recorder = this.outcomeRecorder
    if (recorder === undefined || run.evidenceStatus !== 'pending' || run.evidence === undefined) return
    try {
      recorder.recordAutomationOutcome(run.evidence)
      this.store.completeRunEvidence({ runId: run.id, expectedStatus: 'pending', now: this.now() })
    } catch {
      // Evidence is an outbox lane: the run remains terminal and a later leader
      // tick repeats the same recorder idempotency key. Move a poison row behind
      // its peers so a bounded batch cannot starve newer evidence indefinitely.
      try {
        this.store.deferRunEvidence({ runId: run.id, expectedStatus: 'pending', now: this.now() })
      } catch {
        // A concurrent settlement or store shutdown already owns the next step.
      }
    }
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
