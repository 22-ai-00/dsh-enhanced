import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService, externalPrincipalId, ownerRouteAuthorityHash } from '@dsh-enhanced/assistant-delivery'
import { AssistantEvaluationService, EvaluationStore } from '@dsh-enhanced/assistant-evaluation'
import { growthObjectDigest, memoryLearningRequestDigest, type MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { PersonalMemoryService } from '@dsh-enhanced/personal-memory'
import { afterEach, expect, test, vi } from 'vitest'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { MemoryReviewRuntime, type MemoryReviewConfig } from '../../assistant-verifier/lib/memory-review.js'
import { SourceReviewStore } from '../../assistant-verifier/lib/source-review-store.js'
import { MemoryStore } from '../../personal-memory/lib/store.js'
import { MemoryLearningRuntime } from '../src/runtime.ts'
import type { LearningConfig, LearningJob } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(options: { verdict?: 'approved' | 'rejected' | 'unknown'; loseAdoptionAck?: boolean } = {}) {
  const verdict = options.verdict ?? 'approved'
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-learning-integration-')))
  const ctx = new Context()
  const deliveryPath = join(root, 'delivery.sqlite'), evaluationPath = join(root, 'evaluation.sqlite')
  const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
  const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
  const authority = { id: 'ordinary-owner', principal, conversation, workspace: root,
    agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
  const deliveryStore = new DeliveryStore({ path: deliveryPath, codeGenerator: () => 'PAIR1234' })
  const evaluationStore = new EvaluationStore({ path: evaluationPath })
  const issued = deliveryStore.issuePairing(principal, { ttlMs: 5000, maxAttempts: 3 })
  deliveryStore.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const principalRow = deliveryStore.getPrincipal(principal)!
  const owner = { authorityId: authority.id, authorityHash: ownerRouteAuthorityHash(authority),
    principalId: externalPrincipalId(principal), principalRecordId: principalRow.id,
    principalVersion: principalRow.version, workspace: root, agentPreset: 'primary' }
  const binding = deliveryStore.createBinding({ principal, conversation, workspace: root,
    agentPreset: 'primary', policyRef: 'owner-dm', sessionId: 'owner-session' })
  const reviewConfig: MemoryReviewConfig = { authorityId: 'review-grant', owner, expiresAt: Date.now() + 120_000,
    maxReviews: 8, policy: 'Review only exact owner statements.', maxInputBytes: 8192,
    maxOutputTokens: 256, timeoutMs: 1000 }
  const adoptionGrant = { authorityId: 'adoption-grant', owner, reviewAuthorityId: reviewConfig.authorityId,
    reviewAuthorityDigest: growthObjectDigest(reviewConfig), expiresAt: Date.now() + 120_000,
    maxMutations: 8, maxTotalContentBytes: 8192, maxRecordTtlMs: 120_000,
    kinds: ['fact', 'experience'] as const, operations: ['add', 'replace', 'remove'] as const }
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'),
    budgets: ['learning-budget', 'scan-budget'].map(id => ({ id, metric: 'automation-runs', limit: 20,
      periodMs: 60_000, scope: 'subject' as const })), rules: [
    ...(['extract', 'review', 'adopt'] as const).map(action => ({ id: `learning-${action}`, effect: 'allow' as const,
      subject: { kind: 'background' as const, id: 'assistant-memory-learning', workspace: root, principal: owner.principalId },
      actions: [action], resource: { kind: 'memory' as const, id: `learning:${action === 'review' ? reviewConfig.authorityId : action === 'adopt' ? adoptionGrant.authorityId : 'producer-grant'}` },
      context: { initiators: ['background' as const] } })),
    { id: 'automation-reconcile', effect: 'allow', subject: { kind: 'background', id: 'assistant-memory-learning', workspace: root,
      principal: owner.principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'automation-execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root,
      principal: owner.principalId }, actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'memory-read', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root },
      actions: ['search', 'read', 'export', 'snapshot'], resource: { kind: 'memory', id: '*' }, context: { initiators: ['foreground'] } },
  ] })
  new SystemPrompt(ctx, {})
  await ctx.plugin(AssistantDeliveryService, { databasePath: deliveryPath, spoolPath: join(root, 'spool'),
    schedulerEnabled: false, ownerRoutes: [authority] })
  let evaluationFiber = await ctx.plugin(AssistantEvaluationService, { databasePath: evaluationPath, projectionIntervalMs: 0 })
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
    schedulerEnabled: false, reconcileIntervalMs: 0 })
  const reviewer = new MemoryReviewRuntime(ctx, reviewConfig, join(root, 'verifier.sqlite'))
  const reviewLedger = new SourceReviewStore(join(root, 'verifier.sqlite.memory-reviews'))
  const reviewCalls = vi.fn(async (request: MemoryLearningReviewRequest) => {
    const model = { provider: 'frozen-provider', model: 'frozen-model', reasoningEffort: 'high' }
    const requestDigest = memoryLearningRequestDigest(request)
    reviewLedger.claim({ operationId: request.operationId, requestDigest, authorityId: reviewConfig.authorityId,
      authorityDigest: growthObjectDigest(reviewConfig), maxReviews: reviewConfig.maxReviews, model })
    if (verdict !== 'unknown') reviewLedger.finish(request.operationId, requestDigest,
      { status: verdict, reason: 'Independent fixture decision.', outputDigest: 'e'.repeat(64) })
    return reviewer.run(request)
  })
  const verifierPort = { inspectMemoryLearningReviewAvailability: (input: { owner: typeof owner }) => reviewer.inspectAvailability(input),
    reviewMemoryLearning: reviewCalls, lookupMemoryLearningReview: (request: MemoryLearningReviewRequest) => reviewer.lookup(request) }
  ctx.provide('assistantVerifier', verifierPort as never)
  await ctx.plugin(PersonalMemoryService, { databasePath: join(root, 'memory.sqlite'), automaticLearning: adoptionGrant,
    toolEvidence: false, reconcileIntervalMs: 0 })
  const config: LearningConfig = { databasePath: join(root, 'learning.sqlite'), authorityId: 'producer-grant', owner,
    expiresAt: Date.now() + 120_000, maxExtractions: 8, maxPending: 20, lookbackMs: 60_000,
    policy: 'Learn exact owner facts.', maxInputBytes: 8192, maxOutputTokens: 256, timeoutMs: 5000,
    budgetId: 'learning-budget', budgetAmount: 1, scanBudgetId: 'scan-budget', scanBudgetAmount: 1,
    reviewAuthorityId: reviewConfig.authorityId, reviewAuthorityDigest: growthObjectDigest(reviewConfig),
    adoptionAuthorityId: adoptionGrant.authorityId, adoptionGrantDigest: growthObjectDigest(adoptionGrant) }
  const extract = vi.fn(async ({ job }: { job: LearningJob }) => ({
    proposal: job.intent.kind === 'fact' && !job.snapshot?.ownerStatement.includes('Atlas uses pnpm') ? null
      : { mutation: { op: 'add' as const, entry: { kind: job.intent.kind, content: job.intent.kind === 'fact'
        ? 'Atlas uses pnpm for this workspace.' : 'When dependency updates fail, inspect the pnpm lockfile.' } },
      evidenceQuote: job.intent.kind === 'fact' ? 'Atlas uses pnpm' : 'dependency updates fail' },
    reason: 'Fixture extraction from owner text.', sessionId: `extract-${job.id}`,
    outputDigest: 'd'.repeat(64),
  }))
  let adoptCalls = 0
  const memoryPort = { listLearningTargets: (input: { owner: typeof owner; limit?: number }) => ctx.personalMemory.listLearningTargets(input),
    inspectLearningAdoptionAvailability: (input: { owner: typeof owner }) => ctx.personalMemory.inspectLearningAdoptionAvailability(input),
    lookupLearningAdoption: (input: { request: MemoryLearningReviewRequest }) => ctx.personalMemory.lookupLearningAdoption(input),
    adoptReviewedLearning: (input: { request: MemoryLearningReviewRequest }) => {
      adoptCalls += 1
      const receipt = ctx.personalMemory.adoptReviewedLearning(input)
      if (options.loseAdoptionAck && adoptCalls === 1) throw new Error('fixture: durable adoption ACK lost')
      return receipt
    } }
  const runtime = new MemoryLearningRuntime(config, { delivery: ctx.assistantDelivery, evaluation: ctx.assistantEvaluation,
    automations: ctx.assistantAutomations, memory: memoryPort, verifier: verifierPort,
    policy: ctx.assistantPolicy, extract })
  const id = SessionId('owner-session'), session = Session.create(id, [], { version: SESSION_FORMAT_VERSION,
    id, createdAt: Date.now(), isSeeded: false, cwd: root, agentPreset: 'primary' })
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'What package manager does Atlas use?' }] }), { surfaceOp: 'append' })
  const agent: Agent = { id, session, options: {}, inbox: createInboxStub(), ctx, status: 'idle',
    cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {} }
  cleanups.push(async () => { await runtime.close(); await reviewer.close(); reviewLedger.close();
    await ctx.fiber.restart(); deliveryStore.close(); evaluationStore.close(); await rm(root, { recursive: true, force: true }) })
  function source(text = 'Atlas uses pnpm for this workspace.') {
    const eventId = `task-${Math.random().toString(36).slice(2)}`
    const admitted = deliveryStore.claimNativeInbox({ envelope: { channel: principal.channel, account: principal.account,
      eventId, occurredAt: Date.now(), principal, conversation, kind: 'text', text }, binding,
    ownerLineage: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
    ownerId: 'native-worker', leaseMs: 100_000 })
    deliveryStore.bindForegroundTaskExecution({ inboxId: admitted.record.id,
      scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: owner.principalRecordId,
        principalVersion: owner.principalVersion }, binding, dispatchedAt: Date.now() })
    deliveryStore.recordForegroundExecutionModelSelection({ inboxId: admitted.record.id,
      provider: 'frozen-provider', model: 'frozen-model', reasoningEffort: 'high' })
    const outbox = deliveryStore.enqueue({ idempotencyKey: `inbound:${admitted.record.id}:reply`, bindingId: binding.id,
      target: { principal, conversation }, text: 'Understood.', format: 'plain', replyToEventId: eventId })
    deliveryStore.finishForegroundTaskExecution({ inboxId: admitted.record.id, status: 'succeeded',
      quiescent: true, completedAt: Date.now() })
    deliveryStore.finishInbox({ inboxId: admitted.record.id, ownerId: 'native-worker',
      fencingToken: admitted.fencingToken!, outcome: 'processed' })
    return { inboxId: admitted.record.id, outbox }
  }
  function feedback(sourceRef: ReturnType<typeof source>, status: 'achieved' | 'not-achieved' | 'unknown' = 'achieved',
    action: 'initial' | 'withdraw' = 'initial', previous?: { version: number; status: 'achieved' | 'not-achieved' }) {
    const writer = new DatabaseSync(deliveryPath)
    try { writer.prepare("UPDATE outbox_messages SET status = 'accepted' WHERE id = ?").run(sourceRef.outbox.id) }
    finally { writer.close() }
    const scope = { workspace: root, preset: 'primary' }
    return evaluationStore.append({ scope, situation: `foreground:${sourceRef.inboxId}`,
      executionStatus: 'succeeded', objectiveStatus: status, deliveryStatus: 'delivered',
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' }, trust: 'trusted',
      evidence: [{ kind: 'foreground-turn', ref: sourceRef.inboxId }, { kind: 'delivery-outbox', ref: sourceRef.outbox.id }],
      metrics: {}, occurredAt: Date.now(), idempotencyKey: `feedback-${action}-${sourceRef.inboxId}`,
      evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' } }, {
      principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion,
      action, operationId: `feedback-op-${action}-${sourceRef.inboxId}`,
      ...(previous === undefined ? {} : { expectedVersion: previous.version, previousStatus: previous.status }),
    })
  }
  async function run(afterStart?: () => void) {
    runtime.start()
    afterStart?.()
    await new Promise(resolve => setTimeout(resolve, 1150))
    const observations: Array<ReturnType<typeof runtime.health>['counts']> = []
    for (let attempt = 0; attempt < 3; attempt++) {
      await ctx.assistantAutomations.tick()
      await ctx.assistantAutomations.whenIdle()
      const counts = runtime.health().counts
      observations.push(counts)
      if (counts.pending + counts.queued + counts.running === 0) return observations
    }
    throw new Error(`memory learning did not drain after three native ticks: ${JSON.stringify(observations)}`)
  }
  return { root, ctx, owner, authority, principal, binding, deliveryStore, evaluationStore,
    runtime, source, feedback, run, agent, extract, reviewCalls, reviewer, reviewLedger,
    get adoptCalls() { return adoptCalls },
    unloadEvaluation: async () => { await evaluationFiber.dispose() },
    restoreEvaluation: async () => { evaluationFiber = await ctx.plugin(AssistantEvaluationService,
      { databasePath: evaluationPath, projectionIntervalMs: 0 }) } }
}

