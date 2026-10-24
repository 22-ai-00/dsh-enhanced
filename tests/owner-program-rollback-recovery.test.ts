import { createHash, generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { AutomationStore } from '../plugins/assistant-automations/src/store.ts'
import { controlPlaneDigest } from '../plugins/plugin-control-plane/src/store.ts'
import { ownerRepairActivationInspector } from '../scripts/install/owner-repair-readiness.mjs'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { admitOwnerProgramRollbackRecovery, assertRollbackRecoveryEnvelope,
  createRollbackRecoveryIntent, createRollbackRecoveryReceipt, ownerProgramRollbackRecoveryTest as probe,
  publishRollbackRecoveryLocator, rollbackRecoveryTransactionIntentPath,
  readRollbackRecoveryIntentSource, readRollbackRecoveryReceipt, rollbackRecoveryArchivePath,
  rollbackRecoveryReceiptPath, verifyRollbackRecoveryEnvelope,
  verifyRollbackRecoveryIntent } from '../scripts/install/owner-program-rollback-recovery.mjs'

vi.mock('../scripts/install/local-source-maintenance.mjs', () => ({
  assertLocalSourceInstaller: vi.fn(async () => {}),
  bindLocalSourceInstaller: vi.fn(async (path: string) => ({ root: path,
    dev: '1', ino: '3', digest: 'a'.repeat(64), entries: 1 })),
}))

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'owner'
const coordinator = `rsi-${profile}-${hash(profile).slice(0, 12)}`
const transactionId = '11111111-1111-4111-8111-111111111111'
const installer = (path: string) => ({ root: path, dev: '1', ino: '3', digest: 'a'.repeat(64), entries: 1 })
const statIdentity = (entry: Awaited<ReturnType<typeof lstat>>) => ({
  dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode,
})

function fixture(homePath = '/private/test-owner-home') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const host = { authority: 'host-installation', keyId: 'host-installation-key',
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  const runtime = { version: '0.2.1-rc.2', root: '/private/hosts/0.2.1-rc.2' }
  const plan = { schemaVersion: 1, status: 'current', originalRuntime: runtime, candidateRuntime: runtime }
  const oldInstaller = installer('/private/reviewed-original')
  const ownerUpdate = { homePath, profile, coordinatorProfile: coordinator, hostPlan: plan,
    hostPlanDigest: hash(JSON.stringify(plan)), installer: oldInstaller,
    original: { resources: { root: join(homePath, 'rsi-authorities', profile), installationId: 'installation',
      identities: { host } }, manifest: { sourceReviews: { owner: { id: 'original-owner' } } } } }
  const proof = { protocol: 'dsh-enhanced/host-owner-program-update/v1', homePath, profile, installer: oldInstaller,
    ownerUpdate, candidate: { sourceCommit: 'd'.repeat(40) } }
  const services = [profile, coordinator].map((name, index) => ({ profile: name,
    unit: `dsh-profile-${name}.service`, wasActive: true,
    invocationId: String(index + 1).repeat(32) }))
  const units = services.map(service => ({ unit: service.unit, profile: service.profile,
    path: `/private/systemd/${service.unit}`, before: `[Service]\n${service.unit}\n`,
    beforeDigest: hash(`[Service]\n${service.unit}\n`) }))
  const createdAt = '2026-01-01T00:00:00.000Z'
  const activeServices = services.map((service, index) => ({ unit: service.unit, mainPid: 100 + index,
    invocationId: String(index + 3).repeat(32), nRestarts: 0,
    startTimestamp: 'Fri 2026-01-02 00:00:00.192232 UTC', startedAt: Date.parse('2026-01-02T00:00:00.193Z') }))
  const manifest = { version: 4, operation: 'host-update', state: 'preparing', homePath,
    canonicalHome: homePath, profile, id: transactionId, createdAt,
    transactionPath: `${homePath}.dsh-enhanced-transaction`, bindingDigest: 'e'.repeat(64),
    originalIdentity: { dev: '1', ino: '2', uid: 1000, mode: 16832 }, services,
    serviceMasks: [{}, {}], serviceStartBarriers: [{}, {}], containmentMasks: [],
    containmentMaskIntents: [], containmentStartBarriers: [],
    hostMigration: { candidateEverStarted: false, phase: 'prepared', plan, units, localSource: proof } }
  const permit = probe.signBody(probe.permitBody(manifest, installer(root), activeServices), privateKey, host)
  return { manifest, activeServices, permit, host, privateKey }
}

async function diskFixture() {
  const directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'rollback-readiness-')))
  roots.push(directory)
  const home = join(directory, 'home'), authority = join(home, 'rsi-authorities', profile)
  const identities = join(authority, 'identities')
  await mkdir(identities, { recursive: true, mode: 0o700 })
  const setup = fixture(home), manifest = structuredClone(setup.manifest)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const host = { authority: 'host-installation', keyId: 'host-installation-key',
    keyPath: join(identities, 'host.pem'), publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  const resources = { root: authority, installationId: 'installation', identities: { host } }
  const receiptBody = { schemaVersion: 1, dshHome: home, profile, resources,
    keyDigests: { host: hash(privatePem) } }
  await writeFile(host.keyPath, privatePem, { mode: 0o600 })
  await writeFile(join(authority, 'bootstrap.json'), JSON.stringify({ ...receiptBody,
    receiptDigest: hash(JSON.stringify(receiptBody)) }), { mode: 0o600 })
  manifest.originalIdentity = statIdentity(await lstat(home))
  manifest.hostMigration.localSource.ownerUpdate.original.resources = resources
  const oldRoot = join(directory, 'old-installer')
  manifest.hostMigration.localSource.installer.root = oldRoot
  manifest.hostMigration.localSource.ownerUpdate.installer.root = oldRoot
  return { directory, home, manifest, activeServices: setup.activeServices, host }
}

