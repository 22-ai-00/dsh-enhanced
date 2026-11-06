import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalEvaluationScope, EvaluationStoreError } from './store.js'
import type { EvaluationScope, NotificationOutcome } from './types.js'

/**
 * WP22 slice 2: bounded, tighten-only attention tuning with exact-version
 * cohort rollback. A cohort is one notification `(lane, sourceId)` inside one
 * Evaluation scope. Versions are immutable and bound to their exact parent.
 *
 * WP22 slice 3 (explicit opt-in): a loosening request is sealed against a
 * hash-partitioned holdout the proposer never reads, replayed independently
 * on a later tick, and adopted only inside an owner one-time grant; outside
 * it a structured owner question is recorded instead. Without the opt-in,
 * loosening is rejected exactly as in slice 2.
 */
export const ATTENTION_TUNING_PROTOCOL = 'assistant-evaluation/attention-tuning/v1' as const

export interface AttentionCohort { readonly lane: string; readonly sourceId: string }

/** Overlay deltas on a consumer's own profile. Every field only ever makes notifications rarer. */
export interface AttentionTuningParameters {
  /** Added to the profile's interruption cost (lowers utility). */
  readonly interruptionCostDelta: number
  /** Added to the profile's minimum utility threshold. */
  readonly minimumUtilityDelta: number
  /** Minutes added on both sides of an existing quiet window. */
  readonly quietExtensionMinutes: number
  /** Disables the noisy rule for this cohort entirely. */
  readonly muted: boolean
}

export type AttentionTuningNumericParameter = 'interruptionCostDelta' | 'minimumUtilityDelta' | 'quietExtensionMinutes'
export type AttentionTuningParameter = AttentionTuningNumericParameter | 'muted'

/** Fixed code constants; neither configuration nor a request can widen them. */
export const attentionTuningBounds: Readonly<Record<AttentionTuningNumericParameter, Readonly<{ min: number; max: number; step: number }>>> = Object.freeze({
  interruptionCostDelta: Object.freeze({ min: 0, max: 100, step: 10 }),
  minimumUtilityDelta: Object.freeze({ min: 0, max: 100, step: 10 }),
  quietExtensionMinutes: Object.freeze({ min: 0, max: 120, step: 30 }),
})

/** Fixed single-step order: cheapest reversible lever first, mute last. */
export const attentionTuningOrder: readonly AttentionTuningParameter[] = Object.freeze(['interruptionCostDelta', 'minimumUtilityDelta', 'quietExtensionMinutes', 'muted'])

export const defaultAttentionTuningParameters: AttentionTuningParameters = Object.freeze({
  interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false,
})

export interface AttentionCohortStats {
  readonly fromNotifiedAt: number
  readonly toNotifiedAt: number
  readonly total: number
  readonly accepted: number
  readonly reacted: number
  readonly rejected: number
  readonly expiredUnhandled: number
  /** accepted + reacted + rejected + expired-unhandled; pending/delivered/failed are undecided. */
  readonly decided: number
  /** rejected + expired-unhandled. */
  readonly negative: number
}

export interface AttentionTuningPolicy {
  readonly minSample: number
  readonly negativeRatePpm: number
  readonly muteRatePpm: number
  readonly regressionMarginPpm: number
}

export interface AttentionTuningChange {
  readonly parameter: AttentionTuningParameter
  readonly from: number | boolean
  readonly to: number | boolean
}

export type AttentionTuningProposal =
  | Readonly<{ kind: 'tighten'; change: AttentionTuningChange; parameters: AttentionTuningParameters }>
  | Readonly<{ kind: 'no-op'; reason: 'insufficient-sample' | 'below-threshold' | 'at-bound' }>

export type AttentionTuningRequestRejection =
  | 'loosening-requires-holdout'
  | 'out-of-bounds'
  | 'no-change'
  | 'not-single-step'
  | 'auto-adoption-disabled'
  | 'observation-in-progress'
  /** Slice 3 loosening (opt-in only): more than one parameter moved, or not on the grid. */
  | 'not-single-parameter'
  | 'proposal-pending'
  | 'owner-question-pending'

/** Why a sealed loosening proposal was not adopted by the independent replay. */
export type AttentionLooseningRejection =
  | 'proposal-unverifiable'
  | 'stale-parent'
  | 'holdout-drifted'
  | 'insufficient-basis'
  | 'era-unverifiable'
  | 'holdout-failed'

export interface AttentionTuningVersion {
  readonly protocol: typeof ATTENTION_TUNING_PROTOCOL
  readonly scopeKey: string
  readonly cohort: AttentionCohort
  readonly version: number
  readonly parentVersion: number
  readonly parentDigest: string | null
  readonly parameters: AttentionTuningParameters
  readonly basis: Readonly<{ stats: AttentionCohortStats; scopeWatermark: number }>
  readonly change: AttentionTuningChange
  readonly origin: 'auto' | 'request'
  readonly digest: string
  readonly createdAt: number
}

export interface AttentionTuningCurrent {
  readonly scopeKey: string
  readonly cohort: AttentionCohort
  /** 0 is the built-in default (no overlay). */
  readonly version: number
  readonly digest: string | null
  readonly parameters: AttentionTuningParameters
  /** `parent-fallback`/`default` mean the active version was unreadable or failed digest verification. */
  readonly source: 'active' | 'parent-fallback' | 'default'
}

export interface AttentionTuningEvent {
  readonly sequence: number
  readonly kind: 'adopted' | 'rolled-back' | 'settled' | 'request-rejected'
  readonly fromVersion: number
  readonly toVersion: number
  readonly reason: string
  readonly detail: Readonly<Record<string, unknown>>
  readonly occurredAt: number
}

export interface AttentionTuningStatus {
  readonly current: AttentionTuningCurrent
  readonly state: 'idle' | 'observing'
  readonly observeFrom?: number
  readonly observeUntil?: number
  readonly versions: readonly AttentionTuningVersion[]
  readonly events: readonly AttentionTuningEvent[]
}

export type AttentionTuningTickAction =
  | Readonly<{ action: 'adopted'; version: number; change: AttentionTuningChange }>
  | Readonly<{ action: 'rolled-back'; fromVersion: number; toVersion: number }>
  | Readonly<{ action: 'settled'; version: number }>
  | Readonly<{ action: 'observing'; version: number }>
  | Readonly<{ action: 'no-op'; reason: 'insufficient-sample' | 'below-threshold' | 'at-bound' }>
  | Readonly<{ action: 'loosening-adopted'; version: number; change: AttentionTuningChange; proposalId: string; grantId: string }>
  | Readonly<{ action: 'loosening-rejected'; reason: AttentionLooseningRejection; proposalId: string }>
  | Readonly<{ action: 'owner-question'; questionId: string; proposalId: string; exceeded: readonly AttentionGrantExceeded[] }>

export interface AttentionHoldoutSeal {
  readonly protocol: typeof ATTENTION_HOLDOUT_PROTOCOL
  readonly modulus: number
  readonly count: number
  readonly digest: string
}

export type AttentionTuningRequestResult =
  | Readonly<{ status: 'adopted'; version: number; change: AttentionTuningChange }>
  | Readonly<{ status: 'proposed'; proposalId: string; holdout: AttentionHoldoutSeal }>
  | Readonly<{ status: 'rejected'; reason: AttentionTuningRequestRejection }>

/** Sealed loosening proposal. It names holdout membership by digest only; holdout outcomes are never read to build it. */
export interface AttentionLooseningProposal {
  readonly protocol: typeof ATTENTION_LOOSENING_PROTOCOL
  readonly scopeKey: string
  readonly cohort: AttentionCohort
  /** 1-based position among this cohort's proposals, so identical retries stay distinct. */
  readonly ordinal: number
  readonly parentVersion: number
  readonly parentDigest: string | null
  readonly parent: AttentionTuningParameters
  readonly candidate: AttentionTuningParameters
  readonly change: AttentionTuningChange
  readonly steps: number
  readonly window: Readonly<{ fromNotifiedAt: number; toNotifiedAt: number }>
  readonly holdout: AttentionHoldoutSeal
  /** Training-partition outcome summary; becomes the adopted version's regression basis. */
  readonly basis: Readonly<{ stats: AttentionCohortStats; scopeWatermark: number }>
  readonly createdAt: number
}

