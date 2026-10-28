import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { hashLinuxRuntimeTree, validateLinuxRuntime, verifyLinuxRuntime, type LinuxRuntime } from './linux-runtime.js'

export interface LinuxSystemSnapshot {
  schemaVersion: 1
  root: { path: string; dev: number; ino: number; sha256: string }
  manifestSha256: string
  bytes: number
  entries: number
}

export const linuxSystemSnapshotLimits = Object.freeze({ bytes: 640 * 1024 * 1024, entries: 32768 })
const MANIFEST = '.dsh-system-manifest.json'
const MAX_MANIFEST = 16 * 1024 * 1024
const HEX = /^[a-f0-9]{64}$/u
const exec = promisify(execFile)
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): value is string => typeof value === 'string'
  && isAbsolute(value) && value === resolve(value) && ![...value].some(character => character.charCodeAt(0) < 32)
const stamp = (s: Stats): string => JSON.stringify([s.dev, s.ino, s.uid, s.mode, s.size, s.mtimeMs, s.ctimeMs])
const checkAbort = (signal?: AbortSignal): void => { signal?.throwIfAborted() }
const tools = `bash dash sh env printenv bwrap unshare mount umount setpriv script flock setsid nsenter timeout kill sleep yes ps pgrep pkill id whoami uname hostname mkfifo cat ls chmod cp mv rm mkdir rmdir mktemp touch ln readlink realpath stat basename dirname date du df head tail tr sort cut wc od tee printf true false test pwd expr seq install truncate sync sha256sum find xargs grep sed awk which tar gzip gunzip xz curl git openssl perl python3 strace`.split(' ')
interface SourceLink { path: string; target: string; info: Stats }
interface Source { path: string; info: Stats; links: SourceLink[] }
interface Origin { path: string; source: string; sourceMode: number; kind: 'file' | 'dir' | 'link' | 'pinned-runtime-node'; mode: number; size?: number; sha256?: string; target?: string; sourceTarget?: string; pinnedNodeRuntimeDigest?: string }
interface Manifest { schemaVersion: 1; platform: string; tools: Record<string, string>; origins: Origin[] }

/** Resolve every component without trusting a user-owned intermediate or a mutable symlink. */
export async function inspectTrustedLinuxSystemSource(path: string): Promise<Source> {
  if (!canonical(path)) throw new Error('noncanonical system source')
  let pending = path.split('/').filter(Boolean), current = '/', hops = 0
  const links: SourceLink[] = []
  const root = await lstat('/')
  if (root.uid !== 0 || root.mode & 0o022) throw new Error('untrusted system source root')
  while (pending.length) {
    current = join(current, pending.shift()!)
    if (current === '/etc/ssl/private' || current.startsWith('/etc/ssl/private/')) throw new Error('private system source forbidden')
    const info = await lstat(current)
    if (!info.isSymbolicLink() && !info.isFile() && !info.isDirectory()) throw new Error('special system source forbidden')
    if (info.uid !== 0 || (!info.isSymbolicLink() && info.mode & 0o022)) throw new Error(`untrusted system source: ${current}`)
    if (info.isSymbolicLink()) {
      if (++hops > 40) throw new Error('system source symlink cycle')
      const target = await readlink(current)
      if (stamp(await lstat(current)) !== stamp(info)) throw new Error('system source link changed')
      links.push({ path: current, target, info })
      pending = [...resolve(dirname(current), target).split('/').filter(Boolean), ...pending]
      current = '/'
    } else if (!info.isFile() && !info.isDirectory()) throw new Error('special system source forbidden')
    else if (pending.length && !info.isDirectory()) throw new Error('invalid system source parent')
  }
  const info = await lstat(current)
  if (info.uid !== 0 || info.mode & 0o022 || !info.isFile() && !info.isDirectory()) throw new Error('system source changed after resolution')
  return { path: current, info, links }
}

