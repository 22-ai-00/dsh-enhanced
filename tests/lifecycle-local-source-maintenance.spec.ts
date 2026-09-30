import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import * as yaml from 'yaml'
import { assertLocalSourceInstaller, assertLocalSourceRawPreflight, assertMemoryLearningCandidateConfigs, assertPreOwnerAuthorityState, assertPreOwnerEffectiveConfigs,
  bindLocalSourceInstaller, expectedMemoryLearningSemanticDigest } from '../scripts/install/local-source-maintenance.mjs'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { rsiMemoryLearningInitialRow } from '../plugins/lark-channel/src/rsi-local-roots-extension.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const home = '/srv/dsh'
const base = [
  { id: 'assistant', name: '@dsh-enhanced/personal-assistant', config: { assistantAutomations: { schedulerEnabled: false } } },
  { id: 'recovery', name: '@dsh-enhanced/assistant-recovery', config: { jobs: [], databasePath: `${home}/state/recovery.sqlite` } },
  { id: 'control', name: '@dsh-enhanced/plugin-control-plane', config: { sourceJobs: null, sourceAdoptions: null, statePath: `${home}/state/control` } },
  { id: 'delivery', name: '@dsh-enhanced/assistant-delivery', config: { schedulerEnabled: true, ownerRoutes: [] } },
]
function check(rows = base, extra: Record<string, string> = {}) {
  return assertPreOwnerEffectiveConfigs({ assistant: yaml.stringify(rows), ...extra }, home, 'assistant', yaml)
}
async function installerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'local-source-installer-'))
  roots.push(root)
  for (const directory of ['plugins/lark-channel/lib', 'packages/shared/lib', 'scripts/install', 'node_modules']) await mkdir(join(root, directory), { recursive: true })
  for (const path of ['package.json', 'pnpm-lock.yaml', 'plugins/lark-channel/package.json', 'packages/shared/package.json']) await writeFile(join(root, path), '{}', { mode: 0o600 })
  await writeFile(join(root, 'plugins/lark-channel/lib/entry.js'), 'export const version = 1\n', { mode: 0o600 })
  await writeFile(join(root, 'scripts/install/local-source-maintenance.mjs'), 'export {}\n', { mode: 0o600 })
  const require = createRequire(import.meta.url)
  await cp(dirname(require.resolve('yaml/package.json')), join(root, 'node_modules/yaml'), { recursive: true })
  return root
}

