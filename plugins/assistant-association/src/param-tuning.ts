import type { DatabaseSync } from 'node:sqlite'
import {
  assertExactGrowthKeys,
  canonicalGrowthJson,
  growthObjectDigest,
  isGrowthRecord,
} from '@dsh-enhanced/assistant-growth-contract'
import type { NormalizedAssociationConfig } from './config.js'
import { runHotPathQuery } from './hot-path.js'
import type { AssociationMemoryIndex } from './index-memory.js'
import {
  DEFAULT_SOURCE_WEIGHTS,
  NODE_KINDS,
  WEB_LEARNING_SOURCE_PLUGIN,
  type HotPathClock,
  type HotPathCue,
  type HotPathFilter,
  type HotPathProfile,
  type NodeKind,
} from './types.js'

export const ASSOC_PARAM_PROFILE_PROTOCOL = 'assistant-association/param-profile/v1' as const
export const ASSOC_PARAM_RELAX_PROTOCOL = 'assistant-association/param-relaxation/v1' as const
export const ASSOC_PARAM_HOLDOUT_PROTOCOL = 'assistant-association/param-holdout/v1' as const

export const DECAY_HALF_LIFE_LADDER: readonly number[] = Object.freeze([
  86_400_000, // 1d (tightest)
  259_200_000, // 3d
  604_800_000, // 7d
  1_209_600_000, // 14d
  2_592_000_000, // 30d (loosest)
])

export const ASSOC_PARAM_BOUNDS = Object.freeze({
  maxHops: Object.freeze({ min: 1, max: 2, step: 1 }),
  maxItems: Object.freeze({ min: 5, max: 8, step: 1 }),
  hysteresisDeltaMilli: Object.freeze({ min: 50, max: 500, step: 50 }),
  sourceWeightPct: Object.freeze({ min: 20, max: 150, step: 10 }),
})

const PROFILE_KEYS = [
  'decayHalfLifeMs',
  'maxHops',
  'maxItems',
  'hysteresisDeltaMilli',
  'sourceWeightsPct',
] as const

const SOURCE_PLUGIN_TO_KIND: Readonly<Record<string, NodeKind>> = Object.freeze({
  'personal-memory': 'memory',
  'assistant-goals': 'goal',
  'assistant-work-items': 'work-item',
  'assistant-automations': 'automation',
  'assistant-delivery': 'episode',
  'personal-wiki': 'wiki',
  'assistant-skills': 'skill',
  'event-triggers': 'event',
  'assistant-dreaming': 'dream',
  [WEB_LEARNING_SOURCE_PLUGIN]: 'web',
})

export interface AssocParamProfileValues {
  readonly decayHalfLifeMs: number
  readonly maxHops: number
  readonly maxItems: number
  readonly hysteresisDeltaMilli: number
  readonly sourceWeightsPct: Readonly<Record<NodeKind, number>>
}

export type AssocParamField =
  | 'decayHalfLifeMs'
  | 'maxHops'
  | 'maxItems'
  | 'hysteresisDeltaMilli'
  | `sourceWeightsPct.${NodeKind}`

export interface AssocParamChange {
  readonly parameter: AssocParamField
  readonly from: number
  readonly to: number
  readonly steps: number
}

export type AssocParamDirection = 'identical' | 'tighten' | 'relax'
export type AssocParamOrigin = 'baseline' | 'auto' | 'replay' | 'manual'

export interface AssocParamTuningPolicy {
  readonly minSample: number
  readonly minStepSample: number
  readonly minSourceSample: number
  readonly minHoldoutSamples: number
  readonly maxTimeoutRatePpm: number
  readonly lowUsageRatePpm: number
  readonly healthyUsageRatePpm: number
  readonly highCorrectionRatePpm: number
  readonly noisySourceRatePpm: number
  readonly regressionMarginPpm: number
  readonly timeoutMarginPpm: number
  readonly maxTimeoutMarginPpm: number
  readonly usageDropMarginPpm: number
  readonly observationMs: number
  readonly evaluationWindowMs: number
  readonly relaxReplayWindowMs: number
  readonly rollbackCooldownMs: number
  readonly hotPathBudgetMs: number
  readonly minItems: number
  readonly autoTightenEnabled: boolean
  readonly relaxationReplayEnabled: boolean
}

export const DEFAULT_ASSOC_PARAM_TUNING_POLICY: AssocParamTuningPolicy = Object.freeze({
  minSample: 20,
  minStepSample: 20,
  minSourceSample: 10,
  minHoldoutSamples: 20,
  maxTimeoutRatePpm: 50_000,
  lowUsageRatePpm: 100_000,
  healthyUsageRatePpm: 250_000,
  highCorrectionRatePpm: 250_000,
  noisySourceRatePpm: 850_000,
  regressionMarginPpm: 100_000,
  timeoutMarginPpm: 25_000,
  maxTimeoutMarginPpm: 25_000,
  usageDropMarginPpm: 100_000,
  observationMs: 7 * 86_400_000,
  evaluationWindowMs: 7 * 86_400_000,
  relaxReplayWindowMs: 30 * 86_400_000,
  rollbackCooldownMs: 7 * 86_400_000,
  hotPathBudgetMs: 4.5,
  minItems: 5,
  autoTightenEnabled: true,
  relaxationReplayEnabled: true,
})

export interface AssocSourceExposureStats {
  readonly total: number
  readonly unusedOrCorrected: number
}

export interface AssocWindowStats {
  readonly fromAt: number
  readonly toAt: number
  readonly totalSteps: number
  readonly timedOutSteps: number
  readonly p99LatencyUs: number
  readonly injectedTasks: number
  readonly decidedTasks: number
  readonly usedTasks: number
  readonly correctedTasks: number
  readonly sourceExposures: Readonly<Record<NodeKind, AssocSourceExposureStats>>
}

export interface AssocParamProfileVersion {
  readonly protocol: typeof ASSOC_PARAM_PROFILE_PROTOCOL
  readonly scopeKey: string
  readonly version: number
  readonly parentVersion: number | null
  readonly parentDigest: string | null
  readonly parameters: AssocParamProfileValues
  readonly paramsDigest: string
  readonly basis: Readonly<{ readonly stats: AssocWindowStats }>
  readonly change: AssocParamChange | null
  readonly origin: AssocParamOrigin
  readonly digest: string
  readonly createdAt: number
}

export interface AssocParamCurrent {
  readonly scopeKey: string
  readonly version: number
  readonly origin: AssocParamOrigin
  readonly digest: string
  readonly paramsDigest: string
  readonly parameters: AssocParamProfileValues
  readonly source: 'active' | 'parent-fallback' | 'default'
}

export interface AssocParamProfileEvent {
  readonly sequence: number
  readonly kind: 'adopted' | 'rolled-back' | 'settled' | 'request-rejected'
  readonly fromVersion: number | null
  readonly toVersion: number | null
  readonly fromDigest: string | null
  readonly toDigest: string | null
  readonly reason: string
  readonly detail: Readonly<Record<string, unknown>>
  readonly occurredAt: number
}

export interface AssocParamHoldoutSeal {
  readonly protocol: typeof ASSOC_PARAM_HOLDOUT_PROTOCOL
  readonly count: number
  readonly digest: string
}

export interface AssocRelaxationProposal {
  readonly protocol: typeof ASSOC_PARAM_RELAX_PROTOCOL
  readonly scopeKey: string
  readonly ordinal: number
  readonly parentVersion: number
  readonly parentDigest: string
  readonly parent: AssocParamProfileValues
  readonly candidate: AssocParamProfileValues
  readonly change: AssocParamChange
  readonly reason: string
  readonly window: Readonly<{ readonly fromAt: number; readonly toAt: number }>
  readonly holdout: AssocParamHoldoutSeal
  readonly basis: Readonly<{ readonly stats: AssocWindowStats }>
  readonly createdAt: number
}

export type AssocRelaxReplayFailure =
  | 'insufficient-holdout'
  | 'holdout-regression'
  | 'insufficient-replay-episodes'
  | 'replay-timeouts'
  | 'latency-budget-exceeded'
  | 'recall-regression'
  | 'no-net-benefit'

export interface AssocRelaxReplayTally {
  readonly timeouts: number
  readonly p99Ms: number
  readonly usedHits: number
  readonly noiseExposed: number
}

export interface AssocRelaxReplaySummary {
  readonly protocol: typeof ASSOC_PARAM_RELAX_PROTOCOL
  readonly episodeCount: number
  readonly holdoutDecided: number
  readonly trainingDecided: number
  readonly parent: AssocRelaxReplayTally
  readonly candidate: AssocRelaxReplayTally
  readonly verdict: 'pass' | 'fail'
  readonly failureReason?: AssocRelaxReplayFailure
}

export interface AssocRelaxationDecision {
  readonly decisionId: string
  readonly proposalId: string
  readonly decision: 'adopted' | 'rejected'
  readonly reason: string
  readonly version: number | null
  readonly replay: AssocRelaxReplaySummary | null
  readonly decidedAt: number
}

export interface AssocParamTuningStatus {
  readonly current: AssocParamCurrent
  readonly state: 'idle' | 'observing'
  readonly observeFrom?: number
  readonly observeUntil?: number
  readonly versions: readonly AssocParamProfileVersion[]
  readonly events: readonly AssocParamProfileEvent[]
  readonly proposals: readonly Readonly<{
    readonly proposalId: string
    readonly proposal: AssocRelaxationProposal
    readonly decision: AssocRelaxationDecision | null
  }>[]
  readonly blockedParamsDigests: readonly string[]
}

export type AssocParamRequestRejection =
  | 'loosening-requires-holdout'
  | 'out-of-bounds'
  | 'no-change'
  | 'not-single-step'
  | 'not-single-parameter'
  | 'auto-adoption-disabled'
  | 'observation-in-progress'
  | 'proposal-pending'
  | 'digest-previously-rolled-back'
  | 'rollback-cooldown'

export type AssocRelaxRejection =
  | 'proposal-unverifiable'
  | 'stale-parent'
  | 'holdout-drifted'
  | 'holdout-failed'
  | 'digest-previously-rolled-back'
  | 'rollback-cooldown'

export type AssocParamRequestResult =
  | Readonly<{
      readonly status: 'adopted'
      readonly version: number
      readonly change: AssocParamChange
    }>
  | Readonly<{
      readonly status: 'proposed'
      readonly proposalId: string
      readonly holdout: AssocParamHoldoutSeal
    }>
  | Readonly<{
      readonly status: 'rejected'
      readonly reason: AssocParamRequestRejection
    }>

export type AssocParamTickAction =
  | Readonly<{
      readonly action: 'adopted'
      readonly version: number
      readonly change: AssocParamChange
      readonly triggerReason: string
    }>
  | Readonly<{
      readonly action: 'rolled-back'
      readonly fromVersion: number
      readonly toVersion: number
      readonly reason: string
    }>
  | Readonly<{ readonly action: 'settled'; readonly version: number }>
  | Readonly<{ readonly action: 'observing'; readonly version: number }>
  | Readonly<{
      readonly action: 'no-op'
      readonly reason:
        | 'insufficient-sample'
        | 'below-threshold'
        | 'at-bound'
        | 'blocked-by-rollback'
        | 'rollback-cooldown'
        | 'disabled'
    }>
  | Readonly<{
      readonly action: 'relax-adopted'
      readonly version: number
      readonly change: AssocParamChange
      readonly proposalId: string
      readonly replay: AssocRelaxReplaySummary
    }>
  | Readonly<{
      readonly action: 'relax-rejected'
      readonly reason: AssocRelaxRejection
      readonly proposalId: string
      readonly replay?: AssocRelaxReplaySummary
    }>

export interface AssocParamTightenProposal {
  readonly kind: 'tighten'
  readonly change: AssocParamChange
  readonly parameters: AssocParamProfileValues
  readonly triggerReason: string
}

