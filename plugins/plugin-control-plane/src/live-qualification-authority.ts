import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sourceAuthorityCanonicalSafePath, sourceAuthorityReadSafeFile } from './source-approval-authority.js'
import { controlPlaneDigest, readLiveQualificationContext } from './store.js'
import { PROTECTED_PLUGIN_DENYLIST } from './source-workspace.js'
import type { ForegroundDeploymentRecord } from './foreground-deployment.js'
import { assertLiveQualificationBatch, liveQualificationReceiptId, liveQualificationSigningPayload,
  parseLiveQualificationReceipt, validateLiveQualificationTerms,
  type LiveQualificationBatch, type LiveQualificationReceipt, type LiveQualificationRequest,
  type LiveQualificationTerms } from './live-qualification.js'
import type { TaskObservationOwner } from './task-observation-types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const PACKAGE = /^@dsh-enhanced\/[a-z][a-z0-9-]*$/u
const MAX_CONFIG = 65_536
const MAX_REQUEST = 8_192
const MAX_KEY = 32_768

export interface LiveQualificationAuthorityConfig {
  schemaVersion: 1
  authority: string
  keyId: string
  keyPath: string
  statePath: string
  controlDatabasePath: string
  grant: {
    id: string
    expiresAt: number
    maxQualifications: number
    owner: TaskObservationOwner
    installationId: string
    ledger: { id: string; path: string }
    profilePath: string
    packages: readonly string[]
    terms: LiveQualificationTerms
    receiptTtlMs: number
  }
}

