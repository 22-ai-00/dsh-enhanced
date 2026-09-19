import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { prepareNpmPublish, sendNpmPublish } from '../src/npm-publish.ts'

const roots: string[] = []
function field(header: Buffer, offset: number, size: number, value: string): void { header.write(value, offset, Math.min(size, Buffer.byteLength(value)), 'ascii') }
function tarEntry(path: string, body: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512); field(header, 0, 100, path); field(header, 100, 8, '0000644\0'); field(header, 124, 12, `${body.length.toString(8).padStart(11, '0')}\0`); field(header, 148, 8, '        '); field(header, 156, 1, type); field(header, 257, 6, 'ustar\0')
  let sum = 0; for (const byte of header) sum += byte; field(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)])
}
function packed(manifest: object): Buffer { return gzipSync(Buffer.concat([tarEntry('package/package.json', Buffer.from(JSON.stringify(manifest))), Buffer.alloc(1024)])) }
function paxRecord(key: string, value: string): Buffer {
  let length = 0; let record = ''
  do { length = Buffer.byteLength(record); record = `${length} ${key}=${value}\n` } while (Buffer.byteLength(record) !== length)
  return Buffer.from(record)
}
async function certificate() {
  const root = await mkdtemp(join(tmpdir(), 'npm-publish-')); roots.push(root); const key = join(root, 'key.pem'); const cert = join(root, 'cert.pem'); const config = join(root, 'openssl.cnf')
  await writeFile(config, '[req]\nprompt = no\ndistinguished_name = subject\n\n[subject]\nCN = 127.0.0.1\n\n[v3_req]\nsubjectAltName = IP:127.0.0.1\n')
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config, '-extensions', 'v3_req'], { stdio: 'ignore' })
  return { key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('bounded npm publish helper', () => {
  test('creates the official scoped PUT document without running package scripts', () => {
    const tarball = packed({ name: '@scope/pkg', version: '1.2.3', scripts: { prepublishOnly: 'exit 99' }, patchedDependencies: { x: 'y' } })
    const result = prepareNpmPublish({ locator: 'https://registry.example/base', packageName: '@scope/pkg', version: '1.2.3', tarball, tag: 'latest', expectedRegistryReference: 'https://registry.example/base/@scope/pkg/-/@scope/pkg-1.2.3.tgz' })
    expect(result.url).toBe('https://registry.example/base/@scope%2fpkg')
    const body = JSON.parse(result.body.toString())
    expect(body._attachments['@scope/pkg-1.2.3.tgz']).toMatchObject({ content_type: 'application/octet-stream', length: tarball.length })
    expect(body.versions['1.2.3'].dist.tarball).toBe('https://registry.example/base/@scope/pkg/-/@scope/pkg-1.2.3.tgz')
    expect(body.versions['1.2.3']).not.toHaveProperty('patchedDependencies')
  })

  test.each([
    ['private manifest', { name: 'pkg', version: '1.2.3', private: true }],
    ['mismatched identity', { name: 'other', version: '1.2.3' }],
  ])('rejects %s before publication', (_label, manifest) => {
    expect(() => prepareNpmPublish({ locator: 'https://registry.example/', packageName: 'pkg', version: '1.2.3', tarball: packed(manifest), tag: 'latest', expectedRegistryReference: 'https://registry.example/pkg/-/pkg-1.2.3.tgz' })).toThrow()
  })

  test.each(['https://registry.example//base', 'https://registry.example/base%2Fpath', 'https://registry.example/base\n'])
  ('rejects noncanonical registry locator %j before parsing publication input', locator => {
    expect(() => prepareNpmPublish({ locator, packageName: 'pkg', version: '1.2.3', tarball: packed({ name: 'pkg', version: '1.2.3' }), tag: 'latest', expectedRegistryReference: 'https://registry.example/pkg/-/pkg-1.2.3.tgz' })).toThrow()
  })

  test('rejects duplicate manifests and link entries in the tar stream', () => {
    const manifest = Buffer.from(JSON.stringify({ name: 'pkg', version: '1.2.3' }))
    const duplicate = gzipSync(Buffer.concat([tarEntry('package/package.json', manifest), tarEntry('package/package.json', manifest), Buffer.alloc(1024)]))
    const linked = gzipSync(Buffer.concat([tarEntry('package/package.json', manifest), tarEntry('package/link', Buffer.alloc(0), '2'), Buffer.alloc(1024)]))
    const common = { locator: 'https://registry.example/', packageName: 'pkg', version: '1.2.3', tag: 'latest', expectedRegistryReference: 'https://registry.example/pkg/-/pkg-1.2.3.tgz' }
    expect(() => prepareNpmPublish({ ...common, tarball: duplicate })).toThrow('duplicate')
    expect(() => prepareNpmPublish({ ...common, tarball: linked })).toThrow('unsupported')
  })

  test('accepts an ordinary package directory and rejects dangerous or dangling PAX headers', () => {
    const manifest = Buffer.from(JSON.stringify({ name: 'pkg', version: '1.2.3' })); const ending = Buffer.alloc(1024)
    const directory = gzipSync(Buffer.concat([tarEntry('package/', Buffer.alloc(0), '5'), tarEntry('package/package.json', manifest), ending]))
    const paxSize = gzipSync(Buffer.concat([tarEntry('PaxHeader', paxRecord('size', '0'), 'x'), tarEntry('package/package.json', manifest), ending]))
    const paxLink = gzipSync(Buffer.concat([tarEntry('PaxHeader', paxRecord('linkpath', '../../outside'), 'x'), tarEntry('package/package.json', manifest), ending]))
    const paxEscape = gzipSync(Buffer.concat([tarEntry('PaxHeader', paxRecord('path', '../../outside'), 'x'), tarEntry('package/package.json', manifest), ending]))
    const dangling = gzipSync(Buffer.concat([tarEntry('PaxHeader', paxRecord('path', 'package/package.json'), 'x'), ending]))
    const common = { locator: 'https://registry.example/', packageName: 'pkg', version: '1.2.3', tag: 'latest', expectedRegistryReference: 'https://registry.example/pkg/-/pkg-1.2.3.tgz' }
    expect(() => prepareNpmPublish({ ...common, tarball: directory })).not.toThrow()
    expect(() => prepareNpmPublish({ ...common, tarball: paxSize })).toThrow('PAX size')
    expect(() => prepareNpmPublish({ ...common, tarball: paxLink })).toThrow('PAX linkpath')
    expect(() => prepareNpmPublish({ ...common, tarball: paxEscape })).toThrow('unsafe')
    expect(() => prepareNpmPublish({ ...common, tarball: dangling })).toThrow('dangling')
  })

  test('sends a scoped prepared document in one pinned-TLS PUT and classifies its ACK', async () => {
    const { key, cert } = await certificate(); let requests = 0; let authorization = ''; let body = Buffer.alloc(0); let path = ''
    const server = createServer({ key, cert }, (request, response) => { requests++; path = request.url ?? ''; authorization = request.headers.authorization ?? ''; const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', () => { body = Buffer.concat(chunks); response.writeHead(201, { 'content-length': '2' }); response.end('{}') }) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing address')
    try {
      const origin = `https://127.0.0.1:${address.port}`; const prepared = prepareNpmPublish({ locator: origin, packageName: '@scope/pkg', version: '1.2.3', tarball: packed({ name: '@scope/pkg', version: '1.2.3' }), tag: 'latest', expectedRegistryReference: `${origin}/@scope/pkg/-/@scope/pkg-1.2.3.tgz` })
      const result = await sendNpmPublish({ url: prepared.url, body: prepared.body, token: 'secret', caPins: [cert], timeoutMs: 2_000 })
      expect(result.outcome).toBe('accepted'); expect(result.detailDigest).toMatch(/^[a-f0-9]{64}$/); expect(requests).toBe(1); expect(path).toBe('/@scope%2fpkg'); expect(authorization).toBe('Bearer secret'); expect(body).toEqual(prepared.body)
    } finally { server.close(); await once(server, 'close') }
  })

  test('classifies a redirect as ambiguous without retrying', async () => {
    const { key, cert } = await certificate(); let requests = 0
    const server = createServer({ key, cert }, (_request, response) => { requests++; response.writeHead(302, { location: '/other', 'content-length': '0' }); response.end() })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing address')
    try { await expect(sendNpmPublish({ url: `https://127.0.0.1:${address.port}/pkg`, body: Buffer.from('{}'), token: 'secret', caPins: [cert], timeoutMs: 2_000 })).resolves.toMatchObject({ outcome: 'ambiguous' }); expect(requests).toBe(1) }
    finally { server.close(); await once(server, 'close') }
  })

  test('destroys a request that exceeds its absolute deadline', async () => {
    const { key, cert } = await certificate(); let requests = 0
    const server = createServer({ key, cert }, request => { requests++; request.resume() })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing address')
    try { await expect(sendNpmPublish({ url: `https://127.0.0.1:${address.port}/pkg`, body: Buffer.from('{}'), token: 'secret', caPins: [cert], timeoutMs: 500 })).resolves.toMatchObject({ outcome: 'ambiguous' }); expect(requests).toBe(1) }
    finally { server.close(); await once(server, 'close') }
  })
})
