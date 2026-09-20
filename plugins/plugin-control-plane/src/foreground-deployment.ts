import type { ForegroundTaskIdentity, ForegroundExecution } from '@dsh-enhanced/assistant-delivery'
import type { DeploymentReadinessBinding } from './deployment-readiness.js'
import { assertRuntimeObservation, runtimeConfigDigest, type RuntimeObservation } from './runtime-observer-protocol.js'

/** A deployment cohort witness; it does not claim a tool call or task quality. */
export interface ForegroundDeploymentRecord {
  schemaVersion: 1
  task: ForegroundTaskIdentity
  readiness: DeploymentReadinessBinding
  begin: RuntimeObservation
  state: 'pending' | 'observed' | 'unknown'
  end?: RuntimeObservation
  execution?: ForegroundExecution
}

export function assertForegroundTask(value: ForegroundTaskIdentity): void {
  runtimeConfigDigest(value)
  if (value.protocol !== 'assistant-delivery/foreground-task/v1') throw new Error('invalid foreground task protocol')
  for (const text of [value.inboxId, value.sessionId, value.scope.workspace, value.scope.preset,
    value.owner.principalRecordId, value.binding.id]) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new Error('invalid foreground task identity')
  }
  for (const version of [value.owner.principalVersion, value.binding.version, value.binding.generation, value.dispatchedAt]) {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid foreground task generation')
  }
}

export function runtimeIdentityDigest(runtime: RuntimeObservation): string {
  assertRuntimeObservation(runtime)
  const { challenge: _challenge, observedAt: _observedAt, ...identity } = runtime
  return runtimeConfigDigest(identity)
}

export function assertForegroundDeployment(record: ForegroundDeploymentRecord): void {
  if (record.schemaVersion !== 1 || !['pending', 'observed', 'unknown'].includes(record.state)) throw new Error('invalid foreground deployment')
  assertForegroundTask(record.task)
  assertRuntimeObservation(record.begin)
  if (record.begin.observedAt < record.task.dispatchedAt || record.begin.profilePath !== record.readiness.profilePath
    || runtimeIdentityDigest(record.begin) !== record.readiness.runtimeDigest) throw new Error('foreground deployment binding differs')
  if (record.end) assertRuntimeObservation(record.end)
  if (record.state === 'pending' && (record.execution || record.end)) throw new Error('pending foreground deployment has completion')
  if (record.execution && (record.execution.executionRef !== record.task.inboxId
    || record.execution.dispatchedAt !== record.task.dispatchedAt || record.execution.completedAt < record.task.dispatchedAt)) {
    throw new Error('foreground completion targets a different execution')
  }
  if (record.state === 'observed' && (!record.execution || !record.end
    || record.execution.status !== 'succeeded' || !record.execution.quiescent
    || record.end.observedAt < record.execution.completedAt
    || runtimeIdentityDigest(record.end) !== record.readiness.runtimeDigest)) throw new Error('foreground deployment has no stable completion')
}
