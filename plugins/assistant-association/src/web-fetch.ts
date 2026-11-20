import { lookup as dnsLookup } from 'node:dns/promises'
import { request as nodeHttpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'

const MAX_DNS_ANSWERS = 16
const DEFAULT_MAX_URL_LENGTH = 2_048
const DEFAULT_MAX_REDIRECTS = 2
const DEFAULT_MAX_HTML_TEXT_CHARS = 8_192
const DEFAULT_MAX_TITLE_CHARS = 160
const DEFAULT_MAX_EXTRACTED_LINKS = 16

export const ALLOWED_WEB_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
])

export const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
])

export const READ_ONLY_WEB_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9',
  'accept-encoding': 'identity',
  'user-agent': 'dsh-enhanced-web-learning/1.0',
})

export const ALLOWED_WEB_LEARNING_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const

export const ALLOWED_WEB_LEARNING_TOOLS: ReadonlySet<string> = new Set([
  'web_fetch_readonly',
])

export const FORBIDDEN_WEB_LEARNING_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multi_edit',
  'patch',
  'delete',
  'rm',
  'bash',
  'exec',
  'shell',
  'run_command',
  'spawn',
  'memory_manage',
  'memory_write',
  'wiki_upsert',
  'wiki_write',
  'goal_create',
  'goal_update',
  'work_item_create',
  'work_item_update',
  'work_item_admit',
  'action_execute',
  'action_propose',
  'isolation_run',
  'assoc_read',
  'plugin_install',
  'config_write',
])

const FORBIDDEN_TOOL_PREFIXES = [
  'write_',
  'edit_',
  'delete_',
  'exec_',
  'shell_',
  'bash_',
  'memory_',
  'wiki_',
  'goal_',
  'work_item_',
  'action_',
  'isolation_',
  'assoc_',
] as const

export type WebFetchRejectionCode =
  | 'rejected-empty-whitelist'
  | 'rejected-invalid-url'
  | 'rejected-scheme'
  | 'rejected-credentials'
  | 'rejected-port'
  | 'rejected-ip-literal'
  | 'rejected-forbidden-host'
  | 'rejected-whitelist'
  | 'rejected-ssrf'
  | 'rejected-dns'
  | 'rejected-redirect'
  | 'rejected-method'
  | 'rejected-header'
  | 'rejected-content-type'
  | 'rejected-size'
  | 'rejected-http-status'
  | 'rejected-timeout'
  | 'rejected-aborted'

export class WebFetchError extends Error {
  readonly code: WebFetchRejectionCode

  constructor(code: WebFetchRejectionCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebFetchError'
    this.code = code
  }
}

export interface ResolvedAddress {
  readonly address: string
  readonly family: number
}

export interface ValidatedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface ValidatedRoute {
  readonly addresses: readonly ValidatedAddress[]
}

export type WebLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>
export type WebFetcher = (url: string, init: RequestInit, route: ValidatedRoute) => Promise<Response>

export interface WebFetchDeps {
  readonly lookup?: WebLookup
  readonly fetcher?: WebFetcher
  readonly httpsRequest?: typeof nodeHttpsRequest
  readonly now?: () => number
}

export interface WebUrlWhitelistOptions {
  readonly allowedDomains: readonly string[]
  readonly allowSubdomains?: boolean
  readonly maxUrlLength?: number
}

export interface ValidatedWebUrl {
  readonly url: URL
  readonly canonicalUrl: string
  readonly hostname: string
  readonly matchedDomain: string
}

export interface FetchWebPageInput {
  readonly url: string
  readonly allowedDomains: readonly string[]
  readonly allowSubdomains?: boolean
  readonly allowIpv6?: boolean
  readonly maxBytes: number
  readonly requestTimeoutMs: number
  readonly maxRedirects?: number
  readonly method?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly onBeforeRequest?: (url: string, hop: number) => void
}

export interface FetchWebPageResult {
  readonly sourceUrl: string
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string
  readonly bytesFetched: number
  readonly bodyBuffer: Buffer
  readonly bodyText: string
  readonly requestsUsed: number
  readonly redirectChain: readonly string[]
  readonly fetchedAt: number
}

export interface ExtractHtmlTextOptions {
  readonly contentType?: string
  readonly baseUrl?: string
  readonly allowedDomains?: readonly string[]
  readonly allowSubdomains?: boolean
  readonly maxTextChars?: number
  readonly maxTitleChars?: number
  readonly maxLinks?: number
}

