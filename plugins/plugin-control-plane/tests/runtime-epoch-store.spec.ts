import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.js'

vi.mock('../src/release.js', async importOriginal => ({
  ...await importOriginal<typeof release>(), invokeSourceReleaseAdapter: vi.fn(),
}))

import { ControlPlaneStore, controlPlaneDigest, readOwnerRuntimeEpochContext } from '../src/store.js'
import { cleanupRuntimeEpochFixtures, createRuntimeEpochFixture } from './helpers/runtime-epoch.js'

afterEach(async () => { vi.useRealTimers(); await cleanupRuntimeEpochFixtures() })

function historicalRows(path: string, planId: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows: Record<string, unknown> = {}
    const tables = { activation_plans: 'id', source_adoptions: 'activation_plan_id', adoption_handoffs: 'plan_id',
      activation_host_input_witnesses: 'plan_id', activation_deployment_checkpoints: 'plan_id', activation_watch: 'plan_id',
      host_attestation_operations: 'plan_id', host_attestations: 'plan_id' }
    for (const [table, key] of Object.entries(tables)) {
      rows[table] = db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).all(planId)
    }
    return rows
  } finally { db.close() }
}

function prepare(f: Awaited<ReturnType<typeof createRuntimeEpochFixture>>, invocationId?: string) {
  return f.f.options.withSourceFence!(() => f.f.store.prepareRuntimeEpoch({ runtime: f.runtime(invocationId),
    issuer: f.issuer, receiptTtlMs: 30_000 }))
}

test('real Store claims and applies an independently signed epoch without rewriting the successful deployment', async () => {
  const f = await createRuntimeEpochFixture()
  const before = historicalRows(f.plan.ledger.path, f.plan.id)
  const pending = prepare(f)
  expect(pending.status).toBe('pending')
  expect(prepare(f).request.operationId).toBe(pending.request.operationId)
  expect(f.coordinator.pendingRuntimeEpochs(f.handoff.coordinatorId).map(epoch => epoch.request.operationId))
    .toContain(pending.request.operationId)
  const claimed = f.coordinator.claimRuntimeEpoch(pending.request.operationId, f.handoff.coordinatorId)
  expect(claimed.status).toBe('claimed')
  const readOnly = new DatabaseSync(f.plan.ledger.path, { readOnly: true })
  try {
    readOnly.exec('PRAGMA query_only=ON; BEGIN')
    const context = readOwnerRuntimeEpochContext(readOnly, pending.request.operationId)
    expect(context).toMatchObject({ plan: { id: f.plan.id, status: 'activated' },
      request: { sequence: 1, predecessor: { operationId: f.signed.operation.operationId,
        receiptDigest: controlPlaneDigest(f.signed.receipt) } }, status: 'claimed' })
    readOnly.exec('COMMIT')
    expect(() => readOnly.exec('CREATE TABLE forbidden(epoch INTEGER)')).toThrow()
  } finally { readOnly.close() }
  const receipt = f.signEpoch(claimed.request)
  const applied = f.coordinator.applyRuntimeEpoch(receipt, f.trust)
  expect(applied).toMatchObject({ status: 'applied', receipt: { operationId: pending.request.operationId,
    runtimeIdentityDigest: pending.request.runtimeIdentityDigest, outcome: 'passed' } })
  expect(f.coordinator.latestAppliedRuntimeEpoch(f.plan.id)).toEqual(applied)
  expect(prepare(f).request.operationId).toBe(pending.request.operationId)
  expect(historicalRows(f.plan.ledger.path, f.plan.id)).toEqual(before)
})

test('a watched deployment can request a new proof after historical plan, approval, and handoff expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await createRuntimeEpochFixture()
  const historicalExpiry = Math.max(f.plan.expiresAt, f.receipt.expiresAt)
  vi.setSystemTime(historicalExpiry + 1)
  const pending = prepare(f)
  const claimed = f.coordinator.claimRuntimeEpoch(pending.request.operationId, f.handoff.coordinatorId)
  expect(claimed.request.requestedAt).toBeGreaterThan(historicalExpiry)
  expect(f.coordinator.applyRuntimeEpoch(f.signEpoch(claimed.request), f.trust).status).toBe('applied')
})