export interface AttentionLooseningDecision {
  readonly decision: 'adopted' | 'rejected' | 'owner-question'
  readonly reason: string
  readonly grantId: string | null
  readonly version: number | null
  readonly replay: AttentionReplaySummary | null
  readonly decidedAt: number
}

/**
 * Structured owner question. The body is immutable and keeps `delivery:
 * 'not-sent'` as recorded; the optional slice-4 delivery state lives in the
 * separate `attention-owner-questions` ledger.
 */
export interface AttentionOwnerQuestion {
  readonly protocol: typeof ATTENTION_OWNER_QUESTION_PROTOCOL
  readonly kind: 'attention-loosening-authorization'
  readonly scopeKey: string
  readonly cohort: AttentionCohort
  readonly proposalId: string
  readonly parentVersion: number
  readonly parentDigest: string | null
  readonly parent: AttentionTuningParameters
  readonly candidate: AttentionTuningParameters
  readonly change: AttentionTuningChange
  readonly steps: number
  readonly replay: AttentionReplaySummary
  readonly exceeded: readonly AttentionGrantExceeded[]
  /** Latest grant row asked under (even if unverifiable); a different grant closes the question. */
  readonly grantId: string | null
  readonly choices: readonly ['authorize-once', 'decline']
  readonly delivery: 'not-sent'
  readonly createdAt: number
}

export type AttentionLooseningGrantResult =
  | Readonly<{ status: 'granted'; grantId: string; digest: string }>
  | Readonly<{ status: 'rejected'; reason: 'loosening-disabled' | 'grant-conflict' | 'grant-expired' }>

export interface AttentionLooseningStatus {
  readonly grant: Readonly<{ grant: AttentionLooseningGrant; digest: string; createdAt: number; used: number; remaining: number }> | null
  readonly proposals: readonly Readonly<{ proposalId: string; proposal: AttentionLooseningProposal; decision: AttentionLooseningDecision | null }>[]
  readonly questions: readonly Readonly<{ questionId: string; question: AttentionOwnerQuestion }>[]
}

/** Present only when the slice-3 opt-in is on; absent options keep slice-2 behaviour byte for byte. */
export interface AttentionLooseningOptions { readonly replayWindowMs: number }

function invalid(message: string): never {
  throw new EvaluationStoreError('invalid-input', `attention tuning: ${message}`)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

function identifier(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || /\p{Cc}/u.test(value)) {
    invalid(`${label} must be a bounded identifier`)
  }
  return value
}

export function normalizeAttentionCohort(input: unknown): AttentionCohort {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('cohort must be an object')
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'lane' && key !== 'sourceId')) invalid('cohort has unknown fields')
  return Object.freeze({ lane: identifier(record.lane, 'cohort.lane', 64), sourceId: identifier(record.sourceId, 'cohort.sourceId', 256) })
}

/** Strict shape check only; bounds and step alignment are judged separately so a request can be recorded. */
export function normalizeAttentionTuningParameters(input: unknown): AttentionTuningParameters {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('parameters must be an object')
  const record = input as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (stable(keys) !== stable([...attentionTuningOrder].sort())) invalid('parameters must name exactly the tunable fields')
  for (const key of ['interruptionCostDelta', 'minimumUtilityDelta', 'quietExtensionMinutes'] as const) {
    if (!Number.isSafeInteger(record[key])) invalid(`${key} must be an integer`)
  }
  if (typeof record.muted !== 'boolean') invalid('muted must be a boolean')
  return Object.freeze({
    interruptionCostDelta: record.interruptionCostDelta as number,
    minimumUtilityDelta: record.minimumUtilityDelta as number,
    quietExtensionMinutes: record.quietExtensionMinutes as number,
    muted: record.muted as boolean,
  })
}

/** Clamp every numeric field into its fixed bound (snapped down to the step grid). */
export function clampAttentionTuning(input: AttentionTuningParameters): AttentionTuningParameters {
  const clamp = (key: AttentionTuningNumericParameter): number => {
    const { min, max, step } = attentionTuningBounds[key]
    const value = Math.min(max, Math.max(min, Math.trunc(input[key])))
    return min + Math.floor((value - min) / step) * step
  }
  return Object.freeze({
    interruptionCostDelta: clamp('interruptionCostDelta'),
    minimumUtilityDelta: clamp('minimumUtilityDelta'),
    quietExtensionMinutes: clamp('quietExtensionMinutes'),
    muted: input.muted === true,
  })
}

export function withinAttentionTuningBounds(input: AttentionTuningParameters): boolean {
  return stable(clampAttentionTuning(input)) === stable(input)
}

/** True when any field would make notifications more frequent than `current`. */
export function isAttentionLoosening(current: AttentionTuningParameters, next: AttentionTuningParameters): boolean {
  return next.interruptionCostDelta < current.interruptionCostDelta
    || next.minimumUtilityDelta < current.minimumUtilityDelta
    || next.quietExtensionMinutes < current.quietExtensionMinutes
    || (current.muted && !next.muted)
}

function atLeastRate(numerator: number, denominator: number, ratePpm: number): boolean {
  return BigInt(numerator) * 1_000_000n >= BigInt(ratePpm) * BigInt(denominator)
}

/**
 * Pure tighten-only tuner. With at least `minSample` decided notifications and
 * a negative (rejected + expired-unhandled) rate at or above the threshold, it
 * proposes exactly one step on the first non-maxed parameter in fixed order;
 * mute additionally requires `muteRatePpm`. Never proposes loosening.
 */
export function proposeAttentionTuning(currentInput: AttentionTuningParameters, stats: AttentionCohortStats, policy: AttentionTuningPolicy): AttentionTuningProposal {
  const current = clampAttentionTuning(currentInput)
  if (stats.decided < policy.minSample || stats.decided === 0) return deepFreeze({ kind: 'no-op', reason: 'insufficient-sample' })
  if (!atLeastRate(stats.negative, stats.decided, policy.negativeRatePpm)) return deepFreeze({ kind: 'no-op', reason: 'below-threshold' })
  for (const parameter of attentionTuningOrder) {
    if (parameter === 'muted') {
      if (current.muted || !atLeastRate(stats.negative, stats.decided, policy.muteRatePpm)) continue
      return deepFreeze({ kind: 'tighten', change: { parameter, from: false, to: true }, parameters: { ...current, muted: true } })
    }
    const { max, step } = attentionTuningBounds[parameter]
    if (current[parameter] >= max) continue
    const to = Math.min(max, current[parameter] + step)
    return deepFreeze({ kind: 'tighten', change: { parameter, from: current[parameter], to }, parameters: { ...current, [parameter]: to } })
  }
  return deepFreeze({ kind: 'no-op', reason: 'at-bound' })
}

/**
 * Regression test for an observing version: the post-adoption negative rate
 * must exceed the basis (parent-era) rate by more than the margin. Cross
 * multiplication keeps it exact; acceptances only lower the rate, so positive
 * evidence can never satisfy it.
 */
export function attentionRegressed(basis: AttentionCohortStats, post: AttentionCohortStats, policy: AttentionTuningPolicy): boolean {
  if (post.decided < policy.minSample || post.decided === 0 || basis.decided === 0) return false
  const left = BigInt(post.negative) * BigInt(basis.decided) * 1_000_000n
  const right = BigInt(basis.negative) * BigInt(post.decided) * 1_000_000n + BigInt(policy.regressionMarginPpm) * BigInt(basis.decided) * BigInt(post.decided)
  return left > right
}

/**
 * WP22 slice 3: sealed holdout partition. Membership is a pure function of the
 * notification id under a fixed protocol salt and modulus, so it is
 * reproducible by any auditor and never chosen by the proposer.
 */
export const ATTENTION_HOLDOUT_PROTOCOL = 'assistant-evaluation/attention-holdout/v1' as const
export const attentionHoldoutModulus = 4
export const ATTENTION_LOOSENING_PROTOCOL = 'assistant-evaluation/attention-loosening/v1' as const
export const ATTENTION_LOOSENING_GRANT_PROTOCOL = 'assistant-evaluation/attention-loosening-grant/v1' as const
export const ATTENTION_OWNER_QUESTION_PROTOCOL = 'assistant-evaluation/attention-owner-question/v1' as const

export function attentionHoldoutMember(notificationId: string): boolean {
  const hex = createHash('sha256').update(`${ATTENTION_HOLDOUT_PROTOCOL}\n${notificationId}`).digest('hex')
  return Number.parseInt(hex.slice(0, 8), 16) % attentionHoldoutModulus === 0
}

