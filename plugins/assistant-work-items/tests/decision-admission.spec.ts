import { describe, expect, test } from 'vitest'
import { MALFORMED_AUTHORITY_REASON, MANDATE_RULE_CHANGED_REASON } from '../src/authority.ts'
import type { WorkItemExecuteDecision, WorkItemRecord } from '../src/types.ts'
import { WorkItemError } from '../src/types.ts'
import { claim, fakeAcceptance, harness, report, type Harness } from './fixtures.ts'

const RULE = 'inferred-review-admit'

function decision(overrides: Partial<WorkItemExecuteDecision> = {}): WorkItemExecuteDecision {
  return {
    protocol: 'work-items/execute-decision/v1',
    decisionId: 'decision-1',
    verdict: 'execute',
    origin: 'explicit',
    mode: 'auto',
    budgetRemaining: 3,
    mandate: {
      kind: 'review',
      title: 'Review the flaky deploy step',
      brief: 'Find why the deploy step failed twice and report.',
      originBindingId: 'binding-origin-1',
      acceptanceRef: 'tac:deploy-review/v1',
    },
    ...overrides,
  }
}

function inferred(overrides: Partial<WorkItemExecuteDecision> = {}): WorkItemExecuteDecision {
  return decision({ origin: 'inferred', policyRuleId: RULE, ...overrides })
}

const acceptance = fakeAcceptance()
const harnessWithAcceptance = (overrides: Parameters<typeof harness>[0] = {}) =>
  harness(overrides, { verifier: () => acceptance.service })
/** Inferred auto decisions now must carry a real acceptance handle (E2 invariant). */
const acceptedInferred = (overrides: Partial<WorkItemExecuteDecision> = {}) =>
  inferred({ acceptance: acceptance.handle(), ...overrides })

function itemCount(fixture: Harness): number {
  return fixture.store.countItemsSince(0)
}

function allowBy(fixture: Harness, ruleId: string | undefined): void {
  fixture.policy.decision = { effect: 'allow', reasonCode: 'rule-allow', ...(ruleId === undefined ? {} : { ruleId }) }
}

function admittedItem(result: ReturnType<Harness['admission']['admitDecision']>): WorkItemRecord {
  if (result.outcome === 'refused') throw new Error(`refused: ${result.reasonCode}`)
  return result.item
}