test('signed permit binds prepared original Home, owner, Host plan, old units, invocations and reviewed installer', () => {
  const { manifest, activeServices, permit, host } = fixture()
  expect(assertRollbackRecoveryEnvelope(manifest, { permit }, manifest.homePath, profile, root)).toEqual(permit)
  expect(() => probe.verifySigned(permit, host)).not.toThrow()
  for (const changed of [
    { ...manifest, id: '22222222-2222-4222-8222-222222222222' },
    { ...manifest, originalIdentity: { ...manifest.originalIdentity, ino: '9' } },
    { ...manifest, hostMigration: { ...manifest.hostMigration, candidateEverStarted: true } },
    { ...manifest, hostMigration: { ...manifest.hostMigration, phase: 'starting' } },
    { ...manifest, hostMigration: { ...manifest.hostMigration,
      units: [{ ...manifest.hostMigration.units[0], before: 'different', beforeDigest: hash('different') },
        manifest.hostMigration.units[1]] } },
    { ...manifest, hostMigration: { ...manifest.hostMigration,
      localSource: { ...manifest.hostMigration.localSource, candidate: { sourceCommit: 'f'.repeat(40) } } } },
  ]) expect(() => assertRollbackRecoveryEnvelope(changed, { permit }, manifest.homePath, profile, root)).toThrow()
  expect(() => probe.verifySigned({ ...permit,
    activeServices: [{ ...activeServices[0], mainPid: 999 }, activeServices[1]] }, host))
    .toThrow('Host signature differs')
  expect(() => assertRollbackRecoveryEnvelope(manifest, { permit }, manifest.homePath, profile,
    '/private/other-installer')).toThrow()
})

