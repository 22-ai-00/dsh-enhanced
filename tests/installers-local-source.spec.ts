import { link, lstat, mkdtemp, mkdir, open, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { classifyLifecycleScenario } from '../scripts/install/lifecycle-config.mjs'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { stageLinuxRsiPreOwnerNativeResources } from '../plugins/lark-channel/src/rsi-linux-native-resources.ts'
import { rsiMemoryLearningInitialRow } from '../plugins/lark-channel/src/rsi-local-roots-extension.ts'
import { createInstallerFixtures } from './helpers/installer-fixtures.ts'

const {
  cleanupInstallerFixtures,
  temporaryRoots,
  nativePreOwnerLifecycleFixture,
  writePreOwnerPnpmFixtureEnvironment,
  runPreOwnerLifecycle,
  readLifecycleSystemdState,
  readLifecycleSystemdLog,
} = createInstallerFixtures()

afterEach(cleanupInstallerFixtures)

describe.skipIf(process.platform !== 'linux')('explicit pre-owner local source transaction', () => {
  test('rejects external prepared receipt mutation after online candidate resolution without touching services', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const before = await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade', { candidateFailure: 'external-preparation' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('prepared candidate changed')
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command.some(argument => ['mask', 'unmask', 'start', 'stop'].includes(argument)))).toBe(false)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']?.activeState).toBe('active')
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(before)
    expect(await readFile(join(f.dshHome, 'sessions/owner-session.jsonl'), 'utf8')).toBe('durable-session')
    expect(await readFile(join(f.preparationRoot, 'receipt.json'), 'utf8')).toContain('external mutation')
    expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(false)
  }, 45000)

  test.each(['add', 'fetch', 'verify', 'offline', 'missing-started', 'missing-done', 'policy', 'optional-resolution', 'offline-optional-resolution', 'offline-graph-drift'] as const)(
    'rejects final candidate %s before stopping the original service', async candidateFailure => {
      const f = await nativePreOwnerLifecycleFixture()
      const names = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.patch.yml']
      const before = await Promise.all(names.map(name => readFile(join(f.profileDirectory, name), 'utf8')))
      const result = runPreOwnerLifecycle(f, 'local-service-upgrade', { candidateFailure })
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stderr).toContain('final candidate failed before service stop')
      expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command.includes('stop'))).toBe(false)
      expect(await Promise.all(names.map(name => readFile(join(f.profileDirectory, name), 'utf8')))).toEqual(before)
      expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(false)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']?.activeState).toBe('active')
      expect((await readdir(f.root)).some(name => name.startsWith('.dsh-local-candidate-'))).toBe(false)
      const operations = await readFile(f.operationLog, 'utf8')
      expect(operations).toContain('pnpm-metadata-warmup\tabsent\t')
      expect(operations).toContain('candidate-add\tabsent\toffline=false')
    }, 30000)

  test('proves anonymous candidate preparation and native offline replay before the original packages transaction', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status, result.stderr).toBe(0)
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations).toContain('candidate-add\tabsent\toffline=false')
    expect(operations).toContain('candidate-fetch\tabsent\toffline=false')
    expect(operations).toContain('candidate-verify\tabsent\toffline=false')
    expect(operations).toContain('candidate-native\tabsent\toffline=true')
    expect(operations).toContain('candidate-offline-verify\tabsent\toffline=true')
    const invocations = (await readFile(f.bwrapLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const isolated = invocations.filter(args => args.includes('/run/dsh-enhanced-local-pnpm-cache') && !args.includes('--ro-bind-data'))
    expect(isolated.length).toBeGreaterThanOrEqual(5)
    for (const args of isolated) expect(args.filter(value => value === '--bind-fd')).toHaveLength(3)
    expect(isolated.some(args => args.includes('--share-net') && args.includes('--lockfile-only'))).toBe(true)
    const native = isolated.find(args => args.includes('candidate-install'))!
    expect(native).toBeDefined()
    expect(native).not.toContain('--share-net')
    const packageIndex = invocations.findIndex(args => args.includes('packages'))
    expect(packageIndex).toBeGreaterThanOrEqual(0)
    const candidateIndices = invocations.flatMap((args, index) => isolated.includes(args) ? [index] : [])
    expect(candidateIndices.every(index => index < packageIndex)).toBe(true)
    const onlineAdd = invocations.findIndex(args => isolated.includes(args) && args.includes('add') && args.includes('--share-net'))
    const onlineFetch = invocations.findIndex(args => isolated.includes(args) && args.includes('fetch') && args.includes('--share-net'))
    const onlineVerify = invocations.findIndex(args => isolated.includes(args) && args.includes('install') && args.includes('--share-net'))
    const nativeInstall = invocations.indexOf(native)
    const offlineVerify = invocations.findIndex(args => isolated.includes(args) && args.includes('install') && args.includes('--offline'))
    expect(onlineAdd).toBeGreaterThanOrEqual(0)
    expect(onlineFetch).toBeGreaterThan(onlineAdd)
    expect(onlineVerify).toBeGreaterThan(onlineFetch)
    expect(nativeInstall).toBeGreaterThan(onlineVerify)
    expect(offlineVerify).toBeGreaterThan(nativeInstall)
    expect(offlineVerify).toBeLessThan(packageIndex)
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(f.candidateLock)
    expect(await readFile(join(f.dshHome, 'sessions/owner-session.jsonl'), 'utf8')).toBe('durable-session')
  }, 45000)

  test('restores the original service when post-stop packages differ from the proven candidate graph', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const before = await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade', { candidateFailure: 'final-graph-drift' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('final candidate dependency graph changed')
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command.includes('stop'))).toBe(true)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']?.activeState).toBe('active')
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(before)
  }, 45000)
  test.each([
    ['warmup command', { metadataWarmupFails: true }],
    ['missing full metadata', { metadataWarmupMissingMirror: true }],
    ['optional resolution failure', { metadataWarmupSkipReason: 'resolution_failure' as const }],
    ['optional skip without reason', { metadataWarmupSkipReason: 'missing' as const }],
    ['optional resolution failure on stderr', { metadataWarmupStderrSkip: true }],
    ['truncated stderr before optional resolution failure', { metadataWarmupLargeStderr: true }],
  ])('rejects %s before stopping the original service', async (_name, options) => {
    const fixture = await nativePreOwnerLifecycleFixture()
    const metadataNames = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
    const original = await Promise.all(metadataNames.map(name => readFile(join(fixture.profileDirectory, name), 'utf8')))
    const result = runPreOwnerLifecycle(fixture, 'local-service-upgrade', options)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('before service stop')
    if ('metadataWarmupLargeStderr' in options) expect(result.stderr).toContain('output exceeds verification limit')
    expect((await readLifecycleSystemdLog(fixture.systemdLog)).some(command => command.includes('stop'))).toBe(false)
    expect(await Promise.all(metadataNames.map(name => readFile(join(fixture.profileDirectory, name), 'utf8')))).toEqual(original)
    expect(existsSync(fixture.dshHome + '.dsh-enhanced-transaction')).toBe(false)
  })
  test.each(['replay', 'both'] as const)('rejects a silent %s optional graph shrink before service stop', async mode => {
    const fixture = await nativePreOwnerLifecycleFixture()
    const lockfile = `lockfileVersion: '9.0'
packages:
  'koffi@3.3.2':
    resolution: {integrity: sha512-fixture}
  '@koromix/koffi-linux-x64@3.3.2':
    resolution: {integrity: sha512-fixture}
  '@koromix/koffi-linux-arm@3.3.2':
    resolution: {integrity: sha512-fixture}
snapshots:
  'koffi@3.3.2':
    optionalDependencies:
      '@koromix/koffi-linux-x64': 3.3.2
      '@koromix/koffi-linux-arm': 3.3.2
  '@koromix/koffi-linux-x64@3.3.2': {}
  '@koromix/koffi-linux-arm@3.3.2': {}
`
    await writeFile(join(fixture.profileDirectory, 'pnpm-lock.yaml'), lockfile)
    const result = runPreOwnerLifecycle(fixture, 'local-service-upgrade', { metadataGraphShrink: mode })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('before service stop')
    expect(result.stderr).toContain(mode === 'replay' ? 'graphs differ' : 'original registry optional dependency')
    expect((await readLifecycleSystemdLog(fixture.systemdLog)).some(command => command.includes('stop'))).toBe(false)
    expect(await readFile(join(fixture.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfile)
  })
  test('warms complete metadata in disposable profiles and binds an isolated cache copy', async () => {
    const fixture = await nativePreOwnerLifecycleFixture()
    const metadataNames = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
    const original = await Promise.all(metadataNames.map(name => readFile(join(fixture.profileDirectory, name), 'utf8')))
    const directoryIdentity = async (path: string) => { const entry = await lstat(path); return { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode } }
    const pnpmStore = { storePath: join(fixture.root, 'pnpm-store'), identity: await directoryIdentity(join(fixture.root, 'pnpm-store')),
      localSource: { alias: { path: fixture.storeAlias }, cachePath: fixture.cachePath, cacheIdentity: await directoryIdentity(fixture.cachePath) } }
    const preparation = await lifecycleProfileTest.prepareLocalSourceOfflineCache({
      current: { profilesPath: join(fixture.dshHome, 'profiles'), profilesStat: await lstat(join(fixture.dshHome, 'profiles')),
        profilePath: fixture.profileDirectory, profileStat: await lstat(fixture.profileDirectory) },
      homePath: fixture.dshHome, profile: 'web', pnpmPath: join(fixture.fakeBin, 'pnpm'),
    })
    try {
      expect(await Promise.all(metadataNames.map(name => readFile(join(fixture.profileDirectory, name), 'utf8')))).toEqual(original)
      expect(existsSync(join(preparation.rootPath, 'profiles', 'web-metadata'))).toBe(false)
      expect(existsSync(join(preparation.rootPath, 'profiles', 'web-replay'))).toBe(false)
      const metadataPath = join(preparation.cachePath, 'v11/metadata-full/registry.npmjs.org/@koromix/koffi-linux-x64.jsonl')
      expect(await readFile(metadataPath, 'utf8')).toBe('full metadata\n')
      const operations = await readFile(join(fixture.root, 'lifecycle-operations.log'), 'utf8')
      expect(operations.match(/^pnpm-metadata-warmup/gmu)).toHaveLength(2)
      expect(operations).toMatch(/pnpm-metadata-warmup\tabsent\t.*add --force --ignore-scripts --reporter=ndjson /u)
      expect(operations).toMatch(/pnpm-metadata-warmup\tabsent\t.*add --force --ignore-scripts --reporter=ndjson --offline /u)
      expect(operations.match(/^pnpm-metadata-warmup.*$/gmu)?.every(line => !line.includes('--lockfile-only'))).toBe(true)
      expect(operations.match(/^pnpm-verify/gmu)).toHaveLength(2)
      expect(operations.match(/^pnpm-fetch/gmu)).toHaveLength(1)
      expect(operations).not.toContain('--no-frozen-lockfile')
      const transaction = join(fixture.root, 'cache-transaction')
      await mkdir(transaction, { mode: 0o700 })
      const copy = await lifecycleProfileTest.prepareLocalSourcePackageCaches(transaction, pnpmStore, preparation, fixture.profileDirectory)
      try {
        expect(await readFile(join(copy.roots.at(-1)!.sourcePath, 'v11/metadata-full/registry.npmjs.org/@koromix/koffi-linux-x64.jsonl'), 'utf8')).toBe('full metadata\n')
        expect(await readFile(join(copy.roots.at(-1)!.sourcePath, 'v12/metadata-full/entry.jsonl'), 'utf8')).toBe('new version\n')
        expect(await readFile(join(copy.roots.at(-1)!.sourcePath, 'v9/metadata/entry.jsonl'), 'utf8')).toBe('old version\n')
      } finally { await copy.dispose() }
      await writeFile(metadataPath, 'changed metadata\n')
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, fixture.profileDirectory)).rejects.toThrow('registry metadata mirror changed')
      await expect(lifecycleProfileTest.prepareLocalSourcePackageCaches(transaction, pnpmStore, preparation, fixture.profileDirectory)).rejects.toThrow('registry metadata mirror changed')
      expect(await readdir(transaction)).toEqual([])
      await writeFile(metadataPath, 'full metadata\n')
      await rm(metadataPath)
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, fixture.profileDirectory)).rejects.toThrow('registry metadata mirror changed')
      await writeFile(metadataPath, 'full metadata\n')
      const addedMetadata = join(dirname(metadataPath), 'unexpected.jsonl')
      await writeFile(addedMetadata, 'added metadata\n')
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, fixture.profileDirectory)).rejects.toThrow('registry metadata mirror changed')
      await rm(addedMetadata)
      const metadataLink = join(dirname(metadataPath), 'indirection.jsonl')
      await symlink('koffi-linux-x64.jsonl', metadataLink)
      await expect(lifecycleProfileTest.assertLocalSourcePreparation(preparation, fixture.profileDirectory)).rejects.toThrow('registry metadata mirror contains a symlink')
      await rm(metadataLink)
      writePreOwnerPnpmFixtureEnvironment(fixture, { metadataMirrorMutationPath: metadataPath })
      await expect(lifecycleProfileTest.prepareLocalSourcePackageCaches(transaction, pnpmStore, preparation, fixture.profileDirectory)).rejects.toThrow('copied registry metadata mirror changed')
      expect(await readdir(transaction)).toEqual([])
    } finally { await preparation.dispose() }
  })
  // Final candidate resolution and offline replay add a second preparation phase.
  // Complete Linux transactions measured 28s; keep 45s/60s limits local here.
  test('allows unsupported platform optional skips during metadata warmup', async () => {
    const fixture = await nativePreOwnerLifecycleFixture()
    const result = runPreOwnerLifecycle(fixture, 'local-service-upgrade', { metadataWarmupSkipReason: 'unsupported_platform' })
    expect(result.status, result.stderr).toBe(0)
  }, 45000)
  test.each([
    ['verification', { npmVerifyFails: true }],
    ['prefetch', { storeFails: true }],
    ['verification policy', { npmReceiptMissingPolicy: 'dependencyAliasCheck' as const }],
  ])('rejects failed %s before stopping the original service', async (_name, options) => {
    const f = await nativePreOwnerLifecycleFixture()
    const before = await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade', options)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('before service stop')
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command.includes('stop'))).toBe(false)
    expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(false)
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(before)
    expect(existsSync(join(f.cachePath, 'lockfile-verified.jsonl'))).toBe(false)
  })
  test('takes a SQLite store snapshot including committed WAL and isolates writable cache copies', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const transaction = join(f.root, 'cache-transaction')
    await mkdir(transaction, { mode: 0o700 })
    const directoryIdentity = async (path: string) => { const entry = await lstat(path); return { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode } }
    const pnpmStore = { storePath: join(f.root, 'pnpm-store'), identity: await directoryIdentity(join(f.root, 'pnpm-store')),
      localSource: { alias: { path: f.storeAlias }, cachePath: f.cachePath, cacheIdentity: await directoryIdentity(f.cachePath) } }
    const preparation = await lifecycleProfileTest.prepareLocalSourceOfflineCache({
      current: { profilesPath: join(f.dshHome, 'profiles'), profilesStat: await lstat(join(f.dshHome, 'profiles')),
        profilePath: f.profileDirectory, profileStat: await lstat(f.profileDirectory) },
      homePath: f.dshHome, profile: 'web', pnpmPath: join(f.fakeBin, 'pnpm'),
    })
    const storePath = preparation.storePath, cachePath = preparation.cachePath
    await writeFile(join(storePath, 'content'), 'original', { mode: 0o600 })
    await link(join(storePath, 'content'), join(storePath, 'content-alias'))
    await writeFile(join(cachePath, 'cache-content'), 'cached', { mode: 0o600 })
    await symlink('cache-content', join(cachePath, 'contained-link'))
    await mkdir(join(storePath, 'projects'))
    await symlink(f.root, join(storePath, 'projects', 'registered-project'))
    await mkdir(join(cachePath, 'dlx'))
    await symlink(f.root, join(cachePath, 'dlx', 'unrelated-executable'))
    const db = new DatabaseSync(join(storePath, 'index.db'))
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE package_index(key TEXT); INSERT INTO package_index VALUES (\'committed in WAL\')')
    expect((await stat(join(storePath, 'index.db-wal'))).size).toBeGreaterThan(0)
    try {
      const copy = await lifecycleProfileTest.prepareLocalSourcePackageCaches(transaction, pnpmStore, preparation, f.profileDirectory)
      try {
        const clone = new DatabaseSync(join(copy.roots[0].sourcePath, 'index.db'))
        try { expect(clone.prepare('SELECT key FROM package_index').all()).toEqual([{ key: 'committed in WAL' }]) } finally { clone.close() }
        expect((await stat(join(copy.roots[0].sourcePath, 'content'))).nlink).toBe(1)
        await writeFile(join(copy.roots[0].sourcePath, 'content'), 'new')
        expect(existsSync(join(copy.roots[0]!.sourcePath, 'projects'))).toBe(false)
        expect(existsSync(join(copy.roots.at(-1)!.sourcePath, 'dlx'))).toBe(false)
        expect(await realpath(join(copy.roots.at(-1)!.sourcePath, 'contained-link'))).toBe(join(copy.roots.at(-1)!.sourcePath, 'cache-content'))
        expect(await readlink(join(storePath, 'projects', 'registered-project'))).toBe(f.root)
        expect(await readlink(join(cachePath, 'dlx', 'unrelated-executable'))).toBe(f.root)
        await writeFile(join(copy.roots.at(-1)!.sourcePath, 'cache-content'), 'new')
        expect(await readFile(join(storePath, 'content'), 'utf8')).toBe('original')
        expect(await readFile(join(cachePath, 'cache-content'), 'utf8')).toBe('cached')
      } finally { await copy.dispose() }
      expect(await readdir(transaction)).toEqual([])
      await writeFile(join(cachePath, 'other.db-wal'), 'unsupported WAL', { mode: 0o600 })
      await expect(lifecycleProfileTest.prepareLocalSourcePackageCaches(transaction, pnpmStore, preparation, f.profileDirectory)).rejects.toThrow('unsupported active SQLite WAL')
      expect(await readdir(transaction)).toEqual([])
      await rm(join(cachePath, 'other.db-wal'))
      await symlink(join(storePath, 'content'), join(cachePath, 'escape'))
      await expect(lifecycleProfileTest.prepareLocalSourcePackageCaches(transaction, pnpmStore, preparation, f.profileDirectory)).rejects.toThrow('cache symlink escapes its boundary')
      expect(await readdir(transaction)).toEqual([])
      expect(await readFile(join(pnpmStore.storePath, 'original-store'), 'utf8')).toBe('original store')
      expect(await readFile(join(f.cachePath, 'original-cache'), 'utf8')).toBe('original cache')
    } finally { db.close(); await preparation.dispose() }
  })
  test('rejects a different installed store before stopping the service', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const foreign = join(f.root, 'foreign-store')
    await mkdir(foreign)
    await writeFile(join(f.profileDirectory, 'node_modules', '.modules.yaml'), stringify({ storeDir: foreign }), { mode: 0o600 })
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('installed store alias does not match')
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command.includes('stop'))).toBe(false)
  })
  test('reproduces the native resource gate for a lock-anchored physical stage alias', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'local-source-stage-alias-')))
    temporaryRoots.push(root)
    const logicalHome = join(root, 'home'), stage = join(root, 'stopped-stage')
    await mkdir(logicalHome, { mode: 0o700 })
    await mkdir(stage, { mode: 0o700 })
    const parent = await open(root, 'r')
    try {
      const alias = `/proc/self/fd/${parent.fd}/stopped-stage`
      expect(await realpath(alias)).toBe(stage)
      await expect(stageLinuxRsiPreOwnerNativeResources({ logicalHome, stagePhysicalHome: alias, profile: 'assistant', preparationRoot: join(root, 'prepared') }))
        .rejects.toThrow('stage must be a distinct canonical stopped Home')
    } finally { await parent.close() }
  })
  test('accepts large frozen resource binaries within 256MiB while retaining the profile 64MiB limit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'local-source-large-resource-'))
    temporaryRoots.push(home)
    const profile = 'assistant'
    for (const kind of ['rsi-sources', 'rsi-local-cohorts', 'rsi-builds', 'rsi-release-builds', 'rsi-authorities', 'rsi-authority-runtimes']) {
      await mkdir(join(home, kind, profile), { recursive: true, mode: 0o700 })
    }
    const profilePath = join(home, 'profiles', profile)
    await mkdir(join(profilePath, 'node_modules'), { recursive: true, mode: 0o700 })
    for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
      await writeFile(join(profilePath, name), '{}', { mode: 0o600 })
    }
    const resource = join(home, 'rsi-authority-runtimes', profile, 'node')
    const handle = await open(resource, 'wx', 0o600)
    try { await handle.truncate(64 * 1024 * 1024 + 1) } finally { await handle.close() }
    const before = await lifecycleProfileTest.localSourcePhysicalProof(home, profile)
    await expect(lifecycleProfileTest.profileTreeDigest(join(home, 'rsi-authority-runtimes', profile))).rejects.toThrow('大小不安全')
    const changed = await open(resource, 'r+')
    try { await changed.write(Buffer.from('x'), 0, 1, 0) } finally { await changed.close() }
    expect((await lifecycleProfileTest.localSourcePhysicalProof(home, profile)).resources['rsi-authority-runtimes']).not.toBe(before.resources['rsi-authority-runtimes'])
    const alias = join(home, 'rsi-authority-runtimes', profile, 'alias')
    await link(resource, alias)
    await expect(lifecycleProfileTest.localSourcePhysicalProof(home, profile)).rejects.toThrow('身份或大小不安全')
    await rm(alias)
    const oversized = await open(resource, 'r+')
    try { await oversized.truncate(256 * 1024 * 1024 + 1) } finally { await oversized.close() }
    await expect(lifecycleProfileTest.localSourcePhysicalProof(home, profile)).rejects.toThrow('大小不安全')
  })
  test('rejects retained owner authority before stopping the service', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    await writeFile(join(f.dshHome,'owner-residue'),'retained owner',{mode:0o600})
    const result = runPreOwnerLifecycle(f,'local-service-upgrade')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('owner/coordinator rejected')
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command.includes('stop'))).toBe(false)
    expect(await readFile(join(f.dshHome,'sessions/owner-session.jsonl'),'utf8')).toBe('durable-session')
  })
  test('rejects a native root rewrite in a private snapshot and preserves live custom configuration', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const path = join(f.profileDirectory, 'cordis.yml')
    const custom = '- id: custom\n  name: x\n'
    await writeFile(path, custom)
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('native composition changed persistent configuration bytes')
    expect(await readFile(path, 'utf8')).toBe(custom)
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command.includes('stop'))).toBe(false)
  })
  test('rejects retained owner grants in a sibling raw patch before any native dump', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const sibling = join(f.dshHome, 'profiles', 'other')
    await mkdir(sibling)
    await writeFile(join(sibling, 'cordis.patch.yml'), '- id: retained\n  config:\n    sourceAdoptions: {}\n')
    const before = await readFile(f.dshLog, 'utf8').catch(() => '')
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('owner/source')
    expect(await readFile(f.dshLog, 'utf8').catch(() => '')).toBe(before)
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command.includes('stop'))).toBe(false)
  })
  test('updates the frozen source and runtime through the existing service transaction', async () => {
    // The four-fd assertion includes both canonical and alias stores hidden by /tmp.
    const f = await nativePreOwnerLifecycleFixture({ temporaryParent: '/tmp' })
    const result = runPreOwnerLifecycle(f,'local-service-upgrade')
    expect(result.status,result.stderr).toBe(0)
    expect((await stat(f.dshHome)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(f.dshHome,'rsi-sources/web/receipt.json'),'utf8')).toContain('new')
    expect(await readFile(join(f.dshHome,'rsi-authority-runtimes/web/receipt.json'),'utf8')).toContain('new')
    expect(JSON.parse(await readFile(join(f.dshHome, 'rsi-authority-runtimes/web/receipt.json'), 'utf8')).logicalSource).toBe(join(f.dshHome, 'profiles/web/node_modules/@dsh-enhanced/plugin-control-plane'))
    expect(await readFile(join(f.profileDirectory,'pnpm-lock.yaml'),'utf8')).toBe(f.candidateLock)
    expect(await readFile(join(f.dshHome,'sessions/owner-session.jsonl'),'utf8')).toBe('durable-session')
    expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(false)
    expect(await readFile(join(f.root, 'pnpm-store', 'original-store'), 'utf8')).toBe('original store')
    expect(await readFile(join(f.cachePath, 'original-cache'), 'utf8')).toBe('original cache')
    expect(existsSync(join(f.root, 'pnpm-store', 'package-install-marker'))).toBe(false)
    expect(existsSync(join(f.cachePath, 'package-install-marker'))).toBe(false)
    const invocations = (await readFile(f.bwrapLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const packageInvocation = invocations.find(args => args.includes('packages'))!
    expect(packageInvocation).toContain('--unshare-all')
    expect(packageInvocation).not.toContain('--share-net')
    const storeEnv = packageInvocation.indexOf('pnpm_config_store_dir')
    expect(packageInvocation[storeEnv + 1]).toBe(f.storeAlias)
    const storeMount = packageInvocation.lastIndexOf(join(f.root, 'pnpm-store'))
    expect(packageInvocation[storeMount - 2]).toBe('--bind-fd')
    expect(packageInvocation.filter(arg => arg === '--bind-fd')).toHaveLength(4)
    for (const invocation of invocations.filter(args => args.some(arg => ['configs', 'verify', 'preview-overlay', 'assert-preview'].includes(arg)))) {
      expect(invocation.filter(arg => arg === '--bind-fd')).toHaveLength(1)
      expect(invocation).not.toContain('pnpm_config_cache_dir')
    }
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command.includes('stop'))).toBe(true)
    expect(commands.some(command => command.includes('start'))).toBe(true)
  }, 45000)
  test('applies the frozen learner-root extension through the stopped transaction and fresh service acceptance', async () => {
    // Only systemd, package installation and native config composition are fixture ports.
    const f = await nativePreOwnerLifecycleFixture({ baseServices: true, memoryExtension: true })
    const original = await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status, result.stderr).toBe(0)
    const rows = parse(await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')) as Record<string, unknown>[]
    expect(rows.slice(0, -1)).toEqual(parse(original))
    expect(rows.at(-1)).toEqual(rsiMemoryLearningInitialRow)
    expect(await readFile(join(f.dshHome, 'rsi-sources/web/receipt.json'), 'utf8')).toContain('new')
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(f.candidateLock)
    expect(await readFile(join(f.dshHome, 'sessions/owner-session.jsonl'), 'utf8')).toBe('durable-session')
    expect(await readFile(join(f.dshHome, 'assistant-delivery/preview-queue.json'), 'utf8')).toBe('{"attempts":0,"pending":["owner-job"]}')
    const database = new DatabaseSync(join(f.dshHome, 'assistant-goals', 'web.sqlite'))
    try { expect(database.prepare('SELECT value FROM goals').all()).toEqual([{ value: 'durable-goal-state' }]) }
    finally { database.close() }
    const accepted = (await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']!
    expect(accepted.activeState).toBe('active')
    expect(accepted.invocationId).toMatch(/^fresh-web-/u)
    expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(false)
  }, 45000)
  test('accepts a pre-owner profile with baseline Recovery and Control Plane services', async () => {
    const f = await nativePreOwnerLifecycleFixture({ baseServices: true })
    const config = await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')
    expect(await classifyLifecycleScenario(config, { dshExecutable: join(f.fakeBin, 'dsh') })).toBe('supervised')
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(f.dshHome, 'rsi-sources/web/receipt.json'), 'utf8')).toContain('new')
    expect(await readFile(join(f.dshHome, 'rsi-authority-runtimes/web/receipt.json'), 'utf8')).toContain('new')
    expect(await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')).toBe(config)
    expect(await readFile(join(f.dshHome, 'sessions/owner-session.jsonl'), 'utf8')).toBe('durable-session')
    expect(await readFile(join(f.dshHome, 'assistant-delivery/preview-queue.json'), 'utf8')).toBe('{"attempts":0,"pending":["owner-job"]}')
    const accepted = (await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']!
    expect(accepted.activeState).toBe('active')
    expect(accepted.invocationId).toMatch(/^fresh-web-/u)
    expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(false)
    expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe('')
  }, 45000)
  test('discards activation writes to Delivery, sessions and business databases before deployment', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(f.dshHome, 'assistant-delivery', 'preview-queue.json'), 'utf8')).toBe('{"attempts":0,"pending":["owner-job"]}')
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    const database = new DatabaseSync(join(f.dshHome, 'assistant-goals', 'web.sqlite'))
    try {
      expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
      expect(database.prepare('SELECT value FROM goals').all()).toEqual([{ value: 'durable-goal-state' }])
    } finally { database.close() }
    expect(await readFile(f.dshLog, 'utf8')).toContain('--host\t127.0.0.1\t--no-open\t--port\t0')
    expect((await readdir(f.root)).filter(name => name.startsWith('.dsh-local-source-activation-'))).toEqual([])
  }, 45000)
  test('restores the original active service and preserves original source after staged package failure', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const result = runPreOwnerLifecycle(f,'local-service-upgrade',{packageFails:true})
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('fixture package failure')
    expect(existsSync(join(f.root, 'pnpm-store', 'package-install-marker'))).toBe(false)
    expect(existsSync(join(f.cachePath, 'package-install-marker'))).toBe(false)
    const archived = (await readdir(f.root)).find(name => name.startsWith('home.dsh-enhanced-transaction.failed-'))!
    expect((await readdir(join(f.root, archived))).some(name => name.startsWith('local-package-caches-'))).toBe(false)
    expect((await stat(f.dshHome)).mode & 0o777).toBe(0o755)
    expect(await readFile(join(f.dshHome,'rsi-sources/web/receipt.json'),'utf8')).toContain('old')
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']?.activeState).toBe('active')
  // Includes the full staged package transaction and restoration, like the
  // adjacent upgrade cases; measured Linux runs approach 15 seconds.
  }, 45000)
  test('recovers a swapped candidate only after rechecking the frozen module/source identities', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const first = runPreOwnerLifecycle(f,'local-service-upgrade',{systemdStartFailsProfile:'web'})
    expect(first.status).not.toBe(0)
    expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(true)
    const recovery = runPreOwnerLifecycle(f,'local-service-recover')
    expect(recovery.status,recovery.stderr).toBe(0)
    expect(await readFile(join(f.dshHome,'rsi-sources/web/receipt.json'),'utf8')).toContain('new')
    expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(false)
  }, 60000)
  test('refuses installed package byte drift during recovery before service operations', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const first = runPreOwnerLifecycle(f, 'local-service-upgrade', { systemdStartFailsProfile: 'web' })
    expect(first.status).not.toBe(0)
    await writeFile(join(f.profileDirectory, 'node_modules/@dsh-enhanced/plugin-control-plane/lib/entry.js'), 'unapproved-bytes')
    const before = await readFile(f.systemdLog, 'utf8')
    const recovery = runPreOwnerLifecycle(f, 'local-service-recover')
    expect(recovery.status).not.toBe(0)
    expect(recovery.stderr).toContain('installed package file differs')
    const added = (await readFile(f.systemdLog, 'utf8')).slice(before.length)
    expect(added).not.toContain('stop')
    expect(added).not.toContain('start')
  }, 60000)
  test('restores an original-renamed crash after proving the original snapshot', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const first = runPreOwnerLifecycle(f, 'local-service-upgrade', { killLifecycleAfterOriginalRename: true })
    expect(first.status).not.toBe(0)
    expect(existsSync(f.dshHome)).toBe(false)
    const recovery = runPreOwnerLifecycle(f, 'local-service-recover')
    expect(recovery.status, recovery.stderr).toBe(0)
    expect((await stat(f.dshHome)).mode & 0o777).toBe(0o755)
    expect(await readFile(join(f.dshHome, 'rsi-sources/web/receipt.json'), 'utf8')).toContain('old')
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']?.activeState).toBe('active')
  }, 45000)
  test('refuses drifted reviewed installer code during recovery before any service operation', async () => {
    const f = await nativePreOwnerLifecycleFixture()
    const first = runPreOwnerLifecycle(f,'local-service-upgrade',{systemdStartFailsProfile:'web'})
    expect(first.status).not.toBe(0)
    await writeFile(join(f.moduleRoot,'plugins/lark-channel/lib/rsi-local-update.js'),'export const drift=true\n')
    const before = await readFile(f.systemdLog,'utf8')
    const recovery = runPreOwnerLifecycle(f,'local-service-recover')
    expect(recovery.status).not.toBe(0)
    expect(recovery.stderr).toContain('installer module bytes or ownership changed')
    const added = (await readFile(f.systemdLog,'utf8')).slice(before.length)
    expect(added).not.toContain('stop')
    expect(added).not.toContain('start')
  }, 60000)
})
