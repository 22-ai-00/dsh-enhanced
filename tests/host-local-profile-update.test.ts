import { afterEach, expect, test, vi } from 'vitest'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'
import { parse, stringify } from 'yaml'
import { deriveHostLocalProfileMetadata, materializeHostLocalProfileUpdate, prepareHostLocalProfileUpdate,
  validateHostLocalProfileUpdate } from '../scripts/install/host-local-profile-update.mjs'
import { nativeAuthority, readMetadata } from '../scripts/install/host-profile-update.mjs'
import { createHash } from 'node:crypto'

const reviewed = vi.hoisted(() => ({ peers: {} as Record<string, Record<string, string>> }))
vi.mock('../scripts/install/local-source-maintenance.mjs', () => ({
  loadLocalSourceInstaller: async () => ({
    readRsiLocalArtifactManifest: async ({ name }: { name: string }) => ({ peerDependencies: reviewed.peers[name] || {} }),
  }),
}))
vi.mock('../scripts/install/host-legacy-settings.mjs', () => ({
  verifyHostLegacySettingsImport: async () => '[]\n',
}))

const roots: string[] = []
afterEach(async () => {
  reviewed.peers = {}
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const integrity = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='

async function host(root: string, version: string, cordis: string) {
  await mkdir(join(root, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
  await mkdir(join(root, 'node_modules/@deepseek-ai/dsh-base'), { recursive: true })
  await mkdir(join(root, 'node_modules/@deepseek-ai/cordis'), { recursive: true })
  await cp(dirname(createRequire(import.meta.url).resolve('yaml/package.json')), join(root, 'node_modules/yaml'), { recursive: true })
  const packages = [
    ['@deepseek-ai/dsh', version, {}], ['@deepseek-ai/dsh-base', version, { '@deepseek-ai/cordis': cordis }],
    ['@deepseek-ai/cordis', cordis, {}],
  ] as const
  const lock: Record<string, unknown> = { '': { name: 'fixture', version: '0.0.0' } }
  for (const [name, release, dependencies] of packages) {
    await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: release, dependencies }))
    lock[`node_modules/${name}`] = { version: release, integrity, dependencies }
  }
  const bin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  await writeFile(bin, '')
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lock }))
  return bin
}

async function fixture(names = ['assistant', 'acp']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-joint-profile-')))
  roots.push(root)
  const originalHome = join(root, 'home'), preparationRoot = join(root, 'prepare'), candidateHome = join(preparationRoot, 'candidate-home')
  const stagedHome = join(root, 'stage'), oldHost = join(root, 'old-host'), candidateHost = join(root, 'candidate-host')
  await mkdir(originalHome, { mode: 0o700 }); await mkdir(candidateHome, { recursive: true, mode: 0o700 })
  const originalDshPath = await host(oldHost, '0.1.5-rc.3', '4.0.2')
  const candidateDshPath = await host(candidateHost, '0.2.0-rc.2', '4.0.4')
  const candidateArtifacts: Record<string, unknown> = {}
  const content = 'candidate package bytes'
  for (const name of ['demo', 'acp']) {
    const tarball = join(originalHome, 'rsi-local-cohorts', name === 'acp' ? 'acp' : 'assistant', 'artifacts', `${name}.tgz`)
    const sourcePath = join(candidateHome, relative(originalHome, tarball))
    await mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 })
    await writeFile(sourcePath, content)
    candidateArtifacts[`@dsh-enhanced/${name}`] = { version: '0.1.48', tarball, sourcePath, sha256: digest(content),
      runtimeDependencies: [], files: [{ path: 'index.js', sha256: digest(content), mode: 0o644 },
        { path: 'package.json', sha256: digest(JSON.stringify({ name: `@dsh-enhanced/${name}`, version: '0.1.48' })), mode: 0o644 }] }
  }
  for (const cohort of ['assistant', 'acp']) {
    const logicalRoot = join(originalHome, 'rsi-local-cohorts', cohort)
    const packages = Object.entries(candidateArtifacts).filter(([, value]) => (value as { tarball: string }).tarball.startsWith(`${logicalRoot}/`))
      .map(([name, value]) => ({ name, tarball: (value as { tarball: string }).tarball }))
    const body = { schemaVersion: 1, root: logicalRoot, packages }
    await writeFile(join(candidateHome, 'rsi-local-cohorts', cohort, 'receipt.json'), JSON.stringify({ ...body, receiptDigest: digest(JSON.stringify(body)) }))
  }
  for (const name of names) {
    const path = join(originalHome, 'profiles', name)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const enhanced = `@dsh-enhanced/${name === 'acp' ? 'acp' : 'demo'}`
    const manifest = { name: `dsh-profile-${name}`, private: true,
      dependencies: { [enhanced]: '0.1.1', '@deepseek-ai/cordis': '4.0.2' }, dsh: { profile: name } }
    const lock = { lockfileVersion: '9.0', settings: { autoInstallPeers: false }, importers: { '.': { dependencies: {
      [enhanced]: { specifier: '0.1.1', version: '0.1.1' },
      '@deepseek-ai/cordis': { specifier: '4.0.2', version: '4.0.2' },
    } } }, packages: { [`${enhanced}@0.1.1`]: { resolution: { integrity } },
      '@deepseek-ai/cordis@4.0.2': { resolution: { integrity } } }, snapshots: {
      [`${enhanced}@0.1.1`]: {}, '@deepseek-ai/cordis@4.0.2': {},
    } }
    await writeFile(join(path, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(path, 'pnpm-workspace.yaml'), stringify({ packages: ['.'], overrides: {} }))
    await writeFile(join(path, 'pnpm-lock.yaml'), stringify(lock))
    await writeFile(join(path, 'cordis.patch.yml'), '[]\n')
  }
  await cp(originalHome, stagedHome, { recursive: true })
  await cp(join(candidateHome, 'rsi-local-cohorts'), join(stagedHome, 'rsi-local-cohorts'), { recursive: true })
  const runPnpm = async (_args: string[], options: { phase: string; cwd: string; env: Record<string, string>; logicalHome: string; candidateHome?: string }) => {
    expect(options.env.PNPM_CONFIG_NODE_LINKER).toBe('isolated')
    if (options.phase === 'resolve') {
      expect(options.logicalHome).toBe(originalHome)
      expect(options.candidateHome).toBe(candidateHome)
      expect(options.env.PNPM_CONFIG_TRUST_LOCKFILE).toBe('false')
      const path = join(options.cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(path, 'utf8'))
      const manifest = JSON.parse(await readFile(join(options.cwd, 'package.json'), 'utf8'))
      const enhanced = Object.keys(manifest.dependencies).find(name => name.startsWith('@dsh-enhanced/'))!
      const tarball = (candidateArtifacts[enhanced] as { tarball: string }).tarball
      lock.importers['.'].dependencies[enhanced] = { specifier: `file:${tarball}`, version: `file:${relative(join(originalHome, 'profiles', '__profile__'), tarball)}` }
      lock.importers['.'].dependencies['@deepseek-ai/cordis'] = { specifier: '4.0.4', version: '4.0.4' }
      lock.packages = { [`${enhanced}@file:${relative(join(originalHome, 'profiles', '__profile__'), tarball)}`]: {},
        '@deepseek-ai/cordis@4.0.4': { resolution: { integrity } } }
      lock.snapshots = { [`${enhanced}@file:${relative(join(originalHome, 'profiles', '__profile__'), tarball)}`]: {},
        '@deepseek-ai/cordis@4.0.4': {} }
      lock.overrides = parse(await readFile(join(options.cwd, 'pnpm-workspace.yaml'), 'utf8')).overrides
      await writeFile(path, stringify(lock))
    }
    if (options.phase === 'materialize') {
      expect(options.env.PNPM_CONFIG_OFFLINE).toBe('true')
      const profileName = options.cwd.split('/').at(-1)!
      const enhanced = `@dsh-enhanced/${profileName === 'acp' ? 'acp' : 'demo'}`
      const physical = join(stagedHome, 'profiles', profileName, 'node_modules/.pnpm', `${enhanced.replace('/', '+')}@file`, 'node_modules', enhanced)
      await mkdir(physical, { recursive: true })
      await writeFile(join(stagedHome, 'profiles', profileName, 'node_modules', '.pnpm', 'lock.yaml'),
        await readFile(join(stagedHome, 'profiles', profileName, 'pnpm-lock.yaml')))
      await writeFile(join(physical, 'package.json'), JSON.stringify({ name: enhanced, version: '0.1.48' }))
      await writeFile(join(physical, 'index.js'), content)
      const root = join(stagedHome, 'profiles', profileName, 'node_modules', enhanced)
      await mkdir(dirname(root), { recursive: true })
      await symlink(relative(dirname(root), physical), root)
    }
  }
  return { root, originalHome, preparationRoot, candidateHome, stagedHome, originalDshPath, candidateDshPath,
    candidateArtifacts, installer: { root: 'reviewed-test-installer' }, runPnpm }
}

