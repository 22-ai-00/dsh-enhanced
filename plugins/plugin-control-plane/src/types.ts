import type { CatalogEntry, CatalogPackage } from './catalog.js'
import type { LiveQualificationTerms } from './live-qualification.js'
import type { AdoptionHandoffTerms } from './adoption-handoff.js'

export type PlanStatus =
  | 'pending-approval'
  | 'approved'
  | 'staging'
  | 'awaiting-reload'
  | 'awaiting-readiness'
  | 'awaiting-live-tasks'
  | 'awaiting-effect-blocked-replay'
  | 'awaiting-shadow'
  | 'awaiting-canary'
  | 'awaiting-soak'
  | 'awaiting-health'
  | 'commit-pending'
  | 'rollback-pending'
  | 'activated'
  | 'rolled-back'

export type HostAttestationPhase = 'reload' | 'readiness' | 'effect-blocked-replay' | 'shadow' | 'canary' | 'soak' | 'health' | 'rollback'

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
  | { kind: 'rollback'; previousHostGeneration: number; action: 'restore' | 'stop'; baselineFiles: readonly { path: string; sha256: string | null }[]; minimumChecks: number }

export interface HostAttestationRequest {
  schemaVersion: 2
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
  /** Immutable, durable receipt binding for the Host generation this phase observes. */
  predecessor: null | {
    operationId: string
    receiptId: string
    phase: HostAttestationPhase
    /** SHA-256 of the complete signed receipt persisted by the prior operation. */
    receiptDigest: string
    hostGeneration: number
  }
}

/** Schema-v1 records are retained for read-only provenance and reconciliation. */
export interface LegacyHostAttestationRequest extends Omit<HostAttestationRequest, 'schemaVersion' | 'predecessor'> {
  schemaVersion: 1
}

export type StoredHostAttestationRequest = HostAttestationRequest | LegacyHostAttestationRequest

export type HostAttestationEvidence =
  | { kind: 'reload'; reloaded: boolean; previousHostGeneration: number; currentHostGeneration: number; probeDigest: string }
  | { kind: 'readiness'; checks: number; failures: number; probeDigest: string }
  | { kind: 'effect-blocked-replay'; deliveryAttempts: number; deliveryBlocked: number; toolExecutionAttempts: number; toolExecutionBlocked: number; externalEffects: number; replayDigest: string }
  | { kind: 'shadow'; samples: number; mismatches: number; externalEffects: number; traceDigest: string }
  | { kind: 'canary'; exposureId: string; exposures: number; samples: number; failures: number; traceDigest: string }
  | { kind: 'soak'; windowStartedAt: number; windowEndedAt: number; samples: number; failures: number; traceDigest: string }
  | { kind: 'health'; checks: number; failures: number; probeDigest: string }
  | { kind: 'rollback'; action: 'restore' | 'stop'; previousHostGeneration: number; currentHostGeneration: number; checks: number; failures: number; profileRestored: boolean; probeDigest: string }

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
    packages: readonly CatalogPackage[]
    handoff?: AdoptionHandoffTerms
    liveQualification?: LiveQualificationTerms
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
    /** Exact core profile files captured before staging; absent files use null. */
    targetBaselineFiles?: readonly { path: string; sha256: string | null }[]
    /** Once a Host-visible profile was installed, signed physical recovery is required. */
    hostRecoveryRequired?: boolean
    /** Durable filesystem restore marker. It never itself completes Host recovery. */
    rollbackProfileRestored?: boolean
    failureCode?: string
    updatedAt: number
  }
}

export type SourceReleasePhase = 'pr' | 'review' | 'merge' | 'build' | 'sign' | 'publish' | 'registry-verify' | 'catalog-admission'

export type SourcePlanStatus =
  | 'expired'
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
  /**
   * 'create' scaffolds a brand-new plugin after approval (the legacy flow);
   * 'modify' prepares a bounded patch for an *existing* plugin before approval,
   * carrying its frozen-build evidence while still pending. Modify bindings
   * include mode, checked digests, and evidence in the immutable plan digest;
   * legacy create-plan digests retain their existing shape.
   */
  mode: 'create' | 'modify'
  scope: readonly string[]
  approval?: VerifiedApprovalReceipt
  sourceCheck?: SourceCheckEvidence
  /** Present only for 'modify' plans: frozen, offline, ignore-scripts build evidence captured at pending time. */
  preparedEvidence?: SourcePreparedEvidence
  releaseAuthorization?: VerifiedSourceReleaseAuthorization
  release?: {
    id: string
    fence: number
    failurePhase?: SourceReleasePhase
    failureCode?: string
    updatedAt: number
  }
}

/** Exact source bytes that completed the local post-generation check gate. */
export interface SourceCheckEvidence {
  treeDigest: string
  patchDigest: string
  checkedAt: number
}

