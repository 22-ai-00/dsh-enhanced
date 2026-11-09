import { createPublicKey, verify } from 'node:crypto'
import { canonicalGrowthJson } from './canonical.js'
import { validatePluginCreationVerificationCertificate,
  type PluginCreationVerificationCertificate, type PluginCreationVerificationLinuxExecution } from './creation-verification.js'

/** Owner policy frozen before a revision candidate can be written. */
export interface RevisionAcceptanceAuthorityRef {
  protocol: 'assistant-growth/revision-acceptance-authority/v1'
  authorityId: string
  keyId: string
  authorityDigest: string
  namePrefix: string
  expiresAt: number
}

/** Exact adopted version and retained source on which the revision is based. */
export interface PluginRevisionParentBinding {
  planId: string
  certificateDigest: string
  artifactSha256: string
  sourceArchiveDigest: string
  sourceDigest: string
}

/**
 * Task-failure revisions bind the frozen growth run that authorized them.
 * Owner-instruction revisions have no growth run: their signed source instead
 * binds the exact instruction row that authenticated the revision, while the
 * parent binding already names the adopted plan.
 */
export type PluginRevisionVerificationTaskSource = { referenceDigest: string; ownerDigest: string; growthRunDigest: string }
export type PluginRevisionVerificationInstructionSource = { instructionDigest: string; ownerDigest: string }
export type PluginRevisionVerificationSource =
  | PluginRevisionVerificationTaskSource
  | PluginRevisionVerificationInstructionSource

export function isPluginRevisionTaskSource(value: PluginRevisionVerificationSource): value is PluginRevisionVerificationTaskSource {
  return Object.hasOwn(value, 'growthRunDigest')
}
export function isPluginRevisionInstructionSource(value: PluginRevisionVerificationSource): value is PluginRevisionVerificationInstructionSource {
  return Object.hasOwn(value, 'instructionDigest')
}

export type PluginRevisionVerificationCertificate =
  Omit<PluginCreationVerificationCertificate, 'protocol' | 'authority' | 'execution' | 'source'> & {
    protocol: 'assistant-growth/revision-verification/v1' | 'assistant-growth/revision-verification/v2'
      | 'assistant-growth/revision-verification/v3'
    authority: RevisionAcceptanceAuthorityRef
    parent: PluginRevisionParentBinding
    source: PluginRevisionVerificationSource
    /** Required exactly for v2 with the Linux native boundary; rejected for v1 and v3. */
    execution?: PluginCreationVerificationLinuxExecution
  }

export type PluginRevisionVerificationCertificateV1 = PluginRevisionVerificationCertificate &
  { protocol: 'assistant-growth/revision-verification/v1'; execution?: never }
export type PluginRevisionVerificationCertificateV2 = PluginRevisionVerificationCertificate &
  { protocol: 'assistant-growth/revision-verification/v2'; execution: PluginCreationVerificationLinuxExecution }
/** Owner-instruction revision: no task reference and no growth run anywhere in the signed body. */
export type PluginRevisionVerificationCertificateV3 = PluginRevisionVerificationCertificate &
  { protocol: 'assistant-growth/revision-verification/v3'; execution?: never;
    source: { instructionDigest: string; ownerDigest: string } }

/** Host-only request; the producer must reread the current parent and candidate. */
export interface PluginRevisionVerificationRequest {
  protocol: 'assistant-growth/revision-verification-request/v1'
  planId: string
}

export type PluginRevisionVerificationResult =
  | { status: 'verified'; certificate: PluginRevisionVerificationCertificate }
  | { status: 'rejected' | 'unknown'; reason: string }

const domainV1 = 'assistant-growth/revision-verification/v1\0'
const domainV2 = 'assistant-growth/revision-verification/v2\0'
const domainV3 = 'assistant-growth/revision-verification/v3\0'
const digest = /^[a-f0-9]{64}$/u
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const certificateKeys = ['protocol', 'verificationId', 'authority', 'plan', 'parent', 'source', 'contractDigest',
  'schemaDigest', 'environment', 'model', 'budget', 'sessions', 'observations', 'reviewDigest', 'verifiedAt', 'expiresAt'] as const

function certificateKeysFor(value: unknown): readonly string[] {
  const protocol = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'protocol')?.value : undefined
  return protocol === 'assistant-growth/revision-verification/v2' ? [...certificateKeys, 'execution'] : certificateKeys
}

function fail(label: string): never { throw new Error(`invalid plugin revision verification ${label}`) }
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length
    || !Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(label)
  return value as Record<string, unknown>
}

