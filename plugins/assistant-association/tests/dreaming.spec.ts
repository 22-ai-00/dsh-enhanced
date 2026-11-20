import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantAssociationService } from '../src/index.js'
import {
  canRunDreaming,
  computeAbstractionNodeId,
  computeDreamSynonymId,
  DEFAULT_ASSOCIATION_DREAMING_CONFIG,
  ensureDreamingSchema,
  findExpiredAssociationNodes,
  listDreamRuns,
  normalizeAssociationDreamingConfig,
  projectDreamIdeasToAssociation,
  runDreamingPass,
  sweepExpiredDreamingNodes,
  synthesizeDreamingArtifacts,
  type DreamIdeaRecord,
  type DreamingDeliveryPeer,
  type DreamingPolicyPeer,
  type DreamingPolicyRequest,
} from '../src/dreaming.js'
import { extractEntities } from '../src/entities.js'
import { runHotPathQuery } from '../src/hot-path.js'
import { buildMemoryIndex } from '../src/index-memory.js'
import { AssociationStore, openAssociationDatabase } from '../src/sqlite.js'
import { tokenizeAssociationText } from '../src/tokenize.js'
import {
  computeOwnerScopeKey,
  computePrincipalDigest,
  DEFAULT_SOURCE_WEIGHTS,
  type AssociationOwnerScope,
  type UpsertNodeInput,
} from '../src/types.js'

const tempDirs: string[] = []
const contexts: Context[] = []