async function nativePackage(hostRoot: string, name: string, version: string, dependencies: Record<string, string>) {
  const path = join(hostRoot, 'node_modules', name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'package.json'), JSON.stringify({ name, version, dependencies }))
  const lockPath = join(hostRoot, 'package-lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.packages[`node_modules/${name}`] = { version, integrity, dependencies }
  await writeFile(lockPath, JSON.stringify(lock))
}

async function nativeOverrides(input: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, string>) {
  const profile = join(input.originalHome, 'profiles', 'assistant')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), stringify({ packages: ['.'], overrides }))
  const lockPath = join(profile, 'pnpm-lock.yaml'), lock = parse(await readFile(lockPath, 'utf8'))
  lock.overrides = overrides
  await writeFile(lockPath, stringify(lock))
  const staged = join(input.stagedHome, 'profiles', 'assistant')
  await writeFile(join(staged, 'pnpm-workspace.yaml'), stringify({ packages: ['.'], overrides }))
  await writeFile(join(staged, 'pnpm-lock.yaml'), stringify(lock))
}

test('retires only authenticated original native override edges and regenerates the complete candidate graph', async () => {
  const input = await fixture(['assistant'])
  const oldRoot = join(input.root, 'old-host'), candidateRoot = join(input.root, 'candidate-host')
  await nativePackage(oldRoot, '@deepseek-ai/dsh-retired-tool', '0.1.5-rc.3', {})
  await nativePackage(oldRoot, '@deepseek-ai/dsh-retired-parent', '0.1.5-rc.3', {
    '@deepseek-ai/dsh-retired-tool': '0.1.5-rc.3',
  })
  await nativePackage(oldRoot, '@deepseek-ai/dsh-base', '0.1.5-rc.3', {
    '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/dsh-retired-tool': '0.1.5-rc.3',
  })
  await nativePackage(candidateRoot, '@deepseek-ai/dsh-new-tool', '0.2.0-rc.2', {})
  await nativePackage(candidateRoot, '@deepseek-ai/dsh-base', '0.2.0-rc.2', {
    '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/dsh-new-tool': '0.2.0-rc.2',
  })
  await nativeOverrides(input, {
    '@deepseek-ai/dsh-base@0.1.5-rc.3>@deepseek-ai/cordis': '4.0.2',
    '@deepseek-ai/dsh-base@0.1.5-rc.3>@deepseek-ai/dsh-retired-tool': '0.1.5-rc.3',
    '@deepseek-ai/dsh-retired-parent@0.1.5-rc.3>@deepseek-ai/dsh-retired-tool': '0.1.5-rc.3',
  })
  const original = await readMetadata(join(input.originalHome, 'profiles', 'assistant'))
  const originalBytes = structuredClone(original)
  const originalHost = await nativeAuthority(input.originalDshPath)
  const candidateHost = await nativeAuthority(input.candidateDshPath)
  const projected = deriveHostLocalProfileMetadata(original, input.originalHome, originalHost.packages,
    candidateHost.packages, input.candidateArtifacts, createRequire(input.candidateDshPath)('yaml'))
  expect(original).toEqual(originalBytes)
  expect(projected['cordis.patch.yml']).toBe(original['cordis.patch.yml'])
  const preparation = await prepareHostLocalProfileUpdate(input)
  const workspace = parse(await readFile(join(input.preparationRoot, 'assistant', 'pnpm-workspace.yaml'), 'utf8'))
  expect(parse(projected['pnpm-workspace.yaml']).overrides).toEqual(workspace.overrides)
  expect(workspace.overrides).toEqual({
    '@deepseek-ai/dsh-base@0.2.0-rc.2>@deepseek-ai/cordis': '4.0.4',
    '@deepseek-ai/dsh-base@0.2.0-rc.2>@deepseek-ai/dsh-new-tool': '0.2.0-rc.2',
  })
  expect(Object.keys(workspace.overrides).some((key: string) => key.includes('retired'))).toBe(false)
  expect(preparation.originalNative['@deepseek-ai/dsh-retired-parent']).toMatchObject({ version: '0.1.5-rc.3' })
})

