import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantDeliveryService, externalPrincipalId, ownerRouteAuthorityHash } from '@dsh-enhanced/assistant-delivery'
import { AssistantEvaluationService, EvaluationStore } from '@dsh-enhanced/assistant-evaluation'
import { growthObjectDigest, memoryLearningRequestDigest, type MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { MemoryReviewRuntime, type MemoryReviewConfig } from '../../assistant-verifier/lib/memory-review.js'
import { SourceReviewStore } from '../../assistant-verifier/lib/source-review-store.js'
import { PersonalMemoryService } from '../src/service.ts'
import { MemoryStore, memoryPrincipalDigest } from '../src/store.ts'
import type { MemoryLearningAdoptionGrant, MemoryLearningReviewReceipt } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
const stores = new Set<{ close(): void }>()

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const store of stores) store.close()
  stores.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function reviewReceipt(request: MemoryLearningReviewRequest, grant: MemoryLearningAdoptionGrant,
  status: 'approved' | 'rejected' | 'unknown' = 'approved'): MemoryLearningReviewReceipt {
  const body = { protocol: 'memory-learning-review-receipt/v1' as const, operationId: request.operationId,
    requestDigest: memoryLearningRequestDigest(request), authorityId: grant.reviewAuthorityId,
    authorityDigest: grant.reviewAuthorityDigest, sessionId: `review:${request.operationId}`,
    model: { provider: 'test-provider', model: 'test-model' }, status, reason: 'Fixture review decision.',
    outputDigest: 'e'.repeat(64) }
  return { ...body, receiptDigest: growthObjectDigest(body) }
}

