#!/usr/bin/env node
import {
  chmodSync, chownSync, existsSync, lstatSync, mkdirSync,
  readFileSync, realpathSync, statfsSync, writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const V1_MAGIC = 0x27e0eb
export const V2_MAGIC = 0x63677270
export const V1_CONTROLLERS = ['cpu', 'memory', 'pids', 'freezer']
export const V2_CONTROLLERS = ['cpu', 'memory', 'pids']
export const V2_ROOT = '/sys/fs/cgroup'

function fail(message) { throw new Error(`prepare Linux cgroups: ${message}`) }

export function parsePrepareArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== '--uid'
    || !/^[1-9][0-9]{0,9}$/u.test(argv[1]) || !['--v1', '--v2', '--auto'].includes(argv[2])) {
    fail('usage: prepare-linux-cgroups --uid <numeric non-root UID> <--v1|--v2|--auto>')
  }
  const uid = Number.parseInt(argv[1], 10)
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff) fail('invalid numeric non-root UID')
  return { uid, mode: argv[2].slice(2) }
}

export function parseMountinfoEntries(text) {
  const entries = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const sep = line.indexOf(' - ')
    if (sep < 0) continue
    const before = line.slice(0, sep).split(' ')
    const after = line.slice(sep + 3).split(' ')
    const mountPoint = before[4]
    const fsType = after[0]
    if (!mountPoint || !fsType) continue
    entries.push({
      mountPoint,
      fsType,
      options: (after[2] ?? '').split(',').filter(Boolean),
    })
  }
  return entries
}

export function collectV1ControllerMounts(entries) {
  const mounts = new Map()
  for (const entry of entries) {
    if (entry.fsType !== 'cgroup' || !entry.mountPoint.startsWith('/sys/fs/cgroup/')) continue
    for (const option of entry.options) {
      if (V1_CONTROLLERS.includes(option)) {
        mounts.set(option, [...(mounts.get(option) ?? []), entry.mountPoint])
      }
    }
  }
  const resolved = {}
  for (const controller of V1_CONTROLLERS) {
    const list = mounts.get(controller) ?? []
    if (list.length !== 1) fail(`cgroup v1 controller ${controller} requires a single mount`)
    const mount = list[0]
    if (!/^\/sys\/fs\/cgroup\/[A-Za-z0-9_,]+$/u.test(mount)) fail('unexpected controller mount')
    resolved[controller] = mount
  }
  return resolved
}

export function resolveMountMode(mountinfoText, requestedMode) {
  const entries = parseMountinfoEntries(mountinfoText)
  const v1All = entries.filter(entry => entry.fsType === 'cgroup')
  const v2All = entries.filter(entry => entry.fsType === 'cgroup2')
  const v2Root = v2All.filter(entry => entry.mountPoint === V2_ROOT)
  const v2Other = v2All.filter(entry => entry.mountPoint !== V2_ROOT)

  if (requestedMode === 'v1') {
    return { mode: 'v1', v1Mounts: collectV1ControllerMounts(entries) }
  }
  if (requestedMode === 'v2') {
    if (v1All.length > 0 || v2Other.length > 0) fail('hybrid or non-unified cgroup hierarchy cannot be prepared with --v2')
    if (v2Root.length === 0) fail('cgroup v2 unified mount at /sys/fs/cgroup is unavailable')
    if (v2Root.length > 1) fail('multiple cgroup v2 mounts at /sys/fs/cgroup')
    return { mode: 'v2', unifiedMount: V2_ROOT }
  }
  if (requestedMode === 'auto') {
    if (v1All.length > 0 && v2All.length > 0) fail('hybrid cgroup v1/v2 hierarchy detected; ambiguous delegation mode')
    if (v2All.length > 0) {
      if (v2Other.length > 0 || v2Root.length !== 1) fail('ambiguous or non-canonical cgroup v2 mount layout')
      return { mode: 'v2', unifiedMount: V2_ROOT }
    }
    if (v1All.length > 0) {
      return { mode: 'v1', v1Mounts: collectV1ControllerMounts(entries) }
    }
    fail('no supported cgroup hierarchy detected')
  }
  fail(`unsupported delegation mode: ${requestedMode}`)
}

