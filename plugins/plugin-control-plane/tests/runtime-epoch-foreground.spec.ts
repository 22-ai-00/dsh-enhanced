import { chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import type { ForegroundTaskIdentity } from '@dsh-enhanced/assistant-delivery'
import * as release from '../src/release.js'
vi.mock('../src/release.js', async importOriginal => ({ ...await importOriginal<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
import { createForegroundDeploymentObserver, queueRuntimeEpoch } from '../src/foreground-deployment-runtime.js'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.js'
import { cleanupRuntimeEpochFixtures, createRuntimeEpochFixture } from './helpers/runtime-epoch.js'

afterEach(async () => { vi.useRealTimers(); await cleanupRuntimeEpochFixtures() })

async function fixture() {
  const f = await createRuntimeEpochFixture()
  const owner = f.f.store.getOwnerTaskFailureReference(f.plan.gapId)!.owner
  let runtime = f.runtime()
  const task = (id: string, dispatchedAt = Date.now()): ForegroundTaskIdentity => ({
    protocol: 'assistant-delivery/foreground-task/v1', inboxId: id, sessionId: 'session',
    scope: { workspace: owner.workspace, preset: owner.agentPreset },
    owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
    binding: { id: 'binding', version: 1, generation: 1 }, dispatchedAt,
  })
  const observer = createForegroundDeploymentObserver({ config: { attestorJournalPath: f.signed.journalPath },
    profilePath: f.plan.target.profilePath, store: f.f.store, trust: f.trust,
    sample: challenge => ({ ...structuredClone(runtime), challenge, observedAt: Date.now() }), assertCurrent() {},
    owner: { ownsForegroundTaskObservationRegistration: () => true } })
  const begin = (value: ForegroundTaskIdentity) => f.f.options.withSourceFence!(() => observer.begin(value))
  const complete = (value: ForegroundTaskIdentity, handle: unknown) => observer.completed(handle, value, {
    executionRef: value.inboxId, dispatchedAt: value.dispatchedAt, completedAt: Date.now(), status: 'succeeded', quiescent: true,
    modelSelectionState: 'frozen', modelSelection: { provider: 'user-provider', model: 'user-model' },
  })
  const attest = async () => {
    const record = f.coordinator.pendingRuntimeEpochs(f.handoff.coordinatorId)[0]!
    const claimed = f.coordinator.claimRuntimeEpoch(record.request.operationId, f.handoff.coordinatorId)
    const { challenge: _challenge, observedAt: _observedAt, ...stable } = runtime
    const observation = { requestDigest: controlPlaneDigest(claimed.request), runtime: stable, observedAt: Date.now(), samples: [1, 2] }
    const receipt = f.signEpoch(claimed.request, { evidence: { checks: 2, failures: 0, probeDigest: controlPlaneDigest(observation) } })
    const path = join(dirname(f.signed.journalPath), 'runtime-epochs.sqlite'), db = new DatabaseSync(path)
    try {
      db.exec('CREATE TABLE IF NOT EXISTS runtime_epochs(operation_id TEXT PRIMARY KEY,request_digest TEXT,observation TEXT,receipt TEXT)')
      db.prepare('INSERT INTO runtime_epochs VALUES (?,?,?,?)').run(receipt.operationId, receipt.requestDigest, JSON.stringify(observation), JSON.stringify(receipt))
    } finally { db.close() }
    await chmod(path, 0o600)
    f.coordinator.applyRuntimeEpoch(receipt, f.trust)
    return receipt
  }
  return { ...f, task, observer, begin, complete, attest, restart: () => { runtime = { ...runtime, invocationId: '9'.repeat(32), processId: runtime.processId + 1 } } }
}

test('restarted runtime resumes task attribution only after an independently signed epoch, without backfilling earlier tasks', async () => {
  const f = await fixture()
  const original = f.task('original'), originalHandle = f.begin(original)
  f.complete(original, originalHandle)
  expect(f.f.store.getForegroundDeployment(original.inboxId)?.state).toBe('observed')
  f.restart()
  const during = f.task('before-proof')
  expect(() => f.begin(during)).toThrow()
  expect(f.f.store.getForegroundDeployment(during.inboxId)).toBeUndefined()
  await new Promise(resolve => setTimeout(resolve, 20))
  const receipt = await f.attest()
  expect(() => f.begin(during)).toThrow('outside')
  const after = f.task('after-proof'), handle = f.begin(after)
  f.complete(after, handle)
  expect(f.f.store.getForegroundDeployment(after.inboxId)).toMatchObject({ state: 'observed',
    readiness: { runtimeEpoch: { operationId: receipt.operationId, sequence: 1 } } })
  expect(f.f.store.getForegroundDeployment(original.inboxId)?.readiness.runtimeEpoch).toBeUndefined()
  f.coordinator.close()
})

test('a changed epoch during a foreground task suppresses its completion attribution', async () => {
  const f = await fixture(), task = f.task('old-runtime'), handle = f.begin(task)
  f.restart(); expect(() => f.begin(f.task('queue'))).toThrow()
  await f.attest()
  f.complete(task, handle)
  expect(f.f.store.getForegroundDeployment(task.inboxId)?.state).toBe('unknown')
  f.coordinator.close()
})

test('the resident Store queues only through the current owner source fence used by service startup and task fallback', async () => {
  const f = await createRuntimeEpochFixture(), resident = new ControlPlaneStore({ path: f.plan.ledger.path })
  try {
    const runtime = f.runtime('9'.repeat(32))
    expect(() => queueRuntimeEpoch(resident, f.trust, runtime)).toThrow('source admission')
    expect(() => queueRuntimeEpoch(resident, f.trust, runtime, () => { throw new Error('owner correction') })).toThrow('owner correction')
    expect(f.coordinator.pendingRuntimeEpochs(f.handoff.coordinatorId)).toHaveLength(0)
    const fence = vi.fn((gapId: string, owner: unknown, callback: () => void) => {
      expect(gapId).toBe(f.plan.gapId)
      expect(owner).toEqual(f.f.store.getOwnerTaskFailureReference(f.plan.gapId)!.owner)
      // OwnerTaskFailureGaps.withCurrent owns admission on the resident Store.
      f.f.options.withSourceFence!(() => resident.withOwnerTaskFailureGapAdmission(gapId, callback))
    })
    queueRuntimeEpoch(resident, f.trust, runtime, fence)
    expect(fence).toHaveBeenCalledOnce()
    expect(f.coordinator.pendingRuntimeEpochs(f.handoff.coordinatorId)).toHaveLength(1)
  } finally { resident.close(); f.coordinator.close() }
})
