import { createHash } from 'node:crypto'
import { RECOVERY_CATALOG, RECOVERY_CATALOG_DIGEST } from './catalog.js'
import { RecoveryStore, RecoveryStoreError } from './store.js'
import type {
  RecoveryRunInput,
  RecoveryStepAction,
  RecoveryStepId,
  StoredRecoveryRun,
  StoredRecoveryStep,
} from './types.js'

export type RecoveryPortSideEffectState = 'none' | 'possible'

export class RecoveryPortError extends Error {
  constructor(
    readonly code: string,
    readonly sideEffectState: RecoveryPortSideEffectState,
    message = code,
  ) {
    super(message)
    this.name = 'RecoveryPortError'
  }
}

export interface RecoveryStepPlan {
  action: RecoveryStepAction
  beforeDigest: string
}

export interface RecoveryActionReceipt {
  status: 'noop' | 'succeeded'
  resultCode: string
  afterDigest: string
}

export interface RecoveryExecutionContext extends RecoveryRunInput {
  runId: string
}

/**
 * Host-only adapter. Planning is read-only; every mutation receives the exact
 * durable idempotency key before it may cross into another service.
 */
export interface RecoveryRunbookPort {
  plan(
    context: RecoveryExecutionContext,
    stepId: RecoveryStepId,
    signal: AbortSignal,
  ): Promise<RecoveryStepPlan>
  execute(
    context: RecoveryExecutionContext,
    stepId: RecoveryStepId,
    action: RecoveryStepAction,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<RecoveryActionReceipt>
}

export interface RecoveryExecutorInput extends Omit<RecoveryRunInput, 'catalogDigest'> {
  catalogDigest?: string
  signal: AbortSignal
}

export interface RecoveryExecutorResult {
  status: 'failed' | 'succeeded' | 'unknown'
  resultCode: string
  run: StoredRecoveryRun
  steps: readonly StoredRecoveryStep[]
}

const DIGEST = /^[a-f\d]{64}$/u
const CODE = /^[a-z\d][a-z\d.-]{0,63}$/u
const UNKNOWN_STATE_DIGEST = createHash('sha256').update('assistant-recovery:unknown-state:v1').digest('hex')

function stableCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.normalize('NFC').trim().toLowerCase()
  return CODE.test(normalized) ? normalized : fallback
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof RecoveryPortError ? stableCode(error.code, fallback) : fallback
}

function stateDigest(
  value: unknown,
  field: string,
  sideEffectState: RecoveryPortSideEffectState,
): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new RecoveryPortError(`${field}-invalid`, sideEffectState)
  }
  return value
}

function receiptCode(value: unknown, sideEffectState: RecoveryPortSideEffectState): string {
  const normalized = stableCode(value, '')
  if (normalized === '') throw new RecoveryPortError('result-code-invalid', sideEffectState)
  return normalized
}

function isMutation(action: RecoveryStepAction): boolean {
  return !['noop', 'verify-authority', 'verify-health'].includes(action.kind)
}

function isRequiredVerification(stepId: RecoveryStepId): boolean {
  return stepId === 'authority-admission' || stepId === 'verification'
}

function terminalStatus(step: StoredRecoveryStep): 'failed' | 'unknown' | undefined {
  if (step.status === 'failed') return 'failed'
  if (step.status === 'unknown') return 'unknown'
  return undefined
}

interface BoundedError extends Error {
  recoveryTimeout?: true
  recoveryDeadline?: true
  recoveryCancelled?: true
}

