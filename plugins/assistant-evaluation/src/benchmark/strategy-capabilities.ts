/**
 * Capability identity and live probes for the native Goal strategy benchmark.
 *
 * A plan may bind an expectation, but cannot attest a process it has not yet
 * constructed.  This module consequently keeps resolved source identity and
 * observations separate: `capabilities` is safe to freeze in a plan, while a
 * `StrategyCapabilityRuntimeObservation` is a per-cell fact collected after
 * the owner has mounted its services.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { assertStrategyPolicyConfiguration, strategyPolicyRecipe } from './strategy-policy.js'

export const strategyBenchmarkMinimalRecipe = Object.freeze({
  protocol: 'dsh-native-goal-strategy-recipe-v1',
  parentTools: Object.freeze(['goal_create', 'goal_context', 'goal_checkpoint', 'isolation_run']),
  strategyTool: 'goal_strategy',
  strategyKinds: Object.freeze(['investigate', 'review', 'compare']),
  /** Strategy is the only arm difference.  Do not add task data here. */
  strategyEnabled: true,
})

export interface StrategyCapabilitySourceModule {
  /** Package specifier resolved from the evaluation package actually running. */
  packageName: string
  /** Relative files below the resolved package root.  These are deployed lib files. */
  files: readonly string[]
}

export interface StrategyCapabilitySourceGroups {
  common: { tools: readonly StrategyCapabilitySourceModule[]; policy: readonly StrategyCapabilitySourceModule[]; runtime: readonly StrategyCapabilitySourceModule[] }
  strategy: { guide: readonly StrategyCapabilitySourceModule[]; tool: readonly StrategyCapabilitySourceModule[]; policy: readonly StrategyCapabilitySourceModule[]; runtime: readonly StrategyCapabilitySourceModule[] }
}

export interface StrategyCapabilityToolDefinition {
  name: string
  description: string
  parameters: unknown
  output: unknown
}

export interface StrategyCapabilityPolicyProbe {
  request: unknown
  /** The public `AssistantPolicyService.evaluate()` result expected before dispatch. */
  effect: 'allow' | 'deny'
  /** Exact validated policy configuration passed when the service was installed. */
  config: unknown
}

export interface StrategyCapabilityExpectationInput {
  resolverDirectory: string
  persona: string
  recipe?: typeof strategyBenchmarkMinimalRecipe
  sources: StrategyCapabilitySourceGroups
  commonTools: readonly StrategyCapabilityToolDefinition[]
  strategyTools: readonly StrategyCapabilityToolDefinition[]
  commonPolicy: StrategyCapabilityPolicyProbe
  strategyPolicy: StrategyCapabilityPolicyProbe
}

/** The only plan-construction input.  Package and tool selection are fixed. */
export interface FixedStrategyCapabilityExpectationInput {
  resolverDirectory: string
  persona: string
  recipe?: typeof strategyBenchmarkMinimalRecipe
}

export interface StrategyCapabilitySourceIdentity {
  packageName: string
  version: string
  manifestDigest: string
  files: readonly { path: string; digest: string }[]
  digest: string
}

