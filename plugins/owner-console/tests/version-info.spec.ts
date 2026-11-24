import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { formatOwnerConsoleVersionSummary, parseOwnerSelfIterationCommand, parseOwnerVersionQuery } from '../src/nl-control.ts'
import type { OwnerConsoleService } from '../src/service.ts'
import { OwnerConsoleVersionReportSchema, TYPERT } from '../src/typert.ts'
import { collectOwnerConsoleVersionInfo } from '../src/version-info.ts'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function createSqlite(path: string, sql: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

describe('owner-console version query parser & formatter', () => {
  it('matches slash commands and concise Chinese/English version & iteration queries while rejecting prose and mutating controls', () => {
    expect(parseOwnerVersionQuery('/version')?.intent).toBe('slash')
    expect(parseOwnerVersionQuery('/version --short')?.intent).toBe('slash')
    expect(parseOwnerVersionQuery('/autonomy version')?.intent).toBe('slash')
    expect(parseOwnerVersionQuery('  /AUTONOMY   VERSION ')?.intent).toBe('slash')

    for (const phrase of [
      '查看版本',
      '查看版本。',
      '版本信息？',
      '当前版本?',
      '助手版本！',
      'assistant version',
      'Current Version?',
    ]) {
      expect(parseOwnerVersionQuery(phrase)?.intent).toBe('version')
    }

    for (const phrase of [
      '查看自迭代次数',
      '自迭代次数？',
      '自己迭代了多少次？',
      '迭代了多少次?',
      '进化了多少次',
      'self-iteration count',
      'Self Iteration Count?',
    ]) {
      expect(parseOwnerVersionQuery(phrase)?.intent).toBe('selfIterationCount')
    }

    for (const nonMatch of [
      '',
      '   ',
      '今天北京天气怎么样？',
      '为什么版本升级会失败？',
      '当前版本有哪些已知 bug 吗？',
      '查看版本，顺便帮我写代码',
      '开启自迭代',
      '关闭自迭代',
      '升级整体助手',
      '/autonomy enable',
      '/autonomy disable',
      '/autonomy upgrade',
    ]) {
      expect(parseOwnerVersionQuery(nonMatch)).toBeUndefined()
    }

    // Strict mutual exclusion with parseOwnerSelfIterationCommand
    for (const sample of [
      '/version',
      '/autonomy version',
      '查看版本',
      '自己迭代了多少次？',
      '开启自迭代',
      '关闭自迭代',
      '升级整体助手',
    ]) {
      const asVersion = parseOwnerVersionQuery(sample)
      const asControl = parseOwnerSelfIterationCommand(sample)
      expect(Boolean(asVersion && asControl)).toBe(false)
    }
  })
})

describe('collectOwnerConsoleVersionInfo & OwnerConsoleService.versionInfo', () => {
  const prevDshHome = process.env['DSH_HOME']

  afterEach(() => {
    if (prevDshHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = prevDshHome
    for (const dir of tempDirs.splice(0)) {
      try { chmodSync(dir, 0o700) } catch { /* ignore */ }
      try {
        // Restore permissions on nested read-only test dirs before cleanup
        for (const sub of ['plugin-control-plane', 'ro-dir']) {
          try { chmodSync(join(dir, sub), 0o700) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns no-data with null counters when no explicit DSH_HOME or services exist (never leaks ~/.dsh)', async () => {
    delete process.env['DSH_HOME']
    const emptyCtx = new Context()
    const report = await collectOwnerConsoleVersionInfo(emptyCtx, { now: 1_700_000_000_000 })
    expect(OwnerConsoleVersionReportSchema.parse(report)).toEqual(report)
    expect(report.protocol).toBe('dsh-rsi/version/v1')
    expect(report.schemaVersion).toBe(1)
    expect(report.dshHome).toBeNull()
    expect(report.plugins.state).toBe('unavailable')
    expect(report.selfIteration.dataState).toBe('no-data')
    expect(report.selfIteration.totalIterations).toBeNull()
    expect(report.selfIteration.workItemsTotal).toBeNull()
    expect(report.selfIteration.pluginsCreated).toBeNull()
    expect(report.selfIteration.selfUpgrades).toBeNull()

    const summary = formatOwnerConsoleVersionSummary(report)
    expect(summary).toContain('no-data')
    expect(summary).toContain('无账本数据')
  })

  it('returns dataState=zero when ledgers exist with 0 rows and no upgrades', async () => {
    const home = makeTempDir('oc-version-zero-')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    createSqlite(
      join(home, 'assistant-work-items', 'state.sqlite'),
      'CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT); CREATE TABLE work_item_outcome (item_id TEXT, revision INTEGER, PRIMARY KEY (item_id, revision));',
    )
    createSqlite(
      join(home, 'plugin-control-plane', 'control.sqlite'),
      'CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT, mode TEXT, status TEXT); CREATE TABLE activation_plans (id TEXT PRIMARY KEY, profile TEXT, status TEXT);',
    )
    mkdirSync(join(home, '.dsh-rsi-upgrade-backups'), { recursive: true })
    mkdirSync(join(home, '.dsh-enhanced'), { recursive: true })
    writeFileSync(join(home, '.dsh-enhanced', 'upgrade-history.jsonl'), '', 'utf8')

    const ctx = new Context()
    ctx.provide('profileContext' as never, { home, dir: join(home, 'profiles', 'web'), name: 'web' } as never)
    ctx.provide('pluginManager' as never, { listBundles: async () => [], listPlugins: async () => [] } as never)

    const report = await collectOwnerConsoleVersionInfo(ctx, { now: 1_700_000_000_100 })
    expect(OwnerConsoleVersionReportSchema.parse(report)).toEqual(report)
    expect(report.plugins.state).toBe('zero')
    expect(report.selfIteration.dataState).toBe('zero')
    expect(report.selfIteration.totalIterations).toBe(0)
    expect(report.selfIteration.workItemsTotal).toBe(0)
    expect(report.selfIteration.workItemsSettled).toBe(0)
    expect(report.selfIteration.pluginsCreated).toBe(0)
    expect(report.selfIteration.pluginsRevised).toBe(0)
    expect(report.selfIteration.selfUpgrades).toBe(0)
    expect(report.selfIteration.backupSnapshotsCount).toBe(0)
    expect(formatOwnerConsoleVersionSummary(report)).toContain('zero')
  })

  it('aggregates all read-only SQLite ledgers without lifecycle double-counting, separates core vs evolved plugins, and enforces symlink boundaries', async () => {
    const home = makeTempDir('oc-version-data-')
    const outsideDir = makeTempDir('oc-version-outside-')
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(join(profileDir, 'node_modules', '@dsh-enhanced', 'owner-console'), { recursive: true })

    // .dsh-rsi-host.json (0600 regular file)
    writeFileSync(
      join(home, '.dsh-rsi-host.json'),
      JSON.stringify({ schemaVersion: 1, version: '0.2.2-rc.5', cacheRoot: join(home, 'cache'), receiptDigest: 'a'.repeat(64) }),
      { encoding: 'utf8', mode: 0o600 },
    )

    // Symlink escape attempt that MUST be skipped and diagnosed
    createSqlite(join(outsideDir, 'evil.sqlite'), "CREATE TABLE dream_runs (id TEXT PRIMARY KEY); INSERT INTO dream_runs VALUES ('evil');")
    mkdirSync(join(home, 'assistant-dreaming'), { recursive: true })
    symlinkSync(join(outsideDir, 'evil.sqlite'), join(home, 'assistant-dreaming', 'state.sqlite'))

    // 1. plugin-control-plane (plan p1 created across source_plans + creation-adoptions + activation_plans -> counted ONCE!)
    createSqlite(
      join(home, 'plugin-control-plane', 'control.sqlite'),
      `
      CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT, mode TEXT, status TEXT);
      CREATE TABLE activation_plans (id TEXT PRIMARY KEY, profile TEXT, status TEXT);
      CREATE TABLE activation_watch (plan_id TEXT PRIMARY KEY, package_name TEXT, package_version TEXT, state TEXT);
      INSERT INTO source_plans VALUES ('p-create-1', '@dsh-enhanced/evolved-alpha', 'create', 'release-complete');
      INSERT INTO source_plans VALUES ('p-rev-1', '@dsh-enhanced/evolved-alpha', 'modify', 'release-complete');
      INSERT INTO source_plans VALUES ('p-draft-1', '@dsh-enhanced/evolved-beta', 'create', 'draft');
      INSERT INTO activation_plans VALUES ('p-create-1', 'web', 'activated');
      INSERT INTO activation_plans VALUES ('p-rb-1', 'web', 'rolled-back');
      INSERT INTO activation_watch VALUES ('p-create-1', '@dsh-enhanced/evolved-alpha', '1.2.0', 'watching');
      `,
    )
    createSqlite(
      join(home, 'plugin-control-plane', 'creation-adoptions.sqlite'),
      `
      CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, certificate_json TEXT, receipt_json TEXT);
      INSERT INTO adoptions VALUES (
        'p-create-1',
        'active',
        '{"plan":{"name":"@dsh-enhanced/evolved-alpha"}}',
        '{"version":"1.2.0"}'
      );
      INSERT INTO adoptions VALUES (
        'p-create-closed',
        'closed',
        '{"plan":{"name":"@dsh-enhanced/evolved-retired"}}',
        '{"version":"0.9.0"}'
      );
      `,
    )
    createSqlite(
      join(home, 'plugin-control-plane', 'revision-adoptions.sqlite'),
      `
      CREATE TABLE entries (entry_id TEXT PRIMARY KEY, name TEXT, current_plan_id TEXT, revision INTEGER);
      CREATE TABLE versions (plan_id TEXT PRIMARY KEY, entry_id TEXT, role TEXT, certificate_json TEXT);
      CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, entry_id TEXT);
      CREATE TABLE rollbacks (seq INTEGER PRIMARY KEY, rollback_id TEXT, entry_id TEXT, from_plan_id TEXT, to_plan_id TEXT, at INTEGER);
      INSERT INTO entries VALUES ('e1', '@dsh-enhanced/evolved-alpha', 'p-rev-1', 2);
      INSERT INTO versions VALUES ('p-rev-1', 'e1', 'revision', '{}');
      INSERT INTO adoptions VALUES ('p-rev-1', 'active', 'e1');
      INSERT INTO rollbacks VALUES (1, 'rb-1', 'e1', 'p-rev-0', 'p-create-1', 1000);
      `,
    )

    // 2. assistant-work-items (1 item with 2 outcome revisions -> settled = 1)
    createSqlite(
      join(home, 'assistant-work-items', 'state.sqlite'),
      `
      CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE work_item_outcome (item_id TEXT, revision INTEGER, PRIMARY KEY (item_id, revision));
      INSERT INTO work_item VALUES ('wi-1', 'settled'), ('wi-2', 'open');
      INSERT INTO work_item_outcome VALUES ('wi-1', 1), ('wi-1', 2);
      `,
    )

    // 3. assistant-growth-driver
    createSqlite(
      join(home, 'assistant-growth-driver', 'usage.sqlite'),
      "CREATE TABLE usage_jobs (id TEXT PRIMARY KEY, lane TEXT, state TEXT); INSERT INTO usage_jobs VALUES ('u1', 'l', 'reviewed'), ('u2', 'l', 'queued');",
    )

    // 4. assistant-goals (.strategies)
    createSqlite(
      join(home, 'assistant-goals', 'state.sqlite.strategies'),
      "CREATE TABLE goal_strategy_records (id TEXT PRIMARY KEY, state TEXT, outcome TEXT); INSERT INTO goal_strategy_records VALUES ('gs1', 'settled', 'ok');",
    )

    // 5. assistant-verifier + sidecar creation review
    createSqlite(
      join(home, 'assistant-verifier', 'verification.sqlite'),
      "CREATE TABLE acceptance_jobs (contract_id TEXT PRIMARY KEY, state TEXT); INSERT INTO acceptance_jobs VALUES ('c1', 'done'), ('c2', 'pending');",
    )
    createSqlite(
      join(home, 'assistant-verifier', 'verification.sqlite.creation-reviews'),
      "CREATE TABLE verifications (plan TEXT PRIMARY KEY, state TEXT); INSERT INTO verifications VALUES ('p-create-1', 'certificate');",
    )

    // 6. assistant-evolution, association, evaluation, memory-learning, personal-memory, preference-learning, growth-experiments, skills, recovery
    createSqlite(
      join(home, 'assistant-evolution', 'evolution.sqlite'),
      `
      CREATE TABLE evolution_proposals (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE evolution_rules (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE evolution_autonomous_rollbacks (idempotency_key TEXT PRIMARY KEY);
      INSERT INTO evolution_proposals VALUES ('ep1', 'approved');
      INSERT INTO evolution_rules VALUES ('er1', 'active');
      INSERT INTO evolution_autonomous_rollbacks VALUES ('erb1');
      `,
    )
    createSqlite(
      join(home, 'assistant-association', 'association.sqlite'),
      `
      CREATE TABLE assoc_param_profile_heads (scope_key TEXT PRIMARY KEY, active_version INTEGER);
      CREATE TABLE assoc_param_profile_events (kind TEXT);
      CREATE TABLE assoc_param_relax_proposals (proposal_id TEXT PRIMARY KEY);
      INSERT INTO assoc_param_profile_heads VALUES ('owner', 4);
      INSERT INTO assoc_param_profile_events VALUES ('adopted'), ('adopted');
      INSERT INTO assoc_param_relax_proposals VALUES ('arp1');
      `,
    )
    createSqlite(
      join(home, 'assistant-evaluation', 'evaluation.sqlite'),
      `
      CREATE TABLE evaluation_attention_tuning_events (kind TEXT);
      CREATE TABLE evaluation_attention_loosening_proposals (proposal_id TEXT PRIMARY KEY);
      CREATE TABLE evaluation_attention_loosening_decisions (proposal_id TEXT PRIMARY KEY, decision TEXT);
      INSERT INTO evaluation_attention_tuning_events VALUES ('adopted');
      INSERT INTO evaluation_attention_loosening_proposals VALUES ('lp1');
      INSERT INTO evaluation_attention_loosening_decisions VALUES ('lp1', 'adopted');
      `,
    )
    createSqlite(
      join(home, 'assistant-memory-learning', 'learning.sqlite'),
      "CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT); INSERT INTO jobs VALUES ('ml1', 'adopted'), ('ml2', 'queued');",
    )
    createSqlite(
      join(home, 'personal-memory', 'memory.sqlite'),
      "CREATE TABLE memory_records (id TEXT PRIMARY KEY, status TEXT); INSERT INTO memory_records VALUES ('m1', 'active'), ('m2', 'active'), ('m3', 'removed');",
    )
    createSqlite(
      join(home, 'preference-learning', 'preferences.sqlite'),
      `
      CREATE TABLE preference_hypotheses (id TEXT PRIMARY KEY, effect_state TEXT);
      CREATE TABLE preference_transitions (id TEXT PRIMARY KEY, reason TEXT);
      INSERT INTO preference_hypotheses VALUES ('ph1', 'active');
      INSERT INTO preference_transitions VALUES ('pt1', 'activated');
      `,
    )
    createSqlite(
      join(home, 'assistant-growth-experiments', 'growth.sqlite'),
      "CREATE TABLE workflow_candidates (id TEXT PRIMARY KEY, state TEXT); INSERT INTO workflow_candidates VALUES ('wf1', 'promoted');",
    )
    createSqlite(
      join(home, 'assistant-skills', 'skills.sqlite'),
      `
      CREATE TABLE skill_candidates (id TEXT PRIMARY KEY);
      CREATE TABLE skill_deployments (id TEXT PRIMARY KEY, state TEXT);
      INSERT INTO skill_candidates VALUES ('sc1');
      INSERT INTO skill_deployments VALUES ('sd1', 'promoted');
      `,
    )
    createSqlite(
      join(home, 'assistant-recovery', 'recovery.sqlite'),
      "CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, status TEXT); INSERT INTO recovery_runs VALUES ('rr1', 'succeeded');",
    )

    // 7. upgrade-history.jsonl & .dsh-rsi-upgrade-backups/ (with symlink child ignored)
    mkdirSync(join(home, '.dsh-enhanced'), { recursive: true })
    writeFileSync(
      join(home, '.dsh-enhanced', 'upgrade-history.jsonl'),
      `${JSON.stringify({ at: 100, toVersion: '0.1.83' })}\n${JSON.stringify({ at: 200, toVersion: '0.1.84' })}\n`,
      'utf8',
    )
    mkdirSync(join(home, '.dsh-rsi-upgrade-backups', 'doctor-100'), { recursive: true })
    mkdirSync(join(home, '.dsh-rsi-upgrade-backups', '2026-11-24-1'), { recursive: true })
    symlinkSync(outsideDir, join(home, '.dsh-rsi-upgrade-backups', 'evil-link'))

    const ctx = new Context()
    ctx.provide('profileContext' as never, { home, dir: profileDir, name: 'web' } as never)
    ctx.provide('pluginManager' as never, {
      listBundles: async () => [
        { name: '@dsh-enhanced/owner-console', version: '0.1.83', enabled: true, installed: true, removable: false, optional: false },
        // Also present in evolved ledger -> must enrich evolved & NOT double-count in core!
        { name: '@dsh-enhanced/evolved-alpha', version: '1.2.0', enabled: true, installed: true, removable: true, optional: false },
        { name: '@dsh-enhanced/dep-helper', version: '0.1.83', enabled: true, installed: true, removable: false, optional: false, error: { code: 'not-bundle' } },
      ],
      listPlugins: async () => [],
    } as never)

    const report = await collectOwnerConsoleVersionInfo(ctx, { now: 1_700_000_000_200 })
    expect(OwnerConsoleVersionReportSchema.parse(report)).toEqual(report)

    expect(report.host.boundVersion).toBe('0.2.2-rc.5')
    expect(report.host.boundStatus).toBe('ready')
    expect(report.profile).toBe('web')
    expect(report.profiles).toEqual(['web'])

    // Core vs Evolved strictly separated
    expect(report.plugins.state).toBe('ok')
    expect(report.plugins.coreCount).toBe(1)
    expect(report.plugins.core[0]).toMatchObject({ name: '@dsh-enhanced/owner-console', kind: 'core', installKind: 'npm', enabled: true })
    expect(report.plugins.evolvedCount).toBe(2) // evolved-alpha + evolved-retired
    expect(report.plugins.activeEvolvedCount).toBe(1)
    expect(report.plugins.evolved.find(e => e.name === '@dsh-enhanced/evolved-alpha')).toMatchObject({
      kind: 'evolved',
      installKind: 'adopted',
      version: '1.2.0',
      enabled: true,
    })

    // Zero double-counting checks
    expect(report.selfIteration.dataState).toBe('data')
    expect(report.selfIteration.pluginsCreated).toBe(1) // p-create-1 (closed p-create-closed excluded)
    expect(report.selfIteration.pluginsRevised).toBe(1) // p-rev-1
    // control-plane distinct plans = {p-create-1, p-rev-1} (2) + ml(1) + skills(1) + pref(1) + evo(1) + wf(1) = 7
    expect(report.selfIteration.candidatesAdopted).toBe(7)
    // rollbacks: cp activation(1) + cp revision rollbacks(1) + evo(1) = 3
    expect(report.selfIteration.rollbacks).toBe(3)
    expect(report.selfIteration.workItemsTotal).toBe(2)
    expect(report.selfIteration.workItemsSettled).toBe(1)
    expect(report.selfIteration.growthUsageJobsTotal).toBe(2)
    expect(report.selfIteration.goalStrategyRuns).toBe(1)
    expect(report.selfIteration.recoveryRuns).toBe(1)
    expect(report.selfIteration.taskVerificationsDone).toBe(1)
    expect(report.selfIteration.evolutionRulesAdopted).toBe(1)
    expect(report.selfIteration.associationParamVersion).toBe(4)
    expect(report.selfIteration.associationProfileAdoptions).toBe(2)
    expect(report.selfIteration.evaluationAttentionTuningAdoptions).toBe(1)
    expect(report.selfIteration.evaluationLooseningDecisionsAdopted).toBe(1)
    expect(report.selfIteration.activeMemories).toBe(2)
    expect(report.selfIteration.activePreferenceOverlays).toBe(1)
    expect(report.selfIteration.workflowCandidatesPromoted).toBe(1)
    expect(report.selfIteration.skillDeployments).toBe(1)
    expect(report.selfIteration.selfUpgrades).toBe(2)
    expect(report.selfIteration.backupSnapshotsCount).toBe(2)
    // Symlinked evil dream_runs was skipped
    expect(report.selfIteration.dreamingRuns).toBeNull()
    expect(report.diagnostics?.some(d => d.includes('skipped symlink ledger'))).toBe(true)
    expect(report.extensions?.['verifierReviews']).toEqual({
      creationCertificates: 1,
      sourceApproved: 0,
      revisionCertificates: 0,
      revisionRegressions: 0,
    })
  })

  it('supports mode=ro&immutable=1 fallback on read-only directories without -wal and falls back to Cordis health() for :memory: services', async () => {
    const home = makeTempDir('oc-version-ro-')
    const roDir = join(home, 'ro-dir')
    const roDbPath = join(roDir, 'wi.sqlite')
    createSqlite(roDbPath, "CREATE TABLE work_item (id TEXT PRIMARY KEY); INSERT INTO work_item VALUES ('ro-1');")
    chmodSync(roDbPath, 0o444)
    chmodSync(roDir, 0o555)

    const ctx = new Context()
    ctx.provide('profileContext' as never, { home, name: 'web' } as never)
    ctx.provide('loader' as never, {
      entries: () => [{
        id: 'wi',
        options: { id: 'wi', name: '@dsh-enhanced/assistant-work-items', config: { databasePath: roDbPath } },
      }],
    } as never)
    ctx.provide('assistantDreaming' as never, { health: () => ({ counts: { runs: 5 } }) } as never)
    ctx.provide('assistantPreferenceLearning' as never, { health: () => ({ active: 3, hypotheses: 4, rolledBack: 1 }) } as never)
    ctx.provide('personalMemory' as never, { health: () => ({ activeRecords: 9 }) } as never)

    const report = await collectOwnerConsoleVersionInfo(ctx, { now: 1_700_000_000_300 })
    expect(OwnerConsoleVersionReportSchema.parse(report)).toEqual(report)
    expect(report.selfIteration.workItemsTotal).toBe(1)
    expect(report.selfIteration.dreamingRuns).toBe(5)
    expect(report.selfIteration.activePreferenceOverlays).toBe(3)
    expect(report.selfIteration.activeMemories).toBe(9)
    expect(report.selfIteration.rollbacks).toBe(1)
  })

  it('exposes OwnerConsoleService.versionInfo() via TYPERT and gates owner_console_version_info tool authorization without altering preauthPredicates[0]', async () => {
    const home = makeTempDir('oc-version-service-')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const registeredTools: Array<{
      def: { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }
      opts?: { when?: (ctx: { agent?: unknown }) => boolean | Promise<boolean> } | undefined
    }> = []
    const preauthPredicates: Array<(exec: { agent?: unknown }) => boolean> = []

    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('profileContext' as never, { home, dir: join(home, 'profiles', 'web'), name: 'web' } as never)
    ctx.provide('tools' as never, {
      register: (def: typeof registeredTools[number]['def'], opts?: typeof registeredTools[number]['opts']) => {
        registeredTools.push({ def, opts })
        return () => {}
      },
    } as never)
    ctx.provide('assistantPolicy' as never, {
      registerPreauthorizedTool: (_c: unknown, _d: unknown, pred: (exec: { agent?: unknown }) => boolean) => {
        preauthPredicates.push(pred)
        return () => {}
      },
    } as never)

    apply(ctx, Config({ feishuAppId: '' }))
    const svc = ctx.get('ownerConsole' as never) as unknown as OwnerConsoleService

    try {
      const report = await svc.versionInfo()
      const codec = TYPERT.invocations.find(i => i.method === 'versionInfo')!.result
      expect(codec).toBeDefined()
      expect(OwnerConsoleVersionReportSchema.parse(report)).toEqual(report)

      expect(registeredTools.map(t => t.def.name)).toEqual([
        'owner_console_self_iteration_control',
        'owner_console_version_info',
      ])
      expect(preauthPredicates).toHaveLength(2)

      const versionTool = registeredTools[1]!
      const foreignAgent = { id: 'foreign-session', session: { id: 'foreign-session' } }
      expect(versionTool.opts?.when?.({ agent: foreignAgent })).toBe(false)
      expect(preauthPredicates[1]?.({ agent: foreignAgent })).toBe(false)
      const denied = await versionTool.def.execute({}, { agent: foreignAgent })
      expect(denied.ok).toBe(false)

      await svc.registerAssistantSession('wenyao-version-session', true)
      const ownerAgent = { id: 'wenyao-version-session', session: { id: 'wenyao-version-session' } }
      expect(versionTool.opts?.when?.({ agent: ownerAgent })).toBe(true)
      expect(preauthPredicates[1]?.({ agent: ownerAgent })).toBe(true)
      const allowed = await versionTool.def.execute({}, { agent: ownerAgent })
      expect(allowed.ok).toBe(true)
      expect(typeof allowed.summary).toBe('string')
      expect(OwnerConsoleVersionReportSchema.parse(allowed.report)).toEqual(allowed.report)
    } finally {
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
    }
  })

  it('bounds oversized diagnostics, plugin names/versions, host boundVersion, and negative now to satisfy strict OwnerConsoleVersionReportSchema and TYPERT result codec', async () => {
    const home = makeTempDir('oc-version-bounds-')
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(home, '.dsh-rsi-host.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: `0.2.2-${'v'.repeat(200)}`,
        cacheRoot: join(home, 'cache'),
        receiptDigest: 'a'.repeat(64),
      }),
      { encoding: 'utf8', mode: 0o600 },
    )

    const ctx = new Context()
    ctx.provide('profileContext' as never, { home, dir: profileDir, name: 'web' } as never)
    ctx.provide('pluginManager' as never, {
      listBundles: async () => {
        throw new Error(`E_FAIL: ${'x'.repeat(1_500)}`)
      },
      listPlugins: async () => [],
    } as never)
    ctx.provide('loader' as never, {
      entries: () => {
        throw new Error(`   ${'y'.repeat(1_600)}   `)
      },
    } as never)

    const report = await collectOwnerConsoleVersionInfo(ctx, { now: -10 })
    const typertCodec = TYPERT.invocations.find(i => i.method === 'versionInfo')!.result.create()

    expect(report.generatedAt).toBeGreaterThanOrEqual(0)
    expect(report.host.boundVersion?.length).toBeLessThanOrEqual(128)
    expect(report.diagnostics).toBeDefined()
    expect(report.diagnostics!.length).toBeGreaterThanOrEqual(2)
    for (const entry of report.diagnostics!) {
      expect(entry.length).toBeGreaterThanOrEqual(1)
      expect(entry.length).toBeLessThanOrEqual(1_024)
    }
    expect(report.diagnostics![0]!.endsWith('…')).toBe(true)
    expect(OwnerConsoleVersionReportSchema.safeParse(report).success).toBe(true)
    expect(typertCodec.safeParse(report).success).toBe(true)

    const ctxLongNames = new Context()
    ctxLongNames.provide('profileContext' as never, { home, dir: profileDir, name: 'web' } as never)
    ctxLongNames.provide('pluginManager' as never, {
      listBundles: async () => [{
        name: `@dsh-enhanced/${'long-plugin-'.repeat(25)}`,
        version: `1.0.0-${'b'.repeat(200)}`,
        enabled: true,
        installed: true,
        removable: false,
        optional: false,
      }],
      listPlugins: async () => [],
    } as never)

    const longReport = await collectOwnerConsoleVersionInfo(ctxLongNames, { now: 1_700_000_000_400 })
    expect(longReport.plugins.core[0]!.name.length).toBeLessThanOrEqual(200)
    expect(longReport.plugins.core[0]!.version!.length).toBeLessThanOrEqual(128)
    expect(OwnerConsoleVersionReportSchema.safeParse(longReport).success).toBe(true)
    expect(typertCodec.safeParse(longReport).success).toBe(true)
  })

  it('reads stopped writable WAL DBs with zero -wal/-shm sidecars, fails closed on 0555 uncheckpointed -wal, rejects hardlinks, and handles prepared-revise', async () => {
    const root = makeTempDir('oc-version-wal-sec-')
    const home = join(root, 'dsh-home')
    const outsideDir = join(root, 'outside')
    const wiDir = join(home, 'assistant-work-items')
    const gdDir = join(home, 'assistant-growth-driver')
    const liveDir = join(home, 'assistant-dreaming')
    const roWalDir = join(home, 'assistant-recovery')
    const hlDir = join(home, 'assistant-evolution')
    const cpDir = join(home, 'plugin-control-plane')
    for (const d of [outsideDir, wiDir, gdDir, liveDir, roWalDir, hlDir, cpDir]) {
      mkdirSync(d, { recursive: true })
    }

    // 1. Cleanly stopped writable (0o700) WAL DB (no sidecars)
    const wiDbPath = join(wiDir, 'state.sqlite')
    createSqlite(wiDbPath, "PRAGMA journal_mode = WAL; CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT); INSERT INTO work_item VALUES ('w1', 'settled');")
    try { unlinkSync(`${wiDbPath}-wal`) } catch { /* ignore */ }
    try { unlinkSync(`${wiDbPath}-shm`) } catch { /* ignore */ }
    chmodSync(wiDir, 0o700)
    const wiMtimeBefore = statSync(wiDbPath).mtimeMs

    // 2. Cleanly stopped writable (0o700) WAL DB with 0-byte -wal and no -shm
    const gdDbPath = join(gdDir, 'usage.sqlite')
    createSqlite(gdDbPath, "PRAGMA journal_mode = WAL; CREATE TABLE usage_jobs (id TEXT PRIMARY KEY, state TEXT); INSERT INTO usage_jobs VALUES ('u1', 'reviewed');")
    try { unlinkSync(`${gdDbPath}-shm`) } catch { /* ignore */ }
    writeFileSync(`${gdDbPath}-wal`, '', 'utf8')
    chmodSync(gdDir, 0o700)

    // 3. Live uncheckpointed WAL DB
    const liveDbPath = join(liveDir, 'state.sqlite')
    const liveWriter = new DatabaseSync(liveDbPath)
    liveWriter.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE dream_runs (id TEXT PRIMARY KEY); INSERT INTO dream_runs VALUES ('d1');")

    // 4. 0555 dir with uncheckpointed non-empty -wal (no -shm) -> must fail closed (null + diagnostic)
    const roWalDbPath = join(roWalDir, 'recovery.sqlite')
    createSqlite(roWalDbPath, "CREATE TABLE recovery_runs (id TEXT PRIMARY KEY); INSERT INTO recovery_runs VALUES ('r1');")
    writeFileSync(`${roWalDbPath}-wal`, 'non-empty-wal-frames', 'utf8')
    chmodSync(roWalDir, 0o555)

    // 5. Hardlink escape (.sqlite with nlink === 2) -> must fail closed (null + diagnostic)
    const evilOutside = join(outsideDir, 'evil-hardlink.sqlite')
    createSqlite(evilOutside, "CREATE TABLE evolution_rules (id TEXT PRIMARY KEY); INSERT INTO evolution_rules VALUES ('er-hl');")
    linkSync(evilOutside, join(hlDir, 'evolution.sqlite'))

    // 6. source_plans prepared-revise on core plugin must NOT move it to evolved[]
    createSqlite(
      join(cpDir, 'control.sqlite'),
      "CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT, mode TEXT, status TEXT); INSERT INTO source_plans VALUES ('sp-rev', '@dsh-enhanced/assistant-work-items', 'prepared-revise', 'release-complete');",
    )

    const ctx = new Context()
    ctx.provide('profileContext' as never, { home, name: 'web' } as never)

    try {
      const report = await collectOwnerConsoleVersionInfo(ctx, { now: 1_700_000_000_500 })
      expect(OwnerConsoleVersionReportSchema.safeParse(report).success).toBe(true)
      expect(readdirSync(wiDir).sort()).toEqual(['state.sqlite'])
      expect(statSync(wiDbPath).mtimeMs).toBe(wiMtimeBefore)
      expect(readdirSync(gdDir).sort()).toEqual(['usage.sqlite', 'usage.sqlite-wal'])
      expect(report.selfIteration.workItemsTotal).toBe(1)
      expect(report.selfIteration.growthUsageJobsTotal).toBe(1)
      expect(report.selfIteration.dreamingRuns).toBe(1)
      expect(report.selfIteration.recoveryRuns).toBeNull()
      expect(report.selfIteration.evolutionRulesAdopted).toBeNull()
      expect(report.selfIteration.pluginsRevised).toBe(1)
      expect(report.plugins.evolved).toEqual([])
      expect(report.diagnostics?.some(d => d.includes('hardlink'))).toBe(true)
    } finally {
      liveWriter.close()
      try { chmodSync(roWalDir, 0o700) } catch { /* ignore */ }
    }
  })
})
