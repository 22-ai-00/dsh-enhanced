import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  AssistantWorkItemsService,
  classifyIntake,
  type Config as WorkItemsConfig,
  type WorkItemIntakeEvaluatorRegistration,
} from '@dsh-enhanced/assistant-work-items'
import {
  DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG,
  emitAssociationIntakeSignal,
  ensureIntakeSignalSchema,
  listIntakeSignals,
  normalizeAssociationIntakeSignalConfig,
  type IntakeSignalNodeRef,
  type IntakeSignalPolicyPeer,
  type IntakeSignalPolicyRequest,
  type IntakeSignalWorkItemsPeer,
} from '../src/intake-signal.js'
import { openAssociationDatabase } from '../src/sqlite.js'
import {
  computeOwnerScopeKey,
  computePrincipalDigest,
  type AssociationOwnerScope,
} from '../src/types.js'

const tempDirs: string[] = []
const contexts: Context[] = []

function makeTempDir(prefix = 'assoc-intake-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeScope(label = 'owner-intake'): AssociationOwnerScope {
  const principalId = `principal:${label}`
  const principalDigest = computePrincipalDigest(principalId)
  const principalRecordId = `pr-${label}`
  const principalVersion = 1
  const workspace = `/ws/${label}`
  const agentPreset = 'primary'
  return {
    mode: 'delivery',
    ownerScopeKey: computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest,
      principalRecordId,
      principalVersion,
      workspace,
      agentPreset,
    }),
    principalId,
    principalDigest,
    principalRecordId,
    principalVersion,
    workspace,
    agentPreset,
    authorityId: `auth-${label}`,
  }
}

function makeNodeRef(
  scope: AssociationOwnerScope,
  id: string,
  kind: IntakeSignalNodeRef['kind'],
  title: string,
  overrides?: Partial<IntakeSignalNodeRef>,
): IntakeSignalNodeRef {
  return {
    id,
    kind,
    ownerScopeKey: scope.ownerScopeKey,
    sensitivity: 'private',
    status: 'active',
    title,
    expiresAt: null,
    ...overrides,
  }
}

