import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptanceCanonicalJson,
  acceptanceDigest,
  goalDefinitionSituation,
} from '@dsh-enhanced/task-acceptance-contract'
import { GoalStrategyStore } from '../plugins/assistant-goals/lib/strategy-store.js'
import { EvolutionStore } from '../plugins/assistant-evolution/lib/store.js'
import { canonicalEvolutionScope } from '../plugins/assistant-evolution/lib/service.js'
import {
  joinStrategyLearningObservations,
  toStrategyAdviceSignal,
} from '../plugins/assistant-evolution/lib/strategy-learning.js'

/**
 * Real two-database, read-only strategy-learning join (G2 phase 2).
 *
 * The goals ledger and the evolution ledger are separate SQLite files with
 * non-isomorphic scope keys, so the correlation can only happen in the
 * application layer, here played by the host/recovery adapter:
 *   - goals side:    acceptanceCanonicalJson(GoalScope) (5 identity fields)
 *   - evolution side: canonicalEvolutionScope(workspace, preset)
 * The two are joined only by the content-bound situation
 * `goal-definition:<acceptanceDigest({objective})>`, never by a structural
 * goal id. No writes cross between the stores; this test only reads.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`))
  roots.push(root)
  return root
}

const scope = {
  principalId: 'owner',
  principalRecordId: 'owner-row',
  principalVersion: 1,
  workspace: '/workspace',
  preset: 'default',
}
const evolutionScopeKey = canonicalEvolutionScope(scope.workspace, scope.preset)

const intentBase = {
  parentRunId: 'run-a',
  parentSessionId: 'session-parent',
  definitionVersion: 1,
  kind: 'investigate' as const,
  provider: 'provider',
  model: 'model-id',
  maxChildren: 2,
  maxDurationMs: 300_000,
}

const completedChild = {
  stopReason: 'complete' as const,
  quiescent: true,
  diagnostics: { toolRejections: 0, output: 'accepted' as const },
}

function settleAdvice(
  store: GoalStrategyStore,
  input: {
    id: string
    goalId: string
    definitionDigest: string
    requestDigest: string
    outputDigest: string
    createdAt: number
    completedAt: number
  },
): void {
  store.prepare({
    ...intentBase,
    id: input.id,
    goalId: input.goalId,
    definitionDigest: input.definitionDigest,
    scope,
    requestDigest: input.requestDigest,
    createdAt: input.createdAt,
    expiresAt: input.createdAt + 300_000,
  })
  store.dispatch(input.id, 1, input.createdAt + 1)
  store.bindChild(input.id, 2, `child-${input.id}`, input.createdAt + 2)
  store.settle(
    input.id,
    3,
    {
      children: [{ sessionId: `child-${input.id}`, ...completedChild }],
      outcome: 'advice',
      outputDigest: input.outputDigest,
      quiescent: true,
      terminationReason: 'completed',
    },
    input.completedAt,
  )
}

function trustedGoalOutcomeEpisode(
  store: EvolutionStore,
  situationValue: string,
  outcome: 'succeeded' | 'failed',
  index: number,
): void {
  const subjectRef = JSON.stringify(['evaluation-outcome', situationValue, index])
  const digest = createHash('sha256')
    .update(JSON.stringify({ scopeKey: evolutionScopeKey, subjectRef, situation: situationValue, outcome }))
    .digest('hex')
  store.applyTaskLearningProjection({
    scopeKey: evolutionScopeKey,
    scopeWatermark: index,
    subjectKind: 'goal-outcome',
    subjectRef,
    version: 1,
    digest,
    disposition: 'upsert',
    situation: situationValue,
    outcome,
    detail: `authoritative evaluation outcome ${index}`,
    evidenceRef: `evaluation:${situationValue}:${index}`,
    occurredAt: 1_000 + index,
  })
}

describe('read-only strategy-learning join across the real goals and evolution databases', () => {
  it('correlates repeated settled advice with trusted failures only by content-bound situation', () => {
    // Sanity: the two scopes really are non-isomorphic strings. The host maps
    // workspace/preset between them; the stores never share a scope key.
    expect(evolutionScopeKey).not.toBe(acceptanceCanonicalJson(scope))

    const goalsRoot = tempRoot('strategy-learning-goals')
    const goals = new GoalStrategyStore(join(goalsRoot, 'strategy.sqlite'))
    const evolutionRoot = tempRoot('strategy-learning-evolution')
    const evolution = new EvolutionStore({ path: join(evolutionRoot, 'evolution.sqlite') })

    // Same objective content on both sides: the digest is really derived from
    // the objective, not a shared synthetic structural id.
    const objectiveA = 'Draft the weekly sales summary from the CRM export.'
    const digestA = acceptanceDigest({ objective: objectiveA })
    const situationA = goalDefinitionSituation(digestA)
    const objectiveB = 'Refresh the quarterly forecast assumptions.'
    const digestB = acceptanceDigest({ objective: objectiveB })

    // Definition A: two goal instances, three settled advice runs; the same
    // request digest repeats across all three runs with two distinct outputs
    // (3 runs - 1 distinct request = 2 repeated runs).
    settleAdvice(goals, { id: 's1', goalId: 'goal-1', definitionDigest: digestA, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 1, completedAt: 10 })
    settleAdvice(goals, { id: 's2', goalId: 'goal-2', definitionDigest: digestA, requestDigest: '1'.repeat(64), outputDigest: 'd'.repeat(64), createdAt: 2, completedAt: 20 })
    settleAdvice(goals, { id: 's3', goalId: 'goal-2', definitionDigest: digestA, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 3, completedAt: 30 })
    // Definition B has repeating advice in the goals ledger but no trusted
    // evaluation episode anywhere: advice alone must not create an observation.
    settleAdvice(goals, { id: 's4', goalId: 'goal-3', definitionDigest: digestB, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 4, completedAt: 40 })
    settleAdvice(goals, { id: 's5', goalId: 'goal-3', definitionDigest: digestB, requestDigest: '1'.repeat(64), outputDigest: 'd'.repeat(64), createdAt: 5, completedAt: 50 })

    // Definition A: three authoritative failures projected from Evaluation.
    trustedGoalOutcomeEpisode(evolution, situationA, 'failed', 1)
    trustedGoalOutcomeEpisode(evolution, situationA, 'failed', 2)
    trustedGoalOutcomeEpisode(evolution, situationA, 'failed', 3)

    // Host-side read-only assembly. Each store is queried with its own scope.
    const adviceSummaries = goals.summarizeAdviceByDefinition(scope)
    const advice = adviceSummaries.map(item => toStrategyAdviceSignal(item))
    const episodes = evolution.summarizeGoalDefinitionEpisodes({ scopeKey: evolutionScopeKey, window: 100 })

    const observations = joinStrategyLearningObservations({
      episodes,
      advice,
      minTrustedEpisodes: 3,
      minRepeatedAdviceRuns: 2,
    })

    // Advice-only definition B is absent; only the ledger-backed situation A shows.
    expect(observations.map(item => item.situation)).toEqual([situationA])
    const observation = observations[0]!
    expect(observation.definitionDigest).toBe(digestA)
    expect(observation.episodes).toEqual({ trusted: 3, failures: 3, succeeded: 0, failureRate: 1, lastOccurredAt: 1_003 })
    expect(observation.advice).toEqual({ goalInstances: 2, adviceRuns: 3, distinctRequests: 1, repeatedAdviceRuns: 2 })
    expect(observation.repeatedAndFailing).toBe(true)
    expect(observation.observationDigest).toMatch(/^[a-f0-9]{64}$/u)

    goals.close()
    evolution.close()
  })

  it('reports trusted episodes with no matching advice as non-repeating and never invents advice', () => {
    const goalsRoot = tempRoot('strategy-learning-goals')
    const goals = new GoalStrategyStore(join(goalsRoot, 'strategy.sqlite'))
    const evolutionRoot = tempRoot('strategy-learning-evolution')
    const evolution = new EvolutionStore({ path: join(evolutionRoot, 'evolution.sqlite') })

    const digestC = acceptanceDigest({ objective: 'An objective with trusted outcomes but no strategy advice.' })
    const situationC = goalDefinitionSituation(digestC)
    trustedGoalOutcomeEpisode(evolution, situationC, 'failed', 1)
    trustedGoalOutcomeEpisode(evolution, situationC, 'succeeded', 2)
    // Goals ledger has advice for a different definition only.
    const otherDigest = acceptanceDigest({ objective: 'Unrelated objective.' })
    settleAdvice(goals, { id: 't1', goalId: 'goal-7', definitionDigest: otherDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 1, completedAt: 10 })

    const observations = joinStrategyLearningObservations({
      episodes: evolution.summarizeGoalDefinitionEpisodes({ scopeKey: evolutionScopeKey, window: 100 }),
      advice: goals.summarizeAdviceByDefinition(scope).map(item => toStrategyAdviceSignal(item)),
      minTrustedEpisodes: 2,
      minRepeatedAdviceRuns: 1,
    })

    expect(observations.map(item => item.situation)).toEqual([situationC])
    expect(observations[0]!.advice).toEqual({ goalInstances: 0, adviceRuns: 0, distinctRequests: 0, repeatedAdviceRuns: 0 })
    expect(observations[0]!.repeatedAndFailing).toBe(false)

    goals.close()
    evolution.close()
  })
})
