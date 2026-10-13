import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { isMap, isSeq, parseDocument } from 'yaml'
import { appendOwnerSourceRepairMaintenance, captureOwnerSourceRepairSuccessor, ownerRepairSnapshotEquivalent,
  ownerRepairSuccessorSnapshotEquivalent, readOwnerRepairPredecessorChain,
  selectOwnerRepairPermission } from '../scripts/install/owner-source-repair.mjs'
import { readRsiHostUpdateOverlayChain, rsiHostUpdateOverlayDigest,
  signRsiOwnerRepairOverlay } from '../plugins/lark-channel/src/rsi-host-update.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const stageState = vi.hoisted(() => ({ source: null as unknown, ledger: null as unknown,
  trust: null as unknown, appendCount: 0 }))
vi.mock('../scripts/install/local-source-maintenance.mjs', () => ({ assertLocalSourceInstaller: vi.fn() }))
vi.mock('../plugins/lark-channel/lib/rsi-source-maintenance.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), readRsiSourceMaintenance: async () => stageState.source,
}))
vi.mock('../plugins/plugin-control-plane/lib/index.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  parseSourceMaintenanceRecord: (record: unknown) => record,
  sourceMaintenanceDigest: () => 'd'.repeat(64),
  loadTrustConfig: async () => stageState.trust,
  ControlPlaneStore: class {
    readSourceMaintenanceState() { return stageState.ledger }
    readSourceMaintenanceActivationState() { return { kind: 'none' } }
    async appendSourceMaintenance(record: unknown) {
      stageState.appendCount += 1
      const before = stageState.ledger as { history: unknown[]; records: unknown[] }
      stageState.ledger = { ...before, records: [...before.records, record] }
    }
    close() {}
  },
}))

test('successor append accepts signed seq1 trust bytes, but rejects staged trust drift', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-successor-trust-')))
  roots.push(root)
  const homePath = join(root, 'home'), stageHome = join(root, 'stage'), profile = 'target'
  const configRoot = join(homePath, 'rsi-authorities', profile, 'config')
  const trustPath = join(stageHome, 'rsi-authorities', profile, 'config', 'trust.json')
  await mkdir(homePath, { mode: 0o700 })
  await mkdir(join(stageHome, 'rsi-authorities', profile, 'config'), { recursive: true, mode: 0o700 })
  const bootstrapTrust = '{"version":"bootstrap"}\n'
  const signedTrust = '{"version":"first-repair"}\n'
  await writeFile(trustPath, signedTrust, { mode: 0o600 })
  const sha = (source: string) => createHash('sha256').update(source).digest('hex')
  const prior = { sequence: 1 }, record = { host: null, after: { sourceCommit: 'candidate' } }
  const sourceState = { history: [], records: [prior] }
  stageState.source = { records: [prior, record], anchor: { kind: 'owner' },
    workspace: { sourceCommit: 'candidate' } }
  stageState.ledger = sourceState
  stageState.trust = { installationId: 'installation', ledger: { id: 'ledger' }, dshHome: homePath }
  stageState.appendCount = 0
  const ownerRepair = { protocol: 'dsh-enhanced/host-owner-source-repair/v1', homePath, profile,
    installer: { root: process.cwd() }, original: {
      resources: { installationId: 'installation', ledgerId: 'ledger', configRoot },
      source: { records: [prior], anchor: { kind: 'owner' }, workspace: { repository: '/source', baseline: {} } },
      sourceState, receipt: { files: { [join(configRoot, 'trust.json')]: sha(bootstrapTrust) } },
      baselineFiles: { [join(configRoot, 'trust.json')]: sha(signedTrust) },
    } }
  await expect(appendOwnerSourceRepairMaintenance({ ownerRepair, homePath, stageHome, record }))
    .resolves.toMatchObject({ recordDigest: 'd'.repeat(64) })
  expect(stageState.appendCount).toBe(1)
  stageState.ledger = sourceState
  await writeFile(trustPath, '{"version":"tampered"}\n')
  await expect(appendOwnerSourceRepairMaintenance({ ownerRepair, homePath, stageHome, record }))
    .rejects.toThrow('staged old owner trust differs')
  expect(stageState.appendCount).toBe(1)
  await writeFile(trustPath, signedTrust)
  stageState.trust = { installationId: 'different', ledger: { id: 'ledger' }, dshHome: homePath }
  await expect(appendOwnerSourceRepairMaintenance({ ownerRepair, homePath, stageHome, record }))
    .rejects.toThrow('staged old owner trust differs')
  expect(stageState.appendCount).toBe(1)
})

