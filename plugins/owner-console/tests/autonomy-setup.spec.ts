import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { ownerRouteAuthorityHash } from '../../assistant-delivery/lib/index.js'
import { normalizeConfig as validateDreamingConfig } from '../../assistant-dreaming/lib/index.js'
import { normalizeConfig as validateGrowthConfig } from '../../assistant-growth-driver/lib/index.js'
import { validateLearningConfig } from '../../assistant-memory-learning/lib/index.js'
import { AssistantPolicyService } from '../../assistant-policy/lib/index.js'
import { validateMemoryReviewConfig } from '../../assistant-verifier/lib/index.js'
import { validateMemoryLearningAdoptionGrant } from '../../personal-memory/lib/index.js'
import {
  applyAutonomyWizardSetup,
  canonicalObjectDigest,
  inspectAutonomyWizardStatus,
  ownerRouteAuthorityHashLocal,
} from '../src/autonomy-setup.js'
import { OwnerConsoleService } from '../src/service.js'
import { AUTONOMY_TIER_DEFAULTS, TYPERT } from '../src/typert.js'

const CUSTOM_JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }

function createTempProfile() {
  const root = mkdtempSync(join(tmpdir(), 'owner-console-autonomy-'))
  const dshHome = join(root, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  const workspace = join(dshHome, 'assistant-workspace')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(dshHome, 'assistant-delivery'), { recursive: true })
  return { root, dshHome, profileDir, workspace }
}

