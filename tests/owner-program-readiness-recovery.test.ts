import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { admitOwnerProgramReadinessRecovery, assertRecoveryEnvelope, createRecoveryReceipt,
  ownerProgramReadinessRecoveryTest as probe, readRecoveryReceipt,
  recoveryReceiptPath, verifyRecoveryEnvelope } from '../scripts/install/owner-program-readiness-recovery.mjs'

vi.mock('../scripts/install/local-source-maintenance.mjs', () => ({
  assertLocalSourceInstaller: vi.fn(async () => {}),
  bindLocalSourceInstaller: vi.fn(async (path: string) => ({ root: path,
    dev: '1', ino: '3', digest: 'a'.repeat(64), entries: 1 })),
}))

const temporaryRoots: string[] = []
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const homePath = '/private/test-owner-home'
const profile = 'owner'
const coordinator = `rsi-${profile}-${hash(profile).slice(0, 12)}`
const transactionId = '11111111-1111-4111-8111-111111111111'
const identity = { dev: '1', ino: '2', uid: 1000, mode: 16832 }
const installer = (path: string) => ({ root: path, dev: '1', ino: '3', digest: 'a'.repeat(64), entries: 1 })

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const host = { authority: 'host-installation', keyId: 'host-installation-key',
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  const plan = { originalRuntime: { root: '/private/old-host' }, candidateRuntime: { root: '/private/new-host' } }
  const oldInstaller = installer('/private/reviewed-original')
  const overlay = probe.signBody({ kind: 'rsi-owner-program-update-overlay', transactionId,
    dshHome: homePath, targetProfile: profile, installationId: 'installation' }, privateKey, host)
  const ownerUpdate = { homePath, profile, coordinatorProfile: coordinator, hostPlan: plan,
    hostPlanDigest: hash(JSON.stringify(plan)), installer: oldInstaller,
    original: { resources: { root: join(homePath, 'rsi-authorities', profile), installationId: 'installation',
      identities: { host } }, manifest: { sourceReviews: { owner: { id: 'original-owner' } } } } }
  const proof = { protocol: 'dsh-enhanced/host-owner-program-update/v1', installer: oldInstaller,
    ownerUpdate, ownerUpdateNext: { transactionId, overlay, manifestDigest: 'b'.repeat(64),
      overlayDigest: 'c'.repeat(64) }, candidate: { sourceCommit: 'd'.repeat(40) } }
  const manifest = { version: 4, operation: 'host-update', state: 'swapped', homePath,
    canonicalHome: homePath, profile, id: transactionId,
    transactionPath: `${homePath}.dsh-enhanced-transaction`, bindingDigest: 'e'.repeat(64),
    originalIdentity: { ...identity, ino: '1' }, stagedIdentity: identity,
    services: [profile, coordinator].map(name => ({ profile: name,
      unit: `dsh-profile-${name}.service`, wasActive: true })),
    unitUniverse: [profile, coordinator].map(name => `dsh-profile-${name}.service`),
    serviceMasks: [{}, {}], serviceStartBarriers: [{}, {}],
    containmentMasks: [], containmentMaskIntents: [], containmentStartBarriers: [],
    hostMigration: { candidateEverStarted: true, phase: 'starting', plan, localSource: proof } }
  const unsigned = probe.permitBody(manifest, installer(root))
  const permit = probe.signBody(unsigned, privateKey, host)
  return { manifest, permit, host, privateKey }
}

async function diskFixture() {
  const directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'readiness-recovery-')))
  temporaryRoots.push(directory)
  const home = join(directory, 'home'), backup = join(`${home}.dsh-enhanced-transaction`, 'original-home')
  const config = join(home, 'rsi-authorities', profile)
  const identities = join(config, 'identities')
  await mkdir(backup, { recursive: true, mode: 0o700 })
  await mkdir(identities, { recursive: true, mode: 0o700 })
  await mkdir(home, { recursive: true, mode: 0o700 })
  const fresh = fixture(), manifest = structuredClone(fresh.manifest)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const host = { authority: 'host-installation', keyId: 'host-installation-key',
    keyPath: join(identities, 'host.pem'),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  const resources = { root: config, installationId: 'installation', identities: { host } }
  const receiptBody = { schemaVersion: 1, dshHome: home, profile, resources,
    keyDigests: { host: hash(privatePem) } }
  await writeFile(host.keyPath, privatePem, { mode: 0o600 })
  await writeFile(join(config, 'bootstrap.json'), JSON.stringify({ ...receiptBody,
    receiptDigest: hash(JSON.stringify(receiptBody)) }), { mode: 0o600 })
  manifest.homePath = home
  manifest.canonicalHome = home
  manifest.transactionPath = `${home}.dsh-enhanced-transaction`
  manifest.originalIdentity = { ...manifest.originalIdentity, ...statIdentity(await lstat(backup)) }
  manifest.stagedIdentity = statIdentity(await lstat(home))
  manifest.hostMigration.localSource.ownerUpdate.homePath = home
  manifest.hostMigration.localSource.ownerUpdate.original.resources = resources
  manifest.hostMigration.localSource.ownerUpdateNext.overlay = probe.signBody({
    kind: 'rsi-owner-program-update-overlay', transactionId, dshHome: home,
    targetProfile: profile, installationId: 'installation' }, privateKey, host)
  const oldRoot = join(directory, 'old-installer')
  manifest.hostMigration.localSource.installer.root = oldRoot
  manifest.hostMigration.localSource.ownerUpdate.installer.root = oldRoot
  return { directory, home, backup, manifest, host, privateKey }
}

