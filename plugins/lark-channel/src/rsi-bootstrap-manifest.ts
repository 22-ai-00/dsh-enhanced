import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type ActiveLarkOwnerBinding } from '@dsh-enhanced/assistant-delivery'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { PROTECTED_PLUGIN_DENYLIST, runtimeConfigDigest, validateHostDeploymentInputs, type RuntimeObserverTarget } from '@dsh-enhanced/plugin-control-plane'
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml'

import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import type { Pin, RsiAuthorityRuntime } from './rsi-authority-runtime.js'
import type { RsiBuildEnvironment } from './rsi-build.js'
import type { RsiSetupManifest } from './rsi-profile.js'
import type { RsiSourceWorkspace } from './rsi-source.js'
import { resolveRsiOwnerRoute } from './rsi-owner-profile.js'
import { getRsiMemoryLearningValidators, validateRsiMemoryLearningSetup } from './rsi-memory-learning.js'
import { compileRsiPersonalAssistantOptions } from './rsi-profile.js'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const pluginPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const digestPattern = /^[a-f0-9]{64}$/u
const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
const mutableRows = new Set(['dsh-enhanced-personal-assistant', 'dsh-enhanced-assistant-verifier',
  'dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-assistant-memory-learning', 'dsh-enhanced-plugin-control-plane'])
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
/** Include's entryListSchema keeps !!js as an inert raw `{__jsExpr}` value in
 * Loader Entry.options. Runtime observation hashes that raw value before the
 * Fiber interpolates it. Never evaluate the expression while preparing setup. */