export class LiveQualificationAuthorityError extends Error {
  constructor() {
    super('live qualification authority refused the request')
    this.name = 'LiveQualificationAuthorityError'
  }
}
function fail(): never { throw new LiveQualificationAuthorityError() }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail()
}
function string(value: unknown, pattern = ID, maximum = 4096): string {
  if (typeof value !== 'string' || !pattern.test(value) || value.normalize('NFC').trim() !== value
    || Buffer.byteLength(value) > maximum || /[\p{Cc}]/u.test(value)) fail()
  return value as string
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail()
  return Number(value)
}
function path(value: unknown): string {
  const result = string(value, /^[\s\S]+$/u)
  if (!result.startsWith('/') || result === '/' || resolve(result) !== result) fail()
  return result
}
function equal(left: unknown, right: unknown): boolean { return controlPlaneDigest(left) === controlPlaneDigest(right) }
function owner(value: unknown): TaskObservationOwner {
  const item = object(value)
  exact(item, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  return Object.freeze({ authorityId: string(item.authorityId), authorityHash: string(item.authorityHash, DIGEST, 64),
    principalId: string(item.principalId, /^[\s\S]+$/u, 512),
    principalRecordId: string(item.principalRecordId, /^[\s\S]+$/u, 512),
    principalVersion: integer(item.principalVersion, 1), workspace: path(item.workspace), agentPreset: string(item.agentPreset) })
}

export function validateLiveQualificationAuthorityConfig(value: unknown): asserts value is LiveQualificationAuthorityConfig {
  const item = object(value)
  exact(item, ['schemaVersion', 'authority', 'keyId', 'keyPath', 'statePath', 'controlDatabasePath', 'grant'])
  if (item.schemaVersion !== 1) fail()
  const authority = string(item.authority), keyId = string(item.keyId)
  const keyPath = sourceAuthorityCanonicalSafePath(path(item.keyPath), 'file')
  const statePath = path(item.statePath)
  const controlPath = sourceAuthorityCanonicalSafePath(path(item.controlDatabasePath), 'file')
  if (new Set([keyPath, statePath, controlPath]).size !== 3) fail()
  const grant = object(item.grant)
  exact(grant, ['id', 'expiresAt', 'maxQualifications', 'owner', 'installationId', 'ledger', 'profilePath', 'packages', 'terms', 'receiptTtlMs'])
  string(grant.id)
  integer(grant.expiresAt, 1)
  integer(grant.maxQualifications, 1, 1000)
  owner(grant.owner)
  string(grant.installationId)
  const ledger = object(grant.ledger)
  exact(ledger, ['id', 'path'])
  string(ledger.id)
  if (path(ledger.path) !== controlPath) fail()
  path(grant.profilePath)
  validateLiveQualificationTerms(grant.terms)
  if (grant.terms.authority !== authority || grant.terms.keyId !== keyId) fail()
  integer(grant.receiptTtlMs, 1_000, 300_000)
  if (!Array.isArray(grant.packages) || grant.packages.length < 1 || grant.packages.length > 64) fail()
  const packages = grant.packages.map((value: unknown) => string(value, PACKAGE, 128))
  if (new Set(packages).size !== packages.length) fail()
}

function parseRequest(value: unknown): LiveQualificationRequest {
  const item = object(value)
  exact(item, ['protocol', 'batchId', 'batchDigest'])
  if (item.protocol !== 'dsh-live-qualification/v1') fail()
  return Object.freeze({ protocol: 'dsh-live-qualification/v1',
    batchId: string(item.batchId, /^live-qualification-[a-f0-9]{64}$/u),
    batchDigest: string(item.batchDigest, DIGEST, 64) })
}

function openState(statePath: string): DatabaseSync {
  sourceAuthorityCanonicalSafePath(statePath, 'file', true)
  const database = new DatabaseSync(statePath)
  try {
    database.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS live_qualification_grants (
        grant_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, key_fingerprint TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS live_qualification_receipts (
        request_digest TEXT PRIMARY KEY, grant_id TEXT NOT NULL, config_digest TEXT NOT NULL,
        batch_id TEXT NOT NULL UNIQUE, batch_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL
      ) STRICT;`)
    return database
  } catch (error) { database.close(); throw error }
}

function storedReceipt(receiptJson: string, digest: string, key: ReturnType<typeof createPrivateKey>): LiveQualificationReceipt {
  if (controlPlaneDigest(receiptJson) !== digest) fail()
  try {
    const receipt = parseLiveQualificationReceipt(JSON.parse(receiptJson))
    const { signature, ...unsigned } = receipt
    if (!verify(null, Buffer.from(liveQualificationSigningPayload(unsigned)), createPublicKey(key), Buffer.from(signature, 'base64'))) fail()
    return receipt
  } catch { return fail() }
}

function validateContext(config: LiveQualificationAuthorityConfig, request: LiveQualificationRequest, now: number) {
  const db = new DatabaseSync(sourceAuthorityCanonicalSafePath(config.controlDatabasePath, 'file'), { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    const context = readLiveQualificationContext(db, request.batchId)
    const { record, plan, source, deployments } = context
    const batch = record.batch
    assertLiveQualificationBatch(batch)
    if (!['pending', 'signed'].includes(record.state) || batch.id !== request.batchId || batch.digest !== request.batchDigest
      || batch.expiresAt <= now || now >= batch.deadlineAt || config.grant.expiresAt <= now
      || !equal(batch.terms, config.grant.terms) || !equal(batch.owner, config.grant.owner)
      || batch.installationId !== config.grant.installationId || !equal(plan.ledger, config.grant.ledger)
      || batch.profilePath !== config.grant.profilePath || plan.id !== batch.planId || plan.digest !== batch.planDigest
      || plan.status !== 'awaiting-live-tasks' || !plan.activation || plan.activation.id !== batch.activationId
      || plan.activation.fence !== batch.fence || PROTECTED_PLUGIN_DENYLIST.has(plan.candidate.id)
      || !config.grant.packages.includes(plan.candidate.package)
      || !equal((plan.dossier as { liveQualification?: LiveQualificationTerms }).liveQualification, batch.terms)
      || source.owner.authorityId !== batch.owner.authorityId || source.owner.authorityHash !== batch.owner.authorityHash
      || source.owner.principalId !== batch.owner.principalId || source.owner.principalRecordId !== batch.owner.principalRecordId
      || source.owner.principalVersion !== batch.owner.principalVersion || source.owner.workspace !== batch.owner.workspace
      || source.owner.agentPreset !== batch.owner.agentPreset || deployments.length !== batch.votes.length) fail()
    for (const vote of batch.votes) {
      const deployment = deployments.find((item: ForegroundDeploymentRecord) => item.task.inboxId === vote.inboxId)
      if (!deployment || controlPlaneDigest(deployment) !== vote.deploymentDigest
        || deployment.readiness.planId !== plan.id || deployment.readiness.planDigest !== plan.digest
        || deployment.readiness.activationId !== batch.activationId || deployment.readiness.fence !== batch.fence
        || deployment.readiness.hostGeneration !== batch.hostGeneration
        || deployment.task.owner.principalRecordId !== batch.owner.principalRecordId
        || deployment.task.owner.principalVersion !== batch.owner.principalVersion
        || deployment.task.scope.workspace !== batch.owner.workspace || deployment.task.scope.preset !== batch.owner.agentPreset
        || !deployment.execution || deployment.execution.completedAt !== vote.completedAt) fail()
    }
    return context
  } finally { db.close() }
}

function makeReceipt(config: LiveQualificationAuthorityConfig, batch: LiveQualificationBatch,
  key: ReturnType<typeof createPrivateKey>, now: number): LiveQualificationReceipt {
  const identity = {
    schemaVersion: 1 as const, kind: 'dsh-live-qualification-receipt' as const,
    authority: config.authority, keyId: config.keyId, batchId: batch.id, batchDigest: batch.digest,
    planId: batch.planId, planDigest: batch.planDigest, activationId: batch.activationId, fence: batch.fence,
    hostGeneration: batch.hostGeneration,
    disposition: batch.votes.some(vote => vote.status === 'not-achieved') ? 'failed' as const : 'qualified' as const,
    observedAt: now,
    expiresAt: Math.min(now + config.grant.receiptTtlMs, batch.expiresAt, config.grant.expiresAt),
  }
  if (identity.expiresAt <= now) fail()
  const unsigned = { ...identity, receiptId: liveQualificationReceiptId(identity) }
  return parseLiveQualificationReceipt({ ...unsigned,
    signature: sign(null, Buffer.from(liveQualificationSigningPayload(unsigned)), key).toString('base64') })
}

export async function authorizeLiveQualification(configInput: LiveQualificationAuthorityConfig,
  requestInput: LiveQualificationRequest): Promise<LiveQualificationReceipt> {
  try {
    validateLiveQualificationAuthorityConfig(configInput)
    const config = configInput, request = parseRequest(requestInput)
    const keyBytes = sourceAuthorityReadSafeFile(config.keyPath, MAX_KEY)
    const key = createPrivateKey(keyBytes)
    if (key.asymmetricKeyType !== 'ed25519') fail()
    const configDigest = controlPlaneDigest(config)
    const keyFingerprint = createHash('sha256').update(keyBytes).digest('hex')
    const requestDigest = controlPlaneDigest(request)
    const state = openState(config.statePath)
    try {
      state.exec('BEGIN IMMEDIATE')
      const frozen = state.prepare('SELECT config_digest,key_fingerprint FROM live_qualification_grants WHERE grant_id=?')
        .get(config.grant.id) as { config_digest: string; key_fingerprint: string } | undefined
      if (frozen && (frozen.config_digest !== configDigest || frozen.key_fingerprint !== keyFingerprint)) fail()
      const prior = state.prepare(`SELECT receipt_json,receipt_digest,grant_id,config_digest,batch_id,batch_digest
        FROM live_qualification_receipts WHERE request_digest=?`).get(requestDigest) as {
          receipt_json: string; receipt_digest: string; grant_id: string; config_digest: string;
          batch_id: string; batch_digest: string
        } | undefined
      if (prior) {
        if (prior.grant_id !== config.grant.id || prior.config_digest !== configDigest
          || prior.batch_id !== request.batchId || prior.batch_digest !== request.batchDigest) fail()
        const receipt = storedReceipt(prior.receipt_json, prior.receipt_digest, key)
        if (receipt.batchId !== request.batchId || receipt.batchDigest !== request.batchDigest
          || receipt.authority !== config.authority || receipt.keyId !== config.keyId) fail()
        state.exec('COMMIT')
        return receipt
      }
      const now = Date.now()
      const first = validateContext(config, request, now)
      const final = validateContext(config, request, now)
      if (!equal(first.record.batch, final.record.batch) || !equal(first.plan, final.plan)) fail()
      const count = state.prepare('SELECT COUNT(*) AS count FROM live_qualification_receipts WHERE grant_id=?')
        .get(config.grant.id) as { count: number }
      if (count.count >= config.grant.maxQualifications) fail()
      if (!frozen) state.prepare('INSERT INTO live_qualification_grants VALUES (?,?,?)')
        .run(config.grant.id, configDigest, keyFingerprint)
      const receipt = makeReceipt(config, final.record.batch, key, now)
      const receiptJson = JSON.stringify(receipt)
      state.prepare('INSERT INTO live_qualification_receipts VALUES (?,?,?,?,?,?,?)').run(
        requestDigest, config.grant.id, configDigest, request.batchId, request.batchDigest,
        receiptJson, controlPlaneDigest(receiptJson))
      state.exec('COMMIT')
      return receipt
    } catch (error) { try { state.exec('ROLLBACK') } catch {}; throw error }
    finally { state.close() }
  } catch (error) {
    if (error instanceof LiveQualificationAuthorityError) throw error
    throw new LiveQualificationAuthorityError()
  }
}

export async function runLiveQualificationAuthority(argv = process.argv.slice(2)): Promise<void> {
  try {
    if (argv.length !== 2 || argv[0] !== '--config') fail()
    const configBytes = sourceAuthorityReadSafeFile(path(argv[1]), MAX_CONFIG)
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes))
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_REQUEST) fail()
      chunks.push(bytes)
    }
    const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    process.stdout.write(`${JSON.stringify(await authorizeLiveQualification(config, request))}\n`)
  } catch { throw new LiveQualificationAuthorityError() }
}