test.each([
  ['unknown parent', '@deepseek-ai/dsh-unknown@0.1.5-rc.3>@deepseek-ai/cordis', '4.0.2'],
  ['wrong parent version', '@deepseek-ai/dsh-base@0.1.5-rc.2>@deepseek-ai/cordis', '4.0.2'],
  ['wrong child version', '@deepseek-ai/dsh-base@0.1.5-rc.3>@deepseek-ai/cordis', '4.0.1'],
  ['undeclared edge', '@deepseek-ai/dsh@0.1.5-rc.3>@deepseek-ai/cordis', '4.0.2'],
  ['unknown child', '@deepseek-ai/dsh-base@0.1.5-rc.3>@deepseek-ai/dsh-unknown', '0.1.5-rc.3'],
] as const)('rejects %s native override outside original Host authority', async (_label, key, value) => {
  const input = await fixture(['assistant'])
  await nativeOverrides(input, { [key]: value })
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('override is outside original Host')
})

test('keeps custom and enhanced-parent overrides fail closed', async () => {
  const custom = await fixture(['assistant'])
  await nativeOverrides(custom, { '@custom/driver@1.0.0>@deepseek-ai/cordis': '4.0.2' })
  await expect(prepareHostLocalProfileUpdate(custom)).rejects.toThrow('unapproved override parent')
  const enhanced = await fixture(['assistant'])
  await nativeOverrides(enhanced, { '@dsh-enhanced/demo@0.1.1>@deepseek-ai/dsh-retired-tool': '0.1.5-rc.3' })
  await expect(prepareHostLocalProfileUpdate(enhanced)).rejects.toThrow('candidate Host lacks override')
})

test('does not retire an explicit native root missing from the candidate Host', async () => {
  const input = await fixture(['assistant'])
  await nativePackage(join(input.root, 'old-host'), '@deepseek-ai/dsh-retired-tool', '0.1.5-rc.3', {})
  const profile = join(input.originalHome, 'profiles', 'assistant', 'package.json')
  const manifest = JSON.parse(await readFile(profile, 'utf8'))
  manifest.dependencies['@deepseek-ai/dsh-retired-tool'] = '0.1.5-rc.3'
  await writeFile(profile, JSON.stringify(manifest))
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('candidate Host lacks root')
})

test('rechecks original Host authority before staged validation', async () => {
  const input = await fixture(['assistant'])
  await nativeOverrides(input, { '@deepseek-ai/dsh-base@0.1.5-rc.3>@deepseek-ai/cordis': '4.0.2' })
  const preparation = await prepareHostLocalProfileUpdate(input)
  preparation.originalNative['@deepseek-ai/cordis'].version = '4.0.1'
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('original Host authority drift')
})

test('rejects original Host authority changed during preparation', async () => {
  const input = await fixture(['assistant'])
  await nativeOverrides(input, { '@deepseek-ai/dsh-base@0.1.5-rc.3>@deepseek-ai/cordis': '4.0.2' })
  const runPnpm: typeof input.runPnpm = async (...args) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'resolve') return
    const manifestPath = join(input.root, 'old-host', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, dependencies: {} }))
  }
  await expect(prepareHostLocalProfileUpdate({ ...input, runPnpm }))
    .rejects.toThrow('original Host authority drift')
})

test('rejects changed original Host dependency authority and staged override tampering', async () => {
  const input = await fixture(['assistant'])
  await nativeOverrides(input, { '@deepseek-ai/dsh-base@0.1.5-rc.3>@deepseek-ai/cordis': '4.0.2' })
  const preparation = await prepareHostLocalProfileUpdate(input)
  const oldBase = join(input.root, 'old-host', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json')
  const original = await readFile(oldBase, 'utf8')
  await writeFile(oldBase, JSON.stringify({ ...JSON.parse(original), dependencies: {} }))
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('original Host authority drift')
  await writeFile(oldBase, original)
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  const workspacePath = join(input.stagedHome, 'profiles', 'assistant', 'pnpm-workspace.yaml')
  const workspace = parse(await readFile(workspacePath, 'utf8'))
  workspace.overrides['@deepseek-ai/dsh-base@0.2.0-rc.2>@deepseek-ai/cordis'] = '4.0.1'
  await writeFile(workspacePath, stringify(workspace))
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('staged metadata drift: assistant/pnpm-workspace.yaml')
})

test('binds local cohort install metadata to a persistent pnpm store and detects store drift', async () => {
  const input = await fixture(['assistant'])
  const storePath = join(input.root, 'persistent-store', 'v11')
  await mkdir(storePath, { recursive: true, mode: 0o700 })
  const entry = await lstat(storePath)
  const preparation = { ...await prepareHostLocalProfileUpdate(input), persistentPnpmStore: {
    storePath, identity: { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode },
    transactionRoot: join(input.root, 'transaction'),
  } }
  const metadataPath = join(input.stagedHome, 'profiles/assistant/node_modules/.modules.yaml')
  const lockPath = join(input.stagedHome, 'profiles/assistant/pnpm-lock.yaml')
  const expectedLock = await readFile(join(input.preparationRoot, 'assistant/pnpm-lock.yaml'), 'utf8')
  let generated = ''
  const runPnpm: typeof input.runPnpm = async (...args) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'materialize') return
    generated = `${JSON.stringify({ hoistPattern: ['*'], nodeLinker: 'isolated',
      storeDir: join(input.preparationRoot, 'store', 'v11'), virtualStoreDir: '.pnpm' }, null, 2)}\n`
    await writeFile(metadataPath, generated)
  }
  const proof = await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })
  expect(JSON.parse(await readFile(metadataPath, 'utf8'))).toEqual({ ...JSON.parse(generated), storeDir: storePath })
  expect(await readFile(lockPath, 'utf8')).toBe(expectedLock)
  expect(proof.storeMetadataDigests).toHaveProperty('assistant')
  await rm(join(input.preparationRoot, 'store'), { recursive: true, force: true })
  expect(await validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome })).toEqual(proof)
  await chmod(storePath, 0o777)
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('persistent pnpm store identity changed')
})

test('derives internal peer overrides only inside the selected runtime closure', async () => {
  const input = await fixture(['assistant'])
  reviewed.peers['@dsh-enhanced/demo'] = { '@dsh-enhanced/acp': '^0.1.0' }
  const withoutProvider = await prepareHostLocalProfileUpdate(input)
  expect(withoutProvider.profiles[0].peerScope.overrides).toEqual({})
  const withProvider = await fixture(['assistant'])
  const demo = withProvider.candidateArtifacts['@dsh-enhanced/demo'] as { runtimeDependencies: string[] }
  demo.runtimeDependencies = ['@dsh-enhanced/acp']
  const preparation = await prepareHostLocalProfileUpdate(withProvider)
  const acp = withProvider.candidateArtifacts['@dsh-enhanced/acp'] as { tarball: string }
  expect(preparation.profiles[0].peerScope.overrides).toEqual({
    '@dsh-enhanced/demo@0.1.48>@dsh-enhanced/acp': `file:${acp.tarball}`,
  })
  const workspace = parse(await readFile(join(withProvider.preparationRoot, 'assistant', 'pnpm-workspace.yaml'), 'utf8'))
  expect(workspace.overrides['@dsh-enhanced/demo@0.1.48>@dsh-enhanced/acp']).toBe(`file:${acp.tarball}`)
})

