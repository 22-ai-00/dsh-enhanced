import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { externalPrincipalId, ownerRouteAuthorityHash, type ActiveLarkOwnerBinding } from '@dsh-enhanced/assistant-delivery'
import { normalizeConfig, type AssistantGrowthDriverConfig } from '@dsh-enhanced/assistant-growth-driver'
import { normalizeControlPlaneConfig, type Config as ControlPlaneConfig } from '@dsh-enhanced/plugin-control-plane'
import { validateSourceReviewConfig, type SourceReviewConfig } from '@dsh-enhanced/assistant-verifier'
import { isMap, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'

/** Private, owner supplied input for the two-host RSI overlay. */
export interface RsiSetupManifest {
  schemaVersion: 1
  targetProfile: string
  coordinatorProfile: string
  controlPlane: ControlPlaneConfig
  growthDriver: AssistantGrowthDriverConfig
  sourceReviews: SourceReviewConfig
  coordinator: { budgetId: string; budgetAmount: number; timeoutMs: number }
  limits: { periodMs: number; reviews: number; discovery: number; source: number; observations: number; coordinator: number }
}

type Rows = { document: Document; rows: YAMLSeq }
const targetBundles = [
  'dsh-enhanced-personal-assistant', 'dsh-enhanced-assistant-delivery', 'dsh-enhanced-lark-channel',
  'dsh-enhanced-assistant-evaluation', 'dsh-enhanced-assistant-goals', 'dsh-enhanced-assistant-skills',
  'dsh-enhanced-assistant-verifier', 'dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-plugin-control-plane',
] as const
const coordinatorBundles = new Set(['dsh-enhanced-assistant-policy', 'dsh-enhanced-assistant-automations', 'dsh-enhanced-plugin-control-plane'])
const coordinatorBundleNames = new Map([
  ['dsh-enhanced-assistant-policy', '@dsh-enhanced/assistant-policy'],
  ['dsh-enhanced-assistant-automations', '@dsh-enhanced/assistant-automations'],
  ['dsh-enhanced-plugin-control-plane', '@dsh-enhanced/plugin-control-plane'],
])
const rsiPrefix = 'rsi-setup-'

function fail(message: string): never { throw new Error(`rsi setup: ${message}`) }
function map(value: Node | undefined, label: string): YAMLMap { if (!isMap(value)) fail(`${label} must be a YAML mapping`); return value }
function seq(value: Node | undefined, label: string): YAMLSeq { if (!isSeq(value)) fail(`${label} must be a YAML sequence`); return value }
function parse(value: string, label: string): Rows {
  const document = parseDocument(value, { uniqueKeys: true })
  if (document.errors.length) fail(`invalid ${label} YAML: ${document.errors[0]!.message}`)
  return { document, rows: seq(document.contents ?? undefined, label) }
}
function baseRows(value: string): Map<string, string> {
  const document = parseDocument(value, { uniqueKeys: true })
  if (document.errors.length) fail(`invalid coordinator base YAML: ${document.errors[0]!.message}`)
  const result = new Map<string, string>()
  const operations = seq(document.contents ?? undefined, 'coordinator base')
  for (const operation of operations.items) {
    const item = map(operation as Node, 'coordinator base operation')
    if (item.items.length !== 1 || !item.has('insert')) fail('coordinator base contains unsupported operation')
    const inserted = seq(item.get('insert', true) as Node | undefined, 'coordinator base insert')
    for (const entry of inserted.items) {
      const row = map(entry as Node, 'coordinator base row'), id = row.get('id'), name = row.get('name')
      if (typeof id !== 'string' || typeof name !== 'string' || !id || !name || result.has(id)) fail('coordinator base has invalid or duplicate id')
      result.set(id, name)
    }
  }
  if (!result.size) fail('coordinator base has no rows')
  return result
}
function row(rows: YAMLSeq, id: string): YAMLMap | undefined { return rows.items.find(item => isMap(item) && item.get('id') === id) as YAMLMap | undefined }
function required(rows: YAMLSeq, id: string, label = 'profile'): YAMLMap {
  const result = row(rows, id); if (!result) fail(`${label} row ${id} is missing`)
  if (result.get('disabled') === true) fail(`${label} row ${id} is disabled`)
  return result
}
function config(item: YAMLMap, id: string): YAMLMap { return map(item.get('config', true) as Node | undefined, `${id} config`) }
function json(item: YAMLMap, label: string): Record<string, any> {
  const value = item.toJSON()
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, any>
}
function text(value: unknown, label: string): string { if (typeof value !== 'string' || value.trim() !== value || !value) fail(`invalid ${label}`); return value }
function profile(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) fail(`invalid ${label}`)
  return value
}
function cloneEffectiveConfig(out: Rows, effective: Rows, id: string): YAMLMap {
  const source = config(required(effective.rows, id, 'effective profile'), id)
  let destination = row(out.rows, id)
  if (!destination) { destination = map(out.document.createNode({ id }), `${id} override`); out.rows.add(destination) }
  if (destination.get('disabled') === true) fail(`profile row ${id} is disabled`)
  // Preserve YAML tags (notably !!js dshHomePath) by retaining the source node.
  destination.set('config', source)
  return source
}
function replaceNode(document: Document, parent: YAMLMap, key: string, value: unknown): void { parent.set(key, document.createNode(value)) }
function upsertById(document: Document, values: YAMLSeq, value: Record<string, unknown>): void {
  const index = values.items.findIndex(item => isMap(item) && item.get('id') === value.id)
  if (index < 0) values.add(document.createNode(value)); else values.items[index] = document.createNode(value)
}
function removePrefixed(values: YAMLSeq): void {
  for (let i = values.items.length - 1; i >= 0; i--) {
    const item = values.items[i]
    if (isMap(item) && typeof (item as YAMLMap).get('id') === 'string' && ((item as YAMLMap).get('id') as string).startsWith(rsiPrefix)) values.items.splice(i, 1)
  }
}
function absolute(value: string, label: string): string { if (!isAbsolute(value) || resolve(value) !== value) fail(`${label} must be canonical absolute`); return value }
function same(value: unknown, expected: unknown, label: string): void { if (!isDeepStrictEqual(value, expected)) fail(`${label} does not match owner scope`) }

