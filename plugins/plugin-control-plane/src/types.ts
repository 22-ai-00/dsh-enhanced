import type { CatalogEntry } from './catalog.js'

export type PlanStatus =
  | 'pending-approval'
  | 'approved'
  | 'staging'
  | 'awaiting-reload'
  | 'awaiting-readiness'
  | 'awaiting-effect-blocked-replay'
  | 'awaiting-shadow'
  | 'awaiting-canary'
  | 'awaiting-soak'
  | 'awaiting-health'
  | 'commit-pending'
  | 'rollback-pending'
  | 'activated'
  | 'rolled-back'

export type HostAttestationPhase = 'reload' | 'readiness' | 'effect-blocked-replay' | 'shadow' | 'canary' | 'soak' | 'health'

export interface HostAttestationPolicy {
  readinessMinimumChecks: number
  effectBlockedMinimumDeliveryAttempts: number
  effectBlockedMinimumToolExecutionAttempts: number
  shadowMinimumSamples: number
  shadowMaximumMismatches: number
  canaryMinimumSamples: number
  canaryMaximumFailures: number
  soakMinimumWindowMs: number
  soakMinimumSamples: number
  soakMaximumFailureRate: number
  healthMinimumChecks: number
  healthMaximumFailures: number
  receiptTtlMs: number
}

export type HostAttestationRequirements =
  | { kind: 'reload'; previousHostGeneration: number }
  | { kind: 'readiness'; minimumChecks: number }
  | { kind: 'effect-blocked-replay'; minimumDeliveryAttempts: number; minimumToolExecutionAttempts: number; maximumExternalEffects: 0 }
  | { kind: 'shadow'; minimumSamples: number; maximumMismatches: number; maximumExternalEffects: 0 }
  | { kind: 'canary'; maximumExposures: 1; minimumSamples: number; maximumFailures: number }
  | { kind: 'soak'; minimumWindowMs: number; minimumSamples: number; maximumFailureRate: number }
  | { kind: 'health'; minimumChecks: number; maximumFailures: number }

export interface HostAttestationRequest {
  schemaVersion: 1
  kind: 'dsh-host-attestation-request'
  operationId: string
  requestedAt: number
  receiptTtlMs: number
  installationId: string
  ledger: { id: string; path: string }
  plan: { id: string; digest: string }
  activation: { id: string; fence: number }
  profile: { name: string; path: string }
  issuer:
    | { mode: 'owner-manual' }
    | { mode: 'configured-executable'; id: string; version: string; path: string; sha256: string;
      interpreter: { path: string; sha256: string } | null; authority: string; keyId: string }
  phase: HostAttestationPhase
  requirements: HostAttestationRequirements
}

export type HostAttestationEvidence =
  | { kind: 'reload'; reloaded: boolean; previousHostGeneration: number; currentHostGeneration: number; probeDigest: string }
  | { kind: 'readiness'; checks: number; failures: number; probeDigest: string }
  | { kind: 'effect-blocked-replay'; deliveryAttempts: number; deliveryBlocked: number; toolExecutionAttempts: number; toolExecutionBlocked: number; externalEffects: number; replayDigest: string }
  | { kind: 'shadow'; samples: number; mismatches: number; externalEffects: number; traceDigest: string }
  | { kind: 'canary'; exposureId: string; exposures: number; samples: number; failures: number; traceDigest: string }
  | { kind: 'soak'; windowStartedAt: number; windowEndedAt: number; samples: number; failures: number; traceDigest: string }
  | { kind: 'health'; checks: number; failures: number; probeDigest: string }

export interface CapabilityGapInput {
  idempotencyKey: string
  capability: string
  context: string
  expectedValue: number
  frequency: number
  estimatedCost: number
  risk: number
}

export interface StoredCapabilityGap extends CapabilityGapInput {
  id: string
  inputDigest: string
  roi: number
  status: 'open' | 'matched' | 'closed'
  revision: number
  candidateId?: string
  createdAt: number
  updatedAt: number
}

export interface PluginActivationPlan {
  schemaVersion: 4
  kind: 'activation'
  id: string
  gapId: string
  gapSnapshot: {
    revision: number
    inputDigest: string
    roi: number
    capability: string
  }
  status: PlanStatus
  revision: number
  createdAt: number
  expiresAt: number
  profile: string
  candidate: CatalogEntry
  dossier: {
    catalogDigest: string
    catalogProvenance: 'owner-provided-integrity-pinned'
    matchedCapabilities: readonly string[]
    authorities: readonly string[]
    packages: readonly { package: string; version: string; integrity: string }[]
  }
  installationId: string
  ledger: { id: string; path: string }
  target: { dshHome: string; profile: string; profilePath: string }
  executor: { id: string; version: string; path: string; sha256: string }
  digest: string
  approval?: VerifiedApprovalReceipt
  activation?: {
    id: string
    fence: number
    /** Durable baseline used to distinguish restore-from-backup from remove-on-rollback. */
    targetOriginallyExisted?: boolean
    failureCode?: string
    updatedAt: number
  }
}

