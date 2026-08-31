import type { AutomationSchedule } from './schedule.js'
import type { ApprovalDispatchRoute } from '@dsh-enhanced/assistant-policy'

export type MisfirePolicy =
  | { kind: 'skip' }
  | { kind: 'latest' }
  | { kind: 'bounded-replay'; limit: number }

export type OverlapPolicy = 'cancel-previous' | 'queue-one' | 'skip'
export type RetrySafety = 'idempotent' | 'never'
export type AutomationStatus = 'active' | 'deleted' | 'paused'

export interface AutomationDefinitionControl {
  name: string
  schedule: AutomationSchedule
  workspace: string
  agentPreset: string
  timeoutMs: number
  misfire: MisfirePolicy
  overlap: OverlapPolicy
  retrySafety: RetrySafety
  maxRetries: number
  principal: string
  budgetId?: string
  budgetAmount?: number
}

/** Legacy model-backed execution surface. Its serialized bytes remain stable. */
export interface AgentAutomationDefinition extends AutomationDefinitionControl {
  execution?: never
  prompt: string
  provider: string
  model: string
  allowedTools: readonly string[]
  maxOutputTokens: number
  maxToolCalls: number
  /**
   * Optional approval-only route for background Agents. This is never an
   * ordinary result sink; legacy definitions fall back to deliveryBindingId.
   */
  approvalBindingId?: string
  deliveryBindingId?: string
  deliverySuppressExact?: readonly string[]
}

export interface HostAutomationTargetScope {
  workspace: string
  preset: string
}

/**
 * Immutable, content-free binding to one Host executor contract. The scope
 * digest is recomputed by normalization from canonical `[workspace, preset]`.
 */
export interface HostAutomationExecutionSpec {
  kind: 'host'
  executorId: string
  executorContractVersion: number
  runbookId: string
  runbookVersion: number
  catalogDigest: string
  targetScope: HostAutomationTargetScope
  scopeDigest: string
  ownerRouteId: string
  /** Non-bearer audit nonce used to reject replay of stale activation plans. */
  activationNonce: string
}

/** Host executions cannot expose model/prompt/tool or ordinary output sinks. */
export interface HostAutomationDefinition extends AutomationDefinitionControl {
  execution: HostAutomationExecutionSpec
  prompt?: never
  provider?: never
  model?: never
  allowedTools?: never
  maxOutputTokens?: never
  maxToolCalls?: never
  approvalBindingId?: never
  deliveryBindingId?: never
  deliverySuppressExact?: never
}

export type AutomationDefinition = AgentAutomationDefinition | HostAutomationDefinition

export function isHostAutomationDefinition(
  definition: AutomationDefinition,
): definition is HostAutomationDefinition {
  return 'execution' in definition && definition.execution?.kind === 'host'
}

export interface AutomationRecord {
  id: string
  owner?: string
  definition: AutomationDefinition
  status: AutomationStatus
  nextRunAt: number | undefined
  createdAt: number
  updatedAt: number
  version: number
}

export type OccurrenceTriggerKind = 'external' | 'manual' | 'scheduled'
export type OccurrenceStatus =
  | 'cancelled'
  | 'failed'
  | 'pending'
  | 'skipped'
  | 'succeeded'
  | 'timed_out'
  | 'unknown'

export interface AutomationOccurrence {
  id: string
  automationId: string
  triggerKind: OccurrenceTriggerKind
  triggerKey: string
  scheduledAt: number
  status: OccurrenceStatus
  reason?: string
  dryRun: boolean
  createdAt: number
  updatedAt: number
}

export type AutomationTaskStatus =
  | 'cancelled'
  | 'claimed'
  | 'failed'
  | 'lost'
  | 'running'
  | 'scheduled'
  | 'succeeded'
  | 'timed_out'
  | 'unknown'

export interface AutomationTask {
  id: string
  occurrenceId: string
  automationId: string
  status: AutomationTaskStatus
  cancelRequested: boolean
  claimedBy?: string
  fencingToken?: number
  leaseUntil?: number
  attemptCount: number
  createdAt: number
  updatedAt: number
}