export interface ExtractedWebContent {
  readonly title: string
  readonly text: string
  readonly links: readonly string[]
}

function unbracketHost(host: string): string {
  const lower = host.toLowerCase()
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
}

function isForbiddenHostname(host: string): boolean {
  return (
    host === ''
    || host.endsWith('.')
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.arpa')
  )
}

function normalizeAllowedDomains(domains: readonly string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const raw of domains) {
    const candidate = raw.trim().toLowerCase()
    if (candidate === '') continue
    if (
      candidate.includes('://')
      || candidate.includes('/')
      || candidate.includes(':')
      || candidate.includes('*')
      || /\s/u.test(candidate)
      || isIP(unbracketHost(candidate)) !== 0
      || isForbiddenHostname(candidate)
    ) {
      continue
    }
    if (!seen.has(candidate)) {
      seen.add(candidate)
      normalized.push(candidate)
    }
  }
  return normalized
}

export function validateWhitelistedWebUrl(
  rawUrl: string,
  options: WebUrlWhitelistOptions,
): ValidatedWebUrl {
  const allowed = normalizeAllowedDomains(options.allowedDomains)
  if (allowed.length === 0) {
    throw new WebFetchError('rejected-empty-whitelist', 'web-learning: domain whitelist is empty (fail-closed)')
  }
  const maxLen = options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '' || rawUrl.length > maxLen) {
    throw new WebFetchError('rejected-invalid-url', 'web-learning: URL is empty or exceeds maximum length')
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    throw new WebFetchError('rejected-invalid-url', 'web-learning: URL could not be parsed', { cause: error })
  }

  if (parsed.protocol !== 'https:') {
    throw new WebFetchError('rejected-scheme', `web-learning: only https:// URLs are allowed (got ${parsed.protocol})`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new WebFetchError('rejected-credentials', 'web-learning: embedded URL credentials are not allowed')
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new WebFetchError('rejected-port', `web-learning: non-443 port (${parsed.port}) is not allowed`)
  }

  const host = unbracketHost(parsed.hostname)
  if (isIP(host) !== 0 || host.includes(':')) {
    throw new WebFetchError('rejected-ip-literal', `web-learning: IP literal host (${host}) is not allowed`)
  }
  if (isForbiddenHostname(host)) {
    throw new WebFetchError('rejected-forbidden-host', `web-learning: forbidden host (${host}) is not allowed`)
  }

  const allowSubdomains = options.allowSubdomains === true
  const matchedDomain = allowed.find(domain =>
    host === domain || (allowSubdomains && host.endsWith(`.${domain}`)))
  if (matchedDomain === undefined) {
    throw new WebFetchError('rejected-whitelist', `web-learning: host ${host} is outside the domain whitelist`)
  }

  parsed.hash = ''
  return {
    url: parsed,
    canonicalUrl: parsed.toString(),
    hostname: host,
    matchedDomain,
  }
}

function ipv4Bytes(address: string): [number, number, number, number] | undefined {
  if (isIP(address) !== 4) return undefined
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined
  }
  return parts as [number, number, number, number]
}

function globalIpv4(parts: ArrayLike<number>): boolean {
  const [a, b, c] = parts as [number, number, number, number]
  return !(
    a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  )
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  if (address.includes('%') || isIP(address) !== 6) return undefined
  const halves = address.toLowerCase().split('::')
  if (halves.length > 2) return undefined
  const parseHalf = (value: string): number[] | undefined => {
    if (value === '') return []
    const raw = value.split(':')
    const result: number[] = []
    for (let index = 0; index < raw.length; index += 1) {
      const part = raw[index]!
      if (part.includes('.')) {
        if (index !== raw.length - 1) return undefined
        const embedded = ipv4Bytes(part)
        if (embedded === undefined) return undefined
        result.push((embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3])
      } else {
        if (!/^[a-f0-9]{1,4}$/u.test(part)) return undefined
        result.push(Number.parseInt(part, 16))
      }
    }
    return result
  }
  const left = parseHalf(halves[0]!)
  const right = parseHalf(halves[1] ?? '')
  if (left === undefined || right === undefined) return undefined
  const omitted = 8 - left.length - right.length
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return undefined
  }
  const groups = halves.length === 1
    ? left
    : [...left, ...Array.from({ length: omitted }, () => 0), ...right]
  if (groups.length !== 8) return undefined
  const bytes = new Uint8Array(16)
  groups.forEach((group, index) => {
    bytes[index * 2] = group >>> 8
    bytes[index * 2 + 1] = group & 0xff
  })
  return bytes
}

