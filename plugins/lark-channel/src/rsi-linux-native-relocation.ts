import { createHash } from 'node:crypto'
import { constants, createReadStream, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, symlink,
  type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  hashLinuxRuntimeTree, linuxRuntimeDigest, validateLinuxRuntime, validateLinuxUserNamespaceMapping,
  type LinuxRuntime,
} from '@dsh-enhanced/assistant-isolation'
import type { LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'

/** Receipt-relocation primitive for moving one prepared Linux-native DSH Home
 * from a Docker volume onto a native filesystem without re-preparing it.
 * Source receipts are authenticated before any byte is copied; the copied
 * trees and the rewritten receipts are bound together in a sealed proof whose
 * logical paths survive the later same-filesystem rename(2). */

export interface LinuxRsiNativeRelocationInput {
  sourceHome: string
  physicalHome: string
  logicalHome: string
  profile: string
  signal?: AbortSignal
}

export interface LinuxRsiNativeRelocationElement {
  name: 'runtime' | 'repository-runtime' | 'system' | 'behavior-runtime'
    | 'release-toolchain' | 'release-store' | 'release-cache'
  logicalPath: string
  physicalPath: string
  dev: number
  ino: number
  sha256: string
  entries: number
  bytes: number
}

export interface LinuxRsiNativeRelocationProof {
  schemaVersion: 1
  backend: 'linux-native'
  profile: string
  sourceHome: string
  physicalHome: string
  logicalHome: string
  behaviorRootRelative: string
  elements: LinuxRsiNativeRelocationElement[]
  digests: {
    runtime: string; repository: string; behavior: string; creation: string; release: string
    relocation: string
  }
}

type JsonObject = Record<string, unknown>
type ElementName = LinuxRsiNativeRelocationElement['name']

interface LinuxBehaviorPeer {
  validateLinuxPluginBehaviorRuntime(value: unknown): LinuxPluginBehaviorRuntime
  linuxPluginBehaviorRuntimeDigest(value: LinuxPluginBehaviorRuntime): string
}

interface TreeMeta { path: string; dev: number; ino: number; sha256: string }
interface TreeCopy extends TreeMeta { entries: number; bytes: number }

interface SourceState {
  runtime: LinuxRuntime
  runtimeReceipt: JsonObject
  repository: LinuxRuntime
  repositoryReceipt: JsonObject
  snapshot: JsonObject
  userNamespace: JsonObject
  behavior: LinuxPluginBehaviorRuntime
  behaviorReceipt: JsonObject
  creationReceipt: JsonObject
  releaseReceipt: JsonObject
}

const PEER_SPECIFIER = '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const HEX = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/u
const MAX_ENTRIES = 500_000
const MAX_BYTES = 8 * 1024 ** 3
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024
const CHUNK = 64 * 1024
const ELEMENT_NAMES: readonly ElementName[] = ['runtime', 'repository-runtime', 'system', 'behavior-runtime',
  'release-toolchain', 'release-store', 'release-cache']

function fail(message: string): never { throw new Error(`rsi Linux native relocation: ${message}`) }
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown): string => sha(JSON.stringify(value))
const stamp = (info: Stats): string => JSON.stringify([info.dev, info.ino, info.uid, info.mode, info.size,
  info.mtimeMs, info.ctimeMs])
const canonical = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value)
  && value === resolve(value) && value !== '/' && ![...value].some(character => character.charCodeAt(0) < 32)
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function object(value: unknown, message: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail(message)
  return value as JsonObject
}

function exactKeys(value: JsonObject, keys: readonly string[], message: string): void {
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) fail(message)
}

function stringField(value: JsonObject, key: string, message: string): string {
  const field = value[key]
  if (typeof field !== 'string') fail(message)
  return field
}

function hexField(value: JsonObject, key: string, message: string): string {
  const field = stringField(value, key, message)
  if (!HEX.test(field)) fail(message)
  return field
}

function naturalField(value: JsonObject, key: string, message: string): number {
  const field = value[key]
  if (!natural(field)) fail(message)
  return field
}

function readInt(value: JsonObject, key: string): number {
  const field = value[key]
  if (!natural(field)) fail('invalid recorded identity')
  return field
}

/** Keep AbortError identity while prefixing every other rejection. */
function reject(error: unknown, signal: AbortSignal | undefined, message: string): never {
  if (signal?.aborted || (error as { name?: string }).name === 'AbortError') throw error
  fail(`${message}: ${(error as Error).message}`)
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Canonical owner-private directory, as the stock readers require it. */
async function privateDirectory(path: string, message: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || info.mode & 0o077 || await realpath(path) !== path) fail(message)
}

async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}

async function makePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  await privateDirectory(path, 'relocation destination is not a private directory')
}

/** Every descriptor family records its immutable tree as a nested `root`. */
function readRoot(descriptor: JsonObject): JsonObject {
  const root = object(descriptor.root, 'invalid recorded root')
  exactKeys(root, ['dev', 'ino', 'path', 'sha256'], 'invalid recorded root')
  const path = stringField(root, 'path', 'invalid recorded root')
  if (!canonical(path)) fail('invalid recorded root')
  return root
}

function validateSnapshot(value: unknown): JsonObject {
  const snapshot = object(value, 'invalid system snapshot')
  exactKeys(snapshot, ['bytes', 'entries', 'manifestSha256', 'root', 'schemaVersion'], 'invalid system snapshot')
  if (snapshot.schemaVersion !== 1) fail('invalid system snapshot')
  hexField(snapshot, 'manifestSha256', 'invalid system snapshot')
  naturalField(snapshot, 'bytes', 'invalid system snapshot')
  naturalField(snapshot, 'entries', 'invalid system snapshot')
  readRoot(snapshot)
  return snapshot
}

function validateCgroupRoots(value: unknown, home: string): JsonObject {
  const roots = object(value, 'invalid cgroup roots')
  exactKeys(roots, ['cpu', 'freezer', 'memory', 'mode', 'pids'], 'invalid cgroup roots')
  if (roots.mode !== 'v1') fail('invalid cgroup roots')
  const owner = process.getuid?.()
  const seen = new Set<string>()
  for (const name of ['cpu', 'freezer', 'memory', 'pids'] as const) {
    const path = stringField(roots, name, 'invalid cgroup roots')
    if (!canonical(path) || !path.startsWith('/sys/fs/cgroup/') || within(path, home) || seen.has(path)
      || owner !== undefined && !path.endsWith(`/dsh-native/uid-${owner}`)) fail('invalid cgroup roots')
    seen.add(path)
  }
  return roots
}

function validateUserNamespace(value: unknown): JsonObject {
  try { return object(validateLinuxUserNamespaceMapping(value), 'invalid user namespace') } catch (error) {
    reject(error, undefined, 'invalid user namespace')
  }
}

function validateBehavior(peer: LinuxBehaviorPeer, value: unknown): LinuxPluginBehaviorRuntime {
  try { return peer.validateLinuxPluginBehaviorRuntime(value) } catch (error) {
    reject(error, undefined, 'behavior descriptor differs')
  }
}

function validateRuntime(value: unknown): LinuxRuntime {
  try { return validateLinuxRuntime(value) } catch (error) { reject(error, undefined, 'runtime descriptor differs') }
}

async function hashTree(path: string, signal: AbortSignal | undefined, message: string): Promise<string> {
  try { return await hashLinuxRuntimeTree(path, signal) } catch (error) { reject(error, signal, message) }
}

function behaviorPeer(): LinuxBehaviorPeer {
  const requirePeer = createRequire(import.meta.url)
  try { requirePeer.resolve(PEER_SPECIFIER) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
      || (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      fail(`Linux native relocation requires installed peer ${PEER_SPECIFIER}`)
    }
    throw error
  }
  const peer = requirePeer(PEER_SPECIFIER) as Partial<LinuxBehaviorPeer>
  if (typeof peer.validateLinuxPluginBehaviorRuntime !== 'function'
    || typeof peer.linuxPluginBehaviorRuntimeDigest !== 'function') {
    fail('installed Linux behavior runtime peer is unavailable; update the assistant-verifier peer')
  }
  return peer as LinuxBehaviorPeer
}