export interface DutyLease {
  acquired: boolean
  ownerId: string
  fencingToken: number
  leaseUntil: number
}

export type AutomationRunStatus = 'cancelled' | 'failed' | 'succeeded' | 'timed_out' | 'unknown'
/**
 * Host-derived occurrence mode. `dryRun` remains on the public occurrence for
 * compatibility; sinks must authorize only `production`.
 */
export type AutomationExecutionMode = 'preview' | 'production'
/**
 * Agent-scoped, Host-derived execution context. Consumers may use this only to
 * reduce behaviour (for example, suppress learning exposure in preview); it is
 * not an authority grant and is never supplied by the model or preset.
 */
export interface AutomationExecutionContext {
  mode: AutomationExecutionMode
  automationId: string
  occurrenceId: string
}

/**
 * A bounded, machine-readable account of how far one execution crossed the
 * unattended boundary.  This is operational telemetry, never a quality score.
 * Old/custom runners that do not produce it are persisted as `unknown` rather
 * than inferred from an exception message.
 */
export type AutomationFailureClass =
  | 'none'
  | 'budget'
  | 'cancelled'
  | 'configuration'
  | 'execution'
  | 'infrastructure'
  | 'policy'
  | 'provider'
  | 'timeout'
  | 'unknown'

export type AutomationFailurePhase =
  | 'none'
  | 'artifact-write'
  | 'agent-creation'
  | 'agent-disposal'
  | 'agent-setup'
  | 'budget-reservation'
  | 'budget-settlement'
  | 'model-execution'
  | 'executor-availability'
  | 'host-execution'
  | 'preflight'
  | 'preset-resolution'
  | 'prompt-submission'
  | 'recovery'
  | 'session-flush'
  | 'terminal-commit'
  | 'unknown'

export type AutomationPromptSubmissionState = 'not-applicable' | 'not-submitted' | 'submitted' | 'unknown'
export type AutomationSideEffectState = 'none' | 'possible' | 'unknown'
export type AutomationRetryability = 'safe' | 'unsafe' | 'after-intervention' | 'unknown'
export type AutomationBudgetSettlementState =
  | 'not-required'
  | 'not-reserved'
  | 'reserved'
  | 'released'
  | 'finalized'
  | 'unknown'

export interface AutomationExecutionDiagnostic {
  schemaVersion: 1
  failureClass: AutomationFailureClass
  failurePhase: AutomationFailurePhase
  /** Stable category only. Exception text must never be placed here. */
  failureCode: string
  promptSubmissionState: AutomationPromptSubmissionState
  sideEffectState: AutomationSideEffectState
  retryability: AutomationRetryability
  /** Keeps the existing fixed `automation-runs` accounting semantics observable. */
  budgetSettlementState: AutomationBudgetSettlementState
}

export interface HostAutomationExecutorDescriptor {
  executorId: string
  contractVersion: number
  catalogDigest: string
}

/** Structurally matches the Recovery v2 executor input. */
export interface HostAutomationExecutorInput {
  occurrenceId: string
  automationId: string
  definitionHash: string
  executionMode: AutomationExecutionMode
  targetScope: HostAutomationTargetScope
  principal: string
  ownerRouteId: string
  activationNonce: string
  catalogDigest: string
  signal: AbortSignal
}

export interface HostAutomationExecutorResult {
  outcome: Extract<AutomationRunStatus, 'failed' | 'succeeded' | 'unknown'>
  failureClass: AutomationFailureClass
  failurePhase: AutomationFailurePhase
  /** Stable low-cardinality code only. */
  failureCode: string
  sideEffectState: AutomationSideEffectState
  retryability: AutomationRetryability
}

export interface HostAutomationExecutor {
  readonly descriptor: HostAutomationExecutorDescriptor
  /** Pure capability check. Claiming an unrelated spec is treated as a conflict. */
  accepts(spec: HostAutomationExecutionSpec): boolean
  execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult>
}

