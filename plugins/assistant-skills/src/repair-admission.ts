import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { SkillDefinition } from './definition.js'
import { validateCanaryAdmission, type CanaryAdmission } from './holdout-qualification.js'

export interface CanaryAdmissionTemplate {
  readonly protocol: 'assistant-skills/canary-admission-template/v1'
  readonly skillName: string
  readonly taskFamily: CanaryAdmission['taskFamily']
}

const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)

/** Strictly validate the configured, parent-agnostic repair admission template. */
export function validateCanaryAdmissionTemplate(value: unknown): asserts value is CanaryAdmissionTemplate {
  if (!plain(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'protocol') || !Object.hasOwn(value, 'skillName') || !Object.hasOwn(value, 'taskFamily')
    || value.protocol !== 'assistant-skills/canary-admission-template/v1' || typeof value.skillName !== 'string' || !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.skillName)
    || !plain(value.taskFamily) || Object.keys(value.taskFamily).length !== 2 || !hex(value.taskFamily.goalDefinitionDigest)
    || !plain(value.taskFamily.outcomeProfile) || Object.keys(value.taskFamily.outcomeProfile).length !== 3
    || typeof value.taskFamily.outcomeProfile.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.taskFamily.outcomeProfile.id)
    || !Number.isSafeInteger(value.taskFamily.outcomeProfile.version) || (value.taskFamily.outcomeProfile.version as number) < 1 || !hex(value.taskFamily.outcomeProfile.digest)) throw new Error('assistant-skills: invalid canary admission template')
}

export function materializeCanaryAdmission(template: CanaryAdmissionTemplate, parent: SkillDefinition, candidate: SkillDefinition): CanaryAdmission {
  validateCanaryAdmissionTemplate(template)
  const admission: CanaryAdmission = { protocol: 'assistant-skills/canary-admission/v1', skillName: template.skillName,
    parentDefinitionDigest: acceptanceDigest(parent), candidateDefinitionDigest: acceptanceDigest(candidate), taskFamily: template.taskFamily }
  validateCanaryAdmission(admission)
  if (admission.skillName !== parent.name || admission.skillName !== candidate.name || admission.taskFamily.goalDefinitionDigest !== candidate.source.goal.definition.digest) throw new Error('assistant-skills: repair admission does not match exact definitions')
  return Object.freeze(admission)
}
