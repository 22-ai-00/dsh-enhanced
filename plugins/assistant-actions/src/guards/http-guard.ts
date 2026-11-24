import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type {
  HttpGrantDestination,
  HttpMethod,
  HttpRequestDestination,
  HttpRequestPayload,
} from '../broker-protocol-v2.js'

export interface DnsResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type HttpDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly DnsResolvedAddress[]>

export interface HttpTransportRequest {
  readonly url: URL
  readonly pinnedAddress: string
  readonly pinnedFamily: 4 | 6
  readonly method: HttpMethod
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly signal: AbortSignal
}

export interface HttpTransportResponse {
  readonly statusCode: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer
  readonly truncated: boolean
}

export type HttpTransportFn = (request: HttpTransportRequest) => Promise<HttpTransportResponse>

export interface HttpGuardDeps {
  readonly lookup?: HttpDnsLookup
  readonly requestImpl?: HttpTransportFn
  readonly secrets?: readonly string[]
}

export class HttpGuardError extends Error {
  constructor(
    readonly code: 'request-invalid' | 'grant-invalid' | 'target-mismatch' | 'transport-failed' | 'response-secret-leak',
    readonly dispatched: boolean,
    message: string,
  ) {
    super(`assistant-actions http guard: ${message}`)
    this.name = 'HttpGuardError'
  }
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
])

const CREDENTIAL_SHAPE_RE = /(?:\bbearer\s+[A-Za-z0-9._~-]+|\bbasic\s+[A-Za-z0-9+/=]+|github_pat_|gh[pousr]_|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bauthorization\s*:|\bcookie\s*:)/iu
const CONTROL_CHAR_RE = /[\p{Cc}]/u

function parseIpv4Int(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return undefined
    const octet = Number(part)
    if (octet < 0 || octet > 255) return undefined
    value = ((value << 8) | octet) >>> 0
  }
  return value
}

function ipv4InCidr(ipInt: number, baseInt: number, prefixBits: number): boolean {
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

function expandIpv6(ip: string): number[] | undefined {
  if (ip.includes('%')) return undefined
  let input = ip.toLowerCase()
  const lastColon = input.lastIndexOf(':')
  if (lastColon >= 0 && input.includes('.')) {
    const ipv4Part = input.slice(lastColon + 1)
    const ipv4Int = parseIpv4Int(ipv4Part)
    if (ipv4Int === undefined) return undefined
    const hi = ((ipv4Int >>> 16) & 0xffff).toString(16)
    const lo = (ipv4Int & 0xffff).toString(16)
    input = `${input.slice(0, lastColon)}:${hi}:${lo}`
  }
  const halves = input.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : halves[0]!.split(':')
  const right = halves.length === 1 ? [] : (halves[1] === '' ? [] : halves[1]!.split(':'))
  if (halves.length === 1 && left.length !== 8) return undefined
  if (halves.length === 2 && left.length + right.length >= 8) return undefined
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right]
  if (groups.length !== 8) return undefined
  const parsed: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined
    parsed.push(parseInt(group, 16))
  }
  return parsed
}

