import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { MALFORMED_AUTHORITY_REASON, MANDATE_RULE_CHANGED_REASON, WorkItemAuthority } from '../src/authority.ts'
import { normalizeFollowUp, normalizePolicyChange, noticePolicyChange } from '../src/policy-notice.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemExecuteDecision, WorkItemRecord } from '../src/types.ts'
import { claim, harness, report, type Harness } from './fixtures.ts'

const RULE = 'inferred-review-admit'

function inferred(decisionId: string, overrides: Partial<WorkItemExecuteDecision> = {}): WorkItemExecuteDecision {
  return {
    protocol: 'work-items/execute-decision/v1',
    decisionId,
    verdict: 'execute',
    origin: 'inferred',
    mode: 'auto',
    budgetRemaining: 3,
    policyRuleId: RULE,
    mandate: {
      kind: 'review',
      title: `Review ${decisionId}`,
      brief: 'Find why the deploy step failed twice and report.',
      originBindingId: 'binding-origin-1',
      acceptanceRef: 'tac:deploy-review/v1',
    },
    ...overrides,
  }
}

function allowBy(fixture: Harness, ruleId: string | undefined): void {
  fixture.policy.decision = { effect: 'allow', reasonCode: 'rule-allow', ...(ruleId === undefined ? {} : { ruleId }) }
}

function admit(fixture: Harness, decisionId: string): WorkItemRecord {
  const result = fixture.admission.admitDecision(inferred(decisionId))
  if (result.outcome === 'refused') throw new Error(`refused: ${result.reasonCode}`)
  return result.item
}

const change = (policyVersion: string) => normalizePolicyChange({ protocol: 'work-items/policy-change/v1', policyVersion })

/** Snapshot every field a notice must never touch. */
function liveShape(item: WorkItemRecord | undefined) {
  return item === undefined ? undefined : {
    state: item.state, stateReason: item.stateReason, attempt: item.attempt,
    leaseUntil: item.leaseUntil, leaseRunId: item.leaseRunId, authority: item.authority,
  }
}

function tamper(fixture: Harness, sql: string, ...parameters: Array<string | null>): void {
  const db = new DatabaseSync(fixture.config.databasePath)
  try { db.prepare(sql).run(...parameters) } finally { db.close() }
}

