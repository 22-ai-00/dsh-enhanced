import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test } from 'vitest'
import { AssistantAutomationsService } from '../src/service.ts'
import { listAutomationsLocally } from '../src/operator.ts'
import type { HostAutomationDefinition } from '../src/types.ts'

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

const defaults = { provider: 'test', model: 'test', allowedTools: [], timeoutMs: 30_000, maxOutputTokens: 32,
  maxToolCalls: 0, misfireKind: 'latest' as const, misfireLimit: 1, overlap: 'skip' as const,
  retrySafety: 'never' as const, maxRetries: 0, budgetId: 'host-budget', budgetAmount: 1 }

function definition(nonce: string): HostAutomationDefinition {
  return { name: 'Owned Host registration', schedule: { kind: 'at', at: '2035-01-01T00:00:00.000Z' },
    workspace: '/engineering', agentPreset: 'probe', timeoutMs: 30_000, misfire: { kind: 'latest' }, overlap: 'skip',
    retrySafety: 'never', maxRetries: 0, principal: 'engineering/probe', budgetId: 'host-budget', budgetAmount: 1,
    execution: { kind: 'host', executorId: 'shutdown-probe', executorContractVersion: 1,
      runbookId: 'probe', runbookVersion: 1, catalogDigest: 'a'.repeat(64),
      targetScope: { workspace: '/engineering', preset: 'probe' }, scopeDigest: 'b'.repeat(64),
      ownerRouteId: 'engineering-route', activationNonce: nonce } }
}

async function setup() {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'assistant-host-shutdown-')))
  const ctx = new Context()
  fixtures.push({ ctx, root })
  const databasePath = join(root, 'automations.sqlite')
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'host-budget', metric: 'automation-runs', limit: 10, periodMs: 60_000, scope: 'subject' }],
    rules: [{ id: 'allow-host-reconcile', effect: 'allow', subject: { kind: 'background', id: '*' },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } }],
  })
  const config = { databasePath, runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0,
    allowUnbudgetedExecution: false, proposalDefaults: defaults }
  const provider = ctx.plugin(AssistantAutomationsService, config)
  await provider
  return { ctx, root, databasePath, provider, config }
}

function consumer(ctx: Context, id: string) {
  let generation = 0
  return ctx.plugin({ name: `shutdown-consumer-${id}`, inject: ['assistantAutomations'], apply(owner: Context) {
    const service = owner.get('assistantAutomations') as AssistantAutomationsService
    const nonce = `${id}-generation-${++generation}`
    const current = definition(nonce)
    const registered = service.reconcileSystem({ owner: id, automationId: id, idempotencyKey: `${id}:active:${generation}`, desiredStatus: 'active', definition: current })
    expect(registered.status).toBe('active')
    expect(registered.definition.execution?.activationNonce).toBe(nonce)
    expect(service.inspectSystemOwnedActivation({ owner: id, automationId: id })?.activationNonce).toBe(nonce)
    return service.registerHostShutdown(owner, { owner: id, automationId: id, activationNonce: nonce }, () => {})
  } })
}

test('pinned Cordis root disposal pauses the owner registration before provider closes', async () => {
  const { ctx, databasePath } = await setup()
  const owned = consumer(ctx, 'owned')
  await owned
  const service = ctx.get('assistantAutomations') as AssistantAutomationsService
  service.reconcileSystem({ owner: 'other', automationId: 'other', idempotencyKey: 'other:active',
    desiredStatus: 'active', definition: definition('other-generation') })
  expect(listAutomationsLocally(databasePath).map(item => [item.id, item.status])).toEqual([['other', 'active'], ['owned', 'active']])
  await ctx.fiber.dispose()
  expect(listAutomationsLocally(databasePath).map(item => [item.id, item.status])).toEqual([['other', 'active'], ['owned', 'paused']])
})

test('consumer-only unload and provider replacement pause once without leaking old callback', async () => {
  const { ctx, databasePath, provider, config } = await setup()
  const first = consumer(ctx, 'owned')
  await first
  await first.dispose()
  expect(listAutomationsLocally(databasePath).find(item => item.id === 'owned')?.status).toBe('paused')
  const second = consumer(ctx, 'replacement')
  await second
  await provider.dispose()
  expect(listAutomationsLocally(databasePath).find(item => item.id === 'replacement')?.status).toBe('paused')
  const nextProvider = ctx.plugin(AssistantAutomationsService, config)
  await nextProvider
  await second
  expect(listAutomationsLocally(databasePath).find(item => item.id === 'replacement')?.status).toBe('active')
  await second.dispose()
  expect(listAutomationsLocally(databasePath).find(item => item.id === 'replacement')?.status).toBe('paused')
})

