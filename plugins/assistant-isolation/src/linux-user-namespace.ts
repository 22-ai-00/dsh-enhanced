import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository-only identity protocol. Ordinary/legacy jobs retain their
 * single-UID contract and never inherit this termination authority. */
export interface LinuxUserNamespaceMapping {
  schemaVersion: 1
  ownerUid: number
  ownerGid: number
  candidateUid: number
  candidateGid: number
  hostNamespace: { dev: number; ino: number }
  helpers: {
    uid: { path: '/usr/bin/newuidmap'; sha256: string }
    gid: { path: '/usr/bin/newgidmap'; sha256: string }
  }
}

/** Observed independently by the Host before any candidate receives START.
 * UID/GID maps are exactly [0, owner, 1], [65534, candidate, 1]. */
export interface LinuxUserNamespaceWitness {
  schemaVersion: 1
  bootId: string
  mapping: LinuxUserNamespaceMapping
  namespace: { dev: number; ino: number }
  parent: { dev: number; ino: number }
  ownerUid: number
  leader: { pid: number; startTicks: string }
}

export interface LinuxRepositoryCandidateWitness {
  schemaVersion: 1
  pid: number
  startTicks: string
  bootId: string
  namespace: { dev: number; ino: number }
  uid: number
  gid: number
  groups: []
  capabilities: '0'
  noNewPrivileges: true
  seccomp: 2
}

const PROOF = fileURLToPath(new URL('../runtime/linux-userns-proof.py', import.meta.url))
const HEX = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const TICKS = /^[1-9][0-9]{0,63}$/u
function fail(message: string): never { throw new Error(`Linux user namespace: ${message}`) }

/** Freeze the packaged implementation in each repository execution contract.
 * Updating these bytes cannot silently change an already prepared job. */
export function linuxRepositoryImplementationDigest(): string {
  const digest = createHash('sha256').update('linux-repository-implementation-v1\0')
  for (const name of ['linux-userns-launcher.py', 'linux-candidate-entry.py', 'linux-namespace-worker.mjs',
    'linux-seccomp.py', 'linux-seccomp-policy.json', 'linux-userns-proof.py']) {
    const path = fileURLToPath(new URL(`../runtime/${name}`, import.meta.url))
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size < 1 || before.size > 1_048_576 || before.mode & 0o022) fail('unsafe packaged runtime file')
      const bytes = Buffer.alloc(before.size)
      let used = 0
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, used)
        if (!count) fail('packaged runtime file truncated')
        used += count
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, used)) fail('packaged runtime file grew')
      const after = fstatSync(fd)
      if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('packaged runtime file changed')
      digest.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0')
    } finally { closeSync(fd) }
  }
  return digest.digest('hex')
}
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const positive = (value: unknown): value is number => natural(value) && value > 0
function fields(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join() !== [...expected].sort().join()) fail('record fields differ')
}
function namespace(value: unknown): asserts value is { dev: number; ino: number } {
  fields(value, ['dev', 'ino'])
  if (!natural(value.dev) || !positive(value.ino)) fail('invalid namespace identity')
}
const sameNamespace = (left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean => left.dev === right.dev && left.ino === right.ino
function frozen<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item) } }
  freeze(copy)
  return copy
}

export function validateLinuxUserNamespaceMapping(value: unknown): LinuxUserNamespaceMapping {
  fields(value, ['schemaVersion', 'ownerUid', 'ownerGid', 'candidateUid', 'candidateGid', 'hostNamespace', 'helpers'])
  if (value.schemaVersion !== 1 || !positive(value.ownerUid) || !natural(value.ownerGid)
    || !positive(value.candidateUid) || value.candidateUid < 65_536 || value.candidateUid > 0xffff_fffe
    || !positive(value.candidateGid) || value.candidateGid < 65_536 || value.candidateGid > 0xffff_fffe
    || value.ownerUid === value.candidateUid || value.ownerGid === value.candidateGid) fail('invalid mapping')
  namespace(value.hostNamespace)
  fields(value.helpers, ['uid', 'gid'])
  for (const kind of ['uid', 'gid'] as const) {
    const helper = value.helpers[kind]
    fields(helper, ['path', 'sha256'])
    if (helper.path !== `/usr/bin/new${kind}map` || typeof helper.sha256 !== 'string' || !HEX.test(helper.sha256)) fail('invalid mapping helper')
  }
  return frozen(value as unknown as LinuxUserNamespaceMapping)
}

