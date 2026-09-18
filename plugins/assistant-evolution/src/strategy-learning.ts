import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { isGoalDefinitionSituation } from './types.js'
import type { GoalDefinitionEpisodeSummary } from './types.js'

export { isGoalDefinitionSituation }
export type { GoalDefinitionEpisodeSummary }

/**
 * Phase-2 (G2) read-only strategy-learning projection.
 *
 * This module is deliberately a *pure observation kernel*: it correlates, for
 * one content-bound goal definition, (a) the repetition of strategy advice
 * recorded by assistant-goals with (b) the trusted failure episodes recorded in
 * the evolution ledger. It performs no writes, mints no candidates and never
 * widens permissions. Turning a repeated-and-failing observation into an
 * `evolution_propose` draft is a later phase and still requires owner adopt.
 *
 * The advice side is supplied through a narrow structural port rather than by
 * importing assistant-goals, so the learning core does not gain a dependency on
 * the execution plugin (and cannot reach into its authority).
 */

/** Content-bound situation shape is validated via isGoalDefinitionSituation. */

function natural(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError('strategy-learning observation contains an invalid count')
  }
  return value
}

/**
 * Narrow advice signal the learning core needs. The host derives this from
 * assistant-goals' read-only advice summary. Only hashes and counts cross the
 * seam — advice plaintext is never available here.
 */
export interface StrategyAdviceSignal {
  /** `goal-definition:<definitionDigest>`. */
  situation: string
  /** Distinct goal instances whose settled advice is covered. */
  goalInstances: number
  /** Settled advice runs across those instances. */
  adviceRuns: number
  /** Distinct advice request digests seen. */
  distinctRequests: number
  /**
   * Advice runs that repeated a request digest already seen for this
   * definition (`adviceRuns - distinctRequests`, floored at zero).
   */
  repeatedAdviceRuns: number
}

/**
 * One correlated, read-only observation. `repeatedAndFailing` is a descriptive
 * flag for an operator or a later, owner-gated draft generator; it is never an
 * instruction and never causes a write by itself.
 */
export interface StrategyLearningObservation {
  situation: string
  definitionDigest: string
  episodes: Readonly<{
    trusted: number
    failures: number
    succeeded: number
    failureRate: number
    lastOccurredAt: number
  }>
  advice: Readonly<{
    goalInstances: number
    adviceRuns: number
    distinctRequests: number
    repeatedAdviceRuns: number
  }>
  /** True when trusted failures meet the floor and the same advice keeps recurring. */
  repeatedAndFailing: boolean
  /**
   * Digest over the exact correlated inputs, so a host runbook can prove the
   * observation it acted on and a later draft cannot silently rewrite history.
   */
  observationDigest: string
}

export interface StrategyLearningJoinInput {
  /** Trusted goal-definition episode aggregates, authoritative for outcome. */
  episodes: readonly GoalDefinitionEpisodeSummary[]
  /** Advice repetition supplied by the host through the narrow port. */
  advice: readonly StrategyAdviceSignal[]
  /** Minimum trusted episodes before a situation is worth reporting. */
  minTrustedEpisodes: number
  /** Minimum repeated advice runs before advice counts as recurring. */
  minRepeatedAdviceRuns: number
}

function assertSituation(situation: unknown): string {
  if (!isGoalDefinitionSituation(situation)) {
    throw new TypeError('strategy-learning observation has an invalid goal-definition situation')
  }
  return situation
}

/**
 * Narrow a goals-side advice summary to the structural learning port. The
 * input is structural (no import of assistant-goals); repeated runs are derived
 * here rather than trusted from the caller. Throws on inconsistent counts.
 */
export function toStrategyAdviceSignal(input: {
  situation: string
  goalInstances: number
  adviceRuns: number
  distinctRequests: number
}): StrategyAdviceSignal {
  const situation = assertSituation(input?.situation)
  const goalInstances = natural(input.goalInstances, 1_000_000)
  const adviceRuns = natural(input.adviceRuns, 1_000_000)
  const distinctRequests = natural(input.distinctRequests, 1_000_000)
  if (distinctRequests > adviceRuns || goalInstances > adviceRuns
    || (adviceRuns > 0 && goalInstances < 1)) {
    throw new TypeError('strategy-learning advice signal has inconsistent counts')
  }
  return Object.freeze({
    situation,
    goalInstances,
    adviceRuns,
    distinctRequests,
    repeatedAdviceRuns: adviceRuns - distinctRequests,
  })
}

