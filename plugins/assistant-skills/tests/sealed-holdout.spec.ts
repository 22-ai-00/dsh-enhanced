import { describe, expect, test } from 'vitest'
import { sealedPlan } from '../src/sealed-holdout.ts'
import type { SkillComparisonProfile } from '../src/comparison.ts'
import { syntheticCgroupRoots, syntheticLinuxRuntime } from './helpers/native-holdout-fixture.ts'

const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp/work', preset: 'primary' }
const profile: SkillComparisonProfile = { id: 'sealed', version: 1, scope, stateRoot: '/tmp/state', backend: 'linux-native', runtime: syntheticLinuxRuntime('/tmp/state'), cgroupRoots: syntheticCgroupRoots(), command: 'true', artifactPath: 'out', expiresAt: Date.now() + 60000, maxComparisons: 1, repeats: 2, cellDurationMs: 2000, verificationDurationMs: 1000, maxToolCalls: 1, maxBytes: 1024, maxOutputBytes: 1024, minimumEvaluationGain: 0.1, dataset: { id: 'sealed-holdout', version: '1', digest: 'b'.repeat(64), split: 'holdout' as const }, cases: ['replay', 'evaluation', 'regression'].map(kind => ({ id: kind, kind: kind as 'replay' | 'evaluation' | 'regression', inputs: {}, files: [], stdin: '', expectedStdout: '', expectedExitCode: 0 })) }

describe('sealed holdout binding', () => {
  test('accepts only a Host provider attestation and does not treat a caller sealed flag as proof', () => {
    const provider = { generation: 'host-generation', read: () => ({ profile, attestationDigest: 'b'.repeat(64) }) }
    expect(sealedPlan(provider, 'plan-1', scope).bindingDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(() => sealedPlan({ generation: 'x', read: () => ({ profile, attestationDigest: 'sealed=true' }) }, 'plan-1', scope)).toThrow(/sealed holdout plan unavailable/)
    expect(() => sealedPlan({ generation: '', read: () => ({ profile, attestationDigest: 'b'.repeat(64) }) }, 'plan-1', scope)).toThrow(/provider unavailable/)
    // Host attestation never exempts the sealed plan from split proof.
    const { dataset: _dataset, ...withoutSplit } = profile
    expect(() => sealedPlan({ generation: 'host-generation', read: () => ({ profile: withoutSplit as never, attestationDigest: 'b'.repeat(64) }) }, 'plan-1', scope))
      .toThrow(/sealed holdout plan requires a proven benchmark split/)
  })
})
