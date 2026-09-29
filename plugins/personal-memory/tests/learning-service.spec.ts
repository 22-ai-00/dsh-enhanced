import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { growthObjectDigest, memoryLearningRequestDigest, type MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { PersonalMemoryService } from '../src/service.ts'
import type { MemoryLearningAdoptionGrant, MemoryLearningReviewReceipt } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// Real Cordis, Policy, Memory and native prompt assembly; source/reviewer ports
// are explicit doubles. The companion integration suite uses real producers.
async function fixture(options: { prompt?: boolean; allowAdoption?: boolean; task?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'memory-learning-service-')), ctx = new Context()
  const owner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'lark/app/tenant/owner',
    principalRecordId: 'owner-row', principalVersion: 1, workspace: root, agentPreset: 'assistant' }
  const grant: MemoryLearningAdoptionGrant = { authorityId: 'adoption-grant', owner, reviewAuthorityId: 'review-grant',
    reviewAuthorityDigest: 'e'.repeat(64), expiresAt: Date.now() + 60_000, maxMutations: 10,
    maxTotalContentBytes: 4096, maxRecordTtlMs: 60_000, kinds: ['fact', 'experience'], operations: ['add', 'replace', 'remove'] }
  const request: MemoryLearningReviewRequest = { protocol: 'memory-learning-review/v1', operationId: 'op-1',
    extractionSessionId: 'extract-1', owner, source: { inboxId: 'inbox-1', sourceDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) },
    mutation: { op: 'add', entry: { kind: 'fact', content: 'Owner says Atlas uses pnpm.' } }, evidenceQuote: 'Atlas uses pnpm.' }
  const state = { withdrawn: false, unavailable: false, ownerCurrent: true, review: 'approved' as MemoryLearningReviewReceipt['status'] }
  const content = { sourceDigest: request.source.sourceDigest, contentDigest: request.source.contentDigest,
    source: { execution: { modelSelection: { provider: 'supplier', model: 'source-model' }, completedAt: Date.now() } },
    input: { text: 'Atlas uses pnpm.', truncated: false }, reply: { text: 'Understood.', truncated: false } }
  let locked = false
  const delivery = {
    preferencePrincipalForAgent: (agent: Agent) => state.ownerCurrent ? { scope: { workspace: root, preset: 'assistant' },
      principalId: owner.principalId, principalLineage: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
      bindingId: 'binding-1', bindingVersion: 1, bindingGeneration: 1, sessionId: String(agent.id) } : undefined,
    withOwnerForegroundTaskSourcesFence: vi.fn((input: { sources: readonly unknown[] }, callback: (contents: unknown[]) => unknown) => {
      if (!state.ownerCurrent || state.unavailable) throw new Error('source unavailable')
      expect(locked).toBe(false); locked = true
      try { return callback(input.sources.map(() => content)) } finally { locked = false }
    }),
    inspectOwnerForegroundLearningTask: vi.fn(() => undefined),
  }
  const evaluation = { canonicalHostScope: (scope: unknown) => scope,
    listTrustedTaskLearningProjections: () => ({ scopeWatermark: 0 }),
    getTrustedForegroundLearningProjection: () => state.withdrawn ? { triggerOutcomeId: 'outcome-1' } : undefined,
    inspectTrustedTaskOwnerRevision: () => state.withdrawn ? { action: 'withdraw' } : undefined,
    withTrustedCanonicalScopeWriterFence: (_input: unknown, callback: () => unknown) => {
      expect(locked).toBe(true); return { matched: true, value: callback() }
    } }
  const reviewer = { lookupMemoryLearningReview: vi.fn((input: MemoryLearningReviewRequest) => {
    expect(locked).toBe(false)
    const body = { protocol: 'memory-learning-review-receipt/v1' as const, operationId: input.operationId,
      requestDigest: memoryLearningRequestDigest(input), authorityId: grant.reviewAuthorityId, authorityDigest: grant.reviewAuthorityDigest,
      sessionId: 'independent-review', model: { provider: 'supplier', model: 'source-model' }, status: state.review,
      reason: 'Supported owner statement.', outputDigest: 'd'.repeat(64) }
    return { ...body, receiptDigest: growthObjectDigest(body) }
  }) }
  new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'read-memory', effect: 'allow', subject: { kind: 'agent', id: 'assistant', workspace: root },
      actions: ['search', 'read', 'export', 'snapshot'], resource: { kind: 'memory', id: '*' }, context: { initiators: ['foreground'] } },
    ...(options.allowAdoption === false ? [] : [{ id: 'adopt-memory', effect: 'allow' as const,
      subject: { kind: 'background' as const, id: 'assistant-memory-learning', workspace: root, principal: owner.principalId },
      actions: ['adopt'], resource: { kind: 'memory' as const, id: `learning:${grant.authorityId}` }, context: { initiators: ['background' as const] } }]),
  ] })
  ctx.provide('assistantDelivery', delivery as never)
  ctx.provide('assistantEvaluation', evaluation as never)
  ctx.provide('assistantVerifier', reviewer as never)
  if (options.prompt !== false) new SystemPrompt(ctx, {})
  const service = new PersonalMemoryService(ctx, { databasePath: join(root, 'memory.sqlite'), automaticLearning: grant,
    reconcileIntervalMs: 0, toolEvidence: false })
  const id = SessionId('memory-learning-session'), session = Session.create(id, [], { version: SESSION_FORMAT_VERSION,
    id, createdAt: Date.now(), isSeeded: false, cwd: root, agentPreset: 'assistant' })
  if (options.task !== false) session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Atlas package manager' }] }), { surfaceOp: 'append' })
  const injections: UserMessage[] = []
  const agent: Agent = { id, session, options: {}, inbox: createInboxStub(), ctx, status: 'idle',
    cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {},
    inject: message => { injections.push(message) } }
  const render = async () => renderContextSnapshot(await ctx.systemPrompt.assemble({ agent }))
  cleanups.push(async () => { await ctx.fiber.restart(); await rm(root, { recursive: true, force: true }) })
  return { ctx, owner, grant, request, state, service, agent, reviewer, render, injections }
}

