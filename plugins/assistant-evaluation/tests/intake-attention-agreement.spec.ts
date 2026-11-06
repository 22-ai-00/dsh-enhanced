import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationService } from '../src/service.ts'

const scope = { workspace: '/work/notify', preset: 'primary' }
const hour = 3_600_000
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart())) })

type Fact = Record<string, unknown> & { outboxId: string; auditSequence: number }
function fact(outboxId: string, auditSequence: number, overrides: Record<string, unknown> = {}): Fact {
  return {
    auditSequence, outboxId, bindingId: 'binding-1', scope, lane: 'background', sourceId: 'assistant-work-items',
    purpose: 'result', purposeSource: 'declared', verdict: 'would-accept', reasons: [], auditedAt: 1_000,
    transport: { status: 'accepted', acceptedAt: 1_100 },
    ...overrides,
  }
}

class FactSource {
  readonly facts = new Map<string, Fact>()
  put(value: Fact) { this.facts.set(value.outboxId, value) }
  inspectNotificationOutcomeFacts(input: { afterSequence?: number; limit?: number; outboxIds?: readonly string[] }) {
    if (input.outboxIds !== undefined) {
      return { protocol: 'assistant-delivery/notification-outcome-facts/v1', hasMore: false, nextAfterSequence: null,
        facts: input.outboxIds.map(id => this.facts.get(id)).filter(item => item !== undefined) }
    }
    const all = [...this.facts.values()].filter(item => item.auditSequence > (input.afterSequence ?? 0))
      .sort((a, b) => a.auditSequence - b.auditSequence)
    const page = all.slice(0, input.limit ?? 100)
    return { protocol: 'assistant-delivery/notification-outcome-facts/v1', facts: page, hasMore: all.length > page.length,
      nextAfterSequence: page.at(-1)?.auditSequence ?? null }
  }
}

/** Structural stand-in for WorkItems' `inspectIntakeProvenance`. */
class ProvenanceSource {
  readonly items = new Map<string, unknown>()
  reads: string[] = []
  failing = new Set<string>()
  inspectIntakeProvenance(itemId: string) {
    this.reads.push(itemId)
    if (this.failing.has(itemId)) throw new Error('work items unavailable')
    return this.items.get(itemId)
  }
  admit(itemId: string, level = 'accept') {
    this.items.set(itemId, { protocol: 'work-items/intake-provenance/v1', itemId, source: 'lark-channel', sourceEventId: `om-${itemId}`,
      ruleId: 'rule-1', policyVersion: 'v1', mode: 'auto', level, wouldAccept: true, admittedAt: 900 })
  }
}

function setup(options: { enabled?: boolean; provenance?: ProvenanceSource | null } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const facts = new FactSource()
  const provenance = options.provenance === undefined ? new ProvenanceSource() : options.provenance
  ctx.provide('assistantDelivery' as never, facts as never)
  if (provenance !== null) ctx.provide('assistantWorkItems' as never, provenance as never)
  const clock = { now: 2_000 }
  const evaluation = new AssistantEvaluationService(ctx, {
    databasePath: ':memory:', projectionIntervalMs: 0, notificationOutcomesEnabled: true, notificationResponseWindowMs: hour,
    intakeAttentionAgreementEnabled: options.enabled ?? true,
  }, { now: () => clock.now })
  return { facts, provenance, clock, evaluation }
}

describe('intake attention agreement (WP22, read-only)', () => {
  test('is undefined when off and requires notification outcomes', () => {
    const { evaluation, provenance } = setup({ enabled: false })
    expect(evaluation.inspectIntakeAttentionAgreement({ scope })).toBeUndefined()
    expect(provenance?.reads).toEqual([])
    expect(() => new AssistantEvaluationService(new Context(), { databasePath: ':memory:', projectionIntervalMs: 0,
      intakeAttentionAgreementEnabled: true })).toThrow(/requires notificationOutcomesEnabled/u)
  })

  test('joins intake-admitted items to their notification outcomes and separates non-intake items', () => {
    const { facts, provenance, clock, evaluation } = setup()
    provenance!.admit('item-a')
    provenance!.admit('item-b')
    facts.put(fact('out-1', 1, { workItemId: 'item-a', judgement: { source: 'work-item-feedback', version: 1, objectiveStatus: 'achieved' } }))
    facts.put(fact('out-2', 2, { workItemId: 'item-a', reaction: { firstAt: 1_200 } }))
    facts.put(fact('out-3', 3, { workItemId: 'item-b', judgement: { source: 'work-item-feedback', version: 1, objectiveStatus: 'not-achieved' } }))
    facts.put(fact('out-4', 4, { workItemId: 'item-b' }))
    facts.put(fact('out-5', 5, { workItemId: 'item-manual' }))
    facts.put(fact('out-6', 6))
    clock.now = 2_000 + 2 * hour
    evaluation.reconcileNotificationOutcomes()
    const before = evaluation.notificationOutcomeSummary({ scope, fromNotifiedAt: 0, toNotifiedAt: clock.now })
    const result = evaluation.inspectIntakeAttentionAgreement({ scope, fromNotifiedAt: 0, toNotifiedAt: clock.now })
    expect(result).toMatchObject({
      protocol: 'assistant-evaluation/intake-attention-agreement/v1', causal: false, scanned: 5, truncated: false,
      provenanceAvailable: true, notIntake: 1, unresolved: 0,
      intake: { notifications: 4, items: 2, agreed: 2, disagreed: 2, agreementPpm: 500_000,
        outcomes: { accepted: 1, reacted: 1, rejected: 1, 'expired-unhandled': 1 } },
      byLevel: { accept: { notifications: 4, items: 2 } },
    })
    // Provenance is read once per item.
    expect([...provenance!.reads].sort()).toEqual(['item-a', 'item-b', 'item-manual'])
    // Read-only: the ledger is unchanged.
    expect(evaluation.notificationOutcomeSummary({ scope, fromNotifiedAt: 0, toNotifiedAt: clock.now })).toEqual(before)
  })

  test('counts throwing or malformed provenance as unresolved and works without a WorkItems peer', () => {
    const { facts, provenance, evaluation } = setup()
    provenance!.failing.add('item-x')
    provenance!.items.set('item-y', { protocol: 'work-items/intake-provenance/v1', itemId: 'other', level: 'accept', mode: 'auto', wouldAccept: true })
    facts.put(fact('out-1', 1, { workItemId: 'item-x' }))
    facts.put(fact('out-2', 2, { workItemId: 'item-y' }))
    evaluation.reconcileNotificationOutcomes()
    expect(evaluation.inspectIntakeAttentionAgreement({ scope, fromNotifiedAt: 0, toNotifiedAt: 10_000 }))
      .toMatchObject({ scanned: 2, unresolved: 2, notIntake: 0, intake: { notifications: 0, agreementPpm: null }, byLevel: {} })

    const bare = setup({ provenance: null })
    bare.facts.put(fact('out-1', 1, { workItemId: 'item-a' }))
    bare.evaluation.reconcileNotificationOutcomes()
    expect(bare.evaluation.inspectIntakeAttentionAgreement({ scope, fromNotifiedAt: 0, toNotifiedAt: 10_000 }))
      .toMatchObject({ provenanceAvailable: false, scanned: 1, unresolved: 1, intake: { notifications: 0 } })
  })

  test('rejects an invalid window', () => {
    const { evaluation } = setup()
    expect(() => evaluation.inspectIntakeAttentionAgreement({ scope, fromNotifiedAt: 10, toNotifiedAt: 10 })).toThrow(/window is invalid/u)
  })
})
