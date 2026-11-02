import { chmod, cp, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { stageLinuxRsiPreOwnerNativeResources, verifyLinuxRsiPreOwnerNativeResources } from '../src/rsi-linux-native-resources.js'
import type { RsiLocalUpdatePreparation } from '../src/rsi-local-update.js'
import type { LinuxRsiNativeBaseRelocationProof } from '../src/rsi-linux-native-relocation.js'

// Narrow seams for independently verified readers/relocation only. Cohort
// bytes, inventories, renames and rollback below are actual filesystem effects.
// These tests do not claim real native runtime or live-Home acceptance.
const faults = vi.hoisted(() => ({ cleanup: false, replaceLink: undefined as string | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: async (path: Parameters<typeof actual.rm>[0], options: Parameters<typeof actual.rm>[1]) => {
    if (faults.cleanup && basename(String(path)).startsWith('.rsi-pre-owner-native-')) {
      faults.cleanup = false
      await actual.rm(join(String(path), 'rsi-release-builds'), { recursive: true, force: true })
      throw Object.assign(new Error('fixture cleanup failed after partial backup deletion'), { code: 'EIO' })
    }
    return actual.rm(path, options)
  }, readlink: async (path: Parameters<typeof actual.readlink>[0]) => {
    const target = await actual.readlink(path)
    if (String(path) === faults.replaceLink) {
      faults.replaceLink = undefined
      await actual.rm(path); await actual.symlink(target, path)
    }
    return target
  } }
})
const ports = vi.hoisted(() => ({ preparation: vi.fn(), source: vi.fn(), build: vi.fn(), release: vi.fn(), relocate: vi.fn(), open: vi.fn(), openAt: vi.fn() }))
vi.mock('../src/rsi-local-update.js', () => ({ readRsiLocalUpdateLocked: ports.preparation }))
vi.mock('../src/rsi-source.js', () => ({ readRsiSourceWorkspace: ports.source }))
vi.mock('../src/rsi-local-update-build.js', () => ({ readRsiLocalUpdateSourceBuild: ports.build }))
vi.mock('../src/rsi-release-build.js', () => ({ readRsiReleaseBuildEnvironment: ports.release }))
vi.mock('../src/rsi-linux-native-relocation.js', async original => ({ ...await original<typeof import('../src/rsi-linux-native-relocation.js')>(),
  relocateLinuxRsiNativeBase: ports.relocate, openLinuxRsiNativeRelocatedBase: ports.open, openLinuxRsiNativeRelocatedBaseAt: ports.openAt }))
const roots: string[] = [], OLD = '1'.repeat(40), NEXT = '2'.repeat(40), PROFILE = 'web'
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function directory(path: string) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700) }
async function write(path: string, value: string) { await writeFile(path, value, { mode: 0o600 }) }
async function cohort(path: string, logical: string, repository: string, commit: string, content: string) {
  await directory(join(path, 'artifacts')); await write(join(path, 'artifacts', 'demo.tgz'), content)
  const body = { schemaVersion: 1, root: logical, sourceRepository: repository, sourceCommit: commit, version: '0.1.65',
    bundles: ['demo'], allowBuilds: {}, packages: [{ name: '@dsh-enhanced/demo', tarball: join(logical, 'artifacts/demo.tgz'), sha256: sha(content) }] }
  const result = { ...body, receiptDigest: sha(JSON.stringify(body)) }; await write(join(path, 'receipt.json'), JSON.stringify(result)); return result
}
beforeEach(() => { for (const port of Object.values(ports)) port.mockReset(); faults.cleanup = false; faults.replaceLink = undefined })
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(backend: 'docker' | 'linux-native' = 'docker') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pre-owner-base-'))); roots.push(root)
  const logicalHome = join(root, 'live'), stagePhysicalHome = join(root, 'stage'), preparationRoot = join(root, 'preparation'), candidate = join(preparationRoot, 'home'), upstream = join(root, 'upstream')
  for (const path of [logicalHome, stagePhysicalHome, preparationRoot, candidate, upstream]) await directory(path)
  const cohortPath = join(logicalHome, 'rsi-local-cohorts', PROFILE), original = await cohort(cohortPath, cohortPath, upstream, OLD, 'old-artifact')
  const oldKind = backend === 'docker' ? 'rsi-builds' : 'rsi-linux-runtimes'
  for (const kind of [oldKind, 'rsi-release-builds']) { await directory(join(logicalHome, kind, PROFILE)); await write(join(logicalHome, kind, PROFILE, 'bootstrap.json'), `old-${kind}`) }
  await directory(join(logicalHome, 'rsi-authority-runtimes', PROFILE)); await write(join(logicalHome, 'rsi-authority-runtimes', PROFILE, 'unchanged'), 'authority-runtime')
  for (const field of ['config', 'state', 'registry']) await directory(join(logicalHome, 'rsi-authorities', PROFILE, field))
  await write(join(logicalHome, 'rsi-authorities', PROFILE, 'catalog.json'), JSON.stringify({ schemaVersion: 1, entries: [] }))
  await cp(logicalHome, stagePhysicalHome, { recursive: true })
  const preparedCohort = await cohort(join(candidate, 'rsi-local-cohorts', PROFILE), join(candidate, 'rsi-local-cohorts', PROFILE), upstream, NEXT, 'new-artifact')
  for (const kind of ['rsi-linux-runtimes', 'rsi-release-builds']) { await directory(join(candidate, kind, PROFILE)); await write(join(candidate, kind, PROFILE, 'bootstrap.json'), `candidate-${kind}`) }
  const sourceBuild = { schemaVersion: 3, backend: 'linux-native', sourceCommit: NEXT }, releaseBuild = { schemaVersion: 2, backend: 'linux-native', sourceCommit: NEXT }
  const prepared = { schemaVersion: 1, mode: 'prepared', dshHome: logicalHome, profile: PROFILE, root: preparationRoot, candidateHome: candidate,
    originalCohortDigest: original.receiptDigest, source: { sourceCommit: NEXT }, cohort: preparedCohort, build: { sourceBuild, releaseBuild }, receiptDigest: sha('preparation') } as unknown as RsiLocalUpdatePreparation
  const oldSource = { sourceCommit: OLD, maintained: true }
  ports.preparation.mockResolvedValue(prepared); ports.source.mockResolvedValue(oldSource)
  ports.build.mockResolvedValue(backend === 'docker' ? { schemaVersion: 1, sourceCommit: OLD } : { schemaVersion: 3, backend, sourceCommit: OLD })
  ports.release.mockResolvedValue(backend === 'docker' ? { schemaVersion: 1, sourceCommit: OLD } : { schemaVersion: 2, backend, sourceCommit: OLD })
  ports.relocate.mockImplementation(async (input: { sourceHome: string; physicalHome: string; logicalHome: string; profile: string }) => {
    for (const kind of ['rsi-linux-runtimes', 'rsi-release-builds']) {
      await directory(join(input.physicalHome, kind)); await cp(join(input.sourceHome, kind, input.profile), join(input.physicalHome, kind, input.profile), { recursive: true, errorOnExist: true, force: false })
    }
    return { schemaVersion: 1, backend: 'linux-native', purpose: 'pre-owner-base', sourceHome: input.sourceHome, physicalHome: input.physicalHome,
      logicalHome: input.logicalHome, profile: input.profile, elements: [], digests: { runtime: sha('runtime'), release: sha('release'), relocation: sha('relocation') } } as unknown as LinuxRsiNativeBaseRelocationProof
  })
  ports.open.mockResolvedValue({ runtime: sourceBuild, release: releaseBuild }); ports.openAt.mockResolvedValue({ runtime: sourceBuild, release: releaseBuild })
  return { root, input: { logicalHome, stagePhysicalHome, profile: PROFILE, preparationRoot }, prepared, oldKind, oldSource, candidate }
}
async function contents(home: string): Promise<unknown[]> {
  const result: unknown[] = []
  async function visit(path: string, prefix: string) {
    const stat = await lstat(path)
    if (stat.isDirectory()) { result.push([prefix, stat.mode & 0o777]); for (const name of (await readdir(path)).sort()) await visit(join(path, name), prefix ? `${prefix}/${name}` : name) }
    else result.push([prefix, stat.mode & 0o777, await readFile(path, 'utf8')])
  }
  await visit(home, ''); return result
}

