import { createHash, createPublicKey, verify } from 'node:crypto'
import { ControlPlaneStoreError } from './store.js'
import type {
  HostAttestationAuthority,
  HostAttestationEvidence,
  HostAttestationReceipt,
  HostAttestationRequest,
  PluginActivationPlan,
  VerifiedHostAttestation,
} from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const phases = new Set(['reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health'])

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

function text(value: unknown, label: string, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new ControlPlaneStoreError('invalid-input', `${label} is invalid`)
  return value
}

function parseEvidence(value: unknown): HostAttestationEvidence {
  const item = record(value, 'host attestation evidence')
  const kind = item.kind
  if (kind === 'reload') {
    exact(item, ['kind', 'reloaded', 'previousHostGeneration', 'currentHostGeneration', 'probeDigest'], 'reload evidence')
    if (typeof item.reloaded !== 'boolean') throw new ControlPlaneStoreError('invalid-input', 'reload evidence reloaded must be boolean')
    return { kind, reloaded: item.reloaded, previousHostGeneration: integer(item.previousHostGeneration, 'previousHostGeneration'),
      currentHostGeneration: integer(item.currentHostGeneration, 'currentHostGeneration', 1), probeDigest: text(item.probeDigest, 'probeDigest', DIGEST) }
  }
  if (kind === 'readiness') {
    exact(item, ['kind', 'checks', 'failures', 'probeDigest'], 'readiness evidence')
    const checks = integer(item.checks, 'checks'); const failures = integer(item.failures, 'failures')
    if (failures > checks) throw new ControlPlaneStoreError('invalid-input', 'readiness failures exceed checks')
    return { kind, checks, failures, probeDigest: text(item.probeDigest, 'probeDigest', DIGEST) }
  }
  if (kind === 'effect-blocked-replay') {
    exact(item, ['kind', 'deliveryAttempts', 'deliveryBlocked', 'toolExecutionAttempts', 'toolExecutionBlocked', 'externalEffects', 'replayDigest'], 'effect-blocked replay evidence')
    const deliveryAttempts = integer(item.deliveryAttempts, 'deliveryAttempts'); const deliveryBlocked = integer(item.deliveryBlocked, 'deliveryBlocked')
    const toolExecutionAttempts = integer(item.toolExecutionAttempts, 'toolExecutionAttempts'); const toolExecutionBlocked = integer(item.toolExecutionBlocked, 'toolExecutionBlocked')
    if (deliveryBlocked > deliveryAttempts || toolExecutionBlocked > toolExecutionAttempts) throw new ControlPlaneStoreError('invalid-input', 'blocked effects exceed attempted effects')
    return { kind, deliveryAttempts, deliveryBlocked,
      toolExecutionAttempts, toolExecutionBlocked,
      externalEffects: integer(item.externalEffects, 'externalEffects'), replayDigest: text(item.replayDigest, 'replayDigest', DIGEST) }
  }
  if (kind === 'shadow') {
    exact(item, ['kind', 'samples', 'mismatches', 'externalEffects', 'traceDigest'], 'shadow evidence')
    const samples = integer(item.samples, 'samples'); const mismatches = integer(item.mismatches, 'mismatches')
    if (mismatches > samples) throw new ControlPlaneStoreError('invalid-input', 'shadow mismatches exceed samples')
    return { kind, samples, mismatches,
      externalEffects: integer(item.externalEffects, 'externalEffects'), traceDigest: text(item.traceDigest, 'traceDigest', DIGEST) }
  }
  if (kind === 'canary') {
    exact(item, ['kind', 'exposureId', 'exposures', 'samples', 'failures', 'traceDigest'], 'canary evidence')
    const samples = integer(item.samples, 'samples'); const failures = integer(item.failures, 'failures')
    if (failures > samples) throw new ControlPlaneStoreError('invalid-input', 'canary failures exceed samples')
    return { kind, exposureId: text(item.exposureId, 'exposureId'), exposures: integer(item.exposures, 'exposures'),
      samples, failures, traceDigest: text(item.traceDigest, 'traceDigest', DIGEST) }
  }
  if (kind === 'soak') {
    exact(item, ['kind', 'windowStartedAt', 'windowEndedAt', 'samples', 'failures', 'traceDigest'], 'soak evidence')
    const windowStartedAt = integer(item.windowStartedAt, 'windowStartedAt'); const windowEndedAt = integer(item.windowEndedAt, 'windowEndedAt')
    if (windowEndedAt < windowStartedAt) throw new ControlPlaneStoreError('invalid-input', 'soak evidence window is reversed')
    const samples = integer(item.samples, 'samples'); const failures = integer(item.failures, 'failures')
    if (failures > samples) throw new ControlPlaneStoreError('invalid-input', 'soak failures exceed samples')
    return { kind, windowStartedAt, windowEndedAt, samples,
      failures, traceDigest: text(item.traceDigest, 'traceDigest', DIGEST) }
  }
  if (kind === 'health') {
    exact(item, ['kind', 'checks', 'failures', 'probeDigest'], 'health evidence')
    const checks = integer(item.checks, 'checks'); const failures = integer(item.failures, 'failures')
    if (failures > checks) throw new ControlPlaneStoreError('invalid-input', 'health failures exceed checks')
    return { kind, checks, failures, probeDigest: text(item.probeDigest, 'probeDigest', DIGEST) }
  }
  throw new ControlPlaneStoreError('invalid-input', 'host attestation evidence kind is invalid')
}

