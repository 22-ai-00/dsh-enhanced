import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { chmod, copyFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestTaskObservation } from '../src/task-observation-client.ts'
import { postActivationObservationSigningPayload } from '../src/post-activation.ts'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'

import * as release from '../src/release.ts'
import { authorizeTaskObservation, type TaskObservationAuthorityConfig, TaskObservationAuthorityError } from '../src/task-observation-authority.ts'
import { controlPlaneDigest } from '../src/store.ts'
import { taskObservationDigest, taskObservationId } from '../src/task-observation-store.ts'
import type { TaskObservationBatch } from '../src/task-observation-types.ts'
import { cleanupForegroundDeploymentFixtures, foregroundDeploymentFixture } from './helpers/foreground-deployment.ts'

vi.mock('../src/release.ts', async original => ({
  ...await original<typeof release>(),
  invokeSourceReleaseAdapter: vi.fn(),
}))

afterEach(async () => { await cleanupForegroundDeploymentFixtures() })

async function fixture() {
  const f = await foregroundDeploymentFixture()
  const handle = f.observer.begin(f.task)
  const execution = f.execution()
  f.observer.completed(handle, f.task, execution)
  const deployment = f.store.getForegroundDeployment(f.task.inboxId)!
  const now = Math.max(Date.now(), execution.completedAt)
  const policy = {
    id: 'finite-policy',
    expiresAt: now + 60_000,
    maximumObservations: 1,
    minimumChecks: 1,
    maximumChecks: 1,
    lookbackMs: 30_000,
  }
  const owner = {
    authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: f.root, agentPreset: 'primary',
  }
  const core = {
    lane: controlPlaneDigest({ policy: policy.id, owner }),
    configDigest: 'c'.repeat(64), trustDigest: 'd'.repeat(64),
    planId: f.plan.id, planDigest: f.plan.digest, installationId: f.plan.installationId,
    profilePath: f.plan.target.profilePath, owner, policy,
    hostGeneration: deployment.readiness.hostGeneration,
    votes: [{
      inboxId: f.task.inboxId, outcomeId: 'outcome',
      projection: { subjectKind: 'foreground-turn' as const, subjectRef: f.task.inboxId, version: 1, digest: 'e'.repeat(64), disposition: 'upsert' as const },
      sourceDigest: 'f'.repeat(64), deploymentDigest: controlPlaneDigest(deployment),
      status: 'achieved' as const, completedAt: execution.completedAt,
    }],
  }
  const unsigned = {
    schemaVersion: 1 as const, kind: 'dsh-task-observation' as const,
    id: taskObservationId(core), ...core, createdAt: now, expiresAt: now + 20_000,
  }
  const batch: TaskObservationBatch = { ...unsigned, digest: taskObservationDigest(unsigned) }
  f.store.putTaskObservation(batch)

  const keys = generateKeyPairSync('ed25519')
  const keyPath = join(f.root, 'task-observation-key.pem')
  const statePath = join(f.root, 'task-observation-state.sqlite')
  await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await chmod(keyPath, 0o600)
  const config: TaskObservationAuthorityConfig = {
    schemaVersion: 1, authority: 'observer', keyId: 'key', keyPath, statePath,
    controlDatabasePath: f.plan.ledger.path,
    grant: {
      policy, owner, installationId: f.plan.installationId, ledger: f.plan.ledger,
      profilePath: f.plan.target.profilePath, packages: [f.plan.candidate.package], receiptTtlMs: 10_000,
    },
  }
  const request = { protocol: 'dsh-task-observation/v1' as const, observationId: batch.id, observationDigest: batch.digest }
  return { f, batch, config, request, statePath, keys }
}

test('signs a current durable batch once, verifies replay, quota, and private state', async () => {
  const value = await fixture()
  const [first, replay] = await Promise.all([
    authorizeTaskObservation(value.config, value.request),
    authorizeTaskObservation(value.config, value.request),
  ])
  expect(replay).toEqual(first)
  expect(first.evidence.probeDigest).toBe(value.batch.digest)
  expect(first.disposition).toBe('healthy')
  const { signature, ...unsigned } = first
  expect(verify(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), value.keys.publicKey,
    Buffer.from(signature, 'base64'))).toBe(true)
  expect((await lstat(value.statePath)).mode & 0o777).toBe(0o600)

  const state = new DatabaseSync(value.statePath, { readOnly: true })
  try {
    expect(state.prepare('SELECT COUNT(*) AS count FROM task_observation_receipts').get()).toEqual({ count: 1 })
  } finally {
    state.close()
  }
  await expect(authorizeTaskObservation(value.config, value.request)).resolves.toEqual(first)
})

