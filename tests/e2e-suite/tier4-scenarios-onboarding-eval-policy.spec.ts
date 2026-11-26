import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { getExportFn, getMethod, sha256Hex } from './helpers/assertions.ts'
import { runBashCommand } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantActions,
  loadAssistantActionsBroker,
  loadAssistantDelivery,
  loadAssistantDreaming,
  loadAssistantEvaluation,
  loadAssistantEvolution,
  loadAssistantGrowthDriver,
  loadAssistantMemoryLearning,
  loadAssistantPolicy,
  loadAssistantPolicyEvaluator,
  loadAssistantProactive,
  loadAssistantVerifier,
  loadAssistantWebOwnerSetup,
  loadAssistantWorkItems,
  loadPersonalMemory,
  loadPluginSetup,
  loadPreferenceLearning,
  loadTaskAcceptanceContract,
} from './helpers/packages.ts'
import { createIsolatedEnv, createWorkspaceTracker, repoRoot, type TempWorkspace } from './helpers/workspace.ts'
import { findPatchRow, getPatchConfig, parseCordisPatch } from './helpers/yaml-presets.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

function createPresetFixtureDump(bundlesYaml: string) {
  return async (dshHome: string, profile: string): Promise<YAMLSeq> => {
    const rows = parseDocument(bundlesYaml).contents as YAMLSeq
    for (const path of [join(dshHome, 'cordis.patch.yml'), join(dshHome, 'profiles', profile, 'cordis.patch.yml')]) {
      let source: string
      try {
        source = await readFile(path, 'utf8')
      } catch {
        continue
      }
      const patch = parseDocument(source)
      if (patch.errors.length > 0 || !isSeq(patch.contents)) continue
      for (const entry of patch.contents.items) {
        if (!isMap(entry)) continue
        const target = rows.items.find(row => isMap(row) && row.get('id') === entry.get('id')) as YAMLMap | undefined
        if (target === undefined) continue
        if (entry.has('disabled')) target.set('disabled', entry.get('disabled'))
        const config = entry.get('config', true)
        if (isMap(config)) target.set('config', config.clone())
      }
    }
    return rows
  }
}

function makeAgent(id: string, workspace: string, agentPreset = 'primary') {
  return {
    id,
    status: 'running',
    options: {},
    session: {
      id: `sess-${id}`,
      header: { id: `sess-${id}`, cwd: workspace, agentPreset },
      deriveMessages: () => [],
    },
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

function activeWorkItemsConfig(
  ws: TempWorkspace,
  dbPath: string,
  admitMode: 'observe' | 'auto' = 'observe',
  kind = 'triage',
) {
  return {
    enabled: true,
    mode: 'active',
    databasePath: dbPath,
    workRoot: ws.workspace,
    workerAutomationId: 'worker-s2',
    scope: {
      workspace: ws.workspace,
      preset: 'primary',
      principalId: 'web/a/t/u',
      ownerRouteId: 'route-s2',
      expiresAt: Date.now() + 86_400_000,
    },
    admission: {
      allowedKinds: [kind],
      maxOpenItems: 100,
      maxAdmitsPerHour: 100,
      cooldownMs: 0,
    },
    intakeLedger: {
      enabled: true,
      sources: { 'lark-channel': { unaddressedGroupMessages: true, unsubscribedEvents: false } },
      evaluation: {
        enabled: true,
        admit: {
          enabled: true,
          mode: admitMode,
          kind,
          originBindingId: 'binding-origin-s2',
        },
      },
    },
  }
}

function makeProactiveProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prof-s2',
    mode: 'remind',
    expectedBenefit: 100,
    successPpm: 800_000,
    executionCost: 10,
    interruptionCost: 15,
    possibleLoss: 5,
    minimumUtility: 30,
    mergeWindowMs: 0,
    cooldownMs: 1_000,
    rejectionCooldownMs: 1_000,
    maxDecisionsPerGoal: 10,
    maxExecutionsPerGoal: 5,
    maxRemindersPerGoal: 5,
    ...overrides,
  }
}

function makeProactiveInput(wsRoot: string, seq: number) {
  return {
    waitId: `wait-s2-${seq}`,
    profileId: 'prof-s2',
    scope: { principalId: 'web/a/t/u', principalRecordId: 'rec-s2', principalVersion: 1, workspace: wsRoot, preset: 'primary' },
    goalId: 'goal-s2',
    sessionId: 'sess-s2',
    definitionDigest: sha256Hex('def-s2'),
    objective: 'Check upcoming CI deadline',
    nativeGoalId: 'ng-s2',
    nativeRevision: 1,
    ownerRouteId: 'route-s2',
    sourceDigest: sha256Hex('src-s2'),
    sourceId: 'src-s2',
    event: { id: `evt-s2-${seq}`, sequence: seq, digest: sha256Hex(`evt-s2-${seq}`), occurredAt: 1_700_000_000_000 + seq },
    expiresAt: 1_900_000_000_000,
  }
}

