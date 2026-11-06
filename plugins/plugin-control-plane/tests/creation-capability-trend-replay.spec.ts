/**
 * Synthetic replay of ordinary use against KNOWN ground truth. A seeded generator plants treated/control session
 * cohorts per frozen model across fixed windows around one adoption, with a chosen effect, shared time trend and
 * optional pre-trend divergence, then replays them through the real trend and attribution estimators. Offline only:
 * it proves estimator arithmetic and flags, never long-term ordinary-use benefit.
 */
import { describe, expect, it } from 'vitest'
import { controlPlaneDigest } from '../src/store.js'
import { inspectCreationCapabilityAvailabilityAttribution, inspectCreationCapabilityOrdinaryUseTrend,
  type CreationCapabilityTrendInput } from '../src/creation-capability-feedback.js'
import type { CreationCapabilityCallEvidence, CreationCapabilityRecord,
  CreationCapabilityTrendDifferenceInDifferences } from '../src/creation-capability-types.js'

const H = 60 * 60 * 1000
const adoptedAt = 1_000 * H
const owner = { authorityId: 'authority', authorityHash: 'a'.repeat(64), principalId: 'owner',
  principalRecordId: 'principal-row', principalVersion: 2, workspace: '/work', agentPreset: 'primary' }
const tool = { name: 'evolved_tool', originalName: 'read', description: '', parameters: {} }
const receipt = { protocol: 'dsh-created-capability-adoption/v2', planId: 'plan', adoptedAt,
  expiresAt: adoptedAt + 1_000 * H, artifactSha256: 'b'.repeat(64), schemaDigest: 'c'.repeat(64) }
const record = { planId: 'plan', status: 'active', receipt, tools: [tool] } as unknown as CreationCapabilityRecord
const receiptDigest = controlPlaneDigest(receipt)
const original = { subjectKind: 'foreground-turn' as const, subjectRef: 'trigger', version: 1,
  digest: 'd'.repeat(64), disposition: 'upsert' as const }
const binding = (inboxId: string) => ({ id: `${inboxId}-binding`, version: 3, generation: 4 })

/** mulberry32: a small deterministic PRNG; the only randomness source of this file. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface StratumPlan {
  model: { provider: string; model: string }
  /** Achieved probability at window -1 (immediately before adoption). */
  treatedBase: number
  controlBase: number
  /** Planted additive effect on the treated cohort's achieved probability in every after window. */
  effect: number
  /** Extra per-window slope of the treated cohort before adoption only; zero means parallel pre-trends. */
  treatedPreSlope?: number
}

interface Plan {
  seed: number
  /** `exact` plants round(p * n) achieved tasks per cell; `bernoulli` draws each outcome from the seeded PRNG. */
  mode: 'exact' | 'bernoulli'
  preWindows: number
  postWindows: number
  /** Tasks per (stratum, cohort, window) cell. */
  perCell: number
  sessionsPerCohort: number
  /** Per-window additive time trend applied to BOTH cohorts. */
  sharedTrend: number
  strata: readonly StratumPlan[]
}

interface SyntheticTask {
  inboxId: string
  session: string
  window: number
  dispatchedAt: number
  status: 'achieved' | 'not-achieved'
  model: { provider: string; model: string }
  /** Treated after-window tasks carry one exact call of this adoption. */
  exposed: boolean
}

const clamp = (p: number) => Math.min(1, Math.max(0, p))

/** Planted achieved probability of one cohort cell. */
function probability(plan: Plan, stratum: StratumPlan, cohort: 'treated' | 'control', window: number): number {
  // Windows are indexed so the shared trend is zero at window -1.
  const time = plan.sharedTrend * (window + 1)
  if (cohort === 'control') return clamp(stratum.controlBase + time)
  const preDivergence = window < 0 ? (stratum.treatedPreSlope ?? 0) * (window + 1) : 0
  return clamp(stratum.treatedBase + time + preDivergence + (window >= 0 ? stratum.effect : 0))
}

function generate(plan: Plan): SyntheticTask[] {
  const random = seeded(plan.seed)
  const tasks: SyntheticTask[] = []
  plan.strata.forEach((stratum, s) => {
    for (const cohort of ['treated', 'control'] as const) {
      for (let window = -plan.preWindows; window < plan.postWindows; window++) {
        const p = probability(plan, stratum, cohort, window)
        const planted = Math.round(p * plan.perCell)
        for (let i = 0; i < plan.perCell; i++) {
          const achieved = plan.mode === 'exact' ? i < planted : random() < p
          tasks.push({ inboxId: `s${s}-${cohort}-w${window}-${i}`, session: `s${s}-${cohort}-${i % plan.sessionsPerCohort}`,
            window, dispatchedAt: adoptedAt + window * H + 1 + i, status: achieved ? 'achieved' : 'not-achieved',
            model: stratum.model, exposed: cohort === 'treated' && window >= 0 })
        }
      }
    }
  })
  return tasks
}