describe('policy-change notices (WP21 slice 2)', () => {
  test('a rule change notifies affected live items once per version and never cancels them', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const queued = admit(fixture, 'decision-queued')
    const claimed = admit(fixture, 'decision-claimed')
    claim(fixture, claimed.id)
    const ended = admit(fixture, 'decision-ended')
    claim(fixture, ended.id)
    report(fixture, ended.id, 'ready')
    const before = [queued, claimed].map(item => liveShape(fixture.store.findItemById(item.id)))
    const authorizeCalls = fixture.policy.requests.length

    allowBy(fixture, 'broad-allow')
    const result = noticePolicyChange(fixture.store, fixture.authority, change('policy-v2'))
    expect(result.outcome).toBe('noticed')
    if (result.outcome !== 'noticed') return
    expect(result.notified.map(notice => notice.itemId)).toEqual([queued.id, claimed.id])
    expect(result.notified[0]).toMatchObject({
      policyVersion: 'policy-v2', reasonCode: MANDATE_RULE_CHANGED_REASON,
      frozenRuleId: RULE, currentRuleId: 'broad-allow', decisionId: 'decision-queued',
    })
    expect(result).toMatchObject({ alreadyNotified: [], unaffected: 0, legacy: 0, unavailable: [] })
    // Terminal items are not live work and are never notified.
    expect(fixture.store.policyNotices(ended.id)).toEqual([])
    // No cancel, park, lease change or Policy side effect.
    expect([queued, claimed].map(item => liveShape(fixture.store.findItemById(item.id)))).toEqual(before)
    expect(fixture.policy.requests.length).toBe(authorizeCalls)
    expect(fixture.policy.evaluations.length).toBe(2)

    const replay = noticePolicyChange(fixture.store, fixture.authority, change('policy-v2'))
    expect(replay).toMatchObject({ outcome: 'noticed', notified: [], alreadyNotified: [queued.id, claimed.id] })
    expect(fixture.store.policyNotices(queued.id)).toHaveLength(1)

    // A further version is a further notice.
    const next = noticePolicyChange(fixture.store, fixture.authority, change('policy-v3'))
    expect(next.outcome === 'noticed' && next.notified.length).toBe(2)
    expect(fixture.store.policyNotices(queued.id).map(notice => notice.policyVersion)).toEqual(['policy-v2', 'policy-v3'])
  })

  test('notices are durable and idempotent across a store restart', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const item = admit(fixture, 'decision-restart')
    fixture.policy.deny('owner-revoked')
    const first = noticePolicyChange(fixture.store, fixture.authority, change('rev-7'))
    expect(first).toMatchObject({ outcome: 'noticed', notified: [{ itemId: item.id, reasonCode: 'owner-revoked', currentRuleId: null }] })

    const reopened = new WorkItemStore(fixture.config.databasePath, { now: fixture.now })
    try {
      const authority = new WorkItemAuthority({ policy: () => fixture.policy.service })
      const replay = noticePolicyChange(reopened, authority, change('rev-7'))
      expect(replay).toMatchObject({ outcome: 'noticed', notified: [], alreadyNotified: [item.id] })
      expect(reopened.policyNotices(item.id)).toEqual(first.outcome === 'noticed' ? first.notified : [])
      expect(reopened.findItemById(item.id)?.state).toBe('queued')
    } finally {
      reopened.close()
    }
  })

  test('unaffected, legacy and malformed bases are classified deterministically', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const holds = admit(fixture, 'decision-holds')
    const legacy = admit(fixture, 'decision-legacy')
    const malformed = admit(fixture, 'decision-malformed')
    tamper(fixture, 'UPDATE work_item SET authority_basis = NULL WHERE id = ?', legacy.id)
    const forged = { ...malformed.authority!, mandate: { ...malformed.authority!.mandate!, digest: 'not-a-digest' } }
    tamper(fixture, 'UPDATE work_item SET authority_basis = ? WHERE id = ?', JSON.stringify(forged), malformed.id)

    const result = noticePolicyChange(fixture.store, fixture.authority, change('v2'))
    expect(result).toMatchObject({ outcome: 'noticed', unaffected: 1, legacy: 1, unavailable: [] })
    if (result.outcome !== 'noticed') return
    expect(result.notified).toHaveLength(1)
    expect(result.notified[0]).toMatchObject({ itemId: malformed.id, reasonCode: MALFORMED_AUTHORITY_REASON })
    expect(fixture.store.policyNotices(holds.id)).toEqual([])
  })

  test('a Policy peer that cannot evaluate writes nothing; a thrown evaluation is retried later', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const item = admit(fixture, 'decision-unavailable')
    const malformed = admit(fixture, 'decision-local')
    tamper(fixture, 'UPDATE work_item SET authority_basis = ? WHERE id = ?',
      JSON.stringify({ ...malformed.authority!, protocol: 'other/v1' }), malformed.id)

    const none = new WorkItemAuthority({ policy: () => undefined })
    expect(noticePolicyChange(fixture.store, none, change('v2'))).toEqual({ outcome: 'unavailable', detail: 'missing-policy' })
    const older = new WorkItemAuthority({ policy: () => ({ authorize: fixture.policy.service.authorize }) })
    expect(noticePolicyChange(fixture.store, older, change('v2'))).toEqual({ outcome: 'unavailable', detail: 'missing-evaluate' })
    // The locally-judged malformed item was not written ahead of the refusal.
    expect(fixture.store.policyNotices(malformed.id)).toEqual([])

    fixture.policy.failure = new Error('policy offline')
    const partial = noticePolicyChange(fixture.store, fixture.authority, change('v2'))
    expect(partial).toMatchObject({ outcome: 'noticed', unavailable: [item.id] })
    fixture.policy.failure = null
    allowBy(fixture, 'broad-allow')
    const retried = noticePolicyChange(fixture.store, fixture.authority, change('v2'))
    expect(retried).toMatchObject({ outcome: 'noticed', notified: [{ itemId: item.id }], alreadyNotified: [malformed.id] })
  })

  test('policy change input is strict', () => {
    for (const bad of [null, {}, { protocol: 'work-items/policy-change/v1' },
      { protocol: 'other/v1', policyVersion: 'v' }, { protocol: 'work-items/policy-change/v1', policyVersion: 'has space' },
      { protocol: 'work-items/policy-change/v1', policyVersion: 'x'.repeat(257) },
      { protocol: 'work-items/policy-change/v1', policyVersion: 'v', extra: 1 }]) {
      expect(() => normalizePolicyChange(bad)).toThrow(expect.objectContaining({ code: 'invalid-input' }))
    }
  })
})

function followUp(itemId: string, messageId: string, overrides: Record<string, unknown> = {}) {
  return normalizeFollowUp({
    protocol: 'work-items/follow-up/v1', itemId, bindingId: 'binding-origin-1', messageId, sourceDigest: `sha256:${messageId}`, ...overrides,
  })
}

