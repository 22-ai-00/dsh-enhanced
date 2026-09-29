import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { rsiBuildResources as io } from './rsi-build.js'
import { rsiCoordinatorProfile } from './rsi-install.js'
import type { InstalledRsiDsh } from './rsi-install-inputs.js'
import { readRsiLocalCohort, verifyRsiLocalInstalledPackages, rsiLocalPeerOverrides, type RsiLocalCohort } from './rsi-local-cohort.js'
import { installRsiLocalProfile } from './rsi-local-install.js'
import { assertRsiLocalProfileRoots, rebaseRsiLocalProfileWorkspace } from './rsi-local-profile-update.js'

const coordinatorBundles = ['assistant-policy', 'assistant-automations', 'plugin-control-plane']
const hash = (source: string | Buffer): string => createHash('sha256').update(source).digest('hex')
function fail(message: string): never { throw new Error(`rsi local pair install: ${message}`) }
export interface RsiLocalSinglePackageProof {
  schemaVersion: 1
  profile: string
  cohortDigest: string
  files: Record<string, string>
}
export interface RsiLocalPairPackageProof extends RsiLocalSinglePackageProof {
  coordinatorProfile: string
}
export interface RsiLocalPairPackagePorts {
  install: typeof installRsiLocalProfile
  verify: typeof verifyRsiLocalInstalledPackages
}
const ports: RsiLocalPairPackagePorts = { install: installRsiLocalProfile, verify: verifyRsiLocalInstalledPackages }

async function replace(path: string, before: Buffer, after: string): Promise<void> {
  const temporary = `${path}.rsi-update-${randomUUID()}`
  try {
    await io.writeExclusive(temporary, after)
    if (!(await io.readStable(path, 2_097_152)).equals(before)) fail(`file changed before replacement: ${path}`)
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  }
}

/** Run only inside the lifecycle sandbox mapping a disposable stopped Home to
 * its canonical logical path. The caller holds the Home lock, has authenticated
 * originalCohort, and has staged candidate resources. This helper neither
 * establishes that isolation nor switches services. A failed install leaves the
 * stage for outer recovery/discard; it never reports a partial pair as success. */
interface RsiLocalPackageInput {
  dshHome: string; profile: string; originalCohort: RsiLocalCohort
  dsh: Pick<InstalledRsiDsh, 'path' | 'pin'>; signal: AbortSignal
}

export async function stageRsiLocalPairPackages(input: RsiLocalPackageInput,
  dependencies: RsiLocalPairPackagePorts = ports): Promise<RsiLocalPairPackageProof> {
  return { ...await stageRsiLocalPackages(input, dependencies, true), coordinatorProfile: rsiCoordinatorProfile(input.profile) }
}

/** Package-only step for an explicitly verified pre-owner installation. The
 * outer transaction must also prove the absence of owner authority, stage signed
 * source maintenance and own stop/copy/switch/recovery. Never splits an existing
 * coordinator pair, even if its receipt or profile has been partly removed. */
export async function stageRsiLocalSinglePackages(input: RsiLocalPackageInput,
  dependencies: RsiLocalPairPackagePorts = ports): Promise<RsiLocalSinglePackageProof> {
  return stageRsiLocalPackages(input, dependencies, false)
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}