test('successor keeps the already selected permission preset instead of resetting authority', () => {
  const effective = `- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      workspace-write:
        sandbox: workspace-write
      danger-full-access:
        sandbox: danger-full-access
    defaultPreset: workspace-write
`
  const input = { targetEffective: effective, targetPatch: '- id: unrelated\n  config: {}\n',
    permissionPreset: 'workspace-write', currentPreset: 'workspace-write', yaml: { parseDocument, isMap, isSeq } }
  const selected = selectOwnerRepairPermission(input)
  expect(selected.targetEffective).toContain('defaultPreset: workspace-write')
  expect(selected.targetPatch).toContain('defaultPreset: workspace-write')
  expect(() => selectOwnerRepairPermission({ ...input, permissionPreset: 'danger-full-access' }))
    .toThrow('invalid explicit permission selection')
  expect(() => selectOwnerRepairPermission({ ...input,
    targetEffective: effective.replace('defaultPreset: workspace-write', 'defaultPreset: auto') }))
    .toThrow('permission default differs from repair baseline')
})

test('successor capture rejects missing or forged predecessor before loading an installer', async () => {
  const homePath = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-successor-')))
  roots.push(homePath)
  const input = { homePath, profile: 'target', installer: {}, permissionPreset: 'workspace-write',
    dshPath: '/usr/bin/dsh' }
  await expect(captureOwnerSourceRepairSuccessor({ ...input, predecessorProof: undefined }))
    .rejects.toThrow('successor predecessor scope differs')
  await expect(captureOwnerSourceRepairSuccessor({ ...input, predecessorProof: {
    protocol: 'dsh-enhanced/host-owner-source-repair/v1', homePath, profile: 'target',
    ownerRepairNext: {}, ownerRepair: { permissionPreset: 'danger-full-access', dshPath: '/usr/bin/dsh' },
  } })).rejects.toThrow('successor predecessor scope differs')
})

test('successor accepts only a byte-identical copied owner database with the same binding', () => {
  const original = { protocol: 'assistant-delivery/active-lark-owner-bindings-snapshot/v1', schemaVersion: 25,
    scope: { account: 'account', tenant: 'tenant', workspace: 'workspace', agentPreset: 'preset' },
    bindings: [{ id: 'binding', owner: { id: 'owner' } }],
    database: { device: '1', inode: '42' }, sidecars: { wal: null, shm: null },
    storageDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) }
  const copied = { ...original, database: { device: '1', inode: '43' }, snapshotDigest: 'c'.repeat(64) }
  expect(ownerRepairSnapshotEquivalent(copied, original)).toBe(false)
  expect(ownerRepairSuccessorSnapshotEquivalent(copied, original)).toBe(true)
  expect(ownerRepairSuccessorSnapshotEquivalent({ ...copied, storageDigest: 'd'.repeat(64) }, original)).toBe(false)
  expect(ownerRepairSuccessorSnapshotEquivalent({ ...copied, database: { device: '2', inode: '43' } }, original)).toBe(false)
  expect(ownerRepairSuccessorSnapshotEquivalent({ ...copied, scope: { ...copied.scope, account: 'other' } }, original)).toBe(false)
  expect(ownerRepairSuccessorSnapshotEquivalent({ ...copied, bindings: [{ id: 'other' }] }, original)).toBe(false)
  expect(ownerRepairSuccessorSnapshotEquivalent({ ...copied, schemaVersion: 26 }, original)).toBe(false)
  expect(ownerRepairSuccessorSnapshotEquivalent({ ...copied, database: { device: '1' } }, original)).toBe(false)
  expect(ownerRepairSuccessorSnapshotEquivalent({ ...copied, sidecars: {} }, original)).toBe(false)
  expect(ownerRepairSuccessorSnapshotEquivalent({ ...copied, storageDigest: 'malformed' }, original)).toBe(false)
})
import { createHash, generateKeyPairSync } from 'node:crypto'

