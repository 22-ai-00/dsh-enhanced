import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { benchmarkPlanDigest, benchmarkResultParser, benchmarkSchedule, benchmarkSnapshot, parseBenchmarkMetrics, parseBenchmarkPlan } from './schema.js'
import { holdoutEnvelopeDigest, type SignedHoldoutFinish, type SignedHoldoutManifest, type SignedHoldoutVerdict } from './holdout-protocol.js'
import type { BenchmarkCell, BenchmarkMetrics, BenchmarkPlan, BenchmarkResult, BenchmarkVersions } from './types.js'

export const HOLDOUT_EVIDENCE_PROTOCOL = 'dsh-benchmark/holdout-evidence/v1' as const
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024
const DIGEST = /^[a-f0-9]{64}$/u
const TEMPORARY = /^\.holdout-([a-f0-9]{64})-[A-Za-z0-9-]+\.tmp$/u

export interface HoldoutEvidenceVerifier {
  verifyManifest(envelope: unknown): Readonly<SignedHoldoutManifest>
  verifyVerdict(input: { envelope: unknown; manifest: Readonly<SignedHoldoutManifest>; planDigest: string; cell: Readonly<BenchmarkCell>; outputDigest: string }): Readonly<SignedHoldoutVerdict>
  verifyFinish(input: { envelope: unknown; manifest: Readonly<SignedHoldoutManifest>; planDigest: string; cells: readonly Readonly<BenchmarkCell>[]; verdictEnvelopeDigests: readonly string[] }): Readonly<SignedHoldoutFinish>
}
export interface HoldoutEvidenceStoreOptions { root: string; verifier: HoldoutEvidenceVerifier; create?: boolean }
export interface HoldoutEvidenceReference { digest: string; path: string; receiptDigest: string }
export interface HoldoutHostEvidence { versions: BenchmarkVersions; hostMetrics: BenchmarkMetrics; quiescent: boolean; executionEvidenceDigest: string; outputDigest: string }
export interface HoldoutManifestEvidence { protocol: typeof HOLDOUT_EVIDENCE_PROTOCOL; schemaVersion: 1; kind: 'manifest'; planDigest: string; receiptDigest: string; authority: { keyId: string }; envelope: Readonly<SignedHoldoutManifest> }
export interface HoldoutVerdictEvidence { protocol: typeof HOLDOUT_EVIDENCE_PROTOCOL; schemaVersion: 1; kind: 'verdict'; planDigest: string; manifestEvidenceDigest: string; cell: Readonly<BenchmarkCell>; inputDigest: string; acceptanceDigest: string; receiptDigest: string; authority: { keyId: string }; host: Readonly<HoldoutHostEvidence>; envelope: Readonly<SignedHoldoutVerdict> }
export interface HoldoutFinishEvidence { protocol: typeof HOLDOUT_EVIDENCE_PROTOCOL; schemaVersion: 1; kind: 'finish'; planDigest: string; manifestEvidenceDigest: string; verdictEvidenceDigests: readonly string[]; verdictEnvelopeDigests: readonly string[]; receiptDigest: string; authority: { keyId: string }; envelope: Readonly<SignedHoldoutFinish> }
export interface HoldoutPlanCompletion { protocol: typeof HOLDOUT_EVIDENCE_PROTOCOL; schemaVersion: 1; kind: 'plan-completion'; planDigest: string; manifestEvidenceDigest: string; verdictEvidenceDigests: readonly string[]; verdictEnvelopeDigests: readonly string[]; finishEvidenceDigest: string }
export interface HoldoutRunEvidence { completion: Readonly<HoldoutPlanCompletion>; manifest: Readonly<HoldoutManifestEvidence>; verdicts: readonly Readonly<HoldoutVerdictEvidence>[]; finish: Readonly<HoldoutFinishEvidence> }
export interface HoldoutManifestWrite { plan: BenchmarkPlan; manifest: unknown }
export interface HoldoutVerdictWrite extends HoldoutManifestWrite { cell: BenchmarkCell; outputDigest: string; host: HoldoutHostEvidence; envelope: unknown }
export interface HoldoutFinishWrite extends HoldoutManifestWrite { verdictEvidenceDigests: readonly string[]; envelope: unknown }