describe('follow-up ownership (WP21 slice 2)', () => {
  test('a live item owns its thread follow-ups; replay is idempotent; other identities mismatch', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const item = admit(fixture, 'decision-follow')
    const other = admit(fixture, 'decision-other')
    const owned = fixture.store.ownFollowUp(followUp(item.id, 'msg-1'))
    expect(owned).toMatchObject({ outcome: 'owned', followUp: { itemId: item.id, messageId: 'msg-1', state: 'owned', settledAt: null } })
    expect(fixture.store.ownFollowUp(followUp(item.id, 'msg-1'))).toMatchObject({ outcome: 'already-owned' })
    expect(() => fixture.store.ownFollowUp(followUp(item.id, 'msg-1', { sourceDigest: 'sha256:edited' })))
      .toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(() => fixture.store.ownFollowUp(followUp(other.id, 'msg-1')))
      .toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(() => fixture.store.ownFollowUp(followUp(item.id, 'msg-2', { bindingId: 'binding-elsewhere' })))
      .toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(() => fixture.store.ownFollowUp(followUp('missing-item', 'msg-3')))
      .toThrow(expect.objectContaining({ code: 'not-found' }))
    expect(fixture.store.followUps(item.id)).toHaveLength(1)
    expect(fixture.store.followUps(other.id)).toEqual([])
    // Ownership never changes the item itself.
    expect(fixture.store.findItemById(item.id)?.state).toBe('queued')
  })

  test('when the item ends, unprocessed follow-ups are released to judgment exactly once', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const item = admit(fixture, 'decision-release')
    fixture.store.ownFollowUp(followUp(item.id, 'msg-done'))
    fixture.store.ownFollowUp(followUp(item.id, 'msg-open'))
    claim(fixture, item.id)
    expect(fixture.store.markFollowUpProcessed(item.id, 'msg-done')).toMatchObject({ state: 'processed' })
    expect(fixture.store.markFollowUpProcessed(item.id, 'msg-done')).toMatchObject({ state: 'processed' })
    // A live item releases nothing.
    expect(fixture.store.releaseEndedFollowUps()).toEqual([])
    report(fixture, item.id, 'blocked')

    // Before the sweep the item can no longer process what it did not settle.
    expect(() => fixture.store.markFollowUpProcessed(item.id, 'msg-open')).toThrow(expect.objectContaining({ code: 'invalid-state' }))
    // An ended item takes no new follow-up and writes nothing.
    expect(fixture.store.ownFollowUp(followUp(item.id, 'msg-late'))).toEqual({ outcome: 'item-ended', itemId: item.id, state: 'blocked' })

    const released = fixture.store.releaseEndedFollowUps()
    expect(released).toEqual([expect.objectContaining({ messageId: 'msg-open', state: 'released', releasedFrom: 'blocked' })])
    expect(fixture.store.releaseEndedFollowUps()).toEqual([])
    expect(fixture.store.followUps(item.id).map(record => [record.messageId, record.state]))
      .toEqual([['msg-done', 'processed'], ['msg-open', 'released']])
    // Replaying an already-owned id after the end reports its settled record.
    expect(fixture.store.ownFollowUp(followUp(item.id, 'msg-open'))).toMatchObject({ outcome: 'already-owned', followUp: { state: 'released' } })
    expect(fixture.store.findItemById(item.id)?.state).toBe('blocked')
  })

  test('release state survives a restart and pages in release order', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const first = admit(fixture, 'decision-a')
    const second = admit(fixture, 'decision-b')
    fixture.store.ownFollowUp(followUp(first.id, 'msg-a'))
    fixture.store.ownFollowUp(followUp(second.id, 'msg-b'))
    for (const item of [first, second]) { claim(fixture, item.id); report(fixture, item.id, 'failed') }

    const reopened = new WorkItemStore(fixture.config.databasePath, { now: fixture.now })
    try {
      // The sweep is derived from durable state, so a cold store still releases.
      expect(reopened.releaseEndedFollowUps(1).map(record => record.messageId)).toEqual(['msg-a'])
      fixture.advance(1)
      expect(reopened.releaseEndedFollowUps().map(record => record.messageId)).toEqual(['msg-b'])
      const page = reopened.listReleasedFollowUps({ limit: 1 })
      expect(page.items.map(record => record.messageId)).toEqual(['msg-a'])
      expect(page.next).not.toBeNull()
      const rest = reopened.listReleasedFollowUps({ limit: 1, after: page.next! })
      expect(rest.items.map(record => record.messageId)).toEqual(['msg-b'])
      expect(rest.next).toBeNull()
    } finally {
      reopened.close()
    }
    expect(fixture.store.releaseEndedFollowUps()).toEqual([])
  })

  test('follow-up input is strict', () => {
    for (const bad of [null, { protocol: 'work-items/follow-up/v1' },
      { protocol: 'work-items/follow-up/v1', itemId: 'i', bindingId: 'b', messageId: 'm', sourceDigest: 'd', text: 'hi' },
      { protocol: 'other/v1', itemId: 'i', bindingId: 'b', messageId: 'm', sourceDigest: 'd' },
      { protocol: 'work-items/follow-up/v1', itemId: '', bindingId: 'b', messageId: 'm', sourceDigest: 'd' }]) {
      expect(() => normalizeFollowUp(bad)).toThrow(expect.objectContaining({ code: 'invalid-input' }))
    }
  })
})
