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
import { WorkItemError } from './types.js'

/** Upper bound on live items one notice call assesses; larger ledgers continue via `next`. */
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
  const record = exactKeys(value, ['protocol', 'policyVersion', 'after'], 'policy change')
  if (record['protocol'] !== 'work-items/policy-change/v1') invalid('policy change protocol is not work-items/policy-change/v1')
  const policyVersion = token(record['policyVersion'], 'policyVersion')
  if (record['after'] === undefined) return Object.freeze({ protocol: 'work-items/policy-change/v1', policyVersion })
  const after = exactKeys(record['after'], ['createdAt', 'id'], 'policy change cursor')
  const createdAt = after['createdAt']
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) invalid('cursor createdAt must be a non-negative integer')
  return Object.freeze({
    protocol: 'work-items/policy-change/v1',
    policyVersion,
    after: Object.freeze({ createdAt, id: token(after['id'], 'cursor id') }),
  })
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
 *
 * One call assesses at most {@link MAX_POLICY_NOTICE_ITEMS} live items in
 * admission order; it never truncates silently: `remaining` counts the live
 * items after the page and `next` continues the pass.
 */
export function noticePolicyChange(
  store: WorkItemStore,
  authority: WorkItemAuthority,
  change: WorkItemPolicyChange,
  pageSize: number = MAX_POLICY_NOTICE_ITEMS,
): WorkItemPolicyChangeResult {
  // A peer that cannot evaluate at all leaves the ledger untouched, including
  // locally-judged malformed bases that need no Policy call.
  const missing = authority.assessUnavailable()
  if (missing !== null) return Object.freeze({ outcome: 'unavailable', detail: missing })
  const limit = Math.max(1, Math.min(Math.trunc(pageSize), MAX_POLICY_NOTICE_ITEMS))
  const page = store.listLiveItemsPage({ ...(change.after === undefined ? {} : { after: change.after }), limit })
  const notified: WorkItemPolicyNotice[] = []
  const alreadyNotified: string[] = []
  const unavailable: string[] = []
  let unaffected = 0
  let legacy = 0
  // Assess everything first (evaluate is side-effect free), then write every
  // affected notice in one transaction.
  const affected: Array<Readonly<{ itemId: string; notice: Omit<WorkItemPolicyNotice, 'itemId' | 'recordedAt' | 'policyVersion'> }>> = []
  for (const item of page.items) {
    const assessment = authority.assess(item)
    if (assessment.kind === 'unavailable') { unavailable.push(item.id); continue }
    if (assessment.kind === 'legacy') { legacy += 1; continue }
    if (assessment.kind === 'allow') { unaffected += 1; continue }
    const basis = item.authority
    affected.push(Object.freeze({
      itemId: item.id,
      notice: Object.freeze({
        reasonCode: assessment.reasonCode,
        frozenRuleId: basis?.mandate?.ruleId ?? basis?.ruleId ?? null,
        currentRuleId: assessment.currentRuleId,
        decisionId: basis?.mandate?.decisionId ?? null,
      }),
    }))
  }
  const recorded = store.recordPolicyNotices(change.policyVersion, affected)
  recorded.forEach((notice, index) => {
    if (notice === undefined) alreadyNotified.push(affected[index]!.itemId)
    else notified.push(notice)
  })
  const last = page.items.at(-1)
  const next = page.remaining > 0 && last !== undefined ? Object.freeze({ createdAt: last.createdAt, id: last.id }) : null
  return Object.freeze({
    outcome: 'noticed',
    policyVersion: change.policyVersion,
    notified: Object.freeze(notified),
    alreadyNotified: Object.freeze(alreadyNotified),
    unaffected,
    legacy,
    unavailable: Object.freeze(unavailable),
    next,
    remaining: page.remaining,
  })
}
