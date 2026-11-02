import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test, vi } from 'vitest'
import { dueOccurrences, nextOccurrence, previousOccurrence, validateSchedule } from '../src/schedule.ts'
import { AutomationStore, normalizeAutomationDefinition } from '../src/store.ts'
import { AssistantAutomationsService } from '../src/service.ts'
import type { HostAutomationDefinition } from '../src/types.ts'
const roots: string[] = [], cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'automations-external-')); roots.push(path); return path }
function definition(workspace: string): HostAutomationDefinition {
  return { name: 'External-only Host', schedule: { kind: 'external' }, workspace, agentPreset: 'primary', timeoutMs: 10000,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0, principal: 'owner:external', budgetId: 'runs', budgetAmount: 1,
    execution: { kind: 'host', executorId: 'external-test', executorContractVersion: 1, runbookId: 'external/v1', runbookVersion: 1,
      catalogDigest: 'a'.repeat(64), targetScope: { workspace, preset: 'primary' }, scopeDigest: '0'.repeat(64), ownerRouteId: 'owner/external', activationNonce: 'nonce' } }
}
test('external has exact shape and no next, prior or due calendar occurrence', () => {
  expect(validateSchedule({ kind: 'external' })).toEqual({ kind: 'external' })
  for (const value of [{ kind: 'external', at: '2030-01-01T00:00:00.000Z' }, { kind: 'external', expression: '*' }, { kind: 'external', [Symbol('extra')]: true }]) expect(() => validateSchedule(value)).toThrow()
  expect(nextOccurrence({ kind: 'external' }, 0)).toBeUndefined(); expect(previousOccurrence({ kind: 'external' }, Number.MAX_SAFE_INTEGER)).toBeUndefined()
  expect(dueOccurrences({ kind: 'external' }, 0, Number.MAX_SAFE_INTEGER, 100)).toEqual([])
})
test('ordinary Agent creation rejects external while old calendar bytes remain unchanged', () => {
  const { execution: _execution, ...control } = definition('/work/external')
  const agent = { ...control, prompt: 'observe', provider: 'mock', model: 'mock', allowedTools: [], maxToolCalls: 0, maxOutputTokens: 100 }
  expect(() => normalizeAutomationDefinition(agent)).toThrow(/require a Host/u)
  const calendar = { ...agent, schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' } }
  expect(normalizeAutomationDefinition(calendar)).toEqual(calendar)
})
test('create/reconcile/pause/restart/resume keep nextRunAt absent and manual lanes cannot create occurrences', async () => {
  const home = await root(), path = join(home, 'store.sqlite'); let store = new AutomationStore({ path, now: () => 1000 })
  const created = store.reconcileSystemOwned({ owner: 'test', automationId: 'external', idempotencyKey: 'seed', definition: definition(home) })
  expect(created.nextRunAt).toBeUndefined()
  expect(store.materializeDue({ now: 9000000000000, misfireGraceMs: 1000, maxCatchUp: 10 })).toEqual([])
  for (const dryRun of [false,true]) expect(() => store.createManual({ automationId: 'external', requestId: `manual-${dryRun}`, dryRun })).toThrow(/external/u)
  expect(store.listOccurrences({ limit: 100 })).toHaveLength(0)
  const paused = store.changeApproved({ automationId: created.id, operation: 'pause', expectedVersion: created.version, idempotencyKey: 'pause' })
  store.close(); store = new AutomationStore({ path, now: () => 2000 }); cleanups.push(() => store.close())
  expect(store.get(created.id)).toMatchObject({ status: 'paused' }); expect(store.get(created.id)?.nextRunAt).toBeUndefined()
  expect(() => store.ingestExternal({ automationId: created.id, externalEventId: 'paused', occurredAt: 2000 })).toThrow(/not active/u)
  const resumed = store.changeApproved({ automationId: created.id, operation: 'resume', expectedVersion: paused.version, idempotencyKey: 'resume' })
  expect(resumed.nextRunAt).toBeUndefined()
  expect(store.materializeDue({ now: 9000000000000, misfireGraceMs: 1000, maxCatchUp: 10 })).toEqual([])
  const first = store.ingestExternal({ automationId: created.id, externalEventId: 'legitimate', occurredAt: 2000 })
  expect(store.ingestExternal({ automationId: created.id, externalEventId: 'legitimate', occurredAt: 2000 }).id).toBe(first.id)
  expect(store.listOccurrences({ limit: 100 })).toHaveLength(1)
})
test('idle genuine Service reserves zero budget, manual dry refuses, one external event runs once', async () => {
  const home = await root(), ctx = new Context(); cleanups.push(() => ctx.fiber.restart())
  await ctx.plugin(AssistantPolicyService, { databasePath: join(home, 'policy.sqlite'), budgets: [{ id: 'runs', metric: 'automation-runs', limit: 10, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' }],
    rules: [{ id: 'host', effect: 'allow', subject: { kind: 'background', id: '*' }, actions: ['reconcile','execute','run-dry'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'events', effect: 'allow', subject: { kind: 'external', id: 'external-test' }, actions: ['ingest'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } }] })
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(home, 'automations.sqlite'), runsPath: join(home, 'runs'), schedulerEnabled: false })
  const service = ctx.assistantAutomations, execute = vi.fn(async () => ({ outcome: 'succeeded' as const, failureClass: 'none' as const, failurePhase: 'none' as const, failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const }))
  const dispose = service.registerHostExecutor({ descriptor: { executorId: 'external-test', contractVersion: 1, catalogDigest: 'a'.repeat(64) }, accepts: () => true, execute }); cleanups.push(dispose)
  const reserve = vi.spyOn(ctx.assistantPolicy, 'reserve'), finalize = vi.spyOn(ctx.assistantPolicy, 'finalize')
  service.reconcileSystem({ owner: 'test', automationId: 'external', idempotencyKey: 'seed', definition: definition(home) })
  for (let index = 0; index < 3; index++) { await service.tick(); await service.whenIdle() }
  expect(reserve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
  const current = service.inspectSystemOwned({ owner: 'test', automationId: 'external' })!
  await expect(service.runSystemDry({ owner: 'test', automationId: 'external', definitionHash: current.definitionHash, idempotencyKey: 'dry' })).rejects.toThrow(/external/u)
  expect(reserve).not.toHaveBeenCalled()
  const input = { sourceId: 'external-test', automationId: 'external', eventId: 'event-1', occurredAt: Date.now() }
  const occurrence = service.ingestExternal(input); expect(service.ingestExternal(input).id).toBe(occurrence.id)
  await service.tick(); await service.whenIdle(); await service.tick(); await service.whenIdle()
  expect(execute).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1); expect(finalize).toHaveBeenCalledTimes(1)
})

test.each(['manual-next','manual-direct','scheduled-next','scheduled-direct'] as const)('rejects a stale %s occurrence after calendar becomes external', async lane => {
  const home = await root(), store = new AutomationStore({ path: join(home, 'store.sqlite'), now: () => 1000 }); cleanups.push(() => store.close())
  store.reconcileSystemOwned({ owner: 'test', automationId: 'external', idempotencyKey: 'calendar', definition: { ...definition(home), schedule: { kind: 'at', at: '1970-01-01T00:00:01.000Z' } } })
  if (lane.startsWith('manual')) store.createManual({ automationId: 'external', requestId: 'old-manual', dryRun: false })
  else store.materializeDue({ now: 1000, misfireGraceMs: 1000, maxCatchUp: 10, hostAvailability: [{ automationId: 'external', definitionHash: store.getDefinitionHash('external')!, stage: 'materialize', available: true, reasonCode: 'host-executor-available' }] })
  const pending = store.listTasks({ limit: 10 })[0]!
  expect(pending.status).toBe('scheduled')
  store.reconcileSystemOwned({ owner: 'test', automationId: 'external', idempotencyKey: 'external', definition: definition(home) })
  expect(() => store.createManual({ automationId: 'external', requestId: 'old-manual', dryRun: false })).toThrow(/external/u)
  const duty = store.acquireDuty({ ownerId: 'runner', now: 1000, leaseMs: 10000 })
  const input = { ownerId: 'runner', fencingToken: duty.fencingToken, now: 1000, leaseMs: 10000,
    hostAvailability: [{ automationId: 'external', definitionHash: store.getDefinitionHash('external')!, stage: 'claim' as const, available: true, reasonCode: 'host-executor-available' }] }
  expect(lane.endsWith('next') ? store.claimNextTask(input) : store.claimTask({ ...input, taskId: pending.id })).toBeUndefined()
  expect(store.getTaskRecord(pending.id)).toMatchObject({ status: 'scheduled', attemptCount: 0 })
})
