import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, cp, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { rsiBootstrapFixture } from '../plugins/lark-channel/tests/fixtures/rsi-bootstrap.js'
import { prepareRsiOwnerConfiguration } from '../plugins/lark-channel/src/rsi-bootstrap.js'
import { compileRsiProfiles } from '../plugins/lark-channel/src/rsi-profile.js'
import { signRsiHostUpdateOverlay, signRsiOwnerRepairOverlay, signRsiOwnerProgramUpdateOverlay } from '../plugins/lark-channel/src/rsi-host-update.js'
import * as release from '../plugins/plugin-control-plane/src/release.js'
vi.mock('../plugins/plugin-control-plane/src/release.js', async original => ({
  ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn(),
}))
import { fixture as releaseFixture } from '../plugins/plugin-control-plane/tests/helpers/source-release-runner.js'
import { createRuntimeEpochFixture, cleanupRuntimeEpochFixtures } from '../plugins/plugin-control-plane/tests/helpers/runtime-epoch.js'
import { inspectRsiScannerOwnerSource } from '../scripts/install/host-rsi-update.mjs'
import { lifecycleProfileTest as lifecycle } from '../scripts/install/lifecycle-profile.mjs'

const faults = vi.hoisted(() => ({ afterRead: null as null | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    return new Proxy(handle, { get(target, key) {
      if (key === 'read') return async (...readArgs: unknown[]) => {
        const result = await (target.read as (...args: unknown[]) => Promise<unknown>)(...readArgs)
        await faults.afterRead?.(String(args[0]))
        return result
      }
      const value = Reflect.get(target, key, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
})

const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
afterEach(async () => { faults.afterRead = null; await cleanupRuntimeEpochFixtures(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function file(path: string, source: string, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, source, { mode }); await chmod(path, mode)
}
async function installSourceReader(home: string, packageName = 'lark-channel') {
  const source = resolve('plugins', packageName), target = join(home, 'profiles/target/node_modules/@dsh-enhanced', packageName)
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const entry of ['lib', 'package.json']) await cp(join(source, entry), join(target, entry), { recursive: true, dereference: true })
  const dependencies = join(target, 'node_modules'); await mkdir(dependencies, { mode: 0o700 })
  for (const entry of await readdir(join(source, 'node_modules'))) {
    if (entry === '@dsh-enhanced') {
      await mkdir(join(dependencies, entry), { mode: 0o700 })
      for (const child of await readdir(join(source, 'node_modules', entry))) {
        const destination = join(dependencies, entry, child)
        if (child === 'assistant-growth-contract') {
          // The owner validator is an explicitly imported entry and must be a
          // real installed runtime dependency inside the controlled Home.
          const contract = await realpath(resolve(source, 'node_modules', entry, child))
          await mkdir(destination, { mode: 0o700 })
          for (const part of ['lib', 'package.json']) await cp(join(contract, part), join(destination, part), { recursive: true, dereference: true })
        } else await symlink(resolve(source, 'node_modules', entry, child), destination)
      }
    } else await symlink(resolve(source, 'node_modules', entry), join(dependencies, entry))
  }
}
async function fixture() {
  const f = await rsiBootstrapFixture(); roots.push(f.root)
  await prepareRsiOwnerConfiguration(f.input, f)
  const home = join(f.root, 'home'), configRoot = f.input.resources.configRoot
  const patches = await compileRsiProfiles({ manifest: f.input.manifest, dshHome: home, ...f.profiles, owner: f.binding })
  await file(join(home, 'profiles/target/cordis.patch.yml'), patches.targetPatch, 0o644)
  await file(join(home, 'profiles/coordinator/cordis.patch.yml'), patches.coordinatorPatch, 0o644)
  await file(join(home, `.rsi-coordinator-${hash('target').slice(0, 16)}.json`), json({ schemaVersion: 1, targetProfile: 'target', coordinatorProfile: 'coordinator' }))
  await installSourceReader(home)
  const query = { homePath: home, profile: 'target' }
  return { f, home, configRoot, query, manifestPath: join(configRoot, 'manifest.json'), bootstrapPath: join(configRoot, 'bootstrap.json'),
    resourcePath: join(f.input.resources.root, 'bootstrap.json'), overlayPath: join(configRoot, 'host-update-overlays.json') }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function overlay(f: Fixture, kind: 'repair' | 'program', changeOwner = false, expired = false) {
  const bootstrapSource = await readFile(f.bootstrapPath, 'utf8')
  const receipt = JSON.parse(bootstrapSource)
  const files: Record<string, string> = { ...receipt.files }
  if (changeOwner || expired) {
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
    if (changeOwner) {
      manifest.sourceReviews.owner.principalVersion = 2
      for (const group of ['learning', 'reviews', 'adoption']) manifest.memoryLearning[group].owner.principalVersion = 2
    }
    if (expired) {
      manifest.sourceReviews.expiresAt = 1; manifest.controlPlane.sourceJobs.expiresAt = 1
      for (const group of ['learning', 'reviews', 'adoption']) manifest.memoryLearning[group].expiresAt = 1
    }
    await file(f.manifestPath, json(manifest)); files[f.manifestPath] = hash(await readFile(f.manifestPath))
  }
  const patches = { target: hash(await readFile(join(f.home, 'profiles/target/cordis.patch.yml'))),
    coordinator: hash(await readFile(join(f.home, 'profiles/coordinator/cordis.patch.yml'))) }
  const runtimeReceiptDigest = hash(await readFile(join(f.home, 'rsi-authority-runtimes/target/receipt.json')))
  const journalPath = join(f.home, '.rsi-setup-journal.json'), creationPath = join(f.home, 'rsi-creation-builds/target/bootstrap.json')
  const beforeJournal = json({ state: 'before' }), beforeCreation = json({ state: 'before' })
  const afterJournal = json({ state: 'after' }), afterCreation = json({ state: 'after' })
  await file(journalPath, afterJournal); await file(creationPath, afterCreation)
  const host = f.f.input.resources.identities.host
  const common = { schemaVersion: 1 as const, transactionId: `source-${kind}`, dshHome: f.home, targetProfile: 'target',
    installationId: f.f.input.resources.installationId, sequence: 1, previousDigest: null, bootstrapDigest: hash(bootstrapSource), files, patches,
    runtimeReceiptDigest, planDigest: hash(json({ files, patches })), result: { ...receipt.result, manifestDigest: files[f.manifestPath] },
    issuedAt: f.f.input.now, authority: host.authority, keyId: host.keyId }
  const change = { sourceMaintenanceDigest: hash('maintenance'), before: { files: receipt.files, patches, runtimeReceiptDigest,
    creationReceiptDigest: hash(beforeCreation), journalDigest: hash(beforeJournal) },
  after: { creationReceiptDigest: hash(afterCreation), journalDigest: hash(afterJournal) } }
  const key = await readFile(host.keyPath, 'utf8')
  const record = kind === 'repair'
    ? signRsiOwnerRepairOverlay({ ...common, kind: 'rsi-owner-repair-overlay', repair: { ...change, permissionPreset: 'workspace-write' } }, key, f.f.input.resources, bootstrapSource, [])
    : signRsiOwnerProgramUpdateOverlay({ ...common, kind: 'rsi-owner-program-update-overlay', update: { ...change,
      authorityDigest: hash('old-authority'), hostPlanDigest: hash('host-plan') } }, key, f.f.input.resources, bootstrapSource, [])
  await file(f.overlayPath, json({ schemaVersion: 1, kind: 'rsi-host-update-overlays', records: [record] }))
  return { journalPath, creationPath, record }
}
async function fingerprint(path: string) {
  const entry = await lstat(path, { bigint: true })
  return { dev: entry.dev, ino: entry.ino, mode: entry.mode, size: entry.size, mtimeNs: entry.mtimeNs, ctimeNs: entry.ctimeNs, digest: hash(await readFile(path)) }
}
function rejected(value: Promise<unknown>) { return expect(value).rejects.toMatchObject({ code: 'rsi-scanner-owner-source-unavailable' }) }

describe.skipIf(process.platform !== 'linux')('frozen RSI scanner owner source', () => {
  test('reads the real original bootstrap owner without Delivery/Store/grant APIs or scanning other profiles', async () => {
    const f = await fixture()
    // No materialized CP migration module or valid unrelated installation is
    // required to read the frozen bootstrap owner; no active binding is read.
    await file(join(f.home, 'rsi-authorities/unrelated/broken.json'), 'broken')
    const paths = [f.manifestPath, f.bootstrapPath, f.resourcePath, f.f.input.resources.identities.host.keyPath]
    const before = await Promise.all(paths.map(fingerprint))
    const proof = await inspectRsiScannerOwnerSource(f.query)
    expect(proof.protocol).toBe('host-rsi/scanner-owner-source/v1')
    expect(proof.owner).toEqual(f.f.input.manifest.sourceReviews.owner)
    expect(proof.manifest).toMatchObject({ path: f.manifestPath, digest: hash(await readFile(f.manifestPath)) })
    expect(proof.overlay).toBeNull(); expect(proof.sqliteReadOnlyPlan).toBe(false)
    const { sourceDigest, ...unsigned } = proof
    expect(sourceDigest).toBe(hash(JSON.stringify(unsigned)))
    const frozen = (value: unknown) => {
      if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen) }
    }
    frozen(proof)
    expect(JSON.stringify(proof)).not.toMatch(/BEGIN PRIVATE KEY|sourceReviews|grant|observerKeyDigest/u)
    expect(await Promise.all(paths.map(fingerprint))).toEqual(before)
  }, 120_000)

  test.each(['repair', 'program'] as const)('reads signed %s effective manifest and verifies owner-change receipts without a CP Store', async kind => {
    const f = await fixture(); const signed = await overlay(f, kind, true)
    const proof = await inspectRsiScannerOwnerSource(f.query)
    expect(proof.owner.principalVersion).toBe(2)
    expect(f.f.input.manifest.sourceReviews.owner.principalVersion).toBe(1)
    expect(proof.overlay?.sequence).toBe(1); expect(proof.sqliteReadOnlyPlan).toBe(false)
    expect(proof.sourceFiles).toContainEqual({ path: signed.journalPath, digest: hash(await readFile(signed.journalPath)), private: true })
    await writeFile(signed.creationPath, json({ drift: true }))
    await rejected(inspectRsiScannerOwnerSource(f.query))
  }, 120_000)

  test('reuses the formal read-only current-plan fence for a signed Host update overlay', async () => {
    const f = await fixture(); await installSourceReader(f.home, 'plugin-control-plane')
    const databasePath = join(f.f.input.manifest.controlPlane.statePath, 'control.sqlite')
    const released = await releaseFixture(true, { root: f.home, databasePath,
      installationId: f.f.input.resources.installationId, ledgerId: f.f.input.resources.ledgerId })
    const profile = join(f.home, 'profiles/target'), inputPath = 'node_modules/.pnpm/host-entry/index.js'
    await file(join(profile, inputPath), 'export const fixture = true\n', 0o644)
    const profileFiles = await Promise.all(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(async name => {
      const path = join(profile, name); await chmod(path, 0o644); return { path, sha256: hash(await readFile(path)) }
    }))
    const deploymentFiles = [{ input: inputPath, path: join(profile, inputPath), sha256: hash(await readFile(join(profile, inputPath))) }]
    const host = f.f.input.resources.identities.host
    const { environmentAllowlist: _environment, ...executor } = f.f.input.executor
    const activated = await createRuntimeEpochFixture({ releaseFixture: released, profile: 'target', originallyExisted: true,
      executor, profileFiles, baselineFiles: profileFiles, deploymentFiles, baselineDeploymentFiles: deploymentFiles,
      readinessKey: { ...host, privateKeyPem: await readFile(host.keyPath, 'utf8') } })
    const suffix = activated.plan.activation!.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
    await cp(profile, join(f.home, 'profiles', `.target.plugin-backup-${suffix}`), { recursive: true, verbatimSymlinks: true })
    activated.coordinator.close(); released.close()
    const bootstrapSource = await readFile(f.bootstrapPath, 'utf8'), receipt = JSON.parse(bootstrapSource)
    const patches = { target: hash(await readFile(join(profile, 'cordis.patch.yml'))),
      coordinator: hash(await readFile(join(f.home, 'profiles/coordinator/cordis.patch.yml'))) }
    const record = signRsiHostUpdateOverlay({ schemaVersion: 1, kind: 'rsi-host-update-overlay', transactionId: 'host-source',
      dshHome: f.home, targetProfile: 'target', installationId: f.f.input.resources.installationId,
      currentPlanId: activated.plan.id, activationId: activated.plan.activation!.id, sequence: 1, previousDigest: null,
      bootstrapDigest: hash(bootstrapSource), files: receipt.files, patches,
      runtimeReceiptDigest: hash(await readFile(join(f.home, 'rsi-authority-runtimes/target/receipt.json'))),
      planDigest: hash(json({ files: receipt.files, patches })), result: receipt.result,
      issuedAt: Date.now(), authority: host.authority, keyId: host.keyId },
    await readFile(host.keyPath, 'utf8'), f.f.input.resources, bootstrapSource, [])
    await file(f.overlayPath, json({ schemaVersion: 1, kind: 'rsi-host-update-overlays', records: [record] }))
    const before = await fingerprint(databasePath)
    expect((await inspectRsiScannerOwnerSource(f.query)).sqliteReadOnlyPlan).toBe(true)
    expect(await fingerprint(databasePath)).toEqual(before)
    await writeFile(join(profile, 'cordis.patch.yml'), `${await readFile(join(profile, 'cordis.patch.yml'), 'utf8')}# unexpected drift\n`)
    await rejected(inspectRsiScannerOwnerSource(f.query))
  }, 120_000)

  test('uses only the controlled physical copy, including through a pinned Home fd', async () => {
    const f = await fixture(); await overlay(f, 'repair')
    const original = await inspectRsiScannerOwnerSource(f.query)
    const stage = join(f.f.root, 'stage'); await cp(f.home, stage, { recursive: true, verbatimSymlinks: true })
    // Make logical original unusable: staged inspection must not read it.
    await writeFile(f.manifestPath, 'broken original')
    const copied = await inspectRsiScannerOwnerSource({ ...f.query, physicalHome: stage })
    expect(copied).toEqual(original)
    const { open } = await import('node:fs/promises')
    const handle = await open(stage, 'r')
    try { expect(await inspectRsiScannerOwnerSource({ ...f.query, physicalHome: `/proc/self/fd/${handle.fd}` })).toEqual(original) }
    finally { await handle.close() }
  }, 120_000)

  test('runs the real bwrap source child against stage mapped at logical Home', async context => {
    // No namespace/helper mock: skip only when this Linux host cannot actually
    // execute bwrap. Trusted fixture dependencies are not a general JS closure audit.
    const probe = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/',
      '--proc', '/proc', '--dev', '/dev', '--', '/bin/true'], { timeout: 5000, encoding: 'utf8' })
    if (probe.status !== 0) {
      process.stdout.write(`${JSON.stringify({ check: 'real-bwrap-scanner-source', actualExecuted: false,
        reason: probe.error?.message ?? probe.stderr.trim() ?? `bwrap probe exit ${probe.status}` })}\n`)
      context.skip('actual bwrap unavailable on this Linux host')
    }
    const f = await fixture(), expected = await inspectRsiScannerOwnerSource(f.query)
    const stage = join(f.f.root, 'source-child-stage')
    await cp(f.home, stage, { recursive: true, verbatimSymlinks: true })
    const stagedManifest = join(stage, 'rsi-authorities/target/config/manifest.json')
    const stagedBefore = await fingerprint(stagedManifest)
    const probeMarker = 'ORIGINAL_HOME_SOURCE_PROGRAM_EXECUTED'
    await writeFile(f.manifestPath, 'broken original Home business manifest')
    const originalReader = join(f.home, 'profiles/target/node_modules/@dsh-enhanced/lark-channel/lib/rsi-host-update.js')
    const originalContract = join(f.home, 'profiles/target/node_modules/@dsh-enhanced/lark-channel/node_modules/@dsh-enhanced/assistant-growth-contract/lib/index.js')
    for (const path of [originalReader, originalContract]) await writeFile(path,
      `${await readFile(path, 'utf8')}\nprocess.stderr.write(${JSON.stringify(probeMarker)}); throw new Error(${JSON.stringify(probeMarker)})\n`)
    const originalBefore = await fingerprint(f.manifestPath)
    const result = await lifecycle.sandboxRun({ bwrapExecutable: '/usr/bin/bwrap', homePath: f.home,
      stageHome: stage, profile: 'target' },
    [process.execPath, '--input-type=module', '--eval', lifecycle.SCANNER_RETIREMENT_SOURCE_PROGRAM,
      resolve('scripts/install/host-rsi-update.mjs'), f.home, 'target'],
    { capture: true, rejectTruncated: true, timeoutMs: 30_000, readonlyRoots: [resolve('scripts/install')] })
    const actual = JSON.parse(result.stdout)
    expect(actual.owner).toEqual(expected.owner)
    expect(actual.sourceDigest).toBe(expected.sourceDigest)
    expect(actual.sourceFiles).toEqual(expected.sourceFiles)
    expect(actual.manifest).toEqual(expected.manifest)
    expect(result.stderr).not.toContain(probeMarker)
    expect(await fingerprint(f.manifestPath)).toEqual(originalBefore)
    expect(await fingerprint(stagedManifest)).toEqual(stagedBefore)
    process.stdout.write(`${JSON.stringify({ check: 'real-bwrap-scanner-source', actualExecuted: true,
      deadlineMs: 30_000, sourceDigest: actual.sourceDigest, ownerVersion: actual.owner.principalVersion })}\n`)
  }, 120_000)

  test('rejects manifest, bootstrap, resource receipt and private file-pin changes', async () => {
    const f = await fixture()
    const receipt = JSON.parse(await readFile(f.bootstrapPath, 'utf8'))
    const pinned = Object.keys(receipt.files).find(path => path !== f.manifestPath)!
    for (const path of [f.manifestPath, f.bootstrapPath, f.resourcePath, pinned]) {
      const saved = await readFile(path)
      await writeFile(path, path === f.bootstrapPath ? json({ ...receipt, observerKeyDigest: 'f'.repeat(64) }) : 'changed')
      await rejected(inspectRsiScannerOwnerSource(f.query)); await writeFile(path, saved)
    }
  }, 120_000)

  test('rejects recorded signer key/public-key mismatches even if the resource receipt hash is recomputed', async () => {
    const f = await fixture(), saved = await readFile(f.resourcePath), receipt = JSON.parse(saved.toString('utf8'))
    receipt.resources.identities.host.publicKeyPem = receipt.resources.identities.approval.publicKeyPem
    const { receiptDigest: _digest, ...body } = receipt; receipt.receiptDigest = hash(JSON.stringify(body))
    await writeFile(f.resourcePath, json(receipt)); await rejected(inspectRsiScannerOwnerSource(f.query)); await writeFile(f.resourcePath, saved)
    const key = f.f.input.resources.identities.host.keyPath, original = await readFile(key)
    await writeFile(key, await readFile(f.f.input.resources.identities.approval.keyPath))
    await rejected(inspectRsiScannerOwnerSource(f.query)); await writeFile(key, original)
  }, 120_000)

  test('rejects signature/overlay and owner journal drift while keeping static errors content-free', async () => {
    const f = await fixture(); const signed = await overlay(f, 'program')
    const saved = await readFile(f.overlayPath)
    await writeFile(f.overlayPath, saved.toString().replace(signed.record.signature, 'A'.repeat(signed.record.signature.length)))
    await rejected(inspectRsiScannerOwnerSource(f.query)); await writeFile(f.overlayPath, saved)
    await writeFile(signed.journalPath, 'private-credential-marker')
    const failure = await inspectRsiScannerOwnerSource(f.query).catch(error => error)
    expect(failure.code).toBe('rsi-scanner-owner-source-unavailable')
    expect(failure.message).not.toMatch(/credential|BEGIN|manifest|sourceReviews/u)
  }, 120_000)

  test('rejects unsafe symlinked, hardlinked and public private sources or parent directories', async () => {
    const f = await fixture()
    const held = `${f.manifestPath}.held`; await rename(f.manifestPath, held); await symlink(held, f.manifestPath)
    await rejected(inspectRsiScannerOwnerSource(f.query)); await rm(f.manifestPath); await rename(held, f.manifestPath)
    const linked = `${f.manifestPath}.linked`; await link(f.manifestPath, linked)
    await rejected(inspectRsiScannerOwnerSource(f.query)); await rm(linked)
    await chmod(f.manifestPath, 0o644); await rejected(inspectRsiScannerOwnerSource(f.query)); await chmod(f.manifestPath, 0o600)
    await chmod(f.configRoot, 0o755); await rejected(inspectRsiScannerOwnerSource(f.query)); await chmod(f.configRoot, 0o700)
    const oldConfig = `${f.configRoot}.held`; await rename(f.configRoot, oldConfig); await symlink(oldConfig, f.configRoot)
    await rejected(inspectRsiScannerOwnerSource(f.query)); await rm(f.configRoot); await rename(oldConfig, f.configRoot)
  }, 120_000)

  test('rejects an external growth-contract entry before executing that validator', async () => {
    const f = await fixture()
    const dependency = join(f.home, 'profiles/target/node_modules/@dsh-enhanced/lark-channel/node_modules/@dsh-enhanced/assistant-growth-contract')
    const external = join(f.f.root, 'external-contract')
    await cp(dependency, external, { recursive: true, dereference: true })
    const entry = join(external, 'lib/index.js')
    await writeFile(entry, `${await readFile(entry, 'utf8')}\nglobalThis.__scannerExternalContractExecuted = true\n`)
    await rm(dependency, { recursive: true }); await symlink(external, dependency)
    const probe = globalThis as typeof globalThis & { __scannerExternalContractExecuted?: boolean }
    delete probe.__scannerExternalContractExecuted
    try {
      await rejected(inspectRsiScannerOwnerSource(f.query))
      expect(probe.__scannerExternalContractExecuted).toBeUndefined()
    } finally { delete probe.__scannerExternalContractExecuted }
  }, 120_000)

  test('pins the in-Home growth-contract entry before loading the validator', async () => {
    const f = await fixture()
    const entry = join(f.home, 'profiles/target/node_modules/@dsh-enhanced/lark-channel/node_modules/@dsh-enhanced/assistant-growth-contract/lib/index.js')
    const probe = globalThis as typeof globalThis & { __scannerContractAfterPinExecuted?: boolean }
    delete probe.__scannerContractAfterPinExecuted
    faults.afterRead = async path => {
      if (!path.endsWith('/index.js')) return
      faults.afterRead = null
      await writeFile(entry, `${await readFile(entry, 'utf8')}\nglobalThis.__scannerContractAfterPinExecuted = true\n`)
    }
    try {
      await rejected(inspectRsiScannerOwnerSource(f.query))
      expect(probe.__scannerContractAfterPinExecuted).toBeUndefined()
    } finally { delete probe.__scannerContractAfterPinExecuted }
  }, 120_000)

  test('rejects source drift after its pinned fd is read', async () => {
    const f = await fixture()
    faults.afterRead = async path => {
      if (!path.endsWith('/manifest.json')) return
      faults.afterRead = null
      await writeFile(f.manifestPath, `${await readFile(f.manifestPath, 'utf8')} `)
    }
    await rejected(inspectRsiScannerOwnerSource(f.query))
  }, 120_000)

  test('does not require unexpired grants and does not infer active or revoked owner state', async () => {
    const f = await fixture(); await overlay(f, 'repair', false, true)
    const proof = await inspectRsiScannerOwnerSource(f.query)
    expect(JSON.parse(await readFile(f.manifestPath, 'utf8')).sourceReviews.expiresAt).toBe(1)
    expect(proof.owner).not.toHaveProperty('status')
    expect(proof).not.toHaveProperty('revoked'); expect(proof).not.toHaveProperty('active')
    // Source expiry is neither evaluated nor renewed: only the signed original
    // manifest bytes and frozen owner are returned; Delivery proves revocation.
    expect(proof.owner).toEqual(f.f.input.manifest.sourceReviews.owner)
  }, 120_000)
})
