import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { OpportunityEngine } from '../src/engine.ts'
import { PreparationStore } from '../src/preparation-store.ts'
import { PreparationRuntime } from '../src/preparation.ts'
import type { OpportunityInput, OpportunityProfile } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const settings = { provider: 'mock', model: 'draft', budgetId: 'preparation-runs', maxOutputTokens: 1000, timeoutMs: 5000 }
const profile: OpportunityProfile = { id: 'prepare', mode: 'prepare', preparation: settings, expectedBenefit: 10, successPpm: 1_000_000, executionCost: 1, interruptionCost: 0, possibleLoss: 0, minimumUtility: 1, mergeWindowMs: 0, cooldownMs: 0, rejectionCooldownMs: 1000, maxDecisionsPerGoal: 1, maxExecutionsPerGoal: 0, maxRemindersPerGoal: 0 }
function decision() {
  const engine = new OpportunityEngine(':memory:', [profile])
  const input: OpportunityInput = { waitId: 'wait', profileId: 'prepare', scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: '/workspace', preset: 'standard' }, goalId: 'goal', sessionId: 'owner-session', definitionDigest: 'definition', objective: 'Prepare working code.\nKeep the owner constraints.', nativeGoalId: 'native-goal', nativeRevision: 2, ownerRouteId: 'route', sourceDigest: 'source-digest', sourceId: 'event-triggers:file', event: { id: 'event', sequence: 1, digest: 'event-digest', occurredAt: Date.now() }, expiresAt: Date.now() + 60_000 }
  try { return engine.evaluate(input).decision } finally { engine.close() }
}
async function path() { const root = await mkdtemp(join(tmpdir(), 'proactive-preparation-')); roots.push(root); return join(root, 'preparations.sqlite') }

it('persists a generated draft and never repeats completed or interrupted paid work after restart', async () => {
  const database = await path(); const store = new PreparationStore(database); const value = decision()
  const ctx = new Context(); contexts.push(ctx)
  const run = vi.fn(async () => ({ outcome: 'succeeded', output: 'export const answer = 42;', usage: { outputTokens: 7 }, sessionId: 'independent-preparation', quiescent: true }))
  ctx.provide('assistantAutomations' as never, { runPreparation: run } as never)
  ctx.provide('assistantGoals' as never, { assertPreparationCurrent: vi.fn() } as never)
  const runtime = new PreparationRuntime(ctx, store)
  store.enqueue(value, settings)
  await runtime.tick(); store.enqueue(value, settings); await runtime.tick()
  expect(run).toHaveBeenCalledOnce()
  expect(store.get(value.id)).toMatchObject({ state: 'draft', reason: 'unverified-draft', result: { output: 'export const answer = 42;' } })
  const other = { ...value, id: 'interrupted' }
  store.enqueue(other, settings); store.claim(other.id)
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  const reopened = new PreparationStore(database)
  try {
    expect(reopened.get(value.id)).toMatchObject({ state: 'draft', result: { sessionId: 'independent-preparation' } })
    expect(reopened.get(other.id)).toMatchObject({ state: 'unknown', reason: 'process-interrupted' })
    expect(reopened.pending()).toHaveLength(0)
  } finally { reopened.close() }
})

it('does not call the model after goal authority is lost or a queued preparation deadline passes', async () => {
  const ctx = new Context(); contexts.push(ctx); const store = new PreparationStore(':memory:')
  const run = vi.fn(); const current = vi.fn((): void => { throw new Error('goal changed') })
  ctx.provide('assistantAutomations' as never, { runPreparation: run } as never)
  ctx.provide('assistantGoals' as never, { assertPreparationCurrent: current } as never)
  const runtime = new PreparationRuntime(ctx, store); const value = decision()
  store.enqueue(value, settings); await runtime.tick()
  expect(store.get(value.id)?.state).toBe('cancelled'); expect(run).not.toHaveBeenCalled()
  current.mockImplementation(() => {})
  store.enqueue({ ...value, id: 'quiet' }, settings, Date.now() - 1); await runtime.tick()
  expect(store.get('quiet')?.state).toBe('cancelled'); expect(run).not.toHaveBeenCalled()
})

it('fences a late result after owner rejection without changing an existing draft', () => {
  const store = new PreparationStore(':memory:'); const value = decision()
  try {
    store.enqueue(value, settings); const running = store.claim(value.id)!
    store.cancel(value.id)
    store.finish(running, 'draft', { outcome: 'succeeded', output: 'late', usage: {}, quiescent: true })
    expect(store.get(value.id)).toMatchObject({ state: 'cancelled' })
    expect(store.get(value.id)?.result).toBeUndefined()
  } finally { store.close() }
})

it('retains failed runner diagnostics across restart without retrying the paid intent', async () => {
  const database = await path(); const store = new PreparationStore(database); const value = decision()
  const ctx = new Context(); contexts.push(ctx)
  const result = { outcome: 'unknown', output: '[unverified-draft] No usable draft was produced.', usage: {}, sessionId: 'failed-preparation', quiescent: false,
    diagnostic: { failureClass: 'configuration', failurePhase: 'agent-setup', failureCode: 'agent-setup-failed' } }
  const run = vi.fn(async () => result)
  ctx.provide('assistantAutomations' as never, { runPreparation: run } as never)
  ctx.provide('assistantGoals' as never, { assertPreparationCurrent: vi.fn() } as never)
  const runtime = new PreparationRuntime(ctx, store)
  store.enqueue(value, settings); await runtime.tick(); await runtime.tick()
  expect(run).toHaveBeenCalledOnce()
  expect(store.get(value.id)).toMatchObject({ state: 'unknown', result })
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  const reopened = new PreparationStore(database)
  try { expect(reopened.get(value.id)).toMatchObject({ state: 'unknown', result }); expect(reopened.pending()).toHaveLength(0) }
  finally { reopened.close() }
})