const runtimeRelative = (profile: string): string => `rsi-linux-runtimes/${profile}/runtime`
const repositoryRuntimeRelative = (profile: string): string => `rsi-linux-repository-runtimes/${profile}/runtime`
const systemRelative = (profile: string): string => `rsi-linux-repository-runtimes/${profile}/system`
const behaviorRelative = (profile: string): string => `rsi-authorities/${profile}/state/linux-creation-behavior/runtime`
const creationRelative = (profile: string): string => `rsi-linux-creation-builds/${profile}`
const releaseRelative = (profile: string): string => `rsi-release-builds/${profile}`
const releaseTreeRelative = (profile: string, name: 'cache' | 'store' | 'toolchain'): string =>
  `${releaseRelative(profile)}/${name}`
const runtimeFamily = (profile: string): string => `rsi-linux-runtimes/${profile}`
const repositoryFamily = (profile: string): string => `rsi-linux-repository-runtimes/${profile}`
const authorityFamily = (profile: string): string => `rsi-authorities/${profile}`
const behaviorFamily = (profile: string): string => `rsi-authorities/${profile}/state/linux-creation-behavior`

function under(home: string, path: string): string { return join(home, ...path.split('/')) }

function relativeOf(name: ElementName, profile: string): string {
  switch (name) {
    case 'runtime': return runtimeRelative(profile)
    case 'repository-runtime': return repositoryRuntimeRelative(profile)
    case 'system': return systemRelative(profile)
    case 'behavior-runtime': return behaviorRelative(profile)
    case 'release-toolchain': return releaseTreeRelative(profile, 'toolchain')
    case 'release-store': return releaseTreeRelative(profile, 'store')
    case 'release-cache': return releaseTreeRelative(profile, 'cache')
  }
}

function rewrite(value: string, from: string, to: string): string {
  if (value === from) return to
  return value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value
}

/** Rewrite only recorded absolute paths, preserving every key's position. */
function relocate(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return rewrite(value, from, to)
  if (Array.isArray(value)) return value.map(item => relocate(item, from, to))
  if (value !== null && typeof value === 'object') {
    const result: JsonObject = {}
    for (const [key, item] of Object.entries(value as JsonObject)) result[key] = relocate(item, from, to)
    return result
  }
  return value
}

/** Recompute the trailing self-digest without reordering retained fields. */
function seal(receipt: JsonObject): JsonObject {
  const content: JsonObject = {}
  for (const [key, value] of Object.entries(receipt)) if (key !== 'receiptDigest') content[key] = value
  return { ...content, receiptDigest: digest(content) }
}

function verifyReceiptDigest(receipt: JsonObject, message: string): void {
  const content: JsonObject = {}
  for (const [key, value] of Object.entries(receipt)) if (key !== 'receiptDigest') content[key] = value
  if (!HEX.test(stringField(receipt, 'receiptDigest', message)) || digest(content) !== receipt.receiptDigest) {
    fail(message)
  }
}

async function readReceipt(path: string, privateMode: boolean): Promise<JsonObject> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_RECEIPT_BYTES
    || info.uid !== process.getuid?.() || info.mode & 0o022 || privateMode && info.mode & 0o077) {
    fail('unsafe source receipt')
  }
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (stamp(await fd.stat()) !== stamp(info)) fail('source receipt changed')
    const text = await fd.readFile({ encoding: 'utf8' })
    if (stamp(await fd.stat()) !== stamp(info) || stamp(await lstat(path)) !== stamp(info)) {
      fail('source receipt changed')
    }
    return parseObject(text, 'invalid source receipt')
  } finally { await fd.close() }
}

function parseObject(text: string, message: string): JsonObject {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { fail(message) }
  return object(parsed, message)
}

async function inventory(path: string, names: readonly string[], message: string): Promise<void> {
  let entries: string[]
  try { entries = await readdir(path) } catch (error) { reject(error, undefined, message) }
  if (entries.sort().join() !== [...names].sort().join()) fail(message)
}

async function treeMeta(path: string, root: JsonObject, signal: AbortSignal | undefined): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || await realpath(path) !== path) fail('unsafe source tree')
  if (info.dev !== readInt(root, 'dev') || info.ino !== readInt(root, 'ino')) fail('source tree identity differs')
  const recorded = stringField(root, 'sha256', 'invalid recorded root')
  if (!HEX.test(recorded) || await hashTree(path, signal, 'source tree differs') !== recorded) {
    fail('source tree digest differs')
  }
}

/** The release build pins are sealed content digests produced by the Control
 * Plane release adapter, which canonicalises keys and sorts directory entries.
 * Re-deriving them here authenticates the source trees before they are copied
 * and proves the copy carries exactly the pinned bytes after it. */
function canonicalReleaseValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReleaseValue).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReleaseValue(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const RELEASE_PIN_MAX_BYTES = 268_435_456

async function releaseInventory(path: string, signal: AbortSignal | undefined): Promise<string> {
  checkAbort(signal)
  const owner = process.getuid?.()
  const root = await realpath(path)
  if (root !== path) fail('source release tree is not canonical')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022
    || owner !== undefined && info.uid !== owner) fail('unsafe source release tree')
  const entries: JsonObject[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    checkAbort(signal)
    for (const name of (await readdir(directory)).sort()) {
      checkAbort(signal)
      const entryPath = join(directory, name)
      const entryName = prefix === '' ? name : `${prefix}/${name}`
      const entry = await lstat(entryPath)
      if ((!entry.isSymbolicLink() && entry.mode & 0o022)
        || owner !== undefined && entry.uid !== owner) fail('unsafe source release tree entry')
      if (entry.isDirectory()) {
        entries.push({ path: entryName, type: 'directory', mode: entry.mode & 0o777 })
        await visit(entryPath, entryName)
      } else if (entry.isFile()) {
        if (entry.size > RELEASE_PIN_MAX_BYTES) fail('source release tree file is oversized')
        const bytes = await readFile(entryPath)
        entries.push({ path: entryName, type: 'file', mode: entry.mode & 0o777, bytes: bytes.length,
          sha256: sha(bytes) })
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(entryPath)
        if (isAbsolute(target)) fail('source release tree has an absolute symlink')
        const resolved = resolve(dirname(entryPath), target)
        if (resolved !== path && !resolved.startsWith(`${path}/`)) {
          fail('source release tree has an escaping symlink')
        }
        entries.push({ path: entryName, type: 'symlink', target })
      } else fail('source release tree has an unsupported entry')
    }
  }
  await visit(path, '')
  return sha(canonicalReleaseValue(entries))
}

async function pinnedExecutableDigest(path: string, signal: AbortSignal | undefined): Promise<string> {
  checkAbort(signal)
  const owner = process.getuid?.()
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1
    || info.mode & 0o022 || (info.mode & 0o111) === 0 || owner !== undefined && info.uid !== owner && info.uid !== 0
    || await realpath(path) !== path) fail('unsafe source release executable')
  if (info.size > RELEASE_PIN_MAX_BYTES) fail('source release executable is oversized')
  return sha(await readFile(path))
}

function releasePin(value: unknown, message: string): { path: string; sha256: string } {
  const item = object(value, message)
  exactKeys(item, ['path', 'sha256'], message)
  const path = stringField(item, 'path', message)
  if (!canonical(path)) fail(message)
  return { path, sha256: hexField(item, 'sha256', message) }
}

interface ReleasePins {
  sandboxExecutable: { path: string; sha256: string }
  tarExecutable: { path: string; sha256: string }
  nodeExecutable: { path: string; sha256: string }
  pnpmExecutable: { path: string; sha256: string }
  pnpmRoot: { path: string; sha256: string }
  storeRoot: { path: string; sha256: string }
  cacheRoot: { path: string; sha256: string }
}

const RELEASE_PIN_KEYS = ['cacheRoot', 'nodeExecutable', 'pnpmExecutable', 'pnpmRoot', 'sandboxExecutable',
  'storeRoot', 'tarExecutable'] as const