function call(task: SyntheticTask): CreationCapabilityCallEvidence {
  const key = `${task.inboxId}-call`
  return { protocol: 'dsh-created-capability-call-evidence/v1', planId: 'plan', key, status: 'completed',
    attribution: 'foreground', toolAlias: tool.name, originalName: tool.originalName,
    receiptDigest, artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest,
    claimedAt: task.dispatchedAt + 10, settledAt: task.dispatchedAt + 20,
    foreground: { protocol: 'assistant-delivery/foreground-tool-call/v1',
      task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId: task.inboxId, sessionId: task.session,
        scope: { workspace: owner.workspace, preset: owner.agentPreset },
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: binding(task.inboxId), dispatchedAt: task.dispatchedAt },
      turn: 1, call: { id: key, toolName: tool.name, eventSeq: 8, eventDigest: 'e'.repeat(64), argumentsDigest: 'f'.repeat(64) } } }
}

/** Indexed Evaluation/Delivery fakes over a fixed replay; the scope watermark never moves. */
function replay(plan: Plan) {
  const tasks = generate(plan)
  const byInbox = new Map(tasks.map(task => [task.inboxId, task]))
  const canonical = (task: SyntheticTask) => ({ triggerOutcomeId: `outcome-${task.inboxId}`, scopeWatermark: 1,
    scope: {}, scopeKey: 'scope', situation: 's',
    projection: { subjectKind: 'foreground-turn', subjectRef: task.inboxId, version: 1, digest: '1'.repeat(64),
      disposition: 'upsert' }, objective: { status: task.status } })
  const delivery = {
    inspectOwnerForegroundLearningTask: ({ outcomeId }: { outcomeId: string }) => {
      const task = byInbox.get(outcomeId.slice('outcome-'.length))
      return task && { protocol: 'assistant-delivery/owner-foreground-learning/v1',
        owner: { ...owner, bindingVersion: 3, generation: 4 }, canonical: canonical(task), judgement: 'owner-feedback',
        ownerRevision: { version: 1, action: 'initial' },
        source: { inboxId: task.inboxId, sessionId: task.session, truncated: false, quiescent: true,
          modelSelectionState: 'frozen', modelSelection: task.model } }
    },
    inspectOwnerForegroundTaskSource: ({ inboxId }: { inboxId: string }) => {
      const task = byInbox.get(inboxId)
      return task && { authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId,
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: { ...binding(inboxId), sessionId: task.session },
        execution: { dispatchedAt: task.dispatchedAt, completedAt: task.dispatchedAt + 500, quiescent: true } }
    },
  }
  const heads = tasks.map((task, index) => ({ watermark: index + 1, receipt: canonical(task) }))
  const evaluation = {
    canonicalHostScope: () => ({ workspace: owner.workspace, preset: owner.agentPreset }),
    listTrustedTaskLearningProjections: ({ after, limit }: { after?: { watermark: number }; limit: number }) => {
      const start = after?.watermark ?? 0
      const page = heads.slice(start, start + limit)
      return { items: page, nextCursor: { scopeKey: 'scope', watermark: start + page.length }, scopeWatermark: 1,
        hasMore: start + page.length < heads.length }
    },
    withTrustedCanonicalScopeWriterFence: (_input: unknown, callback: () => unknown) => ({ matched: true, value: callback() }),
  }
  const input: CreationCapabilityTrendInput = { record, calls: tasks.filter(task => task.exposed).map(call),
    triggerInboxId: 'trigger', owner, evaluation: evaluation as unknown as CreationCapabilityTrendInput['evaluation'],
    delivery: delivery as unknown as CreationCapabilityTrendInput['delivery'],
    readSourceCurrent: () => ({ projection: original, scopeWatermark: 1 }),
    now: adoptedAt + plan.postWindows * H, windowMs: H, preWindows: plan.preWindows, maxPostWindows: plan.postWindows,
    maxScannedHeads: tasks.length }
  return {
    tasks,
    trend: (extra: Partial<CreationCapabilityTrendInput> = {}) => inspectCreationCapabilityOrdinaryUseTrend({ ...input, ...extra })!,
    /** The naive before/after report over the same span: windowMs covers every after window, and as many before. */
    attribution: () => inspectCreationCapabilityAvailabilityAttribution({ ...input, windowMs: plan.postWindows * H })!,
  }
}

