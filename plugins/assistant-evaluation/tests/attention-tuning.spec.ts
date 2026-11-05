import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationService } from '../src/service.ts'
import {
  attentionRegressed,
  attentionTuningBounds,
  clampAttentionTuning,
  defaultAttentionTuningParameters,
  isAttentionLoosening,
  proposeAttentionTuning,
  type AttentionCohortStats,
  type AttentionTuningParameters,
} from '../src/attention-tuning.ts'

const scope = { workspace: '/work/attention', preset: 'primary' }
const cohort = { lane: 'owner-notification', sourceId: 'assistant-proactive/v1' }
const hour = 3_600_000
const day = 24 * hour
const policy = { minSample: 20, negativeRatePpm: 600_000, muteRatePpm: 900_000, regressionMarginPpm: 100_000 }
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function stats(decided: number, negative: number, accepted = decided - negative): AttentionCohortStats {
  return { fromNotifiedAt: 0, toNotifiedAt: 1, total: decided, accepted, reacted: 0, rejected: negative, expiredUnhandled: 0, decided, negative }
}

type Fact = Record<string, unknown> & { outboxId: string; auditSequence: number }

class FactSource {
  readonly facts = new Map<string, Fact>()
  sequence = 0
  put(value: Fact) { this.facts.set(value.outboxId, value) }
  /** `negative` of `count` notifications at `at` are owner-rejected; the rest accepted. */
  batch(prefix: string, count: number, negative: number, at: number, overrides: Record<string, unknown> = {}) {
    for (let index = 0; index < count; index += 1) {
      this.sequence += 1
      this.put({
        auditSequence: this.sequence, outboxId: `${prefix}-${index}`, bindingId: 'binding-1', scope, ...cohort,
        purpose: 'attention', purposeSource: 'lane', verdict: 'would-accept', reasons: [], auditedAt: at,
        transport: { status: 'delivered', acceptedAt: at + 1, deliveredAt: at + 2 },
        judgement: { source: 'owner-objective', version: 1, objectiveStatus: index < negative ? 'not-achieved' : 'achieved' },
        ...overrides,
      })
    }
  }
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

function setup(options: { path?: string; autoAdopt?: boolean; source?: FactSource; clock?: { now: number } } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const source = options.source ?? new FactSource()
  const clock = options.clock ?? { now: 10_000 }
  ctx.provide('assistantDelivery' as never, source as never)
  const evaluation = new AssistantEvaluationService(ctx, {
    databasePath: options.path ?? ':memory:', projectionIntervalMs: 0,
    notificationOutcomesEnabled: true, notificationResponseWindowMs: hour, notificationSyncBatchSize: 500,
    attentionTuningAutoAdopt: options.autoAdopt ?? true, attentionTuningObservationMs: day,
  }, { now: () => clock.now })
  const sync = () => {
    while (evaluation.reconcileNotificationOutcomes().ingested > 0) { /* drain */ }
    return evaluation.reconcileAttentionTuning()
  }
  return { ctx, source, clock, evaluation, sync }
}

const tuned = (overrides: Partial<AttentionTuningParameters>): AttentionTuningParameters => ({ ...defaultAttentionTuningParameters, ...overrides })

describe('pure tighten-only tuner', () => {
  test('clamps every parameter to its fixed bound and step grid', () => {
    expect(clampAttentionTuning({ interruptionCostDelta: 1_000, minimumUtilityDelta: -5, quietExtensionMinutes: 95, muted: false }))
      .toEqual({ interruptionCostDelta: attentionTuningBounds.interruptionCostDelta.max, minimumUtilityDelta: 0, quietExtensionMinutes: 90, muted: false })
  })

  test('insufficient sample and below-threshold are no-ops', () => {
    expect(proposeAttentionTuning(defaultAttentionTuningParameters, stats(19, 19), policy)).toEqual({ kind: 'no-op', reason: 'insufficient-sample' })
    expect(proposeAttentionTuning(defaultAttentionTuningParameters, stats(20, 11), policy)).toEqual({ kind: 'no-op', reason: 'below-threshold' })
  })

  test('proposes exactly one tightening step in fixed order until every bound is reached', () => {
    let current = defaultAttentionTuningParameters
    const seen: string[] = []
    for (;;) {
      const proposal = proposeAttentionTuning(current, stats(20, 19), policy)
      if (proposal.kind === 'no-op') { expect(proposal.reason).toBe('at-bound'); break }
      expect(isAttentionLoosening(current, proposal.parameters)).toBe(false)
      const changed = (Object.keys(current) as (keyof AttentionTuningParameters)[]).filter(key => current[key] !== proposal.parameters[key])
      expect(changed).toEqual([proposal.change.parameter])
      seen.push(proposal.change.parameter)
      current = proposal.parameters
    }
    expect(current).toEqual({ interruptionCostDelta: 100, minimumUtilityDelta: 100, quietExtensionMinutes: 120, muted: true })
    expect(seen.filter(key => key === 'interruptionCostDelta')).toHaveLength(10)
    expect(seen.at(-1)).toBe('muted')
  })

  test('mute requires the higher mute rate', () => {
    const maxed = tuned({ interruptionCostDelta: 100, minimumUtilityDelta: 100, quietExtensionMinutes: 120 })
    expect(proposeAttentionTuning(maxed, stats(20, 14), policy)).toEqual({ kind: 'no-op', reason: 'at-bound' })
    expect(proposeAttentionTuning(maxed, stats(20, 18), policy)).toMatchObject({ kind: 'tighten', change: { parameter: 'muted', to: true } })
  })

  test('is deterministic', () => {
    expect(proposeAttentionTuning(tuned({ interruptionCostDelta: 30 }), stats(40, 30), policy))
      .toEqual(proposeAttentionTuning(tuned({ interruptionCostDelta: 30 }), stats(40, 30), policy))
  })

  test('positive evidence never satisfies the regression test', () => {
    const basis = stats(20, 12)
    expect(attentionRegressed(basis, stats(100, 0), policy)).toBe(false)
    expect(attentionRegressed(basis, stats(20, 14), policy)).toBe(false) // 70% is not above 60% + 10%
    expect(attentionRegressed(basis, stats(20, 15), policy)).toBe(true)
    expect(attentionRegressed(basis, stats(19, 19), policy)).toBe(false) // below min sample
  })
})

describe('attention tuning service', () => {
  test('switch off: no version, no overlay, no tick work', () => {
    const f = setup({ autoAdopt: false })
    f.source.batch('a', 30, 30, 1_000)
    expect(f.sync()).toEqual([])
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })).toBeUndefined()
    expect(f.evaluation.attentionTuningStatus({ scope, cohort })).toMatchObject({ versions: [], state: 'idle', current: { version: 0 } })
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 10 }) }))
      .toEqual({ status: 'rejected', reason: 'auto-adoption-disabled' })
  })

  test('auto-adopts one bounded step, is idempotent, and keeps observing', () => {
    const f = setup()
    f.source.batch('a', 20, 12, 1_000)
    f.source.batch('other', 30, 30, 1_000, { lane: 'background', sourceId: 'other-source' })
    const [first] = f.sync()
    expect(first).toMatchObject({ cohort, result: { action: 'adopted', version: 1, change: { parameter: 'interruptionCostDelta', from: 0, to: 10 } } })
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1, source: 'active', parameters: tuned({ interruptionCostDelta: 10 }) })
    expect(f.sync()).toMatchObject([{ result: { action: 'observing', version: 1 } }])
    const status = f.evaluation.attentionTuningStatus({ scope, cohort })
    expect(status.versions).toHaveLength(1)
    expect(status.versions[0]).toMatchObject({ parentVersion: 0, parentDigest: null, origin: 'auto', basis: { stats: { decided: 20, negative: 12 } } })
    expect(status.versions[0]!.basis.scopeWatermark).toBeGreaterThan(0)
    expect(status).toMatchObject({ state: 'observing', observeFrom: 10_000, observeUntil: 10_000 + day })
    // Unconfigured cohorts are not tunable even when noisy.
    expect(() => f.evaluation.currentAttentionTuning({ scope, cohort: { lane: 'background', sourceId: 'other-source' } })).toThrow(/not configured/)
  })

  test('rising negative rate rolls back to the exact parent version', () => {
    const f = setup()
    f.source.batch('a', 20, 12, 1_000)
    f.sync()
    f.clock.now += day
    expect(f.sync()).toMatchObject([{ result: { action: 'settled', version: 1 } }])
    const v1 = f.evaluation.currentAttentionTuning({ scope, cohort })!
    f.source.batch('b', 20, 12, f.clock.now)
    f.clock.now += 1
    expect(f.sync()).toMatchObject([{ result: { action: 'adopted', version: 2, change: { parameter: 'interruptionCostDelta', from: 10, to: 20 } } }])
    f.source.batch('c', 20, 18, f.clock.now)
    f.clock.now += 1
    expect(f.sync()).toMatchObject([{ result: { action: 'rolled-back', fromVersion: 2, toVersion: 1 } }])
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })).toEqual(v1)
    const status = f.evaluation.attentionTuningStatus({ scope, cohort })
    expect(status.versions.map(version => version.version)).toEqual([1, 2])
    expect(status.versions[1]).toMatchObject({ parentVersion: 1, parentDigest: v1.digest })
    expect(status.events.map(event => event.kind)).toEqual(['adopted', 'settled', 'adopted', 'rolled-back'])
    expect(status.state).toBe('idle')
    // The rolled-back version's evidence is not reused: a fresh sample is required.
    expect(f.sync()).toMatchObject([{ result: { action: 'no-op', reason: 'insufficient-sample' } }])
  })

  test('positive evidence never triggers rollback and the version settles', () => {
    const f = setup()
    f.source.batch('a', 20, 12, 1_000)
    f.sync()
    f.source.batch('b', 50, 0, f.clock.now)
    f.clock.now += 1
    expect(f.sync()).toMatchObject([{ result: { action: 'observing', version: 1 } }])
    f.clock.now += day
    expect(f.sync()).toMatchObject([{ result: { action: 'settled', version: 1 } }])
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1 })
  })

  test('observation continues across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-attention-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const source = new FactSource()
    const clock = { now: 10_000 }
    const first = setup({ path, source, clock })
    source.batch('a', 20, 12, 1_000)
    first.sync()
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = setup({ path, source, clock })
    expect(second.evaluation.attentionTuningStatus({ scope, cohort })).toMatchObject({ state: 'observing', observeFrom: 10_000 })
    source.batch('b', 20, 20, clock.now)
    clock.now += 1
    expect(second.sync()).toMatchObject([{ result: { action: 'rolled-back', fromVersion: 1, toVersion: 0 } }])
    expect(second.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 0, digest: null, parameters: defaultAttentionTuningParameters })
  })

  test('loosening requests are rejected with loosening-requires-holdout and recorded', () => {
    const f = setup()
    f.source.batch('a', 20, 12, 1_000)
    f.sync()
    f.clock.now += day
    f.sync()
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({}) }))
      .toEqual({ status: 'rejected', reason: 'loosening-requires-holdout' })
    // Mixed tighten + loosen is still loosening.
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ minimumUtilityDelta: 10 }) }))
      .toEqual({ status: 'rejected', reason: 'loosening-requires-holdout' })
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 10, minimumUtilityDelta: 15 }) }))
      .toEqual({ status: 'rejected', reason: 'out-of-bounds' })
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 30 }) }))
      .toEqual({ status: 'rejected', reason: 'not-single-step' })
    expect(f.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 10, muted: true }) }))
      .toMatchObject({ status: 'adopted', version: 2, change: { parameter: 'muted', from: false, to: true } })
    const events = f.evaluation.attentionTuningStatus({ scope, cohort }).events
    expect(events.filter(event => event.kind === 'request-rejected').map(event => event.reason))
      .toEqual(['loosening-requires-holdout', 'loosening-requires-holdout', 'out-of-bounds', 'not-single-step'])
    expect(f.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 2, parameters: { muted: true } })
  })

  test('a tampered active version falls back to its verified parent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-eval-attention-tamper-')); directories.push(directory)
    const path = join(directory, 'evaluation.sqlite')
    const source = new FactSource()
    const clock = { now: 10_000 }
    const first = setup({ path, source, clock })
    source.batch('a', 20, 12, 1_000)
    first.sync()
    clock.now += day
    first.sync()
    first.evaluation.requestAttentionTuning({ scope, cohort, parameters: tuned({ interruptionCostDelta: 20 }) })
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const database = new DatabaseSync(path)
    database.exec(`DROP TRIGGER evaluation_attention_tuning_versions_immutable;
      UPDATE evaluation_attention_tuning_versions SET parameters_json='{"interruptionCostDelta":100,"minimumUtilityDelta":0,"muted":false,"quietExtensionMinutes":0}' WHERE version=2`)
    database.close()
    const second = setup({ path, source, clock })
    expect(second.evaluation.currentAttentionTuning({ scope, cohort })).toMatchObject({ version: 1, source: 'parent-fallback', parameters: tuned({ interruptionCostDelta: 10 }) })
  })
})