test.each([
  { timing: 'within one minute', offset: 10_000, scanRuns: 0 },
  { timing: 'across a minute boundary', offset: 59_800, scanRuns: 1 },
])('ordinary source flows through native Automations and independent review ledger into later Memory prompt $timing', async ({ offset, scanRuns }) => {
  const minute = Math.floor(Date.now() / 60_000) * 60_000
  let now = minute + offset
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const f = await fixture()
  const deliveryWriter = new DatabaseSync(join(f.root, 'delivery.sqlite'))
  const evaluationWriter = new DatabaseSync(join(f.root, 'evaluation.sqlite'))
  deliveryWriter.exec('PRAGMA busy_timeout=0'); evaluationWriter.exec('PRAGMA busy_timeout=0')
  const apply = MemoryStore.prototype.applyLearningAdoption
  const commit = vi.spyOn(MemoryStore.prototype, 'applyLearningAdoption').mockImplementation(function (this: MemoryStore, input) {
    expect(() => deliveryWriter.exec('BEGIN IMMEDIATE')).toThrow(/locked/u)
    expect(() => evaluationWriter.exec('BEGIN IMMEDIATE')).toThrow(/locked/u)
    return apply.call(this, input)
  })
  const source = f.source()
  try { await f.run(() => { now += 1200 }) } finally { deliveryWriter.close(); evaluationWriter.close() }
  expect(commit).toHaveBeenCalledOnce()
  expect(f.runtime.health().counts.adopted).toBe(1)
  expect(f.extract).toHaveBeenCalledOnce()
  const learningId = f.extract.mock.calls[0]![0].job.id
  const scanId = `memory-scan-${growthObjectDigest(['producer-grant', f.owner])}`
  const policyRead = new DatabaseSync(join(f.root, 'policy.sqlite'), { readOnly: true })
  try {
    const reservations = policyRead.prepare("SELECT scope,status,metric,amount,actual_amount FROM budget_reservations WHERE metric = 'automation-runs'").all()
    const settled = { status: 'finalized', metric: 'automation-runs', amount: 1, actual_amount: 1 }
    // A due native cron scan spends its own budget without repeating learning.
    const expected = [{ scope: `background:${learningId}`, ...settled },
      ...(scanRuns === 0 ? [] : [{ scope: `background:${scanId}`, ...settled }])]
    expect(reservations).toHaveLength(expected.length)
    expect(reservations).toEqual(expect.arrayContaining(expected))
  }
  finally { policyRead.close() }
  expect(f.reviewCalls).toHaveBeenCalledOnce()
  const hits = f.ctx.personalMemory.search(f.agent, { query: 'Atlas pnpm' })
  expect(hits).toHaveLength(1)
  expect(hits[0]!.record.content).toContain('Atlas uses pnpm')
  expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent: f.agent }))).toContain('Atlas uses pnpm')
  const initial = f.feedback(source)
  f.feedback(source, 'unknown', 'withdraw', { version: 1, status: 'achieved' })
  expect(initial.id).toBeTruthy()
  expect(f.ctx.personalMemory.search(f.agent, { query: 'Atlas pnpm' })).toEqual([])
  expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent: f.agent }))).not.toContain('Atlas uses pnpm for this workspace.')
})

