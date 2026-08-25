import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { constants, lstatSync, realpathSync, statSync } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'

export interface SensorObservation {
  fingerprint: string
  truthy: boolean
}

export interface PinnedFileRoot {
  configuredPath: string
  realPath: string
  configuredDevice: bigint
  configuredInode: bigint
  physicalDevice: bigint
  physicalInode: bigint
}

export interface ResolvedAddress { address: string; family: number }
export interface ValidatedRoute { addresses: readonly Readonly<{ address: string; family: 4 | 6 }>[] }
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>
export type Fetcher = (url: string, init: RequestInit, route: ValidatedRoute) => Promise<Response>
export type OperationTracker = <T>(operation: Promise<T>) => Promise<T>

const MAX_DNS_ANSWERS = 16

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function hostname(url: URL): string {
  const value = url.hostname
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

export function pinFileRoots(roots: readonly string[]): readonly PinnedFileRoot[] {
  return Object.freeze(roots.map(root => {
    const configuredPath = resolve(root)
    try {
      const configured = lstatSync(configuredPath, { bigint: true })
      const realPath = realpathSync(configuredPath)
      const physical = statSync(configuredPath, { bigint: true })
      if (!physical.isDirectory()) throw new Error('allowed file root is not a directory')
      return Object.freeze({
        configuredPath,
        realPath,
        configuredDevice: configured.dev,
        configuredInode: configured.ino,
        physicalDevice: physical.dev,
        physicalInode: physical.ino,
      })
    } catch (error) {
      throw new Error(`event-triggers: allowed file root cannot be pinned: ${configuredPath}`, { cause: error })
    }
  }))
}

async function verifiedFileRoots(target: string, pins: readonly PinnedFileRoot[]): Promise<string[]> {
  const candidates = pins.filter(pin => inside(target, pin.configuredPath))
  if (candidates.length === 0) throw new Error('event-triggers: file path is outside pinned allowlist roots')
  const verified = await Promise.all(candidates.map(async pin => {
    try {
      const [configured, realPath, physical] = await Promise.all([
        lstat(pin.configuredPath, { bigint: true }),
        realpath(pin.configuredPath),
        stat(pin.configuredPath, { bigint: true }),
      ])
      if (!physical.isDirectory() || realPath !== pin.realPath
        || configured.dev !== pin.configuredDevice || configured.ino !== pin.configuredInode
        || physical.dev !== pin.physicalDevice || physical.ino !== pin.physicalInode) return undefined
      return pin.realPath
    } catch {
      return undefined
    }
  }))
  const roots = verified.filter(root => root !== undefined)
  if (roots.length === 0) throw new Error('event-triggers: allowed file root changed after initialization')
  return roots
}

export async function readFileObservation(input: {
  path: string
  roots: readonly string[]
  mode: 'content-hash' | 'exists'
  maxBytes: number
  pinnedRoots?: readonly PinnedFileRoot[]
  beforeOpen?: () => Promise<void>
}): Promise<SensorObservation> {
  const target = resolve(input.path)
  if (!input.roots.some(root => inside(target, resolve(root)))) throw new Error('event-triggers: file path is outside allowlist')
  const pins = input.pinnedRoots ?? pinFileRoots(input.roots)
  const allowedRoots = await verifiedFileRoots(target, pins)
  let metadata
  try { metadata = await lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { fingerprint: 'missing', truthy: false }
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('event-triggers: watched path must be a regular non-symlink file')
  const actual = await realpath(target)
  if (!allowedRoots.some(root => inside(actual, root))) {
    throw new Error('event-triggers: watched file escapes its realpath allowlist')
  }
  await input.beforeOpen?.()
  let descriptor
  try {
    descriptor = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new Error('event-triggers: watched path became a symlink')
    if (code === 'ENOENT') return { fingerprint: 'missing', truthy: false }
    throw error
  }
  try {
    const current = await descriptor.stat()
    if (!current.isFile()) throw new Error('event-triggers: watched path must remain a regular file')
    let currentPath
    let currentActual: string
    try {
      currentPath = await lstat(target)
      currentActual = await realpath(target)
    } catch {
      throw new Error('event-triggers: watched path changed while it was being opened')
    }
    const currentAllowedRoots = await verifiedFileRoots(target, pins)
    if (currentPath.isSymbolicLink() || !currentPath.isFile()
      || !currentAllowedRoots.some(root => inside(currentActual, root))
      || currentPath.dev !== current.dev || currentPath.ino !== current.ino) {
      throw new Error('event-triggers: watched path changed or escaped its realpath allowlist')
    }
    if (input.mode === 'exists') return { fingerprint: 'exists', truthy: true }
    if (current.size > input.maxBytes) throw new Error('event-triggers: watched file exceeds maxBodyBytes')
    const content = await descriptor.readFile()
    if (content.byteLength > input.maxBytes) throw new Error('event-triggers: watched file exceeds maxBodyBytes')
    return { fingerprint: `sha256:${hash(content)}`, truthy: true }
  } finally {
    await descriptor.close()
  }
}

function ipv4Bytes(address: string): [number, number, number, number] | undefined {
  if (isIP(address) !== 4) return undefined
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
  return parts as [number, number, number, number]
}

function globalIpv4(parts: ArrayLike<number>): boolean {
  const [a, b, c] = parts as [number, number, number, number]
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113))
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
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return undefined
  const groups = halves.length === 1 ? left : [...left, ...Array.from({ length: omitted }, () => 0), ...right]
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
  for (let index = 0; index < bytes; index += 1) if (value[index] !== prefix[index]) return false
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
  // IPv4-compatible, translated, NAT64 and all non-current global-unicast space fail closed.
  if (bytes[0]! < 0x20 || bytes[0]! > 0x3f) return false
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x10], 28)
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28)
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48)
    || hasPrefix(bytes, [0x3f, 0xff, 0x00], 20)) return false
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return globalIpv4(bytes.slice(2, 6))
  const isatap = (bytes[8] === 0 || bytes[8] === 2) && bytes[9] === 0 && bytes[10] === 0x5e && bytes[11] === 0xfe
  return !isatap || globalIpv4(mapped)
}

