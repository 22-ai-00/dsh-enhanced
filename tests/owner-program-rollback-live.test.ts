import { createHash, generateKeyPairSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { AutomationStore } from '../plugins/assistant-automations/src/store.ts'
import { controlPlaneDigest } from '../plugins/plugin-control-plane/src/store.ts'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { readRollbackRecoveryIntentSource, readRollbackRecoveryReceipt,
  rollbackRecoveryIntentPath, rollbackRecoveryReceiptPath,
  rollbackRecoveryTransactionIntentPath, verifyRollbackRecoveryEnvelope,
  verifyRollbackRecoveryIntent } from '../scripts/install/owner-program-rollback-recovery.mjs'

vi.mock('../scripts/install/local-source-maintenance.mjs', () => ({
  assertLocalSourceInstaller: vi.fn(async () => {}),
  bindLocalSourceInstaller: vi.fn(async (path: string) => ({ root: path,
    dev: '1', ino: '3', digest: 'a'.repeat(64), entries: 1 })),
}))
vi.mock('../scripts/install/host-local-source-update.mjs', () => ({
  verifyHostLocalSourceOriginalForPrestartRecovery: vi.fn(async () => {}),
}))

const roots: string[] = []
const writers: ChildProcessWithoutNullStreams[] = []
const originalHome = process.env.HOME
afterEach(async () => {
  for (const writer of writers.splice(0)) {
    if (writer.exitCode === null) { writer.stdin.write('stop\n'); await once(writer, 'exit') }
  }
  process.env.HOME = originalHome
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const identity = (entry: Awaited<ReturnType<typeof lstat>>) => ({
  dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode,
})
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'owner'
const coordinator = `rsi-${profile}-${sha256(profile).slice(0, 12)}`
const transactionId = '11111111-1111-4111-8111-111111111111'
const installer = (path: string) => ({ root: path, dev: '1', ino: '3', digest: 'a'.repeat(64), entries: 1 })

async function runtimeFixture(directory: string) {
  const version = '0.2.1-rc.2'
  const cacheRoot = join(directory, 'hosts')
  const runtimeRoot = join(cacheRoot, version)
  const binDirectory = join(runtimeRoot, 'node_modules', '.bin')
  const dshPath = join(binDirectory, 'dsh')
  await mkdir(binDirectory, { recursive: true, mode: 0o700 })
  await writeFile(dshPath, `#!${process.execPath}\nprocess.stdout.write('${version}\\n')\n`, { mode: 0o700 })
  for (const path of [cacheRoot, runtimeRoot, join(runtimeRoot, 'node_modules')]) await chmod(path, 0o700)
  const entries: Record<string, unknown>[] = []
  const walk = async (directoryPath: string) => {
    for (const name of (await readdir(directoryPath)).sort()) {
      const path = join(directoryPath, name), entry = await lstat(path)
      const item = { path: relative(runtimeRoot, path), mode: entry.mode & 0o777 }
      if (entry.isDirectory()) { entries.push({ path: item.path, type: 'directory', mode: item.mode }); await walk(path) }
      else entries.push({ path: item.path, type: 'file', mode: item.mode, sha256: sha256(await readFile(path)) })
    }
  }
  await walk(runtimeRoot)
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`
  const receipt = { schemaVersion: 1, version, integrity, tarball: 'fixture', entries }
  await writeFile(join(runtimeRoot, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 })
  return { version, root: runtimeRoot, dshPath, binDirectory, integrity,
    receiptDigest: sha256(JSON.stringify(receipt)), cacheRoot }
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rollback-live-')))
  roots.push(directory)
  const fakeHome = join(directory, 'user'), homePath = join(directory, 'home')
  process.env.HOME = fakeHome
  const transactionRoot = `${homePath}.dsh-enhanced-transaction`
  const userControl = join(fakeHome, '.config', 'systemd', 'user.control')
  const wants = join(fakeHome, '.config', 'systemd', 'user', 'default.target.wants')
  await mkdir(userControl, { recursive: true, mode: 0o700 })
  await mkdir(wants, { recursive: true, mode: 0o700 })
  await mkdir(transactionRoot, { mode: 0o700 })
  await mkdir(homePath, { mode: 0o700 })
  const runtime = await runtimeFixture(directory)
  const bindingSource = `${JSON.stringify({ schemaVersion: 1, cacheRoot: runtime.cacheRoot,
    version: runtime.version, receiptDigest: runtime.receiptDigest })}\n`
  await writeFile(join(homePath, '.dsh-rsi-host.json'), bindingSource, { mode: 0o600 })
  const { cacheRoot: _cacheRoot, ...hostRuntime } = runtime
  const plan = { schemaVersion: 1, status: 'current', canonicalHome: homePath,
    bindingPath: join(homePath, '.dsh-rsi-host.json'), originalBindingSource: bindingSource,
    originalBindingDigest: sha256(bindingSource), originalRuntime: hostRuntime,
    candidateRuntime: hostRuntime, candidateBindingSource: bindingSource }
  const profileBytes = Buffer.from('{"name":"fixture-owner"}\n')
  const active = [profile, coordinator].map((name, index) => ({
    unit: `dsh-profile-${name}.service`, mainPid: 200 + index,
    invocationId: String(index + 3).repeat(32), nRestarts: 0,
    startTimestamp: 'Fri 2026-01-02 00:00:00.000000 UTC', startedAt: Date.parse('2026-01-02T00:00:00Z'),
  }))
  const services = []
  const units = []
  const masks = []
  const barriers = []
  for (const [index, name] of [profile, coordinator].entries()) {
    const unit = `dsh-profile-${name}.service`
    const source = `[Service]\n${unit}\n`
    const fragmentPath = join(fakeHome, '.config', 'systemd', 'user', unit)
    await writeFile(fragmentPath, source, { mode: 0o600 })
    await mkdir(join(homePath, 'profiles', name), { recursive: true, mode: 0o700 })
    await writeFile(join(homePath, 'profiles', name, 'package.json'), profileBytes, { mode: 0o600 })
    const maskPath = join(userControl, unit)
    const maskStaging = join(transactionRoot, 'service-mask-staging', 'managed', unit)
    await mkdir(dirname(maskStaging), { recursive: true, mode: 0o700 })
    await symlink('/dev/null', maskPath)
    const enablementPath = join(wants, unit)
    const enablementStaging = join(transactionRoot, 'service-enablement', unit)
    await mkdir(dirname(enablementStaging), { recursive: true, mode: 0o700 })
    await symlink(fragmentPath, enablementStaging)
    services.push({ unit, profile: name, wasActive: true, serviceHome: homePath,
      pathEnvironment: 'PATH=/usr/bin:/bin', fragment: { path: fragmentPath }, dropIns: [],
      mainPid: 100 + index, invocationId: String(index + 1).repeat(32), nRestarts: 0 })
    units.push({ unit, profile: name, path: fragmentPath, before: source, after: source,
      beforeDigest: sha256(source), afterDigest: sha256(source) })
    masks.push({ unit, path: maskPath, stagingPath: maskStaging, transactionRoot,
      target: '/dev/null', identity: identity(await lstat(maskPath)) })
    barriers.push({ unit, originalUnitFileState: 'enabled', disableIntentAt: '2026-01-01T00:00:00.000Z',
      enablement: { path: enablementPath, stagingPath: enablementStaging, transactionRoot,
        target: fragmentPath, identity: identity(await lstat(enablementStaging)) } })
  }
  const authority = join(homePath, 'rsi-authorities', profile)
  const identities = join(authority, 'identities')
  await mkdir(identities, { recursive: true, mode: 0o700 })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const host = { authority: 'host-installation', keyId: 'host-installation-key',
    keyPath: join(identities, 'host.pem'), publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  const resources = { root: authority, installationId: 'installation', identities: { host } }
  const bootstrap = { schemaVersion: 1, dshHome: homePath, profile, resources,
    keyDigests: { host: sha256(privatePem) } }
  await writeFile(host.keyPath, privatePem, { mode: 0o600 })
  await writeFile(join(authority, 'bootstrap.json'), JSON.stringify({ ...bootstrap,
    receiptDigest: sha256(JSON.stringify(bootstrap)) }), { mode: 0o600 })

  const scope = { workspace: '/work/owner', preset: 'primary', principalId: 'owner:test', ownerRouteId: 'owner-route' }
  const coordinatorId = 'exact-coordinator'
  const automationId = `adoption-coordinator-${controlPlaneDigest({ coordinatorId, scope }).slice(0, 40)}`
  const databasePath = join(homePath, 'rsi-coordinators', coordinator, 'automations.sqlite')
  const automations = new AutomationStore({ path: databasePath, now: () => Date.now() })
  automations.reconcileSystemOwned({ owner: 'plugin-control-plane-adoption-coordinator', automationId,
    idempotencyKey: 'create-exact-coordinator', definition: {
      name: 'Coordinate adoption', schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      workspace: scope.workspace, agentPreset: scope.preset, timeoutMs: 60_000,
      misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      principal: scope.principalId, execution: { kind: 'host', executorId: 'plugin-control-plane-adoption-coordinator-v1',
        executorContractVersion: 1, runbookId: 'coordinate', runbookVersion: 1, catalogDigest: 'a'.repeat(64),
        targetScope: { workspace: scope.workspace, preset: scope.preset },
        scopeDigest: controlPlaneDigest([scope.workspace, scope.preset]), ownerRouteId: scope.ownerRouteId,
        activationNonce: 'nonce' },
    } })
  automations.close()
  const ownerWriter = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1])
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    process.stdout.write('ready\\n')
    process.stdin.on('data', data => {
      const command = String(data).trim()
      if (command === 'stop') { db.close(); process.exit(0) }
      db.prepare('UPDATE automation_definitions SET system_owner = ? WHERE id = ?')
        .run(command, process.argv[2])
      process.stdout.write('done\\n')
    })
  `, databasePath, automationId], { stdio: ['pipe', 'pipe', 'pipe'] })
  writers.push(ownerWriter)
  expect(String((await once(ownerWriter.stdout, 'data'))[0])).toContain('ready')
  const setOwner = async (owner: string) => {
    const acknowledged = once(ownerWriter.stdout, 'data')
    ownerWriter.stdin.write(`${owner}\n`)
    expect(String((await acknowledged)[0])).toContain('done')
  }

  const oldInstaller = installer(join(directory, 'old-installer'))
  for (const name of ['assistant-automations', 'plugin-control-plane']) {
    const source = join(root, 'plugins', name), destination = join(oldInstaller.root, 'plugins', name)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await cp(join(source, 'lib'), join(destination, 'lib'), { recursive: true })
    await cp(join(source, 'package.json'), join(destination, 'package.json'))
  }
  await symlink(join(root, 'node_modules'), join(oldInstaller.root, 'node_modules'))
  const ownerUpdate = { homePath, profile, coordinatorProfile: coordinator, hostPlan: plan,
    hostPlanDigest: sha256(JSON.stringify(plan)), installer: oldInstaller,
    original: { resources, manifest: { targetProfile: profile, coordinatorProfile: coordinator,
      sourceReviews: { owner: { id: 'original-owner' } },
      controlPlane: { taskObservations: { scope }, sourceAdoptions: { handoff: { coordinatorId } } } } } }
  const proof = { protocol: 'dsh-enhanced/host-owner-program-update/v1', homePath, profile,
    installer: oldInstaller, ownerUpdate, candidate: { sourceCommit: 'd'.repeat(40) } }
  const manifest = { version: 4, operation: 'host-update', state: 'preparing', homePath,
    canonicalHome: homePath, profile, id: transactionId, createdAt: '2026-01-01T00:00:00.000Z',
    transactionPath: transactionRoot, transactionIdentity: identity(await lstat(transactionRoot)),
    originalIdentity: identity(await lstat(homePath)), originalProfileDigest: sha256(profileBytes),
    services, unitUniverse: services.map(service => service.unit).sort(), foreignOwnership: [],
    serviceMasks: masks, serviceStartBarriers: barriers, containmentMasks: [],
    containmentMaskIntents: [], containmentStartBarriers: [],
    hostMigration: { candidateEverStarted: false, phase: 'prepared', plan, units,
      bwrapExecutable: '/usr/bin/true', originalExternalLinksDigest: 'a'.repeat(64), localSource: proof,
      originalReadiness: { schemaVersion: 1, services: services.map(service => ({ unit: service.unit,
        profile: service.profile, invocationId: service.invocationId, mainPid: service.mainPid,
        hostReady: true, coordinatorActivated: service.profile === coordinator ? true : null })) } } }
  await lifecycleProfileTest.writeManifest(transactionRoot, manifest, 'preparing')

  const statePath = join(directory, 'systemd-state.json'), logPath = join(directory, 'systemctl.log')
  const journalModePath = join(directory, 'journal-mode.json')
  await writeFile(statePath, JSON.stringify({ homePath, active,
    units: Object.fromEntries(units.map(unit => [unit.unit, {
      fragment: unit.path, mask: join(userControl, unit.unit), enablement: join(wants, unit.unit),
    }])) }), { mode: 0o600 })
  await writeFile(logPath, '', { mode: 0o600 })
  await writeFile(journalModePath, JSON.stringify({ disconnected: true }), { mode: 0o600 })
  const systemctlExecutable = join(directory, 'systemctl')
  await writeFile(systemctlExecutable, `#!${process.execPath}\n`
    + `const fs=require('node:fs'); const data=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));\n`
    + `const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify(args)+'\\n');\n`
    + `const command=args.includes('show')?'show':args.includes('list-unit-files')?'list-unit-files':args.includes('list-units')?'list-units':args.includes('daemon-reload')?'daemon-reload':'';\n`
    + `if(command==='daemon-reload')process.exit(0);\n`
    + `if(command==='list-unit-files'||command==='list-units'){for(const unit of Object.keys(data.units).sort())process.stdout.write(unit+' loaded\\n');process.exit(0)}\n`
    + `if(command!=='show')process.exit(19);\n`
    + `const unit=args[args.indexOf('show')+1], item=data.units[unit], active=data.active.find(x=>x.unit===unit);if(!item||!active)process.exit(20);\n`
    + `const masked=fs.existsSync(item.mask), enabled=fs.existsSync(item.enablement);\n`
    + `const props={Id:unit,LoadState:masked?'masked':'loaded',UnitFileState:masked?'masked':enabled?'enabled':'disabled',ActiveState:'active',SubState:'running',MainPID:active.mainPid,ControlPID:0,InvocationID:active.invocationId,NRestarts:active.nRestarts,FragmentPath:item.fragment,DropInPaths:'',WorkingDirectory:data.homePath+'/profiles/'+unit.slice(12,-8),Environment:'DSH_HOME='+data.homePath+' PATH=/usr/bin:/bin DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${process.getuid()}/bus XDG_RUNTIME_DIR=/run/user/${process.getuid()}',ExecMainStartTimestamp:active.startTimestamp};\n`
    + `for(const arg of args.filter(value=>value.startsWith('--property='))){const key=arg.slice(11);process.stdout.write(key+'='+props[key]+'\\n')}\n`,
  { mode: 0o700 })
  const journalctlExecutable = join(directory, 'journalctl')
  const receiptPath = rollbackRecoveryReceiptPath(homePath, profile, transactionId)
  await writeFile(journalctlExecutable, `#!${process.execPath}\n`
    + `const fs=require('node:fs');const state=JSON.parse(fs.readFileSync(${JSON.stringify(journalModePath)},'utf8'));\n`
    + `process.stdout.write('dsh-enhanced host ready: v1\\n');\n`
    + `if(process.argv.includes('--unit')&&process.argv[process.argv.indexOf('--unit')+1]==='dsh-profile-owner.service')process.stdout.write('lark-channel: '+(state.disconnected||state.disconnectAfterReceipt&&fs.existsSync(${JSON.stringify(receiptPath)})?'disconnected':'connected')+'\\n')\n`,
  { mode: 0o700 })
  const sessionPath = join(homePath, 'sessions', 'owner.jsonl')
  await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 })
  await writeFile(sessionPath, 'original session\n', { mode: 0o600 })
  const input = { homePath, physicalHomePath: homePath, profile, transactionRoot,
    physicalTransactionRoot: transactionRoot, serviceContext: { systemctlExecutable, journalctlExecutable },
    installerRoot: root, parentFsyncPath: directory }
  return { directory, homePath, transactionRoot, input, statePath, logPath, journalModePath,
    sessionPath, databasePath, automationId, setOwner, masks, barriers, active }
}