test.each(['rejected', 'unknown'] as const)('independent %s review cannot adopt a learned fact', async verdict => {
  const f = await fixture({ verdict })
  f.source()
  await f.run()
  expect(f.extract).toHaveBeenCalledOnce()
  expect(f.reviewCalls).toHaveBeenCalledOnce()
  expect(f.adoptCalls).toBe(0)
  expect(f.ctx.personalMemory.search(f.agent, { query: 'Atlas pnpm' })).toEqual([])
  expect(f.runtime.health().counts[verdict]).toBe(1)
  f.runtime.scan()
  expect(f.extract).toHaveBeenCalledOnce()
  expect(f.reviewCalls).toHaveBeenCalledOnce()
})

test('minute-boundary scan leaves the learning job queued until the next native tick', async () => {
  const minute = Math.floor(Date.now() / 60_000) * 60_000
  let now = minute + 59_800
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const f = await fixture({ verdict: 'unknown' })
  f.source()
  const observations = await f.run(() => { now = minute + 61_000 })
  expect(observations.map(counts => ({ queued: counts.queued, unknown: counts.unknown })))
    .toEqual([{ queued: 1, unknown: 0 }, { queued: 0, unknown: 1 }])
  expect(f.extract).toHaveBeenCalledOnce()
  expect(f.reviewCalls).toHaveBeenCalledOnce()
  expect(f.adoptCalls).toBe(0)
  expect(f.ctx.personalMemory.search(f.agent, { query: 'Atlas pnpm' })).toEqual([])
  expect(f.runtime.health().counts.unknown).toBe(1)
})

