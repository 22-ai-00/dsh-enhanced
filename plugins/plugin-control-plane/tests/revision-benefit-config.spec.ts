import { describe, expect, test } from 'vitest'
import { revisionBenefitContractDigest, type RevisionBenefitContract } from '@dsh-enhanced/assistant-growth-contract'
import { validateSourceJobsConfig } from '../src/source-jobs.js'
import type { SourceJobsConfig } from '../src/source-job-types.js'

const build = { dockerPath: '/usr/bin/docker', image: `example@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
  memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 } as const

const base: SourceJobsConfig = {
  authorityId: 'source-authority', expiresAt: Date.now() + 60_000, maxSubmissions: 2,
  repository: '/tmp/repository', ownerRouteId: 'route', principalId: 'principal',
  workspace: '/tmp/workspace', preset: 'primary', budgetId: 'budget', budgetAmount: 1,
}

const contract = (): RevisionBenefitContract => ({
  protocol: 'assistant-growth/revision-benefit-contract/v1',
  model: { provider: 'p', model: 'm' }, budget: { budgetId: 'budget', amount: 1 },
  minimumTaskRevisions: 3,
  thresholds: { maxFailureRateDelta: 0.05, maxReworkRateDelta: 0.1, maxCorrectionRateDelta: 0.1,
    maxLatencyRatio: 1.5, maxCostRatio: 1.5 },
  createdAt: 1_000, expiresAt: 2_000,
})

describe('source jobs revisionBenefit configuration', () => {
  test('rejects unknown config fields including benefit config with no grant pin', () => {
    expect(() => validateSourceJobsConfig({ ...base, unknown: true } as never, build)).toThrow()
    expect(() => validateSourceJobsConfig({ ...base, revisionBenefit: contract() }, build)).toThrow()
  })

  test('accepts a matching grant pin and rejects a digest mismatch', () => {
    const digest = revisionBenefitContractDigest(contract())
    const revision = {
      id: 'owner-revision-1', expiresAt: Date.now() + 60_000, maxRevisions: 2,
      namePrefix: 'rsi-created-', benefit: { contractDigest: digest },
    }
    expect(() => validateSourceJobsConfig({ ...base, revision, revisionBenefit: contract() }, build)).not.toThrow()
    const mismatched = { ...revision, benefit: { contractDigest: 'b'.repeat(64) } }
    expect(() => validateSourceJobsConfig({ ...base, revision: mismatched, revisionBenefit: contract() }, build)).toThrow()
  })
})
