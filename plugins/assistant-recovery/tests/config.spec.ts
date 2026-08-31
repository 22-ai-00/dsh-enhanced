import { describe, expect, it } from 'vitest'
import { RECOVERY_CATALOG_DIGEST } from '../src/catalog.ts'
import { normalizeRecoveryConfig, type Config } from '../src/config.ts'

function config(overrides: Partial<Config> = {}): Config {
  return {
    databasePath: '/state/recovery.sqlite',
    jobs: [{
      id: 'supervised-growth',
      activationState: 'preview',
      activationNonce: 'nonce-1',
      catalogDigest: RECOVERY_CATALOG_DIGEST,
      workspace: '/workspace',
      preset: 'owner',
      principal: 'lark/account/tenant/user',
      ownerRouteId: 'owner-route',
      cron: '0 8,10,12,14,16,18,20 * * *',
      timezone: 'Asia/Shanghai',
      budgetId: 'growth-runs',
      budgetAmount: 1,
    }],
    ...overrides,
  }
}

describe('normalizeRecoveryConfig', () => {
  it('normalizes a bounded preview activation', () => {
    expect(normalizeRecoveryConfig(config())).toMatchObject({
      databasePath: '/state/recovery.sqlite',
      maxStepDurationMs: 10_000,
      jobs: [{ activationState: 'preview', catalogDigest: RECOVERY_CATALOG_DIGEST }],
    })
  })

  it('canonicalizes lexical workspace aliases before building a learning scope', () => {
    const input = config()
    input.jobs![0]!.workspace = '/work/../workspace'
    expect(normalizeRecoveryConfig(input).jobs[0]!.workspace).toBe('/workspace')
  })

  it('rejects a catalog drift before any run can be scheduled', () => {
    const input = config()
    input.jobs![0]!.catalogDigest = '0'.repeat(64)
    expect(() => normalizeRecoveryConfig(input)).toThrow(/compiled runbook/u)
  })

  it('requires absolute database and target workspace paths', () => {
    expect(() => normalizeRecoveryConfig(config({ databasePath: 'relative.sqlite' }))).toThrow(/absolute/u)
    const input = config()
    input.jobs![0]!.workspace = 'relative'
    expect(() => normalizeRecoveryConfig(input)).toThrow(/absolute/u)
  })

  it('requires a complete optional budget tuple', () => {
    const input = config()
    delete input.jobs![0]!.budgetAmount
    expect(() => normalizeRecoveryConfig(input)).toThrow(/supplied together/u)
  })

  it('requires a hard budget before a job may enter production', () => {
    const input = config()
    input.jobs![0]!.activationState = 'active'
    delete input.jobs![0]!.budgetId
    delete input.jobs![0]!.budgetAmount
    expect(() => normalizeRecoveryConfig(input)).toThrow(/requires a budget/u)
  })

  it('requires the future production budget in the previewed activation plan', () => {
    const input = config()
    delete input.jobs![0]!.budgetId
    delete input.jobs![0]!.budgetAmount
    expect(() => normalizeRecoveryConfig(input)).toThrow(/preview\/active recovery requires a budget/u)
  })

  it('rejects duplicate job ids and activation nonces', () => {
    const first = config().jobs![0]!
    expect(() => normalizeRecoveryConfig(config({ jobs: [first, { ...first }] }))).toThrow(/job ids/u)
    expect(() => normalizeRecoveryConfig(config({
      jobs: [first, { ...first, id: 'other' }],
    }))).toThrow(/activation nonces/u)
  })

  it('rejects control characters before values become durable authority', () => {
    const input = config()
    input.jobs![0]!.ownerRouteId = 'owner\nroute'
    expect(() => normalizeRecoveryConfig(input)).toThrow(/printable/u)
  })
})
