import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import * as yaml from 'yaml'
import { assertLocalSourceInstaller, assertLocalSourceRawPreflight, assertMemoryLearningCandidateConfigs, assertPreOwnerAuthorityState, assertPreOwnerEffectiveConfigs,
  bindLocalSourceInstaller, expectedMemoryLearningSemanticDigest, healLocalSourceProfileModuleFallback } from '../scripts/install/local-source-maintenance.mjs'
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-source-installer-')))
  roots.push(root)
  for (const directory of ['plugins/lark-channel/lib', 'packages/shared/lib', 'scripts/install', 'node_modules']) await mkdir(join(root, directory), { recursive: true })
  for (const path of ['package.json', 'pnpm-lock.yaml', 'plugins/lark-channel/package.json', 'packages/shared/package.json']) await writeFile(join(root, path), '{}', { mode: 0o600 })
  await writeFile(join(root, 'plugins/lark-channel/lib/entry.js'), 'export const version = 1\n', { mode: 0o600 })
  await writeFile(join(root, 'scripts/install/local-source-maintenance.mjs'), 'export {}\n', { mode: 0o600 })
  const require = createRequire(import.meta.url)
  await cp(dirname(require.resolve('yaml/package.json')), join(root, 'node_modules/yaml'), { recursive: true })
  return root
}
async function hostFixture(root: string, missingApi = false, version = '0.1.5-rc.3') {
  const host = join(root, 'host')
  const dshRoot = join(host, 'node_modules', '@deepseek-ai', 'dsh')
  const bootRoot = join(host, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  await mkdir(join(dshRoot, 'lib'), { recursive: true })
  await mkdir(join(bootRoot, 'lib'), { recursive: true })
  const path = join(dshRoot, 'lib', 'bin.js')
  await writeFile(path, 'export const cli = true\n', { mode: 0o700 })
  await writeFile(join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version,
    type: 'module', bin: { dsh: 'lib/bin.js' }, exports: { './package.json': './package.json' } }), { mode: 0o600 })
  await writeFile(join(bootRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version,
    type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } }), { mode: 0o600 })
  await writeFile(join(bootRoot, 'lib/index.js'), missingApi ? 'export const boot = () => { throw new Error("plugin effects ran") }\n'
    : ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.2-rc.1'].includes(version) ? `import { readFileSync } from 'node:fs'
import { join } from 'node:path'
export function loadProfileDirectory(name, dir, installAnchor) {
  if (name !== 'dsh' || !installAnchor.endsWith('/@deepseek-ai/dsh/package.json')) throw new Error('wrong Host')
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  return { dir, skippedBundles: manifest.skip ? [{ packageName: 'missing' }] : [] }
}
export async function createRuntimeResolution({ installAnchor, profile }) {
  if (!installAnchor.endsWith('/@deepseek-ai/dsh/package.json') || !profile.dir) throw new Error('wrong Host profile')
  return { entries: [{ name: '@deepseek-ai/cordis', scope: 'installation' }] }
}
` : `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const boot = () => { throw new Error('plugin effects ran') }
export function loadProfileDirectory(name, dir, installAnchor) {
  if (name !== 'dsh' || !installAnchor.endsWith('/@deepseek-ai/dsh/package.json')) throw new Error('wrong Host')
  return { dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
}
export async function healProfilesModuleFallback({ installAnchor, profile, home }) {
  if (!installAnchor.endsWith('/@deepseek-ai/dsh/package.json') || !profile.manifest.dsh) throw new Error('wrong Host profile')
  appendFileSync(join(home, 'heal.log'), profile.dir + '\\n')
  writeFileSync(join(home, 'fallback-healed'), 'native')
}
`, { mode: 0o600 })
  return { path, pin: { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') } }
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
    for (const name of ['rsi-local-update', 'rsi-source-maintenance', 'rsi-local-activation',
      'rsi-local-pair-install', 'rsi-local-install', 'rsi-local-roots-extension', 'rsi-local-cohort', 'rsi-authority-runtime', 'supervised-growth-profile']) {
      await writeFile(join(root, 'plugins/lark-channel/lib', `${name}.js`), name === 'rsi-local-pair-install'
        ? 'export async function stageRsiLocalSinglePackages(input) { return { extension: input.rootExtension ?? null } }\n'
        : 'export {}\n', { mode: 0o600 })
    }
    const installer = await bindLocalSourceInstaller(root)
    const homePath = join(await realpath(await mkdtemp(join(tmpdir(), 'local-source-stage-'))), 'home')
    roots.push(dirname(homePath))
    await mkdir(join(homePath, 'profiles', 'assistant'), { recursive: true })
    const manifest = '{"name":"dsh-profile-assistant","dsh":{"profile":{"bundles":[]}}}\n'
    await writeFile(join(homePath, 'profiles', 'assistant', 'package.json'), manifest)
    const dsh = await hostFixture(dirname(homePath))
    const inputPath = join(root, 'package-input.json')
    const run = async (extension?: string) => {
      await writeFile(inputPath, JSON.stringify({ homePath, profile: 'assistant', originalCohort: {}, dsh,
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
    expect(await readFile(join(homePath, 'fallback-healed'), 'utf8')).toBe('native')
    expect((await readFile(join(homePath, 'heal.log'), 'utf8')).trim().split('\n')).toHaveLength(2)
    expect(await readFile(join(homePath, 'profiles', 'assistant', 'package.json'), 'utf8')).toBe(manifest)
  })
  test('package healing fails closed for a missing native API or a changed pinned Host CLI', async () => {
    const root = await installerFixture()
    await writeFile(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 })
    await writeFile(join(root, 'plugins/lark-channel/package.json'), '{"type":"module"}', { mode: 0o600 })
    for (const name of ['rsi-local-update', 'rsi-source-maintenance', 'rsi-local-activation',
      'rsi-local-pair-install', 'rsi-local-install', 'rsi-local-roots-extension', 'rsi-local-cohort', 'rsi-authority-runtime', 'supervised-growth-profile']) {
      await writeFile(join(root, 'plugins/lark-channel/lib', `${name}.js`), name === 'rsi-local-pair-install'
        ? 'export async function stageRsiLocalSinglePackages() { return { staged: true } }\n' : 'export {}\n', { mode: 0o600 })
    }
    const installer = await bindLocalSourceInstaller(root)
    const stageRoot = await realpath(await mkdtemp(join(tmpdir(), 'local-source-heal-')))
    roots.push(stageRoot)
    const homePath = join(stageRoot, 'home')
    await mkdir(join(homePath, 'profiles', 'assistant'), { recursive: true })
    await writeFile(join(homePath, 'profiles', 'assistant', 'package.json'), '{"dsh":{"profile":{"bundles":[]}}}\n')
    const dsh = await hostFixture(stageRoot, true)
    const inputPath = join(root, 'package-input.json')
    const run = () => spawnSync(process.execPath, [join(process.cwd(), 'scripts/install/local-source-maintenance.mjs'), 'packages', inputPath], { encoding: 'utf8' })
    await writeFile(inputPath, JSON.stringify({ homePath, profile: 'assistant', originalCohort: {}, dsh, proof: { installer } }), { mode: 0o600 })
    const missing = run()
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('lacks native fallback healing APIs')
    expect(await readFile(join(homePath, 'profiles', 'assistant', 'package.json'), 'utf8')).toBe('{"dsh":{"profile":{"bundles":[]}}}\n')
    await writeFile(dsh.path, 'changed Host executable\n')
    const changed = run()
    expect(changed.status).not.toBe(0)
    expect(changed.stderr).toContain('pinned DSH executable changed')
  })
  test.each(['0.2.0-rc.2', '0.2.1-rc.2', '0.2.2-rc.1'])('DSH %s resolves a pinned Host profile without legacy fallback writes', async version => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'local-source-resolution-')))
    roots.push(root)
    const homePath = join(root, 'home')
    const manifestPath = join(homePath, 'profiles', 'assistant', 'package.json')
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, '{"dsh":{"profile":{"bundles":[]}}}\n')
    const dsh = await hostFixture(root, false, version)
    await expect(healLocalSourceProfileModuleFallback({ homePath, profile: 'assistant', dsh })).resolves.toBeUndefined()
    await expect(readFile(join(homePath, 'fallback-healed'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(manifestPath, 'utf8')).toBe('{"dsh":{"profile":{"bundles":[]}}}\n')
    await writeFile(manifestPath, '{"skip":true,"dsh":{"profile":{"bundles":[]}}}\n')
    await expect(healLocalSourceProfileModuleFallback({ homePath, profile: 'assistant', dsh }))
      .rejects.toThrow('cannot resolve the complete profile')
    await writeFile(dsh.path, 'changed Host executable\n')
    await expect(healLocalSourceProfileModuleFallback({ homePath, profile: 'assistant', dsh }))
      .rejects.toThrow('pinned DSH executable changed')
  })
  test('rejects an executable Host from the writable stopped Home before loading its boot module', async () => {
    const homePath = await realpath(await mkdtemp(join(tmpdir(), 'local-source-home-host-')))
    roots.push(homePath)
    const dsh = await hostFixture(homePath)
    await expect(healLocalSourceProfileModuleFallback({ homePath, profile: 'assistant', dsh }))
      .rejects.toThrow('executable is inside the stopped Home')
  })
  test('rechecks authority emptiness and signed sidecar host absence on stopped copies', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'local-source-authority-')))
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


// Native bytes below exercise integrity binding only; they are never executed.
const reviewedManagedPnpmLauncher = "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\ncase `uname` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=`cygpath -w \"$basedir\"`\n        fi\n    ;;\nesac\n\n\"$basedir/.tools/@pnpm+exe/11.7.0/node_modules/@pnpm/exe/pnpm\"   \"$@\"\nexit $?\n"
async function pnpmRuntimeFixture(kind: 'managed' | 'node' = 'managed') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pnpm-runtime-pin-')))
  roots.push(root)
  const packageRoot = kind === 'managed'
    ? join(root, '.tools', '@pnpm+exe', '11.7.0', 'node_modules', '@pnpm', 'exe')
    : join(root, 'node_modules', 'pnpm')
  const dist = join(packageRoot, 'dist'), path = join(root, 'pnpm')
  await mkdir(dist, { recursive: true, mode: 0o700 })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(kind === 'managed'
    ? { name: '@pnpm/exe', version: '11.7.0' }
    : { name: 'pnpm', version: '11.7.0', bin: { pnpm: 'bin/pnpm.cjs' } }), { mode: 0o600 })
  await writeFile(join(dist, kind === 'managed' ? 'pnpm.mjs' : 'pnpm.cjs'), 'const pnpm = 1\n', { mode: 0o600 })
  await writeFile(join(dist, 'worker.js'), 'const worker = 1\n', { mode: 0o600 })
  let target: string
  if (kind === 'managed') {
    target = join(packageRoot, 'pnpm')
    await writeFile(target, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('native fixture 1')]), { mode: 0o700 })
    await writeFile(path, reviewedManagedPnpmLauncher, { mode: 0o700 })
  } else {
    await mkdir(join(packageRoot, 'bin'), { mode: 0o700 })
    target = join(packageRoot, 'bin', 'pnpm.cjs')
    await writeFile(target, '#!/usr/bin/env node\nrequire("../dist/pnpm.cjs")\n', { mode: 0o700 })
    await symlink(target, path)
  }
  return { root, path, target, packageRoot, dist }
}

