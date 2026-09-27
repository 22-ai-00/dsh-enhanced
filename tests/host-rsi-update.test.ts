import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../plugins/plugin-control-plane/src/release.js'
vi.mock('../plugins/plugin-control-plane/src/release.js', async original => ({
  ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn(),
}))
import { fixture as releaseFixture } from '../plugins/plugin-control-plane/tests/helpers/source-release-runner.js'
import { createRuntimeEpochFixture, cleanupRuntimeEpochFixtures } from '../plugins/plugin-control-plane/tests/helpers/runtime-epoch.js'
import { rsiBootstrapFixture } from '../plugins/lark-channel/tests/fixtures/rsi-bootstrap.js'
import { prepareRsiOwnerConfiguration } from '../plugins/lark-channel/src/rsi-bootstrap.js'
import { compileRsiProfiles } from '../plugins/lark-channel/src/rsi-profile.js'
import { controlPlaneDigest, readHostMaintenanceContext } from '../plugins/plugin-control-plane/src/store.js'
import { loadTrustConfig } from '../plugins/plugin-control-plane/src/trust.js'
import { discoverRsiHostUpdateBackups, prepareRsiHostUpdate, verifyRsiHostUpdate } from '../scripts/install/host-rsi-update.mjs'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const roots: string[] = []
afterEach(async () => {
  await cleanupRuntimeEpochFixtures()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function file(path: string, source: string, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, source, { mode }); await chmod(path, mode)
}

/** Materialize the actual published modules; only their ordinary dependencies
 * use the workspace installation. Migration imports must come from this Home. */
async function installMigrationModules(home: string) {
  const modules = join(home, 'profiles', 'target', 'node_modules')
  await mkdir(join(modules, '@dsh-enhanced'), { recursive: true, mode: 0o700 })
  for (const name of ['plugin-control-plane', 'lark-channel']) {
    const source = resolve('plugins', name), target = join(modules, '@dsh-enhanced', name)
    await mkdir(target, { mode: 0o700 })
    for (const entry of ['lib', 'package.json', ...(name === 'plugin-control-plane' ? ['bin'] : [])]) {
      await cp(join(source, entry), join(target, entry), { recursive: true, dereference: true })
    }
    for (const entry of await readdir(join(source, 'node_modules'))) {
      await mkdir(join(target, 'node_modules'), { recursive: true, mode: 0o700 })
      if (entry === '@dsh-enhanced') {
        await mkdir(join(target, 'node_modules', entry), { mode: 0o700 })
        for (const child of await readdir(join(source, 'node_modules', entry))) {
          await symlink(child === 'plugin-control-plane' ? relative(join(target, 'node_modules', entry), join(modules, entry, child))
            : resolve(source, 'node_modules', entry, child), join(target, 'node_modules', entry, child))
        }
      } else await symlink(resolve(source, 'node_modules', entry), join(target, 'node_modules', entry))
    }
  }
}

async function installedFixture() {
  const f = await rsiBootstrapFixture(); roots.push(f.root)
  const home = join(f.root, 'home'), profile = join(home, 'profiles', 'target')
  const runtime = async (version: string) => {
    const root = join(f.root, 'hosts', version), path = join(root, 'dsh')
    await mkdir(root, { recursive: true, mode: 0o700 })
    await copyFile('/usr/bin/true', path); await chmod(path, 0o700)
    return { version, root, dshPath: path }
  }
  const originalRuntime = await runtime('0.1.5-rc.3'), candidateRuntime = await runtime('0.1.5-rc.4')
  f.input.executor = { ...f.input.executor, path: originalRuntime.dshPath,
    sha256: hash(await readFile(originalRuntime.dshPath)) }
  await prepareRsiOwnerConfiguration(f.input, f)
  const patches = await compileRsiProfiles({ manifest: f.input.manifest, dshHome: home,
    ...f.profiles, owner: f.binding })
  await file(join(profile, 'cordis.patch.yml'), patches.targetPatch, 0o644)
  await file(join(home, 'profiles', 'coordinator', 'cordis.patch.yml'), patches.coordinatorPatch, 0o644)
  await file(join(home, `.rsi-coordinator-${hash('target').slice(0, 16)}.json`),
    json({ schemaVersion: 1, targetProfile: 'target', coordinatorProfile: 'coordinator' }))
  const databasePath = join(f.input.manifest.controlPlane.statePath, 'control.sqlite')
  const released = await releaseFixture(true, { root: home, databasePath,
    installationId: f.input.resources.installationId, ledgerId: f.input.resources.ledgerId })
  const input = 'node_modules/.pnpm/host-entry/index.js'
  await file(join(profile, input), 'export const deployed = true\n', 0o644)
  const profileFiles = await Promise.all(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(async name => {
    const path = join(profile, name); await chmod(path, 0o644)
    return { path, sha256: hash(await readFile(path)) }
  }))
  const deploymentFiles = [{ input, path: join(profile, input), sha256: hash(await readFile(join(profile, input))) }]
  const host = f.input.resources.identities.host
  const { environmentAllowlist: _environment, ...executor } = f.input.executor
  const activated = await createRuntimeEpochFixture({ releaseFixture: released, profile: 'target', originallyExisted: true,
    executor, profileFiles, baselineFiles: profileFiles, deploymentFiles, baselineDeploymentFiles: deploymentFiles,
    readinessKey: { ...host, privateKeyPem: await readFile(host.keyPath, 'utf8') } })
  const suffix = activated.plan.activation!.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
  const backup = `.target.plugin-backup-${suffix}`
  await cp(profile, join(home, 'profiles', backup), { recursive: true, dereference: true })
  activated.coordinator.close(); released.close()
  await installMigrationModules(home)
  const config = JSON.parse(await readFile(f.input.manifest.controlPlane.sourceApprovals!.configPath, 'utf8'))
  const grantDb = new DatabaseSync(config.statePath)
  grantDb.exec(`CREATE TABLE source_approval_grants (grant_id TEXT PRIMARY KEY, config_digest TEXT, key_fingerprint TEXT, created_at INTEGER);
    CREATE TABLE source_approval_receipts (request_digest TEXT PRIMARY KEY, grant_id TEXT, config_digest TEXT,
      plan_id TEXT UNIQUE, plan_digest TEXT, receipt_json TEXT, receipt_digest TEXT, created_at INTEGER)`)
  grantDb.prepare('INSERT INTO source_approval_grants VALUES (?,?,?,?)').run(config.grant.id,
    controlPlaneDigest(config), 'existing-key-fingerprint', 123)
  grantDb.prepare('INSERT INTO source_approval_receipts VALUES (?,?,?,?,?,?,?,?)').run('a'.repeat(64), config.grant.id,
    controlPlaneDigest(config), activated.plan.id, activated.plan.digest, JSON.stringify(activated.receipt),
    controlPlaneDigest(activated.receipt), 123)
  grantDb.close(); await chmod(config.statePath, 0o600)
  const hostConfig = JSON.parse(await readFile(join(f.input.resources.configRoot, 'host-authority.json'), 'utf8'))
  const hostGrantDb = new DatabaseSync(hostConfig.statePath)
  hostGrantDb.exec(`CREATE TABLE systemd_host_grants (grant_id TEXT PRIMARY KEY, grant_digest TEXT, config_digest TEXT, trust_digest TEXT);
    CREATE TABLE systemd_host_operations (operation_id TEXT PRIMARY KEY, grant_id TEXT, phase TEXT,
      request_digest TEXT, config_digest TEXT, witness_digest TEXT, context_digest TEXT, config_json TEXT)`)
  hostGrantDb.prepare('INSERT INTO systemd_host_grants VALUES (?,?,?,?)').run(hostConfig.grant.id,
    controlPlaneDigest(hostConfig.grant), controlPlaneDigest(hostConfig), controlPlaneDigest(await loadTrustConfig(f.input.manifest.controlPlane.trustPath)))
  for (const phase of ['reload', 'runtime-epoch']) hostGrantDb.prepare('INSERT INTO systemd_host_operations VALUES (?,?,?,?,?,?,?,?)')
    .run(`existing-${phase}`, hostConfig.grant.id, phase, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), '{}')
  hostGrantDb.close(); await chmod(hostConfig.statePath, 0o600)
  const unitTransitions = ['target', 'coordinator'].map(name => ({ profile: name,
    unit: `dsh-profile-${name}.service`, oldSource: 'old', newSource: 'candidate',
    unitProperties: { ...f.input.unitProperties, ExecStart: `${candidateRuntime.dshPath} --profile ${name}` } }))
  return { f, home, backup, config, hostConfig, activated, released, databasePath, runtime, unitTransitions,
    hostPlan: { schemaVersion: 1, originalRuntime, candidateRuntime } }
}

