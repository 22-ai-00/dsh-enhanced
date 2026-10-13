import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { assertLocalSourceInstaller, bindLocalSourceInstaller } from './local-source-maintenance.mjs'

const protocol = 'dsh-enhanced/pre-owner-creation-build-migration/v1'
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const commitPattern = /^[a-f0-9]{40}$/u
const hashPattern = /^[a-f0-9]{64}$/u
const imagePattern = /^sha256:[a-f0-9]{64}$/u
const archivePattern = /^\.dsh-rsi-creation-build-migration-[A-Za-z0-9_-]{8,80}$/u
const receiptFields = ['schemaVersion', 'sourceCommit', 'sourceImage', 'image', 'dockerPath', 'dshHome',
  'profile', 'dockerSha256', 'inputHashes', 'contextFiles', 'contextDigest', 'lockSha256', 'receiptDigest']
const journalFields = ['protocol', 'homePath', 'profile', 'archiveRoot', 'archiveIdentity', 'installer',
  'sourceCommit', 'sourceChainTip', 'sourceDigest', 'buildDigest', 'oldReceiptSha256', 'oldReceiptDigest',
  'oldSourceCommit', 'oldSourceImage', 'oldImage', 'oldDirectoryIdentity', 'oldFileIdentity', 'state',
  'creationBuild', 'journalDigest']