export function isBlockedIpAddress(ip: string, allowPrivateNetwork = false): boolean {
  const family = isIP(ip)
  if (family === 4) {
    const ipInt = parseIpv4Int(ip)
    if (ipInt === undefined) return true
    // Always block unspecified (0.0.0.0/8), link-local & cloud metadata (169.254.0.0/16), multicast (224.0.0.0/4), reserved (240.0.0.0/4)
    if (
      ipv4InCidr(ipInt, 0x00000000, 8) ||
      ipv4InCidr(ipInt, 0xa9fe0000, 16) ||
      ipv4InCidr(ipInt, 0xe0000000, 4) ||
      ipv4InCidr(ipInt, 0xf0000000, 4)
    ) {
      return true
    }
    if (allowPrivateNetwork) return false
    return (
      ipv4InCidr(ipInt, 0x7f000000, 8) || // 127.0.0.0/8
      ipv4InCidr(ipInt, 0x0a000000, 8) || // 10.0.0.0/8
      ipv4InCidr(ipInt, 0xac100000, 12) || // 172.16.0.0/12
      ipv4InCidr(ipInt, 0xc0a80000, 16) || // 192.168.0.0/16
      ipv4InCidr(ipInt, 0x64400000, 10) || // 100.64.0.0/10
      ipv4InCidr(ipInt, 0xc0000000, 24) || // 192.0.0.0/24
      ipv4InCidr(ipInt, 0xc0000200, 24) || // 192.0.2.0/24
      ipv4InCidr(ipInt, 0xc6120000, 15) || // 198.18.0.0/15
      ipv4InCidr(ipInt, 0xc6336400, 24) || // 198.51.100.0/24
      ipv4InCidr(ipInt, 0xcb007100, 24)    // 203.0.113.0/24
    )
  }

  if (family === 6) {
    const groups = expandIpv6(ip)
    if (!groups) return true
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number]
    const toIpv4 = (hi: number, lo: number): string =>
      `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`

    // :: unspecified
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) return true
    // ff00::/8 multicast
    if ((g0 & 0xff00) === 0xff00) return true
    // fe80::/10 link-local
    if ((g0 & 0xffc0) === 0xfe80) return true
    // Unwrap ::ffff:0:0/96 IPv4-mapped IPv6
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return isBlockedIpAddress(toIpv4(g6, g7), allowPrivateNetwork)
    }
    // ::/96 IPv4-compatible IPv6 (excluding :: and ::1)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      if (g6 === 0 && g7 === 1) return !allowPrivateNetwork
      if (!allowPrivateNetwork) return true
      return isBlockedIpAddress(toIpv4(g6, g7), true)
    }
    // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
    if (
      (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
      || (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001)
    ) {
      if (!allowPrivateNetwork) return true
      return isBlockedIpAddress(toIpv4(g6, g7), true)
    }
    // 2002::/16 6to4 embedded IPv4
    if (g0 === 0x2002) {
      return isBlockedIpAddress(toIpv4(g1, g2), allowPrivateNetwork)
    }
    // 2001::/32 Teredo (embedded client IPv4 is XOR 0xffff in g6, g7)
    if (g0 === 0x2001 && g1 === 0x0000) {
      if (!allowPrivateNetwork) return true
      return isBlockedIpAddress(toIpv4(g6 ^ 0xffff, g7 ^ 0xffff), true)
    }
    // ISATAP embedded IPv4
    if ((g4 === 0x0000 || g4 === 0x0200) && g5 === 0x5efe) {
      if (isBlockedIpAddress(toIpv4(g6, g7), allowPrivateNetwork)) return true
    }

    if (allowPrivateNetwork) return false
    // Enforce global unicast 2000::/3 only (blocks fc00::/7 ULA, 100::/64 discard, etc.)
    if (g0 < 0x2000 || g0 > 0x3fff) return true
    // 2001:2::/48 benchmarking, 2001:10::/28 ORCHID, 2001:20::/28 ORCHIDv2, 2001:db8::/32 docs, 3fff::/20
    if (
      (g0 === 0x2001 && g1 === 0x0002 && g2 === 0x0000)
      || (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010)
      || (g0 === 0x2001 && (g1 & 0xfff0) === 0x0020)
      || (g0 === 0x2001 && g1 === 0x0db8)
      || (g0 === 0x3fff && (g1 & 0xf000) === 0x0000)
    ) {
      return true
    }
    return false
  }

  return true
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true
  if (prefix === '/') return pathname.startsWith('/')
  if (prefix.endsWith('/')) return pathname.startsWith(prefix)
  return pathname.startsWith(`${prefix}/`)
}

export function isSafeUrlPathSegment(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !/[/\\?%#\s\p{Cc}]/u.test(value)
  )
}

