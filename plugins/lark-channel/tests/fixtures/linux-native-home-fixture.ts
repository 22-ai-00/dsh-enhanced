import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm,
  symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashLinuxRuntimeTree, linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import type { LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { relocateLinuxRsiNativeFamily,
  type LinuxRsiNativeRelocationElement, type LinuxRsiNativeRelocationProof } from '../../src/rsi-linux-native-relocation.js'

/** Pure fixture machinery for the Linux-native Home tests. This module must not
 * register Vitest mocks: the optional behavior peer is faked per spec file. */
export const PROFILE = 'unit'
export const SOURCE_COMMIT = '1'.repeat(40)
export const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
export const hex = (label: string): string => sha(`fixture:${label}`)

const directories: string[] = []

/** Remove every Home tree this fixture allocated. */
export async function removeFixtureDirectories(): Promise<void> {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export async function write(path: string, bytes: string, mode = 0o600): Promise<void> {
  // Tampering must work on read-only fixture files, so make the owner writable first.
  await chmod(path, 0o600).catch(() => undefined)
  await writeFile(path, bytes, { mode })
  await chmod(path, mode)
}

/** A minimal immutable toolchain tree: layout the LinuxRuntime invariants require. */
async function runtimeTree(root: string, label: string): Promise<void> {
  await privateDirectory(root)
  for (const name of ['bin', 'pnpm', 'pnpm/bin', 'pnpm-native', 'node_modules', 'store', 'cache']) {
    await mkdir(join(root, name), { recursive: true, mode: 0o755 })
    await chmod(join(root, name), 0o755)
  }
  // The stock reader executes the toolchain, so these stand-ins answer --version.
  const nodeScript = '#!/bin/sh\ncase "$*" in *pnpm.mjs*) echo 11.7.0 ;; *) echo v22.23.2 ;; esac\n'
  await write(join(root, 'bin/node'), nodeScript, 0o555)
  await write(join(root, 'pnpm/bin/pnpm.mjs'), '#!/bin/sh\necho 11.7.0\n', 0o444)
  await write(join(root, 'pnpm-native/pnpm'), '#!/bin/sh\necho 11.7.0\n', 0o555)
  await write(join(root, 'pnpm-native/node'), nodeScript, 0o555)
  await write(join(root, 'pnpm-native/package.json'),
    JSON.stringify({ name: '@pnpm/exe', version: '11.7.0' }), 0o444)
  await write(join(root, 'pnpm-lock.yaml'), 'lock', 0o444)
  for (const name of ['typescript', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-system-prompt']) {
    await mkdir(join(root, 'node_modules', name), { recursive: true })
    await write(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version: '1.0.0' }), 0o444)
  }
  await write(join(root, 'node_modules/index.js'), `export default ${JSON.stringify(label)}\n`, 0o444)
  await write(join(root, 'store/data'), `store-${label}`, 0o444)
  await write(join(root, 'cache/data'), `cache-${label}`, 0o444)
  await symlink('bin/node', join(root, 'node-link'))
}

async function runtimeFor(root: string): Promise<LinuxRuntime> {
  const info = await lstat(root)
  return {
    schemaVersion: 1,
    backend: 'linux-native',
    platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: SOURCE_COMMIT,
    lockSha256: sha('lock'),
    root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
    nodePath: join(root, 'bin/node'),
    nodeSha256: sha(await readFile(join(root, 'bin/node'))),
    pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(root, 'pnpm-native'),
    nativePnpmPath: join(root, 'pnpm-native/pnpm'),
    modulesPath: join(root, 'node_modules'),
    storePath: join(root, 'store'),
    cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1.0.0', cordis: '1.0.0',
      tools: '1.0.0', systemPrompt: '1.0.0' },
  }
}

function behaviorFor(runtime: LinuxRuntime): LinuxPluginBehaviorRuntime {
  return {
    schemaVersion: 1,
    runtime,
    observer: {
      schemaVersion: 1,
      sourceSha256: hex('observer-source'),
      workerSha256: hex('observer-worker'),
      candidateSha256: hex('observer-candidate'),
      launcherSha256: hex('observer-launcher'),
      parentProtectSha256: hex('observer-parent'),
      childProtectSha256: hex('observer-child'),
    },
  }
}