test.skipIf(process.platform !== 'linux')('pending rollback restores the running original pair without service restart and reenters signed evidence', async () => {
  const f = await fixture()
  // The first attempt stops after durable permit, intent and locator publication.
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(f.input))
    .rejects.toThrow('connection state')
  const pending = await lifecycleProfileTest.loadManifest(f.transactionRoot,
    { homePath: f.homePath, profile, transactionPath: f.transactionRoot })
  const envelope = pending.hostMigration.rollbackReadinessRecovery
  expect(envelope?.permit?.signature).toMatch(/^[A-Za-z0-9+/]+=*$/u)
  await expect(verifyRollbackRecoveryEnvelope({ manifest: pending, envelope,
    homePath: f.homePath, profile, installerRoot: root })).resolves.toEqual(envelope.permit)
  const intent = await readRollbackRecoveryIntentSource(f.homePath, profile, pending.id)
  expect(intent).toBeDefined()
  expect(await readRollbackRecoveryIntentSource(f.homePath, profile)).toEqual(intent)
  expect(await readFile(rollbackRecoveryIntentPath(f.homePath, profile), 'utf8')).toContain(intent.archivePath)
  expect(await readFile(rollbackRecoveryTransactionIntentPath(f.homePath, profile, pending.id), 'utf8'))
    .toContain(intent.archivePath)
  expect(await readFile(f.sessionPath, 'utf8')).toBe('original session\n')
  await writeFile(f.sessionPath, 'original session\nnew owner data\n', { mode: 0o600 })

  // A changed owner activation cannot reuse the signed permit.
  await f.setOwner('other-owner')
  await writeFile(f.journalModePath, JSON.stringify({ disconnected: false }), { mode: 0o600 })
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(f.input))
    .rejects.toThrow('fresh owner-bound activation')
  await f.setOwner('plugin-control-plane-adoption-coordinator')

  // The same pending transaction also refuses an altered running invocation.
  const state = JSON.parse(await readFile(f.statePath, 'utf8'))
  state.active[0].invocationId = '9'.repeat(32)
  await writeFile(f.statePath, JSON.stringify(state), { mode: 0o600 })
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(f.input))
    .rejects.toThrow('invocation changed')
  state.active[0].invocationId = f.active[0].invocationId
  await writeFile(f.statePath, JSON.stringify(state), { mode: 0o600 })

  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(f.input))
    .resolves.toBeUndefined()
  expect(await readFile(f.sessionPath, 'utf8')).toBe('original session\nnew owner data\n')
  expect(await readRollbackRecoveryIntentSource(f.homePath, profile)).toEqual(intent)
  expect(await readRollbackRecoveryIntentSource(f.homePath, profile, pending.id)).toEqual(intent)
  await expect(verifyRollbackRecoveryIntent({ manifest: pending, envelope, intent,
    homePath: f.homePath, profile, historical: true })).resolves.toEqual(intent)
  const receipt = await readRollbackRecoveryReceipt({ manifest: pending, envelope, intent,
    homePath: f.homePath, profile, historical: true })
  expect(receipt?.signature).toMatch(/^[A-Za-z0-9+/]+=*$/u)
  expect(await readFile(rollbackRecoveryReceiptPath(f.homePath, profile, pending.id), 'utf8'))
    .toContain(receipt.signature)
  expect(await realpath(intent.archivePath)).toBe(intent.archivePath)
  expect(await lstat(f.transactionRoot).catch(() => undefined)).toBeUndefined()
  for (const barrier of f.barriers) {
    expect(await readlink(barrier.enablement.path)).toBe(barrier.enablement.target)
    expect(await lstat(barrier.enablement.stagingPath).catch(() => undefined)).toBeUndefined()
  }
  for (const mask of f.masks) {
    expect(await lstat(mask.path).catch(() => undefined)).toBeUndefined()
    expect(await readlink(join(intent.archivePath, relative(f.transactionRoot, mask.stagingPath)))).toBe('/dev/null')
  }
  const commands = (await readFile(f.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(commands.some(args => args.some(arg => ['stop', 'start', 'restart'].includes(arg)))).toBe(false)
  expect(commands.some(args => args.includes('daemon-reload'))).toBe(true)
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(f.input))
    .resolves.toBeUndefined()
}, 60_000)