test.skipIf(process.platform !== 'linux')('Host update refuses unfinished work before stopping and rechecks original and staged ledgers before authority writes', async () => {
  const f = await installedFixture()
  const stageHome = join(f.f.root, 'unsettled-stage')
  await cp(f.home, stageHome, { recursive: true, verbatimSymlinks: true })
  const prepare = () => prepareRsiHostUpdate({ homePath: f.home, stageHome, hostPlan: f.hostPlan,
    unitTransitions: f.unitTransitions, transactionId: 'unsettled-work', systemctlExecutable: '/usr/bin/true' })
  const grantPath = f.config.statePath.replace(f.home, stageHome)
  const originalGrant = await readFile(grantPath)
  const originalRuntime = await readFile(join(stageHome, 'rsi-authority-runtimes/target/receipt.json'))
  for (const home of [f.home, stageHome]) {
    const db = new DatabaseSync(f.databasePath.replace(f.home, home))
    try {
      const plan = db.prepare('SELECT id,status FROM source_plans LIMIT 1').get()!
      for (const status of ['pending-approval', 'awaiting-publish', 'publish-ambiguous']) {
        db.prepare('UPDATE source_plans SET status=? WHERE id=?').run(status, plan.id)
        if (home === f.home) await expect(discoverRsiHostUpdateBackups({ homePath: f.home })).rejects.toThrow('unsettled source_plans')
        await expect(prepare()).rejects.toThrow('unsettled source_plans')
      }
      db.prepare('UPDATE source_plans SET status=? WHERE id=?').run(plan.status, plan.id)
      const operation = db.prepare('SELECT operation_id,applied_at FROM source_release_operations LIMIT 1').get()!
      db.prepare("UPDATE source_release_operations SET status='completed',applied_at=NULL WHERE operation_id=?").run(operation.operation_id)
      await expect(prepare()).rejects.toThrow('unsettled source_release_operations')
      db.prepare("UPDATE source_release_operations SET status='applied',applied_at=? WHERE operation_id=?")
        .run(operation.applied_at, operation.operation_id)
      for (const status of ['pending-approval', 'approved']) {
        db.prepare('UPDATE activation_plans SET status=? WHERE id=?').run(status, f.activated.plan.id)
        await expect(prepare()).rejects.toThrow('unsettled activation_plans')
      }
      db.prepare("UPDATE activation_plans SET status='activated' WHERE id=?").run(f.activated.plan.id)
      for (const table of ['task_observation_batches', 'live_qualification_batches']) {
        db.prepare(`INSERT INTO ${table} (id,lane,plan_id,batch_json,batch_digest,state,created_at) VALUES (?,?,?,?,?,'pending',?)`)
          .run('pending-fixture', 'fixture', f.activated.plan.id, '{}', 'a'.repeat(64), 123)
        await expect(prepare()).rejects.toThrow(`unsettled ${table}`)
        db.prepare(`UPDATE ${table} SET state='signed' WHERE id='pending-fixture'`).run()
        await expect(prepare()).rejects.toThrow(`unsettled ${table}`)
        db.prepare(`DELETE FROM ${table} WHERE id='pending-fixture'`).run()
      }
      db.exec('PRAGMA ignore_check_constraints=ON')
      db.prepare("UPDATE source_plans SET status='future-unknown' WHERE id=?").run(plan.id)
      await expect(prepare()).rejects.toThrow('unsettled source_plans')
      db.prepare('UPDATE source_plans SET status=? WHERE id=?').run(plan.status, plan.id)
      db.exec('ALTER TABLE source_jobs RENAME TO unavailable_source_jobs')
      await expect(prepare()).rejects.toThrow('source_jobs')
      db.exec('ALTER TABLE unavailable_source_jobs RENAME TO source_jobs')
    } finally { db.close() }
    expect(await readFile(grantPath)).toEqual(originalGrant)
    expect(await readFile(join(stageHome, 'rsi-authority-runtimes/target/receipt.json'))).toEqual(originalRuntime)
  }
  expect(await discoverRsiHostUpdateBackups({ homePath: f.home })).toEqual({ approvedBackupNames: [f.backup] })
}, 120_000)

