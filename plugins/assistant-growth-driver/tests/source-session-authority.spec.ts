import { expect, test } from 'vitest'
import { mintGrowthAuthority, type GrowthDeliveryPort, type OwnerRouteReceipt } from '../src/deposit.js'

test('only task-backed usage continues its finite wake across a new Session', () => {
  let current: OwnerRouteReceipt = { receiptVersion: 2, authorityId: 'route', authorityHash: 'a'.repeat(64),
    principalId: 'owner', principalRecordId: 'record', principalVersion: 1,
    workspace: '/work', agentPreset: 'main', bindingVersion: 1, generation: 1 }
  const delivery: GrowthDeliveryPort = { validateOwnerRoute: () => current,
    commitOwnerAnchoredWorkflowTrace: async () => { throw new Error('not used') } }
  const config = { ownerRouteId: 'route', principalId: 'owner', workspace: '/work', preset: 'main' }
  const expiresAt = Date.now() + 10_000
  const explicitWake = mintGrowthAuthority(delivery, config, expiresAt)
  const usageWake = mintGrowthAuthority(delivery, config, expiresAt, true)
  const originalId = usageWake.id
  current = { ...current, generation: 2 }
  expect(explicitWake.assertCurrent).toThrow('owner route changed')
  expect(usageWake.assertCurrent).not.toThrow()
  expect(usageWake).toMatchObject({ id: originalId, expiresAt })
  current = { ...current, principalVersion: 2 }
  expect(usageWake.assertCurrent).toThrow('owner route changed')
})
