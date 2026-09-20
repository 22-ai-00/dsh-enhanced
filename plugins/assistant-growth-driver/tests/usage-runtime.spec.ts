import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantEvaluationService, EvaluationStore } from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, test, vi } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { UsageLearningRuntime, type UsageReviewInput, type UsageReviewResult } from '../src/usage-runtime.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(options: { fixed?: boolean; missing?: boolean; budget?: boolean; maxPending?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'growth-usage-'))
  const ctx = new Context()
  const scope = { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'owner-route' }
  const owner = { receiptVersion: 2 as const, authorityId: scope.ownerRouteId, authorityHash: 'a'.repeat(64),
    principalId: scope.principalId, principalRecordId: 'record', principalVersion: 1,
    workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), budgets: options.budget === false ? [] : [
    { id: 'growth-budget', metric: 'automation-runs', limit: 10, periodMs: 60_000, scope: 'global' }], rules: [
    { id: 'usage-reconcile', effect: 'allow', subject: { kind: 'background', id: 'assistant-growth-usage', workspace: root, principal: 'owner' },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'usage-execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: 'owner' },
      actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
  ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const evaluation = new AssistantEvaluationService(ctx, { databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
  let time = Date.now() - 1000
  const producer = new EvaluationStore({ path: join(root, 'evaluation.sqlite'), now: () => ++time })
  const sourceModel = { provider: 'conversation', model: 'original', reasoningEffort: 'medium' }
  const delivery = {
    validateOwnerRoute: () => ({ ...owner }),
    inspectOwnerForegroundLearningTask: ({ outcomeId }: { outcomeId: string }): OwnerForegroundLearningTask | undefined => {
      const canonical = evaluation.getTrustedTaskLearningProjection({ scope: evaluation.canonicalHostScope({ workspace: root, preset: 'primary' }), outcomeId })
      if (!canonical || canonical.projection.subjectKind !== 'foreground-turn') return undefined
      return { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner: { ...owner }, canonical,
        judgement: 'independent-verifier', source: { sessionId: 'original-session', inboxId: canonical.projection.subjectRef,
          objective: 'Fix the real task failure', truncated: false, quiescent: true,
          modelSelectionState: options.missing ? 'missing' : 'frozen', ...(options.missing ? {} : { modelSelection: { ...sourceModel } }) } }
    },
  }
  const config = normalizeConfig({ enabled: true, scope, budgetId: 'growth-budget', budgetAmount: 1,
    ...(options.fixed ? { provider: 'fixed', model: 'repair' } : {}),
    usageLearning: { enabled: true, databasePath: join(root, 'usage.sqlite'), maxPending: options.maxPending ?? 16 } })
  const review = vi.fn<(input: UsageReviewInput) => Promise<UsageReviewResult>>(async input => { input.assertCurrent(); return 'reviewed' })
  const runtimes: UsageLearningRuntime[] = []
  const create = () => {
    const runtime = new UsageLearningRuntime(config, { evaluation, automations, delivery, review })
    runtimes.push(runtime); runtime.start(); return runtime
  }
  const append = (task = 'task', status: 'achieved' | 'not-achieved' | 'unknown' = 'not-achieved') => producer.append({
    scope: { workspace: root, preset: 'primary' }, situation: `foreground:${task}`, executionStatus: 'succeeded', objectiveStatus: status,
    deliveryStatus: 'delivered', source: { kind: 'evaluator', id: 'assistant-verifier' }, trust: 'trusted',
    evidence: [{ kind: 'foreground-turn', ref: task }, { kind: 'acceptance-contract', ref: `contract:${task}` },
      { kind: 'verification-receipt', ref: `receipt:${time}` }], metrics: {}, occurredAt: Date.now() - 100,
    idempotencyKey: `${task}:${status}:${++time}`, evaluator: { id: 'assistant-verifier', version: '1' },
  })
  const tick = async () => {
    await new Promise(resolve => setTimeout(resolve, 1100))
    // A minute-boundary scanner may occupy the native runner's admission slot
    // on the first tick. Drain the remaining already-due occurrence as well.
    for (let i = 0; i < 3; i += 1) { await automations.tick(); await automations.whenIdle() }
  }
  cleanup.push(async () => { for (const runtime of runtimes) await runtime.close(); producer.close(); await ctx.fiber.restart(); await rm(root, { recursive: true, force: true }) })
  return { ctx, config, owner, evaluation, automations, sourceModel, review, create, append, tick }
}

test('native Automations dispatches one durable review of real canonical feedback and never replays it', async () => {
  const f = await fixture(); f.append(); const runtime = f.create()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  await f.tick()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(f.review.mock.calls[0]![0]).toMatchObject({ model: f.sourceModel, source: { source: { objective: 'Fix the real task failure' } } })
  expect(runtime.health().counts).toEqual({ reviewed: 1 })
  await runtime.close(); const restarted = f.create(); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.review).toHaveBeenCalledTimes(1); expect(restarted.health().counts).toEqual({ reviewed: 1 })
})

test('recovers queued work and freezes its original model across a restart', async () => {
  const f = await fixture(); f.append(); const first = f.create(); await first.close()
  const second = f.create(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(f.review.mock.calls[0]![0].model).toEqual({ provider: 'conversation', model: 'original', reasoningEffort: 'medium' })
  expect(second.health().counts).toEqual({ reviewed: 1 })
})

test.each([false, true])('does not guess a missing source model; fixed override=%s', async fixed => {
  const f = await fixture({ missing: true, fixed }); f.append(); const runtime = f.create(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(fixed ? 1 : 0)
  if (fixed) expect(f.review.mock.calls[0]![0].model).toEqual({ provider: 'fixed', model: 'repair' })
  else expect(runtime.health().counts).toEqual({})
})

test('withdrawal before dispatch cancels the old review without a model call', async () => {
  const f = await fixture(); f.append(); const runtime = f.create(); f.append('task', 'unknown'); runtime.scan(); await f.tick()
  expect(f.review).not.toHaveBeenCalled()
  expect(runtime.health().counts.queued ?? 0).toBe(0)
})

test('native budget refusal settles a queued job without calling the review Agent', async () => {
  const f = await fixture({ budget: false }); f.append(); const runtime = f.create(); await f.tick(); runtime.scan()
  expect(f.review).not.toHaveBeenCalled(); expect(runtime.health().counts).toEqual({ failed: 1 })
})

test('a running review observes a correction and becomes unknown rather than replaying', async () => {
  const f = await fixture(); f.append(); const runtime = f.create()
  f.review.mockImplementationOnce(async input => { f.append('task', 'unknown'); input.assertCurrent(); return 'reviewed' })
  await f.tick()
  expect(runtime.health().counts).toEqual({ unknown: 1 })
  await runtime.close(); const restarted = f.create(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(1); expect(restarted.health().counts).toEqual({ unknown: 1 })
})

test('backpressure leaves unconsumed heads discoverable after the first job finishes', async () => {
  const f = await fixture({ maxPending: 1 }); f.append('one'); f.append('two'); const runtime = f.create()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  await f.tick(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(2); expect(runtime.health().counts).toEqual({ reviewed: 2 })
})

test('the native periodic scan discovers later cross-process feedback without a local notification', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Keep the review tick away from the next cron minute, which can otherwise
  // occupy the native runner's single admission slot depending on wall time.
  vi.setSystemTime(new Date('2026-09-20T00:00:10Z'))
  const f = await fixture(); const runtime = f.create()
  expect(runtime.health().counts).toEqual({})
  f.append('later')
  const now = Date.now(); vi.setSystemTime(now + 65_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  vi.setSystemTime(now + 67_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(runtime.health().counts).toEqual({ reviewed: 1 })
})

test('automatic learning requires its owner scope, budget and native scheduling', () => {
  expect(normalizeConfig({}).usageLearning.enabled).toBe(false)
  expect(() => normalizeConfig({ usageLearning: { enabled: true, databasePath: '/tmp/usage.sqlite' } })).toThrow(/usageLearning/)
  expect(() => normalizeConfig({ enabled: true, scope: { workspace: '/work', preset: 'p', principalId: 'u', ownerRouteId: 'r' },
    budgetId: 'b', budgetAmount: 1, intervalMs: 1000, usageLearning: { enabled: true, databasePath: '/tmp/usage.sqlite' } })).toThrow(/intervalMs/)
})

test('provider disposal aborts and drains a running review before closing its store', async () => {
  const f = await fixture(); f.append(); const runtime = f.create()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.review.mockImplementationOnce(async input => {
    entered()
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    return 'unknown'
  })
  const ticking = f.tick()
  await started; await runtime.close(); await ticking
  const restarted = f.create()
  expect(restarted.health().counts).toEqual({ unknown: 1 })
  expect(f.review).toHaveBeenCalledTimes(1)
})
