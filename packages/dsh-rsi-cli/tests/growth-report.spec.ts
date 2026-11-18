import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  collectGrowthReport,
  formatGrowthReport,
  parseArgs,
  parseGrowthNow,
  parseGrowthSince,
} from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rsi-growth-report-'))
  tempDirs.push(dir)
  return dir
}

function initEmptyEvaluationDb(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE evaluation_outcomes (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        objective_status TEXT NOT NULL,
        execution_status TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        evaluator_id TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        cost_usd_micros INTEGER,
        latency_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        tool_calls INTEGER,
        occurred_at INTEGER NOT NULL,
        task_subject_key TEXT
      );
      CREATE TABLE evaluation_task_projections (
        subject_key TEXT PRIMARY KEY,
        primary_outcome_id TEXT,
        objective_conflicted INTEGER NOT NULL DEFAULT 0,
        learning_disposition TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE evaluation_owner_revisions (
        outcome_id TEXT PRIMARY KEY,
        subject_key TEXT NOT NULL,
        action TEXT NOT NULL
      );
      CREATE TABLE evaluation_notification_outcome_heads (
        notification_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE evaluation_intake_evaluation_heads (
        eval_id TEXT PRIMARY KEY,
        would_accept INTEGER NOT NULL,
        outcome_kind TEXT NOT NULL,
        evaluated_at INTEGER NOT NULL
      );
    `)
  } finally {
    db.close()
  }
}

function initEmptyMemoryAndPrefDbs(memPath: string, prefPath: string): void {
  const memDb = new DatabaseSync(memPath)
  try {
    memDb.exec(`
      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE memory_promotion_compensations (
        promotion_id TEXT PRIMARY KEY,
        compensated_at INTEGER NOT NULL
      );
    `)
  } finally {
    memDb.close()
  }
  const prefDb = new DatabaseSync(prefPath)
  try {
    prefDb.exec(`
      CREATE TABLE preference_hypotheses (
        id TEXT PRIMARY KEY,
        effect_state TEXT NOT NULL
      );
      CREATE TABLE preference_exposures (
        idempotency_key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        exposed_at INTEGER NOT NULL
      );
      CREATE TABLE preference_exposure_corrections (
        signal_id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE preference_signals (
        id TEXT PRIMARY KEY,
        stance TEXT NOT NULL,
        actor_trust TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE preference_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reason TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
    `)
  } finally {
    prefDb.close()
  }
}

describe('dsh-rsi growth-report', () => {
  test('parseGrowthSince, parseGrowthNow, and parseArgs validate options strictly', () => {
    expect(parseGrowthSince('7d')).toEqual({ spec: '7d', windowMs: 7 * 86_400_000 })
    expect(parseGrowthSince('24h')).toEqual({ spec: '24h', windowMs: 24 * 3_600_000 })
    expect(parseGrowthSince('2w')).toEqual({ spec: '2w', windowMs: 14 * 86_400_000 })
    expect(() => parseGrowthSince('0d')).toThrow(/--since/)
    expect(() => parseGrowthSince('400d')).toThrow(/--since/)
    expect(() => parseGrowthSince('bad')).toThrow(/--since/)

    expect(parseGrowthNow('1763400000000')).toBe(1763400000000)
    expect(parseGrowthNow('2026-11-18T00:00:00Z')).toBe(Date.parse('2026-11-18T00:00:00Z'))
    expect(() => parseGrowthNow('not-a-timestamp')).toThrow(/--now/)

    const parsed = parseArgs(['growth-report', '--since', '14d', '--now', '1763400000000', '--json', '--profile', 'web'])
    expect(parsed.command).toBe('growth-report')
    expect(parsed.since).toBe('14d')
    expect(parsed.nowMs).toBe(1763400000000)
    expect(parsed.json).toBe(true)
    expect(parsed.profile).toBe('web')

    expect(() => parseArgs(['status', '--since', '7d'])).toThrow(/仅适用于 growth-report/)
  })

  test('distinguishes no-data (absent ledgers) from zero (initialized ledgers with 0 events in window)', async () => {
    const missingHome = join(await createTempHome(), 'nonexistent')
    const noDataReport = await collectGrowthReport({ dshHome: missingHome, since: '7d', now: 1_800_000_000_000 })
    expect(noDataReport.overallState).toBe('no-data')
    expect(noDataReport.tasks.state).toBe('no-data')
    expect(noDataReport.memory.state).toBe('no-data')
    expect(noDataReport.candidates.state).toBe('no-data')
    expect(noDataReport.notifications.state).toBe('no-data')
    expect(noDataReport.suppliers.state).toBe('no-data')
    expect(noDataReport.memoryLaneGate.status).toBe('no-data')
    expect(formatGrowthReport(noDataReport)).toContain('无数据（未启用/无账本）')

    const emptyHome = await createTempHome()
    await mkdir(join(emptyHome, 'profiles', 'web'), { recursive: true })
    await mkdir(join(emptyHome, 'assistant-evaluation'), { recursive: true })
    await mkdir(join(emptyHome, 'personal-memory'), { recursive: true })
    await mkdir(join(emptyHome, 'preference-learning'), { recursive: true })
    initEmptyEvaluationDb(join(emptyHome, 'assistant-evaluation', 'evaluation.sqlite'))
    initEmptyMemoryAndPrefDbs(
      join(emptyHome, 'personal-memory', 'memory.sqlite'),
      join(emptyHome, 'preference-learning', 'preferences.sqlite'),
    )

    const zeroReport = await collectGrowthReport({ dshHome: emptyHome, profile: 'web', since: '7d', now: 1_800_000_000_000 })
    expect(zeroReport.overallState).toBe('zero')
    expect(zeroReport.tasks.state).toBe('zero')
    expect(zeroReport.tasks.totalTasks).toBe(0)
    expect(zeroReport.tasks.correctionRatePpm).toBeNull()
    expect(zeroReport.memory.state).toBe('zero')
    expect(zeroReport.candidates.state).toBe('zero')
    expect(zeroReport.notifications.state).toBe('zero')
    expect(zeroReport.suppliers.state).toBe('zero')
    expect(formatGrowthReport(zeroReport)).toContain('0（账本就绪，窗口内无记录）')
  })

  test('aggregates tasks, memory exposure, candidates, notifications, supplier distributions and dogfood gate reproducibly', async () => {
    const home = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await mkdir(join(home, 'assistant-evaluation'), { recursive: true })
    await mkdir(join(home, 'personal-memory'), { recursive: true })
    await mkdir(join(home, 'preference-learning'), { recursive: true })
    await mkdir(join(home, 'plugin-control-plane'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'web', 'cordis.patch.yml'),
      `- id: dsh-enhanced-assistant-evaluation\n  config:\n    databasePath: !!js dshHomePath('assistant-evaluation/custom-eval.sqlite')\n`,
    )

    const evalPath = join(home, 'assistant-evaluation', 'custom-eval.sqlite')
    const memPath = join(home, 'personal-memory', 'memory.sqlite')
    const prefPath = join(home, 'preference-learning', 'preferences.sqlite')
    const cpPath = join(home, 'plugin-control-plane', 'web.sqlite')
    initEmptyEvaluationDb(evalPath)
    initEmptyMemoryAndPrefDbs(memPath, prefPath)

    const evalDb = new DatabaseSync(evalPath)
    try {
      // Previous 14d window [now - 28d, now - 14d): 4 tasks, 3 corrected (75%)
      for (let i = 1; i <= 4; i++) {
        const at = now - 20 * day + i * 1000
        evalDb.prepare(`INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(`prev-${i}`, 's', i <= 3 ? 'not-achieved' : 'achieved', 'succeeded', 'foreground', 'eval-1', '{}', '[]', 1000, 200, 10, 20, 1, at, `prev-subj-${i}`)
        evalDb.prepare(`INSERT INTO evaluation_task_projections VALUES (?,?,?,?,?)`)
          .run(`prev-subj-${i}`, `prev-${i}`, 0, 'upsert', at)
        if (i <= 3) {
          evalDb.prepare(`INSERT INTO evaluation_owner_revisions VALUES (?,?,?)`)
            .run(`prev-${i}`, `prev-subj-${i}`, 'correct')
        }
      }
      // Current 14d window [now - 14d, now]: 10 tasks (6 achieved, 2 partial/corrected, 1 unrated automation retract, 1 owner-withdrawn)
      const latencies = [120, 180, 240, 300, 350, 420, 500, 610, 800, 1200]
      for (let i = 1; i <= 10; i++) {
        const at = now - 10 * day + i * 60_000
        const supplier = i <= 7
          ? { supplier: { provider: 'deepseek', model: 'deepseek-v4' }, retries: i <= 2 ? 1 : 0 }
          : { supplier: { provider: 'traex-agent', model: 'default' }, retries: 0 }
        const objStatus = i <= 2 ? 'partial' : i >= 9 ? 'unknown' : 'achieved'
        const disp = i <= 2 || i >= 9 ? 'retract' : 'upsert'
        evalDb.prepare(`INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            `cur-${i}`, 's', objStatus, 'succeeded', i === 9 ? 'automation' : 'foreground', 'eval-1',
            JSON.stringify(supplier), '[]', i <= 7 ? 2000 : 0, latencies[i - 1]!, 100, 50, 2, at, `cur-subj-${i}`,
          )
        evalDb.prepare(`INSERT INTO evaluation_task_projections VALUES (?,?,?,?,?)`)
          .run(`cur-subj-${i}`, `cur-${i}`, 0, disp, at)
        if (i <= 2) {
          evalDb.prepare(`INSERT INTO evaluation_owner_revisions VALUES (?,?,?)`)
            .run(`cur-${i}`, `cur-subj-${i}`, 'correct')
        } else if (i === 10) {
          evalDb.prepare(`INSERT INTO evaluation_owner_revisions VALUES (?,?,?)`)
            .run(`cur-${i}`, `cur-subj-${i}`, 'withdraw')
        }
      }
      // Notifications & intake agreement
      for (let i = 1; i <= 12; i++) {
        const out = i <= 8 ? 'accepted' : i <= 10 ? 'reacted' : 'expired-unhandled'
        evalDb.prepare(`INSERT INTO evaluation_notification_outcome_heads VALUES (?,?,?)`)
          .run(`notif-${i}`, out, now - 2 * day + i * 1000)
      }
      for (let i = 1; i <= 8; i++) {
        evalDb.prepare(`INSERT INTO evaluation_intake_evaluation_heads VALUES (?,?,?,?)`)
          .run(`eval-${i}`, 1, i <= 6 ? 'agreed' : 'disagreed', now - 2 * day + i * 1000)
      }
    } finally {
      evalDb.close()
    }

    const memDb = new DatabaseSync(memPath)
    try {
      for (let i = 1; i <= 6; i++) {
        memDb.prepare(`INSERT INTO memory_records VALUES (?,?,?,?,?)`)
          .run(`mem-${i}`, 'active', JSON.stringify({ source: `turn-${i}` }), now - 5 * day + i * 1000, now - 5 * day + i * 1000)
      }
      memDb.prepare(`INSERT INTO memory_records VALUES (?,?,?,?,?)`)
        .run('mem-removed', 'removed', '{}', now - 4 * day, now - 3 * day)
    } finally {
      memDb.close()
    }

    const prefDb = new DatabaseSync(prefPath)
    try {
      prefDb.prepare(`INSERT INTO preference_hypotheses VALUES ('h1', 'active'), ('h2', 'active')`).run()
      for (let i = 1; i <= 6; i++) {
        prefDb.prepare(`INSERT INTO preference_exposures VALUES (?, 'bound', ?)`).run(`exp-${i}`, now - 3 * day + i * 1000)
      }
      prefDb.prepare(`INSERT INTO preference_exposure_corrections VALUES ('sig-post-1', ?)`).run(now - 1 * day)
      for (let i = 1; i <= 8; i++) {
        prefDb.prepare(`INSERT INTO preference_signals VALUES (?, 'contradict', 'owner-authenticated', ?)`)
          .run(`sig-${i}`, now - 12 * day + i * 1000)
      }
      prefDb.prepare(`INSERT INTO preference_transitions(reason, occurred_at) VALUES ('created', ?), ('activated', ?)`)
        .run(now - 6 * day, now - 5 * day)
    } finally {
      prefDb.close()
    }

    const cpDb = new DatabaseSync(cpPath)
    try {
      cpDb.exec(`
        CREATE TABLE activation_plans (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO activation_plans VALUES ('p1', 'activated', ${now - 2 * day}), ('p2', 'rolled-back', ${now - 1 * day});
      `)
    } finally {
      cpDb.close()
    }

    const first = await collectGrowthReport({ dshHome: home, profile: 'web', since: '14d', now })
    const second = await collectGrowthReport({ dshHome: home, profile: 'web', since: '14d', now })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))

    expect(first.overallState).toBe('data')
    expect(first.tasks).toMatchObject({
      state: 'data',
      totalTasks: 10,
      achieved: 6,
      partial: 2,
      ownerCorrections: 2,
      ownerWithdrawals: 1,
      reworkTasks: 2,
      correctionRatePpm: 200_000,
      previousCorrectionRatePpm: 750_000,
      trend: 'improving',
    })
    expect(first.memory).toMatchObject({
      state: 'data',
      activeMemoriesTotal: 6,
      newMemories: 7,
      sourcedMemories: 6,
      withdrawnOrRemovedMemories: 1,
      activePreferenceOverlays: 2,
      promptExposures: 6,
      postExposureSameClassCorrections: 1,
      sameClassCorrectionTrend: 'reduced',
    })
    expect(first.candidates).toMatchObject({
      state: 'data',
      generated: 3,
      verificationPassed: 2,
      adopted: 2,
      rolledBack: 1,
    })
    expect(first.notifications).toMatchObject({
      state: 'data',
      total: 12,
      delivered: 12,
      accepted: 8,
      reacted: 2,
      ignoredOrExpired: 2,
      wouldAcceptTotal: 8,
      agreementDecided: 8,
      agreementAgreed: 6,
      agreementDisagreed: 2,
      agreementPpm: 750_000,
    })
    expect(first.suppliers.suppliers).toEqual([
      expect.objectContaining({ supplier: 'deepseek/deepseek-v4', runs: 7, costUsdMicros: 14_000, p50LatencyMs: 300 }),
      expect.objectContaining({ supplier: 'traex-agent/default', runs: 3, costUsdMicros: 0, p95LatencyMs: 1200 }),
    ])
    expect(first.memoryLaneGate.status).toBe('passed')
  })

  test('isolates explicit --profile reports, rejects symlink/out-of-bounds ledgers, deduplicates withdrawn corrections, prevents post-exposure tautology, and filters candidates by window', async () => {
    const home = await createTempHome()
    const outside = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000

    // Real profiles anchored by package.json: `desktop` has RSI plugins, `acp` has none.
    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-evaluation'), { recursive: true })
    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'preference-learning'), { recursive: true })
    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-skills'), { recursive: true })
    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-growth-driver'), { recursive: true })
    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-evolution'), { recursive: true })
    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-growth-experiments'), { recursive: true })
    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-memory-learning'), { recursive: true })
    await mkdir(join(home, 'profiles', 'acp'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{"private":true}\n')
    await writeFile(join(home, 'profiles', 'acp', 'package.json'), '{"private":true}\n')

    // Out-of-bounds dshHomePath('../../outside.sqlite') must be rejected with diagnostic
    await writeFile(
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      `- id: dsh-enhanced-personal-memory\n  config:\n    databasePath: !!js dshHomePath('../../outside.sqlite')\n`,
    )
    const outsideDbPath = join(outside, 'outside.sqlite')
    initEmptyMemoryAndPrefDbs(outsideDbPath, join(outside, 'unused-pref.sqlite'))

    await mkdir(join(home, 'assistant-evaluation'), { recursive: true })
    await mkdir(join(home, 'preference-learning'), { recursive: true })
    await mkdir(join(home, 'assistant-skills'), { recursive: true })
    await mkdir(join(home, 'assistant-growth-driver'), { recursive: true })
    await mkdir(join(home, 'assistant-evolution'), { recursive: true })
    await mkdir(join(home, 'assistant-growth-experiments'), { recursive: true })
    await mkdir(join(home, 'assistant-memory-learning'), { recursive: true })

    const evalPath = join(home, 'assistant-evaluation', 'evaluation.sqlite')
    const prefPath = join(home, 'preference-learning', 'preferences.sqlite')
    initEmptyEvaluationDb(evalPath)
    initEmptyMemoryAndPrefDbs(join(outside, 'unused-mem.sqlite'), prefPath)

    // Add lineage+version to evaluation_owner_revisions to test correction -> withdrawal superseding
    const evalDb = new DatabaseSync(evalPath)
    try {
      evalDb.exec('DROP TABLE evaluation_owner_revisions')
      evalDb.exec(`
        CREATE TABLE evaluation_owner_revisions (
          outcome_id TEXT PRIMARY KEY,
          subject_key TEXT NOT NULL,
          lineage TEXT NOT NULL,
          version INTEGER NOT NULL,
          action TEXT NOT NULL
        );
      `)
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('t1', 's', 'achieved', 'succeeded', 'foreground', 'eval-1', '{}', '[]', 0, 100, 10, 10, 0, now - 3 * day, 'subj-1')
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('rev-1', 's', 'not-achieved', 'succeeded', 'user-feedback', 'owner', '{}', '[]', 0, null, 0, 0, 0, now - 2 * day, 'subj-1')
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('rev-2', 's', 'unknown', 'succeeded', 'user-feedback', 'owner', '{}', '[]', 0, null, 0, 0, 0, now - 1 * day, 'subj-1')
      evalDb.prepare('INSERT INTO evaluation_task_projections VALUES (?,?,?,?,?)')
        .run('subj-1', null, 0, 'retract', now - 1 * day)
      evalDb.prepare('INSERT INTO evaluation_owner_revisions VALUES (?,?,?,?,?)')
        .run('rev-1', 'subj-1', 'owner-1', 1, 'correct')
      evalDb.prepare('INSERT INTO evaluation_owner_revisions VALUES (?,?,?,?,?)')
        .run('rev-2', 'subj-1', 'owner-1', 2, 'withdraw')
    } finally {
      evalDb.close()
    }

    // Preference learning: 1 true pre-exposure contradiction + 6 bound exposures ALL contradicted (6 post signals in BOTH tables!)
    const prefDb = new DatabaseSync(prefPath)
    try {
      prefDb.prepare("INSERT INTO preference_signals VALUES ('pre-1', 'contradict', 'owner-authenticated', ?)").run(now - 10 * day)
      for (let i = 1; i <= 6; i++) {
        prefDb.prepare("INSERT INTO preference_exposures VALUES (?, 'bound', ?)").run(`exp-${i}`, now - 4 * day + i * 1000)
        prefDb.prepare("INSERT INTO preference_signals VALUES (?, 'contradict', 'owner-authenticated', ?)").run(`post-${i}`, now - 2 * day + i * 1000)
        prefDb.prepare('INSERT INTO preference_exposure_corrections VALUES (?, ?)').run(`post-${i}`, now - 2 * day + i * 1000)
      }
    } finally {
      prefDb.close()
    }

    // Candidates: real usage_jobs('reviewed'), real skill_comparisons(result.qualified=true), stale 60d-old memory-learning job, evolution & workflow_candidates
    const gdDb = new DatabaseSync(join(home, 'assistant-growth-driver', 'usage.sqlite'))
    try {
      gdDb.exec('CREATE TABLE usage_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, intent_json TEXT NOT NULL)')
      gdDb.prepare('INSERT INTO usage_jobs VALUES (?, ?, ?)').run('uj-1', 'reviewed', JSON.stringify({ occurredAt: now - 2 * day }))
      gdDb.prepare('INSERT INTO usage_jobs VALUES (?, ?, ?)').run('uj-old', 'reviewed', JSON.stringify({ occurredAt: now - 60 * day }))
    } finally {
      gdDb.close()
    }

    const skDb = new DatabaseSync(join(home, 'assistant-skills', 'skills.sqlite'))
    try {
      skDb.exec(`
        CREATE TABLE skill_candidates (scope_key TEXT NOT NULL, id TEXT NOT NULL, candidate_json TEXT NOT NULL);
        CREATE TABLE skill_comparisons (scope_key TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, comparison_json TEXT NOT NULL);
      `)
      skDb.prepare('INSERT INTO skill_candidates VALUES (?, ?, ?)').run('s', 'sc-1', JSON.stringify({ id: 'sc-1', state: 'pending', createdAt: now - 2 * day, updatedAt: now - 2 * day }))
      skDb.prepare('INSERT INTO skill_comparisons VALUES (?, ?, ?, ?)').run('s', 'cmp-1', 'complete', JSON.stringify({
        id: 'cmp-1',
        state: 'complete',
        result: { qualified: true, admissionDigest: 'a'.repeat(64) },
        createdAt: now - 2 * day,
        updatedAt: now - 2 * day,
      }))
    } finally {
      skDb.close()
    }

    const mlDb = new DatabaseSync(join(home, 'assistant-memory-learning', 'state.sqlite'))
    try {
      mlDb.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, intent_json TEXT NOT NULL)')
      mlDb.prepare('INSERT INTO jobs VALUES (?, ?, ?)').run('ml-stale', 'adopted', JSON.stringify({ createdAt: now - 60 * day }))
    } finally {
      mlDb.close()
    }

    const evoDb = new DatabaseSync(join(home, 'assistant-evolution', 'evolution.sqlite'))
    try {
      evoDb.exec(`
        CREATE TABLE evolution_proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE evolution_rules (id TEXT PRIMARY KEY, adopted_at INTEGER NOT NULL);
        CREATE TABLE evolution_autonomous_rollbacks (idempotency_key TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL);
      `)
      evoDb.prepare('INSERT INTO evolution_proposals VALUES (?, ?, ?)').run('ep-1', 'approved', now - 2 * day)
      evoDb.prepare('INSERT INTO evolution_rules VALUES (?, ?)').run('er-1', now - 2 * day)
      evoDb.prepare('INSERT INTO evolution_autonomous_rollbacks VALUES (?, ?)').run('erb-1', now - 1 * day)
    } finally {
      evoDb.close()
    }

    const geDb = new DatabaseSync(join(home, 'assistant-growth-experiments', 'growth.sqlite'))
    try {
      geDb.exec('CREATE TABLE workflow_candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL)')
      geDb.prepare('INSERT INTO workflow_candidates VALUES (?, ?, ?)').run('wc-1', 'promoted', now - 2 * day)
    } finally {
      geDb.close()
    }

    // 1. Empty profile `acp` must NOT leak `desktop`'s ledgers
    const acpReport = await collectGrowthReport({ dshHome: home, profile: 'acp', since: '14d', now })
    expect(acpReport.overallState).toBe('no-data')
    expect(acpReport.inspectedLedgers).toEqual([])

    // 2. Profile `desktop` reports accurate deductions
    const desktopReport = await collectGrowthReport({ dshHome: home, profile: 'desktop', since: '14d', now })
    expect(desktopReport.diagnostics.some(d => d.includes('越界'))).toBe(true)
    expect(desktopReport.inspectedLedgers).not.toContain(outsideDbPath)
    expect(desktopReport.tasks).toMatchObject({
      totalTasks: 1,
      ownerCorrections: 0,
      ownerWithdrawals: 1,
    })
    // 6/6 post-exposure contradictions vs 1 true pre-exposure contradiction => increased, NOT reduced!
    expect(desktopReport.memory).toMatchObject({
      promptExposures: 6,
      preExposureContradictions: 1,
      postExposureSameClassCorrections: 6,
      sameClassCorrectionTrend: 'increased',
    })
    expect(desktopReport.memoryLaneGate.status).toBe('collecting')
    // Candidates: uj-1(1 gen, 1 pass) + sc-1(1 gen) + cmp-1(1 pass) + ep-1(1 gen, 1 pass) + er-1(1 adopt) + erb-1(1 rb) + wc-1(1 gen, 1 pass, 1 adopt); stale 60d rows excluded!
    expect(desktopReport.candidates).toMatchObject({
      state: 'data',
      generated: 4,
      verificationPassed: 4,
      verificationFailed: 0,
      adopted: 2,
      rolledBack: 1,
    })
  })

  test('supports legacy v4 evaluation_task_projections, control-plane statePath multi-ledger adoptions/rollbacks, and blocks directory symlinks escaping $DSH_HOME', async () => {
    const home = await createTempHome()
    const outside = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000

    await mkdir(join(home, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'assistant-evaluation'), { recursive: true })
    await mkdir(join(home, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'plugin-control-plane'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"private":true}\n')

    // Symlinked personal-memory directory escaping $DSH_HOME must be rejected
    await mkdir(join(outside, 'secret-memory'), { recursive: true })
    initEmptyMemoryAndPrefDbs(join(outside, 'secret-memory', 'memory.sqlite'), join(outside, 'unused-pref.sqlite'))
    const secretMemDb = new DatabaseSync(join(outside, 'secret-memory', 'memory.sqlite'))
    try {
      secretMemDb.prepare('INSERT INTO memory_records VALUES (?,?,?,?,?)').run('leak-1', 'active', '{"src":"leak"}', now - day, now - day)
    } finally {
      secretMemDb.close()
    }
    await symlink(join(outside, 'secret-memory'), join(home, 'personal-memory'))

    // Legacy v4 evaluation_task_projections (NO learning_disposition column, NO split outcome refs)
    await mkdir(join(home, 'assistant-evaluation'), { recursive: true })
    const evalDb = new DatabaseSync(join(home, 'assistant-evaluation', 'evaluation.sqlite'))
    try {
      evalDb.exec(`
        CREATE TABLE evaluation_outcomes (
          id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          objective_status TEXT NOT NULL,
          execution_status TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          evaluator_id TEXT NOT NULL,
          metrics_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          cost_usd_micros INTEGER,
          latency_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          tool_calls INTEGER,
          occurred_at INTEGER NOT NULL,
          task_subject_key TEXT
        );
        CREATE TABLE evaluation_task_projections (
          subject_key TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_ref TEXT NOT NULL,
          primary_outcome_id TEXT,
          objective_conflicted INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
      `)
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('v4-out-1', 's', 'achieved', 'succeeded', 'foreground', 'eval-v4', '{"retries":1}', '[]', 500, 150, 20, 30, 1, now - 2 * day, 'v4-subj-1')
      evalDb.prepare('INSERT INTO evaluation_task_projections VALUES (?,?,?,?,?,?,?)')
        .run('v4-subj-1', 's', 'outcome', 'v4-out-1', 'v4-out-1', 0, now - 2 * day)
    } finally {
      evalDb.close()
    }

    // Control-plane statePath with control.sqlite + creation-adoptions.sqlite + revision-adoptions.sqlite
    const cpStateDir = join(home, 'custom-cp-state')
    await mkdir(cpStateDir, { recursive: true })
    await writeFile(
      join(home, 'profiles', 'web', 'cordis.patch.yml'),
      [
        '- id: dsh-enhanced-plugin-control-plane',
        '  config:',
        `    statePath: ${cpStateDir}`,
        '- id: dsh-enhanced-personal-memory',
        '  config:',
        `    databasePath: ${join(outside, 'secret-memory', 'memory.sqlite')}`,
      ].join('\n') + '\n',
    )

    const controlDb = new DatabaseSync(join(cpStateDir, 'control.sqlite'))
    try {
      controlDb.exec(`
        CREATE TABLE source_plans (id TEXT PRIMARY KEY, status TEXT NOT NULL, checked_tree_digest TEXT, updated_at INTEGER NOT NULL);
        CREATE TABLE activation_plans (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
      `)
      controlDb.prepare('INSERT INTO source_plans VALUES (?,?,?,?)').run('sp-1', 'ready-for-human-review', 'a'.repeat(64), now - 2 * day)
      controlDb.prepare('INSERT INTO activation_plans VALUES (?,?,?)').run('ap-1', 'activated', now - 2 * day)
    } finally {
      controlDb.close()
    }

    const creationDb = new DatabaseSync(join(cpStateDir, 'creation-adoptions.sqlite'))
    try {
      creationDb.exec('CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, receipt_json TEXT)')
      creationDb.prepare('INSERT INTO adoptions VALUES (?,?,?)')
        .run('ca-1', 'active', JSON.stringify({ adoptedAt: now - day }))
      creationDb.prepare('INSERT INTO adoptions VALUES (?,?,?)')
        .run('ca-2', 'rejected', JSON.stringify({ issuedAt: now - day }))
      creationDb.prepare('INSERT INTO adoptions VALUES (?,?,?)')
        .run('ca-old', 'active', JSON.stringify({ adoptedAt: now - 60 * day }))
    } finally {
      creationDb.close()
    }

    const revisionDb = new DatabaseSync(join(cpStateDir, 'revision-adoptions.sqlite'))
    try {
      revisionDb.exec(`
        CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, claimed_at INTEGER NOT NULL, settled_at INTEGER);
        CREATE TABLE rollbacks (seq INTEGER PRIMARY KEY, rollback_id TEXT NOT NULL, at INTEGER NOT NULL);
      `)
      revisionDb.prepare('INSERT INTO adoptions VALUES (?,?,?,?)').run('ra-1', 'closed', now - 3 * day, now - 2 * day)
      revisionDb.prepare('INSERT INTO rollbacks VALUES (?,?,?)').run(1, 'rb-1', now - day)
    } finally {
      revisionDb.close()
    }

    const report = await collectGrowthReport({ dshHome: home, profile: 'web', since: '14d', now })
    expect(report.diagnostics.some(d => d.includes('越界'))).toBe(true)
    expect(report.memory.activeMemoriesTotal).toBe(0)
    expect(report.tasks).toMatchObject({
      state: 'data',
      totalTasks: 1,
      achieved: 1,
      reworkTasks: 1,
    })
    expect(report.candidates).toMatchObject({
      state: 'data',
      generated: 2,
      verificationPassed: 2,
      verificationFailed: 1,
      adopted: 2,
      rolledBack: 1,
    })

    // Symlinked DSH_HOME alias + intra-home directory alias deduplication (no false out-of-bounds rejection, no double-counting)
    const homeAlias = join(outside, 'home-alias')
    await symlink(home, homeAlias)
    await symlink(cpStateDir, join(home, 'plugin-control-plane'))
    await writeFile(
      join(home, 'profiles', 'web', 'cordis.patch.yml'),
      [
        '- id: dsh-enhanced-plugin-control-plane',
        '  config:',
        `    statePath: ${await realpath(cpStateDir)}`,
      ].join('\n') + '\n',
    )
    const aliasedReport = await collectGrowthReport({ dshHome: homeAlias, profile: 'web', since: '14d', now })
    expect(aliasedReport.diagnostics.some(d => d.includes('越界'))).toBe(false)
    expect(aliasedReport.candidates).toMatchObject({
      state: 'data',
      generated: 2,
      verificationPassed: 2,
      verificationFailed: 1,
      adopted: 2,
      rolledBack: 1,
    })
  })
})