/**
 * Content-free evidence that a 'modify' patch was produced and validated inside
 * an isolated worktree under a frozen, offline, ignore-scripts build, captured
 * while the plan is still pending owner approval. It never embeds source,
 * logs or secrets: command output is reduced to a bounded-tail sha256 digest.
 */
export interface SourcePreparedEvidence {
  schemaVersion: 1
  kind: 'dsh-source-prepared-evidence'
  environment: {
    npmConfigIgnoreScripts: true
    frozenLockfile: true
    offline: boolean
    nodeVersion: string
    pnpmVersion: string
  }
  commands: readonly {
    command: string
    args: readonly string[]
    exitCode: 0
    durationMs: number
    /** sha256 over the bounded captured tail of stdout/stderr. */
    logDigest: string
  }[]
  pack: {
    name: string
    version: string
    sizeBytes: number
    sha256: string
  }
  preparedAt: number
}

export interface SourceReleasePolicy {
  targetBranch: string
  candidateId: string
  packageName: string
  packageVersion: string
  packagePath: string
  dshBaseline: string
  capabilities: readonly string[]
  authorities: readonly string[]
  requires: readonly { package: string; version: string; integrity: string }[]
  registryId: string
  registryLocator: string
  registryReference: string
  catalogId: string
  catalogPath: string
  minimumReproducibleBuilds: number
}

/**
 * A fresh owner decision made after local checks. It deliberately cannot be
 * substituted with the approval that authorized source generation.
 */
export interface SourceReleaseAuthorization {
  schemaVersion: 1
  kind: 'dsh-source-release-authorization'
  authorizationId: string
  authority: string
  keyId: string
  planId: string
  planDigest: string
  baseCommit: string
  checkedTreeDigest: string
  checkedPatchDigest: string
  scope: readonly string[]
  releasePolicy: SourceReleasePolicy
  authorizedAt: number
  expiresAt: number
  signature: string
}

export interface VerifiedSourceReleaseAuthorization extends SourceReleaseAuthorization {
  signatureDigest: string
}

export interface SourceReleaseAuthorizationAuthority {
  verify(authorization: SourceReleaseAuthorization, plan: PluginSourcePlan): Promise<VerifiedSourceReleaseAuthorization>
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
  candidateId: string
  sourceName: string
  packagePath: string
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
  attempt: number
  requestedAt: number
  receiptTtlMs: number
  installationId: string
  ledger: { id: string; path: string }
  plan: { id: string; digest: string; revision: number }
  release: { id: string; fence: number }
  authorization: VerifiedSourceReleaseAuthorization
  adapter: SourceReleaseAdapterIdentity
  registry: { id: string; locator: string }
  catalog: { id: string; path: string }
}

export type SourceReleaseRequest = SourceReleaseRequestBase & (
  | { phase: 'pr'; input: { repository: string; worktree: string; baseCommit: string; name: string; scope: readonly string[];
    expectedTreeDigest: string; expectedPatchDigest: string } }
  | { phase: 'review'; input: { prId: string; headCommit: string; baseCommit: string; prEvidenceDigest: string } }
  | { phase: 'merge'; input: { prId: string; headCommit: string; reviewId: string; reviewEvidenceDigest: string; targetBranch: string } }
  | { phase: 'build'; input: { repository: string; mergeCommit: string; mergeEvidenceDigest: string; name: string;
    expectedCandidateId: string; expectedPackageName: string; expectedPackageVersion: string; expectedPackagePath: string;
    expectedDshBaseline: string; expectedCapabilities: readonly string[]; expectedAuthorities: readonly string[];
    expectedRequires: readonly { package: string; version: string; integrity: string }[] } }
  | { phase: 'sign'; input: { artifact: SourceReleaseArtifact; buildEvidenceDigest: string } }
  | { phase: 'publish'; input: { artifact: SourceReleaseArtifact; artifactStatementDigest: string; artifactSignature: string; signEvidenceDigest: string } }
  | { phase: 'registry-verify'; input: { artifact: SourceReleaseArtifact; artifactStatementDigest: string; artifactSignature: string;
    registryReference: string; publishEvidenceDigest: string } }
  | { phase: 'catalog-admission'; input: { artifact: SourceReleaseArtifact; artifactStatementDigest: string; artifactSignature: string;
    registryReference: string; registryVerificationRequest: Extract<SourceReleaseRequest, { phase: 'registry-verify' }>;
    registryVerificationReceipt: SourceReleaseReceipt; verificationEvidenceDigest: string; expectedBeforeCatalogDigest: string;
    expectedAfterCatalogDigest: string; candidate: CatalogEntry } }
)

