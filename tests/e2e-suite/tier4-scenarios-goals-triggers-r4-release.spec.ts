import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createHmac } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { isSeq, parseDocument } from 'yaml'
import { getExport, getExportFn, sha256Hex } from './helpers/assertions.ts'
import { runBashCommand, runDshRayInProcess, runNodeScript } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantActions,
  loadAssistantActionsBroker,
  loadAssistantDelivery,
  loadAssistantGoals,
  loadAssistantGoalsStrategy,
  loadAssistantGoalsStrategyRouter,
  loadAssistantPolicy,
  loadAssistantRecovery,
  loadAssistantSkills,
  loadAssistantSkillsDefinition,
  loadAssistantWebOwnerSetup,
  loadBenchmarkIndex,
  loadBenchmarkRunner,
  loadBenchmarkStore,
  loadCredentialsKeychain,
  loadDshRayCli,
  loadDshRayUpgrade,
  loadEventTriggers,
  loadFamiliesCorpus,
  loadLarkChannel,
  loadNativeBenchmark,
  loadOwnerConsole,
  loadPackageModule,
  readAllWorkspaceManifests,
} from './helpers/packages.ts'
import { createIsolatedEnv, createWorkspaceTracker, repoRoot } from './helpers/workspace.ts'
import {
  findPatchRow,
  getPatchConfig,
  parseBashArray,
  parseCordisPatch,
  parseWorkflowYaml,
  readInstallerCommonScript,
} from './helpers/yaml-presets.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

class DeterministicNativeAdapter extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const promptText = options.messages
      .flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text))
      .join('\n')
    const text = promptText.includes('【规划阶段')
      ? 'Step 1: inspect task constraints; Step 2: produce structured JSON output.'
      : JSON.stringify({ answer: 'ok', citations: [] })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function makeTriggerObserver(workspace: string, budgetId = 'obs-budget') {
  return {
    workspace,
    preset: 'primary',
    principalId: 'owner:s9',
    principalRecordId: 'record-s9',
    principalVersion: 1,
    ownerRouteId: 'route-s9',
    expiresAt: Date.now() + 120_000,
    budgetId,
  }
}