test.skipIf(process.platform !== 'linux')('a disconnect after the signed receipt still blocks archive without stopping the original pair', async () => {
  const f = await fixture()
  await writeFile(f.journalModePath, JSON.stringify({ disconnected: false, disconnectAfterReceipt: true }),
    { mode: 0o600 })
  await expect(lifecycleProfileTest.completeHostProgramRollbackReadinessRecovery(f.input))
    .rejects.toThrow('connection state')
  const pending = await lifecycleProfileTest.loadManifest(f.transactionRoot,
    { homePath: f.homePath, profile, transactionPath: f.transactionRoot })
  const intent = await readRollbackRecoveryIntentSource(f.homePath, profile, pending.id)
  const receipt = await readRollbackRecoveryReceipt({ manifest: pending,
    envelope: pending.hostMigration.rollbackReadinessRecovery, intent, homePath: f.homePath, profile })
  expect(receipt?.signature).toMatch(/^[A-Za-z0-9+/]+=*$/u)
  expect(await lstat(intent.archivePath).catch(() => undefined)).toBeUndefined()
  expect(await readFile(f.sessionPath, 'utf8')).toBe('original session\n')
  const commands = (await readFile(f.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(commands.some(args => args.some(arg => ['stop', 'start', 'restart'].includes(arg)))).toBe(false)
}, 60_000)
