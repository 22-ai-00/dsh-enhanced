import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.ts'
import { ControlPlaneStore } from '../src/store.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { foregroundDeploymentFixture as fixture, cleanupForegroundDeploymentFixtures } from './helpers/foreground-deployment.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
afterEach(cleanupForegroundDeploymentFixtures)

test('real signed readiness binds the current task and durable completion, without inventing quality', async () => {
  const f = await fixture(), handle = f.observer.begin(f.task)
  expect(f.store.getForegroundDeployment(f.task.inboxId)?.state).toBe('pending')
  f.observer.completed(handle, f.task, f.execution())
  const captured = f.store.getForegroundDeployment(f.task.inboxId)!
  expect(captured).toMatchObject({ state: 'observed', task: f.task, readiness: { planId: f.plan.id,
    exact: { package: f.plan.candidate.package, version: f.plan.candidate.version, integrity: f.plan.candidate.integrity } } })
  expect(f.store.getActivationWatch(f.plan.id)).toMatchObject({ state: 'watching', healthyObservations: 0 })
  const reopened = new ControlPlaneStore({ path: f.plan.ledger.path })
  try { expect(reopened.getForegroundDeployment(f.task.inboxId)).toEqual(captured) } finally { reopened.close() }
  expect(() => f.observer.begin(f.task)).toThrow()
})

test.each(['generation', 'unknown', 'superseded'] as const)('completion becomes unknown on %s', async mode => {
  const f = await fixture(), handle = f.observer.begin(f.task), execution = { ...f.execution() }
  if (mode === 'generation') f.signed.runtime.entries[0]!.instance!.epoch++
  if (mode === 'unknown') { execution.status = 'unknown'; execution.quiescent = false }
  if (mode === 'superseded') {
    const db = new DatabaseSync(f.plan.ledger.path)
    try { db.prepare('UPDATE activation_deployment_checkpoints SET successful_order = NULL WHERE plan_id = ?').run(f.plan.id) } finally { db.close() }
  }
  f.observer.completed(handle, f.task, execution)
  expect(f.store.getForegroundDeployment(f.task.inboxId)?.state).toBe('unknown')
})

test('rejects pre-deployment and cross-owner task attribution and suppresses late completion', async () => {
  const f = await fixture()
  expect(() => f.observer.begin({ ...f.task, owner: { ...f.task.owner, principalVersion: 2 } })).toThrow('owner')
  expect(() => f.observer.begin({ ...f.task, dispatchedAt: 1 })).toThrow('watched')
  const handle = f.observer.begin(f.task); f.dispose()
  expect(() => f.observer.completed(handle, f.task, f.execution())).toThrow('disposed')
  expect(f.store.getForegroundDeployment(f.task.inboxId)?.state).toBe('pending')
})

test('schema 19 migration preserves adoption and does not backfill historical tasks', async () => {
  const f = await fixture(), db = new DatabaseSync(f.plan.ledger.path)
  try { db.exec('DROP TABLE foreground_deployments; PRAGMA user_version = 19;') } finally { db.close() }
  const migrated = openControlPlaneDatabase(f.plan.ledger.path)
  try {
    expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(controlPlaneSchemaVersion)
    expect(migrated.prepare('SELECT count(*) AS n FROM foreground_deployments').get()?.n).toBe(0)
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(migrated.prepare('SELECT activation_plan_id FROM source_adoptions').get()?.activation_plan_id).toBe(f.plan.id)
  } finally { migrated.close() }
})