/** Validate the recorded pin layout against one Home without reading its trees. */
function releaseLayout(receipt: JsonObject, home: string, profile: string): ReleasePins {
  const build = object(receipt.releaseBuild, 'source release receipt differs')
  exactKeys(build, RELEASE_PIN_KEYS, 'source release receipt differs')
  const pins: ReleasePins = {
    sandboxExecutable: releasePin(build.sandboxExecutable, 'source release receipt differs'),
    tarExecutable: releasePin(build.tarExecutable, 'source release receipt differs'),
    nodeExecutable: releasePin(build.nodeExecutable, 'source release receipt differs'),
    pnpmExecutable: releasePin(build.pnpmExecutable, 'source release receipt differs'),
    pnpmRoot: releasePin(build.pnpmRoot, 'source release receipt differs'),
    storeRoot: releasePin(build.storeRoot, 'source release receipt differs'),
    cacheRoot: releasePin(build.cacheRoot, 'source release receipt differs'),
  }
  if (pins.sandboxExecutable.path !== '/usr/bin/bwrap' || pins.tarExecutable.path !== '/usr/bin/tar'
    || pins.pnpmRoot.path !== under(home, releaseTreeRelative(profile, 'toolchain'))
    || pins.storeRoot.path !== under(home, releaseTreeRelative(profile, 'store'))
    || pins.cacheRoot.path !== under(home, releaseTreeRelative(profile, 'cache'))
    || pins.nodeExecutable.path !== join(pins.pnpmRoot.path, 'node')
    || pins.pnpmExecutable.path !== join(pins.pnpmRoot.path, 'pnpm')) {
    fail('source release receipt differs')
  }
  return pins
}

/** Re-derive every pin from the trees that are about to be copied. */
async function releasePins(pins: ReleasePins, signal: AbortSignal | undefined): Promise<void> {
  for (const [label, item, kind] of [
    ['sandbox', pins.sandboxExecutable, 'executable'],
    ['tar', pins.tarExecutable, 'executable'],
    ['node', pins.nodeExecutable, 'executable'],
    ['pnpm', pins.pnpmExecutable, 'executable'],
    ['pnpm root', pins.pnpmRoot, 'tree'],
    ['pnpm store', pins.storeRoot, 'tree'],
    ['pnpm cache', pins.cacheRoot, 'tree'],
  ] as const) {
    const computed = kind === 'executable'
      ? await pinnedExecutableDigest(item.path, signal)
      : await releaseInventory(item.path, signal)
    if (computed !== item.sha256) fail(`source release ${label} differs`)
  }
  // The stock release readers re-check these two semantics after the cutover.
  const manifest = JSON.parse(await readFile(join(pins.pnpmRoot.path, 'package.json'), 'utf8')) as JsonObject
  const version = stringField(manifest, 'version', 'source release pnpm manifest differs')
  if (!SEMVER.test(version)) fail('source release pnpm manifest differs')
  const storeVersion = Number.parseInt(version, 10)
  const projects = join(pins.storeRoot.path, `v${storeVersion}`, 'projects')
  const projectsInfo = await lstat(projects).catch(() => undefined)
  if (projectsInfo === undefined || !projectsInfo.isDirectory() || projectsInfo.isSymbolicLink()) {
    fail('source release pnpm store registry differs')
  }
}

