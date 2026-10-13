import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const fail = message => { throw new Error(`Host legacy settings recovery: ${message}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const digestPattern = /^[a-f0-9]{64}$/u
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
const sections = [
  ['ui-onboarding', 'ui-settings-general', 'rejected-unsupported-entry'],
  ['agent-presets', 'agent-presets', 'rejected-unsupported-entry'],
  ['permission', 'permission', 'appended'],
  ['ui-theme', 'ui-theme', 'rejected-unsupported-entry'],
  ['agent-default-model', 'agent-default-model', 'appended'],
  ['llm-pi-ai', 'llm-pi-ai', 'appended'],
]
const appendedNames = {
  permission: '@deepseek-ai/dsh-permission-presets',
  'agent-default-model': '@deepseek-ai/dsh-agent-default-model',
  'llm-pi-ai': '@deepseek-ai/dsh-llm-pi-ai',
}
const permitFields = ['protocol', 'homePath', 'profile', 'transactionId', 'baseManifestDigest', 'archiveRoot',
  'candidateHostReceiptDigest', 'candidateHostVersion', 'originalPatchSha256', 'importedPatchSha256',
  'originalSettingsSha256', 'previousImportedSha256', 'replayReceiptSha256', 'replayReceiptFileSha256',
  'rawReplaySha256', 'sectionAudit',
  'authority', 'keyId']
const replayFields = ['protocol', 'method', 'methodSha256', 'hostReceiptSha256', 'candidateHostReceiptDigest',
  'settingsModuleSha256', 'originalPatchSha256', 'importedPatchSha256', 'originalSettingsSha256', 'sectionAudit']

export function hostLegacySettingsPermitSigningPayload(unsignedPermit) {
  if (!exactKeys(unsignedPermit, permitFields)) fail('invalid unsigned permit fields')
  return Buffer.from(`dsh-enhanced/native-settings-import/v1\0${canonical(unsignedPermit)}`)
}

async function canonicalDirectory(path, privateMode = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
    || await realpath(path) !== path) fail('non-canonical directory')
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || entry.mode & (privateMode ? 0o077 : 0o022)) fail('unsafe directory')
  return path
}

async function privateFile(path, maximum = 1_048_576, optional = false, privateMode = true) {
  const before = await lstat(path).catch(error => {
    if (optional && error?.code === 'ENOENT') return undefined
    throw error
  })
  if (!before) return null
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || before.mode & (privateMode ? 0o077 : 0o022) || before.size > maximum) fail('unsafe recovery input file')
  const bytes = await readFile(path), after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || bytes.length !== before.size) fail('recovery input file changed')
  return bytes
}

function strictYaml(yaml, text, label) {
  const document = yaml.parseDocument(text, { uniqueKeys: true, strict: true, customTags: [{
    tag: 'tag:yaml.org,2002:js', resolve: value => value,
  }] })
  if (document.errors.length || document.warnings.length || /(^|\s)[&*][a-z0-9_-]+/iu.test(text)) fail(`invalid ${label}`)
  return document.toJS({ maxAliasCount: 0 })
}

function assertAudit(audit, settings) {
  if (!Array.isArray(audit) || !isDeepStrictEqual(Object.keys(settings), sections.map(([section]) => section))
    || audit.length !== sections.length) fail('legacy section inventory differs')
  for (let index = 0; index < sections.length; index += 1) {
    const [section, entry, result] = sections[index]
    if (!exactKeys(audit[index], ['section', 'entry', 'result'])
      || audit[index].section !== section || audit[index].entry !== entry || audit[index].result !== result) {
      fail('legacy section audit differs')
    }
  }
}

export async function verifyHostLegacySettingsImport({ permit, replayReceipt, manifest, preparation,
  sourceProof, homePath, stagedHome, originalPhysicalHome, baseManifestDigest }) {
  const migration = manifest?.hostMigration
  const journaled = migration?.nativeSettingsImport
  const phase = migration?.phase
  if (!exactKeys(permit, [...permitFields, 'signature']) || !exactKeys(replayReceipt, replayFields)
    || permit.protocol !== 'dsh-enhanced/native-settings-import/v1'
    || replayReceipt.protocol !== 'dsh-enhanced/native-settings-replay/v1'
    || !digestPattern.test(String(baseManifestDigest)) || permit.baseManifestDigest !== baseManifestDigest
    || permit.homePath !== homePath || permit.profile !== manifest?.profile
    || permit.transactionId !== manifest?.id || manifest?.homePath !== homePath
    || migration?.candidateEverStarted !== true
    || (journaled === undefined ? phase !== 'accepted'
      : !['starting', 'accepted', 'committed', 'cleanup-started'].includes(phase)
        || !isDeepStrictEqual(journaled, { permit, replayReceipt }))
    || permit.candidateHostReceiptDigest !== manifest.hostMigration.plan?.candidateRuntime?.receiptDigest
    || permit.candidateHostVersion !== manifest.hostMigration.plan?.candidateRuntime?.version
    || preparation?.originalHome !== homePath || sourceProof?.homePath !== homePath
    || sourceProof?.profile !== permit.profile || preparation?.candidateDshPath !== manifest.hostMigration.plan?.candidateRuntime?.dshPath
    || ![permit.originalPatchSha256, permit.importedPatchSha256, permit.originalSettingsSha256,
      permit.replayReceiptSha256, permit.replayReceiptFileSha256, permit.rawReplaySha256, replayReceipt.methodSha256,
      replayReceipt.hostReceiptSha256, replayReceipt.settingsModuleSha256].every(value => digestPattern.test(String(value)))
    || permit.previousImportedSha256 !== null && !digestPattern.test(String(permit.previousImportedSha256))
    || replayReceipt.method !== 'native-settings-bwrap-replay/v1'
    || replayReceipt.candidateHostReceiptDigest !== permit.candidateHostReceiptDigest
    || !isDeepStrictEqual(permit.sectionAudit, replayReceipt.sectionAudit)
    || replayReceipt.originalPatchSha256 !== permit.originalPatchSha256
    || replayReceipt.importedPatchSha256 !== permit.importedPatchSha256
    || replayReceipt.originalSettingsSha256 !== permit.originalSettingsSha256
    || sha256(canonical(replayReceipt)) !== permit.replayReceiptSha256) fail('recovery permit binding differs')
  const stage = await canonicalDirectory(stagedHome)
  const original = await canonicalDirectory(originalPhysicalHome)
  const archive = await canonicalDirectory(permit.archiveRoot, true)
  const overlaps = (left, right) => left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)
  for (const protectedRoot of [stage, original, manifest.transactionPath, preparation.preparationRoot,
    preparation.candidateHome, sourceProof.installer?.root, manifest.hostMigration.plan.candidateRuntime.root]) {
    if (typeof protectedRoot !== 'string' || overlaps(archive, protectedRoot)) fail('recovery archive overlaps protected root')
  }
  if (stage !== homePath || stage === original || stage.startsWith(`${original}${sep}`)
    || original.startsWith(`${stage}${sep}`)) fail('recovery Home locations differ')
  for (const root of [stage, original]) {
    await canonicalDirectory(join(root, 'profiles'))
    await canonicalDirectory(join(root, 'profiles', permit.profile))
    await canonicalDirectory(join(root, 'rsi-authorities'))
    await canonicalDirectory(join(root, 'rsi-authorities', permit.profile))
  }
  await canonicalDirectory(preparation.preparationRoot, true)
  await canonicalDirectory(join(preparation.preparationRoot, permit.profile), true)
  await canonicalDirectory(preparation.candidateHome, true)
  for (const root of [stage, original, preparation.candidateHome]) {
    if (await privateFile(join(root, 'cordis.patch.yml'), 1_048_576, true) !== null) {
      fail('Home-level patch is outside native recovery scope')
    }
  }
  const hostRoot = await canonicalDirectory(manifest.hostMigration.plan.candidateRuntime.root, true)
  await canonicalDirectory(join(hostRoot, 'node_modules'))
  await canonicalDirectory(join(hostRoot, 'node_modules', '@deepseek-ai'))
  await canonicalDirectory(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-settings'))
  await canonicalDirectory(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib'))
  if (sha256(await privateFile(join(hostRoot, 'receipt.json'), 8_388_608)) !== replayReceipt.hostReceiptSha256
    || sha256(await privateFile(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-settings', 'lib', 'index.js'),
      1_048_576, false, false))
      !== replayReceipt.settingsModuleSha256) fail('native replay Host bytes differ')
  const bootstrapPath = join(original, 'rsi-authorities', permit.profile, 'bootstrap.json')
  const originalBootstrap = await privateFile(bootstrapPath)
  const candidateBootstrap = await privateFile(join(stage, 'rsi-authorities', permit.profile, 'bootstrap.json'))
  if (sha256(originalBootstrap) !== sourceProof?.original?.ownerInventory?.authorityBootstrap
    || sha256(candidateBootstrap) !== sha256(originalBootstrap)) fail('Host authority bootstrap changed')
  const bootstrap = JSON.parse(originalBootstrap.toString('utf8'))
  const identity = bootstrap?.resources?.identities?.host
  if (typeof identity?.publicKeyPem !== 'string' || permit.authority !== identity.authority
    || permit.keyId !== identity.keyId || !/^[A-Za-z0-9_-]{86}$/u.test(String(permit.signature))) {
    fail('Host authority identity differs')
  }
  const publicKey = createPublicKey(identity.publicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null,
    hostLegacySettingsPermitSigningPayload(Object.fromEntries(permitFields.map(field => [field, permit[field]]))),
    publicKey, Buffer.from(permit.signature, 'base64url'))) fail('Host recovery permit signature differs')
  const settings = await privateFile(join(original, 'settings.yaml'))
  const previousImported = await privateFile(join(original, 'settings.yaml.imported'), 1_048_576, true)
  if (sha256(settings) !== permit.originalSettingsSha256
    || (previousImported === null ? null : sha256(previousImported)) !== permit.previousImportedSha256
    || await privateFile(join(stage, 'settings.yaml'), 1_048_576, true) !== null
    || sha256(await privateFile(join(stage, 'settings.yaml.imported'))) !== permit.originalSettingsSha256) {
    fail('legacy settings import marker differs')
  }
  const yaml = createRequire(preparation.candidateDshPath)('yaml')
  const parsedSettings = strictYaml(yaml, settings.toString('utf8'), 'legacy settings')
  if (parsedSettings === null || typeof parsedSettings !== 'object' || Array.isArray(parsedSettings)) fail('legacy settings shape differs')
  assertAudit(permit.sectionAudit, parsedSettings)
  const expected = preparation.profiles?.find(profile => profile.name === permit.profile)
  if (!expected || expected.backupOf !== undefined) fail('recovery profile differs')
  const prepared = await privateFile(join(preparation.preparationRoot, permit.profile, 'cordis.patch.yml'))
  const originalPatch = await privateFile(join(original, 'profiles', permit.profile, 'cordis.patch.yml'))
  const imported = await privateFile(join(stage, 'profiles', permit.profile, 'cordis.patch.yml'))
  if (sha256(prepared) !== permit.originalPatchSha256 || sha256(originalPatch) !== permit.originalPatchSha256
    || expected.preparedDigests?.['cordis.patch.yml'] !== permit.originalPatchSha256
    || expected.originalDigests?.['cordis.patch.yml'] !== permit.originalPatchSha256
    || sha256(imported) !== permit.importedPatchSha256
    || !imported.subarray(0, prepared.length).equals(prepared) || imported.length <= prepared.length) {
    fail('imported profile patch differs')
  }
  const archiveNames = ['original-settings.yaml', 'original-patch.yml', 'imported-patch.yml',
    'replay-method.mjs', 'replay-receipt.json', 'replay-observation.json', 'permit.json',
    ...(previousImported === null ? [] : ['previous-imported.yaml'])]
  const present = await readdir(archive)
  if (present.some(name => !archiveNames.includes(name))
    || archiveNames.some(name => !present.includes(name))) fail('recovery archive inventory differs')
  for (const [name, contents] of [['original-settings.yaml', settings], ['original-patch.yml', prepared],
    ['imported-patch.yml', imported], ...(previousImported === null ? [] : [['previous-imported.yaml', previousImported]])]) {
    if (!(await privateFile(join(archive, name))).equals(contents)) fail('recovery archive bytes differ')
  }
  if (sha256(await privateFile(join(archive, 'replay-method.mjs'))) !== replayReceipt.methodSha256) {
    fail('archived replay method differs')
  }
  const archivedReceipt = await privateFile(join(archive, 'replay-receipt.json'))
  if (sha256(archivedReceipt) !== permit.replayReceiptFileSha256
    || !isDeepStrictEqual(JSON.parse(archivedReceipt.toString('utf8')), replayReceipt)) {
    fail('archived replay receipt differs')
  }
  const rawReplayBytes = await privateFile(join(archive, 'replay-observation.json'))
  if (sha256(rawReplayBytes) !== permit.rawReplaySha256) fail('raw replay observation bytes differ')
  const observation = JSON.parse(rawReplayBytes.toString('utf8'))
  if (!exactKeys(observation, ['protocol', 'root', 'home', 'candidateVersion', 'original', 'overlay',
    'ready', 'nativeImportComplete', 'sectionResults', 'finalPatchSha256', 'importedMarkerSha256',
    'originalSettingsRemoved', 'termination'])
    || observation.protocol !== 'dsh-enhanced/native-settings-replay/v1'
    || observation.candidateVersion !== permit.candidateHostVersion
    || typeof observation.root !== 'string' || !isAbsolute(observation.root)
    || resolve(observation.root) !== observation.root
    || [stage, original, archive, manifest.transactionPath].some(protectedRoot => overlaps(observation.root, protectedRoot))
    || observation.home !== homePath
    || !exactKeys(observation.original, ['hostReceiptSha256', 'canonicalSettingsModule',
      'settingsModuleSha256', 'originalPatchSha256', 'originalSettingsSha256', 'originalImportedMarkerSha256'])
    || observation.original.hostReceiptSha256 !== replayReceipt.hostReceiptSha256
    || observation.original.canonicalSettingsModule !== join(hostRoot, 'node_modules', '@deepseek-ai',
      'dsh-settings', 'lib', 'index.js')
    || observation.original.settingsModuleSha256 !== replayReceipt.settingsModuleSha256
    || observation.original.originalPatchSha256 !== permit.originalPatchSha256
    || observation.original.originalSettingsSha256 !== permit.originalSettingsSha256
    || observation.original.originalImportedMarkerSha256 !== permit.previousImportedSha256
    || !isDeepStrictEqual(observation.overlay, { larkDisabled: true,
      deliverySchedulerDisabled: true, automationsSchedulerDisabled: true })
    || observation.ready !== true || observation.nativeImportComplete !== true
    || observation.finalPatchSha256 !== permit.importedPatchSha256
    || observation.importedMarkerSha256 !== permit.originalSettingsSha256
    || observation.originalSettingsRemoved !== true
    || !isDeepStrictEqual(observation.termination, { code: null, signal: 'SIGTERM' })
    || !Array.isArray(observation.sectionResults)
    || observation.sectionResults.length !== permit.sectionAudit.length
    || observation.sectionResults.some((item, index) => {
      const expectedSection = permit.sectionAudit[index]
      return expectedSection.result === 'appended'
        ? !exactKeys(item, ['section', 'status']) || item.section !== expectedSection.entry || item.status !== 'accepted'
        : !exactKeys(item, ['section', 'status', 'category']) || item.section !== expectedSection.entry
          || item.status !== 'rejected' || item.category !== 'unsupported-entry'
    })) fail('raw replay observation differs')
  const archivedPermit = JSON.parse((await privateFile(join(archive, 'permit.json'))).toString('utf8'))
  if (!isDeepStrictEqual(archivedPermit, { permit, replayReceipt })) fail('archived recovery permit differs')
  const baseRows = strictYaml(yaml, prepared.toString('utf8'), 'prepared profile patch')
  const importedRows = strictYaml(yaml, imported.toString('utf8'), 'imported profile patch')
  if (!Array.isArray(baseRows) || !Array.isArray(importedRows) || importedRows.length !== baseRows.length + 3
    || !isDeepStrictEqual(importedRows.slice(0, baseRows.length), baseRows)) fail('imported patch rows differ')
  for (const [index, section] of ['permission', 'agent-default-model', 'llm-pi-ai'].entries()) {
    const row = importedRows[baseRows.length + index]
    if (!exactKeys(row, ['id', 'name', 'config']) || row.id !== section || row.name !== appendedNames[section]
      || row.config === null || typeof row.config !== 'object' || Array.isArray(row.config)) {
      fail('imported patch row is not an approved legacy entry')
    }
  }
  return prepared.toString('utf8')
}