export function seal(content: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(content)) if (key !== 'receiptDigest') base[key] = value
  return { ...base, receiptDigest: sha(JSON.stringify(base)) }
}

export function receiptDigest(receipt: Record<string, unknown>): string {
  const content: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(receipt)) if (key !== 'receiptDigest') content[key] = value
  return sha(JSON.stringify(content))
}

export async function writeReceipt(path: string, receipt: Record<string, unknown>, mode = 0o600): Promise<void> {
  await write(path, JSON.stringify(receipt), mode)
}

export interface Fixture {
  sourceHome: string
  physicalHome: string
  logicalHome: string
  profile: string
  trees: { runtime: string; repository: string; system: string; behavior: string
    release: { toolchain: string; store: string; cache: string } }
}

/** Independent mirror of the release adapter's canonical inventory digest. */
function canonicalRelease(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRelease).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalRelease(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export async function releaseInventoryDigest(root: string): Promise<string> {
  const entries: Record<string, unknown>[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const entryName = prefix === '' ? name : `${prefix}/${name}`
      const info = await lstat(path)
      if (info.isDirectory()) {
        entries.push({ path: entryName, type: 'directory', mode: info.mode & 0o777 })
        await visit(path, entryName)
      } else if (info.isFile()) {
        const bytes = await readFile(path)
        entries.push({ path: entryName, type: 'file', mode: info.mode & 0o777, bytes: bytes.length,
          sha256: sha(bytes) })
      } else entries.push({ path: entryName, type: 'symlink', target: await readlink(path) })
    }
  }
  await visit(root, '')
  return sha(canonicalRelease(entries))
}

/** Stand-in for a host executable pin when the host does not ship one. */
async function hostExecutableDigest(path: string, fallback: string): Promise<string> {
  return sha(await readFile(path).catch(() => Buffer.from(fallback)))
}

/** A fixed toolchain/store/cache release tree set: the executable pins live in
 * the toolchain, and the store keeps the pnpm version registry the readers check. */
async function releaseTrees(profileRoot: string): Promise<{ toolchain: string; store: string; cache: string }> {
  const toolchain = join(profileRoot, 'toolchain')
  const store = join(profileRoot, 'store')
  const cache = join(profileRoot, 'cache')
  await privateDirectory(toolchain)
  await privateDirectory(store)
  await privateDirectory(cache)
  const nodeScript = '#!/bin/sh\necho v22.23.2\n'
  await write(join(toolchain, 'node'), nodeScript, 0o555)
  await write(join(toolchain, 'pnpm'), '#!/bin/sh\necho 11.7.0\n', 0o555)
  await write(join(toolchain, 'package.json'),
    JSON.stringify({ name: 'dsh-local-toolchain', version: '11.7.0' }), 0o444)
  await mkdir(join(toolchain, 'lib', 'bin'), { recursive: true, mode: 0o755 })
  await chmod(join(toolchain, 'lib', 'bin'), 0o755)
  await write(join(toolchain, 'lib', 'bin', 'pnpm.cjs'), 'module.exports = 1\n', 0o444)
  await mkdir(join(store, 'v11', 'projects'), { recursive: true, mode: 0o755 })
  await chmod(join(store, 'v11'), 0o755)
  await chmod(join(store, 'v11', 'projects'), 0o755)
  await write(join(store, 'v11', 'projects', 'registry.json'), '{"projects":[]}\n', 0o444)
  await mkdir(join(cache, 'metadata'), { recursive: true, mode: 0o755 })
  await chmod(join(cache, 'metadata'), 0o755)
  await write(join(cache, 'metadata', 'state.json'), '{"cache":1}\n', 0o444)
  return { toolchain, store, cache }
}

