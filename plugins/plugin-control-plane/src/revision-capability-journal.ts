import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson, validatePluginCreationVerificationCertificate,
  validatePluginRevisionVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import type { CreationCapabilityTool } from './creation-capability-types.js'
import type { RevisionCapabilityAdoptionReceipt, RevisionCapabilityAdoptionRecord, RevisionCapabilityCall,
  RevisionCapabilityCallEvidence, RevisionCapabilityConfig, RevisionCapabilityEntry, RevisionCapabilityJournalPort,
  RevisionCapabilityModel, RevisionCapabilityRollbackRecord, RevisionCapabilitySourceRef,
  RevisionCapabilityVersion } from './revision-capability-types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const SHA = /^[a-f0-9]{64}$/u
const ALIAS = /^[a-z][a-z0-9_-]{0,95}$/u
const APP_ID = 0x44535241
const SEMANTICS = 'dsh-created-capability-revision-journal/v1:reserve-before-dispatch:unknown-no-retry:parent-cas:append-only-versions'
const DOMAIN = 'dsh-created-capability-revision-adoption-v1\0'
const MAX_ARTIFACT = 512 * 1024
const MAX_JSON = 65_536
const TABLES = ['adoptions', 'authority', 'calls', 'entries', 'rollbacks', 'versions'] as const

function fail(): never { throw new Error('revision capability journal rejected input or state') }
function obj(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== expected.length) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).sort().join('\0') !== [...expected].sort().join('\0')
    || !Object.values(descriptors).every(descriptor => descriptor.enumerable && 'value' in descriptor)) fail()
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
  const stat = lstatSync(file)
  if (realpathSync(file) !== file || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail()
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
function json(value: unknown, max = MAX_JSON): string {
  const seen = new Set<object>()
  let nodes = 0
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 32) fail()
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || seen.has(item)) fail()
    seen.add(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) fail()
      for (let index = 0; index < item.length; index++) { if (!Object.hasOwn(item, index)) fail(); walk(item[index], depth + 1) }
    } else {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      if ((Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        || Reflect.ownKeys(item).length !== Object.keys(descriptors).length
        || !Object.values(descriptors).every(descriptor => descriptor.enumerable && 'value' in descriptor)) fail()
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') fail()
        walk(descriptor.value, depth + 1)
      }
    }
    seen.delete(item)
  }
  walk(value, 0)
  const encoded = canonicalGrowthJson(value)
  if (Buffer.byteLength(encoded) > max) fail()
  return encoded
}
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
function digest(value: unknown): string { return sha(json(value)) }

function model(value: unknown): RevisionCapabilityModel {
  const item = obj(value, Object.hasOwn(value as object, 'reasoningEffort') ? ['provider', 'model', 'reasoningEffort'] : ['provider', 'model'])
  str(item.provider, /^[\s\S]+$/u, 500); str(item.model, /^[\s\S]+$/u, 500)
  if (Object.hasOwn(item, 'reasoningEffort')) str(item.reasoningEffort, /^[\s\S]+$/u, 500)
  return value as RevisionCapabilityModel
}
function sourceRef(value: unknown): RevisionCapabilitySourceRef {
  const item = obj(value, ['referenceDigest', 'ownerDigest', 'growthRunDigest'])
  for (const name of ['referenceDigest', 'ownerDigest', 'growthRunDigest']) str(item[name], SHA, 64)
  return value as RevisionCapabilitySourceRef
}
function aliases(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 16
    || Reflect.ownKeys(value).length !== value.length + 1) fail()
  const names = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail()
    const alias = str(value[index], ALIAS, 96)
    if (names.has(alias)) fail()
    names.add(alias)
  }
  return Object.freeze([...value as readonly string[]])
}
function tools(value: unknown): readonly CreationCapabilityTool[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 16
    || Reflect.ownKeys(value).length !== value.length + 1) fail()
  const names = new Set<string>()
  for (const entry of value) {
    const tool = obj(entry, ['originalName', 'name', 'description', 'parameters'])
    str(tool.originalName, ALIAS, 96); str(tool.name, ALIAS, 96); str(tool.description, /^[\s\S]+$/u, 2048)
    if (names.has(tool.name as string)) fail()
    names.add(tool.name as string)
    if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) fail()
    json(tool.parameters)
  }
  json(value)
  return value as readonly CreationCapabilityTool[]
}

