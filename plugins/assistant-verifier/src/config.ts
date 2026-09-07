import Schema from '@deepseek-ai/schemastery'
import { acceptanceCanonicalJson, acceptanceDigest, acceptanceProtocolForTask, createTaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { AcceptanceTaskIdentity, TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { AcceptanceTask } from './host.js'
import { createVerifierAuthorities } from './drivers.js'
import type { VerifierAuthority, VerifierAuthorityInput } from './drivers.js'

/** A Host-owned exact task specification; editing it cannot rewrite accepted work. */
export interface AcceptanceProfile extends Omit<AcceptanceTask, 'task'> {
  readonly id: string
  readonly version: number
  readonly taskKind: AcceptanceTaskIdentity['kind']
  readonly criteria: TaskAcceptanceContract['criteria']
  readonly validityMs: number
  readonly bounds: TaskAcceptanceContract['bounds']
}

export interface Config {
  databasePath: string
  authorities?: readonly VerifierAuthorityInput[]
  profiles?: readonly AcceptanceProfile[]
  tickIntervalMs?: number
  requireAcceptance?: boolean
}

export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().required(),
  authorities: Schema.array(Schema.any()).default([]),
  profiles: Schema.array(Schema.any()).default([]),
  tickIntervalMs: Schema.number().step(1).min(0).max(60_000).default(5_000),
  requireAcceptance: Schema.boolean().default(false),
}) as Schema<Config>

export interface CompiledAcceptanceProfile {
  readonly profile: AcceptanceProfile
  readonly digest: string
}

export function compileAcceptanceProfiles(config: Config): Readonly<{
  authorities: readonly VerifierAuthority[]
  profiles: readonly CompiledAcceptanceProfile[]
}> {
  const authorities = config.authorities === undefined || config.authorities.length === 0
    ? Object.freeze([]) : createVerifierAuthorities({ authorities: config.authorities })
  const inputs = config.profiles ?? []
  if (!Array.isArray(inputs) || inputs.length > 64) throw new Error('assistant-verifier: profiles must be a bounded array')
  const ids = new Set<string>()
  const matches = new Set<string>()
  const profiles = inputs.map(input => {
    // The wire validator rejects accessors, extra keys, invalid paths, bytes and criteria.
    const allowed = ['id', 'version', 'scope', 'owner', 'objective', 'taskKind', 'criteria', 'validityMs', 'bounds'].sort()
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Reflect.ownKeys(input).some(key => typeof key !== 'string')
      || Object.getOwnPropertyNames(input).sort().join(',') !== allowed.join(',')
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(property => !property.enumerable || !('value' in property))) {
      throw new Error('assistant-verifier: invalid acceptance profile shape')
    }
    const digest = acceptanceDigest(input)
    const task: AcceptanceTaskIdentity = input.taskKind === 'goal-outcome'
      ? { kind: 'goal-outcome', ref: 'profile-validation', goal: {
          id: 'profile-validation-goal', definitionVersion: 1, definitionDigest: '0'.repeat(64),
          assessmentId: 'profile-validation', sessionId: 'profile-validation-session', nativeGoalId: 'profile-validation-native-goal',
        } }
      : input.taskKind === 'goal-step'
      ? { kind: 'goal-step', ref: 'profile-validation', goal: {
          id: 'profile-validation-goal', definitionVersion: 1,
          definitionDigest: '0'.repeat(64), stepId: 'profile-validation-step', runId: 'profile-validation',
          sessionId: 'profile-validation-session', nativeGoalId: 'profile-validation-native-goal', nativeRevision: 1,
        } }
      : { kind: input.taskKind, ref: 'profile-validation' }
    const contract = createTaskAcceptanceContract({ protocol: acceptanceProtocolForTask(task, input.criteria), id: 'profile-validation',
      scope: input.scope, owner: input.owner, task,
      objective: input.objective, profile: { id: input.id, version: input.version, digest },
      criteria: input.criteria, issuedAt: 0, expiresAt: input.validityMs, bounds: input.bounds })
    if (input.validityMs <= input.bounds.maxDurationMs) throw new Error('assistant-verifier: profile validity must exceed verification duration')
    const match = acceptanceCanonicalJson([contract.scope, contract.owner, contract.task.kind, contract.objective])
    if (ids.has(input.id) || matches.has(match)) throw new Error('assistant-verifier: duplicate profile id or exact task match')
    ids.add(input.id); matches.add(match)
    for (const criterion of contract.criteria) {
      const authority = authorities.find(item => item.id === criterion.authority.id && item.digest === criterion.authority.digest)
      const expected = criterion.kind === 'isolated-process-behavior' ? 'isolated-runner' : criterion.kind === 'process-behavior' ? 'runner' : criterion.kind === 'document-citations' ? 'document' : 'readback'
      if (authority?.kind !== expected) throw new Error('assistant-verifier: acceptance profile authority is unavailable or changed')
      if (criterion.kind === 'isolated-process-behavior' && authority.kind === 'isolated-runner'
        && !authority.testSets.some(set => set.id === criterion.testSetId)) throw new Error('assistant-verifier: isolated test set unavailable')
    }
    const profile: AcceptanceProfile = Object.freeze({ id: contract.profile.id, version: contract.profile.version,
      scope: contract.scope, owner: contract.owner, objective: contract.objective, taskKind: contract.task.kind,
      criteria: contract.criteria, validityMs: input.validityMs, bounds: contract.bounds })
    return Object.freeze({ profile, digest })
  })
  return Object.freeze({ authorities, profiles: Object.freeze(profiles) })
}