async function sourceBytes(source: Source, destination?: string, signal?: AbortSignal): Promise<{ sha256: string; prefix: Buffer }> {
  const fd = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output: FileHandle | undefined
  try {
    output = destination ? await open(destination, 'wx', 0o600) : undefined
    if (stamp(await fd.stat()) !== stamp(source.info) || await realpath(`/proc/self/fd/${fd.fd}`) !== source.path) throw new Error('system source descriptor changed')
    if (source.info.size > linuxSystemSnapshotLimits.bytes) throw new Error('system source size bound exceeded')
    const buffer = Buffer.alloc(65536), hash = createHash('sha256')
    let offset = 0, prefix = Buffer.alloc(0)
    while (offset < source.info.size) {
      checkAbort(signal)
      const result = await fd.read(buffer, 0, Math.min(buffer.length, source.info.size - offset), offset)
      if (!result.bytesRead) throw new Error('system source truncated')
      const chunk = buffer.subarray(0, result.bytesRead)
      if (!offset) prefix = Buffer.from(chunk.subarray(0, 4096))
      hash.update(chunk)
      if (output) {
        let written = 0
        while (written < chunk.length) {
          const result = await output.write(chunk, written, chunk.length - written)
          if (!result.bytesWritten) throw new Error('system snapshot copy stalled')
          written += result.bytesWritten
        }
      }
      offset += result.bytesRead
    }
    if ((await fd.read(buffer, 0, 1, offset)).bytesRead) throw new Error('system source grew')
    if (stamp(await fd.stat()) !== stamp(source.info) || stamp(await lstat(source.path)) !== stamp(source.info)) throw new Error('system source changed')
    return { sha256: hash.digest('hex'), prefix }
  } finally { try { await output?.close() } finally { await fd.close() } }
}

interface Elf { interpreter?: string; needed: string[]; search: string[]; inherit: boolean }
/** Metadata reads are bounded independently of ELF size; no loader or inspection executable runs. */
export async function parseLinuxSystemElf(readAt: (offset: number, length: number) => Promise<Buffer>, size: number, path: string): Promise<Elf | undefined> {
  const read = async (offset: number, length: number, limit = 4 * 1024 * 1024): Promise<Buffer> => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || length > limit || offset + length > size) throw new Error(`ELF range invalid or metadata bound exceeded: ${path}`)
    const result = await readAt(offset, length)
    if (result.length !== length) throw new Error('ELF metadata truncated')
    return result
  }
  const header = await read(0, Math.min(size, 64))
  if (header.length < 4 || header.subarray(0, 4).toString('hex') !== '7f454c46') return undefined
  if (header.length < 64 || header[4] !== 2 || header[5] !== 1
    || header.readUInt16LE(18) !== (process.arch === 'x64' ? 62 : process.arch === 'arm64' ? 183 : -1)) throw new Error(`unsupported system ELF: ${path}`)
  const number = (buffer: Buffer, offset: number): number => {
    const value = Number(buffer.readBigUInt64LE(offset))
    if (!Number.isSafeInteger(value)) throw new Error('ELF integer overflow')
    return value
  }
  const cstring = (buffer: Buffer, offset: number): string => {
    const end = buffer.indexOf(0, offset)
    if (offset < 0 || end < offset || end - offset > 4096) throw new Error('ELF string invalid or over bound')
    return buffer.subarray(offset, end).toString('utf8')
  }
  if (header.readUInt16LE(16) === 1) return { needed: [], search: [], inherit: false }
  const segments: Array<{ type: number; offset: number; address: number; size: number }> = []
  const start = number(header, 32), width = header.readUInt16LE(54), count = header.readUInt16LE(56)
  if (count > 4096 || width < 56 || width > 256) throw new Error('ELF program table invalid')
  const programs = await read(start, count * width)
  for (let i = 0; i < count; i++) {
    const offset = width * i
    segments.push({ type: programs.readUInt32LE(offset), offset: number(programs, offset + 8),
      address: number(programs, offset + 16), size: number(programs, offset + 32) })
  }
  for (const type of [2, 3]) if (segments.filter(segment => segment.type === type).length > 1) throw new Error('duplicate ELF program metadata')
  const result: Elf = { needed: [], search: [], inherit: false }
  const interpreter = segments.find(s => s.type === 3)
  if (interpreter) result.interpreter = cstring(await read(interpreter.offset, interpreter.size, 4096), 0)
  const dynamic = segments.find(s => s.type === 2)
  if (!dynamic) return result
  const table = await read(dynamic.offset, dynamic.size, 256 * 1024), tags: Array<[number, number]> = []
  for (let offset = 0; offset + 16 <= table.length; offset += 16) {
    const tag = Number(table.readBigInt64LE(offset)), value = number(table, offset + 8)
    if (!tag) break
    tags.push([tag, value])
  }
  for (const type of [5, 10, 15, 29]) if (tags.filter(([tag]) => tag === type).length > 1) throw new Error('duplicate ELF dynamic metadata')
  const address = tags.find(([tag]) => tag === 5)?.[1], length = tags.find(([tag]) => tag === 10)?.[1]
  if (address === undefined || length === undefined) {
    if (tags.some(([tag]) => tag === 1)) throw new Error('ELF string table missing')
    return result
  }
  const segment = segments.find(s => s.type === 1 && address >= s.address && address + length <= s.address + s.size)
  if (!segment) throw new Error('ELF string table unmapped')
  const strings = await read(segment.offset + address - segment.address, length, 8 * 1024 * 1024)
  if (tags.filter(([tag]) => tag === 1).length > 512) throw new Error('ELF dependency count bound exceeded')
  result.needed = tags.filter(([tag]) => tag === 1).map(([, offset]) => cstring(strings, offset))
  const runpath = tags.find(([tag]) => tag === 29)
  const rpath = tags.find(([tag]) => tag === 15)
  const searches = new Map<number, string[]>()
  for (const entry of [rpath, runpath]) {
    if (!entry) continue
    const paths: string[] = []
    const directories = cstring(strings, entry[1]).split(':')
    if (directories.length > 64) throw new Error('ELF search directory count bound exceeded')
    for (const value of directories) {
      const expanded = value.replace(/\$\{ORIGIN\}|\$ORIGIN(?=\/|$)/gu, dirname(path))
      if (!isAbsolute(expanded) || expanded.includes('$') || [...expanded].some(character => character.charCodeAt(0) < 32)) throw new Error(`unsupported ELF search path: ${path}`)
      const directory = resolve(expanded)
      const approved = (value: string): boolean => ['/usr/lib', '/usr/lib64', '/lib', '/lib64'].some(root => value === root || value.startsWith(root + '/'))
        || value === dirname(path) && /^\/usr\/(?:bin|sbin|libexec)\//u.test(path)
      if (!approved(directory)) throw new Error(`unsafe ELF search directory: ${directory}`)
      const source = await inspectTrustedLinuxSystemSource(directory).catch(() => { throw new Error(`unsafe ELF search directory: ${directory}`) })
      if (!source.info.isDirectory() || !approved(source.path)) throw new Error(`unsafe ELF search directory: ${directory}`)
      paths.push(directory)
    }
    searches.set(entry[0], paths)
  }
  result.inherit = !runpath && Boolean(rpath)
  result.search = searches.get(runpath ? 29 : 15) ?? []
  return result
}

