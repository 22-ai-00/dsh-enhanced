import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { lstatSync } from 'node:fs'
import { chmod, link, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  admitCatalogCandidate,
  catalogAdmissionId,
  discover,
  loadCatalogWithMetadata,
  parseCatalog,
  previewCatalogAdmission,
  type CapabilityCatalog,
  type CatalogAdmissionInput,
  type CatalogEntry,
} from '../src/catalog.ts'

const roots = new Set<string>()
const children = new Set<ChildProcess>()
const integrity = (value: string): string => `sha512-${createHash('sha512').update(value).digest('base64')}`
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  await Promise.all([...children].map(async child => { if (child.exitCode === null) await once(child, 'exit') }))
  children.clear()
  await Promise.all([...roots].map(async root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

function candidate(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  const identity = {
    id: 'released-plugin', package: '@dsh-enhanced/released-plugin', version: '1.2.3',
    integrity: integrity('released'), requires: [], capabilities: ['catalog admission', 'new capability'],
    authorities: ['network: verified registry'], dshBaseline: '0.1.0-rc.8', ...overrides,
  }
  const registryPath = '/var/lib/dsh-local-registry'; const locator = pathToFileURL(registryPath).href
  return { ...identity, registry: overrides.registry ?? { id: 'local-registry', locator,
    reference: pathToFileURL(join(registryPath, 'packages', encodeURIComponent(identity.package), identity.version, 'package.tgz')).href } }
}

async function fixture(entries: CatalogEntry[] = []): Promise<{ root: string; path: string; catalog: CapabilityCatalog }> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-catalog-admission-')); roots.add(root)
  await chmod(root, 0o700)
  const path = join(root, 'catalog.json')
  const catalog = parseCatalog({ schemaVersion: 1, entries })
  await writeFile(path, JSON.stringify(catalog), { mode: 0o600 })
  return { root, path, catalog }
}

async function transitionJournalPath(root: string): Promise<string> {
  const directory = join(root, '.catalog.json.admissions')
  const name = (await readdir(directory)).find(entry => /^[a-f0-9]{64}\.json$/u.test(entry))
  if (name === undefined) throw new Error('missing transition journal')
  return join(directory, name)
}

async function attemptDirectories(root: string): Promise<string[]> {
  const directory = join(root, '.catalog.json.admissions')
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('.catalog.json.admission-'))
    .map(entry => join(directory, entry.name))
}

function input(path: string, current: CapabilityCatalog, rawCandidate: CatalogEntry,
  overrides: Partial<CatalogAdmissionInput> = {}): CatalogAdmissionInput {
  const registry = { id: rawCandidate.registry!.id, locator: rawCandidate.registry!.locator }
  const registryReference = rawCandidate.registry!.reference
  const preview = previewCatalogAdmission(current, rawCandidate)
  return {
    catalog: { id: 'owner-catalog', path }, registry, installationId: 'installation-1', operationId: 'source-operation-1',
    plan: { id: 'source-plan-1', digest: '1'.repeat(64), revision: 7 }, release: { id: 'source-release-1', fence: 3 },
    expectedBeforeCatalogDigest: preview.beforeCatalogDigest, expectedAfterCatalogDigest: preview.afterCatalogDigest,
    registryReference, artifactStatementDigest: '2'.repeat(64),
    artifactSignature: Buffer.from('verified artifact signature').toString('base64'),
    verificationEvidenceDigest: '3'.repeat(64), candidate: rawCandidate, ...overrides,
  }
}

