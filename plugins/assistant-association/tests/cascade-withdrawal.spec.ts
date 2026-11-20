import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmRuntime, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService, type OwnerRouteAuthority } from '@dsh-enhanced/assistant-delivery'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { AssistantGoalsService } from '@dsh-enhanced/assistant-goals'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantWorkItemsService } from '@dsh-enhanced/assistant-work-items'
import { PersonalMemoryService } from '@dsh-enhanced/personal-memory'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantAssociationService,
  computeDeterministicEdgeId,
  computeOwnerScopeKey,
  computePrincipalDigest,
  normalizeSourceVersion,
  tokenizeAssociationText,
} from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
})

function stubSessionAgent(sessionId: string, cwd: string, preset = 'primary'): Agent {
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

describe('derivedFrom cascade withdrawal & conflict retraction across all 5 sources', () => {
  test('cascade-deletes derived nodes/edges across memory, goals, work-items, automations, and Evaluation withdraw vs conflict retract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assoc-cascade-'))
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
    const nativeGoals = new Map<
      Agent,
      {
        id: string
        revision: number
        objective: string
        phase: 'active' | 'paused' | 'blocked' | 'complete' | 'cleared'
        roundsStarted: number
        maxGoalRounds: number
        updatedAt: number
      }
    >()
    ctx.provide('goals' as never, {
      get: (a: Agent) => nativeGoals.get(a),
      create: (a: Agent, input: { objective: string; maxGoalRounds?: number }) => {
        const rec = {
          id: `native-goal-${Math.random().toString(36).slice(2)}`,
          revision: 1,
          objective: input.objective,
          phase: 'active' as const,
          roundsStarted: 0,
          maxGoalRounds: input.maxGoalRounds ?? 3,
          updatedAt: Date.now(),
        }
        nativeGoals.set(a, rec)
        return rec
      },
      clear: (a: Agent) => {
        const cur = nativeGoals.get(a)
        if (cur) {
          nativeGoals.delete(a)
          ctx.emit('goal/changed' as never, {
            agent: a,
            change: { operation: 'clear', ref: { id: cur.id, revision: cur.revision + 1 } },
          } as never)
        }
      },
      pause: (a: Agent) => {
        const cur = nativeGoals.get(a)
        if (cur) {
          cur.phase = 'paused'
          cur.revision += 1
          cur.updatedAt = Date.now()
          ctx.emit('goal/changed' as never, {
            agent: a,
            change: { operation: 'pause', ref: { id: cur.id, revision: cur.revision } },
          } as never)
        }
        return cur
      },
    } as never)

    const ownerPrincipal = { channel: 'lark', account: 'bot', tenant: 't1', user: 'ou_owner' }
    const ownerConv = { channel: 'lark', account: 'bot', tenant: 't1', kind: 'dm' as const, chat: 'chat_1' }
    const authority: OwnerRouteAuthority = {
      id: 'owner-route-cascade',
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
          actions: ['pair.confirm', 'ingest'],
          resource: { kind: 'message', id: '*' },
          context: { initiators: ['external'] },
        },
        {
          id: 'allow-agent',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace },
          actions: ['*'],
          resource: { kind: '*', id: '*' },
          context: { initiators: ['foreground', 'external'] },
        },
        {
          id: 'allow-bg',
          effect: 'allow',
          subject: { kind: 'background', id: '*', workspace },
          actions: ['*'],
          resource: { kind: '*', id: '*' },
          context: { initiators: ['background'] },
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
          claimNativeInbox: (input: unknown) => { record: { id: string }; fencingToken?: number }
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

    const sessionId = SessionId('sess-cascade-1')
    const agent = await ctx.agentLoop.create(
      sessionId,
      { provider: 'mock', model: 'mock' },
      { cwd: workspace, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = agent.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })

    const binding = dStore.createBinding({
      conversation: ownerConv,
      principal: ownerPrincipal,
      workspace,
      agentPreset: 'primary',
      sessionId: String(sessionId),
      policyRef: 'owner-dm',
    })

    await ctx.plugin(PersonalMemoryService, {
      databasePath: join(root, 'memory.sqlite'),
      approvalMode: 'delivery-required',
    })
    await ctx.plugin(AssistantGoalsService, {
      databasePath: join(root, 'goals.sqlite'),
    })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'),
      schedulerEnabled: false,
      reconcileIntervalMs: 0,
    })
    await ctx.plugin(AssistantWorkItemsService, {
      enabled: true,
      mode: 'active',
      databasePath: join(root, 'work-items.sqlite'),
      workRoot: join(root, 'work-root'),
      workerAutomationId: 'worker-auto-1',
      scope: {
        ownerRouteId: authority.id,
        principalId: 'lark/bot/t1/ou_owner',
        workspace,
        preset: 'primary',
        expiresAt: Date.now() + 600_000,
      },
      admission: { allowedKinds: ['repair'] },
    })
    await ctx.plugin(AssistantEvaluationService, {
      databasePath: join(root, 'evaluation.sqlite'),
      projectionIntervalMs: 0,
    })
    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
      holdoutSeed: 'cascade-test-seed-0123456789abcdef',
    })

    const assoc = ctx.assistantAssociation
    const pm = ctx.personalMemory
    const store = assoc.store!

    // 1. Personal-memory add -> attach derived summary node -> remove memory -> cascades derived node & edge + evicts session!
    const memProp = pm.propose(agent, {
      idempotencyKey: 'cas-mem-1',
      principal: 'lark/bot/t1/ou_owner',
      mutation: {
        op: 'add',
        identity: { owner: 'user', scope: 'workspace', workspace },
        entry: {
          kind: 'fact',
          content: 'cascade_token_alpha memory fact',
          sensitivity: 'private',
          trust: 'user-confirmed',
          confidence: 1,
          provenance: { source: 'test', observedAt: 1_000 },
        },
      },
    })
    const memAdded = pm.decideProposal({
      proposalId: memProp.proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: memProp.version,
      decision: 'approved',
      reason: 'ok',
    })
    await assoc.flush()
    const memNodeId = `a:m-${memAdded.record!.id}`
    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('lark/bot/t1/ou_owner'),
      principalRecordId: ownerRow.id,
      principalVersion: ownerRow.version,
      workspace,
      agentPreset: 'primary',
    })

    // Attach derived abstraction node + edge depending on (memNodeId, v1)
    const derivedEdgeId = computeDeterministicEdgeId(memNodeId, 'a:abs-derived', 'abstraction')
    store.upsertBatch({
      nodes: [
        {
          id: 'a:abs-derived',
          kind: 'abstraction',
          sourcePlugin: 'assistant-dreaming',
          sourceRef: 'dream:abs-cas',
          sourceVersion: 1,
          ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: computePrincipalDigest('lark/bot/t1/ou_owner'),
          principalRecordId: ownerRow.id,
          principalVersion: ownerRow.version,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Derived abstraction over cascade_token_alpha',
          body: 'Derived abstraction body',
          entities: ['cascade_token_alpha'],
          tokens: tokenizeAssociationText('cascade_token_alpha derived'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      edges: [
        {
          edgeId: derivedEdgeId,
          aId: memNodeId,
          bId: 'a:abs-derived',
          edgeType: 'abstraction',
          weight: 0.8,
          trust: 'trusted',
          reason: 'abstraction:cas',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      derivedRefs: [
        { sourceNodeId: memNodeId, sourceVersion: 1, targetKind: 'node', targetId: 'a:abs-derived' },
        { sourceNodeId: memNodeId, sourceVersion: 1, targetKind: 'edge', targetId: derivedEdgeId },
      ],
    })
    await assoc.refreshIndex()

    // Ensure session currently sees memNodeId in contextSnapshot (using non-holdout turn)
    agent.session.append('user/message', {
      role: 'user',
      id: 'u-cas-1' as never,
      content: [{ type: 'text', text: 'Tell me about cascade_token_alpha' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    const beforeWithdrawSnap = assoc.contextSnapshot(agent)
    expect(beforeWithdrawSnap).toContain(memNodeId)

    // Withdraw memory -> immediate session eviction + derived node/edge cascade deletion + assoc_read fail-closed
    const memRm = pm.propose(agent, {
      idempotencyKey: 'cas-mem-rm',
      principal: 'lark/bot/t1/ou_owner',
      mutation: {
        op: 'remove',
        identity: { owner: 'user', scope: 'workspace', workspace },
        id: memAdded.record!.id,
        expectedVersion: memAdded.record!.version,
      },
    })
    pm.decideProposal({
      proposalId: memRm.proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: memRm.version,
      decision: 'approved',
      reason: 'rm',
    })

    // Immediately after remove: contextSnapshot evicts memNodeId & derived node!
    const afterWithdrawSnap = assoc.contextSnapshot(agent)
    expect(afterWithdrawSnap).not.toContain(memNodeId)
    expect(afterWithdrawSnap).not.toContain('a:abs-derived')

    await assoc.flush()
    expect(store.getNodeById(memNodeId)).toBeNull()
    expect(store.getNodeById('a:abs-derived')).toBeNull()
    expect(store.loadActiveEdgesPage(100, 0).some((e) => e.edgeId === derivedEdgeId)).toBe(false)

    const readAfterRm = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('r-1'), name: 'assoc_read', arguments: JSON.stringify({ id: memNodeId }) }],
      agent,
      signal: new AbortController().signal,
    })
    expect(readAfterRm.results[0]!.result.isError).toBe(true)

    // 2. Goal clear cascade
    const turnInbox = dStore.claimNativeInbox({
      envelope: {
        channel: 'lark',
        account: 'bot',
        eventId: 'evt-cas-goal',
        occurredAt: 1_000,
        principal: ownerPrincipal,
        conversation: ownerConv,
        kind: 'text',
        text: 'Create goal for cascade',
      },
      binding,
      ownerLineage: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      ownerId: 'worker-1',
      leaseMs: 100_000,
    })
    agent.session.append('turn/start', { turn: 1 })
    agent.inbox.append(
      'next-turn',
      createUserMessage({
        content: [{ type: 'text', text: 'Create goal for cascade' }],
        source: { kind: 'delivery', channel: 'lark', account: 'bot', eventId: 'evt-cas-goal' } as never,
      }),
    )
    ;(agent.inbox as unknown as { claim: (t: 'next-turn', turn: number) => void }).claim('next-turn', 1)
    const goal = ctx.assistantGoals.create(agent, 'Goal to clear cascade_goal_token', 2)
    await assoc.flush()
    expect(store.getNodeById(`a:g-${goal.id}`)).not.toBeNull()
    ctx.assistantGoals.control(agent, {
      goalId: goal.id,
      expectedRevision: goal.native.revision,
      operation: 'clear',
    })
    await assoc.flush()
    expect(store.getNodeById(`a:g-${goal.id}`)).toBeNull()
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // 3. Work-item withdraw cascade
    const wi = ctx.assistantWorkItems.admit({
      kind: 'repair',
      externalId: 'wi-withdraw-1',
      title: 'Work item to withdraw',
      brief: 'Details',
      originBindingId: binding.id,
      provenance: {
        source: 'intake-test',
        sourceVersion: '1',
        signalDigest: 'b'.repeat(64),
        observedAt: Date.now(),
        evidence: {
          inboxId: turnInbox.record.id,
          completionSequence: 1,
          authorityHash: delivery.listActiveOwnerRouteScopes()[0]!.authorityHash,
        },
      },
    })
    await assoc.syncAll()
    expect(store.getNodeById(`a:w-${wi.item.id}`)).not.toBeNull()
    ctx.assistantWorkItems.withdraw({
      kind: 'repair',
      externalId: 'wi-withdraw-1',
      title: 'Work item to withdraw',
      brief: 'Details',
      originBindingId: binding.id,
    })
    await assoc.flush()
    expect(store.getNodeById(`a:w-${wi.item.id}`)).toBeNull()

    // 4. Automation delete cascade
    const autoStore = (ctx.assistantAutomations as unknown as {
      store: {
        createApproved: (input: { automationId: string; idempotencyKey: string; definition: unknown }) => { id: string; version: number }
        changeApproved: (input: { automationId: string; operation: 'delete'; expectedVersion: number; idempotencyKey: string }) => void
      }
    }).store
    const autoCreated = autoStore.createApproved({
      automationId: 'auto-to-delete',
      idempotencyKey: 'auto-del-1',
      definition: {
        name: 'Temp automation',
        prompt: 'Run once',
        schedule: { kind: 'at', at: '2035-01-01T00:00:00.000Z' },
        workspace,
        agentPreset: 'primary',
        provider: 'mock',
        model: 'mock',
        allowedTools: [],
        timeoutMs: 60_000,
        maxOutputTokens: 256,
        maxToolCalls: 0,
        misfire: { kind: 'latest' },
        overlap: 'skip',
        retrySafety: 'never',
        maxRetries: 0,
        principal: 'lark/bot/t1/ou_owner',
      },
    })
    await assoc.syncAll()
    expect(store.getNodeById('a:au-auto-to-delete')).not.toBeNull()
    autoStore.changeApproved({
      automationId: 'auto-to-delete',
      operation: 'delete',
      expectedVersion: autoCreated.version,
      idempotencyKey: 'auto-del-2',
    })
    await assoc.flush()
    expect(store.getNodeById('a:au-auto-to-delete')).toBeNull()

    // 5. Evaluation action === 'withdraw' (hard delete + tombstone) vs conflict disposition === 'retract' (suppress + low trust, no tombstone)
    const evalSvc = ctx.assistantEvaluation
    evalSvc.createHostScope({ workspace, preset: 'primary' })
    const fgInbox1 = turnInbox.record.id
    dStore.bindForegroundTaskExecution({
      inboxId: fgInbox1,
      scope: { workspace, preset: 'primary' },
      owner: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      binding,
      dispatchedAt: 1_000,
    })
    dStore.recordForegroundExecutionModelSelection({ inboxId: fgInbox1, provider: 'mock', model: 'mock' })
    dStore.finishForegroundTaskExecution({ inboxId: fgInbox1, status: 'succeeded', quiescent: true, completedAt: 2_000 })
    dStore.finishInbox({ inboxId: fgInbox1, ownerId: 'worker-1', fencingToken: turnInbox.fencingToken!, outcome: 'processed' })
    dStore.enqueue({
      idempotencyKey: `inbound:${fgInbox1}:reply`,
      bindingId: binding.id,
      target: { principal: ownerPrincipal, conversation: ownerConv },
      text: 'Foreground reply 1',
      format: 'plain',
      replyToEventId: 'evt-cas-goal',
    })
    await assoc.syncAll()
    const fgNodeId = `a:e-fg-${fgInbox1}`
    expect(store.getNodeById(fgNodeId)?.status).toBe('active')

    // Conflict retract (without 'withdraw') via Evaluation store/service -> suppresses node with conflicted: true & trust: 'low', NO withdrawal tombstone
    store.suppressNodeConflict({
      ownerScopeKey,
      sourcePlugin: 'assistant-delivery',
      sourceRef: `foreground-turn:${fgInbox1}`,
      objectiveStatus: 'objective-conflict',
    })
    const suppressedRow = store.getNodeById(fgNodeId)
    expect(suppressedRow?.status).toBe('suppressed')
    expect(suppressedRow?.trust).toBe('low')
    expect(suppressedRow?.metadata.conflicted).toBe(true)
    expect(store.isSourceWithdrawn(ownerScopeKey, 'assistant-delivery', `foreground-turn:${fgInbox1}`)).toBe(false)

    // Explicit withdraw via Evaluation -> hard delete + withdrawal tombstone (prevents re-ingestion on syncAll)
    const fgInbox2Obj = dStore.claimNativeInbox({
      envelope: {
        channel: 'lark',
        account: 'bot',
        eventId: 'evt-cas-withdraw',
        occurredAt: 2_000,
        principal: ownerPrincipal,
        conversation: ownerConv,
        kind: 'text',
        text: 'Foreground turn to withdraw via evaluation',
      },
      binding,
      ownerLineage: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      ownerId: 'worker-1',
      leaseMs: 100_000,
    })
    dStore.bindForegroundTaskExecution({
      inboxId: fgInbox2Obj.record.id,
      scope: { workspace, preset: 'primary' },
      owner: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      binding,
      dispatchedAt: 2_000,
    })
    dStore.recordForegroundExecutionModelSelection({ inboxId: fgInbox2Obj.record.id, provider: 'mock', model: 'mock' })
    dStore.finishForegroundTaskExecution({ inboxId: fgInbox2Obj.record.id, status: 'succeeded', quiescent: true, completedAt: 3_000 })
    dStore.finishInbox({ inboxId: fgInbox2Obj.record.id, ownerId: 'worker-1', fencingToken: fgInbox2Obj.fencingToken!, outcome: 'processed' })
    dStore.enqueue({
      idempotencyKey: `inbound:${fgInbox2Obj.record.id}:reply`,
      bindingId: binding.id,
      target: { principal: ownerPrincipal, conversation: ownerConv },
      text: 'Reply to be withdrawn',
      format: 'plain',
      replyToEventId: 'evt-cas-withdraw',
    })
    await assoc.syncAll()
    const fg2NodeId = `a:e-fg-${fgInbox2Obj.record.id}`
    expect(store.getNodeById(fg2NodeId)).not.toBeNull()

    // Register a trusted delivery evaluation outcome & withdraw it -> triggers Evaluation projection + withdraw cascade!
    const deliveryReg = (evalSvc as unknown as {
      store: {
        append: (input: unknown, command?: unknown) => { id: string }
      }
    }).store
    const outcomeInit = deliveryReg.append(
      {
        scope: { workspace, preset: 'primary' },
        situation: 'foreground-turn withdraw test',
        executionStatus: 'succeeded',
        objectiveStatus: 'achieved',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [
          { kind: 'foreground-turn', ref: fgInbox2Obj.record.id },
          { kind: 'delivery-outbox', ref: 'outbox-fg-2' },
        ],
        metrics: {},
        occurredAt: 3_100,
        idempotencyKey: 'eval-fg2-init',
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      },
      {
        operationId: 'op-init-1',
        principalRecordId: ownerRow.id,
        principalVersion: ownerRow.version,
        action: 'initial',
      },
    )
    expect(outcomeInit.id).toBeTruthy()
    deliveryReg.append(
      {
        scope: { workspace, preset: 'primary' },
        situation: 'foreground-turn withdraw test',
        executionStatus: 'succeeded',
        objectiveStatus: 'unknown',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [
          { kind: 'foreground-turn', ref: fgInbox2Obj.record.id },
          { kind: 'delivery-outbox', ref: 'outbox-fg-2' },
        ],
        metrics: {},
        occurredAt: 3_200,
        idempotencyKey: 'eval-fg2-withdraw',
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      },
      {
        operationId: 'op-wd-1',
        principalRecordId: ownerRow.id,
        principalVersion: ownerRow.version,
        action: 'withdraw',
        expectedVersion: 1,
        previousStatus: 'achieved',
      },
    )

    await assoc.syncAll()
    expect(store.getNodeById(fg2NodeId)).toBeNull()
    expect(
      store.isSourceWithdrawn(
        ownerScopeKey,
        'assistant-delivery',
        `foreground-turn:${fgInbox2Obj.record.id}`,
      ),
    ).toBe(true)

    // Subsequent syncAll MUST NOT resurrect the withdrawn foreground turn
    await assoc.syncAll()
    expect(store.getNodeById(fg2NodeId)).toBeNull()
    void stubSessionAgent
  })

  test('immediately omits withdrawn root & derived nodes from retainedBlock when >=2 items retained, cascades on hash-inverted supersessions, and handles same-pass Delivery+Evaluation retract/withdraw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assoc-cascade-reg-'))
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
    const nativeGoals = new Map<
      Agent,
      {
        id: string
        revision: number
        objective: string
        phase: 'active' | 'paused' | 'blocked' | 'complete' | 'cleared'
        roundsStarted: number
        maxGoalRounds: number
        updatedAt: number
      }
    >()
    ctx.provide('goals' as never, {
      get: (a: Agent) => nativeGoals.get(a),
      create: (a: Agent, input: { objective: string; maxGoalRounds?: number }) => {
        const rec = {
          id: `native-goal-${Math.random().toString(36).slice(2)}`,
          revision: 1,
          objective: input.objective,
          phase: 'active' as const,
          roundsStarted: 0,
          maxGoalRounds: input.maxGoalRounds ?? 3,
          updatedAt: Date.now(),
        }
        nativeGoals.set(a, rec)
        return rec
      },
      clear: (a: Agent) => {
        const cur = nativeGoals.get(a)
        if (cur) {
          nativeGoals.delete(a)
          ctx.emit('goal/changed' as never, {
            agent: a,
            change: { operation: 'clear', ref: { id: cur.id, revision: cur.revision + 1 } },
          } as never)
        }
      },
      pause: (a: Agent) => {
        const cur = nativeGoals.get(a)
        if (cur) {
          cur.phase = 'paused'
          cur.revision += 1
          cur.updatedAt = Date.now()
          ctx.emit('goal/changed' as never, {
            agent: a,
            change: { operation: 'pause', ref: { id: cur.id, revision: cur.revision } },
          } as never)
        }
        return cur
      },
    } as never)

    const ownerPrincipal = { channel: 'lark', account: 'bot', tenant: 't1', user: 'ou_owner' }
    const ownerConv = { channel: 'lark', account: 'bot', tenant: 't1', kind: 'dm' as const, chat: 'chat_reg' }
    const authority: OwnerRouteAuthority = {
      id: 'owner-route-reg',
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
          actions: ['pair.confirm', 'ingest'],
          resource: { kind: 'message', id: '*' },
          context: { initiators: ['external'] },
        },
        {
          id: 'allow-agent',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace },
          actions: ['*'],
          resource: { kind: '*', id: '*' },
          context: { initiators: ['foreground', 'external'] },
        },
        {
          id: 'allow-bg',
          effect: 'allow',
          subject: { kind: 'background', id: '*', workspace },
          actions: ['*'],
          resource: { kind: '*', id: '*' },
          context: { initiators: ['background'] },
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
          claimNativeInbox: (input: unknown) => { record: { id: string }; fencingToken?: number }
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

    await ctx.plugin(PersonalMemoryService, {
      databasePath: join(root, 'memory.sqlite'),
      approvalMode: 'delivery-required',
    })
    await ctx.plugin(AssistantGoalsService, {
      databasePath: join(root, 'goals.sqlite'),
    })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'),
      schedulerEnabled: false,
      reconcileIntervalMs: 0,
    })
    await ctx.plugin(AssistantWorkItemsService, {
      enabled: true,
      mode: 'active',
      databasePath: join(root, 'work-items.sqlite'),
      workRoot: join(root, 'work-root'),
      workerAutomationId: 'worker-auto-reg',
      scope: {
        ownerRouteId: authority.id,
        principalId: 'lark/bot/t1/ou_owner',
        workspace,
        preset: 'primary',
        expiresAt: Date.now() + 600_000,
      },
      admission: { allowedKinds: ['repair'] },
    })
    await ctx.plugin(AssistantEvaluationService, {
      databasePath: join(root, 'evaluation.sqlite'),
      projectionIntervalMs: 0,
    })
    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
      holdoutSeed: 'cascade-reg-seed-0123456789abcdef',
    })

    const assoc = ctx.assistantAssociation
    const pm = ctx.personalMemory
    const store = assoc.store!

    // Pick a deterministic non-holdout session ID
    let sNum = 1
    while (assoc.isTaskInHoldout(`headless-session:sess-reg-${sNum}:turn:0`).inHoldout) {
      sNum += 1
    }
    const sessionId = SessionId(`sess-reg-${sNum}`)
    const agent = await ctx.agentLoop.create(
      sessionId,
      { provider: 'mock', model: 'mock' },
      { cwd: workspace, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = agent.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })

    const binding = dStore.createBinding({
      conversation: ownerConv,
      principal: ownerPrincipal,
      workspace,
      agentPreset: 'primary',
      sessionId: String(sessionId),
      policyRef: 'owner-dm',
    })

    const ownerDigest = computePrincipalDigest('lark/bot/t1/ou_owner')
    const ownerScope = {
      mode: 'delivery' as const,
      ownerScopeKey: computeOwnerScopeKey({
        mode: 'delivery',
        principalDigest: ownerDigest,
        principalRecordId: ownerRow.id,
        principalVersion: ownerRow.version,
        workspace,
        agentPreset: 'primary',
      }),
      principalId: 'lark/bot/t1/ou_owner',
      principalDigest: ownerDigest,
      principalRecordId: ownerRow.id,
      principalVersion: ownerRow.version,
      workspace,
      agentPreset: 'primary',
      authorityId: authority.id,
    }

    // 1. Multi-item retainedBlock leak regression: retain [Peer, A, D1, D2], withdraw A -> immediately omit A, D1, D2 BEFORE flush() while keeping Peer!
    const peerRec = pm.decideProposal({
      proposalId: pm.propose(agent, {
        idempotencyKey: 'reg-peer',
        principal: 'lark/bot/t1/ou_owner',
        mutation: {
          op: 'add',
          identity: { owner: 'user', scope: 'workspace', workspace },
          entry: {
            kind: 'fact',
            content: 'reg_alpha_entity surviving peer fact',
            sensitivity: 'private',
            trust: 'user-confirmed',
            confidence: 1,
            provenance: { source: 'test', observedAt: 1_000 },
          },
        },
      }).proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'ok',
    }).record!

    const rootProp = pm.propose(agent, {
      idempotencyKey: 'reg-root-a',
      principal: 'lark/bot/t1/ou_owner',
      mutation: {
        op: 'add',
        identity: { owner: 'user', scope: 'workspace', workspace },
        entry: {
          kind: 'fact',
          content: 'reg_alpha_entity root fact A',
          sensitivity: 'private',
          trust: 'user-confirmed',
          confidence: 1,
          provenance: { source: 'test', observedAt: 1_000 },
        },
      },
    })
    const rootRec = pm.decideProposal({
      proposalId: rootProp.proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: rootProp.version,
      decision: 'approved',
      reason: 'ok',
    }).record!
    await assoc.syncScope(ownerScope)

    const peerNodeId = `a:m-${peerRec.id}`
    const rootNodeId = `a:m-${rootRec.id}`
    store.upsertBatch({
      nodes: [
        {
          id: 'a:abs-d1',
          kind: 'abstraction',
          sourcePlugin: 'assistant-dreaming',
          sourceRef: 'dream:d1',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: ownerDigest,
          principalRecordId: ownerRow.id,
          principalVersion: ownerRow.version,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Derived D1 reg_alpha_entity',
          body: 'Derived D1',
          entities: ['reg_alpha_entity'],
          tokens: tokenizeAssociationText('Derived D1 reg_alpha_entity'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'a:dream-d2',
          kind: 'dream',
          sourcePlugin: 'assistant-dreaming',
          sourceRef: 'dream:d2',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: ownerDigest,
          principalRecordId: ownerRow.id,
          principalVersion: ownerRow.version,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Derived D2 reg_alpha_entity',
          body: 'Derived D2',
          entities: ['reg_alpha_entity'],
          tokens: tokenizeAssociationText('Derived D2 reg_alpha_entity'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      edges: [],
      derivedRefs: [
        { sourceNodeId: rootNodeId, sourceVersion: 1, targetKind: 'node', targetId: 'a:abs-d1' },
        { sourceNodeId: 'a:abs-d1', sourceVersion: 1, targetKind: 'node', targetId: 'a:dream-d2' },
      ],
    })
    await assoc.refreshIndex()

    agent.session.append('user/message', {
      role: 'user',
      id: 'u-reg-multi' as never,
      content: [{ type: 'text', text: 'Inspect reg_alpha_entity' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    const snapBefore = assoc.contextSnapshot(agent)
    expect(snapBefore).toContain(peerNodeId)
    expect(snapBefore).toContain(rootNodeId)
    expect(snapBefore).toContain('a:abs-d1')
    expect(snapBefore).toContain('a:dream-d2')

    const rmRoot = pm.propose(agent, {
      idempotencyKey: 'reg-rm-root-a',
      principal: 'lark/bot/t1/ou_owner',
      mutation: {
        op: 'remove',
        identity: { owner: 'user', scope: 'workspace', workspace },
        id: rootRec.id,
        expectedVersion: rootRec.version,
      },
    })
    pm.decideProposal({
      proposalId: rmRoot.proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: rmRoot.version,
      decision: 'approved',
      reason: 'withdraw A',
    })

    // Immediately BEFORE assoc.flush(): retainedBlock MUST omit A, D1, D2 while keeping Peer!
    const snapImmediate = assoc.contextSnapshot(agent)
    expect(snapImmediate).toContain(peerNodeId)
    expect(snapImmediate).not.toContain(rootNodeId)
    expect(snapImmediate).not.toContain('a:abs-d1')
    expect(snapImmediate).not.toContain('a:dream-d2')

    await assoc.flush()
    const snapPostFlush = assoc.contextSnapshot(agent)
    expect(snapPostFlush).toContain(peerNodeId)
    expect(snapPostFlush).not.toContain(rootNodeId)
    expect(snapPostFlush).not.toContain('a:abs-d1')
    expect(snapPostFlush).not.toContain('a:dream-d2')

    // 2. Hash-inverted sourceVersion supersession cascades derived nodes/edges for Goal (v1:def1 -> v2:def1), Work-Item, and Automation!
    expect(normalizeSourceVersion('v1:def1')).toBeGreaterThan(normalizeSourceVersion('v2:def1'))

    const turnInbox = dStore.claimNativeInbox({
      envelope: {
        channel: 'lark',
        account: 'bot',
        eventId: 'evt-reg-goal',
        occurredAt: 10_000,
        principal: ownerPrincipal,
        conversation: ownerConv,
        kind: 'text',
        text: 'Create goal for supersession cascade',
      },
      binding,
      ownerLineage: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      ownerId: 'worker-1',
      leaseMs: 100_000,
    })
    agent.session.append('turn/start', { turn: 1 })
    agent.inbox.append(
      'next-turn',
      createUserMessage({
        content: [{ type: 'text', text: 'Create goal for supersession cascade' }],
        source: { kind: 'delivery', channel: 'lark', account: 'bot', eventId: 'evt-reg-goal' } as never,
      }),
    )
    ;(agent.inbox as unknown as { claim: (t: 'next-turn', turn: number) => void }).claim('next-turn', 1)
    const goal = ctx.assistantGoals.create(agent, 'Goal supersession cascade check', 2)
    await assoc.flush()
    const goalNodeId = `a:g-${goal.id}`
    const goalV1Ver = normalizeSourceVersion(`v${goal.version}:def${goal.definition.version}`)
    const goalDerivedEdgeId = computeDeterministicEdgeId(goalNodeId, 'a:abs-goal-v1', 'abstraction')
    store.upsertBatch({
      nodes: [
        {
          id: 'a:abs-goal-v1',
          kind: 'abstraction',
          sourcePlugin: 'assistant-dreaming',
          sourceRef: 'dream:goal-v1',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: ownerDigest,
          principalRecordId: ownerRow.id,
          principalVersion: ownerRow.version,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Goal v1 derived node',
          body: 'Derived from goal v1',
          entities: ['goal_v1'],
          tokens: tokenizeAssociationText('Goal v1 derived node'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      edges: [
        {
          edgeId: goalDerivedEdgeId,
          aId: goalNodeId,
          bId: 'a:abs-goal-v1',
          edgeType: 'abstraction',
          weight: 0.7,
          trust: 'trusted',
          reason: 'abstraction:goal-v1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      derivedRefs: [
        { sourceNodeId: goalNodeId, sourceVersion: goalV1Ver, targetKind: 'node', targetId: 'a:abs-goal-v1' },
        { sourceNodeId: goalNodeId, sourceVersion: goalV1Ver, targetKind: 'edge', targetId: goalDerivedEdgeId },
      ],
    })
    ctx.assistantGoals.control(agent, {
      goalId: goal.id,
      expectedRevision: goal.native.revision,
      operation: 'pause',
    })
    await assoc.flush()
    expect(store.getNodeById('a:abs-goal-v1')).toBeNull()
    expect(store.loadActiveEdgesPage(100, 0).some((e) => e.edgeId === goalDerivedEdgeId)).toBe(false)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Work-item supersession cascade (even when next version hashes smaller than prior version)
    const wi = ctx.assistantWorkItems.admit({
      kind: 'repair',
      externalId: 'wi-supersede-1',
      title: 'Work item supersession',
      brief: 'Initial brief',
      originBindingId: binding.id,
      provenance: {
        source: 'intake-test',
        sourceVersion: '1',
        signalDigest: 'c'.repeat(64),
        observedAt: Date.now(),
        evidence: {
          inboxId: turnInbox.record.id,
          completionSequence: 1,
          authorityHash: delivery.listActiveOwnerRouteScopes()[0]!.authorityHash,
        },
      },
    })
    await assoc.syncAll()
    const wiNode = store.getNodeById(`a:w-${wi.item.id}`)!
    expect(wiNode).not.toBeNull()
    const wiDerivedEdge = computeDeterministicEdgeId(wiNode.id, 'a:abs-wi-v1', 'abstraction')
    store.upsertBatch({
      nodes: [
        {
          id: 'a:abs-wi-v1',
          kind: 'abstraction',
          sourcePlugin: 'assistant-dreaming',
          sourceRef: 'dream:wi-v1',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: ownerDigest,
          principalRecordId: ownerRow.id,
          principalVersion: ownerRow.version,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Work-item v1 derived',
          body: 'Derived from work-item v1',
          entities: ['wi_v1'],
          tokens: tokenizeAssociationText('Work-item v1 derived'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      edges: [
        {
          edgeId: wiDerivedEdge,
          aId: wiNode.id,
          bId: 'a:abs-wi-v1',
          edgeType: 'abstraction',
          weight: 0.7,
          trust: 'trusted',
          reason: 'abstraction:wi-v1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      derivedRefs: [
        { sourceNodeId: wiNode.id, sourceVersion: wiNode.sourceVersion, targetKind: 'node', targetId: 'a:abs-wi-v1' },
        { sourceNodeId: wiNode.id, sourceVersion: wiNode.sourceVersion, targetKind: 'edge', targetId: wiDerivedEdge },
      ],
    })
    // Supersede work-item node with strictly smaller sourceVersion (0 < wiNode.sourceVersion)
    store.upsertBatch({
      nodes: [
        {
          ...wiNode,
          sourceVersion: 0,
          title: '[ready] Work item supersession v2',
          updatedAt: Date.now() + 10,
        },
      ],
      edges: [],
      derivedRefs: [],
    })
    expect(store.getNodeById('a:abs-wi-v1')).toBeNull()
    expect(store.loadActiveEdgesPage(100, 0).some((e) => e.edgeId === wiDerivedEdge)).toBe(false)

    // Automation supersession cascade
    const autoStore = (ctx.assistantAutomations as unknown as {
      store: {
        createApproved: (input: { automationId: string; idempotencyKey: string; definition: unknown }) => { id: string; version: number }
        changeApproved: (input: { automationId: string; operation: 'pause' | 'resume' | 'delete'; expectedVersion: number; idempotencyKey: string }) => { version: number }
      }
    }).store
    const autoCreated = autoStore.createApproved({
      automationId: 'auto-supersede-1',
      idempotencyKey: 'auto-sup-1',
      definition: {
        name: 'Supersession automation',
        prompt: 'Run once',
        schedule: { kind: 'at', at: '2035-01-01T00:00:00.000Z' },
        workspace,
        agentPreset: 'primary',
        provider: 'mock',
        model: 'mock',
        allowedTools: [],
        timeoutMs: 60_000,
        maxOutputTokens: 256,
        maxToolCalls: 0,
        misfire: { kind: 'latest' },
        overlap: 'skip',
        retrySafety: 'never',
        maxRetries: 0,
        principal: 'lark/bot/t1/ou_owner',
      },
    })
    await assoc.syncAll()
    const autoNode = store.getNodeById('a:au-auto-supersede-1')!
    expect(autoNode).not.toBeNull()
    store.upsertBatch({
      nodes: [
        {
          id: 'a:abs-auto-v1',
          kind: 'abstraction',
          sourcePlugin: 'assistant-dreaming',
          sourceRef: 'dream:auto-v1',
          sourceVersion: 1,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest: ownerDigest,
          principalRecordId: ownerRow.id,
          principalVersion: ownerRow.version,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Automation v1 derived',
          body: 'Derived from automation v1',
          entities: ['auto_v1'],
          tokens: tokenizeAssociationText('Automation v1 derived'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      edges: [],
      derivedRefs: [
        { sourceNodeId: autoNode.id, sourceVersion: autoNode.sourceVersion, targetKind: 'node', targetId: 'a:abs-auto-v1' },
      ],
    })
    autoStore.changeApproved({
      automationId: 'auto-supersede-1',
      operation: 'pause',
      expectedVersion: autoCreated.version,
      idempotencyKey: 'auto-sup-2',
    })
    await assoc.flush()
    expect(store.getNodeById('a:abs-auto-v1')).toBeNull()

    // 3. Same-pass Delivery + Evaluation retract (disposition === 'retract' without 'withdraw') AND withdraw
    const evalSvc = ctx.assistantEvaluation
    evalSvc.createHostScope({ workspace, preset: 'primary' })
    const evalStore = (evalSvc as unknown as {
      store: {
        append: (input: unknown, command?: unknown) => { id: string }
      }
    }).store

    // Finish turnInbox (not yet ingested by Delivery sync) AND append Evaluation conflict retract in the SAME pass!
    dStore.bindForegroundTaskExecution({
      inboxId: turnInbox.record.id,
      scope: { workspace, preset: 'primary' },
      owner: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      binding,
      dispatchedAt: 10_000,
    })
    dStore.recordForegroundExecutionModelSelection({ inboxId: turnInbox.record.id, provider: 'mock', model: 'mock' })
    dStore.finishForegroundTaskExecution({ inboxId: turnInbox.record.id, status: 'succeeded', quiescent: true, completedAt: 11_000 })
    dStore.finishInbox({ inboxId: turnInbox.record.id, ownerId: 'worker-1', fencingToken: turnInbox.fencingToken!, outcome: 'processed' })
    dStore.enqueue({
      idempotencyKey: `inbound:${turnInbox.record.id}:reply`,
      bindingId: binding.id,
      target: { principal: ownerPrincipal, conversation: ownerConv },
      text: 'Foreground reply for same-pass retract',
      format: 'plain',
      replyToEventId: 'evt-reg-goal',
    })

    // Append conflicting Evaluation outcome on turnInbox BEFORE assoc.syncScope(ownerScope) runs!
    evalStore.append(
      {
        scope: { workspace, preset: 'primary' },
        situation: 'same-pass retract init',
        executionStatus: 'succeeded',
        objectiveStatus: 'achieved',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [
          { kind: 'foreground-turn', ref: turnInbox.record.id },
          { kind: 'delivery-outbox', ref: 'outbox-same-pass-1' },
        ],
        metrics: {},
        occurredAt: 11_100,
        idempotencyKey: 'eval-samepass-retract-1',
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      },
      {
        operationId: 'op-sp-init',
        principalRecordId: ownerRow.id,
        principalVersion: ownerRow.version,
        action: 'initial',
      },
    )
    evalStore.append(
      {
        scope: { workspace, preset: 'primary' },
        situation: 'same-pass retract conflict',
        executionStatus: 'succeeded',
        objectiveStatus: 'unknown',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [
          { kind: 'foreground-turn', ref: turnInbox.record.id },
          { kind: 'delivery-outbox', ref: 'outbox-same-pass-1' },
        ],
        metrics: {},
        occurredAt: 11_200,
        idempotencyKey: 'eval-samepass-retract-2',
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      },
      {
        operationId: 'op-sp-correct',
        principalRecordId: ownerRow.id,
        principalVersion: ownerRow.version,
        action: 'correct',
        expectedVersion: 1,
        previousStatus: 'achieved',
      },
    )

    await assoc.syncScope(ownerScope)
    const retractedNode = store.getNodeById(`a:e-fg-${turnInbox.record.id}`)
    expect(retractedNode).not.toBeNull()
    expect(retractedNode?.status).toBe('suppressed')
    expect(retractedNode?.trust).toBe('low')
    expect(retractedNode?.metadata.conflicted).toBe(true)

    // Same-pass Delivery + Evaluation action === 'withdraw' -> never inserts active node or resurrects!
    const turnInboxWd = dStore.claimNativeInbox({
      envelope: {
        channel: 'lark',
        account: 'bot',
        eventId: 'evt-reg-wd-samepass',
        occurredAt: 12_000,
        principal: ownerPrincipal,
        conversation: ownerConv,
        kind: 'text',
        text: 'Foreground turn for same-pass withdraw',
      },
      binding,
      ownerLineage: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      ownerId: 'worker-1',
      leaseMs: 100_000,
    })
    dStore.bindForegroundTaskExecution({
      inboxId: turnInboxWd.record.id,
      scope: { workspace, preset: 'primary' },
      owner: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version },
      binding,
      dispatchedAt: 12_000,
    })
    dStore.recordForegroundExecutionModelSelection({ inboxId: turnInboxWd.record.id, provider: 'mock', model: 'mock' })
    dStore.finishForegroundTaskExecution({ inboxId: turnInboxWd.record.id, status: 'succeeded', quiescent: true, completedAt: 13_000 })
    dStore.finishInbox({ inboxId: turnInboxWd.record.id, ownerId: 'worker-1', fencingToken: turnInboxWd.fencingToken!, outcome: 'processed' })
    dStore.enqueue({
      idempotencyKey: `inbound:${turnInboxWd.record.id}:reply`,
      bindingId: binding.id,
      target: { principal: ownerPrincipal, conversation: ownerConv },
      text: 'Foreground reply for same-pass withdraw',
      format: 'plain',
      replyToEventId: 'evt-reg-wd-samepass',
    })
    evalStore.append(
      {
        scope: { workspace, preset: 'primary' },
        situation: 'same-pass withdraw init',
        executionStatus: 'succeeded',
        objectiveStatus: 'achieved',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [
          { kind: 'foreground-turn', ref: turnInboxWd.record.id },
          { kind: 'delivery-outbox', ref: 'outbox-same-pass-2' },
        ],
        metrics: {},
        occurredAt: 13_100,
        idempotencyKey: 'eval-samepass-wd-1',
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      },
      {
        operationId: 'op-sp-wd-init',
        principalRecordId: ownerRow.id,
        principalVersion: ownerRow.version,
        action: 'initial',
      },
    )
    evalStore.append(
      {
        scope: { workspace, preset: 'primary' },
        situation: 'same-pass withdraw',
        executionStatus: 'succeeded',
        objectiveStatus: 'unknown',
        deliveryStatus: 'delivered',
        source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        trust: 'trusted',
        evidence: [
          { kind: 'foreground-turn', ref: turnInboxWd.record.id },
          { kind: 'delivery-outbox', ref: 'outbox-same-pass-2' },
        ],
        metrics: {},
        occurredAt: 13_200,
        idempotencyKey: 'eval-samepass-wd-2',
        evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
      },
      {
        operationId: 'op-sp-wd-2',
        principalRecordId: ownerRow.id,
        principalVersion: ownerRow.version,
        action: 'withdraw',
        expectedVersion: 1,
        previousStatus: 'achieved',
      },
    )

    await assoc.syncScope(ownerScope)
    expect(store.getNodeById(`a:e-fg-${turnInboxWd.record.id}`)).toBeNull()
    expect(
      store.isSourceWithdrawn(
        ownerScope.ownerScopeKey,
        'assistant-delivery',
        `foreground-turn:${turnInboxWd.record.id}`,
      ),
    ).toBe(true)
    await assoc.syncScope(ownerScope)
    expect(store.getNodeById(`a:e-fg-${turnInboxWd.record.id}`)).toBeNull()
  })
})