async function authenticateSource(home: string, profile: string, peer: LinuxBehaviorPeer,
  signal: AbortSignal | undefined): Promise<SourceState> {
  const runtimePath = under(home, runtimeRelative(profile))
  const repositoryPath = under(home, repositoryRuntimeRelative(profile))
  const systemPath = under(home, systemRelative(profile))
  const behaviorPath = under(home, behaviorRelative(profile))
  const creationPath = under(home, creationRelative(profile))

  await inventory(under(home, runtimeFamily(profile)), ['bootstrap.json', 'runtime'], 'source runtime family differs')
  await inventory(under(home, repositoryFamily(profile)), ['bootstrap.json', 'runtime', 'system'],
    'source repository family differs')
  await inventory(under(home, behaviorFamily(profile)), ['behavior.json', 'runtime'], 'source behavior family differs')
  await inventory(creationPath, ['bootstrap.json'], 'source creation family differs')

  // The schema-3 bootstrap receipt binds the immutable Node/pnpm toolchain.
  const runtimeReceipt = await readReceipt(join(under(home, runtimeFamily(profile)), 'bootstrap.json'), true)
  exactKeys(runtimeReceipt, ['archives', 'backend', 'dshHome', 'lockSha256', 'manifestHashes', 'profile',
    'receiptDigest', 'runtime', 'schemaVersion', 'sourceCommit'], 'source runtime receipt differs')
  verifyReceiptDigest(runtimeReceipt, 'source runtime receipt digest differs')
  if (runtimeReceipt.schemaVersion !== 3 || runtimeReceipt.backend !== 'linux-native'
    || runtimeReceipt.dshHome !== home || runtimeReceipt.profile !== profile) fail('source runtime receipt differs')
  const sourceCommit = stringField(runtimeReceipt, 'sourceCommit', 'source runtime receipt differs')
  if (!COMMIT.test(sourceCommit)) fail('source runtime receipt differs')
  const lockSha256 = hexField(runtimeReceipt, 'lockSha256', 'source runtime receipt differs')
  const runtime = validateRuntime(runtimeReceipt.runtime)
  if (runtime.root.path !== runtimePath || runtime.sourceCommit !== sourceCommit || runtime.lockSha256 !== lockSha256) {
    fail('source runtime receipt differs')
  }
  const manifests = object(runtimeReceipt.manifestHashes, 'source runtime receipt differs')
  if (Object.keys(manifests).length === 0
    || Object.values(manifests).some(value => typeof value !== 'string' || !HEX.test(value))) {
    fail('source runtime receipt differs')
  }
  const archives = object(runtimeReceipt.archives, 'source runtime receipt differs')
  exactKeys(archives, ['node', 'pnpm', 'pnpmExe', 'pnpmNative'], 'source runtime receipt differs')
  for (const key of ['node', 'pnpm', 'pnpmExe', 'pnpmNative']) hexField(archives, key, 'source runtime receipt differs')
  await treeMeta(runtimePath, readRoot(runtime as unknown as JsonObject), signal)

  // The schema-4 repository receipt binds the base runtime, system snapshot and
  // user namespace; only its path-bearing parts are relocated.
  const repositoryReceipt = await readReceipt(join(under(home, repositoryFamily(profile)), 'bootstrap.json'), true)
  exactKeys(repositoryReceipt, ['backend', 'baseRuntimeDigest', 'dshHome', 'lockSha256', 'nodeArchiveDigest',
    'npmVersion', 'ownerGid', 'ownerUid', 'profile', 'receiptDigest', 'runtime', 'runtimeDigest', 'schemaVersion',
    'sourceCommit', 'sourceDigest', 'systemSnapshot', 'systemSnapshotDigest', 'userNamespace',
    'userNamespaceDigest'], 'source repository receipt differs')
  verifyReceiptDigest(repositoryReceipt, 'source repository receipt digest differs')
  const repository = validateRuntime(repositoryReceipt.runtime)
  const snapshot = validateSnapshot(repositoryReceipt.systemSnapshot)
  const userNamespace = validateUserNamespace(repositoryReceipt.userNamespace)
  const uid = process.getuid?.(), gid = process.getgid?.()
  const sourceDigest = hexField(repositoryReceipt, 'sourceDigest', 'source repository receipt differs')
  const nodeArchiveDigest = hexField(repositoryReceipt, 'nodeArchiveDigest', 'source repository receipt differs')
  const npmVersion = stringField(repositoryReceipt, 'npmVersion', 'source repository receipt differs')
  if (repositoryReceipt.schemaVersion !== 4 || repositoryReceipt.backend !== 'linux-native'
    || repositoryReceipt.dshHome !== home || repositoryReceipt.profile !== profile
    || repositoryReceipt.ownerUid !== uid || repositoryReceipt.ownerGid !== gid
    || repositoryReceipt.sourceCommit !== sourceCommit || repositoryReceipt.lockSha256 !== lockSha256
    || !SEMVER.test(npmVersion) || !HEX.test(sourceDigest) || !HEX.test(nodeArchiveDigest)
    || repositoryReceipt.baseRuntimeDigest !== digest(runtimeReceipt.runtime)
    || repositoryReceipt.runtimeDigest !== digest(repositoryReceipt.runtime)
    || repositoryReceipt.systemSnapshotDigest !== digest(repositoryReceipt.systemSnapshot)
    || repositoryReceipt.userNamespaceDigest !== digest(repositoryReceipt.userNamespace)
    || repository.root.path !== repositoryPath || repository.sourceCommit !== sourceCommit
    || repository.lockSha256 !== lockSha256
    || readRoot(snapshot).path !== systemPath) fail('source repository receipt differs')
  await treeMeta(repositoryPath, readRoot(repository as unknown as JsonObject), signal)
  await treeMeta(systemPath, readRoot(snapshot), signal)

  // The behavior deployment receipt is the immutable authority for the plugin
  // observer; its digest is also the creation receipt's preparation digest.
  const behaviorReceipt = await readReceipt(join(under(home, behaviorFamily(profile)), 'behavior.json'), false)
  exactKeys(behaviorReceipt, ['baseRuntimeDigest', 'compilerSha256', 'descriptor', 'receiptDigest', 'schemaVersion'],
    'source behavior receipt differs')
  verifyReceiptDigest(behaviorReceipt, 'source behavior receipt digest differs')
  if (behaviorReceipt.schemaVersion !== 1
    || behaviorReceipt.baseRuntimeDigest !== linuxRuntimeDigest(repository)
    || !HEX.test(stringField(behaviorReceipt, 'compilerSha256', 'source behavior receipt differs'))) {
    fail('source behavior receipt differs')
  }
  const behavior = validateBehavior(peer, behaviorReceipt.descriptor)
  if (behavior.runtime.root.path !== behaviorPath) fail('source behavior receipt differs')
  await treeMeta(behaviorPath, readRoot(behavior.runtime as unknown as JsonObject), signal)

  // The creation receipt aggregates the other three and carries cgroup roots
  // that must already live outside the source Home.
  const creationReceipt = await readReceipt(join(creationPath, 'bootstrap.json'), true)
  exactKeys(creationReceipt, ['backend', 'behavior', 'behaviorDigest', 'buildRuntimeDigest', 'cgroupRoots',
    'dshHome', 'lockSha256', 'preparationDigest', 'profile', 'repositoryRuntimeDigest', 'schemaVersion',
    'sourceCommit', 'systemSnapshotDigest', 'userNamespaceDigest', 'receiptDigest'],
  'source creation receipt differs')
  verifyReceiptDigest(creationReceipt, 'source creation receipt digest differs')
  validateCgroupRoots(creationReceipt.cgroupRoots, home)
  const repositoryRuntimeDigest = linuxRuntimeDigest(repository)
  if (creationReceipt.schemaVersion !== 3 || creationReceipt.backend !== 'linux-native'
    || creationReceipt.dshHome !== home || creationReceipt.profile !== profile
    || creationReceipt.sourceCommit !== sourceCommit || creationReceipt.lockSha256 !== lockSha256
    || creationReceipt.buildRuntimeDigest !== repositoryRuntimeDigest
    || creationReceipt.repositoryRuntimeDigest !== repositoryRuntimeDigest
    || creationReceipt.preparationDigest !== behaviorReceipt.receiptDigest
    || creationReceipt.behaviorDigest !== peer.linuxPluginBehaviorRuntimeDigest(behavior)
    || creationReceipt.systemSnapshotDigest !== digest(repositoryReceipt.systemSnapshot)
    || creationReceipt.userNamespaceDigest !== digest(repositoryReceipt.userNamespace)
    || !isDeepStrictEqual(creationReceipt.behavior, behaviorReceipt.descriptor)) {
    fail('source creation receipt differs')
  }

  // The release build pins the fixed toolchain/store/cache trees that the
  // native runner executes with; its receipt must describe this exact Home and
  // the base runtime this Home was prepared from.
  await inventory(under(home, releaseRelative(profile)), ['bootstrap.json', 'cache', 'store', 'toolchain'],
    'source release family differs')
  const releaseReceipt = await readReceipt(join(under(home, releaseRelative(profile)), 'bootstrap.json'), true)
  exactKeys(releaseReceipt, ['backend', 'dshHome', 'profile', 'receiptDigest', 'releaseBuild', 'runtimeDigest',
    'schemaVersion', 'sourceCommit'], 'source release receipt differs')
  verifyReceiptDigest(releaseReceipt, 'source release receipt digest differs')
  const baseRuntimeDigest = linuxRuntimeDigest(runtime)
  if (releaseReceipt.schemaVersion !== 2 || releaseReceipt.backend !== 'linux-native'
    || releaseReceipt.dshHome !== home || releaseReceipt.profile !== profile
    || releaseReceipt.sourceCommit !== sourceCommit || releaseReceipt.runtimeDigest !== baseRuntimeDigest) {
    fail('source release receipt differs')
  }
  const release = releaseLayout(releaseReceipt, home, profile)
  await releasePins(release, signal)

  return {
    runtime, runtimeReceipt, repository, repositoryReceipt, snapshot, userNamespace,
    behavior, behaviorReceipt, creationReceipt, releaseReceipt,
  }
}

interface CopyBudget { entries: number; bytes: number }

function checkAbort(signal: AbortSignal | undefined): void { signal?.throwIfAborted() }

async function writeAll(fd: FileHandle, buffer: Buffer, signal: AbortSignal | undefined): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    checkAbort(signal)
    const written = await fd.write(buffer, offset, buffer.length - offset)
    if (written.bytesWritten <= 0) fail('copy write stalled')
    offset += written.bytesWritten
  }
}

async function copyFile(source: string, destination: string, before: Stats, budget: CopyBudget,
  signal: AbortSignal | undefined): Promise<void> {
  budget.entries += 1
  budget.bytes += before.size
  if (budget.entries > MAX_ENTRIES) fail('source tree entry bound exceeded')
  if (budget.bytes > MAX_BYTES) fail('source tree byte bound exceeded')
  if (before.nlink !== 1 || before.mode & 0o022) fail('unsafe source tree file')
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output: FileHandle | undefined
  try {
    if (stamp(await input.stat()) !== stamp(before)) fail('source tree changed during copy')
    output = await open(destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let copied = 0
    const stream = createReadStream(source, signal
      ? { fd: input.fd, autoClose: false, highWaterMark: CHUNK, signal }
      : { fd: input.fd, autoClose: false, highWaterMark: CHUNK })
    for await (const chunk of stream) {
      checkAbort(signal)
      const buffer = chunk as Buffer
      copied += buffer.length
      if (copied > before.size) fail('source tree file grew during copy')
      await writeAll(output, buffer, signal)
    }
    if (copied !== before.size) fail('source tree file changed during copy')
    await output.sync()
    await output.chmod(before.mode & 0o777)
    if (stamp(await input.stat()) !== stamp(before) || stamp(await lstat(source)) !== stamp(before)) {
      fail('source tree changed during copy')
    }
  } finally {
    await output?.close()
    await input.close()
  }
}

async function copyDirectory(source: string, destination: string, before: Stats, root: string,
  budget: CopyBudget, signal: AbortSignal | undefined): Promise<void> {
  budget.entries += 1
  if (budget.entries > MAX_ENTRIES) fail('source tree entry bound exceeded')
  if (before.mode & 0o022) fail('unsafe source tree directory')
  await mkdir(destination, { mode: 0o700 })
  const names = (await readdir(source)).sort()
  for (const name of names) {
    checkAbort(signal)
    await copyEntry(join(source, name), join(destination, name), root, budget, signal)
  }
  await chmod(destination, before.mode & 0o777)
  await syncDirectory(destination)
  if (stamp(await lstat(source)) !== stamp(before)) fail('source tree changed during copy')
}

async function copyLink(source: string, destination: string, root: string, budget: CopyBudget): Promise<void> {
  budget.entries += 1
  if (budget.entries > MAX_ENTRIES) fail('source tree entry bound exceeded')
  const target = await readlink(source)
  if (isAbsolute(target) || !within(resolve(dirname(source), target), root)
    || !within(await realpath(source), root)) fail('source tree link escaped root')
  await symlink(target, destination)
}

async function copyEntry(source: string, destination: string, root: string, budget: CopyBudget,
  signal: AbortSignal | undefined): Promise<void> {
  checkAbort(signal)
  const before = await lstat(source)
  if (before.uid !== process.getuid?.()) fail('foreign-owned source tree entry')
  if (before.isSymbolicLink()) {
    await copyLink(source, destination, root, budget)
  } else if (before.isDirectory()) {
    await copyDirectory(source, destination, before, root, budget, signal)
  } else if (before.isFile()) {
    await copyFile(source, destination, before, budget, signal)
  } else fail('unsupported source tree entry')
}

async function copyTree(source: string, destination: string, signal: AbortSignal | undefined,
  expectedSha256?: string): Promise<TreeCopy> {
  const root = await lstat(source)
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.()
    || await realpath(source) !== source) fail('unsafe source tree')
  const budget: CopyBudget = { entries: 0, bytes: 0 }
  await copyDirectory(source, destination, root, source, budget, signal)
  const copied = await lstat(destination)
  const copiedSha256 = await hashTree(destination, signal, 'copied tree differs')
  if (expectedSha256 !== undefined && copiedSha256 !== expectedSha256) fail('copied tree digest differs')
  return { path: destination, dev: copied.dev, ino: copied.ino, sha256: copiedSha256, ...budget }
}

