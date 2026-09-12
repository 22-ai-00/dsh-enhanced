import { describe, expect, test, vi } from 'vitest'
import { enqueueRepairFeedback, repairFeedbackIdempotencyKey, renderRepairFeedback, type RepairFeedbackDelivery, type RepairFeedbackRecord, type RepairIterationOutcome } from '../src/repair-feedback.js'

const receipt = { receiptVersion: 2, authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: '/workspace', agentPreset: 'primary', bindingVersion: 1, generation: 1 }
const record: RepairFeedbackRecord = { id: 'repair-1', scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: '/workspace', preset: 'primary' }, authorization: { ownerRouteId: 'owner-route' }, routeReceipt: receipt, feedbackAuthority: { sessionId: 'current-owner-session', expiresAt: Date.now() + 60_000, routeReceipt: receipt } }
const outcome: RepairIterationOutcome = { iteration: 1, maxIterations: 2, state: 'watching', milestone: 'finite-canary', candidateId: 'candidate-secret', deploymentId: 'deployment-secret', goalId: 'goal-secret' }

function delivery(overrides: Partial<RepairFeedbackDelivery> = {}) {
  return { validateOwnerRoute: vi.fn(() => receipt), enqueueOwnerNotification: vi.fn(() => ({ id: 'outbox-1' })), ...overrides } satisfies RepairFeedbackDelivery
}

describe('repair feedback', () => {
  test('queues a stable private finite-canary notice using the frozen owner session', () => {
    const port = delivery(), first = enqueueRepairFeedback(port, record, outcome), second = enqueueRepairFeedback(port, record, outcome)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ outcome: 'queued', idempotencyKey: 'repair-feedback:repair-1:1:finite-canary' })
    expect(port.enqueueOwnerNotification).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'dsh-enhanced-assistant-skills', sessionId: 'current-owner-session', expiresAt: record.feedbackAuthority.expiresAt, idempotencyKey: 'repair-feedback:repair-1:1:finite-canary' }))
    expect(first.outcome === 'queued' && first.text).not.toMatch(/candidate-secret|deployment-secret|goal-secret|complete|read/u)
  })

  test('uses exact route receipts and never queues after route lineage drifts', () => {
    const port = delivery({ validateOwnerRoute: vi.fn(() => ({ ...receipt, generation: 2 })) })
    expect(enqueueRepairFeedback(port, record, outcome)).toEqual({ outcome: 'not-queued', reason: 'route-not-current' })
    expect(port.enqueueOwnerNotification).not.toHaveBeenCalled()
    const mismatched = { ...record, feedbackAuthority: { ...record.feedbackAuthority, routeReceipt: { ...receipt, bindingVersion: 2 } } }
    expect(enqueueRepairFeedback(delivery(), mismatched, outcome)).toEqual({ outcome: 'not-queued', reason: 'route-not-current' })
  })

  test('does not extend notification authority, and treats revocation or enqueue denial as no queue', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    try {
      const expired = { ...record, feedbackAuthority: { ...record.feedbackAuthority, expiresAt: Date.now() } }, port = delivery()
      expect(enqueueRepairFeedback(port, expired, outcome)).toEqual({ outcome: 'not-queued', reason: 'expired' })
      expect(port.validateOwnerRoute).not.toHaveBeenCalled()
      const current = { ...record, feedbackAuthority: { ...record.feedbackAuthority, expiresAt: Date.now() + 60_000 } }
      const revoked = delivery({ validateOwnerRoute: vi.fn(() => { throw new Error('revoked') }) })
      expect(enqueueRepairFeedback(revoked, current, outcome)).toEqual({ outcome: 'not-queued', reason: 'route-not-current' })
      const denied = delivery({ enqueueOwnerNotification: vi.fn(() => { throw new Error('send denied') }) })
      expect(enqueueRepairFeedback(denied, current, outcome)).toEqual({ outcome: 'not-queued', reason: 'delivery-rejected' })
    } finally { vi.useRealTimers() }
  })

  test('renders honest terminal results without asserting total objective completion or user reading', () => {
    for (const milestone of ['final-success', 'successor-failed', 'interrupted', 'budget-exhausted'] as const) {
      const text = renderRepairFeedback({ ...outcome, milestone })
      expect(text).toContain('Repair iteration 1 of 2.')
      expect(text).toContain('does not establish that the original objective is complete or that this notice was read')
    }
    expect(repairFeedbackIdempotencyKey(record, { iteration: 2, milestone: 'successor-failed' })).toBe('repair-feedback:repair-1:2:successor-failed')
  })
})
