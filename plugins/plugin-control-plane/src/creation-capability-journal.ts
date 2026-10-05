import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson, validatePluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { validateCreationCapabilitySource, type CreationCapabilitySourceSnapshot } from './creation-capability-source.js'
import type { CreationCapabilityCall, CreationCapabilityCallEvidence, CreationCapabilityConfig,
  CreationCapabilityForegroundCallWitness, CreationCapabilityJournalPort,
  CreationCapabilityReceipt, CreationCapabilityRecord, CreationCapabilitySourceArchive, CreationCapabilityTool } from './creation-capability-types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const SHA = /^[a-f0-9]{64}$/u
const APP_ID = 0x44534341
const SEMANTICS = 'dsh-created-capability-journal/v1:reserve-before-dispatch:unknown-no-retry:finite-owner-grant'
const SOURCE_ARCHIVE_LIMIT = 2 * 1024 * 1024
const SOURCE_ARCHIVE_DOMAIN = 'dsh-created-capability-source-archive-v1\0'
function fail(): never { throw new Error('creation capability journal rejected input or state') }
function obj(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== expected.length) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).sort().join('\0') !== [...expected].sort().join('\0')
    || !Object.values(descriptors).every(d => d.enumerable && 'value' in d)) fail()
  return value as Record<string, unknown>
}
function str(value: unknown, pattern = ID, max = 512): string {
  if (typeof value !== 'string' || !pattern.test(value) || value.normalize('NFC') !== value
    || Buffer.byteLength(value) > max || /[\p{Cc}]/u.test(value)) fail()
  return value
}
function int(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail()
  return Number(value)
}
function path(value: unknown): string {
  const result = str(value, /^[\s\S]+$/u, 4096)
  if (!isAbsolute(result) || result === '/' || resolve(result) !== result) fail()
  return result
}
function privateStat(file: string, kind: 'file' | 'directory'): void {
  const s = lstatSync(file)
  if (realpathSync(file) !== file || (kind === 'file' ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())
    || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) fail()
}
function keyBytes(file: string): Buffer {
  privateStat(dirname(file), 'directory'); privateStat(file, 'file')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true })
    if (before.size > 32768n || before.ino !== named.ino || before.dev !== named.dev) fail()
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true })
    if (bytes.length > 32768 || before.ino !== after.ino || before.dev !== after.dev
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail()
    return bytes
  } finally { closeSync(fd) }
}
function json(value: unknown, max = 65536): string {
  const seen = new Set<object>()
  let nodes = 0
  const walk = (v: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 32) fail()
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number' && Number.isFinite(v)) return
    if (!v || typeof v !== 'object' || seen.has(v)) fail()
    seen.add(v)
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) fail()
      for (let i = 0; i < v.length; i++) { if (!Object.hasOwn(v, i)) fail(); walk(v[i], depth + 1) }
    } else {
      const d = Object.getOwnPropertyDescriptors(v)
      if ((Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        || Reflect.ownKeys(v).length !== Object.keys(d).length
        || !Object.values(d).every(x => x.enumerable && 'value' in x)) fail()
      for (const [k, x] of Object.entries(d)) { if (k === '__proto__' || k === 'constructor') fail(); walk(x.value, depth + 1) }
    }
    seen.delete(v)
  }
  walk(value, 0)
  const encoded = canonicalGrowthJson(value)
  if (Buffer.byteLength(encoded) > max) fail()
  return encoded
}
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
function digest(value: unknown): string { return sha(json(value)) }
function witnessJson(value: unknown, config: CreationCapabilityConfig, planId: string, alias: string,
  argumentsDigest: string, key: string): string {
  const root = obj(value, ['protocol','task','turn','call'])
  if (root.protocol !== 'assistant-delivery/foreground-tool-call/v1') fail()
  const task = obj(root.task, ['protocol','inboxId','sessionId','scope','owner','binding','dispatchedAt'])
  if (task.protocol !== 'assistant-delivery/foreground-task/v1') fail()
  str(task.inboxId); str(task.sessionId)
  const scope = obj(task.scope, ['workspace','preset'])
  if (path(scope.workspace) !== config.owner.workspace || str(scope.preset) !== config.owner.agentPreset) fail()
  const owner = obj(task.owner, ['principalRecordId','principalVersion'])
  if (str(owner.principalRecordId, /^[\s\S]+$/u, 512) !== config.owner.principalRecordId
    || int(owner.principalVersion, 1, Number.MAX_SAFE_INTEGER) !== config.owner.principalVersion) fail()
  const binding = obj(task.binding, ['id','version','generation'])
  str(binding.id, /^[\s\S]+$/u, 512)
  int(binding.version, 1, Number.MAX_SAFE_INTEGER); int(binding.generation, 1, Number.MAX_SAFE_INTEGER)
  int(task.dispatchedAt, 1, 8_640_000_000_000_000)
  int(root.turn, 0, Number.MAX_SAFE_INTEGER)
  const call = obj(root.call, ['id','toolName','eventSeq','eventDigest','argumentsDigest'])
  str(call.id); str(call.toolName); int(call.eventSeq, 0, Number.MAX_SAFE_INTEGER)
  str(call.eventDigest, SHA, 64); str(call.argumentsDigest, SHA, 64)
  if (call.toolName !== alias || call.argumentsDigest !== argumentsDigest
    || sha(JSON.stringify({ planId, sessionId: task.sessionId, callId: call.id, toolName: alias })) !== key) fail()
  return json(value, 4096)
}
function receiptBody(receipt: CreationCapabilityReceipt): Omit<CreationCapabilityReceipt, 'signature'> {
  const { signature: _signature, ...body } = receipt
  return body
}
function receiptShape(value: unknown): CreationCapabilityReceipt {
  const v = obj(value, ['protocol','authorityId','authorityDigest','keyId','planId','planDigest','verificationDigest',
    'artifactSha256','artifactBytes','source','schemaDigest','toolsDigest','expiresAt','adoptedAt','signature'])
  if (v.protocol !== 'dsh-created-capability-adoption/v1' && v.protocol !== 'dsh-created-capability-adoption/v2') fail()
  for (const name of ['authorityId','keyId','planId']) str(v[name])
  for (const name of ['authorityDigest','planDigest','verificationDigest','artifactSha256','schemaDigest','toolsDigest']) str(v[name], SHA, 64)
  int(v.artifactBytes, 1, 512 * 1024); int(v.expiresAt, 1, 8_640_000_000_000_000); int(v.adoptedAt, 1, 8_640_000_000_000_000)
  obj(v.source, ['referenceDigest','ownerDigest','growthRunDigest'])
  for (const x of Object.values(v.source as Record<string, unknown>)) str(x, SHA, 64)
  const sig = str(v.signature, /^[A-Za-z0-9_-]{86}$/u, 86)
  if (Buffer.from(sig, 'base64url').length !== 64 || Buffer.from(sig, 'base64url').toString('base64url') !== sig) fail()
  return value as CreationCapabilityReceipt
}
export function verifyCreationCapabilityReceipt(value: unknown, authorityDigest: string, publicKey: string, now = Date.now()): value is CreationCapabilityReceipt {
  try {
    const receipt = receiptShape(value)
    if (!SHA.test(authorityDigest) || receipt.authorityDigest !== authorityDigest || !Number.isSafeInteger(now)
      || receipt.adoptedAt > now || receipt.expiresAt <= now || receipt.expiresAt <= receipt.adoptedAt) return false
    const key = createPublicKey(publicKey)
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(json(receiptBody(receipt))), key, Buffer.from(receipt.signature, 'base64url'))
  } catch { return false }
}

