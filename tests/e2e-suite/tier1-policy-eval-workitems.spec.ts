import { mkdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { getExportFn, getMethod, sha256Hex } from './helpers/assertions.ts'
import { runPluginSetupInProcess } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantEvaluation,
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

function basePolicyRequest(overrides: Record<string, unknown> = {}) {
  return {
    subject: { kind: 'agent', id: 'worker-1', workspace: '/work/proj', principal: 'web/a/t/u' },
    action: 'execute',
    resource: { kind: 'network', id: 'api.github.com' },
    context: { initiator: 'background' },
    ...overrides,
  }
}

function baseRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    effect: 'allow',
    subject: { kind: 'agent', id: 'worker-1' },
    actions: ['execute'],
    resource: { kind: 'network', id: '*' },
    context: { initiators: ['background'] },
    ...overrides,
  }
}

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
  policyDbName: string,
  objectiveText: string,
  contractId: string,
  contractWindow: { issuedAt: number; expiresAt: number } = (() => {
    const issuedAt = Date.now() - 1_000
    return { issuedAt, expiresAt: issuedAt + 3_600_000 }
  })(),
) {
  const { AssistantPolicyService } = await loadAssistantPolicy()
  const { createTaskAcceptanceContract } = await loadTaskAcceptanceContract()

  await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
    databasePath: ws.sqlitePath(policyDbName),
    rules: [
      {
        id: 'r-auto',
        effect: 'allow',
        subject: { kind: 'background', id: 'work-items/v1', workspace: ws.workspace, principal: 'web/a/t/u' },
        actions: ['admit'],
        resource: { kind: 'automation', id: 'worker-1' },
        context: { initiators: ['background'] },
      },
    ],
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
  const contract = createContract({
    protocol: 'task-acceptance/v1',
    id: contractId,
    scope: { workspace: ws.workspace, preset: 'primary' },
    owner: { principalRecordId: 'owner-1', principalVersion: 1 },
    task: { kind: 'automation-run', ref: `run-${contractId}` },
    objective: objectiveText,
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

  harness.provideMockService(ctx, 'assistantVerifier', {
    inspectAcceptedTask: (id: string) =>
      id === contract.id
        ? { contract, state: 'awaiting-execution', attempts: 0, reason: null, receipt: null }
        : null,
  })

  return { contractId: contract.id, contractDigest: contract.digest }
}

function validEvaluator(quote: string, mode: 'accept' | 'pending' = 'accept') {
  return {
    protocol: 1,
    policy: () => ({ version: 'v1', rules: [{ ruleId: 'r-auto', ceiling: 'accept' }] }),
    evaluate: ({ signal }: { signal?: AbortSignal }) => {
      if (mode === 'pending') {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('evaluation-aborted')), { once: true })
        })
      }
      return Promise.resolve({ level: 'accept', quotes: [quote] })
    },
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

