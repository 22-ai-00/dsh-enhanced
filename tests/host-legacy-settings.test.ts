import { afterEach, expect, test } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import { hostLegacySettingsPermitSigningPayload, verifyHostLegacySettingsImport } from '../scripts/install/host-legacy-settings.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
const sectionAudit = [
  { section: 'ui-onboarding', entry: 'ui-settings-general', result: 'rejected-unsupported-entry' },
  { section: 'agent-presets', entry: 'agent-presets', result: 'rejected-unsupported-entry' },
  { section: 'permission', entry: 'permission', result: 'appended' },
  { section: 'ui-theme', entry: 'ui-theme', result: 'rejected-unsupported-entry' },
  { section: 'agent-default-model', entry: 'agent-default-model', result: 'appended' },
  { section: 'llm-pi-ai', entry: 'llm-pi-ai', result: 'appended' },
]

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-settings-')))
  roots.push(root)
  const homePath = join(root, 'home'), originalPhysicalHome = join(root, 'transaction', 'original-home')
  const preparationRoot = join(root, 'preparation'), archiveRoot = join(root, 'archive')
  const candidateHome = join(preparationRoot, 'candidate-home')
  const candidateHost = join(root, 'candidate-host'), installer = join(root, 'installer')
  const candidateDshPath = join(candidateHost, 'node_modules', '.bin', 'dsh')
  for (const path of [homePath, originalPhysicalHome, preparationRoot, candidateHome, archiveRoot, installer,
    dirname(candidateDshPath), join(candidateHost, 'node_modules'),
    join(originalPhysicalHome, 'profiles', 'assistant'), join(homePath, 'profiles', 'assistant'),
    join(preparationRoot, 'assistant'), join(originalPhysicalHome, 'rsi-authorities', 'assistant'),
    join(homePath, 'rsi-authorities', 'assistant')]) await mkdir(path, { recursive: true, mode: 0o700 })
  await symlink(dirname(import.meta.resolve('yaml/package.json').replace('file://', '')),
    join(candidateHost, 'node_modules', 'yaml'))
  await writeFile(candidateDshPath, '')
  const hostReceipt = 'candidate Host receipt\n', settingsModule = 'native settings module\n'
  const settingsModulePath = join(candidateHost, 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js')
  await mkdir(dirname(settingsModulePath), { recursive: true, mode: 0o700 })
  await writeFile(join(candidateHost, 'receipt.json'), hostReceipt, { mode: 0o600 })
  await writeFile(settingsModulePath, settingsModule, { mode: 0o600 })
  const settings = stringify({ 'ui-onboarding': { done: true }, 'agent-presets': { name: 'old' },
    permission: { defaultPreset: 'auto' }, 'ui-theme': { mode: 'dark' },
    'agent-default-model': { model: 'test' }, 'llm-pi-ai': { providers: {} } })
  const previousImported = 'prior marker\n'
  const originalPatch = '- id: keep\n  name: keep\n'
  const importedPatch = originalPatch + stringify([
    { id: 'permission', name: '@deepseek-ai/dsh-permission-presets', config: { defaultPreset: 'auto' } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { model: 'test' } },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } },
  ])
  for (const [path, value] of [
    [join(originalPhysicalHome, 'settings.yaml'), settings],
    [join(originalPhysicalHome, 'settings.yaml.imported'), previousImported],
    [join(homePath, 'settings.yaml.imported'), settings],
    [join(preparationRoot, 'assistant', 'cordis.patch.yml'), originalPatch],
    [join(originalPhysicalHome, 'profiles', 'assistant', 'cordis.patch.yml'), originalPatch],
    [join(homePath, 'profiles', 'assistant', 'cordis.patch.yml'), importedPatch],
    [join(archiveRoot, 'original-settings.yaml'), settings],
    [join(archiveRoot, 'previous-imported.yaml'), previousImported],
    [join(archiveRoot, 'original-patch.yml'), originalPatch],
    [join(archiveRoot, 'imported-patch.yml'), importedPatch],
  ] as [string, string][]) await writeFile(path, value, { mode: 0o600 })
  const keys = generateKeyPairSync('ed25519')
  const identity = { authority: 'host-test', keyId: 'host-test-key',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const bootstrap = JSON.stringify({ resources: { identities: { host: identity } } })
  await writeFile(join(originalPhysicalHome, 'rsi-authorities', 'assistant', 'bootstrap.json'), bootstrap, { mode: 0o600 })
  await writeFile(join(homePath, 'rsi-authorities', 'assistant', 'bootstrap.json'), bootstrap, { mode: 0o600 })
  const replayMethod = 'native replay method\n'
  const replayReceipt = { protocol: 'dsh-enhanced/native-settings-replay/v1',
    method: 'native-settings-bwrap-replay/v1', methodSha256: sha256(replayMethod),
    hostReceiptSha256: sha256(hostReceipt), candidateHostReceiptDigest: sha256('host'),
    settingsModuleSha256: sha256(settingsModule),
    originalPatchSha256: sha256(originalPatch), importedPatchSha256: sha256(importedPatch),
    originalSettingsSha256: sha256(settings), sectionAudit }
  const replayReceiptFile = `${JSON.stringify(replayReceipt)}\n`
  await writeFile(join(archiveRoot, 'replay-method.mjs'), replayMethod, { mode: 0o600 })
  await writeFile(join(archiveRoot, 'replay-receipt.json'), replayReceiptFile, { mode: 0o600 })
  const rawReplay = { protocol: 'dsh-enhanced/native-settings-replay/v1', root: join(root, 'replay'),
    home: homePath, candidateVersion: '0.2.0-rc.2', original: {
      hostReceiptSha256: sha256(hostReceipt), canonicalSettingsModule: settingsModulePath,
      settingsModuleSha256: sha256(settingsModule), originalPatchSha256: sha256(originalPatch),
      originalSettingsSha256: sha256(settings), originalImportedMarkerSha256: sha256(previousImported),
    }, overlay: { larkDisabled: true, deliverySchedulerDisabled: true, automationsSchedulerDisabled: true },
    ready: true, nativeImportComplete: true,
    sectionResults: sectionAudit.map(item => item.result === 'appended'
      ? { section: item.entry, status: 'accepted' }
      : { section: item.entry, status: 'rejected', category: 'unsupported-entry' }),
    finalPatchSha256: sha256(importedPatch), importedMarkerSha256: sha256(settings),
    originalSettingsRemoved: true, termination: { code: null, signal: 'SIGTERM' } }
  const rawReplayFile = `${JSON.stringify(rawReplay)}\n`
  await writeFile(join(archiveRoot, 'replay-observation.json'), rawReplayFile, { mode: 0o600 })
  const manifest = { id: 'transaction-1', profile: 'assistant', homePath, transactionPath: join(root, 'transaction'),
    hostMigration: { phase: 'accepted', candidateEverStarted: true,
      plan: { candidateRuntime: { version: '0.2.0-rc.2', receiptDigest: sha256('host'), dshPath: candidateDshPath,
        root: candidateHost } } } }
  const preparation = { originalHome: homePath, preparationRoot, candidateHome,
    candidateDshPath, profiles: [{ name: 'assistant', preparedDigests: { 'cordis.patch.yml': sha256(originalPatch) },
      originalDigests: { 'cordis.patch.yml': sha256(originalPatch) } }] }
  const sourceProof = { homePath, profile: 'assistant', installer: { root: installer },
    original: { ownerInventory: { authorityBootstrap: sha256(bootstrap) } } }
  const unsignedPermit = { protocol: 'dsh-enhanced/native-settings-import/v1', homePath, profile: 'assistant',
    transactionId: manifest.id, baseManifestDigest: sha256('manifest'), archiveRoot,
    candidateHostReceiptDigest: manifest.hostMigration.plan.candidateRuntime.receiptDigest,
    candidateHostVersion: manifest.hostMigration.plan.candidateRuntime.version,
    originalPatchSha256: sha256(originalPatch), importedPatchSha256: sha256(importedPatch),
    originalSettingsSha256: sha256(settings), previousImportedSha256: sha256(previousImported),
    replayReceiptSha256: sha256(canonical(replayReceipt)), replayReceiptFileSha256: sha256(replayReceiptFile),
    rawReplaySha256: sha256(rawReplayFile), sectionAudit,
    authority: identity.authority, keyId: identity.keyId }
  const signed = (body = unsignedPermit) => ({ ...body, signature: sign(null,
    hostLegacySettingsPermitSigningPayload(body), keys.privateKey).toString('base64url') })
  const permit = signed()
  await writeFile(join(archiveRoot, 'permit.json'), `${JSON.stringify({ permit, replayReceipt })}\n`, { mode: 0o600 })
  const input = { permit, replayReceipt, manifest, preparation, sourceProof,
    homePath, stagedHome: homePath, originalPhysicalHome, baseManifestDigest: unsignedPermit.baseManifestDigest }
  return { input, signed, root, settings, originalPatch, importedPatch, originalPhysicalHome, homePath, archiveRoot }
}