function agentFor(sessionId: string, workspace: string, preset: string): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    isSeeded: false, cwd: workspace, agentPreset: preset })
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'pnpm project' }] }), { surfaceOp: 'append' })
  return { id, options: {}, session, inbox: createInboxStub(), ctx: new Context(), status: 'idle',
    cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {} }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-learning-integration-'))
  roots.push(root)
  const deliveryPath = join(root, 'delivery.sqlite'), evaluationPath = join(root, 'evaluation.sqlite')
  const memoryPath = join(root, 'memory.sqlite')
  const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
  const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
  const authority = { id: 'learning-owner', principal, conversation, workspace: root,
    agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
  const deliveryStore = new DeliveryStore({ path: deliveryPath, codeGenerator: () => 'PAIR1234' })
  const evaluationStore = new EvaluationStore({ path: evaluationPath })
  stores.add(deliveryStore); stores.add(evaluationStore)
  const pairing = deliveryStore.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  deliveryStore.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  const principalRow = deliveryStore.getPrincipal(principal)!
  const owner = { authorityId: authority.id, authorityHash: ownerRouteAuthorityHash(authority),
    principalId: externalPrincipalId(principal), principalRecordId: principalRow.id,
    principalVersion: principalRow.version, workspace: root, agentPreset: authority.agentPreset }
  const reviewConfig: MemoryReviewConfig = { authorityId: 'review-authority', owner,
    expiresAt: Date.now() + 60_000, maxReviews: 10, policy: 'Review exact owner statements.',
    maxInputBytes: 32_768, maxOutputTokens: 512, timeoutMs: 10_000 }
  const binding = deliveryStore.createBinding({ principal, conversation, workspace: root,
    agentPreset: authority.agentPreset, policyRef: authority.policyRef, sessionId: 'owner-session' })
  const grant: MemoryLearningAdoptionGrant = { authorityId: authority.id, owner,
    reviewAuthorityId: reviewConfig.authorityId, reviewAuthorityDigest: growthObjectDigest(reviewConfig),
    expiresAt: Date.now() + 60_000, maxMutations: 10, maxTotalContentBytes: 10_000,
    maxRecordTtlMs: 60_000, kinds: ['fact', 'experience'], operations: ['add', 'replace', 'remove'] }
  const ctx = new Context(); contexts.push(ctx)
  new SystemPrompt(ctx, {})
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'learning-adopt', effect: 'allow', subject: { kind: 'background', id: 'assistant-memory-learning',
      workspace: root, principal: owner.principalId }, actions: ['adopt'],
    resource: { kind: 'memory', id: `learning:${authority.id}` }, context: { initiators: ['background'] } },
    { id: 'learning-review', effect: 'allow', subject: { kind: 'background', id: 'assistant-memory-learning',
      workspace: root, principal: owner.principalId }, actions: ['review'],
    resource: { kind: 'memory', id: `learning:${reviewConfig.authorityId}` }, context: { initiators: ['background'] } },
    { id: 'learning-read', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root },
      actions: ['read', 'search', 'export', 'snapshot'], resource: { kind: 'memory', id: '*' },
      context: { initiators: ['foreground'] } },
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: deliveryPath, spoolPath: join(root, 'spool'),
    schedulerEnabled: false, ownerRoutes: [authority] })
  let evaluationPlugin = await ctx.plugin(AssistantEvaluationService, { databasePath: evaluationPath, projectionIntervalMs: 0 })
  const otherDelivery = new DatabaseSync(deliveryPath), otherEvaluation = new DatabaseSync(evaluationPath)
  otherDelivery.exec('PRAGMA busy_timeout = 1'); otherEvaluation.exec('PRAGMA busy_timeout = 1')
  stores.add(otherDelivery); stores.add(otherEvaluation)
  let reviewStatus: 'approved' | 'rejected' | 'unknown' = 'approved'
  let realReviewer: MemoryReviewRuntime | undefined
  const lookup = vi.fn((request: MemoryLearningReviewRequest) => {
    // Verifier.lookup acquires its own producer fences; adoption must call it
    // before entering the outer Delivery/Evaluation transaction.
    otherDelivery.exec('BEGIN IMMEDIATE; ROLLBACK')
    otherEvaluation.exec('BEGIN IMMEDIATE; ROLLBACK')
    if (realReviewer) return realReviewer.lookup(request)
    return reviewReceipt(request, grant, reviewStatus)
  })
  // Only the independent review verdict is simulated. The source, owner and
  // canonical task state all come from the real producer services and stores.
  ctx.provide('assistantVerifier', { lookupMemoryLearningReview: lookup } as never)
  await ctx.plugin(PersonalMemoryService, { databasePath: memoryPath, automaticLearning: grant,
    toolEvidence: false, reconcileIntervalMs: 0 })
  const memoryStore = new MemoryStore({ path: memoryPath }); stores.add(memoryStore)
  const agent = agentFor(binding.sessionId, root, authority.agentPreset)
  const namespace = { mode: 'delivery' as const, principalDigest: memoryPrincipalDigest(owner.principalId),
    principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion }
  const context = { workspace: root, agentPreset: authority.agentPreset, namespace }
  let sourceIndex = 0
  function source(text = 'This pnpm project uses a lockfile.') {
    const eventId = `event-${++sourceIndex}`
    const admitted = deliveryStore.claimNativeInbox({ envelope: { channel: principal.channel,
      account: principal.account, eventId, occurredAt: Date.now(), principal, conversation,
      kind: 'text', text }, binding, ownerLineage: { principalRecordId: owner.principalRecordId,
      principalVersion: owner.principalVersion }, ownerId: 'native-worker', leaseMs: 100_000 })
    deliveryStore.bindForegroundTaskExecution({ inboxId: admitted.record.id,
      scope: { workspace: root, preset: authority.agentPreset }, owner: {
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
      binding, dispatchedAt: Date.now() })
    deliveryStore.recordForegroundExecutionModelSelection({ inboxId: admitted.record.id,
      provider: 'task-provider', model: 'task-model' })
    const outbox = deliveryStore.enqueue({ idempotencyKey: `inbound:${admitted.record.id}:reply`,
      bindingId: binding.id, target: { principal, conversation }, text: 'Acknowledged.',
      format: 'plain', replyToEventId: eventId })
    deliveryStore.finishForegroundTaskExecution({ inboxId: admitted.record.id,
      status: 'succeeded', quiescent: true, completedAt: Date.now() })
    deliveryStore.finishInbox({ inboxId: admitted.record.id, ownerId: 'native-worker',
      fencingToken: admitted.fencingToken!, outcome: 'processed' })
    const scope = { authorityId: authority.id, principalId: owner.principalId, workspace: root,
      agentPreset: authority.agentPreset, expectedOwner: { authorityHash: owner.authorityHash,
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion } }
    const metadata = deliveryStore.listOwnerForegroundTaskSources(scope, authority).items.find(item => item.inboxId === admitted.record.id)!
    const content = deliveryStore.readOwnerForegroundTaskSource({ ...scope, inboxId: metadata.inboxId,
      expectedSourceDigest: metadata.sourceDigest }, authority)!
    return { inboxId: metadata.inboxId, sourceDigest: metadata.sourceDigest,
      contentDigest: content.contentDigest, outbox, eventId }
  }
  function request(sourceRef: ReturnType<typeof source>, operationId: string,
    mutation: MemoryLearningReviewRequest['mutation'] = { op: 'add',
      entry: { kind: 'fact', content: 'This pnpm project uses a lockfile.' } }): MemoryLearningReviewRequest {
    return { protocol: 'memory-learning-review/v1', operationId, extractionSessionId: 'extraction:1',
      owner, source: { inboxId: sourceRef.inboxId, sourceDigest: sourceRef.sourceDigest,
        contentDigest: sourceRef.contentDigest }, mutation, evidenceQuote: 'This pnpm project uses a lockfile.' }
  }
  return { root, memoryPath, ctx, grant, reviewConfig, authority, owner, agent, context, deliveryStore, evaluationStore, memoryStore,
    otherDelivery, otherEvaluation, lookup, source, request, get reviewStatus() { return reviewStatus },
    set reviewStatus(value: 'approved' | 'rejected' | 'unknown') { reviewStatus = value },
    useRealReviewer(runtime: MemoryReviewRuntime) { realReviewer = runtime },
    async unloadEvaluation() { await evaluationPlugin.dispose() },
    async restoreEvaluation() { evaluationPlugin = await ctx.plugin(AssistantEvaluationService,
      { databasePath: evaluationPath, projectionIntervalMs: 0 }) } }
}

