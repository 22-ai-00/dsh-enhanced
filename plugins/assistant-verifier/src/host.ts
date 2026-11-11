import type { AcceptanceTaskIdentity, TaskAcceptanceContract, TaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { Execution } from './store.js'

/** Supplied by a Host production entrypoint, never a model tool payload. */
export interface AcceptanceTask {
  readonly scope: TaskAcceptanceContract['scope']
  readonly owner: TaskAcceptanceContract['owner']
  readonly task: AcceptanceTaskIdentity
  readonly objective: string
}

export interface AcceptanceHandle {
  readonly contractId: string
  readonly contractDigest: string
}

/** The producer persists this binding before submitting the actual task. */
export interface AcceptedExecution extends Execution {
  readonly contractId: string
  readonly contractDigest: string
  readonly dispatchedAt: number
}

/** Host-prepared criteria for one owner goal; the verifier validates and seals them. */
export interface OwnerPreparedContractInput {
  readonly scope: AcceptanceTask['scope']
  readonly owner: AcceptanceTask['owner']
  readonly task: AcceptanceTask['task']
  readonly objective: string
  readonly criteria: TaskAcceptanceContract['criteria']
  readonly bounds: TaskAcceptanceContract['bounds']
  readonly validityMs: number
  /** Trusted preparer identity recorded with the seal; never a model tool payload. */
  readonly preparer: Readonly<{ id: string; digest: string }>
}

export interface TaskAcceptanceRegistration {
  readonly protocol: 'assistant-verifier/host-producer/v1'
  readonly generation: string
  readonly owner: object
  readonly requiresAcceptance: boolean
  prepare(input: AcceptanceTask): AcceptanceHandle | null
  /**
   * Seal Host-prepared criteria for one owner goal without a configured profile.
   * Only the Goals producer may call it; criteria must be decidable by an
   * installed authority, and the same task identity cannot change its seal.
   */
  prepareOwnerContract?(input: OwnerPreparedContractInput): AcceptanceHandle
  /** Reassess a goal using its original frozen conditions and absolute expiry. */
  prepareGoalAssessment?(input: AcceptanceTask, template: AcceptanceHandle): AcceptanceHandle
  /** Re-read the durable terminal execution; a caller cannot supply a verdict. */
  completed(handle: AcceptanceHandle): Promise<void>
}

export interface TaskAcceptanceProducer {
  trustedAcceptanceProducerGeneration(): string
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration): () => void
  inspectAcceptedArtifactSource?(contract: TaskAcceptanceContract): Promise<AcceptanceHandle | null>
  inspectAcceptedExecution(contract: TaskAcceptanceContract): Promise<AcceptedExecution | null>
}

export interface VerifierEvaluationRegistration {
  readonly protocol: 'assistant-verifier/evaluation/v1'
  readonly generation: string
  readonly owner: {
    ownsTrustedVerifierEvaluationRegistration(registration: VerifierEvaluationRegistration): boolean
  }
  append(input: Readonly<{
    contract: TaskAcceptanceContract
    receipt: TaskVerificationReceipt
    execution: Execution
  }>): Promise<void>
}
