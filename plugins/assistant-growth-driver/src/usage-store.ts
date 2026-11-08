import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { types as utilTypes } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { sourceGrowthEvidenceDigest, validateSourceGrowthRunBinding, validateAnySourceGrowthRunBinding, anySourceGrowthRunDigest, type AnySourceGrowthRunBinding, type WorkItemSourceGrowthRunBinding, type WorkItemRevisionSourceGrowthRunBinding, type WorkItemGrowthAuthorityPins, type WorkItemRevisionAuthorityPins, type SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { freezeWorkItemData, ownData, workItemRunSource, validateWorkItemUsageLocator, type WorkItemUsageLocator, type WorkItemUsageSource } from './work-item-source.js'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'

export type UsageModel = Readonly<{ provider: string; model: string; reasoningEffort?: string }>
export interface ForegroundUsageIntent {
  configDigest: string
  source: OwnerForegroundLearningTask
  model: UsageModel
  /** Old rows omit these fields and cannot authorize task-bound creation. */
  modelOrigin?: SourceGrowthRunBinding['modelOrigin']
  budget?: SourceGrowthRunBinding['budget']
  createdAt: number
  expiresAt: number
}
interface WorkItemUsageIntentBase {
  sourceKind: 'work-item'
  configDigest: string
  source: WorkItemUsageSource
  model: UsageModel
  modelOrigin: SourceGrowthRunBinding['modelOrigin']
  budget: SourceGrowthRunBinding['budget']
  createdAt: number
  expiresAt: number
}
/**
 * The corridor is frozen when the WorkItem is admitted to the queue and never
 * changes for that job: create-only (v2) or revise-created (v3). The matching
 * authority pin set travels with it, so a later configuration change can never
 * silently switch an admitted job's authority shape.
 */
export type WorkItemUsageIntent = WorkItemUsageIntentBase & (
  | { corridor: 'create'; authorities: WorkItemGrowthAuthorityPins }
  | { corridor: 'revise-created'; authorities: WorkItemRevisionAuthorityPins; revisionTarget: { parentPlanId: string; name: string } })
export type UsageIntent = ForegroundUsageIntent | WorkItemUsageIntent
export const isWorkItemUsageIntent = (intent: UsageIntent): intent is WorkItemUsageIntent => 'sourceKind' in intent && intent.sourceKind === 'work-item'
export interface UsageLocatorJob { id: string; locator: WorkItemUsageLocator; digest: string; state: 'pending' | 'frozen' | 'superseded'; jobId: string | null }
export interface UsageJob {
  id: string
  intent: UsageIntent
  digest: string
  state: 'queued' | 'running' | 'reviewed' | 'failed' | 'unknown' | 'superseded'
  definitionHash: string | null
  occurrenceId: string | null
  reason: string | null
  sourceRun: AnySourceGrowthRunBinding | null
}
type Row = { id: string; intent_json: string; digest: string; state: UsageJob['state']; definition_hash: string | null; occurrence_id: string | null; reason: string | null; source_run_json: string | null }
const read = (row: Row): UsageJob => {
  const intent = JSON.parse(row.intent_json) as UsageIntent
  if (acceptanceDigest(intent) !== row.digest) throw new Error('usage intent digest mismatch')
  return { id: row.id, intent, digest: row.digest, state: row.state, definitionHash: row.definition_hash,
    occurrenceId: row.occurrence_id, reason: row.reason,
    sourceRun: row.source_run_json === null ? null : JSON.parse(row.source_run_json) as AnySourceGrowthRunBinding }
}

/** Intent/index only. Evaluation remains the sole task-result ledger. */
export class UsageStore {
  private readonly db: DatabaseSync
  private runWriterFrame = false
  private assertMutable(): void { if (this.runWriterFrame) throw new Error('usage mutation is forbidden inside a producer writer frame') }
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
      if (version > 3) throw new Error('usage database schema is newer than this plugin')
      this.db.exec(`CREATE TABLE IF NOT EXISTS usage_jobs(id TEXT PRIMARY KEY, lane TEXT NOT NULL, subject TEXT NOT NULL,
          intent_json TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','reviewed','failed','unknown','superseded')),
          definition_hash TEXT, occurrence_id TEXT, reason TEXT, source_run_json TEXT) STRICT;
        CREATE INDEX IF NOT EXISTS usage_jobs_lane_state ON usage_jobs(lane,state);
        CREATE TABLE IF NOT EXISTS usage_cursors(lane TEXT PRIMARY KEY, scope_key TEXT NOT NULL, watermark INTEGER NOT NULL) STRICT;`)
      if (!(this.db.prepare('PRAGMA table_info(usage_jobs)').all() as { name: string }[]).some(column => column.name === 'source_run_json')) {
        this.db.exec('ALTER TABLE usage_jobs ADD COLUMN source_run_json TEXT')
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS usage_work_item_cursors(lane TEXT PRIMARY KEY, scope_key TEXT NOT NULL, watermark INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS usage_work_item_locators(id TEXT PRIMARY KEY, lane TEXT NOT NULL, subject TEXT NOT NULL, locator_json TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','frozen','superseded')), job_id TEXT) STRICT;
        CREATE INDEX IF NOT EXISTS usage_work_item_locator_lane_state ON usage_work_item_locators(lane,state);
        PRAGMA user_version=3; COMMIT;`)
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* no transaction remained */ } this.db.close(); throw error }
  }
  close(): void { this.assertMutable(); this.db.close() }
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
  consume(input: { lane: string; scopeKey: string; watermark: number; subject: string; intent?: ForegroundUsageIntent; maxPending: number }): boolean {
    this.assertMutable()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.cursor(input.lane)
      if (prior && (prior.scopeKey !== input.scopeKey || prior.watermark >= input.watermark)) { this.db.exec('COMMIT'); return true }
      const id = input.intent === undefined ? undefined : `usage-${acceptanceDigest([input.lane, input.subject, input.intent.source.canonical.projection])}`
      if (id && !this.get(id) && this.pending(input.lane).filter(job => job.state === 'queued' || job.state === 'running').length + this.pendingWorkItems(input.lane).length >= input.maxPending) {
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
  workItemCursor(lane: string): { scopeKey: string; watermark: number } | undefined {
    const row = this.db.prepare('SELECT scope_key,watermark FROM usage_work_item_cursors WHERE lane=?').get(lane) as { scope_key: string; watermark: number } | undefined
    return row ? { scopeKey: row.scope_key, watermark: row.watermark } : undefined
  }
  private locator(row: { id: string; locator_json: string; digest: string; state: UsageLocatorJob['state']; job_id: string | null }): UsageLocatorJob {
    const locator = ownData(JSON.parse(row.locator_json)) as WorkItemUsageLocator
    validateWorkItemUsageLocator(locator)
    if (acceptanceDigest(locator) !== row.digest) throw new Error('work item locator digest mismatch')
    return { id: row.id, locator, digest: row.digest, state: row.state, jobId: row.job_id }
  }
  pendingWorkItems(lane: string): UsageLocatorJob[] {
    return (this.db.prepare("SELECT * FROM usage_work_item_locators WHERE lane=? AND state='pending' ORDER BY rowid").all(lane) as Parameters<UsageStore['locator']>[0][]).map(row => this.locator(row))
  }
  /** Canonical locator and its independent cursor commit together, before any source reader is needed. */
  consumeWorkItem(input: { lane: string; scopeKey: string; watermark: number; itemId?: string; locator?: WorkItemUsageLocator; maxPending: number }): boolean {
    this.assertMutable()
    const locator = input.locator === undefined ? undefined : ownData(input.locator)
    if (locator && (locator.protocol !== 'assistant-growth/work-item-usage-locator/v1' || locator.itemId !== input.itemId
      || locator.canonical.objectiveStatus !== 'not-achieved' || locator.expiresAt <= locator.createdAt)) throw new Error('invalid work item locator')
    if (locator) validateWorkItemUsageLocator(locator)
    if (!Number.isSafeInteger(input.watermark) || input.watermark < 1 || !Number.isSafeInteger(input.maxPending) || input.maxPending < 1 || input.maxPending > 100) throw new Error('invalid work item cursor or queue bound')
    const subject = `work-item:${input.itemId}`
    const id = locator ? `usage-work-item-${acceptanceDigest([input.lane, input.itemId, locator.canonical.version, locator.canonical.digest])}` : undefined
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.workItemCursor(input.lane)
      if (prior?.scopeKey !== undefined && prior.scopeKey !== input.scopeKey) throw new Error('work item cursor scope changed')
      if (prior && prior.watermark >= input.watermark) { this.db.exec('COMMIT'); return true }
      const existing = id ? this.db.prepare('SELECT * FROM usage_work_item_locators WHERE id=?').get(id) as Parameters<UsageStore['locator']>[0] | undefined : undefined
      if (existing && acceptanceDigest(this.locator(existing).locator) !== acceptanceDigest(locator)) {
        // Creation time/window are frozen on first discovery, never renewed by a feed revision replay.
        const priorLocator = this.locator(existing).locator
        if (acceptanceDigest({ ...locator!, createdAt: priorLocator.createdAt, expiresAt: priorLocator.expiresAt }) !== existing.digest) throw new Error('work item locator identity conflict')
      }
      const pending = this.pendingWorkItems(input.lane).filter(item => item.locator.itemId !== input.itemId).length + this.pending(input.lane).length
      if (locator && !existing && pending >= input.maxPending) { this.db.exec('COMMIT'); return false }
      if (input.itemId !== undefined) this.db.prepare("UPDATE usage_work_item_locators SET state='superseded' WHERE lane=? AND subject=? AND state='pending' AND id<>?").run(input.lane, subject, id ?? '')
      if (input.itemId !== undefined) this.db.prepare("UPDATE usage_jobs SET state='superseded',reason='canonical-source-changed' WHERE lane=? AND subject=? AND state='queued' AND id<>?").run(input.lane, subject, id ?? '')
      if (locator && id && !existing) this.db.prepare("INSERT INTO usage_work_item_locators VALUES(?,?,?,?,?,'pending',NULL)").run(id, input.lane, subject, JSON.stringify(locator), acceptanceDigest(locator))
      this.db.prepare('INSERT INTO usage_work_item_cursors VALUES(?,?,?) ON CONFLICT(lane) DO UPDATE SET scope_key=excluded.scope_key,watermark=excluded.watermark').run(input.lane, input.scopeKey, input.watermark)
      this.db.exec('COMMIT'); return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  abandonWorkItem(id: string): void {
    this.assertMutable()
    this.db.prepare("UPDATE usage_work_item_locators SET state='superseded' WHERE id=? AND state='pending'").run(id)
  }
  /** Called only inside the complete Delivery → Evaluation → WorkItems frame. */
  freezeWorkItem(id: string, intentInput: WorkItemUsageIntent): UsageJob {
    this.assertMutable()
    const intent = ownData(intentInput), source = workItemRunSource(intent.source)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM usage_work_item_locators WHERE id=?').get(id) as Parameters<UsageStore['locator']>[0] | undefined
      if (!row || row.state !== 'pending') throw new Error('work item locator is no longer pending')
      const locator = this.locator(row).locator
      if (intent.sourceKind !== 'work-item' || intent.configDigest !== locator.configDigest || intent.createdAt !== locator.createdAt
        || intent.expiresAt !== locator.expiresAt || source.itemId !== locator.itemId || source.outcomeId !== locator.canonical.outcomeId
        || source.projection.version !== locator.canonical.version || source.projection.digest !== locator.canonical.digest) throw new Error('work item source differs from locator')
      this.db.prepare("INSERT INTO usage_jobs(id,lane,subject,intent_json,digest,state) SELECT id,lane,subject,?,?,'queued' FROM usage_work_item_locators WHERE id=?")
        .run(JSON.stringify(intent), acceptanceDigest(intent), id)
      this.db.prepare("UPDATE usage_work_item_locators SET state='frozen',job_id=? WHERE id=? AND state='pending'").run(id, id)
      this.db.exec('COMMIT'); return this.get(id)!
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  bindWorkItemSourceRun(id: string, digest: string, definitionHash: string, occurrenceId: string,
    binding: WorkItemSourceGrowthRunBinding | WorkItemRevisionSourceGrowthRunBinding):
    WorkItemSourceGrowthRunBinding | WorkItemRevisionSourceGrowthRunBinding {
    this.assertMutable()
    validateAnySourceGrowthRunBinding(binding)
    return this.withWorkItemRunWriter({ runId: id, intentDigest: digest }, job => {
      if (job.state !== 'running' || job.definitionHash !== definitionHash || job.occurrenceId !== occurrenceId
        || !isWorkItemUsageIntent(job.intent) || binding.runId !== id || binding.intentDigest !== digest
        || binding.configDigest !== job.intent.configDigest || binding.ownerDigest !== sourceGrowthEvidenceDigest(job.intent.source.task.owner)
        || binding.native.automationId !== id || binding.native.definitionHash !== definitionHash || binding.native.occurrenceId !== occurrenceId
        || acceptanceDigest(binding.source) !== acceptanceDigest(workItemRunSource(job.intent.source))
        || acceptanceDigest(binding.model) !== acceptanceDigest(job.intent.model) || binding.modelOrigin !== job.intent.modelOrigin
        || acceptanceDigest(binding.budget) !== acceptanceDigest(job.intent.budget)
        || (binding.protocol === 'assistant-growth/source-run/v3') !== (job.intent.corridor === 'revise-created')
        || binding.mode !== (job.intent.corridor === 'revise-created' ? 'revise-created' : 'create')
        || acceptanceDigest(binding.authorities) !== acceptanceDigest(job.intent.authorities)) throw new Error('work item source run differs from frozen intent')
      if (job.sourceRun !== null) {
        if (anySourceGrowthRunDigest(job.sourceRun) !== anySourceGrowthRunDigest(binding)) throw new Error('usage source run binding conflict')
        return freezeWorkItemData(binding)
      }
      this.db.prepare('UPDATE usage_jobs SET source_run_json=? WHERE id=? AND source_run_json IS NULL').run(JSON.stringify(binding), id)
      return freezeWorkItemData(binding)
    })
  }
  /** A real SQLite writer transaction holds the durable row through the foreign synchronous consumer. */
  withWorkItemRunWriter<T>(input: { runId: string; intentDigest: string }, callback: (job: UsageJob) => T): T {
    this.assertMutable()
    this.db.exec('BEGIN IMMEDIATE')
    this.runWriterFrame = true
    try {
      const job = this.get(input.runId)
      if (!job || job.digest !== input.intentDigest || !isWorkItemUsageIntent(job.intent)
        || !['running', 'reviewed'].includes(job.state)) throw new Error('work item growth run is not current')
      const value = callback(job)
      if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
        if (utilTypes.isProxy(value)) throw new Error('work item run fence callback must be synchronous')
        if ('then' in value) {
          // Consume a trusted native Promise rejection without reading a custom
          // then getter. Arbitrary thenables and proxies remain forbidden.
          try { Promise.prototype.then.call(value, undefined, () => undefined) } catch { /* Not a native Promise. */ }
          throw new Error('work item run fence callback must be synchronous')
        }
      }
      this.db.exec('COMMIT'); return value
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { this.runWriterFrame = false }
  }
  interrupt(lane: string): void {
    this.assertMutable()
    this.db.prepare("UPDATE usage_jobs SET state='unknown',reason='interrupted-after-dispatch' WHERE lane=? AND state='running'").run(lane)
  }
  bind(id: string, definitionHash: string): UsageJob {
    this.assertMutable()
    this.db.prepare("UPDATE usage_jobs SET definition_hash=? WHERE id=? AND state='queued' AND definition_hash IS NULL").run(definitionHash, id)
    const job = this.get(id)
    if (!job || job.definitionHash !== definitionHash) throw new Error('usage definition binding changed')
    return job
  }
  claim(id: string, definitionHash: string, occurrenceId: string): UsageJob {
    this.assertMutable()
    if (this.db.prepare("UPDATE usage_jobs SET state='running',occurrence_id=? WHERE id=? AND state='queued' AND definition_hash=?").run(occurrenceId, id, definitionHash).changes !== 1) throw new Error('usage job already claimed')
    return this.get(id)!
  }
  bindSourceRun(id: string, digest: string, definitionHash: string, occurrenceId: string, binding: SourceGrowthRunBinding): SourceGrowthRunBinding {
    this.assertMutable()
    validateSourceGrowthRunBinding(binding)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const job = this.get(id)
      if (!job || isWorkItemUsageIntent(job.intent) || job.digest !== digest || job.state !== 'running' || job.definitionHash !== definitionHash
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
        if (job.sourceRun.protocol !== 'assistant-growth/source-run/v1') throw new Error('foreground source run protocol changed')
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
    this.assertMutable()
    if (occurrenceId === undefined) this.db.prepare("UPDATE usage_jobs SET state=?,reason=? WHERE id=? AND state='queued'").run(state, reason, id)
    else this.db.prepare("UPDATE usage_jobs SET state=?,reason=? WHERE id=? AND state='running' AND occurrence_id=?").run(state, reason, id, occurrenceId)
  }
}