async function bounded<T>(input: {
  parentSignal: AbortSignal
  timeoutMs: number
  operation: (signal: AbortSignal) => Promise<T>
  /** A started mutation must be allowed to return its durable sink receipt. */
  settleAfterCancellation?: boolean
  /** The immutable run/step deadline, rather than config, selected this bound. */
  deadlineLimited?: boolean
}): Promise<T> {
  if (input.parentSignal.aborted) throw new RecoveryPortError('execution-cancelled', 'none')
  const controller = new AbortController()
  const abort = () => controller.abort(input.parentSignal.reason)
  input.parentSignal.addEventListener('abort', abort, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new Error('assistant-recovery step timed out'))
      const error = new Error('assistant-recovery step timed out') as BoundedError
      error.recoveryTimeout = true
      if (input.deadlineLimited) error.recoveryDeadline = true
      reject(error)
    }, input.timeoutMs)
  })
  let cancelWaiter: (() => void) | undefined
  const cancelledPromise = new Promise<never>((_resolve, reject) => {
    if (input.settleAfterCancellation) return
    if (input.parentSignal.aborted) {
      reject(new RecoveryPortError('execution-cancelled', 'none'))
      return
    }
    cancelWaiter = () => {
      const error = new Error('assistant-recovery execution cancelled') as BoundedError
      error.recoveryCancelled = true
      reject(error)
    }
    input.parentSignal.addEventListener('abort', cancelWaiter, { once: true })
  })
  // Promise.race attaches a rejection observer to the operation. A late result
  // after timeout is deliberately ignored and cannot mutate the durable run.
  const operation = Promise.resolve().then(() => input.operation(controller.signal))
  try {
    return await Promise.race(input.settleAfterCancellation
      ? [operation, timeoutPromise]
      : [operation, timeoutPromise, cancelledPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    input.parentSignal.removeEventListener('abort', abort)
    if (cancelWaiter !== undefined) input.parentSignal.removeEventListener('abort', cancelWaiter)
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error as BoundedError).recoveryTimeout === true
}

function isDeadlineTimeout(error: unknown): boolean {
  return isTimeout(error) && (error as BoundedError).recoveryDeadline === true
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && (error as BoundedError).recoveryCancelled === true
}

export class RecoveryExecutor {
  constructor(
    private readonly store: RecoveryStore,
    private readonly port: RecoveryRunbookPort,
    private readonly maxStepDurationMs: number,
  ) {
    if (!Number.isSafeInteger(maxStepDurationMs) || maxStepDurationMs < 100 || maxStepDurationMs > 60_000) {
      throw new Error('assistant-recovery: maxStepDurationMs must be an integer from 100 to 60000')
    }
  }

  async execute(input: RecoveryExecutorInput): Promise<RecoveryExecutorResult> {
    const begun = this.store.beginRun({
      occurrenceId: input.occurrenceId,
      automationId: input.automationId,
      definitionHash: input.definitionHash,
      executionMode: input.executionMode,
      targetScope: input.targetScope,
      principal: input.principal,
      ownerRouteId: input.ownerRouteId,
      activationNonce: input.activationNonce,
      activationPlanDigest: input.activationPlanDigest,
      catalogDigest: input.catalogDigest ?? RECOVERY_CATALOG_DIGEST,
    })
    let run = begun.run
    if (run.status !== 'running') return this.result(run)
    const context: RecoveryExecutionContext = Object.freeze({
      occurrenceId: run.occurrenceId,
      automationId: run.automationId,
      definitionHash: run.definitionHash,
      executionMode: run.executionMode,
      targetScope: run.targetScope,
      principal: run.principal,
      ownerRouteId: run.ownerRouteId,
      activationNonce: run.activationNonce,
      activationPlanDigest: run.activationPlanDigest,
      catalogDigest: run.catalogDigest,
      runId: run.id,
    })

    for (const catalogStep of RECOVERY_CATALOG) {
      let step = this.store.getStep(run.id, catalogStep.id)
      const resumedIntent = step?.status === 'started'
      if (step !== undefined && step.status !== 'started') {
        const failed = terminalStatus(step)
        if (failed !== undefined) {
          run = this.store.completeRun({
            runId: run.id,
            expectedVersion: run.version,
            status: failed,
            resultCode: stableCode(step.resultCode, `step-${failed}`),
          })
          return this.result(run)
        }
        continue
      }

      if (step === undefined) {
        const planBudget = this.operationBudget(run.deadlineAt)
        if (planBudget.remainingMs <= 0) {
          return this.settleExpiredRun(run)
        }
        let plan: RecoveryStepPlan
        try {
          plan = await bounded({
            parentSignal: input.signal,
            timeoutMs: planBudget.timeoutMs,
            deadlineLimited: planBudget.deadlineLimited,
            operation: signal => this.port.plan(context, catalogStep.id, signal),
          })
          plan = { ...plan, beforeDigest: stateDigest(plan.beforeDigest, 'before-digest', 'none') }
        } catch (error) {
          if (isDeadlineTimeout(error)
            || this.store.deadlineRemainingMs(run.deadlineAt) <= 0) {
            return this.settleExpiredRun(run)
          }
          const code = isTimeout(error)
            ? 'planning-timeout'
            : isCancelled(error)
              ? 'planning-cancelled'
              : errorCode(error, 'planning-failed')
          try {
            step = this.store.beginStep({
              runId: run.id,
              stepId: catalogStep.id,
              action: { kind: 'noop', reasonCode: code },
              beforeDigest: UNKNOWN_STATE_DIGEST,
            }).step
          } catch (storeError) {
            if (storeError instanceof RecoveryStoreError && storeError.code === 'deadline-expired') {
              return this.settleExpiredRun(run)
            }
            throw storeError
          }
          this.store.completeStep({
            runId: run.id,
            stepId: catalogStep.id,
            expectedVersion: step.version,
            status: 'failed',
            beforeDigest: step.beforeDigest,
            afterDigest: UNKNOWN_STATE_DIGEST,
            resultCode: code,
          })
          run = this.store.completeRun({
            runId: run.id,
            expectedVersion: run.version,
            status: 'failed',
            resultCode: code,
          })
          return this.result(run)
        }
        if (this.store.deadlineRemainingMs(run.deadlineAt) <= 0) {
          return this.settleExpiredRun(run)
        }
        try {
          step = this.store.beginStep({
            runId: run.id,
            stepId: catalogStep.id,
            action: plan.action,
            beforeDigest: plan.beforeDigest,
          }).step
        } catch (error) {
          if (error instanceof RecoveryStoreError && error.code === 'deadline-expired') {
            return this.settleExpiredRun(run)
          }
          throw error
        }
      }

      const actionBudget = this.operationBudget(run.deadlineAt, step.deadlineAt)
      if (actionBudget.remainingMs <= 0) {
        return this.settleExpiredStep(run, step)
      }

      if (step.action.kind === 'noop') {
        const required = isRequiredVerification(catalogStep.id)
        this.store.completeStep({
          runId: run.id,
          stepId: catalogStep.id,
          expectedVersion: step.version,
          status: required ? 'failed' : 'noop',
          beforeDigest: step.beforeDigest,
          afterDigest: step.beforeDigest,
          resultCode: required ? 'required-verification-missing' : step.action.reasonCode,
        })
        if (required) {
          run = this.store.completeRun({
            runId: run.id,
            expectedVersion: run.version,
            status: 'failed',
            resultCode: 'required-verification-missing',
          })
          return this.result(run)
        }
        continue
      }

      if (context.executionMode === 'preview' && isMutation(step.action)) {
        this.store.completeStep({
          runId: run.id,
          stepId: catalogStep.id,
          expectedVersion: step.version,
          status: 'noop',
          beforeDigest: step.beforeDigest,
          afterDigest: step.beforeDigest,
          resultCode: 'preview-suppressed',
        })
        continue
      }

      let receipt: RecoveryActionReceipt
      try {
        receipt = await bounded({
          parentSignal: input.signal,
          timeoutMs: actionBudget.timeoutMs,
          deadlineLimited: actionBudget.deadlineLimited,
          settleAfterCancellation: isMutation(step.action),
          operation: signal => this.port.execute(
            context,
            catalogStep.id,
            step!.action,
            step!.idempotencyKey,
            signal,
          ),
        })
        receipt = {
          ...receipt,
          resultCode: receiptCode(receipt.resultCode, isMutation(step.action) ? 'possible' : 'none'),
          afterDigest: stateDigest(
            receipt.afterDigest,
            'after-digest',
            isMutation(step.action) ? 'possible' : 'none',
          ),
        }
      } catch (error) {
        const mutating = isMutation(step.action)
        const knownNoEffect = error instanceof RecoveryPortError && error.sideEffectState === 'none'
        // A durable started mutation may be resuming after the prior process
        // crossed the external boundary and crashed before recording its
        // receipt. Even a newly proven pre-effect refusal cannot prove that the
        // earlier call had no effect; only a successful idempotent replay can
        // settle it as known.
        const deadlineExpired = isDeadlineTimeout(error)
        const ambiguous = mutating && (deadlineExpired || resumedIntent || !knownNoEffect)
        const status = ambiguous ? 'unknown' : 'failed'
        const code = deadlineExpired
          ? (ambiguous ? 'action-deadline-expired-ambiguous' : 'action-deadline-expired')
          : isTimeout(error)
          ? (ambiguous ? 'action-timeout-ambiguous' : 'action-timeout')
          : isCancelled(error)
            ? (ambiguous ? 'action-cancelled-ambiguous' : 'action-cancelled')
          : errorCode(error, ambiguous ? 'action-ambiguous' : 'action-failed')
        this.store.completeStep({
          runId: run.id,
          stepId: catalogStep.id,
          expectedVersion: step.version,
          status,
          beforeDigest: step.beforeDigest,
          afterDigest: UNKNOWN_STATE_DIGEST,
          resultCode: code,
        })
        run = this.store.completeRun({
          runId: run.id,
          expectedVersion: run.version,
          status,
          resultCode: code,
        })
        return this.result(run)
      }
      // Durable settlement is intentionally outside the port exception block.
      // If the SQLite commit itself fails after an external action, do not
      // misclassify that storage error and overwrite a possibly committed
      // receipt with a contradictory action failure. A restart will observe
      // either the started intent or the exact terminal receipt and resume.
      const requiredNoop = isRequiredVerification(catalogStep.id) && receipt.status !== 'succeeded'
      this.store.completeStep({
        runId: run.id,
        stepId: catalogStep.id,
        expectedVersion: step.version,
        status: requiredNoop ? 'failed' : receipt.status,
        beforeDigest: step.beforeDigest,
        afterDigest: receipt.afterDigest,
        resultCode: requiredNoop ? 'required-verification-noop' : receipt.resultCode,
      })
      if (requiredNoop) {
        run = this.store.completeRun({
          runId: run.id,
          expectedVersion: run.version,
          status: 'failed',
          resultCode: 'required-verification-noop',
        })
        return this.result(run)
      }
    }

    run = this.store.completeRun({
      runId: run.id,
      expectedVersion: run.version,
      status: 'succeeded',
      resultCode: context.executionMode === 'preview' ? 'preview-verified' : 'runbook-complete',
    })
    return this.result(run)
  }

  private result(run: StoredRecoveryRun): RecoveryExecutorResult {
    if (run.status === 'running') throw new Error('assistant-recovery: cannot expose a non-terminal executor result')
    return Object.freeze({
      status: run.status,
      resultCode: run.resultCode!,
      run,
      steps: Object.freeze(this.store.listSteps(run.id)),
    })
  }

  private operationBudget(...deadlines: readonly number[]): {
    remainingMs: number
    timeoutMs: number
    deadlineLimited: boolean
  } {
    const deadlineAt = Math.min(...deadlines)
    const remainingMs = this.store.deadlineRemainingMs(deadlineAt)
    return Object.freeze({
      remainingMs,
      timeoutMs: Math.max(1, Math.min(this.maxStepDurationMs, remainingMs)),
      deadlineLimited: remainingMs <= this.maxStepDurationMs,
    })
  }

  private settleExpiredStep(
    run: StoredRecoveryRun,
    step: StoredRecoveryStep,
  ): RecoveryExecutorResult {
    const ambiguous = isMutation(step.action)
    const status = ambiguous ? 'unknown' : 'failed'
    const code = ambiguous
      ? 'action-deadline-expired-ambiguous'
      : 'action-deadline-expired'
    this.store.completeStep({
      runId: run.id,
      stepId: step.stepId,
      expectedVersion: step.version,
      status,
      beforeDigest: step.beforeDigest,
      afterDigest: UNKNOWN_STATE_DIGEST,
      resultCode: code,
    })
    const completed = this.store.completeRun({
      runId: run.id,
      expectedVersion: run.version,
      status,
      resultCode: code,
    })
    return this.result(completed)
  }

  private settleExpiredRun(run: StoredRecoveryRun): RecoveryExecutorResult {
    const code = 'run-deadline-expired'
    const completed = this.store.completeRun({
      runId: run.id,
      expectedVersion: run.version,
      status: 'failed',
      resultCode: code,
    })
    return this.result(completed)
  }
}
