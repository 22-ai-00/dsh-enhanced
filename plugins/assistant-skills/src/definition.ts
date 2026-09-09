import type { VerifiedWorkflowSource } from '@dsh-enhanced/assistant-goals'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
export type { VerifiedWorkflowSource } from '@dsh-enhanced/assistant-goals'

export type SkillScalar = string | number | boolean
export type SkillInputType = 'string' | 'number' | 'boolean'

export interface SkillBinding { name: string; stepId: string; path: string }
export interface SkillInput extends SkillBinding { type: SkillInputType; default: SkillScalar }
export interface SkillStep { id: string; toolName: string; arguments: unknown; dependsOn: readonly string[] }
export interface SkillFileObservations { protocol: 'assistant-skills/file-observations/v1'; beforeSteps: readonly string[] }
export interface SkillRunExpansion {
  protocol: 'assistant-skills/run-expansion/v1'
  callId: string
  runId: string
  runDigest: string
  definitionDigest: string
  inputsDigest: string
  steps: readonly { id: string; toolName: string; arguments: unknown }[]
}
export interface SkillDefinition {
  protocol: 'assistant-skills/definition/v1'
  name: string
  description: string
  source: VerifiedWorkflowSource
  inputs: readonly SkillInput[]
  steps: readonly SkillStep[]
  fileObservations?: SkillFileObservations
  runExpansions?: readonly SkillRunExpansion[]
  preconditions: 'current-owner-policy-and-fresh-goal'
  compensation: 'stop-and-report'
}

export interface CreateDefinitionOptions { name: string; description: string; bindings?: readonly SkillBinding[] }

const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const maximumArgumentsBytes = 256 * 1024

function fail(message = 'assistant-skills: invalid definition'): never { throw new Error(message) }
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{Cc}]/u.test(value)
}
function scalar(value: unknown): value is SkillScalar {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
}
function clone<T>(value: T): T {
  if (!json(value)) fail()
  return JSON.parse(JSON.stringify(value)) as T
}
function json(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !json(descriptor.value)) return false
    }
    return true
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  return Object.keys(value).every(key => {
    if (forbidden.has(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor && json(descriptor.value)
  })
}
function freeze<T>(value: T): Readonly<T> { return Object.freeze(clone(value)) }
function pointer(path: string): string[] {
  if (path === '' || !path.startsWith('/')) fail('assistant-skills: binding path is invalid')
  return path.slice(1).split('/').map(part => {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (decoded === '' || forbidden.has(decoded)) fail('assistant-skills: binding path is invalid')
    return decoded
  })
}
function at(root: unknown, path: string): SkillScalar {
  let current: unknown = root
  for (const part of pointer(path)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(part) || Number(part) >= current.length) fail('assistant-skills: binding path is missing')
      current = current[Number(part)]
    } else if (current && typeof current === 'object' && Object.getPrototypeOf(current) === Object.prototype && Object.hasOwn(current, part)) {
      current = (current as Record<string, unknown>)[part]
    } else fail('assistant-skills: binding path is missing')
  }
  if (!scalar(current)) fail('assistant-skills: binding value must be scalar')
  return current
}
function replace(root: unknown, path: string, value: SkillScalar): void {
  const parts = pointer(path); let current: unknown = root
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(current)) current = current[Number(part)]
    else current = (current as Record<string, unknown>)[part]
  }
  const final = parts.at(-1)!
  if (Array.isArray(current)) current[Number(final)] = value
  else (current as Record<string, unknown>)[final] = value
}
function inputType(value: SkillScalar): SkillInputType {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  return 'boolean'
}
function controlTool(name: string, arguments_: unknown): boolean {
  const normalized = name.toLowerCase()
  // Native get_goal is a parameterless read of the current Goal. It is only
  // reusable when the Host explicitly allowlists it; all other goal controls
  // remain excluded from captured tool compositions.
  if (normalized === 'get_goal') return !arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)
    || Object.getPrototypeOf(arguments_) !== Object.prototype || Object.getOwnPropertySymbols(arguments_).length !== 0 || Object.keys(arguments_).length !== 0
  return normalized.startsWith('goal_') || normalized.startsWith('skill') || normalized.includes('workflow') || normalized.includes('subagent')
    || ['create_goal', 'update_goal', 'run_code', 'javascript'].includes(normalized)
}
function failedProbe(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const observation = value as { id?: unknown; toolName?: unknown; arguments?: unknown; outcome?: unknown }
  if (!text(observation.id, 256) || !text(observation.toolName, 256) || observation.outcome !== 'failed' || !json(observation.arguments)) return false
  if (observation.toolName === 'read' || observation.toolName === 'glob' || observation.toolName === 'grep') return true
  return observation.toolName === 'get_goal' && !controlTool('get_goal', observation.arguments)
}

