#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyLifecycleScenario } from './lifecycle-config.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const VALIDATOR_PATH = join(dirname(SCRIPT_PATH), 'lifecycle-config.mjs')
const SANDBOX_VALIDATOR_PATH = '/run/dsh-enhanced-lifecycle-config.mjs'
const MANIFEST_VERSION = 1
const SERVICE_MANIFEST_VERSION = 2
const SUPERVISED_SERVICE_MANIFEST_VERSION = 3
const TRANSACTION_SUFFIX = '.dsh-enhanced-transaction'
const READY_MARKER = 'dsh web: http://127.0.0.1:'
const LARK_STATE_PREFIX = 'lark-channel: '
const LARK_ACCEPTED_STATES = new Set(['connected', 'connected-with-gap'])
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MANAGED_PACKAGE = /^@dsh-enhanced\/[a-z0-9-]+$/u
const SEMVER_PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const SEMVER_SOURCE = `(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`
const MANAGED_EXACT_SPEC = new RegExp(`^(@dsh-enhanced/[a-z0-9-]+)@(${SEMVER_SOURCE})$`, 'u')
const EXACT_SEMVER = new RegExp(`^${SEMVER_SOURCE}$`, 'u')
const NARROW_DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/u
const NPM_COHORT_ANCHOR = '@dsh-enhanced/personal-assistant'
const ANCESTOR_CHAIN_ENV = 'DSH_ENHANCED_LIFECYCLE_ANCESTORS'
const LOCK_PARENT_FD_PATH = '/proc/self/fd/3'
const ALLOWED_WEB_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
const SYSTEMD_UNIT = /^dsh-profile-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.service$/u
const SYSTEMD_OWNERSHIP_PROPERTIES = ['Id', 'LoadState', 'WorkingDirectory', 'Environment']
const SYSTEMD_SHOW_PROPERTIES = [
  'Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'ActiveState', 'SubState', 'MainPID',
  'ControlPID', 'InvocationID', 'NRestarts', 'UnitFileState', 'WorkingDirectory', 'Environment', 'ExecStart',
]
const KEYRING_DROP_IN = '[Unit]\nRequires=gnome-keyring-daemon.service\nAfter=gnome-keyring-daemon.service\n'
const SERVICE_PHASES = new Set(['initializing', 'stopping', 'stopped', 'swapped', 'starting', 'service-accepted', 'service-failed'])
const LIFECYCLE_SCENARIOS = new Set(['web', 'autonomy', 'lark', 'supervised'])
const SUPERVISED_UPGRADE_PHASES = new Set([
  'source-pending', 'source-attested', 'preview-prepared', 'preview-running',
  'preview-accepted', 'active-prepared', 'post-swap-pending', 'post-swap-accepted',
])
const SUPERVISED_UNINSTALL_PHASES = new Set([
  'source-pending', 'source-attested', 'clean-target-validated', 'clean-target-pending', 'clean-target-accepted',
])
const SUPERVISED_UPGRADE_PROTOCOL = 'dsh-enhanced/supervised-lifecycle/v1'
const SUPERVISED_UNINSTALL_PROTOCOL = 'dsh-enhanced/supervised-uninstall/v1'
const SERVICE_CLEANUP_PROTOCOL = 'dsh-enhanced/service-cleanup/v1'
const SUPERVISED_POLL_INTERVAL_MS = 100
const SUPERVISED_OPERATOR_PROGRAM = String.raw`
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
const [action, home, profile, dsh, nonce = ''] = process.argv.slice(1)
const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
const jsonDigest = value => digest(canonical(value))
const require = createRequire(join(home, 'profiles', profile, 'package.json'))
const load = async name => import(require.resolve(name))
const [lark, delivery, recovery, automations] = await Promise.all([
  load('@dsh-enhanced/lark-channel'), load('@dsh-enhanced/assistant-delivery'),
  load('@dsh-enhanced/assistant-recovery'), load('@dsh-enhanced/assistant-automations'),
])
const dump = (runtimeOverlay = false) => {
  const overlay = process.env.DSH_ENHANCED_SUPERVISED_PREVIEW_OVERLAY
  const result = spawnSync(dsh, ['--profile', profile,
    ...(runtimeOverlay && overlay ? ['--patch', overlay] : []), '--dump-config'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, DSH_HOME: home },
  })
  if (result.status !== 0) throw new Error('DSH rejected supervised lifecycle config: ' + String(result.stderr ?? '').trim().slice(0, 2000))
  return String(result.stdout ?? '')
}
const previewOverlayPath = () => {
  const overlayPath = process.env.DSH_ENHANCED_SUPERVISED_PREVIEW_OVERLAY
  if (typeof overlayPath !== 'string'
    || !isAbsolute(overlayPath) || (overlayPath !== home && !overlayPath.startsWith(home + sep))) {
    throw new Error('supervised preview requires a runtime overlay path inside DSH_HOME')
  }
  return overlayPath
}
// Preview isolation overlay is ALWAYS derived from the current persisted,
// Lark-enabled baseline — never a static template — so every extra Health
// provider the user declared survives. Prepare stages the dotfile (exclusive
// create) right after the persisted supervised patch is asserted; attestation
// independently re-derives from the same baseline and requires the staged file
// to be byte-identical, which makes a tampered/stale overlay and any baseline
// drift both fail closed.
const resolveStageConfig = async (persisted, stage) => {
  if (stage !== 'preview') return { effectiveConfig: persisted }
  const overlayPath = previewOverlayPath()
  const derived = lark.buildSupervisedGrowthPreviewOverlay(persisted)
  if (typeof derived !== 'string' || derived.trim() === '') {
    throw new Error('supervised preview overlay derivation produced an empty patch')
  }
  if (action === 'prepare-preview') {
    await writeFile(overlayPath, derived, { mode: 0o600, flag: 'wx' })
    if (await readFile(overlayPath, 'utf8') !== derived) {
      throw new Error('supervised preview runtime overlay could not be staged intact')
    }
  } else if (await readFile(overlayPath, 'utf8') !== derived) {
    throw new Error('supervised preview runtime overlay is not derived from the current persisted baseline')
  }
  const effectiveConfig = dump(true)
  // Fail-closed whitelist proof: composing with the derived overlay may only
  // disable Lark and remove larkChannel from Health required providers.
  lark.assertSupervisedGrowthPreviewDerivation({ persistedConfig: persisted, previewConfig: effectiveConfig })
  return { effectiveConfig, overlayDigest: digest(derived) }
}
const relativeDatabasePath = path => {
  if (!isAbsolute(path) || !(path === home || path.startsWith(home + sep))) throw new Error('supervised database path escapes DSH_HOME')
  const value = relative(home, path)
  if (value === '' || value.split(/[\\/]/u).includes('..')) throw new Error('invalid supervised database path')
  return value
}
const observe = async effectiveConfig => {
  const paths = lark.supervisedGrowthDatabasePaths(effectiveConfig, home)
  const query = lark.supervisedGrowthBindingQuery(effectiveConfig, home)
  const deliveryProof = delivery.inspectActiveLarkOwnerBindingsLocally({ databasePath: paths.deliveryDatabasePath, ...query })
  if (deliveryProof.bindings.length !== 1) throw new Error('supervised lifecycle requires exactly one active owner Lark DM binding')
  const recoveryProof = recovery.inspectRecoveryOperatorSnapshot(paths.recoveryDatabasePath)
  const automationsProof = automations.inspectAutomationsOperatorSnapshot(paths.automationsDatabasePath)
  const semantic = {
    delivery: { scope: deliveryProof.scope, storageDigest: deliveryProof.storageDigest, bindings: deliveryProof.bindings },
    recovery: recoveryProof.bootstrap,
    automations: { inFlightCount: automationsProof.inFlightCount, inventoryDigest: automationsProof.inventoryDigest, records: automationsProof.records },
  }
  return { effectiveConfig, paths, deliveryProof, recoveryProof, automationsProof, binding: deliveryProof.bindings[0], semanticDigest: jsonDigest(semantic) }
}
const attest = async (effectiveConfig, stage) => {
  const paths = lark.supervisedGrowthDatabasePaths(effectiveConfig, home)
  return await lark.captureSupervisedGrowthLifecycleAttestation({
    profile, stage, externalProviderExemptions: stage === 'preview' ? ['larkChannel'] : [],
    effectiveConfig, recoveryDatabasePath: paths.recoveryDatabasePath,
    automationsDatabasePath: paths.automationsDatabasePath,
  })
}
const plan = async (stage, effectiveConfig, patchSource, ownerBindingDigest, overlayDigest) => {
  const paths = lark.supervisedGrowthDatabasePaths(effectiveConfig, home)
  const expected = await lark.expectedSupervisedGrowthRecoveryBootstrap(effectiveConfig, paths.recoveryDatabasePath)
  const managedProjection = await lark.expectedSupervisedGrowthManagedAutomationDigest({
    stage, effectiveConfig, recoveryDatabasePath: paths.recoveryDatabasePath,
  })
  if (stage === 'preview' && (typeof overlayDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(overlayDigest))) {
    throw new Error('supervised preview plan requires the derived runtime overlay digest')
  }
  return {
    patchDigest: digest(patchSource), effectiveConfigDigest: digest(effectiveConfig),
    attestationSetDigest: expected.attestationSetDigest,
    managedInventoryDigest: managedProjection.digest, ownerBindingDigest,
    externalProviderExemptions: stage === 'preview' ? ['larkChannel'] : [],
    // Active never carries a runtime overlay: omit the field entirely so the
    // manifest reader's exact previewPlan/activePlan shape check stays closed.
    ...(stage === 'preview' ? { runtimeOverlayDigest: overlayDigest } : {}),
  }
}
const writePatch = async source => {
  const path = join(home, 'profiles', profile, 'cordis.patch.yml')
  const temporary = path + '.supervised-lifecycle-' + process.pid + '-' + randomUUID()
  await writeFile(temporary, source, { mode: 0o600, flag: 'wx' }); await rename(temporary, path)
}
let output
if (action === 'snapshot' || action === 'attest-active' || action === 'attest-preview') {
  const persistedConfig = dump()
  const { effectiveConfig } = await resolveStageConfig(persistedConfig,
    action === 'attest-preview' ? 'preview' : 'active')
  const observed = await observe(effectiveConfig)
  const stage = action === 'attest-preview' ? 'preview' : 'active'
  const managedProjection = await lark.expectedSupervisedGrowthManagedAutomationDigest({
    stage, effectiveConfig, recoveryDatabasePath: observed.paths.recoveryDatabasePath,
  })
  output = {
    effectiveConfigDigest: digest(effectiveConfig), semanticDigest: observed.semanticDigest,
    databasePaths: Object.fromEntries(Object.entries(observed.paths).map(([key, value]) => [key.replace('DatabasePath', ''), relativeDatabasePath(value)])),
    delivery: observed.deliveryProof, recovery: observed.recoveryProof, automations: observed.automationsProof,
    managedProjection, ownerBindingDigest: jsonDigest(observed.binding),
    ...(action === 'snapshot' ? {} : { attestation: await attest(effectiveConfig, stage) }),
  }
} else if (action === 'prepare-preview' || action === 'prepare-active') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(nonce)) throw new Error('invalid fresh lifecycle nonce')
  const before = dump(); const observed = await observe(before)
  const stage = action === 'prepare-preview' ? 'preview' : 'active'
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml')
  const originalPatch = await readFile(patchPath, 'utf8')
  const patch = lark.configureSupervisedGrowthProfilePatch({
    profilePatch: originalPatch, effectiveConfig: before, dshHome: home, binding: observed.binding,
    activationState: stage, activationNonce: nonce, recoveryCatalogDigest: recovery.RECOVERY_CATALOG_DIGEST,
  })
  await writePatch(patch)
  const persistedEffectiveConfig = dump()
  lark.assertEffectiveSupervisedGrowthConfig({ effectiveConfig: persistedEffectiveConfig, dshHome: home, binding: observed.binding,
    activationState: stage, activationNonce: nonce, recoveryCatalogDigest: recovery.RECOVERY_CATALOG_DIGEST })
  const { effectiveConfig, overlayDigest } = await resolveStageConfig(persistedEffectiveConfig, stage)
  output = { catalogDigest: recovery.RECOVERY_CATALOG_DIGEST,
    plan: await plan(stage, effectiveConfig, patch, jsonDigest(observed.binding), overlayDigest) }
} else throw new Error('unknown supervised lifecycle action')
process.stdout.write(JSON.stringify(output))
`
const SUPERVISED_CAPABILITY_PROGRAM = String.raw`
import { createRequire } from 'node:module'
import { join } from 'node:path'
const [home, profile] = process.argv.slice(1)
const require = createRequire(join(home, 'profiles', profile, 'package.json'))
const load = async name => import(require.resolve(name))
const [lark, delivery, recovery, automations] = await Promise.all([
  load('@dsh-enhanced/lark-channel'), load('@dsh-enhanced/assistant-delivery'),
  load('@dsh-enhanced/assistant-recovery'), load('@dsh-enhanced/assistant-automations'),
])
const required = [
  [lark, 'captureSupervisedGrowthLifecycleAttestation'], [lark, 'configureSupervisedGrowthProfilePatch'],
  [lark, 'assertEffectiveSupervisedGrowthConfig'], [lark, 'expectedSupervisedGrowthRecoveryBootstrap'],
  [lark, 'expectedSupervisedGrowthManagedAutomationDigest'],
  [lark, 'buildSupervisedGrowthPreviewOverlay'], [lark, 'assertSupervisedGrowthPreviewDerivation'],
  [delivery, 'inspectActiveLarkOwnerBindingsLocally'], [recovery, 'inspectRecoveryOperatorSnapshot'],
  [automations, 'inspectAutomationsOperatorSnapshot'], [automations, 'automationDefinitionDigest'],
]
if (required.some(([module, name]) => typeof module[name] !== 'function')) throw new Error('required read-only operator seam is unavailable')
if (typeof recovery.RECOVERY_CATALOG_DIGEST !== 'string' || !/^[0-9a-f]{64}$/u.test(recovery.RECOVERY_CATALOG_DIGEST)) {
  throw new Error('Recovery catalog identity is unavailable')
}
process.stdout.write(JSON.stringify({ protocol: 'dsh-enhanced/supervised-lifecycle-capability/v1' }))
`

class LifecycleError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

class ServiceMaskConflictError extends LifecycleError {}