const fail = message => { throw new Error(`pre-owner creation build migration: ${message}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const exactKeys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
const digest = value => sha256(canonical(value))
const exactPath = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !path.includes('\0')
const overlaps = (left, right) => left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)
const identity = item => ({ dev: String(item.dev), ino: String(item.ino) })

async function optional(path) {
  try { return await lstat(path) } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

async function privateDirectory(path) {
  if (!exactPath(path) || await realpath(path) !== path) fail(`directory is not canonical: ${path}`)
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== process.getuid()
    || item.mode & 0o077) fail(`unsafe private directory: ${path}`)
  return item
}

async function trustedParent(path) {
  if (!exactPath(path) || await realpath(path) !== path) fail(`archive parent is not canonical: ${path}`)
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== process.getuid()
    || item.mode & 0o022) fail(`unsafe archive parent: ${path}`)
  return item
}

async function stableFile(path, maximum = 65_536) {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await descriptor.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid()
      || before.mode & 0o077 || before.size < 1 || before.size > maximum) fail(`unsafe private file: ${path}`)
    const bytes = await descriptor.readFile()
    const after = await descriptor.stat(), name = await lstat(path)
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || name.dev !== before.dev || name.ino !== before.ino || name.isSymbolicLink()) fail(`file changed: ${path}`)
    return { bytes, identity: identity(before) }
  } finally { await descriptor.close() }
}

async function syncDirectory(path) {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await descriptor.sync() } finally { await descriptor.close() }
}

async function writeExclusive(path, bytes) {
  const descriptor = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await descriptor.writeFile(bytes); await descriptor.sync() } finally { await descriptor.close() }
}

async function writeJournal(root, journal) {
  const { journalDigest: _digest, ...content } = journal
  const bytes = JSON.stringify({ ...content, journalDigest: digest(content) })
  const temporary = join(root, `.journal-${process.pid}-${Date.now()}-${sha256(bytes).slice(0, 12)}.tmp`)
  await writeExclusive(temporary, bytes)
  await rename(temporary, join(root, 'journal.json'))
  await syncDirectory(root)
}

function inspectLegacyReceipt(bytes, homePath, profile, source) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('legacy receipt is not JSON') }
  if (!exactKeys(value, receiptFields)) fail('legacy receipt fields differ')
  const { receiptDigest, ...content } = value
  if (value.schemaVersion !== 1 || value.dshHome !== homePath || value.profile !== profile
    || !hashPattern.test(receiptDigest) || sha256(JSON.stringify(content)) !== receiptDigest
    || !commitPattern.test(value.sourceCommit) || !imagePattern.test(value.sourceImage)
    || !imagePattern.test(value.image) || !exactPath(value.dockerPath)
    || !hashPattern.test(value.dockerSha256) || !hashPattern.test(value.contextDigest)
    || !hashPattern.test(value.lockSha256) || !value.inputHashes || typeof value.inputHashes !== 'object'
    || Array.isArray(value.inputHashes) || Object.keys(value.inputHashes).length < 1
    || Object.keys(value.inputHashes).length > 256
    || Object.values(value.inputHashes).some(item => typeof item !== 'string' || !hashPattern.test(item))
    || !Array.isArray(value.contextFiles) || value.contextFiles.length < 1 || value.contextFiles.length > 256
    || value.contextFiles.some(item => typeof item !== 'string' || !item || item.includes('\0'))
    || value.sourceCommit === source.workspace.sourceCommit) fail('legacy receipt differs from an older valid creation build')
  const history = new Set([source.anchor.baseline.initialCommit])
  for (const record of source.records) {
    history.add(record.previousTip)
    history.add(record.before.sourceCommit)
    history.add(record.candidateTip)
  }
  if (!history.has(value.sourceCommit)) fail('legacy source commit is absent from signed history')
  return value
}

function ancestor(repository, earlier, later) {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'protocol.allow=never', '-c', 'gc.auto=0', '-C', repository, 'merge-base', '--is-ancestor', earlier, later], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
  })
  if (result.error || result.status !== 0 || result.signal || result.stdout || result.stderr) {
    fail('legacy commit is not a strict ancestor of the signed source tip')
  }
}

export function moveDirectoryNoReplace(source, destination, expected, sourceParent, destinationParent) {
  const helper = [
    'import ctypes, os, stat, sys',
    'source, destination, expected_dev, expected_ino, source_dev, source_ino, destination_dev, destination_ino, expected_uid = sys.argv[1:]',
    'source_parent, source_name = os.path.split(source)',
    'destination_parent, destination_name = os.path.split(destination)',
    'source_fd = os.open(source_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'destination_fd = os.open(destination_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'try:',
    '  before_source = os.fstat(source_fd)',
    '  before_destination = os.fstat(destination_fd)',
    '  if (before_source.st_dev, before_source.st_ino, before_source.st_uid) != (int(source_dev), int(source_ino), int(expected_uid)): raise RuntimeError("source parent changed")',
    '  if (before_destination.st_dev, before_destination.st_ino, before_destination.st_uid) != (int(destination_dev), int(destination_ino), int(expected_uid)): raise RuntimeError("destination parent changed")',
    '  entry = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)',
    '  if not stat.S_ISDIR(entry.st_mode) or (entry.st_dev, entry.st_ino, entry.st_uid) != (int(expected_dev), int(expected_ino), int(expected_uid)): raise RuntimeError("source identity changed")',
    '  libc = ctypes.CDLL(None, use_errno=True)',
    '  renameat2 = getattr(libc, "renameat2", None)',
    '  if renameat2 is None: raise RuntimeError("renameat2 unavailable")',
    '  if renameat2(source_fd, source_name.encode(), destination_fd, destination_name.encode(), 1) != 0: raise RuntimeError("renameat2 noreplace errno=%d" % ctypes.get_errno())',
    '  moved = os.stat(destination_name, dir_fd=destination_fd, follow_symlinks=False)',
    '  if (moved.st_dev, moved.st_ino, moved.st_uid) != (int(expected_dev), int(expected_ino), int(expected_uid)): raise RuntimeError("destination identity changed")',
    '  os.fsync(destination_fd)',
    '  os.fsync(source_fd)',
    'finally:',
    '  os.close(source_fd)',
    '  os.close(destination_fd)',
  ].join('\n')
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', helper, source, destination,
    expected.dev, expected.ino, sourceParent.dev, sourceParent.ino, destinationParent.dev,
    destinationParent.ino, String(process.getuid())], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  })
  if (result.error || result.status !== 0 || result.signal || result.stdout || result.stderr) {
    fail('cannot move legacy directory without replacement')
  }
}

async function loadReviewedApi(binding) {
  const root = join(binding.root, 'plugins', 'lark-channel', 'lib')
  const modules = await Promise.all(['setup', 'rsi-creation-build', 'rsi-build', 'rsi-source',
    'rsi-source-maintenance', 'rsi-local-activation'].map(name => import(pathToFileURL(join(root, `${name}.js`)).href)))
  const [setup, creation, build, workspace, maintenance, activation] = modules
  const api = {
    withDshHomeLifecycleLock: setup.withDshHomeLifecycleLock,
    prepareRsiCreationBuildEnvironment: creation.prepareRsiCreationBuildEnvironment,
    readRsiCreationBuildEnvironment: creation.readRsiCreationBuildEnvironment,
    readRsiBuildEnvironment: build.readRsiBuildEnvironment,
    readRsiSourceWorkspace: workspace.readRsiSourceWorkspace,
    readRsiSourceMaintenance: maintenance.readRsiSourceMaintenance,
    assertRsiPreOwnerInstallation: activation.assertRsiPreOwnerInstallation,
  }
  if (Object.values(api).some(value => typeof value !== 'function')) fail('reviewed installer API is incomplete')
  return api
}

async function liveState(api, homePath, profile) {
  const preOwner = await api.assertRsiPreOwnerInstallation({ logicalHome: homePath, physicalHome: homePath,
    profile, preparedCoordinator: true })
  if (preOwner.mode !== 'pre-owner' || !preOwner.preparedCoordinator) fail('prepared pre-owner identity is absent')
  const source = await api.readRsiSourceMaintenance({ logicalHome: homePath, physicalHome: homePath, profile })
  const workspace = await api.readRsiSourceWorkspace({ dshHome: homePath, profile })
  if (!isDeepStrictEqual(source.workspace, workspace) || !isDeepStrictEqual(source.anchor, preOwner.anchor)
    || !isDeepStrictEqual(source.records, preOwner.records)
    || source.workspace.sourceCommit !== preOwner.workspace.sourceCommit
    || workspace.origin?.kind !== 'local-head' || !exactPath(workspace.origin.locator)) fail('signed source state changed')
  const build = await api.readRsiBuildEnvironment({ dshHome: homePath, profile, source: workspace })
  if (build.sourceCommit !== workspace.sourceCommit || build.schemaVersion !== 1) fail('approved source build differs')
  const authority = join(homePath, 'rsi-authorities', profile)
  for (const name of ['config', 'registry']) {
    await privateDirectory(join(authority, name))
    if ((await readdir(join(authority, name))).length) fail(`owner ${name} is not empty`)
  }
  const state = join(authority, 'state')
  await privateDirectory(state)
  if (!isDeepStrictEqual((await readdir(state)).sort(), ['creation-adoption-runner', 'creation-review-runner'])) {
    fail('owner state inventory differs')
  }
  for (const name of ['creation-adoption-runner', 'creation-review-runner']) {
    await privateDirectory(join(state, name))
    if ((await readdir(join(state, name))).length) fail('known runner state is not empty')
  }
  return { source, workspace, build, preOwner }
}

async function legacyAt(path, homePath, profile, source) {
  const directory = await privateDirectory(path)
  if (!isDeepStrictEqual(await readdir(path), ['bootstrap.json'])) fail('legacy creation directory contains unknown state')
  const file = await stableFile(join(path, 'bootstrap.json'))
  const receipt = inspectLegacyReceipt(file.bytes, homePath, profile, source)
  return { receipt, bytes: file.bytes, directoryIdentity: identity(directory), fileIdentity: file.identity }
}

function journalBase(input, binding, live, old, archiveIdentity) {
  return {
    protocol, homePath: input.homePath, profile: input.profile, archiveRoot: input.archiveRoot,
    archiveIdentity, installer: binding, sourceCommit: live.workspace.sourceCommit,
    sourceChainTip: live.preOwner.sourceChainTip, sourceDigest: digest(live.source),
    buildDigest: digest(live.build), oldReceiptSha256: sha256(old.bytes),
    oldReceiptDigest: old.receipt.receiptDigest, oldSourceCommit: old.receipt.sourceCommit,
    oldSourceImage: old.receipt.sourceImage, oldImage: old.receipt.image,
    oldDirectoryIdentity: old.directoryIdentity, oldFileIdentity: old.fileIdentity,
  }
}

async function readJournal(root, expected) {
  const files = (await readdir(root)).sort()
  if (!isDeepStrictEqual(files, ['journal.json'])
    && !isDeepStrictEqual(files, ['journal.json', 'legacy'])) fail('archive contains unknown state')
  const value = JSON.parse((await stableFile(join(root, 'journal.json'))).bytes.toString('utf8'))
  if (!exactKeys(value, journalFields)) fail('journal fields differ')
  const { journalDigest, state, creationBuild, ...base } = value
  if (!hashPattern.test(journalDigest) || digest({ ...base, state, creationBuild }) !== journalDigest
    || !isDeepStrictEqual(base, expected)
    || !['archived', 'completed'].includes(state)
    || state === 'archived' && creationBuild !== null
    || state === 'completed' && (!creationBuild || creationBuild.schemaVersion !== 1)) fail('journal binding differs')
  return value
}

async function migrateLocked(input, dependencies, binding, api) {
  await dependencies.assertInstaller(binding)
  await privateDirectory(input.homePath)
  const live = await liveState(api, input.homePath, input.profile)
  if (overlaps(input.archiveRoot, live.workspace.repository)
    || overlaps(input.archiveRoot, live.workspace.origin.locator)
    || overlaps(input.archiveRoot, dirname(live.build.sourceBuild.dockerPath))) fail('archive overlaps build or source input')
  const parent = join(input.homePath, 'rsi-creation-builds'), original = join(parent, input.profile)
  const parentIdentity = identity(await privateDirectory(parent))
  let archive = await optional(input.archiveRoot)
  if (!archive) {
    if (!isDeepStrictEqual(await readdir(parent), [input.profile])) fail('creation build inventory differs')
    const old = await legacyAt(original, input.homePath, input.profile, live.source)
    dependencies.ancestor(live.workspace.repository, old.receipt.sourceCommit, live.workspace.sourceCommit)
    const parentItem = await trustedParent(dirname(input.archiveRoot))
    if (parentItem.dev !== (await lstat(parent)).dev) fail('archive must share the Home filesystem')
    await mkdir(input.archiveRoot, { mode: 0o700 })
    await syncDirectory(dirname(input.archiveRoot))
    archive = await privateDirectory(input.archiveRoot)
    const base = journalBase(input, binding, live, old, identity(archive))
    await writeJournal(input.archiveRoot, { ...base, state: 'archived', creationBuild: null })
  }
  await privateDirectory(input.archiveRoot)
  const archived = join(input.archiveRoot, 'legacy')
  const archivedEntry = await optional(archived), originalEntry = await optional(original)
  if (!originalEntry && !archivedEntry) fail('legacy directory has an ambiguous archive state')
  const old = await legacyAt(archivedEntry ? archived : original, input.homePath, input.profile, live.source)
  dependencies.ancestor(live.workspace.repository, old.receipt.sourceCommit, live.workspace.sourceCommit)
  const expected = journalBase(input, binding, live, old, identity(archive))
  const journal = await readJournal(input.archiveRoot, expected)
  if (originalEntry && !archivedEntry) {
    if (journal.state === 'completed') fail('completed migration still has the legacy directory')
    if (!isDeepStrictEqual(await readdir(parent), [input.profile])) fail('creation build inventory differs')
    await dependencies.assertInstaller(binding)
    if (!isDeepStrictEqual(await liveState(api, input.homePath, input.profile), live)) fail('pre-owner state changed before archive')
    dependencies.moveDirectory(original, archived, old.directoryIdentity, parentIdentity, identity(archive))
    await syncDirectory(parent)
    await syncDirectory(input.archiveRoot)
    const moved = await legacyAt(archived, input.homePath, input.profile, live.source)
    if (!moved.bytes.equals(old.bytes) || !isDeepStrictEqual(moved.directoryIdentity, old.directoryIdentity)
      || !isDeepStrictEqual(moved.fileIdentity, old.fileIdentity)) fail('legacy archive changed during move')
  }
  await legacyAt(archived, input.homePath, input.profile, live.source)
  await dependencies.assertInstaller(binding)
  const existing = await optional(original)
  if (journal.state === 'completed' && !existing) fail('completed native creation receipt is missing')
  if (!isDeepStrictEqual((await readdir(parent)).sort(), existing ? [input.profile] : [])) {
    fail('creation build parent contains unknown state')
  }
  let result
  const args = { dshHome: input.homePath, profile: input.profile, source: live.workspace, build: live.build }
  if (existing) {
    result = await api.readRsiCreationBuildEnvironment(args)
    const replay = await api.prepareRsiCreationBuildEnvironment(args)
    if (!isDeepStrictEqual(result, replay)) fail('native creation image replay differs')
  }
  else {
    if ((await readdir(parent)).length) fail('unknown creation build state after archive')
    result = await api.prepareRsiCreationBuildEnvironment(args)
  }
  const readback = await api.readRsiCreationBuildEnvironment(args)
  if (!isDeepStrictEqual(result, readback)
    || !exactKeys(result, ['schemaVersion', 'sourceCommit', 'sourceImage', 'image', 'dockerPath'])
    || result.schemaVersion !== 1
    || result.sourceCommit !== live.workspace.sourceCommit
    || result.sourceImage !== live.build.sourceBuild.image
    || result.dockerPath !== live.build.sourceBuild.dockerPath
    || !imagePattern.test(result.image)) fail('native creation build readback differs')
  if (journal.state === 'completed' && !isDeepStrictEqual(journal.creationBuild, result)) fail('completed creation build changed')
  await dependencies.assertInstaller(binding)
  if (!isDeepStrictEqual(await liveState(api, input.homePath, input.profile), live)) fail('pre-owner state changed after build')
  if (journal.state === 'archived') await writeJournal(input.archiveRoot, { ...expected, state: 'completed', creationBuild: result })
  return { archiveRoot: input.archiveRoot, previous: {
    sourceCommit: old.receipt.sourceCommit, sourceImage: old.receipt.sourceImage, image: old.receipt.image,
    receiptSha256: sha256(old.bytes), receiptDigest: old.receipt.receiptDigest,
  }, creationBuild: result }
}

export async function migratePreOwnerCreationBuild(input, seams = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('Linux x64 is required')
  if (!profilePattern.test(input?.profile) || !exactPath(input?.homePath)
    || !exactPath(input?.archiveRoot) || !exactPath(input?.installerRoot)
    || dirname(input.archiveRoot) !== dirname(input.homePath)
    || !archivePattern.test(basename(input.archiveRoot))
    || overlaps(input.archiveRoot, input.homePath) || overlaps(input.archiveRoot, input.installerRoot)) {
    fail('invalid migration paths or profile')
  }
  await privateDirectory(input.homePath)
  await trustedParent(dirname(input.archiveRoot))
  const dependencies = {
    bindInstaller: seams.bindInstaller ?? bindLocalSourceInstaller,
    assertInstaller: seams.assertInstaller ?? assertLocalSourceInstaller,
    loadApi: seams.loadApi ?? loadReviewedApi,
    ancestor: seams.ancestor ?? ancestor,
    moveDirectory: seams.moveDirectory ?? moveDirectoryNoReplace,
  }
  const binding = await dependencies.bindInstaller(input.installerRoot)
  await dependencies.assertInstaller(binding)
  const api = await dependencies.loadApi(binding)
  return api.withDshHomeLifecycleLock(input.homePath, () => migrateLocked(input, dependencies, binding, api))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6) {
    process.stderr.write('usage: node creation-build-migration.mjs <profile> <canonical-home> <sibling-archive-root> <reviewed-installer-root>\n')
    process.exitCode = 2
  } else {
    migratePreOwnerCreationBuild({ profile: process.argv[2], homePath: process.argv[3],
      archiveRoot: process.argv[4], installerRoot: process.argv[5] }).then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }, error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'creation build migration failed'}\n`)
      process.exitCode = 1
    })
  }
}
