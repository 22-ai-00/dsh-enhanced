import { createHash, createPublicKey } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson } from '@dsh-enhanced/assistant-growth-contract'
import { creationCapabilityAuthorityDigest, creationCapabilityPublicKey, validateCreationCapabilityConfig } from './creation-capability-journal.js'
import type { CreationCapabilityConfig } from './creation-capability-types.js'

// Shared by the empty and sealed Docker→Linux adoption handoffs. Each handoff binds these
// primitives to its own error prefix so its messages stay unchanged.
const APP = 0x44534341
// Exact schema3 produced by the reviewed CreationCapabilityJournal constructor.
const SCHEMA = 'f91ee0ecdbb43d7a4305075d70f13bfa492f7d46c1ff3d3f59e1ca1a155f23a8'
export const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export const encode = (value: unknown) => canonicalGrowthJson(value)
export const hash = (value: unknown) => sha(encode(value))
export function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
export interface FileIdentity { dev: string; ino: string; uid: number; gid: number; mode: number; nlink: number }
export interface FileSnapshot { identity: FileIdentity; bytes: number; digest: string }
export interface AdoptionAuthorityIdentity {
  logicalPath: string
  config: CreationCapabilityConfig
  authorityDigest: string
  publicKey: string
  keyFingerprint: string
}
export interface HandoffAuditSchema { table: string; statements: readonly string[] }

