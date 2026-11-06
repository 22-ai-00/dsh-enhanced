import { createHash } from 'node:crypto'
import { ACCEPTANCE_CONTRACT_ID, acceptanceBindingIsUsable } from './acceptance-binding.ts'
import type {
  WorkItemAcceptanceBinding,
  WorkItemAcceptanceHandle,
  WorkItemAdmitInput,
  WorkItemDecisionRefusal,
  WorkItemExecuteDecision,
  WorkItemMandateBasis,
} from './types.ts'
import { WorkItemError } from './types.ts'

const DECISION_PROTOCOL = 'work-items/execute-decision/v1'
const MANDATE_PROTOCOL = 'work-items/mandate/v1'
/** Printable, no spaces; `decision:` + id must stay inside the 256-byte externalId cap. */
const DECISION_ID = /^[\x21-\x7e]{1,200}$/
const RULE_ID = /^[\x21-\x7e]{1,256}$/
const DIGEST = /^[0-9a-f]{64}$/
const MAX_BUDGET = 1_000_000_000

function fail(message: string): never {
  throw new WorkItemError('invalid-input', message)
}

function exactKeys(value: object, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field} contains unknown field ${key}`)
  }
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  return value as Record<string, unknown>
}

/** Normalized decision; mandate fields are re-validated by ordinary admission. */
export interface NormalizedExecuteDecision {
  readonly decisionId: string
  readonly origin: WorkItemExecuteDecision['origin']
  readonly mode: WorkItemExecuteDecision['mode']
  readonly policyRuleId: string | undefined
  readonly budgetRemaining: number
  readonly input: WorkItemAdmitInput
  /** Acceptance handle, resolved against the verifier by admission. */
  readonly acceptance: WorkItemAcceptanceHandle | undefined
}

/**
 * Structural validation of one execute decision. Pure and deterministic.
 *
 * Only the shape is checked here; kind/title/brief/binding normalization stays
 * with `WorkItemAdmission` so the two admission paths cannot drift.
 */
export function normalizeExecuteDecision(value: unknown): NormalizedExecuteDecision {
  const decision = plainObject(value, 'decision')
  exactKeys(decision, ['protocol', 'decisionId', 'verdict', 'origin', 'mode', 'policyRuleId', 'budgetRemaining', 'mandate', 'acceptance'], 'decision')
  if (decision['protocol'] !== DECISION_PROTOCOL) fail('decision.protocol is not supported')
  if (decision['verdict'] !== 'execute') fail('decision.verdict must be execute')
  const decisionId = decision['decisionId']
  if (typeof decisionId !== 'string' || !DECISION_ID.test(decisionId)) fail('decision.decisionId has an invalid shape')
  const origin = decision['origin']
  if (origin !== 'explicit' && origin !== 'inferred') fail('decision.origin must be explicit or inferred')
  const mode = decision['mode']
  if (mode !== 'observe' && mode !== 'auto') fail('decision.mode must be observe or auto')
  const rule = decision['policyRuleId']
  if (rule !== undefined && (typeof rule !== 'string' || !RULE_ID.test(rule))) fail('decision.policyRuleId has an invalid shape')
  const budget = decision['budgetRemaining']
  if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 0 || budget > MAX_BUDGET) {
    fail('decision.budgetRemaining must be a non-negative integer')
  }
  const mandate = plainObject(decision['mandate'], 'decision.mandate')
  exactKeys(mandate, ['kind', 'title', 'brief', 'originBindingId', 'acceptanceRef'], 'decision.mandate')
  for (const key of ['kind', 'title', 'brief', 'originBindingId', 'acceptanceRef'] as const) {
    if (typeof mandate[key] !== 'string') fail(`decision.mandate.${key} must be a string`)
  }
  let acceptance: WorkItemAcceptanceHandle | undefined
  if (decision['acceptance'] !== undefined) {
    const handle = plainObject(decision['acceptance'], 'decision.acceptance')
    exactKeys(handle, ['contractId', 'contractDigest'], 'decision.acceptance')
    const contractId = handle['contractId']
    if (typeof contractId !== 'string' || !ACCEPTANCE_CONTRACT_ID.test(contractId)) fail('decision.acceptance.contractId has an invalid shape')
    const contractDigest = handle['contractDigest']
    if (typeof contractDigest !== 'string' || !DIGEST.test(contractDigest)) fail('decision.acceptance.contractDigest must be a sha256 hex digest')
    acceptance = Object.freeze({ contractId, contractDigest })
  }
  return Object.freeze({
    decisionId,
    origin,
    mode,
    policyRuleId: rule as string | undefined,
    budgetRemaining: budget,
    acceptance,
    input: Object.freeze({
      kind: mandate['kind'] as string,
      externalId: decisionExternalId(decisionId),
      title: mandate['title'] as string,
      brief: mandate['brief'] as string,
      originBindingId: mandate['originBindingId'] as string,
      acceptanceRef: mandate['acceptanceRef'] as string,
    }),
  })
}

/** Stable external identity: the decision id alone decides the dedup key. */
export function decisionExternalId(decisionId: string): string {
  return `decision:${decisionId}`
}

/**
 * The inferred-execution gate. All three conditions must hold at once; an
 * explicit decision is not gated here (Policy and ordinary admission gates
 * still apply to it).
 */
export function decisionRefusal(decision: NormalizedExecuteDecision): WorkItemDecisionRefusal | undefined {
  if (decision.origin !== 'inferred') return undefined
  if (decision.mode !== 'auto') return 'inferred-requires-auto'
  if (decision.policyRuleId === undefined) return 'inferred-requires-rule'
  if (decision.budgetRemaining < 1) return 'budget-exhausted'
  return undefined
}

/**
 * Digest over the decision identity after admission normalized the mandate.
 *
 * Mode and remaining budget are admission-time facts, not identity: a replay
 * of the same decision after the budget moved must resolve to the same item,
 * while a different scope under the same id must not.
 */
export function mandateDigest(decision: NormalizedExecuteDecision, normalized: {
  readonly kind: string
  readonly title: string
  readonly brief: string
  readonly originBindingId: string
  readonly acceptanceRef: string | null
}): string {
  const canonical = JSON.stringify([
    MANDATE_PROTOCOL,
    decision.decisionId,
    decision.origin,
    decision.policyRuleId ?? null,
    normalized.kind,
    normalized.title,
    normalized.brief,
    normalized.originBindingId,
    normalized.acceptanceRef,
    // Appended only when bound, so every digest admitted before slice 4 is unchanged.
    ...(decision.acceptance === undefined ? [] : [['acceptance', decision.acceptance.contractId, decision.acceptance.contractDigest]]),
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function buildMandateBasis(
  decision: NormalizedExecuteDecision,
  digest: string,
  acceptance?: WorkItemAcceptanceBinding,
): WorkItemMandateBasis {
  return Object.freeze({
    protocol: MANDATE_PROTOCOL,
    decisionId: decision.decisionId,
    origin: decision.origin,
    mode: decision.mode,
    ...(decision.policyRuleId === undefined ? {} : { ruleId: decision.policyRuleId }),
    budgetRemaining: decision.budgetRemaining,
    digest,
    ...(acceptance === undefined ? {} : { acceptance }),
  })
}

/** Structural check of a stored mandate; anything else is a malformed basis. */
export function mandateIsUsable(value: unknown): value is WorkItemMandateBasis {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const mandate = value as Record<string, unknown>
  for (const key of Object.keys(mandate)) {
    if (!['protocol', 'decisionId', 'origin', 'mode', 'ruleId', 'budgetRemaining', 'digest', 'acceptance'].includes(key)) return false
  }
  const budget = mandate['budgetRemaining']
  const rule = mandate['ruleId']
  const usable = mandate['protocol'] === MANDATE_PROTOCOL
    && typeof mandate['decisionId'] === 'string' && DECISION_ID.test(mandate['decisionId'])
    && (mandate['origin'] === 'explicit' || mandate['origin'] === 'inferred')
    && (mandate['mode'] === 'observe' || mandate['mode'] === 'auto')
    && (rule === undefined || typeof rule === 'string' && RULE_ID.test(rule))
    && typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 0 && budget <= MAX_BUDGET
    && typeof mandate['digest'] === 'string' && DIGEST.test(mandate['digest'])
    && (mandate['acceptance'] === undefined || acceptanceBindingIsUsable(mandate['acceptance']))
  if (!usable) return false
  // An inferred mandate that could never have passed the gate is corrupt.
  return mandate['origin'] !== 'inferred' || mandate['mode'] === 'auto' && rule !== undefined && (budget as number) >= 1
}
