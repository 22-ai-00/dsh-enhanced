import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { types as utilTypes } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

/**
 * Private idea ledger. Fail-closed, lane-scoped and side-effect free: it only
 * records dreaming runs, submitted ideas and per-day counters. Nothing in this
 * module adopts, notifies or promotes anything.
 */

const SCHEMA_VERSION = 1

export type IdeaState = 'recorded' | 'withdrawn' | 'owner-acknowledged' | 'validated' | 'rejected'

export interface DreamIdea {
  id: string
  lane: string
  runId: string
  createdAt: number
  dayKey: string
  state: IdeaState
  summary: string
  detail: string
  /** Digests of the Host projections this idea cites; never raw content. */
  evidenceRefs: readonly string[]
}

export interface DreamRunRecord {
  id: string
  lane: string
  occurrence: number
  dayKey: string
  startedAt: number
  endedAt: number | null
  outcome: 'running' | 'completed' | 'interrupted'
  drawDigest: string
  ideaCount: number
}

export interface IdeaEvent {
  ideaId: string
  state: IdeaState
  actor: 'owner' | 'host'
  at: number
  note?: string
}

export function assertLedgerPath(path: string): void {
  if (!isAbsolute(path) || dirname(path) === path) throw new Error('dream store: databasePath must be an absolute file path')
  mkdirSync(dirname(path), { recursive: true })
  const parent = lstatSync(dirname(path))
  // Fail closed on shared or world-writable ancestors, mirroring DSH state
  // privacy: the ledger holds owner-derived freeform text.
  if ((parent.mode & 0o022) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error('dream store: database directory must be private to the service owner')
  }
}

function assertMutable(closed: boolean): void {
  if (closed) throw new Error('dream store: database is closed')
}

/** New idea data must be exact own data: no accessors, proxies or cycles. */
export function ownData<T>(input: T): T {
  const seen = new Set<object>()
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 16_384 || depth > 32) throw new Error('dream data exceeds bounds')
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value)) return
    if (typeof value === 'string') {
      if (!value.isWellFormed() || Buffer.byteLength(value) > 65_536) throw new Error('dream text exceeds bounds')
      return
    }
    if (typeof value !== 'object' || utilTypes.isProxy(value) || seen.has(value)
      || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) {
      throw new Error('invalid dream data')
    }
    seen.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Array.isArray(value)) delete descriptors.length
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')
      || Object.values(descriptors).some(field => !field.enumerable || !('value' in field))) {
      throw new Error('invalid dream own data')
    }
    for (const field of Object.values(descriptors)) visit(field.value, depth + 1)
    seen.delete(value)
  }
  visit(input, 0)
  return JSON.parse(JSON.stringify(input)) as T
}

export class DreamStore {
  private readonly db: DatabaseSync
  private readonly lane: string
  private closed = false