function fail(message, exitCode = 1) {
  throw new LifecycleError(message, exitCode)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function unmanagedAutomationDigest(records) {
  const managed = new Set(['recovery:supervised-growth', 'heartbeat:supervised-growth-analyst', 'heartbeat:supervised-growth'])
  const projected = records.filter(record => !managed.has(record.id)).map(record => ({
    id: record.id, owner: record.owner, definitionHash: record.definitionHash, status: record.status,
    nextRunAt: record.nextRunAt, createdAt: record.createdAt, updatedAt: record.updatedAt,
    version: record.version, runningTaskCount: record.runningTaskCount,
  })).sort((left, right) => left.id.localeCompare(right.id))
  return sha256(canonicalJson(projected))
}

function isServiceManifestVersion(version) {
  return version === SERVICE_MANIFEST_VERSION || version === SUPERVISED_SERVICE_MANIFEST_VERSION
}

function bindingFor(manifest) {
  return {
    version: manifest.version,
    id: manifest.id,
    homePath: manifest.homePath,
    canonicalHome: manifest.canonicalHome,
    transactionPath: manifest.transactionPath,
    transactionIdentity: manifest.transactionIdentity,
    profile: manifest.profile,
    operation: manifest.operation,
    originalIdentity: manifest.originalIdentity,
    originalProfileDigest: manifest.originalProfileDigest,
    originalProfileTreeDigest: manifest.originalProfileTreeDigest,
    stagedIdentity: manifest.stagedIdentity,
    stagedProfileDigest: manifest.stagedProfileDigest,
    expectedScenario: manifest.expectedScenario,
    stagedScenario: manifest.stagedScenario,
    createdAt: manifest.createdAt,
    state: manifest.state,
    services: manifest.services,
    servicePhase: manifest.servicePhase,
    serviceFailure: manifest.serviceFailure,
    serviceAcceptance: manifest.serviceAcceptance,
    unitUniverse: manifest.unitUniverse,
    foreignOwnership: manifest.foreignOwnership,
    cleanProfileDigest: manifest.cleanProfileDigest,
    cleanProfiles: manifest.cleanProfiles,
    serviceMasks: manifest.serviceMasks,
    containmentMasks: manifest.containmentMasks,
    containmentMaskIntents: manifest.containmentMaskIntents,
    serviceStartBarriers: manifest.serviceStartBarriers,
    containmentStartBarriers: manifest.containmentStartBarriers,
    archivedProfile: manifest.archivedProfile,
    cleanup: manifest.cleanup,
    supervisedLifecycle: manifest.supervisedLifecycle,
  }
}

function withBindingDigest(manifest) {
  return { ...manifest, bindingDigest: sha256(JSON.stringify(bindingFor(manifest))) }
}

function sameIdentity(actual, expected) {
  return expected !== undefined && actual.isDirectory()
    && String(actual.dev) === expected.dev
    && String(actual.ino) === expected.ino
    && (expected.uid === undefined || actual.uid === expected.uid)
    && (expected.mode === undefined || actual.mode === expected.mode)
}

function identity(entry) {
  return { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode }
}

function sameSymlinkIdentity(actual, expected) {
  return expected !== undefined && actual.isSymbolicLink()
    && String(actual.dev) === expected.dev
    && String(actual.ino) === expected.ino
    && actual.uid === expected.uid
    && actual.mode === expected.mode
    && actual.nlink === 1
}

function currentUid() {
  const uid = process.getuid?.()
  if (!Number.isInteger(uid)) fail('当前平台无法验证生命周期文件 owner。')
  return uid
}

function isGroupOrOtherWritable(entry) {
  return (entry.mode & 0o022) !== 0
}

function isRootOwnedStickyPublicDirectory(entry) {
  return entry.uid === 0 && (entry.mode & 0o7777) === 0o1777
}

function assertSafeAncestorEntry(entry, path) {
  if (!entry.isDirectory() || entry.isSymbolicLink()
    || (isGroupOrOtherWritable(entry) && !isRootOwnedStickyPublicDirectory(entry))) {
    fail(`生命周期祖先目录可被不受信任地替换或权限不安全：${path}`)
  }
}

function captureAncestorChain(parentPath) {
  const chain = []
  let cursor = parentPath
  for (;;) {
    const entry = lstatSync(cursor)
    assertSafeAncestorEntry(entry, cursor)
    chain.push({ path: cursor, ...identity(entry) })
    const next = dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  return chain
}

function parseAncestorChain(homePath) {
  let chain
  try { chain = JSON.parse(process.env[ANCESTOR_CHAIN_ENV] ?? '') }
  catch { fail('生命周期执行器缺少有效的祖先目录绑定。') }
  const expectedPaths = []
  let cursor = dirname(homePath)
  for (;;) {
    expectedPaths.push(cursor)
    const next = dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  if (!Array.isArray(chain) || chain.length !== expectedPaths.length) fail('生命周期祖先目录绑定不完整。')
  for (let index = 0; index < expectedPaths.length; index += 1) {
    const expected = chain[index]
    if (expected === null || typeof expected !== 'object' || expected.path !== expectedPaths[index]
      || typeof expected.dev !== 'string' || typeof expected.ino !== 'string'
      || !Number.isInteger(expected.uid) || !Number.isInteger(expected.mode)) {
      fail('生命周期祖先目录绑定格式无效。')
    }
  }
  return chain
}

function assertAncestorChainStable(homePath) {
  const chain = parseAncestorChain(homePath)
  for (const expected of chain) {
    let actual
    try { actual = lstatSync(expected.path) }
    catch { fail(`生命周期祖先目录在操作期间不可访问：${expected.path}`) }
    assertSafeAncestorEntry(actual, expected.path)
    if (String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino
      || actual.uid !== expected.uid || actual.mode !== expected.mode) {
      fail(`生命周期祖先目录身份或权限在操作期间发生变化：${expected.path}`)
    }
  }
  const openedParent = fstatSync(3)
  const expectedParent = chain[0]
  if (String(openedParent.dev) !== expectedParent.dev || String(openedParent.ino) !== expectedParent.ino
    || openedParent.uid !== expectedParent.uid || openedParent.mode !== expectedParent.mode) {
    fail('生命周期锁父目录 fd 与祖先目录绑定不匹配。')
  }
  return chain
}

function anchoredSibling(path) {
  return join(LOCK_PARENT_FD_PATH, basename(path))
}

function lifecyclePaths(homePath) {
  const transactionPath = `${homePath}${TRANSACTION_SUFFIX}`
  return {
    homePath,
    transactionPath,
    physicalHomePath: anchoredSibling(homePath),
    physicalTransactionRoot: anchoredSibling(transactionPath),
  }
}

function rendezvousLockPath(homePath) {
  return `/tmp/.dsh-enhanced-lifecycle-${currentUid()}-${sha256(homePath)}.lock`
}

function assertOwnedPrivateEntry(entry, path, kind) {
  const kindMatches = kind === 'directory' ? entry.isDirectory() : entry.isFile()
  if (!kindMatches || entry.isSymbolicLink() || entry.uid !== currentUid() || isGroupOrOtherWritable(entry)) {
    fail(`生命周期路径必须由当前用户拥有、不是符号链接且 group/other 不可写：${path}`)
  }
}

async function assertOwnedPrivateDirectory(path) {
  const descriptorMatch = /^\/proc\/self\/fd\/(\d+)$/u.exec(path)
  const entry = descriptorMatch === null
    ? await lstat(path).catch(() => undefined)
    : (() => { try { return fstatSync(Number(descriptorMatch[1])) } catch { return undefined } })()
  if (entry === undefined) fail(`生命周期目录不存在：${path}`)
  assertOwnedPrivateEntry(entry, path, 'directory')
  return entry
}

function assertExpectedDirectoryMetadata(actual, expected, path) {
  assertOwnedPrivateEntry(actual, path, 'directory')
  if (String(actual.dev) !== String(expected.dev) || String(actual.ino) !== String(expected.ino)
    || (expected.uid !== undefined && actual.uid !== expected.uid)
    || (expected.mode !== undefined && actual.mode !== expected.mode)) {
    fail(`生命周期关键目录身份或权限在使用前发生变化：${path}`)
  }
}

function sameSymlinkTarget(actual, expected) {
  return actual.target === expected.target
    && actual.targetIdentity?.dev === expected.targetIdentity?.dev
    && actual.targetIdentity?.ino === expected.targetIdentity?.ino
}

async function existingIdentity(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function canonicalMissingAllowed(path) {
  let cursor = resolve(path)
  const suffix = []
  for (;;) {
    try {
      const canonical = await realpath(cursor)
      return resolve(canonical, ...suffix)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.unshift(basename(cursor))
      cursor = parent
    }
  }
}

function inside(root, target) {
  return target === root || target.startsWith(root + sep)
}

function sameHomeOwnershipEvidence(serviceHome, workingDirectory, homePath) {
  return serviceHome === homePath && inside(homePath, workingDirectory)
}

async function fsyncPath(path, directory = false) {
  let handle
  try {
    handle = await open(path, directory ? constants.O_RDONLY : constants.O_RDWR)
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

async function withLifecycleLock(homePath, invocation) {
  const lockPath = `${homePath}.dsh-enhanced-lifecycle.lock`
  const parent = dirname(lockPath)
  const rendezvousPath = rendezvousLockPath(homePath)
  let parentDescriptor
  let lockDescriptor
  let rendezvousDescriptor
  try {
    const ancestorChain = captureAncestorChain(parent)
    parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const openedParent = fstatSync(parentDescriptor)
    const linkedParent = lstatSync(parent)
    if (!openedParent.isDirectory() || openedParent.uid !== currentUid() || isGroupOrOtherWritable(openedParent)
      || !linkedParent.isDirectory() || linkedParent.isSymbolicLink()
      || linkedParent.uid !== currentUid() || isGroupOrOtherWritable(linkedParent)
      || linkedParent.dev !== openedParent.dev || linkedParent.ino !== openedParent.ino) {
      fail(`生命周期锁父目录身份不稳定或权限不安全：${parent}`)
    }
    const expectedParent = ancestorChain[0]
    if (String(openedParent.dev) !== expectedParent.dev || String(openedParent.ino) !== expectedParent.ino
      || openedParent.uid !== expectedParent.uid || openedParent.mode !== expectedParent.mode) {
      fail(`生命周期锁父目录与祖先目录绑定不匹配：${parent}`)
    }
    lockDescriptor = openSync(join(`/proc/self/fd/${parentDescriptor}`, basename(lockPath)), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const locked = fstatSync(lockDescriptor)
    const linked = lstatSync(join(`/proc/self/fd/${parentDescriptor}`, basename(lockPath)))
    if (!locked.isFile() || locked.uid !== currentUid() || locked.nlink !== 1 || (locked.mode & 0o077) !== 0
      || !linked.isFile() || linked.isSymbolicLink() || linked.dev !== locked.dev || linked.ino !== locked.ino) {
      fail(`生命周期锁身份不稳定或权限不安全：${lockPath}`)
    }
    const temporaryDirectory = lstatSync('/tmp')
    if (!isRootOwnedStickyPublicDirectory(temporaryDirectory) || !temporaryDirectory.isDirectory() || temporaryDirectory.isSymbolicLink()) {
      fail('生命周期全局协调锁要求安全的 root-owned sticky /tmp。')
    }
    rendezvousDescriptor = openSync(rendezvousPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const rendezvous = fstatSync(rendezvousDescriptor)
    const linkedRendezvous = lstatSync(rendezvousPath)
    if (!rendezvous.isFile() || rendezvous.uid !== currentUid() || rendezvous.nlink !== 1 || (rendezvous.mode & 0o077) !== 0
      || !linkedRendezvous.isFile() || linkedRendezvous.isSymbolicLink()
      || linkedRendezvous.dev !== rendezvous.dev || linkedRendezvous.ino !== rendezvous.ino) {
      fail(`生命周期全局协调锁身份不稳定或权限不安全：${rendezvousPath}`)
    }
    const flockExecutable = process.env.DSH_ENHANCED_LIFECYCLE_FLOCK ?? '/usr/bin/flock'
    try {
      await run('/bin/bash', [
        '-c', 'flock_command="$1"; shift; "$flock_command" -n -E 75 3 || exit $?; "$flock_command" -n -E 75 4 || exit $?; "$flock_command" -n -E 75 5 || exit $?; exec "$@"',
        'dsh-enhanced-lifecycle-lock', flockExecutable,
        process.execPath, SCRIPT_PATH, ...invocation, '--lock-held',
      ], {
        env: { ...process.env, [ANCESTOR_CHAIN_ENV]: JSON.stringify(ancestorChain) },
        passFds: [parentDescriptor, lockDescriptor, rendezvousDescriptor],
      })
    }
    catch (error) {
      if (error instanceof LifecycleError && error.exitCode === 75) fail(`DSH_HOME 生命周期锁正在占用，拒绝并发操作：${lockPath}`)
      throw error
    }
  } finally {
    if (rendezvousDescriptor !== undefined) closeSync(rendezvousDescriptor)
    if (lockDescriptor !== undefined) closeSync(lockDescriptor)
    if (parentDescriptor !== undefined) closeSync(parentDescriptor)
  }
}

async function assertLifecycleLocksHeld(homePath) {
  const lockPath = `${homePath}.dsh-enhanced-lifecycle.lock`
  const parent = dirname(lockPath)
  assertAncestorChainStable(homePath)
  const checks = [
    { descriptor: 3, path: parent, kind: 'directory' },
    { descriptor: 4, path: anchoredSibling(lockPath), kind: 'file' },
    { descriptor: 5, path: rendezvousLockPath(homePath), kind: 'file' },
  ]
  for (const check of checks) {
    let opened
    let linked
    try { opened = fstatSync(check.descriptor); linked = lstatSync(check.path) }
    catch { fail('生命周期执行器缺少可验证的内核锁。') }
    const kindMatches = check.kind === 'directory' ? opened.isDirectory() && linked.isDirectory() : opened.isFile() && linked.isFile()
    if (!kindMatches || linked.isSymbolicLink() || opened.uid !== currentUid() || linked.uid !== currentUid()
      || isGroupOrOtherWritable(opened) || isGroupOrOtherWritable(linked)
      || opened.dev !== linked.dev || opened.ino !== linked.ino
      || check.kind === 'file' && (opened.nlink !== 1 || (opened.mode & 0o077) !== 0)
      ) {
      fail('生命周期内核锁的路径身份已变化，拒绝继续。')
    }
    try {
      // Re-lock the inherited open-file-description itself. util-linux flock
      // starts its command in a distinct process and re-locking through a new
      // flock invocation can conflict with its parent, so use the kernel call
      // directly in a tiny interpreter. The inherited fd remains the same
      // open-file-description across exec.
      await run('/usr/bin/perl', [
        '-MFcntl=:flock', '-e', `open(F, "<&", ${check.descriptor}) or exit 74; flock(F, LOCK_EX|LOCK_NB) or exit 75;`,
      ], {
        env: { PATH: '/usr/bin:/bin' },
        passFds: [3, 4, 5],
      })
    } catch (error) {
      if (error instanceof LifecycleError && error.exitCode === 75) fail('生命周期执行器继承的 fd 未持有要求的内核排他锁。')
      throw error
    }
  }
}

async function resolveSymlinkTarget(path, logicalPath, linkText, physicalRoot, logicalRoot) {
  let candidate
  if (isAbsolute(linkText)) {
    const absoluteTarget = resolve(linkText)
    candidate = inside(logicalRoot, absoluteTarget)
      ? resolve(physicalRoot, absoluteTarget.slice(logicalRoot.length + 1))
      : absoluteTarget
  } else {
    const physicalTarget = resolve(dirname(path), linkText)
    // A relative pnpm link can lexically leave staged-home only because the
    // snapshot lives below the transaction directory. Resolve those links as
    // they will behave after the staged tree is renamed back to logicalHome.
    // Links whose lexical target remains in staged-home must resolve there: a
    // fallback to the original tree would hide a target deleted by a package
    // script and incorrectly commit a newly dangling link.
    candidate = inside(physicalRoot, physicalTarget)
      ? physicalTarget
      : resolve(dirname(logicalPath), linkText)
  }
  try {
    const target = await realpath(candidate)
    return { target, targetIdentity: identity(await lstat(target)) }
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
  }
  return { target: undefined, targetIdentity: undefined }
}

async function assertSnapshotTreeSafe(homePath, logicalHome = homePath, allowPackageHardlinks = false, packageSymlinkWhitelist) {
  const canonicalHome = await realpath(homePath)
  const homeStat = await assertOwnedPrivateDirectory(homePath)
  const hardlinks = new Map()
  const observedPackageSymlinks = new Map()
  const visit = async directory => {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      const path = join(directory, entry.name)
      const relative = path.slice(homePath.length + 1)
      if (entry.isSymbolicLink()) {
        const linkText = await readlink(path)
        let resolvedTarget
        try {
          resolvedTarget = await resolveSymlinkTarget(path, join(logicalHome, relative), linkText, canonicalHome, logicalHome)
        }
        catch { fail(`DSH_HOME 包含不可安全解析的符号链接，拒绝快照：${relative}`) }
        const packageLink = relative.split(sep).includes('node_modules')
        const description = { linkText, ...resolvedTarget }
        if (packageLink) observedPackageSymlinks.set(relative, description)
        if (resolvedTarget.target !== undefined && inside(canonicalHome, resolvedTarget.target)) continue
        if (!packageLink) {
          const kind = resolvedTarget.target === undefined ? '悬空或不可解析' : '指向外部'
          fail(`DSH_HOME 包含${kind}的符号链接，拒绝快照：${relative} -> ${linkText}`)
        }
        // pnpm projects linked packages through node_modules. Only links that
        // existed in the original snapshot, with the same link text and the
        // same resolved target identity, may retain an external/dangling shape
        // after package scripts and isolated activation have run.
        if (packageSymlinkWhitelist !== undefined) {
          const expected = packageSymlinkWhitelist.get(relative)
          if (expected === undefined || linkText !== expected.linkText || !sameSymlinkTarget(description, expected)) {
            fail(`staged DSH_HOME 包含新增或已改变的 node_modules 外链/悬空链接，拒绝提交：${relative} -> ${linkText}`)
          }
        }
        continue
      }
      if (entry.isDirectory()) {
        const directoryStat = await lstat(path)
        assertOwnedPrivateEntry(directoryStat, path, 'directory')
        if (String(directoryStat.dev) !== String(homeStat.dev)) fail(`DSH_HOME 包含其它文件系统的挂载点，拒绝快照：${relative}`)
        await visit(path)
      } else if (entry.isFile()) {
        const fileStat = await lstat(path)
        assertOwnedPrivateEntry(fileStat, path, 'file')
        if (fileStat.nlink > 1 && !(allowPackageHardlinks && relative.split(sep).includes('node_modules'))) {
          const key = `${fileStat.dev}:${fileStat.ino}`
          const observed = hardlinks.get(key) ?? { count: 0, expected: fileStat.nlink, first: relative }
          observed.count += 1
          hardlinks.set(key, observed)
        }
      } else fail(`DSH_HOME 包含无法安全快照的特殊文件：${relative}`)
    }
  }
  await visit(homePath)
  for (const value of hardlinks.values()) {
    if (value.count !== value.expected) fail(`DSH_HOME 包含可能连接到快照外部的硬链接，拒绝快照：${value.first}`)
  }
  return observedPackageSymlinks
}

async function assertNoMounts(root) {
  let source
  try { source = await readFile('/proc/self/mountinfo', 'utf8') }
  catch { fail('无法读取 /proc/self/mountinfo；不能证明 DSH_HOME 不含挂载点。') }
  const canonicalRoot = await canonicalMissingAllowed(root)
  for (const line of source.split('\n')) {
    if (line === '') continue
    const fields = line.split(' ')
    if (fields.length < 5) fail('无法解析 /proc/self/mountinfo；拒绝生命周期操作。')
    const mount = fields[4].replace(/\\([0-7]{3})/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
    if (inside(canonicalRoot, resolve(mount))) fail(`DSH_HOME 包含挂载点，拒绝生命周期操作：${mount}`)
  }
}

async function writeFileAtomic(path, contents) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, contents, { mode: 0o600 })
  await fsyncPath(temporary)
  await rename(temporary, path)
  await fsyncPath(dirname(path), true)
}

const MANIFEST_MAX_BYTES = 64 * 1024
const PROFILE_TREE_MAX_ENTRIES = 200_000
const PROFILE_TREE_MAX_FILE_BYTES = 64 * 1024 * 1024
const MANIFEST_TOP_LEVEL_KEYS = [
  'version', 'id', 'homePath', 'canonicalHome', 'transactionPath', 'transactionIdentity',
  'profile', 'operation', 'originalIdentity', 'originalProfileDigest', 'originalProfileTreeDigest', 'stagedIdentity',
  'stagedProfileDigest', 'expectedScenario', 'stagedScenario', 'createdAt', 'state',
  'services', 'servicePhase', 'serviceFailure', 'serviceAcceptance', 'unitUniverse',
  'foreignOwnership', 'cleanProfileDigest', 'cleanProfiles', 'serviceMasks',
  'containmentMasks', 'containmentMaskIntents', 'serviceStartBarriers',
  'containmentStartBarriers', 'archivedProfile', 'cleanup', 'supervisedLifecycle',
  // 以下三个键不进 bindingDigest：updatedAt/failure 是事务时间线与收容诊断，
  // bindingDigest 是自反校验字段本身。未知顶层键必须拒绝，否则可绕过篡改信封。
  'updatedAt', 'failure', 'bindingDigest',
]

function validManifestTopLevel(manifest) {
  return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
    && Object.keys(manifest).every(key => MANIFEST_TOP_LEVEL_KEYS.includes(key))
    && (manifest.failure === undefined || typeof manifest.failure === 'string')
}

async function writeManifest(transactionRoot, manifest, state, details = {}) {
  const next = withBindingDigest({ ...manifest, ...details, state, updatedAt: new Date().toISOString() })
  if (!validManifestTopLevel(next)) {
    fail('生命周期事务 manifest 包含未知顶层字段，拒绝持久化（可能绕过 bindingDigest 信封）。')
  }
  const serialized = `${JSON.stringify(next, null, 2)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MANIFEST_MAX_BYTES) {
    fail(`生命周期事务 manifest 超过 ${MANIFEST_MAX_BYTES} 字节安全上限，拒绝持久化：${transactionRoot}`)
  }
  await writeFileAtomic(join(transactionRoot, 'manifest.json'), serialized)
  return next
}

async function loadManifest(physicalTransactionRoot, expected) {
  let rootDescriptor
  let manifestDescriptor
  let manifest
  try {
    rootDescriptor = openSync(physicalTransactionRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const rootStat = fstatSync(rootDescriptor)
    if (!rootStat.isDirectory() || rootStat.uid !== currentUid() || (rootStat.mode & 0o077) !== 0) throw new Error('unsafe root')
    manifestDescriptor = openSync(`/proc/self/fd/${rootDescriptor}/manifest.json`, constants.O_RDONLY | constants.O_NOFOLLOW)
    const manifestStat = fstatSync(manifestDescriptor)
    if (!manifestStat.isFile() || manifestStat.uid !== currentUid()
      || manifestStat.nlink !== 1 || (manifestStat.mode & 0o077) !== 0 || manifestStat.size > MANIFEST_MAX_BYTES) throw new Error('unsafe manifest')
    manifest = JSON.parse(await readFile(`/proc/self/fd/${manifestDescriptor}`, 'utf8'))
    if (isServiceManifestVersion(manifest?.version) && !sameIdentity(rootStat, manifest.transactionIdentity)) {
      throw new Error('transaction root identity mismatch')
    }
  } catch {
    fail(`拒绝未绑定或未知的生命周期事务；缺少有效 manifest：${expected.transactionPath}`)
  } finally {
    if (manifestDescriptor !== undefined) closeSync(manifestDescriptor)
    if (rootDescriptor !== undefined) closeSync(rootDescriptor)
  }
  const initializingServiceManifest = isServiceManifestVersion(manifest?.version)
    && manifest.state === 'preparing' && manifest.servicePhase === 'initializing'
    && Array.isArray(manifest.services) && manifest.services.length > 0
    && Array.isArray(manifest.unitUniverse) && manifest.unitUniverse.length > 0
    && validForeignOwnershipInventory(manifest)
    && Array.isArray(manifest.serviceMasks) && manifest.serviceMasks.length === 0
    && Array.isArray(manifest.containmentMasks) && manifest.containmentMasks.length === 0
    && Array.isArray(manifest.containmentMaskIntents) && manifest.containmentMaskIntents.length === 0
    && Array.isArray(manifest.containmentStartBarriers) && manifest.containmentStartBarriers.length === 0
    && Array.isArray(manifest.serviceStartBarriers) && manifest.serviceStartBarriers.length === 0
  const validServiceManifest = !isServiceManifestVersion(manifest?.version) || initializingServiceManifest || (
    Array.isArray(manifest.services) && manifest.services.length > 0
    && Array.isArray(manifest.unitUniverse) && manifest.unitUniverse.length > 0
    && new Set(manifest.unitUniverse).size === manifest.unitUniverse.length
    && manifest.unitUniverse.every(unit => typeof unit === 'string' && SYSTEMD_UNIT.test(unit))
    && validForeignOwnershipInventory(manifest)
    && SERVICE_PHASES.has(manifest.servicePhase)
    && Array.isArray(manifest.serviceMasks) && manifest.serviceMasks.length === manifest.services.length
    && manifest.serviceMasks.every((mask, index) => validBoundMask(mask, manifest.services[index]?.unit, physicalTransactionRoot))
    && Array.isArray(manifest.containmentMasks)
    && manifest.containmentMasks.every(mask => validBoundMask(mask, mask?.unit, physicalTransactionRoot))
    && Array.isArray(manifest.containmentMaskIntents)
    && manifest.containmentMaskIntents.every(intent => validMaskIntent(intent, physicalTransactionRoot))
    && Array.isArray(manifest.containmentStartBarriers)
    && manifest.containmentStartBarriers.every(barrier => barrier !== null && typeof barrier === 'object'
      && typeof barrier.unit === 'string' && SYSTEMD_UNIT.test(barrier.unit)
      && ['enabled', 'disabled'].includes(barrier.originalUnitFileState)
      && typeof barrier.disableIntentAt === 'string' && validBoundEnablement(barrier, physicalTransactionRoot))
    && new Set([...manifest.serviceMasks, ...manifest.containmentMasks].map(mask => mask.unit)).size
      === manifest.serviceMasks.length + manifest.containmentMasks.length
    && Array.isArray(manifest.serviceStartBarriers)
    && manifest.serviceStartBarriers.length === manifest.services.length
    && manifest.serviceStartBarriers.every((barrier, index) => barrier !== null && typeof barrier === 'object'
      && typeof barrier.unit === 'string' && barrier.unit === manifest.services[index]?.unit
      && ['enabled', 'disabled'].includes(barrier.originalUnitFileState)
      && typeof barrier.disableIntentAt === 'string'
      && validBoundEnablement(barrier, physicalTransactionRoot))
    && manifest.services.every(service => service !== null && typeof service === 'object'
      && typeof service.unit === 'string' && SYSTEMD_UNIT.test(service.unit)
      && typeof service.profile === 'string' && PROFILE_NAME.test(service.profile)
      && service.unit === `dsh-profile-${service.profile}.service`
      && service.serviceHome === expected.homePath
      && typeof service.wasActive === 'boolean'
      && service.fragment !== null && typeof service.fragment === 'object'
      && typeof service.fragment.path === 'string' && typeof service.fragment.sha256 === 'string'
      && Array.isArray(service.dropIns))
  )
  const validExpectedScenario = manifest?.expectedScenario === undefined
    ? manifest?.version === MANIFEST_VERSION
    : LIFECYCLE_SCENARIOS.has(manifest.expectedScenario)
      && (isServiceManifestVersion(manifest.version)
        ? manifest.expectedScenario === (manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION ? 'supervised' : 'lark')
        : manifest.expectedScenario === 'web' || manifest.expectedScenario === 'autonomy')
  const validStagedScenario = manifest?.stagedScenario === undefined
    || (LIFECYCLE_SCENARIOS.has(manifest.stagedScenario) || manifest.stagedScenario === 'unsupported')
      && (manifest.operation === 'uninstall'
        ? manifest.stagedScenario === 'unsupported'
        : manifest.stagedScenario === manifest.expectedScenario)
      && (!isServiceManifestVersion(manifest.version) || (manifest.operation === 'uninstall'
        ? manifest.stagedScenario === 'unsupported'
        : manifest.stagedScenario === (manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION ? 'supervised' : 'lark')))
  const validCleanProfileDigest = manifest?.cleanProfileDigest === undefined
    || isServiceManifestVersion(manifest.version) && manifest.operation === 'uninstall'
      && /^[0-9a-f]{64}$/u.test(manifest.cleanProfileDigest)
  const validCleanProfiles = manifest?.cleanProfiles === undefined || Array.isArray(manifest.cleanProfiles)
    && new Set(manifest.cleanProfiles.map(entry => entry?.profile)).size === manifest.cleanProfiles.length
    && manifest.cleanProfiles.every(entry => entry !== null && typeof entry === 'object'
      && typeof entry.profile === 'string' && PROFILE_NAME.test(entry.profile)
      && /^[0-9a-f]{64}$/u.test(entry.digest)
      && manifest.services?.some(service => service?.profile === entry.profile))
  const validCleanup = manifest?.cleanup === undefined
    || validServiceCleanup(manifest.cleanup, manifest)
  const validSupervised = validV3OperationShape(manifest)
  const validVersionFields = manifest?.version === SUPERVISED_SERVICE_MANIFEST_VERSION
    || manifest?.supervisedLifecycle === undefined && manifest?.archivedProfile === undefined
      && manifest?.originalProfileTreeDigest === undefined
  if (![MANIFEST_VERSION, SERVICE_MANIFEST_VERSION, SUPERVISED_SERVICE_MANIFEST_VERSION].includes(manifest?.version)
    || typeof manifest.id !== 'string'
    || manifest.homePath !== expected.homePath
    || manifest.transactionPath !== expected.transactionPath
    || isServiceManifestVersion(manifest.version) && (manifest.transactionIdentity === undefined
      || typeof manifest.transactionIdentity.dev !== 'string' || typeof manifest.transactionIdentity.ino !== 'string')
    || isServiceManifestVersion(manifest.version) && manifest.operation === 'uninstall'
      && (!Array.isArray(manifest.foreignOwnership) || !Array.isArray(manifest.cleanProfiles))
    || manifest.profile !== expected.profile
    || !['upgrade', 'uninstall'].includes(manifest.operation)
    || !['preparing', 'prepared', 'validated', 'original-renamed', 'swapped', 'committed', 'cleanup-started', 'failed', 'service-accepted', 'service-failed'].includes(manifest.state)
    || !validServiceManifest
    || !validExpectedScenario
    || !validStagedScenario
    || !validCleanProfileDigest
    || !validCleanProfiles
    || !validCleanup
    || !validSupervised
    || !validVersionFields
    || !validManifestTopLevel(manifest)
    || manifest.bindingDigest !== sha256(JSON.stringify(bindingFor(manifest)))) {
    fail(`拒绝未绑定或校验失败的生命周期事务 manifest：${expected.transactionPath}`)
  }
  if (expected.homePath !== manifest.canonicalHome) fail(`生命周期事务 manifest 与当前 DSH_HOME 未绑定：${expected.transactionPath}`)
  return manifest
}

function validForeignOwnershipEvidence(evidence) {
  return evidence !== null && typeof evidence === 'object'
    && typeof evidence.unit === 'string' && SYSTEMD_UNIT.test(evidence.unit)
    && typeof evidence.digest === 'string' && /^[0-9a-f]{64}$/u.test(evidence.digest)
}

function validForeignOwnershipInventory(manifest) {
  if (!Array.isArray(manifest?.services) || !Array.isArray(manifest.unitUniverse)) return false
  const managed = manifest.services.map(service => service?.unit)
  const contained = [
    ...(Array.isArray(manifest.containmentMasks) ? manifest.containmentMasks : []),
    ...(Array.isArray(manifest.containmentMaskIntents) ? manifest.containmentMaskIntents : []),
  ].map(record => record?.unit)
  const foreign = manifest.foreignOwnership
  if (foreign === undefined) {
    const combined = [...managed, ...contained]
    return new Set(combined).size === combined.length
      && JSON.stringify([...combined].sort()) === JSON.stringify([...manifest.unitUniverse].sort())
  }
  if (!Array.isArray(foreign) || !foreign.every(evidence => validForeignOwnershipEvidence(evidence))) return false
  const foreignUnits = foreign.map(evidence => evidence.unit)
  const combined = [...managed, ...foreignUnits, ...contained].sort()
  return new Set(combined).size === combined.length
    && JSON.stringify(combined) === JSON.stringify([...manifest.unitUniverse].sort())
}

function validDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function validCompactOperatorProof(proof) {
  const expected = {
    'assistant-delivery/active-lark-owner-bindings-snapshot/v1': 19,
    'assistant-recovery/operator-snapshot/v1': 4,
    'assistant-automations-operator-snapshot/v1': 15,
  }
  const additional = proof?.protocol === 'assistant-delivery/active-lark-owner-bindings-snapshot/v1'
    ? ['storageDigest'] : proof?.protocol === 'assistant-automations-operator-snapshot/v1' ? ['inventoryDigest', 'storageDigest']
      : proof?.protocol === 'assistant-recovery/operator-snapshot/v1' ? ['bootstrap'] : []
  return exactKeys(proof, ['protocol', 'schemaVersion', 'database', 'snapshotDigest'], additional)
    && expected[proof.protocol] === proof.schemaVersion
    && validDigest(proof.snapshotDigest)
    && proof.database !== null && typeof proof.database === 'object'
    && typeof proof.database.device === 'string' && typeof proof.database.inode === 'string'
    && (Number.isSafeInteger(proof.database.size) && proof.database.size >= 0
      || typeof proof.database.size === 'string' && /^(?:0|[1-9]\d*)$/u.test(proof.database.size))
    && validDigest(proof.database.digest)
    && (proof.storageDigest === undefined || validDigest(proof.storageDigest))
    && (proof.inventoryDigest === undefined || validDigest(proof.inventoryDigest))
    && (proof.protocol !== 'assistant-automations-operator-snapshot/v1' || validDigest(proof.storageDigest))
}

function exactKeys(value, required, optional = []) {
  if (value === null || typeof value !== 'object') return false
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

function validRecoveryBootstrap(value) {
  return exactKeys(value, ['status', 'generation', 'attestationValid', 'attestationSetDigest', 'attestations'])
    && value.status === 'succeeded' && value.attestationValid === true
    && Number.isSafeInteger(value.generation) && value.generation > 0
    && validDigest(value.attestationSetDigest) && Array.isArray(value.attestations)
    && value.attestations.length > 0 && value.attestations.every(attestation => (
      exactKeys(attestation, ['automationId', 'activationState', 'activationNonce', 'activationPlanDigest'])
      && typeof attestation.automationId === 'string' && ['preview', 'active'].includes(attestation.activationState)
      && typeof attestation.activationNonce === 'string' && validDigest(attestation.activationPlanDigest)
    ))
}

function validDatabasePaths(paths) {
  return exactKeys(paths, ['delivery', 'automations', 'recovery'])
    && ['delivery', 'automations', 'recovery'].every(key => typeof paths[key] === 'string'
      && paths[key] !== '' && paths[key] !== '.' && !isAbsolute(paths[key]) && !paths[key].split('/').includes('..'))
}

function validSupervisedLifecycle(value, operation = 'upgrade') {
  const uninstall = operation === 'uninstall'
  if (uninstall) return validSupervisedUninstallLifecycle(value)
  if (operation !== 'upgrade' || !exactKeys(value, ['protocol', 'phase', 'activationNonce'], [
    'catalogDigest', 'databasePaths', 'source', 'previewPlan', 'previewAcceptance', 'activePlan',
    'startAttempt', 'postSwapAcceptance',
  ]) || value.protocol !== SUPERVISED_UPGRADE_PROTOCOL
    || !SUPERVISED_UPGRADE_PHASES.has(value.phase) || typeof value.activationNonce !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.activationNonce)) return false
  const catalogRequired = !['source-pending', 'source-attested'].includes(value.phase)
  if (catalogRequired ? !validDigest(value.catalogDigest) : value.catalogDigest !== undefined) return false
  const paths = value.databasePaths
  if (paths !== undefined && !validDatabasePaths(paths)) return false
  const source = value.source
  if (source !== undefined && (!exactKeys(source, [
    'effectiveConfigDigest', 'semanticDigest', 'databasePaths', 'ownerBindingDigest',
    'deliveryProof', 'recoveryProof', 'automationsProof', 'unmanagedAutomationsDigest', 'activePlan',
  ])
    || !validDigest(source.effectiveConfigDigest) || !validDigest(source.semanticDigest)
    || !validDatabasePaths(source.databasePaths) || !validDigest(source.ownerBindingDigest)
    || !validDigest(source.unmanagedAutomationsDigest)
    || !exactKeys(source.activePlan, [
      'effectiveConfigDigest', 'attestationSetDigest', 'managedInventoryDigest', 'attestationDigest',
      'activationNonceDigest', 'catalogDigest',
    ]) || !Object.values(source.activePlan).every(validDigest)
    || !validCompactOperatorProof(source.deliveryProof)
    || !validCompactOperatorProof(source.recoveryProof)
    || !validRecoveryBootstrap(source.recoveryProof.bootstrap)
    || !validCompactOperatorProof(source.automationsProof))) return false
  for (const key of ['previewPlan', 'activePlan']) {
    const plan = value[key]
    if (plan !== undefined && (!exactKeys(plan, [
      'patchDigest', 'effectiveConfigDigest', 'attestationSetDigest', 'managedInventoryDigest', 'ownerBindingDigest',
      'externalProviderExemptions', ...(key === 'previewPlan' ? ['runtimeOverlayDigest'] : []),
    ])
      || !validDigest(plan.patchDigest) || !validDigest(plan.effectiveConfigDigest)
      || !validDigest(plan.attestationSetDigest) || !validDigest(plan.managedInventoryDigest)
      || !validDigest(plan.ownerBindingDigest)
      || key === 'previewPlan' && !validDigest(plan.runtimeOverlayDigest)
      || JSON.stringify(plan.externalProviderExemptions) !== JSON.stringify(key === 'previewPlan' ? ['larkChannel'] : []))) return false
  }
  for (const key of ['previewAcceptance', 'postSwapAcceptance']) {
    const proof = value[key]
    if (proof !== undefined && (!exactKeys(proof, [
      'generation', 'deliveryProof', 'recoveryProof', 'automationsProof', 'ownerBindingDigest',
      'unmanagedAutomationsDigest', 'databasePaths', 'attestationDigest', ...(key === 'postSwapAcceptance' ? ['invocationId'] : []),
    ])
      || !Number.isSafeInteger(proof.generation) || proof.generation < 1
      || !validCompactOperatorProof(proof.deliveryProof) || !validDigest(proof.ownerBindingDigest)
      || !validDigest(proof.unmanagedAutomationsDigest)
      || !validDatabasePaths(proof.databasePaths) || !validDigest(proof.attestationDigest)
      || key === 'postSwapAcceptance' && (typeof proof.invocationId !== 'string' || proof.invocationId === '')
      || !validCompactOperatorProof(proof.recoveryProof)
      || !validRecoveryBootstrap(proof.recoveryProof.bootstrap)
      || !validCompactOperatorProof(proof.automationsProof))) return false
  }
  if (value.startAttempt !== undefined && (!exactKeys(value.startAttempt, ['kind', 'baselineGeneration'])
    || !['restore-source', 'accept-active'].includes(value.startAttempt.kind)
    || !Number.isSafeInteger(value.startAttempt.baselineGeneration) || value.startAttempt.baselineGeneration < 0)) return false
  const requiredByPhase = {
    'source-pending': [], 'source-attested': ['source', 'databasePaths'], 'preview-prepared': ['source', 'databasePaths', 'previewPlan'],
    'preview-running': ['source', 'previewPlan'],
    'preview-accepted': ['source', 'previewPlan', 'previewAcceptance'],
    'active-prepared': ['source', 'previewPlan', 'previewAcceptance', 'activePlan'],
    'post-swap-pending': ['source', 'previewPlan', 'previewAcceptance', 'activePlan', 'startAttempt'],
    'post-swap-accepted': ['source', 'previewPlan', 'previewAcceptance', 'activePlan', 'startAttempt', 'postSwapAcceptance'],
  }
  const allowedByPhase = {
    'source-pending': [], 'source-attested': ['databasePaths', 'source', 'startAttempt'],
    'preview-prepared': ['databasePaths', 'source', 'catalogDigest', 'previewPlan'],
    'preview-running': ['databasePaths', 'source', 'catalogDigest', 'previewPlan'],
    'preview-accepted': ['databasePaths', 'source', 'catalogDigest', 'previewPlan', 'previewAcceptance'],
    'active-prepared': ['databasePaths', 'source', 'catalogDigest', 'previewPlan', 'previewAcceptance', 'activePlan'],
    'post-swap-pending': ['databasePaths', 'source', 'catalogDigest', 'previewPlan', 'previewAcceptance', 'activePlan', 'startAttempt'],
    'post-swap-accepted': ['databasePaths', 'source', 'catalogDigest', 'previewPlan', 'previewAcceptance', 'activePlan', 'startAttempt', 'postSwapAcceptance'],
  }
  const phaseOrder = [...SUPERVISED_UPGRADE_PHASES]
  const optionalStateKeys = ['catalogDigest', 'databasePaths', 'source', 'previewPlan', 'previewAcceptance', 'activePlan', 'startAttempt', 'postSwapAcceptance']
  const proofPathsMatch = value.source === undefined || value.databasePaths === undefined || (
    JSON.stringify(value.source.databasePaths) === JSON.stringify(value.databasePaths)
    && value.source.deliveryProof.database !== undefined && value.source.recoveryProof.database !== undefined
    && value.source.automationsProof.database !== undefined
  )
  const acceptanceMatches = (acceptance, plan) => acceptance === undefined || (
    acceptance.recoveryProof.bootstrap.generation === acceptance.generation
    && acceptance.recoveryProof.bootstrap.attestationSetDigest === plan.attestationSetDigest
    && acceptance.ownerBindingDigest === plan.ownerBindingDigest
    && acceptance.unmanagedAutomationsDigest === value.source.unmanagedAutomationsDigest
    && JSON.stringify(acceptance.databasePaths) === JSON.stringify(value.databasePaths)
  )
  return phaseOrder.includes(value.phase) && requiredByPhase[value.phase].every(key => value[key] !== undefined)
    && optionalStateKeys.every(key => value[key] === undefined || allowedByPhase[value.phase].includes(key))
    && proofPathsMatch
    && acceptanceMatches(value.previewAcceptance, value.previewPlan)
    && acceptanceMatches(value.postSwapAcceptance, value.activePlan)
    && (!['post-swap-pending', 'post-swap-accepted'].includes(value.phase) || value.startAttempt.kind === 'accept-active')
    && (value.phase !== 'source-attested' || value.startAttempt === undefined || value.startAttempt.kind === 'restore-source')
    && (value.startAttempt?.kind !== 'accept-active' || value.startAttempt.baselineGeneration >= value.previewAcceptance.generation)
    && (value.previewAcceptance === undefined || value.previewAcceptance.generation > value.source.recoveryProof.bootstrap.generation)
    && (value.postSwapAcceptance === undefined || value.postSwapAcceptance.generation > value.startAttempt.baselineGeneration)
}

function validSupervisedUninstallLifecycle(value) {
  if (!exactKeys(value, ['protocol', 'phase'], ['databasePaths', 'source', 'startAttempt'])
    || value.protocol !== SUPERVISED_UNINSTALL_PROTOCOL
    || !SUPERVISED_UNINSTALL_PHASES.has(value.phase)) return false
  if (value.databasePaths !== undefined && !validDatabasePaths(value.databasePaths)) return false
  const source = value.source
  if (source !== undefined && !validSupervisedLifecycle({
    protocol: SUPERVISED_UPGRADE_PROTOCOL, phase: 'source-attested',
    activationNonce: '00000000-0000-4000-8000-000000000000',
    databasePaths: value.databasePaths, source,
  })) return false
  if (value.startAttempt !== undefined && (!exactKeys(value.startAttempt, ['kind', 'baselineGeneration'])
    || value.startAttempt.kind !== 'restore-source'
    || !Number.isSafeInteger(value.startAttempt.baselineGeneration) || value.startAttempt.baselineGeneration < 0)) return false
  const required = {
    'source-pending': [],
    'source-attested': ['databasePaths', 'source'],
    'clean-target-validated': ['databasePaths', 'source'],
    'clean-target-pending': ['databasePaths', 'source'],
    'clean-target-accepted': ['databasePaths', 'source'],
  }
  const allowed = {
    'source-pending': [],
    'source-attested': ['databasePaths', 'source', 'startAttempt'],
    'clean-target-validated': ['databasePaths', 'source'],
    'clean-target-pending': ['databasePaths', 'source'],
    'clean-target-accepted': ['databasePaths', 'source'],
  }
  return required[value.phase].every(key => value[key] !== undefined)
    && ['databasePaths', 'source', 'startAttempt'].every(key => value[key] === undefined || allowed[value.phase].includes(key))
    && (source === undefined || JSON.stringify(source.databasePaths) === JSON.stringify(value.databasePaths))
}

function validSupervisedManifestPhase(manifest) {
  if (manifest.version !== SUPERVISED_SERVICE_MANIFEST_VERSION) return true
  const phase = manifest.supervisedLifecycle?.phase
  const allowed = manifest.operation === 'uninstall' ? {
    'source-pending': [['preparing', 'initializing'], ['preparing', 'stopping'], ['preparing', 'stopped'], ['service-failed', 'service-failed']],
    'source-attested': [['preparing', 'stopped'], ['preparing', 'starting'], ['prepared', 'stopped'], ['service-failed', 'service-failed']],
    'clean-target-validated': [['validated', 'stopped'], ['original-renamed', 'stopped'], ['swapped', 'swapped'], ['service-failed', 'service-failed']],
    'clean-target-pending': [['swapped', 'starting'], ['cleanup-started', 'starting'], ['cleanup-started', 'service-failed'], ['service-failed', 'service-failed']],
    'clean-target-accepted': [['service-accepted', 'service-accepted'], ['committed', 'service-accepted'], ['cleanup-started', 'service-accepted'], ['service-failed', 'service-failed']],
  } : {
    'source-pending': [['preparing', 'initializing'], ['preparing', 'stopping'], ['preparing', 'stopped'], ['service-failed', 'service-failed']],
    'source-attested': [['preparing', 'stopped'], ['preparing', 'starting'], ['prepared', 'stopped'], ['service-failed', 'service-failed']],
    'preview-prepared': [['prepared', 'stopped'], ['service-failed', 'service-failed']],
    'preview-running': [['prepared', 'stopped'], ['service-failed', 'service-failed']],
    'preview-accepted': [['prepared', 'stopped'], ['service-failed', 'service-failed']],
    'active-prepared': [['prepared', 'stopped'], ['validated', 'stopped'], ['original-renamed', 'stopped'], ['swapped', 'swapped'], ['service-failed', 'service-failed']],
    'post-swap-pending': [['swapped', 'starting'], ['cleanup-started', 'starting'], ['cleanup-started', 'service-failed'], ['service-failed', 'service-failed']],
    'post-swap-accepted': [['service-accepted', 'service-accepted'], ['committed', 'service-accepted'], ['cleanup-started', 'service-accepted'], ['service-failed', 'service-failed']],
  }
  return allowed[phase]?.some(([state, servicePhase]) => manifest.state === state && manifest.servicePhase === servicePhase) === true
}

function validV3ServiceAcceptance(manifest) {
  if (manifest.version !== SUPERVISED_SERVICE_MANIFEST_VERSION) return true
  const acceptance = manifest.serviceAcceptance
  const phase = manifest.supervisedLifecycle?.phase
  const outerState = `${manifest.state}:${manifest.servicePhase}`
  const pendingPhase = manifest.operation === 'uninstall' ? 'clean-target-pending' : 'post-swap-pending'
  const acceptedPhase = manifest.operation === 'uninstall' ? 'clean-target-accepted' : 'post-swap-accepted'
  const acceptanceAllowed = phase === pendingPhase
    ? ['swapped:starting', 'cleanup-started:starting', 'cleanup-started:service-failed', 'service-failed:service-failed'].includes(outerState)
    : phase === acceptedPhase
      && ['service-accepted:service-accepted', 'committed:service-accepted', 'cleanup-started:service-accepted', 'service-failed:service-failed'].includes(outerState)
  if (acceptance === undefined) return phase !== acceptedPhase
  return acceptanceAllowed && validServiceAcceptanceRecords(manifest)
    && (manifest.operation === 'uninstall' || manifest.supervisedLifecycle?.postSwapAcceptance === undefined
      || acceptance.some(proof => proof.unit === `dsh-profile-${manifest.profile}.service`
        && proof.invocationId === manifest.supervisedLifecycle.postSwapAcceptance.invocationId))
}

function validServiceAcceptanceRecords(manifest) {
  const acceptance = manifest.serviceAcceptance
  if (!Array.isArray(acceptance) || !Array.isArray(manifest.services)) return false
  const activeUnits = manifest.services.filter(service => service?.wasActive === true).map(service => service.unit).sort()
  if (acceptance.length !== activeUnits.length) return false
  const acceptedUnits = []
  for (const proof of acceptance) {
    if (!exactKeys(proof, ['unit', 'invocationId', 'mainPid', 'nRestarts'])
      || typeof proof.unit !== 'string' || !SYSTEMD_UNIT.test(proof.unit)
      || typeof proof.invocationId !== 'string' || proof.invocationId === ''
      || !Number.isSafeInteger(proof.mainPid) || proof.mainPid <= 0
      || !Number.isSafeInteger(proof.nRestarts) || proof.nRestarts < 0) return false
    acceptedUnits.push(proof.unit)
  }
  if (new Set(acceptedUnits).size !== acceptedUnits.length
    || JSON.stringify([...acceptedUnits].sort()) !== JSON.stringify(activeUnits)) return false
  return true
}

function validArchivedProfile(archive, manifest) {
  if (!exactKeys(archive, ['relativePath', 'identity', 'profileDigest', 'treeDigest'])) return false
  const parts = typeof archive.relativePath === 'string' ? archive.relativePath.split('/') : []
  return parts.length === 2 && parts[0] === 'uninstalled-profiles'
    && parts[1].startsWith(`${manifest.profile}-`) && parts[1].endsWith(`-${manifest.id}`)
    && archive.identity !== null && typeof archive.identity === 'object'
    && exactKeys(archive.identity, ['dev', 'ino', 'uid', 'mode'])
    && typeof archive.identity.dev === 'string' && typeof archive.identity.ino === 'string'
    && archive.identity.uid === currentUid() && typeof archive.identity.mode === 'number'
    && archive.profileDigest === manifest.originalProfileDigest && validDigest(archive.treeDigest)
    && archive.treeDigest === manifest.originalProfileTreeDigest
}

function validV3OperationShape(manifest) {
  if (manifest.version !== SUPERVISED_SERVICE_MANIFEST_VERSION) return true
  const uninstall = manifest.operation === 'uninstall'
  if (!['upgrade', 'uninstall'].includes(manifest.operation)
    || manifest.expectedScenario !== 'supervised'
    || manifest.stagedScenario !== (uninstall ? 'unsupported' : 'supervised')
    || !validSupervisedLifecycle(manifest.supervisedLifecycle, manifest.operation)
    || !validSupervisedManifestPhase(manifest) || !validV3ServiceAcceptance(manifest)) return false
  const cleanPhase = ['clean-target-validated', 'clean-target-pending', 'clean-target-accepted']
    .includes(manifest.supervisedLifecycle.phase)
  if (!uninstall) return manifest.archivedProfile === undefined && manifest.cleanProfileDigest === undefined
    && manifest.originalProfileTreeDigest === undefined
  const sourceBound = manifest.supervisedLifecycle.phase !== 'source-pending'
  if (sourceBound !== validDigest(manifest.originalProfileTreeDigest)) return false
  return cleanPhase
    ? validDigest(manifest.cleanProfileDigest) && validArchivedProfile(manifest.archivedProfile, manifest)
    : manifest.cleanProfileDigest === undefined && manifest.archivedProfile === undefined
}

function validServiceCleanup(cleanup, manifest) {
  const serviceStateValid = !isServiceManifestVersion(manifest.version) || (
    ['starting', 'service-failed'].includes(manifest.servicePhase)
      || manifest.servicePhase === 'service-accepted' && validServiceAcceptanceRecords(manifest)
  )
  return exactKeys(cleanup, ['protocol', 'phase', 'tombstoneName', 'identity'])
    && cleanup.protocol === SERVICE_CLEANUP_PROTOCOL
    && ['prepared', 'tombstoned', 'deleting', 'metadata-only'].includes(cleanup.phase)
    && cleanup.tombstoneName === 'cleanup-original-home'
    && cleanup.identity !== null && typeof cleanup.identity === 'object'
    && exactKeys(cleanup.identity, ['dev', 'ino', 'uid', 'mode'])
    && typeof cleanup.identity.dev === 'string' && typeof cleanup.identity.ino === 'string'
    && cleanup.identity.uid === currentUid() && typeof cleanup.identity.mode === 'number'
    && manifest.state === 'cleanup-started' && serviceStateValid
}

function validBoundMask(mask, expectedUnit, expectedTransactionRoot) {
  const expectedPath = join(process.env.HOME ?? '', '.config', 'systemd', 'user.control', expectedUnit ?? '')
  return mask !== null && typeof mask === 'object'
    && typeof mask.unit === 'string' && SYSTEMD_UNIT.test(mask.unit) && mask.unit === expectedUnit
    && mask.path === expectedPath && mask.target === '/dev/null'
    && mask.transactionRoot === expectedTransactionRoot && typeof mask.stagingPath === 'string'
    && inside(mask.transactionRoot, mask.stagingPath)
    && mask.identity !== null && typeof mask.identity === 'object'
    && typeof mask.identity.dev === 'string' && typeof mask.identity.ino === 'string'
    && mask.identity.uid === currentUid() && typeof mask.identity.mode === 'number'
    && (mask.guardianRuntimeMask === undefined || mask.guardianRuntimeMask === true)
}

function validMaskIntent(intent, expectedTransactionRoot) {
  return intent !== null && typeof intent === 'object'
    && typeof intent.unit === 'string' && SYSTEMD_UNIT.test(intent.unit)
    && intent.path === serviceMaskPath(intent.unit) && intent.target === '/dev/null'
    && intent.transactionRoot === expectedTransactionRoot && typeof intent.stagingPath === 'string'
    && inside(expectedTransactionRoot, intent.stagingPath)
    && intent.barrier !== null && typeof intent.barrier === 'object'
    && intent.barrier.unit === intent.unit && validBoundEnablement(intent.barrier, expectedTransactionRoot)
    && (intent.guardianRuntimeMask === undefined || intent.guardianRuntimeMask === true)
}

function validBoundEnablement(barrier, expectedTransactionRoot) {
  if (barrier.originalUnitFileState === 'disabled') return barrier.enablement === undefined
  const link = barrier.enablement
  const expectedPath = join(process.env.HOME ?? '', '.config', 'systemd', 'user', 'default.target.wants', barrier.unit)
  return link !== null && typeof link === 'object' && link.path === expectedPath
    && link.transactionRoot === expectedTransactionRoot && typeof link.stagingPath === 'string'
    && inside(expectedTransactionRoot, link.stagingPath) && typeof link.target === 'string'
    && link.identity !== null && typeof link.identity === 'object'
    && typeof link.identity.dev === 'string' && typeof link.identity.ino === 'string'
    && link.identity.uid === currentUid() && typeof link.identity.mode === 'number'
}

function diagnosticPath(transactionRoot, profile) {
  const stamp = new Date().toISOString().replaceAll(/[-:.]/gu, '').replace('Z', 'Z')
  return `${transactionRoot}.failed-${profile}-${stamp}-${process.pid}`
}

async function moveTransactionAside(physicalTransactionRoot, transactionPath, profile) {
  const target = diagnosticPath(transactionPath, profile)
  await rename(physicalTransactionRoot, anchoredSibling(target))
  return target
}

function assertLockParentStable(homePath) {
  assertAncestorChainStable(homePath)
  const parentPath = dirname(homePath)
  let opened
  let linked
  try { opened = fstatSync(3); linked = lstatSync(parentPath) }
  catch { fail('生命周期锁父目录在关键 rename 前无法复核。') }
  assertOwnedPrivateEntry(opened, parentPath, 'directory')
  assertOwnedPrivateEntry(linked, parentPath, 'directory')
  if (opened.dev !== linked.dev || opened.ino !== linked.ino || opened.mode !== linked.mode) {
    fail(`生命周期锁父目录在关键 rename 前身份或权限已变化：${parentPath}`)
  }
}

async function assertCriticalDirectory(path, expected) {
  const actual = await lstat(path).catch(() => undefined)
  if (actual === undefined) fail(`生命周期关键目录不存在：${path}`)
  assertExpectedDirectoryMetadata(actual, expected, path)
  return actual
}

async function assertProfileDigest(home, profile, expected) {
  const pieces = [home, join(home, 'profiles'), join(home, 'profiles', profile)]
  for (const path of pieces) {
    const descriptorMatch = /^\/proc\/self\/fd\/(\d+)$/u.exec(path)
    const entry = descriptorMatch === null ? await lstat(path) : fstatSync(Number(descriptorMatch[1]))
    if (!entry.isDirectory() || descriptorMatch === null && entry.isSymbolicLink()
      || entry.uid !== currentUid() || isGroupOrOtherWritable(entry)) {
      fail('生命周期事务中的 profile 路径身份不安全；拒绝自动恢复。')
    }
  }
  const path = join(home, 'profiles', profile, 'package.json')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const entry = fstatSync(descriptor)
    if (!entry.isFile() || entry.uid !== currentUid() || isGroupOrOtherWritable(entry)
      || entry.nlink !== 1 || entry.size > 4 * 1024 * 1024) {
      fail('生命周期事务中的 profile manifest 身份不安全；拒绝自动恢复。')
    }
    const source = await readFile(`/proc/self/fd/${descriptor}`)
    if (sha256(source) !== expected) fail('生命周期事务中的原 profile manifest 摘要不匹配；拒绝自动恢复。')
  } finally { closeSync(descriptor) }
}

async function profileTreeDigest(profilePath) {
  const records = []
  let count = 0
  const visit = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    for (const entry of entries) {
      count += 1
      if (count > PROFILE_TREE_MAX_ENTRIES) fail('profile tree 超过可验证条目上限。')
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const path = join(directory, entry.name)
      const linked = await lstat(path)
      if (entry.isDirectory()) {
        assertOwnedPrivateEntry(linked, path, 'directory')
        records.push(['directory', relative, linked.mode])
        await visit(path, relative)
      } else if (entry.isFile()) {
        assertOwnedPrivateEntry(linked, path, 'file')
        const packageEntry = relative.split('/').includes('node_modules')
        if (!packageEntry && linked.nlink !== 1 || linked.size > PROFILE_TREE_MAX_FILE_BYTES) {
          fail(`profile tree 文件身份或大小不安全：${relative}`)
        }
        const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const opened = fstatSync(descriptor)
          if (!sameRegularFileIdentity(opened, identity(linked), packageEntry)) {
            fail(`profile tree 文件在读取前发生变化：${relative}`)
          }
          const contents = await readFile(`/proc/self/fd/${descriptor}`)
          if (!sameRegularFileIdentity(await lstat(path), identity(opened), packageEntry)) {
            fail(`profile tree 文件在读取后发生变化：${relative}`)
          }
          records.push(['file', relative, opened.mode, opened.size, sha256(contents)])
        } finally { closeSync(descriptor) }
      } else if (entry.isSymbolicLink()) {
        if (linked.uid !== currentUid() || linked.nlink !== 1) fail(`profile tree symlink 身份不安全：${relative}`)
        records.push(['symlink', relative, linked.mode, await readlink(path)])
      } else fail(`profile tree 含不支持的特殊文件：${relative}`)
    }
  }
  await visit(profilePath)
  return sha256(canonicalJson(records))
}

async function assertArchivedProfile(homePath, manifest) {
  if (!validArchivedProfile(manifest.archivedProfile, manifest)) fail('supervised uninstall 缺少有效的归档绑定。')
  const archivePath = join(homePath, manifest.archivedProfile.relativePath)
  const entry = await assertCriticalDirectory(archivePath, manifest.archivedProfile.identity)
  if (String(entry.dev) !== manifest.archivedProfile.identity.dev || String(entry.ino) !== manifest.archivedProfile.identity.ino
    || await profileTreeDigest(archivePath) !== manifest.archivedProfile.treeDigest) {
    fail(`supervised uninstall 归档内容或身份发生变化：${archivePath}`)
  }
}

async function moveBoundDirectoryNoReplace(source, destination, expectedIdentity, guard) {
  const helper = [
    'import ctypes, os, re, stat, sys',
    'source, destination, expected_dev, expected_ino, expected_uid, guard_path, guard_dev, guard_ino = sys.argv[1:]',
    'source_parent, source_name = os.path.split(source)',
    'destination_parent, destination_name = os.path.split(destination)',
    'def open_parent(path):',
    '  match = re.fullmatch(r"/proc/self/fd/(\\d+)", path)',
    '  return os.dup(int(match.group(1))) if match else os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'source_fd = open_parent(source_parent)',
    'destination_fd = open_parent(destination_parent)',
    'guard_fd = None',
    'try:',
    '  if guard_path:',
    '    guard_fd = os.open(guard_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    '    guard_entry = os.fstat(guard_fd)',
    '    if (guard_entry.st_dev, guard_entry.st_ino) != (int(guard_dev), int(guard_ino)): raise RuntimeError("guard identity changed")',
    '  entry = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)',
    '  if not stat.S_ISDIR(entry.st_mode) or (entry.st_dev, entry.st_ino) != (int(expected_dev), int(expected_ino)) or (expected_uid and entry.st_uid != int(expected_uid)): raise RuntimeError("source identity changed")',
    '  libc = ctypes.CDLL(None, use_errno=True)',
    '  renameat2 = getattr(libc, "renameat2", None)',
    '  if renameat2 is None: raise RuntimeError("renameat2 unavailable")',
    '  if renameat2(source_fd, source_name.encode(), destination_fd, destination_name.encode(), 1) != 0: raise RuntimeError("renameat2 noreplace errno=%d" % ctypes.get_errno())',
    '  moved = os.stat(destination_name, dir_fd=destination_fd, follow_symlinks=False)',
    '  if (moved.st_dev, moved.st_ino) != (int(expected_dev), int(expected_ino)) or (expected_uid and moved.st_uid != int(expected_uid)): raise RuntimeError("destination identity changed")',
    '  os.fsync(destination_fd)',
    '  if source_fd != destination_fd: os.fsync(source_fd)',
    'finally:',
    '  if guard_fd is not None: os.close(guard_fd)',
    '  os.close(source_fd)',
    '  if destination_fd != source_fd: os.close(destination_fd)',
  ].join('\n')
  try {
    await run('/usr/bin/python3', ['-I', '-S', '-c', helper, source, destination,
      String(expectedIdentity.dev), String(expectedIdentity.ino), String(expectedIdentity.uid ?? currentUid()),
      guard?.path ?? '', String(guard?.identity?.dev ?? ''), String(guard?.identity?.ino ?? '')], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, capture: true, timeoutMs: 30_000, passFds: [3],
    })
  } catch (error) {
    fail(`无法无覆盖地移动绑定目录 ${source} -> ${destination}：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function recoverBoundTransaction({
  homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, serviceContext, dshExecutable,
}) {
  assertAncestorChainStable(homePath)
  const transactionStat = await existingIdentity(physicalTransactionRoot)
  if (transactionStat === undefined) return undefined
  if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()
    || transactionStat.uid !== currentUid() || (transactionStat.mode & 0o077) !== 0) {
    fail(`拒绝未绑定或未知的生命周期事务目录：${transactionRoot}`)
  }
  const transactionEntries = await readdir(physicalTransactionRoot)
  if (!transactionEntries.includes('manifest.json')) {
    if (transactionEntries.length !== 0) {
      fail(`拒绝未绑定或未知的生命周期事务；缺少有效 manifest：${transactionRoot}`)
    }
    await assertNoMounts(physicalTransactionRoot)
    assertLockParentStable(homePath)
    const transactionBeforeRemove = await lstat(physicalTransactionRoot)
    if (!sameIdentity(transactionBeforeRemove, identity(transactionStat))) {
      fail(`空生命周期事务目录在删除前发生替换：${transactionRoot}`)
    }
    await rmdir(physicalTransactionRoot)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`生命周期恢复：已删除上次清理遗留的安全空事务目录：${transactionRoot}\n`)
    return 'empty-cleaned'
  }
  let manifest
  manifest = await loadManifest(physicalTransactionRoot, { homePath, profile, transactionPath: transactionRoot })
  if (serviceContext !== undefined && !isServiceManifestVersion(manifest.version)) {
    fail(`检测到旧版 stopped-home lifecycle residue；无法在受管 service 运行状态未知时安全恢复，拒绝修改 DSH_HOME：${transactionRoot}`)
  }
  const backupHome = join(physicalTransactionRoot, 'original-home')
  const failedHome = join(physicalTransactionRoot, 'failed-home')
  const homeStat = await existingIdentity(physicalHomePath)
  const backupStat = await existingIdentity(backupHome)
  const homeIsOriginal = homeStat !== undefined && sameIdentity(homeStat, manifest.originalIdentity)
  const homeIsStaged = homeStat !== undefined && sameIdentity(homeStat, manifest.stagedIdentity)
  const backupIsOriginal = backupStat !== undefined && sameIdentity(backupStat, manifest.originalIdentity)
  if (isServiceManifestVersion(manifest.version)) {
    if (serviceContext === undefined || dshExecutable === undefined) {
      fail(`service-aware 生命周期恢复需要以原 Lark lifecycle 命令持锁执行；保留证据：${transactionRoot}`)
    }
    const scenarioHome = homeIsOriginal || homeIsStaged ? homePath
      : backupIsOriginal ? join(transactionRoot, 'original-home') : undefined
    if (scenarioHome === undefined) {
      fail(`service-aware 生命周期恢复无法绑定可验证的配置副本；保留证据：${transactionRoot}`)
    }
    await assertLockedLifecycleScenario({
      dshExecutable, profile, homePath: scenarioHome,
      expectedScenario: homeIsStaged ? manifest.stagedScenario ?? manifest.expectedScenario : manifest.expectedScenario,
      serviceAware: true, operation: manifest.operation,
    })
    if (manifest.servicePhase === 'initializing') {
      if (!homeIsOriginal || backupStat !== undefined) {
        fail(`service-aware initializing residue 身份未知；拒绝清理：${transactionRoot}`)
      }
      const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
      await fsyncPath(LOCK_PARENT_FD_PATH, true)
      process.stderr.write(`service-aware 生命周期恢复：初始化未修改 service/home；证据保留在 ${evidence}\n`)
      return 'service-original-restored'
    }
    return recoverServiceTransaction({
      manifest, homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, backupHome,
      homeStat, backupStat, homeIsOriginal, homeIsStaged, backupIsOriginal, serviceContext, dshExecutable,
    })
  }
  const scenarioHome = homeIsOriginal || homeIsStaged ? homePath
    : backupIsOriginal ? join(transactionRoot, 'original-home') : undefined
  if (scenarioHome !== undefined) {
    const recoveryScenario = homeIsStaged && manifest.operation === 'uninstall'
      ? manifest.stagedScenario ?? 'unsupported'
      : manifest.expectedScenario
    await assertLockedLifecycleScenario({
      dshExecutable, profile, homePath: scenarioHome,
      expectedScenario: recoveryScenario,
      serviceAware: false,
    })
  }

  if (!isServiceManifestVersion(manifest.version)
    && (manifest.state === 'committed' || manifest.state === 'cleanup-started')) {
    if (!homeIsStaged || (backupStat !== undefined && !backupIsOriginal)) {
      fail(`已提交事务的 home/backup 身份不匹配；拒绝清理：${transactionRoot}`)
    }
    await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
    if (manifest.state === 'committed') {
      if (!backupIsOriginal) fail(`已提交事务缺少完整且绑定的原始备份；拒绝开始清理：${transactionRoot}`)
      await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
      manifest = await writeManifest(physicalTransactionRoot, manifest, 'cleanup-started')
    }
    await removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome })
    process.stdout.write('profile 生命周期恢复：已完成上次提交后的绑定清理。\n')
    return 'committed'
  }

  if (homeIsOriginal && backupStat === undefined) {
    await assertProfileDigest(physicalHomePath, profile, manifest.originalProfileDigest)
    await assertCriticalDirectory(physicalHomePath, manifest.originalIdentity)
    assertLockParentStable(homePath)
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    assertLockParentStable(homePath)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`profile 生命周期恢复：原 DSH_HOME 未修改；旧事务证据保留在 ${evidence}\n`)
    return 'original-intact'
  }

  if (homeStat === undefined && backupIsOriginal) {
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    await assertCriticalDirectory(backupHome, manifest.originalIdentity)
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在恢复 rename 前重新出现；拒绝覆盖。')
    await moveBoundDirectoryNoReplace(backupHome, physicalHomePath, manifest.originalIdentity)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    assertLockParentStable(homePath)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`profile 生命周期恢复：已恢复原 DSH_HOME；失败事务证据保留在 ${evidence}\n`)
    return 'restored'
  }

  if (homeIsStaged && backupIsOriginal) {
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    if (await existingIdentity(failedHome) !== undefined) fail(`事务失败副本路径已存在；拒绝覆盖：${failedHome}`)
    await assertCriticalDirectory(physicalHomePath, manifest.stagedIdentity)
    await assertCriticalDirectory(backupHome, manifest.originalIdentity)
    assertLockParentStable(homePath)
    await moveBoundDirectoryNoReplace(physicalHomePath, failedHome, manifest.stagedIdentity)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    await assertCriticalDirectory(backupHome, manifest.originalIdentity)
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在恢复 rename 前重新出现；拒绝覆盖。')
    await moveBoundDirectoryNoReplace(backupHome, physicalHomePath, manifest.originalIdentity)
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    assertLockParentStable(homePath)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`profile 生命周期恢复：原 DSH_HOME 已恢复；失败副本保留在 ${evidence}\n`)
    return 'restored'
  }

  fail(`生命周期事务 home/backup 身份未知；拒绝重命名或删除任何目录：${transactionRoot}`)
}

