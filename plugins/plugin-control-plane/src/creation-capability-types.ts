import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import type { SourceJobOwnerReceipt } from './source-job-types.js'
import type { CreationCapabilitySourceSnapshot } from './creation-capability-source.js'

export type CreationCapabilityOwner = Pick<SourceJobOwnerReceipt, 'authorityId' | 'authorityHash' | 'principalId'
  | 'principalRecordId' | 'principalVersion' | 'workspace' | 'agentPreset'>

/** Separate owner authority for adoption and ordinary use; never a verifier policy. */
export interface CreationCapabilityConfig {
  authorityId: string
  keyId: string
  keyPath: string
  owner: CreationCapabilityOwner
  namePrefix: string
  expiresAt: number
  maxAdoptions: number
  maxTools: number
  maxCallsPerAdoption: number
  maxCallRecords: number
  maxInputBytes: number
  /** Opt-in lifetime for an already adopted capability; never extends either use grant. */
  retention?: { maximumLifetimeMs: number }
  runner: {
    stateRoot: string
    image: string
    dockerPath: string
    expiresAt: number
    maxRuns: number
    maxTotalDurationMs: number
    maxDurationMs: number
    maxOutputBytes: number
  }
}

export interface CreationCapabilityTool {
  originalName: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CreationCapabilityReceipt {
  protocol: 'dsh-created-capability-adoption/v1' | 'dsh-created-capability-adoption/v2'
  authorityId: string
  authorityDigest: string
  keyId: string
  planId: string
  planDigest: string
  verificationDigest: string
  artifactSha256: string
  artifactBytes: number
  source: PluginCreationVerificationCertificate['source']
  schemaDigest: string
  toolsDigest: string
  expiresAt: number
  adoptedAt: number
  signature: string
}

export interface CreationCapabilityRecord {
  planId: string
  status: 'claimed' | 'authorized' | 'active' | 'closed' | 'unknown' | 'rejected'
  receipt?: CreationCapabilityReceipt
  certificate: PluginCreationVerificationCertificate
  tools?: readonly CreationCapabilityTool[]
  artifact: Buffer
  reason?: string
}

export interface CreationCapabilityObservation {
  status: 'observed' | 'unknown'
  quiescent: boolean
  jobId?: string
  artifactSha256: string
  reason?: string
  environment?: PluginCreationVerificationCertificate['environment']
  schemaDigest?: string
  schemas?: readonly unknown[]
  calls?: readonly { id: string; toolName: string; result: unknown }[]
}

export interface CreationCapabilityRunner {
  run(input: { key: string; artifact: Buffer; operation: { kind: 'discover' }
    | { kind: 'invoke'; schemaDigest: string; calls: readonly { id: string; toolName: string; arguments: unknown }[] };
    signal: AbortSignal }): Promise<CreationCapabilityObservation>
  close(): Promise<void>
}

/** The integration owns current authenticated task/owner fences, not model parameters. */
export interface CreationCapabilityPorts {
  inspect(planId: string): { certificate: PluginCreationVerificationCertificate; artifact: Buffer; owner: CreationCapabilityOwner }
  recheck(planId: string, signal: AbortSignal): Promise<void>
  /** Capture checked staged source before first claim; legacy ports may have no archive. */
  captureSource?(planId: string, signal: AbortSignal): Promise<CreationCapabilitySourceSnapshot>
  /** Historical evidence read for a v2 receipt; must recheck the current owner and frozen source. */
  inspectRetained?(record: CreationCapabilityRecord): { certificate: PluginCreationVerificationCertificate; artifact: Buffer; owner: CreationCapabilityOwner }
  recheckRetained?(record: CreationCapabilityRecord, signal: AbortSignal): Promise<void>
  withCurrent<T>(record: CreationCapabilityRecord, callback: () => T): T
  assertCaller(record: CreationCapabilityRecord, execution: ToolRunContext): void
  /** Optional authenticated Host attribution; absence never implies a foreground task. */
  inspectCall?(record: CreationCapabilityRecord, execution: ToolRunContext, toolAlias: string,
    argumentsJson: string): CreationCapabilityForegroundCallWitness | undefined
}

export interface CreationCapabilityForegroundCallWitness {
  protocol: 'assistant-delivery/foreground-tool-call/v1'
  task: {
    protocol: 'assistant-delivery/foreground-task/v1'
    inboxId: string
    sessionId: string
    scope: { workspace: string; preset: string }
    owner: { principalRecordId: string; principalVersion: number }
    binding: { id: string; version: number; generation: number }
    dispatchedAt: number
  }
  turn: number
  call: { id: string; toolName: string; eventSeq: number; eventDigest: string; argumentsDigest: string }
}

export interface CreationCapabilityCallEvidence {
  protocol: 'dsh-created-capability-call-evidence/v1'
  planId: string
  key: string
  status: CreationCapabilityCall['status']
  attribution: 'foreground' | 'unattributed' | 'legacy-unattributed'
  toolAlias?: string
  originalName?: string
  receiptDigest: string
  artifactSha256: string
  schemaDigest: string
  claimedAt?: number
  settledAt?: number
  foreground?: CreationCapabilityForegroundCallWitness
}

/** A current, content-free task association; not a causal improvement claim. */
export interface CreationCapabilityTaskAssociation {
  protocol: 'dsh-created-capability-task-association/v1'
  planId: string
  inboxId: string
  sessionId: string
  callKeys: readonly string[]
  receiptDigest: string
  artifactSha256: string
  schemaDigest: string
  adoptionStatus: CreationCapabilityRecord['status']
  /** Signed deadline only; current execution still requires runtime owner, mount and quota checks. */
  withinSignedUseWindow: boolean
  task: {
    projection: { subjectKind: 'foreground-turn'; subjectRef: string; version: number; digest: string; disposition: 'upsert' }
    scopeWatermark: number
    outcomeId: string
    judgement: 'owner-feedback' | 'independent-verifier'
    status: 'achieved' | 'not-achieved'
    sourceDigest: string
  }
}

export interface CreationCapabilityCall {
  key: string
  status: 'claimed' | 'completed' | 'unknown'
  result?: unknown
  jobId?: string
}

/** Historical source data signed separately from the finite execution receipt. */
export interface CreationCapabilitySourceArchive {
  protocol: 'dsh-created-capability-source-archive/v1'
  authorityId: string
  authorityDigest: string
  keyId: string
  planId: string
  certificateDigest: string
  artifactSha256: string
  source: CreationCapabilitySourceSnapshot
  signature: string
}

export interface CreationCapabilityJournalPort {
  readonly authorityDigest: string
  readonly publicKey: string
  inspect(planId: string): CreationCapabilityRecord | undefined
  list(): readonly CreationCapabilityRecord[]
  claim(input: { certificate: PluginCreationVerificationCertificate; artifact: Buffer;
    source?: CreationCapabilitySourceSnapshot }): { created: boolean; record: CreationCapabilityRecord }
  /** Lazy historical read; legacy rows have no archive and are never inferred or backfilled. */
  inspectSourceArchive?(planId: string): CreationCapabilitySourceArchive | undefined
  authorize(planId: string, tools: readonly CreationCapabilityTool[]): CreationCapabilityRecord
  activate(planId: string): CreationCapabilityRecord
  settle(planId: string, status: 'closed' | 'unknown' | 'rejected', reason: string): void
  claimCall(input: { planId: string; key: string; argumentsDigest: string; toolAlias?: string;
    foreground?: CreationCapabilityForegroundCallWitness }): { created: boolean; call: CreationCapabilityCall }
  listCallEvidence?(planId: string): readonly CreationCapabilityCallEvidence[]
  settleCall(input: { planId: string; key: string; status: 'completed' | 'unknown'; result?: unknown; jobId?: string }): void
  recoverClaims(): void
  close(): void
}
