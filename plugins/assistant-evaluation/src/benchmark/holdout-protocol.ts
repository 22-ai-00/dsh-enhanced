import { createHash, createPublicKey, verify } from 'node:crypto'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { BenchmarkError } from './schema.js'
import { benchmarkDomains } from './types.js'
import type { BenchmarkCase, BenchmarkCell, BenchmarkPlan, BenchmarkVerdict } from './types.js'

export const HOLDOUT_PROTOCOL_V1 = 'dsh-benchmark/independent-holdout/v1' as const

const digestPattern = /^[a-f0-9]{64}$/u
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const contentTypePattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}(?:; charset=utf-8)?$/u
const base64urlPattern = /^[A-Za-z0-9_-]*$/u
const maximumEnvelopeBytes = 512 * 1024
const maximumInputBytes = 256 * 1024
const maximumNodes = 4096
const maximumDepth = 16
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])

export interface SignedHoldoutManifest {
  readonly protocol: typeof HOLDOUT_PROTOCOL_V1
  readonly kind: 'manifest'
  readonly manifestId: string
  readonly authorityKeyId: string
  readonly dataset: BenchmarkPlan['dataset'] & { readonly split: 'holdout' }
  /** Public identities and digests only: no prompt, input, answer, judge, path, or oracle. */
  readonly cases: readonly BenchmarkCase[]
  readonly issuedAt: number
  readonly signature: string
}

export interface SignedHoldoutInput {
  readonly protocol: typeof HOLDOUT_PROTOCOL_V1
  readonly kind: 'input'
  readonly authorityKeyId: string
  readonly manifestDigest: string
  readonly planDigest: string
  readonly cell: BenchmarkCell
  readonly inputDigest: string
  readonly contentType: string
  /** Canonical unpadded base64url. This is task input, never acceptance material. */
  readonly inputBase64url: string
  readonly signature: string
}

export interface SignedHoldoutVerdict {
  readonly protocol: typeof HOLDOUT_PROTOCOL_V1
  readonly kind: 'verdict'
  readonly authorityKeyId: string
  readonly manifestDigest: string
  readonly planDigest: string
  readonly cell: BenchmarkCell
  readonly inputDigest: string
  readonly acceptanceDigest: string
  readonly outputDigest: string
  readonly verdict: BenchmarkVerdict
  readonly evaluatedAt: number
  readonly signature: string
}

export interface SignedHoldoutFinish {
  readonly protocol: typeof HOLDOUT_PROTOCOL_V1
  readonly kind: 'finish'
  readonly authorityKeyId: string
  readonly manifestDigest: string
  readonly planDigest: string
  readonly cellCount: number
  /** Digest of the ordered exact cells and their signed verdict-envelope digests. */
  readonly verdictsDigest: string
  readonly complete: boolean
  readonly finalizedAt: number
  readonly signature: string
}

type SignedEnvelope = SignedHoldoutManifest | SignedHoldoutInput | SignedHoldoutVerdict | SignedHoldoutFinish

function fail(message: string): never { throw new BenchmarkError(`holdout protocol: ${message}`) }
function assert(condition: unknown, message: string): asserts condition { if (!condition) fail(message) }

/**
 * Inspect hostile values before canonicalization so getters, sparse arrays and oversized strings
 * cannot be hidden by JSON serialization. The detached result is deeply frozen.
 */
