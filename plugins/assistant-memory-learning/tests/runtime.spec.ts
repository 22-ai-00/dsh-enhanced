import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantEvaluationService, EvaluationStore } from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { growthObjectDigest, memoryLearningRequestDigest, type MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { MemoryLearningRuntime, type LearningPorts } from '../src/runtime.ts'
import { LearningStore } from '../src/store.ts'
import type { LearningConfig } from '../src/types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const action of cleanup.splice(0).reverse()) await action() })
type Source = { inboxId: string; sequence: number; digest: string; input: string; reply: string | null;
  model: { provider: string; model: string; reasoningEffort: string }; completedAt: number }

async function fixture(options: { maxPending?: number; maxExtractions?: number; nativeBudget?: boolean; reviewAvailable?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'memory-learning-runtime-'))
  const ctx = new Context()
  const owner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'lark/primary/personal/ou_owner',
    principalRecordId: 'principal-one', principalVersion: 1, workspace: root, agentPreset: 'primary' }
  const reviewAuthorityId = 'memory-review-one', reviewAuthorityDigest = 'b'.repeat(64)
  const adoptionAuthorityId = 'memory-adoption-one', adoptionGrantDigest = 'c'.repeat(64)
  const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), budgets: [
    { id: 'memory-scan-budget', metric: 'automation-runs', limit: 20, periodMs: 86_400_000, scope: 'subject' },
    ...(options.nativeBudget === false ? [] : [{ id: 'memory-learn-budget', metric: 'automation-runs', limit: 20,
      periodMs: 86_400_000, scope: 'global' as const }]),
  ], rules: [
    { id: 'memory-reconcile', effect: 'allow', subject: { kind: 'background', id: 'assistant-memory-learning',
      workspace: root, principal: owner.principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' },
      context: { initiators: ['background'] } },
    { id: 'memory-execute', effect: 'allow', subject: { kind: 'background', id: '*',
      workspace: root, principal: owner.principalId }, actions: ['execute'], resource: { kind: 'automation', id: '*' },
      context: { initiators: ['background'] } },
    { id: 'memory-extract', effect: 'allow', subject: { kind: 'background', id: 'assistant-memory-learning',
      workspace: root, principal: owner.principalId }, actions: ['extract'], resource: { kind: 'memory', id: '*' },
      context: { initiators: ['background'] } },
  ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'),
    runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const evaluation = new AssistantEvaluationService(ctx, { databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
  const producer = new EvaluationStore({ path: join(root, 'evaluation.sqlite') })
  const sources = new Map<string, Source>()
  const source = (inboxId: string): Source => sources.get(inboxId)!
  const metadata = (value: Source) => ({ protocol: 'assistant-delivery/owner-foreground-source/v1' as const,
    inboxId: value.inboxId, sourceDigest: value.digest, completionSequence: value.sequence,
    execution: { dispatchedAt: value.completedAt - 10, completedAt: value.completedAt, executionRef: `run-${value.inboxId}`,
      status: 'succeeded' as const, quiescent: true, modelSelectionState: 'frozen' as const, modelSelection: value.model } })
  let nextSequence = 0
  const addSource = (inboxId = `inbox-${nextSequence + 1}`, reply: string | null = 'Assistant answer.') => {
    const value: Source = { inboxId, sequence: ++nextSequence, digest: growthObjectDigest(['source', inboxId]),
      input: `Owner states a fact about ${inboxId}.`, reply,
      model: { provider: 'conversation', model: `model-${inboxId}`, reasoningEffort: 'medium' }, completedAt: Date.now() - 100 }
    sources.set(inboxId, value); return value
  }
  const cursor = (sequence: number) => ({ protocol: 'assistant-delivery/owner-foreground-source-cursor/v1' as const,
    epoch: 'delivery-epoch', scopeKey: 'delivery-owner-scope', sequence })
  const delivery = {
    validateOwnerRoute: () => ({ ...owner }),
    listOwnerForegroundTaskSources: ({ after }: { after?: { sequence: number } }) => {
      const items = [...sources.values()].filter(item => item.sequence > (after?.sequence ?? 0)).map(metadata)
      return { items, nextCursor: cursor(nextSequence), watermark: nextSequence, hasMore: false }
    },
    inspectOwnerForegroundTaskSource: ({ inboxId }: { inboxId: string }) => {
      const value = sources.get(inboxId); return value ? metadata(value) : undefined
    },
    withOwnerForegroundTaskSourcesFence: (_input: unknown, callback: (items: unknown[]) => unknown) => {
      const refs = (_input as { sources: { inboxId: string; expectedSourceDigest: string }[] }).sources
      const contents = refs.flatMap(ref => {
        const value = sources.get(ref.inboxId)
        if (!value || value.digest !== ref.expectedSourceDigest || value.reply === null) return []
        return [{ source: metadata(value), sourceDigest: value.digest,
          contentDigest: growthObjectDigest([value.input, value.reply]),
          input: { text: value.input, truncated: false }, reply: { text: value.reply, truncated: false } }]
      })
      return callback(contents)
    },
    inspectOwnerForegroundLearningTask: ({ outcomeId }: { outcomeId: string }) => {
      const scope = evaluation.canonicalHostScope({ workspace: root, preset: 'primary' })
      const canonical = evaluation.getTrustedTaskLearningProjection({ scope, outcomeId })
      if (!canonical || canonical.projection.subjectKind !== 'foreground-turn') return undefined
      const value = sources.get(canonical.projection.subjectRef)
      if (!value) return undefined
      return { protocol: 'assistant-delivery/owner-foreground-learning/v1' as const, owner: { ...owner }, canonical,
        judgement: 'owner-feedback' as const, source: { sessionId: 'original-session', inboxId: value.inboxId,
          objective: value.input, truncated: false, quiescent: true, modelSelectionState: 'frozen' as const,
          modelSelection: value.model }, feedback: { inboxId: 'feedback-one', text: `Owner corrected ${value.inboxId}.`, truncated: false } }
    },
  } as unknown as LearningPorts['delivery']
  let event = 0
  const appendCanonical = (inboxId: string, status: 'achieved' | 'not-achieved' | 'unknown' = 'not-achieved',
    action: 'initial' | 'correct' | 'withdraw' = 'initial') => {
    const scope = { workspace: root, preset: 'primary' }, situation = `foreground:${inboxId}`
    if (action === 'initial') producer.append({ scope, situation, executionStatus: 'succeeded', objectiveStatus: status,
      deliveryStatus: 'delivered', source: { kind: 'evaluator', id: 'assistant-verifier' }, trust: 'trusted',
      evidence: [{ kind: 'foreground-turn', ref: inboxId }, { kind: 'acceptance-contract', ref: `contract:${inboxId}` },
        { kind: 'verification-receipt', ref: `receipt:${++event}` }], metrics: {}, occurredAt: Date.now() - 100,
      idempotencyKey: `verifier:${inboxId}`, evaluator: { id: 'assistant-verifier', version: '1' } })
    const current = action === 'initial' ? undefined : evaluation.getTrustedForegroundLearningProjection({
      scope: evaluation.canonicalHostScope(scope), inboxId })
    const previous = current && evaluation.inspectTrustedTaskOwnerRevision({ scope: evaluation.canonicalHostScope(scope),
      outcomeId: current.triggerOutcomeId, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion })
    const revision = action === 'initial' ? { principalRecordId: owner.principalRecordId,
      principalVersion: owner.principalVersion, action, operationId: `owner-${++event}` } : {
      principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion, action,
      operationId: `owner-${++event}`, expectedVersion: previous!.version,
      previousStatus: previous!.objectiveStatus as 'achieved' | 'not-achieved' }
    return producer.append({ scope, situation, executionStatus: 'succeeded', objectiveStatus: status,
      deliveryStatus: 'delivered', source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' }, trust: 'trusted',
      evidence: [{ kind: 'foreground-turn', ref: inboxId }, { kind: 'delivery-outbox', ref: `outbox:${inboxId}` }],
      metrics: {}, occurredAt: Date.now() - 50, idempotencyKey: `owner:${inboxId}:${action}:${event}`,
      evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' } }, revision)
  }
  const adoption = new Map<string, string>(), reviews = new Map<string, ReturnType<typeof receipt>>()
  function receipt(request: MemoryLearningReviewRequest, status: 'approved' | 'rejected' | 'unknown' = 'approved') {
    const body = { protocol: 'memory-learning-review-receipt/v1' as const, operationId: request.operationId,
      requestDigest: memoryLearningRequestDigest(request), authorityId: reviewAuthorityId, authorityDigest: reviewAuthorityDigest,
      sessionId: 'independent-review-session', model: { provider: 'independent', model: 'reviewer' },
      status, reason: status === 'approved' ? 'Source supports candidate.' : 'Unresolved.', outputDigest: 'e'.repeat(64) }
    return { ...body, receiptDigest: growthObjectDigest(body) }
  }
  const memory = { listLearningTargets: vi.fn(() => []),
    inspectLearningAdoptionAvailability: () => ({ authorityId: adoptionAuthorityId, grantDigest: adoptionGrantDigest,
      expiresAt: Date.now() + 100_000, remainingMutations: 100, remainingContentBytes: 100_000, available: true }),
    lookupLearningAdoption: vi.fn(({ request }: { request: MemoryLearningReviewRequest }) => {
      const digest = adoption.get(request.operationId); return digest ? { receiptDigest: digest } : undefined
    }),
    adoptReviewedLearning: vi.fn(({ request }: { request: MemoryLearningReviewRequest }) => {
      const digest = growthObjectDigest(['adoption', request.operationId]); adoption.set(request.operationId, digest)
      return { receiptDigest: digest }
    }) }
  const verifier = { inspectMemoryLearningReviewAvailability: () => ({ authorityId: reviewAuthorityId,
    authorityDigest: reviewAuthorityDigest, expiresAt: Date.now() + 100_000, remainingReviews: 100,
    available: options.reviewAvailable !== false }),
    reviewMemoryLearning: vi.fn(async (request: MemoryLearningReviewRequest) => {
      const result = receipt(request); reviews.set(request.operationId, result); return result
    }),
    lookupMemoryLearningReview: vi.fn((request: MemoryLearningReviewRequest) => reviews.get(request.operationId)) }
  const extract = vi.fn<LearningPorts['extract']>(async ({ job, assertCurrent }) => {
    assertCurrent()
    const quote = job.intent.kind === 'experience' ? job.snapshot!.ownerFeedback! : job.snapshot!.ownerStatement
    return { proposal: { mutation: { op: 'add' as const, entry: { kind: job.intent.kind, content: quote } },
      evidenceQuote: quote }, reason: 'candidate', sessionId: `memory-extract-${job.digest}`, outputDigest: 'd'.repeat(64) }
  })
  const config: LearningConfig = { databasePath: join(root, 'learning.sqlite'), authorityId: 'extraction-one', owner,
    expiresAt: Date.now() + 100_000, maxExtractions: options.maxExtractions ?? 3, maxPending: options.maxPending ?? 3,
    lookbackMs: 180_000, policy: 'Extract only owner-supported durable knowledge.', maxInputBytes: 8192,
    maxOutputTokens: 256, timeoutMs: 10_000, budgetId: 'memory-learn-budget', budgetAmount: 1,
    scanBudgetId: 'memory-scan-budget', scanBudgetAmount: 1, reviewAuthorityId, reviewAuthorityDigest,
    adoptionAuthorityId, adoptionGrantDigest }
  const runtimes: MemoryLearningRuntime[] = []
  const create = () => {
    const runtime = new MemoryLearningRuntime(config, { automations, evaluation, delivery, memory, verifier, policy,
      extract })
    runtimes.push(runtime); runtime.start(); return runtime
  }
  const tick = async () => {
    const now = Date.now(); vi.setSystemTime(now + 1500)
    for (let i = 0; i < 3; i++) { await automations.tick(); await automations.whenIdle() }
  }
  const storedCursor = (feed: 'delivery' | 'evaluation') => {
    const ledger = new LearningStore(config.databasePath, { authorityId: config.authorityId,
      configDigest: growthObjectDigest(config), maxExtractions: config.maxExtractions })
    try { return ledger.cursor(growthObjectDigest([config.authorityId, config.owner]), feed) }
    finally { ledger.close() }
  }
  cleanup.push(async () => { await Promise.allSettled(runtimes.map(runtime => runtime.close())); producer.close()
    await ctx.fiber.restart(); await rm(root, { recursive: true, force: true }) })
  return { root, ctx, config, owner, policy, automations, evaluation, producer, source, addSource, appendCanonical,
    delivery, memory, verifier, extract, create, tick, storedCursor, adoption, reviews, receipt }
}

test('ordinary completed task schedules a native fact extraction before any canonical outcome', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('first'); const runtime = f.create()
  expect(runtime.health().counts.queued).toBe(1)
  expect(f.extract).not.toHaveBeenCalled()
  await f.tick()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(f.extract.mock.calls[0]![0].job.snapshot?.model).toEqual(f.source('first').model)
  expect(f.verifier.reviewMemoryLearning).toHaveBeenCalledTimes(1)
  expect(f.memory.adoptReviewedLearning).toHaveBeenCalledTimes(1)
  expect(runtime.health().counts.adopted).toBe(1)
})

test('unreadable Outbox reply leaves a durable intent; a later native scanner dispatches it', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('late-reply', null); const runtime = f.create()
  expect(runtime.health().counts.pending).toBe(1)
  expect(f.extract).not.toHaveBeenCalled()
  expect(f.storedCursor('delivery')).toMatchObject({ sequence: 1 })
  await runtime.close(); f.source('late-reply').reply = 'Now readable.'
  const restarted = f.create()
  expect(restarted.health().counts.queued).toBe(1)
  await f.tick()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(restarted.health().counts.adopted).toBe(1)
})

test('native periodic scanner notices a reply that appears after startup without a local scan call', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('late-reply', null); const runtime = f.create()
  expect(runtime.health().counts.pending).toBe(1)
  f.source('late-reply').reply = 'Reply was delivered later.'
  vi.setSystemTime(new Date('2026-09-29T12:01:10Z'))
  await f.automations.tick(); await f.automations.whenIdle()
  expect(runtime.health().counts.queued).toBe(1)
  await f.tick()
  expect(runtime.health().counts.adopted).toBe(1)
  expect(f.extract).toHaveBeenCalledTimes(1)
})

test('late canonical feedback admits an experience through Evaluation cursor after the ordinary fact', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('task'); const runtime = f.create(); await f.tick()
  expect(runtime.health().counts.adopted).toBe(1)
  expect(f.extract.mock.calls[0]![0].job.intent.kind).toBe('fact')
  expect(f.storedCursor('evaluation')).toBeUndefined()
  f.appendCanonical('task'); runtime.scan()
  expect(runtime.health().counts.queued).toBe(1)
  expect(f.storedCursor('evaluation')).toMatchObject({ watermark: expect.any(Number) })
  await f.tick()
  expect(f.extract).toHaveBeenCalledTimes(2)
  expect(f.extract.mock.calls[1]![0].job.intent.kind).toBe('experience')
  expect(f.verifier.reviewMemoryLearning).toHaveBeenCalledTimes(2)
  expect(runtime.health().counts.adopted).toBe(2)
})

test('correction before dispatch supersedes the old experience, and later withdrawal closes the newer revision', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('task'); const runtime = f.create(); await f.tick()
  f.appendCanonical('task'); runtime.scan()
  f.appendCanonical('task', 'achieved', 'correct'); runtime.scan()
  await f.tick()
  expect(f.extract.mock.calls.filter(call => call[0].job.intent.kind === 'experience')).toHaveLength(1)
  const projection = f.evaluation.getTrustedForegroundLearningProjection({
    scope: f.evaluation.canonicalHostScope({ workspace: f.root, preset: 'primary' }), inboxId: 'task' })
  expect(f.extract.mock.calls.at(-1)![0].job.intent.canonical?.version).toBe(projection?.projection.version)
  const old = f.extract.mock.calls.at(-1)![0].job
  f.appendCanonical('task', 'unknown', 'withdraw'); runtime.scan()
  expect(runtime.health().counts.superseded).toBeGreaterThanOrEqual(1)
  expect(f.memory.adoptReviewedLearning).toHaveBeenCalledTimes(2)
  expect(old.intent.kind).toBe('experience')
})

