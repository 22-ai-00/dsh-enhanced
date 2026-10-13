import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { hostLocalSourcePlanMode } from '../scripts/install/host-lifecycle.mjs'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const home = '/private/home'
const cache = '/private/hosts'
const legacy = { version: '0.1.5-rc.3', root: `${cache}/0.1.5-rc.3`,
  dshPath: `${cache}/0.1.5-rc.3/node_modules/.bin/dsh`,
  binDirectory: `${cache}/0.1.5-rc.3/node_modules/.bin`,
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, receiptDigest: 'a'.repeat(64) }
const current = { ...legacy, version: '0.2.0-rc.2', root: `${cache}/0.2.0-rc.2`,
  dshPath: `${cache}/0.2.0-rc.2/node_modules/.bin/dsh`,
  binDirectory: `${cache}/0.2.0-rc.2/node_modules/.bin`, receiptDigest: 'b'.repeat(64) }
const binding = (runtime: typeof legacy) => `${JSON.stringify({ schemaVersion: 1, cacheRoot: cache,
  version: runtime.version, receiptDigest: runtime.receiptDigest })}\n`
const sameHostPlan = { schemaVersion: 1, status: 'current', canonicalHome: home,
  bindingPath: `${home}/.dsh-rsi-host.json`, originalBindingSource: binding(current),
  originalBindingDigest: sha256(binding(current)), originalRuntime: current,
  candidateRuntime: current, candidateBindingSource: binding(current) }
const legacyPlan = { ...sameHostPlan, schemaVersion: 2, status: 'update',
  originalBindingSource: null, originalBindingDigest: null, originalRuntime: legacy }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('same-runtime joint source admission', () => {
  test('accepts only a current schema 1 DSH 0.2 runtime or a legacy schema 2 update', () => {
    expect(hostLocalSourcePlanMode(sameHostPlan)).toBe('same-host')
    expect(hostLocalSourcePlanMode(legacyPlan)).toBe('legacy')
    expect(() => hostLocalSourcePlanMode({ ...sameHostPlan, originalRuntime: legacy,
      candidateRuntime: legacy, originalBindingSource: binding(legacy),
      originalBindingDigest: sha256(binding(legacy)), candidateBindingSource: binding(legacy) })).toThrow()
    expect(() => hostLocalSourcePlanMode({ ...sameHostPlan, schemaVersion: 2 })).toThrow()
    expect(() => hostLocalSourcePlanMode({ ...sameHostPlan, schemaVersion: 3 })).toThrow()
  })

  test('rejects forged Host transitions and changed Home or binding identities', () => {
    for (const changed of [
      { ...sameHostPlan, status: 'update' },
      { ...legacyPlan, originalBindingSource: binding(legacy), originalBindingDigest: sha256(binding(legacy)) },
      { ...legacyPlan, status: 'current' },
      { ...sameHostPlan, canonicalHome: '/other/home' },
      { ...sameHostPlan, originalBindingDigest: 'f'.repeat(64) },
      { ...sameHostPlan, candidateRuntime: { ...current, receiptDigest: 'c'.repeat(64) } },
      { ...sameHostPlan, candidateBindingSource: binding(legacy) },
    ]) expect(() => hostLocalSourcePlanMode(changed)).toThrow()
  })

  test('accepts a bound current manifest only with joint source proof and unchanged unit bytes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-same-runtime-manifest-')))
    roots.push(root)
    const homePath = join(root, 'home'), transactionRoot = join(root, 'transaction')
    await mkdir(homePath, { mode: 0o700 })
    await mkdir(transactionRoot, { mode: 0o700 })
    const transaction = await lstat(transactionRoot)
    const currentPlan = { ...sameHostPlan, canonicalHome: homePath,
      bindingPath: join(homePath, '.dsh-rsi-host.json') }
    const source = '[Service]\nExecStart=current-host\n'
    const unit = { unit: 'dsh-profile-assistant.service', profile: 'assistant',
      path: join(root, 'dsh-profile-assistant.service'), before: source, after: source,
      beforeDigest: sha256(source), afterDigest: sha256(source), pathEnvironment: 'PATH=/usr/bin' }
    const base = { version: 4, id: 'same-runtime-test', homePath, canonicalHome: homePath,
      transactionPath: transactionRoot, transactionIdentity: { dev: String(transaction.dev),
        ino: String(transaction.ino), uid: transaction.uid, mode: transaction.mode },
      profile: 'assistant', operation: 'host-update', services: [{ unit: unit.unit, profile: 'assistant', wasActive: true }],
      unitUniverse: [unit.unit], foreignOwnership: [], serviceMasks: [], serviceStartBarriers: [],
      containmentMasks: [], containmentMaskIntents: [], containmentStartBarriers: [],
      hostMigration: { plan: currentPlan, units: [unit], phase: 'initializing',
        candidateEverStarted: false, originalExternalLinksDigest: 'a'.repeat(64),
        localSource: { protocol: 'dsh-enhanced/host-local-source-update/v1', homePath, profile: 'assistant' } } }
    const expected = { homePath, transactionPath: transactionRoot, profile: 'assistant' }
    const write = (changed: object, state = 'preparing') => lifecycleProfileTest.writeManifest(transactionRoot,
      { ...base, ...changed }, state)
    const empty = await write({ services: [], unitUniverse: [], hostMigration: { ...base.hostMigration, units: [] } })
    expect(lifecycleProfileTest.validManifestTopLevel(empty)).toBe(true)
    expect((await lstat(transactionRoot)).ino).toBe(transaction.ino)
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(empty, expected, transactionRoot)).toThrow()
    const valid = await write({})
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(valid, expected, transactionRoot)).not.toThrow()
    const inactive = await write({ services: [{ ...base.services[0], wasActive: false }] })
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(inactive, expected, transactionRoot)).toThrow()
    const recovered = await write({ hostMigration: { ...base.hostMigration, phase: 'units-changed' } }, 'failed')
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(recovered, expected, transactionRoot)).not.toThrow()
    const noSource = await write({ hostMigration: { ...base.hostMigration, localSource: undefined } })
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(noSource, expected, transactionRoot)).toThrow()
    const nullSource = await write({ hostMigration: { ...base.hostMigration, localSource: null } })
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(nullSource, expected, transactionRoot)).toThrow()
    const rewrittenUnit = { ...unit, after: `${source}Environment=changed\n`,
      afterDigest: sha256(`${source}Environment=changed\n`) }
    const changedUnit = await write({ hostMigration: { ...base.hostMigration, units: [rewrittenUnit] } })
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(changedUnit, expected, transactionRoot)).toThrow()
    const fakeUpdate = await write({ hostMigration: { ...base.hostMigration,
      plan: { ...currentPlan, status: 'update' } } })
    expect(() => lifecycleProfileTest.validateHostUpdateManifest(fakeUpdate, expected, transactionRoot)).toThrow()
  })
})

