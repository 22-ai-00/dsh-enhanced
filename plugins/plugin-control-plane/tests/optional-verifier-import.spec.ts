import { expect, it, vi } from 'vitest'

vi.mock('@dsh-enhanced/assistant-verifier', () => {
  throw new Error('optional Verifier package is unavailable')
})
vi.mock('@dsh-enhanced/assistant-verifier/linux-behavior-runtime', () => {
  throw new Error('optional Linux verifier runtime is unavailable')
})
vi.mock('@dsh-enhanced/assistant-verifier/plugin-behavior-config', () => {
  throw new Error('optional Linux verifier configuration is unavailable')
})

it('loads the default Control Plane without loading its optional Verifier peer', async () => {
  const bundle = await import('../src/index.ts')
  expect(bundle.default).toBe(bundle.PluginControlPlaneService)
})