export function validateStrictHttpUrl(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || rawUrl.length < 8 || rawUrl.length > 4_096 || CONTROL_CHAR_RE.test(rawUrl) || /\s/u.test(rawUrl) || rawUrl.includes('\\')) {
    throw new HttpGuardError('request-invalid', false, 'URL contains forbidden characters or whitespace')
  }
  if (rawUrl.includes('#')) {
    throw new HttpGuardError('request-invalid', false, 'URL fragments are forbidden')
  }
  if (/%(?:2e|2f|5c)/iu.test(rawUrl)) {
    throw new HttpGuardError('request-invalid', false, 'encoded path traversal characters are forbidden')
  }
  const schemeSep = rawUrl.indexOf('://')
  if (schemeSep < 0) {
    throw new HttpGuardError('request-invalid', false, 'URL is malformed')
  }
  const afterScheme = rawUrl.slice(schemeSep + 3)
  const authorityEnd = afterScheme.search(/[/?#]/u)
  const rawAuthority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd)
  if (rawAuthority.includes('@')) {
    throw new HttpGuardError('request-invalid', false, 'URL userinfo credentials are forbidden')
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new HttpGuardError('request-invalid', false, 'URL is malformed')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpGuardError('request-invalid', false, 'URL scheme must be http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new HttpGuardError('request-invalid', false, 'URL userinfo credentials are forbidden')
  }
  if (parsed.hash !== '') {
    throw new HttpGuardError('request-invalid', false, 'URL fragment is forbidden')
  }
  const pathSegments = rawUrl.split('?')[0]!.split('/')
  if (pathSegments.some(segment => segment === '..' || segment === '.')) {
    throw new HttpGuardError('request-invalid', false, 'dot path segments are forbidden')
  }
  return parsed
}

export function validateHttpAgainstGrant(
  grantDest: HttpGrantDestination,
  reqDest: HttpRequestDestination,
  payload: HttpRequestPayload,
): { url: URL; scheme: 'http' | 'https'; host: string; port: number; headers: Record<string, string> } {
  const url = validateStrictHttpUrl(payload.url)
  const scheme = url.protocol === 'https:' ? 'https' : 'http'
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const port = url.port ? Number(url.port) : (scheme === 'https' ? 443 : 80)

  if (!grantDest.allowedSchemes.includes(scheme) || reqDest.scheme !== scheme) {
    throw new HttpGuardError('grant-invalid', false, 'HTTP scheme not permitted by grant')
  }
  if (!grantDest.allowedHosts.includes(host) || reqDest.host.toLowerCase() !== host) {
    throw new HttpGuardError('grant-invalid', false, 'HTTP host not permitted by grant')
  }
  if (grantDest.allowedPorts !== undefined && !grantDest.allowedPorts.includes(port)) {
    throw new HttpGuardError('grant-invalid', false, 'HTTP port not permitted by grant')
  }
  if (reqDest.port !== undefined && reqDest.port !== port) {
    throw new HttpGuardError('target-mismatch', false, 'HTTP port mismatch')
  }
  if (!grantDest.allowedPathPrefixes.some(prefix => pathMatchesPrefix(url.pathname, prefix)) || reqDest.path !== url.pathname) {
    throw new HttpGuardError('grant-invalid', false, 'HTTP path not permitted by grant')
  }
  if (!grantDest.allowedMethods.includes(payload.method)) {
    throw new HttpGuardError('grant-invalid', false, 'HTTP method not permitted by grant')
  }

  const sanitizedHeaders: Record<string, string> = {}
  if (payload.headers) {
    for (const [rawKey, rawVal] of Object.entries(payload.headers)) {
      const lower = rawKey.toLowerCase()
      if (FORBIDDEN_REQUEST_HEADERS.has(lower)) {
        throw new HttpGuardError('request-invalid', false, `forbidden HTTP request header: ${rawKey}`)
      }
      if (rawKey.includes('\0') || rawKey.includes('\r') || rawKey.includes('\n') || rawVal.includes('\0') || rawVal.includes('\r') || rawVal.includes('\n')) {
        throw new HttpGuardError('request-invalid', false, 'header contains CRLF or NUL')
      }
      sanitizedHeaders[lower] = rawVal
    }
  }
  return { url, scheme, host, port, headers: sanitizedHeaders }
}

export async function resolveAndPinHttpAddress(
  host: string,
  allowPrivateNetwork: boolean,
  lookupImpl: HttpDnsLookup = async (hostname, options) => {
    const entries = await dnsLookup(hostname, options)
    return entries.map(entry => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }))
  },
): Promise<DnsResolvedAddress> {
  const literalFamily = isIP(host)
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedIpAddress(host, allowPrivateNetwork)) {
      throw new HttpGuardError('grant-invalid', false, `blocked IP literal: ${host}`)
    }
    return { address: host, family: literalFamily }
  }

  let addresses: readonly DnsResolvedAddress[]
  try {
    addresses = await lookupImpl(host, { all: true, verbatim: true })
  } catch {
    throw new HttpGuardError('transport-failed', false, `DNS resolution failed for ${host}`)
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new HttpGuardError('transport-failed', false, `DNS resolution returned no addresses for ${host}`)
  }
  for (const entry of addresses) {
    if (!entry || (entry.family !== 4 && entry.family !== 6) || isBlockedIpAddress(entry.address, allowPrivateNetwork)) {
      throw new HttpGuardError('grant-invalid', false, `DNS resolved to blocked address ${entry?.address ?? 'unknown'}`)
    }
  }
  return addresses[0]!
}

