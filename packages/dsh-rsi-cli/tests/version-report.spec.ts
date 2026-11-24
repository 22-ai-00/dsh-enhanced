import { chmod, link, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  collectVersionReport,
  formatVersionReport,
  version as CLI_VERSION,
} from '../src/index.ts'

const tempDirs: string[] = []
const restoreModes: Array<{ path: string; mode: number }> = []

afterEach(async () => {
  while (restoreModes.length > 0) {
    const item = restoreModes.pop()!
    await chmod(item.path, item.mode).catch(() => {})
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

async function createTempDir(prefix = 'dsh-rsi-version-report-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function execSqlite(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

async function createProfileSkeleton(
  dshHome: string,
  profile: string,
  plugins: Array<{ slug: string; version: string }>,
  patchYaml?: string,
): Promise<void> {
  const profDir = join(dshHome, 'profiles', profile)
  await mkdir(profDir, { recursive: true })
  await writeFile(join(profDir, 'package.json'), JSON.stringify({ name: `dsh-profile-${profile}`, private: true }), 'utf8')
  for (const plugin of plugins) {
    const pkgDir = join(profDir, 'node_modules', '@dsh-enhanced', plugin.slug)
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: `@dsh-enhanced/${plugin.slug}`, version: plugin.version }),
      'utf8',
    )
  }
  if (patchYaml !== undefined) {
    await writeFile(join(profDir, 'cordis.patch.yml'), patchYaml, 'utf8')
  }
}

describe('collectVersionReport & formatVersionReport', () => {
  test('缺失 DSH_HOME 时不崩溃，返回 no-data / unavailable 且全部统计字段为 null', async () => {
    const root = await createTempDir()
    const missingHome = join(root, 'does-not-exist')

    const report = await collectVersionReport({
      dshHome: missingHome,
      now: 1_700_000_000_000,
      runningVersion: null,
    })

    expect(report.schemaVersion).toBe(1)
    expect(report.protocol).toBe('dsh-rsi/version/v1')
    expect(report.generatedAt).toBe(1_700_000_000_000)
    expect(report.assistant).toEqual({
      name: 'dsh-enhanced',
      version: CLI_VERSION,
      cliVersion: CLI_VERSION,
    })
    expect(report.host).toEqual({
      packageName: '@deepseek-ai/dsh',
      boundVersion: null,
      boundStatus: 'missing',
      runningVersion: null,
    })
    expect(report.profile).toBeNull()
    expect(report.profiles).toEqual([])
    expect(report.plugins).toEqual({
      state: 'unavailable',
      coreCount: 0,
      evolvedCount: 0,
      activeEvolvedCount: 0,
      core: [],
      evolved: [],
    })
    expect(report.selfIteration).toEqual({
      dataState: 'no-data',
      totalIterations: null,
      workItemsTotal: null,
      workItemsSettled: null,
      growthUsageJobsTotal: null,
      dreamingRuns: null,
      recoveryRuns: null,
      goalStrategyRuns: null,
      candidatesGenerated: null,
      candidatesAdopted: null,
      pluginsCreated: null,
      pluginsRevised: null,
      taskVerificationsDone: null,
      rollbacks: null,
      evolutionRulesAdopted: null,
      associationParamVersion: null,
      associationProfileAdoptions: null,
      evaluationAttentionTuningAdoptions: null,
      evaluationLooseningDecisionsAdopted: null,
      activeMemories: null,
      activePreferenceOverlays: null,
      workflowCandidatesPromoted: null,
      skillDeployments: null,
      selfUpgrades: null,
      backupSnapshotsCount: null,
    })

    // Passing a valid non-existent --profile still returns exit-safe report, while path traversal throws.
    const withMissingProfile = await collectVersionReport({
      dshHome: missingHome,
      profile: 'web',
      runningVersion: null,
    })
    expect(withMissingProfile.profile).toBe('web')
    expect(withMissingProfile.selfIteration.dataState).toBe('no-data')
    await expect(collectVersionReport({ dshHome: missingHome, profile: '../escape' })).rejects.toThrow(/无效/)
  })

  test('已初始化但空账本返回 zero（已见表为 0，未见表保持 null）', async () => {
    const dshHome = await createTempDir()
    await mkdir(join(dshHome, 'assistant-work-items'), { recursive: true })
    await mkdir(join(dshHome, '.dsh-enhanced'), { recursive: true })
    await mkdir(join(dshHome, '.dsh-rsi-upgrade-backups'), { recursive: true })
    await writeFile(join(dshHome, '.dsh-enhanced', 'upgrade-history.jsonl'), '', 'utf8')

    await createProfileSkeleton(
      dshHome,
      'web',
      [{ slug: 'assistant-work-items', version: '0.1.83' }],
      `- id: dsh-enhanced-assistant-work-items
  name: "@dsh-enhanced/assistant-work-items"
  config:
    enabled: true
    databasePath: !js dshHomePath('assistant-work-items', 'web.sqlite')
`,
    )

    execSqlite(
      join(dshHome, 'assistant-work-items', 'web.sqlite'),
      `CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       CREATE TABLE work_item_outcome (item_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(item_id, revision));`,
    )

    const report = await collectVersionReport({
      dshHome,
      runningVersion: '0.2.2-rc.5',
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: join(dshHome, '.dsh-rsi-host.json'),
        version: '0.2.2-rc.5',
        dshPath: '/opt/dsh/bin/dsh',
        issues: [],
      }),
    })

    expect(report.host.boundVersion).toBe('0.2.2-rc.5')
    expect(report.host.boundStatus).toBe('ready')
    expect(report.host.runningVersion).toBe('0.2.2-rc.5')
    expect(report.plugins.state).toBe('ok')
    expect(report.plugins.coreCount).toBe(1)
    expect(report.plugins.core[0]).toEqual({
      name: '@dsh-enhanced/assistant-work-items',
      version: '0.1.83',
      kind: 'core',
      installKind: 'npm',
      enabled: true,
    })
    expect(report.selfIteration.dataState).toBe('zero')
    expect(report.selfIteration.totalIterations).toBe(0)
    expect(report.selfIteration.workItemsTotal).toBe(0)
    expect(report.selfIteration.workItemsSettled).toBe(0)
    expect(report.selfIteration.selfUpgrades).toBe(0)
    expect(report.selfIteration.backupSnapshotsCount).toBe(0)
    // Unseen subsystem tables remain null
    expect(report.selfIteration.dreamingRuns).toBeNull()
    expect(report.selfIteration.recoveryRuns).toBeNull()
    expect(report.selfIteration.goalStrategyRuns).toBeNull()
    expect(report.selfIteration.skillDeployments).toBeNull()
  })

  test('聚合多账本自迭代统计并避免生命周期双重计数与核心/自演进插件重叠', async () => {
    const dshHome = await createTempDir()
    for (const sub of [
      'assistant-work-items',
      'assistant-growth-driver',
      'assistant-dreaming',
      'assistant-recovery',
      'assistant-goals',
      'assistant-memory-learning',
      'personal-memory',
      'preference-learning',
      'assistant-evolution',
      'assistant-skills',
      'assistant-growth-experiments',
      'assistant-association',
      'assistant-evaluation',
      'assistant-verifier',
      'plugin-control-plane',
      '.dsh-enhanced',
      '.dsh-rsi-upgrade-backups/snap-1',
      '.dsh-rsi-upgrade-backups/snap-2',
      '.dsh-rsi-upgrade-backups/.ignored-hidden',
    ]) {
      await mkdir(join(dshHome, sub), { recursive: true })
    }

    await createProfileSkeleton(
      dshHome,
      'web',
      [
        { slug: 'assistant-work-items', version: '0.1.83' },
        { slug: 'assistant-evolution', version: '0.1.83' },
        { slug: 'evolved-tool-a', version: '0.1.0' },
      ],
      `- id: dsh-enhanced-assistant-work-items
  name: "@dsh-enhanced/assistant-work-items"
  config:
    enabled: true
    databasePath: !js dshHomePath('assistant-work-items', 'web.sqlite')
- id: dsh-enhanced-assistant-evolution
  name: "@dsh-enhanced/assistant-evolution"
  disabled: true
  config:
    enabled: false
    databasePath: !js dshHomePath('assistant-evolution', 'web.sqlite')
- id: dsh-enhanced-assistant-goals
  name: "@dsh-enhanced/assistant-goals"
  config:
    databasePath: !!js dshHomePath('assistant-goals', 'custom-goals.sqlite')
`,
    )

    // 1. Work items: 3 items, 2 distinct settled item_ids (3 outcome revisions total)
    execSqlite(
      join(dshHome, 'assistant-work-items', 'web.sqlite'),
      `CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       CREATE TABLE work_item_outcome (item_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(item_id, revision));
       INSERT INTO work_item VALUES ('w1', 'ready'), ('w2', 'working'), ('w3', 'queued');
       INSERT INTO work_item_outcome VALUES ('w1', 1), ('w1', 2), ('w2', 1);`,
    )

    // 2. Growth driver
    execSqlite(
      join(dshHome, 'assistant-growth-driver', 'web-usage.sqlite'),
      `CREATE TABLE usage_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO usage_jobs VALUES ('u1', 'reviewed'), ('u2', 'queued');`,
    )

    // 3. Dreaming
    execSqlite(
      join(dshHome, 'assistant-dreaming', 'web.sqlite'),
      `CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT NOT NULL);
       CREATE TABLE dream_ideas (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO dream_runs VALUES ('d1', 'completed'), ('d2', 'completed');
       INSERT INTO dream_ideas VALUES ('i1', 'validated'), ('i2', 'owner-acknowledged');`,
    )

    // 4. Recovery
    execSqlite(
      join(dshHome, 'assistant-recovery', 'web.sqlite'),
      `CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
       INSERT INTO recovery_runs VALUES ('r1', 'succeeded');`,
    )

    // 5. Goal strategies (at `${databasePath}.strategies`)
    execSqlite(
      join(dshHome, 'assistant-goals', 'custom-goals.sqlite.strategies'),
      `CREATE TABLE goal_strategy_records (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO goal_strategy_records VALUES ('gs1', 'settled'), ('gs2', 'settled');`,
    )

    // 6. Memory learning
    execSqlite(
      join(dshHome, 'assistant-memory-learning', 'web.sqlite'),
      `CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO jobs VALUES ('ml1', 'adopted'), ('ml2', 'adopted'), ('ml3', 'failed');`,
    )

    // 7. Personal memory
    execSqlite(
      join(dshHome, 'personal-memory', 'web.sqlite'),
      `CREATE TABLE memory_records (id TEXT PRIMARY KEY, status TEXT NOT NULL);
       INSERT INTO memory_records VALUES ('m1', 'active'), ('m2', 'active'), ('m3', 'removed');`,
    )

    // 8. Preference learning
    execSqlite(
      join(dshHome, 'preference-learning', 'web.sqlite'),
      `CREATE TABLE preference_hypotheses (id TEXT PRIMARY KEY, effect_state TEXT NOT NULL);
       CREATE TABLE preference_transitions (id INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT NOT NULL);
       INSERT INTO preference_hypotheses VALUES ('p1', 'active'), ('p2', 'rolled-back');
       INSERT INTO preference_transitions(reason) VALUES ('created'), ('activated'), ('regression');`,
    )

    // 9. Evolution (disabled in cordis.patch.yml, still readable!)
    execSqlite(
      join(dshHome, 'assistant-evolution', 'web.sqlite'),
      `CREATE TABLE evolution_proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL);
       CREATE TABLE evolution_rules (id TEXT PRIMARY KEY, status TEXT NOT NULL);
       CREATE TABLE evolution_autonomous_rollbacks (idempotency_key TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL);
       INSERT INTO evolution_proposals VALUES ('ep1', 'approved'), ('ep2', 'pending');
       INSERT INTO evolution_rules VALUES ('er1', 'active');
       INSERT INTO evolution_autonomous_rollbacks VALUES ('rb1', 1000);`,
    )

    // 10. Skills
    execSqlite(
      join(dshHome, 'assistant-skills', 'web.sqlite'),
      `CREATE TABLE skill_candidates (scope_key TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(scope_key, id));
       CREATE TABLE skill_deployments (scope_key TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(scope_key, id));
       INSERT INTO skill_candidates VALUES ('s', 'sc1'), ('s', 'sc2');
       INSERT INTO skill_deployments VALUES ('s', 'sd1', 'promoted'), ('s', 'sd2', 'canary'), ('s', 'sd3', 'rolled-back');`,
    )

    // 11. Growth experiments
    execSqlite(
      join(dshHome, 'assistant-growth-experiments', 'web.sqlite'),
      `CREATE TABLE workflow_candidates (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO workflow_candidates VALUES ('wc1', 'promoted'), ('wc2', 'rolled-back'), ('wc3', 'observing');`,
    )

    // 12. Association
    execSqlite(
      join(dshHome, 'assistant-association', 'web.sqlite'),
      `CREATE TABLE assoc_param_profile_heads (scope_key TEXT PRIMARY KEY, active_version INTEGER NOT NULL);
       CREATE TABLE assoc_param_profile_events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL);
       INSERT INTO assoc_param_profile_heads VALUES ('default', 4);
       INSERT INTO assoc_param_profile_events VALUES (1, 'adopted'), (2, 'adopted'), (3, 'rolled-back');`,
    )

    // 13. Evaluation
    execSqlite(
      join(dshHome, 'assistant-evaluation', 'web.sqlite'),
      `CREATE TABLE evaluation_attention_tuning_events (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL);
       CREATE TABLE evaluation_attention_loosening_decisions (proposal_id TEXT PRIMARY KEY, decision TEXT NOT NULL);
       INSERT INTO evaluation_attention_tuning_events VALUES (1, 'adopted'), (2, 'adopted'), (3, 'rolled-back');
       INSERT INTO evaluation_attention_loosening_decisions VALUES ('l1', 'adopted'), ('l2', 'rejected');`,
    )

    // 14. Verifier
    execSqlite(
      join(dshHome, 'assistant-verifier', 'web.sqlite'),
      `CREATE TABLE acceptance_jobs (contract_id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO acceptance_jobs VALUES ('aj1', 'done'), ('aj2', 'done'), ('aj3', 'pending');`,
    )

    // 15. Control plane: creation-adoptions + revision-adoptions + control.sqlite
    execSqlite(
      join(dshHome, 'plugin-control-plane', 'creation-adoptions.sqlite'),
      `CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, certificate_json TEXT NOT NULL);
       INSERT INTO adoptions VALUES ('plan-c1', 'active', '{"plan":{"name":"@dsh-enhanced/evolved-tool-a"}}');
       INSERT INTO adoptions VALUES ('plan-c2', 'closed', '{"plan":{"name":"@dsh-enhanced/evolved-tool-retired"}}');`,
    )
    execSqlite(
      join(dshHome, 'plugin-control-plane', 'revision-adoptions.sqlite'),
      `CREATE TABLE entries (entry_id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_plan_id TEXT NOT NULL, current_plan_id TEXT NOT NULL, revision INTEGER NOT NULL);
       CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL);
       CREATE TABLE rollbacks (seq INTEGER PRIMARY KEY, rollback_id TEXT NOT NULL);
       INSERT INTO entries VALUES ('e1', '@dsh-enhanced/evolved-tool-a', 'plan-c1', 'plan-r1', 3);
       INSERT INTO adoptions VALUES ('plan-r1', 'active'), ('plan-r2', 'closed');
       INSERT INTO rollbacks VALUES (1, 'rb-rev-1');`,
    )
    execSqlite(
      join(dshHome, 'plugin-control-plane', 'control.sqlite'),
      `CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT NOT NULL, mode TEXT, status TEXT NOT NULL);
       CREATE TABLE activation_plans (id TEXT PRIMARY KEY, profile TEXT NOT NULL, candidate_json TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
       CREATE TABLE source_adoptions (source_plan_id TEXT NOT NULL, activation_plan_id TEXT NOT NULL);
       CREATE TABLE activation_watch (plan_id TEXT PRIMARY KEY, package_name TEXT NOT NULL, package_version TEXT NOT NULL, state TEXT NOT NULL);
       INSERT INTO source_plans VALUES ('sp-1', '@dsh-enhanced/evolved-tool-c', 'create', 'release-complete');
       INSERT INTO source_plans VALUES ('sp-2', '@dsh-enhanced/assistant-work-items', 'modify', 'release-complete');
       INSERT INTO activation_plans VALUES ('act-1', 'web', '{"package":"@dsh-enhanced/evolved-tool-c","version":"0.2.0"}', 'activated', 100);
       INSERT INTO activation_plans VALUES ('act-2', 'web', '{"package":"@dsh-enhanced/assistant-work-items","version":"0.1.83"}', 'activated', 101);
       INSERT INTO activation_plans VALUES ('act-3', 'web', '{"package":"@dsh-enhanced/evolved-tool-d","version":"0.1.0"}', 'rolled-back', 102);
       INSERT INTO source_adoptions VALUES ('sp-1', 'act-1'), ('sp-2', 'act-2');
       INSERT INTO activation_watch VALUES ('act-1', '@dsh-enhanced/evolved-tool-c', '0.2.0', 'watching');`,
    )

    // Upgrade history JSONL (2 valid entries + 1 blank line)
    await writeFile(
      join(dshHome, '.dsh-enhanced', 'upgrade-history.jsonl'),
      '{"at":1000,"to":"0.1.82"}\n\n{"at":2000,"to":"0.1.83"}\n',
      'utf8',
    )

    const report = await collectVersionReport({
      dshHome,
      runningVersion: '0.2.2-rc.5',
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: join(dshHome, '.dsh-rsi-host.json'),
        version: '0.2.2-rc.5',
        dshPath: '/opt/dsh/bin/dsh',
        issues: [],
      }),
    })

    expect(report.selfIteration.dataState).toBe('data')
    expect(report.selfIteration.workItemsTotal).toBe(3)
    expect(report.selfIteration.workItemsSettled).toBe(2) // distinct item_id, not 3 outcome rows
    expect(report.selfIteration.growthUsageJobsTotal).toBe(2)
    expect(report.selfIteration.dreamingRuns).toBe(2)
    expect(report.selfIteration.recoveryRuns).toBe(1)
    expect(report.selfIteration.goalStrategyRuns).toBe(2)
    expect(report.selfIteration.evolutionRulesAdopted).toBe(1) // read even though evolution row disabled: true
    expect(report.selfIteration.associationParamVersion).toBe(4)
    expect(report.selfIteration.associationProfileAdoptions).toBe(2)
    expect(report.selfIteration.evaluationAttentionTuningAdoptions).toBe(2)
    expect(report.selfIteration.evaluationLooseningDecisionsAdopted).toBe(1)
    expect(report.selfIteration.activeMemories).toBe(2)
    expect(report.selfIteration.activePreferenceOverlays).toBe(1)
    expect(report.selfIteration.workflowCandidatesPromoted).toBe(1)
    expect(report.selfIteration.skillDeployments).toBe(2)
    expect(report.selfIteration.taskVerificationsDone).toBe(2)
    expect(report.selfIteration.selfUpgrades).toBe(2)
    expect(report.selfIteration.backupSnapshotsCount).toBe(2)

    // Anti-double-counting checks for creation / revision / adoption / rollbacks
    // pluginsCreated: plan-c1 + act-1 (sp-1 linked to act-1 -> 1) = 2
    expect(report.selfIteration.pluginsCreated).toBe(2)
    // pluginsRevised: plan-r1 + act-2 (sp-2 linked to act-2 -> 1) = 2
    expect(report.selfIteration.pluginsRevised).toBe(2)
    // candidatesGenerated: 3 (ml jobs) + 2 (source_plans) + 1 (unlinked act-3) + 2 (skill_cand) + 2 (usage_jobs) + 2 (pref_hypotheses) + 2 (evo_proposals) + 3 (wf_candidates) = 17
    expect(report.selfIteration.candidatesGenerated).toBe(17)
    // candidatesAdopted: 2 (ml) + 1 (plan-c1) + 1 (plan-r1) + 2 (act-1, act-2; sp-1 & sp-2 are linked so NOT double-counted) + 2 (skills) + 1 (pref) + 1 (evo_rules) + 1 (wf) = 11
    expect(report.selfIteration.candidatesAdopted).toBe(11)
    // rollbacks: 1 (act-3) + 1 (rev rollbacks; plan-r2 closed NOT double-counted) + 1 (evo) + 1 (skills) + 1 (wf) + 1 (pref) + 1 (assoc) + 1 (eval) = 8
    expect(report.selfIteration.rollbacks).toBe(8)
    // totalIterations = 3 + 2 + 2 + 1 + 2 + 1 + 2 + 2 + 1 + 2 = 18
    expect(report.selfIteration.totalIterations).toBe(18)

    // Core vs evolved separation:
    // - @dsh-enhanced/assistant-work-items stays in core (despite sp-2 modify patch)
    // - @dsh-enhanced/assistant-evolution stays in core with enabled: false
    // - @dsh-enhanced/evolved-tool-a is updated in-place to v3 and NOT duplicated in core
    expect(report.plugins.core.map(p => p.name)).toEqual([
      '@dsh-enhanced/assistant-evolution',
      '@dsh-enhanced/assistant-work-items',
    ])
    expect(report.plugins.core.find(p => p.name === '@dsh-enhanced/assistant-evolution')?.enabled).toBe(false)
    expect(report.plugins.evolved.map(p => p.name)).toEqual([
      '@dsh-enhanced/evolved-tool-a',
      '@dsh-enhanced/evolved-tool-c',
      '@dsh-enhanced/evolved-tool-d',
      '@dsh-enhanced/evolved-tool-retired',
    ])
    expect(report.plugins.evolved.find(p => p.name === '@dsh-enhanced/evolved-tool-a')).toEqual({
      name: '@dsh-enhanced/evolved-tool-a',
      version: 'v3',
      kind: 'evolved',
      installKind: 'adopted',
      enabled: true,
    })
    expect(report.plugins.coreCount).toBe(2)
    expect(report.plugins.evolvedCount).toBe(4)
    expect(report.plugins.activeEvolvedCount).toBe(2)

    expect(report.extensions?.dreamingIdeas).toEqual({ total: 2, validated: 1, ownerAcknowledged: 1 })
    expect(report.extensions?.latestUpgrade).toEqual({ at: 2000, to: '0.1.83' })

    const text = formatVersionReport(report)
    expect(text).toContain(`dsh-enhanced v${CLI_VERSION}`)
    expect(text).toContain('0.2.2-rc.5')
    expect(text).toContain('@dsh-enhanced/assistant-work-items@0.1.83')
    expect(text).toContain('@dsh-enhanced/evolved-tool-a@v3')
    expect(text).toContain('累计迭代次数：18')
  })

  test('拒绝符号链接越界账本、按 realpath 去重共享账本、严格隔离 profile、支持只读目录回退与损坏文件降级', async () => {
    const root = await createTempDir()
    const dshHome = join(root, 'dsh-home')
    const outsideDir = join(root, 'outside')
    await mkdir(join(dshHome, 'shared'), { recursive: true })
    await mkdir(join(dshHome, 'assistant-work-items'), { recursive: true })
    await mkdir(join(dshHome, 'assistant-dreaming'), { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    // Shared DB referenced by both profiles `a` and `b`
    const sharedDb = join(dshHome, 'shared', 'work.sqlite')
    execSqlite(
      sharedDb,
      `CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO work_item VALUES ('shared-1', 'ready'), ('shared-2', 'ready');`,
    )

    // Profile `b` private dreaming DB (must NOT leak into `--profile a`)
    execSqlite(
      join(dshHome, 'assistant-dreaming', 'b.sqlite'),
      `CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT NOT NULL);
       INSERT INTO dream_runs VALUES ('b-dream-1', 'completed');`,
    )

    // Outside DB symlinked into assistant-recovery/state.sqlite (must be rejected!)
    const outsideDb = join(outsideDir, 'secret.sqlite')
    execSqlite(outsideDb, `CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO recovery_runs VALUES ('x', 'succeeded');`)
    await mkdir(join(dshHome, 'assistant-recovery'), { recursive: true })
    await symlink(outsideDb, join(dshHome, 'assistant-recovery', 'state.sqlite'))

    // Corrupt SQLite file at assistant-skills/a.sqlite (must degrade to diagnostics without crashing)
    await mkdir(join(dshHome, 'assistant-skills'), { recursive: true })
    await writeFile(join(dshHome, 'assistant-skills', 'a.sqlite'), 'not a sqlite database', 'utf8')

    // Read-only 0555 directory for assistant-evolution/a.sqlite (must open via ?mode=ro&immutable=1 fallback)
    const roDir = join(dshHome, 'assistant-evolution')
    await mkdir(roDir, { recursive: true })
    execSqlite(
      join(roDir, 'a.sqlite'),
      `CREATE TABLE evolution_rules (id TEXT PRIMARY KEY, status TEXT NOT NULL);
       INSERT INTO evolution_rules VALUES ('ro-rule-1', 'active');`,
    )
    await chmod(roDir, 0o555)
    restoreModes.push({ path: roDir, mode: 0o755 })

    await createProfileSkeleton(
      dshHome,
      'a',
      [{ slug: 'assistant-work-items', version: '0.1.83' }],
      `- id: dsh-enhanced-assistant-work-items
  name: "@dsh-enhanced/assistant-work-items"
  config:
    databasePath: !js dshHomePath('shared', 'work.sqlite')
- id: dsh-enhanced-assistant-evolution
  name: "@dsh-enhanced/assistant-evolution"
  config:
    databasePath: !js dshHomePath('assistant-evolution', 'a.sqlite')
- id: dsh-enhanced-assistant-skills
  name: "@dsh-enhanced/assistant-skills"
  config:
    databasePath: !js dshHomePath('assistant-skills', 'a.sqlite')
- id: dsh-enhanced-assistant-recovery
  name: "@dsh-enhanced/assistant-recovery"
  config:
    databasePath: !!js dshHomePath('..', 'outside', 'secret.sqlite')
`,
    )
    await createProfileSkeleton(
      dshHome,
      'b',
      [{ slug: 'assistant-dreaming', version: '0.1.83' }],
      `- id: dsh-enhanced-assistant-work-items
  name: "@dsh-enhanced/assistant-work-items"
  config:
    databasePath: !js dshHomePath('shared', 'work.sqlite')
- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
  config:
    databasePath: !js dshHomePath('assistant-dreaming', 'b.sqlite')
`,
    )

    // 1. All-profiles report deduplicates shared DB by realpath
    const allReport = await collectVersionReport({ dshHome, runningVersion: null })
    const canonicalShared = await realpath(sharedDb)
    expect(allReport.inspectedLedgers?.filter(p => p === canonicalShared)).toHaveLength(1)
    expect(allReport.selfIteration.workItemsTotal).toBe(2) // NOT 4
    expect(allReport.selfIteration.dreamingRuns).toBe(1)
    expect(allReport.selfIteration.evolutionRulesAdopted).toBe(1) // read cleanly from 0555 dir
    expect(allReport.selfIteration.recoveryRuns).toBeNull() // outside symlink & path escape rejected
    expect(allReport.diagnostics?.some(d => d.includes('越界') || d.includes('符号链接'))).toBe(true)
    expect(allReport.diagnostics?.some(d => d.includes('assistant-skills'))).toBe(true)

    // 2. Profile `a` report excludes `b`'s dreaming DB and plugins
    const profAReport = await collectVersionReport({ dshHome, profile: 'a', runningVersion: null })
    expect(profAReport.profile).toBe('a')
    expect(profAReport.plugins.core.map(p => p.name)).toEqual(['@dsh-enhanced/assistant-work-items'])
    expect(profAReport.selfIteration.workItemsTotal).toBe(2)
    expect(profAReport.selfIteration.dreamingRuns).toBeNull()

    const formatted = formatVersionReport(profAReport)
    expect(formatted).toContain('Dreaming：—')
    expect(formatted).toContain('诊断提示')
  })

  test('已停止的可写 WAL 模式 $DSH_HOME 读取时不生成 -wal/-shm 附属文件，且保留活跃 WAL 读取与只读目录安全拒绝', async () => {
    const root = await createTempDir()
    const dshHome = join(root, 'dsh-home')
    const wiDir = join(dshHome, 'assistant-work-items')
    const gdDir = join(dshHome, 'assistant-growth-driver')
    const liveDir = join(dshHome, 'assistant-dreaming')
    const roWalDir = join(dshHome, 'assistant-recovery')
    const roSymlinkWalDir = join(dshHome, 'assistant-evolution')
    const roSymlinkShmDir = join(dshHome, 'assistant-skills')
    for (const dir of [wiDir, gdDir, liveDir, roWalDir, roSymlinkWalDir, roSymlinkShmDir]) {
      await mkdir(dir, { recursive: true })
    }

    // 1. Cleanly stopped WAL-mode DB in 0755 dir (no -wal, no -shm)
    const wiDbPath = join(wiDir, 'state.sqlite')
    execSqlite(
      wiDbPath,
      `PRAGMA journal_mode = WAL;
       CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO work_item VALUES ('wal-1', 'ready'), ('wal-2', 'done');`,
    )
    for (const suffix of ['-wal', '-shm']) {
      await unlink(`${wiDbPath}${suffix}`).catch(() => {})
    }

    // 2. Cleanly stopped WAL-mode DB in 0755 dir with 0-byte -wal and no -shm
    const gdDbPath = join(gdDir, 'usage.sqlite')
    execSqlite(
      gdDbPath,
      `PRAGMA journal_mode = WAL;
       CREATE TABLE usage_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL);
       INSERT INTO usage_jobs VALUES ('u-wal-1', 'reviewed');`,
    )
    await unlink(`${gdDbPath}-shm`).catch(() => {})
    await writeFile(`${gdDbPath}-wal`, '', 'utf8')

    // 3. Live WAL-mode DB in 0755 dir with uncheckpointed data in -wal + -shm
    const liveDbPath = join(liveDir, 'state.sqlite')
    const liveWriter = new DatabaseSync(liveDbPath)
    liveWriter.exec(
      `PRAGMA journal_mode = WAL;
       PRAGMA wal_autocheckpoint = 0;
       CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT NOT NULL);
       INSERT INTO dream_runs VALUES ('live-d1', 'completed');`,
    )

    // 4. 0555 read-only dir with non-empty -wal (must refuse immutable=1 and emit diagnostic)
    const roWalDbPath = join(roWalDir, 'state.sqlite')
    execSqlite(
      roWalDbPath,
      `CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
       INSERT INTO recovery_runs VALUES ('ro-r1', 'succeeded');`,
    )
    await writeFile(`${roWalDbPath}-wal`, 'non-empty-wal-bytes', 'utf8')
    await chmod(roWalDir, 0o555)
    restoreModes.push({ path: roWalDir, mode: 0o755 })

    // 5. 0555 read-only dir with symlink -wal (must refuse immutable=1 / symlink traversal)
    const roSymWalDbPath = join(roSymlinkWalDir, 'state.sqlite')
    execSqlite(
      roSymWalDbPath,
      `CREATE TABLE evolution_rules (id TEXT PRIMARY KEY, status TEXT NOT NULL);
       INSERT INTO evolution_rules VALUES ('sym-e1', 'active');`,
    )
    await symlink(join(root, 'outside-wal'), `${roSymWalDbPath}-wal`)
    await chmod(roSymlinkWalDir, 0o555)
    restoreModes.push({ path: roSymlinkWalDir, mode: 0o755 })

    // 6. 0555 read-only dir with symlink -shm (must refuse immutable=1 / symlink traversal)
    const roSymShmDbPath = join(roSymlinkShmDir, 'state.sqlite')
    execSqlite(
      roSymShmDbPath,
      `CREATE TABLE skill_candidates (scope_key TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(scope_key, id));
       INSERT INTO skill_candidates VALUES ('s', 'sc-1');`,
    )
    await symlink(join(root, 'outside-shm'), `${roSymShmDbPath}-shm`)
    await chmod(roSymlinkShmDir, 0o555)
    restoreModes.push({ path: roSymlinkShmDir, mode: 0o755 })

    try {
      const beforeWiFiles = (await readdir(wiDir)).sort()
      const beforeGdFiles = (await readdir(gdDir)).sort()
      expect(beforeWiFiles).toEqual(['state.sqlite'])
      expect(beforeGdFiles).toEqual(['usage.sqlite', 'usage.sqlite-wal'])

      const report = await collectVersionReport({ dshHome, runningVersion: null })

      const afterWiFiles = (await readdir(wiDir)).sort()
      const afterGdFiles = (await readdir(gdDir)).sort()
      expect(afterWiFiles).toEqual(['state.sqlite'])
      expect(afterGdFiles).toEqual(['usage.sqlite', 'usage.sqlite-wal'])

      expect(report.selfIteration.workItemsTotal).toBe(2)
      expect(report.selfIteration.growthUsageJobsTotal).toBe(1)
      expect(report.selfIteration.dreamingRuns).toBe(1)
      expect(report.selfIteration.recoveryRuns).toBeNull()
      expect(report.selfIteration.evolutionRulesAdopted).toBeNull()
      expect(report.selfIteration.candidatesGenerated).toBe(1) // only growthUsageJobsTotal=1; skill_candidates skipped
      expect(report.diagnostics?.some(d => d.includes('assistant-recovery'))).toBe(true)
      expect(report.diagnostics?.some(d => d.includes('assistant-evolution'))).toBe(true)
      expect(report.diagnostics?.some(d => d.includes('assistant-skills'))).toBe(true)
    } finally {
      liveWriter.close()
    }
  })

  test('兼容缺失 certificate_json 与 parent_plan_id 的旧版 control-plane 表结构', async () => {
    const dshHome = await createTempDir()
    const cpDir = join(dshHome, 'plugin-control-plane')
    await mkdir(cpDir, { recursive: true })

    execSqlite(
      join(cpDir, 'creation-adoptions.sqlite'),
      `CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL);
       INSERT INTO adoptions VALUES ('legacy-c1', 'active');`,
    )
    execSqlite(
      join(cpDir, 'revision-adoptions.sqlite'),
      `CREATE TABLE entries (entry_id TEXT PRIMARY KEY, name TEXT NOT NULL, current_plan_id TEXT, revision INTEGER);
       CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL);
       INSERT INTO entries VALUES ('e-legacy', '@dsh-enhanced/legacy-evolved', 'legacy-r1', 2);
       INSERT INTO adoptions VALUES ('legacy-r1', 'active');`,
    )

    const report = await collectVersionReport({ dshHome, runningVersion: null })
    expect(report.assistant.version).toBe(CLI_VERSION)
    expect(report.selfIteration.pluginsCreated).toBe(1)
    expect(report.selfIteration.pluginsRevised).toBe(1)
    expect(report.plugins.evolved).toEqual([
      {
        name: '@dsh-enhanced/legacy-evolved',
        version: 'v2',
        kind: 'evolved',
        installKind: 'adopted',
        enabled: true,
      },
      {
        name: 'legacy-c1',
        version: 'v1',
        kind: 'evolved',
        installKind: 'adopted',
        enabled: true,
      },
    ])
  })

  test('拒绝硬链接越界账本与附属文件、支持 --profile 控制面查询与 prepared-revise，且严格截断超长诊断与超量插件', async () => {
    const root = await createTempDir()
    const dshHome = join(root, 'dsh-home')
    const outsideDir = join(root, 'outside')
    await mkdir(join(dshHome, 'assistant-work-items'), { recursive: true })
    await mkdir(join(dshHome, 'assistant-dreaming'), { recursive: true })
    await mkdir(join(dshHome, 'plugin-control-plane'), { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    // Hardlink escape .sqlite -> nlink === 2 must be rejected
    const outsideDb = join(outsideDir, 'hardlinked.sqlite')
    execSqlite(outsideDb, `CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT); INSERT INTO work_item VALUES ('hl-1', 'settled');`)
    await link(outsideDb, join(dshHome, 'assistant-work-items', 'state.sqlite'))

    // Hardlink escape -wal sidecar -> nlink === 2 must be rejected
    const dreamDb = join(dshHome, 'assistant-dreaming', 'state.sqlite')
    execSqlite(dreamDb, `CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT); INSERT INTO dream_runs VALUES ('d-hl', 'completed');`)
    const outsideWal = join(outsideDir, 'evil.wal')
    await writeFile(outsideWal, '', 'utf8')
    await link(outsideWal, `${dreamDb}-wal`)

    // Control-plane with minimal activation_plans & prepared-revise (profile does not list plugin-control-plane)
    execSqlite(
      join(dshHome, 'plugin-control-plane', 'control.sqlite'),
      `CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT NOT NULL, mode TEXT, status TEXT NOT NULL);
       CREATE TABLE activation_plans (id TEXT PRIMARY KEY, profile TEXT NOT NULL, status TEXT NOT NULL);
       INSERT INTO source_plans VALUES
         ('sp-c1', '@dsh-enhanced/evolved-alpha', 'create', 'release-complete'),
         ('sp-r1', '@dsh-enhanced/assistant-work-items', 'prepared-revise', 'release-complete');
       INSERT INTO activation_plans VALUES ('ap-1', 'web', 'activated');`,
    )

    // >256 plugins + oversized name (>200) + oversized diagnostics (>128)
    const manyPlugins: Array<{ slug: string; version: string }> = [
      { slug: `oversized-${'p'.repeat(210)}`, version: `1.0.0-${'v'.repeat(150)}` },
    ]
    for (let i = 0; i < 260; i += 1) {
      manyPlugins.push({ slug: `core-plug-${String(i).padStart(3, '0')}`, version: '0.1.83' })
    }
    await createProfileSkeleton(
      dshHome,
      'web',
      manyPlugins,
      `- id: dsh-enhanced-assistant-work-items
  name: "@dsh-enhanced/assistant-work-items"
  config:
    enabled: true
`,
    )
    // >128 diagnostics & >1024-char diagnostic path using valid nested subdirs (<255B per segment)
    const nestedSegments = Array.from({ length: 12 }, (_, idx) => `seg-${String(idx).padStart(2, '0')}-${'x'.repeat(90)}`)
    const longDiagDir = join(dshHome, 'assistant-recovery', ...nestedSegments)
    await mkdir(longDiagDir, { recursive: true })
    const longDiagDb = join(longDiagDir, 'corrupt.sqlite')
    await writeFile(longDiagDb, 'corrupt-bytes', 'utf8')
    await writeFile(join(dshHome, 'assistant-recovery', 'state.sqlite'), 'corrupt-bytes', 'utf8')
    await writeFile(join(dshHome, 'assistant-recovery', 'recovery.sqlite'), 'corrupt-bytes', 'utf8')
    await writeFile(join(dshHome, 'assistant-recovery', 'web.sqlite'), 'corrupt-bytes', 'utf8')
    const escapeEntries = Array.from({ length: 124 }, (_, idx) =>
      `- id: dsh-enhanced-assistant-skills-${idx}\n  name: "@dsh-enhanced/assistant-skills"\n  config:\n    databasePath: !js dshHomePath('..', 'outside-${idx}', 'db.sqlite')`,
    ).join('\n')
    await createProfileSkeleton(
      dshHome,
      'web',
      manyPlugins,
      `- id: dsh-enhanced-assistant-work-items
  name: "@dsh-enhanced/assistant-work-items"
  config:
    databasePath: !js dshHomePath('assistant-work-items', 'state.sqlite')
- id: dsh-enhanced-assistant-recovery
  name: "@dsh-enhanced/assistant-recovery"
  config:
    databasePath: !js dshHomePath('assistant-recovery', ${[...nestedSegments, 'corrupt.sqlite'].map(s => `'${s}'`).join(', ')})
${escapeEntries}
`,
    )

    const beforeWiStat = await stat(join(dshHome, 'assistant-work-items', 'state.sqlite'))
    expect(beforeWiStat.nlink).toBe(2)

    const report = await collectVersionReport({
      dshHome,
      profile: 'web',
      now: -42,
      runningVersion: null,
    })

    expect(report.generatedAt).toBeGreaterThanOrEqual(0)
    expect(report.selfIteration.workItemsTotal).toBeNull()
    expect(report.selfIteration.dreamingRuns).toBeNull()
    expect(report.selfIteration.pluginsCreated).toBe(1)
    expect(report.selfIteration.pluginsRevised).toBe(1)
    expect(report.selfIteration.candidatesAdopted).toBe(3)
    expect(report.plugins.core.length).toBeLessThanOrEqual(256)
    expect(report.plugins.coreCount).toBe(261)
    expect(report.plugins.core.every(p => p.name.length >= 1 && p.name.length <= 200)).toBe(true)
    expect(report.plugins.core.every(p => p.version === null || (p.version.length >= 1 && p.version.length <= 128))).toBe(true)
    expect(report.plugins.evolved.map(p => p.name)).toEqual(['@dsh-enhanced/evolved-alpha'])
    expect(report.diagnostics!.length).toBe(128)
    expect(report.diagnostics!.every(d => d.length >= 1 && d.length <= 1024)).toBe(true)
    expect(report.diagnostics!.some(d => d.includes('硬链接'))).toBe(true)
  })
})
