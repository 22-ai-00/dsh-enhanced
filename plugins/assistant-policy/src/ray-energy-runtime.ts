import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type {
  RayIdeal,
  RayKernelEnergyConfig,
  RaySelfModel,
  RaySessionRole,
  RayStageGoal,
} from '@dsh-ray/assistant-growth-contract'

export type RayEnergyLane = 'owner' | 'free'

export type RayGrowthEventCategory =
  | 'owner-task'
  | 'owner-correction'
  | 'repeat-request'
  | 'verified-pass'
  | 'latency-ms'
  | 'newly-regressed'
  | 'persistent-gap'
  | 'proactive-surfaced'
  | 'proactive-accepted'
  | 'proactive-annoyed'
  | 'capability-invocation'

export interface RayEnergyDailySnapshot {
  readonly dayKey: string
  readonly dailyTokenCap: number
  readonly freeEnergyRatioBp: number
  readonly maxConcurrentWorkers: number
  readonly ownerTokensUsed: number
  readonly freeTokensUsed: number
  readonly totalTokensUsed: number
  readonly remainingDailyTokens: number
  readonly freeAllowanceTokens: number
  readonly freeRemainingTokens: number
  readonly turnCount: number
  readonly windDown: boolean
}

export interface RayEnergyBudgetCheck {
  readonly allowed: boolean
  readonly reason: string
  readonly lane: RayEnergyLane
  readonly windDown: boolean
  readonly freeRemainingTokens: number
  readonly remainingDailyTokens: number
}

