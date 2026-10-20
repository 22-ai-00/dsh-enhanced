import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { controlPlaneDigest, runtimeConfigDigest, type RuntimeObserverConfig } from '@dsh-enhanced/plugin-control-plane'
import { rsiInstallPorts } from '../src/rsi-install.js'
import { rsiBuildResources } from '../src/rsi-build.js'
import type { RsiSetupManifest } from '../src/rsi-profile.js'

const clock = vi.hoisted(() => ({ now: 1_800_000_000_000 }))
const reads = vi.hoisted(() => ({ active: vi.fn(), offline: vi.fn(), observer: vi.fn() }))
vi.mock('node:timers/promises', async original => ({
  ...await original<typeof import('node:timers/promises')>(),
  setTimeout: async (milliseconds: number) => { clock.now += milliseconds },
}))
vi.mock('@dsh-enhanced/assistant-automations', async original => ({
  ...await original<typeof import('@dsh-enhanced/assistant-automations')>(),
  listActiveAutomationsForReadiness: reads.active,
  listActiveAutomationsLocally: reads.offline,
}))
vi.mock('@dsh-enhanced/plugin-control-plane', async original => ({
  ...await original<typeof import('@dsh-enhanced/plugin-control-plane')>(),
  queryRuntimeObserver: reads.observer,
}))

beforeEach(() => {
  clock.now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
  reads.active.mockReset(); reads.offline.mockReset(); reads.observer.mockReset()
  reads.offline.mockImplementation(() => { throw new Error('offline snapshot requires a stopped database') })
})
afterEach(() => vi.restoreAllMocks())

function fixture() {
  const home = '/private/owner-home', profile = 'owner', coordinator = 'rsi-owner'
  const scope = { ownerRouteId: 'owner-route', principalId: 'owner', workspace: '/workspace', preset: 'coder' }
  const coordinatorId = 'coordinator'
  const observer = { profilePath: join(home, 'profiles', profile), targets: [] } as unknown as RuntimeObserverConfig
  const manifest = { targetProfile: profile, coordinatorProfile: coordinator,
    controlPlane: { runtimeObserver: observer, taskObservations: { scope },
      sourceAdoptions: { handoff: { coordinatorId } } } } as unknown as RsiSetupManifest
  const executable = Buffer.from('reviewed systemctl')
  const pin = { path: '/usr/bin/systemctl', sha256: createHash('sha256').update(executable).digest('hex'), interpreter: null }
  vi.spyOn(rsiBuildResources, 'readStable').mockResolvedValue(executable)
  let pid = 1234
  const command = vi.spyOn(rsiBuildResources, 'command').mockImplementation(async () =>
    `ActiveState=active\nMainPID=${pid}\nInvocationID=${'a'.repeat(32)}\nNRestarts=0\n`)
  reads.observer.mockImplementation(async () => ({ processId: pid, invocationId: 'a'.repeat(32),
    profilePath: observer.profilePath, observerConfigDigest: runtimeConfigDigest(observer), observedAt: clock.now, entries: [] }))
  const registration = { id: `adoption-coordinator-${controlPlaneDigest({ coordinatorId, scope }).slice(0, 40)}`,
    owner: 'plugin-control-plane-adoption-coordinator', updatedAt: clock.now,
    definition: { principal: scope.principalId, workspace: scope.workspace, agentPreset: scope.preset,
      execution: { kind: 'host', executorId: 'plugin-control-plane-adoption-coordinator-v1', ownerRouteId: scope.ownerRouteId } } }
  reads.active.mockReturnValue([registration])
  return { home, coordinator, manifest, pin, registration, command, setPid(value: number) { pid = value } }
}

test('checks live owner registrations across the full stable Host window without offline snapshots', async () => {
  const f = fixture(), startedAt = clock.now
  await rsiInstallPorts.ready(f.manifest, f.pin, new AbortController().signal, startedAt)
  expect(clock.now - startedAt).toBeGreaterThanOrEqual(12_000)
  expect(reads.active).toHaveBeenCalledWith(join(f.home, 'rsi-coordinators', f.coordinator, 'automations.sqlite'))
  expect(reads.active.mock.calls.length).toBeGreaterThan(1)
  expect(reads.offline).not.toHaveBeenCalled()
})

test('live reads do not accept a registration for another owner', async () => {
  const f = fixture(), startedAt = clock.now
  f.registration.definition.principal = 'another-owner'
  await expect(rsiInstallPorts.ready(f.manifest, f.pin, new AbortController().signal, startedAt))
    .rejects.toThrow('dual Host readiness failed')
  expect(clock.now - startedAt).toBeGreaterThanOrEqual(60_000)
  expect(reads.offline).not.toHaveBeenCalled()
})

test('a Host PID change restarts the stability window', async () => {
  const f = fixture(), startedAt = clock.now
  const read = reads.active.getMockImplementation()!
  reads.active.mockImplementation((...args: unknown[]) => {
    if (clock.now - startedAt >= 10_000) f.setPid(5678)
    return read(...args)
  })
  await rsiInstallPorts.ready(f.manifest, f.pin, new AbortController().signal, startedAt)
  expect(clock.now - startedAt).toBeGreaterThanOrEqual(22_000)
})
