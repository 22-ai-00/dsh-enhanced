/** Structural Host-only acceptance seam. Kept local to avoid a verifier runtime cycle. */
export interface AcceptanceScope { readonly workspace: string; readonly preset: string }
export interface AcceptanceOwner { readonly principalRecordId: string; readonly principalVersion: number }
export interface AcceptanceTask {
  readonly scope: AcceptanceScope
  readonly owner: AcceptanceOwner
  readonly task: { readonly kind: 'foreground-turn'; readonly ref: string }
  readonly objective: string
}
export interface AcceptanceHandle { readonly contractId: string; readonly contractDigest: string }
export interface TaskAcceptanceRegistration {
  readonly protocol: 'assistant-verifier/host-producer/v1'
  readonly generation: string
  readonly owner: { ownsTaskAcceptanceRegistration(registration: TaskAcceptanceRegistration): boolean }
  readonly requiresAcceptance: boolean
  prepare(input: AcceptanceTask): AcceptanceHandle | null
  completed(handle: AcceptanceHandle): Promise<void>
}
export interface AcceptanceContract extends AcceptanceTask { readonly id: string; readonly digest: string }
export interface AcceptedExecution {
  readonly contractId: string
  readonly contractDigest: string
  readonly dispatchedAt: number
  readonly status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'unknown'
  readonly quiescent: boolean
  readonly completedAt: number
  readonly executionRef: string
}
