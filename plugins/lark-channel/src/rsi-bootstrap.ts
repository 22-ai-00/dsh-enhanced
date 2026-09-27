import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { ActiveLarkOwnerBinding } from '@dsh-enhanced/assistant-delivery'
import { ControlPlaneStore, controlPlaneSchemaVersion } from '@dsh-enhanced/plugin-control-plane'
import { compileRsiAuthorityConfigs, type RsiAuthorityConfigInput } from './rsi-authority-config.js'
import { compileRsiProfiles } from './rsi-profile.js'
import { validateRsiAuthorities } from './rsi-setup.js'
import { prepareRsiAuthorityResources } from './rsi-authority-resources.js'
import { prepareRsiAuthorityRuntime } from './rsi-authority-runtime.js'
import { readRsiHostUpdateOverlayChain } from './rsi-host-update.js'
import { rsiBuildResources as io } from './rsi-build.js'

type Profiles = Pick<Parameters<typeof compileRsiProfiles>[0], 'targetPatch' | 'targetEffective'
  | 'coordinatorPatch' | 'coordinatorEffective' | 'coordinatorBase'>
export interface RsiOwnerConfigurationContext {
  binding: ActiveLarkOwnerBinding
  profiles: Profiles
  signal?: AbortSignal
}
export interface RsiOwnerConfiguration {
  schemaVersion: 1
  manifestPath: string
  manifestDigest: string
  targetProfile: string
  coordinatorProfile: string
}
interface Receipt {
  schemaVersion: 1
  planDigest: string
  files: Record<string, string>
  observerKeyDigest: string
  result: RsiOwnerConfiguration
}
interface OwnedFile { path: string; dev: number; ino: number; digest: string }
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
function fail(message: string): never { throw new Error(`rsi bootstrap: ${message}`) }
function within(path: string, root: string): boolean {
  return isAbsolute(path) && resolve(path) === path && path.startsWith(`${root}/`) && !path.includes('\0') && !/[\r\n]/u.test(path)
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function privateFile(path: string, maximum = 2_097_152): Promise<Buffer> {
  if (await realpath(path) !== path) fail(`noncanonical file: ${path}`)
  const stat = await lstat(path)
  if (stat.nlink !== 1 || !stat.isFile()) fail(`unsafe file: ${path}`)
  await io.directory(dirname(path))
  return io.readStable(path, maximum, true)
}

/** Prepare runnable owner-bound configurations, without changing either Host.
 * The installer must hold the DSH_HOME lifecycle lock and reread the current
 * owner/profile sources before calling. Configurations and grants are immutable
 * for this preparation; retry never renews a grant or resets a live ledger. */
export async function prepareRsiOwnerConfiguration(input: RsiAuthorityConfigInput,
  context: RsiOwnerConfigurationContext): Promise<RsiOwnerConfiguration> {
  const signal = AbortSignal.any([context.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
  signal.throwIfAborted()
  const { manifest, resources } = input
  if (context.binding.status !== 'active' || context.binding.owner.status !== 'active'
    || context.binding.owner.role !== 'owner' || context.binding.conversation.kind !== 'dm'
    || !isDeepStrictEqual(context.binding.principal, context.binding.owner.principal)) fail('active owner DM binding is required')
  const observer = manifest.controlPlane.runtimeObserver
  if (!observer) fail('runtime observer is required')
  const home = dirname(dirname(observer.profilePath))
  if (observer.profilePath !== join(home, 'profiles', manifest.targetProfile)
    || resources.root !== join(home, 'rsi-authorities', manifest.targetProfile)) fail('installation paths differ')
  // Revalidate persisted identities and program copies before writing grants.
  // These calls preserve the installation IDs; they do not adopt foreign state.
  const actualResources = await prepareRsiAuthorityResources({ dshHome: home, profile: manifest.targetProfile, signal })
  if (!isDeepStrictEqual(actualResources, resources)) fail('signing resources differ from the installation')
  const runtime = await prepareRsiAuthorityRuntime({ dshHome: home, profile: manifest.targetProfile, signal })
  if (!isDeepStrictEqual(runtime, input.runtime)) fail('authority runtime differs from the installation')
  const compiled = compileRsiAuthorityConfigs(input)
  const manifestPath = join(resources.configRoot, 'manifest.json')
  const receiptPath = join(resources.configRoot, 'bootstrap.json')
  const overlayPath = join(resources.configRoot, 'host-update-overlays.json')
  const files = { ...compiled.files }
  if (Object.hasOwn(files, manifestPath) || Object.hasOwn(files, receiptPath) || Object.hasOwn(files, overlayPath)) fail('reserved configuration path')
  files[manifestPath] = json(manifest)
  if (Object.keys(files).length > 64 || Object.entries(files).some(([path, value]) =>
    !within(path, resources.configRoot) || typeof value !== 'string' || Buffer.byteLength(value) > 2_097_152)) fail('configuration output exceeds its bounds')
  if (!within(observer.keyPath, resources.configRoot) || Object.hasOwn(files, observer.keyPath)
    || [manifestPath, receiptPath, overlayPath].includes(observer.keyPath)) fail('observer key must have a separate private configuration path')
  const ledgerPath = join(manifest.controlPlane.statePath, 'control.sqlite')
  if (!within(ledgerPath, resources.stateRoot) || !within(observer.socketPath, resources.stateRoot)) fail('runtime state must stay in the installation state root')
  const directories = [...new Set([...compiled.directories, dirname(ledgerPath), dirname(observer.keyPath),
    ...Object.keys(files).map(dirname)])].sort((left, right) => left.length - right.length || left.localeCompare(right))
  const roots = [resources.configRoot, resources.stateRoot, resources.registry.root]
  if (directories.some(path => !roots.some(root => path === root || within(path, root)))) fail('generated directory is outside prepared resources')
  const expectedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => [path, hash(value)]))
  const result: RsiOwnerConfiguration = { schemaVersion: 1, manifestPath, manifestDigest: hash(files[manifestPath]!),
    targetProfile: manifest.targetProfile, coordinatorProfile: manifest.coordinatorProfile }
  const verify = async () => {
    signal.throwIfAborted()
    for (const directory of directories) await io.directory(directory)
    await privateFile(ledgerPath, 268_435_456)
    const database = new DatabaseSync(ledgerPath, { readOnly: true })
    try {
      const row = database.prepare('PRAGMA user_version').get() as { user_version: number }
      if (row.user_version !== controlPlaneSchemaVersion) fail('control ledger schema differs from the installed runtime')
    } finally { database.close() }
    const patches = await compileRsiProfiles({ manifest, dshHome: home, ...context.profiles, owner: context.binding })
    await validateRsiAuthorities(manifest, context.binding, manifest.serviceEnvironment?.target)
    for (const phase of Object.keys(runtime.releaseAdapters) as Array<keyof typeof runtime.releaseAdapters>) {
      signal.throwIfAborted()
      const adapter = await import(pathToFileURL(runtime.releaseAdapters[phase].path).href) as {
        inspectLocalReleaseAdapterConfiguration?: (environment: Record<string, string>, phase: string) => unknown
      }
      if (typeof adapter.inspectLocalReleaseAdapterConfiguration !== 'function') fail('installed release adapter lacks configuration inspection')
      const actual = adapter.inspectLocalReleaseAdapterConfiguration(manifest.serviceEnvironment!.target, phase)
      const expected = compiled.trust.releaseAdapters![phase]!
      if (!isDeepStrictEqual(actual, { id: expected.id, phase, executablePath: expected.path,
        authority: expected.authority, keyId: expected.keyId })) fail('release adapter configuration differs from trust')
    }
    signal.throwIfAborted()
    return patches
  }
  if (await exists(receiptPath)) {
    const bootstrapSource = (await privateFile(receiptPath)).toString('utf8')
    const receipt = JSON.parse(bootstrapSource) as Receipt
    const overlay = readRsiHostUpdateOverlayChain({ source: await exists(overlayPath)
      ? (await privateFile(overlayPath)).toString('utf8') : undefined,
    resources, dshHome: home, profile: manifest.targetProfile, bootstrapSource })
    const effective = overlay.latest ?? receipt
    if (receipt.schemaVersion !== 1 || !isDeepStrictEqual(effective.files, expectedFiles)
      || !isDeepStrictEqual(effective.result, result)) fail('existing owner configuration differs; retain it for reconciliation')
    for (const [path, digest] of Object.entries(expectedFiles)) if (hash(await privateFile(path)) !== digest) fail('existing configuration changed')
    const key = await privateFile(observer.keyPath, 32)
    if (key.length !== 32 || hash(key) !== receipt.observerKeyDigest) fail('observer identity changed')
    const patches = await verify()
    if (overlay.latest) {
      const patchDigests = { [manifest.targetProfile]: hash(patches.targetPatch),
        [manifest.coordinatorProfile]: hash(patches.coordinatorPatch) }
      for (const [profile, digest] of Object.entries(overlay.latest.patches)) {
        const path = join(home, 'profiles', profile, 'cordis.patch.yml')
        if (!within(path, join(home, 'profiles')) || hash(await privateFile(path)) !== digest) fail('signed owner profile changed')
      }
      if (Object.entries(patchDigests).some(([profile, digest]) => overlay.latest?.patches[profile] !== digest)
        || hash(json({ files: expectedFiles, patches: overlay.latest.patches })) !== overlay.latest.planDigest
        || overlay.latest.runtimeReceiptDigest !== hash(await privateFile(join(home,
          'rsi-authority-runtimes', manifest.targetProfile, 'receipt.json'), 65_536))) fail('signed Host update differs from compiled configuration')
    } else if (hash(json({ files: expectedFiles, patches })) !== receipt.planDigest) fail('owner or compiled profiles changed')
    return result
  }
  // First preparation must not overwrite an operator's configuration or attach
  // new installation IDs to an existing ledger. A crash leaves inspectable
  // partial resources; it is never interpreted as a fresh installation.
  if ((await readdir(resources.configRoot)).length || await exists(ledgerPath)) fail('unregistered configuration or ledger already exists')
  const ownedFiles: OwnedFile[] = []
  const ownedDirectories: Array<{ path: string; dev: number; ino: number }> = []
  const remember = async (path: string) => {
    const stat = await lstat(path)
    ownedFiles.push({ path, dev: stat.dev, ino: stat.ino, digest: hash(await privateFile(path, 268_435_456)) })
  }
  const directory = async (path: string): Promise<void> => {
    if (roots.includes(path)) { await io.directory(path); return }
    await directory(dirname(path))
    try {
      await mkdir(path, { mode: 0o700 })
      const stat = await lstat(path); ownedDirectories.push({ path, dev: stat.dev, ino: stat.ino })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await io.directory(path)
  }
  const write = async (path: string, bytes: string | Buffer) => {
    signal.throwIfAborted()
    const descriptor = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await descriptor.writeFile(bytes); await descriptor.sync() }
    finally { await descriptor.close(); await remember(path) }
  }
  try {
    for (const path of directories) { signal.throwIfAborted(); await directory(path) }
    await write(observer.keyPath, randomBytes(32))
    // Create the real schema. No empty-file stand-in is accepted as a ledger.
    const store = new ControlPlaneStore({ path: ledgerPath })
    store.close()
    await remember(ledgerPath)
    for (const [path, bytes] of Object.entries(files)) await write(path, bytes)
    const planDigest = hash(json({ files: expectedFiles, patches: await verify() }))
    const receipt: Receipt = { schemaVersion: 1, planDigest, files: expectedFiles,
      observerKeyDigest: hash(await privateFile(observer.keyPath, 32)), result }
    await write(receiptPath, json(receipt))
    for (const path of [...directories].reverse()) await io.syncDirectory(path)
    return result
  } catch (error) {
    // Only remove exact resources created by this invocation. A changed file or
    // nonempty directory survives for reconciliation instead of being erased.
    for (const file of ownedFiles.reverse()) {
      try {
        const stat = await lstat(file.path)
        if (stat.dev === file.dev && stat.ino === file.ino && hash(await privateFile(file.path, 268_435_456)) === file.digest) await unlink(file.path)
      } catch {}
    }
    for (const entry of ownedDirectories.reverse()) {
      try { const stat = await lstat(entry.path); if (stat.dev === entry.dev && stat.ino === entry.ino) await rmdir(entry.path) } catch {}
    }
    throw error
  }
}