/** The eight stable slots already carried by StrategyBenchmarkCapabilities. */
export interface StrategyCapabilityExpectation {
  readonly capabilities: {
    readonly common: { readonly persona: string; readonly tools: string; readonly policy: string; readonly runtime: string }
    readonly strategy: { readonly guide: string; readonly tool: string; readonly policy: string; readonly runtime: string }
  }
  readonly sourceIdentity: Readonly<Record<'common.tools' | 'common.policy' | 'common.runtime' | 'strategy.guide' | 'strategy.tool' | 'strategy.policy' | 'strategy.runtime', readonly StrategyCapabilitySourceIdentity[]>>
  readonly commonTools: readonly StrategyCapabilityToolDefinition[]
  readonly strategyTools: readonly StrategyCapabilityToolDefinition[]
  readonly commonPolicy: StrategyCapabilityPolicyProbe
  readonly strategyPolicy: StrategyCapabilityPolicyProbe
  readonly persona: string
  readonly recipeDigest: string
  /** Internal re-probe inputs; they are resolved again before every assertion. */
  readonly resolverDirectory: string
  readonly resolvedSourceModules: Readonly<Record<'common.tools' | 'common.policy' | 'common.runtime' | 'strategy.guide' | 'strategy.tool' | 'strategy.policy' | 'strategy.runtime', readonly StrategyCapabilitySourceModule[]>>
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const canonical = (value: unknown): string => acceptanceCanonicalJson(value)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function fail(message: string): never { throw new Error(`strategy capabilities: ${message}`) }

function checkedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > 256 * 1024) fail(`invalid ${label}`)
  return value
}
function checkedModule(value: StrategyCapabilitySourceModule): StrategyCapabilitySourceModule {
  if (!isPlainObject(value) || !/^(?:@[^/]+\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(value.packageName)
    || !Array.isArray(value.files) || value.files.length === 0) fail('invalid source module')
  const files = value.files.map(file => {
    if (typeof file !== 'string' || file === '' || file.startsWith('/') || file.split(/[\\/]/u).some(part => part === '' || part === '.' || part === '..')) fail('invalid source file')
    return file
  }).sort()
  if (new Set(files).size !== files.length) fail('duplicate source file')
  return { packageName: value.packageName, files }
}
function packageRoot(entry: string, packageName: string): string {
  let current = dirname(realpathSync(entry))
  while (true) {
    const manifest = join(current, 'package.json')
    try {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (json.name === packageName) return current
    } catch {}
    const parent = dirname(current)
    if (parent === current) fail(`resolved package root missing for ${packageName}`)
    current = parent
  }
}
export function resolveStrategyCapabilitySource(input: { resolverDirectory: string; module: StrategyCapabilitySourceModule }): StrategyCapabilitySourceIdentity {
  const module = checkedModule(input.module)
  const directory = resolve(checkedText(input.resolverDirectory, 'resolver directory'))
  const resolver = createRequire(join(directory, 'strategy-capabilities-resolver.cjs'))
  let entry: string
  try { entry = resolver.resolve(module.packageName) } catch { fail(`cannot resolve ${module.packageName}`) }
  const root = packageRoot(entry, module.packageName)
  const manifest = readFileSync(join(root, 'package.json'), 'utf8')
  let version: unknown
  try { version = (JSON.parse(manifest) as { version?: unknown }).version } catch { fail(`invalid package manifest for ${module.packageName}`) }
  if (typeof version !== 'string' || version === '') fail(`invalid package version for ${module.packageName}`)
  const files = module.files.map(path => {
    const target = realpathSync(resolve(root, path))
    if (relative(root, target).startsWith(`..${sep}`) || relative(root, target) === '..' || !statSync(target).isFile()) fail(`source escapes package root: ${module.packageName}/${path}`)
    return Object.freeze({ path, digest: sha256(readFileSync(target)) })
  })
  const identity = { packageName: module.packageName, version, manifestDigest: sha256(manifest), files }
  return Object.freeze({ ...identity, digest: acceptanceDigest(identity) })
}
function identities(directory: string, modules: readonly StrategyCapabilitySourceModule[]): readonly StrategyCapabilitySourceIdentity[] {
  if (!Array.isArray(modules) || modules.length === 0) fail('empty source group')
  return Object.freeze(modules.map(module => resolveStrategyCapabilitySource({ resolverDirectory: directory, module })))
}
function definition(value: StrategyCapabilityToolDefinition): StrategyCapabilityToolDefinition {
  if (!isPlainObject(value) || !/^[a-z][a-z0-9_]{0,127}$/u.test(value.name) || typeof value.description !== 'string') fail('invalid tool definition')
  // `execute` is deliberately absent: a source identity plus this model-visible
  // definition is attestable without pretending closures have serializable code.
  return Object.freeze({ name: value.name, description: value.description, parameters: clone(value.parameters), output: clone(value.output) })
}
function definitions(values: readonly StrategyCapabilityToolDefinition[]): readonly StrategyCapabilityToolDefinition[] {
  if (!Array.isArray(values) || values.length === 0) fail('empty tool definition group')
  const result = values.map(definition).sort((a, b) => a.name.localeCompare(b.name))
  if (new Set(result.map(item => item.name)).size !== result.length) fail('duplicate tool definition')
  return Object.freeze(result)
}
function policy(value: StrategyCapabilityPolicyProbe): StrategyCapabilityPolicyProbe {
  if (!isPlainObject(value) || (value.effect !== 'allow' && value.effect !== 'deny')) fail('invalid policy probe')
  return Object.freeze({ request: clone(value.request), effect: value.effect, config: clone(value.config) })
}
function sourceDigest(label: string, source: readonly StrategyCapabilitySourceIdentity[], extra: unknown): string {
  return acceptanceDigest({ label, source: source.map(item => item.digest), extra })
}

function createStrategyCapabilityExpectation(input: StrategyCapabilityExpectationInput): Readonly<StrategyCapabilityExpectation> {
  const resolverDirectory = resolve(checkedText(input.resolverDirectory, 'resolver directory'))
  const persona = checkedText(input.persona, 'persona')
  if (input.recipe !== undefined && canonical(input.recipe) !== canonical(strategyBenchmarkMinimalRecipe)) fail('strategy recipe differs from fixed benchmark recipe')
  const commonTools = definitions(input.commonTools); const strategyTools = definitions(input.strategyTools)
  const commonPolicy = policy(input.commonPolicy); const strategyPolicy = policy(input.strategyPolicy)
  const sourceIdentity = Object.freeze({
    'common.tools': identities(resolverDirectory, input.sources.common.tools),
    'common.policy': identities(resolverDirectory, input.sources.common.policy),
    'common.runtime': identities(resolverDirectory, input.sources.common.runtime),
    'strategy.guide': identities(resolverDirectory, input.sources.strategy.guide),
    'strategy.tool': identities(resolverDirectory, input.sources.strategy.tool),
    'strategy.policy': identities(resolverDirectory, input.sources.strategy.policy),
    'strategy.runtime': identities(resolverDirectory, input.sources.strategy.runtime),
  })
  const recipeDigest = acceptanceDigest(strategyBenchmarkMinimalRecipe)
  const capabilities = Object.freeze({
    common: Object.freeze({ persona: acceptanceDigest({ persona }), tools: sourceDigest('common-tools', sourceIdentity['common.tools'], { recipeDigest, definitions: commonTools }),
      policy: sourceDigest('common-policy', sourceIdentity['common.policy'], { probe: commonPolicy }), runtime: sourceDigest('common-runtime', sourceIdentity['common.runtime'], { recipeDigest }) }),
    strategy: Object.freeze({ guide: sourceDigest('strategy-guide', sourceIdentity['strategy.guide'], { recipeDigest }), tool: sourceDigest('strategy-tool', sourceIdentity['strategy.tool'], { recipeDigest, definitions: strategyTools }),
      policy: sourceDigest('strategy-policy', sourceIdentity['strategy.policy'], { probe: strategyPolicy }), runtime: sourceDigest('strategy-runtime', sourceIdentity['strategy.runtime'], { recipeDigest }) }),
  })
  return Object.freeze({ capabilities, sourceIdentity, commonTools, strategyTools, commonPolicy, strategyPolicy, persona, recipeDigest, resolverDirectory,
    resolvedSourceModules: Object.freeze({ 'common.tools': input.sources.common.tools, 'common.policy': input.sources.common.policy, 'common.runtime': input.sources.common.runtime,
      'strategy.guide': input.sources.strategy.guide, 'strategy.tool': input.sources.strategy.tool, 'strategy.policy': input.sources.strategy.policy, 'strategy.runtime': input.sources.strategy.runtime }) })
}

// Expected tool names are a recipe, not invented schemas. Actual schemas are
// read from the mounted registry and compared with each model request below.
const fixedToolDefinitions = Object.freeze(strategyBenchmarkMinimalRecipe.parentTools.map(name =>
  Object.freeze({ name, description: '', parameters: null, output: null })))
const fixedStrategyToolDefinitions = Object.freeze([
  Object.freeze({ name: 'goal_strategy', description: '', parameters: null, output: null }),
])
function allLibFiles(root: string): string[] {
  const lib = join(root, 'lib'); const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative(root, path))
    }
  }
  visit(lib)
  if (files.length === 0) fail('resolved package has no deployed lib JavaScript')
  return files.sort()
}
function fixedModule(resolverDirectory: string, packageName: string): StrategyCapabilitySourceModule {
  const resolver = createRequire(join(resolverDirectory, 'strategy-capabilities-resolver.cjs'))
  let entry: string
  try { entry = resolver.resolve(packageName) } catch { fail(`cannot resolve ${packageName}`) }
  return { packageName, files: allLibFiles(packageRoot(entry, packageName)) }
}
/**
 * Fixed benchmark capability construction.  It hashes each selected installed
 * package's manifest and every deployed JavaScript file under lib, so a lockfile range or
 * a caller-provided digest cannot stand in for the code actually resolved.
 */
