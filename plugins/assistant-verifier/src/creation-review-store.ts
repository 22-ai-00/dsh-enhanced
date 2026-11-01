import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'

const SHA = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
type State = 'discover-claimed' | 'contract-claimed' | 'contract-ready' | 'case-claimed' | 'cases-ready'
  | 'review-claimed' | 'certificate' | 'rejected' | 'unknown'
interface Row { plan: string; binding: string; authority: string; state: State; data: string }
interface Grant { authority: string; digest: string; maximum: number; used: number }
interface Data<Certificate> { discovery?: unknown; contract?: unknown; cases?: Record<string, unknown>; certificate?: Certificate; reason?: string }
const maintenance = Symbol('offline review grant maintenance')
const auditTable = 'creation_review_grant_handoffs'
const auditSchema = `CREATE TABLE ${auditTable}(transaction_id TEXT PRIMARY KEY,proof TEXT NOT NULL) STRICT`
const auditTriggers = ['UPDATE', 'DELETE'].map(action =>
  `CREATE TRIGGER creation_review_handoff_no_${action.toLowerCase()} BEFORE ${action} ON ${auditTable} BEGIN SELECT RAISE(ABORT,'immutable review handoff'); END`)
const hash = (value: unknown): string => createHash('sha256').update(canonicalGrowthJson(value)).digest('hex')
export interface ReviewGrantHandoffScope {
  transactionId: string
  installationId: string
  profileId: string
  lane: 'creation-reviews' | 'revision-reviews' | 'revision-regressions'
  /** Frozen owner/key/publicKey/expiry/configuration evidence, checked by the caller. Not authentication. */
  configurationDigest: string
  authority: string
  toDigest: string
}
interface GrantSnapshot {
  digest: string
  maximum: number
  used: number
  grantsDigest: string
  historyDigest: string
  historyCount: number
}
export interface ReviewGrantHandoffPlan extends ReviewGrantHandoffScope {
  protocol: 'dsh-review-grant-handoff/v1'
  file: { path: string; dev: number; ino: number }
  before: GrantSnapshot
  auditBefore: { count: number; digest: string }
  planDigest: string
}
export interface ReviewGrantHandoffProof { plan: ReviewGrantHandoffPlan; after: GrantSnapshot }
function validScope(scope: ReviewGrantHandoffScope): boolean {
  return [scope.transactionId, scope.installationId, scope.profileId, scope.authority].every(value => typeof value === 'string' && ID.test(value))
    && ['creation-reviews', 'revision-reviews', 'revision-regressions'].includes(scope.lane)
    && typeof scope.configurationDigest === 'string' && SHA.test(scope.configurationDigest)
    && typeof scope.toDigest === 'string' && SHA.test(scope.toDigest)
}
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
export class CreationReviewStore<Certificate = PluginCreationVerificationCertificate> {
  readonly #db: DatabaseSync
  readonly #maintenance: boolean
  readonly #path: string
  readonly #identity: { dev: number; ino: number }
  #closed = false
  constructor(path: string, mode?: typeof maintenance) {
    this.#maintenance = mode === maintenance
    this.#path = path
    if (!isAbsolute(path) || resolve(path) !== path) fail('invalid path')
    const parent = dirname(path)
    if (!this.#maintenance) mkdirSync(parent, { recursive: true, mode: 0o700 })
    const directory = lstatSync(parent)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077
      || process.getuid && directory.uid !== process.getuid() || realpathSync(parent) !== parent) fail('directory must be private')
    if (!this.#maintenance) {
      try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    privateFile(path)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { privateFile(path + suffix) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      this.#identity = { dev: stat.dev, ino: stat.ino }
      if (this.#maintenance && stat.size < 100) fail('maintenance database empty')
      this.#db = new DatabaseSync(this.#maintenance ? `${pathToFileURL(path).href}?mode=rw` : path)
    } finally { closeSync(fd) }
    try {
      this.#checkFile()
      if (this.#maintenance) {
        this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
        this.#maintenanceSchema()
      } else this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS grants(authority TEXT PRIMARY KEY,digest TEXT NOT NULL,maximum INTEGER NOT NULL,used INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS verifications(plan TEXT PRIMARY KEY,binding TEXT NOT NULL,authority TEXT NOT NULL,
          state TEXT NOT NULL,data TEXT NOT NULL);`)
    } catch (error) { this.#db.close(); throw error }
  }
  /** Offline private stage only. Caller must stop writers and authorize frozen configuration. */
  static openExistingForMaintenance<Certificate = PluginCreationVerificationCertificate>(path: string): CreationReviewStore<Certificate> {
    return new CreationReviewStore<Certificate>(path, maintenance)
  }
  #checkFile(): void {
    const parent = dirname(this.#path), directory = lstatSync(parent)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077
      || process.getuid && directory.uid !== process.getuid() || realpathSync(parent) !== parent) fail('directory must be private')
    privateFile(this.#path)
    const stat = lstatSync(this.#path)
    if (stat.dev !== this.#identity.dev || stat.ino !== this.#identity.ino) fail('database identity changed')
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { privateFile(this.#path + suffix) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  #maintenanceSchema(): void {
    if (!this.#maintenance || this.#closed) fail('requires existing-only maintenance')
    this.#checkFile()
    if (this.#db.prepare('PRAGMA user_version').get()?.user_version !== 0
      || this.#db.prepare('PRAGMA application_id').get()?.application_id !== 0) fail('maintenance metadata changed')
    const objects = this.#db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()
    const audit = objects.some(row => row.name === auditTable)
    const allowed = new Map<string, string>([['grants', 'table'], ['verifications', 'table']])
    if (audit) {
      allowed.set(auditTable, 'table')
      allowed.set('creation_review_handoff_no_update', 'trigger')
      allowed.set('creation_review_handoff_no_delete', 'trigger')
    }
    if (objects.length !== allowed.size || objects.some(row => allowed.get(String(row.name)) !== row.type)) fail('maintenance schema changed')
    const normalize = (sql: string): string => sql.replace(/\s+/gu, '').toLowerCase()
    for (const sql of [
      'CREATE TABLE grants(authority TEXT PRIMARY KEY,digest TEXT NOT NULL,maximum INTEGER NOT NULL,used INTEGER NOT NULL)',
      'CREATE TABLE verifications(plan TEXT PRIMARY KEY,binding TEXT NOT NULL,authority TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL)',
    ]) {
      if (!objects.some(row => typeof row.sql === 'string' && normalize(row.sql) === normalize(sql))) fail('maintenance schema changed')
    }
    const columns: Record<string, string[]> = {
      grants: ['authority:TEXT:0:1', 'digest:TEXT:1:0', 'maximum:INTEGER:1:0', 'used:INTEGER:1:0'],
      verifications: ['plan:TEXT:0:1', 'binding:TEXT:1:0', 'authority:TEXT:1:0', 'state:TEXT:1:0', 'data:TEXT:1:0'],
    }
    if (audit) columns[auditTable] = ['transaction_id:TEXT:1:1', 'proof:TEXT:1:0']
    for (const [table, expected] of Object.entries(columns)) {
      const actual = this.#db.prepare(`PRAGMA table_xinfo(${table})`).all()
      if (actual.some(row => row.hidden !== 0) || actual.map(row => `${row.name}:${row.type}:${row.notnull}:${row.pk}`).join() !== expected.join())
        fail('maintenance columns changed')
    }
    if (audit && [auditSchema, ...auditTriggers].some(sql => !objects.some(row => row.sql === sql))) fail('handoff audit schema changed')
    const integrity = this.#db.prepare('PRAGMA quick_check').all()
    if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') fail('maintenance integrity failed')
  }
  #snapshot(authority: string, overrideDigest?: string): GrantSnapshot {
    this.#maintenanceSchema()
    const grants = this.#db.prepare('SELECT * FROM grants ORDER BY authority COLLATE BINARY').all() as unknown as Grant[]
    const counts = new Map<string, number>()
    for (const row of grants) {
      if (typeof row.authority !== 'string' || !ID.test(row.authority) || typeof row.digest !== 'string' || !SHA.test(row.digest)
        || !Number.isSafeInteger(row.maximum) || row.maximum < 1 || row.maximum > 1000
        || !Number.isSafeInteger(row.used) || row.used < 1 || row.used > row.maximum) fail('grant corrupt or has no claimed history')
      counts.set(row.authority, 0)
    }
    const grant = grants.find(row => row.authority === authority)
    if (!grant) fail('existing grant missing')
    const rows = this.#db.prepare('SELECT * FROM verifications ORDER BY plan COLLATE BINARY').all() as unknown as Row[]
    // Hash rows independently: the whole history can exceed the canonical JSON
    // helper's per-payload node limit even though every stored row is bounded.
    const history = createHash('sha256').update('dsh-creation-review-history/v1\n')
    for (const row of rows) {
      const terminal = row.state === 'rejected' || row.state === 'unknown'
      if (typeof row.plan !== 'string' || !ID.test(row.plan) || typeof row.binding !== 'string' || !SHA.test(row.binding)
        || !counts.has(row.authority) || typeof row.data !== 'string' || Buffer.byteLength(row.data) > (terminal ? 300_000 : 262_144)
        || !['discover-claimed', 'contract-claimed', 'contract-ready', 'case-claimed', 'cases-ready', 'review-claimed',
          'certificate', 'rejected', 'unknown'].includes(row.state)) fail('verification corrupt')
      let data: unknown
      try { data = JSON.parse(row.data) } catch { fail('verification data corrupt') }
      if (!data || typeof data !== 'object' || Array.isArray(data) || canonicalGrowthJson(data) !== row.data) fail('verification data corrupt')
      const fields = data as Data<Certificate> & { activeCase?: { caseId: string; operationDigest: string } }
      const keys = Object.keys(data)
      if (keys.some(key => !['discovery', 'contract', 'cases', 'activeCase', 'certificate', 'reason'].includes(key))
        || fields.cases !== undefined && (!fields.cases || typeof fields.cases !== 'object' || Array.isArray(fields.cases))
        || fields.activeCase !== undefined && (Object.keys(fields.activeCase).sort().join(',') !== 'caseId,operationDigest'
          || typeof fields.activeCase.caseId !== 'string' || !ID.test(fields.activeCase.caseId)
          || typeof fields.activeCase.operationDigest !== 'string' || !SHA.test(fields.activeCase.operationDigest))
        || ['rejected', 'unknown'].includes(row.state) && (typeof fields.reason !== 'string' || !fields.reason.trim() || fields.reason.length > 4096)
        || !['rejected', 'unknown'].includes(row.state) && fields.reason !== undefined
        || row.state !== 'certificate' && fields.certificate !== undefined
        || row.state === 'certificate' && fields.certificate === undefined) fail('verification fields corrupt')
      const stageKeys = keys.filter(key => key !== 'reason').sort().join(',')
      const prefixes = ['', 'discovery', 'cases,contract,discovery', 'activeCase,cases,contract,discovery']
      const expectedKeys = row.state === 'discover-claimed' ? prefixes[0]
        : row.state === 'contract-claimed' ? prefixes[1]
          : row.state === 'case-claimed' ? prefixes[3]
            : row.state === 'certificate' ? 'cases,certificate,contract,discovery' : prefixes[2]
      if (terminal ? !prefixes.includes(stageKeys) : stageKeys !== expectedKeys) fail('verification stage corrupt')
      counts.set(row.authority, counts.get(row.authority)! + 1)
      history.update(canonicalGrowthJson(row)).update('\n')
    }
    if (grants.some(row => counts.get(row.authority) !== row.used)) fail('used/history mismatch')
    return { digest: overrideDigest ?? grant.digest, maximum: grant.maximum, used: grant.used,
      grantsDigest: hash(grants.map(row => row.authority === authority && overrideDigest ? { ...row, digest: overrideDigest } : row)),
      historyDigest: history.digest('hex'), historyCount: rows.length }
  }
  #auditSnapshot(excludeTransaction?: string): { count: number; digest: string } {
    const exists = this.#db.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(auditTable)
    const rows = exists ? this.#db.prepare(`SELECT transaction_id,proof FROM ${auditTable} ORDER BY transaction_id COLLATE BINARY`).all() : []
    const retained = rows.filter(row => row.transaction_id !== excludeTransaction)
    return { count: retained.length, digest: hash(retained) }
  }
  /** Snapshot only; no schema, grant, audit or journal-mode changes. */
  planGrantHandoff(scope: ReviewGrantHandoffScope): Readonly<ReviewGrantHandoffPlan> {
    if (!validScope(scope)) fail('invalid handoff scope')
    return this.#transaction(() => {
      const before = this.#snapshot(scope.authority)
      if (before.digest === scope.toDigest) fail('handoff digest unchanged')
      const body = { ...scope, protocol: 'dsh-review-grant-handoff/v1' as const,
        file: { path: this.#path, ...this.#identity }, before, auditBefore: this.#auditSnapshot() }
      return Object.freeze({ ...body, file: Object.freeze(body.file), before: Object.freeze(before), auditBefore: Object.freeze(body.auditBefore), planDigest: hash(body) })
    })
  }
  /** CAS and immutable audit commit together. Reuse only before any writer resumes. */
  applyGrantHandoff(plan: ReviewGrantHandoffPlan): Readonly<ReviewGrantHandoffProof> {
    if (!plan || !validScope(plan) || plan.protocol !== 'dsh-review-grant-handoff/v1') fail('invalid handoff plan')
    const { planDigest, ...body } = plan
    if (hash(body) !== planDigest || !SHA.test(planDigest) || plan.file.path !== this.#path
      || plan.file.dev !== this.#identity.dev || plan.file.ino !== this.#identity.ino
      || !SHA.test(plan.before.digest) || plan.before.digest === plan.toDigest
      || !plan.auditBefore || !Number.isSafeInteger(plan.auditBefore.count) || plan.auditBefore.count < 0
      || !SHA.test(plan.auditBefore.digest)) fail('invalid handoff plan')
    return this.#transaction(() => {
      const current = this.#snapshot(plan.authority)
      const audit = this.#db.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(auditTable)
      if (audit) {
        const prior = this.#db.prepare(`SELECT proof FROM ${auditTable} WHERE transaction_id=?`).get(plan.transactionId)
        if (prior) {
          const proof = JSON.parse(String(prior.proof)) as ReviewGrantHandoffProof
          if (prior.proof !== canonicalGrowthJson({ plan, after: current })
            || canonicalGrowthJson(proof.plan) !== canonicalGrowthJson(plan)
            || canonicalGrowthJson(proof.after) !== canonicalGrowthJson(current)
            || canonicalGrowthJson(this.#auditSnapshot(plan.transactionId)) !== canonicalGrowthJson(plan.auditBefore)
            || this.#auditSnapshot().count !== plan.auditBefore.count + 1) fail('handoff retry conflict or drift')
          return proof
        }
        if (Number(this.#db.prepare(`SELECT COUNT(*) AS n FROM ${auditTable}`).get()?.n) >= 64) fail('handoff audit limit')
      }
      if (canonicalGrowthJson(current) !== canonicalGrowthJson(plan.before)
        || canonicalGrowthJson(this.#auditSnapshot()) !== canonicalGrowthJson(plan.auditBefore)) fail('handoff snapshot changed')
      if (!audit) this.#db.exec([auditSchema, ...auditTriggers].join(';'))
      const after = this.#snapshot(plan.authority, plan.toDigest)
      const result = this.#db.prepare('UPDATE grants SET digest=? WHERE authority=? AND digest=? AND maximum=? AND used=?')
        .run(plan.toDigest, plan.authority, current.digest, current.maximum, current.used)
      if (result.changes !== 1) fail('handoff compare-and-swap failed')
      const proof = { plan, after }
      this.#db.prepare(`INSERT INTO ${auditTable}(transaction_id,proof) VALUES(?,?)`).run(plan.transactionId, canonicalGrowthJson(proof))
      if (canonicalGrowthJson(this.#snapshot(plan.authority)) !== canonicalGrowthJson(after)) fail('handoff changed history')
      return Object.freeze(proof)
    })
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close() } }
  #transaction<T>(callback: () => T): T {
    if (this.#closed) fail('closed')
    if (this.#maintenance) this.#checkFile()
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
  /** Historical private evidence only; no grant read, claim, or quota mutation. */
  readRetained(plan: string): Readonly<{ certificate: Certificate; discovery: unknown; contract: unknown;
    cases: Record<string, unknown> }> | undefined {
    if (this.#closed || !ID.test(plan)) fail('invalid retained identity')
    const row = this.#db.prepare('SELECT state,data FROM verifications WHERE plan=?').get(plan) as
      { state: State; data: string } | undefined
    if (!row || row.state !== 'certificate') return undefined
    if (Buffer.byteLength(row.data) > 262_144) fail('retained record too large')
    const data: unknown = JSON.parse(row.data)
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).sort().join(',') !== 'cases,certificate,contract,discovery'
      || canonicalGrowthJson(data) !== row.data) fail('retained record changed')
    const evidence = data as Data<Certificate>
    if (evidence.certificate === undefined || evidence.discovery === undefined || evidence.contract === undefined
      || !evidence.cases || typeof evidence.cases !== 'object' || Array.isArray(evidence.cases)) fail('retained evidence incomplete')
    return { certificate: evidence.certificate, discovery: evidence.discovery, contract: evidence.contract, cases: evidence.cases }
  }
  claim(plan: string, binding: string, authority: string, digest: string, maximum: number):
    { state: 'new' | 'unknown' | 'rejected' | 'certificate'; reason?: string; certificate?: Certificate } {
    check(plan, binding); check(authority, digest)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) fail('invalid quota')
    return this.#transaction(() => {
      const grant = this.#db.prepare('SELECT * FROM grants WHERE authority=?').get(authority) as Grant | undefined
      if (grant && (grant.digest !== digest || grant.maximum !== maximum || grant.used < 0 || grant.used > maximum)) fail('grant changed or corrupt')
      const old = this.#db.prepare('SELECT * FROM verifications WHERE plan=?').get(plan) as Row | undefined
      if (old) {
        if (old.binding !== binding || old.authority !== authority || !grant) fail('binding changed')
        const data = JSON.parse(old.data) as Data<Certificate>
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
  #advance(plan: string, binding: string, from: State, to: State, update: (data: Data<Certificate>) => Data<Certificate>): void {
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM verifications WHERE plan=?').get(plan) as Row | undefined
      if (!row || row.binding !== binding || row.state !== from) fail('stage changed')
      const data = update(JSON.parse(row.data) as Data<Certificate>)
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
      const active = data as Data<Certificate> & { activeCase?: { caseId: string; operationDigest: string } }
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
      const data = JSON.parse(row.data) as Data<Certificate>
      this.#db.prepare('UPDATE verifications SET state=?,data=? WHERE plan=?')
        .run(state, canonicalGrowthJson({ ...data, reason }), plan)
    })
  }
  certificate(plan: string, binding: string, certificate: Certificate): void {
    this.#advance(plan, binding, 'review-claimed', 'certificate', data => ({ ...data, certificate }))
  }
}