test('rejects changed grants and exhausted quotas while retaining original replay', async () => {
  const value = await fixture()
  await authorizeTaskObservation(value.config, value.request)
  await expect(authorizeTaskObservation({ ...value.config, grant: { ...value.config.grant, receiptTtlMs: 11_000 } }, value.request))
    .rejects.toBeInstanceOf(TaskObservationAuthorityError)

  value.f.store.staleTaskObservation(value.batch.id)
  await expect(authorizeTaskObservation(value.config, value.request)).resolves.toMatchObject({ observationId: value.batch.id })

  const second = structuredClone(value.batch)
  second.configDigest = '9'.repeat(64)
  second.id = taskObservationId(second)
  second.createdAt = Date.now()
  second.expiresAt = second.createdAt + 20_000
  second.digest = taskObservationDigest(second)
  value.f.store.putTaskObservation(second)
  await expect(authorizeTaskObservation(value.config, {
    protocol: 'dsh-task-observation/v1', observationId: second.id, observationDigest: second.digest,
  })).rejects.toBeInstanceOf(TaskObservationAuthorityError)
})

test('rejects a key changed after the grant is frozen', async () => {
  const value = await fixture()
  await authorizeTaskObservation(value.config, value.request)
  const replacement = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
  await writeFile(value.config.keyPath, replacement, { mode: 0o600 })
  await expect(authorizeTaskObservation(value.config, value.request)).rejects.toBeInstanceOf(TaskObservationAuthorityError)
})


test('expired grants return only the original audit receipt and never authorize a new batch', async () => {
  const signed = await fixture(), unsigned = await fixture()
  const first = await authorizeTaskObservation(signed.config, signed.request)
  vi.spyOn(Date, 'now').mockReturnValue(Math.max(signed.config.grant.policy.expiresAt, unsigned.config.grant.policy.expiresAt) + 1)
  await expect(authorizeTaskObservation(signed.config, signed.request)).resolves.toEqual(first)
  expect(first.expiresAt).toBeLessThan(Date.now())
  await expect(authorizeTaskObservation(unsigned.config, unsigned.request)).rejects.toBeInstanceOf(TaskObservationAuthorityError)
})

test.each(['stale', 'witness', 'owner'] as const)('rejects unsigned batches with changed %s context', async kind => {
  const value = await fixture()
  if (kind === 'stale') value.f.store.staleTaskObservation(value.batch.id)
  else if (kind === 'owner') value.config.grant.owner = { ...value.config.grant.owner, principalVersion: 2 }
  else {
    const db = new DatabaseSync(value.f.plan.ledger.path)
    try { db.prepare("UPDATE foreground_deployments SET record_digest=? WHERE inbox_id=?").run('0'.repeat(64), value.f.task.inboxId) }
    finally { db.close() }
  }
  await expect(authorizeTaskObservation(value.config, value.request)).rejects.toBeInstanceOf(TaskObservationAuthorityError)
})

test.runIf(process.platform === 'linux')('the compiled descriptor-pinned CLI retains its signed receipt across processes', async () => {
  const value = await fixture()
  const configPath = join(value.f.root, 'authority.json')
  await writeFile(configPath, JSON.stringify(value.config), { mode: 0o600 })
  const executablePath = await realpath(fileURLToPath(new URL('../bin/dsh-task-observation-authority.js', import.meta.url)))
  const nodePath = join(value.f.root, 'node')
  await copyFile(await realpath(process.execPath), nodePath); await chmod(nodePath, 0o700)
  const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
  const config = { configPath, timeoutMs: 10_000,
    executable: { path: executablePath, sha256: await digest(executablePath) },
    interpreter: { path: nodePath, sha256: await digest(nodePath) } }
  const first = await requestTaskObservation(config, value.request)
  expect(await requestTaskObservation(config, value.request)).toEqual(first)
  const { signature, ...unsigned } = first
  expect(verify(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), value.keys.publicKey,
    Buffer.from(signature, 'base64'))).toBe(true)
}, 15_000)
