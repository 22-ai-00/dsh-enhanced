import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { migratePreOwnerCreationBuild, moveDirectoryNoReplace } from '../scripts/install/creation-build-migration.mjs'

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const oldCommit = '1'.repeat(40)
const newCommit = '2'.repeat(40)
const oldImage = `sha256:${'3'.repeat(64)}`
const newImage = `sha256:${'4'.repeat(64)}`
const sourceImage = `sha256:${'5'.repeat(64)}`
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'creation-build-migration-')))
  roots.push(root)
  const homePath = join(root, 'home'), archiveRoot = join(root, '.dsh-rsi-creation-build-migration-fixture01')
  const installerRoot = join(root, 'reviewed'), profile = 'assistant'
  const original = join(homePath, 'rsi-creation-builds', profile)
  const authority = join(homePath, 'rsi-authorities', profile)
  for (const path of [homePath, installerRoot, original,
    join(authority, 'config'), join(authority, 'registry'),
    join(authority, 'state', 'creation-adoption-runner'),
    join(authority, 'state', 'creation-review-runner')]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
  }
  const source = { workspace: { schemaVersion: 1, sourceCommit: newCommit,
    repository: join(homePath, 'rsi-sources', profile, 'checkout'),
    origin: { kind: 'local-head', locator: join(root, 'source-checkout'), ref: 'HEAD' } },
  anchor: { baseline: { initialCommit: oldCommit }, installationId: 'installation' },
  records: [{ previousTip: oldCommit, candidateTip: newCommit, before: { sourceCommit: oldCommit } }] }
  const build = { schemaVersion: 1, sourceCommit: newCommit,
    sourceBuild: { image: sourceImage, dockerPath: '/usr/bin/docker' } }
  const oldContent = { schemaVersion: 1, sourceCommit: oldCommit, sourceImage: `sha256:${'6'.repeat(64)}`,
    image: oldImage, dockerPath: '/usr/bin/docker', dshHome: homePath, profile,
    dockerSha256: '7'.repeat(64), inputHashes: { 'package.json': '8'.repeat(64) },
    contextFiles: ['package.json'], contextDigest: '9'.repeat(64), lockSha256: 'a'.repeat(64) }
  const oldBytes = Buffer.from(JSON.stringify({ ...oldContent, receiptDigest: sha256(JSON.stringify(oldContent)) }))
  await writeFile(join(original, 'bootstrap.json'), oldBytes, { mode: 0o600 })
  const created = { schemaVersion: 1, sourceCommit: newCommit, sourceImage, image: newImage,
    dockerPath: '/usr/bin/docker' }
  const preOwner = { mode: 'pre-owner', preparedCoordinator: { profile: 'coordinator' },
    anchor: source.anchor, records: source.records, workspace: source.workspace, sourceChainTip: newCommit }
  const api = {
    withDshHomeLifecycleLock: vi.fn(async (_home: string, operation: () => Promise<unknown>) => operation()),
    assertRsiPreOwnerInstallation: vi.fn(async () => preOwner),
    readRsiSourceMaintenance: vi.fn(async () => source),
    readRsiSourceWorkspace: vi.fn(async () => source.workspace),
    readRsiBuildEnvironment: vi.fn(async () => build),
    prepareRsiCreationBuildEnvironment: vi.fn(async () => {
      if (!await lstat(original).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
        await mkdir(original, { mode: 0o700 })
        await writeFile(join(original, 'bootstrap.json'), JSON.stringify(created), { mode: 0o600 })
      }
      return created
    }),
    readRsiCreationBuildEnvironment: vi.fn(async () => {
      await lstat(join(original, 'bootstrap.json'))
      return created
    }),
  }
  const binding = { root: installerRoot, dev: '1', ino: '2', digest: 'b'.repeat(64), entries: 10 }
  const seams = { bindInstaller: vi.fn(async () => binding), assertInstaller: vi.fn(async () => undefined),
    loadApi: vi.fn(async () => api), ancestor: vi.fn(() => undefined) }
  const input = { homePath, archiveRoot, installerRoot, profile }
  return { root, homePath, archiveRoot, original, authority, profile, input, seams, api, source,
    oldBytes, oldContent, created }
}

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('pre-owner creation build migration', () => {
test('archives the exact old receipt and creates only the native successor; retry only reads it', async () => {
  const setup = await fixture()
  const first = await migratePreOwnerCreationBuild(setup.input, setup.seams)
  expect(first.previous).toEqual({ sourceCommit: oldCommit, sourceImage: setup.oldContent.sourceImage,
    image: oldImage, receiptSha256: sha256(setup.oldBytes),
    receiptDigest: sha256(JSON.stringify(setup.oldContent)) })
  expect(first.creationBuild).toEqual(setup.created)
  expect(await readFile(join(setup.archiveRoot, 'legacy', 'bootstrap.json'))).toEqual(setup.oldBytes)
  expect((await lstat(setup.archiveRoot)).mode & 0o777).toBe(0o700)
  expect((await lstat(join(setup.archiveRoot, 'journal.json'))).mode & 0o777).toBe(0o600)
  expect(await readdir(setup.archiveRoot)).toEqual(['journal.json', 'legacy'])
  expect(await migratePreOwnerCreationBuild(setup.input, setup.seams)).toEqual(first)
  expect(setup.api.prepareRsiCreationBuildEnvironment).toHaveBeenCalledTimes(2)
  expect(setup.api.readRsiCreationBuildEnvironment).toHaveBeenCalledTimes(3)
  expect(setup.api.withDshHomeLifecycleLock).toHaveBeenCalledTimes(2)
})

test('resumes an archived journal after native preparation fails without deleting the archive', async () => {
  const setup = await fixture()
  setup.api.prepareRsiCreationBuildEnvironment.mockRejectedValueOnce(new Error('builder unavailable'))
  await expect(migratePreOwnerCreationBuild(setup.input, setup.seams)).rejects.toThrow('builder unavailable')
  expect(await readFile(join(setup.archiveRoot, 'legacy', 'bootstrap.json'))).toEqual(setup.oldBytes)
  const journal = JSON.parse(await readFile(join(setup.archiveRoot, 'journal.json'), 'utf8'))
  expect(journal.state).toBe('archived')
  await migratePreOwnerCreationBuild(setup.input, setup.seams)
  expect(setup.api.prepareRsiCreationBuildEnvironment).toHaveBeenCalledTimes(2)
})

test('resumes archived intent before the old directory is moved', async () => {
  const setup = await fixture()
  setup.api.prepareRsiCreationBuildEnvironment.mockRejectedValueOnce(new Error('builder unavailable'))
  await expect(migratePreOwnerCreationBuild(setup.input, setup.seams)).rejects.toThrow('builder unavailable')
  await (await import('node:fs/promises')).rename(join(setup.archiveRoot, 'legacy'), setup.original)
  await migratePreOwnerCreationBuild(setup.input, setup.seams)
  expect(await readFile(join(setup.archiveRoot, 'legacy', 'bootstrap.json'))).toEqual(setup.oldBytes)
})

test('rejects wrong owner, active owner state, and unknown runner entries before archiving', async () => {
  const wrong = await fixture()
  const receipt = JSON.parse(wrong.oldBytes.toString('utf8'))
  receipt.profile = 'other'
  await writeFile(join(wrong.original, 'bootstrap.json'), JSON.stringify(receipt), { mode: 0o600 })
  await expect(migratePreOwnerCreationBuild(wrong.input, wrong.seams)).rejects.toThrow('legacy receipt differs')
  expect(await lstat(wrong.archiveRoot).catch(() => null)).toBeNull()

  const active = await fixture()
  await writeFile(join(active.authority, 'config', 'owner.json'), '{}', { mode: 0o600 })
  await expect(migratePreOwnerCreationBuild(active.input, active.seams)).rejects.toThrow('owner config is not empty')
  expect(await lstat(active.archiveRoot).catch(() => null)).toBeNull()

  const unknown = await fixture()
  await mkdir(join(unknown.authority, 'state', 'unrecognized'), { mode: 0o700 })
  await expect(migratePreOwnerCreationBuild(unknown.input, unknown.seams)).rejects.toThrow('owner state inventory differs')
})

test('rejects absent or altered signed history and old receipt drift', async () => {
  const history = await fixture()
  history.source.records.splice(0)
  history.source.anchor.baseline.initialCommit = 'f'.repeat(40)
  await expect(migratePreOwnerCreationBuild(history.input, history.seams)).rejects.toThrow('absent from signed history')
  expect(history.seams.ancestor).not.toHaveBeenCalled()

  const ancestor = await fixture()
  ancestor.seams.ancestor.mockImplementation(() => { throw new Error('not a Git ancestor') })
  await expect(migratePreOwnerCreationBuild(ancestor.input, ancestor.seams)).rejects.toThrow('not a Git ancestor')
  expect(await lstat(ancestor.archiveRoot).catch(() => null)).toBeNull()

  const drift = await fixture()
  drift.api.prepareRsiCreationBuildEnvironment.mockRejectedValueOnce(new Error('builder unavailable'))
  await expect(migratePreOwnerCreationBuild(drift.input, drift.seams)).rejects.toThrow('builder unavailable')
  await writeFile(join(drift.archiveRoot, 'legacy', 'bootstrap.json'), 'changed', { mode: 0o600 })
  await expect(migratePreOwnerCreationBuild(drift.input, drift.seams)).rejects.toThrow('legacy receipt')
})

test('rejects an unknown archive, absent original without journal, and journal binding changes', async () => {
  const unknown = await fixture()
  await mkdir(unknown.archiveRoot, { mode: 0o700 })
  await writeFile(join(unknown.archiveRoot, 'unrelated'), 'x', { mode: 0o600 })
  await expect(migratePreOwnerCreationBuild(unknown.input, unknown.seams)).rejects.toThrow('archive contains unknown state')

  const missing = await fixture()
  await rm(missing.original, { recursive: true })
  await expect(migratePreOwnerCreationBuild(missing.input, missing.seams)).rejects.toThrow('creation build inventory differs')

  const changed = await fixture()
  changed.api.prepareRsiCreationBuildEnvironment.mockRejectedValueOnce(new Error('builder unavailable'))
  await expect(migratePreOwnerCreationBuild(changed.input, changed.seams)).rejects.toThrow('builder unavailable')
  changed.seams.bindInstaller.mockResolvedValue({ root: changed.input.installerRoot, dev: '1', ino: '2',
    digest: 'c'.repeat(64), entries: 10 })
  await expect(migratePreOwnerCreationBuild(changed.input, changed.seams)).rejects.toThrow('journal binding differs')
})

test('refuses an unclaimed new directory and preserves it', async () => {
  const setup = await fixture()
  setup.api.prepareRsiCreationBuildEnvironment.mockRejectedValueOnce(new Error('builder unavailable'))
  await expect(migratePreOwnerCreationBuild(setup.input, setup.seams)).rejects.toThrow('builder unavailable')
  await mkdir(setup.original, { mode: 0o700 })
  await writeFile(join(setup.original, 'unknown'), 'unclaimed', { mode: 0o600 })
  setup.api.readRsiCreationBuildEnvironment.mockRejectedValueOnce(new Error('native receipt invalid'))
  await expect(migratePreOwnerCreationBuild(setup.input, setup.seams)).rejects.toThrow('native receipt invalid')
  expect(await readFile(join(setup.original, 'unknown'), 'utf8')).toBe('unclaimed')
  expect(setup.api.prepareRsiCreationBuildEnvironment).toHaveBeenCalledTimes(1)
})

test('renameat2 refuses an existing empty archive destination without deleting either directory', async () => {
  const setup = await fixture()
  await mkdir(setup.archiveRoot, { mode: 0o700 })
  const destination = join(setup.archiveRoot, 'legacy')
  await mkdir(destination, { mode: 0o700 })
  const source = await lstat(setup.original), sourceParent = await lstat(dirname(setup.original))
  const destinationParent = await lstat(setup.archiveRoot)
  const identity = (item: { dev: number; ino: number }) => ({ dev: String(item.dev), ino: String(item.ino) })
  expect(() => moveDirectoryNoReplace(setup.original, destination, identity(source),
    identity(sourceParent), identity(destinationParent))).toThrow('cannot move legacy directory without replacement')
  expect(await readFile(join(setup.original, 'bootstrap.json'))).toEqual(setup.oldBytes)
  expect(await readdir(destination)).toEqual([])
})

test('resumes a native receipt created before journal completion without rebuilding', async () => {
  const setup = await fixture()
  setup.api.readRsiCreationBuildEnvironment.mockRejectedValueOnce(new Error('crash after native prepare'))
  await expect(migratePreOwnerCreationBuild(setup.input, setup.seams)).rejects.toThrow('crash after native prepare')
  expect(JSON.parse(await readFile(join(setup.archiveRoot, 'journal.json'), 'utf8')).state).toBe('archived')
  const existing = await readFile(join(setup.original, 'bootstrap.json'))
  await migratePreOwnerCreationBuild(setup.input, setup.seams)
  expect(await readFile(join(setup.original, 'bootstrap.json'))).toEqual(existing)
  expect(JSON.parse(await readFile(join(setup.archiveRoot, 'journal.json'), 'utf8')).state).toBe('completed')
})

test('completed journal never recreates a missing native receipt', async () => {
  const setup = await fixture()
  await migratePreOwnerCreationBuild(setup.input, setup.seams)
  await rm(setup.original, { recursive: true })
  await expect(migratePreOwnerCreationBuild(setup.input, setup.seams)).rejects.toThrow('completed native creation receipt is missing')
  expect(setup.api.prepareRsiCreationBuildEnvironment).toHaveBeenCalledTimes(1)
})

test('rejects signed source failure and post-archive build drift', async () => {
  const signature = await fixture()
  signature.api.readRsiSourceMaintenance.mockRejectedValueOnce(new Error('signed history invalid'))
  await expect(migratePreOwnerCreationBuild(signature.input, signature.seams)).rejects.toThrow('signed history invalid')
  expect(await lstat(signature.archiveRoot).catch(() => null)).toBeNull()

  const changed = await fixture()
  changed.api.prepareRsiCreationBuildEnvironment.mockRejectedValueOnce(new Error('builder unavailable'))
  await expect(migratePreOwnerCreationBuild(changed.input, changed.seams)).rejects.toThrow('builder unavailable')
  changed.api.readRsiBuildEnvironment.mockResolvedValue({ schemaVersion: 1, sourceCommit: newCommit,
    sourceBuild: { image: `sha256:${'f'.repeat(64)}`, dockerPath: '/usr/bin/docker' } })
  await expect(migratePreOwnerCreationBuild(changed.input, changed.seams)).rejects.toThrow('journal binding differs')
})
})

test('CLI rejects incomplete invocation with exit code 2', () => {
  const file = join(dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'install', 'creation-build-migration.mjs')
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  expect(result.status).toBe(2)
  expect(result.stderr).toMatch(/usage: node creation-build-migration/u)
})