describe('pre-owner local source maintenance admission', () => {
  test('permits ordinary base Recovery/Control Plane and Delivery scheduling without source authority', () => {
    expect(Object.keys(check())).toEqual(['assistant'])
    expect(check(base, { web: yaml.stringify([{ id: 'retained', name: '@dsh-enhanced/assistant-delivery', disabled: true, config: { schedulerEnabled: true } }]) })).toHaveProperty('web')
  })
  test.each(['sourceJobs', 'sourceApprovals', 'sourceReleases', 'sourceReleaseExecution', 'sourceAdoptions', 'sourceBuild', 'runtimeObserver', 'foregroundDeployments', 'taskObservations', 'adoptionCoordinator', 'memoryReviews', 'automaticLearning'])('rejects active or retained %s in any profile', field => {
    expect(() => check(base, { other: yaml.stringify([{ id: 'other', name: '@dsh-enhanced/plugin-control-plane', disabled: true, config: { [field]: {} } }]) })).toThrow('owner/source')
  })
  test.each([
    { id: 'auto', name: '@dsh-enhanced/assistant-automations', config: { schedulerEnabled: true } },
    { id: 'assistant', name: '@dsh-enhanced/personal-assistant', config: { assistantAutomations: { schedulerEnabled: true } } },
    { id: 'recovery', name: '@dsh-enhanced/assistant-recovery', config: { jobs: [{ id: 'historical' }] } },
    { id: 'control', name: '@dsh-enhanced/plugin-control-plane', config: { trustPath: `${home}/rsi-authorities/assistant/config/trust.json` } },
  ])('rejects automatic work or retained grant configuration: $id', row => { expect(() => check([row])).toThrow() })
  test('rejects unresolved dynamic config and malformed effective rows', () => {
    expect(() => assertPreOwnerEffectiveConfigs({ assistant: '- id: a\n  name: "@dsh-enhanced/plugin-control-plane"\n  config: !!js ownerConfig()\n' }, home, 'assistant', yaml)).toThrow('dynamic owner-sensitive')
    expect(() => check([{ config: {} }] as never)).toThrow('row identity')
  })
  test('permits inert native JS paths and scripts while rejecting dynamic authority', () => {
    const source = '- id: ordinary\n  name: x\n  config:\n    path: !!js process.env.DSH_HOME + "/state"\n    script: !!js "echo hi"\n'
    expect(assertPreOwnerEffectiveConfigs({ assistant: source }, home, 'assistant', yaml)).toHaveProperty('assistant')
    expect(() => assertPreOwnerEffectiveConfigs({ assistant: source.replace('process.env.DSH_HOME + "/state"', 'sourceAdoptions()') }, home, 'assistant', yaml)).toThrow('dynamic owner/source')
    expect(() => assertPreOwnerEffectiveConfigs({ assistant: source.replace('process.env.DSH_HOME + "/state"', 'automaticLearning()') }, home, 'assistant', yaml)).toThrow('dynamic owner/source')
  })
  test('only inert and unconfigured memory learner rows are pre-owner', () => {
    expect(() => check([rsiMemoryLearningInitialRow])).not.toThrow()
    expect(() => check([{ ...rsiMemoryLearningInitialRow, disabled: false }])).toThrow('disabled and unconfigured')
    expect(() => check([{ ...rsiMemoryLearningInitialRow, config: {} }])).toThrow('disabled and unconfigured')
    expect(() => check([{ ...rsiMemoryLearningInitialRow, id: 'other' }])).toThrow('disabled and unconfigured')
    expect(() => check([{ ...rsiMemoryLearningInitialRow, name: 'other' }])).toThrow('disabled and unconfigured')
  })
  test('binds the exact disabled learner row and old YAML AST, including JS tags and row order', () => {
    const original = '- id: ordinary\n  name: x\n  config:\n    path: !!js process.env.DSH_HOME + "/state"\n'
    const learner = yaml.stringify([rsiMemoryLearningInitialRow])
    const other = yaml.stringify([{ id: 'web', name: '@dsh-enhanced/assistant-delivery', disabled: true }])
    const targetProfile = 'assistant'
    const expectedCandidateSemanticDigest = expectedMemoryLearningSemanticDigest(original, yaml, rsiMemoryLearningInitialRow)
    const admission = { original: { configDigests: {
      assistant: assertPreOwnerEffectiveConfigs({ assistant: original }, home, 'assistant', yaml).assistant,
      web: assertPreOwnerEffectiveConfigs({ web: other }, home, 'web', yaml).web,
    } }, targetProfile, expectedCandidateSemanticDigest }
    const accept = (assistant: string, web = other) => assertMemoryLearningCandidateConfigs({
      ...admission, configs: { assistant, web },
    }, yaml, rsiMemoryLearningInitialRow)
    expect(() => accept(original + learner)).not.toThrow()
    expect(() => accept(learner + original)).not.toThrow()
    expect(() => accept(original + learner, other.replace('disabled: true', 'disabled: false'))).toThrow('other effective profile')
    expect(() => accept(original.replace('!!js ', '') + learner)).toThrow('pre-existing effective rows')
    expect(() => accept(original.replace('path:', 'differentPath:') + learner)).toThrow('pre-existing effective rows')
    expect(() => accept(original + learner.replace('disabled: true', 'disabled: false'))).toThrow('fixed disabled bundle row')
    expect(() => accept(original + learner.replace('assistantPolicy', 'otherPolicy'))).toThrow('fixed disabled bundle row')
    expect(() => accept(original + learner.replace('disabled: true', 'disabled: true\n  config: {}'))).toThrow('fixed disabled bundle row')
    expect(() => accept(original + learner + learner)).toThrow('duplicate effective row identity')
    expect(() => accept(original)).toThrow('fixed disabled bundle row')
    expect(() => expectedMemoryLearningSemanticDigest(original + learner, yaml, rsiMemoryLearningInitialRow)).toThrow('already present')
  })
  test('package sandbox action forwards the frozen extension to native package staging', async () => {
    const root = await installerFixture()
    await writeFile(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 })
    await writeFile(join(root, 'plugins/lark-channel/package.json'), '{"type":"module"}', { mode: 0o600 })
    for (const name of ['rsi-local-update', 'rsi-local-resources', 'rsi-source-maintenance', 'rsi-local-activation',
      'rsi-local-pair-install', 'rsi-local-roots-extension', 'rsi-local-cohort', 'rsi-authority-runtime', 'supervised-growth-profile']) {
      await writeFile(join(root, 'plugins/lark-channel/lib', `${name}.js`), name === 'rsi-local-pair-install'
        ? 'export async function stageRsiLocalSinglePackages(input) { return { extension: input.rootExtension ?? null } }\n'
        : 'export {}\n', { mode: 0o600 })
    }
    const installer = await bindLocalSourceInstaller(root)
    const inputPath = join(root, 'package-input.json')
    const run = async (extension?: string) => {
      await writeFile(inputPath, JSON.stringify({ homePath: '/staged', profile: 'assistant', originalCohort: {}, dsh: {},
        proof: { installer, ...(extension ? { extension } : {}) } }), { mode: 0o600 })
      return spawnSync(process.execPath, [join(process.cwd(), 'scripts/install/local-source-maintenance.mjs'), 'packages', inputPath],
        { encoding: 'utf8' })
    }
    const extended = await run('memory-learning')
    expect(extended.status).toBe(0)
    expect(JSON.parse(extended.stdout)).toEqual({ extension: 'memory-learning' })
    const legacy = await run()
    expect(legacy.status).toBe(0)
    expect(JSON.parse(legacy.stdout)).toEqual({ extension: null })
  })
  test('rechecks authority emptiness and signed sidecar host absence on stopped copies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-source-authority-'))
    roots.push(root)
    const authority = join(root, 'rsi-authorities', 'assistant')
    for (const name of ['config', 'identities', 'registry', 'state']) await mkdir(join(authority, name), { recursive: true, mode: 0o700 })
    await writeFile(join(authority, 'bootstrap.json'), '{}', { mode: 0o600 })
    await writeFile(join(authority, 'catalog.json'), '{"schemaVersion":1,"entries":[]}', { mode: 0o600 })
    await expect(assertPreOwnerAuthorityState(root, 'assistant', [{ host: null }])).resolves.toBeUndefined()
    await expect(assertPreOwnerAuthorityState(root, 'assistant', [{ host: {} }])).rejects.toThrow('Host activation')
    await writeFile(join(authority, 'state', 'control.sqlite'), 'owner state', { mode: 0o600 })
    await expect(assertPreOwnerAuthorityState(root, 'assistant', [{ host: null }])).rejects.toThrow('state is not empty')
    await rm(join(authority, 'state', 'control.sqlite'))
    await writeFile(join(authority, 'catalog.json'), '{"schemaVersion":1,"entries":[{}]}', { mode: 0o600 })
    await expect(assertPreOwnerAuthorityState(root, 'assistant', [{ host: null }])).rejects.toThrow('catalog is not empty')
  })
  test('rejects a linked package root rather than omitting executable bytes', async () => {
    const root = await installerFixture()
    await rm(join(root, 'plugins/lark-channel'), { recursive: true })
    await symlink('/usr/lib', join(root, 'plugins/lark-channel'))
    await expect(bindLocalSourceInstaller(root)).rejects.toThrow('linked installer package root')
  })
  test('binds module bytes including same-version changes and refuses an external module link', async () => {
    const root = await installerFixture()
    const binding = await bindLocalSourceInstaller(root)
    await assertLocalSourceInstaller(binding)
    await writeFile(join(root, 'plugins/lark-channel/lib/entry.js'), 'export const version = 2\n')
    await expect(assertLocalSourceInstaller(binding)).rejects.toThrow('bytes or ownership changed')
    await symlink('/usr/lib', join(root, 'node_modules/external'))
    await expect(bindLocalSourceInstaller(root)).rejects.toThrow('escapes reviewed root')
  })
  test('rejects an ancestor YAML parser before importing reviewed modules', async () => {
    const parent = await installerFixture()
    const root = join(parent, 'reviewed')
    await mkdir(root)
    for (const directory of ['plugins', 'packages', 'scripts', 'node_modules']) await cp(join(parent, directory), join(root, directory), { recursive: true })
    for (const name of ['package.json', 'pnpm-lock.yaml']) await cp(join(parent, name), join(root, name))
    await rm(join(root, 'node_modules/yaml'), { recursive: true })
    const binding = await bindLocalSourceInstaller(root)
    await expect(assertLocalSourceRawPreflight({ homePath: home, profile: 'assistant', installer: binding })).rejects.toThrow('YAML parser is outside')
  })
  test('binds absence of platform-optional pnpm links and detects appearance', async () => {
    const root = await installerFixture()
    await symlink('../optional', join(root, 'node_modules/optional'))
    const binding = await bindLocalSourceInstaller(root)
    await mkdir(join(root, 'optional'))
    await writeFile(join(root, 'optional/module.js'), 'export {}')
    await expect(assertLocalSourceInstaller(binding)).rejects.toThrow('bytes or ownership changed')
  })
  test('only version 5 accepts the explicit pre-owner envelope; legacy versions remain closed', async () => {
    const root = await installerFixture()
    const hash = 'a'.repeat(64)
    const selected = { mode: 'pre-owner', sourceDigest: hash,
      resources: Object.fromEntries(['rsi-sources', 'rsi-local-cohorts', 'rsi-builds', 'rsi-release-builds', 'rsi-authorities', 'rsi-authority-runtimes'].map(name => [name, hash])),
      metadata: Object.fromEntries(['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'].map(name => [name, hash])), configDigests: { assistant: hash }, rawConfiguration: { profiles: ['assistant'], files: { 'cordis.yml': null, 'cordis.patch.yml': null, 'profiles/assistant/cordis.yml': hash, 'profiles/assistant/cordis.patch.yml': hash } } }
    const manifest = { version: 5, homePath: home, operation: 'upgrade', state: 'validated', localSourceMaintenance: {
      protocol: 'dsh-enhanced/pre-owner-source-maintenance/v1', installer: await bindLocalSourceInstaller(root),
      preparationRoot: '/srv/candidate', preparationDigest: hash, original: selected, candidate: selected,
      bwrapExecutable: '/usr/bin/bwrap', driverDigest: hash,
    } }
    expect(lifecycleProfileTest.validLocalSourceManifest(manifest)).toBe(true)
    expect(lifecycleProfileTest.validLocalSourceManifest({ ...manifest, version: 3 })).toBe(false)
    expect(lifecycleProfileTest.validLocalSourceManifest({ ...manifest, rsiCoordinator: {} })).toBe(false)
    expect(lifecycleProfileTest.validLocalSourceManifest({ ...manifest, localSourceMaintenance: { ...manifest.localSourceMaintenance, candidate: null } })).toBe(false)
    expect(lifecycleProfileTest.validLocalSourceManifest({ ...manifest, localSourceMaintenance: { ...manifest.localSourceMaintenance, extra: true } })).toBe(false)
    const extended = { ...manifest, localSourceMaintenance: { ...manifest.localSourceMaintenance,
      protocol: 'dsh-enhanced/pre-owner-source-maintenance/v2', extension: 'memory-learning', expectedCandidateSemanticDigest: hash } }
    expect(lifecycleProfileTest.validLocalSourceManifest(extended)).toBe(true)
    expect(lifecycleProfileTest.validLocalSourceManifest({ ...extended, localSourceMaintenance: { ...extended.localSourceMaintenance, extension: 'other' } })).toBe(false)
    expect(lifecycleProfileTest.validLocalSourceManifest({ ...extended, localSourceMaintenance: { ...extended.localSourceMaintenance, expectedCandidateSemanticDigest: 'bad' } })).toBe(false)
    expect(lifecycleProfileTest.validLocalSourceManifest({ ...manifest, localSourceMaintenance: { ...manifest.localSourceMaintenance, extension: 'memory-learning' } })).toBe(false)
    expect(lifecycleProfileTest.validLocalSourceManifest({ ...extended, version: 3 })).toBe(false)
    expect(await readFile(join(root, 'plugins/lark-channel/lib/entry.js'), 'utf8')).toContain('version = 1')
  })
})
