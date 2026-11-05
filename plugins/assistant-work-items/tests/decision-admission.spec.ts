import { describe, expect, test } from 'vitest'
import { MALFORMED_AUTHORITY_REASON, MANDATE_RULE_CHANGED_REASON } from '../src/authority.ts'
import type { WorkItemExecuteDecision, WorkItemRecord } from '../src/types.ts'
import { WorkItemError } from '../src/types.ts'
import { claim, harness, report, type Harness } from './fixtures.ts'

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

  test('inferred work needs auto mode, a named rule and remaining budget, all before Policy or a write', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const cases: Array<[WorkItemExecuteDecision, string]> = [
      [inferred({ mode: 'observe' }), 'inferred-requires-auto'],
      [decision({ origin: 'inferred' }), 'inferred-requires-rule'],
      [inferred({ budgetRemaining: 0 }), 'budget-exhausted'],
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
    const fixture = await harness()
    allowBy(fixture, 'broad-allow')
    expect(fixture.admission.admitDecision(inferred())).toEqual({ outcome: 'refused', reasonCode: 'policy-rule-mismatch' })
    allowBy(fixture, undefined)
    expect(fixture.admission.admitDecision(inferred())).toEqual({ outcome: 'refused', reasonCode: 'policy-rule-mismatch' })
    expect(itemCount(fixture)).toBe(0)
    fixture.policy.deny('rule-deny')
    expect(() => fixture.admission.admitDecision(inferred())).toThrow(expect.objectContaining({ code: 'source-rejected' }))
    expect(itemCount(fixture)).toBe(0)
    allowBy(fixture, RULE)
    const item = admittedItem(fixture.admission.admitDecision(inferred()))
    expect(item.authority?.ruleId).toBe(RULE)
    expect(item.authority?.mandate).toMatchObject({ origin: 'inferred', ruleId: RULE, budgetRemaining: 3 })
    expect(fixture.policy.requests.at(-1)).toMatchObject({ action: 'admit', resource: { kind: 'automation', id: item.workerAutomationId } })
  })

  test('ordinary admission gates still bound decision work', async () => {
    const fixture = await harness()
    const outOfScope = decision({ mandate: { ...decision().mandate, kind: 'deploy' } })
    expect(() => fixture.admission.admitDecision(outOfScope)).toThrow(expect.objectContaining({ code: 'kind-rejected' }))
    expect(itemCount(fixture)).toBe(0)
  })

  test('dispatch re-verification pins a named rule: a different allowing rule parks, the same rule allows', async () => {
    const fixture = await harness()
    allowBy(fixture, RULE)
    const item = admittedItem(fixture.admission.admitDecision(inferred()))
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
    const fixture = await harness()
    allowBy(fixture, RULE)
    const item = admittedItem(fixture.admission.admitDecision(inferred()))
    const basis = item.authority!
    const variants = [
      { ...basis, mandate: { ...basis.mandate!, digest: 'not-a-digest' } },
      { ...basis, mandate: { ...basis.mandate!, ruleId: 'other-rule' } },
      { ...basis, mandate: { ...basis.mandate!, budgetRemaining: 0 } },
      { ...basis, mandate: { ...basis.mandate!, extra: true } },
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
