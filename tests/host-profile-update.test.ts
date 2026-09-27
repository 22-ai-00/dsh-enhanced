import { afterEach, expect, test } from 'vitest'
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, stringify } from 'yaml'
import { materializeHostProfileUpdate, prepareHostProfileUpdate, validateHostProfileUpdate } from '../scripts/install/host-profile-update.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const integrity = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
const native = (name: string, version: string, dependencies = {}) => ({ name, version, dependencies })

async function host(root: string, version: string, dropped: boolean, cordisVersion = dropped ? '4.0.1' : '4.0.2') {
  const yamlEntry = createRequire(import.meta.url).resolve('yaml')
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(dirname(dirname(yamlEntry)), join(root, 'node_modules', 'yaml'))
  const packages = [native('@deepseek-ai/dsh', version), native('@deepseek-ai/dsh-base', version, { '@deepseek-ai/cordis': cordisVersion }), native('@deepseek-ai/cordis', cordisVersion)]
  if (dropped) packages.push(native('@deepseek-ai/old-only', version))
  const lock: Record<string, unknown> = { '': { name: 'test-host', version: '0.0.0' } }
  for (const pkg of packages) {
    const path = join(root, 'node_modules', pkg.name)
    await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(path, 'package.json'), JSON.stringify(pkg))
    lock[`node_modules/${pkg.name}`] = { version: pkg.version, integrity, dependencies: pkg.dependencies }
  }
  await mkdir(join(root, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
  await writeFile(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '')
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lock }))
  return join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
}