function hasPrefix(value: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const bytes = Math.floor(bits / 8)
  for (let index = 0; index < bytes; index += 1) {
    if (value[index] !== prefix[index]) return false
  }
  const remaining = bits % 8
  if (remaining === 0) return true
  const mask = 0xff << (8 - remaining)
  return (value[bytes]! & mask) === (prefix[bytes]! & mask)
}

function globalIpv6(bytes: Uint8Array): boolean {
  const mapped = bytes.slice(12)
  if (bytes.slice(0, 10).every(value => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return globalIpv4(mapped)
  }
  if (bytes[0]! < 0x20 || bytes[0]! > 0x3f) return false
  if (
    hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x10], 28)
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28)
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48)
    || hasPrefix(bytes, [0x3f, 0xff, 0x00], 20)
  ) {
    return false
  }
  if (hasPrefix(bytes, [0x20, 0x02], 16)) {
    return globalIpv4(bytes.slice(2, 6))
  }
  const isatap = (bytes[8] === 0 || bytes[8] === 2)
    && bytes[9] === 0
    && bytes[10] === 0x5e
    && bytes[11] === 0xfe
  return !isatap || globalIpv4(mapped)
}

export function isGlobalPublicIp(address: string, allowIpv6 = false): boolean {
  const ipv4 = ipv4Bytes(address)
  if (ipv4 !== undefined) return globalIpv4(ipv4)
  const ipv6 = ipv6Bytes(address)
  if (ipv6 !== undefined) return allowIpv6 && globalIpv6(ipv6)
  return false
}

function validatedAddresses(
  resolved: readonly ResolvedAddress[],
  allowIpv6: boolean,
): readonly ValidatedAddress[] {
  if (resolved.length === 0 || resolved.length > MAX_DNS_ANSWERS) {
    throw new WebFetchError(
      'rejected-dns',
      `web-learning: DNS answer count (${resolved.length}) is outside [1, ${MAX_DNS_ANSWERS}]`,
    )
  }
  const seen = new Set<string>()
  const addresses: ValidatedAddress[] = []
  for (const item of resolved) {
    const ipv4 = ipv4Bytes(item.address)
    const ipv6 = ipv6Bytes(item.address)
    const family = ipv4 === undefined ? (ipv6 === undefined ? 0 : 6) : 4
    if (
      (family !== 4 && family !== 6)
      || family !== item.family
      || (ipv4 !== undefined ? !globalIpv4(ipv4) : ipv6 === undefined || !globalIpv6(ipv6))
    ) {
      throw new WebFetchError(
        'rejected-ssrf',
        `web-learning: host resolved to unsafe or invalid address (${item.address})`,
      )
    }
    if (family === 6 && !allowIpv6) {
      throw new WebFetchError(
        'rejected-ssrf',
        `web-learning: IPv6 address (${item.address}) is blocked unless allowIpv6 is enabled`,
      )
    }
    const key = `${family}:${Buffer.from(ipv4 ?? ipv6!).toString('hex')}`
    if (seen.has(key)) continue
    seen.add(key)
    addresses.push(Object.freeze({ address: item.address, family }))
  }
  return Object.freeze(addresses)
}

export async function defaultWebLookup(hostname: string): Promise<readonly ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof WebFetchError) return signal.reason
  if (signal.reason instanceof Error) return signal.reason
  return new WebFetchError('rejected-aborted', 'web-learning: request was aborted')
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal)
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const aborted = () => {
      cleanup()
      rejectPromise(abortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(
      value => {
        cleanup()
        resolvePromise(value)
      },
      error => {
        cleanup()
        rejectPromise(error)
      },
    )
  })
}

