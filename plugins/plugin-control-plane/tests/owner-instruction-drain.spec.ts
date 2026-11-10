import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPlaneStore } from '../src/store.ts'
import { drainOwnerInstructionRequests, OWNER_INSTRUCTION_CLAIM_TIMEOUT_MS, type OwnerInstructionAdmit } from '../src/owner-instruction-drain.ts'
import type { ScopedPluginFile } from '../src/source-workspace.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function ledger() {
  const root = mkdtempSync(join(tmpdir(), 'cp-drain-'))
  roots.push(root)
  const store = new ControlPlaneStore({ path: join(root, 'control.sqlite') })
  return { root, store }
}

const files: ScopedPluginFile[] = [{ path: 'README.md', content: '# demo\n' }]
const base = {
  planId: 'plan-1', pluginName: 'demo-plugin', expectedBaseCommit: 'a'.repeat(40),
  files, ttlMs: 900_000, idempotencyKey: 'key-1', createdAt: 1_000,
}

describe('drainOwnerInstructionRequests', () => {
  it('claims and accepts each pending request once, never re-draining accepted rows', async () => {
    const { store } = ledger()
    const first = store.recordOwnerInstructionRequest(base)
    const second = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-2', idempotencyKey: 'key-2', createdAt: 2_000 })
    const admit = vi.fn(async () => ({ instructionId: 'instr', jobId: 'source-job-' + 'a'.repeat(64) }))
    const result = await drainOwnerInstructionRequests({ store, admit, now: 5_000 })
    expect(admit).toHaveBeenCalledTimes(2)
    expect(result.accepted.map(item => item.requestId).sort()).toEqual([first.requestId, second.requestId].sort())
    expect(result.rejected).toEqual([])
    expect(store.getOwnerInstructionRequest(first.requestId)?.status).toBe('accepted')
    expect(store.getOwnerInstructionRequest(second.requestId)?.status).toBe('accepted')
    // A second pass finds nothing pending.
    const again = await drainOwnerInstructionRequests({ store, admit, now: 6_000 })
    expect(again.accepted).toEqual([])
    expect(admit).toHaveBeenCalledTimes(2)
    store.close()
  })

  it('rejects a request whose admission throws and records a bounded failure code', async () => {
    const { store } = ledger()
    const request = store.recordOwnerInstructionRequest(base)
    const failingAdmit: OwnerInstructionAdmit = async () => { throw new Error('plugin-control-plane: owner route missing') }
    const result = await drainOwnerInstructionRequests({ store, admit: failingAdmit, now: 5_000 })
    expect(result.accepted).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]!.failureCode).toBe('owner-route-unavailable')
    expect(store.getOwnerInstructionRequest(request.requestId)).toMatchObject({ status: 'rejected',
      failureCode: 'owner-route-unavailable' })
    store.close()
  })

  it('maps an expired revision grant to a distinct failure code', async () => {
    const { store } = ledger()
    store.recordOwnerInstructionRequest(base)
    const result = await drainOwnerInstructionRequests({ store,
      admit: async () => { throw new Error('plugin-control-plane: the source revision grant is expired') }, now: 5_000 })
    expect(result.rejected[0]!.failureCode).toBe('revision-grant-expired')
    store.close()
  })

  it('skips an expired request via the store CAS without calling admit', async () => {
    const { store } = ledger()
    const request = store.recordOwnerInstructionRequest(base)
    const admit = vi.fn(async () => ({ instructionId: 'instr', jobId: 'source-job-' + 'a'.repeat(64) }))
    // After the request's expiry (createdAt 1000 + ttl 900000 = 901000) the claim fails.
    const result = await drainOwnerInstructionRequests({ store, admit, now: 1_000_000 })
    expect(admit).not.toHaveBeenCalled()
    expect(result.accepted).toEqual([])
    expect(store.getOwnerInstructionRequest(request.requestId)).toMatchObject({ status: 'rejected', failureCode: 'request-expired' })
    store.close()
  })

  it('caps the number of requests handled in one pass', async () => {
    const { store } = ledger()
    for (const index of [0, 1, 2]) {
      store.recordOwnerInstructionRequest({ ...base, planId: `plan-${index}`, idempotencyKey: `key-${index}`, createdAt: 1_000 + index })
    }
    const admit = vi.fn(async () => ({ instructionId: 'instr', jobId: 'source-job-' + 'a'.repeat(64) }))
    const result = await drainOwnerInstructionRequests({ store, admit, now: 5_000, maxPerPass: 2 })
    expect(admit).toHaveBeenCalledTimes(2)
    expect(result.accepted).toHaveLength(2)
    const remaining = store.listPendingOwnerInstructionRequests(5_000)
    expect(remaining).toHaveLength(1)
    store.close()
  })

  it('reclaims a claim orphaned by a crashed process and drains it on the next pass', async () => {
    const { store, root } = ledger()
    const orphan = store.recordOwnerInstructionRequest(base)
    expect(store.claimOwnerInstructionRequest(orphan.requestId, 10_000)).toBe(1)
    store.close()
    // Simulate a process that died between the CAS and the settle: the row is
    // still claimed with a stale claim time, invisible to the pending listing.
    const now = 10_000 + OWNER_INSTRUCTION_CLAIM_TIMEOUT_MS + 1
    const raw = new DatabaseSync(join(root, 'control.sqlite'))
    expect(raw.prepare("SELECT status FROM source_owner_instruction_requests WHERE request_id = ?").get(orphan.requestId))
      .toMatchObject({ status: 'claimed' })
    raw.close()
    const reopened = new ControlPlaneStore({ path: join(root, 'control.sqlite') })
    expect(reopened.listPendingOwnerInstructionRequests(now)).toEqual([])
    const admit = vi.fn(async () => ({ instructionId: 'instr', jobId: 'source-job-' + 'a'.repeat(64) }))
    const result = await drainOwnerInstructionRequests({ store: reopened, admit, now })
    expect(result.reclaimed).toBe(1)
    expect(admit).toHaveBeenCalledTimes(1)
    expect(result.accepted.map(item => item.requestId)).toEqual([orphan.requestId])
    expect(reopened.getOwnerInstructionRequest(orphan.requestId)?.status).toBe('accepted')
    reopened.close()
  })

  it('requeues a transient admission failure instead of permanently rejecting the request', async () => {
    const { store } = ledger()
    const request = store.recordOwnerInstructionRequest(base)
    const transient = new Error('plugin-control-plane: another source operation is draining')
    const admit = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ instructionId: 'instr', jobId: 'source-job-' + 'a'.repeat(64) })
    const first = await drainOwnerInstructionRequests({ store, admit, now: 5_000 })
    expect(first.rejected).toEqual([])
    expect(first.retried.map(item => item.requestId)).toEqual([request.requestId])
    const requeued = store.getOwnerInstructionRequest(request.requestId)
    expect(requeued).toMatchObject({ status: 'pending', claimedAt: null })
    // The next pass lists and drains the requeued request successfully.
    const second = await drainOwnerInstructionRequests({ store, admit, now: 6_000 })
    expect(second.accepted.map(item => item.requestId)).toEqual([request.requestId])
    expect(store.getOwnerInstructionRequest(request.requestId)?.status).toBe('accepted')
    expect(admit).toHaveBeenCalledTimes(2)
    store.close()
  })

  it('requeues an aborted admission while keeping a genuine authorization rejection terminal', async () => {
    const { store } = ledger()
    const transient = store.recordOwnerInstructionRequest({ ...base, idempotencyKey: 'key-abort' })
    const terminal = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-2', idempotencyKey: 'key-denied' })
    const admit = vi.fn(async request => {
      if (request.requestId === transient.requestId) {
        const error = new Error('operation was aborted'); error.name = 'AbortError'; throw error
      }
      throw new Error('plugin-control-plane: owner instruction target does not match the adopted parent')
    })
    const result = await drainOwnerInstructionRequests({ store, admit, now: 5_000 })
    expect(result.retried.map(item => item.requestId)).toEqual([transient.requestId])
    expect(result.rejected.map(item => item.request.requestId)).toEqual([terminal.requestId])
    expect(store.getOwnerInstructionRequest(transient.requestId)?.status).toBe('pending')
    expect(store.getOwnerInstructionRequest(terminal.requestId)).toMatchObject({ status: 'rejected', failureCode: 'parent-mismatch' })
    store.close()
  })

  it('loads only the first bounded batch even when the following rows are corrupt', async () => {
    const { store, root } = ledger()
    const healthy = store.recordOwnerInstructionRequest(base)
    for (let index = 0; index < 24; index++) {
      store.recordOwnerInstructionRequest({ ...base, idempotencyKey: `later-${index}`, createdAt: 2_000 + index })
    }
    const raw = new DatabaseSync(join(root, 'control.sqlite'))
    try {
      raw.prepare(`UPDATE source_owner_instruction_requests SET files_json=json_set(files_json,'$[0].content','# tampered')
        WHERE request_id <> ?`).run(healthy.requestId)
      expect(store.listPendingOwnerInstructionRequests(5_000, 1)).toEqual([healthy])
      const admit = vi.fn(async () => ({ instructionId: 'instr', jobId: 'source-job-' + 'a'.repeat(64) }))
      const first = await drainOwnerInstructionRequests({ store, admit, now: 5_000, maxPerPass: 1 })
      expect(first.accepted.map(item => item.requestId)).toEqual([healthy.requestId])
      expect(first.quarantined).toBe(0)
      const pending = raw.prepare("SELECT count(*) AS n FROM source_owner_instruction_requests WHERE status = 'pending'")
      expect(pending.get()?.n).toBe(24)
      const second = await drainOwnerInstructionRequests({ store, admit, now: 6_000, maxPerPass: 1 })
      expect(second.accepted).toEqual([])
      expect(second.quarantined).toBe(1)
      expect(pending.get()?.n).toBe(23)
      expect(admit).toHaveBeenCalledOnce()
    } finally { raw.close(); store.close() }
  })

  it('quarantines a corrupt pending row so healthy requests behind it still drain', async () => {
    const { store, root } = ledger()
    const corrupt = store.recordOwnerInstructionRequest(base)
    const healthy = store.recordOwnerInstructionRequest({ ...base, planId: 'plan-2', idempotencyKey: 'key-2', createdAt: 2_000 })
    store.close()
    const raw = new DatabaseSync(join(root, 'control.sqlite'))
    raw.prepare(`UPDATE source_owner_instruction_requests SET files_json=json_set(files_json,'$[0].content','# tampered') WHERE request_id = ?`)
      .run(corrupt.requestId)
    raw.close()
    const reopened = new ControlPlaneStore({ path: join(root, 'control.sqlite') })
    expect(() => reopened.listPendingOwnerInstructionRequests(5_000)).toThrow(/corrupt/u)
    const admit = vi.fn(async () => ({ instructionId: 'instr', jobId: 'source-job-' + 'a'.repeat(64) }))
    const result = await drainOwnerInstructionRequests({ store: reopened, admit, now: 5_000 })
    expect(result.quarantined).toBe(1)
    // The corrupt row is rejected; read it raw because digest validation must
    // keep failing on its corrupted contents even after quarantine.
    const quarantineRaw = new DatabaseSync(join(root, 'control.sqlite'))
    expect(quarantineRaw.prepare('SELECT status, failure_code FROM source_owner_instruction_requests WHERE request_id = ?').get(corrupt.requestId))
      .toMatchObject({ status: 'rejected', failure_code: 'request-corrupt' })
    quarantineRaw.close()
    // The healthy row was not blocked by the corrupt one.
    expect(admit).toHaveBeenCalledTimes(1)
    expect(result.accepted.map(item => item.requestId)).toEqual([healthy.requestId])
    reopened.close()
  })
})
