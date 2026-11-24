import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { getExportFn, getMethod, sha256Hex } from './helpers/assertions.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantAssociation,
  loadAssistantDelivery,
  loadAssistantEvaluation,
  loadAssistantGoals,
  loadAssistantGoalsStrategyRouter,
  loadAssistantPolicy,
  loadAssistantPolicyEvaluator,
  loadAssistantProactive,
  loadAssistantWorkItems,
  loadBenchmarkIndex,
  loadBenchmarkRunner,
  loadBenchmarkStore,
  loadFamiliesCorpus,
  loadNativeBenchmark,
  loadPluginSetup,
  loadTaskAcceptanceContract,
} from './helpers/packages.ts'
import { createWorkspaceTracker, type TempWorkspace } from './helpers/workspace.ts'
import { findPatchRow, getPatchConfig, parseCordisPatch } from './helpers/yaml-presets.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

function activeWorkItemsConfig(
  ws: TempWorkspace,
  dbPath: string,
  admitMode: 'observe' | 'auto' = 'observe',
  kind = 'intake-inferred',
) {
  return {
    enabled: true,
    mode: 'active',
    databasePath: dbPath,
    workRoot: ws.workspace,
    workerAutomationId: 'worker-1',
    scope: {
      workspace: ws.workspace,
      preset: 'primary',
      principalId: 'web/a/t/u',
      ownerRouteId: 'route-1',
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
          originBindingId: 'binding-origin-1',
        },
      },
    },
  }
}

async function mountWorkItemsPeers(
  ctx: ReturnType<typeof harness.createContext>,
  ws: TempWorkspace,
  policyDbPath: string,
  objectiveText: string,
  contractId: string,
  policyRules: readonly Record<string, unknown>[] = [
    {
      id: 'r-auto',
      effect: 'allow',
      subject: { kind: 'background', id: 'work-items/v1', workspace: ws.workspace, principal: 'web/a/t/u' },
      actions: ['admit'],
      resource: { kind: 'automation', id: 'worker-1' },
      context: { initiators: ['background'] },
    },
  ],
  contractWindow: { issuedAt: number; expiresAt: number } = (() => {
    const issuedAt = Date.now() - 1_000
    return { issuedAt, expiresAt: issuedAt + 3_600_000 }
  })(),
  extraContracts: readonly { contractId: string; objectiveText: string }[] = [],
  extraHandlesOut?: Array<{ contractId: string; contractDigest: string }>,
) {
  const { AssistantPolicyService } = await loadAssistantPolicy()
  const { createTaskAcceptanceContract } = await loadTaskAcceptanceContract()

  await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
    databasePath: policyDbPath,
    rules: policyRules as never,
  })

  harness.provideMockService(ctx, 'assistantDelivery', {
    isMaintenanceDraining: () => true,
    validateOwnerRoute: (value: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
      receiptVersion: 2,
      ...value,
      authorityHash: sha256Hex('owner-auth'),
      principalRecordId: 'owner-1',
      principalVersion: 1,
      bindingVersion: 1,
      generation: 1,
    }),
    enqueueBackground: async () => ({ id: 'outbox-1' }),
  })

  const createContract = createTaskAcceptanceContract as (input: Record<string, unknown>) => { id: string; digest: string }
  const makeContract = (cid: string, obj: string) => createContract({
    protocol: 'task-acceptance/v1',
    id: cid,
    scope: { workspace: ws.workspace, preset: 'primary' },
    owner: { principalRecordId: 'owner-1', principalVersion: 1 },
    task: { kind: 'automation-run', ref: `run-${cid}` },
    objective: obj,
    profile: { id: 'intake-profile', version: 1, digest: sha256Hex('intake-profile') },
    issuedAt: contractWindow.issuedAt,
    expiresAt: contractWindow.expiresAt,
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

  const contractsById = new Map<string, { id: string; digest: string }>()
  const primary = makeContract(contractId, objectiveText)
  contractsById.set(primary.id, primary)
  for (const extra of extraContracts) {
    const built = makeContract(extra.contractId, extra.objectiveText)
    contractsById.set(built.id, built)
    extraHandlesOut?.push({ contractId: built.id, contractDigest: built.digest })
  }

  harness.provideMockService(ctx, 'assistantVerifier', {
    inspectAcceptedTask: (id: string) => {
      const found = contractsById.get(id)
      return found
        ? { contract: found, state: 'awaiting-execution', attempts: 0, reason: null, receipt: null }
        : null
    },
  })

  return { contractId: primary.id, contractDigest: primary.digest }
}

function validEvaluator(quote: string) {
  return {
    protocol: 1,
    policy: () => ({ version: 'v1', rules: [{ ruleId: 'r-auto', ceiling: 'accept' }] }),
    evaluate: () => Promise.resolve({ level: 'accept', quotes: [quote] }),
  }
}

function makeProactiveProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prof-1',
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

function makeProactiveInput(wsRoot: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    waitId: `wait-${seq}`,
    profileId: 'prof-1',
    scope: { principalId: 'web/a/t/u', principalRecordId: 'rec-1', principalVersion: 1, workspace: wsRoot, preset: 'primary' },
    goalId: 'goal-1',
    sessionId: 'sess-1',
    definitionDigest: sha256Hex('def'),
    objective: 'Check upcoming deadline',
    nativeGoalId: 'ng-1',
    nativeRevision: 1,
    ownerRouteId: 'route-1',
    sourceDigest: sha256Hex('src'),
    sourceId: 'src-1',
    event: { id: `evt-${seq}`, sequence: seq, digest: sha256Hex(`evt-${seq}`), occurredAt: 1_700_000_000_000 + seq },
    expiresAt: 1_900_000_000_000,
    ...overrides,
  }
}

class DeterministicNativeAdapter extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const promptText = options.messages
      .flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text))
      .join('\n')
    const text = promptText.includes('【规划阶段')
      ? 'Step 1: analyze requirements; Step 2: compute grounded JSON output.'
      : JSON.stringify({ answer: 'ok', citations: [] })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

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