describe('Tier 4 Real-World Scenarios — S1–S3: Cold-Start Onboarding, Eval/WorkItems/Proactive Loop & WP08 Broker', () => {
  test('T4-S01 (F07, F14, F20): Cold-start web install -> R3 defaults -> owner task/feedback -> memory & preference adoption across restart', async () => {
    const ws = await workspaces.create('t4-s01-')
    const setupMod = await loadAssistantWebOwnerSetup()
    const pluginSetupMod = await loadPluginSetup()
    const policyMod = await loadAssistantPolicy()
    const deliveryMod = await loadAssistantDelivery()
    const evalMod = await loadAssistantEvaluation()
    const wiMod = await loadAssistantWorkItems()
    const proMod = await loadAssistantProactive()
    const memLearnMod = await loadAssistantMemoryLearning()
    const pmMod = await loadPersonalMemory()
    const growthMod = await loadAssistantGrowthDriver()
    const evoMod = await loadAssistantEvolution()
    const verMod = await loadAssistantVerifier()
    const prefMod = await loadPreferenceLearning()
    const dreamMod = await loadAssistantDreaming()

    // 1. Prepare Web owner profile & apply recommended plugin preset on disk
    const profileDir = join(ws.dshHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    const bundleSnippets = await Promise.all(
      ['personal-assistant', 'assistant-delivery'].map(async slug => {
        const text = await readFile(join(repoRoot, 'plugins', slug, 'cordis.patch.yml'), 'utf8')
        const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }] })
        const rows = doc.toJS() as Array<{ insert?: unknown[] }>
        const idx = rows.findIndex(r => r.insert !== undefined)
        const node = doc.getIn([idx, 'insert', 0], true)
        const exported = parseDocument('[]')
        if (isSeq(exported.contents)) exported.contents.flow = false
        exported.add(node)
        return exported.toString()
      }),
    )
    const effectiveSource = [
      bundleSnippets.join('\n'),
      '- id: dsh-ray-assistant-goals',
      '  name: "@dsh-ray/assistant-goals"',
      '- id: dsh-ray-assistant-web-owner',
      '  name: "@dsh-ray/assistant-web-owner"',
      '- id: dsh-ray-assistant-association',
      '  name: "@dsh-ray/assistant-association"',
    ].join('\n')
    const prepare = getExportFn<(input: Record<string, unknown>, source: string, effective: string) => {
      patch: string
      databasePath: string
      principal: { channel: string; account: string; tenant: string; user: string }
    }>(setupMod, 'prepareWebOwnerProfile')
    const prepared = prepare(
      { dshHome: ws.dshHome, profile: 'web', workspace: ws.workspace, preset: 'primary' },
      '[]\n',
      effectiveSource,
    )
    expect(prepared.principal.channel).toBe('web')
    expect(prepared.patch).toContain('assistant-web-owner')
    await writeFile(join(profileDir, 'cordis.patch.yml'), prepared.patch, 'utf8')

    // 2. Verify landed R3 default configs on Memory, Delivery, Growth, Evolution, Verifier, Preference & Proactive
    const delDefault = deliveryMod.Config({ databasePath: ws.sqlitePath('del-def'), spoolPath: join(ws.stateDir, 'spool-def') })
    expect(delDefault.attentionEnforce).toBe(true)
    expect(delDefault.attentionAttachOverCap).toBe(true)
    expect(delDefault.ownerReportRouting?.orderAcrossLanes).toBe(true)

    const memLearnDefault = memLearnMod.Config(undefined) as unknown as Record<string, unknown>
    expect(memLearnDefault.enabled).toBe(true)
    expect(memLearnDefault.workItemExperiences).toBe(true)

    const pmConfigFn = (pmMod as Record<string, unknown>).Config as (input: Record<string, unknown>) => { automaticLearning: unknown }
    expect(pmConfigFn({ databasePath: ':memory:' }).automaticLearning).toBe(true)

    const growthDefault = growthMod.normalizeConfig({}) as unknown as Record<string, unknown>
    expect(growthDefault.enabled).toBe(true)
    expect((growthDefault.pluginSourceProposals as Record<string, unknown>).enabled).toBe(true)
    expect((growthDefault.usageLearning as Record<string, unknown>).workItemFailures).toBe(true)

    const evoDefault = evoMod.AssistantEvolutionService.Config({ databasePath: ws.sqlitePath('evo-def') })
    const verDefault = verMod.Config({ databasePath: ws.sqlitePath('ver-def') })
    const prefDefault = prefMod.Config({ databasePath: ws.sqlitePath('pref-def') })
    const proDefault = proMod.Config({})
    expect(evoDefault.autonomousRollback).toBe(true)
    expect(verDefault.requireAcceptance).toBe(true)
    expect(prefDefault.enabled).toBe(true)
    expect(prefDefault.autonomousT1Enabled).toBe(true)
    expect(proDefault.intakeEvaluation?.enabled).toBe(true)

    // 3. Boot live Cordis host cluster for R3 services + memory & preference learning across restart
    const policyDb = ws.sqlitePath('policy')
    const memDb = ws.sqlitePath('memory')
    const prefDb = ws.sqlitePath('pref')
    const delDb = ws.sqlitePath('delivery')
    const evalDb = ws.sqlitePath('eval')
    const wiDb = ws.sqlitePath('work-items')

    const ownerRules = [
      {
        id: 'allow-owner-memory',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
        actions: ['propose', 'search', 'read', 'snapshot', 'export'],
        resource: { kind: 'memory', id: '*' },
        context: { initiators: ['foreground'] },
      },
      {
        id: 'allow-owner-pref',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
        actions: ['review', 'activate', 'snapshot', 'inspect'],
        resource: { kind: 'preference', id: '*' },
        context: { initiators: ['foreground'] },
      },
    ]

    const memoryDeliveryMock = {
      prepareAgentApproval: (_agent: unknown, input: { sourceId: string }) => ({
        routeVersion: 2 as const,
        sourceId: input.sourceId,
        bindingId: 'binding-s1',
        bindingVersion: 1,
        bindingGeneration: 1,
        workspace: ws.workspace,
        principal: 'web:web:local:operator',
        principalRecordId: 'owner-s1',
        principalVersion: 1,
      }),
      preferencePrincipalForAgent: () => ({
        principalId: 'web:web:local:operator',
        principalLineage: { principalRecordId: 'owner-s1', principalVersion: 1 },
        scope: { workspace: ws.workspace, preset: 'primary' },
      }),
    }

    // 3a. PersonalMemoryService owner task -> proposal -> approval -> fail-closed unauthorized -> restart persistence
    const ctxMem1 = harness.createContext()
    harness.provideMockService(ctxMem1, 'systemPrompt', { register: () => () => {}, context: () => () => {} })
    harness.provideMockService(ctxMem1, 'tools', { register: () => () => {} })
    harness.provideMockService(ctxMem1, 'assistantDelivery', memoryDeliveryMock)
    await harness.mountService(ctxMem1, policyMod.AssistantPolicyService, 'assistantPolicy', {
      databasePath: policyDb,
      rules: ownerRules as never,
    })
    const pm1 = await harness.mountService<{
      automaticLearningStatus: () => { enabled: boolean; mode: string }
      propose: (agent: unknown, input: Record<string, unknown>) => { proposalId: string; version: number; status: string }
      decideProposal: (input: Record<string, unknown>) => { status: string; record?: { id: string; content: string } }
      search: (agent: unknown, req: Record<string, unknown>) => readonly { record: { id: string; content: string } }[]
    }>(ctxMem1, pmMod.PersonalMemoryService, 'personalMemory', {
      databasePath: memDb,
      approvalMode: 'delivery-required',
      reconcileIntervalMs: 0,
    })
    expect(pm1.automaticLearningStatus().enabled).toBe(true)

    const ownerAgent = makeAgent('owner-s1', ws.workspace, 'primary')
    const foreignAgent = makeAgent('unauth-s1', ws.workspace, 'guest')
    const memoryContent = 'Prefer concise TypeScript patches with explicit Vitest assertions.'
    const prop = pm1.propose(ownerAgent, {
      idempotencyKey: 's1-mem-1',
      principal: 'web:web:local:operator',
      mutation: {
        op: 'add',
        identity: { owner: 'user', scope: 'workspace', workspace: ws.workspace },
        entry: {
          kind: 'instruction',
          content: memoryContent,
          sensitivity: 'private',
          trust: 'user-confirmed',
          confidence: 0.95,
          provenance: { source: 'owner-feedback', observedAt: Date.now() },
        },
      },
    })
    expect(prop.status).toBe('pending')

    // Negative contrast: unauthorized foreign agent cannot propose or search owner memory
    expect(() => pm1.propose(foreignAgent, {
      idempotencyKey: 's1-mem-denied',
      principal: 'web:web:local:operator',
      mutation: {
        op: 'add',
        identity: { owner: 'user', scope: 'workspace', workspace: ws.workspace },
        entry: {
          kind: 'instruction',
          content: 'Unauthorized memory write',
          sensitivity: 'private',
          trust: 'user-confirmed',
          confidence: 0.9,
          provenance: { source: 'owner-feedback', observedAt: Date.now() },
        },
      },
    })).toThrow(/policy denied/iu)

    const decided = pm1.decideProposal({
      proposalId: prop.proposalId,
      principal: 'web:web:local:operator',
      expectedVersion: prop.version,
      decision: 'approved',
      reason: 'owner-confirmed-in-first-task',
    })
    expect(decided.status).toBe('approved')
    expect(decided.record?.content).toBe(memoryContent)

    // 3b. Full R3 host stack (Delivery + Evaluation + Verifier + WorkItems + Proactive + PreferenceLearning)
    const ctxHost1 = harness.createContext()
    harness.provideMockService(ctxHost1, 'systemPrompt', { register: () => () => {}, context: () => () => {} })
    harness.provideMockService(ctxHost1, 'tools', { register: () => () => {} })
    harness.provideMockService(ctxHost1, 'llm', { chat: async () => ({ content: '{}' }), stream: async function* () {} })
    await harness.mountService(ctxHost1, policyMod.AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy-host'),
      rules: ownerRules as never,
    })
    await harness.mountService(ctxHost1, deliveryMod.AssistantDeliveryService, 'assistantDelivery', {
      databasePath: delDb,
      spoolPath: join(ws.stateDir, 'spool-host'),
      schedulerEnabled: false,
      defaultWorkspace: ws.workspace,
      defaultAgentPreset: 'primary',
    })
    await harness.mountService(ctxHost1, evalMod.AssistantEvaluationService, 'assistantEvaluation', {
      databasePath: evalDb,
      projectionIntervalMs: 0,
    })
    const verifier1 = await harness.mountService<{
      health: () => { evaluationConnected: boolean; requireAcceptance: boolean }
    }>(ctxHost1, verMod.AssistantVerifierService, 'assistantVerifier', verDefault)
    expect(verifier1.health().evaluationConnected).toBe(true)
    expect(verifier1.health().requireAcceptance).toBe(true)
    expect(ctxHost1.get('inProcessReload' as never)).toBeDefined()

    await harness.mountService(ctxHost1, wiMod.AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, wiDb, 'observe'))
    const proactive1 = await harness.mountService<{
      intakeEvaluationHealth: () => { enabled: boolean; registered: boolean }
    }>(ctxHost1, proMod.AssistantProactiveService, 'assistantProactive', {
      databasePath: ws.sqlitePath('pro-host'),
      intakeEvaluation: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' },
    })
    expect(proactive1.intakeEvaluationHealth().enabled).toBe(true)
    expect(proactive1.intakeEvaluationHealth().registered).toBe(true)

    const pref1 = await harness.mountService<{
      appendObservation: (input: Record<string, unknown>) => { id: string; preferenceKey: string; candidateValue: string }
      health: () => { enabled: boolean; signals: number }
    }>(ctxHost1, prefMod.PreferenceLearningService, 'assistantPreferenceLearning', {
      databasePath: prefDb,
    })
    expect(pref1.health().enabled).toBe(true)
    const obsSig = pref1.appendObservation({
      scope: { workspace: ws.workspace, preset: 'primary' },
      preferenceKey: 'response.language',
      candidateValue: 'zh-CN',
      stance: 'support',
      interpretationTrust: 'behavioral-inference',
      source: 'delivery-observation',
      occurredAt: Date.now(),
      idempotencyKey: 's1-pref-obs-1',
    })
    expect(obsSig.preferenceKey).toBe('response.language')
    expect(pref1.health().signals).toBeGreaterThanOrEqual(1)

    await harness.disposeAll()

    // 4. Restart both memory & preference services on the exact same SQLite DBs and verify durable persistence
    const ctxMem2 = harness.createContext()
    harness.provideMockService(ctxMem2, 'systemPrompt', { register: () => () => {}, context: () => () => {} })
    harness.provideMockService(ctxMem2, 'tools', { register: () => () => {} })
    harness.provideMockService(ctxMem2, 'assistantDelivery', memoryDeliveryMock)
    await harness.mountService(ctxMem2, policyMod.AssistantPolicyService, 'assistantPolicy', {
      databasePath: policyDb,
      rules: ownerRules as never,
    })
    const pm2 = await harness.mountService<{
      search: (agent: unknown, req: Record<string, unknown>) => readonly { record: { content: string } }[]
    }>(ctxMem2, pmMod.PersonalMemoryService, 'personalMemory', {
      databasePath: memDb,
      approvalMode: 'delivery-required',
      reconcileIntervalMs: 0,
    })
    const hits = pm2.search(ownerAgent, { query: 'TypeScript patches' })
    expect(hits.some(h => h.record.content === memoryContent)).toBe(true)

    const pref2 = await harness.mountService<{
      health: () => { enabled: boolean; signals: number }
    }>(ctxMem2, prefMod.PreferenceLearningService, 'assistantPreferenceLearning', {
      databasePath: prefDb,
    })
    expect(pref2.health().signals).toBeGreaterThanOrEqual(1)

    // 5. Assert unlanded/full Wave 1 R3/M1/M3/M5 onboarding contracts (no fallbacks)
    const wiDefaultCfg = wiMod.ConfigSchema({ databasePath: wiDb, workRoot: ws.workspace })
    expect(wiDefaultCfg.enabled).toBe(true)
    expect(wiDefaultCfg.intakeLedger?.enabled).toBe(true)
    expect(wiDefaultCfg.intakeLedger?.evaluation?.enabled).toBe(true)
    expect(wiDefaultCfg.intakeLedger?.evaluation?.admit).toBeUndefined()
    const wiBoundCfg = wiMod.ConfigSchema({
      databasePath: wiDb,
      workRoot: ws.workspace,
      intakeLedger: { evaluation: { admit: { originBindingId: 'binding-origin-1' } } },
    })
    expect(wiBoundCfg.intakeLedger?.evaluation?.admit?.enabled).toBe(true)

    const evalDefaultCfg = evalMod.Config({ databasePath: evalDb })
    expect(evalDefaultCfg.notificationOutcomesEnabled).toBe(true)
    expect(evalDefaultCfg.attentionTuningAutoAdopt).toBe(true)
    expect(evalDefaultCfg.attentionLooseningEnabled).toBe(true)

    const dreamDb = ws.sqlitePath('dream-def')
    expect(dreamMod.hasCompleteDreamingPrerequisites({ databasePath: dreamDb })).toBe(false)
    expect(dreamMod.normalizeConfig({ databasePath: dreamDb }).enabled).toBe(false)

    const dreamCompleteInput = {
      databasePath: dreamDb,
      scope: {
        workspace: ws.workspace,
        preset: 'primary',
        principalId: 'web:web:local:operator',
        ownerRouteId: 'route-s1',
      },
      provider: 'deepseek',
      model: 'deepseek-chat',
      budgetId: 'dream-budget',
      budgetAmount: 1,
    }
    expect(dreamMod.hasCompleteDreamingPrerequisites(dreamCompleteInput)).toBe(true)
    const dreamDefaultCfg = dreamMod.normalizeConfig(dreamCompleteInput)
    expect(dreamDefaultCfg.enabled).toBe(true)

    const bundlesYaml = [
      '- id: dsh-ray-assistant-work-items',
      '  name: "@dsh-ray/assistant-work-items"',
      '  config:',
      '    enabled: false',
      `    databasePath: ${wiDb}`,
      `    workRoot: ${ws.workspace}`,
      '- id: dsh-ray-assistant-evaluation',
      '  name: "@dsh-ray/assistant-evaluation"',
      '  config:',
      `    databasePath: ${evalDb}`,
      '    notificationOutcomesEnabled: false',
      '    attentionTuningAutoAdopt: false',
      '    attentionLooseningEnabled: false',
    ].join('\n')
    const applyPreset = getExportFn<(target: Record<string, unknown>, opts: Record<string, unknown>) => Promise<{ changed: boolean }>>(
      pluginSetupMod,
      'applyRecommendedPluginPreset',
    )
    const presetRes = await applyPreset({ dshHome: ws.dshHome, profile: 'web' }, { readDump: createPresetFixtureDump(bundlesYaml) })
    expect(presetRes.changed).toBe(true)
    const patchDoc = parseCordisPatch(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'))
    expect(getPatchConfig(findPatchRow(patchDoc.document, 'dsh-ray-assistant-work-items')).enabled).toBe(true)
    expect(getPatchConfig(findPatchRow(patchDoc.document, 'dsh-ray-assistant-evaluation')).attentionLooseningEnabled).toBe(true)

    const env = await createIsolatedEnv(ws)
    const dryRun = await runBashCommand(
      [join(repoRoot, 'scripts/install/install-local.sh'), '--dry-run', '--scenario', 'web', '--yes'],
      { env },
    )
    expect(dryRun.exitCode).toBe(0)
    expect(dryRun.stdout + dryRun.stderr).toContain('assistant-association')
    expect(prepared.patch).toContain('assistant-association')
  }, 30_000)

  test('T4-S02 (F03, F04, F05, F07): Evaluation loosening (observe -> auto) -> WorkItems restart-persistent admission & AEAD integrity -> Proactive dynamic utility', async () => {
    const ws = await workspaces.create('t4-s02-')
    const policyMod = await loadAssistantPolicy()
    const evalMod = await loadAssistantEvaluation()
    const wiMod = await loadAssistantWorkItems()
    const proMod = await loadAssistantProactive()
    const { createTaskAcceptanceContract } = await loadTaskAcceptanceContract()

    const wiDb = ws.sqlitePath('work-items')
    const policyDb = ws.sqlitePath('policy')
    const evalDb = ws.sqlitePath('evaluation')

    // 1. Dynamic Proactive utility & WP22 attentionOverlay (with OpportunityEngine.close() in finally)
    let idleUtility = 0
    const engine = new proMod.OpportunityEngine(ws.sqlitePath('pro-eng'), [makeProactiveProfile({ minimumUtility: 50 })])
    try {
      const highRes = engine.evaluate(makeProactiveInput(ws.workspace, 1), undefined, { userActive: false, urgencyPpm: 950_000 })
      const lowRes = engine.evaluate(makeProactiveInput(ws.workspace, 2), undefined, { userActive: false, urgencyPpm: 200_000 })
      const busyRes = engine.evaluate(makeProactiveInput(ws.workspace, 3), undefined, {
        userActive: true,
        recentNotificationCount: 5,
        urgencyPpm: 950_000,
      })
      idleUtility = highRes.decision.utility
      expect(highRes.decision.utility).toBeGreaterThan(lowRes.decision.utility)
      expect(busyRes.decision.utility).toBeLessThan(idleUtility)
    } finally {
      engine.close()
    }

    const overlayEngine = new proMod.OpportunityEngine(ws.sqlitePath('pro-eng-overlay'), [makeProactiveProfile({ minimumUtility: 50 })])
    try {
      const overlay = proMod.attentionOverlay({
        version: 1,
        digest: sha256Hex('overlay-s2'),
        parameters: { interruptionCostDelta: 10, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
      })
      const overlayRes = overlayEngine.evaluate(makeProactiveInput(ws.workspace, 4), overlay, { userActive: false, urgencyPpm: 950_000 })
      expect(overlayRes.decision.utility).toBe(idleUtility - 10)
    } finally {
      overlayEngine.close()
    }

    // 2. Mount Evaluation + WorkItems + Proactive + Policy + Delivery/Verifier peers
    const objectiveText = 'Remediate flaky E2E queue test in repository'
    const digest = sha256Hex(objectiveText)
    const issuedAt = Date.now() - 1_000
    const createContract = createTaskAcceptanceContract as (input: Record<string, unknown>) => { id: string; digest: string }
    const contract = createContract({
      protocol: 'task-acceptance/v1',
      id: 'c-t4-s02',
      scope: { workspace: ws.workspace, preset: 'primary' },
      owner: { principalRecordId: 'owner-s2', principalVersion: 1 },
      task: { kind: 'automation-run', ref: 'run-c-t4-s02' },
      objective: objectiveText,
      profile: { id: 'intake-profile', version: 1, digest: sha256Hex('intake-profile') },
      issuedAt,
      expiresAt: issuedAt + 3_600_000,
      criteria: [{
        id: 'result',
        kind: 'process-behavior',
        authority: { id: 'intake-runner', digest: sha256Hex('intake-runner') },
        artifactPath: 'result.txt',
        stdin: '',
        expectedStdout: '',
        expectedExitCode: 0,
      }],
      bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
    })

    const mountPeers = async (ctx: ReturnType<typeof harness.createContext>) => {
      await harness.mountService(ctx, policyMod.AssistantPolicyService, 'assistantPolicy', {
        databasePath: policyDb,
        rules: [{
          id: 'r-auto-s2',
          effect: 'allow',
          subject: { kind: 'background', id: 'work-items/v1', workspace: ws.workspace, principal: 'web/a/t/u' },
          actions: ['admit'],
          resource: { kind: 'automation', id: 'worker-s2' },
          context: { initiators: ['background'] },
        }] as never,
      })
      harness.provideMockService(ctx, 'assistantDelivery', {
        isMaintenanceDraining: () => true,
        validateOwnerRoute: (value: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
          receiptVersion: 2,
          ...value,
          authorityHash: sha256Hex('owner-auth-s2'),
          principalRecordId: 'owner-s2',
          principalVersion: 1,
          bindingVersion: 1,
          generation: 1,
        }),
        enqueueBackground: async () => ({ id: 'outbox-s2' }),
        enqueueOwnerNotification: () => ({ id: 'notice-s2' }),
      })
      harness.provideMockService(ctx, 'assistantVerifier', {
        inspectAcceptedTask: (id: string) => (id === contract.id
          ? { contract, state: 'awaiting-execution', attempts: 0, reason: null, receipt: null }
          : null),
      })
    }

    const ctx1 = harness.createContext()
    await mountPeers(ctx1)
    const evaluation = await harness.mountService<Record<string, unknown>>(ctx1, evalMod.AssistantEvaluationService, 'assistantEvaluation', {
      databasePath: evalDb,
      projectionIntervalMs: 0,
      notificationOutcomesEnabled: true,
      attentionTuningAutoAdopt: true,
      attentionLooseningEnabled: true,
      intakeEvaluationAgreementEnabled: true,
    })
    const wi1 = await harness.mountService<{
      applyIntakeTuning: (u: Record<string, unknown>) => { mode: string; rules: readonly Record<string, unknown>[] }
      intakeAdmissionMode: () => string
      intakeTuning: () => { mode: string; rules: readonly Record<string, unknown>[] }
      registerIntakeEvaluator: (reg: unknown) => () => void
      recordIntake: (input: unknown, sourceText?: string) => unknown
      intakeEvaluations: (source: string, sourceEventId: string) => readonly { wouldAccept: boolean }[]
    }>(ctx1, wiMod.AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, wiDb, 'observe', 'triage'))
    const proactive1 = await harness.mountService<{
      evaluate: (input: unknown, runtimeContext?: unknown) => { decision: { utility: number; reason: string } }
    }>(ctx1, proMod.AssistantProactiveService, 'assistantProactive', {
      databasePath: ws.sqlitePath('pro-svc'),
      profiles: [makeProactiveProfile({ minimumUtility: idleUtility - 5 })],
    })

    expect(wi1.intakeAdmissionMode()).toBe('observe')

    // Assert M1 WP22 loosening contract on Evaluation -> WorkItems + Proactive
    expect(typeof evaluation.onAttentionLooseningAdopted).toBe('function')
    expect(typeof evaluation.emitLooseningToConsumers).toBe('function')
    const subscribe = getMethod<(cb: (d: Record<string, unknown>) => void) => () => void>(evaluation, 'onAttentionLooseningAdopted')
    const emit = getMethod<(input: Record<string, unknown>) => unknown>(evaluation, 'emitLooseningToConsumers')

    subscribe(decision => {
      wi1.applyIntakeTuning({
        ...(typeof decision.workItemsMode === 'string' ? { workItemsMode: decision.workItemsMode } : {}),
        ...(Array.isArray(decision.intakeRuleUpdates) ? { intakeRuleUpdates: decision.intakeRuleUpdates } : {}),
      })
    })
    emit({
      workItemsMode: 'auto',
      intakeRuleUpdates: [
        { ruleId: 'dsh-intake-github-mention-or-review', enabled: true, mode: 'auto', confidenceThresholdPpm: 800_000, minUtility: 10 },
      ],
    })

    expect(wi1.intakeAdmissionMode()).toBe('auto')
    expect(wi1.intakeTuning().rules.find(r => r.ruleId === 'dsh-intake-github-mention-or-review')).toMatchObject({
      mode: 'auto',
      confidenceThresholdPpm: 800_000,
    })

    wi1.registerIntakeEvaluator({
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'r-auto-s2', ceiling: 'accept' }] }),
      evaluate: () => Promise.resolve({ level: 'accept', quotes: ['Remediate flaky E2E'] }),
    })
    wi1.recordIntake({
      source: 'lark-channel',
      sourceEventId: 'evt-s2-1',
      kind: 'message',
      senderAllowlisted: true,
      addressed: false,
      threadFollowUp: false,
      senderIsBot: false,
      groupMessage: true,
      contentDigest: digest,
      occurredAt: Date.now(),
      objective: objectiveText,
      objectiveDigest: digest,
      acceptance: { contractId: contract.id, contractDigest: contract.digest },
    }, objectiveText)
    await vi.waitFor(() => expect(wi1.intakeEvaluations('lark-channel', 'evt-s2-1')).toMatchObject([{ wouldAccept: true }]))

    // Verify AssistantProactiveService reads live Evaluation tuning cleanly (exposes #attentionCohort proxy defect if unfixed)
    const evalTuningReq = evaluation as unknown as {
      requestAttentionTuning: (input: Record<string, unknown>) => { status: string }
    }
    expect(evalTuningReq.requestAttentionTuning({
      scope: { workspace: ws.workspace, preset: 'primary' },
      cohort: proMod.proactiveAttentionCohort,
      parameters: { interruptionCostDelta: 10, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
    }).status).toBe('adopted')
    const tightenedEval = proactive1.evaluate(makeProactiveInput(ws.workspace, 10), { userActive: false, urgencyPpm: 950_000 })
    expect(tightenedEval.decision.utility).toBe(idleUtility - 10)
    expect(tightenedEval.decision.reason).toBe('below-threshold')

    await harness.disposeAll()

    // Inspect AEAD staging before restart
    const stagingDb = new DatabaseSync(wiDb, { readOnly: true })
    try {
      const staged = stagingDb.prepare(
        'SELECT iv, auth_tag, ciphertext, has_objective, has_acceptance FROM work_item_intake_staging WHERE source = ? AND source_event_id = ?',
      ).get('lark-channel', 'evt-s2-1') as {
        iv: Uint8Array
        auth_tag: Uint8Array
        ciphertext: Uint8Array
        has_objective: number
        has_acceptance: number
      } | undefined
      expect(staged).toBeDefined()
      expect(staged!.has_objective).toBe(1)
      expect(staged!.has_acceptance).toBe(1)
      expect(staged!.iv.byteLength).toBe(12)
      expect(staged!.auth_tag.byteLength).toBe(16)
      expect(Buffer.from(staged!.ciphertext).toString('utf8')).not.toContain(objectiveText)
    } finally {
      stagingDb.close()
    }

    // 3. Restart fresh Cordis Context with static mode='observe': persisted WP22 'auto' mode & staging execute 'admitted'
    const ctx2 = harness.createContext()
    await mountPeers(ctx2)
    const wi2 = await harness.mountService<{
      intakeAdmissionMode: () => string
      applyIntakeTuning: (u: Record<string, unknown>) => { mode: string }
      runIntakeAdmission: () => readonly { outcome: string; mode: string; itemId: string | null }[]
    }>(ctx2, wiMod.AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, wiDb, 'observe', 'triage'))
    expect(wi2.intakeAdmissionMode()).toBe('auto')
    const admissions = wi2.runIntakeAdmission()
    expect(admissions[0]?.mode).toBe('auto')
    expect(admissions[0]?.outcome).toBe('admitted')
    expect(admissions[0]?.itemId).not.toBeNull()

    const checkDb = new DatabaseSync(wiDb, { readOnly: true })
    try {
      const item = checkDb.prepare('SELECT id, brief FROM work_item WHERE id = ?').get(admissions[0]!.itemId!) as {
        id: string
        brief: string
      } | undefined
      expect(item?.brief).toBe(objectiveText)
    } finally {
      checkDb.close()
    }

    // Tightening rollback reverts mode back to 'observe'
    wi2.applyIntakeTuning({ workItemsMode: 'observe' })
    expect(wi2.intakeAdmissionMode()).toBe('observe')
  })

  test('T4-S03 (F02, F10): WP08 lease + cost-cap + sensitivity + commit-digest-pinned multi-target Broker dispatch & ledger', async () => {
    const ws = await workspaces.create('t4-s03-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
    const { AssistantActionsService } = await loadAssistantActions()
    const brokerMod = await loadAssistantActionsBroker()

    let requestsReceived = 0
    const server = createServer((req, res) => {
      requestsReceived += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ received: true, method: req.method, path: req.url }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const now = Date.now()
      const expectedDigest = sha256Hex('t4-s03-commit-v1')
      const targetUrl = `http://127.0.0.1:${port}/v1/report`

      // 1. Standalone WP08 PolicyRule evaluation for lease, sensitivity, destination, cost cap & commitDigest
      const compiled = compilePolicy([{
        id: 'wp08-s3-rule',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'owner-s3' },
        actions: ['execute'],
        resource: { kind: 'network', id: 'http:report' },
        context: { initiators: ['foreground'] },
        lease: { leaseId: 's3-lease-1', expiresAtMs: now + 60_000, maxUses: 1, revoked: false },
        destinations: [targetUrl],
        maxSensitivity: 'internal',
        monetaryCostCapMicros: 15_000,
        commitDigest: expectedDigest,
      } as never])
      const evalPolicy = evaluatePolicy as (p: unknown, req: Record<string, unknown>) => { effect: string; reasonCode: string }
      const basePolicyReq = {
        subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'owner-s3' },
        action: 'execute',
        resource: { kind: 'network', id: 'http:report' },
        context: { initiator: 'foreground' },
        lease: { leaseId: 's3-lease-1' },
        destination: targetUrl,
        sensitivity: 'internal',
        estimatedCostMicros: 10_000,
        commitDigest: expectedDigest,
      }
      expect(evalPolicy(compiled, basePolicyReq).effect).toBe('allow')
      expect(evalPolicy(compiled, { ...basePolicyReq, sensitivity: 'restricted' }).reasonCode).toBe('sensitivity-exceeded')
      expect(evalPolicy(compiled, { ...basePolicyReq, estimatedCostMicros: 50_000 }).reasonCode).toBe('monetary-cost-exceeded')
      expect(evalPolicy(compiled, { ...basePolicyReq, destination: `http://127.0.0.1:${port}/v1/exfil` }).reasonCode).toBe('destination-mismatch')
      expect(evalPolicy(compiled, { ...basePolicyReq, commitDigest: sha256Hex('wrong') }).reasonCode).toBe('commit-digest-mismatch')

      // 2. Mount AssistantPolicyService (SQLite) + AssistantActionsService with WP08-pinned HTTP grant
      const owner = {
        principalDigest: sha256Hex('owner-s3'),
        principalRecordId: 'owner-s3',
        principalVersion: 1,
        workspace: ws.workspace,
        preset: 'primary',
        bindingId: 'binding-s3',
        bindingVersion: 1,
        bindingGeneration: 1,
      }
      const createProj = getExportFn<(grant: Record<string, unknown>) => Record<string, unknown>>(brokerMod, 'createActionGrantProjection')
      const httpProjection = createProj({
        protocol: brokerMod.ACTION_GRANT_PROTOCOL,
        id: 'http-s3-grant',
        revision: 1,
        domain: 'http',
        clientKeyId: 'host-s3',
        owner,
        sessionId: 'sess-s3',
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['http'],
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [port],
          allowedMethods: ['GET', 'POST'],
          allowedPathPrefixes: ['/v1/'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 4_096,
        },
        credentialId: 'none',
        expiresAt: now + 60_000,
        maxActions: 5,
        maxTotalBytes: 1_048_576,
        maxCostUnits: 5,
        allowedOperations: ['http.request'],
        client: { kind: 'assistant-actions-host', instanceId: 'host-s3', generation: 1 },
        source: { classification: 'internal', provenanceDigest: 'a'.repeat(64) },
        policyEpoch: 1,
        emergencyEpoch: 0,
        lease: { leaseId: 's3-lease-1', expiresAtMs: now + 60_000, maxUses: 1 },
        destinations: [targetUrl],
        maxSensitivity: 'internal',
        monetaryCostCapMicros: 15_000,
        commitDigest: expectedDigest,
      })

      const agent = makeAgent('agent-s3', ws.workspace, 'primary')
      agent.session.id = 'sess-s3'
      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'tools', { register: () => () => {} })
      harness.provideMockService(ctx, 'agents', { get: (id: string) => (id === agent.id ? agent : undefined) })
      harness.provideMockService(ctx, 'assistantDelivery', {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-s3',
          principalLineage: { principalRecordId: 'owner-s3', principalVersion: 1 },
          sessionId: 'sess-s3',
          scope: { workspace: ws.workspace, preset: 'primary' },
          bindingId: 'binding-s3',
          bindingVersion: 1,
          bindingGeneration: 1,
        }),
      })
      const policyDbPath = ws.sqlitePath('policy')
      const leasePolicyRules = [
        {
          id: 'allow-broker-s3',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
          actions: ['execute'],
          resource: { kind: 'tool', id: '*' },
          context: { initiators: ['foreground'] },
        },
        {
          id: 'wp08-s3-persist-lease',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'owner-s3' },
          actions: ['execute'],
          resource: { kind: 'network', id: 'http:report' },
          context: { initiators: ['foreground'] },
          lease: { leaseId: 's3-persist-lease', expiresAtMs: now + 60_000, maxUses: 1, revoked: false },
          destinations: [targetUrl],
          maxSensitivity: 'internal',
          monetaryCostCapMicros: 15_000,
          commitDigest: expectedDigest,
        },
      ]
      const policy1 = await harness.mountService<{
        authorize: (req: Record<string, unknown>, opts?: { idempotencyKey?: string }) => { effect: string; reasonCode: string; replayed?: boolean }
      }>(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: policyDbPath,
        rules: leasePolicyRules as never,
      })
      const policyLeaseReq = {
        subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'owner-s3' },
        action: 'execute',
        resource: { kind: 'network', id: 'http:report' },
        context: { initiator: 'foreground' },
        lease: { leaseId: 's3-persist-lease' },
        destination: targetUrl,
        sensitivity: 'internal',
        estimatedCostMicros: 10_000,
        commitDigest: expectedDigest,
      }
      expect(policy1.authorize(policyLeaseReq, { idempotencyKey: 's3-persist-1' }).effect).toBe('allow')
      const actionsStateRoot = join(ws.stateDir, 'actions')
      const actions = await harness.mountService<{
        executeAction: (agent: unknown, input: Record<string, unknown>, signal: AbortSignal) => Promise<{
          status: string
          actionId?: string
        }>
      }>(ctx, AssistantActionsService, 'assistantActions', {
        stateRoot: actionsStateRoot,
        actionGrants: [httpProjection as never],
      })

      const baseInput = {
        grantId: 'http-s3-grant',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/report' },
        payload: { method: 'POST', url: targetUrl, body: '{"status":"ok"}' },
        estimatedCostMicros: 10_000,
        commitDigest: expectedDigest,
      }

      // Fail-closed denials BEFORE valid use (zero requests hit loopback server, lease unconsumed)
      await expect(actions.executeAction(agent, { ...baseInput, idempotencyKey: 's3-cost-bad', estimatedCostMicros: 50_000 }, new AbortController().signal))
        .rejects.toThrow(/WP08 policy rejected \(cost-cap-exceeded\)/u)
      await expect(actions.executeAction(agent, {
        ...baseInput,
        idempotencyKey: 's3-dest-bad',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/exfil' },
        payload: { method: 'POST', url: `http://127.0.0.1:${port}/v1/exfil` },
      }, new AbortController().signal)).rejects.toThrow(/WP08 policy rejected \(destination-mismatch\)/u)
      await expect(actions.executeAction(agent, { ...baseInput, idempotencyKey: 's3-digest-bad', commitDigest: sha256Hex('wrong') }, new AbortController().signal))
        .rejects.toThrow(/WP08 policy rejected \(commit-digest-mismatch\)/u)
      expect(requestsReceived).toBe(0)

      // Valid compliant dispatch executes once
      const okRes = await actions.executeAction(agent, { ...baseInput, idempotencyKey: 's3-ok-1' }, new AbortController().signal)
      expect(okRes.status).toBe('succeeded')
      expect(requestsReceived).toBe(1)

      // Second compliant call with fresh idempotencyKey fails closed on exhausted maxUses=1 lease
      await expect(actions.executeAction(agent, { ...baseInput, idempotencyKey: 's3-ok-2' }, new AbortController().signal))
        .rejects.toThrow(/WP08 policy rejected \(lease-exhausted\)/u)
      expect(requestsReceived).toBe(1)

      // Validate lark, calendar, and shell broker envelopes
      const validateReq = getExportFn<(req: unknown) => { kind: string }>(brokerMod, 'validateBrokerActionRequest')
      expect(validateReq({ kind: 'lark', operation: 'send-message', chatId: 'oc_s3', text: 'report ready', grantId: 'g-l', idempotencyKey: 'k-l' }).kind).toBe('lark')
      expect(validateReq({ kind: 'calendar', operation: 'list-events', calendarId: 'cal-s3', startTime: 1000, endTime: 5000, grantId: 'g-c', idempotencyKey: 'k-c' }).kind).toBe('calendar')
      expect(validateReq({ kind: 'shell', operation: 'exec', command: ['/bin/echo', 's3'], cwd: ws.workspace, grantId: 'g-s', idempotencyKey: 'k-s' }).kind).toBe('shell')

      // Verify WP08 lease usage & idempotency persist across SQLite restart
      await harness.disposeAll()
      const ctx2 = harness.createContext()
      const policy2 = await harness.mountService<{
        authorize: (req: Record<string, unknown>, opts?: { idempotencyKey?: string }) => { effect: string; reasonCode: string; replayed?: boolean }
      }>(ctx2, AssistantPolicyService, 'assistantPolicy', {
        databasePath: policyDbPath,
        rules: leasePolicyRules as never,
      })
      const replayedAuth = policy2.authorize(policyLeaseReq, { idempotencyKey: 's3-persist-1' })
      expect(replayedAuth.effect).toBe('allow')
      const exhaustedAuth = policy2.authorize(policyLeaseReq, { idempotencyKey: 's3-persist-2' })
      expect(exhaustedAuth.effect).toBe('deny')
      expect(exhaustedAuth.reasonCode).toBe('lease-exhausted')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
