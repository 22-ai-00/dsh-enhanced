import { createPublicKey, verify } from 'node:crypto'
import { canonicalGrowthJson } from './canonical.js'
import { validatePluginCreationVerificationCertificate,
  type PluginCreationVerificationCertificate } from './creation-verification.js'

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

export type PluginRevisionVerificationCertificate = Omit<PluginCreationVerificationCertificate, 'protocol' | 'authority'> & {
  protocol: 'assistant-growth/revision-verification/v1'
  authority: RevisionAcceptanceAuthorityRef
  parent: PluginRevisionParentBinding
}

/** Host-only request; the producer must reread the current parent and candidate. */
export interface PluginRevisionVerificationRequest {
  protocol: 'assistant-growth/revision-verification-request/v1'
  planId: string
}

export type PluginRevisionVerificationResult =
  | { status: 'verified'; certificate: PluginRevisionVerificationCertificate }
  | { status: 'rejected' | 'unknown'; reason: string }

const domain = 'assistant-growth/revision-verification/v1\0'
const digest = /^[a-f0-9]{64}$/u
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const certificateKeys = ['protocol', 'verificationId', 'authority', 'plan', 'parent', 'source', 'contractDigest',
  'schemaDigest', 'environment', 'model', 'budget', 'sessions', 'observations', 'reviewDigest', 'verifiedAt', 'expiresAt'] as const

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
  const item = record(value, [...certificateKeys, 'signature'], 'certificate')
  if (item.protocol !== 'assistant-growth/revision-verification/v1') fail('protocol')
  const authority = item.authority
  validateRevisionAcceptanceAuthorityRef(authority)
  validatePluginRevisionParentBinding(item.parent)
  const { parent: _parent, ...creationShape } = item
  validatePluginCreationVerificationCertificate({ ...creationShape,
    protocol: 'assistant-growth/creation-verification/v1',
    authority: { ...authority, protocol: 'assistant-growth/creation-acceptance-authority/v1' },
  })
  if (Buffer.byteLength(canonicalGrowthJson(item)) > 65_536) fail('certificate bytes')
}

export function pluginRevisionVerificationSigningPayload(value: Omit<PluginRevisionVerificationCertificate, 'signature'>): string {
  const body = record(value, certificateKeys, 'signing body')
  validatePluginRevisionVerificationCertificate({ ...body, signature: 'A'.repeat(86) })
  return domain + canonicalGrowthJson(body)
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
