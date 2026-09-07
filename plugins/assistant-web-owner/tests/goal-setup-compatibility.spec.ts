import { expect, test, vi } from 'vitest'

vi.mock('@dsh-enhanced/assistant-delivery', async importOriginal => {
  const original = await importOriginal<typeof import('@dsh-enhanced/assistant-delivery')>()
  return { ...original, inspectActiveWebOwnerBindingLocally: undefined }
})

test('an older Delivery gives an actionable upgrade error before task or profile IO', async () => {
  const { configureGoalAdmission } = await import('../src/goal-setup.js')
  await expect(configureGoalAdmission({
    dshHome: '/nonexistent-goal-setup-compatibility-home', profile: 'web',
    workspace: '/nonexistent-goal-setup-compatibility-workspace', preset: 'standard',
  }, '[]', '/nonexistent-goal-setup-compatibility-task.json', 'session')).rejects.toThrow(
    'upgrade assistant-delivery with the matching autonomy bundle set; readonly owner snapshot API is unavailable',
  )
})
