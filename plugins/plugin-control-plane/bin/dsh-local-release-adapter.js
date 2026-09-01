#!/usr/bin/node

/**
 * Owner-controlled, local-only Stage 4 release adapter.
 *
 * The control plane supplies no ambient credentials to this program. The only
 * configuration input is one phase-specific, allowlisted
 * DSH_RELEASE_<PHASE>_CONFIG path. That owner-private file selects one fixed
 * phase, a private signing-key path, and the local Git/filesystem resources
 * that phase may use.
 */
import { spawnSync } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  fstatSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  linkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LOCAL_RELEASE_ADAPTER_VERSION = 'dsh-local-release-adapter-1'
const PHASES = new Set(['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'])
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const PACKAGE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const MAX_INPUT_BYTES = 1_048_576
const MAX_ARTIFACT_BYTES = 268_435_456
const ARTIFACT_FDS = Object.freeze({ tarball: ['DSH_RELEASE_TARBALL_FD', 3, MAX_ARTIFACT_BYTES],
  sbom: ['DSH_RELEASE_SBOM_FD', 4, 16_777_216], provenance: ['DSH_RELEASE_PROVENANCE_FD', 5, 16_777_216] })

class PublishAmbiguity extends Error {
  constructor(detail) { super(detail); this.name = 'PublishAmbiguity' }
}

export function canonicalReleaseValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalReleaseValue).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReleaseValue(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Bytes(value) { return createHash('sha256').update(value).digest('hex') }
function sha512Integrity(value) { return `sha512-${createHash('sha512').update(value).digest('base64')}` }
function digest(value) { return sha256Bytes(canonicalReleaseValue(value)) }
function fail(message) { throw new Error(`local release adapter: ${message}`) }
function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}
function text(value, label, pattern = /^.+$/u, maximum = 2_000) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || value.includes('\0')
    || value.includes('\r') || value.includes('\n') || !pattern.test(value)) fail(`${label} is invalid`)
  return value
}
function exactKeys(value, expected, label) {
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail(`${label} has unknown or missing fields`)
}
function canonicalPath(value, label) {
  const path = text(value, label)
  if (!isAbsolute(path) || path === '/' || realpathSync(path) !== resolve(path)) fail(`${label} must be an existing canonical absolute path`)
  return path
}
function privateDirectory(path, label) {
  const metadata = lstatSync(path); const uid = process.getuid?.()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || (uid !== undefined && metadata.uid !== uid) || realpathSync(path) !== resolve(path)) fail(`${label} must be an owner-private canonical directory`)
}
function ensurePrivateSubdirectory(root, components, label) {
  let current = root; privateDirectory(current, `${label} root`)
  for (const component of components) {
    if (!/^[A-Za-z0-9%._-]+$/u.test(component) || component === '.' || component === '..') fail(`${label} component is invalid`)
    current = join(current, component)
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
    privateDirectory(current, label)
  }
  return current
}
function fsyncDirectory(path) { const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY); try { fsyncSync(descriptor) } finally { closeSync(descriptor) } }
function privateFile(path, label, maximum = 65_536) {
  const canonical = canonicalPath(path, label); const metadata = lstatSync(canonical); const uid = process.getuid?.()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maximum
    || (metadata.mode & 0o077) !== 0 || (uid !== undefined && metadata.uid !== uid)) fail(`${label} must be an owner-private regular file`)
  privateDirectory(dirname(canonical), `${label} directory`)
  return canonical
}
function assertPrivateAncestors(path, stop, label) {
  let current = resolve(path); const boundary = resolve(stop)
  while (true) {
    privateDirectory(current, label)
    if (current === boundary) return
    const parent = dirname(current)
    if (parent === current || (current !== boundary && !current.startsWith(`${boundary}${sep}`))) fail(`${label} escapes its trusted root`)
    current = parent
  }
}
function safeRegularFile(path, label, maximum = MAX_ARTIFACT_BYTES) {
  const canonical = canonicalPath(path, label); const metadata = lstatSync(canonical); const uid = process.getuid?.()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maximum
    || (metadata.mode & 0o022) !== 0 || (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)) fail(`${label} is unsafe`)
  return canonical
}
function stableBytes(path, label, maximum = MAX_ARTIFACT_BYTES) {
  const canonical = safeRegularFile(path, label, maximum)
  const descriptor = openSync(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  let bytes; let before; let after
  try { before = fstatSync(descriptor, { bigint: true }); bytes = inheritedDescriptorBytes(descriptor, label, maximum); after = fstatSync(descriptor, { bigint: true }) }
  finally { closeSync(descriptor) }
  const pathAfter = lstatSync(canonical, { bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
    || BigInt(bytes.length) !== before.size) fail(`${label} changed during read`)
  return bytes
}
function openPinnedFile(spec, label, maximum = MAX_ARTIFACT_BYTES, executable = false) {
  const item = object(spec, label); exactKeys(item, ['path', 'sha256'], label)
  const path = canonicalPath(item.path, `${label}.path`); const expected = text(item.sha256, `${label}.sha256`, DIGEST)
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); const uid = process.getuid?.()
  try {
    const before = fstatSync(descriptor, { bigint: true }); const pathBefore = lstatSync(path, { bigint: true })
    const expectedUid = uid === undefined ? undefined : BigInt(uid)
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)
      || (before.mode & 0o022n) !== 0n || (executable && (before.mode & 0o111n) === 0n)
      || (expectedUid !== undefined && before.uid !== expectedUid && before.uid !== 0n)
      || pathBefore.isSymbolicLink() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino) fail(`${label} is unsafe`)
    const bytes = inheritedDescriptorBytes(descriptor, label, maximum); const after = fstatSync(descriptor, { bigint: true })
    if (sha256Bytes(bytes) !== expected || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail(`${label} digest or identity changed`)
    return { path, sha256: expected, descriptor, device: before.dev, inode: before.ino }
  } catch (error) { closeSync(descriptor); throw error }
}
function verifyPinnedFile(value, label, maximum = MAX_ARTIFACT_BYTES) {
  const metadata = fstatSync(value.descriptor, { bigint: true })
  if (metadata.dev !== value.device || metadata.ino !== value.inode
    || sha256Bytes(inheritedDescriptorBytes(value.descriptor, label, maximum)) !== value.sha256) fail(`${label} changed during use`)
}
function closePinnedFile(value) { if (value?.descriptor !== undefined) closeSync(value.descriptor) }
function openPinnedDirectory(value, label) {
  const path = canonicalPath(value.path, `${label}.path`); const pathMetadata = lstatSync(path, { bigint: true })
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  const metadata = fstatSync(descriptor, { bigint: true }); const uid = process.getuid?.(); const expectedUid = uid === undefined ? undefined : BigInt(uid)
  if (!metadata.isDirectory() || (metadata.mode & 0o022n) !== 0n || (expectedUid !== undefined && metadata.uid !== expectedUid && metadata.uid !== 0n)) {
    closeSync(descriptor); fail(`${label} directory descriptor is unsafe`)
  }
  if (pathMetadata.isSymbolicLink() || pathMetadata.dev !== metadata.dev || pathMetadata.ino !== metadata.ino) {
    closeSync(descriptor); fail(`${label} directory identity changed while opening`)
  }
  return { ...value, descriptor, device: metadata.dev, inode: metadata.ino, label }
}
function closePinnedDirectory(value) { if (value?.descriptor !== undefined) closeSync(value.descriptor) }
function verifyPinnedDirectory(value) {
  const metadata = fstatSync(value.descriptor, { bigint: true })
  if (!metadata.isDirectory() || metadata.dev !== value.device || metadata.ino !== value.inode) fail(`${value.label} directory changed during use`)
}
function directoryInventory(path, label) {
  const root = canonicalPath(path, `${label}.path`); const rootMetadata = lstatSync(root); const uid = process.getuid?.()
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o022) !== 0
    || (uid !== undefined && rootMetadata.uid !== uid && rootMetadata.uid !== 0)) fail(`${label} is not a trusted directory`)
  const inventory = []
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const entryPath = join(directory, name); const entryName = prefix === '' ? name : `${prefix}/${name}`; const metadata = lstatSync(entryPath)
      if ((!metadata.isSymbolicLink() && (metadata.mode & 0o022) !== 0)
        || (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)) {
        fail(`${label} contains an unsafe entry: ${entryName}`)
      }
      if (metadata.isDirectory()) { inventory.push({ path: entryName, type: 'directory', mode: metadata.mode & 0o777 }); visit(entryPath, entryName) }
      else if (metadata.isFile()) {
        const bytes = readFileSync(entryPath)
        if (bytes.length > MAX_ARTIFACT_BYTES) fail(`${label} contains an oversized file`)
        inventory.push({ path: entryName, type: 'file', mode: metadata.mode & 0o777, bytes: bytes.length, sha256: sha256Bytes(bytes) })
      } else if (metadata.isSymbolicLink()) {
        const target = readlinkSync(entryPath)
        if (isAbsolute(target)) fail(`${label} contains an absolute symlink`)
        const resolved = resolve(dirname(entryPath), target)
        if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) fail(`${label} contains an escaping symlink: ${entryName} -> ${target}`)
        inventory.push({ path: entryName, type: 'symlink', target })
      } else fail(`${label} contains an unsupported entry`)
    }
  }
  visit(root)
  return { path: root, inventory, sha256: digest(inventory) }
}
function pinnedDirectory(spec, label) {
  const item = object(spec, label); exactKeys(item, ['path', 'sha256'], label)
  const expected = text(item.sha256, `${label}.sha256`, DIGEST); const inspected = directoryInventory(item.path, label)
  if (inspected.sha256 !== expected) fail(`${label} digest does not match the owner pin`)
  return { path: inspected.path, sha256: expected }
}
function copyPinnedTree(source, destination, label) {
  const sourceRoot = openPinnedDirectory(source, label)
  try {
    mkdirSync(destination, { mode: 0o700 })
    const visit = (sourceDirectory, sourceLogicalPath, destinationDirectory) => {
      for (const name of readdirSync(`/proc/self/fd/${sourceDirectory.descriptor}`).sort()) {
        const sourcePath = `/proc/self/fd/${sourceDirectory.descriptor}/${name}`; const destinationPath = join(destinationDirectory, name)
        const metadata = lstatSync(sourcePath)
        if (metadata.isDirectory()) {
          mkdirSync(destinationPath, { mode: metadata.mode & 0o777 })
          chmodSync(destinationPath, metadata.mode & 0o777)
          const child = openSync(sourcePath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
          try { visit({ descriptor: child }, join(sourceLogicalPath, name), destinationPath) } finally { closeSync(child) }
        } else if (metadata.isFile()) {
          const bytes = readFileSync(sourcePath)
          writeFileSync(destinationPath, bytes, { mode: metadata.mode & 0o777, flag: 'wx' })
          chmodSync(destinationPath, metadata.mode & 0o777)
        } else if (metadata.isSymbolicLink()) {
          const target = readlinkSync(sourcePath)
          if (isAbsolute(target)) fail(`${label} contains an absolute symlink`)
          const resolved = resolve(dirname(join(sourceLogicalPath, name)), target)
          if (resolved !== source.path && !resolved.startsWith(`${source.path}${sep}`)) fail(`${label} contains an escaping symlink`)
          symlinkSync(target, destinationPath)
        } else fail(`${label} contains an unsupported entry`)
      }
    }
    visit(sourceRoot, source.path, destination)
  } finally { closePinnedDirectory(sourceRoot) }
  if (directoryInventory(destination, `${label} snapshot`).sha256 !== source.sha256) fail(`${label} snapshot digest differs`)
}
function readBounded(path, label, maximum = MAX_ARTIFACT_BYTES) { return stableBytes(path, label, maximum) }
function inheritedArtifactBytes(kind) {
  const [environmentName, expectedFd, maximum] = ARTIFACT_FDS[kind]
  if (process.env[environmentName] !== String(expectedFd)) fail(`${environmentName} must bind inherited fd ${expectedFd}`)
  return inheritedDescriptorBytes(expectedFd, `inherited ${kind}`, maximum)
}
function inspectExecutable(spec, label) {
  const executable = openPinnedFile(spec, label, MAX_ARTIFACT_BYTES, true); closePinnedFile(executable)
  return { path: executable.path, sha256: executable.sha256 }
}
function inheritedDescriptorBytes(descriptor, label, maximum) {
  const before = fstatSync(descriptor, { bigint: true }); const uid = process.getuid?.(); const expectedUid = uid === undefined ? undefined : BigInt(uid)
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum) || (before.mode & 0o022n) !== 0n
    || (expectedUid !== undefined && before.uid !== expectedUid && before.uid !== 0n)) fail(`${label} fd is unsafe`)
  const bytes = Buffer.alloc(Number(before.size)); let offset = 0
  while (offset < bytes.length) { const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (count === 0) fail(`${label} ended early`); offset += count }
  const after = fstatSync(descriptor, { bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs) fail(`${label} changed during read`)
  return bytes
}
function runningAdapterDigest() {
  const argument = process.argv[1]
  if (typeof argument !== 'string') fail('adapter executable argument is missing')
  const descriptor = argument.match(/^\/proc\/self\/fd\/(\d+)$/u)
  return descriptor === null ? sha256Bytes(stableBytes(argument, 'running adapter executable', MAX_ARTIFACT_BYTES))
    : sha256Bytes(inheritedDescriptorBytes(Number(descriptor[1]), 'running adapter executable', MAX_ARTIFACT_BYTES))
}
function runningInterpreterDigest() {
  const descriptor = process.execPath.match(/^\/proc\/self\/fd\/(\d+)$/u)
  return descriptor === null ? sha256Bytes(stableBytes(process.execPath, 'running adapter interpreter', MAX_ARTIFACT_BYTES))
    : sha256Bytes(inheritedDescriptorBytes(Number(descriptor[1]), 'running adapter interpreter', MAX_ARTIFACT_BYTES))
}
function relativePath(value, label) {
  const path = text(value, label, /^[A-Za-z0-9._/@+-]+$/u)
  if (isAbsolute(path) || path === '.' || path.split('/').some(part => part === '' || part === '.' || part === '..')) fail(`${label} is not a safe relative path`)
  return path
}
function within(root, candidate, label) {
  const value = resolve(root, candidate); const suffix = relative(root, value)
  if (suffix === '' || suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) fail(`${label} escapes its root`)
  return value
}

