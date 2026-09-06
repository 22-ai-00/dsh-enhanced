import { mkdtemp, rm } from 'node:fs/promises'
import { chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskAcceptanceContract, createTaskVerificationReceipt, type TaskAcceptanceContract, type TaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { AcceptanceStore, AcceptanceStoreError } from '../src/store.ts'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function database(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'acceptance-store-')); cleanup.push(path); return join(path, 'store.sqlite') }
function contract(workspace: string, id = 'contract-1', expiresAt = 10_000, ref = 'run-1'): TaskAcceptanceContract {
  return createTaskAcceptanceContract({ protocol: 'task-acceptance/v1', id, scope: { workspace, preset: 'test' }, owner: { principalRecordId: 'owner-1', principalVersion: 1 }, task: { kind: 'automation-run', ref }, objective: 'objective', profile: { id: 'profile-1', version: 1, digest: 'a'.repeat(64) }, issuedAt: 1, expiresAt, criteria: [{ id: 'process-1', kind: 'process-behavior', authority: { id: 'runner-1', digest: 'b'.repeat(64) }, artifactPath: 'result.txt', stdin: '', expectedStdout: '', expectedExitCode: 0 }], bounds: { maxDurationMs: 100, maxEvidenceBytes: 1024 } })
}
function goalContract(workspace: string, id = 'goal-contract-1', nativeRevision = 1): TaskAcceptanceContract {
  return createTaskAcceptanceContract({ protocol: 'task-acceptance/v2', id, scope: { workspace, preset: 'test' }, owner: { principalRecordId: 'owner-1', principalVersion: 1 }, task: { kind: 'goal-step', ref: 'goal-run-1', goal: { id: 'goal-1', definitionVersion: 1, definitionDigest: 'a'.repeat(64), stepId: 'step-1', runId: 'goal-run-1', sessionId: 'session-1', nativeGoalId: 'native-1', nativeRevision } }, objective: 'objective', profile: { id: 'profile-1', version: 1, digest: 'a'.repeat(64) }, issuedAt: 1, expiresAt: 10_000, criteria: [{ id: 'process-1', kind: 'process-behavior', authority: { id: 'runner-1', digest: 'b'.repeat(64) }, artifactPath: 'result.txt', stdin: '', expectedStdout: '', expectedExitCode: 0 }], bounds: { maxDurationMs: 100, maxEvidenceBytes: 1024 } })
}
function receipt(contract: TaskAcceptanceContract, id: string, status: 'passed' | 'failed' | 'unknown' = 'passed', completedAt = 30): TaskVerificationReceipt {
  return createTaskVerificationReceipt(contract, { protocol: 'task-verification/v1', id, contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task, results: [{ criterionId: 'process-1', status, reason: status === 'unknown' ? 'unavailable' : 'verified', evidence: [] }], startedAt: 11, completedAt, validUntil: Math.min(9_000, contract.expiresAt) })
}
function finishable(store: AcceptanceStore, contract: TaskAcceptanceContract, now = 20) {
  store.markExecutionFinished(contract.id, { status: 'succeeded', quiescent: true, completedAt: 10, executionRef: 'execution-1' })
  const claim = store.claimDue({ workerId: 'worker-1', now, leaseMs: 5_100 }); if (claim === null) throw new Error('expected job claim'); return claim
}

