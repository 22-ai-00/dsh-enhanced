import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { privatePath } from './engine.js'
import type { OpportunityDecision, OpportunityScope, PreparationSettings } from './types.js'

export interface PreparationResult {
  outcome: string; output: string; usage: Readonly<Record<string, unknown>>; sessionId?: string; quiescent?: boolean
  diagnostic?: Readonly<{ failureClass: string; failurePhase: string; failureCode: string }>
}
export interface PreparationRecord {
  id: string; decision: OpportunityDecision; settings: PreparationSettings
  state: 'queued' | 'running' | 'draft' | 'failed' | 'cancelled' | 'unknown'
  createdAt: number; updatedAt: number; deadlineAt: number; token?: string; result?: PreparationResult; reason?: string
}

/** The preparation intent and result are private, durable data; neither is goal completion evidence. */
export class PreparationStore {
  readonly #db: DatabaseSync
  readonly #enqueueListeners = new Set<(record: PreparationRecord) => void>()
  constructor(path: string) {
    if (path !== ':memory:') privatePath(path)
    this.#db = new DatabaseSync(path)
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS proactive_preparations(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, goal_id TEXT NOT NULL, state TEXT NOT NULL, token TEXT, payload_json TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS proactive_preparations_scope ON proactive_preparations(scope_key,goal_id);`)
    // A previous process may have dispatched a paid request. Never retry that
    // uncertain call automatically; a concurrent opener fences its late result.
    for (const row of this.#db.prepare("SELECT id FROM proactive_preparations WHERE state='running'").all() as { id: string }[]) {
      const value = this.get(row.id)!
      this.#write({ ...value, state: 'unknown', reason: 'process-interrupted', updatedAt: Date.now() }, 'running')
    }
  }
  onEnqueue(listener: (record: PreparationRecord) => void): () => void {
    this.#enqueueListeners.add(listener)
    return () => { this.#enqueueListeners.delete(listener) }
  }
  enqueue(decision: OpportunityDecision, settings: PreparationSettings, deadlineAt = decision.expiresAt): PreparationRecord {
    const existing = this.get(decision.id)
    if (existing) {
      if (acceptanceDigest([existing.decision, existing.settings, existing.deadlineAt]) !== acceptanceDigest([decision, settings, deadlineAt])) throw new Error('assistant-proactive: preparation identity conflict')
      return existing
    }
    const value: PreparationRecord = { id: decision.id, decision, settings, deadlineAt, state: 'queued', createdAt: Date.now(), updatedAt: Date.now() }
    const result = this.#db.prepare('INSERT OR IGNORE INTO proactive_preparations VALUES(?,?,?,?,?,?)').run(value.id, acceptanceDigest(decision.scope), decision.goalId, value.state, null, JSON.stringify(value))
    const saved = this.get(value.id)!
    if (acceptanceDigest([saved.decision, saved.settings, saved.deadlineAt]) !== acceptanceDigest([decision, settings, deadlineAt])) throw new Error('assistant-proactive: preparation identity conflict')
    if (result.changes === 1 && saved.state === 'queued') {
      for (const listener of Array.from(this.#enqueueListeners)) {
        try { listener(saved) } catch { /* Enqueue notifications must not abort persistence. */ }
      }
    }
    return saved
  }
  hasPending(): boolean {
    return this.#db.prepare("SELECT 1 AS found FROM proactive_preparations WHERE state='queued' LIMIT 1").get() !== undefined
  }
  list(filter: { scope?: OpportunityScope; goalId?: string; state?: PreparationRecord['state']; limit?: number } = {}): PreparationRecord[] {
    const conditions: string[] = []
    const params: (string | number)[] = []
    if (filter.scope !== undefined) {
      conditions.push('scope_key=?')
      params.push(acceptanceDigest(filter.scope))
    }
    if (filter.goalId !== undefined) {
      conditions.push('goal_id=?')
      params.push(filter.goalId)
    }
    if (filter.state !== undefined) {
      conditions.push('state=?')
      params.push(filter.state)
    }
    const limit = typeof filter.limit === 'number' && Number.isSafeInteger(filter.limit) && filter.limit > 0
      ? Math.min(filter.limit, 500) : 100
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.#db.prepare(`SELECT payload_json FROM proactive_preparations ${where} ORDER BY rowid DESC LIMIT ?`).all(...params, limit) as { payload_json: string }[]
    return rows.map(row => JSON.parse(row.payload_json) as PreparationRecord)
  }
  get(id: string): PreparationRecord | undefined {
    const row = this.#db.prepare('SELECT payload_json FROM proactive_preparations WHERE id=?').get(id) as { payload_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.payload_json) as PreparationRecord
  }
  pending(): PreparationRecord[] {
    return (this.#db.prepare("SELECT payload_json FROM proactive_preparations WHERE state='queued' ORDER BY rowid LIMIT 32").all() as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as PreparationRecord)
  }
  claim(id: string): PreparationRecord | undefined {
    const value = this.get(id)
    if (!value || value.state !== 'queued') return undefined
    const claimed = { ...value, state: 'running' as const, token: randomUUID(), updatedAt: Date.now() }
    return this.#write(claimed, 'queued') ? claimed : undefined
  }
  finish(value: PreparationRecord, state: PreparationRecord['state'], result?: PreparationResult, reason?: string): void {
    const current = this.get(value.id)
    if (current?.state !== 'running' || current.token !== value.token) return
    this.#write({ ...current, state, updatedAt: Date.now(), ...(result ? { result } : {}), ...(reason ? { reason } : {}) }, 'running', value.token)
  }
  cancel(id: string): void {
    const value = this.get(id)
    if (value && (value.state === 'queued' || value.state === 'running')) this.#write({ ...value, state: 'cancelled', reason: 'owner-rejected', updatedAt: Date.now() }, value.state)
  }
  cancelWait(waitId: string, scope: OpportunityScope): void {
    for (const row of this.#db.prepare("SELECT payload_json FROM proactive_preparations WHERE scope_key=? AND state IN ('queued','running')").all(acceptanceDigest(scope)) as { payload_json: string }[]) {
      const value = JSON.parse(row.payload_json) as PreparationRecord
      if (value.decision.waitId === waitId) this.#write({ ...value, state: 'cancelled', reason: 'wait-ended', updatedAt: Date.now() }, value.state)
    }
  }
  cancelGoal(goalId: string, scope: OpportunityScope, reason = 'goal-ended'): number {
    let cancelled = 0
    for (const row of this.#db.prepare("SELECT payload_json FROM proactive_preparations WHERE scope_key=? AND goal_id=? AND state IN ('queued','running')").all(acceptanceDigest(scope), goalId) as { payload_json: string }[]) {
      const value = JSON.parse(row.payload_json) as PreparationRecord
      if (this.#write({ ...value, state: 'cancelled', reason, updatedAt: Date.now() }, value.state)) cancelled += 1
    }
    return cancelled
  }
  #write(value: PreparationRecord, expected: PreparationRecord['state'], token?: string): boolean {
    return this.#db.prepare(`UPDATE proactive_preparations SET state=?,token=?,payload_json=? WHERE id=? AND state=?${token === undefined ? '' : ' AND token=?'}`)
      .run(value.state, value.token ?? null, JSON.stringify(value), value.id, expected, ...(token === undefined ? [] : [token])).changes === 1
  }
  close(): void { this.#enqueueListeners.clear(); this.#db.close() }
}