/** Read-only preflight; it never creates a signing key or ledger. */
export function validateCreationCapabilityConfig(value: unknown): asserts value is CreationCapabilityConfig {
  const v = obj(value, ['authorityId','keyId','keyPath','owner','namePrefix','expiresAt','maxAdoptions','maxTools',
    'maxCallsPerAdoption','maxCallRecords','maxInputBytes','runner', ...(Object.hasOwn(value as object, 'retention') ? ['retention'] : [])])
  str(v.authorityId); str(v.keyId); const keyPath = path(v.keyPath)
  const owner = obj(v.owner, ['authorityId','authorityHash','principalId','principalRecordId','principalVersion','workspace','agentPreset'])
  str(owner.authorityId); str(owner.authorityHash, SHA, 64)
  str(owner.principalId, /^[\s\S]+$/u, 512); str(owner.principalRecordId, /^[\s\S]+$/u, 512)
  int(owner.principalVersion, 1, Number.MAX_SAFE_INTEGER); path(owner.workspace); str(owner.agentPreset)
  str(v.namePrefix, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u, 48)
  int(v.expiresAt, 1, 8_640_000_000_000_000); int(v.maxAdoptions, 1, 32); int(v.maxTools, 1, 16)
  int(v.maxCallsPerAdoption, 1, 1024); int(v.maxCallRecords, 1, 1024); int(v.maxInputBytes, 1, 65536)
  if (Object.hasOwn(v, 'retention')) {
    const retention = obj(v.retention, ['maximumLifetimeMs'])
    int(retention.maximumLifetimeMs, 1, 30 * 86_400_000)
  }
  const runner = obj(v.runner, ['stateRoot','image','dockerPath','expiresAt','maxRuns','maxTotalDurationMs','maxDurationMs','maxOutputBytes'])
  const root = path(runner.stateRoot)
  privateStat(root, 'directory')
  str(runner.image, /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u, 512)
  const dockerPath = path(runner.dockerPath)
  if (dockerPath === keyPath) fail()
  int(runner.expiresAt, 1, 8_640_000_000_000_000); int(runner.maxRuns, 1, 1024)
  int(runner.maxTotalDurationMs, 1, 86_400_000); int(runner.maxDurationMs, 1, 300_000)
  if ((runner.maxDurationMs as number) > (runner.maxTotalDurationMs as number)) fail()
  int(runner.maxOutputBytes, 65536, 65536)
  const privateKey = createPrivateKey(keyBytes(keyPath))
  if (privateKey.asymmetricKeyType !== 'ed25519') fail()
  json(value)
}