test('private Host key signs one permit; retry requires identical service identities and verifies durable receipt', async () => {
  const f = await diskFixture()
  const first = await admitOwnerProgramRollbackRecovery({ manifest: f.manifest,
    homePath: f.home, profile, installerRoot: root, activeServices: f.activeServices })
  expect(first.created).toBe(true)
  await expect(verifyRollbackRecoveryEnvelope({ manifest: f.manifest, envelope: first.envelope,
    homePath: f.home, profile, installerRoot: root })).resolves.toEqual(first.envelope.permit)
  const retry = structuredClone(f.manifest)
  retry.hostMigration.rollbackReadinessRecovery = first.envelope
  retry.bindingDigest = 'f'.repeat(64)
  await expect(admitOwnerProgramRollbackRecovery({ manifest: retry, homePath: f.home,
    profile, installerRoot: root, activeServices: f.activeServices })).resolves.toEqual({
    envelope: first.envelope, created: false,
  })
  await expect(admitOwnerProgramRollbackRecovery({ manifest: retry, homePath: f.home,
    profile, installerRoot: root, activeServices: [{ ...f.activeServices[0], mainPid: 999 }, f.activeServices[1]] }))
    .rejects.toThrow('invocation changed')
  const intent = await createRollbackRecoveryIntent({ manifest: retry, envelope: first.envelope,
    homePath: f.home, profile })
  expect(intent.archivePath).toBe(rollbackRecoveryArchivePath(f.home, profile, first.envelope.permit))
  await writeFile(rollbackRecoveryTransactionIntentPath(f.home, profile, retry.id), JSON.stringify(intent), { mode: 0o600 })
  await publishRollbackRecoveryLocator(f.home, profile, intent, () => Promise.reject(new Error('unexpected prior locator')))
  expect(await readRollbackRecoveryIntentSource(f.home, profile)).toEqual(intent)
  expect(await readRollbackRecoveryIntentSource(f.home, profile, retry.id)).toEqual(intent)
  await expect(verifyRollbackRecoveryIntent({ manifest: retry, envelope: first.envelope,
    intent, homePath: f.home, profile })).resolves.toEqual(intent)
  const receipt = await createRollbackRecoveryReceipt({ manifest: retry, envelope: first.envelope,
    intent, homePath: f.home, profile, accepted: f.activeServices })
  const path = rollbackRecoveryReceiptPath(f.home, profile, retry.id)
  await writeFile(path, JSON.stringify(receipt), { mode: 0o600 })
  expect(await readRollbackRecoveryReceipt({ manifest: retry, envelope: first.envelope, intent,
    homePath: f.home, profile })).toEqual(receipt)
  await writeFile(path, JSON.stringify({ ...receipt, verifiedAt: receipt.verifiedAt + 1 }))
  await expect(readRollbackRecoveryReceipt({ manifest: retry, envelope: first.envelope, intent,
    homePath: f.home, profile })).rejects.toThrow('Host signature differs')
  expect(await readFile(path, 'utf8')).toContain('verifiedAt')
})

test('unsafe Host key, replaced Home and wrong source root fail before permit issuance', async () => {
  const f = await diskFixture()
  await chmod(f.host.keyPath, 0o644)
  await expect(admitOwnerProgramRollbackRecovery({ manifest: f.manifest, homePath: f.home,
    profile, installerRoot: root, activeServices: f.activeServices })).rejects.toThrow('unsafe private file')
  await chmod(f.host.keyPath, 0o600)
  const replacement = join(f.directory, 'replacement-key')
  await writeFile(replacement, 'not a key', { mode: 0o600 })
  await rm(f.host.keyPath)
  await symlink(replacement, f.host.keyPath)
  await expect(admitOwnerProgramRollbackRecovery({ manifest: f.manifest, homePath: f.home,
    profile, installerRoot: root, activeServices: f.activeServices })).rejects.toThrow()
  await rm(f.host.keyPath)
  await writeFile(f.host.keyPath, 'not a key', { mode: 0o600 })
  const moved = { ...f.manifest, originalIdentity: { ...f.manifest.originalIdentity, ino: '9' } }
  await expect(admitOwnerProgramRollbackRecovery({ manifest: moved, homePath: f.home,
    profile, installerRoot: root, activeServices: f.activeServices })).rejects.toThrow('inode differs')
  await expect(admitOwnerProgramRollbackRecovery({ manifest: f.manifest, homePath: f.home,
    profile, installerRoot: '/private/other-root', activeServices: f.activeServices })).rejects.toThrow()
})