function ownerRoute(delivery: YAMLMap, owner: ActiveLarkOwnerBinding, routeId: string, dshHome: string): { workspace: string; preset: string; principal: string; route: Record<string, any> } {
  const root = json(delivery, 'assistant-delivery config')
  const configuredWorkspace = text(root.defaultWorkspace, 'assistant-delivery.defaultWorkspace')
  const workspace = configuredWorkspace === "dshHomePath('assistant-workspace')" || configuredWorkspace === 'dshHomePath("assistant-workspace")'
    ? join(dshHome, 'assistant-workspace') : absolute(configuredWorkspace, 'assistant-delivery.defaultWorkspace')
  const preset = text(root.defaultAgentPreset, 'assistant-delivery.defaultAgentPreset')
  const principal = externalPrincipalId(owner.principal)
  if (workspace !== owner.workspace || preset !== owner.agentPreset || root.policyRef !== undefined && root.policyRef !== owner.policyRef) fail('owner binding differs from effective delivery scope')
  const routes = root.ownerRoutes
  if (!Array.isArray(routes)) fail('assistant-delivery.ownerRoutes is missing')
  const candidates = routes.filter((item: any) => item && typeof item === 'object' && item.id === routeId)
  if (candidates.length !== 1) fail('effective delivery has no unique owner route for the owner binding')
  const route = candidates[0] as Record<string, any>
  // The configured authority is checked field-for-field before it can bind a
  // durable owner receipt. Its minimum generation is a lower bound, not an
  // optional hint.
  for (const key of ['conversation', 'principal', 'workspace', 'agentPreset', 'policyRef'] as const) {
    const expected = key === 'conversation' ? owner.conversation : key === 'principal' ? owner.principal : owner[key]
    same(route[key], expected, `owner route ${key}`)
  }
  if (!Number.isSafeInteger(route.minimumGeneration) || route.minimumGeneration < 1 || owner.generation < route.minimumGeneration) fail('owner route minimumGeneration does not match current binding')
  if (owner.generation < 1 || owner.version < 1 || !owner.owner?.id || owner.owner.version < 1) fail('owner binding generation or owner receipt is invalid')
  const id = text(route.id, 'owner route id')
  const authority = { id, conversation: owner.conversation, principal: owner.principal, workspace, agentPreset: preset,
    policyRef: owner.policyRef, minimumGeneration: route.minimumGeneration }
  return { workspace, preset, principal, route: { id, authorityHash: ownerRouteAuthorityHash(authority) } }
}

