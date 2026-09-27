import { createHash, createPublicKey, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { ControlPlaneStoreError } from './store.js'
import type { PluginControlTrustConfig } from './trust.js'
import type { HostAttestationRequest } from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

export interface RuntimeEpochRequest {
  schemaVersion: 1
  kind: 'dsh-runtime-epoch-request'
  operationId: string
  requestedAt: number
  receiptTtlMs: number
  installationId: string
  ledger: { id: string; path: string }
  plan: { id: string; digest: string }
  activation: { id: string; fence: number }
  profile: { name: string; path: string }
  issuer: Extract<HostAttestationRequest['issuer'], { mode: 'configured-executable' }>
  predecessor: { operationId: string; receiptDigest: string; hostGeneration: number }
  sequence: number
  runtimeIdentityDigest: string
}

export interface RuntimeEpochReceipt {
  schemaVersion: 1
  kind: 'dsh-runtime-epoch-receipt'
  receiptId: string
  operationId: string
  requestDigest: string
  installationId: string
  planId: string
  planDigest: string
  activationId: string
  fence: number
  hostGeneration: number
  sequence: number
  runtimeIdentityDigest: string
  authority: string
  keyId: string
  outcome: 'passed' | 'failed'
  observedAt: number
  expiresAt: number
  evidence: { checks: number; failures: number; probeDigest: string }
  signature: string
}

function invalid(message: string): never { throw new ControlPlaneStoreError('invalid-input', `runtime epoch: ${message}`) }
function conflict(message: string): never { throw new ControlPlaneStoreError('conflict', `runtime epoch: ${message}`) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) invalid(`${label} fields are invalid`)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`)
  return value
}
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(`${label} is invalid`)
  return Number(value)
}
function path(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value === '/') invalid(`${label} is invalid`)
  return value
}
function pin(value: unknown, label: string): { path: string; sha256: string } {
  const item = record(value, ['path', 'sha256'], label)
  return { path: path(item.path, `${label} path`), sha256: text(item.sha256, `${label} digest`, DIGEST) }
}

export function parseRuntimeEpochRequest(value: unknown): RuntimeEpochRequest {
  const item = record(value, ['schemaVersion', 'kind', 'operationId', 'requestedAt', 'receiptTtlMs', 'installationId',
    'ledger', 'plan', 'activation', 'profile', 'issuer', 'predecessor', 'sequence', 'runtimeIdentityDigest'], 'request')
  if (item.schemaVersion !== 1 || item.kind !== 'dsh-runtime-epoch-request') invalid('request version or kind is invalid')
  const ledger = record(item.ledger, ['id', 'path'], 'ledger')
  const plan = record(item.plan, ['id', 'digest'], 'plan')
  const activation = record(item.activation, ['id', 'fence'], 'activation')
  const profile = record(item.profile, ['name', 'path'], 'profile')
  const issuer = record(item.issuer, ['mode', 'id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'issuer')
  if (issuer.mode !== 'configured-executable') invalid('configured issuer is required')
  const predecessor = record(item.predecessor, ['operationId', 'receiptDigest', 'hostGeneration'], 'predecessor')
  const operationId = text(item.operationId, 'operationId')
  if (operationId.length > 152 || predecessor.operationId === operationId) invalid('operation lineage is invalid')
  const profileName = text(profile.name, 'profile name', /^[a-z0-9][a-z0-9-]{0,63}$/u)
  const profilePath = path(profile.path, 'profile path')
  if (profilePath.split('/').at(-1) !== profileName || profilePath.split('/').at(-2) !== 'profiles') invalid('profile path differs from name')
  return {
    schemaVersion: 1, kind: 'dsh-runtime-epoch-request', operationId,
    requestedAt: integer(item.requestedAt, 'requestedAt'), receiptTtlMs: integer(item.receiptTtlMs, 'receiptTtlMs', 1, 3_600_000),
    installationId: text(item.installationId, 'installationId', UUID),
    ledger: { id: text(ledger.id, 'ledger id'), path: path(ledger.path, 'ledger path') },
    plan: { id: text(plan.id, 'plan id'), digest: text(plan.digest, 'plan digest', DIGEST) },
    activation: { id: text(activation.id, 'activation id'), fence: integer(activation.fence, 'activation fence', 1) },
    profile: { name: profileName, path: profilePath },
    issuer: { mode: 'configured-executable', id: text(issuer.id, 'issuer id'), version: text(issuer.version, 'issuer version', /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u),
      ...pin({ path: issuer.path, sha256: issuer.sha256 }, 'issuer'),
      interpreter: issuer.interpreter === null ? null : pin(issuer.interpreter, 'issuer interpreter'),
      authority: text(issuer.authority, 'issuer authority'), keyId: text(issuer.keyId, 'issuer keyId') },
    predecessor: { operationId: text(predecessor.operationId, 'predecessor operation'),
      receiptDigest: text(predecessor.receiptDigest, 'predecessor digest', DIGEST),
      hostGeneration: integer(predecessor.hostGeneration, 'predecessor generation', 1) },
    sequence: integer(item.sequence, 'sequence', 1),
    runtimeIdentityDigest: text(item.runtimeIdentityDigest, 'runtime identity digest', DIGEST),
  }
}

export function parseRuntimeEpochReceipt(value: unknown): RuntimeEpochReceipt {
  const item = record(value, ['schemaVersion', 'kind', 'receiptId', 'operationId', 'requestDigest', 'installationId',
    'planId', 'planDigest', 'activationId', 'fence', 'hostGeneration', 'sequence', 'runtimeIdentityDigest',
    'authority', 'keyId', 'outcome', 'observedAt', 'expiresAt', 'evidence', 'signature'], 'receipt')
  if (item.schemaVersion !== 1 || item.kind !== 'dsh-runtime-epoch-receipt'
    || (item.outcome !== 'passed' && item.outcome !== 'failed')) invalid('receipt version, kind or outcome is invalid')
  const evidence = record(item.evidence, ['checks', 'failures', 'probeDigest'], 'evidence')
  const checks = integer(evidence.checks, 'checks', 2, 256)
  const failures = integer(evidence.failures, 'failures', 0, checks)
  const signature = text(item.signature, 'signature', /^[A-Za-z0-9+/]+={0,2}$/u)
  if (Buffer.from(signature, 'base64').length !== 64 || Buffer.from(signature, 'base64').toString('base64') !== signature) invalid('signature encoding is invalid')
  const receipt: RuntimeEpochReceipt = {
    schemaVersion: 1, kind: 'dsh-runtime-epoch-receipt', receiptId: text(item.receiptId, 'receiptId'),
    operationId: text(item.operationId, 'operationId'), requestDigest: text(item.requestDigest, 'requestDigest', DIGEST),
    installationId: text(item.installationId, 'installationId', UUID), planId: text(item.planId, 'planId'),
    planDigest: text(item.planDigest, 'planDigest', DIGEST), activationId: text(item.activationId, 'activationId'),
    fence: integer(item.fence, 'fence', 1), hostGeneration: integer(item.hostGeneration, 'hostGeneration', 1),
    sequence: integer(item.sequence, 'sequence', 1), runtimeIdentityDigest: text(item.runtimeIdentityDigest, 'runtime identity digest', DIGEST),
    authority: text(item.authority, 'authority'), keyId: text(item.keyId, 'keyId'), outcome: item.outcome,
    observedAt: integer(item.observedAt, 'observedAt'), expiresAt: integer(item.expiresAt, 'expiresAt'),
    evidence: { checks, failures, probeDigest: text(evidence.probeDigest, 'probe digest', DIGEST) }, signature,
  }
  if (receipt.expiresAt <= receipt.observedAt || (receipt.outcome === 'passed' && failures !== 0)
    || (receipt.outcome === 'failed' && failures === 0)) invalid('receipt interval or evidence is invalid')
  return receipt
}

export function runtimeEpochRequestDigest(request: RuntimeEpochRequest): string { return digest(parseRuntimeEpochRequest(request)) }
export function runtimeEpochIdentityDigest(observation: Record<string, unknown>): string {
  const { challenge: _challenge, observedAt: _observedAt, ...identity } = observation
  return digest(identity)
}
export function runtimeEpochSigningPayload(receipt: Omit<RuntimeEpochReceipt, 'signature'>): string { return canonical(receipt) }

export function verifyRuntimeEpochReceipt(receiptInput: unknown, requestInput: unknown,
  trust: Pick<PluginControlTrustConfig, 'installationId' | 'hostAttestationKeys'>, now = Date.now()): RuntimeEpochReceipt {
  const request = parseRuntimeEpochRequest(requestInput)
  const receipt = parseRuntimeEpochReceipt(receiptInput)
  if (receipt.receiptId !== `receipt:${request.operationId}` || receipt.operationId !== request.operationId
    || receipt.requestDigest !== runtimeEpochRequestDigest(request) || receipt.installationId !== request.installationId
    || receipt.installationId !== trust.installationId || receipt.planId !== request.plan.id || receipt.planDigest !== request.plan.digest
    || receipt.activationId !== request.activation.id || receipt.fence !== request.activation.fence
    || receipt.hostGeneration !== request.predecessor.hostGeneration || receipt.sequence !== request.sequence
    || receipt.runtimeIdentityDigest !== request.runtimeIdentityDigest
    || receipt.authority !== request.issuer.authority || receipt.keyId !== request.issuer.keyId) conflict('receipt differs from the exact request')
  if (receipt.observedAt < request.requestedAt || receipt.observedAt > now || now > receipt.expiresAt
    || receipt.expiresAt - receipt.observedAt > request.receiptTtlMs) {
    throw new ControlPlaneStoreError('expired', 'runtime epoch receipt is outside its validity interval')
  }
  const key = trust.hostAttestationKeys.find(candidate => candidate.authority === receipt.authority && candidate.keyId === receipt.keyId)
  const { signature: _signature, ...unsigned } = receipt
  if (!key || !verify(null, Buffer.from(runtimeEpochSigningPayload(unsigned)),
    createPublicKey(key.publicKeyPem), Buffer.from(receipt.signature, 'base64'))) invalid('receipt signature or authority is invalid')
  return Object.freeze(receipt)
}
