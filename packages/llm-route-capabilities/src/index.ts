import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { version } from './version.js'

/**
 * Adapter protocol projection only; never an Agent tool authorization decision.
 * `none` is an explicit negative implementation declaration, not a model capability tier.
 */
export type ToolCallMode = 'none' | 'native' | 'bridge'

export interface LlmRouteCapabilityDeclaration {
  readonly provider: string
  readonly model?: string
  readonly toolCalls: ToolCallMode
}

export type LlmRouteCapabilityDisposer = () => void

/**
 * Host-owned proof that an adapter request is running inside one exact live
 * Agent driver and still names that Agent's exact Session object.
 */
export interface AgentLoopRequestAttestor {
  claim(request: GenerateOptions, session: object): boolean
}

type LiveAgentSession = NonNullable<ReturnType<AgentRegistry['get']>>['session']

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

function own(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function dataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function plainDataKeys(value: object): string[] | undefined {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== 'string')) return undefined
    const dataKeys = keys.filter(key => key !== 'length') as string[]
    if (dataKeys.length !== value.length
      || dataKeys.some((key, index) => key !== String(index))) return undefined
    return dataKeys
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) return undefined
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !own(descriptor, 'value')) return undefined
  }
  return keys as string[]
}

/** Compare the JSON-shaped request/session snapshots without serializing secrets. */
function sameData(left: unknown, right: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[left, right]]
  const seen = new WeakMap<object, WeakSet<object>>()
  while (pending.length > 0) {
    const pair = pending.pop()!
    if (Object.is(pair[0], pair[1])) continue
    if (pair[0] === null || pair[1] === null
      || typeof pair[0] !== 'object' || typeof pair[1] !== 'object') return false

    const leftArray = Array.isArray(pair[0])
    if (leftArray !== Array.isArray(pair[1])) return false
    if (!leftArray && (!dataRecord(pair[0]) || !dataRecord(pair[1]))) return false

    let rights = seen.get(pair[0])
    if (rights?.has(pair[1])) continue
    if (rights === undefined) {
      rights = new WeakSet<object>()
      seen.set(pair[0], rights)
    }
    rights.add(pair[1])

    const leftKeys = plainDataKeys(pair[0])
    const rightKeys = plainDataKeys(pair[1])
    if (leftKeys === undefined || rightKeys === undefined || leftKeys.length !== rightKeys.length) return false
    const rightKeySet = new Set(rightKeys)
    for (const key of leftKeys) {
      if (!rightKeySet.has(key)) return false
      pending.push([
        (pair[0] as Record<string, unknown>)[key],
        (pair[1] as Record<string, unknown>)[key],
      ])
    }
  }
  return true
}

function deeplyFrozen(value: unknown): boolean {
  const pending: Array<{ value: unknown; leave?: boolean }> = [{ value }]
  const active = new WeakSet<object>()
  const complete = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.leave) {
      active.delete(current.value as object)
      complete.add(current.value as object)
      continue
    }
    if (current.value === null || typeof current.value !== 'object') {
      if (current.value === undefined || typeof current.value === 'symbol' || typeof current.value === 'function'
        || (typeof current.value === 'number' && (!Number.isFinite(current.value) || Object.is(current.value, -0)))) return false
      continue
    }
    if (current.value instanceof AbortSignal) continue
    if (active.has(current.value)) return false
    if (complete.has(current.value)) continue
    active.add(current.value)
    pending.push({ value: current.value, leave: true })
    const keys = plainDataKeys(current.value)
    if (keys === undefined) return false
    const currentRecord = current.value as Record<string, unknown>
    if (!Object.isFrozen(current.value)) return false
    for (const key of keys) {
      pending.push({ value: currentRecord[key] })
    }
  }
  return true
}

function sameLoopMessage(
  actual: GenerateOptions['messages'][number],
  expected: GenerateOptions['messages'][number],
  ownedRoutes: ReadonlySet<string>,
): boolean {
  if (actual === expected) return true
  const source = expected.source
  if (expected.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined
    || ownedRoutes.has(source.provider)) return false

  // DSH rc.8's forAdapter() makes exactly this detached snapshot when the
  // historical replay state belongs to another adapter instance.
  return sameData(actual, {
    ...expected,
    source: {
      kind: 'model',
      provider: source.provider,
      model: source.model,
    },
  })
}

function exactLoopEnvelope(
  request: GenerateOptions,
  session: LiveAgentSession,
  ownedRoutes: ReadonlySet<string>,
): boolean {
  if (own(request, 'purpose') || !own(request, 'signal')
    || !(request.signal instanceof AbortSignal) || request.signal.aborted
    || !deeplyFrozen(request)) return false
  const header = session.requestHeader()
  if (header === undefined) return false
  const expectedMessages = session.deriveMessages()
  if (request.messages.length !== expectedMessages.length
    || !request.messages.every((message, index) => sameLoopMessage(message, expectedMessages[index]!, ownedRoutes))) return false

  const expected: Record<string, unknown> = {
    ...header.config,
    messages: request.messages,
    ...(header.system === undefined ? {} : { system: header.system }),
    ...(header.tools === undefined ? {} : { tools: header.tools }),
    sessionId: session.id,
    signal: request.signal,
  }
  return sameData(request, expected)
}

/**
 * Preserve Agent Loop provenance across package duplication and transformations
 * owned by DSH's LLM runtime. DSH rc.8 keeps its request marker in a module-local
 * WeakSet and may clone a frozen request while materializing adapter defaults or
 * stripping another adapter's replay state. The Agent Registry's initiator scope
 * instead spans the whole driver Promise and is owned by the Host service.
 *
 * Ambient initiator presence is not enough: every claim also requires a running
 * Agent, exact registry identity, matching request/session id, the exact Session
 * object returned by the Host, and an envelope reconstructed from that Session's
 * current request header and derived message history. The only accepted clone is
 * DSH rc.8's documented replayState removal in forAdapter(). Provider-side
 * canonical-cwd checks remain separate and mandatory.
 */
export function createAgentLoopRequestAttestor(
  agents: Pick<AgentRegistry, 'currentInitiator' | 'get'>,
  ownedRoutes: readonly string[],
): AgentLoopRequestAttestor {
  const routes = new Set(ownedRoutes)
  if (routes.size === 0 || routes.size !== ownedRoutes.length || ownedRoutes.some(route => !providerPattern.test(route))) {
    throw new Error('llm-route-capabilities: attestor requires unique exact provider routes')
  }
  return Object.freeze({
    claim(request: GenerateOptions, session: object): boolean {
      try {
        const initiator = agents.currentInitiator()
        return initiator !== undefined
          && initiator.status === 'running'
          && request.sessionId !== undefined
          && initiator.id === request.sessionId
          && agents.get(initiator.id) === initiator
          && initiator.session === session
          && initiator.session.id === request.sessionId
          && exactLoopEnvelope(request, initiator.session, routes)
      } catch {
        // Service teardown or a malformed host facade fails closed at the
        // provider boundary and is reported as an unattested local request.
        return false
      }
    },
  })
}

/**
 * Attach one audited tool-call projection declaration to exactly one live LLM runtime.
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
