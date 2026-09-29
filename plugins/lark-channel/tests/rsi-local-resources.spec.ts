import { createHash } from 'node:crypto'
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { rsiBuildResources as io, type RsiBuildEnvironment } from '../src/rsi-build.js'
import type { RsiLocalCohort } from '../src/rsi-local-cohort.js'
import { stageRsiLocalUpdateResources, verifyRsiLocalUpdateResources } from '../src/rsi-local-resources.js'
import { readRsiLocalUpdateLocked, type RsiLocalUpdatePreparation } from '../src/rsi-local-update.js'
import type { RsiReleaseBuildEnvironment } from '../src/rsi-release-build.js'

// The preparation reader is an explicit trust boundary: its own tests cover
// source/build validation. These tests use real files, copies, renames and fsync;
// io spies below only inject deterministic drift or a failed lifecycle barrier.
// A stopped Home and its lifecycle lock remain the enclosing caller's contract.
vi.mock('../src/rsi-local-update.js', () => ({ readRsiLocalUpdateLocked: vi.fn() }))
const reader = vi.mocked(readRsiLocalUpdateLocked)
const kinds = ['rsi-local-cohorts', 'rsi-builds', 'rsi-release-builds'] as const
const profile = 'owner'
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const encode = (body: object): string => JSON.stringify({ ...body, receiptDigest: hash(JSON.stringify(body)) })
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); reader.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function file(path: string, bytes: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, bytes, { mode }); await chmod(path, mode)
}
async function snapshot(root: string): Promise<{ path: string; mode: number; sha256: string | null }[]> {
  const entries: { path: string; mode: number; sha256: string | null }[] = []
  const visit = async (path: string): Promise<void> => {
    const item = await lstat(path)
    entries.push({ path: relative(root, path), mode: item.mode & 0o777,
      sha256: item.isDirectory() ? null : hash(await readFile(path)) })
    if (item.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name))
  }
  await visit(root)
  return entries
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-local-resources-'))); roots.push(root)
  const home = join(root, 'home'), stage = join(root, 'stage'), preparationRoot = join(root, 'preparation')
  const candidate = join(preparationRoot, 'home'), sourceRepository = join(root, 'upstream')
  for (const path of [home, candidate, sourceRepository]) await mkdir(path, { recursive: true, mode: 0o700 })
  for (const physical of [home, candidate]) for (const kind of kinds) {
    await mkdir(join(physical, kind, profile), { recursive: true, mode: 0o700 })
    await file(join(physical, kind, profile, 'payload.bin'), Buffer.from(physical === home ? [0, 1, 255] : [0, 42, 254]))
    await mkdir(join(physical, kind, profile, 'empty'), { mode: 0o700 })
  }
  const makeCohort = (physical: string, version: string): RsiLocalCohort => JSON.parse(encode({
    schemaVersion: 1, root: join(physical, kinds[0], profile), sourceCommit: 'a'.repeat(40), version,
    sourceRepository: physical === home ? sourceRepository : join(preparationRoot, 'source', 'checkout'),
    allowBuilds: { koffi: true }, bundles: ['target'], packages: [{ name: '@dsh-enhanced/target',
      path: 'plugins/target', bundle: true, runtimeDependencies: [],
      tarball: join(physical, kinds[0], profile, 'artifacts', 'target.tgz'), sha256: hash('tarball'),
      files: [{ path: 'lib/index.js', mode: 0o644, sha256: hash('export {}') }] }],
  })) as RsiLocalCohort
  const originalCohort = makeCohort(home, '0.1.48'), cohort = makeCohort(candidate, '0.1.49')
  for (const item of [originalCohort, cohort]) {
    await file(join(item.root, 'receipt.json'), JSON.stringify(item))
    await file(join(item.root, 'artifacts', 'target.tgz'), 'tarball')
  }
  const build: RsiBuildEnvironment = { schemaVersion: 1, sourceCommit: cohort.sourceCommit, sourceBuild: {
    dockerPath: '/usr/bin/docker', image: `sha256:${'b'.repeat(64)}`, timeoutMs: 1000,
    memoryMiB: 128, cpus: 1, pidsLimit: 32, workspaceMiB: 128, outputBytes: 65536,
    profile: 'repository', repositorySandbox: { seccompPath: join(candidate, kinds[1], profile, 'seccomp.json') },
  } }
  const releaseRoot = join(candidate, kinds[2], profile)
  const pin = (path: string) => ({ path, sha256: hash(path) })
  const releaseBuild: RsiReleaseBuildEnvironment = { schemaVersion: 1, sourceCommit: cohort.sourceCommit,
    image: build.sourceBuild.image, releaseBuild: {
      sandboxExecutable: pin('/usr/bin/bwrap'), tarExecutable: pin('/usr/bin/tar'),
      nodeExecutable: pin(join(releaseRoot, 'toolchain', 'node')),
      pnpmExecutable: pin(join(releaseRoot, 'toolchain', 'pnpm')),
      pnpmRoot: pin(join(releaseRoot, 'toolchain')), storeRoot: pin(join(releaseRoot, 'store')),
      cacheRoot: pin(join(releaseRoot, 'cache')),
    } }
  for (const physical of [home, candidate]) {
    await file(join(physical, kinds[1], profile, 'seccomp.json'), '{"syscalls":[]}')
    await file(join(physical, kinds[1], profile, 'bootstrap.json'), encode({ ...build,
      dshHome: physical, profile, repository: join(physical, 'rsi-sources', profile, 'checkout'), retained: 'source metadata' }))
    await file(join(physical, kinds[2], profile, 'bootstrap.json'), encode({ ...releaseBuild,
      dshHome: physical, profile, retained: 'release metadata' }))
    await file(join(physical, kinds[2], profile, 'toolchain', 'node'), '#!/bin/sh\nexit 0\n', 0o700)
    await file(join(physical, kinds[2], profile, 'toolchain', 'pnpm'), '#!/bin/sh\nexit 0\n', 0o500)
    for (const name of ['store', 'cache']) await mkdir(join(physical, kinds[2], profile, name), { mode: 0o700 })
    await file(join(physical, 'profiles', profile, 'owner.json'), 'owner authority must survive')
    await file(join(physical, 'rsi-local-cohorts', 'other', 'keep'), 'other profile must survive')
  }
  await cp(home, stage, { recursive: true })
  const prepared: RsiLocalUpdatePreparation = {
    schemaVersion: 1, mode: 'prepared', dshHome: home, profile, root: preparationRoot, candidateHome: candidate,
    originalCohortDigest: originalCohort.receiptDigest, cohort, build: { sourceBuild: build, releaseBuild },
    source: { schemaVersion: 1, root: join(preparationRoot, 'source'),
      repository: join(preparationRoot, 'source', 'checkout'), version: cohort.version,
      sourceCommit: cohort.sourceCommit, sourceTree: 'c'.repeat(40), candidateConfigDigest: 'd'.repeat(64),
      upstreamCommit: 'e'.repeat(40), repairCommit: 'f'.repeat(40), originalBootstrapDigest: '1'.repeat(64),
      originalCohortDigest: originalCohort.receiptDigest, receiptDigest: '2'.repeat(64) },
    receiptDigest: '3'.repeat(64),
  }
  reader.mockResolvedValue(prepared)
  const input = { logicalHome: home, stagePhysicalHome: stage, profile, preparationRoot }
  return { root, home, stage, candidate, sourceRepository, prepared, input }
}