export type AssocParamProposalResult =
  | AssocParamTightenProposal
  | Readonly<{
      readonly kind: 'no-op'
      readonly reason: 'insufficient-sample' | 'below-threshold' | 'at-bound' | 'blocked-by-rollback'
    }>

export class AssocParamTuningError extends Error {
  constructor(
    readonly code: 'invalid-input' | 'tampered',
    message: string,
  ) {
    super(message)
    this.name = 'AssocParamTuningError'
  }
}

function invalid(message: string): never {
  throw new AssocParamTuningError('invalid-input', `assoc param tuning: ${message}`)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      deepFreeze(entry)
    }
    Object.freeze(value)
  }
  return value
}

function validateScopeKey(scopeKey: unknown): string {
  if (
    typeof scopeKey !== 'string' ||
    scopeKey.length < 1 ||
    scopeKey.length > 128 ||
    scopeKey.trim() !== scopeKey ||
    /\p{Cc}/u.test(scopeKey)
  ) {
    invalid('scopeKey must be a non-empty bounded identifier')
  }
  return scopeKey
}

function clampGridInt(value: number, min: number, max: number, step: number): number {
  const finite = Number.isFinite(value) ? value : min
  const clamped = Math.min(max, Math.max(min, finite))
  const snapped = min + Math.round((clamped - min) / step) * step
  return Math.min(max, Math.max(min, snapped))
}

export function snapDecayHalfLifeMs(value: number): number {
  const minRung = DECAY_HALF_LIFE_LADDER[0]!
  const maxRung = DECAY_HALF_LIFE_LADDER[DECAY_HALF_LIFE_LADDER.length - 1]!
  const finite = Number.isFinite(value) ? value : 1_209_600_000
  const clamped = Math.min(maxRung, Math.max(minRung, finite))
  let best = minRung
  let bestDist = Math.abs(clamped - minRung)
  for (let i = 1; i < DECAY_HALF_LIFE_LADDER.length; i += 1) {
    const rung = DECAY_HALF_LIFE_LADDER[i]!
    const dist = Math.abs(clamped - rung)
    if (dist < bestDist) {
      best = rung
      bestDist = dist
    }
  }
  return best
}

export function clampAssocParamProfile(
  input: AssocParamProfileValues,
  options?: { readonly minItems?: number },
): AssocParamProfileValues {
  const minItems = Math.max(
    ASSOC_PARAM_BOUNDS.maxItems.min,
    Math.min(ASSOC_PARAM_BOUNDS.maxItems.max, Math.trunc(options?.minItems ?? 5)),
  )
  const weights: Record<string, number> = {}
  for (const kind of NODE_KINDS) {
    const raw = input.sourceWeightsPct[kind] ?? Math.round(DEFAULT_SOURCE_WEIGHTS[kind] * 100)
    weights[kind] = clampGridInt(
      raw,
      ASSOC_PARAM_BOUNDS.sourceWeightPct.min,
      ASSOC_PARAM_BOUNDS.sourceWeightPct.max,
      ASSOC_PARAM_BOUNDS.sourceWeightPct.step,
    )
  }
  return deepFreeze({
    decayHalfLifeMs: snapDecayHalfLifeMs(input.decayHalfLifeMs),
    maxHops: clampGridInt(
      input.maxHops,
      ASSOC_PARAM_BOUNDS.maxHops.min,
      ASSOC_PARAM_BOUNDS.maxHops.max,
      ASSOC_PARAM_BOUNDS.maxHops.step,
    ),
    maxItems: clampGridInt(
      input.maxItems,
      minItems,
      ASSOC_PARAM_BOUNDS.maxItems.max,
      ASSOC_PARAM_BOUNDS.maxItems.step,
    ),
    hysteresisDeltaMilli: clampGridInt(
      input.hysteresisDeltaMilli,
      ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.min,
      ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.max,
      ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.step,
    ),
    sourceWeightsPct: weights as Record<NodeKind, number>,
  })
}

export function normalizeAssocParamProfile(input: unknown): AssocParamProfileValues {
  if (!isGrowthRecord(input)) invalid('profile must be an object')
  assertExactGrowthKeys(input, PROFILE_KEYS, 'assocParamProfile')
  for (const key of ['decayHalfLifeMs', 'maxHops', 'maxItems', 'hysteresisDeltaMilli'] as const) {
    if (!Number.isSafeInteger(input[key])) {
      invalid(`${key} must be a safe integer`)
    }
  }
  const rawWeights = input.sourceWeightsPct
  if (!isGrowthRecord(rawWeights)) invalid('sourceWeightsPct must be an object')
  assertExactGrowthKeys(rawWeights, NODE_KINDS, 'assocParamProfile.sourceWeightsPct')
  const weights: Record<string, number> = {}
  for (const kind of NODE_KINDS) {
    const val = rawWeights[kind]
    if (!Number.isSafeInteger(val)) {
      invalid(`sourceWeightsPct.${kind} must be a safe integer`)
    }
    weights[kind] = val as number
  }
  return deepFreeze({
    decayHalfLifeMs: input.decayHalfLifeMs as number,
    maxHops: input.maxHops as number,
    maxItems: input.maxItems as number,
    hysteresisDeltaMilli: input.hysteresisDeltaMilli as number,
    sourceWeightsPct: weights as Record<NodeKind, number>,
  })
}

export function withinAssocParamBounds(
  profile: AssocParamProfileValues,
  options?: { readonly minItems?: number },
): boolean {
  const minItems = Math.max(
    ASSOC_PARAM_BOUNDS.maxItems.min,
    Math.min(ASSOC_PARAM_BOUNDS.maxItems.max, Math.trunc(options?.minItems ?? 5)),
  )
  if (!DECAY_HALF_LIFE_LADDER.includes(profile.decayHalfLifeMs)) return false
  if (
    !Number.isSafeInteger(profile.maxHops) ||
    profile.maxHops < ASSOC_PARAM_BOUNDS.maxHops.min ||
    profile.maxHops > ASSOC_PARAM_BOUNDS.maxHops.max
  ) {
    return false
  }
  if (
    !Number.isSafeInteger(profile.maxItems) ||
    profile.maxItems < minItems ||
    profile.maxItems > ASSOC_PARAM_BOUNDS.maxItems.max
  ) {
    return false
  }
  if (
    !Number.isSafeInteger(profile.hysteresisDeltaMilli) ||
    profile.hysteresisDeltaMilli < ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.min ||
    profile.hysteresisDeltaMilli > ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.max ||
    (profile.hysteresisDeltaMilli - ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.min) %
      ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.step !==
      0
  ) {
    return false
  }
  for (const kind of NODE_KINDS) {
    const w = profile.sourceWeightsPct[kind]
    if (
      !Number.isSafeInteger(w) ||
      w < ASSOC_PARAM_BOUNDS.sourceWeightPct.min ||
      w > ASSOC_PARAM_BOUNDS.sourceWeightPct.max ||
      (w - ASSOC_PARAM_BOUNDS.sourceWeightPct.min) % ASSOC_PARAM_BOUNDS.sourceWeightPct.step !== 0
    ) {
      return false
    }
  }
  return true
}

export function fromAssociationConfig(
  config: Pick<
    NormalizedAssociationConfig,
    'decayHalfLifeMs' | 'maxHops' | 'maxItems' | 'minItems' | 'hysteresisDelta' | 'sourceWeights'
  >,
): AssocParamProfileValues {
  const weights: Record<string, number> = {}
  for (const kind of NODE_KINDS) {
    const raw = config.sourceWeights[kind] ?? DEFAULT_SOURCE_WEIGHTS[kind]
    weights[kind] = clampGridInt(
      Math.round(raw * 100),
      ASSOC_PARAM_BOUNDS.sourceWeightPct.min,
      ASSOC_PARAM_BOUNDS.sourceWeightPct.max,
      ASSOC_PARAM_BOUNDS.sourceWeightPct.step,
    )
  }
  return clampAssocParamProfile(
    {
      decayHalfLifeMs: snapDecayHalfLifeMs(config.decayHalfLifeMs),
      maxHops: Math.round(config.maxHops),
      maxItems: Math.round(config.maxItems),
      hysteresisDeltaMilli: Math.round(config.hysteresisDelta * 1000),
      sourceWeightsPct: weights as Record<NodeKind, number>,
    },
    { minItems: config.minItems },
  )
}

export function toHotPathProfile(
  values: AssocParamProfileValues,
  baseConfig: Pick<NormalizedAssociationConfig, 'hopTopN' | 'maxFanoutPerNode' | 'hotPathBudgetMs'>,
): HotPathProfile & { readonly hysteresisDelta: number } {
  const sourceWeights: Record<string, number> = {}
  for (const kind of NODE_KINDS) {
    sourceWeights[kind] = values.sourceWeightsPct[kind] / 100
  }
  return deepFreeze({
    maxHops: values.maxHops,
    hopTopN: baseConfig.hopTopN,
    maxFanoutPerNode: baseConfig.maxFanoutPerNode,
    maxItems: values.maxItems,
    decayHalfLifeMs: values.decayHalfLifeMs,
    budgetMs: baseConfig.hotPathBudgetMs,
    sourceWeights: sourceWeights as Record<NodeKind, number>,
    hysteresisDelta: values.hysteresisDeltaMilli / 1000,
  })
}

export function isProfileTighterOrEqual(
  a: AssocParamProfileValues,
  b: AssocParamProfileValues,
): boolean {
  if (a.decayHalfLifeMs > b.decayHalfLifeMs) return false
  if (a.maxHops > b.maxHops) return false
  if (a.maxItems > b.maxItems) return false
  if (a.hysteresisDeltaMilli < b.hysteresisDeltaMilli) return false
  for (const kind of NODE_KINDS) {
    if (a.sourceWeightsPct[kind] > b.sourceWeightsPct[kind]) return false
  }
  return true
}

export function classifyProfileChange(
  current: AssocParamProfileValues,
  next: AssocParamProfileValues,
): AssocParamDirection {
  if (canonicalGrowthJson(current) === canonicalGrowthJson(next)) {
    return 'identical'
  }
  if (isProfileTighterOrEqual(next, current)) {
    return 'tighten'
  }
  return 'relax'
}

interface ParamDiffEntry {
  readonly parameter: AssocParamField
  readonly from: number
  readonly to: number
}

function collectParamDiffs(
  current: AssocParamProfileValues,
  next: AssocParamProfileValues,
): ParamDiffEntry[] {
  const diffs: ParamDiffEntry[] = []
  if (current.decayHalfLifeMs !== next.decayHalfLifeMs) {
    diffs.push({ parameter: 'decayHalfLifeMs', from: current.decayHalfLifeMs, to: next.decayHalfLifeMs })
  }
  if (current.maxHops !== next.maxHops) {
    diffs.push({ parameter: 'maxHops', from: current.maxHops, to: next.maxHops })
  }
  if (current.maxItems !== next.maxItems) {
    diffs.push({ parameter: 'maxItems', from: current.maxItems, to: next.maxItems })
  }
  if (current.hysteresisDeltaMilli !== next.hysteresisDeltaMilli) {
    diffs.push({
      parameter: 'hysteresisDeltaMilli',
      from: current.hysteresisDeltaMilli,
      to: next.hysteresisDeltaMilli,
    })
  }
  for (const kind of NODE_KINDS) {
    if (current.sourceWeightsPct[kind] !== next.sourceWeightsPct[kind]) {
      diffs.push({
        parameter: `sourceWeightsPct.${kind}`,
        from: current.sourceWeightsPct[kind],
        to: next.sourceWeightsPct[kind],
      })
    }
  }
  return diffs
}

