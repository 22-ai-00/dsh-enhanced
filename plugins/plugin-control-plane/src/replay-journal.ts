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
interface Row { binding_digest: string; request_digest: string; case_digest: string; result_json: string | null; result_digest: string | null }

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
            result_json TEXT, result_digest TEXT,
            CHECK((result_json IS NULL AND result_digest IS NULL) OR
              (json_valid(result_json) AND length(result_digest) = 64))
          ) STRICT, WITHOUT ROWID;
          PRAGMA application_id = ${APP_ID}; PRAGMA user_version = 1;`)
        } else if (version !== 1 || app !== APP_ID) fail()
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
  get(operationId: string, bindingDigest: string): { status: 'admitted' | 'completed'; result: EffectBlockedReplayResult | null } | undefined {
    identity(operationId, bindingDigest); this.checkFiles()
    const row = this.db.prepare('SELECT binding_digest, request_digest, case_digest, result_json, result_digest FROM replay_operations WHERE operation_id = ?').get(operationId) as Row | undefined
    if (!row) return
    if (row.binding_digest !== bindingDigest) fail()
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
  reserve(operationId: string, bindingDigest: string, requestDigest: string, caseDigest: string): boolean {
    identity(operationId, bindingDigest); this.checkFiles()
    identity(operationId, requestDigest); identity(operationId, caseDigest)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.get(operationId, bindingDigest)
      const pins = this.db.prepare('SELECT request_digest, case_digest FROM replay_operations WHERE operation_id = ?').get(operationId) as Row | undefined
      if (pins && (pins.request_digest !== requestDigest || pins.case_digest !== caseDigest)) fail()
      if (!existing) this.db.prepare('INSERT INTO replay_operations(operation_id, binding_digest, request_digest, case_digest) VALUES (?, ?, ?, ?)').run(operationId, bindingDigest, requestDigest, caseDigest)
      this.db.exec('COMMIT')
      this.syncDirectory()
      return !existing
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
      const prior = this.get(operationId, bindingDigest)
      const pins = this.db.prepare('SELECT request_digest, case_digest FROM replay_operations WHERE operation_id = ?').get(operationId) as Row | undefined
      if (!pins || result.requestDigest !== pins.request_digest || result.caseDigest !== pins.case_digest) fail()
      assertReplayEndpointResponse({ schemaVersion: 1, challenge: '0'.repeat(64), operationId,
        requestDigest: pins.request_digest, status: 'completed', result, observedAt: Date.now() })
      if (!prior || (prior.result && runtimeConfigDigest(prior.result) !== digest)) fail()
      if (!prior.result) this.db.prepare('UPDATE replay_operations SET result_json = ?, result_digest = ? WHERE operation_id = ? AND result_json IS NULL')
        .run(JSON.stringify(result), digest, operationId)
      this.db.exec('COMMIT')
      this.syncDirectory()
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* A completed commit cannot be rolled back. */ } throw error }
  }
  close(): void { this.db.close() }
}