export function createFixedStrategyCapabilityExpectation(input: FixedStrategyCapabilityExpectationInput): Readonly<StrategyCapabilityExpectation> {
  const resolverDirectory = resolve(checkedText(input.resolverDirectory, 'resolver directory'))
  const goals = fixedModule(resolverDirectory, '@dsh-enhanced/assistant-goals')
  const isolation = fixedModule(resolverDirectory, '@dsh-enhanced/assistant-isolation')
  const policyModule = fixedModule(resolverDirectory, '@dsh-enhanced/assistant-policy')
  const runtime = fixedModule(resolverDirectory, '@dsh-enhanced/assistant-evaluation')
  const loaded = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-goal-round-driver', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-session-persistence-jsonl', '@dsh-enhanced/assistant-delivery', '@dsh-enhanced/assistant-verifier'].map(name => fixedModule(resolverDirectory, name))
  const sources: StrategyCapabilitySourceGroups = { common: { tools: [goals, isolation], policy: [policyModule], runtime: [runtime, ...loaded] },
    strategy: { guide: [goals], tool: [goals], policy: [policyModule], runtime: [goals, ...loaded] } }
  // These names are the benchmark recipe's fixed contract.  Runtime records
  // the actual rich definitions emitted by DSH; it never accepts caller hashes.
  const commonPolicy = { request: { action: 'execute', resource: { kind: 'tool', id: 'goal_create' } }, effect: 'allow' as const, config: strategyPolicyRecipe(false) }
  const strategyPolicy = { request: { action: 'execute', resource: { kind: 'tool', id: 'goal_strategy' } }, effect: 'allow' as const, config: strategyPolicyRecipe(true) }
  return createStrategyCapabilityExpectation({ resolverDirectory, persona: input.persona, ...(input.recipe === undefined ? {} : { recipe: input.recipe }), sources,
    commonTools: fixedToolDefinitions, strategyTools: fixedStrategyToolDefinitions, commonPolicy, strategyPolicy })
}