/** Read-only preflight; it never creates a signing key or ledger. */
export function validateRevisionCapabilityConfig(value: unknown): asserts value is RevisionCapabilityConfig {
  const v = obj(value, ['authorityId', 'keyId', 'keyPath', 'owner', 'namePrefix', 'expiresAt', 'maxAdoptions',
    'maxInputBytes', 'maxCallRecords', 'rollback', ...(Object.hasOwn(value as object, 'retention') ? ['retention'] : [])])
  str(v.authorityId, ID); str(v.keyId, ID); path(v.keyPath)
  const owner = obj(v.owner, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  str(owner.authorityId, ID); str(owner.authorityHash, SHA, 64)
  str(owner.principalId, /^[\s\S]+$/u, 512); str(owner.principalRecordId, /^[\s\S]+$/u, 512)
  int(owner.principalVersion, 1, Number.MAX_SAFE_INTEGER); path(owner.workspace); str(owner.agentPreset, ID)
  str(v.namePrefix, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u, 48)
  int(v.expiresAt, 1, 8_640_000_000_000_000); int(v.maxAdoptions, 1, 32)
  int(v.maxInputBytes, 1, 65_536); int(v.maxCallRecords, 1, 1_024)
  const rollback = obj(v.rollback, ['authorityId', 'expiresAt', 'maxRollbacks'])
  str(rollback.authorityId, ID); int(rollback.expiresAt, 1, 8_640_000_000_000_000); int(rollback.maxRollbacks, 1, 32)
  if (Object.hasOwn(v, 'retention')) {
    const retention = obj(v.retention, ['maximumLifetimeMs'])
    int(retention.maximumLifetimeMs, 1, 30 * 86_400_000)
  }
  const privateKey = createPrivateKey(keyBytes(v.keyPath as string))
  if (privateKey.asymmetricKeyType !== 'ed25519') fail()
  json(value)
}

function canonicalConfig(config: RevisionCapabilityConfig): RevisionCapabilityConfig {
  return structuredClone(config)
}

/** Stable public identity for preflight separation from acceptance and creation adoption keys. */
export function revisionCapabilityPublicKey(config: RevisionCapabilityConfig): string {
  validateRevisionCapabilityConfig(config)
  return createPublicKey(createPrivateKey(keyBytes(config.keyPath))).export({ type: 'spki', format: 'pem' }).toString()
}

/**
 * Stable journal authority identity: canonical journal path, the full grant and the signing key file
 * fingerprint. A missing, non-canonical or non-private key fails closed before any ledger exists.
 */
export function revisionCapabilityAuthorityDigest(input: { path: string; config: RevisionCapabilityConfig }): string {
  return digest({ semantics: SEMANTICS, path: path(input.path), config: canonicalConfig(input.config),
    keyFingerprint: sha(keyBytes(input.config.keyPath)) })
}

const receiptKeys = ['protocol', 'authorityId', 'authorityDigest', 'keyId', 'planId', 'planDigest', 'verificationDigest',
  'parentPlanId', 'parentCertificateDigest', 'parentReceiptDigest', 'parentArtifactSha256', 'entryId', 'aliasesDigest',
  'artifactSha256', 'artifactBytes', 'schemaDigest', 'source', 'model', 'inFlightParentCalls', 'expiresAt', 'adoptedAt', 'signature'] as const
function receiptKeysFor(value: unknown): readonly string[] {
  const regression = value && typeof value === 'object' ? Object.hasOwn(value, 'regressionDigest') : false
  return regression ? [...receiptKeys.slice(0, 18), 'regressionDigest', ...receiptKeys.slice(18)] : receiptKeys
}
function receiptShape(value: unknown): RevisionCapabilityAdoptionReceipt {
  const v = obj(value, receiptKeysFor(value))
  if (v.protocol !== 'dsh-created-capability-revision-adoption/v1') fail()
  for (const name of ['authorityId', 'keyId', 'planId', 'parentPlanId', 'entryId']) str(v[name], ID)
  for (const name of ['authorityDigest', 'planDigest', 'verificationDigest', 'parentCertificateDigest', 'parentReceiptDigest',
    'parentArtifactSha256', 'aliasesDigest', 'artifactSha256', 'schemaDigest']) str(v[name], SHA, 64)
  int(v.artifactBytes, 1, MAX_ARTIFACT); int(v.inFlightParentCalls, 0, Number.MAX_SAFE_INTEGER)
  int(v.expiresAt, 1, 8_640_000_000_000_000); int(v.adoptedAt, 1, 8_640_000_000_000_000)
  sourceRef(v.source); model(v.model)
  if (Object.hasOwn(v, 'regressionDigest')) str(v.regressionDigest, SHA, 64)
  const signature = str(v.signature, /^[A-Za-z0-9_-]{86}$/u, 86)
  if (Buffer.from(signature, 'base64url').length !== 64 || Buffer.from(signature, 'base64url').toString('base64url') !== signature) fail()
  return value as RevisionCapabilityAdoptionReceipt
}
function receiptBody(receipt: RevisionCapabilityAdoptionReceipt): Omit<RevisionCapabilityAdoptionReceipt, 'signature'> {
  const { signature: _signature, ...body } = receipt
  return body
}

export function verifyRevisionCapabilityAdoptionReceipt(value: unknown, authorityDigest: string, publicKey: string,
  now = Date.now()): value is RevisionCapabilityAdoptionReceipt {
  try {
    const receipt = receiptShape(value)
    if (!SHA.test(authorityDigest) || receipt.authorityDigest !== authorityDigest || !Number.isSafeInteger(now)
      || receipt.adoptedAt > now || receipt.expiresAt <= now || receipt.expiresAt <= receipt.adoptedAt) return false
    const key = createPublicKey(publicKey)
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(DOMAIN + json(receiptBody(receipt), MAX_JSON)), key, Buffer.from(receipt.signature, 'base64url'))
  } catch { return false }
}

/**
 * Parent authenticity is inherited from the independently verified creation adoption record the Host
 * port re-reads; this journal only pins its exact bytes and digest so a rollback cannot substitute
 * another version.
 */
function parentReceiptShape(value: unknown, planId: string, artifactSha256: string): { json: string; digest: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail()
  const item = value as Record<string, unknown>
  if (item.protocol !== 'dsh-created-capability-adoption/v1' && item.protocol !== 'dsh-created-capability-adoption/v2') fail()
  for (const name of ['authorityId', 'keyId', 'planId']) str(item[name], ID)
  for (const name of ['authorityDigest', 'planDigest', 'verificationDigest', 'artifactSha256', 'schemaDigest', 'toolsDigest']) str(item[name], SHA, 64)
  int(item.artifactBytes, 1, MAX_ARTIFACT); int(item.expiresAt, 1, 8_640_000_000_000_000); int(item.adoptedAt, 1, 8_640_000_000_000_000)
  if (item.planId !== planId || item.artifactSha256 !== artifactSha256) fail()
  const signature = str(item.signature, /^[A-Za-z0-9_-]{86}$/u, 86)
  if (Buffer.from(signature, 'base64url').length !== 64 || Buffer.from(signature, 'base64url').toString('base64url') !== signature) fail()
  const encoded = json(value, MAX_JSON)
  return { json: encoded, digest: sha(encoded) }
}

interface AuthorityRow { authority_id: string; authority_digest: string; key_id: string; public_key: string; config_json: string }
interface EntryRow { entry_id: string; name: string; aliases_json: string; aliases_digest: string;
  parent_plan_id: string; current_plan_id: string; revision: number; created_at: number; updated_at: number }
