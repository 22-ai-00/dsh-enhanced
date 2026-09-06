import { describe, expect, test, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionExecutionLease, SessionLeaseUnavailable } from '../src/session-lease-runtime.ts'
import type { SessionLeasePort } from '../src/session-lease-runtime.ts'

function fixture() {
  const token = { sessionId: 'session', holderId: 'owner', fencingToken: 1, leaseUntil: Date.now() + 30_000 }
  const port: SessionLeasePort = { leaseMs: 30_000, claim: () => ({ kind: 'claimed', lease: token }),
    dispatch: () => true, valid: () => true, renew: () => true, finish: vi.fn(() => true) }
  const released = vi.fn()
  const lease = new SessionExecutionLease(token, port, new AbortController().signal, released)
  const agent = { cancel: vi.fn() } as unknown as Agent
  lease.attach(agent)
  return { lease, port, agent, released }
}

describe('Session execution lifecycle fence', () => {
  test('rejects a disposed Agent while its owner is still settling acceptance', () => {
    const f = fixture()
    try {
      f.lease.dispatch()
      expect(() => f.lease.assertAgent(f.agent)).not.toThrow()
      f.lease.disposed(f.agent)
      // The enclosing owner has not called close; a valid token alone is insufficient.
      expect(() => f.lease.assert()).not.toThrow()
      expect(() => f.lease.assertAgent(f.agent)).toThrow(SessionLeaseUnavailable)
      expect(f.released).not.toHaveBeenCalled()
    } finally { f.lease.close() }
    expect(f.released).toHaveBeenCalledOnce()
  })

  test('keeps unknown occupied until both teardown and an admitted operation finish', () => {
    const f = fixture()
    const done = f.lease.enter()
    try {
      f.lease.dispatch(); f.lease.close(); f.lease.disposed(f.agent)
      expect(f.port.finish).toHaveBeenLastCalledWith(f.lease.token, { quiescent: false })
      expect(f.released).not.toHaveBeenCalled()
      done()
      expect(f.port.finish).toHaveBeenLastCalledWith(f.lease.token, { quiescent: true })
      expect(f.released).toHaveBeenCalledOnce()
      done()
      expect(f.released).toHaveBeenCalledOnce()
      expect(() => f.lease.assertAgent(f.agent)).toThrow(SessionLeaseUnavailable)
    } finally { done(); f.lease.close() }
  })
})