test.each(['closed-watch', 'revoked-handoff', 'new-checkpoint'] as const)('rejects %s before claiming a prepared epoch', async scenario => {
  const f = await createRuntimeEpochFixture()
  const pending = prepare(f)
  const db = new DatabaseSync(f.plan.ledger.path)
  try {
    if (scenario === 'closed-watch') {
      db.prepare(`UPDATE activation_watch SET state='closed-retracted',close_disposition='retracted',
        close_at=?,close_evidence_id='owner-retraction',close_signature_digest=? WHERE plan_id=?`)
        .run(Date.now(), 'a'.repeat(64), f.plan.id)
    } else if (scenario === 'revoked-handoff') {
      db.prepare('UPDATE adoption_handoffs SET revoked_at=? WHERE plan_id=?').run(Date.now(), f.plan.id)
    } else {
      const original = db.prepare('SELECT * FROM activation_plans WHERE id=?').get(f.plan.id) as Record<string, unknown>
      const successor: Record<string, unknown> = { ...original, id: 'successor', plan_digest: '9'.repeat(64), status: 'activated' }
      const columns = Object.keys(successor)
      db.prepare(`INSERT INTO activation_plans (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...columns.map(column => successor[column] as string | number | null))
      db.prepare('INSERT INTO activation_deployment_checkpoints VALUES (?, ?, 2, 2, ?, ?)')
        .run('successor', '[]', Date.now(), Date.now())
    }
  } finally { db.close() }
  expect(() => f.coordinator.claimRuntimeEpoch(pending.request.operationId, f.handoff.coordinatorId)).toThrow()
  expect(f.coordinator.getRuntimeEpoch(pending.request.operationId).status).toBe('pending')
})

test('a newer runtime sequence fences an older claimed request', async () => {
  const f = await createRuntimeEpochFixture()
  const first = prepare(f)
  f.coordinator.claimRuntimeEpoch(first.request.operationId, f.handoff.coordinatorId)
  const second = prepare(f, 'd'.repeat(32))
  expect(second.request.sequence).toBe(first.request.sequence + 1)
  const db = new DatabaseSync(f.plan.ledger.path, { readOnly: true })
  try { expect(() => readOwnerRuntimeEpochContext(db, first.request.operationId)).toThrow() }
  finally { db.close() }
  await expect(Promise.resolve().then(() => f.coordinator.applyRuntimeEpoch(f.signEpoch(first.request), f.trust))).rejects.toThrow()
  expect(f.coordinator.getRuntimeEpoch(first.request.operationId).status).toBe('stale')
  const claimed = f.coordinator.claimRuntimeEpoch(second.request.operationId, f.handoff.coordinatorId)
  expect(f.coordinator.applyRuntimeEpoch(f.signEpoch(claimed.request), f.trust).status).toBe('applied')
})

test('a signed failed receipt cannot become a readiness epoch', async () => {
  const f = await createRuntimeEpochFixture()
  const pending = prepare(f)
  const claimed = f.coordinator.claimRuntimeEpoch(pending.request.operationId, f.handoff.coordinatorId)
  const failed = f.signEpoch(claimed.request, { outcome: 'failed', evidence: { checks: 2, failures: 1, probeDigest: 'f'.repeat(64) } })
  expect(() => f.coordinator.applyRuntimeEpoch(failed, f.trust)).toThrow()
  expect(f.coordinator.getRuntimeEpoch(pending.request.operationId).status).toBe('claimed')
  expect(() => f.coordinator.latestAppliedRuntimeEpoch(f.plan.id)).toThrow('not independently verified')
})

test('an unproved newer identity blocks fallback, and returning to an old identity needs a new sequence', async () => {
  const f = await createRuntimeEpochFixture()
  const first = prepare(f)
  const firstClaimed = f.coordinator.claimRuntimeEpoch(first.request.operationId, f.handoff.coordinatorId)
  f.coordinator.applyRuntimeEpoch(f.signEpoch(firstClaimed.request), f.trust)
  const second = prepare(f, 'd'.repeat(32))
  expect(() => f.coordinator.latestAppliedRuntimeEpoch(f.plan.id)).toThrow('not independently verified')
  expect(prepare(f).request.operationId).not.toBe(second.request.operationId)
  expect(() => f.coordinator.latestAppliedRuntimeEpoch(f.plan.id)).toThrow('not independently verified')
  const third = f.coordinator.pendingRuntimeEpochs(f.handoff.coordinatorId).at(-1)!
  expect(third.request.sequence).toBe(second.request.sequence + 1)
  const claimed = f.coordinator.claimRuntimeEpoch(third.request.operationId, f.handoff.coordinatorId)
  expect(f.coordinator.applyRuntimeEpoch(f.signEpoch(claimed.request), f.trust).status).toBe('applied')
})

test('schema-25 upgrade adds the epoch journal while retaining signed historical rows', async () => {
  const f = await createRuntimeEpochFixture()
  const before = historicalRows(f.plan.ledger.path, f.plan.id)
  const db = new DatabaseSync(f.plan.ledger.path)
  try { db.exec('DROP TABLE deployment_runtime_epochs; PRAGMA user_version=25') }
  finally { db.close() }
  const reopened = new ControlPlaneStore({ path: f.plan.ledger.path })
  try {
    const check = new DatabaseSync(f.plan.ledger.path, { readOnly: true })
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 27 })
      expect(check.prepare('SELECT COUNT(*) AS n FROM deployment_runtime_epochs').get()).toEqual({ n: 0 })
    } finally { check.close() }
    expect(historicalRows(f.plan.ledger.path, f.plan.id)).toEqual(before)
    const pending = prepare(f)
    expect(pending.request.plan).toEqual({ id: f.plan.id, digest: f.plan.digest })
  } finally { reopened.close() }
})