test('adopts a real ordinary source while producer locks cover Memory commit, then propagates owner withdrawal', async () => {
  const f = await fixture()
  const source = f.source()
  const request = f.request(source, 'learn-fact-1')
  const apply = MemoryStore.prototype.applyLearningAdoption
  const commit = vi.spyOn(MemoryStore.prototype, 'applyLearningAdoption').mockImplementation(function (this: MemoryStore, input) {
    expect(() => f.otherDelivery.exec('BEGIN IMMEDIATE')).toThrow(/locked/u)
    expect(() => f.otherEvaluation.exec('BEGIN IMMEDIATE')).toThrow(/locked/u)
    const result = apply.call(this, input)
    expect(() => f.otherDelivery.exec('BEGIN IMMEDIATE')).toThrow(/locked/u)
    expect(() => f.otherEvaluation.exec('BEGIN IMMEDIATE')).toThrow(/locked/u)
    return result
  })
  const adopted = f.ctx.personalMemory.adoptReviewedLearning({ request })
  expect(commit).toHaveBeenCalledTimes(1)
  expect(f.lookup).toHaveBeenCalledTimes(1)
  expect(adopted.record).toMatchObject({ kind: 'fact', trust: 'agent-observed', sensitivity: 'private',
    provenance: { source: 'assistant-memory-learning', uri: `delivery:foreground:${source.inboxId}` } })
  expect(f.ctx.personalMemory.lookupLearningAdoption({ request })).toEqual(adopted)
  expect(f.ctx.personalMemory.adoptReviewedLearning({ request })).toEqual(adopted)
  expect(f.lookup).toHaveBeenCalledTimes(1)
  expect(f.ctx.personalMemory.read(f.agent, { ids: [adopted.record.id] })[0]?.content).toBe(adopted.record.content)
  expect(f.ctx.personalMemory.search(f.agent, { query: 'pnpm lockfile' }).map(item => item.record.id)).toContain(adopted.record.id)
  expect(f.ctx.personalMemory.exportJson(f.agent)).toContain(adopted.record.content)
  expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent: f.agent }))).toContain(adopted.record.content)

  const manual = f.memoryStore.applyApprovedMutation({ op: 'add', namespace: f.context.namespace,
    identity: { owner: 'user', scope: 'user-global' }, idempotencyKey: 'manual:1', entry: {
      kind: 'fact', content: 'The owner manually keeps garden notes.', sensitivity: 'private',
      trust: 'user-confirmed', confidence: 1, provenance: { source: 'owner', observedAt: Date.now() } } })
  const scope = { workspace: f.root, preset: 'primary' }
  const outcome = (id: string, status: 'achieved' | 'unknown') => ({ scope, situation: `foreground:${source.inboxId}`,
    executionStatus: 'succeeded' as const, objectiveStatus: status, deliveryStatus: 'delivered' as const,
    source: { kind: 'user-feedback' as const, id: 'assistant-delivery/typed-owner-feedback' },
    trust: 'trusted' as const, evidence: [{ kind: 'foreground-turn', ref: source.inboxId },
      { kind: 'delivery-outbox', ref: source.outbox.id }], metrics: {}, occurredAt: Date.now(),
    idempotencyKey: id, evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' } })
  const initial = f.evaluationStore.append(outcome('owner-initial', 'achieved'), {
    principalRecordId: f.owner.principalRecordId, principalVersion: f.owner.principalVersion,
    action: 'initial', operationId: 'owner-op-1' })
  expect(f.ctx.assistantEvaluation.getTrustedForegroundLearningProjection({
    scope: f.ctx.assistantEvaluation.canonicalHostScope(scope), inboxId: source.inboxId,
  })?.triggerOutcomeId).toBe(initial.id)
  f.evaluationStore.append(outcome('owner-withdraw', 'unknown'), {
    principalRecordId: f.owner.principalRecordId, principalVersion: f.owner.principalVersion,
    action: 'withdraw', operationId: 'owner-op-2', expectedVersion: 1, previousStatus: 'achieved' })
  expect(f.ctx.personalMemory.search(f.agent, { query: 'pnpm lockfile' })).toEqual([])
  expect(f.ctx.personalMemory.search(f.agent, { query: 'garden' }).map(item => item.record.id)).toContain(manual.id)
  const memoryRead = new DatabaseSync(f.memoryPath, { readOnly: true })
  try {
    expect(memoryRead.prepare('SELECT status FROM memory_records WHERE id = ?').get(adopted.record.id)).toEqual({ status: 'removed' })
    expect(memoryRead.prepare(`SELECT invalidation_reason FROM memory_learning_adoptions
      WHERE authority_id = ? AND operation_id = ?`).get(f.grant.authorityId, request.operationId))
      .toEqual({ invalidation_reason: 'withdrawn' })
  } finally { memoryRead.close() }
  expect(f.ctx.personalMemory.lookupLearningAdoption({ request })).toEqual(adopted)
  f.otherDelivery.exec('BEGIN IMMEDIATE; ROLLBACK')
  f.otherEvaluation.exec('BEGIN IMMEDIATE; ROLLBACK')
})