test('adopted facts reach fresh native prompt snapshots; temporary failure hides and withdrawal removes them', async () => {
  const f = await fixture(), adopted = f.service.adoptReviewedLearning({ request: f.request })
  expect(f.service.search(f.agent, { query: 'Atlas' }).map(hit => hit.record.id)).toEqual([adopted.record.id])
  expect(f.service.read(f.agent, { ids: [adopted.record.id] })[0]?.content).toBe(adopted.record.content)
  expect(f.service.exportJson(f.agent)).toContain('Atlas uses pnpm')
  expect(await f.render()).toContain('Atlas uses pnpm')
  f.state.unavailable = true
  expect(f.service.search(f.agent, { query: 'Atlas' })).toEqual([])
  expect(f.service.exportJson(f.agent)).not.toContain('Atlas uses pnpm')
  expect(await f.render()).not.toContain('Atlas uses pnpm')
  f.state.unavailable = false
  expect(await f.render()).toContain('Atlas uses pnpm')
  f.state.withdrawn = true
  expect(await f.render()).not.toContain('Atlas uses pnpm')
  expect(f.service.search(f.agent, { query: 'Atlas' })).toEqual([])
  expect(() => f.service.read(f.agent, { ids: [adopted.record.id] })).toThrow('not found')
  expect(f.service.inspectLearningTarget({ owner: f.owner, id: adopted.record.id, expectedVersion: adopted.record.version })).toBeUndefined()
  // A lost-ACK receipt is historical and immutable, including after withdrawal.
  expect(f.service.adoptReviewedLearning({ request: f.request })).toEqual(adopted)
  expect(f.reviewer.lookupMemoryLearningReview).toHaveBeenCalledTimes(1)
})

test('automatic memory never enters the permanent session-start fallback', async () => {
  const f = await fixture({ prompt: false })
  f.service.adoptReviewedLearning({ request: f.request })
  expect(f.service.search(f.agent, { query: 'Atlas' })).toHaveLength(1)
  agentEvents(f.ctx, f.agent).emit('agent/session-start', { source: 'startup' })
  expect(f.injections).toEqual([])
})

test('a taskless dynamic snapshot does not automatically inject learned facts', async () => {
  const f = await fixture({ task: false })
  f.service.adoptReviewedLearning({ request: f.request })
  expect(f.service.search(f.agent, { query: 'Atlas' })).toHaveLength(1)
  expect(await f.render()).not.toContain('Atlas uses pnpm')
})

test.each(['unknown', 'rejected'] as const)('cannot adopt a %s review using caller approval fields', async status => {
  const f = await fixture(); f.state.review = status
  expect(() => f.service.adoptReviewedLearning({ request: f.request, approved: true } as never)).toThrow('independent approval')
  expect(f.service.search(f.agent, { query: 'Atlas' })).toEqual([])
})

test('current owner and Policy remain required; stored review alone gives no mutation authority', async () => {
  const f = await fixture({ allowAdoption: false })
  expect(() => f.service.adoptReviewedLearning({ request: f.request })).toThrow('policy denied')
  expect(f.reviewer.lookupMemoryLearningReview).not.toHaveBeenCalled()
  const allowed = await fixture(), adopted = allowed.service.adoptReviewedLearning({ request: allowed.request })
  allowed.state.ownerCurrent = false
  expect(await allowed.render()).not.toContain('Atlas uses pnpm')
  expect(() => allowed.service.lookupLearningAdoption({ request: allowed.request })).toThrow('source unavailable')
  expect(() => allowed.service.adoptReviewedLearning({ request: { ...allowed.request,
    operationId: 'op-other-owner', owner: { ...allowed.owner, principalVersion: 2 },
    mutation: { op: 'remove', id: adopted.record.id, expectedVersion: 1 } } })).toThrow('owner changed')
})

test('the mounted Config validates adoption bounds before acquiring a database', async () => {
  const f = await fixture()
  const result = PersonalMemoryService.Config['~standard'].validate({ databasePath: '/unused/memory.sqlite',
    automaticLearning: { ...f.grant, maxMutations: 0 } })
  expect(result).not.toBeInstanceOf(Promise)
  expect(result).toHaveProperty('issues')
  expect(PersonalMemoryService.inject).toEqual(['assistantPolicy'])
})
