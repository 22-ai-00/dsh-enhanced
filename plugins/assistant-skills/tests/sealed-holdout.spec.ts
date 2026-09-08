import { describe, expect, test } from 'vitest'
import { sealedPlan } from '../src/sealed-holdout.ts'
import type { SkillComparisonProfile } from '../src/comparison.ts'

const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp/work', preset: 'primary' }
const profile: SkillComparisonProfile = { id: 'sealed', version: 1, scope, stateRoot: '/tmp/state', image: `sha256:${'a'.repeat(64)}`, dockerPath: '/usr/bin/docker', command: 'true', artifactPath: 'out', expiresAt: Date.now() + 60000, maxComparisons: 1, repeats: 2, cellDurationMs: 2000, verificationDurationMs: 1000, maxToolCalls: 1, maxBytes: 1024, maxOutputBytes: 1024, minimumEvaluationGain: 0.1, cases: ['replay', 'evaluation', 'regression'].map(kind => ({ id: kind, kind: kind as 'replay' | 'evaluation' | 'regression', inputs: {}, files: [], stdin: '', expectedStdout: '', expectedExitCode: 0 })) }

describe('sealed holdout binding', () => {
  test('accepts only a Host provider attestation and does not treat a caller sealed flag as proof', () => {
    const provider = { generation: 'host-generation', read: () => ({ profile, attestationDigest: 'b'.repeat(64) }) }
    expect(sealedPlan(provider, 'plan-1', scope).bindingDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(() => sealedPlan({ generation: 'x', read: () => ({ profile, attestationDigest: 'sealed=true' }) }, 'plan-1', scope)).toThrow(/sealed holdout plan unavailable/)
    expect(() => sealedPlan({ generation: '', read: () => ({ profile, attestationDigest: 'b'.repeat(64) }) }, 'plan-1', scope)).toThrow(/provider unavailable/)
  })
})