async function profile(home: string, name: string, oldHost: string) {
  const path = join(home, 'profiles', name)
  const cohort = name.startsWith('.') ? name.slice(1).split('.plugin-backup-')[0] : name
  const cohortPath = join(home, 'rsi-local-cohorts', cohort)
  await mkdir(join(cohortPath, 'artifacts'), { recursive: true })
  await writeFile(join(cohortPath, 'receipt.json'), '{"schemaVersion":1,"frozen":true}')
  await writeFile(join(cohortPath, 'artifacts', 'child.tgz'), 'frozen tarball bytes')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const manifest = { name: `dsh-profile-${name}`, private: true,
    dependencies: { '@dsh-enhanced/demo': '1.0.0', '@deepseek-ai/cordis': '4.0.1' },
    dsh: { profile: { bundles: ['@dsh-enhanced/demo'] } } }
  const lock = { lockfileVersion: '9.0', importers: { '.': { dependencies: {
    '@dsh-enhanced/demo': { specifier: '1.0.0', version: '1.0.0' },
    '@deepseek-ai/cordis': { specifier: '4.0.1', version: '4.0.1' },
  } } }, packages: {
    '@dsh-enhanced/demo@1.0.0': { resolution: { integrity: 'sha512-frozen' } },
    '@deepseek-ai/cordis@4.0.1': { resolution: { integrity: 'sha512-old' } },
    '@deepseek-ai/old-only@0.1.4': { resolution: { integrity: 'sha512-old' } },
  }, snapshots: {
    '@dsh-enhanced/demo@1.0.0': { dependencies: { '@deepseek-ai/cordis': '4.0.1' } },
    '@deepseek-ai/cordis@4.0.1': {}, '@deepseek-ai/old-only@0.1.4': {},
  } }
  const workspace = { packages: ['.'], nodeLinker: 'isolated', autoInstallPeers: false,
    overrides: { '@dsh-enhanced/demo@1.0.0>@dsh-enhanced/child': `file:${join(cohortPath, 'artifacts', 'child.tgz')}` } }
  await writeFile(join(path, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(path, 'pnpm-lock.yaml'), stringify(lock))
  await writeFile(join(path, 'pnpm-workspace.yaml'), stringify(workspace))
  await writeFile(join(path, 'cordis.patch.yml'), '[]\n')
  const installed = join(path, 'node_modules/.pnpm/@dsh-enhanced+demo@1.0.0/node_modules/@dsh-enhanced/demo')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/demo', version: '1.0.0' }))
  await writeFile(join(installed, 'index.js'), 'frozen artifact bytes')
  await mkdir(join(path, 'node_modules/.pnpm/@deepseek-ai+cordis@4.0.1'), { recursive: true })
  await mkdir(join(path, 'node_modules/@deepseek-ai'), { recursive: true })
  await symlink(join(oldHost, 'node_modules/@deepseek-ai/cordis'), join(path, 'node_modules/@deepseek-ai/cordis'))
  return path
}

async function fixture(names = ['alpha', 'beta']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-profile-update-'))
  roots.push(root)
  const originalHome = join(root, 'home'), stagedHome = join(root, 'stage'), preparationRoot = join(root, 'preparation')
  const oldHost = join(root, 'old-host'), candidateHost = join(root, 'candidate-host')
  await Promise.all([originalHome, preparationRoot].map(path => mkdir(path, { mode: 0o700 })))
  const originalDshPath = await host(oldHost, '0.1.4', true)
  const candidateDshPath = await host(candidateHost, '0.1.5-rc.3', false)
  for (const name of names) await profile(originalHome, name, oldHost)
  await mkdir(join(originalHome, 'profiles/node_modules/@deepseek-ai'), { recursive: true })
  await symlink(join(oldHost, 'node_modules/@deepseek-ai/old-only'), join(originalHome, 'profiles/node_modules/@deepseek-ai/old-only'))
  await symlink(join(oldHost, 'node_modules/@deepseek-ai/cordis'), join(originalHome, 'profiles/node_modules/@deepseek-ai/cordis'))
  await cp(originalHome, stagedHome, { recursive: true })
  const calls: string[] = []
  const runPnpm = async (_args: string[], options: { cwd: string, phase: string, env?: Record<string, string> }) => {
    expect(options.env?.pnpm_config_trust_lockfile).toBe(options.phase === 'materialize' ? 'true' : 'false')
    if (options.phase === 'materialize') {
      expect(options.env?.pnpm_config_offline).toBe('true')
      expect(options.env?.pnpm_config_frozen_store).toBeUndefined()
    }
    calls.push(`${options.phase}:${options.cwd}`)
    const path = options.cwd.startsWith(originalHome) ? options.cwd.replace(originalHome, stagedHome) : options.cwd
    if (options.phase === 'resolve') {
      const lockPath = join(path, 'pnpm-lock.yaml'), lock = parse(await readFile(lockPath, 'utf8'))
      lock.importers['.'].dependencies['@deepseek-ai/cordis'] = { specifier: '4.0.2', version: '4.0.2' }
      delete lock.packages['@deepseek-ai/cordis@4.0.1']
      delete lock.packages['@deepseek-ai/old-only@0.1.4']
      delete lock.snapshots['@deepseek-ai/cordis@4.0.1']
      delete lock.snapshots['@deepseek-ai/old-only@0.1.4']
      lock.packages['@deepseek-ai/cordis@4.0.2'] = { resolution: { integrity } }
      lock.snapshots['@deepseek-ai/cordis@4.0.2'] = {}
      lock.snapshots['@dsh-enhanced/demo@1.0.0'].dependencies['@deepseek-ai/cordis'] = '4.0.2'
      await writeFile(lockPath, stringify(lock))
    }
    if (options.phase === 'materialize') {
      const pkg = join(path, 'node_modules/.pnpm/@dsh-enhanced+demo@1.0.0/node_modules/@dsh-enhanced/demo')
      await mkdir(pkg, { recursive: true })
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/demo', version: '1.0.0' }))
      await writeFile(join(pkg, 'index.js'), 'frozen artifact bytes')
      await mkdir(join(path, 'node_modules/.pnpm/@deepseek-ai+cordis@4.0.2'), { recursive: true })
    }
  }
  return { root, originalHome, stagedHome, preparationRoot, originalDshPath, candidateDshPath, oldHost, candidateHost, calls, runPnpm }
}

test('migrates all profiles, removes old pnpm natives and proven old fallback links, preserving frozen cohort bytes', async () => {
  const f = await fixture()
  const preparation = await prepareHostProfileUpdate(f)
  expect(preparation.profiles.map(x => x.name)).toEqual(['alpha', 'beta'])
  expect(f.calls.filter(x => x.startsWith('resolve:'))).toHaveLength(2)
  const proof = await materializeHostProfileUpdate({ preparation, stagedHome: f.stagedHome, logicalHome: f.originalHome,
    runPnpm: f.runPnpm, runCandidateDsh: async (_args, options) => {
      const target = join(f.stagedHome, 'profiles/node_modules/@deepseek-ai/cordis')
      if (options.profile === 'alpha') await symlink(join(f.candidateHost, 'node_modules/@deepseek-ai/cordis'), target)
    } })
  expect(proof.profileNames).toEqual(['alpha', 'beta'])
  for (const name of proof.profileNames) {
    const path = join(f.stagedHome, 'profiles', name)
    expect(await readdir(join(path, 'node_modules/.pnpm'))).not.toContain('@deepseek-ai+cordis@4.0.1')
    expect(await readFile(join(path, 'node_modules/.pnpm/@dsh-enhanced+demo@1.0.0/node_modules/@dsh-enhanced/demo/index.js'), 'utf8')).toBe('frozen artifact bytes')
    expect((parse(await readFile(join(path, 'pnpm-workspace.yaml'), 'utf8')) as { overrides: Record<string, string> }).overrides['@dsh-enhanced/demo@1.0.0>@dsh-enhanced/child']).toBe(`file:${join(f.originalHome, 'rsi-local-cohorts', name, 'artifacts', 'child.tgz')}`)
    expect(await lstat(join(path, 'node_modules/@deepseek-ai/cordis')).catch(() => undefined)).toBeUndefined()
  }
  expect(await lstat(join(f.stagedHome, 'profiles/node_modules/@deepseek-ai/old-only')).catch(() => undefined)).toBeUndefined()
  expect(await readlink(join(f.stagedHome, 'profiles/node_modules/@deepseek-ai/cordis'))).toBe(join(f.candidateHost, 'node_modules/@deepseek-ai/cordis'))
  expect(await validateHostProfileUpdate({ preparation, stagedHome: f.stagedHome })).toEqual(proof)
})

test('migrates an edge-scoped native override again while preserving a frozen non-native override', async () => {
  const f = await fixture(['alpha'])
  const first = await prepareHostProfileUpdate(f)
  const profilePath = join(f.originalHome, 'profiles', 'alpha'), preparedPath = join(f.preparationRoot, 'alpha')
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    await writeFile(join(profilePath, name), await readFile(join(preparedPath, name)))
  }
  const secondHost = await host(join(f.root, 'second-candidate'), '0.1.6', false, '4.0.3')
  const secondRoot = join(f.root, 'second-preparation')
  await mkdir(secondRoot, { mode: 0o700 })
  const second = await prepareHostProfileUpdate({ originalHome: f.originalHome,
    originalDshPath: f.candidateDshPath, candidateDshPath: secondHost, preparationRoot: secondRoot,
    runPnpm: async (_args: string[], options: { cwd: string; phase: string }) => {
      if (options.phase !== 'resolve') return
      const lockPath = join(options.cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(lockPath, 'utf8'))
      lock.importers['.'].dependencies['@deepseek-ai/cordis'] = { specifier: '4.0.3', version: '4.0.3' }
      delete lock.packages['@deepseek-ai/cordis@4.0.2']; delete lock.snapshots['@deepseek-ai/cordis@4.0.2']
      lock.packages['@deepseek-ai/cordis@4.0.3'] = { resolution: { integrity } }
      lock.snapshots['@deepseek-ai/cordis@4.0.3'] = {}
      lock.snapshots['@dsh-enhanced/demo@1.0.0'].dependencies['@deepseek-ai/cordis'] = '4.0.3'
      await writeFile(lockPath, stringify(lock))
    } })
  expect(first.profiles[0]?.name).toBe('alpha')
  expect(second.profiles[0]?.name).toBe('alpha')
  const workspace = parse(await readFile(join(secondRoot, 'alpha', 'pnpm-workspace.yaml'), 'utf8'))
  expect(workspace.overrides['@dsh-enhanced/demo@1.0.0>@deepseek-ai/cordis']).toBe('4.0.3')
  expect(workspace.overrides['@dsh-enhanced/demo@1.0.0>@dsh-enhanced/child'])
    .toBe(`file:${join(f.originalHome, 'rsi-local-cohorts', 'alpha', 'artifacts', 'child.tgz')}`)
})