/** Re-seal the release receipt against the copied trees: pins only move, the
 * runtime digest now binds the relocated base runtime. */
function relocatedReleaseReceipt(source: JsonObject, sourceHome: string, logicalHome: string,
  baseDigest: string): JsonObject {
  const receipt = object(relocate(source, sourceHome, logicalHome), 'invalid relocated release receipt')
  const build = object(receipt.releaseBuild, 'invalid relocated release receipt')
  exactKeys(build, RELEASE_PIN_KEYS, 'invalid relocated release receipt')
  for (const key of RELEASE_PIN_KEYS) {
    const pin = releasePin(build[key], 'invalid relocated release receipt')
    build[key] = pin
  }
  receipt.runtimeDigest = baseDigest
  receipt.dshHome = logicalHome
  return seal(receipt)
}

function setRoot(root: JsonObject, meta: TreeMeta): void {
  root.dev = meta.dev
  root.ino = meta.ino
  root.sha256 = meta.sha256
}

function rewriteRuntime(receipt: JsonObject, meta: TreeMeta, path: string): void {
  const runtime = object(receipt.runtime, 'relocated runtime differs')
  const root = readRoot(runtime)
  root.path = path
  setRoot(root, meta)
  validateRuntime(runtime)
}

async function writeReceipt(path: string, receipt: JsonObject): Promise<void> {
  const fds = Buffer.from(JSON.stringify(receipt))
  const fd = await open(path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await fd.writeFile(fds)
    await fd.chmod(0o600)
    await fd.sync()
  } finally { await fd.close() }
  await syncDirectory(dirname(path))
}

function relocatedRuntimeReceipt(source: JsonObject, sourceHome: string, logicalHome: string,
  meta: TreeMeta, runtimePath: string): JsonObject {
  const receipt = object(relocate(source, sourceHome, logicalHome), 'invalid relocated runtime receipt')
  rewriteRuntime(receipt, meta, runtimePath)
  return seal(receipt)
}

function relocatedRepositoryReceipt(source: JsonObject, sourceHome: string, logicalHome: string,
  runtimeMeta: TreeMeta, systemMeta: TreeMeta, runtimePath: string, systemPath: string,
  base: JsonObject): JsonObject {
  const receipt = object(relocate(source, sourceHome, logicalHome), 'invalid relocated repository receipt')
  rewriteRuntime(receipt, runtimeMeta, runtimePath)
  const snapshot = validateSnapshot(receipt.systemSnapshot)
  const root = readRoot(snapshot)
  root.path = systemPath
  setRoot(root, systemMeta)
  const repositoryRuntime = object(receipt.runtime, 'invalid relocated repository runtime')
  validateRuntime(repositoryRuntime)
  receipt.baseRuntimeDigest = digest(base)
  receipt.runtimeDigest = digest(repositoryRuntime)
  receipt.systemSnapshotDigest = digest(receipt.systemSnapshot)
  receipt.userNamespaceDigest = digest(receipt.userNamespace)
  return seal(receipt)
}

function relocatedBehaviorReceipt(source: JsonObject, sourceHome: string, logicalHome: string,
  meta: TreeMeta, runtimePath: string, baseDigest: string, peer: LinuxBehaviorPeer): JsonObject {
  const receipt = object(relocate(source, sourceHome, logicalHome), 'invalid relocated behavior receipt')
  const descriptor = object(receipt.descriptor, 'invalid relocated behavior descriptor')
  rewriteRuntime(descriptor, meta, runtimePath)
  validateBehavior(peer, descriptor)
  receipt.baseRuntimeDigest = baseDigest
  return seal(receipt)
}

function relocatedCreationReceipt(source: JsonObject, sourceHome: string, logicalHome: string,
  behavior: JsonObject, values: { repositoryRuntimeDigest: string; preparationDigest: string
    behaviorDigest: string; systemSnapshotDigest: string; userNamespaceDigest: string }): JsonObject {
  const receipt = object(relocate(source, sourceHome, logicalHome), 'invalid relocated creation receipt')
  // Embed the relocated behavior descriptor so the recorded identity and the digest agree.
  receipt.behavior = behavior
  receipt.buildRuntimeDigest = values.repositoryRuntimeDigest
  receipt.repositoryRuntimeDigest = values.repositoryRuntimeDigest
  receipt.preparationDigest = values.preparationDigest
  receipt.behaviorDigest = values.behaviorDigest
  receipt.systemSnapshotDigest = values.systemSnapshotDigest
  receipt.userNamespaceDigest = values.userNamespaceDigest
  return seal(receipt)
}

function pureIdentity(input: LinuxRsiNativeRelocationInput): void {
  const { sourceHome, physicalHome, logicalHome } = input
  for (const [name, value] of [['sourceHome', sourceHome], ['physicalHome', physicalHome],
    ['logicalHome', logicalHome]] as const) {
    if (!canonical(value)) fail(`invalid ${name}`)
  }
  if (!PROFILE.test(input.profile)) fail('invalid profile')
  if (physicalHome === sourceHome || physicalHome === logicalHome || logicalHome === sourceHome) {
    fail('relocation homes overlap')
  }
  if (within(physicalHome, sourceHome) || within(sourceHome, physicalHome)
    || within(logicalHome, sourceHome) || within(sourceHome, logicalHome)
    || within(physicalHome, logicalHome) || within(logicalHome, physicalHome)) fail('relocation homes overlap')
}

async function assertTargetsAbsent(physicalHome: string, profile: string): Promise<void> {
  for (const path of [runtimeFamily(profile), repositoryFamily(profile), authorityFamily(profile),
    creationRelative(profile), releaseRelative(profile)]) {
    if (await exists(under(physicalHome, path))) fail('relocation target already exists')
  }
}

function relocationContent(proof: LinuxRsiNativeRelocationProof): JsonObject {
  return {
    schemaVersion: proof.schemaVersion,
    backend: proof.backend,
    profile: proof.profile,
    sourceHome: proof.sourceHome,
    physicalHome: proof.physicalHome,
    logicalHome: proof.logicalHome,
    behaviorRootRelative: proof.behaviorRootRelative,
    elements: proof.elements.map(item => ({
      name: item.name, logicalPath: item.logicalPath, physicalPath: item.physicalPath, dev: item.dev,
      ino: item.ino, sha256: item.sha256, entries: item.entries, bytes: item.bytes,
    })),
    digests: {
      runtime: proof.digests.runtime,
      repository: proof.digests.repository,
      behavior: proof.digests.behavior,
      creation: proof.digests.creation,
      release: proof.digests.release,
    },
  }
}

function relocationDigest(proof: LinuxRsiNativeRelocationProof): string {
  return digest(relocationContent(proof))
}