function statIdentity(entry: Awaited<ReturnType<typeof lstat>>) {
  return { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode }
}

test('one signed permit binds the original transaction, candidate inode, proof, plan and separate installer', () => {
  const { manifest, permit, host } = fixture()
  expect(assertRecoveryEnvelope(manifest, { permit }, homePath, profile, root)).toEqual(permit)
  expect(() => probe.verifySigned(permit, host)).not.toThrow()
  for (const changed of [
    { ...manifest, id: '22222222-2222-4222-8222-222222222222' },
    { ...manifest, stagedIdentity: { ...manifest.stagedIdentity, ino: '9' } },
    { ...manifest, serviceMasks: [{ unit: 'foreign.service' }, {}] },
    { ...manifest, unitUniverse: ['foreign.service', manifest.unitUniverse[1]] },
    { ...manifest, hostMigration: { ...manifest.hostMigration, plan: { ...manifest.hostMigration.plan, status: 'other' } } },
    { ...manifest, hostMigration: { ...manifest.hostMigration,
      localSource: { ...manifest.hostMigration.localSource, candidate: { sourceCommit: 'f'.repeat(40) } } } },
  ]) expect(() => assertRecoveryEnvelope(changed, { permit }, homePath, profile, root)).toThrow()
  expect(() => assertRecoveryEnvelope(manifest, { permit }, homePath, profile, '/private/other-root')).toThrow()
  expect(() => probe.verifySigned({ ...permit, issuedAt: permit.issuedAt + 1 }, host)).toThrow('Host signature differs')
})

test('prestart, another owner pair, accepted initial transaction and altered grant are rejected', () => {
  const { manifest, permit } = fixture()
  expect(() => probe.scope({ ...manifest, hostMigration: { ...manifest.hostMigration,
    candidateEverStarted: false } }, homePath, profile, true)).toThrow()
  expect(() => probe.scope({ ...manifest, services: [{ ...manifest.services[0], wasActive: false },
    manifest.services[1]] }, homePath, profile, true)).toThrow()
  expect(() => probe.scope({ ...manifest, serviceAcceptance: [] }, homePath, profile, true)).toThrow()
  const changed = structuredClone(manifest)
  changed.hostMigration.localSource.ownerUpdate.original.manifest.sourceReviews.owner.id = 'another-owner'
  expect(() => assertRecoveryEnvelope(changed, { permit }, homePath, profile, root)).toThrow()
  expect(() => assertRecoveryEnvelope(manifest, { permit, receipt: {} }, homePath, profile, root)).toThrow()
})

test('first admission accepts only bound stopped installed or staged mask states', () => {
  const assertStopped = lifecycleProfileTest.assertHostReadinessRecoveryStoppedServiceState
  const inactive = { loadState: 'loaded', unitFileState: 'disabled', activeState: 'inactive',
    subState: 'dead', mainPid: 0, controlPid: 0 }
  expect(() => assertStopped('staged', inactive)).not.toThrow()
  expect(() => assertStopped('installed', { ...inactive, loadState: 'masked',
    unitFileState: 'masked' })).not.toThrow()
  for (const [location, state] of [
    ['missing', inactive],
    ['staged', { ...inactive, activeState: 'active', subState: 'running', mainPid: 42 }],
    ['staged', { ...inactive, controlPid: 42 }],
    ['staged', { ...inactive, unitFileState: 'enabled' }],
    ['staged', { ...inactive, loadState: 'not-found' }],
    ['installed', inactive],
    ['installed', { ...inactive, loadState: 'masked', subState: 'failed' }],
  ] as const) expect(() => assertStopped(location, state)).toThrow('bound stopped services')
})

test('a persisted permit remains the same signed envelope through accepted and committed cleanup phases', () => {
  const { manifest, permit, host } = fixture()
  for (const phase of ['accepted', 'committed', 'cleanup-started']) {
    const replay = { ...manifest, state: phase === 'accepted' ? 'swapped' : phase,
      hostMigration: { ...manifest.hostMigration, phase, programReadinessRecovery: { permit } } }
    expect(probe.scope(replay, homePath, profile, false)).toBeDefined()
    expect(assertRecoveryEnvelope(replay, { permit }, homePath, profile, root)).toEqual(permit)
    expect(() => probe.verifySigned(permit, host)).not.toThrow()
  }
})

