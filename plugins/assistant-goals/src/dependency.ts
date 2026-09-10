import type { GoalDependencyView, GoalRecord, GoalScope } from './types.js'
import type { GoalOutcomeView } from './outcome.js'

interface DependencyPorts {
  get(scope: GoalScope, goalId: string): GoalRecord | undefined
  outcome(record: GoalRecord): GoalOutcomeView | undefined
}

const freeze = <T>(value: T): Readonly<T> => Object.freeze(JSON.parse(JSON.stringify(value)) as T)

/** Resolve Host-frozen dependency identities without treating native complete as success. */
export function goalDependencies(record: GoalRecord, ports: DependencyPorts): readonly GoalDependencyView[] {
  const bindings = record.checkpoint.dependencyBindings
  if (bindings === undefined) {
    return freeze(record.checkpoint.dependencies.map(goalId => ({ goalId, status: 'stale' as const, reason: 'legacy-unbound' as const })))
  }
  return freeze(bindings.map(binding => {
    const current = ports.get(record.scope, binding.goalId)
    if (current === undefined) return { ...binding, status: 'unknown' as const }
    if (current.native.phase === 'cleared') return { ...binding, status: 'cleared' as const, nativePhase: current.native.phase }
    if (current.definition.version !== binding.definitionVersion || current.definition.digest !== binding.definitionDigest) {
      return { ...binding, status: 'stale' as const, reason: 'definition-changed' as const, nativePhase: current.native.phase }
    }
    const outcome = ports.outcome(current)
    const status = outcome === undefined ? 'unknown' as const
      : outcome.definitionVersion !== binding.definitionVersion ? 'unknown' as const
      : outcome.status === 'achieved' && outcome.nativeCompletion === 'complete' && current.native.phase === 'complete'
      ? 'achieved' as const
      : outcome.status === 'not-achieved' ? 'failed' as const
        : outcome.status === 'unknown' || outcome.status === 'unavailable' || outcome.status === 'expired'
          ? 'unknown' as const : 'pending' as const
    return { ...binding, status, nativePhase: current.native.phase }
  }))
}

export function assertGoalDependenciesAchieved(record: GoalRecord, ports: DependencyPorts): void {
  const dependencies = goalDependencies(record, ports)
  if (dependencies.some(item => item.status !== 'achieved')) {
    throw new Error('assistant-goals: exact independently achieved dependencies are required')
  }
}