export type SourceReleasePhase = 'pr' | 'review' | 'merge' | 'build' | 'sign' | 'publish' | 'registry-verify' | 'catalog-admission'

export type SourcePlanStatus =
  | 'pending-approval'
  | 'approved'
  | 'running-local-checks'
  | 'ready-for-human-review'
  | 'local-checks-failed'
  | 'awaiting-pr'
  | 'awaiting-review'
  | 'awaiting-merge'
  | 'awaiting-build'
  | 'awaiting-sign'
  | 'awaiting-publish'
  | 'awaiting-registry-verify'
  | 'awaiting-catalog-admission'
  | 'release-complete'
  | 'release-failed'
  | 'publish-ambiguous'

export interface PluginSourcePlan {
  schemaVersion: 1
  kind: 'source'
  id: string
  gapId: string
  gapSnapshot: PluginActivationPlan['gapSnapshot']
  status: SourcePlanStatus
  revision: number
  createdAt: number
  expiresAt: number
  digest: string
  repository: string
  worktree: string
  baseCommit: string
  name: string
  generatorDigest: string
  scope: readonly string[]
  approval?: VerifiedApprovalReceipt
  release?: {
    id: string
    fence: number
    failurePhase?: SourceReleasePhase
    failureCode?: string
    updatedAt: number
  }
}

export interface SourceReleaseAdapterIdentity {
  id: string
  version: string
  path: string
  sha256: string
  interpreter: { path: string; sha256: string } | null
  authority: string
  keyId: string
}

export interface SourceReleaseArtifact {
  packageName: string
  packageVersion: string
  tarballPath: string
  tarballBytes: number
  tarballSha256: string
  tarballIntegrity: string
  sbomPath: string
  sbomSha256: string
  provenancePath: string
  provenanceSha256: string
  mergedCommit: string
  dshBaseline: string
  capabilities: readonly string[]
  authorities: readonly string[]
  requires: readonly { package: string; version: string; integrity: string }[]
}

interface SourceReleaseRequestBase {
  schemaVersion: 1
  kind: 'dsh-source-release-request'
  operationId: string
  requestedAt: number
  receiptTtlMs: number
  installationId: string
  ledger: { id: string; path: string }
  plan: { id: string; digest: string; revision: number }
  release: { id: string; fence: number }
  adapter: SourceReleaseAdapterIdentity
  registry: { id: string; locator: string }
  catalog: { id: string; path: string }
}

export type SourceReleaseRequest = SourceReleaseRequestBase & (
  | { phase: 'pr'; input: { repository: string; worktree: string; baseCommit: string; name: string; scope: readonly string[] } }
  | { phase: 'review'; input: { prId: string; headCommit: string; baseCommit: string; prEvidenceDigest: string } }
  | { phase: 'merge'; input: { prId: string; headCommit: string; reviewId: string; reviewEvidenceDigest: string } }
  | { phase: 'build'; input: { repository: string; mergeCommit: string; mergeEvidenceDigest: string; name: string } }
  | { phase: 'sign'; input: { artifact: SourceReleaseArtifact; buildEvidenceDigest: string } }
  | { phase: 'publish'; input: { artifact: SourceReleaseArtifact; artifactStatementDigest: string; artifactSignature: string; signEvidenceDigest: string } }
  | { phase: 'registry-verify'; input: { artifact: SourceReleaseArtifact; artifactStatementDigest: string; artifactSignature: string;
    registryReference: string; publishEvidenceDigest: string } }
  | { phase: 'catalog-admission'; input: { artifact: SourceReleaseArtifact; artifactStatementDigest: string; artifactSignature: string;
    registryReference: string; verificationEvidenceDigest: string; candidate: CatalogEntry } }
)

export type SourceReleaseSuccessEvidence =
  | { kind: 'pr'; prId: string; baseCommit: string; headCommit: string; repositoryDigest: string }
  | { kind: 'review'; prId: string; headCommit: string; reviewId: string; decision: 'approved'; reviewerPrincipalDigest: string }
  | { kind: 'merge'; prId: string; reviewedHeadCommit: string; mergeCommit: string; targetBranch: string }
  | ({ kind: 'build'; isolated: true; reproducibleBuilds: number; firstBuildSha256: string; secondBuildSha256: string } & SourceReleaseArtifact)
  | { kind: 'sign'; artifactStatementDigest: string; artifactSignature: string; artifactSignatureDigest: string }
  | { kind: 'publish'; registryId: string; registryReference: string; packageName: string; packageVersion: string;
    tarballSha256: string; tarballIntegrity: string; artifactStatementDigest: string; artifactSignatureDigest: string; immutable: true }
  | { kind: 'registry-verify'; registryId: string; registryReference: string; independentlyDownloaded: true;
    downloadedBytes: number; downloadedSha256: string; downloadedIntegrity: string; artifactStatementDigest: string; artifactSignatureDigest: string }
  | { kind: 'catalog-admission'; admissionId: string; catalogId: string; beforeCatalogDigest: string; afterCatalogDigest: string;
    verificationEvidenceDigest: string; candidate: CatalogEntry }