/** True when `a` suppresses at least everything `b` suppresses (every field at least as tight). */
export function attentionTighterOrEqual(a: AttentionTuningParameters, b: AttentionTuningParameters): boolean {
  return a.interruptionCostDelta >= b.interruptionCostDelta
    && a.minimumUtilityDelta >= b.minimumUtilityDelta
    && a.quietExtensionMinutes >= b.quietExtensionMinutes
    && (a.muted || !b.muted)
}

export interface AttentionLooseningChange extends AttentionTuningChange {
  /** Grid steps moved toward the default; unmute counts as one. */
  readonly steps: number
}

/** One parameter moved toward the default by whole grid steps, or an unmute; anything else is undefined. */
export function attentionLooseningChange(current: AttentionTuningParameters, next: AttentionTuningParameters): AttentionLooseningChange | undefined {
  const changed = attentionTuningOrder.filter(key => current[key] !== next[key])
  if (changed.length !== 1) return undefined
  const parameter = changed[0]!
  if (parameter === 'muted') return current.muted && !next.muted ? Object.freeze({ parameter, from: true, to: false, steps: 1 }) : undefined
  const delta = current[parameter] - next[parameter]
  const { step } = attentionTuningBounds[parameter]
  if (delta <= 0 || delta % step !== 0) return undefined
  return Object.freeze({ parameter, from: current[parameter], to: next[parameter], steps: delta / step })
}

export interface AttentionReplayRecord {
  /** Parameters that were active when the notification was sent. */
  readonly era: AttentionTuningParameters
  readonly outcome: NotificationOutcome
}

export interface AttentionReplayTally { readonly decided: number; readonly positive: number; readonly negative: number }

export type AttentionReplayFailure = 'insufficient-holdout' | 'extra-interruptions' | 'candidate-negative-rate' | 'no-net-benefit'

export interface AttentionReplaySummary {
  readonly protocol: typeof ATTENTION_LOOSENING_PROTOCOL
  /** Sent under an era at least as tight as the parent: both parent and candidate send them. */
  readonly shared: AttentionReplayTally
  /** Sent under an era the candidate admits but the parent may suppress: the loosening's extra traffic. */
  readonly discriminating: AttentionReplayTally
  /** Sent under an era looser than the candidate; neither verdict is attributable, reported only. */
  readonly unattributable: AttentionReplayTally
  /** False positives are delivered-and-rejected/ignored; misses are owner-accepted notifications suppressed. */
  readonly parent: Readonly<{ falsePositives: number; misses: number }>
  readonly candidate: Readonly<{ falsePositives: number; misses: number }>
  readonly thresholds: Readonly<{ minSample: number; maxDiscriminatingNegativeRatePpm: number; maxCandidateNegativeRatePpm: number }>
  readonly verdict: 'pass' | 'fail'
  readonly reason?: AttentionReplayFailure
}

const positiveOutcomes: readonly NotificationOutcome[] = ['accepted', 'reacted']

/**
 * Deterministic counterfactual replay of a loosening on holdout records.
 * Notifications carry no per-message utility, so each is attributed by the
 * era it was sent under: an era at least as tight as a configuration proves
 * that configuration would also have sent it. Passing requires enough
 * discriminating evidence, an extra-interruption rate below the tuning
 * threshold minus the regression margin, a candidate-wide negative rate below
 * the tightening threshold (so it would not be immediately re-tightened), and
 * more owner-valued notifications recovered than extra interruptions added.
 */
export function replayAttentionLoosening(records: readonly AttentionReplayRecord[], parent: AttentionTuningParameters,
  candidate: AttentionTuningParameters, policy: AttentionTuningPolicy): AttentionReplaySummary {
  const tally = () => ({ decided: 0, positive: 0, negative: 0 })
  const shared = tally()
  const discriminating = tally()
  const unattributable = tally()
  for (const record of records) {
    const positive = positiveOutcomes.includes(record.outcome)
    const negative = negativeOutcomes.includes(record.outcome)
    if (!positive && !negative) continue
    const bucket = attentionTighterOrEqual(record.era, parent) ? shared
      : attentionTighterOrEqual(record.era, candidate) ? discriminating : unattributable
    bucket.decided += 1
    if (positive) bucket.positive += 1
    else bucket.negative += 1
  }
  const maxDiscriminatingNegativeRatePpm = Math.max(0, policy.negativeRatePpm - policy.regressionMarginPpm)
  const candidateDecided = shared.decided + discriminating.decided
  const candidateNegative = shared.negative + discriminating.negative
  const reason: AttentionReplayFailure | undefined = discriminating.decided < policy.minSample || discriminating.decided === 0 ? 'insufficient-holdout'
    : BigInt(discriminating.negative) * 1_000_000n > BigInt(maxDiscriminatingNegativeRatePpm) * BigInt(discriminating.decided) ? 'extra-interruptions'
      : atLeastRate(candidateNegative, candidateDecided, policy.negativeRatePpm) ? 'candidate-negative-rate'
        : discriminating.positive <= discriminating.negative ? 'no-net-benefit'
          : undefined
  return deepFreeze({
    protocol: ATTENTION_LOOSENING_PROTOCOL, shared, discriminating, unattributable,
    parent: { falsePositives: shared.negative, misses: discriminating.positive },
    candidate: { falsePositives: candidateNegative, misses: 0 },
    thresholds: { minSample: policy.minSample, maxDiscriminatingNegativeRatePpm, maxCandidateNegativeRatePpm: policy.negativeRatePpm },
    verdict: reason === undefined ? 'pass' : 'fail',
    ...(reason === undefined ? {} : { reason }),
  })
}

/** Owner one-time pre-authorization for automatic loosening of one cohort. */
export interface AttentionLooseningGrant {
  readonly grantId: string
  /** Loosest parameters a candidate may reach. */
  readonly lowerBound: AttentionTuningParameters
  /** Tightest parameters a loosening may start from. */
  readonly upperBound: AttentionTuningParameters
  readonly maxStepsPerAdoption: number
  readonly maxAdoptions: number
  readonly expiresAt: number
}

export type AttentionGrantExceeded = 'no-grant' | 'grant-unverifiable' | 'grant-expired' | 'grant-exhausted' | 'outside-bounds' | 'step-too-large'

export function normalizeAttentionLooseningGrant(input: unknown): AttentionLooseningGrant {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('grant must be an object')
  const record = input as Record<string, unknown>
  const fields = ['expiresAt', 'grantId', 'lowerBound', 'maxAdoptions', 'maxStepsPerAdoption', 'upperBound']
  if (stable(Object.keys(record).sort()) !== stable(fields)) invalid('grant must name exactly the grant fields')
  const grantId = identifier(record.grantId, 'grant.grantId', 128)
  const lowerBound = normalizeAttentionTuningParameters(record.lowerBound)
  const upperBound = normalizeAttentionTuningParameters(record.upperBound)
  if (!withinAttentionTuningBounds(lowerBound) || !withinAttentionTuningBounds(upperBound)) invalid('grant bounds must lie on the fixed tuning grid')
  if (!attentionTighterOrEqual(upperBound, lowerBound)) invalid('grant upperBound must be at least as tight as lowerBound')
  const integer = (key: string, min: number, max: number): number => {
    const value = record[key]
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(`grant.${key} must be an integer in [${min}, ${max}]`)
    return value as number
  }
  return deepFreeze({
    grantId, lowerBound: { ...lowerBound }, upperBound: { ...upperBound },
    maxStepsPerAdoption: integer('maxStepsPerAdoption', 1, 4),
    maxAdoptions: integer('maxAdoptions', 1, 10),
    expiresAt: integer('expiresAt', 0, Number.MAX_SAFE_INTEGER),
  })
}

/** Every way a holdout-accepted loosening falls outside the active grant; empty means adoptable. */
export function attentionGrantExceeded(grant: AttentionLooseningGrant | undefined, used: number, parent: AttentionTuningParameters,
  candidate: AttentionTuningParameters, steps: number, now: number): readonly AttentionGrantExceeded[] {
  if (grant === undefined) return Object.freeze(['no-grant'])
  const exceeded: AttentionGrantExceeded[] = []
  if (now >= grant.expiresAt) exceeded.push('grant-expired')
  if (used >= grant.maxAdoptions) exceeded.push('grant-exhausted')
  if (!attentionTighterOrEqual(grant.upperBound, parent) || !attentionTighterOrEqual(candidate, grant.lowerBound)) exceeded.push('outside-bounds')
  if (steps > grant.maxStepsPerAdoption) exceeded.push('step-too-large')
  return Object.freeze(exceeded)
}

