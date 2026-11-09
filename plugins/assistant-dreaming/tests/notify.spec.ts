import { describe, expect, test, vi } from 'vitest'
import { buildDreamNotificationText, enqueueDreamNotification, DREAM_NOTIFICATION_SOURCE_ID } from '../src/notify.ts'

const owner = { ownerRouteId: 'route', principalId: 'principal', workspace: '/workspace', preset: 'primary' }
const baseInput = {
  owner, runId: 'dream-run-1', dayKey: '2026-11-09', now: 1_000, expiresAt: 2_000,
  summaries: [{ summary: 'cron idea', detail: 'detail' }, { summary: 'idle idea', detail: 'detail' }],
}

describe('dream notification text', () => {
  test('bounds summaries and marks silence as non-consent', () => {
    const text = buildDreamNotificationText({ ...baseInput, summaries: [
      { summary: 'a'.repeat(300), detail: 'd' }, ...baseInput.summaries,
    ] })
    expect(text).toContain('…')
    expect(text).toContain('沉默不算认可')
    expect(text).toContain('1.')
  })

  test('no summaries produces no notification', () => {
    const enqueue = vi.fn()
    const ports = {
      validateOwnerRoute: () => ({ principalRecordId: 'record', principalVersion: 1 }),
      resolveOwnerRoute: () => ({ binding: { sessionId: 'session-1' } }),
      enqueueOwnerNotification: enqueue,
    }
    expect(enqueueDreamNotification(ports, { ...baseInput, summaries: [] })).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('dream notification enqueue', () => {
  test('validates the live route and sends an idempotent owner notice', () => {
    const enqueue = vi.fn((_input: unknown) => ({ id: 'out-1' }))
    const validate = vi.fn(() => ({ principalRecordId: 'record', principalVersion: 3 }))
    const resolve = vi.fn(() => ({ binding: { sessionId: 'session-1' } }))
    const sent = enqueueDreamNotification(
      { validateOwnerRoute: validate, resolveOwnerRoute: resolve, enqueueOwnerNotification: enqueue }, baseInput)
    expect(sent).toBe(true)
    expect(validate).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith('route')
    const arg = enqueue.mock.calls[0]![0] as Record<string, any>
    expect(arg).toMatchObject({
      sourceId: DREAM_NOTIFICATION_SOURCE_ID,
      ownerRouteId: 'route',
      sessionId: 'session-1',
      attention: { purpose: 'result' },
      expiresAt: 2_000,
    })
    expect(arg.scope).toMatchObject({ principalId: 'principal', principalRecordId: 'record', principalVersion: 3 })
    expect(typeof arg.idempotencyKey).toBe('string')
    expect(arg.idempotencyKey).toHaveLength(64)
  })

  test('a route failure fails closed without a notification', () => {
    const enqueue = vi.fn()
    const ports = {
      validateOwnerRoute: () => { throw new Error('route revoked') },
      resolveOwnerRoute: () => ({ binding: { sessionId: 'session-1' } }),
      enqueueOwnerNotification: enqueue,
    }
    expect(enqueueDreamNotification(ports, baseInput)).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })
})
