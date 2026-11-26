import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  createInboxStub,
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { AssistantDeliveryService, type OwnerRouteAuthority } from '@dsh-ray/assistant-delivery'
import { AssistantEvaluationService } from '@dsh-ray/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { PersonalMemoryService } from '@dsh-ray/personal-memory'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantAssociationService,
  Config,
  computeDeterministicEdgeId,
  computeOwnerScopeKey,
  computePrincipalDigest,
  DEFAULT_HEBBIAN_CONFIG,
  DEFAULT_PARAM_TUNING_CONFIG,
  extractEntities,
  fromAssociationConfig,
  normalizeConfig,
  tokenizeAssociationText,
  type AssociationConfig,
  type AssociationOwnerScope,
} from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
})

function makeExec(agent: Agent, callId = 'call-1'): ToolExecution {
  return {
    callId: ToolCallId(callId),
    rootCallId: ToolCallId(callId),
    agent,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function makeStubAgent(sessionId: string, cwd: string, preset = 'primary'): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd,
    agentPreset: preset,
    isSeeded: false,
  })
  return {
    id,
    options: {},
    session,
    inbox: createInboxStub(),
    ctx: new Context(),
    status: 'running',
    model: { current: () => ({ provider: 'mock', model: 'mock' }), select: () => {} },
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: (task) => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

async function setupRuntimeHarness(options?: {
  readonly hebbian?: AssociationConfig['hebbian']
  readonly paramTuning?: AssociationConfig['paramTuning']
  readonly holdoutRateBps?: number
  readonly holdoutSeed?: string
  readonly hotPathBudgetMs?: number
}) {
  const root = await mkdtemp(join(tmpdir(), 'assoc-s2-replay-'))
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'native' } })
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      {
        id: 'allow-all-agent',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: root },
        actions: ['*'],
        resource: { kind: '*', id: '*' },
        context: { initiators: ['foreground'] },
      },
    ],
  })

  await ctx.plugin(AssistantAssociationService, {
    databasePath: join(root, 'assoc.sqlite'),
    allowHeadlessScope: true,
    holdoutRateBps: options?.holdoutRateBps ?? 1250,
    holdoutSeed: options?.holdoutSeed ?? 's2-replay-holdout-seed-0123456789abcdef',
    hotPathBudgetMs: options?.hotPathBudgetMs ?? 50,
    ...(options?.hebbian !== undefined ? { hebbian: options.hebbian } : {}),
    ...(options?.paramTuning !== undefined ? { paramTuning: options.paramTuning } : {}),
  })

  const service = ctx.assistantAssociation
  if (options?.hotPathBudgetMs === undefined) {
    service.setHotPathClock(() => 0)
  }
  const harness = await mountAgentLoopTestHarness(ctx)

  const principalId = `headless:${root}:primary`
  const principalDigest = computePrincipalDigest(principalId)
  const ownerScope: AssociationOwnerScope = {
    mode: 'headless',
    ownerScopeKey: computeOwnerScopeKey({
      mode: 'headless',
      principalDigest,
      principalRecordId: null,
      principalVersion: null,
      workspace: root,
      agentPreset: 'primary',
    }),
    principalId,
    principalDigest,
    principalRecordId: null,
    principalVersion: null,
    workspace: root,
    agentPreset: 'primary',
  }

  return { root, ctx, service, harness, ownerScope }
}

function findHoldoutTaskSessionId(
  service: AssistantAssociationService,
  prefix: string,
  wantHoldout: boolean,
): string {
  let idx = 1
  while (true) {
    const sessId = `${prefix}-${idx}`
    const taskId = `headless-session:${sessId}:turn:1`
    if (service.isTaskInHoldout(taskId).inHoldout === wantHoldout) {
      return sessId
    }
    idx += 1
  }
}