test.each([
  ['without an original age field', undefined],
  ['with an existing age exclusion', ['left-pad@1.0.0']],
] as const)('accepts pnpm release-age exclusions only for exact verified packages in each selected closure %s', async (_label, originalExcludes) => {
  const input = await fixture()
  for (const home of [input.originalHome, input.stagedHome]) for (const name of ['assistant', 'acp']) {
    const path = join(home, 'profiles', name, 'pnpm-workspace.yaml')
    const workspace = parse(await readFile(path, 'utf8'))
    if (originalExcludes !== undefined) workspace.minimumReleaseAgeExclude = [...originalExcludes]
    await writeFile(path, stringify(workspace))
  }
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    const options = args[1]
    if (options.phase !== 'resolve') return
    const name = basename(options.cwd) === 'assistant' ? '@dsh-enhanced/demo' : '@dsh-enhanced/acp'
    const path = join(options.cwd, 'pnpm-workspace.yaml')
    const workspace = parse(await readFile(path, 'utf8'))
    workspace.minimumReleaseAgeExclude = [...(workspace.minimumReleaseAgeExclude ?? []), `${name}@0.1.48`]
    await writeFile(path, stringify(workspace))
  }
  const preparation = await prepareHostLocalProfileUpdate({ ...input, runPnpm })
  for (const name of ['assistant', 'acp']) {
    const workspace = parse(await readFile(join(input.preparationRoot, name, 'pnpm-workspace.yaml'), 'utf8'))
    expect(workspace.minimumReleaseAgeExclude).toEqual([
      ...(originalExcludes ?? []), `@dsh-enhanced/${name === 'assistant' ? 'demo' : 'acp'}@0.1.48`,
    ])
  }
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })
  await validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome })
  const stagedPath = join(input.stagedHome, 'profiles', 'assistant', 'pnpm-workspace.yaml')
  const staged = parse(await readFile(stagedPath, 'utf8'))
  staged.minimumReleaseAgeExclude.push('@dsh-enhanced/acp@0.1.48')
  await writeFile(stagedPath, stringify(staged))
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('staged metadata drift: assistant/pnpm-workspace.yaml')
})

test.each([
  ['outside selected closure', ['@dsh-enhanced/acp@0.1.48'], 'unauthorized prepared minimumReleaseAgeExclude'],
  ['wrong version', ['@dsh-enhanced/demo@0.1.49'], 'unauthorized prepared minimumReleaseAgeExclude'],
  ['version range', ['@dsh-enhanced/demo@^0.1.48'], 'unauthorized prepared minimumReleaseAgeExclude'],
  ['wildcard', ['@dsh-enhanced/demo@*'], 'unauthorized prepared minimumReleaseAgeExclude'],
  ['third-party package', ['left-pad@1.0.0'], 'unauthorized prepared minimumReleaseAgeExclude'],
  ['duplicate addition', ['@dsh-enhanced/demo@0.1.48', '@dsh-enhanced/demo@0.1.48'],
    'duplicate prepared minimumReleaseAgeExclude'],
  ['non-array policy', '@dsh-enhanced/demo@0.1.48', 'workspace minimumReleaseAgeExclude must be a string list'],
] as const)('rejects pnpm release-age exclusion for %s', async (_label, exclusions, message) => {
  const input = await fixture(['assistant'])
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'resolve') return
    const path = join(args[1].cwd, 'pnpm-workspace.yaml')
    const workspace = parse(await readFile(path, 'utf8'))
    workspace.minimumReleaseAgeExclude = exclusions
    await writeFile(path, stringify(workspace))
  }
  await expect(prepareHostLocalProfileUpdate({ ...input, runPnpm })).rejects.toThrow(message)
})

test('preserves original age rules as an ordered prefix and rejects strict or unrelated workspace changes', async () => {
  for (const kind of ['reordered', 'strict', 'unrelated'] as const) {
    const input = await fixture(['assistant'])
    const originalPath = join(input.originalHome, 'profiles', 'assistant', 'pnpm-workspace.yaml')
    const original = parse(await readFile(originalPath, 'utf8'))
    original.minimumReleaseAgeExclude = ['left-pad@1.0.0']
    if (kind === 'strict') original.minimumReleaseAgeStrict = true
    await writeFile(originalPath, stringify(original))
    const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
      await input.runPnpm(...args)
      if (args[1].phase !== 'resolve') return
      const path = join(args[1].cwd, 'pnpm-workspace.yaml')
      const workspace = parse(await readFile(path, 'utf8'))
      workspace.minimumReleaseAgeExclude = kind === 'reordered'
        ? ['@dsh-enhanced/demo@0.1.48', 'left-pad@1.0.0']
        : ['left-pad@1.0.0', '@dsh-enhanced/demo@0.1.48']
      if (kind === 'unrelated') workspace.allowBuilds = { arbitrary: true }
      await writeFile(path, stringify(workspace))
    }
    const message = kind === 'reordered' ? 'ordered prefix'
      : kind === 'strict' ? 'strict minimum release age forbids new exclusions'
        : 'unexpected prepared pnpm-workspace.yaml'
    await expect(prepareHostLocalProfileUpdate({ ...input, runPnpm })).rejects.toThrow(message)
  }
})