describe.skipIf(process.platform !== 'linux')('same-runtime unit reconciliation', () => {
  test('retains exact source, inode, and timestamps across forward and recovery reentry', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-same-runtime-unit-')))
    roots.push(root)
    const path = join(root, 'dsh-profile-assistant.service')
    const source = '[Service]\nExecStart=/usr/bin/node /private/hosts/0.2.0-rc.2/node_modules/.bin/dsh\n'
    await writeFile(path, source, { mode: 0o600 })
    const unit = { unit: 'dsh-profile-assistant.service', profile: 'assistant', path,
      before: source, after: source, beforeDigest: sha256(source), afterDigest: sha256(source) }
    const before = await lstat(path)
    await lifecycleProfileTest.reconcileHostUnitSources([unit], 'after')
    await lifecycleProfileTest.reconcileHostUnitSources([unit], 'after')
    await lifecycleProfileTest.reconcileHostUnitSources([unit], 'before')
    const after = await lstat(path)
    expect(await readFile(path, 'utf8')).toBe(source)
    expect([after.dev, after.ino, after.mtimeMs, after.ctimeMs])
      .toEqual([before.dev, before.ino, before.mtimeMs, before.ctimeMs])
  })

  test('rejects unit byte drift and leaves it untouched during recovery', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-same-runtime-unit-drift-')))
    roots.push(root)
    const path = join(root, 'dsh-profile-assistant.service'), before = '[Service]\nExecStart=original\n'
    await writeFile(path, 'tampered\n', { mode: 0o600 })
    const unit = { unit: 'dsh-profile-assistant.service', profile: 'assistant', path,
      before, after: before, beforeDigest: sha256(before), afterDigest: sha256(before) }
    const identity = await lstat(path)
    await expect(lifecycleProfileTest.reconcileHostUnitSources([unit], 'after')).rejects.toThrow()
    await expect(lifecycleProfileTest.reconcileHostUnitSources([unit], 'before')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('tampered\n')
    expect((await lstat(path)).ino).toBe(identity.ino)
  })
})