/** Single-step tightening check for an explicit request. */
function singleStep(current: AttentionTuningParameters, next: AttentionTuningParameters): AttentionTuningChange | undefined {
  const changed = attentionTuningOrder.filter(key => current[key] !== next[key])
  if (changed.length !== 1) return undefined
  const parameter = changed[0]!
  if (parameter === 'muted') return { parameter, from: current.muted, to: next.muted }
  if (next[parameter] - current[parameter] !== attentionTuningBounds[parameter].step) return undefined
  return { parameter, from: current[parameter], to: next[parameter] }
}

interface VersionRow {
  scope_key: string; lane: string; source_id: string; version: number; parent_version: number
  parameters_json: string; basis_json: string; change_json: string; origin: 'auto' | 'request'; digest: string; created_at: number
}

interface HeadRow {
  scope_key: string; lane: string; source_id: string; workspace: string; preset: string
  active_version: number; latest_version: number; state: 'idle' | 'observing'
  observing_version: number | null; observe_from: number | null; observe_until: number | null; changed_at: number
}

interface ProposalRow {
  proposal_id: string; scope_key: string; lane: string; source_id: string; parent_version: number
  proposal_json: string; holdout_digest: string; created_at: number
}

interface EventRow {
  sequence: number; kind: AttentionTuningEvent['kind']; from_version: number; to_version: number
  reason: string; detail_json: string; occurred_at: number
}

function versionDigest(input: Omit<AttentionTuningVersion, 'digest' | 'createdAt'>): string {
  return sha256({
    protocol: input.protocol, scopeKey: input.scopeKey, cohort: input.cohort, version: input.version,
    parentVersion: input.parentVersion, parentDigest: input.parentDigest, parameters: input.parameters,
    basis: input.basis, change: input.change, origin: input.origin,
  })
}

const negativeOutcomes: readonly NotificationOutcome[] = ['rejected', 'expired-unhandled']

/**
 * Durable ledger over the same Evaluation database as the notification canon.
 * All decisions recompute inside BEGIN IMMEDIATE so concurrent ticks or a
 * restart mid-observation converge on one head.
 */
