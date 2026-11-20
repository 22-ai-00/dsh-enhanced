import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { request as nodeHttpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  assertReadOnlyWebToolSurface,
  extractPlainTextFromHtml,
  fetchWebPageReadOnly,
  isGlobalPublicIp,
  READ_ONLY_WEB_HEADERS,
  resolveAndValidatePublicAddresses,
  sanitizeWebLearningEnv,
  validateWhitelistedWebUrl,
  WebFetchError,
  type WebFetcher,
  type WebLookup,
} from '../src/web-fetch.js'
import {
  createInProcessWebLearningRunner,
  createSubprocessWebLearningRunner,
} from '../src/web-learning-runner.js'
import { executeWebLearningPlan } from '../src/web-learning-worker.js'

const tempDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const PUBLIC_IPV4_LOOKUP: WebLookup = async () => [{ address: '93.184.216.34', family: 4 }]

describe('S4 web-fetch & sandbox isolation', () => {
  // T-S4-02: Empty whitelist = fail-closed
  test('T-S4-02: empty domain whitelist fails closed with zero lookups or fetches', async () => {
    expect(() => validateWhitelistedWebUrl('https://example.com/docs', { allowedDomains: [] }))
      .toThrowError(WebFetchError)
    try {
      validateWhitelistedWebUrl('https://example.com/docs', { allowedDomains: [] })
    } catch (error) {
      expect(error).toBeInstanceOf(WebFetchError)
      expect((error as WebFetchError).code).toBe('rejected-empty-whitelist')
    }

    expect(() => validateWhitelistedWebUrl('https://example.com/docs', { allowedDomains: ['', '  ', '*.evil.com'] }))
      .toThrowError(/empty/i)

    const lookup = vi.fn(PUBLIC_IPV4_LOOKUP)
    const fetcher = vi.fn(async () => new Response('ok'))
    await expect(fetchWebPageReadOnly({
      url: 'https://example.com/docs',
      allowedDomains: [],
      maxBytes: 1_024,
      requestTimeoutMs: 1_000,
    }, { lookup, fetcher })).rejects.toMatchObject({ code: 'rejected-empty-whitelist' })

    expect(lookup).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()

    const planResult = await executeWebLearningPlan({
      runId: 'run-empty-wl',
      allowedDomains: [],
      targets: [{ url: 'https://example.com/docs', interestKey: 'nodejs' }],
      budget: {
        maxRequests: 5,
        maxPages: 3,
        maxBytesPerRequest: 4_096,
        maxTotalBytes: 8_192,
        maxDurationMs: 5_000,
        requestTimeoutMs: 1_000,
      },
    }, { lookup, fetcher })

    expect(planResult.status).toBe('rejected')
    expect(planResult.reason).toBe('rejected-empty-whitelist')
    expect(planResult.requestsUsed).toBe(0)
    expect(planResult.pagesFetched).toBe(0)
    expect(planResult.pages).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  // T-S4-03: Whitelist exact vs subdomain matching, scheme, port, credentials, forbidden hosts
  test('T-S4-03: enforces https-only, no credentials, port 443, no IP literals, and exact/subdomain whitelist', () => {
    const allowed = ['example.com']

    const exact = validateWhitelistedWebUrl('https://Example.COM:443/docs/api#section', { allowedDomains: allowed })
    expect(exact.hostname).toBe('example.com')
    expect(exact.canonicalUrl).toBe('https://example.com/docs/api')

    expect(() => validateWhitelistedWebUrl('https://docs.example.com/guide', { allowedDomains: allowed, allowSubdomains: false }))
      .toThrowError(expect.objectContaining({ code: 'rejected-whitelist' }))

    const sub = validateWhitelistedWebUrl('https://docs.example.com/guide', { allowedDomains: allowed, allowSubdomains: true })
    expect(sub.hostname).toBe('docs.example.com')
    expect(sub.matchedDomain).toBe('example.com')

    expect(() => validateWhitelistedWebUrl('https://notexample.com/', { allowedDomains: allowed, allowSubdomains: true }))
      .toThrowError(expect.objectContaining({ code: 'rejected-whitelist' }))
    expect(() => validateWhitelistedWebUrl('https://evil.com/', { allowedDomains: allowed }))
      .toThrowError(expect.objectContaining({ code: 'rejected-whitelist' }))

    for (const badScheme of [
      'http://example.com/',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'data:text/html,<h1>hi</h1>',
      'javascript:alert(1)',
    ]) {
      expect(() => validateWhitelistedWebUrl(badScheme, { allowedDomains: allowed }))
        .toThrowError(expect.objectContaining({ code: 'rejected-scheme' }))
    }

    for (const badCreds of [
      'https://user:pass@example.com/',
      'https://token@example.com/',
    ]) {
      expect(() => validateWhitelistedWebUrl(badCreds, { allowedDomains: allowed }))
        .toThrowError(expect.objectContaining({ code: 'rejected-credentials' }))
    }

    for (const badPort of [
      'https://example.com:8443/',
      'https://example.com:80/',
    ]) {
      expect(() => validateWhitelistedWebUrl(badPort, { allowedDomains: allowed }))
        .toThrowError(expect.objectContaining({ code: 'rejected-port' }))
    }

    for (const ipUrl of [
      'https://127.0.0.1/',
      'https://93.184.216.34/',
      'https://[::1]/',
      'https://[2606:4700:4700::1111]/',
    ]) {
      expect(() => validateWhitelistedWebUrl(ipUrl, { allowedDomains: allowed }))
        .toThrowError(expect.objectContaining({ code: 'rejected-ip-literal' }))
    }

    for (const forbiddenHost of [
      'https://localhost/',
      'https://api.localhost/',
      'https://printer.local/',
      'https://metadata.internal/',
      'https://1.0.0.127.in-addr.arpa/',
      'https://example.com./',
    ]) {
      expect(() => validateWhitelistedWebUrl(forbiddenHost, { allowedDomains: [...allowed, 'localhost', 'example.com.'] }))
        .toThrowError(expect.objectContaining({ code: 'rejected-forbidden-host' }))
    }
  })

  // T-S4-04: SSRF & DNS rebinding defense + pinned HTTPS lookup
  test.each([
    ['127.0.0.1', 4],
    ['0.0.0.0', 4],
    ['10.0.0.1', 4],
    ['172.16.0.1', 4],
    ['192.168.1.1', 4],
    ['169.254.169.254', 4],
    ['100.64.0.1', 4],
    ['224.0.0.1', 4],
    ['198.18.0.1', 4],
    ['192.0.2.1', 4],
    ['198.51.100.1', 4],
    ['203.0.113.1', 4],
    ['::1', 6],
    ['fe80::1', 6],
    ['fc00::1', 6],
    ['fd12::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['::ffff:169.254.169.254', 6],
    ['2001:db8::1', 6],
    ['2002:7f00:1::1', 6],
  ])('T-S4-04: blocks unsafe/private DNS address %s', async (address, family) => {
    expect(isGlobalPublicIp(address, true)).toBe(false)
    await expect(resolveAndValidatePublicAddresses('docs.example.com', {
      allowIpv6: true,
      lookup: async () => [{ address, family }],
    })).rejects.toMatchObject({ code: 'rejected-ssrf' })
  })

  test('T-S4-04: enforces allowIpv6, rejects mixed/overflow DNS answers, and pins resolved IP in https.request', async () => {
    const fetcher = vi.fn(async () => new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))

    // Mixed public + loopback DNS answer must be rejected
    await expect(fetchWebPageReadOnly({
      url: 'https://docs.example.com/guide',
      allowedDomains: ['docs.example.com'],
      maxBytes: 1_024,
      requestTimeoutMs: 1_000,
    }, {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      fetcher,
    })).rejects.toMatchObject({ code: 'rejected-ssrf' })
    expect(fetcher).not.toHaveBeenCalled()

    // IPv6 public address rejected unless allowIpv6: true
    await expect(resolveAndValidatePublicAddresses('docs.example.com', {
      lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
    })).rejects.toMatchObject({ code: 'rejected-ssrf' })

    const allowedV6 = await resolveAndValidatePublicAddresses('docs.example.com', {
      allowIpv6: true,
      lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
    })
    expect(allowedV6).toEqual([{ address: '2606:4700:4700::1111', family: 6 }])

    // > 16 DNS answers or empty answers rejected
    await expect(resolveAndValidatePublicAddresses('docs.example.com', {
      lookup: async () => [],
    })).rejects.toMatchObject({ code: 'rejected-dns' })

    await expect(resolveAndValidatePublicAddresses('docs.example.com', {
      lookup: async () => Array.from({ length: 17 }, (_, i) => ({ address: `93.184.216.${i + 1}`, family: 4 })),
    })).rejects.toMatchObject({ code: 'rejected-dns' })

    // Family mismatch rejected
    await expect(resolveAndValidatePublicAddresses('docs.example.com', {
      lookup: async () => [{ address: '93.184.216.34', family: 6 }],
    })).rejects.toMatchObject({ code: 'rejected-ssrf' })

    // Reject credential headers and non-GET methods
    for (const headerName of ['Authorization', 'Cookie', 'Proxy-Authorization', 'X-API-Key']) {
      await expect(fetchWebPageReadOnly({
        url: 'https://docs.example.com/guide',
        allowedDomains: ['docs.example.com'],
        maxBytes: 1_024,
        requestTimeoutMs: 1_000,
        extraHeaders: { [headerName]: 'secret-value' },
      }, { lookup: PUBLIC_IPV4_LOOKUP, fetcher })).rejects.toMatchObject({ code: 'rejected-header' })
    }

    await expect(fetchWebPageReadOnly({
      url: 'https://docs.example.com/guide',
      allowedDomains: ['docs.example.com'],
      maxBytes: 1_024,
      requestTimeoutMs: 1_000,
      method: 'POST',
    }, { lookup: PUBLIC_IPV4_LOOKUP, fetcher })).rejects.toMatchObject({ code: 'rejected-method' })

    // Verify pinnedHttpsFetch passes agent:false, pinned lookup, servername, rejectUnauthorized, GET, stripped headers, ignores Set-Cookie
    let capturedOptions: Record<string, unknown> | undefined
    const fakeHttpsRequest = ((
      _url: URL,
      options: Record<string, unknown>,
      callback: (res: Readable & { statusCode?: number; headers: Record<string, string | string[]> }) => void,
    ) => {
      capturedOptions = options
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () => {
        const res = Readable.from([Buffer.from('Hello pinned HTTPS')]) as Readable & {
          statusCode?: number
          headers: Record<string, string | string[]>
        }
        res.statusCode = 200
        res.headers = {
          'content-type': 'text/plain; charset=utf-8',
          'set-cookie': 'session=secret; HttpOnly',
        }
        callback(res)
      }
      return req
    }) as unknown as typeof nodeHttpsRequest

    const lookupSpy = vi.fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    const res = await fetchWebPageReadOnly({
      url: 'https://docs.example.com/guide',
      allowedDomains: ['docs.example.com'],
      maxBytes: 1_024,
      requestTimeoutMs: 1_000,
    }, { lookup: lookupSpy, httpsRequest: fakeHttpsRequest })

    expect(res.bodyText).toBe('Hello pinned HTTPS')
    expect(lookupSpy).toHaveBeenCalledOnce()
    expect(capturedOptions).toBeDefined()
    expect(capturedOptions?.agent).toBe(false)
    expect(capturedOptions?.method).toBe('GET')
    expect(capturedOptions?.servername).toBe('docs.example.com')
    expect(capturedOptions?.rejectUnauthorized).toBe(true)
    expect(capturedOptions?.headers).toEqual(READ_ONLY_WEB_HEADERS)

    const pinnedLookup = capturedOptions?.lookup as (
      host: string,
      opts: { all?: boolean },
      cb: (err: Error | null, addr: unknown, fam?: number) => void,
    ) => void
    const cbSingle = vi.fn()
    pinnedLookup('docs.example.com', {}, cbSingle)
    expect(cbSingle).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    const cbAll = vi.fn()
    pinnedLookup('docs.example.com', { all: true }, cbAll)
    expect(cbAll).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }])
    expect(lookupSpy).toHaveBeenCalledOnce()
  })

  // T-S4-05: Redirect validation
  test('T-S4-05: re-validates redirects and blocks off-whitelist, http, credential, and SSRF redirects', async () => {
    // Valid redirect within whitelist
    const validFetcher: WebFetcher = vi.fn(async (url) => {
      if (url === 'https://example.com/old') {
        return new Response('', {
          status: 302,
          headers: { location: '/new-docs' },
        })
      }
      return new Response('Redirected content', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    })
    const ok = await fetchWebPageReadOnly({
      url: 'https://example.com/old',
      allowedDomains: ['example.com'],
      maxBytes: 1_024,
      requestTimeoutMs: 1_000,
      maxRedirects: 2,
    }, { lookup: PUBLIC_IPV4_LOOKUP, fetcher: validFetcher })
    expect(ok.finalUrl).toBe('https://example.com/new-docs')
    expect(ok.requestsUsed).toBe(2)
    expect(ok.redirectChain).toEqual(['https://example.com/old'])

    // Rejects off-whitelist / http / credentials redirects and cancels 3xx body
    for (const location of [
      'https://evil.com/steal',
      'http://example.com/downgrade',
      'https://user:pass@example.com/auth',
    ]) {
      const cancel = vi.fn()
      const body = new ReadableStream({ cancel })
      await expect(fetchWebPageReadOnly({
        url: 'https://example.com/start',
        allowedDomains: ['example.com'],
        maxBytes: 1_024,
        requestTimeoutMs: 1_000,
      }, {
        lookup: PUBLIC_IPV4_LOOKUP,
        fetcher: async () => new Response(body, { status: 302, headers: { location } }),
      })).rejects.toMatchObject({ code: 'rejected-redirect' })
      expect(cancel).toHaveBeenCalledOnce()
    }

    // Rejects redirect to IP literal / metadata SSRF
    await expect(fetchWebPageReadOnly({
      url: 'https://example.com/start',
      allowedDomains: ['example.com'],
      maxBytes: 1_024,
      requestTimeoutMs: 1_000,
    }, {
      lookup: PUBLIC_IPV4_LOOKUP,
      fetcher: async () => new Response('', {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' },
      }),
    })).rejects.toMatchObject({ code: 'rejected-ssrf' })

    // Rejects redirect whose hostname DNS resolves to 127.0.0.1
    await expect(fetchWebPageReadOnly({
      url: 'https://example.com/start',
      allowedDomains: ['example.com', 'rebind.example.com'],
      maxBytes: 1_024,
      requestTimeoutMs: 1_000,
    }, {
      lookup: async host => host === 'rebind.example.com'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
      fetcher: async () => new Response('', {
        status: 302,
        headers: { location: 'https://rebind.example.com/internal' },
      }),
    })).rejects.toMatchObject({ code: 'rejected-ssrf' })

    // Rejects when redirect count exceeds maxRedirects
    let hops = 0
    await expect(fetchWebPageReadOnly({
      url: 'https://example.com/0',
      allowedDomains: ['example.com'],
      maxBytes: 1_024,
      requestTimeoutMs: 1_000,
      maxRedirects: 2,
    }, {
      lookup: PUBLIC_IPV4_LOOKUP,
      fetcher: async () => {
        hops += 1
        return new Response('', {
          status: 302,
          headers: { location: `https://example.com/${hops}` },
        })
      },
    })).rejects.toMatchObject({ code: 'rejected-redirect' })
    expect(hops).toBe(3)
  })

  // T-S4-06: Isolated execution: stripped env, empty 0o700 cwd, zero write tools, SIGKILL
  test('T-S4-06: strips env credentials, isolates cwd in 0o700 scratch dir, enforces tool surface, and SIGKILLs runaway child', async () => {
    const sanitized = sanitizeWebLearningEnv({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      HOME: '/home/secret',
      DSH_HOME: '/data00/secret-dsh',
      DEEPSEEK_API_KEY: 'sk-secret-123',
      GITHUB_TOKEN: 'ghp_secret_456',
      OPENAI_API_KEY: 'sk-openai-789',
      COOKIE: 'session=abc',
      HTTP_PROXY: 'http://user:pass@proxy.local:8080',
    })
    expect(sanitized).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
    })

    // Tool-surface guard
    expect(() => assertReadOnlyWebToolSurface([])).not.toThrow()
    expect(() => assertReadOnlyWebToolSurface(['web_fetch_readonly'])).not.toThrow()
    for (const forbidden of [
      'write',
      'edit',
      'bash',
      'exec',
      'shell',
      'memory_manage',
      'wiki_upsert',
      'goal_create',
      'work_item_create',
      'action_execute',
      'isolation_run',
      'assoc_read',
    ]) {
      expect(() => assertReadOnlyWebToolSurface([forbidden])).toThrowError(/forbidden/i)
    }

    // Real subprocess execution of production web-learning-worker.ts
    const tempRoot = await makeTempDir('s4-runner-root-')
    const prodRunner = createSubprocessWebLearningRunner({
      tempBaseDir: tempRoot,
      sourceEnv: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: '/home/host-user',
        DSH_HOME: '/data00/host-dsh',
        DEEPSEEK_API_KEY: 'sk-host-secret',
        GITHUB_TOKEN: 'ghp_host_secret',
        OPENAI_API_KEY: 'sk-openai-secret',
        COOKIE: 'secret=cookie',
      },
    })

    const prodOutput = await prodRunner.run({
      runId: 'subproc-proof-1',
      allowedDomains: [],
      targets: [],
      budget: {
        maxRequests: 2,
        maxPages: 2,
        maxBytesPerRequest: 1_024,
        maxTotalBytes: 2_048,
        maxDurationMs: 5_000,
        requestTimeoutMs: 1_000,
      },
    })

    expect(prodOutput.status).toBe('rejected')
    expect(prodOutput.environmentProof.envKeys).toEqual(['LANG', 'PATH'])
    expect(prodOutput.environmentProof.cwd.startsWith(tempRoot)).toBe(true)
    // Scratch directory must be cleaned up after completion
    expect(existsSync(prodOutput.environmentProof.cwd)).toBe(false)
    expect(readdirSync(tempRoot)).toEqual([])

    // Probe child script verifying inside-process cwd permissions (0o700), emptiness, and zero leaked secrets
    const probeScriptPath = join(tempRoot, 'probe-worker.mjs')
    await writeFile(
      probeScriptPath,
      [
        "import { readdirSync, statSync } from 'node:fs'",
        "let raw = ''",
        "for await (const c of process.stdin) raw += c",
        'const input = JSON.parse(raw)',
        'const cwd = process.cwd()',
        'const mode = statSync(cwd).mode & 0o777',
        'const entries = readdirSync(cwd)',
        'const leaked = ["DEEPSEEK_API_KEY","GITHUB_TOKEN","OPENAI_API_KEY","COOKIE","HOME","DSH_HOME"].filter(k => k in process.env)',
        'process.stdout.write(JSON.stringify({',
        '  runId: input.runId,',
        '  status: mode === 0o700 && entries.length === 0 && leaked.length === 0 ? "completed" : "rejected",',
        '  reason: JSON.stringify({ mode, entries, leaked }),',
        '  startedAt: Date.now(),',
        '  finishedAt: Date.now(),',
        '  requestsUsed: 0, pagesFetched: 0, bytesFetched: 0, pages: [], attempts: [],',
        '  environmentProof: { pid: process.pid, cwd, envKeys: Object.keys(process.env).sort() },',
        '}))',
      ].join('\n'),
      'utf8',
    )

    const probeRunner = createSubprocessWebLearningRunner({
      workerEntryPath: probeScriptPath,
      tempBaseDir: tempRoot,
      sourceEnv: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: '/home/should-not-leak',
        DSH_HOME: '/data00/should-not-leak',
        DEEPSEEK_API_KEY: 'sk-should-not-leak',
        GITHUB_TOKEN: 'ghp_should-not-leak',
        OPENAI_API_KEY: 'sk-should-not-leak-2',
        COOKIE: 'should-not-leak',
      },
    })
    const probeOut = await probeRunner.run({
      runId: 'subproc-probe-2',
      allowedDomains: ['example.com'],
      targets: [],
      budget: {
        maxRequests: 1,
        maxPages: 1,
        maxBytesPerRequest: 1_024,
        maxTotalBytes: 1_024,
        maxDurationMs: 5_000,
        requestTimeoutMs: 1_000,
      },
    })
    expect(probeOut.status).toBe('completed')
    expect(JSON.parse(probeOut.reason)).toEqual({ mode: 0o700, entries: [], leaked: [] })
    expect(existsSync(probeOut.environmentProof.cwd)).toBe(false)

    // Runaway subprocess ignoring SIGTERM must be SIGKILLed at maxDurationMs + killGraceMs
    const runawayScriptPath = join(tempRoot, 'runaway-worker.mjs')
    await writeFile(
      runawayScriptPath,
      [
        "process.on('SIGTERM', () => {})",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
      'utf8',
    )
    const runawayRunner = createSubprocessWebLearningRunner({
      workerEntryPath: runawayScriptPath,
      tempBaseDir: tempRoot,
      killGraceMs: 100,
      runnerTimeoutBufferMs: 0,
    })
    const started = Date.now()
    await expect(runawayRunner.run({
      runId: 'subproc-runaway-3',
      allowedDomains: ['example.com'],
      targets: [],
      budget: {
        maxRequests: 1,
        maxPages: 1,
        maxBytesPerRequest: 1_024,
        maxTotalBytes: 1_024,
        maxDurationMs: 700,
        requestTimeoutMs: 700,
      },
    })).rejects.toThrowError(/timed out.*SIGKILL/i)
    expect(Date.now() - started).toBeLessThan(3_000)
    // Verify only the two test scripts remain in tempRoot (scratch dir deleted)
    expect(readdirSync(tempRoot).sort()).toEqual(['probe-worker.mjs', 'runaway-worker.mjs'])
    expect(statSync(tempRoot).isDirectory()).toBe(true)
  })

  // T-S4-07: Content-Type MIME filter, streaming byte cap, timeout, and HTML extraction
  test('T-S4-07: enforces MIME allowlist, streaming maxBytes cap, requestTimeoutMs, and pure HTML extraction', async () => {
    // Disallowed MIME types (binary / js / missing)
    for (const contentType of ['application/octet-stream', 'application/javascript', 'image/png', '']) {
      const cancel = vi.fn()
      const body = new ReadableStream({ cancel })
      await expect(fetchWebPageReadOnly({
        url: 'https://example.com/file',
        allowedDomains: ['example.com'],
        maxBytes: 1_024,
        requestTimeoutMs: 1_000,
      }, {
        lookup: PUBLIC_IPV4_LOOKUP,
        fetcher: async () => new Response(body, {
          status: 200,
          headers: contentType ? { 'content-type': contentType } : {},
        }),
      })).rejects.toMatchObject({ code: 'rejected-content-type' })
      expect(cancel).toHaveBeenCalledOnce()
    }

    // Declared Content-Length exceeding maxBytes
    const cancelDeclared = vi.fn()
    await expect(fetchWebPageReadOnly({
      url: 'https://example.com/big',
      allowedDomains: ['example.com'],
      maxBytes: 16,
      requestTimeoutMs: 1_000,
    }, {
      lookup: PUBLIC_IPV4_LOOKUP,
      fetcher: async () => new Response(new ReadableStream({ cancel: cancelDeclared }), {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '2048' },
      }),
    })).rejects.toMatchObject({ code: 'rejected-size' })
    expect(cancelDeclared).toHaveBeenCalledOnce()

    // Streaming chunk cap without Content-Length header
    const cancelStream = vi.fn()
    await expect(fetchWebPageReadOnly({
      url: 'https://example.com/stream-big',
      allowedDomains: ['example.com'],
      maxBytes: 8,
      requestTimeoutMs: 1_000,
    }, {
      lookup: PUBLIC_IPV4_LOOKUP,
      fetcher: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('12345'))
          controller.enqueue(new TextEncoder().encode('67890'))
        },
        cancel: cancelStream,
      }), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    })).rejects.toMatchObject({ code: 'rejected-size' })
    expect(cancelStream).toHaveBeenCalledOnce()

    // Slow response aborted by requestTimeoutMs
    vi.useFakeTimers()
    const slowPromise = fetchWebPageReadOnly({
      url: 'https://example.com/slow',
      allowedDomains: ['example.com'],
      maxBytes: 1_024,
      requestTimeoutMs: 100,
    }, {
      lookup: PUBLIC_IPV4_LOOKUP,
      fetcher: async () => new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    }).then(() => 'ok', (error: WebFetchError) => error.code)
    await vi.advanceTimersByTimeAsync(100)
    await expect(slowPromise).resolves.toBe('rejected-timeout')
    vi.useRealTimers()

    // Pure HTML extraction
    const html = [
      '<!doctype html><html><head><title>Node.js &amp; TypeScript &amp;lt;Guide&amp;gt;</title>',
      '<style>body { color: red; }</style>',
      '<script>alert("xss")</script></head>',
      '<body><!-- secret comment --><h1>Overview</h1>',
      '<noscript>Enable JS</noscript><svg><text>ignored</text></svg>',
      '<p>Read <a href="/docs/streams">Streams API</a> and ',
      '<a href="https://evil.com/phish">Evil</a> and ',
      '<a href="http://example.com/insecure">HTTP</a>.</p>',
      '</body></html>',
    ].join('')
    const extracted = extractPlainTextFromHtml(html, {
      contentType: 'text/html',
      baseUrl: 'https://example.com/index.html',
      allowedDomains: ['example.com'],
      maxTextChars: 8_192,
    })
    expect(extracted.title).toBe('Node.js & TypeScript &lt;Guide&gt;')
    expect(extracted.text).toContain('Overview')
    expect(extracted.text).toContain('Read Streams API')
    expect(extracted.text).not.toContain('alert')
    expect(extracted.text).not.toContain('color: red')
    expect(extracted.text).not.toContain('secret comment')
    expect(extracted.text).not.toContain('Enable JS')
    expect(extracted.text).not.toContain('ignored')
    expect(extracted.links).toEqual(['https://example.com/docs/streams'])

    const longExtracted = extractPlainTextFromHtml(`<p>${'a'.repeat(10_000)}</p>`, {
      contentType: 'text/html',
    })
    expect(longExtracted.text.length).toBe(8_192)
  })

  // Budget exhaustion hard stop in executeWebLearningPlan & createInProcessWebLearningRunner
  test('stops immediately on budget exhaustion while preserving fetched pages and exact accounting', async () => {
    let nowMs = 1_700_000_000_000
    const fetcher = vi.fn(async (url: string) => {
      if (url === 'https://example.com/redirect-hop') {
        return new Response('', { status: 302, headers: { location: 'https://example.com/p2' } })
      }
      return new Response(`<html><title>Title ${url}</title><body>Body for ${url}</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    })

    const runner = createInProcessWebLearningRunner({
      lookup: PUBLIC_IPV4_LOOKUP,
      fetcher,
      now: () => {
        nowMs += 5
        return nowMs
      },
    })

    // Case 1: maxPages exhaustion preserves first 2 pages and skips target 3
    const pageCapOutput = await runner.run({
      runId: 'budget-pages',
      allowedDomains: ['example.com'],
      targets: [
        { url: 'https://example.com/p1', interestKey: 'interest-1', originNodeIds: ['a:g-1'] },
        { url: 'https://example.com/p2', interestKey: 'interest-2', originNodeIds: ['a:w-2'] },
        { url: 'https://example.com/p3', interestKey: 'interest-3' },
      ],
      budget: {
        maxRequests: 10,
        maxPages: 2,
        maxBytesPerRequest: 4_096,
        maxTotalBytes: 16_384,
        maxDurationMs: 5_000,
        requestTimeoutMs: 1_000,
      },
    })
    expect(pageCapOutput.status).toBe('budget-exhausted')
    expect(pageCapOutput.reason).toBe('max-pages-exhausted')
    expect(pageCapOutput.pagesFetched).toBe(2)
    expect(pageCapOutput.requestsUsed).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(pageCapOutput.pages).toHaveLength(2)
    expect(pageCapOutput.pages[0]).toMatchObject({
      sourceUrl: 'https://example.com/p1',
      interestKey: 'interest-1',
      contentType: 'text/html',
      originNodeIds: ['a:g-1'],
    })
    expect(pageCapOutput.pages[0]!.contentDigest).toBe(
      createHash('sha256').update(pageCapOutput.pages[0]!.text, 'utf8').digest('hex'),
    )
    expect(pageCapOutput.pages[0]!.fetchedAt).toBeGreaterThan(1_700_000_000_000)

    // Case 2: maxRequests exhaustion across a redirect hop stops before sending hop 2
    fetcher.mockClear()
    const requestCapOutput = await runner.run({
      runId: 'budget-requests',
      allowedDomains: ['example.com'],
      targets: [
        { url: 'https://example.com/p1', interestKey: 'k1' },
        { url: 'https://example.com/redirect-hop', interestKey: 'k2' },
      ],
      budget: {
        maxRequests: 2,
        maxPages: 5,
        maxBytesPerRequest: 4_096,
        maxTotalBytes: 16_384,
        maxDurationMs: 5_000,
        requestTimeoutMs: 1_000,
      },
    })
    expect(requestCapOutput.status).toBe('budget-exhausted')
    expect(requestCapOutput.reason).toBe('max-requests-exhausted')
    expect(requestCapOutput.requestsUsed).toBe(2)
    expect(requestCapOutput.pagesFetched).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(2)

    // Case 3: maxTotalBytes exhaustion stops when second page exceeds remaining total budget
    fetcher.mockClear()
    const bytesCapOutput = await runner.run({
      runId: 'budget-bytes',
      allowedDomains: ['example.com'],
      targets: [
        { url: 'https://example.com/p1', interestKey: 'k1' },
        { url: 'https://example.com/p2', interestKey: 'k2' },
      ],
      budget: {
        maxRequests: 5,
        maxPages: 5,
        maxBytesPerRequest: 1_024,
        maxTotalBytes: 100,
        maxDurationMs: 5_000,
        requestTimeoutMs: 1_000,
      },
    })
    expect(bytesCapOutput.status).toBe('budget-exhausted')
    expect(bytesCapOutput.reason).toBe('max-bytes-exhausted')
    expect(bytesCapOutput.pagesFetched).toBe(1)
    expect(bytesCapOutput.bytesFetched).toBeLessThanOrEqual(100)
  })

  test('extractPlainTextFromHtml blocks </script foo="bar">, unclosed <script>, comment-spoofed <title>, and nested <scr<script>ipt> without dropping visible paragraphs', () => {
    const endAttr = extractPlainTextFromHtml(
      '<html><head><title>Real Title</title></head><body><script>LEAKED_SCRIPT_BODY</script foo="bar"><p>Real Body</p></body></html>',
      { contentType: 'text/html' },
    )
    expect(endAttr.title).toBe('Real Title')
    expect(endAttr.text).toContain('Real Body')
    expect(endAttr.text).not.toContain('LEAKED_SCRIPT_BODY')

    const unclosed = extractPlainTextFromHtml(
      '<html><body><p>Before</p><script>UNCLOSED_SECRET_SCRIPT_1<p>Visible after unclosed?</p></body></html>',
      { contentType: 'text/html' },
    )
    expect(unclosed.text).toContain('Before')
    expect(unclosed.text).not.toContain('UNCLOSED_SECRET_SCRIPT_1')

    const commentTitle = extractPlainTextFromHtml(
      '<html><head><!-- <title>Spoofed</title> --><title>Real Title</title></head><body><p>Body</p></body></html>',
      { contentType: 'text/html' },
    )
    expect(commentTitle.title).toBe('Real Title')
    expect(commentTitle.title).not.toContain('Spoofed')

    const nested = extractPlainTextFromHtml(
      '<title>Safe &amp; Sound</title>\n<scr<script>ipt>NESTED_SECRET</script>\n<p>Visible &lt;script&gt;text&lt;/script&gt; here.</p>\n<a href="https://evil.org/phish">bad</a>',
      {
        contentType: 'text/html',
        baseUrl: 'https://example.com/page',
        allowedDomains: ['example.com'],
      },
    )
    expect(nested.title).toBe('Safe & Sound')
    expect(nested.text).not.toContain('NESTED_SECRET')
    expect(nested.text).toContain('Visible <script>text</script> here.')

    const nestedReassembled = extractPlainTextFromHtml(
      '<scr<script></script>ipt>REASSEMBLED_SECRET</script><p>After</p>',
      { contentType: 'text/html' },
    )
    expect(nestedReassembled.text).not.toContain('REASSEMBLED_SECRET')
    expect(nestedReassembled.text).toContain('After')
  })
})
