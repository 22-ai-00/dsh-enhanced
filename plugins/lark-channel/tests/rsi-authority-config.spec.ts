import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { ControlPlaneStore, loadTrustConfig, validateLiveQualificationAuthorityConfig,
  validateSourceAdoptionAuthorityConfig, validateSourceApprovalAuthorityConfig,
  validateSourceReleaseAuthorityConfig, validateSystemdHostAuthorityConfig,
  validateTaskObservationAuthorityConfig } from '@dsh-enhanced/plugin-control-plane'
import { compileRsiAuthorityConfigs } from '../src/rsi-authority-config.js'
import { validateRsiAuthorities } from '../src/rsi-setup.js'
import { rsiBootstrapFixture } from './fixtures/rsi-bootstrap.js'

const fixtures: Array<{ cleanup(): Promise<void> }> = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup() })

describe.skipIf(process.platform !== 'linux')('owner-bound RSI authority compiler', () => {
  test('emits all distinct private identities and configurations accepted by the production validators', async () => {
    const fixture = await rsiBootstrapFixture(); fixtures.push(fixture)
    const { input, binding } = fixture
    const first = compileRsiAuthorityConfigs(input)
    expect(compileRsiAuthorityConfigs(input)).toEqual(first)
    expect(await readdir(input.resources.configRoot)).toEqual([])
    expect(Object.keys(first.files)).toHaveLength(30)
    expect(first.trust.schemaVersion).toBe(4)
    expect(first.trust.releaseAuthorizationKeys[0]?.authority).toBe(input.resources.identities.release.authority)
    expect(new Set(Object.values(first.trust.releaseAdapters!).map(item => item?.path)).size).toBe(8)
    for (const path of first.directories) await mkdir(path, { recursive: true, mode: 0o700 })
    const store = new ControlPlaneStore({ path: join(input.manifest.controlPlane.statePath, 'control.sqlite') })
    store.close()
    for (const [path, bytes] of Object.entries(first.files)) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600 })
    }
    const cp = input.manifest.controlPlane
    for (const [path, validate] of [
      [cp.sourceApprovals!.configPath, validateSourceApprovalAuthorityConfig],
      [cp.sourceReleases!.configPath, validateSourceReleaseAuthorityConfig],
      [cp.sourceAdoptions!.authority.configPath, validateSourceAdoptionAuthorityConfig],
      [cp.taskObservations!.authority.configPath, validateTaskObservationAuthorityConfig],
      [cp.liveQualification!.authority.configPath, validateLiveQualificationAuthorityConfig],
      [join(input.resources.configRoot, 'host-authority.json'), validateSystemdHostAuthorityConfig],
    ] as const) validate(JSON.parse(await readFile(path, 'utf8')))
    const trust = await loadTrustConfig(cp.trustPath)
    expect(trust.releaseAdapters?.review?.authority).toBe(input.resources.identities.review.authority)
    await validateRsiAuthorities(input.manifest, binding, input.manifest.serviceEnvironment!.target)
    for (const [phase, executable] of Object.entries(input.runtime.releaseAdapters)) {
      const module = await import(pathToFileURL(executable.path).href) as {
        inspectLocalReleaseAdapterConfiguration(environment: Record<string, string>, phase: string): unknown
      }
      const actual = module.inspectLocalReleaseAdapterConfiguration(input.manifest.serviceEnvironment!.target, phase)
      expect(actual).toMatchObject({ phase, executablePath: executable.path,
        authority: input.resources.identities[phase as keyof typeof input.runtime.releaseAdapters].authority })
    }
  }, 120_000)

  test('refuses a changed source, registry, or owner grant before emitting files', async () => {
    const fixture = await rsiBootstrapFixture(); fixtures.push(fixture)
    const original = fixture.input
    const changedSource = { ...original, source: { ...original.source, repository: join(fixture.root, 'another-source') } }
    expect(() => compileRsiAuthorityConfigs(changedSource)).toThrow('source, profile, owner, or policy binding differs')
    const changedRegistry = { ...original, policies: original.policies.map(policy => ({ ...policy, registryId: 'another-registry' })) }
    expect(() => compileRsiAuthorityConfigs(changedRegistry)).toThrow('release policy differs')
    const changedOwner = { ...original.manifest, sourceReviews: { ...original.manifest.sourceReviews,
      owner: { ...original.manifest.sourceReviews.owner, principalId: 'another-principal' } } }
    expect(() => compileRsiAuthorityConfigs({ ...original, manifest: changedOwner })).toThrow('source, profile, owner, or policy binding differs')
    expect(await readdir(original.resources.configRoot)).toEqual([])
  }, 120_000)
})