export interface SourceReleaseFailureEvidence {
  kind: 'failure'
  phase: SourceReleasePhase
  code: string
  remoteState: 'unchanged' | 'created-not-reverted' | 'unknown'
  detailDigest: string
}

export interface SourceReleasePublishAmbiguityEvidence {
  kind: 'publish-ambiguity'
  registryId: string
  packageName: string
  packageVersion: string
  tarballSha256: string
  detailDigest: string
}

export interface SourceReleaseReceipt {
  schemaVersion: 1
  receiptId: string
  authority: string
  keyId: string
  installationId: string
  planId: string
  planDigest: string
  releaseId: string
  fence: number
  operationId: string
  requestDigest: string
  phase: SourceReleasePhase
  outcome: 'passed' | 'failed' | 'ambiguous'
  evidence: SourceReleaseSuccessEvidence | SourceReleaseFailureEvidence | SourceReleasePublishAmbiguityEvidence
  evidenceDigest: string
  observedAt: number
  expiresAt: number
  signature: string
}

export interface VerifiedSourceReleaseReceipt extends Omit<SourceReleaseReceipt, 'signature'> { signatureDigest: string }

export interface SourceReleaseAuthority {
  verify(receipt: SourceReleaseReceipt, plan: PluginSourcePlan, request: SourceReleaseRequest): Promise<VerifiedSourceReleaseReceipt>
}

export interface SourceReleaseOperation {
  planId: string
  phase: SourceReleasePhase
  operationId: string
  bindingDigest: string
  requestDigest: string
  request: SourceReleaseRequest
  status: 'pending' | 'completed' | 'applied'
  receipt?: SourceReleaseReceipt
  createdAt: number
  completedAt?: number
  appliedAt?: number
}

/**
 * Receipt returned by an owner-controlled approval authority. The authority
 * signs the canonical fields; the control plane never accepts a display name
 * or caller assertion as an approval decision.
 */
export interface ApprovalReceipt {
  schemaVersion: 1
  approvalId: string
  authority: string
  keyId: string
  planId: string
  planDigest: string
  decision: 'approved' | 'rejected'
  principal: string
  decidedAt: number
  expiresAt: number
  signature: string
}

export interface VerifiedApprovalReceipt extends Omit<ApprovalReceipt, 'signature'> {
  signatureDigest: string
}

export interface ApprovalAuthority {
  verify(receipt: ApprovalReceipt, plan: Pick<PluginActivationPlan | PluginSourcePlan, 'id' | 'digest' | 'createdAt' | 'expiresAt'>): Promise<VerifiedApprovalReceipt>
}

export interface HostAttestationReceipt {
  schemaVersion: 2
  receiptId: string
  authority: string
  keyId: string
  installationId: string
  planId: string
  planDigest: string
  activationId: string
  fence: number
  operationId: string
  requestDigest: string
  phase: HostAttestationPhase
  outcome: 'passed' | 'failed'
  hostGeneration: number
  evidence: HostAttestationEvidence
  evidenceDigest: string
  observedAt: number
  expiresAt: number
  signature: string
}

export interface VerifiedHostAttestation extends Omit<HostAttestationReceipt, 'signature'> {
  signatureDigest: string
}

export interface HostAttestationAuthority {
  verify(receipt: HostAttestationReceipt, plan: PluginActivationPlan, request: HostAttestationRequest): Promise<VerifiedHostAttestation>
}

export interface HostAttestationOperation {
  planId: string
  phase: HostAttestationPhase
  operationId: string
  bindingDigest: string
  requestDigest: string
  request: HostAttestationRequest
  status: 'pending' | 'completed' | 'applied'
  receipt?: HostAttestationReceipt
  createdAt: number
  completedAt?: number
  appliedAt?: number
}

export interface OperationReceipt<T> {
  idempotencyKey: string
  operation: string
  inputDigest: string
  result: T
  createdAt: number
}

export interface PluginControlPlaneHealth {
  gaps: number
  readyPlans: number
  activeActivations: number
  failed: number
  rollbackPending: number
}