export type SourceReleaseSuccessEvidence =
  | { kind: 'pr'; prId: string; baseCommit: string; headCommit: string; treeDigest: string; patchDigest: string; repositoryDigest: string }
  | { kind: 'review'; prId: string; headCommit: string; reviewId: string; decision: 'approved'; reviewerPrincipalDigest: string; prEvidenceDigest: string }
  | { kind: 'merge'; prId: string; reviewedHeadCommit: string; reviewId: string; reviewEvidenceDigest: string; mergeCommit: string; targetBranch: string }
  | ({ kind: 'build'; isolated: true; reproducibleBuilds: number; firstBuildSha256: string; secondBuildSha256: string; mergeEvidenceDigest: string } & SourceReleaseArtifact)
  | { kind: 'sign'; artifactStatementDigest: string; artifactSignature: string; artifactSignatureDigest: string; buildEvidenceDigest: string }
  | { kind: 'publish'; registryId: string; registryReference: string; packageName: string; packageVersion: string;
    tarballSha256: string; tarballIntegrity: string; artifactStatementDigest: string; artifactSignatureDigest: string; signEvidenceDigest: string; immutable: true }
  | { kind: 'registry-verify'; registryId: string; registryReference: string; independentlyDownloaded: true;
    downloadedBytes: number; downloadedSha256: string; downloadedIntegrity: string; artifactStatementDigest: string;
    artifactSignatureDigest: string; publishEvidenceDigest: string }
  | { kind: 'catalog-admission'; admissionId: string; catalogId: string; beforeCatalogDigest: string; afterCatalogDigest: string;
    registryReference: string; artifactStatementDigest: string; artifactSignatureDigest: string; verificationEvidenceDigest: string; candidate: CatalogEntry }

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

export interface SourcePublishReconciliationRequest {
  schemaVersion: 1
  kind: 'dsh-source-publish-reconciliation-request'
  operationId: string
  attempt: number
  requestedAt: number
  receiptTtlMs: number
  installationId: string
  ledger: { id: string; path: string }
  plan: { id: string; digest: string; revision: number }
  release: { id: string; fence: number }
  authorization: VerifiedSourceReleaseAuthorization
  adapter: SourceReleaseAdapterIdentity
  registry: { id: string; locator: string }
  ambiguousPublish: { operationId: string; receiptId: string; receiptDigest: string; evidenceDigest: string }
  artifact: { packageName: string; packageVersion: string; tarballSha256: string; tarballIntegrity: string }
  expectedArtifactStatementDigest: string
  expectedArtifactSignatureDigest: string
  expectedRegistryReference: string
}

/** The original adapter-defined reconciliation evidence wire format. */
export interface SourcePublishReconciliationEvidenceV1 {
  kind: 'publish-reconciliation'
  outcome: 'exists-match' | 'absent' | 'unknown' | 'digest-conflict'
  registryId: string
  registryReference: string | null
  packageName: string
  packageVersion: string
  expectedTarballSha256: string
  expectedTarballIntegrity: string
  expectedArtifactStatementDigest: string
  expectedArtifactSignatureDigest: string
  observedTarballSha256: string | null
  observedTarballIntegrity: string | null
  observedArtifactStatementDigest: string | null
  observedArtifactSignatureDigest: string | null
  ambiguousPublishOperationId: string
  ambiguousPublishReceiptDigest: string
  detailDigest: string
}

/** Independently observed npm registry metadata and tarball evidence. */
export interface SourceNpmPublishReconciliationEvidence {
  kind: 'npm-publish-reconciliation'
  outcome: 'exists-match' | 'unknown' | 'digest-conflict'
  registryId: string
  registryReference: string | null
  packageName: string
  packageVersion: string
  expectedTarballSha256: string
  expectedTarballIntegrity: string
  expectedArtifactStatementDigest: string
  expectedArtifactSignatureDigest: string
  observedTarballSha256: string | null
  observedTarballIntegrity: string | null
  ambiguousPublishOperationId: string
  ambiguousPublishReceiptDigest: string
  detailDigest: string
  metadataReference: string | null
  metadataIntegrity: string | null
  downloadedBytes: number | null
}

export type SourcePublishReconciliationEvidence = SourcePublishReconciliationEvidenceV1 | SourceNpmPublishReconciliationEvidence

export interface SourcePublishReconciliationReceiptV1 {
  schemaVersion: 1
  kind: 'dsh-source-publish-reconciliation-receipt'
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
  evidence: SourcePublishReconciliationEvidenceV1
  evidenceDigest: string
  observedAt: number
  expiresAt: number
  signature: string
}

export interface SourceNpmPublishReconciliationReceipt {
  schemaVersion: 2
  kind: 'dsh-source-publish-reconciliation-receipt'
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
  evidence: SourceNpmPublishReconciliationEvidence
  evidenceDigest: string
  observedAt: number
  expiresAt: number
  signature: string
}

