import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants, lstatSync, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, resolve } from 'node:path'
import { hostAttestationEvidenceDigest, hostAttestationRequestDigest, hostAttestationSigningPayload, parseHostAttestationReceipt } from './attestation.js'
import { resolveTrustKey, type PluginControlTrustConfig } from './trust.js'
import type { HostAttestationOperation, HostAttestationReceipt, HostAttestationRequest, PluginActivationPlan } from './types.js'
import { assertRuntimeObservation, runtimeConfigDigest, type RuntimeObservation } from './runtime-observer-protocol.js'

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024
const HEX = /^[a-f0-9]{64}$/u

export class DeploymentReadinessError extends Error {
  constructor(message: string) { super(`deployment readiness: ${message}`); this.name = 'DeploymentReadinessError' }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value !== 'object') throw new DeploymentReadinessError('non-JSON retained value')
  const record = value as Record<string, unknown>
  if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) throw new DeploymentReadinessError('non-plain retained record')
  return `{${Object.entries(record).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

function safeFile(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new DeploymentReadinessError('journal path is not canonical')
  const directory = dirname(path); const uid = process.getuid?.()
  const parent = lstatSync(directory); const named = lstatSync(path, { bigint: true })
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || (uid !== undefined && parent.uid !== uid)
    || realpathSync(directory) !== directory || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1n
    || named.size < 1n || named.size > BigInt(MAX_JOURNAL_BYTES) || (named.mode & 0o077n) !== 0n
    || (uid !== undefined && named.uid !== BigInt(uid))) throw new DeploymentReadinessError('journal is not an owner-private regular file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd, { bigint: true }); const byte = Buffer.alloc(1); readSync(fd, byte, 0, 1, 0)
    const after = lstatSync(path, { bigint: true })
    if (opened.dev !== named.dev || opened.ino !== named.ino || after.dev !== opened.dev || after.ino !== opened.ino) throw new DeploymentReadinessError('journal pathname changed')
  } finally { closeSync(fd) }
}

function parseBounded(source: unknown, label: string): Record<string, unknown> {
  if (typeof source !== 'string' || Buffer.byteLength(source) < 2 || Buffer.byteLength(source) > MAX_JSON_BYTES) throw new DeploymentReadinessError(`${label} is missing or oversized`)
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new DeploymentReadinessError(`${label} is invalid JSON`) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DeploymentReadinessError(`${label} is not an object`)
  return value as Record<string, unknown>
}

function stableRuntime(value: RuntimeObservation): Record<string, unknown> {
  const { challenge: _challenge, observedAt: _observedAt, ...stable } = value
  return stable
}

export interface DeploymentReadinessBinding {
  readonly planId: string
  readonly activationId: string
  readonly fence: number
  readonly hostGeneration: number
  readonly operationId: string
  readonly receiptDigest: string
  readonly readinessDigest: string
  readonly runtimeDigest: string
  readonly planDigest: string
  readonly installationId: string
  readonly profilePath: string
  readonly exact: Readonly<{ package: string; version: string; integrity: string }>
}

/**
 * Synchronously binds a current Host runtime sample to a retained, already
 * applied signed readiness receipt. The caller owns current-plan selection and
 * Store applied-status checks; this function never opens that Store.
 */
export function captureRetainedDeploymentReadiness(input: {
  plan: PluginActivationPlan
  operation: HostAttestationOperation
  receipt: HostAttestationReceipt
  trust: PluginControlTrustConfig
  journalPath: string
  runtime: RuntimeObservation
}): DeploymentReadinessBinding {
  const { plan, operation, trust, journalPath, runtime } = input
  const receipt = parseHostAttestationReceipt(input.receipt)
  if (operation.status !== 'applied' || operation.phase !== 'readiness' || operation.receipt === undefined
    || canonical(operation.receipt) !== canonical(receipt) || operation.request.schemaVersion !== 2
    || operation.request.phase !== 'readiness') throw new DeploymentReadinessError('operation is not the exact applied readiness receipt')
  const request = operation.request as HostAttestationRequest
  if (request.installationId !== plan.installationId || request.installationId !== trust.installationId
    || request.plan.id !== plan.id || request.plan.digest !== plan.digest
    || request.activation.id !== plan.activation?.id || request.activation.fence !== plan.activation?.fence
    || request.ledger.id !== plan.ledger.id || request.ledger.path !== plan.ledger.path
    || request.ledger.id !== trust.ledger.id || request.ledger.path !== trust.ledger.path
    || request.profile.path !== plan.target.profilePath) {
    throw new DeploymentReadinessError('request is outside the admitted plan and trust scope')
  }
  if (operation.planId !== plan.id || operation.requestDigest !== hostAttestationRequestDigest(request)
    || receipt.outcome !== 'passed' || receipt.evidence.kind !== 'readiness' || receipt.evidence.failures !== 0
    || receipt.operationId !== operation.operationId || receipt.planId !== plan.id || receipt.planDigest !== plan.digest
    || receipt.installationId !== plan.installationId || receipt.activationId !== plan.activation?.id || receipt.fence !== plan.activation?.fence
    || receipt.requestDigest !== operation.requestDigest || receipt.phase !== request.phase
    || request.predecessor === null || receipt.hostGeneration !== request.predecessor.hostGeneration
    || request.requirements.kind !== 'readiness' || receipt.evidence.checks < request.requirements.minimumChecks
    || receipt.evidenceDigest !== hostAttestationEvidenceDigest(receipt.evidence)) {
    throw new DeploymentReadinessError('receipt does not bind this successful plan activation and readiness generation')
  }
  const key = resolveTrustKey(trust, 'host-attestation', receipt.authority, receipt.keyId)
  if (request.issuer.mode === 'configured-executable'
    && (receipt.authority !== request.issuer.authority || receipt.keyId !== request.issuer.keyId)) {
    throw new DeploymentReadinessError('receipt issuer differs from configured attestor')
  }
  // Historical verification intentionally fixes time at observation: later
  // receipt expiry cannot erase the identity already admitted by the Store.
  const { signature: _signature, ...unsigned } = receipt
  if (!verify(null, Buffer.from(hostAttestationSigningPayload(unsigned)), createPublicKey(key.publicKeyPem), Buffer.from(receipt.signature, 'base64')))
    throw new DeploymentReadinessError('receipt signature is invalid')
  if (receipt.observedAt < request.requestedAt || receipt.observedAt < plan.createdAt || receipt.expiresAt <= receipt.observedAt
    || receipt.expiresAt - receipt.observedAt > request.receiptTtlMs) throw new DeploymentReadinessError('receipt historical validity is invalid')
  safeFile(journalPath)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(journalPath, { readOnly: true })
    database.exec('PRAGMA query_only = ON')
    const row = database.prepare('SELECT operation_id, request_digest, observation, receipt FROM readiness WHERE operation_id = ?').get(receipt.operationId) as
      { operation_id?: unknown; request_digest?: unknown; observation?: unknown; receipt?: unknown } | undefined
    if (!row || row.operation_id !== receipt.operationId || row.request_digest !== receipt.requestDigest) throw new DeploymentReadinessError('retained readiness row does not bind receipt request')
    const retainedReceipt = parseHostAttestationReceipt(parseBounded(row.receipt, 'retained receipt'))
    if (canonical(retainedReceipt) !== canonical(receipt)) throw new DeploymentReadinessError('retained receipt differs from applied receipt')
    const observation = parseBounded(row.observation, 'retained observation')
    if (digest(observation) !== receipt.evidence.probeDigest || observation.requestDigest !== receipt.requestDigest
      || !('runtime' in observation) || typeof observation.runtime !== 'object' || observation.runtime === null) {
      throw new DeploymentReadinessError('retained observation digest or runtime binding differs')
    }
    assertRuntimeObservation(runtime)
    if (runtime.observedAt < receipt.observedAt || runtime.profilePath !== plan.target.profilePath || runtime.entries.some(entry => !entry.active)) {
      throw new DeploymentReadinessError('current runtime is older than readiness or has inactive entries')
    }
    const current = stableRuntime(runtime)
    if (canonical(current) !== canonical(observation.runtime)) throw new DeploymentReadinessError('current runtime differs from retained stable readiness runtime')
    const runtimeDigest = runtimeConfigDigest(current)
    if (!HEX.test(receipt.evidence.probeDigest)) throw new DeploymentReadinessError('readiness probe digest is invalid')
    return Object.freeze({ planId: plan.id, activationId: receipt.activationId, fence: receipt.fence, hostGeneration: receipt.hostGeneration,
      operationId: receipt.operationId, receiptDigest: digest(receipt), readinessDigest: receipt.evidence.probeDigest, runtimeDigest,
      planDigest: plan.digest, installationId: plan.installationId, profilePath: runtime.profilePath,
      exact: Object.freeze({ package: plan.candidate.package, version: plan.candidate.version, integrity: plan.candidate.integrity }) })
  } catch (error) {
    if (error instanceof DeploymentReadinessError) throw error
    throw new DeploymentReadinessError('journal could not be read without mutation')
  } finally { database?.close() }
}