function run(executable, args, { env = process.env, capture = false, passFds = [], timeoutMs } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      env,
      stdio: capture
        ? ['ignore', 'pipe', 'pipe', ...passFds]
        : passFds.length === 0 ? 'inherit' : ['inherit', 'inherit', 'inherit', ...passFds],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timeout?.unref()
    if (capture) {
      child.stdout.on('data', chunk => {
        if (stdout.length < 16 * 1024 * 1024) stdout += String(chunk)
      })
      child.stderr.on('data', chunk => {
        if (stderr.length < 4 * 1024 * 1024) stderr += String(chunk)
      })
    }
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (timeout !== undefined) clearTimeout(timeout)
      if (code === 0) resolveRun({ stdout, stderr })
      else rejectRun(new LifecycleError(
        timedOut
          ? `${basename(executable)} timed out after ${timeoutMs}ms`
          : `${basename(executable)} failed${signal === null ? ` with exit ${code ?? 1}` : ` from signal ${signal}`}${stderr === '' ? '' : `: ${stderr.trim()}`}`,
        code ?? 1,
      ))
    })
  })
}

function serviceCommandEnvironment() {
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }),
    ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
  }
}

async function runServiceCommand(executable, args) {
  return await run(executable, args, { env: serviceCommandEnvironment(), capture: true, timeoutMs: 30_000 })
}

async function withCrashStopGuardian(
  systemctlExecutable, units, completionToken, operation, startUnits = true, containmentHome, knownUniverse = units,
) {
  const source = String.raw`
const { spawnSync } = require('node:child_process')
const { realpathSync } = require('node:fs')
const { isAbsolute, sep } = require('node:path')
const [systemctl, completionToken, startFlag, containmentHome, startCountSource, ...allUnits] = process.argv.slice(1)
const startCount = Number(startCountSource)
const units = allUnits.slice(0, startCount)
const knownUniverse = allUnits.slice(startCount)
const unitPattern = /^dsh-profile-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.service$/u
const knownUnits = [...new Set([...units, ...knownUniverse])]
let input = ''
let parentDisconnected = false
let containmentPromise
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
const command = args => spawnSync(systemctl, args, { encoding: 'utf8', timeout: 30000 })
const successful = result => result.error === undefined && result.status === 0
const lines = source => {
  if (source === '') return []
  const values = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
  return values.length === 1 && values[0] === '' ? [] : values
}
const parseUnitList = (result, minimumColumns) => {
  if (!successful(result)) return undefined
  const parsed = []
  for (const line of lines(result.stdout)) {
    const normalized = line.trim()
    if (normalized === '') return undefined
    const fields = normalized.split(/\s+/u)
    if (fields.length < minimumColumns || !unitPattern.test(fields[0])) return undefined
    parsed.push(fields[0])
  }
  return new Set(parsed).size === parsed.length ? parsed : undefined
}
const parseProperties = (result, required) => {
  if (!successful(result)) return undefined
  const values = {}
  for (const line of lines(result.stdout)) {
    const index = line.indexOf('=')
    const key = index <= 0 ? '' : line.slice(0, index)
    if (!required.includes(key) || Object.hasOwn(values, key)) return undefined
    values[key] = line.slice(index + 1)
  }
  return required.every(key => Object.hasOwn(values, key)) ? values : undefined
}
const parseEnvironment = source => {
  const words = []
  let word = ''
  let quote = ''
  let active = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      const next = source[index + 1]
      if (next === undefined) return undefined
      if (next === 'x' && /^[0-9A-Fa-f]{2}$/u.test(source.slice(index + 2, index + 4))) {
        word += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 4), 16))
        index += 3
      } else {
        word += next
        index += 1
      }
      active = true
    } else if (quote !== '') {
      if (character === quote) quote = ''
      else word += character
      active = true
    } else if (character === '"' || character === "'") {
      quote = character
      active = true
    } else if (/\s/u.test(character)) {
      if (active) { words.push(word); word = ''; active = false }
    } else {
      word += character
      active = true
    }
  }
  if (quote !== '') return undefined
  if (active) words.push(word)
  return words.every(value => /^[^=]+=/u.test(value)) ? words : undefined
}
const canonical = value => {
  try { return realpathSync(value) } catch { return undefined }
}
const ownership = (unit) => {
  const result = command([
    '--user', 'show', unit, '--no-pager', '--property=Id', '--property=LoadState',
    '--property=Environment', '--property=WorkingDirectory',
  ])
  const values = parseProperties(result, ['Id', 'LoadState', 'Environment', 'WorkingDirectory'])
  if (values === undefined || values.Id !== unit || values.LoadState === '') return undefined
  const environment = parseEnvironment(values.Environment)
  if (environment === undefined) return undefined
  const configuredHomes = environment
    .filter(value => value.startsWith('DSH_HOME='))
    .map(value => value.slice('DSH_HOME='.length))
  if (configuredHomes.length !== 1 || !isAbsolute(configuredHomes[0])) return undefined
  const canonicalHome = configuredHomes.length === 1 && isAbsolute(configuredHomes[0])
    ? canonical(configuredHomes[0]) : undefined
  const working = values.WorkingDirectory
  if (working === '' || !isAbsolute(working)) return undefined
  const canonicalWorking = canonical(working)
  if (canonicalHome === undefined || canonicalWorking === undefined) return undefined
  const homeMatches = canonicalHome === containmentHome
  const workingMatches = canonicalWorking === containmentHome || canonicalWorking.startsWith(containmentHome + sep)
  if (homeMatches && workingMatches) return 'same-home'
  if (!homeMatches && !workingMatches) return 'foreign'
  return undefined
}
const state = unit => parseProperties(command([
  '--user', 'show', unit, '--no-pager', '--property=Id', '--property=ActiveState',
  '--property=SubState', '--property=MainPID', '--property=ControlPID',
] ), ['Id', 'ActiveState', 'SubState', 'MainPID', 'ControlPID'])
const inactive = (unit, values) => values !== undefined && values.Id === unit
  && values.ActiveState === 'inactive' && values.SubState === 'dead'
  && values.MainPID === '0' && values.ControlPID === '0'
const stop = targets => targets.length === 0 || successful(command(['--user', 'stop', ...targets]))
const blockStarts = targets => targets.length === 0 || (
  successful(command(['--user', 'disable', ...targets]))
  && successful(command(['--user', 'mask', '--runtime', ...targets]))
)
const verify = targets => targets.every(unit => inactive(unit, state(unit)))
const stopKnownUntilVerified = async () => {
  for (;;) {
    stop(knownUnits)
    if (verify(knownUnits)) return
    await sleep(1000)
  }
}
const stopAndVerify = async () => {
  stop(knownUnits)
  verify(knownUnits)
  let previousCensus
  let stableCensuses = 0
  for (;;) {
    const unitFiles = parseUnitList(command([
      '--user', 'list-unit-files', '--type=service', '--no-legend', '--no-pager', 'dsh-profile-*.service',
    ]), 2)
    const loadedUnits = parseUnitList(command([
      '--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager', 'dsh-profile-*.service',
    ]), 4)
    if (unitFiles === undefined || loadedUnits === undefined) {
      stableCensuses = 0
      previousCensus = undefined
      stop(knownUnits)
      verify(knownUnits)
      await sleep(1000)
      continue
    }
    const census = [...new Set([...unitFiles, ...loadedUnits])].sort()
    const classifications = []
    let complete = true
    for (const unit of census) {
      if (knownUnits.includes(unit)) {
        classifications.push([unit, 'known'])
        continue
      }
      const classification = containmentHome === '-' ? 'foreign' : ownership(unit)
      if (classification === undefined) { complete = false; break }
      classifications.push([unit, classification])
    }
    if (!complete) {
      stableCensuses = 0
      previousCensus = undefined
      stop(knownUnits)
      verify(knownUnits)
      await sleep(1000)
      continue
    }
    const targets = [...new Set([
      ...knownUnits,
      ...classifications.filter(([, classification]) => classification === 'same-home').map(([unit]) => unit),
    ])].sort()
    const dynamicTargets = targets.filter(unit => !knownUnits.includes(unit))
    if (!blockStarts(dynamicTargets)) {
      stableCensuses = 0
      previousCensus = undefined
      stop(targets)
      verify(targets)
      await sleep(1000)
      continue
    }
    stop(targets)
    const quiescent = verify(targets)
    if (!quiescent) {
      stableCensuses = 0
      previousCensus = undefined
      await sleep(1000)
      continue
    }
    const signature = JSON.stringify(classifications)
    stableCensuses = signature === previousCensus ? stableCensuses + 1 : 1
    previousCensus = signature
    if (stableCensuses >= 2) return 1
    await sleep(1000)
  }
}
const beginContainment = () => {
  parentDisconnected = true
  if (containmentPromise === undefined) {
    containmentPromise = (async () => {
      for (;;) {
        try {
          const status = await stopAndVerify()
          process.exit(status || 1)
        } catch {}
        await sleep(1000)
      }
    })()
  }
}
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, beginContainment)
process.stdin.on('end', () => {
  if (input === completionToken + '\n' && !parentDisconnected) process.exit(0)
  else beginContainment()
})
process.stdin.on('error', beginContainment)
process.stdout.on('error', beginContainment)
;(async () => {
  const startStatus = startFlag === '1' && units.length > 0
    ? command(['--user', 'start', ...units]).status ?? 1
    : 0
  if (startStatus !== 0) {
    await stopKnownUntilVerified()
    process.stdout.write('STARTED ' + startStatus + ' 0\n')
    beginContainment()
    return
  }
  if (parentDisconnected) { beginContainment(); return }
  process.stdout.write('STARTED 0 0\n', error => { if (error) beginContainment() })
})().catch(beginContainment)
`
  const guardian = spawn(process.execPath, [
    '-e', source, systemctlExecutable, completionToken, startUnits ? '1' : '0', containmentHome ?? '-',
    String(units.length), ...units, ...knownUniverse,
  ], {
    // Keep the parent directory plus both kernel lock descriptions alive if
    // the lifecycle process dies. The detached guardian must continue to
    // exclude recovery and setup until containment is conclusively finished.
    detached: true, env: serviceCommandEnvironment(), stdio: ['pipe', 'pipe', 'inherit', 3, 4, 5],
  })
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    guardian.once('error', rejectCompletion)
    guardian.once('close', (code, signal) => {
      if (code === 0) resolveCompletion()
      else rejectCompletion(new LifecycleError(`service crash guardian failed${signal === null ? ` with exit ${code ?? 1}` : ` from signal ${signal}`}`))
    })
  })
  try {
    await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new LifecycleError('service crash guardian 未就绪。')), 35_000)
      timeout.unref()
      guardian.stdout.once('data', chunk => {
        clearTimeout(timeout)
        const match = /^STARTED (\d+) (\d+)\n/u.exec(String(chunk))
        if (match?.[1] === '0' && match[2] === '0') resolveReady()
        else rejectReady(new LifecycleError(`service crash guardian 启动/收容失败：start=${match?.[1] ?? 'invalid'} containment=${match?.[2] ?? 'invalid'}`))
      })
      guardian.once('error', rejectReady)
    })
  } catch (error) {
    guardian.stdin.end()
    await completion.catch(() => {})
    throw error
  }
  try {
    const result = await operation()
    guardian.stdin.end(`${completionToken}\n`)
    await completion
    return result
  } catch (error) {
    guardian.stdin.end()
    await completion.catch(() => {})
    throw error
  }
}

async function trustedServiceExecutable(path, name) {
  const canonical = await realpath(path).catch(() => fail(`${name} executable must exist`))
  const entry = await lstat(canonical)
  if (!entry.isFile() || entry.isSymbolicLink() || isGroupOrOtherWritable(entry)
    || entry.uid !== 0 || !['/usr/bin', '/bin'].includes(dirname(canonical))) {
    fail(`${name} executable 的 owner、权限或系统路径不可信：${canonical}`)
  }
  return canonical
}

async function trustedSystemExecutable(path, name) {
  const canonical = await realpath(path).catch(() => fail(`${name} executable must exist`))
  const entry = await lstat(canonical)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== 0 || isGroupOrOtherWritable(entry)
    || !['/usr/bin', '/bin'].includes(dirname(canonical))) {
    fail(`${name} executable 的 owner、权限或系统路径不可信：${canonical}`)
  }
  return canonical
}

function parseBoundedInteger(name, rawValue, defaultValue, maximum) {
  const raw = rawValue ?? String(defaultValue)
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) fail(`${name} 必须是 0..${maximum} 的整数。`, 2)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > maximum) fail(`${name} 必须是 0..${maximum} 的整数。`, 2)
  return value
}

function parseBoundedMilliseconds(name, defaultValue, maximum) {
  return parseBoundedInteger(name, process.env[name], defaultValue, maximum)
}

function serviceTimeouts() {
  return {
    stop: parseBoundedMilliseconds('DSH_ENHANCED_SERVICE_STOP_TIMEOUT_MS', 30_000, 300_000),
    ready: parseBoundedMilliseconds('DSH_ENHANCED_SERVICE_READY_TIMEOUT_MS', 30_000, 300_000),
    stability: parseBoundedMilliseconds('DSH_ENHANCED_SERVICE_STABILITY_MS', 12_000, 60_000),
    // 稳定性窗口内要求连续通过的样本数；两点（接受点 + 窗口末点）采样抓不住
    // connected→disconnected→connected 这类末点状态复原的窗口内抖动。
    stabilitySamples: parseBoundedInteger(
      'DSH_ENHANCED_SERVICE_STABILITY_SAMPLES', process.env.DSH_ENHANCED_SERVICE_STABILITY_SAMPLES, 4, 16),
  }
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, Math.max(1, milliseconds))))
}