describe('Tier 3 Pairwise — F02–F07 & F15: Evaluation, WorkItems, Proactive, Policy & Benchmarks', () => {
  test('T3-EW-01 (F03+F04+F07): Evaluation WP22 loosening (observe -> auto + dynamic rules) persists in WorkItems SQLite across Cordis restart', async () => {
    const ws = await workspaces.create('t3-ew01-')
    const evalMod = await loadAssistantEvaluation()
    const wiMod = await loadAssistantWorkItems()
    const wiDb = ws.sqlitePath('work-items')
    const policyDb = ws.sqlitePath('policy')
    const evalDb = ws.sqlitePath('evaluation')

    // Verify R3 defaults on Evaluation & WorkItems schemas before mounting
    const evalDefaultCfg = evalMod.Config({ databasePath: evalDb })
    const wiDefaultCfg = wiMod.ConfigSchema({ databasePath: wiDb, workRoot: ws.workspace })
    const wiBoundCfg = wiMod.ConfigSchema({
      databasePath: wiDb,
      workRoot: ws.workspace,
      intakeLedger: { evaluation: { admit: { originBindingId: 'binding-origin-1' } } },
    })
    expect(evalDefaultCfg.notificationOutcomesEnabled).toBe(true)
    expect(evalDefaultCfg.attentionTuningAutoAdopt).toBe(true)
    expect(evalDefaultCfg.attentionLooseningEnabled).toBe(true)
    expect(wiDefaultCfg.intakeLedger?.evaluation?.admit).toBeUndefined()
    expect(wiBoundCfg.intakeLedger?.evaluation?.admit?.enabled).toBe(true)

    const objectiveText = 'Fix CI workflow build cache miss'
    const digest = sha256Hex(objectiveText)
    const issuedAt = Date.now() - 1_000
    const contractWindow = { issuedAt, expiresAt: issuedAt + 3_600_000 }

    const ctx1 = harness.createContext()
    const acceptance = await mountWorkItemsPeers(ctx1, ws, policyDb, objectiveText, 'c-ew01', undefined, contractWindow)
    const evaluation = await harness.mountService(ctx1, evalMod.AssistantEvaluationService, 'assistantEvaluation', {
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

    const subscribe = getMethod<(cb: (d: Record<string, unknown>) => void) => () => void>(evaluation, 'onAttentionLooseningAdopted')
    const adopt = getMethod<(input: Record<string, unknown>) => unknown>(evaluation, 'emitLooseningToConsumers')
    subscribe(decision => {
      wi1.applyIntakeTuning({
        ...(typeof decision.workItemsMode === 'string' ? { workItemsMode: decision.workItemsMode } : {}),
        ...(Array.isArray(decision.intakeRuleUpdates) ? { intakeRuleUpdates: decision.intakeRuleUpdates } : {}),
      })
    })
    adopt({
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

    wi1.registerIntakeEvaluator(validEvaluator('Fix CI workflow'))
    wi1.recordIntake({
      source: 'lark-channel',
      sourceEventId: 'evt-ew01-1',
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
      acceptance,
    }, objectiveText)
    await vi.waitFor(() => expect(wi1.intakeEvaluations('lark-channel', 'evt-ew01-1')).toMatchObject([{ wouldAccept: true }]))
    await harness.disposeAll()

    // Restart with static config mode='observe'; persisted WP22 tuned mode='auto' must survive
    const ctx2 = harness.createContext()
    await mountWorkItemsPeers(ctx2, ws, policyDb, objectiveText, 'c-ew01', undefined, contractWindow)
    const wi2 = await harness.mountService<{
      intakeAdmissionMode: () => string
      runIntakeAdmission: () => readonly { outcome: string; mode: string; itemId: string | null }[]
    }>(ctx2, wiMod.AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, wiDb, 'observe', 'triage'))

    expect(wi2.intakeAdmissionMode()).toBe('auto')
    const admissions = wi2.runIntakeAdmission()
    expect(admissions[0]?.mode).toBe('auto')
    expect(admissions[0]?.outcome).toBe('admitted')
    expect(admissions[0]?.itemId).not.toBeNull()

    const db = new DatabaseSync(wiDb, { readOnly: true })
    try {
      const row = db.prepare('SELECT id, brief FROM work_item WHERE id = ?').get(admissions[0]!.itemId!) as { id: string; brief: string } | undefined
      expect(row?.brief).toBe(objectiveText)
    } finally {
      db.close()
    }
  }, 15_000)

  test('T3-EW-02 (F03+F05): Evaluation AttentionOverlay dynamically modulates Proactive utility & interruption cost', async () => {
    const ws = await workspaces.create('t3-ew02-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const evalMod = await loadAssistantEvaluation()
    const { AssistantProactiveService, OpportunityEngine, attentionOverlay, proactiveAttentionCohort } = await loadAssistantProactive()

    const enqueued: Array<Record<string, unknown>> = []
    const ctx = harness.createContext()
    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
    harness.provideMockService(ctx, 'assistantDelivery', {
      enqueueOwnerNotification: (notice: Record<string, unknown>) => {
        enqueued.push(notice)
        return { id: `out-${enqueued.length}` }
      },
    })
    const evaluation = new evalMod.AssistantEvaluationService(ctx, {
      databasePath: ws.sqlitePath('evaluation'),
      projectionIntervalMs: 0,
      notificationOutcomesEnabled: true,
      attentionTuningAutoAdopt: true,
      attentionLooseningEnabled: true,
    }) as unknown as {
      requestAttentionTuning: (input: Record<string, unknown>) => { status: string; version?: number }
      currentAttentionTuning: (input: Record<string, unknown>) => Record<string, unknown> | undefined
    }

    let idleRes: ReturnType<InstanceType<typeof OpportunityEngine>['evaluate']>
    const engine = new OpportunityEngine(ws.sqlitePath('proactive-eng'), [makeProactiveProfile({ minimumUtility: 55 })])
    try {
      idleRes = engine.evaluate(makeProactiveInput(ws.workspace, 1), undefined, { userActive: false, urgencyPpm: 700_000 })
      const busyRes = engine.evaluate(makeProactiveInput(ws.workspace, 2), undefined, { userActive: true, recentNotificationCount: 5, urgencyPpm: 700_000 })
      expect(busyRes.decision.utility).toBeLessThan(idleRes.decision.utility)
    } finally {
      engine.close()
    }

    const borderlineThreshold = idleRes.decision.utility - 5
    // Utility check with idle vs active runtimeContext + borderline threshold = idleUtility - 5
    const proactive = await harness.mountService<{
      evaluate: (input: unknown, runtimeContext?: unknown) => {
        disposition: string
        decision: { state: string; mode: string; utility: number; reason: string }
      }
    }>(ctx, AssistantProactiveService, 'assistantProactive', {
      databasePath: ws.sqlitePath('proactive-svc'),
      profiles: [makeProactiveProfile({ minimumUtility: borderlineThreshold })],
    })

    // Adopt single-step tightening delta (+10 interruptionCostDelta) in Evaluation
    const scope = { workspace: ws.workspace, preset: 'primary' }
    const tunedRes = evaluation.requestAttentionTuning({
      scope,
      cohort: proactiveAttentionCohort,
      parameters: { interruptionCostDelta: 10, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
    })
    expect(tunedRes.status).toBe('adopted')

    const liveTuning = evaluation.currentAttentionTuning({ scope, cohort: proactiveAttentionCohort })
    expect(liveTuning).toBeDefined()
    const liveOverlay = attentionOverlay(liveTuning)
    expect(liveOverlay?.parameters.interruptionCostDelta).toBe(10)

    // Tightened overlay reduces utility by 10 (below borderlineThreshold = idleUtility - 5)
    const tightenedEval = proactive.evaluate(makeProactiveInput(ws.workspace, 10), { userActive: false, urgencyPpm: 700_000 })
    expect(tightenedEval.decision.utility).toBe(idleRes.decision.utility - 10)
    expect(tightenedEval.decision.reason).toBe('below-threshold')
    expect(enqueued.length).toBe(0)

    // Evaluating directly on an untightened context (cleared overlay) restores 'decided' and enqueues reminder notice
    const ctx2 = harness.createContext()
    await harness.mountService(ctx2, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy-restored') })
    harness.provideMockService(ctx2, 'assistantDelivery', {
      enqueueOwnerNotification: (notice: Record<string, unknown>) => {
        enqueued.push(notice)
        return { id: `out-${enqueued.length}` }
      },
    })
    const restoredPro = await harness.mountService<{
      evaluate: (input: unknown, runtimeContext?: unknown) => {
        disposition: string
        decision: { state: string; mode: string; utility: number }
      }
    }>(ctx2, AssistantProactiveService, 'assistantProactive', {
      databasePath: ws.sqlitePath('proactive-restored'),
      profiles: [makeProactiveProfile({ minimumUtility: borderlineThreshold })],
    })
    const decidedEval = restoredPro.evaluate(makeProactiveInput(ws.workspace, 11), { userActive: false, urgencyPpm: 700_000 })
    expect(decidedEval.decision.state).toBe('decided')
    expect(decidedEval.decision.mode).toBe('remind')
    expect(enqueued.length).toBe(1)
    expect(enqueued[0]?.attention).toEqual({ purpose: 'result' })
  })

  test('T3-EW-03 (F02+F04): WP08 PolicyRule lease & sensitivity/cost-cap constraints gate WorkItems admission across restart', async () => {
    const ws = await workspaces.create('t3-ew03-')
    const wiMod = await loadAssistantWorkItems()
    const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
    const wiDb = ws.sqlitePath('work-items')
    const policyDb = ws.sqlitePath('policy')
    const now = Date.now()

    const leaseRules = [
      {
        id: 'r-auto',
        effect: 'allow',
        subject: { kind: 'background', id: 'work-items/v1', workspace: ws.workspace, principal: 'web/a/t/u' },
        actions: ['admit'],
        resource: { kind: 'automation', id: 'worker-1' },
        context: { initiators: ['background'] },
        lease: { leaseId: 'wi-lease-1', expiresAtMs: now + 60_000, maxUses: 1, revoked: false },
      },
    ]

    const obj1 = 'Deploy hotfix for auth token rotation'
    const obj2 = 'Deploy hotfix secondary follow-up rotation'
    const digest1 = sha256Hex(obj1)
    const digest2 = sha256Hex(obj2)
    const contractWindow = { issuedAt: now - 1_000, expiresAt: now + 3_600_000 }

    const ctx1 = harness.createContext()
    const extraAccs: Array<{ contractId: string; contractDigest: string }> = []
    const acc1 = await mountWorkItemsPeers(
      ctx1,
      ws,
      policyDb,
      obj1,
      'c-ew03-1',
      leaseRules,
      contractWindow,
      [{ contractId: 'c-ew03-2', objectiveText: obj2 }],
      extraAccs,
    )
    const acc2 = extraAccs[0]!
    expect(acc2).toBeDefined()
    expect(acc2.contractId).toBe('c-ew03-2')
    expect(acc2.contractId).not.toBe(acc1.contractId)
    const wi1 = await harness.mountService<{
      registerIntakeEvaluator: (reg: unknown) => () => void
      recordIntake: (input: unknown, sourceText?: string) => unknown
      intakeEvaluations: (source: string, sourceEventId: string) => readonly { wouldAccept: boolean }[]
      runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
    }>(ctx1, wiMod.AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, wiDb, 'auto', 'triage'))

    wi1.registerIntakeEvaluator(validEvaluator('Deploy hotfix'))
    wi1.recordIntake({
      source: 'lark-channel',
      sourceEventId: 'evt-ew03-1',
      kind: 'message',
      senderAllowlisted: true,
      addressed: false,
      threadFollowUp: false,
      senderIsBot: false,
      groupMessage: true,
      contentDigest: digest1,
      occurredAt: now,
      objective: obj1,
      objectiveDigest: digest1,
      acceptance: acc1,
    }, obj1)
    await vi.waitFor(() => expect(wi1.intakeEvaluations('lark-channel', 'evt-ew03-1')).toMatchObject([{ wouldAccept: true }]))
    const firstAdm = wi1.runIntakeAdmission()
    expect(firstAdm[0]?.outcome).toBe('admitted')
    expect(firstAdm[0]?.itemId).not.toBeNull()
    const firstItemId = firstAdm[0]!.itemId!

    // Stage event 2 with its own distinct acc2 ('c-ew03-2') before restart while lease is now exhausted (1/1 used in policyDb)
    wi1.recordIntake({
      source: 'lark-channel',
      sourceEventId: 'evt-ew03-2',
      kind: 'message',
      senderAllowlisted: true,
      addressed: false,
      threadFollowUp: false,
      senderIsBot: false,
      groupMessage: true,
      contentDigest: digest2,
      occurredAt: now + 10,
      objective: obj2,
      objectiveDigest: digest2,
      acceptance: acc2,
    }, obj2)
    await vi.waitFor(() => expect(wi1.intakeEvaluations('lark-channel', 'evt-ew03-2')).toMatchObject([{ wouldAccept: true }]))
    await harness.disposeAll()

    // Post-restart: same policyDb + wiDb -> WP08 lease maxUses=1 is exhausted -> fail closed on event 2 via policy denial ('source-rejected')
    const ctx2 = harness.createContext()
    await mountWorkItemsPeers(ctx2, ws, policyDb, obj2, 'c-ew03-2', leaseRules, contractWindow)
    const wi2 = await harness.mountService<{
      runIntakeAdmission: () => readonly { outcome: string; reasonCode?: string | null; itemId: string | null }[]
    }>(ctx2, wiMod.AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, wiDb, 'auto', 'triage'))

    const refusedAdm = wi2.runIntakeAdmission()
    expect(refusedAdm[0]?.outcome).toBe('refused')
    expect(refusedAdm[0]?.reasonCode).toBe('source-rejected')
    expect(refusedAdm[0]?.itemId).toBeNull()

    const db = new DatabaseSync(wiDb, { readOnly: true })
    try {
      const rows = db.prepare('SELECT id, brief FROM work_item').all() as { id: string; brief: string }[]
      expect(rows.length).toBe(1)
      expect(rows[0]?.id).toBe(firstItemId)
      expect(rows[0]?.brief).toBe(obj1)
    } finally {
      db.close()
    }

    // Verify WP08 sensitivity & monetary cost cap checks on the same admission subject/resource
    const compiled = compilePolicy([
      {
        id: 'r-wp08-caps',
        effect: 'allow',
        subject: { kind: 'background', id: 'work-items/v1', workspace: ws.workspace, principal: 'web/a/t/u' },
        actions: ['admit'],
        resource: { kind: 'automation', id: 'worker-1' },
        context: { initiators: ['background'] },
        maxSensitivity: 'confidential',
        monetaryCostCapMicros: 50_000,
      } as never,
    ])
    const evalFn = evaluatePolicy as (p: unknown, req: unknown) => { effect: string; reasonCode: string }
    const baseAdmitReq = {
      subject: { kind: 'background', id: 'work-items/v1', workspace: ws.workspace, principal: 'web/a/t/u' },
      action: 'admit',
      resource: { kind: 'automation', id: 'worker-1' },
      context: { initiator: 'background' },
    }
    expect(evalFn(compiled, { ...baseAdmitReq, sensitivity: 'confidential', estimatedCostMicros: 20_000 }).effect).toBe('allow')
    expect(evalFn(compiled, { ...baseAdmitReq, sensitivity: 'restricted', estimatedCostMicros: 20_000 }).reasonCode).toBe('sensitivity-exceeded')
    expect(evalFn(compiled, { ...baseAdmitReq, sensitivity: 'internal', estimatedCostMicros: 75_000 }).reasonCode).toBe('monetary-cost-exceeded')
  })

  test('T3-EW-04 (F02+F05): WP08 PolicyRule constraints gate Proactive execution/inspection despite high dynamic utility', async () => {
    const ws = await workspaces.create('t3-ew04-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantProactiveService, OpportunityEngine } = await loadAssistantProactive()

    const now = Date.now()
    const engine = new OpportunityEngine(ws.sqlitePath('pro-eng'), [makeProactiveProfile({ mode: 'execute', minimumUtility: 20 })])
    try {
      const highEval = engine.evaluate(makeProactiveInput(ws.workspace, 1), undefined, { urgencyPpm: 950_000, userActive: false })
      expect(highEval.decision.state).toBe('decided')
      expect(highEval.decision.mode).toBe('execute')
    } finally {
      engine.close()
    }

    // Mount live AssistantPolicyService with WP08 constraints gating BOTH AssistantProactiveService.availableProfiles/inspect
    // (via evaluateAgent/authorizeAgent lease maxUses=1) AND proactive execution authorization (destinations, maxSensitivity, monetaryCostCapMicros, lease).
    const ctx = harness.createContext()
    const agent = { id: 'agent-ew04', session: { id: 'sess-1', header: { id: 'sess-1', cwd: ws.workspace, agentPreset: 'primary' } } }
    harness.provideMockService(ctx, 'agents', { list: () => [agent], get: (id: string) => (id === agent.id ? agent : undefined) })
    harness.provideMockService(ctx, 'assistantDelivery', {
      preferencePrincipalForAgent: () => ({
        principalId: 'web/a/t/u',
        principalLineage: { principalRecordId: 'rec-1', principalVersion: 1 },
        scope: { workspace: ws.workspace, preset: 'primary' },
      }),
    })
    const policy = await harness.mountService<{
      evaluate: (req: Record<string, unknown>) => { effect: string; reasonCode: string }
      authorize: (req: Record<string, unknown>, opts?: { idempotencyKey?: string }) => { effect: string; reasonCode: string }
    }>(ctx, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy'),
      rules: [
        {
          id: 'pro-inspect-wp08-lease',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
          actions: ['inspect'],
          resource: { kind: 'goal', id: 'proactive-opportunities' },
          context: { initiators: ['foreground'] },
          lease: { leaseId: 'pro-inspect-lease', expiresAtMs: now + 60_000, maxUses: 1, revoked: false },
        },
        {
          id: 'pro-exec-wp08',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'web/a/t/u' },
          actions: ['execute'],
          resource: { kind: 'goal', id: 'proactive-opportunities' },
          context: { initiators: ['foreground'] },
          destinations: ['https://api.internal.test/hooks'],
          maxSensitivity: 'internal',
          monetaryCostCapMicros: 20_000,
          lease: { leaseId: 'pro-exec-lease', expiresAtMs: now + 60_000, maxUses: 1, revoked: false },
        },
      ] as never,
    })
    const proactive = await harness.mountService<{
      availableProfiles: (agent: unknown) => readonly { id: string; mode: string }[]
      inspect: (agent: unknown) => readonly unknown[]
      evaluate: (input: unknown, runtimeContext?: unknown) => {
        disposition: string
        decision: { id: string; state: string; mode: string; utility: number }
      }
    }>(ctx, AssistantProactiveService, 'assistantProactive', {
      databasePath: ws.sqlitePath('pro-svc'),
      profiles: [makeProactiveProfile({ mode: 'execute', minimumUtility: 20 })],
    })

    // High-utility proactive evaluation succeeds, and availableProfiles passes while pro-inspect-lease is unused
    const svcEval = proactive.evaluate(makeProactiveInput(ws.workspace, 2), { urgencyPpm: 950_000, userActive: false })
    expect(svcEval.decision.state).toBe('decided')
    expect(svcEval.decision.mode).toBe('execute')
    expect(proactive.availableProfiles(agent)).toMatchObject([{ id: 'prof-1', mode: 'execute' }])

    // Calling proactive.inspect consumes the single-use WP08 lease via assistantPolicy.authorizeAgent
    expect(proactive.inspect(agent).length).toBe(1)
    expect(() => proactive.availableProfiles(agent)).toThrow(/policy denied/u)
    expect(() => proactive.inspect(agent)).toThrow(/policy denied/u)

    // Route the proactive execution decision through mounted AssistantPolicyService WP08 constraints
    const execReqBase = {
      subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'web/a/t/u' },
      action: 'execute',
      resource: { kind: 'goal', id: 'proactive-opportunities' },
      context: { initiator: 'foreground' },
      lease: { leaseId: 'pro-exec-lease' },
    }
    expect(policy.evaluate({ ...execReqBase, destination: 'https://api.internal.test/hooks', sensitivity: 'restricted', estimatedCostMicros: 10_000 }).reasonCode).toBe('sensitivity-exceeded')
    expect(policy.evaluate({ ...execReqBase, destination: 'https://api.internal.test/hooks', sensitivity: 'internal', estimatedCostMicros: 35_000 }).reasonCode).toBe('monetary-cost-exceeded')
    expect(policy.evaluate({ ...execReqBase, destination: 'https://untrusted.example/exfil', sensitivity: 'internal', estimatedCostMicros: 10_000 }).reasonCode).toBe('destination-mismatch')
    expect(policy.authorize({
      ...execReqBase,
      destination: 'https://api.internal.test/hooks',
      sensitivity: 'internal',
      estimatedCostMicros: 10_000,
    }, { idempotencyKey: `pro-exec:${svcEval.decision.id}:1` }).effect).toBe('allow')
    expect(policy.authorize({
      ...execReqBase,
      destination: 'https://api.internal.test/hooks',
      sensitivity: 'internal',
      estimatedCostMicros: 10_000,
    }, { idempotencyKey: `pro-exec:${svcEval.decision.id}:2` })).toMatchObject({ effect: 'deny', reasonCode: 'lease-exhausted' })

    // Default-deny policy context also blocks AssistantProactiveService.availableProfiles
    const ctxDenied = harness.createContext()
    harness.provideMockService(ctxDenied, 'agents', { list: () => [agent], get: (id: string) => (id === agent.id ? agent : undefined) })
    harness.provideMockService(ctxDenied, 'assistantDelivery', {
      preferencePrincipalForAgent: () => ({
        principalId: 'web/a/t/u',
        principalLineage: { principalRecordId: 'rec-1', principalVersion: 1 },
        scope: { workspace: ws.workspace, preset: 'primary' },
      }),
    })
    await harness.mountService(ctxDenied, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy-denied'),
      rules: [],
    })
    const proactiveDenied = await harness.mountService<{
      availableProfiles: (agent: unknown) => readonly unknown[]
    }>(ctxDenied, AssistantProactiveService, 'assistantProactive', {
      databasePath: ws.sqlitePath('pro-svc-denied'),
      profiles: [makeProactiveProfile({ mode: 'execute', minimumUtility: 20 })],
    })
    expect(() => proactiveDenied.availableProfiles(agent)).toThrow(/policy denied/u)
  })

  test('T3-EW-05 (F03+F05+F07): R3 default-on WP22 tightening rollback reverts WorkItems auto -> observe & tightens Proactive overlay', async () => {
    const ws = await workspaces.create('t3-ew05-')
    const evalMod = await loadAssistantEvaluation()
    const wiMod = await loadAssistantWorkItems()
    const proMod = await loadAssistantProactive()

    const evalCfg = evalMod.Config({ databasePath: ws.sqlitePath('eval') })
    const proCfg = proMod.Config({})
    const wiCfg = wiMod.ConfigSchema({ databasePath: ws.sqlitePath('wi'), workRoot: ws.workspace })
    expect(evalCfg.notificationOutcomesEnabled).toBe(true)
    expect(evalCfg.attentionTuningAutoAdopt).toBe(true)
    expect(evalCfg.attentionLooseningEnabled).toBe(true)
    expect(proCfg.intakeEvaluation?.enabled).toBe(true)
    expect(wiCfg.intakeLedger?.enabled).toBe(true)
    expect(wiCfg.intakeLedger?.evaluation?.enabled).toBe(true)

    const objectiveText = 'Verify rollback reverts auto admission'
    const digest = sha256Hex(objectiveText)
    const ctx = harness.createContext()
    const acceptance = await mountWorkItemsPeers(ctx, ws, ws.sqlitePath('policy'), objectiveText, 'c-ew05')
    const evaluation = await harness.mountService(ctx, evalMod.AssistantEvaluationService, 'assistantEvaluation', {
      databasePath: ws.sqlitePath('eval'),
      projectionIntervalMs: 0,
      notificationOutcomesEnabled: true,
      attentionTuningAutoAdopt: true,
      attentionLooseningEnabled: true,
    })
    const workItems = await harness.mountService<{
      applyIntakeTuning: (u: Record<string, unknown>) => { mode: string }
      intakeAdmissionMode: () => string
      registerIntakeEvaluator: (reg: unknown) => () => void
      recordIntake: (input: unknown, sourceText?: string) => unknown
      intakeEvaluations: (source: string, sourceEventId: string) => readonly { wouldAccept: boolean }[]
      runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
    }>(ctx, wiMod.AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, ws.sqlitePath('wi'), 'auto', 'triage'))
    expect(workItems.intakeAdmissionMode()).toBe('auto')

    // Simultaneous rollback/tightening broadcast from Evaluation to WorkItems and Proactive
    const engine = new proMod.OpportunityEngine(ws.sqlitePath('pro-eng'), [makeProactiveProfile({ minimumUtility: 48 })])
    try {
      const baseEval = engine.evaluate(makeProactiveInput(ws.workspace, 1), undefined, { userActive: false, urgencyPpm: 700_000 })
      expect(baseEval.decision.state).toBe('decided')

      const subscribe = getMethod<(cb: (d: Record<string, unknown>) => void) => () => void>(evaluation, 'onAttentionLooseningAdopted')
      const emit = getMethod<(input: Record<string, unknown>) => unknown>(evaluation, 'emitLooseningToConsumers')
      let emittedDecision: Record<string, unknown> | undefined
      subscribe(d => {
        emittedDecision = d
        if (typeof d.workItemsMode === 'string') {
          workItems.applyIntakeTuning({ workItemsMode: d.workItemsMode })
        }
      })
      emit({ workItemsMode: 'observe', interruptionCostDelta: 30 })

      expect(emittedDecision).toBeDefined()
      const emittedDelta = Number(emittedDecision!.interruptionCostDelta)
      expect(emittedDelta).toBeGreaterThan(0)

      expect(workItems.intakeAdmissionMode()).toBe('observe')
      workItems.registerIntakeEvaluator(validEvaluator('Verify rollback'))
      workItems.recordIntake({
        source: 'lark-channel',
        sourceEventId: 'evt-ew05-1',
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
        acceptance,
      }, objectiveText)
      await vi.waitFor(() => expect(workItems.intakeEvaluations('lark-channel', 'evt-ew05-1')).toMatchObject([{ wouldAccept: true }]))
      const adm = workItems.runIntakeAdmission()
      expect(adm[0]?.outcome).toBe('would-admit')
      expect(adm[0]?.itemId).toBeNull()

      const tightenedOverlay = proMod.attentionOverlay({
        version: 1,
        digest: sha256Hex(JSON.stringify(emittedDecision)),
        parameters: { interruptionCostDelta: emittedDelta, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false },
      })
      const tightenedEngine = new proMod.OpportunityEngine(ws.sqlitePath('pro-eng-tightened'), [makeProactiveProfile({ minimumUtility: 48 })])
      try {
        const suppressedEval = tightenedEngine.evaluate(makeProactiveInput(ws.workspace, 2), tightenedOverlay, { userActive: false, urgencyPpm: 700_000 })
        expect(suppressedEval.decision.utility).toBe(baseEval.decision.utility - emittedDelta)
        expect(suppressedEval.decision.reason).toBe('below-threshold')
      } finally {
        tightenedEngine.close()
      }
    } finally {
      engine.close()
    }
  })

  test('T3-EW-06 (F06+F15): families-v1 benchmark planning & growth ablations feed GoalStrategyRuntime routing & optimizer', async () => {
    const ws = await workspaces.create('t3-ew06-')
    const native = await loadNativeBenchmark()
    const corpus = await loadFamiliesCorpus()
    const runnerMod = await loadBenchmarkRunner()
    const { BenchmarkStore } = await loadBenchmarkStore()
    const { benchmarkReport } = await loadBenchmarkIndex()
    const routerMod = await loadAssistantGoalsStrategyRouter()
    const goalsMod = await loadAssistantGoals()

    const caseId = corpus.familiesDevelopmentCases()[0]!.id
    const planConfig = {
      id: 'plan-ew06-1',
      suite: 'families-v1' as const,
      cases: [caseId],
      variants: [
        { id: 'base', role: 'baseline' as const, persona: 'p', memory: false, review: false, planning: false, growth: false },
        { id: 'cand', role: 'candidate' as const, persona: 'p', memory: false, review: true, planning: true, growth: true },
        { id: 'abl-no-planning', role: 'ablation' as const, persona: 'p', memory: false, review: true, planning: false, growth: true },
        { id: 'abl-no-growth', role: 'ablation' as const, persona: 'p', memory: false, review: true, planning: true, growth: false },
      ],
      model: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        temperature: 0,
        maxOutputTokens: 256,
        inputUsdMicrosPerMillionTokens: 1000,
        outputUsdMicrosPerMillionTokens: 2000,
        adapterDigest: sha256Hex('adapter'),
        tokenCounterDigest: sha256Hex('counter'),
      },
      budget: { durationMs: 10_000, inputTokens: 100_000, outputTokens: 1_000, costUsdMicros: null, toolCalls: 4 },
      repeats: 2,
      seed: 11,
    }
    const plan = native.nativeBenchmarkPlan(planConfig)
    const store = new (BenchmarkStore as new (path: string) => { close?: () => void })(ws.sqlitePath('bench'))
    let results: ReadonlyArray<{
      cell: { id: string; caseId: string; variantId: string; repeat: number; seed: number }
      status: string
      verdict: 'achieved' | 'not-achieved' | 'unknown'
      metrics: { toolCalls: number | null; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null }
      completedAt: number
    }>
    let report: {
      complete: boolean
      variants: readonly {
        id: string
        achieved: number
        notAchieved: number
        unknown: number
        successRate: number
        metrics: {
          toolCalls: { mean: number | null; max: number | null }
          latencyMs: { mean: number | null }
        }
      }[]
      comparisons: readonly { variantId: string; baselineId: string; wins: number; losses: number; ties: number }[]
    }
    try {
      const executor = native.createNativeBenchmarkExecutor(planConfig, async () => ({
        adapter: new DeterministicNativeAdapter(),
        inputTokenUpperBound: () => 500,
        dispose: () => {},
      }))
      results = (await runnerMod.runBenchmark(store as never, plan, executor)) as typeof results
      report = benchmarkReport(plan, results as never) as typeof report
      expect(report.complete).toBe(true)
      expect(report.comparisons.some(c => c.variantId === 'abl-no-planning')).toBe(true)
      expect(report.comparisons.some(c => c.variantId === 'abl-no-growth')).toBe(true)
    } finally {
      store.close?.()
    }

    const baseSummary = report.variants.find(v => v.id === 'base')!
    const candSummary = report.variants.find(v => v.id === 'cand')!
    const noPlanningSummary = report.variants.find(v => v.id === 'abl-no-planning')!
    const noGrowthSummary = report.variants.find(v => v.id === 'abl-no-growth')!
    const candCells = results.filter(r => r.cell.variantId === 'cand')
    expect(candCells.length).toBe(planConfig.repeats)
    const observedLatencyMs = Math.max(1, Math.round(candSummary.metrics.latencyMs.mean ?? 100))
    const observedToolCalls = Math.round(candSummary.metrics.toolCalls.mean ?? 0)
    const firstCandCell = candCells[0]!

    const recommend = getExportFn<(input: Record<string, unknown>) => {
      failureType: string
      selectedStrategy: string
      expectedNetBenefit: number
    }>(routerMod, 'recommendGoalStrategy')
    const optimize = getExportFn<(input: Record<string, unknown>) => {
      selectedStrategy: string
      expectedNetBenefit: number
    }>(routerMod, 'optimizeStrategyDecision')

    const moderateRecord = {
      id: 'goal-ew06',
      scope: { principalId: 'owner', principalRecordId: 'owner-rec', principalVersion: 1, workspace: ws.workspace, preset: 'primary' },
      originalObjective: `Solve families-v1 case ${caseId}`,
      definition: { version: 1, digest: sha256Hex(caseId), objective: `Solve families-v1 case ${caseId}` },
      native: { sessionId: 'sess-1', goalId: 'ng-1', revision: 1, objective: `Solve ${caseId}`, phase: 'active', roundsStarted: 1, maxGoalRounds: 4, updatedAt: firstCandCell.completedAt },
      checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: ['dep-1'] },
      version: 1,
      createdAt: 1_000,
      updatedAt: firstCandCell.completedAt,
    }
    const budget = {
      limits: {
        mode: 'calls',
        routes: [{ provider: planConfig.model.provider, model: planConfig.model.model }],
        modelCalls: 10,
        toolCalls: Math.max(planConfig.budget.toolCalls, observedToolCalls + 4),
        inputTokens: null,
        outputTokens: null,
        costUsdMicros: null,
        expiresAt: Date.now() + 60_000,
      },
      modelCalls: 1,
      toolCalls: observedToolCalls,
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
      heldCalls: 0,
    }
    const toolRoute = recommend({
      record: moderateRecord,
      budget,
      availableTools: ['read', 'glob', 'grep', 'code_run_tests'],
      recentToolOutcomes: [{ name: 'code_run_tests', isError: true }],
      now: firstCandCell.completedAt + 1_000,
    })
    expect(toolRoute.failureType).toBe('tool-failure')
    expect(toolRoute.selectedStrategy).toBe('experiment')

    // Feed real benchmark cell outcome & ablation telemetry directly into recommendGoalStrategy and optimizeStrategyDecision
    const reasonRoute = recommend({
      record: moderateRecord,
      budget,
      availableTools: ['read', 'glob', 'grep', 'code_run_tests'],
      feedback: {
        protocol: 'assistant-goals/feedback/v1',
        goalId: 'goal-ew06',
        goalOutcome: firstCandCell.verdict === 'achieved' ? 'verified' : 'unverified',
        definition: { version: 1, digest: sha256Hex(caseId), objective: { excerpt: `Solve ${caseId}`, truncated: false } },
        verification: {
          current: {
            runId: firstCandCell.cell.id,
            definitionVersion: 1,
            status: firstCandCell.verdict === 'achieved' ? 'achieved' : 'not-achieved',
            execution: { status: 'succeeded', quiescent: true, completedAt: firstCandCell.completedAt, executionRef: firstCandCell.cell.id },
            criteria: [{
              id: 'c1',
              status: firstCandCell.verdict === 'achieved' ? 'passed' : 'failed',
              reason: `ablation-planning:${noPlanningSummary.successRate}-growth:${noGrowthSummary.successRate}`,
              reasonTruncated: false,
              evidence: [],
              definition: { kind: 'document-citations' },
              evidenceTruncated: false,
            }],
            criteriaTruncated: false,
          },
          pending: null,
          history: [],
        },
        nextAction: 'revise-plan',
      },
      now: firstCandCell.completedAt + 1_000,
    })
    expect(reasonRoute.failureType).toBe('reasoning-failure')
    expect(['review', 'compare']).toContain(reasonRoute.selectedStrategy)

    const zeroStat = { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 }
    const statFromVariant = (v: typeof candSummary, avgModelCalls: number) => ({
      total: Math.max(2, v.achieved + v.notAchieved),
      succeeded: v.achieved,
      failedOrUnknown: v.notAchieved + v.unknown,
      avgDurationMs: observedLatencyMs,
      avgModelCalls,
      avgToolCalls: observedToolCalls,
    })
    const ablationDrivenOpt = optimize({
      difficulty: 'moderate',
      difficultyScore: 2,
      difficultySignals: [`case:${caseId}`, `cand-success:${candSummary.successRate}`],
      failureType: reasonRoute.failureType,
      failureSignals: ['step:not-achieved'],
      budget,
      telemetry: {
        totalRuns: baseSummary.achieved + baseSummary.notAchieved + candSummary.achieved + candSummary.notAchieved + noPlanningSummary.achieved + noPlanningSummary.notAchieved + noGrowthSummary.achieved + noGrowthSummary.notAchieved,
        adviceRuns: 0,
        experimentRuns: candSummary.achieved + candSummary.notAchieved,
        directRecommendedRuns: 0,
        failedOrUnknownRuns: baseSummary.notAchieved + candSummary.notAchieved + noPlanningSummary.notAchieved + noGrowthSummary.notAchieved,
        byKind: {
          direct: zeroStat,
          investigate: statFromVariant(baseSummary, 1),
          review: statFromVariant(noPlanningSummary, 1),
          compare: statFromVariant(noGrowthSummary, 2),
          experiment: statFromVariant(candSummary, 2),
          subagent: zeroStat,
        },
      },
      experiment: { enabled: true, allowedTools: ['read', 'code_run_tests'], maxToolCalls: 4, maxModelCalls: 2, workspaceWriteAllowed: false },
      subagent: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
      availableTools: ['read', 'code_run_tests'],
      costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
      maxStrategyDurationMs: 30_000,
      now: firstCandCell.completedAt + 1_000,
    })
    expect(['direct', 'investigate', 'review', 'compare', 'experiment']).toContain(ablationDrivenOpt.selectedStrategy)
    if (noPlanningSummary.notAchieved + noPlanningSummary.unknown >= 2 && candSummary.notAchieved + candSummary.unknown >= 2) {
      expect(ablationDrivenOpt.selectedStrategy).toBe('direct')
    }
    expect(goalsMod.validateGoalStrategyConfig({ maxDurationMs: 5_000, maxRunsPerGoal: 4 }).maxRunsPerGoal).toBe(4)
  })

  test('T3-EW-07 (F06+F04): WP04 sealed holdout isolation guard prevents holdout-tainted intake from entering WorkItems/candidates', async () => {
    const ws = await workspaces.create('t3-ew07-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const wiMod = await loadAssistantWorkItems()
    const assoc = await loadAssistantAssociation()
    const benchIdx = await loadBenchmarkIndex()
    const native = await loadNativeBenchmark()
    const corpus = await loadFamiliesCorpus()

    const ctx = harness.createContext()
    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy'),
      rules: [
        {
          id: 'allow-intake-signal',
          effect: 'allow',
          subject: { kind: 'background', id: 'assistant-association', workspace: ws.workspace, principal: 'owner-ew07' },
          actions: ['intake-observe'],
          resource: { kind: 'automation', id: 'assistant-association:intake-signal' },
          context: { initiators: ['background'] },
        },
      ],
    })
    const recordedByWorkItems: Array<Record<string, unknown>> = []
    const wi = await harness.mountService<{
      recordIntake: (input: Record<string, unknown>, sourceText?: string) => { record: { decision: string }; replayed: boolean }
      intakeLedger: () => readonly unknown[]
    }>(ctx, wiMod.AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, ws.sqlitePath('wi'), 'observe', 'triage'))
    const origRecord = wi.recordIntake.bind(wi)
    wi.recordIntake = (input: Record<string, unknown>, sourceText?: string) => {
      recordedByWorkItems.push(input)
      return origRecord(input, sourceText)
    }

    const assocSvc = await harness.mountService<{
      emitIntakeSignalNow: (input: Record<string, unknown>) => { emitted: boolean; outcome: string }
      listIntakeSignals: (ownerScopeKey: string) => readonly unknown[]
    }>(ctx, assoc.AssistantAssociationService, 'assistantAssociation', {
      databasePath: ws.sqlitePath('assoc'),
      enabled: true,
      allowHeadlessScope: true,
      intakeSignal: { enabled: true, minScore: 0.5 },
    })

    const principalDigest = assoc.computePrincipalDigest('owner-ew07')
    const ownerScopeKey = assoc.computeOwnerScopeKey({
      mode: 'headless',
      principalDigest,
      principalRecordId: null,
      principalVersion: null,
      workspace: ws.workspace,
      agentPreset: 'primary',
    })
    const scope = {
      mode: 'headless' as const,
      ownerScopeKey,
      principalId: 'owner-ew07',
      principalDigest,
      principalRecordId: null,
      principalVersion: null,
      workspace: ws.workspace,
      agentPreset: 'primary',
    }
    const goalNode = { id: 'g:ew07', kind: 'goal', title: 'Investigate test failure', ownerScopeKey, sensitivity: 'private', status: 'active' }
    const targetNode = { id: 'm:ew07', kind: 'memory', title: 'Test failure hint', ownerScopeKey, sensitivity: 'private', status: 'active' }

    // Holdout signal is blocked before touching WorkItems.recordIntake
    const blocked = assocSvc.emitIntakeSignalNow({
      scope,
      goalNode,
      targetNode,
      score: 0.95,
      reason: 'holdout-check',
      inHoldout: true,
      nowMs: 1_700_000_000_000,
    })
    expect(blocked.emitted).toBe(false)
    expect(blocked.outcome).toBe('holdout-blocked')
    expect(recordedByWorkItems.length).toBe(0)

    // Non-holdout signal flows cleanly into WorkItems.recordIntake
    const allowed = assocSvc.emitIntakeSignalNow({
      scope,
      goalNode,
      targetNode,
      score: 0.95,
      reason: 'dev-check',
      inHoldout: false,
      nowMs: 1_700_000_001_000,
    })
    expect(allowed.emitted).toBe(true)
    expect(recordedByWorkItems.length).toBe(1)
    expect(assocSvc.listIntakeSignals(ownerScopeKey).length).toBe(1)

    // WP04 BenchmarkPlan guard rejects holdout dataset plans and accepts development dataset plans
    const devCaseId = corpus.familiesDevelopmentCases()[0]!.id
    const devPlan = native.nativeBenchmarkPlan({
      id: 'plan-dev-ew07',
      suite: 'families-v1',
      cases: [devCaseId],
      variants: [
        { id: 'base', role: 'baseline', persona: 'p', memory: false, review: false },
        { id: 'cand', role: 'candidate', persona: 'p', memory: false, review: true },
      ],
      model: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        temperature: 0,
        maxOutputTokens: 256,
        inputUsdMicrosPerMillionTokens: 1000,
        outputUsdMicrosPerMillionTokens: 2000,
        adapterDigest: sha256Hex('a'),
        tokenCounterDigest: sha256Hex('t'),
      },
      budget: { durationMs: 10_000, inputTokens: 100_000, outputTokens: 1_000, costUsdMicros: null, toolCalls: 0 },
      repeats: 2,
      seed: 1,
    })
    expect(() => benchIdx.assertCandidateGenerationInput(devPlan)).not.toThrow()
    const holdoutPlan = { ...devPlan, dataset: { ...devPlan.dataset, split: 'holdout' } }
    expect(() => benchIdx.assertCandidateGenerationInput(holdoutPlan as never)).toThrow(/holdout/u)
  })

  test('T3-EW-08 (F07+F03+F05): plugin-setup recommended preset materializes cordis.patch.yml that boots live R3 Eval + WorkItems + Proactive + Delivery stack', async () => {
    const ws = await workspaces.create('t3-ew08-')
    const profileDir = join(ws.dshHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')

    const setup = await loadPluginSetup()
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantDeliveryService } = await loadAssistantDelivery()
    const { AssistantEvaluationService } = await loadAssistantEvaluation()
    const { AssistantWorkItemsService } = await loadAssistantWorkItems()
    const { AssistantProactiveService } = await loadAssistantProactive()

    const bundlesYaml = [
      '- id: dsh-enhanced-assistant-work-items',
      '  name: "@dsh-enhanced/assistant-work-items"',
      '  config:',
      '    enabled: false',
      '    mode: observe',
      `    databasePath: ${ws.sqlitePath('wi')}`,
      `    workRoot: ${ws.workspace}`,
      '- id: dsh-enhanced-assistant-evaluation',
      '  name: "@dsh-enhanced/assistant-evaluation"',
      '  config:',
      `    databasePath: ${ws.sqlitePath('eval')}`,
      '    projectionIntervalMs: 0',
      '    notificationOutcomesEnabled: false',
      '    attentionTuningAutoAdopt: false',
      '    attentionLooseningEnabled: false',
      '- id: dsh-enhanced-assistant-proactive',
      '  name: "@dsh-enhanced/assistant-proactive"',
      '  config:',
      `    databasePath: ${ws.sqlitePath('pro')}`,
      '    intakeEvaluation:',
      '      enabled: false',
      '      provider: deepseek',
      '      model: deepseek-chat',
      '- id: dsh-enhanced-assistant-delivery',
      '  name: "@dsh-enhanced/assistant-delivery"',
      '  config:',
      `    databasePath: ${ws.sqlitePath('del')}`,
      `    spoolPath: ${join(ws.stateDir, 'spool')}`,
      '    schedulerEnabled: false',
      `    defaultWorkspace: ${ws.workspace}`,
      '    defaultAgentPreset: standard',
      '    attentionAttachOverCap: false',
    ].join('\n')

    const readDump = createPresetFixtureDump(bundlesYaml)
    const applyPreset = getExportFn<(target: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{ changed: boolean }>>(
      setup,
      'applyRecommendedPluginPreset',
    )
    const res = await applyPreset({ dshHome: ws.dshHome, profile: 'web' }, { readDump })
    expect(res.changed).toBe(true)

    const patchDoc = parseCordisPatch(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'))
    const wiPatchCfg = getPatchConfig(findPatchRow(patchDoc.document, 'dsh-enhanced-assistant-work-items'))
    const evalPatchCfg = getPatchConfig(findPatchRow(patchDoc.document, 'dsh-enhanced-assistant-evaluation'))
    const proPatchCfg = getPatchConfig(findPatchRow(patchDoc.document, 'dsh-enhanced-assistant-proactive'))
    const delPatchCfg = getPatchConfig(findPatchRow(patchDoc.document, 'dsh-enhanced-assistant-delivery'))

    expect(wiPatchCfg.enabled).toBe(true)
    expect(evalPatchCfg.notificationOutcomesEnabled).toBe(true)
    expect(evalPatchCfg.attentionTuningAutoAdopt).toBe(true)
    expect(evalPatchCfg.attentionLooseningEnabled).toBe(true)

    const ctx = harness.createContext()
    harness.provideMockService(ctx, 'llm', {
      chat: async () => ({ content: '{}' }),
      stream: async function* () {},
    })
    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
    await harness.mountService(ctx, AssistantDeliveryService, 'assistantDelivery', {
      ...delPatchCfg,
      databasePath: ws.sqlitePath('del'),
      spoolPath: join(ws.stateDir, 'spool'),
      schedulerEnabled: false,
      defaultWorkspace: ws.workspace,
      defaultAgentPreset: 'standard',
    })
    await harness.mountService(ctx, AssistantEvaluationService, 'assistantEvaluation', {
      ...evalPatchCfg,
      databasePath: ws.sqlitePath('eval'),
      projectionIntervalMs: 0,
    })
    await harness.mountService(ctx, AssistantWorkItemsService, 'assistantWorkItems', {
      ...wiPatchCfg,
      databasePath: ws.sqlitePath('wi'),
      workRoot: ws.workspace,
      intakeLedger: {
        enabled: true,
        evaluation: { enabled: true },
      },
    })
    const proactive = await harness.mountService<{
      intakeEvaluationHealth: () => { enabled: boolean; registered: boolean }
    }>(ctx, AssistantProactiveService, 'assistantProactive', {
      ...proPatchCfg,
      databasePath: ws.sqlitePath('pro'),
      intakeEvaluation: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' },
    })

    expect(ctx.get('inProcessReload' as never)).toBeDefined()
    expect(proactive.intakeEvaluationHealth().enabled).toBe(true)
    expect(proactive.intakeEvaluationHealth().registered).toBe(true)
  })

  test('T3-EW-09 (F04+F05): Cross-restart deduplication & intake evaluation across AssistantProactiveService (Proactive SQLite) and WorkItems SQLite', async () => {
    const ws = await workspaces.create('t3-ew09-')
    const { AssistantProactiveService } = await loadAssistantProactive()
    const { AssistantWorkItemsService } = await loadAssistantWorkItems()
    const proDb = ws.sqlitePath('proactive')
    const wiDb = ws.sqlitePath('work-items')
    const policyDb = ws.sqlitePath('policy')

    const objectiveText = 'Remediate flaky nightly build'
    const digest = sha256Hex(objectiveText)
    const now = Date.now()
    const contractWindow = { issuedAt: now - 1_000, expiresAt: now + 3_600_000 }
    const proInput = makeProactiveInput(ws.workspace, 1)

    let llmCalls = 0
    const mockLlm = {
      stream: async function* () {
        llmCalls += 1
        const payload = JSON.stringify({ ruleId: 'r-auto', level: 'accept', quotes: ['Remediate flaky'] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: payload }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }

    const ctx1 = harness.createContext()
    harness.provideMockService(ctx1, 'llm', mockLlm)
    const acceptance = await mountWorkItemsPeers(ctx1, ws, policyDb, objectiveText, 'c-ew09', undefined, contractWindow)
    const wi1 = await harness.mountService<{
      recordIntake: (input: unknown, sourceText?: string) => unknown
      intakeEvaluations: (source: string, sourceEventId: string) => readonly { wouldAccept: boolean; ruleId: string }[]
      runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
    }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, wiDb, 'auto', 'triage'))
    const proactive1 = await harness.mountService<{
      intakeEvaluationHealth: () => { enabled: boolean; registered: boolean; policyVersion: string | null }
      routeIntakeObservation: (input: Record<string, unknown>, options?: Record<string, unknown>) => {
        disposition: string
        requiresModelEvaluation: boolean
        workItemInput: Record<string, unknown>
      }
      evaluate: (input: unknown, runtimeContext?: unknown) => { disposition: string; decision: { id: string; state: string } }
      inspectOpportunities: (filter?: Record<string, unknown>) => readonly unknown[]
    }>(ctx1, AssistantProactiveService, 'assistantProactive', {
      databasePath: proDb,
      profiles: [makeProactiveProfile({ mode: 'execute', minimumUtility: 20 })],
      intakeEvaluation: {
        enabled: true,
        rules: [{ ruleId: 'r-auto', ceiling: 'accept' }],
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    })

    // AssistantProactiveService automatically registered itself as AssistantWorkItemsService's intake evaluator
    expect(proactive1.intakeEvaluationHealth().enabled).toBe(true)
    expect(proactive1.intakeEvaluationHealth().registered).toBe(true)

    const eval1 = proactive1.evaluate(proInput, { urgencyPpm: 900_000, userActive: false })
    expect(eval1.disposition).toBe('execute')
    expect(eval1.decision.state).toBe('decided')

    const routePlan = proactive1.routeIntakeObservation({
      source: 'lark-channel',
      sourceEventId: 'evt-ew09-1',
      kind: 'message',
      allowlistedSender: true,
      explicitlyAddressed: false,
      threadFollowUp: false,
      senderIsBot: false,
      groupMessage: true,
      observationDigest: digest,
      occurredAt: now,
      text: objectiveText,
    }, { sourcePolicy: { unaddressedGroupMessages: true, unsubscribedEvents: false } })
    expect(routePlan.disposition).toBe('evaluate-inferred')
    expect(routePlan.requiresModelEvaluation).toBe(true)

    const intakePayload = {
      ...routePlan.workItemInput,
      objective: objectiveText,
      objectiveDigest: digest,
      acceptance,
    }
    wi1.recordIntake(intakePayload, objectiveText)
    await vi.waitFor(() => expect(wi1.intakeEvaluations('lark-channel', 'evt-ew09-1')).toMatchObject([{ wouldAccept: true, ruleId: 'r-auto' }]))
    expect(llmCalls).toBe(1)
    const adm1 = wi1.runIntakeAdmission()
    expect(adm1[0]?.outcome).toBe('admitted')
    const admittedItemId = adm1[0]!.itemId!
    await harness.disposeAll()

    // Restart BOTH AssistantProactiveService and AssistantWorkItemsService on the exact same SQLite stores and replay
    const ctx2 = harness.createContext()
    harness.provideMockService(ctx2, 'llm', mockLlm)
    await mountWorkItemsPeers(ctx2, ws, policyDb, objectiveText, 'c-ew09', undefined, contractWindow)
    const wi2 = await harness.mountService<{
      recordIntake: (input: unknown, sourceText?: string) => { replayed: boolean; record: { decision: string } }
      intakeAdmissions: (src: string, id: string) => readonly { itemId: string | null }[]
    }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, wiDb, 'auto', 'triage'))
    const proactive2 = await harness.mountService<{
      intakeEvaluationHealth: () => { enabled: boolean; registered: boolean }
      evaluate: (input: unknown, runtimeContext?: unknown) => { disposition: string; decision: { id: string; state: string } }
      inspectOpportunities: (filter?: Record<string, unknown>) => readonly unknown[]
    }>(ctx2, AssistantProactiveService, 'assistantProactive', {
      databasePath: proDb,
      profiles: [makeProactiveProfile({ mode: 'execute', minimumUtility: 20 })],
      intakeEvaluation: {
        enabled: true,
        rules: [{ ruleId: 'r-auto', ceiling: 'accept' }],
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    })

    expect(proactive2.intakeEvaluationHealth().registered).toBe(true)
    const eval2 = proactive2.evaluate(proInput, { urgencyPpm: 900_000, userActive: false })
    expect(eval2.decision.id).toBe(eval1.decision.id)
    expect(proactive2.inspectOpportunities({}).length).toBe(1)

    const replayed = wi2.recordIntake(intakePayload, objectiveText)
    expect(replayed.replayed).toBe(true)
    expect(replayed.record.decision).toBe('stored')
    expect(wi2.intakeAdmissions('lark-channel', 'evt-ew09-1')[0]?.itemId).toBe(admittedItemId)
    expect(llmCalls).toBe(1)

    const db = new DatabaseSync(wiDb, { readOnly: true })
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM work_item').get() as { n: number }
      expect(count.n).toBe(1)
    } finally {
      db.close()
    }
  })

  test('T3-EW-10 (F02+F06+F15): WP08 monetaryCostCapMicros & GoalStrategyRuntime cost-benefit optimizer bound families-v1 strategy execution', async () => {
    const ws = await workspaces.create('t3-ew10-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const routerMod = await loadAssistantGoalsStrategyRouter()
    const corpus = await loadFamiliesCorpus()

    const scenario = corpus.familiesDevelopmentCases()[0]!
    const optimize = getExportFn<(input: Record<string, unknown>) => {
      selectedStrategy: string
      estimatedCostCalls: number
      expectedNetBenefit: number
    }>(routerMod, 'optimizeStrategyDecision')

    const budget = {
      limits: { mode: 'calls', routes: [{ provider: 'p', model: 'm' }], modelCalls: 12, toolCalls: 10, inputTokens: null, outputTokens: null, costUsdMicros: null, expiresAt: Date.now() + 60_000 },
      modelCalls: 1,
      toolCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
      heldCalls: 0,
    }
    const zeroStat = { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 }

    // Positive telemetry chooses experiment for tool-failure, and WP08 policy allows within monetaryCostCapMicros
    const positiveOpt = optimize({
      difficulty: 'moderate',
      difficultyScore: 2,
      difficultySignals: [`case:${scenario.id}`],
      failureType: 'tool-failure',
      failureSignals: ['tool:code_run_tests:error'],
      budget,
      experiment: { enabled: true, allowedTools: ['read', 'code_run_tests'], maxToolCalls: 4, maxModelCalls: 2, workspaceWriteAllowed: false },
      subagent: { enabled: true, allowedTools: ['read'], maxToolCalls: 4, maxModelCalls: 3, workspaceWriteAllowed: false },
      availableTools: ['read', 'code_run_tests'],
      costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
      maxStrategyDurationMs: 30_000,
      now: 5_000,
    })
    expect(positiveOpt.selectedStrategy).toBe('experiment')
    expect(positiveOpt.expectedNetBenefit).toBeGreaterThanOrEqual(0.25)
    expect(positiveOpt.estimatedCostCalls).toBeGreaterThan(0)

    // Negative telemetry suppresses branch back to 'direct'
    const negativeOpt = optimize({
      difficulty: 'moderate',
      difficultyScore: 2,
      difficultySignals: [`case:${scenario.id}`],
      failureType: 'tool-failure',
      failureSignals: ['tool:code_run_tests:error'],
      budget,
      telemetry: {
        totalRuns: 6,
        adviceRuns: 0,
        experimentRuns: 6,
        directRecommendedRuns: 0,
        failedOrUnknownRuns: 6,
        byKind: {
          direct: zeroStat,
          investigate: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 1, avgToolCalls: 0 },
          review: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 1, avgToolCalls: 0 },
          compare: { total: 3, succeeded: 0, failedOrUnknown: 3, avgDurationMs: 1_000, avgModelCalls: 2, avgToolCalls: 0 },
          experiment: { total: 6, succeeded: 0, failedOrUnknown: 6, avgDurationMs: 1_000, avgModelCalls: 2, avgToolCalls: 2 },
          subagent: zeroStat,
        },
      },
      experiment: { enabled: true, allowedTools: ['read', 'code_run_tests'], maxToolCalls: 4, maxModelCalls: 2, workspaceWriteAllowed: false },
      subagent: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
      availableTools: ['read', 'code_run_tests'],
      costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
      maxStrategyDurationMs: 30_000,
      now: 5_000,
    })
    expect(negativeOpt.selectedStrategy).toBe('direct')

    // Feed optimizeStrategyDecision's selectedStrategy and estimatedCostCalls directly into mounted AssistantPolicyService (WP08 cost cap + lease)
    const now = Date.now()
    const ctx = harness.createContext()
    const policy = await harness.mountService<{
      evaluate: (req: Record<string, unknown>) => { effect: string; reasonCode: string }
      authorize: (req: Record<string, unknown>, opts?: { idempotencyKey?: string }) => { effect: string; reasonCode: string }
    }>(ctx, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy'),
      rules: [
        {
          id: 'strategy-cap',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'web/a/t/u' },
          actions: ['execute'],
          resource: { kind: 'goal', id: `strategy:${scenario.id}:${positiveOpt.selectedStrategy}` },
          context: { initiators: ['foreground'] },
          monetaryCostCapMicros: 15_000,
          lease: { leaseId: 'strat-lease', expiresAtMs: now + 60_000, maxUses: 1, revoked: false },
        },
      ] as never,
    })
    const strategyReq = {
      subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'web/a/t/u' },
      action: 'execute',
      resource: { kind: 'goal', id: `strategy:${scenario.id}:${positiveOpt.selectedStrategy}` },
      context: { initiator: 'foreground' },
      lease: { leaseId: 'strat-lease' },
    }
    const withinCapMicros = Math.round(positiveOpt.estimatedCostCalls * 5_000)
    const overCapMicros = Math.round(positiveOpt.estimatedCostCalls * 10_000)
    expect(withinCapMicros).toBeLessThanOrEqual(15_000)
    expect(overCapMicros).toBeGreaterThan(15_000)

    expect(policy.evaluate({ ...strategyReq, estimatedCostMicros: overCapMicros }).reasonCode).toBe('monetary-cost-exceeded')
    expect(policy.authorize({ ...strategyReq, estimatedCostMicros: withinCapMicros }, { idempotencyKey: 'strat-opt-1' }).effect).toBe('allow')
    expect(policy.authorize({ ...strategyReq, estimatedCostMicros: withinCapMicros }, { idempotencyKey: 'strat-opt-2' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'lease-exhausted',
    })
  })
})
