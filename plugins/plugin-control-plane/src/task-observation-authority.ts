import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  postActivationEvidenceDigest,
  parsePostActivationObservation,
  postActivationObservationSigningPayload,
} from './post-activation.js'
import {
  sourceAuthorityCanonicalSafePath,
  sourceAuthorityReadSafeFile,
} from './source-approval-authority.js'
import { controlPlaneDigest } from './store.js'
import { readTaskObservationContext, taskObservationDigest } from './task-observation-store.js'
import { PROTECTED_PLUGIN_DENYLIST } from './source-workspace.js'
import type { TaskObservationBatch, TaskObservationOwner, TaskObservationPolicy, TaskObservationRequest } from './task-observation-types.js'
import type { PostActivationObservationReceipt } from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const PACKAGE = /^@dsh-enhanced\/[a-z][a-z0-9-]*$/u
const MAX_CONFIG = 65_536
const MAX_REQUEST = 8_192
const MAX_KEY = 32_768
const MAX_LOOKBACK = 30 * 24 * 60 * 60 * 1_000

export interface TaskObservationAuthorityConfig {
  schemaVersion: 1
  authority: string
  keyId: string
  keyPath: string
  statePath: string
  controlDatabasePath: string
  grant: {
    policy: TaskObservationPolicy
    owner: TaskObservationOwner
    installationId: string
    ledger: { id: string; path: string }
    profilePath: string
    packages: readonly string[]
    receiptTtlMs: number
  }
}

export class TaskObservationAuthorityError extends Error {
  constructor() {
    super('task observation authority refused the request')
    this.name = 'TaskObservationAuthorityError'
  }
}

function fail(): never {
  throw new TaskObservationAuthorityError()
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail()
}

function string(value: unknown, pattern = ID, max = 4_096): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || !pattern.test(value)
    || Buffer.byteLength(value) > max || /[\p{Cc}]/u.test(value)) fail()
  return value as string
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail()
  return Number(value)
}

function configuredPath(value: unknown): string {
  const path = string(value, /^[\s\S]+$/u)
  if (!path.startsWith('/') || path === '/' || resolve(path) !== path) fail()
  return path
}

function equal(left: unknown, right: unknown): boolean {
  return controlPlaneDigest(left) === controlPlaneDigest(right)
}

