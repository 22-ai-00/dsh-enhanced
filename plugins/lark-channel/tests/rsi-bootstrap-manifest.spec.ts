import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { isMap, isSeq, parse, parseDocument, stringify, type Node } from 'yaml'
import { normalizeControlPlaneConfig, runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { normalizeConfig } from '@dsh-enhanced/assistant-growth-driver'
import { validateSourceReviewConfig } from '@dsh-enhanced/assistant-verifier'

import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.ts'
import { createRsiBootstrapManifest, rawLoaderConfig, type RsiBootstrapManifestInput } from '../src/rsi-bootstrap-manifest.ts'
import { compileRsiProfiles } from '../src/rsi-profile.ts'
import type { RsiAuthorityRuntime } from '../src/rsi-authority-runtime.ts'

const now = Date.now()
const owner = {
  id: 'owner-binding', conversation: { channel: 'lark', account: 'account', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' },
  principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' }, workspace: '',
  agentPreset: 'primary', sessionId: 'session', generation: 3, policyRef: 'owner-policy', status: 'active' as const,
  createdAt: 1, updatedAt: 1, version: 2,
  owner: { id: 'principal-record', principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' },
    role: 'owner' as const, status: 'active' as const, createdAt: 1, updatedAt: 1, version: 2 },
}
const coordinatorBase = '- insert:\n    - id: tool-web\n      name: "@deepseek-ai/tool-web"\n    - id: agent-loop\n      name: "@deepseek-ai/agent-loop"\n'
const coordinatorEffective = [
  { id: 'dsh-enhanced-assistant-policy', name: '@dsh-enhanced/assistant-policy', config: { budgets: [], rules: [] } },
  { id: 'dsh-enhanced-assistant-automations', name: '@dsh-enhanced/assistant-automations', config: { schedulerEnabled: false, allowUnbudgetedExecution: false } },
  { id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {} },
  { id: 'tool-web', name: '@deepseek-ai/tool-web', config: {} },
]

function runtime(home: string): RsiAuthorityRuntime {
  const root = join(home, 'rsi-authority-runtimes', 'target')
  const pin = (name: string) => ({ path: join(root, name), sha256: 'a'.repeat(64) })
  return { schemaVersion: 1, packageVersion: '0.1.48', root, node: pin('node'),
    executables: { approval: pin('approval'), release: pin('release'), adoption: pin('adoption'),
      observation: pin('observation'), qualification: pin('qualification'), hostAuthority: pin('host-authority'),
      hostAttestor: pin('host-attestor') },
    releaseAdapters: { pr: pin('pr'), review: pin('review'), merge: pin('merge'), build: pin('build'),
      sign: pin('sign'), publish: pin('publish'), 'registry-verify': pin('registry-verify'),
      'catalog-admission': pin('catalog-admission') },
    processHelper: pin('process-helper'), observerClient: pin('observer-client'),
    catalogValidator: pin('catalog-validator'), catalogInterpreter: pin('catalog-interpreter') }
}

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rsi-manifest-'))
  const home = join(root, 'home'), workspace = join(home, 'assistant-workspace')
  await mkdir(home, { mode: 0o700 })
  await mkdir(join(home, 'profiles', 'target'), { recursive: true })
  await mkdir(join(home, 'profiles', 'coordinator'), { recursive: true })
  await mkdir(join(root, 'source'), { mode: 0o700 })
  await mkdir(join(root, 'release.git'), { mode: 0o700 })
  const resources = await prepareRsiAuthorityResources({ dshHome: home, profile: 'target' })
  await writeFile(join(resources.configRoot, 'observer.key'), Buffer.alloc(32, 7), { mode: 0o600 })
  await mkdir(join(resources.stateRoot, 'review-decisions'), { mode: 0o700 })
  await chmod(join(resources.stateRoot, 'review-decisions'), 0o700)
  const active = { ...owner, workspace }
  const route = { id: 'owner-route', conversation: active.conversation, principal: active.principal,
    workspace, agentPreset: 'primary', policyRef: 'owner-policy', minimumGeneration: 2 }
  const row = (id: string, name: string, config: object) => ({ id, name, config })
  const targetEffective = stringify([
    row('dsh-enhanced-personal-assistant', '@dsh-enhanced/personal-assistant',
      { assistantPolicy: { databasePath: join(home, 'policy.sqlite'), budgets: [{ id: 'existing-global', metric: 'automation-runs', limit: 9, periodMs: 86_400_000, scope: 'global' }], rules: [] },
        personalMemory: { databasePath: join(home, 'memory.sqlite') },
        assistantAutomations: { schedulerEnabled: false, allowUnbudgetedExecution: false } }),
    row('dsh-enhanced-assistant-delivery', '@dsh-enhanced/assistant-delivery',
      { defaultWorkspace: workspace, defaultAgentPreset: 'primary', ownerRoutes: [route] }),
    row('dsh-enhanced-lark-channel', '@dsh-enhanced/lark-channel', { enabled: true }),
    row('dsh-enhanced-assistant-evaluation', '@dsh-enhanced/assistant-evaluation', {}),
    row('dsh-enhanced-assistant-goals', '@dsh-enhanced/assistant-goals', {}),
    row('dsh-enhanced-assistant-health', '@dsh-enhanced/assistant-health', {}),
    row('dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', {}),
    row('dsh-enhanced-assistant-verifier', '@dsh-enhanced/assistant-verifier', { databasePath: join(home, 'verifier.sqlite') }),
    row('dsh-enhanced-assistant-growth-driver', '@dsh-enhanced/assistant-growth-driver',
      { provider: 'owner-provider', model: 'owner-model', reasoningEffort: 'high' }),
    { id: 'dsh-enhanced-assistant-memory-learning', name: '@dsh-enhanced/assistant-memory-learning', disabled: true },
    row('dsh-enhanced-plugin-control-plane', '@dsh-enhanced/plugin-control-plane', {}),
  ])
  const input: RsiBootstrapManifestInput = { dshHome: home, targetProfile: 'target', coordinatorProfile: 'coordinator',
    targetEffective, owner: active, resources, runtime: runtime(home),
    source: { schemaVersion: 1, version: '0.1.48', origin: { kind: 'local-head', locator: root, ref: 'HEAD' },
      sourceCommit: 'a'.repeat(40), repository: join(root, 'source'),
      baseline: { ref: 'refs/dsh-source/repairs', remote: join(root, 'release.git'), targetBranch: 'repairs', initialCommit: 'a'.repeat(40) } },
    sourceBuild: { dockerPath: '/usr/bin/docker', image: `fixture@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
      memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096, versioning: 'patch' },
    git: { path: '/usr/bin/git', sha256: 'a'.repeat(64) }, now, expiresAt: now + 30 * 86_400_000,
    plugins: ['personal-assistant', 'assistant-goals', 'assistant-health', 'assistant-growth-driver', 'assistant-memory-learning'],
    observerTargets: [{ entryId: 'dsh-enhanced-lark-channel', module: '@dsh-enhanced/lark-channel',
      configDigest: runtimeConfigDigest({ enabled: true }), services: [] }],
    hostDeploymentInputs: ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml',
      ...['personal-assistant', 'assistant-goals', 'assistant-health', 'assistant-growth-driver', 'assistant-memory-learning', 'personal-memory'].flatMap(name => [
        `node_modules/@dsh-enhanced/${name}/package.json`,
        `node_modules/@dsh-enhanced/${name}/cordis.patch.yml`,
        `node_modules/@dsh-enhanced/${name}/lib/index.js`,
      ])] }
  return { root, input }
}

describe('ordinary-use RSI manifest factory', () => {
  test('compiles the complete finite created-tool chain and fences mismatched setup fields', async () => {
    const { root, input } = await fixture()
    try {
      await mkdir(input.owner.workspace, { mode: 0o700 })
      for (const name of ['creation-review-runner', 'creation-adoption-runner']) {
        await mkdir(join(input.resources.stateRoot, name), { mode: 0o700 })
      }
      input.sourceBuild.image = `sha256:${'a'.repeat(64)}`
      input.creationBuild = { schemaVersion: 1, sourceCommit: input.source.sourceCommit,
        sourceImage: input.sourceBuild.image, image: `sha256:${'b'.repeat(64)}`,
        dockerPath: input.sourceBuild.dockerPath }
      const manifest = createRsiBootstrapManifest(input)
      const creation = manifest.pluginCreation!
      expect(creation.reviews.owner).toEqual(manifest.sourceReviews.owner)
      expect(creation.capabilities.owner).toEqual(manifest.sourceReviews.owner)
      expect(creation.reviews.keyPath).not.toBe(creation.capabilities.keyPath)
      expect(manifest.growthDriver.pluginSourceProposals!.allowCreation).toBe(true)
      const compile = (candidate = manifest) => compileRsiProfiles({ manifest: candidate,
        dshHome: input.dshHome, targetPatch: '[]\n', targetEffective: input.targetEffective,
        coordinatorPatch: '[]\n', coordinatorEffective: stringify(coordinatorEffective),
        coordinatorBase, owner: input.owner })
      const compiled = await compile()
      const rows = parse(compiled.targetPatch) as Array<{ id: string; config: Record<string, any> }>
      const verifier = rows.find(row => row.id === 'dsh-enhanced-assistant-verifier')!.config
      expect(verifier.creationReviews).toEqual(creation.reviews)
      expect(manifest.controlPlane.runtimeObserver!.targets.find(target =>
        target.entryId === 'dsh-enhanced-assistant-verifier')!.configDigest).toBe(runtimeConfigDigest(verifier))
      const cp = rows.find(row => row.id === 'dsh-enhanced-plugin-control-plane')!.config
      expect(cp.creationCapabilities).toEqual(creation.capabilities)
      expect(cp.creationVerifications).toEqual(creation.verifications)
      expect(cp.sourceJobs.creation).toEqual(creation.creation)
      const partial = structuredClone(manifest)
      delete partial.pluginCreation
      await expect(compile(partial)).rejects.toThrow('complete independently verified adoption setup')
      const drift = structuredClone(manifest)
      drift.controlPlane.sourceJobs!.creation = { ...drift.controlPlane.sourceJobs!.creation!, namePrefix: 'foreign-' }
      await expect(compile(drift)).rejects.toThrow('source creation grant')
      const ownerDrift = structuredClone(manifest)
      ownerDrift.pluginCreation!.reviews.owner.principalId = 'foreign-owner'
      await expect(compile(ownerDrift)).rejects.toThrow()
      const disabled = structuredClone(manifest)
      disabled.growthDriver.pluginSourceProposals!.allowCreation = false
      await expect(compile(disabled)).rejects.toThrow('enabled Growth')
      expect(() => createRsiBootstrapManifest({ ...input,
        creationBuild: { ...input.creationBuild!, sourceCommit: 'c'.repeat(40) } })).toThrow('approved source build')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('cold bootstrap import does not resolve optional memory bundles', async () => {
    vi.doMock('@dsh-enhanced/assistant-memory-learning', () => { throw new Error('unexpected learner import') })
    vi.doMock('@dsh-enhanced/personal-memory', () => { throw new Error('unexpected memory import') })
    vi.resetModules()
    try {
      const module = await import('../src/rsi-bootstrap-manifest.ts')
      expect(typeof module.createRsiBootstrapManifest).toBe('function')
    } finally {
      vi.doUnmock('@dsh-enhanced/assistant-memory-learning')
      vi.doUnmock('@dsh-enhanced/personal-memory')
      vi.resetModules()
    }
  })

  test('adds a missing owner route only in compiler output and observes its final tagged Delivery config', async () => {
    const {root,input} = await fixture()
    try {
      const original = parse(input.targetEffective) as Array<{id:string;config:Record<string,any>}>
      original.find(row => row.id === 'dsh-enhanced-assistant-delivery')!.config.ownerRoutes = []
      const targetEffective = stringify(original).replace('ownerRoutes: []', "ownerRoutes: []\n    databasePath: !!js dshHomePath('delivery/state.sqlite')")
      const source = parseDocument(targetEffective)
      if (!isSeq(source.contents)) throw new Error('invalid fixture')
      const delivery = source.contents.items.find(item => isMap(item) && (item.get('id') as unknown) === 'dsh-enhanced-assistant-delivery')
      if (!isMap(delivery)) throw new Error('missing Delivery')
      const originalDigest = runtimeConfigDigest(rawLoaderConfig(delivery.get('config',true) as Node,'Delivery'))
      const observerTargets = [...input.observerTargets,{entryId:'dsh-enhanced-assistant-delivery',module:'@dsh-enhanced/assistant-delivery',configDigest:originalDigest,services:['assistantDelivery']}]
      const manifest = createRsiBootstrapManifest({...input,targetEffective,observerTargets})
      expect(targetEffective).toContain('ownerRoutes: []')
      expect(() => createRsiBootstrapManifest({...input,targetEffective,observerTargets:observerTargets.map(target => target.entryId === 'dsh-enhanced-assistant-delivery' ? {...target,configDigest:'a'.repeat(64)} : target)})).toThrow('config digest differs')
      const compiled = await compileRsiProfiles({manifest,dshHome:input.dshHome,targetPatch:'[]\n',targetEffective,
        coordinatorPatch:'[]\n',coordinatorEffective:stringify(coordinatorEffective),coordinatorBase,owner:input.owner})
      const final = parseDocument(compiled.targetPatch)
      if (!isSeq(final.contents)) throw new Error('invalid final')
      const row = final.contents.items.find(item => isMap(item) && (item.get('id') as unknown) === 'dsh-enhanced-assistant-delivery')
      if (!isMap(row)) throw new Error('missing compiled Delivery')
      expect(compiled.targetPatch).toContain("databasePath: !!js dshHomePath('delivery/state.sqlite')")
      const digest = manifest.controlPlane.runtimeObserver!.targets.find(target => target.entryId === 'dsh-enhanced-assistant-delivery')!.configDigest
      expect(digest).not.toBe(originalDigest)
      expect(digest).toBe(runtimeConfigDigest(rawLoaderConfig(row.get('config',true) as Node,'Delivery')))
      expect((row.toJSON() as {config:{ownerRoutes:unknown[]}}).config.ownerRoutes).toHaveLength(1)
    } finally { await rm(root,{recursive:true,force:true}) }
  })
  test('composes a real validator-accepted owner-bound two-Host profile from prepared inputs', async () => {
    const { root, input } = await fixture()
    try {
      const manifest = createRsiBootstrapManifest(input)
      expect(manifest.limits.reviews).toBe(9)
      expect(manifest.growthDriver).toMatchObject({ provider: 'owner-provider', model: 'owner-model', reasoningEffort: 'high' })
      expect(manifest.controlPlane.sourceJobs!.baseline).toEqual(input.source.baseline)
      expect(manifest.controlPlane.sourceAdoptions!.hostDeploymentInputs).toEqual(input.hostDeploymentInputs)
      expect(manifest.serviceEnvironment!.target.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG).toBe(join(input.resources.configRoot, 'host-wrapper.json'))
      const learning = manifest.memoryLearning!
      expect(learning.learning.owner).toEqual(manifest.sourceReviews.owner)
      expect(new Set([learning.learning.authorityId, learning.reviews.authorityId,
        learning.adoption.authorityId, learning.learning.owner.authorityId]).size).toBe(4)
      expect([learning.learning.expiresAt, learning.reviews.expiresAt, learning.adoption.expiresAt]).toEqual([input.expiresAt, input.expiresAt, input.expiresAt])
      expect(learning.learning.reviewAuthorityDigest).toBe(growthObjectDigest(learning.reviews))
      expect(learning.learning.adoptionGrantDigest).toBe(growthObjectDigest(learning.adoption))
      expect(learning.learning.model).toBeUndefined()
      expect(learning.reviews.model).toBeUndefined()
      expect(learning.limits).toEqual({ extractions: 7, scans: 1440 })
      expect(normalizeConfig(manifest.growthDriver).pluginSourceProposals.preparationMode).toBe('durable')
      expect(() => normalizeControlPlaneConfig(manifest.controlPlane)).not.toThrow()
      expect(() => validateSourceReviewConfig(manifest.sourceReviews)).not.toThrow()
      const compiled = await compileRsiProfiles({ manifest, dshHome: input.dshHome, targetPatch: '[]\n',
        targetEffective: input.targetEffective, coordinatorPatch: '[]\n',
        coordinatorEffective: stringify(coordinatorEffective), coordinatorBase, owner: input.owner })
      const patch = parseDocument(compiled.targetPatch)
      expect(isSeq(patch.contents)).toBe(true)
      if (!isSeq(patch.contents)) throw new Error('invalid patch')
      for (const id of ['dsh-enhanced-assistant-growth-driver','dsh-enhanced-assistant-verifier',
        'dsh-enhanced-personal-assistant', 'dsh-enhanced-assistant-memory-learning']) {
        const row = patch.contents.items.find(item => isMap(item) && (item.get('id') as unknown) === id)
        if (!isMap(row)) throw new Error('missing derived row')
        expect(manifest.controlPlane.runtimeObserver!.targets.find(target => target.entryId === id)!.configDigest)
          .toBe(runtimeConfigDigest(rawLoaderConfig(row.get('config',true) as Node,id)))
      }
      const personal = patch.contents.items.find(item => isMap(item) && (item.get('id') as unknown) === 'dsh-enhanced-personal-assistant')
      if (!isMap(personal)) throw new Error('missing personal assistant')
      const personalConfig = personal.toJSON() as { config: { assistantPolicy: { budgets: Array<{id:string;metric:string;scope:string;limit:number}>, rules: unknown[] }; personalMemory: { automaticLearning: unknown } } }
      expect(personalConfig.config.personalMemory.automaticLearning).toEqual(learning.adoption)
      for (const [id, limit, scope] of [[learning.learning.budgetId, 7, 'workspace'], [learning.learning.scanBudgetId, 1440, 'subject']] as const) {
        expect(personalConfig.config.assistantPolicy.budgets).toContainEqual(expect.objectContaining({ id, metric: 'automation-runs', scope, limit }))
      }
      const learner = patch.contents.items.find(item => isMap(item) && (item.get('id') as unknown) === 'dsh-enhanced-assistant-memory-learning')
      if (!isMap(learner)) throw new Error('missing learner')
      expect(learner.get('disabled')).toBe(false)
      expect(compiled.targetPatch).toContain('sourceAdoptions')
      expect(compiled.coordinatorPatch).toContain('adoptionCoordinator')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('rejects ambiguous owner routes, mutable observer rows and incomplete Host inputs', async () => {
    const { root, input } = await fixture()
    try {
      const rows = parse(input.targetEffective) as Array<{ id: string; config: Record<string, any> }>
      const delivery = rows.find(row => row.id === 'dsh-enhanced-assistant-delivery')!
      delivery.config.ownerRoutes.push({ ...structuredClone(delivery.config.ownerRoutes[0]), id: 'other-route' })
      expect(() => createRsiBootstrapManifest({ ...input, targetEffective: stringify(rows) })).toThrow('no unique effective route')
      expect(() => createRsiBootstrapManifest({ ...input, observerTargets: [{ ...input.observerTargets[0]!, entryId: 'dsh-enhanced-plugin-control-plane', module: '@dsh-enhanced/plugin-control-plane', configDigest: runtimeConfigDigest({}) }] })).toThrow('stable effective Loader')
      expect(() => createRsiBootstrapManifest({ ...input, hostDeploymentInputs: input.hostDeploymentInputs.slice(0, 3) })).toThrow('does not cover installed package')
      expect(() => createRsiBootstrapManifest({ ...input, hostDeploymentInputs: input.hostDeploymentInputs.filter(path => !path.includes('/personal-memory/')) })).toThrow('embedded Personal Memory package')
      expect(() => createRsiBootstrapManifest({ ...input, plugins: ['plugin-control-plane'] })).toThrow('protected')
      expect(() => createRsiBootstrapManifest({ ...input, plugins: ['assistant-health'] })).toThrow('scope differs from all installed')
      expect(() => createRsiBootstrapManifest({ ...input, observerTargets: [{ entryId: 'dsh-enhanced-assistant-memory-learning',
        module: '@dsh-enhanced/assistant-memory-learning', configDigest: runtimeConfigDigest(null), services: [] }] })).toThrow('stable effective Loader')
      const tagged = input.targetEffective.replace('enabled: true', 'enabled: !!js true')
      expect(() => createRsiBootstrapManifest({ ...input, targetEffective: tagged })).toThrow('config digest differs')
      expect(() => createRsiBootstrapManifest({ ...input, targetEffective: input.targetEffective.replace('enabled: true', 'enabled: !unknown true') })).toThrow('unsupported YAML tag')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('inherits the triggering conversation model when no fixed growth route is configured', async () => {
    const { root, input } = await fixture()
    try {
      const rows = parse(input.targetEffective) as Array<{ id: string; config: Record<string, any> }>
      rows.find(row => row.id === 'dsh-enhanced-assistant-growth-driver')!.config = {}
      const manifest = createRsiBootstrapManifest({ ...input, targetEffective: stringify(rows) })
      expect(manifest.growthDriver.provider).toBeUndefined()
      expect(manifest.growthDriver.model).toBeUndefined()
      expect(manifest.growthDriver.reasoningEffort).toBeUndefined()
      expect(manifest.sourceReviews.model).toBeUndefined()
      expect(manifest.memoryLearning!.learning.model).toBeUndefined()
      expect(manifest.memoryLearning!.reviews.model).toBeUndefined()
      expect(normalizeConfig(manifest.growthDriver).provider).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('reuses the exact active learner grant and rejects changed owner or learner terms on retry', async () => {
    const { root, input } = await fixture()
    try {
      const original = createRsiBootstrapManifest(input)
      const compiled = await compileRsiProfiles({ manifest: original, dshHome: input.dshHome,
        targetPatch: '[]\n', targetEffective: input.targetEffective, coordinatorPatch: '[]\n',
        coordinatorEffective: stringify(coordinatorEffective), coordinatorBase, owner: input.owner })
      const effective = parse(input.targetEffective) as Array<{ id: string; config?: Record<string, unknown>; disabled?: boolean }>
      const overrides = parse(compiled.targetPatch) as Array<{ id: string; config?: Record<string, unknown>; disabled?: boolean }>
      const active = stringify(effective.map(row => ({ ...row, ...overrides.find(value => value.id === row.id) })))
      expect(createRsiBootstrapManifest({ ...input, targetEffective: active }).memoryLearning).toEqual(original.memoryLearning)
      const changed = parse(active) as typeof effective
      changed.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')!.config!.maxExtractions = 999
      expect(() => createRsiBootstrapManifest({ ...input, targetEffective: stringify(changed) })).toThrow('existing memory learner config differs')
      expect(() => createRsiBootstrapManifest({ ...input, targetEffective: active,
        owner: { ...input.owner, owner: { ...input.owner.owner, version: input.owner.owner.version + 1 } } })).toThrow('existing memory learner config differs')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('accepts fresh default-only plugin rows and observes missing Loader config as null', async () => {
    const { root, input } = await fixture()
    try {
      const rows = parse(input.targetEffective) as Array<{ id: string; config?: Record<string, unknown> }>
      delete rows.find(row => row.id === 'dsh-enhanced-assistant-growth-driver')!.config
      delete rows.find(row => row.id === 'dsh-enhanced-assistant-health')!.config
      const targetEffective = stringify(rows)
      const manifest = createRsiBootstrapManifest({ ...input, targetEffective,
        observerTargets: [{ entryId: 'dsh-enhanced-assistant-health', module: '@dsh-enhanced/assistant-health',
          configDigest: runtimeConfigDigest(null), services: [] }] })
      expect(manifest.growthDriver.provider).toBeUndefined()
      const compiled = await compileRsiProfiles({ manifest, dshHome: input.dshHome, targetPatch: '[]\n',
        targetEffective, coordinatorPatch: '[]\n', coordinatorEffective: stringify(coordinatorEffective),
        coordinatorBase, owner: input.owner })
      expect(compiled.targetPatch).toContain('pluginSourceProposals:')
      expect(compiled.targetPatch).toContain('preparationMode: durable')
      expect(manifest.controlPlane.runtimeObserver!.targets[0]!.configDigest).toBe(runtimeConfigDigest(null))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('validates raw Include !!js expressions without evaluating them', async () => {
    const { root, input } = await fixture()
    try {
      const targetEffective = input.targetEffective.replace('enabled: true', "enabled: !!js dshHomePath('never-execute')")
      const manifest = createRsiBootstrapManifest({ ...input, targetEffective,
        observerTargets: [{ ...input.observerTargets[0]!, configDigest: runtimeConfigDigest({ enabled: { __jsExpr: "dshHomePath('never-execute')" } }) }] })
      expect(manifest.controlPlane.runtimeObserver?.targets[0]?.configDigest).toBe(runtimeConfigDigest({ enabled: { __jsExpr: "dshHomePath('never-execute')" } }))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