test.skipIf(process.platform !== 'linux')('systemd proof freezes a post-transaction running Invocation and C-locale start time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rollback-systemd-proof-'))
  roots.push(directory)
  const statePath = join(directory, 'state.json'), executable = join(directory, 'systemctl')
  const unit = 'dsh-profile-owner.service', invocationId = 'a'.repeat(32)
  const state = { Id: unit, LoadState: 'loaded', ActiveState: 'active', SubState: 'running',
    MainPID: '123', ControlPID: '0', InvocationID: invocationId, NRestarts: '0', UnitFileState: 'enabled',
    WorkingDirectory: '/private/home/profiles/owner',
    Environment: `DSH_HOME=/private/home PATH=/usr/bin:/bin DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${process.getuid()}/bus XDG_RUNTIME_DIR=/run/user/${process.getuid()}`,
    ExecMainStartTimestamp: 'Fri 2026-01-02 00:00:00.192232 UTC' }
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
  await writeFile(executable, `#!${process.execPath}\n`
    + `const fs=require('node:fs');const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));\n`
    + `if(process.env.TZ!=='UTC'||(process.argv.includes('--property=ExecMainStartTimestamp')&&!process.argv.includes('--timestamp=us')))process.exit(17);\n`
    + `for(const arg of process.argv.filter(value=>value.startsWith('--property='))){const key=arg.slice(11);process.stdout.write(key+'='+state[key]+'\\n')}\n`, { mode: 0o700 })
  const service = { unit, invocationId: 'b'.repeat(32), serviceHome: '/private/home',
    pathEnvironment: 'PATH=/usr/bin:/bin' }
  await expect(lifecycleProfileTest.originalRunningServiceProof(executable, service,
    '2026-01-01T00:00:00.000Z')).resolves.toMatchObject({
    unit, mainPid: 123, invocationId, startTimestamp: state.ExecMainStartTimestamp,
    startedAt: Date.parse('2026-01-02T00:00:00.193Z'),
  })
  state.InvocationID = service.invocationId
  await writeFile(statePath, JSON.stringify(state))
  await expect(lifecycleProfileTest.originalRunningServiceProof(executable, service,
    '2026-01-01T00:00:00.000Z')).rejects.toThrow('fresh running invocation')
  state.InvocationID = invocationId
  state.ExecMainStartTimestamp = 'Thu 2025-12-31 00:00:00.000000 UTC'
  await writeFile(statePath, JSON.stringify(state))
  await expect(lifecycleProfileTest.originalRunningServiceProof(executable, service,
    '2026-01-01T00:00:00.000Z')).rejects.toThrow('post-transaction start timestamp')
})

test.skipIf(process.platform !== 'linux')('new rollback rejects a truncated Lark journal instead of missing a later disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rollback-lark-journal-'))
  roots.push(directory)
  const journalctl = join(directory, 'journalctl')
  await writeFile(journalctl, `#!${process.execPath}\n`
    + `process.stdout.write('lark-channel: connected\\n' + 'x'.repeat(17 * 1024 * 1024) + '\\nlark-channel: disconnected\\n')\n`,
  { mode: 0o700 })
  await expect(lifecycleProfileTest.larkJournalStates(journalctl,
    { unit: 'dsh-profile-owner.service', invocationId: 'a'.repeat(32) }, { rejectTruncated: true }))
    .rejects.toThrow('output exceeds verification limit')
})

