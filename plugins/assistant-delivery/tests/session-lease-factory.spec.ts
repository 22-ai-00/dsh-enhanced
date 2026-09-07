import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DeliverySessionLeases, SessionLeaseUnavailable } from '../src/session-lease-runtime.ts'
import type { SessionLeasePort } from '../src/session-lease-runtime.ts'

function fixture(resume: (options: ResumeAgentOptions) => Promise<AgentHandle>, nativeFactory = false) {
  const cleanups: (() => Promise<void> | void)[] = []
  const hooks = new Map<string, (name: string) => void>()
  const token = { sessionId: 'session', holderId: 'owner', fencingToken: 1, leaseUntil: Date.now() + 30_000 }
  const port: SessionLeasePort = {
    leaseMs: 30_000, requiresLease: () => true,
    claim: () => ({ kind: 'claimed', lease: token }), dispatch: () => true,
    valid: () => true, renew: () => true, finish: vi.fn(() => true),
  }
  const registry = { resume }
  const root = {
    agents: registry,
    on(event: string, callback: (name: string) => void) { hooks.set(event, callback); return () => {} },
    get(name: string) { return name === 'agentLoop' && nativeFactory ? {} : undefined },
    inject() {},
    effect() { return () => {} },
  } as unknown as Context
  const owner = {
    // An isolated Controller facade must not recurse through its own resume.
    agents: { resume: vi.fn(() => { throw new Error('recursive facade call') }) },
    reflect: { trace: (value: unknown) => value },
    fiber: { state: 2 },
    effect(callback: () => () => Promise<void> | void) {
      const cleanup = callback()
      let active = true
      const dispose = () => { if (!active) return; active = false; return cleanup() }
      cleanups.push(dispose)
      return dispose
    },
  } as unknown as Context
  const leases = new DeliverySessionLeases(root, port)
  const lease = leases.open({} as never, new AbortController().signal)
  lease.dispatch()
  return { owner, leases, lease, port, cleanups, hooks }
}

describe('Shared Session factory lifecycle', () => {
  test.each([false, true])('distinguishes a settled native load error from provider replacement=%s', async replaced => {
    const loaded = Promise.withResolvers<AgentHandle>()
    const f = fixture(() => loaded.promise, true)
    const pending = f.leases.resume(f.owner, { resumeSessionId: SessionId('session') })
    const rejected = expect(pending).rejects.toThrow('ordinary load failure')
    try {
      if (replaced) f.hooks.get('internal/service')!('agentLoop')
      loaded.reject(new Error('ordinary load failure'))
      await rejected
      f.lease.close()
      expect(f.port.finish).toHaveBeenLastCalledWith(f.lease.token, { quiescent: !replaced })
      if (replaced) expect(f.port.finish).not.toHaveBeenCalledWith(f.lease.token, { quiescent: true })
    } finally { f.lease.close() }
  })

  test('keeps a failed cold load unknown when no Agent proves cleanup and fuses cancellation', async () => {
    const loaded = Promise.withResolvers<AgentHandle>()
    let factorySignal: AbortSignal | undefined
    const f = fixture(async options => { factorySignal = options.signal; return loaded.promise })
    const pending = f.leases.resume(f.owner, { resumeSessionId: SessionId('session') })
    const rejected = expect(pending).rejects.toThrow('cold load cancelled')
    try {
      f.lease.cancel()
      f.lease.close()
      expect(factorySignal?.aborted).toBe(true)
      expect(f.port.finish).toHaveBeenLastCalledWith(f.lease.token, { quiescent: false })
      expect(f.port.finish).not.toHaveBeenCalledWith(f.lease.token, { quiescent: true })
      loaded.reject(new Error('cold load cancelled'))
      await rejected
      expect(f.port.finish).toHaveBeenLastCalledWith(f.lease.token, { quiescent: false })
      expect(f.port.finish).not.toHaveBeenCalledWith(f.lease.token, { quiescent: true })
    } finally { loaded.reject(new Error('cleanup')); f.lease.close() }
  })

  test('remembers owner teardown even when its fiber is active again before rejection', async () => {
    const loaded = Promise.withResolvers<AgentHandle>()
    const f = fixture(() => loaded.promise, true)
    const pending = f.leases.resume(f.owner, { resumeSessionId: SessionId('session') })
    const rejected = expect(pending).rejects.toThrow('old owner aborted')
    try {
      await f.cleanups[0]!()
      // The restarted fiber has the same object and ACTIVE state. Its old
      // construction cancellation remains captured by the combined signal.
      expect(f.owner.fiber.state).toBe(2)
      loaded.reject(new Error('old owner aborted'))
      await rejected
      f.lease.close()
      expect(f.port.finish).not.toHaveBeenCalledWith(f.lease.token, { quiescent: true })
    } finally { f.lease.close() }
  })

  test('closes an abandoned Controller handle on scope unload and waits for native drain', async () => {
    const drained = Promise.withResolvers<void>()
    const agent = { session: { id: SessionId('session') }, cancel: vi.fn() } as unknown as Agent
    const dispose = vi.fn(() => drained.promise)
    const f = fixture(async options => {
      const setup = await options.setup?.({ agent } as Context)
      setup?.commit()
      return { agent, dispose }
    })
    const handle = await f.leases.resume(f.owner, { resumeSessionId: SessionId('session') })
    try {
      expect(f.owner.agents.resume).not.toHaveBeenCalled()
      const unloading = Promise.all(f.cleanups.map(dispose => dispose()))
      expect(f.lease.signal.aborted).toBe(true)
      expect(agent.cancel).toHaveBeenCalled()
      expect(f.port.finish).toHaveBeenLastCalledWith(f.lease.token, { quiescent: false })
      const alsoDisposing = handle.dispose()
      await Promise.resolve()
      expect(dispose).toHaveBeenCalledOnce()
      drained.resolve()
      await Promise.all([unloading, alsoDisposing, handle.dispose()])
      expect(dispose).toHaveBeenCalledOnce()
      expect(f.port.finish).toHaveBeenLastCalledWith(f.lease.token, { quiescent: true })
      expect(() => f.lease.assertAgent(agent)).toThrow(SessionLeaseUnavailable)
    } finally { drained.resolve(); await handle.dispose(); f.lease.close() }
  })

  test('rechecks the lease after a native setup commit changes authorization', async () => {
    const agent = { session: { id: SessionId('session') }, cancel: vi.fn() } as unknown as Agent
    const published = vi.fn()
    const f = fixture(async options => {
      const setup = await options.setup?.({ agent } as Context)
      setup?.commit()
      published()
      return { agent, dispose: async () => {} }
    })
    let authorized = true
    f.port.valid = () => authorized
    const commit = vi.fn(() => { authorized = false })
    try {
      await expect(f.leases.resume(f.owner, {
        resumeSessionId: SessionId('session'), setup: async () => ({ commit }),
      })).rejects.toThrow(SessionLeaseUnavailable)
      expect(commit).toHaveBeenCalledOnce()
      expect(published).not.toHaveBeenCalled()
      expect(f.lease.signal.aborted).toBe(true)
      f.lease.close()
      expect(f.port.finish).toHaveBeenLastCalledWith(f.lease.token, { quiescent: true })
    } finally { f.lease.close() }
  })
})
