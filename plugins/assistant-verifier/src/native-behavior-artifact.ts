import { gunzipSync } from 'node:zlib'

const MAX_TAR_BYTES = 16 * 1024 * 1024
const MAX_FILES = 256
const MAX_PATH = 256

function fail(): never { throw new Error('invalid native behavior artifact') }
function field(bytes: Buffer): string {
  const end = bytes.indexOf(0)
  const value = end < 0 ? bytes : bytes.subarray(0, end)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(value)
  if (!text.isWellFormed()) fail()
  return text
}
function octal(bytes: Buffer): number {
  const text = field(bytes).trim()
  if (!/^[0-7]+$/u.test(text)) fail()
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) fail()
  return value
}
function pax(bytes: Buffer): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at)
    if (space < 0) fail()
    const length = Number(bytes.subarray(at, space).toString('ascii'))
    if (!Number.isSafeInteger(length) || length <= space - at + 2 || at + length > bytes.length
      || bytes[at + length - 1] !== 10) fail()
    const row = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(space + 1, at + length - 1))
    const equals = row.indexOf('=')
    if (equals < 1 || Object.hasOwn(result, row.slice(0, equals))) fail()
    result[row.slice(0, equals)] = row.slice(equals + 1)
    at += length
  }
  return result
}
function safePath(name: string): boolean {
  return name.length <= MAX_PATH && name.startsWith('package/')
    && name.slice(8).split('/').every(part => /^[A-Za-z0-9._-]+$/u.test(part) && part !== '.' && part !== '..')
}

/** Parse only regular UTF-8 npm package members. The runner stages these exact bytes; no archive links enter its workspace. */
export function nativeBehaviorFiles(artifact: Buffer): { entry: string; files: { path: string; content: string }[] } {
  let tar: Buffer
  try { tar = gunzipSync(artifact, { maxOutputLength: MAX_TAR_BYTES }) }
  catch { fail() }
  let at = 0; let local: Record<string, string> = {}; let global: Record<string, string> = {}
  let members = 0
  const entries = new Map<string, Buffer>()
  const seen = new Set<string>()
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    if (++members > MAX_FILES) fail()
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!
    if (checksum !== octal(header.subarray(148, 156))) fail()
    const size = octal(header.subarray(124, 136))
    const end = at + 512 + size
    if (!Number.isSafeInteger(end) || end > tar.length) fail()
    const kind = String.fromCharCode(header[156] || 48)
    if (kind === 'g' || kind === 'x') {
      if (size > 1_048_576) fail()
      const values = pax(tar.subarray(at + 512, end))
      if (kind === 'g') global = { ...global, ...values }
      else local = values
    } else {
      const attrs = { ...global, ...local }
      if (Object.keys(attrs).some(key => !['path', 'mtime', 'atime', 'ctime', 'comment', 'uid', 'gid', 'uname', 'gname', 'mode'].includes(key))) fail()
      const prefix = field(header.subarray(345, 500))
      const headerName = field(header.subarray(0, 100))
      const rawName = attrs.path ?? (prefix ? `${prefix}/${headerName}` : headerName)
      const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
      if ((name !== 'package' && !safePath(name)) || seen.has(name)) fail()
      seen.add(name)
      if (kind === '0' || kind === '7') {
        if (name === 'package') fail()
        entries.set(name, tar.subarray(at + 512, end))
      } else if (kind !== '5') fail()
      local = {}
    }
    at = Math.ceil(end / 512) * 512
  }
  if (at + 1024 > tar.length || !tar.subarray(at).every(byte => byte === 0)) fail()
  const manifestBytes = entries.get('package/package.json')
  if (!manifestBytes) fail()
  let manifest: unknown
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) }
  catch { fail() }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || typeof (manifest as { main?: unknown }).main !== 'string') fail()
  const main = (manifest as { main: string }).main
  if (!/^\.\/lib\/[A-Za-z0-9._/-]+\.js$/u.test(main) || main.split('/').includes('..')) fail()
  const entry = `package/${main.slice(2)}`
  if (!entries.has(entry)) fail()
  const files: { path: string; content: string }[] = []
  for (const [path, bytes] of entries) {
    if (bytes.length > 1024 * 1024) fail()
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { fail() }
    files.push({ path, content })
  }
  return { entry, files }
}
