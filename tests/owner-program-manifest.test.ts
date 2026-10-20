import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const profile = 'assistant'
const coordinatorProfile = `rsi-${profile}-${hash(profile).slice(0, 12)}`
const cache = '/private/dsh-hosts'
const runtime = (version: string, receiptDigest: string) => ({ version, root: `${cache}/${version}`,
  dshPath: `${cache}/${version}/node_modules/.bin/dsh`,
  binDirectory: `${cache}/${version}/node_modules/.bin`,
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, receiptDigest })
const originalRuntime = runtime('0.2.0-rc.2', 'a'.repeat(64))
const candidateRuntime = runtime('0.2.1-rc.2', 'b'.repeat(64))
const binding = (selected: ReturnType<typeof runtime>) => `${JSON.stringify({ schemaVersion: 1,
  cacheRoot: cache, version: selected.version, receiptDigest: selected.receiptDigest })}\n`

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-manifest-')))
  const homePath = join(root, 'home'), transactionRoot = join(root, 'transaction')
  await mkdir(homePath, { mode: 0o700 }); await mkdir(transactionRoot, { mode: 0o700 })
  const transaction = await lstat(transactionRoot)
  const plan = { schemaVersion: 1, status: 'update', canonicalHome: homePath,
    bindingPath: join(homePath, '.dsh-rsi-host.json'), originalBindingSource: binding(originalRuntime),
    originalBindingDigest: hash(binding(originalRuntime)), originalRuntime, candidateRuntime,
    candidateBindingSource: binding(candidateRuntime) }
  const services = [profile, coordinatorProfile].map((name, index) => ({
    unit: `dsh-profile-${name}.service`, profile: name, wasActive: true,
    mainPid: 101 + index, invocationId: `original-${index}` }))
  const before = '[Service]\nExecStart=original\n', after = '[Service]\nExecStart=candidate\n'
  const units = services.map(service => ({ unit: service.unit, profile: service.profile,
    path: join(root, service.unit), before, after, beforeDigest: hash(before), afterDigest: hash(after),
    pathEnvironment: 'PATH=/usr/bin' }))
  const ownerUpdate = { coordinatorProfile, hostPlan: plan, original: { source: { records: [] as string[] } } }
  const localSource = { protocol: 'dsh-enhanced/host-owner-program-update/v1', homePath, profile, ownerUpdate }
  const originalReadiness = { schemaVersion: 1, services: services.map(service => ({
    unit: service.unit, profile: service.profile, invocationId: service.invocationId,
    mainPid: service.mainPid, hostReady: false,
    coordinatorActivated: service.profile === coordinatorProfile ? false : null })) }
  const manifest = { version: 4, id: 'owner-program-size-test', homePath, canonicalHome: homePath,
    transactionPath: transactionRoot, transactionIdentity: { dev: String(transaction.dev),
      ino: String(transaction.ino), uid: transaction.uid, mode: transaction.mode },
    profile, operation: 'host-update', services, unitUniverse: services.map(service => service.unit),
    foreignOwnership: [], serviceMasks: [], serviceStartBarriers: [], containmentMasks: [],
    containmentMaskIntents: [], containmentStartBarriers: [],
    hostMigration: { plan, units, bwrapExecutable: '/usr/bin/true', phase: 'initializing',
      candidateEverStarted: false, originalExternalLinksDigest: 'c'.repeat(64),
      localSource, originalReadiness } }
  const expected = { homePath, transactionPath: transactionRoot, profile }
  return { root, transactionRoot, manifest, expected }
}

function genericManifest(program: Awaited<ReturnType<typeof fixture>>['manifest']) {
  const generic = structuredClone(program)
  const plan = generic.hostMigration.plan
  plan.status = 'current'
  plan.candidateRuntime = structuredClone(plan.originalRuntime)
  plan.candidateBindingSource = plan.originalBindingSource
  generic.services = generic.services.slice(0, 1)
  generic.unitUniverse = generic.unitUniverse.slice(0, 1)
  generic.hostMigration.units = generic.hostMigration.units.slice(0, 1).map(unit => ({
    ...unit, after: unit.before, afterDigest: unit.beforeDigest }))
  generic.hostMigration.localSource = { protocol: 'dsh-enhanced/host-local-source-update/v1',
    homePath: generic.homePath, profile: generic.profile } as typeof generic.hostMigration.localSource
  delete (generic.hostMigration as { originalReadiness?: unknown }).originalReadiness
  return generic
}