describe('intake-signal gates, schema, and closed 10-key contract', () => {
  test('defaults to disabled and enforces holdout, node eligibility, score, policy, budget, cooldown, and hourly cap', () => {
    expect(DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG).toEqual({
      enabled: false,
      minScore: 0.75,
      maxSignalsPerHour: 10,
      cooldownMs: 3_600_000,
      maxSummaryBytes: 1024,
      sourceId: 'assistant-association',
    })

    const db = openAssociationDatabase(':memory:')
    try {
      ensureIntakeSignalSchema(db)
      const scope = makeScope('gates')
      const goalNode = makeNodeRef(scope, 'a:g-1', 'goal', 'Ship nightly regression suite')
      const targetNode = makeNodeRef(
        scope,
        'a:e-1',
        'episode',
        'Flaky test failure in CI pipeline sk-secret1234567890abcdef',
      )
      const nowMs = 1_700_000_000_000

      const recordCalls: Array<{ input: unknown; text?: string }> = []
      const mockWorkItems: IntakeSignalWorkItemsPeer = {
        recordIntake: (input, text) => {
          recordCalls.push({ input, ...(text !== undefined ? { text } : {}) })
          return {
            record: {
              source: input.source,
              sourceEventId: input.sourceEventId,
              kind: input.kind,
              decision: 'stored',
              strength: 'inferred',
              strengthReason: 'allowlisted-unaddressed',
              contentDigest: input.contentDigest,
            },
            replayed: false,
          }
        },
      }
      const policyRequests: IntakeSignalPolicyRequest[] = []
      const allowPolicy: IntakeSignalPolicyPeer = {
        getEmergencyStop: () => ({ enabled: false }),
        authorize: (req) => {
          policyRequests.push(req)
          return { effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-intake' }
        },
      }

      // 1. Disabled -> no-op
      const disabledRes = emitAssociationIntakeSignal({
        db,
        scope,
        config: DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG,
        goalNode,
        targetNode,
        score: 0.95,
        inHoldout: false,
        policy: allowPolicy,
        assistantWorkItems: mockWorkItems,
        nowMs,
      })
      expect(disabledRes).toMatchObject({ emitted: false, outcome: 'disabled' })
      expect(recordCalls).toHaveLength(0)

      const cfg = normalizeAssociationIntakeSignalConfig({
        enabled: true,
        minScore: 0.75,
        maxSignalsPerHour: 2,
        cooldownMs: 60_000,
        maxSummaryBytes: 256,
      })

      // 2. Sealed holdout -> blocked
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode,
          score: 0.95,
          inHoldout: true,
          policy: allowPolicy,
          assistantWorkItems: mockWorkItems,
          nowMs,
        }),
      ).toMatchObject({ emitted: false, outcome: 'holdout-blocked' })

      // 3. Sensitive target / non-goal goalNode -> blocked
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode: makeNodeRef(scope, 'a:e-sens', 'episode', 'Private', {
            sensitivity: 'sensitive',
          }),
          score: 0.95,
          inHoldout: false,
          policy: allowPolicy,
          assistantWorkItems: mockWorkItems,
          nowMs,
        }),
      ).toMatchObject({ emitted: false, outcome: 'ineligible-node' })

      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode: makeNodeRef(scope, 'a:m-1', 'memory', 'Not a goal'),
          targetNode,
          score: 0.95,
          inHoldout: false,
          policy: allowPolicy,
          assistantWorkItems: mockWorkItems,
          nowMs,
        }),
      ).toMatchObject({ emitted: false, outcome: 'ineligible-node' })

      // 4. Below threshold -> blocked
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode,
          score: 0.74,
          inHoldout: false,
          policy: allowPolicy,
          assistantWorkItems: mockWorkItems,
          nowMs,
        }),
      ).toMatchObject({ emitted: false, outcome: 'score-below-threshold' })

      // 5. Missing policy -> fail closed
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode,
          score: 0.9,
          inHoldout: false,
          assistantWorkItems: mockWorkItems,
          nowMs,
        }),
      ).toMatchObject({ emitted: false, outcome: 'policy-unavailable' })

      // 6. Emergency stop -> blocked
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode,
          score: 0.9,
          inHoldout: false,
          policy: { ...allowPolicy, getEmergencyStop: () => ({ enabled: true }) },
          assistantWorkItems: mockWorkItems,
          nowMs,
        }),
      ).toMatchObject({ emitted: false, outcome: 'emergency-stop' })

      // 7. Policy deny -> blocked & checks closed 'automation' resource kind
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode,
          score: 0.9,
          inHoldout: false,
          policy: {
            getEmergencyStop: () => ({ enabled: false }),
            authorize: (req) => {
              policyRequests.push(req)
              return { effect: 'deny', reasonCode: 'default-deny' }
            },
          },
          assistantWorkItems: mockWorkItems,
          nowMs,
        }),
      ).toMatchObject({
        emitted: false,
        outcome: 'policy-denied',
        policyReasonCode: 'default-deny',
      })
      expect(policyRequests[0]).toEqual({
        subject: {
          kind: 'background',
          id: 'assistant-association',
          workspace: scope.workspace,
          principal: scope.principalId,
        },
        action: 'intake-observe',
        resource: {
          kind: 'automation',
          id: 'assistant-association:intake-signal',
        },
        context: { initiator: 'background' },
      })

      // 8. Budget check fails closed if budget unavailable or limit too low
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode,
          score: 0.9,
          inHoldout: false,
          policy: {
            ...allowPolicy,
            getBudgetConfig: () => undefined,
          },
          budgetId: 'intake-budget',
          assistantWorkItems: mockWorkItems,
          nowMs,
        }),
      ).toMatchObject({ emitted: false, outcome: 'budget-unavailable' })
      expect(recordCalls).toHaveLength(0)

      // 9. Successful emission constructs exact 10-key WorkItemIntakeInput accepted by classifyIntake
      const ok1 = emitAssociationIntakeSignal({
        db,
        scope,
        config: cfg,
        goalNode,
        targetNode,
        score: 0.92,
        reason: 'entity:ci-pipeline',
        inHoldout: false,
        policy: allowPolicy,
        assistantWorkItems: mockWorkItems,
        nowMs,
      })
      expect(ok1.emitted).toBe(true)
      expect(ok1.outcome).toBe('recorded')
      expect(ok1.intakeInput).not.toBeNull()
      expect(Object.keys(ok1.intakeInput!).sort()).toEqual([
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
      expect(ok1.intakeInput).not.toHaveProperty('groupMessage')
      expect(ok1.intakeInput).not.toHaveProperty('objective')
      expect(ok1.intakeInput).not.toHaveProperty('objectiveDigest')
      expect(ok1.intakeInput).not.toHaveProperty('acceptance')
      expect(ok1.sourceText).not.toContain('sk-secret1234567890abcdef')
      expect(ok1.sourceText).toContain('[redacted]')
      expect(Buffer.byteLength(ok1.sourceText!, 'utf8')).toBeLessThanOrEqual(256)
      expect(ok1.intakeInput!.contentDigest).toBe(
        createHash('sha256').update(ok1.sourceText!, 'utf8').digest('hex'),
      )

      // Validate directly against real classifyIntake
      const classified = classifyIntake(ok1.intakeInput!, {
        unaddressedGroupMessages: false,
        unsubscribedEvents: true,
      })
      expect(classified.strength).toBe('inferred')
      expect(classified.strengthReason).toBe('allowlisted-unaddressed')
      expect(classified.decision).toBe('stored')

      // 10. Cooldown active for same (goal, target) within 60_000ms
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode,
          score: 0.95,
          inHoldout: false,
          policy: allowPolicy,
          assistantWorkItems: mockWorkItems,
          nowMs: nowMs + 30_000,
        }),
      ).toMatchObject({ emitted: false, outcome: 'cooldown-active' })

      // Different target succeeds (2nd signal in hour)
      const target2 = makeNodeRef(scope, 'a:e-2', 'episode', 'Second target episode')
      const ok2 = emitAssociationIntakeSignal({
        db,
        scope,
        config: cfg,
        goalNode,
        targetNode: target2,
        score: 0.88,
        inHoldout: false,
        policy: allowPolicy,
        assistantWorkItems: mockWorkItems,
        nowMs: nowMs + 30_000,
      })
      expect(ok2.emitted).toBe(true)

      // 11. Hourly cap (maxSignalsPerHour = 2) blocks 3rd signal in same hour
      const target3 = makeNodeRef(scope, 'a:e-3', 'episode', 'Third target episode')
      expect(
        emitAssociationIntakeSignal({
          db,
          scope,
          config: cfg,
          goalNode,
          targetNode: target3,
          score: 0.99,
          inHoldout: false,
          policy: allowPolicy,
          assistantWorkItems: mockWorkItems,
          nowMs: nowMs + 70_000,
        }),
      ).toMatchObject({ emitted: false, outcome: 'hourly-cap-exceeded' })

      // After 1 hour + 1ms, cooldown & hourly cap both allow next signal
      const ok3 = emitAssociationIntakeSignal({
        db,
        scope,
        config: cfg,
        goalNode,
        targetNode,
        score: 0.95,
        inHoldout: false,
        policy: allowPolicy,
        assistantWorkItems: mockWorkItems,
        nowMs: nowMs + 3_600_001,
      })
      expect(ok3.emitted).toBe(true)
      expect(ok3.sourceEventId).not.toBe(ok1.sourceEventId)

      const stored = listIntakeSignals(db, scope.ownerScopeKey)
      expect(stored).toHaveLength(3)
    } finally {
      db.close()
    }
  })
})