const defaultHttpTransport: HttpTransportFn = async request => {
  const client = request.url.protocol === 'https:' ? https : http
  return await new Promise<HttpTransportResponse>((resolvePromise, rejectPromise) => {
    let settled = false
    const finishError = (error: unknown): void => {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
    const headers: Record<string, string> = {
      ...request.headers,
      host: request.url.host,
    }
    if (request.body !== undefined && !Object.hasOwn(headers, 'content-length')) {
      headers['content-length'] = String(Buffer.byteLength(request.body, 'utf8'))
    }
    const pinnedLookup = (
      _hostname: string,
      options: unknown,
      callback?: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
    ): void => {
      const cb = typeof options === 'function' ? options as typeof callback : callback
      const opts = typeof options === 'object' && options !== null ? options as { all?: boolean } : {}
      if (!cb) return
      if (opts.all) cb(null, [{ address: request.pinnedAddress, family: request.pinnedFamily }])
      else cb(null, request.pinnedAddress, request.pinnedFamily)
    }

    const req = client.request({
      protocol: request.url.protocol,
      hostname: request.url.hostname,
      port: request.url.port ? Number(request.url.port) : (request.url.protocol === 'https:' ? 443 : 80),
      path: `${request.url.pathname}${request.url.search}`,
      method: request.method,
      headers,
      agent: false,
      timeout: request.timeoutMs,
      signal: request.signal,
      lookup: pinnedLookup as never,
      ...(request.url.protocol === 'https:' ? { servername: request.url.hostname } : {}),
    }, res => {
      const statusCode = res.statusCode ?? 0
      if (statusCode >= 300 && statusCode < 400) {
        res.destroy()
        finishError(new HttpGuardError('grant-invalid', true, `HTTP redirects (${statusCode}) are forbidden`))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      let truncated = false
      res.on('data', (chunk: Buffer) => {
        if (truncated) return
        const remaining = request.maxResponseBytes - total
        if (chunk.length > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
          total = request.maxResponseBytes
          truncated = true
          res.destroy()
          if (!settled) {
            settled = true
            resolvePromise({
              statusCode,
              headers: normalizeResponseHeaders(res.headers),
              body: Buffer.concat(chunks),
              truncated: true,
            })
          }
          return
        }
        chunks.push(chunk)
        total += chunk.length
      })
      res.once('end', () => {
        if (settled) return
        settled = true
        resolvePromise({
          statusCode,
          headers: normalizeResponseHeaders(res.headers),
          body: Buffer.concat(chunks),
          truncated,
        })
      })
      res.once('error', error => {
        if (truncated && settled) return
        finishError(new HttpGuardError('transport-failed', true, error.message))
      })
    })
    req.once('timeout', () => {
      req.destroy()
      finishError(new HttpGuardError('transport-failed', true, 'HTTP request timed out'))
    })
    req.once('error', error => {
      finishError(new HttpGuardError('transport-failed', true, error.message))
    })
    if (request.body !== undefined) req.write(request.body, 'utf8')
    req.end()
  })
}

function normalizeResponseHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (lower === 'set-cookie' || lower === 'authorization' || lower === 'proxy-authorization') continue
    const textVal = Array.isArray(value) ? value.join(', ') : value
    if (!textVal.includes('\0') && !textVal.includes('\r') && !textVal.includes('\n')) out[lower] = textVal.slice(0, 4_096)
  }
  return out
}

