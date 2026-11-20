import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PersonalMemoryService } from '../src/service.ts'
import { MemoryStore, memoryPrincipalDigest } from '../src/store.ts'
import type { MemoryRecordChangeEvent } from '../src/types.ts'

const temporaryRoots: string[] = []

async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-assoc-'))
  temporaryRoots.push(root)
  return { memory: join(root, 'memory.sqlite'), policy: join(root, 'policy.sqlite') }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function stubAgent(options: { cwd?: string; preset?: string } = {}) {
  const id = SessionId(`memory-assoc-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  })
  const inbox = createInboxStub()
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    model: { current: () => ({ provider: 'test-provider', model: 'test-model' }), select: () => {} },
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  return { agent }
}

async function setupService(suppressor?: { shouldSuppressMemoryKeywordHits?: (agent: Agent) => boolean }) {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const databasePaths = await paths()
  new AssistantPolicyService(ctx, {
    databasePath: databasePaths.policy,
    rules: [{
      id: 'allow-memory-service',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['export', 'propose', 'read', 'search', 'snapshot'],
      resource: { kind: 'memory', id: '*' },
      context: { initiators: ['foreground'] },
    }],
  })
  if (suppressor !== undefined) {
    ctx.provide('assistantAssociation' as never, suppressor as never)
  }
  const service = new PersonalMemoryService(ctx, {
    databasePath: databasePaths.memory,
    approvalMode: 'delivery-or-headless',
    snapshotLimit: 10,
    snapshotMaxBytes: 4_096,
    snapshotMaxTokens: 1_024,
    defaultProposalTtlMs: 60_000,
  })
  return { ctx, service }
}

function addMemory(
  service: PersonalMemoryService,
  agent: Agent,
  opts: {
    idempotencyKey: string
    kind: 'fact' | 'experience' | 'preference' | 'instruction'
    trust: 'user-confirmed' | 'agent-observed'
    sensitivity?: 'private' | 'sensitive'
    content: string
  },
) {
  const proposal = service.propose(agent, {
    idempotencyKey: opts.idempotencyKey,
    principal: 'owner:lark:123',
    mutation: {
      op: 'add',
      identity: { owner: 'user', scope: 'user-global' },
      entry: {
        kind: opts.kind,
        content: opts.content,
        sensitivity: opts.sensitivity ?? 'private',
        trust: opts.trust,
        confidence: 0.9,
        provenance: { source: 'test', observedAt: 1_000 },
      },
    },
  })
  return service.decideProposal({
    proposalId: proposal.proposalId,
    principal: 'owner:lark:123',
    expectedVersion: proposal.version,
    decision: 'approved',
    reason: 'approve',
  })
}

describe('personal-memory association coordination', () => {
  test('standingOnly emits confirmed preferences/instructions on Step 1 even with empty session messages and suppresses keyword hits', async () => {
    let suppress = true
    const { ctx, service } = await setupService({
      shouldSuppressMemoryKeywordHits: () => suppress,
    })
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })

    addMemory(service, agent, {
      idempotencyKey: 'pref-1',
      kind: 'preference',
      trust: 'user-confirmed',
      content: 'Always write concise TypeScript responses',
    })
    addMemory(service, agent, {
      idempotencyKey: 'inst-1',
      kind: 'instruction',
      trust: 'user-confirmed',
      content: 'Never mutate production branches directly',
    })
    addMemory(service, agent, {
      idempotencyKey: 'fact-1',
      kind: 'fact',
      trust: 'agent-observed',
      content: 'Redis retry queue uses exponential backoff',
    })

    // Step 1: session has no derived user messages yet
    const step1Assembly = await ctx.get('systemPrompt')!.assemble({ agent })
    const step1Text = renderContextSnapshot(step1Assembly)
    expect(step1Text).toContain('Always write concise TypeScript responses')
    expect(step1Text).toContain('Never mutate production branches directly')
    expect(step1Text).not.toContain('Redis retry queue uses exponential backoff')

    // Step 2: session has a user message matching the fact; keyword hits remain suppressed when suppress === true
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Inspect Redis retry queue' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const step2Suppressed = renderContextSnapshot(await ctx.get('systemPrompt')!.assemble({ agent }))
    expect(step2Suppressed).toContain('Always write concise TypeScript responses')
    expect(step2Suppressed).not.toContain('Redis retry queue uses exponential backoff')

    // Fallback: when assistantAssociation returns false, full keyword hits resume
    suppress = false
    const step2Fallback = renderContextSnapshot(await ctx.get('systemPrompt')!.assemble({ agent }))
    expect(step2Fallback).toContain('Always write concise TypeScript responses')
    expect(step2Fallback).toContain('Redis retry queue uses exponential backoff')
  })

  test('falls back cleanly when assistantAssociation is absent or throws', async () => {
    const { ctx: absentCtx, service: absentService } = await setupService(undefined)
    const { agent: a1 } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    addMemory(absentService, a1, {
      idempotencyKey: 'fact-absent',
      kind: 'fact',
      trust: 'agent-observed',
      content: 'Cgroup freeze requires unified hierarchy',
    })
    a1.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Check cgroup freeze behavior' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const absentText = renderContextSnapshot(await absentCtx.get('systemPrompt')!.assemble({ agent: a1 }))
    expect(absentText).toContain('Cgroup freeze requires unified hierarchy')

    const { ctx: throwingCtx, service: throwingService } = await setupService({
      shouldSuppressMemoryKeywordHits: () => { throw new Error('association unavailable') },
    })
    const { agent: a2 } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    addMemory(throwingService, a2, {
      idempotencyKey: 'fact-throw',
      kind: 'fact',
      trust: 'agent-observed',
      content: 'Cgroup freeze requires unified hierarchy',
    })
    a2.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Check cgroup freeze behavior' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const throwingText = renderContextSnapshot(await throwingCtx.get('systemPrompt')!.assemble({ agent: a2 }))
    expect(throwingText).toContain('Cgroup freeze requires unified hierarchy')
  })

  test('post-commit onRecordChange and listActiveRecordsForAssociationSync track mutations and exclude sensitive/removed records', async () => {
    const { service } = await setupService()
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    const events: MemoryRecordChangeEvent[] = []
    const unsub = service.onRecordChange(event => events.push(event))

    const added = addMemory(service, agent, {
      idempotencyKey: 'sync-add-1',
      kind: 'fact',
      trust: 'user-confirmed',
      content: 'SQLite WAL requires 0600 permissions',
    })
    addMemory(service, agent, {
      idempotencyKey: 'sync-sensitive-1',
      kind: 'fact',
      trust: 'user-confirmed',
      sensitivity: 'sensitive',
      content: 'Secret token should stay out of association sync',
    })

    expect(events).toHaveLength(2)
    expect(events[0]?.op).toBe('add')
    expect(events[0]?.record.id).toBe(added.record!.id)
    expect(events[0]?.reason).toBe('mutation')
    expect(typeof events[0]?.auditSequence).toBe('number')

    // Replace and remove
    const replaceProp = service.propose(agent, {
      idempotencyKey: 'sync-replace-1',
      principal: 'owner:lark:123',
      mutation: {
        op: 'replace',
        identity: { owner: 'user', scope: 'user-global' },
        id: added.record!.id,
        expectedVersion: added.record!.version,
        entry: {
          kind: 'fact',
          content: 'SQLite WAL and SHM require 0600 permissions',
          sensitivity: 'private',
          trust: 'user-confirmed',
          confidence: 0.95,
          provenance: { source: 'test', observedAt: 2_000 },
        },
      },
    })
    const replaced = service.decideProposal({
      proposalId: replaceProp.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: replaceProp.version,
      decision: 'approved',
      reason: 'update',
    })
    expect(events).toHaveLength(3)
    expect(events[2]?.op).toBe('replace')
    expect(events[2]?.record.version).toBe(2)

    const digest = memoryPrincipalDigest('owner:lark:123')
    const syncList = service.listActiveRecordsForAssociationSync({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      namespace: {
        mode: 'delivery',
        principalDigest: digest,
        principalRecordId: 'unused',
        principalVersion: 1,
      },
    })
    // Headless test namespace above was headless, not delivery:
    expect(syncList).toHaveLength(0)

    const headlessSyncList = service.listActiveRecordsForAssociationSync({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      namespace: {
        mode: 'headless',
        principalDigest: digest,
        lineageId: `headless:${digest}`,
        lineageVersion: 1,
      },
    })
    expect(headlessSyncList).toHaveLength(1)
    expect(headlessSyncList[0]?.id).toBe(replaced.record!.id)
    expect(headlessSyncList[0]?.content).toBe('SQLite WAL and SHM require 0600 permissions')

    // Remove and verify remove event + empty sync list
    const removeProp = service.propose(agent, {
      idempotencyKey: 'sync-remove-1',
      principal: 'owner:lark:123',
      mutation: {
        op: 'remove',
        identity: { owner: 'user', scope: 'user-global' },
        id: replaced.record!.id,
        expectedVersion: replaced.record!.version,
      },
    })
    service.decideProposal({
      proposalId: removeProp.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: removeProp.version,
      decision: 'approved',
      reason: 'delete',
    })
    expect(events).toHaveLength(4)
    expect(events[3]?.op).toBe('remove')
    expect(events[3]?.record.status).toBe('removed')

    const afterRemove = service.listActiveRecordsForAssociationSync({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      namespace: {
        mode: 'headless',
        principalDigest: digest,
        lineageId: `headless:${digest}`,
        lineageVersion: 1,
      },
    })
    expect(afterRemove).toHaveLength(0)

    unsub()
  })

  test('MemoryStore onRecordChange does not emit on rolled-back or replayed mutations', async () => {
    const databasePaths = await paths()
    const store = new MemoryStore({ path: databasePaths.memory })
    const events: MemoryRecordChangeEvent[] = []
    const unsub = store.onRecordChange(event => events.push(event))
    const digest = memoryPrincipalDigest('owner:1')
    const namespace = {
      mode: 'headless' as const,
      principalDigest: digest,
      lineageId: `headless:${digest}`,
      lineageVersion: 1,
    }
    const identity = { owner: 'user' as const, scope: 'user-global' as const }

    const first = store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'idem-1',
      namespace,
      identity,
      entry: {
        kind: 'fact',
        content: 'First fact',
        sensitivity: 'private',
        trust: 'user-confirmed',
        confidence: 1,
        provenance: { source: 'test', observedAt: 10 },
      },
    })
    expect(events).toHaveLength(1)

    // Replay same idempotencyKey -> no new event
    const replay = store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'idem-1',
      namespace,
      identity,
      entry: {
        kind: 'fact',
        content: 'First fact',
        sensitivity: 'private',
        trust: 'user-confirmed',
        confidence: 1,
        provenance: { source: 'test', observedAt: 10 },
      },
    })
    expect(replay.id).toBe(first.id)
    expect(events).toHaveLength(1)

    // Duplicate content -> throws & rolls back -> no event
    expect(() => store.applyApprovedMutation({
      op: 'add',
      idempotencyKey: 'idem-2',
      namespace,
      identity,
      entry: {
        kind: 'fact',
        content: 'First fact',
        sensitivity: 'private',
        trust: 'user-confirmed',
        confidence: 1,
        provenance: { source: 'test', observedAt: 10 },
      },
    })).toThrow()
    expect(events).toHaveLength(1)

    unsub()
    store.close()
  })
})
