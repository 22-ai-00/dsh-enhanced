import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { rsiCoordinatorProfile } from '../src/rsi-install.js'
import { prepareRsiLocalCohort, readRsiLocalCohort, verifyRsiLocalInstalledPackages, rsiLocalPeerOverrides, type RsiLocalCohort } from '../src/rsi-local-cohort.js'
import { installRsiLocalProfile, mergeRsiLocalOverrides, rsiLocalDependencyOverrides, type RsiLocalProfilePorts } from '../src/rsi-local-install.js'
import { stageRsiLocalPairPackages } from '../src/rsi-local-pair-install.js'
import { prepareRsiSourceWorkspace } from '../src/rsi-source.js'
import { localCohortFixture } from './fixtures/rsi-local-cohort.js'

// The disposable Home's outer lifecycle sandbox and lock are caller-owned.
// Only native package-manager commands are simulated; cohort readers, tarball
// extraction, installed-package verification, file replacement and fsync are real.
const coordinatorBundles = ['assistant-policy', 'assistant-automations', 'plugin-control-plane']
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const visit = async (path: string): Promise<void> => {
    const item = await lstat(path)
    result[relative(root, path)] = `${item.mode & 0o777}:${item.isDirectory() ? 'directory' : hash(await readFile(path))}`
    if (item.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name))
  }
  await visit(root); return result
}
async function unpack(cohort: RsiLocalCohort, root: string, bundles: readonly string[]): Promise<void> {
  await rm(join(root, 'node_modules'), { recursive: true, force: true })
  const pending = bundles.map(slug => `@dsh-enhanced/${slug}`), seen = new Set<string>()
  for (let index = 0; index < pending.length; index++) {
    const name = pending[index]!
    if (seen.has(name)) continue
    seen.add(name)
    const pkg = cohort.packages.find(item => item.name === name)!
    const destination = join(root, 'node_modules', '@dsh-enhanced', name.split('/')[1]!)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    execFileSync('/usr/bin/tar', ['-xzf', pkg.tarball, '--strip-components=1', '-C', destination])
    pending.push(...pkg.runtimeDependencies)
  }
}
async function fixture(sameVersion = false, peerGraph = false) {
  const f = await localCohortFixture(peerGraph); roots.push(f.root)
  const original = await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile, source: f.source, bundles: ['target'] }, f.ports)
  const coordinator = rsiCoordinatorProfile(f.profile), pair = [f.profile, coordinator] as const
  for (const name of pair) {
    const root = join(f.home, 'profiles', name), bundles = name === f.profile ? original.bundles : coordinatorBundles
    await mkdir(root, { recursive: true, mode: 0o700 })
    await unpack(original, root, bundles)
    const dependencies = Object.fromEntries(bundles.map(slug => {
      const pkg = original.packages.find(item => item.name === `@dsh-enhanced/${slug}`)!
      return [pkg.name, `file:${pkg.tarball}`]
    }))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: `profile-${name}`, private: true,
      dependencies: { '@deepseek-ai/dsh-base': '0.1.0', ...dependencies }, owner: { setting: 'keep' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...Object.keys(dependencies)], patchReload: 'live' } } }), { mode: 0o600 })
    await writeFile(join(root, 'cordis.patch.yml'), `# owner patch for ${name}\n[]\n`, { mode: 0o600 })
    await writeFile(join(root, 'pnpm-workspace.yaml'), mergeRsiLocalOverrides(
      '# owner workspace\npackages: [.]\nautoInstallPeers: false\noverrides:\n  unrelated-package: 1.2.3\n',
      { ...rsiLocalDependencyOverrides(original), ...(peerGraph ? await rsiLocalPeerOverrides({ cohort: original, bundles }) : {}) }, original.allowBuilds), { mode: 0o600 })
    await writeFile(join(root, 'pnpm-lock.yaml'), '# original lock\n', { mode: 0o600 })
  }
  const receiptPath = join(f.home, `.rsi-coordinator-${hash(f.profile).slice(0, 16)}.json`)
  const receipt = { schemaVersion: 1, targetProfile: f.profile, coordinatorProfile: coordinator,
    version: original.version, sourceRepository: original.sourceRepository }
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
  const version = sameVersion ? original.version : '0.1.49'
  for (const path of ['package.json', ...original.packages.map(pkg => `${pkg.path}/package.json`)]) {
    const manifestPath = join(f.sourceRepository, path), value = JSON.parse(await readFile(manifestPath, 'utf8'))
    value.version = version
    await writeFile(manifestPath, JSON.stringify(value, null, 2) + '\n')
  }
  await writeFile(join(f.sourceRepository, 'plugins/target/lib/index.js'), "export const identity = 'candidate-byte-change'\n")
  git(f.sourceRepository, 'add', '.'); git(f.sourceRepository, 'commit', '-m', 'candidate release')
  const buildHome = join(f.root, 'candidate-home'); await mkdir(buildHome, { mode: 0o700 })
  const source = await prepareRsiSourceWorkspace({ dshHome: buildHome, profile: f.profile, version, sourceRepository: f.sourceRepository })
  const built = await prepareRsiLocalCohort({ dshHome: buildHome, profile: f.profile, source, bundles: ['target'] }, f.ports)
  await rm(original.root, { recursive: true }); await cp(built.root, original.root, { recursive: true })
  const { receiptDigest: _digest, ...body } = built
  const content = { ...body, root: original.root,
    packages: built.packages.map(pkg => ({ ...pkg, tarball: join(original.root, 'artifacts', `${pkg.name.split('/')[1]}.tgz`) })) }
  const candidate: RsiLocalCohort = { ...content, receiptDigest: hash(JSON.stringify(content)) }
  await writeFile(join(candidate.root, 'receipt.json'), JSON.stringify(candidate), { mode: 0o600 })
  await readRsiLocalCohort({ dshHome: f.home, profile: f.profile })
  const path = join(f.root, 'dsh.js'), executable = '#!/usr/bin/env node\n'
  await writeFile(path, executable, { mode: 0o700 })
  const command = vi.fn<RsiLocalProfilePorts['command']>(async (_exe, args, environment) => {
    const name = args[2]!, root = join(f.home, 'profiles', name)
    expect(environment.DSH_HOME).toBe(f.home)
    expect(environment.pnpm_config_package_import_method).toBe('copy')
    if (args[3] === 'add') {
      const bundles = name === f.profile ? original.bundles : coordinatorBundles
      expect(args.slice(4)).toEqual(bundles.map(slug => candidate.packages.find(pkg => pkg.name === `@dsh-enhanced/${slug}`)!.tarball))
      // A same-version add may preserve stale files; the existing installer must
      // verify those bytes and perform its bounded force retry.
      if (!(sameVersion && name === f.profile && environment.pnpm_config_force !== 'true')) await unpack(candidate, root, bundles)
      await writeFile(join(root, 'pnpm-lock.yaml'), `# candidate lock ${candidate.version}\n`, { mode: 0o600 })
    } else expect(args[3]).toBe('list')
    return ''
  })
  const install = vi.fn<typeof installRsiLocalProfile>(input => installRsiLocalProfile(input, { command, verify: verifyRsiLocalInstalledPackages }))
  const input = { dshHome: f.home, profile: f.profile, originalCohort: original,
    dsh: { path, pin: { path, sha256: hash(executable) } }, signal: new AbortController().signal }
  const ports = { install, verify: verifyRsiLocalInstalledPackages }
  return { ...f, original, candidate, coordinator, pair, receiptPath, receipt, input, ports, install, command }
}

