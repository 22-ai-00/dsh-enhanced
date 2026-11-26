import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmRuntime, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { AssistantDeliveryService, type OwnerRouteAuthority } from '@dsh-ray/assistant-delivery'
import {
  AssistantEvaluationService,
  evaluationLearningProjectionDigest,
  type TrustedTaskLearningProjectionReceipt,
} from '@dsh-ray/assistant-evaluation'
import { AssistantGoalsService } from '@dsh-ray/assistant-goals'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { AssistantSkillsService } from '@dsh-ray/assistant-skills'
import {
  AssistantWorkItemsService,
  type Config as WorkItemsConfig,
  type WorkItemIntakeEvaluatorRegistration,
} from '@dsh-ray/assistant-work-items'
import { EventTriggersService } from '@dsh-ray/event-triggers'
import { PersonalWikiService } from '@dsh-ray/personal-wiki'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantAssociationError,
  AssistantAssociationService,
  Config,
  computeDeterministicEdgeId,
  computeDeterministicSynonymId,
  computeOwnerScopeKey,
  computePrincipalDigest,
  normalizeConfig,
  type AssociationOwnerScope,
} from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
})

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeFakeExecution(agent: Agent, callId = 'call-1') {
  return {
    callId: ToolCallId(callId),
    rootCallId: ToolCallId(`root-${callId}`),
    token: 'tok-1' as never,
    agent,
    name: 'assoc_read',
    arguments: {},
    signal: new AbortController().signal,
    attempt: 1,
    deferContext() {},
    concludeTurn() {},
  } as unknown as Parameters<AssistantAssociationService['readById']>[0]
}

function makeHeadlessAgent(sessionId: string, cwd: string, preset = 'primary'): Agent {
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
    status: 'idle',
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

function makeHeadlessScope(principalId: string, workspace: string, preset = 'primary'): AssociationOwnerScope {
  const principalDigest = computePrincipalDigest(principalId)
  return {
    mode: 'headless',
    ownerScopeKey: computeOwnerScopeKey({
      mode: 'headless',
      principalDigest,
      principalRecordId: null,
      principalVersion: null,
      workspace,
      agentPreset: preset,
    }),
    principalId,
    principalDigest,
    principalRecordId: null,
    principalVersion: null,
    workspace,
    agentPreset: preset,
  }
}

function findForegroundInboxByHoldout(
  service: AssistantAssociationService,
  wantHoldout: boolean,
  prefix: string,
): string {
  for (let i = 0; i < 500; i += 1) {
    const inboxId = `${prefix}-${i}`
    if (service.isTaskInHoldout(`foreground-turn:${inboxId}`).inHoldout === wantHoldout) {
      return inboxId
    }
  }
  throw new Error(`Unable to find foreground inbox holdout=${String(wantHoldout)} for ${prefix}`)
}

function findHeadlessSessionByHoldout(
  service: AssistantAssociationService,
  wantHoldout: boolean,
  prefix: string,
): string {
  for (let i = 0; i < 500; i += 1) {
    const sid = `${prefix}-${i}`
    if (service.isTaskInHoldout(`headless-session:${sid}:turn:0`).inHoldout === wantHoldout) {
      return sid
    }
  }
  throw new Error(`Unable to find headless session holdout=${String(wantHoldout)} for ${prefix}`)
}

function pushUserTurn(ctx: Context, agent: Agent, text: string, turn = 0): void {
  const msg = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', id: 'user' },
  })
  ctx.emit('agent/inbox/claimed', { agent, message: msg, turn } as never)
}