test('accepts only an authorized append-only native import with archived originals', async () => {
  const item = await fixture()
  expect(await verifyHostLegacySettingsImport(item.input)).toBe(item.originalPatch)
})

test('revalidates a journaled permit after a candidate start crash but never before start', async () => {
  const item = await fixture()
  const journaled = { permit: item.input.permit, replayReceipt: item.input.replayReceipt }
  const migration = { ...item.input.manifest.hostMigration, phase: 'starting', nativeSettingsImport: journaled }
  expect(await verifyHostLegacySettingsImport({ ...item.input,
    manifest: { ...item.input.manifest, hostMigration: migration } })).toBe(item.originalPatch)
  await expect(verifyHostLegacySettingsImport({ ...item.input,
    manifest: { ...item.input.manifest, hostMigration: { ...migration, nativeSettingsImport: {
      ...journaled, replayReceipt: { ...journaled.replayReceipt, method: 'different' },
    } } } })).rejects.toThrow(/binding/)
  await expect(verifyHostLegacySettingsImport({ ...item.input,
    manifest: { ...item.input.manifest, hostMigration: { ...migration, candidateEverStarted: false } } })).rejects.toThrow(/binding/)
})

test('rejects wrong signatures, transactions, Host receipts, replay and appended rows', async () => {
  const item = await fixture()
  await expect(verifyHostLegacySettingsImport({ ...item.input,
    permit: { ...item.input.permit, signature: item.input.permit.signature.replace(/^./u, 'A') } })).rejects.toThrow()
  await expect(verifyHostLegacySettingsImport({ ...item.input,
    manifest: { ...item.input.manifest, id: 'another-transaction' } })).rejects.toThrow(/binding/)
  await expect(verifyHostLegacySettingsImport({ ...item.input,
    manifest: { ...item.input.manifest, hostMigration: { ...item.input.manifest.hostMigration,
      plan: { candidateRuntime: { ...item.input.manifest.hostMigration.plan.candidateRuntime,
        receiptDigest: sha256('another-host') } } } } })).rejects.toThrow(/binding/)
  await expect(verifyHostLegacySettingsImport({ ...item.input,
    replayReceipt: { ...item.input.replayReceipt, importedPatchSha256: sha256('another-replay') } })).rejects.toThrow(/binding/)
  await writeFile(join(item.homePath, 'profiles', 'assistant', 'cordis.patch.yml'), item.importedPatch + '- id: extra\n')
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/patch differs/)
})

