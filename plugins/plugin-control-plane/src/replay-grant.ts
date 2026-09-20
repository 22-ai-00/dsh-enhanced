import { createPublicKey, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { hostAttestationRequestDigest } from './attestation.js'
import { validateReplayCases, type ReplayCase } from './effect-blocked-replay.js'
import { runtimeConfigDigest } from './runtime-observer-protocol.js'
import type { HostAttestationRequest } from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const DOMAIN = 'dsh-effect-replay-grant/v1'

export interface ReplaySignedAuthority {
  mode: 'signed'
  authority: string
  keyId: string
  publicKeyPem: string
  scope: {
    installationId: string
    ledger: { id: string; path: string }
    plan: { id: string; digest: string }
    activation: { id: string; fence: number }
    profile: { name: string; path: string }
  }
  notBefore: number
  expiresAt: number
  maximumGrantMs: number
  cases: ReplayCase[]
}

export interface ReplayGrant {
  schemaVersion: 1
  kind: 'dsh-effect-replay-grant'
  authority: string
  keyId: string
  request: HostAttestationRequest
  endpointDigest: string
  caseDigest: string
  processId: number
  invocationId: string | null
  notBefore: number
  expiresAt: number
  signature: string
}

function fail(message: string): never { throw new Error(`replay grant: ${message}`) }
function exact(value: unknown, fields: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail(`${label} has unknown or missing fields`)
}
function integer(value: unknown, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum) fail(`${label} is invalid`)
  return value
}
function text(value: unknown, label: string, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`)
  return value
}
function path(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || !isAbsolute(value) || resolve(value) !== value
    || Array.from(value).some(character => character.charCodeAt(0) < 32)) fail(`${label} is invalid`)
  return value
}
function digest(value: unknown, label: string): string { return text(value, label, DIGEST) }

function assertIssuer(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('request issuer is invalid')
  if ((value as Record<string, unknown>).mode === 'owner-manual') { exact(value, ['mode'], 'request issuer'); return }
  exact(value, ['mode', 'id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'request issuer')
  if (value.mode !== 'configured-executable') fail('request issuer mode is invalid')
  text(value.id, 'request issuer id'); text(value.version, 'request issuer version'); path(value.path, 'request issuer path')
  digest(value.sha256, 'request issuer sha256'); text(value.authority, 'request issuer authority'); text(value.keyId, 'request issuer keyId')
  if (value.interpreter === null) return
  exact(value.interpreter, ['path', 'sha256'], 'request issuer interpreter')
  path(value.interpreter.path, 'request issuer interpreter path'); digest(value.interpreter.sha256, 'request issuer interpreter sha256')
}

function assertReplayRequest(value: unknown): asserts value is HostAttestationRequest {
  exact(value, ['schemaVersion', 'kind', 'operationId', 'requestedAt', 'receiptTtlMs', 'installationId', 'ledger', 'plan', 'activation', 'profile', 'issuer', 'phase', 'requirements', 'predecessor'], 'request')
  if (value.schemaVersion !== 2 || value.kind !== 'dsh-host-attestation-request' || value.phase !== 'effect-blocked-replay') fail('request schema or phase is invalid')
  text(value.operationId, 'request operationId', OPERATION_ID); integer(value.requestedAt, 'request requestedAt'); integer(value.receiptTtlMs, 'request receiptTtlMs', 1_000)
  if ((value.receiptTtlMs as number) > 300_000) fail('request receiptTtlMs is invalid')
  text(value.installationId, 'request installationId', UUID)
  exact(value.ledger, ['id', 'path'], 'request ledger'); text(value.ledger.id, 'request ledger id', UUID); path(value.ledger.path, 'request ledger path')
  exact(value.plan, ['id', 'digest'], 'request plan'); text(value.plan.id, 'request plan id'); digest(value.plan.digest, 'request plan digest')
  exact(value.activation, ['id', 'fence'], 'request activation'); text(value.activation.id, 'request activation id'); integer(value.activation.fence, 'request activation fence')
  exact(value.profile, ['name', 'path'], 'request profile'); text(value.profile.name, 'request profile name'); path(value.profile.path, 'request profile path')
  assertIssuer(value.issuer)
  exact(value.requirements, ['kind', 'minimumDeliveryAttempts', 'minimumToolExecutionAttempts', 'maximumExternalEffects'], 'request requirements')
  if (value.requirements.kind !== 'effect-blocked-replay' || value.requirements.maximumExternalEffects !== 0) fail('request requirements are invalid')
  integer(value.requirements.minimumDeliveryAttempts, 'request minimumDeliveryAttempts'); integer(value.requirements.minimumToolExecutionAttempts, 'request minimumToolExecutionAttempts')
  exact(value.predecessor, ['operationId', 'receiptId', 'phase', 'receiptDigest', 'hostGeneration'], 'request predecessor')
  if (value.predecessor.phase !== 'readiness' || value.predecessor.operationId === value.operationId) fail('request predecessor is invalid')
  text(value.predecessor.operationId, 'request predecessor operationId', OPERATION_ID); text(value.predecessor.receiptId, 'request predecessor receiptId')
  digest(value.predecessor.receiptDigest, 'request predecessor receiptDigest'); integer(value.predecessor.hostGeneration, 'request predecessor hostGeneration')
}

function assertScope(value: unknown): void {
  exact(value, ['installationId', 'ledger', 'plan', 'activation', 'profile'], 'authority scope')
  text(value.installationId, 'authority installationId', UUID)
  exact(value.ledger, ['id', 'path'], 'authority ledger'); text(value.ledger.id, 'authority ledger id', UUID); path(value.ledger.path, 'authority ledger path')
  exact(value.plan, ['id', 'digest'], 'authority plan'); text(value.plan.id, 'authority plan id'); digest(value.plan.digest, 'authority plan digest')
  exact(value.activation, ['id', 'fence'], 'authority activation'); text(value.activation.id, 'authority activation id'); integer(value.activation.fence, 'authority activation fence')
  exact(value.profile, ['name', 'path'], 'authority profile'); text(value.profile.name, 'authority profile name'); path(value.profile.path, 'authority profile path')
}

/** Validates only a public SPKI Ed25519 signer and a bounded authority window. */
export function validateReplaySignedAuthority(value: unknown): asserts value is ReplaySignedAuthority {
  runtimeConfigDigest(value)
  exact(value, ['mode', 'authority', 'keyId', 'publicKeyPem', 'scope', 'notBefore', 'expiresAt', 'maximumGrantMs', 'cases'], 'signed authority')
  if (value.mode !== 'signed') fail('authority mode is invalid')
  text(value.authority, 'authority'); text(value.keyId, 'keyId'); assertScope(value.scope)
  integer(value.notBefore, 'authority notBefore'); integer(value.expiresAt, 'authority expiresAt')
  if ((value.expiresAt as number) <= (value.notBefore as number) || (value.expiresAt as number) - (value.notBefore as number) > 86_400_000) fail('authority window is invalid')
  const maximumGrantMs = integer(value.maximumGrantMs, 'maximumGrantMs', 100)
  if (maximumGrantMs > 60_000) fail('maximumGrantMs is invalid')
  if (typeof value.publicKeyPem !== 'string') fail('publicKeyPem is invalid')
  let key: ReturnType<typeof createPublicKey>
  try { key = createPublicKey(value.publicKeyPem) } catch { fail('publicKeyPem is invalid') }
  if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'pem' }).toString() !== value.publicKeyPem) fail('publicKeyPem is not canonical public Ed25519 SPKI')
  validateReplayCases(value.cases)
}

export function assertReplayGrant(value: unknown): asserts value is ReplayGrant {
  runtimeConfigDigest(value)
  exact(value, ['schemaVersion', 'kind', 'authority', 'keyId', 'request', 'endpointDigest', 'caseDigest', 'processId', 'invocationId', 'notBefore', 'expiresAt', 'signature'], 'grant')
  if (value.schemaVersion !== 1 || value.kind !== 'dsh-effect-replay-grant') fail('grant schema is invalid')
  text(value.authority, 'grant authority'); text(value.keyId, 'grant keyId'); assertReplayRequest(value.request)
  digest(value.endpointDigest, 'endpointDigest'); digest(value.caseDigest, 'caseDigest'); integer(value.processId, 'processId')
  if (value.invocationId !== null) text(value.invocationId, 'invocationId', /^[a-f0-9]{32}$/u)
  integer(value.notBefore, 'grant notBefore'); integer(value.expiresAt, 'grant expiresAt')
  if ((value.expiresAt as number) <= (value.notBefore as number)) fail('grant validity interval is invalid')
  if (typeof value.signature !== 'string' || !BASE64.test(value.signature)) fail('grant signature is invalid')
  const signature = Buffer.from(value.signature, 'base64')
  if (signature.length !== 64 || signature.toString('base64') !== value.signature) fail('grant signature is invalid')
}

/** The payload contains a bounded canonical digest, so object access happens only after getter rejection. */
export function replayGrantSigningPayload(grant: Omit<ReplayGrant, 'signature'>): string {
  return `${DOMAIN}\n${runtimeConfigDigest(grant)}`
}

export function verifyReplayGrant(grantInput: ReplayGrant, authorityInput: ReplaySignedAuthority, binding: {
  endpointDigest: string
  caseDigest: string
  profilePath: string
  operationId: string
  requestDigest: string
}, now: number): { scopeDigest: string; grantDigest: string; expiresAt: number } {
  assertReplayGrant(grantInput); validateReplaySignedAuthority(authorityInput); runtimeConfigDigest(binding)
  exact(binding, ['endpointDigest', 'caseDigest', 'profilePath', 'operationId', 'requestDigest'], 'binding')
  digest(binding.endpointDigest, 'binding endpointDigest'); digest(binding.caseDigest, 'binding caseDigest'); path(binding.profilePath, 'binding profilePath')
  text(binding.operationId, 'binding operationId', OPERATION_ID); digest(binding.requestDigest, 'binding requestDigest'); integer(now, 'now')
  const grant = grantInput; const authority = authorityInput
  const requestDigest = hostAttestationRequestDigest(grant.request)
  const replay = validateReplayCases(authority.cases)
  const requirements = grant.request.requirements
  if (requirements.kind !== 'effect-blocked-replay' || requirements.maximumExternalEffects !== 0) fail('grant request requirements are invalid')
  if (grant.authority !== authority.authority || grant.keyId !== authority.keyId || grant.endpointDigest !== binding.endpointDigest
    || grant.caseDigest !== binding.caseDigest || grant.caseDigest !== replay.caseDigest || grant.request.operationId !== binding.operationId
    || requestDigest !== binding.requestDigest || grant.request.profile.path !== binding.profilePath
    || grant.request.installationId !== authority.scope.installationId || grant.request.ledger.id !== authority.scope.ledger.id
    || grant.request.ledger.path !== authority.scope.ledger.path || grant.request.plan.id !== authority.scope.plan.id
    || grant.request.plan.digest !== authority.scope.plan.digest || grant.request.activation.id !== authority.scope.activation.id
    || grant.request.activation.fence !== authority.scope.activation.fence || grant.request.profile.name !== authority.scope.profile.name
    || grant.request.profile.path !== authority.scope.profile.path) fail('grant is not bound to authority scope and request')
  const toolCases = replay.cases.filter(item => item.kind === 'tool').length
  const deliveryCases = replay.cases.filter(item => item.kind === 'delivery').length
  if (toolCases < requirements.minimumToolExecutionAttempts || deliveryCases < requirements.minimumDeliveryAttempts) fail('grant cases do not meet request minimums')
  if (grant.request.requestedAt > grant.notBefore || grant.notBefore < authority.notBefore || grant.expiresAt > authority.expiresAt
    || grant.expiresAt - grant.notBefore > authority.maximumGrantMs || grant.expiresAt - grant.request.requestedAt > grant.request.receiptTtlMs
    || now < grant.notBefore || now >= grant.expiresAt) fail('grant is outside its validity interval')
  const unsigned: Omit<ReplayGrant, 'signature'> = { schemaVersion: grant.schemaVersion, kind: grant.kind, authority: grant.authority,
    keyId: grant.keyId, request: grant.request, endpointDigest: grant.endpointDigest, caseDigest: grant.caseDigest,
    processId: grant.processId, invocationId: grant.invocationId, notBefore: grant.notBefore, expiresAt: grant.expiresAt }
  const signature = Buffer.from(grant.signature, 'base64')
  if (!verify(null, Buffer.from(replayGrantSigningPayload(unsigned)), createPublicKey(authority.publicKeyPem), signature)) fail('grant signature is invalid')
  return Object.freeze({ scopeDigest: runtimeConfigDigest(authority.scope), grantDigest: runtimeConfigDigest(grant), expiresAt: grant.expiresAt })
}
