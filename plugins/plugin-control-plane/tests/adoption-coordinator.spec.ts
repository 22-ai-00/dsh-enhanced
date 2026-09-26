import type { HostAutomationExecutor, HostAutomationExecutorInput } from '@dsh-enhanced/assistant-automations'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../src/cli.ts', () => ({ activatePluginPlan: vi.fn(), probePluginPlan: vi.fn() }))

import { activatePluginPlan, probePluginPlan } from '../src/cli.ts'
import { AdoptionCoordinatorRuntime, coordinateAdoptionHandoff, validateAdoptionCoordinatorConfig } from '../src/adoption-coordinator.ts'
import type { PluginActivationPlan } from '../src/types.ts'

const plan = (status: PluginActivationPlan['status']): PluginActivationPlan => ({ schemaVersion: 4, kind: 'activation', id: 'plan', gapId: 'gap',
  gapSnapshot: { revision: 1, inputDigest: 'a'.repeat(64), roi: 1, capability: 'health' }, digest: 'b'.repeat(64), status, revision: 1,
  createdAt: 1, expiresAt: Date.now() + 60_000, profile: 'primary', candidate: {} as never,
  dossier: { catalogDigest: 'c'.repeat(64), catalogProvenance: 'owner-provided-integrity-pinned', matchedCapabilities: [], authorities: [], packages: [],
    handoff: { schemaVersion: 1, coordinatorId: 'coordinator', maximumWindowMs: 60_000, commit: 'target-host' } }, installationId: 'install', ledger: { id: 'ledger', path: '/ledger' },
  target: { dshHome: '/dsh', profile: 'primary', profilePath: '/dsh/profiles/primary' }, executor: { id: 'executor', version: '1', path: '/bin/dsh', sha256: 'd'.repeat(64) },
  ...(status === 'approved' ? {} : { activation: { id: 'activation', fence: 1, updatedAt: 1 } }) })

function storeFixture(status: PluginActivationPlan['status'] = 'awaiting-health', handoff = { planId: 'plan', planDigest: 'b'.repeat(64), coordinatorId: 'coordinator', createdAt: 1, expiresAt: Date.now() + 60_000 }) {
  let current = plan(status)
  return { store: {
    getPlan: vi.fn(() => current), getAdoptionHandoff: vi.fn(() => handoff), getLiveQualificationDeadline: vi.fn<() => number | undefined>(() => undefined),
    assertAdoptionHandoff: vi.fn(() => { if (handoff.expiresAt <= Date.now() || 'revokedAt' in handoff) throw new Error('inactive') }),
    requestActivationRollback: vi.fn(() => current = { ...current, status: 'rollback-pending', revision: current.revision + 1,
      activation: { ...current.activation!, rollbackProfileRestored: true } }),
    listAdoptionHandoffs: vi.fn(() => [handoff]), close: vi.fn(),
  }, state: () => current, set: (value: PluginActivationPlan) => { current = value } }
}

afterEach(() => { vi.clearAllMocks() })

test('forwards Host phases only through deferCommit and stops at target-owned commit', async () => {
  const f = storeFixture()
  vi.mocked(probePluginPlan).mockImplementation(async _input => ({ ...f.state(), status: 'commit-pending', revision: 2, activation: f.state().activation! }))
  const output = await coordinateAdoptionHandoff({ store: f.store as never, trust: {} as never, planId: 'plan' })
  expect(output.status).toBe('commit-pending')
  expect(probePluginPlan).toHaveBeenCalledWith(expect.objectContaining({ deferCommit: true }))
  expect(activatePluginPlan).not.toHaveBeenCalled()
})

test('expired exposed handoff enters the shared rollback path; an unexposed approval is untouched', async () => {
  const expired = { planId: 'plan', planDigest: 'b'.repeat(64), coordinatorId: 'coordinator', createdAt: 1, expiresAt: 1 }
  const f = storeFixture('awaiting-health', expired)
  vi.mocked(activatePluginPlan).mockImplementation(async () => f.state())
  vi.mocked(probePluginPlan).mockImplementation(async () => ({ ...f.state(), status: 'rolled-back' }))
  await coordinateAdoptionHandoff({ store: f.store as never, trust: {} as never, planId: 'plan' })
  expect(f.store.requestActivationRollback).toHaveBeenCalledTimes(1)
  expect(probePluginPlan).toHaveBeenCalledWith(expect.objectContaining({ deferCommit: true }))

  const approved = storeFixture('approved', expired)
  await coordinateAdoptionHandoff({ store: approved.store as never, trust: {} as never, planId: 'plan' })
  expect(approved.store.requestActivationRollback).not.toHaveBeenCalled()
  expect(activatePluginPlan).not.toHaveBeenCalled()
})

test('live qualification deadline rolls back exposure before the handoff expires', async () => {
  const f = storeFixture('awaiting-live-tasks')
  f.store.getLiveQualificationDeadline.mockReturnValue(Date.now() - 1)
  vi.mocked(probePluginPlan).mockImplementation(async () => ({ ...f.state(), status: 'rolled-back' }))
  await coordinateAdoptionHandoff({ store: f.store as never, trust: {} as never, planId: 'plan' })
  expect(f.store.requestActivationRollback).toHaveBeenCalledWith(expect.objectContaining({ failureCode: 'live-qualification-expired' }))
  expect(probePluginPlan).toHaveBeenCalledWith(expect.objectContaining({ deferCommit: true }))
})

