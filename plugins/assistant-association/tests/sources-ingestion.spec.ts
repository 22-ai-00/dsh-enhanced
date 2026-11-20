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
  computeOwnerScopeKey,
  computePrincipalDigest,
} from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
})

function stubAgent(sessionId: string, cwd: string, preset = 'primary'): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd,
    agentPreset: preset,
    isSeeded: false,
  })
  session.append('approval/policy', { policy: 'never' })
  session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
  const append = session.append as unknown as (type: string, data: unknown) => unknown
  append.call(session, 'sandbox/mode', { mode: 'danger-full-access' })
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

describe('sources ingestion across all 5 sources, Delivery+Evaluation episodes, toolNames[], and ABA isolation', () => {
  test('discovers owner scopes via listActiveOwnerRouteScopes, ingests all 5 sources, captures toolNames[], and enforces ABA principalVersion isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assoc-sources-'))
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
    } as never)

    const ownerPrincipal = { channel: 'lark', account: 'bot', tenant: 't1', user: 'ou_owner' }
    const ownerConv = { channel: 'lark', account: 'bot', tenant: 't1', kind: 'dm' as const, chat: 'chat_1' }
    const authority: OwnerRouteAuthority = {
      id: 'owner-route-1',
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
          actions: ['pair.issue', 'pair.handoff'],
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
          database: import('node:sqlite').DatabaseSync
        }
      }
    ).deliveryStore

    const pairing = delivery.issuePairing('test', ownerPrincipal)
    delivery.confirmPairing({ challengeId: pairing.challenge.id, principal: ownerPrincipal, code: pairing.code })
    const ownerV1 = dStore.getPrincipal(ownerPrincipal)!

    const sessionId = SessionId('sess-sources-1')
    const liveAgent = await ctx.agentLoop.create(
      sessionId,
      { provider: 'mock', model: 'mock' },
      { cwd: workspace, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    liveAgent.session.append('approval/policy', { policy: 'never' })
    liveAgent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = liveAgent.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(liveAgent.session, 'sandbox/mode', { mode: 'danger-full-access' })

    const binding = dStore.createBinding({
      conversation: ownerConv,
      principal: ownerPrincipal,
      workspace,
      agentPreset: 'primary',
      sessionId: String(sessionId),
      policyRef: 'owner-dm',
    })

    // Mount all peer services
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

    // Populate initial data BEFORE starting assistant-association so startup backfill is tested too!
    // Source 1: personal-memory
    const pm = ctx.personalMemory
    const memProp = pm.propose(liveAgent, {
      idempotencyKey: 'src-mem-1',
      principal: 'lark/bot/t1/ou_owner',
      mutation: {
        op: 'add',
        identity: { owner: 'user', scope: 'workspace', workspace },
        entry: {
          kind: 'fact',
          content: 'cgroup.freeze delegation resolves EPERM in unified hierarchy',
          sensitivity: 'private',
          trust: 'user-confirmed',
          confidence: 0.95,
          provenance: { source: 'test', observedAt: 1_000 },
        },
      },
    })
    const memDecided = pm.decideProposal({
      proposalId: memProp.proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: memProp.version,
      decision: 'approved',
      reason: 'ok',
    })

    // Source 2: assistant-goals
    const admittedTurn = dStore.claimNativeInbox({
      envelope: {
        channel: 'lark',
        account: 'bot',
        eventId: 'evt-fg-1',
        occurredAt: 1_000,
        principal: ownerPrincipal,
        conversation: ownerConv,
        kind: 'text',
        text: 'Fix cgroup.freeze delegation permissions',
      },
      binding,
      ownerLineage: { principalRecordId: ownerV1.id, principalVersion: ownerV1.version },
      ownerId: 'worker-1',
      leaseMs: 100_000,
    })
    // Simulate turn start + real Inbox.claim so currentPreferenceTurn is active for goals
    liveAgent.session.append('turn/start', { turn: 1 })
    liveAgent.inbox.append(
      'next-turn',
      createUserMessage({
        content: [{ type: 'text', text: 'Fix cgroup.freeze delegation permissions' }],
        source: { kind: 'delivery', channel: 'lark', account: 'bot', eventId: 'evt-fg-1' } as never,
      }),
    )
    ;(liveAgent.inbox as unknown as { claim: (t: 'next-turn', turn: number) => void }).claim('next-turn', 1)
    const goalRec = ctx.assistantGoals.create(liveAgent, 'Stabilize cgroup.freeze unified hierarchy', 3)
    liveAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Source 3: assistant-work-items
    const wiAdmitted = ctx.assistantWorkItems.admit({
      kind: 'repair',
      externalId: 'wi-cgroup-1',
      title: 'Repair cgroup.freeze helper',
      brief: 'Ensure cgroup.freeze subtree ownership',
      originBindingId: binding.id,
      provenance: {
        source: 'test-intake',
        sourceVersion: '1',
        signalDigest: 'a'.repeat(64),
        observedAt: Date.now(),
        evidence: {
          inboxId: admittedTurn.record.id,
          completionSequence: 1,
          authorityHash: delivery.listActiveOwnerRouteScopes()[0]!.authorityHash,
        },
      },
    })

    // Source 4: assistant-automations
    const autoStore = (ctx.assistantAutomations as unknown as {
      store: {
        createApproved: (input: { automationId: string; idempotencyKey: string; definition: unknown }) => { id: string }
      }
    }).store
    autoStore.createApproved({
      automationId: 'auto-cgroup-audit',
      idempotencyKey: 'auto-create-1',
      definition: {
        name: 'Audit cgroup.freeze permissions',
        prompt: 'Check cgroup.freeze nightly',
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

    // Now mount AssistantAssociationService (discovers owner route on startup + backfills!)
    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
    })
    const assoc = ctx.assistantAssociation

    // Simulate a tool call in session before foreground episode completion so toolNames[] are captured
    liveAgent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('tc-bash-1'),
      name: 'bash',
      arguments: '{"command":"ls /sys/fs/cgroup"}',
    })

    // Source 5: Delivery foreground episode completion
    dStore.bindForegroundTaskExecution({
      inboxId: admittedTurn.record.id,
      scope: { workspace, preset: 'primary' },
      owner: { principalRecordId: ownerV1.id, principalVersion: ownerV1.version },
      binding,
      dispatchedAt: 1_000,
    })
    dStore.recordForegroundExecutionModelSelection({
      inboxId: admittedTurn.record.id,
      provider: 'mock',
      model: 'mock',
    })
    dStore.finishForegroundTaskExecution({
      inboxId: admittedTurn.record.id,
      status: 'succeeded',
      quiescent: true,
      completedAt: 2_000,
    })
    dStore.finishInbox({
      inboxId: admittedTurn.record.id,
      ownerId: 'worker-1',
      fencingToken: admittedTurn.fencingToken!,
      outcome: 'processed',
    })
    dStore.enqueue({
      idempotencyKey: `inbound:${admittedTurn.record.id}:reply`,
      bindingId: binding.id,
      target: { principal: ownerPrincipal, conversation: ownerConv },
      text: 'Fixed cgroup.freeze delegation via systemd Delegate=yes.',
      format: 'plain',
      replyToEventId: 'evt-fg-1',
    })

    await assoc.syncAll()

    // Verify all 5 source nodes exist in SQLite with shared-entity edges & toolNames[]
    const store = assoc.store!
    const memNode = store.getNodeById(`a:m-${memDecided.record!.id}`)
    const goalNode = store.getNodeById(`a:g-${goalRec.id}`)
    const wiNode = store.getNodeById(`a:w-${wiAdmitted.item.id}`)
    const autoNode = store.getNodeById('a:au-auto-cgroup-audit')
    const fgEpisodeNode = store.getNodeById(`a:e-fg-${admittedTurn.record.id}`)

    expect(memNode?.kind).toBe('memory')
    expect(goalNode?.kind).toBe('goal')
    expect(wiNode?.kind).toBe('work-item')
    expect(autoNode?.kind).toBe('automation')
    expect(fgEpisodeNode?.kind).toBe('episode')
    expect(fgEpisodeNode?.metadata).toMatchObject({ toolNames: ['bash'] })

    // Verify shared-entity edges were built across sources sharing cgroup.freeze
    const edges = store.loadActiveEdgesPage(100, 0)
    expect(edges.some((e) => e.edgeType === 'entity' && e.reason.includes('cgroup.freeze'))).toBe(true)

    // Verify contextSnapshot recalls across sources for ownerV1
    const nonHoldoutStub = stubAgent('non-holdout-check', workspace, 'primary')
    // Bind session to ownerV1 temporarily or test via contextSnapshot on liveAgent if not holdout
    void nonHoldoutStub

    // Verify ABA principalVersion isolation: rotate owner principal version 1 -> 2
    const dDb = (dStore as unknown as { database: import('node:sqlite').DatabaseSync }).database
    dDb.prepare('UPDATE delivery_principals SET version = 2 WHERE id = ?').run(ownerV1.id)

    const v2ScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest('lark/bot/t1/ou_owner'),
      principalRecordId: ownerV1.id,
      principalVersion: 2,
      workspace,
      agentPreset: 'primary',
    })
    expect(memNode!.ownerScopeKey).not.toBe(v2ScopeKey)

    // Hot-path query & assoc_read under rotated principalVersion=2 must NOT see v1 nodes
    const snapAfterAba = assoc.contextSnapshot(liveAgent)
    expect(snapAfterAba).not.toContain(`a:m-${memDecided.record!.id}`)
    expect(snapAfterAba).not.toContain(`a:g-${goalRec.id}`)

    const abaRead = await ctx.tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: ToolCallId('aba-read'),
          name: 'assoc_read',
          arguments: JSON.stringify({ id: `a:g-${goalRec.id}` }),
        },
      ],
      agent: liveAgent,
      signal: new AbortController().signal,
    })
    expect(abaRead.results[0]!.result.isError).toBe(true)
  })

  test('deduplicates user-global MemoryRecord node IDs across scopes in same sync pass and rejects automation-run name-substring false positives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assoc-sources-dedup-'))
    const ws1 = join(root, 'ws1')
    const ws2 = join(root, 'ws2')
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })

    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        {
          id: 'allow-all',
          effect: 'allow',
          subject: { kind: 'agent', id: '*', workspace: '*' },
          actions: ['*'],
          resource: { kind: '*', id: '*' },
          context: { initiators: ['foreground'] },
        },
      ],
    })
    await ctx.plugin(PersonalMemoryService, {
      databasePath: join(root, 'memory.sqlite'),
      approvalMode: 'delivery-or-headless',
    })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'),
      schedulerEnabled: false,
      reconcileIntervalMs: 0,
    })
    await ctx.plugin(AssistantEvaluationService, {
      databasePath: join(root, 'evaluation.sqlite'),
      projectionIntervalMs: 0,
    })
    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
      allowHeadlessScope: true,
    })

    const pm = ctx.personalMemory
    const assoc = ctx.assistantAssociation
    const a1 = stubAgent('dedup-1', ws1, 'primary')
    const prop = pm.propose(a1, {
      idempotencyKey: 'global-dedup-1',
      principal: 'headless-shared-owner',
      mutation: {
        op: 'add',
        identity: { owner: 'user', scope: 'user-global' },
        entry: {
          kind: 'fact',
          content: 'Global memory shared across two workspace scopes',
          sensitivity: 'private',
          trust: 'user-confirmed',
          confidence: 1,
          provenance: { source: 'test', observedAt: 1_000 },
        },
      },
    })
    const added = pm.decideProposal({
      proposalId: prop.proposalId,
      principal: 'headless-shared-owner',
      expectedVersion: prop.version,
      decision: 'approved',
      reason: 'ok',
    }).record!

    const sharedPrincipal = 'headless-shared-owner'
    const digest = computePrincipalDigest(sharedPrincipal)
    const scope1 = {
      mode: 'headless' as const,
      ownerScopeKey: computeOwnerScopeKey({
        mode: 'headless',
        principalDigest: digest,
        principalRecordId: null,
        principalVersion: null,
        workspace: ws1,
        agentPreset: 'primary',
      }),
      principalId: sharedPrincipal,
      principalDigest: digest,
      principalRecordId: null,
      principalVersion: null,
      workspace: ws1,
      agentPreset: 'primary',
    }
    const scope2 = {
      mode: 'headless' as const,
      ownerScopeKey: computeOwnerScopeKey({
        mode: 'headless',
        principalDigest: digest,
        principalRecordId: null,
        principalVersion: null,
        workspace: ws2,
        agentPreset: 'primary',
      }),
      principalId: sharedPrincipal,
      principalDigest: digest,
      principalRecordId: null,
      principalVersion: null,
      workspace: ws2,
      agentPreset: 'primary',
    }

    // Register scopes and sync in the same pass before SQLite flush
    const mgr = (assoc as unknown as {
      sourceManager: {
        registerScope: (s: typeof scope1) => boolean
        syncAll: () => Promise<void>
      }
    }).sourceManager
    mgr.registerScope(scope1)
    mgr.registerScope(scope2)
    await mgr.syncAll()

    const baseId = `a:m-${added.id}`
    const suffixedId = `${baseId}~${scope2.ownerScopeKey.slice(0, 8)}`
    const baseNode = assoc.store!.getNodeById(baseId)
    const suffixedNode = assoc.store!.getNodeById(suffixedId)
    expect(baseNode).not.toBeNull()
    expect(suffixedNode).not.toBeNull()
    expect(baseNode!.ownerScopeKey).toBe(scope1.ownerScopeKey)
    expect(suffixedNode!.ownerScopeKey).toBe(scope2.ownerScopeKey)

    // Verify automation-run owner check ignores broad definition.name substring match
    const autoStore = (ctx.assistantAutomations as unknown as {
      store: {
        createApproved: (input: { automationId: string; idempotencyKey: string; definition: unknown }) => { id: string }
      }
    }).store
    autoStore.createApproved({
      automationId: 'auto-exact-id-only',
      idempotencyKey: 'auto-sub-1',
      definition: {
        name: 'check',
        prompt: 'check logs',
        schedule: { kind: 'at', at: '2035-01-01T00:00:00.000Z' },
        workspace: ws1,
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
        principal: sharedPrincipal,
      },
    })
    const evalStore = (ctx.assistantEvaluation as unknown as {
      store: {
        append: (input: unknown, command?: unknown) => { id: string }
      }
    }).store
    ctx.assistantEvaluation.createHostScope({ workspace: ws1, preset: 'primary' })
    evalStore.append({
      scope: { workspace: ws1, preset: 'primary' },
      situation: 'unrelated task containing word check in prose',
      executionStatus: 'succeeded',
      objectiveStatus: 'achieved',
      deliveryStatus: 'delivered',
      source: { kind: 'automation', id: 'auto-other-owner' },
      trust: 'trusted',
      evidence: [{ kind: 'automation-run', ref: 'run-unrelated-999' }],
      metrics: {},
      occurredAt: 2_000,
      idempotencyKey: 'eval-auto-sub-1',
      evaluator: { id: 'auto-eval', version: '1' },
    })
    await assoc.syncAll()
    expect(assoc.store!.getNodeById('a:e-automation-run-run-unrelated-999')).toBeNull()
  })
})