test('private Host key signs one permit; retry verifies the same signature and signed receipt', async () => {
  const f = await diskFixture()
  const first = await admitOwnerProgramReadinessRecovery({ manifest: f.manifest,
    homePath: f.home, profile, installerRoot: root })
  expect(first.created).toBe(true)
  await expect(verifyRecoveryEnvelope({ manifest: f.manifest, envelope: first.envelope,
    homePath: f.home, profile, installerRoot: root })).resolves.toEqual(first.envelope.permit)
  expect(() => probe.verifySigned(first.envelope.permit, f.host)).not.toThrow()
  const retry = structuredClone(f.manifest)
  retry.hostMigration.programReadinessRecovery = first.envelope
  retry.hostMigration.phase = 'accepted'
  retry.serviceAcceptance = [{ unit: retry.services[0].unit }]
  retry.bindingDigest = 'f'.repeat(64)
  const second = await admitOwnerProgramReadinessRecovery({ manifest: retry,
    homePath: f.home, profile, installerRoot: root })
  expect(second).toEqual({ envelope: first.envelope, created: false })
  expect(() => lifecycleProfileTest.assertReadinessRecoveryAdmissionGate(retry, {})).toThrow('explicit admitted')
  expect(() => lifecycleProfileTest.assertReadinessRecoveryAdmissionGate(retry, {
    readinessRecoveryPermitDigest: 'f'.repeat(64) })).toThrow('explicit admitted')
  expect(() => lifecycleProfileTest.assertReadinessRecoveryAdmissionGate(retry, {
    readinessRecoveryPermitDigest: hash(JSON.stringify(first.envelope.permit)) })).not.toThrow()
  const permitDigest = hash(probe.canonical(first.envelope.permit))
  await expect(readRecoveryReceipt({ manifest: retry, envelope: first.envelope,
    homePath: f.home, profile })).resolves.toBeUndefined()
  const receipt = await createRecoveryReceipt({ manifest: retry, envelope: first.envelope,
    homePath: f.home, profile, readiness: { mode: 'ready', permitDigest,
      manifestDigest: retry.hostMigration.localSource.ownerUpdateNext.manifestDigest,
      overlayDigest: retry.hostMigration.localSource.ownerUpdateNext.overlayDigest } })
  const path = recoveryReceiptPath(f.home, transactionId)
  await writeFile(path, JSON.stringify(receipt), { mode: 0o600 })
  expect(await readRecoveryReceipt({ manifest: retry, envelope: first.envelope,
    homePath: f.home, profile })).toEqual(receipt)
  await writeFile(path, JSON.stringify({ ...receipt, verifiedAt: receipt.verifiedAt + 1 }))
  await expect(readRecoveryReceipt({ manifest: retry, envelope: first.envelope,
    homePath: f.home, profile })).rejects.toThrow('Host signature differs')
  expect(await readFile(path, 'utf8')).toContain('verifiedAt')
})

test('unsafe private Host key and changed original overlay fail before permit issuance', async () => {
  const f = await diskFixture()
  const key = f.host.keyPath
  await chmod(key, 0o644)
  await expect(admitOwnerProgramReadinessRecovery({ manifest: f.manifest,
    homePath: f.home, profile, installerRoot: root })).rejects.toThrow('unsafe private file')
  await chmod(key, 0o600)
  f.manifest.hostMigration.localSource.ownerUpdateNext.overlay.issuedAt = Date.now()
  await expect(admitOwnerProgramReadinessRecovery({ manifest: f.manifest,
    homePath: f.home, profile, installerRoot: root })).rejects.toThrow('overlay signature differs')
  const replacement = join(f.directory, 'replacement-key')
  await writeFile(replacement, 'not a key', { mode: 0o600 })
  await rm(key)
  await symlink(replacement, key)
  await expect(admitOwnerProgramReadinessRecovery({ manifest: f.manifest,
    homePath: f.home, profile, installerRoot: root })).rejects.toThrow()
})

test.skipIf(process.platform !== 'linux')('an abandoned prepublication temporary file does not block atomic receipt publication', async () => {
  const f = await diskFixture()
  const destination = recoveryReceiptPath(f.home, transactionId)
  await writeFile(`${destination}.pending-crashed`, 'partial', { mode: 0o600 })
  await lifecycleProfileTest.publishReadinessRecoveryReceipt(destination, '{"complete":true}\n')
  expect(await readFile(destination, 'utf8')).toBe('{"complete":true}\n')
  await expect(lifecycleProfileTest.publishReadinessRecoveryReceipt(destination, '{"different":true}\n'))
    .rejects.toThrow()
  expect(await readFile(destination, 'utf8')).toBe('{"complete":true}\n')
})