test('canonicalizes peer-context native override selectors and rejects unrelated owner overrides', async () => {
  const f = await fixture(['alpha'])
  const path = join(f.originalHome, 'profiles', 'alpha')
  const lockPath = join(path, 'pnpm-lock.yaml'), lock = parse(await readFile(lockPath, 'utf8'))
  lock.importers['.'].dependencies['@dsh-enhanced/demo'].version = '1.0.0(@deepseek-ai/cordis@4.0.1)'
  lock.snapshots['@dsh-enhanced/demo@1.0.0(@deepseek-ai/cordis@4.0.1)'] = lock.snapshots['@dsh-enhanced/demo@1.0.0']
  lock.snapshots['@dsh-enhanced/demo@1.0.0(@deepseek-ai/cordis@4.0.1)'].optionalDependencies = {
    '@deepseek-ai/cordis': '4.0.1(@deepseek-ai/dsh-base@0.1.4)',
  }
  delete lock.snapshots['@dsh-enhanced/demo@1.0.0']
  lock.snapshots['@deepseek-ai/cordis@4.0.1(e676a1)'] = lock.snapshots['@deepseek-ai/cordis@4.0.1']
  delete lock.snapshots['@deepseek-ai/cordis@4.0.1']
  await writeFile(lockPath, stringify(lock))
  const preparation = await prepareHostProfileUpdate({ ...f, runPnpm: async (args: string[], options: { cwd: string; phase: string }) => {
    if (options.phase === 'resolve') {
      const currentPath = join(options.cwd, 'pnpm-lock.yaml'), current = parse(await readFile(currentPath, 'utf8'))
      current.snapshots['@dsh-enhanced/demo@1.0.0'] = current.snapshots['@dsh-enhanced/demo@1.0.0(@deepseek-ai/cordis@4.0.1)']
      delete current.snapshots['@dsh-enhanced/demo@1.0.0(@deepseek-ai/cordis@4.0.1)']
      current.snapshots['@deepseek-ai/cordis@4.0.1'] = current.snapshots['@deepseek-ai/cordis@4.0.1(e676a1)']
      delete current.snapshots['@deepseek-ai/cordis@4.0.1(e676a1)']
      await writeFile(currentPath, stringify(current))
      await f.runPnpm(args, options)
      const changed = parse(await readFile(currentPath, 'utf8'))
      changed.importers['.'].dependencies['@dsh-enhanced/demo'].version = '1.0.0(@deepseek-ai/cordis@4.0.2)'
      changed.snapshots['@dsh-enhanced/demo@1.0.0'].optionalDependencies['@deepseek-ai/cordis']
        = '4.0.2(@deepseek-ai/dsh-base@0.1.5-rc.3)'
      changed.snapshots['@dsh-enhanced/demo@1.0.0(@deepseek-ai/cordis@4.0.2)'] = changed.snapshots['@dsh-enhanced/demo@1.0.0']
      delete changed.snapshots['@dsh-enhanced/demo@1.0.0']
      changed.snapshots['@deepseek-ai/cordis@4.0.2(e676b2)'] = changed.snapshots['@deepseek-ai/cordis@4.0.2']
      delete changed.snapshots['@deepseek-ai/cordis@4.0.2']
      await writeFile(currentPath, stringify(changed))
    } else await f.runPnpm(args, options)
  } })
  expect(preparation.profiles).toHaveLength(1)
  const workspace = parse(await readFile(join(f.preparationRoot, 'alpha', 'pnpm-workspace.yaml'), 'utf8'))
  expect(workspace.overrides['@dsh-enhanced/demo@1.0.0>@deepseek-ai/cordis']).toBe('4.0.2')
  expect(Object.keys(workspace.overrides).some((key: string) => key.includes('('))).toBe(false)
  const originalWorkspacePath = join(path, 'pnpm-workspace.yaml'), owner = parse(await readFile(originalWorkspacePath, 'utf8'))
  owner.overrides['@dsh-enhanced/demo@1.0.0>@deepseek-ai/cordis'] = '9.9.9'
  await writeFile(originalWorkspacePath, stringify(owner))
  const negativeRoot = join(f.root, 'negative-preparation')
  await mkdir(negativeRoot, { mode: 0o700 })
  await expect(prepareHostProfileUpdate({ ...f, preparationRoot: negativeRoot })).rejects.toThrow('existing native override conflicts')
})

