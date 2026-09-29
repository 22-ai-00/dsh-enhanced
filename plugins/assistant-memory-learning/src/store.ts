import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalGrowthJson, growthObjectDigest, validateMemoryLearningOwner,
  validateMemoryLearningReviewRequest,
} from '@dsh-enhanced/assistant-growth-contract'
import type { MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import type { LearningCursor, LearningIntent, LearningJob, LearningSnapshot, LearningState } from './types.js'

type Feed = 'delivery' | 'evaluation'
type Grant = Readonly<{ authorityId: string; configDigest: string; maxExtractions: number }>
type JobRow = { id: string; lane: string; subject: string; intent_json: string; digest: string; state: LearningState;
  snapshot_json: string | null; definition_hash: string | null; occurrence_id: string | null;
  request_json: string | null; result_digest: string | null; reason: string | null }
type CursorRow = { cursor_json: string; sequence: number }
const DIGEST = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const ACTIVE: readonly LearningState[] = ['pending', 'queued', 'running', 'unknown']
const TERMINAL: readonly LearningState[] = ['adopted', 'rejected', 'noop', 'failed', 'superseded']

export class LearningStoreError extends Error {
  constructor(readonly code: 'invalid-input' | 'conflict' | 'corrupt' | 'closed', message: string) {
    super(message); this.name = 'LearningStoreError'
  }
}
function fail(code: LearningStoreError['code'], message: string): never { throw new LearningStoreError(code, message) }
function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) fail('invalid-input', `${label} is invalid`)
}
function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('invalid-input', `${label} is invalid`)
}
function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('invalid-input', `${label} is invalid`)
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid-input', 'object is invalid')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !field.enumerable || !('value' in field))) fail('invalid-input', 'object fields are invalid')
  return value as Record<string, unknown>
}
function normalizedText(value: unknown, label: string, bytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC').trim()
    || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value) > bytes) fail('invalid-input', `${label} is invalid`)
}
function sourceText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || value.includes('\0')
    || Buffer.byteLength(value) > 65_536) fail('invalid-input', `${label} is invalid`)
}
function canonical(value: unknown): string { return canonicalGrowthJson(value) }
function parse(value: string, label: string): unknown {
  try { return JSON.parse(value) } catch { return fail('corrupt', `${label} is invalid JSON`) }
}
function safeIntent(input: LearningIntent, grant: Grant): LearningIntent {
  const raw = fields(input, ['configDigest', 'owner', 'kind', 'subject', 'inboxId', 'createdAt', 'expiresAt'],
    ['expectedSourceDigest', 'canonical'])
  digest(raw.configDigest, 'configDigest')
  if (raw.configDigest !== grant.configDigest) fail('conflict', 'intent config digest differs from grant')
  try { validateMemoryLearningOwner(raw.owner) } catch { return fail('invalid-input', 'owner is invalid') }
  // Extraction authority and Delivery owner route are independently configured.
  // The immutable config digest fixes the complete owner, not equality of ids.
  if (raw.kind !== 'fact' && raw.kind !== 'experience') fail('invalid-input', 'kind is invalid')
  identifier(raw.subject, 'subject'); identifier(raw.inboxId, 'inboxId')
  integer(raw.createdAt, 'createdAt'); integer(raw.expiresAt, 'expiresAt', 1)
  if (raw.expiresAt <= raw.createdAt) fail('invalid-input', 'intent is already expired')
  if (Object.hasOwn(raw, 'expectedSourceDigest')) digest(raw.expectedSourceDigest, 'expectedSourceDigest')
  if (Object.hasOwn(raw, 'canonical')) {
    const item = fields(raw.canonical, ['outcomeId', 'version', 'digest', 'objectiveStatus'])
    identifier(item.outcomeId, 'outcomeId'); integer(item.version, 'canonical version', 1); digest(item.digest, 'canonical digest')
    if (item.objectiveStatus !== 'achieved' && item.objectiveStatus !== 'not-achieved') fail('invalid-input', 'objective status is invalid')
  }
  if (raw.kind === 'experience' && raw.canonical === undefined) fail('invalid-input', 'experience needs canonical outcome')
  return JSON.parse(canonical(input)) as LearningIntent
}
function safeCursor(feed: Feed, value: LearningCursor, sequence: number): LearningCursor {
  integer(sequence, 'sequence')
  if (feed === 'delivery') {
    const raw = fields(value, ['protocol', 'epoch', 'scopeKey', 'sequence'])
    if (raw.protocol !== 'assistant-delivery/owner-foreground-source-cursor/v1') fail('invalid-input', 'delivery cursor protocol is invalid')
    identifier(raw.epoch, 'epoch'); normalizedText(raw.scopeKey, 'scopeKey', 512); integer(raw.sequence, 'cursor sequence')
    if (raw.sequence < sequence) fail('invalid-input', 'delivery cursor precedes item')
  } else {
    const raw = fields(value, ['scopeKey', 'watermark'])
    normalizedText(raw.scopeKey, 'scopeKey', 512); integer(raw.watermark, 'watermark')
    if (raw.watermark < sequence) fail('invalid-input', 'evaluation cursor precedes item')
  }
  return JSON.parse(canonical(value)) as LearningCursor
}
function safeSnapshot(input: LearningSnapshot, intent: LearningIntent): LearningSnapshot {
  const raw = fields(input, ['model', 'source', 'ownerStatement', 'assistantReply', 'targets'], ['ownerFeedback'])
  const model = fields(raw.model, ['provider', 'model'], ['reasoningEffort'])
  for (const key of Object.keys(model)) normalizedText(model[key], `model ${key}`, 256)
  const source = fields(raw.source, ['inboxId', 'sourceDigest', 'contentDigest'], ['canonical'])
  identifier(source.inboxId, 'source inboxId'); digest(source.sourceDigest, 'sourceDigest'); digest(source.contentDigest, 'contentDigest')
  if (source.inboxId !== intent.inboxId || (intent.expectedSourceDigest !== undefined && source.sourceDigest !== intent.expectedSourceDigest))
    fail('conflict', 'snapshot source differs from intent')
  if (Object.hasOwn(source, 'canonical')) {
    const outcome = fields(source.canonical, ['outcomeId', 'version', 'digest', 'objectiveStatus'])
    identifier(outcome.outcomeId, 'outcomeId'); integer(outcome.version, 'version', 1); digest(outcome.digest, 'digest')
    if (outcome.objectiveStatus !== 'achieved' && outcome.objectiveStatus !== 'not-achieved') fail('invalid-input', 'objective status is invalid')
  }
  if (canonical(source.canonical ?? null) !== canonical(intent.canonical ?? null)) fail('conflict', 'snapshot canonical revision differs from intent')
  sourceText(raw.ownerStatement, 'ownerStatement'); sourceText(raw.assistantReply, 'assistantReply')
  if (Object.hasOwn(raw, 'ownerFeedback')) sourceText(raw.ownerFeedback, 'ownerFeedback')
  if (!Array.isArray(raw.targets) || raw.targets.length > 100) fail('invalid-input', 'targets are invalid')
  for (const target of raw.targets) {
    const item = fields(target, ['id', 'version', 'kind', 'content'], ['knowledge'])
    identifier(item.id, 'target id'); integer(item.version, 'target version', 1)
    if (item.kind !== 'fact' && item.kind !== 'experience') fail('invalid-input', 'target kind is invalid')
    normalizedText(item.content, 'target content', 4096)
    if (Object.hasOwn(item, 'knowledge')) canonical(item.knowledge)
  }
  return JSON.parse(canonical(input)) as LearningSnapshot
}
function privateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) fail('corrupt', 'database file is not private')
}
function privatePaths(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) fail('invalid-input', 'database path is not canonical absolute')
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const dir = lstatSync(parent)
  if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(parent) !== parent || (dir.mode & 0o077) !== 0
    || (process.getuid?.() !== undefined && dir.uid !== process.getuid?.())) fail('corrupt', 'database parent is not private')
  try { lstatSync(path) } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600))
    chmodSync(path, 0o600)
  }
  privateFile(path)
  for (const suffix of ['-wal', '-shm']) {
    try { privateFile(`${path}${suffix}`) } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
}