/** The session-owned todo list is planning provenance, never a reusable action. */
function todoWrite(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  if (!Object.hasOwn(value, 'todos') || Object.keys(value).length !== 1 || !Array.isArray((value as { todos?: unknown }).todos)) return false
  const contents = new Set<string>()
  for (const todo of (value as { todos: unknown[] }).todos) {
    if (!todo || typeof todo !== 'object' || Array.isArray(todo) || Object.getPrototypeOf(todo) !== Object.prototype || Object.getOwnPropertySymbols(todo).length !== 0
      || Object.keys(todo).length !== 2 || !Object.hasOwn(todo, 'content') || !Object.hasOwn(todo, 'status') || typeof (todo as { content?: unknown }).content !== 'string'
      || !['pending', 'in_progress', 'completed'].includes((todo as { status?: unknown }).status as string)) return false
    const content = (todo as { content: string }).content.trim()
    if (!content || contents.has(content)) return false
    contents.add(content)
  }
  return true
}

type TraceStep = { id: string; toolName: string; arguments: unknown }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function validExpansion(value: unknown): value is SkillRunExpansion {
  if (!json(value) || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 7) return false
  const expansion = value as Partial<SkillRunExpansion>
  if (expansion.protocol !== 'assistant-skills/run-expansion/v1' || !text(expansion.callId, 256) || !text(expansion.runId, 256)
    || !digest(expansion.runDigest) || !digest(expansion.definitionDigest) || !digest(expansion.inputsDigest) || !Array.isArray(expansion.steps) || expansion.steps.length === 0 || expansion.steps.length > 32) return false
  const ids = new Set<string>()
  return expansion.steps.every(step => json(step) && step && typeof step === 'object' && !Array.isArray(step) && Object.keys(step).length === 3
    && text((step as TraceStep).id, 256) && text((step as TraceStep).toolName, 256) && json((step as TraceStep).arguments) && !ids.has((step as TraceStep).id) && (ids.add((step as TraceStep).id), true))
}
function expandSkillRuns(sourceSteps: readonly TraceStep[], observations: readonly unknown[], expansions: readonly SkillRunExpansion[]): readonly TraceStep[] {
  if (!Array.isArray(expansions) || expansions.length > 32 || expansions.some(value => !validExpansion(value))) fail('assistant-skills: invalid run expansion')
  const calls = new Map<string, SkillRunExpansion>(); const runs = new Set<string>()
  for (const expansion of expansions) {
    if (calls.has(expansion.callId) || runs.has(expansion.runId)) fail('assistant-skills: invalid run expansion')
    calls.set(expansion.callId, expansion)
    // Stored step IDs belong to a definition and repeat across distinct runs.
    // An idempotent response for the same run is not another execution.
    runs.add(expansion.runId)
  }
  const sourceCalls = new Set(sourceSteps.filter(step => step?.toolName === 'skill_run' && typeof step.id === 'string').map(step => step.id))
  if ([...calls.keys()].some(callId => !sourceCalls.has(callId))) fail('assistant-skills: invalid run expansion')
  const proofBytes = expansions.length === 0 ? [] : [expansions]
  if (Buffer.byteLength(JSON.stringify([...sourceSteps.map(step => step.arguments), ...observations.map(value => (value as { arguments?: unknown }).arguments), ...proofBytes]), 'utf8') > maximumArgumentsBytes) fail('assistant-skills: bounded run expansion is required')
  return sourceSteps.flatMap(step => {
    const expansion = step.toolName === 'skill_run' ? calls.get(step.id) : undefined
    return expansion === undefined ? [step] : expansion.steps.map(expanded => ({ id: `expanded:${acceptanceDigest([expansion.callId, expanded.id])}`, toolName: expanded.toolName, arguments: expanded.arguments }))
  })
}