/** Build the five receipt-bound families a prepared Linux-native Home carries. */
export async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'dsh-linux-relocation-test-'))
  directories.push(parent)
  const sourceHome = join(parent, 'source-home')
  await privateDirectory(sourceHome)
  const family = (name: string): string => join(sourceHome, name, PROFILE)
  const runtimeFamily = family('rsi-linux-runtimes')
  const repositoryFamily = family('rsi-linux-repository-runtimes')
  const behaviorFamily = join(sourceHome, 'rsi-authorities', PROFILE, 'state', 'linux-creation-behavior')
  const creationFamily = family('rsi-linux-creation-builds')
  const trees = {
    runtime: join(runtimeFamily, 'runtime'),
    repository: join(repositoryFamily, 'runtime'),
    system: join(repositoryFamily, 'system'),
    behavior: join(behaviorFamily, 'runtime'),
  }
  for (const directory of [runtimeFamily, repositoryFamily, behaviorFamily, creationFamily]) {
    await privateDirectory(directory)
  }
  await runtimeTree(trees.runtime, 'runtime')
  await runtimeTree(trees.repository, 'repository')
  await runtimeTree(trees.system, 'system')
  await runtimeTree(trees.behavior, 'behavior')

  const runtime = await runtimeFor(trees.runtime)
  await writeReceipt(join(runtimeFamily, 'bootstrap.json'), seal({
    schemaVersion: 3,
    backend: 'linux-native',
    dshHome: sourceHome,
    profile: PROFILE,
    sourceCommit: SOURCE_COMMIT,
    lockSha256: runtime.lockSha256,
    runtime,
    manifestHashes: { node: hex('manifest-node'), pnpm: hex('manifest-pnpm') },
    archives: { node: hex('archive-node'), pnpm: hex('archive-pnpm'),
      pnpmExe: hex('archive-pnpm-exe'), pnpmNative: hex('archive-pnpm-native') },
  }))

  const repositoryRuntime = await runtimeFor(trees.repository)
  const systemInfo = await lstat(trees.system)
  const snapshot = {
    schemaVersion: 1,
    root: { path: trees.system, dev: systemInfo.dev, ino: systemInfo.ino,
      sha256: await hashLinuxRuntimeTree(trees.system) },
    manifestSha256: hex('system-manifest'),
    bytes: 4,
    entries: 2,
  }
  const userNamespace = {
    schemaVersion: 1,
    ownerUid: process.getuid!(),
    ownerGid: process.getgid!(),
    candidateUid: 100_000,
    candidateGid: 100_000,
    hostNamespace: { dev: 11, ino: 12 },
    helpers: { uid: { path: '/usr/bin/newuidmap', sha256: hex('newuidmap') },
      gid: { path: '/usr/bin/newgidmap', sha256: hex('newgidmap') } },
  }
  await writeReceipt(join(repositoryFamily, 'bootstrap.json'), seal({
    schemaVersion: 4,
    backend: 'linux-native',
    dshHome: sourceHome,
    profile: PROFILE,
    sourceCommit: SOURCE_COMMIT,
    lockSha256: repositoryRuntime.lockSha256,
    ownerUid: userNamespace.ownerUid,
    ownerGid: userNamespace.ownerGid,
    sourceDigest: hex('source-digest'),
    nodeArchiveDigest: hex('node-archive'),
    npmVersion: '11.7.0',
    baseRuntimeDigest: linuxRuntimeDigest(runtime),
    runtimeDigest: linuxRuntimeDigest(repositoryRuntime),
    systemSnapshotDigest: sha(JSON.stringify(snapshot)),
    userNamespaceDigest: sha(JSON.stringify(userNamespace)),
    runtime: repositoryRuntime,
    systemSnapshot: snapshot,
    userNamespace,
  }))

  const descriptor = behaviorFor(await runtimeFor(trees.behavior))
  const behaviorReceipt = seal({
    schemaVersion: 1,
    baseRuntimeDigest: linuxRuntimeDigest(repositoryRuntime),
    compilerSha256: hex('compiler'),
    descriptor,
  })
  await writeReceipt(join(behaviorFamily, 'behavior.json'), behaviorReceipt, 0o444)

  const cgroupRoots = {
    mode: 'v1',
    cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${process.getuid!()}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${process.getuid!()}`,
    pids: `/sys/fs/cgroup/pids/dsh-native/uid-${process.getuid!()}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${process.getuid!()}`,
  }
  await writeReceipt(join(creationFamily, 'bootstrap.json'), seal({
    schemaVersion: 3,
    backend: 'linux-native',
    dshHome: sourceHome,
    profile: PROFILE,
    sourceCommit: SOURCE_COMMIT,
    lockSha256: runtime.lockSha256,
    buildRuntimeDigest: linuxRuntimeDigest(repositoryRuntime),
    repositoryRuntimeDigest: linuxRuntimeDigest(repositoryRuntime),
    preparationDigest: behaviorReceipt.receiptDigest as string,
    behaviorDigest: sha(JSON.stringify(descriptor)),
    systemSnapshotDigest: sha(JSON.stringify(snapshot)),
    userNamespaceDigest: sha(JSON.stringify(userNamespace)),
    cgroupRoots,
    behavior: descriptor,
  }))

  // The release build pins the executable toolchain and the pnpm store/cache
  // that the native runner mounts read-only.
  const releaseFamily = join(sourceHome, 'rsi-release-builds', PROFILE)
  await privateDirectory(join(sourceHome, 'rsi-release-builds'))
  await privateDirectory(releaseFamily)
  const release = await releaseTrees(releaseFamily)
  await writeReceipt(join(releaseFamily, 'bootstrap.json'), seal({
    schemaVersion: 2,
    backend: 'linux-native',
    sourceCommit: SOURCE_COMMIT,
    runtimeDigest: linuxRuntimeDigest(runtime),
    releaseBuild: {
      sandboxExecutable: { path: '/usr/bin/bwrap',
        sha256: await hostExecutableDigest('/usr/bin/bwrap', hex('bwrap')) },
      tarExecutable: { path: '/usr/bin/tar',
        sha256: await hostExecutableDigest('/usr/bin/tar', hex('tar')) },
      nodeExecutable: { path: join(release.toolchain, 'node'),
        sha256: sha(await readFile(join(release.toolchain, 'node'))) },
      pnpmExecutable: { path: join(release.toolchain, 'pnpm'),
        sha256: sha(await readFile(join(release.toolchain, 'pnpm'))) },
      pnpmRoot: { path: release.toolchain, sha256: await releaseInventoryDigest(release.toolchain) },
      storeRoot: { path: release.store, sha256: await releaseInventoryDigest(release.store) },
      cacheRoot: { path: release.cache, sha256: await releaseInventoryDigest(release.cache) },
    },
    dshHome: sourceHome,
    profile: PROFILE,
  }))

  return {
    sourceHome,
    physicalHome: join(parent, 'stage-home'),
    logicalHome: join(parent, 'logical-home'),
    profile: PROFILE,
    trees: { ...trees, release },
  }
}

export async function relocate(ctx: Fixture): Promise<LinuxRsiNativeRelocationProof> {
  return relocateLinuxRsiNativeFamily({
    sourceHome: ctx.sourceHome, physicalHome: ctx.physicalHome,
    logicalHome: ctx.logicalHome, profile: ctx.profile,
  })
}

export function elementMap(proof: LinuxRsiNativeRelocationProof): Map<string, LinuxRsiNativeRelocationElement> {
  return new Map(proof.elements.map(item => [item.name, item]))
}

/** Recompute the relocation digest so narrower checks can be exercised alone. */
export function reseal(proof: LinuxRsiNativeRelocationProof): void {
  const { runtime, repository, behavior, creation, release } = proof.digests
  const content = { ...proof, digests: { runtime, repository, behavior, creation, release } }
  proof.digests = { ...content.digests, relocation: sha(JSON.stringify(content)) }
}

export async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

export function homePath(home: string, relativePath: string): string {
  return join(home, ...relativePath.split('/'))
}

/** Copy a tree preserving only what hashLinuxRuntimeTree records: names, types, modes, bytes. */
export async function structuralCopy(source: string, destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 })
  const info = await lstat(source)
  for (const name of (await readdir(source)).sort()) {
    const from = join(source, name), to = join(destination, name), child = await lstat(from)
    if (child.isSymbolicLink()) await symlink(await readlink(from), to)
    else if (child.isDirectory()) await structuralCopy(from, to)
    else { await copyFile(from, to); await chmod(to, child.mode & 0o777) }
  }
  await chmod(destination, info.mode & 0o777)
}
