import { createHash, createPublicKey } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson } from '@dsh-enhanced/assistant-growth-contract'
import { creationCapabilityAuthorityDigest, creationCapabilityPublicKey, validateCreationCapabilityConfig } from './creation-capability-journal.js'
import type { CreationCapabilityConfig } from './creation-capability-types.js'

const PROTOCOL = 'dsh-empty-creation-adoption-handoff/v1' as const
const APP = 0x44534341
// Exact schema3 produced by the reviewed CreationCapabilityJournal constructor.
const SCHEMA = 'f91ee0ecdbb43d7a4305075d70f13bfa492f7d46c1ff3d3f59e1ca1a155f23a8'
const AUDIT = 'creation_empty_authority_handoff'
const AUDIT_SQL = `CREATE TABLE ${AUDIT} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), proof_json TEXT NOT NULL, proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64)) STRICT`
const NO_UPDATE = `CREATE TRIGGER creation_empty_handoff_no_update BEFORE UPDATE ON ${AUDIT} BEGIN SELECT RAISE(ABORT,'immutable empty authority handoff'); END`
const NO_DELETE = `CREATE TRIGGER creation_empty_handoff_no_delete BEFORE DELETE ON ${AUDIT} BEGIN SELECT RAISE(ABORT,'immutable empty authority handoff'); END`
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown) => canonicalGrowthJson(value)
const hash = (value: unknown) => sha(encode(value))
function fail(message: string): never { throw new Error(`empty adoption authority handoff: ${message}`) }
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
interface FileIdentity { dev: string; ino: string; uid: number; gid: number; mode: number; nlink: number }
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
function bytes(file: string, max: number) {
  const expected = identity(file), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (String(before.dev) !== expected.dev || String(before.ino) !== expected.ino || before.size > BigInt(max)) fail('file changed or too large')
    const value = readFileSync(fd), after = fstatSync(fd, { bigint: true })
    if (value.length !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || encode(identity(file)) !== encode(expected)) fail('file changed while reading')
    return { identity: expected, bytes: value.length, digest: sha(value) }
  } finally { closeSync(fd) }
}
export interface EmptyAdoptionIdentity {
  logicalPath: string
  config: CreationCapabilityConfig
  authorityDigest: string
  publicKey: string
  keyFingerprint: string
}
function publicIdentity(logicalPath: string, config: CreationCapabilityConfig): EmptyAdoptionIdentity {
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
/** Trusted stopped-Host caller must independently verify the source copy and old/next configuration,
 * and bind that provenance in hostAnchor. Freeze the generated plan digest separately. This API does not
 * attest that an arbitrary empty clone originated from a particular live Home. */
export interface EmptyAdoptionScope {
  physicalPath: string
  logicalPath: string
  transactionId: string
  hostAnchor: string
  oldConfig: CreationCapabilityConfig
  nextConfig: CreationCapabilityConfig
  now: number
  expiresAt: number
}
export interface EmptyAdoptionPlan {
  protocol: typeof PROTOCOL
  transactionId: string
  hostAnchor: string
  physicalPath: string
  oldIdentity: EmptyAdoptionIdentity
  nextIdentity: EmptyAdoptionIdentity
  snapshot: ReturnType<typeof bytes>
  createdAt: number
  expiresAt: number
  digest: string
}
export interface EmptyAdoptionProof {
  protocol: typeof PROTOCOL
  plan: EmptyAdoptionPlan
  fileIdentity: FileIdentity
  emptyBusiness: { adoptions: 0; calls: 0; sourceArchives: 0 }
  digest: string
}
function textRows(db: DatabaseSync, table: string, columns: readonly string[], order = ''): Record<string, string>[] {
  const rows = db.prepare(`SELECT ${columns.map(column => `CAST(${column} AS BLOB) AS ${column}`).join(',')} FROM ${table} ${order}`).all()
  return rows.map(row => Object.fromEntries(columns.map(column => {
    const raw = row[column]
    if (!(raw instanceof Uint8Array)) fail('non-text bytes')
    let decoded: string
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { fail('invalid UTF-8 text') }
    if (decoded.includes('\0') || !Buffer.from(decoded, 'utf8').equals(raw)) fail('noncanonical text bytes')
    return [column, decoded]
  })))
}
function schema(db: DatabaseSync, audited: boolean) {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== APP || db.prepare('PRAGMA user_version').get()?.user_version !== 3) fail('schema version mismatch')
  const objects = textRows(db, 'sqlite_schema', ['type', 'name', 'tbl_name', 'sql'], 'ORDER BY type,name')
  const base = objects.filter(row => row.tbl_name !== AUDIT)
  if (sha(JSON.stringify(base)) !== SCHEMA) fail('schema bytes mismatch')
  const audit = objects.filter(row => row.tbl_name === AUDIT)
  if (audited ? audit.length !== 3 || [AUDIT_SQL, NO_UPDATE, NO_DELETE].some(sql => !audit.some(row => row.sql === sql)) : audit.length !== 0) fail('unexpected audit schema')
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('database integrity mismatch')
}
function authority(db: DatabaseSync, expected: EmptyAdoptionIdentity) {
  const rows = textRows(db, 'authority', ['authority_id', 'authority_digest', 'key_id', 'public_key', 'config_json'])
  if (rows.length !== 1 || encode(rows[0]) !== encode({ authority_id: expected.config.authorityId,
    authority_digest: expected.authorityDigest, key_id: expected.config.keyId, public_key: expected.publicKey,
    config_json: encode(expected.config) })) fail('authority singleton mismatch')
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
function planBody(plan: EmptyAdoptionPlan) { const { digest: _digest, ...body } = plan; return body }
function validatePlan(plan: EmptyAdoptionPlan) {
  exact(plan, ['protocol','transactionId','hostAnchor','physicalPath','oldIdentity','nextIdentity','snapshot','createdAt','expiresAt','digest'])
  for (const identity of [plan.oldIdentity, plan.nextIdentity]) exact(identity, ['logicalPath','config','authorityDigest','publicKey','keyFingerprint'])
  if (plan.physicalPath === plan.oldIdentity.logicalPath) fail('staged copy must be separate from logical source')
  exact(plan.snapshot, ['identity','bytes','digest'])
  exact(plan.snapshot.identity, ['dev','ino','uid','gid','mode','nlink'])
  if (!plan || plan.protocol !== PROTOCOL || plan.digest !== hash(planBody(plan))
    || !/^[a-f0-9]{64}$/u.test(plan.hostAnchor) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(plan.transactionId)
    || !Number.isSafeInteger(plan.createdAt) || !Number.isSafeInteger(plan.expiresAt)
    || plan.createdAt < 1 || plan.expiresAt <= plan.createdAt || plan.expiresAt - plan.createdAt > 300_000
    || plan.expiresAt > Math.min(plan.oldIdentity.config.expiresAt, plan.nextIdentity.config.expiresAt,
      plan.oldIdentity.config.runner.expiresAt, plan.nextIdentity.config.runner.expiresAt)) fail('invalid plan')
  const actual = identities(plan.oldIdentity.logicalPath, plan.oldIdentity.config, plan.nextIdentity.config)
  if (encode(actual) !== encode({ oldIdentity: plan.oldIdentity, nextIdentity: plan.nextIdentity })) fail('public identity changed')
}
export function planEmptyAdoptionHandoff(scope: EmptyAdoptionScope): Readonly<EmptyAdoptionPlan> {
  const pair = identities(scope.logicalPath, scope.oldConfig, scope.nextConfig)
  const body = { protocol: PROTOCOL, transactionId: scope.transactionId, hostAnchor: scope.hostAnchor,
    physicalPath: scope.physicalPath, ...pair, snapshot: bytes(scope.physicalPath, 64 * 1024 * 1024), createdAt: scope.now, expiresAt: scope.expiresAt }
  const plan: EmptyAdoptionPlan = { ...body, digest: hash(body) }; validatePlan(plan)
  if (scope.now >= Math.min(scope.oldConfig.expiresAt, scope.nextConfig.expiresAt,
    scope.oldConfig.runner.expiresAt, scope.nextConfig.runner.expiresAt) || scope.expiresAt > Math.min(scope.oldConfig.expiresAt, scope.nextConfig.expiresAt,
      scope.oldConfig.runner.expiresAt, scope.nextConfig.runner.expiresAt)) fail('expired grant or plan')
  openExisting(scope.physicalPath, db => {
    db.exec('BEGIN')
    try { schema(db, false); authority(db, pair.oldIdentity); empty(db)
      if (encode(bytes(scope.physicalPath, 64 * 1024 * 1024)) !== encode(plan.snapshot)) fail('plan snapshot drift')
    } finally { db.exec('ROLLBACK') }
  })
  return freeze(plan)
}
function storedProof(db: DatabaseSync, plan: EmptyAdoptionPlan): EmptyAdoptionProof {
  schema(db, true)
  const rows = textRows(db, AUDIT, ['proof_json', 'proof_digest'])
  if (rows.length !== 1 || typeof rows[0]!.proof_json !== 'string') fail('missing immutable proof')
  const proof = JSON.parse(rows[0]!.proof_json!) as EmptyAdoptionProof
  exact(proof, ['protocol','plan','fileIdentity','emptyBusiness','digest'])
  exact(proof.fileIdentity, ['dev','ino','uid','gid','mode','nlink'])
  exact(proof.emptyBusiness, ['adoptions','calls','sourceArchives'])
  if (encode(proof) !== rows[0]!.proof_json) fail('noncanonical proof JSON')
  const { digest: _digest, ...body } = proof
  if (proof.protocol !== PROTOCOL || proof.digest !== hash(body) || proof.digest !== rows[0]!.proof_digest
    || encode(proof.plan) !== encode(plan) || encode(proof.fileIdentity) !== encode(plan.snapshot.identity)
    || encode(proof.emptyBusiness) !== encode({ adoptions: 0, calls: 0, sourceArchives: 0 })) fail('proof mismatch')
  authority(db, plan.nextIdentity)
  return proof
}
export function applyEmptyAdoptionHandoff(plan: EmptyAdoptionPlan, input: { now: number; expectedPlanDigest: string; expectedHostAnchor: string }): Readonly<EmptyAdoptionProof> {
  validatePlan(plan)
  if (plan.digest !== input.expectedPlanDigest || plan.hostAnchor !== input.expectedHostAnchor) fail('external plan anchor mismatch')
  const now = input.now
  if (!Number.isSafeInteger(now) || now < plan.createdAt) fail('invalid apply time')
  return openExisting(plan.physicalPath, db => {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    try {
      if (db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(AUDIT)) {
        const proof = storedProof(db, plan)
        empty(db) // stopped empty acknowledgement only, never a new handoff
        if (encode(identity(plan.physicalPath)) !== encode(proof.fileIdentity)) fail('retry file identity mismatch')
        db.exec('ROLLBACK'); return freeze(proof)
      }
      if (!Number.isSafeInteger(now) || now < plan.createdAt || now > plan.expiresAt) fail('stale plan')
      schema(db, false); authority(db, plan.oldIdentity); empty(db)
      if (encode(bytes(plan.physicalPath, 64 * 1024 * 1024)) !== encode(plan.snapshot)) fail('apply snapshot drift')
      const result = db.prepare('UPDATE authority SET authority_digest=?,config_json=? WHERE authority_id=? AND authority_digest=? AND key_id=? AND public_key=? AND config_json=?')
        .run(plan.nextIdentity.authorityDigest, encode(plan.nextIdentity.config), plan.oldIdentity.config.authorityId,
          plan.oldIdentity.authorityDigest, plan.oldIdentity.config.keyId, plan.oldIdentity.publicKey, encode(plan.oldIdentity.config))
      if (result.changes !== 1) fail('authority compare-and-swap failed')
      if (encode(identity(plan.physicalPath)) !== encode(plan.snapshot.identity)) fail('apply file identity drift')
      const body = { protocol: PROTOCOL, plan: structuredClone(plan), fileIdentity: identity(plan.physicalPath),
        emptyBusiness: { adoptions: 0 as const, calls: 0 as const, sourceArchives: 0 as const } }
      const proof: EmptyAdoptionProof = { ...body, digest: hash(body) }
      db.exec(`${AUDIT_SQL};${NO_UPDATE};${NO_DELETE};`)
      db.prepare(`INSERT INTO ${AUDIT} VALUES (1,?,?)`).run(encode(proof), proof.digest)
      schema(db, true); authority(db, plan.nextIdentity); empty(db)
      if (encode(identity(plan.physicalPath)) !== encode(plan.snapshot.identity)) fail('commit file identity drift')
      db.exec('COMMIT')
      return freeze(proof)
    } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  }, true)
}
/** Stopped-stage / post-cutover BEFORE START acceptance only: prove current emptiness again.
 * Do not call this after ordinary Host work begins. Later legitimate business is governed by
 * the normal constructor; a general historical proof reader is outside this empty-only API.
 * Rename on the same inode is allowed; copying needs a separate authorized contract. */
export function verifyEmptyAdoptionHandoff(input: { physicalPath: string; plan: EmptyAdoptionPlan; expectedProofDigest: string }): Readonly<EmptyAdoptionProof> {
  validatePlan(input.plan)
  return openExisting(input.physicalPath, db => {
    db.exec('BEGIN')
    try {
      const proof = storedProof(db, input.plan)
      empty(db)
      if (proof.digest !== input.expectedProofDigest || !/^[a-f0-9]{64}$/u.test(input.expectedProofDigest)
        || encode(identity(input.physicalPath)) !== encode(proof.fileIdentity)) fail('external anchor or file identity mismatch')
      return freeze(proof)
    } finally { db.exec('ROLLBACK') }
  })
}