export function validateLinuxUserNamespaceWitness(value: unknown): LinuxUserNamespaceWitness {
  fields(value, ['schemaVersion', 'bootId', 'mapping', 'namespace', 'parent', 'ownerUid', 'leader'])
  const mapping = validateLinuxUserNamespaceMapping(value.mapping)
  namespace(value.namespace); namespace(value.parent)
  fields(value.leader, ['pid', 'startTicks'])
  if (value.schemaVersion !== 1 || typeof value.bootId !== 'string' || !UUID.test(value.bootId)
    || value.ownerUid !== mapping.ownerUid || sameNamespace(value.namespace, mapping.hostNamespace)
    || !sameNamespace(value.parent, mapping.hostNamespace) || !positive(value.leader.pid)
    || typeof value.leader.startTicks !== 'string' || !TICKS.test(value.leader.startTicks)) fail('invalid namespace witness')
  return frozen(value as unknown as LinuxUserNamespaceWitness)
}

export function validateLinuxRepositoryCandidateWitness(value: unknown, witness: LinuxUserNamespaceWitness): LinuxRepositoryCandidateWitness {
  fields(value, ['schemaVersion', 'pid', 'startTicks', 'bootId', 'namespace', 'uid', 'gid', 'groups', 'capabilities', 'noNewPrivileges', 'seccomp'])
  const anchor = validateLinuxUserNamespaceWitness(witness)
  namespace(value.namespace)
  if (value.schemaVersion !== 1 || !positive(value.pid) || typeof value.startTicks !== 'string' || !TICKS.test(value.startTicks)
    || value.bootId !== anchor.bootId || !sameNamespace(value.namespace, anchor.namespace)
    || value.uid !== anchor.mapping.candidateUid || value.gid !== anchor.mapping.candidateGid
    || !Array.isArray(value.groups) || value.groups.length !== 0 || value.capabilities !== '0'
    || value.noNewPrivileges !== true || value.seccomp !== 2) fail('invalid candidate witness')
  return frozen(value as unknown as LinuxRepositoryCandidateWitness)
}

async function trustedSystemFile(path: string, executable = false): Promise<Buffer> {
  if (await realpath(path) !== path) fail(`noncanonical system file: ${path}`)
  let parent = dirname(path)
  for (;;) {
    const item = await lstat(parent)
    if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== 0 || item.mode & 0o022) fail('untrusted system parent')
    if (parent === '/') break
    parent = dirname(parent)
  }
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.mode & 0o022 || before.size > 1_048_576
    || executable && (before.mode & 0o4111) !== 0o4111) fail(`untrusted system file: ${path}`)
  const bytes = await readFile(path), after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || bytes.length !== before.size) fail('system file changed')
  return bytes
}

async function allocation(kind: 'uid' | 'gid', owner: number, name: string, selected?: number): Promise<number> {
  const content = (await trustedSystemFile(`/etc/sub${kind}`)).toString('utf8')
  const allocated: number[] = []
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const parts = line.split(':')
    if (parts[0] !== name && parts[0] !== String(owner)) continue
    if (parts.length !== 3 || !/^[0-9]+$/u.test(parts[1]!) || !/^[0-9]+$/u.test(parts[2]!)) fail('invalid subordinate allocation')
    const start = Number(parts[1]), length = Number(parts[2])
    if (!natural(start) || !positive(length) || start + length > 0xffff_ffff) fail('invalid subordinate range')
    if (selected !== undefined && selected >= start && selected < start + length) return selected
    const first = Math.max(start, 65_536)
    if (first < start + length && first !== owner) allocated.push(first)
  }
  if (selected !== undefined || allocated.length === 0) fail(`subordinate ${kind} allocation is unavailable`)
  return Math.min(...allocated)
}

