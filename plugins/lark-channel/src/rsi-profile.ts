import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type ActiveLarkOwnerBinding } from '@dsh-enhanced/assistant-delivery'
import { normalizeConfig, type AssistantGrowthDriverConfig } from '@dsh-enhanced/assistant-growth-driver'
import { normalizeControlPlaneConfig, type Config as ControlPlaneConfig } from '@dsh-enhanced/plugin-control-plane'
import { validateSourceReviewConfig, type SourceReviewConfig } from '@dsh-enhanced/assistant-verifier'
import { isMap, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'

import type { RsiServiceEnvironments } from './rsi-service-setup.js'
import { resolveRsiOwnerRoute, rsiCoordinatorAutomationDatabasePath } from './rsi-owner-profile.js'
import { validateRsiMemoryLearningSetup, type RsiMemoryLearningSetup } from './rsi-memory-learning.js'

/** Private, owner supplied input for the two-host RSI overlay. */
export interface RsiSetupManifest {
  schemaVersion: 1
  targetProfile: string
  coordinatorProfile: string
  serviceEnvironment?: RsiServiceEnvironments
  controlPlane: ControlPlaneConfig
  growthDriver: AssistantGrowthDriverConfig
  sourceReviews: SourceReviewConfig
  memoryLearning?: RsiMemoryLearningSetup
  coordinator: { budgetId: string; budgetAmount: number; timeoutMs: number }
  limits: { periodMs: number; reviews: number; discovery: number; source: number; observations: number; coordinator: number; qualification?: number }
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
function profile(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) fail(`invalid ${label}`)
  return value
}
function cloneEffectiveConfig(out: Rows, effective: Rows, id: string, allowMissing = false): YAMLMap {
  const entry = required(effective.rows, id, 'effective profile')
  const source = allowMissing && !entry.has('config') ? map(out.document.createNode({}), `${id} config`) : config(entry, id)
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

function assertNewMemoryBudget(policy: YAMLMap, id: string, limit: number, periodMs: number,
  scope: 'subject' | 'workspace'): void {
  const budgets = seq(policy.get('budgets', true) as Node | undefined, 'assistantPolicy.budgets')
  const matches = budgets.items.filter(item => isMap(item) && item.get('id') === id)
  if (matches.length > 1 || matches.length === 1 && !isDeepStrictEqual((matches[0] as YAMLMap).toJSON(),
    { id, metric: 'automation-runs', limit, periodMs, scope })) fail(`memory Policy budget ${id} conflicts`)
  if (scope === 'workspace' && budgets.items.some(item => isMap(item) && item.get('id') !== id
    && item.get('metric') === 'automation-runs' && item.get('scope') === 'workspace'
    && item.get('periodMs') === periodMs)) {
    fail(`memory Policy workspace budget ${id} conflicts with an existing counter pool`)
  }
}

function targetPolicy(document: Document, personal: YAMLMap, manifest: RsiSetupManifest, scope: { workspace: string; preset: string; principal: string }, budgetIds: { reviews: string; discovery: string; source: string; observations: string }, memory?: RsiMemoryLearningSetup): void {
  const policy = map(personal.get('assistantPolicy', true) as Node | undefined, 'assistantPolicy config')
  const automation = map(personal.get('assistantAutomations', true) as Node | undefined, 'assistantAutomations config')
  if (automation.get('allowUnbudgetedExecution') === true) fail('assistantAutomations.allowUnbudgetedExecution must be false')
  automation.set('schedulerEnabled', true)
  assertBudget(document, policy, budgetIds.reviews, manifest.limits.reviews, manifest.limits.periodMs, 'global')
  assertBudget(document, policy, budgetIds.discovery, manifest.limits.discovery, manifest.limits.periodMs, 'subject')
  assertBudget(document, policy, budgetIds.source, manifest.limits.source, manifest.limits.periodMs, 'subject')
  assertBudget(document, policy, budgetIds.observations, manifest.limits.observations, manifest.limits.periodMs, 'subject')
  if (manifest.controlPlane.liveQualification) assertBudget(document, policy, manifest.controlPlane.liveQualification.budgetId, manifest.limits.qualification!, manifest.limits.periodMs, 'subject')
  if (memory) {
    assertNewMemoryBudget(policy, memory.learning.budgetId, memory.limits.extractions, manifest.limits.periodMs, 'workspace')
    assertNewMemoryBudget(policy, memory.learning.scanBudgetId, memory.limits.scans, manifest.limits.periodMs, 'subject')
    assertBudget(document, policy, memory.learning.budgetId, memory.limits.extractions, manifest.limits.periodMs, 'workspace')
    assertBudget(document, policy, memory.learning.scanBudgetId, memory.limits.scans, manifest.limits.periodMs, 'subject')
  }
  const rules = seq(policy.get('rules', true) as Node | undefined, 'assistantPolicy.rules'); removePrefixed(rules)
  const background = (id: string, subject: string, action: 'reconcile' | 'execute', automationId: string) => ({ id: `${rsiPrefix}${id}`, effect: 'allow', subject: { kind: 'background', id: subject, workspace: scope.workspace, principal: scope.principal }, actions: [action], resource: { kind: 'automation', id: automationId }, context: { initiators: ['background'] } })
  for (const [name, subject, automation] of [['usage', 'assistant-growth-usage', 'usage-*'], ['source', 'plugin-control-plane-source', 'source-job-*'], ['observation', 'plugin-control-plane-task-observations', 'task-observation-scan-*']] as const) {
    upsertById(document, rules, background(`${name}-reconcile`, subject, 'reconcile', automation))
    // Automations execute under their generated automation id; reconciliation
    // runs under its stable owner id.
    upsertById(document, rules, background(`${name}-execute`, automation, 'execute', automation))
  }
  if (manifest.controlPlane.liveQualification) {
    upsertById(document, rules, background('qualification-reconcile', 'plugin-control-plane-live-qualification', 'reconcile', 'live-qualification-scan-*'))
    upsertById(document, rules, background('qualification-execute', 'live-qualification-scan-*', 'execute', 'live-qualification-scan-*'))
  }
  if (memory) {
    const subject = { kind: 'background', id: 'assistant-memory-learning', workspace: scope.workspace, principal: scope.principal }
    for (const [action, authorityId] of [['extract', memory.learning.authorityId], ['review', memory.reviews.authorityId], ['adopt', memory.adoption.authorityId]] as const) {
      upsertById(document, rules, { id: `${rsiPrefix}memory-${action}`, effect: 'allow', subject,
        actions: [action], resource: { kind: 'memory', id: `learning:${authorityId}` }, context: { initiators: ['background'] } })
    }
    for (const [kind, automationId] of [['scan', 'memory-scan-*'], ['job', 'memory-learning:*']] as const) {
      upsertById(document, rules, background(`memory-${kind}-reconcile`, 'assistant-memory-learning', 'reconcile', automationId))
      upsertById(document, rules, background(`memory-${kind}-execute`, automationId, 'execute', automationId))
    }
  }
  const agent = { kind: 'agent', id: scope.preset, workspace: scope.workspace, principal: scope.principal }
  for (const tool of ['growth_*', 'plugin_source_*'] as const) upsertById(document, rules, { id: `${rsiPrefix}${tool}`, effect: 'allow', subject: agent, actions: ['execute'], resource: { kind: 'tool', id: tool }, context: { initiators: ['background'] } })
  upsertById(document, rules, { id: `${rsiPrefix}verified-workflows`, effect: 'allow', subject: agent, actions: ['draft'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiators: ['background'] } })
}

function configurePersonal(document: Document, personal: YAMLMap, manifest: RsiSetupManifest,
  scope: { workspace: string; preset: string; principal: string },
  budgetIds: { reviews: string; discovery: string; source: string; observations: string },
  memory?: RsiMemoryLearningSetup): void {
  if (memory) {
    const personalMemory = map(personal.get('personalMemory', true) as Node | undefined, 'personalMemory config')
    replaceNode(document, personalMemory, 'automaticLearning', memory.adoption)
  }
  targetPolicy(document, personal, manifest, scope, budgetIds, memory)
}

/** Match the target compiler's exact embedded Personal Assistant options for Host attestation. */
export function compileRsiPersonalAssistantOptions(input: {
  effectiveConfig: Record<string, unknown>
  manifest: RsiSetupManifest
  scope: { workspace: string; preset: string; principal: string }
  budgetIds: { reviews: string; discovery: string; source: string; observations: string }
}): Record<string, unknown> {
  const document = parseDocument(JSON.stringify(input.effectiveConfig), { uniqueKeys: true })
  const personal = map(document.contents ?? undefined, 'personal assistant options')
  const memory = input.manifest.memoryLearning === undefined ? undefined
    : validateRsiMemoryLearningSetup(input.manifest.memoryLearning, input.manifest.sourceReviews.owner)
  configurePersonal(document, personal, input.manifest, input.scope, input.budgetIds, memory)
  return json(personal, 'personal assistant options')
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
  const standaloneAutomations = row(effective.rows, 'dsh-enhanced-assistant-automations')
  if (standaloneAutomations && standaloneAutomations.get('disabled') !== true) fail('ambiguous standalone and embedded Automations providers')
  const jobs = input.manifest.controlPlane.sourceJobs
  if (!jobs || jobs.expiresAt <= Date.now()) fail('sourceJobs must be present and unexpired')
  const delivery = config(required(effective.rows, 'dsh-enhanced-assistant-delivery'), 'assistant-delivery')
  const owner = resolveRsiOwnerRoute(json(delivery, 'assistant-delivery config'), input.owner, input.dshHome, jobs.ownerRouteId)
  if (jobs.ownerRouteId !== owner.route.id || jobs.principalId !== owner.principal || jobs.workspace !== owner.workspace || jobs.preset !== owner.preset) fail('sourceJobs does not match effective owner route')
  const growth = normalizeConfig(input.manifest.growthDriver)
  if (!growth.enabled || growth.intervalMs !== 0 || !growth.usageLearning.enabled || !growth.pluginSourceProposals.enabled || growth.pluginSourceProposals.preparationMode !== 'durable' || growth.pluginSourceProposals.repository !== jobs.repository || !growth.scope || !isDeepStrictEqual(growth.scope, { workspace: owner.workspace, preset: owner.preset, principalId: owner.principal, ownerRouteId: owner.route.id })) fail('growthDriver must be owner-scoped durable ordinary-use configuration')
  // The review source is the Delivery owner receipt. Its authorityId is the
  // owner route, while sourceJobs.authorityId names a separate finite job grant.
  const expectedOwner = { authorityId: owner.route.id, authorityHash: owner.route.authorityHash, principalId: owner.principal, principalRecordId: input.owner.owner.id, principalVersion: input.owner.owner.version, workspace: owner.workspace, agentPreset: owner.preset }
  if (!isDeepStrictEqual(input.manifest.sourceReviews.owner, expectedOwner)) fail('sourceReviews.owner does not match current owner')
  validateSourceReviewConfig(input.manifest.sourceReviews)
  const memory = input.manifest.memoryLearning === undefined ? undefined
    : validateRsiMemoryLearningSetup(input.manifest.memoryLearning, expectedOwner)

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
  if (cp.liveQualification) {
    same(cp.liveQualification.scope, cp.taskObservations.scope, 'live qualification')
    if (!Number.isSafeInteger(input.manifest.limits.qualification) || input.manifest.limits.qualification! < 1
      || [...Object.values(budgetIds), input.manifest.coordinator.budgetId].includes(cp.liveQualification.budgetId)) fail('live qualification requires a distinct finite budget')
  }
  if (memory) {
    const existing = [...Object.values(budgetIds), input.manifest.coordinator.budgetId,
      ...(cp.liveQualification ? [cp.liveQualification.budgetId] : [])]
    if (memory.learning.budgetId === memory.learning.scanBudgetId
      || existing.includes(memory.learning.budgetId) || existing.includes(memory.learning.scanBudgetId)) fail('memory automation budget ids conflict with RSI')
    const learnerRows = effective.rows.items.filter(item => isMap(item) && item.get('id') === 'dsh-enhanced-assistant-memory-learning')
    if (learnerRows.length !== 1) fail('memory learner row is missing or duplicate')
    const learner = learnerRows[0] as YAMLMap
    const currentLearnerConfig = learner.get('config', true) as Node | undefined
    if (learner.get('name') !== '@dsh-enhanced/assistant-memory-learning'
      || !(learner.get('disabled') === true && !learner.has('config')
        || learner.get('disabled') === false && isMap(currentLearnerConfig)
          && isDeepStrictEqual((currentLearnerConfig as YAMLMap).toJSON(), memory.learning))) {
      fail('memory learner must be the inactive installed bundle or exact current learning configuration')
    }
    const standalone = row(effective.rows, 'dsh-enhanced-personal-memory')
    if (standalone && standalone.get('disabled') !== true) fail('ambiguous standalone and embedded Memory providers')
  }
  if (owner.created) {
    const deliveryOverride = cloneEffectiveConfig(target, effective, 'dsh-enhanced-assistant-delivery')
    seq(deliveryOverride.get('ownerRoutes', true) as Node | undefined, 'Delivery ownerRoutes').add(target.document.createNode(owner.authority))
  }
  const personal = cloneEffectiveConfig(target, effective, 'dsh-enhanced-personal-assistant')
  configurePersonal(target.document, personal, input.manifest, owner,
    budgetIds as { reviews: string; discovery: string; source: string; observations: string }, memory)
  const verifier = cloneEffectiveConfig(target, effective, 'dsh-enhanced-assistant-verifier')
  // Keep all existing verifier settings, replacing only the finite review grant.
  replaceNode(target.document, verifier, 'sourceReviews', input.manifest.sourceReviews)
  if (memory) replaceNode(target.document, verifier, 'memoryReviews', memory.reviews)
  if (memory) {
    let learner = row(target.rows, 'dsh-enhanced-assistant-memory-learning')
    if (!learner) {
      learner = map(target.document.createNode({ id: 'dsh-enhanced-assistant-memory-learning' }), 'memory learner override')
      target.rows.add(learner)
    }
    if (Object.keys(json(learner, 'memory learner override')).some(key => !['id', 'name', 'disabled', 'config'].includes(key))) fail('memory learner override has unsupported fields')
    if (learner.has('name') && learner.get('name') !== '@dsh-enhanced/assistant-memory-learning') fail('memory learner override package differs')
    learner.set('name', '@dsh-enhanced/assistant-memory-learning')
    learner.set('disabled', false)
    replaceNode(target.document, learner, 'config', memory.learning)
  }
  cloneEffectiveConfig(target, effective, 'dsh-enhanced-assistant-growth-driver', true)
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
  automationConfig.set('schedulerEnabled', true); automationConfig.set('databasePath', rsiCoordinatorAutomationDatabasePath(input.dshHome, input.manifest.coordinatorProfile)); automationConfig.set('runsPath', join(root, 'runs'))
  cloneEffectiveConfig(coordinator, coordinatorEffective, 'dsh-enhanced-plugin-control-plane')
  replaceNode(coordinator.document, required(coordinator.rows, 'dsh-enhanced-plugin-control-plane'), 'config', coordinatorCp)
  return { targetPatch: target.document.toString({ lineWidth: 0 }), coordinatorPatch: coordinator.document.toString({ lineWidth: 0 }) }
}
