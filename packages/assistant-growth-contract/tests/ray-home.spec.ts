import { describe, expect, test } from 'vitest'
import {
  RAY_BODY_KERNEL_PROTOCOL,
  RAY_DEFAULT_ALIASES,
  RAY_DEFAULT_NAME,
  RAY_FREE_ENERGY_DEFAULT_RATIO_BP,
  RAY_HOME_MANIFEST_PROTOCOL,
  commandReferencesRayKernel,
  createDefaultBodyKernel,
  isPathInsideRoot,
  isRayKernelPath,
  isWithinAllowedHomes,
} from '../src/index.js'

describe('ray-home contracts', () => {
  test('createDefaultBodyKernel produces immutable strict-owner defaults', () => {
    const kernel = createDefaultBodyKernel(1_700_000_000_000)
    expect(kernel.protocol).toBe(RAY_BODY_KERNEL_PROTOCOL)
    expect(kernel.fundamentalStance).toEqual({
      strictOwnerPrecedence: true,
      noOwnerHarm: true,
      aspirationsUseFreeEnergyOnly: true,
    })
    expect(kernel.energy.freeEnergyRatioBp).toBe(RAY_FREE_ENERGY_DEFAULT_RATIO_BP)
    expect(kernel.credentialsExcludedFromRayHome).toBe(true)
    expect(kernel.externalSideEffectsRequireAuthorization).toBe(true)
    expect(kernel.independentVerifierRequired).toBe(true)
    expect(kernel.rollbackEnabled).toBe(true)
    expect(RAY_DEFAULT_NAME).toBe('文鳐')
    expect(RAY_DEFAULT_ALIASES).toEqual(['Ray', '小鳐'])
    expect(RAY_HOME_MANIFEST_PROTOCOL).toBe('ray-home/manifest/v1')
  })

  test('kernel path and allowed home guards handle traversal and arbitrary disk paths', () => {
    const dshHome = '/var/lib/dsh'
    const rayHome = '/mnt/disk2/ray-home'

    expect(isRayKernelPath(rayHome, '/mnt/disk2/ray-home/kernel')).toBe(true)
    expect(isRayKernelPath(rayHome, '/mnt/disk2/ray-home/kernel/kernel.json')).toBe(true)
    expect(isRayKernelPath(rayHome, '/mnt/disk2/ray-home/self/../kernel/proposals.json')).toBe(true)
    expect(isRayKernelPath(rayHome, '/mnt/disk2/ray-home/self/self-model.json')).toBe(false)
    expect(isPathInsideRoot(rayHome, '/mnt/disk2/ray-home/state/policy.sqlite')).toBe(true)
    expect(isPathInsideRoot(rayHome, '/mnt/disk2/ray-home-evil/kernel.json')).toBe(false)

    expect(isWithinAllowedHomes('/mnt/disk2/ray-home/state/memory.sqlite', dshHome, rayHome)).toBe(true)
    expect(isWithinAllowedHomes('/tmp/outside.sqlite', dshHome, rayHome)).toBe(false)

    expect(commandReferencesRayKernel('cat /mnt/disk2/ray-home/kernel/kernel.json', rayHome)).toBe(true)
    expect(commandReferencesRayKernel('echo "{}" > $RAY_HOME/kernel/kernel.json', rayHome)).toBe(true)
    expect(commandReferencesRayKernel('sed -i s/a/b/ kernel/kernel.json', rayHome, rayHome)).toBe(true)
    expect(commandReferencesRayKernel('ls /mnt/disk2/ray-home/self/self-model.json', rayHome, '/tmp/ws')).toBe(false)
  })
})
