export const ASSISTANT_GROWTH_CONTRACT_VERSION = 1 as const
export const WORKFLOW_TRACE_SOURCE_ID = 'assistantDelivery' as const
export const WORKFLOW_TRACE_PROTOCOL = 'assistant-growth-workflow-trace/v1' as const
export const WORKFLOW_ARGUMENT_SHAPE_PROTOCOL = 'assistant-growth-argument-shape/v1' as const
export const WORKFLOW_TEMPLATE_PROTOCOL = 'assistant-growth-template/v1' as const
export const GROWTH_AUTOMATION_OPERATION_PROTOCOL = 'assistant-growth-automation-operation/v1' as const
export const GROWTH_AUTOMATION_RECEIPT_PROTOCOL = 'assistant-growth-automation-receipt/v1' as const
export const GROWTH_EFFECT_BLOCKER_PROTOCOL = 'assistant-automations-effect-blocker/v1' as const
/** Delivery's built-in model-turn orchestration step; it is not a DSH tool schema. */
export const WORKFLOW_MODEL_TURN_CATALOG_ID = 'assistant.agent-turn' as const

export interface WorkflowScope {
  workspace: string
  preset: string
}

export interface WorkflowStepFingerprint {
  /** Fixed Host action/tool catalog id; never a raw command or argument. */
  catalogId: string
  /** SHA-256 of the redacted JSON argument shape, never argument values. */
  argumentSchemaDigest: string
}

/**
 * A shape-checked claim is not proof by itself. Delivery must resolve
 * `attestationId` to its private immutable review ledger before materializing
 * the template or emitting a trace.
 */
export type WorkflowTemplatePrivacyAttestation =
  | Readonly<{
      kind: 'deterministic-deidentification'
      method: 'assistant-delivery-redaction-v1'
      attestationId: string
      attestationDigest: string
    }>
  | Readonly<{
      kind: 'owner-explicit'
      limitation: 'deidentification-unproven'
      attestationId: string
      attestationDigest: string
    }>

/** Content-free wire reference. The reusable prompt never crosses Growth. */
export interface WorkflowAutomationTemplate {
  templateRef: string
  templateDigest: string
  privacyAttestation: WorkflowTemplatePrivacyAttestation
}

/** Private Delivery-owned template content resolved only at the Host boundary. */
export interface WorkflowAutomationTemplateContent {
  scope: Readonly<WorkflowScope>
  ownerBindingId: string
  /** Canonical external owner principal, derived by Delivery from the live binding. */
  principalId: string
  name: string
  prompt: string
  schedule: Readonly<{
    kind: 'cron'
    expression: string
    timezone: string
  }>
  timeoutMs: number
  toolCatalogIds: readonly string[]
  deliveryBindingId: string
}

/** Exact private materialization returned by Delivery to Automations. */
export interface ResolvedWorkflowAutomationTemplate extends WorkflowAutomationTemplateContent {
  contractVersion: 1
  template: Readonly<WorkflowAutomationTemplate>
}

export interface WorkflowTemplateResolver {
  resolveWorkflowAutomationTemplate(input: Readonly<{
    contractVersion: 1
    template: Readonly<WorkflowAutomationTemplate>
    scope: Readonly<WorkflowScope>
    ownerBindingId: string
  }>): Readonly<ResolvedWorkflowAutomationTemplate>
}

export interface WorkflowTraceEvidence {
  occurredAt: number
  signal: 'owner-explicit' | 'verified-repetition'
  objectiveStatus: 'achieved' | 'unknown'
  ownerBindingId: string
  /** Stable privacy-preserving task identity produced by Delivery. */
  taskRef: string
  /** Exact trusted task-projection digest, required for verified repetition. */
  taskEvidenceDigest?: string
  template: Readonly<WorkflowAutomationTemplate>
  steps: readonly Readonly<WorkflowStepFingerprint>[]
}

export interface WorkflowTraceSourceAttestation {
  sourceId: 'assistantDelivery'
  generation: number
  authorityDigest: string
}

export interface WorkflowTraceRevision {
  source: Readonly<WorkflowTraceSourceAttestation>
  scope: Readonly<WorkflowScope>
  subjectRef: string
  version: number
  disposition: 'upsert' | 'retract'
  digest: string
  evidence?: Readonly<WorkflowTraceEvidence>
}

export interface WorkflowTraceProjectionReceipt {
  contractVersion: 1
  source: Readonly<WorkflowTraceSourceAttestation>
  scope: Readonly<WorkflowScope>
  subjectRef: string
  version: number
  disposition: 'upsert' | 'retract'
  digest: string
  outcome: 'applied' | 'replayed'
  candidateIds: readonly string[]
}

export interface WorkflowTraceSink {
  projectWorkflowTraceRevision(input: Readonly<WorkflowTraceRevision>): WorkflowTraceProjectionReceipt
}

export interface GrowthWorkflowTraceSourceRegistration extends WorkflowTraceSourceAttestation {
  contractVersion: 1
  dispose(): void
}