describe('Slice S2: Hebbian reinforcement, decay, owner correction & WP22 parameter tuning', () => {
  test('validates hebbian and paramTuning config bounds while preserving S1 defaults', () => {
    const cfg = normalizeConfig({ databasePath: ':memory:' })
    expect(cfg.hebbian).toEqual(DEFAULT_HEBBIAN_CONFIG)
    expect(cfg.paramTuning).toEqual(DEFAULT_PARAM_TUNING_CONFIG)

    expect(() => Config({ hebbian: { alpha: -0.1 } })).toThrow(/hebbian\.alpha/)
    expect(() => Config({ hebbian: { weakRatio: 1.2 } })).toThrow(/hebbian\.weakRatio/)
    expect(() => Config({ hebbian: { beta: -1 } })).toThrow(/hebbian\.beta/)
    expect(() =>
      Config({ hebbian: { weightMin: 0.5, initialHebbianWeight: 0.2, weightMax: 2.0 } }),
    ).toThrow(/initialHebbianWeight/)
    expect(() => Config({ hebbian: { decayHalfLifeMs: 0 } })).toThrow(/decayHalfLifeMs/)
    expect(() => Config({ hebbian: { decayIntervalMs: 500 } })).toThrow(/decayIntervalMs/)
    expect(() => Config({ hebbian: { unknownHeb: 1 } as never })).toThrow(/unknown config field/)
    expect(() => Config({ paramTuning: { minSample: 0 } })).toThrow(/minSample/)
    expect(() => Config({ paramTuning: { unknownPt: 1 } as never })).toThrow(/unknown config field/)
  })

  test('strong use (+α) via assoc_read reinforces provenance & Hop-0 edges, stays idempotent, ignores unexposed/unauthorized/holdout, and logs assoc_read_events', async () => {
    const { root, ctx, service, harness, ownerScope } = await setupRuntimeHarness({
      hebbian: {
        alpha: 0.3,
        weakRatio: 1 / 3,
        weightMin: 0.05,
        weightMax: 2.5,
        initialHebbianWeight: 0.4,
      },
    })

    const now = 1_700_000_000_000
    service.setNowClock(() => now)

    const edgeSeedToTarget = computeDeterministicEdgeId('a:m-hop0-seed', 'a:m-hop1-target', 'entity')
    service.store!.upsertBatch({
      nodes: [
        {
          id: 'a:m-hop0-seed',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:hop0-seed',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'k8s_ingress controller notes',
          body: 'k8s_ingress routes cluster traffic.',
          entities: ['k8s_ingress'],
          tokens: tokenizeAssociationText('k8s_ingress routes cluster traffic'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-hop1-target',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:hop1-target',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'envoy_drain timeout fix',
          body: 'Configure envoy_drain graceful shutdown.',
          entities: ['envoy_drain'],
          tokens: tokenizeAssociationText('envoy_drain graceful shutdown'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-unexposed',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:unexposed',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'unrelated_redis cluster',
          body: 'Unrelated redis detail.',
          entities: ['unrelated_redis'],
          tokens: tokenizeAssociationText('unrelated_redis cluster'),
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [
        {
          edgeId: edgeSeedToTarget,
          aId: 'a:m-hop0-seed',
          bId: 'a:m-hop1-target',
          edgeType: 'entity',
          weight: 0.6,
          trust: 'trusted',
          reason: 'shared-entity:cluster',
          createdAt: now,
          updatedAt: now,
        },
      ],
      derivedRefs: [],
    })
    await service.refreshIndex()

    class MockAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const hasToolResult = (options.messages ?? []).some((m) => m.role === 'tool')
        if (!hasToolResult) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: 0,
            id: ToolCallId('call-read-1'),
            name: 'assoc_read',
            argumentsDelta: JSON.stringify({ id: 'a:m-hop1-target' }),
          }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: ToolCallId('call-read-1'),
              name: 'assoc_read',
              arguments: JSON.stringify({ id: 'a:m-hop1-target' }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Completed inspection.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Completed inspection.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new MockAdapter())

    const injectedSessId = findHoldoutTaskSessionId(service, 'strong-inj', false)
    const injectedAgent = await harness.create(
      SessionId(injectedSessId),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    injectedAgent.session.append('approval/policy', { policy: 'never' })
    injectedAgent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    ;(injectedAgent.session.append as unknown as (type: string, data: unknown) => unknown)(
      'sandbox/mode',
      { mode: 'danger-full-access' },
    )
    injectedAgent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Investigate k8s_ingress issue' }],
        source: { kind: 'user' },
      }),
    )
    await injectedAgent.whenIdle()
    await service.flush()

    const toolResult = injectedAgent.session
      .snapshotEvents()
      .find((ev) => ev.type === 'tool/result')
    expect(toolResult?.type).toBe('tool/result')
    if (toolResult?.type === 'tool/result') {
      expect(toolResult.data.error).toBeUndefined()
      if (toolResult.data.message.isError) {
        expect(toolResult.data.message.content).toEqual([])
      }
      expect(toolResult.data.message.isError).not.toBe(true)
    }

    const afterFirstRead = service.store!.database
      .prepare('SELECT weight, use_count FROM assoc_edges WHERE edge_id = ?')
      .get(edgeSeedToTarget) as { weight: number; use_count: number }
    expect(afterFirstRead.weight).toBeCloseTo(0.9, 6)
    expect(afterFirstRead.use_count).toBe(1)

    // Repeat assoc_read on same (taskId, nodeId) -> idempotent (+0 extra delta, assoc_read_count = 2)
    await service.readById(makeExec(injectedAgent, 'repeat-1'), 'a:m-hop1-target')
    // Read unexposed item -> zero edge boost, was_exposed stays 0
    await service.readById(makeExec(injectedAgent, 'unexp-1'), 'a:m-unexposed')
    // Read Hop-0 seed -> creates Hop-0 co-use hebbian edge with derivedFrom
    await service.readById(makeExec(injectedAgent, 'hop0-1'), 'a:m-hop0-seed')
    // Read non-existent and invalid-input -> logs hit = 0
    await expect(service.readById(makeExec(injectedAgent, 'miss-1'), 'a:m-does-not-exist')).rejects.toThrow()
    await expect(service.readById(makeExec(injectedAgent, 'inv-1'), '   ')).rejects.toThrow()
    await service.flush()

    const afterRepeat = service.store!.database
      .prepare('SELECT weight, use_count FROM assoc_edges WHERE edge_id = ?')
      .get(edgeSeedToTarget) as { weight: number; use_count: number }
    expect(afterRepeat.weight).toBeCloseTo(0.9, 6)
    expect(afterRepeat.use_count).toBe(1)

    const unexpRow = service.store!.database
      .prepare('SELECT was_exposed, strong_used, assoc_read_count FROM assoc_exposures WHERE node_id = ?')
      .get('a:m-unexposed') as { was_exposed: number; strong_used: number; assoc_read_count: number }
    expect(unexpRow.was_exposed).toBe(0)
    expect(unexpRow.strong_used).toBe(0)
    expect(unexpRow.assoc_read_count).toBe(1)

    const hebbianEdgeId = computeDeterministicEdgeId('a:m-hop0-seed', 'a:m-hop1-target', 'hebbian')
    const hebbianEdge = service.store!.database
      .prepare("SELECT weight, edge_type FROM assoc_edges WHERE edge_id = ?")
      .get(hebbianEdgeId) as { weight: number; edge_type: string } | undefined
    expect(hebbianEdge?.edge_type).toBe('hebbian')
    expect(hebbianEdge?.weight).toBeCloseTo(0.7, 6)

    // Policy-denied read logs hit = 0 with reason = 'policy-denied' and never mutates weights
    const policySvc = ctx.assistantPolicy
    const origAuth = policySvc.authorizeAgent.bind(policySvc)
    policySvc.authorizeAgent = ((agent, action, resource, opts) => {
      if (action === 'read' && resource.kind === 'tool' && resource.id === 'assoc_read') {
        return { effect: 'deny', ruleId: 'deny-read', reason: 'denied', matched: true } as unknown as ReturnType<typeof origAuth>
      }
      return origAuth(agent, action, resource, opts)
    }) as typeof policySvc.authorizeAgent
    await expect(service.readById(makeExec(injectedAgent, 'deny-1'), 'a:m-hop1-target')).rejects.toThrow(/policy/)
    policySvc.authorizeAgent = origAuth
    await service.flush()

    const readEvents = service.store!.database
      .prepare('SELECT node_id, hit, reason FROM assoc_read_events ORDER BY seq ASC')
      .all() as Array<{ node_id: string; hit: number; reason: string }>
    expect(readEvents.some((e) => e.node_id === 'a:m-hop1-target' && e.hit === 1 && e.reason === 'ok')).toBe(true)
    expect(readEvents.some((e) => e.node_id === 'a:m-does-not-exist' && e.hit === 0 && e.reason === 'not-found')).toBe(true)
    expect(readEvents.some((e) => e.node_id === '<invalid>' && e.hit === 0 && e.reason === 'invalid-input')).toBe(true)
    expect(readEvents.some((e) => e.node_id === 'a:m-hop1-target' && e.hit === 0 && e.reason === 'policy-denied')).toBe(true)

    // Holdout task: even if assoc_read is invoked, zero Hebbian reinforcement occurs
    const holdoutSessId = findHoldoutTaskSessionId(service, 'strong-holdout', true)
    const holdoutAgent = await harness.create(
      SessionId(holdoutSessId),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    holdoutAgent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Investigate k8s_ingress issue' }],
        source: { kind: 'user' },
      }),
    )
    await holdoutAgent.whenIdle()
    await service.flush()

    const holdoutTaskId = `headless-session:${holdoutSessId}:turn:1`
    const holdoutHebbianEvents = service.store!.database
      .prepare('SELECT COUNT(*) AS cnt FROM assoc_hebbian_events WHERE task_id = ?')
      .get(holdoutTaskId) as { cnt: number }
    expect(holdoutHebbianEvents.cnt).toBe(0)
  })

  test('weak use (+α/3) credits unique-entity reappearance, suppresses prompt/tool/shared/interrupted entities, and upgrades weak->strong cleanly by +(α - α/3)', async () => {
    const { root, ctx, service, harness, ownerScope } = await setupRuntimeHarness({
      hebbian: {
        alpha: 0.3,
        weakRatio: 1 / 3,
        weightMin: 0.05,
        weightMax: 3.0,
      },
    })

    const now = 1_700_000_100_000
    service.setNowClock(() => now)

    const edgeSeedToWeak = computeDeterministicEdgeId('a:m-seed-w', 'a:m-hop1-weak', 'entity')
    const edgeSeedToSharedA = computeDeterministicEdgeId('a:m-seed-w', 'a:m-shared-a', 'entity')
    const edgeSeedToSharedB = computeDeterministicEdgeId('a:m-seed-w', 'a:m-shared-b', 'entity')

    service.store!.upsertBatch({
      nodes: [
        {
          id: 'a:m-seed-w',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:seed-w',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'grpc_deadline budget check',
          body: 'Always inspect grpc_deadline propagation.',
          entities: ['grpc_deadline'],
          tokens: tokenizeAssociationText('grpc_deadline budget propagation'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-hop1-weak',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:hop1-weak',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Use circuit_breaker_x42 on backend retries',
          body: 'Apply circuit_breaker_x42 and common_retry_tag.',
          entities: ['circuit_breaker_x42', 'common_retry_tag', 'tool_result_ent'],
          tokens: tokenizeAssociationText('circuit_breaker_x42 common_retry_tag tool_result_ent'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-shared-a',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:shared-a',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Shared tag item A',
          body: 'Mentions common_retry_tag only.',
          entities: ['common_retry_tag'],
          tokens: tokenizeAssociationText('common_retry_tag shared item a'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-shared-b',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:shared-b',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Shared tag item B',
          body: 'Also mentions tool_result_ent.',
          entities: ['tool_result_ent'],
          tokens: tokenizeAssociationText('tool_result_ent shared item b'),
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [
        {
          edgeId: edgeSeedToWeak,
          aId: 'a:m-seed-w',
          bId: 'a:m-hop1-weak',
          edgeType: 'entity',
          weight: 0.9,
          trust: 'trusted',
          reason: 'shared-entity:retry',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: edgeSeedToSharedA,
          aId: 'a:m-seed-w',
          bId: 'a:m-shared-a',
          edgeType: 'entity',
          weight: 0.7,
          trust: 'trusted',
          reason: 'shared-entity:a',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: edgeSeedToSharedB,
          aId: 'a:m-seed-w',
          bId: 'a:m-shared-b',
          edgeType: 'entity',
          weight: 0.65,
          trust: 'trusted',
          reason: 'shared-entity:b',
          createdAt: now,
          updatedAt: now,
        },
      ],
      derivedRefs: [],
    })
    await service.refreshIndex()

    const inspectTool: ToolDefinition = {
      name: 'inspect_env',
      description: 'Inspect environment',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { detail: { type: 'string' } }, required: ['detail'] },
        render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
      },
      async execute() {
        return { detail: 'Observed tool_result_ent in environment.' }
      },
    }
    ctx.tools.register(inspectTool)

    let stepNum = 0
    class WeakUseAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(): AsyncIterable<StreamChunk> {
        stepNum += 1
        if (stepNum === 1) {
          // Step 1 mentions ONLY prompt/shared entities (grpc_deadline, common_retry_tag) + calls tool
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield {
            type: 'text-delta',
            index: 0,
            text: 'Checking grpc_deadline and common_retry_tag.',
          }
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'text', text: 'Checking grpc_deadline and common_retry_tag.' },
          }
          yield { type: 'block-start', index: 1, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: 1,
            id: ToolCallId('call-env-1'),
            name: 'inspect_env',
            argumentsDelta: '{}',
          }
          yield {
            type: 'block-end',
            index: 1,
            block: { type: 'tool-call', id: ToolCallId('call-env-1'), name: 'inspect_env', arguments: '{}' },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        // Step 2 reappears unique entity circuit_breaker_x42 alongside tool_result_ent
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'text-delta',
          index: 0,
          text: 'Enabled circuit_breaker_x42 after observing tool_result_ent.',
        }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'text', text: 'Enabled circuit_breaker_x42 after observing tool_result_ent.' },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new WeakUseAdapter())

    const sessId = findHoldoutTaskSessionId(service, 'weak-use', false)
    const agent = await harness.create(
      SessionId(sessId),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    ;(agent.session.append as unknown as (type: string, data: unknown) => unknown)(
      'sandbox/mode',
      { mode: 'danger-full-access' },
    )
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Check grpc_deadline budget issues' }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
    await service.flush()

    const inspectResult = agent.session
      .snapshotEvents()
      .find((ev) => ev.type === 'tool/result')
    expect(inspectResult?.type).toBe('tool/result')
    if (inspectResult?.type === 'tool/result') {
      expect(inspectResult.data.message.isError).not.toBe(true)
    }

    // Shared entities common_retry_tag & tool_result_ent MUST NOT reinforce shared-a or shared-b!
    const sharedAWeight = (
      service.store!.database
        .prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?')
        .get(edgeSeedToSharedA) as { weight: number }
    ).weight
    const sharedBWeight = (
      service.store!.database
        .prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?')
        .get(edgeSeedToSharedB) as { weight: number }
    ).weight
    expect(sharedAWeight).toBeCloseTo(0.7, 6)
    expect(sharedBWeight).toBeCloseTo(0.65, 6)

    // Unique entity circuit_breaker_x42 reinforced edgeSeedToWeak by +α/3 = +0.1 (0.9 -> 1.0)
    const afterWeak = (
      service.store!.database
        .prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?')
        .get(edgeSeedToWeak) as { weight: number }
    ).weight
    expect(afterWeak).toBeCloseTo(1.0, 6)

    // Weak -> Strong upgrade on same taskId applies exact remaining +(α - α/3) = +0.2 (1.0 -> 1.2)
    await service.readById(makeExec(agent, 'upgrade-read-1'), 'a:m-hop1-weak')
    await service.flush()

    const afterUpgrade = (
      service.store!.database
        .prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?')
        .get(edgeSeedToWeak) as { weight: number }
    ).weight
    expect(afterUpgrade).toBeCloseTo(1.2, 6)

    const expRow = service.store!.database
      .prepare('SELECT weak_used, strong_used, hebbian_delta_applied FROM assoc_exposures WHERE task_id = ? AND node_id = ?')
      .get(`headless-session:${sessId}:turn:1`, 'a:m-hop1-weak') as {
      weak_used: number
      strong_used: number
      hebbian_delta_applied: number
    }
    expect(expRow.weak_used).toBe(1)
    expect(expRow.strong_used).toBe(1)
    expect(expRow.hebbian_delta_applied).toBeCloseTo(0.3, 6)

    // Interrupted assistant/message must NOT trigger weak use
    const intSessId = findHoldoutTaskSessionId(service, 'weak-interrupted', false)
    const intAgent = await harness.create(
      SessionId(intSessId),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    intAgent.session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'Check grpc_deadline' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    service.contextSnapshot(intAgent)
    await service.flush()
    intAgent.session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-int-1' as never,
          role: 'assistant',
          content: [{ type: 'text', text: 'Partial circuit_breaker_x42 prefix' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
        stream: [],
        interrupted: true,
      },
      { surfaceOp: 'append' },
    )
    await service.flush()
    const afterInterrupted = (
      service.store!.database
        .prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?')
        .get(edgeSeedToWeak) as { weight: number }
    ).weight
    expect(afterInterrupted).toBeCloseTo(1.2, 6)
  })

  test('exponential non-use decay respects nonUseGraceMs, semigroup invariance, [wMin, wMax], and rebuildEdgesOnly() live index swap', async () => {
    const { root, service, harness, ownerScope } = await setupRuntimeHarness({
      hebbian: {
        weightMin: 0.1,
        weightMax: 3.0,
        decayHalfLifeMs: 10 * 86_400_000,
        nonUseGraceMs: 5 * 86_400_000,
        decayIntervalMs: 3_600_000,
      },
    })

    const t0 = 1_700_000_000_000
    service.setNowClock(() => t0)

    const edgeA = computeDeterministicEdgeId('a:m-decay-seed', 'a:m-decay-a', 'entity')
    const edgeB = computeDeterministicEdgeId('a:m-decay-seed', 'a:m-decay-b', 'entity')

    service.store!.upsertBatch({
      nodes: [
        {
          id: 'a:m-decay-seed',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:d-seed',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'decay_anchor_token',
          body: 'Anchor node.',
          entities: ['decay_anchor_token'],
          tokens: tokenizeAssociationText('decay_anchor_token'),
          createdAt: t0,
          updatedAt: t0,
        },
        {
          id: 'a:m-decay-a',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:d-a',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Decaying candidate A',
          body: 'Candidate A body.',
          entities: ['decay_cand_a'],
          tokens: tokenizeAssociationText('decay_cand_a'),
          createdAt: t0,
          updatedAt: t0,
        },
        {
          id: 'a:m-decay-b',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:d-b',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Fresh candidate B',
          body: 'Candidate B body.',
          entities: ['decay_cand_b'],
          tokens: tokenizeAssociationText('decay_cand_b'),
          createdAt: t0,
          updatedAt: t0,
        },
      ],
      edges: [
        {
          edgeId: edgeA,
          aId: 'a:m-decay-seed',
          bId: 'a:m-decay-a',
          edgeType: 'entity',
          weight: 2.0,
          trust: 'trusted',
          reason: 'decay-test-a',
          lastUsedAt: t0,
          createdAt: t0,
          updatedAt: t0,
        },
        {
          edgeId: edgeB,
          aId: 'a:m-decay-seed',
          bId: 'a:m-decay-b',
          edgeType: 'entity',
          weight: 1.5,
          trust: 'trusted',
          reason: 'decay-test-b',
          lastUsedAt: t0 + 10 * 86_400_000,
          createdAt: t0,
          updatedAt: t0,
        },
      ],
      derivedRefs: [],
    })
    await service.refreshIndex()

    // Within grace period (t0 + 4d): zero decay
    await service.runHebbianDecayPass(t0 + 4 * 86_400_000)
    const wWithinGrace = (
      service.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edgeA) as {
        weight: number
      }
    ).weight
    expect(wWithinGrace).toBeCloseTo(2.0, 6)

    // Step at t1 = t0 + 10d (5d past grace = half of 10d half-life) then t2 = t0 + 15d (10d past grace = exact 1 half-life -> 1.0)
    // Edge B was used at t0 + 10d so its grace ends at t0 + 15d -> Edge B stays at 1.5!
    const acBefore = (service as unknown as { activeIndex: { ac: unknown; buildEpoch: number } }).activeIndex.ac
    const epochBefore = (service as unknown as { activeIndex: { buildEpoch: number } }).activeIndex.buildEpoch

    await service.runHebbianDecayPass(t0 + 10 * 86_400_000)
    await service.runHebbianDecayPass(t0 + 15 * 86_400_000)

    const wAfterSemigroup = (
      service.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edgeA) as {
        weight: number
      }
    ).weight
    const wFreshB = (
      service.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edgeB) as {
        weight: number
      }
    ).weight
    expect(wAfterSemigroup).toBeCloseTo(1.0, 5)
    expect(wFreshB).toBeCloseTo(1.5, 6)

    // Verify rebuildEdgesOnly() swapped activeIndex immutably while reusing the exact AC automaton!
    const activeIdxAfter = (service as unknown as { activeIndex: { ac: unknown; buildEpoch: number } }).activeIndex
    expect(activeIdxAfter.buildEpoch).toBeGreaterThan(epochBefore)
    expect(activeIdxAfter.ac).toBe(acBefore)

    // Live query now ranks Fresh B (weight 1.5) above Decayed A (weight 1.0)
    const probeSessId = findHoldoutTaskSessionId(service, 'decay-probe', false)
    const probeAgent = await harness.create(
      SessionId(probeSessId),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    probeAgent.session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'Lookup decay_anchor_token' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    const snap = service.contextSnapshot(probeAgent)
    const idxA = snap.indexOf('a:m-decay-a')
    const idxB = snap.indexOf('a:m-decay-b')
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(-1)
    expect(idxB).toBeLessThan(idxA)

    // Extreme time jump clamps at weightMin = 0.1
    await service.runHebbianDecayPass(t0 + 200 * 86_400_000)
    const wClamped = (
      service.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edgeA) as {
        weight: number
      }
    ).weight
    expect(wClamped).toBeCloseTo(0.1, 6)
  })

  test('owner correction (−β) down-weights only corrected task via Evaluation and latest uncorrected exposure via personal-memory replace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assoc-s2-corr-'))
    const workspace = join(root, 'ws')
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })

    ctx.provide('workingDirectory' as never, { ensure: async () => workspace, set: async () => workspace } as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const ownerPrincipal = { channel: 'lark', account: 'bot', tenant: 't1', user: 'ou_owner' }
    const ownerConv = { channel: 'lark', account: 'bot', tenant: 't1', kind: 'dm' as const, chat: 'chat_1' }
    const authority: OwnerRouteAuthority = {
      id: 'owner-route-corr',
      conversation: ownerConv,
      principal: ownerPrincipal,
      workspace,
      agentPreset: 'primary',
      policyRef: 'owner-dm',
      minimumGeneration: 1,
    }

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        {
          id: 'local-pair',
          effect: 'allow',
          subject: { kind: 'external', id: 'local:test' },
          actions: ['pair.issue'],
          resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['foreground'] },
        },
        {
          id: 'owner-pair',
          effect: 'allow',
          subject: { kind: 'external', id: 'lark/bot/t1/ou_owner' },
          actions: ['pair.confirm'],
          resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['external'] },
        },
        {
          id: 'allow-agent',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace },
          actions: ['*'],
          resource: { kind: '*', id: '*' },
          context: { initiators: ['foreground'] },
        },
      ],
    })

    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      ownerRoutes: [authority],
    })
    const delivery = ctx.assistantDelivery
    const dStore = (
      delivery as unknown as {
        deliveryStore: {
          getPrincipal: (p: unknown) => { id: string; version: number } | undefined
          createBinding: (input: unknown) => { id: string }
          claimNativeInbox: (input: unknown) => { record: { id: string }; fencingToken?: string }
          bindForegroundTaskExecution: (input: unknown) => void
          recordForegroundExecutionModelSelection: (input: unknown) => void
          finishForegroundTaskExecution: (input: unknown) => void
          finishInbox: (input: unknown) => void
          enqueue: (input: unknown) => void
        }
      }
    ).deliveryStore

    const pairing = delivery.issuePairing('test', ownerPrincipal)
    delivery.confirmPairing({ challengeId: pairing.challenge.id, principal: ownerPrincipal, code: pairing.code })
    const ownerRow = dStore.getPrincipal(ownerPrincipal)!

    await ctx.plugin(AssistantEvaluationService, { databasePath: join(root, 'eval.sqlite') })
    await ctx.plugin(PersonalMemoryService, {
      databasePath: join(root, 'memory.sqlite'),
      approvalMode: 'delivery-required',
    })
    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
      hotPathBudgetMs: 50,
      hebbian: {
        alpha: 0.25,
        beta: 0.4,
        weightMin: 0.05,
        weightMax: 3.0,
        correctionLookbackMs: 86_400_000,
      },
    })

    const pm = ctx.personalMemory
    const evalSvc = ctx.assistantEvaluation
    const assoc = ctx.assistantAssociation
    assoc.setHotPathClock(() => 0)
    const now = 1_700_000_200_000
    assoc.setNowClock(() => now)

    const ownerDigest = computePrincipalDigest('lark/bot/t1/ou_owner')
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: ownerDigest,
      principalRecordId: ownerRow.id,
      principalVersion: ownerRow.version,
      workspace,
      agentPreset: 'primary',
    })

    const agent = makeStubAgent('sess-corr-owner', workspace, 'primary')
    const binding = dStore.createBinding({
      conversation: ownerConv,
      principal: ownerPrincipal,
      workspace,
      agentPreset: 'primary',
      sessionId: String(agent.session.id),
      policyRef: 'owner-dm',
    })

    // Add two approved memories via PersonalMemoryService
    const addMem = async (key: string, content: string) => {
      const prop = pm.propose(agent, {
        idempotencyKey: key,
        principal: 'lark/bot/t1/ou_owner',
        mutation: {
          op: 'add',
          identity: { owner: 'user', scope: 'workspace', workspace },
          entry: {
            kind: 'fact',
            content,
            sensitivity: 'private',
            trust: 'user-confirmed',
            confidence: 1,
            provenance: { source: 'test', observedAt: now },
          },
        },
      })
      const decided = pm.decideProposal({
        proposalId: prop.proposalId,
        principal: 'lark/bot/t1/ou_owner',
        expectedVersion: prop.version,
        decision: 'approved',
        reason: 'ok',
      })
      return decided.record!.id
    }

    const mem1Id = await addMem('corr-mem-1', 'Use wrong_flag_v1 for cache invalidation.')
    const mem2Id = await addMem('corr-mem-2', 'Use innocent_flag_v2 for metrics export.')
    await assoc.syncAll()

    // Seed Hop-1 helper nodes + edges E1 (connected to a:m-${mem1Id}) and E2 (connected to a:m-${mem2Id})
    const nodeMem1 = `a:m-${mem1Id}`
    const nodeMem2 = `a:m-${mem2Id}`
    const edge1 = computeDeterministicEdgeId('a:m-seed-c1', nodeMem1, 'entity')
    const edge2 = computeDeterministicEdgeId('a:m-seed-c2', nodeMem2, 'entity')
    assoc.store!.upsertBatch({
      nodes: [
        {
          id: 'a:m-seed-c1',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:seed-c1',
          sourceVersion: 1,
          ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: ownerDigest,
          principalRecordId: ownerRow.id,
          principalVersion: ownerRow.version,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Seed C1',
          body: 'Seed C1',
          entities: ['seed_c1'],
          tokens: tokenizeAssociationText('seed_c1'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-seed-c2',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:seed-c2',
          sourceVersion: 1,
          ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: ownerDigest,
          principalRecordId: ownerRow.id,
          principalVersion: ownerRow.version,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Seed C2',
          body: 'Seed C2',
          entities: ['seed_c2'],
          tokens: tokenizeAssociationText('seed_c2'),
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [
        {
          edgeId: edge1,
          aId: 'a:m-seed-c1',
          bId: nodeMem1,
          edgeType: 'entity',
          weight: 1.0,
          trust: 'trusted',
          reason: 'corr-e1',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: edge2,
          aId: 'a:m-seed-c2',
          bId: nodeMem2,
          edgeType: 'entity',
          weight: 1.0,
          trust: 'trusted',
          reason: 'corr-e2',
          createdAt: now,
          updatedAt: now,
        },
      ],
      derivedRefs: [],
    })

    // Create foreground turn T1 (will be corrected via Evaluation) and T2 (unrelated innocent task)
    const inbox1 = dStore.claimNativeInbox({
      envelope: {
        channel: 'lark',
        account: 'bot',
        eventId: 'evt-corr-t1',
        occurredAt: now,
        principal: ownerPrincipal,
        conversation: ownerConv,
        kind: 'text',
        text: 'Task T1 query',
      },
      binding,
      ownerLineage: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      ownerId: 'w1',
      leaseMs: 100_000,
    })
    dStore.bindForegroundTaskExecution({
      inboxId: inbox1.record.id,
      scope: { workspace, preset: 'primary' },
      owner: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      binding,
      dispatchedAt: now,
    })
    dStore.recordForegroundExecutionModelSelection({ inboxId: inbox1.record.id, provider: 'mock', model: 'mock' })
    dStore.finishForegroundTaskExecution({ inboxId: inbox1.record.id, status: 'succeeded', quiescent: true, completedAt: now + 10 })
    dStore.finishInbox({ inboxId: inbox1.record.id, ownerId: 'w1', fencingToken: inbox1.fencingToken!, outcome: 'processed' })
    dStore.enqueue({
      idempotencyKey: `inbound:${inbox1.record.id}:reply`,
      bindingId: binding.id,
      target: { principal: ownerPrincipal, conversation: ownerConv },
      text: 'Reply T1',
      format: 'plain',
      replyToEventId: 'evt-corr-t1',
    })

    const task1Id = `foreground-turn:${inbox1.record.id}`
    const task2Id = 'foreground-turn:innocent-t2'
    assoc.store!.recordMetricsAndExposures(
      [],
      [
        {
          taskId: task1Id,
          nodeId: nodeMem1,
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now + 20,
          wasExposed: true,
          hop: 1,
          score: 0.9,
          reason: 'via edge1',
          provenanceEdges: [{ edgeId: edge1, aId: 'a:m-seed-c1', bId: nodeMem1, edgeType: 'entity' }],
          strongUsed: true,
        },
        {
          taskId: task2Id,
          nodeId: nodeMem2,
          ownerScopeKey,
          sourcePlugin: 'personal-memory',
          exposedAt: now + 30,
          wasExposed: true,
          hop: 1,
          score: 0.9,
          reason: 'via edge2',
          provenanceEdges: [{ edgeId: edge2, aId: 'a:m-seed-c2', bId: nodeMem2, edgeType: 'entity' }],
          strongUsed: true,
        },
      ],
    )
    await assoc.syncAll()

    // Evaluation negative user-feedback on T1 -> triggers −β on edge1 ONLY, leaving edge2 untouched!
    evalSvc.createHostScope({ workspace, preset: 'primary' })
    const evalStore = (evalSvc as unknown as {
      store: { append: (input: unknown, command?: unknown) => { id: string } }
    }).store
    evalStore.append(
      {
        scope: { workspace, preset: 'primary' },
        situation: 'foreground turn T1 correction',
        executionStatus: 'succeeded',
        objectiveStatus: 'not-achieved',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [{ kind: 'foreground-turn', ref: inbox1.record.id }],
        metrics: {},
        occurredAt: now + 50,
        idempotencyKey: 'eval-t1-neg',
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      },
      {
        operationId: 'op-t1-neg',
        principalRecordId: ownerRow.id,
        principalVersion: ownerRow.version,
        action: 'initial',
      },
    )
    await assoc.syncAll()

    const wEdge1AfterEval = (
      assoc.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edge1) as {
        weight: number
      }
    ).weight
    const wEdge2AfterEval = (
      assoc.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edge2) as {
        weight: number
      }
    ).weight
    expect(wEdge1AfterEval).toBeCloseTo(0.6, 6) // 1.0 - 0.4 = 0.6
    expect(wEdge2AfterEval).toBeCloseTo(1.0, 6) // Unrelated T2 untouched!

    // Now test personal-memory replace on mem2Id -> triggers −β on latest uncorrected exposure (T2)
    const replaceProp = pm.propose(agent, {
      idempotencyKey: 'corr-mem-2-replace',
      principal: 'lark/bot/t1/ou_owner',
      mutation: {
        op: 'replace',
        identity: { owner: 'user', scope: 'workspace', workspace },
        id: mem2Id,
        expectedVersion: 1,
        entry: {
          kind: 'fact',
          content: 'Corrected: use correct_flag_v3 for metrics export.',
          sensitivity: 'private',
          trust: 'user-confirmed',
          confidence: 1,
          provenance: { source: 'test', observedAt: now + 100 },
        },
      },
    })
    pm.decideProposal({
      proposalId: replaceProp.proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: replaceProp.version,
      decision: 'approved',
      reason: 'owner-correction',
    })
    await assoc.flush()

    const wEdge2AfterReplace = (
      assoc.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edge2) as {
        weight: number
      }
    ).weight
    expect(wEdge2AfterReplace).toBeCloseTo(0.6, 6) // 1.0 - 0.4 = 0.6
  })

  test('WP22 parameter tuning end-to-end: auto-tighten, holdout-replay relaxation, exact-parent rollback, and symmetrical assoc_task_telemetry', async () => {
    const DAY_MS = 86_400_000
    const { root, ctx, service, harness, ownerScope } = await setupRuntimeHarness({
      paramTuning: {
        enabled: true,
        minSample: 20,
        minHoldoutSamples: 20,
        lowUsageRatePpm: 100_000,
        highCorrectionRatePpm: 250_000,
        observationMs: 7 * DAY_MS,
        evaluationWindowMs: 7 * DAY_MS,
        relaxationReplayWindowMs: 30 * DAY_MS,
        relaxationReplayEnabled: true,
      },
    })

    const baseTime = 1_700_000_000_000
    service.setNowClock(() => baseTime)

    // Seed Hop-0 -> Hop-1 -> Hop-2 chain so Hop-2 item appears under maxHops=2, but disappears when tightened to maxHops=1!
    const e01 = computeDeterministicEdgeId('a:m-wp-seed', 'a:m-wp-hop1', 'entity')
    const e12 = computeDeterministicEdgeId('a:m-wp-hop1', 'a:m-wp-hop2', 'entity')
    service.store!.upsertBatch({
      nodes: [
        {
          id: 'a:m-wp-seed',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:wp-seed',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'wp22_anchor_query',
          body: 'Anchor wp22_anchor_query node.',
          entities: ['wp22_anchor_query'],
          tokens: tokenizeAssociationText('wp22_anchor_query'),
          createdAt: baseTime,
          updatedAt: baseTime,
        },
        {
          id: 'a:m-wp-hop1',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:wp-hop1',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Hop 1 bridge',
          body: 'Intermediate bridge.',
          entities: ['wp22_bridge'],
          tokens: tokenizeAssociationText('wp22_bridge'),
          createdAt: baseTime,
          updatedAt: baseTime,
        },
        {
          id: 'a:m-wp-hop2',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:wp-hop2',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Hop 2 deep useful insight',
          body: 'Deep insight wp22_deep_target.',
          entities: ['wp22_deep_target'],
          tokens: tokenizeAssociationText('wp22_deep_target'),
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
      edges: [
        {
          edgeId: e01,
          aId: 'a:m-wp-seed',
          bId: 'a:m-wp-hop1',
          edgeType: 'entity',
          weight: 1.0,
          trust: 'trusted',
          reason: 'wp22-e01',
          createdAt: baseTime,
          updatedAt: baseTime,
        },
        {
          edgeId: e12,
          aId: 'a:m-wp-hop1',
          bId: 'a:m-wp-hop2',
          edgeType: 'entity',
          weight: 1.0,
          trust: 'trusted',
          reason: 'wp22-e12',
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
      derivedRefs: [],
    })
    await service.refreshIndex()

    let reportUsage = true
    class TelemetryAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Ack.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ack.' } }
        if (reportUsage) {
          yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 } }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new TelemetryAdapter())

    // Run 1 injected task (with TokenUsage) and 1 holdout task (without TokenUsage -> nulls preserved!)
    const injSess = findHoldoutTaskSessionId(service, 'tel-inj', false)
    const injAgent = await harness.create(
      SessionId(injSess),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    injAgent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Query wp22_anchor_query' }],
        source: { kind: 'user' },
      }),
    )
    await injAgent.whenIdle()

    reportUsage = false
    const holdSess = findHoldoutTaskSessionId(service, 'tel-hold', true)
    const holdAgent = await harness.create(
      SessionId(holdSess),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    holdAgent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Query wp22_anchor_query' }],
        source: { kind: 'user' },
      }),
    )
    await holdAgent.whenIdle()
    await service.flush()

    const injTel = service.store!.database
      .prepare('SELECT in_holdout, turns, steps, input_tokens, output_tokens, cost_usd_micros FROM assoc_task_telemetry WHERE task_id = ?')
      .get(`headless-session:${injSess}:turn:1`) as {
      in_holdout: number
      turns: number
      steps: number
      input_tokens: number | null
      output_tokens: number | null
      cost_usd_micros: number | null
    }
    expect(injTel).toEqual({
      in_holdout: 0,
      turns: 1,
      steps: 1,
      input_tokens: 130,
      output_tokens: 30,
      cost_usd_micros: null,
    })

    const holdTel = service.store!.database
      .prepare('SELECT in_holdout, turns, steps, input_tokens, output_tokens, cost_usd_micros FROM assoc_task_telemetry WHERE task_id = ?')
      .get(`headless-session:${holdSess}:turn:1`) as typeof injTel
    expect(holdTel).toEqual({
      in_holdout: 1,
      turns: 1,
      steps: 1,
      input_tokens: null,
      output_tokens: null,
      cost_usd_micros: null,
    })

    // Confirm real replay episode cues were captured by contextSnapshot!
    const replayRow = service.store!.database
      .prepare('SELECT cues_json, profile_version FROM assoc_replay_episodes WHERE task_id = ?')
      .get(`headless-session:${injSess}:turn:1`) as { cues_json: string; profile_version: number }
    expect(replayRow.profile_version).toBe(0)
    expect(replayRow.cues_json).toContain('wp22_anchor_query')

    // 1) Auto-tighten on high timeout rate (>= 5% over >= 20 steps) -> maxHops 2 -> 1
    const timeoutMetrics = Array.from({ length: 22 }, (_, i) => ({
      taskId: `auto-to-${i}`,
      ownerScopeKey: ownerScope.ownerScopeKey,
      inHoldout: false,
      latencyUs: 6_000,
      timedOut: i < 4,
      fallbackMode: (i < 4 ? 'timeout' : 'none') as 'timeout' | 'none',
      injectedCount: i < 4 ? 0 : 1,
      candidateCount: 1,
      sourceCounts: i < 4 ? {} : { memory: 1 },
      profileVersion: 0,
      occurredAt: baseTime + 1_000 + i,
    }))
    service.store!.recordMetricsAndExposures(timeoutMetrics, [])

    const tick1 = service.reconcileParamTuning(ownerScope.ownerScopeKey, baseTime + 2_000)
    expect(tick1.action).toBe('adopted')
    if (tick1.action === 'adopted') {
      expect(tick1.version).toBe(1)
      expect(tick1.change).toEqual({ parameter: 'maxHops', from: 2, to: 1, steps: 1 })
    }
    expect(service.currentParamProfile(ownerScope.ownerScopeKey).parameters.maxHops).toBe(1)

    // Verify contextSnapshot immediately picks up tightened maxHops=1 (a:m-wp-hop2 is NOT injected!)
    const tightSessId = findHoldoutTaskSessionId(service, 'wp22-tight-probe', false)
    const tightProbe = await harness.create(
      SessionId(tightSessId),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    tightProbe.session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'Query wp22_anchor_query' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    const tightBlock = service.contextSnapshot(tightProbe)
    expect(tightBlock).toContain('a:m-wp-hop1')
    expect(tightBlock).not.toContain('a:m-wp-hop2')

    // Settle v1 after 7d with zero degradation
    const settleTime = baseTime + 2_000 + 7 * DAY_MS + 10
    const settled = service.reconcileParamTuning(ownerScope.ownerScopeKey, settleTime)
    expect(settled).toEqual({ action: 'settled', version: 1 })

    // 2) Holdout-replay-gated relaxation: advance past the old 30d timeout era, then propose maxHops 1 -> 2
    const holdoutStart = settleTime + 31 * DAY_MS
    for (let i = 0; i < 20; i += 1) {
      service.store!.recordHoldoutAssignment({
        taskId: `wp22-holdout-${i}`,
        ownerScopeKey: ownerScope.ownerScopeKey,
        taskKind: 'foreground-turn',
        sessionId: `h-${i}`,
        turnNumber: 1,
        inHoldout: true,
        bucketBps: 500,
        rateBps: 1250,
        hmacDigest: 'a'.repeat(64),
        assignedAt: holdoutStart + i,
      })
    }
    // Record positive usage of Hop-2 in captured replay episodes so counterfactual replay shows net recall gain under maxHops=2
    for (const [idx, epTaskId] of [
      `headless-session:${injSess}:turn:1`,
      `headless-session:${tightSessId}:turn:0`,
      'wp22-replay-ep-1',
    ].entries()) {
      service.store!.upsertReplayEpisode({
        taskId: epTaskId,
        ownerScopeKey: ownerScope.ownerScopeKey,
        inHoldout: false,
        cues: [{ kind: 'user', text: 'wp22_anchor_query', weight: 1.0 }],
        usedNodeIds: ['a:m-wp-seed', 'a:m-wp-hop1', 'a:m-wp-hop2'],
        correctedNodeIds: [],
        profileVersion: 1,
        occurredAt: holdoutStart + 50 + idx,
      })
    }

    const baseParams = fromAssociationConfig(normalizeConfig({ databasePath: ':memory:' }))
    const reqRes = service.requestParamTuning({
      scopeKey: ownerScope.ownerScopeKey,
      candidate: baseParams, // relaxes maxHops 1 -> 2
      reason: 'recover-hop2-recall',
      nowMs: holdoutStart + 100,
    })
    expect(reqRes.status).toBe('proposed')

    const relaxTick = service.reconcileParamTuning(ownerScope.ownerScopeKey, holdoutStart + 200)
    if (relaxTick.action === 'relax-rejected') {
      throw new Error(`Unexpected relax-rejected: ${JSON.stringify(relaxTick)}`)
    }
    expect(relaxTick.action).toBe('relax-adopted')
    if (relaxTick.action === 'relax-adopted') {
      expect(relaxTick.version).toBe(2)
      expect(relaxTick.replay.verdict).toBe('pass')
    }
    expect(service.currentParamProfile(ownerScope.ownerScopeKey).parameters.maxHops).toBe(2)

    // 3) Post-adoption regression triggers exact-parent rollback to v1 and blocks re-adoption of v2's digest
    const regMetrics = Array.from({ length: 22 }, (_, i) => ({
      taskId: `reg-post-${i}`,
      ownerScopeKey: ownerScope.ownerScopeKey,
      inHoldout: false,
      latencyUs: 7_000,
      timedOut: i < 10, // ~45% timeouts -> regresses vs basis!
      fallbackMode: (i < 10 ? 'timeout' : 'none') as 'timeout' | 'none',
      injectedCount: i < 10 ? 0 : 1,
      candidateCount: 1,
      sourceCounts: i < 10 ? {} : { memory: 1 },
      profileVersion: 2,
      occurredAt: holdoutStart + 300 + i,
    }))
    service.store!.recordMetricsAndExposures(regMetrics, [])

    const rbTick = service.reconcileParamTuning(ownerScope.ownerScopeKey, holdoutStart + 500)
    expect(rbTick).toEqual({
      action: 'rolled-back',
      fromVersion: 2,
      toVersion: 1,
      reason: 'timeout-rate-regressed',
    })
    expect(service.currentParamProfile(ownerScope.ownerScopeKey).version).toBe(1)
    expect(service.currentParamProfile(ownerScope.ownerScopeKey).parameters.maxHops).toBe(1)

    const statusAfterRb = service.paramTuningStatus(ownerScope.ownerScopeKey)
    expect(statusAfterRb.blockedParamsDigests.length).toBeGreaterThanOrEqual(1)

    // Immediate re-proposal of the rolled-back parameter set is rejected!
    const reReq = service.requestParamTuning({
      scopeKey: ownerScope.ownerScopeKey,
      candidate: baseParams,
      reason: 'retry-rolled-back',
      nowMs: holdoutStart + 600,
    })
    expect(reReq).toEqual({ status: 'rejected', reason: 'digest-previously-rolled-back' })

    // Verify auto-tighten also triggers on low usage rate (via global reconcileParamTuning() sweep)
    const lowUsageScopeKey = 'b'.repeat(64)
    const lowUsageMetrics = Array.from({ length: 22 }, (_, i) => ({
      taskId: `low-use-${i}`,
      ownerScopeKey: lowUsageScopeKey,
      inHoldout: false,
      latencyUs: 500,
      timedOut: false,
      fallbackMode: 'none' as const,
      injectedCount: 2,
      candidateCount: 2,
      sourceCounts: { memory: 2 },
      profileVersion: 0,
      occurredAt: holdoutStart + 700 + i,
    }))
    const lowUsageExposures = lowUsageMetrics.map((m) => ({
      taskId: m.taskId,
      nodeId: 'a:m-wp-seed',
      ownerScopeKey: lowUsageScopeKey,
      sourcePlugin: 'personal-memory',
      exposedAt: m.occurredAt,
      wasExposed: true,
    }))
    service.store!.recordMetricsAndExposures(lowUsageMetrics, lowUsageExposures)
    const allTicks = service.reconcileParamTuning(undefined, holdoutStart + 800)
    expect(allTicks[lowUsageScopeKey]?.action).toBe('adopted')
    if (allTicks[lowUsageScopeKey]?.action === 'adopted') {
      expect(allTicks[lowUsageScopeKey].change).toEqual({
        parameter: 'sourceWeightsPct.memory',
        from: 100,
        to: 90,
        steps: 1,
      })
    }

    // Verify extractEntities import is exercised cleanly if needed
    expect(extractEntities('wp22_anchor_query').length).toBeGreaterThan(0)
  })

  test('preserves shared-entity weak-use exclusion after sibling strongUsed, reinforces Hop-1 edges superseding sessionActivation (BUG-1), and wires all paramTuning fields in service', async () => {
    const DAY_MS = 86_400_000
    const { root, ctx, service, harness, ownerScope } = await setupRuntimeHarness({
      hebbian: {
        alpha: 0.3,
        weakRatio: 1 / 3,
        weightMin: 0.05,
        weightMax: 3.0,
      },
      paramTuning: {
        enabled: true,
        minSample: 20,
        minStepSample: 30,
        healthyUsageRatePpm: 200_000,
        lowUsageRatePpm: 300_000,
        maxTimeoutMarginPpm: 25_000,
        rollbackCooldownMs: 7 * DAY_MS,
      },
    })

    const now = 1_700_000_500_000
    service.setNowClock(() => now)

    const edgeToA = computeDeterministicEdgeId('a:m-sib-seed', 'a:m-sib-a', 'entity')
    const edgeToB = computeDeterministicEdgeId('a:m-sib-seed', 'a:m-sib-b', 'entity')
    const edgeUV = computeDeterministicEdgeId('a:m-bug1-u', 'a:m-bug1-v', 'entity')

    const padNodes = Array.from({ length: 7 }, (_, i) => ({
      id: `a:m-bug1-pad-${i}`,
      kind: 'memory' as const,
      sourcePlugin: 'personal-memory',
      sourceRef: `memory:bug1-pad-${i}`,
      sourceVersion: 1,
      ownerScopeKey: ownerScope.ownerScopeKey,
      ownerMode: 'headless' as const,
      principalDigest: ownerScope.principalDigest,
      principalRecordId: null,
      principalVersion: null,
      scopeMode: 'workspace' as const,
      workspace: root,
      agentPreset: 'primary',
      trust: 'trusted' as const,
      sensitivity: 'private' as const,
      title: `Pad node ${i}`,
      body: `Pad body ${i}`,
      entities: [`bug1_pad_ent_${i}`],
      tokens: tokenizeAssociationText(`Pad node ${i}`),
      createdAt: now,
      updatedAt: now,
    }))
    const padEdges = padNodes.map((p, i) => ({
      edgeId: computeDeterministicEdgeId('a:m-bug1-v', p.id, 'entity'),
      aId: 'a:m-bug1-v',
      bId: p.id,
      edgeType: 'entity' as const,
      weight: 0.85 + i * 0.01,
      trust: 'trusted' as const,
      reason: `edge:pad-${i}`,
      createdAt: now,
      updatedAt: now,
    }))

    service.store!.upsertBatch({
      nodes: [
        {
          id: 'a:m-sib-seed',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:sib-seed',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'sib_anchor_key',
          body: 'Anchor sib_anchor_key',
          entities: ['sib_anchor_key'],
          tokens: tokenizeAssociationText('sib_anchor_key'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-sib-a',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:sib-a',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Sibling A note',
          body: 'Mentions shared_sib_ent and sib_a_only',
          entities: ['shared_sib_ent', 'sib_a_only'],
          tokens: tokenizeAssociationText('shared_sib_ent sib_a_only'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-sib-b',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:sib-b',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Sibling B note',
          body: 'Mentions shared_sib_ent and sib_b_only',
          entities: ['shared_sib_ent', 'sib_b_only'],
          tokens: tokenizeAssociationText('shared_sib_ent sib_b_only'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-bug1-u',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:bug1-u',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'bug1_u_trigger bug1_u_extra',
          body: 'Trigger node u',
          entities: ['bug1_u_trigger', 'bug1_u_extra'],
          tokens: tokenizeAssociationText('bug1_u_trigger bug1_u_extra'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:m-bug1-v',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:bug1-v',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: ownerScope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace: root,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'bug1_v_seed',
          body: 'Target node v',
          entities: ['bug1_v_seed'],
          tokens: tokenizeAssociationText('bug1_v_seed'),
          createdAt: now,
          updatedAt: now,
        },
        ...padNodes,
      ],
      edges: [
        {
          edgeId: edgeToA,
          aId: 'a:m-sib-seed',
          bId: 'a:m-sib-a',
          edgeType: 'entity',
          weight: 1.0,
          trust: 'trusted',
          reason: 'sib-a',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: edgeToB,
          aId: 'a:m-sib-seed',
          bId: 'a:m-sib-b',
          edgeType: 'entity',
          weight: 1.0,
          trust: 'trusted',
          reason: 'sib-b',
          createdAt: now,
          updatedAt: now,
        },
        {
          edgeId: edgeUV,
          aId: 'a:m-bug1-u',
          bId: 'a:m-bug1-v',
          edgeType: 'entity',
          weight: 0.7,
          trust: 'trusted',
          reason: 'edge:bug1-uv',
          createdAt: now,
          updatedAt: now,
        },
        ...padEdges,
      ],
      derivedRefs: [],
    })
    await service.refreshIndex()

    // Part A: Step 1 calls assoc_read('a:m-sib-a') (strongUsed = true), Step 2 mentions shared_sib_ent -> a:m-sib-b MUST NOT get weak use!
    class SiblingAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model }
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const hasToolResult = (options.messages ?? []).some((m) => m.role === 'tool')
        if (!hasToolResult) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: 0,
            id: ToolCallId('call-sib-a'),
            name: 'assoc_read',
            argumentsDelta: JSON.stringify({ id: 'a:m-sib-a' }),
          }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: ToolCallId('call-sib-a'),
              name: 'assoc_read',
              arguments: JSON.stringify({ id: 'a:m-sib-a' }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Observed shared_sib_ent behavior.' }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'text', text: 'Observed shared_sib_ent behavior.' },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new SiblingAdapter())

    const sibSess = findHoldoutTaskSessionId(service, 'sib-uniq', false)
    const sibAgent = await harness.create(
      SessionId(sibSess),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    sibAgent.session.append('approval/policy', { policy: 'never' })
    sibAgent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    ;(sibAgent.session.append as unknown as (type: string, data: unknown) => unknown)(
      'sandbox/mode',
      { mode: 'danger-full-access' },
    )
    sibAgent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Investigate sib_anchor_key' }],
        source: { kind: 'user' },
      }),
    )
    await sibAgent.whenIdle()
    await service.flush()

    const wEdgeA = (
      service.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edgeToA) as {
        weight: number
      }
    ).weight
    const wEdgeB = (
      service.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edgeToB) as {
        weight: number
      }
    ).weight
    expect(wEdgeA).toBeCloseTo(1.3, 6)
    expect(wEdgeB).toBeCloseTo(1.0, 6)

    // Part B: BUG-1 E2E: Turn 1 seeds a:m-bug1-v into sessionActivation, Turn 2 hits a:m-bug1-u -> edgeUV -> a:m-bug1-v,
    // and assoc_read('a:m-bug1-v') reinforces edgeUV (2.0 -> 2.3)!
    let bug1Idx = 1
    let bug1Sess = ''
    while (true) {
      const cand = `bug1-e2e-${bug1Idx}`
      if (
        !service.isTaskInHoldout(`headless-session:${cand}:turn:1`).inHoldout &&
        !service.isTaskInHoldout(`headless-session:${cand}:turn:2`).inHoldout
      ) {
        bug1Sess = cand
        break
      }
      bug1Idx += 1
    }
    const bug1Agent = await harness.create(
      SessionId(bug1Sess),
      { provider: 'mock', model: 'mock-model' },
      { cwd: root, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    bug1Agent.session.append('turn/start', { turn: 1 })
    bug1Agent.session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'Check bug1_v_seed' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    expect(service.contextSnapshot(bug1Agent)).toContain('a:m-bug1-v')
    await service.flush()

    bug1Agent.session.append('turn/start', { turn: 2 })
    bug1Agent.session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'Now inspect bug1_u_trigger and bug1_u_extra' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    const turn2Block = service.contextSnapshot(bug1Agent)
    expect(turn2Block).toContain('edge:bug1-uv | trusted | a:m-bug1-v')
    await service.readById(makeExec(bug1Agent, 'bug1-read'), 'a:m-bug1-v')
    await service.flush()

    const wEdgeUVAfter = (
      service.store!.database.prepare('SELECT weight FROM assoc_edges WHERE edge_id = ?').get(edgeUV) as {
        weight: number
      }
    ).weight
    expect(wEdgeUVAfter).toBeCloseTo(1.0, 6)

    // Part C: Service wires minStepSample=30 and healthyUsageRatePpm=200_000 cleanly
    const wiredScope = 'c'.repeat(64)
    const batch20 = Array.from({ length: 20 }, (_, i) => ({
      taskId: `wired-t-${i}`,
      ownerScopeKey: wiredScope,
      inHoldout: false,
      latencyUs: 500,
      timedOut: i < 5,
      fallbackMode: (i < 5 ? 'timeout' : 'none') as 'timeout' | 'none',
      injectedCount: 1,
      candidateCount: 1,
      sourceCounts: { memory: 1 },
      profileVersion: 0,
      occurredAt: now + 100 + i,
    }))
    service.store!.recordMetricsAndExposures(
      batch20,
      batch20.map((m, i) => ({
        taskId: m.taskId,
        nodeId: 'a:m-sib-seed',
        ownerScopeKey: wiredScope,
        sourcePlugin: 'personal-memory',
        exposedAt: m.occurredAt,
        wasExposed: true,
        strongUsed: i < 5, // 25% >= healthyUsageRatePpm (200_000)
      })),
    )
    // Only 20 steps < minStepSample (30) -> must NOT tighten on high-timeout-rate or low-usage-rate!
    expect(service.reconcileParamTuning(wiredScope, now + 500)).toEqual({
      action: 'no-op',
      reason: 'below-threshold',
    })
  })
})