interface VersionRow { plan_id: string; entry_id: string; role: 'parent' | 'revision'; certificate_json: string;
  certificate_digest: string; receipt_json: string; receipt_digest: string; tools_json: string; artifact: Uint8Array;
  artifact_sha: string; schema_digest: string; source_json: string; model_json: string; regression_digest: string | null;
  adopted_at: number; expires_at: number }
interface AdoptionRow { plan_id: string; status: RevisionCapabilityAdoptionRecord['status']; parent_plan_id: string;
  certificate_digest: string; claimed_at: number; settled_at: number | null; reason: string | null;
  entry_id: string | null; in_flight_parent_calls: number | null }
interface CallRow { entry_id: string; call_key: string; version_plan_id: string; tool_alias: string;
  arguments_digest: string; status: RevisionCapabilityCall['status']; result_json: string | null;
  claimed_at: number; settled_at: number | null }
interface RollbackRow { seq: number; rollback_id: string; entry_id: string; from_plan_id: string; to_plan_id: string;
  parent_receipt_digest: string; authority_id: string; at: number; ordinal: number; digest: string }

/** Reservations consume quota before any external action; recovery only marks uncertainty. */
export class RevisionCapabilityJournal implements RevisionCapabilityJournalPort {
  readonly authorityDigest: string
  readonly publicKey: string
  private readonly db: DatabaseSync
  private readonly key: KeyObject
  private readonly identity: { dev: number; ino: number }
  private readonly ledgerPath: string
  private readonly config: RevisionCapabilityConfig
  constructor(input: { path: string; config: RevisionCapabilityConfig }) {
    validateRevisionCapabilityConfig(input.config)
    this.config = canonicalConfig(input.config)
    this.ledgerPath = path(input.path)
    if (!this.ledgerPath.endsWith('/revision-adoptions.sqlite') || this.ledgerPath === this.config.keyPath) fail()
    this.key = createPrivateKey(keyBytes(this.config.keyPath))
    this.publicKey = createPublicKey(this.key).export({ type: 'spki', format: 'pem' }).toString()
    this.authorityDigest = revisionCapabilityAuthorityDigest({ path: this.ledgerPath, config: this.config })
    privateStat(dirname(this.ledgerPath), 'directory')
    try {
      const fd = openSync(this.ledgerPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      try { fsyncSync(fd) } finally { closeSync(fd) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    privateStat(this.ledgerPath, 'file')
    const stat = lstatSync(this.ledgerPath); this.identity = { dev: stat.dev, ino: stat.ino }
    this.db = new DatabaseSync(this.ledgerPath)
    try {
      this.checkFiles()
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
      try {
        const app = (this.db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
        const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
        const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name).sort()
        if (app === 0 && version === 0 && tables.length === 0) {
          this.db.exec(schemaSql())
        } else {
          // Append-only evolution: a known older version may only add tables/columns in a
          // forward migration; any unknown application id or schema version fails closed.
          if (app !== APP_ID || version !== 1) fail()
          const expected = [...TABLES].sort().join('\0')
          if (tables.join('\0') !== expected) fail()
        }
        const row = this.db.prepare('SELECT * FROM authority WHERE authority_id=?').get(this.config.authorityId) as AuthorityRow | undefined
        const count = (this.db.prepare('SELECT COUNT(*) AS n FROM authority').get() as { n: number }).n
        if (row) {
          if (count !== 1 || row.authority_digest !== this.authorityDigest || row.key_id !== this.config.keyId
            || row.public_key !== this.publicKey || row.config_json !== json(this.config)) fail()
        } else if (count !== 0) fail()
        else this.db.prepare('INSERT INTO authority VALUES (?,?,?,?,?)').run(this.config.authorityId, this.authorityDigest,
          this.config.keyId, this.publicKey, json(this.config))
        this.db.exec('COMMIT; PRAGMA journal_mode=WAL')
      } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* keep the original error */ } throw error }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail()
      this.checkFiles(); this.syncDirectory(); this.listEntries()
    } catch (error) { this.db.close(); throw error }
  }
  private checkFiles(): void {
    privateStat(dirname(this.ledgerPath), 'directory'); privateStat(this.ledgerPath, 'file')
    const stat = lstatSync(this.ledgerPath)
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) fail()
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { privateStat(this.ledgerPath + suffix, 'file') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  private syncDirectory(): void {
    this.checkFiles()
    const fd = openSync(dirname(this.ledgerPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  private transaction<T>(callback: () => T): T {
    this.checkFiles(); this.db.exec('BEGIN IMMEDIATE')
    try { const result = callback(); this.db.exec('COMMIT'); this.syncDirectory(); return result }
    catch (error) { try { this.db.exec('ROLLBACK') } catch { /* keep the original error */ } throw error }
  }
  private count(table: 'adoptions' | 'calls' | 'rollbacks'): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n
  }
  usage(): { adoptions: number; rollbacks: number; calls: number } {
    this.checkFiles()
    return { adoptions: this.count('adoptions'), rollbacks: this.count('rollbacks'), calls: this.count('calls') }
  }
  private row<T>(sql: string, ...args: readonly (string | number)[]): T | undefined {
    return this.db.prepare(sql).get(...(args as (string | number)[])) as T | undefined
  }
  private versionRow(planId: string): VersionRow | undefined {
    return this.row<VersionRow>('SELECT * FROM versions WHERE plan_id=?', str(planId, ID))
  }
  private decodeEntry(row: EntryRow): RevisionCapabilityEntry {
    str(row.entry_id, ID); str(row.name, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 64)
    const list = aliases(JSON.parse(row.aliases_json))
    if (json([...list]) !== row.aliases_json || digest([...list]) !== row.aliases_digest) fail()
    str(row.parent_plan_id, ID); str(row.current_plan_id, ID); int(row.revision, 1, Number.MAX_SAFE_INTEGER)
    int(row.created_at, 1, 8_640_000_000_000_000); int(row.updated_at, 1, 8_640_000_000_000_000)
    return { entryId: row.entry_id, name: row.name, aliases: list, aliasesDigest: row.aliases_digest,
      parentPlanId: row.parent_plan_id, currentPlanId: row.current_plan_id,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
  }
  private decodeVersion(row: VersionRow): RevisionCapabilityVersion {
    str(row.plan_id, ID); str(row.entry_id, ID)
    if (!(row.artifact instanceof Uint8Array) || row.artifact.length < 1 || row.artifact.length > MAX_ARTIFACT
      || sha(Buffer.from(row.artifact)) !== row.artifact_sha) fail()
    if (Buffer.byteLength(row.certificate_json) > MAX_JSON || sha(row.certificate_json) !== row.certificate_digest
      || Buffer.byteLength(row.receipt_json) > MAX_JSON || sha(row.receipt_json) !== row.receipt_digest) fail()
    const certificate = JSON.parse(row.certificate_json) as RevisionCapabilityVersion['certificate']
    if (row.role === 'parent') validatePluginCreationVerificationCertificate(certificate)
    else {
      validatePluginRevisionVerificationCertificate(certificate)
      const receipt = receiptShape(JSON.parse(row.receipt_json))
      if (!verifyRevisionCapabilityAdoptionReceipt(receipt, this.authorityDigest, this.publicKey, receipt.adoptedAt)
        || receipt.authorityId !== this.config.authorityId || receipt.keyId !== this.config.keyId) fail()
      if (receipt.planId !== row.plan_id || receipt.planDigest !== certificate.plan.digest
        || receipt.verificationDigest !== sha(row.certificate_json) || receipt.artifactSha256 !== row.artifact_sha
        || receipt.artifactBytes !== row.artifact.length || receipt.schemaDigest !== certificate.schemaDigest
        || receipt.entryId !== row.entry_id || json(receipt.source) !== json(certificate.source)
        || json(receipt.model) !== json(certificate.model)
        || receipt.expiresAt !== row.expires_at || receipt.adoptedAt !== row.adopted_at
        || (receipt.regressionDigest === undefined) !== (row.regression_digest === null)
        || (receipt.regressionDigest !== undefined && receipt.regressionDigest !== row.regression_digest)
        || receipt.parentPlanId !== certificate.parent.planId
        || receipt.parentCertificateDigest !== certificate.parent.certificateDigest
        || receipt.parentArtifactSha256 !== certificate.parent.artifactSha256) fail()
    }
    if (certificate.plan.id !== row.plan_id || certificate.plan.artifactSha256 !== row.artifact_sha
      || certificate.plan.artifactBytes !== row.artifact.length || certificate.schemaDigest !== row.schema_digest
      || json(certificate) !== row.certificate_json) fail()
    if (row.role === 'parent') {
      const parentReceipt = parentReceiptShape(JSON.parse(row.receipt_json), row.plan_id, row.artifact_sha)
      if (parentReceipt.json !== row.receipt_json || parentReceipt.digest !== row.receipt_digest) fail()
    }
    const versionTools = tools(JSON.parse(row.tools_json))
    if (json(versionTools) !== row.tools_json) fail()
    const versionSource = sourceRef(JSON.parse(row.source_json))
    if (json(versionSource) !== row.source_json || json(versionSource) !== json(certificate.source)) fail()
    const versionModel = model(JSON.parse(row.model_json))
    if (json(versionModel) !== row.model_json || json(versionModel) !== json(certificate.model)) fail()
    int(row.adopted_at, 1, 8_640_000_000_000_000); int(row.expires_at, 1, 8_640_000_000_000_000)
    if (row.expires_at <= row.adopted_at) fail()
    return { planId: row.plan_id, entryId: row.entry_id, role: row.role, name: certificate.plan.name,
      certificate, certificateDigest: row.certificate_digest, receiptJson: row.receipt_json,
      receiptDigest: row.receipt_digest, tools: versionTools, artifact: Buffer.from(row.artifact),
      artifactSha256: row.artifact_sha, schemaDigest: row.schema_digest, source: versionSource, model: versionModel,
      ...(row.regression_digest === null ? {} : { regressionDigest: row.regression_digest }),
      adoptedAt: row.adopted_at, expiresAt: row.expires_at }
  }
  private decodeAdoption(row: AdoptionRow): RevisionCapabilityAdoptionRecord {
    str(row.plan_id, ID); str(row.parent_plan_id, ID); str(row.certificate_digest, SHA, 64)
    if (!['claimed', 'active', 'closed', 'unknown', 'rejected'].includes(row.status)) fail()
    int(row.claimed_at, 1, 8_640_000_000_000_000)
    const record: RevisionCapabilityAdoptionRecord = { planId: row.plan_id, status: row.status,
      parentPlanId: row.parent_plan_id, certificateDigest: row.certificate_digest, claimedAt: row.claimed_at }
    if (row.settled_at !== null) record.settledAt = int(row.settled_at, 1, 8_640_000_000_000_000)
    if (row.reason !== null) record.reason = str(row.reason, /^[a-z][a-z0-9-]{0,63}$/u, 64)
    if (row.entry_id !== null) record.entryId = str(row.entry_id, ID)
    if (row.in_flight_parent_calls !== null) record.inFlightParentCalls = int(row.in_flight_parent_calls, 0, Number.MAX_SAFE_INTEGER)
    if (row.status === 'active') {
      if (record.entryId === undefined || record.inFlightParentCalls === undefined
        || record.settledAt === undefined || record.reason !== undefined) fail()
    } else if (row.status === 'claimed') {
      if (record.settledAt !== undefined || record.reason !== undefined
        || record.entryId !== undefined || record.inFlightParentCalls !== undefined) fail()
    } else if (record.settledAt === undefined || record.reason === undefined
      || record.entryId !== undefined || record.inFlightParentCalls !== undefined) fail()
    return record
  }
  inspectAdoption(planId: string): RevisionCapabilityAdoptionRecord | undefined {
    this.checkFiles()
    const row = this.row<AdoptionRow>('SELECT * FROM adoptions WHERE plan_id=?', str(planId, ID))
    return row === undefined ? undefined : this.decodeAdoption(row)
  }
  listEntries(): readonly RevisionCapabilityEntry[] {
    this.checkFiles()
    const rows = this.db.prepare('SELECT * FROM entries ORDER BY entry_id').all() as unknown as EntryRow[]
    return rows.map(row => this.decodeEntry(row))
  }
  inspectVersion(planId: string): RevisionCapabilityVersion | undefined {
    this.checkFiles()
    const row = this.versionRow(planId)
    return row === undefined ? undefined : this.decodeVersion(row)
  }
  inspectEntry(entryId: string): { entry: RevisionCapabilityEntry; parent: RevisionCapabilityVersion;
    current: RevisionCapabilityVersion } | undefined {
    this.checkFiles()
    const row = this.row<EntryRow>('SELECT * FROM entries WHERE entry_id=?', str(entryId, ID))
    if (!row) return undefined
    const entry = this.decodeEntry(row)
    const parentRow = this.versionRow(entry.parentPlanId), currentRow = this.versionRow(entry.currentPlanId)
    if (!parentRow || !currentRow) fail()
    const parent = this.decodeVersion(parentRow), current = this.decodeVersion(currentRow)
    if (parent.role !== 'parent' || parent.entryId !== entry.entryId || current.entryId !== entry.entryId) fail()
    return { entry, parent, current }
  }
  claim(input: { planId: string; parentPlanId: string; certificateDigest: string }): { created: boolean
    record: RevisionCapabilityAdoptionRecord } {
    str(input.planId, ID); str(input.parentPlanId, ID); str(input.certificateDigest, SHA, 64)
    return this.transaction(() => {
      const prior = this.row<AdoptionRow>('SELECT * FROM adoptions WHERE plan_id=?', input.planId)
      if (prior) {
        const record = this.decodeAdoption(prior)
        if (record.parentPlanId !== input.parentPlanId || record.certificateDigest !== input.certificateDigest) fail()
        return { created: false, record }
      }
      if (Date.now() >= this.config.expiresAt) fail()
      if (this.count('adoptions') >= this.config.maxAdoptions) fail()
      this.db.prepare("INSERT INTO adoptions(plan_id,status,parent_plan_id,certificate_digest,claimed_at) VALUES (?,'claimed',?,?,?)")
        .run(input.planId, input.parentPlanId, input.certificateDigest, Date.now())
      return { created: true, record: this.decodeAdoption(this.row<AdoptionRow>('SELECT * FROM adoptions WHERE plan_id=?', input.planId)!) }
    })
  }
  settle(planId: string, status: 'closed' | 'unknown' | 'rejected', reason: string): void {
    str(planId, ID)
    if (!['closed', 'unknown', 'rejected'].includes(status)) fail()
    str(reason, /^[a-z][a-z0-9-]{0,63}$/u, 64)
    this.transaction(() => {
      const prior = this.row<AdoptionRow>('SELECT * FROM adoptions WHERE plan_id=?', planId)
      if (!prior) fail()
      if (prior.status === status && prior.reason === reason) return
      if (prior.status !== 'claimed') fail()
      this.db.prepare("UPDATE adoptions SET status=?,reason=?,settled_at=? WHERE plan_id=? AND status='claimed'")
        .run(status, reason, Date.now(), planId)
    })
  }
  commit(input: { entry: { entryId: string; name: string; aliases: readonly string[] }
    parent: RevisionCapabilityVersion; revision: RevisionCapabilityVersion
    receipt: RevisionCapabilityAdoptionReceipt; expectedCurrentPlanId: string; inFlightParentCalls: number }):
    RevisionCapabilityAdoptionRecord {
    str(input.entry.entryId, ID); str(input.entry.name, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 64)
    str(input.expectedCurrentPlanId, ID); int(input.inFlightParentCalls, 0, Number.MAX_SAFE_INTEGER)
    const receipt = receiptShape(input.receipt)
    if (!verifyRevisionCapabilityAdoptionReceipt(receipt, this.authorityDigest, this.publicKey, receipt.adoptedAt)
      || receipt.authorityId !== this.config.authorityId || receipt.keyId !== this.config.keyId
      || receipt.entryId !== input.entry.entryId || receipt.aliasesDigest !== digest([...input.entry.aliases])
      || receipt.planId !== input.revision.planId || input.revision.role !== 'revision'
      || input.parent.role !== 'parent' || input.parent.entryId !== input.entry.entryId
      || input.revision.entryId !== input.entry.entryId
      || receipt.planDigest !== input.revision.certificate.plan.digest
      || receipt.verificationDigest !== input.revision.certificateDigest
      || receipt.artifactSha256 !== input.revision.artifactSha256 || receipt.schemaDigest !== input.revision.schemaDigest
      || receipt.parentPlanId !== input.parent.planId || receipt.parentCertificateDigest !== input.parent.certificateDigest
      || receipt.parentReceiptDigest !== input.parent.receiptDigest || receipt.parentArtifactSha256 !== input.parent.artifactSha256
      || receipt.expiresAt !== input.revision.expiresAt || receipt.adoptedAt !== input.revision.adoptedAt
      || receipt.inFlightParentCalls !== input.inFlightParentCalls
      || (receipt.regressionDigest === undefined) !== (input.revision.regressionDigest === undefined)
      || (receipt.regressionDigest !== undefined && receipt.regressionDigest !== input.revision.regressionDigest)) fail()
    const expectedExpiry = this.config.retention === undefined
      ? Math.min(this.config.expiresAt, input.revision.certificate.expiresAt)
      : Math.min(this.config.expiresAt, input.revision.adoptedAt + this.config.retention.maximumLifetimeMs)
    if (input.revision.expiresAt !== expectedExpiry
      || input.revision.adoptedAt < input.revision.certificate.verifiedAt
      || input.revision.adoptedAt >= input.revision.certificate.expiresAt
      || input.revision.adoptedAt >= this.config.expiresAt) fail()
    return this.transaction(() => {
      const adoption = this.row<AdoptionRow>('SELECT * FROM adoptions WHERE plan_id=?', input.revision.planId)
      if (!adoption || adoption.status !== 'claimed' || adoption.certificate_digest !== input.revision.certificateDigest
        || adoption.parent_plan_id !== input.parent.planId) fail()
      const priorEntry = this.row<EntryRow>('SELECT * FROM entries WHERE entry_id=?', input.entry.entryId)
      let revisionCount: number
      if (!priorEntry) {
        if (input.expectedCurrentPlanId !== input.parent.planId) fail()
        this.db.prepare('INSERT INTO entries(entry_id,name,aliases_json,aliases_digest,parent_plan_id,current_plan_id,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)')
          .run(input.entry.entryId, input.entry.name, json([...input.entry.aliases]), digest([...input.entry.aliases]),
            input.parent.planId, input.parent.planId, input.revision.adoptedAt, input.revision.adoptedAt)
        this.insertVersion(input.parent)
        revisionCount = 1
      } else {
        const entry = this.decodeEntry(priorEntry)
        if (entry.parentPlanId !== input.parent.planId || entry.currentPlanId !== input.expectedCurrentPlanId
          || entry.currentPlanId !== input.parent.planId || entry.name !== input.entry.name
          || json([...entry.aliases]) !== json([...input.entry.aliases])) fail()
        revisionCount = entry.revision
      }
      if (this.versionRow(input.revision.planId)) fail()
      this.insertVersion(input.revision)
      const updated = this.db.prepare('UPDATE entries SET current_plan_id=?, revision=revision+1, updated_at=? WHERE entry_id=? AND current_plan_id=? AND revision=?')
        .run(input.revision.planId, input.revision.adoptedAt, input.entry.entryId, input.expectedCurrentPlanId, revisionCount)
      if (Number(updated.changes) !== 1) fail()
      const settled = this.db.prepare("UPDATE adoptions SET status='active',entry_id=?,in_flight_parent_calls=?,settled_at=? WHERE plan_id=? AND status='claimed'")
        .run(input.entry.entryId, input.inFlightParentCalls, input.revision.adoptedAt, input.revision.planId)
      if (Number(settled.changes) !== 1) fail()
      return this.decodeAdoption(this.row<AdoptionRow>('SELECT * FROM adoptions WHERE plan_id=?', input.revision.planId)!)
    })
  }
  signReceipt(body: Omit<RevisionCapabilityAdoptionReceipt, 'signature'>): RevisionCapabilityAdoptionReceipt {
    const canonicalBody = JSON.parse(json(body)) as Omit<RevisionCapabilityAdoptionReceipt, 'signature'>
    const signature = sign(null, Buffer.from(DOMAIN + json(canonicalBody, MAX_JSON)), this.key).toString('base64url')
    return receiptShape({ ...canonicalBody, signature })
  }
  private insertVersion(version: RevisionCapabilityVersion): void {
    const certificateJson = json(version.certificate)
    if (version.role === 'parent') {
      const receipt = parentReceiptShape(JSON.parse(version.receiptJson), version.planId, version.artifactSha256)
      if (receipt.digest !== version.receiptDigest) fail()
    } else if (sha(version.receiptJson) !== version.receiptDigest) fail()
    this.db.prepare('INSERT INTO versions(plan_id,entry_id,role,certificate_json,certificate_digest,receipt_json,receipt_digest,tools_json,artifact,artifact_sha,schema_digest,source_json,model_json,regression_digest,adopted_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(version.planId, version.entryId, version.role, certificateJson, sha(certificateJson), version.receiptJson,
        version.receiptDigest, json([...version.tools]), version.artifact, version.artifactSha256, version.schemaDigest,
        json(version.source), json(version.model), version.regressionDigest ?? null, version.adoptedAt, version.expiresAt)
  }
  rollback(input: { entryId: string; expectedCurrentPlanId: string; authorityId: string }):
    { created: boolean; record: RevisionCapabilityRollbackRecord } {
    str(input.entryId, ID); str(input.expectedCurrentPlanId, ID); str(input.authorityId, ID)
    const rollbackId = digest({ entryId: input.entryId, expectedCurrentPlanId: input.expectedCurrentPlanId, authorityId: input.authorityId })
    return this.transaction(() => {
      const prior = this.row<RollbackRow>('SELECT * FROM rollbacks WHERE rollback_id=?', rollbackId)
      if (prior) return { created: false, record: this.decodeRollback(prior) }
      if (Date.now() >= this.config.rollback.expiresAt) fail()
      if (this.count('rollbacks') >= this.config.rollback.maxRollbacks) fail()
      const entryRow = this.row<EntryRow>('SELECT * FROM entries WHERE entry_id=?', input.entryId)
      if (!entryRow) fail()
      const entry = this.decodeEntry(entryRow)
      if (entry.currentPlanId !== input.expectedCurrentPlanId || entry.currentPlanId === entry.parentPlanId) fail()
      const childRow = this.versionRow(entry.currentPlanId), parentRow = this.versionRow(entry.parentPlanId)
      if (!childRow || !parentRow) fail()
      const child = this.decodeVersion(childRow), parent = this.decodeVersion(parentRow)
      if (child.role !== 'revision' || parent.role !== 'parent' || child.entryId !== entry.entryId
        || parent.entryId !== entry.entryId) fail()
      const childReceipt = receiptShape(JSON.parse(child.receiptJson))
      if (childReceipt.parentPlanId !== entry.parentPlanId || childReceipt.parentReceiptDigest !== parent.receiptDigest) fail()
      const ordinal = this.count('rollbacks') + 1, at = Date.now()
      const body = { rollbackId, entryId: entry.entryId, fromPlanId: entry.currentPlanId, toPlanId: entry.parentPlanId,
        parentReceiptDigest: parent.receiptDigest, authorityId: input.authorityId, at, ordinal }
      const recordDigest = digest(body)
      this.db.prepare('INSERT INTO rollbacks(rollback_id,entry_id,from_plan_id,to_plan_id,parent_receipt_digest,authority_id,at,ordinal,digest) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(rollbackId, entry.entryId, entry.currentPlanId, entry.parentPlanId, parent.receiptDigest, input.authorityId, at, ordinal, recordDigest)
      const updated = this.db.prepare('UPDATE entries SET current_plan_id=?, revision=revision+1, updated_at=? WHERE entry_id=? AND current_plan_id=? AND revision=?')
        .run(entry.parentPlanId, at, entry.entryId, entry.currentPlanId, entry.revision)
      if (Number(updated.changes) !== 1) fail()
      return { created: true, record: this.decodeRollback(this.row<RollbackRow>('SELECT * FROM rollbacks WHERE rollback_id=?', rollbackId)!) }
    })
  }
  private decodeRollback(row: RollbackRow): RevisionCapabilityRollbackRecord {
    str(row.rollback_id, SHA, 64); str(row.entry_id, ID); str(row.from_plan_id, ID); str(row.to_plan_id, ID)
    str(row.parent_receipt_digest, SHA, 64); str(row.authority_id, ID); int(row.at, 1, 8_640_000_000_000_000)
    int(row.ordinal, 1, 32); str(row.digest, SHA, 64)
    const body = { rollbackId: row.rollback_id, entryId: row.entry_id, fromPlanId: row.from_plan_id, toPlanId: row.to_plan_id,
      parentReceiptDigest: row.parent_receipt_digest, authorityId: row.authority_id, at: row.at, ordinal: row.ordinal }
    if (digest(body) !== row.digest) fail()
    return { protocol: 'dsh-created-capability-revision-rollback/v1', ...body, digest: row.digest }
  }
  claimCall(input: { entryId: string; key: string; argumentsDigest: string; toolAlias: string; versionPlanId: string }):
    { created: boolean; call: RevisionCapabilityCall } {
    str(input.entryId, ID); str(input.key, SHA, 64); str(input.argumentsDigest, SHA, 64)
    str(input.toolAlias, ALIAS, 96); str(input.versionPlanId, ID)
    return this.transaction(() => {
      const prior = this.row<CallRow>('SELECT * FROM calls WHERE entry_id=? AND call_key=?', input.entryId, input.key)
      if (prior) {
        if (prior.arguments_digest !== input.argumentsDigest || prior.tool_alias !== input.toolAlias) fail()
        return { created: false, call: this.decodeCall(prior) }
      }
      const entryRow = this.row<EntryRow>('SELECT * FROM entries WHERE entry_id=?', input.entryId)
      if (!entryRow) fail()
      const entry = this.decodeEntry(entryRow)
      if (entry.currentPlanId !== input.versionPlanId || !entry.aliases.includes(input.toolAlias)) fail()
      const versionRow = this.versionRow(input.versionPlanId)
      if (!versionRow) fail()
      const version = this.decodeVersion(versionRow)
      if (version.entryId !== entry.entryId || Date.now() >= version.expiresAt) fail()
      if (this.count('calls') >= this.config.maxCallRecords) fail()
      this.db.prepare("INSERT INTO calls(entry_id,call_key,version_plan_id,tool_alias,arguments_digest,status,claimed_at) VALUES (?,?,?,?,?,'claimed',?)")
        .run(input.entryId, input.key, input.versionPlanId, input.toolAlias, input.argumentsDigest, Date.now())
      return { created: true, call: { key: input.key, versionPlanId: input.versionPlanId, status: 'claimed' } }
    })
  }
  private decodeCall(row: CallRow): RevisionCapabilityCall {
    str(row.entry_id, ID); str(row.call_key, SHA, 64); str(row.version_plan_id, ID); str(row.tool_alias, ALIAS, 96)
    str(row.arguments_digest, SHA, 64); int(row.claimed_at, 1, 8_640_000_000_000_000)
    if (!['claimed', 'completed', 'unknown'].includes(row.status)) fail()
    const call: RevisionCapabilityCall = { key: row.call_key, versionPlanId: row.version_plan_id, status: row.status }
    if (row.result_json !== null) {
      if (Buffer.byteLength(row.result_json) > MAX_JSON) fail()
      call.result = JSON.parse(row.result_json)
      if (json(call.result) !== row.result_json) fail()
    }
    if (row.settled_at !== null) int(row.settled_at, 1, 8_640_000_000_000_000)
    if ((row.status === 'claimed') !== (row.settled_at === null && row.result_json === null)) fail()
    return call
  }
  settleCall(input: { entryId: string; key: string; status: 'completed' | 'unknown'; result?: unknown }): void {
    str(input.entryId, ID); str(input.key, SHA, 64)
    if (input.status !== 'completed' && input.status !== 'unknown') fail()
    const resultJson = Object.hasOwn(input, 'result') ? json(input.result) : null
    this.transaction(() => {
      const row = this.row<CallRow>('SELECT * FROM calls WHERE entry_id=? AND call_key=?', input.entryId, input.key)
      if (!row || row.status !== 'claimed') fail()
      this.decodeCall(row)
      this.db.prepare("UPDATE calls SET status=?,result_json=?,settled_at=? WHERE entry_id=? AND call_key=? AND status='claimed'")
        .run(input.status, resultJson, Math.max(Date.now(), row.claimed_at), input.entryId, input.key)
    })
  }
  listCallEvidence(entryId: string): readonly RevisionCapabilityCallEvidence[] {
    this.checkFiles()
    str(entryId, ID)
    const rows = this.db.prepare('SELECT * FROM calls WHERE entry_id=? ORDER BY claimed_at, call_key').all(entryId) as unknown as CallRow[]
    if (rows.length > this.config.maxCallRecords) fail()
    const entry = this.row<EntryRow>('SELECT * FROM entries WHERE entry_id=?', entryId)
    if (!entry) return []
    return rows.map(row => {
      const call = this.decodeCall(row)
      const versionRow = this.versionRow(call.versionPlanId)
      if (!versionRow) fail()
      const version = this.decodeVersion(versionRow)
      return { protocol: 'dsh-created-capability-revision-call/v1' as const, entryId, key: call.key,
        versionPlanId: call.versionPlanId, toolAlias: row.tool_alias, status: call.status,
        receiptDigest: version.receiptDigest, claimedAt: row.claimed_at,
        ...(row.settled_at === null ? {} : { settledAt: row.settled_at }) }
    })
  }
  recoverClaims(): void {
    this.transaction(() => {
      this.db.prepare("UPDATE adoptions SET status='unknown',reason='recovered-claim',settled_at=? WHERE status='claimed'").run(Date.now())
      this.db.prepare("UPDATE calls SET status='unknown',settled_at=CASE WHEN claimed_at IS NULL THEN NULL ELSE max(claimed_at,?) END WHERE status='claimed'").run(Date.now())
    })
  }
  close(): void { this.db.close() }
}

function schemaSql(): string {
  return [
    'CREATE TABLE authority (authority_id TEXT PRIMARY KEY, authority_digest TEXT NOT NULL CHECK(length(authority_digest)=64),',
    '  key_id TEXT NOT NULL, public_key TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json) AND length(config_json)<=65536)) STRICT, WITHOUT ROWID;',
    'CREATE TABLE entries (entry_id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases_json TEXT NOT NULL CHECK(json_valid(aliases_json) AND length(aliases_json)<=16384),',
    '  aliases_digest TEXT NOT NULL CHECK(length(aliases_digest)=64), parent_plan_id TEXT NOT NULL, current_plan_id TEXT NOT NULL,',
    '  revision INTEGER NOT NULL CHECK(revision>=1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT, WITHOUT ROWID;',
    'CREATE TABLE versions (plan_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(entry_id),',
    "  role TEXT NOT NULL CHECK(role IN ('parent','revision')), certificate_json TEXT NOT NULL CHECK(json_valid(certificate_json) AND length(certificate_json)<=65536),",
    '  certificate_digest TEXT NOT NULL CHECK(length(certificate_digest)=64), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=65536),',
    '  receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64), tools_json TEXT NOT NULL CHECK(json_valid(tools_json) AND length(tools_json)<=65536),',
    '  artifact BLOB NOT NULL CHECK(length(artifact)>0 AND length(artifact)<=524288), artifact_sha TEXT NOT NULL CHECK(length(artifact_sha)=64),',
    '  schema_digest TEXT NOT NULL CHECK(length(schema_digest)=64), source_json TEXT NOT NULL CHECK(json_valid(source_json) AND length(source_json)<=4096),',
    '  model_json TEXT NOT NULL CHECK(json_valid(model_json) AND length(model_json)<=4096), regression_digest TEXT CHECK(regression_digest IS NULL OR length(regression_digest)=64),',
    '  adopted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT, WITHOUT ROWID;',
    "CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('claimed','active','closed','unknown','rejected')),",
    '  parent_plan_id TEXT NOT NULL, certificate_digest TEXT NOT NULL CHECK(length(certificate_digest)=64), claimed_at INTEGER NOT NULL,',
    "  settled_at INTEGER, reason TEXT CHECK(reason IS NULL OR (length(reason)>0 AND length(reason)<=64)), entry_id TEXT,",
    '  in_flight_parent_calls INTEGER, CHECK((status=\'claimed\' AND settled_at IS NULL AND reason IS NULL AND entry_id IS NULL AND in_flight_parent_calls IS NULL)',
    '    OR (status=\'active\' AND settled_at IS NOT NULL AND reason IS NULL AND entry_id IS NOT NULL AND in_flight_parent_calls IS NOT NULL)',
    "    OR (status IN ('closed','unknown','rejected') AND settled_at IS NOT NULL AND reason IS NOT NULL AND entry_id IS NULL AND in_flight_parent_calls IS NULL))) STRICT, WITHOUT ROWID;",
    'CREATE TABLE calls (entry_id TEXT NOT NULL REFERENCES entries(entry_id), call_key TEXT NOT NULL, version_plan_id TEXT NOT NULL,',
    '  tool_alias TEXT NOT NULL, arguments_digest TEXT NOT NULL CHECK(length(arguments_digest)=64),',
    "  status TEXT NOT NULL CHECK(status IN ('claimed','completed','unknown')), result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json)<=65536)),",
    '  claimed_at INTEGER NOT NULL, settled_at INTEGER, PRIMARY KEY(entry_id, call_key),',
    "  CHECK((status='claimed' AND result_json IS NULL AND settled_at IS NULL) OR status IN ('completed','unknown'))) STRICT, WITHOUT ROWID;",
    'CREATE TABLE rollbacks (seq INTEGER PRIMARY KEY, rollback_id TEXT NOT NULL UNIQUE, entry_id TEXT NOT NULL REFERENCES entries(entry_id),',
    '  from_plan_id TEXT NOT NULL, to_plan_id TEXT NOT NULL, parent_receipt_digest TEXT NOT NULL CHECK(length(parent_receipt_digest)=64),',
    '  authority_id TEXT NOT NULL, at INTEGER NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=1), digest TEXT NOT NULL CHECK(length(digest)=64)) STRICT;',
    'PRAGMA application_id=' + APP_ID + ';',
    'PRAGMA user_version=1;',
  ].join('\n')
}