test('withdrawal inside an in-flight extraction blocks review and adoption of the old experience', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('task'); const runtime = f.create(); await f.tick()
  f.appendCanonical('task'); runtime.scan()
  f.extract.mockImplementationOnce(async input => {
    f.appendCanonical('task', 'unknown', 'withdraw')
    input.assertCurrent()
    throw new Error('withdrawn source must fail the source fence')
  })
  await f.tick()
  expect(f.verifier.reviewMemoryLearning).toHaveBeenCalledTimes(1)
  expect(f.memory.adoptReviewedLearning).toHaveBeenCalledTimes(1)
  expect(runtime.health().counts.failed + runtime.health().counts.superseded).toBe(1)
  await runtime.close(); const restarted = f.create(); await f.tick()
  expect(f.extract).toHaveBeenCalledTimes(2)
  expect(f.verifier.reviewMemoryLearning).toHaveBeenCalledTimes(1)
  expect(restarted.health().counts.failed + restarted.health().counts.superseded).toBe(1)
})

test('failed extraction consumes one grant but releases maxPending capacity for the next ordinary task', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture({ maxPending: 1 }); f.addSource('first'); f.addSource('second')
  f.extract.mockImplementationOnce(async () => { throw new Error('model failed before proposing') })
  const runtime = f.create()
  expect(runtime.health().counts.queued).toBe(1)
  expect(f.storedCursor('delivery')).toMatchObject({ sequence: 1 })
  await f.tick()
  expect(runtime.health().counts.failed).toBe(1)
  expect(runtime.health().counts.queued).toBe(1)
  expect(runtime.health().remainingExtractions).toBe(f.config.maxExtractions - 1)
  expect(f.storedCursor('delivery')).toMatchObject({ sequence: 2 })
  await f.tick()
  expect(runtime.health().counts.adopted).toBe(1)
  expect(f.extract.mock.calls.map(call => call[0].job.intent.inboxId)).toEqual(['first', 'second'])
  expect(f.verifier.reviewMemoryLearning).toHaveBeenCalledTimes(1)
  await runtime.close(); const restarted = f.create(); await f.tick()
  expect(restarted.health().counts.failed).toBe(1)
  expect(f.extract).toHaveBeenCalledTimes(2)
})

