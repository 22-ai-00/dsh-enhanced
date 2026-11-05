import { expect, test } from 'vitest'
import { normalizeConfig, ConfigSchema } from '../src/config.ts'
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

test('linked alias reads are an explicit, bounded owner allowlist', () => {
  const OWNER = 'lark/cli_app/tenant/ou_owner'
  const owned = { ...active, scope: { ...active.scope, principalId: OWNER } }
  const recall = (ownerRecall: unknown) => normalizeConfig({ ...owned, ownerRecall } as never, 1_000).ownerRecall
  const A = 'telegram/bot/personal/alice', B = 'lark/cli_app/tenant/ou_b%40x%2Fy'
  expect(recall({ enabled: true, linkedAliases: [] })).toEqual({ enabled: true })
  expect(recall({ enabled: true, linkedAliases: [A, B] })).toEqual({ enabled: true, linkedAliases: [A, B] })
  expect(Object.isFrozen(recall({ enabled: true, linkedAliases: [A] })!.linkedAliases)).toBe(true)
  expect(ConfigSchema({ ...owned, ownerRecall: { enabled: true, linkedAliases: [A] } }).ownerRecall).toMatchObject({ linkedAliases: [A] })
  // Bypass/misconfiguration shapes: never a canonical Delivery principal id, so rejected rather than silently unmatched.
  const variants = [`${A} `, ` ${A}`, `${A}\u200b`, `${A}\n`, A.normalize('NFD').replace('alice', 'ali\u0301ce'), A.replace('alice', 'al\u00edce'), A.replace('alice', '\uff41lice'),
    'telegram/bot/a', 'telegram/bot/personal/alice/extra', 'telegram//personal/alice', 'lark/cli_app/tenant/ou_b%2fy', 'lark/cli_app/tenant/ou_b@x', 'lark/cli_app/tenant/张三']
  for (const variant of variants) expect(() => recall({ enabled: true, linkedAliases: [variant] })).toThrow('canonical Delivery principal ids')
  for (const linkedAliases of [A, [''], [1], [OWNER], [A, A], Array.from({ length: 9 }, (_, index) => `telegram/bot/personal/alias-${index}`), [`telegram/bot/personal/${'x'.repeat(240)}`]]) {
    expect(() => recall({ enabled: true, linkedAliases })).toThrow()
  }
  expect(() => recall({ enabled: true, linkedAliases: [OWNER] })).toThrow('must not contain the owner principal')
  // Case variants are distinct Delivery principals (keys are case-sensitive) and stay exact-match only.
  expect(recall({ enabled: true, linkedAliases: [OWNER.replace('ou_owner', 'OU_OWNER')] })!.linkedAliases).toEqual(['lark/cli_app/tenant/OU_OWNER'])
  expect(() => normalizeConfig({ ...owned, ownerRecall: { enabled: false, linkedAliases: [A] } }, 1_000)).toThrow('requires ownerRecall.enabled')
})

test('cross-channel report routing defaults off and is an explicit, bounded linked fallback list', () => {
  const OWNER = 'lark/cli_app/tenant/ou_owner'
  const owned = { ...active, scope: { ...active.scope, principalId: OWNER } }
  const routing = (ownerReportRouting: unknown, config: object = owned) => normalizeConfig({ ...config, ownerReportRouting } as never, 1_000).ownerReportRouting
  const A = 'telegram/bot/personal/alice', B = 'lark/cli_app/tenant/ou_b'
  expect(normalizeConfig(owned, 1_000)).not.toHaveProperty('ownerReportRouting')
  expect(routing({})).toBeUndefined()
  expect(routing({ linkedFallback: [] })).toBeUndefined()
  expect(routing({ linkedFallback: [B, A] })).toEqual({ linkedFallback: [B, A] })
  expect(Object.isFrozen(routing({ linkedFallback: [A] })!.linkedFallback)).toBe(true)
  expect(ConfigSchema({ ...owned, ownerReportRouting: { linkedFallback: [A] } }).ownerReportRouting).toMatchObject({ linkedFallback: [A] })
  expect(() => routing({ linkedFallback: [OWNER] })).toThrow('ownerReportRouting.linkedFallback must not contain the owner principal')
  for (const linkedFallback of [A, ['telegram/bot/alice'], [A, A], Array.from({ length: 9 }, (_, index) => `telegram/bot/personal/alias-${index}`)]) {
    expect(() => routing({ linkedFallback })).toThrow()
  }
  expect(() => routing({ linkedFallback: [A], viaActivity: true })).toThrow()
  for (const config of [base, { ...owned, mode: 'observe' }, { ...owned, enabled: false }]) {
    expect(() => routing({ linkedFallback: [A] }, config)).toThrow('requires an enabled active worker and complete scope')
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

const continuation = { enabled: true, automationId: 'continuation-worker',
  allowedTools: ['work_item_claim', 'work_item_report', 'work_item_read_context'],
  budgetId: 'continuation-budget', budgetAmount: 1, maxModelCalls: 2, maxToolCalls: 5,
  maxOutputTokens: 64, timeoutMs: 1000, expiresAt: 1500 }
const resumable = { ...active, ownerRecall: { enabled: true }, admission: { allowedKinds: ['repair', 'owner-continuation'] } }
test('continuation stays disabled through real Standard-Schema defaults and validates explicit finite authority', () => {
  expect(normalizeConfig(ConfigSchema(base), 1000)).not.toHaveProperty('ownerContinuation')
  expect(normalizeConfig({ ...resumable, ownerContinuation: continuation }, 1000).ownerContinuation).toEqual({
    ...continuation, allowedTools: [...continuation.allowedTools].sort() })
  for (const override of [{ enabled: false }, { mode: 'observe' }, { ownerRecall: { enabled: false } },
    { admission: { allowedKinds: ['repair'] } }]) {
    expect(() => normalizeConfig({ ...resumable, ownerContinuation: continuation, ...override } as never, 1000)).toThrow()
  }
  for (const override of [{ automationId: 'worker' }, { budgetAmount: 0 }, { maxModelCalls: 0 }, { expiresAt: 999 },
    { expiresAt: 2001 }, { allowedTools: ['work_item_claim', 'work_item_report'] },
    { allowedTools: [...continuation.allowedTools, 'work_item_continue'] },
    { allowedTools: [...continuation.allowedTools, 'work_item_read_source'] },
    { allowedTools: [...continuation.allowedTools, 'work_item_claim'] }, { unknown: true }]) {
    expect(() => normalizeConfig({ ...resumable, ownerContinuation: { ...continuation, ...override } } as never, 1000)).toThrow()
  }
})
test('separate continuation settings do not rewrite the existing diagnosis execution configuration', async () => {
  const { diagnosisConfigurationDigest } = await import('../src/diagnosis-contract.ts')
  expect(diagnosisConfigurationDigest(normalizeConfig({ ...resumable, ownerContinuation: continuation }, 1000), []))
    .toBe(diagnosisConfigurationDigest(normalizeConfig(resumable, 1000), []))
})