test('rejects modified original settings, imported marker and archive', async () => {
  const item = await fixture()
  await writeFile(join(item.originalPhysicalHome, 'settings.yaml'), item.settings + '\n')
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/settings import marker/)
  await writeFile(join(item.originalPhysicalHome, 'settings.yaml'), item.settings)
  await writeFile(join(item.homePath, 'settings.yaml.imported'), 'changed\n')
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/settings import marker/)
  await writeFile(join(item.homePath, 'settings.yaml.imported'), item.settings)
  await writeFile(join(item.archiveRoot, 'previous-imported.yaml'), 'changed\n')
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/archive bytes/)
})

test('rejects altered replay method, receipt, native module and section audit', async () => {
  const item = await fixture()
  await writeFile(join(item.archiveRoot, 'replay-method.mjs'), 'other method\n')
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/replay method/)
  await writeFile(join(item.archiveRoot, 'replay-method.mjs'), 'native replay method\n')
  await writeFile(join(item.archiveRoot, 'replay-receipt.json'), '{}\n')
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/replay receipt/)
  await writeFile(join(item.archiveRoot, 'replay-receipt.json'), `${JSON.stringify(item.input.replayReceipt)}\n`)
  const modulePath = join(item.input.manifest.hostMigration.plan.candidateRuntime.root,
    'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js')
  await writeFile(modulePath, 'other native module\n')
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/Host bytes/)
  await writeFile(modulePath, 'native settings module\n')
  await expect(verifyHostLegacySettingsImport({ ...item.input,
    replayReceipt: { ...item.input.replayReceipt, sectionAudit: [] } })).rejects.toThrow(/binding/)
})

