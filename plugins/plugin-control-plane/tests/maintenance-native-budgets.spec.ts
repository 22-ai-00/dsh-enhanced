import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test, vi } from 'vitest'
import { AdoptionCoordinatorRuntime } from '../src/adoption-coordinator.ts'
import { TaskObservationRuntime } from '../src/task-observation-runtime.ts'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test('native coordinator and observation crons finalize one budgeted run and do not enter either executor after exhaustion', async () => {
  let now = Date.UTC(2026, 8, 20, 12, 0, 5); vi.spyOn(Date, 'now').mockImplementation(() => now)
  const root = await mkdtemp(join(tmpdir(), 'cp-native-maintenance-')); roots.push(root)
  const ctx = new Context()
  const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), budgets: [
    { id: 'adoption-runs', metric: 'automation-runs', limit: 1, periodMs: 86_400_000, scope: 'subject' },
    { id: 'observation-runs', metric: 'automation-runs', limit: 1, periodMs: 86_400_000, scope: 'subject' },
  ], rules: [
    { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: '*', workspace: '/workspace', principal: 'owner' }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: '/workspace', principal: 'owner' }, actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
  ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const coordinatorStore = { listAdoptionHandoffs: vi.fn(() => []), close: vi.fn() }
  const observationStore = { listTaskObservations: vi.fn(() => []), listObservedForegroundDeployments: vi.fn(() => []), close: vi.fn() }
  const owner = { receiptVersion: 2 as const, authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const coordinator = new AdoptionCoordinatorRuntime({ config: { coordinatorId: 'coordinator', scope: { workspace: '/workspace', preset: 'primary', principalId: 'owner', ownerRouteId: 'route' }, timeoutMs: 1_000, budgetId: 'adoption-runs', budgetAmount: 1 }, store: coordinatorStore as never, trust: {} as never, automations, assertCurrent() {} })
  const observation = new TaskObservationRuntime({ config: { policy: { id: 'policy', expiresAt: now + 86_400_000, maximumObservations: 1, minimumChecks: 1, maximumChecks: 1, lookbackMs: 1_000 }, scope: { ownerRouteId: 'route', principalId: 'owner', workspace: '/workspace', preset: 'primary' }, profilePath: '/workspace/profile', timeoutMs: 1_000, budgetId: 'observation-runs', budgetAmount: 1, authority: { executable: { path: '/bin/true', sha256: 'a'.repeat(64) }, configPath: '/tmp/authority', timeoutMs: 1_000 } }, store: observationStore as never, trust: {} as never,
    evaluation: { canonicalHostScope: value => value as never, getTrustedForegroundLearningProjection: () => undefined, withTrustedCanonicalTaskWriterFence: (_input, callback) => ({ matched: true, value: callback() }), onTrustedTaskChange: () => () => {} },
    delivery: { validateOwnerRoute: () => owner, inspectOwnerForegroundLearningTask: () => undefined }, automations, assertCurrent() {}, rollback: async () => {} })
  const reserve = vi.spyOn(policy, 'reserve')
  coordinator.start(); observation.start()
  observationStore.listTaskObservations.mockClear()
  const lanes = ['plugin-control-plane-adoption-coordinator', 'plugin-control-plane-task-observations']
    .map(owner => ({ owner, automationId: automations.listSystemOwned({ owner })[0]!.automationId }))
  const drain = async () => {
    // The default native runner admits one occurrence per tick.
    for (let i = 0; i < lanes.length; i++) { await automations.tick(); await automations.whenIdle() }
  }
  try {
    now += 60_000; await drain()
    expect(coordinatorStore.listAdoptionHandoffs).toHaveBeenCalledTimes(1)
    expect(observationStore.listTaskObservations).toHaveBeenCalledTimes(2)
    for (const lane of lanes) expect(automations.inspectSystemOwned(lane).latestTerminalRuns.production)
      .toMatchObject({ status: 'succeeded', diagnostic: { budgetSettlementState: 'finalized' } })
    now += 60_000; await drain()
    expect(coordinatorStore.listAdoptionHandoffs).toHaveBeenCalledTimes(1)
    expect(observationStore.listTaskObservations).toHaveBeenCalledTimes(2)
    const failures = reserve.mock.results.filter(result => result.type === 'throw').map(result => result.value)
    expect(failures).toEqual([expect.objectContaining({ code: 'budget-exhausted' }), expect.objectContaining({ code: 'budget-exhausted' })])
    for (const lane of lanes) expect(automations.inspectSystemOwned(lane).latestTerminalRuns.production)
      .toMatchObject({ diagnostic: { budgetSettlementState: 'not-reserved' } })
  } finally { await coordinator.close(); await observation.close(); await ctx.fiber.dispose() }
})
