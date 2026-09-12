import { describe, expect, test } from 'vitest'
import type { ExternalHoldoutProfile } from '../src/external-holdout.ts'
import { validateRepairProfiles } from '../src/repair-profile.ts'

const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp/repair-workspace', preset: 'primary' }
const template = { protocol: 'assistant-skills/canary-admission-template/v1' as const, skillName: 'repair-skill', taskFamily: { goalDefinitionDigest: 'a'.repeat(64), outcomeProfile: { id: 'outcome', version: 1, digest: 'b'.repeat(64) } } }
function holdout(overrides: Record<string, unknown> = {}): ExternalHoldoutProfile {
  return { id: 'repair-holdout', scope, authority: { generatorDigest: 'c'.repeat(64) }, canaryAdmissionTemplate: template, ...overrides } as unknown as ExternalHoldoutProfile
}
function profile(overrides: Record<string, unknown> = {}) {
  return { id: 'repair', scope, skillName: 'repair-skill', taskFamilyId: 'repair-family', description: 'Repair the saved skill after a verified failure.', bindings: [{ name: 'message', stepId: 'step', path: '/data' }], externalHoldoutProfileId: 'repair-holdout', provider: 'provider', model: 'model', allowedTools: ['read', 'write'], maxGoalRounds: 2, maxModelCalls: 4, maxToolCalls: 8, maxOutputTokens: 1024, maxDurationMs: 30_000, canaryRuns: 1, maxCanaryRuns: 2, ...overrides }
}

describe('repair continuation profile configuration', () => {
  test('accepts only an exact scoped prospective holdout template and snapshots configuration', () => {
    const input = profile(), saved = validateRepairProfiles([input], [holdout()])
    ;(input.allowedTools as string[]).push('edit'); (input.bindings![0] as { path: string }).path = '/mutated'
    expect(saved).toEqual([expect.objectContaining({ id: 'repair', allowedTools: ['read', 'write'], bindings: [{ name: 'message', stepId: 'step', path: '/data' }] })])
    expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved[0])).toBe(true)
    expect(() => validateRepairProfiles([profile()], [holdout({ scope: { ...scope, preset: 'other' } })])).toThrow(/scoped prospective holdout template/)
    expect(() => validateRepairProfiles([profile()], [holdout({ canaryAdmissionTemplate: { ...template, skillName: 'other' } })])).toThrow(/scoped prospective holdout template/)
    expect(() => validateRepairProfiles([profile()], [holdout({ authority: { generatorDigest: undefined } })])).toThrow(/scoped prospective holdout template/)
  })

  test.each([
    ['goal rounds', { maxGoalRounds: 33 }], ['model calls', { maxModelCalls: 0 }], ['tool calls', { maxToolCalls: 513 }],
    ['output tokens', { maxOutputTokens: 65_537 }], ['duration', { maxDurationMs: 999 }], ['canary count', { canaryRuns: 33 }], ['canary ordering', { canaryRuns: 3, maxCanaryRuns: 2 }],
  ])('rejects non-finite %s bounds', (_label, override) => {
    expect(() => validateRepairProfiles([profile(override)], [holdout()])).toThrow(/invalid repair profile/)
  })

  test.each(['skill_run', 'skill_repair_arm', 'goal_create', 'goal_control', 'set_goal', 'update_goal'])('blocks repair-model authority %s', tool => {
    expect(() => validateRepairProfiles([profile({ allowedTools: ['read', tool] })], [holdout()])).toThrow(/tool authority exceeds fixed scope/)
  })

  test('rejects unknown fields, duplicate scoped ids, and invalid bindings', () => {
    expect(() => validateRepairProfiles([{ ...profile(), injected: true }], [holdout()])).toThrow(/invalid repair profile/)
    expect(() => validateRepairProfiles([profile(), profile()], [holdout()])).toThrow(/duplicate repair profile/)
    expect(() => validateRepairProfiles([profile({ bindings: [{ name: 'x', stepId: 'step', path: '/x', extra: true }] })], [holdout()])).toThrow(/invalid repair bindings/)
    expect(() => validateRepairProfiles([profile({ scope: { ...scope, unknown: true } })], [holdout()])).toThrow(/invalid repair profile/)
  })
})
