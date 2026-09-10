import { describe, expect, it } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { assertGoalDependenciesAchieved, goalDependencies } from '../src/dependency.ts'
import type { GoalOutcomeView } from '../src/outcome.ts'
import type { GoalRecord } from '../src/types.ts'

const scope = { principalId: 'owner-a', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'primary' }

function record(id: string, objective: string, changes: Partial<GoalRecord> = {}): GoalRecord {
  const definition = { version: 1, digest: acceptanceDigest({ objective }), objective }
  return {
    id, scope, originalObjective: objective, definition,
    native: { sessionId: `session-${id}`, goalId: `native-${id}`, revision: 1, objective, phase: 'complete', roundsStarted: 1, maxGoalRounds: 2, updatedAt: 1 },
    checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] },
    version: 1, createdAt: 1, updatedAt: 1, ...changes,
  }
}

function dependent(dependency: GoalRecord): GoalRecord {
  const parent = record('parent', 'Ship only after the prerequisite')
  return { ...parent, checkpoint: { ...parent.checkpoint, dependencies: [dependency.id], dependencyBindings: [{
    goalId: dependency.id, definitionVersion: dependency.definition.version, definitionDigest: dependency.definition.digest,
  }] } }
}

describe('dependency-aware goal gating', () => {
  it('permits only the exact independently achieved definition and returns an immutable status view', () => {
    const dependency = record('dependency', 'Publish the verified artifact')
    const parent = dependent(dependency)
    const view = goalDependencies(parent, {
      get: (_scope, goalId) => goalId === dependency.id ? dependency : undefined,
      outcome: () => ({ status: 'achieved', definitionVersion: 1, nativeCompletion: 'complete' }),
    })

    expect(view).toEqual([{ goalId: dependency.id, definitionVersion: 1, definitionDigest: dependency.definition.digest, status: 'achieved', nativePhase: 'complete' }])
    expect(Object.isFrozen(view)).toBe(true)
    expect(() => assertGoalDependenciesAchieved(parent, {
      get: () => dependency,
      outcome: () => ({ status: 'achieved', definitionVersion: 1, nativeCompletion: 'complete' }),
    })).not.toThrow()
  })

  it.each([
    ['pending', { status: 'pending', definitionVersion: 1 }],
    ['pending', { status: 'unverified', definitionVersion: 1 }],
    ['failed', { status: 'not-achieved', definitionVersion: 1 }],
    ['unknown', { status: 'unknown', definitionVersion: 1 }],
    ['unknown', { status: 'unavailable', definitionVersion: 1 }],
    ['unknown', { status: 'expired', definitionVersion: 1 }],
  ] as const)('blocks an exact dependency whose independent outcome resolves to %s from %j', (status, outcome) => {
    const dependency = record('dependency', 'Publish the verified artifact')
    const parent = dependent(dependency)
    const ports = { get: () => dependency, outcome: () => outcome as GoalOutcomeView }

    expect(goalDependencies(parent, ports)).toMatchObject([{ goalId: dependency.id, status, nativePhase: 'complete' }])
    expect(() => assertGoalDependenciesAchieved(parent, ports)).toThrow('exact independently achieved dependencies are required')
  })

  it.each([
    ['cleared', (dependency: GoalRecord) => ({ ...dependency, native: { ...dependency.native, phase: 'cleared' as const } })],
    ['unknown', () => undefined],
    ['stale', (dependency: GoalRecord) => {
      const objective = 'Edited after the parent checkpoint'
      return { ...dependency, definition: { version: 2, digest: acceptanceDigest({ objective }), objective }, native: { ...dependency.native, objective } }
    }],
  ] as const)('blocks a %s dependency before consulting its outcome', (status, current) => {
    const dependency = record('dependency', 'Publish the verified artifact')
    const parent = dependent(dependency)
    let outcomeReads = 0
    const ports = { get: () => current(dependency), outcome: () => { outcomeReads += 1; return { status: 'achieved', definitionVersion: 1, nativeCompletion: 'complete' } as GoalOutcomeView } }

    expect(goalDependencies(parent, ports)).toMatchObject([{ goalId: dependency.id, status }])
    expect(outcomeReads).toBe(0)
    expect(() => assertGoalDependenciesAchieved(parent, ports)).toThrow('exact independently achieved dependencies are required')
  })

  it('treats a legacy ID-only checkpoint as unresolved without looking up or upgrading its identity', () => {
    const dependency = record('dependency', 'Publish the verified artifact')
    const current = dependent(dependency)
    const { dependencyBindings: _binding, ...legacyCheckpoint } = current.checkpoint
    const parent: GoalRecord = { ...current, checkpoint: legacyCheckpoint }
    let reads = 0
    const ports = { get: () => { reads += 1; return dependency }, outcome: () => ({ status: 'achieved', definitionVersion: 1, nativeCompletion: 'complete' } as GoalOutcomeView) }

    expect(goalDependencies(parent, ports)).toEqual([{ goalId: dependency.id, status: 'stale', reason: 'legacy-unbound' }])
    expect(reads).toBe(0)
    expect(() => assertGoalDependenciesAchieved(parent, ports)).toThrow('exact independently achieved dependencies are required')
  })

  it('treats a missing outcome service and a receipt for another definition as unknown', () => {
    const dependency = record('dependency', 'Publish the verified artifact')
    const parent = dependent(dependency)
    expect(goalDependencies(parent, { get: () => dependency, outcome: () => undefined }))
      .toMatchObject([{ status: 'unknown' }])
    expect(goalDependencies(parent, { get: () => dependency, outcome: () => ({
      status: 'achieved', definitionVersion: 2, nativeCompletion: 'complete',
    }) })).toMatchObject([{ status: 'unknown' }])
  })
})
