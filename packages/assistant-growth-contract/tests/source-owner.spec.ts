import { expect, test } from 'vitest'
import { isSourceOwnerContinuation, type SourceOwnerReceipt } from '../src/index.js'

const original: SourceOwnerReceipt = { receiptVersion: 2, authorityId: 'route', authorityHash: 'a'.repeat(64),
  principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/work',
  agentPreset: 'main', bindingVersion: 3, generation: 4 }

test('allows the same receipt and a later Session without changing the original evidence', () => {
  expect(isSourceOwnerContinuation(original, original)).toBe(true)
  const next = { ...original, bindingVersion: 1, generation: 5 }
  expect(isSourceOwnerContinuation(next, original)).toBe(true)
  expect(isSourceOwnerContinuation(original, next)).toBe(false)
  expect(original).toMatchObject({ bindingVersion: 3, generation: 4 })
})

test.each(['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion',
  'workspace', 'agentPreset', 'receiptVersion', 'bindingVersion', 'generation'] as const)(
  'rejects changed authority or invalid continuation: %s', field => {
    const value = original[field]
    const changed = { ...original, [field]: typeof value === 'string' ? (field === 'authorityHash' ? 'b'.repeat(64) : `${value}-other`)
      : field === 'generation' ? value - 1 : value + 1 }
    expect(isSourceOwnerContinuation(changed as SourceOwnerReceipt, original)).toBe(false)
  })

test.each([0, -1, NaN, Infinity, 1.5])('rejects invalid generation/version %s on either side', value => {
  for (const field of ['generation', 'bindingVersion', 'principalVersion'] as const) {
    const changed = { ...original, [field]: value }
    expect(isSourceOwnerContinuation(changed, original)).toBe(false)
    expect(isSourceOwnerContinuation(original, changed)).toBe(false)
  }
})