export type HostExecutorAvailabilityStage = 'claim' | 'materialize'

export type HostExecutorAvailabilityDecision = Readonly<{
  automationId: string
  definitionHash: string
  stage: HostExecutorAvailabilityStage
  available: boolean
  reasonCode: string
}>

export type AutomationIncidentState = 'open' | 'recovering' | 'resolved'
export type AutomationIncidentAlertStatus = 'pending' | 'enqueued' | 'suppressed'
export type AutomationIncidentStage = HostExecutorAvailabilityStage | 'terminal'

export interface AutomationIncident {
  id: string
  automationId: string
  definitionHash: string
  stage: AutomationIncidentStage
  state: AutomationIncidentState
  failureClass: Exclude<AutomationFailureClass, 'none'>
  failurePhase: AutomationFailurePhase
  failureCode: string
  sideEffectState: AutomationSideEffectState
  retryability: AutomationRetryability
  notificationRouteId: string
  /** Reopen epoch. Each generation owns a different provider message. */
  lifecycleGeneration: number
  /** Monotonic desired-message revision, including transitions within and across generations. */
  presentationRevision: number
  alertStatus: AutomationIncidentAlertStatus
  alertRef?: string
  runId?: string
  openedAt: number
  updatedAt: number
  resolvedAt?: number
  version: number
}

/**
 * Exact, content-free Delivery target proven from the immutable definition
 * that opened an incident. Host jobs use a stable owner-route authority;
 * Agent jobs use their approval binding (or the legacy result binding).
 */
export type AutomationIncidentNotificationTarget =
  | Readonly<{
      kind: 'owner-route'
      authorityId: string
    }>
  | Readonly<{
      kind: 'binding'
      bindingId: string
      workspace: string
    }>

export interface HostExecutionRequirement {
  automationId: string
  definitionHash: string
  execution: HostAutomationExecutionSpec
}

export interface AutomationQualityEvidenceReceipt {
  schemaVersion: 1
  source: 'assistant-automations'
  executionKind: 'agent' | 'host'
  automationId: string
  runId: string
  definitionHash: string
  status: Extract<AutomationRunStatus, 'succeeded' | 'failed' | 'timed_out'>
  scope: { workspace: string; preset: string }
  situation: string
  occurredAt: number
  evidenceRef: { kind: 'automation-run'; ref: string }
  sessionId?: string
  ruleId?: string
  guidanceVersion?: number
  /** Non-secret digest for exact revalidation; never an authority capability. */
  proofDigest: string
}

/**
 * Content-minimal proof used by Delivery's dedicated Automation-result seam.
 * Delivery supplies the output digest and exact binding expectation; callers
 * never get to manufacture learning metadata for the outbound message.
 */
export interface AutomationDeliveryEvidenceReceipt {
  schemaVersion: 1
  source: 'assistant-automations'
  executionKind: 'agent'
  automationId: string
  runId: string
  occurrenceId: string
  workspace: string
  agentPreset: string
  bindingId: string
  situation: string
  occurredAt: number
  executionStatus: 'succeeded'
  outputDigest: string
  proofDigest: string
}

export const legacyAutomationExecutionDiagnostic = Object.freeze<AutomationExecutionDiagnostic>({
  schemaVersion: 1,
  failureClass: 'unknown',
  failurePhase: 'unknown',
  failureCode: 'legacy-runner-unclassified',
  promptSubmissionState: 'unknown',
  sideEffectState: 'unknown',
  retryability: 'unknown',
  budgetSettlementState: 'unknown',
})

export interface AutomationCircuit {
  automationId: string
  definitionHash: string
  state: 'closed' | 'half-open' | 'open' | 'probing'
  failureClass: Extract<AutomationFailureClass, 'budget' | 'configuration' | 'policy'>
  failurePhase: AutomationFailurePhase
  failureCode: string
  openedAt: number
  updatedAt: number
  /** Opaque Host-issued capability for one bounded half-open execution. */
  probeToken?: string
  probeLeaseUntil?: number
  probeTaskId?: string
  version: number
}

