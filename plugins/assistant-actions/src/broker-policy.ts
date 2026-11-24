import type { Agent } from '@deepseek-ai/dsh-agent'

export type BrokerSensitivity = 'public' | 'internal' | 'confidential' | 'restricted'

export interface BrokerPolicyLease {
  readonly leaseId?: string
  readonly expiresAtMs?: number
  readonly maxUses?: number
  readonly revoked?: boolean
}

export interface BrokerWp08Constraints {
  readonly lease?: BrokerPolicyLease
  readonly destinations?: readonly string[]
  readonly maxSensitivity?: BrokerSensitivity
  readonly monetaryCostCapMicros?: number
  readonly commitDigest?: string
  readonly predecessorDigest?: string
  readonly idempotencyKey?: string
}

export interface BrokerWp08RequestContext {
  readonly destination?: string
  readonly sensitivity?: BrokerSensitivity
  readonly estimatedCostMicros?: number
  readonly commitDigest?: string
  readonly predecessorDigest?: string
  readonly idempotencyKey?: string
}

export interface BrokerWp08UsageState {
  readonly leaseUses: number
  readonly spentCostMicros: number
  readonly lastSettledCommitDigest?: string
}

export type BrokerWp08ReasonCode =
  | 'allowed'
  | 'lease-revoked'
  | 'lease-expired'
  | 'lease-exhausted'
  | 'destination-mismatch'
  | 'sensitivity-exceeded'
  | 'cost-cap-exceeded'
  | 'commit-digest-mismatch'
  | 'predecessor-digest-mismatch'
  | 'invalid-input'

export interface BrokerWp08EvaluationResult {
  readonly allowed: boolean
  readonly reasonCode: BrokerWp08ReasonCode
  readonly detail?: string
}

export interface BrokerPolicySubject {
  kind: 'agent' | 'background' | 'external'
  id: string
  workspace?: string
  principal?: string
}

export interface BrokerPolicyResource {
  kind: 'automation' | 'credential' | 'evolution' | 'filesystem' | 'goal' | 'memory' | 'message' | 'network' | 'preference' | 'tool' | 'wiki'
  id: string
}

export interface BrokerPolicyRequest extends BrokerWp08RequestContext {
  subject: BrokerPolicySubject
  action: string
  resource: BrokerPolicyResource
  context: { initiator: 'background' | 'external' | 'foreground' }
  lease?: BrokerPolicyLease
}

export interface BrokerPolicyDecision {
  effect: 'allow' | 'deny'
  reasonCode: string
  ruleId: string | undefined
  lease?: BrokerPolicyLease
  readonly decisionId?: string
}

export interface BrokerPolicyRollbackInput {
  readonly idempotencyKey: string
  readonly decisionId?: string | undefined
  readonly ruleId?: string | undefined
  readonly leaseId?: string | undefined
  readonly estimatedCostMicros?: number | undefined
  readonly commitDigest?: string | undefined
  readonly auditDetails?: unknown
}

export interface BrokerPolicyOptions extends BrokerWp08RequestContext {
  idempotencyKey?: string
  lease?: BrokerPolicyLease
}

export interface BrokerPolicyServicePort {
  evaluate(request: BrokerPolicyRequest): BrokerPolicyDecision
  authorize(request: BrokerPolicyRequest, options?: BrokerPolicyOptions): BrokerPolicyDecision
  evaluateAgent(agent: Agent | undefined, action: string, resource: BrokerPolicyResource, options?: BrokerPolicyOptions): BrokerPolicyDecision
  authorizeAgent(agent: Agent | undefined, action: string, resource: BrokerPolicyResource, options?: BrokerPolicyOptions): BrokerPolicyDecision
  rollbackPreDispatchAuthorization?(input: BrokerPolicyRollbackInput): boolean
}

const SENSITIVITY_RANK: Readonly<Record<BrokerSensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

const DIGEST_RE = /^[0-9a-f]{64}$/u
const CONTROL_CHAR_RE = /[\p{Cc}]/u

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
}