export function rawLoaderConfig(node: Node | string | number | boolean | null | undefined, label: string): unknown {
  if (node === undefined || node === null) return null
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node
  if (isAlias(node)) fail(`${label} contains a YAML alias`)
  if (isScalar(node)) {
    if (node.tag === 'tag:yaml.org,2002:js') {
      if (typeof node.value !== 'string') fail(`${label} has an invalid !!js scalar`)
      return { __jsExpr: node.value }
    }
    if (node.tag) fail(`${label} has an unsupported YAML tag`)
    return node.value
  }
  if (isSeq(node)) {
    if (node.tag) fail(`${label} has an unsupported YAML tag`)
    return node.items.map(item => rawLoaderConfig(item as Node | undefined, label))
  }
  if (isMap(node)) {
    if (node.tag) fail(`${label} has an unsupported YAML tag`)
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const pair of node.items) {
      const key = typeof pair.key === 'string' ? pair.key
        : isScalar(pair.key) && !pair.key.tag && typeof pair.key.value === 'string' ? pair.key.value : undefined
      if (key === undefined) fail(`${label} has an invalid YAML key`)
      if (Object.hasOwn(result, key)) fail(`${label} has a duplicate YAML key`)
      result[key] = rawLoaderConfig(pair.value as Node | undefined, label)
    }
    return result
  }
  fail(`${label} contains an unsupported YAML node`)
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
  const memoryManifestPaths = hostInputs.filter(path => path.endsWith('/@dsh-enhanced/personal-memory/package.json'))
  if (memoryManifestPaths.length !== 1) fail('Host deployment inputs require one embedded Personal Memory package')
  const memoryPrefix = memoryManifestPaths[0]!.slice(0, -'package.json'.length)
  if (!hostInputs.includes(`${memoryPrefix}cordis.patch.yml`)
    || !hostInputs.some(path => path.startsWith(`${memoryPrefix}lib/`) && path.endsWith('.js'))) {
    fail('Host deployment inputs do not cover embedded Personal Memory')
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
    if (entry.get('disabled') === true && id !== 'dsh-enhanced-assistant-memory-learning') return []
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
  const resolvedOwner = resolveRsiOwnerRoute(deliveryConfig, input.owner, input.dshHome)
  const routeId = resolvedOwner.route.id, principalId = resolvedOwner.principal
  const scope = { ownerRouteId: routeId, principalId, workspace: input.owner.workspace, preset: input.owner.agentPreset }
  const reviewOwner = { authorityId: routeId, authorityHash: resolvedOwner.route.authorityHash, principalId,
    principalRecordId: input.owner.owner.id, principalVersion: input.owner.owner.version,
    workspace: input.owner.workspace, agentPreset: input.owner.agentPreset }

  const personal = rows.get('dsh-enhanced-personal-assistant')
  if (!personal || personal.get('disabled') === true || personal.get('name') !== '@dsh-enhanced/personal-assistant') fail('effective personal assistant is missing')
  const personalConfig = rowConfig(personal, 'personal assistant')
  const memoryConfig = personalConfig.get('personalMemory', true) as Node | undefined
  if (!isMap(memoryConfig)) fail('effective embedded Personal Memory is missing')
  const learner = rows.get('dsh-enhanced-assistant-memory-learning')
  if (!learner || learner.get('name') !== '@dsh-enhanced/assistant-memory-learning'
    || learner.get('disabled') === true && learner.has('config')) fail('effective memory learner must be the installed unconfigured bundle')
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

  if (!Array.isArray(input.observerTargets) || input.observerTargets.length < 1 || input.observerTargets.length > 30
    || new Set(input.observerTargets.map(target => target.entryId)).size !== input.observerTargets.length) fail('observer targets are invalid')
  for (const target of input.observerTargets) {
    const effective = rows.get(target.entryId)
    if (!effective || effective.get('disabled') === true || mutableRows.has(target.entryId)
      || target.module !== effective.get('name')) fail(`observer target ${target.entryId} is not a stable effective Loader entry`)
    const node = effective.get('config', true) as Node | undefined
    // Loader observes an omitted configuration as null. Default-only bundles
    // need no artificial YAML config mapping to be observed or bootstrapped.
    if (runtimeConfigDigest(rawLoaderConfig(node, target.entryId)) !== target.configDigest) fail(`observer target ${target.entryId} config digest differs from effective Loader entry`)
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
  const { validateLearningConfig, validateMemoryReviewConfig, validateMemoryLearningAdoptionGrant } = getRsiMemoryLearningValidators()
  const memoryReview = validateMemoryReviewConfig({ authorityId: `memory-review-${installation}`,
    owner: reviewOwner, expiresAt: input.expiresAt, maxReviews: 1000,
    policy: 'Independently verify exact owner statements for facts and trusted owner objectives with canonical outcomes for experiences. Reject unsupported claims, withdrawn sources, and ambiguous mutations.',
    maxInputBytes: 65_536, maxOutputTokens: 2048, timeoutMs: 120_000 })
  const memoryAdoption = validateMemoryLearningAdoptionGrant({ authorityId: `memory-adopt-${installation}`,
    owner: reviewOwner, reviewAuthorityId: memoryReview.authorityId,
    reviewAuthorityDigest: growthObjectDigest(memoryReview), expiresAt: input.expiresAt,
    maxMutations: 1000, maxTotalContentBytes: 4_096_000, maxRecordTtlMs: 30 * day,
    kinds: ['fact', 'experience'], operations: ['add', 'replace', 'remove'] })
  const memoryLearning = validateRsiMemoryLearningSetup({
    learning: validateLearningConfig({ databasePath: join(state, 'memory-learning.sqlite'),
      authorityId: `memory-extract-${installation}`, owner: reviewOwner, expiresAt: input.expiresAt,
      maxExtractions: 1000, maxPending: 100, lookbackMs: 30 * day,
      policy: 'Extract only explicit owner facts or experience grounded in a trusted owner objective and canonical outcome. Do not infer success from a reply. Prefer noop when evidence is insufficient.',
      maxInputBytes: 65_536, maxOutputTokens: 2048, timeoutMs: 120_000,
      budgetId: `rsi-memory-learning-${installation}`, budgetAmount: 1,
      scanBudgetId: `rsi-memory-scan-${installation}`, scanBudgetAmount: 1,
      reviewAuthorityId: memoryReview.authorityId, reviewAuthorityDigest: growthObjectDigest(memoryReview),
      adoptionAuthorityId: memoryAdoption.authorityId, adoptionGrantDigest: growthObjectDigest(memoryAdoption) }),
    reviews: memoryReview, adoption: memoryAdoption, limits: { extractions: 7, scans: 1440 },
  }, reviewOwner, input.now)
  if (learner.get('disabled') !== true) {
    if (!learner.has('config') || !isDeepStrictEqual(plain(rowConfig(learner, 'memory learner'), 'memory learner'), memoryLearning.learning)) {
      fail('existing memory learner config differs from frozen owner grant')
    }
  }
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
    memoryLearning,
    coordinator: { budgetId: `rsi-coordinator-${installation}`, budgetAmount: 1, timeoutMs: 300_000 },
    limits: { periodMs: day, reviews: reviewLimit, discovery: 1440, source: 7, observations: 1440,
      coordinator: 1440, qualification: 1440 },
  }
  // Delivery, Growth and Verifier final options are determined by compileRsiProfiles.
  // Observe their final raw Loader options, not the pre-install dump. Neither
  // embeds runtimeObserver, so there is no configuration-digest cycle.
  const verifier = rows.get('dsh-enhanced-assistant-verifier')
  if (!verifier || verifier.get('disabled') === true) fail('effective verifier is missing')
  const verifierRaw = rawLoaderConfig(rowConfig(verifier, 'verifier'), 'verifier')
  if (!verifierRaw || typeof verifierRaw !== 'object' || Array.isArray(verifierRaw)) fail('invalid verifier config')
  manifest.controlPlane.runtimeObserver!.targets.push(
    { entryId: 'dsh-enhanced-assistant-growth-driver', module: '@dsh-enhanced/assistant-growth-driver',
      configDigest: runtimeConfigDigest(manifest.growthDriver), services: ['assistantGrowthDriver'] },
    { entryId: 'dsh-enhanced-assistant-verifier', module: '@dsh-enhanced/assistant-verifier',
      configDigest: runtimeConfigDigest({ ...verifierRaw, sourceReviews: manifest.sourceReviews,
        memoryReviews: memoryLearning.reviews }), services: ['assistantVerifier'] },
    { entryId: 'dsh-enhanced-personal-assistant', module: '@dsh-enhanced/personal-assistant',
      configDigest: runtimeConfigDigest(compileRsiPersonalAssistantOptions({
        effectiveConfig: rawLoaderConfig(personalConfig, 'personal assistant') as Record<string, unknown>,
        manifest, scope: { workspace: scope.workspace, preset: scope.preset, principal: scope.principalId },
        budgetIds: { reviews: manifest.growthDriver.budgetId!, discovery: manifest.growthDriver.usageLearning!.scanBudgetId!,
          source: manifest.controlPlane.sourceJobs!.budgetId, observations: manifest.controlPlane.taskObservations!.budgetId },
      })), services: ['personalMemory', 'assistantPolicy', 'assistantAutomations'] },
    { entryId: 'dsh-enhanced-assistant-memory-learning', module: '@dsh-enhanced/assistant-memory-learning',
      configDigest: runtimeConfigDigest(memoryLearning.learning), services: ['assistantMemoryLearning'] },
  )
  const deliveryTarget = manifest.controlPlane.runtimeObserver!.targets.find(target => target.entryId === 'dsh-enhanced-assistant-delivery')
  if (deliveryTarget) {
    // The input observer digest was validated above against the original dump.
    // Only the journaled compiler output receives the new owner route.
    const deliveryRaw = rawLoaderConfig(rowConfig(delivery, 'Delivery'), 'Delivery') as Record<string, unknown>
    deliveryTarget.configDigest = runtimeConfigDigest(resolvedOwner.created
      ? { ...deliveryRaw, ownerRoutes: [...deliveryRaw.ownerRoutes as unknown[], resolvedOwner.authority] }
      : deliveryRaw)
  }
  return manifest
}