export interface AutomationCircuitProbeReceipt {
  operationId: string
  circuit: AutomationCircuit
  replayed: boolean
}

/**
 * Atomic Host repair receipt. The scheduled canary is always a production
 * manual task; no prompt, scope, principal, route, or probe capability is
 * exposed through this projection.
 */
export interface AutomationCircuitCanaryReceipt extends AutomationCircuitProbeReceipt {
  occurrenceId: string
  taskId: string
  executionMode: 'production'
}

export type AutomationCircuitExecutionDecision =
  | { kind: 'normal' }
  | { kind: 'blocked'; circuit: AutomationCircuit }
  | { kind: 'probe'; circuit: AutomationCircuit }

/**
 * Content-free Host projection for one exact system-owned automation. It
 * deliberately omits prompts, outputs, artifacts, sessions, usage, and probe
 * capabilities. Historical scope is present only when the immutable run
 * snapshot and stored run hash agree.
 */
export interface SystemOwnedAutomationTerminalRunProjection {
  runId: string
  status: AutomationRunStatus
  executionMode: AutomationExecutionMode
  diagnostic: AutomationExecutionDiagnostic
  createdAt: number
  immutableContext:
    | { state: 'unknown' }
    | {
        state: 'verified'
        definitionHash: string
        definitionVersion: number
        scope: { workspace: string; agentPreset: string }
      }
}

export interface SystemOwnedAutomationHealthProjection {
  owner: string
  automationId: string
  automationStatus: AutomationStatus
  definitionHash: string
  definitionVersion: number
  /** Compatibility alias for production only; preview can never shadow it. */
  latestTerminalRun?: SystemOwnedAutomationTerminalRunProjection
  latestTerminalRuns: {
    production?: SystemOwnedAutomationTerminalRunProjection
    preview?: SystemOwnedAutomationTerminalRunProjection
  }
  currentCircuit?: {
    definitionHash: string
    state: AutomationCircuit['state']
    failureClass: AutomationCircuit['failureClass']
    failurePhase: AutomationFailurePhase
    failureCode: string
    openedAt: number
    updatedAt: number
    probeLeaseUntil?: number
    version: number
  }
  currentIncident?: {
    definitionHash: string
    stage: AutomationIncidentStage
    failureClass: Exclude<AutomationFailureClass, 'none'>
    failurePhase: AutomationFailurePhase
    failureCode: string
    alertStatus: AutomationIncidentAlertStatus
    openedAt: number
    updatedAt: number
    version: number
  }
}

/** Bounded content-free identity used to reconcile a Host-owned fleet. */
export interface SystemOwnedAutomationIdentityProjection {
  owner: string
  automationId: string
  automationStatus: AutomationStatus
  definitionHash: string
  definitionVersion: number
}

/**
 * Durable content-free receipt for pausing one exact Host-owned definition.
 * The definition itself is immutable across this operation; only lifecycle
 * state, next-run materialization, and the row version change.
 */
export interface SystemOwnedAutomationPauseReceipt {
  operationId: string
  owner: string
  automationId: string
  definitionHash: string
  expectedVersion: number
  definitionVersion: number
  automationStatus: 'paused'
  replayed: boolean
}
export type AutomationDeliveryStatus = 'enqueued' | 'pending' | 'suppressed'
export type AutomationEvidenceStatus = 'pending' | 'recorded' | 'suppressed'
export type AutomationEvaluationStatus = 'pending' | 'recorded' | 'dead-letter'

/**
 * Frozen terminal observation written to the Evaluation outbox in the same
 * transaction as its Automation run.  This intentionally mirrors the public
 * assistant-evaluation append seam without importing that optional plugin.
 */