async function sourceElf(source: Source, signal?: AbortSignal, virtualPath = source.path): Promise<Elf | undefined> {
  const fd = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (stamp(await fd.stat()) !== stamp(source.info) || await realpath(`/proc/self/fd/${fd.fd}`) !== source.path) throw new Error('system ELF descriptor changed')
    const result = await parseLinuxSystemElf(async (offset, length) => {
      checkAbort(signal)
      const buffer = Buffer.alloc(length)
      let used = 0
      while (used < length) {
        const part = await fd.read(buffer, used, length - used, offset + used)
        if (!part.bytesRead) throw new Error('system ELF truncated')
        used += part.bytesRead
      }
      return buffer
    }, source.info.size, virtualPath)
    if (stamp(await fd.stat()) !== stamp(source.info) || stamp(await lstat(source.path)) !== stamp(source.info)) throw new Error('system ELF source changed')
    return result
  } finally { await fd.close() }
}

/** The destination must be fresh, below a canonical owner-private directory. */
export async function prepareLinuxSystemSnapshot(root: string, signal?: AbortSignal, runtime?: LinuxRuntime): Promise<LinuxSystemSnapshot> {
  if (process.platform !== 'linux' || !canonical(root) || root === '/') throw new Error('invalid system snapshot destination')
  checkAbort(signal)
  const parent = await lstat(dirname(root))
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o077
    || await realpath(dirname(root)) !== dirname(root)) throw new Error('system snapshot parent must be owner-private')
  const fixedRuntime = runtime ? await verifyLinuxRuntime(runtime) : undefined
  checkAbort(signal)
  await mkdir(root, { mode: 0o700 })
  const created = await lstat(root)
  const origins = new Map<string, Origin>(), sources = new Map<string, { info: Stats; digest: string | undefined }>()
  const programs: Record<string, string> = {}
  const expandedDirectories = new Set<string>()
  const activeDirectories = new Set<string>()
  const metadataByPath = new Map<string, Elf | undefined>()
  const scriptByPath = new Map<string, string>()
  const contexts = new Set<string>()
  const resolutions = new Map<string, string>()
  let bytes = 0, entries = 1
  const architecture = process.arch === 'x64' ? 'x86_64-linux-gnu' : process.arch === 'arm64' ? 'aarch64-linux-gnu' : ''
  const libraryDirs = [`/lib/${architecture}`, `/usr/lib/${architecture}`, '/lib64', '/usr/lib64', '/lib', '/usr/lib']
  const allocate = (size = 0): void => {
    checkAbort(signal)
    bytes += size
    if (++entries > linuxSystemSnapshotLimits.entries || bytes > linuxSystemSnapshotLimits.bytes) throw new Error('system snapshot size bound exceeded')
  }
  const remember = (path: string, info: Stats, digest?: string): void => {
    const old = sources.get(path)
    if (old && (stamp(old.info) !== stamp(info) || old.digest && digest && old.digest !== digest)) throw new Error('system source changed during preparation')
    sources.set(path, { info, digest: digest ?? old?.digest })
  }
  const directory = async (path: string): Promise<void> => {
    if (path === '/' || origins.has(path)) return
    await directory(dirname(path))
    const source = await inspectTrustedLinuxSystemSource(path)
    if (source.path !== path || !source.info.isDirectory()) throw new Error('noncanonical system directory')
    allocate()
    remember(path, source.info)
    await mkdir(join(root, path), { mode: 0o755 })
    await chmod(join(root, path), 0o755)
    origins.set(path, { path, source: path, sourceMode: source.info.mode & 0o7777, kind: 'dir', mode: 0o755 })
  }
  const optional = async (path: string): Promise<boolean> => {
    try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  const library = async (name: string, search: string[]): Promise<string> => {
    if (!name || name === '.' || name === '..' || name.includes('/')) throw new Error(`unsupported ELF dependency: ${name}`)
    for (const dirs of [search, libraryDirs]) {
      const matches = new Map<string, string>()
      for (const dir of dirs) {
        const path = join(dir, name)
        if (await optional(path)) matches.set((await inspectTrustedLinuxSystemSource(path)).path, path)
      }
      if (matches.size > 1) throw new Error(`ambiguous system library: ${name}`)
      if (matches.size) return [...matches.values()][0]!
    }
    throw new Error(`missing system library: ${name}`)
  }
  const add = async (requested: string, recursive = true, inherited: string[] = []): Promise<void> => {
    checkAbort(signal)
    const source = await inspectTrustedLinuxSystemSource(requested)
    if (!source.path.startsWith('/usr/') && !source.path.startsWith('/etc/alternatives/')
      && !source.path.startsWith('/etc/ssl/certs/') && source.path !== '/etc/ssl/certs'
      && !source.path.startsWith('/run/systemd/resolve/')
      && !/^\/etc\/python[0-9]+\.[0-9]+\/sitecustomize\.py$/u.test(source.path)
      && !['/etc/ssl/openssl.cnf', '/etc/nsswitch.conf', '/etc/hosts', '/etc/resolv.conf'].includes(source.path)) {
      throw new Error(`system source escaped the fixed data roots: ${source.path}`)
    }
    for (const link of source.links) {
      if (origins.has(link.path)) continue
      await directory(dirname(link.path))
      const target = resolve(dirname(link.path), link.target)
      // Link paths are retained, but absolute host targets become relative guest targets.
      allocate()
      remember(link.path, link.info)
      await symlink(relative(dirname(link.path), target) || '.', join(root, link.path))
      origins.set(link.path, { path: link.path, source: link.path, sourceMode: link.info.mode & 0o7777, kind: 'link', mode: 0o777, sourceTarget: link.target, target: relative(dirname(link.path), target) || '.' })
    }
    if (source.info.isDirectory()) {
      await directory(source.path)
      if (recursive && !expandedDirectories.has(source.path)) {
        if (activeDirectories.has(source.path)) throw new Error('system source directory link cycle')
        activeDirectories.add(source.path)
        for (const name of (await readdir(source.path)).sort()) {
          if (name !== '__pycache__' && !name.endsWith('.pyc')) await add(join(source.path, name))
        }
        activeDirectories.delete(source.path)
        expandedDirectories.add(source.path)
      }
      return
    }
    if (!source.info.isFile()) throw new Error('special system source forbidden')
    if (!origins.has(source.path)) {
      allocate(source.info.size)
      await directory(dirname(source.path))
      const { sha256: digest, prefix: content } = await sourceBytes(source, join(root, source.path), signal)
      remember(source.path, source.info, digest)
      const mode = source.info.mode & 0o111 ? 0o555 : 0o444
      await chmod(join(root, source.path), mode)
      origins.set(source.path, { path: source.path, source: source.path, sourceMode: source.info.mode & 0o7777, kind: 'file', mode, size: source.info.size, sha256: digest })
      metadataByPath.set(source.path, await sourceElf(source, signal))
      if (source.info.mode & 0o111 && /^\/usr\/(?:s?bin\/|lib(?:exec)?\/git-core\/)/u.test(source.path)
        && content.subarray(0, 2).toString() === '#!') {
        const newline = content.indexOf(10)
        const interpreter = content.subarray(2, newline < 0 ? Math.min(content.length, 4096) : Math.min(newline, 4096)).toString().trim().split(/\s+/u)[0]!
        if (!canonical(interpreter)) throw new Error('unsupported system script interpreter')
        scriptByPath.set(source.path, interpreter)
      }
    }
    const context = JSON.stringify([source.path, inherited])
    if (contexts.has(context)) return
    if (contexts.size >= linuxSystemSnapshotLimits.entries) throw new Error('system ELF context bound exceeded')
    contexts.add(context)
    const metadata = metadataByPath.get(source.path)
    const search = [...new Set([...(metadata?.inherit ? metadata.search : []), ...inherited,
      ...(!metadata?.inherit ? metadata?.search ?? [] : [])])]
    const nextInherited = metadata?.inherit ? search : inherited
    if (metadata?.interpreter) await add(metadata.interpreter)
    for (const needed of metadata?.needed ?? []) {
      const dependency = await library(needed, search)
      const target = (await inspectTrustedLinuxSystemSource(dependency)).path
      const key = source.path + ':' + needed, previous = resolutions.get(key)
      if (previous && previous !== target) throw new Error('ambiguous inherited system ELF dependency')
      resolutions.set(key, target)
      await add(dependency, true, nextInherited)
    }
    const interpreter = scriptByPath.get(source.path)
    if (interpreter) await add(interpreter)
  }

  const probe = async (path: string, args: string[]): Promise<string> => {
    await add(path)
    const source = await inspectTrustedLinuxSystemSource(path)
    const before = (await sourceBytes(source, undefined, signal)).sha256
    const result = await exec(source.path, args, { timeout: 5000, maxBuffer: 64 * 1024, signal, cwd: '/',
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' } })
    if ((await sourceBytes(source, undefined, signal)).sha256 !== before) throw new Error('system probe changed')
    programs[path + ' ' + args.join(' ')] = result.stdout.trim()
    return result.stdout.trim()
  }
  try {
    if (!architecture) throw new Error('unsupported system snapshot architecture')
    for (const name of tools) await add(`/usr/bin/${name}`)
    for (const alias of ['/bin', '/sbin', '/lib', '/lib64']) if (await optional(alias)) await add(alias, false)
    const python = await probe('/usr/bin/python3', ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("stdlib"))'])
    if (!/^\/usr\/lib\/python[0-9.]+$/u.test(python)) throw new Error('unexpected Python standard library')
    await add(python)
    const perl = await probe('/usr/bin/perl', ['-T', '-MConfig', '-e', 'print "$Config{privlib}\n$Config{archlib}\n"'])
    for (const path of perl.split('\n')) {
      if (!/^\/usr\/(?:lib|share)\/[a-zA-Z0-9_./-]+$/u.test(path)) throw new Error('unexpected Perl library')
      await add(path)
    }
    const git = await probe('/usr/bin/git', ['--exec-path'])
    if (!/^\/usr\/lib(?:exec)?\/git-core$/u.test(git)) throw new Error('unexpected Git exec path')
    for (const path of [git, '/usr/share/git-core/templates', '/etc/ssl/certs', '/etc/ssl/openssl.cnf',
      `/usr/lib/${architecture}/ossl-modules`, `/usr/lib/${architecture}/engines-3`,
      '/usr/lib/terminfo', '/usr/share/terminfo', '/usr/share/zoneinfo/UTC', '/etc/nsswitch.conf', '/etc/hosts', '/etc/resolv.conf']) {
      if (await optional(path)) await add(path)
    }
    // Preserve OpenSSL's compiled public defaults without copying the ssl
    // directory: its private-key alias and maintenance scripts are excluded.
    for (const [alias, target] of [['/usr/lib/ssl/openssl.cnf', '/etc/ssl/openssl.cnf'],
      ['/usr/lib/ssl/certs', '/etc/ssl/certs'], ['/usr/lib/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt']] as const) {
      if (!await optional(alias)) continue
      const source = await inspectTrustedLinuxSystemSource(alias)
      const approved = await inspectTrustedLinuxSystemSource(target)
      if (source.path !== approved.path) throw new Error('unexpected public OpenSSL alias target')
      await add(alias, false)
    }
    for (const name of ['libseccomp.so.2', 'libatomic.so.1', 'libnss_files.so.2', 'libnss_dns.so.2',
      'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libstdc++.so.6', 'libgcc_s.so.1']) await add(await library(name, []))
    if (await optional('/usr/bin/gcc')) {
      for (const name of ['cc', 'gcc', 'g++', 'c++', 'as', 'ld', 'ar', 'ranlib', 'nm', 'strip', 'objcopy', 'objdump', 'readelf']) if (await optional(`/usr/bin/${name}`)) await add(`/usr/bin/${name}`)
      const gcc = await probe('/usr/bin/gcc', ['-print-libgcc-file-name'])
      if (!gcc.startsWith(`/usr/lib/gcc/${architecture}/`) || basename(gcc) !== 'libgcc.a') throw new Error('unexpected GCC library directory')
      await add(dirname(gcc))
      await add('/usr/include')
      const scripts = `/usr/lib/${architecture}/ldscripts`
      if (await optional(scripts)) await add(scripts)
      for (const name of ['crt1.o', 'Scrt1.o', 'crti.o', 'crtn.o', 'libc.so', 'libc.a', 'libc_nonshared.a', 'libm.so', 'libm.a', 'libmvec.so', 'libmvec.a', 'libpthread.a', 'libdl.a', 'librt.a']) {
        const path = `/usr/lib/${architecture}/${name}`
        if (await optional(path)) await add(path)
      }
    }
    if (fixedRuntime) {
      const path = fixedRuntime.nodePath, source: Source = { path, info: await lstat(path), links: [] }
      if (await realpath(path) !== path || !source.info.isFile() || source.info.uid !== process.getuid?.()
        || source.info.nlink !== 1 || source.info.mode & 0o022 || !(source.info.mode & 0o111)) throw new Error('unsafe pinned runtime Node')
      allocate(source.info.size)
      await directory('/usr/bin')
      const copied = await sourceBytes(source, join(root, 'usr/bin/node'), signal)
      if (copied.sha256 !== fixedRuntime.nodeSha256) throw new Error('pinned runtime Node digest differs')
      await chmod(join(root, 'usr/bin/node'), 0o555)
      remember(path, source.info, copied.sha256)
      origins.set('/usr/bin/node', { path: '/usr/bin/node', source: path, sourceMode: source.info.mode & 0o7777,
        kind: 'pinned-runtime-node', mode: 0o555, size: source.info.size, sha256: copied.sha256,
        pinnedNodeRuntimeDigest: pinnedNodeRuntimeDigest(fixedRuntime) })
      const metadata = await sourceElf(source, signal)
      if (!metadata) throw new Error('pinned runtime Node is not ELF')
      if (metadata.interpreter) await add(metadata.interpreter)
      for (const name of metadata.needed) await add(await library(name, metadata.search), true, metadata.inherit ? metadata.search : [])
    }
    for (const [path, args] of [['/usr/bin/bash', ['--version']], ['/usr/bin/git', ['--version']],
      ['/usr/bin/openssl', ['version']], ['/usr/bin/python3', ['--version']], ['/usr/bin/bwrap', ['--version']]] as const) {
      await probe(path, [...args])
    }
    for (const [path, record] of sources) {
      checkAbort(signal)
      const current = await lstat(path)
      if (stamp(current) !== stamp(record.info) || record.digest && (await sourceBytes({ path, info: current, links: [] }, undefined, signal)).sha256 !== record.digest) throw new Error('system source changed before commit')
    }
    const manifest: Manifest = { schemaVersion: 1, platform: `linux-${process.arch}`, tools: programs,
      origins: [...origins.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) }
    const encoded = JSON.stringify(manifest) + '\n'
    if (Buffer.byteLength(encoded) > MAX_MANIFEST) throw new Error('system snapshot manifest bound exceeded')
    allocate(Buffer.byteLength(encoded))
    await writeFile(join(root, MANIFEST), encoded, { mode: 0o444, flag: 'wx' })
    await chmod(join(root, MANIFEST), 0o444)
    await chmod(root, 0o755)
    const info = await lstat(root)
    const snapshot: LinuxSystemSnapshot = { schemaVersion: 1, root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
      manifestSha256: sha(encoded), bytes, entries }
    checkAbort(signal)
    return await verifyLinuxSystemSnapshot(snapshot, signal)
  } catch (error) {
    const current = await lstat(root).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === 'ENOENT') return undefined
      throw failure
    })
    if (current && (current.dev !== created.dev || current.ino !== created.ino || !current.isDirectory() || current.uid !== process.getuid?.())) {
      throw new Error('system snapshot destination replaced; cleanup refused', { cause: error })
    }
    if (current) await rm(root, { recursive: true, force: true })
    throw error
  }
}

