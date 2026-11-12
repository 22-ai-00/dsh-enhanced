import { describe, expect, it, vi } from 'vitest'

// Simulate a present-but-stale optional Evaluation peer (module loads, expected
// export missing): version skew must normalize to the same readable fail-closed
// reason instead of a TypeError.
vi.mock('@dsh-enhanced/assistant-evaluation/benchmark', () => ({}))

const { assertCandidateGenerationOrigin } = await import('../src/growth-agent.ts')

describe('candidate generation guard under peer version skew', () => {
  it('fails closed with the readable unavailable reason', async () => {
    await expect(assertCandidateGenerationOrigin({ benchmarkPlan: {} as never }))
      .rejects.toThrow(/benchmark holdout guard is unavailable; refusing to generate candidates/u)
  })
})