describe('Tier 1 — F02–F07: Policy, Evaluation, WorkItems, Proactive & Benchmarks', () => {
  describe('F02: WP08 PolicyRule native schema (lease, destination, sensitivity, cost cap, commit digest)', () => {
    test('T1-F02-01: active lease allows within expiry and maxUses and fails closed once expired', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const now = 1_700_000_000_000
      const compiled = compilePolicy([
        baseRule({
          lease: { leaseId: 'L1', expiresAtMs: now + 60_000, maxUses: 3, revoked: false },
        }) as never,
      ])

      const evalFn = evaluatePolicy as (p: unknown, req: unknown, state?: unknown) => { effect: string; reasonCode: string }
      const allowed = evalFn(compiled, basePolicyRequest({ leaseId: 'L1' }), { nowMs: now, leaseUses: { L1: 1 } })
      expect(allowed.effect).toBe('allow')
      expect(allowed.reasonCode).toBe('rule-allow')

      const expired = evalFn(compiled, basePolicyRequest({ leaseId: 'L1' }), { nowMs: now + 120_000, leaseUses: { L1: 1 } })
      expect(expired.effect).toBe('deny')
    })

    test('T1-F02-02: destination allowlist permits exact matched destination and denies unlisted destination', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const compiled = compilePolicy([
        baseRule({
          destinations: ['https://api.github.com/repos/org/repo'],
        }) as never,
      ])

      const evalFn = evaluatePolicy as (p: unknown, req: unknown, state?: unknown) => { effect: string }
      const ok = evalFn(compiled, basePolicyRequest({ destination: 'https://api.github.com/repos/org/repo' }))
      expect(ok.effect).toBe('allow')

      const denied = evalFn(compiled, basePolicyRequest({ destination: 'https://evil.example/exfil' }))
      expect(denied.effect).toBe('deny')
    })

    test('T1-F02-03: data sensitivity ceiling permits internal under confidential and denies restricted', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const compiled = compilePolicy([
        baseRule({ maxSensitivity: 'confidential' }) as never,
      ])

      const evalFn = evaluatePolicy as (p: unknown, req: unknown) => { effect: string }
      expect(evalFn(compiled, basePolicyRequest({ sensitivity: 'internal' })).effect).toBe('allow')
      expect(evalFn(compiled, basePolicyRequest({ sensitivity: 'restricted' })).effect).toBe('deny')
    })

    test('T1-F02-04: monetary cost cap permits within monetaryCostCapMicros and denies over-cap request', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const compiled = compilePolicy([
        baseRule({ monetaryCostCapMicros: 50_000 }) as never,
      ])

      const evalFn = evaluatePolicy as (p: unknown, req: unknown) => { effect: string }
      expect(evalFn(compiled, basePolicyRequest({ estimatedCostMicros: 25_000 })).effect).toBe('allow')
      expect(evalFn(compiled, basePolicyRequest({ estimatedCostMicros: 75_000 })).effect).toBe('deny')
    })

    test('T1-F02-05: commit digest, predecessor digest and idempotencyKey bind rule and deny mismatch', async () => {
      const { compilePolicy, evaluatePolicy } = await loadAssistantPolicyEvaluator()
      const shaA = sha256Hex('commit-a')
      const shaPrev = sha256Hex('commit-prev')
      const shaBad = sha256Hex('commit-other')
      const compiled = compilePolicy([
        baseRule({ commitDigest: shaA, predecessorDigest: shaPrev, idempotencyKey: 'k1' }) as never,
      ])

      const evalFn = evaluatePolicy as (p: unknown, req: unknown) => { effect: string }
      expect(evalFn(compiled, basePolicyRequest({ commitDigest: shaA, predecessorDigest: shaPrev, idempotencyKey: 'k1' })).effect).toBe('allow')
      expect(evalFn(compiled, basePolicyRequest({ commitDigest: shaBad, predecessorDigest: shaPrev, idempotencyKey: 'k1' })).effect).toBe('deny')
    })
  })

  describe('F03: WP22 observe -> auto transition & dynamic intake rule adoption', () => {
    test('T1-F03-01: AttentionTuning / AttentionLoosening schema carries workItemsMode and intakeRuleUpdates', async () => {
      const evalMod = await loadAssistantEvaluation()
      const normalize = getExportFn<(input: Record<string, unknown>) => Record<string, unknown>>(
        evalMod,
        'normalizeAttentionTuningParameters',
      )
      const normalized = normalize({
        interruptionCostDelta: 0,
        minimumUtilityDelta: 0,
        quietExtensionMinutes: 0,
        muted: false,
        workItemsMode: 'auto',
        intakeRuleUpdates: [
          { ruleId: 'dsh-intake-github-mention-or-review', enabled: true, mode: 'auto', confidenceThresholdPpm: 800_000, minUtility: 10 },
        ],
      })
      expect(normalized.workItemsMode).toBe('auto')
      expect(Array.isArray(normalized.intakeRuleUpdates)).toBe(true)
      expect((normalized.intakeRuleUpdates as Array<Record<string, unknown>>)[0]?.ruleId).toBe('dsh-intake-github-mention-or-review')
    })

    test('T1-F03-02: dynamic observe -> auto transition updates live AssistantWorkItemsService without restart', async () => {
      const ws = await workspaces.create('f03-live-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantEvaluationService } = await loadAssistantEvaluation()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      const evalSvc = await harness.mountService(ctx, AssistantEvaluationService, 'assistantEvaluation', {
        databasePath: ws.sqlitePath('evaluation'),
        projectionIntervalMs: 0,
        notificationOutcomesEnabled: true,
        attentionTuningAutoAdopt: true,
        attentionLooseningEnabled: true,
      })
      const workItems = await harness.mountService<{
        applyIntakeTuning: (u: Record<string, unknown>) => { mode: string; rules: readonly unknown[] }
        intakeAdmissionMode: () => string
        intakeTuning: () => { mode: string; rules: readonly unknown[] }
      }>(
        ctx,
        AssistantWorkItemsService,
        'assistantWorkItems',
        activeWorkItemsConfig(ws, ws.sqlitePath('work-items'), 'observe'),
      )

      const applied = workItems.applyIntakeTuning({ workItemsMode: 'auto' })
      expect(evalSvc).toBeDefined()
      expect(applied.mode).toBe('auto')
      expect(workItems.intakeAdmissionMode()).toBe('auto')
      expect(workItems.intakeTuning().mode).toBe('auto')
    }, 15_000)

    test('T1-F03-03: dynamic intakeRuleUpdates adopted by WorkItems runtime', async () => {
      const ws = await workspaces.create('f03-rules-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      const workItems = await harness.mountService<{
        applyIntakeTuning: (u: Record<string, unknown>) => { mode: string; rules: readonly Record<string, unknown>[] }
        intakeTuning: () => { mode: string; rules: readonly Record<string, unknown>[] }
      }>(
        ctx,
        AssistantWorkItemsService,
        'assistantWorkItems',
        activeWorkItemsConfig(ws, ws.sqlitePath('work-items'), 'observe'),
      )

      const res = workItems.applyIntakeTuning({
        intakeRuleUpdates: [
          {
            ruleId: 'dsh-intake-github-mention-or-review',
            enabled: true,
            mode: 'auto',
            confidenceThresholdPpm: 800_000,
            minUtility: 10,
          },
        ],
      })
      expect(res.rules.some(r => r.ruleId === 'dsh-intake-github-mention-or-review' && r.mode === 'auto')).toBe(true)
      expect(workItems.intakeTuning().rules.find(r => r.ruleId === 'dsh-intake-github-mention-or-review')?.confidenceThresholdPpm).toBe(800_000)
    })

    test('T1-F03-04: WP22 loosening decision propagates to WorkItems automatic admission', async () => {
      const ws = await workspaces.create('f03-e2e-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantEvaluationService } = await loadAssistantEvaluation()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      const evaluation = await harness.mountService(ctx, AssistantEvaluationService, 'assistantEvaluation', {
        databasePath: ws.sqlitePath('evaluation'),
        projectionIntervalMs: 0,
        notificationOutcomesEnabled: true,
        attentionTuningAutoAdopt: true,
        attentionLooseningEnabled: true,
        intakeEvaluationAgreementEnabled: true,
      })
      const workItems = await harness.mountService<{
        applyIntakeTuning: (u: Record<string, unknown>) => { mode: string }
        intakeAdmissionMode: () => string
      }>(
        ctx,
        AssistantWorkItemsService,
        'assistantWorkItems',
        activeWorkItemsConfig(ws, ws.sqlitePath('work-items'), 'observe'),
      )

      const subscribe = getMethod<(cb: (d: Record<string, unknown>) => void) => () => void>(evaluation, 'onAttentionLooseningAdopted')
      let captured: Record<string, unknown> | undefined
      subscribe(d => {
        captured = d
        workItems.applyIntakeTuning({
          ...(typeof d.workItemsMode === 'string' ? { workItemsMode: d.workItemsMode } : {}),
          ...(Array.isArray(d.intakeRuleUpdates) ? { intakeRuleUpdates: d.intakeRuleUpdates } : {}),
        })
      })
      const adopt = getMethod<(input: Record<string, unknown>) => unknown>(evaluation, 'emitLooseningToConsumers')
      adopt({ workItemsMode: 'auto', intakeRuleUpdates: [{ ruleId: 'dsh-intake-github-mention-or-review', mode: 'auto' }] })
      expect(captured?.workItemsMode).toBe('auto')
      expect(workItems.intakeAdmissionMode()).toBe('auto')
    })

    test('T1-F03-05: tightening or rollback reverts WorkItems auto -> observe', async () => {
      const ws = await workspaces.create('f03-rollback-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      const workItems = await harness.mountService<{
        applyIntakeTuning: (u: Record<string, unknown>) => { mode: string }
        intakeAdmissionMode: () => string
      }>(
        ctx,
        AssistantWorkItemsService,
        'assistantWorkItems',
        activeWorkItemsConfig(ws, ws.sqlitePath('work-items'), 'observe'),
      )

      workItems.applyIntakeTuning({ workItemsMode: 'auto' })
      expect(workItems.intakeAdmissionMode()).toBe('auto')
      workItems.applyIntakeTuning({ workItemsMode: 'observe' })
      expect(workItems.intakeAdmissionMode()).toBe('observe')
    })
  })

  describe('F04: WP21 restart-persistent intake hints & evaluation queue', () => {
    test('T1-F04-01: workItemsIntakeHints survive Cordis restart in SQLite', async () => {
      const ws = await workspaces.create('f04-hint-')
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('work-items')

      const objectiveText = 'Fix failing test suite in repo'
      const digest = sha256Hex(objectiveText)
      const issuedAt = Date.now() - 1_000
      const contractWindow = { issuedAt, expiresAt: issuedAt + 3_600_000 }

      const ctx1 = harness.createContext()
      const acceptance = await mountWorkItemsPeers(ctx1, ws, 'policy1', objectiveText, 'c-hint-1', contractWindow)
      const wi1 = await harness.mountService<{
        recordIntake: (input: unknown, sourceText?: string) => unknown
        registerIntakeEvaluator: (reg: unknown) => () => void
        intakeEvaluations: (source: string, sourceEventId: string) => readonly { wouldAccept: boolean }[]
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      wi1.registerIntakeEvaluator(validEvaluator('Fix failing test suite'))
      wi1.recordIntake({
        source: 'lark-channel',
        sourceEventId: 'evt-hint-1',
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
      await vi.waitFor(() => expect(wi1.intakeEvaluations('lark-channel', 'evt-hint-1')).toMatchObject([{ wouldAccept: true }]))
      await harness.disposeAll()

      const ctx2 = harness.createContext()
      await mountWorkItemsPeers(ctx2, ws, 'policy2', objectiveText, 'c-hint-1', contractWindow)
      const wi2 = await harness.mountService<{
        runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      const admissions = wi2.runIntakeAdmission()
      expect(admissions[0]?.outcome).toBe('admitted')
      expect(admissions[0]?.itemId).not.toBeNull()

      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db.prepare('SELECT id, brief FROM work_item WHERE id = ?').get(admissions[0]!.itemId!) as { id: string; brief: string } | undefined
        expect(row?.brief).toBe(objectiveText)
      } finally {
        db.close()
      }
    })

    test('T1-F04-02: post-restart auto admission executes admitted instead of would-admit', async () => {
      const ws = await workspaces.create('f04-auto-')
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('work-items')

      const objectiveText = 'Triage urgent CI failure'
      const digest = sha256Hex(objectiveText)
      const issuedAt = Date.now() - 1_000
      const contractWindow = { issuedAt, expiresAt: issuedAt + 3_600_000 }

      const ctx1 = harness.createContext()
      const acceptance = await mountWorkItemsPeers(ctx1, ws, 'policy1', objectiveText, 'c-auto-1', contractWindow)
      const wi1 = await harness.mountService<{
        recordIntake: (input: unknown, sourceText?: string) => unknown
        registerIntakeEvaluator: (reg: unknown) => () => void
        intakeEvaluations: (source: string, sourceEventId: string) => readonly { wouldAccept: boolean }[]
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      wi1.registerIntakeEvaluator(validEvaluator('Triage urgent'))
      wi1.recordIntake({
        source: 'lark-channel',
        sourceEventId: 'evt-auto-1',
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
      await vi.waitFor(() => expect(wi1.intakeEvaluations('lark-channel', 'evt-auto-1')).toMatchObject([{ wouldAccept: true }]))
      await harness.disposeAll()

      const ctx2 = harness.createContext()
      await mountWorkItemsPeers(ctx2, ws, 'policy2', objectiveText, 'c-auto-1', contractWindow)
      const wi2 = await harness.mountService<{
        runIntakeAdmission: () => readonly { outcome: string; mode: string; itemId: string | null }[]
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      const admissions = wi2.runIntakeAdmission()
      expect(admissions.length).toBeGreaterThan(0)
      expect(admissions[0]?.mode).toBe('auto')
      expect(admissions[0]?.outcome).toBe('admitted')
      expect(admissions[0]?.itemId).not.toBeNull()
    })

    test('T1-F04-03: pending intake evaluation queue entries survive restart and settle post-restart', async () => {
      const ws = await workspaces.create('f04-evalq-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('work-items')

      const objectiveText = 'Evaluate queued event after restart'
      const digest = sha256Hex(objectiveText)

      const ctx1 = harness.createContext()
      await harness.mountService(ctx1, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy1') })
      const wi1 = await harness.mountService<{
        recordIntake: (input: unknown, sourceText?: string) => unknown
        registerIntakeEvaluator: (reg: unknown) => () => void
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'observe', 'triage'))

      // Register a pending evaluator before recordIntake so staging + queue entries persist while inflight aborts cleanly on disposeAll.
      wi1.registerIntakeEvaluator(validEvaluator('Evaluate', 'pending'))
      wi1.recordIntake({
        source: 'lark-channel',
        sourceEventId: 'evt-q-1',
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
      }, objectiveText)

      const dbCheck = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const qRow = dbCheck.prepare('SELECT source_event_id FROM work_item_intake_eval_queue WHERE source_event_id = ?').get('evt-q-1') as { source_event_id: string } | undefined
        expect(qRow?.source_event_id).toBe('evt-q-1')
      } finally {
        dbCheck.close()
      }
      await harness.disposeAll()

      const ctx2 = harness.createContext()
      await harness.mountService(ctx2, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy2') })
      const wi2 = await harness.mountService<{
        registerIntakeEvaluator: (reg: unknown) => () => void
        intakeEvaluations: (source: string, sourceEventId: string) => readonly { sourceEventId: string; status: string }[]
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'observe', 'triage'))

      wi2.registerIntakeEvaluator(validEvaluator('Evaluate', 'accept'))
      await vi.waitFor(() => {
        expect(wi2.intakeEvaluations('lark-channel', 'evt-q-1').some(row => row.status === 'decided')).toBe(true)
      })
    })

    test('T1-F04-04: post-restart replay idempotency returns replayed with identical itemId', async () => {
      const ws = await workspaces.create('f04-replay-')
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('work-items')

      const objectiveText = 'Idempotent work item check'
      const digest = sha256Hex(objectiveText)
      const issuedAt = Date.now() - 1_000
      const contractWindow = { issuedAt, expiresAt: issuedAt + 3_600_000 }

      const ctx1 = harness.createContext()
      const acceptance = await mountWorkItemsPeers(ctx1, ws, 'policy1', objectiveText, 'c-idem', contractWindow)
      const input = {
        source: 'lark-channel',
        sourceEventId: 'evt-idem-1',
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
      }
      const wi1 = await harness.mountService<{
        recordIntake: (i: unknown, s?: string) => unknown
        registerIntakeEvaluator: (reg: unknown) => () => void
        intakeEvaluations: (source: string, sourceEventId: string) => readonly { wouldAccept: boolean }[]
        runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      wi1.registerIntakeEvaluator(validEvaluator('Idempotent'))
      wi1.recordIntake(input, objectiveText)
      await vi.waitFor(() => expect(wi1.intakeEvaluations('lark-channel', 'evt-idem-1')).toMatchObject([{ wouldAccept: true }]))
      const first = wi1.runIntakeAdmission()
      expect(first[0]?.outcome).toBe('admitted')
      const itemId = first[0]?.itemId
      await harness.disposeAll()

      const ctx2 = harness.createContext()
      await mountWorkItemsPeers(ctx2, ws, 'policy2', objectiveText, 'c-idem', contractWindow)
      const wi2 = await harness.mountService<{
        recordIntake: (i: unknown, s?: string) => { record: { decision: string }; replayed: boolean }
        intakeAdmissions: (src: string, id: string) => readonly { itemId: string | null }[]
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      const replayed = wi2.recordIntake(input, objectiveText)
      expect(replayed.replayed).toBe(true)
      expect(replayed.record.decision).toBe('stored')
      expect(wi2.intakeAdmissions('lark-channel', 'evt-idem-1')[0]?.itemId).toBe(itemId)
    })

    test('T1-F04-05: persisted intake hint uses AEAD integrity tag and fails closed on tampering', async () => {
      const ws = await workspaces.create('f04-integrity-')
      const { AssistantWorkItemsService } = await loadAssistantWorkItems()
      const dbPath = ws.sqlitePath('work-items')

      const objectiveText = 'Verify protected AEAD hint storage'
      const digest = sha256Hex(objectiveText)
      const ctx1 = harness.createContext()
      const acceptance = await mountWorkItemsPeers(ctx1, ws, 'policy1', objectiveText, 'c-int-1')
      const wi1 = await harness.mountService<{
        recordIntake: (i: unknown, s?: string) => unknown
        registerIntakeEvaluator: (reg: unknown) => () => void
        runIntakeEvaluation: () => Promise<unknown[]>
      }>(ctx1, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      wi1.registerIntakeEvaluator(validEvaluator('Verify protected'))
      wi1.recordIntake({
        source: 'lark-channel',
        sourceEventId: 'evt-int-1',
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
      await wi1.runIntakeEvaluation()
      await harness.disposeAll()

      const dbTamper = new DatabaseSync(dbPath)
      try {
        const row = dbTamper.prepare(
          'SELECT iv, auth_tag, ciphertext, has_objective, has_acceptance FROM work_item_intake_staging WHERE source = ? AND source_event_id = ?',
        ).get('lark-channel', 'evt-int-1') as {
          iv: Uint8Array
          auth_tag: Uint8Array
          ciphertext: Uint8Array
          has_objective: number
          has_acceptance: number
        } | undefined
        expect(row).toBeDefined()
        expect(row!.has_objective).toBe(1)
        expect(row!.has_acceptance).toBe(1)
        expect(row!.iv.byteLength).toBe(12)
        expect(row!.auth_tag.byteLength).toBe(16)
        expect(Buffer.from(row!.ciphertext).toString('utf8')).not.toContain(objectiveText)

        const badTag = Buffer.from(row!.auth_tag)
        badTag[0] = (badTag[0]! ^ 0xff) & 0xff
        dbTamper.prepare('UPDATE work_item_intake_staging SET auth_tag = ? WHERE source = ? AND source_event_id = ?')
          .run(badTag, 'lark-channel', 'evt-int-1')
      } finally {
        dbTamper.close()
      }

      const ctx2 = harness.createContext()
      await mountWorkItemsPeers(ctx2, ws, 'policy2', objectiveText, 'c-int-1')
      const wi2 = await harness.mountService<{
        runIntakeAdmission: () => readonly { outcome: string; itemId: string | null }[]
      }>(ctx2, AssistantWorkItemsService, 'assistantWorkItems', activeWorkItemsConfig(ws, dbPath, 'auto', 'triage'))

      const admissions = wi2.runIntakeAdmission()
      expect(admissions[0]?.outcome).toBe('would-admit')
      expect(admissions[0]?.itemId).toBeNull()

      const dbVerify = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const count = dbVerify.prepare('SELECT COUNT(*) AS n FROM work_item').get() as { n: number }
        expect(count.n).toBe(0)
      } finally {
        dbVerify.close()
      }
    })
  })

  describe('F05: WP12 dynamic proactive utility & interruption cost', () => {
    function makeProfile(overrides: Record<string, unknown> = {}) {
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

    function makeInput(wsRoot: string, seq: number, overrides: Record<string, unknown> = {}) {
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

    test('T1-F05-01: dynamic utility adjusts based on runtime urgency/context signals', async () => {
      const ws = await workspaces.create('f05-urgency-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[]) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): { decision: { utility: number } }
      }>(mod, 'OpportunityEngine')

      const engine = new OpportunityEngine(ws.sqlitePath('proactive'), [makeProfile()])
      const lowUrgency = engine.evaluate(makeInput(ws.workspace, 1), undefined, { urgencyPpm: 200_000 })
      const highUrgency = engine.evaluate(makeInput(ws.workspace, 2), undefined, { urgencyPpm: 950_000 })

      expect(highUrgency.decision.utility).not.toBe(lowUrgency.decision.utility)
      expect(highUrgency.decision.utility).toBeGreaterThan(lowUrgency.decision.utility)
    })

    test('T1-F05-02: dynamic interruption cost rises when owner is actively engaged', async () => {
      const ws = await workspaces.create('f05-interrupt-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[]) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): { decision: { utility: number } }
      }>(mod, 'OpportunityEngine')

      const engine = new OpportunityEngine(ws.sqlitePath('proactive'), [makeProfile()])
      const idle = engine.evaluate(makeInput(ws.workspace, 1), undefined, { userActive: false, recentNotificationCount: 0 })
      const busy = engine.evaluate(makeInput(ws.workspace, 2), undefined, { userActive: true, recentNotificationCount: 5 })

      expect(busy.decision.utility).toBeLessThan(idle.decision.utility)
    })

    test('T1-F05-03: dynamic utility crosses minimumUtility threshold deterministically', async () => {
      const ws = await workspaces.create('f05-threshold-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[]) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): { decision: { state: string; mode: string; reason: string } }
      }>(mod, 'OpportunityEngine')

      const engine = new OpportunityEngine(ws.sqlitePath('proactive'), [makeProfile({ minimumUtility: 45 })])
      const high = engine.evaluate(makeInput(ws.workspace, 1), undefined, { urgencyPpm: 950_000, userActive: false })
      const low = engine.evaluate(makeInput(ws.workspace, 2), undefined, { urgencyPpm: 100_000, userActive: true, recentNotificationCount: 6 })

      expect(high.decision.state).toBe('decided')
      expect(high.decision.mode).toBe('remind')
      expect(low.decision.reason).toBe('below-threshold')
    })

    test('T1-F05-04: dynamic utility composes additively with WP22 AttentionOverlay delta', async () => {
      const ws = await workspaces.create('f05-overlay-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[]) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): { decision: { utility: number } }
      }>(mod, 'OpportunityEngine')

      const baseEngine = new OpportunityEngine(ws.sqlitePath('proactive-base'), [makeProfile()])
      const overlayEngine = new OpportunityEngine(ws.sqlitePath('proactive-overlay'), [makeProfile()])
      const baseEval = baseEngine.evaluate(makeInput(ws.workspace, 1), undefined, { urgencyPpm: 700_000 })
      const overlayEval = overlayEngine.evaluate(
        makeInput(ws.workspace, 1),
        { version: 1, digest: sha256Hex('ov-1'), parameters: { interruptionCostDelta: 20, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false } },
        { urgencyPpm: 700_000 },
      )
      expect(overlayEval.decision.utility).toBe(baseEval.decision.utility - 20)
    })

    test('T1-F05-05: dynamic utility remains finite safe integer under extreme valid signals', async () => {
      const ws = await workspaces.create('f05-safe-')
      const mod = await loadAssistantProactive()
      const OpportunityEngine = getExportFn<new (path: string, profiles: readonly unknown[]) => {
        evaluate(input: unknown, overlay?: unknown, runtimeContext?: unknown): { decision: { utility: number } }
      }>(mod, 'OpportunityEngine')

      const engine = new OpportunityEngine(ws.sqlitePath('proactive'), [makeProfile({ expectedBenefit: 1_000_000_000, successPpm: 1_000_000 })])
      const res = engine.evaluate(makeInput(ws.workspace, 1), undefined, { urgencyPpm: 1_000_000, userActive: false })
      expect(Number.isSafeInteger(res.decision.utility)).toBe(true)
      expect(Number.isFinite(res.decision.utility)).toBe(true)
    })
  })

  describe('F06: WP04 families-v1 deepened benchmark & native planning/growth ablations', () => {
    function sampleModelConfig() {
      return {
        provider: 'deepseek',
        model: 'deepseek-chat',
        temperature: 0,
        maxOutputTokens: 256,
        inputUsdMicrosPerMillionTokens: 1000,
        outputUsdMicrosPerMillionTokens: 2000,
        adapterDigest: sha256Hex('adapter'),
        tokenCounterDigest: sha256Hex('counter'),
      }
    }

    function sampleBudget(toolCalls = 0) {
      return {
        durationMs: 10_000,
        inputTokens: 100_000,
        outputTokens: 1_000,
        costUsdMicros: null,
        toolCalls,
      }
    }

    test('T1-F06-01: families-v1 deepened corpus provides version 2 multi-stage and stateful scenarios', async () => {
      const corpus = await loadFamiliesCorpus()
      expect(corpus.familiesDevelopmentDataset.version).toBe('2')
      const cases = corpus.familiesDevelopmentCases()
      expect(cases.length).toBe(9)
      const crossDay = corpus.familiesScenario('cross-day-handoff-next-batch')
      expect(crossDay.stages.length).toBe(2)
      expect(crossDay.stages[1]?.freshSession).toBe(true)
      const codeCase = corpus.familiesScenario('code-page-count-off-by-one')
      expect(codeCase.hiddenCodeVectors.length).toBeGreaterThanOrEqual(5)
      expect(codeCase.allowedTools).toContain('code_run_tests')
    })

    test('T1-F06-02: nativeBenchmarkPlan preserves features.planning true on candidate and false on ablation', async () => {
      const native = await loadNativeBenchmark()
      const corpus = await loadFamiliesCorpus()
      const firstId = corpus.familiesDevelopmentCases()[0]!.id
      const plan = native.nativeBenchmarkPlan({
        id: 'plan-planning-1',
        suite: 'families-v1',
        cases: [firstId],
        variants: [
          { id: 'base', role: 'baseline', persona: 'baseline', memory: false, review: false, planning: false, growth: false } as never,
          { id: 'cand', role: 'candidate', persona: 'cand', memory: false, review: true, planning: true, growth: true } as never,
          { id: 'no-plan', role: 'ablation', persona: 'cand', memory: false, review: true, planning: false, growth: true } as never,
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(8),
        repeats: 2,
        seed: 42,
      })

      const cand = plan.variants.find(v => v.id === 'cand')
      const ablation = plan.variants.find(v => v.id === 'no-plan')
      expect((cand?.features as Record<string, unknown> | undefined)?.planning).toBe(true)
      expect((ablation?.features as Record<string, unknown> | undefined)?.planning).toBe(false)
    })

    test('T1-F06-03: nativeBenchmarkPlan preserves features.growth true on candidate and false on ablation', async () => {
      const native = await loadNativeBenchmark()
      const corpus = await loadFamiliesCorpus()
      const firstId = corpus.familiesDevelopmentCases()[0]!.id
      const plan = native.nativeBenchmarkPlan({
        id: 'plan-growth-1',
        suite: 'families-v1',
        cases: [firstId],
        variants: [
          { id: 'base', role: 'baseline', persona: 'baseline', memory: false, review: false, planning: false, growth: false } as never,
          { id: 'cand', role: 'candidate', persona: 'cand', memory: false, review: true, planning: true, growth: true } as never,
          { id: 'no-growth', role: 'ablation', persona: 'cand', memory: false, review: true, planning: true, growth: false } as never,
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(8),
        repeats: 2,
        seed: 42,
      })

      const cand = plan.variants.find(v => v.id === 'cand')
      const ablation = plan.variants.find(v => v.id === 'no-growth')
      expect((cand?.features as Record<string, unknown> | undefined)?.growth).toBe(true)
      expect((ablation?.features as Record<string, unknown> | undefined)?.growth).toBe(false)
    })

    test('T1-F06-04: createNativeBenchmarkExecutor executes families-v1 cell with planning enabled', async () => {
      const native = await loadNativeBenchmark()
      const corpus = await loadFamiliesCorpus()
      const { benchmarkSchedule } = await loadBenchmarkIndex()
      const cases = corpus.familiesDevelopmentCases()
      const planConfig = {
        id: 'plan-exec-1',
        suite: 'families-v1' as const,
        cases: [cases[0]!.id],
        variants: [
          { id: 'base', role: 'baseline' as const, persona: 'helpful', memory: false, review: false, planning: false, growth: false },
          { id: 'cand', role: 'candidate' as const, persona: 'helpful', memory: false, review: false, planning: true, growth: false },
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(0),
        repeats: 2,
        seed: 1,
      }
      const plan = native.nativeBenchmarkPlan(planConfig)
      const executor = native.createNativeBenchmarkExecutor(planConfig, async () => ({
        adapter: new DeterministicNativeAdapter(),
        inputTokenUpperBound: () => 500,
        dispose: () => {},
      }))
      const candCell = benchmarkSchedule(plan).find(c => c.variantId === 'cand')!
      const controller = new AbortController()
      const obs = await executor.execute({
        planId: plan.id,
        dataset: plan.dataset,
        cell: candCell,
        task: plan.cases[0]!,
        variant: plan.variants[1]!,
        budget: plan.budget,
        signal: controller.signal,
      })
      expect(obs.quiescent).toBe(true)
      expect(['achieved', 'not-achieved']).toContain(obs.verdict)
    })

    test('T1-F06-05: paired comparison computes deltas for planning and growth ablations', async () => {
      const ws = await workspaces.create('f06-ablation-')
      const native = await loadNativeBenchmark()
      const corpus = await loadFamiliesCorpus()
      const runnerMod = await loadBenchmarkRunner()
      const { BenchmarkStore } = await loadBenchmarkStore()
      const { benchmarkReport } = await loadBenchmarkIndex()

      const caseId = corpus.familiesDevelopmentCases()[0]!.id
      const planConfig = {
        id: 'plan-pair-1',
        suite: 'families-v1' as const,
        cases: [caseId],
        variants: [
          { id: 'base', role: 'baseline' as const, persona: 'p', memory: false, review: false, planning: false, growth: false },
          { id: 'cand', role: 'candidate' as const, persona: 'p', memory: false, review: false, planning: true, growth: true },
          { id: 'abl-plan', role: 'ablation' as const, persona: 'p', memory: false, review: false, planning: false, growth: true },
          { id: 'abl-growth', role: 'ablation' as const, persona: 'p', memory: false, review: false, planning: true, growth: false },
        ],
        model: sampleModelConfig(),
        budget: sampleBudget(0),
        repeats: 2,
        seed: 7,
      }
      const plan = native.nativeBenchmarkPlan(planConfig)

      const store = new (BenchmarkStore as new (path: string) => { close?: () => void })(ws.sqlitePath('bench'))
      try {
        const executor = native.createNativeBenchmarkExecutor(planConfig, async () => ({
          adapter: new DeterministicNativeAdapter(),
          inputTokenUpperBound: () => 500,
          dispose: () => {},
        }))
        const results = await runnerMod.runBenchmark(store as never, plan, executor)
        expect(results.length).toBe(8)
        const report = benchmarkReport(plan, results)
        expect(report.complete).toBe(true)
        expect(report.comparisons.length).toBeGreaterThanOrEqual(2)
      } finally {
        store.close?.()
      }
    })
  })

  describe('F07: R3 default-on flags across Policy, Evaluation, WorkItems, Proactive & plugin-setup', () => {
    test('T1-F07-01: assistant-work-items default ConfigSchema enables R3 intake & evaluation while failing closed on unbound admit', async () => {
      const ws = await workspaces.create('f07-wi-')
      const { ConfigSchema, normalizeConfig } = await loadAssistantWorkItems()
      const parsed = ConfigSchema({ databasePath: ws.sqlitePath('wi'), workRoot: ws.workspace })
      expect(parsed.enabled).toBe(true)
      expect(parsed.intakeLedger?.enabled).toBe(true)
      expect(parsed.intakeLedger?.evaluation?.enabled).toBe(true)
      expect(parsed.intakeLedger?.evaluation?.admit).toBeUndefined()
      expect(() => normalizeConfig({
        databasePath: ws.sqlitePath('wi'),
        workRoot: ws.workspace,
        intakeLedger: { evaluation: { admit: { enabled: true } } },
      } as never)).toThrow('originBindingId')

      const bound = ConfigSchema({
        databasePath: ws.sqlitePath('wi'),
        workRoot: ws.workspace,
        intakeLedger: { evaluation: { admit: { originBindingId: 'binding-origin-1' } } },
      })
      expect(bound.intakeLedger?.evaluation?.admit?.enabled).toBe(true)

      const now = Date.now()
      const normalized = normalizeConfig({
        enabled: true,
        mode: 'active',
        databasePath: ws.sqlitePath('wi'),
        workRoot: ws.workspace,
        workerAutomationId: 'worker-1',
        scope: {
          workspace: ws.workspace,
          preset: 'primary',
          principalId: 'web/a/t/u',
          ownerRouteId: 'route-1',
          expiresAt: now + 86_400_000,
        },
        admission: { allowedKinds: ['intake-inferred'] },
        intakeLedger: { evaluation: { admit: { originBindingId: 'binding-origin-1' } } },
      }, now)
      expect(normalized.intakeLedger?.evaluation?.admit?.mode).toBe('auto')
    })

    test('T1-F07-02: assistant-proactive default Config enables intakeEvaluation', async () => {
      const { Config } = await loadAssistantProactive()
      const parsed = Config({})
      expect(parsed.intakeEvaluation?.enabled).toBe(true)
    })

    test('T1-F07-03: assistant-evaluation default Config enables WP22 flags', async () => {
      const ws = await workspaces.create('f07-eval-')
      const { Config } = await loadAssistantEvaluation()
      const parsed = Config({ databasePath: ws.sqlitePath('eval') })
      expect(parsed.notificationOutcomesEnabled).toBe(true)
      expect(parsed.attentionTuningAutoAdopt).toBe(true)
      expect(parsed.intakeAttentionAgreementEnabled).toBe(true)
      expect(parsed.intakeEvaluationAgreementEnabled).toBe(true)
      expect(parsed.attentionLooseningEnabled).toBe(true)
    })

    test('T1-F07-04: plugin-setup recommended preset activates WP22/WorkItems/Proactive auto chain', async () => {
      const ws = await workspaces.create('f07-preset-')
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')

      const setup = await loadPluginSetup()
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
        '    notificationOutcomesEnabled: false',
        '    attentionTuningAutoAdopt: false',
        '    attentionLooseningEnabled: false',
        '- id: dsh-enhanced-assistant-proactive',
        '  name: "@dsh-enhanced/assistant-proactive"',
        '  config:',
        `    databasePath: ${ws.sqlitePath('pro')}`,
        '    intakeEvaluation:',
        '      enabled: false',
        '- id: dsh-enhanced-assistant-delivery',
        '  name: "@dsh-enhanced/assistant-delivery"',
        '  config:',
        `    databasePath: ${ws.sqlitePath('del')}`,
        `    spoolPath: ${join(ws.stateDir, 'spool')}`,
        '    attentionAttachOverCap: false',
      ].join('\n')

      const readDump = createPresetFixtureDump(bundlesYaml)
      const applyPreset = getExportFn<(
        target: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<{
        changed: boolean
        changes: Array<{ id: string; key: string; from: unknown; to: unknown }>
      }>>(setup, 'applyRecommendedPluginPreset')

      const res = await applyPreset({ dshHome: ws.dshHome, profile: 'web' }, { readDump })
      expect(res.changed).toBe(true)
      expect(res.changes).toContainEqual({
        id: 'dsh-enhanced-assistant-work-items',
        key: 'enabled',
        from: false,
        to: true,
      })

      const patchDoc = parseCordisPatch(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'))
      const wiConfig = getPatchConfig(findPatchRow(patchDoc.document, 'dsh-enhanced-assistant-work-items'))
      const evalConfig = getPatchConfig(findPatchRow(patchDoc.document, 'dsh-enhanced-assistant-evaluation'))
      expect(wiConfig.enabled).toBe(true)
      expect(evalConfig.notificationOutcomesEnabled).toBe(true)
      expect(evalConfig.attentionTuningAutoAdopt).toBe(true)
      expect(evalConfig.attentionLooseningEnabled).toBe(true)
    })

    test('T1-F07-05: plugin-setup CLI presets apply cleanly and idempotently across web/supervised/lark profiles', async () => {
      const ws = await workspaces.create('f07-cli-')
      for (const profile of ['web', 'supervised', 'lark']) {
        const dir = join(ws.dshHome, 'profiles', profile)
        mkdirSync(dir, { recursive: true })
        await writeFile(join(dir, 'cordis.patch.yml'), '[]\n', 'utf8')
      }
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
        '- id: dsh-enhanced-assistant-proactive',
        '  name: "@dsh-enhanced/assistant-proactive"',
        '  config:',
        `    databasePath: ${ws.sqlitePath('pro')}`,
      ].join('\n')
      const readDump = createPresetFixtureDump(bundlesYaml)

      for (const profile of ['web', 'supervised', 'lark']) {
        const patchPath = join(ws.dshHome, 'profiles', profile, 'cordis.patch.yml')
        const first = await runPluginSetupInProcess(
          ['preset', 'recommended', '--yes', '--profile', profile, '--dsh-home', ws.dshHome],
          { dshHome: ws.dshHome, readDump },
        )
        expect(first.exitCode).toBe(0)
        const afterFirst = await readFile(patchPath, 'utf8')
        const second = await runPluginSetupInProcess(
          ['preset', 'recommended', '--yes', '--profile', profile, '--dsh-home', ws.dshHome],
          { dshHome: ws.dshHome, readDump },
        )
        expect(second.exitCode).toBe(0)
        const afterSecond = await readFile(patchPath, 'utf8')
        expect(afterSecond).toBe(afterFirst)
      }
    })
  })
})
