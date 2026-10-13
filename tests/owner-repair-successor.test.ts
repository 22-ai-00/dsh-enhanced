import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../scripts/install/local-source-maintenance.mjs', () => ({ assertLocalSourceInstaller: vi.fn() }))

import { assertOwnerRepairSuccessorAbsent, createOwnerRepairSuccessorIntent, finalizeOwnerRepairSuccessorIntent,
  peekOwnerRepairSuccessorIntent, readOwnerRepairSuccessorIntent } from '../scripts/install/owner-repair-successor.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (source: string | Buffer) => createHash('sha256').update(source).digest('hex')
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
const roles = ['approval', 'release', 'adoption', 'observation', 'qualification', 'host', 'pr', 'review',
  'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission']
const oldTransactionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const successorTransactionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function fixture({ badHostPublic = false } = {}) {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'owner-repair-successor-')))
  roots.push(root)
  const homePath = join(root, 'home'), profile = 'assistant', installationId = 'installation'
  const authorityRoot = join(homePath, 'rsi-authorities', profile), identitiesPath = join(authorityRoot, 'identities')
  await mkdir(identitiesPath, { recursive: true, mode: 0o700 })
  await chmod(homePath, 0o700)
  await chmod(join(homePath, 'rsi-authorities'), 0o700)
  await chmod(authorityRoot, 0o700)
  const identities: Record<string, { authority: string; keyId: string; keyPath: string; publicKeyPem: string }> = {}
  const keyDigests: Record<string, string> = {}
  let hostPrivateKey = ''
  for (const role of roles) {
    const keys = generateKeyPairSync('ed25519')
    const privateKeyPem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const publicKeyPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const keyPath = join(identitiesPath, `${role}.pem`)
    await writeFile(keyPath, privateKeyPem, { mode: 0o600 })
    identities[role] = { authority: `${role}-${installationId}`, keyId: `${role}-${installationId}-key`,
      keyPath, publicKeyPem: role === 'host' ? publicKeyPem.trimEnd() : publicKeyPem }
    keyDigests[role] = hash(privateKeyPem)
    if (role === 'host') hostPrivateKey = privateKeyPem
  }
  if (badHostPublic) identities.host.publicKeyPem = identities.approval.publicKeyPem
  const resources = { schemaVersion: 1, root: authorityRoot, installationId, identities }
  const receiptBody = { schemaVersion: 1, dshHome: homePath, profile, resources, keyDigests }
  await writeFile(join(authorityRoot, 'bootstrap.json'), JSON.stringify({ ...receiptBody,
    receiptDigest: hash(JSON.stringify(receiptBody)) }), { mode: 0o600 })
  const overlayBody = { kind: 'rsi-owner-repair-overlay', transactionId: oldTransactionId,
    dshHome: homePath, targetProfile: profile, installationId,
    authority: identities.host.authority, keyId: identities.host.keyId }
  const overlay = { ...overlayBody, signature: sign(null, Buffer.from(canonical(overlayBody)), hostPrivateKey).toString('base64') }
  const sourceProof = { protocol: 'dsh-enhanced/host-owner-source-repair/v1', homePath, profile,
    ownerRepair: { homePath, profile, original: { resources } },
    ownerRepairNext: { overlay, overlayDigest: hash(canonical(overlay)) } }
  const transactionPath = `${homePath}.dsh-enhanced-transaction`
  await mkdir(transactionPath, { mode: 0o700 })
  const backupPath = join(transactionPath, 'original-home')
  await cp(homePath, backupPath, { recursive: true })
  const transactionStat = await lstat(transactionPath), backupStat = await lstat(backupPath)
  const transactionIdentity = { dev: String(transactionStat.dev), ino: String(transactionStat.ino),
    uid: transactionStat.uid, mode: transactionStat.mode }
  const originalIdentity = { dev: String(backupStat.dev), ino: String(backupStat.ino),
    uid: backupStat.uid, mode: backupStat.mode }
  const stat = await lstat(homePath)
  const currentCandidateIdentity = { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, mode: stat.mode }
  const oldManifestSource = JSON.stringify({ version: 4, operation: 'host-update', id: oldTransactionId,
    homePath, canonicalHome: homePath, transactionPath, transactionIdentity, originalIdentity,
    stagedIdentity: currentCandidateIdentity,
    profile, state: 'swapped', bindingDigest: 'a'.repeat(64),
    hostMigration: { phase: 'starting', candidateEverStarted: true, localSource: sourceProof } })
  await writeFile(join(transactionPath, 'manifest.json'), oldManifestSource, { mode: 0o600 })
  const installerRoot = join(root, 'installer')
  await mkdir(installerRoot, { mode: 0o700 })
  const installerStat = await lstat(installerRoot)
  const installer = { root: installerRoot, dev: String(installerStat.dev), ino: String(installerStat.ino),
    digest: 'b'.repeat(64), entries: 42 }
  const preparationRoot = join(root, 'preparation'), planPath = join(root, 'plan.json')
  await mkdir(preparationRoot, { mode: 0o700 })
  await writeFile(planPath, '{"plan":true}\n', { mode: 0o600 })
  const archivePath = `${homePath}.dsh-enhanced-transaction.owner-predecessor-${successorTransactionId}`
  const request = { homePath, profile, oldManifestSource, currentCandidateIdentity, installer,
    preparationRoot, preparationDigest: 'c'.repeat(64), candidateSourceCommit: 'd'.repeat(40),
    permissionPreset: 'workspace-write', auxiliaryRoot: null, planPath,
    planDigest: hash('{"plan":true}\n'), archivePath, successorTransactionId }
  const accepted = (intentDigest: string, extra = {}) => JSON.stringify({ version: 4, operation: 'host-update', id: successorTransactionId,
    homePath, profile, state: 'committed', hostMigration: { phase: 'committed', candidateEverStarted: true,
      plan: { plan: true },
      localSource: { protocol: 'dsh-enhanced/host-owner-source-repair/v1', homePath, profile,
        preparationRoot, preparationDigest: request.preparationDigest, candidate: { sourceCommit: request.candidateSourceCommit },
        ownerRepair: { permissionPreset: request.permissionPreset,
          predecessor: { sourceProofDigest: hash(JSON.stringify(sourceProof)) } },
        successorIntent: { digest: intentDigest, archivePath, transactionId: successorTransactionId },
        auxiliary: request.auxiliaryRoot === null ? null : { root: request.auxiliaryRoot }, installer } }, ...extra })
  return { ...request, root, accepted, archivePath, transactionPath, sourceProof }
}

