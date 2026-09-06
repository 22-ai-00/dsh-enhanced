/** Structural Host-only acceptance seam.  Kept local to avoid a runtime cycle. */
export interface AcceptanceOwner { readonly principalRecordId: string; readonly principalVersion: number }
export interface AcceptanceScope { readonly workspace: string; readonly preset: string }
export interface AcceptanceTaskInput {
  readonly scope: AcceptanceScope
  readonly owner: AcceptanceOwner
  readonly task: { readonly kind: 'automation-run'; readonly ref: string }
  readonly objective: string
}
export interface AcceptanceHandle { readonly contractId: string; readonly contractDigest: string }
export interface TaskAcceptanceRegistration {
  readonly protocol: 'assistant-verifier/host-producer/v1'
  readonly generation: string
  readonly owner: { ownsTaskAcceptanceRegistration(registration: TaskAcceptanceRegistration): boolean }
  readonly requiresAcceptance?: boolean
  prepare(input: AcceptanceTaskInput): AcceptanceHandle | null
  completed(handle: AcceptanceHandle): Promise<void>
}
export interface AcceptanceContract {
  readonly id: string
  readonly digest: string
  readonly scope: AcceptanceScope
  readonly owner: AcceptanceOwner
  readonly task: { readonly kind: 'automation-run'; readonly ref: string }
}
export interface AcceptedExecution {
  readonly contractId: string
  readonly contractDigest: string
  readonly dispatchedAt: number
  readonly status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'unknown'
  readonly quiescent: boolean
  readonly completedAt: number
  readonly executionRef: string
}
