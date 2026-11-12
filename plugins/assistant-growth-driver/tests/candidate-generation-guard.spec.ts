import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { parseBenchmarkPlan } from '@dsh-enhanced/assistant-evaluation/benchmark'
import type { BenchmarkPlan } from '@dsh-enhanced/assistant-evaluation/benchmark'
import { assertCandidateGenerationOrigin, runGrowthAgent } from '../src/growth-agent.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const versions = Object.fromEntries(['model', 'prompt', 'skills', 'tools', 'policy', 'runtime'].map(key => [key, sha(key)]))
const features = { memory: false, planning: false, review: false, growth: false }
function plan(split: 'development' | 'holdout', id = 'candidate-input'): BenchmarkPlan {
  return parseBenchmarkPlan({ schemaVersion: 1, id,
    dataset: { id: 'dsh-candidate-input', version: '1', digest: sha('candidate-input'), split },
    comparison: 'capability',
    cases: [{ id: 'case-1', domain: 'code', inputDigest: sha('input'), acceptanceDigest: sha('acceptance') }],
    variants: [{ id: 'baseline', role: 'baseline', versions: { ...versions }, features: { ...features } },
      { id: 'candidate', role: 'candidate', versions: { ...versions }, features: { ...features } }],
    budget: { durationMs: 1000, inputTokens: 0, outputTokens: 0, costUsdMicros: 0, toolCalls: 1 },
    repeats: 2, seed: 1 })
}
const ordinaryFeedback = { protocol: 'assistant-delivery/owner-foreground-learning/v1' } as never
const unknownFeedback = { protocol: 'assistant-growth/unknown-benchmark-source' } as never
const input = (extra: object) => ({ wakeId: 'guard-wake', authority: {} as never, config: {} as never,
  model: {} as never, goals: {} as never, skills: {} as never, ...extra })

describe('candidate generation holdout guard', () => {
  it('allows ordinary owner-task evidence and a development benchmark plan', async () => {
    await expect(assertCandidateGenerationOrigin({ feedback: ordinaryFeedback })).resolves.toBeUndefined()
    await expect(assertCandidateGenerationOrigin({ feedback: undefined })).resolves.toBeUndefined()
    await expect(assertCandidateGenerationOrigin({ feedback: ordinaryFeedback, benchmarkPlan: plan('development') })).resolves.toBeUndefined()
  })

  it('rejects a holdout plan before an Agent or candidate write exists', async () => {
    const stageCandidate = vi.fn()
    await expect(runGrowthAgent({} as never, input({ feedback: ordinaryFeedback, benchmarkPlan: plan('holdout'),
      skills: { stageCandidate } }) as never)).rejects.toThrow(/holdout data must never be used for candidate generation/u)
    // The guard runs before ctx/goals/skills are touched at all.
    expect(stageCandidate).not.toHaveBeenCalled()
  })

  it('fails closed for evidence without a proven origin before any candidate write', async () => {
    await expect(runGrowthAgent({} as never, input({ feedback: unknownFeedback }) as never))
      .rejects.toThrow(/no proven development origin/u)
  })
})