describe('stopped local update resource migration', () => {
  test('rejects using the upstream repository as the disposable stage', async () => {
    const f = await fixture()
    await cp(f.home, f.sourceRepository, { recursive: true })
    const before = await snapshot(f.sourceRepository)
    await expect(stageRsiLocalUpdateResources({ ...f.input, stagePhysicalHome: f.sourceRepository }))
      .rejects.toThrow('stage overlaps upstream source repository')
    expect(await snapshot(f.sourceRepository)).toEqual(before)
  })

  test('replaces exactly three resource trees, rebases logical paths, preserves bytes/modes and binds independent inventories', async () => {
    const f = await fixture(), original = await snapshot(f.home), candidate = await snapshot(f.candidate)
    const result = await stageRsiLocalUpdateResources(f.input)
    expect(result.cohort.root).toBe(join(f.home, kinds[0], profile))
    expect(result.cohort.sourceRepository).toBe(f.sourceRepository)
    expect(result.cohort.packages[0]!.tarball).toBe(join(f.home, kinds[0], profile, 'artifacts', 'target.tgz'))
    expect(result.cohort.packages[0]!.sha256).toBe(hash(await readFile(join(f.stage, kinds[0], profile, 'artifacts', 'target.tgz'))))
    expect(result.sourceBuild.sourceBuild.repositorySandbox!.seccompPath).toBe(join(f.home, kinds[1], profile, 'seccomp.json'))
    for (const [key, oldPin] of Object.entries(f.prepared.build!.releaseBuild.releaseBuild)) {
      const next = result.releaseBuild.releaseBuild[key as keyof RsiReleaseBuildEnvironment['releaseBuild']]
      expect(next.sha256).toBe(oldPin.sha256)
      expect(next.path).toBe(oldPin.path.startsWith(f.candidate + '/') ? oldPin.path.replace(f.candidate, f.home) : oldPin.path)
    }
    for (const kind of kinds) {
      const base = join(f.stage, kind, profile), name = kind === kinds[0] ? 'receipt.json' : 'bootstrap.json'
      const receipt = JSON.parse(await readFile(join(base, name), 'utf8')) as Record<string, unknown>
      const { receiptDigest, ...body } = receipt
      expect(receiptDigest).toBe(hash(JSON.stringify(body)))
      expect(JSON.stringify(body)).not.toContain(f.candidate)
      expect(JSON.stringify(body)).not.toContain(f.stage)
      expect(await readFile(join(base, 'payload.bin'))).toEqual(Buffer.from([0, 42, 254]))
      expect(result.proof.original[kind]).toBe(hash(JSON.stringify(await snapshot(join(f.home, kind, profile)))))
      expect(result.proof.candidate[kind]).toBe(hash(JSON.stringify(await snapshot(base))))
    }
    const buildReceipt = JSON.parse(await readFile(join(f.stage, kinds[1], profile, 'bootstrap.json'), 'utf8'))
    expect(buildReceipt).toMatchObject({ dshHome: f.home, repository: join(f.home, 'rsi-sources', profile, 'checkout'), retained: 'source metadata' })
    expect(JSON.parse(await readFile(join(f.stage, kinds[2], profile, 'bootstrap.json'), 'utf8')))
      .toMatchObject({ dshHome: f.home, retained: 'release metadata' })
    expect((await lstat(join(f.stage, kinds[2], profile, 'toolchain', 'node'))).mode & 0o777).toBe(0o700)
    expect((await lstat(join(f.stage, kinds[2], profile, 'toolchain', 'pnpm'))).mode & 0o777).toBe(0o500)
    expect(await snapshot(f.home)).toEqual(original); expect(await snapshot(f.candidate)).toEqual(candidate)
    expect(await readFile(join(f.stage, 'profiles', profile, 'owner.json'), 'utf8')).toBe('owner authority must survive')
    expect(await readFile(join(f.stage, kinds[0], 'other', 'keep'), 'utf8')).toBe('other profile must survive')
    expect((await readdir(f.stage)).some(name => name.startsWith('.rsi-local-resources-'))).toBe(false)
    expect(result.proof).toMatchObject({ schemaVersion: 1, dshHome: f.home, profile, preparationDigest: f.prepared.receiptDigest })
    await verifyRsiLocalUpdateResources({ physicalHome: f.stage, proof: result.proof })
    await verifyRsiLocalUpdateResources({ physicalHome: f.home, proof: result.proof, original: true })
    await expect(verifyRsiLocalUpdateResources({ physicalHome: f.stage, proof: result.proof, original: true })).rejects.toThrow('resource proof differs')
    const migrated = await snapshot(f.stage)
    await expect(stageRsiLocalUpdateResources(f.input)).rejects.toThrow('copied original differs')
    expect(await snapshot(f.stage)).toEqual(migrated)
  })

  test.each(['same', 'inside-home', 'contains-home', 'inside-preparation', 'contains-preparation', 'symlink', 'noncanonical'] as const)
    ('rejects a %s stage before changing resources', async (layout) => {
      const f = await fixture(), original = await snapshot(f.home), candidate = await snapshot(f.candidate)
      let stage = f.stage
      if (layout === 'same') stage = f.home
      if (layout === 'inside-home') { stage = join(f.home, 'nested'); await mkdir(stage, { mode: 0o700 }) }
      if (layout === 'contains-home') stage = f.root
      if (layout === 'contains-preparation') stage = f.prepared.root
      if (layout === 'inside-preparation') stage = f.candidate
      if (layout === 'symlink') { stage = join(f.root, 'stage-alias'); await symlink(f.stage, stage) }
      if (layout === 'noncanonical') stage = f.stage + '/.'
      const before = await snapshot(f.stage)
      await expect(stageRsiLocalUpdateResources({ ...f.input, stagePhysicalHome: stage })).rejects.toThrow(/distinct canonical stopped Home|overlaps preparation/u)
      expect(await snapshot(f.stage)).toEqual(before)
      if (layout !== 'inside-home') expect(await snapshot(f.home)).toEqual(original)
      expect(await snapshot(f.candidate)).toEqual(candidate)
    })

  test.each(['symlink', 'hardlink', 'public-file', 'public-directory'] as const)
    ('refuses candidate %s entries without replacing any stage tree', async (unsafe) => {
      const f = await fixture(), before = await snapshot(f.stage), base = join(f.candidate, kinds[2], profile)
      if (unsafe === 'symlink') await symlink(join(f.home, kinds[2], profile, 'payload.bin'), join(base, 'unsafe'))
      if (unsafe === 'hardlink') await link(join(base, 'payload.bin'), join(base, 'unsafe'))
      if (unsafe === 'public-file') await chmod(join(base, 'payload.bin'), 0o644)
      if (unsafe === 'public-directory') await chmod(join(base, 'empty'), 0o755)
      await expect(stageRsiLocalUpdateResources(f.input)).rejects.toThrow(/unsafe resource entry|private regular file/u)
      expect(await snapshot(f.stage)).toEqual(before)
      expect((await readdir(f.stage)).some(name => name.startsWith('.rsi-local-resources-'))).toBe(false)
    })

  test.each(['bytes', 'mode'] as const)('refuses a copied stage with different original %s', async (difference) => {
    const f = await fixture(), original = await snapshot(f.home), candidate = await snapshot(f.candidate)
    const target = join(f.stage, kinds[1], profile, 'payload.bin')
    if (difference === 'bytes') await file(target, 'bad stage copy')
    else await chmod(target, 0o500)
    const before = await snapshot(f.stage)
    await expect(stageRsiLocalUpdateResources(f.input)).rejects.toThrow('copied original differs')
    expect(await snapshot(f.stage)).toEqual(before)
    expect(await snapshot(f.home)).toEqual(original); expect(await snapshot(f.candidate)).toEqual(candidate)
  })

  test('refuses a preparation bound to a different original cohort', async () => {
    const f = await fixture(), before = await snapshot(f.stage)
    reader.mockResolvedValue({ ...f.prepared, originalCohortDigest: '0'.repeat(64) })
    await expect(stageRsiLocalUpdateResources(f.input)).rejects.toThrow('original cohort source differs')
    expect(await snapshot(f.stage)).toEqual(before)
  })

  test('an already cancelled call leaves every tree unchanged', async () => {
    const f = await fixture(), before = await snapshot(f.stage), original = await snapshot(f.home), candidate = await snapshot(f.candidate)
    const controller = new AbortController(); controller.abort(new Error('cancelled before migration'))
    await expect(stageRsiLocalUpdateResources({ ...f.input, signal: controller.signal })).rejects.toThrow('cancelled before migration')
    expect(await snapshot(f.stage)).toEqual(before)
    expect(await snapshot(f.home)).toEqual(original); expect(await snapshot(f.candidate)).toEqual(candidate)
  })

  test.each(['stage', 'original', 'preparation', 'candidate-copy'] as const)
    ('detects %s drift before resource replacement', async (drift) => {
      const f = await fixture(), before = await snapshot(f.stage)
      let expected = /changed during copy|original resource changed/u
      if (drift === 'stage' || drift === 'original') {
        reader.mockImplementationOnce(async () => f.prepared).mockImplementationOnce(async () => {
          await file(join(drift === 'stage' ? f.stage : f.home, kinds[1], profile, 'payload.bin'), 'late edit')
          return f.prepared
        })
      } else if (drift === 'preparation') {
        reader.mockResolvedValueOnce(f.prepared).mockResolvedValueOnce({ ...f.prepared, receiptDigest: '4'.repeat(64) })
        expected = /preparation changed during copy/u
      } else {
        const read = io.readStable, target = join(f.candidate, kinds[0], profile, 'payload.bin')
        let changed = false
        vi.spyOn(io, 'readStable').mockImplementation(async (...args) => {
          const bytes = await read(...args)
          if (args[0] === target && !changed) { changed = true; await file(target, 'late edit') }
          return bytes
        })
      }
      await expect(stageRsiLocalUpdateResources(f.input)).rejects.toThrow(expected)
      if (drift !== 'stage') expect(await snapshot(f.stage)).toEqual(before)
      else expect(await readFile(join(f.stage, kinds[0], profile, 'payload.bin'))).toEqual(Buffer.from([0, 1, 255]))
      expect((await readdir(f.stage)).some(name => name.startsWith('.rsi-local-resources-'))).toBe(false)
    })

  test.each([1, 2, 3])('restores all original stage trees after the %s replacement fsync fails', async (failAt) => {
    const f = await fixture(), before = await snapshot(f.stage), original = await snapshot(f.home), candidate = await snapshot(f.candidate)
    const sync = io.syncDirectory
    let calls = 0
    vi.spyOn(io, 'syncDirectory').mockImplementation(async path => {
      if (++calls === failAt) throw new Error('injected fsync failure')
      await sync(path)
    })
    await expect(stageRsiLocalUpdateResources(f.input)).rejects.toThrow('injected fsync failure')
    expect(await snapshot(f.stage)).toEqual(before)
    expect(await snapshot(f.home)).toEqual(original); expect(await snapshot(f.candidate)).toEqual(candidate)
    expect((await readdir(f.stage)).some(name => name.startsWith('.rsi-local-resources-'))).toBe(false)
    vi.restoreAllMocks()
    await stageRsiLocalUpdateResources(f.input)
  })

  test('cancellation after the first replacement restores the stage', async () => {
    const f = await fixture(), before = await snapshot(f.stage), controller = new AbortController(), sync = io.syncDirectory
    vi.spyOn(io, 'syncDirectory').mockImplementation(async path => {
      await sync(path); controller.abort(new Error('owner cancelled'))
    })
    await expect(stageRsiLocalUpdateResources({ ...f.input, signal: controller.signal })).rejects.toThrow('owner cancelled')
    expect(await snapshot(f.stage)).toEqual(before)
  })

  test('a failed restore retains scratch evidence and surfaces the recovery failure', async () => {
    const f = await fixture(), original = await snapshot(f.home), candidate = await snapshot(f.candidate)
    let calls = 0
    vi.spyOn(io, 'syncDirectory').mockImplementation(async () => {
      throw new Error(++calls === 1 ? 'replacement failed' : 'recovery failed')
    })
    await expect(stageRsiLocalUpdateResources(f.input)).rejects.toThrow('recovery failed')
    const scratch = (await readdir(f.stage)).filter(name => name.startsWith('.rsi-local-resources-'))
    expect(scratch).toHaveLength(1)
    expect(await readdir(join(f.stage, scratch[0]!))).toContain(kinds[1])
    expect(await snapshot(f.home)).toEqual(original); expect(await snapshot(f.candidate)).toEqual(candidate)
  })

  test.each(['bytes', 'executable-mode', 'directory-mode', 'empty-directory', 'proof-hash', 'proof-binding'] as const)
    ('verification rejects %s drift without mutating the tree', async (drift) => {
      const f = await fixture(), { proof } = await stageRsiLocalUpdateResources(f.input)
      const base = join(f.stage, kinds[2], profile)
      if (drift === 'bytes') await file(join(base, 'payload.bin'), 'changed')
      if (drift === 'executable-mode') await chmod(join(base, 'toolchain', 'node'), 0o600)
      if (drift === 'directory-mode') await chmod(join(base, 'empty'), 0o500)
      if (drift === 'empty-directory') await mkdir(join(base, 'extra'), { mode: 0o700 })
      if (drift === 'proof-hash') proof.candidate[kinds[2]] = '0'.repeat(64)
      if (drift === 'proof-binding') proof.preparationDigest = 'invalid'
      const before = await snapshot(f.stage)
      await expect(verifyRsiLocalUpdateResources({ physicalHome: f.stage, proof })).rejects.toThrow(/resource proof differs|invalid resource proof binding/u)
      expect(await snapshot(f.stage)).toEqual(before)
    })

  test.each(['source-digest', 'build-digest', 'release-digest', 'missing-build'] as const)
    ('rejects an invalid %s before creating replacement trees', async (invalid) => {
      const f = await fixture(), before = await snapshot(f.stage)
      if (invalid === 'missing-build') reader.mockResolvedValue({ ...f.prepared, build: null })
      else {
        const home = invalid === 'source-digest' ? f.home : f.candidate
        const kind = invalid === 'source-digest' ? kinds[0] : invalid === 'build-digest' ? kinds[1] : kinds[2]
        const path = join(home, kind, profile, invalid === 'source-digest' ? 'receipt.json' : 'bootstrap.json')
        const receipt = JSON.parse(await readFile(path, 'utf8'))
        receipt.receiptDigest = '0'.repeat(64)
        await file(path, JSON.stringify(receipt))
        if (invalid === 'source-digest') await cp(path, join(f.stage, kind, profile, 'receipt.json'))
      }
      const attempted = await snapshot(f.stage)
      await expect(stageRsiLocalUpdateResources(f.input)).rejects.toThrow(/resource receipt digest differs|stage overlaps preparation/u)
      expect(await snapshot(f.stage)).toEqual(invalid === 'source-digest' ? attempted : before)
      expect((await readdir(f.stage)).some(name => name.startsWith('.rsi-local-resources-'))).toBe(false)
    })
})