function readOwnerJson(path, label) {
  const source = readBounded(path, label, 65_536).toString('utf8')
  try { return object(JSON.parse(source), label) } catch (error) { if (error instanceof SyntaxError) fail(`${label} is not valid JSON`); throw error }
}
function readPrivateJsonUnder(root, name, label) {
  const path = join(root, name); const canonical = privateFile(path, label, 262_144)
  if (!canonical.startsWith(`${root}${sep}`)) fail(`${label} escapes its root`)
  return readOwnerJson(canonical, label)
}
function configEnvironment(phase) { return `DSH_RELEASE_${phase.toUpperCase().replaceAll('-', '_')}_CONFIG` }
function loadConfig(environment, phase) {
  const environmentName = configEnvironment(phase)
  const configPath = privateFile(text(environment[environmentName], environmentName), 'adapter config')
  const config = readOwnerJson(configPath, 'adapter config')
  const allowed = ['schemaVersion', 'id', 'phase', 'executablePath', 'authority', 'keyId', 'privateKeyPath', 'authorizationAuthority', 'stateRoot',
    'registryVerifier', 'git', 'build', 'registry', 'catalog']
  if (Object.keys(config).some(key => !allowed.includes(key))) fail('adapter config has unknown fields')
  if (config.schemaVersion !== 1 || !PHASES.has(config.phase)) fail('adapter config schema or phase is invalid')
  const id = text(config.id, 'adapter id', ID); const executablePath = canonicalPath(config.executablePath, 'adapter executable path')
  const authority = text(config.authority, 'adapter authority', ID); const keyId = text(config.keyId, 'adapter key id', ID)
  const privateKeyPath = privateFile(config.privateKeyPath, 'adapter private key', 16_384)
  const stateRoot = canonicalPath(config.stateRoot, 'adapter state root'); privateDirectory(stateRoot, 'adapter state root')
  const authorizationAuthority = loadPublicIdentity(config.authorizationAuthority, 'release authorization authority')
  const registryVerifier = config.registryVerifier === undefined
    ? undefined : loadPublicIdentity(config.registryVerifier, 'registry verifier')
  if (phase === 'catalog-admission' && registryVerifier === undefined) fail('catalog adapter requires an explicit registry verifier')
  if (phase !== 'catalog-admission' && registryVerifier !== undefined) fail('registry verifier identity is only valid for catalog admission')
  const privateKey = createPrivateKey(readBounded(privateKeyPath, 'adapter private key', 16_384))
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('adapter private key must be Ed25519')
  if (registryVerifier !== undefined && ((registryVerifier.authority === authority && registryVerifier.keyId === keyId)
    || registryVerifier.publicKey.equals(createPublicKey(privateKey)))) {
    fail('catalog adapter and registry verifier identities and keys must be independent')
  }
  return { ...config, configPath, id, executablePath, authority, keyId, privateKeyPath, privateKey, stateRoot, authorizationAuthority, registryVerifier }
}
function loadPublicIdentity(value, label) {
  const item = object(value, label); exactKeys(item, ['authority', 'keyId', 'publicKeyPath'], label)
  const authority = text(item.authority, `${label}.authority`, ID); const keyId = text(item.keyId, `${label}.keyId`, ID)
  const publicKeyPath = privateFile(item.publicKeyPath, `${label}.public key`, 16_384)
  const publicKey = createPublicKey(readBounded(publicKeyPath, `${label}.public key`, 16_384))
  if (publicKey.asymmetricKeyType !== 'ed25519') fail(`${label} public key must be Ed25519`)
  return { authority, keyId, publicKeyPath, publicKey }
}
function gitConfig(value) {
  const item = object(value, 'git config')
  const allowed = ['executable', 'remote', 'targetBranch', 'authorName', 'authorEmail', 'reviewStore', 'reviewDecisionRoot', 'reviewAuthority']
  if (Object.keys(item).some(key => !allowed.includes(key))) fail('git config has unknown fields')
  const executable = inspectExecutable(item.executable, 'git')
  const remote = canonicalPath(item.remote, 'git remote')
  const remoteMetadata = lstatSync(remote); const uid = process.getuid?.()
  if (!remoteMetadata.isDirectory() || remoteMetadata.isSymbolicLink() || (remoteMetadata.mode & 0o077) !== 0
    || (uid !== undefined && remoteMetadata.uid !== uid)) fail('git remote must be owner-private')
  if (!existsSync(join(remote, 'HEAD'))) fail('git remote must be a local bare repository')
  assertPrivateAncestors(remote, dirname(remote), 'git remote')
  const targetBranch = text(item.targetBranch, 'git target branch', /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u)
  if (targetBranch.includes('..') || targetBranch.startsWith('/') || targetBranch.endsWith('/') || targetBranch.includes('//')) fail('git target branch is invalid')
  const authorName = text(item.authorName, 'git author name', /^.{1,128}$/u, 128)
  const authorEmail = text(item.authorEmail, 'git author email', /^[^@\s]+@[^@\s]+$/u, 254)
  let reviewStore; let reviewDecisionRoot; let reviewAuthority
  if (item.reviewStore !== undefined) { reviewStore = canonicalPath(item.reviewStore, 'review store'); privateDirectory(reviewStore, 'review store') }
  if (item.reviewDecisionRoot !== undefined) {
    reviewDecisionRoot = canonicalPath(item.reviewDecisionRoot, 'review decision root'); privateDirectory(reviewDecisionRoot, 'review decision root')
  }
  if (item.reviewAuthority !== undefined) reviewAuthority = loadPublicIdentity(item.reviewAuthority, 'review authority')
  return { executable, remote, targetBranch, authorName, authorEmail, reviewStore, reviewDecisionRoot, reviewAuthority }
}
function registryConfig(value) {
  const item = object(value, 'registry config')
  const allowed = ['id', 'root', 'locator', 'downloadRoot', 'signer']
  if (Object.keys(item).some(key => !allowed.includes(key))) fail('registry config has unknown fields')
  const id = text(item.id, 'registry id', ID); const root = canonicalPath(item.root, 'registry root'); privateDirectory(root, 'registry root')
  const locator = text(item.locator, 'registry locator')
  if (locator !== pathToFileURL(root).href) fail('registry locator must be the exact local registry file URL')
  let downloadRoot
  if (item.downloadRoot !== undefined) {
    downloadRoot = canonicalPath(item.downloadRoot, 'registry download root'); privateDirectory(downloadRoot, 'registry download root')
    if (downloadRoot === root || downloadRoot.startsWith(`${root}${sep}`) || root.startsWith(`${downloadRoot}${sep}`)) fail('registry verifier download root must be independent')
  }
  const signer = item.signer === undefined ? undefined : loadPublicIdentity(item.signer, 'artifact signer')
  return { id, root, locator, downloadRoot, signer }
}
function registryPublicationPath(registry, packageName, packageVersion) {
  return join(registry.root, 'packages', encodeURIComponent(packageName), packageVersion, 'publication.json')
}
function catalogConfig(value) {
  const item = object(value, 'catalog config'); exactKeys(item, ['id', 'path', 'helper', 'interpreter'], 'catalog config')
  const id = text(item.id, 'catalog id', ID); const path = canonicalPath(item.path, 'catalog path')
  const helper = object(item.helper, 'catalog admission helper'); exactKeys(helper, ['path', 'sha256'], 'catalog admission helper')
  const interpreter = object(item.interpreter, 'catalog helper interpreter'); exactKeys(interpreter, ['path', 'sha256'], 'catalog helper interpreter')
  inspectExecutable(interpreter, 'catalog helper interpreter')
  return { id, path, helper, interpreter }
}
function buildConfig(value) {
  const item = object(value, 'build config')
  exactKeys(item, ['sandboxExecutable', 'tarExecutable', 'pnpmExecutable', 'pnpmRoot', 'storeRoot'], 'build config')
  const sandboxExecutable = inspectExecutable(item.sandboxExecutable, 'build sandbox')
  const tarExecutable = inspectExecutable(item.tarExecutable, 'tar')
  if (sandboxExecutable.path !== '/usr/bin/bwrap') fail('local build adapter requires the pinned Linux bubblewrap sandbox')
  const pnpmExecutable = inspectExecutable(item.pnpmExecutable, 'pnpm executable')
  const pnpmRoot = pinnedDirectory(item.pnpmRoot, 'pnpm root')
  const storeRoot = pinnedDirectory(item.storeRoot, 'pnpm store')
  if (pnpmExecutable.path !== join(pnpmRoot.path, 'pnpm')) fail('pnpm executable must be the pinned pnpm root entrypoint')
  let pnpmManifest
  try { pnpmManifest = object(JSON.parse(readFileSync(join(pnpmRoot.path, 'package.json'), 'utf8')), 'pnpm manifest') }
  catch (error) { if (error instanceof SyntaxError) fail('pnpm manifest is invalid'); throw error }
  const pnpmVersion = text(pnpmManifest.version, 'pnpm version', VERSION)
  const storeVersion = Number.parseInt(pnpmVersion.split('.')[0], 10)
  const projectsPath = join(storeRoot.path, `v${storeVersion}`, 'projects')
  if (!existsSync(projectsPath) || !lstatSync(projectsPath).isDirectory()) fail('pnpm store project registry is unavailable')
  return { sandboxExecutable, tarExecutable, pnpmExecutable, pnpmRoot, storeRoot, storeVersion }
}
function verifyBuildPins(build) {
  for (const [item, label] of [[build.pnpmRoot, 'pnpm root'], [build.storeRoot, 'pnpm store']]) {
    if (directoryInventory(item.path, label).sha256 !== item.sha256) fail(`${label} changed after configuration validation`)
  }
}