export async function resolveAndValidatePublicAddresses(
  hostname: string,
  options?: {
    readonly allowIpv6?: boolean
    readonly lookup?: WebLookup
    readonly signal?: AbortSignal
  },
): Promise<readonly ValidatedAddress[]> {
  const cleanHost = unbracketHost(hostname)
  if (isIP(cleanHost) !== 0 || cleanHost.includes(':')) {
    throw new WebFetchError('rejected-ip-literal', `web-learning: IP literal (${cleanHost}) cannot be resolved`)
  }
  if (isForbiddenHostname(cleanHost)) {
    throw new WebFetchError('rejected-forbidden-host', `web-learning: forbidden host (${cleanHost})`)
  }
  const lookup = options?.lookup ?? defaultWebLookup
  const resolving = lookup(cleanHost)
  const resolved = options?.signal
    ? await raceWithAbort(resolving, options.signal)
    : await resolving
  return validatedAddresses(resolved, options?.allowIpv6 ?? false)
}

export function assertReadOnlyRequestSafety(
  method?: string,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  if (method !== undefined && method.toUpperCase() !== 'GET') {
    throw new WebFetchError('rejected-method', `web-learning: HTTP method ${method} is forbidden; only GET is allowed`)
  }
  if (extraHeaders !== undefined) {
    for (const key of Object.keys(extraHeaders)) {
      const normalized = key.trim().toLowerCase()
      if (
        CREDENTIAL_HEADER_NAMES.has(normalized)
        || normalized.includes('auth')
        || normalized.includes('cookie')
        || normalized.includes('token')
        || normalized.includes('secret')
        || normalized.includes('password')
        || normalized.includes('credential')
      ) {
        throw new WebFetchError('rejected-header', `web-learning: credential header "${key}" is forbidden`)
      }
      if (!(normalized in READ_ONLY_WEB_HEADERS)) {
        throw new WebFetchError('rejected-header', `web-learning: non-allowlisted header "${key}" is forbidden`)
      }
    }
  }
}

function createPinnedHttpsFetcher(httpsRequestImpl: typeof nodeHttpsRequest): WebFetcher {
  return async (urlValue: string, init: RequestInit, route: ValidatedRoute): Promise<Response> => {
    const url = new URL(urlValue)
    const certificateHost = unbracketHost(url.hostname)
    const selected = route.addresses[0]
    if (selected === undefined) {
      throw new WebFetchError('rejected-ssrf', 'web-learning: validated route has no pinned address')
    }
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [selected])
      else callback(null, selected.address, selected.family)
    }
    return new Promise<Response>((resolveResponse, rejectResponse) => {
      const request = httpsRequestImpl(
        url,
        {
          agent: false,
          method: 'GET',
          headers: { ...READ_ONLY_WEB_HEADERS },
          lookup,
          servername: certificateHost,
          rejectUnauthorized: true,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        response => {
          try {
            const headers = new Headers()
            for (const [name, value] of Object.entries(response.headers)) {
              if (name.toLowerCase() === 'set-cookie') continue
              if (Array.isArray(value)) {
                for (const item of value) headers.append(name, item)
              } else if (value !== undefined) {
                headers.set(name, value)
              }
            }
            const status = response.statusCode ?? 500
            const hasNullBody = status === 204 || status === 205 || status === 304
            const body = hasNullBody ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>)
            if (hasNullBody) response.destroy()
            resolveResponse(new Response(body, { status, headers }))
          } catch (error) {
            response.destroy()
            rejectResponse(error)
          }
        },
      )
      request.once('error', error => {
        if (init.signal?.aborted) {
          rejectResponse(abortError(init.signal))
          return
        }
        rejectResponse(error)
      })
      request.end()
    })
  }
}

async function cancelBody(response: Response, signal: AbortSignal): Promise<void> {
  if (response.body === null) return
  try {
    await raceWithAbort(response.body.cancel(), signal)
  } catch {
    // Ignore uncooperative cancel failures; caller already rejects.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {})
  } catch {
    // Ignore synchronous cancel error.
  }
}

async function boundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && declared.trim() !== '') {
    const parsedLength = Number(declared)
    if (Number.isFinite(parsedLength) && parsedLength > maximum) {
      await cancelBody(response, signal)
      throw new WebFetchError(
        'rejected-size',
        `web-learning: declared Content-Length (${parsedLength}) exceeds cap (${maximum})`,
      )
    }
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    let chunkResult: Awaited<ReturnType<typeof reader.read>>
    try {
      chunkResult = await raceWithAbort(reader.read(), signal)
    } catch (error) {
      cancelReader(reader)
      throw error
    }
    if (chunkResult.done) break
    total += chunkResult.value.byteLength
    if (total > maximum) {
      cancelReader(reader)
      throw new WebFetchError(
        'rejected-size',
        `web-learning: response body exceeded byte cap (${maximum})`,
      )
    }
    chunks.push(Buffer.from(chunkResult.value))
  }
  return Buffer.concat(chunks, total)
}