async function seedProfileFixture(
  dshHome: string,
  profileName: string,
  opts: { hostVersion?: string; seedHistory?: boolean } = {},
) {
  const profileDir = join(dshHome, 'profiles', profileName)
  const enhancedDir = join(profileDir, 'node_modules', '@dsh-ray', 'assistant-delivery')
  const cacheRoot = join(dshHome, 'host-cache')
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await mkdir(enhancedDir, { recursive: true, mode: 0o700 })
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })

  const hostVersion = opts.hostVersion ?? '0.1.9'
  const hostBindingPath = join(dshHome, '.dsh-ray-host.json')
  await writeFile(
    hostBindingPath,
    JSON.stringify({
      schemaVersion: 1,
      version: hostVersion,
      cacheRoot,
      receiptDigest: sha256Hex(`host-receipt:${hostVersion}`),
    }),
    { mode: 0o600 },
  )
  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: { '@dsh-ray/assistant-delivery': '0.1.83' },
    }),
    { mode: 0o600 },
  )
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', { mode: 0o600 })
  await writeFile(
    join(enhancedDir, 'package.json'),
    JSON.stringify({ name: '@dsh-ray/assistant-delivery', version: '0.1.83' }),
    { mode: 0o600 },
  )
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    [
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      '    ownerRoutes:',
      '      - id: owner-route-1',
      '        principal:',
      '          channel: web',
      '          account: owner',
      '          tenant: local',
      '          user: primary',
    ].join('\n'),
    { mode: 0o600 },
  )
  await writeFile(join(profileDir, '.credentials.yaml'), 'openai: dummy-ref\n', { mode: 0o600 })

  if (opts.seedHistory) {
    const cpDir = join(dshHome, 'plugin-control-plane')
    await mkdir(cpDir, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(join(cpDir, `${profileName}.sqlite`))
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_plans (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS source_creation_verifications (plan_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS source_revision_sources (plan_id TEXT PRIMARY KEY);
        INSERT INTO source_plans (id) VALUES ('plan-c1');
        INSERT INTO source_creation_verifications (plan_id) VALUES ('plan-c1');
        INSERT INTO source_revision_sources (plan_id) VALUES ('plan-r1');
      `)
    } finally {
      db.close()
    }
  }
  return { profileDir, hostBindingPath, hostVersion }
}

function mockUpgradeFetch(targetEnhanced = '0.1.84', targetDsh = '0.2.2-rc.5') {
  return async (url: string | URL) => {
    const str = String(url)
    const latest = str.includes('@dsh-ray') || str.includes('dsh-ray') ? targetEnhanced : targetDsh
    return new Response(JSON.stringify({ 'dist-tags': { latest } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('Tier 4 Real-World Scenarios — S8–S11: Goals/Ablations, Triggers+Compensation, WP17/R4 Upgrade & Release/CI Gate', () => {
  test('T4-S08 (F06, F15, F18): High-difficulty goal failure -> GoalStrategyRuntime routing -> experiment branch -> families-v1 ablation & cost-benefit recovery', async () => {
    const ws = await workspaces.create('t4-s08-')
    const native = await loadNativeBenchmark()
    const corpus = await loadFamiliesCorpus()
    const runnerMod = await loadBenchmarkRunner()
    const { BenchmarkStore } = await loadBenchmarkStore()
    const { benchmarkReport } = await loadBenchmarkIndex()
    const goalsMod = await loadAssistantGoals()
    const strategyMod = await loadAssistantGoalsStrategy()
    const routerMod = await loadAssistantGoalsStrategyRouter()
    const skillsMod = await loadAssistantSkills()

    // 1. Execute families-v1 v2 benchmark with planning & growth ablations (BenchmarkStore.close() in finally)
    const caseId = corpus.familiesDevelopmentCases()[0]!.id
    const planConfig = {
      id: 'plan-t4-s08',
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
        adapterDigest: sha256Hex('adapter-s08'),
        tokenCounterDigest: sha256Hex('counter-s08'),
      },
      budget: { durationMs: 10_000, inputTokens: 100_000, outputTokens: 1_000, costUsdMicros: null, toolCalls: 4 },
      repeats: 2,
      seed: 17,
    }
    const plan = native.nativeBenchmarkPlan(planConfig)
    const store = new (BenchmarkStore as new (path: string) => { close?: () => void })(ws.sqlitePath('bench-s08'))
    let results: ReadonlyArray<{
      cell: { id: string; variantId: string }
      verdict: 'achieved' | 'not-achieved' | 'unknown'
      completedAt: number
    }>
    let report: {
      complete: boolean
      comparisons: readonly { variantId: string }[]
    }
    try {
      const executor = native.createNativeBenchmarkExecutor(planConfig, async () => ({
        adapter: new DeterministicNativeAdapter(),
        inputTokenUpperBound: () => 500,
        dispose: () => {},
      }))
      results = (await runnerMod.runBenchmark(store as never, plan, executor)) as typeof results
      report = benchmarkReport(plan, results as never) as typeof report
      expect(results.length).toBe(8)
      expect(report.complete).toBe(true)
      expect(report.comparisons.length).toBeGreaterThanOrEqual(2)
      expect(report.comparisons.some(c => c.variantId === 'abl-no-planning')).toBe(true)
      expect(report.comparisons.some(c => c.variantId === 'abl-no-growth')).toBe(true)
    } finally {
      store.close?.()
    }

    // 2. Mount AssistantGoalsService with strategy enabled
    const ctx = harness.createContext()
    harness.provideMockService(ctx, 'subagents', {})
    const goalsSvc = await harness.mountService<{ strategyEnabled: boolean }>(ctx, goalsMod.AssistantGoalsService, 'assistantGoals', {
      databasePath: ws.sqlitePath('goals'),
      verifyNativeRounds: true,
      executionBudget: {
        mode: 'calls',
        modelCalls: 10,
        toolCalls: 10,
        durationMs: 30_000,
        maxOutputTokensPerCall: 1024,
        routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      },
      strategy: { maxDurationMs: 5_000, maxRunsPerGoal: 4 },
    })
    expect(goalsSvc.strategyEnabled).toBe(true)

    const recommend = getExportFn<(input: Record<string, unknown>) => {
      difficulty: string
      failureType: string
      selectedStrategy: string
    }>(routerMod, 'recommendGoalStrategy')
    const optimize = getExportFn<(input: Record<string, unknown>) => {
      selectedStrategy: string
    }>(routerMod, 'optimizeStrategyDecision')
    const isForbidden = getExportFn<(tool: string) => boolean>(routerMod, 'isForbiddenStrategyTool')
    const isWrite = getExportFn<(tool: string) => boolean>(routerMod, 'isWriteMutationTool')

    expect(isForbidden('goal_create')).toBe(true)
    expect(isWrite('write_file')).toBe(true)

    const budget = {
      limits: {
        mode: 'calls',
        routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
        modelCalls: 10,
        toolCalls: 10,
        inputTokens: null,
        outputTokens: null,
        costUsdMicros: null,
        expiresAt: Date.now() + 60_000,
      },
      modelCalls: 1,
      toolCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
      heldCalls: 0,
    }
    const baseRecord = {
      id: 'goal-s08',
      scope: { principalId: 'owner', principalRecordId: 'owner-rec', principalVersion: 1, workspace: ws.workspace, preset: 'primary' },
      originalObjective: `Solve ${caseId}`,
      definition: { version: 1, digest: sha256Hex('s08'), objective: `Solve ${caseId}` },
      native: { sessionId: 'sess-s08', goalId: 'ng-s08', revision: 1, objective: `Solve ${caseId}`, phase: 'active', roundsStarted: 1, maxGoalRounds: 4, updatedAt: 1_000 },
      checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: ['dep-1'] },
      version: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
    }

    // Trivial goal -> 'direct'
    const trivialRoute = recommend({
      record: { ...baseRecord, originalObjective: 'Echo status', definition: { version: 1, digest: sha256Hex('triv'), objective: 'Echo status' }, checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] } },
      budget,
      availableTools: ['read'],
      now: 5_000,
    })
    expect(trivialRoute.difficulty).toBe('trivial')
    expect(trivialRoute.selectedStrategy).toBe('direct')

    // Tool-failure -> 'experiment' & validateGoalStrategyInput
    const toolFailureRoute = recommend({
      record: baseRecord,
      budget,
      availableTools: ['read', 'grep', 'isolation_run'],
      recentToolOutcomes: [{ name: 'isolation_run', isError: true }],
      now: 5_000,
    })
    expect(toolFailureRoute.failureType).toBe('tool-failure')
    expect(toolFailureRoute.selectedStrategy).toBe('experiment')
    const validatedExp = strategyMod.validateGoalStrategyInput({
      kind: 'experiment',
      question: 'Probe isolated test runner exit code',
      tools: ['read', 'grep'],
    } as never) as unknown as Record<string, unknown>
    expect(validatedExp.kind).toBe('experiment')

    // Reasoning-failure -> 'review' or 'compare'
    const reasoningFailureRoute = recommend({
      record: baseRecord,
      budget,
      availableTools: ['read', 'grep'],
      feedback: {
        protocol: 'assistant-goals/feedback/v1',
        goalId: 'goal-s08',
        goalOutcome: 'unverified',
        definition: { version: 1, digest: sha256Hex('s08'), objective: { excerpt: `Solve ${caseId}`, truncated: false } },
        verification: {
          current: {
            runId: 'run-s08-1',
            definitionVersion: 1,
            status: 'not-achieved',
            execution: { status: 'succeeded', quiescent: true, completedAt: 4_000, executionRef: 'run-s08-1' },
            criteria: [{
              id: 'c1',
              status: 'failed',
              reason: 'citation mismatch',
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
      now: 5_000,
    })
    expect(reasoningFailureRoute.failureType).toBe('reasoning-failure')
    expect(['review', 'compare']).toContain(reasoningFailureRoute.selectedStrategy)

    // Negative telemetry suppresses branch back to 'direct'
    const zeroStat = { total: 0, succeeded: 0, failedOrUnknown: 0, avgDurationMs: 0, avgModelCalls: 0, avgToolCalls: 0 }
    const suppressed = optimize({
      difficulty: 'moderate',
      difficultyScore: 2,
      difficultySignals: [`case:${caseId}`],
      failureType: 'tool-failure',
      failureSignals: ['tool:isolation_run:error'],
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
      experiment: { enabled: true, allowedTools: ['read', 'grep'], maxToolCalls: 4, maxModelCalls: 2, workspaceWriteAllowed: false },
      subagent: { enabled: false, allowedTools: [], maxToolCalls: 0, maxModelCalls: 1, workspaceWriteAllowed: false },
      availableTools: ['read', 'grep'],
      costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
      maxStrategyDurationMs: 30_000,
      now: 5_000,
    })
    expect(suppressed.selectedStrategy).toBe('direct')

    // Confirm real workflow skill templates align
    const listTemplates = getExportFn<() => readonly { name: string; workflowFamily: string }[]>(skillsMod, 'listWorkflowSkillTemplates')
    const templates = listTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(4)
    expect(templates.some(t => t.workflowFamily === 'repo-ci-fix')).toBe(true)
  }, 15_000)

  test('T4-S09 (F16, F17, F18): Event trigger (rolling lark-calendar / HMAC webhook) -> multi-step skill failure -> CompensationRegistry undo & SQLite restart persistence', async () => {
    const ws = await workspaces.create('t4-s09-')
    const triggersMod = await loadEventTriggers()
    const { EVENT_OBSERVER_EXECUTOR } = (await loadPackageModule('event-triggers/observer')) as { EVENT_OBSERVER_EXECUTOR: string }
    const intakeMod = (await loadPackageModule('event-triggers/intake')) as {
      buildEventIntakeObservation: (input: Record<string, unknown>) => Record<string, unknown>
      toWorkItemIntakeInput: (obs: Record<string, unknown>) => Record<string, unknown>
    }
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantAutomationsService } = (await loadPackageModule('assistant-automations')) as { AssistantAutomationsService: unknown }
    const { CredentialsKeychainService } = await loadCredentialsKeychain()
    const { AssistantActionsService } = await loadAssistantActions()
    const brokerMod = await loadAssistantActionsBroker()
    const recMod = await loadAssistantRecovery()
    const skillsMod = await loadAssistantSkills()
    const skillsDef = await loadAssistantSkillsDefinition()

    // 1. Default pollerEnabled + task-system / calendar / email trigger config + workflow templates
    const defaultCfg = triggersMod.normalizeEventTriggersConfig({
      databasePath: ws.sqlitePath('events-def'),
      allowedHttpOrigins: ['https://tasks.example.test', 'https://cal.example.test', 'https://mail.example.test'],
      triggers: [
        { id: 't-task', kind: 'task-system', automationId: 'auto-t', url: 'https://tasks.example.test/items', itemsPointer: '/items', observer: makeTriggerObserver(ws.workspace) } as never,
        { id: 't-cal', kind: 'calendar', automationId: 'auto-c', url: 'https://cal.example.test/team.ics', format: 'ics', observer: makeTriggerObserver(ws.workspace) } as never,
        { id: 't-mail', kind: 'email', automationId: 'auto-m', url: 'https://mail.example.test/jmap', protocol: 'jmap', accountId: 'acc-1', observer: makeTriggerObserver(ws.workspace) } as never,
      ],
    })
    expect(defaultCfg.pollerEnabled).toBe(true)
    expect(defaultCfg.triggers.length).toBe(3)

    const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(skillsMod, 'listWorkflowSkillTemplates')
    const assertProto = getExportFn<(def: Record<string, unknown>) => void>(skillsDef, 'assertDefinitionProtocol')
    const directive = getExportFn<(kind: string) => { executeCompensation: boolean }>(skillsDef, 'compensationDirective')
    const templates = listTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(4)
    for (const tpl of templates) {
      expect(() => assertProto({
        preconditions: tpl.preconditions,
        compensation: tpl.compensation,
        steps: tpl.steps ?? [{ id: 's1', toolName: 'read', arguments: {}, dependsOn: [] }],
      })).not.toThrow()
      expect(directive(String(tpl.compensation)).executeCompensation).toBe(true)
    }

    // 2. Loopback HTTP server simulating external calendar/event API forward POST + undo DELETE
    let postCalls = 0
    let deleteCalls = 0
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/events') {
        postCalls += 1
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'evt-ext-1' }))
        return
      }
      if (req.method === 'DELETE' && req.url === '/v1/events/evt-ext-1') {
        deleteCalls += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ deleted: true }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const httpPort = (server.address() as { port: number }).port

    try {
      const windows: Array<{ startTime: number; endTime: number }> = []
      let fakeNowSec = 1_700_000_000
      const nowMs = fakeNowSec * 1000
      const compDb = ws.sqlitePath('comp-s9')

      const ctx1 = harness.createContext()
      harness.provideMockService(ctx1, 'tools', { register: () => () => {} })
      harness.provideMockService(ctx1, 'assistantDelivery', {
        validateOwnerRoute: () => ({
          authorityId: 'route-s9',
          authorityHash: sha256Hex('route-s9'),
          receiptVersion: 2,
          principalId: 'owner:s9',
          principalRecordId: 'record-s9',
          principalVersion: 1,
          workspace: ws.workspace,
          agentPreset: 'primary',
          bindingVersion: 1,
          generation: 1,
        }),
        preferencePrincipalForAgent: () => ({
          principalId: 'owner:s9',
          principalLineage: { principalRecordId: 'record-s9', principalVersion: 1 },
          sessionId: 'sess-s9',
          scope: { workspace: ws.workspace, preset: 'primary' },
          bindingId: 'binding-s9',
          bindingVersion: 1,
          bindingGeneration: 1,
        }),
      })
      const agent = { id: 'agent-s9', session: { id: 'sess-s9', header: { cwd: ws.workspace, agentPreset: 'primary' } } }
      harness.provideMockService(ctx1, 'agents', { get: (id: string) => (id === agent.id ? agent : undefined) })
      await harness.mountService(ctx1, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        budgets: [{ id: 'obs-budget', metric: 'requests', limit: 100, periodMs: 60_000, scope: 'subject' }],
        rules: [
          {
            id: 'observer',
            effect: 'allow',
            subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: ws.workspace, principal: 'owner:s9' },
            actions: ['observe', 'reconcile', 'execute'],
            resource: { kind: 'automation', id: '*' },
            context: { initiators: ['background'] },
          },
          {
            id: 'calendar',
            effect: 'allow',
            subject: { kind: 'background', id: 'event-triggers:cal-roll', workspace: ws.workspace, principal: 'owner:s9' },
            actions: ['observe'],
            resource: { kind: 'network', id: 'lark-calendar:cal-1' },
            context: { initiators: ['background'] },
            budget: { id: 'obs-budget', amount: 1 },
          },
          {
            id: 'cred-use',
            effect: 'allow',
            subject: { kind: 'background', id: 'dsh-ray-event-triggers' },
            actions: ['credential.use'],
            resource: { kind: 'credential', id: '*' },
            context: { initiators: ['background'] },
          },
          {
            id: 'ingest-all',
            effect: 'allow',
            subject: { kind: 'external', id: '*', workspace: ws.workspace },
            actions: ['ingest'],
            resource: { kind: 'automation', id: '*' },
            context: { initiators: ['external'] },
          },
          {
            id: 'accept-wh',
            effect: 'allow',
            subject: { kind: 'external', id: 'webhook:wh-s9' },
            actions: ['accept'],
            resource: { kind: 'automation', id: '*' },
            context: { initiators: ['external'] },
          },
          {
            id: 'agent-exec',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['execute'],
            resource: { kind: 'tool', id: '*' },
            context: { initiators: ['foreground'] },
          },
        ] as never,
      })
      await harness.mountPlugin(ctx1, AssistantAutomationsService, {
        databasePath: ws.sqlitePath('automations'),
        runsPath: join(ws.stateDir, 'runs'),
        schedulerEnabled: false,
        reconcileIntervalMs: 0,
        allowUnbudgetedExecution: true,
      })
      await ctx1.plugin({
        name: 'webhook-creds-s9',
        apply(runtime: unknown) {
          new (CredentialsKeychainService as new (r: unknown, cfg: unknown, opts: unknown) => unknown)(
            runtime,
            {
              databasePath: ws.sqlitePath('credentials'),
              handles: [{
                id: 'cred-wh-s9',
                provider: 'environment',
                environmentName: 'DSH_E2E_WH_S9_SECRET',
                consumers: ['dsh-ray-event-triggers'],
                purposes: ['verify-webhook'],
                maxLeaseMs: 30_000,
              }],
            },
            { env: { DSH_E2E_WH_S9_SECRET: 's9-webhook-secret' } },
          )
        },
      } as never)

      const observer = makeTriggerObserver(ws.workspace, 'obs-budget')
      let trigSvc!: InstanceType<typeof triggersMod.EventTriggersService>
      await ctx1.plugin({
        name: 'dsh-ray-event-triggers',
        apply(runtime: unknown) {
          trigSvc = new triggersMod.EventTriggersService(runtime as never, {
            databasePath: ws.sqlitePath('events'),
            pollerEnabled: false,
            webhookListen: { enabled: true, host: '127.0.0.1', port: 0, basePath: '/hooks' },
            triggers: [
              {
                id: 'wh-s9',
                kind: 'webhook',
                automationId: 'auto-wh',
                credentialHandle: 'cred-wh-s9',
                path: '/meeting',
                observer,
              } as never,
              {
                id: 'cal-roll',
                kind: 'lark-calendar',
                automationId: 'auto-cal',
                calendarId: 'cal-1',
                lookbackSeconds: 300,
                lookaheadSeconds: 3_600,
                windowStepSeconds: 60,
                observer,
              } as never,
            ],
          }, {
            now: () => fakeNowSec * 1000,
            larkCalendarReader: {
              readCalendarEventPage: async (req: { startTime: number; endTime: number }) => {
                windows.push({ startTime: req.startTime, endTime: req.endTime })
                return { items: [], has_more: false }
              },
            },
          })
        },
      } as never)

      const whAddr = await trigSvc.whenWebhookListening()
      const whBody = JSON.stringify({ event: 'meeting-prep', calendarId: 'cal-1' })
      const ts = String(nowMs)
      const nonce = 'nonce-s9-1'
      const sig = `sha256=${createHmac('sha256', 's9-webhook-secret').update(`${ts}\n${nonce}\n${whBody}`).digest('hex')}`
      const whHeaders = {
        'content-type': 'application/json',
        'x-dsh-timestamp': ts,
        'x-dsh-nonce': nonce,
        'x-dsh-signature': sig,
      }
      const whOk = await fetch(`http://${whAddr!.host}:${whAddr!.port}/meeting`, { method: 'POST', headers: whHeaders, body: whBody })
      expect(whOk.status).toBe(202)
      expect((await whOk.json() as { accepted: boolean }).accepted).toBe(true)

      // Negative contrast: replay & invalid HMAC rejected
      const whReplay = await fetch(`http://${whAddr!.host}:${whAddr!.port}/meeting`, { method: 'POST', headers: whHeaders, body: whBody })
      expect(whReplay.status).not.toBe(202)
      const whBadSig = await fetch(`http://${whAddr!.host}:${whAddr!.port}/meeting`, {
        method: 'POST',
        headers: { ...whHeaders, 'x-dsh-nonce': 'nonce-s9-2', 'x-dsh-signature': 'sha256=deadbeef' },
        body: whBody,
      })
      expect(whBadSig.status).not.toBe(202)

      // Rolling lark-calendar window advances with clock
      await trigSvc.pollOnce()
      fakeNowSec += 600
      await trigSvc.pollOnce()
      expect(windows.length).toBe(2)
      expect(windows[1]!.startTime).toBeGreaterThan(windows[0]!.startTime)
      expect(windows[1]!.endTime).toBeGreaterThan(windows[0]!.endTime)

      // Build intake projection from trigger event
      const obs = intakeMod.buildEventIntakeObservation({
        trigger: defaultCfg.triggers[0]!,
        receipt: {
          receiptVersion: 2,
          authorityId: 'route-s9',
          authorityHash: sha256Hex('route-s9'),
          principalId: 'owner:s9',
          principalRecordId: 'record-s9',
          principalVersion: 1,
          workspace: ws.workspace,
          agentPreset: 'primary',
          bindingVersion: 1,
          generation: 1,
        },
        sequence: 1,
        envelope: {
          event: { id: 'cal-evt-s9', occurredAt: nowMs },
          observation: { revision: '1', digest: sha256Hex('meeting-prep') },
        },
        envelopeDigest: sha256Hex('env-s9'),
        text: 'Prepare meeting event and dispatch calendar invite',
      })
      expect(intakeMod.toWorkItemIntakeInput(obs).source).toBe('event-triggers')

      // 3. Execute forward HTTP action via Broker, simulate step-2 failure -> CompensationRegistry undo -> idempotent replay
      const createProj = getExportFn<(grant: Record<string, unknown>) => Record<string, unknown>>(brokerMod, 'createActionGrantProjection')
      const httpProjection = createProj({
        protocol: brokerMod.ACTION_GRANT_PROTOCOL,
        id: 'http-s9',
        revision: 1,
        domain: 'http',
        clientKeyId: 'host-s9',
        owner: {
          principalDigest: sha256Hex('owner:s9'),
          principalRecordId: 'record-s9',
          principalVersion: 1,
          workspace: ws.workspace,
          preset: 'primary',
          bindingId: 'binding-s9',
          bindingVersion: 1,
          bindingGeneration: 1,
        },
        sessionId: 'sess-s9',
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['http'],
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [httpPort],
          allowedMethods: ['POST'],
          allowedPathPrefixes: ['/v1/'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 4_096,
        },
        credentialId: 'none',
        expiresAt: Date.now() + 60_000,
        maxActions: 5,
        maxTotalBytes: 1_048_576,
        maxCostUnits: 5,
        allowedOperations: ['http.request'],
        client: { kind: 'assistant-actions-host', instanceId: 'host-s9', generation: 1 },
        source: { classification: 'internal', provenanceDigest: 'c'.repeat(64) },
        policyEpoch: 1,
        emergencyEpoch: 0,
      })
      const actions = await harness.mountService<{
        executeAction: (agent: unknown, input: Record<string, unknown>, signal: AbortSignal) => Promise<{ status: string; actionId?: string }>
      }>(ctx1, AssistantActionsService, 'assistantActions', {
        stateRoot: join(ws.stateDir, 'actions'),
        actionGrants: [httpProjection as never],
      })
      const comp1 = await harness.mountService<{
        registerCompensator: (h: {
          kind: string
          category: string
          compensate: (input: { record: { target: { externalRef: string } } }) => Promise<{ status: string; resultCode: string }>
        }) => () => void
        executeCompensation: (rec: Record<string, unknown>) => Promise<{ id: string; status: string; replayed: boolean; preimageDigest?: string }>
        listCompensationAudit: (id: string) => readonly unknown[]
      }>(ctx1, recMod.AssistantCompensationService, 'assistantCompensation', { databasePath: compDb })

      comp1.registerCompensator({
        kind: 'http.delete-resource',
        category: 'delete',
        compensate: async ({ record }) => {
          const resp = await fetch(record.target.externalRef, { method: 'DELETE' })
          return { status: resp.ok ? 'succeeded' : 'failed', resultCode: `http-${resp.status}` }
        },
      })
      comp1.registerCompensator({
        kind: 'calendar.cancel-event',
        category: 'cancel',
        compensate: async () => {
          throw new Error('calendar downstream timeout')
        },
      })

      const fwd = await actions.executeAction(agent, {
        grantId: 'http-s9',
        idempotencyKey: 's9-fwd-1',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port: httpPort, path: '/v1/events' },
        payload: { method: 'POST', url: `http://127.0.0.1:${httpPort}/v1/events`, body: '{"title":"meeting"}' },
      }, new AbortController().signal)
      expect(fwd.status).toBe('succeeded')
      expect(postCalls).toBe(1)

      const compInput = {
        forwardActionId: fwd.actionId ?? 's9-fwd-1',
        idempotencyKey: 's9-comp-undo-1',
        kind: 'http.delete-resource',
        target: { externalRef: `http://127.0.0.1:${httpPort}/v1/events/evt-ext-1` },
        preimage: { eventId: 'evt-ext-1' },
      }
      const undo1 = await comp1.executeCompensation(compInput)
      const undo2 = await comp1.executeCompensation(compInput)
      expect(undo1.status).toBe('succeeded')
      expect(undo1.preimageDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(undo2.replayed).toBe(true)
      expect(undo2.id).toBe(undo1.id)
      expect(deleteCalls).toBe(1)

      // Ambiguous timeout failure settles explicitly to 'unknown'
      const unk = await comp1.executeCompensation({
        forwardActionId: 's9-fwd-2',
        idempotencyKey: 's9-comp-unk-1',
        kind: 'calendar.cancel-event',
        target: { externalRef: 'cal-evt-s9' },
      })
      expect(unk.status).toBe('unknown')

      // 4. Restart AssistantCompensationService on same SQLite DB and verify durable audit & status
      await harness.disposeAll()
      const ctx2 = harness.createContext()
      const comp2 = await harness.mountService<{
        getCompensationStatus: (q: { idempotencyKey: string }) => { id: string; status: string } | undefined
        listCompensationAudit: (id: string) => readonly unknown[]
      }>(ctx2, recMod.AssistantCompensationService, 'assistantCompensation', { databasePath: compDb })
      const persisted = comp2.getCompensationStatus({ idempotencyKey: 's9-comp-undo-1' })
      expect(persisted?.id).toBe(undo1.id)
      expect(persisted?.status).toBe('succeeded')
      expect(comp2.listCompensationAudit(undo1.id).length).toBeGreaterThanOrEqual(1)
      expect(comp2.getCompensationStatus({ idempotencyKey: 's9-comp-unk-1' })?.status).toBe('unknown')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 15_000)

  test('T4-S10 (F19, F20, F21): WP17 0.1 -> 0.2 owner upgrade with non-empty history + rollback drill -> dsh-ray CLI & NL Web/Lark enable/disable/upgrade + recovery', async () => {
    const wsFail = await workspaces.create('t4-s10-rb-')
    const { profileDir: rbProfileDir, hostBindingPath: rbHostPath } = await seedProfileFixture(wsFail.dshHome, 'web', {
      hostVersion: '0.2.1-rc.2',
    })
    const upg = await loadDshRayUpgrade()

    // 1. Failed health check during upgrade triggers atomic rollback preserving ownerRoutes & credentials
    const { report: rbReport } = await upg.runUpgrade({
      dshHome: wsFail.dshHome,
      osHome: wsFail.root,
      platform: 'linux',
      profile: 'web',
      action: 'apply',
    } as never, {
      fetch: mockUpgradeFetch() as never,
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: rbHostPath,
        version: '0.2.1-rc.2',
        dshPath: '/usr/local/bin/dsh',
        issues: [],
      }) as never,
      scanProcesses: async () => ({ processes: [] }),
      upgradeHost: async () => {},
      upgradeProfilePackages: async () => {},
      verifyHealth: async () => ({ ok: false, error: 'doctor-failed' }),
    } as never)
    expect(rbReport.ok).toBe(false)
    expect(rbReport.execution?.rolledBack).toBe(true)
    expect(rbReport.execution?.rollbackSucceeded).toBe(true)
    expect(await readFile(join(rbProfileDir, 'cordis.patch.yml'), 'utf8')).toContain('owner-route-1')
    expect(await readFile(join(rbProfileDir, '.credentials.yaml'), 'utf8')).toContain('openai: dummy-ref')

    // 2. Successful 0.1 -> 0.2 owner upgrade with non-empty creation/revision history migration (M5 contract)
    const ws = await workspaces.create('t4-s10-ok-')
    const { profileDir, hostBindingPath } = await seedProfileFixture(ws.dshHome, 'web', { hostVersion: '0.1.9', seedHistory: true })
    const { report: okReport } = await upg.runUpgrade({
      dshHome: ws.dshHome,
      osHome: ws.root,
      platform: 'linux',
      profile: 'web',
      action: 'apply',
      dshVersion: '0.2.2-rc.5',
      allowNonEmptyHistoryMigration: true,
    } as never, {
      fetch: mockUpgradeFetch() as never,
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: hostBindingPath,
        version: '0.1.9',
        dshPath: '/usr/local/bin/dsh',
        issues: [],
      }) as never,
      scanProcesses: async () => ({ processes: [] }),
      upgradeHost: async () => {},
      upgradeProfilePackages: async () => {},
      verifyHealth: async () => ({ ok: true }),
    } as never)
    expect(okReport.ok).toBe(true)
    expect(okReport.readiness.ledgersOk).toBe(true)
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('owner-route-1')
    expect(await readFile(join(profileDir, '.credentials.yaml'), 'utf8')).toContain('openai: dummy-ref')

    // Verify seeded non-empty SQLite history survived migration intact
    const histDb = new DatabaseSync(join(ws.dshHome, 'plugin-control-plane', 'web.sqlite'), { readOnly: true })
    try {
      expect((histDb.prepare('SELECT COUNT(*) AS n FROM source_plans').get() as { n: number }).n).toBe(1)
      expect((histDb.prepare('SELECT COUNT(*) AS n FROM source_creation_verifications').get() as { n: number }).n).toBe(1)
      expect((histDb.prepare('SELECT COUNT(*) AS n FROM source_revision_sources').get() as { n: number }).n).toBe(1)
    } finally {
      histDb.close()
    }

    // 3. R4 CLI (dsh-ray disable / enable) + upgradeAssistantAndRecover + NL Web/Lark controls (M5 contracts)
    const cliMod = await loadDshRayCli()
    const deliveryMod = await loadAssistantDelivery()
    const larkMod = await loadLarkChannel()
    const ownerMod = await loadOwnerConsole()
    const setupMod = await loadAssistantWebOwnerSetup()
    expect(larkMod.LarkChannelService).toBeDefined()

    // Prepare web profile patch with R3 plugins
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
    const effective = [
      bundleSnippets.join('\n'),
      '- id: dsh-ray-assistant-goals',
      '  name: "@dsh-ray/assistant-goals"',
      '- id: dsh-ray-assistant-web-owner',
      '  name: "@dsh-ray/assistant-web-owner"',
      '- id: dsh-ray-assistant-association',
      '  name: "@dsh-ray/assistant-association"',
      '- id: dsh-ray-assistant-work-items',
      '  name: "@dsh-ray/assistant-work-items"',
      '  config:',
      '    enabled: true',
    ].join('\n')
    const prepare = getExportFn<(input: Record<string, unknown>, source: string, eff: string) => { patch: string }>(
      setupMod,
      'prepareWebOwnerProfile',
    )
    const prepared = prepare({ dshHome: ws.dshHome, profile: 'web', workspace: ws.workspace, preset: 'primary' }, '[]\n', effective)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    await writeFile(patchPath, prepared.patch, 'utf8')

    // Assert M5 exports cleanly before calling
    expect((cliMod as Record<string, unknown>).upgradeAssistantAndRecover).toBeTypeOf('function')
    expect((deliveryMod as Record<string, unknown>).parseOwnerSelfIterationCommand).toBeTypeOf('function')
    expect((ownerMod as Record<string, unknown>).handleOwnerConsoleControlAction).toBeTypeOf('function')

    const assertPatchToggled = async (expectedState: 'disabled' | 'enabled') => {
      const parsed = parseCordisPatch(await readFile(patchPath, 'utf8'))
      const workItemsRow = findPatchRow(parsed.document, 'dsh-ray-assistant-work-items')
      const webOwnerRow = findPatchRow(parsed.document, 'dsh-ray-assistant-web-owner')
      expect(workItemsRow).toBeDefined()
      if (expectedState === 'disabled') {
        expect(workItemsRow?.get('disabled') === true || getPatchConfig(workItemsRow).enabled === false).toBe(true)
      } else {
        expect(workItemsRow?.get('disabled') !== true && getPatchConfig(workItemsRow).enabled !== false).toBe(true)
      }
      expect(webOwnerRow).toBeDefined()
      expect(webOwnerRow?.get('disabled') !== true && getPatchConfig(webOwnerRow).enabled !== false).toBe(true)
    }
    await assertPatchToggled('enabled')

    const disCli = await runDshRayInProcess(['disable', '--profile', 'web', '--dsh-home', ws.dshHome, '--json'])
    expect(disCli.exitCode).toBe(0)
    const disCliJson = JSON.parse(disCli.stdout) as { ok?: boolean; state?: string; status?: string }
    expect(disCliJson.ok).toBe(true)
    expect(disCliJson.state ?? disCliJson.status).toBe('disabled')
    await assertPatchToggled('disabled')

    const enCli = await runDshRayInProcess(['enable', '--profile', 'web', '--dsh-home', ws.dshHome, '--json'])
    expect(enCli.exitCode).toBe(0)
    const enCliJson = JSON.parse(enCli.stdout) as { ok?: boolean; state?: string; status?: string }
    expect(enCliJson.ok).toBe(true)
    expect(enCliJson.state ?? enCliJson.status).toBe('enabled')
    await assertPatchToggled('enabled')

    const parseNl = getExportFn<(text: string) => { action: string } | undefined>(deliveryMod, 'parseOwnerSelfIterationCommand')
    const cmdDisable = parseNl('关闭自迭代')
    const cmdEnable = parseNl('开启自迭代')
    const cmdUpgrade = parseNl('升级整体助手')
    expect(cmdDisable?.action).toBe('disableSelfIteration')
    expect(cmdEnable?.action).toBe('enableSelfIteration')
    expect(cmdUpgrade?.action).toBe('upgradeAssistantAndRecover')

    const ctx = harness.createContext()
    harness.provideMockService(ctx, 'typert', { register: () => {} })
    const handleControl = getExportFn<(ctx: unknown, req: Record<string, unknown>) => Promise<Record<string, unknown>>>(
      ownerMod,
      'handleOwnerConsoleControlAction',
    )

    const patchSnapshot = await readFile(patchPath, 'utf8')
    const unauthorized = await handleControl(ctx, { dshHome: ws.dshHome, ownerAuthorized: false, action: cmdDisable!.action })
    expect(unauthorized.ok).toBe(false)
    expect(await readFile(patchPath, 'utf8')).toBe(patchSnapshot)

    const resDis = await handleControl(ctx, { dshHome: ws.dshHome, ownerAuthorized: true, action: cmdDisable!.action })
    expect(resDis.ok).toBe(true)
    expect(resDis.state).toBe('disabled')
    await assertPatchToggled('disabled')

    const resEn = await handleControl(ctx, { dshHome: ws.dshHome, ownerAuthorized: true, action: cmdEnable!.action })
    expect(resEn.ok).toBe(true)
    expect(resEn.state).toBe('enabled')
    await assertPatchToggled('enabled')

    const upgradeAndRecover = getExportFn<(opts: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<Record<string, unknown>>>(
      cliMod,
      'upgradeAssistantAndRecover',
    )
    const steps: string[] = []
    const recovered = await upgradeAndRecover({ dshHome: ws.dshHome, profile: 'web', yes: true }, {
      runUpgrade: async () => {
        steps.push('upgrade')
        return { ok: true, ready: true }
      },
      runDoctor: async () => {
        steps.push('doctor')
        return { ok: true, ready: true }
      },
      restartService: async () => {
        steps.push('restart')
        return { ok: true, restarted: true }
      },
    })
    expect(recovered.ok).toBe(true)
    expect(recovered.healthy).toBe(true)
    expect(steps).toEqual(['upgrade', 'doctor', 'restart'])

    // 4. Verify standard install queues (web/supervised/lark) include assistant-association
    for (const scenario of ['web', 'supervised', 'lark'] as const) {
      const envWs = await workspaces.create(`t4-s10-${scenario}-`)
      const env = await createIsolatedEnv(envWs)
      const res = await runBashCommand(
        [join(repoRoot, 'scripts/install/install-local.sh'), '--dry-run', '--scenario', scenario, '--yes'],
        { env },
      )
      expect(res.exitCode).toBe(0)
      expect(res.stdout + res.stderr).toContain('assistant-association')
    }
  }, 15_000)

  test('T4-S11 (F22, F23): Release pipeline gate simulation: 40-package manifest check + verify-npm-release.mjs mock registry + CI cross-platform DAG parity', async () => {
    const manifests = await readAllWorkspaceManifests()
    expect(manifests.length).toBe(40)
    expect(manifests.filter(m => m.kind === 'package').length).toBe(4)
    expect(manifests.filter(m => m.kind === 'plugin').length).toBe(36)
    const targetVersion = manifests[0]!.version
    expect(new Set(manifests.map(m => m.version)).size).toBe(1)
    for (const manifest of manifests) {
      expect(manifest.publishConfig?.access).toBe('public')
    }

    // 1. Validate release.yml 40-package npm readback gate sits strictly before record
    const releaseWf = await parseWorkflowYaml<{
      jobs: Record<string, { needs?: string | string[]; steps?: Array<{ run?: string }> }>
    }>('.github/workflows/release.yml')
    expect(releaseWf.jobs['verify-npm']).toBeDefined()
    const recordNeeds = Array.isArray(releaseWf.jobs.record?.needs) ? releaseWf.jobs.record?.needs : [releaseWf.jobs.record?.needs]
    expect(recordNeeds).toContain('verify-npm')
    const releaseRaw = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    expect(releaseRaw).toContain('verify-npm-release.mjs')

    // 2. Validate ci.yml cross-platform matrix (Linux / macOS / Windows) & verify fan-in
    const ciWf = await parseWorkflowYaml<{
      on?: Record<string, unknown>
      jobs: Record<string, { 'runs-on'?: string; needs?: string[]; steps?: Array<{ run?: string }> }>
    }>('.github/workflows/ci.yml')
    const runners = Object.values(ciWf.jobs).map(j => String(j['runs-on'] ?? ''))
    expect(runners.some(r => r.includes('ubuntu'))).toBe(true)
    expect(runners.some(r => r.includes('macos'))).toBe(true)
    expect(runners.some(r => r.includes('windows'))).toBe(true)
    const verifyNeeds = new Set(ciWf.jobs.verify?.needs ?? [])
    for (const jobName of Object.keys(ciWf.jobs).filter(k => k !== 'verify')) {
      expect(verifyNeeds.has(jobName)).toBe(true)
    }
    const xplatCommands = Object.values(ciWf.jobs)
      .filter(j => String(j['runs-on'] ?? '').includes('macos') || String(j['runs-on'] ?? '').includes('windows'))
      .flatMap(j => (j.steps ?? []).map(s => s.run ?? ''))
      .join('\n')
    for (const slug of ['dsh-ray', 'assistant-isolation', 'assistant-actions']) {
      expect(xplatCommands).toContain(slug)
    }

    // Check common.sh installer arrays map to real workspace plugin slugs
    const script = await readInstallerCommonScript()
    const pluginSlugs = new Set(manifests.filter(m => m.kind === 'plugin').map(m => m.slug))
    const queuedSlugs = [
      ...parseBashArray(script, 'DSH_RAY_CORE_PLUGIN_SLUGS'),
      ...parseBashArray(script, 'DSH_RAY_LARK_PLUGIN_SLUGS'),
      ...parseBashArray(script, 'DSH_RAY_SUPERVISED_GROWTH_PLUGIN_SLUGS'),
    ]
    expect(queuedSlugs.filter(slug => !pluginSlugs.has(slug))).toEqual([])

    // 3. Drive live scripts/verify-npm-release.mjs against loopback mock npm registry
    let missingPackage: string | undefined
    let stalePackage: string | undefined
    const staleVersion = targetVersion === '0.1.83' ? '0.1.82' : '0.1.83'
    const server = createServer((req, res) => {
      const pkgName = decodeURIComponent((req.url ?? '/').slice(1))
      if (pkgName === missingPackage || !manifests.some(m => m.name === pkgName)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const servedVersion = pkgName === stalePackage ? staleVersion : targetVersion
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        name: pkgName,
        'dist-tags': { latest: servedVersion },
        versions: {
          [servedVersion]: { name: pkgName, version: servedVersion, dist: { tarball: 'http://127.0.0.1/dummy.tgz' } },
        },
      }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      // 40/40 matching targetVersion -> exit 0
      const okRes = await runNodeScript('scripts/verify-npm-release.mjs', [
        '--tag',
        `v${targetVersion}`,
        '--registry',
        `http://127.0.0.1:${port}`,
        '--retries',
        '0',
      ])
      expect(okRes.exitCode).toBe(0)

      // 1 of 40 returning 404 -> non-zero exit naming missing package
      missingPackage = '@dsh-ray/assistant-association'
      const missRes = await runNodeScript('scripts/verify-npm-release.mjs', [
        '--tag',
        `v${targetVersion}`,
        '--registry',
        `http://127.0.0.1:${port}`,
        '--retries',
        '0',
      ])
      expect(missRes.exitCode).not.toBe(0)
      expect(missRes.stdout + missRes.stderr).toContain(missingPackage)
      missingPackage = undefined

      // 1 of 40 returning stale version -> non-zero exit naming stale package
      stalePackage = 'dsh-ray'
      const staleRes = await runNodeScript('scripts/verify-npm-release.mjs', [
        '--tag',
        `v${targetVersion}`,
        '--registry',
        `http://127.0.0.1:${port}`,
        '--retries',
        '0',
      ])
      expect(staleRes.exitCode).not.toBe(0)
      expect(staleRes.stdout + staleRes.stderr).toContain(stalePackage)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('T4-S12 (F26, F21, F19, F12–F14): Full lifecycle CLI -> Web OwnerConsole -> Feishu LarkChannel + standalone fallback with 0 LLM calls & 0 SQLite sidecars', async () => {
    const ws = await workspaces.create('t4-s12-')
    const manifests = await readAllWorkspaceManifests()
    const expectedVersion = manifests[0]!.version
    const cliMod = await loadDshRayCli()
    const ownerMod = await loadOwnerConsole()
    const deliveryMod = await loadAssistantDelivery()
    const larkMod = await loadLarkChannel()
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const typertMod = await loadPackageModule('owner-console/typert')
    const nlMod = await loadPackageModule('owner-console/nl-control')
    const normalizeMod = await loadPackageModule('lark-channel/normalize')
    const ReportSchema = getExport<{ parse: (input: unknown) => unknown }>(typertMod, 'OwnerConsoleVersionReportSchema')
    const TYPERT = getExport<{ invocations: Array<{ method: string }> }>(typertMod, 'TYPERT')
    const parseWebVersionQuery = getExportFn<(text: string) => { intent: string } | undefined>(nlMod, 'parseOwnerVersionQuery')
    const normalizeLarkMessage = getExportFn<(
      cfg: Record<string, unknown>,
      msg: Record<string, unknown>,
      now: number,
    ) => { outcome: string; envelope?: Record<string, unknown> }>(normalizeMod, 'normalizeLarkMessage')

    // Phase 1: Absent DSH_HOME -> no-data
    const emptyHome = join(ws.root, 'empty-home')
    const emptyCli = await runDshRayInProcess(['version', '--json', '--dsh-home', emptyHome], { DSH_HOME: emptyHome })
    expect(emptyCli.exitCode).toBe(0)
    const emptyJson = JSON.parse(emptyCli.stdout) as {
      assistant: { version: string }
      plugins: { state: string }
      selfIteration: { dataState: string; totalIterations: number | null }
    }
    expect(emptyJson.assistant.version).toBe(expectedVersion)
    expect(emptyJson.plugins.state).toBe('unavailable')
    expect(emptyJson.selfIteration.dataState).toBe('no-data')
    expect(emptyJson.selfIteration.totalIterations).toBeNull()

    // Phase 2: Execute upgradeAssistantAndRecover & seed R3 + WP16 evolved plugin creation/revision + ledgers
    const upgradeAndRecover = getExportFn<(opts: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<{ ok: boolean; healthy?: boolean }>>(
      cliMod,
      'upgradeAssistantAndRecover',
    )
    const upgRes = await upgradeAndRecover({ dshHome: ws.dshHome, profile: 'lark', yes: true }, {
      runUpgrade: async () => ({ ok: true, ready: true }),
      runDoctor: async () => ({ ok: true, ready: true }),
      restartService: async () => ({ ok: true, restarted: true }),
    })
    expect(upgRes.ok).toBe(true)
    expect(upgRes.healthy).toBe(true)

    const profileDir = join(ws.dshHome, 'profiles', 'lark')
    await mkdir(join(profileDir, 'node_modules', '@dsh-ray', 'assistant-delivery'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(profileDir, 'node_modules', '@dsh-ray', 'assistant-delivery', 'package.json'),
      JSON.stringify({ name: '@dsh-ray/assistant-delivery', version: expectedVersion }),
      'utf8',
    )
    await writeFile(
      join(ws.dshHome, '.dsh-ray-host.json'),
      JSON.stringify({ schemaVersion: 1, version: '0.2.2-rc.5', cacheRoot: ws.root, receiptDigest: sha256Hex('host-s12') }),
      { mode: 0o600 },
    )
    await mkdir(join(ws.dshHome, '.dsh-ray'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(ws.dshHome, '.dsh-ray', 'upgrade-history.jsonl'),
      `${JSON.stringify({ at: 100, toVersion: expectedVersion })}\n`,
      'utf8',
    )
    await mkdir(join(ws.dshHome, '.dsh-ray-upgrade-backups', 'snap-s12'), { recursive: true, mode: 0o700 })

    const execSql = async (rel: string, sql: string) => {
      const full = join(ws.dshHome, rel)
      await mkdir(join(full, '..'), { recursive: true, mode: 0o700 })
      const db = new DatabaseSync(full)
      try {
        db.exec(sql)
      } finally {
        db.close()
      }
    }
    await execSql('assistant-work-items/state.sqlite', "PRAGMA journal_mode = WAL; CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT) STRICT; INSERT INTO work_item VALUES ('w1', 'settled'), ('w2', 'settled');")
    await execSql('assistant-dreaming/state.sqlite', "CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT) STRICT; INSERT INTO dream_runs VALUES ('d1', 'completed');")
    await execSql('assistant-evaluation/evaluation.sqlite', "CREATE TABLE evaluation_attention_tuning_events (kind TEXT) STRICT; CREATE TABLE evaluation_attention_loosening_decisions (proposal_id TEXT PRIMARY KEY, decision TEXT) STRICT; INSERT INTO evaluation_attention_tuning_events VALUES ('adopted'); INSERT INTO evaluation_attention_loosening_decisions VALUES ('lp1', 'adopted');")
    await execSql('assistant-association/association.sqlite', "CREATE TABLE assoc_param_profile_heads (scope_key TEXT PRIMARY KEY, active_version INTEGER) STRICT; CREATE TABLE assoc_param_profile_events (kind TEXT) STRICT; INSERT INTO assoc_param_profile_heads VALUES ('owner', 3); INSERT INTO assoc_param_profile_events VALUES ('adopted');")
    await execSql('plugin-control-plane/control.sqlite', "CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT, mode TEXT, status TEXT) STRICT; CREATE TABLE activation_plans (id TEXT PRIMARY KEY, profile TEXT, status TEXT) STRICT; INSERT INTO source_plans VALUES ('sp-c', '@dsh-ray/evolved-s12', 'create', 'release-complete'), ('sp-r', '@dsh-ray/evolved-s12', 'modify', 'release-complete'); INSERT INTO activation_plans VALUES ('sp-c', 'lark', 'activated');")
    await execSql('plugin-control-plane/creation-adoptions.sqlite', `CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, certificate_json TEXT, receipt_json TEXT) STRICT; INSERT INTO adoptions VALUES ('sp-c', 'active', '{"plan":{"name":"@dsh-ray/evolved-s12"}}', '{"version":"0.1.0"}');`)
    await execSql('plugin-control-plane/revision-adoptions.sqlite', "CREATE TABLE entries (entry_id TEXT PRIMARY KEY, name TEXT, current_plan_id TEXT, revision INTEGER) STRICT; CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, entry_id TEXT) STRICT; CREATE TABLE rollbacks (seq INTEGER PRIMARY KEY, rollback_id TEXT) STRICT; INSERT INTO entries VALUES ('e1', '@dsh-ray/evolved-s12', 'sp-r', 2); INSERT INTO adoptions VALUES ('sp-r', 'active', 'e1');")

    const wiDir = join(ws.dshHome, 'assistant-work-items')
    const wiFilesBefore = (await readdir(wiDir)).sort()
    await chmod(wiDir, 0o555)
    try {
      // CLI checks
      expect((await runDshRayInProcess(['--version'])).stdout.trim()).toBe(expectedVersion)
      expect((await runDshRayInProcess(['version', '--short'])).stdout.trim()).toBe(expectedVersion)
      const cliFull = await runDshRayInProcess(['version', '--json', '--dsh-home', ws.dshHome])
      expect(cliFull.exitCode).toBe(0)
      const cliReport = JSON.parse(cliFull.stdout) as {
        assistant: { version: string }
        plugins: { evolvedCount: number }
        selfIteration: { dataState: string; totalIterations: number; pluginsCreated: number; pluginsRevised: number; selfUpgrades: number }
      }
      expect(ReportSchema.parse(cliReport)).toEqual(cliReport)
      expect(cliReport.selfIteration.dataState).toBe('data')
      expect(cliReport.selfIteration.pluginsCreated).toBe(1)
      expect(cliReport.selfIteration.pluginsRevised).toBe(1)
      expect(cliReport.selfIteration.selfUpgrades).toBe(1)
      expect(cliReport.plugins.evolvedCount).toBe(1)

      // Phase 3 & 4: Web OwnerConsole + Feishu LarkChannel/AssistantDelivery live delegation -> standalone fallback
      const ctx = harness.createContext()
      await harness.mountPlugin(ctx, TypertRegistry)
      harness.provideMockService(ctx, 'profileContext', { home: ws.dshHome, dir: profileDir, name: 'lark' })
      const registeredTools: Array<{
        def: { name: string; execute: (args: unknown, exec: unknown) => Promise<{ ok: boolean; summary?: string; report?: unknown }> }
      }> = []
      harness.provideMockService(ctx, 'tools', {
        register: (def: typeof registeredTools[number]['def']) => {
          registeredTools.push({ def })
          return () => {}
        },
      })
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        rules: [
          { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
          { id: 'owner', effect: 'allow', subject: { kind: 'external', id: 'lark/primary-bot/tenant-a/ou_owner' }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
          { id: 'reply-owner', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'lark/primary-bot/tenant-a/ou_owner' }, actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground', 'external'] } },
        ],
      })
      const resumeSpy = vi.fn(async () => ({}))
      harness.provideMockService(ctx, 'agents', {
        create: async (opts: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; setup?: (c: unknown, a?: unknown) => Promise<unknown> }) => {
          const id = opts.sessionId
          const session = {
            id,
            header: { id, cwd: opts.meta?.cwd ?? ws.workspace, agentPreset: opts.meta?.agentPreset ?? 'primary' },
            append: () => {},
            snapshotEvents: () => [],
            deriveMessages: () => [],
          }
          const agent = {
            id,
            ctx,
            session,
            model: { select: () => {}, current: () => ({ provider: 'fixture', model: 'fixture' }) },
            status: 'idle',
            whenIdle: async () => {},
            runMaintenance: (fn: (signal: AbortSignal) => unknown) => fn(new AbortController().signal),
            cancel: () => {},
          }
          await opts.setup?.(ctx, agent)
          return { agent, dispose: async () => {} }
        },
        resume: resumeSpy,
      })
      harness.provideMockService(ctx, 'sessions', { list: async () => [], flush: async () => true })
      harness.provideMockService(ctx, 'llm', { complete: async () => ({}) })

      const applyOwner = getExportFn<(c: unknown, cfg: unknown) => void>(ownerMod, 'apply')
      const configOwner = getExportFn<(input: Record<string, unknown>) => unknown>(ownerMod, 'Config')
      applyOwner(ctx, configOwner({ feishuAppId: '' }))
      const ownerSvc = ctx.get('ownerConsole' as never) as unknown as {
        versionInfo: () => Promise<{
          assistant: { version: string }
          plugins: { evolvedCount: number }
          selfIteration: { dataState: string; totalIterations: number; pluginsCreated: number; pluginsRevised: number; selfUpgrades: number }
        }>
        registerAssistantSession: (id: string, active: boolean) => Promise<unknown>
      }
      expect(TYPERT.invocations.some(i => i.method === 'versionInfo')).toBe(true)
      expect(parseWebVersionQuery('/version --short')?.intent).toBe('slash')
      expect(parseWebVersionQuery('自己迭代了多少次？')?.intent).toBe('selfIterationCount')

      await ownerSvc.registerAssistantSession('wenyao-s12', true)
      const versionTool = registeredTools.find(t => t.def.name === 'owner_console_version_info')!
      const toolRes = await versionTool.def.execute({}, { agent: { id: 'wenyao-s12', session: { id: 'wenyao-s12' } } })
      expect(toolRes.ok).toBe(true)
      expect(ReportSchema.parse(toolRes.report)).toEqual(toolRes.report)

      const ownerReport = await ownerSvc.versionInfo()
      expect(ownerReport.assistant.version).toBe(expectedVersion)
      expect(ownerReport.plugins.evolvedCount).toBe(1)
      expect(ownerReport.selfIteration).toMatchObject({
        dataState: 'data',
        pluginsCreated: cliReport.selfIteration.pluginsCreated,
        pluginsRevised: cliReport.selfIteration.pluginsRevised,
        selfUpgrades: cliReport.selfIteration.selfUpgrades,
      })
      expect(ownerReport.selfIteration.totalIterations).toBeGreaterThan(0)

      const delivery = await harness.mountService<{
        issuePairing: (by: string, p: Record<string, unknown>) => { challenge: { id: string }; code: string }
        confirmPairing: (req: Record<string, unknown>) => unknown
        acceptInbound: (env: Record<string, unknown>) => Promise<unknown>
        tick: () => Promise<void>
        whenIdle: () => Promise<void>
        dispatchVersionQuery: () => Promise<{
          assistant: { version: string }
          plugins: { evolvedCount: number }
          selfIteration: { dataState: string; totalIterations: number | null; pluginsCreated: number | null; pluginsRevised: number | null; selfUpgrades: number | null }
        }>
      }>(ctx, deliveryMod.AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery'),
        spoolPath: join(ws.stateDir, 'spool'),
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'primary',
        schedulerEnabled: false,
      })

      const sends: string[] = []
      const LarkServiceCtor = larkMod.LarkChannelService as new (
        c: unknown,
        cfg: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => { whenReady: () => Promise<void> }
      const larkSvc = new LarkServiceCtor(ctx, {
        enabled: true,
        account: 'primary-bot',
        tenant: 'tenant-a',
        appId: 'cli_0123456789abcdef',
        appSecretEnv: 'LARK_APP_SECRET',
      }, {
        env: { LARK_APP_SECRET: 'secret-value' },
        createTransport: () => ({
          subscribe: () => () => {},
          connect: async () => {},
          disconnect: async () => {},
          addReaction: async () => 'r1',
          createProgress: async () => ({ cotId: 'c1', messageId: 'om_cot' }),
          writeProgress: async () => {},
          send: async (_chatId: string, input: { text?: string }) => {
            sends.push(input.text ?? '')
            return { messageId: `om_out_${sends.length}` }
          },
        }),
        writeLifecycleMarker: () => {},
        dshHome: ws.dshHome,
        profile: 'lark',
      })
      await larkSvc.whenReady()

      const ownerPrincipal = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' }
      const pair = delivery.issuePairing('test', ownerPrincipal)
      delivery.confirmPairing({ challengeId: pair.challenge.id, principal: ownerPrincipal, code: pair.code })

      const inboundCfg = { account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true, maxTextBytes: 4096, staleAfterMs: 300_000 }
      const msg1 = normalizeLarkMessage(inboundCfg, {
        messageId: 'om_s12_1',
        chatId: 'oc_dm_ou_owner',
        chatType: 'p2p',
        senderId: 'ou_owner',
        content: '/version',
        rawContentType: 'text',
        resources: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      }, Date.now())
      if (msg1.outcome === 'accept' && msg1.envelope) await delivery.acceptInbound(msg1.envelope)
      await delivery.tick()
      await delivery.whenIdle()
      await delivery.tick()
      await delivery.whenIdle()

      expect(sends.at(-1)).toContain(expectedVersion)
      expect(sends.at(-1)).toContain(`累计自迭代次数：${ownerReport.selfIteration.totalIterations}`)
      expect(sends.at(-1)).toContain('@dsh-ray/evolved-s12')

      // Remove ownerConsole service and verify standalone fallback via Delivery
      ctx.set('ownerConsole' as never, undefined as never)
      const fallbackReport = await delivery.dispatchVersionQuery()
      expect(fallbackReport.assistant.version).toBe(expectedVersion)
      expect(fallbackReport.plugins.evolvedCount).toBe(1)
      expect(fallbackReport.selfIteration).toMatchObject({
        dataState: 'data',
        pluginsCreated: 1,
        pluginsRevised: 1,
        selfUpgrades: 1,
      })
      expect(fallbackReport.selfIteration.totalIterations).toBeGreaterThan(0)

      expect(resumeSpy).not.toHaveBeenCalled()
    } finally {
      await chmod(wiDir, 0o700)
    }
    const wiFilesAfter = (await readdir(wiDir)).sort()
    expect(wiFilesAfter).toEqual(wiFilesBefore)
  })
})