async function stageRsiLocalPackages(input: RsiLocalPackageInput,
  dependencies: RsiLocalPairPackagePorts, paired: boolean): Promise<RsiLocalSinglePackageProof> {
  const { dshHome, profile, originalCohort, signal } = input
  signal.throwIfAborted()
  if (await realpath(dshHome) !== dshHome) fail('Home is not canonical')
  const coordinatorProfile = rsiCoordinatorProfile(profile)
  const candidate = await readRsiLocalCohort({ dshHome, profile })
  const receiptPath = join(dshHome, `.rsi-coordinator-${hash(profile).slice(0, 16)}.json`)
  const assertSingle = async (): Promise<void> => {
    if (!await absent(receiptPath) || !await absent(join(dshHome, 'profiles', coordinatorProfile))) {
      fail('single-profile update cannot split an existing or incomplete coordinator pair')
    }
  }
  if (!paired) await assertSingle()
  const receiptSource = paired ? await io.readStable(receiptPath, 65_536, true) : undefined
  const receipt = { schemaVersion: 1, targetProfile: profile, coordinatorProfile,
    version: originalCohort.version, sourceRepository: originalCohort.sourceRepository }
  if (receiptSource && !isDeepStrictEqual(JSON.parse(receiptSource.toString('utf8')), receipt)) fail('coordinator receipt differs')
  const nextReceipt = JSON.stringify({ ...receipt, version: candidate.version })
  const snapshots = []
  const profiles: readonly (readonly [string, readonly string[]])[] = paired
    ? [[profile, originalCohort.bundles], [coordinatorProfile, coordinatorBundles]]
    : [[profile, originalCohort.bundles]]
  for (const [name, bundles] of profiles) {
    signal.throwIfAborted()
    const root = join(dshHome, 'profiles', name)
    await io.directory(root, false)
    const read = async (name: string): Promise<Buffer> => {
      const path = join(root, name)
      if (await realpath(path) !== path) fail(`profile metadata is not physical: ${path}`)
      return io.readStable(path, 2_097_152)
    }
    const manifest = await read('package.json'), patch = await read('cordis.patch.yml')
    const workspace = await read('pnpm-workspace.yaml')
    assertRsiLocalProfileRoots({ source: manifest.toString('utf8'), cohort: originalCohort, bundles })
    const nextWorkspace = rebaseRsiLocalProfileWorkspace({ source: workspace.toString('utf8'), original: originalCohort, candidate, bundles,
      originalPeers: await rsiLocalPeerOverrides({ cohort: originalCohort, bundles, profilePath: root }),
      candidatePeers: await rsiLocalPeerOverrides({ cohort: candidate, bundles }) })
    await dependencies.verify({ cohort: originalCohort, profilePath: root, bundles: [...bundles] })
    snapshots.push({ name, root, bundles, manifest, patch, workspace, nextWorkspace })
  }
  // All old package inventories and both configurations must pass before the
  // first write or package-manager invocation.
  if (receiptSource && !(await io.readStable(receiptPath, 65_536, true)).equals(receiptSource)) fail('coordinator receipt changed')
  if (!paired) await assertSingle()
  for (const snapshot of snapshots) for (const [name, expected] of [
    ['package.json', snapshot.manifest], ['cordis.patch.yml', snapshot.patch], ['pnpm-workspace.yaml', snapshot.workspace],
  ] as const) if (!(await io.readStable(join(snapshot.root, name), 2_097_152)).equals(expected)) fail(`profile changed before installation: ${snapshot.name}`)
  for (const snapshot of snapshots) {
    signal.throwIfAborted()
    await replace(join(snapshot.root, 'pnpm-workspace.yaml'), snapshot.workspace, snapshot.nextWorkspace)
    await io.syncDirectory(snapshot.root)
    await dependencies.install({ dshHome, profile: snapshot.name, cohort: candidate,
      bundles: snapshot.bundles, dsh: input.dsh, signal })
  }
  const files: Record<string, string> = {}
  for (const snapshot of snapshots) {
    signal.throwIfAborted()
    await dependencies.verify({ cohort: candidate, profilePath: snapshot.root, bundles: [...snapshot.bundles] })
    const manifest = await io.readStable(join(snapshot.root, 'package.json'), 2_097_152)
    // Tarball locators are stable logical Home paths. Adding the same roots
    // must not change any owner manifest setting, including native bundle rows.
    if (!isDeepStrictEqual(JSON.parse(manifest.toString('utf8')), JSON.parse(snapshot.manifest.toString('utf8')))) fail(`owner manifest changed: ${snapshot.name}`)
    assertRsiLocalProfileRoots({ source: manifest.toString('utf8'), cohort: candidate, bundles: snapshot.bundles })
    const patch = await io.readStable(join(snapshot.root, 'cordis.patch.yml'), 2_097_152)
    const workspace = await io.readStable(join(snapshot.root, 'pnpm-workspace.yaml'), 2_097_152)
    if (!patch.equals(snapshot.patch) || workspace.toString('utf8') !== snapshot.nextWorkspace) fail(`owner patch or workspace changed: ${snapshot.name}`)
    for (const [name, source] of [['package.json', manifest], ['cordis.patch.yml', patch], ['pnpm-workspace.yaml', workspace]] as const) files[join(snapshot.root, name)] = hash(source)
    files[join(snapshot.root, 'pnpm-lock.yaml')] = hash(await io.readStable(join(snapshot.root, 'pnpm-lock.yaml'), 16_777_216))
  }
  if (!isDeepStrictEqual(await readRsiLocalCohort({ dshHome, profile }), candidate)) fail('candidate cohort changed')
  signal.throwIfAborted()
  if (receiptSource) {
    await replace(receiptPath, receiptSource, nextReceipt)
    await io.syncDirectory(dshHome)
    files[receiptPath] = hash(nextReceipt)
  } else await assertSingle()
  return { schemaVersion: 1, profile, cohortDigest: candidate.receiptDigest, files }
}
