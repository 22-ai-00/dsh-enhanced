import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type { RsiLinuxSourceBuildPreparation } from './rsi-linux-source-build.js'
import {
  openLinuxRsiNativeRelocatedFamily, relocateLinuxRsiNativeFamily,
  type LinuxRsiNativeRelocatedFamily, type LinuxRsiNativeRelocationProof,
} from './rsi-linux-native-relocation.js'

/** Compose the relocation primitive into the stage seam the owner-program
 * transaction needs: move the five Linux-native families from a candidate Home
 * into the staged Home, then hand back the typed build environments, the
 * prepared source build and the creation-receipt digests the caller compares
 * against the candidate preparation.
 *
 * This runs strictly before the rename(2) cutover, so it never calls the stock
 * readers (`readLinuxRsiRuntime`, `readLinuxRsiRepositoryRuntime`,
 * `readLinuxRsiCreationBuildEnvironment`, `readRsiReleaseBuildEnvironment`):
 * they probe the host or the logical Home and only accept a Home at its final
 * path. The relocation proof itself is the pre-cutover acceptance gate; the
 * stock readers remain the post-cutover acceptance test.
 *
 * The seam is replayable. A caller that already relocated this pair of Homes in
 * an earlier process passes the sealed proof back in; the proof is re-verified
 * against the staged Home instead of relocating a second time (a second
 * relocation would fail on the existing destinations).
 *
 * When the caller is staging an in-place cutover, the logical Home is the live
 * Home and already exists; `existingLogicalHome` attests that fact so the
 * relocation stages beside it instead of refusing an occupied Home. The staged
 * receipts still record the logical Home and the sealed proof is unchanged.
 *
 * It never cleans up. On any failure — including a crash or abort after the
 * first copy — the staged Home holds an unsealed partial relocation and the
 * sealed proof is gone, so a retry without that proof fails closed on the
 * occupied destinations. The caller owns `stagePhysicalHome` as a disposable
 * directory and must delete and recreate it before retrying. */

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024
const stamp = (info: Stats): string => JSON.stringify([info.dev, info.ino, info.uid, info.mode, info.size,
  info.mtimeMs, info.ctimeMs])

function fail(message: string): never { throw new Error(`rsi Linux native materialize: ${message}`) }

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function canonicalHome(value: string, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value) || value === '/'
    || [...value].some(character => character.charCodeAt(0) < 32)) fail(`invalid ${name}`)
  return value
}