  constructor(databasePath: string, lane: string) {
    if (!lane || lane.length > 128 || !/^[\w:-]+$/u.test(lane)) throw new Error('dream store: invalid lane')
    assertLedgerPath(databasePath)
    this.lane = lane
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`PRAGMA busy_timeout = 5000`)
    this.migrate()
  }

  private migrate(): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > SCHEMA_VERSION) throw new Error('dream store: database schema is newer than this build')
    if (version === SCHEMA_VERSION) return
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS dream_runs (
          id TEXT PRIMARY KEY,
          lane TEXT NOT NULL,
          occurrence INTEGER NOT NULL,
          day_key TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          outcome TEXT NOT NULL CHECK (outcome IN ('running','completed','interrupted')),
          draw_digest TEXT NOT NULL,
          idea_count INTEGER NOT NULL DEFAULT 0,
          UNIQUE (lane, occurrence)
        );
        CREATE TABLE IF NOT EXISTS dream_ideas (
          id TEXT PRIMARY KEY,
          lane TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES dream_runs(id),
          created_at INTEGER NOT NULL,
          day_key TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('recorded','withdrawn','owner-acknowledged','validated','rejected')),
          summary TEXT NOT NULL,
          detail TEXT NOT NULL,
          evidence_refs TEXT NOT NULL,
          summary_digest TEXT NOT NULL,
          UNIQUE (lane, summary_digest, day_key)
        );
        CREATE TABLE IF NOT EXISTS dream_idea_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          idea_id TEXT NOT NULL REFERENCES dream_ideas(id),
          state TEXT NOT NULL,
          actor TEXT NOT NULL CHECK (actor IN ('owner','host')),
          at INTEGER NOT NULL,
          note TEXT
        );
        CREATE TABLE IF NOT EXISTS dream_counters (
          lane TEXT NOT NULL,
          day_key TEXT NOT NULL,
          dreams INTEGER NOT NULL DEFAULT 0,
          notifications INTEGER NOT NULL DEFAULT 0,
          last_notification_at INTEGER,
          PRIMARY KEY (lane, day_key)
        );
      `)
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true }
  }

  beginDream(id: string, occurrence: number, dayKey: string, startedAt: number, drawDigest: string): DreamRunRecord {
    assertMutable(this.closed)
    ownData({ id, occurrence, dayKey, startedAt, drawDigest })
    this.db.prepare(`INSERT INTO dream_runs (id, lane, occurrence, day_key, started_at, outcome, draw_digest)
      VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(id, this.lane, occurrence, dayKey, startedAt, drawDigest)
    this.db.prepare(`INSERT INTO dream_counters (lane, day_key, dreams) VALUES (?, ?, 1)
      ON CONFLICT(lane, day_key) DO UPDATE SET dreams = dreams + 1`).run(this.lane, dayKey)
    return this.run(id)!
  }

  completeDream(id: string, endedAt: number, ideaCount: number): void {
    assertMutable(this.closed)
    const result = this.db.prepare(`UPDATE dream_runs SET outcome='completed', ended_at=?, idea_count=?
      WHERE id=? AND lane=? AND outcome='running'`).run(endedAt, ideaCount, id, this.lane)
    if (result.changes !== 1) throw new Error('dream store: running dream not found')
  }

  markInterrupted(id: string, endedAt: number): void {
    assertMutable(this.closed)
    this.db.prepare(`UPDATE dream_runs SET outcome='interrupted', ended_at=? WHERE id=? AND lane=? AND outcome='running'`)
      .run(endedAt, id, this.lane)
  }

  run(id: string): DreamRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM dream_runs WHERE id=? AND lane=?').get(id, this.lane) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      id: row.id as string, lane: row.lane as string, occurrence: row.occurrence as number,
      dayKey: row.day_key as string, startedAt: row.started_at as number,
      endedAt: row.ended_at as number | null, outcome: row.outcome as DreamRunRecord['outcome'],
      drawDigest: row.draw_digest as string, ideaCount: row.idea_count as number,
    }
  }

  countDreams(dayKey: string): number {
    const row = this.db.prepare('SELECT dreams FROM dream_counters WHERE lane=? AND day_key=?').get(this.lane, dayKey) as { dreams: number } | undefined
    return row?.dreams ?? 0
  }

  recordIdea(idea: Omit<DreamIdea, 'lane' | 'state'>): DreamIdea {
    assertMutable(this.closed)
    const refs = ownData(idea.evidenceRefs)
    if (!Array.isArray(refs) || refs.length === 0 || refs.some(ref => typeof ref !== 'string' || !/^[a-f0-9]{64}$/u.test(ref))) {
      throw new Error('dream store: evidence refs must be hex digests')
    }
    const value = ownData(idea)
    if (Buffer.byteLength(value.summary) > 512 || Buffer.byteLength(value.detail) > 4_096) {
      throw new Error('dream store: idea text exceeds bounds')
    }
    const summaryDigest = createHashSafe(`${value.summary}\0${value.dayKey}`)
    this.db.prepare(`INSERT INTO dream_ideas (id, lane, run_id, created_at, day_key, state, summary, detail, evidence_refs, summary_digest)
      VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?)`)
      .run(value.id, this.lane, value.runId, value.createdAt, value.dayKey, value.summary, value.detail, JSON.stringify(refs), summaryDigest)
    this.db.prepare('UPDATE dream_runs SET idea_count = idea_count + 1 WHERE id=? AND lane=?').run(value.runId, this.lane)
    return this.idea(value.id)!
  }

  idea(id: string): DreamIdea | undefined {
    const row = this.db.prepare('SELECT * FROM dream_ideas WHERE id=? AND lane=?').get(id, this.lane) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      id: row.id as string, lane: row.lane as string, runId: row.run_id as string,
      createdAt: row.created_at as number, dayKey: row.day_key as string,
      state: row.state as IdeaState, summary: row.summary as string, detail: row.detail as string,
      evidenceRefs: JSON.parse(row.evidence_refs as string) as string[],
    }
  }

  transitionIdea(id: string, state: Exclude<IdeaState, 'recorded'>, actor: 'owner' | 'host', at: number, note?: string): void {
    assertMutable(this.closed)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.idea(id)
      if (current === undefined) throw new Error('dream store: idea not found')
      const allowed: Readonly<Record<IdeaState, readonly IdeaState[]>> = {
        recorded: ['withdrawn', 'owner-acknowledged', 'validated', 'rejected'],
        withdrawn: [],
        'owner-acknowledged': ['validated', 'rejected'],
        validated: [],
        rejected: [],
      }
      if (!allowed[current.state].includes(state)) throw new Error(`dream store: transition ${current.state} -> ${state} is not allowed`)
      this.db.prepare('UPDATE dream_ideas SET state=? WHERE id=? AND lane=?').run(state, id, this.lane)
      this.db.prepare('INSERT INTO dream_idea_events (idea_id, state, actor, at, note) VALUES (?, ?, ?, ?, ?)')
        .run(id, state, actor, at, note ?? null)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  listIdeas(limit = 50): readonly DreamIdea[] {
    const rows = this.db.prepare('SELECT id FROM dream_ideas WHERE lane=? ORDER BY created_at DESC LIMIT ?').all(this.lane, limit) as Array<{ id: string }>
    return rows.map(row => this.idea(row.id)!)
  }

  counts(): { runs: number; ideas: number; recorded: number } {
    const runs = Number(this.db.prepare('SELECT COUNT(*) AS n FROM dream_runs WHERE lane=?').get(this.lane)!['n'])
    const ideas = Number(this.db.prepare('SELECT COUNT(*) AS n FROM dream_ideas WHERE lane=?').get(this.lane)!.n)
    const recorded = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM dream_ideas WHERE lane=? AND state='recorded'`).get(this.lane)!.n)
    return { runs, ideas, recorded }
  }

  /** Hard-delete expired ideas per retention policy; runs keep audit digests only. */
  prune(now: number, retentionDays: number): number {
    assertMutable(this.closed)
    const cutoff = now - retentionDays * 86_400_000
    return Number(this.db.prepare('DELETE FROM dream_ideas WHERE lane=? AND created_at < ?').run(this.lane, cutoff).changes)
  }

  interrupt(): void {
    assertMutable(this.closed)
    this.db.prepare(`UPDATE dream_runs SET outcome='interrupted', ended_at=? WHERE lane=? AND outcome='running'`)
      .run(Date.now(), this.lane)
  }
}

function createHashSafe(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