function canonicalReceipt(receipt: HostAttestationReceipt): string {
  return canonical({
    schemaVersion: receipt.schemaVersion, receiptId: receipt.receiptId, authority: receipt.authority,
    keyId: receipt.keyId, installationId: receipt.installationId, planId: receipt.planId,
    planDigest: receipt.planDigest, activationId: receipt.activationId, fence: receipt.fence,
    operationId: receipt.operationId, requestDigest: receipt.requestDigest, phase: receipt.phase,
    outcome: receipt.outcome, hostGeneration: receipt.hostGeneration, evidence: receipt.evidence,
    evidenceDigest: receipt.evidenceDigest, observedAt: receipt.observedAt, expiresAt: receipt.expiresAt,
  })
}

export function hostAttestationRequestDigest(request: HostAttestationRequest): string { return digest(request) }
export function hostAttestationEvidenceDigest(evidence: HostAttestationEvidence): string { return digest(evidence) }

export function parseHostAttestationReceipt(value: unknown): HostAttestationReceipt {
  const item = record(value, 'host attestation')
  exact(item, ['schemaVersion', 'receiptId', 'authority', 'keyId', 'installationId', 'planId', 'planDigest', 'activationId',
    'fence', 'operationId', 'requestDigest', 'phase', 'outcome', 'hostGeneration', 'evidence', 'evidenceDigest', 'observedAt', 'expiresAt', 'signature'], 'host attestation')
  if (item.schemaVersion !== 2 || typeof item.phase !== 'string' || !phases.has(item.phase)
    || (item.outcome !== 'passed' && item.outcome !== 'failed') || typeof item.signature !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(item.signature)) throw new ControlPlaneStoreError('invalid-input', 'host attestation fields are invalid')
  const receipt: HostAttestationReceipt = {
    schemaVersion: 2, receiptId: text(item.receiptId, 'receiptId'), authority: text(item.authority, 'authority'),
    keyId: text(item.keyId, 'keyId'), installationId: text(item.installationId, 'installationId', UUID),
    planId: text(item.planId, 'planId'), planDigest: text(item.planDigest, 'planDigest', DIGEST), activationId: text(item.activationId, 'activationId'),
    fence: integer(item.fence, 'fence', 1), operationId: text(item.operationId, 'operationId'), requestDigest: text(item.requestDigest, 'requestDigest', DIGEST),
    phase: item.phase as HostAttestationReceipt['phase'], outcome: item.outcome, hostGeneration: integer(item.hostGeneration, 'hostGeneration', 1),
    evidence: parseEvidence(item.evidence), evidenceDigest: text(item.evidenceDigest, 'evidenceDigest', DIGEST),
    observedAt: integer(item.observedAt, 'observedAt'), expiresAt: integer(item.expiresAt, 'expiresAt'), signature: item.signature,
  }
  if (receipt.expiresAt <= receipt.observedAt || hostAttestationEvidenceDigest(receipt.evidence) !== receipt.evidenceDigest) {
    throw new ControlPlaneStoreError('invalid-input', 'host attestation evidence digest or validity interval is invalid')
  }
  return receipt
}