function overlap(first: string, second: string): boolean {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`)
}

function identity(input: LinuxRsiNativeMaterializeInput): void {
  const candidateHome = canonicalHome(input.candidateHome, 'candidate Home')
  const stagePhysicalHome = canonicalHome(input.stagePhysicalHome, 'staged Home')
  const logicalHome = canonicalHome(input.logicalHome, 'logical Home')
  if (input.existingLogicalHome !== undefined) {
    canonicalHome(input.existingLogicalHome, 'existing logical Home')
    if (input.existingLogicalHome !== logicalHome) fail('existing logical Home is not this logical Home')
  }
  if (typeof input.profile !== 'string' || !PROFILE.test(input.profile)) fail('invalid profile')
  if (overlap(candidateHome, stagePhysicalHome) || overlap(candidateHome, logicalHome)
    || overlap(stagePhysicalHome, logicalHome)) fail('candidate, staged and logical Homes must be disjoint')
}

interface Receipt { path: string; bytes: Uint8Array; sha256: string }

/** Read one receipt exactly once, requiring the same owner-private, single-link,
 * no-symlink shape the stock readers accept. Hashing and parsing the same buffer
 * keeps the recorded digest bound to the parsed program identity. */
async function readReceipt(path: string): Promise<Receipt> {
  let info: Stats
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(`missing creation receipt: ${path}`)
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_RECEIPT_BYTES
    || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size === 0) {
    fail(`unsafe creation receipt: ${path}`)
  }
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (stamp(await fd.stat()) !== stamp(info)) fail(`creation receipt changed: ${path}`)
    const bytes = await fd.readFile()
    if (bytes.byteLength !== info.size || stamp(await fd.stat()) !== stamp(info)
      || stamp(await lstat(path)) !== stamp(info)) fail(`creation receipt changed: ${path}`)
    return { path, bytes, sha256: sha256(bytes) }
  } finally { await fd.close() }
}

async function receiptSha256(path: string): Promise<string> { return (await readReceipt(path)).sha256 }

/** The candidate receipt names the program being staged; reject a mismatch
 * before spending minutes on the relocation copy. */
function candidateReceipt(bytes: Uint8Array, path: string, home: string, profile: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { fail(`invalid creation receipt: ${path}`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`invalid creation receipt: ${path}`)
  const receipt = parsed as Record<string, unknown>
  if (receipt.schemaVersion !== 3 || receipt.backend !== 'linux-native'
    || receipt.dshHome !== home || receipt.profile !== profile) fail(`candidate creation receipt differs: ${path}`)
}

interface CandidateReceipt { path: string; sha256: string; sourceCommit: string }

async function readCandidateReceipt(home: string, profile: string): Promise<CandidateReceipt> {
  const path = join(home, 'rsi-linux-creation-builds', profile, 'bootstrap.json')
  const receipt = await readReceipt(path)
  candidateReceipt(receipt.bytes, path, home, profile)
  const record = JSON.parse(Buffer.from(receipt.bytes).toString('utf8')) as Record<string, unknown>
  if (typeof record.sourceCommit !== 'string' || !COMMIT.test(record.sourceCommit)) {
    fail(`candidate creation receipt lacks a source commit: ${path}`)
  }
  return { path, sha256: receipt.sha256, sourceCommit: record.sourceCommit }
}

export interface LinuxRsiNativeMaterializeInput {
  /** Home holding the freshly prepared candidate families. */
  candidateHome: string
  /** Private staged Home that will be renamed onto `logicalHome` later. */
  stagePhysicalHome: string
  /** Absolute path the staged Home will occupy after the cutover. */
  logicalHome: string
  /** Set when that path is already occupied by the live Home being cut over
   * in place (the Docker -> Linux-native staging case). It must equal
   * `logicalHome`; the relocation then stages beside the live Home instead of
   * refusing an occupied logical Home. Replay ignores it. */
  existingLogicalHome?: string
  profile: string
  /** Sealed proof from an earlier run over the same Homes, when replaying. */
  relocation?: LinuxRsiNativeRelocationProof
  signal?: AbortSignal
}

export interface LinuxRsiNativeMaterializeOutput {
  relocation: LinuxRsiNativeRelocationProof
  family: LinuxRsiNativeRelocatedFamily
  sourceBuild: RsiLinuxSourceBuildPreparation
  /** Digest of the candidate Home's creation receipt, for equality with the
   * digest the owner-program preparation recorded. */
  candidateReceiptSha256: string
  /** Digest of the staged creation receipt, recorded in the transaction. */
  receiptSha256: string
}

export async function materializeLinuxRsiNativeInStage(
  input: LinuxRsiNativeMaterializeInput): Promise<LinuxRsiNativeMaterializeOutput> {
  identity(input)
  input.signal?.throwIfAborted()
  const { candidateHome, stagePhysicalHome, logicalHome, profile } = input

  const candidate = await readCandidateReceipt(candidateHome, profile)
  input.signal?.throwIfAborted()

  let relocation = input.relocation
  if (relocation === undefined) {
    relocation = await relocateLinuxRsiNativeFamily({ sourceHome: candidateHome, physicalHome: stagePhysicalHome,
      logicalHome, profile, ...(input.existingLogicalHome === undefined
        ? {} : { existingLogicalHome: input.existingLogicalHome }),
      ...(input.signal === undefined ? {} : { signal: input.signal }) })
  } else {
    proofIdentity(relocation, input)
  }

  const family = await openLinuxRsiNativeRelocatedFamily(relocation)
  input.signal?.throwIfAborted()
  if (family.runtime.sourceCommit !== candidate.sourceCommit) fail('staged program differs from candidate')

  const receipt = await receiptSha256(join(stagePhysicalHome, 'rsi-linux-creation-builds', profile, 'bootstrap.json'))
  return {
    relocation,
    family,
    sourceBuild: { backend: 'linux-native', repository: family.repository, cgroupRoots: family.creationBuild.cgroupRoots },
    candidateReceiptSha256: candidate.sha256,
    receiptSha256: receipt,
  }
}

function proofIdentity(proof: LinuxRsiNativeRelocationProof, input: LinuxRsiNativeMaterializeInput): void {
  const record = proof as unknown as Record<string, unknown>
  if (record.schemaVersion !== 1 || record.backend !== 'linux-native') fail('invalid replay relocation proof')
  if (record.sourceHome !== input.candidateHome || record.physicalHome !== input.stagePhysicalHome
    || record.logicalHome !== input.logicalHome || record.profile !== input.profile) {
    fail('replay relocation proof does not describe this Home pair')
  }
}
