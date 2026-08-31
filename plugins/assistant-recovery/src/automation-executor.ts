import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  AutomationFailureClass,
  AutomationRetryability,
  AutomationSideEffectState,
  HostAutomationExecutionSpec,
  HostAutomationExecutor,
  HostAutomationExecutorInput,
  HostAutomationExecutorResult,
} from '@dsh-enhanced/assistant-automations'
import { RECOVERY_CATALOG_DIGEST } from './catalog.js'
import { RecoveryExecutor } from './executor.js'
import type { RecoveryExecutorResult } from './executor.js'
import { RECOVERY_RUNBOOK_ID, RECOVERY_RUNBOOK_VERSION } from './types.js'

export const RECOVERY_EXECUTOR_ID = 'assistant-recovery' as const
export const RECOVERY_EXECUTOR_CONTRACT_VERSION = 2 as const

const MUTATIONS = new Set([
  'activate-preference',
  'maintain-preferences',
  'probe-automation-circuit',
  'project-evaluation',
  'rollback-evolution',
])

function scopeDigest(value: HostAutomationExecutionSpec['targetScope']): string {
  return createHash('sha256').update(JSON.stringify([resolve(value.workspace), value.preset])).digest('hex')
}

function hasPossibleEffect(result: RecoveryExecutorResult): boolean {
  return result.steps.some(step => MUTATIONS.has(step.action.kind)
    && (step.status === 'succeeded' || step.status === 'unknown'))
}

function failureClass(code: string): AutomationFailureClass {
  if (code.includes('cancelled')) return 'cancelled'
  if (code.includes('timeout')) return 'timeout'
  if (code.includes('policy') || code.includes('authority-denied') || code.includes('emergency-stop')) {
    return 'policy'
  }
  if (code.includes('provider') || code.includes('unavailable')) return 'provider'
  if (code.includes('catalog') || code.includes('scope') || code.includes('route')
    || code.includes('required-verification') || code.includes('configuration')) {
    return 'configuration'
  }
  return 'execution'
}

function terminal(result: RecoveryExecutorResult): HostAutomationExecutorResult {
  if (result.status === 'succeeded') {
    const effect = hasPossibleEffect(result)
    return Object.freeze({
      outcome: 'succeeded',
      failureClass: 'none',
      failurePhase: 'none',
      failureCode: 'none',
      sideEffectState: effect ? 'possible' : 'none',
      retryability: effect ? 'unsafe' : 'safe',
    })
  }
  const sideEffectState: AutomationSideEffectState = hasPossibleEffect(result)
    || result.status === 'unknown' ? 'possible' : 'none'
  const classification = result.status === 'unknown' ? 'unknown' : failureClass(result.resultCode)
  const retryability: AutomationRetryability = sideEffectState !== 'none'
    ? 'unsafe'
    : classification === 'configuration' || classification === 'policy' || classification === 'provider'
      ? 'after-intervention'
      : 'safe'
  return Object.freeze({
    outcome: result.status,
    failureClass: classification,
    failurePhase: 'recovery',
    failureCode: result.resultCode,
    sideEffectState,
    retryability,
  })
}

/** Versioned, model-free adapter registered into Assistant Automations. */
export class RecoveryAutomationExecutor implements HostAutomationExecutor {
  readonly descriptor = Object.freeze({
    executorId: RECOVERY_EXECUTOR_ID,
    contractVersion: RECOVERY_EXECUTOR_CONTRACT_VERSION,
    catalogDigest: RECOVERY_CATALOG_DIGEST,
  })

  private readonly active = new Map<string, {
    fingerprint: string
    promise: Promise<HostAutomationExecutorResult>
  }>()

  constructor(
    private readonly executor: RecoveryExecutor,
    private readonly activationPlanDigest: (input: HostAutomationExecutorInput) => string,
  ) {}

  accepts(spec: HostAutomationExecutionSpec): boolean {
    return spec.kind === 'host'
      && spec.executorId === RECOVERY_EXECUTOR_ID
      && spec.executorContractVersion === RECOVERY_EXECUTOR_CONTRACT_VERSION
      && spec.runbookId === RECOVERY_RUNBOOK_ID
      && spec.runbookVersion === RECOVERY_RUNBOOK_VERSION
      && spec.catalogDigest === RECOVERY_CATALOG_DIGEST
      && spec.scopeDigest === scopeDigest(spec.targetScope)
  }

  execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    const activationPlanDigest = this.activationPlanDigest(input)
    const fingerprint = createHash('sha256').update(JSON.stringify({
      occurrenceId: input.occurrenceId,
      automationId: input.automationId,
      definitionHash: input.definitionHash,
      executionMode: input.executionMode,
      targetScope: input.targetScope,
      principal: input.principal,
      ownerRouteId: input.ownerRouteId,
      activationNonce: input.activationNonce,
      catalogDigest: input.catalogDigest,
      activationPlanDigest,
    })).digest('hex')
    const current = this.active.get(input.occurrenceId)
    if (current !== undefined) {
      if (current.fingerprint !== fingerprint) {
        return Promise.reject(new Error(
          'assistant-recovery: concurrent occurrence reused with different immutable input',
        ))
      }
      return current.promise
    }
    const operation = this.executeTracked(input, activationPlanDigest)
    this.active.set(input.occurrenceId, { fingerprint, promise: operation })
    void operation.finally(() => {
      if (this.active.get(input.occurrenceId)?.promise === operation) {
        this.active.delete(input.occurrenceId)
      }
    }).catch(() => {})
    return operation
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map(value => value.promise))
    }
  }

  private async executeTracked(
    input: HostAutomationExecutorInput,
    activationPlanDigest: string,
  ): Promise<HostAutomationExecutorResult> {
    return terminal(await this.executor.execute({
      occurrenceId: input.occurrenceId,
      automationId: input.automationId,
      definitionHash: input.definitionHash,
      executionMode: input.executionMode,
      targetScope: input.targetScope,
      principal: input.principal,
      ownerRouteId: input.ownerRouteId,
      activationNonce: input.activationNonce,
      activationPlanDigest,
      catalogDigest: input.catalogDigest,
      signal: input.signal,
    }))
  }
}