describe('execute decision admission', () => {
  test('an explicit decision admits one item and freezes its mandate in the authority basis', async () => {
    const fixture = await harness()
    const result = fixture.admission.admitDecision(decision())
    expect(result.outcome).toBe('admitted')
    const item = admittedItem(result)
    expect(item.externalId).toBe('decision:decision-1')
    expect(item.acceptanceRef).toBe('tac:deploy-review/v1')
    expect(item.state).toBe('queued')
    expect(item.authority?.mandate).toMatchObject({
      protocol: 'work-items/mandate/v1', decisionId: 'decision-1', origin: 'explicit', mode: 'auto', budgetRemaining: 3,
    })
    expect(item.authority?.mandate?.digest).toMatch(/^[0-9a-f]{64}$/)
    // Durable round-trip, not just the in-memory record.
    expect(fixture.store.findItemById(item.id)?.authority?.mandate).toEqual(item.authority?.mandate)
    expect(fixture.authority.check(fixture.store.findItemById(item.id)!)).toEqual({ kind: 'allow' })
  })

  test('replay never opens a second item: same window, rolled window, settled, and moved budget', async () => {
    const fixture = await harness()
    const first = admittedItem(fixture.admission.admitDecision(decision()))
    const again = fixture.admission.admitDecision(decision({ budgetRemaining: 0, mode: 'observe' }))
    expect(again.outcome).toBe('replayed')
    expect(admittedItem(again).id).toBe(first.id)
    // The ordinary dedup window would forget an open item here.
    fixture.advance(fixture.config.admission.dedupWindowMs * 2)
    expect(admittedItem(fixture.admission.admitDecision(decision())).id).toBe(first.id)
    claim(fixture, first.id)
    report(fixture, first.id, 'ready')
    const settled = fixture.admission.admitDecision(decision())
    expect(settled.outcome).toBe('replayed')
    expect(admittedItem(settled).state).toBe('ready')
    expect(itemCount(fixture)).toBe(1)
  })

  test('the same decision id with a different mandate is an identity mismatch and writes nothing', async () => {
    const fixture = await harness()
    fixture.admission.admitDecision(decision())
    const changed = decision({ mandate: { ...decision().mandate, brief: 'Also rewrite the pipeline.' } })
    expect(() => fixture.admission.admitDecision(changed)).toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(() => fixture.admission.admitDecision(decision({ origin: 'inferred', policyRuleId: RULE })))
      .toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(itemCount(fixture)).toBe(1)
  })

  test('the decision id alone is the identity: another kind under the same id is a mismatch, not a second item', async () => {
    const fixture = await harness()
    const first = admittedItem(fixture.admission.admitDecision(decision()))
    const otherKind = decision({ mandate: { ...decision().mandate, kind: 'triage' } })
    expect(() => fixture.admission.admitDecision(otherKind)).toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    fixture.advance(fixture.config.admission.dedupWindowMs * 2)
    expect(() => fixture.admission.admitDecision(otherKind)).toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(itemCount(fixture)).toBe(1)
    expect(admittedItem(fixture.admission.admitDecision(decision())).id).toBe(first.id)
  })

  test('an ordinary signal cannot squat, replay or withdraw a decision id', async () => {
    const fixture = await harness()
    const squat = { kind: 'review', externalId: 'decision:decision-1', title: 't', brief: 'b', originBindingId: 'binding-origin-1' }
    const ordinary = fixture.admission.admit(squat)
    expect(ordinary.created).toBe(true)
    fixture.advance(fixture.config.admission.cooldownMs + 1)
    const result = fixture.admission.admitDecision(decision())
    expect(result.outcome).toBe('admitted')
    const item = admittedItem(result)
    expect(item.id).not.toBe(ordinary.item.id)
    expect(item.dedupKey).not.toBe(ordinary.item.dedupKey)
    fixture.admission.withdraw(squat)
    expect(fixture.store.findItemById(item.id)?.state).toBe('queued')
    expect(fixture.admission.admitDecision(decision()).outcome).toBe('replayed')
  })

  test('inferred work needs auto mode, a named rule, remaining budget and a real acceptance handle, all before Policy or a write', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const cases: Array<[WorkItemExecuteDecision, string]> = [
      [inferred({ mode: 'observe' }), 'inferred-requires-auto'],
      [decision({ origin: 'inferred' }), 'inferred-requires-rule'],
      [inferred({ budgetRemaining: 0 }), 'budget-exhausted'],
      [inferred(), 'acceptance-required'],
    ]
    for (const [input, reasonCode] of cases) {
      expect(fixture.admission.admitDecision(input)).toEqual({ outcome: 'refused', reasonCode })
      // A refusal is deterministic: the replay gives the same answer.
      expect(fixture.admission.admitDecision(input)).toEqual({ outcome: 'refused', reasonCode })
    }
    expect(fixture.policy.requests).toHaveLength(0)
    expect(itemCount(fixture)).toBe(0)
    // The explicit counterpart of the same shape is not gated by mode or budget.
    expect(fixture.admission.admitDecision(decision({ decisionId: 'explicit-1', mode: 'observe', budgetRemaining: 0 })).outcome).toBe('admitted')
  })

  test('inferred work is admitted only when Policy allows by exactly the named rule', async () => {
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, 'broad-allow')
    expect(fixture.admission.admitDecision(acceptedInferred())).toEqual({ outcome: 'refused', reasonCode: 'policy-rule-mismatch' })
    allowBy(fixture, undefined)
    expect(fixture.admission.admitDecision(acceptedInferred())).toEqual({ outcome: 'refused', reasonCode: 'policy-rule-mismatch' })
    expect(itemCount(fixture)).toBe(0)
    // The mismatch is found by the side-effect-free evaluate: no budget-consuming authorize call.
    expect(fixture.policy.evaluations).toHaveLength(2)
    expect(fixture.policy.requests).toHaveLength(0)
    fixture.policy.deny('rule-deny')
    expect(() => fixture.admission.admitDecision(acceptedInferred())).toThrow(expect.objectContaining({ code: 'source-rejected' }))
    expect(itemCount(fixture)).toBe(0)
    allowBy(fixture, RULE)
    const item = admittedItem(fixture.admission.admitDecision(acceptedInferred()))
    expect(item.authority?.ruleId).toBe(RULE)
    expect(item.authority?.mandate).toMatchObject({ origin: 'inferred', ruleId: RULE, budgetRemaining: 3 })
    expect(fixture.policy.requests.at(-1)).toMatchObject({ action: 'admit', resource: { kind: 'automation', id: item.workerAutomationId } })
  })

  test('an older Policy peer without evaluate still refuses a rule mismatch after authorize', async () => {
    const fixture = await harnessWithAcceptance()
    delete (fixture.policy.service as { evaluate?: unknown }).evaluate
    allowBy(fixture, 'broad-allow')
    expect(fixture.admission.admitDecision(acceptedInferred())).toEqual({ outcome: 'refused', reasonCode: 'policy-rule-mismatch' })
    expect(fixture.policy.requests).toHaveLength(1)
    expect(itemCount(fixture)).toBe(0)
  })

  test('ordinary admission gates still bound decision work', async () => {
    const fixture = await harness()
    const outOfScope = decision({ mandate: { ...decision().mandate, kind: 'deploy' } })
    expect(() => fixture.admission.admitDecision(outOfScope)).toThrow(expect.objectContaining({ code: 'kind-rejected' }))
    expect(itemCount(fixture)).toBe(0)
  })

  test('dispatch re-verification pins a named rule: a different allowing rule parks, the same rule allows', async () => {
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, RULE)
    const item = admittedItem(fixture.admission.admitDecision(acceptedInferred()))
    expect(fixture.authority.check(item)).toEqual({ kind: 'allow' })
    allowBy(fixture, 'broad-allow')
    expect(fixture.authority.check(item)).toEqual({ kind: 'revoked', reasonCode: MANDATE_RULE_CHANGED_REASON })
    // A plain (non-decision) item keeps the existing any-allow semantics.
    const plain = fixture.admission.admit({
      kind: 'triage', externalId: 'plain-1', title: 't', brief: 'b', originBindingId: 'binding-origin-1',
    }).item
    expect(fixture.authority.check(plain)).toEqual({ kind: 'allow' })
  })

  test('a malformed or inconsistent stored mandate is revoked, never treated as legacy', async () => {
    const fixture = await harnessWithAcceptance()
    allowBy(fixture, RULE)
    const item = admittedItem(fixture.admission.admitDecision(acceptedInferred()))
    const basis = item.authority!
    const variants = [
      { ...basis, mandate: { ...basis.mandate!, digest: 'not-a-digest' } },
      { ...basis, mandate: { ...basis.mandate!, ruleId: 'other-rule' } },
      { ...basis, mandate: { ...basis.mandate!, budgetRemaining: 0 } },
      { ...basis, mandate: { ...basis.mandate!, extra: true } },
      { ...basis, mandate: { ...basis.mandate!, budgetRemaining: 1_000_000_001 } },
      // A mandate copied onto another item's basis does not bind that item.
      { ...basis, mandate: { ...basis.mandate!, decisionId: 'decision-2' } },
    ]
    for (const authority of variants) {
      const forged = { ...item, authority } as WorkItemRecord
      expect(fixture.authority.check(forged)).toEqual({ kind: 'revoked', reasonCode: MALFORMED_AUTHORITY_REASON })
    }
  })

  test('malformed decisions and observe mode fail closed without a write', async () => {
    const fixture = await harness()
    const bad: unknown[] = [
      null,
      { ...decision(), verdict: 'ignore' },
      { ...decision(), protocol: 'other/v1' },
      { ...decision(), extra: 1 },
      { ...decision(), decisionId: 'has space' },
      { ...decision(), budgetRemaining: -1 },
      { ...decision(), mandate: { ...decision().mandate, acceptanceRef: undefined } },
      { ...decision(), mandate: { ...decision().mandate, follows: [] } },
    ]
    for (const input of bad) {
      expect(() => fixture.admission.admitDecision(input)).toThrow(WorkItemError)
    }
    expect(itemCount(fixture)).toBe(0)
    const observe = await harness({ mode: 'observe' })
    expect(() => observe.admission.admitDecision(decision())).toThrow(expect.objectContaining({ code: 'observe-mode' }))
    expect(itemCount(observe)).toBe(0)
  })
})
