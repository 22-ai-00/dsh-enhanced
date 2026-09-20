import type { ForegroundExecution } from './acceptance.js'

export interface ForegroundTaskIdentity {
  protocol: 'assistant-delivery/foreground-task/v1'
  inboxId: string
  sessionId: string
  scope: { workspace: string; preset: string }
  owner: { principalRecordId: string; principalVersion: number }
  binding: { id: string; version: number; generation: number }
  dispatchedAt: number
}

export interface ForegroundTaskObservationRegistration {
  protocol: 'plugin-control-plane/foreground-observer/v1'
  generation: string
  owner: { ownsForegroundTaskObservationRegistration(registration: ForegroundTaskObservationRegistration): boolean }
  begin(task: Readonly<ForegroundTaskIdentity>): unknown
  completed(handle: unknown, task: Readonly<ForegroundTaskIdentity>, execution: Readonly<ForegroundExecution>): void
}

export function validForegroundObservationRegistration(value: unknown): value is ForegroundTaskObservationRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<ForegroundTaskObservationRegistration>
  return item.protocol === 'plugin-control-plane/foreground-observer/v1'
    && typeof item.generation === 'string' && item.generation.trim() === item.generation && item.generation.length > 0
    && Buffer.byteLength(item.generation) <= 200 && typeof item.begin === 'function' && typeof item.completed === 'function'
    && typeof item.owner === 'object' && item.owner !== null && typeof item.owner.ownsForegroundTaskObservationRegistration === 'function'
}

export function isSynchronousForegroundObservationHandle(value: unknown): boolean {
  return !(value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function')
}
