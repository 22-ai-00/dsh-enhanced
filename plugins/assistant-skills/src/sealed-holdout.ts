import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import type { SkillComparisonProfile } from './comparison.js'
import { validateComparisonProfiles } from './comparison.js'

/** Host-only sealed plan. It is deliberately not a plugin configuration or model tool argument. */
export interface SealedSkillHoldoutProvider {
  readonly generation: string
  read(input: Readonly<{ planId: string; scope: GoalScope }>): Readonly<{ profile: SkillComparisonProfile; attestationDigest: string }> | undefined
}

export function sealedPlan(provider: SealedSkillHoldoutProvider, planId: string, scope: GoalScope) {
  if (!provider || typeof provider.generation !== 'string' || !provider.generation || typeof provider.read !== 'function' || typeof planId !== 'string' || !planId) throw new Error('assistant-skills: sealed holdout provider unavailable')
  const value = provider.read({ planId, scope })
  if (!value || typeof value.attestationDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.attestationDigest)) throw new Error('assistant-skills: sealed holdout plan unavailable')
  const profile = validateComparisonProfiles([value.profile])[0]!
  return Object.freeze({ profile, profileDigest: acceptanceDigest(profile), attestationDigest: value.attestationDigest, bindingDigest: acceptanceDigest({ generation: provider.generation, planId, scope, profileDigest: acceptanceDigest(profile), attestationDigest: value.attestationDigest }) })
}
