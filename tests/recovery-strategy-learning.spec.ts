import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HostRecoveryRunbookPort,
  RECOVERY_CATALOG_DIGEST,
  RECOVERY_SYSTEM_OWNER,
  RecoveryExecutor,
  RecoveryStore,
  type NormalizedRecoveryJob,
  type RecoveryRuntimePorts,
} from '@dsh-enhanced/assistant-recovery'
import {
  acceptanceDigest,
  goalDefinitionSituation,
} from '@dsh-enhanced/task-acceptance-contract'
import { GoalStrategyStore } from '../plugins/assistant-goals/lib/strategy-store.js'
import { EvolutionStore } from '../plugins/assistant-evolution/lib/store.js'
import { canonicalEvolutionScope } from '../plugins/assistant-evolution/lib/service.js'

/**
 * Real three-database integration for the recovery runbook's read-only
 * `strategy-learning` step (G2 phase 2).
 *
 * Every durable ledger is the production SQLite implementation:
 *   - goals StrategyStore (settled advice ledger),
 *   - evolution Store (trusted evaluation-outcome episodes),
 *   - recovery Store (durable run/step journal).
 * The real HostRecoveryRunbookPort joins the first two through its production
 * host seams, and the real RecoveryExecutor drives all eight catalog steps.
 *
 * Only genuinely external *services* are replaced by local fakes: the
 * automations owner projection, the Delivery owner-route receipt, Evaluation
 * health (no projection seam is registered), the preference owner fence and
 * the global health snapshot. Those fakes are the engineering boundary around
 * the runbook, not learning evidence: the strategy-learning result is derived
 * solely from rows really written to the goals and evolution databases.
 * Nothing here mints a candidate or widens a permission.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`))
  roots.push(root)
  return root
}

const hash = (value: string) => value.repeat(64)

const workspace = '/workspace'
const preset = 'owner'
const principal = 'lark/main/tenant/owner'
const principalLineage = Object.freeze({
  principalRecordId: 'principal-row-1',
  principalVersion: 1,
})
const goalScope = Object.freeze({
  principalId: principal,
  principalRecordId: principalLineage.principalRecordId,
  principalVersion: principalLineage.principalVersion,
  workspace,
  preset,
})
const evolutionScopeKey = canonicalEvolutionScope(workspace, preset)

const intentBase = {
  parentRunId: 'run-a',
  parentSessionId: 'session-parent',
  definitionVersion: 1,
  kind: 'investigate' as const,
  provider: 'provider',
  model: 'model-id',
  maxChildren: 2,
  maxDurationMs: 300_000,
}

const completedChild = {
  stopReason: 'complete' as const,
  quiescent: true,
  diagnostics: { toolRejections: 0, output: 'accepted' as const },
}

function settleAdvice(
  store: GoalStrategyStore,
  input: {
    id: string
    goalId: string
    definitionDigest: string
    requestDigest: string
    outputDigest: string
    createdAt: number
    completedAt: number
  },
): void {
  store.prepare({
    ...intentBase,
    id: input.id,
    goalId: input.goalId,
    definitionDigest: input.definitionDigest,
    scope: goalScope,
    requestDigest: input.requestDigest,
    createdAt: input.createdAt,
    expiresAt: input.createdAt + 300_000,
  })
  store.dispatch(input.id, 1, input.createdAt + 1)
  store.bindChild(input.id, 2, `child-${input.id}`, input.createdAt + 2)
  store.settle(
    input.id,
    3,
    {
      children: [{ sessionId: `child-${input.id}`, ...completedChild }],
      outcome: 'advice',
      outputDigest: input.outputDigest,
      quiescent: true,
      terminationReason: 'completed',
    },
    input.completedAt,
  )
}

function trustedGoalOutcomeEpisode(
  store: EvolutionStore,
  situationValue: string,
  outcome: 'succeeded' | 'failed',
  index: number,
): void {
  const subjectRef = JSON.stringify(['evaluation-outcome', situationValue, index])
  const digest = createHash('sha256')
    .update(JSON.stringify({ scopeKey: evolutionScopeKey, subjectRef, situation: situationValue, outcome }))
    .digest('hex')
  store.applyTaskLearningProjection({
    scopeKey: evolutionScopeKey,
    scopeWatermark: index,
    subjectKind: 'goal-outcome',
    subjectRef,
    version: 1,
    digest,
    disposition: 'upsert',
    situation: situationValue,
    outcome,
    detail: `authoritative evaluation outcome ${index}`,
    evidenceRef: `evaluation:${situationValue}:${index}`,
    occurredAt: 1_000 + index,
  })
}

function healthReport() {
  return Object.freeze({
    ready: true,
    severity: 'healthy' as const,
    generatedAt: 10,
    providers: Object.freeze(
      ['assistantAutomations', 'assistantEvaluation', 'preferenceLearning',
        'assistantEvolution', 'assistantRecovery']
        .map(id => Object.freeze({ id, status: 'ready' as const, metrics: Object.freeze({}) })),
    ),
    assessments: Object.freeze([]),
    warnings: Object.freeze([]),
  })
}

interface Harness {
  recovery: RecoveryStore
  goals: GoalStrategyStore
  evolution: EvolutionStore
  runRun: (mode?: 'production' | 'preview') => ReturnType<RecoveryExecutor['execute']>
}

function harness(): Harness {
  const recovery = new RecoveryStore({
    path: join(tempRoot('recovery-sl-recovery'), 'recovery.sqlite'),
    now: () => 1_000,
  })
  const goals = new GoalStrategyStore(
    join(tempRoot('recovery-sl-goals'), 'strategy.sqlite'),
  )
  const evolution = new EvolutionStore({
    path: join(tempRoot('recovery-sl-evolution'), 'evolution.sqlite'),
  })

  const runtime: RecoveryRuntimePorts = {
    automations: {
      inspectSystemOwned: () => Object.freeze({
        owner: RECOVERY_SYSTEM_OWNER,
        automationId: 'recovery:supervised-growth',
        automationStatus: 'active' as const,
        definitionHash: hash('a'),
        definitionVersion: 1,
        latestTerminalRuns: Object.freeze({}),
      }),
    },
    delivery: {
      validateOwnerRoute: input => Object.freeze({
        receiptVersion: 2 as const,
        authorityId: input.authorityId,
        authorityHash: hash('f'),
        principalId: input.principalId,
        principalRecordId: principalLineage.principalRecordId,
        principalVersion: principalLineage.principalVersion,
        workspace: input.workspace,
        agentPreset: input.agentPreset,
        bindingVersion: 1,
        generation: 1,
      }),
    },
    evaluation: {
      // No peek/reconcile seam: ledger-reconcile must fall back to its read-only
      // no-op instead of inventing a projection to apply.
      health: () => ({ ready: true }) as never,
    },
    evolution: {
      hostCandidates: () => [],
      hostListRules: () => [],
      hostRollbackOne: () => {
        throw new Error('rollback seam must not be called with no regression candidate')
      },
      // Production seam delegated to the real evolution SQLite ledger. The
      // recovery port only passes the branded host scope; the read window is
      // the host service's own fixed evaluation window, here fixed at 100.
      hostGoalDefinitionEpisodes: input =>
        evolution.summarizeGoalDefinitionEpisodes({
          scopeKey: canonicalEvolutionScope(input.scope.workspace, input.scope.preset),
          window: 100,
        }),
    },
    goals: {
      // Production seam delegated to the real goals SQLite ledger.
      hostSummarizeAdviceByDefinition: goalScopeValue =>
        goals.summarizeAdviceByDefinition(goalScopeValue),
    },
    preference: {
      health: () => ({ ready: true }) as never,
      hostActivationCandidate: () => undefined,
      hostActivateOne: () => {
        throw new Error('activation seam must not be called with no preference candidate')
      },
      hostMaintainOne: () => ({
        deletedSignals: 0,
        replayed: false,
        ownerGeneration: 1,
        principalLineageId: principalLineage.principalRecordId,
        principalLineageVersion: principalLineage.principalVersion,
      }),
      hostOwnerFence: () => ({ ownerGeneration: 1, principalLineage }),
      hostReview: () => ({ hypotheses: [], activeOverlay: undefined }),
    },
    health: {
      hostGlobalSnapshot: () => healthReport() as never,
    },
  }

  // Preview execution is admitted only when the configured job itself is in
  // the preview activation state; production requires active. The automations
  // projection still reports active in both modes (preview is an execution
  // mode, not an automation lifecycle state).
  const baseJob: NormalizedRecoveryJob = Object.freeze({
    id: 'supervised-growth',
    activationState: 'active',
    activationNonce: 'activation-1',
    catalogDigest: RECOVERY_CATALOG_DIGEST,
    workspace,
    preset,
    principal,
    ownerRouteId: 'owner-route',
    cron: '0 */2 * * *',
    timezone: 'UTC',
    budgetId: 'growth-runs',
    budgetAmount: 1,
  })
  const makePort = (activationState: 'active' | 'preview') => new HostRecoveryRunbookPort(
    new Map([['recovery:supervised-growth', { ...baseJob, activationState }]]),
    runtime,
    new Map([['recovery:supervised-growth', hash('e')]]),
    new Map([['recovery:supervised-growth', hash('f')]]),
  )
  const productionExecutor = new RecoveryExecutor(recovery, makePort('active'), 10_000)
  const previewExecutor = new RecoveryExecutor(recovery, makePort('preview'), 10_000)

  return {
    recovery,
    goals,
    evolution,
    runRun(mode: 'production' | 'preview' = 'production') {
      const executor = mode === 'preview' ? previewExecutor : productionExecutor
      return executor.execute({
        occurrenceId: `occurrence-${mode}`,
        automationId: 'recovery:supervised-growth',
        definitionHash: hash('a'),
        executionMode: mode,
        targetScope: { workspace, preset },
        principal,
        ownerRouteId: 'owner-route',
        activationNonce: 'activation-1',
        activationPlanDigest: hash('e'),
        catalogDigest: RECOVERY_CATALOG_DIGEST,
        signal: new AbortController().signal,
      })
    },
  }
}