export class AttentionTuningLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number

  constructor(database: DatabaseSync, now: () => number) {
    this.#database = database
    this.#now = now
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

  /** Current-head (id, outcome, notifiedAt) rows for one cohort, notified in [from, to), in id order. */
  #records(scopeKey: string, cohort: AttentionCohort, fromNotifiedAt: number, toNotifiedAt: number): readonly { notification_id: string; outcome: NotificationOutcome; occurred_at: number }[] {
    return this.#database.prepare(`SELECT h.notification_id AS notification_id, h.outcome AS outcome, h.occurred_at AS occurred_at
      FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
      WHERE h.scope_key=? AND h.occurred_at>=? AND h.occurred_at<?
        AND json_extract(r.record_json, '$.lane')=? AND json_extract(r.record_json, '$.sourceId')=?
      ORDER BY h.notification_id`).all(scopeKey, fromNotifiedAt, toNotifiedAt, cohort.lane, cohort.sourceId) as unknown as { notification_id: string; outcome: NotificationOutcome; occurred_at: number }[]
  }

  /** Holdout membership for a window: ids only. Outcomes are deliberately not part of the seal. */
  #holdout(scopeKey: string, cohort: AttentionCohort, fromNotifiedAt: number, toNotifiedAt: number): Readonly<{ ids: readonly string[]; seal: AttentionHoldoutSeal }> {
    const ids = this.#records(scopeKey, cohort, fromNotifiedAt, toNotifiedAt).map(row => row.notification_id).filter(attentionHoldoutMember)
    const digest = sha256({ protocol: ATTENTION_HOLDOUT_PROTOCOL, modulus: attentionHoldoutModulus, scopeKey, cohort: { lane: cohort.lane, sourceId: cohort.sourceId },
      fromNotifiedAt, toNotifiedAt, ids })
    return deepFreeze({ ids, seal: { protocol: ATTENTION_HOLDOUT_PROTOCOL, modulus: attentionHoldoutModulus, count: ids.length, digest } })
  }

  /**
   * Current-head outcome counts for one cohort, notified in [from, to).
   * `training` excludes the sealed holdout partition; every proposer uses it
   * once the slice-3 opt-in is on, so no proposal is fitted to holdout data.
   */
  stats(scopeKey: string, cohort: AttentionCohort, fromNotifiedAt: number, toNotifiedAt: number, partition: 'all' | 'training' = 'all'): AttentionCohortStats {
    if (partition === 'training') {
      const counts = new Map<NotificationOutcome, number>()
      for (const row of this.#records(scopeKey, cohort, fromNotifiedAt, toNotifiedAt)) {
        if (!attentionHoldoutMember(row.notification_id)) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1)
      }
      return this.#summarize(fromNotifiedAt, toNotifiedAt, [...counts].map(([outcome, count]) => ({ outcome, count })))
    }
    const rows = this.#database.prepare(`SELECT h.outcome AS outcome, COUNT(*) AS count
      FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
      WHERE h.scope_key=? AND h.occurred_at>=? AND h.occurred_at<?
        AND json_extract(r.record_json, '$.lane')=? AND json_extract(r.record_json, '$.sourceId')=?
      GROUP BY h.outcome`).all(scopeKey, fromNotifiedAt, toNotifiedAt, cohort.lane, cohort.sourceId) as { outcome: NotificationOutcome; count: number }[]
    return this.#summarize(fromNotifiedAt, toNotifiedAt, rows)
  }

  #summarize(fromNotifiedAt: number, toNotifiedAt: number, rows: readonly { outcome: NotificationOutcome; count: number }[]): AttentionCohortStats {
    const count = (outcome: NotificationOutcome): number => rows.find(row => row.outcome === outcome)?.count ?? 0
    const accepted = count('accepted')
    const reacted = count('reacted')
    const rejected = count('rejected')
    const expiredUnhandled = count('expired-unhandled')
    return Object.freeze({
      fromNotifiedAt, toNotifiedAt,
      total: rows.reduce((sum, row) => sum + row.count, 0),
      accepted, reacted, rejected, expiredUnhandled,
      decided: accepted + reacted + rejected + expiredUnhandled,
      negative: negativeOutcomes.reduce((sum, outcome) => sum + count(outcome), 0),
    })
  }

  /** Scopes that have at least one notification in the cohort, plus scopes with a tuning head. */
  scopes(cohort: AttentionCohort): readonly EvaluationScope[] {
    const rows = this.#database.prepare(`SELECT DISTINCT json_extract(r.record_json, '$.scope.workspace') AS workspace,
        json_extract(r.record_json, '$.scope.preset') AS preset
      FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
      WHERE json_extract(r.record_json, '$.lane')=? AND json_extract(r.record_json, '$.sourceId')=?
      UNION SELECT workspace, preset FROM evaluation_attention_tuning_heads WHERE lane=? AND source_id=?
      ORDER BY workspace, preset`).all(cohort.lane, cohort.sourceId, cohort.lane, cohort.sourceId) as { workspace: string; preset: string }[]
    return Object.freeze(rows.map(row => Object.freeze({ workspace: row.workspace, preset: row.preset })))
  }

  #scopeWatermark(scopeKey: string): number {
    return (this.#database.prepare('SELECT watermark FROM evaluation_notification_watermarks WHERE scope_key=?')
      .get(scopeKey) as { watermark: number } | undefined)?.watermark ?? 0
  }

  #head(scopeKey: string, cohort: AttentionCohort): HeadRow | undefined {
    return this.#database.prepare('SELECT * FROM evaluation_attention_tuning_heads WHERE scope_key=? AND lane=? AND source_id=?')
      .get(scopeKey, cohort.lane, cohort.sourceId) as unknown as HeadRow | undefined
  }

  #row(scopeKey: string, cohort: AttentionCohort, version: number): VersionRow | undefined {
    return this.#database.prepare('SELECT * FROM evaluation_attention_tuning_versions WHERE scope_key=? AND lane=? AND source_id=? AND version=?')
      .get(scopeKey, cohort.lane, cohort.sourceId, version) as unknown as VersionRow | undefined
  }

  /** Parse and digest-verify one stored version; undefined when unreadable or tampered. */
  #verified(scopeKey: string, cohort: AttentionCohort, version: number): AttentionTuningVersion | undefined {
    const row = this.#row(scopeKey, cohort, version)
    if (row === undefined) return undefined
    try {
      const parentDigest = row.parent_version === 0 ? null : this.#row(scopeKey, cohort, row.parent_version)?.digest ?? null
      if (row.parent_version !== 0 && parentDigest === null) return undefined
      const parameters = normalizeAttentionTuningParameters(JSON.parse(row.parameters_json))
      if (!withinAttentionTuningBounds(parameters)) return undefined
      const body = {
        protocol: ATTENTION_TUNING_PROTOCOL, scopeKey, cohort: { lane: cohort.lane, sourceId: cohort.sourceId }, version: row.version,
        parentVersion: row.parent_version, parentDigest, parameters,
        basis: JSON.parse(row.basis_json) as AttentionTuningVersion['basis'],
        change: JSON.parse(row.change_json) as AttentionTuningChange, origin: row.origin,
      }
      if (versionDigest(body) !== row.digest) return undefined
      return deepFreeze({ ...body, digest: row.digest, createdAt: row.created_at })
    } catch {
      return undefined
    }
  }

  #versionNumbers(scopeKey: string, cohort: AttentionCohort): readonly number[] {
    return (this.#database.prepare('SELECT version FROM evaluation_attention_tuning_versions WHERE scope_key=? AND lane=? AND source_id=? ORDER BY version')
      .all(scopeKey, cohort.lane, cohort.sourceId) as { version: number }[]).map(row => row.version)
  }

  /**
   * Active parameters for a consumer. A version that cannot be read or fails
   * digest verification falls back along its recorded parent chain, then to
   * the built-in default; a consumer never sees an unverified overlay.
   */
  current(scopeInput: EvaluationScope, cohortInput: AttentionCohort): AttentionTuningCurrent {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    return this.#current(scopeKey, cohort)
  }

  #current(scopeKey: string, cohort: AttentionCohort): AttentionTuningCurrent {
    const active = this.#head(scopeKey, cohort)?.active_version ?? 0
    let version = active
    let fallback = false
    const seen = new Set<number>()
    while (version > 0 && !seen.has(version)) {
      seen.add(version)
      const verified = this.#verified(scopeKey, cohort, version)
      if (verified !== undefined) {
        return deepFreeze({ scopeKey, cohort: { ...cohort }, version, digest: verified.digest, parameters: { ...verified.parameters }, source: fallback ? 'parent-fallback' : 'active' })
      }
      fallback = true
      const parent = (this.#database.prepare('SELECT parent_version FROM evaluation_attention_tuning_versions WHERE scope_key=? AND lane=? AND source_id=? AND version=?')
        .get(scopeKey, cohort.lane, cohort.sourceId, version) as { parent_version: unknown } | undefined)?.parent_version
      version = Number.isSafeInteger(parent) && (parent as number) >= 0 && (parent as number) < version ? parent as number : 0
    }
    return deepFreeze({ scopeKey, cohort: { ...cohort }, version: 0, digest: null, parameters: { ...defaultAttentionTuningParameters }, source: active === 0 ? 'active' : 'default' })
  }

  status(scopeInput: EvaluationScope, cohortInput: AttentionCohort, eventLimit = 50): AttentionTuningStatus {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    const head = this.#head(scopeKey, cohort)
    const versions = this.#versionNumbers(scopeKey, cohort)
      .map(version => this.#verified(scopeKey, cohort, version)).filter(value => value !== undefined)
    const events = (this.#database.prepare(`SELECT sequence, kind, from_version, to_version, reason, detail_json, occurred_at
      FROM evaluation_attention_tuning_events WHERE scope_key=? AND lane=? AND source_id=? ORDER BY sequence DESC LIMIT ?`)
      .all(scopeKey, cohort.lane, cohort.sourceId, eventLimit) as unknown as EventRow[]).reverse().map(row => ({
      sequence: row.sequence, kind: row.kind, fromVersion: row.from_version, toVersion: row.to_version,
      reason: row.reason, detail: JSON.parse(row.detail_json) as Record<string, unknown>, occurredAt: row.occurred_at,
    }))
    return deepFreeze({
      current: this.#current(scopeKey, cohort),
      state: head?.state ?? 'idle',
      ...(head?.observe_from == null ? {} : { observeFrom: head.observe_from }),
      ...(head?.observe_until == null ? {} : { observeUntil: head.observe_until }),
      versions, events,
    })
  }

  #event(scopeKey: string, cohort: AttentionCohort, kind: AttentionTuningEvent['kind'], fromVersion: number, toVersion: number,
    reason: string, detail: Record<string, unknown>, idempotencyKey: string | null, now: number): void {
    this.#database.prepare(`INSERT INTO evaluation_attention_tuning_events
      (scope_key, lane, source_id, kind, from_version, to_version, reason, detail_json, idempotency_key, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(scopeKey, cohort.lane, cohort.sourceId, kind, fromVersion, toVersion, reason, stable(detail), idempotencyKey, now)
  }

  #adopt(scope: EvaluationScope, scopeKey: string, cohort: AttentionCohort, head: HeadRow | undefined, current: AttentionTuningCurrent,
    proposal: Readonly<{ change: AttentionTuningChange; parameters: AttentionTuningParameters }>, stats: AttentionCohortStats, origin: 'auto' | 'request',
    observationMs: number, now: number, loosening?: Readonly<{ proposalId: string; grantId: string }>): number {
    // Parent is the verified version the consumer is actually running.
    const parentVersion = current.version
    const scopeWatermark = this.#scopeWatermark(scopeKey)
    const idempotencyKey = `adopt:${sha256([scopeKey, cohort.lane, cohort.sourceId, parentVersion, current.digest, scopeWatermark, proposal.change, origin,
      ...(loosening === undefined ? [] : [loosening.proposalId])])}`
    const existing = this.#database.prepare('SELECT version FROM evaluation_attention_tuning_versions WHERE idempotency_key=?')
      .get(idempotencyKey) as { version: number } | undefined
    if (existing !== undefined) return existing.version
    const version = (head?.latest_version ?? 0) + 1
    const body = {
      protocol: ATTENTION_TUNING_PROTOCOL, scopeKey, cohort: { lane: cohort.lane, sourceId: cohort.sourceId }, version,
      parentVersion, parentDigest: current.digest, parameters: proposal.parameters,
      basis: { stats, scopeWatermark }, change: proposal.change, origin,
    }
    const digest = versionDigest(body)
    this.#database.prepare(`INSERT INTO evaluation_attention_tuning_versions
      (scope_key, lane, source_id, version, parent_version, parameters_json, basis_json, change_json, origin, digest, idempotency_key, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(scopeKey, cohort.lane, cohort.sourceId, version, parentVersion,
      stable(body.parameters), stable(body.basis), stable(body.change), origin, digest, idempotencyKey, now)
    const observeUntil = now + observationMs
    if (head === undefined) {
      this.#database.prepare(`INSERT INTO evaluation_attention_tuning_heads
        (scope_key, lane, source_id, workspace, preset, active_version, latest_version, state, observing_version, observe_from, observe_until, changed_at)
        VALUES (?,?,?,?,?,?,?, 'observing', ?,?,?,?)`).run(scopeKey, cohort.lane, cohort.sourceId, scope.workspace, scope.preset,
        version, version, version, now, observeUntil, now)
    } else {
      this.#database.prepare(`UPDATE evaluation_attention_tuning_heads SET active_version=?, latest_version=?, state='observing',
        observing_version=?, observe_from=?, observe_until=?, changed_at=? WHERE scope_key=? AND lane=? AND source_id=?`)
        .run(version, version, version, now, observeUntil, now, scopeKey, cohort.lane, cohort.sourceId)
    }
    this.#event(scopeKey, cohort, 'adopted', parentVersion, version,
      loosening !== undefined ? 'holdout-accepted' : origin === 'auto' ? 'negative-rate-threshold' : 'owner-request',
      { digest, change: proposal.change, stats, scopeWatermark, ...loosening }, idempotencyKey, now)
    return version
  }

  /**
   * One deterministic step for one cohort: monitor an observing version
   * (rollback to its exact parent on regression, settle at window end), or
   * when idle propose and adopt a single bounded tightening step.
   */
  tick(scopeInput: EvaluationScope, cohortInput: AttentionCohort, policy: AttentionTuningPolicy,
    options: Readonly<{ observationMs: number; evaluationWindowMs: number; loosening?: AttentionLooseningOptions }>): AttentionTuningTickAction {
    const { scope, scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    return this.#transaction(() => {
      const now = this.#now()
      const head = this.#head(scopeKey, cohort)
      if (head?.state === 'observing') {
        const observed = head.observing_version!
        const version = this.#verified(scopeKey, cohort, observed)
        const post = this.stats(scopeKey, cohort, head.observe_from!, now + 1)
        // An unverifiable observing version is reverted exactly like a regression.
        if (version === undefined || attentionRegressed(version.basis.stats, post, policy)) {
          const parent = (this.#database.prepare('SELECT parent_version FROM evaluation_attention_tuning_versions WHERE scope_key=? AND lane=? AND source_id=? AND version=?')
            .get(scopeKey, cohort.lane, cohort.sourceId, observed) as { parent_version: number } | undefined)?.parent_version ?? 0
          this.#database.prepare(`UPDATE evaluation_attention_tuning_heads SET active_version=?, state='idle', observing_version=NULL,
            observe_from=NULL, observe_until=NULL, changed_at=? WHERE scope_key=? AND lane=? AND source_id=?`)
            .run(parent, now, scopeKey, cohort.lane, cohort.sourceId)
          this.#event(scopeKey, cohort, 'rolled-back', observed, parent, version === undefined ? 'version-unverifiable' : 'negative-rate-regressed',
            { basis: version?.basis.stats ?? null, post }, `rollback:${sha256([scopeKey, cohort.lane, cohort.sourceId, observed, parent])}`, now)
          return Object.freeze({ action: 'rolled-back' as const, fromVersion: observed, toVersion: parent })
        }
        if (now >= head.observe_until!) {
          this.#database.prepare(`UPDATE evaluation_attention_tuning_heads SET state='idle', observing_version=NULL,
            observe_from=NULL, observe_until=NULL, changed_at=? WHERE scope_key=? AND lane=? AND source_id=?`)
            .run(now, scopeKey, cohort.lane, cohort.sourceId)
          this.#event(scopeKey, cohort, 'settled', observed, observed, 'observation-complete', { post },
            `settle:${sha256([scopeKey, cohort.lane, cohort.sourceId, observed, head.observe_from])}`, now)
          return Object.freeze({ action: 'settled' as const, version: observed })
        }
        return Object.freeze({ action: 'observing' as const, version: observed })
      }
      if (options.loosening !== undefined) {
        // A sealed loosening proposal is judged before any new tightening so
        // its parent cannot move underneath it.
        const pending = this.#pendingProposal(scopeKey, cohort)
        if (pending !== undefined) return this.#decideLoosening(scope, scopeKey, cohort, head, pending, policy, options.observationMs, now)
      }
      const current = this.#current(scopeKey, cohort)
      // Evidence is only counted since the last change, so an adopted or
      // rolled-back version is never re-judged on its predecessor's sample.
      const from = Math.max(0, head?.changed_at ?? 0, now - options.evaluationWindowMs)
      const stats = this.stats(scopeKey, cohort, from, now + 1, options.loosening === undefined ? 'all' : 'training')
      const proposal = proposeAttentionTuning(current.parameters, stats, policy)
      if (proposal.kind === 'no-op') return Object.freeze({ action: 'no-op' as const, reason: proposal.reason })
      const version = this.#adopt(scope, scopeKey, cohort, head, current, proposal, stats, 'auto', options.observationMs, now)
      return Object.freeze({ action: 'adopted' as const, version, change: proposal.change })
    })
  }

  /**
   * Explicit parameter request. Any loosening field is rejected with
   * `loosening-requires-holdout` and recorded; so is every other rejection.
   * A single in-bounds tightening step is adopted with an observation window.
   */
  request(scopeInput: EvaluationScope, cohortInput: AttentionCohort, parametersInput: unknown,
    options: Readonly<{ enabled: boolean; observationMs: number; evaluationWindowMs: number; loosening?: AttentionLooseningOptions }>): AttentionTuningRequestResult {
    const { scope, scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    const requested = normalizeAttentionTuningParameters(parametersInput)
    return this.#transaction(() => {
      const now = this.#now()
      const head = this.#head(scopeKey, cohort)
      const current = this.#current(scopeKey, cohort)
      if (options.loosening !== undefined && isAttentionLoosening(current.parameters, requested)) {
        return this.#proposeLoosening(scopeKey, cohort, head, current, requested, options.enabled, options.loosening, now)
      }
      const change = singleStep(current.parameters, requested)
      const reason: AttentionTuningRequestRejection | undefined = isAttentionLoosening(current.parameters, requested) ? 'loosening-requires-holdout'
        : !withinAttentionTuningBounds(requested) ? 'out-of-bounds'
          : stable(requested) === stable(current.parameters) ? 'no-change'
            : change === undefined ? 'not-single-step'
              : !options.enabled ? 'auto-adoption-disabled'
                : head?.state === 'observing' ? 'observation-in-progress'
                  : undefined
      if (reason !== undefined || change === undefined) {
        const code = reason ?? 'not-single-step'
        this.#event(scopeKey, cohort, 'request-rejected', current.version, current.version, code,
          { current: current.parameters, requested }, null, now)
        return Object.freeze({ status: 'rejected' as const, reason: code })
      }
      const stats = this.stats(scopeKey, cohort, Math.max(0, head?.changed_at ?? 0, now - options.evaluationWindowMs), now + 1,
        options.loosening === undefined ? 'all' : 'training')
      const version = this.#adopt(scope, scopeKey, cohort, head, current, { change, parameters: requested }, stats,
        'request', options.observationMs, now)
      return deepFreeze({ status: 'adopted' as const, version, change })
    })
  }

  /**
   * Slice 3 loosening request: validate, then seal a proposal that names the
   * holdout membership by digest only. Nothing is adopted here; a later tick
   * replays the holdout independently and checks the owner grant.
   */
  #proposeLoosening(scopeKey: string, cohort: AttentionCohort, head: HeadRow | undefined, current: AttentionTuningCurrent,
    requested: AttentionTuningParameters, enabled: boolean, loosening: AttentionLooseningOptions, now: number): AttentionTuningRequestResult {
    const change = attentionLooseningChange(current.parameters, requested)
    const reason: AttentionTuningRequestRejection | undefined = !withinAttentionTuningBounds(requested) ? 'out-of-bounds'
      : change === undefined ? 'not-single-parameter'
        : !enabled ? 'auto-adoption-disabled'
          : head?.state === 'observing' ? 'observation-in-progress'
            : this.#pendingProposal(scopeKey, cohort) !== undefined ? 'proposal-pending'
              : this.#openQuestion(scopeKey, cohort) ? 'owner-question-pending'
                : undefined
    if (reason !== undefined || change === undefined) {
      const code = reason ?? 'not-single-parameter'
      this.#event(scopeKey, cohort, 'request-rejected', current.version, current.version, code,
        { current: current.parameters, requested }, null, now)
      return Object.freeze({ status: 'rejected' as const, reason: code })
    }
    const window = { fromNotifiedAt: Math.max(0, now - loosening.replayWindowMs), toNotifiedAt: now + 1 }
    const holdout = this.#holdout(scopeKey, cohort, window.fromNotifiedAt, window.toNotifiedAt)
    const body: AttentionLooseningProposal = {
      protocol: ATTENTION_LOOSENING_PROTOCOL, scopeKey, cohort: { lane: cohort.lane, sourceId: cohort.sourceId },
      ordinal: (this.#database.prepare(`SELECT COUNT(*) AS count FROM evaluation_attention_loosening_proposals
        WHERE scope_key=? AND lane=? AND source_id=?`).get(scopeKey, cohort.lane, cohort.sourceId) as { count: number }).count + 1,
      parentVersion: current.version, parentDigest: current.digest, parent: { ...current.parameters }, candidate: { ...requested },
      change: { parameter: change.parameter, from: change.from, to: change.to }, steps: change.steps, window,
      holdout: holdout.seal,
      basis: { stats: this.stats(scopeKey, cohort, window.fromNotifiedAt, window.toNotifiedAt, 'training'), scopeWatermark: this.#scopeWatermark(scopeKey) },
      createdAt: now,
    }
    const proposalId = sha256(body)
    this.#database.prepare(`INSERT INTO evaluation_attention_loosening_proposals
      (proposal_id, scope_key, lane, source_id, parent_version, proposal_json, holdout_digest, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(proposalId, scopeKey, cohort.lane, cohort.sourceId, current.version, stable(body), holdout.seal.digest, now)
    return deepFreeze({ status: 'proposed' as const, proposalId, holdout: { ...holdout.seal } })
  }

  #pendingProposal(scopeKey: string, cohort: AttentionCohort): ProposalRow | undefined {
    return this.#database.prepare(`SELECT p.* FROM evaluation_attention_loosening_proposals p
      LEFT JOIN evaluation_attention_loosening_decisions d ON d.proposal_id=p.proposal_id
      WHERE p.scope_key=? AND p.lane=? AND p.source_id=? AND d.proposal_id IS NULL
      ORDER BY p.created_at, p.rowid LIMIT 1`).get(scopeKey, cohort.lane, cohort.sourceId) as unknown as ProposalRow | undefined
  }

  /**
   * The latest owner question stays open until a different grant is recorded:
   * it names the latest grant row it was asked under (grant ids are unique
   * per cohort), so only a new owner authorization reopens the path.
   */
  #openQuestion(scopeKey: string, cohort: AttentionCohort): boolean {
    const question = this.#database.prepare(`SELECT question_json FROM evaluation_attention_owner_questions
      WHERE scope_key=? AND lane=? AND source_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(scopeKey, cohort.lane, cohort.sourceId) as { question_json: string } | undefined
    if (question === undefined) return false
    try {
      return (JSON.parse(question.question_json) as AttentionOwnerQuestion).grantId === this.#latestGrantId(scopeKey, cohort)
    } catch {
      return true
    }
  }

  /**
   * WP22 slice 4: the latest owner question of a cohort, verified against its
   * content id, and whether it is still open (same rule as `#openQuestion`).
   * Older questions are always closed. A row whose body no longer hashes to
   * its id is reported as `unverifiable` and must never be delivered.
   */
  latestOwnerQuestion(scopeInput: EvaluationScope, cohortInput: AttentionCohort):
    Readonly<{ questionId: string; question: AttentionOwnerQuestion; open: boolean }> | 'unverifiable' | undefined {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    const row = this.#database.prepare(`SELECT question_id, question_json FROM evaluation_attention_owner_questions
      WHERE scope_key=? AND lane=? AND source_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(scopeKey, cohort.lane, cohort.sourceId) as { question_id: string; question_json: string } | undefined
    if (row === undefined) return undefined
    let question: AttentionOwnerQuestion
    try { question = JSON.parse(row.question_json) as AttentionOwnerQuestion } catch { return 'unverifiable' }
    if (sha256(question) !== row.question_id || question.protocol !== ATTENTION_OWNER_QUESTION_PROTOCOL
      || question.scopeKey !== scopeKey || question.cohort?.lane !== cohort.lane || question.cohort?.sourceId !== cohort.sourceId) return 'unverifiable'
    return deepFreeze({ questionId: row.question_id, question, open: question.grantId === this.#latestGrantId(scopeKey, cohort) })
  }

  #latestGrantId(scopeKey: string, cohort: AttentionCohort): string | null {
    return (this.#database.prepare(`SELECT grant_id FROM evaluation_attention_loosening_grants
      WHERE scope_key=? AND lane=? AND source_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(scopeKey, cohort.lane, cohort.sourceId) as { grant_id: string } | undefined)?.grant_id ?? null
  }

  #verifiedProposal(row: ProposalRow, scopeKey: string, cohort: AttentionCohort): AttentionLooseningProposal | undefined {
    try {
      const body = JSON.parse(row.proposal_json) as AttentionLooseningProposal
      if (sha256(body) !== row.proposal_id || body.protocol !== ATTENTION_LOOSENING_PROTOCOL || body.scopeKey !== scopeKey
        || body.cohort.lane !== cohort.lane || body.cohort.sourceId !== cohort.sourceId || body.parentVersion !== row.parent_version
        || body.holdout.digest !== row.holdout_digest || body.holdout.protocol !== ATTENTION_HOLDOUT_PROTOCOL || body.holdout.modulus !== attentionHoldoutModulus) return undefined
      const parent = normalizeAttentionTuningParameters(body.parent)
      const candidate = normalizeAttentionTuningParameters(body.candidate)
      const change = attentionLooseningChange(parent, candidate)
      if (!withinAttentionTuningBounds(parent) || !withinAttentionTuningBounds(candidate) || change === undefined || change.steps !== body.steps) return undefined
      return deepFreeze(body)
    } catch {
      return undefined
    }
  }

  #grantDigest(scopeKey: string, cohort: AttentionCohort, grant: AttentionLooseningGrant): string {
    return sha256({ protocol: ATTENTION_LOOSENING_GRANT_PROTOCOL, scopeKey, cohort: { lane: cohort.lane, sourceId: cohort.sourceId }, grant })
  }

  /** Latest grant for the cohort; `unverifiable` when its stored body fails the digest. */
  #activeGrant(scopeKey: string, cohort: AttentionCohort): Readonly<{ grant: AttentionLooseningGrant; digest: string; createdAt: number }> | 'unverifiable' | undefined {
    const row = this.#database.prepare(`SELECT grant_id, grant_json, digest, created_at FROM evaluation_attention_loosening_grants
      WHERE scope_key=? AND lane=? AND source_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(scopeKey, cohort.lane, cohort.sourceId) as { grant_id: string; grant_json: string; digest: string; created_at: number } | undefined
    if (row === undefined) return undefined
    try {
      const grant = normalizeAttentionLooseningGrant(JSON.parse(row.grant_json))
      if (grant.grantId !== row.grant_id || this.#grantDigest(scopeKey, cohort, grant) !== row.digest) return 'unverifiable'
      return Object.freeze({ grant, digest: row.digest, createdAt: row.created_at })
    } catch {
      return 'unverifiable'
    }
  }

  /** Adoptions charged to a grant. Decisions are immutable, so a rollback never refunds quota. */
  #grantUsed(scopeKey: string, cohort: AttentionCohort, grantId: string): number {
    return (this.#database.prepare(`SELECT COUNT(*) AS count FROM evaluation_attention_loosening_decisions
      WHERE scope_key=? AND lane=? AND source_id=? AND grant_id=? AND decision='adopted'`)
      .get(scopeKey, cohort.lane, cohort.sourceId, grantId) as { count: number }).count
  }

  /** Parameters in force at a notification time, from the append-only adopted/rolled-back events. */
  #eraResolver(scopeKey: string, cohort: AttentionCohort): (notifiedAt: number) => AttentionTuningParameters | undefined {
    const changes = this.#database.prepare(`SELECT to_version, occurred_at FROM evaluation_attention_tuning_events
      WHERE scope_key=? AND lane=? AND source_id=? AND kind IN ('adopted','rolled-back') ORDER BY sequence`)
      .all(scopeKey, cohort.lane, cohort.sourceId) as { to_version: number; occurred_at: number }[]
    const cache = new Map<number, AttentionTuningParameters | undefined>()
    return notifiedAt => {
      let version = 0
      for (const change of changes) if (change.occurred_at <= notifiedAt) version = change.to_version
      if (version === 0) return defaultAttentionTuningParameters
      if (!cache.has(version)) cache.set(version, this.#verified(scopeKey, cohort, version)?.parameters)
      return cache.get(version)
    }
  }

  #decision(scopeKey: string, cohort: AttentionCohort, proposalId: string, decision: AttentionLooseningDecision['decision'], reason: string,
    grantId: string | null, version: number | null, replay: AttentionReplaySummary | null, now: number): void {
    this.#database.prepare(`INSERT INTO evaluation_attention_loosening_decisions
      (proposal_id, scope_key, lane, source_id, decision, reason, grant_id, version, replay_json, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(proposalId, scopeKey, cohort.lane, cohort.sourceId, decision, reason, grantId, version, stable(replay), now)
  }

  /**
   * Independent acceptance of one sealed proposal: verify it, require the
   * exact parent still in force, recompute holdout membership against the
   * frozen digest, replay parent vs candidate on holdout outcomes only, then
   * adopt inside the owner grant or record an owner question. Every outcome
   * is one immutable decision row plus a schema-15 tuning event.
   */
  #decideLoosening(scope: EvaluationScope, scopeKey: string, cohort: AttentionCohort, head: HeadRow | undefined, row: ProposalRow,
    policy: AttentionTuningPolicy, observationMs: number, now: number): AttentionTuningTickAction {
    const proposalId = row.proposal_id
    const current = this.#current(scopeKey, cohort)
    const reject = (reason: AttentionLooseningRejection, replay: AttentionReplaySummary | null): AttentionTuningTickAction => {
      this.#decision(scopeKey, cohort, proposalId, 'rejected', reason, null, null, replay, now)
      this.#event(scopeKey, cohort, 'request-rejected', current.version, current.version, reason, { proposalId, replay },
        `loosening:${proposalId}`, now)
      return Object.freeze({ action: 'loosening-rejected' as const, reason, proposalId })
    }
    const proposal = this.#verifiedProposal(row, scopeKey, cohort)
    if (proposal === undefined) return reject('proposal-unverifiable', null)
    if (current.version !== proposal.parentVersion || current.digest !== proposal.parentDigest
      || stable(current.parameters) !== stable(proposal.parent)) return reject('stale-parent', null)
    if (proposal.basis.stats.decided < policy.minSample) return reject('insufficient-basis', null)
    const { fromNotifiedAt, toNotifiedAt } = proposal.window
    const holdout = this.#holdout(scopeKey, cohort, fromNotifiedAt, toNotifiedAt)
    if (holdout.seal.digest !== proposal.holdout.digest) return reject('holdout-drifted', null)
    const members = new Set(holdout.ids)
    const era = this.#eraResolver(scopeKey, cohort)
    const records: AttentionReplayRecord[] = []
    for (const record of this.#records(scopeKey, cohort, fromNotifiedAt, toNotifiedAt)) {
      if (!members.has(record.notification_id)) continue
      const parameters = era(record.occurred_at)
      if (parameters === undefined) return reject('era-unverifiable', null)
      records.push({ era: parameters, outcome: record.outcome })
    }
    const replay = replayAttentionLoosening(records, proposal.parent, proposal.candidate, policy)
    if (replay.verdict === 'fail') return reject('holdout-failed', replay)
    const active = this.#activeGrant(scopeKey, cohort)
    const grant = active === 'unverifiable' ? undefined : active?.grant
    const exceeded: readonly AttentionGrantExceeded[] = active === 'unverifiable' ? ['grant-unverifiable']
      : attentionGrantExceeded(grant, grant === undefined ? 0 : this.#grantUsed(scopeKey, cohort, grant.grantId),
        proposal.parent, proposal.candidate, proposal.steps, now)
    if (exceeded.length > 0 || grant === undefined) {
      const askedUnder = this.#latestGrantId(scopeKey, cohort)
      const body: AttentionOwnerQuestion = {
        protocol: ATTENTION_OWNER_QUESTION_PROTOCOL, kind: 'attention-loosening-authorization', scopeKey,
        cohort: { lane: cohort.lane, sourceId: cohort.sourceId }, proposalId,
        parentVersion: proposal.parentVersion, parentDigest: proposal.parentDigest, parent: proposal.parent, candidate: proposal.candidate,
        change: proposal.change, steps: proposal.steps, replay, exceeded: [...exceeded], grantId: askedUnder,
        choices: ['authorize-once', 'decline'], delivery: 'not-sent', createdAt: now,
      }
      const questionId = sha256(body)
      this.#database.prepare(`INSERT INTO evaluation_attention_owner_questions
        (question_id, proposal_id, scope_key, lane, source_id, question_json, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(questionId, proposalId, scopeKey, cohort.lane, cohort.sourceId, stable(body), now)
      this.#decision(scopeKey, cohort, proposalId, 'owner-question', 'loosening-requires-owner', askedUnder, null, replay, now)
      this.#event(scopeKey, cohort, 'request-rejected', current.version, current.version, 'loosening-requires-owner',
        { proposalId, questionId, exceeded }, `loosening:${proposalId}`, now)
      return deepFreeze({ action: 'owner-question' as const, questionId, proposalId, exceeded: [...exceeded] })
    }
    const version = this.#adopt(scope, scopeKey, cohort, head, current, { change: proposal.change, parameters: proposal.candidate },
      proposal.basis.stats, 'request', observationMs, now, { proposalId, grantId: grant.grantId })
    this.#decision(scopeKey, cohort, proposalId, 'adopted', 'holdout-accepted', grant.grantId, version, replay, now)
    return deepFreeze({ action: 'loosening-adopted' as const, version, change: { ...proposal.change }, proposalId, grantId: grant.grantId })
  }

  /**
   * Record an owner one-time pre-authorization. Grants are immutable; the
   * latest one is active and its quota is never refunded. Re-sending the same
   * grant is idempotent; reusing an id with different content is rejected.
   */
  grant(scopeInput: EvaluationScope, cohortInput: AttentionCohort, grantInput: unknown): AttentionLooseningGrantResult {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    const grant = normalizeAttentionLooseningGrant(grantInput)
    return this.#transaction(() => {
      const now = this.#now()
      const digest = this.#grantDigest(scopeKey, cohort, grant)
      const existing = this.#database.prepare(`SELECT digest FROM evaluation_attention_loosening_grants
        WHERE scope_key=? AND lane=? AND source_id=? AND grant_id=?`).get(scopeKey, cohort.lane, cohort.sourceId, grant.grantId) as { digest: string } | undefined
      if (existing !== undefined) {
        return existing.digest === digest ? Object.freeze({ status: 'granted' as const, grantId: grant.grantId, digest })
          : Object.freeze({ status: 'rejected' as const, reason: 'grant-conflict' as const })
      }
      if (now >= grant.expiresAt) return Object.freeze({ status: 'rejected' as const, reason: 'grant-expired' as const })
      this.#database.prepare(`INSERT INTO evaluation_attention_loosening_grants
        (scope_key, lane, source_id, grant_id, grant_json, digest, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(scopeKey, cohort.lane, cohort.sourceId, grant.grantId, stable(grant), digest, now)
      return Object.freeze({ status: 'granted' as const, grantId: grant.grantId, digest })
    })
  }

  looseningStatus(scopeInput: EvaluationScope, cohortInput: AttentionCohort, limit = 50): AttentionLooseningStatus {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    const active = this.#activeGrant(scopeKey, cohort)
    const grant = active === undefined || active === 'unverifiable' ? null : (() => {
      const used = this.#grantUsed(scopeKey, cohort, active.grant.grantId)
      return { ...active, used, remaining: Math.max(0, active.grant.maxAdoptions - used) }
    })()
    const rows = (this.#database.prepare(`SELECT * FROM evaluation_attention_loosening_proposals
      WHERE scope_key=? AND lane=? AND source_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(scopeKey, cohort.lane, cohort.sourceId, limit) as unknown as ProposalRow[]).reverse()
    const proposals = rows.flatMap(row => {
      const proposal = this.#verifiedProposal(row, scopeKey, cohort)
      if (proposal === undefined) return []
      const decided = this.#database.prepare(`SELECT decision, reason, grant_id, version, replay_json, decided_at
        FROM evaluation_attention_loosening_decisions WHERE proposal_id=?`).get(row.proposal_id) as
        { decision: AttentionLooseningDecision['decision']; reason: string; grant_id: string | null; version: number | null; replay_json: string; decided_at: number } | undefined
      const decision: AttentionLooseningDecision | null = decided === undefined ? null : {
        decision: decided.decision, reason: decided.reason, grantId: decided.grant_id, version: decided.version,
        replay: JSON.parse(decided.replay_json) as AttentionReplaySummary | null, decidedAt: decided.decided_at,
      }
      return [{ proposalId: row.proposal_id, proposal, decision }]
    })
    const questions = (this.#database.prepare(`SELECT question_id, question_json FROM evaluation_attention_owner_questions
      WHERE scope_key=? AND lane=? AND source_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(scopeKey, cohort.lane, cohort.sourceId, limit) as { question_id: string; question_json: string }[]).reverse()
      .map(row => ({ questionId: row.question_id, question: JSON.parse(row.question_json) as AttentionOwnerQuestion }))
    return deepFreeze({ grant, proposals, questions })
  }

  counts(): Readonly<{ versions: number; events: number }> {
    const versions = this.#database.prepare('SELECT COUNT(*) AS count FROM evaluation_attention_tuning_versions').get() as { count: number }
    const events = this.#database.prepare('SELECT COUNT(*) AS count FROM evaluation_attention_tuning_events').get() as { count: number }
    return { versions: versions.count, events: events.count }
  }
}
