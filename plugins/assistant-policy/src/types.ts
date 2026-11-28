export type PolicyEffect = 'allow' | 'deny'

export type PolicySubjectKind = 'agent' | 'background' | 'external'

export type PolicyResourceKind =
  | 'automation'
  | 'credential'
  // Learned behavioural guidance. Kept in this closed vocabulary so adopting or
  // retiring a rule is governed by the same default-deny rules as any other
  // resource, and can never be authorized by the evolution plugin itself.
  | 'evolution'
  | 'filesystem'
  | 'goal'
  | 'memory'
  | 'message'
  | 'network'
  // Tentative preference hypotheses and their bounded T1 overlays stay
  // separate from owner-confirmed long-term Memory.
  | 'preference'
  | 'tool'
  | 'wiki'

export type PolicyInitiator = 'background' | 'external' | 'foreground'

export interface PolicySubject {
  kind: PolicySubjectKind
  id: string
  workspace?: string
  principal?: string
}

export interface PolicyResource {
  kind: PolicyResourceKind
  id: string
}

export interface PolicyContext {
  initiator: PolicyInitiator
}

export const POLICY_SENSITIVITY_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const

export type PolicySensitivity = typeof POLICY_SENSITIVITY_LEVELS[number]

export interface PolicyLease {
  leaseId?: string
  expiresAtMs?: number
  maxUses?: number
  revoked?: boolean
}

export interface PolicyIdempotencyBinding {
  readonly commitDigest?: string
  readonly predecessorDigest?: string
  readonly intentHash?: string
}

export interface PolicyEvaluationState {
  readonly nowMs?: number
  readonly leaseUses?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  readonly revokedLeaseIds?: ReadonlySet<string> | readonly string[]
  readonly spentCostMicros?: number
  readonly spentCostMicrosByRule?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  readonly expectedPredecessorDigest?: string
  readonly activeCommitDigests?: ReadonlySet<string> | readonly string[]
  readonly idempotencyBindings?:
    | ReadonlyMap<string, string | PolicyIdempotencyBinding>
    | Readonly<Record<string, string | PolicyIdempotencyBinding>>
  readonly usedIdempotencyKeys?: ReadonlySet<string> | readonly string[]
  readonly intentHash?: string
}

export interface PolicyRequest {
  subject: PolicySubject
  action: string
  resource: PolicyResource
  context: PolicyContext
  lease?: PolicyLease
  destination?: string
  sensitivity?: PolicySensitivity
  estimatedCostMicros?: number
  commitDigest?: string
  predecessorDigest?: string
  idempotencyKey?: string
}

export interface PolicySubjectMatcher {
  kind?: PolicySubjectKind | '*'
  id?: string
  workspace?: string
  principal?: string
}

export interface PolicyResourceMatcher {
  kind?: PolicyResourceKind | '*'
  id?: string
}

export interface PolicyContextMatcher {
  initiators?: PolicyInitiator[]
}

export interface PolicyRule {
  id: string
  effect: PolicyEffect
  subject?: PolicySubjectMatcher
  actions?: string[]
  resource?: PolicyResourceMatcher
  context?: PolicyContextMatcher
  budget?: PolicyBudgetCharge
  lease?: PolicyLease
  destinations?: readonly string[]
  maxSensitivity?: PolicySensitivity
  monetaryCostCapMicros?: number
  commitDigest?: string
  predecessorDigest?: string
  idempotencyKey?: string
}

export interface PolicyBudgetCharge {
  id: string
  amount: number
}

export type DecisionReasonCode =
  | 'default-deny'
  | 'budget-exhausted'
  | 'budget-idempotency-required'
  | 'budget-not-configured'
  | 'budget-principal-mismatch'
  | 'emergency-stop'
  | 'missing-agent'
  | 'missing-agent-preset'
  | 'missing-workspace'
  | 'rule-allow'
  | 'rule-deny'
  | 'tool-default-allow'
  | 'lease-revoked'
  | 'lease-expired'
  | 'lease-exhausted'
  | 'lease-mismatch'
  | 'lease-invalid'
  | 'destination-missing'
  | 'destination-mismatch'
  | 'destination-invalid'
  | 'sensitivity-missing'
  | 'sensitivity-exceeded'
  | 'sensitivity-invalid'
  | 'monetary-cost-missing'
  | 'monetary-cost-invalid'
  | 'monetary-cost-exceeded'
  | 'commit-digest-missing'
  | 'commit-digest-mismatch'
  | 'commit-digest-invalid'
  | 'predecessor-digest-missing'
  | 'predecessor-digest-mismatch'
  | 'predecessor-digest-invalid'
  | 'idempotency-key-missing'
  | 'idempotency-conflict'
  | 'ray-kernel-protected'

export interface PolicyDecision {
  effect: PolicyEffect
  reasonCode: DecisionReasonCode
  ruleId: string | undefined
  budget?: Readonly<PolicyBudgetCharge>
  lease?: Readonly<PolicyLease>
  /**
   * Set only by `authorizeAgentForPrincipal` when the rule's budget was charged
   * in that principal's own ledger partition (never the shared rule scope).
   */
  budgetPrincipal?: string
  /**
   * Non-enumerable correlation identifier attached to fresh stateful
   * authorization commits so strictly pre-dispatch failures can roll back the
   * exact commit atomically without changing enumerable decision equality.
   */
  readonly decisionId?: string
}

export interface CompiledPolicy {
  readonly rules: readonly CompiledPolicyRule[]
}

export interface CompiledPolicyRule {
  readonly id: string
  readonly effect: PolicyEffect
  readonly subject?: Readonly<PolicySubjectMatcher>
  readonly actions?: readonly string[]
  readonly resource?: Readonly<PolicyResourceMatcher>
  readonly context?: Readonly<{
    initiators?: readonly PolicyInitiator[]
  }>
  readonly budget?: Readonly<PolicyBudgetCharge>
  readonly lease?: Readonly<PolicyLease>
  readonly destinations?: readonly string[]
  readonly maxSensitivity?: PolicySensitivity
  readonly monetaryCostCapMicros?: number
  readonly commitDigest?: string
  readonly predecessorDigest?: string
  readonly idempotencyKey?: string
  readonly specificity: number
  readonly order: number
}
