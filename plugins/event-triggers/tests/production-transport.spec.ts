import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'

const httpsRequest = vi.hoisted(() => vi.fn())

vi.mock('node:https', () => ({ request: httpsRequest }))

import { EventTriggersService } from '../src/service.ts'
import type { Fetcher } from '../src/sensors.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  httpsRequest.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FakePolicy extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorize() { return { effect: 'allow', reasonCode: 'rule-allow' } }
}

class FakeAutomations extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  ingestExternal(input: Record<string, unknown>) { return input }
}

async function harness(fetcher?: Fetcher) {
  const root = await mkdtemp(join(tmpdir(), 'event-triggers-transport-'))
  roots.push(root)
  const ctx = new Context()
  new FakePolicy(ctx)
  new FakeAutomations(ctx)
  const lookup = vi.fn()
    .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  const service = new EventTriggersService(ctx, {
    databasePath: join(root, 'events.sqlite'),
    allowedHttpOrigins: ['https://api.example.com:8443'],
    pollerEnabled: false,
    triggers: [{
      id: 'remote', kind: 'http-json', automationId: 'remote-task',
      url: 'https://api.example.com:8443/state', pointer: '/ready', fireWhen: 'changed',
      debounceMs: 0, cooldownMs: 0, maxFires: 10,
    }],
  }, {
    lookup,
    ...(fetcher === undefined ? {} : { fetcher }),
  })
  return { ctx, lookup, service }
}

describe('production HTTP transport', () => {
  test('uses the DNS-pinned HTTPS request path when no test fetcher is injected', async () => {
    httpsRequest.mockImplementation((_url: URL, _options: Record<string, unknown>, callback: (response: Readable) => void) => {
      const request = new EventEmitter() as EventEmitter & { end(): void }
      request.end = () => {
        const response = Readable.from([Buffer.from('{"ready":true}')]) as Readable & {
          statusCode: number
          headers: Record<string, string>
        }
        response.statusCode = 200
        response.headers = { 'content-type': 'application/json' }
        callback(response)
      }
      return request
    })
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ready":true}', { status: 200 }),
    )
    const fixture = await harness()

    await fixture.service.pollOnce()

    expect(globalFetch).not.toHaveBeenCalled()
    expect(httpsRequest).toHaveBeenCalledOnce()
    expect(fixture.lookup).toHaveBeenCalledOnce()
    const [url, options] = httpsRequest.mock.calls[0] as [URL, {
      agent: boolean
      lookup: (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void
      servername: string
    }]
    expect(url.toString()).toBe('https://api.example.com:8443/state')
    expect(options.agent).toBe(false)
    expect(options.servername).toBe('api.example.com')
    const resolved = vi.fn()
    options.lookup('api.example.com', {}, resolved)
    expect(resolved).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    const rebound = vi.fn()
    options.lookup('api.example.com', {}, rebound)
    expect(rebound).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    expect(fixture.lookup).toHaveBeenCalledOnce()
    await fixture.ctx.fiber.restart()
  })

  test('handles an asynchronous empty 205 response without an uncaught callback exception', async () => {
    httpsRequest.mockImplementation((_url: URL, _options: Record<string, unknown>, callback: (response: Readable) => void) => {
      const request = new EventEmitter() as EventEmitter & { end(): void }
      request.end = () => {
        setImmediate(() => {
          const response = Readable.from([Buffer.from('must-not-be-a-205-body')]) as Readable & {
            statusCode: number
            headers: Record<string, string>
          }
          response.statusCode = 205
          response.headers = { 'content-type': 'application/json' }
          callback(response)
        })
      }
      return request
    })
    const fixture = await harness()

    await expect(fixture.service.pollOnce()).rejects.toThrow(/valid JSON/i)
    await fixture.ctx.fiber.restart()
  })

  test('bypasses a prewarmed global-agent route and connects through the pinned lookup', async () => {
    let reusedPrewarmedRoute = false
    let connectedAddress: string | undefined
    httpsRequest.mockImplementation((url: URL, options: {
      agent?: boolean
      lookup: (hostname: string, options: { all?: boolean }, callback: (
        error: Error | null, address: string, family: number,
      ) => void) => void
    }, callback: (response: Readable) => void) => {
      const request = new EventEmitter() as EventEmitter & { end(): void }
      request.end = () => {
        if (options.agent !== false) {
          reusedPrewarmedRoute = true
          connectedAddress = '127.0.0.1'
        } else {
          options.lookup(url.hostname, {}, (_error, address) => { connectedAddress = address })
        }
        const response = Readable.from([Buffer.from('{"ready":true}')]) as Readable & {
          statusCode: number
          headers: Record<string, string>
        }
        response.statusCode = 200
        response.headers = { 'content-type': 'application/json' }
        callback(response)
      }
      return request
    })
    const fixture = await harness()

    await fixture.service.pollOnce()

    expect(reusedPrewarmedRoute).toBe(false)
    expect(connectedAddress).toBe('93.184.216.34')
    await fixture.ctx.fiber.restart()
  })

  test('keeps an explicit test fetcher injectable without using Node HTTPS', async () => {
    const fetcher = vi.fn(async () => new Response('{"ready":true}', { status: 200 }))
    const fixture = await harness(fetcher)

    await fixture.service.pollOnce()

    expect(fetcher).toHaveBeenCalledOnce()
    expect(httpsRequest).not.toHaveBeenCalled()
    await fixture.ctx.fiber.restart()
  })
})