/** Relocate one prepared Linux-native DSH Home onto a fresh physical Home.
 * The source is authenticated before copying and never modified. */
export async function relocateLinuxRsiNativeFamily(
  input: LinuxRsiNativeRelocationInput): Promise<LinuxRsiNativeRelocationProof> {
  pureIdentity(input)
  const { sourceHome, physicalHome, logicalHome, profile, signal } = input
  if (process.platform !== 'linux') fail('Linux native relocation requires Linux')
  signal?.throwIfAborted()
  await privateDirectory(sourceHome, 'unsafe source Home')
  if (await exists(logicalHome)) fail('logical Home already exists')
  if (await exists(physicalHome)) await privateDirectory(physicalHome, 'unsafe physical Home')
  else await makePrivateDirectory(physicalHome)
  await assertTargetsAbsent(physicalHome, profile)
  const peer = behaviorPeer()

  const source = await authenticateSource(sourceHome, profile, peer, signal)
  checkAbort(signal)

  const runtimePath = under(physicalHome, runtimeRelative(profile))
  const repositoryPath = under(physicalHome, repositoryRuntimeRelative(profile))
  const systemPath = under(physicalHome, systemRelative(profile))
  const behaviorPath = under(physicalHome, behaviorRelative(profile))
  const logicalRuntimePath = under(logicalHome, runtimeRelative(profile))
  const logicalRepositoryPath = under(logicalHome, repositoryRuntimeRelative(profile))
  const logicalSystemPath = under(logicalHome, systemRelative(profile))
  const logicalBehaviorPath = under(logicalHome, behaviorRelative(profile))
  const releaseFamilyPath = under(physicalHome, releaseRelative(profile))
  const releasePaths = {
    toolchain: under(physicalHome, releaseTreeRelative(profile, 'toolchain')),
    store: under(physicalHome, releaseTreeRelative(profile, 'store')),
    cache: under(physicalHome, releaseTreeRelative(profile, 'cache')),
  }
  const logicalReleasePaths = {
    toolchain: under(logicalHome, releaseTreeRelative(profile, 'toolchain')),
    store: under(logicalHome, releaseTreeRelative(profile, 'store')),
    cache: under(logicalHome, releaseTreeRelative(profile, 'cache')),
  }

  await makePrivateDirectory(under(physicalHome, runtimeFamily(profile)))
  await makePrivateDirectory(under(physicalHome, repositoryFamily(profile)))
  await makePrivateDirectory(under(physicalHome, behaviorFamily(profile)))
  await makePrivateDirectory(under(physicalHome, creationRelative(profile)))
  await makePrivateDirectory(releaseFamilyPath)

  const runtimeCopy = await copyTree(source.runtime.root.path, runtimePath, signal,
    source.runtime.root.sha256)
  checkAbort(signal)
  const repositoryCopy = await copyTree(source.repository.root.path, repositoryPath, signal,
    source.repository.root.sha256)
  checkAbort(signal)
  const systemRoot = readRoot(source.snapshot)
  const systemCopy = await copyTree(systemRoot.path as string, systemPath, signal,
    stringField(systemRoot, 'sha256', 'invalid recorded root'))
  checkAbort(signal)
  const behaviorCopy = await copyTree(source.behavior.runtime.root.path, behaviorPath, signal,
    source.behavior.runtime.root.sha256)
  checkAbort(signal)

  // The release trees are sealed by the Control Plane's canonical inventory
  // digest, not by the runtime tree digest: copy them and immediately prove the
  // copy against the authenticated pins.
  const sourcePin = releaseLayout(source.releaseReceipt, sourceHome, profile)
  const releaseCopies = {
    toolchain: await copyTree(sourcePin.pnpmRoot.path, releasePaths.toolchain, signal),
    store: await copyTree(sourcePin.storeRoot.path, releasePaths.store, signal),
    cache: await copyTree(sourcePin.cacheRoot.path, releasePaths.cache, signal),
  }
  checkAbort(signal)
  for (const [label, copy, pin] of [
    ['toolchain', releaseCopies.toolchain, sourcePin.pnpmRoot],
    ['store', releaseCopies.store, sourcePin.storeRoot],
    ['cache', releaseCopies.cache, sourcePin.cacheRoot],
  ] as const) {
    if (await releaseInventory(copy.path, signal) !== pin.sha256) {
      fail(`copied release ${label} differs`)
    }
  }
  for (const [label, copy, pin] of [
    ['node', join(releaseCopies.toolchain.path, 'node'), sourcePin.nodeExecutable],
    ['pnpm', join(releaseCopies.toolchain.path, 'pnpm'), sourcePin.pnpmExecutable],
  ] as const) {
    if (await pinnedExecutableDigest(copy, signal) !== pin.sha256) fail(`copied release ${label} differs`)
  }
  checkAbort(signal)

  const runtimeReceipt = relocatedRuntimeReceipt(source.runtimeReceipt, sourceHome, logicalHome,
    runtimeCopy, logicalRuntimePath)
  const repositoryReceipt = relocatedRepositoryReceipt(source.repositoryReceipt, sourceHome, logicalHome,
    repositoryCopy, systemCopy, logicalRepositoryPath, logicalSystemPath,
    object(runtimeReceipt.runtime, 'invalid relocated runtime receipt'))
  // The creation build and the behavior receipt must bind the relocated
  // repository runtime, never the authenticated source one: the copy has a new
  // root path/dev/ino, so only this digest can be re-derived by the readers
  // after the same-filesystem rename cutover.
  const repositoryRuntimeDigest = linuxRuntimeDigest(validateRuntime(
    object(repositoryReceipt.runtime, 'invalid relocated repository runtime')))
  const behaviorReceipt = relocatedBehaviorReceipt(source.behaviorReceipt, sourceHome, logicalHome,
    behaviorCopy, logicalBehaviorPath, repositoryRuntimeDigest, peer)
  const behaviorDigest = peer.linuxPluginBehaviorRuntimeDigest(
    validateBehavior(peer, object(behaviorReceipt.descriptor, 'invalid relocated behavior descriptor')))
  const creationReceipt = relocatedCreationReceipt(source.creationReceipt, sourceHome, logicalHome,
    object(behaviorReceipt.descriptor, 'invalid relocated behavior descriptor'), {
      repositoryRuntimeDigest,
    preparationDigest: stringField(behaviorReceipt, 'receiptDigest', 'invalid relocated behavior receipt'),
    behaviorDigest,
    systemSnapshotDigest: digest(repositoryReceipt.systemSnapshot),
    userNamespaceDigest: digest(repositoryReceipt.userNamespace),
  })

  const elements: LinuxRsiNativeRelocationElement[] = [
    element('runtime', logicalRuntimePath, runtimeCopy),
    element('repository-runtime', logicalRepositoryPath, repositoryCopy),
    element('system', logicalSystemPath, systemCopy),
    element('behavior-runtime', logicalBehaviorPath, behaviorCopy),
    element('release-toolchain', logicalReleasePaths.toolchain, releaseCopies.toolchain),
    element('release-store', logicalReleasePaths.store, releaseCopies.store),
    element('release-cache', logicalReleasePaths.cache, releaseCopies.cache),
  ]
  // The release receipt must bind the relocated base runtime while keeping the
  // logical Home paths the post-cutover stock readers re-derive.
  const releaseReceipt = relocatedReleaseReceipt(source.releaseReceipt, sourceHome, logicalHome,
    linuxRuntimeDigest(validateRuntime(object(runtimeReceipt.runtime, 'invalid relocated runtime receipt'))))
  if (releaseLayout(releaseReceipt, logicalHome, profile).pnpmRoot.path !== logicalReleasePaths.toolchain) {
    fail('relocated release receipt differs')
  }
  const digests = {
    runtime: stringField(runtimeReceipt, 'receiptDigest', 'invalid relocated runtime receipt'),
    repository: stringField(repositoryReceipt, 'receiptDigest', 'invalid relocated repository receipt'),
    behavior: stringField(behaviorReceipt, 'receiptDigest', 'invalid relocated behavior receipt'),
    creation: stringField(creationReceipt, 'receiptDigest', 'invalid relocated creation receipt'),
    release: stringField(releaseReceipt, 'receiptDigest', 'invalid relocated release receipt'),
  }

  await writeReceipt(join(under(physicalHome, runtimeFamily(profile)), 'bootstrap.json'), runtimeReceipt)
  await writeReceipt(join(under(physicalHome, repositoryFamily(profile)), 'bootstrap.json'), repositoryReceipt)
  await writeReceipt(join(under(physicalHome, behaviorFamily(profile)), 'behavior.json'), behaviorReceipt)
  await writeReceipt(join(physicalHome, creationRelative(profile), 'bootstrap.json'), creationReceipt)
  await writeReceipt(join(releaseFamilyPath, 'bootstrap.json'), releaseReceipt)

  const proof: LinuxRsiNativeRelocationProof = {
    schemaVersion: 1,
    backend: 'linux-native',
    profile,
    sourceHome,
    physicalHome,
    logicalHome,
    behaviorRootRelative: behaviorRelative(profile),
    elements,
    digests: { ...digests, relocation: '' },
  }
  proof.digests.relocation = relocationDigest(proof)
  return proof
}

