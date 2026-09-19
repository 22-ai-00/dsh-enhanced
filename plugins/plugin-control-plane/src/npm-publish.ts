import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { gunzipSync } from 'node:zlib'
import type { ClientRequest, IncomingMessage } from 'node:http'

const MAX_TGZ = 256 * 1024 * 1024
const MAX_INFLATED = 256 * 1024 * 1024
const MAX_MANIFEST = 1024 * 1024
const MAX_RESPONSE = 2 * 1024 * 1024
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const TAG = /^[a-z][a-z0-9-]{0,63}$/u

export interface NpmPublishInput {
  locator: string
  packageName: string
  version: string
  tarball: Buffer
  tag: string
  expectedRegistryReference: string
}

export interface PreparedNpmPublish { url: string; body: Buffer }
export interface NpmPublishSendInput { url: string; body: Buffer; token: string; caPins: readonly string[]; timeoutMs: number }

function fail(message: string): never { throw new Error(`npm publish: ${message}`) }
function boundedText(value: unknown, label: string, maximum = 8_192): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum
    || [...value].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) fail(`${label} is invalid`)
  return value
}
function bareHttps(value: string, label: string, allowNpmEscapedSlash = false): URL {
  boundedText(value, label)
  if (/[\\?#]/u.test(value) || /%(?!2f)/u.test(value)) fail(`${label} is not a canonical HTTPS URL`)
  let url: URL
  try { url = new URL(value) } catch { fail(`${label} is invalid`) }
  const rootWithoutSlash = url.pathname === '/' && url.href === `${value}/`
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname.includes('//')
    || (!allowNpmEscapedSlash && value.includes('%2f')) || (url.href !== value && !rootWithoutSlash)) fail(`${label} is not a canonical HTTPS URL`)
  return url
}
function basePath(base: URL): string { return base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/` }
function atBase(base: URL, suffix: string): URL {
  const target = new URL(base)
  target.pathname = `${basePath(base)}${suffix}`
  return target
}
function verifyReference(value: string, base: URL): string {
  const reference = bareHttps(value, 'expected registry reference')
  if (reference.origin !== base.origin || !reference.pathname.startsWith(basePath(base))) fail('expected registry reference is outside the configured registry base')
  return reference.href
}
function readString(bytes: Buffer, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length); const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8')
}
function octal(bytes: Buffer, offset: number, length: number, label: string): number {
  const raw = readString(bytes, offset, length).trim()
  if (raw === '') return 0
  if (!/^[0-7]+$/u.test(raw)) fail(`tar ${label} is invalid`)
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value) || value < 0) fail(`tar ${label} is invalid`)
  return value
}
function checksum(header: Buffer): void {
  const stored = octal(header, 148, 8, 'checksum'); let sum = 0
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!
  if (sum !== stored) fail('tar header checksum is invalid')
}
function safePath(value: string, permitTerminalSlash = false): string {
  const path = permitTerminalSlash && value.endsWith('/') ? value.slice(0, -1) : value
  if (!path || value.includes('\0') || value.includes('\\') || value.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) fail('tar path is unsafe')
  return value
}
function paxPath(payload: Buffer): string | undefined {
  let offset = 0; let path: string | undefined
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset)
    if (space < 0) fail('PAX record is invalid')
    const lengthText = payload.subarray(offset, space).toString('ascii')
    if (!/^[1-9]\d*$/u.test(lengthText)) fail('PAX record is invalid')
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > payload.length) fail('PAX record is invalid')
    const record = payload.subarray(space + 1, offset + length)
    if (record[record.length - 1] !== 0x0a) fail('PAX record is invalid')
    const equal = record.indexOf(0x3d)
    if (equal < 1) fail('PAX record is invalid')
    const key = record.subarray(0, equal).toString('utf8'); const value = record.subarray(equal + 1, -1).toString('utf8')
    if (key === 'path') path = safePath(value, true)
    else if (key === 'size' || key === 'linkpath') fail(`PAX ${key} is unsupported`)
    else if (!['atime', 'ctime', 'gid', 'gname', 'mtime', 'uid', 'uname'].includes(key)) fail(`PAX ${key} is unsupported`)
    offset += length
  }
  return path
}
function packageManifest(tgz: Buffer): Record<string, unknown> {
  if (!Buffer.isBuffer(tgz) || tgz.length < 1 || tgz.length > MAX_TGZ) fail('tarball exceeds the bounded size')
  let tar: Buffer
  try { tar = Buffer.from(gunzipSync(tgz, { maxOutputLength: MAX_INFLATED })) } catch { fail('tarball is not a bounded gzip stream') }
  let offset = 0; let zeroBlocks = 0; let pendingPath: string | undefined; let pendingPax: { path: string | undefined } | undefined
  let manifest: Record<string, unknown> | undefined
  while (offset < tar.length) {
    if (offset + 512 > tar.length) fail('tarball is truncated')
    const header = tar.subarray(offset, offset + 512); offset += 512
    if (header.every(byte => byte === 0)) { if (pendingPath !== undefined || pendingPax !== undefined) fail('tarball has a dangling extension header'); zeroBlocks++; continue }
    if (zeroBlocks) fail('tarball contains data after its terminator')
    checksum(header)
    const size = octal(header, 124, 12, 'size'); const type = String.fromCharCode(header[156] || 0)
    const padded = Math.ceil(size / 512) * 512
    if (offset + padded > tar.length) fail('tarball is truncated')
    const payload = tar.subarray(offset, offset + size); offset += padded
    if (type === 'x') {
      if (pendingPath !== undefined || pendingPax !== undefined) fail('tarball has stacked extension headers')
      pendingPax = { path: paxPath(payload) }; continue
    }
    if (type === 'L') {
      if (pendingPath !== undefined || pendingPax !== undefined) fail('tarball has stacked extension headers')
      pendingPath = safePath(payload.subarray(0, payload.length && payload[payload.length - 1] === 0 ? -1 : payload.length).toString('utf8').replace(/\n$/u, ''), true); continue
    }
    if (type !== '\0' && type !== '0' && type !== '5') fail('tarball contains an unsupported entry type')
    const prefix = readString(header, 345, 155)
    const path = pendingPax?.path ?? pendingPath ?? safePath(`${prefix}${prefix ? '/' : ''}${readString(header, 0, 100)}`, type === '5')
    pendingPax = undefined; pendingPath = undefined
    if (type === '5') {
      if (size !== 0 || !path.endsWith('/')) fail('tar directory entry is invalid')
      continue
    }
    if (path.endsWith('/')) fail('tar file path is unsafe')
    if (path === 'package/package.json') {
      if (manifest !== undefined) fail('tarball contains duplicate package manifests')
      if (payload.length > MAX_MANIFEST) fail('package manifest exceeds the bounded size')
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('package manifest is invalid')
        manifest = parsed as Record<string, unknown>
      } catch (error) { if (error instanceof Error && error.message.startsWith('npm publish:')) throw error; fail('package manifest is invalid') }
    }
  }
  if (zeroBlocks < 2 || manifest === undefined) fail('tarball has no unique package/package.json')
  return manifest
}
export function prepareNpmPublish(input: NpmPublishInput): PreparedNpmPublish {
  if (!PACKAGE.test(input.packageName)) fail('package name is invalid')
  if (!VERSION.test(input.version)) fail('package version is invalid')
  if (!TAG.test(input.tag)) fail('dist-tag is invalid')
  const base = bareHttps(input.locator, 'registry locator')
  const expected = verifyReference(input.expectedRegistryReference, base)
  const manifest = packageManifest(input.tarball)
  if (manifest.name !== input.packageName || manifest.version !== input.version || manifest.private) fail('package manifest does not match the authorized public package')
  if (Object.hasOwn(manifest, 'packageExtensions')) fail('package manifest contains packageExtensions')
  const tarballName = `${input.packageName}-${input.version}.tgz`
  const sha512 = createHash('sha512').update(input.tarball).digest('base64')
  const sha1 = createHash('sha1').update(input.tarball).digest('hex')
  const version: Record<string, unknown> = { ...manifest, _id: `${input.packageName}@${input.version}`, dist: { integrity: `sha512-${sha512}`, shasum: sha1, tarball: expected } }
  delete version.patchedDependencies
  const body = Buffer.from(JSON.stringify({ _id: input.packageName, name: input.packageName,
    description: typeof manifest.description === 'string' ? manifest.description : '', access: 'public', versions: { [input.version]: version },
    'dist-tags': { [input.tag]: input.version }, _attachments: { [tarballName]: { content_type: 'application/octet-stream', data: input.tarball.toString('base64'), length: input.tarball.length } } }))
  if (body.length > 402_653_184) fail('publish body exceeds the bounded size')
  return { url: atBase(base, input.packageName.replace('/', '%2f')).href, body }
}

function detail(code: string): string { return createHash('sha256').update(code).digest('hex') }
export async function sendNpmPublish(input: NpmPublishSendInput): Promise<{ outcome: 'accepted' | 'ambiguous'; detailDigest: string }> {
  const url = bareHttps(input.url, 'publish URL', true)
  if (!Buffer.isBuffer(input.body) || input.body.length < 1 || input.body.length > 402_653_184) fail('publish body is invalid')
  if (typeof input.token !== 'string' || input.token.length < 1 || /[^\x21-\x7e]/u.test(input.token)) fail('publish token is invalid')
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000) fail('publish timeout is invalid')
  if (!Array.isArray(input.caPins) || input.caPins.some(pin => typeof pin !== 'string' || pin.length < 1)) fail('owner CA pins are invalid')
  const deadline = performance.now() + input.timeoutMs
  return await new Promise(resolve => {
    let req: ClientRequest | undefined; let response: IncomingMessage | undefined; let settled = false
    const finish = (outcome: 'accepted' | 'ambiguous', code: string): void => {
      if (settled) return; settled = true; clearTimeout(timer); response?.destroy(); req?.destroy(); resolve({ outcome, detailDigest: detail(code) })
    }
    const timer = setTimeout(() => finish('ambiguous', 'timeout'), Math.max(1, deadline - performance.now()))
    try {
      req = httpsRequest(url, { method: 'PUT', agent: false, rejectUnauthorized: true, ...(input.caPins.length ? { ca: [...input.caPins] } : {}), ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {}), headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json', 'content-length': String(input.body.length), accept: 'application/json', 'accept-encoding': 'identity' } }, incoming => {
        response = incoming; const status = incoming.statusCode ?? 0; const encoding = incoming.headers['content-encoding']; const length = incoming.headers['content-length']
        if (encoding !== undefined && encoding !== 'identity') { finish('ambiguous', `encoding:${status}`); return }
        if (length !== undefined && (!/^\d{1,10}$/u.test(length) || Number(length) > MAX_RESPONSE)) { finish('ambiguous', `length:${status}`); return }
        let size = 0
        incoming.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_RESPONSE) finish('ambiguous', `body:${status}`) })
        incoming.on('aborted', () => finish('ambiguous', `aborted:${status}`))
        incoming.on('error', () => finish('ambiguous', `response-error:${status}`))
        incoming.on('end', () => {
          if (performance.now() >= deadline) finish('ambiguous', 'timeout')
          else if (length !== undefined && size !== Number(length)) finish('ambiguous', `truncated:${status}`)
          else finish(status === 200 || status === 201 ? 'accepted' : 'ambiguous', `status:${status}`)
        })
      })
      req.on('error', () => finish('ambiguous', 'request-error'))
      req.end(input.body)
    } catch { finish('ambiguous', 'request-start-error') }
  })
}