/**
 * Compatibility surface for callers which constructed the original receipt as
 * an object before selecting a schema. Parsers enforce the schema/evidence
 * pairing; use the named V1/V2 receipt types when narrowing is useful.
 */
export interface SourcePublishReconciliationReceipt {
  schemaVersion: 1 | 2
  kind: 'dsh-source-publish-reconciliation-receipt'
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
  evidence: SourcePublishReconciliationEvidence
  evidenceDigest: string
  observedAt: number
  expiresAt: number
  signature: string
}

export type VerifiedSourcePublishReconciliationReceipt = Omit<SourcePublishReconciliationReceipt, 'signature'> & {
  signatureDigest: string
}

export interface SourcePublishReconciliationAuthority {
  verify(receipt: SourcePublishReconciliationReceipt, plan: PluginSourcePlan,
    request: SourcePublishReconciliationRequest): Promise<VerifiedSourcePublishReconciliationReceipt>
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
  attempt: number
  fence: number
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
  /** v1 is readable historical provenance only; dispatch and apply require v2. */
  request: StoredHostAttestationRequest
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

/**
 * Exact post-activation target a watch is pinned to. `integrity` is the
 * owner-provided immutable package integrity from the admitted catalog; a watch
 * never silently follows a package that was re-published under the same version.
 */
export interface WatchExactTarget {
  package: string
  version: string
  integrity: string
}

/** Post-activation Host health probe. Unlike pipeline phases it has no exit gate. */
export interface PostActivationHealthEvidence {
  kind: 'post-activation-health'
  checks: number
  failures: number
  probeDigest: string
}

/**
 * Signed post-activation observation emitted by the deployment-owned Host
 * authority. `regressed` is independent failure evidence; `healthy` is positive
 * evidence that must never close a watch on its own.
 */
export interface PostActivationObservationReceipt {
  schemaVersion: 1
  observationId: string
  authority: string
  keyId: string
  installationId: string
  planId: string
  planDigest: string
  activationId: string
  fence: number
  package: string
  version: string
  integrity: string
  disposition: 'regressed' | 'healthy'
  evidence: PostActivationHealthEvidence
  evidenceDigest: string
  hostGeneration: number
  observedAt: number
  expiresAt: number
  signature: string
}

export interface VerifiedPostActivationObservation extends Omit<PostActivationObservationReceipt, 'signature'> {
  signatureDigest: string
}

export interface PostActivationObservationAuthority {
  verify(receipt: PostActivationObservationReceipt, plan: PluginActivationPlan, exact: WatchExactTarget):
    Promise<VerifiedPostActivationObservation>
}

/**
 * Owner-authoritative withdrawal of a previously activated exact version. It is
 * signed by an approval root (kept independent of the Host roots by trust config)
 * and is the only evidence that drives a `retracted` closure.
 */
export interface ActivationRetractionReceipt {
  schemaVersion: 1
  retractionId: string
  authority: string
  keyId: string
  installationId: string
  planId: string
  planDigest: string
  activationId: string
  fence: number
  package: string
  version: string
  integrity: string
  principal: string
  reason: string
  decidedAt: number
  expiresAt: number
  signature: string
}

export interface VerifiedActivationRetraction extends Omit<ActivationRetractionReceipt, 'signature'> {
  signatureDigest: string
}

export interface ActivationRetractionAuthority {
  verify(receipt: ActivationRetractionReceipt, plan: PluginActivationPlan, exact: WatchExactTarget):
    Promise<VerifiedActivationRetraction>
}

export type ActivationWatchState = 'watching' | 'closed-regressed' | 'closed-retracted'

export interface ActivationWatch {
  planId: string
  exact: WatchExactTarget
  activationId: string
  fence: number
  state: ActivationWatchState
  revision: number
  startedAt: number
  updatedAt: number
  /** Highest Host generation acknowledged by an applied observation. */
  lastHostGeneration: number
  /** Count of applied positive (`healthy`) observations; they never close a watch. */
  healthyObservations: number
  close?: {
    disposition: 'regressed' | 'retracted'
    at: number
    evidenceId: string
    signatureDigest: string
  }
}

/** One append-only signed post-activation observation read back from the ledger. */
export interface ActivationWatchEvidenceRecord {
  observationId: string
  planId: string
  disposition: 'regressed' | 'healthy' | 'retracted'
  receiptDigest: string
  signatureDigest: string
  hostGeneration: number
  failures: number
  checks: number
  createdAt: number
}

export interface PluginControlPlaneHealth {
  gaps: number
  readyPlans: number
  activeActivations: number
  failed: number
  rollbackPending: number
  watchingActivations: number
  closedRegressed: number
  closedRetracted: number
}