export function parseControllerTokens(text) {
  return new Set(text.trim().split(/\s+/u).filter(Boolean))
}

export function missingSubtreeControllers(controllersText, subtreeText, required = V2_CONTROLLERS) {
  const available = parseControllerTokens(controllersText)
  for (const controller of required) {
    if (!available.has(controller)) fail(`required cgroup v2 controller ${controller} is unavailable`)
  }
  const enabled = parseControllerTokens(subtreeText)
  return required.filter(controller => !enabled.has(controller))
}

function checkedDirectory(path, owner, role, magic) {
  if (realpathSync(path) !== path) fail('noncanonical controller directory')
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || (info.mode & 0o022) !== 0
    || (info.mode & 0o700) !== 0o700 || statfsSync(path).type !== magic) fail('controller directory ownership or filesystem differs')
  if (role === 'parent' && (info.mode & 0o005) !== 0o005) fail('delegation parent cannot be traversed')
}

function ensureSafeDirectory(path, ownerUid, mode, magic, role) {
  if (existsSync(path)) {
    const existing = lstatSync(path)
    if (existing.isSymbolicLink() || !existing.isDirectory()) fail('noncanonical controller directory')
  } else {
    mkdirSync(path, { recursive: false, mode })
  }
  chownSync(path, ownerUid, ownerUid)
  chmodSync(path, mode)
  checkedDirectory(path, ownerUid, role, magic)
}

function prepareV1(uid, v1Mounts) {
  const roots = {}
  for (const [controller, mount] of Object.entries(v1Mounts)) {
    if (!/^\/sys\/fs\/cgroup\/[A-Za-z0-9_,]+$/u.test(mount) || realpathSync(mount) !== mount
      || statfsSync(mount).type !== V1_MAGIC) fail('unexpected controller mount')
    const parent = `${mount}/dsh-native`, leaf = `${parent}/uid-${uid}`
    ensureSafeDirectory(parent, 0, 0o755, V1_MAGIC, 'parent')
    ensureSafeDirectory(leaf, uid, 0o700, V1_MAGIC, 'leaf')
    roots[controller] = leaf
  }
  return { schemaVersion: 1, mode: 'v1', uid, roots }
}

function ensureSubtreeControllers(dir, required = V2_CONTROLLERS) {
  const controllersPath = `${dir}/cgroup.controllers`
  const subtreePath = `${dir}/cgroup.subtree_control`
  const missing = missingSubtreeControllers(
    readFileSync(controllersPath, 'utf8'),
    readFileSync(subtreePath, 'utf8'),
    required,
  )
  if (missing.length > 0) {
    writeFileSync(subtreePath, `${missing.map(controller => `+${controller}`).join(' ')}\n`, 'utf8')
    const remaining = missingSubtreeControllers(
      readFileSync(controllersPath, 'utf8'),
      readFileSync(subtreePath, 'utf8'),
      required,
    )
    if (remaining.length > 0) fail(`failed to enable cgroup v2 subtree controllers (${remaining.join(', ')})`)
  }
}

function verifyFreezeSupport(leaf) {
  const freezePath = `${leaf}/cgroup.freeze`
  if (!existsSync(freezePath)) fail('cgroup.freeze is unsupported in delegated cgroup v2 subtree')
  const info = lstatSync(freezePath)
  if (info.isSymbolicLink() || !info.isFile()) fail('invalid cgroup.freeze interface file')
  if (readFileSync(freezePath, 'utf8').trim() !== '0') fail('delegated cgroup.freeze is unavailable or frozen')
}