function validText(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !CONTROL_CHAR_RE.test(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

export function isBrokerSensitivity(value: unknown): value is BrokerSensitivity {
  return value === 'public' || value === 'internal' || value === 'confidential' || value === 'restricted'
}

export function sensitivityRank(value: BrokerSensitivity): number {
  return SENSITIVITY_RANK[value]
}

export function normalizeBrokerPolicyLease(value: unknown): BrokerPolicyLease {
  if (!isPlainRecord(value)) throw new Error('assistant-actions: invalid WP08 lease')
  const allowedKeys = new Set(['leaseId', 'expiresAtMs', 'maxUses', 'revoked'])
  if (Object.keys(value).some(key => !allowedKeys.has(key))) throw new Error('assistant-actions: unknown WP08 lease field')
  const result: { leaseId?: string; expiresAtMs?: number; maxUses?: number; revoked?: boolean } = {}
  if (value.leaseId !== undefined) {
    if (!validText(value.leaseId, 128)) throw new Error('assistant-actions: invalid WP08 leaseId')
    result.leaseId = value.leaseId
  }
  if (value.expiresAtMs !== undefined) {
    if (typeof value.expiresAtMs !== 'number' || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs < 1) throw new Error('assistant-actions: invalid WP08 expiresAtMs')
    result.expiresAtMs = value.expiresAtMs
  }
  if (value.maxUses !== undefined) {
    if (typeof value.maxUses !== 'number' || !Number.isSafeInteger(value.maxUses) || value.maxUses < 1) throw new Error('assistant-actions: invalid WP08 maxUses')
    result.maxUses = value.maxUses
  }
  if (value.revoked !== undefined) {
    if (typeof value.revoked !== 'boolean') throw new Error('assistant-actions: invalid WP08 revoked flag')
    result.revoked = value.revoked
  }
  return Object.freeze(result)
}

export function normalizeBrokerWp08Constraints(value: unknown): BrokerWp08Constraints {
  if (!isPlainRecord(value)) throw new Error('assistant-actions: invalid WP08 constraints')
  const allowedKeys = new Set(['lease', 'destinations', 'maxSensitivity', 'monetaryCostCapMicros', 'commitDigest', 'predecessorDigest', 'idempotencyKey'])
  if (Object.keys(value).some(key => !allowedKeys.has(key))) throw new Error('assistant-actions: unknown WP08 constraint field')
  const result: {
    lease?: BrokerPolicyLease
    destinations?: readonly string[]
    maxSensitivity?: BrokerSensitivity
    monetaryCostCapMicros?: number
    commitDigest?: string
    predecessorDigest?: string
    idempotencyKey?: string
  } = {}
  if (value.lease !== undefined) result.lease = normalizeBrokerPolicyLease(value.lease)
  if (value.destinations !== undefined) {
    if (!Array.isArray(value.destinations) || value.destinations.length > 128 || !value.destinations.every(item => validText(item, 1024))) {
      throw new Error('assistant-actions: invalid WP08 destinations')
    }
    result.destinations = Object.freeze([...value.destinations])
  }
  if (value.maxSensitivity !== undefined) {
    if (!isBrokerSensitivity(value.maxSensitivity)) throw new Error('assistant-actions: invalid WP08 maxSensitivity')
    result.maxSensitivity = value.maxSensitivity
  }
  if (value.monetaryCostCapMicros !== undefined) {
    if (!isNonNegativeSafeInteger(value.monetaryCostCapMicros)) {
      throw new Error('assistant-actions: invalid WP08 monetaryCostCapMicros')
    }
    result.monetaryCostCapMicros = value.monetaryCostCapMicros
  }
  if (value.commitDigest !== undefined) {
    if (typeof value.commitDigest !== 'string' || !DIGEST_RE.test(value.commitDigest)) throw new Error('assistant-actions: invalid WP08 commitDigest')
    result.commitDigest = value.commitDigest
  }
  if (value.predecessorDigest !== undefined) {
    if (typeof value.predecessorDigest !== 'string' || !DIGEST_RE.test(value.predecessorDigest)) throw new Error('assistant-actions: invalid WP08 predecessorDigest')
    result.predecessorDigest = value.predecessorDigest
  }
  if (value.idempotencyKey !== undefined) {
    if (!validText(value.idempotencyKey, 256)) throw new Error('assistant-actions: invalid WP08 idempotencyKey')
    result.idempotencyKey = value.idempotencyKey
  }
  return Object.freeze(result)
}

export function normalizeBrokerWp08RequestContext(value: unknown): BrokerWp08RequestContext {
  if (!isPlainRecord(value)) throw new Error('assistant-actions: invalid WP08 request context')
  const allowedKeys = new Set(['destination', 'sensitivity', 'estimatedCostMicros', 'commitDigest', 'predecessorDigest', 'idempotencyKey'])
  if (Object.keys(value).some(key => !allowedKeys.has(key))) throw new Error('assistant-actions: unknown WP08 request context field')
  const result: {
    destination?: string
    sensitivity?: BrokerSensitivity
    estimatedCostMicros?: number
    commitDigest?: string
    predecessorDigest?: string
    idempotencyKey?: string
  } = {}
  if (value.destination !== undefined) {
    if (!validText(value.destination, 1024)) throw new Error('assistant-actions: invalid WP08 destination')
    result.destination = value.destination
  }
  if (value.sensitivity !== undefined) {
    if (!isBrokerSensitivity(value.sensitivity)) throw new Error('assistant-actions: invalid WP08 sensitivity')
    result.sensitivity = value.sensitivity
  }
  if (value.estimatedCostMicros !== undefined) {
    if (!isNonNegativeSafeInteger(value.estimatedCostMicros)) {
      throw new Error('assistant-actions: invalid WP08 estimatedCostMicros')
    }
    result.estimatedCostMicros = value.estimatedCostMicros
  }
  if (value.commitDigest !== undefined) {
    if (typeof value.commitDigest !== 'string' || !DIGEST_RE.test(value.commitDigest)) throw new Error('assistant-actions: invalid WP08 commitDigest')
    result.commitDigest = value.commitDigest
  }
  if (value.predecessorDigest !== undefined) {
    if (typeof value.predecessorDigest !== 'string' || !DIGEST_RE.test(value.predecessorDigest)) throw new Error('assistant-actions: invalid WP08 predecessorDigest')
    result.predecessorDigest = value.predecessorDigest
  }
  if (value.idempotencyKey !== undefined) {
    if (!validText(value.idempotencyKey, 256)) throw new Error('assistant-actions: invalid WP08 idempotencyKey')
    result.idempotencyKey = value.idempotencyKey
  }
  return Object.freeze(result)
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
}

function matchGlobPattern(pattern: string, value: string): boolean {
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

function hasAuthorityUserinfoAt(rawUrl: string): boolean {
  const sep = rawUrl.indexOf('://')
  if (sep < 0) return false
  const rest = rawUrl.slice(sep + 3)
  const end = rest.search(/[/?#]/u)
  const authority = end === -1 ? rest : rest.slice(0, end)
  return authority.includes('@')
}

function matchHttpUrlPattern(patternUrl: string, actualUrl: string): boolean {
  if (hasAuthorityUserinfoAt(patternUrl) || hasAuthorityUserinfoAt(actualUrl)) {
    return false
  }
  if (patternUrl.includes('#') || actualUrl.includes('#')) {
    return false
  }
  let expected: URL
  let actual: URL
  try {
    expected = new URL(patternUrl)
    actual = new URL(actualUrl)
  } catch {
    return false
  }
  if ((expected.protocol !== 'http:' && expected.protocol !== 'https:')
    || (actual.protocol !== 'http:' && actual.protocol !== 'https:')) {
    return false
  }
  if (expected.origin !== actual.origin) return false
  if (expected.username !== '' || expected.password !== '' || actual.username !== '' || actual.password !== '') {
    return false
  }
  if (expected.hash !== '' || actual.hash !== '') {
    return false
  }
  const hasQuery = expected.search !== '' || patternUrl.includes('?')
  const hasPathWildcard = expected.pathname.includes('*')
  if (hasQuery) {
    const pathMatches = hasPathWildcard
      ? matchGlobPattern(expected.pathname, actual.pathname)
      : actual.pathname === expected.pathname
    if (!pathMatches) return false
    if (expected.search === '') return actual.search === ''
    if (expected.search.includes('*')) return matchGlobPattern(expected.search, actual.search)
    return actual.search === expected.search
  }
  if (hasPathWildcard) {
    return matchGlobPattern(expected.pathname, actual.pathname)
  }
  if (actual.search !== '') return false
  return actual.pathname === expected.pathname
}

export function matchWp08Destination(pattern: string, actual: string): boolean {
  if (!validText(pattern, 1024) || !validText(actual, 1024)) return false
  if (pattern.startsWith('http://') || pattern.startsWith('https://')) {
    return matchHttpUrlPattern(pattern, actual)
  }
  if (pattern === actual) return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1)
    return actual.startsWith(prefix)
  }
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1)
    return actual.startsWith(prefix)
  }
  return false
}

export function evaluateBrokerWp08Constraints(
  constraints: BrokerWp08Constraints | undefined,
  request: BrokerWp08RequestContext,
  usage: BrokerWp08UsageState = { leaseUses: 0, spentCostMicros: 0 },
  now = Date.now(),
): BrokerWp08EvaluationResult {
  if (!isNonNegativeSafeInteger(now) || !isNonNegativeSafeInteger(usage.leaseUses) || !isNonNegativeSafeInteger(usage.spentCostMicros)) {
    return Object.freeze({ allowed: false, reasonCode: 'invalid-input', detail: 'invalid clock or usage state' })
  }
  if (!Number.isSafeInteger(usage.leaseUses + 1)) {
    return Object.freeze({ allowed: false, reasonCode: 'invalid-input', detail: 'leaseUses overflow' })
  }
  if (request.sensitivity !== undefined && !isBrokerSensitivity(request.sensitivity)) {
    return Object.freeze({ allowed: false, reasonCode: 'invalid-input', detail: 'request sensitivity is invalid' })
  }
  if (request.estimatedCostMicros !== undefined && !isNonNegativeSafeInteger(request.estimatedCostMicros)) {
    return Object.freeze({ allowed: false, reasonCode: 'invalid-input', detail: 'estimatedCostMicros must be a non-negative safe integer' })
  }
  const nextSpent = usage.spentCostMicros + (request.estimatedCostMicros ?? 0)
  if (!Number.isSafeInteger(nextSpent) || nextSpent < 0) {
    return Object.freeze({ allowed: false, reasonCode: 'invalid-input', detail: 'spentCostMicros overflow' })
  }
  if (!constraints) return Object.freeze({ allowed: true, reasonCode: 'allowed' })

  if (constraints.lease) {
    if (constraints.lease.revoked === true) {
      return Object.freeze({ allowed: false, reasonCode: 'lease-revoked', detail: 'lease is revoked' })
    }
    if (constraints.lease.expiresAtMs !== undefined && now >= constraints.lease.expiresAtMs) {
      return Object.freeze({ allowed: false, reasonCode: 'lease-expired', detail: 'lease has expired' })
    }
    if (constraints.lease.maxUses !== undefined && usage.leaseUses >= constraints.lease.maxUses) {
      return Object.freeze({ allowed: false, reasonCode: 'lease-exhausted', detail: 'lease maxUses reached' })
    }
  }

  if (constraints.destinations !== undefined) {
    if (!request.destination || !constraints.destinations.some(pattern => matchWp08Destination(pattern, request.destination!))) {
      return Object.freeze({ allowed: false, reasonCode: 'destination-mismatch', detail: 'request destination is outside allowed destinations' })
    }
  }

  if (constraints.maxSensitivity !== undefined) {
    if (!request.sensitivity || !isBrokerSensitivity(request.sensitivity)) {
      return Object.freeze({ allowed: false, reasonCode: 'sensitivity-exceeded', detail: 'request sensitivity missing or invalid' })
    }
    if (sensitivityRank(request.sensitivity) > sensitivityRank(constraints.maxSensitivity)) {
      return Object.freeze({ allowed: false, reasonCode: 'sensitivity-exceeded', detail: 'request sensitivity exceeds maxSensitivity' })
    }
  }

  if (constraints.monetaryCostCapMicros !== undefined) {
    if (!isNonNegativeSafeInteger(constraints.monetaryCostCapMicros)) {
      return Object.freeze({ allowed: false, reasonCode: 'invalid-input', detail: 'monetaryCostCapMicros must be a non-negative safe integer' })
    }
    if (nextSpent > constraints.monetaryCostCapMicros) {
      return Object.freeze({ allowed: false, reasonCode: 'cost-cap-exceeded', detail: 'monetaryCostCapMicros exceeded' })
    }
  }

  if (constraints.commitDigest !== undefined && request.commitDigest !== constraints.commitDigest) {
    return Object.freeze({ allowed: false, reasonCode: 'commit-digest-mismatch', detail: 'commitDigest does not match grant binding' })
  }

  if (constraints.predecessorDigest !== undefined) {
    if (request.predecessorDigest !== constraints.predecessorDigest) {
      return Object.freeze({ allowed: false, reasonCode: 'predecessor-digest-mismatch', detail: 'predecessorDigest does not match grant constraint' })
    }
    if (usage.lastSettledCommitDigest !== undefined && constraints.predecessorDigest !== usage.lastSettledCommitDigest) {
      return Object.freeze({ allowed: false, reasonCode: 'predecessor-digest-mismatch', detail: 'predecessorDigest does not match last settled commitDigest' })
    }
  } else if (request.predecessorDigest !== undefined && usage.lastSettledCommitDigest !== undefined && request.predecessorDigest !== usage.lastSettledCommitDigest) {
    return Object.freeze({ allowed: false, reasonCode: 'predecessor-digest-mismatch', detail: 'request predecessorDigest does not match last settled commitDigest' })
  }

  return Object.freeze({ allowed: true, reasonCode: 'allowed' })
}

export function evaluatePolicyWithWp08(
  policy: unknown,
  request: BrokerPolicyRequest,
  constraints?: BrokerWp08Constraints,
  usage: BrokerWp08UsageState = { leaseUses: 0, spentCostMicros: 0 },
  now = Date.now(),
): { effect: 'allow' | 'deny'; wp08: BrokerWp08EvaluationResult; policyDecision?: BrokerPolicyDecision } {
  const wp08 = evaluateBrokerWp08Constraints(constraints, request, usage, now)
  if (!wp08.allowed) return { effect: 'deny', wp08 }
  const port = policy as Partial<BrokerPolicyServicePort> | undefined
  if (!port || typeof port.evaluate !== 'function') {
    return { effect: 'deny', wp08 }
  }
  const policyDecision = port.evaluate(request)
  return { effect: policyDecision.effect, wp08, policyDecision }
}

export function authorizeAgentWithWp08(
  policy: unknown,
  agent: Agent | undefined,
  action: string,
  resource: BrokerPolicyResource,
  options: BrokerPolicyOptions,
  constraints?: BrokerWp08Constraints,
  usage: BrokerWp08UsageState = { leaseUses: 0, spentCostMicros: 0 },
  now = Date.now(),
): { effect: 'allow' | 'deny'; wp08: BrokerWp08EvaluationResult; policyDecision?: BrokerPolicyDecision } {
  const wp08 = evaluateBrokerWp08Constraints(constraints, options, usage, now)
  if (!wp08.allowed) return { effect: 'deny', wp08 }
  const port = policy as Partial<BrokerPolicyServicePort> | undefined
  if (!port || typeof port.authorizeAgent !== 'function') {
    return { effect: 'deny', wp08 }
  }
  const policyDecision = port.authorizeAgent(agent, action, resource, options)
  return { effect: policyDecision.effect, wp08, policyDecision }
}