test('rejects unreviewed or mismatched owner/grant attempts; missing producer hides only learned records', async () => {
  const f = await fixture()
  const source = f.source()
  const request = f.request(source, 'learn-fact-2')
  f.reviewStatus = 'unknown'
  expect(() => f.ctx.personalMemory.adoptReviewedLearning({ request })).toThrow(/independent approval/u)
  f.reviewStatus = 'rejected'
  expect(() => f.ctx.personalMemory.adoptReviewedLearning({ request })).toThrow(/independent approval/u)
  expect(f.ctx.personalMemory.lookupLearningAdoption({ request })).toBeUndefined()
  expect(() => f.ctx.personalMemory.adoptReviewedLearning({ request: {
    ...request, owner: { ...request.owner, principalVersion: request.owner.principalVersion + 1 },
  } })).toThrow(/owner changed/u)
  expect(() => f.memoryStore.registerLearningGrant({ ...f.grant, maxMutations: f.grant.maxMutations + 1 }))
    .toThrow(/authority changed/u)
  f.reviewStatus = 'approved'
  const adopted = f.ctx.personalMemory.adoptReviewedLearning({ request })
  const manual = f.memoryStore.applyApprovedMutation({ op: 'add', namespace: f.context.namespace,
    identity: { owner: 'user', scope: 'user-global' }, idempotencyKey: 'manual:peer', entry: {
      kind: 'fact', content: 'Garden notes survive unavailable peers.', sensitivity: 'private',
      trust: 'user-confirmed', confidence: 1, provenance: { source: 'owner', observedAt: Date.now() } } })
  await f.unloadEvaluation()
  expect(f.ctx.personalMemory.search(f.agent, { query: 'pnpm lockfile' })).toEqual([])
  expect(f.ctx.personalMemory.search(f.agent, { query: 'garden' }).map(item => item.record.id)).toContain(manual.id)
  expect(f.ctx.personalMemory.exportJson(f.agent)).not.toContain(adopted.record.content)
  await f.restoreEvaluation()
  expect(f.ctx.personalMemory.search(f.agent, { query: 'pnpm lockfile' }).map(item => item.record.id)).toContain(adopted.record.id)
})