test('rejects altered raw replay observation despite a valid derived receipt', async () => {
  const item = await fixture()
  const path = join(item.archiveRoot, 'replay-observation.json')
  const changed = JSON.parse(await readFile(path, 'utf8'))
  changed.nativeImportComplete = false
  await writeFile(path, `${JSON.stringify(changed)}\n`)
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/raw replay observation bytes/)
  const { signature: _signature, ...unsigned } = item.input.permit
  const resigned = item.signed({ ...unsigned, rawReplaySha256: sha256(`${JSON.stringify(changed)}\n`) })
  await expect(verifyHostLegacySettingsImport({ ...item.input, permit: resigned })).rejects.toThrow(/raw replay observation differs/)
})

test('requires the archived signed permit to match the active envelope', async () => {
  const item = await fixture()
  const path = join(item.archiveRoot, 'permit.json')
  await rm(path)
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/inventory/)
  await writeFile(path, '{}\n', { mode: 0o600 })
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/archived recovery permit differs/)
})

test('rejects missing import marker, symlinked archive evidence and other profile authority', async () => {
  const item = await fixture()
  await rm(join(item.homePath, 'settings.yaml.imported'))
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow()
  await writeFile(join(item.homePath, 'settings.yaml.imported'), item.settings)
  await rm(join(item.archiveRoot, 'imported-patch.yml'))
  await symlink(join(item.homePath, 'profiles', 'assistant', 'cordis.patch.yml'), join(item.archiveRoot, 'imported-patch.yml'))
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/unsafe recovery input file/)
  await rm(join(item.archiveRoot, 'imported-patch.yml'))
  await writeFile(join(item.archiveRoot, 'imported-patch.yml'), item.importedPatch)
  await expect(verifyHostLegacySettingsImport({ ...item.input,
    permit: { ...item.input.permit, profile: 'web' } })).rejects.toThrow(/binding/)
})

test('rejects a new Home-level patch or public archive evidence', async () => {
  const item = await fixture()
  await writeFile(join(item.homePath, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/Home-level patch/)
  await rm(join(item.homePath, 'cordis.patch.yml'))
  await symlink(join(item.homePath, 'profiles', 'assistant', 'cordis.patch.yml'),
    join(item.input.preparation.candidateHome, 'cordis.patch.yml'))
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/unsafe recovery input file/)
  await rm(join(item.input.preparation.candidateHome, 'cordis.patch.yml'))
  await chmod(join(item.archiveRoot, 'original-settings.yaml'), 0o644)
  await expect(verifyHostLegacySettingsImport(item.input)).rejects.toThrow(/unsafe recovery input file/)
})