test('a temporary feed read error clears from health after a successful scan', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture()
  const feed = vi.spyOn(f.delivery, 'listOwnerForegroundTaskSources')
  feed.mockImplementationOnce(() => { throw new Error('temporary delivery feed outage') })
  const runtime = f.create()
  expect(runtime.health().lastError).toContain('temporary delivery feed outage')
  f.addSource('after-outage'); runtime.scan()
  expect(runtime.health().lastError).toBeNull()
  expect(runtime.health().counts.queued).toBe(1)
})

test('source-selected model is frozen across restart and quota stops subsequent extraction calls', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture({ maxExtractions: 1 }); f.addSource('one'); f.addSource('two')
  const first = f.create(); expect(first.health().counts.queued).toBe(2); await first.close()
  const second = f.create(); await f.tick()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(f.extract.mock.calls[0]![0].job.snapshot?.model).toEqual(f.source('one').model)
  expect(second.health().remainingExtractions).toBe(0)
  await f.tick()
  expect(f.extract).toHaveBeenCalledTimes(1)
})

test('native learning budget refusal invokes no extraction model or review', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture({ nativeBudget: false }); f.addSource('task'); const runtime = f.create()
  await f.tick()
  expect(f.extract).not.toHaveBeenCalled()
  expect(f.verifier.reviewMemoryLearning).not.toHaveBeenCalled()
  expect(runtime.health().remainingExtractions).toBe(f.config.maxExtractions)
})