function seedDeliveryOwnerSqlite(dbPath: string, profile = 'web', principalRecordId = 'principal_12345678', version = 2) {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE delivery_principals (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        principal_json TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        linked_to_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE conversation_bindings (
        id TEXT PRIMARY KEY,
        conversation_hash TEXT NOT NULL,
        conversation_json TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        principal_json TEXT NOT NULL,
        workspace TEXT NOT NULL,
        agent_preset TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL,
        policy_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `)
    const principal = { channel: 'web', account: profile, tenant: 'local', user: 'operator' }
    db.prepare(
      `INSERT INTO delivery_principals (id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version)
       VALUES (?, ?, ?, 'owner', 'active', NULL, 1, 1, ?)`,
    ).run(principalRecordId, 'hash-owner', JSON.stringify(principal), version)
  } finally {
    db.close()
  }
}

function makeWebOwnerRoute(profile: string, workspace: string) {
  return {
    id: `web-owner-${'a'.repeat(32)}`,
    conversation: { channel: 'web', account: profile, tenant: 'local', user: 'operator', chat: 'session-1' },
    principal: { channel: 'web', account: profile, tenant: 'local', user: 'operator' },
    workspace,
    agentPreset: 'standard',
    policyRef: 'web-owner-policy',
    minimumGeneration: 1,
  }
}

function createHostContext(opts: {
  dshHome: string
  profileDir: string
  profileName?: string
  descriptors?: Array<{ ns: string; value: Record<string, unknown>; revision?: number }>
  mutateFn?: (ns: string, ops: unknown[], revision?: number) => Promise<void>
  bundles?: Array<{ name: string; installed: boolean }>
  llmProviders?: Array<{ id: string; name: string }>
}) {
  const descriptors = (opts.descriptors ?? []).map(d => ({ ns: d.ns, revision: d.revision ?? 1, value: d.value }))
  const mutate = vi.fn(opts.mutateFn ?? (async () => {}))
  const installedList = (opts.bundles ?? [
    { name: '@dsh-enhanced/traex-acp-provider', installed: true },
    { name: '@dsh-enhanced/personal-assistant', installed: true },
    { name: '@dsh-enhanced/assistant-delivery', installed: true },
    { name: '@dsh-enhanced/assistant-memory-learning', installed: true },
    { name: '@dsh-enhanced/assistant-verifier', installed: true },
    { name: '@dsh-enhanced/assistant-dreaming', installed: true },
    { name: '@dsh-enhanced/assistant-growth-driver', installed: true },
  ]).map(b => ({ name: b.name, installed: b.installed, version: '0.1.73', entries: [] }))

  const services = new Map<string, unknown>([
    ['profileContext', { dir: opts.profileDir, home: opts.dshHome, name: opts.profileName ?? 'web' }],
    ['settings', { describe: () => descriptors, mutate }],
    ['pluginManager', { listBundles: async () => installedList, listPlugins: async () => [] }],
    ['llm', { listProviders: () => opts.llmProviders ?? [{ id: 'traex-agent', name: 'TraeX' }, { id: 'deepseek', name: 'DeepSeek API' }] }],
    ['loader', { entries: () => [] }],
  ])

  const host = {
    get: (name: string) => services.get(name),
    inject: vi.fn(),
  }
  return { host, mutate }
}

describe('autonomy-setup wizard', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('inspects prerequisites fail-closed when owner route or scoped DB paths fail', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)

    writeFileSync(join(profileDir, 'cordis.patch.yml'), `
- id: dsh-enhanced-assistant-delivery
  name: "@dsh-enhanced/assistant-delivery"
  config:
    ownerRoutes:
      - ${JSON.stringify(makeWebOwnerRoute('web', workspace))}
- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
  config:
    enabled: false
    databasePath: "~/.dsh/dreaming.sqlite"
`, { encoding: 'utf8', mode: 0o600 })

    const { host } = createHostContext({ dshHome, profileDir })
    const status = await inspectAutonomyWizardStatus(host, { now: 1_700_000_000_000 })

    expect(status.ownerRoute.configured).toBe(true)
    expect(status.ownerRoute.active).toBe(false)
    expect(status.profile.dbPathsScoped).toBe(false)
    expect(status.profile.unscopedDbPaths.some(p => p.includes('~/.dsh/dreaming.sqlite'))).toBe(true)
    expect(status.overallReady).toBe(false)

    const refused = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'conservative',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: true,
      enableGrowth: true,
      workItemExperiences: false,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
    })
    expect(refused.applied).toBe(false)
    expect(refused.note).toContain('~/.dsh/dreaming.sqlite')
  })

  it('refuses enable when owner route has no active delivery principal lineage', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)

    writeFileSync(join(profileDir, 'cordis.patch.yml'), `
- id: dsh-enhanced-assistant-delivery
  name: "@dsh-enhanced/assistant-delivery"
  config:
    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')
    ownerRoutes:
      - ${JSON.stringify(makeWebOwnerRoute('web', workspace))}
`, { encoding: 'utf8', mode: 0o600 })

    const { host } = createHostContext({
      dshHome,
      profileDir,
      descriptors: [{ ns: 'dsh-deepseek-agent-default-model', value: { provider: 'traex-agent', model: 'default' } }],
    })
    const res = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'balanced',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: true,
      enableGrowth: true,
      workItemExperiences: false,
      customBudget: AUTONOMY_TIER_DEFAULTS.balanced,
    })
    expect(res.applied).toBe(false)
    expect(res.note).toContain('Delivery')
  })

  it('compiles independent 3-authority grants, $DSH_HOME DBs, finite budgets & preserves !!js scalars cleanly', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    seedDeliveryOwnerSqlite(join(dshHome, 'assistant-delivery', 'state.sqlite'), 'web', 'principal_abc12345', 3)

    const initialYaml = `- id: dsh-enhanced-assistant-delivery
  name: "@dsh-enhanced/assistant-delivery"
  config:
    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')
    ownerRoutes:
      - id: web-owner-${'a'.repeat(32)}
        conversation:
          channel: web
          account: web
          tenant: local
          user: operator
          chat: session-1
        principal:
          channel: web
          account: web
          tenant: local
          user: operator
        workspace: ${workspace}
        agentPreset: standard
        policyRef: web-owner-policy
        minimumGeneration: 1
- id: dsh-enhanced-lark-channel
  name: "@dsh-enhanced/lark-channel"
  config:
    appSecret: !!js process.env.LARK_APP_SECRET
- id: dsh-enhanced-traex-acp-provider
  name: "@dsh-enhanced/traex-acp-provider"
  config:
    enabled: false
`
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, initialYaml, { encoding: 'utf8', mode: 0o600 })

    const { host, mutate } = createHostContext({
      dshHome,
      profileDir,
      descriptors: [
        { ns: 'dsh-enhanced-traex-acp-provider', revision: 7, value: { enabled: false, agyEnabled: false } },
        { ns: 'dsh-deepseek-agent-default-model', revision: 4, value: { provider: 'deepseek', model: 'deepseek-chat' } },
      ],
    })

    const now = 1_760_000_000_000
    const statusBefore = await inspectAutonomyWizardStatus(host, { now })
    expect(statusBefore.ownerRoute.active).toBe(true)
    expect(statusBefore.ownerRoute.channel).toBe('web')
    expect(statusBefore.profile.dbPathsScoped).toBe(true)

    const writeResult = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'balanced',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: 'medium',
      enableMemoryLearning: true,
      enableDreaming: true,
      enableGrowth: true,
      workItemExperiences: true,
      customBudget: AUTONOMY_TIER_DEFAULTS.balanced,
      now,
    })

    expect(writeResult.applied).toBe(true)
    expect(writeResult.note).toContain('cordis.patch.yml.bak.')
    expect(writeResult.note).toContain('重启 profile')

    // Backup exists with 0600 permissions
    const backupPath = `${patchPath}.bak.${now}`
    expect(readFileSync(backupPath, 'utf8')).toBe(initialYaml)
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    expect(statSync(patchPath).mode & 0o777).toBe(0o600)

    // Volatile route updates applied after disk write
    expect(mutate).toHaveBeenCalledWith('dsh-enhanced-traex-acp-provider', [{ op: 'set', path: ['enabled'], value: true }], 7)
    expect(mutate).toHaveBeenCalledWith('dsh-deepseek-agent-default-model', [
      { op: 'set', path: ['provider'], value: 'traex-agent' },
      { op: 'set', path: ['model'], value: 'default' },
      { op: 'set', path: ['reasoningEffort'], value: 'medium' },
    ], 4)

    // Existing !!js scalars preserved verbatim
    const updatedRaw = readFileSync(patchPath, 'utf8')
    expect(updatedRaw).toContain("!!js dshHomePath('assistant-delivery/state.sqlite')")
    expect(updatedRaw).toContain('!!js process.env.LARK_APP_SECRET')

    const parsedRows = parse(updatedRaw, { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; disabled?: boolean; config: Record<string, unknown> }>
    const byId = new Map(parsedRows.map(r => [r.id, r]))

    const memRow = byId.get('dsh-enhanced-assistant-memory-learning')!
    const verifierRow = byId.get('dsh-enhanced-assistant-verifier')!
    const paRow = byId.get('dsh-enhanced-personal-assistant')!
    const dreamRow = byId.get('dsh-enhanced-assistant-dreaming')!
    const growthRow = byId.get('dsh-enhanced-assistant-growth-driver')!

    expect(memRow.disabled).toBe(false)
    const reviewCfg = verifierRow.config['memoryReviews'] as Record<string, unknown>
    const adoptCfg = (paRow.config['personalMemory'] as Record<string, unknown>)['automaticLearning'] as Record<string, unknown>
    const learnCfg = memRow.config

    expect(adoptCfg['kinds']).toEqual(['fact', 'experience'])
    expect(learnCfg['workItemExperiences']).toBe(true)
    expect(reviewCfg['workItemExperiences']).toBe(true)
    expect(adoptCfg['workItemExperiences']).toBe(true)

    expect(new Set([
      learnCfg['authorityId'],
      reviewCfg['authorityId'],
      adoptCfg['authorityId'],
      (learnCfg['owner'] as Record<string, unknown>)['authorityId'],
    ]).size).toBe(4)

    expect(learnCfg['reviewAuthorityDigest']).toBe(canonicalObjectDigest(reviewCfg))
    expect(learnCfg['adoptionGrantDigest']).toBe(canonicalObjectDigest(adoptCfg))
    expect(String(learnCfg['databasePath'])).toContain(join('assistant-memory-learning', 'web.sqlite'))
    expect(String(dreamRow.config['databasePath'])).toContain(join('assistant-dreaming', 'web.sqlite'))
    expect(dreamRow.config['retired']).toBe(false)
    expect(dreamRow.config['enabled']).toBe(true)
    expect(dreamRow.config['maxDreamsPerDay']).toBe(6)
    expect((growthRow.config['usageLearning'] as Record<string, unknown>)['enabled']).toBe(true)

    const policy = paRow.config['assistantPolicy'] as { budgets: Array<Record<string, unknown>>; rules: Array<Record<string, unknown>> }
    const autos = paRow.config['assistantAutomations'] as Record<string, unknown>
    expect(autos['schedulerEnabled']).toBe(true)
    expect(autos['allowUnbudgetedExecution']).toBe(false)
    expect(policy.budgets.some(b => b['limit'] === 25 && b['scope'] === 'workspace')).toBe(true)
    expect(policy.budgets.some(b => b['limit'] === 6 && b['scope'] === 'subject')).toBe(true)
    expect(policy.rules.some(r => (r['actions'] as string[]).includes('dream.validate'))).toBe(true)
    expect(policy.rules.some(r => (r['actions'] as string[]).includes('adopt'))).toBe(true)
    expect(policy.rules.some(r => (r['actions'] as string[]).includes('draft'))).toBe(true)

    // Verify inspect sees everything active now
    const statusAfter = await inspectAutonomyWizardStatus(host, { now: now + 1000 })
    expect(statusAfter.activeTier).toBe('balanced')
    expect(statusAfter.grants.memoryLearning.enabled).toBe(true)
    expect(statusAfter.grants.memoryLearning.threeAuthoritiesIndependent).toBe(true)
    expect(statusAfter.grants.dreaming.enabled).toBe(true)
    expect(statusAfter.grants.growthDriver.enabled).toBe(true)
    expect(statusAfter.grants.assistantPolicy.ready).toBe(true)
    expect(statusAfter.overallReady).toBe(true)

    // Safe pause preserves enabled=true + retired=true invariant on dreaming & preserves ledgers
    const paused = await applyAutonomyWizardSetup(host, {
      action: 'pause',
      tier: 'balanced',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: true,
      enableGrowth: true,
      workItemExperiences: true,
      customBudget: AUTONOMY_TIER_DEFAULTS.balanced,
      now: now + 2000,
    })
    expect(paused.applied).toBe(true)
    const afterPauseRows = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; disabled?: boolean; config: Record<string, unknown> }>
    const pauseById = new Map(afterPauseRows.map(r => [r.id, r]))
    expect(pauseById.get('dsh-enhanced-assistant-dreaming')!.config['enabled']).toBe(true)
    expect(pauseById.get('dsh-enhanced-assistant-dreaming')!.config['retired']).toBe(true)
    expect(pauseById.get('dsh-enhanced-assistant-memory-learning')!.disabled).toBe(true)
    expect(pauseById.get('dsh-enhanced-assistant-growth-driver')!.config['enabled']).toBe(false)

    // Safe disable clears `retired` before setting dreaming enabled=false
    const disabled = await applyAutonomyWizardSetup(host, {
      action: 'disable',
      tier: 'balanced',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: true,
      enableGrowth: true,
      workItemExperiences: false,
      customBudget: AUTONOMY_TIER_DEFAULTS.balanced,
      now: now + 3000,
    })
    expect(disabled.applied).toBe(true)
    const afterDisableRows = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; disabled?: boolean; config: Record<string, unknown> }>
    const disableById = new Map(afterDisableRows.map(r => [r.id, r]))
    expect(disableById.get('dsh-enhanced-assistant-dreaming')!.config['retired']).toBeUndefined()
    expect(disableById.get('dsh-enhanced-assistant-dreaming')!.config['enabled']).toBe(false)
    expect(disableById.get('dsh-enhanced-assistant-dreaming')!.disabled).toBe(true)
  })

  it('refuses symlinked cordis.patch.yml and invalid custom budgets', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    const targetFile = join(root, 'outside.yml')
    writeFileSync(targetFile, '[]', 'utf8')
    symlinkSync(targetFile, join(profileDir, 'cordis.patch.yml'))
    const { host } = createHostContext({ dshHome, profileDir })

    const symlinkRes = await applyAutonomyWizardSetup(host, {
      action: 'pause',
      tier: 'conservative',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: false,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
    })
    expect(symlinkRes.applied).toBe(false)

    // Invalid custom budget rejected before touching disk
    const root2 = createTempProfile()
    dirs.push(root2.root)
    seedDeliveryOwnerSqlite(join(root2.dshHome, 'assistant-delivery', 'state.sqlite'))
    writeFileSync(join(root2.profileDir, 'cordis.patch.yml'), `- id: dsh-enhanced-assistant-delivery\n  config:\n    ownerRoutes:\n      - ${JSON.stringify(makeWebOwnerRoute('web', workspace))}\n`, { encoding: 'utf8', mode: 0o600 })
    const { host: host2 } = createHostContext({ dshHome: root2.dshHome, profileDir: root2.profileDir })
    const badBudget = await applyAutonomyWizardSetup(host2, {
      action: 'enable',
      tier: 'custom',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: false,
      customBudget: { ...AUTONOMY_TIER_DEFAULTS.conservative, dailyDreams: 999 },
    })
    expect(badBudget.applied).toBe(false)
    expect(badBudget.note).toContain('超出安全范围')
  })

  it('exposes autonomySetupStatus and configureAutonomySetup through OwnerConsoleService & TYPERT', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    seedDeliveryOwnerSqlite(join(dshHome, 'assistant-delivery', 'state.sqlite'))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: dsh-enhanced-assistant-delivery\n  name: "@dsh-enhanced/assistant-delivery"\n  config:\n    ownerRoutes:\n      - ${JSON.stringify(makeWebOwnerRoute('web', workspace))}\n`, { encoding: 'utf8', mode: 0o600 })
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('profileContext' as never, { dir: profileDir, home: dshHome, name: 'web' } as never)
    ctx.provide('settings' as never, {
      describe: () => [
        { ns: 'dsh-enhanced-traex-acp-provider', revision: 1, value: { enabled: true } },
        { ns: 'dsh-deepseek-agent-default-model', revision: 1, value: { provider: 'traex-agent', model: 'default' } },
      ],
      mutate: vi.fn(async () => {}),
    } as never)
    const svc = new OwnerConsoleService(ctx, { feishuAppId: '' })
    try {
      const st = await svc.autonomySetupStatus()
      expect(st.ownerRoute.active).toBe(true)

      const result = await svc.configureAutonomySetup(
        'enable', 'conservative', 'traex-agent', 'default', '', true, true, true, false, AUTONOMY_TIER_DEFAULTS.conservative,
      )
      expect(result.applied).toBe(true)
      const statusCodec = TYPERT.invocations.find(i => i.method === 'autonomySetupStatus')!.result
      expect(statusCodec.create().safeParse(await svc.autonomySetupStatus()).success).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('matches assistant-delivery ownerRouteAuthorityHash & inspectOwnerRouteState receipt contract and passes real subsystem validators across enable/pause/disable', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)

    const scrambledRoute = {
      policyRef: 'owner-dm',
      minimumGeneration: 1,
      agentPreset: 'standard',
      workspace,
      principal: { user: 'owner-local', tenant: 'local', account: 'web', channel: 'web' },
      conversation: { chat: 'session-1', kind: 'dm', tenant: 'local', account: 'web', channel: 'web' },
      id: 'owner-web-route',
    } as const
    const expectedHash = ownerRouteAuthorityHash(scrambledRoute)
    expect(ownerRouteAuthorityHashLocal(scrambledRoute)).toBe(expectedHash)

    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: dsh-enhanced-assistant-delivery',
      '  name: "@dsh-enhanced/assistant-delivery"',
      '  config:',
      '    ownerRoutes:',
      `      - ${JSON.stringify(scrambledRoute)}`,
    ].join('\n'), { encoding: 'utf8', mode: 0o600 })

    const inspectSpy = vi.fn((arg: unknown) => {
      expect(arg).toEqual({
        authorityId: 'owner-web-route',
        principalId: 'web/web/local/owner-local',
        workspace,
        agentPreset: 'standard',
      })
      return {
        status: 'active',
        receipt: {
          authorityHash: expectedHash,
          principalRecordId: 'principal_receipt_1',
          principalVersion: 3,
        },
      }
    })
    const host = {
      get: (name: string) => {
        if (name === 'profileContext') return { dir: profileDir, home: dshHome, name: 'web' }
        if (name === 'assistantDelivery') return { inspectOwnerRouteState: inspectSpy }
        if (name === 'pluginManager') {
          return {
            listBundles: async () => [
              '@dsh-enhanced/assistant-delivery',
              '@dsh-enhanced/personal-assistant',
              '@dsh-enhanced/assistant-verifier',
              '@dsh-enhanced/assistant-memory-learning',
              '@dsh-enhanced/assistant-dreaming',
              '@dsh-enhanced/assistant-growth-driver',
              '@dsh-enhanced/traex-acp-provider',
            ].map(pkg => ({ name: pkg, installed: true, enabled: true })),
          }
        }
        if (name === 'settings') {
          return {
            describe: () => [
              { ns: 'dsh-enhanced-traex-acp-provider', revision: 1, value: { enabled: true } },
              { ns: 'dsh-deepseek-agent-default-model', revision: 1, value: { provider: 'traex-agent', model: 'default' } },
              {
                ns: 'dsh-enhanced-personal-assistant',
                revision: 1,
                value: {
                  assistantPolicy: {
                    rules: [{ id: 'existing-descriptor-rule', effect: 'allow', actions: ['read'], resource: { kind: 'filesystem', id: '*' } }],
                  },
                },
              },
            ],
            mutate: vi.fn(async () => {}),
          }
        }
        return undefined
      },
    }

    const status = await inspectAutonomyWizardStatus(host)
    expect(inspectSpy).toHaveBeenCalledTimes(1)
    expect(status.ownerRoute.active).toBe(true)

    const enableRes = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'custom',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: true,
      enableGrowth: true,
      workItemExperiences: true,
      customBudget: {
        dailyMemoryExtractions: 120,
        dailyMemoryScans: 60,
        dailyDreams: 12,
        maxIdeasPerWake: 3,
        dailyGrowthReviews: 24,
        dailyGrowthDiscoveryScans: 12,
        grantLeaseDays: 90,
      },
    })
    expect(enableRes.applied).toBe(true)

    const rows = parse(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{
      id: string
      disabled?: boolean
      config?: Record<string, any>
    }>
    const learningCfg = rows.find(r => r.id === 'dsh-enhanced-assistant-memory-learning')!.config!
    const verifierCfg = rows.find(r => r.id === 'dsh-enhanced-assistant-verifier')!.config!
    const paCfg = rows.find(r => r.id === 'dsh-enhanced-personal-assistant')!.config!
    const dreamCfg = rows.find(r => r.id === 'dsh-enhanced-assistant-dreaming')!.config!
    const growthCfg = rows.find(r => r.id === 'dsh-enhanced-assistant-growth-driver')!.config!

    const validatedLearning = validateLearningConfig(learningCfg)
    const validatedReviews = validateMemoryReviewConfig(verifierCfg['memoryReviews'])
    const validatedAdoption = validateMemoryLearningAdoptionGrant(paCfg['personalMemory']['automaticLearning'])
    expect(validatedLearning.maxExtractions).toBe(10_000)
    expect(validatedReviews.maxReviews).toBe(10_000)
    expect(validatedAdoption.maxMutations).toBe(1_000)
    expect(validateDreamingConfig(dreamCfg).enabled).toBe(true)
    expect(validateGrowthConfig(growthCfg).usageLearning.enabled).toBe(true)

    // Descriptor rules were preserved alongside wizard budgets/rules.
    const ruleIds = (paCfg['assistantPolicy']['rules'] as Array<{ id: string }>).map(r => r.id)
    expect(ruleIds).toContain('existing-descriptor-rule')

    // Policy service evaluates growth usage reconciler, usage job execution, growth tools, and verified-workflows.
    const ctx = new Context()
    try {
      const policy = new AssistantPolicyService(ctx, {
        databasePath: join(root, 'policy-check.sqlite'),
        rules: paCfg['assistantPolicy']['rules'],
        budgets: paCfg['assistantPolicy']['budgets'],
      })
      const principalId = 'web/web/local/owner-local'
      expect(policy.evaluate({
        subject: { kind: 'background', id: 'assistant-growth-usage', workspace, principal: principalId },
        action: 'reconcile',
        resource: { kind: 'automation', id: 'usage-scan-owner-1' },
        context: { initiator: 'background' },
      }).effect).toBe('allow')
      expect(policy.evaluate({
        subject: { kind: 'background', id: 'usage-work-item-42', workspace, principal: principalId },
        action: 'execute',
        resource: { kind: 'automation', id: 'usage-work-item-42' },
        context: { initiator: 'background' },
      }).effect).toBe('allow')
      expect(policy.evaluate({
        subject: { kind: 'agent', id: 'standard', workspace, principal: principalId },
        action: 'execute',
        resource: { kind: 'tool', id: 'growth_inspect' },
        context: { initiator: 'background' },
      }).effect).toBe('allow')
      expect(policy.evaluate({
        subject: { kind: 'agent', id: 'standard', workspace, principal: principalId },
        action: 'draft',
        resource: { kind: 'evolution', id: 'verified-workflows' },
        context: { initiator: 'background' },
      }).effect).toBe('allow')
    } finally {
      await ctx.fiber.dispose()
    }

    // Pausing dreaming + growth must still validate cleanly without normalizeConfig throwing.
    const pauseRes = await applyAutonomyWizardSetup(host, {
      action: 'pause',
      tier: 'conservative',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: false,
      enableDreaming: true,
      enableGrowth: true,
      workItemExperiences: true,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
    })
    expect(pauseRes.applied).toBe(true)
    const pausedRows = parse(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{
      id: string
      config?: Record<string, any>
    }>
    expect(validateDreamingConfig(pausedRows.find(r => r.id === 'dsh-enhanced-assistant-dreaming')!.config!).retired).toBe(true)
    expect(validateGrowthConfig(pausedRows.find(r => r.id === 'dsh-enhanced-assistant-growth-driver')!.config!).enabled).toBe(false)

    // Disabling all modules sets `disabled: true` while keeping configs structurally valid.
    const disableRes = await applyAutonomyWizardSetup(host, {
      action: 'disable',
      tier: 'conservative',
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: true,
      enableGrowth: true,
      workItemExperiences: true,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
    })
    expect(disableRes.applied).toBe(true)
    const disabledRows = parse(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{
      id: string
      disabled?: boolean
      config?: Record<string, any>
    }>
    expect(disabledRows.find(r => r.id === 'dsh-enhanced-assistant-memory-learning')?.disabled).toBe(true)
    expect(disabledRows.find(r => r.id === 'dsh-enhanced-assistant-dreaming')?.disabled).toBe(true)
    expect(disabledRows.find(r => r.id === 'dsh-enhanced-assistant-growth-driver')?.disabled).toBe(true)
    expect(validateDreamingConfig(disabledRows.find(r => r.id === 'dsh-enhanced-assistant-dreaming')!.config!).enabled).toBe(false)
    expect(validateGrowthConfig(disabledRows.find(r => r.id === 'dsh-enhanced-assistant-growth-driver')!.config!).enabled).toBe(false)
  })
})