test('signs a private intent against all original identities and accepts equivalent PEM newline', async () => {
  const setup = await fixture()
  expect(await peekOwnerRepairSuccessorIntent({ homePath: setup.homePath })).toBeUndefined()
  await assertOwnerRepairSuccessorAbsent({ homePath: setup.homePath })
  const created = await createOwnerRepairSuccessorIntent(setup)
  expect(created.intent.oldManifestDigest).toBe(hash(setup.oldManifestSource))
  expect(created.intent.currentCandidateIdentity).toEqual(setup.currentCandidateIdentity)
  expect(await peekOwnerRepairSuccessorIntent({ homePath: setup.homePath })).toEqual({
    archivePath: setup.archivePath, oldTransactionId, successorTransactionId })
  await expect(assertOwnerRepairSuccessorAbsent({ homePath: setup.homePath }))
    .rejects.toThrow('pending successor')
  expect((await readOwnerRepairSuccessorIntent(setup)).digest).toBe(created.digest)
  expect((await createOwnerRepairSuccessorIntent(setup)).source).toBe(created.source)
  const pending = await lstat(`${setup.homePath}.dsh-enhanced-owner-successor.json`)
  expect(pending.mode & 0o777).toBe(0o600)
})

test('rejects another key, changed candidate request, plan bytes, and predecessor manifest', async () => {
  const bad = await fixture({ badHostPublic: true })
  await expect(createOwnerRepairSuccessorIntent(bad)).rejects.toThrow('predecessor Host overlay signature differs')
  const setup = await fixture()
  await createOwnerRepairSuccessorIntent(setup)
  await expect(createOwnerRepairSuccessorIntent({ ...setup, candidateSourceCommit: 'e'.repeat(40) }))
    .rejects.toThrow('pending successor request differs')
  await expect(readOwnerRepairSuccessorIntent({ ...setup,
    oldManifestSource: setup.oldManifestSource.replace('"starting"', '"failed"') }))
    .rejects.toThrow('successor intent shape or scope differs')
  await writeFile(setup.planPath, '{"plan":false}\n')
  await expect(readOwnerRepairSuccessorIntent(setup)).rejects.toThrow('successor plan file changed')
})