test('backpressure leaves the second Delivery source discoverable after the first settles', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture({ maxPending: 1 }); f.addSource('one'); f.addSource('two'); const runtime = f.create()
  expect(runtime.health().counts.queued).toBe(1)
  expect(f.storedCursor('delivery')).toMatchObject({ sequence: 1 })
  await f.tick(); await f.tick()
  expect(f.extract).toHaveBeenCalledTimes(2)
  expect(runtime.health().counts.adopted).toBe(2)
  expect(f.storedCursor('delivery')).toMatchObject({ sequence: 2 })
})

test('unknown review after a persisted request reconciles exact adoption receipt after restart without paid replay', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('task'); const first = f.create()
  f.verifier.reviewMemoryLearning.mockImplementationOnce(async () => { throw new Error('review outcome lost') })
  await f.tick()
  expect(first.health().counts.unknown).toBe(1)
  expect(f.extract).toHaveBeenCalledTimes(1)
  const request = f.verifier.reviewMemoryLearning.mock.calls[0]![0]
  const receiptDigest = growthObjectDigest(['already-adopted', request.operationId])
  f.adoption.set(request.operationId, receiptDigest)
  await first.close(); const restarted = f.create()
  expect(restarted.health().counts.adopted).toBe(1)
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(f.verifier.reviewMemoryLearning).toHaveBeenCalledTimes(1)
  expect(f.memory.lookupLearningAdoption).toHaveBeenCalledWith({ request })
})

