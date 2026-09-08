import { describe, expect, test } from 'vitest'
import { resolve } from 'node:path'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { assertStrategyCapabilityRuntime, createFixedStrategyCapabilityExpectation, resolveStrategyCapabilitySource, StrategyCapabilityRuntimeHost, strategyBenchmarkMinimalRecipe, type StrategyCapabilityToolDefinition } from '../../src/benchmark/strategy-capabilities.js'

const root = resolve(process.cwd(), 'plugins/assistant-evaluation')
const output = { schema: { type: 'object', additionalProperties: false }, render: 'not-executed' }
const commonTool: StrategyCapabilityToolDefinition = { name: 'goal_create', description: 'creates a goal', parameters: { objective: { type: 'string', required: true } }, output }
const contextTool: StrategyCapabilityToolDefinition = { name: 'goal_context', description: 'reads a goal', parameters: {}, output }
const checkpointTool: StrategyCapabilityToolDefinition = { name: 'goal_checkpoint', description: 'writes a checkpoint', parameters: {}, output }
const isolationTool: StrategyCapabilityToolDefinition = { name: 'isolation_run', description: 'runs isolated work', parameters: {}, output }
const strategyTool: StrategyCapabilityToolDefinition = { name: 'goal_strategy', description: 'compares approaches', parameters: { kind: { type: 'string', required: true } }, output }
const parentTools = [commonTool, contextTool, checkpointTool, isolationTool, strategyTool]
const request = { subject: { kind: 'agent', id: 'benchmark', workspace: '/work' }, action: 'execute', resource: { kind: 'tool', id: 'goal_create' }, context: { initiator: 'external' } }
const policyConfiguration = (enabled = true) => ({ toolDefaultEffect: 'deny', budgets: [], autoReview: null, rules: [
  { id: 'benchmark-pair-issue', effect: 'allow', subject: { kind: 'external', id: 'local:benchmark-bootstrap-a' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
  { id: 'benchmark-owner-ingest', effect: 'allow', subject: { kind: 'external', id: 'principal-a' }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
  { id: 'benchmark-owner-reply', effect: 'allow', subject: { kind: 'agent', id: 'benchmark', workspace: '/work', principal: 'principal-a' }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
  { id: 'benchmark-goal', effect: 'allow', subject: { kind: 'agent', id: 'benchmark', workspace: '/work' }, actions: ['create', 'observe', 'inspect', 'focus', 'checkpoint', 'snapshot', 'execute', ...(enabled ? ['delegate'] : [])], resource: { kind: 'goal', id: 'business-context' }, context: { initiators: ['external'] } },
  ...['goal_create', 'goal_context', 'goal_checkpoint', 'isolation_run', ...(enabled ? ['goal_strategy'] : []), 'isolation:benchmark-work'].map(id => ({ id: `allow-${id.replace(':', '-')}`, effect: 'allow', subject: { kind: 'agent', id: 'benchmark', workspace: '/work' }, actions: ['execute'], resource: { kind: 'tool', id }, context: { initiators: ['external'] } })),
] })
const goalToolsSource = { packageName: '@dsh-enhanced/assistant-goals', files: ['lib/tools.js'] } as const
const expected = () => createFixedStrategyCapabilityExpectation({ resolverDirectory: root, persona: 'benchmark persona', recipe: strategyBenchmarkMinimalRecipe })

describe('strategy capability attestation', () => {
  test('binds resolved package version, manifest, and deployed source contents', () => {
    const actual = resolveStrategyCapabilitySource({ resolverDirectory: root, module: goalToolsSource })
    expect(actual.version).toMatch(/^\d+\./)
    expect(actual.manifestDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(actual.files).toEqual([{ path: 'lib/tools.js', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }])
    const capability = expected()
    expect(capability.capabilities.strategy.tool).not.toBe(acceptanceDigest({ plan: 'caller-reported-hash' }))
    expect(capability.recipeDigest).toBe(acceptanceDigest(strategyBenchmarkMinimalRecipe))
  })

  test('changes the expected capability when the actual selected source or recipe-bound definition changes', () => {
    const tool = resolveStrategyCapabilitySource({ resolverDirectory: root, module: goalToolsSource })
    const service = resolveStrategyCapabilitySource({ resolverDirectory: root, module: { packageName: '@dsh-enhanced/assistant-goals', files: ['lib/service.js'] } })
    expect(tool.digest).not.toBe(service.digest)
    expect(expected().capabilities.strategy.tool).toMatch(/^[a-f0-9]{64}$/)
  })

  test('rejects a copied plan hash when the mounted tool or Policy probe drifts', () => {
    const expectation = expected()
    const definitions = new Map<string, StrategyCapabilityToolDefinition>(parentTools.map(value => [value.name, value]))
    const policy = { evaluate: () => ({ effect: 'allow' }), inspectHostConfiguration: () => policyConfiguration() }
    const context = { get(name: string) { return name === 'assistantGoals' ? {} : name === 'assistantPolicy' ? policy : name === 'tools' ? { get: (tool: string) => definitions.get(tool) } : undefined }, tools: { get: (tool: string) => definitions.get(tool) } }
    const host = StrategyCapabilityRuntimeHost.fromMountedContext(context)
    host.captureParentRequest({ system: 'benchmark persona', tools: parentTools })
    host.capturePolicyRequests({ common: request, strategy: { ...request, resource: { kind: 'tool', id: 'goal_strategy' } } })
    expect(assertStrategyCapabilityRuntime(expectation, host, true).sourceDigest).toBe(acceptanceDigest(expectation.sourceIdentity))
    definitions.delete('goal_strategy')
    expect(() => assertStrategyCapabilityRuntime(expectation, host, true)).toThrow('parent tool missing')
    definitions.set('goal_strategy', strategyTool)
    definitions.set('goal_strategy', strategyTool)
    const denied = { ...context, get(name: string) { return name === 'assistantPolicy' ? { evaluate: () => ({ effect: 'deny' }), inspectHostConfiguration: () => policyConfiguration() } : context.get(name) } }
    const deniedHost = StrategyCapabilityRuntimeHost.fromMountedContext(denied)
    deniedHost.captureParentRequest({ system: 'benchmark persona', tools: parentTools })
    deniedHost.capturePolicyRequests({ common: request, strategy: request })
    expect(() => assertStrategyCapabilityRuntime(expectation, deniedHost, true)).toThrow('policy decision drift')
  })

  test('does not accept arbitrary host-shaped objects or claim dynamic Goal context is static prompt proof', () => {
    const expectation = expected()
    expect(() => assertStrategyCapabilityRuntime(expectation, {} as StrategyCapabilityRuntimeHost, true)).toThrow('RuntimeHost')
    const context = { get(name: string) { return name === 'assistantGoals' ? {} : name === 'assistantPolicy' ? { evaluate: () => ({ effect: 'allow' }), inspectHostConfiguration: () => policyConfiguration() } : { get: (tool: string) => parentTools.find(value => value.name === tool) } }, tools: { get: (tool: string) => parentTools.find(value => value.name === tool) } }
    const host = StrategyCapabilityRuntimeHost.fromMountedContext(context)
    host.captureParentRequest({ system: 'benchmark persona', tools: parentTools })
    host.capturePolicyRequests({ common: request, strategy: request })
    expect(assertStrategyCapabilityRuntime(expectation, host, true).dynamicGoalContext).toBe('not-attested')
  })

  test('rejects inspected Policy configuration drift even when both Policy probes allow', () => {
    const expectation = expected()
    const drifted = policyConfiguration(); drifted.toolDefaultEffect = 'allow'
    const policy = { evaluate: () => ({ effect: 'allow' }), inspectHostConfiguration: () => drifted }
    const context = { get(name: string) { return name === 'assistantGoals' ? {} : name === 'assistantPolicy' ? policy : { get: (tool: string) => parentTools.find(value => value.name === tool) } }, tools: { get: (tool: string) => parentTools.find(value => value.name === tool) } }
    const host = StrategyCapabilityRuntimeHost.fromMountedContext(context)
    host.captureParentRequest({ system: 'benchmark persona', tools: parentTools })
    host.capturePolicyRequests({ common: request, strategy: request })
    expect(() => assertStrategyCapabilityRuntime(expectation, host, true)).toThrow('default effect')
  })
})
