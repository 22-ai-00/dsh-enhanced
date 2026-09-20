import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'

export class SourceReviewStoreError extends Error {
  constructor(readonly code: 'invalid-input' | 'conflict' | 'corrupt', message: string) { super(message) }
}
type Model = { provider: string; model: string; reasoningEffort?: string }
type Result = { reason: string; outputDigest: string }
interface GrantRow { authority: string; digest: string; max: number; used: number }
interface ReviewRow { operation: string; request: string; authority: string; model: string; state: 'claimed' | 'approved' | 'rejected'; reason: string | null; output: string | null }
interface ClaimInput { operationId: string; requestDigest: string; authorityId: string; authorityDigest: string; maxReviews: number; model: Model }
interface Claim { state: 'claimed' | 'unknown' | 'approved' | 'rejected'; result?: Result }
const D = /^[a-f0-9]{64}$/u, I = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
function fail(code: SourceReviewStoreError['code'], message: string): never { throw new SourceReviewStoreError(code, message) }
function id(value: unknown): void { if (typeof value !== 'string' || !I.test(value)) fail('invalid-input', 'invalid review identity') }
function digest(value: unknown): void { if (typeof value !== 'string' || !D.test(value)) fail('invalid-input', 'invalid review digest') }
function reason(value: unknown): void {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > 4096) fail('invalid-input', 'invalid review reason')
}
function privateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || process.getuid && stat.uid !== process.getuid() || realpathSync(path) !== path) fail('corrupt', 'review database must be private and canonical')
}

/** Durable at-most-once model admission, independently bounded by an immutable grant. */
export class SourceReviewStore {
  readonly #db: DatabaseSync
  #closed = false
  constructor(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) fail('invalid-input', 'invalid review database path')
    const parent = dirname(path)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    const directory = lstatSync(parent)
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
      || process.getuid && directory.uid !== process.getuid() || realpathSync(parent) !== parent) fail('corrupt', 'review database directory must be private and canonical')
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    privateFile(path)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { privateFile(path + suffix) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.#db = new DatabaseSync(path)
    try {
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS grants(authority TEXT PRIMARY KEY, digest TEXT NOT NULL, max INTEGER NOT NULL, used INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS reviews(operation TEXT PRIMARY KEY, request TEXT NOT NULL, authority TEXT NOT NULL,
          model TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('claimed','approved','rejected')), reason TEXT, output TEXT);`)
    } catch (error) { this.#db.close(); throw error }
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close() } }
  available(input: Pick<ClaimInput, 'authorityId' | 'authorityDigest' | 'maxReviews'> & { operationId?: string }): boolean {
    if (this.#closed) return false
    const grant = this.#db.prepare('SELECT * FROM grants WHERE authority=?').get(input.authorityId) as unknown as GrantRow | undefined
    if (!grant) return true
    if (grant.digest !== input.authorityDigest || grant.max !== input.maxReviews || !Number.isSafeInteger(grant.used)
      || grant.used < 0 || grant.used > grant.max) return false
    if (input.operationId !== undefined && this.#db.prepare('SELECT 1 FROM reviews WHERE operation=? AND authority=?').get(input.operationId, input.authorityId)) return true
    return grant.used < grant.max
  }
  #transaction<T>(callback: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const result = callback(); this.#db.exec('COMMIT'); return result } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  claim(input: ClaimInput): Claim {
    id(input.operationId); digest(input.requestDigest); id(input.authorityId); digest(input.authorityDigest)
    if (!Number.isSafeInteger(input.maxReviews) || input.maxReviews < 1 || input.maxReviews > 10_000) fail('invalid-input', 'invalid review quota')
    id(input.model.provider); id(input.model.model)
    if (input.model.reasoningEffort !== undefined) id(input.model.reasoningEffort)
    const model = acceptanceCanonicalJson({ provider: input.model.provider, model: input.model.model,
      ...(input.model.reasoningEffort === undefined ? {} : { reasoningEffort: input.model.reasoningEffort }) })
    return this.#transaction(() => {
      const grant = this.#db.prepare('SELECT * FROM grants WHERE authority=?').get(input.authorityId) as unknown as GrantRow | undefined
      if (grant && (grant.digest !== input.authorityDigest || grant.max !== input.maxReviews)) fail('conflict', 'authority grant differs')
      if (grant && (!Number.isSafeInteger(grant.used) || grant.used < 0 || grant.used > grant.max)) fail('corrupt', 'invalid stored review quota')
      const old = this.#db.prepare('SELECT * FROM reviews WHERE operation=?').get(input.operationId) as unknown as ReviewRow | undefined
      if (old) {
        if (!grant || old.request !== input.requestDigest || old.authority !== input.authorityId || old.model !== model) fail('conflict', 'review binding differs')
        if (old.state === 'claimed') return { state: 'unknown' }
        if (old.state !== 'approved' && old.state !== 'rejected') fail('corrupt', 'invalid stored review state')
        reason(old.reason); digest(old.output)
        return { state: old.state, result: { reason: old.reason!, outputDigest: old.output! } }
      }
      if (grant && grant.used >= grant.max) fail('conflict', 'review quota exhausted')
      if (!grant) this.#db.prepare('INSERT INTO grants VALUES(?,?,?,0)').run(input.authorityId, input.authorityDigest, input.maxReviews)
      this.#db.prepare('UPDATE grants SET used=used+1 WHERE authority=?').run(input.authorityId)
      this.#db.prepare("INSERT INTO reviews VALUES(?,?,?,?,'claimed',NULL,NULL)").run(input.operationId, input.requestDigest, input.authorityId, model)
      return { state: 'claimed' }
    })
  }
  finish(operationId: string, requestDigest: string, result: Result & { status: 'approved' | 'rejected' }): void {
    id(operationId); digest(requestDigest); reason(result.reason); digest(result.outputDigest)
    if (!['approved', 'rejected'].includes(result.status)) fail('invalid-input', 'invalid review result')
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM reviews WHERE operation=?').get(operationId) as unknown as ReviewRow | undefined
      if (!row || row.request !== requestDigest) fail('conflict', 'review differs')
      if (row.state !== 'claimed') {
        if (row.state !== result.status || row.reason !== result.reason || row.output !== result.outputDigest) fail('conflict', 'result differs')
        return
      }
      this.#db.prepare('UPDATE reviews SET state=?,reason=?,output=? WHERE operation=?').run(result.status, result.reason, result.outputDigest, operationId)
    })
  }
}
