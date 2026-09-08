import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'

export interface StrategyPolicyRecipe {
  protocol: 'dsh-native-goal-strategy-policy-v1'
  enabled: boolean
  /** Dynamic identity values are normalized out of this plan-bound recipe. */
  rules: readonly Readonly<Record<string, unknown>>[]
}
function fail(message: string): never { throw new Error(`strategy policy: ${message}`) }
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid configuration')
  return value as Record<string, unknown>
}
const same = (left: unknown, right: unknown): boolean => acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right)
const subject = (id: string, workspace?: string) => ({ kind: 'agent', id, ...(workspace === undefined ? {} : { workspace }) })
const external = (id: string) => ({ kind: 'external', id })
const tool = (id: string) => ({ kind: 'tool', id })
const externalContext = { initiators: ['external'] }

/** Plan-bound rule shape.  Bootstrap/principal/workspace values are normalized. */
export function strategyPolicyRecipe(enabled: boolean): Readonly<StrategyPolicyRecipe> {
  const tools = ['goal_create', 'goal_context', 'goal_checkpoint', 'isolation_run', ...(enabled ? ['goal_strategy'] : []), 'isolation:benchmark-work']
  return Object.freeze({ protocol: 'dsh-native-goal-strategy-policy-v1', enabled, rules: Object.freeze([
    { role: 'pair-issue', effect: 'allow', subject: external('$bootstrap'), actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { role: 'owner-ingest', effect: 'allow', subject: external('$principal'), actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: externalContext },
    { role: 'owner-reply', effect: 'allow', subject: { ...subject('benchmark', '$workspace'), principal: '$principal' }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: externalContext },
    { role: 'goal', effect: 'allow', subject: subject('benchmark', '$workspace'), actions: ['create', 'observe', 'inspect', 'focus', 'checkpoint', 'snapshot', 'execute', ...(enabled ? ['delegate'] : [])], resource: { kind: 'goal', id: 'business-context' }, context: externalContext },
    ...tools.map(id => ({ role: `tool:${id}`, effect: 'allow', subject: subject('benchmark', '$workspace'), actions: ['execute'], resource: tool(id), context: externalContext })),
  ]) })
}

/**
 * Validate the exact public Policy configuration emitted by the benchmark
 * owner.  Dynamic bootstrap/principal IDs are accepted only in their owning
 * rule; every agent rule must bind one identical benchmark workspace.
 */
export function assertStrategyPolicyConfiguration(config: unknown, enabled: boolean, workspace?: string): Readonly<Record<string, unknown>> {
  const value = object(config)
  if (!same(Object.keys(value).sort(), ['autoReview', 'budgets', 'rules', 'toolDefaultEffect']) || !same(value.budgets, []) || value.autoReview !== null) fail('unexpected policy configuration')
  const rules = value.rules
  if (!Array.isArray(rules) || rules.length !== strategyPolicyRecipe(enabled).rules.length || value.toolDefaultEffect !== 'deny') fail('unexpected policy rules or default effect')
  const byId = new Map<string, Record<string, unknown>>()
  for (const item of rules) { const rule = object(item); if (typeof rule.id !== 'string' || byId.has(rule.id)) fail('invalid policy rule id'); byId.set(rule.id, rule) }
  const get = (id: string): Record<string, unknown> => byId.get(id) ?? fail(`missing policy rule ${id}`)
  const exact = (id: string, expected: Record<string, unknown>): void => {
    const rule = get(id); const normalized = { ...rule, id: undefined }
    delete (normalized as Record<string, unknown>).id
    if (!same(normalized, expected)) fail(`policy rule drift: ${id}`)
  }
  const pair = get('benchmark-pair-issue'); const bootstrap = object(pair.subject).id
  if (typeof bootstrap !== 'string' || !bootstrap.startsWith('local:benchmark-bootstrap-') || bootstrap.includes('*')) fail('invalid bootstrap scope')
  exact('benchmark-pair-issue', { effect: 'allow', subject: external(bootstrap), actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } })
  const ingest = get('benchmark-owner-ingest'); const principal = object(ingest.subject).id
  if (typeof principal !== 'string' || principal === '' || principal.includes('*')) fail('invalid principal scope')
  exact('benchmark-owner-ingest', { effect: 'allow', subject: external(principal), actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: externalContext })
  const owner = get('benchmark-owner-reply'); const ownerSubject = object(owner.subject); const boundWorkspace = ownerSubject.workspace
  if (typeof boundWorkspace !== 'string' || boundWorkspace === '' || boundWorkspace.includes('*') || workspace !== undefined && boundWorkspace !== workspace) fail('invalid workspace scope')
  exact('benchmark-owner-reply', { effect: 'allow', subject: { ...subject('benchmark', boundWorkspace), principal }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: externalContext })
  const actions = ['create', 'observe', 'inspect', 'focus', 'checkpoint', 'snapshot', 'execute', ...(enabled ? ['delegate'] : [])]
  exact('benchmark-goal', { effect: 'allow', subject: subject('benchmark', boundWorkspace), actions, resource: { kind: 'goal', id: 'business-context' }, context: externalContext })
  const tools = ['goal_create', 'goal_context', 'goal_checkpoint', 'isolation_run', ...(enabled ? ['goal_strategy'] : []), 'isolation:benchmark-work']
  for (const id of tools) exact(`allow-${id.replace(':', '-')}`, { effect: 'allow', subject: subject('benchmark', boundWorkspace), actions: ['execute'], resource: tool(id), context: externalContext })
  return Object.freeze(JSON.parse(JSON.stringify(value)) as Record<string, unknown>)
}

export function strategyPolicyConfigurationDigest(config: unknown, enabled: boolean, workspace?: string): string {
  return acceptanceDigest(assertStrategyPolicyConfiguration(config, enabled, workspace))
}
