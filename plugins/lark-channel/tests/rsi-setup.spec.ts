import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { rsiServiceEnvironmentPath } from '../src/rsi-service-environment.js'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { ActiveLarkOwnerBindingsSnapshot } from '@dsh-enhanced/assistant-delivery'
import { assertRsiEffectivePatch, configureRsiSetup, parseRsiSetupArgs, readRsiInstalledBase, rsiSetupPorts, runRsiSetup, type RsiSetupPorts } from '../src/rsi-setup.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  // macOS 上 os.tmpdir() 经 /var → /private/var 符号链接，须先规范化到 canonical 路径，
  // 否则 safeDirectory 的 realpath 检查会拒绝测试夹具本身（生产 DSH home 无此问题）。
  const home = await mkdtemp(join(await realpath(tmpdir()), 'dsh-rsi-setup-')); roots.push(home)
  const pair = ['target', 'coordinator']
  for (const name of pair) {
    await mkdir(join(home, 'profiles', name), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'profiles', name, 'cordis.patch.yml'), `- id: ${name}\n  config: { status: original }\n`, { mode: 0o600 })
  }
  const manifestPath = join(home, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, targetProfile: pair[0], coordinatorProfile: pair[1] }), { mode: 0o600 })
  // These ports isolate the OS/DSH and compiler contracts; journal and flock are real.
  const snapshot = { bindings: [{ owner: { id: 'owner', version: 1 } }], snapshotDigest: 'unchanged' } as unknown as ActiveLarkOwnerBindingsSnapshot
  const ports: RsiSetupPorts = {
    dump: vi.fn(profile => readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')),
    base: vi.fn(async () => '[]\n'),
    snapshot: vi.fn(async () => snapshot),
    automationInventory: vi.fn(async () => ({ databasePath: join(home, 'automations.sqlite'), schedulerEnabled: true, records: [] })),
    compile: vi.fn(async () => ({ targetPatch: '- id: target\n  config: { status: configured }\n', coordinatorPatch: '- id: coordinator\n  config: { status: configured }\n' })),
    resolveEnvironments: vi.fn(async () => undefined), serviceUnitPath: (profile, home) => join(home, 'units', `${profile}.service`),
    renderServiceUnit: vi.fn(async (profile, _home, environment) => JSON.stringify({ profile, environment })), reloadServices: vi.fn(), validateServiceUnits: vi.fn(async () => {}),
    validateAuthorities: vi.fn(async () => {}), assertStopped: vi.fn(), start: vi.fn(async () => {}),
  }
  const args = (flags: string[] = []) => parseRsiSetupArgs(['--manifest', manifestPath, '--dsh-home', home, ...flags])
  const apply = ['--apply', '--confirm-hosts-stopped']
  const rollback = ['--rollback', '--confirm-hosts-stopped']
  const patch = (profile = pair[0]!) => join(home, 'profiles', profile, 'cordis.patch.yml')
  const journal = join(home, '.rsi-setup-journal.json')
  return { home, pair, manifestPath, ports, args, apply, rollback, patch, journal }
}

