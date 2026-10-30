import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument, type Node } from 'yaml'
import { linuxRuntimeDigest } from '@dsh-enhanced/assistant-isolation'
import { normalizeControlPlaneConfig, runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import { normalizeConfig } from '@dsh-enhanced/assistant-growth-driver'
import { compileCreationReviewConfig, compileRevisionReviewConfig, compileRevisionRegressionReviewConfig,
  validateSourceReviewConfig } from '@dsh-enhanced/assistant-verifier'
import { createRsiBootstrapManifest, rawLoaderConfig,
  type RsiBootstrapManifestInput } from '../src/rsi-bootstrap-manifest.js'
import { compileRsiProfiles, type RsiSetupManifest } from '../src/rsi-profile.js'
import type { LinuxRsiCreationBuildEnvironment } from '../src/rsi-linux-creation-build.js'
import type { RsiLinuxSourceBuildPreparation } from '../src/rsi-linux-source-build.js'
import { rsiBootstrapFixture } from './fixtures/rsi-bootstrap.js'
import { nativePreparedFixture } from './fixtures/rsi-linux-install.js'

function rawConfig(yaml: string, id: string): unknown {
  const document = parseDocument(yaml, { uniqueKeys: true })
  if (document.errors.length || !isSeq(document.contents)) throw new Error('invalid fixture profile')
  const row = document.contents.items.find(item => isMap(item) && (item.get('id') as unknown) === id)
  return isMap(row) ? rawLoaderConfig(row.get('config', true) as Node | undefined, id) : undefined
}
async function fixture() {
  const base = await rsiBootstrapFixture()
  try {
    const native = await nativePreparedFixture(base.input.resources, base.input.source)
    await mkdir(join(base.input.resources.stateRoot, 'review-decisions'), { mode: 0o700 })
    await writeFile(join(base.input.resources.configRoot, 'observer.key'), Buffer.alloc(32, 7), { mode: 0o600 })
    const old = base.input.manifest
    const input: RsiBootstrapManifestInput<RsiLinuxSourceBuildPreparation> = {
      dshHome: base.input.resources.root.slice(0, -`/rsi-authorities/${old.targetProfile}`.length),
      targetProfile: old.targetProfile, coordinatorProfile: old.coordinatorProfile,
      targetEffective: base.profiles.targetEffective, owner: base.binding, resources: base.input.resources,
      runtime: base.input.runtime, source: base.input.source, sourceBuild: native.sourceBuild, creationBuild: native.creationBuild,
      runnerStates: native.runnerStates,
      git: old.sourceReviews.git, now: base.input.now, expiresAt: old.controlPlane.sourceJobs!.expiresAt,
      plugins: old.sourceReviews.plugins, hostDeploymentInputs: old.controlPlane.sourceAdoptions!.hostDeploymentInputs!,
      observerTargets: [{ entryId: 'dsh-enhanced-assistant-delivery', module: '@dsh-enhanced/assistant-delivery',
        configDigest: runtimeConfigDigest(rawConfig(base.profiles.targetEffective, 'dsh-enhanced-assistant-delivery')),
        services: ['assistantDelivery'] }],
    }
    const compile = (manifest: RsiSetupManifest) => compileRsiProfiles({ manifest, dshHome: input.dshHome,
      ...base.profiles, owner: base.binding })
    return { base, native, input, compile }
  } catch (error) { await base.cleanup(); throw error }
}
function nativeCreation(input: RsiBootstrapManifestInput<RsiLinuxSourceBuildPreparation>): LinuxRsiCreationBuildEnvironment {
  const build = input.creationBuild
  if (!build || build.schemaVersion !== 3) throw new Error('expected native creation fixture')
  return build
}
function sourceBuild(manifest: RsiSetupManifest) {
  const build = manifest.controlPlane.sourceBuild
  if (!build || !('backend' in build) || build.backend !== 'linux-native') throw new Error('expected native source grant')
  return build
}

// Real source Git, private signing keys and public validators; descriptor-only
// native preparation does not establish runtime bytes or kernel readiness.
describe.runIf(process.platform === 'linux' && process.getuid!() > 0)('complete Linux native bootstrap and profile contract', () => {
  let ctx: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => { ctx = await fixture() }, 30_000)
  afterAll(async () => { await ctx?.base.cleanup() })

  test('binds source modification, creation, revision and regression to one finite owner family', () => {
    const manifest = createRsiBootstrapManifest(ctx.input)
    expect(createRsiBootstrapManifest(ctx.input)).toEqual(manifest)
    const build = sourceBuild(manifest), creation = manifest.pluginCreation!, revision = manifest.pluginRevision!
    expect(build.runtime).toEqual(ctx.native.repository.runtime)
    expect(build.systemSnapshot).toEqual(ctx.native.repository.systemSnapshot)
    expect(build.userNamespace).toEqual(ctx.native.repository.userNamespace)
    expect(build.cgroupRoots).toEqual(ctx.native.cgroupRoots)
    expect(nativeCreation(ctx.input).buildRuntimeDigest).toBe(linuxRuntimeDigest(build.runtime))
    expect(build.runtime.root.path).not.toBe(nativeCreation(ctx.input).behavior.runtime.root.path)
    expect(build).toMatchObject({ expiresAt: ctx.input.expiresAt, maxRuns: 48, maxTotalDurationMs: 86_400_000,
      timeoutMs: 1_800_000, versioning: 'patch', memoryMiB: 16_384, cpus: 8, pidsLimit: 1_024,
      workspaceMiB: 8_192, temporaryMiB: 4_096, workspaceInodes: 1_000_000, temporaryInodes: 1_000_000 })
    expect(manifest.controlPlane.sourceJobs).toMatchObject({ maxSubmissions: 48, expiresAt: ctx.input.expiresAt,
      creation: creation.creation, revision: revision.revision })
    expect(manifest.controlPlane.creationVerifications).toEqual(creation.verifications)
    expect(manifest.controlPlane.creationCapabilities).toEqual(creation.capabilities)
    expect(manifest.controlPlane.revisionVerifications).toEqual(revision.verifications)
    expect(manifest.controlPlane.revisionRegressions).toEqual(revision.regressionVerifications)
    for (const config of [creation.reviews, creation.capabilities, revision.reviews, revision.regressions]) {
      expect(config.owner).toEqual(manifest.sourceReviews.owner)
      expect(config.expiresAt).toBe(ctx.input.expiresAt)
      expect(config.namePrefix).toBe(creation.creation.namePrefix)
      expect(config.runner).toMatchObject({ backend: 'linux-native', expiresAt: ctx.input.expiresAt,
        runtime: ctx.native.creationBuild.behavior, cgroupRoots: ctx.native.cgroupRoots })
    }
    expect(revision.revision.namePrefix).toBe(creation.creation.namePrefix)
    expect(creation.creation.maxCreates).toBe(32); expect(revision.revision.maxRevisions).toBe(32)
    expect(revision.reviews.runner.maxRuns).toBe(160); expect(revision.regressions.runner.maxRuns).toBe(320)
    expect(manifest.controlPlane.creationVerifications!.authority).toEqual(compileCreationReviewConfig(creation.reviews).authority)
    expect(manifest.controlPlane.revisionVerifications!.authority).toEqual(compileRevisionReviewConfig(revision.reviews).authority)
    expect(manifest.controlPlane.revisionRegressions!.authority).toEqual(compileRevisionRegressionReviewConfig(revision.regressions).authority)
    expect(normalizeConfig(manifest.growthDriver).pluginSourceProposals).toMatchObject({ enabled: true,
      preparationMode: 'durable', allowCreation: true, allowRevision: true })
    expect(() => normalizeControlPlaneConfig(manifest.controlPlane)).not.toThrow()
    expect(() => validateSourceReviewConfig(manifest.sourceReviews)).not.toThrow()
    expect(Object.hasOwn(build, 'dockerPath')).toBe(false); expect(Object.hasOwn(build, 'image')).toBe(false)
  })

  test('observes the final compiled Loader options and preserves finite budgets on repeat compilation', async () => {
    const manifest = createRsiBootstrapManifest(ctx.input), output = await ctx.compile(manifest)
    expect(await compileRsiProfiles({ manifest, dshHome: ctx.input.dshHome, ...ctx.base.profiles,
      targetPatch: output.targetPatch, coordinatorPatch: output.coordinatorPatch, owner: ctx.base.binding })).toEqual(output)
    for (const target of manifest.controlPlane.runtimeObserver!.targets) {
      const config = rawConfig(output.targetPatch, target.entryId) ?? rawConfig(ctx.base.profiles.targetEffective, target.entryId)
      expect(target.configDigest, target.entryId).toBe(runtimeConfigDigest(config))
    }
    const verifier = rawConfig(output.targetPatch, 'dsh-enhanced-assistant-verifier') as Record<string, unknown>
    expect(verifier.creationReviews).toEqual(manifest.pluginCreation!.reviews)
    expect(verifier.revisionReviews).toEqual(manifest.pluginRevision!.reviews)
    expect(verifier.revisionRegressions).toEqual(manifest.pluginRevision!.regressions)
    expect(rawConfig(output.targetPatch, 'dsh-enhanced-plugin-control-plane')).toEqual(manifest.controlPlane)
    const personal = rawConfig(output.targetPatch, 'dsh-enhanced-personal-assistant') as { assistantPolicy: { budgets: unknown[] } }
    expect(new Set(personal.assistantPolicy.budgets.map(budget => (budget as { id: string }).id)).size)
      .toBe(personal.assistantPolicy.budgets.length)
    const coordinator = rawConfig(output.coordinatorPatch, 'dsh-enhanced-plugin-control-plane') as Record<string, unknown>
    expect(coordinator.adoptionCoordinator).toBeDefined(); expect(coordinator.sourceJobs).toBeUndefined()
    expect(coordinator.sourceBuild).toBeUndefined(); expect(coordinator.creationCapabilities).toBeUndefined()
  })

  test('explicitly disabling revision preserves source repair and creation without issuing revision grants', async () => {
    const manifest = createRsiBootstrapManifest({ ...ctx.input, enableRevision: false })
    expect(manifest.pluginCreation).toBeDefined(); expect(sourceBuild(manifest).backend).toBe('linux-native')
    expect(manifest.pluginRevision).toBeUndefined(); expect(manifest.controlPlane.sourceJobs!.revision).toBeUndefined()
    expect(manifest.controlPlane.revisionVerifications).toBeUndefined(); expect(manifest.controlPlane.revisionRegressions).toBeUndefined()
    expect(normalizeConfig(manifest.growthDriver).pluginSourceProposals).toMatchObject({ allowCreation: true, allowRevision: false })
    const output = await ctx.compile(manifest)
    const verifier = rawConfig(output.targetPatch, 'dsh-enhanced-assistant-verifier') as Record<string, unknown>
    expect(verifier.creationReviews).toBeDefined(); expect(verifier.revisionReviews).toBeUndefined(); expect(verifier.revisionRegressions).toBeUndefined()
    for (const target of manifest.controlPlane.runtimeObserver!.targets) {
      expect(target.configDigest).toBe(runtimeConfigDigest(rawConfig(output.targetPatch, target.entryId)
        ?? rawConfig(ctx.base.profiles.targetEffective, target.entryId)))
    }
  })

  test('bootstrap rejects source, lock, repository binding, cgroup and observer root drift', () => {
    const changes: Array<(input: typeof ctx.input) => void> = [
      input => { input.sourceBuild.repository.sourceCommit = '9'.repeat(40) },
      input => { input.sourceBuild.repository.lockSha256 = '9'.repeat(64) },
      input => { nativeCreation(input).sourceCommit = '9'.repeat(40) },
      input => { nativeCreation(input).behavior.runtime.lockSha256 = '9'.repeat(64) },
      input => { nativeCreation(input).buildRuntimeDigest = '9'.repeat(64) },
      input => { delete nativeCreation(input).buildRuntimeDigest },
      input => { nativeCreation(input).cgroupRoots.pids = `/sys/fs/cgroup/pids,x/dsh-native/uid-${process.getuid!()}` },
      input => { nativeCreation(input).behavior.runtime.root.path += '-moved' },
      input => { input.sourceBuild.repository.runtime.root.ino += 1 },
    ]
    for (const change of changes) {
      const input = structuredClone(ctx.input); change(input)
      expect(() => createRsiBootstrapManifest(input)).toThrow(/source build|creation environment|creation runtime/u)
    }
  })

  test('bootstrap rejects mixed Docker and native families or revision without creation', () => {
    const docker = ctx.base.input.manifest.controlPlane.sourceBuild!
    if ('backend' in docker) throw new Error('expected legacy Docker fixture')
    expect(() => createRsiBootstrapManifest({ ...ctx.input, sourceBuild: { ...docker, versioning: 'patch' } })).toThrow('runner states require')
    expect(() => createRsiBootstrapManifest({ ...ctx.input, creationBuild: { schemaVersion: 1,
      sourceCommit: ctx.input.source.sourceCommit, sourceImage: docker.image, image: 'sha256:' + 'a'.repeat(64),
      dockerPath: docker.dockerPath } })).toThrow('creation image')
    const incomplete = { ...ctx.input, enableRevision: true }; delete incomplete.creationBuild
    expect(() => createRsiBootstrapManifest(incomplete)).toThrow(/revision.*creation/u)
  })

  test('profile rejects partial revision chains and owner or expiry mismatches', async () => {
    const changes: Array<(manifest: RsiSetupManifest) => void> = [
      manifest => { delete manifest.pluginRevision },
      manifest => { delete manifest.controlPlane.sourceJobs!.revision },
      manifest => { delete manifest.controlPlane.revisionVerifications },
      manifest => { delete manifest.controlPlane.revisionRegressions },
      manifest => { manifest.growthDriver.pluginSourceProposals!.allowRevision = false },
      manifest => { manifest.pluginRevision!.reviews.owner.principalVersion += 1 },
      manifest => { manifest.pluginRevision!.revision.expiresAt += 1 },
    ]
    for (const change of changes) {
      const manifest = structuredClone(createRsiBootstrapManifest(ctx.input)); change(manifest)
      await expect(ctx.compile(manifest)).rejects.toThrow(/revision|owner|expiry/u)
    }
  })

  test.each(['source', 'lock', 'cgroups', 'root-identity'] as const)(
    'profile rejects %s drift between its source build and retained creation/revision family', async field => {
      const manifest = structuredClone(createRsiBootstrapManifest(ctx.input)), build = sourceBuild(manifest)
      if (field === 'source') build.runtime.sourceCommit = '9'.repeat(40)
      else if (field === 'lock') build.runtime.lockSha256 = '9'.repeat(64)
      else if (field === 'cgroups') {
        if (build.cgroupRoots.mode !== 'v1') throw new Error('expected cgroup v1 fixture')
        build.cgroupRoots.pids = `/sys/fs/cgroup/pids,x/dsh-native/uid-${process.getuid!()}`
      }
      else build.runtime.root.ino += 1
      await expect(ctx.compile(manifest)).rejects.toThrow()
    })
})