function parseMimeEssence(contentTypeHeader: string | null): string {
  if (contentTypeHeader === null) return ''
  const essence = contentTypeHeader.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return essence
}

function decodeBodyText(buffer: Buffer, contentTypeHeader: string | null): string {
  const match = contentTypeHeader?.match(/;\s*charset\s*=\s*"?([a-zA-Z0-9._-]+)"?/iu)
  const charset = match?.[1]?.toLowerCase()
  if (charset === 'utf-8' || charset === 'utf8' || charset === undefined) {
    return buffer.toString('utf8')
  }
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

function mapRedirectValidationError(error: unknown, nextUrl: string): WebFetchError {
  if (error instanceof WebFetchError) {
    if (error.code === 'rejected-ip-literal' || error.code === 'rejected-forbidden-host' || error.code === 'rejected-ssrf') {
      return new WebFetchError('rejected-ssrf', `web-learning: redirect target blocked by SSRF policy (${nextUrl})`, { cause: error })
    }
    return new WebFetchError('rejected-redirect', `web-learning: redirect target rejected (${error.code})`, { cause: error })
  }
  return new WebFetchError('rejected-redirect', `web-learning: redirect target rejected (${nextUrl})`, { cause: error })
}

export async function fetchWebPageReadOnly(
  input: FetchWebPageInput,
  deps?: WebFetchDeps,
): Promise<FetchWebPageResult> {
  assertReadOnlyRequestSafety(input.method, input.extraHeaders)
  if (!Number.isInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new WebFetchError('rejected-size', 'web-learning: maxBytes must be a positive integer')
  }
  if (!Number.isFinite(input.requestTimeoutMs) || input.requestTimeoutMs <= 0) {
    throw new WebFetchError('rejected-timeout', 'web-learning: requestTimeoutMs must be positive')
  }

  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new WebFetchError('rejected-redirect', 'web-learning: maxRedirects must be a non-negative integer')
  }

  const now = deps?.now ?? Date.now
  const fetcher = deps?.fetcher ?? createPinnedHttpsFetcher(deps?.httpsRequest ?? nodeHttpsRequest)

  const controller = new AbortController()
  const forwardAbort = () => {
    const reason = input.signal?.reason
    controller.abort(
      reason instanceof WebFetchError
        ? reason
        : new WebFetchError('rejected-aborted', 'web-learning: fetch aborted by caller', { cause: reason }),
    )
  }
  if (input.signal?.aborted) {
    forwardAbort()
  } else {
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
  }

  const timer = setTimeout(() => {
    controller.abort(new WebFetchError('rejected-timeout', `web-learning: request timed out after ${input.requestTimeoutMs}ms`))
  }, input.requestTimeoutMs)
  timer.unref?.()

  let currentUrl = input.url
  let initialCanonicalUrl: string | undefined
  const redirectChain: string[] = []
  let requestsUsed = 0

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      let validated: ValidatedWebUrl
      try {
        validated = validateWhitelistedWebUrl(currentUrl, {
          allowedDomains: input.allowedDomains,
          ...(input.allowSubdomains === undefined ? {} : { allowSubdomains: input.allowSubdomains }),
        })
      } catch (error) {
        if (hop > 0) throw mapRedirectValidationError(error, currentUrl)
        throw error
      }
      if (initialCanonicalUrl === undefined) {
        initialCanonicalUrl = validated.canonicalUrl
      }

      let addresses: readonly ValidatedAddress[]
      try {
        addresses = await resolveAndValidatePublicAddresses(validated.hostname, {
          ...(input.allowIpv6 === undefined ? {} : { allowIpv6: input.allowIpv6 }),
          ...(deps?.lookup === undefined ? {} : { lookup: deps.lookup }),
          signal: controller.signal,
        })
      } catch (error) {
        if (hop > 0) throw mapRedirectValidationError(error, validated.canonicalUrl)
        throw error
      }

      if (controller.signal.aborted) {
        throw abortError(controller.signal)
      }

      input.onBeforeRequest?.(validated.canonicalUrl, hop)
      requestsUsed += 1

      const response = await raceWithAbort(
        fetcher(
          validated.canonicalUrl,
          {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: { ...READ_ONLY_WEB_HEADERS },
          },
          { addresses },
        ),
        controller.signal,
      )

      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response, controller.signal)
        if (hop >= maxRedirects) {
          throw new WebFetchError(
            'rejected-redirect',
            `web-learning: redirect count exceeded maxRedirects (${maxRedirects})`,
          )
        }
        const location = response.headers.get('location')
        if (location === null || location.trim() === '') {
          throw new WebFetchError('rejected-redirect', 'web-learning: redirect response missing Location header')
        }
        let resolvedNext: URL
        try {
          resolvedNext = new URL(location, validated.canonicalUrl)
        } catch (error) {
          throw new WebFetchError('rejected-redirect', 'web-learning: invalid redirect Location URL', { cause: error })
        }
        redirectChain.push(validated.canonicalUrl)
        currentUrl = resolvedNext.toString()
        continue
      }

      if (!response.ok) {
        await cancelBody(response, controller.signal)
        throw new WebFetchError(
          'rejected-http-status',
          `web-learning: HTTP status ${response.status} rejected`,
        )
      }

      const rawContentType = response.headers.get('content-type')
      const mimeEssence = parseMimeEssence(rawContentType)
      if (!ALLOWED_WEB_MIME_TYPES.has(mimeEssence)) {
        await cancelBody(response, controller.signal)
        throw new WebFetchError(
          'rejected-content-type',
          `web-learning: MIME type "${mimeEssence || 'missing'}" is not allowlisted`,
        )
      }

      const bodyBuffer = await boundedBody(response, input.maxBytes, controller.signal)
      const bodyText = decodeBodyText(bodyBuffer, rawContentType)
      return {
        sourceUrl: initialCanonicalUrl,
        finalUrl: validated.canonicalUrl,
        status: response.status,
        contentType: mimeEssence,
        bytesFetched: bodyBuffer.byteLength,
        bodyBuffer,
        bodyText,
        requestsUsed,
        redirectChain: Object.freeze([...redirectChain]),
        fetchedAt: now(),
      }
    }

    throw new WebFetchError('rejected-redirect', `web-learning: redirect count exceeded maxRedirects (${maxRedirects})`)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', forwardAbort)
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d{1,7});/gu, (_full, dec: string) => {
      const code = Number.parseInt(dec, 10)
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return ''
      if (code < 0x20 && code !== 0x09 && code !== 0x0a) return ' '
      return String.fromCodePoint(code)
    })
    .replace(/&#x([0-9a-fA-F]{1,6});/gu, (_full, hex: string) => {
      const code = Number.parseInt(hex, 16)
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return ''
      if (code < 0x20 && code !== 0x09 && code !== 0x0a) return ' '
      return String.fromCodePoint(code)
    })
    .replace(/&nbsp;/giu, ' ')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, '\'')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&')
}