test('removes an external alias link that resolves into the retired Host', async () => {
  const f = await fixture(['alpha'])
  const alias = join(f.root, 'old-host-alias')
  await symlink(f.oldHost, alias)
  const fallback = join(f.originalHome, 'profiles', 'alpha', '.dsh-module-fallback', 'node_modules', '@deepseek-ai')
  await mkdir(fallback, { recursive: true })
  await symlink(join(alias, 'node_modules', '@deepseek-ai', 'cordis'), join(fallback, 'cordis'))
  await cp(join(f.originalHome, 'profiles', 'alpha', '.dsh-module-fallback'),
    join(f.stagedHome, 'profiles', 'alpha', '.dsh-module-fallback'), { recursive: true })
  const preparation = await prepareHostProfileUpdate(f)
  await materializeHostProfileUpdate({ preparation, stagedHome: f.stagedHome, logicalHome: f.originalHome,
    runPnpm: f.runPnpm, runCandidateDsh: async () => {} })
  expect(await lstat(join(f.stagedHome, 'profiles', 'alpha', '.dsh-module-fallback', 'node_modules',
    '@deepseek-ai', 'cordis')).catch(() => undefined)).toBeUndefined()
})

test('rejects a disappearing native edge or stale native peer context in a non-native snapshot', async () => {
  const f = await fixture(['alpha'])
  await expect(prepareHostProfileUpdate({ ...f, runPnpm: async (args: string[], options: { cwd: string; phase: string }) => {
    await f.runPnpm(args, options)
    if (options.phase !== 'resolve') return
    const path = join(options.cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(path, 'utf8'))
    delete lock.snapshots['@dsh-enhanced/demo@1.0.0'].dependencies['@deepseek-ai/cordis']
    await writeFile(path, stringify(lock))
  } })).rejects.toThrow('non-native snapshot graph changed')
  const secondRoot = join(f.root, 'stale-peer-preparation')
  await mkdir(secondRoot, { mode: 0o700 })
  await expect(prepareHostProfileUpdate({ ...f, preparationRoot: secondRoot,
    runPnpm: async (args: string[], options: { cwd: string; phase: string }) => {
      await f.runPnpm(args, options)
      if (options.phase !== 'resolve') return
      const path = join(options.cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(path, 'utf8'))
      lock.importers['.'].dependencies['@dsh-enhanced/demo'].version = '1.0.0(@deepseek-ai/cordis@4.0.1)'
      await writeFile(path, stringify(lock))
    } })).rejects.toThrow('native peer context differs')
  const thirdRoot = join(f.root, 'foreign-peer-preparation')
  await mkdir(thirdRoot, { mode: 0o700 })
  await expect(prepareHostProfileUpdate({ ...f, preparationRoot: thirdRoot,
    runPnpm: async (args: string[], options: { cwd: string; phase: string }) => {
      await f.runPnpm(args, options)
      if (options.phase !== 'resolve') return
      const path = join(options.cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(path, 'utf8'))
      lock.importers['.'].dependencies['@dsh-enhanced/demo'].version = '1.0.0(@vendor/sdk@2.0.0)'
      await writeFile(path, stringify(lock))
    } })).rejects.toThrow('non-native importer changed')
})

