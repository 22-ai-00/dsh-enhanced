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
import { Config as AssistantVerifierConfig, validateMemoryReviewConfig } from '../../assistant-verifier/lib/index.js'
import { PersonalMemoryService, validateMemoryLearningAdoptionGrant } from '../../personal-memory/lib/index.js'
import {
  applyAutonomyWizardSetup,
  canonicalObjectDigest,
  ensureVerifierDefaults,
  getPersonalAndPolicyConfigs,
  inspectAutonomyWizardStatus,
  inspectOwnerRoute,
  normalizeLearningConfigForDigest,
  ownerRouteAuthorityHashLocal,
} from '../src/autonomy-setup.js'
import { parseDocument } from 'yaml'
import { applyFeishuVaultConfig } from '../src/doctor-repair.js'
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
    { name: '@dsh-ray/traex-acp-provider', installed: true },
    { name: '@dsh-ray/personal-assistant', installed: true },
    { name: '@dsh-ray/assistant-delivery', installed: true },
    { name: '@dsh-ray/assistant-memory-learning', installed: true },
    { name: '@dsh-ray/assistant-verifier', installed: true },
    { name: '@dsh-ray/assistant-dreaming', installed: true },
    { name: '@dsh-ray/assistant-growth-driver', installed: true },
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
- id: dsh-ray-assistant-delivery
  name: "@dsh-ray/assistant-delivery"
  config:
    ownerRoutes:
      - ${JSON.stringify(makeWebOwnerRoute('web', workspace))}
- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
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
- id: dsh-ray-assistant-delivery
  name: "@dsh-ray/assistant-delivery"
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

    const initialYaml = `- id: dsh-ray-assistant-delivery
  name: "@dsh-ray/assistant-delivery"
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
- id: dsh-ray-lark-channel
  name: "@dsh-ray/lark-channel"
  config:
    appSecret: !!js process.env.LARK_APP_SECRET
- id: dsh-ray-traex-acp-provider
  name: "@dsh-ray/traex-acp-provider"
  config:
    enabled: false
`
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, initialYaml, { encoding: 'utf8', mode: 0o600 })

    const { host, mutate } = createHostContext({
      dshHome,
      profileDir,
      descriptors: [
        { ns: 'dsh-ray-traex-acp-provider', revision: 7, value: { enabled: false, agyEnabled: false } },
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
    expect(mutate).toHaveBeenCalledWith('dsh-ray-traex-acp-provider', [{ op: 'set', path: ['enabled'], value: true }], 7)
    expect(mutate).toHaveBeenCalledWith('dsh-deepseek-agent-default-model', [
      { op: 'set', path: ['provider'], value: 'traex-agent' },
      { op: 'set', path: ['model'], value: 'default' },
      { op: 'set', path: ['reasoningEffort'], value: 'medium' },
    ], 4)

    // Existing !!js scalars preserved verbatim, verifier databasePath restated, and zero YAML anchors/aliases emitted
    const updatedRaw = readFileSync(patchPath, 'utf8')
    expect(updatedRaw).toContain("!!js dshHomePath('assistant-delivery/state.sqlite')")
    expect(updatedRaw).toContain("!!js dshHomePath('assistant-verifier/verification.sqlite')")
    expect(updatedRaw).toContain('!!js process.env.LARK_APP_SECRET')
    expect(updatedRaw).not.toMatch(/&a\d+|\*a\d+/u)

    const parsedRows = parse(updatedRaw, { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; disabled?: boolean; config: Record<string, unknown> }>
    const byId = new Map(parsedRows.map(r => [r.id, r]))

    const memRow = byId.get('dsh-ray-assistant-memory-learning')!
    const verifierRow = byId.get('dsh-ray-assistant-verifier')!
    const paRow = byId.get('dsh-ray-personal-assistant')!
    const dreamRow = byId.get('dsh-ray-assistant-dreaming')!
    const growthRow = byId.get('dsh-ray-assistant-growth-driver')!

    expect(memRow.disabled).toBe(false)
    // Validate full AssistantVerifier Config schema (Cordis patch config is whole-value replacement; databasePath is required).
    const parsedVerifier = AssistantVerifierConfig({
      ...verifierRow.config,
      databasePath: join(dshHome, 'assistant-verifier', 'verification.sqlite'),
    } as never)
    expect(verifierRow.config['databasePath']).toBe("dshHomePath('assistant-verifier/verification.sqlite')")
    expect(parsedVerifier.tickIntervalMs).toBe(5000)
    expect(parsedVerifier.requireAcceptance).toBe(false)
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
    expect(pauseById.get('dsh-ray-assistant-dreaming')!.config['enabled']).toBe(true)
    expect(pauseById.get('dsh-ray-assistant-dreaming')!.config['retired']).toBe(true)
    expect(pauseById.get('dsh-ray-assistant-memory-learning')!.disabled).toBe(true)
    expect(pauseById.get('dsh-ray-assistant-growth-driver')!.config['enabled']).toBe(false)

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
    expect(disableById.get('dsh-ray-assistant-dreaming')!.config['retired']).toBeUndefined()
    expect(disableById.get('dsh-ray-assistant-dreaming')!.config['enabled']).toBe(false)
    expect(disableById.get('dsh-ray-assistant-dreaming')!.disabled).toBe(true)
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
    writeFileSync(join(root2.profileDir, 'cordis.patch.yml'), `- id: dsh-ray-assistant-delivery\n  config:\n    ownerRoutes:\n      - ${JSON.stringify(makeWebOwnerRoute('web', workspace))}\n`, { encoding: 'utf8', mode: 0o600 })
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
    writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: dsh-ray-assistant-delivery\n  name: "@dsh-ray/assistant-delivery"\n  config:\n    ownerRoutes:\n      - ${JSON.stringify(makeWebOwnerRoute('web', workspace))}\n`, { encoding: 'utf8', mode: 0o600 })
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('profileContext' as never, { dir: profileDir, home: dshHome, name: 'web' } as never)
    ctx.provide('settings' as never, {
      describe: () => [
        { ns: 'dsh-ray-traex-acp-provider', revision: 1, value: { enabled: true } },
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
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
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
              '@dsh-ray/assistant-delivery',
              '@dsh-ray/personal-assistant',
              '@dsh-ray/assistant-verifier',
              '@dsh-ray/assistant-memory-learning',
              '@dsh-ray/assistant-dreaming',
              '@dsh-ray/assistant-growth-driver',
              '@dsh-ray/traex-acp-provider',
            ].map(pkg => ({ name: pkg, installed: true, enabled: true })),
          }
        }
        if (name === 'settings') {
          return {
            describe: () => [
              { ns: 'dsh-ray-traex-acp-provider', revision: 1, value: { enabled: true } },
              { ns: 'dsh-deepseek-agent-default-model', revision: 1, value: { provider: 'traex-agent', model: 'default' } },
              {
                ns: 'dsh-ray-personal-assistant',
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
    const learningCfg = rows.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config!
    const verifierCfg = rows.find(r => r.id === 'dsh-ray-assistant-verifier')!.config!
    const paCfg = rows.find(r => r.id === 'dsh-ray-personal-assistant')!.config!
    const dreamCfg = rows.find(r => r.id === 'dsh-ray-assistant-dreaming')!.config!
    const growthCfg = rows.find(r => r.id === 'dsh-ray-assistant-growth-driver')!.config!

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
    expect(validateDreamingConfig(pausedRows.find(r => r.id === 'dsh-ray-assistant-dreaming')!.config!).retired).toBe(true)
    expect(validateGrowthConfig(pausedRows.find(r => r.id === 'dsh-ray-assistant-growth-driver')!.config!).enabled).toBe(false)

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
    expect(disabledRows.find(r => r.id === 'dsh-ray-assistant-memory-learning')?.disabled).toBe(true)
    expect(disabledRows.find(r => r.id === 'dsh-ray-assistant-dreaming')?.disabled).toBe(true)
    expect(disabledRows.find(r => r.id === 'dsh-ray-assistant-growth-driver')?.disabled).toBe(true)
    expect(validateDreamingConfig(disabledRows.find(r => r.id === 'dsh-ray-assistant-dreaming')!.config!).enabled).toBe(false)
    expect(validateGrowthConfig(disabledRows.find(r => r.id === 'dsh-ray-assistant-growth-driver')!.config!).enabled).toBe(false)
  })

  it('preserves valid policy rules and verifier databasePath across autonomy setup followed by Feishu vault setup (zero YAML alias corruption)', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    seedDeliveryOwnerSqlite(join(dshHome, 'assistant-delivery', 'state.sqlite'), 'web', 'principal_roundtrip', 1)

    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      "    defaultWorkspace: !!js dshHomePath('assistant-workspace')",
      '    ownerRoutes:',
      `      - ${JSON.stringify(makeWebOwnerRoute('web', workspace))}`,
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o600 })

    const { host } = createHostContext({
      dshHome,
      profileDir,
      descriptors: [{ ns: 'dsh-deepseek-agent-default-model', value: { provider: 'traex-agent', model: 'default' } }],
    })

    const autoRes = await applyAutonomyWizardSetup(host, {
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
      now: 1_760_000_001_000,
    })
    expect(autoRes.applied).toBe(true)

    const feishuRes = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_1122334455667788',
      appSecret: 'roundtrip_secret_xyz',
      account: 'primary',
      tenant: 'personal',
      ownerOpenId: 'ou_roundtrip_1',
      platform: 'darwin',
      env: {},
      now: 1_760_000_002_000,
      storeSecretFn: async () => {},
    })
    expect(feishuRes.applied).toBe(true)

    const finalYaml = readFileSync(patchPath, 'utf8')
    expect(finalYaml).not.toContain('source: a1')
    expect(finalYaml).not.toMatch(/&a\d+|\*a\d+/u)
    const rows = parse(finalYaml, { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config?: Record<string, any> }>
    const verifierCfg = rows.find(r => r.id === 'dsh-ray-assistant-verifier')!.config!
    expect(verifierCfg['databasePath']).toBe("dshHomePath('assistant-verifier/verification.sqlite')")
    expect(() => AssistantVerifierConfig({
      ...verifierCfg,
      databasePath: join(dshHome, 'assistant-verifier', 'verification.sqlite'),
    } as never)).not.toThrow()

    const paCfg = rows.find(r => r.id === 'dsh-ray-personal-assistant')!.config!
    const adoptAuthorityId = (paCfg['personalMemory']['automaticLearning'] as { authorityId: string }).authorityId
    const ctx = new Context()
    try {
      const policy = new AssistantPolicyService(ctx, {
        databasePath: join(root, 'roundtrip-policy.sqlite'),
        rules: paCfg['assistantPolicy']['rules'],
        budgets: paCfg['assistantPolicy']['budgets'],
      })
      // Specifically test rules that previously got mangled by YAML *a1/*a2 aliases (mem-adopt & mem-scan-reconcile).
      expect(policy.evaluate({
        subject: { kind: 'background', id: 'assistant-memory-learning', workspace, principal: 'web/web/local/operator' },
        action: 'adopt',
        resource: { kind: 'memory', id: `learning:${adoptAuthorityId}` },
        context: { initiator: 'background' },
      }).effect).toBe('allow')
      expect(policy.evaluate({
        subject: { kind: 'background', id: 'assistant-memory-learning', workspace, principal: 'web/web/local/operator' },
        action: 'reconcile',
        resource: { kind: 'automation', id: 'memory-scan-1' },
        context: { initiator: 'background' },
      }).effect).toBe('allow')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rotates memory-learning grant generation on re-apply so frozen PersonalMemory grants never crash startup', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const deliveryDb = join(dshHome, 'assistant-delivery', 'state.sqlite')
    const memoryDb = join(dshHome, 'personal-memory', 'memory.sqlite')
    seedDeliveryOwnerSqlite(deliveryDb, 'web', 'principal_rot_1', 1)
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules: []',
      '      budgets: []',
      '    personalMemory:',
      "      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
      '    assistantAutomations:',
      "      databasePath: !!js dshHomePath('assistant-automations/state.sqlite')",
      '      schedulerEnabled: true',
      '      allowUnbudgetedExecution: false',
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      '    ownerRoutes:',
      '      - id: owner-web-primary',
      '        conversation: { channel: web, account: web, tenant: local, kind: dm, chat: owner-primary }',
      '        principal: { channel: web, account: web, tenant: local, user: operator }',
      `        workspace: ${workspace}`,
      '        agentPreset: standard',
      '        policyRef: owner-dm',
      '        minimumGeneration: 1',
      '',
    ].join('\n'), 'utf8')

    const { host } = createHostContext({
      profileDir,
      dshHome,
      profileName: 'web',
      llmProviders: [
        { id: 'llmgw-general', name: 'LLMBox' },
        { id: 'super-relay', name: 'Super Relay' },
      ],
    })

    // Run 1: initial setup -> base generation (gen 1)
    const run1 = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'conservative',
      provider: 'llmgw-general',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: true,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
      now: 1_760_000_000_000,
    })
    expect(run1.applied).toBe(true)
    const rows1 = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config?: Record<string, any> }>
    const adopt1 = rows1.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['personalMemory']['automaticLearning']
    const mem1 = rows1.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config!
    expect(adopt1['authorityId']).toBe('web-memory-adopt-web')
    expect(mem1['authorityId']).toBe('web-memory-extract-web')

    // Boot real PersonalMemoryService so gen-1 grant is frozen in memory.sqlite
    const ctx1 = new Context()
    try {
      await ctx1.plugin(AssistantPolicyService, {
        databasePath: join(dshHome, 'assistant-policy', 'policy-rot-1.sqlite'),
        rules: rows1.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['assistantPolicy']['rules'],
        budgets: rows1.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['assistantPolicy']['budgets'],
      }).await()
      await ctx1.plugin(PersonalMemoryService, { databasePath: memoryDb, automaticLearning: adopt1, reconcileIntervalMs: 0 }).await()
      expect(ctx1.get('personalMemory')).toBeDefined()
    } finally {
      await ctx1.fiber.dispose()
    }

    // Run 2: change model + timestamp -> MUST rotate to -g2 + fresh dbPath, and real PersonalMemoryService MUST boot cleanly
    const run2 = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'conservative',
      provider: 'super-relay',
      model: 'auto_model/alwaysday1',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: true,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
      now: 1_760_000_060_000,
    })
    expect(run2.applied).toBe(true)
    const rows2 = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config?: Record<string, any> }>
    const pa2 = rows2.find(r => r.id === 'dsh-ray-personal-assistant')!.config!
    const adopt2 = pa2['personalMemory']['automaticLearning']
    const review2 = rows2.find(r => r.id === 'dsh-ray-assistant-verifier')!.config!['memoryReviews']
    const mem2 = rows2.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config!
    expect(adopt2['authorityId']).toBe('web-memory-adopt-web-g2')
    expect(review2['authorityId']).toBe('web-memory-review-web-g2')
    expect(mem2['authorityId']).toBe('web-memory-extract-web-g2')
    expect(String(mem2['databasePath'])).toContain(join('assistant-memory-learning', 'web-g2.sqlite'))
    expect(adopt2['reviewAuthorityDigest']).toBe(canonicalObjectDigest(review2))
    expect(mem2['adoptionGrantDigest']).toBe(canonicalObjectDigest(adopt2))
    expect(() => validateMemoryLearningAdoptionGrant(adopt2)).not.toThrow()
    expect(() => validateMemoryReviewConfig(review2)).not.toThrow()
    expect(() => validateLearningConfig(mem2)).not.toThrow()

    // Policy rules point at the rotated -g2 resources
    const rules2 = pa2['assistantPolicy']['rules'] as Array<{ id: string; resource: { id: string } }>
    expect(rules2.find(r => r.id === 'wizard-web-mem-adopt-web')?.resource.id).toBe('learning:web-memory-adopt-web-g2')
    expect(rules2.find(r => r.id === 'wizard-web-mem-review-web')?.resource.id).toBe('learning:web-memory-review-web-g2')
    expect(rules2.find(r => r.id === 'wizard-web-mem-extract-web')?.resource.id).toBe('learning:web-memory-extract-web-g2')

    // Boot real PersonalMemoryService against the SAME memory.sqlite -> MUST NOT throw idempotency-conflict!
    const ctx2 = new Context()
    try {
      await ctx2.plugin(AssistantPolicyService, {
        databasePath: join(dshHome, 'assistant-policy', 'policy-rot-2.sqlite'),
        rules: pa2['assistantPolicy']['rules'],
        budgets: pa2['assistantPolicy']['budgets'],
      }).await()
      await ctx2.plugin(PersonalMemoryService, { databasePath: memoryDb, automaticLearning: adopt2, reconcileIntervalMs: 0 }).await()
      expect(ctx2.get('personalMemory')).toBeDefined()
    } finally {
      await ctx2.fiber.dispose()
    }

    // Run 3: another re-apply MUST advance to -g3 (never step back to g1)
    const run3 = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'balanced',
      provider: 'super-relay',
      model: 'auto_model/alwaysday1',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: true,
      customBudget: AUTONOMY_TIER_DEFAULTS.balanced,
      now: 1_760_000_120_000,
    })
    expect(run3.applied).toBe(true)
    const rows3 = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config?: Record<string, any> }>
    expect(rows3.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['personalMemory']['automaticLearning']['authorityId']).toBe('web-memory-adopt-web-g3')
    expect(String(rows3.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config!['databasePath'])).toContain(join('assistant-memory-learning', 'web-g3.sqlite'))
  })

  it('rotates away from an existing assistant-memory-learning sqlite grant_record when config_digest differs even if cordis.patch.yml row was removed', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const deliveryDb = join(dshHome, 'assistant-delivery', 'state.sqlite')
    seedDeliveryOwnerSqlite(deliveryDb, 'web', 'principal_stale_db', 1)

    // Pre-existing desktop/web.sqlite with matching gen-1 authority_id & max_extractions, but stale config_digest
    const learningDir = join(dshHome, 'assistant-memory-learning')
    mkdirSync(learningDir, { recursive: true })
    const learningDb = new DatabaseSync(join(learningDir, 'web.sqlite'))
    try {
      learningDb.exec(`CREATE TABLE grant_record (authority_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, max_extractions INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0) STRICT`)
      learningDb.prepare(`INSERT INTO grant_record VALUES ('web-memory-extract-web', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 300, 2)`).run()
    } finally {
      learningDb.close()
    }

    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules: []',
      '      budgets: []',
      '    personalMemory:',
      "      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
      '    assistantAutomations:',
      "      databasePath: !!js dshHomePath('assistant-automations/state.sqlite')",
      '      schedulerEnabled: true',
      '      allowUnbudgetedExecution: false',
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      '    ownerRoutes:',
      '      - id: owner-web-primary',
      '        conversation: { channel: web, account: web, tenant: local, kind: dm, chat: owner-primary }',
      '        principal: { channel: web, account: web, tenant: local, user: operator }',
      `        workspace: ${workspace}`,
      '        agentPreset: standard',
      '        policyRef: owner-dm',
      '        minimumGeneration: 1',
      '',
    ].join('\n'), 'utf8')

    const { host } = createHostContext({
      profileDir,
      dshHome,
      profileName: 'web',
      llmProviders: [{ id: 'super-relay', name: 'Super Relay' }],
    })

    const res = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'conservative',
      provider: 'super-relay',
      model: 'auto_model/alwaysday1',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: true,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
      now: 1_760_000_500_000,
    })
    expect(res.applied).toBe(true)
    const rows = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config?: Record<string, any> }>
    const learnerCfg = rows.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config!
    expect(learnerCfg['authorityId']).toBe('web-memory-extract-web-g2')
    expect(String(learnerCfg['databasePath'])).toContain(join('assistant-memory-learning', 'web-g2.sqlite'))
    expect(() => validateLearningConfig(learnerCfg)).not.toThrow()
  })

  it('defaults requireAcceptance based on profiles while preserving explicit overrides and wholesale verifier fields in ensureVerifierDefaults', () => {
    const doc = parseDocument('- id: dsh-ray-assistant-verifier\n  config:\n    requireAcceptance: false\n')
    const cfgNode = doc.getIn([0, 'config']) as import('yaml').YAMLMap
    ensureVerifierDefaults(doc, cfgNode, { requireAcceptance: true })
    expect(cfgNode.get('requireAcceptance')).toBe(false)

    const docExplicitTrue = parseDocument('- id: dsh-ray-assistant-verifier\n  config:\n    requireAcceptance: true\n    profiles: []\n')
    const explicitTrueCfgNode = docExplicitTrue.getIn([0, 'config']) as import('yaml').YAMLMap
    ensureVerifierDefaults(docExplicitTrue, explicitTrueCfgNode, { requireAcceptance: false })
    expect(explicitTrueCfgNode.get('requireAcceptance')).toBe(true)

    const docFromRuntime = parseDocument('- id: dsh-ray-assistant-verifier\n  config: {}\n')
    const runtimeCfgNode = docFromRuntime.getIn([0, 'config']) as import('yaml').YAMLMap
    ensureVerifierDefaults(docFromRuntime, runtimeCfgNode, {
      requireAcceptance: true,
      profiles: [],
      memoryReviews: { authorityId: 'mem-rev-1' },
    })
    expect(runtimeCfgNode.get('requireAcceptance')).toBe(false)
    expect(runtimeCfgNode.get('memoryReviews', true)?.toJSON?.()).toEqual({ authorityId: 'mem-rev-1' })
    expect(docFromRuntime.toString()).toContain("!!js dshHomePath('assistant-verifier/verification.sqlite')")

    const docDefault = parseDocument('- id: dsh-ray-assistant-verifier\n  config: {}\n')
    const defaultCfgNode = docDefault.getIn([0, 'config']) as import('yaml').YAMLMap
    ensureVerifierDefaults(docDefault, defaultCfgNode, undefined)
    expect(defaultCfgNode.get('requireAcceptance')).toBe(false)

    const docWithProfiles = parseDocument('- id: dsh-ray-assistant-verifier\n  config:\n    profiles:\n      - id: p1\n')
    const withProfilesCfgNode = docWithProfiles.getIn([0, 'config']) as import('yaml').YAMLMap
    ensureVerifierDefaults(docWithProfiles, withProfilesCfgNode, undefined)
    expect(withProfilesCfgNode.get('requireAcceptance')).toBe(true)

    const docWithRuntimeProfilesFalse = parseDocument('- id: dsh-ray-assistant-verifier\n  config: {}\n')
    const withRuntimeProfilesFalseCfgNode = docWithRuntimeProfilesFalse.getIn([0, 'config']) as import('yaml').YAMLMap
    ensureVerifierDefaults(docWithRuntimeProfilesFalse, withRuntimeProfilesFalseCfgNode, {
      profiles: [{ id: 'p1' }],
      requireAcceptance: false,
    })
    expect(withRuntimeProfilesFalseCfgNode.get('requireAcceptance')).toBe(false)
  })

  it('preserves workItemExperiences: false without false configDigest rotation on re-application', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const deliveryDb = join(dshHome, 'assistant-delivery', 'state.sqlite')
    seedDeliveryOwnerSqlite(deliveryDb, 'web', 'principal_work_item_exp_false', 1)
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules: []',
      '      budgets: []',
      '    personalMemory:',
      "      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
      '    assistantAutomations:',
      "      databasePath: !!js dshHomePath('assistant-automations/state.sqlite')",
      '      schedulerEnabled: true',
      '      allowUnbudgetedExecution: false',
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      '    ownerRoutes:',
      '      - id: owner-web-primary',
      '        conversation: { channel: web, account: web, tenant: local, kind: dm, chat: owner-primary }',
      '        principal: { channel: web, account: web, tenant: local, user: operator }',
      `        workspace: ${workspace}`,
      '        agentPreset: standard',
      '        policyRef: owner-dm',
      '        minimumGeneration: 1',
      '',
    ].join('\n'), 'utf8')

    const { host } = createHostContext({
      profileDir,
      dshHome,
      profileName: 'web',
      llmProviders: [{ id: 'super-relay', name: 'Super Relay' }],
    })

    const fixedNow = 1_760_000_600_000
    const first = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'conservative',
      provider: 'super-relay',
      model: 'auto_model/alwaysday1',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: false,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
      now: fixedNow,
    })
    expect(first.applied).toBe(true)

    const rowsAfterFirst = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config: Record<string, any> }>
    const learnCfg = rowsAfterFirst.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config
    const reviewCfg = rowsAfterFirst.find(r => r.id === 'dsh-ray-assistant-verifier')!.config['memoryReviews'] as Record<string, unknown>
    const adoptCfg = (rowsAfterFirst.find(r => r.id === 'dsh-ray-personal-assistant')!.config['personalMemory'] as Record<string, unknown>)['automaticLearning'] as Record<string, unknown>

    expect(learnCfg['workItemExperiences']).toBe(false)
    expect(Object.hasOwn(reviewCfg, 'workItemExperiences')).toBe(false)
    expect(Object.hasOwn(adoptCfg, 'workItemExperiences')).toBe(false)

    const validatedLearn = validateLearningConfig(learnCfg)
    expect(validatedLearn.workItemExperiences).toBe(false)
    const runtimeDigest = canonicalObjectDigest(validatedLearn)

    // Seed MemoryLearning grant_record with the exact runtime digest from validateLearningConfig.
    mkdirSync(join(dshHome, 'assistant-memory-learning'), { recursive: true })
    const learningDb = new DatabaseSync(join(dshHome, 'assistant-memory-learning', 'web.sqlite'))
    try {
      learningDb.exec(`CREATE TABLE grant_record (authority_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, max_extractions INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0) STRICT`)
      learningDb.prepare(`INSERT INTO grant_record VALUES (?, ?, ?, 0)`).run(
        String(learnCfg['authorityId']),
        runtimeDigest,
        Number(learnCfg['maxExtractions']),
      )
    } finally {
      learningDb.close()
    }
    expect(canonicalObjectDigest(normalizeLearningConfigForDigest(learnCfg))).toBe(runtimeDigest)

    // Second apply with same fixedNow must stay at g1 (no false -g2 rotation).
    const second = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'conservative',
      provider: 'super-relay',
      model: 'auto_model/alwaysday1',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: false,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
      now: fixedNow,
    })
    expect(second.applied).toBe(true)
    const rowsAfterSecond = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config: Record<string, any> }>
    const learnCfgSecond = rowsAfterSecond.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config
    expect(learnCfgSecond['authorityId']).toBe('web-memory-extract-web')
    expect(learnCfgSecond['workItemExperiences']).toBe(false)
  })

  it('normalizes omitted/undefined workItemExperiences to true without false -g2 grant rotation', async () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const deliveryDb = join(dshHome, 'assistant-delivery', 'state.sqlite')
    seedDeliveryOwnerSqlite(deliveryDb, 'web', 'principal_work_item_exp_undef', 1)
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules: []',
      '      budgets: []',
      '    personalMemory:',
      "      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
      '    assistantAutomations:',
      "      databasePath: !!js dshHomePath('assistant-automations/state.sqlite')",
      '      schedulerEnabled: true',
      '      allowUnbudgetedExecution: false',
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      '    ownerRoutes:',
      '      - id: owner-web-primary',
      '        conversation: { channel: web, account: web, tenant: local, kind: dm, chat: owner-primary }',
      '        principal: { channel: web, account: web, tenant: local, user: operator }',
      `        workspace: ${workspace}`,
      '        agentPreset: standard',
      '        policyRef: owner-dm',
      '        minimumGeneration: 1',
      '',
    ].join('\n'), 'utf8')

    const { host } = createHostContext({
      profileDir,
      dshHome,
      profileName: 'web',
      llmProviders: [{ id: 'super-relay', name: 'Super Relay' }],
    })

    const fixedNow = 1_760_000_700_000
    const first = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'conservative',
      provider: 'super-relay',
      model: 'auto_model/alwaysday1',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: undefined as unknown as boolean,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
      now: fixedNow,
    })
    expect(first.applied).toBe(true)

    const rowsAfterFirst = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config: Record<string, any> }>
    const learnCfg = rowsAfterFirst.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config
    const reviewCfg = rowsAfterFirst.find(r => r.id === 'dsh-ray-assistant-verifier')!.config['memoryReviews'] as Record<string, unknown>
    const adoptCfg = (rowsAfterFirst.find(r => r.id === 'dsh-ray-personal-assistant')!.config['personalMemory'] as Record<string, unknown>)['automaticLearning'] as Record<string, unknown>

    expect(learnCfg['authorityId']).toBe('web-memory-extract-web')
    expect(learnCfg['workItemExperiences']).toBe(true)
    expect(reviewCfg['workItemExperiences']).toBe(true)
    expect(adoptCfg['workItemExperiences']).toBe(true)

    const second = await applyAutonomyWizardSetup(host, {
      action: 'enable',
      tier: 'conservative',
      provider: 'super-relay',
      model: 'auto_model/alwaysday1',
      reasoningEffort: '',
      enableMemoryLearning: true,
      enableDreaming: false,
      enableGrowth: false,
      workItemExperiences: undefined as unknown as boolean,
      customBudget: AUTONOMY_TIER_DEFAULTS.conservative,
      now: fixedNow,
    })
    expect(second.applied).toBe(true)
    const rowsAfterSecond = parse(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] }) as Array<{ id: string; config: Record<string, any> }>
    const learnCfgSecond = rowsAfterSecond.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config
    expect(learnCfgSecond['authorityId']).toBe('web-memory-extract-web')
    expect(learnCfgSecond['workItemExperiences']).toBe(true)
  })

  it('prefers active Lark owner route over stale web route and surfaces empty ownerRoutes with active Lark SQLite owner', () => {
    const { root, dshHome, profileDir, workspace } = createTempProfile()
    dirs.push(root)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const deliveryDb = join(dshHome, 'assistant-delivery', 'state.sqlite')
    const larkPrincipal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_bd27fe48ff506f7d7ca5e86853049947' }
    const seedDb = new DatabaseSync(deliveryDb)
    try {
      seedDb.exec(`
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
      seedDb.prepare(
        `INSERT INTO delivery_principals (id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version)
         VALUES (?, ?, ?, 'owner', 'active', NULL, 1, 1, 2)`,
      ).run('principal_lark_active', 'hash-lark-owner', JSON.stringify(larkPrincipal))
    } finally {
      seedDb.close()
    }

    // Case 1: dual routes where owner-web-desktop is stale and owner-lark-primary is active
    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      '    ownerRoutes:',
      '      - id: owner-web-desktop',
      '        conversation: { channel: web, account: desktop, tenant: local, kind: dm, chat: owner-primary }',
      '        principal: { channel: web, account: desktop, tenant: local, user: operator }',
      `        workspace: ${workspace}`,
      '        agentPreset: standard',
      '      - id: owner-lark-primary',
      '        conversation: { channel: lark, account: primary, tenant: personal, kind: dm, chat: oc_dm_1 }',
      '        principal: { channel: lark, account: primary, tenant: personal, user: ou_bd27fe48ff506f7d7ca5e86853049947 }',
      `        workspace: ${workspace}`,
      '        agentPreset: standard',
      '        policyRef: owner-dm',
      '        minimumGeneration: 1',
      '',
    ].join('\n'), 'utf8')
    const { host } = createHostContext({ profileDir, dshHome, profileName: 'desktop' })
    const docDual = parseDocument(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] })
    const routeDual = inspectOwnerRoute(host, {
      dshHome,
      canonicalHome: dshHome,
      profileName: 'desktop',
      profileDir,
      patchPath,
      patchExists: true,
      writable: true,
    }, docDual.contents as import('yaml').YAMLSeq, [])
    expect(routeDual.active).toBe(true)
    expect(routeDual.channel).toBe('lark')
    expect(routeDual.authorityId).toBe('owner-lark-primary')
    expect(routeDual.principalId).toBe('lark/primary/personal/ou_bd27fe48ff506f7d7ca5e86853049947')

    // Case 2: empty ownerRoutes with active Lark owner + conversation reports actionable repair guidance
    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      '    ownerRoutes: []',
      '',
    ].join('\n'), 'utf8')
    const db = new DatabaseSync(deliveryDb)
    try {
      db.prepare(`INSERT INTO conversation_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'owner-dm', 'active', 100, 100)`).run(
        'bind_lark',
        'hash_bind',
        JSON.stringify({ channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_dm_1' }),
        'principal_lark_active',
        JSON.stringify({ channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_bd27fe48ff506f7d7ca5e86853049947' }),
        workspace,
        'standard',
        'sess_1',
      )
    } finally {
      db.close()
    }
    const docEmpty = parseDocument(readFileSync(patchPath, 'utf8'), { customTags: [CUSTOM_JS_TAG] })
    const routeEmpty = inspectOwnerRoute(host, {
      dshHome,
      canonicalHome: dshHome,
      profileName: 'desktop',
      profileDir,
      patchPath,
      patchExists: true,
      writable: true,
    }, docEmpty.contents as import('yaml').YAMLSeq, [])
    expect(routeEmpty.configured).toBe(false)
    expect(routeEmpty.active).toBe(false)
    expect(routeEmpty.channel).toBe('lark')
    expect(routeEmpty.principalId).toBe('lark/primary/personal/ou_bd27fe48ff506f7d7ca5e86853049947')
    expect(routeEmpty.missingReason).toContain('一键初始化/修复前置项')

    // Case 3: split layout inferred cleanly from descriptor when patch row does not exist yet
    const ppSplit = getPersonalAndPolicyConfigs(docEmpty.contents as import('yaml').YAMLSeq, [{
      ns: 'dsh-ray-assistant-policy',
      schema: {},
      value: { rules: [{ id: 'split-rule-1' }], budgets: [{ id: 'b1' }] },
      revision: 1,
      applies: 'live',
    }])
    expect(ppSplit.layout).toBe('split')
    expect(Array.isArray(ppSplit.policyCfg['rules'])).toBe(true)
    expect((ppSplit.policyCfg['rules'] as Array<{ id: string }>)[0]?.id).toBe('split-rule-1')
  })
})
