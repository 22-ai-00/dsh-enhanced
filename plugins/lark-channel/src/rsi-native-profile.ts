import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ActiveLarkOwnerBinding } from '@dsh-enhanced/assistant-delivery'
import { normalizeConfig, type AssistantGrowthDriverConfig } from '@dsh-enhanced/assistant-growth-driver'
import { defaultHostAttestationPolicy, normalizeControlPlaneConfig, runtimeConfigDigest,
  type Config as ControlPlaneConfig, type PluginControlTrustConfig, type RuntimeObserverTarget } from '@dsh-enhanced/plugin-control-plane'
import { isMap, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'
import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import type { RsiBuildEnvironment } from './rsi-build.js'
import type { RsiCreationBuildEnvironment } from './rsi-creation-build.js'
import type { NativeRsiBuildEnvironment, NativeRsiCreationBuildEnvironment } from './rsi-native-runtime-bootstrap.js'
import { createRsiMemoryLearningSetup, type RsiMemoryLearningSetup } from './rsi-memory-learning.js'
import { resolveRsiOwnerRoute } from './rsi-owner-profile.js'
import { createRsiPluginCreationSetup, type RsiPluginCreationSetup } from './rsi-plugin-creation.js'
import type { RsiSourceWorkspace } from './rsi-source.js'
import { rawLoaderConfig } from './rsi-bootstrap-manifest.js'

const day = 86_400_000
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const managed = {
  personal: '@dsh-enhanced/personal-assistant', delivery: '@dsh-enhanced/assistant-delivery',
  verifier: '@dsh-enhanced/assistant-verifier', growth: '@dsh-enhanced/assistant-growth-driver',
  control: '@dsh-enhanced/plugin-control-plane', memory: '@dsh-enhanced/assistant-memory-learning',
} as const
const ids = Object.fromEntries(Object.entries(managed).map(([key, name]) => [key, `dsh-enhanced-${name.slice('@dsh-enhanced/'.length)}`])) as Record<keyof typeof managed, string>
const prefix = 'rsi-native-'

export interface NativeRsiProfileInput {
  dshHome: string; targetProfile: string; targetEffective: string; targetPatch: string
  owner: ActiveLarkOwnerBinding; resources: RsiAuthorityResources; source: RsiSourceWorkspace
  sourceBuild: RsiBuildEnvironment['sourceBuild'] | NativeRsiBuildEnvironment['sourceBuild']
  creationBuild: RsiCreationBuildEnvironment | NativeRsiCreationBuildEnvironment
  executor: PluginControlTrustConfig['executor']; now: number; expiresAt: number
  observer: { socketPath: string; keyPath: string }
}
export interface NativeRsiSetupManifest {
  schemaVersion: 1; kind: 'native-plugin-learning'; targetProfile: string
  owner: { authorityId: string; authorityHash: string; principalId: string; principalRecordId: string;
    principalVersion: number; workspace: string; agentPreset: string }
  now: number; expiresAt: number; controlPlane: ControlPlaneConfig; growthDriver: AssistantGrowthDriverConfig
  memoryLearning: RsiMemoryLearningSetup; pluginCreation: RsiPluginCreationSetup
  limits: { periodMs: number; reviews: number; discovery: number; source: number; memoryExtractions: number; memoryScans: number }
}
export interface NativeRsiCompiledProfile { manifest: NativeRsiSetupManifest; targetPatch: string; trust: PluginControlTrustConfig }
function fail(message: string): never { throw new Error(`rsi native profile: ${message}`) }
function absolute(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0') || /[\r\n]/u.test(value)) fail(`${label} must be canonical absolute`)
  return value
}
function mapping(value: Node | undefined, label: string): YAMLMap { if (!isMap(value)) fail(`${label} must be a mapping`); return value }
function sequence(value: Node | undefined, label: string): YAMLSeq { if (!isSeq(value)) fail(`${label} must be a sequence`); return value }
function parseRows(value: string, label: string): { document: Document; rows: YAMLSeq; byId: Map<string, YAMLMap> } {
  const document = parseDocument(value, { uniqueKeys: true })
  if (document.errors.length) fail(`invalid ${label}: ${document.errors[0]!.message}`)
  const rows = sequence(document.contents ?? undefined, label), byId = new Map<string, YAMLMap>()
  for (const item of rows.items) {
    const entry = mapping(item as Node, label), id = entry.get('id')
    if (typeof id !== 'string' || !id || byId.has(id)) fail(`${label} has duplicate or invalid row id`)
    byId.set(id, entry)
  }
  return { document, rows, byId }
}
function effectiveRow(rows: Map<string, YAMLMap>, key: keyof typeof managed, disabled = false): YAMLMap {
  const result = rows.get(ids[key])
  if (!result || result.get('name') !== managed[key] || result.get('disabled') === true && !disabled) fail(`${key} bundle missing or package identity differs`)
  return result
}
function options(row: YAMLMap, label: string): YAMLMap { return mapping(row.get('config', true) as Node | undefined, `${label} config`) }
function plain(node: YAMLMap, label: string): Record<string, any> {
  const value = node.toJSON()
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`)
  return value as Record<string, any>
}
function setExact(document: Document, node: YAMLMap, key: string, value: unknown, label: string): void {
  if (node.has(key) && !isDeepStrictEqual((node.get(key, true) as Node).toJSON(), value)) fail(`${label} conflicts with native grant`)
  node.set(key, document.createNode(value))
}
function upsert(document: Document, sequence: YAMLSeq, value: Record<string, unknown>, label: string): void {
  const matches = sequence.items.filter(item => isMap(item) && item.get('id') === value.id)
  if (matches.length > 1 || matches.length === 1 && !isDeepStrictEqual((matches[0] as YAMLMap).toJSON(), value)) fail(`${label} conflicts with native grant`)
  if (!matches.length) sequence.add(document.createNode(value))
}
function copyConfig(out: ReturnType<typeof parseRows>, effective: ReturnType<typeof parseRows>, key: keyof typeof managed): YAMLMap {
  const source = options(effectiveRow(effective.byId, key), key)
  let row = out.byId.get(ids[key])
  if (!row) { row = mapping(out.document.createNode({ id: ids[key] }), key); out.rows.add(row); out.byId.set(ids[key], row) }
  if (row.get('name') !== undefined && row.get('name') !== managed[key] || row.get('disabled') === true) fail(`${key} patch override differs`)
  // Retain !!js scalars and unrelated effective options verbatim.
  row.set('config', source.clone())
  return options(row, key)
}
function chooseModel(growth: YAMLMap): Partial<AssistantGrowthDriverConfig> {
  const value = plain(growth, 'growth')
  if (value.provider === undefined && value.model === undefined && value.reasoningEffort === undefined) return {}
  if (typeof value.provider !== 'string' || !value.provider || typeof value.model !== 'string' || !value.model
    || value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !value.reasoningEffort)) fail('existing growth model override is invalid')
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}
function rule(scope: { workspace: string; principal: string; preset: string }, id: string,
  subjectId: string, action: string, resourceKind: string, resourceId: string, initiator: string) {
  return { id: `${prefix}${id}`, effect: 'allow', subject: { kind: subjectId === scope.preset ? 'agent' : 'background', id: subjectId,
    workspace: scope.workspace, principal: scope.principal }, actions: [action], resource: { kind: resourceKind, id: resourceId },
    context: { initiators: [initiator] } }
}

/** Pure profile composition: prepared identities/builds are inputs, and the caller owns I/O and activation. */
export function compileNativeRsiProfile(input: NativeRsiProfileInput): NativeRsiCompiledProfile {
  absolute(input.dshHome, 'dshHome')
  if (!profilePattern.test(input.targetProfile) || !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= input.now || input.expiresAt - input.now > 365 * day) fail('profile or authority lifetime is invalid')
  const resources = input.resources, installation = resources?.installationId
  if (resources?.schemaVersion !== 1 || resources.root !== join(input.dshHome, 'rsi-authorities', input.targetProfile)
    || resources.stateRoot !== join(resources.root, 'state') || resources.configRoot !== join(resources.root, 'config')
    || resources.catalog.path !== join(resources.root, 'catalog.json') || !installation) fail('prepared resources differ from target installation')
  for (const path of [input.source?.repository, input.source?.baseline.remote, input.observer?.socketPath,
    input.observer?.keyPath, input.executor?.path]) absolute(path, 'prepared path')
  if (input.source.schemaVersion !== 1 || input.sourceBuild.versioning !== 'patch'
    || input.creationBuild.sourceCommit !== input.source.sourceCommit) fail('creation build differs from prepared source')
  if ('backend' in input.sourceBuild && input.sourceBuild.backend === 'macos-seatbelt') {
    if (input.creationBuild.schemaVersion !== 2 || input.creationBuild.backend !== 'macos-seatbelt'
      || !isDeepStrictEqual(input.creationBuild.runtime, input.sourceBuild.runtime)) fail('native creation runtime differs')
  } else {
    if ('backend' in input.sourceBuild || input.creationBuild.schemaVersion !== 1
      || input.creationBuild.sourceImage !== input.sourceBuild.image
      || input.creationBuild.dockerPath !== input.sourceBuild.dockerPath
      || input.creationBuild.socketPath !== input.sourceBuild.socketPath) fail('creation build differs from prepared source')
  }
  if (!/^[a-f0-9]{64}$/u.test(input.executor.sha256) || !input.executor.id || !input.executor.version
    || !Array.isArray(input.executor.environmentAllowlist)) fail('executor pin is invalid')
  const effective = parseRows(input.targetEffective, 'effective profile'), out = parseRows(input.targetPatch, 'target patch')
  for (const key of Object.keys(managed) as (keyof typeof managed)[]) effectiveRow(effective.byId, key, key === 'memory')
  for (const [id, row] of effective.byId) if (id.startsWith('dsh-enhanced-')) {
    const name = row.get('name')
    if (typeof name !== 'string' || id !== `dsh-enhanced-${name.replace(/^@dsh-enhanced\//u, '')}` || !name.startsWith('@dsh-enhanced/')) fail(`bundle ${id} package identity differs`)
  }
  const standalone = effective.byId.get('dsh-enhanced-assistant-automations')
  if (standalone && standalone.get('disabled') !== true) fail('standalone Automations conflicts with embedded provider')
  const standaloneMemory = effective.byId.get('dsh-enhanced-personal-memory')
  if (standaloneMemory && standaloneMemory.get('disabled') !== true) fail('standalone Memory conflicts with embedded provider')
  const delivery = options(effectiveRow(effective.byId, 'delivery'), 'delivery')
  const resolved = resolveRsiOwnerRoute(plain(delivery, 'delivery'), input.owner, input.dshHome)
  const owner = { authorityId: resolved.route.id, authorityHash: resolved.route.authorityHash, principalId: resolved.principal,
    principalRecordId: input.owner.owner.id, principalVersion: input.owner.owner.version,
    workspace: resolved.workspace, agentPreset: resolved.preset }
  const scope = { ownerRouteId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace, preset: owner.agentPreset }
  const creation = createRsiPluginCreationSetup({ resources, build: input.creationBuild, owner, now: input.now, expiresAt: input.expiresAt })
  const memory = createRsiMemoryLearningSetup({ installationId: installation, stateRoot: resources.stateRoot,
    owner, now: input.now, expiresAt: input.expiresAt })
  const currentLearner = effectiveRow(effective.byId, 'memory', true)
  if (currentLearner.get('disabled') !== true && !isDeepStrictEqual(plain(options(currentLearner, 'memory'), 'memory'), memory.learning)) fail('existing memory learner grant differs')
  const growthCurrent = effectiveRow(effective.byId, 'growth')
  const growth: AssistantGrowthDriverConfig = { enabled: true, intervalMs: 0, maxReviewsPerWake: 1, minRepeatedSuccesses: 2,
    budgetId: `rsi-reviews-${installation}`, budgetAmount: 1, ...chooseModel(growthCurrent.has('config') ? options(growthCurrent, 'growth') : mapping(out.document.createNode({}), 'growth')),
    scope, workflowOwnerAnchored: { enabled: true },
    usageLearning: { enabled: true, databasePath: join(resources.stateRoot, 'growth.sqlite'), scanBudgetId: `rsi-discovery-${installation}`, scanBudgetAmount: 1 },
    pluginSourceProposals: { enabled: true, allowModification: false, allowCreation: true, allowRevision: false,
      preparationMode: 'durable', repository: input.source.repository, maxPlansPerWake: 1, offline: true, planTtlMs: day } }
  normalizeConfig(growth)
  const sourceBuildForControl: NonNullable<ControlPlaneConfig['sourceBuild']> = 'backend' in input.sourceBuild
    ? { ...input.sourceBuild, stateRoot: join(resources.stateRoot, 'native-source-build'),
      authorityDigest: createHash('sha256').update(JSON.stringify({ installation, owner, sourceCommit: input.source.sourceCommit,
        runtime: input.sourceBuild.runtime, expiresAt: input.expiresAt })).digest('hex'),
      expiresAt: input.expiresAt, maxRuns: 1000, maxTotalDurationMs: day }
    : input.sourceBuild
  const control: ControlPlaneConfig = { catalogPath: resources.catalog.path, statePath: join(resources.stateRoot, 'control-plane'),
    trustPath: join(resources.configRoot, 'native-trust.json'), sourceBuild: sourceBuildForControl,
    sourceJobs: { authorityId: `source-jobs-${installation}`, expiresAt: input.expiresAt, maxSubmissions: 1000,
      allowedModes: ['create'], repository: input.source.repository, baseline: { ...input.source.baseline }, creation: creation.creation,
      ...scope, budgetId: `rsi-source-${installation}`, budgetAmount: 1 },
    creationVerifications: creation.verifications, creationCapabilities: creation.capabilities,
    runtimeObserver: { socketPath: input.observer.socketPath, keyPath: input.observer.keyPath,
      profilePath: join(input.dshHome, 'profiles', input.targetProfile), targets: [] } }
  // The observer pins the final Loader options after all mutations below.
  if (resolved.created) {
    const targetDelivery = copyConfig(out, effective, 'delivery')
    const routes = sequence(targetDelivery.get('ownerRoutes', true) as Node | undefined, 'delivery ownerRoutes')
    routes.add(out.document.createNode(resolved.authority))
  }
  const personal = copyConfig(out, effective, 'personal')
  const policy = mapping(personal.get('assistantPolicy', true) as Node | undefined, 'assistantPolicy')
  const automations = mapping(personal.get('assistantAutomations', true) as Node | undefined, 'assistantAutomations')
  if (automations.get('allowUnbudgetedExecution') === true) fail('unbudgeted Automations is forbidden')
  automations.set('schedulerEnabled', true)
  const budgets = sequence(policy.get('budgets', true) as Node | undefined, 'policy budgets')
  const limits = { periodMs: day, reviews: 7, discovery: 1440, source: 7, memoryExtractions: memory.limits.extractions,
    memoryScans: memory.limits.scans }
  const existingGlobal = budgets.items.filter(item => isMap(item) && item.get('metric') === 'automation-runs'
    && item.get('scope') === 'global' && item.get('periodMs') === day)
  if (existingGlobal.length) {
    const values = new Set(existingGlobal.map(item => (item as YAMLMap).get('limit')))
    if (values.size !== 1 || !Number.isSafeInteger([...values][0]) || Number([...values][0]) < 1) fail('global automation budget conflicts')
    limits.reviews = Number([...values][0])
  }
  for (const [id, limit, subject] of [[growth.budgetId!, limits.reviews, 'global'],
    [growth.usageLearning!.scanBudgetId!, limits.discovery, 'subject'],
    [control.sourceJobs!.budgetId, limits.source, 'subject'],
    [memory.learning.budgetId, limits.memoryExtractions, 'workspace'],
    [memory.learning.scanBudgetId, limits.memoryScans, 'subject']] as const) {
    if (subject === 'workspace' && budgets.items.some(item => isMap(item) && item.get('id') !== id
      && item.get('metric') === 'automation-runs' && item.get('scope') === 'workspace' && item.get('periodMs') === day)) fail('workspace memory budget conflicts')
    upsert(out.document, budgets, { id, metric: 'automation-runs', limit, periodMs: day, scope: subject }, 'Policy budget')
  }
  const rules = sequence(policy.get('rules', true) as Node | undefined, 'policy rules')
  const policyScope = { workspace: owner.workspace, principal: owner.principalId, preset: owner.agentPreset }
  const add = (id: string, subject: string, action: string, kind: string, resource: string, initiator = 'background') =>
    upsert(out.document, rules, rule(policyScope, id, subject, action, kind, resource, initiator), 'Policy rule')
  for (const [id, subject, automation] of [['usage', 'assistant-growth-usage', 'usage-*'],
    ['source', 'plugin-control-plane-source', 'source-job-*'], ['memory-scan', 'assistant-memory-learning', 'memory-scan-*'],
    ['memory-job', 'assistant-memory-learning', 'memory-learning:*']] as const) {
    add(`${id}-reconcile`, subject, 'reconcile', 'automation', automation)
    add(`${id}-execute`, automation, 'execute', 'automation', automation)
  }
  for (const [action, authority] of [['extract', memory.learning.authorityId], ['review', memory.reviews.authorityId],
    ['adopt', memory.adoption.authorityId]] as const) add(`memory-${action}`, 'assistant-memory-learning', action, 'memory', `learning:${authority}`)
  for (const tool of ['growth_*', 'plugin_source_*'] as const) add(tool, owner.agentPreset, 'execute', 'tool', tool)
  add('created-tools', owner.agentPreset, 'execute', 'tool', `evolved_${creation.creation.namePrefix.replaceAll('-', '_')}*`, 'external')
  add('verified-workflows', owner.agentPreset, 'draft', 'evolution', 'verified-workflows')
  const embeddedMemory = mapping(personal.get('personalMemory', true) as Node | undefined, 'personalMemory')
  setExact(out.document, embeddedMemory, 'automaticLearning', memory.adoption, 'memory adoption')
  const verifier = copyConfig(out, effective, 'verifier')
  setExact(out.document, verifier, 'memoryReviews', memory.reviews, 'memory review')
  setExact(out.document, verifier, 'creationReviews', creation.reviews, 'creation review')
  const learner = out.byId.get(ids.memory) ?? mapping(out.document.createNode({ id: ids.memory }), 'learner patch')
  if (!out.byId.has(ids.memory)) { out.rows.add(learner); out.byId.set(ids.memory, learner) }
  if (learner.get('name') !== undefined && learner.get('name') !== managed.memory) fail('learner patch package differs')
  learner.set('name', managed.memory); learner.set('disabled', false)
  setExact(out.document, learner, 'config', memory.learning, 'memory learner')
  const growthRow = copyConfig(out, effective, 'growth')
  if (growthRow.has('pluginSourceProposals') && !isDeepStrictEqual((growthRow.get('pluginSourceProposals', true) as Node).toJSON(), growth.pluginSourceProposals)) fail('existing source proposal grant differs')
  out.byId.get(ids.growth)!.set('config', out.document.createNode(growth))
  const controlRow = copyConfig(out, effective, 'control')
  for (const key of ['sourceJobs', 'sourceApprovals', 'sourceReleases', 'sourceAdoptions', 'creationVerifications', 'creationCapabilities'] as const) {
    if (controlRow.has(key) && !isDeepStrictEqual((controlRow.get(key, true) as Node).toJSON(), control[key as keyof ControlPlaneConfig])) fail(`existing ${key} grant differs`)
  }
  out.byId.get(ids.control)!.set('config', out.document.createNode(control))
  const final = parseRows(out.document.toString({ lineWidth: 0 }), 'compiled target')
  const targets: RuntimeObserverTarget[] = []
  for (const [key, services] of [['personal', ['personalMemory', 'assistantPolicy', 'assistantAutomations']],
    ['delivery', ['assistantDelivery']], ['verifier', ['assistantVerifier']], ['growth', ['assistantGrowthDriver']],
    ['memory', ['assistantMemoryLearning']]] as const) {
    const finalRow = final.byId.get(ids[key]) ?? effectiveRow(effective.byId, key)
    targets.push({ entryId: ids[key], module: managed[key], configDigest: runtimeConfigDigest(rawLoaderConfig(finalRow.get('config', true) as Node, key)), services: [...services] })
  }
  const larkRow = effective.byId.get('dsh-enhanced-lark-channel')
  if (!larkRow || larkRow.get('disabled') === true || larkRow.get('name') !== '@dsh-enhanced/lark-channel') fail('active Lark channel is required')
  targets.push({ entryId: 'dsh-enhanced-lark-channel', module: '@dsh-enhanced/lark-channel',
    configDigest: runtimeConfigDigest(rawLoaderConfig(larkRow.get('config', true) as Node, 'lark-channel')),
    services: ['larkChannel'] })
  control.runtimeObserver!.targets = targets
  normalizeControlPlaneConfig(control)
  final.byId.get(ids.control)!.set('config', final.document.createNode(control))
  const trust = { schemaVersion: 2, installationId: installation, dshHome: input.dshHome,
    ledger: { id: resources.ledgerId, path: join(resources.stateRoot, 'control-plane', 'control.sqlite') },
    executor: { ...input.executor, environmentAllowlist: [...input.executor.environmentAllowlist] },
    hostPolicy: defaultHostAttestationPolicy, hostAttestor: null,
    approvalKeys: [{ authority: resources.identities.approval.authority, keyId: resources.identities.approval.keyId,
      publicKeyPem: resources.identities.approval.publicKeyPem }],
    hostAttestationKeys: [{ authority: resources.identities.host.authority, keyId: resources.identities.host.keyId,
      publicKeyPem: resources.identities.host.publicKeyPem }] } as unknown as PluginControlTrustConfig
  const manifest: NativeRsiSetupManifest = { schemaVersion: 1, kind: 'native-plugin-learning', targetProfile: input.targetProfile,
    owner, now: input.now, expiresAt: input.expiresAt, controlPlane: control, growthDriver: growth, memoryLearning: memory,
    pluginCreation: creation, limits }
  return { manifest, targetPatch: final.document.toString({ lineWidth: 0 }), trust }
}
