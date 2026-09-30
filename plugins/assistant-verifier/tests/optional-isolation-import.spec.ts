import { expect, it, vi } from 'vitest'

vi.mock('@dsh-enhanced/assistant-isolation', () => {
  throw new Error('optional Isolation package is unavailable')
})

it('loads the default Verifier bundle without loading its optional Isolation peer', async () => {
  const bundle = await import('../src/index.ts')
  expect(bundle.default).toBe(bundle.AssistantVerifierService)
})
