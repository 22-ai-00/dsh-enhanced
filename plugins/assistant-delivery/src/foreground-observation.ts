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

/** Content-free proof of one native call in the currently claimed owner task. */
export interface ForegroundToolCallAttestation {
  protocol: 'assistant-delivery/foreground-tool-call/v1'
  task: ForegroundTaskIdentity
  turn: number
  call: {
    id: string
    toolName: string
    eventSeq: number
    eventDigest: string
    argumentsDigest: string
  }
}

/** A byte-bounded page of the persisted human input, never model tool arguments. */
export interface ForegroundToolInputPage {
  text: string
  fullTextDigest: string
  fullBytes: number
  returnedBytes: number
  offset: number
  nextOffset?: number
}

export interface OwnerForegroundToolInput {
  protocol: 'assistant-delivery/foreground-tool-input/v1'
  attestation: Readonly<ForegroundToolCallAttestation>
  sourceDigest: string
  modelSelectionState: 'missing' | 'frozen' | 'inconsistent'
  modelSelection?: Readonly<{ provider: string; model: string; reasoningEffort?: string }>
  input: Readonly<ForegroundToolInputPage>
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