function parseSystemdShowProperties(source, unit, properties) {
  const values = new Map()
  for (const line of source.trimEnd().split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) fail(`systemctl show 返回无法解析的字段：${unit}`)
    const key = line.slice(0, separator)
    if (!properties.includes(key) || values.has(key)) fail(`systemctl show 返回重复或未知字段：${unit}:${key}`)
    values.set(key, line.slice(separator + 1))
  }
  for (const property of properties) if (!values.has(property)) fail(`systemctl show 缺少字段：${unit}:${property}`)
  return Object.fromEntries(values)
}

function parseSystemdShow(source, unit) {
  return parseSystemdShowProperties(source, unit, SYSTEMD_SHOW_PROPERTIES)
}

function parseSystemdEnvironment(source, unit) {
  const values = []
  let value = ''
  let quote = ''
  let active = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      const next = source[index + 1]
      if (next === undefined) fail(`systemd unit Environment 转义不完整：${unit}`)
      if (next === 'x' && /^[0-9A-Fa-f]{2}$/u.test(source.slice(index + 2, index + 4))) {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 4), 16))
        index += 3
      } else {
        value += next
        index += 1
      }
      active = true
    } else if (quote !== '') {
      if (character === quote) quote = ''
      else value += character
      active = true
    } else if (character === '"' || character === "'") {
      quote = character
      active = true
    } else if (/\s/u.test(character)) {
      if (active) { values.push(value); value = ''; active = false }
    } else {
      value += character
      active = true
    }
  }
  if (quote !== '') fail(`systemd unit Environment 引号不完整：${unit}`)
  if (active) values.push(value)
  if (values.some(entry => !/^[^=]+=/u.test(entry))) fail(`systemd unit Environment 无法安全解析：${unit}`)
  return values
}

async function classifyServiceUnitOwnership(systemctlExecutable, unit, homePath) {
  if (!SYSTEMD_UNIT.test(unit)) fail(`非法 DSH systemd unit：${unit}`)
  const shown = parseSystemdShowProperties((await runServiceCommand(systemctlExecutable, [
    '--user', 'show', unit, '--no-pager', ...SYSTEMD_OWNERSHIP_PROPERTIES.map(property => `--property=${property}`),
  ])).stdout, unit, SYSTEMD_OWNERSHIP_PROPERTIES)
  if (shown.Id !== unit || shown.LoadState !== 'loaded') fail(`systemd unit ownership 无法证明：${unit}`)
  const homes = parseSystemdEnvironment(shown.Environment, unit)
    .filter(value => value.startsWith('DSH_HOME='))
    .map(value => value.slice('DSH_HOME='.length))
  if (homes.length !== 1 || !isAbsolute(homes[0]) || !isAbsolute(shown.WorkingDirectory)) {
    fail(`systemd unit ownership 含缺失、重复或非绝对路径证据：${unit}`)
  }
  const serviceHome = await canonicalMissingAllowed(homes[0])
  const workingDirectory = await canonicalMissingAllowed(shown.WorkingDirectory)
  const homeMatches = serviceHome === homePath
  const workingMatches = inside(homePath, workingDirectory)
  if (homeMatches && workingMatches) {
    return { classification: 'same-home', digest: sha256(JSON.stringify(shown)) }
  }
  if (!homeMatches && !workingMatches && !inside(homePath, serviceHome)) {
    return { classification: 'foreign', digest: sha256(JSON.stringify(shown)) }
  }
  fail(`systemd unit ownership 的 HOME/WorkingDirectory 证据冲突或嵌套：${unit}`)
}

function decodeUnitQuoted(value, label) {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') { output += value[index]; continue }
    index += 1
    if (index >= value.length || !['\\', '"'].includes(value[index])) fail(`systemd unit ${label} 包含 renderer 不会生成的转义。`)
    output += value[index]
  }
  return output.replaceAll('%%', '%')
}

function rendererUnitPattern(profile) {
  const escapedProfile = profile.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(
    '^\\[Unit\\]\\nDescription=DeepSeek Harness profile ' + escapedProfile
    + '\\nAfter=network-online\\.target\\nWants=network-online\\.target\\nStartLimitIntervalSec=0\\n\\n'
    + '\\[Service\\]\\nType=simple\\nWorkingDirectory=([^\\r\\n]+)\\n'
    + 'Environment="((?:\\\\.|[^"])*)"\\nEnvironment="((?:\\\\.|[^"])*)"\\n'
    + 'Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"\\nEnvironment="XDG_RUNTIME_DIR=%t"\\n'
    + 'ExecStart="((?:\\\\.|[^"])*)" --disable-warning=ExperimentalWarning "((?:\\\\.|[^"])*)" --profile '
    + escapedProfile + ' --no-open\\n'
    + '# A deliberate systemctl user stop remains stopped, while every process\\n'
    + '# exit \\(including a clean but unintended Host exit\\) is restarted\\.  Disabling\\n'
    + "# systemd's start-rate limiter keeps a long-lived personal assistant from\\n"
    + '# becoming permanently inactive after a transient dependency outage\\.\\n'
    + 'Restart=always\\nRestartSec=5\\nTimeoutStopSec=30\\nKillSignal=SIGINT\\nUMask=0077\\n\\n'
    + '\\[Install\\]\\nWantedBy=default\\.target\\n$', 'u',
  )
}

async function snapshotServiceFile(path, expectedSource) {
  const lexicalParent = await lstat(dirname(path))
  if (!lexicalParent.isDirectory() || lexicalParent.isSymbolicLink() || lexicalParent.uid !== currentUid()
    || isGroupOrOtherWritable(lexicalParent)) fail(`systemd service 目录身份或权限不安全：${dirname(path)}`)
  const canonicalPath = await realpath(path)
  const parentPath = dirname(canonicalPath)
  const ancestorChain = captureAncestorChain(parentPath)
  const parentBefore = await lstat(parentPath)
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() || parentBefore.uid !== currentUid()
    || isGroupOrOtherWritable(parentBefore)) fail(`systemd service 目录身份或权限不安全：${parentPath}`)
  const descriptor = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const entry = fstatSync(descriptor)
    const linked = await lstat(canonicalPath)
    const parentAfter = await lstat(parentPath)
    if (!entry.isFile() || entry.uid !== currentUid() || entry.nlink !== 1 || isGroupOrOtherWritable(entry) || entry.size > 1024 * 1024) {
      fail(`systemd service 文件身份或权限不安全：${path}`)
    }
    if (!sameServiceFileIdentity(linked, identity(entry))
      || !sameIdentity(parentAfter, identity(parentBefore))) fail(`systemd service 文件或目录身份不稳定：${path}`)
    const source = await readFile(`/proc/self/fd/${descriptor}`, 'utf8')
    if (expectedSource !== undefined && source !== expectedSource) fail(`systemd service drop-in 内容不受支持：${path}`)
    return {
      path: canonicalPath, identity: identity(entry), parentPath, parentIdentity: identity(parentBefore),
      ancestorChain, sha256: sha256(source), source,
    }
  } finally { closeSync(descriptor) }
}

async function inspectServiceUnit(systemctlExecutable, unit, dshExecutable) {
  const match = SYSTEMD_UNIT.exec(unit)
  if (match === null) fail(`非法 DSH systemd unit：${unit}`)
  const shown = parseSystemdShow((await runServiceCommand(systemctlExecutable, [
    '--user', 'show', unit, '--no-pager', ...SYSTEMD_SHOW_PROPERTIES.map(property => `--property=${property}`),
  ])).stdout, unit)
  if (shown.Id !== unit || shown.LoadState !== 'loaded' || shown.UnitFileState === '') fail(`systemd unit 未加载或身份不匹配：${unit}`)
  const fragment = await snapshotServiceFile(shown.FragmentPath)
  const expectedUnitDirectory = await canonicalMissingAllowed(join(process.env.HOME ?? '', '.config', 'systemd', 'user'))
  if (fragment.path !== join(expectedUnitDirectory, unit)) fail(`systemd unit fragment 不属于当前用户安装目录：${unit}`)
  const parsed = rendererUnitPattern(match[1]).exec(fragment.source)
  if (parsed === null) fail(`systemd unit 不是 installer renderer 的精确输出：${unit}`)
  const workingDirectory = parsed[1].replaceAll('%%', '%').replace(/\/$/u, '')
  const dshEnvironment = decodeUnitQuoted(parsed[2], 'DSH_HOME')
  const pathEnvironment = decodeUnitQuoted(parsed[3], 'PATH')
  const nodePath = decodeUnitQuoted(parsed[4], 'node path')
  const dshPath = decodeUnitQuoted(parsed[5], 'dsh path')
  if (!dshEnvironment.startsWith('DSH_HOME=') || !pathEnvironment.startsWith('PATH=')
    || !isAbsolute(nodePath) || !isAbsolute(dshPath)) fail(`systemd unit renderer 字段无效：${unit}`)
  if (pathEnvironment.slice('PATH='.length).split(':').some(path => !isAbsolute(path))
    || await realpath(dshPath).catch(() => '') !== dshExecutable
    || await realpath(nodePath).catch(() => '') === '') fail(`systemd unit executable/PATH 与当前运行时不匹配：${unit}`)
  const configuredHome = dshEnvironment.slice('DSH_HOME='.length)
  if (!isAbsolute(configuredHome)) fail(`systemd unit DSH_HOME 必须是绝对路径：${unit}`)
  const serviceHome = await canonicalMissingAllowed(configuredHome)
  const expectedWorkingDirectory = join(serviceHome, 'profiles', match[1])
  if (await canonicalMissingAllowed(workingDirectory) !== expectedWorkingDirectory || shown.WorkingDirectory !== workingDirectory) {
    fail(`systemd unit WorkingDirectory 与 profile 不匹配：${unit}`)
  }
  const shownEnvironment = shown.Environment.split(' ')
  if (shownEnvironment.length !== 4
    || shownEnvironment.filter(value => value.startsWith('DSH_HOME=')).length !== 1
    || shownEnvironment.filter(value => value.startsWith('PATH=')).length !== 1
    || !shownEnvironment.includes(`DSH_HOME=${dshEnvironment.slice('DSH_HOME='.length)}`)
    || !shownEnvironment.includes(pathEnvironment)
    || !shownEnvironment.includes('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/' + currentUid() + '/bus')
    || !shownEnvironment.includes('XDG_RUNTIME_DIR=/run/user/' + currentUid())) {
    fail(`systemd unit Environment 与 fragment 不一致：${unit}`)
  }
  const expectedExecPrefix = `{ path=${nodePath} ; argv[]=${nodePath} --disable-warning=ExperimentalWarning ${dshPath} --profile ${match[1]} --no-open ; ignore_errors=no ;`
  if (!shown.ExecStart.startsWith(expectedExecPrefix) || !shown.ExecStart.endsWith(' }')
    || shown.ExecStart.split('{ path=').length !== 2) {
    fail(`systemd unit ExecStart 与 fragment 不一致：${unit}`)
  }
  const dropIns = []
  for (const path of shown.DropInPaths.split(' ').filter(Boolean)) {
    if (await realpath(path).catch(() => '') !== await realpath(`${shown.FragmentPath}.d/keyring.conf`).catch(() => '__missing__')) {
      fail(`systemd unit 包含未知 drop-in：${unit}:${path}`)
    }
    const snapshot = await snapshotServiceFile(path, KEYRING_DROP_IN)
    dropIns.push({
      path: snapshot.path, identity: snapshot.identity, parentPath: snapshot.parentPath,
      parentIdentity: snapshot.parentIdentity, ancestorChain: snapshot.ancestorChain, sha256: snapshot.sha256,
    })
  }
  const mainPid = Number(shown.MainPID)
  const controlPid = Number(shown.ControlPID)
  const nRestarts = Number(shown.NRestarts)
  if (!Number.isSafeInteger(mainPid) || mainPid < 0 || !Number.isSafeInteger(controlPid) || controlPid < 0
    || !Number.isSafeInteger(nRestarts) || nRestarts < 0) {
    fail(`systemd unit PID/restart 状态无效：${unit}`)
  }
  const stableActive = shown.ActiveState === 'active' && shown.SubState === 'running'
    && mainPid > 0 && controlPid === 0 && shown.InvocationID !== ''
  const stableInactive = shown.ActiveState === 'inactive' && shown.SubState === 'dead' && mainPid === 0 && controlPid === 0
  if (!stableActive && !stableInactive) fail(`systemd unit 不在稳定 active/running 或 inactive/dead 状态：${unit}`)
  if (!['enabled', 'disabled'].includes(shown.UnitFileState)) {
    fail(`systemd unit file state 不受支持：${unit}:${shown.UnitFileState}`)
  }
  return {
    unit, profile: match[1], serviceHome, fragment: {
      path: fragment.path, identity: fragment.identity, parentPath: fragment.parentPath,
      parentIdentity: fragment.parentIdentity, ancestorChain: fragment.ancestorChain, sha256: fragment.sha256,
    },
    dropIns, wasActive: shown.ActiveState === 'active', activeState: shown.ActiveState, subState: shown.SubState,
    mainPid, controlPid, invocationId: shown.InvocationID, nRestarts, unitFileState: shown.UnitFileState, nodePath, dshPath, pathEnvironment,
  }
}

async function readRawServiceState(systemctlExecutable, unit) {
  const shown = parseSystemdShow((await runServiceCommand(systemctlExecutable, [
    '--user', 'show', unit, '--no-pager', ...SYSTEMD_SHOW_PROPERTIES.map(property => `--property=${property}`),
  ])).stdout, unit)
  if (shown.Id !== unit) fail(`systemd raw state unit 身份不匹配：${unit}`)
  for (const property of ['MainPID', 'ControlPID', 'NRestarts']) {
    if (!/^(?:0|[1-9]\d*)$/u.test(shown[property])) fail(`systemd unit 数字状态无效：${unit}:${property}`)
  }
  const mainPid = Number(shown.MainPID)
  const controlPid = Number(shown.ControlPID)
  const nRestarts = Number(shown.NRestarts)
  if (!Number.isSafeInteger(mainPid) || mainPid < 0 || !Number.isSafeInteger(controlPid) || controlPid < 0
    || !Number.isSafeInteger(nRestarts) || nRestarts < 0) {
    fail(`systemd unit PID 状态无效：${unit}`)
  }
  return {
    unit, loadState: shown.LoadState, unitFileState: shown.UnitFileState,
    activeState: shown.ActiveState, subState: shown.SubState, mainPid, controlPid,
    invocationId: shown.InvocationID, nRestarts, environment: shown.Environment, workingDirectory: shown.WorkingDirectory,
  }
}

async function sameHomeRawServiceOwnership(raw, homePath, strict = false) {
  const homes = (raw.environment ?? '').split(' ').filter(value => value.startsWith('DSH_HOME='))
  const candidate = homes.length === 1 ? homes[0].slice('DSH_HOME='.length) : undefined
  if (candidate === undefined || !isAbsolute(candidate) || !isAbsolute(raw.workingDirectory ?? '')) return false
  const canonicalize = strict ? realpath : canonicalMissingAllowed
  const serviceHome = await canonicalize(candidate).catch(() => undefined)
  const workingDirectory = await canonicalize(raw.workingDirectory).catch(() => undefined)
  return serviceHome !== undefined && workingDirectory !== undefined
    && sameHomeOwnershipEvidence(serviceHome, workingDirectory, homePath)
}

async function listedServiceUnits(systemctlExecutable) {
  const commands = [
    ['--user', 'list-unit-files', '--type=service', '--no-legend', '--no-pager', 'dsh-profile-*.service'],
    ['--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager', 'dsh-profile-*.service'],
  ]
  const names = []
  for (const args of commands) {
    const listed = await runServiceCommand(systemctlExecutable, args)
    names.push(...listed.stdout.split('\n').map(line => line.trim().split(/\s+/u)[0]).filter(name => SYSTEMD_UNIT.test(name)))
  }
  return [...new Set(names)].sort()
}

async function assertUnitUniverseStable(systemctlExecutable, unitUniverse, homePath, foreignOwnership = []) {
  const current = await listedServiceUnits(systemctlExecutable)
  if (JSON.stringify(current) !== JSON.stringify(unitUniverse)) {
    fail('systemd DSH unit inventory 在事务期间发生变化。')
  }
  for (const expected of foreignOwnership) {
    const currentOwnership = await classifyServiceUnitOwnership(systemctlExecutable, expected.unit, homePath)
    if (currentOwnership.classification !== 'foreign' || currentOwnership.digest !== expected.digest) {
      fail(`foreign systemd unit ownership 在事务期间发生变化：${expected.unit}`)
    }
  }
}

async function captureForeignOwnership(systemctlExecutable, units, homePath) {
  const foreignOwnership = []
  for (const unit of units) {
    const ownership = await classifyServiceUnitOwnership(systemctlExecutable, unit, homePath)
    if (ownership.classification !== 'foreign') {
      fail(`未绑定的 systemd unit 不再能证明属于 foreign DSH_HOME：${unit}`)
    }
    foreignOwnership.push({ unit, digest: ownership.digest })
  }
  return foreignOwnership
}

async function captureServiceInventory(systemctlExecutable, homePath, targetProfile, dshExecutable) {
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
  const names = await listedServiceUnits(systemctlExecutable)
  const services = []
  const foreignUnits = []
  for (const unit of names) {
    const ownership = await classifyServiceUnitOwnership(systemctlExecutable, unit, homePath)
    if (ownership.classification === 'foreign') {
      foreignUnits.push(unit)
      continue
    }
    const inspected = await inspectServiceUnit(systemctlExecutable, unit, dshExecutable)
    if (inspected.serviceHome !== homePath) {
      fail(`systemd unit 使用目标 DSH_HOME 内的嵌套 home；拒绝在外层目录切换期间忽略或接管：${unit}`)
    }
    services.push(inspected)
  }
  const targetUnit = `dsh-profile-${targetProfile}.service`
  const target = services.find(service => service.unit === targetUnit)
  if (target === undefined || target.serviceHome !== homePath) {
    fail(`Lark service lifecycle 需要由 installer 管理且属于目标 DSH_HOME 的 unit：${targetUnit}`)
  }
  return {
    services, unitUniverse: names,
    foreignOwnership: await captureForeignOwnership(systemctlExecutable, foreignUnits, homePath),
  }
}

function sameServiceFileIdentity(actual, expected) {
  return sameRegularFileIdentity(actual, expected, false)
}

function sameRegularFileIdentity(actual, expected, allowHardlinks) {
  return actual.isFile() && !actual.isSymbolicLink()
    && String(actual.dev) === expected.dev && String(actual.ino) === expected.ino
    && actual.uid === expected.uid && actual.mode === expected.mode
    && (allowHardlinks ? actual.nlink >= 1 : actual.nlink === 1)
}

async function assertServiceFilesUnchanged(services) {
  for (const service of services) {
    for (const expected of [service.fragment, ...service.dropIns]) {
      const snapshot = await snapshotServiceFile(expected.path)
      const current = await lstat(expected.path)
      const parent = await lstat(expected.parentPath)
      if (snapshot.sha256 !== expected.sha256 || !sameServiceFileIdentity(current, expected.identity)
        || !sameIdentity(parent, expected.parentIdentity)) {
        fail(`systemd service 文件在操作期间发生变化：${expected.path}`)
      }
      if (JSON.stringify(snapshot.ancestorChain) !== JSON.stringify(expected.ancestorChain)) {
        fail(`systemd service 目录链在操作期间发生变化：${expected.path}`)
      }
    }
  }
}

async function readServiceStates(systemctlExecutable, services, homePath, dshExecutable) {
  const result = []
  for (const expected of services) {
    const current = await inspectServiceUnit(systemctlExecutable, expected.unit, dshExecutable)
    if (current.serviceHome === homePath) result.push(current)
  }
  return result
}

function serviceMaskPath(unit) {
  return join(process.env.HOME ?? '', '.config', 'systemd', 'user.control', unit)
}

async function prepareBoundMasks(transactionRoot, units, kind) {
  const root = join(transactionRoot, 'service-mask-staging', kind)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await assertOwnedPrivateDirectory(root)
  const records = []
  for (const unit of units) {
    const stagingPath = join(root, unit)
    await symlink('/dev/null', stagingPath)
    const entry = await lstat(stagingPath)
    if (!entry.isSymbolicLink() || entry.uid !== currentUid() || entry.nlink !== 1
      || await readlink(stagingPath) !== '/dev/null') fail(`systemd lifecycle mask 身份不安全：${stagingPath}`)
    records.push({ unit, path: serviceMaskPath(unit), stagingPath, transactionRoot, target: '/dev/null', identity: identity(entry) })
  }
  await fsyncPath(root, true)
  return records
}

async function newBoundMaskIntent(transactionRoot, unit, kind, unitFileState, guardianRuntimeMask = false) {
  const [barrier] = await prepareServiceStartBarriers(transactionRoot, [{ unit, unitFileState }])
  return {
    unit, path: serviceMaskPath(unit),
    stagingPath: join(transactionRoot, 'service-mask-staging', kind, unit),
    transactionRoot, target: '/dev/null', barrier,
    ...(guardianRuntimeMask ? { guardianRuntimeMask: true } : {}),
  }
}

async function materializeMaskIntent(intent) {
  await mkdir(dirname(intent.stagingPath), { recursive: true, mode: 0o700 })
  await assertOwnedPrivateDirectory(dirname(intent.stagingPath))
  let entry = await lstat(intent.stagingPath).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (entry === undefined) {
    await symlink(intent.target, intent.stagingPath)
    entry = await lstat(intent.stagingPath)
  }
  if (!entry.isSymbolicLink() || entry.uid !== currentUid() || entry.nlink !== 1
    || await readlink(intent.stagingPath) !== intent.target) {
    throw new ServiceMaskConflictError(`systemd containment mask intent 身份不安全：${intent.stagingPath}`)
  }
  await fsyncPath(dirname(intent.stagingPath), true)
  return { ...intent, identity: identity(entry) }
}

async function boundMaskLocation(mask) {
  const destination = await lstat(mask.path).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (destination !== undefined) {
    if (!sameSymlinkIdentity(destination, mask.identity) || await readlink(mask.path) !== mask.target) {
      throw new ServiceMaskConflictError(`拒绝接管或移除身份不匹配的 systemd lifecycle mask：${mask.path}`)
    }
    return 'installed'
  }
  const staged = await lstat(mask.stagingPath).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (staged !== undefined) {
    if (!sameSymlinkIdentity(staged, mask.identity) || await readlink(mask.stagingPath) !== mask.target) {
      throw new ServiceMaskConflictError(`systemd lifecycle staging mask 身份不匹配：${mask.stagingPath}`)
    }
    return 'staged'
  }
  return 'missing'
}

