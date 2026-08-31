import type { AutomationArtifactStore } from './artifacts.js'
import type { DeliveryPresentationUpdate } from '@dsh-enhanced/assistant-delivery'
import { HostAutomationExecutorRegistry } from './host-executors.js'
import { AutomationStoreError, type AutomationStore } from './store.js'
import { isHostAutomationDefinition, legacyAutomationExecutionDiagnostic } from './types.js'
import type {
  AutomationOccurrence,
  AutomationExecutionDiagnostic,
  AutomationIncident,
  AutomationEvaluationOutcome,
  AutomationEvaluationOutboxEntry,
  AutomationRecord,
  AutomationRun,
  AutomationRunStatus,
  AutomationTask,
  HostExecutionRequirement,
  HostExecutorAvailabilityDecision,
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
  /** Omitted only by legacy/custom runners; the coordinator persists unknown. */
  diagnostic?: AutomationExecutionDiagnostic
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
    metadata?: Readonly<Record<string, string>>
  }): { id: string; status: string }
  enqueueAutomationResult?(input: {
    automationId: string
    runId: string
    workspace: string
    bindingId: string
    outputPreview: string
  }): { id: string; status: string }
  enqueueBackgroundRoute?(input: {
    sourceId: string
    authorityId: string
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'plain'
  }): { id: string; status: string }
  /** Trusted Host-only desired-message projection; never exposed as an Agent tool. */
  publishDeliveryPresentation?(input: DeliveryPresentationUpdate): { status: string }
}

/**
 * Optional one-way sink for finished production-run telemetry. The sink owns
 * any learning eligibility decision; this scheduler never treats operational
 * execution success or failure as a quality label.
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

/** Optional append-only Evaluation ledger. It has its own durable outbox lane. */
export interface AutomationEvaluationRecorder {
  append(input: AutomationEvaluationOutcome): unknown | Promise<unknown>
}

export class AutomationRunnerAmbiguousError extends Error {
  readonly diagnostic: AutomationExecutionDiagnostic

  constructor(message: string, options?: ErrorOptions & { diagnostic?: AutomationExecutionDiagnostic }) {
    super(message, options)
    this.name = 'AutomationRunnerAmbiguousError'
    this.diagnostic = options?.diagnostic ?? legacyAutomationExecutionDiagnostic
  }
}

