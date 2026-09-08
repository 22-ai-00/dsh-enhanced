import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService, type AutomationDefinition } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EventSourceObservers, EVENT_OBSERVER_EXECUTOR, type EventObserverConfig } from '../src/observer.ts'
import { EventTriggerStore } from '../src/store.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(expiresAt = Date.now() + 60_000, lifetime: 'shared' | 'goal' = 'shared') {
  const root = await mkdtemp(join(tmpdir(), 'event-observer-'))
  roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  const route = { principalRecordId: 'record-1', principalVersion: 3, principalId: 'owner:one',
    workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1, authorityId: 'route-1',
    authorityHash: 'a'.repeat(64), receiptVersion: 2 as const }
  const validateOwnerRoute = vi.fn(() => Object.freeze({ ...route }))
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute } as never)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), budgets: [
    { id: 'event-runs', metric: 'automation-runs', limit: 5, periodMs: 60_000, scope: 'workspace' },
  ], rules: [{
    id: 'observer', effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: root, principal: 'owner:one' },
    actions: ['observe', 'reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] },
  }, {
    id: 'observer-execute', effect: 'allow', subject: { kind: 'background', id: 'github-source', workspace: root, principal: 'owner:one' },
    actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] },
  }, {
    id: 'event-ingest', effect: 'allow', subject: { kind: 'external', id: 'event-test', workspace: root },
    actions: ['ingest'], resource: { kind: 'automation', id: 'github-source' }, context: { initiators: ['external'] },
  }] })
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
    schedulerEnabled: false, reconcileIntervalMs: 0 })
  const owner: EventObserverConfig = { workspace: root, preset: 'primary', principalId: 'owner:one',
    principalRecordId: 'record-1', principalVersion: 3, ownerRouteId: 'route-1', expiresAt, budgetId: 'event-runs' }
  let observer!: EventSourceObservers
  let goal = { scope: { principalId: owner.principalId, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion, workspace: root, preset: owner.preset }, id: 'goal-one', definition: { version: 1, digest: 'c'.repeat(64) }, native: { sessionId: 'session-one', goalId: 'native-one', revision: 2, phase: 'paused' } }
  ctx.provide('assistantGoals' as never, { inspectGoalLifecycle: ({ scope, goalId }: { scope: unknown; goalId: string }) => JSON.stringify(scope) === JSON.stringify(goal.scope) && goalId === goal.id ? Object.freeze(goal) : undefined } as never)
  const store = new EventTriggerStore({ path: join(root, 'events.sqlite') })
  const mount = async () => ctx.plugin(runtime => { observer = new EventSourceObservers(runtime, [{ triggerId: 'github', automationId: 'github-source', configDigest: 'b'.repeat(64), owner, lifetime }], store) })
  const observerFiber = await mount()
  const claim = () => ({ triggerId: 'github', scope: goal.scope, goalId: goal.id, definition: goal.definition, native: { sessionId: goal.native.sessionId, goalId: goal.native.goalId, revision: 2 }, configDigest: 'b'.repeat(64), automationId: 'github-source' })
  return { ctx, root, observer, observerFiber, mount, route, validateOwnerRoute, claim,
    completeGoal: () => { goal = { ...goal, native: { ...goal.native, revision: 5, phase: 'complete' } } },
    setGoal: (value: typeof goal) => { goal = value } }
}

