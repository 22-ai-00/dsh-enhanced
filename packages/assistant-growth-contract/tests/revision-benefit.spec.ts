import { describe, expect, test } from 'vitest'
import { evaluateRevisionBenefit, revisionBenefitContractDigest,
  validateRevisionBenefitContract, validateRevisionBenefitWindowStats,
  type RevisionBenefitContract, type RevisionBenefitWindowStats } from '../src/revision-benefit.ts'

const CONTRACT: RevisionBenefitContract = {
  protocol: 'assistant-growth/revision-benefit-contract/v1',
  model: { provider: 'p', model: 'm' },
  budget: { budgetId: 'b', amount: 10 },
  minimumTaskRevisions: 3,
  thresholds: {
    maxFailureRateDelta: 0.05, maxReworkRateDelta: 0.1, maxCorrectionRateDelta: 0.1,
    maxLatencyRatio: 1.5, maxCostRatio: 1.5,
  },
  createdAt: 1_000, expiresAt: 2_000,
}

function window(overrides: Partial<RevisionBenefitWindowStats> = {}): RevisionBenefitWindowStats {
  return {
    protocol: 'assistant-growth/revision-benefit-window/v1', artifactSha256: 'a'.repeat(64),
    windowStart: 0, windowEnd: 100, taskRevisions: 10, correctedOrWithdrawn: 0,
    failed: 1, reworked: 1, latencyMsTotal: 1_000, tokensTotal: 500,
    inputTokensTotal: 300, outputTokensTotal: 200, ...overrides,
  }
}

describe('revision benefit evaluation', () => {
  test('equal windows are non-inferior once both windows meet the minimum sample', () => {
    const result = evaluateRevisionBenefit(CONTRACT, window(), window(), 1_500)
    expect(result.verdict).toEqual({ status: 'non-inferior', reason: 'all-metrics-within-thresholds' })
  })

  test('sample-short or expired windows stay insufficient without a quality claim', () => {
    expect(evaluateRevisionBenefit(CONTRACT, window({ taskRevisions: 2 }), window(), 1_500).verdict)
      .toEqual({ status: 'insufficient', reason: 'below-minimum-samples' })
    expect(evaluateRevisionBenefit(CONTRACT, window(), window(), 2_000).verdict)
      .toEqual({ status: 'insufficient', reason: 'contract-expired' })
  })

  test('excluded corrections shrink the included set and can flip insufficiency', () => {
    // 10 revisions with 8 corrected leaves 2 included: below the minimum of 3.
    expect(evaluateRevisionBenefit(CONTRACT, window({ correctedOrWithdrawn: 8 }), window(), 1_500).verdict)
      .toEqual({ status: 'insufficient', reason: 'below-minimum-samples' })
  })

  test('each threshold violation names its metric', () => {
    expect(evaluateRevisionBenefit(CONTRACT, window(), window({ failed: 3 }), 1_500).verdict)
      .toEqual({ status: 'inferior', reason: 'failure-rate' })
    expect(evaluateRevisionBenefit(CONTRACT, window(), window({ reworked: 3 }), 1_500).verdict)
      .toEqual({ status: 'inferior', reason: 'rework-rate' })
    expect(evaluateRevisionBenefit(CONTRACT, window({ correctedOrWithdrawn: 1 }), window({ correctedOrWithdrawn: 3 }), 1_500).verdict)
      .toEqual({ status: 'inferior', reason: 'correction-rate' })
    expect(evaluateRevisionBenefit(CONTRACT, window(), window({ latencyMsTotal: 10_000 }), 1_500).verdict)
      .toEqual({ status: 'inferior', reason: 'latency' })
    expect(evaluateRevisionBenefit(CONTRACT, window(), window({ tokensTotal: 5_000 }), 1_500).verdict)
      .toEqual({ status: 'inferior', reason: 'cost' })
  })

  test('latency and cost ratios stay capped at their configured thresholds', () => {
    // Exactly at 1.5x the parent mean remains non-inferior.
    expect(evaluateRevisionBenefit(CONTRACT, window(), window({ latencyMsTotal: 1_500 }), 1_500).verdict.status).toBe('non-inferior')
    expect(evaluateRevisionBenefit(CONTRACT, window(), window({ latencyMsTotal: 1_600 }), 1_500).verdict)
      .toEqual({ status: 'inferior', reason: 'latency' })
    expect(evaluateRevisionBenefit(CONTRACT, window(), window({ tokensTotal: 750 }), 1_500).verdict.status).toBe('non-inferior')
  })

  test('structural validators reject tampered windows and contracts', () => {
    expect(() => validateRevisionBenefitWindowStats(window({ artifactSha256: 'zz' }))).toThrow()
    expect(() => validateRevisionBenefitWindowStats(window({ failed: 99 }))).toThrow()
    expect(() => validateRevisionBenefitContract({ ...CONTRACT, protocol: 'other' })).toThrow()
    expect(() => validateRevisionBenefitContract({ ...CONTRACT, thresholds: { ...CONTRACT.thresholds, maxLatencyRatio: 0.5 } })).toThrow()
    expect(revisionBenefitContractDigest(CONTRACT)).toMatch(/^[a-f0-9]{64}$/u)
  })
})