test('owner program v4 stores more than 2 MiB compactly, validates, and rejects oversize without replacing bytes', async () => {
  const f = await fixture()
  try {
    const records = Array.from({ length: 1500 }, (_, index) => `${index}:${'r'.repeat(1400)}`)
    f.manifest.hostMigration.localSource.ownerUpdate.original.source.records = records
    const saved = await lifecycleProfileTest.writeManifest(f.transactionRoot, f.manifest, 'preparing')
    const source = await readFile(join(f.transactionRoot, 'manifest.json'))
    expect(source.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    expect(source.byteLength).toBeLessThan(8 * 1024 * 1024)
    expect(source.toString('utf8').startsWith('{"version":4,')).toBe(true)
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(saved, f.expected, f.transactionRoot)).not.toThrow()
    const oversized = structuredClone(f.manifest)
    oversized.hostMigration.localSource.ownerUpdate.original.source.records.push('x'.repeat(8 * 1024 * 1024))
    await expect(lifecycleProfileTest.writeManifest(f.transactionRoot, oversized, 'prepared'))
      .rejects.toThrow(/超过 8388608 字节安全上限/u)
    expect(await readFile(join(f.transactionRoot, 'manifest.json'))).toEqual(source)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('generic v4 stays below 2 MiB and legacy manifests stay below 64 KiB', async () => {
  const f = await fixture()
  try {
    const generic = genericManifest(f.manifest)
    const saved = await lifecycleProfileTest.writeManifest(f.transactionRoot, generic, 'preparing')
    const original = await readFile(join(f.transactionRoot, 'manifest.json'))
    expect(original.toString('utf8')).toContain('\n  "version": 4,\n')
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(saved, f.expected, f.transactionRoot)).not.toThrow()
    await expect(lifecycleProfileTest.writeManifest(f.transactionRoot,
      { ...generic, failure: 'x'.repeat(2 * 1024 * 1024) }, 'prepared'))
      .rejects.toThrow(/超过 2097152 字节安全上限/u)
    expect(await readFile(join(f.transactionRoot, 'manifest.json'))).toEqual(original)
    const legacy = { ...saved, version: 1, hostMigration: undefined }
    await expect(lifecycleProfileTest.writeManifest(f.transactionRoot,
      { ...legacy, failure: 'x'.repeat(64 * 1024) }, 'preparing'))
      .rejects.toThrow(/超过 65536 字节安全上限/u)
    expect(await readFile(join(f.transactionRoot, 'manifest.json'))).toEqual(original)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'linux')('Linux loader accepts old pretty v4 and new large owner program, then rejects tampering and class-specific oversize', async () => {
  const f = await fixture()
  try {
    const path = join(f.transactionRoot, 'manifest.json')
    f.manifest.hostMigration.localSource.ownerUpdate.original.source.records =
      Array.from({ length: 900 }, (_, index) => `${index}:${'r'.repeat(1400)}`)
    const old = await lifecycleProfileTest.writeManifest(f.transactionRoot, f.manifest, 'preparing')
    await writeFile(path, `${JSON.stringify(old, null, 2)}\n`, { mode: 0o600 })
    expect((await readFile(path)).byteLength).toBeGreaterThan(1024 * 1024)
    expect((await readFile(path)).byteLength).toBeLessThan(2 * 1024 * 1024)
    await expect(lifecycleProfileTest.loadManifest(f.transactionRoot, f.expected)).resolves.toEqual(old)
    f.manifest.hostMigration.localSource.ownerUpdate.original.source.records =
      Array.from({ length: 1500 }, (_, index) => `${index}:${'r'.repeat(1400)}`)
    const large = await lifecycleProfileTest.writeManifest(f.transactionRoot, f.manifest, 'preparing')
    await expect(lifecycleProfileTest.loadManifest(f.transactionRoot, f.expected)).resolves.toEqual(large)
    const source = await readFile(path, 'utf8')
    await writeFile(path, source.replace('"candidateEverStarted":false', '"candidateEverStarted":true'), { mode: 0o600 })
    await expect(lifecycleProfileTest.loadManifest(f.transactionRoot, f.expected)).rejects.toThrow()
    const wrongScope = structuredClone(f.manifest)
    wrongScope.hostMigration.localSource.ownerUpdate.coordinatorProfile = 'other'
    await lifecycleProfileTest.writeManifest(f.transactionRoot, wrongScope, 'preparing')
    await expect(lifecycleProfileTest.loadManifest(f.transactionRoot, f.expected)).rejects.toThrow()
    const generic = await lifecycleProfileTest.writeManifest(f.transactionRoot,
      genericManifest(f.manifest), 'preparing')
    await expect(lifecycleProfileTest.loadManifest(f.transactionRoot, f.expected)).resolves.toEqual(generic)
    const genericSource = await readFile(path, 'utf8')
    await writeFile(path, `${genericSource}${' '.repeat(2 * 1024 * 1024)}\n`, { mode: 0o600 })
    await expect(lifecycleProfileTest.loadManifest(f.transactionRoot, f.expected)).rejects.toThrow()
    const legacy = { ...large, version: 1 }
    await writeFile(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 })
    await expect(lifecycleProfileTest.loadManifest(f.transactionRoot, f.expected)).rejects.toThrow()
    await writeFile(path, `${source}${' '.repeat(8 * 1024 * 1024)}\n`, { mode: 0o600 })
    await expect(lifecycleProfileTest.loadManifest(f.transactionRoot, f.expected)).rejects.toThrow()
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