async function moveBoundSymlinkNoReplace(source, destination, expectedIdentity, expectedTarget) {
  const before = await lstat(source).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (before === undefined || !sameSymlinkIdentity(before, expectedIdentity)
    || await readlink(source) !== expectedTarget) fail(`绑定 symlink 源身份不匹配：${source}`)
  const helper = [
    'import ctypes, os, stat, sys',
    'source, destination, expected_dev, expected_ino, expected_uid, expected_target = sys.argv[1:]',
    'source_parent, source_name = os.path.split(source)',
    'destination_parent, destination_name = os.path.split(destination)',
    'source_fd = os.open(source_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'destination_fd = os.open(destination_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
    'try:',
    '  entry = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)',
    '  if not stat.S_ISLNK(entry.st_mode) or (entry.st_dev, entry.st_ino, entry.st_uid) != (int(expected_dev), int(expected_ino), int(expected_uid)): raise RuntimeError("source identity changed")',
    '  if os.readlink(source_name, dir_fd=source_fd) != expected_target: raise RuntimeError("source target changed")',
    '  libc = ctypes.CDLL(None, use_errno=True)',
    '  renameat2 = getattr(libc, "renameat2", None)',
    '  if renameat2 is None: raise RuntimeError("renameat2 unavailable")',
    '  if renameat2(source_fd, source_name.encode(), destination_fd, destination_name.encode(), 1) != 0: raise RuntimeError("renameat2 noreplace errno=%d" % ctypes.get_errno())',
    '  moved = os.stat(destination_name, dir_fd=destination_fd, follow_symlinks=False)',
    '  if (moved.st_dev, moved.st_ino, moved.st_uid) != (int(expected_dev), int(expected_ino), int(expected_uid)): raise RuntimeError("destination identity changed")',
    '  os.fsync(destination_fd)',
    '  if source_fd != destination_fd: os.fsync(source_fd)',
    'finally:',
    '  os.close(source_fd)',
    '  if destination_fd != source_fd: os.close(destination_fd)',
  ].join('\n')
  try {
    await run('/usr/bin/python3', ['-I', '-S', '-c', helper, source, destination, expectedIdentity.dev, expectedIdentity.ino,
      String(expectedIdentity.uid), expectedTarget], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, capture: true, timeoutMs: 30_000, passFds: [3],
    })
  } catch (error) {
    throw new ServiceMaskConflictError(`无法无覆盖地移动 systemd 绑定 symlink ${source} -> ${destination}：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function installBoundMasks(systemctlExecutable, masks) {
  if (masks.length === 0) return
  const controlRoot = dirname(masks[0].path)
  await assertOwnedPrivateDirectory(dirname(controlRoot))
  if (await existingIdentity(controlRoot) === undefined) await mkdir(controlRoot, { mode: 0o700 })
  await assertOwnedPrivateDirectory(controlRoot)
  for (const mask of masks) {
    const location = await boundMaskLocation(mask)
    if (location === 'missing') fail(`绑定的 systemd lifecycle mask 已丢失：${mask.path}`)
    if (location === 'staged') await moveBoundSymlinkNoReplace(mask.stagingPath, mask.path, mask.identity, mask.target)
    const installed = await lstat(mask.path)
    if (!sameSymlinkIdentity(installed, mask.identity) || await readlink(mask.path) !== mask.target) {
      fail(`systemd lifecycle mask 安装后身份不匹配：${mask.path}`)
    }
  }
  await fsyncPath(controlRoot, true)
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
}

async function stageBoundMasks(systemctlExecutable, masks) {
  if (masks.length === 0) return
  const controlRoot = dirname(masks[0].path)
  await assertOwnedPrivateDirectory(controlRoot)
  for (const mask of masks) {
    const location = await boundMaskLocation(mask)
    if (location === 'missing') fail(`绑定的 systemd lifecycle mask 已丢失：${mask.path}`)
    if (location === 'installed') {
      if (await existingIdentity(mask.stagingPath) !== undefined) fail(`systemd lifecycle staging path 已被占用：${mask.stagingPath}`)
      await moveBoundSymlinkNoReplace(mask.path, mask.stagingPath, mask.identity, mask.target)
    }
  }
  await fsyncPath(controlRoot, true)
  await fsyncPath(dirname(masks[0].stagingPath), true)
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
}

async function releaseGuardianRuntimeMasks(systemctlExecutable, masks) {
  for (const mask of masks.filter(candidate => candidate.guardianRuntimeMask === true)) {
    if (await boundMaskLocation(mask) !== 'installed') {
      fail(`guardian runtime mask 只能在绑定 lifecycle mask 安装后解除：${mask.unit}`)
    }
    const before = await readRawServiceState(systemctlExecutable, mask.unit)
    if (before.loadState !== 'masked' || before.activeState !== 'inactive' || before.subState !== 'dead'
      || before.mainPid !== 0 || before.controlPid !== 0) {
      fail(`guardian runtime mask 解除前缺少 bound-masked/inactive 证明：${mask.unit}`)
    }
    await runServiceCommand(systemctlExecutable, ['--user', 'unmask', '--runtime', mask.unit])
    await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
    if (await boundMaskLocation(mask) !== 'installed') {
      fail(`guardian runtime mask 解除后 lifecycle mask 身份丢失：${mask.unit}`)
    }
    const after = await readRawServiceState(systemctlExecutable, mask.unit)
    if (after.loadState !== 'masked' || after.activeState !== 'inactive' || after.subState !== 'dead'
      || after.mainPid !== 0 || after.controlPid !== 0) {
      fail(`guardian runtime mask 解除后未保持 bound-masked/inactive：${mask.unit}`)
    }
  }
}

async function prepareServiceStartBarriers(transactionRoot, services) {
  const root = join(transactionRoot, 'service-enablement')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const barriers = []
  for (const service of services) {
    let enablement
    if (service.unitFileState === 'enabled') {
      const path = join(process.env.HOME ?? '', '.config', 'systemd', 'user', 'default.target.wants', service.unit)
      const entry = await lstat(path).catch(() => undefined)
      if (entry === undefined || !entry.isSymbolicLink() || entry.uid !== currentUid() || entry.nlink !== 1) {
        fail(`enabled systemd unit 缺少受当前用户拥有的 enablement link：${service.unit}`)
      }
      enablement = {
        path, stagingPath: join(root, service.unit), transactionRoot, target: await readlink(path), identity: identity(entry),
      }
    }
    barriers.push({
      unit: service.unit, originalUnitFileState: service.unitFileState, disableIntentAt: new Date().toISOString(), enablement,
    })
  }
  return barriers
}

async function boundEnablementLocation(enablement) {
  for (const [label, path] of [['installed', enablement.path], ['staged', enablement.stagingPath]]) {
    const entry = await lstat(path).catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
    if (entry === undefined) continue
    if (!sameSymlinkIdentity(entry, enablement.identity) || await readlink(path) !== enablement.target) {
      throw new ServiceMaskConflictError(`systemd enablement link 身份不匹配：${path}`)
    }
    return label
  }
  return 'missing'
}

async function establishServiceStartBarriers(systemctlExecutable, barriers) {
  for (const barrier of barriers) {
    if (barrier.originalUnitFileState === 'enabled') {
      const location = await boundEnablementLocation(barrier.enablement)
      if (location === 'missing') fail(`绑定的 systemd enablement link 已丢失：${barrier.unit}`)
      if (location === 'installed') await moveBoundSymlinkNoReplace(
        barrier.enablement.path, barrier.enablement.stagingPath, barrier.enablement.identity, barrier.enablement.target,
      )
    } else if (barrier.originalUnitFileState !== 'disabled') {
      fail(`不支持为 ${barrier.originalUnitFileState} unit 建立 crash-safe start barrier：${barrier.unit}`)
    }
  }
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
  for (const barrier of barriers) {
    const state = await readRawServiceState(systemctlExecutable, barrier.unit)
    if (barrier.originalUnitFileState === 'enabled') {
      if (await boundEnablementLocation(barrier.enablement) !== 'staged') {
        fail(`systemd service enablement link 未进入持久 start barrier：${barrier.unit}`)
      }
      if (!['disabled', 'masked'].includes(state.unitFileState) && state.loadState !== 'masked') {
        fail(`systemd service 未反映持久 start barrier 或 lifecycle mask：${barrier.unit}`)
      }
    } else if (state.unitFileState !== 'disabled' && state.loadState !== 'masked') {
      fail(`systemd disabled service 在 start barrier 后状态漂移：${barrier.unit}`)
    }
  }
}

async function ensureServiceStartBarriers(systemctlExecutable, barriers) {
  const toDisable = []
  for (const barrier of barriers) {
    if (barrier.originalUnitFileState === 'enabled') {
      const location = await boundEnablementLocation(barrier.enablement)
      if (location === 'staged') continue
      if (location === 'installed') { toDisable.push(barrier); continue }
      fail(`绑定的 systemd enablement link 已丢失：${barrier.unit}`)
    }
    const state = await readRawServiceState(systemctlExecutable, barrier.unit)
    if (barrier.originalUnitFileState === 'disabled' && ['disabled', 'masked'].includes(state.unitFileState)) continue
    if (state.unitFileState !== barrier.originalUnitFileState) {
      fail(`systemd service start barrier 状态不匹配：${barrier.unit}:${state.unitFileState}`)
    }
    toDisable.push(barrier)
  }
  if (toDisable.length > 0) await establishServiceStartBarriers(systemctlExecutable, toDisable)
}

async function restoreServiceEnablement(systemctlExecutable, barriers) {
  for (const barrier of barriers) {
    if (barrier.originalUnitFileState === 'enabled') {
      const location = await boundEnablementLocation(barrier.enablement)
      if (location === 'missing') fail(`绑定的 systemd enablement link 已丢失：${barrier.unit}`)
      if (location === 'staged') await moveBoundSymlinkNoReplace(
        barrier.enablement.stagingPath, barrier.enablement.path, barrier.enablement.identity, barrier.enablement.target,
      )
    } else {
      const current = await readRawServiceState(systemctlExecutable, barrier.unit)
      if (current.unitFileState !== 'disabled') fail(`systemd disabled service 状态在事务中漂移：${barrier.unit}`)
    }
  }
  await runServiceCommand(systemctlExecutable, ['--user', 'daemon-reload'])
  for (const barrier of barriers) {
    const state = await readRawServiceState(systemctlExecutable, barrier.unit)
    if (barrier.originalUnitFileState === 'enabled'
      && await boundEnablementLocation(barrier.enablement) !== 'installed') {
      fail(`systemd service enablement link 未恢复绑定：${barrier.unit}`)
    }
    if (state.unitFileState !== barrier.originalUnitFileState) {
      fail(`systemd service enablement 未恢复原状态：${barrier.unit}`)
    }
  }
}

async function assertMaskedAndQuiescent({
  systemctlExecutable, services, serviceMasks, homePath, unitUniverse, foreignOwnership = [], equivalentHomePaths = [],
}) {
  await assertServiceFilesUnchanged(services)
  await assertUnitUniverseStable(systemctlExecutable, unitUniverse, homePath, foreignOwnership)
  for (const service of services) {
    const mask = serviceMasks.find(candidate => candidate.unit === service.unit)
    if (mask === undefined || await boundMaskLocation(mask) !== 'installed') {
      fail(`systemd service 缺少已绑定 lifecycle mask：${service.unit}`)
    }
    const state = await readRawServiceState(systemctlExecutable, service.unit)
    if (state.loadState !== 'masked') {
      fail(`systemd service 未保持 runtime mask：${service.unit}`)
    }
    if (state.activeState !== 'inactive' || state.subState !== 'dead' || state.mainPid !== 0 || state.controlPid !== 0) {
      fail(`systemd service 未保持 inactive/dead/PID0：${service.unit}`)
    }
  }
  await assertNoUnmanagedHomeProcesses(homePath, equivalentHomePaths)
  assertLockParentStable(homePath)
}

async function stopServicesAndWait(
  systemctlExecutable, services, masks, homePath, dshExecutable, unitUniverse, foreignOwnership, timeoutMilliseconds,
) {
  const names = services.map(service => service.unit)
  await installBoundMasks(systemctlExecutable, masks)
  if (names.length > 0) {
    try { await runServiceCommand(systemctlExecutable, ['--user', 'stop', ...names]) }
    catch (error) {
      fail(`systemd service stop 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const deadline = Date.now() + timeoutMilliseconds
  for (;;) {
    await assertServiceFilesUnchanged(services)
    const states = await Promise.all(services.map(service => readRawServiceState(systemctlExecutable, service.unit)))
    if (states.every(service => service.activeState === 'inactive'
    && service.subState === 'dead' && service.mainPid === 0 && service.controlPid === 0)) {
      await assertMaskedAndQuiescent({
        systemctlExecutable, services, serviceMasks: masks, homePath, dshExecutable, unitUniverse, foreignOwnership,
      })
      return states
    }
    if (Date.now() >= deadline) fail('systemd services 未在超时内停止为 inactive/dead/MainPID=0。')
    await delay(deadline - Date.now())
  }
}

async function stopRelatedServices(
  systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeoutMilliseconds, transactionRoot, manifest,
) {
  for (const intent of manifest.containmentMaskIntents) {
    manifest = await withCrashStopGuardian(systemctlExecutable, [], randomUUID(), async () => {
      const raw = await readRawServiceState(systemctlExecutable, intent.unit)
      if (!await sameHomeRawServiceOwnership(raw, homePath, intent.guardianRuntimeMask === true)) {
        fail(`已持久化 containment intent 的 unit ownership 证据缺失或冲突；拒绝修改：${intent.unit}`)
      }
      if (intent.guardianRuntimeMask !== true) {
        await ensureServiceStartBarriers(systemctlExecutable, [intent.barrier])
      }
      const mask = await materializeMaskIntent(intent)
      manifest = await writeManifest(transactionRoot, {
        ...manifest, containmentMaskIntents: manifest.containmentMaskIntents.filter(candidate => candidate.unit !== intent.unit),
        containmentMasks: [...manifest.containmentMasks, mask],
        containmentStartBarriers: [...manifest.containmentStartBarriers, intent.barrier],
      }, manifest.state)
      await installBoundMasks(systemctlExecutable, [mask])
      await releaseGuardianRuntimeMasks(systemctlExecutable, [mask])
      await runServiceCommand(systemctlExecutable, ['--user', 'stop', intent.unit])
      return manifest
    }, false, homePath)
  }
  const combined = new Map(services.map(service => [service.unit, service]))
  const containedUnits = new Set(manifest.containmentMasks.map(mask => mask.unit))
  for (const mask of manifest.containmentMasks) {
    const raw = await readRawServiceState(systemctlExecutable, mask.unit)
    if (!await sameHomeRawServiceOwnership(raw, homePath, mask.guardianRuntimeMask === true)) {
      fail(`已持久化 containment mask 的 unit ownership 证据缺失或冲突；拒绝修改：${mask.unit}`)
    }
  }
  await installBoundMasks(systemctlExecutable, [...manifest.serviceMasks, ...manifest.containmentMasks])
  await releaseGuardianRuntimeMasks(systemctlExecutable, manifest.containmentMasks)
  await ensureServiceStartBarriers(systemctlExecutable, manifest.serviceStartBarriers)
  const currentUniverse = await listedServiceUnits(systemctlExecutable)
  const additionalUnits = [...containedUnits].filter(unit => currentUniverse.includes(unit))
  if (services.length > 0) {
    await runServiceCommand(systemctlExecutable, ['--user', 'stop', ...services.map(service => service.unit)])
  }
  if (additionalUnits.length > 0) {
    await runServiceCommand(systemctlExecutable, ['--user', 'stop', ...additionalUnits])
  }
  for (const unit of currentUniverse) {
    if (combined.has(unit) || containedUnits.has(unit)) continue
    // This unit is only a candidate until the ownership query below proves it
    // belongs to this DSH_HOME.  Do not seed it into the guardian's trusted
    // set: if the parent dies during classification, the guardian must apply
    // its own fresh ownership census rather than stopping a foreign unit.
    const classified = await withCrashStopGuardian(systemctlExecutable, [], randomUUID(), async () => {
      const raw = await readRawServiceState(systemctlExecutable, unit)
      const guardianContained = raw.unitFileState === 'masked-runtime'
      const homes = (raw.environment ?? '').split(' ').filter(value => value.startsWith('DSH_HOME='))
      const candidate = homes.length === 1 ? homes[0].slice('DSH_HOME='.length) : undefined
      const canonicalize = guardianContained ? realpath : canonicalMissingAllowed
      const serviceHome = candidate !== undefined && isAbsolute(candidate)
        ? await canonicalize(candidate).catch(() => undefined) : undefined
      const workingDirectory = isAbsolute(raw.workingDirectory ?? '')
        ? await canonicalize(raw.workingDirectory).catch(() => undefined) : undefined
      const sameHome = await sameHomeRawServiceOwnership(raw, homePath, guardianContained)
      if (sameHome) {
        if (manifest.foreignOwnership?.some(evidence => evidence.unit === unit)) {
          fail(`既有 foreign systemd unit ownership 在事务期间发生变化；拒绝接管：${unit}`)
        }
        if (!manifest.containmentMasks.some(mask => mask.unit === unit)) {
          if (!['enabled', 'disabled', 'masked-runtime'].includes(raw.unitFileState)) {
            fail(`新增同-home unit 的 enablement 状态不受支持：${unit}:${raw.unitFileState}`)
          }
          // A detached crash guardian cannot safely rewrite manifest JSON, so
          // it persistently disables and runtime-masks a late same-home unit.
          // Recovery recognizes that fail-closed residue as originally
          // disabled, then materializes the normal inode-bound user.control
          // mask ledger before it performs any further work.
          const intent = await newBoundMaskIntent(
            transactionRoot, unit, 'containment', guardianContained ? 'disabled' : raw.unitFileState, guardianContained,
          )
          if (!unitUniverse.includes(unit)) {
            unitUniverse.push(unit)
            unitUniverse.sort()
          }
          manifest = await writeManifest(transactionRoot, {
            ...manifest, unitUniverse, containmentMaskIntents: [...manifest.containmentMaskIntents, intent],
          }, manifest.state)
          await establishServiceStartBarriers(systemctlExecutable, [intent.barrier])
          const mask = await materializeMaskIntent(intent)
          manifest = await writeManifest(transactionRoot, {
            ...manifest, containmentMaskIntents: manifest.containmentMaskIntents.filter(candidate => candidate.unit !== unit),
            containmentMasks: [...manifest.containmentMasks, mask],
            containmentStartBarriers: [...manifest.containmentStartBarriers, intent.barrier],
          }, manifest.state)
        }
        const unitMasks = manifest.containmentMasks.filter(mask => mask.unit === unit)
        await installBoundMasks(systemctlExecutable, unitMasks)
        await releaseGuardianRuntimeMasks(systemctlExecutable, unitMasks)
        await runServiceCommand(systemctlExecutable, ['--user', 'stop', unit])
        return { matched: true, manifest }
      }
      const environmentMatches = serviceHome === homePath
      const workingMatches = workingDirectory !== undefined && inside(homePath, workingDirectory)
      if (environmentMatches !== workingMatches || serviceHome !== undefined && inside(homePath, serviceHome)) {
        fail(`新增 unit 的 HOME/WorkingDirectory ownership 证据冲突：${unit}`)
      }
      return { matched: false, manifest }
    }, false, homePath)
    manifest = classified.manifest
    if (classified.matched) {
      additionalUnits.push(unit)
      containedUnits.add(unit)
    }
  }
  await stopServicesAndWait(
    systemctlExecutable, services, manifest.serviceMasks, homePath, dshExecutable, unitUniverse,
    manifest.foreignOwnership ?? [], timeoutMilliseconds,
  )
  const deadline = Date.now() + timeoutMilliseconds
  for (;;) {
    const states = await Promise.all(additionalUnits.map(unit => readRawServiceState(systemctlExecutable, unit)))
    if (states.every(service => service.activeState === 'inactive' && service.subState === 'dead'
      && service.mainPid === 0 && service.controlPid === 0
      && service.loadState === 'masked')) break
    if (Date.now() >= deadline) fail('新增同-home systemd services 未能可靠停止。')
    await delay(deadline - Date.now())
  }
  if (JSON.stringify(currentUniverse) !== JSON.stringify(unitUniverse)) {
    fail('systemd DSH unit inventory 在失败收容期间发生变化；已停止并继续 mask 可证明相关的 services。')
  }
  return manifest
}

async function journalHasReadyMarker(journalctlExecutable, service) {
  const result = await runServiceCommand(journalctlExecutable, [
    '--user', '--unit', service.unit, `_SYSTEMD_INVOCATION_ID=${service.invocationId}`, '--output=cat', '--no-pager',
  ])
  return result.stdout.split('\n').some(line => line.includes(READY_MARKER))
}

async function larkJournalStates(journalctlExecutable, service) {
  const result = await runServiceCommand(journalctlExecutable, [
    '--user', '--unit', service.unit, `_SYSTEMD_INVOCATION_ID=${service.invocationId}`, '--output=cat', '--no-pager',
  ])
  return result.stdout.split('\n').flatMap(line => {
    const normalized = line.trim()
    if (!normalized.startsWith(LARK_STATE_PREFIX)) return []
    const state = normalized.slice(LARK_STATE_PREFIX.length)
    return ['connected', 'connected-with-gap', 'disconnected'].includes(state) ? [state] : []
  })
}

function latestLarkState(states) {
  const latest = states.at(-1)
  return latest !== undefined && ['connected', 'connected-with-gap', 'disconnected'].includes(latest) ? latest : undefined
}

async function latestLarkJournalState(journalctlExecutable, service) {
  return latestLarkState(await larkJournalStates(journalctlExecutable, service))
}

async function startAndAcceptServices({
  systemctlExecutable, journalctlExecutable, services, serviceMasks,
  homePath, targetProfile, unitUniverse, foreignOwnership = [], cleanProfiles = [], timeouts,
  acceptAfterReady, durableAccept, requireLarkReady = false,
}) {
  const activeBefore = services.filter(service => service.wasActive)
  const activeMasks = activeBefore.map(service => {
    const mask = serviceMasks.find(candidate => candidate.unit === service.unit)
    if (mask === undefined) fail(`service start 缺少绑定 mask：${service.unit}`)
    return mask
  })
  await stageBoundMasks(systemctlExecutable, activeMasks)
  await assertCleanProfileInventory(homePath, cleanProfiles)
  const unitNames = activeBefore.map(service => service.unit)
  let accepted
  const larkBaseline = new Map()
  const result = await withCrashStopGuardian(systemctlExecutable, unitNames, randomUUID(), async () => {
    const deadline = Date.now() + timeouts.ready
    for (;;) {
      await assertUnitUniverseStable(systemctlExecutable, unitUniverse, homePath, foreignOwnership)
      await assertCleanProfileInventory(homePath, cleanProfiles)
      await assertServiceFilesUnchanged(services)
      const current = await Promise.all(activeBefore.map(async previous => ({
        ...previous, ...await readRawServiceState(systemctlExecutable, previous.unit),
      })))
      const byUnit = new Map(current.map(service => [service.unit, service]))
      const candidates = activeBefore.map(previous => ({ previous, current: byUnit.get(previous.unit) }))
      let inactiveReady = true
      for (const previous of services.filter(service => !service.wasActive)) {
        const service = await readRawServiceState(systemctlExecutable, previous.unit)
        inactiveReady &&= service.activeState === 'inactive' && service.subState === 'dead'
          && service.mainPid === 0 && service.controlPid === 0
          && service.loadState === 'masked'
      }
      const systemdReady = candidates.every(({ previous, current: service }) => service !== undefined
        && service.activeState === 'active' && service.subState === 'running' && service.mainPid > 0
        && service.controlPid === 0 && service.invocationId !== '' && service.invocationId !== previous.invocationId) && inactiveReady
      if (systemdReady) {
        let logsReady = true
        const readinessLarkCounts = new Map()
        for (const candidate of candidates) {
          if (!await journalHasReadyMarker(journalctlExecutable, candidate.current)) { logsReady = false; break }
          if (requireLarkReady && candidate.current.profile === targetProfile) {
            const states = await larkJournalStates(journalctlExecutable, candidate.current)
            if (!LARK_ACCEPTED_STATES.has(latestLarkState(states))) { logsReady = false; break }
            readinessLarkCounts.set(candidate.current.unit, states.length)
          }
        }
        if (logsReady) {
          accepted = candidates.map(({ current }) => current)
          for (const [unit, count] of readinessLarkCounts) larkBaseline.set(unit, count)
          break
        }
      }
      if (Date.now() >= deadline) fail('systemd services 未在超时内产生 fresh InvocationID Host ready marker。')
      await delay(deadline - Date.now())
    }
    const targetBefore = services.find(service => service.profile === targetProfile)
    if (targetBefore === undefined || targetBefore.wasActive && !accepted.some(service => service.profile === targetProfile)) {
      fail('目标 Lark service 未通过 readiness。')
    }
    if (acceptAfterReady !== undefined) await acceptAfterReady()
    // 稳定性窗口：窗口内取 N 个连续样本，每个样本都必须独立通过全部门槛。
    // 仅比对「接受点 + 窗口末点」会漏掉窗口内 connected→disconnected→connected
    // （末点复原）与 nRestarts 不变的短暂掉线；对 Lark journal 还要逐条检查
    // 自接受基线以来「新增的每一条状态行」，因为最新行会把一次掉线完全覆盖。
    const sampleCount = timeouts.stability > 0 ? Math.max(2, timeouts.stabilitySamples) : 1
    const gap = sampleCount > 1 ? timeouts.stability / (sampleCount - 1) : 0
    for (let sample = 1; sample <= sampleCount; sample += 1) {
      if (sample > 1) await new Promise(resolveDelay => setTimeout(resolveDelay, gap))
      await assertUnitUniverseStable(systemctlExecutable, unitUniverse, homePath, foreignOwnership)
      await assertCleanProfileInventory(homePath, cleanProfiles)
      const stable = await Promise.all(activeBefore.map(async previous => ({
        ...previous, ...await readRawServiceState(systemctlExecutable, previous.unit),
      })))
      const stableByUnit = new Map(stable.map(service => [service.unit, service]))
      for (const acceptedService of accepted) {
        const service = stableByUnit.get(acceptedService.unit)
        if (service === undefined || service.activeState !== 'active' || service.subState !== 'running' || service.mainPid <= 0
          || service.controlPid !== 0
          || service.invocationId !== acceptedService.invocationId || service.nRestarts !== acceptedService.nRestarts) {
          fail(`systemd service 未通过稳定性验证：${acceptedService.unit}`)
        }
        if (requireLarkReady && acceptedService.profile === targetProfile) {
          const states = await larkJournalStates(journalctlExecutable, service)
          const baselineCount = larkBaseline.get(acceptedService.unit) ?? 0
          const offending = states.slice(baselineCount)
            .find(state => !LARK_ACCEPTED_STATES.has(state))
          if (offending !== undefined) {
            fail(`Lark service 在稳定性窗口内报告了非接受状态「${offending}」：${acceptedService.unit}`)
          }
          if (!LARK_ACCEPTED_STATES.has(latestLarkState(states))) {
            fail(`Lark service 在稳定性窗口后未保持 connected：${acceptedService.unit}`)
          }
        }
      }
      for (const inactiveService of services.filter(service => !service.wasActive)) {
        const state = await readRawServiceState(systemctlExecutable, inactiveService.unit)
        if (state.activeState !== 'inactive' || state.subState !== 'dead' || state.mainPid !== 0 || state.controlPid !== 0) {
          fail(`原 inactive service 被意外启动：${inactiveService.unit}`)
        }
      }
    }
    await installBoundMasks(systemctlExecutable, activeMasks)
    if (durableAccept !== undefined) await durableAccept(accepted)
    return accepted
  }, true, homePath, services.map(service => service.unit))
  return result
}

async function finalizeAcceptedServices({
  systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks, containmentMasks, serviceStartBarriers,
  containmentStartBarriers,
  homePath, targetProfile, unitUniverse, foreignOwnership = [], cleanProfiles = [], acceptance, requireLarkReady = false,
  restoreContainedEnablement = true,
}) {
  await stageBoundMasks(systemctlExecutable, serviceMasks)
  if (restoreContainedEnablement) await stageBoundMasks(systemctlExecutable, containmentMasks)
  else {
    await installBoundMasks(systemctlExecutable, containmentMasks)
    for (const barrier of containmentStartBarriers) {
      await ensureServiceStartBarriers(systemctlExecutable, [barrier])
      const state = await readRawServiceState(systemctlExecutable, barrier.unit)
      const mask = containmentMasks.find(candidate => candidate.unit === barrier.unit)
      if (mask === undefined || await boundMaskLocation(mask) !== 'installed'
        || state.activeState !== 'inactive' || state.subState !== 'dead'
        || state.mainPid !== 0 || state.controlPid !== 0) {
        fail(`卸载收容 unit 未保持 persistent masked/disabled/inactive：${barrier.unit}`)
      }
    }
  }
  await restoreServiceEnablement(systemctlExecutable, serviceStartBarriers)
  if (restoreContainedEnablement) await restoreServiceEnablement(systemctlExecutable, containmentStartBarriers)
  await assertAcceptedServicesStillBound({
    systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks, serviceStartBarriers,
    homePath, targetProfile, unitUniverse, foreignOwnership, cleanProfiles, acceptance, requireLarkReady,
  })
}

async function assertAcceptedServicesStillBound({
  systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks, serviceStartBarriers,
  homePath, targetProfile, unitUniverse, foreignOwnership = [], cleanProfiles = [], acceptance, requireLarkReady = false,
}) {
  if (!await acceptedServicesStillBound({
    systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks, serviceStartBarriers,
    homePath, targetProfile, unitUniverse, foreignOwnership, cleanProfiles, acceptance, requireLarkReady,
  })) fail('systemd service acceptance 在 cleanup 前失效。')
}

async function acceptedServicesStillBound({
  systemctlExecutable, journalctlExecutable, services, serviceMasks, serviceStartBarriers, homePath, targetProfile,
  unitUniverse, foreignOwnership = [], cleanProfiles = [], acceptance, requireLarkReady = false,
}) {
  await assertUnitUniverseStable(systemctlExecutable, unitUniverse, homePath, foreignOwnership)
  await assertCleanProfileInventory(homePath, cleanProfiles)
  await assertServiceFilesUnchanged(services)
  const accepted = new Map(acceptance.map(service => [service.unit, service]))
  let readyForCleanup = true
  for (const original of services) {
    const mask = serviceMasks.find(candidate => candidate.unit === original.unit)
    const barrier = serviceStartBarriers.find(candidate => candidate.unit === original.unit)
    if (mask === undefined || barrier === undefined) fail(`systemd service cleanup 绑定不完整：${original.unit}`)
    const maskLocation = await boundMaskLocation(mask)
    if (maskLocation === 'missing') fail(`绑定的 systemd lifecycle mask 已丢失：${mask.path}`)
    let enablementLocation = 'installed'
    if (barrier.originalUnitFileState === 'enabled') {
      enablementLocation = await boundEnablementLocation(barrier.enablement)
      if (enablementLocation === 'missing') fail(`绑定的 systemd enablement link 已丢失：${barrier.unit}`)
    } else if (barrier.originalUnitFileState !== 'disabled') {
      fail(`systemd service start barrier 状态不受支持：${barrier.unit}`)
    }
    const service = await readRawServiceState(systemctlExecutable, original.unit)
    if (!['loaded', 'masked'].includes(service.loadState)
      || !['enabled', 'disabled', 'masked', 'masked-runtime'].includes(service.unitFileState)) {
      fail(`systemd service raw load/unit-file state 无效：${original.unit}:${service.loadState}/${service.unitFileState}`)
    }
    const stableActive = service.activeState === 'active' && service.subState === 'running'
      && service.mainPid > 0 && service.controlPid === 0 && service.invocationId !== ''
    const stableInactive = service.activeState === 'inactive' && service.subState === 'dead'
      && service.mainPid === 0 && service.controlPid === 0
    if (!stableActive && !stableInactive) fail(`systemd service raw runtime state 无法安全重验：${original.unit}`)
    if (maskLocation === 'installed') {
      // renameat2() of the inode-bound mask and daemon-reload are not one
      // syscall.  A crash between them can legitimately leave the filesystem
      // mask installed while systemd still reports the previous loaded state.
      readyForCleanup = false
      continue
    } else {
      // The inverse cache-skew exists when the bound mask has moved back to
      // staging but daemon-reload has not observed that move yet.
      if (service.loadState === 'masked') {
        readyForCleanup = false
        continue
      }
      if (!await sameHomeRawServiceOwnership(service, homePath)) {
        fail(`systemd service ownership 在 cleanup 前发生变化：${original.unit}`)
      }
      if (enablementLocation !== 'installed' || service.unitFileState !== barrier.originalUnitFileState) {
        readyForCleanup = false
      }
    }
    if (!original.wasActive) {
      if (service.activeState !== 'inactive' || service.subState !== 'dead' || service.mainPid !== 0 || service.controlPid !== 0) {
        readyForCleanup = false
      }
      continue
    }
    const proof = accepted.get(original.unit)
    if (proof === undefined || service.activeState !== 'active' || service.subState !== 'running'
      || service.mainPid !== proof.mainPid || service.invocationId !== proof.invocationId
      || service.nRestarts !== proof.nRestarts) readyForCleanup = false
    if (requireLarkReady && original.profile === targetProfile
      && !LARK_ACCEPTED_STATES.has(await latestLarkJournalState(journalctlExecutable, service))) {
      readyForCleanup = false
    }
  }
  return readyForCleanup
}

async function removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome }) {
  const liveDescriptor = openSync(manifest.homePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (!sameIdentity(fstatSync(liveDescriptor), manifest.stagedIdentity)) {
      fail(`service-aware canonical home 身份已变化；拒绝删除原始备份：${manifest.homePath}`)
    }
    await removeCommittedTransactionBound({
      physicalTransactionRoot, transactionRoot, manifest, backupHome, liveDescriptor,
    })
  } finally { closeSync(liveDescriptor) }
}

