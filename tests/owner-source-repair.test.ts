import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Document, isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { appendOwnerSourceRepairMaintenance, assertIssuerStateAbsent, awaitOwnerSourceRepairReady,
  captureOwnerSourceRepair, composeOwnerRepairProfiles, prepareOwnerRepairCreation, selectOwnerRepairPermission,
  ownerLedger, ownerRepairPatchEquivalent, ownerRepairSnapshotEquivalent, readOwnerRepairCandidateSource, stageOwnerSourceRepair,
  verifyOwnerSourceRepair } from '../scripts/install/owner-source-repair.mjs'
import { rsiBootstrapFixture } from '../plugins/lark-channel/tests/fixtures/rsi-bootstrap.js'
import { readRsiSourceWorkspace } from '../plugins/lark-channel/src/rsi-source.js'

const roots: string[] = []
const dshExecutable = spawnSync('which', ['dsh'], { encoding: 'utf8' }).stdout.trim()
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const effective = `- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      workspace-write:
        sandbox: workspace-write
      danger-full-access:
        sandbox: danger-full-access
    defaultPreset: auto
- id: unrelated
  name: '@dsh-enhanced/unrelated'
  config:
    path: !!js dshHomePath('existing')
`
const patch = `- id: unrelated
  config:
    path: !!js dshHomePath('existing')
`

test.skipIf(process.platform !== 'linux')('candidate creation rereads the receipt-bound source origin, not its managed checkout', async () => {
  const fixture = await rsiBootstrapFixture()
  try {
    const source = fixture.input.source
    const candidateHome = join(fixture.root, 'home')
    expect(source.origin.kind).toBe('local-head')
    expect(source.origin.locator).not.toBe(source.repository)
    const input = { api: { readRsiSourceWorkspace }, candidateHome, profile: 'target', source }
    await expect(readOwnerRepairCandidateSource(input)).resolves.toEqual(source)
    await expect(readOwnerRepairCandidateSource({ ...input,
      source: { ...source, origin: { kind: 'local-head', locator: source.repository, ref: 'HEAD' } } }))
      .rejects.toThrow(/workspace receipt provenance differs/u)
    await expect(readOwnerRepairCandidateSource({ ...input,
      source: { ...source, sourceCommit: '0'.repeat(40) } }))
      .rejects.toThrow('candidate source or build differs')
  } finally { await fixture.cleanup() }
})

function rows(source: string) {
  const document = parseDocument(source, { uniqueKeys: true })
  expect(document.errors).toHaveLength(0)
  expect(isSeq(document.contents)).toBe(true)
  return document.contents!.items
}

test('explicit permission selection changes only the installed default and preserves unrelated executable tags', () => {
  for (const permissionPreset of ['workspace-write', 'danger-full-access']) {
    const result = selectOwnerRepairPermission({ targetEffective: effective, targetPatch: patch,
      permissionPreset, yaml: { parseDocument, isMap, isSeq } })
    expect(effective).toContain('defaultPreset: auto')
    expect(patch).not.toContain('permission')
    const target = rows(result.targetEffective)
    const selected = target.find(row => isMap(row) && row.get('id') === 'permission')
    expect(isMap(selected)).toBe(true)
    expect((selected as any).get('config').get('defaultPreset')).toBe(permissionPreset)
    const unrelated = target.find(row => isMap(row) && row.get('id') === 'unrelated')
    expect((unrelated as any).get('config').get('path', true).tag).toBe('tag:yaml.org,2002:js')
    const output = rows(result.targetPatch)
    expect(output.map(row => isMap(row) ? row.get('id') : null)).toEqual(['unrelated', 'permission'])
    const permission = output[1]
    expect((permission as any).get('config').get('defaultPreset')).toBe(permissionPreset)
  }
})