function command(executable, args, cwd, extraEnvironment = {}, input, inherited = [], hooks = {}) {
  if (process.platform !== 'linux' || !existsSync('/proc/self/fd')) fail('descriptor-pinned commands require Linux /proc/self/fd')
  const pinned = openPinnedFile(executable, `pinned ${basename(executable.path)} executable`, MAX_ARTIFACT_BYTES, true)
  const descriptor = 3 + inherited.length
  try {
    const header = Buffer.alloc(4); readSync(pinned.descriptor, header, 0, header.length, 0)
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('pinned child executable must be a native ELF binary')
    hooks.beforeSpawn?.({ executable: pinned.path, descriptor: pinned.descriptor, args })
    const result = spawnSync(`/proc/self/fd/${descriptor}`, args, {
      cwd, env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin', ...extraEnvironment }, input, encoding: null,
      maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', ...inherited, pinned.descriptor],
    })
    hooks.afterSpawn?.({ executable: pinned.path, descriptor: pinned.descriptor, args, status: result.status })
    verifyPinnedFile(pinned, `pinned ${basename(executable.path)} executable`)
    if (result.error !== undefined || (result.status !== 0 && !hooks.allowedStatuses?.includes(result.status))) {
      const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : ''
      const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8').trim() : ''
      const detail = (stderr === '' ? stdout : stderr).slice(0, 2_000)
      fail(`pinned ${basename(executable.path)} command failed (${args.join(' ')}, ${String(result.status)})${detail === '' ? '' : `: ${detail}`}`)
    }
    return result.stdout ?? Buffer.alloc(0)
  } finally {
    try { hooks.afterFinally?.() } finally { closePinnedFile(pinned) }
  }
}
function runPinnedNodeModule(interpreter, module, source, cwd, input, hooks = {}) {
  if (process.platform !== 'linux' || !existsSync('/proc/self/fd')) fail('descriptor-pinned modules require Linux /proc/self/fd')
  const node = openPinnedFile(interpreter, 'pinned module interpreter', MAX_ARTIFACT_BYTES, true)
  const script = openPinnedFile(module, 'pinned module', MAX_ARTIFACT_BYTES, false)
  try {
    const header = Buffer.alloc(4); readSync(node.descriptor, header, 0, header.length, 0)
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('pinned module interpreter must be a native ELF binary')
    hooks.beforeSpawn?.({ interpreter: node.path, module: script.path })
    const result = spawnSync('/proc/self/fd/4', ['--input-type=module', '-e', source], { cwd, input, encoding: null, maxBuffer: 32 * 1024 * 1024,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', script.descriptor, node.descriptor] })
    hooks.afterSpawn?.({ interpreter: node.path, module: script.path, status: result.status })
    verifyPinnedFile(node, 'pinned module interpreter'); verifyPinnedFile(script, 'pinned module')
    if (result.error !== undefined || result.status !== 0) {
      const detail = (result.stderr ?? Buffer.alloc(0)).toString('utf8').trim().slice(0, 2_000)
      fail(`pinned module failed (${String(result.status)})${detail === '' ? '' : `: ${detail}`}`)
    }
    return result.stdout ?? Buffer.alloc(0)
  } finally {
    try { hooks.afterFinally?.() } finally { closePinnedFile(script); closePinnedFile(node) }
  }
}
const SAFE_GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null']
function openSandboxContext(build, workspace, output, runRoot) {
  const storeProjects = join(runRoot, 'store-projects')
  if (!existsSync(storeProjects)) mkdirSync(storeProjects, { mode: 0o700 })
  const toolchainSnapshot = join(runRoot, 'toolchain-snapshot'); const storeSnapshot = join(runRoot, 'store-snapshot')
  if (!existsSync(toolchainSnapshot)) copyPinnedTree(build.pnpmRoot, toolchainSnapshot, 'pnpm root')
  if (!existsSync(storeSnapshot)) copyPinnedTree(build.storeRoot, storeSnapshot, 'pnpm store')
  const pnpmRoot = openPinnedDirectory({ path: toolchainSnapshot, sha256: build.pnpmRoot.sha256 }, 'pnpm snapshot')
  const storeRoot = openPinnedDirectory({ path: storeSnapshot, sha256: build.storeRoot.sha256 }, 'pnpm store snapshot')
  const workspaceRoot = openPinnedDirectory({ path: workspace }, 'build workspace')
  const outputRoot = openPinnedDirectory({ path: output }, 'build output')
  const storeProjectsRoot = openPinnedDirectory({ path: storeProjects }, 'pnpm project registry')
  const mounts = [pnpmRoot, storeRoot, workspaceRoot, outputRoot, storeProjectsRoot]
  return { mounts, runRoot }
}
function closeSandboxContext(context) { for (const item of context.mounts) closePinnedDirectory(item) }
function sandboxCommand(build, args, context, hooks = {}) {
  const { mounts, runRoot } = context
  for (const item of mounts) verifyPinnedDirectory(item)
  const mountFd = index => String(3 + index)
  const sandboxArgs = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--ro-bind-fd', mountFd(0), '/toolchain', '--ro-bind-fd', mountFd(1), '/store',
    '--bind-fd', mountFd(4), `/store/v${build.storeVersion}/projects`, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home',
    '--bind-fd', mountFd(2), '/workspace', '--bind-fd', mountFd(3), '/output',
    '--chdir', '/workspace', '--setenv', 'HOME', '/home', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'SOURCE_DATE_EPOCH', '0',
    '--setenv', 'PATH', '/toolchain:/usr/bin:/bin', '/toolchain/pnpm', ...args]
  command(build.sandboxExecutable, sandboxArgs, runRoot, {}, undefined, mounts.map(item => item.descriptor),
    { beforeSpawn: hooks.beforeSandboxSpawn, afterSpawn: hooks.afterSandboxSpawn, afterFinally: hooks.afterSandboxFinally })
  for (const item of mounts) verifyPinnedDirectory(item)
}
function git(gitValue, args, cwd, environment = {}, hooks = {}) {
  return command(gitValue.executable, [...SAFE_GIT_CONFIG, ...args], cwd,
    { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...environment }, undefined, [],
    { beforeSpawn: hooks.beforeGitSpawn, afterSpawn: hooks.afterGitSpawn, afterFinally: hooks.afterGitFinally })
}
function remoteRef(gitValue, ref, hooks = {}) {
  const output = command(gitValue.executable, ['--git-dir', gitValue.remote, 'show-ref', '--verify', '--hash', ref], gitValue.remote, {}, undefined, [], {
    beforeSpawn: hooks.beforeGitSpawn, afterSpawn: hooks.afterGitSpawn, afterFinally: hooks.afterGitFinally, allowedStatuses: [1, 128],
  }).toString('utf8').trim()
  return output === '' ? undefined : output
}
function commitEnvironment(config, requestedAt) {
  const date = new Date(requestedAt).toISOString()
  return {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: config.authorName, GIT_AUTHOR_EMAIL: config.authorEmail, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: config.authorName, GIT_COMMITTER_EMAIL: config.authorEmail, GIT_COMMITTER_DATE: date,
  }
}
function safeScope(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail('source scope is invalid')
  const scope = [...new Set(value.map((entry, index) => relativePath(entry.normalize('NFC').trim(), `scope[${index}]`)))].sort()
  return scope
}
function changedPaths(gitValue, worktree, baseCommit) {
  const tracked = git(gitValue, ['--literal-pathspecs', 'diff', '--no-renames', '--name-only', '-z', baseCommit, '--'], worktree)
    .toString('utf8').split('\0').filter(Boolean)
  const untracked = git(gitValue, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z'], worktree)
    .toString('utf8').split('\0').filter(Boolean)
  return [...new Set([...tracked, ...untracked])].sort()
}
function expectedSourceScope(name) { return ['plugins/README.md', `plugins/${name}`].sort() }
function pathAllowed(path, scope) {
  return scope.some(root => path === root || (root !== 'plugins/README.md' && path.startsWith(`${root}/`)))
}
function sourceDigests(gitValue, worktree, baseCommit, scope, operationDirectory) {
  const indexPath = join(operationDirectory, 'source.index')
  rmSync(indexPath, { force: true })
  const environment = { GIT_INDEX_FILE: indexPath, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  git(gitValue, ['read-tree', baseCommit], worktree, environment)
  git(gitValue, ['--literal-pathspecs', 'add', '--all', '--', ...scope], worktree, environment)
  const tree = git(gitValue, ['write-tree'], worktree, environment).toString('utf8').trim()
  const treeListing = git(gitValue, ['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--stage', '-z', '--', ...scope], worktree, environment)
  const patch = git(gitValue, ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--cached', '--binary', '--full-index', '--no-color',
    baseCommit, '--', ...scope], worktree, environment)
  if (!COMMIT.test(tree) || patch.length === 0) fail('source change is empty')
  const binding = Buffer.from(`${baseCommit}\0${JSON.stringify(scope)}\0`)
  const treeDigest = createHash('sha256').update('dsh-source-tree-v2\0').update(binding).update(treeListing).digest('hex')
  const patchDigest = createHash('sha256').update('dsh-source-patch-v2\0').update(binding).update(patch).digest('hex')
  return { indexPath, environment, tree, treeDigest, patchDigest }
}

function validateAuthorization(request) {
  const authorization = object(request.authorization, 'source authorization')
  exactKeys(authorization, ['schemaVersion', 'kind', 'authorizationId', 'authority', 'keyId', 'planId', 'planDigest', 'baseCommit',
    'checkedTreeDigest', 'checkedPatchDigest', 'scope', 'releasePolicy', 'authorizedAt', 'expiresAt', 'signature', 'signatureDigest'], 'source authorization')
  const policy = object(authorization.releasePolicy, 'source release policy')
  exactKeys(policy, ['targetBranch', 'candidateId', 'packageName', 'packageVersion', 'packagePath', 'dshBaseline', 'capabilities',
    'authorities', 'requires', 'registryId', 'registryLocator', 'registryReference', 'catalogId', 'catalogPath',
    'minimumReproducibleBuilds'], 'source release policy')
  text(authorization.signatureDigest, 'authorization signature digest', DIGEST)
  const authorizationSignature = text(authorization.signature, 'authorization signature', /^[A-Za-z0-9+/]+={0,2}$/u, 16_384)
  const authorizationSignatureBytes = Buffer.from(authorizationSignature, 'base64')
  if (authorization.schemaVersion !== 1 || authorization.kind !== 'dsh-source-release-authorization'
    || !ID.test(authorization.authorizationId) || !ID.test(authorization.authority) || !ID.test(authorization.keyId)
    || authorization.planId !== request.plan.id || authorization.planDigest !== request.plan.digest
    || authorization.baseCommit === undefined || !COMMIT.test(authorization.baseCommit)
    || !DIGEST.test(authorization.checkedTreeDigest) || !DIGEST.test(authorization.checkedPatchDigest)
    || digest(authorization.scope) !== digest(safeScope(authorization.scope))
    || !Number.isSafeInteger(authorization.authorizedAt) || !Number.isSafeInteger(authorization.expiresAt)
    || authorization.authorizedAt > request.requestedAt || request.requestedAt > authorization.expiresAt
    || text(policy.targetBranch, 'authorized target branch') === '' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(policy.candidateId)
    || !PACKAGE.test(policy.packageName) || !VERSION.test(policy.packageVersion)
    || relativePath(policy.packagePath, 'authorized package path') !== policy.packagePath
    || !VERSION.test(policy.dshBaseline) || !Number.isSafeInteger(policy.minimumReproducibleBuilds) || policy.minimumReproducibleBuilds < 2
    || policy.minimumReproducibleBuilds > 16
    || authorizationSignatureBytes.length !== 64 || authorizationSignatureBytes.toString('base64') !== authorizationSignature
    || sha256Bytes(authorizationSignatureBytes) !== authorization.signatureDigest
    || policy.registryId !== request.registry.id || policy.registryLocator !== request.registry.locator
    || ('catalog' in request && (policy.catalogId !== request.catalog.id || policy.catalogPath !== request.catalog.path))
    || typeof policy.registryReference !== 'string' || policy.registryReference === '') fail('source authorization is not bound to this request')
  const normalizeStrings = (value, label) => {
    if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'string' || entry.normalize('NFC').trim() === '')) fail(`${label} is invalid`)
    const normalized = [...new Set(value.map(entry => entry.normalize('NFC').trim()))].sort()
    if (digest(value) !== digest(normalized)) fail(`${label} is not canonical`)
    return normalized
  }
  normalizeStrings(policy.capabilities, 'authorized capabilities'); normalizeStrings(policy.authorities, 'authorized authorities')
  if (!Array.isArray(policy.requires)) fail('authorized requirements are invalid')
  for (const requirement of policy.requires) {
    const item = object(requirement, 'authorized requirement'); exactKeys(item, ['package', 'version', 'integrity'], 'authorized requirement')
    text(item.package, 'authorized required package', PACKAGE); text(item.version, 'authorized required version', VERSION)
    text(item.integrity, 'authorized required integrity', /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
  }
  return authorization
}
function verifyAuthorizationSignature(authorization, config) {
  if (authorization.authority !== config.authorizationAuthority.authority || authorization.keyId !== config.authorizationAuthority.keyId) {
    fail('source authorization uses an untrusted authority')
  }
  const { signature, signatureDigest: _signatureDigest, ...unsigned } = authorization
  if (!verify(null, Buffer.from(canonicalReleaseValue(unsigned)), config.authorizationAuthority.publicKey, Buffer.from(signature, 'base64'))) {
    fail('source authorization signature is invalid')
  }
}
function validateRequest(request, config) {
  exactKeys(object(request, 'release request'), ['schemaVersion', 'kind', 'operationId', 'attempt', 'requestedAt', 'receiptTtlMs',
    'installationId', 'ledger', 'plan', 'release', 'authorization', 'adapter', 'registry', 'catalog', 'phase', 'input'], 'release request')
  if (request.schemaVersion !== 1 || request.kind !== 'dsh-source-release-request' || request.phase !== config.phase
    || !PHASES.has(request.phase) || !ID.test(request.operationId) || !Number.isSafeInteger(request.requestedAt)
    || !Number.isSafeInteger(request.attempt) || request.attempt < 1 || !Number.isSafeInteger(request.receiptTtlMs)
    || request.receiptTtlMs < 1_000 || request.receiptTtlMs > 300_000) fail('release request envelope is invalid')
  const ledger = object(request.ledger, 'release ledger'); exactKeys(ledger, ['id', 'path'], 'release ledger')
  const plan = object(request.plan, 'release plan'); exactKeys(plan, ['id', 'digest', 'revision'], 'release plan')
  const release = object(request.release, 'release fence'); exactKeys(release, ['id', 'fence'], 'release fence')
  const registry = object(request.registry, 'release registry'); exactKeys(registry, ['id', 'locator'], 'release registry')
  const catalog = object(request.catalog, 'release catalog'); exactKeys(catalog, ['id', 'path'], 'release catalog')
  const adapter = object(request.adapter, 'adapter identity'); exactKeys(adapter, ['id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'adapter identity')
  const interpreter = object(adapter.interpreter, 'adapter interpreter'); exactKeys(interpreter, ['path', 'sha256'], 'adapter interpreter')
  if (!ID.test(plan.id) || !DIGEST.test(plan.digest) || !Number.isSafeInteger(plan.revision) || plan.revision < 1
    || !ID.test(release.id) || !Number.isSafeInteger(release.fence) || release.fence < 1
    || adapter.id !== config.id || adapter.version !== LOCAL_RELEASE_ADAPTER_VERSION || adapter.authority !== config.authority || adapter.keyId !== config.keyId
    || adapter.path !== config.executablePath || runningAdapterDigest() !== adapter.sha256
    || runningInterpreterDigest() !== interpreter.sha256) {
    fail('release request is not bound to this adapter')
  }
  const authorization = validateAuthorization(request)
  verifyAuthorizationSignature(authorization, config)
  const input = object(request.input, `${request.phase} input`)
  const fields = { pr: ['repository', 'worktree', 'baseCommit', 'name', 'scope', 'expectedTreeDigest', 'expectedPatchDigest'],
    review: ['prId', 'headCommit', 'baseCommit', 'prEvidenceDigest'], merge: ['prId', 'headCommit', 'reviewId', 'reviewEvidenceDigest', 'targetBranch'],
    build: ['repository', 'mergeCommit', 'mergeEvidenceDigest', 'name', 'expectedCandidateId', 'expectedPackageName', 'expectedPackageVersion',
      'expectedPackagePath', 'expectedDshBaseline', 'expectedCapabilities', 'expectedAuthorities', 'expectedRequires'],
    sign: ['artifact', 'buildEvidenceDigest'], publish: ['artifact', 'artifactStatementDigest', 'artifactSignature', 'signEvidenceDigest'],
    'registry-verify': ['artifact', 'artifactStatementDigest', 'artifactSignature', 'registryReference', 'publishEvidenceDigest'],
    'catalog-admission': ['artifact', 'artifactStatementDigest', 'artifactSignature', 'registryReference', 'registryVerificationRequest',
      'registryVerificationReceipt', 'verificationEvidenceDigest',
      'expectedBeforeCatalogDigest', 'expectedAfterCatalogDigest', 'candidate'] }
  exactKeys(input, fields[request.phase], `${request.phase} input`)
  return { authorization }
}
function validateCatalogRegistryVerificationReceipt(request, config) {
  if (request.phase !== 'catalog-admission') return undefined
  if (config.registryVerifier === undefined) fail('catalog adapter has no trusted registry verifier')
  const verificationRequest = object(request.input.registryVerificationRequest, 'registry verification request')
  exactKeys(verificationRequest, ['schemaVersion', 'kind', 'operationId', 'attempt', 'requestedAt', 'receiptTtlMs',
    'installationId', 'ledger', 'plan', 'release', 'authorization', 'adapter', 'registry', 'catalog', 'phase', 'input'],
  'registry verification request')
  if (verificationRequest.phase !== 'registry-verify') fail('nested registry verification request has the wrong phase')
  const verificationInput = object(verificationRequest.input, 'registry verification request input')
  exactKeys(verificationInput, ['artifact', 'artifactStatementDigest', 'artifactSignature', 'registryReference', 'publishEvidenceDigest'],
    'registry verification request input')
  const verificationAdapter = object(verificationRequest.adapter, 'registry verifier adapter identity')
  exactKeys(verificationAdapter, ['id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'registry verifier adapter identity')
  const verificationLedger = object(verificationRequest.ledger, 'registry verification ledger')
  exactKeys(verificationLedger, ['id', 'path'], 'registry verification ledger')
  const verificationPlan = object(verificationRequest.plan, 'registry verification plan')
  exactKeys(verificationPlan, ['id', 'digest', 'revision'], 'registry verification plan')
  const verificationRelease = object(verificationRequest.release, 'registry verification release')
  exactKeys(verificationRelease, ['id', 'fence'], 'registry verification release')
  const verificationRegistry = object(verificationRequest.registry, 'registry verification registry')
  exactKeys(verificationRegistry, ['id', 'locator'], 'registry verification registry')
  const verificationCatalog = object(verificationRequest.catalog, 'registry verification catalog')
  exactKeys(verificationCatalog, ['id', 'path'], 'registry verification catalog')
  const verificationInterpreter = verificationAdapter.interpreter === null ? null
    : object(verificationAdapter.interpreter, 'registry verifier interpreter')
  if (verificationInterpreter !== null) exactKeys(verificationInterpreter, ['path', 'sha256'], 'registry verifier interpreter')
  const receipt = object(request.input.registryVerificationReceipt, 'registry verification receipt')
  exactKeys(receipt, ['schemaVersion', 'receiptId', 'authority', 'keyId', 'installationId', 'planId', 'planDigest', 'releaseId',
    'fence', 'operationId', 'requestDigest', 'phase', 'outcome', 'evidence', 'evidenceDigest', 'observedAt', 'expiresAt', 'signature'],
  'registry verification receipt')
  const evidence = object(receipt.evidence, 'registry verification evidence')
  exactKeys(evidence, ['kind', 'registryId', 'registryReference', 'independentlyDownloaded', 'downloadedBytes', 'downloadedSha256',
    'downloadedIntegrity', 'artifactStatementDigest', 'artifactSignatureDigest', 'publishEvidenceDigest'], 'registry verification evidence')
  const signatureValue = text(receipt.signature, 'registry verification receipt signature', /^[A-Za-z0-9+/]+={0,2}$/u, 16_384)
  const signatureBytes = Buffer.from(signatureValue, 'base64')
  for (const [value, label] of [[receipt.planDigest, 'registry receipt plan digest'], [receipt.requestDigest, 'registry receipt request digest'],
    [receipt.evidenceDigest, 'registry receipt evidence digest'], [evidence.downloadedSha256, 'registry downloaded digest'],
    [evidence.artifactStatementDigest, 'registry artifact statement digest'],
    [evidence.artifactSignatureDigest, 'registry artifact signature digest'],
    [evidence.publishEvidenceDigest, 'registry publish evidence digest']]) text(value, label, DIGEST)
  text(evidence.downloadedIntegrity, 'registry downloaded integrity', /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
  if (verificationRequest.schemaVersion !== 1 || verificationRequest.kind !== 'dsh-source-release-request'
    || verificationRequest.phase !== 'registry-verify' || !ID.test(verificationRequest.operationId)
    || !Number.isSafeInteger(verificationRequest.attempt) || verificationRequest.attempt < 1
    || !ID.test(verificationLedger.id) || typeof verificationLedger.path !== 'string' || !isAbsolute(verificationLedger.path)
    || !ID.test(verificationPlan.id) || !DIGEST.test(verificationPlan.digest) || !Number.isSafeInteger(verificationPlan.revision) || verificationPlan.revision < 1
    || !ID.test(verificationRelease.id) || !Number.isSafeInteger(verificationRelease.fence) || verificationRelease.fence < 1
    || !ID.test(verificationRegistry.id) || typeof verificationRegistry.locator !== 'string'
    || !ID.test(verificationCatalog.id) || typeof verificationCatalog.path !== 'string' || !isAbsolute(verificationCatalog.path)
    || !ID.test(verificationAdapter.id) || !ID.test(verificationAdapter.authority) || !ID.test(verificationAdapter.keyId)
    || verificationAdapter.version !== LOCAL_RELEASE_ADAPTER_VERSION || typeof verificationAdapter.path !== 'string'
    || !isAbsolute(verificationAdapter.path) || !DIGEST.test(verificationAdapter.sha256)
    || (verificationInterpreter !== null && (!isAbsolute(verificationInterpreter.path) || !DIGEST.test(verificationInterpreter.sha256)))
    || receipt.schemaVersion !== 1 || receipt.phase !== 'registry-verify' || receipt.outcome !== 'passed'
    || evidence.kind !== 'registry-verify' || evidence.independentlyDownloaded !== true
    || !ID.test(receipt.receiptId) || !ID.test(receipt.authority) || !ID.test(receipt.keyId)
    || !ID.test(receipt.planId) || !ID.test(receipt.releaseId) || !ID.test(receipt.operationId)
    || !Number.isSafeInteger(receipt.fence) || receipt.fence < 1
    || !Number.isSafeInteger(receipt.observedAt) || !Number.isSafeInteger(receipt.expiresAt)
    || !Number.isSafeInteger(verificationRequest.requestedAt) || !Number.isSafeInteger(verificationRequest.receiptTtlMs)
    || verificationRequest.receiptTtlMs < 1_000 || verificationRequest.receiptTtlMs > 300_000
    || receipt.expiresAt <= receipt.observedAt || receipt.expiresAt - receipt.observedAt > verificationRequest.receiptTtlMs
    || verificationRequest.requestedAt < request.authorization.authorizedAt
    || verificationRequest.requestedAt > request.authorization.expiresAt || receipt.observedAt < verificationRequest.requestedAt
    || receipt.observedAt > request.requestedAt || receipt.expiresAt > request.authorization.expiresAt || Date.now() > receipt.expiresAt
    || !Number.isSafeInteger(evidence.downloadedBytes) || evidence.downloadedBytes < 1
    || signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signatureValue) {
    fail('registry verification receipt envelope is invalid or expired')
  }
  const verificationRequestDigest = digest(verificationRequest)
  if (receipt.authority !== config.registryVerifier.authority || receipt.keyId !== config.registryVerifier.keyId) {
    fail('registry verification receipt uses an untrusted verifier identity')
  }
  const { signature: _signature, ...unsigned } = receipt
  if (receipt.evidenceDigest !== digest(evidence)
    || !verify(null, Buffer.from(canonicalReleaseValue(unsigned)), config.registryVerifier.publicKey, signatureBytes)) {
    fail('registry verification receipt signature or evidence digest is invalid')
  }
  const artifact = request.input.artifact
  const artifactSignatureDigest = sha256Bytes(Buffer.from(request.input.artifactSignature, 'base64'))
  if (request.input.verificationEvidenceDigest !== receipt.evidenceDigest
    || receipt.operationId !== verificationRequest.operationId || receipt.requestDigest !== verificationRequestDigest
    || receipt.authority !== verificationAdapter.authority || receipt.keyId !== verificationAdapter.keyId
    || receipt.installationId !== request.installationId || receipt.planId !== request.plan.id
    || receipt.planDigest !== request.plan.digest || receipt.releaseId !== request.release.id || receipt.fence !== request.release.fence
    || verificationRequest.installationId !== request.installationId || verificationRequest.plan.id !== request.plan.id
    || verificationRequest.plan.digest !== request.plan.digest || verificationRequest.plan.revision + 1 !== request.plan.revision
    || verificationRequest.release.id !== request.release.id
    || verificationRequest.release.fence !== request.release.fence
    || digest(verificationRequest.authorization) !== digest(request.authorization)
    || digest(verificationLedger) !== digest(request.ledger) || digest(verificationCatalog) !== digest(request.catalog)
    || digest(verificationRequest.registry) !== digest(request.registry)
    || digest(verificationInput.artifact) !== digest(artifact)
    || verificationInput.registryReference !== request.input.registryReference
    || verificationInput.artifactStatementDigest !== request.input.artifactStatementDigest
    || verificationInput.artifactSignature !== request.input.artifactSignature
    || evidence.publishEvidenceDigest !== verificationInput.publishEvidenceDigest
    || evidence.registryId !== request.registry.id || evidence.registryReference !== request.input.registryReference
    || evidence.downloadedBytes !== artifact.tarballBytes || evidence.downloadedSha256 !== artifact.tarballSha256
    || evidence.downloadedIntegrity !== artifact.tarballIntegrity
    || evidence.artifactStatementDigest !== request.input.artifactStatementDigest
    || evidence.artifactSignatureDigest !== artifactSignatureDigest) {
    fail('registry verification receipt is not bound to this catalog request and signed artifact')
  }
  return receipt
}
function validatePhasePolicy(request, config) {
  const policy = request.authorization.releasePolicy
  if (request.phase === 'pr' || request.phase === 'review' || request.phase === 'merge' || request.phase === 'build') {
    if (gitConfig(config.git).targetBranch !== policy.targetBranch) fail('Git adapter is not bound to the authorized target branch')
  }
  if (request.phase === 'build') {
    buildConfig(config.build)
  }
  if (request.phase === 'publish' || request.phase === 'registry-verify' || request.phase === 'catalog-admission') {
    const registry = registryConfig(config.registry)
    if (registry.id !== policy.registryId || registry.locator !== request.registry.locator) fail('registry adapter is not bound to the authorized registry')
  }
}

function operationContext(request, config) {
  const requestDigest = digest(request); const operationKey = sha256Bytes(request.operationId)
  const operationsRoot = ensurePrivateSubdirectory(config.stateRoot, ['operations'], 'operations directory')
  const directory = ensurePrivateSubdirectory(operationsRoot, [operationKey], 'operation directory')
  const bindingPath = join(directory, 'binding.json'); const binding = { operationId: request.operationId, requestDigest }
  if (!existsSync(bindingPath)) immutableJson(bindingPath, binding, 0o600)
  const prior = readOwnerJson(bindingPath, 'operation binding')
  if (prior.operationId !== request.operationId || prior.requestDigest !== requestDigest) fail('operation id was reused with a different request')
  const releaseLock = acquireProcessLock(join(directory, 'execution.lock'), 'operation')
  const invocations = ensurePrivateSubdirectory(config.stateRoot, ['invocations'], 'invocations directory')
  immutableJson(join(invocations, `${operationKey}-${process.pid}.json`), {
    operationId: request.operationId, requestDigest, phase: request.phase, pid: process.pid,
    executable: config.executablePath, authority: config.authority, keyId: config.keyId,
  }, 0o600)
  const receiptPath = join(directory, 'receipt.json')
  if (existsSync(receiptPath)) {
    const cached = readOwnerJson(receiptPath, 'operation receipt')
    if (cached.requestDigest !== requestDigest) fail('cached operation request digest changed')
    releaseLock(); return { directory, requestDigest, receiptPath, cached: cached.receipt, releaseLock: undefined }
  }
  return { directory, requestDigest, receiptPath, releaseLock }
}
function reconciliationContext(request, config) {
  const requestDigest = digest(request); const operationKey = sha256Bytes(request.operationId)
  const operationsRoot = ensurePrivateSubdirectory(config.stateRoot, ['reconciliations'], 'reconciliations directory')
  const directory = ensurePrivateSubdirectory(operationsRoot, [operationKey], 'reconciliation directory')
  const bindingPath = join(directory, 'binding.json'); const binding = { operationId: request.operationId, requestDigest }
  if (!existsSync(bindingPath)) immutableJson(bindingPath, binding, 0o600)
  const prior = readOwnerJson(bindingPath, 'reconciliation binding')
  if (prior.operationId !== request.operationId || prior.requestDigest !== requestDigest) fail('reconciliation operation id was reused with a different request')
  const releaseLock = acquireProcessLock(join(directory, 'execution.lock'), 'reconciliation')
  const invocations = ensurePrivateSubdirectory(config.stateRoot, ['invocations'], 'invocations directory')
  immutableJson(join(invocations, `${operationKey}-${process.pid}.reconcile.json`), { operationId: request.operationId, requestDigest,
    phase: 'registry-verify', command: 'reconcile', pid: process.pid, executable: config.executablePath,
    authority: config.authority, keyId: config.keyId }, 0o600)
  const receiptPath = join(directory, 'receipt.json')
  if (existsSync(receiptPath)) {
    const cached = readOwnerJson(receiptPath, 'reconciliation receipt')
    if (cached.requestDigest !== requestDigest) fail('cached reconciliation request digest changed')
    releaseLock(); return { directory, requestDigest, receiptPath, cached: cached.receipt, releaseLock: undefined }
  }
  return { directory, requestDigest, receiptPath, releaseLock }
}
function acquireProcessLock(path, label, retried = false) {
  try {
    writeSynced(path, Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`), 0o600)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let owner
    try { owner = readOwnerJson(path, `${label} execution lock`) } catch { fail(`${label} execution lock is invalid`) }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) fail(`${label} execution lock is invalid`)
    try { process.kill(owner.pid, 0); fail(`${label} is already executing`) } catch (probe) {
      if (probe?.code !== 'ESRCH') throw probe
    }
    if (retried) fail(`${label} stale execution lock raced`)
    unlinkSync(path); return acquireProcessLock(path, label, true)
  }
  let released = false
  return () => {
    if (released) return
    const owner = readOwnerJson(path, `${label} execution lock`)
    if (owner.pid !== process.pid) fail(`${label} execution lock ownership changed`)
    unlinkSync(path); released = true
  }
}
function writeSynced(path, bytes, mode = 0o600) {
  const descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode)
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
function immutableJson(path, value, mode = 0o600) {
  const bytes = Buffer.from(`${canonicalReleaseValue(value)}\n`)
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeSynced(temporary, bytes, mode)
  try { linkSync(temporary, path); fsyncDirectory(dirname(path)) } catch (error) { if (error?.code !== 'EEXIST') throw error } finally { unlinkSync(temporary); fsyncDirectory(dirname(path)) }
}
function immutableCopy(path, bytes, mode = 0o444) {
  if (existsSync(path)) {
    if (sha256Bytes(readBounded(path, 'immutable destination')) !== sha256Bytes(bytes)) fail('immutable destination already contains different bytes')
    return false
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700)
  const temporary = join(dirname(path), `.tmp-${basename(path)}-${process.pid}-${Date.now()}`)
  writeSynced(temporary, bytes, 0o600)
  try { linkSync(temporary, path); chmodSync(path, mode); fsyncDirectory(dirname(path)) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (sha256Bytes(readFileSync(path)) !== sha256Bytes(bytes)) fail('immutable destination raced with different bytes')
  } finally { unlinkSync(temporary); fsyncDirectory(dirname(path)) }
  return true
}
function assertUnexpired(request, label) { if (Date.now() > request.authorization.expiresAt) fail(`${label} crossed the authorization expiry`) }

function prPhase(request, config, context, authorization) {
  const input = object(request.input, 'PR input'); const gitValue = gitConfig(config.git)
  const repository = canonicalPath(input.repository, 'source repository'); const worktree = canonicalPath(input.worktree, 'source worktree')
  if (repository !== worktree) {
    const common = git(gitValue, ['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree).toString('utf8').trim()
    const repositoryGit = git(gitValue, ['rev-parse', '--path-format=absolute', '--git-common-dir'], repository).toString('utf8').trim()
    if (realpathSync(common) !== realpathSync(repositoryGit)) fail('source worktree is not linked to the approved repository')
  }
  const baseCommit = text(input.baseCommit, 'base commit', COMMIT); const sourceName = text(input.name, 'source name', /^[a-z0-9][a-z0-9-]{0,63}$/u)
  const scope = safeScope(input.scope); const expectedScope = expectedSourceScope(sourceName)
  if (digest(scope) !== digest(expectedScope) || digest(input.scope) !== digest(scope)
    || authorization.baseCommit !== baseCommit || digest(scope) !== digest(safeScope(authorization.scope))) {
    fail('PR input changed after owner authorization')
  }
  const current = git(gitValue, ['rev-parse', 'HEAD'], worktree).toString('utf8').trim()
  if (current !== baseCommit || remoteRef(gitValue, `refs/heads/${gitValue.targetBranch}`) !== baseCommit) fail('source or target branch moved from the authorized base')
  const changes = changedPaths(gitValue, worktree, baseCommit)
  if (changes.length === 0 || changes.some(path => !pathAllowed(path, scope))) fail('source changes escape the authorized scope')
  const source = sourceDigests(gitValue, worktree, baseCommit, scope, context.directory)
  const expectedTreeDigest = text(input.expectedTreeDigest, 'expected tree digest', DIGEST)
  const expectedPatchDigest = text(input.expectedPatchDigest, 'expected patch digest', DIGEST)
  if (source.treeDigest !== expectedTreeDigest || source.patchDigest !== expectedPatchDigest
    || authorization.checkedTreeDigest !== source.treeDigest || authorization.checkedPatchDigest !== source.patchDigest) fail('source bytes changed after post-check authorization')
  const headCommit = git(gitValue, ['commit-tree', source.tree, '-p', baseCommit, '-m', `dsh source release ${request.plan.id}`],
    worktree, { ...source.environment, ...commitEnvironment(gitValue, request.requestedAt) }).toString('utf8').trim()
  if (!COMMIT.test(headCommit) || headCommit === baseCommit) fail('PR commit was not created')
  const prId = `pr-${sha256Bytes(request.operationId).slice(0, 32)}`; const ref = `refs/dsh-release/pulls/${prId}/head`
  const prior = remoteRef(gitValue, ref)
  assertUnexpired(request, 'PR creation')
  if (prior === undefined) git(gitValue, ['push', '--force-with-lease=' + ref + ':', gitValue.remote, `${headCommit}:${ref}`], worktree)
  else if (prior !== headCommit) fail('PR ref already exists with a different head')
  if (remoteRef(gitValue, ref) !== headCommit) fail('PR ref did not become durable')
  return { kind: 'pr', prId, baseCommit, headCommit,
    repositoryDigest: digest({ remote: gitValue.remote, ref, baseCommit, headCommit, treeDigest: source.treeDigest, patchDigest: source.patchDigest }),
    treeDigest: source.treeDigest, patchDigest: source.patchDigest }
}
function reviewPhase(request, config) {
  const input = object(request.input, 'review input'); const gitValue = gitConfig(config.git)
  if (gitValue.reviewStore === undefined || gitValue.reviewDecisionRoot === undefined) fail('review stores are not configured')
  const prId = text(input.prId, 'PR id', ID); const headCommit = text(input.headCommit, 'review head', COMMIT)
  const baseCommit = text(input.baseCommit, 'review base', COMMIT); text(input.prEvidenceDigest, 'PR evidence digest', DIGEST)
  if (remoteRef(gitValue, `refs/dsh-release/pulls/${prId}/head`) !== headCommit) fail('reviewed PR ref does not match the requested head')
  const parents = git(gitValue, ['--git-dir', gitValue.remote, 'rev-list', '--parents', '-n', '1', headCommit], gitValue.remote).toString('utf8').trim().split(' ')
  if (parents.length !== 2 || parents[1] !== baseCommit) fail('reviewed PR is not based on the exact authorized commit')
  const decision = readPrivateJsonUnder(gitValue.reviewDecisionRoot, `${prId}.json`, 'review decision')
  exactKeys(decision, ['schemaVersion', 'kind', 'prId', 'baseCommit', 'headCommit', 'prEvidenceDigest', 'decision', 'reviewerPrincipal'], 'review decision')
  if (decision.schemaVersion !== 1 || decision.kind !== 'dsh-local-review-decision' || decision.decision !== 'approved'
    || decision.prId !== prId || decision.baseCommit !== baseCommit || decision.headCommit !== headCommit
    || decision.prEvidenceDigest !== input.prEvidenceDigest) fail('review decision is not bound to the exact PR evidence')
  const reviewerPrincipal = text(decision.reviewerPrincipal, 'reviewer principal', /^.{1,500}$/u, 500)
  const reviewId = `review-${sha256Bytes(request.operationId).slice(0, 32)}`
  return { kind: 'review', prId, headCommit, reviewId, decision: 'approved',
    reviewerPrincipalDigest: sha256Bytes(reviewerPrincipal), prEvidenceDigest: input.prEvidenceDigest }
}
function readReviewReceipt(gitValue, reviewId) {
  if (gitValue.reviewStore === undefined || gitValue.reviewAuthority === undefined) fail('independent review verification is not configured')
  const receipt = readPrivateJsonUnder(gitValue.reviewStore, `${reviewId}.json`, 'review receipt')
  const { signature, ...unsigned } = receipt
  if (receipt.authority !== gitValue.reviewAuthority.authority || receipt.keyId !== gitValue.reviewAuthority.keyId
    || !verify(null, Buffer.from(canonicalReleaseValue(unsigned)), gitValue.reviewAuthority.publicKey, Buffer.from(signature, 'base64'))) fail('independent review receipt signature is invalid')
  return receipt
}
function mergePhase(request, config, authorization) {
  const input = object(request.input, 'merge input'); const gitValue = gitConfig(config.git)
  const prId = text(input.prId, 'PR id', ID); const headCommit = text(input.headCommit, 'merge head', COMMIT)
  const reviewId = text(input.reviewId, 'review id', ID); const reviewEvidenceDigest = text(input.reviewEvidenceDigest, 'review evidence digest', DIGEST)
  const targetBranch = text(input.targetBranch, 'target branch')
  if (targetBranch !== gitValue.targetBranch) fail('merge target branch is not owner-configured')
  const review = readReviewReceipt(gitValue, reviewId)
  if (review.outcome !== 'passed' || review.phase !== 'review' || review.evidence?.reviewId !== reviewId
    || review.evidence.prId !== prId || review.evidence.headCommit !== headCommit || review.evidenceDigest !== reviewEvidenceDigest) fail('merge is not bound to the independent review receipt')
  if (remoteRef(gitValue, `refs/dsh-release/pulls/${prId}/head`) !== headCommit) fail('PR head changed after review')
  const baseCommit = text(authorization.baseCommit, 'authorized base', COMMIT); const targetRef = `refs/heads/${targetBranch}`
  const target = remoteRef(gitValue, targetRef)
  const tree = git(gitValue, ['--git-dir', gitValue.remote, 'rev-parse', `${headCommit}^{tree}`], gitValue.remote).toString('utf8').trim()
  const mergeCommit = git(gitValue, ['--git-dir', gitValue.remote, 'commit-tree', tree, '-p', baseCommit, '-p', headCommit,
    '-m', `Merge ${prId} after ${reviewId}`], gitValue.remote, commitEnvironment(gitValue, request.requestedAt)).toString('utf8').trim()
  if (!COMMIT.test(mergeCommit)) fail('merge commit was not created')
  assertUnexpired(request, 'merge')
  if (target === baseCommit) git(gitValue, ['--git-dir', gitValue.remote, 'update-ref', targetRef, mergeCommit, baseCommit], gitValue.remote)
  else if (target !== mergeCommit) fail('target branch moved before merge CAS')
  if (remoteRef(gitValue, targetRef) !== mergeCommit) fail('merge ref did not become durable')
  return { kind: 'merge', prId, reviewedHeadCommit: headCommit, reviewId, reviewEvidenceDigest, mergeCommit, targetBranch }
}

function copyBuildWorkspace(source, destination) {
  cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: true, filter: path => {
    const name = basename(path)
    return name !== '.git' && name !== 'node_modules'
  } })
  const inspect = path => {
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) fail('build source contains an unsupported filesystem entry')
    if (metadata.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name))
  }
  inspect(destination)
}
function fileInventory(root) {
  const result = []
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const relativeName = prefix === '' ? name : `${prefix}/${name}`; const metadata = lstatSync(path)
      if (metadata.isDirectory()) visit(path, relativeName)
      else if (metadata.isFile()) { const bytes = readFileSync(path); result.push({ path: relativeName, bytes: bytes.length, sha256: sha256Bytes(bytes) }) }
      else fail('package inventory contains an unsupported entry')
    }
  }
  visit(root); return result
}
function prepareBuildSource(request, context, gitValue, hooks) {
  const bundle = join(context.directory, 'source.bundle'); rmSync(bundle, { force: true })
  const temporaryRef = `refs/dsh-release/build/${sha256Bytes(request.operationId).slice(0, 32)}`
  git(gitValue, ['--git-dir', gitValue.remote, 'update-ref', temporaryRef, request.input.mergeCommit], gitValue.remote, {}, hooks)
  try { git(gitValue, ['--git-dir', gitValue.remote, 'bundle', 'create', bundle, temporaryRef], gitValue.remote, {}, hooks) }
  finally { git(gitValue, ['--git-dir', gitValue.remote, 'update-ref', '-d', temporaryRef], gitValue.remote, {}, hooks) }
  chmodSync(bundle, 0o400); return bundle
}
function unpackPackage(build, tarball, staging, runRoot, hooks) {
  mkdirSync(staging, { mode: 0o700 })
  const commandHooks = { beforeSpawn: hooks.beforeTarSpawn, afterSpawn: hooks.afterTarSpawn, afterFinally: hooks.afterTarFinally }
  const names = command(build.tarExecutable, ['-tzf', tarball], runRoot, {}, undefined, [], commandHooks).toString('utf8').split('\n').filter(Boolean)
  if (names.length === 0 || names.some(name => name.startsWith('/') || name.includes('\0')
    || name.split('/').some(part => part === '..') || (name !== 'package' && !name.startsWith('package/')))) {
    fail('packed archive contains an unsafe path')
  }
  command(build.tarExecutable, ['--no-same-owner', '--no-same-permissions', '-xzf', tarball, '-C', staging], runRoot, {}, undefined, [], commandHooks)
  const packageRoot = join(staging, 'package')
  if (!existsSync(packageRoot) || !lstatSync(packageRoot).isDirectory()) fail('packed archive has no package root')
  const inventory = fileInventory(packageRoot)
  return { packageRoot, inventory }
}
function runIsolatedBuild(request, context, runNumber, gitValue, build, packagePath, sourceBundle, hooks) {
  const runRoot = join(context.directory, `build-${runNumber}`); rmSync(runRoot, { recursive: true, force: true }); mkdirSync(runRoot, { mode: 0o700 })
  const checkout = join(runRoot, 'checkout'); mkdirSync(checkout, { mode: 0o700 }); git(gitValue, ['init'], checkout, {}, hooks)
  git(gitValue, ['fetch', sourceBundle, temporaryBuildRef(request)], checkout, {}, hooks); git(gitValue, ['checkout', '--detach', 'FETCH_HEAD'], checkout, {}, hooks)
  if (git(gitValue, ['rev-parse', 'HEAD'], checkout).toString('utf8').trim() !== request.input.mergeCommit
    || git(gitValue, ['status', '--porcelain=v1', '--untracked-files=all'], checkout).length !== 0) fail('exact build checkout is not clean')
  const workspace = join(runRoot, 'workspace'); copyBuildWorkspace(checkout, workspace)
  const packageRoot = within(workspace, packagePath, 'package path')
  if (!lstatSync(packageRoot).isDirectory() || realpathSync(packageRoot) !== resolve(packageRoot)) fail('expected package directory is unavailable')
  const output = join(runRoot, 'pack-output'); mkdirSync(output, { mode: 0o700 })
  const sandbox = openSandboxContext(build, workspace, output, runRoot)
  try {
    sandboxCommand(build, ['install', '--offline', '--frozen-lockfile', '--frozen-store', '--ignore-scripts',
      '--package-import-method=copy', '--store-dir=/store'], sandbox, hooks)
    sandboxCommand(build, ['--dir', `/workspace/${packagePath}`, 'run', 'build'], sandbox, hooks)
    sandboxCommand(build, ['--dir', `/workspace/${packagePath}`, 'pack', '--pack-destination', '/output'], sandbox, hooks)
  } finally { closeSandboxContext(sandbox) }
  const packed = readdirSync(output).filter(name => name.endsWith('.tgz'))
  if (packed.length !== 1 || readdirSync(output).length !== 1) fail('pnpm pack must produce exactly one tarball')
  const tarball = safeRegularFile(join(output, packed[0]), `isolated build ${runNumber} tarball`)
  const bytes = readBounded(tarball, `isolated build ${runNumber} tarball`)
  const unpacked = unpackPackage(build, tarball, join(runRoot, 'packed'), runRoot, hooks)
  return { runRoot, checkout, workspace, packageRoot: unpacked.packageRoot, inventory: unpacked.inventory, tarball, bytes, sha256: sha256Bytes(bytes) }
}
function temporaryBuildRef(request) { return `refs/dsh-release/build/${sha256Bytes(request.operationId).slice(0, 32)}` }
function buildPhase(request, config, context, hooks) {
  const input = object(request.input, 'build input'); const gitValue = gitConfig(config.git); const build = buildConfig(config.build)
  const mergeCommit = text(input.mergeCommit, 'merge commit', COMMIT); text(input.mergeEvidenceDigest, 'merge evidence digest', DIGEST)
  const packageName = text(input.expectedPackageName, 'expected package name', PACKAGE)
  const packageVersion = text(input.expectedPackageVersion, 'expected package version', VERSION)
  const packagePath = relativePath(input.expectedPackagePath, 'expected package path')
  const sourceName = text(input.name, 'source name', /^[a-z0-9][a-z0-9-]{0,63}$/u)
  const candidateId = text(input.expectedCandidateId, 'expected candidate id', /^[a-z0-9][a-z0-9-]{0,63}$/u)
  const policy = request.authorization.releasePolicy
  if (candidateId !== sourceName || policy.candidateId !== candidateId || policy.packageName !== packageName
    || policy.packageVersion !== packageVersion || policy.packagePath !== packagePath || policy.dshBaseline !== input.expectedDshBaseline
    || digest(policy.capabilities) !== digest(input.expectedCapabilities) || digest(policy.authorities) !== digest(input.expectedAuthorities)
    || digest(policy.requires) !== digest(input.expectedRequires) || policy.targetBranch !== gitValue.targetBranch
    || !safeScope(request.authorization.scope).some(scope => pathAllowed(packagePath, [scope]))) {
    fail('build input does not match the owner-authorized release policy')
  }
  if (remoteRef(gitValue, `refs/heads/${gitValue.targetBranch}`, hooks) !== mergeCommit) fail('build commit is not the exact merged target')
  const sourceBundle = prepareBuildSource(request, context, gitValue, hooks)
  verifyBuildPins(build)
  const builds = [runIsolatedBuild(request, context, 1, gitValue, build, packagePath, sourceBundle, hooks)]
  for (let index = 2; index <= policy.minimumReproducibleBuilds; index += 1) {
    const repeated = runIsolatedBuild(request, context, index, gitValue, build, packagePath, sourceBundle, hooks)
    if (builds[0].sha256 !== repeated.sha256 || digest(builds[0].inventory) !== digest(repeated.inventory)) fail('isolated builds are not reproducible')
    builds.push(repeated)
  }
  verifyBuildPins(build)
  const first = builds[0]
  const manifest = readOwnerJson(join(first.packageRoot, 'package.json'), 'built package manifest')
  if (manifest.name !== packageName || manifest.version !== packageVersion || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    fail('built package identity or DSH bundle metadata does not match the request')
  }
  const packedPaths = new Set(first.inventory.map(file => file.path))
  for (const required of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) if (!packedPaths.has(required)) fail(`packed package is missing ${required}`)
  if (![...packedPaths].some(path => path.startsWith('lib/')) || [...packedPaths].some(path => path === 'src' || path.startsWith('src/')
    || path === 'tests' || path.startsWith('tests/') || path === 'tsconfig.json' || path.startsWith('tsconfig.'))) fail('packed package inventory is invalid')
  const outputs = ensurePrivateSubdirectory(context.directory, ['outputs'], 'build outputs directory')
  assertUnexpired(request, 'build artifact commit')
  const tarballPath = join(outputs, 'package.tgz'); immutableCopy(tarballPath, first.bytes, 0o600)
  const tarballBytes = first.bytes.length; const tarballSha256 = first.sha256; const tarballIntegrity = sha512Integrity(first.bytes)
  const sbom = { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${request.installationId}`, version: 1,
    metadata: { component: { type: 'library', name: packageName, version: packageVersion } },
    components: first.inventory.map(file => ({ type: 'file', name: file.path, hashes: [{ alg: 'SHA-256', content: file.sha256 }],
      properties: [{ name: 'dsh:file-bytes', value: String(file.bytes) }] })) }
  const sbomPath = join(outputs, 'sbom.cdx.json'); immutableCopy(sbomPath, Buffer.from(`${canonicalReleaseValue(sbom)}\n`), 0o600)
  const provenance = { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: packageName, digest: { sha256: tarballSha256 } }],
    predicateType: 'https://slsa.dev/provenance/v1', predicate: { buildDefinition: { buildType: 'https://dsh-enhanced.dev/build/local-isolated/v1',
      externalParameters: { packagePath, packageVersion }, resolvedDependencies: [{ uri: pathToFileURL(gitValue.remote).href, digest: { gitCommit: mergeCommit } }] },
    runDetails: { builder: { id: `dsh-local-release-adapter:${config.authority}:${config.keyId}` }, metadata: { invocationId: request.operationId },
      byproducts: [{ name: 'sbom', digest: { sha256: sha256Bytes(readFileSync(sbomPath)) } }] } } }
  const provenancePath = join(outputs, 'provenance.intoto.jsonl'); immutableCopy(provenancePath, Buffer.from(`${canonicalReleaseValue(provenance)}\n`), 0o600)
  const metadata = { dshBaseline: input.expectedDshBaseline, capabilities: input.expectedCapabilities,
    authorities: input.expectedAuthorities, requires: input.expectedRequires }
  return { kind: 'build', isolated: true, reproducibleBuilds: policy.minimumReproducibleBuilds, firstBuildSha256: first.sha256, secondBuildSha256: builds[1].sha256,
    mergeEvidenceDigest: input.mergeEvidenceDigest, sourceName, candidateId, packagePath, packageName, packageVersion,
    tarballPath: realpathSync(tarballPath), tarballBytes, tarballSha256, tarballIntegrity,
    sbomPath: realpathSync(sbomPath), sbomSha256: sha256Bytes(readFileSync(sbomPath)), provenancePath: realpathSync(provenancePath),
    provenanceSha256: sha256Bytes(readFileSync(provenancePath)), mergedCommit: mergeCommit, ...metadata }
}
function artifactSigningPayload(artifact) { return canonicalReleaseValue({ schemaVersion: 1, kind: 'dsh-release-artifact', artifact }) }
function verifyArtifactFiles(artifact) {
  const tarball = inheritedArtifactBytes('tarball'); const sbom = inheritedArtifactBytes('sbom'); const provenance = inheritedArtifactBytes('provenance')
  if (tarball.length !== artifact.tarballBytes || sha256Bytes(tarball) !== artifact.tarballSha256 || sha512Integrity(tarball) !== artifact.tarballIntegrity
    || sha256Bytes(sbom) !== artifact.sbomSha256 || sha256Bytes(provenance) !== artifact.provenanceSha256) fail('inherited artifact files do not match build evidence')
  return tarball
}
function signPhase(request, config) {
  const input = object(request.input, 'sign input'); const artifact = object(input.artifact, 'release artifact')
  text(input.buildEvidenceDigest, 'build evidence digest', DIGEST); verifyArtifactFiles(artifact)
  assertUnexpired(request, 'artifact signing')
  const artifactStatementDigest = digest(artifact)
  const artifactSignature = sign(null, Buffer.from(artifactSigningPayload(artifact)), config.privateKey).toString('base64')
  return { kind: 'sign', artifactStatementDigest, artifactSignature, artifactSignatureDigest: sha256Bytes(Buffer.from(artifactSignature, 'base64')),
    buildEvidenceDigest: input.buildEvidenceDigest }
}
function verifySignedArtifact(input, registry, verifyFiles = true) {
  if (registry.signer === undefined) fail('artifact signer is not configured')
  const artifact = object(input.artifact, 'release artifact'); const statementDigest = text(input.artifactStatementDigest, 'artifact statement digest', DIGEST)
  const signature = text(input.artifactSignature, 'artifact signature', /^[A-Za-z0-9+/]+={0,2}$/u, 16_384)
  if (statementDigest !== digest(artifact)
    || !verify(null, Buffer.from(artifactSigningPayload(artifact)), registry.signer.publicKey, Buffer.from(signature, 'base64'))) fail('artifact signature is invalid')
  return { artifact, statementDigest, signature, signatureDigest: sha256Bytes(Buffer.from(signature, 'base64')),
    ...(verifyFiles ? { tarball: verifyArtifactFiles(artifact) } : {}) }
}
async function publishPhase(request, config, hooks) {
  const input = object(request.input, 'publish input'); const registry = registryConfig(config.registry)
  if (request.registry.id !== registry.id || request.registry.locator !== registry.locator) fail('publish request targets a different registry')
  text(input.signEvidenceDigest, 'sign evidence digest', DIGEST)
  const signed = verifySignedArtifact(input, registry); const artifact = signed.artifact
  const packagesRoot = ensurePrivateSubdirectory(registry.root, ['packages'], 'registry packages directory')
  const packageDirectory = ensurePrivateSubdirectory(packagesRoot, [encodeURIComponent(artifact.packageName)], 'registry package directory')
  const versionDirectory = join(packageDirectory, artifact.packageVersion)
  const objectPath = join(versionDirectory, 'package.tgz')
  assertUnexpired(request, 'registry publication')
  const recordPath = join(versionDirectory, 'publication.json')
  const registryReference = pathToFileURL(objectPath).href
  if (request.authorization.releasePolicy.registryReference !== registryReference) fail('published registry reference is not the owner-authorized immutable reference')
  const publication = { schemaVersion: 1, registryId: registry.id, packageName: artifact.packageName, packageVersion: artifact.packageVersion,
    tarballSha256: artifact.tarballSha256, tarballIntegrity: artifact.tarballIntegrity, artifactStatementDigest: signed.statementDigest,
    artifactSignatureDigest: signed.signatureDigest, registryReference }
  if (!existsSync(versionDirectory)) {
    const stagingName = `.pending-${artifact.packageVersion}-${sha256Bytes(request.operationId).slice(0, 32)}`
    const staging = ensurePrivateSubdirectory(packageDirectory, [stagingName], 'registry staging directory')
    const stagingObject = join(staging, 'package.tgz'); const stagingRecord = join(staging, 'publication.json')
    immutableCopy(stagingObject, signed.tarball, 0o400)
    await hooks.afterPublishObject?.({ request, config, objectPath: stagingObject, recordPath: stagingRecord, publication })
    assertUnexpired(request, 'registry publication record commit')
    if (!existsSync(stagingRecord)) immutableJson(stagingRecord, publication, 0o400)
    else if (digest(readOwnerJson(stagingRecord, 'staged registry publication')) !== digest(publication)) fail('staged publication differs')
    fsyncDirectory(staging)
    try { renameSync(staging, versionDirectory); fsyncDirectory(packageDirectory) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
    }
  }
  privateDirectory(versionDirectory, 'registry version directory')
  if (digest(readOwnerJson(recordPath, 'registry publication')) !== digest(publication)
    || sha256Bytes(readBounded(objectPath, 'registry object')) !== artifact.tarballSha256) fail('package version is already immutably published with different evidence')
  const hookResult = await hooks.afterPublishWrite?.({ request, config, objectPath, recordPath, publication })
  if (hookResult?.outcome === 'ambiguous') throw new PublishAmbiguity(hookResult.detail ?? 'publish outcome is ambiguous')
  return { kind: 'publish', registryId: registry.id, registryReference, packageName: artifact.packageName, packageVersion: artifact.packageVersion,
    tarballSha256: artifact.tarballSha256, tarballIntegrity: artifact.tarballIntegrity, artifactStatementDigest: signed.statementDigest,
    artifactSignatureDigest: signed.signatureDigest, signEvidenceDigest: input.signEvidenceDigest, immutable: true }
}
function registryVerifyPhase(request, config, context) {
  const input = object(request.input, 'registry verification input'); const registry = registryConfig(config.registry)
  if (registry.downloadRoot === undefined || request.registry.id !== registry.id || request.registry.locator !== registry.locator) fail('registry verifier is not independently configured')
  text(input.publishEvidenceDigest, 'publish evidence digest', DIGEST)
  const signed = verifySignedArtifact(input, registry, true); const reference = text(input.registryReference, 'registry reference')
  if (request.authorization.releasePolicy.registryReference !== reference) fail('registry verification reference is not owner-authorized')
  let source
  try { source = fileURLToPath(reference) } catch { fail('registry reference is not a local file URL') }
  const canonicalSource = safeRegularFile(source, 'registry object')
  if (!canonicalSource.startsWith(`${join(registry.root, 'packages')}${sep}`)) fail('registry object is outside the configured immutable store')
  const publication = readOwnerJson(registryPublicationPath(registry, signed.artifact.packageName, signed.artifact.packageVersion), 'registry publication')
  const expectedPublication = { schemaVersion: 1, registryId: registry.id, packageName: signed.artifact.packageName,
    packageVersion: signed.artifact.packageVersion, tarballSha256: signed.artifact.tarballSha256, tarballIntegrity: signed.artifact.tarballIntegrity,
    artifactStatementDigest: signed.statementDigest, artifactSignatureDigest: signed.signatureDigest, registryReference: reference }
  if (digest(publication) !== digest(expectedPublication)) fail('registry publication record does not bind the signed artifact')
  const destinationDirectory = ensurePrivateSubdirectory(registry.downloadRoot, [sha256Bytes(request.operationId)], 'registry download directory')
  const destination = join(destinationDirectory, 'package.tgz')
  assertUnexpired(request, 'registry verification download')
  if (!existsSync(destination)) {
    const temporary = join(destinationDirectory, `.package-${process.pid}.tmp`)
    const sourceBytes = readBounded(canonicalSource, 'registry object')
    writeSynced(temporary, sourceBytes, 0o600)
    try { linkSync(temporary, destination); fsyncDirectory(destinationDirectory) } catch (error) { if (error?.code !== 'EEXIST') throw error }
    finally { unlinkSync(temporary); fsyncDirectory(destinationDirectory) }
  }
  const downloaded = readBounded(destination, 'independent registry download')
  if (statSync(canonicalSource).ino === statSync(destination).ino || sha256Bytes(downloaded) !== signed.artifact.tarballSha256
    || downloaded.length !== signed.artifact.tarballBytes || sha512Integrity(downloaded) !== signed.artifact.tarballIntegrity) fail('independent registry download does not match the artifact')
  immutableJson(join(context.directory, 'download.json'), { source: canonicalSource, destination: realpathSync(destination) }, 0o600)
  return { kind: 'registry-verify', registryId: registry.id, registryReference: reference, independentlyDownloaded: true,
    downloadedBytes: downloaded.length, downloadedSha256: sha256Bytes(downloaded), downloadedIntegrity: sha512Integrity(downloaded),
    artifactStatementDigest: signed.statementDigest, artifactSignatureDigest: signed.signatureDigest,
    publishEvidenceDigest: input.publishEvidenceDigest }
}

async function catalogAdmissionPhase(request, config, registryVerificationReceipt, hooks = {}) {
  const input = object(request.input, 'catalog admission input'); const catalog = catalogConfig(config.catalog)
  const { id, path } = catalog
  if (request.catalog.id !== id || request.catalog.path !== path) fail('catalog request targets a different owner catalog')
  const registry = registryConfig(config.registry); const signed = verifySignedArtifact(input, registry, true)
  const expectedBeforeDigest = text(input.expectedBeforeCatalogDigest, 'expected catalog digest', DIGEST)
  const expectedAfterDigest = text(input.expectedAfterCatalogDigest, 'expected after catalog digest', DIGEST)
  if (registryVerificationReceipt === undefined) fail('catalog admission has no verified registry receipt')
  const verificationEvidenceDigest = registryVerificationReceipt.evidenceDigest
  const candidate = object(input.candidate, 'catalog candidate')
  const expectedCandidate = { id: input.artifact.candidateId, package: input.artifact.packageName, version: input.artifact.packageVersion,
    integrity: input.artifact.tarballIntegrity, registry: { id: registry.id, locator: registry.locator,
      reference: input.registryReference }, requires: input.artifact.requires, dshBaseline: input.artifact.dshBaseline,
    capabilities: input.artifact.capabilities, authorities: input.artifact.authorities }
  if (digest(candidate) !== digest(expectedCandidate)) fail('catalog candidate does not match the signed artifact')
  const reference = text(input.registryReference, 'registry reference')
  if (request.authorization.releasePolicy.registryReference !== reference) fail('catalog registry reference is not owner-authorized')
  let registryPath
  try { registryPath = fileURLToPath(reference) } catch { fail('catalog registry reference is not a local file URL') }
  const registryBytes = readBounded(registryPath, 'catalog registry object')
  if (!realpathSync(registryPath).startsWith(`${join(registry.root, 'packages')}${sep}`)
    || sha256Bytes(registryBytes) !== input.artifact.tarballSha256 || sha512Integrity(registryBytes) !== input.artifact.tarballIntegrity) {
    fail('catalog registry reference does not contain the signed artifact')
  }
  assertUnexpired(request, 'catalog admission')
  const helperInput = { catalog: { id, path }, registry: { id: registry.id, locator: registry.locator },
    installationId: request.installationId, operationId: request.operationId, plan: request.plan, release: request.release,
    expectedBeforeCatalogDigest: expectedBeforeDigest, expectedAfterCatalogDigest: expectedAfterDigest, registryReference: reference,
    artifactStatementDigest: signed.statementDigest, artifactSignature: signed.signature, verificationEvidenceDigest, candidate }
  const helperSource = `import { readFileSync } from 'node:fs';
const helper=await import('file:///proc/self/fd/3');const input=JSON.parse(readFileSync(0,'utf8'));
if(typeof helper.admitCatalogCandidate!=='function')throw new Error('catalog admission helper is unavailable');
process.stdout.write(JSON.stringify(await helper.admitCatalogCandidate(input))+'\\n');`
  let result
  const stdout = runPinnedNodeModule(catalog.interpreter, catalog.helper, helperSource, dirname(path), Buffer.from(JSON.stringify(helperInput)), {
    beforeSpawn: hooks.beforeCatalogHelperSpawn, afterSpawn: hooks.afterCatalogHelperSpawn, afterFinally: hooks.afterCatalogHelperFinally,
  })
  result = object(JSON.parse(stdout.toString('utf8')), 'catalog helper result')
  if (result.evidence.afterCatalogDigest !== expectedAfterDigest) fail('catalog admission produced an unauthorized after digest')
  return { ...result.evidence, registryReference: reference, artifactStatementDigest: signed.statementDigest,
    artifactSignatureDigest: signed.signatureDigest, verificationEvidenceDigest, candidate }
}

async function executePhase(request, config, context, authorization, hooks, registryVerificationReceipt) {
  if (request.phase === 'pr') return prPhase(request, config, context, authorization)
  if (request.phase === 'review') return reviewPhase(request, config)
  if (request.phase === 'merge') return mergePhase(request, config, authorization)
  if (request.phase === 'build') return buildPhase(request, config, context, hooks)
  if (request.phase === 'sign') return signPhase(request, config)
  if (request.phase === 'publish') return publishPhase(request, config, hooks)
  if (request.phase === 'registry-verify') return registryVerifyPhase(request, config, context)
  if (request.phase === 'catalog-admission') return catalogAdmissionPhase(request, config, registryVerificationReceipt, hooks)
  fail('unsupported release phase')
}
function signedReceipt(request, config, requestDigest, evidence, outcome = 'passed') {
  const observedAt = request.requestedAt
  if (Date.now() < observedAt || Date.now() > request.authorization.expiresAt) fail('request is outside its authorization interval')
  const expiresAt = Math.min(observedAt + request.receiptTtlMs, request.authorization.expiresAt)
  if (expiresAt <= observedAt) fail('source release authorization expired before receipt issuance')
  const unsigned = { schemaVersion: 1, receiptId: `receipt-${sha256Bytes(request.operationId).slice(0, 32)}`,
    authority: config.authority, keyId: config.keyId, installationId: request.installationId, planId: request.plan.id,
    planDigest: request.plan.digest, releaseId: request.release.id, fence: request.release.fence, operationId: request.operationId,
    requestDigest, phase: request.phase, outcome, evidence, evidenceDigest: digest(evidence), observedAt, expiresAt }
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalReleaseValue(unsigned)), config.privateKey).toString('base64') }
}
function signedReconciliationReceipt(request, config, requestDigest, evidence) {
  const observedAt = request.requestedAt
  if (Date.now() < observedAt || Date.now() > request.authorization.expiresAt) fail('reconciliation request is outside its authorization interval')
  const expiresAt = Math.min(observedAt + request.receiptTtlMs, request.authorization.expiresAt)
  if (expiresAt <= observedAt) fail('source release authorization expired before reconciliation receipt issuance')
  const unsigned = { schemaVersion: 1, kind: 'dsh-source-publish-reconciliation-receipt',
    receiptId: `reconciliation-${sha256Bytes(request.operationId).slice(0, 32)}`, authority: config.authority, keyId: config.keyId,
    installationId: request.installationId, planId: request.plan.id, planDigest: request.plan.digest, releaseId: request.release.id,
    fence: request.release.fence, operationId: request.operationId, requestDigest, evidence, evidenceDigest: digest(evidence),
    observedAt, expiresAt }
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalReleaseValue(unsigned)), config.privateKey).toString('base64') }
}
function validateReconciliationRequest(request, config) {
  const expected = ['schemaVersion', 'kind', 'operationId', 'attempt', 'requestedAt', 'receiptTtlMs', 'installationId', 'ledger', 'plan',
    'release', 'authorization', 'adapter', 'registry', 'ambiguousPublish', 'artifact', 'expectedRegistryReference',
    'expectedArtifactStatementDigest', 'expectedArtifactSignatureDigest']
  exactKeys(object(request, 'reconciliation request'), expected, 'reconciliation request')
  if (request.schemaVersion !== 1 || request.kind !== 'dsh-source-publish-reconciliation-request' || !ID.test(request.operationId)
    || !Number.isSafeInteger(request.attempt) || request.attempt < 1
    || !Number.isSafeInteger(request.requestedAt) || !Number.isSafeInteger(request.receiptTtlMs) || request.receiptTtlMs < 1_000
    || request.receiptTtlMs > 300_000) fail('reconciliation request envelope is invalid')
  const authorization = validateAuthorization(request); const adapter = object(request.adapter, 'adapter identity')
  const ledger = object(request.ledger, 'reconciliation ledger'); exactKeys(ledger, ['id', 'path'], 'reconciliation ledger')
  const plan = object(request.plan, 'reconciliation plan'); exactKeys(plan, ['id', 'digest', 'revision'], 'reconciliation plan')
  const release = object(request.release, 'reconciliation release'); exactKeys(release, ['id', 'fence'], 'reconciliation release')
  const registryInput = object(request.registry, 'reconciliation registry'); exactKeys(registryInput, ['id', 'locator'], 'reconciliation registry')
  exactKeys(adapter, ['id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'adapter identity')
  const interpreter = object(adapter.interpreter, 'adapter interpreter')
  exactKeys(interpreter, ['path', 'sha256'], 'adapter interpreter')
  if (config.phase !== 'registry-verify' || adapter.id !== config.id || adapter.version !== LOCAL_RELEASE_ADAPTER_VERSION
    || adapter.authority !== config.authority || adapter.keyId !== config.keyId || adapter.path !== config.executablePath
    || runningAdapterDigest() !== adapter.sha256 || runningInterpreterDigest() !== interpreter.sha256) {
    fail('reconciliation request is not bound to this verifier')
  }
  const registry = registryConfig(config.registry)
  if (registry.id !== request.registry.id || registry.locator !== request.registry.locator
    || request.expectedRegistryReference !== authorization.releasePolicy.registryReference) fail('reconciliation request targets a different registry')
  const ambiguous = object(request.ambiguousPublish, 'ambiguous publish'); exactKeys(ambiguous, ['operationId', 'receiptId', 'receiptDigest', 'evidenceDigest'], 'ambiguous publish')
  const artifact = object(request.artifact, 'reconciliation artifact'); exactKeys(artifact, ['packageName', 'packageVersion', 'tarballSha256', 'tarballIntegrity'], 'reconciliation artifact')
  for (const value of [ambiguous.receiptDigest, ambiguous.evidenceDigest, artifact.tarballSha256]) text(value, 'reconciliation digest', DIGEST)
  text(request.expectedArtifactStatementDigest, 'expected artifact statement digest', DIGEST)
  text(request.expectedArtifactSignatureDigest, 'expected artifact signature digest', DIGEST)
  text(artifact.packageName, 'reconciliation package', PACKAGE); text(artifact.packageVersion, 'reconciliation version', VERSION)
  text(artifact.tarballIntegrity, 'reconciliation integrity', /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
  if (artifact.packageName !== authorization.releasePolicy.packageName || artifact.packageVersion !== authorization.releasePolicy.packageVersion) {
    fail('reconciliation artifact is not owner-authorized')
  }
  verifyAuthorizationSignature(authorization, config)
  return { authorization, registry }
}
function reconcileRegistry(request, registry) {
  let registryPath
  try { registryPath = fileURLToPath(request.expectedRegistryReference) } catch { fail('expected registry reference is not a local file URL') }
  const expectedPrefix = `${join(registry.root, 'packages')}${sep}`
  const ambiguous = request.ambiguousPublish; const artifact = request.artifact
  let outcome = 'absent'; let registryReference = null; let observedTarballSha256 = null; let observedTarballIntegrity = null
  let observedArtifactStatementDigest = null; let observedArtifactSignatureDigest = null
  const recordPath = registryPublicationPath(registry, artifact.packageName, artifact.packageVersion)
  const objectExists = existsSync(registryPath); const recordExists = existsSync(recordPath)
  const pendingPath = join(registry.root, 'packages', encodeURIComponent(artifact.packageName),
    `.pending-${artifact.packageVersion}-${sha256Bytes(ambiguous.operationId).slice(0, 32)}`)
  if (objectExists !== recordExists || (!objectExists && existsSync(pendingPath))) outcome = 'unknown'
  else try {
    const path = safeRegularFile(registryPath, 'reconciled registry object')
    if (!path.startsWith(expectedPrefix)) fail('reconciled registry object is outside the owner registry')
    const bytes = readBounded(path, 'reconciled registry object'); registryReference = request.expectedRegistryReference
    observedTarballSha256 = sha256Bytes(bytes); observedTarballIntegrity = sha512Integrity(bytes)
    if (recordExists) {
      const publication = readOwnerJson(recordPath, 'reconciled registry publication')
      observedArtifactStatementDigest = typeof publication.artifactStatementDigest === 'string' ? publication.artifactStatementDigest : null
      observedArtifactSignatureDigest = typeof publication.artifactSignatureDigest === 'string' ? publication.artifactSignatureDigest : null
      const recordMatches = publication.schemaVersion === 1 && publication.registryId === registry.id
        && publication.packageName === artifact.packageName && publication.packageVersion === artifact.packageVersion
        && publication.tarballSha256 === artifact.tarballSha256 && publication.tarballIntegrity === artifact.tarballIntegrity
        && publication.registryReference === request.expectedRegistryReference
        && observedArtifactStatementDigest === request.expectedArtifactStatementDigest
        && observedArtifactSignatureDigest === request.expectedArtifactSignatureDigest
      outcome = observedTarballSha256 === artifact.tarballSha256 && observedTarballIntegrity === artifact.tarballIntegrity && recordMatches
        ? 'exists-match' : 'digest-conflict'
    } else outcome = 'absent'
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const detailDigest = digest({ outcome, registryId: registry.id, registryReference, observedTarballSha256, observedTarballIntegrity,
    observedArtifactStatementDigest, observedArtifactSignatureDigest,
    ambiguousPublishOperationId: ambiguous.operationId, ambiguousPublishReceiptDigest: ambiguous.receiptDigest })
  return { kind: 'publish-reconciliation', outcome, registryId: registry.id, registryReference, packageName: artifact.packageName,
    packageVersion: artifact.packageVersion, expectedTarballSha256: artifact.tarballSha256, expectedTarballIntegrity: artifact.tarballIntegrity,
    expectedArtifactStatementDigest: request.expectedArtifactStatementDigest, expectedArtifactSignatureDigest: request.expectedArtifactSignatureDigest,
    observedTarballSha256, observedTarballIntegrity, observedArtifactStatementDigest, observedArtifactSignatureDigest, ambiguousPublishOperationId: ambiguous.operationId,
    ambiguousPublishReceiptDigest: ambiguous.receiptDigest, detailDigest }
}
function persistReviewReceipt(receipt, config) {
  if (receipt.phase !== 'review') return
  const gitValue = gitConfig(config.git)
  if (gitValue.reviewStore === undefined) fail('review store is not configured')
  const path = join(gitValue.reviewStore, `${receipt.evidence.reviewId}.json`)
  if (existsSync(path)) {
    if (digest(readOwnerJson(path, 'review receipt')) !== digest(receipt)) fail('review id already contains a different receipt')
  } else immutableJson(path, receipt, 0o600)
}

export async function runLocalReleaseAdapter(argv = process.argv.slice(2), environment = process.env, hooks = {}) {
  if (argv.length === 1 && argv[0] === '--version') { process.stdout.write(`${LOCAL_RELEASE_ADAPTER_VERSION}\n`); return }
  if (argv.length === 1 && argv[0] === '--capabilities') {
    process.stdout.write('{"schemaVersion":1,"artifactInput":"inherited-fd-v1"}\n'); return
  }
  if (argv.length !== 1 || !['release', 'reconcile'].includes(argv[0])) fail('usage: dsh-local-release-adapter <--version|release|reconcile>')
  const input = readFileSync(0)
  if (input.length < 2 || input.length > MAX_INPUT_BYTES) fail('release request size is invalid')
  let request
  try { request = JSON.parse(input.toString('utf8')) } catch { fail('release request is not valid JSON') }
  if (argv[0] === 'reconcile') {
    const config = loadConfig(environment, 'registry-verify'); const { registry } = validateReconciliationRequest(request, config)
    const context = reconciliationContext(request, config)
    if (context.cached !== undefined) { process.stdout.write(`${JSON.stringify(context.cached)}\n`); return }
    try {
      const evidence = reconcileRegistry(request, registry); const receipt = signedReconciliationReceipt(request, config, context.requestDigest, evidence)
      immutableJson(context.receiptPath, { requestDigest: context.requestDigest, receipt }, 0o600)
      process.stdout.write(`${JSON.stringify(receipt)}\n`); return
    } finally { context.releaseLock?.() }
  }
  if (!PHASES.has(request?.phase)) fail('release request phase is invalid')
  const config = loadConfig(environment, request.phase)
  const { authorization } = validateRequest(request, config)
  validatePhasePolicy(request, config)
  const registryVerificationReceipt = validateCatalogRegistryVerificationReceipt(request, config)
  const context = operationContext(request, config)
  if (context.cached !== undefined) { process.stdout.write(`${JSON.stringify(context.cached)}\n`); return }
  try {
    if (Date.now() > authorization.expiresAt) fail('source release authorization expired before execution')
    let evidence; let outcome = 'passed'
    try { evidence = await executePhase(request, config, context, authorization, hooks, registryVerificationReceipt) } catch (error) {
      if (!(error instanceof PublishAmbiguity) || request.phase !== 'publish') throw error
      outcome = 'ambiguous'
      evidence = { kind: 'publish-ambiguity', registryId: request.registry.id, packageName: request.input.artifact.packageName,
        packageVersion: request.input.artifact.packageVersion, tarballSha256: request.input.artifact.tarballSha256,
        detailDigest: sha256Bytes(error.message) }
    }
    const receipt = signedReceipt(request, config, context.requestDigest, evidence, outcome)
    persistReviewReceipt(receipt, config)
    immutableJson(context.receiptPath, { requestDigest: context.requestDigest, receipt }, 0o600)
    const cached = readOwnerJson(context.receiptPath, 'operation receipt')
    if (cached.requestDigest !== context.requestDigest || digest(cached.receipt) !== digest(receipt)) fail('operation receipt persistence raced')
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } finally { context.releaseLock?.() }
}
export function runPinnedCommandForTest(executable, args, hooks = {}) {
  return command(executable, args, process.cwd(), {}, undefined, [], hooks).toString('utf8')
}
export function importPinnedHelperForTest(interpreter, helper, hooks = {}) {
  return runPinnedNodeModule(interpreter, helper, `const h=await import('file:///proc/self/fd/3');
if(typeof h.admitCatalogCandidate!=='function')throw new Error('missing helper');process.stdout.write('ok\\n')`, process.cwd(), undefined, hooks).toString('utf8')
}

const invokedDirectly = process.argv[1] !== undefined
  && (/^\/proc\/self\/fd\/\d+$/u.test(process.argv[1]) || realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
if (invokedDirectly) void runLocalReleaseAdapter().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'local release adapter failed'}\n`)
  process.exitCode = 1
})