describe('EventSourceObservers', () => {
  test('rejects a changed definition even when another Host controller preserves its route and nonce', async () => {
    const f = await fixture()
    const db = new DatabaseSync(join(f.root, 'automations.sqlite'))
    let definition: AutomationDefinition
    try {
      const row = db.prepare('SELECT definition_json FROM automation_definitions WHERE id = ?').get('github-source') as { definition_json: string }
      definition = JSON.parse(row.definition_json) as AutomationDefinition
    } finally { db.close() }
    f.ctx.assistantAutomations.reconcileSystem({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source',
      idempotencyKey: 'other-controller', definition: { ...definition, timeoutMs: 25_000 } })
    expect(() => f.observer.assertCurrent('github')).toThrow(/paused|changed/)
    await f.observerFiber.restart()
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'paused' })
  })

  test('registers a real bounded Host definition without a model service', async () => {
    const f = await fixture()
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'active' })
    expect(f.validateOwnerRoute).toHaveBeenCalled()
  })

  test('pauses the exact owned automation after owner-route rebind or expiry', async () => {
    const f = await fixture()
    f.validateOwnerRoute.mockReturnValue({ ...f.route, generation: 2 })
    expect(() => f.observer.assertCurrent('github')).toThrow(/owner route changed/)
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'paused' })

    const expired = await fixture(Date.now() - 1)
    expect(() => expired.observer.assertCurrent('github')).toThrow(/expired/)
    expect(() => expired.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toThrow(/not found/)
  })

  test('rejects a receipt whose route scope no longer matches the frozen observer scope', async () => {
    const f = await fixture()
    f.validateOwnerRoute.mockReturnValue({ ...f.route, workspace: '/different-workspace' })
    expect(() => f.observer.assertCurrent('github')).toThrow(/owner route changed/)
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'paused' })
  })

  test('runs a persisted external event through the bounded Host executor without a model service', async () => {
    const f = await fixture()
    f.ctx.assistantAutomations.ingestExternal({ sourceId: 'event-test', automationId: 'github-source', eventId: 'event-1', occurredAt: 1 })
    await f.ctx.assistantAutomations.tick()
    await f.ctx.assistantAutomations.whenIdle()
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ latestTerminalRuns: { production: { status: 'succeeded', diagnostic: { failureCode: 'none' } } } })
  })

  test('keeps an unchanged persisted receipt across restart but pauses a rebound route instead of overwriting it', async () => {
    const f = await fixture()
    const before = f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' })
    await f.observerFiber.restart()
    const unchanged = f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' })
    expect(unchanged).toMatchObject({ automationStatus: 'active', definitionVersion: before.definitionVersion })

    f.validateOwnerRoute.mockReturnValue({ ...f.route, generation: 2 })
    await f.observerFiber.restart()
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'paused' })
  })

  test('retires only an explicitly claimed goal observer after its trusted completed lifecycle, including restart', async () => {
    const f = await fixture(Date.now() + 60_000, 'goal')
    const claim = f.claim()
    expect(f.observer.claimGoalSource(claim)).toBe(true)
    expect(() => f.observer.retireGoalSource(claim)).toThrow(/not trusted/)
    f.completeGoal()
    expect(f.observer.retireGoalSource(claim)).toBe(true)
    expect(() => f.observer.assertCurrent('github')).toThrow(/retired|changed/)
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'paused' })
    await f.observerFiber.restart()
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'paused' })
  })

  test('rejects a different goal or owner claim and leaves a shared source active', async () => {
    const dedicated = await fixture(Date.now() + 60_000, 'goal')
    const claimed = dedicated.claim()
    dedicated.observer.claimGoalSource(claimed)
    expect(dedicated.observer.claimGoalSource({ ...claimed, native: { ...claimed.native, revision: claimed.native.revision + 3 } })).toBe(true)
    expect(() => dedicated.observer.claimGoalSource({ ...claimed, goalId: 'other-goal' })).toThrow(/already claimed/)
    expect(() => dedicated.observer.claimGoalSource({ ...claimed, scope: { ...claimed.scope, principalId: 'other-owner' } })).toThrow(/does not match/)
    expect(dedicated.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'active' })

    const shared = await fixture()
    expect(shared.observer.claimGoalSource(shared.claim())).toBe(false)
    shared.completeGoal()
    expect(shared.observer.retireGoalSource(shared.claim())).toBe(false)
    expect(shared.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'github-source' }))
      .toMatchObject({ automationStatus: 'active' })
  })

  test('allows settlement only for the retired exact completed claim and rechecks current authority', async () => {
    const ready = await fixture(Date.now() + 60_000, 'goal'); const claim = ready.claim()
    ready.observer.claimGoalSource(claim); ready.completeGoal(); ready.observer.retireGoalSource(claim)
    expect(ready.observer.canSettleGoalSource(claim)).toBe(true)
    expect(ready.observer.canSettleGoalSource({ ...claim, goalId: 'other-goal' })).toBe(false)
    expect(ready.observer.canSettleGoalSource({ ...claim, configDigest: 'd'.repeat(64) })).toBe(false)

    const revoked = await fixture(Date.now() + 60_000, 'goal'); const revokedClaim = revoked.claim()
    revoked.observer.claimGoalSource(revokedClaim); revoked.completeGoal(); revoked.observer.retireGoalSource(revokedClaim)
    revoked.validateOwnerRoute.mockReturnValue({ ...revoked.route, generation: 2 })
    expect(revoked.observer.canSettleGoalSource(revokedClaim)).toBe(false)

    const denied = await fixture(Date.now() + 60_000, 'goal'); const deniedClaim = denied.claim()
    denied.observer.claimGoalSource(deniedClaim); denied.completeGoal(); denied.observer.retireGoalSource(deniedClaim)
    denied.ctx.assistantPolicy.setEmergencyStop({ enabled: true, actor: 'test', reason: 'deny settlement' })
    expect(denied.observer.canSettleGoalSource(deniedClaim)).toBe(false)

    const shared = await fixture(); expect(shared.observer.canSettleGoalSource(shared.claim())).toBe(false)
  })
})