function boundedSnapshot<T>(value: T): T {
  const active = new Set<object>()
  let nodes = 0
  let bytes = 0
  const inspect = (entry: unknown, depth: number): void => {
    nodes++
    assert(nodes <= maximumNodes && depth <= maximumDepth, 'envelope is too complex')
    if (entry === null) { bytes += 4; return }
    if (typeof entry === 'string') { bytes += Buffer.byteLength(entry, 'utf8') + 2; assert(bytes <= maximumEnvelopeBytes, 'envelope is too large'); return }
    if (typeof entry === 'boolean') { bytes += 5; return }
    if (typeof entry === 'number') {
      assert(Number.isFinite(entry) && (!Number.isInteger(entry) || Number.isSafeInteger(entry)), 'envelope contains an invalid number')
      bytes += 24
      return
    }
    assert(typeof entry === 'object' && !active.has(entry), 'envelope contains an unsafe value or cycle')
    active.add(entry)
    try {
      if (Array.isArray(entry)) {
        assert(Object.getPrototypeOf(entry) === Array.prototype && entry.length <= maximumNodes, 'envelope contains an invalid array')
        const keys = Reflect.ownKeys(entry).filter(key => key !== 'length')
        assert(keys.length === entry.length && keys.every((key, index) => key === String(index)), 'envelope contains a sparse or decorated array')
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, key)!
          assert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'envelope contains an unsafe array property')
          inspect(descriptor.value, depth + 1)
        }
        return
      }
      const prototype = Object.getPrototypeOf(entry)
      assert(prototype === Object.prototype || prototype === null, 'envelope must contain plain objects')
      for (const key of Reflect.ownKeys(entry)) {
        assert(typeof key === 'string' && !unsafeKeys.has(key), 'envelope contains an unsafe key')
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)!
        assert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'envelope contains an unsafe property')
        bytes += Buffer.byteLength(key, 'utf8') + 3
        assert(bytes <= maximumEnvelopeBytes, 'envelope is too large')
        inspect(descriptor.value, depth + 1)
      }
    } finally { active.delete(entry) }
  }
  inspect(value, 0)
  const canonical = acceptanceCanonicalJson(value)
  assert(Buffer.byteLength(canonical, 'utf8') <= maximumEnvelopeBytes, 'envelope is too large')
  const copy = JSON.parse(canonical) as T
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object') return
    for (const child of Object.values(entry)) freeze(child)
    Object.freeze(entry)
  }
  freeze(copy)
  return copy
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  assert(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} has unexpected fields`)
  return record
}
function id(value: unknown, label: string): asserts value is string { assert(typeof value === 'string' && idPattern.test(value), `${label} is invalid`) }
function digest(value: unknown, label: string): asserts value is string { assert(typeof value === 'string' && digestPattern.test(value), `${label} is invalid`) }
function integer(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max, `${label} is invalid`)
}
function signature(value: unknown): asserts value is string {
  assert(typeof value === 'string' && base64urlPattern.test(value) && value.length === 86
    && Buffer.from(value, 'base64url').length === 64 && Buffer.from(value, 'base64url').toString('base64url') === value, 'signature is invalid')
}

function publicKey(value: string) {
  assert(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 16 * 1024, 'pinned public key is invalid')
  try {
    const key = createPublicKey(value)
    assert(key.asymmetricKeyType === 'ed25519', 'pinned public key must be Ed25519')
    return key
  } catch (error) {
    if (error instanceof BenchmarkError) throw error
    return fail('pinned public key is invalid')
  }
}

export function holdoutAuthorityKeyId(pinnedPublicKey: string): string {
  return createHash('sha256').update(publicKey(pinnedPublicKey).export({ format: 'der', type: 'spki' })).digest('hex')
}

/** Canonical signing bytes. A supplied signature field is omitted without invoking accessors. */
export function holdoutUnsignedCanonicalJson(value: unknown): string {
  const snapshot = boundedSnapshot(value)
  assert(snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot), 'signed envelope must be an object')
  const record = snapshot as Record<string, unknown>
  if (!Object.hasOwn(record, 'signature')) return acceptanceCanonicalJson(record)
  const unsigned = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'signature'))
  return acceptanceCanonicalJson(unsigned)
}

/** Digest of the complete signed envelope, suitable for evidence and chaining. */
export function holdoutEnvelopeDigest(value: unknown): string {
  return createHash('sha256').update(acceptanceCanonicalJson(boundedSnapshot(value))).digest('hex')
}

export function verifyHoldoutEnvelopeSignature(value: unknown, pinnedPublicKey: string): boolean {
  try {
    const snapshot = boundedSnapshot(value)
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
    const signed = snapshot as Record<string, unknown>
    signature(signed.signature)
    return verify(null, Buffer.from(holdoutUnsignedCanonicalJson(signed)), publicKey(pinnedPublicKey), Buffer.from(signed.signature, 'base64url'))
  } catch { return false }
}

function common(envelope: Record<string, unknown>, kind: SignedEnvelope['kind'], pinnedPublicKey: string): void {
  assert(envelope.protocol === HOLDOUT_PROTOCOL_V1 && envelope.kind === kind, 'protocol or envelope kind is invalid')
  digest(envelope.authorityKeyId, 'authority key id')
  assert(envelope.authorityKeyId === holdoutAuthorityKeyId(pinnedPublicKey), 'authority key id does not match pinned key')
  signature(envelope.signature)
  assert(verifyHoldoutEnvelopeSignature(envelope, pinnedPublicKey), 'signature verification failed')
}

function benchmarkCase(value: unknown): BenchmarkCase {
  const item = object(value, ['id', 'domain', 'inputDigest', 'acceptanceDigest'], 'manifest case')
  id(item.id, 'case id')
  assert(benchmarkDomains.includes(item.domain as typeof benchmarkDomains[number]), 'case domain is invalid')
  digest(item.inputDigest, 'case input digest'); digest(item.acceptanceDigest, 'case acceptance digest')
  return item as unknown as BenchmarkCase
}

function benchmarkCell(value: unknown): BenchmarkCell {
  const item = object(value, ['id', 'caseId', 'variantId', 'repeat', 'seed'], 'benchmark cell')
  digest(item.id, 'cell id'); id(item.caseId, 'cell case id'); id(item.variantId, 'cell variant id')
  integer(item.repeat, 'cell repeat', 19); integer(item.seed, 'cell seed', 0xffffffff)
  return item as unknown as BenchmarkCell
}

function same(left: unknown, right: unknown): boolean { return acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right) }

export function parseSignedHoldoutManifest(value: unknown, pinnedPublicKey: string): Readonly<SignedHoldoutManifest> {
  const snapshot = boundedSnapshot(value)
  const raw = object(snapshot, ['protocol', 'kind', 'manifestId', 'authorityKeyId', 'dataset', 'cases', 'issuedAt', 'signature'], 'manifest')
  common(raw, 'manifest', pinnedPublicKey)
  id(raw.manifestId, 'manifest id'); integer(raw.issuedAt, 'manifest issuedAt')
  const dataset = object(raw.dataset, ['id', 'version', 'digest', 'split'], 'manifest dataset')
  id(dataset.id, 'dataset id'); id(dataset.version, 'dataset version'); digest(dataset.digest, 'dataset digest')
  assert(dataset.split === 'holdout', 'manifest dataset must be a holdout')
  assert(Array.isArray(raw.cases) && raw.cases.length >= 1 && raw.cases.length <= 100, 'manifest requires 1..100 cases')
  const cases = raw.cases.map(benchmarkCase)
  assert(new Set(cases.map(item => item.id)).size === cases.length, 'manifest case ids must be unique')
  assert(new Set(cases.map(item => item.inputDigest)).size === cases.length, 'manifest case inputs must be unique')
  const expectedDatasetDigest = acceptanceDigest({ id: dataset.id, version: dataset.version, split: dataset.split, cases })
  assert(dataset.digest === expectedDatasetDigest, 'manifest dataset digest does not match public commitments')
  return snapshot as Readonly<SignedHoldoutManifest>
}

export function parseSignedHoldoutInput(
  value: unknown, manifestValue: SignedHoldoutManifest, expectedPlanDigest: string, expectedCell: BenchmarkCell, pinnedPublicKey: string,
): Readonly<SignedHoldoutInput> {
  const manifest = parseSignedHoldoutManifest(manifestValue, pinnedPublicKey)
  digest(expectedPlanDigest, 'expected plan digest')
  const snapshot = boundedSnapshot(value)
  const raw = object(snapshot, ['protocol', 'kind', 'authorityKeyId', 'manifestDigest', 'planDigest', 'cell', 'inputDigest', 'contentType', 'inputBase64url', 'signature'], 'input')
  common(raw, 'input', pinnedPublicKey)
  digest(raw.manifestDigest, 'input manifest digest'); digest(raw.planDigest, 'input plan digest'); digest(raw.inputDigest, 'input digest')
  assert(raw.manifestDigest === holdoutEnvelopeDigest(manifest) && raw.planDigest === expectedPlanDigest, 'input plan or manifest identity differs')
  const cell = benchmarkCell(raw.cell)
  assert(same(cell, expectedCell), 'input cell identity differs')
  const task = manifest.cases.find(item => item.id === cell.caseId)
  assert(task !== undefined && raw.inputDigest === task.inputDigest, 'input case commitment differs')
  assert(typeof raw.contentType === 'string' && contentTypePattern.test(raw.contentType), 'input content type is invalid')
  assert(typeof raw.inputBase64url === 'string' && base64urlPattern.test(raw.inputBase64url), 'input encoding is invalid')
  const bytes = Buffer.from(raw.inputBase64url, 'base64url')
  assert(bytes.length <= maximumInputBytes && bytes.toString('base64url') === raw.inputBase64url, 'input encoding is non-canonical or too large')
  assert(createHash('sha256').update(bytes).digest('hex') === raw.inputDigest, 'input bytes do not match the committed digest')
  return snapshot as Readonly<SignedHoldoutInput>
}

export function holdoutInputBytes(value: SignedHoldoutInput): Uint8Array {
  const snapshot = boundedSnapshot(value) as SignedHoldoutInput
  assert(typeof snapshot.inputBase64url === 'string' && base64urlPattern.test(snapshot.inputBase64url), 'input encoding is invalid')
  const bytes = Buffer.from(snapshot.inputBase64url, 'base64url')
  assert(bytes.length <= maximumInputBytes && bytes.toString('base64url') === snapshot.inputBase64url, 'input encoding is non-canonical or too large')
  return Uint8Array.from(bytes)
}

export function parseSignedHoldoutVerdict(
  value: unknown, manifestValue: SignedHoldoutManifest, expectedPlanDigest: string, expectedCell: BenchmarkCell, expectedOutputDigest: string, pinnedPublicKey: string,
): Readonly<SignedHoldoutVerdict> {
  const manifest = parseSignedHoldoutManifest(manifestValue, pinnedPublicKey)
  digest(expectedPlanDigest, 'expected plan digest'); digest(expectedOutputDigest, 'expected output digest')
  const snapshot = boundedSnapshot(value)
  const raw = object(snapshot, ['protocol', 'kind', 'authorityKeyId', 'manifestDigest', 'planDigest', 'cell', 'inputDigest', 'acceptanceDigest', 'outputDigest', 'verdict', 'evaluatedAt', 'signature'], 'verdict')
  common(raw, 'verdict', pinnedPublicKey)
  for (const [entry, label] of [[raw.manifestDigest, 'verdict manifest digest'], [raw.planDigest, 'verdict plan digest'], [raw.inputDigest, 'verdict input digest'], [raw.acceptanceDigest, 'verdict acceptance digest'], [raw.outputDigest, 'verdict output digest']] as const) digest(entry, label)
  assert(raw.manifestDigest === holdoutEnvelopeDigest(manifest) && raw.planDigest === expectedPlanDigest && raw.outputDigest === expectedOutputDigest, 'verdict plan, manifest, or output identity differs')
  const cell = benchmarkCell(raw.cell)
  assert(same(cell, expectedCell), 'verdict cell identity differs')
  const task = manifest.cases.find(item => item.id === cell.caseId)
  assert(task !== undefined && raw.inputDigest === task.inputDigest && raw.acceptanceDigest === task.acceptanceDigest, 'verdict case commitment differs')
  assert(raw.verdict === 'achieved' || raw.verdict === 'not-achieved' || raw.verdict === 'unknown', 'verdict value is invalid')
  integer(raw.evaluatedAt, 'verdict evaluatedAt')
  return snapshot as Readonly<SignedHoldoutVerdict>
}

export function holdoutVerdictsDigest(expectedCells: readonly BenchmarkCell[], verdictEnvelopeDigests: readonly string[]): string {
  assert(expectedCells.length === verdictEnvelopeDigests.length, 'verdict digest count differs from cells')
  const seen = new Set<string>()
  const entries = expectedCells.map((cellValue, index) => {
    const cell = benchmarkCell(boundedSnapshot(cellValue))
    assert(!seen.has(cell.id), 'finish cells must be unique')
    seen.add(cell.id)
    const verdictDigest = verdictEnvelopeDigests[index]
    digest(verdictDigest, 'signed verdict envelope digest')
    return { cell, verdictDigest }
  })
  return acceptanceDigest(entries)
}

export function parseSignedHoldoutFinish(
  value: unknown, manifestValue: SignedHoldoutManifest, expectedPlanDigest: string, expectedCells: readonly BenchmarkCell[], verdictEnvelopeDigests: readonly string[], pinnedPublicKey: string,
): Readonly<SignedHoldoutFinish> {
  const manifest = parseSignedHoldoutManifest(manifestValue, pinnedPublicKey)
  digest(expectedPlanDigest, 'expected plan digest')
  assert(expectedCells.length <= 16_000 && verdictEnvelopeDigests.length <= expectedCells.length, 'finish cell count is invalid')
  const snapshot = boundedSnapshot(value)
  const raw = object(snapshot, ['protocol', 'kind', 'authorityKeyId', 'manifestDigest', 'planDigest', 'cellCount', 'verdictsDigest', 'complete', 'finalizedAt', 'signature'], 'finish')
  common(raw, 'finish', pinnedPublicKey)
  digest(raw.manifestDigest, 'finish manifest digest'); digest(raw.planDigest, 'finish plan digest'); digest(raw.verdictsDigest, 'finish verdicts digest')
  assert(raw.manifestDigest === holdoutEnvelopeDigest(manifest) && raw.planDigest === expectedPlanDigest, 'finish plan or manifest identity differs')
  integer(raw.cellCount, 'finish cell count', 16_000); integer(raw.finalizedAt, 'finish finalizedAt')
  assert(typeof raw.complete === 'boolean' && raw.cellCount === verdictEnvelopeDigests.length, 'finish completion metadata differs')
  assert(!raw.complete || raw.cellCount === expectedCells.length, 'complete finish must cover every planned cell')
  assert(raw.verdictsDigest === holdoutVerdictsDigest(expectedCells.slice(0, raw.cellCount), verdictEnvelopeDigests), 'finish verdict chain differs')
  return snapshot as Readonly<SignedHoldoutFinish>
}