async function installedBaseFixture() {
  const setup = await fixture()
  const host = await mkdtemp(join(await realpath(tmpdir()), 'dsh-rsi-host-')); roots.push(host)
  const bin = join(host, 'bin'), dsh = join(host, 'node_modules', '@deepseek-ai', 'dsh')
  const base = join(host, 'node_modules', '@deepseek-ai', 'dsh-base')
  await mkdir(bin, { recursive: true })
  await mkdir(join(dsh, 'lib'), { recursive: true })
  await mkdir(base, { recursive: true })
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.3', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(dsh, 'lib', 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  await symlink(join(dsh, 'lib', 'bin.js'), join(bin, 'dsh'))
  const baseManifest = { name: '@deepseek-ai/dsh-base', version: '0.1.5-rc.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  await writeFile(join(base, 'package.json'), JSON.stringify(baseManifest))
  const basePatch = '- id: installed-base\n  config: {}\n'
  await writeFile(join(base, 'cordis.patch.yml'), basePatch)
  const environment = { PATH: bin }
  return { ...setup, host, bin, dsh, base, baseManifest, basePatch, environment }
}

describe('RSI dual profile setup transaction', () => {
  test('reads the selected DSH Host base when the coordinator has no local base dependency', async () => {
    const f = await installedBaseFixture()
    await expect(stat(join(f.home, 'profiles', 'coordinator', 'node_modules', '@deepseek-ai', 'dsh-base')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readRsiInstalledBase('coordinator', f.home, f.environment)).toBe(f.basePatch)
    const local = join(f.home, 'profiles', 'coordinator', 'node_modules', '@deepseek-ai', 'dsh-base')
    await mkdir(local, { recursive: true })
    await writeFile(join(local, 'cordis.patch.yml'), '- id: untrusted-local\n')
    expect(await readRsiInstalledBase('coordinator', f.home, f.environment)).toBe(f.basePatch)
  })
  test.each([
    ['name', { name: '@deepseek-ai/other' }],
    ['version', { version: '0.1.7' }],
    ['patch declaration', { dsh: { bundle: { patch: './other.yml' } } }],
  ])('rejects installed base %s drift', async (_label, change) => {
    const f = await installedBaseFixture()
    await writeFile(join(f.base, 'package.json'), JSON.stringify({ ...f.baseManifest, ...change }))
    await expect(readRsiInstalledBase('coordinator', f.home, f.environment)).rejects.toThrow('base identity or patch declaration')
  })
  test('rejects an untrusted DSH executable and absent Host base', async () => {
    const f = await installedBaseFixture()
    await writeFile(join(f.dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/other', version: '0.1.5-rc.3', bin: { dsh: 'lib/bin.js' } }))
    await expect(readRsiInstalledBase('coordinator', f.home, f.environment)).rejects.toThrow('no installed @deepseek-ai/dsh package')
    await writeFile(join(f.dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.3', bin: { dsh: 'lib/bin.js' } }))
    await rm(f.base, { recursive: true })
    await expect(readRsiInstalledBase('coordinator', f.home, f.environment)).rejects.toThrow('base is absent from Host installation')
  })
  test('rejects a Host base link outside the selected installation', async () => {
    const f = await installedBaseFixture()
    const external = join(f.home, 'external-base')
    await rm(f.base, { recursive: true })
    await mkdir(external)
    await writeFile(join(external, 'package.json'), JSON.stringify(f.baseManifest))
    await writeFile(join(external, 'cordis.patch.yml'), f.basePatch)
    await symlink(external, f.base)
    await expect(readRsiInstalledBase('coordinator', f.home, f.environment)).rejects.toThrow('base escapes Host installation')
  })
  test('rejects installed base byte drift before writing either profile', async () => {
    const f = await installedBaseFixture()
    f.ports.base = () => readRsiInstalledBase('coordinator', f.home, f.environment)
    const compile = f.ports.compile
    f.ports.compile = vi.fn(async input => {
      await writeFile(join(f.base, 'cordis.patch.yml'), '- id: drifted-base\n  config: {}\n')
      return compile(input)
    })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('manifest or owner snapshot changed before write')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.patch(), 'utf8')).toContain('original')
  })
  test('final composition compares values and executable YAML tags, ignoring formatting', () => {
    const patch = '- id: managed\n  config: { count: 1, path: !!js dshHomePath("state") }\n'
    expect(() => assertRsiEffectivePatch(patch, '- id: managed\n  config:\n    path: !!js dshHomePath("state")\n    count: 1\n')).not.toThrow()
    expect(() => assertRsiEffectivePatch(patch, patch.replace('count: 1', 'count: 2'))).toThrow('overrides compiled config')
    expect(() => assertRsiEffectivePatch(patch, patch.replace('!!js ', ''))).toThrow('overrides compiled config')
    expect(() => assertRsiEffectivePatch(patch, '[]')).toThrow('overrides compiled config')
  })
  test('final composition resolves aliases without trusting anchor names', () => {
    const aliased = '- id: managed\n  config:\n    scope: &scope { principalId: owner, path: !!js dshHomePath("state") }\n    reused: *scope\n'
    const expanded = '- id: managed\n  config:\n    scope: { principalId: owner, path: !!js dshHomePath("state") }\n    reused: { principalId: owner, path: !!js dshHomePath("state") }\n'
    const renamed = aliased.replace('&scope', '&other').replace('*scope', '*other')
    expect(() => assertRsiEffectivePatch(aliased, expanded)).not.toThrow()
    expect(() => assertRsiEffectivePatch(expanded, aliased)).not.toThrow()
    expect(() => assertRsiEffectivePatch(aliased, renamed)).not.toThrow()
    expect(() => assertRsiEffectivePatch(aliased, expanded.replace('principalId: owner', 'principalId: other'))).toThrow('overrides compiled config')
    expect(() => assertRsiEffectivePatch(aliased, expanded.replace('!!js ', ''))).toThrow('overrides compiled config')
    expect(() => assertRsiEffectivePatch(aliased, '- id: managed\n  config: &loop { self: *loop }\n')).toThrow('cyclic or unresolved YAML alias')
    expect(() => assertRsiEffectivePatch(aliased, '- id: managed\n  config: *missing\n')).toThrow('cyclic or unresolved YAML alias')
  })
  test('recompiled profile patches compare aliases with expanded values', async () => {
    const f = await fixture()
    const aliased = (profile: string) => `- id: ${profile}\n  config:\n    scope: &scope { principalId: owner }\n    reused: *scope\n`
    const expanded = (profile: string) => `- id: ${profile}\n  config:\n    scope: { principalId: owner }\n    reused: { principalId: owner }\n`
    f.ports.compile = vi.fn(async input => input.targetPatch.includes('reused:')
      ? { targetPatch: expanded('target'), coordinatorPatch: expanded('coordinator') }
      : { targetPatch: aliased('target'), coordinatorPatch: aliased('coordinator') })
    expect((await configureRsiSetup(f.args(f.apply), f.ports)).mode).toBe('configured')
  })
  test('default validates without writing or starting services', async () => {
    const f = await fixture()
    expect(await configureRsiSetup(f.args(), f.ports)).toEqual({ mode: 'checked', profiles: f.pair })
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.ports.validateAuthorities).toHaveBeenCalledOnce()
    expect(f.ports.start).not.toHaveBeenCalled()
  })
  test('manual apply gates scheduler activation and acknowledgement still fences inventory drift', async () => {
    const f = await fixture()
    const active = [{id:'heartbeat:legacy',status:'active',version:1}] as unknown as Awaited<ReturnType<typeof f.ports.automationInventory>>['records']
    f.ports.automationInventory = vi.fn(async effective => ({databasePath:join(f.home,'automations.sqlite'),
      schedulerEnabled:effective.includes('schedulerEnabled: true'),records:active}))
    await expect(configureRsiSetup(f.args(f.apply),f.ports)).rejects.toThrow('--ack-existing-automations')
    await expect(stat(f.journal)).rejects.toMatchObject({code:'ENOENT'})
    f.ports.validateAuthorities = vi.fn(async () => { active[0] = {...active[0]!,version:2} })
    await expect(configureRsiSetup(f.args([...f.apply,'--ack-existing-automations']),f.ports)).rejects.toThrow('Automation inventory changed before write')
    expect(await readFile(f.patch(),'utf8')).toContain('status: original')
    f.ports.validateAuthorities = vi.fn(async () => {})
    expect((await configureRsiSetup(f.args([...f.apply,'--ack-existing-automations']),f.ports)).mode).toBe('configured')
    expect(active[0]).toMatchObject({id:'heartbeat:legacy',version:2})
  })
  test('applies both profiles, retains private journal across idempotent apply, and rolls back', async () => {
    const f = await fixture()
    await configureRsiSetup(f.args(f.apply), f.ports)
    const journal = await readFile(f.journal, 'utf8')
    expect((await stat(f.journal)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(journal).stage).toBe('applied')
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: configured }\n')
    await configureRsiSetup(f.args(f.apply), f.ports)
    expect(await readFile(f.journal, 'utf8')).toBe(journal)
    // Restoration remains possible when forward authorities expire.
    f.ports.validateAuthorities = vi.fn(async () => { throw new Error('expired') })
    expect((await configureRsiSetup(f.args(f.rollback), f.ports)).mode).toBe('rolled-back')
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: original }\n')
  })
  test('failed final DSH composition restores both originals', async () => {
    const f = await fixture()
    let count = 0
    f.ports.dump = vi.fn(() => { if (++count > 2) throw new Error('compose failed'); return 'initial' })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('compose failed')
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: original }\n')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('later failed apply preserves the previous rollback point', async () => {
    const f = await fixture()
    await configureRsiSetup(f.args(f.apply), f.ports)
    const previous = await readFile(f.journal, 'utf8')
    f.ports.compile = vi.fn(async () => ({ targetPatch: '- id: target\n  config: { status: next }\n', coordinatorPatch: '- id: coordinator\n  config: { status: next }\n' }))
    let count = 0
    f.ports.dump = vi.fn(profile => {
      if (++count > 2) throw new Error('compose failed')
      return readFileSync(f.patch(profile), 'utf8')
    })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('compose failed')
    expect(await readFile(f.journal, 'utf8')).toBe(previous)
    await configureRsiSetup(f.args(f.rollback), f.ports)
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
  })
  test('final higher-layer override fails and restores both profiles', async () => {
    const f = await fixture()
    let count = 0
    f.ports.dump = vi.fn(profile => {
      const actual = readFileSync(f.patch(profile), 'utf8')
      return ++count > 2 ? actual.replace('configured', 'overridden') : actual
    })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('overrides compiled config')
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
  })
  test('interrupted transaction blocks new apply; rollback accepts half-restored pair', async () => {
    const f = await fixture()
    await configureRsiSetup(f.args(f.apply), f.ports)
    const journal = JSON.parse(await readFile(f.journal, 'utf8')); journal.stage = 'prepared'
    await writeFile(f.journal, JSON.stringify(journal))
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('interrupted setup')
    await writeFile(f.patch(), '- id: target\n  config: { status: original }\n')
    await configureRsiSetup(f.args(f.rollback), f.ports)
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: original }\n')
  })
  test('rollback checks both profiles before restoring either', async () => {
    const f = await fixture()
    await configureRsiSetup(f.args(f.apply), f.ports)
    await writeFile(f.patch('coordinator'), 'external edit\n')
    await expect(configureRsiSetup(f.args(f.rollback), f.ports)).rejects.toThrow('changed outside setup')
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: configured }\n')
    expect((await stat(f.journal)).isFile()).toBe(true)
  })
  test('active service prevents any profile write', async () => {
    const f = await fixture()
    f.ports.assertStopped = vi.fn(() => { throw new Error('active') })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('active')
    expect(f.ports.compile).not.toHaveBeenCalled()
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: original }\n')
  })
  test.each(['owner', 'manifest', 'patch'])('rejects changed %s before write', async change => {
    const f = await fixture()
    const original = f.ports.compile
    f.ports.compile = vi.fn(async input => {
      if (change === 'owner') f.ports.snapshot = vi.fn(async () => ({ bindings: [] }) as unknown as ActiveLarkOwnerBindingsSnapshot)
      if (change === 'manifest') await writeFile(f.manifestPath, '{}')
      if (change === 'patch') await writeFile(f.patch(), 'external edit\n')
      return original(input)
    })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('changed before write')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.patch('coordinator'), 'utf8')).toBe('- id: coordinator\n  config: { status: original }\n')
  })
  test('starts coordinator before target; failed target start retains applied configuration', async () => {
    const f = await fixture()
    const started: string[] = []
    f.ports.start = vi.fn(async profile => { started.push(profile); if (profile === 'target') throw new Error('target start failed') })
    await expect(configureRsiSetup(f.args([...f.apply, '--start']), f.ports)).rejects.toThrow('target start failed')
    expect(started).toEqual(['coordinator', 'target'])
    expect(await readFile(f.patch(), 'utf8')).toBe('- id: target\n  config: { status: configured }\n')
    expect(JSON.parse(await readFile(f.journal, 'utf8')).stage).toBe('applied')
  })
  test('rejects symlink and publicly readable private manifest', async () => {
    const f = await fixture()
    await chmod(f.manifestPath, 0o644)
    await expect(configureRsiSetup(f.args(), f.ports)).rejects.toThrow('unsafe file')
    await chmod(f.manifestPath, 0o600)
    const link = join(f.home, 'linked.json'); await symlink(f.manifestPath, link)
    await expect(configureRsiSetup({ ...f.args(), manifestPath: link }, f.ports)).rejects.toThrow('noncanonical file')
  })
  async function withServiceEnvironment() {
    const f = await fixture()
    const config = join(f.home, 'authority config.json'); await writeFile(config, '{}', { mode: 0o600 })
    const environments = { target: { DSH_RELEASE_PR_CONFIG: config, DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: config },
      coordinator: { DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: config } }
    f.ports.resolveEnvironments = vi.fn(async () => environments)
    return { ...f, environments, binding: (profile = 'target') => rsiServiceEnvironmentPath(f.home, profile),
      unit: (profile = 'target') => f.ports.serviceUnitPath(profile, f.home) }
  }
  async function withAliasedServiceHome(createUnitParent = true) {
    const setup = await withServiceEnvironment()
    const unitParent = join(setup.home, '.config', 'systemd', 'user')
    if (createUnitParent) await mkdir(unitParent, { recursive: true, mode: 0o700 })
    const alias = join(setup.home, 'alias-home')
    await symlink(setup.home, alias)
    vi.stubEnv('HOME', alias)
    setup.ports.serviceUnitPath = rsiSetupPorts.serviceUnitPath
    return { ...setup, unitParent }
  }
  test('creates a missing unit parent through a HOME alias', async () => {
    const setup = await withAliasedServiceHome(false)
    const unitPath = join(setup.unitParent, 'dsh-profile-target.service')
    expect(setup.unit()).toBe(unitPath)
    await expect(lstat(setup.unitParent)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await configureRsiSetup(setup.args(setup.apply), setup.ports)
    expect((await lstat(setup.unitParent)).isDirectory()).toBe(true)
    expect(JSON.parse(await readFile(unitPath, 'utf8')).environment).toEqual(setup.environments.target)
    await configureRsiSetup(setup.args(setup.rollback), setup.ports)
    await expect(lstat(unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('restores original unit bytes through a HOME alias after failed service validation', async () => {
    const setup = await withAliasedServiceHome()
    for (const profile of setup.pair) await writeFile(setup.unit(profile), `original ${profile} unit`, { mode: 0o600 })
    setup.ports.validateServiceUnits = vi.fn(async () => { throw new Error('grant environment mismatch') })
    await expect(configureRsiSetup(setup.args(setup.apply), setup.ports)).rejects.toThrow('grant environment mismatch')
    for (const profile of setup.pair) expect(await readFile(setup.unit(profile), 'utf8')).toBe(`original ${profile} unit`)
    expect(await readFile(setup.patch(), 'utf8')).toContain('original')
    await expect(lstat(setup.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('rejects a final unit symlink through a HOME alias before changing profiles', async () => {
    const setup = await withAliasedServiceHome()
    const outside = join(setup.home, 'outside-unit')
    await writeFile(outside, 'external unit', { mode: 0o600 })
    await symlink(outside, setup.unit())
    await expect(configureRsiSetup(setup.args(setup.apply), setup.ports)).rejects.toThrow('noncanonical file')
    expect(await readFile(outside, 'utf8')).toBe('external unit')
    expect((await lstat(setup.unit())).isSymbolicLink()).toBe(true)
    expect(await readFile(setup.patch(), 'utf8')).toContain('original')
    await expect(lstat(setup.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test.each(['.config', 'systemd', 'user'])('rejects a %s service directory symlink through a HOME alias', async segment => {
    const setup = await withAliasedServiceHome(false)
    const directories = ['.config', 'systemd', 'user']
    const index = directories.indexOf(segment)
    const linked = join(setup.home, ...directories.slice(0, index + 1))
    const outside = join(setup.home, 'outside-service-tree')
    const remaining = directories.slice(index + 1)
    await mkdir(join(outside, ...remaining), { recursive: true, mode: 0o700 })
    await writeFile(join(outside, ...remaining, 'dsh-profile-target.service'), 'external unit', { mode: 0o600 })
    await mkdir(join(setup.home, ...directories.slice(0, index)), { recursive: true, mode: 0o700 })
    await symlink(outside, linked)
    await expect(configureRsiSetup(setup.args(setup.apply), setup.ports)).rejects.toThrow('noncanonical file')
    expect(await readFile(join(outside, ...remaining, 'dsh-profile-target.service'), 'utf8')).toBe('external unit')
    expect((await lstat(linked)).isSymbolicLink()).toBe(true)
    expect(await readFile(setup.patch(), 'utf8')).toContain('original')
    await expect(lstat(setup.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('accepts a native Include YAML roundtrip with reordered maps, quotes and comments', async () => {
    const setup = await fixture()
    const require = createRequire(import.meta.url)
    const includeRequire = createRequire(require.resolve('@deepseek-ai/cordis-plugin-include/package.json'))
    const nativeYaml = includeRequire('js-yaml') as { load(source: string, options: { schema: unknown }): unknown;
      dump(value: unknown, options: { schema: unknown; noRefs: boolean }): string }
    const targetPatch = '- id: target\n  name: "@owner/target"\n  config:\n    status: configured\n    expression: !!js dshHomePath("state")\n    steps: [first, second]\n'
    const coordinatorPatch = '- id: coordinator\n  config: { status: configured, count: 2 }\n'
    const roundtrip = (source: string): string => {
      const rows = nativeYaml.load(source, { schema: entryListSchema }) as Array<{ config: Record<string, unknown> }>
      rows[0]!.config = Object.fromEntries(Object.entries(rows[0]!.config).reverse())
      return `# native Include dump\n${nativeYaml.dump(applyEntryPatches([], [{ insert: rows as unknown as Parameters<typeof applyEntryPatches>[0] }], () => {}),
        { schema: entryListSchema, noRefs: true })}`
    }
    const recompiled = { targetPatch: roundtrip(targetPatch), coordinatorPatch: roundtrip(coordinatorPatch) }
    expect(recompiled.targetPatch).not.toBe(targetPatch)
    setup.ports.compile = vi.fn().mockResolvedValueOnce({ targetPatch, coordinatorPatch }).mockResolvedValueOnce(recompiled)
    await expect(configureRsiSetup(setup.args(setup.apply), setup.ports)).resolves.toMatchObject({ mode: 'configured' })
    expect(await readFile(setup.patch(), 'utf8')).toBe(targetPatch)
    expect(await readFile(setup.patch('coordinator'), 'utf8')).toBe(coordinatorPatch)
  })
  test.each([
    ['expression tag', '- id: target\n  name: "@owner/target"\n  config: { status: configured, expression: dshHomePath("state"), steps: [first, second] }\n'],
    ['config value', '- id: target\n  name: "@owner/target"\n  config: { status: changed, expression: !!js dshHomePath("state"), steps: [first, second] }\n'],
    ['disabled flag', '- id: target\n  name: "@owner/target"\n  disabled: true\n  config: { status: configured, expression: !!js dshHomePath("state"), steps: [first, second] }\n'],
    ['plugin name', '- id: target\n  name: "@owner/other"\n  config: { status: configured, expression: !!js dshHomePath("state"), steps: [first, second] }\n'],
    ['extra row', '- id: target\n  name: "@owner/target"\n  config: { status: configured, expression: !!js dshHomePath("state"), steps: [first, second] }\n- id: extra\n  name: "@owner/extra"\n'],
    ['sequence order', '- id: target\n  name: "@owner/target"\n  config: { status: configured, expression: !!js dshHomePath("state"), steps: [second, first] }\n'],
  ])('rejects recompiled patch %s drift and restores the original profile', async (_case, changedTarget) => {
    const setup = await fixture()
    const targetPatch = '- id: target\n  name: "@owner/target"\n  config: { status: configured, expression: !!js dshHomePath("state"), steps: [first, second] }\n'
    const coordinatorPatch = '- id: coordinator\n  config: { status: configured }\n'
    setup.ports.compile = vi.fn().mockResolvedValueOnce({ targetPatch, coordinatorPatch })
      .mockResolvedValueOnce({ targetPatch: changedTarget, coordinatorPatch })
    await expect(configureRsiSetup(setup.args(setup.apply), setup.ports))
      .rejects.toThrow('effective profile differs from the compiled deployment')
    expect(await readFile(setup.patch(), 'utf8')).toContain('status: original')
    expect(await readFile(setup.patch('coordinator'), 'utf8')).toContain('status: original')
    await expect(lstat(setup.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('rejects recompiled coordinator row order drift', async () => {
    const setup = await fixture()
    const targetPatch = '- id: target\n  config: { status: configured }\n'
    const coordinatorPatch = '- id: coordinator\n  config: { status: configured }\n- id: extra\n  name: "@owner/extra"\n'
    const changedCoordinator = '- id: extra\n  name: "@owner/extra"\n- id: coordinator\n  config: { status: configured }\n'
    setup.ports.compile = vi.fn().mockResolvedValueOnce({ targetPatch, coordinatorPatch })
      .mockResolvedValueOnce({ targetPatch, coordinatorPatch: changedCoordinator })
    await expect(configureRsiSetup(setup.args(setup.apply), setup.ports))
      .rejects.toThrow('effective profile differs from the compiled deployment')
    expect(await readFile(setup.patch('coordinator'), 'utf8')).toContain('status: original')
    await expect(lstat(setup.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('rejects invalid recompiled YAML and restores both profiles', async () => {
    const setup = await fixture()
    const targetPatch = '- id: target\n  config: { status: configured }\n'
    const coordinatorPatch = '- id: coordinator\n  config: { status: configured }\n'
    setup.ports.compile = vi.fn().mockResolvedValueOnce({ targetPatch, coordinatorPatch })
      .mockResolvedValueOnce({ targetPatch: '- id: [\n', coordinatorPatch })
    await expect(configureRsiSetup(setup.args(setup.apply), setup.ports)).rejects.toThrow('invalid recompiled target patch')
    expect(await readFile(setup.patch(), 'utf8')).toContain('status: original')
    expect(await readFile(setup.patch('coordinator'), 'utf8')).toContain('status: original')
    await expect(lstat(setup.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('journals both service bindings and units, preserves replay, and restores absent originals', async () => {
    const f = await withServiceEnvironment()
    await configureRsiSetup(f.args(), f.ports)
    await expect(stat(f.binding())).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(f.unit())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.ports.reloadServices).not.toHaveBeenCalled()
    await configureRsiSetup(f.args(f.apply), f.ports)
    expect(JSON.parse(await readFile(f.binding(), 'utf8')).environment).toEqual(f.environments.target)
    expect(JSON.parse(await readFile(f.binding('coordinator'), 'utf8')).environment).toEqual(f.environments.coordinator)
    expect((await stat(f.binding())).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(f.unit(), 'utf8')).environment).toEqual(f.environments.target)
    const saved = await readFile(f.journal, 'utf8'); expect(JSON.parse(saved).schemaVersion).toBe(2)
    await configureRsiSetup(f.args(f.apply), f.ports)
    expect(await readFile(f.journal, 'utf8')).toBe(saved)
    await configureRsiSetup(f.args(f.rollback), f.ports)
    for (const profile of f.pair) {
      await expect(stat(f.binding(profile))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(f.unit(profile))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(f.ports.reloadServices).toHaveBeenCalledTimes(3)
  })
  test('failed Host grant environment readback restores all files before any service starts', async () => {
    const f = await withServiceEnvironment()
    await mkdir(join(f.home, 'units'), { mode: 0o700 })
    await writeFile(f.unit(), 'original unit', { mode: 0o600 })
    f.ports.validateServiceUnits = vi.fn(async () => { throw new Error('grant environment mismatch') })
    await expect(configureRsiSetup(f.args([...f.apply, '--start']), f.ports)).rejects.toThrow('grant environment mismatch')
    expect(await readFile(f.unit(), 'utf8')).toBe('original unit')
    expect(await readFile(f.patch(), 'utf8')).toContain('original')
    await expect(stat(f.binding())).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.ports.start).not.toHaveBeenCalled()
  })
  test.each(['unit', 'binding'])('refuses %s drift without partial rollback', async resource => {
    const f = await withServiceEnvironment()
    await configureRsiSetup(f.args(f.apply), f.ports)
    await writeFile(resource === 'unit' ? f.unit() : f.binding(), 'external edit', { mode: 0o600 })
    await expect(configureRsiSetup(f.args(f.rollback), f.ports)).rejects.toThrow('service resource changed outside setup')
    expect(await readFile(f.patch(), 'utf8')).toContain('configured')
    expect((await stat(f.journal)).isFile()).toBe(true)
  })
  test('failed target start retains all new resources and rollback restores prior bindings and units', async () => {
    const f = await withServiceEnvironment()
    await mkdir(join(f.home, 'rsi-service-environments'), { mode: 0o700 })
    await mkdir(join(f.home, 'units'), { mode: 0o700 })
    for (const profile of f.pair) {
      await writeFile(f.binding(profile), 'previous binding', { mode: 0o600 })
      await writeFile(f.unit(profile), 'previous unit', { mode: 0o600 })
    }
    f.ports.start = vi.fn(async profile => { if (profile === 'target') throw new Error('start failed') })
    await expect(configureRsiSetup(f.args([...f.apply, '--start']), f.ports)).rejects.toThrow('start failed')
    expect(JSON.parse(await readFile(f.journal, 'utf8')).stage).toBe('applied')
    expect(await readFile(f.unit(), 'utf8')).toContain('DSH_RELEASE_PR_CONFIG')
    // A crash during rollback can leave one resource already restored.
    await writeFile(f.binding(), 'previous binding', { mode: 0o600 })
    await configureRsiSetup(f.args(f.rollback), f.ports)
    for (const profile of f.pair) {
      expect(await readFile(f.binding(profile), 'utf8')).toBe('previous binding')
      expect(await readFile(f.unit(profile), 'utf8')).toBe('previous unit')
    }
  })
  test('rejects service file changes during preflight before changing either profile', async () => {
    const f = await withServiceEnvironment()
    f.ports.validateAuthorities = vi.fn(async () => {
      await mkdir(join(f.home, 'units'), { mode: 0o700 }); await writeFile(f.unit(), 'external writer', { mode: 0o600 })
    })
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('service resource changed before write')
    expect(await readFile(f.patch(), 'utf8')).toContain('original')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('refuses a dangling service unit link without replacing it or changing profiles', async () => {
    const f = await withServiceEnvironment()
    await mkdir(join(f.home, 'units'), { mode: 0o700 })
    await symlink(join(f.home, 'missing-unit'), f.unit())
    await expect(configureRsiSetup(f.args(f.apply), f.ports)).rejects.toThrow('unsafe file')
    expect(await readFile(f.patch(), 'utf8')).toContain('original')
    await expect(stat(f.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('automatic owner installation selects its own operation without manual manifest or stop confirmation', () => {
    expect(parseRsiSetupArgs(['--install-owner','--profile','web','--dsh-home','/tmp/home','--source-repository','/tmp/source']))
      .toMatchObject({installOwner:true,profile:'web',sourceRepository:'/tmp/source',apply:false})
    expect(() => parseRsiSetupArgs(['--install-owner','--profile','web','--dsh-home','/tmp/home','--apply']))
      .toThrow('cannot be combined')
    expect(parseRsiSetupArgs(['--install-owner','--profile','web','--dsh-home','/tmp/home','--ack-existing-automations']).ackExistingAutomations).toBe(true)
  })
  test('argument parser refuses implicit mutation and incompatible operations', () => {
    const base = ['--manifest', '/tmp/private.json', '--dsh-home', '/tmp/home']
    expect(() => parseRsiSetupArgs([...base, '--start'])).toThrow('requires --apply')
    expect(() => parseRsiSetupArgs([...base, '--apply'])).toThrow('confirm-hosts-stopped')
    expect(() => parseRsiSetupArgs([...base, '--rollback', '--apply'])).toThrow('cannot be combined')
    expect(() => parseRsiSetupArgs([...base, '--apply', '--apply'])).toThrow('duplicate')
    expect(parseRsiSetupArgs([...base,'--apply','--confirm-hosts-stopped','--ack-existing-automations']).ackExistingAutomations).toBe(true)
    expect(() => parseRsiSetupArgs([...base,'--ack-existing-automations'])).toThrow('requires --install-owner or --apply')
    expect(() => parseRsiSetupArgs([...base,'--rollback','--confirm-hosts-stopped','--ack-existing-automations'])).toThrow('requires --install-owner or --apply')
    expect(() => parseRsiSetupArgs(['--prepare-build','--profile','web','--ack-existing-automations'])).toThrow('requires --install-owner or --apply')
    if (process.platform === 'darwin') {
      expect(() => parseRsiSetupArgs(['--prepare-build', '--profile', 'web', '--docker-path', '/usr/local/bin/docker']))
        .toThrow('--docker-path is not supported by macOS')
    }
  })
  test('platform gate lives only in the CLI shell, not in the injectable transaction', async () => {
    const f = await fixture()
    // 事务本体在任意平台都可测（ports 已隔离 systemctl/服务安装）。
    await expect(configureRsiSetup(f.args(), f.ports)).resolves.toMatchObject({ mode: 'checked' })
    // CLI 外壳在非 Linux 上拒绝，且发生在读任何 profile 文件之前。
    const platform = vi.spyOn(process, 'platform', 'get')
    platform.mockReturnValue('darwin')
    try {
      await expect(runRsiSetup(['--manifest', f.manifestPath, '--dsh-home', f.home]))
        .rejects.toThrow('requires Linux systemd user services')
    } finally {
      platform.mockRestore()
    }
  })
})