type StandardFileMutator = { id: string; toolName: 'write' | 'edit'; arguments: Record<string, unknown> }
function standardFileMutators(steps: readonly SkillStep[]): StandardFileMutator[] {
  const output: StandardFileMutator[] = []
  for (const step of steps) {
    if (step.toolName !== 'write' && step.toolName !== 'edit' || !step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)
      || Object.getPrototypeOf(step.arguments) !== Object.prototype || Object.getOwnPropertySymbols(step.arguments).length !== 0) continue
    const args = step.arguments as Record<string, unknown>
    const allowed = step.toolName === 'write' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string', 'replace_all']
    if (Object.keys(args).some(key => !allowed.includes(key)) || !text(args.file_path, 4096)
      || step.toolName === 'write' && typeof args.content !== 'string'
      || step.toolName === 'edit' && (typeof args.old_string !== 'string' || typeof args.new_string !== 'string' || args.replace_all !== undefined && typeof args.replace_all !== 'boolean')) continue
    output.push({ id: step.id, toolName: step.toolName, arguments: args })
  }
  return output
}
function fileObservations(definition: SkillDefinition): readonly StandardFileMutator[] {
  const value = definition.fileObservations
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0
    || Object.keys(value).length !== 2 || value.protocol !== 'assistant-skills/file-observations/v1' || !Array.isArray(value.beforeSteps)
    || value.beforeSteps.some(id => !text(id, 256))) fail('assistant-skills: invalid file observations')
  const mutators = standardFileMutators(definition.steps)
  if (definition.steps.length + value.beforeSteps.length > 32 || value.beforeSteps.length !== mutators.length
    || value.beforeSteps.some((id, index) => id !== mutators[index]?.id) || new Set(value.beforeSteps).size !== value.beforeSteps.length) fail('assistant-skills: invalid file observations')
  if (Buffer.byteLength(JSON.stringify([...definition.steps.map(step => step.arguments), ...mutators.map(step => ({ file_path: step.arguments.file_path, limit: 1 }))]), 'utf8') > maximumArgumentsBytes) fail('assistant-skills: file observations exceed argument limit')
  const observationIds = mutators.map((_step, index) => `file-observation:${index + 1}`)
  if (new Set(definition.steps.map(step => step.id)).size !== definition.steps.length || observationIds.some(id => definition.steps.some(step => step.id === id))) fail('assistant-skills: invalid file observations')
  return mutators
}

/** Derive the native reads which establish file-observation policy state for an instantiated definition. */
export function fileObservationSteps(definition: SkillDefinition): readonly { id: string; beforeStepId: string; filePath: string; allowAbsent: boolean }[] {
  return Object.freeze(fileObservations(definition).map((step, index) => Object.freeze({ id: `file-observation:${index + 1}`, beforeStepId: step.id,
    filePath: step.arguments.file_path as string, allowAbsent: step.toolName === 'write' })))
}

