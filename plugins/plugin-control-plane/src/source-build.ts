import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ControlPlaneCliError } from './errors.js'
import { verifyRevisedPluginWorkspace, type SourceRevisionBinding } from './source-revision.js'
import type { CreationCapabilitySourceSnapshot } from './creation-capability-source.js'
import type { PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { verifyCreatedPluginWorkspace, type SourceCreationBinding } from './source-creation.js'
import { checkedSourceSnapshot, runLocalBuffer, runLocalCommand } from './source-workspace.js'
import type { SourcePreparedEvidence } from './types.js'

export interface SourceBuildConfig {
  /** Canonical owner-controlled docker client. */
  dockerPath: string
  /** Image pinned by manifest reference or a local immutable image content ID. */
  image: string
  timeoutMs: number
  memoryMiB: number
  cpus: number
  pidsLimit: number
  workspaceMiB: number
  outputBytes: number
  /** Host-owned package/runtime version bump before the checked tree is frozen. */
  versioning?: 'patch'
  /** Owner-only opt-in for the larger, full-repository check budget. */
  profile?: 'standard' | 'repository'
  /** Writable /tmp tmpfs size. Defaults to 32 MiB for standard, 2048 MiB for repository. */
  temporaryMiB?: number
  /** Explicit owner opt-in for nested unprivileged sandboxes. Relaxes Docker's
   * system-path masks, hides /sys, and requires the pinned seccomp/runtime. */
  repositorySandbox?: { seccompPath: string }
}

export interface SourceBuildResult {
  treeDigest: string
  patchDigest: string
  checkedAt: number
  evidence: SourcePreparedEvidence
  /** Host-only bytes from the same verified in-container pack read. Never persisted in source evidence. */
  packArtifact?: Buffer
}

const imageDigest = /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u
const marker = /^DSH_PREPARED_PACK\t([^\t\n]+)\t([0-9]+)\t([a-f0-9]{64})\t([^\t\n]+)\t([^\t\n]+)$/mu
const packFrame = 'DSH_PREPARED_PACK_BYTES_V1\t'
const maximumPackBytes = 32 * 1024 * 1024
const maximumPackBase64Bytes = Math.ceil(maximumPackBytes / 3) * 4
const repositorySeccompSha256 = 'b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342'

/** Exact in-container command recorded in prepared source evidence. */
export const PREPARED_SOURCE_BUILD_SCRIPT = String.raw`set -eu
checked() {
  phase="$1"; shift
  if "$@" >"/tmp/$phase.log" 2>&1; then return 0; else
    code=$?
    printf 'source build phase failed: %s\n' "$phase" >&2
    tail -c 8192 "/tmp/$phase.log" >&2
    return "$code"
  fi
}
umask 077
mkdir -p /workspace
archive="$(mktemp /tmp/dsh-source-input.XXXXXX)"
cat >"$archive"
archive_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
tar -xf "$archive" -C /workspace --no-same-owner --no-same-permissions
verify_input() {
  current_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
  if [ "$current_sha" != "$archive_sha" ]; then
    printf 'source build input archive changed\n' >&2
    return 1
  fi
  NODE_OPTIONS= NODE_PATH= node - "$archive" /workspace "$1" <<'DSH_SOURCE_VERIFY'
const fs = require('node:fs')
const path = require('node:path')
const archive = fs.openSync(process.argv[2], 'r')
const root = path.resolve(process.argv[3])
const initializing = process.argv[4] === 'init'
if (!initializing && process.argv[4] !== 'verify') throw new Error('invalid source verification phase')
const length = fs.fstatSync(archive).size
const fail = reason => { console.error('source build input changed: ' + reason); process.exit(1) }
const block = (position, size) => {
  const out = Buffer.alloc(size)
  if (fs.readSync(archive, out, 0, size, position) !== size) fail('archive truncated')
  return out
}
const text = bytes => {
  const end = bytes.indexOf(0)
  const slice = end < 0 ? bytes : bytes.subarray(0, end)
  const result = slice.toString('utf8')
  if (!Buffer.from(result, 'utf8').equals(slice)) fail('archive path is not UTF-8')
  return result
}
const octal = bytes => {
  const value = text(bytes).trim()
  if (!/^[0-7]+$/.test(value)) fail('unsupported archive number')
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) fail('archive number exceeds safe bound')
  return parsed
}
const pax = bytes => {
  const values = {}
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at)
    if (space < 0) fail('malformed archive extension')
    const size = Number(bytes.subarray(at, space).toString('ascii'))
    if (!Number.isSafeInteger(size) || size <= space - at + 2 || at + size > bytes.length || bytes[at + size - 1] !== 10) fail('malformed archive extension')
    const value = bytes.subarray(space + 1, at + size - 1).toString('utf8')
    const equal = value.indexOf('=')
    if (equal < 1) fail('malformed archive extension')
    values[value.slice(0, equal)] = value.slice(equal + 1)
    at += size
  }
  return values
}
const archiveKey = raw => {
  const name = raw.startsWith('./') ? raw.slice(2) : raw
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.length === 0 || parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) fail('unsafe archive path')
  return parts.join('/')
}
const checkedPath = raw => {
  const parts = archiveKey(raw).split('/')
  let current = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index])
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('archive parent replaced by a link')
  }
  const full = path.resolve(root, ...parts)
  if (!full.startsWith(root + path.sep)) fail('archive path escaped workspace')
  return full
}
let at = 0
let extension = {}
const members = []
const byName = new Map()
while (at + 512 <= length) {
  const header = block(at, 512)
  if (header.every(byte => byte === 0)) break
  const size = octal(header.subarray(124, 136))
  const mode = octal(header.subarray(100, 108)) & 0o7777
  const kind = String.fromCharCode(header[156] || 48)
  const end = at + 512 + size
  if (!Number.isSafeInteger(end) || end > length) fail('archive member truncated')
  if (kind === 'g' || kind === 'x') {
    if (size > 1_048_576) fail('archive extension exceeds bound')
    const parsed = pax(block(at + 512, size))
    if (kind === 'x') extension = parsed
  } else {
    const prefix = text(header.subarray(345, 500))
    const headerName = text(header.subarray(0, 100))
    const name = extension.path || (prefix ? prefix + '/' + headerName : headerName)
    const key = archiveKey(name)
    if (byName.has(key)) fail('duplicate archive member: ' + name)
    const member = { name, key, kind, size, mode, offset: at + 512,
      link: extension.linkpath || text(header.subarray(157, 257)) }
    members.push(member)
    byName.set(key, member)
    extension = {}
  }
  at = Math.ceil(end / 512) * 512
}
if (members.length === 0) fail('archive had no source files')
// Only immutable package manifests can authorize pnpm 11's pre-install bin
// normalization. A bin must already have Git's owner executable bit.
const bins = new Set()
for (const member of members) {
  if (member.key !== 'package.json' && !/^(?:plugins|packages)\/[a-z0-9][a-z0-9-]*\/package\.json$/.test(member.key)) continue
  if ((member.kind !== '0' && member.kind !== '7') || member.size > 1_048_576) fail('unsafe source package manifest')
  const bytes = block(member.offset, member.size)
  const content = bytes.toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(bytes)) fail('source package manifest is not UTF-8')
  let manifest
  try { manifest = JSON.parse(content) } catch { fail('invalid source package manifest') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.directories?.bin !== undefined) fail('unsupported source package bin')
  const declared = manifest.bin
  if (declared === undefined) continue
  if (typeof declared !== 'string' && (!declared || typeof declared !== 'object' || Array.isArray(declared))) fail('invalid source package bin')
  const paths = typeof declared === 'string' ? [declared] : Object.values(declared)
  const packageRoot = member.key === 'package.json' ? '' : member.key.slice(0, -'/package.json'.length) + '/'
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.endsWith('/')) fail('invalid source package bin path')
    const relative = archiveKey(raw)
    const targetKey = packageRoot + relative
    const parts = targetKey.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const parent = byName.get(parts.slice(0, index).join('/'))
      if (parent && parent.kind !== '5') fail('source package bin parent is not a directory: ' + raw)
    }
    const target = byName.get(targetKey)
    if (target === undefined) {
      if (relative.startsWith('lib/')) continue
      fail('source package bin target is missing: ' + raw)
    }
    if ((target.kind !== '0' && target.kind !== '7') || !(target.mode & 0o100)) fail('source package bin target is not an executable regular input: ' + raw)
    bins.add(target.key)
  }
}
const verifiedBins = new Map()
for (const member of members) {
  const { name, key, kind, size, mode, link } = member
  const full = checkedPath(name)
  const before = fs.lstatSync(full)
  if (kind === '0' || kind === '7') {
      const expectedMode = !initializing && bins.has(key) ? 0o755 : mode & 0o700
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== size || (before.mode & 0o7777) !== expectedMode) fail('original file replaced: ' + name)
      const input = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const opened = fs.fstatSync(input)
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== size || opened.nlink !== 1 || (opened.mode & 0o7777) !== expectedMode) fail('original file changed while opened: ' + name)
        for (let offset = 0; offset < size; offset += 65_536) {
          const count = Math.min(65_536, size - offset)
          const expected = block(member.offset + offset, count)
          const actual = Buffer.alloc(count)
          if (fs.readSync(input, actual, 0, count, offset) !== count || !actual.equals(expected)) fail('original file content changed: ' + name)
        }
        const after = fs.fstatSync(input)
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1 || (after.mode & 0o7777) !== expectedMode) fail('original file changed while compared: ' + name)
        if (bins.has(key)) verifiedBins.set(key, { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs })
      } finally { fs.closeSync(input) }
    } else if (kind === '5') {
      if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o7777) !== (mode & 0o700)) fail('original directory replaced: ' + name)
    } else if (kind === '2') {
      if (!before.isSymbolicLink() || fs.readlinkSync(full) !== link) fail('original link replaced: ' + name)
    } else fail('unsupported archive member type: ' + name)
}
if (initializing) {
  for (const key of bins) {
    const member = byName.get(key)
    const full = checkedPath(member.name)
    const input = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = fs.fstatSync(input)
      const verified = verifiedBins.get(key)
      if (!verified || !before.isFile() || before.nlink !== 1 || before.dev !== verified.dev || before.ino !== verified.ino
        || before.size !== verified.size || before.mtimeMs !== verified.mtimeMs || before.ctimeMs !== verified.ctimeMs
        || (before.mode & 0o7777) !== (member.mode & 0o700)) fail('source package bin changed before normalization: ' + key)
      fs.fchmodSync(input, 0o755)
      if ((fs.fstatSync(input).mode & 0o7777) !== 0o755) fail('source package bin normalization failed: ' + key)
    } finally { fs.closeSync(input) }
  }
}
fs.closeSync(archive)
DSH_SOURCE_VERIFY
  current_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
  if [ "$current_sha" != "$archive_sha" ]; then
    printf 'source build input archive changed\n' >&2
    return 1
  fi
}
cd /workspace
verify_input init
if [ "$(printenv DSH_SOURCE_TRUST_LOCKFILE 2>/dev/null || true)" = true ]; then
  test "$(pnpm --version)" = 11.7.0 || { printf 'source creation requires pinned pnpm\n' >&2; exit 1; }
  test -f /opt/dsh-source-baseline/pnpm-lock.yaml || { printf 'source creation baseline lock is absent\n' >&2; exit 1; }
  test "$(sha256sum /opt/dsh-source-baseline/pnpm-lock.yaml | cut -d ' ' -f1)" = "$(printenv DSH_SOURCE_BASE_LOCK_SHA256 2>/dev/null || true)" || { printf 'source creation baseline lock differs\n' >&2; exit 1; }
  checked install pnpm install --offline --frozen-lockfile --ignore-scripts --trust-lockfile
else
  checked install pnpm install --offline --frozen-lockfile --ignore-scripts
fi
checked check /bin/sh -ceu 'umask 022; exec pnpm check'
verify_input verify
mkdir -p /workspace/.dsh-pack
cd "$PLUGIN_ROOT"
checked pack pnpm pack --pack-destination /workspace/.dsh-pack
verify_input verify
set -- /workspace/.dsh-pack/*.tgz
test "$#" = 1
pack="$1"
NODE_OPTIONS= NODE_PATH= node - "$archive" "$pack" "$PLUGIN_ROOT" "$archive_sha" <<'DSH_SOURCE_PACK_VERIFY'
const fs = require('node:fs')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const path = require('node:path')
const zlib = require('node:zlib')
const fail = reason => { console.error('source packed artifact changed: ' + reason); process.exit(1) }
if (fs.statSync(process.argv[2]).size > 64 * 1024 * 1024) fail('source archive exceeds verification bound')
const source = fs.readFileSync(process.argv[2])
if (crypto.createHash('sha256').update(source).digest('hex') !== process.argv[5]) fail('immutable source archive changed')
const packedPath = process.argv[3]
const pluginRoot = process.argv[4]
if (!/^plugins\/[a-z0-9][a-z0-9-]*$/.test(pluginRoot)) fail('invalid plugin root')
const packedStat = fs.lstatSync(packedPath)
if (!packedStat.isFile() || packedStat.isSymbolicLink() || packedStat.nlink !== 1) fail('packed artifact is not a regular file')
if (packedStat.size > 32 * 1024 * 1024) fail('compressed artifact exceeds bound')
const packedFd = fs.openSync(packedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
const opened = fs.fstatSync(packedFd)
if (opened.dev !== packedStat.dev || opened.ino !== packedStat.ino || opened.size !== packedStat.size) fail('packed artifact changed while opened')
const packed = fs.readFileSync(packedFd)
fs.closeSync(packedFd)
if (packed.length > 32 * 1024 * 1024) fail('compressed artifact exceeds bound')
let tar
try { tar = zlib.gunzipSync(packed, { maxOutputLength: 128 * 1024 * 1024 }) }
catch { fail('invalid or oversized gzip artifact') }
const string = value => {
  const end = value.indexOf(0)
  const bytes = end < 0 ? value : value.subarray(0, end)
  const result = bytes.toString('utf8')
  if (!Buffer.from(result, 'utf8').equals(bytes)) fail('invalid UTF-8 tar name')
  return result
}
const octal = value => {
  const raw = string(value).trim()
  if (!/^[0-7]+$/.test(raw)) fail('invalid tar size')
  const parsed = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(parsed)) fail('oversized tar member')
  return parsed
}
const pax = bytes => {
  const values = {}
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at)
    if (space < 0) fail('malformed tar extension')
    const size = Number(bytes.subarray(at, space).toString('ascii'))
    if (!Number.isSafeInteger(size) || size <= space - at + 2 || at + size > bytes.length || bytes[at + size - 1] !== 10) fail('malformed tar extension')
    const value = bytes.subarray(space + 1, at + size - 1).toString('utf8')
    const equal = value.indexOf('=')
    if (equal < 1 || Object.hasOwn(values, value.slice(0, equal))) fail('malformed tar extension')
    values[value.slice(0, equal)] = value.slice(equal + 1)
    at += size
  }
  return values
}
const entries = (buffer, prefix) => {
  const result = new Map()
  let at = 0; let extension = {}; let global = {}
  while (at + 512 <= buffer.length) {
    const header = buffer.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    const checksum = octal(header.subarray(148, 156))
    let actualChecksum = 0
    for (let index = 0; index < 512; index += 1) actualChecksum += index >= 148 && index < 156 ? 32 : header[index]
    if (checksum !== actualChecksum) fail('invalid tar header checksum')
    const size = octal(header.subarray(124, 136))
    const end = at + 512 + size
    if (!Number.isSafeInteger(end) || end > buffer.length) fail('truncated tar member')
    const kind = String.fromCharCode(header[156] || 48)
    if (kind === 'g' || kind === 'x') {
      if (size > 1_048_576) fail('oversized tar extension')
      const parsed = pax(buffer.subarray(at + 512, end))
      if (kind === 'g') global = { ...global, ...parsed }; else extension = parsed
    } else {
      const attributes = { ...global, ...extension }
      if (Object.keys(attributes).some(key => !['path', 'mtime', 'atime', 'ctime', 'comment', 'uid', 'gid', 'uname', 'gname', 'mode'].includes(key))) fail('unsupported tar extension')
      const headerName = string(header.subarray(0, 100))
      const pathPrefix = string(header.subarray(345, 500))
      const raw = attributes.path || (pathPrefix ? pathPrefix + '/' + headerName : headerName)
      const name = raw.endsWith('/') ? raw.slice(0, -1) : raw
      if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe tar member path')
      if (result.has(name)) fail('duplicate tar member: ' + name)
      if (kind !== '0' && kind !== '5' && kind !== '7') fail('unsupported tar member type: ' + name)
      if (prefix === 'package' && name !== 'package' && !name.startsWith('package/')) fail('tar member outside package')
      result.set(name, { kind, bytes: buffer.subarray(at + 512, end) })
      extension = {}
    }
    at = Math.ceil(end / 512) * 512
  }
  if (at + 1024 > buffer.length || !buffer.subarray(at).every(byte => byte === 0)) fail('tar has no valid trailer')
  return result
}
const original = entries(source, 'source')
const artifact = entries(tar, 'package')
const required = ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']
for (const relative of required) {
  const expected = original.get(pluginRoot + '/' + relative)
  const actual = artifact.get('package/' + relative)
  if (!expected || expected.kind !== '0' || !actual || actual.kind !== '0') fail('missing fixed package file: ' + relative)
}
const json = bytes => { try { return JSON.parse(bytes.toString('utf8')) } catch { fail('invalid package manifest') } }
const originalManifest = json(original.get(pluginRoot + '/package.json').bytes)
const actualManifest = json(artifact.get('package/package.json').bytes)
const expectedName = '@dsh-enhanced/' + pluginRoot.slice('plugins/'.length)
if (originalManifest.name !== expectedName || actualManifest.name !== expectedName
  || originalManifest.dsh?.bundle?.patch !== './cordis.patch.yml'
  || actualManifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package identity or bundle patch changed')
const catalogs = new Map()
const workspaceYaml = original.get('pnpm-workspace.yaml')
if (!workspaceYaml || workspaceYaml.kind !== '0') fail('immutable workspace catalog is missing')
let catalogSection = ''
let catalogName = ''
for (const line of workspaceYaml.bytes.toString('utf8').split(/\r?\n/)) {
  if (line === 'catalog:') { catalogSection = 'default'; catalogName = ''; continue }
  if (line === 'catalogs:') { catalogSection = 'named'; catalogName = ''; continue }
  if (/^[^\s#][^:]*:/u.test(line)) { catalogSection = ''; catalogName = ''; continue }
  if (catalogSection === 'named') {
    const heading = /^  ([a-z][a-z0-9-]*):\s*$/u.exec(line)
    if (heading) { catalogName = heading[1]; continue }
  }
  const pattern = catalogSection === 'default' ? /^  (?:'([^']+)'|"([^"]+)"|([^\s:]+)):\s+(.+?)\s*$/u
    : catalogSection === 'named' && catalogName ? /^    (?:'([^']+)'|"([^"]+)"|([^\s:]+)):\s+(.+?)\s*$/u : null
  const matched = pattern?.exec(line)
  if (!matched) continue
  const name = matched[1] || matched[2] || matched[3]
  const raw = matched[4]
  const value = /^(['"])(.*)\1$/u.exec(raw)?.[2] ?? raw
  const key = (catalogSection === 'named' ? catalogName : '') + '\0' + name
  if (catalogs.has(key) || !value || value.includes('#')) fail('ambiguous immutable workspace catalog')
  catalogs.set(key, value)
}
const workspaceVersions = new Map()
for (const [name, member] of original) {
  if (!/^(?:plugins|packages)\/[^/]+\/package\.json$/u.test(name) || member.kind !== '0') continue
  const manifest = json(member.bytes)
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || workspaceVersions.has(manifest.name)) fail('ambiguous workspace package identity')
  workspaceVersions.set(manifest.name, manifest.version)
}
const dependencies = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
for (const key of dependencies) {
  const originalDependencies = originalManifest[key] || {}
  const packedDependencies = actualManifest[key] || {}
  if (!originalDependencies || typeof originalDependencies !== 'object' || Array.isArray(originalDependencies)
    || !packedDependencies || typeof packedDependencies !== 'object' || Array.isArray(packedDependencies)
    || JSON.stringify(Object.keys(originalDependencies).sort()) !== JSON.stringify(Object.keys(packedDependencies).sort())) fail('package dependency names differ')
  for (const [name, value] of Object.entries(originalDependencies)) {
    const packedValue = packedDependencies[name]
    if (typeof value !== 'string' || typeof packedValue !== 'string' || packedValue.length > 256) fail('package dependency value differs')
    let expected = value
    if (value.startsWith('catalog:')) {
      const catalogName = value.slice('catalog:'.length)
      expected = catalogs.get(catalogName + '\0' + name)
      if (typeof expected !== 'string') fail('unresolved immutable workspace catalog')
    } else if (value.startsWith('workspace:')) {
      const selector = value.slice('workspace:'.length)
      const version = workspaceVersions.get(name)
      if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
        || !['*', '^', '~'].includes(selector)) fail('unsupported workspace dependency locator')
      expected = selector === '*' ? version : selector + version
    }
    if (packedValue !== expected) fail('package dependency value differs')
  }
}
// pnpm 11.7.0 omits these fields, then appends its filtered scripts map.
// Derive that exact published order from the immutable archive, not the pack workspace.
const expectedManifest = {}
for (const [key, value] of Object.entries(originalManifest)) {
  if (!['scripts', 'packageManager', 'pnpm'].includes(key)) expectedManifest[key] = value
}
if (originalManifest.scripts != null) {
  if (typeof originalManifest.scripts !== 'object' || Array.isArray(originalManifest.scripts)) fail('invalid source package scripts')
  const scripts = {}
  const omitted = new Set(['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish'])
  for (const [key, value] of Object.entries(originalManifest.scripts)) {
    if (!omitted.has(key)) scripts[key] = value
  }
  expectedManifest.scripts = scripts
}
if (!actualManifest || typeof actualManifest !== 'object' || Array.isArray(actualManifest)) fail('invalid package manifest')
for (const key of dependencies) { delete expectedManifest[key]; delete actualManifest[key] }
if (JSON.stringify(expectedManifest) !== JSON.stringify(actualManifest)) fail('fixed manifest fields differ')
const requirePublished = (entry, field) => {
  if (typeof entry === 'string') {
    if (!entry.startsWith('./') || entry.includes('*') || entry.split('/').some(part => part === '..')
      || !artifact.has('package/' + entry.slice(2)) || artifact.get('package/' + entry.slice(2)).kind !== '0') fail('published entry is missing: ' + field)
  } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    for (const [key, nested] of Object.entries(entry)) requirePublished(nested, field + '.' + key)
  } else fail('unsupported published entry: ' + field)
}
for (const field of ['main', 'types', 'exports', 'imports', 'bin']) {
  if (originalManifest[field] !== undefined) requirePublished(originalManifest[field], field)
}
for (const [name, actual] of artifact) {
  if (actual.kind !== '0' && actual.kind !== '7') continue
  const expected = original.get(pluginRoot + name.slice('package'.length))
  if (expected && name !== 'package/package.json' && !actual.bytes.equals(expected.bytes)) fail('fixed package file differs: ' + name)
  if (!expected && !name.startsWith('package/lib/')) fail('unexpected package file: ' + name)
}
const pnpmVersion = childProcess.execFileSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
const digest = crypto.createHash('sha256').update(packed).digest('hex')
console.log(['DSH_PREPARED_PACK', path.basename(packedPath), packed.length, digest, process.version, pnpmVersion].join('\t'))
if (process.env.DSH_SOURCE_CAPTURE_PACK === 'true') process.stdout.write('DSH_PREPARED_PACK_BYTES_V1\t' + packed.toString('base64') + '\n')
DSH_SOURCE_PACK_VERIFY
`

interface SourceBuildLimits {
  profile: 'standard' | 'repository'
  temporaryMiB: number
}

function sourceBuildLimits(config: SourceBuildConfig): SourceBuildLimits {
  const profile = config.profile ?? 'standard'
  return { profile, temporaryMiB: config.temporaryMiB ?? (profile === 'repository' ? 2_048 : 32) }
}

export function validateSourceBuildConfig(config: SourceBuildConfig): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config) || (config.profile !== undefined && config.profile !== 'standard' && config.profile !== 'repository')
    || (config.versioning !== undefined && config.versioning !== 'patch')
    || (config.temporaryMiB !== undefined && !Number.isSafeInteger(config.temporaryMiB))
    || (config.repositorySandbox !== undefined && (config.profile !== 'repository' || typeof config.repositorySandbox !== 'object' || config.repositorySandbox === null
      || Array.isArray(config.repositorySandbox) || Object.getPrototypeOf(config.repositorySandbox) !== Object.prototype
      || Object.keys(config.repositorySandbox).length !== 1 || Object.keys(config.repositorySandbox)[0] !== 'seccompPath'
      || typeof config.repositorySandbox.seccompPath !== 'string' || !config.repositorySandbox.seccompPath.startsWith('/') || config.repositorySandbox.seccompPath.includes('\0')))
    || typeof config.image !== 'string' || config.image.length > 256 || !imageDigest.test(config.image) || typeof config.dockerPath !== 'string' || !config.dockerPath.startsWith('/') || config.dockerPath.includes('\0')
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 60_000
    || !Number.isSafeInteger(config.memoryMiB) || config.memoryMiB < 128
    || !Number.isSafeInteger(config.pidsLimit) || config.pidsLimit < 16
    || !Number.isFinite(config.cpus) || config.cpus < 0.25
    || !Number.isSafeInteger(config.workspaceMiB) || config.workspaceMiB < 64
    || !Number.isSafeInteger(config.outputBytes) || config.outputBytes < 4096 || config.outputBytes > 1_048_576) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source build configuration is invalid')
  }
  const limits = sourceBuildLimits(config)
  const repository = limits.profile === 'repository'
  if (config.timeoutMs > (repository ? 1_800_000 : 240_000)
    || config.memoryMiB > (repository ? 16_384 : 4_096)
    || config.pidsLimit > (repository ? 1_024 : 512)
    || config.cpus > (repository ? 16 : 4)
    || config.workspaceMiB > (repository ? 8_192 : 2_048)
    || limits.temporaryMiB < 32 || limits.temporaryMiB > (repository ? 4_096 : 32)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source build configuration is invalid')
  }
}