test('requires one installed physical provider and resolves a selected peer to it', async () => {
  const input = await fixture(['assistant'])
  reviewed.peers['@dsh-enhanced/demo'] = { '@dsh-enhanced/acp': '^0.1.0' }
  const demo = input.candidateArtifacts['@dsh-enhanced/demo'] as { runtimeDependencies: string[] }
  demo.runtimeDependencies = ['@dsh-enhanced/acp']
  const preparation = await prepareHostLocalProfileUpdate(input)
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'materialize') return
    const modules = join(input.stagedHome, 'profiles', 'assistant', 'node_modules')
    const provider = join(modules, '.pnpm', '@dsh-enhanced+acp@file', 'node_modules', '@dsh-enhanced', 'acp')
    await mkdir(provider, { recursive: true })
    await writeFile(join(provider, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/acp', version: '0.1.48' }))
    await writeFile(join(provider, 'index.js'), 'candidate package bytes')
    const selected = join(modules, '.pnpm', '@dsh-enhanced+demo@file', 'node_modules', '@dsh-enhanced', 'demo',
      'node_modules', '@dsh-enhanced', 'acp')
    await mkdir(dirname(selected), { recursive: true })
    await symlink(relative(dirname(selected), provider), selected)
  }
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })
  const modules = join(input.stagedHome, 'profiles', 'assistant', 'node_modules')
  const duplicate = join(modules, '.pnpm', '@dsh-enhanced+acp@duplicate', 'node_modules', '@dsh-enhanced', 'acp')
  await mkdir(duplicate, { recursive: true })
  await writeFile(join(duplicate, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/acp', version: '0.1.48' }))
  await writeFile(join(duplicate, 'index.js'), 'candidate package bytes')
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('installed package identity split or absent')
})

test('resolves providers fresh after a previously resolved module tree is replaced', async () => {
  const input = await fixture(['assistant'])
  const demo = input.candidateArtifacts['@dsh-enhanced/demo'] as { runtimeDependencies: string[] }
  demo.runtimeDependencies = ['@dsh-enhanced/acp']
  const preparation = await prepareHostLocalProfileUpdate(input)
  const store = join(input.stagedHome, 'profiles', 'assistant', 'node_modules', '.pnpm')
  const originalProvider = join(store, '@dsh-enhanced+acp@file', 'node_modules', '@dsh-enhanced', 'acp')
  const providerLink = join(store, '@dsh-enhanced+demo@file', 'node_modules', '@dsh-enhanced', 'demo',
    'node_modules', '@dsh-enhanced', 'acp')
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'materialize') return
    await mkdir(originalProvider, { recursive: true })
    await writeFile(join(originalProvider, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/acp', version: '0.1.48' }))
    await writeFile(join(originalProvider, 'index.js'), 'candidate package bytes')
    await mkdir(dirname(providerLink), { recursive: true })
    await symlink(relative(dirname(providerLink), originalProvider), providerLink)
  }
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })
  const parentManifest = join(store, '@dsh-enhanced+demo@file', 'node_modules', '@dsh-enhanced', 'demo', 'package.json')
  expect(createRequire(parentManifest).resolve('@dsh-enhanced/acp/package.json')).toBe(join(originalProvider, 'package.json'))
  const replacement = join(store, '@dsh-enhanced+acp@fresh', 'node_modules', '@dsh-enhanced', 'acp')
  await mkdir(dirname(replacement), { recursive: true })
  await rename(originalProvider, replacement)
  await rm(providerLink)
  await symlink(relative(dirname(providerLink), replacement), providerLink)
  await validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome })
})

test('compares installed file inventory in signed bytewise path order', async () => {
  const input = await fixture(['assistant'])
  const artifact = input.candidateArtifacts['@dsh-enhanced/demo'] as {
    files: { path: string; sha256: string; mode: number }[]
  }
  artifact.files.unshift({ path: 'LICENSE', sha256: digest('license bytes'), mode: 0o644 })
  const preparation = await prepareHostLocalProfileUpdate(input)
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'materialize') return
    const root = join(input.stagedHome, 'profiles', 'assistant', 'node_modules', '.pnpm',
      '@dsh-enhanced+demo@file', 'node_modules', '@dsh-enhanced', 'demo')
    await writeFile(join(root, 'LICENSE'), 'license bytes')
  }
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })
})

test('accepts only a semantic copy of the profile lock as pnpm store metadata', async () => {
  const input = await fixture(['assistant'])
  const preparation = await prepareHostLocalProfileUpdate(input)
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  const store = join(input.stagedHome, 'profiles', 'assistant', 'node_modules', '.pnpm')
  const lockPath = join(store, 'lock.yaml')
  const lock = parse(await readFile(lockPath, 'utf8'))
  await writeFile(lockPath, stringify(lock))
  await validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome })
  lock.importers['.'].dependencies['@deepseek-ai/cordis'].version = '0.1.1'
  await writeFile(lockPath, stringify(lock))
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('installed pnpm lockfile differs from profile')
})

test('rejects unknown files or symlinks at pnpm store top level', async () => {
  const input = await fixture(['assistant'])
  const preparation = await prepareHostLocalProfileUpdate(input)
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  const store = join(input.stagedHome, 'profiles', 'assistant', 'node_modules', '.pnpm')
  await writeFile(join(store, 'unknown.txt'), 'not pnpm metadata')
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('unexpected pnpm store entry')
  await rm(join(store, 'unknown.txt'))
  await symlink(input.root, join(store, 'unknown-link'))
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('unexpected pnpm store entry')
})

test('rejects a candidate package outside the selected closure in the resolved lock', async () => {
  const input = await fixture(['assistant'])
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'resolve') return
    const path = join(args[1].cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(path, 'utf8'))
    const acp = input.candidateArtifacts['@dsh-enhanced/acp'] as { tarball: string }
    const locator = relative(join(input.originalHome, 'profiles', '__profile__'), acp.tarball)
    lock.packages[`@dsh-enhanced/acp@file:${locator}`] = {}
    await writeFile(path, stringify(lock))
  }
  await expect(prepareHostLocalProfileUpdate({ ...input, runPnpm }))
    .rejects.toThrow('enhanced package outside selected closure')
})

test('rejects an installed candidate package outside the selected closure', async () => {
  const input = await fixture(['assistant'])
  const preparation = await prepareHostLocalProfileUpdate(input)
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'materialize') return
    const packageRoot = join(input.stagedHome, 'profiles', 'assistant', 'node_modules', '.pnpm',
      '@dsh-enhanced+acp@file', 'node_modules', '@dsh-enhanced', 'acp')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/acp', version: '0.1.48' }))
    await writeFile(join(packageRoot, 'index.js'), 'candidate package bytes')
  }
  await expect(materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} }))
    .rejects.toThrow('installed enhanced package outside selected closure')
})

test('prepares all profiles and materializes a copied Home using pinned candidate artifacts', async () => {
  const input = await fixture()
  const preparation = await prepareHostLocalProfileUpdate(input)
  expect(preparation.profiles.map(profile => profile.name)).toEqual(['acp', 'assistant'])
  const prepared = JSON.parse(await readFile(join(input.preparationRoot, 'assistant', 'package.json'), 'utf8'))
  expect(prepared.dependencies['@deepseek-ai/cordis']).toBe('4.0.4')
  expect(prepared.dependencies['@dsh-enhanced/demo']).toBe(`file:${(input.candidateArtifacts['@dsh-enhanced/demo'] as { tarball: string }).tarball}`)
  const proof = await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  expect(proof.profileNames).toEqual(['acp', 'assistant'])
  expect(await validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome })).toEqual(proof)
})