/** Successful source-Goal planning notes are provenance, never reusable authority. */
function sourceCheckpoint(value: unknown, goalId: string): boolean {
  if (!json(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const args = value as Record<string, unknown>
  const keys = ['goal_id', 'expected_version', 'next_step', 'blockers', 'assumptions', 'evidence_refs', 'dependencies']
  const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === 'string')
  return Object.keys(args).length === keys.length && Object.keys(args).every(key => keys.includes(key))
    && args.goal_id === goalId && Number.isSafeInteger(args.expected_version) && (args.expected_version as number) > 0
    && typeof args.next_step === 'string' && strings(args.blockers) && strings(args.evidence_refs) && strings(args.dependencies)
    && Array.isArray(args.assumptions) && args.assumptions.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === 2 && Object.keys(item).every(key => ['statement', 'expires_at'].includes(key))
      && typeof item.statement === 'string' && Number.isSafeInteger(item.expires_at) && item.expires_at > 0)
}

/** Multi-round provenance is explicit; the v1 top-level still names the final accepted run. */
function sourceProjection(source: VerifiedWorkflowSource) {
  if (source.segments === undefined) return { steps: source.steps, observations: source.failedObservations ?? [] }
  const segments = source.segments
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > 32) fail('assistant-skills: invalid source segments')
  const runs = new Set<string>()
  for (const [index, segment] of segments.entries()) {
    if (!segment || !text(segment.runId, 256) || runs.has(segment.runId) || segment.round !== index + 1
      || !Number.isSafeInteger(segment.turn) || segment.turn < 1 || index > 0 && segment.turn <= segments[index - 1]!.turn
      || !Number.isSafeInteger(segment.nativeRevision) || segment.nativeRevision < 0 || !Array.isArray(segment.steps)
      || segment.failedObservations !== undefined && !Array.isArray(segment.failedObservations)) fail('assistant-skills: invalid source segment')
    runs.add(segment.runId)
  }
  const final = segments.at(-1)!
  if (final.runId !== source.runId || final.turn !== source.turn || acceptanceDigest(final.steps) !== acceptanceDigest(source.steps)
    || acceptanceDigest(final.failedObservations ?? []) !== acceptanceDigest(source.failedObservations ?? [])) fail('assistant-skills: final source segment mismatch')
  return { steps: segments.flatMap(segment => segment.steps), observations: segments.flatMap(segment => segment.failedObservations ?? []) }
}

