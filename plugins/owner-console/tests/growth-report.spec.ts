// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { jsx } from 'react/jsx-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readOwnerConsoleGrowthReport } from '../src/growth-report.ts'
import { OwnerConsoleService } from '../src/service.ts'
import { GrowthReportCard, growthDataStatePill, type ConsoleRemote } from '../src/settings-cards.ts'
import { OwnerConsoleGrowthReportSchema, TYPERT } from '../src/typert.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('owner-console growth report scorecard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('distinguishes no-data vs zero vs data through read-only inspect/query/summary interfaces and validates against TYPERT schema', async () => {
    const now = 1_800_000_000_000
    const day = 86_400_000

    // 1. No services mounted -> all sections `no-data`
    const emptyHost = { get: () => undefined } as never
    const noData = readOwnerConsoleGrowthReport(emptyHost, '/ws', 'default', 7, now)
    expect(OwnerConsoleGrowthReportSchema.parse(noData)).toEqual(noData)
    expect(noData.overallState).toBe('no-data')
    expect(noData.tasks.state).toBe('no-data')
    expect(noData.memory.state).toBe('no-data')
    expect(noData.candidates.state).toBe('no-data')
    expect(noData.notifications.state).toBe('no-data')
    expect(noData.suppliers.state).toBe('no-data')
    expect(growthDataStatePill(noData.overallState)).toEqual({ label: '无数据（未启用/无账本）', tone: 'warn' })

    // 2. Services mounted, 0 events in window -> `zero` with null rates
    const zeroHost = {
      get: (name: string) => {
        if (name === 'assistantEvaluation') {
          return {
            queryTasks: () => [],
            query: () => [],
            notificationOutcomeSummary: () => ({ total: 0, outcomes: {} }),
            intakeEvaluationAgreementSummary: () => ({ truePositive: 0, falsePositive: 0, decided: 0, agreed: 0, disagreed: 0 }),
          }
        }
        if (name === 'personalMemory') return { health: () => ({ activeRecords: 0 }) }
        if (name === 'pluginControlPlane') return { health: () => ({ readyPlans: 0, activeActivations: 0, failed: 0 }) }
        return undefined
      },
    } as never
    const zero = readOwnerConsoleGrowthReport(zeroHost, '/ws', 'default', 7, now)
    expect(OwnerConsoleGrowthReportSchema.parse(zero)).toEqual(zero)
    expect(zero.overallState).toBe('zero')
    expect(zero.tasks.state).toBe('zero')
    expect(zero.tasks.correctionRatePpm).toBeNull()
    expect(zero.memory.state).toBe('zero')
    expect(zero.candidates.state).toBe('zero')
    expect(zero.notifications.state).toBe('zero')
    expect(zero.suppliers.state).toBe('zero')
    expect(growthDataStatePill(zero.overallState)).toEqual({ label: '0（账本就绪，窗口内无记录）', tone: 'neutral' })

    // 3. Populated read-only services -> `data`
    const liveNow = Date.now()
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const mockServices: Record<string, unknown> = {
      profileContext: { name: 'web' },
      assistantEvaluation: {
        queryTasks: () => [
          { id: 'p1', occurredAt: liveNow - 20 * day, objectiveStatus: 'not-achieved', task: { subjectKey: 'prev-1' }, metrics: {} },
          { id: 'c1', occurredAt: liveNow - 2 * day, objectiveStatus: 'achieved', task: { subjectKey: 'cur-1' }, metrics: { retries: 1 } },
          { id: 'c2', occurredAt: liveNow - 1 * day, objectiveStatus: 'unknown', task: { subjectKey: 'cur-2', learningDisposition: 'retract' }, metrics: {} },
          { id: 'c3', occurredAt: liveNow - 1 * day, objectiveStatus: 'unknown', task: { subjectKey: 'cur-3', learningDisposition: 'retract' }, metrics: {} },
        ],
        query: () => [
          { id: 'p1-fb', occurredAt: liveNow - 20 * day, taskSubjectKey: 'prev-1', source: { kind: 'user-feedback' }, objectiveStatus: 'not-achieved', executionStatus: 'succeeded', metrics: {} },
          { id: 'c1', occurredAt: liveNow - 2 * day, taskSubjectKey: 'cur-1', source: { kind: 'foreground' }, objectiveStatus: 'achieved', executionStatus: 'succeeded', metrics: { supplier: { provider: 'deepseek', model: 'deepseek-v4' }, costUsdMicros: 4500, latencyMs: 320, inputTokens: 120, outputTokens: 80, toolCalls: 2 } },
          { id: 'c2-wd', occurredAt: liveNow - 1 * day, taskSubjectKey: 'cur-2', source: { kind: 'user-feedback' }, objectiveStatus: 'unknown', executionStatus: 'succeeded', metrics: { supplier: { provider: 'traex-agent', model: 'default' }, costUsdMicros: 0, latencyMs: 740 } },
          { id: 'c3-bg', occurredAt: liveNow - 1 * day, taskSubjectKey: 'cur-3', source: { kind: 'automation' }, objectiveStatus: 'unknown', executionStatus: 'succeeded', metrics: { supplier: { provider: 'traex-agent', model: 'default' }, costUsdMicros: 0, latencyMs: 18 } },
        ],
        notificationOutcomeSummary: () => ({
          total: 5,
          outcomes: { delivered: 1, accepted: 2, reacted: 1, rejected: 0, 'expired-unhandled': 1, failed: 0 },
        }),
        intakeEvaluationAgreementSummary: () => ({
          truePositive: 3, falsePositive: 1, decided: 4, agreed: 3, disagreed: 1,
        }),
        listIntakeEvaluationAgreements: () => [
          { evalId: 'e1', outcomeKind: 'agreed' },
          { evalId: 'e2', outcomeKind: 'agreed' },
          { evalId: 'e3', outcomeKind: 'agreed' },
          { evalId: 'e4', outcomeKind: 'disagreed' },
        ],
      },
      personalMemory: { health: () => ({ activeRecords: 8 }) },
      assistantMemoryLearning: { health: () => ({ counts: { adopted: 5, rejected: 1 } }) },
      assistantPreferenceLearning: { health: () => ({ active: 2, hypotheses: 3, rolledBack: 1 }) },
      pluginControlPlane: { health: () => ({ readyPlans: 1, activeActivations: 1, watchingActivations: 0, failed: 0, closedRegressed: 0, closedRetracted: 0, rollbackPending: 0 }) },
    }
    for (const [k, v] of Object.entries(mockServices)) {
      ctx.provide(k as never, v as never)
    }

    const svc = new OwnerConsoleService(ctx, { feishuAppId: '' })
    try {
      const viaService = await svc.growthReport('/ws', 'default', 14)
      const codec = TYPERT.invocations.find(i => i.method === 'growthReport')!.result
      expect(OwnerConsoleGrowthReportSchema.parse(viaService)).toEqual(viaService)
      expect(codec).toBeDefined()
      expect(viaService.overallState).toBe('data')
      expect(viaService.cliCommand).toBe('dsh-rsi growth-report --profile web --since 14d')
      expect(viaService.tasks.totalTasks).toBe(3)
      expect(viaService.tasks.ownerWithdrawals).toBe(1)
      expect(viaService.tasks.reworkTasks).toBe(1)
      expect(viaService.suppliers.suppliers.map(s => s.supplier)).toEqual(['deepseek/deepseek-v4', 'traex-agent/default'])
      expect(viaService.notifications.agreementPpm).toBe(750_000)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('renders GrowthReportCard and switches time windows cleanly', async () => {
    const baseReport = readOwnerConsoleGrowthReport({ get: () => undefined } as never, '', '', 7, 1_800_000_000_000)
    const growthReportMock = vi.fn(async (_ws: string, _pr: string, days: number) => ({
      ok: true as const,
      value: { ...baseReport, sinceDays: days, cliCommand: `dsh-rsi growth-report --since ${days}d` },
    }))
    const remote = { growthReport: growthReportMock } as unknown as ConsoleRemote

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(jsx(GrowthReportCard, { remote }))
    })

    expect(growthReportMock).toHaveBeenCalledWith('', '', 7)
    expect(container.textContent).toContain('成长计分卡（只读）')
    expect(container.textContent).toContain('无数据（未启用/无账本）')
    expect(container.textContent).toContain('dsh-rsi growth-report --since 7d')

    const btn14 = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('最近 14 天'))
    expect(btn14).toBeDefined()
    await act(async () => {
      btn14!.click()
    })
    expect(growthReportMock).toHaveBeenCalledWith('', '', 14)
    expect(container.textContent).toContain('dsh-rsi growth-report --since 14d')

    await act(async () => {
      root.unmount()
    })
  })

  it('integrates cleanly with a real AssistantEvaluationService (default maxQueryLimit=100, real ProjectedOutcome/NotificationOutcomeFeedPage/listIntakeEvaluationAgreements)', async () => {
    const evalModuleUrl = pathToFileURL(resolve(process.cwd(), '../assistant-evaluation/lib/index.js')).href
    const {
      default: AssistantEvaluation,
      EvaluationStore,
    } = await import(evalModuleUrl) as {
      default: unknown
      EvaluationStore: new (options: { path: string }) => {
        append(input: Record<string, unknown>): { id: string }
        notifications: { apply(factInput: unknown, responseWindowMs: number): unknown }
        intakeEvaluations: { applyFeedItem(rawItem: unknown): unknown }
        close(): void
      }
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'owner-console-real-eval-'))
    const dbPath = join(tempDir, 'evaluation.sqlite')
    const now = Date.now()
    const day = 86_400_000
    const scope = { workspace: '/real-ws', preset: 'default' }

    // Seed trusted outcomes, notifications & intake agreements via real EvaluationStore
    const seedStore = new EvaluationStore({ path: dbPath })
    try {
      seedStore.append({
        idempotencyKey: 'fg-prev-1',
        scope,
        situation: 'chat',
        executionStatus: 'succeeded',
        objectiveStatus: 'not-achieved',
        deliveryStatus: 'delivered',
        source: { kind: 'foreground', id: 'turn-prev-1' },
        trust: 'trusted',
        evidence: [{ kind: 'foreground-turn', ref: 'turn-prev-1' }],
        metrics: { supplier: { provider: 'deepseek', model: 'deepseek-v4' }, latencyMs: 250, costUsdMicros: 1200 },
        occurredAt: now - 20 * day,
        evaluator: { id: 'host', version: '1' },
      })
      seedStore.append({
        idempotencyKey: 'fg-prev-fb-1',
        scope,
        situation: 'chat',
        executionStatus: 'succeeded',
        objectiveStatus: 'not-achieved',
        deliveryStatus: 'not-required',
        source: { kind: 'user-feedback', id: 'fb-prev-1' },
        trust: 'trusted',
        evidence: [{ kind: 'foreground-turn', ref: 'turn-prev-1' }],
        metrics: {},
        occurredAt: now - 20 * day + 1000,
        evaluator: { id: 'owner', version: '1' },
      })
      seedStore.append({
        idempotencyKey: 'auto-conflict-exec',
        scope,
        situation: 'auto',
        executionStatus: 'succeeded',
        objectiveStatus: 'unknown',
        deliveryStatus: 'delivered',
        source: { kind: 'automation', id: 'run-c1' },
        trust: 'trusted',
        evidence: [{ kind: 'automation-run', ref: 'run-c1' }],
        metrics: { supplier: { provider: 'deepseek', model: 'deepseek-v4' }, latencyMs: 410, costUsdMicros: 3000, inputTokens: 200, outputTokens: 90, toolCalls: 3 },
        occurredAt: now - 2 * day,
        evaluator: { id: 'automations', version: '1' },
      })
      seedStore.append({
        idempotencyKey: 'auto-conflict-a',
        scope,
        situation: 'auto',
        executionStatus: 'succeeded',
        objectiveStatus: 'achieved',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [{ kind: 'automation-run', ref: 'run-c1' }, { kind: 'delivery-outbox', ref: 'out-a' }],
        metrics: {},
        occurredAt: now - 2 * day + 50,
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      })
      seedStore.append({
        idempotencyKey: 'auto-conflict-b',
        scope,
        situation: 'auto',
        executionStatus: 'succeeded',
        objectiveStatus: 'not-achieved',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [{ kind: 'automation-run', ref: 'run-c1' }, { kind: 'delivery-outbox', ref: 'out-b' }],
        metrics: {},
        occurredAt: now - 2 * day + 100,
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      })

      for (let i = 1; i <= 12; i++) {
        const at = now - 2 * day + i * 1000
        seedStore.notifications.apply({
          auditSequence: i,
          outboxId: `real-notif-${i}`,
          bindingId: 'b-1',
          scope,
          lane: 'proactive',
          sourceId: 'src-1',
          purpose: 'result',
          purposeSource: 'declared',
          verdict: 'would-accept',
          reasons: [],
          auditedAt: at,
          transport: { status: 'delivered', deliveredAt: at + 10 },
          judgement: {
            source: 'owner-objective',
            version: 1,
            objectiveStatus: i <= 9 ? 'achieved' : 'not-achieved',
          },
        }, 86_400_000)
      }

      for (let i = 1; i <= 10; i++) {
        const at = now - 2 * day + i * 1000
        seedStore.intakeEvaluations.applyFeedItem({
          seq: i,
          id: `feed-${i}`,
          recordedAt: at,
          evaluatedAt: at,
          source: 'github',
          sourceEventId: `ev-${i}`,
          ruleId: 'dsh-intake-github-mention-or-review',
          policyVersion: 'v1',
          mode: 'observe',
          evaluationLevel: 'notify',
          wouldAccept: true,
          metadataDigest: 'a'.repeat(64),
          sourceDigest: 'b'.repeat(64),
          scope,
          ...(i <= 6
            ? { acceptanceVerdict: { objectiveStatus: 'achieved', receiptDigest: 'c'.repeat(64), completedAt: at + 10, recordedAt: at + 10 } }
            : i <= 8
              ? { acceptanceVerdict: { objectiveStatus: 'not-achieved', receiptDigest: 'd'.repeat(64), completedAt: at + 10, recordedAt: at + 10 } }
              : {}),
        })
      }
    } finally {
      seedStore.close()
    }

    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      await ctx.plugin(AssistantEvaluation as never, {
        databasePath: dbPath,
        notificationOutcomesEnabled: true,
        intakeEvaluationAgreementEnabled: true,
      } as never)

      // 1. Live service RPC path (without loader.entries() databasePath)
      const svc = new OwnerConsoleService(ctx, { feishuAppId: '' })
      const viaLiveService = await svc.growthReport('/real-ws', 'default', 14)
      expect(OwnerConsoleGrowthReportSchema.parse(viaLiveService)).toEqual(viaLiveService)
      expect(viaLiveService.tasks.state).toBe('data')
      expect(viaLiveService.tasks.totalTasks).toBe(1)
      expect(viaLiveService.tasks.conflicted).toBe(1)
      expect(viaLiveService.tasks.previousTotalTasks).toBe(1)
      expect(viaLiveService.tasks.previousCorrectionRatePpm).toBe(1_000_000)
      expect(viaLiveService.memoryLaneGate.status).toBe('attention-needed')
      expect(viaLiveService.suppliers.totalRuns).toBe(1)
      expect(viaLiveService.suppliers.suppliers[0]?.supplier).toBe('deepseek/deepseek-v4')
      expect(viaLiveService.notifications.total).toBe(12)
      expect(viaLiveService.notifications.wouldAcceptTotal).toBe(10)
      expect(viaLiveService.notifications.agreementDecided).toBe(8)
      expect(viaLiveService.notifications.holdoutDecidedSamples).toBeGreaterThan(0)

      // 2. File-backed SQLite fast path (with profileContext + loader.entries() exposing databasePath, even when workspace='' preset='')
      ctx.provide('profileContext' as never, { home: tempDir, name: 'web' } as never)
      ctx.provide('loader' as never, {
        entries: () => [{ options: { name: '@dsh-enhanced/assistant-evaluation', config: { databasePath: dbPath } } }],
      } as never)
      const viaSqlite = await svc.growthReport('', '', 14)
      expect(OwnerConsoleGrowthReportSchema.parse(viaSqlite)).toEqual(viaSqlite)
      expect(viaSqlite.resolvedScope).toEqual(scope)
      expect(viaSqlite.tasks.totalTasks).toBe(1)
      expect(viaSqlite.tasks.conflicted).toBe(1)
      expect(viaSqlite.notifications.wouldAcceptTotal).toBe(10)
      expect(viaSqlite.notifications.holdoutDecidedSamples).toBe(viaLiveService.notifications.holdoutDecidedSamples)
    } finally {
      await ctx.fiber.dispose()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects directory-symlink escapes outside $DSH_HOME, matches CLI control-plane multi-ledger counts, and handles legacy v4 evaluation_task_projections', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'owner-console-home-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'owner-console-outside-'))
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000

    try {
      mkdirSync(join(homeDir, 'profiles', 'web'), { recursive: true })
      mkdirSync(join(outsideDir, 'secret'), { recursive: true })

      // Seed outside SQLite and create a directory symlink inside $DSH_HOME -> outside
      const leakedMemPath = join(outsideDir, 'secret', 'memory.sqlite')
      const leakedDb = new DatabaseSync(leakedMemPath)
      try {
        leakedDb.exec('CREATE TABLE memory_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
        leakedDb.prepare('INSERT INTO memory_records VALUES (?,?,?,?,?)').run('leak-1', 'active', '{"src":"leak"}', now - day, now - day)
      } finally {
        leakedDb.close()
      }
      symlinkSync(join(outsideDir, 'secret'), join(homeDir, 'linked-memory'))

      // Seed legacy v4 evaluation_task_projections (no learning_disposition, no split outcome refs)
      mkdirSync(join(homeDir, 'assistant-evaluation'), { recursive: true })
      const evalPath = join(homeDir, 'assistant-evaluation', 'evaluation.sqlite')
      const evalDb = new DatabaseSync(evalPath)
      try {
        evalDb.exec(`
          CREATE TABLE evaluation_outcomes (
            id TEXT PRIMARY KEY,
            scope_key TEXT NOT NULL,
            objective_status TEXT NOT NULL,
            execution_status TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            evaluator_id TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            cost_usd_micros INTEGER,
            latency_ms INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            tool_calls INTEGER,
            occurred_at INTEGER NOT NULL,
            task_subject_key TEXT
          );
          CREATE TABLE evaluation_task_projections (
            subject_key TEXT PRIMARY KEY,
            scope_key TEXT NOT NULL,
            subject_kind TEXT NOT NULL,
            subject_ref TEXT NOT NULL,
            primary_outcome_id TEXT,
            objective_conflicted INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
          );
        `)
        evalDb.prepare('INSERT INTO evaluation_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run('v4-out-1', 's', 'achieved', 'succeeded', 'foreground', 'eval-v4', '{"retries":1}', '[]', 500, 150, 20, 30, 1, now - 2 * day, 'v4-subj-1')
        evalDb.prepare('INSERT INTO evaluation_task_projections VALUES (?,?,?,?,?,?,?)')
          .run('v4-subj-1', 's', 'outcome', 'v4-out-1', 'v4-out-1', 0, now - 2 * day)
      } finally {
        evalDb.close()
      }

      // Seed control-plane statePath with control.sqlite + creation-adoptions.sqlite + revision-adoptions.sqlite
      const cpStateDir = join(homeDir, 'cp-state')
      mkdirSync(cpStateDir, { recursive: true })
      const controlDb = new DatabaseSync(join(cpStateDir, 'control.sqlite'))
      try {
        controlDb.exec(`
          CREATE TABLE source_plans (id TEXT PRIMARY KEY, status TEXT NOT NULL, checked_tree_digest TEXT, updated_at INTEGER NOT NULL);
          CREATE TABLE activation_plans (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
        `)
        controlDb.prepare('INSERT INTO source_plans VALUES (?,?,?,?)').run('sp-1', 'ready-for-human-review', 'a'.repeat(64), now - 2 * day)
        controlDb.prepare('INSERT INTO activation_plans VALUES (?,?,?)').run('ap-1', 'activated', now - 2 * day)
      } finally {
        controlDb.close()
      }
      const creationDb = new DatabaseSync(join(cpStateDir, 'creation-adoptions.sqlite'))
      try {
        creationDb.exec('CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, receipt_json TEXT)')
        creationDb.prepare('INSERT INTO adoptions VALUES (?,?,?)').run('ca-1', 'active', JSON.stringify({ adoptedAt: now - day }))
        creationDb.prepare('INSERT INTO adoptions VALUES (?,?,?)').run('ca-2', 'rejected', JSON.stringify({ issuedAt: now - day }))
        creationDb.prepare('INSERT INTO adoptions VALUES (?,?,?)').run('ca-old', 'active', JSON.stringify({ adoptedAt: now - 60 * day }))
      } finally {
        creationDb.close()
      }
      const revisionDb = new DatabaseSync(join(cpStateDir, 'revision-adoptions.sqlite'))
      try {
        revisionDb.exec(`
          CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, claimed_at INTEGER NOT NULL, settled_at INTEGER);
          CREATE TABLE rollbacks (seq INTEGER PRIMARY KEY, rollback_id TEXT NOT NULL, at INTEGER NOT NULL);
        `)
        revisionDb.prepare('INSERT INTO adoptions VALUES (?,?,?,?)').run('ra-1', 'closed', now - 3 * day, now - 2 * day)
        revisionDb.prepare('INSERT INTO rollbacks VALUES (?,?,?)').run(1, 'rb-1', now - day)
      } finally {
        revisionDb.close()
      }

      const host = {
        get: (name: string) => {
          if (name === 'profileContext') return { home: homeDir, dir: join(homeDir, 'profiles', 'web'), name: 'web' }
          if (name === 'loader') {
            return {
              entries: () => [
                { options: { name: '@dsh-enhanced/personal-memory', config: { databasePath: join(homeDir, 'linked-memory', 'memory.sqlite') } } },
                { options: { name: '@dsh-enhanced/preference-learning', config: { databasePath: leakedMemPath } } },
                { options: { name: '@dsh-enhanced/assistant-evaluation', config: { databasePath: evalPath } } },
                { options: { name: '@dsh-enhanced/plugin-control-plane', config: { statePath: cpStateDir } } },
              ],
            }
          }
          return undefined
        },
      } as never

      const report = readOwnerConsoleGrowthReport(host, '', '', 14, now)
      expect(OwnerConsoleGrowthReportSchema.parse(report)).toEqual(report)
      // Symlinked directory and direct outside path both rejected -> memory remains no-data with 0 leaked records
      expect(report.memory.state).toBe('no-data')
      expect(report.memory.activeMemoriesTotal).toBe(0)
      expect(report.tasks).toMatchObject({
        state: 'data',
        totalTasks: 1,
        achieved: 1,
        reworkTasks: 1,
      })
      // Exact parity with CLI control-plane multi-ledger counts
      expect(report.candidates).toMatchObject({
        state: 'data',
        generated: 2,
        verificationPassed: 2,
        verificationFailed: 1,
        adopted: 2,
        rolledBack: 1,
      })

      // Also enforce $DSH_HOME containment when profileContext/settings are absent on host (via DSH_HOME env)
      const prevEnvHome = process.env['DSH_HOME']
      process.env['DSH_HOME'] = homeDir
      try {
        const envOnlyHost = {
          get: (name: string) => {
            if (name === 'loader') {
              return {
                entries: () => [
                  { options: { name: '@dsh-enhanced/personal-memory', config: { databasePath: leakedMemPath } } },
                  { options: { name: '@dsh-enhanced/preference-learning', config: { databasePath: join(homeDir, 'linked-memory', 'memory.sqlite') } } },
                ],
              }
            }
            return undefined
          },
        } as never
        const envReport = readOwnerConsoleGrowthReport(envOnlyHost, '', '', 14, now)
        expect(envReport.memory.state).toBe('no-data')
        expect(envReport.memory.activeMemoriesTotal).toBe(0)
      } finally {
        if (prevEnvHome === undefined) delete process.env['DSH_HOME']
        else process.env['DSH_HOME'] = prevEnvHome
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('resolves Cordis Loader !!js dshHomePath(__jsExpr) entries for preference-learning, personal-memory, and evaluation', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'owner-console-jsexpr-'))
    const now = Date.parse('2026-11-18T00:00:00Z')
    const day = 86_400_000
    try {
      mkdirSync(join(homeDir, 'personal-memory'), { recursive: true })
      const memDb = new DatabaseSync(join(homeDir, 'personal-memory', 'memory.sqlite'))
      try {
        memDb.exec('CREATE TABLE memory_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
        for (let i = 1; i <= 5; i++) {
          memDb.prepare('INSERT INTO memory_records VALUES (?,?,?,?,?)').run(`m-${i}`, 'active', '{"turn":"t1"}', now - day, now - day)
        }
      } finally {
        memDb.close()
      }

      mkdirSync(join(homeDir, 'preference-learning'), { recursive: true })
      const prefDb = new DatabaseSync(join(homeDir, 'preference-learning', 'preferences.sqlite'))
      try {
        prefDb.exec(`
          CREATE TABLE preference_hypotheses (id TEXT PRIMARY KEY, effect_state TEXT NOT NULL);
          CREATE TABLE preference_exposures (idempotency_key TEXT PRIMARY KEY, state TEXT NOT NULL, exposed_at INTEGER NOT NULL);
          CREATE TABLE preference_signals (id TEXT PRIMARY KEY, stance TEXT NOT NULL, actor_trust TEXT NOT NULL, occurred_at INTEGER NOT NULL);
        `)
        prefDb.prepare('INSERT INTO preference_hypotheses VALUES (?,?)').run('h-1', 'active')
        for (let i = 1; i <= 6; i++) {
          prefDb.prepare('INSERT INTO preference_exposures VALUES (?,?,?)').run(`exp-${i}`, 'bound', now - day + i)
        }
        for (let i = 1; i <= 10; i++) {
          prefDb.prepare('INSERT INTO preference_signals VALUES (?,?,?,?)').run(`sig-${i}`, 'contradict', 'owner-authenticated', now - 10 * day + i)
        }
      } finally {
        prefDb.close()
      }

      const host = {
        get: (name: string) => {
          if (name === 'profileContext') return { home: homeDir, name: 'web' }
          if (name === 'loader') {
            return {
              entries: () => [
                {
                  options: {
                    name: '@dsh-enhanced/personal-assistant',
                    config: {
                      personalMemory: { databasePath: { __jsExpr: "dshHomePath('personal-memory/memory.sqlite')" } },
                    },
                  },
                },
                {
                  options: {
                    name: '@dsh-enhanced/preference-learning',
                    config: {
                      databasePath: { __jsExpr: "dshHomePath('preference-learning/preferences.sqlite')" },
                    },
                  },
                },
              ],
            }
          }
          return undefined
        },
      } as never

      const report = readOwnerConsoleGrowthReport(host, '', '', 14, now)
      expect(OwnerConsoleGrowthReportSchema.parse(report)).toEqual(report)
      expect(report.memory.state).toBe('data')
      expect(report.memory.sourcedMemories).toBe(5)
      expect(report.memory.activePreferenceOverlays).toBe(1)
      expect(report.memory.promptExposures).toBe(6)
      expect(report.memory.sameClassCorrectionTrend).toBe('reduced')
      expect(report.memoryLaneGate.status).toBe('passed')
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})