/**
 * Correlate trusted episodes with advice repetition.
 *
 * Only situations present in the trusted episode ledger can be emitted: advice
 * repetition alone, with no authoritative outcome, is never learning evidence
 * and must not be able to manufacture an observation. Pure and deterministic.
 */
export function joinStrategyLearningObservations(input: StrategyLearningJoinInput):
  readonly StrategyLearningObservation[] {
  const minTrusted = natural(input.minTrustedEpisodes, 1_000_000)
  const minRepeated = natural(input.minRepeatedAdviceRuns, 1_000_000)
  if (!Array.isArray(input.episodes) || !Array.isArray(input.advice)) {
    throw new TypeError('strategy-learning join requires episodes and advice arrays')
  }

  const adviceBySituation = new Map<string, StrategyAdviceSignal>()
  for (const signal of input.advice) {
    const situation = assertSituation(signal?.situation)
    const goalInstances = natural(signal.goalInstances, 1_000_000)
    const adviceRuns = natural(signal.adviceRuns, 1_000_000)
    const distinctRequests = natural(signal.distinctRequests, 1_000_000)
    const repeatedAdviceRuns = natural(signal.repeatedAdviceRuns, 1_000_000)
    // The join is a trust boundary: revalidate every count independently rather
    // than trusting a signal object a caller persisted, deserialized or built
    // without toStrategyAdviceSignal.  repeatedAdviceRuns is the sole driver of
    // `repeatedAndFailing`, so it must satisfy the exact complement identity
    // that constructor derives (adviceRuns - distinctRequests); a loose upper
    // bound alone would accept an impossible count (e.g. 5 runs / 4 distinct /
    // 3 repeated) and forge recurring-advice evidence into the adoption gate.
    if (distinctRequests > adviceRuns || repeatedAdviceRuns > adviceRuns
      || repeatedAdviceRuns !== adviceRuns - distinctRequests
      || goalInstances > adviceRuns || (adviceRuns > 0 && goalInstances < 1)) {
      throw new TypeError('strategy-learning advice signal has inconsistent counts')
    }
    if (adviceBySituation.has(situation)) {
      throw new TypeError(`duplicate advice signal for situation ${situation}`)
    }
    adviceBySituation.set(situation, Object.freeze({
      situation, goalInstances, adviceRuns, distinctRequests, repeatedAdviceRuns,
    }))
  }

  const seen = new Set<string>()
  const observations: StrategyLearningObservation[] = []
  for (const summary of input.episodes) {
    const situation = assertSituation(summary?.situation)
    if (seen.has(situation)) {
      throw new TypeError(`duplicate episode summary for situation ${situation}`)
    }
    seen.add(situation)
    const failures = natural(summary.failures, 1_000_000_000)
    const succeeded = natural(summary.succeeded, 1_000_000_000)
    const total = natural(summary.total, 1_000_000_000)
    const lastOccurredAt = natural(summary.lastOccurredAt, Number.MAX_SAFE_INTEGER)
    if (failures + succeeded !== total || total < 1) {
      throw new TypeError('strategy-learning episode summary has inconsistent counts')
    }
    if (total < minTrusted) continue

    const adviceSignal = adviceBySituation.get(situation)
    const repeatedAdviceRuns = adviceSignal?.repeatedAdviceRuns ?? 0
    const repeatedAndFailing = failures >= 1 && total >= minTrusted
      && repeatedAdviceRuns >= minRepeated
    const definitionDigest = situation.slice('goal-definition:'.length)
    const episodes = Object.freeze({
      trusted: total,
      failures,
      succeeded,
      failureRate: total === 0 ? 0 : failures / total,
      lastOccurredAt,
    })
    const advice = Object.freeze({
      goalInstances: adviceSignal?.goalInstances ?? 0,
      adviceRuns: adviceSignal?.adviceRuns ?? 0,
      distinctRequests: adviceSignal?.distinctRequests ?? 0,
      repeatedAdviceRuns,
    })
    const observationDigest = acceptanceDigest({
      kind: 'strategy-learning-observation/v1',
      situation,
      episodes: { failures, succeeded, total, lastOccurredAt },
      advice: adviceSignal === undefined
        ? null
        : {
          goalInstances: adviceSignal.goalInstances,
          adviceRuns: adviceSignal.adviceRuns,
          distinctRequests: adviceSignal.distinctRequests,
          repeatedAdviceRuns: adviceSignal.repeatedAdviceRuns,
        },
    })
    observations.push(Object.freeze({
      situation,
      definitionDigest,
      episodes,
      advice,
      repeatedAndFailing,
      observationDigest,
    }))
  }
  return Object.freeze(observations)
}