describe('end-to-end integration against real AssistantWorkItemsService & WorkItemIntakeAdmissionBridge', () => {
  class PolicyStubService extends Service {
    constructor(ctx: Context) {
      super(ctx, 'assistantPolicy')
    }
    getEmergencyStop() {
      return { enabled: false }
    }
    evaluate() {
      return { effect: 'allow' as const, reasonCode: 'rule-allow' as const, ruleId: 'rule-triage' }
    }
    authorize() {
      return { effect: 'allow' as const, reasonCode: 'rule-allow' as const, ruleId: 'rule-triage' }
    }
    authorizeAgent() {
      return { effect: 'allow' as const, reasonCode: 'rule-allow' as const, ruleId: 'rule-triage' }
    }
  }

  class SchedulerStubService extends Service {
    private readonly listeners = new Set<() => void>()
    constructor(ctx: Context) {
      super(ctx, 'assistantAutomations')
    }
    onSchedulerWake(fn: () => void): () => void {
      this.listeners.add(fn)
      return () => {
        this.listeners.delete(fn)
      }
    }
    wake(): void {
      for (const listener of this.listeners) listener()
    }
    ingestExternal(value: { automationId: string; eventId: string }) {
      return { id: `occ-${value.eventId}`, automationId: value.automationId }
    }
  }

  test('catches WorkItemError(disabled) cleanly when work-items intakeLedger is disabled', async () => {
    const root = makeTempDir('wi-disabled-')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('assistantDelivery' as never, {
      isMaintenanceDraining: () => true,
      validateOwnerRoute: (v: {
        authorityId: string
        principalId: string
        workspace: string
        agentPreset: string
      }) => ({
        receiptVersion: 2,
        ...v,
        authorityHash: 'sha256:owner',
        principalRecordId: 'owner-1',
        principalVersion: 1,
        bindingVersion: 1,
        generation: 1,
      }),
      enqueueBackground: () => Promise.resolve({ id: 'outbox' }),
    } as never)
    await ctx.plugin(PolicyStubService)
    await ctx.plugin(SchedulerStubService)

    const wiConfig: WorkItemsConfig = {
      enabled: true,
      mode: 'observe',
      databasePath: join(root, 'items.sqlite'),
      workRoot: join(root, 'work'),
      workerAutomationId: 'worker',
      scope: {
        workspace: root,
        preset: 'primary',
        principalId: 'owner:one',
        ownerRouteId: 'route-1',
        expiresAt: Date.now() + 86_400_000,
      },
      // intakeLedger omitted -> disabled
    }
    await ctx.plugin(AssistantWorkItemsService, wiConfig)
    const wiService = ctx.get('assistantWorkItems' as never) as unknown as AssistantWorkItemsService

    const db = openAssociationDatabase(':memory:')
    try {
      const scope = makeScope('wi-disabled')
      const res = emitAssociationIntakeSignal({
        db,
        scope,
        config: normalizeAssociationIntakeSignalConfig({ enabled: true }),
        goalNode: makeNodeRef(scope, 'a:g-1', 'goal', 'Monitor build health'),
        targetNode: makeNodeRef(scope, 'a:e-1', 'episode', 'CI build failure spike'),
        score: 0.9,
        inHoldout: false,
        policy: {
          getEmergencyStop: () => ({ enabled: false }),
          authorize: () => ({ effect: 'allow' }),
        },
        assistantWorkItems: wiService,
        nowMs: 1_700_000_000_000,
      })
      expect(res.emitted).toBe(false)
      expect(res.outcome).toBe('work-items-disabled')
      const rows = listIntakeSignals(db, scope.ownerScopeKey)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outcome).toBe('work-items-disabled')
    } finally {
      db.close()
    }
  })

  test('even with work-items admit.mode=auto, closed 10-key signal fails closed to observe/would-admit with 0 admitted items and 0 delivery calls', async () => {
    const root = makeTempDir('wi-auto-observe-')
    const ctx = new Context()
    contexts.push(ctx)
    const enqueueBackgroundSpy = vi.fn(() => Promise.resolve({ id: 'outbox' }))
    ctx.provide('assistantDelivery' as never, {
      isMaintenanceDraining: () => true,
      validateOwnerRoute: (v: {
        authorityId: string
        principalId: string
        workspace: string
        agentPreset: string
      }) => ({
        receiptVersion: 2,
        ...v,
        authorityHash: 'sha256:owner',
        principalRecordId: 'owner-1',
        principalVersion: 1,
        bindingVersion: 1,
        generation: 1,
      }),
      enqueueBackground: enqueueBackgroundSpy,
    } as never)
    await ctx.plugin(PolicyStubService)
    await ctx.plugin(SchedulerStubService)

    const itemsDbPath = join(root, 'items.sqlite')
    const wiConfig: WorkItemsConfig = {
      enabled: true,
      mode: 'active',
      databasePath: itemsDbPath,
      workRoot: join(root, 'work'),
      workerAutomationId: 'worker',
      scope: {
        workspace: root,
        preset: 'primary',
        principalId: 'owner:one',
        ownerRouteId: 'route-1',
        expiresAt: Date.now() + 86_400_000,
      },
      admission: {
        allowedKinds: ['triage'],
        maxOpenItems: 100,
        maxAdmitsPerHour: 100,
        cooldownMs: 0,
      },
      intakeLedger: {
        enabled: true,
        sources: {
          'assistant-association': {
            unaddressedGroupMessages: false,
            unsubscribedEvents: true,
          },
        },
        evaluation: {
          enabled: true,
          admit: {
            enabled: true,
            mode: 'auto',
            kind: 'triage',
            originBindingId: 'binding-origin-1',
          },
        },
      },
    }
    await ctx.plugin(AssistantWorkItemsService, wiConfig)
    const wiService = ctx.get('assistantWorkItems' as never) as unknown as AssistantWorkItemsService
    const scheduler = ctx.get('assistantAutomations' as never) as unknown as SchedulerStubService

    const evaluator: WorkItemIntakeEvaluatorRegistration = {
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'rule-triage', ceiling: 'accept' }] }),
      evaluate: () => Promise.resolve({ level: 'accept', quotes: ['goal'] }),
    }
    wiService.registerIntakeEvaluator(evaluator)

    const db = openAssociationDatabase(':memory:')
    try {
      const scope = makeScope('wi-auto')
      const res = emitAssociationIntakeSignal({
        db,
        scope,
        config: normalizeAssociationIntakeSignalConfig({ enabled: true, minScore: 0.75 }),
        goalNode: makeNodeRef(scope, 'a:g-1', 'goal', 'Keep deployment latency under 100ms'),
        targetNode: makeNodeRef(scope, 'a:e-1', 'episode', 'Observed p99 latency spike to 450ms'),
        score: 0.91,
        reason: 'entity:latency',
        inHoldout: false,
        policy: {
          getEmergencyStop: () => ({ enabled: false }),
          authorize: () => ({ effect: 'allow', reasonCode: 'rule-allow' }),
        },
        assistantWorkItems: wiService,
        nowMs: 1_700_000_000_000,
      })

      expect(res.emitted).toBe(true)
      expect(res.outcome).toBe('recorded')
      const sourceEventId = res.sourceEventId!

      // Wait for WP20 evaluation to complete
      await vi.waitFor(() => {
        const evals = wiService.intakeEvaluations('assistant-association', sourceEventId)
        expect(evals).toMatchObject([{ wouldAccept: true }])
      })

      // Trigger scheduler wake -> WorkItemIntakeAdmissionBridge runs in admit.mode='auto'
      scheduler.wake()
      await vi.waitFor(() => {
        const admissions = wiService.intakeAdmissions('assistant-association', sourceEventId)
        expect(admissions).toMatchObject([
          {
            source: 'assistant-association',
            sourceEventId,
            mode: 'observe',
            outcome: 'would-admit',
            itemId: null,
          },
        ])
      })

      // Verify zero work items created and zero delivery notifications emitted
      const wiDb = new DatabaseSync(itemsDbPath, { readOnly: true })
      try {
        const countRow = wiDb.prepare('SELECT count(*) AS n FROM work_item').get() as { n: number }
        expect(countRow.n).toBe(0)
      } finally {
        wiDb.close()
      }
      expect(enqueueBackgroundSpy).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
