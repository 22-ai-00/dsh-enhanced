import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { afterEach, describe, expect, test } from 'vitest'
import { fetchRegistryArtifact, startLocalHttpsRegistry } from '../src/registry-fetch.ts'

const roots: string[] = []
async function certificate() {
  const root = await mkdtemp(join(tmpdir(), 'registry-fetch-')); roots.push(root)
  const key = join(root, 'key.pem'); const cert = join(root, 'cert.pem'); const config = join(root, 'openssl.cnf')
  await writeFile(config, '[req]\nprompt = no\ndistinguished_name = subject\n\n[subject]\nCN = 127.0.0.1\n\n[v3_req]\nsubjectAltName = IP:127.0.0.1\n')
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config, '-extensions', 'v3_req'])
  return { key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sri = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
type RequestHandler = (path: string, response: ServerResponse) => void
async function adversarialRegistry(key: string, cert: string, handle: RequestHandler) {
  const server = createServer({ key, cert }, (request, response) => handle(request.url ?? '/', response))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback address')
  return {
    origin: `https://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await once(server, 'close') },
  }
}
const binding = (origin: string, cert: string, protocol: 'npm' | 'dsh' = 'npm') =>
  ({ id: 'npm', protocol, locator: origin, caPins: [cert], tokenEnvironment: null })
const npmMetadata = (origin: string, bytes: Buffer, overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  name: 'pkg', version: '1.2.3', dist: { integrity: sri(bytes), tarball: `${origin}/base/tarball.tgz` }, ...overrides,
}))
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(next => { resolve = next }), resolve }
}
async function within(promise: Promise<void>, milliseconds = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('test server did not observe request closure')), milliseconds) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
describe('npm registry artifact retrieval', () => {
  test('downloads scoped npm metadata and a same-base tarball with its pinned integrity', async () => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('npm-tarball'); const seen: string[] = []
    const registry = await startLocalHttpsRegistry({ key, cert, handle(request) {
      seen.push(request.path)
      if (request.path === '/base/%40scope%2Fpkg/1.2.3') return { status: 200, bytes: Buffer.from(JSON.stringify({ name: '@scope/pkg', version: '1.2.3', dist: { integrity: sri(bytes), tarball: `${registry.origin}/base/tarballs/pkg.tgz` } })) }
      if (request.path === '/base/tarballs/pkg.tgz') return { status: 200, bytes, contentType: 'application/gzip' }
      return { status: 404 }
    } })
    try {
      const result = await fetchRegistryArtifact({ registry: { id: 'npm', protocol: 'npm', locator: `${registry.origin}/base`, caPins: [cert], tokenEnvironment: null }, packageName: '@scope/pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})
      expect(result.bytes).toEqual(bytes); expect(seen).toEqual(['/base/%40scope%2Fpkg/1.2.3', '/base/tarballs/pkg.tgz'])
    } finally { await registry.close() }
  })
  test('keeps a leading-double-slash registry base on the approved loopback authority', async () => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('double-slash'); const seen: string[] = []
    const registry = await startLocalHttpsRegistry({ key, cert, handle(request) {
      seen.push(request.path)
      if (request.path === '//base/pkg/1.2.3') return { status: 200, bytes: npmMetadata(registry.origin, bytes,
        { dist: { integrity: sri(bytes), tarball: `${registry.origin}//base/tarball.tgz` } }) }
      if (request.path === '//base/tarball.tgz') return { status: 200, bytes }
      return { status: 404 }
    } })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(`${registry.origin}//base`, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).resolves.toMatchObject({ bytes })
      expect(seen).toEqual(['//base/pkg/1.2.3', '//base/tarball.tgz'])
    } finally { await registry.close() }
  })
  test('rejects mismatched metadata before requesting a tarball', async () => {
    const { key, cert } = await certificate(); let requests = 0; const bytes = Buffer.from('x')
    const registry = await startLocalHttpsRegistry({ key, cert, handle() { requests++; return { status: 200, bytes: Buffer.from(JSON.stringify({ name: 'other', version: '1.2.3', dist: { integrity: sri(bytes), tarball: 'https://127.0.0.1/t.tgz' } })) } } })
    try { await expect(fetchRegistryArtifact({ registry: { id: 'npm', protocol: 'npm', locator: registry.origin, caPins: [cert], tokenEnvironment: null }, packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).rejects.toThrow('metadata'); expect(requests).toBe(1) } finally { await registry.close() }
  })
  test('rejects an off-base tarball URL before credentials can reach it', async () => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('x'); let second = 0
    const other = await startLocalHttpsRegistry({ key, cert, handle() { second++; return { status: 200, bytes } } })
    const registry = await startLocalHttpsRegistry({ key, cert, handle() { return { status: 200, bytes: Buffer.from(JSON.stringify({ name: 'pkg', version: '1.2.3', dist: { integrity: sri(bytes), tarball: `${other.origin}/steal.tgz` } })) } } })
    try { await expect(fetchRegistryArtifact({ registry: { id: 'npm', protocol: 'npm', locator: registry.origin, caPins: [cert], tokenEnvironment: 'TOKEN' }, packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, { TOKEN: 'secret' })).rejects.toThrow('outside'); expect(second).toBe(0) } finally { await registry.close(); await other.close() }
  })
  test('rejects a tampered tarball and honours an already aborted request', async () => {
    const { key, cert } = await certificate(); const good = Buffer.from('good'); const registry = await startLocalHttpsRegistry({ key, cert, handle(request) {
      if (request.path.includes('1.2.3')) return { status: 200, bytes: Buffer.from(JSON.stringify({ name: 'pkg', version: '1.2.3', dist: { integrity: sri(good), tarball: `${registry.origin}/tar.tgz` } })) }
      return { status: 200, bytes: Buffer.from('bad') }
    } })
    try {
      const binding = { id: 'npm', protocol: 'npm' as const, locator: registry.origin, caPins: [cert], tokenEnvironment: null }
      await expect(fetchRegistryArtifact({ registry: binding, packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(good) }, {})).rejects.toThrow('integrity')
      const abort = new AbortController(); abort.abort(); await expect(fetchRegistryArtifact({ registry: binding, packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(good), signal: abort.signal }, {})).rejects.toThrow()
    } finally { await registry.close() }
  })

  test.each([
    ['bad expected integrity', { expectedIntegrity: 'sha512-not-base64' }, 'canonical sha512 integrity'],
    ['invalid timeout', { timeoutMs: 0 }, 'timeout'],
    ['invalid package version', { version: '1.2' }, 'version'],
  ])('rejects %s before opening a network connection', async (_label, overrides, message) => {
    const { key, cert } = await certificate(); let requests = 0
    const registry = await startLocalHttpsRegistry({ key, cert, handle() { requests++; return { status: 200 } } })
    try {
      const request = { registry: binding(registry.origin, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(Buffer.from('x')), ...overrides }
      await expect(fetchRegistryArtifact(request, {})).rejects.toThrow(message)
      expect(requests).toBe(0)
    } finally { await registry.close() }
  })

  test('rejects invalid protocol and locator before opening a network connection', async () => {
    const { key, cert } = await certificate(); let requests = 0
    const registry = await startLocalHttpsRegistry({ key, cert, handle() { requests++; return { status: 200 } } })
    try {
      const request = { packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(Buffer.from('x')) }
      await expect(fetchRegistryArtifact({ ...request, registry: { ...binding(registry.origin, cert), protocol: 'http' as never } }, {})).rejects.toThrow('protocol')
      await expect(fetchRegistryArtifact({ ...request, registry: binding('http://127.0.0.1:1', cert) }, {})).rejects.toThrow('https')
      expect(requests).toBe(0)
    } finally { await registry.close() }
  })

  test.each([
    ['wrong version', { version: 'other' }, 'identity'],
    ['wrong integrity', { dist: { integrity: sri(Buffer.from('other')), tarball: 'https://127.0.0.1/t.tgz' } }, 'integrity'],
    ['missing dist', { dist: undefined }, 'distribution'],
  ])('rejects npm metadata with %s without fetching a tarball', async (_label, replacement, message) => {
    const { key, cert } = await certificate(); let requests = 0; const bytes = Buffer.from('artifact')
    const registry = await startLocalHttpsRegistry({ key, cert, handle() {
      requests++; return { status: 200, bytes: npmMetadata(registry.origin, bytes, replacement) }
    } })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(registry.origin, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).rejects.toThrow(message)
      expect(requests).toBe(1)
    } finally { await registry.close() }
  })

  test.each([
    ['malformed JSON', Buffer.from('{'), 'metadata'],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), 'metadata'],
  ])('rejects %s metadata before a tarball request', async (_label, bytes, message) => {
    const { key, cert } = await certificate(); let requests = 0
    const registry = await startLocalHttpsRegistry({ key, cert, handle() { requests++; return { status: 200, bytes } } })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(registry.origin, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(Buffer.from('x')) }, {})).rejects.toThrow(message)
      expect(requests).toBe(1)
    } finally { await registry.close() }
  })

  test.each([
    ['/outside.tgz', 'outside'], ['/baseevil/t.tgz', 'outside'], ['/base/%2fescape.tgz', 'ambiguous'],
    ['/base/%252fescape.tgz', 'ambiguous'], ['/base/%2e%2e/t.tgz', 'ambiguous'], ['/base/\\escape.tgz', 'bare https'],
  ])('rejects dangerous tarball path %s before a second request', async (path, message) => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('x'); let requests = 0
    const registry = await startLocalHttpsRegistry({ key, cert, handle() {
      requests++; return { status: 200, bytes: npmMetadata(registry.origin, bytes, { dist: { integrity: sri(bytes), tarball: `${registry.origin}${path}` } }) }
    } })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(`${registry.origin}/base`, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).rejects.toThrow(message)
      expect(requests).toBe(1)
    } finally { await registry.close() }
  })

  test.each(['https://user:pass@127.0.0.1/t.tgz', 'https://127.0.0.1/t.tgz?x=1', 'https://127.0.0.1/t.tgz#part'])
  ('rejects credentials, query, and fragment in tarball URLs before a second request', async url => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('x'); let requests = 0
    const registry = await startLocalHttpsRegistry({ key, cert, handle() { requests++; return { status: 200,
      bytes: npmMetadata(registry.origin, bytes, { dist: { integrity: sri(bytes), tarball: url.replace('127.0.0.1', `127.0.0.1:${new URL(registry.origin).port}`) } }) } } })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(registry.origin, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).rejects.toThrow('bare https')
      expect(requests).toBe(1)
    } finally { await registry.close() }
  })

  test.each(['metadata', 'tarball'])(`does not follow %s redirects`, async phase => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('x'); let targetRequests = 0
    const target = await startLocalHttpsRegistry({ key, cert, handle() { targetRequests++; return { status: 200, bytes } } })
    const registry = await adversarialRegistry(key, cert, (path, response) => {
      if ((phase === 'metadata' && path.includes('1.2.3')) || (phase === 'tarball' && path === '/base/tarball.tgz')) {
        response.writeHead(302, { location: `${target.origin}/redirected` }); response.end(); return
      }
      response.end(npmMetadata(registry.origin, bytes))
    })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(`${registry.origin}/base`, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).rejects.toThrow('302')
      expect(targetRequests).toBe(0)
    } finally { await registry.close(); await target.close() }
  })

  test.each([
    ['declared oversized metadata', 'metadata', 2_097_153, 'length'],
    ['declared oversized artifact', 'tarball', 268_435_457, 'length'],
    ['unsupported content encoding', 'tarball', undefined, 'content encoding'],
    ['truncated body', 'tarball', undefined, 'fetch failed'],
  ])('rejects %s and closes the targeted transfer', async (_label, phase, length, message) => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('x'); const targetClosed = deferred()
    const registry = await adversarialRegistry(key, cert, (path, response) => {
      if (phase === 'metadata' && path.includes('1.2.3')) {
        response.socket?.once('close', targetClosed.resolve)
        response.writeHead(200, { 'content-length': String(length) }); response.end(); return
      }
      if (phase === 'tarball' && path === '/base/tarball.tgz') {
        response.socket?.once('close', targetClosed.resolve)
        if (_label === 'unsupported content encoding') { response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': '1' }); response.end('x'); return }
        if (_label === 'truncated body') { response.writeHead(200, { 'content-length': '9' }); response.write('x'); response.destroy(); return }
        response.writeHead(200, { 'content-length': String(length) }); response.end(); return
      }
      response.end(npmMetadata(registry.origin, bytes))
    })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(`${registry.origin}/base`, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).rejects.toThrow(message)
      await within(targetClosed.promise)
    } finally { await registry.close() }
  })

  test('rejects streaming oversized metadata and a TLS certificate outside the pinned root', async () => {
    const first = await certificate(); const second = await certificate(); const bytes = Buffer.from('x'); let tarballs = 0
    const registry = await adversarialRegistry(first.key, first.cert, (path, response) => {
      if (path.includes('1.2.3')) { response.writeHead(200); response.write(Buffer.alloc(2_097_153, 0x20)); response.end(); return }
      tarballs++; response.end(bytes)
    })
    const wrongCertificate = await startLocalHttpsRegistry({ key: second.key, cert: second.cert, handle() { return { status: 200, bytes } } })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(registry.origin, first.cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).rejects.toThrow('bounded size')
      expect(tarballs).toBe(0)
      await expect(fetchRegistryArtifact({ registry: binding(wrongCertificate.origin, first.cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes) }, {})).rejects.toThrow('TLS')
    } finally { await registry.close(); await wrongCertificate.close() }
  })

  test('uses the legacy DSH package path', async () => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('legacy'); const seen: string[] = []
    const registry = await startLocalHttpsRegistry({ key, cert, handle(request) { seen.push(request.path); return { status: 200, bytes } } })
    try {
      await expect(fetchRegistryArtifact({ registry: binding(`${registry.origin}/registry`, cert, 'dsh'), packageName: '@scope/pkg', version: '1.2.3' }, {})).resolves.toMatchObject({ bytes })
      expect(seen).toEqual(['/registry/packages/%40scope/pkg/1.2.3/package.tgz'])
    } finally { await registry.close() }
  })

  test.each(['metadata', 'tarball'])('enforces one absolute deadline during a slow %s body', async phase => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('x'); const reached = deferred(); const closed = deferred()
    const registry = await adversarialRegistry(key, cert, (path, response) => {
      if ((phase === 'metadata' && path.includes('1.2.3')) || (phase === 'tarball' && path === '/base/tarball.tgz')) {
        reached.resolve(); response.socket?.once('close', closed.resolve)
        response.writeHead(200, { 'content-length': '100' }); response.write('x')
        const timer = setInterval(() => response.writableEnded || response.destroyed ? clearInterval(timer) : response.write('x'), 15)
        response.once('close', () => clearInterval(timer))
        return
      }
      response.end(npmMetadata(registry.origin, bytes))
    })
    try {
      const pending = fetchRegistryArtifact({ registry: binding(`${registry.origin}/base`, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes), timeoutMs: 500 }, {})
      await within(reached.promise); await expect(pending).rejects.toThrow('timed out'); await within(closed.promise)
    } finally { await registry.close() }
  })

  test.each(['metadata', 'tarball'])('aborts an active %s request and destroys its socket', async phase => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('x'); const abort = new AbortController(); const reached = deferred(); const closed = deferred()
    const registry = await adversarialRegistry(key, cert, (path, response) => {
      if ((phase === 'metadata' && path.includes('1.2.3')) || (phase === 'tarball' && path === '/base/tarball.tgz')) {
        reached.resolve(); response.socket?.once('close', closed.resolve)
        response.writeHead(200, { 'content-length': '100' }); response.write('x'); return
      }
      response.end(npmMetadata(registry.origin, bytes))
    })
    try {
      const pending = fetchRegistryArtifact({ registry: binding(`${registry.origin}/base`, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes), signal: abort.signal }, {})
      await within(reached.promise); abort.abort()
      await expect(pending).rejects.toThrow('aborted')
      await within(closed.promise)
    } finally { await registry.close() }
  })

  test('does not reset the deadline between metadata and tarball', async () => {
    const { key, cert } = await certificate(); const bytes = Buffer.from('x'); const tarballRequested = deferred()
    const registry = await adversarialRegistry(key, cert, (path, response) => {
      const later = (body: Buffer) => { const timer = setTimeout(() => response.end(body), 600); response.once('close', () => clearTimeout(timer)) }
      if (path.includes('1.2.3')) { later(npmMetadata(registry.origin, bytes)); return }
      tarballRequested.resolve(); later(bytes)
    })
    try {
      const pending = fetchRegistryArtifact({ registry: binding(`${registry.origin}/base`, cert), packageName: 'pkg', version: '1.2.3', expectedIntegrity: sri(bytes), timeoutMs: 1_000 }, {})
      await within(tarballRequested.promise); await expect(pending).rejects.toThrow('timed out')
    } finally { await registry.close() }
  })
})
