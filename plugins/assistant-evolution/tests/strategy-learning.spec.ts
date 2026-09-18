import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionStore } from '../src/store.ts'
import {
  isGoalDefinitionSituation,
  joinStrategyLearningObservations,
  toStrategyAdviceSignal,
} from '../src/strategy-learning.ts'

const roots: string[] = []
const scopeKey = JSON.stringify(['/work/alpha', 'primary'])
const digest = (letter: string): string => letter.repeat(64)
const situation = (letter: string): string => `goal-definition:${digest(letter)}`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function openStore(now: () => number = () => 1_000): EvolutionStore {
  const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-strategy-learning-'))
  roots.push(root)
  return new EvolutionStore({ path: join(root, 'evolution.sqlite'), now })
}

/**
 * Appends through the production task-learning projection path, so every row
 * used here is genuinely trusted and learning-eligible (not raw SQL).
 */
function trustedEpisode(
  target: EvolutionStore,
  situationValue: string,
  outcome: 'succeeded' | 'failed',
  index: number,
  occurredAt = 1_000 + index,
): void {
  const subjectRef = JSON.stringify(['evaluation-outcome', situationValue, index])
  const valueDigest = createHash('sha256')
    .update(JSON.stringify({ scopeKey, subjectRef, situation: situationValue, outcome }))
    .digest('hex')
  target.applyTaskLearningProjection({
    scopeKey,
    scopeWatermark: index,
    subjectKind: 'goal-outcome',
    subjectRef,
    version: 1,
    digest: valueDigest,
    disposition: 'upsert',
    situation: situationValue,
    outcome,
    detail: `attempt ${index}`,
    evidenceRef: `evaluation:${situationValue}:${index}`,
    occurredAt,
  })
}

describe('EvolutionStore.summarizeGoalDefinitionEpisodes', () => {
  it('aggregates only trusted learning-eligible goal-definition episodes', () => {
    const target = openStore()
    trustedEpisode(target, situation('a'), 'failed', 1)
    trustedEpisode(target, situation('a'), 'failed', 2)
    trustedEpisode(target, situation('a'), 'succeeded', 3)
    trustedEpisode(target, situation('b'), 'failed', 4)
    // A trusted episode under an unrelated situation shape must not appear.
    trustedEpisode(target, 'plain:weekly-report', 'failed', 5)
    // A self-reported operational row is not learning-eligible and must be ignored.
    target.recordEpisode({
      idempotencyKey: 'self-reported-a',
      scopeKey,
      situation: situation('a'),
      outcome: 'failed',
      detail: 'model claimed failure without verification',
      source: 'foreground',
      trust: 'self-reported',
      evidenceKind: 'operational',
      occurredAt: 999,
    })

    const summaries = target.summarizeGoalDefinitionEpisodes({ scopeKey, window: 100 })
    const bySituation = new Map(summaries.map(item => [item.situation, item]))
    expect([...bySituation.keys()].sort()).toEqual([situation('a'), situation('b')])
    expect(bySituation.get(situation('a'))).toEqual({
      situation: situation('a'),
      failures: 2,
      succeeded: 1,
      total: 3,
      lastOccurredAt: 1_003,
    })
    expect(bySituation.get(situation('b'))).toMatchObject({ failures: 1, total: 1 })
    target.close()
  })

  it('respects the recent window and validates its arguments', () => {
    const target = openStore()
    trustedEpisode(target, situation('a'), 'failed', 1, 1_001)
    trustedEpisode(target, situation('a'), 'failed', 2, 1_002)
    trustedEpisode(target, situation('a'), 'succeeded', 3, 1_003)
    expect(target.summarizeGoalDefinitionEpisodes({ scopeKey, window: 2 }))
      .toMatchObject([{ situation: situation('a'), failures: 1, succeeded: 1, total: 2, lastOccurredAt: 1_003 }])
    expect(() => target.summarizeGoalDefinitionEpisodes({ scopeKey, window: 0 })).toThrow(/window/u)
    expect(() => target.summarizeGoalDefinitionEpisodes({ scopeKey, window: 100, limit: 201 })).toThrow(/limit/u)
    expect(target.summarizeGoalDefinitionEpisodes({ scopeKey: JSON.stringify(['/other', 'primary']), window: 100 }))
      .toEqual([])
    target.close()
  })
})