function assertManifest(input: RsiSetupManifest): void {
  if (!input || input.schemaVersion !== 1) fail('unsupported manifest schema')
  profile(input.targetProfile, 'targetProfile'); profile(input.coordinatorProfile, 'coordinatorProfile')
  if (input.targetProfile === input.coordinatorProfile) fail('target and coordinator profiles must differ')
  const l = input.limits
  if (!l || !['periodMs', 'reviews', 'discovery', 'source', 'observations', 'coordinator'].every(key => Object.hasOwn(l, key)) || !Number.isSafeInteger(l.periodMs) || l.periodMs < 1_000 || Object.values(l).some(value => !Number.isSafeInteger(value) || value < 1)) fail('invalid limits')
}
function assertBudget(document: Document, policy: YAMLMap, id: string, limit: number, periodMs: number, scope: string): void {
  const budgets = seq(policy.get('budgets', true) as Node | undefined, 'assistantPolicy.budgets')
  const match = budgets.items.filter(item => isMap(item) && item.get('id') === id)
  if (match.length > 1) fail(`duplicate Policy budget ${id}`)
  const globalConflicts = scope === 'global' ? budgets.items.filter(item => isMap(item) && item.get('metric') === 'automation-runs' && item.get('scope') === 'global' && item.get('periodMs') === periodMs && item.get('id') !== id && item.get('limit') !== limit) : []
  if (globalConflicts.length) fail(`global automation-runs budget conflicts with ${id}`)
  upsertById(document, budgets, { id, metric: 'automation-runs', limit, periodMs, scope })
}

function targetPolicy(document: Document, personal: YAMLMap, manifest: RsiSetupManifest, scope: { workspace: string; preset: string; principal: string }, budgetIds: { reviews: string; discovery: string; source: string; observations: string }): void {
  const policy = map(personal.get('assistantPolicy', true) as Node | undefined, 'assistantPolicy config')
  const automation = map(personal.get('assistantAutomations', true) as Node | undefined, 'assistantAutomations config')
  if (automation.get('allowUnbudgetedExecution') === true) fail('assistantAutomations.allowUnbudgetedExecution must be false')
  automation.set('schedulerEnabled', true)
  assertBudget(document, policy, budgetIds.reviews, manifest.limits.reviews, manifest.limits.periodMs, 'global')
  assertBudget(document, policy, budgetIds.discovery, manifest.limits.discovery, manifest.limits.periodMs, 'subject')
  assertBudget(document, policy, budgetIds.source, manifest.limits.source, manifest.limits.periodMs, 'subject')
  assertBudget(document, policy, budgetIds.observations, manifest.limits.observations, manifest.limits.periodMs, 'subject')
  const rules = seq(policy.get('rules', true) as Node | undefined, 'assistantPolicy.rules'); removePrefixed(rules)
  const background = (id: string, subject: string, action: 'reconcile' | 'execute', automationId: string) => ({ id: `${rsiPrefix}${id}`, effect: 'allow', subject: { kind: 'background', id: subject, workspace: scope.workspace, principal: scope.principal }, actions: [action], resource: { kind: 'automation', id: automationId }, context: { initiators: ['background'] } })
  for (const [name, subject, automation] of [['usage', 'assistant-growth-usage', 'usage-*'], ['source', 'plugin-control-plane-source', 'source-job-*'], ['observation', 'plugin-control-plane-task-observations', 'task-observation-scan-*']] as const) {
    upsertById(document, rules, background(`${name}-reconcile`, subject, 'reconcile', automation))
    // Automations execute under their generated automation id; reconciliation
    // runs under its stable owner id.
    upsertById(document, rules, background(`${name}-execute`, automation, 'execute', automation))
  }
  const agent = { kind: 'agent', id: scope.preset, workspace: scope.workspace, principal: scope.principal }
  for (const tool of ['growth_*', 'plugin_source_*'] as const) upsertById(document, rules, { id: `${rsiPrefix}${tool}`, effect: 'allow', subject: agent, actions: ['execute'], resource: { kind: 'tool', id: tool }, context: { initiators: ['background'] } })
  upsertById(document, rules, { id: `${rsiPrefix}verified-workflows`, effect: 'allow', subject: agent, actions: ['draft'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiators: ['background'] } })
}