async function snapshotRepositorySeccomp(config: SourceBuildConfig, temporary: string): Promise<{ path: string; digest: string } | undefined> {
  const sandbox = config.repositorySandbox
  if (sandbox === undefined) return undefined
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp requires linux x64')
  const canonical = await realpath(sandbox.seccompPath)
  if (canonical !== resolve(sandbox.seccompPath)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp profile must be canonical')
  const before = await lstat(canonical); const parent = await lstat(dirname(canonical)); const uid = process.getuid?.()
  if (!before.isFile() || before.isSymbolicLink() || before.size > 65_536 || (before.mode & 0o022) !== 0
    || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0
    || (uid !== undefined && before.uid !== 0 && before.uid !== uid)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp profile is not an owner-safe bounded regular file')
  }
  const bytes = await readFile(canonical)
  const after = await lstat(canonical)
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp profile changed while being read')
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== repositorySeccompSha256) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp profile digest is not approved')
  const path = join(temporary, 'repository-seccomp.json')
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
  return { path, digest }
}

async function verifiedDockerPath(path: string): Promise<string> {
  const canonical = await realpath(path)
  const executable = await lstat(canonical); const parent = await lstat(dirname(canonical)); const uid = process.getuid?.()
  if (resolve(path) !== canonical || !executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o111) === 0
    || (executable.mode & 0o022) !== 0 || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o002) !== 0
    || (uid !== undefined && executable.uid !== 0 && executable.uid !== uid)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source build docker client is not a canonical owner-safe executable')
  }
  return canonical
}

