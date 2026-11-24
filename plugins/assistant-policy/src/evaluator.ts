import { Buffer } from 'node:buffer'
import {
  POLICY_SENSITIVITY_LEVELS,
  type CompiledPolicy,
  type CompiledPolicyRule,
  type DecisionReasonCode,
  type PolicyDecision,
  type PolicyEvaluationState,
  type PolicyIdempotencyBinding,
  type PolicyLease,
  type PolicyRequest,
  type PolicyRule,
  type PolicySensitivity,
} from './types.js'

const SENSITIVITY_RANK: Readonly<Record<PolicySensitivity, number>> = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
})

const defaultDecision: PolicyDecision = Object.freeze({
  effect: 'deny',
  reasonCode: 'default-deny',
  ruleId: undefined,
})

function denyDecision(reasonCode: DecisionReasonCode, ruleId: string | undefined = undefined): PolicyDecision {
  return { effect: 'deny', reasonCode, ruleId }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidToken(value: unknown, maxBytes = 512): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isSensitivity(value: unknown): value is PolicySensitivity {
  return typeof value === 'string' && (POLICY_SENSITIVITY_LEVELS as readonly string[]).includes(value)
}

function validateCompiledLease(lease: PolicyLease): Readonly<PolicyLease> {
  if (!isPlainObject(lease)) {
    throw new TypeError('policy rule lease must be an object')
  }
  if (lease.leaseId !== undefined && !isValidToken(lease.leaseId, 256)) {
    throw new TypeError('policy rule lease.leaseId must be a non-empty trimmed string without control characters')
  }
  if (lease.expiresAtMs !== undefined && (typeof lease.expiresAtMs !== 'number' || !Number.isSafeInteger(lease.expiresAtMs) || lease.expiresAtMs < 0)) {
    throw new TypeError('policy rule lease.expiresAtMs must be a non-negative safe integer')
  }
  if (lease.maxUses !== undefined && (typeof lease.maxUses !== 'number' || !Number.isSafeInteger(lease.maxUses) || lease.maxUses < 0)) {
    throw new TypeError('policy rule lease.maxUses must be a non-negative safe integer')
  }
  if (lease.revoked !== undefined && typeof lease.revoked !== 'boolean') {
    throw new TypeError('policy rule lease.revoked must be a boolean')
  }
  return Object.freeze({
    ...(lease.leaseId === undefined ? {} : { leaseId: lease.leaseId }),
    ...(lease.expiresAtMs === undefined ? {} : { expiresAtMs: lease.expiresAtMs }),
    ...(lease.maxUses === undefined ? {} : { maxUses: lease.maxUses }),
    ...(lease.revoked === undefined ? {} : { revoked: lease.revoked }),
  })
}

function cloneRule(rule: PolicyRule, order: number): CompiledPolicyRule {
  if (rule.budget !== undefined) {
    if (rule.budget.id.trim() === '') throw new TypeError('policy rule budget id must not be empty')
    if (!Number.isFinite(rule.budget.amount) || rule.budget.amount <= 0) {
      throw new TypeError('policy rule budget amount must be a positive finite number')
    }
  }
  const lease = rule.lease === undefined ? undefined : validateCompiledLease(rule.lease)

  let destinations: readonly string[] | undefined
  if (rule.destinations !== undefined) {
    if (!Array.isArray(rule.destinations)) {
      throw new TypeError('policy rule destinations must be an array')
    }
    for (const entry of rule.destinations) {
      if (!isValidToken(entry, 1024)) {
        throw new TypeError('policy rule destination entries must be non-empty trimmed strings without control characters')
      }
    }
    destinations = Object.freeze([...rule.destinations])
  }

  if (rule.maxSensitivity !== undefined && !isSensitivity(rule.maxSensitivity)) {
    throw new TypeError(`policy rule maxSensitivity must be one of ${POLICY_SENSITIVITY_LEVELS.join(', ')}`)
  }
  if (rule.monetaryCostCapMicros !== undefined && (
    typeof rule.monetaryCostCapMicros !== 'number'
    || !Number.isSafeInteger(rule.monetaryCostCapMicros)
    || rule.monetaryCostCapMicros < 0
  )) {
    throw new TypeError('policy rule monetaryCostCapMicros must be a non-negative safe integer')
  }
  if (rule.commitDigest !== undefined && !isValidToken(rule.commitDigest, 512)) {
    throw new TypeError('policy rule commitDigest must be a non-empty trimmed string without control characters')
  }
  if (rule.predecessorDigest !== undefined && !isValidToken(rule.predecessorDigest, 512)) {
    throw new TypeError('policy rule predecessorDigest must be a non-empty trimmed string without control characters')
  }
  if (rule.idempotencyKey !== undefined && !isValidToken(rule.idempotencyKey, 512)) {
    throw new TypeError('policy rule idempotencyKey must be a non-empty trimmed string without control characters')
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
  let specificity = matchers.reduce((score, value) => {
    if (value === undefined || value === '*') return score
    return score + (value.includes('*') ? 1 : 2)
  }, 0)
  if (destinations !== undefined) {
    const patternScore = destinations.reduce((best, pattern) => {
      const score = pattern === '*' ? 0 : pattern.includes('*') ? 1 : 2
      return Math.max(best, score)
    }, 0)
    specificity += 1 + patternScore
  }
  if (lease !== undefined) specificity += lease.leaseId === undefined ? 1 : 2
  if (rule.maxSensitivity !== undefined) specificity += 1
  if (rule.monetaryCostCapMicros !== undefined) specificity += 1
  if (rule.commitDigest !== undefined) specificity += 2
  if (rule.predecessorDigest !== undefined) specificity += 2
  if (rule.idempotencyKey !== undefined) specificity += 2

  return Object.freeze({
    id: rule.id,
    effect: rule.effect,
    ...(subject === undefined ? {} : { subject }),
    ...(actions === undefined ? {} : { actions }),
    ...(resource === undefined ? {} : { resource }),
    ...(context === undefined ? {} : { context }),
    ...(budget === undefined ? {} : { budget }),
    ...(lease === undefined ? {} : { lease }),
    ...(destinations === undefined ? {} : { destinations }),
    ...(rule.maxSensitivity === undefined ? {} : { maxSensitivity: rule.maxSensitivity }),
    ...(rule.monetaryCostCapMicros === undefined ? {} : { monetaryCostCapMicros: rule.monetaryCostCapMicros }),
    ...(rule.commitDigest === undefined ? {} : { commitDigest: rule.commitDigest }),
    ...(rule.predecessorDigest === undefined ? {} : { predecessorDigest: rule.predecessorDigest }),
    ...(rule.idempotencyKey === undefined ? {} : { idempotencyKey: rule.idempotencyKey }),
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

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
}

function matchPattern(pattern: string | undefined, value: string | undefined): boolean {
  if (pattern === undefined) return true
  if (value === undefined) return false
  const collapsed = pattern.replace(/\*+/gu, '*')
  if (collapsed === '*') return true
  let pIndex = 0
  let vIndex = 0
  let starIndex = -1
  let matchIndex = 0
  while (vIndex < value.length) {
    if (pIndex < collapsed.length && collapsed[pIndex] === '*') {
      starIndex = pIndex
      matchIndex = vIndex
      pIndex++
    } else if (pIndex < collapsed.length && collapsed[pIndex] === value[vIndex]) {
      pIndex++
      vIndex++
    } else if (starIndex !== -1) {
      if (isLineTerminator(value.charCodeAt(matchIndex))) return false
      pIndex = starIndex + 1
      matchIndex++
      vIndex = matchIndex
    } else {
      return false
    }
  }
  while (pIndex < collapsed.length && collapsed[pIndex] === '*') {
    pIndex++
  }
  return pIndex === collapsed.length
}

export function matchesRuleScope(rule: CompiledPolicyRule, request: PolicyRequest): boolean {
  return matchesScope(rule, request)
}

function matchesScope(rule: CompiledPolicyRule, request: PolicyRequest): boolean {
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

function hasString(collection: ReadonlySet<string> | readonly string[] | undefined, target: string): boolean {
  if (collection === undefined) return false
  if (collection instanceof Set) return collection.has(target)
  return (collection as readonly string[]).includes(target)
}

function lookupNumber(
  source: ReadonlyMap<string, number> | Readonly<Record<string, number>> | undefined,
  key: string,
): number | undefined {
  if (source === undefined) return undefined
  if (source instanceof Map) return source.get(key)
  const record = source as Readonly<Record<string, number>>
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function lookupBinding(
  source:
    | ReadonlyMap<string, string | PolicyIdempotencyBinding>
    | Readonly<Record<string, string | PolicyIdempotencyBinding>>
    | undefined,
  key: string,
): string | PolicyIdempotencyBinding | undefined {
  if (source === undefined) return undefined
  if (source instanceof Map) return source.get(key)
  const record = source as Readonly<Record<string, string | PolicyIdempotencyBinding>>
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

function validateRequestAndState(
  request: PolicyRequest,
  state: PolicyEvaluationState | undefined,
): { ok: true; nowMs: number } | { ok: false; reasonCode: DecisionReasonCode } {
  if (state?.nowMs !== undefined && (typeof state.nowMs !== 'number' || !Number.isFinite(state.nowMs) || state.nowMs < 0)) {
    return { ok: false, reasonCode: 'lease-invalid' }
  }
  const nowMs = state?.nowMs ?? Date.now()

  if (state?.spentCostMicros !== undefined && (
    typeof state.spentCostMicros !== 'number'
    || !Number.isSafeInteger(state.spentCostMicros)
    || state.spentCostMicros < 0
  )) {
    return { ok: false, reasonCode: 'monetary-cost-invalid' }
  }
  if (state?.spentCostMicrosByRule !== undefined) {
    const entries = state.spentCostMicrosByRule instanceof Map
      ? [...state.spentCostMicrosByRule.values()]
      : Object.values(state.spentCostMicrosByRule)
    for (const value of entries) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        return { ok: false, reasonCode: 'monetary-cost-invalid' }
      }
    }
  }
  if (state?.expectedPredecessorDigest !== undefined && !isValidToken(state.expectedPredecessorDigest, 512)) {
    return { ok: false, reasonCode: 'predecessor-digest-invalid' }
  }
  if (state?.intentHash !== undefined && !isValidToken(state.intentHash, 512)) {
    return { ok: false, reasonCode: 'idempotency-conflict' }
  }

  if (request.destination !== undefined && !isValidToken(request.destination, 1024)) {
    return { ok: false, reasonCode: 'destination-invalid' }
  }
  if (request.sensitivity !== undefined && !isSensitivity(request.sensitivity)) {
    return { ok: false, reasonCode: 'sensitivity-invalid' }
  }
  if (request.estimatedCostMicros !== undefined && (
    typeof request.estimatedCostMicros !== 'number'
    || !Number.isSafeInteger(request.estimatedCostMicros)
    || request.estimatedCostMicros < 0
  )) {
    return { ok: false, reasonCode: 'monetary-cost-invalid' }
  }
  if (request.commitDigest !== undefined && !isValidToken(request.commitDigest, 512)) {
    return { ok: false, reasonCode: 'commit-digest-invalid' }
  }
  if (request.predecessorDigest !== undefined && !isValidToken(request.predecessorDigest, 512)) {
    return { ok: false, reasonCode: 'predecessor-digest-invalid' }
  }
  if (request.commitDigest !== undefined && request.predecessorDigest !== undefined && request.commitDigest === request.predecessorDigest) {
    return { ok: false, reasonCode: 'commit-digest-mismatch' }
  }
  if (request.idempotencyKey !== undefined && !isValidToken(request.idempotencyKey, 512)) {
    return { ok: false, reasonCode: 'idempotency-conflict' }
  }

  if (request.lease !== undefined) {
    const lease = request.lease
    if (!isPlainObject(lease)) {
      return { ok: false, reasonCode: 'lease-invalid' }
    }
    if (lease.leaseId !== undefined && !isValidToken(lease.leaseId, 256)) {
      return { ok: false, reasonCode: 'lease-invalid' }
    }
    if (lease.expiresAtMs !== undefined && (
      typeof lease.expiresAtMs !== 'number'
      || !Number.isSafeInteger(lease.expiresAtMs)
      || lease.expiresAtMs < 0
    )) {
      return { ok: false, reasonCode: 'lease-invalid' }
    }
    if (lease.maxUses !== undefined && (
      typeof lease.maxUses !== 'number'
      || !Number.isSafeInteger(lease.maxUses)
      || lease.maxUses < 0
    )) {
      return { ok: false, reasonCode: 'lease-invalid' }
    }
    if (lease.revoked !== undefined && typeof lease.revoked !== 'boolean') {
      return { ok: false, reasonCode: 'lease-invalid' }
    }
    if (lease.revoked === true) {
      return { ok: false, reasonCode: 'lease-revoked' }
    }
    if (lease.leaseId !== undefined && hasString(state?.revokedLeaseIds, lease.leaseId)) {
      return { ok: false, reasonCode: 'lease-revoked' }
    }
    if (lease.expiresAtMs !== undefined && nowMs >= lease.expiresAtMs) {
      return { ok: false, reasonCode: 'lease-expired' }
    }
    if (lease.maxUses !== undefined) {
      const used = lease.leaseId === undefined ? 0 : (lookupNumber(state?.leaseUses, lease.leaseId) ?? 0)
      if (!Number.isSafeInteger(used) || used < 0) {
        return { ok: false, reasonCode: 'lease-invalid' }
      }
      if (used >= lease.maxUses) {
        return { ok: false, reasonCode: 'lease-exhausted' }
      }
    }
  }

  return { ok: true, nowMs }
}

function checkIdempotencyStateConflict(
  request: PolicyRequest,
  state: PolicyEvaluationState | undefined,
): boolean {
  if (request.idempotencyKey === undefined) return false
  if (hasString(state?.usedIdempotencyKeys, request.idempotencyKey)) return true
  const binding = lookupBinding(state?.idempotencyBindings, request.idempotencyKey)
  if (binding === undefined) return false
  if (typeof binding === 'string') {
    return (request.commitDigest ?? '') !== binding
  }
  if (binding.intentHash !== undefined && state?.intentHash !== undefined && state.intentHash !== binding.intentHash) {
    return true
  }
  if (binding.commitDigest !== undefined && request.commitDigest !== binding.commitDigest) return true
  if (binding.predecessorDigest !== undefined && request.predecessorDigest !== binding.predecessorDigest) return true
  return false
}

type ConstraintCheckResult =
  | { ok: true }
  | { ok: false; reasonCode: DecisionReasonCode; destinationMatched: boolean }

function evaluateRuleConstraints(
  rule: CompiledPolicyRule,
  request: PolicyRequest,
  state: PolicyEvaluationState | undefined,
  nowMs: number,
): ConstraintCheckResult {
  let destinationMatched = true
  if (rule.destinations !== undefined) {
    if (request.destination === undefined) {
      return { ok: false, reasonCode: 'destination-missing', destinationMatched: false }
    }
    const matched = request.destination.length > 0
      && rule.destinations.some(pattern => matchPattern(pattern, request.destination))
    if (!matched) {
      return { ok: false, reasonCode: 'destination-mismatch', destinationMatched: false }
    }
    destinationMatched = true
  }

  if (rule.lease !== undefined) {
    if (
      rule.lease.leaseId !== undefined
      && request.lease?.leaseId !== undefined
      && rule.lease.leaseId !== request.lease.leaseId
    ) {
      return { ok: false, reasonCode: 'lease-mismatch', destinationMatched }
    }
    const candidateKeys = rule.lease.leaseId !== undefined
      ? [rule.lease.leaseId]
      : [
          `rule:${rule.id}`,
          rule.id,
          ...(request.lease?.leaseId === undefined ? [] : [request.lease.leaseId]),
        ]

    if (
      rule.lease.revoked === true
      || request.lease?.revoked === true
      || candidateKeys.some(key => hasString(state?.revokedLeaseIds, key))
    ) {
      return { ok: false, reasonCode: 'lease-revoked', destinationMatched }
    }

    const effectiveExpiry = minDefined(rule.lease.expiresAtMs, request.lease?.expiresAtMs)
    if (effectiveExpiry !== undefined && nowMs >= effectiveExpiry) {
      return { ok: false, reasonCode: 'lease-expired', destinationMatched }
    }

    const effectiveMaxUses = minDefined(rule.lease.maxUses, request.lease?.maxUses)
    if (effectiveMaxUses !== undefined) {
      let maxRecordedUses = 0
      for (const key of candidateKeys) {
        const value = lookupNumber(state?.leaseUses, key)
        if (value === undefined) continue
        if (!Number.isSafeInteger(value) || value < 0) {
          return { ok: false, reasonCode: 'lease-invalid', destinationMatched }
        }
        if (value > maxRecordedUses) maxRecordedUses = value
      }
      if (maxRecordedUses >= effectiveMaxUses) {
        return { ok: false, reasonCode: 'lease-exhausted', destinationMatched }
      }
    }
  } else if (rule.effect === 'allow' && request.lease !== undefined) {
    const candidateKeys = request.lease.leaseId !== undefined
      ? [request.lease.leaseId]
      : [`rule:${rule.id}`, rule.id]
    if (candidateKeys.some(key => hasString(state?.revokedLeaseIds, key))) {
      return { ok: false, reasonCode: 'lease-revoked', destinationMatched }
    }
    if (request.lease.maxUses !== undefined) {
      let maxRecordedUses = 0
      for (const key of candidateKeys) {
        const value = lookupNumber(state?.leaseUses, key)
        if (value === undefined) continue
        if (!Number.isSafeInteger(value) || value < 0) {
          return { ok: false, reasonCode: 'lease-invalid', destinationMatched }
        }
        if (value > maxRecordedUses) maxRecordedUses = value
      }
      if (maxRecordedUses >= request.lease.maxUses) {
        return { ok: false, reasonCode: 'lease-exhausted', destinationMatched }
      }
    }
  }

  if (rule.maxSensitivity !== undefined) {
    if (request.sensitivity === undefined) {
      return { ok: false, reasonCode: 'sensitivity-missing', destinationMatched }
    }
    if (SENSITIVITY_RANK[request.sensitivity] > SENSITIVITY_RANK[rule.maxSensitivity]) {
      return { ok: false, reasonCode: 'sensitivity-exceeded', destinationMatched }
    }
  }

  if (rule.monetaryCostCapMicros !== undefined) {
    if (request.estimatedCostMicros === undefined) {
      return { ok: false, reasonCode: 'monetary-cost-missing', destinationMatched }
    }
    const spent = lookupNumber(state?.spentCostMicrosByRule, rule.id) ?? state?.spentCostMicros ?? 0
    if (!Number.isSafeInteger(spent) || spent < 0) {
      return { ok: false, reasonCode: 'monetary-cost-invalid', destinationMatched }
    }
    if (spent > rule.monetaryCostCapMicros || request.estimatedCostMicros > rule.monetaryCostCapMicros - spent) {
      return { ok: false, reasonCode: 'monetary-cost-exceeded', destinationMatched }
    }
  }

  if (rule.commitDigest !== undefined) {
    if (request.commitDigest === undefined) {
      return { ok: false, reasonCode: 'commit-digest-missing', destinationMatched }
    }
    if (request.commitDigest !== rule.commitDigest) {
      return { ok: false, reasonCode: 'commit-digest-mismatch', destinationMatched }
    }
  }

  if (state?.activeCommitDigests !== undefined) {
    if (request.commitDigest === undefined) {
      return { ok: false, reasonCode: 'commit-digest-missing', destinationMatched }
    }
    if (!hasString(state.activeCommitDigests, request.commitDigest)) {
      return { ok: false, reasonCode: 'commit-digest-mismatch', destinationMatched }
    }
  }

  if (rule.predecessorDigest !== undefined) {
    if (request.predecessorDigest === undefined) {
      return { ok: false, reasonCode: 'predecessor-digest-missing', destinationMatched }
    }
    if (request.predecessorDigest !== rule.predecessorDigest) {
      return { ok: false, reasonCode: 'predecessor-digest-mismatch', destinationMatched }
    }
  }

  if (state?.expectedPredecessorDigest !== undefined) {
    if (request.predecessorDigest === undefined) {
      return { ok: false, reasonCode: 'predecessor-digest-missing', destinationMatched }
    }
    if (request.predecessorDigest !== state.expectedPredecessorDigest) {
      return { ok: false, reasonCode: 'predecessor-digest-mismatch', destinationMatched }
    }
  }

  if (rule.idempotencyKey !== undefined) {
    if (request.idempotencyKey === undefined) {
      return { ok: false, reasonCode: 'idempotency-key-missing', destinationMatched }
    }
    if (request.idempotencyKey !== rule.idempotencyKey) {
      return { ok: false, reasonCode: 'idempotency-conflict', destinationMatched }
    }
  }

  if (checkIdempotencyStateConflict(request, state)) {
    return { ok: false, reasonCode: 'idempotency-conflict', destinationMatched }
  }

  return { ok: true }
}

export function evaluatePolicy(
  policy: CompiledPolicy,
  request: PolicyRequest,
  state?: PolicyEvaluationState,
): PolicyDecision {
  const precheck = validateRequestAndState(request, state)
  if (!precheck.ok) {
    return denyDecision(precheck.reasonCode)
  }
  const nowMs = precheck.nowMs

  const scopeMatching = policy.rules.filter(rule => matchesScope(rule, request))
  const firingDenies = scopeMatching.filter(
    rule => rule.effect === 'deny' && evaluateRuleConstraints(rule, request, state, nowMs).ok,
  )
  const denied = bestMatch(firingDenies)
  if (denied !== undefined) {
    return denyDecision('rule-deny', denied.id)
  }

  if (checkIdempotencyStateConflict(request, state)) {
    return denyDecision('idempotency-conflict')
  }

  const satisfiedAllows: CompiledPolicyRule[] = []
  const failedAllows: Array<{ rule: CompiledPolicyRule; reasonCode: DecisionReasonCode; destinationMatched: boolean }> = []
  for (const rule of scopeMatching) {
    if (rule.effect !== 'allow') continue
    const result = evaluateRuleConstraints(rule, request, state, nowMs)
    if (result.ok) {
      satisfiedAllows.push(rule)
    } else {
      failedAllows.push({ rule, reasonCode: result.reasonCode, destinationMatched: result.destinationMatched })
    }
  }

  const allowed = bestMatch(satisfiedAllows)
  if (allowed !== undefined) {
    return {
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: allowed.id,
      ...(allowed.budget === undefined ? {} : { budget: allowed.budget }),
      ...(allowed.lease === undefined ? {} : { lease: allowed.lease }),
    }
  }

  if (failedAllows.length > 0) {
    const destinationMatchedFailures = failedAllows.filter(entry => entry.destinationMatched)
    const candidates = destinationMatchedFailures.length > 0 ? destinationMatchedFailures : failedAllows
    const bestFailedRule = bestMatch(candidates.map(entry => entry.rule))!
    const bestFailed = candidates.find(entry => entry.rule === bestFailedRule)!
    return denyDecision(bestFailed.reasonCode, bestFailed.rule.id)
  }

  if (state?.expectedPredecessorDigest !== undefined) {
    return denyDecision(
      request.predecessorDigest === undefined ? 'predecessor-digest-missing' : 'predecessor-digest-mismatch',
    )
  }

  if (state?.activeCommitDigests !== undefined) {
    if (request.commitDigest === undefined) {
      return denyDecision('commit-digest-missing')
    }
    if (!hasString(state.activeCommitDigests, request.commitDigest)) {
      return denyDecision('commit-digest-mismatch')
    }
  }

  return defaultDecision
}
