import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantAutomationsService } from '../src/service.ts'
import type { AutomationStore } from '../src/store.ts'
import type { HostAutomationDefinition } from '../src/types.ts'

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function setup(schedulerEnabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-scheduler-wake-'))
  const ctx = new Context()
  fixtures.push({ ctx, root })
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'scan-budget', metric: 'automation-runs', limit: 10, periodMs: 60_000, scope: 'subject' }],
    rules: [{ id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'scanner' },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } }],
  })
  const config = { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled,
    tickIntervalMs: 1_000, reconcileIntervalMs: 0 }
  const provider = ctx.plugin(AssistantAutomationsService, config)
  await provider
  return { ctx, provider, config, service: ctx.assistantAutomations }
}

function definition(): HostAutomationDefinition {
  return { name: 'Dormant scanner', schedule: { kind: 'at', at: '2035-01-01T00:00:00.000Z' },
    workspace: '/engineering', agentPreset: 'probe', timeoutMs: 30_000, misfire: { kind: 'latest' }, overlap: 'skip',
    retrySafety: 'never', maxRetries: 0, principal: 'engineering/probe', budgetId: 'scan-budget', budgetAmount: 1,
    execution: { kind: 'host', executorId: 'scanner', executorContractVersion: 1, runbookId: 'probe', runbookVersion: 1,
      catalogDigest: 'a'.repeat(64), targetScope: { workspace: '/engineering', preset: 'probe' },
      scopeDigest: 'b'.repeat(64), ownerRouteId: 'engineering-route', activationNonce: 'scanner-generation' } }
}

test('native manual ticks recover bounded initialization before materialization and isolate listener failures', async () => {
  const { ctx, service } = await setup()
  const store = (service as unknown as { store: AutomationStore }).store
  const reserve = vi.spyOn(ctx.assistantPolicy, 'reserve')
  const inspect = vi.spyOn(store, 'inspectSystemOwnedRetirement')
    .mockImplementationOnce(() => { throw new Error('temporary retirement read failure') })
  const reconcile = vi.spyOn(store, 'reconcileSystemOwned')
    .mockImplementationOnce(() => { throw new Error('temporary reconcile failure') })
  const materialize = vi.spyOn(store, 'materializeDue')
  const healthy = vi.fn()
  const broken = vi.fn(() => { throw new Error('independent wake listener failed') })
  service.onSchedulerWake(broken)
  const asynchronous = vi.fn(async () => { throw new Error('unsupported async observer failed') })
  service.onSchedulerWake(asynchronous)
  let initialized = false
  let attempts = 0
  const unregister = service.onSchedulerWake(() => {
    if (initialized) return
    attempts++
    if (service.inspectSystemOwnedRetirement({ owner: 'scanner', automationId: 'new-scan' })) return
    service.reconcileSystem({ owner: 'scanner', automationId: 'new-scan', idempotencyKey: 'initialize',
      desiredStatus: 'paused', definition: definition() })
    initialized = true
  })
  service.onSchedulerWake(healthy)
  await service.tick()
  expect(attempts).toBe(1)
  expect(initialized).toBe(false)
  expect(store.list()).toEqual([])
  await service.tick()
  expect(attempts).toBe(2)
  expect(initialized).toBe(false)
  expect(store.list()).toEqual([])
  await service.tick()
  expect(attempts).toBe(3)
  expect(initialized).toBe(true)
  expect(store.get('new-scan')?.status).toBe('paused')
  expect(reconcile.mock.invocationCallOrder[1]).toBeLessThan(materialize.mock.invocationCallOrder[2]!)
  await service.tick()
  expect(attempts).toBe(3)
  expect(healthy).toHaveBeenCalledTimes(4)
  expect(broken).toHaveBeenCalledTimes(4)
  expect(inspect).toHaveBeenCalledTimes(4) // three consumer reads plus the successful reconcile fence
  unregister()
  unregister()
  await service.tick()
  expect(attempts).toBe(3)
  expect(healthy).toHaveBeenCalledTimes(5)
  expect(asynchronous).toHaveBeenCalledTimes(5)
  expect(materialize).toHaveBeenCalledTimes(5)
  expect(reserve).not.toHaveBeenCalled()
  expect(store.listTasks({ limit: 10 })).toEqual([])
  expect(store.listOccurrences({ limit: 10 })).toEqual([])
  expect(store.listRuns({ limit: 10 })).toEqual([])
})

test('existing automatic scheduler ticks notify without creating work or budget reservations', async () => {
  const { ctx, service, provider } = await setup(true)
  const reserve = vi.spyOn(ctx.assistantPolicy, 'reserve')
  const listener = vi.fn()
  service.onSchedulerWake(listener)
  await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 3_000, interval: 20 })
  expect(reserve).not.toHaveBeenCalled()
  const store = (service as unknown as { store: AutomationStore }).store
  expect(store.list()).toEqual([])
  expect(store.listTasks({ limit: 10 })).toEqual([])
  await provider.dispose()
  const count = listener.mock.calls.length
  await expect(service.tick()).rejects.toThrow(/disposed/)
  expect(() => service.onSchedulerWake(listener)).toThrow(/disposed/)
  expect(listener).toHaveBeenCalledTimes(count)
})

test('Cordis use-site disposal and provider reinjection keep independent registrations bounded', async () => {
  const { ctx, service, provider, config } = await setup()
  const listener = vi.fn()
  let mounts = 0
  const consumer = () => ctx.plugin({ name: `wake-consumer-${++mounts}`, inject: ['assistantAutomations'], apply(owner: Context) {
    owner.assistantAutomations.onSchedulerWake(listener)
  } })
  const first = consumer()
  const second = consumer()
  await first
  await second
  await service.tick()
  expect(listener).toHaveBeenCalledTimes(2)
  await first.dispose()
  await service.tick()
  expect(listener).toHaveBeenCalledTimes(3)
  await provider.dispose()
  await expect(service.tick()).rejects.toThrow(/disposed/)
  const nextProvider = ctx.plugin(AssistantAutomationsService, config)
  await nextProvider
  await second
  const replacement = ctx.assistantAutomations
  await replacement.tick()
  expect(listener).toHaveBeenCalledTimes(4)
  await second.dispose()
  await replacement.tick()
  expect(listener).toHaveBeenCalledTimes(4)
})