function parseOwner(value: unknown): TaskObservationOwner {
  const item = object(value)
  exact(item, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  return Object.freeze({
    authorityId: string(item.authorityId),
    authorityHash: string(item.authorityHash, DIGEST, 64),
    principalId: string(item.principalId, /^[\s\S]+$/u, 512),
    principalRecordId: string(item.principalRecordId, /^[\s\S]+$/u, 512),
    principalVersion: integer(item.principalVersion, 1),
    workspace: configuredPath(item.workspace),
    agentPreset: string(item.agentPreset),
  })
}

function parsePolicy(value: unknown): TaskObservationPolicy {
  const item = object(value)
  exact(item, ['id', 'expiresAt', 'maximumObservations', 'minimumChecks', 'maximumChecks', 'lookbackMs'])
  const result = {
    id: string(item.id),
    expiresAt: integer(item.expiresAt, 1),
    maximumObservations: integer(item.maximumObservations, 1, 1_000),
    minimumChecks: integer(item.minimumChecks, 1, 32),
    maximumChecks: integer(item.maximumChecks, 1, 32),
    lookbackMs: integer(item.lookbackMs, 1_000, MAX_LOOKBACK),
  }
  if (result.minimumChecks > result.maximumChecks) fail()
  return Object.freeze(result)
}

export function validateTaskObservationAuthorityConfig(value: unknown): asserts value is TaskObservationAuthorityConfig {
  const item = object(value)
  exact(item, ['schemaVersion', 'authority', 'keyId', 'keyPath', 'statePath', 'controlDatabasePath', 'grant'])
  if (item.schemaVersion !== 1) fail()
  string(item.authority)
  string(item.keyId)
  const keyPath = sourceAuthorityCanonicalSafePath(configuredPath(item.keyPath), 'file')
  const statePath = configuredPath(item.statePath)
  const controlPath = sourceAuthorityCanonicalSafePath(configuredPath(item.controlDatabasePath), 'file')
  if (new Set([keyPath, statePath, controlPath]).size !== 3) fail()

  const grant = object(item.grant)
  exact(grant, ['policy', 'owner', 'installationId', 'ledger', 'profilePath', 'packages', 'receiptTtlMs'])
  parsePolicy(grant.policy)
  parseOwner(grant.owner)
  string(grant.installationId)
  const ledger = object(grant.ledger)
  exact(ledger, ['id', 'path'])
  string(ledger.id)
  if (configuredPath(ledger.path) !== controlPath) fail()
  configuredPath(grant.profilePath)
  integer(grant.receiptTtlMs, 1_000, 300_000)
  const rawPackages = grant.packages
  if (!Array.isArray(rawPackages)) fail()
  if (rawPackages.length < 1 || rawPackages.length > 64) fail()
  const packages = rawPackages.map((value: unknown) => string(value, PACKAGE, 128))
  if (new Set(packages).size !== packages.length) fail()
}

function parseRequest(value: unknown): TaskObservationRequest {
  const item = object(value)
  exact(item, ['protocol', 'observationId', 'observationDigest'])
  if (item.protocol !== 'dsh-task-observation/v1') fail()
  return Object.freeze({
    protocol: 'dsh-task-observation/v1',
    observationId: string(item.observationId),
    observationDigest: string(item.observationDigest, DIGEST, 64),
  })
}

function openState(path: string): DatabaseSync {
  sourceAuthorityCanonicalSafePath(path, 'file', true)
  const database = new DatabaseSync(path)
  try {
    database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS task_observation_grants (
      grant_id TEXT PRIMARY KEY,
      config_digest TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS task_observation_receipts (
      request_digest TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      observation_id TEXT NOT NULL UNIQUE,
      observation_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      receipt_digest TEXT NOT NULL
    ) STRICT;
    `)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function storedReceipt(receiptJson: string, digest: string, key: ReturnType<typeof createPrivateKey>): PostActivationObservationReceipt {
  if (controlPlaneDigest(receiptJson) !== digest) fail()
  try {
    const receipt = parsePostActivationObservation(JSON.parse(receiptJson))
    const { signature: _signature, ...unsigned } = receipt
    if (!verify(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), createPublicKey(key), Buffer.from(receipt.signature, 'base64'))) fail()
    return receipt
  } catch {
    return fail()
  }
}

function validateContext(config: TaskObservationAuthorityConfig, request: TaskObservationRequest, now: number) {
  const control = new DatabaseSync(sourceAuthorityCanonicalSafePath(config.controlDatabasePath, 'file'), { readOnly: true })
  try {
    control.exec('PRAGMA query_only = ON')
    const { record, plan, source, deployments } = readTaskObservationContext(control, request.observationId)
    const batch = record.batch
    if (!['pending', 'signed'].includes(record.state)
      || batch.id !== request.observationId
      || batch.digest !== request.observationDigest
      || taskObservationDigest(batch) !== batch.digest
      || batch.expiresAt <= now
      || batch.policy.expiresAt <= now
      || !equal(batch.policy, config.grant.policy)
      || !equal(batch.owner, config.grant.owner)
      || batch.installationId !== config.grant.installationId
      || !equal(plan.ledger, config.grant.ledger)
      || batch.profilePath !== config.grant.profilePath
      || plan.id !== batch.planId
      || plan.digest !== batch.planDigest
      || plan.status !== 'activated'
      || !plan.activation
      || PROTECTED_PLUGIN_DENYLIST.has(plan.candidate.id)
      || !config.grant.packages.includes(plan.candidate.package)
      || source.owner.authorityId !== batch.owner.authorityId
      || source.owner.authorityHash !== batch.owner.authorityHash
      || source.owner.principalId !== batch.owner.principalId
      || source.owner.principalRecordId !== batch.owner.principalRecordId
      || source.owner.principalVersion !== batch.owner.principalVersion
      || source.owner.workspace !== batch.owner.workspace
      || source.owner.agentPreset !== batch.owner.agentPreset) fail()

    if (batch.votes.length < batch.policy.minimumChecks
      || batch.votes.length > batch.policy.maximumChecks
      || deployments.length !== batch.votes.length
      || new Set(batch.votes.map(vote => vote.inboxId)).size !== batch.votes.length) fail()

    for (const vote of batch.votes) {
      if (vote.completedAt > now || now - vote.completedAt > batch.policy.lookbackMs
        || (vote.status !== 'achieved' && vote.status !== 'not-achieved')) fail()
      const deployment = deployments.find(item => item.task.inboxId === vote.inboxId)
      if (!deployment
        || deployment.readiness.planId !== plan.id
        || deployment.task.owner.principalRecordId !== batch.owner.principalRecordId
        || deployment.task.owner.principalVersion !== batch.owner.principalVersion
        || deployment.task.scope.workspace !== batch.owner.workspace
        || deployment.task.scope.preset !== batch.owner.agentPreset
        || controlPlaneDigest(deployment) !== vote.deploymentDigest
        || !deployment.execution
        || deployment.execution.completedAt !== vote.completedAt) fail()
    }
    return { batch, plan }
  } finally {
    control.close()
  }
}

function makeReceipt(config: TaskObservationAuthorityConfig, batch: TaskObservationBatch, plan: ReturnType<typeof validateContext>['plan'], key: ReturnType<typeof createPrivateKey>, now: number): PostActivationObservationReceipt {
  const failures = batch.votes.filter(vote => vote.status === 'not-achieved').length
  const evidence = {
    kind: 'post-activation-health' as const,
    checks: batch.votes.length,
    failures,
    probeDigest: batch.digest,
  }
  const unsigned: Omit<PostActivationObservationReceipt, 'signature'> = {
    schemaVersion: 1,
    observationId: batch.id,
    authority: config.authority,
    keyId: config.keyId,
    installationId: batch.installationId,
    planId: plan.id,
    planDigest: plan.digest,
    activationId: plan.activation!.id,
    fence: plan.activation!.fence,
    package: plan.candidate.package,
    version: plan.candidate.version,
    integrity: plan.candidate.integrity,
    disposition: failures ? 'regressed' : 'healthy',
    evidence,
    evidenceDigest: postActivationEvidenceDigest(evidence),
    hostGeneration: batch.hostGeneration,
    observedAt: now,
    expiresAt: Math.min(now + config.grant.receiptTtlMs, batch.expiresAt, batch.policy.expiresAt, config.grant.policy.expiresAt),
  }
  if (unsigned.expiresAt <= now) fail()
  try {
    return parsePostActivationObservation({
      ...unsigned,
      signature: sign(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), key).toString('base64'),
    })
  } catch {
    return fail()
  }
}

export async function authorizeTaskObservation(configInput: TaskObservationAuthorityConfig, requestInput: TaskObservationRequest): Promise<PostActivationObservationReceipt> {
  try {
    validateTaskObservationAuthorityConfig(configInput)
    const config = configInput
    const request = parseRequest(requestInput)
    const keyBytes = sourceAuthorityReadSafeFile(config.keyPath, MAX_KEY)
    let key: ReturnType<typeof createPrivateKey>
    try {
      key = createPrivateKey(keyBytes)
    } catch {
      return fail()
    }
    if (key.asymmetricKeyType !== 'ed25519') fail()

    const configDigest = controlPlaneDigest(config)
    const keyFingerprint = createHash('sha256').update(keyBytes).digest('hex')
    const requestDigest = controlPlaneDigest(request)
    const state = openState(config.statePath)
    try {
      state.exec('BEGIN IMMEDIATE')
      const frozen = state.prepare('SELECT config_digest, key_fingerprint FROM task_observation_grants WHERE grant_id = ?')
        .get(config.grant.policy.id) as { config_digest: string; key_fingerprint: string } | undefined
      if (frozen && (frozen.config_digest !== configDigest || frozen.key_fingerprint !== keyFingerprint)) fail()

      const prior = state.prepare(`
        SELECT receipt_json, receipt_digest, grant_id, config_digest, observation_id, observation_digest
        FROM task_observation_receipts WHERE request_digest = ?
      `).get(requestDigest) as {
        receipt_json: string; receipt_digest: string; grant_id: string; config_digest: string
        observation_id: string; observation_digest: string
      } | undefined
      if (prior) {
        if (prior.grant_id !== config.grant.policy.id
          || prior.config_digest !== configDigest
          || prior.observation_id !== request.observationId
          || prior.observation_digest !== request.observationDigest) fail()
        const receipt = storedReceipt(prior.receipt_json, prior.receipt_digest, key)
        if (receipt.observationId !== request.observationId
          || receipt.evidence.probeDigest !== request.observationDigest
          || receipt.authority !== config.authority
          || receipt.keyId !== config.keyId) fail()
        state.exec('COMMIT')
        return receipt
      }

      const now = Date.now()
      if (now >= config.grant.policy.expiresAt) fail()
      const first = validateContext(config, request, now)
      const final = validateContext(config, request, now)
      if (!equal(first.batch, final.batch) || !equal(first.plan, final.plan)) fail()
      if ((state.prepare('SELECT COUNT(*) AS count FROM task_observation_receipts WHERE grant_id = ?')
        .get(config.grant.policy.id) as { count: number }).count >= config.grant.policy.maximumObservations) fail()

      if (!frozen) state.prepare('INSERT INTO task_observation_grants VALUES (?, ?, ?)')
        .run(config.grant.policy.id, configDigest, keyFingerprint)
      const receipt = makeReceipt(config, final.batch, final.plan, key, now)
      const receiptJson = JSON.stringify(receipt)
      state.prepare('INSERT INTO task_observation_receipts VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        requestDigest, config.grant.policy.id, configDigest, request.observationId,
        request.observationDigest, receiptJson, controlPlaneDigest(receiptJson),
      )
      state.exec('COMMIT')
      return receipt
    } catch (error) {
      try { state.exec('ROLLBACK') } catch {}
      throw error
    } finally {
      state.close()
    }
  } catch (error) {
    if (error instanceof TaskObservationAuthorityError) throw error
    throw new TaskObservationAuthorityError()
  }
}

export async function runTaskObservationAuthority(argv = process.argv.slice(2)): Promise<void> {
  try {
    if (argv.length !== 2 || argv[0] !== '--config') fail()
    const configBytes = sourceAuthorityReadSafeFile(configuredPath(argv[1]), MAX_CONFIG)
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes))
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_REQUEST) fail()
      chunks.push(bytes)
    }
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    process.stdout.write(`${JSON.stringify(await authorizeTaskObservation(config, input))}\n`)
  } catch {
    throw new TaskObservationAuthorityError()
  }
}