export function validateRevisionAcceptanceAuthorityRef(value: unknown): asserts value is RevisionAcceptanceAuthorityRef {
  const ref = record(value, ['protocol', 'authorityId', 'keyId', 'authorityDigest', 'namePrefix', 'expiresAt'], 'authority')
  if (ref.protocol !== 'assistant-growth/revision-acceptance-authority/v1') fail('authority protocol')
  for (const key of ['authorityId', 'keyId']) {
    if (typeof ref[key] !== 'string' || !identifier.test(ref[key]) || ref[key].normalize('NFC') !== ref[key]) fail(key)
  }
  if (typeof ref.authorityDigest !== 'string' || !digest.test(ref.authorityDigest)) fail('authorityDigest')
  if (typeof ref.namePrefix !== 'string' || ref.namePrefix.length < 2 || ref.namePrefix.length > 48
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u.test(ref.namePrefix)) fail('namePrefix')
  if (!Number.isSafeInteger(ref.expiresAt) || Number(ref.expiresAt) < 1
    || Number(ref.expiresAt) > 8_640_000_000_000_000) fail('authority expiry')
}

export function validatePluginRevisionParentBinding(value: unknown): asserts value is PluginRevisionParentBinding {
  const parent = record(value, ['planId', 'certificateDigest', 'artifactSha256', 'sourceArchiveDigest', 'sourceDigest'], 'parent')
  if (typeof parent.planId !== 'string' || !identifier.test(parent.planId)
    || parent.planId.normalize('NFC') !== parent.planId) fail('parent planId')
  for (const key of ['certificateDigest', 'artifactSha256', 'sourceArchiveDigest', 'sourceDigest']) {
    if (typeof parent[key] !== 'string' || !digest.test(parent[key])) fail(`parent ${key}`)
  }
}

export function validatePluginRevisionVerificationCertificate(value: unknown): asserts value is PluginRevisionVerificationCertificate {
  const protocol: unknown = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'protocol')?.value : undefined
  const linux = protocol === 'assistant-growth/revision-verification/v2'
  const instruction = protocol === 'assistant-growth/revision-verification/v3'
  const item = record(value, [...certificateKeysFor(value), 'signature'], 'certificate')
  if (!linux && item.protocol !== 'assistant-growth/revision-verification/v1'
    && item.protocol !== 'assistant-growth/revision-verification/v3') fail('protocol')
  const authority = item.authority
  validateRevisionAcceptanceAuthorityRef(authority)
  validatePluginRevisionParentBinding(item.parent)
  // The instruction source is validated in full here; the delegated creation
  // shape check only re-verifies the shared fields, so it receives a mapped
  // pseudo-source with the exact triple shape it always required.
  if (instruction) {
    const source = record(item.source, ['instructionDigest', 'ownerDigest'], 'source')
    for (const key of ['instructionDigest', 'ownerDigest']) {
      if (typeof source[key] !== 'string' || !digest.test(source[key])) fail(`source ${key}`)
    }
  }
  const { parent: _parent, ...creationShape } = item
  validatePluginCreationVerificationCertificate({ ...creationShape,
    protocol: linux ? 'assistant-growth/creation-verification/v3' : 'assistant-growth/creation-verification/v1',
    authority: { ...authority, protocol: 'assistant-growth/creation-acceptance-authority/v1' },
    ...(instruction ? { source: instructionSourceForShapeCheck(item.source) } : {}) })
  if (Buffer.byteLength(canonicalGrowthJson(item)) > 65_536) fail('certificate bytes')
}

/** Maps a validated v3 instruction source onto the shared creation shape for field checks only. */
function instructionSourceForShapeCheck(source: unknown): { referenceDigest: string; ownerDigest: string; growthRunDigest: string } {
  const item = source as { instructionDigest: string; ownerDigest: string }
  return { referenceDigest: item.instructionDigest, ownerDigest: item.ownerDigest, growthRunDigest: item.instructionDigest }
}

export function pluginRevisionVerificationSigningPayload(value: Omit<PluginRevisionVerificationCertificate, 'signature'>): string {
  const body = record(value, certificateKeysFor(value), 'signing body')
  validatePluginRevisionVerificationCertificate({ ...body, signature: 'A'.repeat(86) })
  return (body.protocol === 'assistant-growth/revision-verification/v2' ? domainV2
    : body.protocol === 'assistant-growth/revision-verification/v3' ? domainV3 : domainV1) + canonicalGrowthJson(body)
}

/** Signature and authority equality only; consumers must also recheck provenance and parent currency. */
export function verifyPluginRevisionVerificationCertificate(value: unknown,
  authority: RevisionAcceptanceAuthorityRef, publicKey: string, now = Date.now()): value is PluginRevisionVerificationCertificate {
  try {
    validateRevisionAcceptanceAuthorityRef(authority)
    validatePluginRevisionVerificationCertificate(value)
    if (!Number.isSafeInteger(now) || value.verifiedAt > now || value.expiresAt <= now
      || canonicalGrowthJson(value.authority) !== canonicalGrowthJson(authority)) return false
    const { signature, ...body } = value
    const key = createPublicKey(publicKey)
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(pluginRevisionVerificationSigningPayload(body)), key, Buffer.from(signature, 'base64url'))
  } catch { return false }
}
