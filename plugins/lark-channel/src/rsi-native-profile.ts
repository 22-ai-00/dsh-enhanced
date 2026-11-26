import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ActiveLarkOwnerBinding } from '@dsh-ray/assistant-delivery'
import { normalizeConfig, type AssistantGrowthDriverConfig } from '@dsh-ray/assistant-growth-driver'
import { defaultHostAttestationPolicy, normalizeControlPlaneConfig, runtimeConfigDigest,
  type Config as ControlPlaneConfig, type PluginControlTrustConfig, type RuntimeObserverTarget } from '@dsh-ray/plugin-control-plane'
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'
import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import type { NativeRsiBuildEnvironment, NativeRsiCreationBuildEnvironment } from './rsi-native-runtime-bootstrap.js'
import { createRsiMemoryLearningSetup, type RsiMemoryLearningSetup } from './rsi-memory-learning.js'
import { createRsiOrdinaryUseLearningSetup, type RsiOrdinaryUseLearningSetup } from './rsi-ordinary-use-learning.js'
import { resolveRsiOwnerRoute } from './rsi-owner-profile.js'
import { createRsiPluginCreationSetup, type RsiPluginCreationSetup } from './rsi-plugin-creation.js'
import { createRsiPluginRevisionSetup, type RsiPluginRevisionSetup } from './rsi-plugin-revision.js'
import type { RsiSourceWorkspace } from './rsi-source.js'
import { rawLoaderConfig } from './rsi-bootstrap-manifest.js'
import { SELF_ITERATION_MANAGED_ROW_IDS } from './rsi-profile.js'

const day = 86_400_000
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const managed = {
  personal: '@dsh-ray/personal-assistant', delivery: '@dsh-ray/assistant-delivery',
  verifier: '@dsh-ray/assistant-verifier', growth: '@dsh-ray/assistant-growth-driver',
  control: '@dsh-ray/plugin-control-plane', memory: '@dsh-ray/assistant-memory-learning',
} as const
const ids = Object.fromEntries(Object.entries(managed).map(([key, name]) => [key, `dsh-ray-${name.slice('@dsh-ray/'.length)}`])) as Record<keyof typeof managed, string>
const prefix = 'rsi-native-'