describe('joinStrategyLearningObservations', () => {
  it('emits observations only for trusted-episode situations and marks repeated failures', () => {
    const result = joinStrategyLearningObservations({
      episodes: [
        { situation: situation('a'), failures: 3, succeeded: 0, total: 3, lastOccurredAt: 1_030 },
        { situation: situation('b'), failures: 1, succeeded: 2, total: 3, lastOccurredAt: 1_020 },
        { situation: situation('c'), failures: 2, succeeded: 0, total: 2, lastOccurredAt: 1_010 },
      ],
      advice: [
        toStrategyAdviceSignal({ situation: situation('a'), goalInstances: 2, adviceRuns: 4, distinctRequests: 1 }),
        toStrategyAdviceSignal({ situation: situation('b'), goalInstances: 2, adviceRuns: 2, distinctRequests: 2 }),
      ],
      minTrustedEpisodes: 3,
      minRepeatedAdviceRuns: 2,
    })
    // Situation c is below the trusted-episode floor; b meets it but advice never repeats.
    expect(result.map(item => item.situation)).toEqual([situation('a'), situation('b')])
    const a = result[0]!
    expect(a.definitionDigest).toBe(digest('a'))
    expect(a.episodes).toEqual({ trusted: 3, failures: 3, succeeded: 0, failureRate: 1, lastOccurredAt: 1_030 })
    expect(a.advice).toEqual({ goalInstances: 2, adviceRuns: 4, distinctRequests: 1, repeatedAdviceRuns: 3 })
    expect(a.repeatedAndFailing).toBe(true)
    expect(a.observationDigest).toMatch(/^[a-f0-9]{64}$/u)
    const b = result[1]!
    expect(b.repeatedAndFailing).toBe(false)
    expect(b.advice.repeatedAdviceRuns).toBe(0)
  })

  it('never manufactures an observation from advice alone and tolerates absent advice', () => {
    const result = joinStrategyLearningObservations({
      episodes: [
        { situation: situation('a'), failures: 4, succeeded: 0, total: 4, lastOccurredAt: 1_000 },
      ],
      advice: [
        // Trusted episodes have no situation 'b', so this can never appear.
        toStrategyAdviceSignal({ situation: situation('b'), goalInstances: 9, adviceRuns: 9, distinctRequests: 1 }),
      ],
      minTrustedEpisodes: 1,
      minRepeatedAdviceRuns: 1,
    })
    expect(result.map(item => item.situation)).toEqual([situation('a')])
    expect(result[0]!.advice).toEqual({ goalInstances: 0, adviceRuns: 0, distinctRequests: 0, repeatedAdviceRuns: 0 })
    expect(result[0]!.repeatedAndFailing).toBe(false)
  })

  it('digests identical inputs identically and advice-only input changes the digest', () => {
    const input = {
      episodes: [
        { situation: situation('a'), failures: 2, succeeded: 0, total: 2, lastOccurredAt: 1_000 } as const,
      ],
      advice: [
        toStrategyAdviceSignal({ situation: situation('a'), goalInstances: 1, adviceRuns: 2, distinctRequests: 1 }),
      ],
      minTrustedEpisodes: 1,
      minRepeatedAdviceRuns: 1,
    }
    const first = joinStrategyLearningObservations(input)
    const second = joinStrategyLearningObservations({ ...input, advice: [...input.advice] })
    expect(first[0]!.observationDigest).toBe(second[0]!.observationDigest)
    const changed = joinStrategyLearningObservations({
      ...input,
      advice: [
        toStrategyAdviceSignal({ situation: situation('a'), goalInstances: 1, adviceRuns: 3, distinctRequests: 1 }),
      ],
    })
    expect(changed[0]!.observationDigest).not.toBe(first[0]!.observationDigest)
  })

  it('rejects malformed situations and inconsistent counts', () => {
    expect(isGoalDefinitionSituation(situation('a'))).toBe(true)
    expect(isGoalDefinitionSituation('goal:g1:definition:1')).toBe(false)
    expect(isGoalDefinitionSituation('goal-definition:xyz')).toBe(false)
    expect(() => joinStrategyLearningObservations({
      episodes: [{ situation: 'goal-definition:short', failures: 1, succeeded: 0, total: 1, lastOccurredAt: 1 }],
      advice: [],
      minTrustedEpisodes: 1,
      minRepeatedAdviceRuns: 1,
    })).toThrow(TypeError)
    expect(() => joinStrategyLearningObservations({
      episodes: [{ situation: situation('a'), failures: 1, succeeded: 1, total: 3, lastOccurredAt: 1 }],
      advice: [],
      minTrustedEpisodes: 1,
      minRepeatedAdviceRuns: 1,
    })).toThrow(/inconsistent counts/u)
    expect(() => toStrategyAdviceSignal({ situation: situation('a'), goalInstances: 3, adviceRuns: 2, distinctRequests: 1 }))
      .toThrow(/inconsistent counts/u)
    expect(() => toStrategyAdviceSignal({ situation: situation('a'), goalInstances: 1, adviceRuns: 2, distinctRequests: 3 }))
      .toThrow(/inconsistent counts/u)
  })

  it('fails closed on an advice signal whose repeated count breaks the complement identity (engineering-level trust boundary, not real external evidence)', () => {
    // A caller that persisted, deserialized or hand-built a signal can bypass
    // toStrategyAdviceSignal (which derives repeatedAdviceRuns = adviceRuns -
    // distinctRequests).  The join is itself a trust boundary and must reject
    // the impossible 5 runs / 4 distinct / *3* repeated instead of letting an
    // inflated repeated count forge `repeatedAndFailing` adoption evidence.
    const forged = {
      situation: situation('a'),
      goalInstances: 1,
      adviceRuns: 5,
      distinctRequests: 4,
      repeatedAdviceRuns: 3,
    } as unknown as Parameters<typeof joinStrategyLearningObservations>[0]['advice'][number]
    expect(() => joinStrategyLearningObservations({
      episodes: [{ situation: situation('a'), failures: 3, succeeded: 0, total: 3, lastOccurredAt: 1 }],
      advice: [forged],
      minTrustedEpisodes: 3,
      minRepeatedAdviceRuns: 2,
    })).toThrow(/inconsistent counts/u)
    // Sanity: the exact same runs/distinct admitted via the deriving constructor
    // carry the true complement (1), which stays below the repeat floor.
    const sound = toStrategyAdviceSignal({ situation: situation('a'), goalInstances: 1, adviceRuns: 5, distinctRequests: 4 })
    expect(sound.repeatedAdviceRuns).toBe(1)
  })

  it('joins store-produced episode aggregates with goals-shaped advice summaries end to end', () => {
    const target = openStore()
    trustedEpisode(target, situation('a'), 'failed', 1)
    trustedEpisode(target, situation('a'), 'failed', 2)
    trustedEpisode(target, situation('a'), 'failed', 3)
    const episodes = [...target.summarizeGoalDefinitionEpisodes({ scopeKey, window: 100 })]
    // Structurally mirrors StrategyAdviceDefinitionSummary from assistant-goals;
    // the learning core never imports the execution plugin.
    const goalsSummary = {
      situation: situation('a'),
      definitionDigest: digest('a'),
      goalInstances: 2,
      adviceRuns: 3,
      distinctRequests: 1,
      requests: [],
    }
    const observations = joinStrategyLearningObservations({
      episodes,
      advice: [toStrategyAdviceSignal(goalsSummary)],
      minTrustedEpisodes: 3,
      minRepeatedAdviceRuns: 2,
    })
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      situation: situation('a'),
      repeatedAndFailing: true,
      episodes: { trusted: 3, failures: 3, failureRate: 1 },
      advice: { adviceRuns: 3, distinctRequests: 1, repeatedAdviceRuns: 2 },
    })
    target.close()
  })
})
