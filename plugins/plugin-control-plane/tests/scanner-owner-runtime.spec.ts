import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService, type HostAutomationExecutorInput } from '@dsh-enhanced/assistant-automations'
import type { OwnerRouteStateInspection } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test, vi } from 'vitest'
import { LiveQualificationRuntime } from '../src/live-qualification-runtime.ts'
import { TaskObservationRuntime } from '../src/task-observation-runtime.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture(kind: 'observation' | 'qualification') {
  const root = await mkdtemp(join(tmpdir(), 'cp-scanner-owner-'))
  const ctx = new Context()
  new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), budgets: [
    { id: 'scan-budget', metric: 'automation-runs', limit: 10, periodMs: 86_400_000, scope: 'subject' }], rules: [
    { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: 'owner' },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: 'owner' },
      actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
  ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'),
    runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const owner = { receiptVersion: 2 as const, authorityId: 'route', authorityHash: 'a'.repeat(64),
    principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root,
    agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  let state: OwnerRouteStateInspection = { status: 'active', receipt: owner }
  const delivery = { validateOwnerRoute: () => owner, inspectOwnerRouteState: () => state,
    inspectOwnerForegroundLearningTask: () => undefined }
  const store = { listTaskObservations: vi.fn(() => []), listObservedForegroundDeployments: vi.fn(() => []),
    listLiveQualificationPlans: vi.fn(() => []), close: vi.fn(), staleTaskObservation: vi.fn(),
    staleLiveQualification: vi.fn(), invalidateLiveQualification: vi.fn(), requestActivationRollback: vi.fn() }
  const evaluation = { canonicalHostScope: (value: unknown) => value as never,
    getTrustedForegroundLearningProjection: () => undefined,
    withTrustedCanonicalTaskWriterFence: <T>(_input: unknown, callback: () => T) => ({ matched: true as const, value: callback() }),
    onTrustedTaskChange: () => () => {} }
  const request = vi.fn(), rollback = vi.fn()
  const config = { scope: { ownerRouteId: 'route', principalId: 'owner', workspace: root, preset: 'primary' },
    profilePath: join(root, 'profile'), timeoutMs: 1000, budgetId: 'scan-budget', budgetAmount: 1,
    authority: { executable: { path: '/bin/true', sha256: 'b'.repeat(64) }, configPath: join(root, 'authority.json'), timeoutMs: 1000 } }
  const registration = vi.spyOn(automations, 'registerHostExecutor')
  const reconciliation = vi.spyOn(automations, 'reconcileSystem')
  const runtimes: (TaskObservationRuntime | LiveQualificationRuntime)[] = []
  const create = () => {
    const common = { config, store: store as never, trust: {} as never, delivery, evaluation, automations, assertCurrent() {}, request }
    const runtime = kind === 'observation'
      ? new TaskObservationRuntime({ ...common, config: { ...config, policy: { id: 'policy', expiresAt: Date.now() + 60000,
        maximumObservations: 1, minimumChecks: 1, maximumChecks: 1, lookbackMs: 1000 } }, rollback })
      : new LiveQualificationRuntime({ ...common, assertRuntime() {}, runtimeAvailable: () => true,
        qualificationSource: () => { throw new Error('must not inspect historical source') } })
    runtimes.push(runtime); runtime.start(); return runtime
  }
  const identity = () => automations.listSystemOwned({ owner: kind === 'observation'
    ? 'plugin-control-plane-task-observations' : 'plugin-control-plane-live-qualification' })[0]!
  const execute = () => {
    const current = identity(), activation = automations.inspectSystemOwnedActivation(current)!
    const executor = registration.mock.calls.at(-1)![0]
    return executor.execute({ automationId: current.automationId, executionMode: 'production',
      activationNonce: activation.activationNonce, definitionHash: activation.definitionHash,
      catalogDigest: executor.descriptor.catalogDigest, ownerRouteId: owner.authorityId,
      principal: owner.principalId, targetScope: { workspace: root, preset: 'primary' },
      signal: new AbortController().signal } as HostAutomationExecutorInput)
  }
  cleanups.push(async () => { for (const runtime of runtimes) await runtime.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { owner, store, create, execute, automations, registration, reconciliation, identity, request, rollback,
    revoke: () => { state = { status: 'revoked', ...owner } },
    unavailable: () => { state = { status: 'unavailable', reason: 'missing-binding' } },
    restore: () => { state = { status: 'active', receipt: owner } } }
}

test.each(['observation', 'qualification'] as const)('%s retires at revoked startup and never reactivates after owner ABA', async kind => {
  const f = await fixture(kind), first = f.create(), identity = f.identity()
  await first.close(); f.reconciliation.mockClear(); f.registration.mockClear()
  f.store.listTaskObservations.mockClear(); f.store.listLiveQualificationPlans.mockClear()
  f.revoke(); const revoked = f.create()
  expect(revoked.health().connected).toBe(false)
  expect(f.automations.inspectSystemOwnedRetirement(identity)).toMatchObject({ reason: 'owner-revoked', automationStatus: 'paused' })
  f.restore(); const restarted = f.create(); restarted.scan()
  expect(restarted.health().connected).toBe(false)
  expect(f.reconciliation).not.toHaveBeenCalled()
  expect(f.registration).not.toHaveBeenCalled()
  expect(f.store.listTaskObservations).not.toHaveBeenCalled()
  expect(f.store.listLiveQualificationPlans).not.toHaveBeenCalled()
})

test.each(['observation', 'qualification'] as const)('%s dispatch rejects revocation before mutable work or unknown classification', async kind => {
  const f = await fixture(kind); f.create(); const identity = f.identity()
  f.store.listTaskObservations.mockClear(); f.store.listLiveQualificationPlans.mockClear()
  f.revoke()
  expect(await f.execute()).toMatchObject({ outcome: 'failed', sideEffectState: 'none' })
  expect(f.automations.inspectSystemOwnedRetirement(identity)).toBeDefined()
  expect(f.request).not.toHaveBeenCalled(); expect(f.rollback).not.toHaveBeenCalled()
  expect(f.store.listTaskObservations).not.toHaveBeenCalled(); expect(f.store.listLiveQualificationPlans).not.toHaveBeenCalled()
  expect(f.store.staleTaskObservation).not.toHaveBeenCalled(); expect(f.store.requestActivationRollback).not.toHaveBeenCalled()
})

test.each(['observation', 'qualification'] as const)('%s keeps native recovery on temporary unavailability and blocks work when retirement fails', async kind => {
  const f = await fixture(kind), runtime = f.create(), identity = f.identity()
  f.unavailable(); runtime.scan()
  expect(f.automations.inspectSystemOwnedRetirement(identity)).toBeUndefined()
  f.restore(); runtime.scan()
  expect(runtime.health().lastError).toBeNull()
  f.revoke()
  const retirement = vi.spyOn(f.automations, 'retireSystemOwned').mockImplementation(() => { throw new Error('policy-denied') })
  expect(await f.execute()).toMatchObject({ outcome: 'failed', sideEffectState: 'none' })
  expect(f.automations.inspectSystemOwnedRetirement(identity)).toBeUndefined()
  expect(runtime.health().lastError).toContain('policy-denied')
  expect(f.request).not.toHaveBeenCalled(); expect(f.rollback).not.toHaveBeenCalled()
  retirement.mockRestore()
})


test.each(['observation', 'qualification'] as const)('%s startup temporary unavailability recovers in the same instance on the native cron', async kind => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(kind); f.unavailable(); const runtime = f.create(), identity = f.identity()
  expect(identity.automationStatus).toBe('active')
  expect(f.store.listTaskObservations).not.toHaveBeenCalled(); expect(f.store.listLiveQualificationPlans).not.toHaveBeenCalled()
  expect(f.automations.inspectSystemOwnedRetirement(identity)).toBeUndefined()
  f.restore(); vi.setSystemTime(Date.now() + 60_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(runtime.health().lastError).toBeNull()
  expect(f.automations.inspectSystemOwned(identity).latestTerminalRuns.production?.status).toBe('succeeded')
  if (kind === 'observation') expect(f.store.listTaskObservations).toHaveBeenCalled()
  else expect(f.store.listLiveQualificationPlans).toHaveBeenCalled()
})


test.each(['observation', 'qualification'] as const)('%s does not create a missing scanner for an explicitly revoked owner', async kind => {
  const f = await fixture(kind); f.revoke(); const runtime = f.create()
  expect(runtime.health().connected).toBe(false)
  expect(f.identity()).toBeUndefined()
  expect(f.registration).not.toHaveBeenCalled(); expect(f.reconciliation).not.toHaveBeenCalled()
  expect(f.request).not.toHaveBeenCalled(); expect(f.rollback).not.toHaveBeenCalled()
})


test.each(['observation', 'qualification'] as const)('%s startup retirement read outage retains a fresh native cron recovery entrance', async kind => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(kind)
  const inspection = vi.spyOn(f.automations, 'inspectSystemOwnedRetirement')
    .mockImplementation(() => { throw new Error('temporary retirement read unavailable') })
  const runtime = f.create()
  expect(f.identity().automationStatus).toBe('active')
  expect(f.store.listTaskObservations).not.toHaveBeenCalled(); expect(f.store.listLiveQualificationPlans).not.toHaveBeenCalled()
  inspection.mockRestore(); vi.setSystemTime(Date.now() + 60_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(runtime.health().lastError).toBeNull()
  expect(f.automations.inspectSystemOwned(f.identity()).latestTerminalRuns.production?.status).toBe('succeeded')
  expect(f.request).not.toHaveBeenCalled(); expect(f.rollback).not.toHaveBeenCalled()
})


test.each(['observation', 'qualification'] as const)('%s silently recovers failed fresh scanner registration on the native scheduler wake', async kind => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture(kind)
  const inspection = vi.spyOn(f.automations, 'inspectSystemOwnedRetirement')
    .mockImplementation(() => { throw new Error('SQLITE_BUSY retirement inspection') })
  const reconciliation = vi.spyOn(f.automations, 'reconcileSystem')
    .mockImplementation(() => { throw new Error('SQLITE_BUSY scanner registration') })
  f.create()
  expect(f.identity()).toBeUndefined()
  inspection.mockRestore(); reconciliation.mockRestore()
  vi.setSystemTime(Date.now() + 1000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.identity().automationStatus).toBe('active')
  expect(f.store.listTaskObservations).not.toHaveBeenCalled(); expect(f.store.listLiveQualificationPlans).not.toHaveBeenCalled()
  vi.setSystemTime(Date.now() + 60_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.automations.inspectSystemOwned(f.identity()).latestTerminalRuns.production?.status).toBe('succeeded')
})


test.each(['observation', 'qualification'] as const)('%s close unregisters native scheduler recovery while the service continues ticking', async kind => {
  const f = await fixture(kind)
  const onWake = f.automations.onSchedulerWake.bind(f.automations), disposers: ReturnType<typeof vi.fn>[] = []
  vi.spyOn(f.automations, 'onSchedulerWake').mockImplementation(listener => {
    const dispose = vi.fn(onWake(listener)); disposers.push(dispose); return dispose
  })
  const inspection = vi.spyOn(f.automations, 'inspectSystemOwnedRetirement')
    .mockImplementation(() => { throw new Error('SQLITE_BUSY retirement inspection') })
  const reconciliation = vi.spyOn(f.automations, 'reconcileSystem')
    .mockImplementation(() => { throw new Error('SQLITE_BUSY scanner registration') })
  const runtime = f.create(); await runtime.close()
  expect(disposers).toHaveLength(1); expect(disposers[0]).toHaveBeenCalledOnce()
  inspection.mockRestore(); reconciliation.mockRestore()
  const restored = vi.spyOn(f.automations, 'reconcileSystem')
  await f.automations.tick(); await f.automations.whenIdle()
  expect(restored).not.toHaveBeenCalled()
  expect(f.identity()).toBeUndefined()
  expect(f.store.listTaskObservations).not.toHaveBeenCalled(); expect(f.store.listLiveQualificationPlans).not.toHaveBeenCalled()
})