function validatedAddresses(
  resolved: readonly ResolvedAddress[],
  allowIpv6: boolean,
): Array<{ address: string; family: 4 | 6 }> {
  if (resolved.length === 0 || resolved.length > MAX_DNS_ANSWERS) {
    throw new Error('event-triggers: HTTP DNS answer count is outside the accepted bound')
  }
  const seen = new Set<string>()
  const addresses: Array<{ address: string; family: 4 | 6 }> = []
  for (const item of resolved) {
    const ipv4 = ipv4Bytes(item.address)
    const ipv6 = ipv6Bytes(item.address)
    const family = ipv4 === undefined ? (ipv6 === undefined ? 0 : 6) : 4
    if ((family !== 4 && family !== 6) || family !== item.family
      || (ipv4 !== undefined ? !globalIpv4(ipv4) : ipv6 === undefined || !globalIpv6(ipv6))) {
      throw new Error('event-triggers: HTTP host resolved to an unsafe or invalid address')
    }
    if (family === 6 && !allowIpv6) {
      throw new Error('event-triggers: HTTP IPv6 address is unsafe without an explicit native-only network assertion')
    }
    const key = `${family}:${Buffer.from(ipv4 ?? ipv6!).toString('hex')}`
    if (seen.has(key)) continue
    seen.add(key)
    addresses.push(Object.freeze({ address: item.address, family }))
  }
  return addresses
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('event-triggers: HTTP sensor was aborted')
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal)
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const aborted = () => { cleanup(); rejectPromise(abortError(signal)) }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(
      value => { cleanup(); resolvePromise(value) },
      error => { cleanup(); rejectPromise(error) },
    )
  })
}

function tracked<T>(operation: Promise<T>, tracker?: OperationTracker): Promise<T> {
  return tracker?.(operation) ?? operation
}

async function cancelBody(response: Response, signal: AbortSignal, tracker?: OperationTracker): Promise<void> {
  if (response.body === null) return
  try { await raceWithAbort(tracked(response.body.cancel(), tracker), signal) } catch {}
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  tracker?: OperationTracker,
): void {
  try { void tracked(reader.cancel(), tracker).catch(() => {}) } catch {}
}

