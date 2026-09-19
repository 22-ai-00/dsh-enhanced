import { createHash } from 'node:crypto'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { isIP, type AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { request as httpsRequest, createServer as createHttpsServer, type Server as HttpsServer, type RequestOptions } from 'node:https'

export class RegistryFetchError extends Error {
  constructor(message: string) { super(message); this.name = 'RegistryFetchError' }
}

export interface RegistryBinding {
  id: string
  locator: string
  protocol?: 'dsh' | 'npm'
  caPins: readonly string[]
  tokenEnvironment: string | null
}

export interface FetchedRegistryArtifact {
  bytes: Buffer
  mediaType: string | null
  reference: string
}

const artifactLimit = 268_435_456
const metadataLimit = 2_097_152
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const sriPattern = /^sha512-([A-Za-z0-9+/]{86}==)$/u

function error(message: string): never { throw new RegistryFetchError(message) }

function bareHttps(value: string, label: string): URL {
  if (/[\\?#]/u.test(value) || [...value].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
    error(`${label} must be a bare https URL without credentials or query`)
  }
  let url: URL
  try { url = new URL(value) } catch { return error(`${label} is invalid`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') error(`${label} must be a bare https URL without credentials or query`)
  // Reject nested escapes as well as encoded separators before any server
  // decoding can move a credential-bearing request outside the bound path.
  if (/%(?:2e|2f|5c|25)|%(?![a-f0-9]{2})/iu.test(value)) error(`${label} path is ambiguous`)
  return url
}

// Assigning pathname cannot reinterpret a double-slash base as a new origin.
function atPath(base: URL, path: string): URL {
  const target = new URL(base)
  target.pathname = path
  return target
}

function expectedSri(value: string | undefined): Buffer {
  if (typeof value !== 'string') error('npm registry requires canonical sha512 integrity')
  const match = sriPattern.exec(value)
  if (!match) error('npm registry requires canonical sha512 integrity')
  const encoded = match[1]!
  const result = Buffer.from(encoded, 'base64')
  if (result.length !== 64 || result.toString('base64') !== encoded) error('npm registry requires canonical sha512 integrity')
  return result
}

function options(base: URL, binding: RegistryBinding, environment: NodeJS.ProcessEnv): { headers: Record<string, string>; tls: RequestOptions } {
  const headers: Record<string, string> = { accept: 'application/json, application/gzip, application/octet-stream', 'accept-encoding': 'identity' }
  if (binding.tokenEnvironment !== null) {
    const token = environment[binding.tokenEnvironment]
    if (typeof token !== 'string' || token.trim() === '' || /[^\x21-\x7e]/u.test(token)) error('bound registry token environment variable is missing or invalid')
    headers.authorization = `Bearer ${token}`
  }
  return { headers, tls: binding.caPins.length ? { ca: [...binding.caPins], rejectUnauthorized: true, ...(isIP(base.hostname) === 0 ? { servername: base.hostname } : {}) } : {} }
}

function assertLive(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) error('registry request aborted')
  if (performance.now() >= deadline) error('registry request timed out')
}

// Own both sides of the HTTP stream. One absolute deadline bounds DNS, TLS,
// headers and drip-fed bodies; rejected operations destroy the connection.
async function fetchOne(url: URL, binding: RegistryBinding, environment: NodeJS.ProcessEnv, limit: number,
  deadline: number, signal?: AbortSignal): Promise<FetchedRegistryArtifact> {
  assertLive(deadline, signal)
  const setup = options(url, binding, environment)
  return await new Promise<FetchedRegistryArtifact>((resolve, reject) => {
    let settled = false
    let req: ClientRequest | undefined
    let response: IncomingMessage | undefined
    const finish = (reason?: Error, value?: FetchedRegistryArtifact): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (reason !== undefined) {
        response?.destroy()
        req?.destroy()
        reject(reason)
      } else resolve(value!)
    }
    const abort = (): void => finish(new RegistryFetchError('registry request aborted'))
    const timer = setTimeout(() => finish(new RegistryFetchError('registry request timed out')), Math.max(1, deadline - performance.now()))
    try {
      req = httpsRequest(url, { method: 'GET', headers: setup.headers, agent: false, rejectUnauthorized: true, ...setup.tls }, incoming => {
        response = incoming
        incoming.on('error', () => finish(new RegistryFetchError('registry response failed')))
        incoming.on('aborted', () => finish(new RegistryFetchError('registry response ended prematurely')))
        if (settled) { incoming.destroy(); return }
        const status = incoming.statusCode ?? 0
        if (status !== 200) { finish(new RegistryFetchError(`registry answered ${status}`)); return }
        const encoding = incoming.headers['content-encoding']
        if (encoding !== undefined && encoding !== 'identity') {
          finish(new RegistryFetchError('registry response content encoding is unsupported')); return
        }
        const length = incoming.headers['content-length']
        if (length !== undefined && (!/^\d{1,10}$/u.test(length) || Number(length) > limit)) {
          finish(new RegistryFetchError('registry response length is invalid or exceeds the bound')); return
        }
        let size = 0
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          if (size > limit) finish(new RegistryFetchError('registry response exceeds the bounded size'))
          else chunks.push(chunk)
        })
        incoming.on('end', () => {
          if (settled) return
          try { assertLive(deadline, signal) } catch (reason) { finish(reason as Error); return }
          if (length !== undefined && size !== Number(length)) finish(new RegistryFetchError('registry response length changed during transfer'))
          else if (size === 0) finish(new RegistryFetchError('registry response is empty'))
          else finish(undefined, { bytes: Buffer.concat(chunks, size),
            mediaType: typeof incoming.headers['content-type'] === 'string' ? incoming.headers['content-type'] : null,
            reference: url.href })
        })
      })
      req.on('error', raw => {
        const code = String((raw as NodeJS.ErrnoException).code ?? '')
        finish(new RegistryFetchError(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/u.test(code)
          ? 'registry TLS certificate is not pinned by the owner trust root' : 'registry fetch failed'))
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else req.end()
    } catch { finish(new RegistryFetchError('registry request could not be started')) }
  })
}

function tarball(metadata: unknown, base: URL, name: string, version: string, expected: string): URL {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) error('npm metadata is invalid')
  const item = metadata as { name?: unknown; version?: unknown; dist?: unknown }
  if (item.name !== name || item.version !== version) error('npm metadata package identity does not match the approved artifact')
  if (typeof item.dist !== 'object' || item.dist === null || Array.isArray(item.dist)) error('npm metadata distribution is invalid')
  const dist = item.dist as { integrity?: unknown; tarball?: unknown }
  if (dist.integrity !== expected) error('npm metadata integrity does not match the approved artifact')
  if (typeof dist.tarball !== 'string' || dist.tarball.length > 8_192) error('npm tarball URL is invalid')
  const url = bareHttps(dist.tarball, 'npm tarball URL')
  const prefix = `${base.pathname.replace(/\/+$/u, '')}/`
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) error('npm tarball URL is outside the approved registry base')
  return url
}

