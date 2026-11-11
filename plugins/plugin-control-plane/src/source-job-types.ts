import type { LegacyDockerSourceBuildConfig, SourceBuildConfig } from './source-build.js'
import type { ScopedPluginFile } from './source-workspace.js'
import type { SourceBaselineConfig } from './source-baseline.js'
import type { SourceCreationBinding, SourceCreationGrant } from './source-creation.js'
import type { SourceRevisionBinding, SourceRevisionGrant } from './source-revision.js'
import type { RevisionAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'

/** Owner-configured authority for background checks, separate from an Agent wake. */
export interface SourceJobsConfig {
  authorityId: string
  expiresAt: number
  maxSubmissions: number
  /** Restrict both new work and recovery; omitted retains all legacy modes. */
  allowedModes?: readonly ('create' | 'modify' | 'revise-created')[]
  repository: string
  /** Owner-managed source history; the working checkout remains untouched. */
  baseline?: SourceBaselineConfig
  /** Explicit owner grant for creating new plugin roots. */
  creation?: SourceCreationGrant
  /** Preparation only; does not grant adoption or execution of a revision. */
  revision?: SourceRevisionGrant
  /**
   * P1-4 owner-configured non-inferiority contract (full form). When present,
   * revision grants that pin a benefit digest gate auto-adoption on a recorded
   * non-inferior outcome evaluated under this exact contract.
   */
  revisionBenefit?: import('@dsh-enhanced/assistant-growth-contract').RevisionBenefitContract
  /**
   * Explicit owner opt-in: with a pinned benefit contract, allow exactly one
   * review-only first adoption before candidate evidence can exist. Default
   * false preserves the contract's non-inferior-before-adoption requirement.
   */
  allowReviewOnlyFirstAdoption?: boolean
  ownerRouteId: string
  principalId: string
  workspace: string
  preset: string
  budgetId: string
  budgetAmount: number
}

/** Structural Delivery v2 receipt; no runtime dependency on the optional peer. */
export interface SourceJobOwnerReceipt {
  receiptVersion: 2
  authorityId: string
  authorityHash: string
  principalId: string
  principalRecordId: string
  principalVersion: number
  workspace: string
  agentPreset: string
  bindingVersion: number
  generation: number
}

/**
 * Host-recorded owner revision instruction: the authenticated alternative to
 * a failed owner task for triggering one `revise-created` job. It is written
 * only by the Host request path, freezes the owner receipt and the exact
 * submitted files, and expires; the model cannot create or alter it.
 */
export interface SourceOwnerInstruction {
  instructionId: string
  ownerReceipt: SourceJobOwnerReceipt
  ownerDigest: string
  ownerRouteId: string
  planId: string
  pluginName: string
  filesDigest: string
  createdAt: number
  expiresAt: number
  idempotencyKey: string
}

/**
 * Exact review/adoption windows frozen when an owner instruction is enqueued.
 * The verifier review budget identity itself is committed by the frozen
 * `RevisionAcceptanceAuthorityRef.authorityDigest`; these windows are the
 * Host-side outer budget the source job definition may allocate for the
 * review and adoption continuations.
 */
export interface OwnerInstructionReviewWindow {
  verificationMs: number
  regressionMs: number
  adoptionMs: number
}

/** Independent review budget identity frozen at instruction enqueue. */
export interface OwnerInstructionReviewBudget {
  protocol: 'plugin-control-plane/owner-instruction-review-budget/v1'
  authority: RevisionAcceptanceAuthorityRef
  verifierKeyDigest: string
  window: OwnerInstructionReviewWindow
}

/**
 * The review supplier and budget an owner-instruction revision must use for
 * its whole review lane. Written once at enqueue; recovery only re-reads it and
 * fails closed if it is absent or no longer matches the configured verifier.
 */
export interface OwnerInstructionReviewFreeze {
  protocol: 'plugin-control-plane/owner-instruction-review-freeze/v1'
  supplier: Readonly<{ provider: string; model: string; reasoningEffort?: string }>
  budget: OwnerInstructionReviewBudget
  digest: string
}

/**
 * A structured owner-instruction revision request written by the control-plane
 * CLI before any Delivery/owner-route validation exists in that process. The
 * running service's SourceJobs continuation tick claims pending rows, re-validates
 * the owner route inside its trust boundary and only then enqueues the job. The
 * CLI never writes source_jobs directly and the model tool surface never reaches
 * this table. `files` are the exact candidate bytes; `filesDigest` binds them.
 */
export interface SourceOwnerInstructionRequest {
  requestId: string
  planId: string
  pluginName: string
  expectedBaseCommit: string
  files: readonly ScopedPluginFile[]
  filesDigest: string
  ttlMs: number
  idempotencyKey: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'claimed' | 'accepted' | 'rejected'
  failureCode: string | null
  /** Set while claimed; a stale value marks an orphaned claim safe to requeue. */
  claimedAt: number | null
  claimGeneration: number
  instructionId: string | null
  jobId: string | null
}

export interface SourceJobAuthority {
  id: string
  digest: string
  expiresAt: number
  maxSubmissions: number
}

/** Private immutable payload. Never return files, paths or receipts to model tools. */
export interface SourceJobIntent {
  authority: SourceJobAuthority
  owner: SourceJobOwnerReceipt
  ownerDigest: string
  trustDigest: string
  repository: string
  baseline?: SourceBaselineConfig
  /** Absent on historical and current modify jobs. */
  mode?: 'create' | 'revise-created'
  creation?: SourceCreationBinding
  revision?: SourceRevisionBinding
  name: string
  gapId: string
  gapRevision: number
  gapDigest: string
  baseCommit: string
  files: readonly ScopedPluginFile[]
  ttlMs: number
  /** A docker-era value can only be decoded from stored history; new intents require a native backend. */
  build: SourceBuildConfig | LegacyDockerSourceBuildConfig
  worktree: string
  /** Historical Docker row identity; present only on legacy docker-era intents. */
  containerName?: string
  /** Durable native ledger key; present on all native jobs. */
  nativeResource?: { backend: 'macos-seatbelt' | 'linux-native'; key: string }
  /**
   * Present only on `revise-created` jobs authenticated by a Host-recorded
   * owner instruction instead of an owner task failure. The digest pins the
   * exact stored instruction row, so any drift fails the frozen intent.
   * `reviewFreezeDigest`/`reviewWindow` pin the review supplier and budget
   * frozen at instruction enqueue; both are absent only on legacy intents,
   * which every execution path fails closed.
   */
  ownerInstruction?: {
    instructionId: string
    digest: string
    reviewFreezeDigest?: string
    reviewWindow?: OwnerInstructionReviewWindow
  }
}

export type SourceJobStatus = 'queued' | 'running' | 'prepared' | 'failed' | 'unknown'

export interface SourceJobRecord {
  id: string
  automationId: string
  idempotencyKey: string
  intent: SourceJobIntent
  intentDigest: string
  status: SourceJobStatus
  revision: number
  createdAt: number
  expiresAt: number
  updatedAt: number
  definitionHash?: string
  /** Operational one-shot rearm only; never part of the immutable intent. */
  dispatchAt?: number
  previousDefinitionHash?: string
  previousDefinitionVersion?: number
  occurrenceId?: string
  planId?: string
  failureCode?: string
}

export interface SourceJobCompletion {
  jobId: string
  jobRevision: number
  occurrenceId: string
}

/** Content-free projection, scoped by the current owner before returning it. */
export interface SourceJobProjection {
  id: string
  name: string
  gapId: string
  baseCommit: string
  mode?: 'create' | 'revise-created'
  status: SourceJobStatus
  createdAt: number
  expiresAt: number
  planId?: string
  failureCode?: string
  /** Present only for `failed` + `source-build-check-failed`: bounded, sanitized, process-local. */
  diagnostics?: import('./source-build-diagnostics.js').SourceBuildDiagnostics
}
