import type {
  CompiledPolicy,
  CompiledPolicyRule,
  PolicyDecision,
  PolicyRequest,
  PolicyRule,
} from './types.js'

const defaultDecision: PolicyDecision = Object.freeze({
  effect: 'deny',
  reasonCode: 'default-deny',
  ruleId: undefined,
})

function cloneRule(rule: PolicyRule, order: number): CompiledPolicyRule {
  if (rule.budget !== undefined) {
    if (rule.budget.id.trim() === '') throw new TypeError('policy rule budget id must not be empty')
    if (!Number.isFinite(rule.budget.amount) || rule.budget.amount <= 0) {
      throw new TypeError('policy rule budget amount must be a positive finite number')
    }
  }
  const subject = rule.subject === undefined ? undefined : Object.freeze({ ...rule.subject })
  const actions = rule.actions === undefined ? undefined : Object.freeze([...rule.actions])
  const resource = rule.resource === undefined ? undefined : Object.freeze({ ...rule.resource })
  const context: CompiledPolicyRule['context'] = rule.context === undefined
    ? undefined
    : rule.context.initiators === undefined
      ? Object.freeze({})
      : Object.freeze({ initiators: Object.freeze([...rule.context.initiators]) })
  const budget = rule.budget === undefined ? undefined : Object.freeze({ ...rule.budget })
  const matchers = [
    subject?.kind,
    subject?.id,
    subject?.workspace,
    subject?.principal,
    ...(actions ?? []),
    resource?.kind,
    resource?.id,
    ...(context?.initiators ?? []),
  ]
  const specificity = matchers.reduce((score, value) => {
    if (value === undefined || value === '*') return score
    return score + (value.includes('*') ? 1 : 2)
  }, 0)

  return Object.freeze({
    id: rule.id,
    effect: rule.effect,
    ...(subject === undefined ? {} : { subject }),
    ...(actions === undefined ? {} : { actions }),
    ...(resource === undefined ? {} : { resource }),
    ...(context === undefined ? {} : { context }),
    ...(budget === undefined ? {} : { budget }),
    specificity,
    order,
  })
}

export function compilePolicy(rules: readonly PolicyRule[]): CompiledPolicy {
  const identifiers = new Set<string>()
  const compiled = rules.map((rule, order) => {
    if (rule.id.trim() === '') throw new TypeError('policy rule id must not be empty')
    if (identifiers.has(rule.id)) throw new TypeError(`duplicate policy rule id: ${rule.id}`)
    identifiers.add(rule.id)
    return cloneRule(rule, order)
  })

  return Object.freeze({ rules: Object.freeze(compiled) })
}

function matchPattern(pattern: string | undefined, value: string | undefined): boolean {
  if (pattern === undefined) return true
  if (value === undefined) return false
  if (pattern === '*') return true
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`, 'u').test(value)
}

function matches(rule: CompiledPolicyRule, request: PolicyRequest): boolean {
  const subject = rule.subject
  if (subject !== undefined) {
    if (!matchPattern(subject.kind, request.subject.kind)) return false
    if (!matchPattern(subject.id, request.subject.id)) return false
    if (!matchPattern(subject.workspace, request.subject.workspace)) return false
    if (!matchPattern(subject.principal, request.subject.principal)) return false
  }

  if (rule.actions !== undefined && !rule.actions.some(action => matchPattern(action, request.action))) {
    return false
  }

  const resource = rule.resource
  if (resource !== undefined) {
    if (!matchPattern(resource.kind, request.resource.kind)) return false
    if (!matchPattern(resource.id, request.resource.id)) return false
  }

  const initiators = rule.context?.initiators
  if (initiators !== undefined && initiators.length > 0 && !initiators.includes(request.context.initiator)) return false
  return true
}

function bestMatch(rules: readonly CompiledPolicyRule[]): CompiledPolicyRule | undefined {
  return rules.reduce<CompiledPolicyRule | undefined>((best, rule) => {
    if (best === undefined) return rule
    if (rule.specificity > best.specificity) return rule
    if (rule.specificity === best.specificity && rule.order < best.order) return rule
    return best
  }, undefined)
}

export function evaluatePolicy(policy: CompiledPolicy, request: PolicyRequest): PolicyDecision {
  const matching = policy.rules.filter(rule => matches(rule, request))
  const denied = bestMatch(matching.filter(rule => rule.effect === 'deny'))
  if (denied !== undefined) {
    return { effect: 'deny', reasonCode: 'rule-deny', ruleId: denied.id }
  }

  const allowed = bestMatch(matching.filter(rule => rule.effect === 'allow'))
  if (allowed !== undefined) {
    return {
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: allowed.id,
      ...(allowed.budget === undefined ? {} : { budget: allowed.budget }),
    }
  }

  return defaultDecision
}
