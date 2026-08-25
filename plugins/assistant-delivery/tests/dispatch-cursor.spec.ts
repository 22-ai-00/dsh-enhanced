import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('approval dispatch scan cursor', () => {
  test('persists its high-water mark and rejects a concurrent stale fence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-dispatch-cursor-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const first = new DeliveryStore({ path, now: () => 10_000 })
    const second = new DeliveryStore({ path, now: () => 10_001 })
    const initial = first.getApprovalDispatchCursor()
    expect(initial).toEqual({ version: 0 })
    expect(second.getApprovalDispatchCursor()).toEqual(initial)

    const after = { createdAt: 9_000, proposalId: 'proposal-100' }
    expect(first.advanceApprovalDispatchCursor({ expectedVersion: initial.version, after }))
      .toEqual({ version: 1, after })
    expect(() => second.advanceApprovalDispatchCursor({ expectedVersion: initial.version,
      after: { createdAt: 9_001, proposalId: 'proposal-stale' } }))
      .toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    first.close()
    second.close()

    const restarted = new DeliveryStore({ path, now: () => 10_002 })
    expect(restarted.getApprovalDispatchCursor()).toEqual({ version: 1, after })
    expect(restarted.advanceApprovalDispatchCursor({ expectedVersion: 1 })).toEqual({ version: 2 })
    restarted.close()
  })
})