test('rejects tampered or unsafe pending files and an occupied archive path', async () => {
  const setup = await fixture()
  const path = `${setup.homePath}.dsh-enhanced-owner-successor.json`
  await createOwnerRepairSuccessorIntent(setup)
  const raw = await readFile(path, 'utf8')
  await writeFile(path, raw.replace('workspace-write', 'danger-full-access'))
  await expect(readOwnerRepairSuccessorIntent(setup)).rejects.toThrow('signature differs')
  await writeFile(path, raw)
  await chmod(path, 0o644)
  await expect(readOwnerRepairSuccessorIntent(setup)).rejects.toThrow('unsafe private file')
  const occupied = await fixture()
  await mkdir(occupied.archivePath, { mode: 0o700 })
  await expect(createOwnerRepairSuccessorIntent(occupied)).rejects.toThrow('archive path already exists')
})

test('archives exact intent and accepted manifest, then replays after pending unlink', async () => {
  const setup = await fixture()
  const created = await createOwnerRepairSuccessorIntent(setup)
  await rename(setup.transactionPath, setup.archivePath)
  await expect(finalizeOwnerRepairSuccessorIntent({ ...setup, acceptedManifestSource: setup.accepted(created.digest),
    readinessVerified: false })).rejects.toThrow('readiness was not verified')
  const result = await finalizeOwnerRepairSuccessorIntent({ ...setup, acceptedManifestSource: setup.accepted(created.digest),
    readinessVerified: true, archivePath: setup.archivePath })
  expect(result.intentDigest).toBe(created.digest)
  expect(await readFile(join(setup.archivePath, 'owner-successor-intent.json'), 'utf8')).toBe(created.source)
  expect(await readFile(join(setup.archivePath, 'owner-successor-accepted-manifest.json'), 'utf8'))
    .toBe(setup.accepted(created.digest))
  expect(await peekOwnerRepairSuccessorIntent({ homePath: setup.homePath })).toBeUndefined()
  const replay = await finalizeOwnerRepairSuccessorIntent({ ...setup,
    acceptedManifestSource: setup.accepted(created.digest, { freshCheck: Date.now() }), readinessVerified: true,
    archivePath: setup.archivePath })
  expect(replay.acceptedManifestDigest).toBe(hash(setup.accepted(created.digest)))
})