export class HoldoutEvidenceError extends Error {
  constructor(readonly code: 'invalid-path' | 'unsafe-root' | 'unsafe-file' | 'invalid-evidence' | 'conflict' | 'io') { super('holdout evidence: ' + code); this.name = 'HoldoutEvidenceError' }
}

interface AncestorIdentity { path: string; stat: BigIntStats }
interface SecureRoot { path: string; descriptor: number; stat: BigIntStats; uid: number; gid: number; ancestors: readonly AncestorIdentity[] }
function fail(code: HoldoutEvidenceError['code']): never { throw new HoldoutEvidenceError(code) }
function sameDirectory(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode }
function sameFile(left: BigIntStats, right: BigIntStats): boolean { return sameDirectory(left, right) && left.size === right.size && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs }
function hash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }
function assertDigest(value: unknown): asserts value is string { if (typeof value !== 'string' || !DIGEST.test(value)) fail('invalid-evidence') }
function same(left: unknown, right: unknown): boolean { return acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right) }
function frozen<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) frozen(child); Object.freeze(value) }; return value }
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid-evidence')
  const input = value as Record<string, unknown>, keys = Reflect.ownKeys(input)
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) fail('invalid-evidence')
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(input, key)!; if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-evidence') }
  return input
}
function snapshotObject(value: unknown, fields: readonly string[]): Record<string, unknown> { return exact(benchmarkSnapshot(value), fields) }

function inspectAncestors(path: string, uid: number, gid: number, privateLeaf: boolean): readonly AncestorIdentity[] {
  const entries: AncestorIdentity[] = []; let cursor = path, leaf = true
  for (;;) {
    let canonical: string, stat: BigIntStats
    try { canonical = realpathSync.native(cursor); stat = lstatSync(cursor, { bigint: true }) } catch { return fail('unsafe-root') }
    const mode = Number(stat.mode & 0o7777n), owner = Number(stat.uid), group = Number(stat.gid), stickyRoot = owner === 0 && (mode & 0o1000) !== 0 && (mode & 0o022) !== 0
    if (canonical !== cursor || stat.isSymbolicLink() || !stat.isDirectory() || !stickyRoot && (mode & 0o022) !== 0 || leaf && privateLeaf && (owner !== uid || group !== gid || mode !== 0o700)) fail('unsafe-root')
    entries.push({ path: cursor, stat }); const parent = dirname(cursor)
    if (parent === cursor) return Object.freeze(entries)
    cursor = parent; leaf = false
  }
}
function sameAncestors(expected: readonly AncestorIdentity[], uid: number, gid: number, privateLeaf: boolean): void {
  const actual = inspectAncestors(expected[0]!.path, uid, gid, privateLeaf)
  if (actual.length !== expected.length || actual.some((entry, index) => entry.path !== expected[index]!.path || !sameDirectory(entry.stat, expected[index]!.stat))) fail('unsafe-root')
}
function openRoot(path: string, create: boolean): SecureRoot {
  if (process.platform !== 'linux' || !isAbsolute(path) || resolve(path) !== path || path === '/' || /[\p{Cc}]/u.test(path)) fail('invalid-path')
  const uid = process.geteuid?.(), gid = process.getegid?.(); if (uid === undefined || gid === undefined) fail('unsafe-root')
  const parentPath = dirname(path), parentBefore = inspectAncestors(parentPath, uid, gid, false)
  if (!existsSync(path)) { if (!create) fail('unsafe-root'); try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail('io') } }
  sameAncestors(parentBefore, uid, gid, false)
  const ancestors = inspectAncestors(path, uid, gid, true); let descriptor: number | undefined
  try {
    const before = lstatSync(path, { bigint: true }); descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor, { bigint: true }), after = lstatSync(path, { bigint: true })
    if (!sameDirectory(ancestors[0]!.stat, opened) || !sameDirectory(before, opened) || !sameDirectory(opened, after) || !opened.isDirectory()) fail('unsafe-root')
    sameAncestors(ancestors, uid, gid, true)
    const root = { path, descriptor, stat: opened, uid, gid, ancestors }; descriptor = undefined; return root
  } catch (error) { if (error instanceof HoldoutEvidenceError) throw error; return fail('unsafe-root') }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
