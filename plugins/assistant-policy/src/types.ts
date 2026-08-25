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
  | 'memory'
  | 'message'
  | 'network'
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

export interface PolicyRequest {
  subject: PolicySubject
  action: string
  resource: PolicyResource
  context: PolicyContext
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
  | 'emergency-stop'
  | 'missing-agent'
  | 'missing-agent-preset'
  | 'missing-workspace'
  | 'rule-allow'
  | 'rule-deny'
  | 'tool-default-allow'

export interface PolicyDecision {
  effect: PolicyEffect
  reasonCode: DecisionReasonCode
  ruleId: string | undefined
  budget?: Readonly<PolicyBudgetCharge>
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
  readonly specificity: number
  readonly order: number
}