export function responseContainsSecret(value: string, secrets: readonly string[]): boolean {
  if (CREDENTIAL_SHAPE_RE.test(value)) return true
  return secrets.some(secret => secret.length > 0 && value.includes(secret))
}

export async function executeHttpGuardedAction(input: {
  readonly grantDestination: HttpGrantDestination
  readonly requestDestination: HttpRequestDestination
  readonly payload: HttpRequestPayload
  readonly token?: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly deps?: HttpGuardDeps
}): Promise<{
  readonly domain: 'http'
  readonly operation: 'http.request'
  readonly statusCode: number
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly body: string
  readonly bodySha256: string
  readonly truncated: boolean
  readonly untrusted: true
}> {
  const { url, host, headers } = validateHttpAgainstGrant(input.grantDestination, input.requestDestination, input.payload)
  const pinned = await resolveAndPinHttpAddress(host, input.grantDestination.allowPrivateNetwork === true, input.deps?.lookup)

  const transportHeaders: Record<string, string> = { ...headers }
  if (input.token && input.grantDestination.authHeader) {
    const headerName = input.grantDestination.authHeader.toLowerCase()
    transportHeaders[headerName] = input.grantDestination.authScheme
      ? `${input.grantDestination.authScheme} ${input.token}`
      : input.token
  }

  const transport = input.deps?.requestImpl ?? defaultHttpTransport
  const res = await transport({
    url,
    pinnedAddress: pinned.address,
    pinnedFamily: pinned.family,
    method: input.payload.method,
    headers: transportHeaders,
    ...(input.payload.body === undefined ? {} : { body: input.payload.body }),
    timeoutMs: input.timeoutMs,
    maxResponseBytes: input.grantDestination.maxResponseBytes,
    signal: input.signal,
  })

  if (res.statusCode >= 300 && res.statusCode < 400) {
    throw new HttpGuardError('grant-invalid', true, `HTTP redirects (${res.statusCode}) are forbidden`)
  }

  const bodyText = res.body.toString('utf8')
  const bodySha256 = createHash('sha256').update(res.body).digest('hex')
  if (input.payload.expectedResponseSha256 !== undefined && input.payload.expectedResponseSha256 !== bodySha256) {
    throw new HttpGuardError('target-mismatch', true, 'HTTP response digest does not match expectedResponseSha256')
  }

  const secrets = [...(input.deps?.secrets ?? []), ...(input.token ? [input.token] : [])]
  if (responseContainsSecret(bodyText, secrets) || Object.values(res.headers).some(v => responseContainsSecret(v, secrets))) {
    throw new HttpGuardError('response-secret-leak', true, 'HTTP response contained a protected secret or credential shape')
  }

  return Object.freeze({
    domain: 'http',
    operation: 'http.request',
    statusCode: res.statusCode,
    responseHeaders: Object.freeze({ ...res.headers }),
    body: bodyText,
    bodySha256,
    truncated: res.truncated,
    untrusted: true,
  })
}