const estimated = (did: CreationCapabilityTrendDifferenceInDifferences) => {
  if (did.status !== 'estimated') throw new Error(`expected an estimate, got ${did.status}`)
  return did
}
const covers = (did: { interval95: { low: number; high: number } }, value: number) =>
  did.interval95.low <= value && value <= did.interval95.high

const models = [{ provider: 'p', model: 'm' }, { provider: 'q', model: 'n' }] as const
const modelOf = (model: { provider: string; model: string }) => ({ state: 'frozen', ...model })
/** Two strata with different bases and planted effects; strata sort by model key, matching this order. */
const twoStrata = (effects: readonly [number, number]): StratumPlan[] => [
  { model: models[0], treatedBase: 0.45, controlBase: 0.4, effect: effects[0] },
  { model: models[1], treatedBase: 0.6, controlBase: 0.5, effect: effects[1] },
]
const base = { mode: 'bernoulli', preWindows: 2, postWindows: 2, perCell: 150, sessionsPerCohort: 5, sharedTrend: 0 } as const

describe('created capability ordinary-use trend: synthetic replay against planted ground truth', () => {
  it('recovers the planted effect exactly from exact cells in every model stratum', () => {
    const run = replay({ ...base, mode: 'exact', perCell: 100, seed: 1, sharedTrend: 0.04, strata: twoStrata([0.2, 0.1]) })
    const result = run.trend()
    expect(result.causal).toBe(false)
    expect(result.strata.map(stratum => stratum.model)).toEqual(models.map(modelOf))
    expect(result.cohorts).toEqual({ treatedSessions: 10, controlSessions: 10 })
    expect(result.flags).toEqual([])
    for (const [index, effect] of [0.2, 0.1].entries()) {
      const stratum = result.strata[index]!
      expect(estimated(stratum.differenceInDifferences).estimate).toBeCloseTo(effect, 12)
      expect(stratum.parallelTrend).toEqual({ status: 'not-flagged', testedWindows: 2, gapChange: expect.closeTo(0, 12) })
    }
  })

  it('recovers a planted effect within tolerance with an interval covering it across two model strata', () => {
    const effects = [0.2, 0.1] as const
    // One seeded replay. A single draw misses its 95% interval about one time in twenty (seed 20261106 does for the
    // 0.1 stratum, at about 2.1 standard errors), so the bias claim rests on the seed sweep below.
    const result = replay({ ...base, seed: 1, strata: twoStrata(effects) }).trend()
    expect(result.causal).toBe(false)
    expect(result.population.counted).toBe(2 * 2 * 4 * 150)
    expect(result.flags).toEqual([])
    for (const [index, effect] of effects.entries()) {
      const did = estimated(result.strata[index]!.differenceInDifferences)
      expect(Math.abs(did.estimate - effect)).toBeLessThan(3 * did.standardError)
      expect(covers(did, effect)).toBe(true)
      expect(did.interval95.low).toBeGreaterThan(0)
    }
    // Mean estimate over seeds is within three standard errors of the mean of the planted effect, per stratum.
    const seeds = 30
    const sum = [0, 0]
    const se = [0, 0]
    for (let seed = 100; seed < 100 + seeds; seed++) {
      replay({ ...base, seed, strata: twoStrata(effects) }).trend().strata.forEach((stratum, index) => {
        const did = estimated(stratum.differenceInDifferences)
        sum[index]! += did.estimate
        se[index]! += did.standardError
      })
    }
    for (const [index, effect] of effects.entries()) {
      expect(Math.abs(sum[index]! / seeds - effect)).toBeLessThan(3 * (se[index]! / seeds) / Math.sqrt(seeds))
    }
  })

  it('covers zero when no effect is planted', () => {
    const result = replay({ ...base, seed: 7, strata: twoStrata([0, 0]) }).trend()
    for (const stratum of result.strata) {
      const did = estimated(stratum.differenceInDifferences)
      expect(covers(did, 0)).toBe(true)
      expect(Math.abs(did.estimate)).toBeLessThan(3 * did.standardError)
    }
    expect(result.causal).toBe(false)
  })

  it('keeps nominal interval coverage of the planted effect over many seeds', () => {
    const seeds = 60
    const tally = { zero: 0, planted: 0 }
    for (let seed = 1; seed <= seeds; seed++) {
      const plan = { ...base, perCell: 40, seed, strata: [{ model: models[0], treatedBase: 0.45, controlBase: 0.4, effect: 0 },
        { model: models[1], treatedBase: 0.45, controlBase: 0.4, effect: 0.15 }] }
      const [zero, planted] = replay(plan).trend().strata.map(stratum => estimated(stratum.differenceInDifferences))
      if (covers(zero!, 0)) tally.zero++
      if (covers(planted!, 0.15)) tally.planted++
    }
    // Nominal 95%; 0.85 is more than three binomial standard deviations below it at 60 seeds.
    expect(tally.zero / seeds).toBeGreaterThanOrEqual(0.85)
    expect(tally.planted / seeds).toBeGreaterThanOrEqual(0.85)
  })

  it('flags parallel-trend-suspect when pre-adoption trends diverge, and not when they are parallel', () => {
    const strata = (treatedPreSlope: number): StratumPlan[] =>
      [{ model: models[0], treatedBase: 0.6, controlBase: 0.4, effect: 0.1, treatedPreSlope }]
    const plan = { ...base, mode: 'exact', perCell: 100, preWindows: 4, seed: 3, sharedTrend: 0.02 } as const
    const diverging = replay({ ...plan, strata: strata(0.1) }).trend()
    // Treated gap at -1 minus at -4 equals 3 windows of the extra 0.1 slope.
    expect(diverging.strata[0]!.parallelTrend).toEqual({ status: 'parallel-trend-suspect', testedWindows: 4,
      gapChange: expect.closeTo(0.3, 12) })
    expect(diverging.flags).toContain('parallel-trend-suspect')
    expect(diverging.causal).toBe(false)
    const parallel = replay({ ...plan, strata: strata(0) }).trend()
    expect(parallel.strata[0]!.parallelTrend).toMatchObject({ status: 'not-flagged', gapChange: expect.closeTo(0, 12) })
    expect(parallel.flags).not.toContain('parallel-trend-suspect')
  })

  it('a shared time trend leaves DiD unbiased while the naive before/after attribution absorbs it', () => {
    // No planted effect; both cohorts improve by 0.08 per window. Before windows -2,-1, after windows 0,1.
    const run = replay({ ...base, mode: 'exact', perCell: 100, seed: 5, sharedTrend: 0.08, strata: twoStrata([0, 0]) })
    const trend = run.trend()
    const attribution = run.attribution()
    expect(attribution.windowMs).toBe(2 * H)
    expect(attribution.population.counted).toBe(trend.population.counted)
    for (const index of [0, 1]) {
      expect(estimated(trend.strata[index]!.differenceInDifferences).estimate).toBeCloseTo(0, 12)
      const naive = attribution.strata[index]!.achievedRateDelta
      if (naive.status !== 'paired') throw new Error('expected a paired naive delta')
      // Mean after window index 0.5 minus mean before -1.5: two windows of the shared 0.08 trend.
      expect(naive.numerator / naive.denominator).toBeCloseTo(0.16, 12)
    }
    // The naive report reads the shared trend as improvement; DiD does not. Neither claims causality.
    expect(attribution.direction).toBe('improved')
    expect(attribution.causal).toBe(false)
    expect(trend.causal).toBe(false)
    // With a planted effect too, DiD still recovers it while the naive delta mixes trend and the treated share.
    const both = replay({ ...base, mode: 'exact', perCell: 100, seed: 5, sharedTrend: 0.08, strata: twoStrata([0.1, 0.1]) })
    expect(estimated(both.trend().strata[0]!.differenceInDifferences).estimate).toBeCloseTo(0.1, 12)
    const mixed = both.attribution().strata[0]!.achievedRateDelta
    if (mixed.status !== 'paired') throw new Error('expected a paired naive delta')
    expect(mixed.numerator / mixed.denominator).toBeCloseTo(0.16 + 0.1 / 2, 12)
  })

  it('marks too few samples insufficient in both estimators and stays non-causal', () => {
    const run = replay({ ...base, perCell: 1, sessionsPerCohort: 1, seed: 11, strata: twoStrata([0.3, 0.3]) })
    const trend = run.trend()
    expect(trend.minimumSamples).toBe(5)
    expect(trend.causal).toBe(false)
    for (const stratum of trend.strata) {
      expect(stratum.differenceInDifferences).toEqual({ status: 'insufficient' })
      expect(stratum.parallelTrend).toEqual({ status: 'untestable', testedWindows: 0 })
      expect(stratum.cells.every(cell => cell.treated.status === 'insufficient' && cell.control.status === 'insufficient'))
        .toBe(true)
    }
    const attribution = run.attribution()
    expect(attribution.causal).toBe(false)
    expect(attribution.strata.every(stratum => stratum.achievedRateDelta.status === 'insufficient')).toBe(true)
    expect(attribution.direction).toBe('insufficient')
  })
})