function assertPassedEvidence(receipt: HostAttestationReceipt, request: HostAttestationRequest): void {
  const evidence = receipt.evidence; const requirements = request.requirements
  if (evidence.kind !== request.phase || requirements.kind !== request.phase) throw new ControlPlaneStoreError('conflict', 'host evidence is not for the requested phase')
  if (receipt.outcome === 'failed') return
  let passed = false
  if (evidence.kind === 'reload' && requirements.kind === 'reload') {
    passed = evidence.reloaded && evidence.currentHostGeneration === receipt.hostGeneration
      && evidence.previousHostGeneration === requirements.previousHostGeneration
      && evidence.currentHostGeneration > requirements.previousHostGeneration
  } else if (evidence.kind === 'readiness' && requirements.kind === 'readiness') {
    passed = evidence.checks >= requirements.minimumChecks && evidence.failures === 0
  } else if (evidence.kind === 'effect-blocked-replay' && requirements.kind === 'effect-blocked-replay') {
    passed = evidence.deliveryAttempts >= requirements.minimumDeliveryAttempts && evidence.deliveryBlocked === evidence.deliveryAttempts
      && evidence.toolExecutionAttempts >= requirements.minimumToolExecutionAttempts && evidence.toolExecutionBlocked === evidence.toolExecutionAttempts
      && evidence.externalEffects <= requirements.maximumExternalEffects
  } else if (evidence.kind === 'shadow' && requirements.kind === 'shadow') {
    passed = evidence.samples >= requirements.minimumSamples && evidence.mismatches <= requirements.maximumMismatches
      && evidence.externalEffects <= requirements.maximumExternalEffects
  } else if (evidence.kind === 'canary' && requirements.kind === 'canary') {
    passed = evidence.exposures === requirements.maximumExposures && evidence.samples >= requirements.minimumSamples
      && evidence.failures <= requirements.maximumFailures
  } else if (evidence.kind === 'soak' && requirements.kind === 'soak') {
    const failureRate = evidence.samples === 0 ? Number.POSITIVE_INFINITY : evidence.failures / evidence.samples
    passed = evidence.windowEndedAt - evidence.windowStartedAt >= requirements.minimumWindowMs
      && evidence.samples >= requirements.minimumSamples && failureRate <= requirements.maximumFailureRate
      && evidence.windowStartedAt >= request.requestedAt && evidence.windowEndedAt <= receipt.observedAt
  } else if (evidence.kind === 'health' && requirements.kind === 'health') {
    passed = evidence.checks >= requirements.minimumChecks && evidence.failures <= requirements.maximumFailures
  }
  if (!passed) throw new ControlPlaneStoreError('invalid-input', `passed ${request.phase} receipt does not satisfy its signed evidence contract`)
}

export class Ed25519HostAttestationAuthority implements HostAttestationAuthority {
  constructor(
    readonly publicKey: string | Buffer,
    readonly expectedAuthority: string,
    readonly expectedKeyId: string,
    readonly now: () => number = Date.now,
  ) {}

  async verify(receiptInput: HostAttestationReceipt, plan: PluginActivationPlan, request: HostAttestationRequest): Promise<VerifiedHostAttestation> {
    const receipt = parseHostAttestationReceipt(receiptInput)
    const configuredIssuerMismatch = request.issuer.mode === 'configured-executable'
      && (receipt.authority !== request.issuer.authority || receipt.keyId !== request.issuer.keyId)
    if (receipt.authority !== this.expectedAuthority || receipt.keyId !== this.expectedKeyId
      || configuredIssuerMismatch
      || receipt.installationId !== plan.installationId || receipt.planId !== plan.id
      || receipt.planDigest !== plan.digest || receipt.activationId !== plan.activation?.id
      || receipt.fence !== plan.activation.fence || receipt.phase !== request.phase
      || receipt.operationId !== request.operationId || receipt.requestDigest !== hostAttestationRequestDigest(request)) {
      throw new ControlPlaneStoreError('conflict', 'host attestation is not bound to the exact request, installation, plan, activation fence, and phase')
    }
    const now = this.now()
    if (receipt.observedAt < request.requestedAt || receipt.observedAt < plan.createdAt || receipt.observedAt > now || now > receipt.expiresAt
      || receipt.expiresAt - receipt.observedAt > request.receiptTtlMs) {
      throw new ControlPlaneStoreError('expired', 'host attestation is outside its validity interval')
    }
    const signature = Buffer.from(receipt.signature, 'base64')
    if (!verify(null, Buffer.from(canonicalReceipt(receipt)), createPublicKey(this.publicKey), signature)) {
      throw new ControlPlaneStoreError('invalid-input', 'host attestation signature is invalid')
    }
    assertPassedEvidence(receipt, request)
    const { signature: _signature, ...fields } = receipt
    return Object.freeze({ ...fields, signatureDigest: createHash('sha256').update(signature).digest('hex') })
  }
}

export function hostAttestationSigningPayload(receipt: Omit<HostAttestationReceipt, 'signature'>): string {
  return canonicalReceipt({ ...receipt, signature: '' })
}