/** Delivery-owned source; `sink` is a private in-process capability. */
export interface GrowthWorkflowTraceSourcePort {
  registerWorkflowTraceSink(input: Readonly<{
    contractVersion: 1
    sink: WorkflowTraceSink
  }>): GrowthWorkflowTraceSourceRegistration
}

export interface GrowthExperimentIdentity {
  contractVersion: 1
  operationId: string
  experimentId: string
  candidateId: string
  candidateRevision: number
  candidateDigest: string
}

export interface GrowthArtifactIdentity {
  artifactId: string
  artifactVersion: number
  artifactDigest: string
}

export interface GrowthAutomationProposalRequest extends GrowthExperimentIdentity {
  /** The port must atomically create this artifact paused, never active. */
  initialState: 'paused'
  scope: Readonly<WorkflowScope>
  ownerBindingId: string
  evidenceDigest: string
  evidenceCount: number
  template: Readonly<WorkflowAutomationTemplate>
  steps: readonly Readonly<WorkflowStepFingerprint>[]
  deadlineAt: number
}

export type GrowthAutomationProposalReceipt = GrowthExperimentIdentity & {
  receiptDigest: string
} & (
  | { outcome: 'approval-pending'; proposalId: string }
  | ({ outcome: 'approved-paused'; proposalId: string } & GrowthArtifactIdentity)
  | { outcome: 'conflicted' | 'expired' | 'rejected'; proposalId?: string }
)

export interface GrowthAutomationApprovalRequest extends GrowthExperimentIdentity {
  proposalId: string
}

export type GrowthAutomationApprovalReceipt = GrowthAutomationProposalReceipt

export interface GrowthAutomationArtifactRequest extends GrowthExperimentIdentity, GrowthArtifactIdentity {}

export type GrowthReplayReceipt = GrowthExperimentIdentity & GrowthArtifactIdentity & {
  outcome: 'failed' | 'passed'
  replayDigest: string
  receiptDigest: string
}

export type GrowthShadowReceipt = GrowthExperimentIdentity & GrowthArtifactIdentity & {
  outcome: 'failed' | 'passed'
  effectsBlocked: true
  effectBlockerAttestation: Readonly<{
    contract: 'assistant-automations-effect-blocker/v1'
    blockedEffects: readonly ['delivery', 'tool-execution']
    implementationDigest: string
  }>
  shadowDigest: string
  receiptDigest: string
}

export type GrowthCanaryReceipt = GrowthExperimentIdentity & GrowthArtifactIdentity & {
  outcome: 'failed' | 'passed' | 'pending'
  exposureCount: 1
  exposureOperationId: string
  evaluationDigest?: string
  evaluationTrust?: 'trusted'
  objectiveStatus?: 'achieved'
  receiptDigest: string
}

export interface GrowthCanaryInspectionRequest extends GrowthAutomationArtifactRequest {
  exposureOperationId: string
}

export type GrowthCanaryInspectionReceipt = GrowthCanaryReceipt

export type GrowthPromotionReceipt = GrowthExperimentIdentity & GrowthArtifactIdentity & {
  outcome: 'promoted'
  resultingArtifactVersion: number
  resultingArtifactDigest: string
  receiptDigest: string
}

export type GrowthRollbackReceipt = GrowthExperimentIdentity & GrowthArtifactIdentity & {
  outcome: 'rolled-back'
  receiptDigest: string
}

/**
 * Host-only idempotent Automation boundary. Every operation must durably replay
 * the same receipt for the same operationId and reject a changed payload.
 */
export interface GrowthAutomationPort {
  requestWorkflowAutomation(input: Readonly<GrowthAutomationProposalRequest>): GrowthAutomationProposalReceipt
    | Promise<GrowthAutomationProposalReceipt>
  settleWorkflowAutomation(input: Readonly<GrowthAutomationApprovalRequest>): GrowthAutomationApprovalReceipt
    | Promise<GrowthAutomationApprovalReceipt>
  replayWorkflowAutomation(input: Readonly<GrowthAutomationArtifactRequest>): GrowthReplayReceipt
    | Promise<GrowthReplayReceipt>
  shadowWorkflowAutomation(input: Readonly<GrowthAutomationArtifactRequest>): GrowthShadowReceipt
    | Promise<GrowthShadowReceipt>
  canaryWorkflowAutomation(input: Readonly<GrowthAutomationArtifactRequest>): GrowthCanaryReceipt
    | Promise<GrowthCanaryReceipt>
  inspectWorkflowCanary(input: Readonly<GrowthCanaryInspectionRequest>): GrowthCanaryInspectionReceipt
    | Promise<GrowthCanaryInspectionReceipt>
  promoteWorkflowAutomation(input: Readonly<GrowthAutomationArtifactRequest>): GrowthPromotionReceipt
    | Promise<GrowthPromotionReceipt>
  rollbackWorkflowAutomation(input: Readonly<GrowthAutomationArtifactRequest>): GrowthRollbackReceipt
    | Promise<GrowthRollbackReceipt>
}
