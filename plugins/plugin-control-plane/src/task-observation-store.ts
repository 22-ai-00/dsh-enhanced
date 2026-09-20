import type { DatabaseSync } from 'node:sqlite'
import { isAbsolute, resolve } from 'node:path'
import { assertForegroundDeployment, type ForegroundDeploymentRecord } from './foreground-deployment.js'
import { controlPlaneSchemaVersion } from './sqlite.js'
import { controlPlaneDigest, ControlPlaneStoreError, readOwnerSourceAdoptionPlan } from './store.js'
import { parsePostActivationObservation } from './post-activation.js'
import type { PluginActivationPlan } from './types.js'
import type { TaskObservationBatch, TaskObservationRecord } from './task-observation-types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const fail = (message: string): never => { throw new ControlPlaneStoreError('invalid-state', message) }
const same = (a: unknown, b: unknown): boolean => controlPlaneDigest(a) === controlPlaneDigest(b)
const integer = (value: number, min: number, max = Number.MAX_SAFE_INTEGER): boolean => Number.isSafeInteger(value) && value >= min && value <= max
const text = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && value.normalize('NFC').trim() === value && !/[\p{Cc}]/u.test(value)
const path = (value: string): boolean => text(value) && isAbsolute(value) && resolve(value) === value

export function taskObservationId(batch: Omit<TaskObservationBatch, 'schemaVersion' | 'kind' | 'id' | 'digest' | 'createdAt' | 'expiresAt'>): string {
  return `task-observation-${controlPlaneDigest({ lane: batch.lane, configDigest: batch.configDigest, trustDigest: batch.trustDigest,
    planId: batch.planId, planDigest: batch.planDigest, installationId: batch.installationId, profilePath: batch.profilePath,
    owner: batch.owner, policy: batch.policy, hostGeneration: batch.hostGeneration, votes: batch.votes })}`
}
export function taskObservationDigest(batch: Omit<TaskObservationBatch, 'digest'>): string {
  const { digest: _digest, ...unsigned } = batch as TaskObservationBatch
  return controlPlaneDigest(unsigned)
}
export function assertTaskObservationBatch(value: unknown): asserts value is TaskObservationBatch {
  const batch = value as TaskObservationBatch
  if (!batch || typeof batch !== 'object' || batch.schemaVersion !== 1 || batch.kind !== 'dsh-task-observation'
    || !ID.test(batch.id) || !DIGEST.test(batch.digest) || !DIGEST.test(batch.lane) || !DIGEST.test(batch.configDigest)
    || !DIGEST.test(batch.trustDigest) || !ID.test(batch.planId) || !DIGEST.test(batch.planDigest) || !Array.isArray(batch.votes)
    || !path(batch.profilePath) || !text(batch.installationId) || !integer(batch.hostGeneration, 1)
    || !integer(batch.createdAt, 1) || !integer(batch.expiresAt, batch.createdAt + 1)
    || !batch.policy || !ID.test(batch.policy.id) || !integer(batch.policy.expiresAt, batch.expiresAt)
    || !integer(batch.policy.maximumObservations, 1, 1000) || !integer(batch.policy.minimumChecks, 1, 32)
    || !integer(batch.policy.maximumChecks, batch.policy.minimumChecks, 32) || !integer(batch.policy.lookbackMs, 1000, 30 * 86_400_000)
    || batch.votes.length < batch.policy.minimumChecks || batch.votes.length > batch.policy.maximumChecks
    || !batch.owner || ![batch.owner.authorityId, batch.owner.principalId, batch.owner.principalRecordId, batch.owner.agentPreset].every(text)
    || !DIGEST.test(batch.owner.authorityHash) || !path(batch.owner.workspace) || !integer(batch.owner.principalVersion, 1)
    || Buffer.byteLength(JSON.stringify(batch)) > 262_144) fail('task observation batch is invalid')
  const seen = new Set<string>()
  for (const vote of batch.votes) {
    if (!vote || !text(vote.inboxId) || !text(vote.outcomeId) || !DIGEST.test(vote.sourceDigest) || !DIGEST.test(vote.deploymentDigest)
      || !['achieved', 'not-achieved'].includes(vote.status) || !integer(vote.completedAt, 1, batch.createdAt)
      || batch.expiresAt > vote.completedAt + batch.policy.lookbackMs || !vote.projection
      || vote.projection.subjectKind !== 'foreground-turn' || vote.projection.subjectRef !== vote.inboxId
      || vote.projection.disposition !== 'upsert' || !integer(vote.projection.version, 1) || !DIGEST.test(vote.projection.digest)
      || seen.has(vote.inboxId)) fail('task observation vote is invalid')
    seen.add(vote.inboxId)
  }
  if (batch.id !== taskObservationId(batch) || batch.digest !== taskObservationDigest(batch)) fail('task observation digest differs')
}