function element(name: ElementName, logicalPath: string, copy: TreeCopy): LinuxRsiNativeRelocationElement {
  return {
    name, logicalPath, physicalPath: copy.path, dev: copy.dev, ino: copy.ino, sha256: copy.sha256,
    entries: copy.entries, bytes: copy.bytes,
  }
}

interface ElementMeta {
  logicalPath: string
  physicalPath: string
  dev: number
  ino: number
  sha256: string
  entries: number
  bytes: number
}

function proofShape(proof: LinuxRsiNativeRelocationProof): {
  record: JsonObject; elements: Map<ElementName, ElementMeta>; digests: JsonObject } {
  const record = object(proof, 'invalid relocation proof')
  exactKeys(record, ['backend', 'behaviorRootRelative', 'digests', 'elements', 'logicalHome', 'physicalHome',
    'profile', 'schemaVersion', 'sourceHome'], 'invalid relocation proof')
  if (record.schemaVersion !== 1 || record.backend !== 'linux-native') fail('invalid relocation proof')
  const profile = stringField(record, 'profile', 'invalid relocation proof')
  if (!PROFILE.test(profile)) fail('invalid relocation proof')
  const sourceHome = stringField(record, 'sourceHome', 'invalid relocation proof')
  const physicalHome = stringField(record, 'physicalHome', 'invalid relocation proof')
  const logicalHome = stringField(record, 'logicalHome', 'invalid relocation proof')
  for (const [name, value] of [['sourceHome', sourceHome], ['physicalHome', physicalHome],
    ['logicalHome', logicalHome]] as const) if (!canonical(value)) fail(`invalid relocation proof ${name}`)
  if (sourceHome === physicalHome || sourceHome === logicalHome || physicalHome === logicalHome
    || within(sourceHome, physicalHome) || within(physicalHome, sourceHome)
    || within(sourceHome, logicalHome) || within(logicalHome, sourceHome)
    || within(physicalHome, logicalHome) || within(logicalHome, physicalHome)) {
    fail('invalid relocation proof homes')
  }
  if (stringField(record, 'behaviorRootRelative', 'invalid relocation proof') !== behaviorRelative(profile)) {
    fail('invalid relocation proof behavior root')
  }

  const listed = record.elements
  if (!Array.isArray(listed) || listed.length !== ELEMENT_NAMES.length) fail('invalid relocation proof elements')
  const elements = new Map<ElementName, ElementMeta>()
  for (const item of listed) {
    const value = object(item, 'invalid relocation proof element')
    exactKeys(value, ['bytes', 'dev', 'entries', 'ino', 'logicalPath', 'name', 'physicalPath', 'sha256'],
      'invalid relocation proof element')
    const name = stringField(value, 'name', 'invalid relocation proof element') as ElementName
    if (!ELEMENT_NAMES.includes(name) || elements.has(name)) fail('invalid relocation proof element')
    const logicalPath = stringField(value, 'logicalPath', 'invalid relocation proof element')
    const physicalPath = stringField(value, 'physicalPath', 'invalid relocation proof element')
    const expected = relativeOf(name, profile)
    if (!canonical(logicalPath) || !canonical(physicalPath)
      || relative(logicalHome, logicalPath) !== expected || relative(physicalHome, physicalPath) !== expected
      || logicalPath !== under(logicalHome, expected) || physicalPath !== under(physicalHome, expected)) {
      fail('relocation element paths differ')
    }
    const entries = naturalField(value, 'entries', 'invalid relocation proof element')
    if (entries < 1) fail('invalid relocation proof element')
    elements.set(name, {
      logicalPath, physicalPath,
      dev: naturalField(value, 'dev', 'invalid relocation proof element'),
      ino: naturalField(value, 'ino', 'invalid relocation proof element'),
      sha256: hexField(value, 'sha256', 'invalid relocation proof element'),
      entries,
      bytes: naturalField(value, 'bytes', 'invalid relocation proof element'),
    })
  }
  if (elements.size !== ELEMENT_NAMES.length) fail('invalid relocation proof elements')

  const digests = object(record.digests, 'invalid relocation proof digests')
  exactKeys(digests, ['behavior', 'creation', 'release', 'relocation', 'repository', 'runtime'],
    'invalid relocation proof digests')
  for (const key of ['behavior', 'creation', 'release', 'relocation', 'repository', 'runtime']) {
    hexField(digests, key, 'invalid relocation proof digests')
  }
  return { record, elements, digests }
}

async function verifyCopies(elements: Map<ElementName, ElementMeta>): Promise<void> {
  for (const name of ELEMENT_NAMES) {
    const meta = elements.get(name) ?? fail('invalid relocation proof elements')
    await privateDirectory(dirname(meta.physicalPath), 'unsafe relocation destination')
    const info = await lstat(meta.physicalPath)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
      || info.dev !== meta.dev || info.ino !== meta.ino || await realpath(meta.physicalPath) !== meta.physicalPath
      || await hashTree(meta.physicalPath, undefined, 'relocated tree differs') !== meta.sha256) {
      fail('relocated tree differs')
    }
  }
}

interface PhysicalFamily {
  runtime: JsonObject
  repository: JsonObject
  snapshot: JsonObject
  userNamespace: JsonObject
  runtimeRuntime: LinuxRuntime
  repositoryRuntime: LinuxRuntime
  behavior: LinuxPluginBehaviorRuntime
  behaviorReceipt: JsonObject
  creationReceipt: JsonObject
  releaseReceipt: JsonObject
}

async function readRelocated(physicalHome: string, profile: string, peer: LinuxBehaviorPeer,
  elements: Map<ElementName, ElementMeta>): Promise<PhysicalFamily> {
  const runtimeReceipt = await readReceipt(
    join(under(physicalHome, runtimeFamily(profile)), 'bootstrap.json'), false)
  const repositoryReceipt = await readReceipt(
    join(under(physicalHome, repositoryFamily(profile)), 'bootstrap.json'), false)
  const behaviorReceipt = await readReceipt(
    join(under(physicalHome, behaviorFamily(profile)), 'behavior.json'), false)
  const creationReceipt = await readReceipt(
    join(join(physicalHome, creationRelative(profile)), 'bootstrap.json'), false)
  const releaseReceipt = await readReceipt(
    join(under(physicalHome, releaseRelative(profile)), 'bootstrap.json'), false)
  const runtimeRuntime = validateRuntime(runtimeReceipt.runtime)
  const repositoryRuntime = validateRuntime(repositoryReceipt.runtime)
  const snapshot = validateSnapshot(repositoryReceipt.systemSnapshot)
  const userNamespace = validateUserNamespace(repositoryReceipt.userNamespace)
  const behavior = validateBehavior(peer, behaviorReceipt.descriptor)

  if (runtimeReceipt.schemaVersion !== 3 || runtimeReceipt.backend !== 'linux-native'
    || runtimeRuntime.root.path !== elements.get('runtime')?.logicalPath) fail('relocated runtime receipt differs')
  if (repositoryReceipt.schemaVersion !== 4 || repositoryReceipt.backend !== 'linux-native'
    || repositoryRuntime.root.path !== elements.get('repository-runtime')?.logicalPath
    || readRoot(snapshot).path !== elements.get('system')?.logicalPath) {
    fail('relocated repository receipt differs')
  }
  if (behaviorReceipt.schemaVersion !== 1
    || behavior.runtime.root.path !== elements.get('behavior-runtime')?.logicalPath) {
    fail('relocated behavior receipt differs')
  }
  if (creationReceipt.schemaVersion !== 3 || creationReceipt.backend !== 'linux-native') {
    fail('relocated creation receipt differs')
  }
  if (releaseReceipt.schemaVersion !== 2 || releaseReceipt.backend !== 'linux-native') {
    fail('relocated release receipt differs')
  }
  return {
    runtime: runtimeReceipt, repository: repositoryReceipt, snapshot, userNamespace,
    runtimeRuntime, repositoryRuntime, behavior, behaviorReceipt, creationReceipt, releaseReceipt,
  }
}

