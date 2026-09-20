import { describe, expect, test, vi } from 'vitest'
import { rollbackPluginWatch } from '../src/cli.ts'
import type { ControlPlaneStore } from '../src/store.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'

describe('shared post-activation rollback engine', () => {
  test('honors a pre-aborted owner signal before touching or closing the caller Store', async () => {
    const controller = new AbortController(); controller.abort()
    const store = { getPlan: vi.fn(), close: vi.fn() } as unknown as ControlPlaneStore
    await expect(rollbackPluginWatch({ store, trust: {} as PluginControlTrustConfig, planId: 'plan', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'ActivationCancelledError' })
    expect(store.getPlan).not.toHaveBeenCalled(); expect(store.close).not.toHaveBeenCalled()
  })
})
