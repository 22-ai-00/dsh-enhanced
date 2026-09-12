import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { describe, expect, test } from 'vitest'
import type { SkillDefinition } from '../src/definition.ts'
import { materializeCanaryAdmission, validateCanaryAdmissionTemplate } from '../src/repair-admission.ts'

const definition = (name: string, goalDigest: string, marker: string) => ({ name, marker, source: { goal: { definition: { digest: goalDigest } } } }) as unknown as SkillDefinition
const template = { protocol: 'assistant-skills/canary-admission-template/v1' as const, skillName: 'repair-skill', taskFamily: { goalDefinitionDigest: 'a'.repeat(64), outcomeProfile: { id: 'outcome', version: 1, digest: 'b'.repeat(64) } } }

describe('repair canary admission template', () => {
  test('strictly rejects parent or candidate fields and materializes exact captured digests', () => {
    expect(() => validateCanaryAdmissionTemplate({ ...template, candidateDefinitionDigest: 'c'.repeat(64) })).toThrow(/invalid canary admission template/)
    expect(() => validateCanaryAdmissionTemplate({ ...template, taskFamily: { ...template.taskFamily, extra: true } })).toThrow(/invalid canary admission template/)
    const parent = definition('repair-skill', 'a'.repeat(64), 'parent'), candidate = definition('repair-skill', 'a'.repeat(64), 'candidate')
    const admission = materializeCanaryAdmission(template, parent, candidate)
    expect(admission).toEqual({ protocol: 'assistant-skills/canary-admission/v1', skillName: 'repair-skill', parentDefinitionDigest: acceptanceDigest(parent), candidateDefinitionDigest: acceptanceDigest(candidate), taskFamily: template.taskFamily })
    expect(Object.isFrozen(admission)).toBe(true)
  })

  test('requires the configured task family and skill name to match captured definitions', () => {
    expect(() => materializeCanaryAdmission(template, definition('other', 'a'.repeat(64), 'parent'), definition('other', 'a'.repeat(64), 'candidate'))).toThrow(/does not match/)
    expect(() => materializeCanaryAdmission(template, definition('repair-skill', 'c'.repeat(64), 'parent'), definition('repair-skill', 'c'.repeat(64), 'candidate'))).toThrow(/does not match/)
  })
})