export class AutomationRunnerFailureError extends Error {
  constructor(
    message: string,
    readonly diagnostic: AutomationExecutionDiagnostic,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AutomationRunnerFailureError'
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
  hostExecutors?: HostAutomationExecutorRegistry
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

function incidentAlertText(incident: AutomationIncident): string {
  return [
    `Automation incident ${incident.id}`,
    `automation: ${incident.automationId}`,
    `state: ${incident.state}`,
    `stage: ${incident.stage}`,
    `failure: ${incident.failureClass}/${incident.failurePhase}/${incident.failureCode}`,
    `side effects: ${incident.sideEffectState}`,
    `retryability: ${incident.retryability}`,
  ].join('\n')
}

const exposureReceiptTimeoutMs = 2_000
const evaluationMaxAttempts = 8
const evaluationRetryBaseMs = 1_000
const evaluationRetryMaxMs = 3_600_000
const evaluationRecorderTimeoutMs = 2_000

function recorderErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Za-z0-9._:-]{1,64}$/u.test(code)) return code
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)) return error.name
  return 'recorder-error'
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
  private readonly hostExecutors: HostAutomationExecutorRegistry
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private readonly activeEvaluations = new Map<string, Promise<void>>()
  private delivery: AutomationDeliveryDispatcher | undefined
  private outcomeRecorder: AutomationOutcomeRecorder | undefined
  private evaluationRecorder: AutomationEvaluationRecorder | undefined
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
    this.hostExecutors = options.hostExecutors ?? new HostAutomationExecutorRegistry()
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
    this.store.recoverExpiredCircuitProbes({ now })
    this.store.recoverExpiredTasks({ now, limit: this.maxCatchUp })
    this.dispatchPendingEvaluations()
    this.dispatchPendingEvidence()
    this.dispatchPendingDeliveries()
    this.dispatchPendingIncidentAlerts()
    const materializeAvailability = this.hostAvailability(
      this.store.listDueHostExecutionRequirements({ now }), 'materialize',
    )
    this.store.materializeDue({
      now,
      misfireGraceMs: this.misfireGraceMs,
      maxCatchUp: this.maxCatchUp,
      hostAvailability: materializeAvailability,
    })
    while (this.active.size < this.maxConcurrency) {
      const claimAvailability = this.hostAvailability(
        this.store.listClaimableHostExecutionRequirements(), 'claim',
      )
      const claimed = this.store.claimNextTask({
        ownerId: this.ownerId,
        fencingToken: this.fencingToken!,
        now,
        leaseMs: this.taskLeaseMs,
        hostAvailability: claimAvailability,
      })
      if (claimed === undefined) break
      if (claimed.status !== 'claimed') continue
      this.abortRequestedActive()
      this.launch(claimed)
    }
    this.dispatchPendingIncidentAlerts()
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

  /** Attach the optional unified Evaluation sink without coupling it to Evolution. */
  setEvaluationRecorder(recorder: AutomationEvaluationRecorder | undefined): void {
    this.evaluationRecorder = recorder
    if (recorder !== undefined && !this.stopped) this.dispatchPendingEvaluations()
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0 || this.activeEvaluations.size > 0) {
      await Promise.allSettled([
        ...[...this.active.values()].map(value => value.promise),
        ...this.activeEvaluations.values(),
      ])
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
    if (this.fencingToken !== undefined) {
      try {
        this.store.releaseDuty({ ownerId: this.ownerId, fencingToken: this.fencingToken, now: this.now() })
      } catch (error) {
        // A successor that already advanced the fence owns the row.  The
        // stopped coordinator must not interfere with it.
        if (!(error instanceof AutomationStoreError) || error.code !== 'stale-fence') throw error
      } finally {
        this.fencingToken = undefined
      }
    }
  }

  private hostAvailability(
    requirements: readonly HostExecutionRequirement[],
    stage: HostExecutorAvailabilityDecision['stage'],
  ): HostExecutorAvailabilityDecision[] {
    return requirements.map(requirement => {
      const proof = this.hostExecutors.prove(requirement.execution)
      return Object.freeze({
        automationId: requirement.automationId,
        definitionHash: requirement.definitionHash,
        stage,
        available: proof.available,
        reasonCode: proof.available ? 'host-executor-available' : proof.reasonCode,
      })
    })
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
    if (this.fencingToken === undefined) throw new Error('assistant-automations: duty fence is missing')
    const fence = this.fencingToken
    const freshSessionId = sessionId(claimed)
    let timeout: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let timedOut = false
    try {
      const started = this.store.startTask({
        taskId: claimed.id,
        ownerId: this.ownerId,
        fencingToken: fence,
        now: this.now(),
        leaseMs: this.taskLeaseMs,
        sessionId: freshSessionId,
      })
      let automation: AutomationRecord | undefined
      let occurrence: ReturnType<AutomationStore['getOccurrence']>
      try {
        automation = this.store.getTaskExecutionSnapshot(claimed.id)
        occurrence = this.store.getOccurrence(claimed.occurrenceId)
      } catch {
        this.store.quarantineInvalidExecutionSnapshot({
          taskId: started.id,
          ownerId: this.ownerId,
          fencingToken: fence,
          now: this.now(),
        })
        return
      }
      if (automation === undefined || occurrence === undefined) {
        this.store.quarantineInvalidExecutionSnapshot({
          taskId: started.id,
          ownerId: this.ownerId,
          fencingToken: fence,
          now: this.now(),
        })
        return
      }
      const hostExecution = isHostAutomationDefinition(automation.definition)
      timeout = setTimeout(() => {
        timedOut = true
        controller.abort('timeout')
      }, automation.definition.timeoutMs)
      timeout.unref?.()
      heartbeat = setInterval(() => {
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
        const admission = this.store.acquireCircuitExecutionForTask({
          taskId: started.id,
          now: this.now(),
          leaseMs: Math.min(86_400_000, Math.max(this.taskLeaseMs, automation.definition.timeoutMs)),
        })
        if (admission.kind === 'blocked') {
          result = {
            outcome: 'failed',
            output: `execution circuit is ${admission.circuit.state} for immutable definition ${admission.circuit.definitionHash}`,
            usage: {},
            diagnostic: Object.freeze({
              schemaVersion: 1,
              failureClass: admission.circuit.failureClass,
              failurePhase: 'preflight',
              failureCode: 'circuit-open',
              promptSubmissionState: hostExecution ? 'not-applicable' : 'not-submitted',
              sideEffectState: 'none',
              retryability: 'after-intervention',
              budgetSettlementState: automation.definition.budgetId === undefined ? 'not-required' : 'not-reserved',
            }),
          }
        } else {
          const runnerPromise = Promise.resolve().then(() => this.runner.run({
            automation,
            occurrence,
            task: started,
            sessionId: freshSessionId,
            signal: controller.signal,
          }))
          // The runner owns Agent flush/disposal. It may violate cancellation,
          // so its late settlement is deliberately detached from terminal I/O.
          const settledRunner = runnerPromise.then(
            value => ({ kind: 'result' as const, value }),
            error => ({ kind: 'error' as const, error }),
          )
          let removeAbort = () => {}
          const aborted = new Promise<{ kind: 'aborted' }>(resolve => {
            const finish = () => resolve({ kind: 'aborted' })
            if (controller.signal.aborted) finish()
            else {
              controller.signal.addEventListener('abort', finish, { once: true })
              removeAbort = () => controller.signal.removeEventListener('abort', finish)
            }
          })
          const settled = await Promise.race([settledRunner, aborted])
          removeAbort()
          void settledRunner.then(() => {})
          if (settled.kind === 'aborted' || controller.signal.aborted) {
            const isTimeout = timedOut
            result = {
              outcome: isTimeout ? 'timed_out' : 'cancelled',
              output: isTimeout ? 'automation execution timed out' : 'automation execution was cancelled',
              usage: {},
              diagnostic: Object.freeze({
                schemaVersion: 1,
                failureClass: isTimeout ? 'timeout' : 'cancelled',
                failurePhase: 'unknown',
                failureCode: isTimeout ? 'execution-timeout' : 'execution-cancelled',
                promptSubmissionState: hostExecution ? 'not-applicable' : 'unknown',
                sideEffectState: 'unknown',
                retryability: 'unsafe',
                budgetSettlementState: automation.definition.budgetId === undefined ? 'not-required' : 'unknown',
              }),
            }
          } else if (settled.kind === 'error') {
            const error = settled.error
            const diagnostic = error instanceof AutomationRunnerFailureError
              || error instanceof AutomationRunnerAmbiguousError
              ? error.diagnostic
              : legacyAutomationExecutionDiagnostic
            result = {
              outcome: error instanceof AutomationRunnerAmbiguousError ? 'unknown' : 'failed',
              output: error instanceof Error ? error.message : String(error),
              usage: {},
              diagnostic,
            }
          } else {
            result = settled.value
          }
        }
      } catch {
        result = {
          outcome: 'unknown',
          output: 'automation circuit admission could not be proven',
          usage: {},
          diagnostic: Object.freeze({
            schemaVersion: 1,
            failureClass: 'infrastructure',
            failurePhase: 'preflight',
            failureCode: 'circuit-admission-failed',
            promptSubmissionState: hostExecution ? 'not-applicable' : 'not-submitted',
            sideEffectState: 'none',
            retryability: 'after-intervention',
            budgetSettlementState: automation.definition.budgetId === undefined ? 'not-required' : 'not-reserved',
          }),
        }
      }
      if (timeout !== undefined) clearTimeout(timeout)

      const evidenceSessionId = occurrence.dryRun === false && result.sessionId === freshSessionId
        ? freshSessionId
        : undefined
      const exposure = evidenceSessionId === undefined
        ? undefined
        : await this.getExposure(automation, evidenceSessionId)
      let outcome: AutomationRunStatus = result.outcome
      let diagnostic: AutomationExecutionDiagnostic = result.diagnostic ?? legacyAutomationExecutionDiagnostic
      const outputPreview = preview(result.output)
      let artifactRef: string | undefined
      try {
        artifactRef = this.artifacts.write(occurrence.id, {
          occurrenceId: occurrence.id,
          automationId: automation.id,
          taskId: started.id,
          outcome,
          sessionId: result.sessionId ?? freshSessionId,
          output: result.output,
          usage: result.usage,
          diagnostic,
        })
      } catch {
        // The execution may already have crossed prompt/tool boundaries. Commit
        // a content-free unknown recovery receipt instead of waiting for lease
        // expiry or pretending the missing artifact did not matter.
        outcome = 'unknown'
        diagnostic = Object.freeze({
          schemaVersion: 1,
          failureClass: 'infrastructure',
          failurePhase: 'artifact-write',
          failureCode: 'artifact-write-failed',
          promptSubmissionState: diagnostic.promptSubmissionState,
          sideEffectState: diagnostic.sideEffectState,
          retryability: diagnostic.promptSubmissionState === 'not-submitted'
            && diagnostic.sideEffectState === 'none'
            && (diagnostic.budgetSettlementState === 'not-required'
              || diagnostic.budgetSettlementState === 'not-reserved'
              || diagnostic.budgetSettlementState === 'released')
            ? 'safe'
            : 'unsafe',
          budgetSettlementState: diagnostic.budgetSettlementState,
        })
      }
      const run = this.store.completeTask({
        taskId: started.id,
        ownerId: this.ownerId,
        fencingToken: fence,
        now: this.now(),
        outcome,
        sessionId: result.sessionId ?? freshSessionId,
        ...(artifactRef === undefined ? {} : { artifactRef }),
        outputPreview: artifactRef === undefined ? 'artifact persistence failed' : outputPreview,
        usage: artifactRef === undefined ? {} : result.usage,
        diagnostic,
        ...(artifactRef === undefined || evidenceSessionId === undefined
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
      this.dispatchRunEvaluation(run.id)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      if (heartbeat !== undefined) clearInterval(heartbeat)
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
    for (const run of this.store.listPendingEvidence(100)) {
      try {
        this.dispatchRunEvidence(run)
      } catch {
        // One corrupt/concurrently-settled row must not starve its peers.
      }
    }
  }

  private dispatchRunEvidence(run: AutomationRun): void {
    const recorder = this.outcomeRecorder
    if (recorder === undefined || run.evidenceStatus !== 'pending' || run.evidence === undefined) return
    let proven: ReturnType<AutomationStore['getProvenProductionRun']>
    try {
      proven = this.store.getProvenProductionRun(run.id)
    } catch {
      this.store.suppressRunEvidence({ runId: run.id, expectedStatus: 'pending', now: this.now() })
      return
    }
    if (proven === undefined
      || (proven.run.status !== 'succeeded' && proven.run.status !== 'failed' && proven.run.status !== 'timed_out')
      || proven.run.evidenceStatus !== 'pending' || proven.run.evidence === undefined) {
      this.store.suppressRunEvidence({ runId: run.id, expectedStatus: 'pending', now: this.now() })
      return
    }
    try {
      recorder.recordAutomationOutcome(proven.run.evidence)
      this.store.completeRunEvidence({ runId: proven.run.id, expectedStatus: 'pending', now: this.now() })
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

  private dispatchPendingEvaluations(): void {
    if (this.evaluationRecorder === undefined) return
    const now = this.now()
    for (const entry of this.store.listPendingEvaluations(100, now)) this.dispatchEvaluation(entry)
  }

  private dispatchRunEvaluation(runId: string): void {
    if (this.evaluationRecorder === undefined) return
    const entry = this.store.getPendingEvaluationForRun(runId, this.now())
    if (entry !== undefined) this.dispatchEvaluation(entry)
  }

  private dispatchEvaluation(entry: AutomationEvaluationOutboxEntry): void {
    const recorder = this.evaluationRecorder
    if (recorder === undefined || entry.status !== 'pending' || this.activeEvaluations.has(entry.id)) return
    const authoritativeMode = this.store.getRunExecutionMode(entry.runId)
    const payloadMode = (entry.payload as Partial<AutomationEvaluationOutcome>).executionMode
    if (authoritativeMode !== 'production' || (payloadMode !== undefined && payloadMode !== 'production')) {
      // Repair old preview rows without ever presenting them to a trusted sink.
      // `recorded` here means the durable outbox item was conclusively handled;
      // no Evaluation outcome is invented.
      this.store.completeEvaluation({ id: entry.id, expectedStatus: 'pending', now: this.now() })
      return
    }
    const normalizedEntry = payloadMode === 'production'
      ? entry
      : Object.freeze({ ...entry, payload: Object.freeze({ ...entry.payload, executionMode: 'production' as const }) })
    const promise = this.recordEvaluation(recorder, normalizedEntry)
      .finally(() => this.activeEvaluations.delete(entry.id))
    this.activeEvaluations.set(entry.id, promise)
    void promise.catch(() => {})
  }

  private async recordEvaluation(
    recorder: AutomationEvaluationRecorder,
    entry: AutomationEvaluationOutboxEntry,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve(recorder.append(entry.payload)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(Object.assign(new Error('evaluation recorder timed out'), {
            code: 'recorder-timeout',
          })), evaluationRecorderTimeoutMs)
          timeout.unref?.()
        }),
      ])
      this.store.completeEvaluation({ id: entry.id, expectedStatus: 'pending', now: this.now() })
    } catch (error) {
      // The payload is immutable and has its own idempotency key. A crash after
      // append but before settlement therefore replays safely without rerunning
      // the Automation or coupling this lane to Evolution evidence.
      try {
        const now = this.now()
        const delay = Math.min(
          evaluationRetryMaxMs,
          evaluationRetryBaseMs * 2 ** Math.min(entry.attemptCount, 12),
        )
        this.store.deferEvaluation({
          id: entry.id,
          expectedStatus: 'pending',
          now,
          retryAt: now + delay,
          maxAttempts: evaluationMaxAttempts,
          errorCode: recorderErrorCode(error),
        })
      } catch {
        // A concurrent settlement or shutdown already owns the next step.
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private dispatchPendingDeliveries(): void {
    for (const run of this.store.listPendingDeliveries(100)) {
      try {
        this.dispatchRunDelivery(run)
      } catch {
        // Per-row isolation: the next pending delivery remains dispatchable.
      }
    }
  }

  private dispatchPendingIncidentAlerts(): void {
    const delivery = this.delivery
    if (delivery === undefined) return
    for (const incident of this.store.listPendingIncidentAlerts(100)) {
      try {
        const target = this.store.getIncidentNotificationTarget(incident.id)
        if (target === undefined) continue
        const lifecycleKey = `automation-incident:${incident.id}:g${incident.lifecycleGeneration}`
        let outbox: { id: string; status: string }
        if (target.kind === 'owner-route') {
          const enqueue = delivery.enqueueBackgroundRoute
          const publish = delivery.publishDeliveryPresentation
          if (enqueue === undefined || publish === undefined) continue
          outbox = incident.alertRef === undefined
            ? enqueue.call(delivery, {
                sourceId: 'assistant-automations-incidents',
                authorityId: target.authorityId,
                idempotencyKey: lifecycleKey,
                // Immutable bootstrap text. The typed presentation below owns all
                // mutable details and eventually replaces this exact message.
                text: `Automation incident ${incident.id}`,
                format: 'plain',
              })
            : { id: incident.alertRef, status: 'enqueued' }
          publish.call(delivery, {
            presentationKey: lifecycleKey,
            originalOutboxIdempotencyKey: lifecycleKey,
            revision: incident.presentationRevision,
            presentation: {
              kind: 'automation-incident',
              incidentId: incident.id,
              automationId: incident.automationId,
              definitionHash: incident.definitionHash,
              stage: incident.stage,
              state: incident.state,
              failureClass: incident.failureClass,
              failurePhase: incident.failurePhase,
              failureCode: incident.failureCode,
              sideEffectState: incident.sideEffectState,
              retryability: incident.retryability,
              lifecycleGeneration: incident.lifecycleGeneration,
              incidentRevision: incident.presentationRevision,
              openedAt: incident.openedAt,
              updatedAt: incident.updatedAt,
              ...(incident.resolvedAt === undefined ? {} : { resolvedAt: incident.resolvedAt }),
            },
          })
        } else {
          // Agent approval bindings are Conversation bindings, not Host owner-
          // route authorities. Emit one idempotent content-free update per
          // durable revision; Delivery intentionally reserves mutable incident
          // presentations for stable Host owner routes.
          outbox = delivery.enqueueBackground({
            sourceId: 'assistant-automations-incidents',
            workspace: target.workspace,
            bindingId: target.bindingId,
            idempotencyKey: `${lifecycleKey}:r${incident.presentationRevision}`,
            text: incidentAlertText(incident),
            format: 'plain',
          })
        }
        this.store.completeIncidentAlert({
          incidentId: incident.id,
          expectedStatus: 'pending',
          expectedLifecycleGeneration: incident.lifecycleGeneration,
          expectedPresentationRevision: incident.presentationRevision,
          expectedVersion: incident.version,
          alertRef: outbox.id,
          now: this.now(),
        })
      } catch {
        // Emergency stop / Policy refusal keeps the durable incident and its
        // pending alert. A later authorized tick uses the same idempotency key.
      }
    }
  }

  private dispatchRunDelivery(run: AutomationRun): void {
    if (run.deliveryStatus !== 'pending') return
    let proof: ReturnType<AutomationStore['getProvenProductionRun']>
    try {
      proof = this.store.getProvenProductionRun(run.id)
    } catch {
      this.store.suppressRunDelivery({ runId: run.id, expectedStatus: 'pending', now: this.now() })
      return
    }
    const automation = proof?.automation
    const evidence = proof?.run.evidence
    const bindingId = automation?.definition.deliveryBindingId
    if (proof === undefined || proof.run.status !== 'succeeded'
      || evidence === undefined || automation === undefined || bindingId === undefined) {
      // Unknown/legacy mode, missing immutable snapshot, hash mismatch, and a
      // missing binding all reduce monotonically to a terminal no-send state.
      this.store.suppressRunDelivery({ runId: run.id, expectedStatus: 'pending', now: this.now() })
      return
    }
    run = proof.run
    const normalizedOutput = run.outputPreview.normalize('NFC').trim()
    if (normalizedOutput === '' || automation.definition.deliverySuppressExact?.includes(normalizedOutput) === true) {
      this.store.suppressRunDelivery({ runId: run.id, expectedStatus: 'pending', now: this.now() })
      return
    }
    if (this.delivery?.enqueueAutomationResult === undefined) return
    try {
      const outbox = this.delivery.enqueueAutomationResult({
        automationId: automation.id,
        runId: run.id,
        workspace: automation.definition.workspace,
        bindingId,
        outputPreview: run.outputPreview,
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
