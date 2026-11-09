import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CreationCapabilityObservation, CreationCapabilityOwner, CreationCapabilityTool } from './creation-capability-types.js'
import type { CreationCapabilitySourceSnapshot } from './creation-capability-source.js'
import type { PluginCreationVerificationCertificate, PluginRevisionRegressionCertificate,
  PluginRevisionVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'

/** Independent finite rollback authorization; deliberately separate from the adoption grant. */
export interface RevisionCapabilityRollbackGrant {
  authorityId: string
  expiresAt: number
  maxRollbacks: number
}

/**
 * Separate, finite owner authority for replacing an already adopted stable tool entry with an
 * independently verified revision. It never signs acceptance and never grants execution: the
 * parent creation adoption and this receipt only select which verified artifact the stable entry
 * routes to. Absent configuration keeps every existing revision plan terminal after review.
 */
export interface RevisionCapabilityConfig {
  authorityId: string
  keyId: string
  keyPath: string
  owner: CreationCapabilityOwner
  namePrefix: string
  expiresAt: number
  maxAdoptions: number
  maxInputBytes: number
  maxCallRecords: number
  /** New independent host-only rollback grant with its own expiry and count. */
  rollback: RevisionCapabilityRollbackGrant
  /** Opt-in lifetime for an already adopted revision; never extends either use grant. */
  retention?: { maximumLifetimeMs: number }
}

export interface RevisionCapabilityModel {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Content-addressed candidate run reference bound by an adoption receipt. */
/**
 * The adoption receipt repeats the verification certificate's signed source:
 * a task-failure revision pins its growth run, an owner-instruction revision
 * pins the instruction row that authenticated it.
 */
export type RevisionCapabilitySourceRef =
  | { referenceDigest: string; ownerDigest: string; growthRunDigest: string }
  | { instructionDigest: string; ownerDigest: string }

/** A signed adoption receipt binds the exact parent adoption receipt, candidate artifact, new task and model. */
export interface RevisionCapabilityAdoptionReceipt {
  protocol: 'dsh-created-capability-revision-adoption/v1'
  authorityId: string
  authorityDigest: string
  keyId: string
  planId: string
  planDigest: string
  verificationDigest: string
  parentPlanId: string
  parentCertificateDigest: string
  parentReceiptDigest: string
  parentArtifactSha256: string
  entryId: string
  aliasesDigest: string
  artifactSha256: string
  artifactBytes: number
  schemaDigest: string
  source: RevisionCapabilitySourceRef
  model: RevisionCapabilityModel
  /** Present exactly when an independent parent-behavior regression was configured. */
  regressionDigest?: string
  /** Parent calls already running at the switch; attribution evidence only, never an authorization. */
  inFlightParentCalls: number
  expiresAt: number
  adoptedAt: number
  signature: string
}

export type RevisionCapabilityAdoptionStatus = 'claimed' | 'active' | 'closed' | 'unknown' | 'rejected'

export interface RevisionCapabilityAdoptionRecord {
  planId: string
  status: RevisionCapabilityAdoptionStatus
  parentPlanId: string
  certificateDigest: string
  claimedAt: number
  settledAt?: number
  reason?: string
  entryId?: string
  inFlightParentCalls?: number
}

/** One immutable artifact version retained under a stable entry; bytes are never rewritten. */
export interface RevisionCapabilityVersion {
  planId: string
  entryId: string
  role: 'parent' | 'revision'
  name: string
  certificate: PluginCreationVerificationCertificate | PluginRevisionVerificationCertificate
  certificateDigest: string
  /** Parent creation adoption receipt (parent) or this journal's signed adoption receipt (revision). */
  receiptJson: string
  receiptDigest: string
  tools: readonly CreationCapabilityTool[]
  artifact: Buffer
  artifactSha256: string
  schemaDigest: string
  source: RevisionCapabilitySourceRef
  model: RevisionCapabilityModel
  regressionDigest?: string
  adoptedAt: number
  expiresAt: number
}

/** The stable tool entry; aliases are inherited verbatim from the parent adoption. */
export interface RevisionCapabilityEntry {
  entryId: string
  name: string
  aliases: readonly string[]
  aliasesDigest: string
  parentPlanId: string
  currentPlanId: string
  revision: number
  createdAt: number
  updatedAt: number
}

export interface RevisionCapabilityCall {
  key: string
  versionPlanId: string
  status: 'claimed' | 'completed' | 'unknown'
  result?: unknown
}

/** Bounded, content-free call attribution; arguments and results never escape. */
export interface RevisionCapabilityCallEvidence {
  protocol: 'dsh-created-capability-revision-call/v1'
  entryId: string
  key: string
  versionPlanId: string
  toolAlias: string
  status: 'completed' | 'unknown' | 'claimed'
  receiptDigest: string
  claimedAt: number
  settledAt?: number
}

export interface RevisionCapabilityRollbackRecord {
  protocol: 'dsh-created-capability-revision-rollback/v1'
  rollbackId: string
  entryId: string
  fromPlanId: string
  toPlanId: string
  parentReceiptDigest: string
  authorityId: string
  at: number
  ordinal: number
  digest: string
}

/** Read-only Host readiness; never a model tool and never key material. */
export interface RevisionCapabilityReadiness {
  protocol: 'dsh-created-capability-revision-adoption-readiness/v1'
  available: boolean
  authority: { authorityId: string; expiresAt: number }
  remainingAdoptions: number
  remainingRollbacks: number
  rollbackExpiresAt: number
}

/** The integration owns current authenticated owner/source fences, not model parameters. */
export interface RevisionCapabilityPorts {
  /** Fresh independently verified candidate; the integration rechecks owner and every source fence. */
  inspect(planId: string): RevisionCapabilityInspection
  recheck(planId: string, signal: AbortSignal): Promise<void>
  /** Current active creation adoption of the exact parent plan. */
  parent(planId: string): RevisionCapabilityParentAdoption
  recheckParent(planId: string, signal: AbortSignal): Promise<void>
  /** Calls of the parent adoption already running at the switch; evidence only. */
  inFlightParentCalls(planId: string): number
  /** Host-only alias handover; already running parent calls must keep executing. */
  suspendParent(planId: string): Promise<void>
  /** Host-only recovery after a failed switch. */
  resumeParent(planId: string): Promise<void>
  /** Execute a verified parent/revision artifact under the same finite behavior runner. */
  runVersion(input: { certificate: PluginCreationVerificationCertificate | PluginRevisionVerificationCertificate
    artifact: Buffer; schemaDigest: string; operation: { kind: 'discover' }
    | { kind: 'invoke'; calls: readonly { id: string; toolName: string; arguments: unknown }[] }; key: string
    signal: AbortSignal }): Promise<CreationCapabilityObservation>
  /** Read-only proof of the fixed execution boundary for this candidate. */
  recheckExecution(certificate: PluginCreationVerificationCertificate | PluginRevisionVerificationCertificate,
    signal: AbortSignal): Promise<void>
  /** Synchronous, read-only execution-boundary identity used by admission; never executes the artifact. */
  matchesExecution(certificate: PluginCreationVerificationCertificate | PluginRevisionVerificationCertificate): boolean
  /** Current authenticated owner Agent admission for one mounted call. */
  assertCaller(execution: ToolRunContext): void
}

export interface RevisionCapabilityParentAdoption {
  planId: string
  name: string
  owner: CreationCapabilityOwner
  certificate: PluginCreationVerificationCertificate
  artifact: Buffer
  tools: readonly CreationCapabilityTool[]
  receiptJson: string
  receiptDigest: string
}

export interface RevisionCapabilityInspection {
  certificate: PluginRevisionVerificationCertificate
  artifact: Buffer
  source: CreationCapabilitySourceSnapshot
  plan: { id: string; digest: string; name: string }
  regression?: PluginRevisionRegressionCertificate
  owner: CreationCapabilityOwner
}

/** Signed-receipt and durable state mirror for the runtime; the filesystem journal is the production port. */
export interface RevisionCapabilityJournalPort {
  readonly authorityDigest: string
  readonly publicKey: string
  inspectAdoption(planId: string): RevisionCapabilityAdoptionRecord | undefined
  listEntries(): readonly RevisionCapabilityEntry[]
  inspectEntry(entryId: string): { entry: RevisionCapabilityEntry; parent: RevisionCapabilityVersion;
    current: RevisionCapabilityVersion } | undefined
  inspectVersion(planId: string): RevisionCapabilityVersion | undefined
  usage(): { adoptions: number; rollbacks: number; calls: number }
  /** Sign one exact adoption receipt with the journal key; the body is validated before signing. */
  signReceipt(body: Omit<RevisionCapabilityAdoptionReceipt, 'signature'>): RevisionCapabilityAdoptionReceipt
  claim(input: { planId: string; parentPlanId: string; certificateDigest: string }): { created: boolean;
    record: RevisionCapabilityAdoptionRecord }
  commit(input: { entry: { entryId: string; name: string; aliases: readonly string[] }
    parent: RevisionCapabilityVersion; revision: RevisionCapabilityVersion
    receipt: RevisionCapabilityAdoptionReceipt; expectedCurrentPlanId: string; inFlightParentCalls: number }):
    RevisionCapabilityAdoptionRecord
  settle(planId: string, status: 'closed' | 'unknown' | 'rejected', reason: string): void
  rollback(input: { entryId: string; expectedCurrentPlanId: string; authorityId: string }):
    { created: boolean; record: RevisionCapabilityRollbackRecord }
  claimCall(input: { entryId: string; key: string; argumentsDigest: string; toolAlias: string;
    versionPlanId: string }): { created: boolean; call: RevisionCapabilityCall }
  settleCall(input: { entryId: string; key: string; status: 'completed' | 'unknown'; result?: unknown }): void
  listCallEvidence(entryId: string): readonly RevisionCapabilityCallEvidence[]
  recoverClaims(): void
  close(): void
}