test('successor predecessor requires exact signed two-repair chain and current baseline', () => {
  const sha = (source: string) => createHash('sha256').update(source).digest('hex')
  const key = generateKeyPairSync('ed25519')
  const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const homePath = '/private/home', profile = 'target', coordinatorProfile = 'coordinator'
  const configRoot = `${homePath}/rsi-authorities/${profile}/config`
  const manifestPath = `${configRoot}/manifest.json`
  const resources = { installationId: 'installed', configRoot,
    identities: { host: { authority: 'host-installed', keyId: 'host-key',
      publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } } as any
  const bootstrapSource = '{"schemaVersion":1}\n'
  const files = { [manifestPath]: sha('manifest-1') }
  const patches = { [profile]: sha('patch-1'), [coordinatorProfile]: sha('patch-2') }
  const input = { schemaVersion: 1 as const, kind: 'rsi-owner-repair-overlay' as const,
    transactionId: 'transaction-1', dshHome: homePath, targetProfile: profile,
    installationId: resources.installationId, sequence: 1, previousDigest: null,
    bootstrapDigest: sha(bootstrapSource), files, patches, runtimeReceiptDigest: sha('runtime-1'),
    planDigest: sha('plan-1'), result: { schemaVersion: 1 as const, manifestPath,
      manifestDigest: files[manifestPath], targetProfile: profile, coordinatorProfile },
    repair: { sourceMaintenanceDigest: sha('source-1'),
      before: { files, patches, runtimeReceiptDigest: sha('runtime-0'),
        creationReceiptDigest: sha('creation-0'), journalDigest: sha('journal-0') },
      after: { creationReceiptDigest: sha('creation-1'), journalDigest: sha('journal-1') },
      permissionPreset: 'workspace-write' as const },
    issuedAt: 1, authority: 'host-installed', keyId: 'host-key' }
  const first = signRsiOwnerRepairOverlay(input, privateKey, resources, bootstrapSource, [])
  const secondFiles = { [manifestPath]: sha('manifest-2') }
  const secondPatches = { [profile]: sha('patch-3'), [coordinatorProfile]: sha('patch-4') }
  const second = signRsiOwnerRepairOverlay({ ...input, transactionId: 'transaction-2',
    sequence: 2, previousDigest: rsiHostUpdateOverlayDigest(first), issuedAt: 2,
    files: secondFiles, patches: secondPatches, runtimeReceiptDigest: sha('runtime-2'),
    result: { ...input.result, manifestDigest: secondFiles[manifestPath] },
    repair: { ...input.repair, sourceMaintenanceDigest: sha('source-2'),
      before: { files, patches, runtimeReceiptDigest: first.runtimeReceiptDigest,
        creationReceiptDigest: first.repair.after.creationReceiptDigest,
        journalDigest: first.repair.after.journalDigest },
      after: { creationReceiptDigest: sha('creation-2'), journalDigest: sha('journal-2') } } },
  privateKey, resources, bootstrapSource, [first])
  const api = { readRsiHostUpdateOverlayChain, rsiHostUpdateOverlayDigest }
  const source = (records: unknown[]) => JSON.stringify({ schemaVersion: 1,
    kind: 'rsi-host-update-overlays', records })
  const ownerRepair = { homePath, profile, original: { resources, receiptSource: bootstrapSource,
    baselineFiles: secondFiles, baselinePatches: secondPatches }, predecessor: {
    sourceProofDigest: sha('frozen-predecessor-proof'), overlayDigest: rsiHostUpdateOverlayDigest(second),
    records: [first, second] } }
  expect(readOwnerRepairPredecessorChain(api, ownerRepair, source([first, second]))).toEqual([first, second])
  expect(() => readOwnerRepairPredecessorChain(api, ownerRepair, source([first]))).toThrow()
  expect(() => readOwnerRepairPredecessorChain(api, ownerRepair,
    source([first, { ...second, runtimeReceiptDigest: sha('tampered') }]))).toThrow()
  expect(() => readOwnerRepairPredecessorChain(api, { ...ownerRepair,
    original: { ...ownerRepair.original, baselineFiles: files } }, source([first, second])))
    .toThrow('signed predecessor overlay chain differs')
  expect(() => readOwnerRepairPredecessorChain(api, { ...ownerRepair,
    predecessor: { ...ownerRepair.predecessor, sourceProofDigest: 'invalid' } }, source([first, second])))
    .toThrow('invalid successor predecessor reference')
  expect(() => signRsiOwnerRepairOverlay({ ...input, files: { '/outside/manifest.json': sha('escape') } },
    privateKey, resources, bootstrapSource, [])).toThrow('repair overlay shape')
})