async function sourceTree(worktree: string, baseCommit: string, scope: readonly string[], environment: NodeJS.ProcessEnv): Promise<{ tree: string; temporary: string; cleanup: () => Promise<void> }> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-source-build-index-'))
  try {
    const env = { ...environment, GIT_INDEX_FILE: join(temporary, 'index') }
    await runLocalCommand('git', ['read-tree', baseCommit], worktree, env)
    await runLocalCommand('git', ['--literal-pathspecs', 'add', '--all', '--', ...scope], worktree, env)
    const tree = (await runLocalCommand('git', ['write-tree'], worktree, env, { capture: true })).trim()
    if (!/^[a-f0-9]{40}$/u.test(tree)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'temporary source tree is invalid')
    return { tree, temporary, cleanup: async () => { await rm(temporary, { recursive: true, force: true }) } }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
}

/**
 * Archive an exact temporary-index tree into a disposable, mount-free Docker
 * container. No repository, state directory, socket, credential, environment
 * value, or Host path crosses the boundary: the sole input is tar on stdin.
 */
export async function runDockerPreparedChecks(input: {
  config: SourceBuildConfig
  worktree: string
  baseCommit: string
  name: string
  scope: readonly string[]
  environment: NodeJS.ProcessEnv
  signal: AbortSignal
  assertCurrent: () => Promise<void>
  preparedAt: number
  /** Frozen before resource acquisition by the durable Host job. */
  sourceJob?: { id: string; containerName: string }
  /** Frozen owner grant and generator proof for Host-scaffolded creation only. */
  creation?: SourceCreationBinding
  revision?: { binding: SourceRevisionBinding; parentSource: CreationCapabilitySourceSnapshot; parentCertificate: PluginCreationVerificationCertificate; files: readonly import('./source-workspace.js').ScopedPluginFile[] }
  /** Host-only request to return the exact already-verified pack bytes for independent verification. */
  capturePack?: true
}): Promise<SourceBuildResult> {
  if (input.capturePack !== undefined && input.capturePack !== true) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source pack capture request is invalid')
  if (input.sourceJob !== undefined && (!/^source-job-[a-f0-9]{64}$/u.test(input.sourceJob.id)
    || input.sourceJob.containerName !== `dsh-${input.sourceJob.id}`)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'invalid durable container identity')
  validateSourceBuildConfig(input.config); const limits = sourceBuildLimits(input.config); const dockerPath = await verifiedDockerPath(input.config.dockerPath); await input.assertCurrent()
  if (input.config.repositorySandbox !== undefined) {
    const version = await dockerControl(dockerPath, ['version', '--format', '{{.Server.Version}}/{{.Server.Os}}/{{.Server.Arch}}'], input.signal)
    if (version.code !== 0 || version.stdout.trim() !== '29.4.1/linux/amd64') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository seccomp requires approved Docker runtime 29.4.1/linux/amd64')
    await input.assertCurrent()
  }
  let creationSnapshot: Awaited<ReturnType<typeof checkedSourceSnapshot>> | undefined
  let baseLockDigest: string | undefined
  const verifyCreation = async (): Promise<void> => {
    if (input.creation === undefined && input.revision === undefined) return
    if (input.creation !== undefined && input.revision !== undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source build has conflicting preparation authorities')
    if ((input.creation?.grant ?? input.revision!.binding.grant).expiresAt <= Date.now()) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation grant expired before build')
    const verified = input.revision === undefined ? await verifyCreatedPluginWorkspace({ worktree: input.worktree, baseCommit: input.baseCommit,
      name: input.name, environment: input.environment, signal: input.signal, assertCurrent: input.assertCurrent,
      creation: input.creation! }) : await verifyRevisedPluginWorkspace({ worktree: input.worktree, baseCommit: input.baseCommit,
        name: input.name, environment: input.environment, signal: input.signal, assertCurrent: input.assertCurrent,
        revision: input.revision.binding, parentSource: input.revision.parentSource, parentCertificate: input.revision.parentCertificate, files: input.revision.files })
    const expected = [...input.scope].sort()
    const actual = [...verified.scope].sort()
    if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation build scope differs from verified scope')
    }
    await input.assertCurrent()
    if ((input.creation?.grant ?? input.revision!.binding.grant).expiresAt <= Date.now()) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation grant expired before build')
  }
  if (input.creation !== undefined || input.revision !== undefined) {
    await verifyCreation()
    creationSnapshot = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment, undefined, input.signal)
    const baseLock = await runLocalBuffer('git', ['show', `${input.baseCommit}:pnpm-lock.yaml`], input.worktree,
      input.environment, { maximumOutput: 8_388_608, signal: input.signal })
    baseLockDigest = createHash('sha256').update(baseLock).digest('hex')
  }
  const snapshot = await sourceTree(input.worktree, input.baseCommit, input.scope, input.environment)
  let before: Awaited<ReturnType<typeof checkedSourceSnapshot>>
  let packageVersion: string
  let seccomp: { path: string; digest: string } | undefined
  try {
    seccomp = await snapshotRepositorySeccomp(input.config, snapshot.temporary)
    before = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment, snapshot.tree)
    if (creationSnapshot !== undefined) {
      if (before.checkedTreeDigest !== creationSnapshot.checkedTreeDigest || before.checkedPatchDigest !== creationSnapshot.checkedPatchDigest) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation staged tree differs from verified workspace')
      }
      await verifyCreation()
      const current = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment, undefined, input.signal)
      if (current.checkedTreeDigest !== creationSnapshot.checkedTreeDigest || current.checkedPatchDigest !== creationSnapshot.checkedPatchDigest) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation changed after verification')
      }
    }
    const packageJson = await runLocalCommand('git', ['show', `${snapshot.tree}:plugins/${input.name}/package.json`],
      input.worktree, input.environment, { capture: true, maximumOutput: 65_536 })
    const value: unknown = (JSON.parse(packageJson) as { version?: unknown })?.version
    if (typeof value !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source package version is invalid')
    }
    packageVersion = value
    await input.assertCurrent()
    input.signal.throwIfAborted()
  } catch (error) { await snapshot.cleanup(); throw error }
  const container = input.sourceJob?.containerName ?? `dsh-source-prepare-${randomUUID()}`
  if (input.sourceJob !== undefined) {
    try {
      const existing = await dockerControl(dockerPath, ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${container}$`], input.signal)
      if (existing.code !== 0 || existing.stdout.trim() !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable source container already exists or cannot be inspected')
    } catch (error) { await snapshot.cleanup(); throw error }
  }
  if ((input.creation !== undefined || input.revision !== undefined) && (input.creation?.grant ?? input.revision!.binding.grant).expiresAt <= Date.now()) {
    await snapshot.cleanup()
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation grant expired before build')
  }
  const script = PREPARED_SOURCE_BUILD_SCRIPT
  const args = ['run', '-i', '--pull', 'never', '--name', container, '--label', `dsh.source.tree=${snapshot.tree}`, ...(input.sourceJob === undefined ? [] : ['--label', `dsh.source.job=${input.sourceJob.id}`]), ...(seccomp === undefined ? [] : ['--label', `dsh.source.seccomp.sha256=${seccomp.digest}`]), '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', String(input.config.pidsLimit),
    '--memory', `${input.config.memoryMiB}m`, '--memory-swap', `${input.config.memoryMiB}m`, '--cpus', String(input.config.cpus),
    '--tmpfs', `/workspace:rw,nosuid,nodev,mode=1777,size=${input.config.workspaceMiB}m${limits.profile === 'repository' ? ',exec' : ''}`, '--tmpfs', `/tmp:rw,nosuid,nodev,mode=1777,size=${limits.temporaryMiB}m${limits.profile === 'repository' ? ',exec' : ''}`,
    '--workdir', '/workspace', '--env', `PLUGIN_ROOT=plugins/${input.name}`, '--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    ...(input.capturePack ? ['--env', 'DSH_SOURCE_CAPTURE_PACK=true'] : []),
    ...(baseLockDigest === undefined ? [] : ['--env', 'DSH_SOURCE_TRUST_LOCKFILE=true', '--env', `DSH_SOURCE_BASE_LOCK_SHA256=${baseLockDigest}`]),
    ...(limits.profile === 'repository' ? ['--env', 'CI=true', '--env', `VITEST_MAX_WORKERS=${Math.max(1, Math.min(4, Math.floor(input.config.cpus)))}`] : []),
    // Docker's masked proc submounts prevent procfs mounts in a child user
    // namespace. This opt-in removes those system-path masks; an empty /sys
    // compensates for sysfs exposure, but does not restore the /proc masks.
    ...(seccomp === undefined ? [] : ['--security-opt', `seccomp=${seccomp.path}`,
      '--security-opt', 'systempaths=unconfined', '--tmpfs', '/sys:ro,nosuid,nodev,noexec,size=1m']),
    '--entrypoint', '/bin/sh', input.config.image, '-ceu', script]
  const git = spawn('/usr/bin/git', ['archive', '--format=tar', snapshot.tree], { cwd: input.worktree, env: input.environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const docker = spawn(dockerPath, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { PATH: '/usr/bin:/bin' } })
  git.stderr.resume()
  docker.stdin!.on('error', () => { /* EPIPE is settled by the Docker exit result. */ })
  git.stdout.pipe(docker.stdin!)
  const dockerDone = new Promise<number | null>((resolvePromise, reject) => { docker.once('error', reject); docker.once('close', resolvePromise) })
  const gitDone = new Promise<void>((resolvePromise, reject) => { git.once('error', reject); git.once('close', code => code === 0 ? resolvePromise() : reject(new ControlPlaneCliError('EXECUTOR_FAILED', `source archive exited ${code}`))) })
  const stdoutLimit = input.config.outputBytes + (input.capturePack ? packFrame.length + maximumPackBase64Bytes + 1 : 0)
  let stdout = ''; let stdoutBytes = 0; let stderr = ''; let overflow = false; let timedOut = false
  const add = (target: 'out' | 'err', chunk: Buffer): void => {
    if (target === 'err') { stderr = (stderr + chunk.toString('utf8')).slice(-4096); return }
    const remaining = stdoutLimit - stdoutBytes
    if (remaining > 0) stdout += chunk.subarray(0, remaining).toString('utf8')
    stdoutBytes += chunk.length
    if (stdoutBytes > stdoutLimit) { overflow = true; stop() }
  }
  docker.stdout!.on('data', (chunk: Buffer) => add('out', chunk)); docker.stderr!.on('data', (chunk: Buffer) => add('err', chunk))
  const stop = (): void => { git.kill('SIGKILL'); docker.kill('SIGKILL') }
  const abort = (): void => { timedOut = true; stop() }
  input.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, input.config.timeoutMs)
  if (input.signal.aborted) abort()
  const started = Date.now()
  try {
    const [code] = await Promise.all([dockerDone, gitDone])
    await input.assertCurrent()
    if (timedOut || input.signal.aborted) throw new ControlPlaneCliError('EXECUTOR_TIMEOUT', 'isolated source build was cancelled or exceeded its deadline')
    if (overflow) throw new ControlPlaneCliError('EXECUTOR_OUTPUT_LIMIT', 'isolated source build exceeded its output bound')
    if (code !== 0) throw new ControlPlaneCliError('EXECUTOR_FAILED', `isolated source build failed (${code}): ${stderr.trimEnd()}`)
    const match = marker.exec(stdout)
    if (match === null) throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build did not emit its pack evidence marker')
    let packArtifact: Buffer | undefined
    if (input.capturePack) {
      const prefix = `${match[0]}\n${packFrame}`
      if (!stdout.startsWith(prefix) || !stdout.endsWith('\n')) throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build emitted an invalid pack capture frame')
      const encoded = stdout.slice(prefix.length, -1)
      const expectedSize = Number(match[2])
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumPackBytes
        || encoded.length !== Math.ceil(expectedSize / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
        throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build emitted an invalid pack capture frame')
      }
      packArtifact = Buffer.from(encoded, 'base64')
      if (packArtifact.length !== expectedSize || packArtifact.toString('base64') !== encoded
        || createHash('sha256').update(packArtifact).digest('hex') !== match[3]) {
        throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build pack capture differs from verified evidence')
      }
    } else if (stdout.trim() !== match[0]) {
      throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build emitted unexpected evidence output')
    }
    const checked = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment)
    if (checked.checkedTreeDigest !== before.checkedTreeDigest || checked.checkedPatchDigest !== before.checkedPatchDigest) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared source changed while its isolated build was running')
    }
    const logDigest = createHash('sha256').update(stdout).update('\0').update(stderr).digest('hex')
    const checkedAt = Date.now()
    return { treeDigest: checked.checkedTreeDigest, patchDigest: checked.checkedPatchDigest, checkedAt,
      ...(packArtifact === undefined ? {} : { packArtifact }),
      evidence: Object.freeze({ schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
        environment: Object.freeze({ npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: match[4]!, pnpmVersion: match[5]! }),
        commands: Object.freeze([{ command: 'docker', args: Object.freeze([...args]), exitCode: 0 as const, durationMs: Date.now() - started, logDigest }]),
        pack: Object.freeze({ name: match[1]!, sizeBytes: Number(match[2]), sha256: match[3]!, version: packageVersion }), preparedAt: input.preparedAt }) }
  } finally {
    clearTimeout(timer); input.signal.removeEventListener('abort', abort); stop()
    await Promise.allSettled([dockerDone, gitDone])
    try {
      // Failed inspect is ambiguous (daemon loss also exits nonzero). Require
      // a successful exact-name listing from the daemon to prove absence.
      if (input.sourceJob === undefined) await ensureContainerRemoved(dockerPath, container)
      else await removeSourceJobContainer(input.config, input.sourceJob)
    } finally { await snapshot.cleanup() }
  }
}

/** Reconcile only a labeled, image-bound durable container, then prove absence. */
export async function removeSourceJobContainer(config: SourceBuildConfig, job: { id: string; containerName: string }): Promise<void> {
  if (!/^source-job-[a-f0-9]{64}$/u.test(job.id) || job.containerName !== `dsh-${job.id}`) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'invalid durable container identity')
  validateSourceBuildConfig(config)
  const path = await verifiedDockerPath(config.dockerPath)
  const list = (): Promise<{ code: number | null; stdout: string }> => dockerControl(path, ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${job.containerName}$`])
  const before = await list()
  if (before.code !== 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable container absence is unproven')
  if (before.stdout.trim() !== '') {
    const inspected = await dockerControl(path, ['inspect', '--format', '[{{json .Id}},{{json .Name}},{{json .Config.Image}},{{json (index .Config.Labels "dsh.source.job")}}]', job.containerName])
    if (inspected.code !== 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable container identity is unproven')
    const value: unknown = JSON.parse(inspected.stdout)
    if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== 'string' || !/^[a-f0-9]{64}$/u.test(value[0])
      || value[1] !== `/${job.containerName}` || value[2] !== config.image || value[3] !== job.id) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable container ownership mismatch')
    await dockerControl(path, ['rm', '-f', value[0]])
  }
  const after = await list()
  if (after.code !== 0 || after.stdout.trim() !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'durable container cleanup is unproven')
}

async function dockerControl(path: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false, env: { PATH: '/usr/bin:/bin' } })
    let stdout = ''; let bytes = 0; let failed = false
    const abort = (): void => { child.kill('SIGKILL') }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL') }, 5_000)
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4_096) { failed = true; child.kill('SIGKILL') }
      else stdout += chunk.toString('utf8')
    })
    child.once('error', () => { cleanup(); reject(new ControlPlaneCliError('EXECUTOR_FAILED', 'source build control client could not start')) })
    child.once('close', code => {
      cleanup()
      if (signal?.aborted) reject(new ControlPlaneCliError('EXECUTOR_TIMEOUT', 'source build control query was cancelled'))
      else if (failed) reject(new ControlPlaneCliError('EXECUTOR_FAILED', 'source build control query exceeded its resource bound'))
      else resolvePromise({ code, stdout })
    })
  })
}

async function ensureContainerRemoved(path: string, container: string): Promise<void> {
  await dockerControl(path, ['rm', '-f', container])
  const remaining = await dockerControl(path, ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${container}$`])
  if (remaining.code !== 0 || remaining.stdout.trim() !== '') {
    throw new ControlPlaneCliError('EXECUTOR_FAILED', 'isolated source build container cleanup could not prove quiescence')
  }
}