async function removeCommittedTransactionBound({
  physicalTransactionRoot, transactionRoot, manifest: initialManifest, backupHome, liveDescriptor,
}) {
  let manifest = initialManifest
  const liveHome = `/proc/self/fd/${liveDescriptor}`
  if (manifest.operation === 'uninstall') {
    if (typeof manifest.cleanProfileDigest !== 'string') {
      fail(`service-aware uninstall cleanup 缺少 clean baseline 绑定：${transactionRoot}`)
    }
    await assertInstallerCleanWebProfile(liveHome, manifest.profile, manifest.cleanProfileDigest)
    if (manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION) await assertArchivedProfile(liveHome, manifest)
  }
  await assertCleanProfileInventory(liveHome, manifest.cleanProfiles ?? [])
  const transactionIdentity = await lstat(physicalTransactionRoot)
  const expectedTransactionIdentity = manifest.transactionIdentity
    ?? (manifest.version === MANIFEST_VERSION ? identity(transactionIdentity) : undefined)
  if (!sameIdentity(transactionIdentity, expectedTransactionIdentity)) {
    fail(`service-aware transaction root 身份不安全；拒绝清理：${transactionRoot}`)
  }
  assertLockParentStable(manifest.homePath)
  const cleanupDescriptor = openSync(physicalTransactionRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const cleanupFdPath = `/proc/self/fd/${cleanupDescriptor}`
  try {
    const cleanupIdentity = fstatSync(cleanupDescriptor)
    if (!sameIdentity(cleanupIdentity, expectedTransactionIdentity)) {
      fail(`service-aware transaction root fd 身份不匹配：${transactionRoot}`)
    }
    const anchoredBackup = join(cleanupFdPath, basename(backupHome))
    const tombstoneName = 'cleanup-original-home'
    const anchoredTombstone = join(cleanupFdPath, tombstoneName)
    const backupIdentity = await existingIdentity(anchoredBackup)
    const tombstoneIdentity = await existingIdentity(anchoredTombstone)
    if (backupIdentity !== undefined && tombstoneIdentity !== undefined) {
      fail(`service-aware cleanup 同时存在 original-home 与 deletion tombstone：${transactionRoot}`)
    }
    if (manifest.cleanup === undefined) {
      if (backupIdentity === undefined) {
        manifest = await writeManifest(cleanupFdPath, manifest, 'cleanup-started', {
          cleanup: { protocol: SERVICE_CLEANUP_PROTOCOL, phase: 'metadata-only', tombstoneName, identity: manifest.originalIdentity },
        })
      } else {
        if (!sameIdentity(backupIdentity, manifest.originalIdentity)) fail(`service-aware original-home 身份不匹配；拒绝清理：${backupHome}`)
        await assertProfileDigest(anchoredBackup, manifest.profile, manifest.originalProfileDigest)
        const boundBackupIdentity = identity(backupIdentity)
        manifest = await writeManifest(cleanupFdPath, manifest, 'cleanup-started', {
          cleanup: { protocol: SERVICE_CLEANUP_PROTOCOL, phase: 'prepared', tombstoneName, identity: boundBackupIdentity },
        })
      }
    }
    if (manifest.cleanup.phase === 'prepared') {
      if (backupIdentity !== undefined) {
        await moveBoundDirectoryNoReplace(backupHome, join(physicalTransactionRoot, tombstoneName),
          manifest.cleanup.identity, manifest.transactionIdentity === undefined ? undefined
            : { path: physicalTransactionRoot, identity: manifest.transactionIdentity })
      } else if (!sameIdentity(tombstoneIdentity, manifest.cleanup.identity)) {
        fail(`service-aware cleanup tombstone 身份未知：${transactionRoot}`)
      }
      manifest = await writeManifest(cleanupFdPath, manifest, 'cleanup-started', {
        cleanup: { ...manifest.cleanup, phase: 'tombstoned' },
      })
    }
    if (manifest.cleanup.phase === 'tombstoned') {
      const currentTombstone = await existingIdentity(anchoredTombstone)
      if (!sameIdentity(currentTombstone, manifest.cleanup.identity)) fail(`service-aware cleanup tombstone 身份不匹配：${transactionRoot}`)
      await assertProfileDigest(anchoredTombstone, manifest.profile, manifest.originalProfileDigest)
      await assertNoMounts(anchoredTombstone)
      manifest = await writeManifest(cleanupFdPath, manifest, 'cleanup-started', {
        cleanup: { ...manifest.cleanup, phase: 'deleting' },
      })
    }
    if (manifest.cleanup.phase === 'deleting') {
      const currentTombstone = await existingIdentity(anchoredTombstone)
      if (currentTombstone !== undefined) {
        assertExpectedDirectoryMetadata(currentTombstone, manifest.cleanup.identity, anchoredTombstone)
        await assertNoMounts(anchoredTombstone)
        if (!sameIdentity(fstatSync(liveDescriptor), manifest.stagedIdentity)
          || !sameIdentity(await lstat(manifest.homePath), manifest.stagedIdentity)) {
          fail(`service-aware canonical home 在不可逆删除前发生替换：${manifest.homePath}`)
        }
        const deletion = [
          'import os, stat, sys',
          'parent_fd, name, expected_dev, expected_ino, expected_uid = int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])',
          'root_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)',
          'def purge(fd):',
          '  for entry in os.listdir(fd):',
          '    info = os.stat(entry, dir_fd=fd, follow_symlinks=False)',
          '    if stat.S_ISDIR(info.st_mode):',
          '      child = os.open(entry, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)',
          '      try: purge(child)',
          '      finally: os.close(child)',
          '      os.rmdir(entry, dir_fd=fd)',
          '    else:',
          '      os.unlink(entry, dir_fd=fd)',
          'try:',
          '  info = os.fstat(root_fd)',
          '  if (info.st_dev, info.st_ino, info.st_uid) != (expected_dev, expected_ino, expected_uid): raise RuntimeError("tombstone identity changed")',
          '  purge(root_fd)',
          '  os.fsync(root_fd)',
          'finally: os.close(root_fd)',
          'os.rmdir(name, dir_fd=parent_fd)',
          'os.fsync(parent_fd)',
        ].join('\n')
        await run('/usr/bin/python3', ['-I', '-S', '-c', deletion, '3', tombstoneName,
          manifest.cleanup.identity.dev, manifest.cleanup.identity.ino, String(manifest.cleanup.identity.uid)], {
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, capture: true, timeoutMs: 30_000,
          passFds: [cleanupDescriptor],
        })
        await fsyncPath(cleanupFdPath, true)
      }
      manifest = await writeManifest(cleanupFdPath, manifest, 'cleanup-started', {
        cleanup: { ...manifest.cleanup, phase: 'metadata-only' },
      })
    }
    if (manifest.cleanup.phase !== 'metadata-only') fail(`service-aware cleanup phase 无效：${transactionRoot}`)
    const remainingBackup = await existingIdentity(anchoredBackup)
    const remainingTombstone = await existingIdentity(anchoredTombstone)
    if (remainingBackup !== undefined || remainingTombstone !== undefined) fail(`service-aware cleanup 删除阶段未收敛：${transactionRoot}`)
    if (backupIdentity !== undefined && manifest.cleanup.phase === 'metadata-only') {
      if (!sameIdentity(backupIdentity, manifest.originalIdentity)) {
        fail(`service-aware original-home 身份不匹配；拒绝清理：${backupHome}`)
      }
    }
    if (!sameIdentity(fstatSync(liveDescriptor), manifest.stagedIdentity)
      || !sameIdentity(await lstat(manifest.homePath), manifest.stagedIdentity)) {
      fail(`service-aware canonical home 在删除前发生替换：${manifest.homePath}`)
    }
    await assertNoMounts(cleanupFdPath)
    const entries = await readdir(cleanupFdPath)
    if (!entries.includes('manifest.json')) {
      fail(`service-aware transaction root 在清理前缺少 manifest：${transactionRoot}`)
    }
    const allowedCleanupEntries = new Set(['manifest.json', 'service-mask-staging', 'service-enablement'])
    const unknownEntries = entries.filter(entry => !allowedCleanupEntries.has(entry))
    if (unknownEntries.length > 0) fail(`service-aware cleanup 包含未知事务条目：${unknownEntries.join(', ')}`)
    for (const entry of entries) {
      if (entry === 'manifest.json') continue
      await assertOwnedPrivateDirectory(join(cleanupFdPath, entry))
      await rm(join(cleanupFdPath, entry), { recursive: true })
    }
    await fsyncPath(cleanupFdPath, true)
    const cleanupBeforeManifest = fstatSync(cleanupDescriptor)
    if (!sameIdentity(cleanupBeforeManifest, expectedTransactionIdentity)) {
      fail(`service-aware transaction root 在 manifest 删除前发生替换：${transactionRoot}`)
    }
    await rm(join(cleanupFdPath, 'manifest.json'))
    await fsyncPath(cleanupFdPath, true)
  } finally {
    closeSync(cleanupDescriptor)
  }
  assertLockParentStable(manifest.homePath)
  const transactionBeforeRemove = await lstat(physicalTransactionRoot)
  if (!sameIdentity(transactionBeforeRemove, expectedTransactionIdentity)) {
    fail(`service-aware transaction root 在最终删除前发生替换：${transactionRoot}`)
  }
  await rmdir(physicalTransactionRoot)
  await fsyncPath(LOCK_PARENT_FD_PATH, true)
}

async function recoverServiceTransaction({
  manifest, homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, backupHome,
  homeStat, backupStat, homeIsOriginal, homeIsStaged, backupIsOriginal, serviceContext, dshExecutable,
}) {
  const services = manifest.services
  const serviceMasks = manifest.serviceMasks
  const serviceStartBarriers = manifest.serviceStartBarriers
  const unitUniverse = manifest.unitUniverse
  const foreignOwnership = manifest.foreignOwnership ?? []
  const cleanProfiles = manifest.cleanProfiles ?? []
  const timeouts = serviceTimeouts()
  if (services.length === 0 || services.some(service => typeof service?.unit !== 'string'
    || SYSTEMD_UNIT.exec(service.unit) === null || typeof service.wasActive !== 'boolean'
    || service.serviceHome !== homePath)) fail(`service-aware manifest 中的 inventory 无效：${transactionRoot}`)
  if (!Array.isArray(unitUniverse) || unitUniverse.some(unit => typeof unit !== 'string' || !SYSTEMD_UNIT.test(unit))) {
    fail(`service-aware manifest 中的 unit universe 无效：${transactionRoot}`)
  }
  if (manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION && manifest.operation === 'uninstall' && homeIsStaged) {
    await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
    await assertInstallerCleanWebProfile(physicalHomePath, profile, manifest.cleanProfileDigest)
    await assertArchivedProfile(physicalHomePath, manifest)
    await assertCleanProfileInventory(physicalHomePath, cleanProfiles)
  }
  if (isServiceManifestVersion(manifest.version) && homeIsStaged && manifest.state === 'cleanup-started'
    && manifest.cleanup !== undefined && ['deleting', 'metadata-only'].includes(manifest.cleanup.phase)) {
    await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
    if (manifest.operation === 'uninstall' && manifest.version !== SUPERVISED_SERVICE_MANIFEST_VERSION) {
      await assertInstallerCleanWebProfile(physicalHomePath, profile, manifest.cleanProfileDigest)
    }
    await assertCleanProfileInventory(physicalHomePath, cleanProfiles)
    const acceptanceStillBound = await acceptedServicesStillBound({
      ...serviceContext, services, serviceMasks, serviceStartBarriers, homePath, targetProfile: profile, unitUniverse,
      foreignOwnership, cleanProfiles, acceptance: manifest.serviceAcceptance,
      requireLarkReady: manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION && manifest.operation === 'upgrade',
    })
    if (acceptanceStillBound && manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION && manifest.operation === 'upgrade') {
      await assertPersistedSupervisedAcceptance({
        homePath, profile, dshExecutable, acceptance: manifest.supervisedLifecycle.postSwapAcceptance,
      })
      await assertAcceptedSupervisedInvocation({
        ...serviceContext, services, homePath, dshExecutable, profile,
        acceptance: manifest.supervisedLifecycle.postSwapAcceptance,
      })
    }
    if (acceptanceStillBound) {
      await removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome })
      process.stdout.write('service-aware 生命周期恢复：已完成崩溃中断的绑定清理。\n')
      return 'service-committed'
    }
  }
  manifest = await stopRelatedServices(
    serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
    physicalTransactionRoot, manifest,
  )
  await assertCleanProfileInventory(
    homeIsOriginal ? physicalHomePath : backupIsOriginal ? backupHome : physicalHomePath, cleanProfiles,
  )
  const target = services.find(service => service.profile === profile)
  if (target === undefined) fail(`service-aware manifest 缺少目标 unit：${transactionRoot}`)
  if (manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION && target.wasActive !== true) {
    fail(`supervised lifecycle 要求目标 unit 原本是 active：${transactionRoot}`)
  }
  await assertServiceFilesUnchanged(services)
  const assertCommittedCleanProfile = async () => {
    if (manifest.operation !== 'uninstall') return
    if (typeof manifest.cleanProfileDigest !== 'string') {
      fail(`service-aware uninstall manifest 缺少 clean baseline 绑定：${transactionRoot}`)
    }
    await assertInstallerCleanWebProfile(physicalHomePath, profile, manifest.cleanProfileDigest)
  }
  const supervisedSource = manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION
  const supervisedContext = manifest.version === SUPERVISED_SERVICE_MANIFEST_VERSION && manifest.operation === 'upgrade'
    ? {
        homePath, profile, dshExecutable, supervisedNonce: manifest.supervisedLifecycle.activationNonce,
        supervisedCatalogDigest: manifest.supervisedLifecycle.catalogDigest,
        supervisedPlan: manifest.supervisedLifecycle.activePlan,
        previewAcceptance: manifest.supervisedLifecycle.previewAcceptance,
        supervisedSource: manifest.supervisedLifecycle.source,
      }
    : undefined
  if (supervisedSource && manifest.supervisedLifecycle.source === undefined) {
    const sourceHome = homeIsOriginal ? physicalHomePath : backupIsOriginal ? backupHome : physicalHomePath
    const source = compactSupervisedSnapshot(await runSupervisedOperatorDirect({
      homePath: homeIsOriginal ? homePath : backupIsOriginal ? backupHome : homePath, profile, dshExecutable,
    }, 'attest-active'))
    manifest = await writeManifest(physicalTransactionRoot, {
      ...manifest, ...(manifest.operation === 'uninstall' ? {
        originalProfileTreeDigest: await profileTreeDigest(join(sourceHome, 'profiles', profile)),
      } : {}), servicePhase: 'stopped', supervisedLifecycle: {
        ...manifest.supervisedLifecycle, phase: 'source-attested', databasePaths: source.databasePaths, source,
      },
    }, 'preparing')
  }

  if (homeIsOriginal && backupStat === undefined) {
    await assertProfileDigest(physicalHomePath, profile, manifest.originalProfileDigest)
    manifest = await stopRelatedServices(serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop, physicalTransactionRoot, manifest)
    let sourceAcceptance
    if (supervisedSource) {
      manifest = await persistSourceRestoreAttempt({ manifest, physicalTransactionRoot, homePath, profile, dshExecutable })
      sourceAcceptance = sourceRestoreAcceptance({ manifest, homePath, profile, dshExecutable, timeouts })
    }
    await restoreOriginalActiveSet({
      ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers,
      containmentMasks: manifest.containmentMasks, containmentStartBarriers: manifest.containmentStartBarriers,
      homePath, targetProfile: profile, unitUniverse, foreignOwnership, timeouts,
      cleanProfiles, acceptAfterReady: sourceAcceptance, requireLarkReady: supervisedSource,
    })
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`service-aware 生命周期恢复：原 home 与 active service set 已恢复；证据保留在 ${evidence}\n`)
    return 'service-original-restored'
  }

  if (homeStat === undefined && backupIsOriginal) {
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    manifest = await stopRelatedServices(serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop, physicalTransactionRoot, manifest)
    assertLockParentStable(homePath)
    await moveBoundDirectoryNoReplace(backupHome, physicalHomePath, manifest.originalIdentity,
      { path: physicalTransactionRoot, identity: manifest.transactionIdentity })
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    let sourceAcceptance
    if (supervisedSource) {
      manifest = await persistSourceRestoreAttempt({ manifest, physicalTransactionRoot, homePath, profile, dshExecutable })
      sourceAcceptance = sourceRestoreAcceptance({ manifest, homePath, profile, dshExecutable, timeouts })
    }
    await restoreOriginalActiveSet({
      ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers,
      containmentMasks: manifest.containmentMasks, containmentStartBarriers: manifest.containmentStartBarriers,
      homePath, targetProfile: profile, unitUniverse, foreignOwnership, timeouts,
      cleanProfiles, acceptAfterReady: sourceAcceptance, requireLarkReady: supervisedSource,
    })
    const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    process.stderr.write(`service-aware 生命周期恢复：original-renamed 崩溃已恢复原 home 与 active service set；证据保留在 ${evidence}\n`)
    return 'service-original-restored'
  }

  const cleanupWithoutBackup = homeIsStaged && backupStat === undefined && manifest.state === 'cleanup-started'
  if (homeIsStaged && (backupIsOriginal || cleanupWithoutBackup)) {
    await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
    await assertCommittedCleanProfile()
    await assertCleanProfileInventory(physicalHomePath, cleanProfiles)
    if (backupIsOriginal && manifest.state !== 'cleanup-started') {
      await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    }
    manifest = await stopRelatedServices(serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop, physicalTransactionRoot, manifest)
    let recoveryStartBaseline
    if (supervisedContext !== undefined) {
      recoveryStartBaseline = compactSupervisedSnapshot(await runSupervisedOperatorDirect({
        homePath, profile, dshExecutable,
      }, 'snapshot'), false)
    }
    // cleanup-started is durable before removeCommittedTransaction creates its
    // phase descriptor.  If the backup disappears after that commit point,
    // recovery must keep the outer cleanup state even while it freshly
    // reaccepts services; otherwise a second acceptance failure strands an
    // irreversible transaction as ordinary service-failed residue.
    const resumeCleanup = manifest.state === 'cleanup-started'
    manifest = await writeManifest(physicalTransactionRoot, {
      ...manifest, servicePhase: 'starting',
      ...(supervisedSource ? { supervisedLifecycle: manifest.operation === 'uninstall' ? {
        ...manifest.supervisedLifecycle, phase: 'clean-target-pending',
      } : {
        ...manifest.supervisedLifecycle, phase: 'post-swap-pending', postSwapAcceptance: undefined,
        startAttempt: { kind: 'accept-active', baselineGeneration: recoveryStartBaseline.recoveryProof.bootstrap.generation },
      } } : {}),
    }, resumeCleanup ? 'cleanup-started' : 'swapped')
    let accepted
    try {
      let postSwapProof
      accepted = await startAndAcceptServices({
        ...serviceContext, dshExecutable, services, serviceMasks, homePath, targetProfile: profile,
        unitUniverse, foreignOwnership, cleanProfiles, timeouts,
        requireLarkReady: supervisedContext !== undefined,
        ...(supervisedSource ? { ...(supervisedContext === undefined ? {} : { acceptAfterReady: async () => {
          postSwapProof = await awaitSupervisedDirectSuccessor(supervisedContext, { recoveryProof: { bootstrap: {
            generation: manifest.supervisedLifecycle.startAttempt.baselineGeneration,
          } } }, 'active', timeouts.ready)
        } }), durableAccept: async acceptedStates => {
          const serviceAcceptance = acceptedStates.map(service => ({
            unit: service.unit, invocationId: service.invocationId, mainPid: service.mainPid, nRestarts: service.nRestarts,
          }))
          if (manifest.operation === 'uninstall') {
            manifest = await writeManifest(physicalTransactionRoot, {
              ...manifest, servicePhase: 'service-accepted', serviceAcceptance, serviceFailure: undefined,
              supervisedLifecycle: { ...manifest.supervisedLifecycle, phase: 'clean-target-accepted' },
            }, resumeCleanup ? 'cleanup-started' : 'service-accepted')
            return
          }
          const targetAcceptance = serviceAcceptance.find(service => service.unit === `dsh-profile-${profile}.service`)
          if (targetAcceptance === undefined) fail('supervised durable acceptance 缺少目标 InvocationID。')
          manifest = await writeManifest(physicalTransactionRoot, {
            ...manifest, servicePhase: 'service-accepted', serviceAcceptance, serviceFailure: undefined,
            supervisedLifecycle: {
              ...manifest.supervisedLifecycle, phase: 'post-swap-accepted', postSwapAcceptance: {
                generation: postSwapProof.proof.recoveryProof.bootstrap.generation,
                invocationId: targetAcceptance.invocationId,
                deliveryProof: postSwapProof.proof.deliveryProof, ownerBindingDigest: postSwapProof.proof.ownerBindingDigest,
                unmanagedAutomationsDigest: postSwapProof.proof.unmanagedAutomationsDigest,
                databasePaths: postSwapProof.proof.databasePaths,
                attestationDigest: postSwapProof.snapshot.attestation.attestationDigest,
                recoveryProof: postSwapProof.proof.recoveryProof, automationsProof: postSwapProof.proof.automationsProof,
              },
            },
          }, resumeCleanup ? 'cleanup-started' : 'service-accepted')
        } } : {}),
      })
    } catch (error) {
      if (supervisedContext !== undefined && manifest.supervisedLifecycle.source === undefined) {
        await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'service-failed',
          serviceFailure: `supervised source attestation failed: ${error instanceof Error ? error.message : String(error)}`,
        }, 'service-failed').catch(() => {})
        throw error
      }
      try {
        manifest = await stopRelatedServices(
          serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
          physicalTransactionRoot, manifest,
        )
      } catch {}
      await writeManifest(physicalTransactionRoot, {
        ...manifest, servicePhase: 'service-failed', serviceFailure: error instanceof Error ? error.message : String(error),
      }, resumeCleanup ? 'cleanup-started' : 'service-failed').catch(() => {})
      throw error
    }
    const acceptance = accepted.map(service => ({
      unit: service.unit, invocationId: service.invocationId, mainPid: service.mainPid, nRestarts: service.nRestarts,
    }))
    if (!supervisedSource) {
      manifest = await writeManifest(physicalTransactionRoot, {
        ...manifest, servicePhase: 'service-accepted', serviceAcceptance: acceptance, serviceFailure: undefined,
      }, resumeCleanup ? 'cleanup-started' : 'service-accepted')
    }
    await assertCommittedCleanProfile()
    await assertCleanProfileInventory(physicalHomePath, cleanProfiles)
    await finalizeAcceptedServices({
      ...serviceContext, dshExecutable, services, serviceMasks, containmentMasks: manifest.containmentMasks,
      containmentStartBarriers: manifest.containmentStartBarriers,
      serviceStartBarriers, homePath, targetProfile: profile, unitUniverse, foreignOwnership, cleanProfiles, acceptance,
      requireLarkReady: supervisedContext !== undefined,
      restoreContainedEnablement: manifest.operation !== 'uninstall',
    })
    if (supervisedContext !== undefined) {
      await assertPersistedSupervisedAcceptance({
        homePath, profile, dshExecutable, acceptance: manifest.supervisedLifecycle.postSwapAcceptance,
      })
      await assertAcceptedSupervisedInvocation({
        ...serviceContext, services, homePath, dshExecutable, profile,
        acceptance: manifest.supervisedLifecycle.postSwapAcceptance,
      })
    }
    await assertCommittedCleanProfile()
    await assertCleanProfileInventory(physicalHomePath, cleanProfiles)
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'cleanup-started')
    await removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome })
    process.stdout.write('service-aware 生命周期恢复：swapped home 已重新验收并完成绑定清理。\n')
    return 'service-committed'
  }

  fail(`service-aware 生命周期 home/backup 身份未知；保留证据：${transactionRoot}`)
}

async function processAncestorIds() {
  const identifiers = new Set([process.pid])
  let current = process.pid
  for (;;) {
    let status
    try { status = await readFile(`/proc/${current}/status`, 'utf8') }
    catch { break }
    const parent = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1])
    if (!Number.isSafeInteger(parent) || parent <= 0 || identifiers.has(parent)) break
    identifiers.add(parent)
    current = parent
  }
  return identifiers
}

async function assertNoUnmanagedHomeProcesses(homePath, equivalentHomePaths = []) {
  const roots = [homePath, ...equivalentHomePaths]
  const weakReferenceExempt = await processAncestorIds()
  const proc = await opendir('/proc')
  for await (const entry of proc) {
    if (!/^\d+$/u.test(entry.name) || Number(entry.name) === process.pid) continue
    const processPath = join('/proc', entry.name)
    let status
    try { status = await readFile(join(processPath, 'status'), 'utf8') }
    catch (error) { if (error?.code === 'ENOENT') continue; fail(`无法检查当前用户进程 ${entry.name} 的状态。`) }
    const uid = /^Uid:\s+(\d+)/mu.exec(status)?.[1]
    if (uid !== String(currentUid())) continue
    if (/^State:\s+Z\b/mu.test(status)) continue
    let referenced = false
    if (!weakReferenceExempt.has(Number(entry.name))) {
      try {
        const command = (await readFile(join(processPath, 'cmdline'))).toString().split('\0').filter(Boolean)
        for (const value of command) {
          if (!isAbsolute(value)) continue
          const canonical = await canonicalMissingAllowed(value).catch(() => resolve(value))
          referenced ||= roots.some(root => inside(root, canonical))
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') fail(`无法检查当前用户进程 ${entry.name} 的命令行。`)
      }
      try {
        const environment = await readFile(join(processPath, 'environ'))
        for (const value of environment.toString().split('\0')) {
          if (!value.startsWith('DSH_HOME=')) continue
          const configured = value.slice('DSH_HOME='.length)
          if (isAbsolute(configured)) {
            const canonical = await canonicalMissingAllowed(configured)
            referenced ||= roots.some(root => canonical === root)
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') fail(`无法确认当前用户进程 ${entry.name} 的环境。`)
      }
    }
    for (const name of ['cwd', 'root']) {
      try {
        const canonical = await realpath(join(processPath, name))
        referenced ||= roots.some(root => inside(root, canonical))
      }
      catch (error) { if (error?.code !== 'ENOENT') fail(`无法确认当前用户进程 ${entry.name} 的 ${name}。`) }
    }
    for (const directory of ['fd']) {
      try {
        const handles = await opendir(join(processPath, directory))
        for await (const handle of handles) {
          try {
            const canonical = await realpath(join(processPath, directory, handle.name))
            referenced ||= roots.some(root => inside(root, canonical))
          }
          catch (error) { if (error?.code !== 'ENOENT') fail(`无法确认当前用户进程 ${entry.name} 的 ${directory} 引用。`) }
        }
      } catch (error) { if (error?.code !== 'ENOENT') fail(`无法枚举当前用户进程 ${entry.name} 的 ${directory}。`) }
    }
    try {
      const maps = await readFile(join(processPath, 'maps'), 'utf8')
      for (const line of maps.split('\n')) {
        const mapped = /\s(\/.*)$/u.exec(line)?.[1]?.replace(/ \(deleted\)$/u, '')
        if (mapped === undefined) continue
        const canonical = await canonicalMissingAllowed(mapped).catch(() => resolve(mapped))
        referenced ||= roots.some(root => inside(root, canonical))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(`无法确认当前用户进程 ${entry.name} 的内存映射。`)
    }
    if (referenced) fail(`检测到 systemd inventory 之外的当前用户进程仍引用 DSH_HOME；拒绝继续：PID ${entry.name}`)
  }
}

async function assertServiceProfileScenario({ dshExecutable, profile, homePath, targetProfile, expectedScenario }) {
  const { scenario } = await readLifecycleConfig({ dshExecutable, profile, homePath })
  if (profile === targetProfile && expectedScenario === 'supervised') {
    if (scenario !== 'supervised') fail(`目标 systemd profile 必须保持 supervised：${profile}:${scenario}`)
    return undefined
  }
  if (scenario === 'lark') return undefined
  if (scenario === 'unsupported') return await assertInstallerCleanWebProfile(homePath, profile)
  fail(`受管 systemd sibling 必须是标准 Lark 或 installer clean baseline：${profile}:${scenario}`)
}

async function assertCleanProfileInventory(homePath, cleanProfiles = []) {
  for (const entry of cleanProfiles) {
    await assertInstallerCleanWebProfile(homePath, entry.profile, entry.digest)
  }
}

async function readLifecycleConfig({ dshExecutable, profile, homePath }) {
  const dumped = await run(dshExecutable, ['--profile', profile, '--dump-config'], {
    capture: true, env: { ...process.env, DSH_HOME: homePath },
  })
  return {
    source: dumped.stdout,
    scenario: await classifyLifecycleScenario(dumped.stdout, { dshExecutable }),
  }
}

async function assertLockedLifecycleScenario({ dshExecutable, profile, homePath, expectedScenario, serviceAware, operation = 'upgrade' }) {
  const { scenario } = await readLifecycleConfig({ dshExecutable, profile, homePath })
  if (scenario === 'unsupported' && expectedScenario !== 'unsupported') {
    fail('实际 effective/composed profile 无法安全归类为 web、autonomy 或已启用 Lark；拒绝 lifecycle 操作。')
  }
  if (expectedScenario !== undefined && scenario !== expectedScenario) {
    fail(`声明的 lifecycle scenario ${expectedScenario} 与实际 effective/composed profile 场景 ${scenario} 不一致；拒绝 lifecycle 操作。`, 2)
  }
  if (serviceAware && scenario !== 'lark' && scenario !== 'supervised'
    && !(operation === 'uninstall' && scenario === 'unsupported')) {
    fail('service-aware lifecycle 要求原 profile 为 active Lark/supervised，或要求已提交 uninstall 的目标 profile 为 clean unsupported。')
  }
  if (!serviceAware && (scenario === 'lark' || scenario === 'supervised')) {
    fail('检测到实际 effective/composed profile 含 active Lark/supervised channel；必须使用 service-aware lifecycle。')
  }
  return scenario
}

async function restoreOriginalActiveSet({
  systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks, serviceStartBarriers,
  containmentMasks = [], containmentStartBarriers = [],
  homePath, targetProfile, unitUniverse, foreignOwnership = [], cleanProfiles = [], timeouts, acceptAfterReady,
  requireLarkReady = false,
}) {
  await assertServiceFilesUnchanged(services)
  const accepted = await startAndAcceptServices({
    systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks,
    homePath, targetProfile, unitUniverse, foreignOwnership, cleanProfiles, timeouts, acceptAfterReady, requireLarkReady,
  })
  await finalizeAcceptedServices({
    systemctlExecutable, journalctlExecutable, dshExecutable, services, serviceMasks, serviceStartBarriers,
    containmentMasks, containmentStartBarriers, homePath, targetProfile, unitUniverse, foreignOwnership, cleanProfiles, acceptance: accepted,
    requireLarkReady,
  })
  return accepted
}

function sandboxArgs({ bwrapExecutable, homePath, validatorPath, command, extraEnvironment = {} }) {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp', '--tmpfs', '/run',
    '--dir', homePath,
    '--bind-fd', '3', homePath,
    '--perms', '0400', '--ro-bind-data', '4', validatorPath,
    '--proc', '/proc', '--dev', '/dev',
    '--chdir', process.cwd(),
    '--clearenv',
    '--setenv', 'PATH', process.env.PATH ?? '/usr/bin:/bin',
    '--setenv', 'HOME', process.env.HOME ?? dirname(homePath),
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'DSH_HOME', homePath,
  ]
  for (const [name, value] of Object.entries(extraEnvironment)) args.push('--setenv', name, value)
  args.push('--', ...command)
  return { executable: bwrapExecutable, args }
}

async function openSandboxResources(context) {
  const stage = await open(context.stageHome, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let validator
  try {
    validator = await open(VALIDATOR_PATH, constants.O_RDONLY | constants.O_NOFOLLOW)
    const validatorStat = await validator.stat()
    if (!validatorStat.isFile() || validatorStat.uid !== currentUid() || validatorStat.nlink !== 1
      || isGroupOrOtherWritable(validatorStat) || validatorStat.size > 4 * 1024 * 1024) {
      fail(`生命周期 validator 身份或权限不安全：${VALIDATOR_PATH}`)
    }
    return { stage, validator }
  } catch (error) {
    await stage.close()
    await validator?.close()
    throw error
  }
}

async function sandboxRun(context, command, options = {}) {
  const resources = await openSandboxResources(context)
  const invocation = sandboxArgs({
    ...context, validatorPath: SANDBOX_VALIDATOR_PATH, command, extraEnvironment: options.extraEnvironment,
  })
  try {
    return await run(invocation.executable, invocation.args, {
      capture: options.capture,
      passFds: [resources.stage.fd, resources.validator.fd],
    })
  } finally {
    await resources.validator.close()
    await resources.stage.close()
  }
}

function parseJsonOutput(source, label) {
  try { return JSON.parse(source) }
  catch { fail(`supervised lifecycle ${label} 返回无效 JSON。`) }
}

function compactDatabaseProof(snapshot) {
  return {
    protocol: snapshot.protocol, schemaVersion: snapshot.schemaVersion,
    database: snapshot.database, snapshotDigest: snapshot.snapshotDigest
      ?? sha256(JSON.stringify({
        protocol: snapshot.protocol, schemaVersion: snapshot.schemaVersion,
        database: snapshot.database, sidecars: snapshot.sidecars,
        inFlightCount: snapshot.inFlightCount, inventoryDigest: snapshot.inventoryDigest, records: snapshot.records,
      })),
    ...(validDigest(snapshot.storageDigest) ? { storageDigest: snapshot.storageDigest } : {}),
    ...(validDigest(snapshot.inventoryDigest) ? { inventoryDigest: snapshot.inventoryDigest } : {}),
  }
}

function compactSupervisedSnapshot(snapshot, requireAttestation = true) {
  const recoveryBootstrap = snapshot.recovery?.bootstrap
  if (snapshot.delivery?.protocol !== 'assistant-delivery/active-lark-owner-bindings-snapshot/v1'
    || snapshot.recovery?.protocol !== 'assistant-recovery/operator-snapshot/v1'
    || snapshot.automations?.protocol !== 'assistant-automations-operator-snapshot/v1'
    || snapshot.delivery.bindings?.length !== 1
    || !Number.isSafeInteger(recoveryBootstrap?.generation) || recoveryBootstrap.generation < 0
    || requireAttestation && (snapshot.automations.inFlightCount !== 0
      || recoveryBootstrap.status !== 'succeeded' || recoveryBootstrap.attestationValid !== true
      || recoveryBootstrap.generation < 1)
    || snapshot.managedProjection?.protocol !== 'dsh-enhanced/supervised-growth-managed-automations/v1'
    || !validDigest(snapshot.managedProjection.digest)
    || !validDigest(snapshot.ownerBindingDigest)
    || requireAttestation && (snapshot.attestation?.protocol !== 'dsh-enhanced/supervised-growth-lifecycle-attestation/v1'
      || !validDigest(snapshot.attestation.attestationDigest)
      || !Array.isArray(snapshot.attestation.externalProviderExemptions))
    || !validDigest(snapshot.effectiveConfigDigest) || !validDigest(snapshot.semanticDigest)) {
    fail('supervised lifecycle operator snapshot 不完整或协议不受支持。')
  }
  return {
    effectiveConfigDigest: snapshot.effectiveConfigDigest, semanticDigest: snapshot.semanticDigest,
    databasePaths: snapshot.databasePaths,
    deliveryProof: compactDatabaseProof(snapshot.delivery),
    recoveryProof: { ...compactDatabaseProof(snapshot.recovery), bootstrap: {
      status: recoveryBootstrap.status, generation: recoveryBootstrap.generation,
      attestationValid: recoveryBootstrap.attestationValid,
      attestationSetDigest: recoveryBootstrap.attestationSetDigest,
      attestations: recoveryBootstrap.attestations,
    } },
    automationsProof: compactDatabaseProof(snapshot.automations),
    unmanagedAutomationsDigest: unmanagedAutomationDigest(snapshot.automations.records),
    ownerBindingDigest: snapshot.ownerBindingDigest,
    ...(requireAttestation ? {
      activePlan: {
        effectiveConfigDigest: snapshot.attestation.effectiveConfigDigest,
        attestationSetDigest: snapshot.attestation.recovery.bootstrapAttestationSetDigest,
        managedInventoryDigest: snapshot.managedProjection.digest,
        attestationDigest: snapshot.attestation.attestationDigest,
        activationNonceDigest: snapshot.attestation.recovery.activationNonceDigest,
        catalogDigest: snapshot.attestation.recovery.catalogDigest,
      },
    } : {}),
  }
}

function sameDatabaseLocation(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode
}

function assertPostSwapDatabaseLocations(preview, active) {
  if (JSON.stringify(preview.databasePaths) !== JSON.stringify(active.databasePaths)) {
    fail('post-swap supervised database paths 与 preview 不一致。')
  }
  if (!sameDatabaseLocation(preview.deliveryProof.database, active.deliveryProof.database)
    || !sameDatabaseLocation(preview.recoveryProof.database, active.recoveryProof.database)
    || !sameDatabaseLocation(preview.automationsProof.database, active.automationsProof.database)) {
    fail('post-swap supervised DB 身份与 preview 验收的 staged DB 不一致。')
  }
}

function assertCopiedSupervisedSnapshot(source, copied) {
  if (JSON.stringify(source.databasePaths) !== JSON.stringify(copied.databasePaths)
    || source.effectiveConfigDigest !== copied.effectiveConfigDigest
    || source.semanticDigest !== copied.semanticDigest
    || source.deliveryProof.storageDigest !== copied.deliveryProof.storageDigest
    || source.recoveryProof.database.digest !== copied.recoveryProof.database.digest
    || source.automationsProof.database.digest !== copied.automationsProof.database.digest
    || source.automationsProof.storageDigest !== copied.automationsProof.storageDigest
    || source.automationsProof.inventoryDigest !== copied.automationsProof.inventoryDigest) {
    fail('copied supervised state 与 stopped source 的配置/DB semantic snapshot 不一致。')
  }
}

function assertSupervisedOwnerBindingStable(source, current) {
  if (JSON.stringify(source.databasePaths) !== JSON.stringify(current.databasePaths)
    || source.ownerBindingDigest !== current.ownerBindingDigest
    || source.unmanagedAutomationsDigest !== current.unmanagedAutomationsDigest) {
    fail('supervised owner binding 或非受管 Automation 在 lifecycle phase 间发生变化。')
  }
}

function assertSupervisedAcceptanceStable(expected, current) {
  const checks = {
    generation: current.recoveryProof.bootstrap.generation === expected.generation,
    attestation: current.recoveryProof.bootstrap.attestationSetDigest === expected.recoveryProof.bootstrap.attestationSetDigest,
    automationStorage: current.automationsProof.storageDigest === expected.automationsProof.storageDigest,
    automationInventory: current.automationsProof.inventoryDigest === expected.automationsProof.inventoryDigest,
    unmanagedAutomations: current.unmanagedAutomationsDigest === expected.unmanagedAutomationsDigest,
    owner: current.ownerBindingDigest === expected.ownerBindingDigest,
    paths: JSON.stringify(current.databasePaths) === JSON.stringify(expected.databasePaths),
  }
  if (Object.values(checks).includes(false)) fail(`supervised active proof 在稳定/cleanup 前发生漂移：${JSON.stringify(checks)}`)
}

function sourceSupervisedIdentity(source) {
  const matches = source.recoveryProof.bootstrap.attestations.filter(
    attestation => attestation.automationId === 'recovery:supervised-growth'
      && attestation.activationState === 'active',
  )
  if (matches.length !== 1 || typeof matches[0].activationNonce !== 'string') {
    fail('supervised source 缺少唯一 active Recovery identity。')
  }
  return { nonce: matches[0].activationNonce, catalogDigest: source.activePlan.catalogDigest }
}

function sourceSupervisedPlan(source) {
  return { ...source.activePlan, ownerBindingDigest: source.ownerBindingDigest }
}

async function persistSourceRestoreAttempt({ manifest, physicalTransactionRoot, homePath, profile, dshExecutable }) {
  const raw = compactSupervisedSnapshot(await runSupervisedOperatorDirect({ homePath, profile, dshExecutable }, 'snapshot'), false)
  const lifecycle = manifest.operation === 'uninstall' ? {
    ...manifest.supervisedLifecycle, phase: 'source-attested',
    startAttempt: { kind: 'restore-source', baselineGeneration: raw.recoveryProof.bootstrap.generation },
  } : {
    ...manifest.supervisedLifecycle, phase: 'source-attested', catalogDigest: undefined,
    previewPlan: undefined, previewAcceptance: undefined, activePlan: undefined, postSwapAcceptance: undefined,
    startAttempt: { kind: 'restore-source', baselineGeneration: raw.recoveryProof.bootstrap.generation },
  }
  return await writeManifest(physicalTransactionRoot, {
    ...manifest, servicePhase: 'starting', supervisedLifecycle: lifecycle,
  }, 'preparing')
}

function sourceRestoreAcceptance({ manifest, homePath, profile, dshExecutable, timeouts }) {
  const source = manifest.supervisedLifecycle.source
  const identity = sourceSupervisedIdentity(source)
  return async () => {
    await awaitSupervisedDirectSuccessor({
      homePath, profile, dshExecutable, supervisedNonce: identity.nonce,
      supervisedCatalogDigest: identity.catalogDigest, supervisedPlan: sourceSupervisedPlan(source),
      supervisedSource: source,
    }, { recoveryProof: { bootstrap: { generation: manifest.supervisedLifecycle.startAttempt.baselineGeneration } } },
    'active', timeouts.ready)
  }
}

function supervisedPreviewOverlayPaths(context) {
  const name = `.dsh-enhanced-disable-lark-${context.transactionId}.yml`
  return {
    name,
    stagePath: join(context.stageHome, name),
    logicalPath: join(context.homePath, name),
  }
}

function supervisedPreviewOverlayEnvironment(paths) {
  return { DSH_ENHANCED_SUPERVISED_PREVIEW_OVERLAY: paths.logicalPath }
}

async function runSupervisedOperator(context, action, nonce, extraEnvironment) {
  const result = await sandboxRun(context, [
    process.execPath, '--input-type=module', '--eval', SUPERVISED_OPERATOR_PROGRAM,
    action, context.homePath, context.profile, context.dshExecutable, ...(nonce === undefined ? [] : [nonce]),
  ], { capture: true, extraEnvironment: extraEnvironment ?? context.supervisedOperatorEnvironment })
  return parseJsonOutput(result.stdout, action)
}

async function runSupervisedOperatorDirect(context, action, nonce) {
  const { homePath, profile, dshExecutable } = context
  const effectiveNonce = nonce ?? context.supervisedNonce
  const result = await run(process.execPath, [
    '--input-type=module', '--eval', SUPERVISED_OPERATOR_PROGRAM,
    action, homePath, profile, dshExecutable, ...(effectiveNonce === undefined ? [] : [effectiveNonce]),
  ], { capture: true, env: { ...process.env, DSH_HOME: homePath } })
  return parseJsonOutput(result.stdout, action)
}

function validSupervisedCapabilityProof(proof) {
  return typeof proof === 'object' && proof !== null
    && proof.protocol === 'dsh-enhanced/supervised-lifecycle-capability/v1'
    && Object.keys(proof).length === 1
}

async function assertSupervisedLifecycleCapability(homePath, profile) {
  let result
  try {
    result = await run(process.execPath, [
      '--input-type=module', '--eval', SUPERVISED_CAPABILITY_PROGRAM, homePath, profile,
    ], { capture: true, env: { ...process.env, DSH_HOME: homePath } })
  } catch (error) {
    fail(`当前 supervised source 缺少安全升级所需的只读 operator/attestation seam；请先安装支持该协议的 cohort：${error instanceof Error ? error.message : String(error)}`)
  }
  const proof = parseJsonOutput(result.stdout, 'capability')
  if (!validSupervisedCapabilityProof(proof)) {
    fail('supervised lifecycle capability proof 无效。')
  }
}

async function assertPersistedSupervisedAcceptance({ homePath, profile, dshExecutable, acceptance }) {
  const snapshot = await runSupervisedOperatorDirect({ homePath, profile, dshExecutable }, 'attest-active')
  const proof = compactSupervisedSnapshot(snapshot)
  assertSupervisedAcceptanceStable(acceptance, proof)
  if (snapshot.attestation.attestationDigest !== acceptance.attestationDigest) {
    fail('supervised active attestation digest 在 cleanup 前发生漂移。')
  }
}

async function assertAcceptedSupervisedInvocation({
  systemctlExecutable, journalctlExecutable, services, homePath, dshExecutable, profile, acceptance,
}) {
  const current = await readServiceStates(systemctlExecutable, services, homePath, dshExecutable)
  const target = current.find(service => service.profile === profile)
  if (target === undefined || target.invocationId !== acceptance.invocationId
    || !LARK_ACCEPTED_STATES.has(await latestLarkJournalState(journalctlExecutable, target))) {
    fail('supervised cleanup 前的 InvocationID/Lark latest state 与 durable acceptance 不一致。')
  }
}

async function startSandboxHost(context) {
  const resources = await openSandboxResources(context)
  const overlay = supervisedPreviewOverlayPaths(context)
  let stagedOverlay
  try {
    stagedOverlay = await readFile(overlay.stagePath)
  } catch {
    await resources.validator.close(); await resources.stage.close()
    fail('supervised preview runtime overlay 在 Host 启动前缺失。')
  }
  if (sha256(stagedOverlay) !== context.supervisedPlan.runtimeOverlayDigest) {
    await resources.validator.close(); await resources.stage.close()
    fail('supervised preview runtime overlay digest 不匹配。')
  }
  const invocation = sandboxArgs({
    ...context, validatorPath: SANDBOX_VALIDATOR_PATH,
    command: [context.dshExecutable, '--profile', context.profile, '--patch', overlay.logicalPath,
      '--host', '127.0.0.1', '--no-open', '--port', '0'],
  })
  const child = spawn(invocation.executable, invocation.args, {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe', resources.stage.fd, resources.validator.fd],
  })
  let stdout = ''; let stderr = ''; let closed = false; let closeCode
  child.stdout.on('data', chunk => { if (stdout.length < 1024 * 1024) stdout += String(chunk) })
  child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += String(chunk) })
  child.once('close', code => { closed = true; closeCode = code })
  const close = async () => {
    if (!closed) child.kill('SIGTERM')
    const deadline = Date.now() + 2_000
    while (!closed && Date.now() < deadline) await delay(25)
    if (!closed) child.kill('SIGKILL')
    while (!closed) await delay(25)
    await resources.validator.close(); await resources.stage.close()
  }
  const readyDeadline = Date.now() + 30_000
  while (!stdout.includes(READY_MARKER)) {
    if (closed) { await close(); fail(`supervised 隔离 Host 激活失败（exit ${closeCode ?? 1}）${stderr === '' ? '' : `：${stderr.trim()}`}`) }
    if (Date.now() >= readyDeadline) { await close(); fail('supervised 隔离 Host 在 30 秒内未就绪。') }
    await delay(25)
  }
  return { child, close, closed: () => closed }
}

async function awaitSupervisedSuccessor(context, baseline, stage, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds
  let lastError
  for (;;) {
    try {
      if (context.host?.closed()) fail('supervised preview Host exited before attestation completed.')
      const snapshot = await runSupervisedOperator(context, `attest-${stage}`)
      const proof = compactSupervisedSnapshot(snapshot)
      assertSupervisedOwnerBindingStable(context.supervisedSource, proof)
      if (proof.recoveryProof.bootstrap.generation <= baseline.recoveryProof.bootstrap.generation) {
        fail(`supervised Recovery ${stage} generation 未严格前进。`)
      }
      const expectedNonceDigest = sha256(context.supervisedNonce)
      const attestation = snapshot.attestation
      if (attestation?.stage !== stage || attestation.recovery?.activationNonceDigest !== expectedNonceDigest
        || attestation.recovery?.catalogDigest !== context.supervisedCatalogDigest
        || attestation.effectiveConfigDigest !== context.supervisedPlan.effectiveConfigDigest
        || attestation.recovery.bootstrapAttestationSetDigest !== context.supervisedPlan.attestationSetDigest
        || snapshot.managedProjection?.digest !== context.supervisedPlan.managedInventoryDigest
        || proof.ownerBindingDigest !== context.supervisedPlan.ownerBindingDigest
        || JSON.stringify(attestation.externalProviderExemptions) !== JSON.stringify(stage === 'preview' ? ['larkChannel'] : [])) {
        fail(`supervised Recovery ${stage} attestation 未绑定本事务 nonce/catalog。`)
      }
      if (context.host?.closed()) fail('supervised preview Host exited before acceptance.')
      return { snapshot, proof }
    } catch (error) { lastError = error }
    if (Date.now() >= deadline) throw lastError
    await delay(Math.min(SUPERVISED_POLL_INTERVAL_MS, deadline - Date.now()))
  }
}

async function awaitSupervisedDirectSuccessor(context, baseline, stage, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  let lastError
  for (;;) {
    try {
      const snapshot = await runSupervisedOperatorDirect(context, `attest-${stage}`, context.supervisedNonce)
      const proof = compactSupervisedSnapshot(snapshot)
      assertSupervisedOwnerBindingStable(context.supervisedSource, proof)
      if (proof.recoveryProof.bootstrap.generation <= baseline.recoveryProof.bootstrap.generation) {
        fail(`supervised Recovery ${stage} generation 未严格前进。`)
      }
      if (snapshot.attestation?.stage !== stage
        || snapshot.attestation.recovery?.activationNonceDigest !== sha256(context.supervisedNonce)
        || snapshot.attestation.recovery?.catalogDigest !== context.supervisedCatalogDigest
        || snapshot.attestation.effectiveConfigDigest !== context.supervisedPlan.effectiveConfigDigest
        || snapshot.attestation.recovery.bootstrapAttestationSetDigest !== context.supervisedPlan.attestationSetDigest
        || snapshot.managedProjection?.digest !== context.supervisedPlan.managedInventoryDigest
        || proof.ownerBindingDigest !== context.supervisedPlan.ownerBindingDigest
        || JSON.stringify(snapshot.attestation.externalProviderExemptions) !== JSON.stringify(stage === 'preview' ? ['larkChannel'] : [])) {
        fail(`supervised Recovery ${stage} attestation 未绑定本事务 nonce/catalog/plan：`
          + JSON.stringify({
            nonce: snapshot.attestation?.recovery?.activationNonceDigest === sha256(context.supervisedNonce),
            catalog: snapshot.attestation?.recovery?.catalogDigest === context.supervisedCatalogDigest,
            config: snapshot.attestation?.effectiveConfigDigest === context.supervisedPlan.effectiveConfigDigest,
            bootstrap: snapshot.attestation?.recovery?.bootstrapAttestationSetDigest === context.supervisedPlan.attestationSetDigest,
            managed: snapshot.managedProjection?.digest === context.supervisedPlan.managedInventoryDigest,
            owner: proof.ownerBindingDigest === context.supervisedPlan.ownerBindingDigest,
          }))
      }
      if (context.previewAcceptance !== undefined) {
        assertPostSwapDatabaseLocations(context.previewAcceptance, proof)
      }
      return { snapshot, proof }
    } catch (error) { lastError = error }
    if (Date.now() >= deadline) throw lastError
    await delay(Math.min(SUPERVISED_POLL_INTERVAL_MS, deadline - Date.now()))
  }
}

async function validateComposedConfig(context, label) {
  const dumped = await sandboxRun(context, [context.dshExecutable, '--profile', context.profile, '--dump-config'], { capture: true })
  const physicalPath = join(context.stageHome, `.dsh-enhanced-${label}-${context.transactionId}.yml`)
  const logicalPath = join(context.homePath, basename(physicalPath))
  await writeFile(physicalPath, dumped.stdout, { mode: 0o600, flag: 'wx' })
  try {
    const validationProgram = [
      "import { readFile } from 'node:fs/promises'",
      "import { pathToFileURL } from 'node:url'",
      'const [validatorPath, sourcePath, dshHome, dshExecutable] = process.argv.slice(1)',
      'const { validateLifecycleConfig } = await import(pathToFileURL(validatorPath).href)',
      'await validateLifecycleConfig(await readFile(sourcePath, "utf8"), { dshHome, dshExecutable })',
    ].join(';')
    await sandboxRun(context, [
      process.execPath, '--input-type=module', '--eval', validationProgram,
      SANDBOX_VALIDATOR_PATH, logicalPath, context.homePath, context.dshExecutable,
    ])
  } finally {
    await rm(physicalPath, { force: true })
  }
  const scenario = await classifyLifecycleScenario(dumped.stdout, { dshExecutable: context.dshExecutable })
  if (scenario !== context.expectedScenario) {
    fail(`隔离副本 ${label} 的 lifecycle scenario ${scenario} 与预期 ${context.expectedScenario} 不一致；拒绝提交。`)
  }
  return scenario
}

async function activateInSandbox(context) {
  const resources = await openSandboxResources(context)
  const invocation = sandboxArgs({
    ...context,
    validatorPath: SANDBOX_VALIDATOR_PATH,
    command: [context.dshExecutable, '--profile', context.profile, '--host', '127.0.0.1', '--no-open', '--port', '0'],
  })
  try { await new Promise((resolveActivation, rejectActivation) => {
    const child = spawn(invocation.executable, invocation.args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', resources.stage.fd, resources.validator.fd],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let ready = false
    let timedOut = false
    let forceTimer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceTimer !== undefined) clearTimeout(forceTimer)
      if (error === undefined) resolveActivation()
      else rejectActivation(error)
    }
    const stopAfterReady = () => {
      if (settled || ready) return
      ready = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      forceTimer.unref()
    }
    child.stdout.on('data', chunk => {
      if (stdout.length < 1024 * 1024) stdout += String(chunk)
      if (stdout.includes(READY_MARKER)) stopAfterReady()
    })
    child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += String(chunk) })
    child.once('error', error => finish(error))
    child.once('close', code => {
      if (ready || stdout.includes(READY_MARKER)) finish()
      else if (timedOut) finish(new LifecycleError('隔离 Host 激活在 30 秒内未就绪。'))
      else finish(new LifecycleError(`隔离 Host 激活失败（exit ${code ?? 1}）${stderr === '' ? '' : `：${stderr.trim()}`}`))
    })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      forceTimer.unref()
    }, 30_000)
  }) } finally {
    await resources.validator.close()
    await resources.stage.close()
  }
}

