import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { ControlPlaneCliError } from './errors.js'

const MAX_PACK = 512 * 1024
const MAX_UNPACKED = 16 * 1024 * 1024
const PATH = /^package\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u

export interface NativePackedSource {
  bytes: Buffer
  name: string
  version: string
  sha256: string
}

function fail(message: string): never { throw new ControlPlaneCliError('SOURCE_BOUNDARY', `native source pack ${message}`) }

function octal(header: Buffer, offset: number, width: number, value: number): void {
  const text = value.toString(8)
  if (text.length > width - 1) fail('number exceeds tar header')
  header.write(text.padStart(width - 1, '0') + '\0', offset, width, 'ascii')
}

function member(path: string, bytes: Buffer): Buffer {
  if (!PATH.test(path) || Buffer.byteLength(path) > 100 || bytes.length > 131_072) fail('member path or bytes are unsafe')
  const header = Buffer.alloc(512)
  header.write(path, 0, 100, 'utf8')
  octal(header, 100, 8, 0o644)
  octal(header, 108, 8, 0)
  octal(header, 116, 8, 0)
  octal(header, 124, 12, bytes.length)
  octal(header, 136, 12, 0)
  header.fill(32, 148, 156)
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  octal(header, 148, 8, checksum)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

/** Host-built deterministic npm-compatible ustar. The caller provides exact
 * Host-verified fixed files and bounded compiler output, never a filesystem
 * path, symlink or candidate-controlled archive. */
export function packNativeCreatedPlugin(name: string, fixed: ReadonlyMap<string, string>,
  emitted: ReadonlyMap<string, string>): NativePackedSource {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) fail('plugin name is invalid')
  for (const key of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
    if (!fixed.has(key)) fail(`fixed file is missing: ${key}`)
  }
  if (!emitted.has('lib/index.js') || !emitted.has('lib/index.d.ts')) fail('compiled entry is missing')
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(fixed.get('package.json')!) as Record<string, unknown> }
  catch { fail('package manifest is invalid') }
  const version = manifest.version
  if (manifest.name !== `@dsh-enhanced/${name}` || typeof version !== 'string'
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
    || manifest.main !== './lib/index.js' || manifest.types !== './lib/index.d.ts'
    || JSON.stringify(manifest.files) !== JSON.stringify(['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'])
    || (manifest.dsh as { bundle?: { patch?: unknown } } | undefined)?.bundle?.patch !== './cordis.patch.yml') {
    fail('package identity or published boundary differs')
  }
  const entries = new Map<string, Buffer>()
  for (const key of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
    entries.set(`package/${key}`, Buffer.from(fixed.get(key)!))
  }
  for (const [path, content] of emitted) {
    if (!/^lib\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:js|d\.ts)$/u.test(path)
      || path.split('/').includes('..') || typeof content !== 'string' || entries.has(`package/${path}`)) fail('compiler output is unsafe')
    entries.set(`package/${path}`, Buffer.from(content))
  }
  if (entries.size > 128) fail('too many members')
  const archive = Buffer.concat([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => member(path, bytes)).concat([Buffer.alloc(1024)]))
  if (archive.length > MAX_UNPACKED) fail('uncompressed archive exceeds limit')
  const bytes = gzipSync(archive, { level: 9 })
  if (bytes.length > MAX_PACK) fail('archive exceeds limit')
  // Read back the emitted bytes through an independent bounded gzip decoder.
  if (!gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED }).equals(archive)) fail('archive readback differs')
  return { bytes, name: `${name}-${version}.tgz`, version,
    sha256: createHash('sha256').update(bytes).digest('hex') }
}
