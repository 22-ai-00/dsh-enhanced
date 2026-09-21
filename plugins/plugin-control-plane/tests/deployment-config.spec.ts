import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { normalizeControlPlaneConfig } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test('normalizes deployable minimal and coordinator profiles without creating state resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-deployment-config-')); roots.push(root)
  const base = { catalogPath: join(root, 'catalog.json'), trustPath: join(root, 'trust.json'), statePath: join(root, 'state') }
  const minimal = normalizeControlPlaneConfig(base)
  expect(minimal).toMatchObject({ ...base, proposalTtlMs: 900_000 })
  expect(existsSync(base.statePath)).toBe(false)
  const coordinate = normalizeControlPlaneConfig({ ...base, adoptionCoordinator: { coordinatorId: 'coordinator',
    scope: { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'route' }, timeoutMs: 1_000,
    budgetId: 'adoption-runs', budgetAmount: 1 } })
  expect(coordinate.adoptionCoordinator).toMatchObject({ budgetId: 'adoption-runs', budgetAmount: 1 })
  expect(existsSync(base.statePath)).toBe(false)
})

test('rejects an unbudgeted coordinator and a source adoption chain without release execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-deployment-config-')); roots.push(root)
  const base = { catalogPath: join(root, 'catalog.json'), trustPath: join(root, 'trust.json'), statePath: join(root, 'state') }
  expect(() => normalizeControlPlaneConfig({ ...base, adoptionCoordinator: { coordinatorId: 'coordinator',
    scope: { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'route' }, timeoutMs: 1_000, budgetAmount: 1 } as never })).toThrow('invalid adoption coordinator')
  expect(() => normalizeControlPlaneConfig({ ...base, sourceAdoptions: { profile: 'primary', planTtlMs: 60_000, timeoutMs: 1_000,
    authority: { executable: { path: '/bin/true', sha256: 'a'.repeat(64) }, configPath: '/tmp/authority.json', timeoutMs: 1_000 } } })).toThrow('sourceAdoptions requires sourceReleaseExecution')
  expect(existsSync(base.statePath)).toBe(false)
})