async function readProfile(homePath, profile) {
  const homeStat = await assertOwnedPrivateDirectory(homePath)
  const profilesPath = join(homePath, 'profiles')
  const profilesStat = await assertOwnedPrivateDirectory(profilesPath)
  const profilePath = join(homePath, 'profiles', profile)
  const profileStat = await lstat(profilePath).catch(() => undefined)
  if (profileStat === undefined) {
    fail(`生命周期操作需要已存在的真实 profile 目录：${profilePath}`)
  }
  assertOwnedPrivateEntry(profileStat, profilePath, 'directory')
  const manifestPath = join(profilePath, 'package.json')
  const manifestStat = await lstat(manifestPath).catch(() => undefined)
  if (manifestStat === undefined) fail(`profile manifest 必须是普通文件：${manifestPath}`)
  assertOwnedPrivateEntry(manifestStat, manifestPath, 'file')
  if (manifestStat.nlink !== 1 || manifestStat.size > 4 * 1024 * 1024) fail(`profile manifest 身份或大小不安全：${manifestPath}`)
  const source = await readFile(manifestPath)
  let manifest
  try { manifest = JSON.parse(source) } catch { fail(`profile manifest 不是有效 JSON：${manifestPath}`) }
  return { homeStat, profilesPath, profilesStat, profilePath, profileStat, manifestPath, source, manifest }
}

async function assertProfileTreeIdentity(current) {
  await assertCriticalDirectory(current.profilesPath, identity(current.profilesStat))
  await assertCriticalDirectory(current.profilePath, identity(current.profileStat))
}

function managedNames(profileManifest) {
  return Object.keys(profileManifest.dependencies ?? {}).filter(name => MANAGED_PACKAGE.test(name)).sort()
}

function thirdPartyBundles(profileManifest) {
  const bundles = profileManifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) fail('profile manifest 缺少有效的 dsh.profile.bundles。')
  return bundles.filter(name => typeof name !== 'string' || (!ALLOWED_WEB_BUNDLES.has(name) && !MANAGED_PACKAGE.test(name)))
}

async function validateUpgradeTargets(targets, expectedNames) {
  const actualNames = []
  for (const target of targets) {
    if (isAbsolute(target)) {
      let targetManifest
      try { targetManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) }
      catch { fail(`无法读取升级目标 manifest：${target}`) }
      if (typeof targetManifest.name !== 'string' || !MANAGED_PACKAGE.test(targetManifest.name)) fail(`升级目标不是 @dsh-enhanced/* bundle：${target}`)
      actualNames.push(targetManifest.name)
      continue
    }
    const match = MANAGED_EXACT_SPEC.exec(target)
    if (match === null) fail(`升级目标必须是本地绝对路径或精确版本的 @dsh-enhanced/* 包：${target}`)
    actualNames.push(match[1])
  }
  const actual = [...new Set(actualNames)].sort()
  if (actual.length !== actualNames.length || JSON.stringify(actual) !== JSON.stringify(expectedNames)) {
    fail(`升级目标必须精确匹配当前已安装的受管顶层依赖；expected=${expectedNames.join(',')} actual=${actual.join(',')}`)
  }
}

function parseSingleExactNpmVersion(source, packageSpec) {
  let parsed
  try { parsed = JSON.parse(source) }
  catch { fail(`npm 为 ${packageSpec} 返回了无效的版本数据。`) }
  if (typeof parsed !== 'string' || !EXACT_SEMVER.test(parsed)) {
    fail(`npm 为 ${packageSpec} 返回了非单一精确 SemVer。`)
  }
  return parsed
}

async function resolveNpmUpgradeCohort({ npmExecutable, selector, expectedNames }) {
  if (!EXACT_SEMVER.test(selector) && !NARROW_DIST_TAG.test(selector)) {
    fail('插件版本必须是精确 SemVer 或 npm dist-tag；不支持 range。', 2)
  }
  const anchorSpec = `${NPM_COHORT_ANCHOR}@${selector}`
  let anchorResult
  try { anchorResult = await run(npmExecutable, ['view', anchorSpec, 'version', '--json'], { capture: true }) }
  catch { fail(`无法从 npm 解析 ${anchorSpec} 的版本。`) }
  const version = parseSingleExactNpmVersion(anchorResult.stdout, anchorSpec)
  process.stdout.write(`npm cohort：${anchorSpec} 解析为精确版本 ${version}。\n`)
  const targets = []
  for (const name of expectedNames) {
    const packageSpec = `${name}@${version}`
    let result
    try { result = await run(npmExecutable, ['view', packageSpec, 'version', '--json'], { capture: true }) }
    catch { fail(`npm 未发布所需 cohort bundle：${packageSpec}。尚未修改 profile。`) }
    if (parseSingleExactNpmVersion(result.stdout, packageSpec) !== version) {
      fail(`npm 未发布所需 cohort bundle：${packageSpec}。尚未修改 profile。`)
    }
    targets.push(packageSpec)
  }
  process.stdout.write(`npm cohort：已核验 ${targets.length} 个 bundle 均为 ${version}。\n`)
  return targets
}

function assertExpectedScenario(expectedScenario, serviceAware, operation = 'upgrade') {
  const emptyUninstall = !serviceAware && operation === 'uninstall' && expectedScenario === 'unsupported'
  if (!LIFECYCLE_SCENARIOS.has(expectedScenario) && !emptyUninstall) {
    fail('lifecycle expected scenario must be web, autonomy, lark, or supervised', 2)
  }
  if (serviceAware !== (expectedScenario === 'lark' || expectedScenario === 'supervised')) {
    fail(serviceAware
      ? 'service-aware lifecycle expected scenario must be lark or supervised'
      : 'ordinary lifecycle expected scenario must be web or autonomy', 2)
  }
}