export function handoffPrimitives(fail: (message: string) => never) {
  function identity(file: string): FileIdentity {
    const stat = lstatSync(file)
    if (realpathSync(file) !== file || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o077) !== 0) fail('unsafe file')
    return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink }
  }
  function directory(file: string) {
    const stat = lstatSync(file)
    if (realpathSync(file) !== file || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail('unsafe directory')
  }
  function absolute(file: string) {
    if (typeof file !== 'string' || !isAbsolute(file) || resolve(file) !== file || file.normalize('NFC') !== file || /[\p{Cc}]/u.test(file)) fail('invalid path')
  }
  function noSidecars(file: string) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { lstatSync(file + suffix) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      fail('sidecar requires stopped checkpointed database')
    }
  }
  /** Stable read of one private file; returns the exact bytes with their snapshot. */
  function read(file: string, max: number): { value: Buffer; snapshot: FileSnapshot } {
    const expected = identity(file), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(fd, { bigint: true })
      if (String(before.dev) !== expected.dev || String(before.ino) !== expected.ino || before.size > BigInt(max)) fail('file changed or too large')
      const value = readFileSync(fd), after = fstatSync(fd, { bigint: true })
      if (value.length !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs || encode(identity(file)) !== encode(expected)) fail('file changed while reading')
      return { value, snapshot: { identity: expected, bytes: value.length, digest: sha(value) } }
    } finally { closeSync(fd) }
  }
  const bytes = (file: string, max: number): FileSnapshot => read(file, max).snapshot
  function publicIdentity(logicalPath: string, config: CreationCapabilityConfig): AdoptionAuthorityIdentity {
    absolute(logicalPath)
    if (basename(logicalPath) !== 'creation-adoptions.sqlite') fail('invalid logical journal')
    validateCreationCapabilityConfig(config)
    const key = bytes(config.keyPath, 32768)
    const result = { logicalPath, config: structuredClone(config),
      authorityDigest: creationCapabilityAuthorityDigest({ path: logicalPath, config }),
      publicKey: creationCapabilityPublicKey(config), keyFingerprint: '' }
    result.keyFingerprint = sha(createPublicKey(result.publicKey).export({ type: 'spki', format: 'der' }))
    if (encode(key) !== encode(bytes(config.keyPath, 32768))) fail('key changed')
    return result
  }
  function identities(logicalPath: string, oldConfig: CreationCapabilityConfig, nextConfig: CreationCapabilityConfig) {
    const oldIdentity = publicIdentity(logicalPath, oldConfig), nextIdentity = publicIdentity(logicalPath, nextConfig)
    const stable = (config: CreationCapabilityConfig) => {
      const { runner, ...grant } = config
      const { backend: _backend, runtime: _runtime, cgroupRoots: _cgroups, stateSeal: _seal,
        image: _image, dockerPath: _docker, socketPath: _socket, ...budget } = runner as unknown as Record<string, unknown>
      return { grant, runner: budget }
    }
    if (encode(stable(oldConfig)) !== encode(stable(nextConfig)) || oldIdentity.publicKey !== nextIdentity.publicKey
      || oldIdentity.keyFingerprint !== nextIdentity.keyFingerprint || oldIdentity.authorityDigest === nextIdentity.authorityDigest) fail('stable grant changed or unchanged authority')
    if ('backend' in oldConfig.runner || !('backend' in nextConfig.runner) || nextConfig.runner.backend !== 'linux-native') fail('only reviewed Docker to Linux handoff is supported')
    return { oldIdentity, nextIdentity }
  }
  function text(raw: unknown): string {
    if (!(raw instanceof Uint8Array)) fail('non-text bytes')
    let decoded: string
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { fail('invalid UTF-8 text') }
    if (decoded.includes('\0') || !Buffer.from(decoded, 'utf8').equals(raw)) fail('noncanonical text bytes')
    return decoded
  }
  function textRows(db: DatabaseSync, table: string, columns: readonly string[], order = ''): Record<string, string>[] {
    const rows = db.prepare(`SELECT ${columns.map(column => `CAST(${column} AS BLOB) AS ${column}`).join(',')} FROM ${table} ${order}`).all()
    return rows.map(row => Object.fromEntries(columns.map(column => [column, text(row[column])])))
  }
  function schema(db: DatabaseSync, audit: HandoffAuditSchema, audited: boolean) {
    if (db.prepare('PRAGMA application_id').get()?.application_id !== APP || db.prepare('PRAGMA user_version').get()?.user_version !== 3) fail('schema version mismatch')
    const objects = textRows(db, 'sqlite_schema', ['type', 'name', 'tbl_name', 'sql'], 'ORDER BY type,name')
    const base = objects.filter(row => row.tbl_name !== audit.table)
    if (sha(JSON.stringify(base)) !== SCHEMA) fail('schema bytes mismatch')
    const rows = objects.filter(row => row.tbl_name === audit.table)
    if (audited ? rows.length !== audit.statements.length || audit.statements.some(sql => !rows.some(row => row.sql === sql)) : rows.length !== 0) fail('unexpected audit schema')
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('database integrity mismatch')
  }
  function authority(db: DatabaseSync, expected: AdoptionAuthorityIdentity) {
    const rows = textRows(db, 'authority', ['authority_id', 'authority_digest', 'key_id', 'public_key', 'config_json'])
    if (rows.length !== 1 || encode(rows[0]) !== encode({ authority_id: expected.config.authorityId,
      authority_digest: expected.authorityDigest, key_id: expected.config.keyId, public_key: expected.publicKey,
      config_json: encode(expected.config) })) fail('authority singleton mismatch')
  }
  /** CAS the singleton authority row from the old to the next identity inside the caller's transaction. */
  function swapAuthority(db: DatabaseSync, oldIdentity: AdoptionAuthorityIdentity, nextIdentity: AdoptionAuthorityIdentity) {
    const result = db.prepare('UPDATE authority SET authority_digest=?,config_json=? WHERE authority_id=? AND authority_digest=? AND key_id=? AND public_key=? AND config_json=?')
      .run(nextIdentity.authorityDigest, encode(nextIdentity.config), oldIdentity.config.authorityId,
        oldIdentity.authorityDigest, oldIdentity.config.keyId, oldIdentity.publicKey, encode(oldIdentity.config))
    if (result.changes !== 1) fail('authority compare-and-swap failed')
  }
  function businessCounts(db: DatabaseSync) {
    const n = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)
    return { adoptions: n('adoptions'), calls: n('calls'), sourceArchives: n('source_archives') }
  }
  function empty(db: DatabaseSync) {
    for (const table of ['adoptions', 'calls', 'source_archives']) if (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n !== 0) fail('nonempty business journal is unsupported')
  }
  function openExisting<T>(file: string, action: (db: DatabaseSync) => T, write = false): T {
    absolute(file); if (basename(file) !== 'creation-adoptions.sqlite') fail('invalid physical journal')
    directory(dirname(file)); noSidecars(file)
    const expected = identity(file)
    // Keep the original descriptor alive and recheck the named inode before any SQL.
    const fd = openSync(file, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let db: DatabaseSync | undefined
    try {
      const held = fstatSync(fd)
      if (String(held.dev) !== expected.dev || String(held.ino) !== expected.ino) fail('opened identity mismatch')
      const locator = pathToFileURL(file)
      locator.searchParams.set('mode', write ? 'rw' : 'ro')
      // immutable is safe only after the stopped-file/no-sidecar checks; rehash the plan snapshot.
      if (!write) locator.searchParams.set('immutable', '1')
      db = new DatabaseSync(locator, { readOnly: !write })
      if (encode(identity(file)) !== encode(expected)) fail('named identity changed')
      db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON')
      return action(db)
    } finally { db?.close(); closeSync(fd) }
  }
  function exact(value: unknown, keys: readonly string[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== keys.length) fail('unexpected fields')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).sort().join('\0') !== [...keys].sort().join('\0')
      || !Object.values(descriptors).every(descriptor => descriptor.enumerable && 'value' in descriptor)) fail('unexpected fields')
  }
  return { identity, directory, absolute, noSidecars, read, bytes, publicIdentity, identities, text, textRows,
    schema, authority, swapAuthority, businessCounts, empty, openExisting, exact }
}
