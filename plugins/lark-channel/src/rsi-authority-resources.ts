import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { rsiBuildResources as io } from './rsi-build.js'

export const rsiAuthorityRoles = ['approval', 'release', 'adoption', 'observation', 'qualification', 'host',
  'pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
type Role = typeof rsiAuthorityRoles[number]
export interface RsiAuthorityIdentity { authority: string; keyId: string; keyPath: string; publicKeyPem: string }
export interface RsiAuthorityResources {
  schemaVersion: 1; root: string; installationId: string; ledgerId: string
  identities: Record<Role, RsiAuthorityIdentity>
  registry: { id: string; root: string; locator: string }
  catalog: { id: string; path: string }
  stateRoot: string; configRoot: string
}
interface Receipt { schemaVersion: 1; dshHome: string; profile: string; resources: RsiAuthorityResources
  keyDigests: Record<Role, string>; receiptDigest: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new Error(`rsi authority resources: ${message}`) }

async function readPrivate(path: string, maximum: number): Promise<Buffer> {
  const item = await lstat(path)
  if (!item.isFile() || item.nlink !== 1 || await realpath(path) !== path) fail(`unsafe file: ${path}`)
  return io.readStable(path, maximum, true)
}
function locations(home: string, profile: string) {
  const root = join(home, 'rsi-authorities', profile)
  return { root, keys: join(root, 'identities'), stateRoot: join(root, 'state'), configRoot: join(root, 'config'),
    registryRoot: join(root, 'registry'), catalogPath: join(root, 'catalog.json'), receiptPath: join(root, 'bootstrap.json') }
}
async function inspect(home: string, profile: string, signal: AbortSignal): Promise<RsiAuthorityResources> {
  const paths = locations(home, profile)
  await io.directory(paths.root)
  if (!isDeepStrictEqual((await readdir(paths.root)).sort(), ['bootstrap.json', 'catalog.json', 'config', 'identities', 'registry', 'state'])) fail('existing resources are incomplete')
  const receipt = JSON.parse((await readPrivate(paths.receiptPath, 65_536)).toString('utf8')) as Receipt
  const { receiptDigest, ...content } = receipt
  const resources = receipt.resources
  if (receipt.schemaVersion !== 1 || receipt.dshHome !== home || receipt.profile !== profile
    || hash(JSON.stringify(content)) !== receiptDigest || resources?.schemaVersion !== 1
    || resources.root !== paths.root || !uuid.test(resources.installationId) || !uuid.test(resources.ledgerId)
    || resources.installationId === resources.ledgerId || resources.registry?.id !== `registry-${resources.installationId}`
    || resources.registry.root !== paths.registryRoot || resources.registry.locator !== pathToFileURL(paths.registryRoot).href
    || resources.catalog?.id !== `catalog-${resources.installationId}` || resources.catalog.path !== paths.catalogPath
    || resources.stateRoot !== paths.stateRoot || resources.configRoot !== paths.configRoot
    || !resources.identities || !receipt.keyDigests
    || !isDeepStrictEqual(Object.keys(resources.identities).sort(), [...rsiAuthorityRoles].sort())
    || !isDeepStrictEqual(Object.keys(receipt.keyDigests).sort(), [...rsiAuthorityRoles].sort())) fail('resource receipt differs from the installation')
  for (const directory of [paths.keys, paths.stateRoot, paths.configRoot, paths.registryRoot]) await io.directory(directory)
  if (!isDeepStrictEqual((await readdir(paths.keys)).sort(), rsiAuthorityRoles.map(role => `${role}.pem`).sort())) fail('signing identities changed')
  const publicKeys = new Set<string>()
  for (const role of rsiAuthorityRoles) {
    signal.throwIfAborted()
    const identity = resources.identities[role], expectedAuthority = `${role}-${resources.installationId}`
    if (!isDeepStrictEqual(Object.keys(identity).sort(), ['authority', 'keyId', 'keyPath', 'publicKeyPem'])
      || identity.authority !== expectedAuthority || identity.keyId !== `${expectedAuthority}-key`
      || identity.keyPath !== join(paths.keys, `${role}.pem`)) fail('signing identity binding changed')
    const bytes = await readPrivate(identity.keyPath, 16_384)
    const key = createPrivateKey(bytes), publicKey = createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString()
    if (key.asymmetricKeyType !== 'ed25519' || hash(bytes) !== receipt.keyDigests[role]
      || publicKey !== identity.publicKeyPem || publicKeys.has(publicKey)) fail('signing identity key changed')
    publicKeys.add(publicKey)
  }
  // These are live release resources: validate them, never reset their contents
  // or compare them with the initial empty catalog/registry/state snapshots.
  const { parseCatalog } = await import('@dsh-enhanced/plugin-control-plane')
  parseCatalog(JSON.parse((await readPrivate(paths.catalogPath, 2_097_152)).toString('utf8')))
  signal.throwIfAborted()
  return resources
}

/** Caller holds the DSH_HOME lifecycle lock. This creates identities and local
 * storage, not grants; owner-bound authorization is configured separately. */
export async function prepareRsiAuthorityResources(input: {
  dshHome: string; profile: string; signal?: AbortSignal; existingOnly?: boolean
}): Promise<RsiAuthorityResources> {
  const { dshHome: home, profile } = input
  if (!isAbsolute(home) || resolve(home) !== home || home.includes('\0') || /[\r\n]/u.test(home)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) fail('invalid installation binding')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(30_000)])
  signal.throwIfAborted()
  await io.directory(home, false)
  const parent = join(home, 'rsi-authorities'), paths = locations(home, profile)
  if (input.existingOnly) {
    await io.directory(parent)
    return inspect(home, profile, signal)
  }
  try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await io.directory(parent)
  let existing = false
  try { await lstat(paths.root); existing = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (existing) return inspect(home, profile, signal)
  // An exclusive claim prevents overwriting another installation. Failed work
  // removes only this exact directory; incomplete crash residue is never reset.
  await mkdir(paths.root, { mode: 0o700 })
  const claimed = await lstat(paths.root)
  try {
    for (const directory of [paths.keys, paths.stateRoot, paths.configRoot, paths.registryRoot]) await mkdir(directory, { mode: 0o700 })
    const installationId = randomUUID(), ledgerId = randomUUID()
    const identities = {} as Record<Role, RsiAuthorityIdentity>, keyDigests = {} as Record<Role, string>
    for (const role of rsiAuthorityRoles) {
      signal.throwIfAborted()
      const pair = generateKeyPairSync('ed25519'), keyPath = join(paths.keys, `${role}.pem`)
      const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      await io.writeExclusive(keyPath, privateKey)
      const authority = `${role}-${installationId}`
      identities[role] = { authority, keyId: `${authority}-key`, keyPath,
        publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
      keyDigests[role] = hash(privateKey)
    }
    const resources: RsiAuthorityResources = { schemaVersion: 1, root: paths.root, installationId, ledgerId, identities,
      registry: { id: `registry-${installationId}`, root: paths.registryRoot, locator: pathToFileURL(paths.registryRoot).href },
      catalog: { id: `catalog-${installationId}`, path: paths.catalogPath }, stateRoot: paths.stateRoot, configRoot: paths.configRoot }
    await io.writeExclusive(paths.catalogPath, '{"schemaVersion":1,"entries":[]}\n')
    const content = { schemaVersion: 1 as const, dshHome: home, profile, resources, keyDigests }
    await io.writeExclusive(paths.receiptPath, JSON.stringify({ ...content, receiptDigest: hash(JSON.stringify(content)) }))
    for (const directory of [paths.keys, paths.stateRoot, paths.configRoot, paths.registryRoot, paths.root, parent]) await io.syncDirectory(directory)
    return await inspect(home, profile, signal)
  } catch (error) {
    const current = await lstat(paths.root).catch(() => undefined)
    if (current?.isDirectory() && current.dev === claimed.dev && current.ino === claimed.ino) await rm(paths.root, { recursive: true, force: true })
    await io.syncDirectory(parent)
    throw error
  }
}