function stripControlChars(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) {
      out += input[i]!
    }
  }
  return out
}

function normalizeWhitespace(input: string): string {
  return stripControlChars(input.replace(/\r\n?/gu, '\n'))
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function truncateChars(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input
  const chars = [...input]
  if (chars.length <= maxChars) return input
  return chars.slice(0, maxChars).join('')
}

function extractSameWhitelistLinks(
  rawHtml: string,
  options: ExtractHtmlTextOptions,
): readonly string[] {
  if (
    options.baseUrl === undefined
    || options.allowedDomains === undefined
    || options.allowedDomains.length === 0
  ) {
    return []
  }
  const maxLinks = options.maxLinks ?? DEFAULT_MAX_EXTRACTED_LINKS
  if (maxLinks <= 0) return []

  const results: string[] = []
  const seen = new Set<string>()
  const hrefPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu
  let match: RegExpExecArray | null
  while ((match = hrefPattern.exec(rawHtml)) !== null) {
    if (results.length >= maxLinks) break
    const rawHref = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (rawHref === '' || rawHref.startsWith('#')) continue
    const decodedHref = decodeHtmlEntities(rawHref)
    let resolvedUrl: string
    try {
      resolvedUrl = new URL(decodedHref, options.baseUrl).toString()
    } catch {
      continue
    }
    try {
      const validated = validateWhitelistedWebUrl(resolvedUrl, {
        allowedDomains: options.allowedDomains,
        ...(options.allowSubdomains === undefined ? {} : { allowSubdomains: options.allowSubdomains }),
      })
      if (!seen.has(validated.canonicalUrl)) {
        seen.add(validated.canonicalUrl)
        results.push(validated.canonicalUrl)
      }
    } catch {
      // Ignore off-whitelist, non-https, or unsafe links.
    }
  }
  return Object.freeze(results)
}

function stripCommentsAndRawBlocks(raw: string): string {
  let cleaned = raw
  let previous = ''
  while (cleaned !== previous) {
    previous = cleaned
    cleaned = cleaned
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/giu, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/giu, '')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\b[^>]*>/giu, '')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\b[^>]*>/giu, '')
  }
  return cleaned
    .replace(/<!--[\s\S]*$/gu, ' ')
    .replace(/<(?:script|style|noscript|svg)\b[^>]*>[\s\S]*$/giu, '')
}

