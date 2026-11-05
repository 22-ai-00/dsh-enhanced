import type { PeerPolicyDecision, PeerPolicyRequest, PeerPolicyService } from './peers.ts'
import type { WorkItemAuthorityBasis, WorkItemMandateBasis, WorkItemRecord } from './types.ts'
import { decisionExternalId, mandateIsUsable } from './mandate.ts'

/** Literal marker for the persisted basis; anything else is malformed. */
const AUTHORITY_PROTOCOL = 'work-items/authority/v1'
/** Synthetic reason for a stored basis this host cannot trust structurally. */
export const MALFORMED_AUTHORITY_REASON = 'malformed-basis'
/** A decision-admitted item whose named Policy rule no longer is the one allowing it. */
export const MANDATE_RULE_CHANGED_REASON = 'mandate-rule-changed'

/**
 * Outcome of re-validating one item's admission decision.
 *
 * `legacy` is an item admitted before schema v7: it has no persisted basis, so
 * the gate must not invent one. `allow` and `legacy` may proceed; `revoked` and
 * `unavailable` must park the item without dispatching it.
 */
export type AuthorityCheck =
  | Readonly<{ kind: 'allow' }>
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{ kind: 'revoked'; reasonCode: string }>
  | Readonly<{ kind: 'unavailable'; detail: string }>

/** One peer failure rendered as a bounded, path-free detail string. */
function describe(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    if ('code' in error && typeof (error as { code: unknown }).code === 'string') {
      return String((error as { code: string }).code).slice(0, 128)
    }
    if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
      return String((error as { message: string }).message).slice(0, 128)
    }
  }
  return 'unknown'
}

/** Rebuild the exact admission request the decision was made for. */
function requestOf(basis: WorkItemAuthorityBasis): PeerPolicyRequest {
  return Object.freeze({
    subject: Object.freeze({
      kind: 'background' as const,
      id: basis.sourceId,
      workspace: basis.workspace,
      principal: basis.principal,
    }),
    action: 'admit',
    resource: Object.freeze({ kind: 'automation' as const, id: basis.automationId }),
    context: Object.freeze({ initiator: 'background' as const }),
  })
}

/** A structurally usable basis: every frozen field present and bounded. */
function basisIsUsable(basis: WorkItemAuthorityBasis): boolean {
  const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 512
  return basis.protocol === AUTHORITY_PROTOCOL
    && basis.action === 'admit'
    && basis.subjectKind === 'background'
    && basis.resourceKind === 'automation'
    && basis.effect === 'allow'
    && text(basis.sourceId)
    && text(basis.automationId)
    && text(basis.workspace)
    && text(basis.principal)
    && text(basis.reasonCode)
    && text(basis.idempotencyKey)
    && typeof basis.checkedAt === 'number'
    && Number.isSafeInteger(basis.checkedAt)
    && basis.checkedAt > 0
    && (basis.ruleId === undefined || text(basis.ruleId))
    && (basis.mandate === undefined || mandateIsUsable(basis.mandate)
      // A decision that named a rule is only valid under the exact rule Policy allowed it by.
      && (basis.mandate.ruleId === undefined || basis.mandate.ruleId === basis.ruleId))
}

/**
 * Freeze one allow decision as the item's audit-only admission basis.
 *
 * The request, not the live configuration, is the source of the frozen
 * subject/resource identifiers: the basis must replay exactly what admission
 * asked, even if `intakeSourceId` changes afterwards.
 */
export function buildAuthorityBasis(input: {
  readonly request: PeerPolicyRequest
  readonly decision: PeerPolicyDecision
  readonly sourceId: string
  readonly automationId: string
  readonly idempotencyKey: string
  readonly checkedAt: number
  readonly mandate?: WorkItemMandateBasis
}): WorkItemAuthorityBasis {
  const ruleId = input.decision.ruleId
  return Object.freeze({
    protocol: AUTHORITY_PROTOCOL,
    action: 'admit',
    subjectKind: 'background',
    sourceId: input.sourceId,
    automationId: input.automationId,
    workspace: input.request.subject.workspace ?? '',
    principal: input.request.subject.principal ?? '',
    resourceKind: 'automation',
    effect: 'allow',
    reasonCode: input.decision.reasonCode,
    ...(ruleId === undefined ? {} : { ruleId }),
    idempotencyKey: input.idempotencyKey,
    checkedAt: input.checkedAt,
    ...(input.mandate === undefined ? {} : { mandate: input.mandate }),
  })
}

/** Outcome of the side-effect-free {@link WorkItemAuthority.assess}. */
export type AuthorityAssessment =
  | Readonly<{ kind: 'allow' }>
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{ kind: 'affected'; reasonCode: string; currentRuleId: string | null }>
  | Readonly<{ kind: 'unavailable'; detail: string }>

