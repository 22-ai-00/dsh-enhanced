import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'

export interface SensorObservation {
  fingerprint: string
  truthy: boolean
}

export interface ResolvedAddress { address: string; family: number }
export interface ValidatedRoute { addresses: readonly Readonly<{ address: string; family: 4 | 6 }>[] }
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>
export type Fetcher = (url: string, init: RequestInit, route: ValidatedRoute) => Promise<Response>

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

export async function readFileObservation(input: {
  path: string
  roots: readonly string[]
  mode: 'content-hash' | 'exists'
  maxBytes: number
  beforeOpen?: () => Promise<void>
}): Promise<SensorObservation> {
  const target = resolve(input.path)
  if (!input.roots.some(root => inside(target, resolve(root)))) throw new Error('event-triggers: file path is outside allowlist')
  let metadata
  try { metadata = await lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { fingerprint: 'missing', truthy: false }
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('event-triggers: watched path must be a regular non-symlink file')
  const actual = await realpath(target)
  const allowed = await Promise.all(input.roots.map(async root => {
    try { return inside(actual, await realpath(root)) } catch { return false }
  }))
  if (!allowed.some(Boolean)) throw new Error('event-triggers: watched file escapes its realpath allowlist')
  await input.beforeOpen?.()
  let descriptor
  try {
    descriptor = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new Error('event-triggers: watched path became a symlink')
    if (code === 'ENOENT') return { fingerprint: 'missing', truthy: false }
    throw error
  }
  try {
    const current = await descriptor.stat()
    if (!current.isFile()) throw new Error('event-triggers: watched path must remain a regular file')
    if (input.mode === 'exists') return { fingerprint: 'exists', truthy: true }
    if (current.size > input.maxBytes) throw new Error('event-triggers: watched file exceeds maxBodyBytes')
    const content = await descriptor.readFile()
    if (content.byteLength > input.maxBytes) throw new Error('event-triggers: watched file exceeds maxBodyBytes')
    return { fingerprint: `sha256:${hash(content)}`, truthy: true }
  } finally {
    await descriptor.close()
  }
}

function unsafeIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
}

function unsafeAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]!
  const family = isIP(normalized)
  if (family === 4) return unsafeIpv4(normalized)
  if (family !== 6) return true
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/u.test(normalized)) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1]
  return mapped === undefined ? false : unsafeIpv4(mapped)
}

async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maximum) throw new Error('event-triggers: HTTP body exceeds limit')
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const value = await reader.read()
    if (value.done) break
    total += value.value.byteLength
    if (total > maximum) { await reader.cancel(); throw new Error('event-triggers: HTTP body exceeds limit') }
    chunks.push(Buffer.from(value.value))
  }
  return Buffer.concat(chunks, total)
}

function pointer(document: unknown, value: string): unknown {
  if (value === '') return document
  let current = document
  for (const raw of value.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (typeof current !== 'object' || current === null || !(key in current)) {
      throw new Error('event-triggers: JSON pointer does not exist')
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

async function pinnedHttpsFetch(urlValue: string, init: RequestInit, route: ValidatedRoute): Promise<Response> {
  const url = new URL(urlValue)
  const selected = route.addresses[0]
  if (selected === undefined) throw new Error('event-triggers: HTTP route has no validated address')
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [selected])
    else callback(null, selected.address, selected.family)
  }
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    const request = httpsRequest(url, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      lookup,
      servername: url.hostname,
      signal: init.signal ?? undefined,
    }, (response) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item)
        else if (value !== undefined) headers.set(name, value)
      }
      const status = response.statusCode ?? 500
      const body = status === 204 || status === 304
        ? null
        : Readable.toWeb(response) as ReadableStream<Uint8Array>
      resolveResponse(new Response(body, { status, headers }))
    })
    request.once('error', rejectResponse)
    request.end()
  })
}

export async function readHttpJsonObservation(input: {
  url: string
  pointer: string
  maxBodyBytes: number
  timeoutMs: number
  allowedHosts: ReadonlySet<string>
  fetcher?: Fetcher
  lookup?: Lookup
}): Promise<SensorObservation> {
  const url = new URL(input.url)
  if (url.protocol !== 'https:') throw new Error('event-triggers: HTTP sensor requires HTTPS')
  if (url.username !== '' || url.password !== '' || !input.allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error('event-triggers: HTTP sensor host is not allowlisted')
  }
  const resolved = await (input.lookup ?? defaultLookup)(url.hostname)
  if (resolved.length === 0 || resolved.some(item => unsafeAddress(item.address))) {
    throw new Error('event-triggers: HTTP host resolved to an unsafe address')
  }
  const addresses = resolved.map((item) => {
    const family = isIP(item.address.toLowerCase().split('%')[0]!)
    if ((family !== 4 && family !== 6) || family !== item.family) {
      throw new Error('event-triggers: HTTP resolver returned an invalid address family')
    }
    return Object.freeze({ address: item.address, family })
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('HTTP sensor timeout')), input.timeoutMs)
  timer.unref?.()
  try {
    const response = await (input.fetcher ?? pinnedHttpsFetch)(url.toString(), {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { accept: 'application/json' },
    }, { addresses })
    if (response.status >= 300 && response.status < 400) throw new Error('event-triggers: HTTP redirects are not allowed')
    if (!response.ok) throw new Error(`event-triggers: HTTP sensor returned ${response.status}`)
    const body = await boundedBody(response, input.maxBodyBytes)
    let document: unknown
    try { document = JSON.parse(body.toString('utf8')) } catch { throw new Error('event-triggers: HTTP body is not valid JSON') }
    const selected = pointer(document, input.pointer)
    const serialized = JSON.stringify(selected)
    if (serialized === undefined) throw new Error('event-triggers: JSON pointer selected an unsupported value')
    return { fingerprint: `sha256:${hash(serialized)}`, truthy: Boolean(selected) }
  } finally {
    clearTimeout(timer)
  }
}
