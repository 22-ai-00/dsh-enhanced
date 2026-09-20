import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { EffectBlockedReplayResult } from './effect-blocked-replay.js'
import { assertReplayEndpointResponse } from './replay-endpoint-protocol.js'
import { privateRuntimeObserverDirectory, runtimeConfigDigest } from './runtime-observer-protocol.js'

const APP_ID = 0x44535250
function fail(): never { throw new Error('replay journal: unsafe file, incompatible journal or conflicting operation') }
function identity(operationId: string, bindingDigest: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(operationId) || !/^[a-f0-9]{64}$/u.test(bindingDigest)) fail()
}
function checkFile(path: string): void {
  const stat = lstatSync(path)
  if (realpathSync(path) !== path || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) fail()
}
function optionalFile(path: string): void {
  try { checkFile(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
interface Row { binding_digest: string; request_digest: string; case_digest: string; result_json: string | null; result_digest: string | null; admission_mode: 'fixed' | 'signed' }
interface GrantRow { scope_digest: string; grant_digest: string; operation_id: string }
export interface ReplayAuthorization { scopeDigest: string; grantDigest: string }

function authorization(value: unknown): ReplayAuthorization | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== 2) fail()
  const scope = descriptors.scopeDigest, grant = descriptors.grantDigest
  if (!scope || !grant || !('value' in scope) || !('value' in grant) || typeof scope.value !== 'string' || typeof grant.value !== 'string') fail()
  identity('authorization', scope.value); identity('authorization', grant.value)
  return { scopeDigest: scope.value, grantDigest: grant.value }
}

/** A reserved operation never regains dispatch authority, including after process death. */
export class ReplayJournal {
  private readonly db: DatabaseSync
  private readonly fileIdentity: { dev: number; ino: number }
  constructor(private readonly path: string) {
    if (process.platform !== 'linux' || !isAbsolute(path) || resolve(path) !== path) fail()
    privateRuntimeObserverDirectory(dirname(path))
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      try { fsyncSync(fd) } finally { closeSync(fd) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const before = lstatSync(path)
    this.fileIdentity = { dev: before.dev, ino: before.ino }
    this.checkFiles()
    this.db = new DatabaseSync(path)
    try {
      this.checkFiles()
      const after = lstatSync(path)
      if (before.dev !== after.dev || before.ino !== after.ino) fail()
      this.db.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;')
      try {
        const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
        const app = (this.db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
        if (version === 0 && app === 0 && this.db.prepare('SELECT name FROM sqlite_master').all().length === 0) {
          this.db.exec(`CREATE TABLE replay_operations (
            operation_id TEXT PRIMARY KEY, binding_digest TEXT NOT NULL, request_digest TEXT NOT NULL, case_digest TEXT NOT NULL,
            result_json TEXT, result_digest TEXT, admission_mode TEXT NOT NULL,
            CHECK((result_json IS NULL AND result_digest IS NULL) OR
              (json_valid(result_json) AND length(result_digest) = 64))
          ) STRICT, WITHOUT ROWID;
          CREATE TABLE replay_grants (
            scope_digest TEXT PRIMARY KEY, grant_digest TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
            FOREIGN KEY(operation_id) REFERENCES replay_operations(operation_id)
          ) STRICT, WITHOUT ROWID;
          PRAGMA application_id = ${APP_ID}; PRAGMA user_version = 2;`)
        } else if (version === 1 && app === APP_ID) {
          // Version 1 had only fixed-operation admission. Existing rows remain fixed.
          this.db.exec(`ALTER TABLE replay_operations ADD COLUMN admission_mode TEXT NOT NULL DEFAULT 'fixed';
            CREATE TABLE replay_grants (
              scope_digest TEXT PRIMARY KEY, grant_digest TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
              FOREIGN KEY(operation_id) REFERENCES replay_operations(operation_id)
            ) STRICT, WITHOUT ROWID;
            PRAGMA user_version = 2;`)
        } else if (version !== 2 || app !== APP_ID) fail()
        this.db.exec('COMMIT; PRAGMA journal_mode = WAL;')
      } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* A completed commit cannot be rolled back. */ } throw error }
      this.checkFiles()
      this.syncDirectory()
    } catch (error) { this.db.close(); throw error }
  }
  private checkFiles(): void {
    privateRuntimeObserverDirectory(dirname(this.path))
    checkFile(this.path)
    const current = lstatSync(this.path)
    if (current.dev !== this.fileIdentity.dev || current.ino !== this.fileIdentity.ino) fail()
    for (const suffix of ['-wal', '-shm', '-journal']) optionalFile(this.path + suffix)
  }
  private syncDirectory(): void {
    this.checkFiles()
    const fd = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { if (!fstatSync(fd).isDirectory()) fail(); fsyncSync(fd) } finally { closeSync(fd) }
  }
  private operation(operationId: string): Row | undefined {
    return this.db.prepare('SELECT binding_digest, request_digest, case_digest, result_json, result_digest, admission_mode FROM replay_operations WHERE operation_id = ?').get(operationId) as Row | undefined
  }
  private grantForOperation(operationId: string): GrantRow | undefined {
    return this.db.prepare('SELECT scope_digest, grant_digest, operation_id FROM replay_grants WHERE operation_id = ?').get(operationId) as GrantRow | undefined
  }
  private result(operationId: string, row: Row): { status: 'admitted' | 'completed'; result: EffectBlockedReplayResult | null } {
    if (row.result_json === null) { if (row.result_digest !== null) fail(); return { status: 'admitted', result: null } }
    if (Buffer.byteLength(row.result_json) > 65_536) fail()
    const result = JSON.parse(row.result_json) as EffectBlockedReplayResult
    assertReplayEndpointResponse({ schemaVersion: 1, challenge: '0'.repeat(64), operationId,
      requestDigest: row.request_digest, status: 'completed', result, observedAt: Date.now() })
    if (runtimeConfigDigest(result) !== row.result_digest || result.operationId !== operationId
      || result.requestDigest !== row.request_digest || result.caseDigest !== row.case_digest
      || result.schemaVersion !== 1 || result.kind !== 'dsh-effect-blocked-replay-observation' || result.quiescent !== true) fail()
    return { status: 'completed', result }
  }
  get(operationId: string, bindingDigest: string, signed?: ReplayAuthorization): { status: 'admitted' | 'completed'; result: EffectBlockedReplayResult | null } | undefined {
    const auth = authorization(signed)
    identity(operationId, bindingDigest); this.checkFiles()
    if (auth) {
      const grant = this.db.prepare('SELECT scope_digest, grant_digest, operation_id FROM replay_grants WHERE scope_digest = ?').get(auth.scopeDigest) as GrantRow | undefined
      if (!grant) { if (this.operation(operationId)) fail(); return }
      if (grant.grant_digest !== auth.grantDigest || grant.operation_id !== operationId) fail()
      const row = this.operation(operationId)
      if (!row || row.admission_mode !== 'signed' || row.binding_digest !== bindingDigest) fail()
      return this.result(operationId, row)
    }
    const row = this.operation(operationId)
    if (!row) return
    if (row.admission_mode !== 'fixed' || this.grantForOperation(operationId) || row.binding_digest !== bindingDigest) fail()
    return this.result(operationId, row)
  }
  reserve(operationId: string, bindingDigest: string, requestDigest: string, caseDigest: string, signed?: ReplayAuthorization): boolean {
    const auth = authorization(signed)
    identity(operationId, bindingDigest); this.checkFiles()
    identity(operationId, requestDigest); identity(operationId, caseDigest)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (auth) {
        const grant = this.db.prepare('SELECT scope_digest, grant_digest, operation_id FROM replay_grants WHERE scope_digest = ?').get(auth.scopeDigest) as GrantRow | undefined
        if (grant) {
          if (grant.grant_digest !== auth.grantDigest || grant.operation_id !== operationId) fail()
          const existing = this.operation(operationId)
          if (!existing || existing.admission_mode !== 'signed' || existing.binding_digest !== bindingDigest
            || existing.request_digest !== requestDigest || existing.case_digest !== caseDigest) fail()
          this.db.exec('COMMIT'); this.syncDirectory(); return false
        }
        if (this.operation(operationId)) fail()
        this.db.prepare("INSERT INTO replay_operations(operation_id, binding_digest, request_digest, case_digest, admission_mode) VALUES (?, ?, ?, ?, 'signed')")
          .run(operationId, bindingDigest, requestDigest, caseDigest)
        this.db.prepare('INSERT INTO replay_grants(scope_digest, grant_digest, operation_id) VALUES (?, ?, ?)').run(auth.scopeDigest, auth.grantDigest, operationId)
      } else {
        const existing = this.operation(operationId)
        if (existing) {
          if (existing.admission_mode !== 'fixed' || this.grantForOperation(operationId) || existing.binding_digest !== bindingDigest
            || existing.request_digest !== requestDigest || existing.case_digest !== caseDigest) fail()
          this.db.exec('COMMIT'); this.syncDirectory(); return false
        }
        this.db.prepare("INSERT INTO replay_operations(operation_id, binding_digest, request_digest, case_digest, admission_mode) VALUES (?, ?, ?, ?, 'fixed')")
          .run(operationId, bindingDigest, requestDigest, caseDigest)
      }
      this.db.exec('COMMIT')
      this.syncDirectory()
      return true
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* A completed commit cannot be rolled back. */ } throw error }
  }
  complete(operationId: string, bindingDigest: string, result: EffectBlockedReplayResult): void {
    identity(operationId, bindingDigest)
    runtimeConfigDigest(result)
    result = structuredClone(result)
    const digest = runtimeConfigDigest(result)
    if (result.operationId !== operationId || result.kind !== 'dsh-effect-blocked-replay-observation' || result.quiescent !== true) fail()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const pins = this.operation(operationId)
      if (!pins || (pins.admission_mode !== 'fixed' && pins.admission_mode !== 'signed') || pins.binding_digest !== bindingDigest
        || (pins.admission_mode === 'signed' && !this.grantForOperation(operationId))
        || (pins.admission_mode === 'fixed' && this.grantForOperation(operationId))
        || result.requestDigest !== pins.request_digest || result.caseDigest !== pins.case_digest) fail()
      assertReplayEndpointResponse({ schemaVersion: 1, challenge: '0'.repeat(64), operationId,
        requestDigest: pins.request_digest, status: 'completed', result, observedAt: Date.now() })
      const prior = this.result(operationId, pins)
      if (prior.result && runtimeConfigDigest(prior.result) !== digest) fail()
      if (!prior.result) this.db.prepare('UPDATE replay_operations SET result_json = ?, result_digest = ? WHERE operation_id = ? AND result_json IS NULL')
        .run(JSON.stringify(result), digest, operationId)
      this.db.exec('COMMIT')
      this.syncDirectory()
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* A completed commit cannot be rolled back. */ } throw error }
  }
  close(): void { this.db.close() }
}
