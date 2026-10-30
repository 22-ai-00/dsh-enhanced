import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { RECOVERY_CATALOG_DIGEST } from '@dsh-enhanced/assistant-recovery'
import { externalPrincipalId, ownerRouteAuthorityHash } from '@dsh-enhanced/assistant-delivery'
import { normalizeConfig } from '@dsh-enhanced/assistant-growth-driver'
import { Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'
import { Config as AutomationsConfig } from '@dsh-enhanced/assistant-automations'
import { compileRsiProfiles, type RsiSetupManifest } from '../src/rsi-profile.ts'
import { configureSupervisedGrowthProfilePatch } from '../src/supervised-growth-profile.ts'
import { createRsiMemoryLearningSetup } from '../src/rsi-memory-learning.ts'
import { deriveScannerRetirementConfiguration, ScannerRetirementConfigurationError } from '../src/rsi-scanner-retirement-config.ts'

const roots: string[] = []
const require = createRequire(import.meta.url)
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const yaml = (value: unknown) => stringify(value, { aliasDuplicateObjects: false })
const object = (value: unknown) => value as Record<string, unknown>
function fixture(home = '/unavailable/dsh-retirement-test') {
  const profile = 'web'
  const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
  const authority = { id: 'rsi-owner', conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm' as const, chat: 'oc_owner' },
    principal, workspace: join(home, 'assistant-workspace'), agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
  const owner = { authorityId: authority.id, authorityHash: ownerRouteAuthorityHash(authority), principalId: externalPrincipalId(principal),
    principalRecordId: 'principal_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', principalVersion: 1,
    workspace: authority.workspace, agentPreset: authority.agentPreset }
  const scope = { ownerRouteId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace, preset: owner.agentPreset }
  const memorySetup = createRsiMemoryLearningSetup({ installationId: 'retirement-test', stateRoot: join(home, 'rsi-state'),
    owner, now: 1_700_000_000_000, expiresAt: 1_700_000_100_000 })
  const authorityClient = { executable: { path: '/unavailable/source-client', sha256: 'b'.repeat(64) },
    configPath: '/unavailable/authority.json', timeoutMs: 10_000 }
  const growth = { enabled: true, intervalMs: 0, budgetId: 'reviews', budgetAmount: 1, scope: { ...scope },
    usageLearning: { enabled: true, databasePath: join(home, 'growth.sqlite'), scanBudgetId: 'discovery', scanBudgetAmount: 1 } }
  const task = { scope: { ...scope }, profilePath: join(home, 'profiles', profile), timeoutMs: 300_000, budgetId: 'observations', budgetAmount: 1,
    authority: authorityClient, policy: { id: 'observations', expiresAt: 1, maximumObservations: 1000, minimumChecks: 1, maximumChecks: 32, lookbackMs: 86_400_000 } }
  const live = { scope: { ...scope }, profilePath: join(home, 'profiles', profile), timeoutMs: 300_000, budgetId: 'qualification', budgetAmount: 1, authority: authorityClient }
  const control: Record<string, unknown> = { catalogPath: join(home, 'catalog.json'), statePath: join(home, 'control-plane'), trustPath: join(home, 'trust.json'),
    taskObservations: task, liveQualification: live, sourceJobs: { ...scope, repository: '/unavailable/repository', expiresAt: 1 },
    runtimeObserver: { profilePath: join(home, 'profiles', profile) }, sourceAdoptions: { profile } }
  const policy = { databasePath: join(home, 'policy.sqlite'), rules: [], budgets: [], proposalMaintenanceIntervalMs: 1234 }
  const automations = { databasePath: join(home, 'automations.sqlite'), runsPath: join(home, 'runs'), schedulerEnabled: true, reconcileIntervalMs: 4567 }
  const personal = { assistantPolicy: policy, assistantAutomations: automations,
    personalMemory: { databasePath: join(home, 'memory.sqlite'), automaticLearning: memorySetup.adoption } }
  const delivery = { databasePath: join(home, 'delivery.sqlite'), defaultWorkspace: owner.workspace, defaultAgentPreset: owner.agentPreset,
    ownerRoutes: [authority] }
  const verifier = { sourceReviews: { owner, expiresAt: 1 }, memoryReviews: memorySetup.reviews }
  const row = (name: string, config: unknown) => ({ id: `dsh-enhanced-${name}`, name: `@dsh-enhanced/${name}`, config })
  const rows: Array<Record<string, unknown>> = [row('personal-assistant', personal), row('assistant-delivery', delivery),
    row('lark-channel', { enabled: true, account: 'primary', tenant: 'personal' }), row('assistant-growth-driver', growth),
    row('plugin-control-plane', control), row('assistant-memory-learning', memorySetup.learning), row('assistant-verifier', verifier)]
  return { home, profile, owner, authority, growth, task, live, control, memorySetup, policy, automations, personal, delivery, verifier, rows }
}
type Fixture = ReturnType<typeof fixture>
function input(f: Fixture) { return { effectiveConfig: yaml(f.rows), dshHome: f.home, profile: f.profile, owner: f.owner } }
function expectRejected(f: Fixture) {
  expect(() => deriveScannerRetirementConfiguration(input(f))).toThrowError(ScannerRetirementConfigurationError)
}
async function runtime(name: string, file: string, exported: string) {
  const exports = await import(pathToFileURL(join(dirname(require.resolve(`${name}/package.json`)), `lib/${file}.js`)).href) as
    Record<string, new (...args: unknown[]) => { scanId: string; close(): Promise<void> }>
  return exports[exported]!
}

describe('frozen target configuration scanner retirement derivation', () => {
  test('returns exact source digest, local embedded service configs and original timer values without mutating input', () => {
    const f = fixture(); const source = input(f); const before = JSON.stringify(source)
    const result = deriveScannerRetirementConfiguration(source)
    expect(result.effectiveConfigDigest).toBe(createHash('sha256').update(source.effectiveConfig).digest('hex'))
    expect(result.ownerQuery).toEqual({ databasePath: f.delivery.databasePath, authority: f.authority,
      principalRecordId: f.owner.principalRecordId, frozenPrincipalVersion: 1 })
    expect(result.automationsDatabasePath).toBe(f.automations.databasePath)
    expect(result.policyConfig).toEqual(f.policy); expect(result.automationsConfig).toEqual(f.automations)
    expect(result.automationsConfig.schedulerEnabled).toBe(true)
    expect(result.policyConfig.proposalMaintenanceIntervalMs).toBe(1234)
    expect(result.automationsConfig.reconcileIntervalMs).toBe(4567)
    expect(() => PolicyConfig(structuredClone(result.policyConfig))).not.toThrow()
    expect(() => AutomationsConfig(structuredClone(result.automationsConfig))).not.toThrow()
    const checkFrozen = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(checkFrozen)
    }
    checkFrozen(result)
    expect(JSON.stringify(source)).toBe(before); expect(Object.isFrozen(f.owner)).toBe(false)
  })

  test('matches all four actual runtime constructor scan IDs using formal Growth normalization and generated Memory config', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'rsi-retirement-config-'))); roots.push(home)
    const f = fixture(home); const result = deriveScannerRetirementConfiguration(input(f))
    const noCall = () => { throw new Error('constructor must not start any runtime work') }
    const methods = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, noCall]))
    const automations = methods(['inspectSystemOwnedRetirement', 'retireSystemOwned', 'onSchedulerWake', 'registerHostExecutor',
      'reconcileSystem', 'inspectSystemOwnedActivation', 'inspectSystemOwned'])
    const delivery = methods(['inspectOwnerRouteState', 'validateOwnerRoute', 'listOwnerForegroundTaskSources', 'inspectOwnerForegroundTaskSource',
      'withOwnerForegroundTaskSourcesFence', 'inspectOwnerForegroundLearningTask'])
    const evaluation = methods(['canonicalHostScope', 'listTrustedTaskLearningProjections', 'withTrustedCanonicalTaskWriterFence',
      'onTrustedTaskChange', 'withTrustedCanonicalScopeWriterFence', 'getTrustedForegroundLearningProjection', 'inspectTrustedTaskOwnerRevision'])
    const Usage = await runtime('@dsh-enhanced/assistant-growth-driver', 'usage-runtime', 'UsageLearningRuntime')
    const Memory = await runtime('@dsh-enhanced/assistant-memory-learning', 'runtime', 'MemoryLearningRuntime')
    const Task = await runtime('@dsh-enhanced/plugin-control-plane', 'task-observation-runtime', 'TaskObservationRuntime')
    const Live = await runtime('@dsh-enhanced/plugin-control-plane', 'live-qualification-runtime', 'LiveQualificationRuntime')
    const instances = [
      ['assistant-growth-usage', new Usage(normalizeConfig(f.growth), { automations, delivery, evaluation, review: noCall })],
      ['assistant-memory-learning', new Memory(f.memorySetup.learning, { automations, delivery, evaluation,
        memory: methods(['listLearningTargets', 'inspectLearningAdoptionAvailability', 'lookupLearningAdoption', 'adoptReviewedLearning']),
        verifier: methods(['inspectMemoryLearningReviewAvailability', 'reviewMemoryLearning', 'lookupMemoryLearningReview']),
        policy: methods(['evaluate', 'authorize']), extract: noCall })],
      ['plugin-control-plane-task-observations', new Task({ config: f.task, store: { close: () => undefined }, trust: {}, evaluation, delivery, automations,
        assertCurrent: noCall, rollback: noCall })],
      ['plugin-control-plane-live-qualification', new Live({ config: f.live, store: { close: () => undefined }, trust: {}, evaluation, delivery, automations,
        assertCurrent: noCall, assertRuntime: noCall, runtimeAvailable: noCall, qualificationSource: noCall })],
    ] as const
    try {
      expect(result.targets).toHaveLength(4)
      for (const [owner, instance] of instances) expect(result.targets.find(target => target.owner === owner)?.automationId).toBe(instance.scanId)
    } finally { await Promise.all(instances.map(([, instance]) => instance.close())) }
  })

  test('accepts real supervised overlay plus compileRsiProfiles output with independent valid owner routes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-retirement-overlay-'))); roots.push(root)
    const f = fixture(join(root, 'home')), profilePath = join(f.home, 'profiles', f.profile)
    const privateRoot = join(root, 'private'), decisionRoot = join(root, 'decisions')
    for (const path of [profilePath, privateRoot, decisionRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
    const keyPath = join(privateRoot, 'observer.key'); await writeFile(keyPath, Buffer.alloc(32, 1), { mode: 0o600 })
    Object.assign(f.delivery, { agentProvider: 'fixture', agentModel: 'fixture-model' })
    for (const [name, config] of [
      ['assistant-heartbeat', { heartbeats: [] }], ['assistant-health', { requiredProviders: [] }],
      ['assistant-recovery', { databasePath: join(f.home, 'recovery.sqlite'), jobs: [] }],
      ['assistant-evolution', { databasePath: join(f.home, 'evolution.sqlite') }],
      ['assistant-growth-experiments', { databasePath: join(f.home, 'experiments.sqlite') }],
      ['assistant-evaluation', { databasePath: join(f.home, 'evaluation.sqlite') }],
      ['preference-learning', { enabled: true }], ['assistant-goals', {}], ['assistant-skills', {}],
    ] as const) f.rows.push({ id: `dsh-enhanced-${name}`, name: `@dsh-enhanced/${name}`, config })
    const activeBinding = { id: 'binding_rsi', conversation: f.authority.conversation, principal: f.authority.principal,
      workspace: f.owner.workspace, agentPreset: f.owner.agentPreset, sessionId: 'rsi-session', generation: 1,
      policyRef: f.authority.policyRef, status: 'active' as const, createdAt: 1, updatedAt: 1, version: 1,
      owner: { id: f.owner.principalRecordId, principal: f.authority.principal, role: 'owner' as const,
        status: 'active' as const, createdAt: 1, updatedAt: 1, version: 1 } }
    const supervisedBinding = { ...activeBinding, id: 'binding_supervised',
      conversation: { ...activeBinding.conversation, chat: 'oc_supervised' },
      principal: { ...activeBinding.principal, user: 'ou_supervised' } }
    const overlay = configureSupervisedGrowthProfilePatch({ profilePatch: '[]', effectiveConfig: yaml(f.rows), dshHome: f.home,
      binding: supervisedBinding, activationState: 'active', activationNonce: 'retirement-test', recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST })
    const merge = (original: Array<Record<string, unknown>>, patch: string) => {
      const result = new Map(original.map(row => [row.id, row]))
      for (const row of parse(patch) as Array<Record<string, unknown>>) result.set(row.id, { ...result.get(row.id), ...row })
      return [...result.values()]
    }
    const supervisedRows = merge(f.rows, overlay)
    const adapter = { executable: { path: join(root, 'adapter'), sha256: 'b'.repeat(64) }, configPath: join(root, 'adapter.json'), timeoutMs: 1000 }
    const expiresAt = Date.now() + 60_000
    const manifest: RsiSetupManifest = {
      schemaVersion: 1, targetProfile: f.profile, coordinatorProfile: 'coordinator',
      controlPlane: { catalogPath: join(root, 'catalog.json'), statePath: join(root, 'state'), trustPath: join(root, 'trust.json'),
        sourceBuild: { dockerPath: '/usr/bin/docker', image: `fixture@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
          memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096, versioning: 'patch' },
        sourceJobs: { authorityId: 'jobs', expiresAt, maxSubmissions: 1, repository: root, ...f.growth.scope, budgetId: 'source', budgetAmount: 1 },
        sourceApprovals: adapter, sourceReleases: adapter,
        sourceReleaseExecution: { reviewDecisionRoot: decisionRoot, timeoutMs: 1000, independentReview: true },
        sourceAdoptions: { profile: f.profile, planTtlMs: 60_000, timeoutMs: 1000, authority: adapter,
          handoff: { schemaVersion: 1, coordinatorId: 'coordinator', maximumWindowMs: 1000, commit: 'target-host' } },
        runtimeObserver: { socketPath: join(privateRoot, 'observer.sock'), keyPath, profilePath,
          targets: [{ entryId: 'control', module: '@dsh-enhanced/plugin-control-plane', configDigest: 'c'.repeat(64), services: [] }] },
        foregroundDeployments: { attestorJournalPath: join(root, 'attestor.sqlite') },
        taskObservations: { ...f.task, policy: { ...f.task.policy, expiresAt } } },
      growthDriver: { ...f.growth, pluginSourceProposals: { enabled: true, preparationMode: 'durable', repository: root, offline: true } },
      sourceReviews: { authorityId: 'reviews', expiresAt, maxReviews: 1, repository: join(root, 'review-remote'),
        git: { path: join(root, 'git'), sha256: 'a'.repeat(64) }, decisionRoot, plugins: ['lark-channel'], owner: f.owner,
        reviewerPrincipal: 'reviewer', policy: 'independent', maxChangedFiles: 1, maxInputBytes: 4096, maxOutputTokens: 1, timeoutMs: 1000 },
      coordinator: { budgetId: 'coordinator', budgetAmount: 1, timeoutMs: 1000 },
      limits: { periodMs: 60_000, reviews: 1, discovery: 1, source: 1, observations: 1, coordinator: 1 },
    }
    const coordinatorRows = [
      { id: 'dsh-enhanced-assistant-policy', name: '@dsh-enhanced/assistant-policy', config: { databasePath: join(root, 'old-policy.sqlite'), budgets: [], rules: [] } },
      { id: 'dsh-enhanced-assistant-automations', name: '@dsh-enhanced/assistant-automations', config: { databasePath: join(root, 'old-auto.sqlite'), runsPath: join(root, 'old-runs'), schedulerEnabled: false, allowUnbudgetedExecution: false } },
      { id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {} },
    ]
    const compiled = await compileRsiProfiles({ manifest, dshHome: f.home, targetPatch: overlay, targetEffective: yaml(supervisedRows),
      coordinatorPatch: '[]', coordinatorEffective: yaml(coordinatorRows), coordinatorBase: yaml([{ insert: [{ id: 'tool-web', name: '@deepseek-ai/tool-web' }] }]), owner: activeBinding })
    const effectiveRows = merge(supervisedRows, compiled.targetPatch)
    const delivery = object(effectiveRows.find(row => row.id === 'dsh-enhanced-assistant-delivery')!.config)
    expect((delivery.ownerRoutes as Array<{ id: string }>).map(route => route.id)).toEqual(['rsi-owner', 'supervised-growth-owner'])
    const result = deriveScannerRetirementConfiguration({ effectiveConfig: yaml(effectiveRows), dshHome: f.home,
      profile: f.profile, owner: manifest.sourceReviews.owner })
    expect(result.ownerQuery.authority.id).toBe('rsi-owner')
    expect(result.targets.map(target => target.owner)).toEqual(['assistant-growth-usage', 'plugin-control-plane-task-observations', 'assistant-memory-learning'])
    expect(delivery.ownerRoutes).toHaveLength(2)
  })

  test('allows unrelated canonical routes, but rejects duplicate IDs and malformed unrelated routes', () => {
    const f = fixture()
    const other = { ...f.authority, id: 'unrelated', conversation: { ...f.authority.conversation, chat: 'oc_other' },
      principal: { ...f.authority.principal, user: 'ou_other' } }
    f.delivery.ownerRoutes.push(other)
    expect(deriveScannerRetirementConfiguration(input(f)).ownerQuery.authority).toEqual(f.authority)
    Object.assign(other, { minimumGeneration: 0 }); expectRejected(f)
  })

  test('skips the formal stock disabled unconfigured Memory bundle, while rejecting disabled configured grants', () => {
    const f = fixture(); const stock = f.rows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')!
    delete stock.config; stock.disabled = true
    stock.inject = ['assistantDelivery', 'assistantAutomations', 'personalMemory']
    expect(deriveScannerRetirementConfiguration(input(f)).targets).toHaveLength(3)
    stock.config = f.memorySetup.learning
    expectRejected(f)
  })

  test('resolves only tagged bounded dshHomePath expressions and preserves all other service values', () => {
    const f = fixture()
    const literal = yaml(f.rows)
    const tagged = literal.replace(f.policy.databasePath, "!!js dshHomePath('policy.sqlite')")
      .replace(f.automations.databasePath, "!!js dshHomePath('automations.sqlite')")
      .replace(f.automations.runsPath, "!!js dshHomePath('runs')")
      .replace(f.delivery.databasePath, "!!js dshHomePath('delivery.sqlite')")
    const result = deriveScannerRetirementConfiguration({ ...input(f), effectiveConfig: tagged })
    expect(result.policyConfig).toEqual(f.policy); expect(result.automationsConfig).toEqual(f.automations)
    expect(result.ownerQuery.databasePath).toBe(f.delivery.databasePath)
  })

  test('does not read files, complete-normalize CP or check grant expiry while deriving retirement identities', () => {
    const f = fixture()
    // These intentionally nonexistent paths and expired CP grants would fail
    // the complete normalizer. The parent supplies DSH-validated frozen config;
    // this pure function only rechecks identity bindings, never grants authority.
    f.memorySetup.learning.expiresAt = 1
    expect(deriveScannerRetirementConfiguration(input(f)).targets).toHaveLength(4)
  })

  test('returns a subset only for absent lanes and checks a present inactive-lane scope', () => {
    const f = fixture()
    delete f.control.liveQualification
    f.rows = f.rows.filter(row => row.id !== 'dsh-enhanced-assistant-memory-learning')
    expect(deriveScannerRetirementConfiguration(input(f)).targets.map(target => target.owner)).toEqual([
      'assistant-growth-usage', 'plugin-control-plane-task-observations'])
    f.growth.usageLearning.enabled = false
    expect(deriveScannerRetirementConfiguration(input(f)).targets).toHaveLength(1)
    f.growth.scope.principalId = 'lark/primary/personal/other'
    expectRejected(f)
  })

  test('permits no optional lane, without inferring targets from user-provided IDs or prefix-looking text', () => {
    const f = fixture()
    f.rows = f.rows.filter(row => !['assistant-growth-driver', 'plugin-control-plane', 'assistant-memory-learning'].some(name => row.id === `dsh-enhanced-${name}`))
    f.personal.assistantAutomations = { ...f.automations }
    const raw = input(f)
    expect(deriveScannerRetirementConfiguration(raw).targets).toEqual([])
    expect(() => deriveScannerRetirementConfiguration({ ...raw, targets: [{ owner: 'assistant-growth-usage', automationId: 'usage-scan-fake' }] } as typeof raw))
      .toThrow(ScannerRetirementConfigurationError)
    // Caller-supplied target IDs are rejected; only frozen config can select them.
    expect(deriveScannerRetirementConfiguration(raw).targets).toEqual([])
  })

  const scopeMutations: Array<[string, (f: Fixture) => void]> = [
    ['Growth principal', f => { f.growth.scope.principalId = 'lark/primary/personal/other' }],
    ['Growth hidden scope field', f => { Object.assign(f.growth.scope, { hidden: 'scope' }) }],
    ['task route', f => { f.task.scope.ownerRouteId = 'other-route' }],
    ['task preset', f => { f.task.scope.preset = 'other' }],
    ['live workspace', f => { f.live.scope.workspace = '/other' }],
    ['live hidden scope field', f => { Object.assign(f.live.scope, { expectedOwner: f.owner }) }],
    ['task profile', f => { f.task.profilePath = join(f.home, 'profiles', 'coordinator') }],
    ['live profile', f => { f.live.profilePath = join(f.home, 'profiles', 'coordinator') }],
    ['sourceJobs principal', f => { object(f.control.sourceJobs).principalId = 'lark/primary/personal/other' }],
    ['runtime observer profile', f => { object(f.control.runtimeObserver).profilePath = '/other' }],
    ['adoption profile', f => { object(f.control.sourceAdoptions).profile = 'coordinator' }],
    ['Memory frozen version', f => { f.memorySetup.learning.owner.principalVersion++ }],
    ['Memory frozen record', f => { f.memorySetup.learning.owner.principalRecordId = 'principal_bbbbbbbb' }],
    ['Memory authority hash', f => { f.memorySetup.learning.owner.authorityHash = 'a'.repeat(64) }],
    ['sourceReviews frozen owner', f => { f.verifier.sourceReviews.owner = { ...f.owner, principalVersion: 2 } }],
    ['Memory review owner', f => { f.verifier.memoryReviews.owner = { ...f.owner, principalVersion: 2 } }],
    ['Memory adoption owner', f => { f.personal.personalMemory.automaticLearning = { ...f.personal.personalMemory.automaticLearning, owner: { ...f.owner, principalVersion: 2 } } }],
    ['Delivery workspace', f => { f.delivery.defaultWorkspace = '/other' }],
    ['Delivery preset', f => { f.delivery.defaultAgentPreset = 'other' }],
    ['Delivery principal', f => { f.authority.principal.user = 'ou_other' }],
    ['Delivery hidden authority field', f => { Object.assign(f.authority, { hidden: 'authority' }) }],
    ['duplicate owner route IDs', f => { f.delivery.ownerRoutes.push({ ...f.authority }) }],
    ['no owner route', f => { f.delivery.ownerRoutes = [] }],
    ['unbound frozen version', f => { f.owner = { ...f.owner, principalVersion: 2 } }],
  ]
  test.each(scopeMutations)('rejects owner/scope/config drift: %s', (_name, mutate) => {
    const f = fixture(); mutate(f); expectRejected(f)
  })

  const rowMutations: Array<[string, (f: Fixture) => void]> = [
    ['duplicate row ID', f => { f.rows.push(f.rows[0]!) }],
    ['same provider with other ID', f => { f.rows.push({ ...f.rows[0]!, id: 'another-personal' }) }],
    ['wrong package name', f => { f.rows[0]!.name = '@other/personal-assistant' }],
    ['standalone Policy', f => { f.rows.push({ id: 'standalone', name: '@dsh-enhanced/assistant-policy', config: f.policy }) }],
    ['standalone Automations', f => { f.rows.push({ id: 'standalone', name: '@dsh-enhanced/assistant-automations', config: f.automations }) }],
    ['missing Personal', f => { f.rows.splice(0, 1) }],
    ['missing Delivery', f => { f.rows.splice(1, 1) }],
    ['missing Lark', f => { f.rows.splice(2, 1) }],
    ['missing embedded Policy', f => { delete object(f.personal).assistantPolicy }],
    ['missing embedded Automations', f => { delete object(f.personal).assistantAutomations }],
    ['disabled row', f => { f.rows[0]!.disabled = true }],
    ['disabled optional row', f => { f.rows[5]!.disabled = true }],
    ['disabled Lark channel', f => { object(f.rows[2]!.config).enabled = false }],
    ['disabled Growth runtime', f => { f.growth.enabled = false }],
    ['realm isolate', f => { f.rows[0]!.isolate = { assistantPolicy: 'another' } }],
    ['realm intercept', f => { f.rows[1]!.intercept = {} }],
    ['realm filter', f => { f.rows[4]!.filter = { user: '*' } }],
    ['object inject', f => { f.rows[1]!.inject = { assistantPolicy: {} } }],
    ['coordinator CP', f => { f.control.adoptionCoordinator = {} }],
    ['non-object scanner lane', f => { f.control.taskObservations = 'disabled' }],
  ]
  test.each(rowMutations)('rejects ambiguous, absent, disabled or remapped providers: %s', (_name, mutate) => {
    const f = fixture(); mutate(f); expectRejected(f)
  })

  test.each(['../escape.sqlite', '/absolute.sqlite', 'a/../escape.sqlite', 'a//file.sqlite', './file.sqlite', 'a\\file.sqlite'])('rejects unsafe dshHomePath %s', relative => {
    const f = fixture()
    const source = yaml(f.rows).replace(f.policy.databasePath, `!!js dshHomePath('${relative}')`)
    expect(() => deriveScannerRetirementConfiguration({ ...input(f), effectiveConfig: source })).toThrow(ScannerRetirementConfigurationError)
  })

  test.each(["process.exit()", "dshHomePath('ok') + '/extra'", "dshHomePath('ok', 'other')"])('never executes unrecognized JS expression %s', expression => {
    const f = fixture()
    const source = yaml(f.rows).replace(f.policy.databasePath, `!!js ${expression}`)
    expect(() => deriveScannerRetirementConfiguration({ ...input(f), effectiveConfig: source })).toThrow(ScannerRetirementConfigurationError)
  })

  test('rejects relative/noncanonical paths, aliases, unsupported tags and duplicate DBs', () => {
    for (const path of ['relative.sqlite', '/tmp/a/../db.sqlite', '/tmp//db.sqlite', '/tmp/db.sqlite\n']) {
      const f = fixture(); f.policy.databasePath = path; expectRejected(f)
    }
    const duplicate = fixture(); duplicate.policy.databasePath = duplicate.delivery.databasePath; expectRejected(duplicate)
    const duplicateLane = fixture(); duplicateLane.memorySetup.learning.databasePath = duplicateLane.automations.databasePath; expectRejected(duplicateLane)
    const f = fixture()
    for (const node of ['!!binary aGVsbG8=', '&same { databasePath: /tmp/db }', '*missing']) {
      const source = yaml(f.rows).replace(f.policy.databasePath, node)
      expect(() => deriveScannerRetirementConfiguration({ ...input(f), effectiveConfig: source })).toThrow(ScannerRetirementConfigurationError)
    }
  })

  test.each(['../web', 'web/other', '', '.'])('rejects unsafe profile %s', profile => {
    expect(() => deriveScannerRetirementConfiguration({ ...input(fixture()), profile })).toThrow(ScannerRetirementConfigurationError)
  })
})