/** Derive a bounded, parameterizable skill only from an independently verified tool trace. */
export function createDefinition(source: VerifiedWorkflowSource, options: CreateDefinitionOptions, allowedTools: readonly string[], expansions: readonly SkillRunExpansion[] = []): Readonly<SkillDefinition> {
  if (!json(source) || !json(options) || !source || source.protocol !== 'assistant-goals/verified-workflow-source/v1' || !Array.isArray(source.steps) || source.steps.length === 0 || source.steps.length > 32
    || !options || !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(options.name) || !text(options.description, 512)
    || !Array.isArray(allowedTools) || allowedTools.some(tool => !text(tool, 256))) fail()
  const allow = new Set(allowedTools)
  if (allow.size !== allowedTools.length) fail('assistant-skills: duplicate allowed tool')
  const { steps: sourceSteps, observations } = sourceProjection(source)
  if (!Array.isArray(observations) || sourceSteps.length + observations.length > 32 || observations.some(value => !failedProbe(value))) fail('assistant-skills: invalid failed observation')
  const expandedSteps = expandSkillRuns(sourceSteps, observations, expansions)
  const executable = expandedSteps.filter(step => {
    if (!step || !text(step.id, 256) || !text(step.toolName, 256) || !json(step.arguments)) fail('assistant-skills: untrusted tool trace')
    if (step.toolName === 'goal_checkpoint' && sourceCheckpoint(step.arguments, source.goal.id)) return false
    // The current owner's parameterless catalog inspection informs the source
    // task but is not executable workflow authority. Retain it in provenance.
    if (step.toolName === 'skill_status' && step.arguments !== null && typeof step.arguments === 'object'
      && !Array.isArray(step.arguments) && Object.keys(step.arguments).length === 0) return false
    if (step.toolName === 'todo_write') {
      if (!todoWrite(step.arguments)) fail('assistant-skills: invalid todo provenance')
      return false
    }
    if (!allow.has(step.toolName) || controlTool(step.toolName, step.arguments)) fail('assistant-skills: untrusted tool trace')
    return true
  })
  if (executable.length === 0) fail('assistant-skills: executable tool trace required')
  const steps = executable.map((step, index) => ({ id: step.id, toolName: step.toolName, arguments: clone(step.arguments), dependsOn: index === 0 ? [] : [executable[index - 1]!.id] }))
  if (new Set([...expandedSteps.map(step => step.id), ...observations.map(value => value.id)]).size !== expandedSteps.length + observations.length
    || expandedSteps.length + observations.length > 32) fail('assistant-skills: bounded tool trace is required')
  const bindings = options.bindings ?? []
  if (!Array.isArray(bindings) || bindings.length > 8) fail('assistant-skills: too many bindings')
  const names = new Set<string>(); const locations = new Set<string>()
  const inputs = bindings.map(binding => {
    if (!json(binding) || !binding || !/^[a-z][a-z0-9_]{0,63}$/u.test(binding.name) || !text(binding.stepId, 256) || typeof binding.path !== 'string' || names.has(binding.name) || locations.has(`${binding.stepId}\u0000${binding.path}`)) fail('assistant-skills: invalid binding')
    names.add(binding.name); locations.add(`${binding.stepId}\u0000${binding.path}`)
    const step = steps.find(candidate => candidate.id === binding.stepId)
    if (!step) fail('assistant-skills: binding step is missing')
    const value = at(step.arguments, binding.path)
    return { ...binding, type: inputType(value), default: value }
  })
  const observedMutators = standardFileMutators(steps)
  if (steps.length + observedMutators.length > 32) fail('assistant-skills: bounded tool trace is required')
  const definition: SkillDefinition = { protocol: 'assistant-skills/definition/v1', name: options.name, description: options.description, source: clone(source), inputs, steps,
    ...(observedMutators.length === 0 ? {} : { fileObservations: { protocol: 'assistant-skills/file-observations/v1' as const, beforeSteps: observedMutators.map(step => step.id) } }),
    ...(expansions.length === 0 ? {} : { runExpansions: clone(expansions) }),
    preconditions: 'current-owner-policy-and-fresh-goal', compensation: 'stop-and-report' }
  fileObservations(definition)
  return freeze(definition)
}

/** Materialize saved defaults and only declared scalar inputs into an immutable trace projection. */
export function instantiate(definition: SkillDefinition, values: Readonly<Record<string, unknown>> = {}): Readonly<SkillDefinition> {
  if (!definition || definition.protocol !== 'assistant-skills/definition/v1' || !values || typeof values !== 'object' || Array.isArray(values) || Object.getPrototypeOf(values) !== Object.prototype || Object.getOwnPropertySymbols(values).length !== 0 || !json(values)) fail('assistant-skills: invalid invocation inputs')
  const expected = new Map(definition.inputs.map(input => [input.name, input]))
  if (Object.keys(values).some(name => !expected.has(name) || forbidden.has(name))) fail('assistant-skills: unknown invocation input')
  const output = clone(definition) as SkillDefinition
  for (const input of output.inputs) {
    const value = Object.hasOwn(values, input.name) ? values[input.name] : input.default
    if (typeof value !== input.type || !scalar(value)) fail('assistant-skills: invocation input type mismatch')
    const step = output.steps.find(candidate => candidate.id === input.stepId)
    if (!step) fail('assistant-skills: invalid definition')
    replace(step.arguments, input.path, value)
  }
  if (output.runExpansions !== undefined) expandSkillRuns(sourceProjection(output.source).steps, sourceProjection(output.source).observations, output.runExpansions)
  fileObservations(output)
  if (Buffer.byteLength(JSON.stringify(output.steps.map(step => step.arguments)), 'utf8') > maximumArgumentsBytes) fail('assistant-skills: invocation arguments too large')
  return freeze(output)
}