export interface RayGrowthEventInput {
  readonly category: RayGrowthEventCategory
  readonly metricKey: string
  readonly value?: number
  readonly subjectId?: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface RayKernelGrowthReport {
  readonly rayHome: string
  readonly generatedAt: number
  readonly energy: RayEnergyDailySnapshot
  readonly ownerService: {
    readonly totalOwnerTasks: number
    readonly correctionCount: number
    readonly correctionRate: number
    readonly repeatRequestCount: number
    readonly repeatRequestRate: number
    readonly verifiedPassCount: number
    readonly totalTokens: number
    readonly avgLatencyMs: number
    readonly newlyRegressedCount: number
    readonly persistentGapCount: number
  }
  readonly proactiveValue: {
    readonly surfacedCount: number
    readonly acceptedCount: number
    readonly acceptanceRate: number
    readonly annoyedCount: number
    readonly annoyanceRate: number
    readonly selfCapabilityInvocations: number
  }
  readonly selfGoals: {
    readonly trustLevel: 'low-self-reported'
    readonly note: string
    readonly ideals: readonly RayIdeal[]
    readonly stageGoals: readonly RayStageGoal[]
  }
}

export interface RayEnergyRuntimeOptions {
  readonly rayHome: string
  readonly now: () => number
  readonly getKernelEnergy: () => RayKernelEnergyConfig
  readonly getSessionRole: (sessionId: string) => RaySessionRole
  readonly getSelfModel: () => RaySelfModel
  readonly registerDatabase?: (plugin: string, dbPath: string) => void
  readonly context?: Context
}

const WIND_DOWN_UTILIZATION_RATIO = 0.85

function formatLocalDayKey(timestampMs: number): string {
  const d = new Date(timestampMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function ratio(num: number, denom: number): number {
  if (denom <= 0) return 0
  return Number((num / denom).toFixed(4))
}

interface DailyRow {
  day_key: string
  owner_tokens: number
  free_tokens: number
  turn_count: number
  wind_down: number
  updated_at: number
}

export class RayEnergyRuntime {
  readonly databasePath: string
  private readonly rayHome: string
  private readonly now: () => number
  private readonly options: RayEnergyRuntimeOptions
  private readonly db: DatabaseSync
  private readonly disposers: Array<() => void> = []
  private closed = false

  constructor(options: RayEnergyRuntimeOptions) {
    this.options = options
    this.rayHome = options.rayHome
    this.now = options.now
    this.databasePath = join(this.rayHome, 'energy', 'energy.sqlite')
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })

    const db = new DatabaseSync(this.databasePath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS ray_energy_daily (
        day_key TEXT PRIMARY KEY,
        owner_tokens INTEGER NOT NULL DEFAULT 0,
        free_tokens INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        wind_down INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ray_energy_events (
        event_id TEXT PRIMARY KEY,
        day_key TEXT NOT NULL,
        lane TEXT NOT NULL CHECK(lane IN ('owner','free')),
        source TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        session_id TEXT,
        allowed INTEGER NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ray_energy_events_day ON ray_energy_events(day_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS ray_growth_events (
        event_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        value_num REAL NOT NULL DEFAULT 1,
        subject_id TEXT,
        detail_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ray_growth_events_cat ON ray_growth_events(category, created_at DESC);
    `)
    this.db = db
    if (existsSync(this.databasePath)) {
      try { chmodSync(this.databasePath, 0o600) } catch { /* ignore */ }
    }
    try {
      this.options.registerDatabase?.('assistant-policy/energy', this.databasePath)
    } catch {
      // Ignore if manifest is not ready yet during early construction.
    }

    const on = (this.options.context as unknown as {
      on?: (event: string, listener: (session: unknown, event: unknown) => void) => (() => void) | undefined
    } | undefined)?.on
    if (typeof on === 'function') {
      const unsub = on('session/event', (rawSession, rawEvent) => {
        if (this.closed) return
        const session = rawSession as { id?: unknown; header?: { origin?: unknown } } | undefined
        const ev = rawEvent as { type?: unknown; data?: { message?: { usage?: { totalTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown } } } } | undefined
        if (session?.header?.origin === 'subagent') return
        if (ev?.type !== 'assistant/message') return
        const usage = ev.data?.message?.usage
        if (usage === undefined) return
        const totalRaw = typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
          ? usage.totalTokens
          : (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0)
            + (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0)
        const tokens = Math.max(0, Math.trunc(totalRaw))
        if (tokens === 0) return
        const sessionId = typeof session?.id === 'string' ? session.id : ''
        const role = sessionId ? this.options.getSessionRole(sessionId) : 'front-consciousness'
        if (role === 'reflection') {
          this.recordFreeEnergyUsage(tokens, 'session:reflection', sessionId)
        } else {
          this.consumeOwnerEnergy(tokens, `session:${role}`, sessionId)
        }
      })
      if (typeof unsub === 'function') this.disposers.push(unsub)
    }
  }

  private assertOpen(): DatabaseSync {
    if (this.closed) throw new Error('assistant-policy: RayEnergyRuntime is disposed')
    return this.db
  }

  private readDailyRow(dayKey: string): DailyRow {
    const db = this.assertOpen()
    const row = db.prepare('SELECT * FROM ray_energy_daily WHERE day_key = ?').get(dayKey) as unknown as DailyRow | undefined
    if (row !== undefined) return row
    const now = this.now()
    db.prepare(`
      INSERT OR IGNORE INTO ray_energy_daily (day_key, owner_tokens, free_tokens, turn_count, wind_down, updated_at)
      VALUES (?, 0, 0, 0, 0, ?)
    `).run(dayKey, now)
    return { day_key: dayKey, owner_tokens: 0, free_tokens: 0, turn_count: 0, wind_down: 0, updated_at: now }
  }

  snapshot(atMs = this.now()): RayEnergyDailySnapshot {
    const dayKey = formatLocalDayKey(atMs)
    const kernelEnergy = this.options.getKernelEnergy()
    const row = this.readDailyRow(dayKey)
    const dailyTokenCap = Math.max(1, Math.trunc(kernelEnergy.dailyTokenCap))
    const freeEnergyRatioBp = Math.max(0, Math.min(10_000, Math.trunc(kernelEnergy.freeEnergyRatioBp)))
    const maxConcurrentWorkers = Math.max(1, Math.trunc(kernelEnergy.maxConcurrentWorkers))
    const ownerTokensUsed = Math.max(0, Math.trunc(row.owner_tokens))
    const freeTokensUsed = Math.max(0, Math.trunc(row.free_tokens))
    const totalTokensUsed = ownerTokensUsed + freeTokensUsed
    const remainingDailyTokens = Math.max(0, dailyTokenCap - totalTokensUsed)
    const freeAllowanceTokens = Math.floor(Math.max(0, dailyTokenCap - ownerTokensUsed) * (freeEnergyRatioBp / 10_000))
    const freeRemainingTokens = Math.min(remainingDailyTokens, Math.max(0, freeAllowanceTokens - freeTokensUsed))
    const windDown = row.wind_down === 1 || totalTokensUsed >= Math.floor(dailyTokenCap * WIND_DOWN_UTILIZATION_RATIO)
    return {
      dayKey,
      dailyTokenCap,
      freeEnergyRatioBp,
      maxConcurrentWorkers,
      ownerTokensUsed,
      freeTokensUsed,
      totalTokensUsed,
      remainingDailyTokens,
      freeAllowanceTokens,
      freeRemainingTokens,
      turnCount: Math.max(0, Math.trunc(row.turn_count)),
      windDown,
    }
  }

  checkFreeEnergyBudget(requestedTokens: number, atMs = this.now()): RayEnergyBudgetCheck {
    const snap = this.snapshot(atMs)
    const req = Math.max(1, Math.trunc(requestedTokens))
    if (snap.windDown) {
      return {
        allowed: false,
        reason: 'daily-energy-wind-down',
        lane: 'free',
        windDown: true,
        freeRemainingTokens: snap.freeRemainingTokens,
        remainingDailyTokens: snap.remainingDailyTokens,
      }
    }
    if (snap.remainingDailyTokens < req || snap.freeRemainingTokens < req) {
      return {
        allowed: false,
        reason: 'free-energy-exhausted',
        lane: 'free',
        windDown: snap.windDown,
        freeRemainingTokens: snap.freeRemainingTokens,
        remainingDailyTokens: snap.remainingDailyTokens,
      }
    }
    return {
      allowed: true,
      reason: 'ok',
      lane: 'free',
      windDown: false,
      freeRemainingTokens: snap.freeRemainingTokens,
      remainingDailyTokens: snap.remainingDailyTokens,
    }
  }

  checkOwnerEnergyBudget(requestedTokens: number, atMs = this.now()): RayEnergyBudgetCheck {
    const snap = this.snapshot(atMs)
    const req = Math.max(0, Math.trunc(requestedTokens))
    // Strict owner precedence: owner work bypasses windDown and free-energy caps up to dailyTokenCap.
    const allowed = snap.ownerTokensUsed + req <= snap.dailyTokenCap
    return {
      allowed,
      reason: allowed ? 'owner-priority' : 'daily-token-cap-reached',
      lane: 'owner',
      windDown: snap.windDown,
      freeRemainingTokens: snap.freeRemainingTokens,
      remainingDailyTokens: snap.remainingDailyTokens,
    }
  }

  tryConsumeFreeEnergy(
    tokens: number,
    source: string,
    sessionId?: string,
    atMs = this.now(),
  ): { ok: true; snapshot: RayEnergyDailySnapshot } | { ok: false; check: RayEnergyBudgetCheck } {
    const req = Math.max(1, Math.trunc(tokens))
    const check = this.checkFreeEnergyBudget(req, atMs)
    const db = this.assertOpen()
    const dayKey = formatLocalDayKey(atMs)
    if (!check.allowed) {
      db.prepare(`
        INSERT INTO ray_energy_events (event_id, day_key, lane, source, tokens, session_id, allowed, reason, created_at)
        VALUES (?, ?, 'free', ?, ?, ?, 0, ?, ?)
      `).run(`en-${randomUUID()}`, dayKey, source, req, sessionId ?? null, check.reason, atMs)
      return { ok: false, check }
    }
    return {
      ok: true,
      snapshot: this.recordFreeEnergyUsage(req, source, sessionId, atMs),
    }
  }

  private recordFreeEnergyUsage(
    tokens: number,
    source: string,
    sessionId?: string,
    atMs = this.now(),
  ): RayEnergyDailySnapshot {
    const db = this.assertOpen()
    const dayKey = formatLocalDayKey(atMs)
    this.readDailyRow(dayKey)
    const amount = Math.max(0, Math.trunc(tokens))
    const before = this.snapshot(atMs)
    const nextTotal = before.totalTokensUsed + amount
    const windDown = nextTotal >= Math.floor(before.dailyTokenCap * WIND_DOWN_UTILIZATION_RATIO) ? 1 : 0
    db.prepare(`
      UPDATE ray_energy_daily
      SET free_tokens = free_tokens + ?, turn_count = turn_count + 1,
          wind_down = MAX(wind_down, ?), updated_at = ?
      WHERE day_key = ?
    `).run(amount, windDown, atMs, dayKey)
    db.prepare(`
      INSERT INTO ray_energy_events (event_id, day_key, lane, source, tokens, session_id, allowed, reason, created_at)
      VALUES (?, ?, 'free', ?, ?, ?, 1, 'ok', ?)
    `).run(`en-${randomUUID()}`, dayKey, source, amount, sessionId ?? null, atMs)
    return this.snapshot(atMs)
  }

  consumeOwnerEnergy(
    tokens: number,
    source: string,
    sessionId?: string,
    atMs = this.now(),
  ): RayEnergyDailySnapshot {
    const db = this.assertOpen()
    const dayKey = formatLocalDayKey(atMs)
    this.readDailyRow(dayKey)
    const amount = Math.max(0, Math.trunc(tokens))
    const before = this.snapshot(atMs)
    const nextTotal = before.totalTokensUsed + amount
    const windDown = nextTotal >= Math.floor(before.dailyTokenCap * WIND_DOWN_UTILIZATION_RATIO) ? 1 : 0
    db.prepare(`
      UPDATE ray_energy_daily
      SET owner_tokens = owner_tokens + ?, turn_count = turn_count + 1,
          wind_down = MAX(wind_down, ?), updated_at = ?
      WHERE day_key = ?
    `).run(amount, windDown, atMs, dayKey)
    db.prepare(`
      INSERT INTO ray_energy_events (event_id, day_key, lane, source, tokens, session_id, allowed, reason, created_at)
      VALUES (?, ?, 'owner', ?, ?, ?, 1, 'owner-priority', ?)
    `).run(`en-${randomUUID()}`, dayKey, source, amount, sessionId ?? null, atMs)
    return this.snapshot(atMs)
  }

  recordGrowthEvent(input: RayGrowthEventInput, atMs = this.now()): string {
    const db = this.assertOpen()
    const eventId = `gr-${randomUUID()}`
    const val = typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : 1
    db.prepare(`
      INSERT INTO ray_growth_events (event_id, category, metric_key, value_num, subject_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.category,
      input.metricKey,
      val,
      input.subjectId ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      atMs,
    )
    return eventId
  }

  growthReport(atMs = this.now()): RayKernelGrowthReport {
    const db = this.assertOpen()
    const energy = this.snapshot(atMs)
    const rows = db.prepare(`
      SELECT category, COUNT(*) AS cnt, COALESCE(SUM(value_num), 0) AS sum_val, COALESCE(AVG(value_num), 0) AS avg_val
      FROM ray_growth_events
      GROUP BY category
    `).all() as Array<{ category: string; cnt: number; sum_val: number; avg_val: number }>
    const byCat = new Map(rows.map(r => [r.category, r]))
    const sumOf = (cat: RayGrowthEventCategory) => Math.max(0, Math.round(byCat.get(cat)?.sum_val ?? 0))

    const totalOwnerTasks = sumOf('owner-task')
    const correctionCount = sumOf('owner-correction')
    const repeatRequestCount = sumOf('repeat-request')
    const verifiedPassCount = sumOf('verified-pass')
    const newlyRegressedCount = sumOf('newly-regressed')
    const persistentGapCount = sumOf('persistent-gap')
    const latencyAvg = byCat.get('latency-ms')?.avg_val ?? 0

    const surfacedCount = sumOf('proactive-surfaced')
    const acceptedCount = sumOf('proactive-accepted')
    const annoyedCount = sumOf('proactive-annoyed')
    const selfCapabilityInvocations = sumOf('capability-invocation')

    const totalTokensAllDays = (db.prepare(`
      SELECT COALESCE(SUM(owner_tokens + free_tokens), 0) AS total FROM ray_energy_daily
    `).get() as { total: number }).total

    const selfModel = this.options.getSelfModel()
    return {
      rayHome: this.rayHome,
      generatedAt: atMs,
      energy,
      ownerService: {
        totalOwnerTasks,
        correctionCount,
        correctionRate: ratio(correctionCount, Math.max(1, totalOwnerTasks)),
        repeatRequestCount,
        repeatRequestRate: ratio(repeatRequestCount, Math.max(1, totalOwnerTasks)),
        verifiedPassCount,
        totalTokens: Math.max(0, Math.trunc(totalTokensAllDays)),
        avgLatencyMs: Math.round(latencyAvg),
        newlyRegressedCount,
        persistentGapCount,
      },
      proactiveValue: {
        surfacedCount,
        acceptedCount,
        acceptanceRate: ratio(acceptedCount, Math.max(1, surfacedCount)),
        annoyedCount,
        annoyanceRate: ratio(annoyedCount, Math.max(1, surfacedCount)),
        selfCapabilityInvocations,
      },
      selfGoals: {
        trustLevel: 'low-self-reported',
        note: 'Ray 阶段目标与理想进展自评属于低信任信号，不等同身体内核计算的客观成长证明。',
        ideals: [...selfModel.ideals],
        stageGoals: [...selfModel.stageGoals],
      },
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop()!
      try { fn() } catch { /* ignore */ }
    }
    try { this.db.close() } catch { /* ignore */ }
  }
}