async function performNpmUpgrade({
  profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, npmExecutable, pnpmExecutable, selector,
}) {
  if (!PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid npm lifecycle invocation', 2)
  assertExpectedScenario(expectedScenario, false)
  const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
  const recovery = await recoverBoundTransaction({
    homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, dshExecutable,
  })
  await assertLockedLifecycleScenario({ dshExecutable, profile, homePath, expectedScenario, serviceAware: false })
  if (recovery !== undefined) {
    fail('已恢复或隔离上次生命周期事务；本次未访问 npm registry。请确认 DSH_HOME 仍已停止后重试 upgrade。')
  }
  const current = await readProfile(physicalHomePath, profile)
  const expectedManaged = managedNames(current.manifest)
  if (expectedManaged.length === 0) fail('当前 profile 没有可升级的 @dsh-enhanced/* 顶层依赖。')
  const thirdParty = thirdPartyBundles(current.manifest)
  if (thirdParty.length > 0) fail(`检测到无法证明状态路径的第三方顶层 bundle，拒绝 upgrade：${thirdParty.join(', ')}`)
  const npmPath = await realpath(npmExecutable).catch(() => fail('npm executable must exist'))
  const pnpmPath = await realpath(pnpmExecutable).catch(() => fail('pnpm executable must exist'))
  const targets = await resolveNpmUpgradeCohort({ npmExecutable: npmPath, selector, expectedNames: expectedManaged })
  process.stdout.write(`npm cohort：正在生命周期锁内预取精确版本；DSH_HOME 尚未修改。\n`)
  try {
    await run(pnpmPath, ['store', 'add', ...targets], { env: { ...process.env, npm_config_ignore_scripts: 'true' } })
  } catch {
    fail('npm cohort 预取失败；尚未创建事务或修改 DSH_HOME。')
  }
  await performLifecycle({
    operation: 'upgrade', profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets,
    skipRecovery: true, transactionPrechecked: true,
  })
}

async function performNpmServiceUpgrade({
  profile, homePath, dshExecutable, bwrapExecutable, expectedScenario,
  systemctlExecutable, journalctlExecutable, npmExecutable, pnpmExecutable, selector,
}) {
  assertExpectedScenario(expectedScenario, true)
  const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
  const recovery = await recoverBoundTransaction({
    homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot,
    serviceContext: { systemctlExecutable, journalctlExecutable }, dshExecutable,
  })
  await assertLockedLifecycleScenario({ dshExecutable, profile, homePath, expectedScenario, serviceAware: true })
  if (recovery !== undefined) fail('已恢复上次生命周期事务；本次未访问 npm registry，请重试 upgrade。')
  if (expectedScenario === 'supervised') await assertSupervisedLifecycleCapability(homePath, profile)
  const current = await readProfile(physicalHomePath, profile)
  const expectedManaged = managedNames(current.manifest)
  if (expectedManaged.length === 0) fail('当前 profile 没有可升级的 @dsh-enhanced/* 顶层依赖。')
  const thirdParty = thirdPartyBundles(current.manifest)
  if (thirdParty.length > 0) fail(`检测到无法证明状态路径的第三方顶层 bundle，拒绝 upgrade：${thirdParty.join(', ')}`)
  const npmPath = await realpath(npmExecutable).catch(() => fail('npm executable must exist'))
  const pnpmPath = await realpath(pnpmExecutable).catch(() => fail('pnpm executable must exist'))
  const targets = await resolveNpmUpgradeCohort({ npmExecutable: npmPath, selector, expectedNames: expectedManaged })
  try { await run(pnpmPath, ['store', 'add', ...targets], { env: { ...process.env, npm_config_ignore_scripts: 'true' } }) }
  catch { fail('npm cohort 预取失败；尚未创建事务或修改 DSH_HOME。') }
  await performLifecycle({
    operation: 'upgrade', profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets,
    skipRecovery: true, transactionPrechecked: true,
    serviceContext: { systemctlExecutable, journalctlExecutable },
  })
}

async function copyHome(homePath, stageHome) {
  await mkdir(stageHome, { mode: 0o700 })
  await run('/bin/cp', ['-a', '--no-preserve=links', '--reflink=auto', '--', `${homePath}${sep}.`, stageHome], { passFds: [3, 4, 5] })
}

function cleanWebProfileSources(profile) {
  const manifest = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...ALLOWED_WEB_BUNDLES], patchReload: 'live' } },
  }
  return new Map([
    ['package.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['cordis.yml', '[]\n'],
    ['cordis.patch.yml', '[]\n'],
    ['pnpm-workspace.yaml', 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'],
  ])
}

async function installerCleanWebProfileDigest(homePath, profile) {
  const current = await readProfile(homePath, profile)
  const sources = cleanWebProfileSources(profile)
  const expectedEntries = [...sources.keys()].sort()
  const profileDescriptor = openSync(current.profilePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const anchoredProfile = `/proc/self/fd/${profileDescriptor}`
  try {
    const openedProfile = fstatSync(profileDescriptor)
    if (!sameIdentity(openedProfile, identity(current.profileStat))) {
      fail(`installer clean baseline profile 目录身份不稳定：${profile}`)
    }
    if (JSON.stringify((await readdir(anchoredProfile)).sort()) !== JSON.stringify(expectedEntries)) {
      fail(`unsupported systemd profile 不是 installer clean baseline：${profile}`)
    }
    for (const [name, expected] of sources) {
      const path = join(anchoredProfile, name)
      let descriptor
      try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch { fail(`installer clean baseline 缺少或无法安全打开文件：${profile}:${name}`) }
      try {
        const entry = fstatSync(descriptor)
        assertOwnedPrivateEntry(entry, path, 'file')
        const linked = await lstat(path)
        if (entry.nlink !== 1 || entry.size !== Buffer.byteLength(expected)
          || !sameServiceFileIdentity(linked, identity(entry))
          || await readFile(`/proc/self/fd/${descriptor}`, 'utf8') !== expected) {
          fail(`unsupported systemd profile 不是 installer clean baseline：${profile}:${name}`)
        }
      } finally { closeSync(descriptor) }
    }
    if (JSON.stringify((await readdir(anchoredProfile)).sort()) !== JSON.stringify(expectedEntries)) {
      fail(`installer clean baseline 在验证期间发生变化：${profile}`)
    }
  } finally {
    closeSync(profileDescriptor)
  }
  await assertProfileTreeIdentity(current)
  return sha256(JSON.stringify([...sources]))
}

async function assertInstallerCleanWebProfile(homePath, profile, expectedDigest) {
  const digest = await installerCleanWebProfileDigest(homePath, profile)
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    fail(`installer clean baseline 摘要与事务绑定不匹配：${profile}`)
  }
  return digest
}

async function initializeCleanWebProfile(stageHome, profile) {
  const profilePath = join(stageHome, 'profiles', profile)
  await mkdir(profilePath, { recursive: true, mode: 0o700 })
  for (const [name, source] of cleanWebProfileSources(profile)) await writeFile(join(profilePath, name), source)
}

async function performLifecycle({
  operation, profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets,
  skipRecovery = false, transactionPrechecked = false, serviceContext,
}) {
  if (!['upgrade', 'uninstall'].includes(operation) || !PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle invocation', 2)
  assertExpectedScenario(expectedScenario, serviceContext !== undefined, operation)
  const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
  if (skipRecovery) {
    if (!transactionPrechecked) fail('lifecycle recovery may only be skipped after a locked transaction precheck')
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalTransactionRoot) !== undefined) fail('生命周期事务在预检后出现；拒绝继续。')
  } else {
    const recovery = await recoverBoundTransaction({
      homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, serviceContext, dshExecutable,
    })
    if (typeof recovery === 'string' && recovery.startsWith('service-')) return
  }
  await assertLockedLifecycleScenario({
    dshExecutable, profile, homePath, expectedScenario, serviceAware: serviceContext !== undefined, operation,
  })
  const homeLstat = await lstat(physicalHomePath).catch(() => undefined)
  if (homeLstat === undefined || !homeLstat.isDirectory() || homeLstat.isSymbolicLink() || resolve(homePath) === sep) {
    fail('DSH_HOME 必须是已存在的真实非根目录。')
  }
  const canonicalHome = homePath
  await assertNoMounts(physicalHomePath)
  const packageSymlinkWhitelist = await assertSnapshotTreeSafe(physicalHomePath, homePath, true)

  const current = await readProfile(physicalHomePath, profile)
  const expectedManaged = managedNames(current.manifest)
  const thirdParty = thirdPartyBundles(current.manifest)
  if (thirdParty.length > 0) fail(`检测到无法证明状态路径的第三方顶层 bundle，拒绝 ${operation}：${thirdParty.join(', ')}`)
  if (expectedScenario === 'unsupported' && expectedManaged.length > 0) {
    fail('无法归类的 profile 仍含受管顶层依赖；拒绝 uninstall。')
  }
  if (operation === 'upgrade') {
    if (expectedManaged.length === 0) fail('当前 profile 没有可升级的 @dsh-enhanced/* 顶层依赖。')
    await validateUpgradeTargets(targets, expectedManaged)
  } else {
    if (expectedManaged.length === 0) {
      process.stdout.write('profile 生命周期事务：uninstall 已完成；当前 profile 没有 @dsh-enhanced/* 顶层依赖。\n')
      return
    }
  }
  if (expectedScenario === 'supervised') {
    await assertSupervisedLifecycleCapability(homePath, profile)
  }
  let serviceInventory
  if (serviceContext !== undefined) {
    serviceInventory = await captureServiceInventory(serviceContext.systemctlExecutable, homePath, profile, dshExecutable)
    if (expectedScenario === 'supervised'
      && serviceInventory.services.find(service => service.profile === profile)?.wasActive !== true) {
      fail('supervised upgrade 要求目标 systemd user service 在事务开始前处于 active。')
    }
  }
  let services
  let unitUniverse
  let foreignOwnership
  let cleanProfiles
  let timeouts
  if (serviceContext !== undefined) {
    timeouts = serviceTimeouts()
    const inventory = serviceInventory
    services = inventory.services
    unitUniverse = inventory.unitUniverse
    foreignOwnership = inventory.foreignOwnership
    cleanProfiles = []
    for (const service of services) {
      const cleanDigest = await assertServiceProfileScenario({
        dshExecutable, profile: service.profile, homePath, targetProfile: profile, expectedScenario,
      })
      if (cleanDigest !== undefined) cleanProfiles.push({ profile: service.profile, digest: cleanDigest })
      if (!['enabled', 'disabled'].includes(service.unitFileState)) {
        fail(`service-aware lifecycle 仅支持 enabled/disabled units；${service.unit} 当前为 ${service.unitFileState}。`)
      }
      if (await existingIdentity(serviceMaskPath(service.unit)) !== undefined
        || await existingIdentity(`${serviceMaskPath(service.unit)}.d`) !== undefined) {
        throw new ServiceMaskConflictError(`拒绝接管既有 systemd mask/drop-in：${service.unit}`)
      }
    }
    const controlRootStat = await stat(join(process.env.HOME ?? '', '.config', 'systemd', 'user'))
    const homeParentStat = fstatSync(3)
    if (String(controlRootStat.dev) !== String(homeParentStat.dev)) {
      fail('service-aware lifecycle 要求 DSH_HOME parent 与用户 systemd 配置位于同一文件系统，以保证 no-replace 原子屏障。')
    }
  }

  assertLockParentStable(homePath)
  const parentStat = fstatSync(3)
  const originalStat = await assertOwnedPrivateDirectory(physicalHomePath)
  if (String(parentStat.dev) !== String(originalStat.dev)) fail('DSH_HOME 与事务目录不在同一文件系统，无法保证原子切换。')
  await mkdir(physicalTransactionRoot, { mode: 0o700 })
  assertLockParentStable(homePath)
  await chmod(physicalTransactionRoot, 0o700)
  const stageHome = join(physicalTransactionRoot, 'staged-home')
  const backupHome = join(physicalTransactionRoot, 'original-home')
  const transactionCreated = {
    version: serviceContext === undefined ? MANIFEST_VERSION
      : expectedScenario === 'supervised' ? SUPERVISED_SERVICE_MANIFEST_VERSION : SERVICE_MANIFEST_VERSION,
    id: randomUUID(), homePath, canonicalHome, transactionPath: transactionRoot, profile, operation,
    transactionIdentity: identity(await lstat(physicalTransactionRoot)),
    originalIdentity: identity(originalStat), originalProfileDigest: sha256(current.source),
    stagedIdentity: undefined, stagedProfileDigest: undefined, createdAt: new Date().toISOString(),
    expectedScenario, stagedScenario: operation === 'uninstall' ? 'unsupported' : expectedScenario,
    ...(expectedScenario === 'supervised' ? {
      supervisedLifecycle: operation === 'uninstall' ? {
        protocol: SUPERVISED_UNINSTALL_PROTOCOL, phase: 'source-pending',
        databasePaths: undefined, source: undefined, startAttempt: undefined,
      } : {
        protocol: SUPERVISED_UPGRADE_PROTOCOL, phase: 'source-pending', activationNonce: randomUUID(),
        catalogDigest: undefined, databasePaths: undefined, source: undefined,
        previewPlan: undefined, previewAcceptance: undefined, activePlan: undefined,
        postSwapAcceptance: undefined,
      },
    } : {}),
  }
  let serviceMasks
  let serviceStartBarriers
  try {
    if (serviceContext !== undefined) {
      await writeManifest(physicalTransactionRoot, {
        ...transactionCreated, services, unitUniverse, foreignOwnership, cleanProfiles,
        serviceMasks: [], containmentMasks: [], containmentMaskIntents: [],
        containmentStartBarriers: [],
        serviceStartBarriers: [], servicePhase: 'initializing', serviceFailure: undefined, serviceAcceptance: undefined,
      }, 'preparing')
      serviceMasks = await prepareBoundMasks(physicalTransactionRoot, services.map(service => service.unit), 'managed')
      serviceStartBarriers = await prepareServiceStartBarriers(physicalTransactionRoot, services)
    }
  } catch (error) {
    await rm(physicalTransactionRoot, { recursive: true, force: true }).catch(() => {})
    await fsyncPath(LOCK_PARENT_FD_PATH, true).catch(() => {})
    throw error
  }
  let manifest = {
    ...transactionCreated,
    ...(serviceContext === undefined ? {} : {
      services, unitUniverse, foreignOwnership, cleanProfiles, serviceMasks, containmentMasks: [], containmentMaskIntents: [],
      containmentStartBarriers: [], serviceStartBarriers,
      servicePhase: 'stopping', serviceFailure: undefined, serviceAcceptance: undefined,
    }),
  }
  if (serviceContext !== undefined) {
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'preparing')
    try {
      await assertUnitUniverseStable(
        serviceContext.systemctlExecutable, unitUniverse, homePath, foreignOwnership,
      )
      await installBoundMasks(serviceContext.systemctlExecutable, serviceMasks)
      await establishServiceStartBarriers(serviceContext.systemctlExecutable, serviceStartBarriers)
      await stopServicesAndWait(
        serviceContext.systemctlExecutable, services, serviceMasks, homePath, dshExecutable,
        unitUniverse, foreignOwnership, timeouts.stop,
      )
      await assertNoUnmanagedHomeProcesses(homePath)
      manifest = await writeManifest(physicalTransactionRoot, { ...manifest, servicePhase: 'stopped' }, 'preparing')
      if (expectedScenario === 'supervised') {
        const stoppedSource = compactSupervisedSnapshot(await runSupervisedOperatorDirect({
          homePath, profile, dshExecutable,
        }, 'attest-active'))
        manifest = await writeManifest(physicalTransactionRoot, {
          ...manifest, ...(operation === 'uninstall' ? {
            originalProfileTreeDigest: await profileTreeDigest(current.profilePath),
          } : {}),
          supervisedLifecycle: {
            ...manifest.supervisedLifecycle, phase: 'source-attested', databasePaths: stoppedSource.databasePaths,
            source: stoppedSource,
          },
        }, 'preparing')
      }
    } catch (error) {
      try {
        let restoreAccepted
        if (expectedScenario === 'supervised' && manifest.supervisedLifecycle.source !== undefined) {
          const raw = compactSupervisedSnapshot(await runSupervisedOperatorDirect({
            homePath, profile, dshExecutable,
          }, 'snapshot'), false)
          manifest = await writeManifest(physicalTransactionRoot, {
            ...manifest, servicePhase: 'starting', supervisedLifecycle: operation === 'uninstall' ? {
              ...manifest.supervisedLifecycle, phase: 'source-attested',
              startAttempt: { kind: 'restore-source', baselineGeneration: raw.recoveryProof.bootstrap.generation },
            } : {
              ...manifest.supervisedLifecycle, phase: 'source-attested', catalogDigest: undefined,
              previewPlan: undefined, previewAcceptance: undefined, activePlan: undefined, postSwapAcceptance: undefined,
              startAttempt: { kind: 'restore-source', baselineGeneration: raw.recoveryProof.bootstrap.generation },
            },
          }, 'preparing')
          const identity = sourceSupervisedIdentity(manifest.supervisedLifecycle.source)
          restoreAccepted = async () => {
            await awaitSupervisedDirectSuccessor({
              homePath, profile, dshExecutable, supervisedNonce: identity.nonce,
              supervisedCatalogDigest: identity.catalogDigest, supervisedPlan: sourceSupervisedPlan(manifest.supervisedLifecycle.source),
              supervisedSource: manifest.supervisedLifecycle.source,
            }, { recoveryProof: { bootstrap: { generation: raw.recoveryProof.bootstrap.generation } } }, 'active', timeouts.ready)
          }
        }
        await restoreOriginalActiveSet({
          ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers,
          containmentMasks: manifest.containmentMasks, containmentStartBarriers: manifest.containmentStartBarriers,
          homePath, targetProfile: profile, unitUniverse, foreignOwnership, cleanProfiles, timeouts,
          acceptAfterReady: restoreAccepted, requireLarkReady: expectedScenario === 'supervised',
        })
        await rm(physicalTransactionRoot, { recursive: true, force: true })
      } catch (restoreError) {
        await stopRelatedServices(
          serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
          physicalTransactionRoot, manifest,
        ).catch(() => {})
        await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'service-failed',
          serviceFailure: `${error instanceof Error ? error.message : String(error)}; restore: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        }, 'service-failed').catch(() => {})
      }
      throw error
    }
  } else {
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'preparing')
  }

  let swapped = false
  let commitUncertain = false
  let committedCleanup = false
  try {
    if (serviceContext !== undefined) {
      await assertMaskedAndQuiescent({
        ...serviceContext, services, serviceMasks, homePath, dshExecutable, unitUniverse, foreignOwnership,
      })
    }
    await copyHome(physicalHomePath, stageHome)
    const stagedStat = await stat(stageHome)
    manifest = await writeManifest(physicalTransactionRoot, { ...manifest, stagedIdentity: identity(stagedStat) }, 'prepared')
    const stagedProfile = await readProfile(stageHome, profile)
    const stagedCanonical = await realpath(stagedProfile.profilePath)
    if (!inside(await realpath(stageHome), stagedCanonical)) fail('staged profile 通过符号链接逃逸 DSH_HOME；拒绝继续。')

    const sandbox = {
      bwrapExecutable, stageHome, homePath, dshExecutable, profile, expectedScenario, transactionId: manifest.id,
    }
    await validateComposedConfig(sandbox, 'before')
    if (expectedScenario === 'supervised') {
      const copiedSource = compactSupervisedSnapshot(await runSupervisedOperator(sandbox, 'attest-active'))
      assertCopiedSupervisedSnapshot(manifest.supervisedLifecycle.source, copiedSource)
    }
    let archivedProfile
    if (operation === 'upgrade') {
      await sandboxRun(sandbox, [dshExecutable, 'plugin', '--profile', profile, 'add', ...targets], {
        extraEnvironment: { npm_config_offline: 'true', npm_config_package_import_method: 'copy' },
      })
    } else {
      const archiveRoot = join(stageHome, 'uninstalled-profiles')
      await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
      const archiveName = `${profile}-${new Date().toISOString().replaceAll(/[-:.]/gu, '')}-${manifest.id}`
      const sourceProfilePath = join(stageHome, 'profiles', profile)
      const archivePath = join(archiveRoot, archiveName)
      const archiveSourceIdentity = identity(await lstat(sourceProfilePath))
      const archiveTreeDigest = await profileTreeDigest(sourceProfilePath)
      if (expectedScenario === 'supervised' && archiveTreeDigest !== manifest.originalProfileTreeDigest) {
        fail('supervised uninstall copied profile tree 与 stopped source 不一致。')
      }
      await moveBoundDirectoryNoReplace(sourceProfilePath, archivePath, archiveSourceIdentity)
      archivedProfile = {
        relativePath: `uninstalled-profiles/${archiveName}`, identity: identity(await lstat(archivePath)),
        profileDigest: manifest.originalProfileDigest, treeDigest: archiveTreeDigest,
      }
      await initializeCleanWebProfile(stageHome, profile)
    }
    const committedScenario = manifest.stagedScenario
    const packageScenario = await validateComposedConfig({ ...sandbox, expectedScenario: committedScenario }, 'after-package')
    if (expectedScenario === 'supervised' && operation === 'upgrade') {
      const nonce = manifest.supervisedLifecycle.activationNonce
      const overlay = supervisedPreviewOverlayPaths(sandbox)
      // Clear any dotfile left by a crashed earlier attempt; prepare-preview
      // still creates it exclusively (flag 'wx') to reject a pre-planted file.
      await rm(overlay.stagePath, { force: true })
      const overlayEnvironment = supervisedPreviewOverlayEnvironment(overlay)
      // prepare-preview derives the isolation overlay inside the sandbox from
      // the just-asserted, Lark-enabled persisted baseline and stages it
      // itself (exclusive create), so no fixed template can drop user providers.
      const preview = await runSupervisedOperator(sandbox, 'prepare-preview', nonce, overlayEnvironment)
      if (!validDigest(preview.catalogDigest) || preview.plan === undefined
        || !validDigest(preview.plan.runtimeOverlayDigest)) fail('supervised preview plan 输出无效。')
      // Independently confirm the operator-staged dotfile matches the digest the
      // plan binds before the Host is allowed to consume it.
      if (sha256(await readFile(overlay.stagePath)) !== preview.plan.runtimeOverlayDigest) {
        await rm(overlay.stagePath, { force: true })
        fail('supervised preview runtime overlay 写入后摘要不匹配。')
      }
      if (manifest.supervisedLifecycle.source.recoveryProof.bootstrap.attestations.some(
        attestation => attestation.activationNonce === nonce,
      )) fail('supervised lifecycle fresh nonce 与 source bootstrap nonce 重复。')
      manifest = await writeManifest(physicalTransactionRoot, {
        ...manifest, supervisedLifecycle: {
          ...manifest.supervisedLifecycle, phase: 'preview-prepared', catalogDigest: preview.catalogDigest,
          previewPlan: preview.plan,
        },
      }, 'prepared')
      const previewContext = { ...sandbox, supervisedNonce: nonce, supervisedCatalogDigest: preview.catalogDigest,
        supervisedPlan: preview.plan, supervisedSource: manifest.supervisedLifecycle.source,
        supervisedOperatorEnvironment: overlayEnvironment }
      manifest = await writeManifest(physicalTransactionRoot, {
        ...manifest, supervisedLifecycle: { ...manifest.supervisedLifecycle, phase: 'preview-running' },
      }, 'prepared')
      const host = await startSandboxHost(previewContext)
      previewContext.host = host
      let previewSuccessor
      try {
        previewSuccessor = await awaitSupervisedSuccessor(
          previewContext, manifest.supervisedLifecycle.source, 'preview', timeouts.ready,
        )
      } finally {
        await host.close()
        await rm(overlay.stagePath, { force: true })
      }
      manifest = await writeManifest(physicalTransactionRoot, {
        ...manifest, supervisedLifecycle: {
          ...manifest.supervisedLifecycle, phase: 'preview-accepted',
          previewAcceptance: {
            generation: previewSuccessor.proof.recoveryProof.bootstrap.generation,
            deliveryProof: previewSuccessor.proof.deliveryProof,
            ownerBindingDigest: previewSuccessor.proof.ownerBindingDigest,
            unmanagedAutomationsDigest: previewSuccessor.proof.unmanagedAutomationsDigest,
            databasePaths: previewSuccessor.proof.databasePaths,
            attestationDigest: previewSuccessor.snapshot.attestation.attestationDigest,
            recoveryProof: previewSuccessor.proof.recoveryProof,
            automationsProof: previewSuccessor.proof.automationsProof,
          },
        },
      }, 'prepared')
      const active = await runSupervisedOperator(sandbox, 'prepare-active', nonce)
      if (active.catalogDigest !== preview.catalogDigest || active.plan === undefined) {
        fail('supervised active plan 未与 preview nonce/catalog 一致。')
      }
      manifest = await writeManifest(physicalTransactionRoot, {
        ...manifest, supervisedLifecycle: {
          ...manifest.supervisedLifecycle, phase: 'active-prepared', activePlan: active.plan,
        },
      }, 'prepared')
    } else {
      await activateInSandbox(sandbox)
    }
    await validateComposedConfig({ ...sandbox, expectedScenario: packageScenario }, 'after-activation')
    await assertSnapshotTreeSafe(stageHome, homePath, false, packageSymlinkWhitelist)
    await run('/bin/sync', ['-f', stageHome], { passFds: [3, 4, 5] })
    await fsyncPath(stageHome, true)
    const validatedProfile = await readProfile(stageHome, profile)
    const cleanProfileDigest = operation === 'uninstall'
      ? await assertInstallerCleanWebProfile(stageHome, profile)
      : undefined
    manifest = await writeManifest(physicalTransactionRoot, {
      ...manifest, stagedProfileDigest: sha256(validatedProfile.source), cleanProfileDigest,
      ...(expectedScenario === 'supervised' && operation === 'uninstall' ? {
        archivedProfile, supervisedLifecycle: { ...manifest.supervisedLifecycle, phase: 'clean-target-validated' },
      } : {}),
    }, 'validated')
    if (expectedScenario === 'supervised' && operation === 'uninstall') await assertArchivedProfile(stageHome, manifest)

    assertLockParentStable(homePath)
    assertExpectedDirectoryMetadata(await lstat(physicalHomePath), originalStat, homePath)
    await assertProfileTreeIdentity(current)
    await assertCriticalDirectory(stageHome, manifest.stagedIdentity)
    if (operation === 'upgrade') await assertProfileTreeIdentity(validatedProfile)
    else await readProfile(stageHome, profile)
    if (serviceContext !== undefined) {
      await assertMaskedAndQuiescent({
        ...serviceContext, services, serviceMasks, homePath, dshExecutable, unitUniverse, foreignOwnership,
      })
    }
    await moveBoundDirectoryNoReplace(physicalHomePath, backupHome, manifest.originalIdentity,
      { path: physicalTransactionRoot, identity: manifest.transactionIdentity })
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'original-renamed')
    if (serviceContext !== undefined) {
      try {
        await assertNoUnmanagedHomeProcesses(homePath, [await realpath(backupHome)])
      } catch (error) {
        if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在 post-rename quiescence 恢复前重新出现；拒绝覆盖。')
        await moveBoundDirectoryNoReplace(backupHome, physicalHomePath, manifest.originalIdentity,
          { path: physicalTransactionRoot, identity: manifest.transactionIdentity })
        await fsyncPath(physicalTransactionRoot, true)
        await fsyncPath(LOCK_PARENT_FD_PATH, true)
        throw error
      }
    }
    assertLockParentStable(homePath)
    if (await existingIdentity(physicalHomePath) !== undefined) fail('DSH_HOME 在原目录移走后重新出现；拒绝覆盖。')
    await assertCriticalDirectory(stageHome, manifest.stagedIdentity)
    if (operation === 'upgrade') await assertProfileTreeIdentity(validatedProfile)
    else await readProfile(stageHome, profile)
    if (serviceContext !== undefined) {
      await assertMaskedAndQuiescent({
        ...serviceContext, services, serviceMasks, homePath, dshExecutable, unitUniverse, foreignOwnership,
        equivalentHomePaths: [await realpath(backupHome)],
      })
    }
    await moveBoundDirectoryNoReplace(stageHome, physicalHomePath, manifest.stagedIdentity,
      { path: physicalTransactionRoot, identity: manifest.transactionIdentity })
    assertLockParentStable(homePath)
    await fsyncPath(physicalTransactionRoot, true)
    await fsyncPath(LOCK_PARENT_FD_PATH, true)
    swapped = true
    manifest = await writeManifest(physicalTransactionRoot, {
      ...manifest, ...(serviceContext === undefined ? {} : { servicePhase: 'swapped' }),
    }, 'swapped')
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    if (expectedScenario === 'supervised' && operation === 'uninstall') await assertArchivedProfile(physicalHomePath, manifest)
    if (serviceContext !== undefined) {
      if (expectedScenario === 'supervised' && operation === 'upgrade') {
        const rawBeforeStart = compactSupervisedSnapshot(await runSupervisedOperatorDirect({
          homePath, profile, dshExecutable,
        }, 'snapshot'), false)
        manifest = await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'starting', supervisedLifecycle: {
            ...manifest.supervisedLifecycle, phase: 'post-swap-pending',
            startAttempt: { kind: 'accept-active', baselineGeneration: rawBeforeStart.recoveryProof.bootstrap.generation },
          },
        }, 'swapped')
      } else {
        manifest = await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'starting', serviceAcceptance: undefined,
          ...(expectedScenario === 'supervised' ? {
            supervisedLifecycle: { ...manifest.supervisedLifecycle, phase: 'clean-target-pending' },
          } : {}),
        }, 'swapped')
      }
      try {
        let postSwapProof
        const accepted = await startAndAcceptServices({
          ...serviceContext, dshExecutable, services, serviceMasks, homePath, targetProfile: profile,
          unitUniverse, foreignOwnership, cleanProfiles, timeouts,
        requireLarkReady: expectedScenario === 'supervised' && operation === 'upgrade',
        ...(expectedScenario === 'supervised' ? {
          durableAccept: async acceptedStates => {
            const serviceAcceptance = acceptedStates.map(service => ({
              unit: service.unit, invocationId: service.invocationId, mainPid: service.mainPid, nRestarts: service.nRestarts,
            }))
            if (operation === 'uninstall') {
              manifest = await writeManifest(physicalTransactionRoot, {
                ...manifest, servicePhase: 'service-accepted', serviceAcceptance, serviceFailure: undefined,
                supervisedLifecycle: { ...manifest.supervisedLifecycle, phase: 'clean-target-accepted' },
              }, 'service-accepted')
              return
            }
            const targetAcceptance = serviceAcceptance.find(service => service.unit === `dsh-profile-${profile}.service`)
            if (targetAcceptance === undefined) fail('supervised durable acceptance 缺少目标 InvocationID。')
            manifest = await writeManifest(physicalTransactionRoot, {
              ...manifest, servicePhase: 'service-accepted', serviceAcceptance,
              supervisedLifecycle: {
                ...manifest.supervisedLifecycle, phase: 'post-swap-accepted', postSwapAcceptance: {
                  generation: postSwapProof.proof.recoveryProof.bootstrap.generation,
                  invocationId: targetAcceptance.invocationId,
                  deliveryProof: postSwapProof.proof.deliveryProof, ownerBindingDigest: postSwapProof.proof.ownerBindingDigest,
                  unmanagedAutomationsDigest: postSwapProof.proof.unmanagedAutomationsDigest,
                  databasePaths: postSwapProof.proof.databasePaths,
                  attestationDigest: postSwapProof.snapshot.attestation.attestationDigest,
                  recoveryProof: postSwapProof.proof.recoveryProof, automationsProof: postSwapProof.proof.automationsProof,
                },
              },
            }, 'service-accepted')
          },
          ...(operation === 'upgrade' ? { acceptAfterReady: async () => {
            postSwapProof = await awaitSupervisedDirectSuccessor({
              homePath, profile, dshExecutable, supervisedNonce: manifest.supervisedLifecycle.activationNonce,
              supervisedCatalogDigest: manifest.supervisedLifecycle.catalogDigest,
              supervisedPlan: manifest.supervisedLifecycle.activePlan,
              previewAcceptance: manifest.supervisedLifecycle.previewAcceptance,
              supervisedSource: manifest.supervisedLifecycle.source,
            }, { recoveryProof: { bootstrap: {
              generation: manifest.supervisedLifecycle.startAttempt.baselineGeneration,
            } } }, 'active', timeouts.ready)
          } } : {}),
        } : {}),
        })
        if (expectedScenario !== 'supervised') {
          manifest = await writeManifest(physicalTransactionRoot, {
            ...manifest, servicePhase: 'service-accepted',
            serviceAcceptance: accepted.map(service => ({
              unit: service.unit, invocationId: service.invocationId, mainPid: service.mainPid, nRestarts: service.nRestarts,
            })),
          }, 'service-accepted')
        }
      } catch (serviceError) {
        let containmentFailure
        manifest = await loadManifest(physicalTransactionRoot, {
          homePath, profile, transactionPath: transactionRoot,
        }).catch(() => manifest)
        try {
          manifest = await stopRelatedServices(
            serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
            physicalTransactionRoot, manifest,
          )
        } catch (containmentError) {
          containmentFailure = containmentError instanceof Error ? containmentError.message : String(containmentError)
          manifest = await loadManifest(physicalTransactionRoot, {
            homePath, profile, transactionPath: transactionRoot,
          }).catch(() => manifest)
        }
        await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'service-failed',
          serviceFailure: (serviceError instanceof Error ? serviceError.message : String(serviceError))
            + (containmentFailure === undefined ? '' : `; containment: ${containmentFailure}`),
        }, 'service-failed').catch(() => {})
        if (containmentFailure !== undefined) {
          process.stderr.write(`service-aware failure containment 未完成：${containmentFailure}\n`)
        }
        throw serviceError
      }
    }
    if (serviceContext !== undefined) {
      await finalizeAcceptedServices({
        ...serviceContext, dshExecutable, services, serviceMasks, containmentMasks: manifest.containmentMasks,
        containmentStartBarriers: manifest.containmentStartBarriers,
        serviceStartBarriers,
        homePath, targetProfile: profile, unitUniverse, foreignOwnership, cleanProfiles, acceptance: manifest.serviceAcceptance,
        requireLarkReady: expectedScenario === 'supervised' && operation === 'upgrade',
        restoreContainedEnablement: operation !== 'uninstall',
      })
    }
    commitUncertain = true
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'committed')
    commitUncertain = false
    await assertProfileDigest(physicalHomePath, profile, manifest.stagedProfileDigest)
    if (operation === 'uninstall') {
      await assertInstallerCleanWebProfile(physicalHomePath, profile, manifest.cleanProfileDigest)
      if (expectedScenario === 'supervised') await assertArchivedProfile(physicalHomePath, manifest)
    }
    await assertProfileDigest(backupHome, profile, manifest.originalProfileDigest)
    if (serviceContext !== undefined) {
      await assertAcceptedServicesStillBound({
        ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers, homePath, unitUniverse,
        foreignOwnership, targetProfile: profile, cleanProfiles, acceptance: manifest.serviceAcceptance,
        requireLarkReady: expectedScenario === 'supervised' && operation === 'upgrade',
      })
      if (expectedScenario === 'supervised' && operation === 'upgrade') {
        await assertPersistedSupervisedAcceptance({
          homePath, profile, dshExecutable, acceptance: manifest.supervisedLifecycle.postSwapAcceptance,
        })
        await assertAcceptedSupervisedInvocation({
          ...serviceContext, services, homePath, dshExecutable, profile,
          acceptance: manifest.supervisedLifecycle.postSwapAcceptance,
        })
      }
    }
    if (operation === 'uninstall') {
      await assertInstallerCleanWebProfile(physicalHomePath, profile, manifest.cleanProfileDigest)
      if (expectedScenario === 'supervised') await assertArchivedProfile(physicalHomePath, manifest)
    }
    manifest = await writeManifest(physicalTransactionRoot, manifest, 'cleanup-started')
    committedCleanup = true
    await removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome })
    committedCleanup = false
    process.stdout.write(operation === 'uninstall'
      ? 'profile 生命周期事务完成：uninstall；旧 profile 已归档，事务未主动清除 live profile 外状态。\n'
      : 'profile 生命周期事务完成：upgrade；配置与持久状态已从离线副本保留。\n')
  } catch (error) {
    const persisted = await loadManifest(physicalTransactionRoot, { homePath, profile, transactionPath: transactionRoot }).catch(() => undefined)
    const liveAfterFailure = await existingIdentity(physicalHomePath)
    const backupAfterFailure = await existingIdentity(backupHome)
    const crossedSwapBoundary = isServiceManifestVersion(persisted?.version)
      && sameIdentity(liveAfterFailure, persisted.stagedIdentity)
      && sameIdentity(backupAfterFailure, persisted.originalIdentity)
    if (committedCleanup) {
      process.stderr.write(`profile 生命周期已提交，但 canonical 事务清理失败；保留可恢复 residue，请重试同一命令：${transactionRoot}\n`)
    } else if (commitUncertain && persisted?.state === 'committed') {
      process.stderr.write(`profile 生命周期已提交但收尾状态无法确认；保留当前 home 与原始备份，请重新执行同一命令持锁恢复：${transactionRoot}\n`)
    } else if (serviceContext !== undefined && persisted?.state === 'cleanup-started'
      && sameIdentity(liveAfterFailure, persisted.stagedIdentity) && backupAfterFailure === undefined) {
      process.stderr.write(`service-aware 生命周期已验收且旧备份已删除，但事务元数据清理未完成；请重试同一命令：${transactionRoot}\n`)
    } else if (serviceContext !== undefined && (swapped || crossedSwapBoundary)) {
      try {
        manifest = await stopRelatedServices(
          serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
          physicalTransactionRoot, persisted ?? manifest,
        )
        await writeManifest(physicalTransactionRoot, {
          ...manifest, servicePhase: 'service-failed',
          serviceFailure: error instanceof Error ? error.message : String(error),
        }, 'service-failed')
      } catch {}
      process.stderr.write(`service-aware 生命周期已切换 DSH_HOME；禁止自动回滚迁移状态，保留 current home、original-home 与事务证据：${transactionRoot}\n`)
    } else if (serviceContext !== undefined) {
      try {
        if (liveAfterFailure === undefined && sameIdentity(backupAfterFailure, manifest.originalIdentity)) {
          assertLockParentStable(homePath)
          await moveBoundDirectoryNoReplace(backupHome, physicalHomePath, manifest.originalIdentity,
            { path: physicalTransactionRoot, identity: manifest.transactionIdentity })
          await fsyncPath(physicalTransactionRoot, true)
          await fsyncPath(LOCK_PARENT_FD_PATH, true)
        }
        manifest = await stopRelatedServices(
          serviceContext.systemctlExecutable, services, homePath, dshExecutable, unitUniverse, timeouts.stop,
          physicalTransactionRoot, persisted ?? manifest,
        )
        let restoreAccepted
        if (expectedScenario === 'supervised' && (persisted ?? manifest).supervisedLifecycle?.source !== undefined) {
          const lifecycle = (persisted ?? manifest).supervisedLifecycle
          const raw = compactSupervisedSnapshot(await runSupervisedOperatorDirect({
            homePath, profile, dshExecutable,
          }, 'snapshot'), false)
          const identity = sourceSupervisedIdentity(lifecycle.source)
          manifest = await writeManifest(physicalTransactionRoot, {
            ...(persisted ?? manifest), servicePhase: 'starting', supervisedLifecycle: operation === 'uninstall' ? {
              ...lifecycle, phase: 'source-attested',
              startAttempt: { kind: 'restore-source', baselineGeneration: raw.recoveryProof.bootstrap.generation },
            } : {
              ...lifecycle, phase: 'source-attested', catalogDigest: undefined, previewPlan: undefined,
              previewAcceptance: undefined, activePlan: undefined, postSwapAcceptance: undefined,
              startAttempt: { kind: 'restore-source', baselineGeneration: raw.recoveryProof.bootstrap.generation },
            },
          }, 'preparing')
          restoreAccepted = async () => {
            await awaitSupervisedDirectSuccessor({
              homePath, profile, dshExecutable, supervisedNonce: identity.nonce,
              supervisedCatalogDigest: identity.catalogDigest, supervisedPlan: sourceSupervisedPlan(lifecycle.source),
              supervisedSource: lifecycle.source,
            }, { recoveryProof: { bootstrap: { generation: raw.recoveryProof.bootstrap.generation } } }, 'active', timeouts.ready)
          }
        }
        await restoreOriginalActiveSet({
          ...serviceContext, dshExecutable, services, serviceMasks, serviceStartBarriers,
          containmentMasks: (persisted ?? manifest).containmentMasks,
          containmentStartBarriers: (persisted ?? manifest).containmentStartBarriers,
          homePath, targetProfile: profile, unitUniverse, foreignOwnership, cleanProfiles, timeouts,
          acceptAfterReady: restoreAccepted, requireLarkReady: expectedScenario === 'supervised',
        })
        const evidence = await moveTransactionAside(physicalTransactionRoot, transactionRoot, profile)
        await fsyncPath(LOCK_PARENT_FD_PATH, true)
        process.stderr.write(`service-aware 生命周期在切换前失败；原 home 与 active service set 已恢复，证据保留在 ${evidence}\n`)
      } catch (restoreError) {
        await writeManifest(physicalTransactionRoot, {
          ...(persisted ?? manifest), servicePhase: 'service-failed',
          serviceFailure: `${error instanceof Error ? error.message : String(error)}; restore: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        }, 'service-failed').catch(() => {})
        process.stderr.write(`service-aware 生命周期在切换前失败且服务恢复未完成：${restoreError instanceof Error ? restoreError.message : String(restoreError)}\n`)
      }
    } else if (swapped || await existingIdentity(backupHome) !== undefined) {
      try {
        await recoverBoundTransaction({
          homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, dshExecutable,
        })
        process.stderr.write('profile 生命周期事务失败：原 DSH_HOME 已恢复。\n')
      } catch (recoveryError) {
        process.stderr.write(`profile 生命周期事务失败且自动恢复未完成：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}\n`)
      }
    } else {
      try { await writeManifest(physicalTransactionRoot, manifest, 'failed', { failure: error instanceof Error ? error.message : String(error) }) } catch {}
      process.stderr.write(`profile 生命周期事务失败：原 DSH_HOME 未修改；失败副本保留在 ${transactionRoot}\n`)
    }
    throw error
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const lockHeld = argv.at(-1) === '--lock-held'
  if (lockHeld) argv.pop()
  const [operation, profile, suppliedHomePath, suppliedDshExecutable, suppliedBwrapExecutable, ...targets] = argv
  if (operation === undefined || profile === undefined || suppliedHomePath === undefined || suppliedDshExecutable === undefined || suppliedBwrapExecutable === undefined) {
    fail('usage: lifecycle-profile.mjs <upgrade|npm-upgrade|service-upgrade|npm-service-upgrade|uninstall|service-uninstall|recover|service-recover> <profile> <dsh-home> <dsh-executable> <bwrap-executable> [operation-arguments...]', 2)
  }
  if (!isAbsolute(suppliedHomePath) || resolve(suppliedHomePath) !== suppliedHomePath) fail('invalid lifecycle DSH_HOME', 2)
  const homePath = await canonicalMissingAllowed(suppliedHomePath)
  const recoveryOperation = operation === 'recover' || operation === 'service-recover'
  const dshExecutable = await realpath(suppliedDshExecutable).catch(() => fail('DSH executable must exist'))
  const bwrapExecutable = recoveryOperation ? suppliedBwrapExecutable
    : await trustedSystemExecutable(suppliedBwrapExecutable, 'bwrap')
  if (!lockHeld) {
    await withLifecycleLock(homePath, [operation, profile, homePath, dshExecutable, bwrapExecutable, ...targets])
    return
  }
  await assertLifecycleLocksHeld(homePath)
  if (operation === 'recover') {
    if (targets.length > 1) fail('recover accepts at most one ignored caller scenario', 2)
    if (!PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle recovery invocation', 2)
    const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
    await recoverBoundTransaction({
      homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, dshExecutable,
    })
    return
  }
  if (operation === 'service-recover') {
    if (targets.length < 2 || targets.length > 3) {
      fail('service-recover requires systemctl and journalctl and accepts one ignored caller scenario', 2)
    }
    if (!PROFILE_NAME.test(profile) || !isAbsolute(homePath) || resolve(homePath) !== homePath) fail('invalid lifecycle recovery invocation', 2)
    const [suppliedSystemctl, suppliedJournalctl] = targets
    const systemctlExecutable = await trustedServiceExecutable(suppliedSystemctl, 'systemctl')
    const journalctlExecutable = await trustedServiceExecutable(suppliedJournalctl, 'journalctl')
    const { transactionPath: transactionRoot, physicalHomePath, physicalTransactionRoot } = lifecyclePaths(homePath)
    await recoverBoundTransaction({
      homePath, physicalHomePath, profile, transactionRoot, physicalTransactionRoot, dshExecutable,
      serviceContext: { systemctlExecutable, journalctlExecutable },
    })
    return
  }
  if (operation === 'npm-upgrade') {
    if (targets.length !== 4) fail('npm-upgrade requires npm, pnpm, expected scenario, and one selector', 2)
    const [npmExecutable, pnpmExecutable, expectedScenario, selector] = targets
    await performNpmUpgrade({
      profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, npmExecutable, pnpmExecutable, selector,
    })
    return
  }
  if (operation === 'service-upgrade') {
    if (targets.length < 4) fail('service-upgrade requires systemctl, journalctl, expected scenario, and upgrade targets', 2)
    const [suppliedSystemctl, suppliedJournalctl, expectedScenario, ...serviceTargets] = targets
    const systemctlExecutable = await trustedServiceExecutable(suppliedSystemctl, 'systemctl')
    const journalctlExecutable = await trustedServiceExecutable(suppliedJournalctl, 'journalctl')
    await performLifecycle({
      operation: 'upgrade', profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets: serviceTargets,
      serviceContext: { systemctlExecutable, journalctlExecutable },
    })
    return
  }
  if (operation === 'service-uninstall') {
    if (targets.length !== 3) fail('service-uninstall requires systemctl, journalctl, and expected scenario', 2)
    const [suppliedSystemctl, suppliedJournalctl, expectedScenario] = targets
    const systemctlExecutable = await trustedServiceExecutable(suppliedSystemctl, 'systemctl')
    const journalctlExecutable = await trustedServiceExecutable(suppliedJournalctl, 'journalctl')
    await performLifecycle({
      operation: 'uninstall', profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets: [],
      serviceContext: { systemctlExecutable, journalctlExecutable },
    })
    return
  }
  if (operation === 'npm-service-upgrade') {
    if (targets.length !== 6) fail('npm-service-upgrade requires systemctl, journalctl, npm, pnpm, expected scenario, and selector', 2)
    const [suppliedSystemctl, suppliedJournalctl, npmExecutable, pnpmExecutable, expectedScenario, selector] = targets
    const systemctlExecutable = await trustedServiceExecutable(suppliedSystemctl, 'systemctl')
    const journalctlExecutable = await trustedServiceExecutable(suppliedJournalctl, 'journalctl')
    await performNpmServiceUpgrade({
      profile, homePath, dshExecutable, bwrapExecutable, expectedScenario,
      systemctlExecutable, journalctlExecutable, npmExecutable, pnpmExecutable, selector,
    })
    return
  }
  const [expectedScenario, ...lifecycleTargets] = targets
  await performLifecycle({
    operation, profile, homePath, dshExecutable, bwrapExecutable, expectedScenario, targets: lifecycleTargets,
  })
}

export const lifecycleProfileTest = Object.freeze({
  compactSupervisedSnapshot, validSupervisedLifecycle, validSupervisedManifestPhase, sameHomeOwnershipEvidence,
  validManifestTopLevel, validV3OperationShape, validV3ServiceAcceptance, writeManifest,
  validSupervisedCapabilityProof, MANIFEST_MAX_BYTES,
})

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    process.stderr.write(`dsh-enhanced lifecycle: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = error instanceof LifecycleError ? error.exitCode : 1
  })
}