function stillRoot(root: SecureRoot): void {
  try { sameAncestors(root.ancestors, root.uid, root.gid, true); const opened = fstatSync(root.descriptor, { bigint: true }), visible = lstatSync(root.path, { bigint: true }); if (!sameDirectory(root.stat, opened) || !sameDirectory(opened, visible)) fail('unsafe-root') }
  catch (error) { if (error instanceof HoldoutEvidenceError) throw error; fail('unsafe-root') }
}
function anchored(root: SecureRoot, name: string): string { return '/proc/self/fd/' + root.descriptor + '/' + name }
function evidenceName(digest: string): string { assertDigest(digest); return digest + '.json' }
function markerName(planDigest: string): string { assertDigest(planDigest); return 'plan-' + planDigest + '.json' }
function openFile(root: SecureRoot, name: string): { descriptor: number; stat: BigIntStats } {
  stillRoot(root); let descriptor: number | undefined
  try {
    descriptor = openSync(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(descriptor, { bigint: true }), visible = lstatSync(join(root.path, name), { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.uid !== BigInt(root.uid) || opened.gid !== BigInt(root.gid) || Number(opened.mode & 0o7777n) !== 0o600 || opened.size < 1n || opened.size > BigInt(MAX_EVIDENCE_BYTES) || !sameFile(opened, visible)) fail('unsafe-file')
    const result = { descriptor, stat: opened }; descriptor = undefined; return result
  } catch (error) { if (error instanceof HoldoutEvidenceError) throw error; return fail('unsafe-file') }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
function readObject(root: SecureRoot, name: string, expectedDigest?: string): unknown {
  const opened = openFile(root, name)
  try {
    const bytes = readFileSync(opened.descriptor), after = fstatSync(opened.descriptor, { bigint: true }), linked = lstatSync(anchored(root, name), { bigint: true })
    if (bytes.length !== Number(opened.stat.size) || !sameFile(opened.stat, after) || !sameFile(after, linked) || expectedDigest !== undefined && hash(bytes) !== expectedDigest) fail('invalid-evidence')
    const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes) || !text.endsWith('\n') || text.includes('\r')) fail('invalid-evidence')
    let object: unknown; try { object = JSON.parse(text.slice(0, -1)) } catch { return fail('invalid-evidence') }
    if (acceptanceCanonicalJson(object) + '\n' !== text) fail('invalid-evidence'); stillRoot(root); return object
  } finally { closeSync(opened.descriptor) }
}

function recoverTemporary(root: SecureRoot): void {
  stillRoot(root); let changed = false
  for (const name of readdirSync(anchored(root, '.'))) {
    const match = TEMPORARY.exec(name); if (!match) continue
    const temporary = lstatSync(anchored(root, name), { bigint: true })
    if (!temporary.isFile() || temporary.uid !== BigInt(root.uid) || temporary.gid !== BigInt(root.gid) || Number(temporary.mode & 0o7777n) !== 0o600 || ![1n, 2n].includes(temporary.nlink)) fail('unsafe-file')
    if (temporary.nlink === 2n) {
      const linked = readdirSync(anchored(root, '.')).filter(candidate => candidate !== name).flatMap(candidate => { try { const stat = lstatSync(anchored(root, candidate), { bigint: true }); return sameFile(temporary, stat) ? [candidate] : [] } catch { return [] } })
      if (linked.length !== 1 || !(/^[a-f0-9]{64}\.json$/u.test(linked[0]!) || /^plan-[a-f0-9]{64}\.json$/u.test(linked[0]!))) fail('unsafe-file')
    }
    unlinkSync(anchored(root, name)); changed = true
  }
  if (changed) fsyncSync(root.descriptor); stillRoot(root)
}
function publishNamed(root: SecureRoot, name: string, object: unknown): string {
  const content = acceptanceCanonicalJson(object) + '\n', bytes = Buffer.from(content)
  if (bytes.length > MAX_EVIDENCE_BYTES) fail('invalid-evidence')
  stillRoot(root)
  try {
    lstatSync(anchored(root, name), { bigint: true })
    if (!same(readObject(root, name), object)) fail('conflict')
    return join(root.path, name)
  } catch (error) {
    if (error instanceof HoldoutEvidenceError || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    stillRoot(root)
  }
  const digest = hash(bytes), temporaryName = '.holdout-' + digest + '-' + randomUUID() + '.tmp', temporary = anchored(root, temporaryName), final = anchored(root, name)
  let descriptor: number | undefined
  try {
    stillRoot(root); descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    writeFileSync(descriptor, bytes); fsyncSync(descriptor)
    const staged = fstatSync(descriptor, { bigint: true }), visibleTemporary = lstatSync(temporary, { bigint: true })
    if (!sameFile(staged, visibleTemporary) || staged.nlink !== 1n || staged.uid !== BigInt(root.uid) || staged.gid !== BigInt(root.gid) || Number(staged.mode & 0o7777n) !== 0o600) fail('unsafe-file')
    let linked = false
    try { linkSync(temporary, final); linked = true; fsyncSync(root.descriptor) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!same(readObject(root, name), object)) fail('conflict')
      closeSync(descriptor); descriptor = undefined; unlinkSync(temporary); fsyncSync(root.descriptor); stillRoot(root); return join(root.path, name)
    }
    if (linked) { const temporaryAfter = lstatSync(temporary, { bigint: true }), finalAfter = lstatSync(final, { bigint: true }); if (!sameFile(temporaryAfter, finalAfter) || temporaryAfter.nlink !== 2n) fail('unsafe-file') }
    unlinkSync(temporary); fsyncSync(root.descriptor)
    const openedAfter = fstatSync(descriptor, { bigint: true }), published = lstatSync(final, { bigint: true })
    if (!sameFile(openedAfter, published) || !published.isFile() || published.nlink !== 1n || Number(published.mode & 0o7777n) !== 0o600) fail('unsafe-file')
    closeSync(descriptor); descriptor = undefined
    stillRoot(root); return join(root.path, name)
  } catch (error) { if (error instanceof HoldoutEvidenceError) throw error; return fail('io') }
  finally { if (descriptor !== undefined) closeSync(descriptor); try { unlinkSync(temporary) } catch {} }
}
function publish(root: SecureRoot, object: HoldoutManifestEvidence | HoldoutVerdictEvidence | HoldoutFinishEvidence): HoldoutEvidenceReference {
  const content = acceptanceCanonicalJson(object) + '\n', digest = hash(content), path = publishNamed(root, evidenceName(digest), object)
  if (!same(readObject(root, evidenceName(digest), digest), object)) fail('conflict')
  return Object.freeze({ digest, path, receiptDigest: object.receiptDigest })
}
function scheduledCell(plan: Readonly<BenchmarkPlan>, cell: BenchmarkCell): Readonly<BenchmarkCell> { const copy = benchmarkSnapshot(cell), expected = benchmarkSchedule(plan).find(item => same(item, copy)); if (!expected) fail('invalid-evidence'); return expected }
function safeVerify<T>(operation: () => T): T { try { return operation() } catch { return fail('invalid-evidence') } }
function safeManifest(verifier: HoldoutEvidenceVerifier, value: unknown): Readonly<SignedHoldoutManifest> {
  return frozen(snapshotObject(safeVerify(() => verifier.verifyManifest(value)), ['protocol', 'kind', 'manifestId', 'authorityKeyId', 'dataset', 'cases', 'issuedAt', 'signature']) as unknown as SignedHoldoutManifest)
}
function safeVerdict(verifier: HoldoutEvidenceVerifier, input: Parameters<HoldoutEvidenceVerifier['verifyVerdict']>[0]): Readonly<SignedHoldoutVerdict> {
  return frozen(snapshotObject(safeVerify(() => verifier.verifyVerdict(input)), ['protocol', 'kind', 'authorityKeyId', 'manifestDigest', 'planDigest', 'cell', 'inputDigest', 'acceptanceDigest', 'outputDigest', 'verdict', 'evaluatedAt', 'signature']) as unknown as SignedHoldoutVerdict)
}
function safeFinish(verifier: HoldoutEvidenceVerifier, input: Parameters<HoldoutEvidenceVerifier['verifyFinish']>[0]): Readonly<SignedHoldoutFinish> {
  return frozen(snapshotObject(safeVerify(() => verifier.verifyFinish(input)), ['protocol', 'kind', 'authorityKeyId', 'manifestDigest', 'planDigest', 'cellCount', 'verdictsDigest', 'complete', 'finalizedAt', 'signature']) as unknown as SignedHoldoutFinish)
}
function hostEvidence(value: unknown, plan: Readonly<BenchmarkPlan>, cell: Readonly<BenchmarkCell>, outputDigest: string): Readonly<HoldoutHostEvidence> {
  const input = snapshotObject(value, ['versions', 'hostMetrics', 'quiescent', 'executionEvidenceDigest', 'outputDigest']), variant = plan.variants.find(item => item.id === cell.variantId)
  assertDigest(input.executionEvidenceDigest); assertDigest(input.outputDigest)
  if (!variant || !same(input.versions, variant.versions) || input.quiescent !== true || input.outputDigest !== outputDigest) fail('invalid-evidence')
  const hostMetrics = parseBenchmarkMetrics(input.hostMetrics)
  if (hostMetrics.inputTokens === null || hostMetrics.outputTokens === null || hostMetrics.toolCalls === null || hostMetrics.latencyMs !== null
    || hostMetrics.inputTokens > plan.budget.inputTokens || hostMetrics.outputTokens > plan.budget.outputTokens || hostMetrics.toolCalls > plan.budget.toolCalls
    || plan.budget.costUsdMicros !== null && (hostMetrics.costUsdMicros === null || hostMetrics.costUsdMicros > plan.budget.costUsdMicros)) fail('invalid-evidence')
  return frozen({ versions: variant.versions, hostMetrics, quiescent: true, executionEvidenceDigest: input.executionEvidenceDigest, outputDigest })
}

export class HoldoutEvidenceStore {
  readonly #root: SecureRoot
  readonly #verifier: HoldoutEvidenceVerifier
  #closed = false
  constructor(options: HoldoutEvidenceStoreOptions) {
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['root', 'verifier', 'create'].includes(key)) || typeof options.verifier?.verifyManifest !== 'function' || typeof options.verifier?.verifyVerdict !== 'function' || typeof options.verifier?.verifyFinish !== 'function') fail('invalid-evidence')
    this.#root = openRoot(options.root, options.create !== false); this.#verifier = options.verifier
    try { recoverTemporary(this.#root) } catch (error) { closeSync(this.#root.descriptor); throw error }
  }
  #open(): void { if (this.#closed) fail('io'); stillRoot(this.#root) }
  #manifest(plan: Readonly<BenchmarkPlan>, value: unknown): Readonly<SignedHoldoutManifest> {
    const manifest = safeManifest(this.#verifier, value)
    if (plan.dataset.split !== 'holdout' || !same(manifest.dataset, plan.dataset) || !same(manifest.cases, plan.cases)) fail('invalid-evidence')
    return manifest
  }
  writeManifest(input: HoldoutManifestWrite): HoldoutEvidenceReference {
    this.#open(); const raw = snapshotObject(input, ['plan', 'manifest']), plan = parseBenchmarkPlan(raw.plan as BenchmarkPlan), manifest = this.#manifest(plan, raw.manifest), planDigest = benchmarkPlanDigest(plan), receiptDigest = holdoutEnvelopeDigest(manifest)
    return publish(this.#root, frozen({ protocol: HOLDOUT_EVIDENCE_PROTOCOL, schemaVersion: 1, kind: 'manifest', planDigest, receiptDigest, authority: { keyId: manifest.authorityKeyId }, envelope: manifest }))
  }
  readManifest(planInput: BenchmarkPlan, digest: string): Readonly<HoldoutManifestEvidence> {
    this.#open(); assertDigest(digest); const object = snapshotObject(readObject(this.#root, evidenceName(digest), digest), ['protocol', 'schemaVersion', 'kind', 'planDigest', 'receiptDigest', 'authority', 'envelope']), plan = parseBenchmarkPlan(planInput), planDigest = benchmarkPlanDigest(plan)
    if (object.protocol !== HOLDOUT_EVIDENCE_PROTOCOL || object.schemaVersion !== 1 || object.kind !== 'manifest' || object.planDigest !== planDigest) fail('invalid-evidence')
    const manifest = this.#manifest(plan, object.envelope), receiptDigest = holdoutEnvelopeDigest(manifest), authority = exact(object.authority, ['keyId'])
    if (object.receiptDigest !== receiptDigest || authority.keyId !== manifest.authorityKeyId || !same(object.envelope, manifest)) fail('invalid-evidence')
    return frozen({ protocol: HOLDOUT_EVIDENCE_PROTOCOL, schemaVersion: 1, kind: 'manifest', planDigest, receiptDigest, authority: { keyId: manifest.authorityKeyId }, envelope: manifest })
  }
  writeVerdict(input: HoldoutVerdictWrite): HoldoutEvidenceReference {
    this.#open(); const raw = snapshotObject(input, ['plan', 'manifest', 'cell', 'outputDigest', 'host', 'envelope']), plan = parseBenchmarkPlan(raw.plan as BenchmarkPlan), planDigest = benchmarkPlanDigest(plan), cell = scheduledCell(plan, raw.cell as BenchmarkCell)
    assertDigest(raw.outputDigest); const manifest = this.#manifest(plan, raw.manifest), host = hostEvidence(raw.host, plan, cell, raw.outputDigest)
    const envelope = safeVerdict(this.#verifier, { envelope: raw.envelope, manifest, planDigest, cell, outputDigest: raw.outputDigest })
    if (envelope.planDigest !== planDigest || envelope.outputDigest !== raw.outputDigest || !same(envelope.cell, cell)) fail('invalid-evidence')
    const manifestReference = this.writeManifest({ plan, manifest })
    const receiptDigest = holdoutEnvelopeDigest(envelope)
    return publish(this.#root, frozen({ protocol: HOLDOUT_EVIDENCE_PROTOCOL, schemaVersion: 1, kind: 'verdict', planDigest, manifestEvidenceDigest: manifestReference.digest, cell, inputDigest: envelope.inputDigest, acceptanceDigest: envelope.acceptanceDigest, receiptDigest, authority: { keyId: envelope.authorityKeyId }, host, envelope }))
  }
  #readVerdict(plan: Readonly<BenchmarkPlan>, cell: Readonly<BenchmarkCell>, digest: string): Readonly<HoldoutVerdictEvidence> {
    assertDigest(digest); const object = snapshotObject(readObject(this.#root, evidenceName(digest), digest), ['protocol', 'schemaVersion', 'kind', 'planDigest', 'manifestEvidenceDigest', 'cell', 'inputDigest', 'acceptanceDigest', 'receiptDigest', 'authority', 'host', 'envelope']), planDigest = benchmarkPlanDigest(plan)
    if (object.protocol !== HOLDOUT_EVIDENCE_PROTOCOL || object.schemaVersion !== 1 || object.kind !== 'verdict' || object.planDigest !== planDigest || !same(object.cell, cell)) fail('invalid-evidence')
    assertDigest(object.manifestEvidenceDigest); const manifest = this.readManifest(plan, object.manifestEvidenceDigest).envelope
    const storedEnvelope = benchmarkSnapshot(object.envelope) as SignedHoldoutVerdict, host = hostEvidence(object.host, plan, cell, storedEnvelope.outputDigest)
    const envelope = safeVerdict(this.#verifier, { envelope: storedEnvelope, manifest, planDigest, cell, outputDigest: host.outputDigest }), receiptDigest = holdoutEnvelopeDigest(envelope), authority = exact(object.authority, ['keyId'])
    if (object.inputDigest !== envelope.inputDigest || object.acceptanceDigest !== envelope.acceptanceDigest || object.receiptDigest !== receiptDigest || authority.keyId !== envelope.authorityKeyId || !same(storedEnvelope, envelope)) fail('invalid-evidence')
    return frozen({ protocol: HOLDOUT_EVIDENCE_PROTOCOL, schemaVersion: 1, kind: 'verdict', planDigest, manifestEvidenceDigest: object.manifestEvidenceDigest, cell, inputDigest: envelope.inputDigest, acceptanceDigest: envelope.acceptanceDigest, receiptDigest, authority: { keyId: envelope.authorityKeyId }, host, envelope })
  }
  readVerdict(planInput: BenchmarkPlan, cellInput: BenchmarkCell, digest: string): Readonly<HoldoutVerdictEvidence> { this.#open(); const plan = parseBenchmarkPlan(planInput), cell = scheduledCell(plan, cellInput); return this.#readVerdict(plan, cell, digest) }
  writeFinish(input: HoldoutFinishWrite): HoldoutEvidenceReference {
    this.#open(); const raw = snapshotObject(input, ['plan', 'manifest', 'verdictEvidenceDigests', 'envelope']), plan = parseBenchmarkPlan(raw.plan as BenchmarkPlan), planDigest = benchmarkPlanDigest(plan), cells = benchmarkSchedule(plan)
    if (!Array.isArray(raw.verdictEvidenceDigests) || raw.verdictEvidenceDigests.length > cells.length) fail('invalid-evidence')
    const verdictEvidenceDigests = Object.freeze(raw.verdictEvidenceDigests.map(item => { assertDigest(item); return item })), manifestReference = this.writeManifest({ plan, manifest: raw.manifest }), manifest = this.readManifest(plan, manifestReference.digest).envelope
    const verdictEnvelopeDigests = Object.freeze(verdictEvidenceDigests.map((item, index) => this.#readVerdict(plan, cells[index] ?? fail('invalid-evidence'), item).receiptDigest))
    const envelope = safeFinish(this.#verifier, { envelope: raw.envelope, manifest, planDigest, cells, verdictEnvelopeDigests }), receiptDigest = holdoutEnvelopeDigest(envelope)
    if (!envelope.complete || envelope.cellCount !== cells.length || verdictEvidenceDigests.length !== cells.length) fail('invalid-evidence')
    const evidence = frozen({ protocol: HOLDOUT_EVIDENCE_PROTOCOL, schemaVersion: 1 as const, kind: 'finish' as const, planDigest, manifestEvidenceDigest: manifestReference.digest, verdictEvidenceDigests, verdictEnvelopeDigests, receiptDigest, authority: { keyId: envelope.authorityKeyId }, envelope })
    const reference = publish(this.#root, evidence)
    const marker: HoldoutPlanCompletion = frozen({ protocol: HOLDOUT_EVIDENCE_PROTOCOL, schemaVersion: 1, kind: 'plan-completion', planDigest, manifestEvidenceDigest: manifestReference.digest, verdictEvidenceDigests, verdictEnvelopeDigests, finishEvidenceDigest: reference.digest })
    publishNamed(this.#root, markerName(planDigest), marker)
    return reference
  }
  readFinish(planInput: BenchmarkPlan, digest: string): Readonly<HoldoutFinishEvidence> {
    this.#open(); assertDigest(digest); const object = snapshotObject(readObject(this.#root, evidenceName(digest), digest), ['protocol', 'schemaVersion', 'kind', 'planDigest', 'manifestEvidenceDigest', 'verdictEvidenceDigests', 'verdictEnvelopeDigests', 'receiptDigest', 'authority', 'envelope']), plan = parseBenchmarkPlan(planInput), planDigest = benchmarkPlanDigest(plan), cells = benchmarkSchedule(plan)
    if (object.protocol !== HOLDOUT_EVIDENCE_PROTOCOL || object.schemaVersion !== 1 || object.kind !== 'finish' || object.planDigest !== planDigest || !Array.isArray(object.verdictEvidenceDigests) || !Array.isArray(object.verdictEnvelopeDigests) || object.verdictEvidenceDigests.length !== object.verdictEnvelopeDigests.length || object.verdictEvidenceDigests.length > cells.length) fail('invalid-evidence')
    assertDigest(object.manifestEvidenceDigest); const manifest = this.readManifest(plan, object.manifestEvidenceDigest).envelope
    const verdictEvidenceDigests = Object.freeze(object.verdictEvidenceDigests.map(item => { assertDigest(item); return item })), verdictEnvelopeDigests = Object.freeze(object.verdictEnvelopeDigests.map((item, index) => { assertDigest(item); if (this.#readVerdict(plan, cells[index] ?? fail('invalid-evidence'), verdictEvidenceDigests[index]!).receiptDigest !== item) fail('invalid-evidence'); return item }))
    const storedEnvelope = benchmarkSnapshot(object.envelope) as SignedHoldoutFinish, envelope = safeFinish(this.#verifier, { envelope: storedEnvelope, manifest, planDigest, cells, verdictEnvelopeDigests }), receiptDigest = holdoutEnvelopeDigest(envelope), authority = exact(object.authority, ['keyId'])
    if (!envelope.complete || envelope.cellCount !== cells.length || verdictEvidenceDigests.length !== cells.length || object.receiptDigest !== receiptDigest || authority.keyId !== envelope.authorityKeyId || !same(storedEnvelope, envelope)) fail('invalid-evidence')
    return frozen({ protocol: HOLDOUT_EVIDENCE_PROTOCOL, schemaVersion: 1, kind: 'finish', planDigest, manifestEvidenceDigest: object.manifestEvidenceDigest, verdictEvidenceDigests, verdictEnvelopeDigests, receiptDigest, authority: { keyId: envelope.authorityKeyId }, envelope })
  }
  readPlanCompletion(planInput: BenchmarkPlan): Readonly<HoldoutPlanCompletion> | undefined {
    this.#open(); const plan = parseBenchmarkPlan(planInput), planDigest = benchmarkPlanDigest(plan), name = markerName(planDigest)
    try { lstatSync(anchored(this.#root, name), { bigint: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { stillRoot(this.#root); return undefined }; throw error }
    const object = snapshotObject(readObject(this.#root, name), ['protocol', 'schemaVersion', 'kind', 'planDigest', 'manifestEvidenceDigest', 'verdictEvidenceDigests', 'verdictEnvelopeDigests', 'finishEvidenceDigest'])
    if (object.protocol !== HOLDOUT_EVIDENCE_PROTOCOL || object.schemaVersion !== 1 || object.kind !== 'plan-completion' || object.planDigest !== planDigest || !Array.isArray(object.verdictEvidenceDigests) || !Array.isArray(object.verdictEnvelopeDigests)) fail('invalid-evidence')
    assertDigest(object.manifestEvidenceDigest); assertDigest(object.finishEvidenceDigest); const finish = this.readFinish(plan, object.finishEvidenceDigest)
    if (finish.manifestEvidenceDigest !== object.manifestEvidenceDigest || !same(finish.verdictEvidenceDigests, object.verdictEvidenceDigests) || !same(finish.verdictEnvelopeDigests, object.verdictEnvelopeDigests)) fail('invalid-evidence')
    return frozen({ protocol: HOLDOUT_EVIDENCE_PROTOCOL, schemaVersion: 1, kind: 'plan-completion', planDigest, manifestEvidenceDigest: finish.manifestEvidenceDigest, verdictEvidenceDigests: finish.verdictEvidenceDigests, verdictEnvelopeDigests: finish.verdictEnvelopeDigests, finishEvidenceDigest: object.finishEvidenceDigest })
  }
  verifyRun(planInput: BenchmarkPlan, resultsInput: readonly BenchmarkResult[]): Readonly<HoldoutRunEvidence> {
    this.#open(); const plan = parseBenchmarkPlan(planInput), cells = benchmarkSchedule(plan)
    if (!Array.isArray(resultsInput)) fail('invalid-evidence')
    const parseResult = benchmarkResultParser(plan), results = resultsInput.map(item => safeVerify(() => parseResult(item)))
    if (!Array.isArray(results) || results.length !== cells.length) fail('invalid-evidence')
    const completion = this.readPlanCompletion(plan); if (!completion || completion.verdictEvidenceDigests.length !== cells.length) fail('invalid-evidence')
    const verdicts = cells.map((cell, index) => {
      const result = results[index], evidenceDigest = result?.evidenceDigest
      if (!result || result.status !== 'completed' || result.reason !== 'verified' || !same(result.cell, cell) || typeof evidenceDigest !== 'string' || evidenceDigest !== completion.verdictEvidenceDigests[index]) fail('invalid-evidence')
      const evidence = this.#readVerdict(plan, cell, evidenceDigest)
      if (result.verdict !== evidence.envelope.verdict) fail('invalid-evidence')
      for (const key of ['inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls', 'rework', 'interventions'] as const) if (result.metrics[key] !== evidence.host.hostMetrics[key]) fail('invalid-evidence')
      return evidence
    })
    const finish = this.readFinish(plan, completion.finishEvidenceDigest), manifest = this.readManifest(plan, completion.manifestEvidenceDigest)
    return frozen({ completion, manifest, verdicts: Object.freeze(verdicts), finish })
  }
  close(): void { if (this.#closed) return; this.#closed = true; closeSync(this.#root.descriptor) }
}
