import type { VerifiedWorkflowSource } from '@dsh-enhanced/assistant-goals'
export type { VerifiedWorkflowSource } from '@dsh-enhanced/assistant-goals'

export type SkillScalar = string | number | boolean
export type SkillInputType = 'string' | 'number' | 'boolean'

export interface SkillBinding { name: string; stepId: string; path: string }
export interface SkillInput extends SkillBinding { type: SkillInputType; default: SkillScalar }
export interface SkillStep { id: string; toolName: string; arguments: unknown; dependsOn: readonly string[] }
export interface SkillDefinition {
  protocol: 'assistant-skills/definition/v1'
  name: string
  description: string
  source: VerifiedWorkflowSource
  inputs: readonly SkillInput[]
  steps: readonly SkillStep[]
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
function controlTool(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.startsWith('goal_') || normalized.startsWith('skill') || normalized.includes('workflow') || normalized.includes('subagent')
    || ['create_goal', 'update_goal', 'get_goal', 'run_code', 'javascript'].includes(normalized)
}

/** Derive a bounded, parameterizable skill only from an independently verified tool trace. */
export function createDefinition(source: VerifiedWorkflowSource, options: CreateDefinitionOptions, allowedTools: readonly string[]): Readonly<SkillDefinition> {
  if (!json(source) || !json(options) || !source || source.protocol !== 'assistant-goals/verified-workflow-source/v1' || !Array.isArray(source.steps) || source.steps.length === 0 || source.steps.length > 32
    || !options || !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(options.name) || !text(options.description, 512)
    || !Array.isArray(allowedTools) || allowedTools.some(tool => !text(tool, 256))) fail()
  const allow = new Set(allowedTools)
  if (allow.size !== allowedTools.length) fail('assistant-skills: duplicate allowed tool')
  const steps = source.steps.map((step, index) => {
    if (!step || !text(step.id, 256) || !text(step.toolName, 256) || !allow.has(step.toolName) || controlTool(step.toolName) || !json(step.arguments)) fail('assistant-skills: untrusted tool trace')
    return { id: step.id, toolName: step.toolName, arguments: clone(step.arguments), dependsOn: index === 0 ? [] : [source.steps[index - 1]!.id] }
  })
  if (new Set(steps.map(step => step.id)).size !== steps.length || Buffer.byteLength(JSON.stringify(steps.map(step => step.arguments)), 'utf8') > maximumArgumentsBytes) fail('assistant-skills: bounded tool trace is required')
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
  return freeze({ protocol: 'assistant-skills/definition/v1', name: options.name, description: options.description, source: clone(source), inputs, steps,
    preconditions: 'current-owner-policy-and-fresh-goal', compensation: 'stop-and-report' })
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
  if (Buffer.byteLength(JSON.stringify(output.steps.map(step => step.arguments)), 'utf8') > maximumArgumentsBytes) fail('assistant-skills: invocation arguments too large')
  return freeze(output)
}