describe('pre-owner base-only native resources transaction', () => {
  test.each(['docker', 'linux-native'] as const)('stages %s to native base without owner resources or original/preparation writes', async backend => {
    const f = await fixture(backend), live = await contents(f.input.logicalHome), candidate = await contents(f.candidate)
    const result = await stageLinuxRsiPreOwnerNativeResources(f.input)
    expect(result.proof).toMatchObject({ purpose: 'pre-owner-base', originalBackend: backend, preparationDigest: f.prepared.receiptDigest })
    expect(result.cohort.root).toBe(join(f.input.logicalHome, 'rsi-local-cohorts', PROFILE)); expect(result.cohort.sourceCommit).toBe(NEXT)
    expect(await contents(f.input.logicalHome)).toEqual(live); expect(await contents(f.candidate)).toEqual(candidate)
    expect(await readFile(join(f.input.stagePhysicalHome, 'rsi-authority-runtimes', PROFILE, 'unchanged'), 'utf8')).toBe('authority-runtime')
    expect(ports.build).toHaveBeenCalledWith(expect.objectContaining({ dshHome: f.input.logicalHome, source: f.oldSource }))
    expect(ports.openAt).toHaveBeenLastCalledWith(result.proof.relocation, f.input.stagePhysicalHome)
    expect(await readdir(join(f.input.stagePhysicalHome, 'rsi-builds')).catch(() => [])).toEqual([])
    await verifyLinuxRsiPreOwnerNativeResources({ proof: result.proof, physicalHome: f.input.stagePhysicalHome })
  })
  test('restores stage bytes and cohort/base inodes after failure following a successful cohort swap', async () => {
    const f = await fixture('linux-native'), before = await contents(f.input.stagePhysicalHome)
    const paths = ['rsi-local-cohorts', 'rsi-linux-runtimes', 'rsi-release-builds'].map(kind => join(f.input.stagePhysicalHome, kind, PROFILE))
    const identities = await Promise.all(paths.map(async path => (await lstat(path)).ino))
    ports.preparation.mockResolvedValueOnce(f.prepared).mockResolvedValueOnce(f.prepared).mockResolvedValueOnce({ ...f.prepared, receiptDigest: sha('changed') })
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('preparation changed after base staging')
    expect(await contents(f.input.stagePhysicalHome)).toEqual(before)
    expect(await Promise.all(paths.map(async path => (await lstat(path)).ino))).toEqual(identities)
  })
  test('restores old Docker/release/cohort layout if relocation fails partway', async () => {
    const f = await fixture(), before = await contents(f.input.stagePhysicalHome)
    ports.relocate.mockImplementation(async () => { await directory(join(f.input.stagePhysicalHome, 'rsi-linux-runtimes', PROFILE)); await write(join(f.input.stagePhysicalHome, 'rsi-linux-runtimes', PROFILE, 'partial'), 'new'); throw new Error('copy failed') })
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('copy failed'); expect(await contents(f.input.stagePhysicalHome)).toEqual(before)
  })
  test('rejects partial backup cleanup without deleting the already verified candidate or claiming rollback', async () => {
    const f = await fixture(), live = await contents(f.input.logicalHome)
    faults.cleanup = true
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('backup cleanup failed after candidate verification; preserved evidence:')
    expect(await readFile(join(f.input.stagePhysicalHome, 'rsi-linux-runtimes', PROFILE, 'bootstrap.json'), 'utf8')).toBe('candidate-rsi-linux-runtimes')
    expect(await readFile(join(f.input.stagePhysicalHome, 'rsi-release-builds', PROFILE, 'bootstrap.json'), 'utf8')).toBe('candidate-rsi-release-builds')
    expect(await readFile(join(f.input.stagePhysicalHome, 'rsi-local-cohorts', PROFILE, 'artifacts/demo.tgz'), 'utf8')).toBe('new-artifact')
    const retained = (await readdir(f.input.stagePhysicalHome)).find(name => name.startsWith('.rsi-pre-owner-native-'))!
    expect(await readFile(join(f.input.stagePhysicalHome, retained, 'transaction.json'), 'utf8')).toContain('pre-owner-base-stage')
    expect(await lstat(join(f.input.stagePhysicalHome, retained, 'rsi-release-builds')).then(() => true, () => false)).toBe(false)
    expect(await contents(f.input.logicalHome)).toEqual(live)
  })
  test('rejects a hard-linked symbolic link before staging', async () => {
    const f = await fixture(), family = join(f.input.stagePhysicalHome, f.oldKind, PROFILE), first = join(family, 'first-link')
    await symlink('bootstrap.json', first)
    // Node's link() follows the source symlink on Darwin; ln -P explicitly links the link inode.
    const linked = spawnSync('/bin/ln', ['-P', first, join(family, 'second-link')], { encoding: 'utf8', timeout: 1000 })
    expect(linked.status, linked.stderr).toBe(0)
    expect((await lstat(first)).nlink).toBe(2)
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('link must be detached'); expect(ports.relocate).not.toHaveBeenCalled()
  })
  test('rejects a symlink replaced with the same target during readlink', async () => {
    const f = await fixture(), path = join(f.input.stagePhysicalHome, f.oldKind, PROFILE, 'raced-link')
    await symlink('bootstrap.json', path); faults.replaceLink = path
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('link identity changed during read'); expect(ports.relocate).not.toHaveBeenCalled()
  })
  test('preserves a private transaction journal if rollback itself cannot restore a backup', async () => {
    const f = await fixture(), live = await contents(f.input.logicalHome)
    ports.relocate.mockImplementation(async () => {
      const name = (await readdir(f.input.stagePhysicalHome)).find(name => name.startsWith('.rsi-pre-owner-native-'))!
      await rm(join(f.input.stagePhysicalHome, name, 'rsi-release-builds'), { recursive: true }); throw new Error('injected missing backup')
    })
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('rollback incomplete; preserved evidence:')
    const retained = (await readdir(f.input.stagePhysicalHome)).find(name => name.startsWith('.rsi-pre-owner-native-'))!
    expect(JSON.parse(await readFile(join(f.input.stagePhysicalHome, retained, 'transaction.json'), 'utf8'))).toMatchObject({ purpose: 'pre-owner-base-stage', originalBackend: 'docker', preparationDigest: f.prepared.receiptDigest })
    expect(await contents(f.input.logicalHome)).toEqual(live)
  })
  test('propagates original receipt/source authentication failure before staging', async () => {
    const f = await fixture(), before = await contents(f.input.stagePhysicalHome)
    ports.build.mockRejectedValue(new Error('frozen manifest/source receipt differs'))
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('frozen manifest/source receipt differs')
    expect(await contents(f.input.stagePhysicalHome)).toEqual(before); expect(ports.relocate).not.toHaveBeenCalled()
  })
  test('rolls back if the final original release receipt differs', async () => {
    const f = await fixture(), before = await contents(f.input.stagePhysicalHome)
    ports.release.mockResolvedValueOnce({ schemaVersion: 1, sourceCommit: OLD }).mockResolvedValueOnce({ schemaVersion: 1, sourceCommit: NEXT })
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('original base receipts changed')
    expect(await contents(f.input.stagePhysicalHome)).toEqual(before)
  })
  test.each(['rsi-linux-repository-runtimes', 'rsi-linux-creation-builds', 'rsi-creation-builds'])('refuses owner family %s without deletion', async kind => {
    const f = await fixture(); await directory(join(f.input.stagePhysicalHome, kind, PROFILE)); await write(join(f.input.stagePhysicalHome, kind, PROFILE, 'owner'), 'preserve')
    const before = await contents(f.input.stagePhysicalHome)
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('owner runtime family'); expect(await contents(f.input.stagePhysicalHome)).toEqual(before); expect(ports.relocate).not.toHaveBeenCalled()
  })
  test.each(['state', 'config', 'registry'])('refuses nonempty authority %s', async field => {
    const f = await fixture(); await write(join(f.input.stagePhysicalHome, 'rsi-authorities', PROFILE, field, 'owner'), 'preserve')
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('authority is not empty'); expect(ports.relocate).not.toHaveBeenCalled()
  })
  test('rejects nonempty authority catalog and leaves it intact', async () => {
    const f = await fixture(); await write(join(f.input.stagePhysicalHome, 'rsi-authorities', PROFILE, 'catalog.json'), JSON.stringify({ schemaVersion: 1, entries: [{ id: 'owner-capability' }] }))
    const before = await contents(f.input.stagePhysicalHome)
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('catalog is not empty')
    expect(await contents(f.input.stagePhysicalHome)).toEqual(before); expect(ports.relocate).not.toHaveBeenCalled()
  })
  test('refuses a prepared candidate carrying an owner runtime family before staging', async () => {
    const f = await fixture(), before = await contents(f.input.stagePhysicalHome)
    await directory(join(f.candidate, 'rsi-linux-repository-runtimes', PROFILE))
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('owner runtime family')
    expect(await contents(f.input.stagePhysicalHome)).toEqual(before); expect(ports.relocate).not.toHaveBeenCalled()
  })
  test('rejects mixed original/candidate backends and bad prepared source binding', async () => {
    const f = await fixture(); await directory(join(f.input.logicalHome, 'rsi-linux-runtimes', PROFILE))
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('exactly one build backend')
    await rm(join(f.input.logicalHome, 'rsi-linux-runtimes'), { recursive: true }); await directory(join(f.candidate, 'rsi-builds', PROFILE))
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('candidate also contains Docker')
    await rm(join(f.candidate, 'rsi-builds'), { recursive: true }); ports.preparation.mockResolvedValue({ ...f.prepared, source: { sourceCommit: OLD } })
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow('runtime differs from preparation source')
  })
  test.each(['bytes', 'mode', 'hardlink', 'absolute-link', 'escaping-link'] as const)('rejects original-copy %s drift before writes', async kind => {
    const f = await fixture(), path = join(f.input.stagePhysicalHome, f.oldKind, PROFILE, 'bootstrap.json')
    if (kind === 'bytes') await write(path, 'different')
    else if (kind === 'mode') await chmod(path, 0o622)
    else if (kind === 'hardlink') { await rm(path); await link(join(f.input.logicalHome, f.oldKind, PROFILE, 'bootstrap.json'), path) }
    else await symlink(kind === 'absolute-link' ? path : '../../../../outside', join(f.input.stagePhysicalHome, f.oldKind, PROFILE, 'escape'))
    await expect(stageLinuxRsiPreOwnerNativeResources(f.input)).rejects.toThrow(); expect(ports.relocate).not.toHaveBeenCalled()
  })
  test('rejects unsafe Home/preparation paths before reading preparation', async () => {
    const f = await fixture()
    for (const input of [{ ...f.input, stagePhysicalHome: f.input.logicalHome }, { ...f.input, stagePhysicalHome: f.input.stagePhysicalHome + '/' }, { ...f.input, preparationRoot: join(f.input.stagePhysicalHome, 'nested') }]) await expect(stageLinuxRsiPreOwnerNativeResources(input)).rejects.toThrow('distinct canonical stopped Home')
    expect(ports.preparation).not.toHaveBeenCalled()
  })
  test('verifier refuses unrelated Home, owner purpose, Docker residue and changed cohort', async () => {
    const f = await fixture(), staged = await stageLinuxRsiPreOwnerNativeResources(f.input), unrelated = join(f.root, 'unrelated'); await directory(unrelated)
    await expect(verifyLinuxRsiPreOwnerNativeResources({ proof: staged.proof, physicalHome: unrelated })).rejects.toThrow('proof binding')
    await expect(verifyLinuxRsiPreOwnerNativeResources({ proof: { ...staged.proof, purpose: 'owner' } as unknown as typeof staged.proof, physicalHome: f.input.stagePhysicalHome })).rejects.toThrow('proof binding')
    await expect(verifyLinuxRsiPreOwnerNativeResources({ proof: { ...staged.proof, cohortDigest: sha('wrong') }, physicalHome: f.input.stagePhysicalHome })).rejects.toThrow('cohort receipt digest differs')
    await directory(join(f.input.stagePhysicalHome, 'rsi-builds', PROFILE))
    await expect(verifyLinuxRsiPreOwnerNativeResources({ proof: staged.proof, physicalHome: f.input.stagePhysicalHome })).rejects.toThrow('retains Docker')
  })
})
