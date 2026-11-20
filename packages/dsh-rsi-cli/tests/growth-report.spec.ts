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

function initS1AssociationDb(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE assoc_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_plugin TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        owner_scope_key TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE assoc_holdout_assignments (
        task_id TEXT PRIMARY KEY,
        owner_scope_key TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        session_id TEXT,
        turn_number INTEGER,
        in_holdout INTEGER NOT NULL,
        bucket_bps INTEGER NOT NULL,
        rate_bps INTEGER NOT NULL,
        hmac_digest TEXT NOT NULL,
        assigned_at INTEGER NOT NULL
      );
      CREATE TABLE assoc_step_metrics (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        owner_scope_key TEXT NOT NULL,
        in_holdout INTEGER NOT NULL,
        latency_us INTEGER NOT NULL,
        timed_out INTEGER NOT NULL,
        fallback_mode TEXT NOT NULL,
        injected_count INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        source_counts_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE assoc_exposures (
        task_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        owner_scope_key TEXT NOT NULL,
        source_plugin TEXT NOT NULL,
        exposed_at INTEGER NOT NULL,
        assoc_read_count INTEGER NOT NULL DEFAULT 0,
        weak_use_count INTEGER NOT NULL DEFAULT 0,
        corrected INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_id, node_id)
      );
    `)
  } finally {
    db.close()
  }
}

function initS2AssociationDb(path: string): void {
  initS1AssociationDb(path)
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      ALTER TABLE assoc_step_metrics ADD COLUMN profile_version INTEGER;
      ALTER TABLE assoc_exposures ADD COLUMN was_exposed INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE assoc_exposures ADD COLUMN hop INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE assoc_exposures ADD COLUMN score REAL NOT NULL DEFAULT 0.0;
      ALTER TABLE assoc_exposures ADD COLUMN reason TEXT NOT NULL DEFAULT '';
      ALTER TABLE assoc_exposures ADD COLUMN provenance_edges_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE assoc_exposures ADD COLUMN session_id TEXT;
      ALTER TABLE assoc_exposures ADD COLUMN strong_used INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE assoc_exposures ADD COLUMN weak_used INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE assoc_exposures ADD COLUMN hebbian_delta_applied REAL NOT NULL DEFAULT 0.0;
      ALTER TABLE assoc_exposures ADD COLUMN corrected_at INTEGER;
      CREATE TABLE assoc_read_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        node_id TEXT NOT NULL,
        owner_scope_key TEXT NOT NULL,
        hit INTEGER NOT NULL,
        reason TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE assoc_param_profile_heads (
        scope_key TEXT PRIMARY KEY,
        active_version INTEGER NOT NULL,
        latest_version INTEGER NOT NULL,
        active_digest TEXT,
        state TEXT NOT NULL,
        changed_at INTEGER NOT NULL
      );
      CREATE TABLE assoc_param_profile_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_version INTEGER,
        to_version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE assoc_task_telemetry (
        task_id TEXT PRIMARY KEY,
        owner_scope_key TEXT NOT NULL,
        in_holdout INTEGER NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0,
        steps INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd_micros INTEGER,
        updated_at INTEGER NOT NULL
      );
    `)
  } finally {
    db.close()
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
    expect(noDataReport.association.state).toBe('no-data')
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
    expect(zeroReport.association.state).toBe('no-data')
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

  test('association S1 DB compatibility: filters holdout zero-latency rows and returns null for S2-only and missing telemetry fields', async () => {
    const home = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000
    await mkdir(join(home, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'assistant-association'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"private":true}\n')

    // Empty initialized S1 DB -> association.state === 'zero'
    await mkdir(join(home, 'assistant-association'), { recursive: true })
    const assocPath = join(home, 'assistant-association', 'state.sqlite')
    initS1AssociationDb(assocPath)
    const emptyReport = await collectGrowthReport({ dshHome: home, profile: 'web', since: '7d', now })
    expect(emptyReport.overallState).toBe('zero')
    expect(emptyReport.association.state).toBe('zero')
    expect(emptyReport.association.assocReadAttempts).toBeNull()
    expect(emptyReport.association.activeProfileVersion).toBeNull()

    const db = new DatabaseSync(assocPath)
    try {
      const scope = 'a'.repeat(64)
      const hmac = 'b'.repeat(64)
      db.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-mem-1', 'memory', 'personal-memory', 'm1', scope, 'active', '{}', now - day)
      db.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-goal-1', 'goal', 'assistant-goals', 'g1', scope, 'active', '{}', now - day)

      // 1 holdout task + 2 non-holdout tasks (1 injected, 1 uninjected)
      db.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:h1', scope, 'foreground-turn', 's1', 1, 1, 500, 1250, hmac, now - day)
      db.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:i1', scope, 'foreground-turn', 's2', 1, 0, 5000, 1250, hmac, now - day)
      db.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:u1', scope, 'foreground-turn', 's3', 1, 0, 6000, 1250, hmac, now - day)

      // 3 holdout zero-latency placeholders MUST NOT skew p50/p99 or timeout rate
      for (let i = 0; i < 3; i++) {
        db.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run('foreground-turn:h1', scope, 1, 0, 0, 'holdout', 0, 0, '{}', now - day + i)
      }
      // 3 evaluated steps: latencies [1200, 2400, 4800], 1 timeout, 1 cold-start fallback
      db.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:i1', scope, 0, 1200, 0, 'none', 2, 5, JSON.stringify({ memory: 1, goal: 1 }), now - day)
      db.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:i1', scope, 0, 2400, 0, 'cold-start', 0, 0, '{}', now - day + 100)
      db.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:u1', scope, 0, 4800, 1, 'timeout', 0, 2, '{}', now - day + 200)

      // Exposures: 1 strong+weak, 1 unused
      db.prepare('INSERT INTO assoc_exposures VALUES (?,?,?,?,?,?,?,?)')
        .run('foreground-turn:i1', 'n-mem-1', scope, 'personal-memory', now - day, 1, 1, 0)
      db.prepare('INSERT INTO assoc_exposures VALUES (?,?,?,?,?,?,?,?)')
        .run('foreground-turn:i1', 'n-goal-1', scope, 'assistant-goals', now - day, 0, 0, 0)
    } finally {
      db.close()
    }

    const report = await collectGrowthReport({ dshHome: home, profile: 'web', since: '7d', now })
    expect(report.association).toMatchObject({
      state: 'data',
      evaluatedSteps: 3,
      holdoutSteps: 3,
      injectedSteps: 1,
      totalInjectedItems: 2,
      avgInjectedItemsMilli: 667,
      timedOutSteps: 1,
      timeoutRatePpm: 333_333,
      fallbackSteps: 1,
      latencySamples: 3,
      p50LatencyUs: 2400,
      p99LatencyUs: 4800,
      exposuresTotal: 2,
      strongUseExposures: 1,
      weakUseExposures: 1,
      strongUseRatePpm: 500_000,
      weakUseRatePpm: 500_000,
      assocReadAttempts: null,
      assocReadHits: null,
      assocReadHitRatePpm: null,
      activeProfileVersion: null,
      activeProfileDigest: null,
      profileAdoptions: 0,
      profileRollbacks: 0,
      implicitSignals: null,
      evalPool: null,
      skillCandidates: null,
      webLearning: null,
    })
    expect(report.association.holdoutComparison).toEqual({
      nonHoldoutTasks: 2,
      injectedTasks: 1,
      holdoutTasks: 1,
      injected: {
        tasks: 1,
        evaluatedTasks: 0,
        corrections: 0,
        retractions: 0,
        redos: 0,
        correctionRatePpm: null,
        retractionRatePpm: null,
        redoRatePpm: null,
        turnSamples: 0,
        avgTurnsMilli: null,
        costSamples: 0,
        avgCostUsdMicros: null,
        tokenSamples: 0,
        avgInputTokens: null,
        avgOutputTokens: null,
      },
      holdout: {
        tasks: 1,
        evaluatedTasks: 0,
        corrections: 0,
        retractions: 0,
        redos: 0,
        correctionRatePpm: null,
        retractionRatePpm: null,
        redoRatePpm: null,
        turnSamples: 0,
        avgTurnsMilli: null,
        costSamples: 0,
        avgCostUsdMicros: null,
        tokenSamples: 0,
        avgInputTokens: null,
        avgOutputTokens: null,
      },
    })
    const formatted = formatGrowthReport(report)
    expect(formatted).toContain('6. 联想层在线指标与留出对照 [有数据]')
    expect(formatted).toContain('assoc_read 命中率：不可用')
    expect(formatted).toContain('参数档案版本：不可用')
    expect(formatted).not.toContain('S3 进化反馈：')
    expect(formatted).not.toContain('S4 Web 学习：')
  })

  test('association S2 full telemetry: profile isolation, symlink rejection, read events, WP22 profile, and joined holdout comparison', async () => {
    const home = await createTempHome()
    const outside = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000

    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-association'), { recursive: true })
    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-evaluation'), { recursive: true })
    await mkdir(join(home, 'profiles', 'acp'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{"private":true}\n')
    await writeFile(join(home, 'profiles', 'acp', 'package.json'), '{"private":true}\n')

    // Symlinked outside association DB must be rejected with diagnostic
    const outsideAssocPath = join(outside, 'leak-assoc.sqlite')
    initS2AssociationDb(outsideAssocPath)
    await mkdir(join(home, 'assistant-association'), { recursive: true })
    await symlink(outsideAssocPath, join(home, 'assistant-association', 'association.sqlite'))

    const assocPath = join(home, 'assistant-association', 'state.sqlite')
    initS2AssociationDb(assocPath)

    await mkdir(join(home, 'assistant-evaluation'), { recursive: true })
    const evalPath = join(home, 'assistant-evaluation', 'evaluation.sqlite')
    initEmptyEvaluationDb(evalPath)

    // Upgrade evaluation_task_projections + evaluation_owner_revisions with subject_kind/subject_ref & lineage/version
    const evalDb = new DatabaseSync(evalPath)
    try {
      evalDb.exec(`
        DROP TABLE evaluation_task_projections;
        DROP TABLE evaluation_owner_revisions;
        CREATE TABLE evaluation_task_projections (
          subject_key TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_ref TEXT NOT NULL,
          primary_outcome_id TEXT,
          execution_outcome_id TEXT,
          objective_outcome_id TEXT,
          objective_conflicted INTEGER NOT NULL DEFAULT 0,
          learning_disposition TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE evaluation_owner_revisions (
          outcome_id TEXT PRIMARY KEY,
          subject_key TEXT NOT NULL,
          lineage TEXT NOT NULL,
          version INTEGER NOT NULL,
          action TEXT NOT NULL
        );
      `)
      // Injected task 1: achieved, NO cost/tokens in evaluation_outcomes (NULL), has turns in assoc_task_telemetry
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('eo-i1', 's', 'achieved', 'succeeded', 'foreground', 'eval-1', '{}', '[]', null, 300, null, null, 1, now - day, '["s","foreground-turn","inj-1"]')
      evalDb.prepare('INSERT INTO evaluation_task_projections VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('["s","foreground-turn","inj-1"]', 's', 'foreground-turn', 'inj-1', 'eo-i1', 'eo-i1', 'eo-i1', 0, 'upsert', now - day)

      // Injected task 2: had correction v1 superseded by withdraw v2 -> counted as retraction, NOT correction!
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('eo-i2', 's', 'achieved', 'succeeded', 'foreground', 'eval-1', JSON.stringify({ retries: 1, turns: 4 }), '[]', 2500, 400, 300, 120, 2, now - day, '["s","foreground-turn","inj-2"]')
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('rev-i2-1', 's', 'not-achieved', 'succeeded', 'user-feedback', 'owner', '{}', '[]', 0, null, 0, 0, 0, now - day + 1000, '["s","foreground-turn","inj-2"]')
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('rev-i2-2', 's', 'unknown', 'succeeded', 'user-feedback', 'owner', '{}', '[]', 0, null, 0, 0, 0, now - day + 2000, '["s","foreground-turn","inj-2"]')
      evalDb.prepare('INSERT INTO evaluation_task_projections VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('["s","foreground-turn","inj-2"]', 's', 'foreground-turn', 'inj-2', 'eo-i2', 'eo-i2', 'rev-i2-2', 0, 'retract', now - day + 2000)
      evalDb.prepare('INSERT INTO evaluation_owner_revisions VALUES (?,?,?,?,?)')
        .run('rev-i2-1', '["s","foreground-turn","inj-2"]', 'owner-1', 1, 'correct')
      evalDb.prepare('INSERT INTO evaluation_owner_revisions VALUES (?,?,?,?,?)')
        .run('rev-i2-2', '["s","foreground-turn","inj-2"]', 'owner-1', 2, 'withdraw')

      // Holdout task 1: corrected by owner, partial, retries=1
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('eo-h1', 's', 'partial', 'succeeded', 'foreground', 'eval-1', JSON.stringify({ retries: 1 }), '[]', 4000, 500, 500, 200, 3, now - day, '["s","foreground-turn","hold-1"]')
      evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('rev-h1-1', 's', 'partial', 'succeeded', 'user-feedback', 'owner', '{}', '[]', 0, null, 0, 0, 0, now - day + 1000, '["s","foreground-turn","hold-1"]')
      evalDb.prepare('INSERT INTO evaluation_task_projections VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('["s","foreground-turn","hold-1"]', 's', 'foreground-turn', 'hold-1', 'eo-h1', 'eo-h1', 'rev-h1-1', 0, 'retract', now - day + 1000)
      evalDb.prepare('INSERT INTO evaluation_owner_revisions VALUES (?,?,?,?,?)')
        .run('rev-h1-1', '["s","foreground-turn","hold-1"]', 'owner-1', 1, 'correct')
    } finally {
      evalDb.close()
    }

    const assocDb = new DatabaseSync(assocPath)
    try {
      const scope = 'c'.repeat(64)
      const hmac = 'd'.repeat(64)
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-ep-1', 'episode', 'assistant-delivery', 'fg:1', scope, 'active', '{}', now - day)
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-wi-1', 'work-item', 'assistant-work-items', 'wi:1', scope, 'active', '{}', now - day)

      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:inj-1', scope, 'foreground-turn', 's1', 1, 0, 5000, 1250, hmac, now - day)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:inj-2', scope, 'foreground-turn', 's2', 1, 0, 6000, 1250, hmac, now - day)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:hold-1', scope, 'foreground-turn', 's3', 1, 1, 500, 1250, hmac, now - day)
      // Holdout task 2 has NO evaluation row and NO telemetry -> tests null handling
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:hold-2', scope, 'foreground-turn', 's4', 1, 1, 600, 1250, hmac, now - day)

      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:inj-1', scope, 0, 1000, 0, 'none', 2, 4, JSON.stringify({ episode: 1, 'work-item': 1 }), now - day, 2)
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:inj-2', scope, 0, 3000, 0, 'memory-only', 1, 2, JSON.stringify({ episode: 1 }), now - day, 2)
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:hold-1', scope, 1, 0, 0, 'holdout', 0, 0, '{}', now - day, 2)

      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:inj-1', 'n-ep-1', scope, 'assistant-delivery', now - day, 1, 0, 0, 1, 1, 0)
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:inj-1', 'n-wi-1', scope, 'assistant-work-items', now - day, 0, 1, 0, 1, 0, 1)
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:inj-2', 'n-ep-1', scope, 'assistant-delivery', now - day, 0, 1, 1, 1, 0, 1)

      // 3 assoc_read attempts (2 hits, 1 miss) + 1 out-of-window event
      assocDb.prepare('INSERT INTO assoc_read_events (task_id, node_id, owner_scope_key, hit, reason, occurred_at) VALUES (?,?,?,?,?,?)')
        .run('foreground-turn:inj-1', 'n-ep-1', scope, 1, 'ok', now - day)
      assocDb.prepare('INSERT INTO assoc_read_events (task_id, node_id, owner_scope_key, hit, reason, occurred_at) VALUES (?,?,?,?,?,?)')
        .run('foreground-turn:inj-1', 'n-wi-1', scope, 1, 'ok', now - day)
      assocDb.prepare('INSERT INTO assoc_read_events (task_id, node_id, owner_scope_key, hit, reason, occurred_at) VALUES (?,?,?,?,?,?)')
        .run('foreground-turn:inj-2', 'missing', scope, 0, 'not-found', now - day)
      assocDb.prepare('INSERT INTO assoc_read_events (task_id, node_id, owner_scope_key, hit, reason, occurred_at) VALUES (?,?,?,?,?,?)')
        .run('foreground-turn:old', 'n-ep-1', scope, 0, 'policy-denied', now - 30 * day)

      assocDb.prepare('INSERT INTO assoc_param_profile_heads VALUES (?,?,?,?,?,?)')
        .run(scope, 2, 2, 'e'.repeat(64), 'active', now - day)
      assocDb.prepare('INSERT INTO assoc_param_profile_events (scope_key, kind, from_version, to_version, reason, detail_json, occurred_at) VALUES (?,?,?,?,?,?,?)')
        .run(scope, 'adopted', 1, 2, 'tightening', '{}', now - 2 * day)
      assocDb.prepare('INSERT INTO assoc_param_profile_events (scope_key, kind, from_version, to_version, reason, detail_json, occurred_at) VALUES (?,?,?,?,?,?,?)')
        .run(scope, 'rolled-back', 2, 1, 'degradation', '{}', now - day)
      assocDb.prepare('INSERT INTO assoc_param_profile_events (scope_key, kind, from_version, to_version, reason, detail_json, occurred_at) VALUES (?,?,?,?,?,?,?)')
        .run(scope, 'adopted', 0, 1, 'old', '{}', now - 30 * day)

      // Telemetry: inj-1 has turns=2 and NULL cost/tokens (must NOT be fabricated as 0!); hold-1 has turns=3
      assocDb.prepare('INSERT INTO assoc_task_telemetry VALUES (?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:inj-1', scope, 0, 2, 2, null, null, null, now - day)
      assocDb.prepare('INSERT INTO assoc_task_telemetry VALUES (?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:hold-1', scope, 1, 3, 4, null, null, null, now - day)
    } finally {
      assocDb.close()
    }

    // 1. Profile `acp` without assistant-association must NOT leak `desktop` association ledger
    const acpReport = await collectGrowthReport({ dshHome: home, profile: 'acp', since: '7d', now })
    expect(acpReport.association.state).toBe('no-data')

    // 2. Profile `desktop` rejects symlinked association.sqlite and computes S2 metrics accurately
    const report = await collectGrowthReport({ dshHome: home, profile: 'desktop', since: '7d', now })
    expect(report.diagnostics.some(d => d.includes('越界') || d.includes('非普通账本文件'))).toBe(true)
    expect(report.inspectedLedgers).not.toContain(outsideAssocPath)

    expect(report.association).toMatchObject({
      state: 'data',
      evaluatedSteps: 2,
      holdoutSteps: 1,
      injectedSteps: 2,
      totalInjectedItems: 3,
      avgInjectedItemsMilli: 1500,
      timedOutSteps: 0,
      timeoutRatePpm: 0,
      fallbackSteps: 1,
      latencySamples: 2,
      p50LatencyUs: 1000,
      p99LatencyUs: 3000,
      exposuresTotal: 3,
      strongUseExposures: 1,
      weakUseExposures: 2,
      strongUseRatePpm: 333_333,
      weakUseRatePpm: 666_667,
      assocReadAttempts: 3,
      assocReadHits: 2,
      assocReadHitRatePpm: 666_667,
      activeProfileVersion: 2,
      activeProfileDigest: 'e'.repeat(64),
      profileAdoptions: 1,
      profileRollbacks: 1,
    })
    expect(report.association.sources).toEqual([
      {
        source: 'episode',
        injectedItems: 2,
        exposures: 2,
        strongUses: 1,
        weakUses: 1,
        strongUseRatePpm: 500_000,
        weakUseRatePpm: 500_000,
      },
      {
        source: 'work-item',
        injectedItems: 1,
        exposures: 1,
        strongUses: 0,
        weakUses: 1,
        strongUseRatePpm: 0,
        weakUseRatePpm: 1_000_000,
      },
    ])
    expect(report.association.holdoutComparison).toEqual({
      nonHoldoutTasks: 2,
      injectedTasks: 2,
      holdoutTasks: 2,
      injected: {
        tasks: 2,
        evaluatedTasks: 2,
        corrections: 0,
        retractions: 1,
        redos: 1,
        correctionRatePpm: 0,
        retractionRatePpm: 500_000,
        redoRatePpm: 500_000,
        turnSamples: 2,
        avgTurnsMilli: 3000,
        costSamples: 1,
        avgCostUsdMicros: 2500,
        tokenSamples: 1,
        avgInputTokens: 300,
        avgOutputTokens: 120,
      },
      holdout: {
        tasks: 2,
        evaluatedTasks: 1,
        corrections: 1,
        retractions: 1,
        redos: 1,
        correctionRatePpm: 1_000_000,
        retractionRatePpm: 1_000_000,
        redoRatePpm: 1_000_000,
        turnSamples: 1,
        avgTurnsMilli: 3000,
        costSamples: 1,
        avgCostUsdMicros: 4000,
        tokenSamples: 1,
        avgInputTokens: 500,
        avgOutputTokens: 200,
      },
    })

    const formatted = formatGrowthReport(report)
    expect(formatted).toContain('6. 联想层在线指标与留出对照 [有数据]')
    expect(formatted).toContain('assoc_read 命中率：66.7%（2/3）')
    expect(formatted).toContain('参数档案版本：v2 (eeeeeeee) · 窗口采用：1 次 · 回滚：1 次')
    expect(formatted).toContain('来源贡献：episode(注2/强1/弱1) · work-item(注1/强0/弱1)')
    expect(formatted).toContain('留出对照（注入组 2 任务 [非留出总 2] vs 留出组 2 任务）：')
  })

  test('association S2 excludes was_exposed=0 assoc_read rows for holdout and uninjected tasks from exposures, sources, and injectedTasks', async () => {
    const home = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000

    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-association'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{"private":true}\n')
    await mkdir(join(home, 'assistant-association'), { recursive: true })
    const assocPath = join(home, 'assistant-association', 'state.sqlite')
    initS2AssociationDb(assocPath)

    const assocDb = new DatabaseSync(assocPath)
    try {
      const scope = 'a'.repeat(64)
      const hmac = 'b'.repeat(64)
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-ep-1', 'episode', 'assistant-delivery', 'fg:1', scope, 'active', '{}', now - day)
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-ep-2', 'episode', 'assistant-delivery', 'fg:2', scope, 'active', '{}', now - day)
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-wi-1', 'work-item', 'assistant-work-items', 'wi:1', scope, 'active', '{}', now - day)

      // 1 injected non-holdout task, 1 uninjected non-holdout task, 1 holdout task
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:inj-1', scope, 'foreground-turn', 's1', 1, 0, 5000, 1250, hmac, now - day)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:noinj-1', scope, 'foreground-turn', 's2', 1, 0, 6000, 1250, hmac, now - day)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:hold-1', scope, 'foreground-turn', 's3', 1, 1, 500, 1250, hmac, now - day)

      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:inj-1', scope, 0, 1200, 0, 'none', 1, 2, JSON.stringify({ episode: 1 }), now - day, 2)
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:noinj-1', scope, 0, 800, 0, 'none', 0, 0, '{}', now - day, 2)
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:hold-1', scope, 1, 0, 0, 'holdout', 0, 0, '{}', now - day, 2)

      // Legitimate exposed rows on inj-1:
      // - n-ep-1 has strong_used=1
      // - n-ep-2 has assoc_read_count=1, strong_used=0 (must use strong_used column rather than assoc_read_count)
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:inj-1', 'n-ep-1', scope, 'assistant-delivery', now - day, 1, 0, 0, 1, 1, 0)
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:inj-1', 'n-ep-2', scope, 'assistant-delivery', now - day, 1, 0, 0, 1, 0, 0)

      // Unexposed assoc_read rows (was_exposed = 0, assoc_read_count = 1, strong_used = 0):
      // 1. uninjected non-holdout task calling assoc_read
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:noinj-1', 'n-wi-1', scope, 'assistant-work-items', now - day, 1, 0, 0, 0, 0, 0)
      // 2. holdout task calling assoc_read
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:hold-1', 'n-wi-1', scope, 'assistant-work-items', now - day, 1, 0, 0, 0, 0, 0)
    } finally {
      assocDb.close()
    }

    const report = await collectGrowthReport({ dshHome: home, profile: 'desktop', since: '7d', now })
    expect(report.association).toMatchObject({
      state: 'data',
      evaluatedSteps: 2,
      holdoutSteps: 1,
      injectedSteps: 1,
      totalInjectedItems: 1,
      exposuresTotal: 2,
      strongUseExposures: 1,
      weakUseExposures: 0,
      strongUseRatePpm: 500_000,
      weakUseRatePpm: 0,
    })
    expect(report.association.sources).toEqual([
      {
        source: 'episode',
        injectedItems: 1,
        exposures: 2,
        strongUses: 1,
        weakUses: 0,
        strongUseRatePpm: 500_000,
        weakUseRatePpm: 0,
      },
    ])
    expect(report.association.holdoutComparison.nonHoldoutTasks).toBe(2)
    expect(report.association.holdoutComparison.injectedTasks).toBe(1)
    expect(report.association.holdoutComparison.holdoutTasks).toBe(1)
    expect(report.association.holdoutComparison.injected.tasks).toBe(1)
    expect(report.association.holdoutComparison.holdout.tasks).toBe(1)
    expect(report.association.implicitSignals).toBeNull()
    expect(report.association.evalPool).toBeNull()
    expect(report.association.skillCandidates).toBeNull()
    expect(report.association.webLearning).toBeNull()
  })

  test('association Low Radar #6: counts pre-window holdout assignments active in-window and uninjected step-metric non-holdout tasks', async () => {
    const home = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000

    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-association'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{"private":true}\n')
    await mkdir(join(home, 'assistant-association'), { recursive: true })
    const assocPath = join(home, 'assistant-association', 'state.sqlite')
    initS2AssociationDb(assocPath)

    const assocDb = new DatabaseSync(assocPath)
    try {
      const scope = 'a'.repeat(64)
      const hmac = 'b'.repeat(64)
      const preWindowAt = now - 20 * day // outside 7d window [now - 7d, now]

      // Pre-window holdout assignments:
      // 1) pre-hold-step: in_holdout=1, runs in-window step_metrics + telemetry
      // 2) pre-hold-tel-only: in_holdout=1, runs in-window telemetry ONLY
      // 3) pre-inj-step: in_holdout=0, runs in-window step_metrics with injected_count=2
      // 4) pre-noinj-step: in_holdout=0, runs in-window step_metrics with injected_count=0
      // 5) pre-exp-only: in_holdout=0, has in-window assoc_exposures ONLY
      // 6) pre-dormant: in_holdout=1, NO in-window activity (must NOT be counted)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-hold-step', scope, 'foreground-turn', 's1', 1, 1, 500, 1250, hmac, preWindowAt)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-hold-tel-only', scope, 'foreground-turn', 's2', 1, 1, 600, 1250, hmac, preWindowAt)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-inj-step', scope, 'foreground-turn', 's3', 1, 0, 5000, 1250, hmac, preWindowAt)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-noinj-step', scope, 'foreground-turn', 's4', 1, 0, 6000, 1250, hmac, preWindowAt)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-exp-only', scope, 'foreground-turn', 's5', 1, 0, 7000, 1250, hmac, preWindowAt)
      assocDb.prepare('INSERT INTO assoc_holdout_assignments VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-dormant', scope, 'foreground-turn', 's6', 1, 1, 700, 1250, hmac, preWindowAt)

      // Also an in-window step_metrics task with NO assoc_holdout_assignments row at all (in_holdout=0, injected_count=0)
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-hold-step', scope, 1, 0, 0, 'holdout', 0, 0, '{}', now - day, 2)
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-inj-step', scope, 0, 900, 0, 'none', 2, 3, JSON.stringify({ memory: 2 }), now - day, 2)
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-noinj-step', scope, 0, 500, 0, 'none', 0, 0, '{}', now - day, 2)
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:step-only-noinj', scope, 0, 400, 0, 'none', 0, 0, '{}', now - day, 2)

      // Exposure for pre-exp-only
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:pre-exp-only', 'n-mem-1', scope, 'personal-memory', now - day, 1, 0, 0, 1, 1, 0)

      // Telemetry for pre-hold-step (turns=2) and pre-hold-tel-only (turns=4)
      assocDb.prepare('INSERT INTO assoc_task_telemetry VALUES (?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-hold-step', scope, 1, 2, 2, null, null, null, now - day)
      assocDb.prepare('INSERT INTO assoc_task_telemetry VALUES (?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:pre-hold-tel-only', scope, 1, 4, 4, null, null, null, now - day)
    } finally {
      assocDb.close()
    }

    const report = await collectGrowthReport({ dshHome: home, profile: 'desktop', since: '7d', now })
    expect(report.association.holdoutComparison.holdoutTasks).toBe(2) // pre-hold-step + pre-hold-tel-only (NOT pre-dormant)
    expect(report.association.holdoutComparison.nonHoldoutTasks).toBe(4) // pre-inj-step, pre-noinj-step, step-only-noinj, pre-exp-only
    expect(report.association.holdoutComparison.injectedTasks).toBe(2) // pre-inj-step + pre-exp-only
    expect(report.association.holdoutComparison.holdout.tasks).toBe(2)
    expect(report.association.holdoutComparison.holdout.turnSamples).toBe(2)
    expect(report.association.holdoutComparison.holdout.avgTurnsMilli).toBe(3000)
  })

  test('association S3 optional feeds: summarizes assoc_implicit_signals, assoc_eval_pool, and assoc_skill_candidates with hasTable fallback', async () => {
    const home = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000

    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-association'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{"private":true}\n')
    await mkdir(join(home, 'assistant-association'), { recursive: true })
    const assocPath = join(home, 'assistant-association', 'state.sqlite')
    initS2AssociationDb(assocPath)

    const assocDb = new DatabaseSync(assocPath)
    try {
      const scope = 'e'.repeat(64)
      assocDb.exec(`
        CREATE TABLE assoc_implicit_signals (
          id TEXT PRIMARY KEY,
          owner_scope_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          trust TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE assoc_eval_pool (
          task_id TEXT PRIMARY KEY,
          owner_scope_key TEXT NOT NULL,
          pool_kind TEXT NOT NULL CHECK (pool_kind IN ('replay', 'holdout')),
          status TEXT NOT NULL CHECK (status IN ('active', 'retracted')),
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE assoc_skill_candidates (
          id TEXT PRIMARY KEY,
          owner_scope_key TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)

      // Implicit signals: 2 re-ask, 1 redo, 1 owner-correction in window + 1 stale out-of-window
      assocDb.prepare('INSERT INTO assoc_implicit_signals VALUES (?,?,?,?,?)')
        .run('sig-1', scope, 're-ask', 'low', now - day)
      assocDb.prepare('INSERT INTO assoc_implicit_signals VALUES (?,?,?,?,?)')
        .run('sig-2', scope, 're-ask', 'low', now - 2 * day)
      assocDb.prepare('INSERT INTO assoc_implicit_signals VALUES (?,?,?,?,?)')
        .run('sig-3', scope, 'redo', 'low', now - day)
      assocDb.prepare('INSERT INTO assoc_implicit_signals VALUES (?,?,?,?,?)')
        .run('sig-4', scope, 'owner-correction', 'low', now - day)
      assocDb.prepare('INSERT INTO assoc_implicit_signals VALUES (?,?,?,?,?)')
        .run('sig-old', scope, 're-ask', 'low', now - 30 * day)

      // Eval pool: 2 active replay, 1 retracted replay, 1 active holdout, 1 retracted holdout (including older updated_at still active)
      assocDb.prepare('INSERT INTO assoc_eval_pool VALUES (?,?,?,?,?)')
        .run('pool-r1', scope, 'replay', 'active', now - day)
      assocDb.prepare('INSERT INTO assoc_eval_pool VALUES (?,?,?,?,?)')
        .run('pool-r2', scope, 'replay', 'active', now - 20 * day)
      assocDb.prepare('INSERT INTO assoc_eval_pool VALUES (?,?,?,?,?)')
        .run('pool-r3', scope, 'replay', 'retracted', now - day)
      assocDb.prepare('INSERT INTO assoc_eval_pool VALUES (?,?,?,?,?)')
        .run('pool-h1', scope, 'holdout', 'active', now - day)
      assocDb.prepare('INSERT INTO assoc_eval_pool VALUES (?,?,?,?,?)')
        .run('pool-h2', scope, 'holdout', 'retracted', now - day)

      // Skill candidates: 2 pending, 1 staged, 1 adopted, 1 rejected
      assocDb.prepare('INSERT INTO assoc_skill_candidates VALUES (?,?,?,?)')
        .run('cand-1', scope, 'pending', now - day)
      assocDb.prepare('INSERT INTO assoc_skill_candidates VALUES (?,?,?,?)')
        .run('cand-2', scope, 'pending', now - 15 * day)
      assocDb.prepare('INSERT INTO assoc_skill_candidates VALUES (?,?,?,?)')
        .run('cand-3', scope, 'staged', now - day)
      assocDb.prepare('INSERT INTO assoc_skill_candidates VALUES (?,?,?,?)')
        .run('cand-4', scope, 'adopted', now - day)
      assocDb.prepare('INSERT INTO assoc_skill_candidates VALUES (?,?,?,?)')
        .run('cand-5', scope, 'rejected', now - day)
    } finally {
      assocDb.close()
    }

    const report = await collectGrowthReport({ dshHome: home, profile: 'desktop', since: '7d', now })
    expect(report.association.state).toBe('data')
    expect(report.association.implicitSignals).toEqual({
      total: 4,
      reAsk: 2,
      redo: 1,
      ownerCorrection: 1,
    })
    expect(report.association.evalPool).toEqual({
      activeReplay: 2,
      activeHoldout: 1,
    })
    expect(report.association.skillCandidates).toEqual({
      pending: 3,
    })
    expect(report.association.webLearning).toBeNull()

    const formatted = formatGrowthReport(report)
    expect(formatted).toContain('S3 进化反馈：隐式低可信信号：4（重问 2/重做 1/纠正 1） · 生产评估池：回放 2 / 留出 1 · 待处理技能候选：3')
    expect(formatted).not.toContain('S4 Web 学习：')
  })

  test('association S4 webLearning summary & expired assistant-association:web exposure fallback', async () => {
    const home = await createTempHome()
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000

    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-association'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{"private":true}\n')
    await mkdir(join(home, 'assistant-association'), { recursive: true })
    const assocPath = join(home, 'assistant-association', 'state.sqlite')
    initS2AssociationDb(assocPath)

    const assocDb = new DatabaseSync(assocPath)
    try {
      const scope = 'f'.repeat(64)
      assocDb.exec(`
        CREATE TABLE assoc_web_learning_runs (
          run_id TEXT PRIMARY KEY,
          owner_scope_key TEXT NOT NULL,
          status TEXT NOT NULL,
          pages_stored INTEGER NOT NULL DEFAULT 0,
          ran_at INTEGER NOT NULL
        );
        CREATE TABLE assoc_web_learning_budget_usage (
          owner_scope_key TEXT NOT NULL,
          day_key TEXT NOT NULL,
          requests_used INTEGER NOT NULL DEFAULT 0,
          bytes_fetched INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (owner_scope_key, day_key)
        );
      `)

      // 2 active web nodes, 1 withdrawn web node, 1 active memory node
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-web-1', 'web', 'assistant-association:web', 'https://nodejs.org/a', scope, 'active', '{}', now - day)
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-web-2', 'web', 'assistant-association:web', 'https://nodejs.org/b', scope, 'active', '{}', now - day)
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-web-old', 'web', 'assistant-association:web', 'https://nodejs.org/old', scope, 'withdrawn', '{}', now - 2 * day)
      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-mem-1', 'memory', 'personal-memory', 'm1', scope, 'active', '{}', now - day)

      // Step metric injecting 2 web items
      assocDb.prepare('INSERT INTO assoc_step_metrics (task_id, owner_scope_key, in_holdout, latency_us, timed_out, fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at, profile_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('foreground-turn:w1', scope, 0, 900, 0, 'none', 2, 2, JSON.stringify({ web: 2 }), now - day, 3)

      // Exposure 1: active web node n-web-1 (strong use)
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:w1', 'n-web-1', scope, 'assistant-association:web', now - day, 1, 0, 0, 1, 1, 0)
      // Exposure 2: expired/deleted web node (no row in assoc_nodes!) must still map assistant-association:web -> 'web'
      assocDb.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at,
          assoc_read_count, weak_use_count, corrected, was_exposed, strong_used, weak_used
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run('foreground-turn:w1', 'n-web-deleted', scope, 'assistant-association:web', now - day, 0, 1, 0, 1, 0, 1)

      // Runs: 1 completed (2 pages), 1 budget-exhausted (1 page) in window + 1 stale out-of-window
      assocDb.prepare('INSERT INTO assoc_web_learning_runs VALUES (?,?,?,?,?)')
        .run('wr-1', scope, 'completed', 2, now - 2 * day)
      assocDb.prepare('INSERT INTO assoc_web_learning_runs VALUES (?,?,?,?,?)')
        .run('wr-2', scope, 'budget-exhausted', 1, now - day)
      assocDb.prepare('INSERT INTO assoc_web_learning_runs VALUES (?,?,?,?,?)')
        .run('wr-old', scope, 'completed', 5, now - 30 * day)

      // Budget usage: 2 in-window days + 1 stale out-of-window day
      assocDb.prepare('INSERT INTO assoc_web_learning_budget_usage VALUES (?,?,?,?,?)')
        .run(scope, '2026-11-16', 3, 12000, now - 2 * day)
      assocDb.prepare('INSERT INTO assoc_web_learning_budget_usage VALUES (?,?,?,?,?)')
        .run(scope, '2026-11-17', 5, 24000, now - day)
      assocDb.prepare('INSERT INTO assoc_web_learning_budget_usage VALUES (?,?,?,?,?)')
        .run(scope, '2026-10-01', 10, 50000, now - 45 * day)
    } finally {
      assocDb.close()
    }

    const report = await collectGrowthReport({ dshHome: home, profile: 'desktop', since: '7d', now })
    expect(report.association.state).toBe('data')
    expect(report.association.sources).toEqual([
      {
        source: 'web',
        injectedItems: 2,
        exposures: 2,
        strongUses: 1,
        weakUses: 1,
        strongUseRatePpm: 500_000,
        weakUseRatePpm: 500_000,
      },
    ])
    expect(report.association.webLearning).toEqual({
      runs: 2,
      budgetExhaustedRuns: 1,
      storedPages: 3,
      activeWebNodes: 2,
      requestsUsed: 8,
      bytesFetched: 36000,
    })

    const formatted = formatGrowthReport(report)
    expect(formatted).toContain('来源贡献：web(注2/强1/弱1)')
    expect(formatted).toContain('S4 Web 学习：运行 2 次（预算耗尽 1 次） · 入库页面 3 个 · 活跃 Web 节点 2 · 预算使用 8 请求 / 36000 B')
  })

  test('association S4 Schema v4 column alignment (nodes_written, started_at, utc_day)', async () => {
    const home = await createTempHome()
    const now = Date.parse('2026-11-18T12:00:00Z')
    const day = 86_400_000

    await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@dsh-enhanced', 'assistant-association'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{"private":true}\n')
    await mkdir(join(home, 'assistant-association'), { recursive: true })
    const assocPath = join(home, 'assistant-association', 'state.sqlite')
    initS2AssociationDb(assocPath)

    const assocDb = new DatabaseSync(assocPath)
    try {
      const scope = 'e'.repeat(64)
      assocDb.exec(`
        CREATE TABLE assoc_web_learning_runs (
          run_id TEXT PRIMARY KEY,
          owner_scope_key TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          topics_considered INTEGER NOT NULL DEFAULT 0,
          requests_used INTEGER NOT NULL DEFAULT 0,
          pages_fetched INTEGER NOT NULL DEFAULT 0,
          bytes_fetched INTEGER NOT NULL DEFAULT 0,
          nodes_written INTEGER NOT NULL DEFAULT 0,
          details_json TEXT
        ) STRICT;
        CREATE TABLE assoc_web_learning_budget_usage (
          owner_scope_key TEXT NOT NULL,
          utc_day TEXT NOT NULL,
          requests_used INTEGER NOT NULL DEFAULT 0,
          pages_fetched INTEGER NOT NULL DEFAULT 0,
          bytes_fetched INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (owner_scope_key, utc_day)
        ) STRICT, WITHOUT ROWID;
      `)

      assocDb.prepare('INSERT INTO assoc_nodes VALUES (?,?,?,?,?,?,?,?)')
        .run('n-web-v4', 'web', 'assistant-association:web', 'https://nodejs.org/v4', scope, 'active', '{}', now - day)

      assocDb.prepare(`
        INSERT INTO assoc_web_learning_runs (
          run_id, owner_scope_key, started_at, finished_at, status, reason,
          topics_considered, requests_used, pages_fetched, bytes_fetched, nodes_written, details_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run('wr-v4-1', scope, now - day, now - day + 500, 'budget-exhausted', 'budget-exhausted', 2, 4, 3, 9500, 2, null)

      assocDb.prepare(`
        INSERT INTO assoc_web_learning_budget_usage (
          owner_scope_key, utc_day, requests_used, pages_fetched, bytes_fetched
        ) VALUES (?,?,?,?,?)
      `).run(scope, '2026-11-17', 4, 3, 9500)
      assocDb.prepare(`
        INSERT INTO assoc_web_learning_budget_usage (
          owner_scope_key, utc_day, requests_used, pages_fetched, bytes_fetched
        ) VALUES (?,?,?,?,?)
      `).run(scope, '2026-10-01', 99, 50, 99999)
    } finally {
      assocDb.close()
    }

    const report = await collectGrowthReport({ dshHome: home, profile: 'desktop', since: '7d', now })
    expect(report.association.webLearning).toEqual({
      runs: 1,
      budgetExhaustedRuns: 1,
      storedPages: 2,
      activeWebNodes: 1,
      requestsUsed: 4,
      bytesFetched: 9500,
    })
  })
})
