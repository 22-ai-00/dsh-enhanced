import type { Context } from '@deepseek-ai/cordis'

export type CompensationCategory =
  | 'revert'
  | 'delete'
  | 'cancel'
  | 'notify-undo'
  | 'rollback-state'
  | 'custom'

export type CompensationTerminalStatus = 'succeeded' | 'failed' | 'unknown'

export type CompensationStatus =
  | 'capturing'
  | 'prepared'
  | 'dispatched'
  | CompensationTerminalStatus

export type CompensationAuditEvent =
  | 'capturing'
  | 'prepared'
  | 'dispatched'
  | 'settled'
  | 'discarded'
  | 'abandoned'
  | 'recovered'
  | 'replayed'

export type RecoveryCompensationErrorCode =
  | 'invalid-input'
  | 'invalid-state'
  | 'handler-not-registered'
  | 'handler-conflict'
  | 'idempotency-conflict'
  | 'conflict'
  | 'unauthorized'
  | 'expired'
  | 'capture-failed'
  | 'disposed'
  | 'not-found'

export class RecoveryCompensationError extends Error {
  constructor(
    readonly code: RecoveryCompensationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RecoveryCompensationError'
  }
}

export interface CompensationScope {
  readonly principalId: string
  readonly workspace: string
  readonly preset: string
  readonly principalRecordId?: string
  readonly principalVersion?: number
}

export interface CompensationRecordInput {
  readonly idempotencyKey: string
  readonly kind: string
  readonly target: Readonly<Record<string, unknown>>
  readonly forwardActionId?: string
  readonly scope?: CompensationScope
  readonly sourcePlugin?: string
  readonly runId?: string
  readonly stepId?: string
  readonly preimage?: Readonly<Record<string, unknown>>
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly expiresAt?: number
  readonly timeoutMs?: number
}

export interface StoredCompensationRecord {
  readonly id: string
  readonly idempotencyKey: string
  readonly idempotencyDigest: string
  readonly forwardActionId?: string
  readonly kind: string
  readonly category: CompensationCategory
  readonly scopeDigest?: string
  readonly sourcePlugin?: string
  readonly runId?: string
  readonly stepId?: string
  readonly target: Readonly<Record<string, unknown>>
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly requestDigest: string
  readonly preimage?: Readonly<Record<string, unknown>>
  readonly preimageDigest?: string
  readonly status: CompensationStatus
  readonly resultCode?: string
  readonly receipt?: Readonly<Record<string, unknown>>
  readonly receiptDigest?: string
  readonly reason?: string
  readonly expiresAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly settledAt?: number
  readonly version: number
}

export interface PublicCompensationStatus {
  readonly id: string
  readonly idempotencyKey: string
  readonly forwardActionId?: string
  readonly kind: string
  readonly category: CompensationCategory
  readonly scopeDigest?: string
  readonly sourcePlugin?: string
  readonly runId?: string
  readonly stepId?: string
  readonly target: Readonly<Record<string, unknown>>
  readonly targetDigest: string
  readonly requestDigest: string
  readonly preimageDigest?: string
  readonly status: CompensationStatus
  readonly resultCode?: string
  readonly receipt?: Readonly<Record<string, unknown>>
  readonly receiptDigest?: string
  readonly reason?: string
  readonly expiresAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly settledAt?: number
  readonly version: number
}

export interface CompensationAuditEntry {
  readonly sequence: number
  readonly compensationId: string
  readonly event: CompensationAuditEvent
  readonly status: CompensationStatus
  readonly version: number
  readonly resultCode?: string
  readonly detail?: Readonly<Record<string, unknown>>
  readonly detailDigest?: string
  readonly recordedAt: number
}

export interface CompensationExecutionContext {
  readonly compensationId: string
  readonly idempotencyKey: string
  readonly record: StoredCompensationRecord
  readonly signal: AbortSignal
}

export interface CompensatorOutcome {
  readonly status: CompensationTerminalStatus
  readonly resultCode: string
  readonly sideEffectState?: 'none' | 'possible' | 'applied'
  readonly receipt?: Readonly<Record<string, unknown>>
  readonly reason?: string
}

export interface CompensatorHandler {
  readonly kind: string
  readonly category: CompensationCategory
  readonly description?: string
  readonly capturePreimage?: (
    context: CompensationExecutionContext,
  ) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>
  readonly authorize?: (
    context: {
      readonly kind: string
      readonly idempotencyKey: string
      readonly target: Readonly<Record<string, unknown>>
      readonly scope?: CompensationScope
    },
  ) => Promise<boolean> | boolean
  readonly compensate: (
    context: CompensationExecutionContext,
  ) => Promise<CompensatorOutcome> | CompensatorOutcome
}

export interface CompensatorDescriptor {
  readonly kind: string
  readonly category: CompensationCategory
  readonly description?: string
  readonly capturesPreimage: boolean
  readonly hasAuthorizer: boolean
}

export interface ExecuteCompensationOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly authorize?: () => boolean | Promise<boolean>
}

export interface CompensationExecutionResult {
  readonly id: string
  readonly idempotencyKey: string
  readonly kind: string
  readonly status: CompensationTerminalStatus
  readonly resultCode: string
  readonly preimageDigest: string
  readonly receipt?: Readonly<Record<string, unknown>>
  readonly receiptDigest?: string
  readonly reason?: string
  readonly replayed: boolean
  readonly settledAt: number
}

export interface CompensationQueryFilter {
  readonly kind?: string
  readonly status?: CompensationStatus
  readonly runId?: string
  readonly sourcePlugin?: string
  readonly limit?: number
}

export interface RecoveryCompensationPort {
  executeCompensation(
    record: CompensationRecordInput,
    options?: ExecuteCompensationOptions,
  ): Promise<CompensationExecutionResult>
  hasCompensator(kind: string): boolean
  registerCompensator?(
    handler: CompensatorHandler,
    options?: { replace?: boolean; ownerCtx?: Context },
  ): () => void
  listCompensators?(): readonly CompensatorDescriptor[]
  getCompensationStatus?(
    idOrKey: { readonly id?: string; readonly idempotencyKey?: string },
  ): PublicCompensationStatus | undefined
  listCompensations?(filter?: CompensationQueryFilter): readonly PublicCompensationStatus[]
  listCompensationAudit?(compensationId: string): readonly CompensationAuditEntry[]
}