test('original in-memory YAML aliases equal persisted expanded maps without erasing tags or row order', () => {
  const planned = '- id: first\n  config: &scope\n    path: !!js homePath()\n    enabled: true\n- id: second\n  config: *scope\n'
  const applied = '- id: first\n  config:\n    enabled: true\n    path: !!js homePath()\n- id: second\n  config:\n    path: !!js homePath()\n    enabled: true\n'
  const input = { yaml: { parseDocument, isMap, isScalar, isSeq, isAlias }, planned, applied }
  expect(ownerRepairPatchEquivalent(input)).toBe(true)
  expect(ownerRepairPatchEquivalent({ ...input, applied: applied.replace('!!js homePath()', 'homePath()') })).toBe(false)
  expect(ownerRepairPatchEquivalent({ ...input, applied: applied.replace('enabled: true', 'enabled: false') })).toBe(false)
  expect(ownerRepairPatchEquivalent({ ...input, applied: applied.replace('- id: first', '- id: changed') })).toBe(false)
  expect(ownerRepairPatchEquivalent({ ...input, applied: applied.replace('- id: first', '- id: temporary')
    .replace('- id: second', '- id: first').replace('- id: temporary', '- id: second') })).toBe(false)
})

test('owner repair retains exact binding and main database identity across SQLite checkpoints', () => {
  const original = {
    protocol: 'assistant-delivery/active-lark-owner-bindings-snapshot/v1', schemaVersion: 25,
    scope: { account: 'account', tenant: 'tenant', workspace: 'workspace', agentPreset: 'assistant' },
    database: { device: '1', inode: '42', size: '100', mtimeNs: '1000', digest: 'a'.repeat(64) },
    sidecars: { wal: { device: '1', inode: '43', size: '20', mtimeNs: '1000', digest: 'b'.repeat(64) },
      shm: { device: '1', inode: '44', size: '30', mtimeNs: '1000', digest: 'c'.repeat(64) } },
    storageDigest: 'd'.repeat(64), snapshotDigest: 'e'.repeat(64),
    bindings: [{ id: 'binding', version: 1, principal: { id: 'principal' },
      owner: { id: 'owner', version: 1 } }],
  }
  const afterCheckpoint = { ...original,
    database: { ...original.database, size: '120', mtimeNs: '2000', digest: 'f'.repeat(64) },
    sidecars: { wal: null, shm: null }, storageDigest: '1'.repeat(64), snapshotDigest: '2'.repeat(64) }
  expect(ownerRepairSnapshotEquivalent(afterCheckpoint, original)).toBe(true)
  const differences = [
    { ...afterCheckpoint, protocol: 'forged' },
    { ...afterCheckpoint, schemaVersion: 26 },
    { ...afterCheckpoint, scope: { ...original.scope, workspace: 'elsewhere' } },
    { ...afterCheckpoint, bindings: [{ ...original.bindings[0], version: 2 }] },
    { ...afterCheckpoint, bindings: [{ ...original.bindings[0], principal: { id: 'elsewhere' } }] },
    { ...afterCheckpoint, bindings: [{ ...original.bindings[0], owner: { id: 'owner', version: 2 } }] },
    { ...afterCheckpoint, database: { ...afterCheckpoint.database, device: '2' } },
    { ...afterCheckpoint, database: { ...afterCheckpoint.database, inode: '45' } },
  ]
  for (const current of differences) expect(ownerRepairSnapshotEquivalent(current, original)).toBe(false)
  const malformed = [
    { ...original, bindings: [] },
    { ...original, database: { ...original.database, inode: undefined } },
    { ...original, sidecars: {} },
    { ...original, snapshotDigest: 'bad' },
  ]
  for (const current of malformed) {
    expect(ownerRepairSnapshotEquivalent(current, original)).toBe(false)
    expect(ownerRepairSnapshotEquivalent(original, current)).toBe(false)
  }
})

