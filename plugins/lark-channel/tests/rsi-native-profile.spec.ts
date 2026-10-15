import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { normalizeConfig as normalizeGrowthConfig } from '@dsh-enhanced/assistant-growth-driver'
import { loadTrustConfig, normalizeControlPlaneConfig, runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import { validateLearningConfig } from '@dsh-enhanced/assistant-memory-learning'
import { Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { Config as AutomationsConfig } from '@dsh-enhanced/assistant-automations'
import { MemoryLearningRuntime, type LearningPorts } from '../../assistant-memory-learning/lib/runtime.js'
import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.ts'
import { compileNativeRsiProfile, type NativeRsiProfileInput } from '../src/rsi-native-profile.ts'
import type { RsiCreationBuildEnvironment } from '../src/rsi-creation-build.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(): Promise<NativeRsiProfileInput> {
  const root = await mkdtemp(join(await realpath('/tmp'), 'nr-')); roots.push(root)
  const home = join(root, 'h'), workspace = join(root, 'w'), sourceRoot = join(root, 's'), release = join(root, 'r')
  for (const path of [home, workspace, sourceRoot, release, join(home, 'profiles', 'web')]) await mkdir(path, { recursive: true })
  const resources = await prepareRsiAuthorityResources({ dshHome: home, profile: 'web' })
  for (const name of ['creation-review-runner', 'creation-adoption-runner']) await mkdir(join(resources.stateRoot, name), { mode: 0o700 })
  const observer = { socketPath: join(resources.stateRoot, 'observer.sock'), keyPath: join(resources.configRoot, 'observer.key') }
  await writeFile(observer.keyPath, Buffer.alloc(32, 9), { mode: 0o600 })
  const seccompPath = join(resources.configRoot, 'source-builder-seccomp.json')
  await writeFile(seccompPath, await readFile(new URL('../../../scripts/isolation/source-builder-seccomp.json', import.meta.url)), { mode: 0o600 })
  const principal = { channel: 'lark' as const, account: 'account', tenant: 'tenant', user: 'owner' }
  const conversation = { channel: 'lark' as const, account: 'account', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' }
  const owner = { id: 'binding', conversation, principal, workspace, agentPreset: 'primary', sessionId: 'session',
    generation: 1, policyRef: 'owner-policy', status: 'active' as const, createdAt: 1, updatedAt: 1, version: 1,
    owner: { id: 'principal-record', principal, role: 'owner' as const, status: 'active' as const, createdAt: 1, updatedAt: 1, version: 1 } }
  const row = (name: string, config: object, extra = {}) => ({ id: `dsh-enhanced-${name}`, name: `@dsh-enhanced/${name}`, config, ...extra })
  const targetEffective = stringify([
    row('personal-assistant', { assistantPolicy: { databasePath: join(root, 'policy.sqlite'), budgets: [], rules: [] },
      assistantAutomations: { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
        schedulerEnabled: false, allowUnbudgetedExecution: false },
      personalMemory: { databasePath: join(root, 'memory.sqlite') } }),
    row('assistant-delivery', { defaultWorkspace: workspace, defaultAgentPreset: 'primary', ownerRoutes: [] }),
    row('assistant-verifier', { databasePath: join(root, 'verifier.sqlite') }),
    row('assistant-growth-driver', { provider: 'owner-provider', model: 'owner-model' }),
    { id: 'dsh-enhanced-assistant-memory-learning', name: '@dsh-enhanced/assistant-memory-learning', disabled: true },
    row('plugin-control-plane', {}), row('lark-channel', { enabled: true }),
  ])
  const now = Date.now(), image = `sha256:${'a'.repeat(64)}`, dockerPath = await realpath(process.execPath)
  const executorPath = join(root, 'executor'), executorBytes = '#!/bin/sh\nexit 0\n'
  await writeFile(executorPath, executorBytes, { mode: 0o500 })
  return { dshHome: home, targetProfile: 'web', targetEffective,
    targetPatch: "- id: custom-row\n  name: custom-package\n  config: { keep: true, path: !!js dshHomePath('custom') }\n",
    owner, resources, source: { schemaVersion: 1, version: '0.1.49', origin: { kind: 'local-head', locator: root, ref: 'HEAD' },
      sourceCommit: 'b'.repeat(40), repository: sourceRoot,
      baseline: { ref: 'refs/dsh-source/repairs', remote: release, targetBranch: 'repairs', initialCommit: 'b'.repeat(40) } },
    sourceBuild: { dockerPath, socketPath: join(root, 'docker.sock'), daemonId: 'daemon-test-12345', profile: 'portable-repository',
      repositorySandbox: { seccompPath },
      image, timeoutMs: 60_000, memoryMiB: 128, cpus: 1, pidsLimit: 16,
      workspaceMiB: 64, outputBytes: 4096, versioning: 'patch' },
    creationBuild: { schemaVersion: 1, sourceCommit: 'b'.repeat(40), sourceImage: image,
      image: `sha256:${'c'.repeat(64)}`, dockerPath, socketPath: join(root, 'docker.sock') },
    executor: { id: 'native-executor', version: '1', path: executorPath,
      sha256: createHash('sha256').update(executorBytes).digest('hex'), environmentAllowlist: [] },
    now, expiresAt: now + 30 * 86_400_000, observer }
}

describe('native owner learning profile', () => {
  test('binds native compiler and behavior runners to one frozen runtime and finite owner grant', async () => {
    const input = await fixture(), root = join(input.dshHome, 'rsi-native-runtimes', 'web', 'runtime')
    const runtime = { schemaVersion: 1 as const, platform: `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64',
      nodePath: join(root, 'bin', 'node'), nodeSha256: 'a'.repeat(64),
      roots: [{ path: root, dev: 1, ino: 2, sha256: 'b'.repeat(64) }], modulesPath: join(root, 'node_modules'),
      versions: { node: 'v24.22.0', typescript: '5.9.3', cordis: '3.0.0', tools: '1.0.0', systemPrompt: '1.0.0' } }
    const native = { ...input,
      sourceBuild: { backend: 'macos-seatbelt' as const, runtime, timeoutMs: 60_000 as const,
        outputBytes: 1_048_576 as const, versioning: 'patch' as const },
      creationBuild: { schemaVersion: 2 as const, backend: 'macos-seatbelt' as const,
        sourceCommit: input.source.sourceCommit, runtime } }
    const compiled = compileNativeRsiProfile(native)
    expect(compiled.manifest.controlPlane.sourceBuild).toMatchObject({ backend: 'macos-seatbelt', runtime,
      stateRoot: join(input.resources.stateRoot, 'native-source-build'), expiresAt: input.expiresAt,
      maxRuns: 1000, maxTotalDurationMs: 86_400_000, timeoutMs: 60_000, outputBytes: 1_048_576 })
    expect(compiled.manifest.pluginCreation.reviews.runner).toMatchObject({ backend: 'macos-seatbelt', runtime })
    expect(compiled.manifest.pluginCreation.capabilities.runner).toMatchObject({ backend: 'macos-seatbelt', runtime })
    expect(compileNativeRsiProfile(native)).toEqual(compiled)
    expect(() => compileNativeRsiProfile({ ...native, creationBuild: { ...native.creationBuild,
      runtime: { ...runtime, nodeSha256: 'c'.repeat(64) } } })).toThrow('native creation runtime differs')
  })

  test('compiles finite memory and creation grants, final observation digests, and create-only Host authority', async () => {
    const input = await fixture()
    const first = compileNativeRsiProfile(input)
    const rows = parse(first.targetPatch) as Array<{ id: string; config: any }>
    const effectiveRows = parse(input.targetEffective) as Array<{ id: string; config: any }>
    const get = (name: string) => (rows.find(row => row.id === `dsh-enhanced-${name}`)
      ?? effectiveRows.find(row => row.id === `dsh-enhanced-${name}`))!.config
    expect(first.manifest).toMatchObject({ schemaVersion: 1, kind: 'native-plugin-learning', now: input.now, expiresAt: input.expiresAt })
    expect(first.manifest.growthDriver.pluginSourceProposals).toMatchObject({ allowModification: false, allowCreation: true, allowRevision: false })
    expect(get('assistant-growth-driver')).toMatchObject({ provider: 'owner-provider', model: 'owner-model' })
    expect(get('plugin-control-plane').sourceJobs.allowedModes).toEqual(['create'])
    expect(get('plugin-control-plane')).not.toHaveProperty('sourceApprovals')
    expect(get('plugin-control-plane')).not.toHaveProperty('sourceReleases')
    expect(get('plugin-control-plane')).not.toHaveProperty('sourceAdoptions')
    expect(get('assistant-verifier').creationReviews.owner).toEqual(first.manifest.owner)
    expect(get('assistant-verifier').memoryReviews.owner).toEqual(first.manifest.owner)
    expect(get('personal-assistant').personalMemory.automaticLearning.owner).toEqual(first.manifest.owner)
    expect(() => PolicyConfig(get('personal-assistant').assistantPolicy)).not.toThrow()
    expect(() => AutomationsConfig(get('personal-assistant').assistantAutomations)).not.toThrow()
    expect(() => normalizeGrowthConfig(get('assistant-growth-driver'))).not.toThrow()
    expect(() => normalizeControlPlaneConfig(get('plugin-control-plane'))).not.toThrow()
    expect(() => validateLearningConfig(get('assistant-memory-learning'))).not.toThrow()
    expect(rows.find(row => row.id === 'custom-row')!.config.keep).toBe(true)
    expect(first.targetPatch).toContain("!!js dshHomePath('custom')")
    expect(first.trust).toMatchObject({ schemaVersion: 2, hostAttestor: null, executor: input.executor })
    expect(first.trust.ledger.path).toBe(join(input.resources.stateRoot, 'control-plane', 'control.sqlite'))
    await mkdir(join(input.resources.stateRoot, 'control-plane'), { mode: 0o700 })
    await writeFile(first.manifest.controlPlane.trustPath, JSON.stringify(first.trust), { mode: 0o600 })
    expect((await loadTrustConfig(first.manifest.controlPlane.trustPath)).hostAttestor).toBeUndefined()
    const targets = first.manifest.controlPlane.runtimeObserver!.targets
    expect(targets.map(target => target.entryId)).toContain('dsh-enhanced-assistant-memory-learning')
    expect(targets.find(target => target.entryId === 'dsh-enhanced-lark-channel')?.services).toEqual(['larkChannel'])
    expect(targets.find(target => target.entryId === 'dsh-enhanced-personal-assistant')?.services).toContain('assistantAutomations')
    for (const target of targets) expect(target.configDigest).toBe(runtimeConfigDigest(get(target.entryId.slice('dsh-enhanced-'.length))))
    expect(compileNativeRsiProfile({ ...input, targetPatch: first.targetPatch }).targetPatch).toBe(first.targetPatch)
  })

  test('rejects changed owner, existing learning grants and source build drift', async () => {
    const input = await fixture()
    expect(() => compileNativeRsiProfile({ ...input, owner: { ...input.owner, workspace: '/tmp/other' } })).toThrow('owner')
    const rows = parse(input.targetEffective) as Array<{ id: string; config: any; disabled?: boolean }>
    rows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')!.config = { authorityId: 'foreign' }
    rows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')!.disabled = false
    expect(() => compileNativeRsiProfile({ ...input, targetEffective: stringify(rows) })).toThrow('existing memory learner grant differs')
    const dockerBuild = input.creationBuild as RsiCreationBuildEnvironment
    expect(() => compileNativeRsiProfile({ ...input, creationBuild: { ...dockerBuild, sourceImage: `sha256:${'0'.repeat(64)}` } })).toThrow('creation build differs')
    expect(() => compileNativeRsiProfile({ ...input, creationBuild: { ...dockerBuild, socketPath: '/tmp/other.sock' } })).toThrow('creation build differs')
  })

  test('registers a native memory scan against the generated Policy and Automations config', async () => {
    const input = await fixture(), compiled = compileNativeRsiProfile(input)
    const rows = parse(compiled.targetPatch) as Array<{ id: string; config: any }>
    const personal = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!.config
    const ctx = new Context()
    const policy = new AssistantPolicyService(ctx, PolicyConfig(personal.assistantPolicy))
    const automations = new AssistantAutomationsService(ctx, AutomationsConfig(personal.assistantAutomations))
    const evaluation = new AssistantEvaluationService(ctx, { databasePath: join(input.dshHome, 'evaluation.sqlite'), projectionIntervalMs: 0 })
    const config = compiled.manifest.memoryLearning.learning, owner = compiled.manifest.owner
    const delivery = {
      validateOwnerRoute: () => owner,
      listOwnerForegroundTaskSources: () => ({ items: [], nextCursor: { protocol: 'assistant-delivery/owner-foreground-source-cursor/v1',
        epoch: 'fixture-epoch', scopeKey: 'fixture-owner', sequence: 0 }, watermark: 0, hasMore: false }),
      inspectOwnerForegroundTaskSource: () => undefined,
      withOwnerForegroundTaskSourcesFence: () => { throw new Error('no task source in this test') },
      inspectOwnerForegroundLearningTask: () => undefined,
    } as unknown as LearningPorts['delivery']
    const memory = {
      listLearningTargets: () => [], inspectLearningAdoptionAvailability: () => ({ authorityId: config.adoptionAuthorityId,
        grantDigest: config.adoptionGrantDigest, expiresAt: config.expiresAt, remainingMutations: 1,
        remainingContentBytes: 1, available: true }),
      lookupLearningAdoption: () => undefined,
      adoptReviewedLearning: () => { throw new Error('no learning candidate in this test') },
    } as unknown as LearningPorts['memory']
    const verifier = {
      inspectMemoryLearningReviewAvailability: () => ({ authorityId: config.reviewAuthorityId,
        authorityDigest: config.reviewAuthorityDigest, expiresAt: config.expiresAt, remainingReviews: 1, available: true }),
      reviewMemoryLearning: async () => { throw new Error('no learning candidate in this test') },
      lookupMemoryLearningReview: () => undefined,
    } as unknown as LearningPorts['verifier']
    const runtime = new MemoryLearningRuntime(config, { delivery, evaluation, automations, memory, verifier, policy,
      extract: async () => { throw new Error('no learning candidate in this test') } })
    try {
      runtime.start()
      const scanId = `memory-scan-${growthObjectDigest([config.authorityId, owner])}`
      expect(runtime.health()).toMatchObject({ enabled: true, connected: true, lastError: null })
      expect(automations.listSystemOwned({ owner: 'assistant-memory-learning' })).toEqual([
        expect.objectContaining({ automationId: scanId }),
      ])
      expect(automations.inspectSystemOwned({ owner: 'assistant-memory-learning', automationId: scanId }))
        .toMatchObject({ automationStatus: 'active' })
    } finally { await runtime.close(); await ctx.fiber.restart() }
  })
})