test('waiting for live tasks does not request a strict behavioral attestation', async () => {
  const f = storeFixture('awaiting-live-tasks')
  f.store.getLiveQualificationDeadline.mockReturnValue(Date.now() + 60_000)
  const output = await coordinateAdoptionHandoff({ store: f.store as never, trust: {} as never, planId: 'plan' })
  expect(output.status).toBe('awaiting-live-tasks')
  expect(probePluginPlan).not.toHaveBeenCalled()
  expect(activatePluginPlan).not.toHaveBeenCalled()
})

test('does not turn a forged or mismatched handoff into a rollback or dispatch', async () => {
  const f = storeFixture('awaiting-health', { planId: 'plan', planDigest: 'wrong', coordinatorId: 'coordinator', createdAt: 1, expiresAt: 1 })
  await expect(coordinateAdoptionHandoff({ store: f.store as never, trust: {} as never, planId: 'plan' })).rejects.toThrow('inactive')
  expect(f.store.requestActivationRollback).not.toHaveBeenCalled()
  expect(probePluginPlan).not.toHaveBeenCalled()
})

test('does not replay an expired handoff while the Store retains an unknown Host dispatch claim', async () => {
  const f = storeFixture('awaiting-health', { planId: 'plan', planDigest: 'b'.repeat(64), coordinatorId: 'coordinator', createdAt: 1, expiresAt: 1 })
  f.store.requestActivationRollback.mockImplementation(() => { throw new Error('claimed Host dispatch') })
  await expect(coordinateAdoptionHandoff({ store: f.store as never, trust: {} as never, planId: 'plan' })).rejects.toThrow('claimed Host dispatch')
  expect(activatePluginPlan).not.toHaveBeenCalled()
  expect(probePluginPlan).not.toHaveBeenCalled()
})

test('validates strict coordinator configuration', () => {
  const valid = { coordinatorId: 'coordinator', scope: { workspace: '/workspace', preset: 'primary', principalId: 'owner', ownerRouteId: 'route' }, timeoutMs: 1_000, budgetId: 'adoption-runs', budgetAmount: 1 }
  expect(() => validateAdoptionCoordinatorConfig(valid)).not.toThrow()
  expect(() => validateAdoptionCoordinatorConfig({ ...valid, scope: { ...valid.scope, workspace: 'workspace' } })).toThrow('invalid adoption coordinator')
  expect(() => validateAdoptionCoordinatorConfig({ ...valid, budgetAmount: 0 })).toThrow('invalid adoption coordinator')
  const { budgetId: _budgetId, ...missingBudget } = valid
  expect(() => validateAdoptionCoordinatorConfig(missingBudget)).toThrow('invalid adoption coordinator')
})

test('native executor rejects forged dispatches and close pauses only its generation after draining', async () => {
  const f = storeFixture()
  let executor: HostAutomationExecutor | undefined
  let registration: { definitionHash: string; activationNonce: string } | undefined
  const unregister = vi.fn()
  const automations = {
    registerHostExecutor: vi.fn((value: HostAutomationExecutor) => { executor = value; return unregister }),
    reconcileSystem: vi.fn((input: any) => { registration = { definitionHash: 'definition', activationNonce: input.definition.execution.activationNonce }; return {} }),
    inspectSystemOwnedActivation: vi.fn(() => registration),
  }
  const runtime = new AdoptionCoordinatorRuntime({ config: { coordinatorId: 'coordinator', scope: { workspace: '/workspace', preset: 'primary', principalId: 'owner', ownerRouteId: 'route' }, timeoutMs: 1_000, budgetId: 'adoption-runs', budgetAmount: 7 },
    store: f.store as never, trust: {} as never, automations: automations as never, assertCurrent() {} })
  runtime.start()
  const definition = (automations.reconcileSystem.mock.calls[0]![0] as any).definition
  expect(definition).toMatchObject({ budgetId: 'adoption-runs', budgetAmount: 7 })
  const forged = await executor!.execute({ automationId: 'bad', executionMode: 'production', activationNonce: definition.execution.activationNonce, definitionHash: 'definition', catalogDigest: executor!.descriptor.catalogDigest,
    ownerRouteId: 'route', principal: 'owner', targetScope: { workspace: '/workspace', preset: 'primary' }, signal: new AbortController().signal } as HostAutomationExecutorInput)
  expect(forged.outcome).toBe('failed')

  let release!: () => void
  vi.mocked(probePluginPlan).mockImplementation(async () => new Promise(resolve => { release = () => resolve({ ...f.state(), status: 'commit-pending' }) }))
  const flight = executor!.execute({ automationId: (automations.reconcileSystem.mock.calls[0]![0] as any).automationId, executionMode: 'production', activationNonce: definition.execution.activationNonce,
    definitionHash: 'definition', catalogDigest: executor!.descriptor.catalogDigest, ownerRouteId: 'route', principal: 'owner', targetScope: { workspace: '/workspace', preset: 'primary' }, signal: new AbortController().signal } as HostAutomationExecutorInput)
  while (!release) await new Promise(resolve => setTimeout(resolve, 0))
  const closing = runtime.close(); expect(f.store.close).not.toHaveBeenCalled()
  release(); await closing; expect((await flight).outcome).toBe('unknown')
  expect(unregister).toHaveBeenCalledTimes(1); expect(f.store.close).toHaveBeenCalledTimes(1)
  expect(automations.reconcileSystem).toHaveBeenLastCalledWith(expect.objectContaining({ desiredStatus: 'paused' }))
})