test('receipt plans replay shared in-memory manifest references while persisted JSON expands them', () => {
  const scope = { workspace: 'owner', preset: 'workspace-write' }
  const inMemory = [{ id: 'control-plane', config: { sourceJobs: { scope }, liveQualification: { scope } } }]
  const persisted = JSON.parse(JSON.stringify(inMemory))
  expect(JSON.stringify(inMemory)).toBe(JSON.stringify(persisted))
  const planned = new Document(inMemory).toString()
  const applied = new Document(persisted).toString()
  const digest = (source: string) => createHash('sha256').update(source).digest('hex')
  expect(digest(planned)).not.toBe(digest(applied))
  expect(planned).toMatch(/&a\d/u)
  expect(planned).toMatch(/\*a\d/u)
  expect(ownerRepairPatchEquivalent({ yaml: { parseDocument, isAlias, isMap, isScalar, isSeq },
    planned, applied })).toBe(true)
})

test('permission selection rejects implicit, absent, duplicate, and unconfigured authority', () => {
  const input = { targetEffective: effective, targetPatch: patch,
    permissionPreset: 'workspace-write', yaml: { parseDocument, isMap, isSeq } }
  expect(() => selectOwnerRepairPermission({ ...input, permissionPreset: 'auto' })).toThrow('invalid explicit permission')
  expect(() => selectOwnerRepairPermission({ ...input,
    targetEffective: effective.replace('defaultPreset: auto', 'defaultPreset: workspace-write') })).toThrow('not the original unsupported auto')
  expect(() => selectOwnerRepairPermission({ ...input,
    targetEffective: effective.replace('      workspace-write:\n        sandbox: workspace-write\n', '') })).toThrow('not configured')
  expect(() => selectOwnerRepairPermission({ ...input,
    targetEffective: effective.replace('- id: unrelated', effective.split('- id: unrelated')[0] + '- id: unrelated') })).toThrow('installed permission row differs')
  expect(() => selectOwnerRepairPermission({ ...input,
    targetEffective: effective.replace('@deepseek-ai/dsh-permission-presets', '@dsh-enhanced/pretender') })).toThrow('installed permission row differs')
})

test('issuer state checks receipt-bound paths and rechecks SQLite sidecars before finalization', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-issuer-state-')))
  roots.push(root)
  const homePath = join(root, 'home')
  const stateRoot = join(homePath, 'rsi-authorities', 'owner', 'state')
  const configRoot = join(homePath, 'rsi-authorities', 'owner', 'config')
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const names = ['approval', 'release', 'adoption', 'observation', 'qualification', 'host-authority']
  const files = Object.fromEntries(names.map(name => [join(configRoot, `${name}.json`),
    JSON.stringify({ statePath: join(stateRoot, `${name}.sqlite`) })]))
  const input = { resources: { stateRoot, configRoot }, files, homePath, physicalHome: homePath }
  await expect(assertIssuerStateAbsent(input)).resolves.toBeUndefined()
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = join(stateRoot, `approval.sqlite${suffix}`)
    await writeFile(path, suffix ? '' : 'SQLite format 3', { mode: 0o600 })
    await expect(assertIssuerStateAbsent(input)).rejects.toThrow(/issuer grant state|unsafe file/u)
    await rm(path)
  }
  await writeFile(join(stateRoot, 'approval.json'), 'legacy-name', { mode: 0o600 })
  await expect(assertIssuerStateAbsent(input)).resolves.toBeUndefined()
  expect(await readFile(join(stateRoot, 'approval.json'), 'utf8')).toBe('legacy-name')
  const escaped = { ...files, [join(configRoot, 'release.json')]: JSON.stringify({ statePath: join(root, 'elsewhere.sqlite') }) }
  await expect(assertIssuerStateAbsent({ ...input, files: escaped })).rejects.toThrow('invalid release issuer state path')
})

