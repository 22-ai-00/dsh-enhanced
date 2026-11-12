import { describe, expect, it, vi } from 'vitest'

// Simulate an installation that omitted the optional Evaluation peer: the
// guard must fail closed with a readable reason instead of crashing at module load.
vi.mock('@dsh-enhanced/assistant-evaluation/benchmark', () => {
  throw new Error('evaluation benchmark module unavailable')
})

const { assertCandidateGenerationOrigin } = await import('../src/growth-agent.ts')

describe('candidate generation guard when Evaluation is unavailable', () => {
  it('rejects with a readable fail-closed reason before any candidate work', async () => {
    await expect(assertCandidateGenerationOrigin({ benchmarkPlan: {} as never }))
      .rejects.toThrow(/benchmark holdout guard is unavailable; refusing to generate candidates/u)
  })
})