describe('owner-private catalog CAS admission', () => {
  test('atomically admits a candidate and makes it visible to discovery', async () => {
    const value = await fixture(); const released = candidate(); const request = input(value.path, value.catalog, released)
    const result = await admitCatalogCandidate(request)

    expect(result.replayed).toBe(false)
    expect(result.evidence).toMatchObject({
      kind: 'catalog-admission', catalogId: 'owner-catalog', candidate: released,
      beforeCatalogDigest: request.expectedBeforeCatalogDigest, afterCatalogDigest: request.expectedAfterCatalogDigest,
      registryReference: request.registryReference, artifactStatementDigest: request.artifactStatementDigest,
      verificationEvidenceDigest: request.verificationEvidenceDigest,
    })
    expect(result.evidence.admissionId).toMatch(/^catalog-admission-[a-f0-9]{64}$/u)
    expect(result.evidence.artifactSignatureDigest).toBe(createHash('sha256')
      .update(Buffer.from(request.artifactSignature, 'base64')).digest('hex'))
    const loaded = await loadCatalogWithMetadata(value.path)
    expect(loaded.digest).toBe(request.expectedAfterCatalogDigest)
    expect(discover(loaded.catalog, 'new capability')).toEqual([expect.objectContaining({ id: released.id })])
    expect((await stat(value.path)).mode & 0o777).toBe(0o600)
  })

  test('replays the exact operation without rewriting the catalog or changing evidence', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const first = await admitCatalogCandidate(request); const inode = (await stat(value.path)).ino
    const replay = await admitCatalogCandidate(request)
    expect(replay).toEqual({ evidence: first.evidence, replayed: true })
    expect((await stat(value.path)).ino).toBe(inode)
  })

  test('persists a request-bound v2 attempt journal before exchange and retains exact recovery bytes', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const before = await readFile(value.path, 'utf8')
    await admitCatalogCandidate(request)
    const directory = join(value.root, '.catalog.json.admissions')
    const entries = await readdir(directory, { withFileTypes: true })
    const attemptJournalName = entries.find(entry => entry.isFile() && entry.name.includes('.attempt-'))?.name
    const attemptDirectory = entries.find(entry => entry.isDirectory() && entry.name.startsWith('.catalog.json.admission-'))?.name
    expect(attemptJournalName).toBeDefined(); expect(attemptDirectory).toBeDefined()
    const journal = JSON.parse(await readFile(join(directory, attemptJournalName!), 'utf8')) as {
      schemaVersion: number; bindingDigest: string; attemptId: string; catalogPath: string; attemptDirectoryName: string
      names: { desired: string; stage: string; before: string; reverseMarker: string }
      expectedBefore: { fileDigest: string }; desired: { fileDigest: string }; rollback: { fileDigest: string }
    }
    expect(journal).toMatchObject({ schemaVersion: 2, catalogPath: value.path, attemptDirectoryName: attemptDirectory,
      names: { desired: 'desired', stage: 'stage', before: 'before', reverseMarker: 'reverse-ready' },
      expectedBefore: { fileDigest: createHash('sha256').update(before).digest('hex') },
      rollback: { fileDigest: createHash('sha256').update(before).digest('hex') } })
    expect(journal.attemptId).toMatch(/^[a-f0-9]{64}$/u)
    expect(journal.bindingDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(await readFile(join(directory, attemptDirectory!, 'before'), 'utf8')).toBe(before)
    expect(createHash('sha256').update(await readFile(value.path)).digest('hex')).toBe(journal.desired.fileDigest)
    expect(createHash('sha256').update(await readFile(join(directory, attemptDirectory!, 'stage'))).digest('hex'))
      .toBe(journal.expectedBefore.fileDigest)
  })

  test('fails closed on a durable unresolved attempt instead of inventing a new attempt', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await expect(admitCatalogCandidate(request, { afterTemporaryFileSync: () => { throw new Error('attempt interrupted') } }))
      .rejects.toThrow('attempt interrupted')
    const attempts = await attemptDirectories(value.root)
    expect(attempts).toHaveLength(1)
    await expect(admitCatalogCandidate(request)).rejects.toThrow('durable unresolved attempt')
    expect(await attemptDirectories(value.root)).toEqual(attempts)
    expect((await loadCatalogWithMetadata(value.path)).digest).toBe(request.expectedBeforeCatalogDigest)
  })

  test('rejects after-state replay when only its v2 attempt journal is missing', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await admitCatalogCandidate(request)
    const directory = join(value.root, '.catalog.json.admissions')
    const attemptJournal = (await readdir(directory)).find(name => name.includes('.attempt-') && name.endsWith('.json'))
    await unlink(join(directory, attemptJournal!))
    await expect(admitCatalogCandidate(request)).rejects.toThrow('missing its request-bound v2 attempt journal')
  })

  test('rejects v1 fallback when both v2 attempt journal and directory are missing', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await admitCatalogCandidate(request)
    const directory = join(value.root, '.catalog.json.admissions')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.name.includes('.attempt-')) await rm(join(directory, entry.name), { recursive: true, force: true })
    }
    await expect(admitCatalogCandidate(request)).rejects.toThrow('missing its request-bound v2 attempt journal')
  })

  test('rejects an untracked artifact in a completed attempt instead of deleting it', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await admitCatalogCandidate(request)
    const [attempt] = await attemptDirectories(value.root)
    const foreign = join(attempt!, 'foreign-writer')
    await writeFile(foreign, 'do not delete', { mode: 0o600 })
    await expect(admitCatalogCandidate(request)).rejects.toThrow('untracked recovery artifact')
    expect(await readFile(foreign, 'utf8')).toBe('do not delete')
  })

  test('rejects a foreign inode under an allowed attempt name without deleting it', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await admitCatalogCandidate(request)
    const [attempt] = await attemptDirectories(value.root)
    const stage = join(attempt!, 'stage'); const foreign = 'foreign stage bytes'
    await writeFile(join(attempt!, 'replacement'), foreign, { mode: 0o600 })
    await rename(join(attempt!, 'replacement'), stage)
    await expect(admitCatalogCandidate(request)).rejects.toThrow('durable inode and digest')
    expect(await readFile(stage, 'utf8')).toBe(foreign)
  })

  test.each(['before', 'stage'])('rejects exact replay when required %s recovery is missing', async name => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await admitCatalogCandidate(request)
    const [attempt] = await attemptDirectories(value.root)
    await unlink(join(attempt!, name))
    await expect(admitCatalogCandidate(request)).rejects.toThrow(/missing its durable|invalid state carrier|exactly one state carrier/u)
  })

  test('replays the latest transition with older request-bound attempt history present', async () => {
    const value = await fixture(); const firstCandidate = candidate()
    await admitCatalogCandidate(input(value.path, value.catalog, firstCandidate))
    const current = (await loadCatalogWithMetadata(value.path)).catalog
    const upgraded = candidate({ version: '1.3.0', integrity: integrity('upgraded') })
    const secondRequest = input(value.path, current, upgraded, { operationId: 'source-operation-2' })
    const second = await admitCatalogCandidate(secondRequest)
    await expect(admitCatalogCandidate(secondRequest)).resolves.toEqual({ evidence: second.evidence, replayed: true })
    expect(await attemptDirectories(value.root)).toHaveLength(2)
  })

  test('rejects replay attribution to a different operation or provenance binding', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const first = await admitCatalogCandidate(request)
    for (const changed of [
      { ...request, operationId: 'source-operation-2' },
      { ...request, plan: { ...request.plan, digest: '4'.repeat(64) } },
      { ...request, release: { ...request.release, fence: request.release.fence + 1 } },
      { ...request, verificationEvidenceDigest: '5'.repeat(64) },
    ]) {
      await expect(admitCatalogCandidate(changed)).rejects.toThrow('different admission operation')
    }
    await expect(admitCatalogCandidate({ ...request, expectedBeforeCatalogDigest: '6'.repeat(64) }))
      .rejects.toThrow('no exact request-bound admission journal')
    expect(first.evidence.admissionId).toBe(catalogAdmissionId(request))
  })

  test('binds registry identity and artifact reference into the admitted catalog digest and request', async () => {
    const value = await fixture(); const released = candidate(); const request = input(value.path, value.catalog, released)
    const changedIdentity = { ...released, registry: { ...released.registry!, id: 'different-registry' } }
    expect(previewCatalogAdmission(value.catalog, changedIdentity).afterCatalogDigest).not.toBe(request.expectedAfterCatalogDigest)
    await expect(admitCatalogCandidate({ ...request, registry: { ...request.registry, id: 'different-registry' } }))
      .rejects.toThrow('registry identity and reference')
    const alternateRoot = '/var/lib/dsh-other-registry'; const alternateLocator = pathToFileURL(alternateRoot).href
    const alternateReference = pathToFileURL(join(alternateRoot, 'packages', encodeURIComponent(released.package), released.version, 'package.tgz')).href
    const changedLocation = { ...released, registry: { id: released.registry!.id, locator: alternateLocator, reference: alternateReference } }
    expect(previewCatalogAdmission(value.catalog, changedLocation).afterCatalogDigest).not.toBe(request.expectedAfterCatalogDigest)
    await expect(admitCatalogCandidate({ ...request, candidate: changedLocation }))
      .rejects.toThrow('registry identity and reference')
    const changedReference = { ...released, registry: { ...released.registry!,
      reference: released.registry!.reference.replace('/1.2.3/', '/1.2.4/') } }
    expect(() => previewCatalogAdmission(value.catalog, changedReference)).toThrow('immutable object')
  })

  test('fails closed when the request-bound transition journal is missing or tampered', async () => {
    const missing = await fixture(); const missingRequest = input(missing.path, missing.catalog, candidate())
    await admitCatalogCandidate(missingRequest)
    const directory = join(missing.root, '.catalog.json.admissions')
    for (const name of await readdir(directory)) await rm(join(directory, name), { recursive: true, force: true })
    await expect(admitCatalogCandidate(missingRequest)).rejects.toThrow('no exact request-bound admission journal')

    const tampered = await fixture(); const tamperedRequest = input(tampered.path, tampered.catalog, candidate())
    await admitCatalogCandidate(tamperedRequest)
    await writeFile(await transitionJournalPath(tampered.root), '{}', { mode: 0o600 })
    await expect(admitCatalogCandidate(tamperedRequest)).rejects.toThrow('journal is corrupt')
  })

  test('never repairs a missing after-state journal from an unauthenticated legacy lock file', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const first = await admitCatalogCandidate(request)
    const directory = join(value.root, '.catalog.json.admissions')
    for (const name of await readdir(directory)) await rm(join(directory, name), { recursive: true, force: true })
    await writeFile(join(value.root, '.catalog.json.admission.lock'), JSON.stringify({
      schemaVersion: 1, pid: 2_147_483_647, processStartTime: null, uid: process.getuid?.() ?? null,
      operationId: request.operationId, admissionId: first.evidence.admissionId,
    }), { mode: 0o600 })

    await expect(admitCatalogCandidate(request)).rejects.toThrow('no exact request-bound admission journal')
    await expect(admitCatalogCandidate({ ...request, operationId: 'different-operation' })).rejects.toThrow()
  })

  test('permits an upgrade and replays it from the request-bound after digest', async () => {
    const old = candidate({ version: '1.2.3', integrity: integrity('old') })
    const value = await fixture([old]); const upgraded = candidate({ version: '1.3.0', integrity: integrity('new') })
    const request = input(value.path, value.catalog, upgraded)
    const first = await admitCatalogCandidate(request); const replay = await admitCatalogCandidate(request)
    expect(first.replayed).toBe(false); expect(replay.replayed).toBe(true)
    expect(replay.evidence).toEqual(first.evidence)
    expect((await loadCatalogWithMetadata(value.path)).catalog.entries).toEqual([expect.objectContaining({ version: '1.3.0' })])
  })

  test('rejects before/after digest drift and unrelated changes without writing', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const unrelated = parseCatalog({ schemaVersion: 1, entries: [candidate({
      id: 'unrelated', package: '@dsh-enhanced/unrelated', version: '9.0.0',
    })] })
    await writeFile(value.path, JSON.stringify(unrelated), { mode: 0o600 })
    await expect(admitCatalogCandidate(request)).rejects.toThrow('catalog digest changed before admission')
    expect((await loadCatalogWithMetadata(value.path)).catalog).toEqual(unrelated)

    const fresh = await fixture(); const invalidAfter = input(fresh.path, fresh.catalog, candidate(), { expectedAfterCatalogDigest: 'f'.repeat(64) })
    await expect(admitCatalogCandidate(invalidAfter)).rejects.toThrow('expected after digest')
    expect((await loadCatalogWithMetadata(fresh.path)).catalog.entries).toHaveLength(0)
  })

  test.each([
    ['duplicate id', [candidate({ package: '@dsh-enhanced/existing', version: '2.0.0' })], candidate({ version: '3.0.0' }), 'catalog identity'],
    ['duplicate package', [candidate({ id: 'existing', version: '2.0.0' })], candidate({ id: 'different', version: '3.0.0' }), 'catalog identity'],
    ['same version conflict', [candidate({ integrity: integrity('old') })], candidate({ integrity: integrity('new') }), 'existing version'],
    ['downgrade', [candidate({ version: '2.0.0', integrity: integrity('old') })], candidate({ version: '1.9.9' }), 'would downgrade'],
  ])('rejects %s', async (_label, existing, attempted, message) => {
    const value = await fixture(existing); const before = await readFile(value.path, 'utf8')
    expect(() => previewCatalogAdmission(value.catalog, attempted)).toThrow(message)
    expect(await readFile(value.path, 'utf8')).toBe(before)
  })

  test('rejects catalogs that already contain duplicate package identities', async () => {
    const duplicated = parseCatalog({ schemaVersion: 1, entries: [candidate({ id: 'one' }), candidate({ id: 'two' })] })
    expect(() => previewCatalogAdmission(duplicated, candidate({ id: 'three', package: '@dsh-enhanced/three' })))
      .toThrow('duplicate package identity')
  })

  test('rejects non-canonical integrity and SemVer strings at the admission boundary', () => {
    const catalog = parseCatalog({ schemaVersion: 1, entries: [] })
    expect(() => previewCatalogAdmission(catalog, candidate({ integrity: 'sha512-c2hvcnQ=' })))
      .toThrow('canonical 64-byte sha512')
    expect(() => previewCatalogAdmission(catalog, candidate({ version: '1.0.0-01' }))).toThrow('exact version')
    expect(() => previewCatalogAdmission(catalog, candidate({ version: '1.0.0-alpha..1' }))).toThrow('exact version')
    expect(() => previewCatalogAdmission(catalog, candidate({ version: '1.0.0+build.1' }))).not.toThrow()
  })

  test('rejects writable files, hard links, symlinks, and writable catalog directories', async () => {
    const writable = await fixture(); const writableRequest = input(writable.path, writable.catalog, candidate())
    await chmod(writable.path, 0o620)
    await expect(admitCatalogCandidate(writableRequest)).rejects.toThrow('mode 0600')

    const linked = await fixture(); const alias = join(linked.root, 'alias.json'); await link(linked.path, alias)
    await expect(admitCatalogCandidate(input(linked.path, linked.catalog, candidate()))).rejects.toThrow('one canonical link')

    const symbolic = await fixture(); const symbolicPath = join(symbolic.root, 'symbolic.json'); await symlink(symbolic.path, symbolicPath)
    await expect(admitCatalogCandidate(input(symbolicPath, symbolic.catalog, candidate()))).rejects.toThrow('symbolic links')

    const exposed = await fixture(); await chmod(exposed.root, 0o770)
    await expect(admitCatalogCandidate(input(exposed.path, exposed.catalog, candidate()))).rejects.toThrow('catalog directory')
  })

  test('ignores an obsolete owner-bound PID lock because exclusion is on the parent directory FD', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const lockPath = join(value.root, '.catalog.json.admission.lock')
    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1, pid: 2_147_483_647, uid: process.getuid?.() ?? null,
      processStartTime: null,
      operationId: 'crashed-operation', admissionId: `catalog-admission-${'a'.repeat(64)}`,
    }), { mode: 0o600 })
    await expect(admitCatalogCandidate(request)).resolves.toMatchObject({ replayed: false })
    expect((await readdir(value.root)).sort()).toEqual(['.catalog.json.admission.lock', '.catalog.json.admissions', 'catalog.json'])
  })

  test('does not rely on PID start-time metadata for exclusion', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await writeFile(join(value.root, '.catalog.json.admission.lock'), JSON.stringify({
      schemaVersion: 1, pid: process.pid, processStartTime: '0', uid: process.getuid?.() ?? null,
      operationId: 'dead-incarnation', admissionId: `catalog-admission-${'c'.repeat(64)}`,
    }), { mode: 0o600 })
    await expect(admitCatalogCandidate(request)).resolves.toMatchObject({ replayed: false })
    expect((await readdir(value.root)).sort()).toEqual(['.catalog.json.admission.lock', '.catalog.json.admissions', 'catalog.json'])
  })

  test('does not parse obsolete lock-file payloads while the parent-directory lock remains authoritative', async () => {
    for (const lock of [
      { source: '{}', mode: 0o600 },
      { source: JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, uid: process.getuid?.() ?? null,
        processStartTime: null, operationId: 'exposed-operation', admissionId: `catalog-admission-${'a'.repeat(64)}` }), mode: 0o644 },
    ]) {
      const value = await fixture()
      await writeFile(join(value.root, '.catalog.json.admission.lock'), lock.source, { mode: lock.mode })
      await expect(admitCatalogCandidate(input(value.path, value.catalog, candidate()))).resolves.toMatchObject({ replayed: false })
    }
  })

  test('serializes concurrent writers through the shared owner lock', async () => {
    const value = await fixture(); const firstRequest = input(value.path, value.catalog, candidate())
    let release!: () => void
    const held = new Promise<void>(resolvePromise => { release = resolvePromise })
    let entered!: () => void
    const waiting = new Promise<void>(resolvePromise => { entered = resolvePromise })
    const first = admitCatalogCandidate(firstRequest, { afterTemporaryFileSync: async () => { entered(); await held } })
    await waiting
    await expect(admitCatalogCandidate(input(value.path, value.catalog, candidate({
      id: 'second', package: '@dsh-enhanced/second', version: '1.0.0',
    })))).rejects.toThrow('kernel lock')
    release(); await expect(first).resolves.toMatchObject({ replayed: false })
  })

  test('leaves the old file intact when interrupted before rename and cleans temporary state', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const before = await readFile(value.path, 'utf8')
    await expect(admitCatalogCandidate(request, { afterTemporaryFileSync: () => { throw new Error('injected crash') } }))
      .rejects.toThrow('injected crash')
    expect(await readFile(value.path, 'utf8')).toBe(before)
    expect((await readdir(value.root)).sort()).toEqual(['.catalog.json.admissions', 'catalog.json'])
  })

  test('recovers from a crash after the request-bound journal but before catalog rename', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await expect(admitCatalogCandidate(request, { afterJournalSync: () => { throw new Error('journal-only crash') } }))
      .rejects.toThrow('journal-only crash')
    expect((await loadCatalogWithMetadata(value.path)).digest).toBe(request.expectedBeforeCatalogDigest)
    await expect(admitCatalogCandidate(request)).resolves.toMatchObject({ replayed: false })
    expect((await loadCatalogWithMetadata(value.path)).digest).toBe(request.expectedAfterCatalogDigest)
  })

  test('detects a competing replacement at the final pre-rename seam', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const competing = parseCatalog({ schemaVersion: 1, entries: [candidate({
      id: 'competing', package: '@dsh-enhanced/competing', version: '8.0.0',
    })] })
    await expect(admitCatalogCandidate(request, { beforeAtomicRename: async () => {
      const replacement = join(value.root, 'replacement.json')
      await writeFile(replacement, JSON.stringify(competing), { mode: 0o600 })
      await rename(replacement, value.path)
    } })).rejects.toThrow('exact reverse exchange')
    expect((await loadCatalogWithMetadata(value.path)).catalog).toEqual(competing)
    expect((await readdir(value.root)).sort()).toEqual(['.catalog.json.admissions', 'catalog.json'])
  })

  test('never overwrites a competing replacement in the final rename window', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const before = await readFile(value.path, 'utf8')
    const competing = parseCatalog({ schemaVersion: 1, entries: [candidate({
      id: 'last-window', package: '@dsh-enhanced/last-window', version: '8.0.0',
    })] })
    await expect(admitCatalogCandidate(request, { beforeAtomicRename: async (_path, temporaryPath) => {
      await unlink(temporaryPath)
      await writeFile(temporaryPath, JSON.stringify(competing), { mode: 0o600 })
      expect(await readFile(value.path, 'utf8')).toBe(before)
    } })).rejects.toThrow('desired attempt changed before exchange')
    expect(await readFile(value.path, 'utf8')).toBe(before)
    expect((await readdir(value.root)).sort()).toEqual(['.catalog.json.admissions', 'catalog.json'])
  })

  test('restores the exact competing catalog when the target pathname is replaced before exchange', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const competing = parseCatalog({ schemaVersion: 1, entries: [candidate({
      id: 'target-race', package: '@dsh-enhanced/target-race', version: '8.0.0',
    })] })
    await expect(admitCatalogCandidate(request, { beforeAtomicRename: async catalogPath => {
      const replacement = join(value.root, 'target-race.json')
      await writeFile(replacement, JSON.stringify(competing), { mode: 0o600 })
      await rename(replacement, catalogPath)
      expect((await loadCatalogWithMetadata(catalogPath)).catalog).toEqual(competing)
    } })).rejects.toThrow('exact reverse exchange')
    expect((await loadCatalogWithMetadata(value.path)).catalog).toEqual(competing)
    expect((await readdir(value.root)).sort()).toEqual(['.catalog.json.admissions', 'catalog.json'])
  })

  test('never overwrites a writer that replaces target after exchange and preserves recovery copies', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const before = await readFile(value.path, 'utf8')
    const competing = parseCatalog({ schemaVersion: 1, entries: [candidate({
      id: 'continuous-race', package: '@dsh-enhanced/continuous-race', version: '8.0.0',
    })] })
    const replacement = join(value.root, 'continuous-race.json')
    await writeFile(replacement, JSON.stringify(competing), { mode: 0o600 })
    const originalInode = lstatSync(value.path, { bigint: true }).ino.toString()
    let racer: ChildProcess | undefined
    await expect(admitCatalogCandidate(request, { afterExchangePauseMilliseconds: 500, beforeAtomicRename: async catalogPath => {
      const script = [
        "const { lstatSync, renameSync } = require('node:fs')",
        'const [target, replacement, original] = process.argv.slice(1)',
        "process.stdout.write('ready\\n')",
        'const deadline = Date.now() + 5000',
        'while (lstatSync(target, { bigint: true }).ino.toString() === original && Date.now() < deadline) {}',
        "if (Date.now() >= deadline) process.exit(2)",
        'renameSync(replacement, target)',
      ].join(';')
      racer = spawn(process.execPath, ['-e', script, catalogPath, replacement, originalInode], { stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(racer)
      await once(racer.stdout!, 'data')
    } } as Parameters<typeof admitCatalogCandidate>[1] & { afterExchangePauseMilliseconds: number })).rejects.toThrow('left untouched')
    if (racer !== undefined && racer.exitCode === null) await once(racer, 'exit')
    expect(racer?.exitCode).toBe(0)
    expect((await loadCatalogWithMetadata(value.path)).catalog).toEqual(competing)
    const attempts = await attemptDirectories(value.root)
    expect(attempts.length).toBe(1)
    expect(await readFile(join(attempts[0]!, 'before'), 'utf8')).toBe(before)
  })

  test('preserves a writer raced into stage during reverse exchange for manual reconciliation', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    const firstCompeting = parseCatalog({ schemaVersion: 1, entries: [candidate({
      id: 'first-race', package: '@dsh-enhanced/first-race', version: '8.0.0',
    })] })
    const laterCompeting = parseCatalog({ schemaVersion: 1, entries: [candidate({
      id: 'reverse-race', package: '@dsh-enhanced/reverse-race', version: '9.0.0',
    })] })
    const laterBytes = JSON.stringify(laterCompeting)
    const laterPath = join(value.root, 'reverse-race.json')
    await writeFile(laterPath, laterBytes, { mode: 0o600 })
    let racer: ChildProcess | undefined
    await expect(admitCatalogCandidate(request, {
      beforeAtomicRename: async catalogPath => {
        const firstPath = join(value.root, 'first-race.json')
        await writeFile(firstPath, JSON.stringify(firstCompeting), { mode: 0o600 })
        await rename(firstPath, catalogPath)
        const markerName = 'reverse-ready'
        const script = [
          "const { readdirSync, renameSync } = require('node:fs')",
          "const { dirname } = require('node:path')",
          'const [target, replacement, marker] = process.argv.slice(1)',
          'const directory = dirname(target); const deadline = Date.now() + 5000',
          'while (!readdirSync(directory, { recursive: true }).some(name => name.endsWith(marker)) && Date.now() < deadline) {}',
          "if (Date.now() >= deadline) process.exit(2)",
          'renameSync(replacement, target)',
        ].join(';')
        racer = spawn(process.execPath, ['-e', script, catalogPath, laterPath, markerName], { stdio: 'ignore' })
        children.add(racer)
      },
      beforeReverseExchangePauseMilliseconds: 500,
    } as Parameters<typeof admitCatalogCandidate>[1] & { beforeReverseExchangePauseMilliseconds: number }))
      .rejects.toThrow(/journal-named attempt files were preserved|exact reverse exchange/u)
    if (racer !== undefined && racer.exitCode === null) await once(racer, 'exit')
    expect(racer?.exitCode).toBe(0)
    const attempts = await attemptDirectories(value.root)
    const candidatePaths = [value.path, ...attempts.flatMap(path => ['desired', 'stage', 'before'].map(name => join(path, name)))]
    const preservedBytes = await Promise.all(candidatePaths.map(async path => readFile(path, 'utf8').catch(() => '')))
    expect(preservedBytes).toContain(laterBytes)
    expect(attempts.length).toBe(1)
  })

  test('recovers an ambiguous crash after rename as an exact replay', async () => {
    const value = await fixture(); const request = input(value.path, value.catalog, candidate())
    await expect(admitCatalogCandidate(request, { afterAtomicRename: () => { throw new Error('injected post-rename crash') } }))
      .rejects.toThrow('injected post-rename crash')
    expect((await loadCatalogWithMetadata(value.path)).digest).toBe(request.expectedAfterCatalogDigest)
    const replay = await admitCatalogCandidate(request)
    expect(replay.replayed).toBe(true)
    expect((await readdir(value.root)).sort()).toEqual(['.catalog.json.admissions', 'catalog.json'])
  })
})
