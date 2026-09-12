import { isAbsolute } from 'node:path'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { ExternalHoldoutProfile } from './external-holdout.js'
import type { SkillBinding } from './definition.js'

/** Operator configuration. Owner tools select an id; they cannot supply code or evaluator inputs. */
export interface RepairContinuationProfile {
  id: string
  scope: GoalScope
  skillName: string
  taskFamilyId: string
  description: string
  bindings?: readonly SkillBinding[]
  externalHoldoutProfileId: string
  provider: string
  model: string
  allowedTools: readonly string[]
  maxGoalRounds: number
  maxModelCalls: number
  maxToolCalls: number
  maxOutputTokens: number
  maxDurationMs: number
  canaryRuns: number
  maxCanaryRuns: number
  maxIterations?: number
  followupProfileIds?: readonly string[]
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const integer = (value: unknown, min: number, max: number): boolean => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max

export function validateRepairProfiles(values: unknown, holdouts: readonly ExternalHoldoutProfile[]): readonly RepairContinuationProfile[] {
  if (!Array.isArray(values) || values.length > 32) throw new Error('assistant-skills: invalid repair profiles')
  const allowed = ['id', 'scope', 'skillName', 'taskFamilyId', 'description', 'bindings', 'externalHoldoutProfileId', 'provider', 'model', 'allowedTools', 'maxGoalRounds', 'maxModelCalls', 'maxToolCalls', 'maxOutputTokens', 'maxDurationMs', 'canaryRuns', 'maxCanaryRuns', 'maxIterations', 'followupProfileIds']
  const profiles = values.map((value: unknown) => {
    if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || !plain(value.scope)
      || Object.keys(value.scope).sort().join(',') !== 'preset,principalId,principalRecordId,principalVersion,workspace'
      || !bounded(value.scope.principalId, 4096) || !bounded(value.scope.principalRecordId, 4096) || !integer(value.scope.principalVersion, 1, Number.MAX_SAFE_INTEGER)
      || !bounded(value.scope.workspace, 4096) || !isAbsolute(value.scope.workspace) || !bounded(value.scope.preset, 4096)
      || !bounded(value.id, 128) || !bounded(value.taskFamilyId, 128) || !bounded(value.description, 4096)
      || !bounded(value.skillName, 64) || !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.skillName)
      || !bounded(value.provider, 256) || !bounded(value.model, 256) || !bounded(value.externalHoldoutProfileId, 128)
      || !Array.isArray(value.allowedTools) || value.allowedTools.length < 1 || value.allowedTools.length > 32
      || value.allowedTools.some(tool => !bounded(tool, 128) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(tool))
      || new Set(value.allowedTools).size !== value.allowedTools.length
      || !integer(value.maxGoalRounds, 1, 32) || !integer(value.maxModelCalls, 1, 128) || !integer(value.maxToolCalls, 1, 512)
      || !integer(value.maxOutputTokens, 1, 65536) || !integer(value.maxDurationMs, 1000, 300000)
      || !integer(value.canaryRuns, 1, 32) || !integer(value.maxCanaryRuns, Number(value.canaryRuns), 100)
      || value.maxIterations !== undefined && !integer(value.maxIterations, 1, 4)
      || value.followupProfileIds !== undefined && (!Array.isArray(value.followupProfileIds) || value.followupProfileIds.length > (Number(value.maxIterations ?? 1) - 1)
        || value.followupProfileIds.some(id => !bounded(id, 128)) || new Set(value.followupProfileIds).size !== value.followupProfileIds.length)) throw new Error('assistant-skills: invalid repair profile')
    // The repair model cannot mint goals, authorize continuations, or promote itself.
    if (value.allowedTools.some(tool => /^(?:skill_|goal_create$|goal_control$|set_goal$|update_goal$)/u.test(tool))) throw new Error('assistant-skills: repair tool authority exceeds fixed scope')
    if (value.bindings !== undefined && (!Array.isArray(value.bindings) || value.bindings.length > 32 || value.bindings.some(binding => !plain(binding)
      || Object.keys(binding).sort().join(',') !== 'name,path,stepId' || !bounded(binding.name, 128) || !bounded(binding.stepId, 128) || !bounded(binding.path, 1024)))) throw new Error('assistant-skills: invalid repair bindings')
    const holdout = holdouts.find(item => item.id === value.externalHoldoutProfileId && acceptanceDigest(item.scope) === acceptanceDigest(value.scope))
    if (!holdout?.authority.generatorDigest || !holdout.canaryAdmissionTemplate || holdout.canaryAdmissionTemplate.skillName !== value.skillName) throw new Error('assistant-skills: repair requires a scoped prospective holdout template')
    return { ...structuredClone(value), maxIterations: value.maxIterations ?? 1 } as unknown as RepairContinuationProfile
  })
  if (new Set(profiles.map(value => acceptanceDigest([value.scope, value.id]))).size !== profiles.length) throw new Error('assistant-skills: duplicate repair profile')
  for (const profile of profiles) for (const id of profile.followupProfileIds ?? []) {
    const next = profiles.find(value => value.id === id && acceptanceDigest(value.scope) === acceptanceDigest(profile.scope))
    if (!next || next.id === profile.id) throw new Error('assistant-skills: invalid repair followup profile')
  }
  return Object.freeze(profiles.map(value => Object.freeze(value)))
}