test('a manual version of an adopted record remains visible and cannot be reclaimed as managed learning', async () => {
  const f = await fixture()
  const source = f.source()
  const originalRequest = f.request(source, 'learn-manual-1')
  const adopted = f.ctx.personalMemory.adoptReviewedLearning({ request: originalRequest })
  const identity = { owner: 'agent' as const, scope: 'workspace' as const,
    workspace: f.root, agentPreset: 'primary' }
  const manual = f.memoryStore.applyApprovedMutation({ op: 'replace', namespace: f.context.namespace,
    identity, id: adopted.record.id, expectedVersion: adopted.record.version,
    idempotencyKey: 'manual:replace-learned', entry: { kind: 'fact',
      content: 'The owner manually revised the pnpm policy.', sensitivity: 'private', trust: 'user-confirmed',
      confidence: 1, provenance: { source: 'owner', observedAt: Date.now() } } })
  expect(manual.version).toBe(adopted.record.version + 1)
  expect(f.ctx.personalMemory.search(f.agent, { query: 'pnpm policy' }).map(item => item.record.id)).toContain(manual.id)
  expect(f.ctx.personalMemory.inspectLearningTarget({ owner: f.owner, id: manual.id,
    expectedVersion: manual.version })).toBeUndefined()
  const replaceRequest = f.request(source, 'learn-manual-2', { op: 'replace', id: manual.id,
    expectedVersion: manual.version, entry: { kind: 'fact', content: 'This pnpm project uses a revised lockfile.' } })
  expect(() => f.ctx.personalMemory.adoptReviewedLearning({ request: replaceRequest })).toThrow(/no longer managed/u)
  expect(f.ctx.personalMemory.read(f.agent, { ids: [manual.id] })[0]).toMatchObject({
    version: manual.version, content: manual.content, trust: 'user-confirmed',
  })
  expect(f.ctx.personalMemory.lookupLearningAdoption({ request: originalRequest })).toEqual(adopted)
})

