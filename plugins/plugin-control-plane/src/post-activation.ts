import { createHash, createPublicKey, verify } from 'node:crypto'
import { ControlPlaneStoreError } from './store.js'
import type {
  ActivationRetractionAuthority,
  ActivationRetractionReceipt,
  PluginActivationPlan,
  PostActivationHealthEvidence,
  PostActivationObservationAuthority,
  PostActivationObservationReceipt,
  VerifiedActivationRetraction,
  VerifiedPostActivationObservation,
  WatchExactTarget,
} from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/u
// Mirror the catalog admission invariants so a watch can only pin an exact
// package@version the owner catalog would itself admit.
const PACKAGE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u
const INTEGRITY = /^sha512-[A-Za-z0-9+/=]+$/u

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ControlPlaneStoreError('invalid-input', `${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) throw new ControlPlaneStoreError('invalid-input', `${label} has unknown or missing fields`)
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ControlPlaneStoreError('invalid-input', `${label} must be a bounded integer`)
  return Number(value)
}

function id(value: unknown, label: string, pattern: RegExp = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new ControlPlaneStoreError('invalid-input', `${label} is invalid`)
  return value
}

function parseHealthEvidence(value: unknown): PostActivationHealthEvidence {
  const item = record(value, 'post-activation health evidence')
  exact(item, ['kind', 'checks', 'failures', 'probeDigest'], 'post-activation health evidence')
  if (item.kind !== 'post-activation-health') throw new ControlPlaneStoreError('invalid-input', 'post-activation evidence kind is invalid')
  const checks = integer(item.checks, 'checks')
  const failures = integer(item.failures, 'failures')
  if (failures > checks) throw new ControlPlaneStoreError('invalid-input', 'post-activation failures exceed checks')
  return { kind: 'post-activation-health', checks, failures, probeDigest: id(item.probeDigest, 'probeDigest', DIGEST) }
}

// ---------------------------------------------------------------------------
// Host-signed post-activation observation (independent failure/health evidence)
// ---------------------------------------------------------------------------

const observationFields = ['schemaVersion', 'observationId', 'authority', 'keyId', 'installationId', 'planId',
  'planDigest', 'activationId', 'fence', 'package', 'version', 'integrity', 'disposition', 'evidence',
  'evidenceDigest', 'hostGeneration', 'observedAt', 'expiresAt', 'signature'] as const

function canonicalObservation(receipt: PostActivationObservationReceipt): string {
  return canonical({
    schemaVersion: receipt.schemaVersion, observationId: receipt.observationId, authority: receipt.authority,
    keyId: receipt.keyId, installationId: receipt.installationId, planId: receipt.planId,
    planDigest: receipt.planDigest, activationId: receipt.activationId, fence: receipt.fence,
    package: receipt.package, version: receipt.version, integrity: receipt.integrity,
    disposition: receipt.disposition, evidence: receipt.evidence, evidenceDigest: receipt.evidenceDigest,
    hostGeneration: receipt.hostGeneration, observedAt: receipt.observedAt, expiresAt: receipt.expiresAt,
  })
}

export function postActivationEvidenceDigest(evidence: PostActivationHealthEvidence): string { return digest(evidence) }

export function parsePostActivationObservation(value: unknown): PostActivationObservationReceipt {
  const item = record(value, 'post-activation observation')
  exact(item, observationFields, 'post-activation observation')
  if (item.schemaVersion !== 1 || (item.disposition !== 'regressed' && item.disposition !== 'healthy')
    || typeof item.signature !== 'string' || !SIGNATURE.test(item.signature)) {
    throw new ControlPlaneStoreError('invalid-input', 'post-activation observation fields are invalid')
  }
  const receipt: PostActivationObservationReceipt = {
    schemaVersion: 1, observationId: id(item.observationId, 'observationId'), authority: id(item.authority, 'authority'),
    keyId: id(item.keyId, 'keyId'), installationId: id(item.installationId, 'installationId', UUID),
    planId: id(item.planId, 'planId'), planDigest: id(item.planDigest, 'planDigest', DIGEST),
    activationId: id(item.activationId, 'activationId'), fence: integer(item.fence, 'fence', 1),
    package: id(item.package, 'package', PACKAGE), version: id(item.version, 'version', VERSION),
    integrity: id(item.integrity, 'integrity', INTEGRITY), disposition: item.disposition,
    evidence: parseHealthEvidence(item.evidence), evidenceDigest: id(item.evidenceDigest, 'evidenceDigest', DIGEST),
    hostGeneration: integer(item.hostGeneration, 'hostGeneration', 1),
    observedAt: integer(item.observedAt, 'observedAt'), expiresAt: integer(item.expiresAt, 'expiresAt'),
    signature: item.signature,
  }
  if (receipt.expiresAt <= receipt.observedAt || postActivationEvidenceDigest(receipt.evidence) !== receipt.evidenceDigest) {
    throw new ControlPlaneStoreError('invalid-input', 'post-activation evidence digest or validity interval is invalid')
  }
  // The disposition is not a free-form signer claim: it must agree with the signed
  // counters. A clean probe is positive evidence; at least one failure is a regression.
  if ((receipt.disposition === 'healthy' && receipt.evidence.failures !== 0)
    || (receipt.disposition === 'regressed' && receipt.evidence.failures === 0)) {
    throw new ControlPlaneStoreError('invalid-input', 'post-activation disposition does not match its signed failure evidence')
  }
  return receipt
}

export interface PostActivationVerifyOptions {
  /** Freshness bound for an observation submission; defaults to the host policy 30s window. */
  receiptTtlMs?: number
}

export class Ed25519PostActivationObservationAuthority implements PostActivationObservationAuthority {
  constructor(
    readonly publicKey: string | Buffer,
    readonly expectedAuthority: string,
    readonly expectedKeyId: string,
    private readonly options: PostActivationVerifyOptions = {},
    readonly now: () => number = Date.now,
  ) {}

  async verify(receiptInput: PostActivationObservationReceipt, plan: PluginActivationPlan, exact: WatchExactTarget):
    Promise<VerifiedPostActivationObservation> {
    const receipt = parsePostActivationObservation(receiptInput)
    if (receipt.authority !== this.expectedAuthority || receipt.keyId !== this.expectedKeyId
      || receipt.installationId !== plan.installationId || receipt.planId !== plan.id
      || receipt.planDigest !== plan.digest || !plan.activation
      || receipt.activationId !== plan.activation.id || receipt.fence !== plan.activation.fence
      || receipt.package !== exact.package || receipt.version !== exact.version || receipt.integrity !== exact.integrity) {
      throw new ControlPlaneStoreError('conflict', 'post-activation observation is not bound to the exact installation, plan, activation fence, and pinned package')
    }
    const ttl = this.options.receiptTtlMs ?? 30000
    const now = this.now()
    if (receipt.observedAt < plan.createdAt || receipt.observedAt > now || now > receipt.expiresAt
      || receipt.expiresAt - receipt.observedAt > ttl) {
      throw new ControlPlaneStoreError('expired', 'post-activation observation is outside its validity interval')
    }
    const signature = Buffer.from(receipt.signature, 'base64')
    if (!verify(null, Buffer.from(canonicalObservation(receipt)), createPublicKey(this.publicKey), signature)) {
      throw new ControlPlaneStoreError('invalid-input', 'post-activation observation signature is invalid')
    }
    const { signature: _signature, ...fields } = receipt
    return Object.freeze({ ...fields, signatureDigest: createHash('sha256').update(signature).digest('hex') })
  }
}

export function postActivationObservationSigningPayload(receipt: Omit<PostActivationObservationReceipt, 'signature'>): string {
  return canonicalObservation({ ...receipt, signature: '' })
}

// ---------------------------------------------------------------------------
// Owner-signed activation retraction (the only retracted-closure authority)
// ---------------------------------------------------------------------------

const retractionFields = ['schemaVersion', 'retractionId', 'authority', 'keyId', 'installationId', 'planId',
  'planDigest', 'activationId', 'fence', 'package', 'version', 'integrity', 'principal', 'reason',
  'decidedAt', 'expiresAt', 'signature'] as const

function canonicalRetraction(receipt: ActivationRetractionReceipt): string {
  return canonical({
    schemaVersion: receipt.schemaVersion, retractionId: receipt.retractionId, authority: receipt.authority,
    keyId: receipt.keyId, installationId: receipt.installationId, planId: receipt.planId,
    planDigest: receipt.planDigest, activationId: receipt.activationId, fence: receipt.fence,
    package: receipt.package, version: receipt.version, integrity: receipt.integrity,
    principal: receipt.principal.normalize('NFC').trim(), reason: receipt.reason,
    decidedAt: receipt.decidedAt, expiresAt: receipt.expiresAt,
  })
}

export function parseActivationRetraction(value: unknown): ActivationRetractionReceipt {
  const item = record(value, 'activation retraction')
  exact(item, retractionFields, 'activation retraction')
  if (item.schemaVersion !== 1 || typeof item.signature !== 'string' || !SIGNATURE.test(item.signature)
    || typeof item.principal !== 'string' || typeof item.reason !== 'string') {
    throw new ControlPlaneStoreError('invalid-input', 'activation retraction fields are invalid')
  }
  const principal = item.principal.normalize('NFC').trim()
  const receipt: ActivationRetractionReceipt = {
    schemaVersion: 1, retractionId: id(item.retractionId, 'retractionId'), authority: id(item.authority, 'authority'),
    keyId: id(item.keyId, 'keyId'), installationId: id(item.installationId, 'installationId', UUID),
    planId: id(item.planId, 'planId'), planDigest: id(item.planDigest, 'planDigest', DIGEST),
    activationId: id(item.activationId, 'activationId'), fence: integer(item.fence, 'fence', 1),
    package: id(item.package, 'package', PACKAGE), version: id(item.version, 'version', VERSION),
    integrity: id(item.integrity, 'integrity', INTEGRITY), principal, reason: item.reason,
    decidedAt: integer(item.decidedAt, 'decidedAt'), expiresAt: integer(item.expiresAt, 'expiresAt'),
    signature: item.signature,
  }
  if (principal === '' || principal.length > 256 || receipt.reason.trim() === '' || receipt.reason.length > 1024
    || receipt.expiresAt <= receipt.decidedAt) {
    throw new ControlPlaneStoreError('invalid-input', 'activation retraction values are invalid')
  }
  return receipt
}

export interface ActivationRetractionVerifyOptions {
  /** Submission freshness window; defaults to the approval 15 minute window. */
  receiptTtlMs?: number
}

export class Ed25519ActivationRetractionAuthority implements ActivationRetractionAuthority {
  constructor(
    readonly publicKey: string | Buffer,
    readonly expectedAuthority: string,
    readonly expectedKeyId: string,
    private readonly options: ActivationRetractionVerifyOptions = {},
    readonly now: () => number = Date.now,
  ) {}

  async verify(receiptInput: ActivationRetractionReceipt, plan: PluginActivationPlan, exact: WatchExactTarget):
    Promise<VerifiedActivationRetraction> {
    const receipt = parseActivationRetraction(receiptInput)
    if (receipt.authority !== this.expectedAuthority || receipt.keyId !== this.expectedKeyId
      || receipt.installationId !== plan.installationId || receipt.planId !== plan.id
      || receipt.planDigest !== plan.digest || !plan.activation
      || receipt.activationId !== plan.activation.id || receipt.fence !== plan.activation.fence
      || receipt.package !== exact.package || receipt.version !== exact.version || receipt.integrity !== exact.integrity) {
      throw new ControlPlaneStoreError('conflict', 'activation retraction is not bound to the exact owner authority, plan, activation fence, and pinned package')
    }
    // A retraction is a long-lived post-activation owner decision: it is bounded by
    // plan creation (not by the short proposal TTL) and by its own submission window.
    const ttl = this.options.receiptTtlMs ?? 900000
    const now = this.now()
    if (receipt.decidedAt < plan.createdAt || receipt.decidedAt > now || now > receipt.expiresAt
      || receipt.expiresAt - receipt.decidedAt > ttl) {
      throw new ControlPlaneStoreError('expired', 'activation retraction is outside its validity interval')
    }
    const signature = Buffer.from(receipt.signature, 'base64')
    if (!verify(null, Buffer.from(canonicalRetraction(receipt)), createPublicKey(this.publicKey), signature)) {
      throw new ControlPlaneStoreError('invalid-input', 'activation retraction signature is invalid')
    }
    const { signature: _signature, ...fields } = receipt
    return Object.freeze({ ...fields, signatureDigest: createHash('sha256').update(signature).digest('hex') })
  }
}

export function activationRetractionSigningPayload(receipt: Omit<ActivationRetractionReceipt, 'signature'>): string {
  return canonicalRetraction({ ...receipt, signature: '' })
}
