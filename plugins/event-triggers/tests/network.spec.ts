import { afterEach, describe, expect, test, vi } from 'vitest'
import { readHttpJsonObservation } from '../src/sensors.ts'

afterEach(() => {
  vi.useRealTimers()
})

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

  test('resolves once, rejects mixed answers, and requires an explicit native-only IPv6 mode', async () => {
    const mixedLookup = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    const fetcher = vi.fn(async () => new Response('{}'))
    await expect(readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), fetcher, lookup: mixedLookup,
    })).rejects.toThrow(/unsafe|address/i)
    expect(mixedLookup).toHaveBeenCalledOnce()
    expect(fetcher).not.toHaveBeenCalled()

    await expect(readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), fetcher,
      lookup: async () => [{ address: '2001:4860:4860::8888', family: 6 }],
    })).rejects.toThrow(/IPv6|unsafe|address/i)

    await expect(readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), allowIpv6: true, fetcher,
      lookup: async () => [{ address: '2001:4860:4860::8888', family: 6 }],
    })).resolves.toMatchObject({ truthy: true })

    await expect(readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), fetcher,
      lookup: async () => [{ address: '2001:4860:64:ff9b::7f00:1', family: 6 }],
    })).rejects.toThrow(/IPv6|unsafe|address/i)
  })

  test.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:7f00:1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::1',
  ])(
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

  test('requires an exact HTTPS origin and treats a legacy host allowlist as port 443 only', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const fetcher = vi.fn(async () => new Response('{}'))

    await expect(readHttpJsonObservation({
      url: 'https://api.example.com:8443/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), fetcher, lookup,
    })).rejects.toThrow(/origin|allowlist/i)

    await expect(readHttpJsonObservation({
      url: 'https://api.example.com:8443/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(), allowedOrigins: new Set(['https://api.example.com:8443']), fetcher, lookup,
    })).resolves.toMatchObject({ truthy: true })
  })

  test('validates an explicitly enabled IPv6 literal without DNS', async () => {
    const lookup = vi.fn(async () => [{ address: '2001:4860:4860::8888', family: 6 }])
    await expect(readHttpJsonObservation({
      url: 'https://[2001:4860:4860::8888]/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedOrigins: new Set(['https://[2001:4860:4860::8888]']), allowIpv6: true,
      fetcher: async () => new Response('{}'), lookup,
    })).resolves.toMatchObject({ truthy: true })
    expect(lookup).not.toHaveBeenCalled()
  })

  test('rejects a private URL literal even when an injected resolver lies', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const fetcher = vi.fn(async () => new Response('{}'))
    await expect(readHttpJsonObservation({
      url: 'https://127.0.0.1/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedOrigins: new Set(['https://127.0.0.1']), fetcher, lookup,
    })).rejects.toThrow(/unsafe|address/i)
    expect(lookup).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('caps DNS answers and deduplicates equivalent routes before fetching', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    await expect(readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), fetcher,
      lookup: async () => Array.from({ length: 17 }, (_, index) => ({ address: `93.184.216.${index + 1}`, family: 4 })),
    })).rejects.toThrow(/DNS|answer|address/i)
    expect(fetcher).not.toHaveBeenCalled()

    await readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']), fetcher,
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ],
    })
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://api.example.com/state',
      expect.any(Object),
      { addresses: [{ address: '93.184.216.34', family: 4 }] },
    )
  })

  test('applies one deadline to DNS lookup and an uncooperative response body', async () => {
    vi.useFakeTimers()
    const dnsResult = readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 100,
      allowedHosts: new Set(['api.example.com']), fetcher: vi.fn(), lookup: async () => new Promise(() => {}),
    }).then(() => 'resolved', error => String(error))
    await vi.advanceTimersByTimeAsync(100)
    await expect(Promise.race([dnsResult, Promise.resolve('still pending')])).resolves.toMatch(/timeout/i)

    const bodyResult = readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 1_024, timeoutMs: 100,
      allowedHosts: new Set(['api.example.com']),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetcher: async () => new Response(new ReadableStream({ start() {} })),
    }).then(() => 'resolved', error => String(error))
    await vi.advanceTimersByTimeAsync(100)
    await expect(Promise.race([bodyResult, Promise.resolve('still pending')])).resolves.toMatch(/timeout/i)
  })

  test('does not wait forever for an uncooperative oversized-body cancellation', async () => {
    vi.useFakeTimers()
    const result = readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 4, timeoutMs: 100,
      allowedHosts: new Set(['api.example.com']),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetcher: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('oversized')) },
        cancel: async () => new Promise<void>(() => {}),
      })),
    }).then(() => 'resolved', error => String(error))
    await vi.advanceTimersByTimeAsync(100)
    await expect(Promise.race([result, Promise.resolve('still pending')])).resolves.toMatch(/body|limit|timeout/i)
  })

  test.each([
    { status: 302, headers: {} },
    { status: 200, headers: { 'content-length': '1000' } },
  ])('cancels a rejected response body for status $status', async ({ status, headers }) => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    await expect(readHttpJsonObservation({
      url: 'https://api.example.com/state', pointer: '', maxBodyBytes: 10, timeoutMs: 1_000,
      allowedHosts: new Set(['api.example.com']),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetcher: async () => new Response(body, { status, headers }),
    })).rejects.toThrow(/redirect|body/i)
    expect(cancel).toHaveBeenCalledOnce()
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