test.skipIf(!dshExecutable)('native DSH composition reconstructs journal.before without changing installed patches', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-original-compose-')))
  roots.push(root)
  const homePath = join(root, 'home')
  await mkdir(homePath, { mode: 0o700 })
  const patch = '- id: fixture\n  config:\n    value: after\n    expression: !!js new Date()\n'
  const before = '- id: fixture\n  config:\n    value: before\n    expression: !!js new Date(0)\n'
  for (const name of ['target', 'coordinator']) {
    const directory = join(homePath, 'profiles', name)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `fixture-${name}` }))
    await writeFile(join(directory, 'cordis.yml'), '- id: fixture\n  name: fixture\n  config:\n    value: base\n')
    await writeFile(join(directory, 'cordis.patch.yml'), patch)
  }
  const dshPath = await realpath(dshExecutable)
  const input = { homePath, profile: 'target', coordinatorProfile: 'coordinator', dshPath }
  const current = await composeOwnerRepairProfiles(input)
  const old = await composeOwnerRepairProfiles({ ...input,
    patchOverrides: { target: before, coordinator: before } })
  expect(current.targetEffective).toContain('value: after')
  expect(old.targetEffective).toContain('value: before')
  expect(old.coordinatorEffective).toContain('value: before')
  expect(current.targetEffective).toContain('!!js new Date()')
  expect(old.targetEffective).toContain('!!js new Date(0)')
  expect(await readFile(join(homePath, 'profiles', 'target', 'cordis.patch.yml'), 'utf8')).toBe(patch)
  expect(await readFile(join(homePath, 'profiles', 'coordinator', 'cordis.patch.yml'), 'utf8')).toBe(patch)
})

test('owner ledger reads strictly and refuses activation or extra source records', async () => {
  const constructors: unknown[] = []
  const state = { history: [], records: [] as unknown[] }
  let activation: { kind: string } = { kind: 'none' }
  const api = { control: { ControlPlaneStore: class {
    constructor(input: unknown) { constructors.push(input) }
    readSourceMaintenanceState() { return state }
    readSourceMaintenanceActivationState() { return activation }
    close() {}
  } } }
  const input = [api, '/private/control.sqlite', '/private/repository', '/private/home', []] as const
  await expect(ownerLedger(...input)).resolves.toEqual(state)
  expect(constructors).toEqual([{ path: '/private/control.sqlite', readOnly: true }])
  activation = { kind: 'watched' }
  await expect(ownerLedger(...input)).rejects.toThrow('activation or source history drift')
  activation = { kind: 'none' }
  state.records.push({ sequence: 1 })
  await expect(ownerLedger(...input)).rejects.toThrow('activation or source history drift')
})

test('repair hooks reject forged or incomplete proof before touching a Home', async () => {
  const homePath = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-source-repair-')))
  roots.push(homePath)
  const ownerRepair = { protocol: 'forged', homePath, profile: 'owner' }
  await expect(prepareOwnerRepairCreation({ ownerRepair, candidateHome: join(homePath, 'candidate') }))
    .rejects.toThrow('candidate creation Home is not distinct')
  await expect(appendOwnerSourceRepairMaintenance({ ownerRepair, homePath,
    stageHome: join(homePath, 'stage'), record: { host: null } })).rejects.toThrow('not unanchored')
  await expect(stageOwnerSourceRepair({ ownerRepair, homePath,
    stageHome: join(homePath, 'stage') })).rejects.toThrow('stage inputs differ')
  await expect(verifyOwnerSourceRepair({ ownerRepair, homePath })).rejects.toThrow('invalid owner repair proof')
  await expect(awaitOwnerSourceRepairReady({ ownerRepair, homePath, startedAt: Date.now() }))
    .rejects.toThrow('invalid repair readiness input')
  await expect(captureOwnerSourceRepair({ homePath, profile: 'owner', installer: {},
    permissionPreset: 'auto', dshPath: '/usr/bin/dsh' })).rejects.toThrow('explicit permission')
})
