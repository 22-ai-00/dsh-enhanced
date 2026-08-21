import { describe, expect, test, vi } from 'vitest'
import { readHttpJsonObservation } from '../src/sensors.ts'

describe('HTTP JSON sensor fences', () => {
  test('resolves an exact allowlisted public host and extracts a bounded JSON pointer', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { ready: true } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const result = await readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '/data/ready', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), fetcher, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    expect(result).toMatchObject({ truthy: true })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.com/state',
      expect.objectContaining({ redirect: 'manual' }),
      { addresses: [{ address: '93.184.216.34', family: 4 }] },
    )
  })

  test.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fd00::1'])(
    'blocks private/reserved resolution %s', async address => {
      await expect(readHttpJsonObservation({
        url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
        allowedHosts: new Set(['api.example.com']), fetcher: vi.fn(),
        lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      })).rejects.toThrow(/unsafe|address/i)
    },
  )

  test('rejects a resolver result whose family does not match its address', async () => {
    await expect(readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), fetcher: vi.fn(),
      lookup: async () => [{ address: '93.184.216.34', family: 6 }],
    })).rejects.toThrow(/family|address/i)
  })

  test('rejects redirects, oversized bodies, wrong hosts and non-HTTPS URLs', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    await expect(readHttpJsonObservation({ url: 'https://other.example/state', pointer: '', maxBodyBytes: 10,
      timeoutMs: 1_000, allowedHosts: new Set(['api.example.com']), fetcher: vi.fn(), lookup })).rejects.toThrow(/host/i)
    await expect(readHttpJsonObservation({ url: 'http://api.example.com/state', pointer: '', maxBodyBytes: 10,
      timeoutMs: 1_000, allowedHosts: new Set(['api.example.com']), fetcher: vi.fn(), lookup })).rejects.toThrow(/https/i)
    await expect(readHttpJsonObservation({ url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 10,
      timeoutMs: 1_000, allowedHosts: new Set(['api.example.com']),
      fetcher: async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }), lookup }))
      .rejects.toThrow(/redirect/i)
    await expect(readHttpJsonObservation({ url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 4,
      timeoutMs: 1_000, allowedHosts: new Set(['api.example.com']),
      fetcher: async () => new Response('0123456789'), lookup })).rejects.toThrow(/body/i)
  })
})