function stripRemainingHtmlTags(sanitizedHtml: string): string {
  const cleaned = sanitizedHtml
    .replace(/<\/?(?:p|div|li|br|hr|tr|h[1-6]|article|section|header|footer|main|blockquote|pre)\b[^>]*>/giu, '\n')
    .replace(/<\/?[a-zA-Z!?][^<>]*>/gu, ' ')
  return normalizeWhitespace(decodeHtmlEntities(cleaned))
}

function stripRawTagsForText(raw: string): string {
  return stripRemainingHtmlTags(stripCommentsAndRawBlocks(raw))
}

export function extractPlainTextFromHtml(
  rawContent: string,
  options?: ExtractHtmlTextOptions,
): ExtractedWebContent {
  const maxTextChars = options?.maxTextChars ?? DEFAULT_MAX_HTML_TEXT_CHARS
  const maxTitleChars = options?.maxTitleChars ?? DEFAULT_MAX_TITLE_CHARS
  const contentType = options?.contentType?.toLowerCase() ?? 'text/html'

  if (contentType === 'text/plain' || contentType === 'text/markdown') {
    const normalized = truncateChars(normalizeWhitespace(rawContent), maxTextChars)
    const firstLine = normalized.split('\n', 1)[0]?.replace(/^#+\s*/u, '').trim() ?? ''
    return {
      title: truncateChars(firstLine, maxTitleChars),
      text: normalized,
      links: [],
    }
  }

  if (contentType === 'application/json') {
    let text = normalizeWhitespace(rawContent)
    try {
      const parsed = JSON.parse(rawContent) as unknown
      text = normalizeWhitespace(JSON.stringify(parsed))
    } catch {
      // Preserve raw normalized text if JSON parsing fails.
    }
    return {
      title: '',
      text: truncateChars(text, maxTextChars),
      links: [],
    }
  }

  const sanitizedHtml = stripCommentsAndRawBlocks(rawContent)
  const titleMatch = sanitizedHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title\b[^>]*>/iu)
  const h1Match = sanitizedHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\b[^>]*>/iu)
  const rawTitle = titleMatch?.[1] ?? h1Match?.[1] ?? ''
  const title = truncateChars(stripRawTagsForText(rawTitle).replace(/\n+/gu, ' '), maxTitleChars)
  const links = extractSameWhitelistLinks(sanitizedHtml, options ?? {})
  const text = truncateChars(stripRemainingHtmlTags(sanitizedHtml), maxTextChars)
  return {
    title,
    text,
    links,
  }
}

export function sanitizeWebLearningEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const key of ALLOWED_WEB_LEARNING_ENV_KEYS) {
    const value = sourceEnv[key]
    if (typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\r') && !value.includes('\n')) {
      sanitized[key] = value
    }
  }
  return sanitized
}

export function assertReadOnlyWebToolSurface(
  toolNames: readonly string[],
  allowedTools: ReadonlySet<string> = ALLOWED_WEB_LEARNING_TOOLS,
): void {
  for (const rawName of toolNames) {
    const normalized = rawName.trim().toLowerCase()
    if (normalized === '') {
      throw new Error('web-learning: empty tool name is forbidden in read-only tool surface')
    }
    if (
      FORBIDDEN_WEB_LEARNING_TOOLS.has(normalized)
      || FORBIDDEN_TOOL_PREFIXES.some(prefix => normalized.startsWith(prefix))
      || !allowedTools.has(normalized)
    ) {
      throw new Error(`web-learning: tool "${rawName}" is forbidden in isolated read-only surface`)
    }
  }
}
