import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeliverySessionLeases, SessionExecutionLease, SessionLeaseUnavailable } from '../src/session-lease-runtime.ts'
import type { SessionLeasePort } from '../src/session-lease-runtime.ts'

function leasePort(requiresLease: (sessionId: string) => boolean = () => false): SessionLeasePort {
  const token = { sessionId: 'session', holderId: 'owner', fencingToken: 1, leaseUntil: Date.now() + 30_000 }
  return { leaseMs: 30_000, requiresLease, claim: () => ({ kind: 'claimed', lease: token }),
    dispatch: () => true, valid: () => true, renew: () => true, finish: vi.fn(() => true) }
}

function fixture() {
  const token = { sessionId: 'session', holderId: 'owner', fencingToken: 1, leaseUntil: Date.now() + 30_000 }
  const port = leasePort()
  const released = vi.fn()
  const lease = new SessionExecutionLease(token, port, new AbortController().signal, released)
  const agent = { cancel: vi.fn() } as unknown as Agent
  lease.attach(agent)
  return { lease, port, agent, released }
}

function agent(sessionId: string): Agent {
  return { session: { id: sessionId }, cancel: vi.fn() } as unknown as Agent
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {}
}

function runtimeFixture(requiresLease: (sessionId: string) => boolean) {
  const hooks = new Map<string, unknown>()
  let guard: ((input: { agent?: Agent }) => string | undefined) | undefined
  let initiator: Agent | undefined
  const ctx = {
    on(event: string, callback: unknown) { hooks.set(event, callback); return () => {} },
    inject(_services: string[], callback: (runtime: { tools: { guard: (value: (input: { agent?: Agent }) => string | undefined) => void } }) => void) {
      callback({ tools: { guard: value => { guard = value } } })
    },
    effect(_callback: () => () => void, _name: string) {},
    get(name: string) { return name === 'agents' ? { currentInitiator: () => initiator } : undefined },
  } as unknown as Context
  const leases = new DeliverySessionLeases(ctx, leasePort(requiresLease))
  return {
    leases,
    hooks,
    guard: () => guard!,
    setInitiator: (value: Agent | undefined) => { initiator = value },
  }
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

describe('Delivery-owned Session execution guard', () => {
  test.each(['agent/inbox/inserted', 'agent/inbox/claimed'])(
    'invalidates the exact live lease when native user input reaches %s', event => {
      const runtime = runtimeFixture(() => true)
      const owner = agent('session')
      const lease = runtime.leases.open({} as never, new AbortController().signal)
      runtime.leases.attach(owner)
      const input = runtime.hooks.get(event) as (input: { agent: Agent; message: ReturnType<typeof createUserMessage> }) => void
      try {
        expect(runtime.guard()({ agent: owner })).toBeUndefined()
        input({ agent: owner, message: createUserMessage({ content: [{ type: 'text', text: 'native prompt' }], source: { kind: 'user' } }) })
        expect(lease.signal.aborted).toBe(true)
        expect(owner.cancel).toHaveBeenCalled()
        expect(runtime.guard()({ agent: owner })).toContain('session lease')
      } finally { runtime.leases.disposed(owner); lease.close() }
    },
  )

  test('rejects an unleased Delivery-owned Agent at every execution boundary and cancels it', async () => {
    const runtime = runtimeFixture(() => true)
    const unleased = agent('delivery-owned')
    const next = vi.fn(async () => 'ran')
    const request = runtime.hooks.get('agent/request') as (input: { agent: Agent }, next: () => Promise<string>) => Promise<string>
    const preExecute = runtime.hooks.get('tools/pre-execute') as (input: { agent: Agent }, next: () => Promise<string>) => Promise<string>
    const execute = runtime.hooks.get('tools/execute') as (input: { agent: Agent }, next: () => Promise<string>) => Promise<string>
    const stream = runtime.hooks.get('llm/stream') as (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>

    await expect(request({ agent: unleased }, next)).rejects.toThrow(SessionLeaseUnavailable)
    await expect(preExecute({ agent: unleased }, next)).rejects.toThrow(SessionLeaseUnavailable)
    await expect(execute({ agent: unleased }, next)).rejects.toThrow(SessionLeaseUnavailable)
    runtime.setInitiator(unleased)
    await expect(consume(stream({} as GenerateOptions, async function* () {}))).rejects.toThrow(SessionLeaseUnavailable)
    expect(runtime.guard()({ agent: unleased })).toContain('session lease')
    expect(next).not.toHaveBeenCalled()
    expect(unleased.cancel).toHaveBeenCalled()
  })

  test('allows unmanaged Sessions and rechecks ownership after awaits', async () => {
    let managed = false
    const runtime = runtimeFixture(() => managed)
    const native = agent('native-session')
    const request = runtime.hooks.get('agent/request') as (input: { agent: Agent }, next: () => Promise<string>) => Promise<string>
    const execute = runtime.hooks.get('tools/execute') as (input: { agent?: Agent }, next: () => Promise<string>) => Promise<string>

    await expect(request({ agent: native }, async () => 'allowed')).resolves.toBe('allowed')
    await expect(execute({}, async () => 'host execution')).resolves.toBe('host execution')
    expect(runtime.guard()({})).toBeUndefined()
    await expect(request({ agent: native }, async () => {
      managed = true
      return 'ownership changed while awaiting'
    })).rejects.toThrow(SessionLeaseUnavailable)
    expect(native.cancel).toHaveBeenCalledOnce()
  })

  test('fails closed when ownership lookup fails and does not accept a borrowed Agent object', () => {
    const lookupFailure = runtimeFixture(() => { throw new Error('sqlite unavailable') })
    const native = agent('unknown')
    expect(lookupFailure.guard()({ agent: native })).toContain('session lease')
    expect(native.cancel).toHaveBeenCalledOnce()

    const borrowed = runtimeFixture(() => true)
    const owner = agent('session')
    const lease = borrowed.leases.open({} as never, new AbortController().signal)
    borrowed.leases.attach(owner)
    expect(borrowed.guard()({ agent: owner })).toBeUndefined()
    // A separately constructed Agent with the same Session id is not the attached owner.
    expect(borrowed.guard()({ agent: agent('session') })).toContain('session lease')
    borrowed.leases.disposed(owner)
    lease.close()
  })

  test('stops a stream when Session ownership changes between chunks', async () => {
    let managed = false
    const runtime = runtimeFixture(() => managed)
    runtime.setInitiator(agent('native-session'))
    const stream = runtime.hooks.get('llm/stream') as (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
    async function* chunks(): AsyncIterable<StreamChunk> {
      yield {} as StreamChunk
      managed = true
      yield {} as StreamChunk
    }
    await expect(consume(stream({} as GenerateOptions, chunks))).rejects.toThrow(SessionLeaseUnavailable)
  })
})
