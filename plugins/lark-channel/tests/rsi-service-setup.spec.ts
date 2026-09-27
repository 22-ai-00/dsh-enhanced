import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { resolveRsiServiceEnvironments } from '../src/rsi-service-setup.js'
import { rsiServiceEnvironmentPath } from '../src/rsi-service-environment.js'
import { createRsiAuthorityFixture, type RsiAuthorityFixture } from './fixtures/rsi-authorities.js'

const fixtures: RsiAuthorityFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(value => value.dispose())) })
async function fixture() {
  const f = await createRsiAuthorityFixture(); fixtures.push(f)
  const trustPath = f.manifest.controlPlane.trustPath
  const trust = JSON.parse(await readFile(trustPath, 'utf8'))
  const ambient: Record<string, string> = {}
  for (const [phase, adapter] of Object.entries(trust.releaseAdapters) as Array<[string, any]>) {
    const name = `DSH_RELEASE_${phase.toUpperCase().replaceAll('-', '_')}_CONFIG`
    const path = join(f.root, `${phase} config.json`)
    await writeFile(path, '{}', { mode: 0o600 }); ambient[name] = path; adapter.environmentAllowlist = [name]
  }
  const name = 'DSH_SYSTEMD_HOST_ATTESTOR_CONFIG', path = join(f.root, 'host config.json')
  await writeFile(path, '{}', { mode: 0o600 }); ambient[name] = path; trust.hostAttestor.environmentAllowlist = [name]
  await writeFile(trustPath, JSON.stringify(trust), { mode: 0o600 })
  return { ...f, home: trust.dshHome as string, ambient }
}

test('captures only selected config paths and supplies the coordinator only its Host adapter', async () => {
  const f = await fixture()
  const environments = await resolveRsiServiceEnvironments(f.manifest, f.home, { ...f.ambient, NODE_OPTIONS: '--inspect', OTHER: 'not-a-path' })
  expect(environments!.target).toEqual(f.ambient)
  expect(environments!.coordinator).toEqual({ DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: f.ambient.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG })
})

test('reuses the registered paths without a setup shell and requires explicit manifest changes to replace them', async () => {
  const f = await fixture(), saved = (await resolveRsiServiceEnvironments(f.manifest, f.home, f.ambient))!
  await mkdir(join(f.home, 'rsi-service-environments'), { mode: 0o700 })
  for (const [profile, environment] of [[f.manifest.targetProfile, saved.target], [f.manifest.coordinatorProfile, saved.coordinator]] as const) {
    await writeFile(rsiServiceEnvironmentPath(f.home, profile), JSON.stringify({ schemaVersion: 1, dshHome: f.home, profile, environment }), { mode: 0o600 })
  }
  expect(await resolveRsiServiceEnvironments(f.manifest, f.home, {})).toEqual(saved)
  const replacement = join(f.root, 'replacement.json'); await writeFile(replacement, '{}', { mode: 0o600 })
  expect(await resolveRsiServiceEnvironments(f.manifest, f.home, { DSH_RELEASE_PR_CONFIG: replacement })).toEqual(saved)
  const declared = { target: { ...saved.target, DSH_RELEASE_PR_CONFIG: replacement }, coordinator: saved.coordinator }
  expect(await resolveRsiServiceEnvironments({ ...f.manifest, serviceEnvironment: declared }, f.home, {})).toEqual(declared)
})

test('rejects missing selectors, unselected paths, and different Host config paths before persistence', async () => {
  const f = await fixture()
  await expect(resolveRsiServiceEnvironments(f.manifest, f.home, {})).rejects.toThrow()
  const saved = (await resolveRsiServiceEnvironments(f.manifest, f.home, f.ambient))!
  await expect(resolveRsiServiceEnvironments({ ...f.manifest, serviceEnvironment: { target: {}, coordinator: saved.coordinator } }, f.home, f.ambient))
    .rejects.toThrow('differs from selected trust')
  await expect(resolveRsiServiceEnvironments({ ...f.manifest, serviceEnvironment: { ...saved,
    coordinator: { ...saved.coordinator, DSH_RELEASE_PR_CONFIG: f.ambient.DSH_RELEASE_PR_CONFIG! } } }, f.home, f.ambient))
    .rejects.toThrow('differs from selected trust')
  await expect(resolveRsiServiceEnvironments({ ...f.manifest, serviceEnvironment: { ...saved,
    coordinator: { DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: f.ambient.DSH_RELEASE_PR_CONFIG! } } }, f.home, f.ambient))
    .rejects.toThrow('both Hosts')
})