/** Run one Policy call; a thrown or malformed answer proves nothing about the mandate. */
function decide(call: () => PeerPolicyDecision):
  Readonly<{ kind: 'decided'; decision: PeerPolicyDecision }> | Readonly<{ kind: 'unavailable'; detail: string }> {
  let decision: PeerPolicyDecision
  try {
    decision = call()
  } catch (error) {
    // A thrown peer call (including an idempotency conflict with another
    // caller) proves nothing about the mandate, so it cannot revoke it.
    return Object.freeze({ kind: 'unavailable', detail: describe(error) })
  }
  if (decision === null || typeof decision !== 'object'
    || (decision.effect !== 'allow' && decision.effect !== 'deny')
    || typeof decision.reasonCode !== 'string') {
    return Object.freeze({ kind: 'unavailable', detail: 'malformed-decision' })
  }
  return Object.freeze({ kind: 'decided', decision })
}

/** Compare a well-formed decision with the frozen basis it re-verifies. */
function compare(basis: WorkItemAuthorityBasis, decision: PeerPolicyDecision):
  Readonly<{ kind: 'allow' }> | Readonly<{ kind: 'revoked'; reasonCode: string; currentRuleId: string | null }> {
  const currentRuleId = typeof decision.ruleId === 'string' ? decision.ruleId : null
  if (decision.effect !== 'allow') {
    const reasonCode = decision.reasonCode.length === 0 ? 'default-deny' : decision.reasonCode
    return Object.freeze({ kind: 'revoked', reasonCode, currentRuleId: null })
  }
  // A mandate admitted under a named rule (always so for inferred work) is
  // re-verified against that rule, not against whatever now allows: a broader
  // rule added later must not silently widen what the decision relied on.
  const ruleId = basis.mandate?.ruleId
  if (ruleId !== undefined && decision.ruleId !== ruleId) {
    return Object.freeze({ kind: 'revoked', reasonCode: MANDATE_RULE_CHANGED_REASON, currentRuleId })
  }
  return Object.freeze({ kind: 'allow' })
}

/**
 * Re-run the admission decision before an item is ever claimed or woken.
 *
 * Policy stays the only authority: an `allow` here means the same request with
 * the same idempotency key still allows, not that this record grants anything.
 * Every failure mode is fail-closed but *not* terminal: a deny, a missing peer,
 * a thrown peer error or an unreadable stored basis is reported so the caller
 * can park the item in `waiting` and leave it resumable under the same mandate.
 */
export class WorkItemAuthority {
  readonly #policy: () => PeerPolicyService | undefined

  constructor(options: { policy: () => PeerPolicyService | undefined }) {
    this.#policy = options.policy
  }

  check(item: WorkItemRecord): AuthorityCheck {
    const basis = item.authority
    if (basis === null) return Object.freeze({ kind: 'legacy' })
    if (!basisIsUsable(basis)
      // A mandate belongs to exactly the item its decision id names.
      || basis.mandate !== undefined && item.externalId !== decisionExternalId(basis.mandate.decisionId)) {
      return Object.freeze({ kind: 'revoked', reasonCode: MALFORMED_AUTHORITY_REASON })
    }
    const policy = this.#policy()
    if (policy === undefined) return Object.freeze({ kind: 'unavailable', detail: 'missing-policy' })
    const decided = decide(() => policy.authorize(requestOf(basis), { idempotencyKey: basis.idempotencyKey }))
    if (decided.kind === 'unavailable') return decided
    const verdict = compare(basis, decided.decision)
    return verdict.kind === 'allow'
      ? Object.freeze({ kind: 'allow' })
      : Object.freeze({ kind: 'revoked', reasonCode: verdict.reasonCode })
  }

  /**
   * Side-effect-free counterpart of {@link check} for Policy-change notices.
   *
   * Uses `evaluate` (no audit row, no budget reservation) so computing which
   * live items a new Policy version affects never consumes or records
   * anything at the Policy peer. Same rule comparison as dispatch
   * re-verification; only a budget charge that `authorize` would add at claim
   * time is outside what a notice can predict.
   */
  assess(item: WorkItemRecord): AuthorityAssessment {
    const basis = item.authority
    if (basis === null) return Object.freeze({ kind: 'legacy' })
    if (!basisIsUsable(basis)) {
      return Object.freeze({ kind: 'affected', reasonCode: MALFORMED_AUTHORITY_REASON, currentRuleId: null })
    }
    const policy = this.#policy()
    if (policy === undefined) return Object.freeze({ kind: 'unavailable', detail: 'missing-policy' })
    const evaluate = policy.evaluate
    if (typeof evaluate !== 'function') return Object.freeze({ kind: 'unavailable', detail: 'missing-evaluate' })
    const decided = decide(() => evaluate.call(policy, requestOf(basis)))
    if (decided.kind === 'unavailable') return decided
    const verdict = compare(basis, decided.decision)
    if (verdict.kind === 'allow') return Object.freeze({ kind: 'allow' })
    return Object.freeze({ kind: 'affected', reasonCode: verdict.reasonCode, currentRuleId: verdict.currentRuleId })
  }
}
