import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'

const SHA = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
type State = 'discover-claimed' | 'contract-claimed' | 'contract-ready' | 'case-claimed' | 'cases-ready'
  | 'review-claimed' | 'certificate' | 'rejected' | 'unknown'
interface Row { plan: string; binding: string; authority: string; state: State; data: string }
interface Grant { authority: string; digest: string; maximum: number; used: number }
interface Data { discovery?: unknown; contract?: unknown; cases?: Record<string, unknown>; certificate?: PluginCreationVerificationCertificate; reason?: string }
function fail(message: string): never { throw new Error(`creation review store: ${message}`) }
function check(idValue: string, digestValue: string): void {
  if (!ID.test(idValue) || !SHA.test(digestValue)) fail('invalid identity')
}
function privateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077
    || process.getuid && stat.uid !== process.getuid() || realpathSync(path) !== path) fail('database must be private')
}

/** Every dispatch is claimed durably first. A claimed or unknown stage is never replayed. */
export class CreationReviewStore {
  readonly #db: DatabaseSync
  #closed = false
  constructor(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) fail('invalid path')
    const parent = dirname(path)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    const directory = lstatSync(parent)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077
      || process.getuid && directory.uid !== process.getuid() || realpathSync(parent) !== parent) fail('directory must be private')
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    privateFile(path)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { privateFile(path + suffix) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.#db = new DatabaseSync(path)
    try {
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS grants(authority TEXT PRIMARY KEY,digest TEXT NOT NULL,maximum INTEGER NOT NULL,used INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS verifications(plan TEXT PRIMARY KEY,binding TEXT NOT NULL,authority TEXT NOT NULL,
          state TEXT NOT NULL,data TEXT NOT NULL);`)
    } catch (error) { this.#db.close(); throw error }
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close() } }
  #transaction<T>(callback: () => T): T {
    if (this.#closed) fail('closed')
    this.#db.exec('BEGIN IMMEDIATE')
    try { const result = callback(); this.#db.exec('COMMIT'); return result }
    catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  remaining(authority: string, digest: string, maximum: number): number {
    check(authority, digest)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) fail('invalid quota')
    const row = this.#db.prepare('SELECT * FROM grants WHERE authority=?').get(authority) as Grant | undefined
    if (!row) return maximum
    if (row.digest !== digest || row.maximum !== maximum || !Number.isSafeInteger(row.used)
      || row.used < 0 || row.used > maximum) fail('grant changed or corrupt')
    return maximum - row.used
  }
  claim(plan: string, binding: string, authority: string, digest: string, maximum: number):
    { state: 'new' | 'unknown' | 'rejected' | 'certificate'; reason?: string; certificate?: PluginCreationVerificationCertificate } {
    check(plan, binding); check(authority, digest)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) fail('invalid quota')
    return this.#transaction(() => {
      const grant = this.#db.prepare('SELECT * FROM grants WHERE authority=?').get(authority) as Grant | undefined
      if (grant && (grant.digest !== digest || grant.maximum !== maximum || grant.used < 0 || grant.used > maximum)) fail('grant changed or corrupt')
      const old = this.#db.prepare('SELECT * FROM verifications WHERE plan=?').get(plan) as Row | undefined
      if (old) {
        if (old.binding !== binding || old.authority !== authority || !grant) fail('binding changed')
        const data = JSON.parse(old.data) as Data
        if (old.state === 'certificate') {
          if (!data.certificate) fail('certificate missing')
          return { state: 'certificate', certificate: data.certificate }
        }
        if (old.state === 'rejected' || old.state === 'unknown') {
          if (!data.reason) fail('rejection missing')
          return { state: old.state, reason: data.reason }
        }
        return { state: 'unknown' }
      }
      if (grant && grant.used >= maximum) fail('quota exhausted')
      if (!grant) this.#db.prepare('INSERT INTO grants VALUES(?,?,?,0)').run(authority, digest, maximum)
      this.#db.prepare('UPDATE grants SET used=used+1 WHERE authority=?').run(authority)
      this.#db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?)').run(plan, binding, authority, 'discover-claimed', '{}')
      return { state: 'new' }
    })
  }
  #advance(plan: string, binding: string, from: State, to: State, update: (data: Data) => Data): void {
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM verifications WHERE plan=?').get(plan) as Row | undefined
      if (!row || row.binding !== binding || row.state !== from) fail('stage changed')
      const data = update(JSON.parse(row.data) as Data)
      const serialized = canonicalGrowthJson(data)
      if (Buffer.byteLength(serialized) > 262_144) fail('record too large')
      this.#db.prepare('UPDATE verifications SET state=?,data=? WHERE plan=?').run(to, serialized, plan)
    })
  }
  discovered(plan: string, binding: string, discovery: unknown): void {
    this.#advance(plan, binding, 'discover-claimed', 'contract-claimed', data => ({ ...data, discovery }))
  }
  contract(plan: string, binding: string, contract: unknown): void {
    this.#advance(plan, binding, 'contract-claimed', 'contract-ready', data => ({ ...data, contract, cases: {} }))
  }
  claimCase(plan: string, binding: string, caseId: string, operationDigest: string): void {
    check(caseId, operationDigest)
    this.#advance(plan, binding, 'contract-ready', 'case-claimed', data => ({ ...data, activeCase: { caseId, operationDigest } }))
  }
  observation(plan: string, binding: string, caseId: string, observed: unknown): void {
    this.#advance(plan, binding, 'case-claimed', 'contract-ready', data => {
      const active = data as Data & { activeCase?: { caseId: string; operationDigest: string } }
      if (active.activeCase?.caseId !== caseId || Object.hasOwn(data.cases ?? {}, caseId)) fail('case changed')
      const { activeCase: _, ...rest } = active
      return { ...rest, cases: { ...data.cases, [caseId]: observed } }
    })
  }
  claimReview(plan: string, binding: string): void {
    this.#advance(plan, binding, 'contract-ready', 'review-claimed', data => {
      const contract = data.contract as { cases?: unknown[] } | undefined
      if (!contract?.cases || Object.keys(data.cases ?? {}).length !== contract.cases.length) fail('cases incomplete')
      return data
    })
  }
  reject(plan: string, binding: string, reason: string): void {
    this.#terminal(plan, binding, reason, 'rejected')
  }
  unknown(plan: string, binding: string, reason: string): void {
    this.#terminal(plan, binding, reason, 'unknown')
  }
  #terminal(plan: string, binding: string, reason: string, state: 'rejected' | 'unknown'): void {
    if (!reason.trim() || reason.length > 4096) fail('invalid reason')
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM verifications WHERE plan=?').get(plan) as Row | undefined
      if (!row || row.binding !== binding || row.state === 'certificate' || row.state === 'rejected' || row.state === 'unknown') fail('stage changed')
      const data = JSON.parse(row.data) as Data
      this.#db.prepare('UPDATE verifications SET state=?,data=? WHERE plan=?')
        .run(state, canonicalGrowthJson({ ...data, reason }), plan)
    })
  }
  certificate(plan: string, binding: string, certificate: PluginCreationVerificationCertificate): void {
    this.#advance(plan, binding, 'review-claimed', 'certificate', data => ({ ...data, certificate }))
  }
}
