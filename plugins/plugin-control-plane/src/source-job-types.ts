import type { SourceBuildConfig } from './source-build.js'
import type { ScopedPluginFile } from './source-workspace.js'
import type { SourceBaselineConfig } from './source-baseline.js'
import type { SourceCreationBinding, SourceCreationGrant } from './source-creation.js'
import type { SourceRevisionBinding, SourceRevisionGrant } from './source-revision.js'

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
  build: SourceBuildConfig
  worktree: string
  /** Historical Docker row identity; absent for native jobs. */
  containerName?: string
  /** Durable native ledger key, never interpreted as a Docker container. */
  nativeResource?: { backend: 'macos-seatbelt' | 'linux-native'; key: string }
  /**
   * Present only on `revise-created` jobs authenticated by a Host-recorded
   * owner instruction instead of an owner task failure. The digest pins the
   * exact stored instruction row, so any drift fails the frozen intent.
   */
  ownerInstruction?: { instructionId: string; digest: string }
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
