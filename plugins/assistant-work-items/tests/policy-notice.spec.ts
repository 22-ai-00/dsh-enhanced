import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { MALFORMED_AUTHORITY_REASON, MANDATE_RULE_CHANGED_REASON, WorkItemAuthority } from '../src/authority.ts'
import { normalizeFollowUp, normalizePolicyChange, noticePolicyChange } from '../src/policy-notice.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemExecuteDecision, WorkItemRecord } from '../src/types.ts'
import { admitted, claim, fakeAcceptance, harness, report, type Harness } from './fixtures.ts'

const RULE = 'inferred-review-admit'
const acceptance = fakeAcceptance()
const handles = new Map<string, ReturnType<typeof acceptance.handle>>()
const harnessWithAcceptance = (overrides: Parameters<typeof harness>[0] = {}) =>
  harness(overrides, { verifier: () => acceptance.service })

function inferred(decisionId: string, overrides: Partial<WorkItemExecuteDecision> = {}): WorkItemExecuteDecision {
  let acceptanceHandle = handles.get(decisionId)
  if (acceptanceHandle === undefined) {
    acceptanceHandle = acceptance.handle()
    handles.set(decisionId, acceptanceHandle)
  }
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
    acceptance: acceptanceHandle,
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
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, RULE)
    const queued = admit(fixture, 'decision-queued')
    // Notices follow admission order; same-millisecond items tie on random ids.
    fixture.advance(1)
    const claimed = admit(fixture, 'decision-claimed')
    claim(fixture, claimed.id)
    const ended = admit(fixture, 'decision-ended')
    claim(fixture, ended.id)
    report(fixture, ended.id, 'ready')
    const before = [queued, claimed].map(item => liveShape(fixture.store.findItemById(item.id)))
    const authorizeCalls = fixture.policy.requests.length
    // Admission itself compares the named rule via evaluate first (slice 1).
    const evaluateCalls = fixture.policy.evaluations.length

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
    expect(fixture.policy.evaluations.length - evaluateCalls).toBe(2)

    const replay = noticePolicyChange(fixture.store, fixture.authority, change('policy-v2'))
    expect(replay).toMatchObject({ outcome: 'noticed', notified: [], alreadyNotified: [queued.id, claimed.id] })
    expect(fixture.store.policyNotices(queued.id)).toHaveLength(1)

    // A further version is a further notice.
    const next = noticePolicyChange(fixture.store, fixture.authority, change('policy-v3'))
    expect(next.outcome === 'noticed' && next.notified.length).toBe(2)
    expect(fixture.store.policyNotices(queued.id).map(notice => notice.policyVersion)).toEqual(['policy-v2', 'policy-v3'])
  })

  test('notices are durable and idempotent across a store restart', async () => {
    const fixture = await harnessWithAcceptance()
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
    const fixture = await harnessWithAcceptance()
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
    const fixture = await harnessWithAcceptance()
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

  test('a mandate that does not name its item is malformed for notices exactly as at dispatch', async () => {
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, RULE)
    const item = admit(fixture, 'decision-own')
    const donor = admit(fixture, 'decision-donor')
    // A well-formed basis copied from another item: usable alone, but not this item's.
    tamper(fixture, 'UPDATE work_item SET authority_basis = (SELECT authority_basis FROM work_item WHERE id = ?) WHERE id = ?', donor.id, item.id)
    const moved = fixture.store.findItemById(item.id)!
    expect(fixture.authority.check(moved)).toMatchObject({ kind: 'revoked', reasonCode: MALFORMED_AUTHORITY_REASON })
    const result = noticePolicyChange(fixture.store, fixture.authority, change('v2'))
    expect(result).toMatchObject({ outcome: 'noticed', unaffected: 1, notified: [{ itemId: item.id, reasonCode: MALFORMED_AUTHORITY_REASON }] })
  })

  test('a pass larger than one page reports what remains and continues by cursor', async () => {
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, RULE)
    const items = ['decision-p1', 'decision-p2', 'decision-p3'].map(id => { fixture.advance(1); return admit(fixture, id) })
    allowBy(fixture, 'broad-allow')
    const first = noticePolicyChange(fixture.store, fixture.authority, change('v2'), 2)
    expect(first).toMatchObject({ outcome: 'noticed', remaining: 1 })
    if (first.outcome !== 'noticed') return
    expect(first.notified.map(notice => notice.itemId)).toEqual([items[0]!.id, items[1]!.id])
    expect(first.next).toEqual({ createdAt: items[1]!.createdAt, id: items[1]!.id })
    // The cursor round-trips through the strict v1 input.
    const rest = noticePolicyChange(fixture.store, fixture.authority,
      normalizePolicyChange({ protocol: 'work-items/policy-change/v1', policyVersion: 'v2', after: first.next }), 2)
    expect(rest).toMatchObject({ outcome: 'noticed', remaining: 0, next: null, notified: [{ itemId: items[2]!.id }] })
    expect(() => normalizePolicyChange({ protocol: 'work-items/policy-change/v1', policyVersion: 'v2', after: { createdAt: -1, id: 'x' } }))
      .toThrow(expect.objectContaining({ code: 'invalid-input' }))
    expect(() => normalizePolicyChange({ protocol: 'work-items/policy-change/v1', policyVersion: 'v2', after: { createdAt: 1, id: 'x', more: 1 } }))
      .toThrow(expect.objectContaining({ code: 'invalid-input' }))
  })

  test('a missing Policy writes nothing even when every live basis is judged locally', async () => {
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, RULE)
    const malformed = admit(fixture, 'decision-only-local')
    tamper(fixture, 'UPDATE work_item SET authority_basis = ? WHERE id = ?',
      JSON.stringify({ ...malformed.authority!, protocol: 'other/v1' }), malformed.id)
    const none = new WorkItemAuthority({ policy: () => undefined })
    expect(noticePolicyChange(fixture.store, none, change('v2'))).toEqual({ outcome: 'unavailable', detail: 'missing-policy' })
    expect(fixture.store.policyNotices(malformed.id)).toEqual([])
  })

  test('a failing batch write records no notice at all and the retry writes them once', async () => {
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, RULE)
    const one = admit(fixture, 'decision-batch-1')
    fixture.advance(1)
    const two = admit(fixture, 'decision-batch-2')
    allowBy(fixture, 'broad-allow')
    const db = new DatabaseSync(fixture.config.databasePath)
    try {
      db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON work_item_event
        WHEN NEW.kind = 'policy-change-noticed' AND NEW.item_id = '${two.id}' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    } finally { db.close() }
    expect(() => noticePolicyChange(fixture.store, fixture.authority, change('v2'))).toThrow()
    expect(fixture.store.policyNotices(one.id)).toEqual([])
    tamper(fixture, 'DROP TRIGGER fail_second')
    const retried = noticePolicyChange(fixture.store, fixture.authority, change('v2'))
    expect(retried).toMatchObject({ outcome: 'noticed', notified: [{ itemId: one.id }, { itemId: two.id }] })
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
    const fixture = await harnessWithAcceptance()
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
    const fixture = await harnessWithAcceptance()
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
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, RULE)
    const first = admit(fixture, 'decision-a')
    const second = admit(fixture, 'decision-b')
    fixture.store.ownFollowUp(followUp(first.id, 'msg-a'))
    // Release order follows ownership time; item ids alone are not ordered.
    fixture.advance(1)
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

  test('the same message id on another work thread is a different follow-up; observed items own nothing', async () => {
    const fixture = await harnessWithAcceptance()
    const here = await admitted(fixture, { originBindingId: 'binding-origin-1' })
    const there = await admitted(fixture, { originBindingId: 'binding-origin-2' })
    expect(fixture.store.ownFollowUp(followUp(here.id, 'msg-shared'))).toMatchObject({ outcome: 'owned' })
    expect(fixture.store.ownFollowUp(followUp(there.id, 'msg-shared', { bindingId: 'binding-origin-2' })))
      .toMatchObject({ outcome: 'owned', followUp: { itemId: there.id, bindingId: 'binding-origin-2' } })

    const shadow = await harnessWithAcceptance({ mode: 'observe' })
    const observed = await admitted(shadow)
    expect(observed.observed).toBe(true)
    expect(shadow.store.ownFollowUp(followUp(observed.id, 'msg-shadow'))).toMatchObject({ outcome: 'item-ended' })
    expect(shadow.store.followUps(observed.id)).toEqual([])
  })

  test('a withdrawn item releases its unprocessed follow-ups like any other end', async () => {
    const fixture = await harnessWithAcceptance()
    const item = await admitted(fixture)
    fixture.store.ownFollowUp(followUp(item.id, 'msg-withdrawn'))
    expect(fixture.store.withdrawByDedupKey(item.dedupKey).outcome).toBe('withdrawn')
    expect(fixture.store.releaseEndedFollowUps()).toEqual([
      expect.objectContaining({ messageId: 'msg-withdrawn', state: 'released', releasedFrom: 'dropped' }),
    ])
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
