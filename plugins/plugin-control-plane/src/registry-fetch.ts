import { isIP, type AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { request as httpsRequest, createServer as createHttpsServer, type Server as HttpsServer, type RequestOptions } from 'node:https'

export class RegistryFetchError extends Error {
  constructor(message: string) { super(message); this.name = 'RegistryFetchError' }
}

export interface RegistryBinding {
  id: string
  locator: string
  caPins: readonly string[]
  tokenEnvironment: string | null
}

export interface FetchedRegistryArtifact {
  bytes: Buffer
  mediaType: string | null
}

const maximumRegistryArtifactBytes = 268_435_456
const fetchTimeoutMs = 120_000
const immutableVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u
// Scoped package names keep their single separating slash; every path segment
// is still percent-encoded, so no traversal or authority-confusion survives.
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

// One independently downloaded immutable object. TLS is pinned to the owner
// trust.caPins when configured, the bearer token (if any) is read only from
// the bound owner-process environment variable, and the body is bounded
// before the caller performs its own approved-integrity comparison.
export async function fetchRegistryArtifact(request: {
  registry: RegistryBinding
  packageName: string
  version: string
}, environment: NodeJS.ProcessEnv): Promise<FetchedRegistryArtifact> {
  const { registry, packageName, version } = request
  if (!packageNamePattern.test(packageName)) throw new RegistryFetchError('registry package name is invalid')
  if (!immutableVersionPattern.test(version)) throw new RegistryFetchError('registry version is not an exact immutable version')
  let locator: URL
  try { locator = new URL(registry.locator) } catch { throw new RegistryFetchError('registry locator is invalid') }
  if (locator.protocol !== 'https:' || locator.username !== '' || locator.password !== '' || locator.search !== '' || locator.hash !== '') {
    throw new RegistryFetchError('registry locator must be a bare https URL without credentials or query')
  }
  const encodedPackage = packageName.split('/').map(part => encodeURIComponent(part)).join('/')
  const basePath = locator.pathname.replace(/\/+$/u, '')
  const target = new URL(`${basePath}/packages/${encodedPackage}/${version}/package.tgz`, locator)
  const headers: Record<string, string> = { accept: 'application/gzip, application/octet-stream' }
  if (registry.tokenEnvironment !== null) {
    const token = environment[registry.tokenEnvironment]
    if (typeof token !== 'string' || token.trim() === '' || /[\r\n]/u.test(token)) {
      throw new RegistryFetchError('bound registry token environment variable is missing or invalid')
    }
    headers.authorization = `Bearer ${token}`
  }
  const tlsOptions: RequestOptions = registry.caPins.length > 0
    ? { ca: [...registry.caPins], rejectUnauthorized: true, ...(isIP(locator.hostname) === 0 ? { servername: locator.hostname } : {}) }
    : {}
  return await new Promise<FetchedRegistryArtifact>((resolve, reject) => {
    const settle = (error: Error): void => reject(error)
    const req = httpsRequest(target, { method: 'GET', headers, timeout: fetchTimeoutMs, ...tlsOptions }, response => {
      const status = response.statusCode ?? 0
      if (status !== 200) {
        response.resume()
        settle(new RegistryFetchError(`registry answered ${status}`))
        return
      }
      const declaredLength = response.headers['content-length']
      if (declaredLength !== undefined && !/^\d{1,10}$/u.test(declaredLength)) {
        response.resume()
        settle(new RegistryFetchError('registry content-length is invalid'))
        return
      }
      const declared = declaredLength === undefined ? null : Number(declaredLength)
      if (declared !== null && declared > maximumRegistryArtifactBytes) {
        response.resume()
        settle(new RegistryFetchError('registry artifact exceeds the bounded size'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maximumRegistryArtifactBytes) {
          req.destroy(new RegistryFetchError('registry artifact exceeds the bounded size'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (declared !== null && size !== declared) {
          settle(new RegistryFetchError('registry artifact length changed during transfer'))
          return
        }
        if (size < 1) {
          settle(new RegistryFetchError('registry artifact is empty'))
          return
        }
        resolve({ bytes: Buffer.concat(chunks, size), mediaType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null })
      })
      response.on('error', error => settle(new RegistryFetchError(error.message)))
    })
    req.on('timeout', () => req.destroy(new RegistryFetchError('registry request timed out')))
    req.on('error', error => {
      const cause = (error as NodeJS.ErrnoException & { cause?: { code?: string } }).cause
      const code = (error as NodeJS.ErrnoException).code ?? cause?.code ?? ''
      if (/SELF_SIGNED_CERT|CERT_|DEPTH_ZERO|UNABLE_TO_VERIFY|UNKNOWN_CERT/u.test(String(code))) {
        settle(new RegistryFetchError('registry TLS certificate is not pinned by the owner trust root'))
        return
      }
      settle(new RegistryFetchError(`registry fetch failed: ${error.message}`))
    })
    req.end()
  })
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
