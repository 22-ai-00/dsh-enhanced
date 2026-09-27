import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { externalPrincipalId, ownerRouteAuthorityHash, type ActiveLarkOwnerBinding } from '@dsh-enhanced/assistant-delivery'
import { PROTECTED_PLUGIN_DENYLIST, runtimeConfigDigest, validateHostDeploymentInputs, type RuntimeObserverTarget } from '@dsh-enhanced/plugin-control-plane'
import { isMap, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml'

import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import type { Pin, RsiAuthorityRuntime } from './rsi-authority-runtime.js'
import type { RsiBuildEnvironment } from './rsi-build.js'
import type { RsiSetupManifest } from './rsi-profile.js'
import type { RsiSourceWorkspace } from './rsi-source.js'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const pluginPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const digestPattern = /^[a-f0-9]{64}$/u
const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
const mutableRows = new Set(['dsh-enhanced-personal-assistant', 'dsh-enhanced-assistant-verifier',
  'dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-plugin-control-plane'])
const day = 86_400_000

export interface RsiBootstrapManifestInput {
  dshHome: string
  targetProfile: string
  coordinatorProfile: string
  /** Exact `dsh --dump-config` YAML of the still unmodified target profile. */
  targetEffective: string
  owner: ActiveLarkOwnerBinding
  resources: RsiAuthorityResources
  runtime: RsiAuthorityRuntime
  source: RsiSourceWorkspace
  sourceBuild: RsiBuildEnvironment['sourceBuild']
  git: Pin
  now: number
  expiresAt: number
  /** Complete installed scope authorized for source repair. */
  plugins: readonly string[]
  /** Loader observations of stable rows that will not be rewritten by the compiler. */
  observerTargets: readonly RuntimeObserverTarget[]
  /** Exact installed profile files that Host will independently pin on activation. */
  hostDeploymentInputs: readonly string[]
}

function fail(message: string): never { throw new Error(`rsi bootstrap manifest: ${message}`) }
function canonical(path: string, label: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0') || /[\r\n]/u.test(path)) fail(`${label} must be canonical absolute`)
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive safe integer`)
  return value as number
}
function mapping(value: Node | undefined, label: string): YAMLMap {
  if (!isMap(value)) fail(`${label} must be a YAML mapping`)
  return value
}
function rowConfig(row: YAMLMap, label: string): YAMLMap {
  return mapping(row.get('config', true) as Node | undefined, `${label} config`)
}
function plain(value: YAMLMap, label: string): Record<string, unknown> {
  const result = value.toJSON()
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(`${label} must be an object`)
  return result as Record<string, unknown>
}
function noTags(node: Node, label: string): void {
  if ('tag' in node && typeof node.tag === 'string') fail(`${label} has evaluated YAML tags; supply an independently observed Loader config digest`)
  if (isMap(node)) for (const pair of node.items) {
    if (pair.key) noTags(pair.key as Node, label)
    if (pair.value) noTags(pair.value as Node, label)
  }
  else if (isSeq(node)) for (const child of node.items) if (child) noTags(child as Node, label)
}

/** This only creates a candidate deployment contract. It performs no I/O and issues no authority. */
export function createRsiBootstrapManifest(input: RsiBootstrapManifestInput): RsiSetupManifest {
  canonical(input.dshHome, 'dshHome')
  if (!profilePattern.test(input.targetProfile) || !profilePattern.test(input.coordinatorProfile)
    || input.targetProfile === input.coordinatorProfile) fail('profiles must be distinct valid names')
  positive(input.now, 'now'); positive(input.expiresAt, 'expiresAt')
  if (input.expiresAt <= input.now || input.expiresAt - input.now > 365 * day) fail('authority lifetime is invalid')
  if (!input.owner || input.owner.status !== 'active' || input.owner.owner?.status !== 'active'
    || input.owner.owner.role !== 'owner' || input.owner.conversation.channel !== 'lark'
    || input.owner.conversation.kind !== 'dm' || input.owner.principal.channel !== 'lark'
    || !isDeepStrictEqual(input.owner.owner.principal, input.owner.principal)
    || !Number.isSafeInteger(input.owner.generation) || input.owner.generation < 1
    || !Number.isSafeInteger(input.owner.version) || input.owner.version < 1
    || !Number.isSafeInteger(input.owner.owner.version) || input.owner.owner.version < 1) fail('active Lark owner receipt is invalid')
  canonical(input.owner.workspace, 'owner workspace')
  if (!input.resources || input.resources.schemaVersion !== 1 || !input.runtime || input.runtime.schemaVersion !== 1
    || !input.source || input.source.schemaVersion !== 1 || !input.sourceBuild || input.sourceBuild.versioning !== 'patch') fail('prepared RSI inputs are incomplete')
  for (const [label, path] of [['resource root', input.resources.root], ['state root', input.resources.stateRoot],
    ['config root', input.resources.configRoot], ['source checkout', input.source.repository], ['source release remote', input.source.baseline.remote],
    ['runtime root', input.runtime.root], ['git', input.git?.path]] as const) canonical(path, label)
  if (input.resources.root !== join(input.dshHome, 'rsi-authorities', input.targetProfile)
    || input.runtime.root !== join(input.dshHome, 'rsi-authority-runtimes', input.targetProfile)
    || input.resources.stateRoot !== join(input.resources.root, 'state')
    || input.resources.configRoot !== join(input.resources.root, 'config')
    || !digestPattern.test(input.git.sha256)) fail('prepared resources do not belong to target installation')
  if (!Array.isArray(input.plugins) || input.plugins.length < 1 || input.plugins.length > 32
    || new Set(input.plugins).size !== input.plugins.length
    || input.plugins.some(name => !pluginPattern.test(name) || PROTECTED_PLUGIN_DENYLIST.has(name))) fail('source repair plugin scope is invalid or protected')
  validateHostDeploymentInputs(input.hostDeploymentInputs)
  const hostInputs = [...input.hostDeploymentInputs]
  for (const required of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    if (!hostInputs.includes(required)) fail(`Host deployment input is missing ${required}`)
  }
  for (const name of input.plugins) {
    const prefix = `node_modules/@dsh-enhanced/${name}/`
    if (!hostInputs.includes(`${prefix}package.json`) || !hostInputs.includes(`${prefix}cordis.patch.yml`)
      || !hostInputs.some(path => path.startsWith(`${prefix}lib/`) && path.endsWith('.js'))) {
      fail(`Host deployment input does not cover installed package ${name}`)
    }
  }

  const document = parseDocument(input.targetEffective, { uniqueKeys: true })
  if (document.errors.length || !isSeq(document.contents)) fail('target effective YAML is invalid')
  const rows = new Map<string, YAMLMap>()
  for (const item of document.contents.items) {
    const entry = mapping(item as Node, 'target row')
    const id = entry.get('id')
    if (typeof id !== 'string' || rows.has(id)) fail('target effective rows have duplicate or invalid ids')
    rows.set(id, entry)
  }
  const installedRepairable = [...rows.entries()].flatMap(([id, entry]) => {
    if (entry.get('disabled') === true) return []
    const name = entry.get('name')
    if (typeof name !== 'string' || !name.startsWith('@dsh-enhanced/')) {
      if (id.startsWith('dsh-enhanced-')) fail(`installed plugin row ${id} has no package name`)
      return []
    }
    const plugin = name.slice('@dsh-enhanced/'.length)
    if (!pluginPattern.test(plugin) || id !== `dsh-enhanced-${plugin}`) fail(`installed plugin row ${id} has inconsistent package identity`)
    return PROTECTED_PLUGIN_DENYLIST.has(plugin) ? [] : [plugin]
  })
  if (installedRepairable.length !== input.plugins.length
    || new Set(installedRepairable).size !== installedRepairable.length
    || installedRepairable.some(name => !input.plugins.includes(name))) fail('plugin scope differs from all installed repairable bundles')
  const delivery = rows.get('dsh-enhanced-assistant-delivery')
  if (!delivery || delivery.get('disabled') === true) fail('effective Delivery is unavailable')
  const deliveryConfig = plain(rowConfig(delivery, 'Delivery'), 'Delivery config')
  const configuredWorkspace = deliveryConfig.defaultWorkspace
  const workspace = configuredWorkspace === "dshHomePath('assistant-workspace')" || configuredWorkspace === 'dshHomePath("assistant-workspace")'
    ? join(input.dshHome, 'assistant-workspace') : configuredWorkspace
  canonical(workspace as string, 'Delivery workspace')
  if (workspace !== input.owner.workspace || deliveryConfig.defaultAgentPreset !== input.owner.agentPreset
    || deliveryConfig.policyRef !== undefined && deliveryConfig.policyRef !== input.owner.policyRef) fail('Delivery scope differs from active owner')
  const routes = deliveryConfig.ownerRoutes
  if (!Array.isArray(routes)) fail('Delivery owner routes are missing')
  const matching = routes.filter(route => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) return false
    const item = route as Record<string, unknown>
    return isDeepStrictEqual(item.conversation, input.owner.conversation)
      && isDeepStrictEqual(item.principal, input.owner.principal)
      && item.workspace === input.owner.workspace && item.agentPreset === input.owner.agentPreset
      && item.policyRef === input.owner.policyRef
      && Number.isSafeInteger(item.minimumGeneration) && (item.minimumGeneration as number) >= 1
      && (item.minimumGeneration as number) <= input.owner.generation
  }) as Record<string, unknown>[]
  if (matching.length !== 1 || typeof matching[0]!.id !== 'string' || !matching[0]!.id) fail('no unique effective route matches active owner')
  const route = matching[0]!, routeId = route.id as string
  if (routes.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).id === routeId).length !== 1) fail('matching owner route id is duplicated')
  const principalId = externalPrincipalId(input.owner.principal)
  const scope = { ownerRouteId: routeId, principalId, workspace: input.owner.workspace, preset: input.owner.agentPreset }
  const reviewOwner = { authorityId: routeId,
    authorityHash: ownerRouteAuthorityHash({ id: routeId, conversation: input.owner.conversation, principal: input.owner.principal,
      workspace: input.owner.workspace, agentPreset: input.owner.agentPreset, policyRef: input.owner.policyRef,
      minimumGeneration: route.minimumGeneration as number }), principalId,
    principalRecordId: input.owner.owner.id, principalVersion: input.owner.owner.version,
    workspace: input.owner.workspace, agentPreset: input.owner.agentPreset }

  const personal = rows.get('dsh-enhanced-personal-assistant')
  if (!personal) fail('effective personal assistant is missing')
  const policy = plain(mapping(rowConfig(personal, 'personal assistant').get('assistantPolicy', true) as Node | undefined, 'assistantPolicy'), 'assistantPolicy')
  let reviewLimit = 7
  const budgets = (policy.budgets as unknown[] | undefined) ?? []
  if (!Array.isArray(budgets)) fail('assistantPolicy budgets are invalid')
  const globalReview = budgets.filter(value => value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).metric === 'automation-runs'
    && (value as Record<string, unknown>).scope === 'global'
    && (value as Record<string, unknown>).periodMs === day) as Record<string, unknown>[]
  if (globalReview.length) {
    const limits = new Set(globalReview.map(value => value.limit))
    if (limits.size !== 1 || !Number.isSafeInteger(globalReview[0]!.limit) || (globalReview[0]!.limit as number) < 1) fail('existing global automation budget conflicts')
    reviewLimit = globalReview[0]!.limit as number
  }
  const growthRow = rows.get('dsh-enhanced-assistant-growth-driver')
  if (!growthRow) fail('effective growth driver is missing')
  const effectiveGrowth = growthRow.has('config') ? plain(rowConfig(growthRow, 'growth driver'), 'growth driver') : {}
  const selection = {} as { provider?: string; model?: string; reasoningEffort?: string }
  if (effectiveGrowth.provider !== undefined || effectiveGrowth.model !== undefined) {
    if (typeof effectiveGrowth.provider !== 'string' || !effectiveGrowth.provider
      || typeof effectiveGrowth.model !== 'string' || !effectiveGrowth.model) fail('growth model override needs provider and model')
    selection.provider = effectiveGrowth.provider; selection.model = effectiveGrowth.model
    if (effectiveGrowth.reasoningEffort !== undefined) {
      if (typeof effectiveGrowth.reasoningEffort !== 'string' || !effectiveGrowth.reasoningEffort) fail('invalid growth reasoning effort')
      selection.reasoningEffort = effectiveGrowth.reasoningEffort
    }
  } else if (effectiveGrowth.reasoningEffort !== undefined) fail('growth reasoning effort has no fixed model')

  if (!Array.isArray(input.observerTargets) || input.observerTargets.length < 1 || input.observerTargets.length > 32
    || new Set(input.observerTargets.map(target => target.entryId)).size !== input.observerTargets.length) fail('observer targets are invalid')
  for (const target of input.observerTargets) {
    const effective = rows.get(target.entryId)
    if (!effective || effective.get('disabled') === true || mutableRows.has(target.entryId)
      || target.module !== effective.get('name')) fail(`observer target ${target.entryId} is not a stable effective Loader entry`)
    const node = effective.get('config', true) as Node | undefined
    if (node) noTags(node, target.entryId)
    // Loader observes an omitted configuration as null. Default-only bundles
    // need no artificial YAML config mapping to be observed or bootstrapped.
    if (runtimeConfigDigest(node?.toJSON() ?? null) !== target.configDigest) fail(`observer target ${target.entryId} config digest differs from effective Loader entry`)
  }

  const config = input.resources.configRoot, state = input.resources.stateRoot
  const client = (name: 'approval' | 'release' | 'adoption' | 'observation' | 'qualification') => ({
    executable: { ...input.runtime.executables[name] }, interpreter: { ...input.runtime.node },
    configPath: join(config, `${name}.json`), timeoutMs: 10_000,
  })
  const releaseConfig = { reviewDecisionRoot: join(state, 'review-decisions'), timeoutMs: 1_800_000, independentReview: true }
  const hostPath = join(config, 'host-wrapper.json')
  const targetEnvironment: Record<string, string> = { DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: hostPath }
  for (const phase of phases) targetEnvironment[`DSH_RELEASE_${phase.toUpperCase().replaceAll('-', '_')}_CONFIG`] = join(config, `release-${phase}.json`)
  const profilePath = join(input.dshHome, 'profiles', input.targetProfile)
  const installation = input.resources.installationId
  const manifest: RsiSetupManifest = {
    schemaVersion: 1, targetProfile: input.targetProfile, coordinatorProfile: input.coordinatorProfile,
    serviceEnvironment: { target: targetEnvironment, coordinator: { DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: hostPath } },
    controlPlane: {
      catalogPath: input.resources.catalog.path, statePath: join(state, 'control-plane'), trustPath: join(config, 'trust.json'),
      sourceBuild: { ...input.sourceBuild },
      sourceJobs: { authorityId: `source-jobs-${installation}`, expiresAt: input.expiresAt, maxSubmissions: 1000,
        repository: input.source.repository, baseline: { ...input.source.baseline }, ...scope,
        budgetId: `rsi-source-${installation}`, budgetAmount: 1 },
      sourceApprovals: client('approval'), sourceReleases: client('release'), sourceReleaseExecution: releaseConfig,
      sourceAdoptions: { profile: input.targetProfile, planTtlMs: day, timeoutMs: 3_600_000, authority: client('adoption'),
        handoff: { schemaVersion: 1, coordinatorId: `rsi-coordinator-${installation}`, maximumWindowMs: day, commit: 'target-host' },
        liveQualification: { protocol: 'dsh-bounded-live/v1', maximumWindowMs: day, minimumTasks: 2,
          authority: input.resources.identities.qualification.authority, keyId: input.resources.identities.qualification.keyId },
        hostDeploymentInputs: hostInputs },
      runtimeObserver: { socketPath: join(state, 'observer.sock'), keyPath: join(config, 'observer.key'),
        profilePath, targets: input.observerTargets.map(target => ({ ...target, services: [...target.services] })) },
      foregroundDeployments: { attestorJournalPath: join(state, 'host-attestor', 'reload.sqlite') },
      taskObservations: { policy: { id: `rsi-observation-${installation}`, expiresAt: input.expiresAt,
        maximumObservations: 1000, minimumChecks: 1, maximumChecks: 32, lookbackMs: 30 * day },
        scope, profilePath, timeoutMs: 300_000, budgetId: `rsi-observations-${installation}`,
        budgetAmount: 1, authority: client('observation') },
      liveQualification: { scope, profilePath, timeoutMs: 300_000, budgetId: `rsi-qualification-${installation}`,
        budgetAmount: 1, authority: client('qualification') },
    },
    growthDriver: { enabled: true, intervalMs: 0, maxReviewsPerWake: 1, minRepeatedSuccesses: 2,
      budgetId: `rsi-reviews-${installation}`, budgetAmount: 1, ...selection,
      scope: { workspace: scope.workspace, preset: scope.preset, principalId, ownerRouteId: routeId },
      workflowOwnerAnchored: { enabled: true },
      usageLearning: { enabled: true, databasePath: join(state, 'growth.sqlite'), scanBudgetId: `rsi-discovery-${installation}`,
        scanBudgetAmount: 1 },
      pluginSourceProposals: { enabled: true, preparationMode: 'durable', repository: input.source.repository,
        maxPlansPerWake: 1, offline: true, planTtlMs: day } },
    sourceReviews: { authorityId: `source-reviews-${installation}`, expiresAt: input.expiresAt, maxReviews: 1000,
      repository: input.source.baseline.remote, git: { ...input.git }, decisionRoot: releaseConfig.reviewDecisionRoot,
      plugins: [...input.plugins], owner: reviewOwner, reviewerPrincipal: `rsi-independent-reviewer-${installation}`,
      policy: 'Review the exact owner-bound source repair and its acceptance evidence independently.',
      maxChangedFiles: 256, maxInputBytes: 2_097_152, maxOutputTokens: 8192, timeoutMs: 300_000 },
    coordinator: { budgetId: `rsi-coordinator-${installation}`, budgetAmount: 1, timeoutMs: 300_000 },
    limits: { periodMs: day, reviews: reviewLimit, discovery: 1440, source: 7, observations: 1440,
      coordinator: 1440, qualification: 1440 },
  }
  return manifest
}