/** Minimal public Context surface.  Callers may not supply a look-alike host. */
export interface StrategyCapabilityContext {
  get(name: string): unknown
  tools?: { get(name: string, scope?: unknown): unknown }
}
export interface StrategyCapabilityParentRequest {
  /** Captured from the actual LLM request options, never reconstructed later. */
  system: string
  tools: readonly StrategyCapabilityToolDefinition[]
}
export interface StrategyCapabilityRuntimeObservation {
  readonly sourceDigest: string
  readonly services: Readonly<{ goals: true; assistantPolicy: true; tools: true }>
  readonly parentTools: readonly StrategyCapabilityToolDefinition[]
  readonly policy: Readonly<{ common: 'allow' | 'deny'; strategy: 'allow' | 'deny'; configuration: Readonly<Record<string, unknown>>; configDigest: string }>
  /** This proves the registered persona section value, not a whole rendered prompt. */
  readonly personaDigest: string
  readonly dynamicGoalContext: 'not-attested'
}

const runtimeBrand = new WeakSet<object>()
export class StrategyCapabilityRuntimeHost {
  readonly #ctx: StrategyCapabilityContext
  #parentRequest: { system: string; tools: readonly StrategyCapabilityToolDefinition[] } | undefined
  #policyRequests: { common: unknown; strategy: unknown } | undefined
  private constructor(ctx: StrategyCapabilityContext) { this.#ctx = ctx }
  static fromMountedContext(ctx: StrategyCapabilityContext): StrategyCapabilityRuntimeHost {
    if (!ctx || typeof ctx !== 'object' || typeof ctx.get !== 'function') fail('trusted runtime requires a Context')
    const host = new StrategyCapabilityRuntimeHost(ctx); runtimeBrand.add(host); return host
  }
  /**
   * Call this from the real `agent/request` hook with the definitions emitted
   * to the parent model request.  It is intentionally a one-shot capture: a
   * later synthetic array cannot replace the observed request.
   */
  captureParentRequest(request: StrategyCapabilityParentRequest): void {
    if (!runtimeBrand.has(this)) fail('untrusted runtime host')
    if (this.#parentRequest !== undefined) fail('parent request already captured')
    this.#parentRequest = Object.freeze({ system: checkedText(request.system, 'parent request system'), tools: definitions(request.tools) })
  }
  /** Capture the real owner-bound requests used for the public Policy API. */
  capturePolicyRequests(requests: { common: unknown; strategy: unknown }): void {
    if (!runtimeBrand.has(this) || this.#policyRequests !== undefined || !isPlainObject(requests)) fail('invalid policy request capture')
    this.#policyRequests = { common: clone(requests.common), strategy: clone(requests.strategy) }
  }
  observe(expectation: StrategyCapabilityExpectation, enabled: boolean, parentScope?: unknown): Readonly<StrategyCapabilityRuntimeObservation> {
    if (!runtimeBrand.has(this)) fail('untrusted runtime host')
    const goals = this.#ctx.get('assistantGoals'); const assistantPolicy = this.#ctx.get('assistantPolicy'); const tools = this.#ctx.tools ?? this.#ctx.get('tools') as StrategyCapabilityContext['tools']
    if (!goals || !assistantPolicy || !tools || typeof tools.get !== 'function') fail('required runtime services are not mounted')
    if (this.#parentRequest === undefined) fail('actual parent request was not captured')
    if (this.#parentRequest.system !== expectation.persona) fail('actual parent request persona drift')
    const expectedNames = [...expectation.commonTools, ...(enabled ? expectation.strategyTools : [])].map(item => item.name).sort()
    const observedNames = this.#parentRequest.tools.map(item => item.name).sort()
    if (canonical(observedNames) !== canonical(expectedNames)) fail('actual parent request tool drift')
    const actual = [...expectation.commonTools, ...(enabled ? expectation.strategyTools : [])].map(expected => {
      const value = tools.get(expected.name, parentScope) as Partial<StrategyCapabilityToolDefinition> | undefined
      if (!value) fail(`parent tool missing: ${expected.name}`)
      const observed = definition({ name: String(value.name), description: String(value.description), parameters: value.parameters,
        output: (value.output as { schema?: unknown } | undefined)?.schema ?? null })
      if (observed.name !== expected.name) fail(`parent tool definition drift: ${expected.name}`)
      const captured = this.#parentRequest!.tools.find(item => item.name === expected.name)!
      if (captured.description !== observed.description || canonical(captured.parameters) !== canonical(observed.parameters)) fail(`parent tool definition drift: ${expected.name}`)
      return observed
    })
    const evaluate = (assistantPolicy as { evaluate?: (request: unknown) => { effect?: unknown } }).evaluate
    if (typeof evaluate !== 'function') fail('assistantPolicy evaluate is unavailable')
    const inspect = (assistantPolicy as { inspectHostConfiguration?: () => unknown }).inspectHostConfiguration
    if (typeof inspect !== 'function') fail('assistantPolicy configuration inspection is unavailable')
    if (this.#policyRequests === undefined) fail('actual policy requests were not captured')
    const common = evaluate.call(assistantPolicy, this.#policyRequests.common)?.effect
    const strategy = evaluate.call(assistantPolicy, this.#policyRequests.strategy)?.effect
    if (common !== 'allow' || strategy !== (enabled ? 'allow' : 'deny')) fail('policy decision drift')
    const commonRequest = this.#policyRequests.common as { subject?: { workspace?: unknown } }
    const workspace = commonRequest.subject?.workspace
    if (typeof workspace !== 'string' || workspace.length === 0) fail('policy request workspace is unavailable')
    const configuration = assertStrategyPolicyConfiguration(inspect.call(assistantPolicy), enabled, workspace)
    const actualSources = Object.fromEntries(Object.entries(expectation.resolvedSourceModules).map(([key, modules]) => [key, identities(expectation.resolverDirectory, modules as readonly StrategyCapabilitySourceModule[])]))
    if (canonical(actualSources) !== canonical(expectation.sourceIdentity)) fail('resolved source identity drift')
    const sourceDigest = acceptanceDigest(actualSources)
    return Object.freeze({ sourceDigest, services: Object.freeze({ goals: true, assistantPolicy: true, tools: true }), parentTools: Object.freeze(actual),
      policy: Object.freeze({ common: common as 'allow', strategy: strategy as 'allow' | 'deny', configuration, configDigest: acceptanceDigest(configuration) }), personaDigest: acceptanceDigest({ persona: this.#parentRequest.system }), dynamicGoalContext: 'not-attested' })
  }
}
export function assertStrategyCapabilityRuntime(expectation: StrategyCapabilityExpectation, host: StrategyCapabilityRuntimeHost, enabled: boolean, parentScope?: unknown): Readonly<StrategyCapabilityRuntimeObservation> {
  if (!(host instanceof StrategyCapabilityRuntimeHost)) fail('runtime observation requires StrategyCapabilityRuntimeHost')
  return host.observe(expectation, enabled, parentScope)
}