export function getTaskObservationRecord(db: DatabaseSync, id: string): TaskObservationRecord | undefined {
  const row = db.prepare('SELECT id,lane,plan_id,batch_json,batch_digest,state,receipt_json,receipt_digest FROM task_observation_batches WHERE id=?').get(id) as
    { id: string; lane: string; plan_id: string; batch_json: string; batch_digest: string; state: string; receipt_json: string | null; receipt_digest: string | null } | undefined
  if (!row) return undefined
  if (Buffer.byteLength(row.batch_json) > 262_144) fail('stored task observation exceeds bound')
  const batch = JSON.parse(row.batch_json) as TaskObservationBatch
  assertTaskObservationBatch(batch)
  if (controlPlaneDigest(batch) !== row.batch_digest || batch.id !== row.id || batch.lane !== row.lane || batch.planId !== row.plan_id
    || !['pending', 'signed', 'applied', 'stale'].includes(row.state)) fail('stored task observation changed')
  const receipt = row.receipt_json === null ? undefined : parsePostActivationObservation(JSON.parse(row.receipt_json))
  if (receipt && (controlPlaneDigest(receipt) !== row.receipt_digest || receipt.observationId !== id || receipt.evidence.probeDigest !== batch.digest)) fail('stored task observation receipt changed')
  if ((row.state === 'signed' || row.state === 'applied') && !receipt) fail('stored task observation receipt missing')
  return Object.freeze({ batch, state: row.state as TaskObservationRecord['state'], ...(receipt === undefined ? {} : { receipt }) })
}

/** Read-only durable cohort validation; canonical quality is fenced by the Host. */
export function readTaskObservationContext(db: DatabaseSync, id: string): {
  record: TaskObservationRecord; plan: PluginActivationPlan
  source: ReturnType<typeof readOwnerSourceAdoptionPlan>['source']; deployments: readonly ForegroundDeploymentRecord[]
} {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== controlPlaneSchemaVersion) fail('task observation database version is invalid')
  const record = getTaskObservationRecord(db, id)
  if (!record) return fail('task observation absent')
  const { batch } = record
  const adopted = readOwnerSourceAdoptionPlan(db, batch.planId), plan = adopted.plan
  if (batch.planDigest !== plan.digest || batch.installationId !== plan.installationId || batch.profilePath !== plan.target.profilePath) fail('task observation plan changed')
  for (const key of ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'] as const) {
    if (batch.owner[key] !== adopted.source.owner[key]) fail('task observation source owner changed')
  }
  const unsettled = db.prepare(`SELECT 1 FROM activation_plans WHERE target_path=? AND status IN (
    'staging','awaiting-reload','awaiting-readiness','awaiting-effect-blocked-replay','awaiting-shadow',
    'awaiting-canary','awaiting-soak','awaiting-health','commit-pending','rollback-pending') LIMIT 1`).get(plan.target.profilePath)
  const latest = db.prepare(`SELECT checkpoint.plan_id,checkpoint.exposure_order,checkpoint.successful_order
    FROM activation_deployment_checkpoints checkpoint JOIN activation_plans candidate ON candidate.id=checkpoint.plan_id
    WHERE candidate.target_path=? ORDER BY checkpoint.exposure_order DESC LIMIT 1`).get(plan.target.profilePath) as
    { plan_id: string; exposure_order: number; successful_order: number | null } | undefined
  const watch = db.prepare('SELECT state,activation_id,fence,started_at,last_host_generation FROM activation_watch WHERE plan_id=?').get(plan.id) as
    { state: string; activation_id: string; fence: number; started_at: number; last_host_generation: number } | undefined
  if (unsettled || latest?.plan_id !== plan.id || latest.exposure_order !== latest.successful_order || plan.status !== 'activated'
    || !plan.activation || !watch || watch.state !== 'watching' || watch.activation_id !== plan.activation.id
    || watch.fence !== plan.activation.fence || watch.last_host_generation !== batch.hostGeneration) return fail('task observation deployment is no longer current')
  const deployments = batch.votes.map(vote => {
    const row = db.prepare('SELECT record_json,record_digest,plan_id FROM foreground_deployments WHERE inbox_id=?').get(vote.inboxId) as
      { record_json: string; record_digest: string; plan_id: string } | undefined
    if (!row || row.plan_id !== plan.id || Buffer.byteLength(row.record_json) > 262_144) return fail('task observation deployment absent')
    const item = JSON.parse(row.record_json) as ForegroundDeploymentRecord
    assertForegroundDeployment(item)
    if (controlPlaneDigest(item) !== row.record_digest || row.record_digest !== vote.deploymentDigest
      || item.state !== 'observed' || !item.execution || item.execution.completedAt !== vote.completedAt || item.task.inboxId !== vote.inboxId
      || item.task.owner.principalRecordId !== batch.owner.principalRecordId || item.task.owner.principalVersion !== batch.owner.principalVersion
      || item.task.scope.workspace !== batch.owner.workspace || item.task.scope.preset !== batch.owner.agentPreset
      || item.task.dispatchedAt < watch.started_at || item.readiness.planId !== plan.id || item.readiness.planDigest !== plan.digest
      || item.readiness.hostGeneration !== batch.hostGeneration || item.readiness.installationId !== batch.installationId
      || item.readiness.profilePath !== batch.profilePath || item.readiness.activationId !== plan.activation!.id
      || item.readiness.fence !== plan.activation!.fence || !same(item.readiness.exact,
        { package: plan.candidate.package, version: plan.candidate.version, integrity: plan.candidate.integrity })) fail('task observation deployment witness changed')
    return item
  })
  return { record, plan, source: adopted.source, deployments }
}