test('rejects native artifact mismatch, non-native lock drift and unprepared profile inventory', async () => {
  const f = await fixture(['alpha'])
  await expect(prepareHostProfileUpdate({ ...f, runPnpm: async (args, options) => {
    await f.runPnpm(args, options)
    if (options.phase === 'resolve') {
      const lockPath = join(options.cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(lockPath, 'utf8'))
      lock.packages['@dsh-enhanced/demo@1.0.0'].resolution.integrity = 'sha512-tampered'
      await writeFile(lockPath, stringify(lock))
    }
  } })).rejects.toThrow('non-native lock entry changed')
  await rm(f.preparationRoot, { recursive: true })
  await mkdir(f.preparationRoot, { mode: 0o700 })
  const preparation = await prepareHostProfileUpdate(f)
  await profile(f.stagedHome, 'unlisted', f.oldHost)
  await expect(materializeHostProfileUpdate({ preparation, stagedHome: f.stagedHome, logicalHome: f.originalHome,
    runPnpm: f.runPnpm, runCandidateDsh: async () => {} })).rejects.toThrow('profile inventory changed')
})

test('includes only approved rollback backups and preserves their pinned cohort files', async () => {
  const f = await fixture(['alpha'])
  const backup = '.alpha.plugin-backup-activation123'
  const backupPath = await profile(f.originalHome, backup, f.oldHost)
  await cp(backupPath, join(f.stagedHome, 'profiles', backup), { recursive: true })
  await expect(prepareHostProfileUpdate(f)).rejects.toThrow('unsupported profile entry')
  const preparation = await prepareHostProfileUpdate({ ...f, approvedBackupNames: [backup] })
  expect(preparation.profiles.map(x => [x.name, x.backupOf])).toEqual([[backup, 'alpha'], ['alpha', undefined]])
  const launched: string[] = []
  const proof = await materializeHostProfileUpdate({ preparation, stagedHome: f.stagedHome, logicalHome: f.originalHome,
    runPnpm: f.runPnpm, runCandidateDsh: async (_args, options) => { launched.push(options.profile) } })
  expect(launched).toEqual(['alpha'])
  expect(proof.profiles.find(x => x.name === backup)?.backupOf).toBe('alpha')
  expect(proof.profiles.find(x => x.name === backup)?.nonNativePackageDigest).toMatch(/^[a-f0-9]{64}$/u)
  expect(proof.profiles.find(x => x.name === backup)?.localCohortDigest).toMatch(/^[a-f0-9]{64}$/u)
  expect(await readFile(join(f.stagedHome, 'profiles', backup, 'node_modules/.pnpm/@dsh-enhanced+demo@1.0.0/node_modules/@dsh-enhanced/demo/index.js'), 'utf8')).toBe('frozen artifact bytes')
})