test('a changed canonical owner outcome hides a learned experience while retaining its managed target', async () => {
  const f = await fixture()
  const source = f.source()
  const deliveryWriter = new DatabaseSync(join(f.root, 'delivery.sqlite'))
  try { deliveryWriter.prepare("UPDATE outbox_messages SET status = 'accepted' WHERE id = ?").run(source.outbox.id) }
  finally { deliveryWriter.close() }
  const scope = { workspace: f.root, preset: 'primary' }
  const outcome = (id: string, status: 'achieved' | 'not-achieved') => ({ scope,
    situation: `foreground:${source.inboxId}`, executionStatus: 'succeeded' as const,
    objectiveStatus: status, deliveryStatus: 'delivered' as const,
    source: { kind: 'user-feedback' as const, id: 'assistant-delivery/typed-owner-feedback' },
    trust: 'trusted' as const, evidence: [{ kind: 'foreground-turn', ref: source.inboxId },
      { kind: 'delivery-outbox', ref: source.outbox.id }], metrics: {}, occurredAt: Date.now(),
    idempotencyKey: id, evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' } })
  const initial = f.evaluationStore.append(outcome('experience-initial', 'achieved'), {
    principalRecordId: f.owner.principalRecordId, principalVersion: f.owner.principalVersion,
    action: 'initial', operationId: 'experience-feedback-1' })
  const inspected = f.ctx.assistantDelivery.inspectOwnerForegroundLearningTask({
    authorityId: f.owner.authorityId, principalId: f.owner.principalId,
    workspace: f.root, agentPreset: 'primary', outcomeId: initial.id,
  })
  expect(inspected).toMatchObject({ judgement: 'owner-feedback', source: { inboxId: source.inboxId,
    quiescent: true }, canonical: { projection: { disposition: 'upsert' }, objective: { status: 'achieved' } } })
  const request: MemoryLearningReviewRequest = { ...f.request(source, 'learn-experience-1', { op: 'add',
    entry: { kind: 'experience', content: 'The pnpm lockfile task succeeded after checking the lockfile.' } }),
  source: { inboxId: source.inboxId, sourceDigest: source.sourceDigest, contentDigest: source.contentDigest,
    canonical: { outcomeId: initial.id, version: inspected!.canonical.projection.version,
      digest: inspected!.canonical.projection.digest, objectiveStatus: 'achieved' } } }
  const adopted = f.ctx.personalMemory.adoptReviewedLearning({ request })
  expect(f.ctx.personalMemory.search(f.agent, { query: 'lockfile task succeeded' }).map(item => item.record.id))
    .toContain(adopted.record.id)
  f.evaluationStore.append(outcome('experience-correct', 'not-achieved'), {
    principalRecordId: f.owner.principalRecordId, principalVersion: f.owner.principalVersion,
    action: 'correct', operationId: 'experience-feedback-2', expectedVersion: 1,
    previousStatus: 'achieved' })
  expect(f.ctx.personalMemory.search(f.agent, { query: 'lockfile task succeeded' })).toEqual([])
  expect(f.ctx.personalMemory.inspectLearningTarget({ owner: f.owner, id: adopted.record.id,
    expectedVersion: adopted.record.version })).toMatchObject({ managed: true,
    id: adopted.record.id, version: adopted.record.version })
  expect(f.ctx.personalMemory.lookupLearningAdoption({ request })).toEqual(adopted)
})

test('adopts an approved receipt reconstructed by the real durable Verifier ledger', async () => {
  const f = await fixture()
  const source = f.source()
  const request = f.request(source, 'learn-real-review-receipt')
  const runtime = new MemoryReviewRuntime(f.ctx, f.reviewConfig, join(f.root, 'verifier.sqlite'))
  const ledger = new SourceReviewStore(join(f.root, 'verifier.sqlite.memory-reviews'))
  try {
    const model = f.deliveryStore.readOwnerForegroundTaskSource({ authorityId: f.owner.authorityId,
      principalId: f.owner.principalId, workspace: f.root, agentPreset: 'primary',
      expectedOwner: { authorityHash: f.owner.authorityHash,
        principalRecordId: f.owner.principalRecordId, principalVersion: f.owner.principalVersion },
      inboxId: source.inboxId, expectedSourceDigest: source.sourceDigest }, f.authority)!.source.execution.modelSelection!
    const binding = { operationId: request.operationId, requestDigest: memoryLearningRequestDigest(request),
      authorityId: f.reviewConfig.authorityId, authorityDigest: growthObjectDigest(f.reviewConfig),
      maxReviews: f.reviewConfig.maxReviews, model }
    expect(ledger.claim(binding)).toEqual({ state: 'claimed' })
    ledger.finish(request.operationId, binding.requestDigest, { status: 'approved',
      reason: 'The owner states this project uses a lockfile.', outputDigest: 'e'.repeat(64) })
    f.useRealReviewer(runtime)
    const receipt = runtime.lookup(request)!
    expect(receipt).toMatchObject({ protocol: 'memory-learning-review-receipt/v1', status: 'approved',
      operationId: request.operationId, requestDigest: binding.requestDigest,
      authorityId: binding.authorityId, authorityDigest: binding.authorityDigest,
      model, outputDigest: 'e'.repeat(64) })
    const { receiptDigest, ...body } = receipt
    expect(receiptDigest).toBe(growthObjectDigest(body))
    const adopted = f.ctx.personalMemory.adoptReviewedLearning({ request })
    expect(adopted.reviewReceiptDigest).toBe(receiptDigest)
    expect(adopted.record.content).toBe(request.mutation.op === 'add' ? request.mutation.entry.content : '')
    const memoryRead = new DatabaseSync(f.memoryPath, { readOnly: true })
    try {
      const row = memoryRead.prepare(`SELECT review_receipt_json FROM memory_learning_adoptions
        WHERE authority_id = ? AND operation_id = ?`).get(f.grant.authorityId, request.operationId) as
        { review_receipt_json: string }
      expect(JSON.parse(row.review_receipt_json)).toEqual(receipt)
    } finally { memoryRead.close() }
    expect(runtime.lookup(request)).toEqual(receipt)
  } finally {
    ledger.close()
    await runtime.close()
  }
})