describe('recovery strategy-learning across the real goals, evolution and recovery databases', () => {
  it('runs the whole eight-step runbook and records repeated-and-failing signals from the real ledgers', async () => {
    const harnessInstance = harness()

    const objective = 'Draft the weekly sales summary from the CRM export.'
    const definitionDigest = acceptanceDigest({ objective })
    const situation = goalDefinitionSituation(definitionDigest)

    // Two goal instances, three settled advice runs, one recurring request
    // digest (3 runs - 1 distinct request = 2 repeated runs).
    settleAdvice(harnessInstance.goals, { id: 's1', goalId: 'goal-1', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 1, completedAt: 10 })
    settleAdvice(harnessInstance.goals, { id: 's2', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'd'.repeat(64), createdAt: 2, completedAt: 20 })
    settleAdvice(harnessInstance.goals, { id: 's3', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 3, completedAt: 30 })

    // Three authoritative evaluation failures for the same content-bound
    // definition — the only side permitted to establish learning evidence.
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 1)
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 2)
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 3)

    const result = await harnessInstance.runRun()

    expect(result.status).toBe('succeeded')
    expect(result.resultCode).toBe('runbook-complete')
    expect(result.steps).toHaveLength(8)
    expect(result.steps.map(step => step.stepId)).toEqual([
      'authority-admission',
      'ledger-reconcile',
      'retention-maintenance',
      't1-effects',
      'regression-rollback',
      'incident-review',
      'strategy-learning',
      'verification',
    ])

    const learning = harnessInstance.recovery.getStep(result.run.id, 'strategy-learning')!
    expect(learning).toMatchObject({
      status: 'succeeded',
      resultCode: 'strategy-learning-signals',
      action: { kind: 'observe-strategy-learning' },
    })
    expect(learning.idempotencyKey).toBe('recovery:4:occurrence-production:strategy-learning')
    expect(learning.afterDigest).toMatch(/^[a-f0-9]{64}$/u)

    // The read-only step is the only thing that ran for the learning signal:
    // no evolution rule was adopted and no permission row was written.
    expect(harnessInstance.evolution.listRules(evolutionScopeKey)).toEqual([])
    expect(result.steps.map(step => `${step.stepId}:${step.status}:${step.resultCode}`)).toEqual([
      'authority-admission:succeeded:authority-verified',
      'ledger-reconcile:noop:projection-seam-unavailable',
      'retention-maintenance:noop:no-expired-preference',
      't1-effects:noop:no-preference-candidate',
      'regression-rollback:noop:no-regression-candidate',
      'incident-review:noop:circuit-canary-seam-unavailable',
      'strategy-learning:succeeded:strategy-learning-signals',
      'verification:succeeded:health-verified',
    ])

    harnessInstance.recovery.close()
    harnessInstance.goals.close()
    harnessInstance.evolution.close()
  })

  it('records a plain observation when trusted episodes exist but advice does not repeat', async () => {
    const harnessInstance = harness()

    const situation = goalDefinitionSituation(
      acceptanceDigest({ objective: 'An objective whose advice never repeats.' }),
    )
    // Three trusted failures, but every advice run carries a distinct request
    // digest, so repeatedAdviceRuns stays 0.
    for (const [index, request] of ['1', '2', '3'].entries()) {
      settleAdvice(harnessInstance.goals, {
        id: `s${index}`,
        goalId: `goal-${index}`,
        definitionDigest: situation.slice('goal-definition:'.length),
        requestDigest: request.repeat(64),
        outputDigest: 'c'.repeat(64),
        createdAt: index + 1,
        completedAt: (index + 1) * 10,
      })
    }
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 1)
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 2)
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 3)

    const result = await harnessInstance.runRun()

    expect(result.status).toBe('succeeded')
    expect(harnessInstance.recovery.getStep(result.run.id, 'strategy-learning'))
      .toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-observed' })

    harnessInstance.recovery.close()
    harnessInstance.goals.close()
    harnessInstance.evolution.close()
  })

  it('never flags signals from goals-side advice repetition without trusted episodes', async () => {
    const harnessInstance = harness()

    const definitionDigest = acceptanceDigest({ objective: 'Repeating advice with no authoritative outcome.' })
    settleAdvice(harnessInstance.goals, { id: 's1', goalId: 'goal-1', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 1, completedAt: 10 })
    settleAdvice(harnessInstance.goals, { id: 's2', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'd'.repeat(64), createdAt: 2, completedAt: 20 })
    settleAdvice(harnessInstance.goals, { id: 's3', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 3, completedAt: 30 })
    // Deliberately no trusted evaluation episodes at all.

    const result = await harnessInstance.runRun()

    expect(result.status).toBe('succeeded')
    expect(harnessInstance.recovery.getStep(result.run.id, 'strategy-learning'))
      .toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-observed' })
    expect(harnessInstance.evolution.listRules(evolutionScopeKey)).toEqual([])

    harnessInstance.recovery.close()
    harnessInstance.goals.close()
    harnessInstance.evolution.close()
  })

  it('executes the read-only observation for real in preview while suppressing the planned mutation', async () => {
    const harnessInstance = harness()

    const situation = goalDefinitionSituation(
      acceptanceDigest({ objective: 'Preview must still observe real failures.' }),
    )
    const definitionDigest = situation.slice('goal-definition:'.length)
    settleAdvice(harnessInstance.goals, { id: 's1', goalId: 'goal-1', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 1, completedAt: 10 })
    settleAdvice(harnessInstance.goals, { id: 's2', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'd'.repeat(64), createdAt: 2, completedAt: 20 })
    settleAdvice(harnessInstance.goals, { id: 's3', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 3, completedAt: 30 })
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 1)
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 2)
    trustedGoalOutcomeEpisode(harnessInstance.evolution, situation, 'failed', 3)

    const result = await harnessInstance.runRun('preview')

    expect(result.status).toBe('succeeded')
    expect(result.resultCode).toBe('preview-verified')
    expect(harnessInstance.recovery.getStep(result.run.id, 'strategy-learning'))
      .toMatchObject({ status: 'succeeded', resultCode: 'strategy-learning-signals' })
    // Only retention-maintenance plans a real mutation action, so only it is
    // suppressed at execute time. The other four mutation steps already
    // declined at plan time (no seams/candidates) and keep their own no-op
    // reason codes; the three read-only steps execute for real in preview.
    expect(result.steps.map(step => `${step.stepId}:${step.status}:${step.resultCode}`)).toEqual([
      'authority-admission:succeeded:authority-verified',
      'ledger-reconcile:noop:projection-seam-unavailable',
      'retention-maintenance:noop:preview-suppressed',
      't1-effects:noop:no-preference-candidate',
      'regression-rollback:noop:no-regression-candidate',
      'incident-review:noop:circuit-canary-seam-unavailable',
      'strategy-learning:succeeded:strategy-learning-signals',
      'verification:succeeded:health-verified',
    ])

    harnessInstance.recovery.close()
    harnessInstance.goals.close()
    harnessInstance.evolution.close()
  })
})