test('rejects pending native legacy settings before Host profile preparation', async () => {
  const input = await fixture(['assistant'])
  await writeFile(join(input.originalHome, 'settings.yaml'), 'permission:\n  defaultPreset: auto\n')
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('pending native legacy settings import')
})

test('normalizes only the permitted profile patch while retaining other profile drift checks', async () => {
  const input = await fixture()
  const preparation = await prepareHostLocalProfileUpdate(input)
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  const assistantPatch = join(input.stagedHome, 'profiles', 'assistant', 'cordis.patch.yml')
  await writeFile(assistantPatch, '[]\n- id: imported\n')
  const legacySettingsImport = { permit: { profile: 'assistant' } }
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    legacySettingsImport })).resolves.toBeDefined()
  await writeFile(join(input.stagedHome, 'profiles', 'acp', 'cordis.patch.yml'), '- id: drift\n')
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    legacySettingsImport })).rejects.toThrow('staged metadata drift: acp/cordis.patch.yml')
})

test('retires authenticated old shared fallback only in stage and checks its backup after swap', async () => {
  const input = await fixture(['assistant'])
  const globalDshRoot = join(input.root, 'global', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(globalDshRoot, { recursive: true })
  await writeFile(join(globalDshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
  const target = join(globalDshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-runtime')
  const projectionTarget = join(input.originalHome, 'profiles', 'assistant', 'node_modules', '.pnpm',
    'node_modules', '@dsh-enhanced', 'personal-memory')
  const projection = join(input.originalHome, 'profiles', 'assistant', '.dsh-module-fallback',
    'node_modules', '@dsh-enhanced', 'personal-memory')
  for (const home of [input.originalHome, input.stagedHome]) {
    const directory = join(home, 'profiles', 'node_modules', '@deepseek-ai')
    await mkdir(directory, { recursive: true })
    await symlink(target, join(directory, 'dsh-client-runtime'))
    const wrapperLink = join(home, 'profiles', 'assistant', '.dsh-module-fallback',
      'node_modules', '@dsh-enhanced', 'personal-memory')
    const activeLink = join(home, 'profiles', 'assistant', 'node_modules', '@dsh-enhanced', 'personal-memory')
    await mkdir(dirname(wrapperLink), { recursive: true })
    await mkdir(dirname(activeLink), { recursive: true })
    await symlink(projectionTarget, wrapperLink)
    await symlink(projection, activeLink)
  }
  const preparation = await prepareHostLocalProfileUpdate({ ...input, globalDshRoot })
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  expect(await readlink(join(input.originalHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-runtime')))
    .toBe(target)
  expect(await readlink(join(input.originalHome, 'profiles', 'assistant', '.dsh-module-fallback',
    'node_modules', '@dsh-enhanced', 'personal-memory'))).toBe(projectionTarget)
  const backup = join(input.root, 'backup')
  await rename(input.originalHome, backup)
  await rename(input.stagedHome, input.originalHome)
  await validateHostLocalProfileUpdate({ preparation, stagedHome: input.originalHome, originalPhysicalHome: backup })
  expect((await lstat(join(input.originalHome, 'profiles', 'node_modules')).catch(() => undefined))).toBeUndefined()
  expect((await lstat(join(input.originalHome, 'profiles', 'assistant', '.dsh-module-fallback'))
    .catch(() => undefined))).toBeUndefined()
})

test('migrates a known hoisted workspace to isolated layout for verified candidate peers', async () => {
  const input = await fixture(['assistant'])
  for (const home of [input.originalHome, input.stagedHome]) {
    const path = join(home, 'profiles', 'assistant', 'pnpm-workspace.yaml')
    const workspace = parse(await readFile(path, 'utf8'))
    workspace.nodeLinker = 'hoisted'
    await writeFile(path, stringify(workspace))
  }
  const preparation = await prepareHostLocalProfileUpdate(input)
  const prepared = parse(await readFile(join(input.preparationRoot, 'assistant', 'pnpm-workspace.yaml'), 'utf8'))
  expect(prepared.nodeLinker).toBe('isolated')
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
})

test('rejects an unknown workspace layout rather than relaxing installation verification', async () => {
  const input = await fixture(['assistant'])
  const path = join(input.originalHome, 'profiles', 'assistant', 'pnpm-workspace.yaml')
  const workspace = parse(await readFile(path, 'utf8'))
  workspace.nodeLinker = 'pnp'
  await writeFile(path, stringify(workspace))
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('unsupported workspace layout')
})

test('projects only the pinned pnpm selector out of dependent and dependency-free candidate manifests', async () => {
  const input = await fixture(['assistant'])
  await addHeadlessProfile(input)
  for (const home of [input.originalHome, input.stagedHome]) for (const name of ['assistant', 'headless']) {
    const path = join(home, 'profiles', name, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.packageManager = 'pnpm@11.7.0'
    await writeFile(path, JSON.stringify(manifest))
  }
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    const options = args[1]
    const profile = options.phase === 'materialize'
      ? join(input.stagedHome, 'profiles', basename(options.cwd)) : options.cwd
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).packageManager).toBeUndefined()
    await input.runPnpm(...args)
  }
  const preparation = await prepareHostLocalProfileUpdate({ ...input, runPnpm })
  for (const name of ['assistant', 'headless']) {
    expect(JSON.parse(await readFile(join(input.preparationRoot, name, 'package.json'), 'utf8')).packageManager).toBeUndefined()
    expect(JSON.parse(await readFile(join(input.originalHome, 'profiles', name, 'package.json'), 'utf8')).packageManager)
      .toBe('pnpm@11.7.0')
  }
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })
  expect(JSON.parse(await readFile(join(input.stagedHome, 'profiles', 'headless', 'package.json'), 'utf8')).packageManager)
    .toBeUndefined()
})

test.each([
  ['npm@11.7.0', 'assistant'],
  ['pnpm@11.6.0', 'headless'],
  ['pnpm@11.7.0+sha512.fake', 'assistant'],
])('rejects unsupported package manager selector %s in %s', async (selector, profile) => {
  const input = await fixture(['assistant'])
  await addHeadlessProfile(input)
  const path = join(input.originalHome, 'profiles', profile, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.packageManager = selector
  await writeFile(path, JSON.stringify(manifest))
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('unsupported package manager selector')
})

test('rejects an incomplete artifact scope and candidate bytes that change before preparation', async () => {
  const input = await fixture()
  delete input.candidateArtifacts['@dsh-enhanced/acp']
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('candidate artifact missing for root')
  const artifact = input.candidateArtifacts['@dsh-enhanced/demo'] as { sourcePath: string }
  await writeFile(artifact.sourcePath, 'tampered candidate bytes')
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('candidate artifact bytes differ')
})

test('detects original profile drift and staged artifact tampering', async () => {
  const input = await fixture(['assistant'])
  const preparation = await prepareHostLocalProfileUpdate(input)
  const artifact = input.candidateArtifacts['@dsh-enhanced/demo'] as { tarball: string }
  await writeFile(join(input.stagedHome, relative(input.originalHome, artifact.tarball)), 'stage tamper')
  await expect(materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })).rejects.toThrow('candidate cohort resources changed')
  await writeFile(join(input.originalHome, 'profiles', 'assistant', 'cordis.patch.yml'), '- changed\n')
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome })).rejects.toThrow()
})