function makeTempDir(prefix = 'assoc-dreaming-test-'): string {
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

function makeScope(label = 'owner-dream'): AssociationOwnerScope {
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

function makeNode(
  scope: AssociationOwnerScope,
  id: string,
  title: string,
  body: string,
  options?: {
    readonly kind?: UpsertNodeInput['kind']
    readonly sourcePlugin?: string
    readonly sourceRef?: string
    readonly sourceVersion?: number
    readonly sensitivity?: UpsertNodeInput['sensitivity']
    readonly trust?: UpsertNodeInput['trust']
    readonly entities?: readonly string[]
    readonly metadata?: UpsertNodeInput['metadata']
    readonly expiresAt?: number | null
    readonly updatedAt?: number
  },
): UpsertNodeInput {
  const combined = `${title}\n${body}`
  const updatedAt = options?.updatedAt ?? 1_700_000_000_000
  return {
    id,
    kind: options?.kind ?? 'memory',
    sourcePlugin: options?.sourcePlugin ?? 'personal-memory',
    sourceRef: options?.sourceRef ?? `ref:${id}`,
    sourceVersion: options?.sourceVersion ?? 1,
    ownerScopeKey: scope.ownerScopeKey,
    ownerMode: scope.mode,
    principalDigest: scope.principalDigest,
    principalRecordId: scope.principalRecordId,
    principalVersion: scope.principalVersion,
    scopeMode: 'workspace',
    workspace: scope.workspace,
    agentPreset: scope.agentPreset,
    trust: options?.trust ?? 'trusted',
    sensitivity: options?.sensitivity ?? 'private',
    title,
    body,
    entities: options?.entities ?? extractEntities(combined),
    tokens: tokenizeAssociationText(combined),
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    ttlMs: null,
    expiresAt: options?.expiresAt ?? null,
    status: 'active',
    createdAt: updatedAt,
    updatedAt,
  }
}

describe('dreaming config & authorization / idle gate', () => {
  test('defaults to disabled with spec defaults and normalizes overrides cleanly', () => {
    expect(DEFAULT_ASSOCIATION_DREAMING_CONFIG).toEqual({
      enabled: false,
      intervalMs: 3_600_000,
      idleMinMs: 1_800_000,
      maxPairsPerRun: 16,
      maxAbstractionsPerRun: 4,
      maxSynonymsPerRun: 16,
      nodeTtlMs: 30 * 86_400_000,
      allowModelSynthesis: false,
    })

    const normalized = normalizeAssociationDreamingConfig({
      enabled: true,
      maxPairsPerRun: 6,
      maxAbstractionsPerRun: 2,
      maxSynonymsPerRun: 8,
      budgetId: 'dream-budget',
      budgetAmount: 2,
    })
    expect(normalized).toEqual({
      enabled: true,
      intervalMs: 3_600_000,
      idleMinMs: 1_800_000,
      maxPairsPerRun: 6,
      maxAbstractionsPerRun: 2,
      maxSynonymsPerRun: 8,
      nodeTtlMs: 30 * 86_400_000,
      allowModelSynthesis: false,
      budgetId: 'dream-budget',
      budgetAmount: 2,
    })
  })

  test('enforces fail-closed gates: disabled, emergency stop, missing/denied policy, route, budget, active agent, idle, interval', () => {
    const scope = makeScope('gate')
    const nowMs = 1_700_010_000_000
    const idleActivityAt = nowMs - 2_000_000
    const enabledCfg = normalizeAssociationDreamingConfig({ enabled: true })

    const allowPolicy: DreamingPolicyPeer = {
      getEmergencyStop: () => ({ enabled: false }),
      evaluate: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-dream' }),
    }

    // 1. Disabled by default
    expect(
      canRunDreaming({
        scope,
        config: DEFAULT_ASSOCIATION_DREAMING_CONFIG,
        policy: allowPolicy,
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'disabled' })

    // 2. Emergency stop blocks
    expect(
      canRunDreaming({
        scope,
        config: enabledCfg,
        policy: { ...allowPolicy, getEmergencyStop: () => ({ enabled: true }) },
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'emergency-stop' })

    // 3. Missing policy fails closed
    expect(
      canRunDreaming({
        scope,
        config: enabledCfg,
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'policy-unavailable' })

    // 4. Policy request uses closed resource kind 'evolution' and background subject
    const seenRequests: DreamingPolicyRequest[] = []
    const denyPolicy: DreamingPolicyPeer = {
      getEmergencyStop: () => ({ enabled: false }),
      evaluate: (req) => {
        seenRequests.push(req)
        return { effect: 'deny', reasonCode: 'default-deny' }
      },
    }
    expect(
      canRunDreaming({
        scope,
        config: enabledCfg,
        policy: denyPolicy,
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'policy-denied', policyReasonCode: 'default-deny' })
    expect(seenRequests[0]).toEqual({
      subject: {
        kind: 'background',
        id: 'assistant-association:dreaming',
        workspace: scope.workspace,
        principal: scope.principalId,
      },
      action: 'dream.build',
      resource: {
        kind: 'evolution',
        id: 'assistant-association:dreaming',
      },
      context: { initiator: 'background' },
    })

    // 5. Delivery route validation & state check
    const badValidateDelivery: DreamingDeliveryPeer = {
      validateOwnerRoute: () => {
        throw new Error('stale authority')
      },
      inspectOwnerRouteState: () => ({ status: 'active' }),
    }
    expect(
      canRunDreaming({
        scope,
        config: enabledCfg,
        policy: allowPolicy,
        delivery: badValidateDelivery,
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'route-invalid' })

    const inactiveDelivery: DreamingDeliveryPeer = {
      validateOwnerRoute: () => ({ ok: true }),
      inspectOwnerRouteState: () => ({ status: 'paused' }),
    }
    expect(
      canRunDreaming({
        scope,
        config: enabledCfg,
        policy: allowPolicy,
        delivery: inactiveDelivery,
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'route-inactive' })

    // 6. Budget check
    const budgetedCfg = normalizeAssociationDreamingConfig({
      enabled: true,
      budgetId: 'dream-daily',
      budgetAmount: 5,
    })
    expect(
      canRunDreaming({
        scope,
        config: budgetedCfg,
        policy: {
          ...allowPolicy,
          getBudgetConfig: () => ({
            id: 'dream-daily',
            metric: 'dream-runs',
            limit: 3,
            periodMs: 86_400_000,
            scope: 'global',
          }),
        },
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'budget-unavailable' })

    // 7. Active running agent blocks
    expect(
      canRunDreaming({
        scope,
        config: enabledCfg,
        policy: allowPolicy,
        hasRunningAgent: true,
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'agent-active' })

    // 8. Non-idle blocks
    expect(
      canRunDreaming({
        scope,
        config: enabledCfg,
        policy: allowPolicy,
        lastActivityAt: nowMs - 10_000,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'not-idle' })

    // 9. Active route + allowed policy + idle succeeds
    expect(
      canRunDreaming({
        scope,
        config: enabledCfg,
        policy: allowPolicy,
        delivery: {
          validateOwnerRoute: () => ({ ok: true }),
          inspectOwnerRouteState: () => 'active',
        },
        hasRunningAgent: false,
        lastActivityAt: idleActivityAt,
        nowMs,
      }),
    ).toEqual({ allowed: true, reason: 'ok' })
  })

  test('integrates with real AssistantPolicyService default-deny and explicit evolution allow rule', async () => {
    const dir = makeTempDir()
    const scope = makeScope('real-policy')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(dir, 'policy.sqlite'),
      proposalMaintenanceIntervalMs: 0,
      budgets: [
        {
          id: 'dream-budget',
          metric: 'dream-runs',
          limit: 10,
          periodMs: 86_400_000,
          scope: 'global',
        },
      ],
      rules: [
        {
          id: 'allow-assoc-dreaming',
          effect: 'allow',
          subject: { kind: 'background', id: 'assistant-association:dreaming', workspace: scope.workspace, principal: scope.principalId },
          actions: ['dream.build'],
          resource: { kind: 'evolution', id: 'assistant-association:dreaming' },
          context: { initiators: ['background'] },
        },
      ],
    })
    const policy = ctx.get('assistantPolicy' as never) as unknown as DreamingPolicyPeer
    const nowMs = 1_700_020_000_000
    const cfg = normalizeAssociationDreamingConfig({
      enabled: true,
      budgetId: 'dream-budget',
      budgetAmount: 1,
    })

    expect(
      canRunDreaming({
        scope,
        config: cfg,
        policy,
        lastActivityAt: nowMs - 3_600_000,
        nowMs,
      }),
    ).toEqual({ allowed: true, reason: 'ok' })

    const otherScope = makeScope('other-owner')
    expect(
      canRunDreaming({
        scope: otherScope,
        config: cfg,
        policy,
        lastActivityAt: nowMs - 3_600_000,
        nowMs,
      }),
    ).toEqual({ allowed: false, reason: 'policy-denied', policyReasonCode: 'default-deny' })
  })

  test('never calls policy.authorize or delivery route checks when skipped by local readiness gates', async () => {
    const scope = makeScope('no-auth-on-skip')
    const db = openAssociationDatabase(':memory:')
    try {
      const store = new AssociationStore(db)
      const baseTime = 1_700_050_000_000
      const idleRunTime = baseTime + 3_600_000
      store.upsertBatch({
        nodes: [makeNode(scope, 'a:m-seed-1', 'Seed Node', 'Seed content', { updatedAt: baseTime })],
        edges: [],
        derivedRefs: [],
      })

      let authorizeCalls = 0
      let deliveryRouteCalls = 0
      const countingPolicy: DreamingPolicyPeer = {
        getEmergencyStop: () => ({ enabled: false }),
        getBudgetConfig: () => ({
          id: 'dream-budget',
          metric: 'dream-runs',
          limit: 5,
          periodMs: 86_400_000,
          scope: 'global',
        }),
        authorize: () => {
          authorizeCalls += 1
          return { effect: 'allow', reasonCode: 'rule-allow' }
        },
      }
      const countingDelivery: DreamingDeliveryPeer = {
        validateOwnerRoute: () => {
          deliveryRouteCalls += 1
          return { ok: true }
        },
        inspectOwnerRouteState: () => {
          deliveryRouteCalls += 1
          return { status: 'active' }
        },
      }

      const enabledCfg = normalizeAssociationDreamingConfig({
        enabled: true,
        intervalMs: 3_600_000,
        idleMinMs: 1_800_000,
        budgetId: 'dream-budget',
        budgetAmount: 1,
      })

      // 1. disabled -> 0 authorize, 0 delivery calls
      const disabledRes = runDreamingPass({
        db,
        scope,
        config: DEFAULT_ASSOCIATION_DREAMING_CONFIG,
        policy: countingPolicy,
        delivery: countingDelivery,
        lastActivityAt: baseTime,
        nowMs: idleRunTime,
      })
      expect(disabledRes).toMatchObject({ ran: false, reason: 'disabled' })
      expect(authorizeCalls).toBe(0)
      expect(deliveryRouteCalls).toBe(0)

      // 2. emergency-stop -> 0 authorize, 0 delivery calls
      const emergencyRes = runDreamingPass({
        db,
        scope,
        config: enabledCfg,
        policy: { ...countingPolicy, getEmergencyStop: () => ({ enabled: true }) },
        delivery: countingDelivery,
        lastActivityAt: baseTime,
        nowMs: idleRunTime,
      })
      expect(emergencyRes).toMatchObject({ ran: false, reason: 'emergency-stop' })
      expect(authorizeCalls).toBe(0)
      expect(deliveryRouteCalls).toBe(0)

      // 3. agent-active -> 0 authorize, 0 delivery calls
      const activeAgentRes = runDreamingPass({
        db,
        scope,
        config: enabledCfg,
        policy: countingPolicy,
        delivery: countingDelivery,
        hasRunningAgent: true,
        lastActivityAt: baseTime,
        nowMs: idleRunTime,
      })
      expect(activeAgentRes).toMatchObject({ ran: false, reason: 'agent-active' })
      expect(authorizeCalls).toBe(0)
      expect(deliveryRouteCalls).toBe(0)

      // 4. not-idle (both explicit lastActivityAt and DB-inferred) -> 0 authorize, 0 delivery calls
      const notIdleExplicit = runDreamingPass({
        db,
        scope,
        config: enabledCfg,
        policy: countingPolicy,
        delivery: countingDelivery,
        lastActivityAt: idleRunTime - 10_000,
        nowMs: idleRunTime,
      })
      expect(notIdleExplicit).toMatchObject({ ran: false, reason: 'not-idle' })
      expect(authorizeCalls).toBe(0)
      expect(deliveryRouteCalls).toBe(0)

      const notIdleInferred = runDreamingPass({
        db,
        scope,
        config: enabledCfg,
        policy: countingPolicy,
        delivery: countingDelivery,
        nowMs: baseTime + 10_000,
      })
      expect(notIdleInferred).toMatchObject({ ran: false, reason: 'not-idle' })
      expect(authorizeCalls).toBe(0)
      expect(deliveryRouteCalls).toBe(0)

      // 5. budget-unavailable -> 0 authorize, 0 delivery calls
      const budgetMissing = runDreamingPass({
        db,
        scope,
        config: normalizeAssociationDreamingConfig({
          ...enabledCfg,
          budgetAmount: 99,
        }),
        policy: countingPolicy,
        delivery: countingDelivery,
        lastActivityAt: baseTime,
        nowMs: idleRunTime,
      })
      expect(budgetMissing).toMatchObject({ ran: false, reason: 'budget-unavailable' })
      expect(authorizeCalls).toBe(0)
      expect(deliveryRouteCalls).toBe(0)

      // 6. route-inactive -> delivery runs, 0 authorize calls
      const routeInactive = runDreamingPass({
        db,
        scope,
        config: enabledCfg,
        policy: countingPolicy,
        delivery: {
          validateOwnerRoute: () => ({ ok: true }),
          inspectOwnerRouteState: () => ({ status: 'paused' }),
        },
        lastActivityAt: baseTime,
        nowMs: idleRunTime,
      })
      expect(routeInactive).toMatchObject({ ran: false, reason: 'route-inactive' })
      expect(authorizeCalls).toBe(0)

      // 7. All local gates pass -> authorizes once and records completed run
      const firstRun = runDreamingPass({
        db,
        scope,
        config: enabledCfg,
        policy: countingPolicy,
        delivery: countingDelivery,
        lastActivityAt: baseTime,
        nowMs: idleRunTime,
      })
      expect(firstRun).toMatchObject({ ran: true, status: 'completed', reason: 'ok' })
      expect(authorizeCalls).toBe(1)
      expect(deliveryRouteCalls).toBe(2)

      // 8. interval-not-elapsed -> 0 additional authorize or delivery calls
      const cooldownRes = runDreamingPass({
        db,
        scope,
        config: enabledCfg,
        policy: countingPolicy,
        delivery: countingDelivery,
        lastActivityAt: baseTime,
        nowMs: idleRunTime + 15_000,
      })
      expect(cooldownRes).toMatchObject({ ran: false, reason: 'interval-not-elapsed' })
      expect(authorizeCalls).toBe(1)
      expect(deliveryRouteCalls).toBe(2)
    } finally {
      db.close()
    }

    // 9. Service-level runDreamingNow with AssistantPolicyService: 0 authorize calls on not-idle,
    //    agent-active, and interval-not-elapsed ticks
    const dir = makeTempDir('assoc-dream-service-gate-')
    const ctx = new Context()
    contexts.push(ctx)
    const { authorityId: _omitAuthorityId, ...restScope } = scope
    const headlessScope: AssociationOwnerScope = {
      ...restScope,
      mode: 'headless',
      principalRecordId: null,
      principalVersion: null,
      ownerScopeKey: computeOwnerScopeKey({
        mode: 'headless',
        principalDigest: scope.principalDigest,
        principalRecordId: null,
        principalVersion: null,
        workspace: scope.workspace,
        agentPreset: scope.agentPreset,
      }),
    }
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(dir, 'policy.sqlite'),
      proposalMaintenanceIntervalMs: 0,
      rules: [
        {
          id: 'allow-assoc-dreaming',
          effect: 'allow',
          subject: {
            kind: 'background',
            id: 'assistant-association:dreaming',
            workspace: headlessScope.workspace,
            principal: headlessScope.principalId,
          },
          actions: ['dream.build'],
          resource: { kind: 'evolution', id: 'assistant-association:dreaming' },
          context: { initiators: ['background'] },
        },
      ],
    })
    const policySvc = ctx.assistantPolicy
    const authorizeSpy = vi.spyOn(policySvc, 'authorize')

    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(dir, 'assoc.sqlite'),
      allowHeadlessScope: true,
      syncIntervalMs: 60_000,
      dreaming: {
        enabled: true,
        intervalMs: 3_600_000,
        idleMinMs: 1_800_000,
      },
    })
    const assoc = ctx.assistantAssociation
    const t0 = 1_700_060_000_000

    // not-idle -> 0 policy.authorize calls
    const svcNotIdle = await assoc.runDreamingNow(headlessScope, {
      lastActivityAt: t0,
      nowMs: t0 + 15_000,
    })
    expect(svcNotIdle).toMatchObject({ ran: false, reason: 'not-idle' })
    expect(authorizeSpy).toHaveBeenCalledTimes(0)

    // agent-active -> 0 policy.authorize calls
    const svcActiveAgent = await assoc.runDreamingNow(headlessScope, {
      hasRunningAgent: true,
      lastActivityAt: t0,
      nowMs: t0 + 2_000_000,
    })
    expect(svcActiveAgent).toMatchObject({ ran: false, reason: 'agent-active' })
    expect(authorizeSpy).toHaveBeenCalledTimes(0)

    // idle + no active agent -> 1 policy.authorize call
    const svcAllowed = await assoc.runDreamingNow(headlessScope, {
      hasRunningAgent: false,
      lastActivityAt: t0,
      nowMs: t0 + 2_000_000,
    })
    expect(svcAllowed).toMatchObject({ ran: true, status: 'completed', reason: 'ok' })
    expect(authorizeSpy).toHaveBeenCalledTimes(1)

    // interval-not-elapsed -> still 1 policy.authorize call
    const svcCooldown = await assoc.runDreamingNow(headlessScope, {
      hasRunningAgent: false,
      lastActivityAt: t0,
      nowMs: t0 + 2_015_000,
    })
    expect(svcCooldown).toMatchObject({ ran: false, reason: 'interval-not-elapsed' })
    expect(authorizeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('dreaming synthesis, AC hot-path & dual-endpoint invalidation', () => {
  test('synthesizes low-trust dream edges, abstraction nodes/edges, and AC synonyms with dual-endpoint derivedRefs', () => {
    const scope = makeScope('synth')
    const db = openAssociationDatabase(':memory:')
    try {
      const store = new AssociationStore(db)
      const baseTime = 1_700_000_000_000
      const runTime = baseTime + 3_600_000

      // Nodes A & B share secondary tokens/entities and are NOT connected by an edge.
      // Node C is sensitive (must be excluded).
      // Node D is already connected to A (must NOT get a duplicate dream edge to A).
      const nodeA = makeNode(
        scope,
        'a:m-1',
        'Association Layer (AL) Migration Checklist',
        'Deploy Postgresql (Postgres) schema migration and DreamEngine telemetry pipeline for backend-api.',
        {
          updatedAt: baseTime,
          metadata: { extra: { aliases: ['assoc-layer'] } },
        },
      )
      const nodeB = makeNode(
        scope,
        'a:m-2',
        'Backend-API Schema Rollout Notes',
        'Verify migration telemetry pipeline and postgresql index latency before canary cutover.',
        { updatedAt: baseTime - 1_000 },
      )
      const nodeC = makeNode(
        scope,
        'a:m-3',
        'Sensitive Secret Token Notes',
        'Secret migration telemetry pipeline credential for postgresql.',
        { sensitivity: 'sensitive', updatedAt: baseTime },
      )
      const nodeD = makeNode(
        scope,
        'a:m-4',
        'Canary Cutover Checklist',
        'Run canary cutover smoke suite after migration checklist passes.',
        { updatedAt: baseTime - 2_000 },
      )

      store.upsertBatch({
        nodes: [nodeA, nodeB, nodeC, nodeD],
        edges: [
          {
            edgeId: 'e'.repeat(64),
            aId: nodeA.id,
            bId: nodeD.id,
            edgeType: 'entity',
            weight: 0.7,
            trust: 'trusted',
            reason: 'entity:migration',
            createdAt: baseTime,
            updatedAt: baseTime,
          },
        ],
        derivedRefs: [],
      })

      const cfg = normalizeAssociationDreamingConfig({
        enabled: true,
        maxPairsPerRun: 4,
        maxAbstractionsPerRun: 2,
        maxSynonymsPerRun: 8,
        nodeTtlMs: 86_400_000,
      })

      const result = runDreamingPass({
        db,
        scope,
        config: cfg,
        policy: {
          getEmergencyStop: () => ({ enabled: false }),
          authorize: () => ({ effect: 'allow', reasonCode: 'rule-allow' }),
        },
        lastActivityAt: baseTime,
        nowMs: runTime,
      })

      expect(result.ran).toBe(true)
      expect(result.status).toBe('completed')
      expect(result.artifacts.pairsCreated).toBeGreaterThanOrEqual(1)
      expect(result.artifacts.abstractionsCreated).toBeGreaterThanOrEqual(1)
      expect(result.artifacts.synonymsCreated).toBeGreaterThanOrEqual(1)

      // Dream edges: all low trust, weight in [0.30, 0.65], never involving sensitive nodeC or already-connected (A, D)
      const dreamEdges = result.artifacts.edges.filter((e) => e.edgeType === 'dream')
      expect(dreamEdges.length).toBeGreaterThanOrEqual(1)
      for (const e of dreamEdges) {
        expect(e.trust).toBe('low')
        expect(e.weight).toBeGreaterThanOrEqual(0.3)
        expect(e.weight).toBeLessThanOrEqual(0.65)
        expect(e.aId).not.toBe(nodeC.id)
        expect(e.bId).not.toBe(nodeC.id)
        expect(
          (e.aId === nodeA.id && e.bId === nodeD.id) ||
            (e.aId === nodeD.id && e.bId === nodeA.id),
        ).toBe(false)
        // Both endpoints recorded in derivedRefs
        expect(result.artifacts.derivedRefs).toContainEqual({
          sourceNodeId: e.aId,
          sourceVersion: 1,
          targetKind: 'edge',
          targetId: e.edgeId,
        })
        expect(result.artifacts.derivedRefs).toContainEqual({
          sourceNodeId: e.bId,
          sourceVersion: 1,
          targetKind: 'edge',
          targetId: e.edgeId,
        })
      }

      // Abstraction nodes & edges: low trust, deterministic ID, derivedRefs from EVERY supporting endpoint + abs node
      const absNodes = result.artifacts.nodes.filter((n) => n.kind === 'abstraction')
      expect(absNodes.length).toBeGreaterThanOrEqual(1)
      const absEdges = result.artifacts.edges.filter((e) => e.edgeType === 'abstraction')
      expect(absEdges.length).toBeGreaterThanOrEqual(2)

      for (const absNode of absNodes) {
        expect(absNode.trust).toBe('low')
        expect(absNode.id.startsWith(`a:abs-${scope.ownerScopeKey.slice(0, 8)}-`)).toBe(true)
        expect(absNode.expiresAt).toBe(runTime + cfg.nodeTtlMs)

        const incidentAbsEdges = absEdges.filter(
          (e) => e.aId === absNode.id || e.bId === absNode.id,
        )
        expect(incidentAbsEdges.length).toBeGreaterThanOrEqual(2)
        for (const edge of incidentAbsEdges) {
          expect(edge.trust).toBe('low')
          const supporterId = edge.aId === absNode.id ? edge.bId : edge.aId
          expect(result.artifacts.derivedRefs).toContainEqual({
            sourceNodeId: supporterId,
            sourceVersion: 1,
            targetKind: 'node',
            targetId: absNode.id,
          })
          expect(result.artifacts.derivedRefs).toContainEqual({
            sourceNodeId: supporterId,
            sourceVersion: 1,
            targetKind: 'edge',
            targetId: edge.edgeId,
          })
          expect(result.artifacts.derivedRefs).toContainEqual({
            sourceNodeId: absNode.id,
            sourceVersion: 1,
            targetKind: 'edge',
            targetId: edge.edgeId,
          })
        }
      }

      // Synonyms: low trust, deterministic ID, matches parenthetical/hyphen/camel/metadata aliases
      expect(result.artifacts.synonyms.length).toBeGreaterThanOrEqual(1)
      for (const syn of result.artifacts.synonyms) {
        expect(syn.trust).toBe('low')
        expect(syn.id).toBe(
          computeDreamSynonymId(scope.ownerScopeKey, syn.surface, syn.canonicalEntity),
        )
      }
      const surfaces = new Set(result.artifacts.synonyms.map((s) => s.surface))
      expect(
        surfaces.has('postgres') ||
          surfaces.has('backend api') ||
          surfaces.has('dream engine') ||
          surfaces.has('al'),
      ).toBe(true)

      // Verify AC hot-path matching uses persisted low-trust synonym
      const activeNodes = store.loadActiveNodesPage(100, 0)
      const activeEdges = store.loadActiveEdgesPage(100, 0)
      const activeSyns = store.loadActiveSynonymsPage(100, 0)
      const memIndex = buildMemoryIndex(
        { nodes: activeNodes, edges: activeEdges, synonyms: activeSyns },
        { buildEpoch: 1, builtAt: runTime },
      )

      const postgresSyn = activeSyns.find((s) => s.surface === 'postgres')
      expect(postgresSyn).toBeDefined()
      const hotResult = runHotPathQuery(
        memIndex,
        [{ kind: 'user', text: 'check postgres latency', weight: 1.0 }],
        {
          ownerScopeKey: scope.ownerScopeKey,
          workspace: scope.workspace,
          agentPreset: scope.agentPreset,
          allowLowTrust: true,
          allowSensitive: false,
          nowMs: runTime,
        },
        {
          maxHops: 2,
          hopTopN: 16,
          maxFanoutPerNode: 32,
          maxItems: 8,
          decayHalfLifeMs: 14 * 86_400_000,
          budgetMs: 25,
          sourceWeights: DEFAULT_SOURCE_WEIGHTS,
        },
      )
      expect(hotResult.items.some((i) => i.id === nodeA.id || i.id === nodeB.id)).toBe(true)

      // Interval throttling prevents immediate second run
      const secondPass = runDreamingPass({
        db,
        scope,
        config: cfg,
        policy: {
          getEmergencyStop: () => ({ enabled: false }),
          authorize: () => ({ effect: 'allow', reasonCode: 'rule-allow' }),
        },
        lastActivityAt: baseTime,
        nowMs: runTime + 1_000,
      })
      expect(secondPass.ran).toBe(false)
      expect(secondPass.reason).toBe('interval-not-elapsed')

      const runs = listDreamRuns(db, scope.ownerScopeKey)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe('completed')
    } finally {
      db.close()
    }
  })

  test('deletes dream edges, abstraction nodes/edges, and synonyms on withdrawSource, suppressNodeConflict, version bump, and TTL expiry sweep', () => {
    const scope = makeScope('cascade')
    const baseTime = 1_700_000_000_000
    const runTime = baseTime + 3_600_000

    const seedGraph = (opts?: { readonly bExpiresAt?: number | null }) => {
      const db = openAssociationDatabase(':memory:')
      const store = new AssociationStore(db)
      const nodeA = makeNode(
        scope,
        'a:m-a',
        'Postgresql (Postgres) Query Planner',
        'Tune postgresql query planner telemetry pipeline for workspace-alpha.',
        { updatedAt: baseTime },
      )
      const nodeB = makeNode(
        scope,
        'a:m-b',
        'Workspace-Alpha Query Telemetry',
        'Inspect postgresql telemetry pipeline and planner regression metrics.',
        { updatedAt: baseTime, ...(opts?.bExpiresAt !== undefined ? { expiresAt: opts.bExpiresAt } : {}) },
      )
      store.upsertBatch({ nodes: [nodeA, nodeB], edges: [], derivedRefs: [] })

      const cfg = normalizeAssociationDreamingConfig({
        enabled: true,
        intervalMs: 0,
        maxPairsPerRun: 4,
        maxAbstractionsPerRun: 2,
        maxSynonymsPerRun: 8,
        nodeTtlMs: 86_400_000,
      })
      const pass = runDreamingPass({
        db,
        scope,
        config: cfg,
        policy: {
          getEmergencyStop: () => ({ enabled: false }),
          authorize: () => ({ effect: 'allow' }),
        },
        lastActivityAt: baseTime,
        nowMs: runTime,
        writer: store,
      })
      expect(pass.ran).toBe(true)
      expect(store.loadActiveEdgesPage(100, 0).some((e) => e.edgeType === 'dream')).toBe(true)
      expect(store.loadActiveNodesPage(100, 0).some((n) => n.kind === 'abstraction')).toBe(true)
      expect(store.loadActiveSynonymsPage(100, 0).length).toBeGreaterThanOrEqual(1)
      return { db, store, nodeA, nodeB, pass }
    }

    // Case 1: withdrawSource on endpoint A
    {
      const { db, store, nodeA } = seedGraph()
      try {
        store.withdrawSource({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: nodeA.sourcePlugin,
          sourceRef: nodeA.sourceRef,
          hardDelete: true,
        })
        expect(store.loadActiveEdgesPage(100, 0).filter((e) => e.edgeType === 'dream')).toHaveLength(0)
        expect(store.loadActiveEdgesPage(100, 0).filter((e) => e.edgeType === 'abstraction')).toHaveLength(0)
        expect(store.loadActiveNodesPage(100, 0).filter((n) => n.kind === 'abstraction')).toHaveLength(0)
        expect(store.loadActiveSynonymsPage(100, 0)).toHaveLength(0)
      } finally {
        db.close()
      }
    }

    // Case 2: suppressNodeConflict on endpoint B
    {
      const { db, store, nodeB } = seedGraph()
      try {
        store.suppressNodeConflict({
          ownerScopeKey: scope.ownerScopeKey,
          sourcePlugin: nodeB.sourcePlugin,
          sourceRef: nodeB.sourceRef,
          nowMs: runTime + 500,
        })
        expect(store.loadActiveEdgesPage(100, 0).filter((e) => e.edgeType === 'dream')).toHaveLength(0)
        expect(store.loadActiveEdgesPage(100, 0).filter((e) => e.edgeType === 'abstraction')).toHaveLength(0)
        expect(store.loadActiveNodesPage(100, 0).filter((n) => n.kind === 'abstraction')).toHaveLength(0)
        expect(store.loadActiveSynonymsPage(100, 0)).toHaveLength(0)
      } finally {
        db.close()
      }
    }

    // Case 3: sourceVersion bump on endpoint A
    {
      const { db, store, nodeA } = seedGraph()
      try {
        store.upsertBatch({
          nodes: [{ ...nodeA, sourceVersion: 2, updatedAt: runTime + 1_000 }],
          edges: [],
          derivedRefs: [],
        })
        expect(store.loadActiveEdgesPage(100, 0).filter((e) => e.edgeType === 'dream')).toHaveLength(0)
        expect(store.loadActiveEdgesPage(100, 0).filter((e) => e.edgeType === 'abstraction')).toHaveLength(0)
        expect(store.loadActiveNodesPage(100, 0).filter((n) => n.kind === 'abstraction')).toHaveLength(0)
        expect(store.loadActiveSynonymsPage(100, 0)).toHaveLength(0)
      } finally {
        db.close()
      }
    }

    // Case 4: TTL expiry on endpoint B + sweepExpiredDreamingNodes
    {
      const { db, store } = seedGraph({ bExpiresAt: runTime + 10_000 })
      try {
        expect(findExpiredAssociationNodes(db, { nowMs: runTime + 5_000 })).toHaveLength(0)
        const swept = sweepExpiredDreamingNodes(db, {
          ownerScopeKey: scope.ownerScopeKey,
          nowMs: runTime + 10_000,
          withdrawSource: (w) => store.withdrawSource(w),
        })
        expect(swept.some((t) => t.id === 'a:m-b')).toBe(true)
        expect(store.loadActiveEdgesPage(100, 0).filter((e) => e.edgeType === 'dream')).toHaveLength(0)
        expect(store.loadActiveEdgesPage(100, 0).filter((e) => e.edgeType === 'abstraction')).toHaveLength(0)
        expect(store.loadActiveNodesPage(100, 0).filter((n) => n.kind === 'abstraction')).toHaveLength(0)
        expect(store.loadActiveSynonymsPage(100, 0)).toHaveLength(0)
      } finally {
        db.close()
      }
    }
  })

  test('projects assistant-dreaming DreamIdeaRecords to low-trust dream nodes and withdraws rejected/withdrawn ideas', () => {
    const scope = makeScope('ideas')
    const db = openAssociationDatabase(':memory:')
    try {
      ensureDreamingSchema(db)
      const store = new AssociationStore(db)
      const baseTime = 1_700_000_000_000
      const runTime = baseTime + 3_600_000

      // Seed one baseline node so idle inference works if needed
      store.upsertBatch({
        nodes: [makeNode(scope, 'a:m-seed', 'Seed Note', 'Baseline node', { updatedAt: baseTime })],
        edges: [],
        derivedRefs: [],
      })

      const cfg = normalizeAssociationDreamingConfig({ enabled: true, intervalMs: 0 })
      const idea1: DreamIdeaRecord = {
        id: 'idea-1',
        lane: 'default',
        runId: 'dr-1',
        createdAt: baseTime,
        dayKey: '2026-11-20',
        state: 'validated',
        summary: 'Cache invalidation pattern across association index rebuilds',
        detail: 'Consolidate entity index invalidation hooks across wiki and memory sources.',
        evidenceRefs: ['sha256:aaa'],
      }
      const idea2: DreamIdeaRecord = {
        id: 'idea-2',
        lane: 'default',
        runId: 'dr-1',
        createdAt: baseTime,
        dayKey: '2026-11-20',
        state: 'recorded',
        summary: 'Deprecated nightly cleanup proposal',
        detail: 'Superseded idea.',
        evidenceRefs: ['sha256:bbb'],
      }

      const pass1 = runDreamingPass({
        db,
        scope,
        config: cfg,
        policy: { getEmergencyStop: () => ({ enabled: false }), authorize: () => ({ effect: 'allow' }) },
        ideas: [idea1, idea2],
        lastActivityAt: baseTime,
        nowMs: runTime,
      })
      expect(pass1.ideasProjected).toBe(2)
      expect(pass1.ideasWithdrawn).toBe(0)
      const dreamNodesAfterPass1 = store
        .loadActiveNodesPage(100, 0)
        .filter((n) => n.kind === 'dream')
      expect(dreamNodesAfterPass1).toHaveLength(2)
      expect(dreamNodesAfterPass1.every((n) => n.trust === 'low')).toBe(true)

      // Now withdraw idea-2 ('rejected')
      const pass2 = runDreamingPass({
        db,
        scope,
        config: cfg,
        policy: { getEmergencyStop: () => ({ enabled: false }), authorize: () => ({ effect: 'allow' }) },
        ideas: [idea1, { ...idea2, state: 'rejected' }],
        lastActivityAt: baseTime,
        nowMs: runTime + 1_000,
      })
      expect(pass2.ideasProjected).toBe(1)
      expect(pass2.ideasWithdrawn).toBe(1)
      const dreamNodesAfterPass2 = store
        .loadActiveNodesPage(100, 0)
        .filter((n) => n.kind === 'dream')
      expect(dreamNodesAfterPass2).toHaveLength(1)
      expect(dreamNodesAfterPass2[0]?.sourceRef).toBe('dream-idea:idea-1')

      // Check deterministic helper directly
      const proj = projectDreamIdeasToAssociation(
        [{ ...idea1, state: 'withdrawn' }],
        scope,
        cfg,
        runTime,
      )
      expect(proj.upserts).toHaveLength(0)
      expect(proj.withdrawals).toHaveLength(1)
      expect(computeAbstractionNodeId(scope.ownerScopeKey, ['a', 'b'], ['c', 'd'])).toMatch(
        /^a:abs-[0-9a-f]{8}-[0-9a-f]{20}$/u,
      )
      expect(synthesizeDreamingArtifacts(db, scope, cfg, { nowMs: runTime }).pairsCreated).toBe(0)
    } finally {
      db.close()
    }
  })
})
