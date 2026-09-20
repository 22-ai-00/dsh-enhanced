import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import type { SkillDefinition } from './definition.js'
import type { SkillDelegatedArmBinding, StoredSkillDefinition } from './store.js'

/** Host discovery is not an import or execution authority. */
export interface BenchmarkArmSelection {
  readonly scope: GoalScope
  readonly ownerRouteId: string
  readonly skillName: string
  readonly version: number
  readonly candidateId?: string
}
export interface BenchmarkArmSnapshot {
  readonly definition: SkillDefinition
  readonly definitionDigest: string
  readonly sourceDigest: string
  readonly version: number
  readonly expiresAt: number
}
/** Opaque, process-local, single-recipient authority; JSON copies are invalid. */
export interface BenchmarkArmCapability { readonly protocol: 'assistant-skills/benchmark-capability/v1' }
export interface BenchmarkArmMount {
  readonly binding: SkillDelegatedArmBinding
  readonly bindingDigest: string
  readonly skill: { readonly name: string; readonly version: number; readonly inputs: SkillDefinition['inputs'] }
  dispose(): void
}

export function benchmarkArmDefinition(value: SkillDefinition): SkillDefinition {
  // Stored version/timestamp fields are not part of the frozen executable arm.
  const { protocol, name, description, source, inputs, steps, preconditions, compensation, fileObservations, runExpansions } = value
  return structuredClone({ protocol, name, description, source, inputs, steps, preconditions, compensation,
    ...(fileObservations === undefined ? {} : { fileObservations }), ...(runExpansions === undefined ? {} : { runExpansions }) })
}

export interface LiveBenchmarkArm {
  readonly binding: SkillDelegatedArmBinding
  readonly bindingDigest: string
  readonly skill: StoredSkillDefinition
  readonly scope: GoalScope
  readonly signal: AbortSignal
  revoke(): void
  assertCurrent(): void
  refresh(signal: AbortSignal): Promise<void>
}

export function sameBenchmarkArm(left: BenchmarkArmSnapshot, right: BenchmarkArmSnapshot): boolean {
  return acceptanceDigest(left) === acceptanceDigest(right)
}

/** Bound waiting and suppress late results; abort is not proof that external work stopped. */
export function awaitBenchmarkSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('assistant-skills: benchmark cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort() }
  })
}