export function describeSingleTighteningStep(
  current: AssocParamProfileValues,
  next: AssocParamProfileValues,
  options?: { readonly minItems?: number },
): AssocParamChange | undefined {
  if (!withinAssocParamBounds(next, options)) return undefined
  const diffs = collectParamDiffs(current, next)
  if (diffs.length !== 1) return undefined
  const diff = diffs[0]!
  if (diff.parameter === 'decayHalfLifeMs') {
    const curIdx = DECAY_HALF_LIFE_LADDER.indexOf(diff.from)
    const nextIdx = DECAY_HALF_LIFE_LADDER.indexOf(diff.to)
    if (curIdx < 0 || nextIdx !== curIdx - 1) return undefined
    return Object.freeze({ parameter: diff.parameter, from: diff.from, to: diff.to, steps: 1 })
  }
  if (diff.parameter === 'maxHops' || diff.parameter === 'maxItems') {
    if (diff.from - diff.to !== 1) return undefined
    return Object.freeze({ parameter: diff.parameter, from: diff.from, to: diff.to, steps: 1 })
  }
  if (diff.parameter === 'hysteresisDeltaMilli') {
    if (diff.to - diff.from !== ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.step) return undefined
    return Object.freeze({ parameter: diff.parameter, from: diff.from, to: diff.to, steps: 1 })
  }
  if (diff.from - diff.to !== ASSOC_PARAM_BOUNDS.sourceWeightPct.step) return undefined
  return Object.freeze({ parameter: diff.parameter, from: diff.from, to: diff.to, steps: 1 })
}

export function describeRelaxationChange(
  current: AssocParamProfileValues,
  next: AssocParamProfileValues,
  options?: { readonly minItems?: number },
): AssocParamChange | undefined {
  if (!withinAssocParamBounds(next, options)) return undefined
  const diffs = collectParamDiffs(current, next)
  if (diffs.length !== 1) return undefined
  const diff = diffs[0]!
  if (diff.parameter === 'decayHalfLifeMs') {
    const curIdx = DECAY_HALF_LIFE_LADDER.indexOf(diff.from)
    const nextIdx = DECAY_HALF_LIFE_LADDER.indexOf(diff.to)
    if (curIdx < 0 || nextIdx <= curIdx) return undefined
    return Object.freeze({
      parameter: diff.parameter,
      from: diff.from,
      to: diff.to,
      steps: nextIdx - curIdx,
    })
  }
  if (diff.parameter === 'maxHops' || diff.parameter === 'maxItems') {
    const delta = diff.to - diff.from
    if (delta <= 0) return undefined
    return Object.freeze({ parameter: diff.parameter, from: diff.from, to: diff.to, steps: delta })
  }
  if (diff.parameter === 'hysteresisDeltaMilli') {
    const delta = diff.from - diff.to
    const { step } = ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli
    if (delta <= 0 || delta % step !== 0) return undefined
    return Object.freeze({
      parameter: diff.parameter,
      from: diff.from,
      to: diff.to,
      steps: delta / step,
    })
  }
  const delta = diff.to - diff.from
  const { step } = ASSOC_PARAM_BOUNDS.sourceWeightPct
  if (delta <= 0 || delta % step !== 0) return undefined
  return Object.freeze({
    parameter: diff.parameter,
    from: diff.from,
    to: diff.to,
    steps: delta / step,
  })
}

function atLeastRate(numerator: number, denominator: number, ratePpm: number): boolean {
  if (denominator <= 0) return false
  return BigInt(numerator) * 1_000_000n >= BigInt(ratePpm) * BigInt(denominator)
}

function atMostRate(numerator: number, denominator: number, ratePpm: number): boolean {
  if (denominator <= 0) return false
  return BigInt(numerator) * 1_000_000n <= BigInt(ratePpm) * BigInt(denominator)
}

function buildTightenedCandidate(
  current: AssocParamProfileValues,
  field: AssocParamField,
  minItems: number,
): Readonly<{ readonly change: AssocParamChange; readonly parameters: AssocParamProfileValues }> | undefined {
  if (field === 'maxHops') {
    if (current.maxHops <= ASSOC_PARAM_BOUNDS.maxHops.min) return undefined
    const to = current.maxHops - 1
    return deepFreeze({
      change: { parameter: 'maxHops', from: current.maxHops, to, steps: 1 },
      parameters: { ...current, maxHops: to },
    })
  }
  if (field === 'maxItems') {
    if (current.maxItems <= minItems) return undefined
    const to = current.maxItems - 1
    return deepFreeze({
      change: { parameter: 'maxItems', from: current.maxItems, to, steps: 1 },
      parameters: { ...current, maxItems: to },
    })
  }
  if (field === 'hysteresisDeltaMilli') {
    if (current.hysteresisDeltaMilli >= ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.max) return undefined
    const to = current.hysteresisDeltaMilli + ASSOC_PARAM_BOUNDS.hysteresisDeltaMilli.step
    return deepFreeze({
      change: {
        parameter: 'hysteresisDeltaMilli',
        from: current.hysteresisDeltaMilli,
        to,
        steps: 1,
      },
      parameters: { ...current, hysteresisDeltaMilli: to },
    })
  }
  if (field === 'decayHalfLifeMs') {
    const idx = DECAY_HALF_LIFE_LADDER.indexOf(current.decayHalfLifeMs)
    if (idx <= 0) return undefined
    const to = DECAY_HALF_LIFE_LADDER[idx - 1]!
    return deepFreeze({
      change: { parameter: 'decayHalfLifeMs', from: current.decayHalfLifeMs, to, steps: 1 },
      parameters: { ...current, decayHalfLifeMs: to },
    })
  }
  const kind = field.slice('sourceWeightsPct.'.length) as NodeKind
  const curW = current.sourceWeightsPct[kind]
  if (curW <= ASSOC_PARAM_BOUNDS.sourceWeightPct.min) return undefined
  const to = curW - ASSOC_PARAM_BOUNDS.sourceWeightPct.step
  return deepFreeze({
    change: { parameter: field, from: curW, to, steps: 1 },
    parameters: {
      ...current,
      sourceWeightsPct: { ...current.sourceWeightsPct, [kind]: to },
    },
  })
}

export function proposeAssocParamTightening(
  currentInput: AssocParamProfileValues,
  stats: AssocWindowStats,
  policy: AssocParamTuningPolicy,
  isBlockedParamsDigest: (paramsDigest: string) => boolean = () => false,
): AssocParamProposalResult {
  const minItems = Math.max(
    ASSOC_PARAM_BOUNDS.maxItems.min,
    Math.min(ASSOC_PARAM_BOUNDS.maxItems.max, Math.trunc(policy.minItems)),
  )
  const current = clampAssocParamProfile(currentInput, { minItems })
  const hasStepSample = stats.totalSteps >= policy.minStepSample
  const hasTaskSample = stats.decidedTasks >= policy.minSample
  if (!hasStepSample && !hasTaskSample) {
    return deepFreeze({ kind: 'no-op', reason: 'insufficient-sample' })
  }

  const highTimeout =
    stats.totalSteps >= policy.minStepSample &&
    atLeastRate(stats.timedOutSteps, stats.totalSteps, policy.maxTimeoutRatePpm)
  const highCorrection =
    stats.injectedTasks >= policy.minSample &&
    atLeastRate(stats.correctedTasks, stats.injectedTasks, policy.highCorrectionRatePpm)
  const lowUsage =
    stats.totalSteps >= policy.minStepSample &&
    stats.injectedTasks >= policy.minSample &&
    atMostRate(stats.usedTasks, stats.injectedTasks, policy.lowUsageRatePpm) &&
    !atLeastRate(stats.usedTasks, stats.injectedTasks, policy.healthyUsageRatePpm)

  if (!highTimeout && !highCorrection && !lowUsage) {
    if (stats.totalSteps < policy.minStepSample && stats.injectedTasks < policy.minSample) {
      return deepFreeze({ kind: 'no-op', reason: 'insufficient-sample' })
    }
    return deepFreeze({ kind: 'no-op', reason: 'below-threshold' })
  }

  const candidateFields: AssocParamField[] = []
  let triggerReason = 'low-usage-rate'

  if (highTimeout) {
    triggerReason = 'high-timeout-rate'
    candidateFields.push('maxHops', 'maxItems', 'decayHalfLifeMs', 'hysteresisDeltaMilli')
  } else {
    triggerReason = highCorrection ? 'high-correction-rate' : 'low-usage-rate'
    const noisyKinds: Array<{ readonly kind: NodeKind; readonly ratio: number }> = []
    for (const kind of NODE_KINDS) {
      const exp = stats.sourceExposures[kind]
      if (
        exp.total >= policy.minSourceSample &&
        atLeastRate(exp.unusedOrCorrected, exp.total, policy.noisySourceRatePpm)
      ) {
        noisyKinds.push({ kind, ratio: exp.unusedOrCorrected / exp.total })
      }
    }
    noisyKinds.sort((a, b) => b.ratio - a.ratio)
    for (const entry of noisyKinds) {
      candidateFields.push(`sourceWeightsPct.${entry.kind}`)
    }
    candidateFields.push('maxItems', 'hysteresisDeltaMilli', 'decayHalfLifeMs', 'maxHops')
  }

  let sawUnblockedBound = false
  for (const field of candidateFields) {
    const candidate = buildTightenedCandidate(current, field, minItems)
    if (candidate === undefined) continue
    sawUnblockedBound = true
    const paramsDigest = growthObjectDigest(candidate.parameters)
    if (isBlockedParamsDigest(paramsDigest)) continue
    return deepFreeze({
      kind: 'tighten',
      change: candidate.change,
      parameters: candidate.parameters,
      triggerReason:
        field.startsWith('sourceWeightsPct.') && !highTimeout ? 'noisy-source-kind' : triggerReason,
    })
  }

  return deepFreeze({
    kind: 'no-op',
    reason: sawUnblockedBound ? 'blocked-by-rollback' : 'at-bound',
  })
}

export function hasAssocObservedRegression(
  basis: AssocWindowStats,
  post: AssocWindowStats,
  policy: AssocParamTuningPolicy,
): { readonly regressed: boolean; readonly reason?: string } {
  if (post.decidedTasks < policy.minSample && post.totalSteps < policy.minStepSample) {
    return Object.freeze({ regressed: false })
  }

  const effectiveTimeoutMarginPpm = Math.min(policy.timeoutMarginPpm, policy.maxTimeoutMarginPpm)
  if (post.totalSteps >= policy.minStepSample) {
    if (basis.totalSteps > 0) {
      const left = BigInt(post.timedOutSteps) * BigInt(basis.totalSteps) * 1_000_000n
      const right =
        BigInt(basis.timedOutSteps) * BigInt(post.totalSteps) * 1_000_000n +
        BigInt(effectiveTimeoutMarginPpm) * BigInt(basis.totalSteps) * BigInt(post.totalSteps)
      if (left > right) {
        return Object.freeze({ regressed: true, reason: 'timeout-rate-regressed' })
      }
    } else if (atLeastRate(post.timedOutSteps, post.totalSteps, policy.maxTimeoutRatePpm)) {
      return Object.freeze({ regressed: true, reason: 'timeout-rate-regressed' })
    }
  }

  if (post.injectedTasks >= policy.minSample) {
    if (basis.injectedTasks > 0) {
      const left = BigInt(post.correctedTasks) * BigInt(basis.injectedTasks) * 1_000_000n
      const right =
        BigInt(basis.correctedTasks) * BigInt(post.injectedTasks) * 1_000_000n +
        BigInt(policy.regressionMarginPpm) * BigInt(basis.injectedTasks) * BigInt(post.injectedTasks)
      if (left > right) {
        return Object.freeze({ regressed: true, reason: 'correction-rate-regressed' })
      }
    } else if (atLeastRate(post.correctedTasks, post.injectedTasks, policy.highCorrectionRatePpm)) {
      return Object.freeze({ regressed: true, reason: 'correction-rate-regressed' })
    }
  }

  if (post.injectedTasks >= policy.minSample && basis.injectedTasks >= policy.minSample) {
    const left =
      BigInt(post.usedTasks) * BigInt(basis.injectedTasks) * 1_000_000n +
      BigInt(policy.usageDropMarginPpm) * BigInt(basis.injectedTasks) * BigInt(post.injectedTasks)
    const right = BigInt(basis.usedTasks) * BigInt(post.injectedTasks) * 1_000_000n
    if (left < right) {
      return Object.freeze({ regressed: true, reason: 'usage-rate-regressed' })
    }
  }

  return Object.freeze({ regressed: false })
}