test('provider disposal aborts and drains in-flight extraction before the database closes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('task'); const runtime = f.create()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.extract.mockImplementationOnce(async ({ signal }) => {
    entered()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    return { proposal: null, reason: 'aborted', sessionId: 'memory-extract-aborted', outputDigest: 'd'.repeat(64) }
  })
  const ticking = f.tick(); await started; await runtime.close(); await ticking
  const restarted = f.create()
  expect(restarted.health().counts.failed).toBe(1)
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(f.verifier.reviewMemoryLearning).not.toHaveBeenCalled()
})

test('noncooperative extraction cannot hold shutdown forever or dispatch a late candidate', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(); f.addSource('task'); const runtime = f.create()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let release!: (value: Awaited<ReturnType<LearningPorts['extract']>>) => void
  const held = new Promise<Awaited<ReturnType<LearningPorts['extract']>>>(resolve => { release = resolve })
  f.extract.mockImplementationOnce(async () => { entered(); return held })
  const ticking = f.tick(); await started
  await expect(runtime.close()).rejects.toThrow(/shutdown timed out/)
  release({ proposal: { mutation: { op: 'add', entry: { kind: 'fact', content: 'Late candidate.' } },
    evidenceQuote: 'Late candidate.' }, reason: 'late', sessionId: 'memory-extract-late', outputDigest: 'd'.repeat(64) })
  await ticking
  expect(f.verifier.reviewMemoryLearning).not.toHaveBeenCalled()
  expect(f.memory.adoptReviewedLearning).not.toHaveBeenCalled()
  const restarted = f.create(); await f.tick()
  expect(restarted.health().counts.failed).toBe(1)
  expect(f.extract).toHaveBeenCalledTimes(1)
}, 15_000)