test('lost adoption acknowledgement reconciles the exact durable receipt without replaying extraction or review', async () => {
  const f = await fixture({ loseAdoptionAck: true })
  f.source()
  await f.run()
  f.runtime.scan()
  expect(f.runtime.health().counts.adopted).toBe(1)
  expect(f.ctx.personalMemory.search(f.agent, { query: 'Atlas pnpm' })).toHaveLength(1)
  expect(f.extract).toHaveBeenCalledOnce()
  expect(f.reviewCalls).toHaveBeenCalledOnce()
  expect(f.adoptCalls).toBe(1)
})

test('temporary Evaluation unload hides adopted memory and restore revalidates the original source', async () => {
  const f = await fixture()
  f.source()
  await f.run()
  expect(f.ctx.personalMemory.search(f.agent, { query: 'Atlas pnpm' })).toHaveLength(1)
  await f.unloadEvaluation()
  expect(f.ctx.personalMemory.search(f.agent, { query: 'Atlas pnpm' })).toEqual([])
  await f.restoreEvaluation()
  expect(f.ctx.personalMemory.search(f.agent, { query: 'Atlas pnpm' })).toHaveLength(1)
})

test('late canonical owner feedback supersedes a pending fact with an experience from the exact inbox', async () => {
  const f = await fixture()
  const source = f.source('When dependency updates fail, inspect the pnpm lockfile.')
  const initial = f.feedback(source, 'achieved')
  expect(f.ctx.assistantDelivery.inspectOwnerForegroundLearningTask({ authorityId: f.owner.authorityId,
    principalId: f.owner.principalId, workspace: f.root, agentPreset: 'primary', outcomeId: initial.id }))
    .toMatchObject({ judgement: 'owner-feedback', source: { inboxId: source.inboxId, quiescent: true } })
  await f.run()
  await new Promise(resolve => setTimeout(resolve, 50))
  await f.ctx.assistantAutomations.tick()
  await f.ctx.assistantAutomations.whenIdle()
  expect(f.runtime.health().counts.adopted).toBe(1)
  expect(f.extract.mock.calls.map(([input]) => input.job.intent.kind)).toContain('experience')
  expect(f.ctx.personalMemory.search(f.agent, { query: 'dependency updates pnpm lockfile' }).map(hit => hit.record.kind))
    .toEqual(['experience'])
})
