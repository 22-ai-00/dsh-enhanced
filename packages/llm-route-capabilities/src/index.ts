import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { version } from './version.js'

export type ToolCallMode = 'none' | 'native' | 'bridge'

export interface LlmRouteCapabilityDeclaration {
  readonly provider: string
  readonly model?: string
  readonly toolCalls: ToolCallMode
}

export type LlmRouteCapabilityDisposer = () => void

interface RegistryEntry {
  readonly declaration: Readonly<LlmRouteCapabilityDeclaration>
  readonly token: symbol
}

interface RegistryState {
  readonly schemaVersion: 1
  readonly providers: Map<string, RegistryEntry>
  readonly models: Map<string, RegistryEntry>
}

const registrySymbol = Symbol.for('@dsh-enhanced/llm-route-capabilities/runtime-registry/v1')
const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u
const modes = new Set<ToolCallMode>(['none', 'native', 'bridge'])

function registryTarget(runtime: LlmRuntime): Record<PropertyKey, unknown> {
  return runtime as unknown as Record<PropertyKey, unknown>
}

function validState(value: unknown): value is RegistryState {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<RegistryState>
  return candidate.schemaVersion === 1
    && candidate.providers instanceof Map
    && candidate.models instanceof Map
}

function registry(runtime: LlmRuntime, create: boolean): RegistryState | undefined {
  const target = registryTarget(runtime)
  const existing = target[registrySymbol]
  if (existing !== undefined) {
    if (!validState(existing)) {
      throw new Error('llm-route-capabilities: incompatible registry is already attached to this LlmRuntime')
    }
    return existing
  }
  if (!create) return undefined
  const state: RegistryState = {
    schemaVersion: 1,
    providers: new Map(),
    models: new Map(),
  }
  Object.defineProperty(target, registrySymbol, {
    value: state,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return state
}

function normalize(input: LlmRouteCapabilityDeclaration): Readonly<LlmRouteCapabilityDeclaration> {
  if (!providerPattern.test(input.provider)) {
    throw new Error('llm-route-capabilities: provider must be an exact non-empty provider id')
  }
  if (input.model !== undefined
    && (input.model.length === 0 || input.model.length > 512 || /[\s\p{Cc}]/u.test(input.model))) {
    throw new Error('llm-route-capabilities: model must be an exact non-empty model id')
  }
  if (!modes.has(input.toolCalls)) {
    throw new Error('llm-route-capabilities: invalid tool-call mode')
  }
  return Object.freeze({
    provider: input.provider,
    ...(input.model === undefined ? {} : { model: input.model }),
    toolCalls: input.toolCalls,
  })
}

function modelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

/**
 * Attach one audited capability declaration to exactly one live LLM runtime.
 * A selector has a single owner; even an identical duplicate is rejected so
 * plugin unload cannot make another plugin's declaration disappear.
 */
export function registerLlmRouteCapability(
  runtime: LlmRuntime,
  input: LlmRouteCapabilityDeclaration,
): LlmRouteCapabilityDisposer {
  const declaration = normalize(input)
  const state = registry(runtime, true)!
  const entries = declaration.model === undefined ? state.providers : state.models
  const key = declaration.model === undefined
    ? declaration.provider
    : modelKey(declaration.provider, declaration.model)
  if (entries.has(key)) {
    const selector = declaration.model === undefined
      ? declaration.provider
      : `${declaration.provider}/${declaration.model}`
    throw new Error(`llm-route-capabilities: duplicate route capability selector: ${selector}`)
  }
  const token = Symbol('llm-route-capability-registration')
  entries.set(key, { declaration, token })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const current = entries.get(key)
    if (current?.token === token) entries.delete(key)
  }
}

/** Resolve the exact-model declaration first, then the provider-wide fallback. */
export function resolveLlmRouteCapability(
  runtime: LlmRuntime,
  provider: string,
  model: string,
): Readonly<LlmRouteCapabilityDeclaration> | undefined {
  const state = registry(runtime, false)
  return state?.models.get(modelKey(provider, model))?.declaration
    ?? state?.providers.get(provider)?.declaration
}

export { version }