export function ensureParamTuningSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS assoc_replay_episodes (
      task_id TEXT PRIMARY KEY CHECK (length(task_id) BETWEEN 1 AND 512),
      owner_scope_key TEXT NOT NULL CHECK (length(owner_scope_key) = 64 AND owner_scope_key NOT GLOB '*[^0-9a-f]*'),
      in_holdout INTEGER NOT NULL CHECK (in_holdout IN (0, 1)),
      cues_json TEXT NOT NULL CHECK (json_valid(cues_json)),
      used_node_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(used_node_ids_json)),
      corrected_node_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(corrected_node_ids_json)),
      profile_version INTEGER NOT NULL DEFAULT 0 CHECK (profile_version >= 0),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assoc_replay_episodes_scope_time
      ON assoc_replay_episodes(owner_scope_key, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS assoc_param_profile_versions (
      scope_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 0),
      parent_version INTEGER CHECK (parent_version IS NULL OR (parent_version >= 0 AND parent_version < version)),
      params_json TEXT NOT NULL CHECK (json_valid(params_json)),
      params_digest TEXT NOT NULL,
      basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
      change_json TEXT NOT NULL CHECK (json_valid(change_json)),
      origin TEXT NOT NULL CHECK (origin IN ('baseline', 'auto', 'replay', 'manual')),
      digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY (scope_key, version)
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS assoc_param_profile_versions_immutable
      BEFORE UPDATE ON assoc_param_profile_versions
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_versions are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS assoc_param_profile_versions_no_delete
      BEFORE DELETE ON assoc_param_profile_versions
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_versions are durable'); END;

    CREATE TABLE IF NOT EXISTS assoc_param_profile_heads (
      scope_key TEXT PRIMARY KEY,
      active_version INTEGER NOT NULL CHECK (active_version >= 0),
      latest_version INTEGER NOT NULL CHECK (latest_version >= active_version),
      active_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('idle', 'observing')),
      observing_version INTEGER,
      observe_from INTEGER,
      observe_until INTEGER,
      changed_at INTEGER NOT NULL CHECK (changed_at >= 0),
      CHECK (
        (state = 'idle' AND observing_version IS NULL AND observe_from IS NULL AND observe_until IS NULL)
        OR (state = 'observing' AND observing_version = active_version AND observe_from IS NOT NULL AND observe_until IS NOT NULL AND observe_until > observe_from)
      )
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS assoc_param_profile_heads_no_delete
      BEFORE DELETE ON assoc_param_profile_heads
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_heads are durable'); END;

    CREATE TABLE IF NOT EXISTS assoc_param_profile_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('adopted', 'rolled-back', 'settled', 'request-rejected')),
      from_version INTEGER,
      to_version INTEGER,
      from_digest TEXT,
      to_digest TEXT,
      reason TEXT NOT NULL,
      detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
      idempotency_key TEXT NOT NULL UNIQUE,
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assoc_param_profile_events_scope
      ON assoc_param_profile_events(scope_key, seq);

    CREATE TRIGGER IF NOT EXISTS assoc_param_profile_events_immutable
      BEFORE UPDATE ON assoc_param_profile_events
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_events are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS assoc_param_profile_events_no_delete
      BEFORE DELETE ON assoc_param_profile_events
      BEGIN SELECT RAISE(ABORT, 'assoc_param_profile_events are durable'); END;

    CREATE TABLE IF NOT EXISTS assoc_param_relax_proposals (
      proposal_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      parent_version INTEGER NOT NULL,
      parent_digest TEXT NOT NULL,
      candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json)),
      params_digest TEXT NOT NULL,
      change_json TEXT NOT NULL CHECK (json_valid(change_json)),
      holdout_seal TEXT NOT NULL,
      window_from INTEGER NOT NULL,
      window_to INTEGER NOT NULL,
      basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'adopted', 'rejected')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assoc_param_relax_proposals_scope
      ON assoc_param_relax_proposals(scope_key, created_at);

    CREATE TRIGGER IF NOT EXISTS assoc_param_relax_proposals_immutable
      BEFORE UPDATE ON assoc_param_relax_proposals
      BEGIN SELECT RAISE(ABORT, 'assoc_param_relax_proposals are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS assoc_param_relax_proposals_no_delete
      BEFORE DELETE ON assoc_param_relax_proposals
      BEGIN SELECT RAISE(ABORT, 'assoc_param_relax_proposals are durable'); END;

    CREATE TABLE IF NOT EXISTS assoc_param_relax_decisions (
      decision_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE,
      scope_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('adopted', 'rejected')),
      reason TEXT NOT NULL,
      replay_json TEXT NOT NULL CHECK (json_valid(replay_json)),
      decided_at INTEGER NOT NULL CHECK (decided_at >= 0),
      FOREIGN KEY (proposal_id) REFERENCES assoc_param_relax_proposals(proposal_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS assoc_param_relax_decisions_immutable
      BEFORE UPDATE ON assoc_param_relax_decisions
      BEGIN SELECT RAISE(ABORT, 'assoc_param_relax_decisions are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS assoc_param_relax_decisions_no_delete
      BEFORE DELETE ON assoc_param_relax_decisions
      BEGIN SELECT RAISE(ABORT, 'assoc_param_relax_decisions are durable'); END;

    CREATE TABLE IF NOT EXISTS assoc_param_rolled_back_digests (
      scope_key TEXT NOT NULL,
      params_digest TEXT NOT NULL,
      rolled_back_at INTEGER NOT NULL CHECK (rolled_back_at >= 0),
      from_version INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (scope_key, params_digest)
    ) STRICT;
  `)
}

interface VersionRow {
  readonly scope_key: string
  readonly version: number
  readonly parent_version: number | null
  readonly params_json: string
  readonly params_digest: string
  readonly basis_json: string
  readonly change_json: string
  readonly origin: AssocParamOrigin
  readonly digest: string
  readonly created_at: number
}

interface HeadRow {
  readonly scope_key: string
  readonly active_version: number
  readonly latest_version: number
  readonly active_digest: string
  readonly state: 'idle' | 'observing'
  readonly observing_version: number | null
  readonly observe_from: number | null
  readonly observe_until: number | null
  readonly changed_at: number
}

interface EventRow {
  readonly seq: number
  readonly kind: AssocParamProfileEvent['kind']
  readonly from_version: number | null
  readonly to_version: number | null
  readonly from_digest: string | null
  readonly to_digest: string | null
  readonly reason: string
  readonly detail_json: string
  readonly occurred_at: number
}

interface ProposalRow {
  readonly proposal_id: string
  readonly scope_key: string
  readonly parent_version: number
  readonly parent_digest: string
  readonly candidate_json: string
  readonly params_digest: string
  readonly change_json: string
  readonly holdout_seal: string
  readonly window_from: number
  readonly window_to: number
  readonly basis_json: string
  readonly status: 'pending' | 'adopted' | 'rejected'
  readonly created_at: number
}

interface DecisionRow {
  readonly decision_id: string
  readonly proposal_id: string
  readonly scope_key: string
  readonly status: 'adopted' | 'rejected'
  readonly reason: string
  readonly replay_json: string
  readonly decided_at: number
}

interface StoredProposalBasis {
  readonly stats: AssocWindowStats
  readonly ordinal: number
  readonly reason: string
  readonly holdoutCount: number
  readonly createdAt: number
}

function versionDigest(input: {
  readonly protocol: typeof ASSOC_PARAM_PROFILE_PROTOCOL
  readonly scopeKey: string
  readonly version: number
  readonly parentVersion: number | null
  readonly parentDigest: string | null
  readonly parameters: AssocParamProfileValues
  readonly paramsDigest: string
  readonly basis: Readonly<{ readonly stats: AssocWindowStats }>
  readonly change: AssocParamChange | null
  readonly origin: AssocParamOrigin
}): string {
  return growthObjectDigest(input)
}

function computeP99(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.99 * sorted.length) - 1))
  return sorted[idx]!
}

function emptySourceExposures(): Record<NodeKind, AssocSourceExposureStats> {
  const out: Record<string, AssocSourceExposureStats> = {}
  for (const kind of NODE_KINDS) {
    out[kind] = Object.freeze({ total: 0, unusedOrCorrected: 0 })
  }
  return out as Record<NodeKind, AssocSourceExposureStats>
}

export type AssocParamBaseHotPathConfig = Pick<
  NormalizedAssociationConfig,
  | 'decayHalfLifeMs'
  | 'maxHops'
  | 'maxItems'
  | 'minItems'
  | 'hysteresisDelta'
  | 'sourceWeights'
  | 'hopTopN'
  | 'maxFanoutPerNode'
  | 'hotPathBudgetMs'
>

const DEFAULT_BASE_CONFIG: AssocParamBaseHotPathConfig = Object.freeze({
  decayHalfLifeMs: 14 * 86_400_000,
  maxHops: 2,
  maxItems: 8,
  minItems: 5,
  hysteresisDelta: 0.15,
  sourceWeights: DEFAULT_SOURCE_WEIGHTS,
  hopTopN: 32,
  maxFanoutPerNode: 128,
  hotPathBudgetMs: 4.5,
})

export class AssociationParamTuningLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #hotPathClock: HotPathClock | undefined
  readonly #baseConfig: AssocParamBaseHotPathConfig
  readonly #baselineParams: AssocParamProfileValues
  readonly #policy: AssocParamTuningPolicy

  constructor(
    database: DatabaseSync,
    options?: {
      readonly baseConfig?: AssocParamBaseHotPathConfig
      readonly policy?: Partial<AssocParamTuningPolicy>
      readonly now?: () => number
      readonly hotPathClock?: HotPathClock
    },
  ) {
    this.#database = database
    this.#now = options?.now ?? (() => Date.now())
    this.#hotPathClock = options?.hotPathClock
    this.#baseConfig = options?.baseConfig ?? DEFAULT_BASE_CONFIG
    this.#policy = Object.freeze({
      ...DEFAULT_ASSOC_PARAM_TUNING_POLICY,
      minItems: this.#baseConfig.minItems,
      hotPathBudgetMs: this.#baseConfig.hotPathBudgetMs,
      ...options?.policy,
    })
    this.#baselineParams = fromAssociationConfig(this.#baseConfig)
  }

  get policy(): AssocParamTuningPolicy {
    return this.#policy
  }

  get baselineParameters(): AssocParamProfileValues {
    return this.#baselineParams
  }

  #transaction<T>(fn: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.#database.exec('COMMIT')
      return value
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #baseline(scopeKey: string): AssocParamCurrent {
    const paramsDigest = growthObjectDigest(this.#baselineParams)
    const digest = versionDigest({
      protocol: ASSOC_PARAM_PROFILE_PROTOCOL,
      scopeKey,
      version: 0,
      parentVersion: null,
      parentDigest: null,
      parameters: this.#baselineParams,
      paramsDigest,
      basis: { stats: this.#emptyStats(0, 0) },
      change: null,
      origin: 'baseline',
    })
    return deepFreeze({
      scopeKey,
      version: 0,
      origin: 'baseline',
      digest,
      paramsDigest,
      parameters: this.#baselineParams,
      source: 'active',
    })
  }

  #emptyStats(fromAt: number, toAt: number): AssocWindowStats {
    return deepFreeze({
      fromAt,
      toAt,
      totalSteps: 0,
      timedOutSteps: 0,
      p99LatencyUs: 0,
      injectedTasks: 0,
      decidedTasks: 0,
      usedTasks: 0,
      correctedTasks: 0,
      sourceExposures: emptySourceExposures(),
    })
  }

  #head(scopeKey: string): HeadRow | undefined {
    return this.#database
      .prepare('SELECT * FROM assoc_param_profile_heads WHERE scope_key = ?')
      .get(scopeKey) as unknown as HeadRow | undefined
  }

  #row(scopeKey: string, version: number): VersionRow | undefined {
    return this.#database
      .prepare('SELECT * FROM assoc_param_profile_versions WHERE scope_key = ? AND version = ?')
      .get(scopeKey, version) as unknown as VersionRow | undefined
  }

  #verified(
    scopeKey: string,
    version: number,
    visited = new Set<number>(),
  ): AssocParamProfileVersion | undefined {
    if (!Number.isSafeInteger(version) || version < 0 || visited.has(version)) {
      return undefined
    }
    visited.add(version)
    if (version === 0) {
      const base = this.#baseline(scopeKey)
      return deepFreeze({
        protocol: ASSOC_PARAM_PROFILE_PROTOCOL,
        scopeKey,
        version: 0,
        parentVersion: null,
        parentDigest: null,
        parameters: base.parameters,
        paramsDigest: base.paramsDigest,
        basis: { stats: this.#emptyStats(0, 0) },
        change: null,
        origin: 'baseline',
        digest: base.digest,
        createdAt: 0,
      })
    }
    const row = this.#row(scopeKey, version)
    if (row === undefined || row.version !== version) return undefined
    try {
      const base = this.#baseline(scopeKey)
      const parentVersion = row.parent_version ?? 0
      if (!Number.isSafeInteger(parentVersion) || parentVersion < 0 || parentVersion >= row.version) {
        return undefined
      }
      const parentDigest =
        parentVersion === 0
          ? base.digest
          : this.#verified(scopeKey, parentVersion, visited)?.digest
      if (parentDigest === undefined) return undefined
      const parameters = normalizeAssocParamProfile(JSON.parse(row.params_json))
      if (!withinAssocParamBounds(parameters, { minItems: this.#policy.minItems })) return undefined
      const paramsDigest = growthObjectDigest(parameters)
      if (paramsDigest !== row.params_digest) return undefined
      const basis = JSON.parse(row.basis_json) as Readonly<{ readonly stats: AssocWindowStats }>
      const change = JSON.parse(row.change_json) as AssocParamChange | null
      const expected = versionDigest({
        protocol: ASSOC_PARAM_PROFILE_PROTOCOL,
        scopeKey,
        version: row.version,
        parentVersion,
        parentDigest,
        parameters,
        paramsDigest,
        basis,
        change,
        origin: row.origin,
      })
      if (expected !== row.digest) return undefined
      return deepFreeze({
        protocol: ASSOC_PARAM_PROFILE_PROTOCOL,
        scopeKey,
        version: row.version,
        parentVersion,
        parentDigest,
        parameters,
        paramsDigest,
        basis,
        change,
        origin: row.origin,
        digest: row.digest,
        createdAt: row.created_at,
      })
    } catch {
      return undefined
    }
  }

  current(scopeKeyInput: string): AssocParamCurrent {
    const scopeKey = validateScopeKey(scopeKeyInput)
    return this.#current(scopeKey)
  }

  #current(scopeKey: string): AssocParamCurrent {
    const active = this.#head(scopeKey)?.active_version ?? 0
    let version = active
    let fallback = false
    const seen = new Set<number>()
    while (version > 0 && !seen.has(version)) {
      seen.add(version)
      const verified = this.#verified(scopeKey, version)
      if (verified !== undefined) {
        return deepFreeze({
          scopeKey,
          version: verified.version,
          origin: verified.origin,
          digest: verified.digest,
          paramsDigest: verified.paramsDigest,
          parameters: verified.parameters,
          source: fallback ? 'parent-fallback' : 'active',
        })
      }
      fallback = true
      const parent = (
        this.#database
          .prepare(
            'SELECT parent_version FROM assoc_param_profile_versions WHERE scope_key = ? AND version = ?',
          )
          .get(scopeKey, version) as { parent_version: unknown } | undefined
      )?.parent_version
      version =
        Number.isSafeInteger(parent) && (parent as number) >= 0 && (parent as number) < version
          ? (parent as number)
          : 0
    }
    const base = this.#baseline(scopeKey)
    return deepFreeze({
      ...base,
      source: active === 0 ? 'active' : 'default',
    })
  }

  status(scopeKeyInput: string, eventLimit = 50): AssocParamTuningStatus {
    const scopeKey = validateScopeKey(scopeKeyInput)
    const head = this.#head(scopeKey)
    const versionNums = (
      this.#database
        .prepare(
          'SELECT version FROM assoc_param_profile_versions WHERE scope_key = ? AND version >= 1 ORDER BY version ASC',
        )
        .all(scopeKey) as Array<{ version: number }>
    ).map((r) => r.version)
    const versions = versionNums
      .map((v) => this.#verified(scopeKey, v))
      .filter((v): v is AssocParamProfileVersion => v !== undefined)
    const events = (
      this.#database
        .prepare(
          `SELECT seq, kind, from_version, to_version, from_digest, to_digest, reason, detail_json, occurred_at
           FROM assoc_param_profile_events WHERE scope_key = ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(scopeKey, eventLimit) as unknown as EventRow[]
    )
      .reverse()
      .map((row) => ({
        sequence: row.seq,
        kind: row.kind,
        fromVersion: row.from_version,
        toVersion: row.to_version,
        fromDigest: row.from_digest,
        toDigest: row.to_digest,
        reason: row.reason,
        detail: JSON.parse(row.detail_json) as Record<string, unknown>,
        occurredAt: row.occurred_at,
      }))
    const proposalRows = this.#database
      .prepare('SELECT * FROM assoc_param_relax_proposals WHERE scope_key = ? ORDER BY created_at ASC')
      .all(scopeKey) as unknown as ProposalRow[]
    const proposals = proposalRows
      .map((pRow) => {
        const verified = this.#verifiedProposal(pRow, scopeKey)
        if (verified === undefined) return undefined
        const dRow = this.#database
          .prepare('SELECT * FROM assoc_param_relax_decisions WHERE proposal_id = ?')
          .get(pRow.proposal_id) as unknown as DecisionRow | undefined
        let decision: AssocRelaxationDecision | null = null
        if (dRow !== undefined) {
          const adoptedEvent =
            dRow.status === 'adopted'
              ? (this.#database
                  .prepare(
                    'SELECT to_version FROM assoc_param_profile_events WHERE idempotency_key = ?',
                  )
                  .get(`relax-adopt:${pRow.proposal_id}`) as { to_version: number | null } | undefined)
              : undefined
          decision = {
            decisionId: dRow.decision_id,
            proposalId: dRow.proposal_id,
            decision: dRow.status,
            reason: dRow.reason,
            version: adoptedEvent?.to_version ?? null,
            replay: JSON.parse(dRow.replay_json) as AssocRelaxReplaySummary | null,
            decidedAt: dRow.decided_at,
          }
        }
        return { proposalId: pRow.proposal_id, proposal: verified, decision }
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined)

    const blockedParamsDigests = (
      this.#database
        .prepare(
          'SELECT params_digest FROM assoc_param_rolled_back_digests WHERE scope_key = ? ORDER BY rolled_back_at ASC',
        )
        .all(scopeKey) as Array<{ params_digest: string }>
    ).map((r) => r.params_digest)

    return deepFreeze({
      current: this.#current(scopeKey),
      state: head?.state ?? 'idle',
      ...(head?.observe_from == null ? {} : { observeFrom: head.observe_from }),
      ...(head?.observe_until == null ? {} : { observeUntil: head.observe_until }),
      versions,
      events,
      proposals,
      blockedParamsDigests,
    })
  }

  listScopeKeys(): readonly string[] {
    const rows = this.#database
      .prepare(
        `SELECT scope_key FROM assoc_param_profile_heads
         UNION SELECT DISTINCT owner_scope_key AS scope_key FROM assoc_step_metrics
         UNION SELECT DISTINCT owner_scope_key AS scope_key FROM assoc_holdout_assignments
         ORDER BY scope_key ASC`,
      )
      .all() as Array<{ scope_key: string }>
    return Object.freeze(rows.map((r) => r.scope_key))
  }

  stats(
    scopeKeyInput: string,
    fromAt: number,
    toAt: number,
    partition: 'training' | 'holdout' | 'all' = 'training',
  ): AssocWindowStats {
    const scopeKey = validateScopeKey(scopeKeyInput)
    const holdoutClause =
      partition === 'training' ? 'AND in_holdout = 0' : partition === 'holdout' ? 'AND in_holdout = 1' : ''

    const metricRows = this.#database
      .prepare(
        `SELECT task_id, in_holdout, latency_us, timed_out, injected_count
         FROM assoc_step_metrics
         WHERE owner_scope_key = ? AND occurred_at >= ? AND occurred_at < ? ${holdoutClause}`,
      )
      .all(scopeKey, fromAt, toAt) as Array<{
      task_id: string | null
      in_holdout: number
      latency_us: number
      timed_out: number
      injected_count: number
    }>

    const distinctMetricTasks = new Set<string>()
    const distinctInjectedTasks = new Set<string>()
    let nullTaskSteps = 0
    let nullTaskInjected = 0
    let timedOutSteps = 0
    const latencies: number[] = []
    for (const row of metricRows) {
      if (row.timed_out === 1) timedOutSteps += 1
      latencies.push(row.latency_us)
      if (row.task_id !== null) {
        distinctMetricTasks.add(row.task_id)
        if (row.injected_count > 0) distinctInjectedTasks.add(row.task_id)
      } else {
        nullTaskSteps += 1
        if (row.injected_count > 0) nullTaskInjected += 1
      }
    }

    if (partition === 'holdout' || partition === 'all') {
      const holdoutRows = this.#database
        .prepare(
          `SELECT task_id FROM assoc_holdout_assignments
           WHERE owner_scope_key = ? AND in_holdout = 1 AND assigned_at >= ? AND assigned_at < ?`,
        )
        .all(scopeKey, fromAt, toAt) as Array<{ task_id: string }>
      for (const row of holdoutRows) {
        distinctMetricTasks.add(row.task_id)
      }
    }

    const exposureCols = new Set(
      (
        this.#database.prepare('PRAGMA table_info(assoc_exposures)').all() as Array<{
          name: string
        }>
      ).map((col) => col.name),
    )
    const hasWasExposed = exposureCols.has('was_exposed')
    const hasStrongUsed = exposureCols.has('strong_used')
    const hasWeakUsed = exposureCols.has('weak_used')

    const exposureRows = this.#database
      .prepare(
        `SELECT e.task_id, e.node_id, e.source_plugin, e.assoc_read_count, e.weak_use_count,
                ${hasStrongUsed ? 'e.strong_used' : 'NULL AS strong_used'},
                ${hasWeakUsed ? 'e.weak_used' : 'NULL AS weak_used'},
                e.corrected,
                n.kind AS node_kind,
                COALESCE(
                  (SELECT h.in_holdout FROM assoc_holdout_assignments h WHERE h.task_id = e.task_id),
                  (SELECT MAX(m.in_holdout) FROM assoc_step_metrics m WHERE m.task_id = e.task_id AND m.owner_scope_key = e.owner_scope_key),
                  0
                ) AS in_holdout
         FROM assoc_exposures e
         LEFT JOIN assoc_nodes n ON n.id = e.node_id
         WHERE e.owner_scope_key = ? AND e.exposed_at >= ? AND e.exposed_at < ?${hasWasExposed ? ' AND e.was_exposed = 1' : ''}`,
      )
      .all(scopeKey, fromAt, toAt) as Array<{
      task_id: string
      node_id: string
      source_plugin: string
      assoc_read_count: number
      weak_use_count: number
      strong_used: number | null
      weak_used: number | null
      corrected: number
      node_kind: NodeKind | null
      in_holdout: number
    }>

    const taskAgg = new Map<string, { used: boolean; corrected: boolean }>()
    const sourceAgg: Record<NodeKind, { total: number; unusedOrCorrected: number }> = {
      memory: { total: 0, unusedOrCorrected: 0 },
      goal: { total: 0, unusedOrCorrected: 0 },
      'work-item': { total: 0, unusedOrCorrected: 0 },
      automation: { total: 0, unusedOrCorrected: 0 },
      episode: { total: 0, unusedOrCorrected: 0 },
      wiki: { total: 0, unusedOrCorrected: 0 },
      skill: { total: 0, unusedOrCorrected: 0 },
      event: { total: 0, unusedOrCorrected: 0 },
      dream: { total: 0, unusedOrCorrected: 0 },
      abstraction: { total: 0, unusedOrCorrected: 0 },
      web: { total: 0, unusedOrCorrected: 0 },
    }

    for (const row of exposureRows) {
      if (partition === 'training' && row.in_holdout !== 0) continue
      if (partition === 'holdout' && row.in_holdout !== 1) continue

      distinctMetricTasks.add(row.task_id)
      distinctInjectedTasks.add(row.task_id)

      const cur = taskAgg.get(row.task_id) ?? { used: false, corrected: false }
      const isStrong = hasStrongUsed ? row.strong_used === 1 : row.assoc_read_count > 0
      const isWeak = hasWeakUsed ? row.weak_used === 1 : row.weak_use_count > 0
      const isUsed = isStrong || isWeak
      const isCorrected = row.corrected === 1
      if (isUsed) cur.used = true
      if (isCorrected) cur.corrected = true
      taskAgg.set(row.task_id, cur)

      const kind = row.node_kind ?? SOURCE_PLUGIN_TO_KIND[row.source_plugin]
      if (kind !== undefined) {
        sourceAgg[kind].total += 1
        if (isCorrected || !isUsed) {
          sourceAgg[kind].unusedOrCorrected += 1
        }
      }
    }

    let usedTasks = 0
    let correctedTasks = 0
    for (const agg of taskAgg.values()) {
      if (agg.used) usedTasks += 1
      if (agg.corrected) correctedTasks += 1
    }

    const sourceExposures: Record<string, AssocSourceExposureStats> = {}
    for (const kind of NODE_KINDS) {
      sourceExposures[kind] = Object.freeze({ ...sourceAgg[kind] })
    }

    return deepFreeze({
      fromAt,
      toAt,
      totalSteps: metricRows.length,
      timedOutSteps,
      p99LatencyUs: computeP99(latencies),
      injectedTasks: distinctInjectedTasks.size + nullTaskInjected,
      decidedTasks: distinctMetricTasks.size + nullTaskSteps,
      usedTasks,
      correctedTasks,
      sourceExposures: sourceExposures as Record<NodeKind, AssocSourceExposureStats>,
    })
  }

  #holdout(
    scopeKey: string,
    fromAt: number,
    toAt: number,
  ): Readonly<{ readonly ids: readonly string[]; readonly seal: AssocParamHoldoutSeal }> {
    const rows = this.#database
      .prepare(
        `SELECT task_id FROM assoc_holdout_assignments
         WHERE owner_scope_key = ? AND in_holdout = 1 AND assigned_at >= ? AND assigned_at < ?
         UNION
         SELECT task_id FROM assoc_step_metrics
         WHERE owner_scope_key = ? AND in_holdout = 1 AND task_id IS NOT NULL AND occurred_at >= ? AND occurred_at < ?
         ORDER BY task_id ASC`,
      )
      .all(scopeKey, fromAt, toAt, scopeKey, fromAt, toAt) as Array<{ task_id: string }>
    const ids = rows.map((r) => r.task_id)
    const digest = growthObjectDigest({
      protocol: ASSOC_PARAM_HOLDOUT_PROTOCOL,
      scopeKey,
      fromAt,
      toAt,
      ids,
    })
    return deepFreeze({
      ids,
      seal: {
        protocol: ASSOC_PARAM_HOLDOUT_PROTOCOL,
        count: ids.length,
        digest,
      },
    })
  }

  #isParamsDigestBlocked(scopeKey: string, paramsDigest: string): boolean {
    const row = this.#database
      .prepare(
        'SELECT 1 AS ok FROM assoc_param_rolled_back_digests WHERE scope_key = ? AND params_digest = ?',
      )
      .get(scopeKey, paramsDigest) as { ok: number } | undefined
    return row !== undefined
  }

  #inRollbackCooldown(scopeKey: string, now: number): boolean {
    if (this.#policy.rollbackCooldownMs <= 0) return false
    const row = this.#database
      .prepare(
        'SELECT MAX(rolled_back_at) AS last_rolled_back_at FROM assoc_param_rolled_back_digests WHERE scope_key = ?',
      )
      .get(scopeKey) as { last_rolled_back_at: number | null } | undefined
    if (row?.last_rolled_back_at == null) return false
    return now - row.last_rolled_back_at < this.#policy.rollbackCooldownMs
  }

  #nextEventIdempotencyKey(scopeKey: string, kind: string, now: number): string {
    const row = this.#database
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM assoc_param_profile_events')
      .get() as { next_seq: number }
    return `evt:${growthObjectDigest([scopeKey, kind, now, row.next_seq])}`
  }

  #event(
    scopeKey: string,
    kind: AssocParamProfileEvent['kind'],
    fromVersion: number | null,
    toVersion: number | null,
    fromDigest: string | null,
    toDigest: string | null,
    reason: string,
    detail: Record<string, unknown>,
    idempotencyKey: string | null,
    now: number,
  ): void {
    const key = idempotencyKey ?? this.#nextEventIdempotencyKey(scopeKey, kind, now)
    this.#database
      .prepare(
        `INSERT INTO assoc_param_profile_events
         (scope_key, kind, from_version, to_version, from_digest, to_digest, reason, detail_json, idempotency_key, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        scopeKey,
        kind,
        fromVersion,
        toVersion,
        fromDigest,
        toDigest,
        reason,
        canonicalGrowthJson(detail),
        key,
        now,
      )
  }

  #adopt(
    scopeKey: string,
    head: HeadRow | undefined,
    current: AssocParamCurrent,
    proposal: Readonly<{
      readonly change: AssocParamChange
      readonly parameters: AssocParamProfileValues
    }>,
    stats: AssocWindowStats,
    origin: Exclude<AssocParamOrigin, 'baseline'>,
    reason: string,
    now: number,
    explicitIdempotencyKey?: string,
    extraEventDetail?: Readonly<Record<string, unknown>>,
  ): number {
    const parentVersion = current.version
    const idempotencyKey =
      explicitIdempotencyKey ??
      `adopt:${growthObjectDigest({
        scopeKey,
        parentVersion,
        parentDigest: current.digest,
        change: proposal.change,
        origin,
        changedAt: head?.changed_at ?? 0,
      })}`
    const existing = this.#database
      .prepare('SELECT version FROM assoc_param_profile_versions WHERE idempotency_key = ?')
      .get(idempotencyKey) as { version: number } | undefined
    if (existing !== undefined) return existing.version

    const version = (head?.latest_version ?? 0) + 1
    const paramsDigest = growthObjectDigest(proposal.parameters)
    const basis = { stats }
    const digest = versionDigest({
      protocol: ASSOC_PARAM_PROFILE_PROTOCOL,
      scopeKey,
      version,
      parentVersion,
      parentDigest: current.digest,
      parameters: proposal.parameters,
      paramsDigest,
      basis,
      change: proposal.change,
      origin,
    })

    this.#database
      .prepare(
        `INSERT INTO assoc_param_profile_versions
         (scope_key, version, parent_version, params_json, params_digest, basis_json, change_json, origin, digest, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scopeKey,
        version,
        parentVersion,
        canonicalGrowthJson(proposal.parameters),
        paramsDigest,
        canonicalGrowthJson(basis),
        canonicalGrowthJson(proposal.change),
        origin,
        digest,
        idempotencyKey,
        now,
      )

    const observeUntil = now + Math.max(1, this.#policy.observationMs)
    if (head === undefined) {
      this.#database
        .prepare(
          `INSERT INTO assoc_param_profile_heads
           (scope_key, active_version, latest_version, active_digest, state, observing_version, observe_from, observe_until, changed_at)
           VALUES (?, ?, ?, ?, 'observing', ?, ?, ?, ?)`,
        )
        .run(scopeKey, version, version, digest, version, now, observeUntil, now)
    } else {
      this.#database
        .prepare(
          `UPDATE assoc_param_profile_heads
           SET active_version = ?, latest_version = ?, active_digest = ?, state = 'observing',
               observing_version = ?, observe_from = ?, observe_until = ?, changed_at = ?
           WHERE scope_key = ?`,
        )
        .run(version, version, digest, version, now, observeUntil, now, scopeKey)
    }

    this.#event(
      scopeKey,
      'adopted',
      parentVersion,
      version,
      current.digest,
      digest,
      reason,
      {
        digest,
        paramsDigest,
        change: proposal.change,
        origin,
        stats,
        ...extraEventDetail,
      },
      idempotencyKey,
      now,
    )
    return version
  }

  #pendingProposal(scopeKey: string): ProposalRow | undefined {
    return this.#database
      .prepare(
        `SELECT p.* FROM assoc_param_relax_proposals p
         LEFT JOIN assoc_param_relax_decisions d ON d.proposal_id = p.proposal_id
         WHERE p.scope_key = ? AND d.proposal_id IS NULL
         ORDER BY p.created_at ASC, p.rowid ASC LIMIT 1`,
      )
      .get(scopeKey) as unknown as ProposalRow | undefined
  }

  #verifiedProposal(row: ProposalRow, scopeKey: string): AssocRelaxationProposal | undefined {
    try {
      const parentVersionInfo = this.#verified(scopeKey, row.parent_version)
      if (parentVersionInfo === undefined) return undefined
      const candidate = normalizeAssocParamProfile(JSON.parse(row.candidate_json))
      const change = JSON.parse(row.change_json) as AssocParamChange
      const basisMeta = JSON.parse(row.basis_json) as StoredProposalBasis
      const body: AssocRelaxationProposal = {
        protocol: ASSOC_PARAM_RELAX_PROTOCOL,
        scopeKey,
        ordinal: basisMeta.ordinal,
        parentVersion: row.parent_version,
        parentDigest: row.parent_digest,
        parent: parentVersionInfo.parameters,
        candidate,
        change,
        reason: basisMeta.reason,
        window: { fromAt: row.window_from, toAt: row.window_to },
        holdout: {
          protocol: ASSOC_PARAM_HOLDOUT_PROTOCOL,
          count: basisMeta.holdoutCount,
          digest: row.holdout_seal,
        },
        basis: { stats: basisMeta.stats },
        createdAt: basisMeta.createdAt,
      }
      if (
        growthObjectDigest(body) !== row.proposal_id ||
        growthObjectDigest(candidate) !== row.params_digest ||
        basisMeta.createdAt !== row.created_at
      ) {
        return undefined
      }
      const checkedChange = describeRelaxationChange(parentVersionInfo.parameters, candidate, {
        minItems: this.#policy.minItems,
      })
      if (
        !withinAssocParamBounds(parentVersionInfo.parameters, { minItems: this.#policy.minItems }) ||
        !withinAssocParamBounds(candidate, { minItems: this.#policy.minItems }) ||
        checkedChange === undefined ||
        canonicalGrowthJson(checkedChange) !== canonicalGrowthJson(change)
      ) {
        return undefined
      }
      return deepFreeze(body)
    } catch {
      return undefined
    }
  }

  requestChange(input: {
    readonly scopeKey: string
    readonly candidate: AssocParamProfileValues
    readonly reason: string
    readonly idempotencyKey?: string
    readonly nowMs?: number
  }): AssocParamRequestResult {
    const scopeKey = validateScopeKey(input.scopeKey)
    const requested = normalizeAssocParamProfile(input.candidate)
    const reason = input.reason.trim() || 'explicit-request'

    return this.#transaction(() => {
      const now = input.nowMs ?? this.#now()
      const head = this.#head(scopeKey)
      const current = this.#current(scopeKey)
      const direction = classifyProfileChange(current.parameters, requested)

      if (direction === 'identical') {
        this.#event(
          scopeKey,
          'request-rejected',
          current.version,
          current.version,
          current.digest,
          current.digest,
          'no-change',
          { current: current.parameters, requested },
          null,
          now,
        )
        return Object.freeze({ status: 'rejected' as const, reason: 'no-change' as const })
      }

      if (direction === 'relax') {
        if (!this.#policy.relaxationReplayEnabled) {
          this.#event(
            scopeKey,
            'request-rejected',
            current.version,
            current.version,
            current.digest,
            current.digest,
            'loosening-requires-holdout',
            { current: current.parameters, requested },
            null,
            now,
          )
          return Object.freeze({
            status: 'rejected' as const,
            reason: 'loosening-requires-holdout' as const,
          })
        }

        const change = describeRelaxationChange(current.parameters, requested, {
          minItems: this.#policy.minItems,
        })
        const candDigest = growthObjectDigest(requested)
        const rejectReason: AssocParamRequestRejection | undefined = !withinAssocParamBounds(
          requested,
          { minItems: this.#policy.minItems },
        )
          ? 'out-of-bounds'
          : change === undefined
            ? 'not-single-parameter'
            : head?.state === 'observing'
              ? 'observation-in-progress'
              : this.#pendingProposal(scopeKey) !== undefined
                ? 'proposal-pending'
                : this.#isParamsDigestBlocked(scopeKey, candDigest)
                  ? 'digest-previously-rolled-back'
                  : this.#inRollbackCooldown(scopeKey, now)
                    ? 'rollback-cooldown'
                    : undefined

        if (rejectReason !== undefined || change === undefined) {
          const code = rejectReason ?? 'not-single-parameter'
          this.#event(
            scopeKey,
            'request-rejected',
            current.version,
            current.version,
            current.digest,
            current.digest,
            code,
            { current: current.parameters, requested },
            null,
            now,
          )
          return Object.freeze({ status: 'rejected' as const, reason: code })
        }

        const window = {
          fromAt: Math.max(0, now - this.#policy.relaxReplayWindowMs),
          toAt: now + 1,
        }
        const holdout = this.#holdout(scopeKey, window.fromAt, window.toAt)
        const ordinal =
          (
            this.#database
              .prepare(
                'SELECT COUNT(*) AS count FROM assoc_param_relax_proposals WHERE scope_key = ?',
              )
              .get(scopeKey) as { count: number }
          ).count + 1
        const basisStats = this.stats(scopeKey, window.fromAt, window.toAt, 'training')
        const body: AssocRelaxationProposal = {
          protocol: ASSOC_PARAM_RELAX_PROTOCOL,
          scopeKey,
          ordinal,
          parentVersion: current.version,
          parentDigest: current.digest,
          parent: current.parameters,
          candidate: requested,
          change,
          reason,
          window,
          holdout: holdout.seal,
          basis: { stats: basisStats },
          createdAt: now,
        }
        const proposalId = growthObjectDigest(body)
        const storedBasis: StoredProposalBasis = {
          stats: basisStats,
          ordinal,
          reason,
          holdoutCount: holdout.seal.count,
          createdAt: now,
        }
        this.#database
          .prepare(
            `INSERT INTO assoc_param_relax_proposals
             (proposal_id, scope_key, parent_version, parent_digest, candidate_json, params_digest, change_json, holdout_seal, window_from, window_to, basis_json, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            proposalId,
            scopeKey,
            current.version,
            current.digest,
            canonicalGrowthJson(requested),
            candDigest,
            canonicalGrowthJson(change),
            holdout.seal.digest,
            window.fromAt,
            window.toAt,
            canonicalGrowthJson(storedBasis),
            now,
          )
        return deepFreeze({
          status: 'proposed' as const,
          proposalId,
          holdout: holdout.seal,
        })
      }

      if (input.idempotencyKey !== undefined) {
        const existing = this.#database
          .prepare('SELECT version, change_json FROM assoc_param_profile_versions WHERE idempotency_key = ?')
          .get(input.idempotencyKey) as { version: number; change_json: string } | undefined
        if (existing !== undefined) {
          return deepFreeze({
            status: 'adopted' as const,
            version: existing.version,
            change: JSON.parse(existing.change_json) as AssocParamChange,
          })
        }
      }

      const change = describeSingleTighteningStep(current.parameters, requested, {
        minItems: this.#policy.minItems,
      })
      const candDigest = growthObjectDigest(requested)
      const rejectReason: AssocParamRequestRejection | undefined = !withinAssocParamBounds(
        requested,
        { minItems: this.#policy.minItems },
      )
        ? 'out-of-bounds'
        : change === undefined
          ? 'not-single-step'
          : !this.#policy.autoTightenEnabled
            ? 'auto-adoption-disabled'
            : head?.state === 'observing'
              ? 'observation-in-progress'
              : this.#isParamsDigestBlocked(scopeKey, candDigest)
                ? 'digest-previously-rolled-back'
                : this.#inRollbackCooldown(scopeKey, now)
                  ? 'rollback-cooldown'
                  : undefined

      if (rejectReason !== undefined || change === undefined) {
        const code = rejectReason ?? 'not-single-step'
        this.#event(
          scopeKey,
          'request-rejected',
          current.version,
          current.version,
          current.digest,
          current.digest,
          code,
          { current: current.parameters, requested },
          null,
          now,
        )
        return Object.freeze({ status: 'rejected' as const, reason: code })
      }

      const fromAt = Math.max(0, head?.changed_at ?? 0, now - this.#policy.evaluationWindowMs)
      const stats = this.stats(scopeKey, fromAt, now + 1, 'training')
      const version = this.#adopt(
        scopeKey,
        head,
        current,
        { change, parameters: requested },
        stats,
        'manual',
        reason,
        now,
        input.idempotencyKey,
      )
      return deepFreeze({ status: 'adopted' as const, version, change })
    })
  }

  #resolveScopeFilter(
    scopeKey: string,
    index: AssociationMemoryIndex,
    filterTemplate?: Partial<HotPathFilter>,
  ): Omit<HotPathFilter, 'nowMs'> {
    const scopeRow = this.#database
      .prepare('SELECT workspace, agent_preset FROM assoc_owner_scopes WHERE owner_scope_key = ?')
      .get(scopeKey) as { workspace: string; agent_preset: string } | undefined
    let workspace = filterTemplate?.workspace ?? scopeRow?.workspace
    let agentPreset = filterTemplate?.agentPreset ?? scopeRow?.agent_preset
    if (workspace === undefined || agentPreset === undefined) {
      const ownerIdx = index.ownerKeys.get(scopeKey)
      if (ownerIdx !== undefined) {
        for (let slot = 0; slot < index.nodeCount; slot += 1) {
          if (index.nodeOwnerIdx[slot] !== ownerIdx) continue
          if (workspace === undefined) {
            const wsIdx = index.nodeWorkspaceIdx[slot]!
            for (const [k, v] of index.workspaces.entries()) {
              if (v === wsIdx) {
                workspace = k
                break
              }
            }
          }
          if (agentPreset === undefined) {
            const pIdx = index.nodePresetIdx[slot]!
            for (const [k, v] of index.presets.entries()) {
              if (v === pIdx) {
                agentPreset = k
                break
              }
            }
          }
          if (workspace !== undefined && agentPreset !== undefined) break
        }
      }
    }
    return {
      ownerScopeKey: scopeKey,
      workspace: workspace ?? '',
      agentPreset: agentPreset ?? '',
      allowLowTrust: filterTemplate?.allowLowTrust ?? true,
      allowSensitive: filterTemplate?.allowSensitive ?? false,
    }
  }

  #replayRelaxation(
    scopeKey: string,
    proposal: AssocRelaxationProposal,
    index: AssociationMemoryIndex | undefined,
    filterTemplate?: Partial<HotPathFilter>,
  ): AssocRelaxReplaySummary {
    const { fromAt, toAt } = proposal.window
    const holdoutStats = this.stats(scopeKey, fromAt, toAt, 'holdout')
    const trainingStats = this.stats(scopeKey, fromAt, toAt, 'training')
    const emptyTally: AssocRelaxReplayTally = { timeouts: 0, p99Ms: 0, usedHits: 0, noiseExposed: 0 }

    const fail = (
      failureReason: AssocRelaxReplayFailure,
      episodeCount: number,
      parentTally: AssocRelaxReplayTally,
      candidateTally: AssocRelaxReplayTally,
    ): AssocRelaxReplaySummary =>
      deepFreeze({
        protocol: ASSOC_PARAM_RELAX_PROTOCOL,
        episodeCount,
        holdoutDecided: holdoutStats.decidedTasks,
        trainingDecided: trainingStats.decidedTasks,
        parent: parentTally,
        candidate: candidateTally,
        verdict: 'fail',
        failureReason,
      })

    if (holdoutStats.decidedTasks < this.#policy.minHoldoutSamples) {
      return fail('insufficient-holdout', 0, emptyTally, emptyTally)
    }

    if (
      trainingStats.injectedTasks > 0 &&
      atLeastRate(
        trainingStats.correctedTasks,
        trainingStats.injectedTasks,
        this.#policy.highCorrectionRatePpm,
      )
    ) {
      return fail('holdout-regression', 0, emptyTally, emptyTally)
    }
    if (holdoutStats.injectedTasks > 0 && trainingStats.injectedTasks > 0) {
      const left = BigInt(trainingStats.correctedTasks) * BigInt(holdoutStats.injectedTasks) * 1_000_000n
      const right =
        BigInt(holdoutStats.correctedTasks) * BigInt(trainingStats.injectedTasks) * 1_000_000n +
        BigInt(this.#policy.regressionMarginPpm) *
          BigInt(holdoutStats.injectedTasks) *
          BigInt(trainingStats.injectedTasks)
      if (left > right) {
        return fail('holdout-regression', 0, emptyTally, emptyTally)
      }
    }
    if (holdoutStats.totalSteps > 0 && trainingStats.totalSteps > 0) {
      const effectiveTimeoutMarginPpm = Math.min(
        this.#policy.timeoutMarginPpm,
        this.#policy.maxTimeoutMarginPpm,
      )
      const left = BigInt(trainingStats.timedOutSteps) * BigInt(holdoutStats.totalSteps) * 1_000_000n
      const right =
        BigInt(holdoutStats.timedOutSteps) * BigInt(trainingStats.totalSteps) * 1_000_000n +
        BigInt(effectiveTimeoutMarginPpm) *
          BigInt(holdoutStats.totalSteps) *
          BigInt(trainingStats.totalSteps)
      if (left > right) {
        return fail('holdout-regression', 0, emptyTally, emptyTally)
      }
    }

    const episodes = this.#database
      .prepare(
        `SELECT task_id, cues_json, used_node_ids_json, corrected_node_ids_json, occurred_at
         FROM assoc_replay_episodes
         WHERE owner_scope_key = ? AND in_holdout = 0 AND occurred_at >= ? AND occurred_at < ?
         ORDER BY occurred_at ASC, task_id ASC`,
      )
      .all(scopeKey, fromAt, toAt) as Array<{
      task_id: string
      cues_json: string
      used_node_ids_json: string
      corrected_node_ids_json: string
      occurred_at: number
    }>

    if (index === undefined || episodes.length === 0) {
      return fail('insufficient-replay-episodes', episodes.length, emptyTally, emptyTally)
    }

    const baseFilter = this.#resolveScopeFilter(scopeKey, index, filterTemplate)
    const parentProfile = toHotPathProfile(proposal.parent, this.#baseConfig)
    const candidateProfile = toHotPathProfile(proposal.candidate, this.#baseConfig)
    const queryOpt = this.#hotPathClock === undefined ? undefined : { clock: this.#hotPathClock }

    let parentTimeouts = 0
    let candidateTimeouts = 0
    const parentLatencies: number[] = []
    const candidateLatencies: number[] = []
    let parentUsedHits = 0
    let candidateUsedHits = 0
    let parentNoise = 0
    let candidateNoise = 0

    for (const ep of episodes) {
      const cues = JSON.parse(ep.cues_json) as HotPathCue[]
      const usedSet = new Set(JSON.parse(ep.used_node_ids_json) as string[])
      const correctedSet = new Set(JSON.parse(ep.corrected_node_ids_json) as string[])
      const filter: HotPathFilter = { ...baseFilter, nowMs: ep.occurred_at }

      const pRes = runHotPathQuery(index, cues, filter, parentProfile, queryOpt)
      const cRes = runHotPathQuery(index, cues, filter, candidateProfile, queryOpt)

      if (pRes.timedOut) parentTimeouts += 1
      if (cRes.timedOut) candidateTimeouts += 1
      parentLatencies.push(pRes.elapsedMs)
      candidateLatencies.push(cRes.elapsedMs)

      for (const item of pRes.items) {
        if (usedSet.has(item.id)) parentUsedHits += 1
        else if (correctedSet.has(item.id)) parentNoise += 2
        else parentNoise += 1
      }
      for (const item of cRes.items) {
        if (usedSet.has(item.id)) candidateUsedHits += 1
        else if (correctedSet.has(item.id)) candidateNoise += 2
        else candidateNoise += 1
      }
    }

    const parentTally: AssocRelaxReplayTally = {
      timeouts: parentTimeouts,
      p99Ms: computeP99(parentLatencies),
      usedHits: parentUsedHits,
      noiseExposed: parentNoise,
    }
    const candidateTally: AssocRelaxReplayTally = {
      timeouts: candidateTimeouts,
      p99Ms: computeP99(candidateLatencies),
      usedHits: candidateUsedHits,
      noiseExposed: candidateNoise,
    }

    if (candidateTally.timeouts > parentTally.timeouts) {
      return fail('replay-timeouts', episodes.length, parentTally, candidateTally)
    }
    if (candidateTally.p99Ms > this.#policy.hotPathBudgetMs) {
      return fail('latency-budget-exceeded', episodes.length, parentTally, candidateTally)
    }
    if (candidateTally.usedHits < parentTally.usedHits) {
      return fail('recall-regression', episodes.length, parentTally, candidateTally)
    }
    const usedGain = candidateTally.usedHits - parentTally.usedHits
    const noiseGain = candidateTally.noiseExposed - parentTally.noiseExposed
    if (usedGain <= noiseGain) {
      return fail('no-net-benefit', episodes.length, parentTally, candidateTally)
    }

    return deepFreeze({
      protocol: ASSOC_PARAM_RELAX_PROTOCOL,
      episodeCount: episodes.length,
      holdoutDecided: holdoutStats.decidedTasks,
      trainingDecided: trainingStats.decidedTasks,
      parent: parentTally,
      candidate: candidateTally,
      verdict: 'pass',
    })
  }

  #decideRelaxation(
    scopeKey: string,
    head: HeadRow | undefined,
    row: ProposalRow,
    now: number,
    index: AssociationMemoryIndex | undefined,
    filterTemplate?: Partial<HotPathFilter>,
  ): AssocParamTickAction {
    const proposalId = row.proposal_id
    const current = this.#current(scopeKey)
    const reject = (
      reason: AssocRelaxRejection,
      replay: AssocRelaxReplaySummary | null,
    ): AssocParamTickAction => {
      const decisionId = growthObjectDigest({ proposalId, status: 'rejected', reason, now })
      this.#database
        .prepare(
          `INSERT INTO assoc_param_relax_decisions
           (decision_id, proposal_id, scope_key, status, reason, replay_json, decided_at)
           VALUES (?, ?, ?, 'rejected', ?, ?, ?)`,
        )
        .run(decisionId, proposalId, scopeKey, reason, canonicalGrowthJson(replay), now)
      this.#event(
        scopeKey,
        'request-rejected',
        current.version,
        current.version,
        current.digest,
        current.digest,
        reason,
        { proposalId, replay },
        `relax:${proposalId}`,
        now,
      )
      return deepFreeze({
        action: 'relax-rejected' as const,
        reason,
        proposalId,
        ...(replay === null ? {} : { replay }),
      })
    }

    const proposal = this.#verifiedProposal(row, scopeKey)
    if (proposal === undefined) {
      return reject('proposal-unverifiable', null)
    }
    if (
      current.version !== proposal.parentVersion ||
      current.digest !== proposal.parentDigest ||
      canonicalGrowthJson(current.parameters) !== canonicalGrowthJson(proposal.parent)
    ) {
      return reject('stale-parent', null)
    }
    const candDigest = growthObjectDigest(proposal.candidate)
    if (this.#isParamsDigestBlocked(scopeKey, candDigest)) {
      return reject('digest-previously-rolled-back', null)
    }
    if (this.#inRollbackCooldown(scopeKey, now)) {
      return reject('rollback-cooldown', null)
    }
    const holdout = this.#holdout(scopeKey, proposal.window.fromAt, proposal.window.toAt)
    if (holdout.seal.digest !== proposal.holdout.digest) {
      return reject('holdout-drifted', null)
    }

    const replay = this.#replayRelaxation(scopeKey, proposal, index, filterTemplate)
    if (replay.verdict === 'fail') {
      return reject('holdout-failed', replay)
    }

    const version = this.#adopt(
      scopeKey,
      head,
      current,
      { change: proposal.change, parameters: proposal.candidate },
      proposal.basis.stats,
      'replay',
      proposal.reason || 'holdout-replay-accepted',
      now,
      `relax-adopt:${proposalId}`,
      { proposalId, replay },
    )
    const decisionId = growthObjectDigest({
      proposalId,
      status: 'adopted',
      reason: 'holdout-replay-accepted',
      version,
      now,
    })
    this.#database
      .prepare(
        `INSERT INTO assoc_param_relax_decisions
         (decision_id, proposal_id, scope_key, status, reason, replay_json, decided_at)
         VALUES (?, ?, ?, 'adopted', 'holdout-replay-accepted', ?, ?)`,
      )
      .run(decisionId, proposalId, scopeKey, canonicalGrowthJson(replay), now)

    return deepFreeze({
      action: 'relax-adopted' as const,
      version,
      change: proposal.change,
      proposalId,
      replay,
    })
  }

  tick(input: {
    readonly scopeKey: string
    readonly nowMs?: number
    readonly index?: AssociationMemoryIndex
    readonly filterTemplate?: Partial<HotPathFilter>
  }): AssocParamTickAction {
    const scopeKey = validateScopeKey(input.scopeKey)
    return this.#transaction(() => {
      const now = input.nowMs ?? this.#now()
      const head = this.#head(scopeKey)

      if (head?.state === 'observing') {
        const observed = head.observing_version!
        const version = this.#verified(scopeKey, observed)
        const post = this.stats(scopeKey, head.observe_from!, now + 1, 'training')
        const regression =
          version === undefined
            ? { regressed: true, reason: 'version-unverifiable' }
            : hasAssocObservedRegression(version.basis.stats, post, this.#policy)

        if (version === undefined || regression.regressed) {
          const rowInfo = this.#database
            .prepare(
              'SELECT parent_version, params_digest, digest FROM assoc_param_profile_versions WHERE scope_key = ? AND version = ?',
            )
            .get(scopeKey, observed) as
            | { parent_version: number | null; params_digest: string; digest: string }
            | undefined
          const rawParent = rowInfo?.parent_version
          let candidate =
            rawParent != null &&
            Number.isSafeInteger(rawParent) &&
            rawParent >= 0 &&
            rawParent < observed
              ? rawParent
              : 0
          let parentInfo: AssocParamProfileVersion | undefined
          const visited = new Set<number>()
          while (candidate > 0 && !visited.has(candidate)) {
            visited.add(candidate)
            parentInfo = this.#verified(scopeKey, candidate)
            if (parentInfo !== undefined) break
            const nextParent = (
              this.#database
                .prepare(
                  'SELECT parent_version FROM assoc_param_profile_versions WHERE scope_key = ? AND version = ?',
                )
                .get(scopeKey, candidate) as { parent_version: unknown } | undefined
            )?.parent_version
            candidate =
              Number.isSafeInteger(nextParent) &&
              (nextParent as number) >= 0 &&
              (nextParent as number) < candidate
                ? (nextParent as number)
                : 0
          }
          parentInfo ??= this.#verified(scopeKey, 0)!
          const parentVersion = parentInfo.version
          const parentDigest = parentInfo.digest

          this.#database
            .prepare(
              `UPDATE assoc_param_profile_heads
               SET active_version = ?, active_digest = ?, state = 'idle', observing_version = NULL,
                   observe_from = NULL, observe_until = NULL, changed_at = ?
               WHERE scope_key = ?`,
            )
            .run(parentVersion, parentDigest, now, scopeKey)

          const reason = regression.reason ?? 'observed-regression'
          const rolledBackParamsDigest = version?.paramsDigest ?? rowInfo?.params_digest
          if (rolledBackParamsDigest !== undefined) {
            this.#database
              .prepare(
                `INSERT INTO assoc_param_rolled_back_digests
                 (scope_key, params_digest, rolled_back_at, from_version, reason)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(scope_key, params_digest) DO UPDATE SET
                   rolled_back_at = excluded.rolled_back_at,
                   from_version = excluded.from_version,
                   reason = excluded.reason`,
              )
              .run(scopeKey, rolledBackParamsDigest, now, observed, reason)
          }

          this.#event(
            scopeKey,
            'rolled-back',
            observed,
            parentVersion,
            version?.digest ?? rowInfo?.digest ?? null,
            parentDigest,
            reason,
            {
              basis: version?.basis.stats ?? null,
              post,
              rolledBackParamsDigest: rolledBackParamsDigest ?? null,
            },
            `rollback:${growthObjectDigest([scopeKey, observed, parentVersion, now])}`,
            now,
          )
          return Object.freeze({
            action: 'rolled-back' as const,
            fromVersion: observed,
            toVersion: parentVersion,
            reason,
          })
        }

        if (now >= head.observe_until!) {
          this.#database
            .prepare(
              `UPDATE assoc_param_profile_heads
               SET state = 'idle', observing_version = NULL,
                   observe_from = NULL, observe_until = NULL, changed_at = ?
               WHERE scope_key = ?`,
            )
            .run(now, scopeKey)
          this.#event(
            scopeKey,
            'settled',
            observed,
            observed,
            version.digest,
            version.digest,
            'observation-complete',
            { post },
            `settle:${growthObjectDigest([scopeKey, observed, head.observe_from])}`,
            now,
          )
          return Object.freeze({ action: 'settled' as const, version: observed })
        }

        return Object.freeze({ action: 'observing' as const, version: observed })
      }

      if (this.#policy.relaxationReplayEnabled) {
        const pending = this.#pendingProposal(scopeKey)
        if (pending !== undefined) {
          return this.#decideRelaxation(
            scopeKey,
            head,
            pending,
            now,
            input.index,
            input.filterTemplate,
          )
        }
      }

      if (!this.#policy.autoTightenEnabled) {
        return Object.freeze({ action: 'no-op' as const, reason: 'disabled' as const })
      }
      if (this.#inRollbackCooldown(scopeKey, now)) {
        return Object.freeze({ action: 'no-op' as const, reason: 'rollback-cooldown' as const })
      }

      const current = this.#current(scopeKey)
      const fromAt = Math.max(0, head?.changed_at ?? 0, now - this.#policy.evaluationWindowMs)
      const stats = this.stats(scopeKey, fromAt, now + 1, 'training')
      const proposal = proposeAssocParamTightening(
        current.parameters,
        stats,
        this.#policy,
        (paramsDigest) => this.#isParamsDigestBlocked(scopeKey, paramsDigest),
      )

      if (proposal.kind === 'no-op') {
        return Object.freeze({ action: 'no-op' as const, reason: proposal.reason })
      }

      const version = this.#adopt(
        scopeKey,
        head,
        current,
        { change: proposal.change, parameters: proposal.parameters },
        stats,
        'auto',
        proposal.triggerReason,
        now,
      )
      return deepFreeze({
        action: 'adopted' as const,
        version,
        change: proposal.change,
        triggerReason: proposal.triggerReason,
      })
    })
  }
}