export async function fetchRegistryArtifact(request: {
  registry: RegistryBinding
  packageName: string
  version: string
  expectedIntegrity?: string
  signal?: AbortSignal
  timeoutMs?: number
}, environment: NodeJS.ProcessEnv): Promise<FetchedRegistryArtifact> {
  if (!packagePattern.test(request.packageName)) error('registry package name is invalid')
  if (!versionPattern.test(request.version)) error('registry version is not an exact immutable version')
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 120_000)) error('registry timeout is invalid')
  const protocol = request.registry.protocol === undefined ? 'dsh' : request.registry.protocol
  if (protocol !== 'dsh' && protocol !== 'npm') error('registry protocol is invalid')
  const base = bareHttps(request.registry.locator, 'registry locator')
  const deadline = performance.now() + (request.timeoutMs ?? 120_000)
  assertLive(deadline, request.signal)
  if (protocol === 'dsh') {
    const encoded = request.packageName.split('/').map(encodeURIComponent).join('/')
    const root = base.pathname.replace(/\/+$/u, '')
    return await fetchOne(atPath(base, `${root}/packages/${encoded}/${request.version}/package.tgz`), request.registry, environment, artifactLimit, deadline, request.signal)
  }
  const expected = request.expectedIntegrity!
  const hash = expectedSri(expected)
  const root = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  const metadata = await fetchOne(atPath(base, `${root}${encodeURIComponent(request.packageName)}/${request.version}`), request.registry, environment, metadataLimit, deadline, request.signal)
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata.bytes)) } catch { return error('npm metadata is invalid') }
  const result = await fetchOne(tarball(parsed, base, request.packageName, request.version, expected), request.registry, environment, artifactLimit, deadline, request.signal)
  if (!createHash('sha512').update(result.bytes).digest().equals(hash)) error('npm artifact integrity does not match the owner expectation')
  assertLive(deadline, request.signal)
  return result
}

export interface LocalHttpsRegistry {
  origin: string
  close: () => Promise<void>
}

export interface RegistryRequestView {
  method: string
  path: string
  authorization: string | undefined
}

// Test-only loopback registry: HTTPS with a supplied certificate so the client
// exercises the same pinned-CA path as a production registry.
export async function startLocalHttpsRegistry(options: {
  key: string
  cert: string
  handle: (request: RegistryRequestView) => { status: number; bytes?: Buffer; contentType?: string }
}): Promise<LocalHttpsRegistry> {
  const server: HttpsServer = createHttpsServer({ key: options.key, cert: options.cert }, (req, res) => {
    const result = options.handle({
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    })
    if (result.bytes !== undefined) {
      res.writeHead(result.status, {
        ...(result.contentType === undefined ? {} : { 'content-type': result.contentType }),
        'content-length': result.bytes.length,
      })
      Readable.from([result.bytes]).pipe(res)
    } else {
      res.writeHead(result.status, result.contentType === undefined ? {} : { 'content-type': result.contentType })
      res.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    origin: `https://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    },
  }
}