describe('acceptance SQLite ledger', () => {
  it('reaches jobs beyond an unresolved first page and expires later jobs fairly', async () => {
    const path = await database(); const workspace = join(path, '..'); const store = new AcceptanceStore(path)
    for (let index = 0; index < 102; index++) {
      const id = `contract-${String(index).padStart(3, '0')}`
      store.accept(contract(workspace, id, index === 101 ? 100 : 10_000, id))
    }
    const first = store.awaitingExecution()
    expect(first).toHaveLength(100)
    expect(store.awaitingExecution(100, first.at(-1)!.id).map(item => item.id)).toEqual(['contract-100', 'contract-101'])
    expect(store.expireAwaiting(100)).toBe(1)
    expect(store.getState('contract-101')).toMatchObject({ state: 'needs-attention', reason: 'execution-unconfirmed' })
    expect(store.getState('contract-000')?.state).toBe('awaiting-execution')
    store.close()
  })

  it('keeps expired outbox evidence but permits paging to a later live receipt', async () => {
    const path = await database(); const workspace = join(path, '..'); const store = new AcceptanceStore(path)
    for (let index = 0; index < 101; index++) {
      const id = `contract-${String(index).padStart(3, '0')}`
      const input = contract(workspace, id, index === 100 ? 10_000 : 100, id)
      store.accept(input)
      const claim = finishable(store, input)
      store.finish({ contractId: input.id, workerId: claim.job.workerId, fencingToken: claim.job.fencingToken,
        now: 31, receipt: receipt(input, `receipt-${String(index).padStart(3, '0')}`), reason: 'verified' })
    }
    const expired = store.pendingReceipts()
    expect(expired).toHaveLength(100)
    expect(store.counts(101)).toEqual({ awaitingExecution: 0, pendingVerification: 0, needsAttention: 0,
      pendingReceipts: 101, expiredReceipts: 100 })
    expect(expired.every(item => item.receipt.validUntil === 100)).toBe(true)
    const live = store.pendingReceipts(100, expired.at(-1)!.receipt.id)
    expect(live).toMatchObject([{ receipt: { id: 'receipt-100', validUntil: 9_000 } }])
    store.acknowledgeReceipt(live[0]!.receipt.id, live[0]!.receipt.digest)
    store.close()
    const reopened = new AcceptanceStore(path)
    expect(reopened.pendingReceipts()).toHaveLength(100)
    expect(reopened.pendingReceipts(100, expired.at(-1)!.receipt.id)).toEqual([])
    reopened.close()
  })

  it('persists immutable acceptance and restart-reconcilable pre-execution work', async () => {
    const path = await database(); const workspace = await mkdtemp(join(tmpdir(), 'acceptance-workspace-')); cleanup.push(workspace); const input = contract(workspace)
    const first = new AcceptanceStore(path); expect(first.accept(input)).toEqual(input); expect(first.awaitingExecution()).toEqual([input]); first.close()
    const second = new AcceptanceStore(path); expect(second.getContract(input.id)).toEqual(input); expect(second.getTaskContract({ scope: input.scope, owner: input.owner, task: input.task })).toEqual(input)
    expect(() => second.accept(contract(workspace, 'contract-conflict'))).toThrow(AcceptanceStoreError)
    second.markExecutionFinished(input.id, { status: 'succeeded', quiescent: true, completedAt: 10, executionRef: 'execution-1' })
    expect(() => second.markExecutionFinished(input.id, { status: 'failed', quiescent: true, completedAt: 10, executionRef: 'execution-1' })).toThrow(/immutable/)
    second.close()
  })

  it('rejects a goal-step lookup whose ref matches but complete binding differs', async () => {
    const path = await database(); const workspace = await mkdtemp(join(tmpdir(), 'acceptance-goal-workspace-')); cleanup.push(workspace)
    const input = goalContract(workspace); const store = new AcceptanceStore(path); store.accept(input)
    expect(store.getTaskContract({ scope: input.scope, owner: input.owner, task: input.task })).toEqual(input)
    const wrong = goalContract(workspace, 'other-goal-contract', 2)
    expect(() => store.getTaskContract({ scope: wrong.scope, owner: wrong.owner, task: wrong.task })).toThrow(/task binding differs/)
    store.close()
  })

  it('fences competing connections and reclaims only an expired lease', async () => {
    const path = await database(); const workspace = await mkdtemp(join(tmpdir(), 'acceptance-workspace-')); cleanup.push(workspace); const input = contract(workspace, 'contract-2', 9_000); const left = new AcceptanceStore(path); const right = new AcceptanceStore(path); left.accept(input); left.markExecutionFinished(input.id, { status: 'succeeded', quiescent: true, completedAt: 10, executionRef: 'execution-2' })
    const first = left.claimDue({ workerId: 'worker-a', now: 20, leaseMs: 5_100 }); expect(first?.job.fencingToken).toBe(1); expect(right.claimDue({ workerId: 'worker-b', now: 21, leaseMs: 5_100 })).toBeNull()
    const reclaimed = right.claimDue({ workerId: 'worker-b', now: 5_121, leaseMs: 5_100 }); expect(reclaimed?.job.fencingToken).toBe(2)
    expect(() => left.finish({ contractId: input.id, workerId: 'worker-a', fencingToken: 1, now: 5_122, receipt: receipt(input, 'receipt-stale', 'passed', 5_122), reason: 'verified' })).toThrow(/lease/)
    right.finish({ contractId: input.id, workerId: 'worker-b', fencingToken: 2, now: 5_122, receipt: receipt(input, 'receipt-2', 'passed', 5_122), reason: 'verified' })
    expect(right.getState(input.id)?.state).toBe('done'); left.close(); right.close()
  })

  it('keeps unknown attempts durable, emits each receipt, and expires to attention without forged proof', async () => {
    const path = await database(); const workspace = await mkdtemp(join(tmpdir(), 'acceptance-workspace-')); cleanup.push(workspace); const input = contract(workspace, 'contract-3', 100); const store = new AcceptanceStore(path); store.accept(input)
    const first = finishable(store, input); const unknown = receipt(input, 'receipt-unknown', 'unknown', 30)
    store.finish({ contractId: input.id, workerId: first.job.workerId, fencingToken: first.job.fencingToken, now: 31, receipt: unknown, reason: 'source-unavailable', retryAt: 40 })
    expect(store.getState(input.id)).toMatchObject({ state: 'pending', attempts: 1, receipt: { id: 'receipt-unknown', objectiveStatus: 'unknown' } }); expect(store.pendingReceipts()).toHaveLength(1)
    const second = store.claimDue({ workerId: 'worker-2', now: 40, leaseMs: 5_100 }); if (second === null) throw new Error('expected retry')
    store.finish({ contractId: input.id, workerId: second.job.workerId, fencingToken: second.job.fencingToken, now: 100, receipt: null, reason: 'deadline' })
    expect(store.getState(input.id)).toMatchObject({ state: 'needs-attention', receipt: null, reason: 'contract-expired' }); expect(store.listAttention()).toHaveLength(1); store.close()
  })

  it('makes expired pre-execution contracts actionable after reopening without inventing proof', async () => {
    const path = await database(); const workspace = await mkdtemp(join(tmpdir(), 'acceptance-workspace-')); cleanup.push(workspace); const input = contract(workspace, 'contract-lost-proof', 100)
    const first = new AcceptanceStore(path); first.accept(input); first.close()
    const reopened = new AcceptanceStore(path); expect(reopened.expireAwaiting(100)).toBe(1); expect(reopened.awaitingExecution()).toEqual([])
    expect(reopened.getState(input.id)).toEqual({ state: 'needs-attention', attempts: 0, reason: 'execution-unconfirmed', receipt: null, execution: null })
    expect(reopened.listAttention()).toMatchObject([{ contract: { id: input.id }, reason: 'execution-unconfirmed', receipt: null, execution: null }]); reopened.close()
  })

  it('acknowledges outbox delivery independently across restart', async () => {
    const path = await database(); const workspace = await mkdtemp(join(tmpdir(), 'acceptance-workspace-')); cleanup.push(workspace); const input = contract(workspace, 'contract-4'); const first = new AcceptanceStore(path); first.accept(input); const claim = finishable(first, input); const proof = receipt(input, 'receipt-4')
    first.finish({ contractId: input.id, workerId: claim.job.workerId, fencingToken: claim.job.fencingToken, now: 31, receipt: proof, reason: 'verified' }); expect(first.pendingReceipts()).toHaveLength(1); first.close()
    const second = new AcceptanceStore(path); expect(second.pendingReceipts()).toMatchObject([{ receipt: { id: proof.id, digest: proof.digest } }]); second.acknowledgeReceipt(proof.id, proof.digest); expect(second.pendingReceipts()).toEqual([]); second.close()
  })

  it('fails closed after a reopened database is tampered to claim done without a receipt', async () => {
    const path = await database(); const workspace = await mkdtemp(join(tmpdir(), 'acceptance-workspace-')); cleanup.push(workspace); const input = contract(workspace, 'contract-tampered-done'); const original = new AcceptanceStore(path); original.accept(input); const claim = finishable(original, input); original.finish({ contractId: input.id, workerId: claim.job.workerId, fencingToken: claim.job.fencingToken, now: 31, receipt: receipt(input, 'receipt-tampered-done'), reason: 'verified' }); original.close()
    const raw = new DatabaseSync(path); raw.prepare('UPDATE acceptance_jobs SET receipt = NULL WHERE contract_id = ?').run(input.id); raw.close()
    const reopened = new AcceptanceStore(path); expect(() => reopened.getState(input.id)).toThrow(/done job lacks a known receipt/); reopened.close()
  })

  it('fails closed after a reopened database has execution evidence outside its contract', async () => {
    const path = await database(); const workspace = await mkdtemp(join(tmpdir(), 'acceptance-workspace-')); cleanup.push(workspace); const input = contract(workspace, 'contract-tampered-execution'); const original = new AcceptanceStore(path); original.accept(input); original.markExecutionFinished(input.id, { status: 'succeeded', quiescent: true, completedAt: 10, executionRef: 'execution-tampered' }); original.close()
    const raw = new DatabaseSync(path); raw.prepare('UPDATE acceptance_jobs SET execution = ? WHERE contract_id = ?').run(JSON.stringify({ status: 'succeeded', quiescent: true, completedAt: 0, executionRef: 'execution-tampered' }), input.id); raw.close()
    const reopened = new AcceptanceStore(path); expect(() => reopened.getState(input.id)).toThrow(/stored execution predates contract/); reopened.close()
  })

  it('rejects an existing version-one database that has no acceptance schema', async () => {
    const path = await database(); const raw = new DatabaseSync(path); raw.exec('PRAGMA user_version = 1'); raw.close(); chmodSync(path, 0o600)
    expect(() => new AcceptanceStore(path)).toThrow(/database schema/)
  })

  it('rejects an existing version-one ledger after a critical table is removed', async () => {
    const path = await database(); const original = new AcceptanceStore(path); original.close()
    const raw = new DatabaseSync(path); raw.exec('DROP TABLE acceptance_receipts'); raw.close()
    expect(() => new AcceptanceStore(path)).toThrow(/database schema/)
  })
})