function prepareV2DelegatedLeaf(parent, uid) {
  ensureSafeDirectory(parent, 0, 0o755, V2_MAGIC, 'parent')
  ensureSubtreeControllers(parent, V2_CONTROLLERS)

  const leaf = `${parent}/uid-${uid}`
  ensureSafeDirectory(leaf, uid, 0o700, V2_MAGIC, 'leaf')
  const leafControllers = parseControllerTokens(readFileSync(`${leaf}/cgroup.controllers`, 'utf8'))
  for (const controller of V2_CONTROLLERS) {
    if (!leafControllers.has(controller)) fail(`delegated cgroup v2 leaf lacks controller ${controller}`)
  }
  ensureSubtreeControllers(leaf, V2_CONTROLLERS)
  verifyFreezeSupport(leaf)
  for (const controlFile of ['cgroup.procs', 'cgroup.threads', 'cgroup.subtree_control', 'cgroup.kill']) {
    const target = `${leaf}/${controlFile}`
    if (existsSync(target)) chownSync(target, uid, uid)
  }
  return leaf
}

function prepareV2(uid, unifiedMount) {
  if (unifiedMount !== V2_ROOT || realpathSync(V2_ROOT) !== V2_ROOT) fail('noncanonical cgroup v2 root')
  const rootInfo = lstatSync(V2_ROOT)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || statfsSync(V2_ROOT).type !== V2_MAGIC) {
    fail('cgroup v2 root filesystem differs')
  }
  ensureSubtreeControllers(V2_ROOT, V2_CONTROLLERS)
  const leaf = prepareV2DelegatedLeaf(`${V2_ROOT}/dsh-native`, uid)
  // Standalone non-systemd callers can migrate into `${leaf}/host` (a leaf
  // without subtree_control) so `leaf` is the writable common ancestor for
  // sibling `job-*` cgroups without violating the v2 no-internal-processes rule.
  const hostLeaf = `${leaf}/host`
  ensureSafeDirectory(hostLeaf, uid, 0o700, V2_MAGIC, 'leaf')
  for (const controlFile of ['cgroup.procs', 'cgroup.threads', 'cgroup.kill']) {
    const target = `${hostLeaf}/${controlFile}`
    if (existsSync(target)) chownSync(target, uid, uid)
  }

  // When systemd's user manager slice is active (`user@<uid>.service`), also
  // delegate `dsh-native/uid-<uid>` inside `user@<uid>.service` so user-unit
  // Hosts share `user@<uid>.service` as a uid-writable common ancestor.
  const userSlice = `${V2_ROOT}/user.slice`
  const uidSlice = `${userSlice}/user-${uid}.slice`
  const userService = `${uidSlice}/user@${uid}.service`
  let systemdUnified
  if (existsSync(userService) && lstatSync(userService).isDirectory() && !lstatSync(userService).isSymbolicLink()) {
    ensureSubtreeControllers(userSlice, V2_CONTROLLERS)
    ensureSubtreeControllers(uidSlice, V2_CONTROLLERS)
    if (existsSync(`${uidSlice}/cgroup.procs`)) chownSync(`${uidSlice}/cgroup.procs`, uid, uid)
    ensureSubtreeControllers(userService, V2_CONTROLLERS)
    systemdUnified = prepareV2DelegatedLeaf(`${userService}/dsh-native`, uid)
  }
  return {
    schemaVersion: 1,
    mode: 'v2',
    uid,
    roots: { unified: systemdUnified ?? leaf },
    ...(systemdUnified ? { rootUnified: leaf, hostLeaf } : { hostLeaf }),
  }
}

export function runPrepareLinuxCgroups(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() !== 0) {
    fail('root Linux x64/arm64 is required')
  }
  const { uid, mode } = parsePrepareArgs(argv)
  const resolved = resolveMountMode(readFileSync('/proc/self/mountinfo', 'utf8'), mode)
  const receipt = resolved.mode === 'v2'
    ? prepareV2(uid, resolved.unifiedMount)
    : prepareV1(uid, resolved.v1Mounts)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

function isCliEntrypoint() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isCliEntrypoint()) runPrepareLinuxCgroups()
