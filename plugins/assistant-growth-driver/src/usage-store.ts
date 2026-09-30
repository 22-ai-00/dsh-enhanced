import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { sourceGrowthEvidenceDigest, validateSourceGrowthRunBinding, type SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'

export type UsageModel = Readonly<{ provider: string; model: string; reasoningEffort?: string }>
export interface UsageIntent {
  configDigest: string
  source: OwnerForegroundLearningTask
  model: UsageModel
  /** Old rows omit these fields and cannot authorize task-bound creation. */
  modelOrigin?: SourceGrowthRunBinding['modelOrigin']
  budget?: SourceGrowthRunBinding['budget']
  createdAt: number
  expiresAt: number
}
export interface UsageJob {
  id: string
  intent: UsageIntent
  digest: string
  state: 'queued' | 'running' | 'reviewed' | 'failed' | 'unknown' | 'superseded'
  definitionHash: string | null
  occurrenceId: string | null
  reason: string | null
  sourceRun: SourceGrowthRunBinding | null
}
type Row = { id: string; intent_json: string; digest: string; state: UsageJob['state']; definition_hash: string | null; occurrence_id: string | null; reason: string | null; source_run_json: string | null }
const read = (row: Row): UsageJob => {
  const intent = JSON.parse(row.intent_json) as UsageIntent
  if (acceptanceDigest(intent) !== row.digest) throw new Error('usage intent digest mismatch')
  return { id: row.id, intent, digest: row.digest, state: row.state, definitionHash: row.definition_hash,
    occurrenceId: row.occurrence_id, reason: row.reason,
    sourceRun: row.source_run_json === null ? null : JSON.parse(row.source_run_json) as SourceGrowthRunBinding }
}

/** Intent/index only. Evaluation remains the sole task-result ledger. */
export class UsageStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('usage database path must be absolute')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const parent = lstatSync(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) throw new Error('unsafe usage database directory')
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error('unsafe usage database file')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; BEGIN IMMEDIATE;')
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version > 2) throw new Error('usage database schema is newer than this plugin')
      this.db.exec(`CREATE TABLE IF NOT EXISTS usage_jobs(id TEXT PRIMARY KEY, lane TEXT NOT NULL, subject TEXT NOT NULL,
          intent_json TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','reviewed','failed','unknown','superseded')),
          definition_hash TEXT, occurrence_id TEXT, reason TEXT, source_run_json TEXT) STRICT;
        CREATE INDEX IF NOT EXISTS usage_jobs_lane_state ON usage_jobs(lane,state);
        CREATE TABLE IF NOT EXISTS usage_cursors(lane TEXT PRIMARY KEY, scope_key TEXT NOT NULL, watermark INTEGER NOT NULL) STRICT;`)
      if (!(this.db.prepare('PRAGMA table_info(usage_jobs)').all() as { name: string }[]).some(column => column.name === 'source_run_json')) {
        this.db.exec('ALTER TABLE usage_jobs ADD COLUMN source_run_json TEXT')
      }
      this.db.exec('PRAGMA user_version=2; COMMIT;')
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* no transaction remained */ } this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  cursor(lane: string): { scopeKey: string; watermark: number } | undefined {
    const row = this.db.prepare('SELECT scope_key,watermark FROM usage_cursors WHERE lane=?').get(lane) as { scope_key: string; watermark: number } | undefined
    return row === undefined ? undefined : { scopeKey: row.scope_key, watermark: row.watermark }
  }
  get(id: string): UsageJob | undefined {
    const row = this.db.prepare('SELECT * FROM usage_jobs WHERE id=?').get(id) as Row | undefined
    return row === undefined ? undefined : read(row)
  }
  pending(lane: string): UsageJob[] {
    return (this.db.prepare("SELECT * FROM usage_jobs WHERE lane=? AND state IN ('queued','running') ORDER BY rowid").all(lane) as Row[]).map(read)
  }
  counts(lane: string): Readonly<Record<string, number>> {
    return Object.fromEntries((this.db.prepare('SELECT state,COUNT(*) AS count FROM usage_jobs WHERE lane=? GROUP BY state').all(lane) as { state: string; count: number }[]).map(row => [row.state, row.count]))
  }
  /** Called only while the caller holds Evaluation's current canonical writer fence. */
  consume(input: { lane: string; scopeKey: string; watermark: number; subject: string; intent?: UsageIntent; maxPending: number }): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.cursor(input.lane)
      if (prior && (prior.scopeKey !== input.scopeKey || prior.watermark >= input.watermark)) { this.db.exec('COMMIT'); return true }
      const id = input.intent === undefined ? undefined : `usage-${acceptanceDigest([input.lane, input.subject, input.intent.source.canonical.projection])}`
      if (id && !this.get(id) && this.pending(input.lane).filter(job => job.state === 'queued' || job.state === 'running').length >= input.maxPending) {
        this.db.exec('COMMIT'); return false
      }
      // A newer canonical result invalidates pending work, including retractions.
      // Running work is checked at every model/tool boundary by the consumer.
      this.db.prepare("UPDATE usage_jobs SET state='superseded',reason='canonical-source-changed' WHERE lane=? AND subject=? AND state='queued' AND id<>?")
        .run(input.lane, input.subject, id ?? '')
      if (id && input.intent) this.db.prepare("INSERT INTO usage_jobs(id,lane,subject,intent_json,digest,state) VALUES (?,?,?,?,?,'queued') ON CONFLICT(id) DO NOTHING")
        .run(id, input.lane, input.subject, JSON.stringify(input.intent), acceptanceDigest(input.intent))
      this.db.prepare('INSERT INTO usage_cursors(lane,scope_key,watermark) VALUES (?,?,?) ON CONFLICT(lane) DO UPDATE SET scope_key=excluded.scope_key,watermark=excluded.watermark')
        .run(input.lane, input.scopeKey, input.watermark)
      this.db.exec('COMMIT'); return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  interrupt(lane: string): void {
    this.db.prepare("UPDATE usage_jobs SET state='unknown',reason='interrupted-after-dispatch' WHERE lane=? AND state='running'").run(lane)
  }
  bind(id: string, definitionHash: string): UsageJob {
    this.db.prepare("UPDATE usage_jobs SET definition_hash=? WHERE id=? AND state='queued' AND definition_hash IS NULL").run(definitionHash, id)
    const job = this.get(id)
    if (!job || job.definitionHash !== definitionHash) throw new Error('usage definition binding changed')
    return job
  }
  claim(id: string, definitionHash: string, occurrenceId: string): UsageJob {
    if (this.db.prepare("UPDATE usage_jobs SET state='running',occurrence_id=? WHERE id=? AND state='queued' AND definition_hash=?").run(occurrenceId, id, definitionHash).changes !== 1) throw new Error('usage job already claimed')
    return this.get(id)!
  }
  bindSourceRun(id: string, digest: string, definitionHash: string, occurrenceId: string, binding: SourceGrowthRunBinding): SourceGrowthRunBinding {
    validateSourceGrowthRunBinding(binding)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const job = this.get(id)
      if (!job || job.digest !== digest || job.state !== 'running' || job.definitionHash !== definitionHash
        || job.occurrenceId !== occurrenceId) throw new Error('usage source run no longer owns the claimed occurrence')
      const projection = job.intent.source.canonical.projection
      if (!job.intent.modelOrigin || !job.intent.budget || binding.runId !== id || binding.intentDigest !== digest
        || binding.configDigest !== job.intent.configDigest || binding.native.automationId !== id
        || binding.native.definitionHash !== definitionHash || binding.native.occurrenceId !== occurrenceId
        || binding.source.outcomeId !== job.intent.source.canonical.triggerOutcomeId
        || acceptanceDigest(binding.source.projection) !== acceptanceDigest(projection)
        || binding.ownerDigest !== sourceGrowthEvidenceDigest(job.intent.source.owner)
        || binding.source.sourceDigest !== sourceGrowthEvidenceDigest({ protocol: job.intent.source.protocol,
          source: job.intent.source.source, judgement: job.intent.source.judgement,
          ownerRevision: job.intent.source.ownerRevision })
        || acceptanceDigest(binding.model) !== acceptanceDigest(job.intent.model)
        || binding.modelOrigin !== job.intent.modelOrigin
        || acceptanceDigest(binding.budget) !== acceptanceDigest(job.intent.budget)) {
        throw new Error('usage source run does not match the frozen intent')
      }
      if (job.sourceRun !== null) {
        if (acceptanceDigest(job.sourceRun) !== acceptanceDigest(binding)) throw new Error('usage source run binding conflict')
        this.db.exec('COMMIT')
        return structuredClone(job.sourceRun)
      }
      if (this.db.prepare("UPDATE usage_jobs SET source_run_json=? WHERE id=? AND digest=? AND state='running' AND definition_hash=? AND occurrence_id=? AND source_run_json IS NULL")
        .run(JSON.stringify(binding), id, digest, definitionHash, occurrenceId).changes !== 1) throw new Error('usage source run bind lost its claim')
      this.db.exec('COMMIT')
      return structuredClone(binding)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  settle(id: string, state: 'reviewed' | 'failed' | 'unknown' | 'superseded', reason: string, occurrenceId?: string): void {
    if (occurrenceId === undefined) this.db.prepare("UPDATE usage_jobs SET state=?,reason=? WHERE id=? AND state='queued'").run(state, reason, id)
    else this.db.prepare("UPDATE usage_jobs SET state=?,reason=? WHERE id=? AND state='running' AND occurrence_id=?").run(state, reason, id, occurrenceId)
  }
}