test('rejects a resolver that leaves an old native edge in the candidate graph', async () => {
  const input = await fixture(['assistant'])
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    const options = args[1]
    if (options.phase !== 'resolve') return
    const path = join(options.cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(path, 'utf8'))
    lock.snapshots['@deepseek-ai/cordis@4.0.2'] = {}
    await writeFile(path, stringify(lock))
  }
  await expect(prepareHostLocalProfileUpdate({ ...input, runPnpm })).rejects.toThrow('stale native snapshot')
})

test('rejects a staged enhanced root linked outside the profile', async () => {
  const input = await fixture(['assistant'])
  const preparation = await prepareHostLocalProfileUpdate(input)
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  const root = join(input.stagedHome, 'profiles', 'assistant', 'node_modules/@dsh-enhanced/demo')
  await rm(root)
  await symlink(input.root, root)
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome })).rejects.toThrow('enhanced root binding is outside profile')
})

async function addHeadlessProfile(input: Awaited<ReturnType<typeof fixture>>) {
  for (const home of [input.originalHome, input.stagedHome]) {
    const profile = join(home, 'profiles', 'headless')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-headless', private: true, dependencies: {} }))
    await writeFile(join(profile, 'pnpm-workspace.yaml'), stringify({ packages: ['.'] }))
    await writeFile(join(profile, 'pnpm-lock.yaml'), stringify({ lockfileVersion: '9.0', settings: { autoInstallPeers: false }, importers: { '.': {} } }))
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  }
}

test('preserves a locked dependency-free profile without creating a pnpm store', async () => {
  const input = await fixture(['assistant'])
  await addHeadlessProfile(input)
  for (const home of [input.originalHome, input.stagedHome]) {
    const modules = join(home, 'profiles', 'headless', 'node_modules')
    await mkdir(join(modules, '.pnpm'), { recursive: true })
    await mkdir(join(modules, '.bin'))
    await writeFile(join(modules, '.modules.yaml'), stringify({ hoistedDependencies: {},
      hoistedLocations: {}, pendingBuilds: [] }))
    await writeFile(join(modules, '.pnpm-workspace-state-v1.json'), JSON.stringify({
      lastValidatedTimestamp: 1, projects: { [join(input.originalHome, 'profiles', 'headless')]: {
        name: 'dsh-profile-headless',
      } }, pnpmfiles: [], settings: { catalogs: {}, workspacePackagePatterns: ['.'], linkWorkspacePackages: false },
      filteredInstall: false,
    }))
  }
  const prepared = await prepareHostLocalProfileUpdate(input)
  const storePath = join(input.root, 'persistent-store', 'v11')
  await mkdir(storePath, { recursive: true, mode: 0o700 })
  const entry = await lstat(storePath)
  const preparation = { ...prepared, persistentPnpmStore: {
    storePath, identity: { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode },
    transactionRoot: join(input.root, 'transaction'),
  } }
  expect(preparation.profiles.find(profile => profile.name === 'headless')?.fallbackOnly).toBe(true)
  const headlessMetadata = await readFile(join(input.stagedHome, 'profiles/headless/node_modules/.modules.yaml'), 'utf8')
  const runPnpm: typeof input.runPnpm = async (...args) => {
    await input.runPnpm(...args)
    if (args[1].phase === 'materialize') {
      await writeFile(join(input.stagedHome, 'profiles/assistant/node_modules/.modules.yaml'),
        JSON.stringify({ storeDir: join(input.preparationRoot, 'store', 'v11') }))
    }
  }
  const proof = await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })
  expect(Object.keys(proof.storeMetadataDigests)).toEqual(['assistant'])
  expect(await validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome })).toEqual(proof)
  expect(await readFile(join(input.stagedHome, 'profiles/headless/node_modules/.modules.yaml'), 'utf8')).toBe(headlessMetadata)
  expect(await readFile(join(input.stagedHome, 'profiles', 'headless', 'pnpm-lock.yaml'), 'utf8'))
    .toBe(await readFile(join(input.originalHome, 'profiles', 'headless', 'pnpm-lock.yaml'), 'utf8'))
})

test.each([
  ['native package', (lock: Record<string, any>) => { lock.packages = { '@deepseek-ai/cordis@4.0.2': { resolution: { integrity } } } }],
  ['enhanced snapshot', (lock: Record<string, any>) => { lock.snapshots = { '@dsh-enhanced/demo@0.1.1': {} } }],
  ['secondary importer dependency', (lock: Record<string, any>) => { lock.importers.extra = { dependencies: { '@dsh-enhanced/demo': { version: '0.1.1' } } } }],
])('rejects stale %s in a dependency-free lockfile', async (_label, mutate) => {
  const input = await fixture(['assistant'])
  await addHeadlessProfile(input)
  const path = join(input.originalHome, 'profiles', 'headless', 'pnpm-lock.yaml')
  const lock = parse(await readFile(path, 'utf8'))
  mutate(lock)
  await writeFile(path, stringify(lock))
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('dependency-free profile has a nonempty lock graph')
})

test('rejects a workspace-state project outside a dependency-free profile', async () => {
  const input = await fixture(['assistant'])
  await addHeadlessProfile(input)
  const modules = join(input.originalHome, 'profiles', 'headless', 'node_modules')
  await mkdir(modules)
  await writeFile(join(modules, '.pnpm-workspace-state-v1.json'), JSON.stringify({
    lastValidatedTimestamp: 1, projects: { [join(input.originalHome, 'profiles', 'headless')]: {
      name: 'dsh-profile-headless',
    }, [join(input.originalHome, 'profiles', 'other')]: { name: 'other' } }, pnpmfiles: [],
    settings: { catalogs: {}, workspacePackagePatterns: ['.'], linkWorkspacePackages: false }, filteredInstall: false,
  }))
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('dependency-free profile has an installed graph')
})