function sameTree(root: JsonObject, meta: ElementMeta): boolean {
  return root.dev === meta.dev && root.ino === meta.ino && root.sha256 === meta.sha256
}

async function validateRelocatedReceipts(family: PhysicalFamily, logicalHome: string, physicalHome: string,
  profile: string, elements: Map<ElementName, ElementMeta>, peer: LinuxBehaviorPeer,
  digests: JsonObject): Promise<void> {
  const { runtime, repository, snapshot, userNamespace, runtimeRuntime, repositoryRuntime, behavior,
    behaviorReceipt, creationReceipt, releaseReceipt } = family
  const runtimeMeta = elements.get('runtime') ?? fail('invalid relocation proof elements')
  const repositoryMeta = elements.get('repository-runtime') ?? fail('invalid relocation proof elements')
  const systemMeta = elements.get('system') ?? fail('invalid relocation proof elements')
  const behaviorMeta = elements.get('behavior-runtime') ?? fail('invalid relocation proof elements')

  verifyReceiptDigest(runtime, 'relocated runtime receipt digest differs')
  if (runtime.dshHome !== logicalHome || runtime.profile !== profile
    || !sameTree(readRoot(runtimeRuntime as unknown as JsonObject), runtimeMeta)) {
    fail('relocated runtime receipt differs')
  }
  if (digests.runtime !== runtime.receiptDigest) fail('relocated runtime receipt digest differs')

  verifyReceiptDigest(repository, 'relocated repository receipt digest differs')
  const repositoryRuntimeDigest = linuxRuntimeDigest(repositoryRuntime)
  if (repository.dshHome !== logicalHome || repository.profile !== profile
    || !sameTree(readRoot(repositoryRuntime as unknown as JsonObject), repositoryMeta)
    || !sameTree(readRoot(snapshot), systemMeta)
    || repository.baseRuntimeDigest !== digest(runtime.runtime)
    || repository.runtimeDigest !== digest(repository.runtime)
    || repository.systemSnapshotDigest !== digest(repository.systemSnapshot)
    || repository.userNamespaceDigest !== digest(repository.userNamespace)
    || repository.ownerUid !== process.getuid?.() || repository.ownerGid !== process.getgid?.()) {
    fail('relocated repository receipt differs')
  }
  if (digests.repository !== repository.receiptDigest) fail('relocated repository receipt digest differs')

  verifyReceiptDigest(behaviorReceipt, 'relocated behavior receipt digest differs')
  if (behaviorReceipt.baseRuntimeDigest !== repositoryRuntimeDigest
    || !sameTree(readRoot(behavior.runtime as unknown as JsonObject), behaviorMeta)) {
    fail('relocated behavior receipt differs')
  }
  if (digests.behavior !== behaviorReceipt.receiptDigest) fail('relocated behavior receipt digest differs')

  verifyReceiptDigest(creationReceipt, 'relocated creation receipt digest differs')
  validateCgroupRoots(creationReceipt.cgroupRoots, logicalHome)
  if (creationReceipt.dshHome !== logicalHome || creationReceipt.profile !== profile
    || creationReceipt.buildRuntimeDigest !== repositoryRuntimeDigest
    || creationReceipt.repositoryRuntimeDigest !== repositoryRuntimeDigest
    || creationReceipt.preparationDigest !== behaviorReceipt.receiptDigest
    || creationReceipt.behaviorDigest !== peer.linuxPluginBehaviorRuntimeDigest(behavior)
    || creationReceipt.systemSnapshotDigest !== digest(snapshot)
    || creationReceipt.userNamespaceDigest !== digest(userNamespace)
    || !isDeepStrictEqual(creationReceipt.behavior, behaviorReceipt.descriptor)
    || creationReceipt.sourceCommit !== repository.sourceCommit
    || creationReceipt.lockSha256 !== repository.lockSha256) fail('relocated creation receipt differs')
  if (digests.creation !== creationReceipt.receiptDigest) fail('relocated creation receipt digest differs')

  // Release build: the pins must describe the logical Home, and re-deriving
  // them from the physical trees must reproduce the sealed digests.
  verifyReceiptDigest(releaseReceipt, 'relocated release receipt digest differs')
  exactKeys(releaseReceipt, ['backend', 'dshHome', 'profile', 'receiptDigest', 'releaseBuild', 'runtimeDigest',
    'schemaVersion', 'sourceCommit'], 'relocated release receipt differs')
  const pins = releaseLayout(releaseReceipt, logicalHome, profile)
  const toolchainMeta = elements.get('release-toolchain') ?? fail('invalid relocation proof elements')
  const storeMeta = elements.get('release-store') ?? fail('invalid relocation proof elements')
  const cacheMeta = elements.get('release-cache') ?? fail('invalid relocation proof elements')
  if (releaseReceipt.dshHome !== logicalHome || releaseReceipt.profile !== profile
    || releaseReceipt.sourceCommit !== repository.sourceCommit
    || releaseReceipt.runtimeDigest !== linuxRuntimeDigest(runtimeRuntime)
    || pins.pnpmRoot.path !== toolchainMeta.logicalPath || pins.storeRoot.path !== storeMeta.logicalPath
    || pins.cacheRoot.path !== cacheMeta.logicalPath) {
    fail('relocated release receipt differs')
  }
  if (digests.release !== releaseReceipt.receiptDigest) fail('relocated release receipt digest differs')
  const physicalOf = (path: string): string => {
    const suffix = relative(logicalHome, path)
    if (suffix === '' || suffix.startsWith('..') || isAbsolute(suffix)) {
      fail('relocated release receipt differs')
    }
    return under(physicalHome, suffix)
  }
  for (const [label, item, kind] of [
    ['toolchain', pins.pnpmRoot, 'tree'],
    ['store', pins.storeRoot, 'tree'],
    ['cache', pins.cacheRoot, 'tree'],
    ['node', pins.nodeExecutable, 'executable'],
    ['pnpm', pins.pnpmExecutable, 'executable'],
  ] as const) {
    const physical = physicalOf(item.path)
    const computed = kind === 'tree' ? await releaseInventory(physical, undefined)
      : await pinnedExecutableDigest(physical, undefined)
    if (computed !== item.sha256) fail(`relocated release ${label} differs`)
  }
}

/** Re-derive a relocation proof from its physical Home without ever reading the
 * logical Home; the proof must still describe a byte-identical, un-opened copy. */
export async function verifyLinuxRsiNativeRelocation(proof: LinuxRsiNativeRelocationProof): Promise<void> {
  const { record, elements, digests } = proofShape(proof)
  if (relocationDigest(proof) !== digests.relocation) fail('relocation proof digest differs')
  if (process.platform !== 'linux') fail('Linux native relocation verification requires Linux')
  const peer = behaviorPeer()
  const logicalHome = stringField(record, 'logicalHome', 'invalid relocation proof')
  const physicalHome = stringField(record, 'physicalHome', 'invalid relocation proof')
  const profile = stringField(record, 'profile', 'invalid relocation proof')

  await verifyCopies(elements)
  const family = await readRelocated(physicalHome, profile, peer, elements)
  await validateRelocatedReceipts(family, logicalHome, physicalHome, profile, elements, peer, digests)
}