/** Verify actual modes, complete inventory and bytes, independently of live host sources. */
export async function verifyLinuxSystemSnapshot(value: LinuxSystemSnapshot, signal?: AbortSignal): Promise<LinuxSystemSnapshot> {
  checkAbort(signal)
  if (!value || Object.keys(value).sort().join() !== 'bytes,entries,manifestSha256,root,schemaVersion'
    || value.schemaVersion !== 1 || !value.root || Object.keys(value.root).sort().join() !== 'dev,ino,path,sha256'
    || !canonical(value.root.path) || value.root.path === '/' || !HEX.test(value.root.sha256) || !HEX.test(value.manifestSha256)
    || !Number.isSafeInteger(value.root.dev) || value.root.dev < 0 || !Number.isSafeInteger(value.root.ino) || value.root.ino < 0
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > linuxSystemSnapshotLimits.bytes
    || !Number.isSafeInteger(value.entries) || value.entries < 2 || value.entries > linuxSystemSnapshotLimits.entries) throw new Error('invalid system snapshot')
  const root = value.root.path, info = await lstat(root)
  if (await realpath(root) !== root || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o755
    || info.dev !== value.root.dev || info.ino !== value.root.ino) throw new Error('system snapshot root differs')
  const manifestInfo = await lstat(join(root, MANIFEST))
  if (!manifestInfo.isFile() || manifestInfo.size > MAX_MANIFEST || (manifestInfo.mode & 0o7777) !== 0o444) throw new Error('invalid system snapshot manifest')
  const encoded = await readFile(join(root, MANIFEST))
  if (sha(encoded) !== value.manifestSha256) throw new Error('system snapshot manifest differs')
  const manifest = JSON.parse(encoded.toString()) as Manifest
  if (manifest.schemaVersion !== 1 || manifest.platform !== `linux-${process.arch}` || !Array.isArray(manifest.origins)
    || manifest.origins.length + 2 !== value.entries) throw new Error('invalid system snapshot inventory')
  const expected = new Map<string, Origin>()
  for (const origin of manifest.origins) {
    if (!canonical(origin.path) || origin.path === '/' || expected.has(origin.path)
      || origin.path === '/' + MANIFEST || !['file', 'dir', 'link', 'pinned-runtime-node'].includes(origin.kind)
      || (origin.kind === 'pinned-runtime-node' ? origin.path !== '/usr/bin/node' || !canonical(origin.source)
        || origin.mode !== 0o555 || !HEX.test(origin.pinnedNodeRuntimeDigest ?? '')
        : origin.source !== origin.path || origin.pinnedNodeRuntimeDigest !== undefined)) throw new Error('invalid system snapshot origin')
    expected.set(origin.path, origin)
  }
  let bytes = encoded.length, entries = 1
  const visit = async (path: string): Promise<void> => {
    checkAbort(signal)
    if (++entries > linuxSystemSnapshotLimits.entries) throw new Error('system snapshot entry bound exceeded')
    const item = await lstat(path), name = '/' + relative(root, path), origin = expected.get(name)
    if (item.uid !== process.getuid?.()) throw new Error('system snapshot owner differs')
    if (name === '/' + MANIFEST) return
    if (!origin || (item.mode & 0o7777) !== origin.mode) throw new Error('system snapshot inventory differs')
    if (item.isSymbolicLink()) {
      const target = await readlink(path)
      const lexical = resolve(dirname(path), target)
      if (origin.kind !== 'link' || typeof origin.sourceTarget !== 'string'
        || resolve(dirname(origin.path), origin.sourceTarget) !== resolve(dirname(origin.path), target) || isAbsolute(target) || target !== origin.target || !lexical.startsWith(root + '/')
        || !(await realpath(path)).startsWith(root + '/')) throw new Error('system snapshot link escaped or differs')
    } else if (item.isDirectory()) {
      if (origin.kind !== 'dir' || origin.mode !== 0o755) throw new Error('system snapshot directory differs')
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else if (item.isFile()) {
      if (origin.kind !== 'file' && origin.kind !== 'pinned-runtime-node' || item.nlink !== 1 || ![0o444, 0o555].includes(origin.mode) || item.size !== origin.size
        || (bytes += item.size) > linuxSystemSnapshotLimits.bytes || (await sourceBytes({ path, info: item, links: [] }, undefined, signal)).sha256 !== origin.sha256) throw new Error('system snapshot file differs')
    } else throw new Error('system snapshot special file')
  }
  for (const child of (await readdir(root)).sort()) await visit(join(root, child))
  if (entries !== value.entries || bytes !== value.bytes || await hashLinuxRuntimeTree(root) !== value.root.sha256) throw new Error('system snapshot tree differs')
  checkAbort(signal)
  return Object.freeze({ ...value, root: Object.freeze({ ...value.root }) })
}

/** Unlike linuxRuntimeDigest, this provenance identity deliberately normalizes
 * the fixed derived paths so an atomic stage->final rename preserves identity. */
function pinnedNodeRuntimeDigest(value: LinuxRuntime): string {
  const runtime = validateLinuxRuntime(value)
  return sha(JSON.stringify({ schemaVersion: runtime.schemaVersion, backend: runtime.backend, platform: runtime.platform,
    sourceCommit: runtime.sourceCommit, lockSha256: runtime.lockSha256,
    root: { dev: runtime.root.dev, ino: runtime.root.ino, sha256: runtime.root.sha256 }, nodeSha256: runtime.nodeSha256,
    versions: { node: runtime.versions.node, pnpm: runtime.versions.pnpm, typescript: runtime.versions.typescript,
      cordis: runtime.versions.cordis, tools: runtime.versions.tools, systemPrompt: runtime.versions.systemPrompt } }))
}

/** Check the ABI closure of only the frozen runtime's selected Node/pnpm
 * binaries. Host programs are never selected by caller-supplied arbitrary paths. */
export async function verifyLinuxSystemSnapshotRuntimeDependencies(snapshot: LinuxSystemSnapshot, runtime: LinuxRuntime,
  signal?: AbortSignal): Promise<void> {
  snapshot = await verifyLinuxSystemSnapshot(snapshot, signal)
  runtime = await verifyLinuxRuntime(runtime)
  checkAbort(signal)
  const architecture = process.arch === 'x64' ? 'x86_64-linux-gnu' : process.arch === 'arm64' ? 'aarch64-linux-gnu' : ''
  if (!architecture) throw new Error('unsupported system runtime dependency architecture')
  const defaults = [`/lib/${architecture}`, `/usr/lib/${architecture}`, '/lib64', '/usr/lib64', '/lib', '/usr/lib']
  const seen = new Set<string>(), resolutions = new Map<string, string>()
  const guest = async (path: string): Promise<Source> => {
    if (!canonical(path)) throw new Error('noncanonical runtime system dependency')
    const actual = await realpath(join(snapshot.root.path, path))
    if (!actual.startsWith(snapshot.root.path + '/')) throw new Error('runtime system dependency escaped snapshot')
    const info = await lstat(actual)
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o222) throw new Error('unsafe runtime system dependency')
    return { path: actual, info, links: [] }
  }
  const library = async (name: string, search: string[]): Promise<Source> => {
    if (!name || name === '.' || name === '..' || name.includes('/')) throw new Error('unsupported runtime system dependency name')
    for (const group of [search, defaults]) {
      const matches = new Map<string, Source>()
      for (const directory of group) {
        try { const source = await guest(join(directory, name)); matches.set(source.path, source) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      if (matches.size > 1) throw new Error('ambiguous runtime system dependency')
      if (matches.size) return [...matches.values()][0]!
    }
    throw new Error(`missing runtime system dependency: ${name}`)
  }
  const visit = async (source: Source, virtual: string, inherited: string[]): Promise<void> => {
    checkAbort(signal)
    const key = JSON.stringify([source.path, inherited])
    if (seen.has(key)) return
    if (seen.size >= linuxSystemSnapshotLimits.entries) throw new Error('runtime system dependency context bound exceeded')
    seen.add(key)
    const metadata = await sourceElf(source, signal, virtual)
    if (!metadata) {
      const fd = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (stamp(await fd.stat()) !== stamp(source.info)) throw new Error('runtime script descriptor changed')
        const buffer = Buffer.alloc(4096), read = await fd.read(buffer, 0, buffer.length, 0)
        const line = buffer.subarray(0, read.bytesRead).toString().split('\n')[0]!
        const interpreter = /^#!\s*(\/[^\s]+)(?:\s.*)?$/u.exec(line)?.[1]
        if (!interpreter || !canonical(interpreter)) throw new Error('unsupported selected runtime executable')
        await visit(await guest(interpreter), interpreter, [])
        if (stamp(await fd.stat()) !== stamp(source.info)) throw new Error('runtime script changed')
      } finally { await fd.close() }
      return
    }
    const search = [...new Set([...(metadata.inherit ? metadata.search : []), ...inherited,
      ...(!metadata.inherit ? metadata.search : [])])]
    if (metadata.interpreter) await visit(await guest(metadata.interpreter), metadata.interpreter, [])
    for (const name of metadata.needed) {
      const dependency = await library(name, search), dependencyKey = source.path + ':' + name
      if (resolutions.has(dependencyKey) && resolutions.get(dependencyKey) !== dependency.path) throw new Error('ambiguous inherited runtime dependency')
      resolutions.set(dependencyKey, dependency.path)
      await visit(dependency, '/' + relative(snapshot.root.path, dependency.path), metadata.inherit ? search : inherited)
    }
  }
  for (const path of [runtime.nodePath, runtime.nativePnpmPath, join(runtime.nativePnpmRoot, 'node')]) {
    if (await realpath(path) !== path || !path.startsWith(runtime.root.path + '/')) throw new Error('selected runtime executable escaped')
    await visit({ path, info: await lstat(path), links: [] }, path, [])
  }
  const manifest = JSON.parse(await readFile(join(snapshot.root.path, MANIFEST), 'utf8')) as Manifest
  const alias = manifest.origins.find(origin => origin.path === '/usr/bin/node')
  if (!alias || alias.kind !== 'pinned-runtime-node' || alias.sha256 !== runtime.nodeSha256
    || alias.pinnedNodeRuntimeDigest !== pinnedNodeRuntimeDigest(runtime)) throw new Error('pinned runtime Node provenance differs')
  checkAbort(signal)
}