export interface NativeRsiProfileInput {
  dshHome: string; targetProfile: string; targetEffective: string; targetPatch: string
  owner: ActiveLarkOwnerBinding; resources: RsiAuthorityResources; source: RsiSourceWorkspace
  sourceBuild: NativeRsiBuildEnvironment['sourceBuild']
  creationBuild: NativeRsiCreationBuildEnvironment
  executor: PluginControlTrustConfig['executor']; now: number; expiresAt: number
  observer: { socketPath: string; keyPath: string }
  /** Fresh-install-only opt-in for the no-signing-key ordinary-use learning rings. */
  enableOrdinaryUseLearning?: boolean
  /** Defaults to true when creationBuild is present; pass false to explicitly opt out. */
  enableRevision?: boolean
  /** Explicit evaluator route; otherwise the composed Delivery agentProvider/agentModel is used. */
  intakeProvider?: string
  intakeModel?: string
  /** Explicit owner-authorized in-place upgrade mode. */
  upgradeExistingOwner?: boolean
}
export interface NativeRsiSetupManifest {
  schemaVersion: 1; kind: 'native-plugin-learning'; targetProfile: string
  owner: { authorityId: string; authorityHash: string; principalId: string; principalRecordId: string;
    principalVersion: number; workspace: string; agentPreset: string }
  now: number; expiresAt: number; controlPlane: ControlPlaneConfig; growthDriver: AssistantGrowthDriverConfig
  memoryLearning: RsiMemoryLearningSetup; pluginCreation: RsiPluginCreationSetup
  pluginRevision?: RsiPluginRevisionSetup
  /** Fresh-install ordinary-use rings that need no new signing-key material. */
  ordinaryUseLearning?: RsiOrdinaryUseLearningSetup
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
function sameAuthorityOwnerGrant(existing: unknown, expected: { authorityId: string; owner: unknown }): boolean {
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) return false
  if (typeof expected.authorityId !== 'string' || !expected.authorityId
    || expected.owner === null || typeof expected.owner !== 'object' || Array.isArray(expected.owner)) return false
  const record = existing as { authorityId?: unknown; owner?: unknown }
  return record.authorityId === expected.authorityId && isDeepStrictEqual(record.owner, expected.owner)
}
function sameVerificationAuthorityGrant(existing: unknown, expected: unknown): boolean {
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) return false
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return false
  const existingRecord = existing as { authority?: unknown; publicKey?: unknown }
  const expectedRecord = expected as { authority?: unknown; publicKey?: unknown }
  if (typeof expectedRecord.publicKey !== 'string' || !expectedRecord.publicKey
    || existingRecord.publicKey !== expectedRecord.publicKey) return false
  if (existingRecord.authority === null || typeof existingRecord.authority !== 'object' || Array.isArray(existingRecord.authority)) return false
  if (expectedRecord.authority === null || typeof expectedRecord.authority !== 'object' || Array.isArray(expectedRecord.authority)) return false
  const existingAuth = existingRecord.authority as Record<string, unknown>
  const expectedAuth = expectedRecord.authority as Record<string, unknown>
  if (typeof expectedAuth.protocol !== 'string' || !expectedAuth.protocol
    || typeof expectedAuth.authorityId !== 'string' || !expectedAuth.authorityId
    || typeof expectedAuth.keyId !== 'string' || !expectedAuth.keyId
    || typeof expectedAuth.namePrefix !== 'string' || !expectedAuth.namePrefix
    || !Number.isSafeInteger(expectedAuth.expiresAt)) return false
  return existingAuth.protocol === expectedAuth.protocol
    && existingAuth.authorityId === expectedAuth.authorityId
    && existingAuth.keyId === expectedAuth.keyId
    && existingAuth.namePrefix === expectedAuth.namePrefix
    && existingAuth.expiresAt === expectedAuth.expiresAt
    && (expectedAuth.owner === undefined ? existingAuth.owner === undefined : isDeepStrictEqual(existingAuth.owner, expectedAuth.owner))
}
function setExact(document: Document, node: YAMLMap, key: string, value: unknown, label: string): void {
  if (node.has(key) && !isDeepStrictEqual((node.get(key, true) as Node).toJSON(), value)) fail(`${label} conflicts with native grant`)
  node.set(key, document.createNode(value))
}
function upsert(document: Document, sequence: YAMLSeq, value: Record<string, unknown>, label: string, replace = false): void {
  const index = sequence.items.findIndex(item => isMap(item) && item.get('id') === value.id)
  const matches = sequence.items.filter(item => isMap(item) && item.get('id') === value.id)
  if (matches.length > 1 || matches.length === 1 && !replace && !isDeepStrictEqual((matches[0] as YAMLMap).toJSON(), value)) fail(`${label} conflicts with native grant`)
  if (index < 0) sequence.add(document.createNode(value))
  else if (replace) sequence.items[index] = document.createNode(value)
}
function copyConfig(out: ReturnType<typeof parseRows>, effective: ReturnType<typeof parseRows>,
  key: keyof typeof managed, allowDisabled = false): YAMLMap {
  const effectiveConfig = effectiveRow(effective.byId, key, allowDisabled)
  const source = key === 'growth' && !effectiveConfig.has('config')
    ? mapping(out.document.createNode({}), 'growth config') : options(effectiveConfig, key)
  let row = out.byId.get(ids[key])
  if (!row) { row = mapping(out.document.createNode({ id: ids[key] }), key); out.rows.add(row); out.byId.set(ids[key], row) }
  if (row.get('name') !== undefined && row.get('name') !== managed[key]
    || (row.get('disabled') === true && !allowDisabled)) fail(`${key} patch override differs`)
  if (row.get('disabled') === true && allowDisabled) row.set('disabled', false)
  // Retain !!js scalars and unrelated effective options verbatim.
  row.set('config', source.clone())
  return options(row, key)
}
/** Copy one optional ordinary-use row by exact id and package; never guess its location. */
function copyNamedConfig(out: ReturnType<typeof parseRows>, effective: ReturnType<typeof parseRows>,
  id: string, name: string, label: string, allowDisabled = false): YAMLMap {
  const source = effective.byId.get(id)
  if (!source || source.get('name') !== name || (source.get('disabled') === true && !allowDisabled)) {
    fail(`${label} bundle missing or disabled`)
  }
  const sourceConfig = source.get('config', true) as Node | undefined
  if (sourceConfig !== undefined && !isMap(sourceConfig)) fail(`${label} config must be a mapping`)
  let row = out.byId.get(id)
  if (!row) { row = mapping(out.document.createNode({ id }), label); out.rows.add(row); out.byId.set(id, row) }
  if (row.get('name') !== undefined && row.get('name') !== name
    || (row.get('disabled') === true && !allowDisabled)) fail(`${label} patch override differs`)
  if (row.get('disabled') === true && allowDisabled) row.set('disabled', false)
  row.set('config', sourceConfig === undefined ? out.document.createNode({}) : sourceConfig.clone())
  return options(row, label)
}
/** Set one leaf exactly while creating only missing parent mappings. */
function setExactAt(document: Document, node: YAMLMap, path: readonly string[], value: unknown, label: string): void {
  let current = node
  for (const key of path.slice(0, -1)) {
    const next = current.get(key, true) as Node | undefined
    if (next === undefined) {
      const created = mapping(document.createNode({}), `${label}.${key}`)
      current.set(key, created)
      current = created
    } else current = mapping(next, `${label}.${key}`)
  }
  const leaf = path[path.length - 1]!
  if (current.has(leaf) && !isDeepStrictEqual((current.get(leaf, true) as Node).toJSON(), value)) {
    fail(`${label} conflicts with native grant`)
  }
  current.set(leaf, document.createNode(value))
}
/** Provider ids exposed by any composed LLM row's `providers` mapping. */
function llmProviderIds(rows: ReadonlyMap<string, YAMLMap>): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const row of rows.values()) {
    if (row.get('disabled') === true) continue
    const config = row.get('config', true)
    if (!isMap(config)) continue
    const providers = config.get('providers', true)
    if (!isMap(providers)) continue
    for (const pair of providers.items) {
      const key = (pair as { key?: unknown }).key
      const value = isScalar(key) ? key.value : key
      if (typeof value === 'string' && value.length > 0) ids.add(value)
    }
  }
  return ids
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
  if (input.sourceBuild.backend !== 'macos-seatbelt'
    || input.creationBuild.schemaVersion !== 2 || input.creationBuild.backend !== 'macos-seatbelt'
    || !isDeepStrictEqual(input.creationBuild.runtime, input.sourceBuild.runtime)) fail('native creation runtime differs')
  if (!/^[a-f0-9]{64}$/u.test(input.executor.sha256) || !input.executor.id || !input.executor.version
    || !Array.isArray(input.executor.environmentAllowlist)) fail('executor pin is invalid')
  if (input.enableOrdinaryUseLearning !== undefined && typeof input.enableOrdinaryUseLearning !== 'boolean'
    || input.intakeProvider !== undefined && typeof input.intakeProvider !== 'string'
    || input.intakeModel !== undefined && typeof input.intakeModel !== 'string') fail('ordinary-use learning inputs are invalid')
  const upgrading = input.upgradeExistingOwner === true
  const effective = parseRows(input.targetEffective, 'effective profile'), out = parseRows(input.targetPatch, 'target patch')
  for (const key of Object.keys(managed) as (keyof typeof managed)[]) {
    effectiveRow(effective.byId, key, key === 'memory' || (upgrading && SELF_ITERATION_MANAGED_ROW_IDS.has(ids[key])))
  }
  for (const [id, row] of effective.byId) if (id.startsWith('dsh-ray-')) {
    const name = row.get('name')
    if (typeof name !== 'string' || id !== `dsh-ray-${name.replace(/^@dsh-ray\//u, '')}` || !name.startsWith('@dsh-ray/')) fail(`bundle ${id} package identity differs`)
  }
  const standalone = effective.byId.get('dsh-ray-assistant-automations')
  if (standalone && standalone.get('disabled') !== true) fail('standalone Automations conflicts with embedded provider')
  const standaloneMemory = effective.byId.get('dsh-ray-personal-memory')
  if (standaloneMemory && standaloneMemory.get('disabled') !== true) fail('standalone Memory conflicts with embedded provider')
  const delivery = options(effectiveRow(effective.byId, 'delivery'), 'delivery')
  const deliveryConfig = plain(delivery, 'delivery')
  const resolved = resolveRsiOwnerRoute(deliveryConfig, input.owner, input.dshHome)
  const owner = { authorityId: resolved.route.id, authorityHash: resolved.route.authorityHash, principalId: resolved.principal,
    principalRecordId: input.owner.owner.id, principalVersion: input.owner.owner.version,
    workspace: resolved.workspace, agentPreset: resolved.preset }
  const scope = { ownerRouteId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace, preset: owner.agentPreset }
  const ordinary = input.enableOrdinaryUseLearning === true
    ? createRsiOrdinaryUseLearningSetup({ deliveryConfig, intakeProvider: input.intakeProvider,
      intakeModel: input.intakeModel, llmProviders: llmProviderIds(effective.byId) })
    : undefined
  if (ordinary === undefined && (input.intakeProvider !== undefined || input.intakeModel !== undefined)) {
    fail('an explicit intake route requires enableOrdinaryUseLearning')
  }
  if (input.enableRevision !== undefined && typeof input.enableRevision !== 'boolean') {
    fail('invalid native revision opt-in')
  }
  const enableRevision = input.enableRevision ?? (input.creationBuild !== undefined)
  const creation = createRsiPluginCreationSetup({ resources, build: input.creationBuild, owner, now: input.now, expiresAt: input.expiresAt })
  const revision = enableRevision
    ? createRsiPluginRevisionSetup({ resources, build: input.creationBuild, owner, now: input.now, expiresAt: input.expiresAt })
    : undefined
  const memory = createRsiMemoryLearningSetup({ installationId: installation, stateRoot: resources.stateRoot,
    owner, now: input.now, expiresAt: input.expiresAt, workItemExperiences: ordinary !== undefined })
  const currentLearner = effectiveRow(effective.byId, 'memory', true)
  if (upgrading) {
    if (currentLearner.has('config')) {
      const currentConfig = plain(options(currentLearner, 'memory'), 'memory')
      if (!sameAuthorityOwnerGrant(currentConfig, memory.learning)) fail('existing memory learner grant differs')
    } else if (currentLearner.get('disabled') !== true) {
      fail('existing memory learner grant differs')
    }
  } else if (currentLearner.get('disabled') !== true
    && !isDeepStrictEqual(plain(options(currentLearner, 'memory'), 'memory'), memory.learning)) {
    fail('existing memory learner grant differs')
  }
  const growthCurrent = effectiveRow(effective.byId, 'growth', upgrading)
  const growth: AssistantGrowthDriverConfig = { enabled: true, intervalMs: 0, maxReviewsPerWake: 1, minRepeatedSuccesses: 2,
    budgetId: `rsi-reviews-${installation}`, budgetAmount: 1, ...chooseModel(growthCurrent.has('config') ? options(growthCurrent, 'growth') : mapping(out.document.createNode({}), 'growth')),
    scope, workflowOwnerAnchored: { enabled: true },
    usageLearning: { enabled: true, databasePath: join(resources.stateRoot, 'growth.sqlite'), scanBudgetId: `rsi-discovery-${installation}`, scanBudgetAmount: 1 },
    pluginSourceProposals: { enabled: true, allowModification: false, allowCreation: true, allowRevision: enableRevision,
      preparationMode: 'durable', repository: input.source.repository, maxPlansPerWake: 1, offline: true, planTtlMs: day } }
  normalizeConfig(growth)
  const sourceBuildForControl: NonNullable<ControlPlaneConfig['sourceBuild']> =
    { ...input.sourceBuild, stateRoot: join(resources.stateRoot, 'native-source-build'),
      authorityDigest: createHash('sha256').update(JSON.stringify({ installation, owner, sourceCommit: input.source.sourceCommit,
        runtime: input.sourceBuild.runtime, expiresAt: input.expiresAt })).digest('hex'),
      expiresAt: input.expiresAt, maxRuns: 1000, maxTotalDurationMs: day }
  const control: ControlPlaneConfig = { catalogPath: resources.catalog.path, statePath: join(resources.stateRoot, 'control-plane'),
    trustPath: join(resources.configRoot, 'native-trust.json'), sourceBuild: sourceBuildForControl,
    sourceJobs: { authorityId: `source-jobs-${installation}`, expiresAt: input.expiresAt, maxSubmissions: 1000,
      allowedModes: enableRevision ? ['create', 'revise-created'] : ['create'], repository: input.source.repository,
      baseline: { ...input.source.baseline }, creation: creation.creation,
      ...(revision ? { revision: revision.revision } : {}),
      ...scope, budgetId: `rsi-source-${installation}`, budgetAmount: 1 },
    creationVerifications: creation.verifications, creationCapabilities: creation.capabilities,
    ...(revision ? { revisionVerifications: revision.verifications, revisionRegressions: revision.regressionVerifications } : {}),
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
    upsert(out.document, budgets, { id, metric: 'automation-runs', limit, periodMs: day, scope: subject }, 'Policy budget', upgrading)
  }
  const rules = sequence(policy.get('rules', true) as Node | undefined, 'policy rules')
  const policyScope = { workspace: owner.workspace, principal: owner.principalId, preset: owner.agentPreset }
  const add = (id: string, subject: string, action: string, kind: string, resource: string, initiator = 'background') => {
    const nextRule = rule(policyScope, id, subject, action, kind, resource, initiator)
    if (upgrading) {
      const existingRule = rules.items.find(item => isMap(item) && item.get('id') === nextRule.id) as YAMLMap | undefined
      if (existingRule !== undefined) {
        const existingSubject = existingRule.get('subject', true)
        const subjectJson = isMap(existingSubject) ? existingSubject.toJSON() as { workspace?: unknown; principal?: unknown } : undefined
        if (!subjectJson || subjectJson.workspace !== owner.workspace || subjectJson.principal !== owner.principalId) {
          fail('Policy rule conflicts with native grant')
        }
      }
    }
    upsert(out.document, rules, nextRule, 'Policy rule', upgrading)
  }
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
  const setGrant = (node: YAMLMap, key: string, expected: { authorityId: string; owner: unknown }, label: string) => {
    if (node.has(key)) {
      const parsed = (node.get(key, true) as Node).toJSON()
      if (upgrading ? !sameAuthorityOwnerGrant(parsed, expected) : !isDeepStrictEqual(parsed, expected)) {
        fail(`${label} conflicts with native grant`)
      }
    }
    node.set(key, out.document.createNode(expected))
  }
  const embeddedMemory = mapping(personal.get('personalMemory', true) as Node | undefined, 'personalMemory')
  setGrant(embeddedMemory, 'automaticLearning', memory.adoption, 'memory adoption')
  const verifier = copyConfig(out, effective, 'verifier')
  setGrant(verifier, 'memoryReviews', memory.reviews, 'memory review')
  setGrant(verifier, 'creationReviews', creation.reviews, 'creation review')
  if (revision) {
    setGrant(verifier, 'revisionReviews', revision.reviews, 'revision review')
    setGrant(verifier, 'revisionRegressions', revision.regressions, 'revision regression')
  } else if (verifier.has('revisionReviews') || verifier.has('revisionRegressions')) {
    fail('existing revision review grant differs')
  }
  const learner = out.byId.get(ids.memory) ?? mapping(out.document.createNode({ id: ids.memory }), 'learner patch')
  if (!out.byId.has(ids.memory)) { out.rows.add(learner); out.byId.set(ids.memory, learner) }
  if (learner.get('name') !== undefined && learner.get('name') !== managed.memory) fail('learner patch package differs')
  learner.set('name', managed.memory); learner.set('disabled', false)
  setGrant(learner, 'config', memory.learning, 'memory learner')
  const growthRow = copyConfig(out, effective, 'growth', upgrading)
  if (growthRow.has('pluginSourceProposals')) {
    if (upgrading) {
      if (growthRow.has('scope') && !isDeepStrictEqual((growthRow.get('scope', true) as Node).toJSON(), growth.scope)) {
        fail('existing source proposal grant differs')
      }
      if (growthRow.has('budgetId') && growthRow.get('budgetId') !== growth.budgetId) {
        fail('existing source proposal grant differs')
      }
    } else if (!isDeepStrictEqual((growthRow.get('pluginSourceProposals', true) as Node).toJSON(), growth.pluginSourceProposals)) {
      fail('existing source proposal grant differs')
    }
  }
  out.byId.get(ids.growth)!.set('config', out.document.createNode(growth))
  const controlRow = copyConfig(out, effective, 'control')
  for (const key of ['sourceJobs', 'sourceApprovals', 'sourceReleases', 'sourceAdoptions', 'creationVerifications',
    'creationCapabilities', 'revisionVerifications', 'revisionRegressions'] as const) {
    if (!controlRow.has(key)) continue
    if (key === 'sourceApprovals' || key === 'sourceReleases' || key === 'sourceAdoptions') {
      fail(`existing ${key} grant differs`)
    }
    const existingGrant = (controlRow.get(key, true) as Node).toJSON() as Record<string, unknown> | null
    const expectedGrant = control[key as keyof ControlPlaneConfig] as Record<string, unknown> | undefined
    if (!upgrading || expectedGrant === undefined) {
      if (!isDeepStrictEqual(existingGrant, expectedGrant)) fail(`existing ${key} grant differs`)
      continue
    }
    if (key === 'sourceJobs') {
      const expectedJobs = control.sourceJobs!
      if (!existingGrant || typeof existingGrant !== 'object' || Array.isArray(existingGrant)
        || existingGrant.authorityId !== expectedJobs.authorityId
        || existingGrant.ownerRouteId !== expectedJobs.ownerRouteId
        || existingGrant.principalId !== expectedJobs.principalId
        || existingGrant.workspace !== expectedJobs.workspace
        || existingGrant.preset !== expectedJobs.preset) {
        fail(`existing ${key} grant differs`)
      }
    } else if (key === 'creationVerifications' || key === 'revisionVerifications' || key === 'revisionRegressions') {
      if (!sameVerificationAuthorityGrant(existingGrant, expectedGrant)) {
        fail(`existing ${key} grant differs`)
      }
    } else if (!sameAuthorityOwnerGrant(existingGrant, expectedGrant as { authorityId: string; owner: unknown })) {
      fail(`existing ${key} grant differs`)
    }
  }
  out.byId.get(ids.control)!.set('config', out.document.createNode(control))
  if (ordinary) {
    const proactive = copyNamedConfig(out, effective, 'dsh-ray-assistant-proactive',
      '@dsh-ray/assistant-proactive', 'assistant-proactive', upgrading)
    if (upgrading) {
      if (proactive.get('enabled') === false) proactive.set('enabled', true)
      proactive.set('intakeEvaluation', out.document.createNode(ordinary.intakeEvaluation))
    } else {
      setExact(out.document, proactive, 'intakeEvaluation', ordinary.intakeEvaluation, 'intake evaluation')
    }
    const workItems = copyNamedConfig(out, effective, 'dsh-ray-assistant-work-items',
      '@dsh-ray/assistant-work-items', 'assistant-work-items', upgrading)
    if (upgrading && workItems.get('enabled') === false) workItems.set('enabled', true)
    if (workItems.get('enabled') !== true) fail('ordinary-use learning requires assistant-work-items.enabled: true')
    const ledger = workItems.get('intakeLedger', true) as Node | undefined
    if (ledger !== undefined && !isMap(ledger)) fail('assistant-work-items intakeLedger must be a mapping')
    if (ledger === undefined || ledger.get('enabled') !== true) {
      fail('ordinary-use learning requires assistant-work-items.intakeLedger.enabled: true')
    }
    setExactAt(out.document, workItems, ['intakeLedger', 'evaluation', 'enabled'], true, 'work-items intake evaluation')
  }
  const final = parseRows(out.document.toString({ lineWidth: 0 }), 'compiled target')
  const targets: RuntimeObserverTarget[] = []
  for (const [key, services] of [['personal', ['personalMemory', 'assistantPolicy', 'assistantAutomations']],
    ['delivery', ['assistantDelivery']], ['verifier', ['assistantVerifier']], ['growth', ['assistantGrowthDriver']],
    ['memory', ['assistantMemoryLearning']]] as const) {
    const finalRow = final.byId.get(ids[key]) ?? effectiveRow(effective.byId, key)
    targets.push({ entryId: ids[key], module: managed[key], configDigest: runtimeConfigDigest(rawLoaderConfig(finalRow.get('config', true) as Node, key)), services: [...services] })
  }
  const larkRow = effective.byId.get('dsh-ray-lark-channel')
  if (!larkRow || larkRow.get('disabled') === true || larkRow.get('name') !== '@dsh-ray/lark-channel') fail('active Lark channel is required')
  targets.push({ entryId: 'dsh-ray-lark-channel', module: '@dsh-ray/lark-channel',
    configDigest: runtimeConfigDigest(rawLoaderConfig(larkRow.get('config', true) as Node, 'lark-channel')),
    services: ['larkChannel'] })
  if (ordinary) {
    for (const [id, name, services] of [['dsh-ray-assistant-proactive', '@dsh-ray/assistant-proactive',
      ['assistantProactive']], ['dsh-ray-assistant-work-items', '@dsh-ray/assistant-work-items',
      ['assistantWorkItems']]] as const) {
      const finalRow = final.byId.get(id)
      if (!finalRow || finalRow.get('disabled') === true
        || finalRow.get('name') !== undefined && finalRow.get('name') !== name) fail(`${name} final row is unavailable`)
      targets.push({ entryId: id, module: name,
        configDigest: runtimeConfigDigest(rawLoaderConfig(finalRow.get('config', true) as Node, name)), services: [...services] })
    }
  }
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
    pluginCreation: creation, ...(revision ? { pluginRevision: revision } : {}),
    limits, ...(ordinary !== undefined ? { ordinaryUseLearning: ordinary } : {}) }
  return { manifest, targetPatch: final.document.toString({ lineWidth: 0 }), trust }
}