describe.skipIf(process.platform === 'win32')('local source pnpm application runtime pin', () => {
  test('binds the managed wrapper, native target and complete dist before revalidation', async () => {
    const f = await pnpmRuntimeFixture()
    const pin = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
    expect(pin.path).toBe(f.path)
    expect(pin.commandPath).toBe(f.target)
    expect(pin.selectionPath).toBe(f.path)
    expect(pin.runtime).toMatchObject({ kind: 'managed-wrapper', target: { path: f.target }, trees: [{ path: f.dist, entries: 2 }] })
    await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).resolves.toBeUndefined()
    const wrapper = await readFile(f.path)
    await writeFile(f.target, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('native fixture 2')]))
    expect(await readFile(f.path)).toEqual(wrapper)
    await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).rejects.toThrow('runtime closure changed')
  })

  test('dispatches the pinned native target without executing PATH shadowed wrapper utilities', async () => {
    const f = await pnpmRuntimeFixture()
    // A real native executable proves dispatch; this is Node, not a pnpm execution claim.
    const nodePath = await realpath(process.execPath)
    await cp(nodePath, f.target)
    await chmod(f.target, 0o700)
    const evil = join(f.root, 'evil'), marker = join(f.root, 'utility-executed')
    await mkdir(evil, { mode: 0o700 })
    for (const name of ['dirname', 'sed', 'uname']) {
      await writeFile(join(evil, name), `#!/bin/sh\necho executed >> '${marker}'\nexit 97\n`, { mode: 0o700 })
    }
    const pin = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
    await lifecycleProfileTest.assertLocalPnpmExecutable(pin)
    const env = { ...process.env, PATH: `${dirname(pin.commandPath)}:${evil}`,
      ...(process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: join(dirname(nodePath), '..', 'lib') } : {}) }
    for (const command of [pin.commandPath, 'pnpm']) {
      const result = spawnSync(command, ['--version'], { env, encoding: 'utf8' })
      expect({ status: result.status, error: result.error?.message, signal: result.signal, stderr: result.stderr }).toEqual({ status: 0, error: undefined, signal: null, stderr: '' })
      expect(result.stdout.trim()).toBe(process.version)
    }
    expect(existsSync(marker)).toBe(false)
    await lifecycleProfileTest.assertLocalPnpmExecutable(pin)
  })

  test.each(['changed', 'added', 'deleted', 'relative-symlink'] as const)('rejects %s dist content with an unchanged launcher', async mutation => {
    const f = await pnpmRuntimeFixture()
    const pin = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
    if (mutation === 'changed') await writeFile(join(f.dist, 'worker.js'), 'const worker = 2\n')
    if (mutation === 'added') await writeFile(join(f.dist, 'later.js'), 'const added = true\n')
    if (mutation === 'deleted') await rm(join(f.dist, 'worker.js'))
    if (mutation === 'relative-symlink') {
      await rm(join(f.dist, 'worker.js'))
      await symlink('pnpm.mjs', join(f.dist, 'worker.js'))
    }
    expect(await readFile(f.path, 'utf8')).toBe(reviewedManagedPnpmLauncher)
    await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).rejects.toThrow(/runtime closure changed|symlink/u)
  })

  test('rejects retargeting a relative managed-target symlink and unsafe target permissions', async () => {
    const f = await pnpmRuntimeFixture(), other = await pnpmRuntimeFixture()
    const pin = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
    await chmod(f.target, 0o777)
    await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).rejects.toThrow('runtime file is unsafe')
    await rm(f.target)
    await symlink(relative(dirname(f.target), other.target), f.target)
    await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).rejects.toThrow('runtime closure changed')
  })

  test('binds a standard pnpm JS package, actual Node selection and logical PATH command', async () => {
    const f = await pnpmRuntimeFixture('node')
    const pin = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
    expect(pin.path).toBe(f.target)
    expect(pin.commandPath).toBe(f.path)
    expect(pin.runtime).toMatchObject({ kind: 'node-package', interpreter: { executable: { path: expect.any(String), digest: expect.any(String) } } })
    await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).resolves.toBeUndefined()
    await writeFile(join(f.dist, 'pnpm.cjs'), 'const pnpm = 2\n')
    await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).rejects.toThrow('runtime closure changed')
  })

  test('rejects Node drift and command-directory Node shadowing instead of choosing a different runtime', async () => {
    const f = await pnpmRuntimeFixture('node')
    const caller = join(f.root, 'caller')
    await mkdir(caller)
    const node = join(caller, 'node')
    await writeFile(node, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('node fixture 1')]), { mode: 0o700 })
    const previous = process.env.PATH
    process.env.PATH = `${caller}:${previous ?? '/usr/bin:/bin'}`
    try {
      const pin = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
      await writeFile(node, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('node fixture 2')]))
      await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).rejects.toThrow('runtime closure changed')
      await symlink(node, join(f.root, 'node'))
      // A matching logical alias still selects the exact pinned executable.
      const matching = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
      await expect(lifecycleProfileTest.assertLocalPnpmExecutable(matching)).resolves.toBeUndefined()
      await rm(join(f.root, 'node'))
      await symlink(process.execPath, join(f.root, 'node'))
      await expect(lifecycleProfileTest.pinLocalPnpmExecutable(f.path)).rejects.toThrow('Node selection differs')
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
  })

  test('rejects logical pnpm command retargeting even when both package loaders have the same bytes', async () => {
    const f = await pnpmRuntimeFixture('node'), other = await pnpmRuntimeFixture('node')
    const pin = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
    expect(await readFile(f.target)).toEqual(await readFile(other.target))
    await rm(f.path)
    await symlink(relative(dirname(f.path), other.target), f.path)
    await expect(lifecycleProfileTest.assertLocalPnpmExecutable(pin)).rejects.toThrow('runtime closure changed')
  })

  test('keeps packageManager requirements strict while disabling runtime re-delegation', async () => {
    const f = await pnpmRuntimeFixture()
    const pin = await lifecycleProfileTest.pinLocalPnpmExecutable(f.path)
    const check = (packageManager?: unknown) => lifecycleProfileTest.assertLocalPnpmPackageManager(JSON.stringify({ packageManager }), pin)
    expect(() => check()).not.toThrow()
    expect(() => check('pnpm@11.7.0')).not.toThrow()
    expect(() => check(`pnpm@11.7.0+sha512.${'a'.repeat(64)}`)).not.toThrow()
    for (const value of ['pnpm@11.8.0', 'npm@11.7.0', 'pnpm@^11', false]) expect(() => check(value)).toThrow('before service stop')
    expect(lifecycleProfileTest.localSourceOriginalNpmEnvironment()).toMatchObject({
      pnpm_config_pm_on_fail: 'error', pnpm_config_manage_package_manager_versions: 'false', pnpm_config_package_manager_strict: 'true', pnpm_config_package_manager_strict_version: 'true',
    })
  })

  test('rejects an unknown forwarding wrapper without executing it', async () => {
    const f = await pnpmRuntimeFixture(), marker = join(f.root, 'was-executed')
    await writeFile(f.path, `#!/bin/sh\ntouch '${marker}'\nexec /bin/true "$@"\n`)
    await expect(lifecycleProfileTest.pinLocalPnpmExecutable(f.path)).rejects.toThrow('unsupported local source pnpm launcher')
    expect(existsSync(marker)).toBe(false)
  })
})
