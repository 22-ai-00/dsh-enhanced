import { expect, test } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
const base = { databasePath: '/private/owner-recall/state.sqlite', workRoot: '/private/owner-recall/work' }
const active = { ...base, enabled: true, mode: 'active' as const, workerAutomationId: 'worker',
  scope: { workspace: '/workspace', preset: 'primary', principalId: 'owner', ownerRouteId: 'route', expiresAt: 2_000 },
  admission: { allowedKinds: ['repair'] } }
test('owner recall defaults off and only explicitly enabled active deployments opt in', () => {
  expect(normalizeConfig(base, 1_000)).not.toHaveProperty('ownerRecall')
  expect(normalizeConfig({ ...active, ownerRecall: { enabled: false } }, 1_000)).not.toHaveProperty('ownerRecall')
  expect(normalizeConfig({ ...active, ownerRecall: { enabled: true } }, 1_000).ownerRecall).toEqual({ enabled: true })
})
test('owner recall rejects disabled, observe, missing scope/worker and unknown configuration', () => {
  for (const override of [{ enabled: false }, { mode: 'observe' }, { scope: undefined }, { workerAutomationId: undefined },
    { ownerRecall: { enabled: 'yes' } }, { ownerRecall: { enabled: true, allowAll: true } }]) {
    expect(() => normalizeConfig({ ...active, ownerRecall: { enabled: true }, ...override } as never, 1_000)).toThrow()
  }
})

test('owner recall alone does not change the immutable diagnosis configuration digest', async () => {
  const { diagnosisConfigurationDigest } = await import('../src/diagnosis-contract.ts')
  const previous = normalizeConfig(active, 1_000)
  const readable = normalizeConfig({ ...active, ownerRecall: { enabled: true } }, 1_000)
  expect(diagnosisConfigurationDigest(readable, [])).toBe(diagnosisConfigurationDigest(previous, []))
})

test('legacy diagnosis digest stays fixed and every diagnosis execution setting remains bound', async () => {
  const { diagnosisConfigurationDigest } = await import('../src/diagnosis-contract.ts')
  expect(diagnosisConfigurationDigest(normalizeConfig(active, 1_000), []))
    .toBe('28def9c03bd925383c816ace3833128ed5c78a15275e7c2cd47fbbafbdef8562')
  const raw = { ...active, scope: { ...active.scope, expiresAt: 10_000 },
    admission: { allowedKinds: ['diagnosis'] }, sources: { foregroundFailures: { enabled: true, kind: 'diagnosis' } },
    diagnosis: { enabled: true, budgetId: 'diagnosis-budget', budgetAmount: 1, maxModelCalls: 2,
      maxToolCalls: 5, maxOutputTokens: 64, timeoutMs: 1_000, expiresAt: 5_000 } }
  const original = diagnosisConfigurationDigest(normalizeConfig(raw, 1_000), [])
  for (const [key, value] of Object.entries(raw.diagnosis)) {
    const changed = typeof value === 'boolean' ? false : typeof value === 'string' ? `${value}-changed` : value + 1
    expect(diagnosisConfigurationDigest(normalizeConfig({ ...raw, diagnosis: { ...raw.diagnosis, [key]: changed } }, 1_000), []))
      .not.toBe(original)
  }
})
