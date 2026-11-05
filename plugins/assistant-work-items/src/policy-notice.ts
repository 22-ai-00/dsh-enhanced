/**
 * WP21 slice 2: Policy-change notices and follow-up ownership.
 *
 * Both are deterministic projections over durable ledger state. A Policy
 * change never cancels, parks or wakes work: it only records, once per
 * (item, policyVersion), that a live item's frozen mandate basis no longer
 * matches what the current Policy decides. Dispatch re-verification
 * (`WorkItemAuthority.check`) stays the only gate that parks an item.
 */

import type { WorkItemAuthority } from './authority.js'
import type { WorkItemStore } from './store.js'
import type {
  WorkItemFollowUpInput,
  WorkItemPolicyChange,
  WorkItemPolicyChangeResult,
  WorkItemPolicyNotice,
} from './types.js'
import { OPEN_STATES, WorkItemError } from './types.js'

/** Upper bound on live items one notice pass reads; open items are capacity-bounded far below this. */
export const MAX_POLICY_NOTICE_ITEMS = 1000
const MAX_TOKEN = 256

function invalid(message: string): never {
  throw new WorkItemError('invalid-input', message)
}

/** Printable, bounded, non-empty identity token. */
function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(value)) {
    invalid(`${field} must be a printable token of 1-${MAX_TOKEN} characters`)
  }
  return value
}

function exactKeys(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${what} must be an object`)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!keys.includes(key)) invalid(`${what} has unknown field ${key}`)
  return record
}

export function normalizePolicyChange(value: unknown): WorkItemPolicyChange {
  const record = exactKeys(value, ['protocol', 'policyVersion'], 'policy change')
  if (record['protocol'] !== 'work-items/policy-change/v1') invalid('policy change protocol is not work-items/policy-change/v1')
  return Object.freeze({ protocol: 'work-items/policy-change/v1', policyVersion: token(record['policyVersion'], 'policyVersion') })
}

export function normalizeFollowUp(value: unknown): WorkItemFollowUpInput {
  const record = exactKeys(value, ['protocol', 'itemId', 'bindingId', 'messageId', 'sourceDigest'], 'follow-up')
  if (record['protocol'] !== 'work-items/follow-up/v1') invalid('follow-up protocol is not work-items/follow-up/v1')
  return Object.freeze({
    protocol: 'work-items/follow-up/v1',
    itemId: token(record['itemId'], 'itemId'),
    bindingId: token(record['bindingId'], 'bindingId'),
    messageId: token(record['messageId'], 'messageId'),
    sourceDigest: token(record['sourceDigest'], 'sourceDigest'),
  })
}

/**
 * Compute which live items a Policy version affects and record one durable
 * notice per affected item.
 *
 * Idempotent across restarts: the notice is keyed by (item, policyVersion) in
 * the ledger, so replaying the same version writes nothing new. Items Policy
 * cannot answer for are reported and retried by the next call with the same
 * version. No item state, lease or dispatch is touched.
 */
export function noticePolicyChange(
  store: WorkItemStore,
  authority: WorkItemAuthority,
  change: WorkItemPolicyChange,
): WorkItemPolicyChangeResult {
  const items = store.listItems({ states: OPEN_STATES, limit: MAX_POLICY_NOTICE_ITEMS })
  const notified: WorkItemPolicyNotice[] = []
  const alreadyNotified: string[] = []
  const unavailable: string[] = []
  let unaffected = 0
  let legacy = 0
  // Oldest first so the notice order is stable for the same ledger. Assess
  // everything before writing, so a peer that cannot evaluate at all leaves
  // the ledger untouched (malformed bases are judged locally and would
  // otherwise be written first).
  const assessed = [...items].reverse().map(item => ({ item, assessment: authority.assess(item) }))
  for (const { assessment } of assessed) {
    if (assessment.kind === 'unavailable' && (assessment.detail === 'missing-policy' || assessment.detail === 'missing-evaluate')) {
      return Object.freeze({ outcome: 'unavailable', detail: assessment.detail })
    }
  }
  for (const { item, assessment } of assessed) {
    if (assessment.kind === 'unavailable') { unavailable.push(item.id); continue }
    if (assessment.kind === 'legacy') { legacy += 1; continue }
    if (assessment.kind === 'allow') { unaffected += 1; continue }
    const basis = item.authority
    const recorded = store.recordPolicyNotice(item.id, {
      policyVersion: change.policyVersion,
      reasonCode: assessment.reasonCode,
      frozenRuleId: basis?.mandate?.ruleId ?? basis?.ruleId ?? null,
      currentRuleId: assessment.currentRuleId,
      decisionId: basis?.mandate?.decisionId ?? null,
    })
    if (recorded === undefined) alreadyNotified.push(item.id)
    else notified.push(recorded)
  }
  return Object.freeze({
    outcome: 'noticed',
    policyVersion: change.policyVersion,
    notified: Object.freeze(notified),
    alreadyNotified: Object.freeze(alreadyNotified),
    unaffected,
    legacy,
    unavailable: Object.freeze(unavailable),
  })
}