test('rejects archive rename gaps and foreign archived bytes without replacing evidence', async () => {
  const setup = await fixture()
  const created = await createOwnerRepairSuccessorIntent(setup)
  await rename(setup.transactionPath, setup.archivePath)
  await rm(join(setup.archivePath, 'manifest.json'))
  await expect(finalizeOwnerRepairSuccessorIntent({ ...setup, acceptedManifestSource: setup.accepted(created.digest),
    readinessVerified: true, archivePath: setup.archivePath })).rejects.toThrow('manifest.json')
  await writeFile(join(setup.archivePath, 'manifest.json'), setup.oldManifestSource, { mode: 0o600 })
  await writeFile(join(setup.archivePath, 'owner-successor-intent.json'), created.source,
    { mode: 0o600, flag: 'wx' })
  await finalizeOwnerRepairSuccessorIntent({ ...setup, acceptedManifestSource: setup.accepted(created.digest),
    readinessVerified: true, archivePath: setup.archivePath })
  const held = join(setup.root, 'held-archive')
  await rename(setup.archivePath, held)
  await mkdir(setup.archivePath, { mode: 0o700 })
  await writeFile(join(setup.archivePath, 'manifest.json'), setup.oldManifestSource, { mode: 0o600 })
  const archivedIntentPath = join(setup.archivePath, 'owner-successor-intent.json')
  await writeFile(archivedIntentPath, 'foreign\n', { mode: 0o600 })
  await expect(readOwnerRepairSuccessorIntent({ ...setup, archivePath: setup.archivePath }))
    .rejects.toThrow('invalid pending intent')
  await writeFile(archivedIntentPath, created.source)
  await expect(readOwnerRepairSuccessorIntent({ ...setup, archivePath: setup.archivePath }))
    .rejects.toThrow('predecessor transaction identity changed')
})

test('reads the original signed authority from the predecessor backup when live Home is absent', async () => {
  const setup = await fixture()
  const created = await createOwnerRepairSuccessorIntent(setup)
  await rename(setup.transactionPath, setup.archivePath)
  await rename(setup.homePath, join(setup.root, 'held-home'))
  expect((await readOwnerRepairSuccessorIntent({ ...setup, archivePath: setup.archivePath })).digest)
    .toBe(created.digest)
  await expect(createOwnerRepairSuccessorIntent(setup)).rejects.toThrow()
  const backupKey = join(setup.archivePath, 'original-home', 'rsi-authorities', setup.profile,
    'identities', 'host.pem')
  await writeFile(backupKey, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }))
  await expect(readOwnerRepairSuccessorIntent({ ...setup, archivePath: setup.archivePath }))
    .rejects.toThrow('original authority key changed')
})

test('does not finalize a different successor or changed source commit', async () => {
  const setup = await fixture()
  const created = await createOwnerRepairSuccessorIntent(setup)
  await rename(setup.transactionPath, setup.archivePath)
  for (const acceptedManifestSource of [
    setup.accepted(created.digest).replace(successorTransactionId, oldTransactionId),
    setup.accepted(created.digest).replace(setup.candidateSourceCommit, 'e'.repeat(40)),
    setup.accepted('f'.repeat(64)),
    setup.accepted(created.digest).replace('"plan":true', '"plan":false'),
  ]) {
    await expect(finalizeOwnerRepairSuccessorIntent({ ...setup, acceptedManifestSource,
      readinessVerified: true, archivePath: setup.archivePath })).rejects.toThrow('accepted successor binding differs')
  }
  expect(await peekOwnerRepairSuccessorIntent({ homePath: setup.homePath })).toBeDefined()
})

test('binds a not-yet-created auxiliary destination without allowing overlap or dangling aliases', async () => {
  const setup = await fixture()
  const auxiliaryRoot = join(setup.root, 'auxiliary')
  expect(await createOwnerRepairSuccessorIntent({ ...setup, auxiliaryRoot })).toMatchObject({
    intent: { auxiliaryRoot } })
  expect(await lstat(auxiliaryRoot).then(() => true, error => error?.code !== 'ENOENT')).toBe(false)
  const overlap = await fixture()
  await expect(createOwnerRepairSuccessorIntent({ ...overlap, auxiliaryRoot: join(overlap.homePath, 'auxiliary') }))
    .rejects.toThrow('overlaps bound resources')
  const dangling = await fixture()
  const alias = join(dangling.root, 'dangling-auxiliary')
  await symlink(join(dangling.root, 'absent'), alias)
  await expect(createOwnerRepairSuccessorIntent({ ...dangling, auxiliaryRoot: alias }))
    .rejects.toThrow('dangling')
})