/** Read installation-owned allocation; never create, widen or rewrite it. */
export async function readLinuxUserNamespaceMapping(): Promise<LinuxUserNamespaceMapping> {
  if (process.platform !== 'linux' || !process.getuid?.() || !process.getgid) fail('requires non-root Linux')
  const ownerUid = process.getuid(), ownerGid = process.getgid(), name = userInfo().username
  const [candidateUid, candidateGid, uid, gid, host] = await Promise.all([
    allocation('uid', ownerUid, name), allocation('gid', ownerUid, name),
    trustedSystemFile('/usr/bin/newuidmap', true), trustedSystemFile('/usr/bin/newgidmap', true), stat('/proc/self/ns/user'),
  ])
  return validateLinuxUserNamespaceMapping({ schemaVersion: 1, ownerUid, ownerGid, candidateUid, candidateGid,
    hostNamespace: { dev: host.dev, ino: host.ino }, helpers: {
      uid: { path: '/usr/bin/newuidmap', sha256: createHash('sha256').update(uid).digest('hex') },
      gid: { path: '/usr/bin/newgidmap', sha256: createHash('sha256').update(gid).digest('hex') },
    } })
}

/** New dispatch requires the frozen allocation and helpers, not a fresh choice. */
export async function verifyLinuxUserNamespaceMapping(value: LinuxUserNamespaceMapping): Promise<LinuxUserNamespaceMapping> {
  const mapping = validateLinuxUserNamespaceMapping(value)
  if (process.platform !== 'linux' || process.getuid?.() !== mapping.ownerUid || process.getgid?.() !== mapping.ownerGid) fail('Host owner differs')
  const host = await stat('/proc/self/ns/user')
  if (!sameNamespace(host, mapping.hostNamespace)) fail('Host user namespace changed')
  const name = userInfo().username
  await Promise.all([allocation('uid', mapping.ownerUid, name, mapping.candidateUid), allocation('gid', mapping.ownerUid, name, mapping.candidateGid)])
  for (const kind of ['uid', 'gid'] as const) {
    if (createHash('sha256').update(await trustedSystemFile(mapping.helpers[kind].path, true)).digest('hex') !== mapping.helpers[kind].sha256) fail('mapping helper changed')
  }
  return mapping
}

export async function linuxUserNamespaceProof(request: object): Promise<unknown> {
  const bytes = JSON.stringify(request)
  if (Buffer.byteLength(bytes) > 1_048_576) fail('proof request exceeds bound')
  return await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', PROOF], { stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } })
    let output = '', diagnostic = '', size = 0, exceeded = false
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.stdin.on('error', () => { child.kill('SIGKILL') })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if ((size += Buffer.byteLength(chunk)) > 1_048_576) { exceeded = true; child.kill('SIGKILL') }
      else output += chunk
    })
    child.stderr.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-4096) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0 || exceeded) { reject(new Error(`Linux user namespace proof failed: ${diagnostic.slice(-512)}`)); return }
      try { resolve(JSON.parse(output)) } catch (error) { reject(error) }
    })
    child.stdin.end(bytes)
  })
}

export async function inspectLinuxUserNamespace(mapping: LinuxUserNamespaceMapping, identity: { pid: number; startTicks: number | string }): Promise<LinuxUserNamespaceWitness> {
  return validateLinuxUserNamespaceWitness(await linuxUserNamespaceProof({ operation: 'anchor', mapping: validateLinuxUserNamespaceMapping(mapping),
    identity: { pid: identity.pid, startTicks: String(identity.startTicks) } }))
}

export async function inspectLinuxRepositoryCandidate(witness: LinuxUserNamespaceWitness, identity: { pid: number; startTicks: number | string }): Promise<LinuxRepositoryCandidateWitness> {
  return validateLinuxRepositoryCandidateWitness(await linuxUserNamespaceProof({ operation: 'candidate', witness: validateLinuxUserNamespaceWitness(witness),
    identity: { pid: identity.pid, startTicks: String(identity.startTicks) } }), witness)
}