test.each([
  ['native', '@deepseek-ai+cordis@4.0.2'],
  ['enhanced', '@dsh-enhanced+demo@0.1.1'],
])('rejects a stale %s pnpm package in a dependency-free profile', async (_label, folder) => {
  const input = await fixture(['assistant'])
  await addHeadlessProfile(input)
  const store = join(input.originalHome, 'profiles', 'headless', 'node_modules', '.pnpm', folder)
  await mkdir(store, { recursive: true })
  await expect(prepareHostLocalProfileUpdate(input)).rejects.toThrow('dependency-free profile has an installed graph')
})

test('rejects a stale package added to a dependency-free stage after preparation', async () => {
  const input = await fixture(['assistant'])
  await addHeadlessProfile(input)
  const preparation = await prepareHostLocalProfileUpdate(input)
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  await mkdir(join(input.stagedHome, 'profiles', 'headless', 'node_modules', '@dsh-enhanced', 'demo'),
    { recursive: true })
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome }))
    .rejects.toThrow('dependency-free profile has an installed graph')
})

test('validates the promoted Home against its renamed original without rebasing logical artifact paths', async () => {
  const input = await fixture(['assistant'])
  const preparation = await prepareHostLocalProfileUpdate(input)
  await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm: input.runPnpm, runCandidateDsh: async () => {} })
  const backup = join(input.root, 'original-backup')
  await rename(input.originalHome, backup)
  await rename(input.stagedHome, input.originalHome)
  const result = await validateHostLocalProfileUpdate({ preparation, stagedHome: input.originalHome,
    originalPhysicalHome: backup })
  expect(result.profileNames).toEqual(['assistant'])
  const manifest = join(input.originalHome, 'profiles', 'assistant', 'package.json')
  const original = await readFile(manifest)
  await writeFile(manifest, JSON.stringify({ name: 'tampered' }))
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.originalHome,
    originalPhysicalHome: backup })).rejects.toThrow('staged metadata drift')
  await writeFile(manifest, original)
  const installed = join(input.originalHome, 'profiles', 'assistant', 'node_modules', '.pnpm',
    '@dsh-enhanced+demo@file', 'node_modules', '@dsh-enhanced', 'demo', 'index.js')
  const installedOriginal = await readFile(installed)
  await writeFile(installed, 'tampered package')
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.originalHome,
    originalPhysicalHome: backup })).rejects.toThrow('installed package differs from artifact')
  await writeFile(installed, installedOriginal)
  await writeFile(join(backup, 'profiles', 'assistant', 'cordis.patch.yml'), '- changed\n')
  await expect(validateHostLocalProfileUpdate({ preparation, stagedHome: input.originalHome,
    originalPhysicalHome: backup })).rejects.toThrow('original metadata drift')
})

test('normalizes pnpm file locators from the private preparation path to the logical Home', async () => {
  const input = await fixture(['assistant'])
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    const options = args[1]
    if (options.phase !== 'resolve') return
    const path = join(options.cwd, 'pnpm-lock.yaml'), lock = parse(await readFile(path, 'utf8'))
    const logical = (input.candidateArtifacts['@dsh-enhanced/demo'] as { tarball: string }).tarball
    const fromLogical = `file:${relative(join(input.originalHome, 'profiles', '__profile__'), logical)}`
    const fromPreparation = `file:${relative(options.cwd, logical)}`
    const rewrite = (value: unknown): unknown => {
      if (typeof value === 'string') return value.replaceAll(fromLogical, fromPreparation)
      if (Array.isArray(value)) return value.map(rewrite)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [rewrite(key), rewrite(item)]))
      return value
    }
    await writeFile(path, stringify(rewrite(lock)))
  }
  const preparation = await prepareHostLocalProfileUpdate({ ...input, runPnpm })
  const resolved = await readFile(join(input.preparationRoot, 'assistant', 'pnpm-lock.yaml'), 'utf8')
  expect(resolved).toContain(`file:${relative(join(input.originalHome, 'profiles', '__profile__'),
    (input.candidateArtifacts['@dsh-enhanced/demo'] as { tarball: string }).tarball)}`)
  expect(resolved).not.toContain(`file:${relative(join(input.preparationRoot, 'assistant'),
    (input.candidateArtifacts['@dsh-enhanced/demo'] as { tarball: string }).tarball)}`)
  expect(preparation.profiles).toHaveLength(1)
})

test('accepts pnpm runtime dependency symlinks bound to another verified package in the same profile', async () => {
  const input = await fixture(['acp'])
  const acp = input.candidateArtifacts['@dsh-enhanced/acp'] as { runtimeDependencies: string[] }
  acp.runtimeDependencies = ['@dsh-enhanced/demo']
  const preparation = await prepareHostLocalProfileUpdate(input)
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'materialize') return
    const store = join(input.stagedHome, 'profiles', 'acp', 'node_modules', '.pnpm')
    const target = join(store, '@dsh-enhanced+demo@file', 'node_modules', '@dsh-enhanced', 'demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/demo', version: '0.1.48' }))
    await writeFile(join(target, 'index.js'), 'candidate package bytes')
    await chmod(join(target, 'index.js'), 0o600)
    const peer = join(store, '@dsh-enhanced+acp@file', 'node_modules', '@dsh-enhanced', 'demo')
    await symlink(target, peer)
  }
  const proof = await materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })
  expect(proof.profileNames).toEqual(['acp'])
})

test('rejects a pnpm runtime dependency link that escapes the profile store', async () => {
  const input = await fixture(['acp'])
  const acp = input.candidateArtifacts['@dsh-enhanced/acp'] as { runtimeDependencies: string[] }
  acp.runtimeDependencies = ['@dsh-enhanced/demo']
  const preparation = await prepareHostLocalProfileUpdate(input)
  const runPnpm = async (...args: Parameters<typeof input.runPnpm>) => {
    await input.runPnpm(...args)
    if (args[1].phase !== 'materialize') return
    const peer = join(input.stagedHome, 'profiles', 'acp', 'node_modules', '.pnpm',
      '@dsh-enhanced+acp@file', 'node_modules', '@dsh-enhanced', 'demo')
    await symlink(input.root, peer)
  }
  await expect(materializeHostLocalProfileUpdate({ preparation, stagedHome: input.stagedHome,
    logicalHome: input.originalHome, runPnpm, runCandidateDsh: async () => {} })).rejects.toThrow('installed dependency link escapes profile')
})
