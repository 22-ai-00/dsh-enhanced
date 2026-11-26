import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { chmod, link, mkdir, mkdtemp, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  collectDeliveryVersionReport,
  formatAssistantVersionSummary,
} from '../src/version-query.ts'
import { version as packageVersion } from '../src/version.ts'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop()!
    await chmod(join(dir, 'dsh-home', 'assistant-dreaming'), 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

describe('collectDeliveryVersionReport & formatAssistantVersionSummary', () => {
  test('returns no-data report without crashing when dshHome and services are absent', async () => {
    const ctx = new Context()
    const report = await collectDeliveryVersionReport({ ctx })

    expect(report.schemaVersion).toBe(1)
    expect(report.protocol).toBe('dsh-ray/version/v1')
    expect(report.assistant.name).toBe('dsh-ray')
    expect(report.assistant.version).toBe(packageVersion)
    expect(report.host.packageName).toBe('@deepseek-ai/dsh')
    expect(report.host.boundStatus).toBe('missing')
    expect(report.host.boundVersion).toBeNull()
    expect(report.plugins.state).toBe('unavailable')
    expect(report.selfIteration.dataState).toBe('no-data')
    expect(report.selfIteration.totalIterations).toBeNull()
    expect(report.selfIteration.workItemsTotal).toBeNull()
    expect(report.selfIteration.pluginsCreated).toBeNull()

    const summary = formatAssistantVersionSummary(report)
    expect(summary).toContain(packageVersion)
    expect(summary).toContain('无数据')
    expect(summary).not.toContain('累计自迭代次数：0')
  })

  test('distinguishes dataState=zero when initialized ledgers have zero rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-version-zero-'))
    roots.push(root)
    const home = join(root, 'dsh-home')
    await mkdir(join(home, 'assistant-work-items'), { recursive: true })
    await mkdir(join(home, 'plugin-control-plane'), { recursive: true })

    const wiDb = new DatabaseSync(join(home, 'assistant-work-items', 'state.sqlite'))
    wiDb.exec('CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;')
    wiDb.close()

    const cpDb = new DatabaseSync(join(home, 'plugin-control-plane', 'control.sqlite'))
    cpDb.exec(`
      CREATE TABLE source_plans (id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, plugin_name TEXT NOT NULL) STRICT;
      CREATE TABLE activation_plans (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    `)
    cpDb.close()

    const ctx = new Context()
    const report = await collectDeliveryVersionReport({ ctx, dshHome: home, profile: 'lark' })

    expect(report.selfIteration.dataState).toBe('zero')
    expect(report.selfIteration.totalIterations).toBe(0)
    expect(report.selfIteration.workItemsTotal).toBe(0)
    expect(report.selfIteration.workItemsSettled).toBe(0)
    expect(report.selfIteration.candidatesGenerated).toBe(0)
    expect(report.selfIteration.candidatesAdopted).toBe(0)
    expect(report.selfIteration.pluginsCreated).toBe(0)
    expect(report.selfIteration.pluginsRevised).toBe(0)
    expect(report.selfIteration.rollbacks).toBe(0)

    const summary = formatAssistantVersionSummary(report)
    expect(summary).toContain('暂无记录')
    expect(summary).toContain('累计自迭代次数：0')
  })

  test('aggregates read-only SQLite ledgers, host metadata, plugins, backups, and separates creation/revision/adoption/rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-version-data-'))
    roots.push(root)
    const home = join(root, 'dsh-home')
    await mkdir(join(home, 'profiles', 'lark', 'node_modules', '@dsh-ray', 'assistant-delivery'), { recursive: true })
    await mkdir(join(home, 'assistant-work-items'), { recursive: true })
    await mkdir(join(home, 'assistant-growth-driver'), { recursive: true })
    await mkdir(join(home, 'assistant-dreaming'), { recursive: true })
    await mkdir(join(home, 'assistant-recovery'), { recursive: true })
    await mkdir(join(home, 'assistant-goals'), { recursive: true })
    await mkdir(join(home, 'plugin-control-plane'), { recursive: true })
    await mkdir(join(home, 'assistant-verifier'), { recursive: true })
    await mkdir(join(home, 'assistant-evolution'), { recursive: true })
    await mkdir(join(home, 'assistant-association'), { recursive: true })
    await mkdir(join(home, 'assistant-evaluation'), { recursive: true })
    await mkdir(join(home, 'personal-memory'), { recursive: true })
    await mkdir(join(home, 'preference-learning'), { recursive: true })
    await mkdir(join(home, 'assistant-growth-experiments'), { recursive: true })
    await mkdir(join(home, 'assistant-skills'), { recursive: true })
    await mkdir(join(home, '.dsh-ray'), { recursive: true })
    await mkdir(join(home, '.dsh-ray-upgrade-backups', 'snap-1'), { recursive: true })
    await mkdir(join(home, '.dsh-ray-upgrade-backups', 'snap-2'), { recursive: true })

    await writeFile(
      join(home, '.dsh-ray-host.json'),
      JSON.stringify({ schemaVersion: 1, version: '0.2.2-rc.5', cacheRoot: '/tmp/cache', receiptDigest: 'a'.repeat(64) }),
      { mode: 0o600 },
    )
    await writeFile(
      join(home, 'profiles', 'lark', 'node_modules', '@dsh-ray', 'assistant-delivery', 'package.json'),
      JSON.stringify({ name: '@dsh-ray/assistant-delivery', version: packageVersion }),
    )
    await writeFile(
      join(home, '.dsh-ray', 'upgrade-history.jsonl'),
      `${JSON.stringify({ at: 1, to: packageVersion })}\n${JSON.stringify({ at: 2, to: packageVersion })}\n`,
    )

    const wiDb = new DatabaseSync(join(home, 'assistant-work-items', 'state.sqlite'))
    wiDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
      INSERT INTO work_item VALUES ('w1', 'ready'), ('w2', 'working'), ('w3', 'failed');
    `)
    wiDb.close()

    const gdDb = new DatabaseSync(join(home, 'assistant-growth-driver', 'usage.sqlite'))
    gdDb.exec(`
      CREATE TABLE usage_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
      INSERT INTO usage_jobs VALUES ('u1', 'reviewed'), ('u2', 'queued');
    `)
    gdDb.close()

    const dreamPath = join(home, 'assistant-dreaming', 'state.sqlite')
    const dreamDb = new DatabaseSync(dreamPath)
    dreamDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT NOT NULL) STRICT;
      INSERT INTO dream_runs VALUES ('d1', 'completed');
    `)
    dreamDb.close()

    const recDb = new DatabaseSync(join(home, 'assistant-recovery', 'state.sqlite'))
    recDb.exec(`
      CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      INSERT INTO recovery_runs VALUES ('r1', 'succeeded');
    `)
    recDb.close()

    const goalDb = new DatabaseSync(join(home, 'assistant-goals', 'strategy.sqlite'))
    goalDb.exec(`
      CREATE TABLE goal_strategy_records (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
      INSERT INTO goal_strategy_records VALUES ('g1', 'settled');
    `)
    goalDb.close()

    const cpDb = new DatabaseSync(join(home, 'plugin-control-plane', 'control.sqlite'))
    cpDb.exec(`
      CREATE TABLE source_plans (id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, plugin_name TEXT NOT NULL) STRICT;
      CREATE TABLE activation_plans (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      INSERT INTO source_plans VALUES
        ('sp1', 'create', 'release-complete', '@dsh-ray/evolved-tool-a'),
        ('sp2', 'modify', 'release-complete', '@dsh-ray/evolved-tool-a'),
        ('sp3', 'create', 'running-local-checks', '@dsh-ray/evolved-tool-b');
      INSERT INTO activation_plans VALUES
        ('ap1', 'activated'),
        ('ap2', 'rolled-back');
    `)
    cpDb.close()

    const createAdoptDb = new DatabaseSync(join(home, 'plugin-control-plane', 'creation-adoptions.sqlite'))
    createAdoptDb.exec(`
      CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, certificate_json TEXT NOT NULL) STRICT;
      INSERT INTO adoptions VALUES
        ('sp1', 'active', '{"pluginName":"@dsh-ray/evolved-tool-a","version":"0.1.0"}');
    `)
    createAdoptDb.close()

    const verDb = new DatabaseSync(join(home, 'assistant-verifier', 'verification.sqlite'))
    verDb.exec(`
      CREATE TABLE acceptance_jobs (contract_id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
      INSERT INTO acceptance_jobs VALUES ('aj1', 'done'), ('aj2', 'pending');
    `)
    verDb.close()

    const evoDb = new DatabaseSync(join(home, 'assistant-evolution', 'evolution.sqlite'))
    evoDb.exec(`
      CREATE TABLE evolution_proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      CREATE TABLE evolution_rules (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      CREATE TABLE evolution_autonomous_rollbacks (idempotency_key TEXT PRIMARY KEY) STRICT;
      INSERT INTO evolution_proposals VALUES ('ep1', 'approved');
      INSERT INTO evolution_rules VALUES ('er1', 'active');
      INSERT INTO evolution_autonomous_rollbacks VALUES ('rb1');
    `)
    evoDb.close()

    const assocDb = new DatabaseSync(join(home, 'assistant-association', 'association.sqlite'))
    assocDb.exec(`
      CREATE TABLE assoc_param_profile_heads (scope_key TEXT PRIMARY KEY, active_version INTEGER NOT NULL) STRICT;
      CREATE TABLE assoc_param_profile_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL) STRICT;
      INSERT INTO assoc_param_profile_heads VALUES ('s1', 3);
      INSERT INTO assoc_param_profile_events (kind) VALUES ('adopted'), ('adopted');
    `)
    assocDb.close()

    const evalDb = new DatabaseSync(join(home, 'assistant-evaluation', 'evaluation.sqlite'))
    evalDb.exec(`
      CREATE TABLE evaluation_attention_tuning_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL) STRICT;
      CREATE TABLE evaluation_attention_loosening_decisions (proposal_id TEXT PRIMARY KEY, decision TEXT NOT NULL) STRICT;
      INSERT INTO evaluation_attention_tuning_events (kind) VALUES ('adopted');
      INSERT INTO evaluation_attention_loosening_decisions VALUES ('p1', 'adopted'), ('p2', 'rejected');
    `)
    evalDb.close()

    const memDb = new DatabaseSync(join(home, 'personal-memory', 'memory.sqlite'))
    memDb.exec(`
      CREATE TABLE memory_records (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      INSERT INTO memory_records VALUES ('m1', 'active'), ('m2', 'removed');
    `)
    memDb.close()

    const prefDb = new DatabaseSync(join(home, 'preference-learning', 'preferences.sqlite'))
    prefDb.exec(`
      CREATE TABLE preference_hypotheses (id TEXT PRIMARY KEY, effect_state TEXT NOT NULL) STRICT;
      INSERT INTO preference_hypotheses VALUES ('ph1', 'active');
    `)
    prefDb.close()

    const geDb = new DatabaseSync(join(home, 'assistant-growth-experiments', 'growth.sqlite'))
    geDb.exec(`
      CREATE TABLE workflow_candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
      INSERT INTO workflow_candidates VALUES ('wc1', 'promoted');
    `)
    geDb.close()

    const skillDb = new DatabaseSync(join(home, 'assistant-skills', 'skills.sqlite'))
    skillDb.exec(`
      CREATE TABLE skill_deployments (scope_key TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (scope_key, id)) STRICT;
      INSERT INTO skill_deployments VALUES ('s1', 'sk1', 'promoted');
    `)
    skillDb.close()

    // Symlinked DB outside boundary must be ignored
    const outsideDb = join(root, 'outside.sqlite')
    const outConn = new DatabaseSync(outsideDb)
    outConn.exec("CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT NOT NULL) STRICT; INSERT INTO dream_runs VALUES ('bad', 'completed');")
    outConn.close()
    await symlink(outsideDb, join(home, 'assistant-dreaming', 'symlink.sqlite'))

    // Read-only dir exercises immutable=1 fallback for dreamDb
    await chmod(join(home, 'assistant-dreaming'), 0o555)

    const ctx = new Context()
    // Loader pointing to the exact same work-items DB should deduplicate by canonical realpath
    ctx.provide('loader' as never, {
      entries: () => [
        { options: { name: '@dsh-ray/assistant-work-items', config: { databasePath: join(home, 'assistant-work-items', 'state.sqlite') } } },
        { options: { name: '@dsh-ray/assistant-delivery', config: {} } },
      ],
    } as never)

    const report = await collectDeliveryVersionReport({ ctx, dshHome: home, profile: 'lark' })
    expect(report.host.boundStatus).toBe('ready')
    expect(report.host.boundVersion).toBe('0.2.2-rc.5')
    expect(report.profile).toBe('lark')
    expect(report.profiles).toEqual(['lark'])
    expect(report.plugins.state).toBe('ok')
    expect(report.plugins.coreCount).toBeGreaterThanOrEqual(2)
    expect(report.plugins.evolvedCount).toBe(1)
    expect(report.plugins.activeEvolvedCount).toBe(1)
    expect(report.plugins.evolved[0]?.name).toBe('@dsh-ray/evolved-tool-a')

    const s = report.selfIteration
    expect(s.dataState).toBe('data')
    expect(s.workItemsTotal).toBe(3)
    expect(s.workItemsSettled).toBe(2)
    expect(s.growthUsageJobsTotal).toBe(2)
    expect(s.dreamingRuns).toBe(1)
    expect(s.recoveryRuns).toBe(1)
    expect(s.goalStrategyRuns).toBe(1)
    expect(s.pluginsCreated).toBe(1) // deduped sp1 across source_plans + adoptions
    expect(s.pluginsRevised).toBe(1) // sp2
    expect(s.candidatesGenerated).toBe(10) // 3 source_plans + 2 unlinked activation_plans + 2 usage_jobs + 1 evo + 1 pref + 1 workflow
    expect(s.candidatesAdopted).toBe(7) // 3 distinct cp plans (sp1, sp2, ap1) + 1 evo_rules + 1 pref + 1 workflow + 1 skill
    expect(s.taskVerificationsDone).toBe(1)
    expect(s.rollbacks).toBe(2) // 1 activation rollback + 1 evo autonomous rollback
    expect(s.evolutionRulesAdopted).toBe(1)
    expect(s.associationParamVersion).toBe(3)
    expect(s.associationProfileAdoptions).toBe(2)
    expect(s.evaluationAttentionTuningAdoptions).toBe(1)
    expect(s.evaluationLooseningDecisionsAdopted).toBe(1)
    expect(s.activeMemories).toBe(1)
    expect(s.activePreferenceOverlays).toBe(1)
    expect(s.workflowCandidatesPromoted).toBe(1)
    expect(s.skillDeployments).toBe(1)
    expect(s.selfUpgrades).toBe(2)
    expect(s.backupSnapshotsCount).toBe(2)
    expect(s.totalIterations).toBe(15)

    const summary = formatAssistantVersionSummary(report)
    expect(summary).toContain('@dsh-ray/evolved-tool-a')
    expect(summary).toContain('0.2.2-rc.5')
    expect(summary).toContain('累计自迭代次数：15')
  })

  test('falls back to Cordis health() and assistantPreferenceLearning slot when SQLite files are absent', async () => {
    const ctx = new Context()
    ctx.provide('pluginManager' as never, {
      listBundles: async () => [
        { name: '@dsh-ray/assistant-delivery', version: packageVersion, enabled: true },
        { name: '@dsh-ray/personal-memory', version: packageVersion, enabled: true },
      ],
    } as never)
    ctx.provide('assistantDreaming' as never, { health: () => ({ runs: 4 }) } as never)
    ctx.provide('assistantEvolution' as never, {
      health: () => ({ activeRules: 2, retiredRules: 1, pendingProposals: 1, autonomousRollbacks: 1 }),
    } as never)
    ctx.provide('personalMemory' as never, { health: () => ({ activeRecords: 7 }) } as never)
    ctx.provide('assistantPreferenceLearning' as never, {
      health: () => ({ active: 2, hypotheses: 3, rolledBack: 1 }),
    } as never)
    ctx.provide('assistantGrowthExperiments' as never, { health: () => ({ promoted: 2 }) } as never)

    const report = await collectDeliveryVersionReport({ ctx })
    expect(report.plugins.state).toBe('ok')
    expect(report.plugins.coreCount).toBe(2)
    expect(report.selfIteration.dataState).toBe('data')
    expect(report.selfIteration.dreamingRuns).toBe(4)
    expect(report.selfIteration.evolutionRulesAdopted).toBe(3)
    expect(report.selfIteration.activeMemories).toBe(7)
    expect(report.selfIteration.activePreferenceOverlays).toBe(2)
    expect(report.selfIteration.workflowCandidatesPromoted).toBe(2)
    expect(report.selfIteration.rollbacks).toBe(2)
  })

  test('reads stopped writable WAL DBs with zero sidecars, fails closed on 0555 uncheckpointed WAL, rejects hardlinks, supports symlinked local plugins & schema bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-version-wal-sec-'))
    roots.push(root)
    const home = join(root, 'dsh-home')
    const outsideDir = join(root, 'outside')
    const localCheckout = join(root, 'local-checkout')
    const wiDir = join(home, 'assistant-work-items')
    const gdDir = join(home, 'assistant-growth-driver')
    const liveDir = join(home, 'assistant-dreaming')
    const roWalDir = join(home, 'assistant-recovery')
    const hlDir = join(home, 'assistant-evolution')
    const cpDir = join(home, 'plugin-control-plane')
    const scopeDir = join(home, 'profiles', 'lark', 'node_modules', '@dsh-ray')
    for (const d of [outsideDir, localCheckout, wiDir, gdDir, liveDir, roWalDir, hlDir, cpDir, scopeDir]) {
      await mkdir(d, { recursive: true })
    }

    // 1. Cleanly stopped writable (0o700) WAL DB (no sidecars)
    const wiDbPath = join(wiDir, 'state.sqlite')
    const wiDb = new DatabaseSync(wiDbPath)
    wiDb.exec("PRAGMA journal_mode = WAL; CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT) STRICT; INSERT INTO work_item VALUES ('w1', 'settled');")
    wiDb.close()
    await unlink(`${wiDbPath}-wal`).catch(() => {})
    await unlink(`${wiDbPath}-shm`).catch(() => {})
    await chmod(wiDir, 0o700)
    const wiMtimeBefore = (await stat(wiDbPath)).mtimeMs

    // 2. Cleanly stopped writable (0o700) WAL DB with 0-byte -wal and no -shm
    const gdDbPath = join(gdDir, 'usage.sqlite')
    const gdDb = new DatabaseSync(gdDbPath)
    gdDb.exec("PRAGMA journal_mode = WAL; CREATE TABLE usage_jobs (id TEXT PRIMARY KEY, state TEXT) STRICT; INSERT INTO usage_jobs VALUES ('u1', 'reviewed');")
    gdDb.close()
    await unlink(`${gdDbPath}-shm`).catch(() => {})
    await writeFile(`${gdDbPath}-wal`, '', 'utf8')
    await chmod(gdDir, 0o700)

    // 3. Live uncheckpointed WAL DB
    const liveDbPath = join(liveDir, 'state.sqlite')
    const liveWriter = new DatabaseSync(liveDbPath)
    liveWriter.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT) STRICT; INSERT INTO dream_runs VALUES ('d1', 'completed');")

    // 4. 0555 dir with uncheckpointed non-empty -wal -> must fail closed (null)
    const roWalDbPath = join(roWalDir, 'state.sqlite')
    const roDb = new DatabaseSync(roWalDbPath)
    roDb.exec("CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, status TEXT) STRICT; INSERT INTO recovery_runs VALUES ('r1', 'succeeded');")
    roDb.close()
    await writeFile(`${roWalDbPath}-wal`, 'uncheckpointed-frames', 'utf8')
    await chmod(roWalDir, 0o555)

    // 5. Hardlink escape (.sqlite with nlink === 2) -> must fail closed (null)
    const outsideDb = join(outsideDir, 'evil.sqlite')
    const outConn = new DatabaseSync(outsideDb)
    outConn.exec("CREATE TABLE evolution_rules (id TEXT PRIMARY KEY, status TEXT) STRICT; INSERT INTO evolution_rules VALUES ('er1', 'active');")
    outConn.close()
    await link(outsideDb, join(hlDir, 'evolution.sqlite'))

    // 6. prepared-revise + cert.plan.name + receipt_json
    const cpDb = new DatabaseSync(join(cpDir, 'control.sqlite'))
    cpDb.exec("CREATE TABLE source_plans (id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, plugin_name TEXT NOT NULL) STRICT; INSERT INTO source_plans VALUES ('sp-rev', 'prepared-revise', 'release-complete', '@dsh-ray/assistant-delivery');")
    cpDb.close()
    const caDb = new DatabaseSync(join(cpDir, 'creation-adoptions.sqlite'))
    caDb.exec(`CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, certificate_json TEXT NOT NULL, receipt_json TEXT NOT NULL) STRICT; INSERT INTO adoptions VALUES ('sp-c1', 'active', '{"plan":{"name":"@dsh-ray/evolved-from-plan"}}', '{"version":"0.2.0"}');`)
    caDb.close()

    // 7. Symlinked local package in node_modules + >256 plugins + oversized names/diagnostics + negative now
    await writeFile(join(localCheckout, 'package.json'), JSON.stringify({ name: '@dsh-ray/local-symlinked', version: '0.1.83' }), 'utf8')
    await symlink(localCheckout, join(scopeDir, 'local-symlinked'))
    for (let i = 0; i < 260; i += 1) {
      const pDir = join(scopeDir, `plug-${String(i).padStart(3, '0')}`)
      await mkdir(pDir, { recursive: true })
      await writeFile(join(pDir, 'package.json'), JSON.stringify({ name: `@dsh-ray/plug-${String(i).padStart(3, '0')}`, version: '0.1.83' }), 'utf8')
    }
    const longPluginName = `@dsh-ray/${'x'.repeat(210)}`
    const ctx = new Context()
    ctx.provide('loader' as never, {
      entries: () => [
        { options: { name: longPluginName } },
      ],
    } as never)

    try {
      const report = await collectDeliveryVersionReport({
        ctx,
        dshHome: home,
        profile: 'lark',
        now: -5,
        extraDiagnostics: Array.from({ length: 135 }, (_, idx) => `diag-${idx}-${'d'.repeat(1_200)}`),
      })
      expect(report.generatedAt).toBeGreaterThanOrEqual(0)
      expect(await readdir(wiDir)).toEqual(['state.sqlite'])
      expect((await stat(wiDbPath)).mtimeMs).toBe(wiMtimeBefore)
      expect((await readdir(gdDir)).sort()).toEqual(['usage.sqlite', 'usage.sqlite-wal'])
      expect(report.selfIteration.workItemsTotal).toBe(1)
      expect(report.selfIteration.growthUsageJobsTotal).toBe(1)
      expect(report.selfIteration.dreamingRuns).toBe(1)
      expect(report.selfIteration.recoveryRuns).toBeNull()
      expect(report.selfIteration.evolutionRulesAdopted).toBeNull()
      expect(report.selfIteration.pluginsRevised).toBe(1)
      expect(report.plugins.coreCount).toBeGreaterThan(256)
      expect(report.plugins.core.length).toBeLessThanOrEqual(256)
      expect(report.plugins.core.every(p => p.name.length >= 1 && p.name.length <= 200)).toBe(true)
      expect(report.plugins.core.some(p => p.name === '@dsh-ray/local-symlinked' && p.installKind === 'local' && p.version === '0.1.83')).toBe(true)
      expect(report.plugins.evolved.find(p => p.name === '@dsh-ray/evolved-from-plan')).toMatchObject({ version: '0.2.0', enabled: true })
      expect(report.diagnostics!.length).toBeLessThanOrEqual(128)
      expect(report.diagnostics!.every(d => d.length >= 1 && d.length <= 1024)).toBe(true)
    } finally {
      liveWriter.close()
      await chmod(roWalDir, 0o700).catch(() => {})
    }
  })
})
