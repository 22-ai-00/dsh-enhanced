import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createHmac } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { isSeq, parseDocument } from 'yaml'
import { expectNoSecretLeak, getExport, getExportFn, sha256Hex } from './helpers/assertions.ts'
import { runBashCommand, runDshRsiInProcess, runNodeScript } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantDelivery,
  loadAssistantGoals,
  loadAssistantGoalsStrategy,
  loadAssistantGoalsStrategyRouter,
  loadAssistantPolicy,
  loadAssistantRecovery,
  loadAssistantSkills,
  loadAssistantSkillsDefinition,
  loadAssistantWebOwnerSetup,
  loadAssistantWorkItems,
  loadCredentialsKeychain,
  loadDshRsiCli,
  loadDshRsiUpgrade,
  loadEventTriggers,
  loadLarkChannel,
  loadOwnerConsole,
  loadPackageModule,
  loadUpgradeProgram,
  readAllWorkspaceManifests,
} from './helpers/packages.ts'
import { createIsolatedEnv, createWorkspaceTracker, repoRoot } from './helpers/workspace.ts'
import { parseBashArray, parseWorkflowYaml, readInstallerCommonScript } from './helpers/yaml-presets.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

function makeTriggerObserver(workspace: string, budgetId = 'obs-budget') {
  return {
    workspace,
    preset: 'primary',
    principalId: 'owner:one',
    principalRecordId: 'record-1',
    principalVersion: 1,
    ownerRouteId: 'route-1',
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
  const enhancedDir = join(profileDir, 'node_modules', '@dsh-enhanced', 'assistant-delivery')
  const cacheRoot = join(dshHome, 'host-cache')
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await mkdir(enhancedDir, { recursive: true, mode: 0o700 })
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })

  const hostVersion = opts.hostVersion ?? '0.1.9'
  const hostBindingPath = join(dshHome, '.dsh-rsi-host.json')
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
      dependencies: { '@dsh-enhanced/assistant-delivery': '0.1.83' },
    }),
    { mode: 0o600 },
  )
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', { mode: 0o600 })
  await writeFile(
    join(enhancedDir, 'package.json'),
    JSON.stringify({ name: '@dsh-enhanced/assistant-delivery', version: '0.1.83' }),
    { mode: 0o600 },
  )
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    [
      '- id: dsh-enhanced-assistant-delivery',
      '  name: "@dsh-enhanced/assistant-delivery"',
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_plans (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS source_creation_verifications (plan_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS source_revision_sources (plan_id TEXT PRIMARY KEY);
      INSERT INTO source_plans (id) VALUES ('plan-c1');
      INSERT INTO source_creation_verifications (plan_id) VALUES ('plan-c1');
      INSERT INTO source_revision_sources (plan_id) VALUES ('plan-r1');
    `)
    db.close()
  }
  return { profileDir, hostBindingPath, hostVersion }
}

function mockUpgradeFetch(targetEnhanced = '0.1.84', targetDsh = '0.2.2-rc.5') {
  return async (url: string | URL) => {
    const str = String(url)
    const latest = str.includes('@dsh-enhanced') || str.includes('dsh-rsi-cli') ? targetEnhanced : targetDsh
    return new Response(JSON.stringify({ 'dist-tags': { latest } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('Tier 3 Pairwise — F15–F23, F04, F07 & F14: Goals, Recovery, Triggers, Skills, Upgrade, R4 & Release/CI', () => {
  test('T3-GR-01 (F15+F16+F18): GoalStrategyRuntime tool-failure routing (experiment) <-> assistant-skills workflow templates <-> CompensationRegistry', async () => {
    const ws = await workspaces.create('t3-gr01-')
    const goalsMod = await loadAssistantGoals()
    const strategyMod = await loadAssistantGoalsStrategy()
    const routerMod = await loadAssistantGoalsStrategyRouter()
    const recMod = await loadAssistantRecovery()
    const skillsMod = await loadAssistantSkills()
    const skillsDef = await loadAssistantSkillsDefinition()

    const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(skillsMod, 'listWorkflowSkillTemplates')
    const templates = listTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(4)
    const targetTpl = templates.find(t => String(t.compensation ?? '') !== 'stop-and-report') ?? templates[0]!

    const assertProto = getExportFn<(def: Record<string, unknown>) => void>(skillsDef, 'assertDefinitionProtocol')
    expect(() => assertProto({
      preconditions: targetTpl.preconditions,
      compensation: targetTpl.compensation,
      steps: targetTpl.steps ?? [{ id: 's1', toolName: 'isolation_run', arguments: {}, dependsOn: [] }],
    })).not.toThrow()

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
        routes: [{ provider: 'p', model: 'm' }],
      },
      strategy: { maxDurationMs: 5_000, maxRunsPerGoal: 4 },
    })
    expect(goalsSvc.strategyEnabled).toBe(true)

    const comp = await harness.mountService<{
      registerCompensator: (h: {
        kind: string
        category: string
        compensate: () => Promise<{ status: string; resultCode: string }>
      }) => () => void
      executeCompensation: (rec: Record<string, unknown>) => Promise<{ id: string; status: string }>
      listCompensationAudit: (id: string) => readonly unknown[]
    }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', { databasePath: ws.sqlitePath('comp') })

    let compensated = 0
    comp.registerCompensator({
      kind: 'repo.revert-branch',
      category: 'revert',
      compensate: async () => {
        compensated += 1
        return { status: 'succeeded', resultCode: 'reverted' }
      },
    })

    const compRes = await comp.executeCompensation({
      forwardActionId: 'skill-step-2',
      idempotencyKey: 'gr01-comp-1',
      kind: 'repo.revert-branch',
      target: { externalRef: `tpl:${String(targetTpl.name)}` },
      preimage: { branch: 'main' },
    })
    expect(compensated).toBe(1)
    expect(compRes.status).toBe('succeeded')
    expect(comp.listCompensationAudit(compRes.id).length).toBeGreaterThanOrEqual(1)

    const validatedExp = strategyMod.validateGoalStrategyInput({
      kind: 'experiment',
      question: 'Probe failed workflow step tool in scoped workspace',
      tools: ['read', 'grep'],
    } as never) as unknown as Record<string, unknown>
    expect(validatedExp.kind).toBe('experiment')

    const recommend = getExportFn<(input: Record<string, unknown>) => { failureType: string; selectedStrategy: string }>(
      routerMod,
      'recommendGoalStrategy',
    )
    const routed = recommend({
      record: {
        id: 'goal-gr01',
        scope: { principalId: 'owner', principalRecordId: 'owner-rec', principalVersion: 1, workspace: ws.workspace, preset: 'primary' },
        originalObjective: `Execute workflow ${String(targetTpl.name)}`,
        definition: { version: 1, digest: sha256Hex('gr01'), objective: `Execute ${String(targetTpl.name)}` },
        native: { sessionId: 'sess-1', goalId: 'ng-1', revision: 1, objective: 'Run workflow', phase: 'active', roundsStarted: 1, maxGoalRounds: 4, updatedAt: 1_000 },
        checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: ['dep-1'] },
        version: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      budget: {
        limits: { mode: 'calls', routes: [{ provider: 'p', model: 'm' }], modelCalls: 10, toolCalls: 10, inputTokens: null, outputTokens: null, costUsdMicros: null, expiresAt: Date.now() + 60_000 },
        modelCalls: 1,
        toolCalls: 0,
        inputTokens: null,
        outputTokens: null,
        costUsdMicros: null,
        heldCalls: 0,
      },
      availableTools: ['read', 'glob', 'grep', 'isolation_run'],
      recentToolOutcomes: [{ name: 'isolation_run', isError: true }],
      now: 5_000,
    })
    expect(routed.failureType).toBe('tool-failure')
    expect(routed.selectedStrategy).toBe('experiment')
  }, 15_000)

  test('T3-GR-02 (F16+F18): assistant-skills 3–5 workflow templates <-> CompensationRegistry idempotency & ambiguous unknown settlement', async () => {
    const ws = await workspaces.create('t3-gr02-')
    const skillsMod = await loadAssistantSkills()
    const skillsDef = await loadAssistantSkillsDefinition()
    const recMod = await loadAssistantRecovery()

    const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(skillsMod, 'listWorkflowSkillTemplates')
    const assertProto = getExportFn<(def: Record<string, unknown>) => void>(skillsDef, 'assertDefinitionProtocol')
    const directive = getExportFn<(kind: string) => { kind: string; executeCompensation: boolean }>(skillsDef, 'compensationDirective')

    const templates = listTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(4)
    expect(templates.some(t => String(t.category ?? t.name).includes('repo'))).toBe(true)
    expect(templates.some(t => String(t.category ?? t.name).includes('calendar'))).toBe(true)
    expect(templates.some(t => String(t.category ?? t.name).includes('email'))).toBe(true)

    for (const tpl of templates) {
      expect(() => assertProto({
        preconditions: tpl.preconditions,
        compensation: tpl.compensation,
        steps: tpl.steps ?? [{ id: 's1', toolName: 'read', arguments: {}, dependsOn: [] }],
      })).not.toThrow()
      if (tpl.compensation !== 'stop-and-report') {
        expect(directive(String(tpl.compensation)).executeCompensation).toBe(true)
      }
    }

    const ctx = harness.createContext()
    const comp = await harness.mountService<{
      registerCompensator: (h: {
        kind: string
        category: string
        compensate: () => Promise<{ status: string; resultCode: string }>
      }) => () => void
      executeCompensation: (rec: Record<string, unknown>) => Promise<{ id: string; status: string; replayed: boolean; preimageDigest?: string }>
      getCompensationStatus: (q: { idempotencyKey: string }) => { status: string } | undefined
    }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', { databasePath: ws.sqlitePath('comp-wf') })

    let undoCount = 0
    comp.registerCompensator({
      kind: 'email.unarchive',
      category: 'revert',
      compensate: async () => {
        undoCount += 1
        return { status: 'succeeded', resultCode: 'unarchived' }
      },
    })
    comp.registerCompensator({
      kind: 'calendar.cancel-event',
      category: 'cancel',
      compensate: async () => {
        throw new Error('downstream timeout')
      },
    })

    const payloadA = {
      forwardActionId: 'wf-email-1',
      idempotencyKey: 'gr02-email-idem',
      kind: 'email.unarchive',
      target: { externalRef: 'msg-42' },
      preimage: { folder: 'INBOX' },
    }
    const r1 = await comp.executeCompensation(payloadA)
    const r2 = await comp.executeCompensation(payloadA)
    expect(undoCount).toBe(1)
    expect(r1.status).toBe('succeeded')
    expect(r1.preimageDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(r2.replayed).toBe(true)
    expect(r2.id).toBe(r1.id)

    const rUnknown = await comp.executeCompensation({
      forwardActionId: 'wf-cal-1',
      idempotencyKey: 'gr02-cal-timeout',
      kind: 'calendar.cancel-event',
      target: { externalRef: 'cal-evt-99' },
    })
    expect(rUnknown.status).toBe('unknown')
    expect(comp.getCompensationStatus({ idempotencyKey: 'gr02-cal-timeout' })?.status).toBe('unknown')
  })

  test('T3-GR-03 (F17+F18): event-triggers (webhook listener + replay dedup + rolling lark-calendar) <-> automations & workflow skills', async () => {
    const ws = await workspaces.create('t3-gr03-')
    const mod = await loadEventTriggers()
    const { EVENT_OBSERVER_EXECUTOR } = (await loadPackageModule('event-triggers/observer')) as { EVENT_OBSERVER_EXECUTOR: string }
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantAutomationsService } = (await loadPackageModule('assistant-automations')) as { AssistantAutomationsService: unknown }
    const { CredentialsKeychainService } = await loadCredentialsKeychain()
    const skillsMod = await loadAssistantSkills()

    const defaultCfg = mod.normalizeEventTriggersConfig({ databasePath: ws.sqlitePath('events-def') })
    expect(defaultCfg.pollerEnabled).toBe(true)

    const listTemplates = getExportFn<() => readonly Record<string, unknown>[]>(skillsMod, 'listWorkflowSkillTemplates')
    expect(listTemplates().length).toBeGreaterThanOrEqual(4)

    const windows: Array<{ startTime: number; endTime: number }> = []
    let fakeNowSec = 1_700_000_000
    const nowMs = fakeNowSec * 1000

    const ctx = harness.createContext()
    harness.provideMockService(ctx, 'assistantDelivery', {
      validateOwnerRoute: () => ({
        authorityId: 'route-1',
        authorityHash: sha256Hex('route-1'),
        receiptVersion: 2,
        principalId: 'owner:one',
        principalRecordId: 'record-1',
        principalVersion: 1,
        workspace: ws.workspace,
        agentPreset: 'primary',
        bindingVersion: 1,
        generation: 1,
      }),
    })
    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy'),
      budgets: [{ id: 'obs-budget', metric: 'requests', limit: 100, periodMs: 60_000, scope: 'subject' }],
      rules: [
        {
          id: 'observer',
          effect: 'allow',
          subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: ws.workspace, principal: 'owner:one' },
          actions: ['observe', 'reconcile', 'execute'],
          resource: { kind: 'automation', id: '*' },
          context: { initiators: ['background'] },
        },
        {
          id: 'calendar',
          effect: 'allow',
          subject: { kind: 'background', id: 'event-triggers:cal-roll', workspace: ws.workspace, principal: 'owner:one' },
          actions: ['observe'],
          resource: { kind: 'network', id: 'lark-calendar:cal-1' },
          context: { initiators: ['background'] },
          budget: { id: 'obs-budget', amount: 1 },
        },
        {
          id: 'cred-use',
          effect: 'allow',
          subject: { kind: 'background', id: 'dsh-enhanced-event-triggers' },
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
          subject: { kind: 'external', id: 'webhook:wh-gr03' },
          actions: ['accept'],
          resource: { kind: 'automation', id: '*' },
          context: { initiators: ['external'] },
        },
      ],
    })
    await harness.mountPlugin(ctx, AssistantAutomationsService, {
      databasePath: ws.sqlitePath('automations'),
      runsPath: join(ws.stateDir, 'runs'),
      schedulerEnabled: false,
      reconcileIntervalMs: 0,
      allowUnbudgetedExecution: true,
    })
    await ctx.plugin({
      name: 'webhook-creds-gr03',
      apply(runtime: unknown) {
        new (CredentialsKeychainService as new (r: unknown, cfg: unknown, opts: unknown) => unknown)(
          runtime,
          {
            databasePath: ws.sqlitePath('credentials'),
            handles: [{
              id: 'cred-wh',
              provider: 'environment',
              environmentName: 'DSH_E2E_WEBHOOK_SECRET',
              consumers: ['dsh-enhanced-event-triggers'],
              purposes: ['verify-webhook'],
              maxLeaseMs: 30_000,
            }],
          },
          { env: { DSH_E2E_WEBHOOK_SECRET: 'gr03-secret' } },
        )
      },
    } as never)

    const observer = makeTriggerObserver(ws.workspace, 'obs-budget')
    let svc!: InstanceType<typeof mod.EventTriggersService>
    await ctx.plugin({
      name: 'dsh-enhanced-event-triggers',
      apply(runtime: unknown) {
        svc = new mod.EventTriggersService(runtime as never, {
          databasePath: ws.sqlitePath('events'),
          pollerEnabled: false,
          webhookListen: { enabled: true, host: '127.0.0.1', port: 0, basePath: '/hooks' },
          triggers: [
            {
              id: 'wh-gr03',
              kind: 'webhook',
              automationId: 'auto-wh',
              credentialHandle: 'cred-wh',
              path: '/test',
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

    const addr = await svc.whenWebhookListening()
    expect(addr?.port).toBeTypeOf('number')
    const body = JSON.stringify({ event: 'ci-failed', workflow: 'repo-ci-fix' })
    const ts = String(nowMs)
    const nonce = 'nonce-gr03-1'
    const sig = `sha256=${createHmac('sha256', 'gr03-secret').update(`${ts}\n${nonce}\n${body}`).digest('hex')}`
    const headers = {
      'content-type': 'application/json',
      'x-dsh-timestamp': ts,
      'x-dsh-nonce': nonce,
      'x-dsh-signature': sig,
    }
    const resp1 = await fetch(`http://${addr!.host}:${addr!.port}/test`, { method: 'POST', headers, body })
    expect(resp1.status).toBe(202)
    expect((await resp1.json() as { accepted: boolean }).accepted).toBe(true)

    // Duplicate replay with identical nonce & signature is rejected
    const resp2 = await fetch(`http://${addr!.host}:${addr!.port}/test`, { method: 'POST', headers, body })
    expect(resp2.status).not.toBe(202)

    await svc.pollOnce()
    fakeNowSec += 600
    await svc.pollOnce()
    expect(windows.length).toBe(2)
    expect(windows[1]!.startTime).toBeGreaterThan(windows[0]!.startTime)
    expect(windows[1]!.endTime).toBeGreaterThan(windows[0]!.endTime)
  })

  test('T3-GR-04 (F17+F04+F07): event-triggers (task-system/calendar/email) -> WorkItems.recordIntake -> SQLite restart persistence & dedup', async () => {
    const ws = await workspaces.create('t3-gr04-')
    const triggersMod = await loadEventTriggers()
    const intakeMod = (await loadPackageModule('event-triggers/intake')) as {
      buildEventIntakeObservation: (input: Record<string, unknown>) => Record<string, unknown>
      toWorkItemIntakeInput: (obs: Record<string, unknown>) => Record<string, unknown>
    }
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const wiMod = await loadAssistantWorkItems()

    const observer = makeTriggerObserver(ws.workspace)
    const trigCfg = triggersMod.normalizeEventTriggersConfig({
      databasePath: ws.sqlitePath('events'),
      allowedHttpOrigins: ['https://tasks.example.test', 'https://cal.example.test', 'https://mail.example.test'],
      triggers: [
        { id: 'tasks-1', kind: 'task-system', automationId: 'auto-t', url: 'https://tasks.example.test/items', itemsPointer: '/items', observer } as never,
        { id: 'cal-1', kind: 'calendar', automationId: 'auto-c', url: 'https://cal.example.test/team.ics', format: 'ics', observer } as never,
        { id: 'mail-1', kind: 'email', automationId: 'auto-m', url: 'https://mail.example.test/jmap', protocol: 'jmap', accountId: 'acc-1', observer } as never,
      ],
    })
    expect(trigCfg.triggers.length).toBe(3)
    const wiDefault = wiMod.ConfigSchema({ databasePath: ws.sqlitePath('wi'), workRoot: ws.workspace })
    expect(wiDefault.enabled).toBe(true)
    expect(wiDefault.intakeLedger?.enabled).toBe(true)

    const sourceText = 'Task updated: triage release check'
    const obsDigest = sha256Hex(sourceText)
    const obs = intakeMod.buildEventIntakeObservation({
      trigger: trigCfg.triggers[0]!,
      receipt: {
        receiptVersion: 2,
        authorityId: 'route-1',
        authorityHash: sha256Hex('route-1'),
        principalId: 'owner:one',
        principalRecordId: 'record-1',
        principalVersion: 1,
        workspace: ws.workspace,
        agentPreset: 'primary',
        bindingVersion: 1,
        generation: 1,
      },
      sequence: 1,
      envelope: {
        event: { id: 'task-evt-1', occurredAt: 1_700_000_000_000 },
        observation: { revision: '1', digest: obsDigest },
      },
      envelopeDigest: sha256Hex('env-1'),
      text: sourceText,
    })
    const projected = intakeMod.toWorkItemIntakeInput(obs)
    expect(Object.keys(projected).sort()).toEqual([
      'addressed',
      'contentDigest',
      'kind',
      'occurredAt',
      'senderAllowlisted',
      'senderIsBot',
      'source',
      'sourceEventId',
      'subscribed',
      'threadFollowUp',
    ])
    expectNoSecretLeak(JSON.stringify({ obs, projected }), ['sk-canary-secret', 'ghp_canary'])

    const wiDb = ws.sqlitePath('wi')
    const wiConfig = {
      enabled: true,
      mode: 'observe',
      databasePath: wiDb,
      workRoot: ws.workspace,
      intakeLedger: { enabled: true },
    }

    const ctx1 = harness.createContext()
    await harness.mountService(ctx1, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy1') })
    const wi1 = await harness.mountService<{
      recordIntake: (input: unknown, sourceText?: string) => { replayed: boolean; record: { decision: string } }
    }>(ctx1, wiMod.AssistantWorkItemsService, 'assistantWorkItems', wiConfig)

    const first = wi1.recordIntake(projected, sourceText)
    expect(first.replayed).toBe(false)
    expect(first.record.decision).toBe('stored')
    await harness.disposeAll()

    const ctx2 = harness.createContext()
    await harness.mountService(ctx2, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy2') })
    const wi2 = await harness.mountService<{
      recordIntake: (input: unknown, sourceText?: string) => { replayed: boolean; record: { decision: string } }
    }>(ctx2, wiMod.AssistantWorkItemsService, 'assistantWorkItems', wiConfig)

    const replay = wi2.recordIntake(projected, sourceText)
    expect(replay.replayed).toBe(true)
    expect(replay.record.decision).toBe('stored')
  })

  test('T3-GR-05 (F19+F20): WP17 0.1 -> 0.2 + non-empty history migration <-> standard web/supervised/lark install queues', async () => {
    const ws = await workspaces.create('t3-gr05-')
    const { profileDir, hostBindingPath } = await seedProfileFixture(ws.dshHome, 'web', { hostVersion: '0.1.9', seedHistory: true })
    const upg = await loadDshRsiUpgrade()
    const progMod = await loadUpgradeProgram()
    expect((progMod as Record<string, unknown>).parseProgramUpgradeArgs).toBeTypeOf('function')

    const { report } = await upg.runUpgrade({
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

    expect(report.ok).toBe(true)
    expect(report.readiness.ledgersOk).toBe(true)
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('owner-route-1')
    expect(await readFile(join(profileDir, '.credentials.yaml'), 'utf8')).toContain('openai: dummy-ref')

    // Verify all 3 standard install queues and common.sh include assistant-association & R3 defaults
    const script = await readInstallerCommonScript()
    const combinedSlugs = new Set([
      ...parseBashArray(script, 'DSH_ENHANCED_CORE_PLUGIN_SLUGS'),
      ...parseBashArray(script, 'DSH_ENHANCED_LARK_PLUGIN_SLUGS'),
      ...parseBashArray(script, 'DSH_ENHANCED_SUPERVISED_GROWTH_PLUGIN_SLUGS'),
    ])
    expect(combinedSlugs.has('assistant-association')).toBe(true)

    for (const scenario of ['web', 'supervised', 'lark'] as const) {
      const envWs = await workspaces.create(`t3-gr05-${scenario}-`)
      const env = await createIsolatedEnv(envWs)
      const res = await runBashCommand(
        [join(repoRoot, 'scripts/install/install-local.sh'), '--dry-run', '--scenario', scenario, '--yes'],
        { env },
      )
      expect(res.exitCode).toBe(0)
      expect(res.stdout + res.stderr).toContain('assistant-association')
    }

    const setupMod = await loadAssistantWebOwnerSetup()
    const prepare = getExportFn<(input: Record<string, unknown>, source: string, effectiveSource: string) => { patch: string }>(
      setupMod,
      'prepareWebOwnerProfile',
    )
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
      '- id: dsh-enhanced-assistant-goals',
      '  name: "@dsh-enhanced/assistant-goals"',
      '- id: dsh-enhanced-assistant-web-owner',
      '  name: "@dsh-enhanced/assistant-web-owner"',
      '- id: dsh-enhanced-assistant-association',
      '  name: "@dsh-enhanced/assistant-association"',
    ].join('\n')
    const prep = prepare({ dshHome: ws.dshHome, profile: 'web', workspace: ws.workspace, preset: 'primary' }, '[]\n', effective)
    expect(prep.patch).toContain('assistant-association')
  })

  test('T3-GR-06 (F19+F21): R4 dsh-rsi upgrade / upgradeAssistantAndRecover <-> WP17 failed health rollback <-> doctor readiness recovery', async () => {
    const wsFail = await workspaces.create('t3-gr06-fail-')
    const { profileDir, hostBindingPath } = await seedProfileFixture(wsFail.dshHome, 'web', { hostVersion: '0.2.1-rc.2' })
    const upg = await loadDshRsiUpgrade()

    const { report: failedReport } = await upg.runUpgrade({
      dshHome: wsFail.dshHome,
      osHome: wsFail.root,
      platform: 'linux',
      profile: 'web',
      action: 'apply',
    } as never, {
      fetch: mockUpgradeFetch() as never,
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: hostBindingPath,
        version: '0.2.1-rc.2',
        dshPath: '/usr/local/bin/dsh',
        issues: [],
      }) as never,
      scanProcesses: async () => ({ processes: [] }),
      upgradeHost: async () => {},
      upgradeProfilePackages: async () => {},
      verifyHealth: async () => ({ ok: false, error: 'unhealthy' }),
    } as never)

    expect(failedReport.ok).toBe(false)
    expect(failedReport.execution?.rolledBack).toBe(true)
    expect(failedReport.execution?.rollbackSucceeded).toBe(true)
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('owner-route-1')
    expect(await readFile(join(profileDir, '.credentials.yaml'), 'utf8')).toContain('openai: dummy-ref')

    // Scenario B: unified R4 upgradeAssistantAndRecover runs upgrade + doctor + service restart
    const wsOk = await workspaces.create('t3-gr06-ok-')
    await seedProfileFixture(wsOk.dshHome, 'web', { hostVersion: '0.1.9' })
    const cli = await loadDshRsiCli()
    const upgradeAndRecover = getExportFn<(opts: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<Record<string, unknown>>>(
      cli,
      'upgradeAssistantAndRecover',
    )
    const steps: string[] = []
    const recovered = await upgradeAndRecover({ dshHome: wsOk.dshHome, profile: 'web', yes: true }, {
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
  })

  test('T3-GR-07 (F20+F21+F14): R4 dsh-rsi disable / enable CLI toggles R3 self-iteration stack prepared by prepareWebOwnerProfile', async () => {
    const ws = await workspaces.create('t3-gr07-')
    const setupMod = await loadAssistantWebOwnerSetup()
    const prepare = getExportFn<(input: Record<string, unknown>, source: string, effectiveSource: string) => { patch: string }>(
      setupMod,
      'prepareWebOwnerProfile',
    )

    const profileDir = join(ws.dshHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }), 'utf8')

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
      '- id: dsh-enhanced-assistant-goals',
      '  name: "@dsh-enhanced/assistant-goals"',
      '- id: dsh-enhanced-assistant-web-owner',
      '  name: "@dsh-enhanced/assistant-web-owner"',
      '- id: dsh-enhanced-assistant-association',
      '  name: "@dsh-enhanced/assistant-association"',
      '- id: dsh-enhanced-assistant-work-items',
      '  name: "@dsh-enhanced/assistant-work-items"',
      '  config:',
      '    enabled: true',
    ].join('\n')
    const prepared = prepare({ dshHome: ws.dshHome, profile: 'web', workspace: ws.workspace, preset: 'primary' }, '[]\n', effective)
    await writeFile(join(profileDir, 'cordis.patch.yml'), prepared.patch, 'utf8')

    const dis = await runDshRsiInProcess(['disable', '--profile', 'web', '--dsh-home', ws.dshHome, '--json'])
    expect(dis.exitCode).toBe(0)
    const afterDisable = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(afterDisable).toContain('assistant-web-owner')

    const en = await runDshRsiInProcess(['enable', '--profile', 'web', '--dsh-home', ws.dshHome, '--json'])
    expect(en.exitCode).toBe(0)
    const afterEnable = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(afterEnable).toContain('assistant-association')
    expect(afterEnable).toContain('assistant-work-items')
  })

  test('T3-GR-08 (F21+F19+F14): R4 Web owner-console & Feishu lark-channel/assistant-delivery NL controls <-> owner authorization <-> upgradeAssistantAndRecover', async () => {
    const ws = await workspaces.create('t3-gr08-')
    const deliveryMod = await loadAssistantDelivery()
    const larkMod = await loadLarkChannel()
    const ownerMod = await loadOwnerConsole()
    const cliMod = await loadDshRsiCli()

    expect(larkMod.LarkChannelService).toBeDefined()
    expect((cliMod as Record<string, unknown>).upgradeAssistantAndRecover).toBeTypeOf('function')

    const parseNlControl = getExportFn<(text: string) => { action: string } | undefined>(
      deliveryMod,
      'parseOwnerSelfIterationCommand',
    )
    const cmdDisable = parseNlControl('关闭自迭代')
    const cmdEnable = parseNlControl('开启自迭代')
    const cmdUpgrade = parseNlControl('升级整体助手')
    expect(cmdDisable?.action).toBe('disableSelfIteration')
    expect(cmdEnable?.action).toBe('enableSelfIteration')
    expect(cmdUpgrade?.action).toBe('upgradeAssistantAndRecover')

    const profileDir = join(ws.dshHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    const initialPatch = '- id: dsh-enhanced-assistant-work-items\n  name: "@dsh-enhanced/assistant-work-items"\n  config:\n    enabled: true\n'
    await writeFile(join(profileDir, 'cordis.patch.yml'), initialPatch, 'utf8')

    const ctx = harness.createContext()
    harness.provideMockService(ctx, 'typert', { register: () => {} })
    const handleControl = getExportFn<(ctx: unknown, req: Record<string, unknown>) => Promise<Record<string, unknown>>>(
      ownerMod,
      'handleOwnerConsoleControlAction',
    )

    // Unauthorized caller fails closed without mutating DSH_HOME
    const denied = await handleControl(ctx, {
      dshHome: ws.dshHome,
      ownerAuthorized: false,
      action: cmdDisable!.action,
    })
    expect(denied.ok).toBe(false)
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(initialPatch)

    const resDis = await handleControl(ctx, { dshHome: ws.dshHome, ownerAuthorized: true, action: cmdDisable!.action })
    expect(resDis.ok).toBe(true)
    expect(resDis.state).toBe('disabled')

    const resEn = await handleControl(ctx, { dshHome: ws.dshHome, ownerAuthorized: true, action: cmdEnable!.action })
    expect(resEn.ok).toBe(true)
    expect(resEn.state).toBe('enabled')

    const resUpg = await handleControl(ctx, { dshHome: ws.dshHome, ownerAuthorized: true, action: cmdUpgrade!.action })
    expect(resUpg.ok).toBe(true)
  })

  test('T3-GR-09 (F22+F23): R1 release.yml 40-package npm readback gate <-> ci.yml cross-platform matrix <-> workspace manifest parity', async () => {
    const manifests = await readAllWorkspaceManifests()
    expect(manifests.length).toBe(40)
    expect(manifests.filter(m => m.kind === 'package').length).toBe(4)
    expect(manifests.filter(m => m.kind === 'plugin').length).toBe(36)
    const targetVersion = manifests[0]!.version
    expect(new Set(manifests.map(m => m.version)).size).toBe(1)
    for (const m of manifests) {
      expect(m.publishConfig?.access).toBe('public')
    }

    const releaseWf = await parseWorkflowYaml<{
      jobs: Record<string, { needs?: string | string[]; steps?: Array<{ run?: string }> }>
    }>('.github/workflows/release.yml')
    const recordNeeds = Array.isArray(releaseWf.jobs.record?.needs) ? releaseWf.jobs.record?.needs : [releaseWf.jobs.record?.needs]
    expect(releaseWf.jobs['verify-npm']).toBeDefined()
    expect(recordNeeds).toContain('verify-npm')

    const ciWf = await parseWorkflowYaml<{
      jobs: Record<string, { 'runs-on'?: string; needs?: string[] }>
    }>('.github/workflows/ci.yml')
    const verifyNeeds = new Set(ciWf.jobs.verify?.needs ?? [])
    for (const jobName of Object.keys(ciWf.jobs).filter(k => k !== 'verify')) {
      expect(verifyNeeds.has(jobName)).toBe(true)
    }

    let stalePackage: string | undefined
    const staleVersion = targetVersion === '0.1.83' ? '0.1.82' : '0.1.83'
    const server = createServer((req, res) => {
      const pkgName = decodeURIComponent((req.url ?? '/').slice(1))
      if (manifests.some(m => m.name === pkgName)) {
        const servedVersion = pkgName === stalePackage ? staleVersion : targetVersion
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          name: pkgName,
          'dist-tags': { latest: servedVersion },
          versions: {
            [servedVersion]: { name: pkgName, version: servedVersion, dist: { tarball: 'http://127.0.0.1/dummy.tgz' } },
          },
        }))
        return
      }
      res.writeHead(404)
      res.end('Not found')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const okRes = await runNodeScript('scripts/verify-npm-release.mjs', [
        '--tag',
        `v${targetVersion}`,
        '--registry',
        `http://127.0.0.1:${port}`,
        '--retries',
        '0',
      ])
      expect(okRes.exitCode).toBe(0)

      stalePackage = '@dsh-enhanced/dsh-rsi-cli'
      const failRes = await runNodeScript('scripts/verify-npm-release.mjs', [
        '--tag',
        `v${targetVersion}`,
        '--registry',
        `http://127.0.0.1:${port}`,
        '--retries',
        '0',
      ])
      expect(failRes.exitCode).not.toBe(0)
      expect(failRes.stdout + failRes.stderr).toContain(stalePackage)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('T3-GR-10 (F22+F23+F20): Installer standard queues (common.sh) <-> ci.yml cross-platform targets <-> 40-package manifest & release readback completeness', async () => {
    const manifests = await readAllWorkspaceManifests()
    const pluginSlugs = new Set(manifests.filter(m => m.kind === 'plugin').map(m => m.slug))
    const allSlugs = new Set(manifests.map(m => m.slug))

    const script = await readInstallerCommonScript()
    const core = parseBashArray(script, 'DSH_ENHANCED_CORE_PLUGIN_SLUGS')
    const lark = parseBashArray(script, 'DSH_ENHANCED_LARK_PLUGIN_SLUGS')
    const sup = parseBashArray(script, 'DSH_ENHANCED_SUPERVISED_GROWTH_PLUGIN_SLUGS')
    const queuedSlugs = [...new Set([...core, ...lark, ...sup])]

    expect(queuedSlugs.length).toBeGreaterThan(0)
    expect(queuedSlugs).toContain('assistant-association')
    const missingFromPlugins = queuedSlugs.filter(slug => !pluginSlugs.has(slug))
    expect(missingFromPlugins).toEqual([])

    const ciWf = await parseWorkflowYaml<{
      jobs: Record<string, { 'runs-on'?: string; steps?: Array<{ run?: string }> }>
    }>('.github/workflows/ci.yml')
    const xplatRuns = Object.values(ciWf.jobs)
      .filter(j => {
        const os = String(j['runs-on'] ?? '')
        return os.includes('windows') || os.includes('macos')
      })
      .flatMap(j => (j.steps ?? []).map(s => s.run ?? ''))
      .join('\n')

    for (const targetSlug of ['dsh-rsi-cli', 'assistant-isolation', 'assistant-actions']) {
      expect(allSlugs.has(targetSlug)).toBe(true)
      expect(xplatRuns).toContain(targetSlug)
    }

    const releaseRaw = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    expect(releaseRaw).toContain('verify-npm-release.mjs')
    expect(manifests.length).toBe(40)
  })

  test('T3-GR-11 (F26+F21): Live OwnerConsole -> AssistantDelivery -> LarkChannel delegation & dsh-rsi disable/enable ledger preservation', async () => {
    const ws = await workspaces.create('t3-gr11-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantDeliveryService } = await loadAssistantDelivery()
    const ownerMod = await loadOwnerConsole()
    const larkMod = await loadLarkChannel()
    const normalizeMod = await loadPackageModule('lark-channel/normalize')
    const normalizeLarkMessage = getExportFn<(
      cfg: Record<string, unknown>,
      msg: Record<string, unknown>,
      now: number,
    ) => { outcome: string; envelope?: Record<string, unknown> }>(normalizeMod, 'normalizeLarkMessage')

    const profileDir = join(ws.dshHome, 'profiles', 'lark')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-lark', private: true }), { mode: 0o600 })
    await writeFile(
      join(profileDir, 'cordis.patch.yml'),
      [
        '- id: dsh-enhanced-owner-console',
        '  name: "@dsh-enhanced/owner-console"',
        '- id: dsh-enhanced-lark-channel',
        '  name: "@dsh-enhanced/lark-channel"',
        '- id: dsh-enhanced-assistant-delivery',
        '  name: "@dsh-enhanced/assistant-delivery"',
        '  config:',
        '    ownerRoutes:',
        '      - id: owner-route-1',
        '        conversation: { channel: lark, account: primary-bot, tenant: tenant-a, kind: dm, chat: oc_dm_ou_owner }',
        '- id: dsh-enhanced-assistant-work-items',
        '  name: "@dsh-enhanced/assistant-work-items"',
        '  config:',
        '    enabled: true',
      ].join('\n') + '\n',
      { mode: 0o600 },
    )

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
    await execSql('assistant-work-items/state.sqlite', "CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT) STRICT; INSERT INTO work_item VALUES ('w1', 'settled'), ('w2', 'settled');")
    await execSql('assistant-dreaming/state.sqlite', "CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT) STRICT; INSERT INTO dream_runs VALUES ('d1', 'completed');")
    await execSql('plugin-control-plane/control.sqlite', "CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT, mode TEXT, status TEXT) STRICT; CREATE TABLE activation_plans (id TEXT PRIMARY KEY, profile TEXT, status TEXT) STRICT; INSERT INTO source_plans VALUES ('p1', '@dsh-enhanced/evolved-alpha', 'create', 'release-complete'); INSERT INTO activation_plans VALUES ('p1', 'lark', 'activated');")
    await execSql('plugin-control-plane/creation-adoptions.sqlite', `CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, certificate_json TEXT, receipt_json TEXT) STRICT; INSERT INTO adoptions VALUES ('p1', 'active', '{"plan":{"name":"@dsh-enhanced/evolved-alpha"}}', '{"version":"0.1.0"}');`)

    const ctx = harness.createContext()
    await harness.mountPlugin(ctx, TypertRegistry)
    harness.provideMockService(ctx, 'profileContext', { home: ws.dshHome, dir: profileDir, name: 'lark' })
    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy'),
      rules: [
        { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
        { id: 'owner', effect: 'allow', subject: { kind: 'external', id: 'lark/primary-bot/tenant-a/ou_owner' }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
        { id: 'linked', effect: 'allow', subject: { kind: 'external', id: 'lark/primary-bot/tenant-a/ou_linked' }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
        { id: 'reply-owner', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'lark/primary-bot/tenant-a/ou_owner' }, actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground', 'external'] } },
        { id: 'reply-linked', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'lark/primary-bot/tenant-a/ou_linked' }, actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground', 'external'] } },
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
    const ownerConsoleSvc = ctx.get('ownerConsole' as never) as unknown as {
      versionInfo: () => Promise<{ selfIteration: { totalIterations: number | null }; plugins: { evolvedCount: number } }>
    }
    const expectedReport = await ownerConsoleSvc.versionInfo()
    expect(expectedReport.selfIteration.totalIterations).toBeGreaterThan(0)
    expect(expectedReport.plugins.evolvedCount).toBe(1)
    const versionInfoSpy = vi.spyOn(ownerConsoleSvc, 'versionInfo')

    const delivery = await harness.mountService<{
      issuePairing: (by: string, p: Record<string, unknown>) => { challenge: { id: string }; code: string }
      confirmPairing: (req: Record<string, unknown>) => unknown
      acceptInbound: (env: Record<string, unknown>) => Promise<unknown>
      tick: () => Promise<void>
      whenIdle: () => Promise<void>
    }>(ctx, AssistantDeliveryService, 'assistantDelivery', {
      databasePath: ws.sqlitePath('delivery'),
      spoolPath: join(ws.stateDir, 'spool'),
      defaultWorkspace: ws.workspace,
      defaultAgentPreset: 'primary',
      schedulerEnabled: false,
    })

    const sends: string[] = []
    const transport = {
      subscribe: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
      addReaction: async () => 'r1',
      createProgress: async () => ({ cotId: 'c1', messageId: 'om_cot' }),
      writeProgress: async () => {},
      send: async (_chatId: string, input: { text?: string }) => {
        sends.push(input.text ?? JSON.stringify(input))
        return { messageId: `om_out_${sends.length}` }
      },
    }
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
      createTransport: () => transport,
      writeLifecycleMarker: () => {},
      dshHome: ws.dshHome,
      profile: 'lark',
    })
    await larkSvc.whenReady()

    const ownerPrincipal = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' }
    const ownerPair = delivery.issuePairing('test', ownerPrincipal)
    delivery.confirmPairing({ challengeId: ownerPair.challenge.id, principal: ownerPrincipal, code: ownerPair.code })
    const linkedPrincipal = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_linked' }
    const linkedPair = delivery.issuePairing('test', linkedPrincipal)
    delivery.confirmPairing({ challengeId: linkedPair.challenge.id, principal: linkedPrincipal, code: linkedPair.code })

    const inboundCfg = { account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true, maxTextBytes: 4096, staleAfterMs: 300_000 }
    const drive = async () => {
      await delivery.tick()
      await delivery.whenIdle()
      await delivery.tick()
      await delivery.whenIdle()
    }
    const now = Date.now()
    const dmMsg = normalizeLarkMessage(inboundCfg, {
      messageId: 'om_gr11_dm',
      chatId: 'oc_dm_ou_owner',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '/version',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: now,
    }, now)
    const grpMsg = normalizeLarkMessage(inboundCfg, {
      messageId: 'om_gr11_grp',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_linked',
      content: '@_user_1 自己迭代了多少次？',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: now + 1,
    }, now + 1)
    if (dmMsg.outcome === 'accept' && dmMsg.envelope) await delivery.acceptInbound(dmMsg.envelope)
    if (grpMsg.outcome === 'accept' && grpMsg.envelope) await delivery.acceptInbound(grpMsg.envelope)
    await drive()

    expect(versionInfoSpy).toHaveBeenCalledTimes(2)
    expect(sends).toHaveLength(2)
    for (const reply of sends) {
      expect(reply).toContain(`累计自迭代次数：${expectedReport.selfIteration.totalIterations}`)
      expect(reply).toContain('@dsh-enhanced/evolved-alpha')
    }
    expect(resumeSpy).not.toHaveBeenCalled()

    // Toggle disable -> enable via dsh-rsi CLI and confirm historical ledgers remain intact
    expect((await runDshRsiInProcess(['disable', '--profile', 'lark', '--dsh-home', ws.dshHome, '--json'])).exitCode).toBe(0)
    expect((await runDshRsiInProcess(['enable', '--profile', 'lark', '--dsh-home', ws.dshHome, '--json'])).exitCode).toBe(0)

    const postToggleCli = await runDshRsiInProcess(['version', '--json', '--dsh-home', ws.dshHome])
    expect(postToggleCli.exitCode).toBe(0)
    const postJson = JSON.parse(postToggleCli.stdout) as { selfIteration: { totalIterations: number }; plugins: { evolvedCount: number } }
    expect(postJson.selfIteration.totalIterations).toBe(expectedReport.selfIteration.totalIterations)
    expect(postJson.plugins.evolvedCount).toBe(1)
  })

  test('T3-GR-12 (F26+F19+F20): Cross-surface dsh-rsi/version/v1 wire parity across CLI, OwnerConsole & Delivery + common.sh real bin probe', async () => {
    const ws = await workspaces.create('t3-gr12-')
    const manifests = await readAllWorkspaceManifests()
    const expectedVersion = manifests[0]!.version
    const typertMod = await loadPackageModule('owner-console/typert')
    const ReportSchema = getExport<{ parse: (input: unknown) => unknown }>(typertMod, 'OwnerConsoleVersionReportSchema')
    const ownerMod = await loadOwnerConsole()
    const deliveryVerMod = await loadPackageModule('assistant-delivery/version-query')
    const collectDelivery = getExportFn<(opts: Record<string, unknown>) => Promise<Record<string, unknown>>>(
      deliveryVerMod,
      'collectDeliveryVersionReport',
    )

    const profileDir = join(ws.dshHome, 'profiles', 'web')
    await mkdir(join(profileDir, 'node_modules', '@dsh-enhanced', 'assistant-delivery'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(profileDir, 'node_modules', '@dsh-enhanced', 'assistant-delivery', 'package.json'),
      JSON.stringify({ name: '@dsh-enhanced/assistant-delivery', version: expectedVersion }),
      'utf8',
    )
    await writeFile(
      join(ws.dshHome, '.dsh-rsi-host.json'),
      JSON.stringify({ schemaVersion: 1, version: '0.2.2-rc.5', cacheRoot: ws.root, receiptDigest: sha256Hex('host-gr12') }),
      { mode: 0o600 },
    )
    await mkdir(join(ws.dshHome, '.dsh-enhanced'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(ws.dshHome, '.dsh-enhanced', 'upgrade-history.jsonl'),
      `${JSON.stringify({ at: 1, toVersion: expectedVersion })}\n${JSON.stringify({ at: 2, toVersion: expectedVersion })}\n`,
      'utf8',
    )
    await mkdir(join(ws.dshHome, '.dsh-rsi-upgrade-backups', 'snap-1'), { recursive: true, mode: 0o700 })
    await mkdir(join(ws.dshHome, '.dsh-rsi-upgrade-backups', 'snap-2'), { recursive: true, mode: 0o700 })

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
    await execSql('assistant-work-items/state.sqlite', "CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT) STRICT; INSERT INTO work_item VALUES ('w1', 'settled');")
    await execSql('plugin-control-plane/control.sqlite', "CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT, mode TEXT, status TEXT) STRICT; CREATE TABLE activation_plans (id TEXT PRIMARY KEY, profile TEXT, status TEXT) STRICT; INSERT INTO source_plans VALUES ('sp1', '@dsh-enhanced/evolved-gr12', 'create', 'release-complete'), ('sp2', '@dsh-enhanced/evolved-gr12', 'modify', 'release-complete'); INSERT INTO activation_plans VALUES ('sp1', 'web', 'activated');")
    await execSql('plugin-control-plane/creation-adoptions.sqlite', `CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, certificate_json TEXT, receipt_json TEXT) STRICT; INSERT INTO adoptions VALUES ('sp1', 'active', '{"plan":{"name":"@dsh-enhanced/evolved-gr12"}}', '{"version":"0.1.0"}');`)
    await execSql('plugin-control-plane/revision-adoptions.sqlite', "CREATE TABLE entries (entry_id TEXT PRIMARY KEY, name TEXT, current_plan_id TEXT, revision INTEGER) STRICT; CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, entry_id TEXT) STRICT; CREATE TABLE rollbacks (seq INTEGER PRIMARY KEY, rollback_id TEXT) STRICT; INSERT INTO entries VALUES ('e1', '@dsh-enhanced/evolved-gr12', 'sp2', 2); INSERT INTO adoptions VALUES ('sp2', 'active', 'e1');")

    // 1. CLI
    const cliRes = await runDshRsiInProcess(['version', '--json', '--dsh-home', ws.dshHome])
    expect(cliRes.exitCode).toBe(0)
    const cliReport = JSON.parse(cliRes.stdout) as Record<string, unknown>

    // 2. OwnerConsoleService.versionInfo()
    const ctx = harness.createContext()
    await harness.mountPlugin(ctx, TypertRegistry)
    harness.provideMockService(ctx, 'profileContext', { home: ws.dshHome, dir: profileDir, name: 'web' })
    const applyOwner = getExportFn<(c: unknown, cfg: unknown) => void>(ownerMod, 'apply')
    const configOwner = getExportFn<(input: Record<string, unknown>) => unknown>(ownerMod, 'Config')
    applyOwner(ctx, configOwner({ feishuAppId: '' }))
    const ownerSvc = ctx.get('ownerConsole' as never) as unknown as { versionInfo: () => Promise<Record<string, unknown>> }
    const ownerReport = await ownerSvc.versionInfo()

    // 3. Delivery standalone collector
    const deliveryReport = await collectDelivery({ ctx, dshHome: ws.dshHome, profile: 'web' })

    for (const report of [cliReport, ownerReport, deliveryReport]) {
      expect(ReportSchema.parse(report)).toEqual(report)
      expect(report.schemaVersion).toBe(1)
      expect(report.protocol).toBe('dsh-rsi/version/v1')
      expect((report.assistant as { version: string }).version).toBe(expectedVersion)
      expect((report.host as { boundVersion: string | null }).boundVersion).toBe('0.2.2-rc.5')
      expect(report.selfIteration).toMatchObject({
        dataState: 'data',
        pluginsCreated: 1,
        pluginsRevised: 1,
        selfUpgrades: 2,
        backupSnapshotsCount: 2,
      })
    }

    // 4. Verify scripts/install/common.sh dsh_enhanced_ensure_rsi_cli probe against real bin/dsh-rsi.js
    const shimBin = join(ws.root, 'real-bin')
    await mkdir(shimBin, { recursive: true, mode: 0o700 })
    await writeFile(join(shimBin, 'npm'), '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    await chmod(join(shimBin, 'npm'), 0o755)
    await writeFile(
      join(shimBin, 'dsh-rsi'),
      `#!/usr/bin/env bash\nexec "${process.execPath}" "${join(repoRoot, 'packages/dsh-rsi-cli/bin/dsh-rsi.js')}" "$@"\n`,
      'utf8',
    )
    await chmod(join(shimBin, 'dsh-rsi'), 0o755)

    const env = await createIsolatedEnv(ws, { PATH: `${shimBin}:${process.env.PATH ?? '/usr/bin:/bin'}` })
    const probeRes = await runBashCommand([
      '-c',
      `source "${join(repoRoot, 'scripts/install/common.sh')}" && dsh_enhanced_ensure_rsi_cli npm "${repoRoot}" "${expectedVersion}" 0`,
    ], { env })
    expect(probeRes.exitCode).toBe(0)
    expect(probeRes.stdout).toContain(`dsh-rsi 已就绪：${expectedVersion}`)
  })
})