describe('disposable Home paired package installation', () => {
  test.each([false, true])('installs and proves both frozen profiles (same version: %s)', async sameVersion => {
    const f = await fixture(sameVersion)
    const before = Object.fromEntries(await Promise.all(f.pair.map(async name => [name, {
      manifest: JSON.parse(await readFile(join(f.home, 'profiles', name, 'package.json'), 'utf8')),
      patch: await readFile(join(f.home, 'profiles', name, 'cordis.patch.yml')),
    }] as const)))
    const proof = await stageRsiLocalPairPackages(f.input, f.ports)
    expect(f.install.mock.calls.map(([input]) => input.profile)).toEqual([...f.pair])
    expect(f.install.mock.calls.map(([input]) => input.cohort)).toEqual([f.candidate, f.candidate])
    for (const name of f.pair) {
      const root = join(f.home, 'profiles', name), bundles = name === f.profile ? f.original.bundles : coordinatorBundles
      await verifyRsiLocalInstalledPackages({ cohort: f.candidate, profilePath: root, bundles: [...bundles] })
      expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual(before[name]!.manifest)
      expect(await readFile(join(root, 'cordis.patch.yml'))).toEqual(before[name]!.patch)
      const source = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), workspace = parseDocument(source).toJS()
      expect(source).toContain('# owner workspace')
      expect(workspace.overrides).toEqual({ 'unrelated-package': '1.2.3', ...rsiLocalDependencyOverrides(f.candidate, name === f.profile ? f.original.bundles : coordinatorBundles) })
      expect(workspace.allowBuilds).toEqual(f.candidate.allowBuilds)
    }
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8'))).toEqual({ ...f.receipt, version: f.candidate.version })
    expect(proof).toMatchObject({ schemaVersion: 1, profile: f.profile, coordinatorProfile: f.coordinator, cohortDigest: f.candidate.receiptDigest })
    const paths = [f.receiptPath, ...f.pair.flatMap(name => ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'].map(file => join(f.home, 'profiles', name, file)))]
    expect(Object.keys(proof.files).sort()).toEqual(paths.sort())
    for (const path of paths) expect(proof.files[path]).toBe(hash(await readFile(path)))
    if (sameVersion) expect(f.command.mock.calls.filter(([, args]) => args[2] === f.profile && args[3] === 'add')
      .map(([, , env]) => env.pnpm_config_force)).toEqual(['false', 'true'])
  })

  test.each(['coordinator-bytes', 'target-bytes', 'manifest-root', 'manifest-bundles', 'workspace', 'coordinator-receipt', 'receipt-extra-key', 'original-cohort'] as const)
    ('rejects %s before any write or install', async drift => {
      const f = await fixture(), target = join(f.home, 'profiles', f.profile), coordinator = join(f.home, 'profiles', f.coordinator)
      if (drift === 'coordinator-bytes') await writeFile(join(coordinator, 'node_modules/@dsh-enhanced/assistant-policy/lib/index.js'), 'changed coordinator')
      if (drift === 'target-bytes') await writeFile(join(target, 'node_modules/@dsh-enhanced/target/lib/index.js'), 'changed target')
      if (drift === 'manifest-root' || drift === 'manifest-bundles') {
        const path = join(coordinator, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
        if (drift === 'manifest-root') manifest.dependencies['@dsh-enhanced/assistant-policy'] = 'file:/foreign/policy.tgz'
        else manifest.dsh.profile.bundles.push('@dsh-enhanced/target')
        await writeFile(path, JSON.stringify(manifest))
      }
      if (drift === 'workspace') {
        const path = join(coordinator, 'pnpm-workspace.yaml'), document = parseDocument(await readFile(path, 'utf8'))
        document.setIn(['overrides', Object.keys(rsiLocalDependencyOverrides(f.original))[0]!], 'file:/foreign/runtime.tgz')
        await writeFile(path, document.toString())
      }
      if (drift === 'coordinator-receipt') await writeFile(f.receiptPath, JSON.stringify({ ...f.receipt, version: '0.1.99' }))
      if (drift === 'receipt-extra-key') await writeFile(f.receiptPath, JSON.stringify({ ...f.receipt, unexpected: true }))
      const input = drift === 'original-cohort' ? { ...f.input, originalCohort: { ...f.original, version: '0.1.99' } } : f.input
      const before = await snapshot(f.home)
      await expect(stageRsiLocalPairPackages(input, f.ports)).rejects.toThrow()
      expect(f.install).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled()
      expect(await snapshot(f.home)).toEqual(before)
    })

  test('the second install failure retains a partial stage and never advances the coordinator receipt', async () => {
    const f = await fixture(), receipt = await readFile(f.receiptPath), install = f.ports.install
    f.ports.install = vi.fn(async input => {
      if (input.profile === f.coordinator) throw new Error('second native install failed')
      await install(input)
    })
    await expect(stageRsiLocalPairPackages(f.input, f.ports)).rejects.toThrow('second native install failed')
    expect(f.ports.install.mock.calls.map(([input]) => input.profile)).toEqual([...f.pair])
    expect(await readFile(f.receiptPath)).toEqual(receipt)
    await verifyRsiLocalInstalledPackages({ cohort: f.candidate, profilePath: join(f.home, 'profiles', f.profile) })
    await verifyRsiLocalInstalledPackages({ cohort: f.original, profilePath: join(f.home, 'profiles', f.coordinator), bundles: coordinatorBundles })
    expect(parseDocument(await readFile(join(f.home, 'profiles', f.coordinator, 'pnpm-workspace.yaml'), 'utf8')).toJS().overrides)
      .toEqual({ 'unrelated-package': '1.2.3', ...rsiLocalDependencyOverrides(f.candidate, coordinatorBundles) })
  })

  test.each(['manifest', 'patch', 'workspace', 'receipt'] as const)
    ('fences %s changes during old inventory verification before the first write', async drift => {
      const f = await fixture(), root = join(f.home, 'profiles', f.profile)
      let verifications = 0, changed: Record<string, string> | undefined
      const verify: typeof verifyRsiLocalInstalledPackages = async input => {
        await verifyRsiLocalInstalledPackages(input)
        if (++verifications !== 2) return
        if (drift === 'manifest') {
          const path = join(root, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
          manifest.owner.setting = 'late correction'; await writeFile(path, JSON.stringify(manifest))
        }
        if (drift === 'patch') await writeFile(join(root, 'cordis.patch.yml'), '# late correction\n[]\n')
        if (drift === 'workspace') await writeFile(join(root, 'pnpm-workspace.yaml'), '# late correction\npackages: [.]\n')
        if (drift === 'receipt') await writeFile(f.receiptPath, JSON.stringify({ ...f.receipt, version: '0.1.99' }))
        changed = await snapshot(f.home)
      }
      await expect(stageRsiLocalPairPackages(f.input, { ...f.ports, verify })).rejects.toThrow(/profile changed before installation|coordinator receipt changed/u)
      expect(f.install).not.toHaveBeenCalled(); expect(changed).toBeDefined()
      expect(await snapshot(f.home)).toEqual(changed)
    })

  test('a changed candidate receipt after both final inventories prevents success', async () => {
    const f = await fixture(), receipt = await readFile(f.receiptPath)
    let verifications = 0
    const verify: typeof verifyRsiLocalInstalledPackages = async input => {
      await verifyRsiLocalInstalledPackages(input)
      if (++verifications !== 4) return
      const { receiptDigest: _digest, ...body } = f.candidate
      const changed = { ...body, sourceCommit: 'f'.repeat(40) }
      await writeFile(join(f.candidate.root, 'receipt.json'), JSON.stringify({ ...changed, receiptDigest: hash(JSON.stringify(changed)) }))
    }
    await expect(stageRsiLocalPairPackages(f.input, { ...f.ports, verify })).rejects.toThrow('candidate cohort changed')
    expect(await readFile(f.receiptPath)).toEqual(receipt)
  })

  test.each(['owner-manifest', 'owner-patch', 'workspace', 'candidate-inventory', 'missing-lock'] as const)
    ('refuses post-install %s drift before advancing the receipt', async drift => {
      const f = await fixture(), receipt = await readFile(f.receiptPath), install = f.ports.install
      f.ports.install = vi.fn(async input => {
        await install(input)
        if (input.profile !== f.coordinator) return
        const root = join(f.home, 'profiles', f.profile)
        if (drift === 'owner-manifest') {
          const path = join(root, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
          manifest.owner.setting = 'changed by install'; await writeFile(path, JSON.stringify(manifest))
        }
        if (drift === 'owner-patch') await writeFile(join(root, 'cordis.patch.yml'), '# changed owner patch\n[]\n')
        if (drift === 'workspace') await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: [.]\n')
        if (drift === 'candidate-inventory') await writeFile(join(root, 'node_modules/@dsh-enhanced/target/lib/index.js'), 'changed after install')
        if (drift === 'missing-lock') await rm(join(root, 'pnpm-lock.yaml'))
      })
      await expect(stageRsiLocalPairPackages(f.input, f.ports)).rejects.toThrow()
      expect(f.ports.install).toHaveBeenCalledTimes(2)
      expect(await readFile(f.receiptPath)).toEqual(receipt)
    })

  test('cancellation before installation changes no files', async () => {
    const f = await fixture(), before = await snapshot(f.home), controller = new AbortController()
    controller.abort(new Error('owner cancelled'))
    await expect(stageRsiLocalPairPackages({ ...f.input, signal: controller.signal }, f.ports)).rejects.toThrow('owner cancelled')
    expect(f.install).not.toHaveBeenCalled(); expect(await snapshot(f.home)).toEqual(before)
  })

  test('cancellation between installations leaves the receipt at the original version', async () => {
    const f = await fixture(), receipt = await readFile(f.receiptPath), controller = new AbortController(), install = f.ports.install
    const coordinatorBefore = await snapshot(join(f.home, 'profiles', f.coordinator))
    f.ports.install = vi.fn(async input => { await install(input); controller.abort(new Error('cancelled between profiles')) })
    await expect(stageRsiLocalPairPackages({ ...f.input, signal: controller.signal }, f.ports)).rejects.toThrow('cancelled between profiles')
    expect(f.ports.install).toHaveBeenCalledTimes(1)
    expect(await readFile(f.receiptPath)).toEqual(receipt)
    expect(await snapshot(join(f.home, 'profiles', f.coordinator))).toEqual(coordinatorBefore)
  })
})


test('migrates exact original peer pins and narrows the coordinator to its own closure', async () => {
  const f = await fixture(false, true)
  await stageRsiLocalPairPackages(f.input, f.ports)
  for (const name of f.pair) {
    const bundles = name === f.profile ? f.original.bundles : coordinatorBundles
    const workspace = parseDocument(await readFile(join(f.home, 'profiles', name, 'pnpm-workspace.yaml'), 'utf8')).toJS()
    expect(workspace.overrides).toEqual({ 'unrelated-package': '1.2.3',
      ...rsiLocalDependencyOverrides(f.candidate, bundles), ...await rsiLocalPeerOverrides({ cohort: f.candidate, bundles }) })
    if (name === f.coordinator) expect(JSON.stringify(workspace.overrides)).not.toContain('@dsh-enhanced/target')
  }
})

test('rejects a changed original peer pin before either profile is written', async () => {
  const f = await fixture(false, true), workspace = join(f.home, 'profiles', f.profile, 'pnpm-workspace.yaml')
  const document = parseDocument(await readFile(workspace, 'utf8'))
  document.setIn(['overrides', '@dsh-enhanced/optional-plugin@0.1.48>@dsh-enhanced/shared-lib'], 'file:/foreign/same-version.tgz')
  await writeFile(workspace, document.toString())
  const before = await snapshot(f.home)
  await expect(stageRsiLocalPairPackages(f.input, f.ports)).rejects.toThrow('override changed')
  expect(f.install).not.toHaveBeenCalled()
  expect(await snapshot(f.home)).toEqual(before)
})