test('rejected Host shutdown callback cannot skip provider resource closure', async () => {
  const { ctx, databasePath } = await setup()
  const owner = ctx.plugin({ name: 'rejected-host-shutdown', inject: ['assistantAutomations'], apply(child: Context) {
    const service = child.get('assistantAutomations') as AssistantAutomationsService
    service.reconcileSystem({ owner: 'broken', automationId: 'broken', idempotencyKey: 'broken:active',
      desiredStatus: 'active', definition: definition('broken-generation') })
    service.registerHostShutdown(child, { owner: 'broken', automationId: 'broken', activationNonce: 'broken-generation' },
      () => { throw new Error('test Host close failed') })
  } })
  await owner
  await ctx.fiber.dispose()
  expect(listAutomationsLocally(databasePath).find(item => item.id === 'broken')?.status).toBe('paused')
})

test('provider rejects new registrations as soon as shutdown begins', async () => {
  const { ctx, provider } = await setup()
  let release!: () => void
  let entered!: () => void
  const callbackEntered = new Promise<void>(resolve => { entered = resolve })
  const callbackRelease = new Promise<void>(resolve => { release = resolve })
  const owner = ctx.plugin({ name: 'held-host-shutdown', inject: ['assistantAutomations'], apply(child: Context) {
    const service = child.get('assistantAutomations') as AssistantAutomationsService
    service.reconcileSystem({ owner: 'held', automationId: 'held', idempotencyKey: 'held:active',
      desiredStatus: 'active', definition: definition('held-generation') })
    service.registerHostShutdown(child, { owner: 'held', automationId: 'held', activationNonce: 'held-generation' }, async () => {
      entered()
      await callbackRelease
    })
  } })
  await owner
  const service = ctx.get('assistantAutomations') as AssistantAutomationsService
  const closing = provider.dispose()
  await callbackEntered
  expect(() => service.registerHostShutdown(ctx, { owner: 'held', automationId: 'held', activationNonce: 'held-generation' }, () => {}))
    .toThrow(/disposed/)
  expect(() => service.reconcileSystem({ owner: 'held', automationId: 'held', idempotencyKey: 'held:reactivate',
    desiredStatus: 'active', definition: definition('held-generation') })).toThrow(/disposed/)
  await expect(service.tick()).rejects.toThrow(/disposed/)
  expect(() => service.registerHostExecutor({ descriptor: { executorId: 'held', contractVersion: 1, catalogDigest: 'a'.repeat(64) },
    accepts: () => true, execute: async () => { throw new Error('must not execute') } })).toThrow(/disposed/)
  release()
  await closing
})

test('an old consumer shutdown cannot pause a newer nonce for the same owner and automation', async () => {
  const { ctx, databasePath } = await setup()
  let oldClosed = 0
  const older = ctx.plugin({ name: 'old-generation', inject: ['assistantAutomations'], apply(child: Context) {
    const service = child.get('assistantAutomations') as AssistantAutomationsService
    service.reconcileSystem({ owner: 'same', automationId: 'same', idempotencyKey: 'same:old',
      desiredStatus: 'active', definition: definition('old-nonce') })
    return service.registerHostShutdown(child, { owner: 'same', automationId: 'same', activationNonce: 'old-nonce' },
      () => { oldClosed++ })
  } })
  await older
  let newStop!: () => Promise<void>
  const newer = ctx.plugin({ name: 'new-generation', inject: ['assistantAutomations'], apply(child: Context) {
    const service = child.get('assistantAutomations') as AssistantAutomationsService
    service.reconcileSystem({ owner: 'same', automationId: 'same', idempotencyKey: 'same:new',
      desiredStatus: 'active', definition: definition('new-nonce') })
    newStop = service.registerHostShutdown(child, { owner: 'same', automationId: 'same', activationNonce: 'new-nonce' }, () => {})
  } })
  await newer
  await older.dispose()
  expect(oldClosed).toBe(1)
  expect(listAutomationsLocally(databasePath).find(item => item.id === 'same')?.status).toBe('active')
  await newStop()
  expect(listAutomationsLocally(databasePath).find(item => item.id === 'same')?.status).toBe('paused')
})

test('a never-settling Host callback reaches its deadline and closes the provider store', async () => {
  const { ctx, provider, databasePath } = await setup()
  const owner = ctx.plugin({ name: 'stuck-host-shutdown', inject: ['assistantAutomations'], apply(child: Context) {
    const service = child.get('assistantAutomations') as AssistantAutomationsService
    service.reconcileSystem({ owner: 'stuck', automationId: 'stuck', idempotencyKey: 'stuck:active',
      desiredStatus: 'active', definition: definition('stuck-generation') })
    return service.registerHostShutdown(child, { owner: 'stuck', automationId: 'stuck', activationNonce: 'stuck-generation' },
      () => new Promise<void>(() => {}))
  } })
  await owner
  const service = ctx.get('assistantAutomations') as AssistantAutomationsService
  const started = Date.now()
  await provider.dispose()
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_800)
  expect(() => service.health()).toThrow(/disposed/)
  expect(listAutomationsLocally(databasePath).find(item => item.id === 'stuck')?.status).toBe('paused')
  const reopened = new DatabaseSync(databasePath)
  try {
    reopened.exec('BEGIN EXCLUSIVE')
    reopened.exec('ROLLBACK')
  } finally { reopened.close() }
}, 8_000)