async function boundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  tracker?: OperationTracker,
): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maximum) {
    await cancelBody(response, signal, tracker)
    throw new Error('event-triggers: HTTP body exceeds limit')
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const reading = tracked(reader.read(), tracker)
    let value: Awaited<typeof reading>
    try { value = await raceWithAbort(reading, signal) } catch (error) {
      cancelReader(reader, tracker)
      throw error
    }
    if (value.done) break
    total += value.value.byteLength
    if (total > maximum) {
      cancelReader(reader, tracker)
      throw new Error('event-triggers: HTTP body exceeds limit')
    }
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
  const certificateHost = hostname(url)
  const selected = route.addresses[0]
  if (selected === undefined) throw new Error('event-triggers: HTTP route has no validated address')
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [selected])
    else callback(null, selected.address, selected.family)
  }
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    const request = httpsRequest(url, {
      agent: false,
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      lookup,
      ...(isIP(certificateHost) === 0 ? { servername: certificateHost } : {}),
      signal: init.signal ?? undefined,
    }, (response) => {
      try {
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item)
          else if (value !== undefined) headers.set(name, value)
        }
        const status = response.statusCode ?? 500
        const hasNullBody = status === 204 || status === 205 || status === 304
        const body = hasNullBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>
        if (hasNullBody) response.destroy()
        resolveResponse(new Response(body, { status, headers }))
      } catch (error) {
        response.destroy()
        rejectResponse(error)
      }
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
  allowedHosts?: ReadonlySet<string>
  allowedOrigins?: ReadonlySet<string>
  allowIpv6?: boolean
  fetcher?: Fetcher
  lookup?: Lookup
  trackOperation?: OperationTracker
  signal?: AbortSignal
}): Promise<SensorObservation> {
  const url = new URL(input.url)
  if (url.protocol !== 'https:') throw new Error('event-triggers: HTTP sensor requires HTTPS')
  const legacyAllowed = (url.port === '' || url.port === '443')
    && (input.allowedHosts?.has(url.hostname.toLowerCase()) ?? false)
  if (url.username !== '' || url.password !== '' || (!legacyAllowed && !(input.allowedOrigins?.has(url.origin) ?? false))) {
    throw new Error('event-triggers: HTTP sensor host/origin is not allowlisted')
  }
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(input.signal?.reason ?? new Error('event-triggers: HTTP sensor was aborted'))
  if (input.signal?.aborted) forwardAbort()
  else input.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('event-triggers: HTTP sensor timeout')), input.timeoutMs)
  timer.unref?.()
  try {
    const address = hostname(url)
    const family = isIP(address)
    const resolving = family === 0
      ? (input.lookup ?? defaultLookup)(address)
      : Promise.resolve([{ address, family }])
    const resolved = await raceWithAbort(tracked(resolving, input.trackOperation), controller.signal)
    const addresses = validatedAddresses(resolved, input.allowIpv6 ?? false)
    const fetching = (input.fetcher ?? pinnedHttpsFetch)(url.toString(), {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { accept: 'application/json' },
    }, { addresses })
    const response = await raceWithAbort(tracked(fetching, input.trackOperation), controller.signal)
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response, controller.signal, input.trackOperation)
      throw new Error('event-triggers: HTTP redirects are not allowed')
    }
    if (!response.ok) {
      await cancelBody(response, controller.signal, input.trackOperation)
      throw new Error(`event-triggers: HTTP sensor returned ${response.status}`)
    }
    const body = await boundedBody(response, input.maxBodyBytes, controller.signal, input.trackOperation)
    let document: unknown
    try { document = JSON.parse(body.toString('utf8')) } catch { throw new Error('event-triggers: HTTP body is not valid JSON') }
    const selected = pointer(document, input.pointer)
    const serialized = JSON.stringify(selected)
    if (serialized === undefined) throw new Error('event-triggers: JSON pointer selected an unsupported value')
    return { fingerprint: `sha256:${hash(serialized)}`, truthy: Boolean(selected) }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', forwardAbort)
  }
}