test.skipIf(process.platform !== 'linux')('exact owner activation survives a live WAL writer while stale time, owner and scope fail', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rollback-activation-wal-')))
  roots.push(directory)
  const homePath = join(directory, 'home')
  const coordinatorProfile = 'rsi-owner'
  const database = join(homePath, 'rsi-coordinators', coordinatorProfile, 'automations.sqlite')
  const scope = { workspace: '/work/owner', preset: 'primary', principalId: 'owner:test', ownerRouteId: 'owner-route' }
  const coordinatorId = 'exact-coordinator'
  const id = `adoption-coordinator-${controlPlaneDigest({ coordinatorId, scope }).slice(0, 40)}`
  const initial = Date.now() - 10_000
  const store = new AutomationStore({ path: database, now: () => initial })
  const definition = { name: 'Coordinate adoption', schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    workspace: scope.workspace, agentPreset: scope.preset, timeoutMs: 60_000,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: scope.principalId, execution: { kind: 'host', executorId: 'plugin-control-plane-adoption-coordinator-v1',
      executorContractVersion: 1, runbookId: 'coordinate', runbookVersion: 1, catalogDigest: 'a'.repeat(64),
      targetScope: { workspace: scope.workspace, preset: scope.preset },
      scopeDigest: controlPlaneDigest([scope.workspace, scope.preset]), ownerRouteId: scope.ownerRouteId,
      activationNonce: 'nonce' } }
  store.reconcileSystemOwned({ owner: 'plugin-control-plane-adoption-coordinator', automationId: id,
    idempotencyKey: 'create-exact-coordinator', definition })
  store.close()
  const ownerRepair = { homePath, profile, coordinatorProfile, installer: installer(root),
    original: { manifest: { targetProfile: profile, coordinatorProfile,
      controlPlane: { taskObservations: { scope }, sourceAdoptions: { handoff: { coordinatorId } } } } } }
  const inspect = await ownerRepairActivationInspector({ ownerRepair, installer: installer(root),
    homePath, targetProfile: profile, coordinatorProfile })
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1])
    db.exec('PRAGMA wal_autocheckpoint=0')
    const query = db.prepare('UPDATE automation_definitions SET updated_at = updated_at + 1 WHERE id = ?')
    const timer = setInterval(() => { db.exec('BEGIN IMMEDIATE'); query.run(process.argv[2]); db.exec('COMMIT');
      process.stdout.write('updated\\n') }, 2)
    process.stdin.on('data', () => { clearInterval(timer); db.close(); process.exit(0) })
  `, database, id], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      writer.stdout.once('data', () => resolveReady())
      writer.once('error', rejectReady)
      writer.once('exit', code => rejectReady(new Error(`WAL writer exited ${code}`)))
    })
    for (let count = 0; count < 5; count += 1) expect(inspect(initial)).toBe(true)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    expect(inspect(initial)).toBe(true)
    writer.stdin.write('stop')
    await new Promise<void>(resolveExit => writer.once('exit', () => resolveExit()))
    const connection = new DatabaseSync(database)
    connection.exec('PRAGMA journal_mode=DELETE')
    const row = connection.prepare('SELECT updated_at FROM automation_definitions WHERE id = ?').get(id) as
      { updated_at: number }
    expect(row.updated_at).toBeGreaterThan(initial + 1)
    connection.close()
    expect(inspect(row.updated_at + 1_000_000)).toBe(false)
    const changedOwner = new DatabaseSync(database)
    changedOwner.prepare('UPDATE automation_definitions SET system_owner = ? WHERE id = ?').run('other-owner', id)
    changedOwner.close()
    expect(inspect(initial)).toBe(false)
    const changedScope = new DatabaseSync(database)
    changedScope.prepare('UPDATE automation_definitions SET system_owner = ? WHERE id = ?')
      .run('plugin-control-plane-adoption-coordinator', id)
    changedScope.close()
    const otherScope = structuredClone(ownerRepair)
    otherScope.original.manifest.controlPlane.taskObservations.scope.ownerRouteId = 'other-route'
    const inspectOtherScope = await ownerRepairActivationInspector({ ownerRepair: otherScope,
      installer: installer(root), homePath, targetProfile: profile, coordinatorProfile })
    expect(inspectOtherScope(initial)).toBe(false)
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) {
      writer.stdin.write('stop')
      await new Promise<void>(resolveExit => writer.once('exit', () => resolveExit()))
    }
  }
})

test('Lark stability rejects every disconnect after the first accepted sample', () => {
  const inspect = lifecycleProfileTest.assertRollbackLarkWindow
  const baseline = inspect(['connected'], undefined)
  expect(baseline).toBe(1)
  expect(inspect(['connected', 'connected-with-gap', 'connected'], baseline)).toBe(1)
  expect(() => inspect(['connected', 'disconnected', 'connected'], baseline)).toThrow('connection state')
  expect(() => inspect(['connected', 'disconnected'], baseline)).toThrow('connection state')
  expect(() => inspect([], baseline)).toThrow('connection state')
})

test.skipIf(process.platform !== 'linux')('a deterministic archived transaction is complete only with its signed intent and receipt', async () => {
  const f = await diskFixture()
  const transactionRoot = `${f.home}.dsh-enhanced-transaction`
  await mkdir(transactionRoot, { mode: 0o700 })
  const runtime = { version: '0.2.1-rc.2', root: '/private/hosts/0.2.1-rc.2',
    dshPath: '/private/hosts/0.2.1-rc.2/node_modules/.bin/dsh',
    binDirectory: '/private/hosts/0.2.1-rc.2/node_modules/.bin',
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, receiptDigest: 'a'.repeat(64) }
  const binding = `${JSON.stringify({ schemaVersion: 1, cacheRoot: '/private/hosts',
    version: runtime.version, receiptDigest: runtime.receiptDigest })}\n`
  const plan = { schemaVersion: 1, status: 'current', canonicalHome: f.home,
    bindingPath: join(f.home, '.dsh-rsi-host.json'), originalBindingSource: binding,
    originalBindingDigest: hash(binding), originalRuntime: runtime,
    candidateRuntime: runtime, candidateBindingSource: binding }
  const services = f.manifest.services.map((service: typeof f.manifest.services[number], index: number) => ({
    ...service, mainPid: 40 + index,
  }))
  const units = services.map((service: typeof services[number]) => ({ unit: service.unit, profile: service.profile,
    path: join(f.directory, service.unit), before: `[Service]\n${service.unit}\n`,
    after: `[Service]\n${service.unit}\n`, beforeDigest: hash(`[Service]\n${service.unit}\n`),
    afterDigest: hash(`[Service]\n${service.unit}\n`), pathEnvironment: 'PATH=/usr/bin' }))
  const masks = services.map((service: typeof services[number]) => ({ unit: service.unit,
    path: join(process.env.HOME ?? '', '.config', 'systemd', 'user.control', service.unit),
    stagingPath: join(transactionRoot, 'service-mask-staging', 'managed', service.unit),
    transactionRoot, target: '/dev/null',
    identity: { dev: '1', ino: '2', uid: process.getuid(), mode: 41471 } }))
  const originalReadiness = { schemaVersion: 1, services: services.map((service: typeof services[number]) => ({
    unit: service.unit, profile: service.profile, invocationId: service.invocationId,
    mainPid: service.mainPid, hostReady: true,
    coordinatorActivated: service.profile === coordinator ? true : null })) }
  const manifest = structuredClone(f.manifest)
  manifest.transactionIdentity = statIdentity(await lstat(transactionRoot))
  manifest.originalProfileDigest = 'a'.repeat(64)
  manifest.unitUniverse = services.map((service: typeof services[number]) => service.unit)
  manifest.foreignOwnership = []
  manifest.services = services
  manifest.serviceMasks = masks
  manifest.serviceStartBarriers = services.map((service: typeof services[number]) => ({
    unit: service.unit, originalUnitFileState: 'disabled' }))
  manifest.hostMigration.plan = plan
  manifest.hostMigration.bwrapExecutable = '/usr/bin/true'
  manifest.hostMigration.originalExternalLinksDigest = 'a'.repeat(64)
  manifest.hostMigration.units = units
  manifest.hostMigration.originalReadiness = originalReadiness
  manifest.hostMigration.localSource.ownerUpdate.hostPlan = plan
  manifest.hostMigration.localSource.ownerUpdate.hostPlanDigest = hash(JSON.stringify(plan))
  let persisted = await lifecycleProfileTest.writeManifest(transactionRoot, manifest, 'preparing')
  const first = await admitOwnerProgramRollbackRecovery({ manifest: persisted,
    homePath: f.home, profile, installerRoot: root, activeServices: f.activeServices })
  persisted = await lifecycleProfileTest.writeManifest(transactionRoot, { ...persisted,
    hostMigration: { ...persisted.hostMigration, rollbackReadinessRecovery: first.envelope } }, 'preparing')
  expect(() => lifecycleProfileTest.assertReadinessRecoveryAdmissionGate(persisted, {}))
    .toThrow('explicit admitted lifecycle operation')
  expect(() => lifecycleProfileTest.assertReadinessRecoveryAdmissionGate(persisted, {
    rollbackReadinessPermitDigest: hash(JSON.stringify(first.envelope.permit)),
  })).not.toThrow()
  const intent = await createRollbackRecoveryIntent({ manifest: persisted, envelope: first.envelope,
    homePath: f.home, profile })
  await writeFile(rollbackRecoveryTransactionIntentPath(f.home, profile, persisted.id), JSON.stringify(intent), { mode: 0o600 })
  await publishRollbackRecoveryLocator(f.home, profile, intent, () => Promise.reject(new Error('unexpected prior locator')))
  await rename(transactionRoot, intent.archivePath)
  const input = { homePath: f.home, physicalHomePath: f.home, profile, transactionRoot,
    physicalTransactionRoot: transactionRoot, serviceContext: {}, installerRoot: root }
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(input))
    .rejects.toThrow('no signed readiness attestation')
  const receipt = await createRollbackRecoveryReceipt({ manifest: persisted, envelope: first.envelope,
    intent, homePath: f.home, profile, accepted: f.activeServices })
  await writeFile(rollbackRecoveryReceiptPath(f.home, profile, persisted.id), JSON.stringify(receipt), { mode: 0o600 })
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(input)).resolves.toBeUndefined()
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(input)).resolves.toBeUndefined()
  expect(statIdentity(await lstat(f.home))).toEqual(persisted.originalIdentity)

  // Simulate a later legitimate Home replacement: A remains historical evidence,
  // while B binds the current inode and may reuse this original Host authority.
  const previousHome = join(f.directory, 'previous-home')
  await rename(f.home, previousHome)
  await cp(previousHome, f.home, { recursive: true })
  expect(statIdentity(await lstat(f.home))).not.toEqual(persisted.originalIdentity)
  const nextRoot = `${f.home}.dsh-enhanced-transaction`
  await mkdir(nextRoot, { mode: 0o700 })
  const next = structuredClone(persisted)
  next.id = '22222222-2222-4222-8222-222222222222'
  next.originalIdentity = statIdentity(await lstat(f.home))
  next.transactionIdentity = statIdentity(await lstat(nextRoot))
  delete next.hostMigration.rollbackReadinessRecovery
  let nextPersisted = await lifecycleProfileTest.writeManifest(nextRoot, next, 'preparing')
  const nextAdmission = await admitOwnerProgramRollbackRecovery({ manifest: nextPersisted,
    homePath: f.home, profile, installerRoot: root, activeServices: f.activeServices })
  nextPersisted = await lifecycleProfileTest.writeManifest(nextRoot, { ...nextPersisted,
    hostMigration: { ...nextPersisted.hostMigration,
      rollbackReadinessRecovery: nextAdmission.envelope } }, 'preparing')
  const nextIntent = await createRollbackRecoveryIntent({ manifest: nextPersisted,
    envelope: nextAdmission.envelope, homePath: f.home, profile })
  await writeFile(rollbackRecoveryTransactionIntentPath(f.home, profile, nextPersisted.id),
    JSON.stringify(nextIntent), { mode: 0o600 })
  expect(await readRollbackRecoveryIntentSource(f.home, profile)).toEqual(intent)
  await expect(publishRollbackRecoveryLocator(f.home, profile, nextIntent,
    async () => { throw new Error('prior archive verification interrupted') }))
    .rejects.toThrow('prior archive verification interrupted')
  expect(await readRollbackRecoveryIntentSource(f.home, profile)).toEqual(intent)
  const verifyPrevious = async (prior: typeof intent) => {
    expect(prior).toEqual(intent)
    await verifyRollbackRecoveryIntent({ manifest: persisted, envelope: first.envelope,
      intent: prior, homePath: f.home, profile, historical: true })
    expect(await readRollbackRecoveryReceipt({ manifest: persisted, envelope: first.envelope,
      intent: prior, homePath: f.home, profile, historical: true })).toEqual(receipt)
  }
  await expect(publishRollbackRecoveryLocator(f.home, profile, nextIntent, verifyPrevious)).resolves.toBe(true)
  await expect(publishRollbackRecoveryLocator(f.home, profile, nextIntent, verifyPrevious)).resolves.toBe(false)
  expect(await readRollbackRecoveryIntentSource(f.home, profile)).toEqual(nextIntent)
  expect(await readRollbackRecoveryIntentSource(f.home, profile, persisted.id)).toEqual(intent)
  expect(await readRollbackRecoveryReceipt({ manifest: persisted, envelope: first.envelope,
    intent, homePath: f.home, profile, historical: true })).toEqual(receipt)
  const nextReceipt = await createRollbackRecoveryReceipt({ manifest: nextPersisted,
    envelope: nextAdmission.envelope, intent: nextIntent, homePath: f.home, profile,
    accepted: f.activeServices })
  await writeFile(rollbackRecoveryReceiptPath(f.home, profile, nextPersisted.id),
    JSON.stringify(nextReceipt), { mode: 0o600 })
  await rename(nextRoot, nextIntent.archivePath)
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(input)).resolves.toBeUndefined()
  expect(await readRollbackRecoveryIntentSource(f.home, profile)).toEqual(nextIntent)
})