test('includes a clean profile without inventing a package-manager lockfile', async () => {
  const f = await fixture(['alpha'])
  const clean = join(f.originalHome, 'profiles', 'clean-web')
  await mkdir(clean, { mode: 0o700 })
  await writeFile(join(clean, 'package.json'), JSON.stringify({ name: 'clean-web', private: true, dependencies: {} }))
  await writeFile(join(clean, 'pnpm-workspace.yaml'), stringify({ packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false }))
  await writeFile(join(clean, 'cordis.patch.yml'), '[]\n')
  await cp(clean, join(f.stagedHome, 'profiles', 'clean-web'), { recursive: true })
  const preparation = await prepareHostProfileUpdate(f)
  expect(preparation.profiles.find(x => x.name === 'clean-web')?.fallbackOnly).toBe(true)
  const proof = await materializeHostProfileUpdate({ preparation, stagedHome: f.stagedHome, logicalHome: f.originalHome,
    runPnpm: f.runPnpm, runCandidateDsh: async () => {} })
  expect(proof.profileNames).toContain('clean-web')
  expect(await lstat(join(f.stagedHome, 'profiles', 'clean-web', 'pnpm-lock.yaml')).catch(() => undefined)).toBeUndefined()
  expect(f.calls.filter(x => x.includes('clean-web'))).toEqual([])
})

test('requires a sandbox runner and rejects copied cohort artifact drift', async () => {
  const f = await fixture(['alpha'])
  const preparation = await prepareHostProfileUpdate(f)
  await expect(materializeHostProfileUpdate({ preparation, stagedHome: f.stagedHome, logicalHome: f.originalHome }))
    .rejects.toThrow('staged sandbox runners are required')
  expect(await readFile(join(f.stagedHome, 'profiles', 'alpha', 'package.json'), 'utf8'))
    .toBe(await readFile(join(f.originalHome, 'profiles', 'alpha', 'package.json'), 'utf8'))
  await writeFile(join(f.stagedHome, 'rsi-local-cohorts', 'alpha', 'artifacts', 'child.tgz'), 'changed')
  await expect(materializeHostProfileUpdate({ preparation, stagedHome: f.stagedHome, logicalHome: f.originalHome,
    runPnpm: f.runPnpm, runCandidateDsh: async () => {} })).rejects.toThrow('local cohort bytes changed')
})

test('loads verified Host YAML from an isolated downloaded helper directory', async () => {
  const f = await fixture(['alpha'])
  const directory = join(f.root, 'downloaded-assets')
  await mkdir(directory)
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  for (const name of ['host-profile-update.mjs', 'lifecycle-config.mjs'])
    await cp(join(sourceRoot, 'scripts', 'install', name), join(directory, name))
  const downloaded = await import(pathToFileURL(join(directory, 'host-profile-update.mjs')).href)
  const preparation = await downloaded.prepareHostProfileUpdate(f)
  expect(preparation.profiles.map((profile: { name: string }) => profile.name)).toEqual(['alpha'])
})