test.skipIf(process.platform !== 'linux')('staged RSI Host maintenance preserves history and used grants across repeated updates and a subsequent adoption', async () => {
  const f = await installedFixture()
  const originalBootstrap = await readFile(join(f.f.input.resources.configRoot, 'bootstrap.json'))
  const key = await readFile(f.f.input.resources.identities.host.keyPath)
  const history = (home: string) => {
    const db = new DatabaseSync(f.databasePath.replace(f.home, home), { readOnly: true })
    try { return ['activation_plans', 'activation_watch', 'activation_host_input_witnesses',
      'host_attestation_operations', 'host_attestations', 'activation_deployment_checkpoints', 'source_adoptions']
      .map(table => db.prepare(`SELECT * FROM ${table}`).all()) } finally { db.close() }
  }
  let originalHistory = history(f.home), currentPlanId = f.activated.plan.id
  expect(await discoverRsiHostUpdateBackups({ homePath: f.home })).toEqual({ approvedBackupNames: [f.backup] })
  for (let index = 0; index < 3; index++) {
    const stageHome = join(f.f.root, `stage-${index}`)
    await cp(f.home, stageHome, { recursive: true, verbatimSymlinks: true })
    const proof = await prepareRsiHostUpdate({ homePath: f.home, stageHome, hostPlan: f.hostPlan,
      unitTransitions: f.unitTransitions, transactionId: `fixture-maintenance-${index}`, systemctlExecutable: '/usr/bin/true' })
    expect(proof.installations).toHaveLength(1)
    const wrapperPath = f.f.input.manifest.serviceEnvironment.target.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG
    expect(JSON.parse(await readFile(wrapperPath.replace(f.home, stageHome), 'utf8')).schemaVersion).toBe(4)
    await verifyRsiHostUpdate({ homePath: f.home, physicalHome: stageHome, hostPlan: f.hostPlan, proof })
    expect(history(stageHome)).toEqual(originalHistory)
    expect(await readFile(join(stageHome, 'rsi-authorities/target/config/bootstrap.json'))).toEqual(originalBootstrap)
    expect(await readFile(f.f.input.resources.identities.host.keyPath.replace(f.home, stageHome))).toEqual(key)
    const grant = new DatabaseSync(f.config.statePath.replace(f.home, stageHome), { readOnly: true })
    try {
      expect(grant.prepare('SELECT receipt_json FROM source_approval_receipts').get()!.receipt_json).toBe(JSON.stringify(f.activated.receipt))
      expect(grant.prepare('SELECT key_fingerprint,created_at FROM source_approval_grants').get())
        .toEqual({ key_fingerprint: 'existing-key-fingerprint', created_at: 123 })
    } finally { grant.close() }
    const hostGrants = new DatabaseSync(f.hostConfig.statePath.replace(f.home, stageHome), { readOnly: true })
    try {
      expect(hostGrants.prepare('SELECT phase,count(*) AS used FROM systemd_host_operations GROUP BY phase ORDER BY phase').all())
        .toEqual([{ phase: 'reload', used: 1 }, { phase: 'runtime-epoch', used: 1 }])
      expect(hostGrants.prepare('SELECT grant_id FROM systemd_host_grants').get()!.grant_id).toBe(f.hostConfig.grant.id)
    } finally { hostGrants.close() }
    const old = join(f.f.root, `previous-${index}`)
    await rename(f.home, old); await rename(stageHome, f.home)
    await verifyRsiHostUpdate({ homePath: f.home, physicalHome: f.home, hostPlan: f.hostPlan, proof })
    const db = new DatabaseSync(f.databasePath, { readOnly: true })
    try { expect(readHostMaintenanceContext(db, currentPlanId).records).toHaveLength(index === 2 ? 1 : index + 1) } finally { db.close() }
    f.hostPlan.originalRuntime = f.hostPlan.candidateRuntime
    f.hostPlan.candidateRuntime = await f.runtime(`0.1.5-rc.${index + 5}`)
    for (const unit of f.unitTransitions) unit.unitProperties.ExecStart = `${f.hostPlan.candidateRuntime.dshPath} --profile ${unit.profile}`
    if (index === 1) {
      // A later real source-release/activation API creates a new current
      // checkpoint. Runtime readiness itself remains explicit fixture evidence.
      const profile = join(f.home, 'profiles', 'target'), saved = join(f.f.root, 'next-baseline')
      await cp(profile, saved, { recursive: true, verbatimSymlinks: true })
      const pins = async () => Promise.all(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(async name => {
        const path = join(profile, name); return { path, sha256: hash(await readFile(path)) }
      }))
      const baselineFiles = await pins(), input = 'node_modules/.pnpm/host-entry/index.js', path = join(profile, input)
      const baselineDeploymentFiles = [{ input, path, sha256: hash(await readFile(path)) }]
      await writeFile(join(profile, 'cordis.patch.yml'), `${await readFile(join(profile, 'cordis.patch.yml'), 'utf8')}# subsequent adopted capability\n`)
      await writeFile(path, 'export const deployed = 2\n')
      f.released.reopen()
      const next = await f.released.next({ baseCommit: '5'.repeat(40), mergeCommit: '6'.repeat(40) })
      const host = f.f.input.resources.identities.host, runtime = f.hostPlan.originalRuntime
      const successor = await createRuntimeEpochFixture({ releaseFixture: next, profile: 'target', originallyExisted: true,
        executor: { id: f.f.input.executor.id, version: runtime.version, path: runtime.dshPath, sha256: hash(await readFile(runtime.dshPath)) },
        profileFiles: await pins(), baselineFiles, deploymentFiles: [{ input, path, sha256: hash(await readFile(path)) }], baselineDeploymentFiles,
        readinessKey: { ...host, privateKeyPem: await readFile(host.keyPath, 'utf8') } })
      successor.coordinator.close(); f.released.close()
      const backup = `.target.plugin-backup-${successor.plan.activation!.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)}`
      await rename(saved, join(f.home, 'profiles', backup))
      await rm(join(f.home, 'profiles', f.backup), { recursive: true })
      expect(await discoverRsiHostUpdateBackups({ homePath: f.home })).toEqual({ approvedBackupNames: [backup] })
      currentPlanId = successor.plan.id; originalHistory = history(f.home)
    }
  }
}, 120_000)