/** Stable public identity for preflight comparison with the independent verifier key. */
export function creationCapabilityPublicKey(config: CreationCapabilityConfig): string {
  validateCreationCapabilityConfig(config)
  return createPublicKey(createPrivateKey(keyBytes(config.keyPath))).export({ type: 'spki', format: 'pem' }).toString()
}

interface AdoptionRow { plan_id: string; status: CreationCapabilityRecord['status']; certificate_json: string; certificate_digest: string;
  artifact: Uint8Array; artifact_sha: string; tools_json: string | null; tools_digest: string | null; receipt_json: string | null; reason: string | null }
interface CallRow { plan_id: string; call_key: string; arguments_digest: string; status: CreationCapabilityCall['status'];
  result_json: string | null; job_id: string | null; tool_alias: string | null; foreground_json: string | null;
  claimed_at: number | null; settled_at: number | null }

/** Reservations consume quota before any external invocation; recovery only marks uncertainty. */
export class CreationCapabilityJournal implements CreationCapabilityJournalPort {
  readonly authorityDigest: string
  readonly publicKey: string
  private readonly db: DatabaseSync
  private readonly key: KeyObject
  private readonly identity: { dev: number; ino: number }
  private readonly path: string
  private readonly config: CreationCapabilityConfig
  constructor(input: { path: string; config: CreationCapabilityConfig }) {
    validateCreationCapabilityConfig(input.config)
    this.config = structuredClone(input.config)
    this.path = path(input.path)
    if (!this.path.endsWith('/creation-adoptions.sqlite') || this.path === this.config.keyPath) fail()
    this.key = createPrivateKey(keyBytes(this.config.keyPath))
    this.publicKey = createPublicKey(this.key).export({ type: 'spki', format: 'pem' }).toString()
    this.authorityDigest = digest({ semantics: SEMANTICS, path: this.path, config: this.config,
      keyFingerprint: sha(keyBytes(this.config.keyPath)) })
    privateStat(dirname(this.path), 'directory')
    try { const fd = openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      try { fsyncSync(fd) } finally { closeSync(fd) } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    privateStat(this.path, 'file')
    const stat = lstatSync(this.path); this.identity = { dev: stat.dev, ino: stat.ino }
    this.db = new DatabaseSync(this.path)
    try {
      this.checkFiles()
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
      try {
        const app = (this.db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
        const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
        if (app === 0 && version === 0 && this.db.prepare('SELECT name FROM sqlite_master').all().length === 0) {
          this.db.exec(`CREATE TABLE authority (authority_id TEXT PRIMARY KEY, authority_digest TEXT NOT NULL CHECK(length(authority_digest)=64),
            key_id TEXT NOT NULL, public_key TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json) AND length(config_json)<=65536)) STRICT, WITHOUT ROWID;
          CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('claimed','authorized','active','closed','unknown','rejected')),
            certificate_json TEXT NOT NULL CHECK(json_valid(certificate_json) AND length(certificate_json)<=65536), certificate_digest TEXT NOT NULL CHECK(length(certificate_digest)=64),
            artifact BLOB NOT NULL CHECK(length(artifact)>0 AND length(artifact)<=524288), artifact_sha TEXT NOT NULL CHECK(length(artifact_sha)=64),
            tools_json TEXT CHECK(tools_json IS NULL OR (json_valid(tools_json) AND length(tools_json)<=65536)), tools_digest TEXT,
            receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(receipt_json)<=65536)), reason TEXT CHECK(reason IS NULL OR (length(reason)>0 AND length(reason)<=64)),
            CHECK((status='claimed' AND tools_json IS NULL AND tools_digest IS NULL AND receipt_json IS NULL AND reason IS NULL)
              OR (status IN ('authorized','active') AND tools_json IS NOT NULL AND tools_digest IS NOT NULL AND receipt_json IS NOT NULL AND reason IS NULL)
              OR (status IN ('closed','unknown','rejected') AND reason IS NOT NULL))) STRICT, WITHOUT ROWID;
          CREATE TABLE calls (plan_id TEXT NOT NULL REFERENCES adoptions(plan_id), call_key TEXT NOT NULL, arguments_digest TEXT NOT NULL CHECK(length(arguments_digest)=64),
            status TEXT NOT NULL CHECK(status IN ('claimed','completed','unknown')), result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json)<=65536)),
            job_id TEXT, tool_alias TEXT, foreground_json TEXT CHECK(foreground_json IS NULL OR (json_valid(foreground_json) AND length(foreground_json)<=4096)),
            claimed_at INTEGER, settled_at INTEGER, PRIMARY KEY(plan_id,call_key),
            CHECK((status='claimed' AND result_json IS NULL AND job_id IS NULL) OR status IN ('completed','unknown'))) STRICT, WITHOUT ROWID;
          PRAGMA application_id=${APP_ID}; PRAGMA user_version=2;`)
        } else if (app === APP_ID && version === 1) {
          this.db.exec(`ALTER TABLE calls ADD COLUMN tool_alias TEXT;
            ALTER TABLE calls ADD COLUMN foreground_json TEXT CHECK(foreground_json IS NULL OR (json_valid(foreground_json) AND length(foreground_json)<=4096));
            ALTER TABLE calls ADD COLUMN claimed_at INTEGER;
            ALTER TABLE calls ADD COLUMN settled_at INTEGER;
            PRAGMA user_version=2;`)
        } else if (app !== APP_ID || ![2, 3].includes(version)) fail()
        if (version !== 3) {
          this.db.exec(`CREATE TABLE source_archives (
            plan_id TEXT PRIMARY KEY REFERENCES adoptions(plan_id),
            archive_json TEXT NOT NULL CHECK(json_valid(archive_json) AND length(archive_json)<=${SOURCE_ARCHIVE_LIMIT})
          ) STRICT, WITHOUT ROWID; PRAGMA user_version=3;`)
        }
        const row = this.db.prepare('SELECT * FROM authority WHERE authority_id=?').get(this.config.authorityId) as
          { authority_digest: string; key_id: string; public_key: string; config_json: string } | undefined
        const count = (this.db.prepare('SELECT COUNT(*) AS n FROM authority').get() as { n: number }).n
        if (row) {
          if (count !== 1 || row.authority_digest !== this.authorityDigest || row.key_id !== this.config.keyId
            || row.public_key !== this.publicKey || row.config_json !== json(this.config)) fail()
        } else if (count !== 0) fail()
        else this.db.prepare('INSERT INTO authority VALUES (?,?,?,?,?)').run(this.config.authorityId, this.authorityDigest,
          this.config.keyId, this.publicKey, json(this.config))
        this.db.exec('COMMIT; PRAGMA journal_mode=WAL')
      } catch (e) { try { this.db.exec('ROLLBACK') } catch {} throw e }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail()
      this.checkFiles(); this.syncDirectory(); this.list()
    } catch (e) { this.db.close(); throw e }
  }
  private checkFiles(): void {
    privateStat(dirname(this.path), 'directory'); privateStat(this.path, 'file')
    const stat = lstatSync(this.path)
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) fail()
    for (const suffix of ['-wal','-shm','-journal']) {
      try { privateStat(this.path + suffix, 'file') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
  }
  private syncDirectory(): void {
    this.checkFiles()
    const fd = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  private transaction<T>(fn: () => T): T {
    this.checkFiles(); this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); this.syncDirectory(); return result }
    catch (e) { try { this.db.exec('ROLLBACK') } catch {} throw e }
  }
  private row(planId: string): AdoptionRow | undefined {
    str(planId)
    return this.db.prepare('SELECT * FROM adoptions WHERE plan_id=?').get(planId) as AdoptionRow | undefined
  }
  private decode(row: AdoptionRow): CreationCapabilityRecord {
    if (!(row.artifact instanceof Uint8Array) || row.artifact.length < 1 || row.artifact.length > 524288 || sha(Buffer.from(row.artifact)) !== row.artifact_sha
      || Buffer.byteLength(row.certificate_json) > 65536 || sha(row.certificate_json) !== row.certificate_digest) fail()
    const certificate = JSON.parse(row.certificate_json) as CreationCapabilityRecord['certificate']
    validatePluginCreationVerificationCertificate(certificate)
    if (json(certificate) !== row.certificate_json || certificate.plan.id !== row.plan_id
      || certificate.plan.artifactSha256 !== row.artifact_sha || certificate.plan.artifactBytes !== row.artifact.length) fail()
    const record: CreationCapabilityRecord = { planId: row.plan_id, status: row.status, certificate, artifact: Buffer.from(row.artifact) }
    if (row.tools_json !== null) {
      if (Buffer.byteLength(row.tools_json) > 65536 || digest(JSON.parse(row.tools_json)) !== row.tools_digest) fail()
      const tools = JSON.parse(row.tools_json) as CreationCapabilityTool[]
      this.validateTools(tools)
      if (json(tools) !== row.tools_json) fail()
      record.tools = tools
    } else if (row.tools_digest !== null) fail()
    if (row.receipt_json !== null) {
      if (Buffer.byteLength(row.receipt_json) > 65536) fail()
      const receipt = receiptShape(JSON.parse(row.receipt_json))
      if (json(receipt) !== row.receipt_json || !verifyCreationCapabilityReceipt(receipt, this.authorityDigest, this.publicKey, receipt.adoptedAt)
        || receipt.authorityId !== this.config.authorityId || receipt.keyId !== this.config.keyId
        || receipt.planId !== row.plan_id || receipt.planDigest !== certificate.plan.digest
        || receipt.verificationDigest !== digest(certificate) || receipt.artifactSha256 !== row.artifact_sha
        || receipt.artifactBytes !== row.artifact.length || receipt.source.referenceDigest !== certificate.source.referenceDigest
        || receipt.source.ownerDigest !== certificate.source.ownerDigest || receipt.source.growthRunDigest !== certificate.source.growthRunDigest
        || receipt.toolsDigest !== row.tools_digest || receipt.schemaDigest !== certificate.schemaDigest) fail()
      const expectedExpiry = this.config.retention === undefined
        ? Math.min(this.config.expiresAt, this.config.runner.expiresAt, certificate.expiresAt)
        : Math.min(this.config.expiresAt, this.config.runner.expiresAt,
          receipt.adoptedAt + this.config.retention.maximumLifetimeMs)
      if (receipt.protocol !== (this.config.retention === undefined
        ? 'dsh-created-capability-adoption/v1' : 'dsh-created-capability-adoption/v2')
        || receipt.expiresAt !== expectedExpiry || receipt.adoptedAt < certificate.verifiedAt
        || receipt.adoptedAt >= certificate.expiresAt || receipt.adoptedAt >= this.config.expiresAt
        || receipt.adoptedAt >= this.config.runner.expiresAt) fail()
      record.receipt = receipt
    }
    if (row.reason !== null) record.reason = row.reason
    if (row.status === 'claimed' && (row.tools_json !== null || row.receipt_json !== null || row.reason !== null)) fail()
    if ((row.status === 'authorized' || row.status === 'active') && (!record.receipt || !record.tools || row.reason !== null)) fail()
    return record
  }
  inspect(planId: string): CreationCapabilityRecord | undefined {
    this.checkFiles()
    const row = this.row(planId)
    if (!row) return undefined
    this.checkCalls(planId)
    return this.decode(row)
  }
  list(): readonly CreationCapabilityRecord[] {
    this.checkFiles()
    const rows = this.db.prepare('SELECT * FROM adoptions ORDER BY plan_id').all() as unknown as AdoptionRow[]
    if (rows.length > this.config.maxAdoptions) fail()
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM calls').get() as { n: number }).n > this.config.maxCallRecords) fail()
    for (const row of rows) this.checkCalls(row.plan_id)
    return rows.map(row => this.decode(row))
  }
  private checkCalls(planId: string): void {
    const rows = this.db.prepare('SELECT * FROM calls WHERE plan_id=?').all(planId) as unknown as CallRow[]
    if (rows.length > this.config.maxCallsPerAdoption) fail()
    const adoption = this.row(planId)
    if (!adoption) fail()
    const record = this.decode(adoption)
    for (const row of rows) this.decodeCall(row, record)
  }
  private decodeCall(row: CallRow, record?: CreationCapabilityRecord): CreationCapabilityCall {
    str(row.plan_id); str(row.call_key); str(row.arguments_digest, SHA, 64)
    if (!['claimed','completed','unknown'].includes(row.status) || (row.status === 'claimed' && (row.result_json !== null || row.job_id !== null))) fail()
    const adoption = record ?? this.decode(this.row(row.plan_id)!)
    if (row.tool_alias !== null) {
      str(row.tool_alias)
      if (!adoption.receipt || !adoption.tools?.some(tool => tool.name === row.tool_alias)) fail()
    }
    if (row.claimed_at === null) {
      if (row.tool_alias !== null || row.foreground_json !== null || row.settled_at !== null) fail()
    } else {
      int(row.claimed_at, 1, 8_640_000_000_000_000)
      if (row.settled_at !== null) int(row.settled_at, row.claimed_at, 8_640_000_000_000_000)
    }
    if (row.status === 'claimed' && row.settled_at !== null) fail()
    if (row.foreground_json !== null) {
      if (row.tool_alias === null || row.claimed_at === null || Buffer.byteLength(row.foreground_json) > 4096
        || witnessJson(JSON.parse(row.foreground_json), this.config, row.plan_id, row.tool_alias,
          row.arguments_digest, row.call_key) !== row.foreground_json) fail()
    }
    const call: CreationCapabilityCall = { key: row.call_key, status: row.status }
    if (row.result_json !== null) {
      if (Buffer.byteLength(row.result_json) > 65536) fail()
      call.result = JSON.parse(row.result_json)
      if (json(call.result) !== row.result_json) fail()
    }
    if (row.job_id !== null) call.jobId = str(row.job_id)
    return call
  }
  claim(input: { certificate: CreationCapabilityRecord['certificate']; artifact: Buffer;
    source?: CreationCapabilitySourceSnapshot }): { created: boolean; record: CreationCapabilityRecord } {
    validatePluginCreationVerificationCertificate(input.certificate)
    if (!Buffer.isBuffer(input.artifact) || input.artifact.length < 1 || input.artifact.length > 524288) fail()
    const certificate = input.certificate, now = Date.now(), bytes = Buffer.from(input.artifact)
    if (certificate.plan.artifactSha256 !== sha(bytes) || certificate.plan.artifactBytes !== bytes.length
      || !certificate.plan.name.startsWith(this.config.namePrefix) || certificate.authority.keyId === this.config.keyId
      || certificate.authority.authorityId === this.config.authorityId
      || now >= this.config.expiresAt || now >= this.config.runner.expiresAt || now >= certificate.expiresAt) fail()
    const certificateJson = json(certificate)
    let archiveJson: string | undefined
    if (input.source !== undefined) {
      validateCreationCapabilitySource(input.source, certificate)
      const body: Omit<CreationCapabilitySourceArchive, 'signature'> = {
        protocol: 'dsh-created-capability-source-archive/v1', authorityId: this.config.authorityId,
        authorityDigest: this.authorityDigest, keyId: this.config.keyId, planId: certificate.plan.id,
        certificateDigest: sha(certificateJson), artifactSha256: sha(bytes), source: input.source,
      }
      archiveJson = json({ ...body, signature: sign(null,
        Buffer.from(SOURCE_ARCHIVE_DOMAIN + json(body, SOURCE_ARCHIVE_LIMIT)), this.key).toString('base64url') }, SOURCE_ARCHIVE_LIMIT)
    }
    return this.transaction(() => {
      const prior = this.row(certificate.plan.id)
      if (prior) {
        const record = this.decode(prior)
        if (prior.certificate_digest !== sha(certificateJson) || prior.artifact_sha !== sha(bytes)
          || !record.artifact.equals(bytes)) fail()
        if (archiveJson !== undefined) {
          const existing = this.db.prepare('SELECT archive_json FROM source_archives WHERE plan_id=?')
            .get(certificate.plan.id) as { archive_json: string } | undefined
          if (existing?.archive_json !== archiveJson) fail()
        }
        return { created: false, record }
      }
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM adoptions').get() as { n: number }).n >= this.config.maxAdoptions) fail()
      this.db.prepare("INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha) VALUES (?,'claimed',?,?,?,?)")
        .run(certificate.plan.id, certificateJson, sha(certificateJson), bytes, sha(bytes))
      if (archiveJson !== undefined) this.db.prepare('INSERT INTO source_archives VALUES (?,?)').run(certificate.plan.id, archiveJson)
      return { created: true, record: this.decode(this.row(certificate.plan.id)!) }
    })
  }

  /** Archive validation is lazy; adoption reconciliation never loads source text. */
  inspectSourceArchive(planId: string): CreationCapabilitySourceArchive | undefined {
    const record = this.inspect(planId)
    if (!record?.receipt) return undefined
    const row = this.db.prepare('SELECT archive_json FROM source_archives WHERE plan_id=?')
      .get(planId) as { archive_json: string } | undefined
    if (!row) return undefined
    if (Buffer.byteLength(row.archive_json) > SOURCE_ARCHIVE_LIMIT) fail()
    const value = JSON.parse(row.archive_json) as unknown
    const item = obj(value, ['protocol','authorityId','authorityDigest','keyId','planId','certificateDigest','artifactSha256','source','signature'])
    if (item.protocol !== 'dsh-created-capability-source-archive/v1'
      || item.authorityId !== this.config.authorityId || item.authorityDigest !== this.authorityDigest
      || item.keyId !== this.config.keyId || item.planId !== record.planId
      || item.certificateDigest !== digest(record.certificate)
      || item.artifactSha256 !== record.certificate.plan.artifactSha256) fail()
    validateCreationCapabilitySource(item.source, record.certificate)
    const signature = str(item.signature, /^[A-Za-z0-9_-]{86}$/u, 86)
    const { signature: _signature, ...body } = item
    if (json(value, SOURCE_ARCHIVE_LIMIT) !== row.archive_json
      || Buffer.from(signature, 'base64url').toString('base64url') !== signature
      || !verify(null, Buffer.from(SOURCE_ARCHIVE_DOMAIN + json(body, SOURCE_ARCHIVE_LIMIT)),
        createPublicKey(this.key), Buffer.from(signature, 'base64url'))) fail()
    return value as CreationCapabilitySourceArchive
  }
  private validateTools(value: unknown): asserts value is CreationCapabilityTool[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1
      || value.length > this.config.maxTools || Reflect.ownKeys(value).length !== value.length + 1) fail()
    const names = new Set<string>()
    for (const tool of value) {
      const item = obj(tool, ['originalName','name','description','parameters'])
      str(item.originalName); str(item.name); str(item.description, /^[\s\S]+$/u, 2048)
      if (names.has(item.name as string)) fail()
      names.add(item.name as string)
      if (!item.parameters || typeof item.parameters !== 'object' || Array.isArray(item.parameters)) fail()
      json(item.parameters, 65536)
    }
    json(value)
  }
  authorize(planId: string, tools: readonly CreationCapabilityTool[]): CreationCapabilityRecord {
    this.validateTools(tools)
    const toolsJson = json(tools), toolsDigest = sha(toolsJson)
    return this.transaction(() => {
      const prior = this.row(planId); if (!prior) fail()
      const record = this.decode(prior)
      if (record.status === 'authorized' || record.status === 'active') {
        if (prior.tools_digest !== toolsDigest) fail()
        return record
      }
      if (record.status !== 'claimed') fail()
      const now = Date.now(), freshExpiry = Math.min(this.config.expiresAt, this.config.runner.expiresAt, record.certificate.expiresAt)
      if (now >= freshExpiry || record.certificate.verifiedAt > now) fail()
      const expiresAt = this.config.retention === undefined ? freshExpiry
        : Math.min(this.config.expiresAt, this.config.runner.expiresAt, now + this.config.retention.maximumLifetimeMs)
      const unsigned: Omit<CreationCapabilityReceipt, 'signature'> = { protocol: this.config.retention === undefined
        ? 'dsh-created-capability-adoption/v1' : 'dsh-created-capability-adoption/v2',
        authorityId: this.config.authorityId, authorityDigest: this.authorityDigest, keyId: this.config.keyId,
        planId, planDigest: record.certificate.plan.digest, verificationDigest: digest(record.certificate),
        artifactSha256: prior.artifact_sha, artifactBytes: prior.artifact.length, source: record.certificate.source,
        schemaDigest: record.certificate.schemaDigest, toolsDigest, expiresAt, adoptedAt: now }
      const receipt = receiptShape({ ...unsigned, signature: sign(null, Buffer.from(json(unsigned)), this.key).toString('base64url') })
      this.db.prepare("UPDATE adoptions SET status='authorized',tools_json=?,tools_digest=?,receipt_json=? WHERE plan_id=? AND status='claimed'")
        .run(toolsJson, toolsDigest, json(receipt), planId)
      return this.decode(this.row(planId)!)
    })
  }
  activate(planId: string): CreationCapabilityRecord {
    return this.transaction(() => {
      const prior = this.row(planId); if (!prior) fail()
      const record = this.decode(prior)
      if (record.status === 'active') return record
      if (record.status !== 'authorized' || !record.receipt || Date.now() >= record.receipt.expiresAt) fail()
      this.db.prepare("UPDATE adoptions SET status='active' WHERE plan_id=? AND status='authorized'").run(planId)
      return this.decode(this.row(planId)!)
    })
  }
  settle(planId: string, status: 'closed' | 'unknown' | 'rejected', reason: string): void {
    if (!['closed','unknown','rejected'].includes(status)) fail()
    str(reason, /^[a-z][a-z0-9-]{0,63}$/u, 64)
    this.transaction(() => {
      const prior = this.row(planId); if (!prior) fail()
      const current = this.decode(prior)
      if (current.status === status && prior.reason === reason) return
      if (['closed','unknown','rejected'].includes(current.status)) fail()
      this.db.prepare('UPDATE adoptions SET status=?,reason=? WHERE plan_id=?').run(status, reason, planId)
    })
  }
  claimCall(input: { planId: string; key: string; argumentsDigest: string; toolAlias?: string;
    foreground?: CreationCapabilityForegroundCallWitness }): { created: boolean; call: CreationCapabilityCall } {
    str(input.planId); str(input.key); str(input.argumentsDigest, SHA, 64)
    return this.transaction(() => {
      const row = this.row(input.planId); if (!row) fail()
      const record = this.decode(row)
      if (input.toolAlias !== undefined && (!record.tools?.some(tool => tool.name === input.toolAlias)
        || str(input.toolAlias) !== input.toolAlias)) fail()
      if (input.foreground !== undefined && input.toolAlias === undefined) fail()
      const foreground = input.foreground === undefined ? null : witnessJson(input.foreground, this.config,
        input.planId, input.toolAlias!, input.argumentsDigest, input.key)
      const prior = this.db.prepare('SELECT * FROM calls WHERE plan_id=? AND call_key=?').get(input.planId,input.key) as CallRow | undefined
      if (prior) {
        if (prior.arguments_digest !== input.argumentsDigest
          || (input.toolAlias !== undefined && prior.tool_alias !== null && prior.tool_alias !== input.toolAlias)
          || (prior.foreground_json !== null && foreground === null)
          || (foreground !== null && prior.foreground_json !== null && prior.foreground_json !== foreground)
          || (foreground !== null && prior.foreground_json === null && prior.claimed_at !== null)) fail()
        return { created: false, call: this.decodeCall(prior, record) }
      }
      const now = Date.now()
      if (record.status !== 'active' || !record.receipt || now >= record.receipt.expiresAt) fail()
      const global = (this.db.prepare('SELECT COUNT(*) AS n FROM calls').get() as { n: number }).n
      const local = (this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE plan_id=?').get(input.planId) as { n: number }).n
      if (global >= this.config.maxCallRecords || local >= this.config.maxCallsPerAdoption) fail()
      this.db.prepare("INSERT INTO calls(plan_id,call_key,arguments_digest,status,tool_alias,foreground_json,claimed_at) VALUES (?,?,?,'claimed',?,?,?)")
        .run(input.planId,input.key,input.argumentsDigest,input.toolAlias ?? null,foreground,now)
      return { created: true, call: { key: input.key, status: 'claimed' } }
    })
  }
  settleCall(input: { planId: string; key: string; status: 'completed' | 'unknown'; result?: unknown; jobId?: string }): void {
    str(input.planId); str(input.key)
    if (input.status !== 'completed' && input.status !== 'unknown') fail()
    const resultJson = Object.hasOwn(input, 'result') ? json(input.result) : null
    const jobId = input.jobId === undefined ? null : str(input.jobId)
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM calls WHERE plan_id=? AND call_key=?').get(input.planId,input.key) as CallRow | undefined
      if (!row || row.status !== 'claimed') fail()
      this.decodeCall(row)
      this.db.prepare('UPDATE calls SET status=?,result_json=?,job_id=?,settled_at=? WHERE plan_id=? AND call_key=? AND status=\'claimed\'')
        .run(input.status,resultJson,jobId,row.claimed_at === null ? null : Math.max(Date.now(), row.claimed_at),input.planId,input.key)
    })
  }
  /** Host-only bounded metadata; never expose candidate arguments, results or private artifact bytes. */
  listCallEvidence(planId: string): readonly CreationCapabilityCallEvidence[] {
    this.checkFiles()
    const adoption = this.row(planId)
    if (!adoption) return []
    const record = this.decode(adoption)
    const rows = this.db.prepare('SELECT * FROM calls WHERE plan_id=? ORDER BY call_key').all(planId) as unknown as CallRow[]
    if (rows.length > this.config.maxCallsPerAdoption || (rows.length > 0 && !record.receipt)) fail()
    if (!record.receipt) return []
    const receiptDigest = digest(record.receipt)
    return rows.map(row => {
      this.decodeCall(row, record)
      const tool = record.tools?.find(item => item.name === row.tool_alias)
      return { protocol: 'dsh-created-capability-call-evidence/v1' as const,
        planId, key: row.call_key, status: row.status,
        attribution: row.claimed_at === null ? 'legacy-unattributed' as const
          : row.foreground_json === null ? 'unattributed' as const : 'foreground' as const,
        ...(row.tool_alias === null ? {} : { toolAlias: row.tool_alias }),
        ...(tool === undefined ? {} : { originalName: tool.originalName }),
        receiptDigest, artifactSha256: record.receipt!.artifactSha256, schemaDigest: record.receipt!.schemaDigest,
        ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
        ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
        ...(row.foreground_json === null ? {} : { foreground: JSON.parse(row.foreground_json) as CreationCapabilityForegroundCallWitness }),
      }
    })
  }
  recoverClaims(): void {
    this.transaction(() => {
      this.db.prepare("UPDATE adoptions SET status='unknown',reason='recovered-claim' WHERE status='claimed'").run()
      this.db.prepare("UPDATE calls SET status='unknown',settled_at=CASE WHEN claimed_at IS NULL THEN NULL ELSE max(claimed_at,?) END WHERE status='claimed'")
        .run(Date.now())
    })
  }
  close(): void { this.db.close() }
}