/**
 * Read-only profile compiler. The caller owns private manifest I/O, lifecycle locks,
 * atomic writes and post-write DSH composition checks.
 */
export async function compileRsiProfiles(input: { manifest: RsiSetupManifest; dshHome: string; targetPatch: string; targetEffective: string; coordinatorPatch: string; coordinatorEffective: string; coordinatorBase: string; owner: ActiveLarkOwnerBinding }): Promise<{ targetPatch: string; coordinatorPatch: string }> {
  assertManifest(input.manifest); absolute(input.dshHome, 'dshHome')
  const target = parse(input.targetPatch, 'target patch'), effective = parse(input.targetEffective, 'target effective config')
  const coordinator = parse(input.coordinatorPatch, 'coordinator patch'), coordinatorEffective = parse(input.coordinatorEffective, 'coordinator effective config')
  for (const id of targetBundles) required(effective.rows, id, 'target effective profile')
  const jobs = input.manifest.controlPlane.sourceJobs
  if (!jobs || jobs.expiresAt <= Date.now()) fail('sourceJobs must be present and unexpired')
  const delivery = config(required(effective.rows, 'dsh-enhanced-assistant-delivery'), 'assistant-delivery')
  const owner = ownerRoute(delivery, input.owner, jobs.ownerRouteId, input.dshHome)
  if (jobs.ownerRouteId !== owner.route.id || jobs.principalId !== owner.principal || jobs.workspace !== owner.workspace || jobs.preset !== owner.preset) fail('sourceJobs does not match effective owner route')
  const growth = normalizeConfig(input.manifest.growthDriver)
  if (!growth.enabled || growth.intervalMs !== 0 || !growth.usageLearning.enabled || !growth.pluginSourceProposals.enabled || growth.pluginSourceProposals.preparationMode !== 'durable' || growth.pluginSourceProposals.repository !== jobs.repository || !growth.scope || !isDeepStrictEqual(growth.scope, { workspace: owner.workspace, preset: owner.preset, principalId: owner.principal, ownerRouteId: owner.route.id })) fail('growthDriver must be owner-scoped durable ordinary-use configuration')
  const expectedOwner = { authorityId: jobs.authorityId, authorityHash: owner.route.authorityHash, principalId: owner.principal, principalRecordId: input.owner.owner.id, principalVersion: input.owner.owner.version, workspace: owner.workspace, agentPreset: owner.preset }
  if (!isDeepStrictEqual(input.manifest.sourceReviews.owner, expectedOwner)) fail('sourceReviews.owner does not match current owner')
  validateSourceReviewConfig(input.manifest.sourceReviews)

  const cp = structuredClone(input.manifest.controlPlane)
  if (!cp.sourceBuild || !cp.sourceApprovals || !cp.sourceReleases || !cp.sourceReleaseExecution || !cp.sourceAdoptions || !cp.runtimeObserver || !cp.foregroundDeployments || !cp.taskObservations) fail('target controlPlane lacks a complete source adoption chain')
  if (cp.adoptionCoordinator) fail('target controlPlane must not contain adoptionCoordinator')
  if (cp.sourceBuild.versioning !== 'patch') fail('sourceBuild requires Host patch versioning')
  if (cp.sourceReleaseExecution.independentReview !== true) fail('sourceReleaseExecution requires independentReview')
  if (cp.sourceReleaseExecution.reviewDecisionRoot !== input.manifest.sourceReviews.decisionRoot) fail('sourceReviews decisionRoot must equal sourceReleaseExecution reviewDecisionRoot')
  if (cp.sourceAdoptions.profile !== input.manifest.targetProfile || cp.runtimeObserver.profilePath !== join(input.dshHome, 'profiles', input.manifest.targetProfile) || cp.taskObservations.profilePath !== cp.runtimeObserver.profilePath) fail('controlPlane profile observation scope differs from target')
  if (!isDeepStrictEqual(cp.taskObservations.scope, { ownerRouteId: owner.route.id, principalId: owner.principal, workspace: owner.workspace, preset: owner.preset })) fail('task observation scope differs from source jobs')
  normalizeControlPlaneConfig(cp)

  const budgetIds = { reviews: growth.budgetId, discovery: growth.usageLearning.scanBudgetId, source: jobs.budgetId, observations: cp.taskObservations.budgetId }
  if (Object.values(budgetIds).some((value): value is null => value === null) || new Set(Object.values(budgetIds)).size !== 4 || new Set([...Object.values(budgetIds), input.manifest.coordinator.budgetId]).size !== 5) fail('five RSI automation budget ids must be present and distinct')
  const personal = cloneEffectiveConfig(target, effective, 'dsh-enhanced-personal-assistant')
  targetPolicy(target.document, personal, input.manifest, owner, budgetIds as { reviews: string; discovery: string; source: string; observations: string })
  const verifier = cloneEffectiveConfig(target, effective, 'dsh-enhanced-assistant-verifier')
  // Keep all existing verifier settings, replacing only the finite review grant.
  replaceNode(target.document, verifier, 'sourceReviews', input.manifest.sourceReviews)
  cloneEffectiveConfig(target, effective, 'dsh-enhanced-assistant-growth-driver')
  replaceNode(target.document, required(target.rows, 'dsh-enhanced-assistant-growth-driver'), 'config', input.manifest.growthDriver)
  cloneEffectiveConfig(target, effective, 'dsh-enhanced-plugin-control-plane')
  replaceNode(target.document, required(target.rows, 'dsh-enhanced-plugin-control-plane'), 'config', cp)

  // Coordinator is intentionally sparse. Base rows must match the installed
  // base patch exactly, while enhanced rows are an explicit three-bundle set.
  const allowedBase = baseRows(input.coordinatorBase)
  const seenCoordinatorRows = new Set<string>()
  for (const item of coordinatorEffective.rows.items) {
    if (!isMap(item)) fail('coordinator effective config contains non-mapping row')
    const id = item.get('id'), name = item.get('name')
    if (typeof id !== 'string' || typeof name !== 'string' || seenCoordinatorRows.has(id)) fail('coordinator effective config has invalid or duplicate row')
    seenCoordinatorRows.add(id)
    const expected = coordinatorBundleNames.get(id) ?? allowedBase.get(id)
    if (expected !== name) fail(`coordinator contains forbidden row ${id}`)
    const configured = item.get('config', true) as Node | undefined
    if (id === 'agent-loop') {
      const agents = map(configured, 'agent-loop config').get('agents', true)
      if (!isSeq(agents) || agents.items.length !== 0) fail('coordinator base agent-loop.agents must be empty')
    }
    const nestedPlugins = isMap(configured) ? (configured as YAMLMap).get('plugins', true) as Node | undefined : undefined
    if (isSeq(nestedPlugins) && nestedPlugins.items.length !== 0) fail(`coordinator base row ${id} has nested plugin mounts`)
  }
  for (const id of coordinatorBundles) required(coordinatorEffective.rows, id, 'coordinator effective profile')
  const root = join(input.dshHome, 'rsi-coordinators', input.manifest.coordinatorProfile)
  const targetCp = cp
  const targetAdoptions = targetCp.sourceAdoptions
  if (!targetAdoptions) fail('target sourceAdoptions is required')
  const coordinatorCp: ControlPlaneConfig = { catalogPath: targetCp.catalogPath, trustPath: targetCp.trustPath, statePath: root,
    adoptionCoordinator: { coordinatorId: targetAdoptions.handoff?.coordinatorId ?? fail('sourceAdoptions.handoff coordinatorId is required'), scope: { workspace: owner.workspace, preset: owner.preset, principalId: owner.principal, ownerRouteId: owner.route.id }, timeoutMs: input.manifest.coordinator.timeoutMs, budgetId: input.manifest.coordinator.budgetId, budgetAmount: input.manifest.coordinator.budgetAmount } }
  normalizeControlPlaneConfig(coordinatorCp)
  const policy = cloneEffectiveConfig(coordinator, coordinatorEffective, 'dsh-enhanced-assistant-policy')
  policy.set('databasePath', join(root, 'policy.sqlite'))
  const budgets = seq(policy.get('budgets', true) as Node | undefined, 'coordinator policy budgets')
  upsertById(coordinator.document, budgets, { id: input.manifest.coordinator.budgetId, metric: 'automation-runs', limit: input.manifest.limits.coordinator, periodMs: input.manifest.limits.periodMs, scope: 'subject' })
  const rules = seq(policy.get('rules', true) as Node | undefined, 'coordinator policy rules'); removePrefixed(rules)
  const coordinatorSubject = { kind: 'background', id: 'plugin-control-plane-adoption-coordinator', workspace: owner.workspace, principal: owner.principal }
  const coordinatorAutomationSubject = { ...coordinatorSubject, id: 'adoption-coordinator-*' }
  upsertById(coordinator.document, rules, { id: `${rsiPrefix}coordinator-reconcile`, effect: 'allow', subject: coordinatorSubject, actions: ['reconcile'], resource: { kind: 'automation', id: 'adoption-coordinator-*' }, context: { initiators: ['background'] } })
  upsertById(coordinator.document, rules, { id: `${rsiPrefix}coordinator-execute`, effect: 'allow', subject: coordinatorAutomationSubject, actions: ['execute'], resource: { kind: 'automation', id: 'adoption-coordinator-*' }, context: { initiators: ['background'] } })
  const automationConfig = cloneEffectiveConfig(coordinator, coordinatorEffective, 'dsh-enhanced-assistant-automations')
  if (automationConfig.get('allowUnbudgetedExecution') === true) fail('coordinator allowUnbudgetedExecution must be false')
  automationConfig.set('schedulerEnabled', true); automationConfig.set('databasePath', join(root, 'automations.sqlite')); automationConfig.set('runsPath', join(root, 'runs'))
  cloneEffectiveConfig(coordinator, coordinatorEffective, 'dsh-enhanced-plugin-control-plane')
  replaceNode(coordinator.document, required(coordinator.rows, 'dsh-enhanced-plugin-control-plane'), 'config', coordinatorCp)
  return { targetPatch: target.document.toString({ lineWidth: 0 }), coordinatorPatch: coordinator.document.toString({ lineWidth: 0 }) }
}