export interface AutomationEvaluationOutcome {
  /** Only a real production run may enter the trusted Evaluation capability. */
  executionMode: 'production'
  scope: { workspace: string; preset: string }
  situation: string
  executionStatus: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'unknown'
  /** Fixed Host runbooks can prove their own bounded objective; Agent runs cannot. */
  objectiveStatus: 'achieved' | 'not-achieved' | 'unknown'
  deliveryStatus: 'not-required' | 'unknown'
  source: { kind: 'automation'; id: 'assistant-automations' }
  trust: 'trusted'
  evidence: ReadonlyArray<{ kind: string; ref: string; digest?: string }>
  metrics: Readonly<Record<string, number>>
  occurredAt: number
  idempotencyKey: string
  evaluator: { id: 'assistant-automations'; version: 'host-runbook-v1' | 'terminal-v1' }
}

export interface AutomationEvaluationOutboxEntry {
  id: string
  runId: string
  kind: 'terminal'
  status: AutomationEvaluationStatus
  payload: AutomationEvaluationOutcome
  attemptCount: number
  nextAttemptAt: number
  lastFailureAt?: number
  /** Bounded machine-readable category only; never an exception message. */
  lastErrorCode?: string
  createdAt: number
  updatedAt: number
}

/**
 * Immutable evidence captured in the same transaction as a terminal run.
 *
 * The automation id is the stable learning situation. The human-editable name
 * appears only in `detail`, so renaming a schedule cannot split its history.
 */
export interface AutomationOutcomeEvidence {
  situation: string
  outcome: 'succeeded' | 'failed'
  detail: string
  idempotencyKey: string
  occurredAt: number
  workspace: string
  agentPreset: string
  automationId: string
  runId: string
  /** Present only when the runner confirmed the Agent session it created. */
  sessionId?: string
  /** Trusted infrastructure attribution read from a durable post-injection receipt. */
  ruleId?: string
  guidanceVersion?: number
}

export interface AutomationEvidenceAttribution {
  sessionId?: string
  ruleId?: string
  guidanceVersion?: number
}

export interface AutomationRun {
  id: string
  occurrenceId: string
  automationId: string
  taskId: string
  attemptId: string
  status: AutomationRunStatus
  sessionId?: string
  artifactRef?: string
  outputPreview: string
  usage: Readonly<Record<string, unknown>>
  executionMode: AutomationExecutionMode | 'unknown'
  definitionHash?: string
  diagnostic: AutomationExecutionDiagnostic
  deliveryStatus?: AutomationDeliveryStatus
  deliveryRef?: string
  evidenceStatus: AutomationEvidenceStatus
  evidence?: AutomationOutcomeEvidence
  createdAt: number
  updatedAt: number
}

export type AutomationMutation =
  | { op: 'create'; automationId: string; definition: AutomationDefinition }
  | { op: 'delete' | 'pause' | 'resume'; automationId: string; expectedVersion: number }

export type AutomationProposalStatus = 'approved' | 'conflicted' | 'expired' | 'pending' | 'rejected'

export interface StoredAutomationProposal {
  proposalId: string
  policyProposalId?: string
  idempotencyKey: string
  requester: string
  principal: string
  dispatch?: Readonly<ApprovalDispatchRoute>
  requestHash: string
  changeHash: string
  mutation: AutomationMutation
  status: AutomationProposalStatus
  expiresAt: number
  ttlMs: number
  createdAt: number
  version: number
  resultAutomationId?: string
}

export interface AutomationProposalInput {
  idempotencyKey: string
  requester: string
  principal: string
  dispatch?: Readonly<ApprovalDispatchRoute>
  ttlMs: number
  mutation: AutomationMutation
}

export interface AutomationProposalDecisionInput {
  proposalId: string
  principal: string
  expectedVersion: number
  decision: 'approved' | 'rejected'
  reason: string
}

export interface AutomationProposalResult {
  proposalId: string
  policyProposalId?: string
  status: AutomationProposalStatus
  version: number
  expiresAt: number
  mutation: AutomationMutation
  diff: string
  summary: string
  replayed: boolean
  automation?: AutomationRecord
}