export class LearningStore {
  readonly #db: DatabaseSync
  readonly #grant: Grant
  #closed = false

  constructor(path: string, grant: Grant) {
    const raw = fields(grant, ['authorityId', 'configDigest', 'maxExtractions'])
    identifier(raw.authorityId, 'authorityId'); digest(raw.configDigest, 'configDigest')
    integer(raw.maxExtractions, 'maxExtractions', 1)
    this.#grant = { authorityId: raw.authorityId, configDigest: raw.configDigest, maxExtractions: raw.maxExtractions }
    if (path !== ':memory:') privatePaths(path)
    this.#db = new DatabaseSync(path)
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
      if (path !== ':memory:') {
        const mode = this.#db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }
        if (mode.journal_mode.toLowerCase() !== 'wal') fail('corrupt', 'WAL mode unavailable')
        privatePaths(path)
      }
      const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version === 0) {
        if (this.#db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) fail('corrupt', 'unversioned database contains objects')
        this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE grant_record (authority_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, max_extractions INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0) STRICT;
          CREATE TABLE cursors (lane TEXT NOT NULL, feed TEXT NOT NULL, cursor_json TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(lane,feed)) STRICT, WITHOUT ROWID;
          CREATE TABLE jobs (id TEXT PRIMARY KEY, lane TEXT NOT NULL, subject TEXT NOT NULL, intent_json TEXT NOT NULL, digest TEXT NOT NULL,
            state TEXT NOT NULL, snapshot_json TEXT, definition_hash TEXT, occurrence_id TEXT, request_json TEXT, result_digest TEXT, reason TEXT) STRICT;
          CREATE INDEX jobs_lane_state ON jobs(lane,state);
        `)
        this.#db.prepare('INSERT INTO grant_record(authority_id,config_digest,max_extractions,consumed) VALUES(?,?,?,0)')
          .run(this.#grant.authorityId, this.#grant.configDigest, this.#grant.maxExtractions)
        this.#db.exec('PRAGMA user_version=1; COMMIT;')
      } else if (version !== 1) fail('corrupt', 'unsupported schema version')
      this.#checkGrant()
      const integrity = this.#db.prepare('PRAGMA quick_check').get() as { quick_check: string }
      if (integrity.quick_check !== 'ok') fail('corrupt', 'database integrity check failed')
    } catch (error) { this.#db.close(); throw error }
  }

  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close() } }
  #checkGrant(): number {
    if (this.#closed) fail('closed', 'store is closed')
    const row = this.#db.prepare('SELECT authority_id,config_digest,max_extractions,consumed FROM grant_record').all() as
      { authority_id: string; config_digest: string; max_extractions: number; consumed: number }[]
    if (row.length !== 1 || row[0]!.authority_id !== this.#grant.authorityId
      || row[0]!.config_digest !== this.#grant.configDigest || row[0]!.max_extractions !== this.#grant.maxExtractions)
      fail('conflict', 'immutable grant differs')
    integer(row[0]!.consumed, 'consumed')
    if (row[0]!.consumed > this.#grant.maxExtractions) fail('corrupt', 'extraction quota is corrupt')
    return row[0]!.consumed
  }
  #transaction<T>(action: () => T): T {
    this.#checkGrant(); this.#db.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.#db.exec('COMMIT'); return result }
    catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  #job(row: JobRow): LearningJob {
    identifier(row.lane, 'stored lane')
    const intent = safeIntent(parse(row.intent_json, 'intent') as LearningIntent, this.#grant)
    const expectedId = this.#id(intent)
    if (row.id !== expectedId || row.subject !== intent.subject || ![...ACTIVE, ...TERMINAL].includes(row.state)) fail('corrupt', 'stored job identity is invalid')
    const snapshot = row.snapshot_json === null ? null : safeSnapshot(parse(row.snapshot_json, 'snapshot') as LearningSnapshot, intent)
    const expectedDigest = growthObjectDigest(snapshot === null ? intent : { intent, snapshot })
    if (row.digest !== expectedDigest) fail('corrupt', 'stored job digest differs')
    if ((row.state === 'pending' && snapshot !== null)
      || (['queued', 'running', 'unknown'].includes(row.state) && snapshot === null)
      || (row.definition_hash !== null && !DIGEST.test(row.definition_hash))
      || (row.occurrence_id !== null && !ID.test(row.occurrence_id)) || (row.result_digest !== null && !DIGEST.test(row.result_digest)))
      fail('corrupt', 'stored job state is inconsistent')
    if (row.definition_hash !== null && snapshot === null) fail('corrupt', 'unfrozen job has definition')
    if ((row.state === 'running' || row.state === 'unknown') && (row.definition_hash === null || row.occurrence_id === null))
      fail('corrupt', 'claimed job lacks immutable binding')
    if (row.state === 'queued' && (row.occurrence_id !== null || row.request_json !== null || row.reason !== null))
      fail('corrupt', 'queued job has claim or settlement')
    if (row.state === 'pending' && (row.definition_hash !== null || row.occurrence_id !== null
      || row.request_json !== null || row.reason !== null)) fail('corrupt', 'pending job has claim or settlement')
    if (TERMINAL.includes(row.state) && (row.reason === null || (!['superseded', 'failed'].includes(row.state)
      && (snapshot === null || row.definition_hash === null || row.occurrence_id === null))))
      fail('corrupt', 'terminal job lacks evidence or reason')
    if (row.reason !== null) normalizedText(row.reason, 'reason', 512)
    if (row.request_json !== null && row.occurrence_id === null) fail('corrupt', 'request lacks claim')
    let request: MemoryLearningReviewRequest | null = null
    if (row.request_json !== null) {
      try { request = validateMemoryLearningReviewRequest(parse(row.request_json, 'request')) } catch { return fail('corrupt', 'stored request is invalid') }
      if (canonical(request.owner) !== canonical(intent.owner) || canonical(request.source) !== canonical(snapshot!.source)
        || request.operationId !== row.id)
        fail('corrupt', 'stored request binding differs')
    }
    return { id: row.id, intent, digest: row.digest, state: row.state, snapshot, definitionHash: row.definition_hash,
      occurrenceId: row.occurrence_id, request, resultDigest: row.result_digest, reason: row.reason }
  }
  #id(intent: LearningIntent): string {
    return `memory-learning:${growthObjectDigest({ authorityId: this.#grant.authorityId, kind: intent.kind,
      subject: intent.subject, revision: intent.canonical ?? intent.expectedSourceDigest ?? intent.inboxId })}`
  }
  #read(id: string): (LearningJob & { lane: string }) | undefined {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined
    return row === undefined ? undefined : { ...this.#job(row), lane: row.lane }
  }
  cursor(lane: string, feed: Feed): LearningCursor | undefined {
    this.#checkGrant(); identifier(lane, 'lane')
    if (feed !== 'delivery' && feed !== 'evaluation') fail('invalid-input', 'feed is invalid')
    const row = this.#db.prepare('SELECT cursor_json,sequence FROM cursors WHERE lane=? AND feed=?').get(lane, feed) as CursorRow | undefined
    if (!row) return undefined
    try { return safeCursor(feed, parse(row.cursor_json, 'cursor') as LearningCursor, row.sequence) }
    catch { return fail('corrupt', 'stored cursor is invalid') }
  }
  stage(input: { lane: string; feed: Feed; cursor: LearningCursor; sequence: number; subject: string;
    intent?: LearningIntent; maxPending: number; supersede?: boolean }): boolean {
    identifier(input.lane, 'lane'); identifier(input.subject, 'subject')
    if (input.feed !== 'delivery' && input.feed !== 'evaluation') fail('invalid-input', 'feed is invalid')
    const cursor = safeCursor(input.feed, input.cursor, input.sequence)
    integer(input.maxPending, 'maxPending', 1)
    if (input.maxPending > 1000) fail('invalid-input', 'maxPending exceeds bound')
    const intent = input.intent === undefined ? undefined : safeIntent(input.intent, this.#grant)
    if (intent && intent.subject !== input.subject) fail('conflict', 'stage subject differs from intent')
    if (input.supersede !== undefined && typeof input.supersede !== 'boolean') fail('invalid-input', 'supersede is invalid')
    return this.#transaction(() => {
      const previous = this.cursor(input.lane, input.feed)
      const previousRow = this.#db.prepare('SELECT cursor_json,sequence FROM cursors WHERE lane=? AND feed=?').get(input.lane, input.feed) as CursorRow | undefined
      if (previous) {
        if (previous.scopeKey !== cursor.scopeKey || ('epoch' in previous && 'epoch' in cursor && previous.epoch !== cursor.epoch))
          fail('conflict', 'cursor scope or epoch changed')
        if (input.sequence <= previousRow!.sequence) {
          if (input.sequence === previousRow!.sequence && canonical(cursor) !== previousRow!.cursor_json) fail('conflict', 'cursor replay differs')
          return true
        }
      }
      const proposedId = intent === undefined ? undefined : this.#id(intent)
      const active = this.#db.prepare("SELECT id, state FROM jobs WHERE lane=? AND state IN ('pending','queued','running','unknown')").all(input.lane) as { id: string; state: LearningState }[]
      const superseded = input.supersede
        ? active.filter(item => {
          const previousJob = this.#read(item.id)!
          return previousJob.id !== proposedId && previousJob.intent.kind === 'experience' && previousJob.intent.subject === input.subject
        }) : []
      if (intent) {
        const id = this.#id(intent)
        const existing = this.#read(id)
        if (existing && (existing.lane !== input.lane || canonical(existing.intent.owner) !== canonical(intent.owner)
          || existing.intent.configDigest !== intent.configDigest || existing.intent.inboxId !== intent.inboxId
          || existing.intent.kind !== intent.kind || canonical(existing.intent.canonical ?? null) !== canonical(intent.canonical ?? null)
          || existing.intent.expectedSourceDigest !== intent.expectedSourceDigest)) fail('conflict', 'job identity collision')
        if (!existing) {
          if (active.length - superseded.length >= input.maxPending) return false
          this.#db.prepare(`INSERT INTO jobs(id,lane,subject,intent_json,digest,state,snapshot_json,definition_hash,occurrence_id,request_json,result_digest,reason)
            VALUES(?,?,?,?,?,'pending',NULL,NULL,NULL,NULL,NULL,NULL)`)
            .run(id, input.lane, intent.subject, canonical(intent), growthObjectDigest(intent))
        }
      }
      for (const old of superseded) this.#db.prepare("UPDATE jobs SET state='superseded',reason='new-canonical-revision' WHERE id=?").run(old.id)
      this.#db.prepare(`INSERT INTO cursors(lane,feed,cursor_json,sequence) VALUES(?,?,?,?)
        ON CONFLICT(lane,feed) DO UPDATE SET cursor_json=excluded.cursor_json,sequence=excluded.sequence`)
        .run(input.lane, input.feed, canonical(cursor), input.sequence)
      return true
    })
  }
  get(id: string): LearningJob | undefined { this.#checkGrant(); identifier(id, 'id'); const job = this.#read(id); if (!job) return undefined; const { lane: _lane, ...result } = job; return result }
  pending(lane: string): LearningJob[] {
    this.#checkGrant(); identifier(lane, 'lane')
    const rows = this.#db.prepare("SELECT * FROM jobs WHERE lane=? AND state IN ('pending','queued','running','unknown') ORDER BY rowid").all(lane) as JobRow[]
    if (rows.length > 1000) fail('corrupt', 'pending set is unbounded')
    return rows.map(row => this.#job(row))
  }
  counts(lane: string): Record<LearningState, number> {
    this.#checkGrant(); identifier(lane, 'lane')
    const counts: Record<LearningState, number> = { pending: 0, queued: 0, running: 0, unknown: 0,
      adopted: 0, rejected: 0, noop: 0, failed: 0, superseded: 0 }
    const rows = this.#db.prepare('SELECT * FROM jobs WHERE lane=? ORDER BY rowid').all(lane) as JobRow[]
    for (const row of rows) counts[this.#job(row).state]++
    return counts
  }
  freeze(id: string, snapshotInput: LearningSnapshot): LearningJob {
    identifier(id, 'id')
    return this.#transaction(() => {
      const job = this.#read(id); if (!job) fail('invalid-input', 'job not found')
      const snapshot = safeSnapshot(snapshotInput, job.intent)
      if (job.state !== 'pending') {
        if (job.snapshot !== null && canonical(job.snapshot) === canonical(snapshot)) return job
        fail('conflict', 'job snapshot is immutable')
      }
      const frozenDigest = growthObjectDigest({ intent: job.intent, snapshot })
      this.#db.prepare("UPDATE jobs SET snapshot_json=?,digest=?,state='queued' WHERE id=? AND state='pending'")
        .run(canonical(snapshot), frozenDigest, id)
      return this.#read(id)!
    })
  }
  bind(id: string, definitionHash: string): LearningJob {
    identifier(id, 'id'); digest(definitionHash, 'definitionHash')
    return this.#transaction(() => {
      const job = this.#read(id); if (!job || job.state !== 'queued') fail('conflict', 'job is not queued')
      if (job.definitionHash && job.definitionHash !== definitionHash) fail('conflict', 'definition is immutable')
      if (!job.definitionHash) this.#db.prepare('UPDATE jobs SET definition_hash=? WHERE id=?').run(definitionHash, id)
      return this.#read(id)!
    })
  }
  claim(id: string, definitionHash: string, occurrenceId: string): LearningJob {
    identifier(id, 'id'); digest(definitionHash, 'definitionHash'); identifier(occurrenceId, 'occurrenceId')
    return this.#transaction(() => {
      const job = this.#read(id)
      if (!job || job.state !== 'queued' || job.definitionHash !== definitionHash || job.occurrenceId !== null)
        fail('conflict', 'job is not claimable')
      const consumed = this.#checkGrant()
      if (consumed >= this.#grant.maxExtractions) fail('conflict', 'extraction quota exhausted')
      this.#db.prepare('UPDATE grant_record SET consumed=consumed+1 WHERE authority_id=?').run(this.#grant.authorityId)
      this.#db.prepare("UPDATE jobs SET state='running',occurrence_id=? WHERE id=? AND state='queued'").run(occurrenceId, id)
      return this.#read(id)!
    })
  }
  saveRequest(id: string, occurrenceId: string, requestInput: MemoryLearningReviewRequest): LearningJob {
    identifier(id, 'id'); identifier(occurrenceId, 'occurrenceId')
    let request: MemoryLearningReviewRequest
    try { request = validateMemoryLearningReviewRequest(requestInput) } catch { return fail('invalid-input', 'review request is invalid') }
    return this.#transaction(() => {
      const job = this.#read(id)
      if (!job || job.state !== 'running' || job.occurrenceId !== occurrenceId) fail('conflict', 'claim is not running')
      if (request.operationId !== id
        || canonical(request.owner) !== canonical(job.intent.owner) || canonical(request.source) !== canonical(job.snapshot!.source))
        fail('conflict', 'review request differs from frozen source or session')
      if (job.request !== null) {
        if (canonical(job.request) !== canonical(request)) fail('conflict', 'review request is immutable')
        return job
      }
      this.#db.prepare('UPDATE jobs SET request_json=? WHERE id=? AND state=\'running\' AND request_json IS NULL')
        .run(canonical(request), id)
      return this.#read(id)!
    })
  }
  settle(id: string, state: Extract<LearningState, 'adopted' | 'rejected' | 'noop' | 'failed' | 'unknown' | 'superseded'>,
    reason: string, resultDigest?: string, occurrenceId?: string): void {
    identifier(id, 'id'); normalizedText(reason, 'reason', 512)
    if (![...TERMINAL, 'unknown'].includes(state)) fail('invalid-input', 'settlement state is invalid')
    if (resultDigest !== undefined) digest(resultDigest, 'resultDigest')
    if (occurrenceId !== undefined) identifier(occurrenceId, 'occurrenceId')
    this.#transaction(() => {
      const job = this.#read(id); if (!job) fail('invalid-input', 'job not found')
      if (occurrenceId !== undefined && job.occurrenceId !== occurrenceId) fail('conflict', 'occurrence differs')
      if (TERMINAL.includes(job.state)) {
        if (job.state === state && job.reason === reason && job.resultDigest === (resultDigest ?? null)) return
        fail('conflict', 'terminal job is immutable')
      }
      if (state === 'unknown' && job.state !== 'running') fail('conflict', 'only running jobs become unknown')
      if (state !== 'superseded' && state !== 'failed' && state !== 'unknown' && job.state !== 'running' && job.state !== 'unknown')
        fail('conflict', 'job has not been claimed')
      this.#db.prepare('UPDATE jobs SET state=?,reason=?,result_digest=? WHERE id=?').run(state, reason, resultDigest ?? null, id)
    })
  }
  interrupt(lane: string): void {
    identifier(lane, 'lane')
    this.#transaction(() => { this.#db.prepare("UPDATE jobs SET state='unknown',reason='interrupted' WHERE lane=? AND state='running'").run(lane) })
  }
  availability(): { remainingExtractions: number; available: boolean } {
    const remainingExtractions = this.#grant.maxExtractions - this.#checkGrant()
    return { remainingExtractions, available: remainingExtractions > 0 }
  }
}