describe('Slice S3 End-to-End Integration', () => {
  test('T-S3-01 & T-S3-02: dreaming low-trust auth, AC synonym owner/trust isolation, and 4-way dual-endpoint invalidation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'assoc-s3-dream-')))
    const workspace = join(root, 'ws')
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })

    let allowDreaming = false
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        {
          id: 'allow-webhook',
          effect: 'allow',
          subject: { kind: 'external', id: 'webhook:*' },
          actions: ['accept'],
          resource: { kind: 'automation', id: '*' },
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
    // Intercept evaluate/authorize so we can toggle 'evolution' dreaming permission dynamically
    const policy = ctx.assistantPolicy
    const origEvaluate = policy.evaluate.bind(policy)
    const origAuthorize = policy.authorize.bind(policy)
    vi.spyOn(policy, 'evaluate').mockImplementation((req) => {
      if (req.resource.kind === 'evolution' && req.resource.id === 'assistant-association:dreaming') {
        return {
          effect: allowDreaming ? 'allow' : 'deny',
          reasonCode: allowDreaming ? 'rule-allow' : 'rule-deny',
          ruleId: undefined,
        }
      }
      return origEvaluate(req)
    })
    vi.spyOn(policy, 'authorize').mockImplementation((req, opts) => {
      if (req.resource.kind === 'evolution' && req.resource.id === 'assistant-association:dreaming') {
        return {
          effect: allowDreaming ? 'allow' : 'deny',
          reasonCode: allowDreaming ? 'rule-allow' : 'rule-deny',
          ruleId: undefined,
        }
      }
      return origAuthorize(req, opts)
    })

    // First verify dreaming defaults enabled and supports explicit opt-out
    const ctxDisabled = new Context()
    cleanups.push(async () => {
      await ctxDisabled.fiber.dispose()
    })
    await ctxDisabled.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy-disabled.sqlite'),
    })
    await ctxDisabled.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc-disabled.sqlite'),
      allowHeadlessScope: true,
      dreaming: { enabled: false },
    })
    const scopeA = makeHeadlessScope('owner-a', workspace)
    const disabledDream = await ctxDisabled.assistantAssociation.runDreamingNow(scopeA)
    expect(disabledDream.ran).toBe(false)
    expect(disabledDream.reason).toBe('disabled')

    // Now test dreaming enabled on main ctx
    const baseNow = 1_700_000_000_000
    let clockMs = baseNow
    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
      allowHeadlessScope: true,
      allowLowTrust: true,
      minItems: 1,
      maxItems: 8,
      hotPathBudgetMs: 50,
      syncIntervalMs: 60_000,
      dreaming: {
        enabled: true,
        intervalMs: 1_000,
        idleMinMs: 10_000,
        maxPairsPerRun: 8,
        maxAbstractionsPerRun: 4,
        maxSynonymsPerRun: 16,
        nodeTtlMs: 50_000,
      },
    })
    const assoc = ctx.assistantAssociation
    assoc.setNowClock(() => clockMs)
    assoc.setHotPathClock(() => 0)
    const store = assoc.store!

    const scopeB = makeHeadlessScope('owner-b', workspace)
    const sidA = findHeadlessSessionByHoldout(assoc, false, 'sess-dream-a')
    const sidB = findHeadlessSessionByHoldout(assoc, false, 'sess-dream-b')
    const agentA = makeHeadlessAgent(sidA, workspace)
    const agentB = makeHeadlessAgent(sidB, workspace)
    assoc.bindHeadlessPrincipal(agentA, 'owner-a')
    assoc.bindHeadlessPrincipal(agentB, 'owner-b')

    // Seed two unlinked memory nodes for Owner A sharing concepts + parenthetical alias for AC synonym
    const makeMem = (
      id: string,
      ref: string,
      scope: AssociationOwnerScope,
      title: string,
      body: string,
      entities: string[],
      expiresAt: number | null = null,
      version = 1,
    ) => ({
      id,
      kind: 'memory' as const,
      sourcePlugin: 'personal-memory',
      sourceRef: ref,
      sourceVersion: version,
      ownerScopeKey: scope.ownerScopeKey,
      ownerMode: 'headless' as const,
      principalDigest: scope.principalDigest,
      principalRecordId: null,
      principalVersion: null,
      scopeMode: 'workspace' as const,
      workspace,
      agentPreset: 'primary',
      trust: 'trusted' as const,
      sensitivity: 'private' as const,
      title,
      body,
      entities,
      tokens: ['postgres', 'replica', 'lag', 'vacuum', 'tuning', 'pg_stat'],
      expiresAt,
      createdAt: baseNow,
      updatedAt: baseNow,
    })

    store.upsertBatch({
      nodes: [
        makeMem(
          'a:m-d1',
          'memory:d1',
          scopeA,
          'Postgres Replica Vacuum',
          'Postgres (pg_alias_a) replica lag and vacuum tuning guide.',
          ['postgres', 'replica', 'vacuum'],
        ),
        makeMem(
          'a:m-d2',
          'memory:d2',
          scopeA,
          'Replica Vacuum Lock Check',
          'Inspect replica lag and vacuum lock contention on pg_stat.',
          ['replica', 'vacuum', 'pg_stat'],
        ),
        // Owner B has a trusted node with a distinct entity and synonym so we verify AC isolation
        makeMem(
          'a:m-b1',
          'memory:b1',
          scopeB,
          'Owner B Exclusive Runbook',
          'Owner B exclusive knowledge.',
          ['owner_b_target'],
        ),
      ],
      edges: [],
      synonyms: [
        {
          id: computeDeterministicSynonymId(scopeB.ownerScopeKey, 'shared_alias', 'owner_b_target'),
          ownerScopeKey: scopeB.ownerScopeKey,
          surface: 'shared_alias',
          canonicalEntity: 'owner_b_target',
          sourceNodeId: 'a:m-b1',
          trust: 'trusted',
          createdAt: baseNow,
        },
        {
          id: computeDeterministicSynonymId(scopeA.ownerScopeKey, 'shared_alias', 'postgres'),
          ownerScopeKey: scopeA.ownerScopeKey,
          surface: 'shared_alias',
          canonicalEntity: 'postgres',
          sourceNodeId: 'a:m-d1',
          trust: 'low',
          createdAt: baseNow,
        },
      ],
      derivedRefs: [
        {
          sourceNodeId: 'a:m-d1',
          sourceVersion: 1,
          targetKind: 'synonym',
          targetId: computeDeterministicSynonymId(scopeA.ownerScopeKey, 'shared_alias', 'postgres'),
        },
        {
          sourceNodeId: 'a:m-b1',
          sourceVersion: 1,
          targetKind: 'synonym',
          targetId: computeDeterministicSynonymId(scopeB.ownerScopeKey, 'shared_alias', 'owner_b_target'),
        },
      ],
    })
    await assoc.refreshIndex()

    // 1. Policy deny blocks dreaming
    clockMs = baseNow + 20_000
    const denied = await assoc.runDreamingNow(scopeA, { nowMs: clockMs })
    expect(denied.ran).toBe(false)
    expect(denied.reason).toBe('policy-denied')

    // 2. Policy allow + idle -> creates low-trust dream edges, abstraction nodes, and AC synonyms
    allowDreaming = true
    const dreamRes = await assoc.runDreamingNow(scopeA, { nowMs: clockMs })
    expect(dreamRes.ran).toBe(true)
    expect(dreamRes.edgesCreated).toBeGreaterThan(0)
    expect(dreamRes.abstractionsCreated).toBeGreaterThan(0)
    expect(dreamRes.synonymsCreated).toBeGreaterThan(0)
    expect(assoc.listDreamRuns(scopeA.ownerScopeKey)).toHaveLength(1)

    const absNode = dreamRes.artifacts.nodes[0]!
    expect(absNode.kind).toBe('abstraction')
    expect(absNode.trust).toBe('low')
    for (const edge of dreamRes.artifacts.edges) {
      expect(edge.trust).toBe('low')
    }
    for (const syn of dreamRes.artifacts.synonyms) {
      expect(syn.trust).toBe('low')
    }

    // Hot-path AC synonym match without model calls + <association> low-trust framing + assoc_read
    pushUserTurn(ctx, agentA, 'Check pg_alias_a and shared_alias now', 0)
    const snapA = assoc.contextSnapshot(agentA)
    expect(snapA).toContain('<association>')
    expect(snapA).toContain('| low |')
    expect(snapA).toContain(absNode.id)
    expect(snapA).not.toContain('a:m-b1')

    const readAbs = await assoc.readById(makeFakeExecution(agentA, 'read-abs'), absNode.id)
    expect(readAbs.trust).toBe('low')
    expect(readAbs.kind).toBe('abstraction')

    // Owner B queries shared_alias -> resolves ONLY Owner B's node, never Owner A's low-trust synonym/node
    pushUserTurn(ctx, agentB, 'Check shared_alias', 0)
    const snapB = assoc.contextSnapshot(agentB)
    expect(snapB).toContain('a:m-b1')
    expect(snapB).not.toContain('a:m-d1')
    expect(snapB).not.toContain(absNode.id)

    // Dual-endpoint invalidation Case 1: withdrawSource(a:m-d1) deletes dream edge, ABS node, and SYN
    store.withdrawSource({
      ownerScopeKey: scopeA.ownerScopeKey,
      sourcePlugin: 'personal-memory',
      sourceRef: 'memory:d1',
      hardDelete: true,
      nowMs: clockMs + 100,
    })
    await assoc.refreshIndex()
    expect(store.getNodeById(absNode.id)).toBeNull()
    expect(
      store.loadActiveEdgesPage(50, 0).filter((e) => e.edgeType === 'dream' || e.edgeType === 'abstraction'),
    ).toHaveLength(0)
    await expect(assoc.readById(makeFakeExecution(agentA, 'read-after-wd'), absNode.id)).rejects.toThrow(
      AssistantAssociationError,
    )

    // Re-seed pair (a:m-d3, a:m-d4) and re-dream to verify Cases 2, 3, and 4
    const reseedAndDream = async (tag: string, bExpiresAt: number | null = null) => {
      clockMs += 5_000
      store.upsertBatch({
        nodes: [
          makeMem(`a:m-${tag}1`, `memory:${tag}1`, scopeA, `Alpha ${tag}`, `Alpha replica (${tag}_syn) vacuum`, ['alpha_k', 'replica', 'vacuum'], null, 1),
          makeMem(`a:m-${tag}2`, `memory:${tag}2`, scopeA, `Beta ${tag}`, `Beta replica vacuum tuning`, ['beta_k', 'replica', 'vacuum'], bExpiresAt, 1),
        ],
        edges: [],
        derivedRefs: [],
      })
      clockMs += 20_000
      const r = await assoc.runDreamingNow(scopeA, { nowMs: clockMs })
      expect(r.ran).toBe(true)
      expect(r.abstractionsCreated).toBeGreaterThan(0)
      return r
    }

    // Case 2: suppressNodeConflict on B deletes dream edge, ABS node, and SYN
    const r2 = await reseedAndDream('supp')
    const abs2 = r2.artifacts.nodes[0]!
    const dreamEdge2 = r2.artifacts.edges.find((e) => e.edgeType === 'dream')!
    const syn2 = r2.artifacts.synonyms.find((s) => s.surface === 'supp_syn')!
    const suppRes = store.suppressNodeConflict({
      ownerScopeKey: scopeA.ownerScopeKey,
      sourcePlugin: 'personal-memory',
      sourceRef: 'memory:supp2',
      nowMs: clockMs + 10,
    })
    expect(suppRes.deletedNodeIds).toContain(abs2.id)
    expect(suppRes.deletedEdgeIds).toContain(dreamEdge2.edgeId)
    expect(suppRes.deletedSynonymIds).toContain(syn2.id)
    await assoc.refreshIndex()
    expect(store.getNodeById(abs2.id)).toBeNull()
    expect(store.loadActiveSynonymsPage(50, 0).some((s) => s.id === syn2.id)).toBe(false)
    store.withdrawSource({ ownerScopeKey: scopeA.ownerScopeKey, sourcePlugin: 'personal-memory', sourceRef: 'memory:supp1', hardDelete: true })

    // Case 3: B expires (expiresAt <= nowMs) + sweepExpiredNodesNow deletes B, ABS, dream edge & SYN
    const bExpiry = clockMs + 100_000
    const r3 = await reseedAndDream('exp', bExpiry)
    const abs3 = r3.artifacts.nodes[0]!
    const syn3 = r3.artifacts.synonyms.find((s) => s.surface === 'exp_syn')!
    expect(store.getNodeById(abs3.id)).not.toBeNull()
    clockMs = bExpiry + 1_000
    const swept = await assoc.sweepExpiredNodesNow(clockMs)
    expect(swept.some((t) => t.id === 'a:m-exp2')).toBe(true)
    expect(store.getNodeById('a:m-exp2')).toBeNull()
    expect(store.getNodeById(abs3.id)).toBeNull()
    expect(store.loadActiveSynonymsPage(50, 0).some((s) => s.id === syn3.id)).toBe(false)
    store.withdrawSource({ ownerScopeKey: scopeA.ownerScopeKey, sourcePlugin: 'personal-memory', sourceRef: 'memory:exp1', hardDelete: true })

    // Case 4: A bumps sourceVersion (v1 -> v2) deletes stale v1 dream edge, ABS, and SYN
    const r4 = await reseedAndDream('bump')
    const abs4 = r4.artifacts.nodes[0]!
    const syn4 = r4.artifacts.synonyms[0]!
    store.upsertBatch({
      nodes: [
        makeMem('a:m-bump1', 'memory:bump1', scopeA, 'Alpha bump v2', 'Rewritten without alias', ['unrelated_v2'], null, 2),
      ],
      edges: [],
      derivedRefs: [],
    })
    await assoc.refreshIndex()
    expect(store.getNodeById(abs4.id)).toBeNull()
    expect(store.loadActiveSynonymsPage(50, 0).some((s) => s.id === syn4.id)).toBe(false)
  })

  test('T-S3-03: ingests wiki (with trusted alias synonyms & Policy wiki deny), active skills, event-triggers (low trust, zero secret leak), and dreaming ideas with live validity re-checks', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'assoc-s3-sources-')))
    const workspace = join(root, 'ws')
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })

    const ownerPrincipal = { channel: 'lark', account: 'bot', tenant: 't1', user: 'ou_owner' }
    const ownerConv = { channel: 'lark', account: 'bot', tenant: 't1', kind: 'dm' as const, chat: 'chat_1' }
    const authority: OwnerRouteAuthority = {
      id: 'owner-route-s3',
      conversation: ownerConv,
      principal: ownerPrincipal,
      workspace,
      agentPreset: 'primary',
      policyRef: 'owner-dm',
      minimumGeneration: 1,
    }

    let allowWikiRead = true
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
          id: 'allow-webhook',
          effect: 'allow',
          subject: { kind: 'external', id: 'webhook:*' },
          actions: ['accept'],
          resource: { kind: 'automation', id: '*' },
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
    const policy = ctx.assistantPolicy
    const origAuthAgent = policy.authorizeAgent.bind(policy)
    vi.spyOn(policy, 'authorizeAgent').mockImplementation((agent, action, resource, opts) => {
      if (resource.kind === 'wiki' && action === 'read' && !allowWikiRead) {
        return { effect: 'deny', reasonCode: 'rule-deny', ruleId: undefined }
      }
      return origAuthAgent(agent, action, resource, opts)
    })

    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      ownerRoutes: [authority],
    })
    const delivery = ctx.assistantDelivery
    const pairing = delivery.issuePairing('test', ownerPrincipal)
    delivery.confirmPairing({ challengeId: pairing.challenge.id, principal: ownerPrincipal, code: pairing.code })
    const dStore = (delivery as unknown as {
      deliveryStore: {
        getPrincipal: (p: unknown) => { id: string; version: number } | undefined
        createBinding: (input: unknown) => { id: string }
      }
    }).deliveryStore
    const ownerV1 = dStore.getPrincipal(ownerPrincipal)!

    const sessionId = SessionId('sess-s3-sources')
    const agent = await ctx.agentLoop.create(
      sessionId,
      { provider: 'mock', model: 'mock' },
      { cwd: workspace, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = agent.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
    dStore.createBinding({
      conversation: ownerConv,
      principal: ownerPrincipal,
      workspace,
      agentPreset: 'primary',
      sessionId: String(sessionId),
      policyRef: 'owner-dm',
    })

    // 1. PersonalWikiService
    await ctx.plugin(PersonalWikiService, {
      vaultRoot: join(root, 'vault'),
      databasePath: join(root, 'wiki.sqlite'),
      defaultProposalTtlMs: 60_000,
      reconcileIntervalMs: 0,
    })
    const wiki = ctx.personalWiki
    const wikiProp = wiki.propose(agent, {
      idempotencyKey: 'wiki-1',
      principal: 'lark/bot/t1/ou_owner',
      mutation: {
        op: 'create',
        input: {
          title: 'Kubernetes Ingress Runbook',
          type: 'concept',
          authority: 'curated',
          status: 'active',
          tags: ['k8s', 'ingress'],
          aliases: ['k8s_ingress_alias'],
          sources: [{ uri: 'https://example.test/k8s', sha256: sha('k8s') }],
          body: 'Restart ingress controller pods on TLS reload errors.',
        },
      },
    })
    const activeWikiPage = wiki.decideProposal({
      proposalId: wikiProp.proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'approved',
    }).page!

    // 2. AssistantGoalsService + AssistantSkillsService (save one active skill, and one pending candidate)
    await ctx.plugin(AssistantGoalsService, {
      databasePath: join(root, 'goals.sqlite'),
    })
    const scopeGoal = {
      principalId: 'lark/bot/t1/ou_owner',
      principalRecordId: ownerV1.id,
      principalVersion: ownerV1.version,
      workspace,
      preset: 'primary',
    }
    const goalsSvc = ctx.assistantGoals
    vi.spyOn(goalsSvc, 'inspectVerifiedWorkflowSource').mockReturnValue({
      protocol: 'assistant-goals/verified-workflow-source/v1',
      scope: scopeGoal,
      goal: {
        id: 'goal-skill-1',
        definition: { version: 1, digest: sha('Deploy script'), objective: 'Deploy script' },
        sessionId: String(sessionId),
        nativeGoalId: 'native-g1',
      },
      runId: 'run-skill-1',
      turn: 1,
      acceptance: {
        contractId: 'contract-skill-1',
        contractDigest: sha('cs1'),
        receiptDigest: sha('rs1'),
        verifiedAt: Date.now(),
        validUntil: Date.now() + 60_000,
      },
      steps: [{ id: 's1', toolName: 'read', arguments: { file_path: 'README.md' } }],
      failedObservations: [],
    })
    vi.spyOn(delivery, 'preferencePrincipalForAgent').mockReturnValue({
      principalId: 'lark/bot/t1/ou_owner',
      principalLineage: { principalRecordId: ownerV1.id, principalVersion: ownerV1.version },
      scope: { workspace, preset: 'primary' },
      sessionId: String(sessionId),
    } as never)
    vi.spyOn(delivery, 'currentPreferenceTurn').mockReturnValue({
      principalId: 'lark/bot/t1/ou_owner',
      principalLineage: { principalRecordId: ownerV1.id, principalVersion: ownerV1.version },
      scope: { workspace, preset: 'primary' },
      sourceInboxId: 'inbox-s3-sources-nh',
      sessionId: String(sessionId),
      turn: 1,
    } as never)

    await ctx.plugin(AssistantSkillsService, {
      databasePath: join(root, 'skills.sqlite'),
      allowedTools: ['read'],
    })
    const saveTool = ctx.tools.get('skill_save')!
    await saveTool.execute(
      {
        goal_id: 'goal-skill-1',
        name: 'deploy-healthcheck',
        description: 'Verify deployment health endpoint after rollout',
      },
      makeFakeExecution(agent, 'skill-save-1') as never,
    )

    // 3. EventTriggersService with secret in http-json / webhook config
    class StubAutomationsService extends Service {
      private readonly rows = new Map<
        string,
        { definitionHash: string; ownerRouteId: string; activationNonce: string; status: 'active' | 'paused' }
      >()
      constructor(c: Context) {
        super(c, 'assistantAutomations')
      }
      registerHostExecutor() {
        return () => {}
      }
      listSystemOwned() {
        return []
      }
      reconcileSystem(input: {
        automationId: string
        desiredStatus?: 'active' | 'paused'
        definition: { execution: { ownerRouteId: string; activationNonce: string } }
      }) {
        const hash = sha(JSON.stringify(input.definition))
        this.rows.set(input.automationId, {
          definitionHash: hash,
          ownerRouteId: input.definition.execution.ownerRouteId,
          activationNonce: input.definition.execution.activationNonce,
          status: input.desiredStatus ?? 'active',
        })
        return { id: input.automationId, definition: input.definition }
      }
      inspectSystemOwned(input: { automationId: string }) {
        const row = this.rows.get(input.automationId)
        return {
          automationStatus: row?.status ?? 'paused',
          definitionHash: row?.definitionHash ?? '0'.repeat(64),
          definitionVersion: 1,
        }
      }
      inspectSystemOwnedActivation(input: { automationId: string }) {
        const row = this.rows.get(input.automationId)
        if (!row) return undefined
        return {
          definitionHash: row.definitionHash,
          ownerRouteId: row.ownerRouteId,
          activationNonce: row.activationNonce,
        }
      }
      pauseSystemOwned(input: { automationId: string }) {
        const row = this.rows.get(input.automationId)
        if (row) row.status = 'paused'
      }
      ingestExternal() {}
    }
    await ctx.plugin(StubAutomationsService)

    const watchedFile = join(root, 'trigger-watch.txt')
    await writeFile(watchedFile, 'initial')
    const secretToken = 'SUPER_SECRET_EVENT_TOKEN_XYZ987654321'
    ctx.provide('credentialsKeychain' as never, {
      withSecret: async (_c: unknown, _req: unknown, cb: (s: string, sig: AbortSignal) => Promise<unknown>) =>
        cb(secretToken, new AbortController().signal),
    } as never)
    const now = Date.now()
    const triggerId = 'trig-s3-1'
    await ctx.plugin(EventTriggersService, {
      databasePath: join(root, 'events.sqlite'),
      pollerEnabled: false,
      triggers: [
        {
          id: triggerId,
          kind: 'webhook',
          enabled: true,
          automationId: 'auto-deploy',
          credentialHandle: 'cred-webhook-1',
          cooldownMs: 0,
          ttlMs: 120_000,
          observer: {
            ...scopeGoal,
            ownerRouteId: authority.id,
            expiresAt: now + 600_000,
            budgetId: 'budget-s3-triggers',
          },
          intake: {
            enabled: true,
            summaryLabel: 'deploy-webhook-alert',
          },
        },
      ],
    })
    const eventTriggers = ctx.eventTriggers
    const eventBody = Buffer.from(JSON.stringify({ status: 'alert', token: secretToken }))
    const ts = String(now)
    const sig = createHmac('sha256', secretToken)
      .update(`${ts}\nnonce-1\n`)
      .update(eventBody)
      .digest('hex')
    const webhookRes = await eventTriggers.ingestWebhook(triggerId, {
      timestamp: ts,
      nonce: 'nonce-1',
      signature: `sha256=${sig}`,
      body: eventBody,
    })

    // 3b. AssistantDreaming peer (ideas -> low-trust dream nodes + immediate withdrawal on reject)
    const dreamIdeas: Array<{
      id: string
      lane: 'memory-consolidation'
      runId: string
      createdAt: number
      dayKey: string
      state: 'proposed' | 'rejected'
      summary: string
      detail: string
      evidenceRefs: string[]
    }> = [
      {
        id: 'idea-s3-1',
        lane: 'memory-consolidation',
        runId: 'dream-run-1',
        createdAt: now,
        dayKey: '2026-11-20',
        state: 'proposed',
        summary: 'dream_k8s_tls_hint correlation across deployments',
        detail: 'Observed dream_k8s_tls_hint repeating after ingress reloads.',
        evidenceRefs: ['mem:1'],
      },
    ]
    const ideaListeners = new Set<() => void>()
    ctx.provide('assistantDreaming' as never, {
      inspectIdeas: () => dreamIdeas,
      onIdeaChange: (cb: () => void) => {
        ideaListeners.add(cb)
        return () => {
          ideaListeners.delete(cb)
        }
      },
    } as never)

    // 4. Mount AssistantAssociationService
    let clockMs = now
    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
      minItems: 1,
      maxItems: 8,
      hotPathBudgetMs: 50,
      allowLowTrust: true,
      syncIntervalMs: 60_000,
    })
    const assoc = ctx.assistantAssociation
    assoc.setNowClock(() => clockMs)
    assoc.setHotPathClock(() => 0)
    await assoc.syncAll()
    await assoc.refreshIndex()

    const ownerScopeKey = computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest: computePrincipalDigest(ownerPrincipal.channel + '/' + ownerPrincipal.account + '/' + ownerPrincipal.tenant + '/' + ownerPrincipal.user),
      principalRecordId: ownerV1.id,
      principalVersion: ownerV1.version,
      workspace,
      agentPreset: 'primary',
    })
    const scope8 = ownerScopeKey.slice(0, 8)
    const wikiNodeId = `a:wk-${scope8}-${activeWikiPage.metadata.id}`
    const skillNodeId = `a:sk-${scope8}-${sha('deploy-healthcheck').slice(0, 24)}`
    const eventNodeId = `a:ev-${scope8}-${sha(`${triggerId}\0${webhookRes.eventId}`).slice(0, 24)}`
    const dreamIdeaNodeId = `a:dr-${scope8}-${sha('idea-s3-1').slice(0, 20)}`

    // Verify all 4 nodes stored with expected trust/scope/ttl and ZERO secret leakage
    const wikiNode = assoc.store!.getNodeById(wikiNodeId)!
    const skillNode = assoc.store!.getNodeById(skillNodeId)!
    const eventNode = assoc.store!.getNodeById(eventNodeId)!
    const dreamIdeaNode = assoc.store!.getNodeById(dreamIdeaNodeId)!
    expect(wikiNode.kind).toBe('wiki')
    expect(wikiNode.trust).toBe('trusted')
    expect(wikiNode.scopeMode).toBe('user-global')
    expect(skillNode.kind).toBe('skill')
    expect(skillNode.trust).toBe('trusted')
    expect(eventNode.kind).toBe('event')
    expect(eventNode.trust).toBe('low')
    expect(eventNode.expiresAt).not.toBeNull()
    expect(JSON.stringify(eventNode)).not.toContain(secretToken)
    expect(dreamIdeaNode.kind).toBe('dream')
    expect(dreamIdeaNode.trust).toBe('low')
    expect(dreamIdeaNode.expiresAt).not.toBeNull()

    // Ensure currentPreferenceTurn uses a guaranteed non-holdout foreground-turn taskId before calling contextSnapshot
    const assocNhInbox = findForegroundInboxByHoldout(assoc, false, 'nh-src')
    vi.mocked(delivery.currentPreferenceTurn).mockReturnValue({
      principalId: 'lark/bot/t1/ou_owner',
      principalLineage: { principalRecordId: ownerV1.id, principalVersion: ownerV1.version },
      scope: { workspace, preset: 'primary' },
      sourceInboxId: assocNhInbox,
      sessionId: String(sessionId),
      turn: 1,
    } as never)

    // Hot-path recalls wiki via alias synonym, skill, and event
    pushUserTurn(ctx, agent, 'Investigate k8s_ingress_alias deploy-healthcheck and deploy-webhook-alert', 1)
    const snap = assoc.contextSnapshot(agent)
    expect(snap).toContain(wikiNodeId)
    expect(snap).toContain(skillNodeId)
    expect(snap).toContain(eventNodeId)

    // assoc_read enforces Policy 'wiki' deny
    allowWikiRead = false
    await expect(assoc.readById(makeFakeExecution(agent, 'read-wiki-deny'), wikiNodeId)).rejects.toMatchObject({
      code: 'policy-denied',
    })
    allowWikiRead = true
    const readWiki = await assoc.readById(makeFakeExecution(agent, 'read-wiki-ok'), wikiNodeId)
    expect(readWiki.kind).toBe('wiki')

    // Retiring skill immediately withdraws skill node on onSkillChange + readById rejects
    const retireTool = ctx.tools.get('skill_retire')!
    await retireTool.execute({ name: 'deploy-healthcheck', expected_version: 1 }, makeFakeExecution(agent, 'skill-retire-1') as never)
    await vi.waitFor(async () => {
      await assoc.flush()
      expect(assoc.store!.getNodeById(skillNodeId)).toBeNull()
    })
    await expect(assoc.readById(makeFakeExecution(agent, 'read-skill-retired'), skillNodeId)).rejects.toMatchObject({
      code: 'not-found',
    })

    // Archiving wiki page withdraws wiki node via onPageChange
    const archProp = wiki.propose(agent, {
      idempotencyKey: 'wiki-arch-1',
      principal: 'lark/bot/t1/ou_owner',
      mutation: {
        op: 'update',
        pageId: activeWikiPage.metadata.id,
        expectedRevision: activeWikiPage.revision,
        input: {
          title: activeWikiPage.metadata.title,
          type: 'concept',
          authority: 'curated',
          status: 'archived',
          tags: ['k8s'],
          aliases: ['k8s_ingress_alias'],
          sources: activeWikiPage.metadata.sources,
          body: activeWikiPage.body,
        },
      },
    })
    wiki.decideProposal({
      proposalId: archProp.proposalId,
      principal: 'lark/bot/t1/ou_owner',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'archive',
    })
    await vi.waitFor(async () => {
      await assoc.flush()
      expect(assoc.store!.getNodeById(wikiNodeId)).toBeNull()
    })
    await expect(assoc.readById(makeFakeExecution(agent, 'read-wiki-arch'), wikiNodeId)).rejects.toMatchObject({
      code: 'not-found',
    })

    // Rejecting assistant-dreaming idea withdraws dream node via onIdeaChange
    dreamIdeas[0]!.state = 'rejected'
    for (const cb of ideaListeners) cb()
    await vi.waitFor(async () => {
      await assoc.flush()
      expect(assoc.store!.getNodeById(dreamIdeaNodeId)).toBeNull()
    })
    await expect(assoc.readById(makeFakeExecution(agent, 'read-idea-rejected'), dreamIdeaNodeId)).rejects.toMatchObject({
      code: 'not-found',
    })

    // Advancing clock past event ttlMs causes live readById expiry check to reject
    clockMs = (eventNode.expiresAt ?? now) + 5_000
    await expect(assoc.readById(makeFakeExecution(agent, 'read-event-expired'), eventNodeId)).rejects.toMatchObject({
      code: 'not-found',
    })
  }, 15_000)

  test('T-S3-04: hot-path intakeSignal operates strictly in observe mode under Policy, cooldown, and holdout exclusion', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'assoc-s3-intake-')))
    const workspace = join(root, 'ws')
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })

    const enqueueBackgroundSpy = vi.fn(() => Promise.resolve({ id: 'outbox' }))
    ctx.provide('assistantDelivery' as never, {
      isMaintenanceDraining: () => true,
      validateOwnerRoute: (v: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
        receiptVersion: 2,
        ...v,
        authorityHash: 'sha256:owner',
        principalRecordId: 'owner-intake',
        principalVersion: 1,
        bindingVersion: 1,
        generation: 1,
      }),
      enqueueBackground: enqueueBackgroundSpy,
    } as never)

    class PolicyAllowService extends Service {
      constructor(c: Context) {
        super(c, 'assistantPolicy')
      }
      getEmergencyStop() {
        return { enabled: false }
      }
      evaluate() {
        return { effect: 'allow' as const, reasonCode: 'rule-allow', ruleId: 'allow-all' }
      }
      authorize() {
        return { effect: 'allow' as const, reasonCode: 'rule-allow', ruleId: 'allow-all' }
      }
      authorizeAgent() {
        return { effect: 'allow' as const, reasonCode: 'rule-allow', ruleId: 'allow-all' }
      }
    }
    class SchedulerStubService extends Service {
      private readonly listeners = new Set<() => void>()
      constructor(c: Context) {
        super(c, 'assistantAutomations')
      }
      onSchedulerWake(fn: () => void): () => void {
        this.listeners.add(fn)
        return () => {
          this.listeners.delete(fn)
        }
      }
      wake(): void {
        for (const fn of this.listeners) fn()
      }
      ingestExternal(value: { automationId: string; eventId: string }) {
        return { id: `occ-${value.eventId}`, automationId: value.automationId }
      }
    }

    await ctx.plugin(PolicyAllowService)
    await ctx.plugin(SchedulerStubService)

    const itemsDbPath = join(root, 'work-items.sqlite')
    const wiConfig: WorkItemsConfig = {
      enabled: true,
      mode: 'active',
      databasePath: itemsDbPath,
      workRoot: join(root, 'wi-work'),
      workerAutomationId: 'worker-1',
      scope: {
        workspace,
        preset: 'primary',
        principalId: 'owner:intake',
        ownerRouteId: 'route-intake',
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
            originBindingId: 'origin-1',
          },
        },
      },
    }
    await ctx.plugin(AssistantWorkItemsService, wiConfig)
    const wiService = ctx.assistantWorkItems
    const evaluator: WorkItemIntakeEvaluatorRegistration = {
      protocol: 1,
      policy: () => ({ version: 'v1', rules: [{ ruleId: 'rule-triage', ceiling: 'accept' }] }),
      evaluate: () => Promise.resolve({ level: 'accept', quotes: ['goal'] }),
    }
    wiService.registerIntakeEvaluator(evaluator)

    let clockMs = 1_700_000_000_000
    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
      allowHeadlessScope: true,
      minItems: 1,
      maxItems: 8,
      hotPathBudgetMs: 50,
      syncIntervalMs: 60_000,
      intakeSignal: {
        enabled: true,
        minScore: 0.5,
        cooldownMs: 600_000,
        maxSignalsPerHour: 10,
      },
    })
    const assoc = ctx.assistantAssociation
    assoc.setNowClock(() => clockMs)
    assoc.setHotPathClock(() => 0)
    const store = assoc.store!
    const scope = makeHeadlessScope('owner-intake', workspace)
    const now = clockMs

    // Seed an active private goal node and a strong-entity-connected event node
    const edgeId = computeDeterministicEdgeId('a:ev-spike', 'a:g-latency', 'entity')
    store.upsertBatch({
      nodes: [
        {
          id: 'a:g-latency',
          kind: 'goal',
          sourcePlugin: 'assistant-goals',
          sourceRef: 'goal:latency',
          sourceVersion: 1,
          ownerScopeKey: scope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: scope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'Keep service p99 latency under 100ms',
          body: 'Monitor latency_spike alerts across staging cluster.',
          entities: ['latency_spike'],
          tokens: ['latency', 'spike', 'service'],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a:ev-spike',
          kind: 'event',
          sourcePlugin: 'event-triggers',
          sourceRef: 'event:trig-1:ev-1',
          sourceVersion: 1,
          ownerScopeKey: scope.ownerScopeKey,
          ownerMode: 'headless',
          principalDigest: scope.principalDigest,
          principalRecordId: null,
          principalVersion: null,
          scopeMode: 'workspace',
          workspace,
          agentPreset: 'primary',
          trust: 'low',
          sensitivity: 'private',
          title: 'Alert: latency_spike observed',
          body: 'Webhook reported latency_spike 450ms.',
          entities: ['latency_spike'],
          tokens: ['latency', 'spike', 'webhook'],
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [
        {
          edgeId,
          aId: 'a:ev-spike',
          bId: 'a:g-latency',
          edgeType: 'entity',
          weight: 1.0,
          trust: 'low',
          reason: 'entity:latency_spike',
          createdAt: now,
          updatedAt: now,
        },
      ],
      derivedRefs: [],
    })
    await assoc.refreshIndex()

    // Use a guaranteed non-holdout headless session taskId (`headless-session:${id}:turn:0`)
    let nonHoldoutSid = ''
    for (let i = 0; i < 200; i += 1) {
      const sid = `sess-intake-nh-${i}`
      if (!assoc.isTaskInHoldout(`headless-session:${sid}:turn:0`).inHoldout) {
        nonHoldoutSid = sid
        break
      }
    }
    expect(nonHoldoutSid).not.toBe('')

    const agent = makeHeadlessAgent(nonHoldoutSid, workspace)
    assoc.bindHeadlessPrincipal(agent, 'owner-intake')
    pushUserTurn(ctx, agent, 'Investigate latency_spike right now', 0)

    const snap = assoc.contextSnapshot(agent)
    expect(snap).toContain('a:g-latency')
    await assoc.flush()

    const signals = assoc.listIntakeSignals(scope.ownerScopeKey)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.outcome).toBe('recorded')
    const sourceEventId = signals[0]!.sourceEventId

    // Verify WP20 evaluate + admit.mode='auto' fail-closed to observe/would-admit with 0 admitted items and 0 delivery notifications
    await vi.waitFor(() => {
      expect(wiService.intakeEvaluations('assistant-association', sourceEventId)).toMatchObject([
        { wouldAccept: true },
      ])
    })
    const scheduler = ctx.get('assistantAutomations' as never) as unknown as SchedulerStubService
    scheduler.wake()
    await vi.waitFor(() => {
      expect(wiService.intakeAdmissions('assistant-association', sourceEventId)).toMatchObject([
        { mode: 'observe', outcome: 'would-admit', itemId: null },
      ])
    })

    const wiDb = new DatabaseSync(itemsDbPath, { readOnly: true })
    try {
      const cnt = wiDb.prepare('SELECT count(*) AS n FROM work_item').get() as { n: number }
      expect(cnt.n).toBe(0)
    } finally {
      wiDb.close()
    }
    expect(enqueueBackgroundSpy).not.toHaveBeenCalled()

    // Second step within cooldownMs does NOT emit a duplicate intake signal
    clockMs += 1_000
    pushUserTurn(ctx, agent, 'Investigate latency_spike again', 1)
    assoc.contextSnapshot(agent)
    await assoc.flush()
    expect(assoc.listIntakeSignals(scope.ownerScopeKey)).toHaveLength(1)

    // Holdout task NEVER triggers intake signal even after cooldown
    let holdoutSid = ''
    for (let i = 0; i < 200; i += 1) {
      const sid = `sess-intake-ho-${i}`
      if (assoc.isTaskInHoldout(`headless-session:${sid}:turn:0`).inHoldout) {
        holdoutSid = sid
        break
      }
    }
    expect(holdoutSid).not.toBe('')
    clockMs += 700_000
    const holdoutAgent = makeHeadlessAgent(holdoutSid, workspace)
    assoc.bindHeadlessPrincipal(holdoutAgent, 'owner-intake')
    pushUserTurn(ctx, holdoutAgent, 'Investigate latency_spike in holdout', 0)
    expect(assoc.contextSnapshot(holdoutAgent)).toBe('')
    await assoc.flush()
    expect(assoc.listIntakeSignals(scope.ownerScopeKey)).toHaveLength(1)
  })

  test('T-S3-05, T-S3-06 & T-S3-07: clustering (WP04 holdout exclusion), implicit low-trust signals, and eval pool eligibility & retraction', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'assoc-s3-feeds-')))
    const workspace = join(root, 'ws')
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })

    const ownerPrincipal = { channel: 'lark', account: 'bot', tenant: 't1', user: 'ou_feeds' }
    const ownerConv = { channel: 'lark', account: 'bot', tenant: 't1', kind: 'dm' as const, chat: 'chat_f' }
    const authority: OwnerRouteAuthority = {
      id: 'owner-route-feeds',
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
          subject: { kind: 'external', id: 'lark/bot/t1/ou_feeds' },
          actions: ['pair.confirm', 'ingest'],
          resource: { kind: 'message', id: '*' },
          context: { initiators: ['external'] },
        },
        {
          id: 'allow-webhook',
          effect: 'allow',
          subject: { kind: 'external', id: 'webhook:*' },
          actions: ['accept'],
          resource: { kind: 'automation', id: '*' },
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

    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      ownerRoutes: [authority],
    })
    const delivery = ctx.assistantDelivery
    const pairing = delivery.issuePairing('test', ownerPrincipal)
    delivery.confirmPairing({ challengeId: pairing.challenge.id, principal: ownerPrincipal, code: pairing.code })
    const dStore = (delivery as unknown as {
      deliveryStore: {
        getPrincipal: (p: unknown) => { id: string; version: number } | undefined
        createBinding: (input: unknown) => { id: string }
      }
    }).deliveryStore
    const ownerV1 = dStore.getPrincipal(ownerPrincipal)!

    await ctx.plugin(AssistantEvaluationService, {
      databasePath: join(root, 'eval.sqlite'),
    })
    const evaluation = ctx.assistantEvaluation

    await ctx.plugin(AssistantGoalsService, {
      databasePath: join(root, 'goals.sqlite'),
    })
    const goals = ctx.assistantGoals

    const sessionId = SessionId('sess-feeds-1')
    await ctx.agentLoop.create(
      sessionId,
      { provider: 'mock', model: 'mock' },
      { cwd: workspace, agentPreset: 'primary' } as unknown as { cwd: string },
    )
    dStore.createBinding({
      conversation: ownerConv,
      principal: ownerPrincipal,
      workspace,
      agentPreset: 'primary',
      sessionId: String(sessionId),
      policyRef: 'owner-dm',
    })

    await ctx.plugin(AssistantAssociationService, {
      databasePath: join(root, 'assoc.sqlite'),
      syncIntervalMs: 60_000,
    })
    const assoc = ctx.assistantAssociation

    const principalId = 'lark/bot/t1/ou_feeds'
    const scope: AssociationOwnerScope = {
      mode: 'delivery',
      ownerScopeKey: computeOwnerScopeKey({
        mode: 'delivery',
        principalDigest: computePrincipalDigest(principalId),
        principalRecordId: ownerV1.id,
        principalVersion: ownerV1.version,
        workspace,
        agentPreset: 'primary',
      }),
      principalId,
      principalDigest: computePrincipalDigest(principalId),
      principalRecordId: ownerV1.id,
      principalVersion: ownerV1.version,
      workspace,
      agentPreset: 'primary',
      authorityId: authority.id,
    }

    // Find 4 non-holdout goal refs and 1 holdout goal ref matching `goal-outcome:${ref}`
    const nhRefs: string[] = []
    let hoRef = ''
    for (let i = 0; i < 300 && (nhRefs.length < 4 || hoRef === ''); i += 1) {
      const ref = `goal-ep-${i}`
      const taskId = `goal-outcome:${ref}`
      const inHo = assoc.isTaskInHoldout(taskId).inHoldout
      if (!inHo && nhRefs.length < 4) nhRefs.push(ref)
      if (inHo && hoRef === '') hoRef = ref
    }
    expect(nhRefs).toHaveLength(4)
    expect(hoRef).not.toBe('')

    // Stub goals.inspectOwnerGoals so #verifyEvaluationProjectionOwner accepts our goal-outcome projections
    vi.spyOn(goals, 'inspectOwnerGoals').mockReturnValue(
      [...nhRefs, hoRef].map((id) => ({
        id,
        version: 1,
        createdAt: 1000,
        updatedAt: 1000,
        definition: { version: 1, objective: 'Verify lint & test suite' },
        native: { phase: 'complete' },
        checkpoint: { nextStep: '', blockers: [] },
      })) as unknown as ReturnType<AssistantGoalsService['inspectOwnerGoals']>,
    )

    // Register eval receipts via Evaluation's public list/append seam
    const baseAt = 1_700_000_000_000
    const evalScopeKey = `${workspace}\0primary`
    const makeReceipt = (input: {
      readonly subjectRef: string
      readonly outcomeId: string
      readonly status: 'achieved' | 'not-achieved'
      readonly occurredAt: number
      readonly sourceId: string
      readonly evidence: ReadonlyArray<{ readonly kind: string; readonly ref: string; readonly digest?: string }>
      readonly disposition?: 'upsert' | 'retract'
      readonly version?: number
    }): TrustedTaskLearningProjectionReceipt => {
      const base: TrustedTaskLearningProjectionReceipt = {
        scope: { workspace, preset: 'primary' },
        scopeKey: evalScopeKey,
        scopeWatermark: 1,
        situation: `Verify isolated receipt ${input.subjectRef}`,
        triggerOutcomeId: input.outcomeId,
        objective: {
          outcomeId: input.outcomeId,
          status: input.status,
          occurredAt: input.occurredAt,
          source: { kind: 'system', id: input.sourceId },
          evidence: [...input.evidence],
          evaluator: { id: input.sourceId, version: '1' },
        },
        projection: {
          subjectKind: 'goal-outcome',
          subjectRef: input.subjectRef,
          disposition: input.disposition ?? 'upsert',
          version: input.version ?? 1,
          digest: sha('placeholder'),
        },
      }
      return {
        ...base,
        projection: {
          ...base.projection,
          digest: evaluationLearningProjectionDigest(
            base as unknown as Parameters<typeof evaluationLearningProjectionDigest>[0],
          ),
        },
      }
    }

    const receipts: TrustedTaskLearningProjectionReceipt[] = [
      // R1: non-holdout, verifier evidence -> replay pool (not-achieved first -> later redo)
      makeReceipt({
        subjectRef: nhRefs[0]!,
        outcomeId: 'out-r1',
        status: 'not-achieved',
        occurredAt: baseAt + 1_000,
        sourceId: 'assistant-verifier',
        evidence: [
          { kind: 'acceptance-contract', ref: 'c-r1', digest: sha('c-r1') },
          { kind: 'verification-receipt', ref: 'rc-r1', digest: sha('rc-r1') },
        ],
      }),
      // R1b: non-holdout, verifier evidence -> replay pool (achieved)
      makeReceipt({
        subjectRef: nhRefs[1]!,
        outcomeId: 'out-r1b',
        status: 'achieved',
        occurredAt: baseAt + 2_000,
        sourceId: 'assistant-verifier',
        evidence: [
          { kind: 'acceptance-contract', ref: 'c-r1b', digest: sha('c-r1b') },
          { kind: 'verification-receipt', ref: 'rc-r1b', digest: sha('rc-r1b') },
        ],
      }),
      // R2: holdout, verifier evidence -> holdout pool (NEVER in clusters/candidates/implicit signals!)
      makeReceipt({
        subjectRef: hoRef,
        outcomeId: 'out-r2',
        status: 'achieved',
        occurredAt: baseAt + 3_000,
        sourceId: 'assistant-verifier',
        evidence: [
          { kind: 'acceptance-contract', ref: 'c-r2', digest: sha('c-r2') },
          { kind: 'verification-receipt', ref: 'rc-r2', digest: sha('rc-r2') },
        ],
      }),
      // R3: non-holdout WITHOUT verifier contract/receipt evidence -> MUST NOT enter eval pool
      makeReceipt({
        subjectRef: nhRefs[2]!,
        outcomeId: 'out-r3',
        status: 'achieved',
        occurredAt: baseAt + 4_000,
        sourceId: 'assistant-delivery',
        evidence: [],
      }),
      // R4: upsert then retract -> removed from active eval pool
      makeReceipt({
        subjectRef: nhRefs[3]!,
        outcomeId: 'out-r4',
        status: 'achieved',
        occurredAt: baseAt + 5_000,
        sourceId: 'assistant-verifier',
        evidence: [
          { kind: 'acceptance-contract', ref: 'c-r4', digest: sha('c-r4') },
          { kind: 'verification-receipt', ref: 'rc-r4', digest: sha('rc-r4') },
        ],
      }),
    ]

    let currentReceipts = [...receipts]
    vi.spyOn(evaluation, 'listTrustedTaskLearningProjections').mockImplementation(() => ({
      items: currentReceipts.map((receipt, i) => ({
        watermark: i + 1,
        receipt,
      })),
      scopeWatermark: currentReceipts.length,
      nextCursor: { scopeKey: `${workspace}\0primary`, watermark: currentReceipts.length },
      hasMore: false,
    }))
    const appendedSignals: unknown[] = []
    vi.spyOn(evaluation, 'append').mockImplementation((env) => {
      appendedSignals.push(env)
      return env as never
    })

    // Provide toolNames on the non-holdout episodes + R4 before sync, or run syncScope
    await assoc.syncScope(scope)

    const replayPool = assoc.listEvalPool(scope.ownerScopeKey, { poolKind: 'replay' })
    const holdoutPool = assoc.listEvalPool(scope.ownerScopeKey, { poolKind: 'holdout' })
    expect(replayPool.map((e) => e.taskId).sort()).toEqual([
      `goal-outcome:${nhRefs[0]}`,
      `goal-outcome:${nhRefs[1]}`,
      `goal-outcome:${nhRefs[3]}`,
    ].sort())
    expect(holdoutPool.map((e) => e.taskId)).toEqual([`goal-outcome:${hoRef}`])
    // R3 (no verifier proof) MUST NOT enter pool
    expect(assoc.listEvalPool(scope.ownerScopeKey).some((e) => e.taskId === `goal-outcome:${nhRefs[2]}`)).toBe(false)

    // Retract R4 -> excluded from active listEvalPool
    const r4Retract = makeReceipt({
      subjectRef: nhRefs[3]!,
      outcomeId: 'out-r4',
      status: 'achieved',
      occurredAt: baseAt + 5_000,
      sourceId: 'assistant-verifier',
      evidence: [
        { kind: 'acceptance-contract', ref: 'c-r4', digest: sha('c-r4') },
        { kind: 'verification-receipt', ref: 'rc-r4', digest: sha('rc-r4') },
      ],
      disposition: 'retract',
      version: 2,
    })
    currentReceipts = [r4Retract]
    await assoc.syncScope(scope)

    const replayAfterRetract = assoc.listEvalPool(scope.ownerScopeKey, { poolKind: 'replay' })
    expect(replayAfterRetract.some((e) => e.taskId === `goal-outcome:${nhRefs[3]}`)).toBe(false)

    // Drain any background clustering triggered by syncScope before testing explicit clustering/implicit signals
    await assoc.flush()
    appendedSignals.length = 0

    // Now test clustering + implicit low-trust signals through AssistantAssociationService.runClusteringNow
    const clusterRes = await assoc.runClusteringNow(scope, {
      episodes: [
        {
          id: 'ep-nh-0',
          taskId: `goal-outcome:${nhRefs[0]}`,
          ownerScopeKey: scope.ownerScopeKey,
          title: 'Run pnpm lint and vitest suite',
          entities: ['pnpm', 'oxlint', 'vitest'],
          toolNames: ['read', 'edit', 'shell'],
          objectiveStatus: 'failed',
          createdAt: baseAt + 1_000,
        },
        {
          id: 'ep-nh-1',
          taskId: `goal-outcome:${nhRefs[1]}`,
          ownerScopeKey: scope.ownerScopeKey,
          title: 'Run pnpm lint and vitest suite',
          entities: ['pnpm', 'oxlint', 'vitest'],
          toolNames: ['read', 'edit', 'shell'],
          objectiveStatus: 'achieved',
          createdAt: baseAt + 2_000,
        },
        {
          id: 'ep-nh-2',
          taskId: `goal-outcome:${nhRefs[2]}`,
          ownerScopeKey: scope.ownerScopeKey,
          title: 'Run pnpm lint and vitest suite',
          entities: ['pnpm', 'oxlint', 'vitest'],
          toolNames: ['read', 'edit', 'shell'],
          corrected: true,
          createdAt: baseAt + 3_000,
        },
        {
          id: 'ep-ho',
          taskId: `goal-outcome:${hoRef}`,
          ownerScopeKey: scope.ownerScopeKey,
          title: 'Run pnpm lint and vitest suite',
          entities: ['pnpm', 'oxlint', 'vitest'],
          toolNames: ['read', 'edit', 'shell'],
          corrected: true,
          createdAt: baseAt + 500,
        },
      ],
      nowMs: baseAt + 10_000,
    })

    expect(clusterRes.clustering.excludedHoldoutCount).toBe(1)
    expect(clusterRes.clustering.candidates).toHaveLength(1)
    expect(clusterRes.clustering.candidates[0]?.status).toBe('pending')
    expect(clusterRes.clustering.candidates[0]?.wp04Verified).toBe(true)
    expect(clusterRes.clustering.candidates[0]?.memberTaskIds).not.toContain(`goal-outcome:${hoRef}`)

    const storedCandidates = assoc.listSkillCandidates(scope.ownerScopeKey, { status: 'pending' })
    expect(storedCandidates).toHaveLength(1)

    expect(clusterRes.implicitSignals.signals.map((s) => s.kind).sort()).toEqual([
      'owner-correction',
      're-ask',
      'redo',
    ])
    const implicit = assoc.listImplicitSignals(scope.ownerScopeKey)
    expect(new Set(implicit.map((s) => s.kind))).toEqual(
      new Set(['owner-correction', 're-ask', 'redo']),
    )
    for (const sig of implicit) {
      expect(sig.trust).toBe('low')
      expect(sig.candidateOnly).toBe(true)
      expect(sig.reportOnly).toBe(true)
      expect(sig.evidence.taskIds as string[]).not.toContain(`goal-outcome:${hoRef}`)
    }
    expect(clusterRes.reportedImplicitSignals.reported).toBe(3)
    expect(appendedSignals).toHaveLength(3)
    for (const env of appendedSignals as Array<{ trust: string }>) {
      expect(env.trust).toBe('self-reported')
    }
  })

  test('T-S3-08: Config validates S3 nested keys, preserves default-on toggles with explicit opt-out, and rejects unknown nested keys', () => {
    const defaults = normalizeConfig({ databasePath: ':memory:' })
    expect(defaults.dreaming.enabled).toBe(true)
    expect(defaults.intakeSignal.enabled).toBe(true)
    expect(defaults.webLearning.enabled).toBe(true)
    expect(defaults.clustering.minClusterSize).toBe(3)

    // Backward-compatible { enabled: false } from dogfoodPluginPreset
    const compat = Config({
      dreaming: { enabled: false },
      intakeSignal: { enabled: false },
      webLearning: { enabled: false },
    })
    expect(compat.dreaming?.enabled).toBe(false)
    expect(compat.intakeSignal?.enabled).toBe(false)
    expect(compat.webLearning?.enabled).toBe(false)

    // Unknown nested fields rejected cleanly
    expect(() => Config({ dreaming: { bogus: true } as never })).toThrow(/unknown config field: dreaming\.bogus/u)
    expect(() => Config({ intakeSignal: { bogus: true } as never })).toThrow(/unknown config field: intakeSignal\.bogus/u)
    expect(() => Config({ clustering: { bogus: true } as never })).toThrow(/unknown config field: clustering\.bogus/u)
    expect(() => Config({ webLearning: { bogus: true } as never })).toThrow(/unknown config field: webLearning\.bogus/u)
  })
})
