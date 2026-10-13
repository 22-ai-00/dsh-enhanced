import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const homePath = '/private/home'
const transactionRoot = `${homePath}.dsh-enhanced-transaction`
const archiveRoot = `${transactionRoot}.owner-predecessor-11111111-1111-4111-8111-111111111111`
const profile = 'assistant'
const coordinatorProfile = `rsi-${profile}-${hash(profile).slice(0, 12)}`
const runtime = { version: '0.2.0-rc.2', root: '/private/hosts/0.2.0-rc.2',
  dshPath: '/private/hosts/0.2.0-rc.2/node_modules/.bin/dsh',
  binDirectory: '/private/hosts/0.2.0-rc.2/node_modules/.bin', receiptDigest: 'a'.repeat(64),
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }
const binding = `${JSON.stringify({ schemaVersion: 1, cacheRoot: '/private/hosts',
  version: runtime.version, receiptDigest: runtime.receiptDigest })}\n`
const plan = { schemaVersion: 1, status: 'current', canonicalHome: homePath,
  bindingPath: `${homePath}/.dsh-rsi-host.json`, originalBindingSource: binding,
  originalBindingDigest: hash(binding), originalRuntime: runtime, candidateRuntime: runtime,
  candidateBindingSource: binding }
const services = [profile, coordinatorProfile].map(name => ({
  unit: `dsh-profile-${name}.service`, profile: name, wasActive: true,
}))
const identity = { dev: '1', ino: '2', uid: process.getuid(), mode: 0o100600 }
const masks = services.map(service => ({ unit: service.unit, path: `/private/systemd/${service.unit}`,
  target: '/dev/null', transactionRoot,
  stagingPath: `${transactionRoot}/masks/${service.unit}`, identity }))
const barriers = services.map(service => ({ unit: service.unit, originalUnitFileState: 'enabled',
  enablement: { path: `/private/systemd/default.target.wants/${service.unit}`,
    target: `/private/systemd/${service.unit}`, transactionRoot,
    stagingPath: `${transactionRoot}/enablement/${service.unit}`, identity } }))

function manifest() {
  return { version: 4, operation: 'host-update', state: 'swapped', profile,
    services, serviceMasks: masks, serviceStartBarriers: barriers,
    containmentMasks: [], containmentMaskIntents: [], containmentStartBarriers: [],
    hostMigration: { phase: 'starting', candidateEverStarted: true, plan,
      localSource: { protocol: 'dsh-enhanced/host-owner-source-repair/v1', ownerRepairNext: {},
        ownerRepair: { permissionPreset: 'danger-full-access' } } } }
}

test('admits only the started, unaccepted same-Host owner repair and the same preset', () => {
  const current = manifest()
  expect(() => lifecycleProfileTest.assertHostOwnerSuccessorAdmission(current, 'danger-full-access')).not.toThrow()
  const invalid = [
    { ...current, state: 'preparing' },
    { ...current, serviceAcceptance: [] },
    { ...current, operation: 'upgrade' },
    { ...current, hostMigration: { ...current.hostMigration, phase: 'accepted' } },
    { ...current, hostMigration: { ...current.hostMigration, candidateEverStarted: false } },
    { ...current, hostMigration: { ...current.hostMigration, nativeSettingsImport: {} } },
    { ...current, hostMigration: { ...current.hostMigration,
      plan: { ...plan, status: 'update' } } },
    { ...current, hostMigration: { ...current.hostMigration,
      localSource: { ...current.hostMigration.localSource, protocol: 'dsh-enhanced/host-local-source-update/v1' } } },
    { ...current, hostMigration: { ...current.hostMigration,
      localSource: { ...current.hostMigration.localSource, ownerRepairNext: undefined } } },
    { ...current, containmentMasks: [{}] },
    { ...current, containmentMaskIntents: [{}] },
    { ...current, containmentStartBarriers: [{}] },
    { ...current, services: services.slice(0, 1) },
  ]
  for (const candidate of invalid) {
    expect(() => lifecycleProfileTest.assertHostOwnerSuccessorAdmission(candidate, 'danger-full-access')).toThrow()
  }
  expect(() => lifecycleProfileTest.assertHostOwnerSuccessorAdmission(current, 'workspace-write')).toThrow()
})

test('archive rebase changes only transaction roots and staging locations', () => {
  const current = manifest()
  const before = JSON.stringify(current)
  const relocated = lifecycleProfileTest.ownerSuccessorServiceBarriers(current, transactionRoot, archiveRoot)
  expect(relocated.masks).toEqual(masks.map(mask => ({ ...mask, transactionRoot: archiveRoot,
    stagingPath: `${archiveRoot}${mask.stagingPath.slice(transactionRoot.length)}` })))
  expect(relocated.barriers).toEqual(barriers.map(barrier => ({ ...barrier,
    enablement: { ...barrier.enablement, transactionRoot: archiveRoot,
      stagingPath: `${archiveRoot}${barrier.enablement.stagingPath.slice(transactionRoot.length)}` } })))
  expect(JSON.stringify(current)).toBe(before)
})

test('archive rebase rejects a foreign or root-level staging location', () => {
  const current = manifest()
  for (const changed of [
    { ...masks[0], transactionRoot: '/private/foreign' },
    { ...masks[0], stagingPath: '/private/foreign/mask' },
    { ...masks[0], stagingPath: `${transactionRoot}-other/mask` },
    { ...masks[0], stagingPath: transactionRoot },
  ]) {
    expect(() => lifecycleProfileTest.ownerSuccessorServiceBarriers({ ...current,
      serviceMasks: [changed, masks[1]] }, transactionRoot, archiveRoot)).toThrow('containment path changed')
  }
  for (const changed of [
    { ...barriers[0].enablement, transactionRoot: '/private/foreign' },
    { ...barriers[0].enablement, stagingPath: '/private/foreign/link' },
    { ...barriers[0].enablement, stagingPath: transactionRoot },
  ]) {
    expect(() => lifecycleProfileTest.ownerSuccessorServiceBarriers({ ...current,
      serviceStartBarriers: [{ ...barriers[0], enablement: changed }, barriers[1]] },
    transactionRoot, archiveRoot)).toThrow('containment path changed')
  }
})
