import { describe, expect, test } from 'vitest'
import { growthObjectDigest, type MemoryLearningOwner } from '@dsh-enhanced/assistant-growth-contract'
import { validateRsiMemoryLearningSetup, type RsiMemoryLearningSetup } from '../src/rsi-memory-learning.js'

const owner: MemoryLearningOwner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64),
  principalId: 'lark/account/tenant/owner', principalRecordId: 'principal-record', principalVersion: 3,
  workspace: '/tmp/rsi-memory-workspace', agentPreset: 'primary' }

function setup(): RsiMemoryLearningSetup {
  const reviews = { authorityId: 'memory-review', owner, expiresAt: 300_000, maxReviews: 3,
    policy: 'Independently check evidence.', maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 1000 }
  const adoption = { authorityId: 'memory-adopt', owner, reviewAuthorityId: reviews.authorityId,
    reviewAuthorityDigest: growthObjectDigest(reviews), expiresAt: 300_000, maxMutations: 3,
    maxTotalContentBytes: 8192, maxRecordTtlMs: 60_000,
    kinds: ['fact', 'experience'] as const, operations: ['add', 'replace', 'remove'] as const }
  return { learning: { databasePath: '/tmp/rsi-memory.sqlite', authorityId: 'memory-extract', owner,
    expiresAt: 200_000, maxExtractions: 3, maxPending: 2, lookbackMs: 60_000,
    policy: 'Extract owner evidence only.', maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 1000,
    budgetId: 'memory-extract-budget', budgetAmount: 1, scanBudgetId: 'memory-scan-budget', scanBudgetAmount: 1,
    reviewAuthorityId: reviews.authorityId, reviewAuthorityDigest: growthObjectDigest(reviews),
    adoptionAuthorityId: adoption.authorityId, adoptionGrantDigest: growthObjectDigest(adoption) },
    reviews, adoption, limits: { extractions: 3, scans: 5 } }
}

describe('RSI memory learning setup admission', () => {
  test('accepts an exact independent finite chain without changing the supplied grants', () => {
    const input = setup(), copy = structuredClone(input)
    expect(validateRsiMemoryLearningSetup(input, owner, 100_000)).toEqual(copy)
    expect(input).toEqual(copy)
  })

  test('rejects owner ABA and authority reuse', () => {
    const input = setup()
    expect(() => validateRsiMemoryLearningSetup(input, { ...owner, principalVersion: 4 }, 100_000)).toThrow('owner')
    expect(() => validateRsiMemoryLearningSetup(input, { ...owner, authorityHash: 'b'.repeat(64) }, 100_000)).toThrow('owner')
    input.learning.authorityId = owner.authorityId
    expect(() => validateRsiMemoryLearningSetup(input, owner, 100_000)).toThrow('independent')
  })

  test('rejects digest drift, expiry, widened lifetime and unbounded automation limits', () => {
    const input = setup()
    input.learning.reviewAuthorityDigest = '0'.repeat(64)
    expect(() => validateRsiMemoryLearningSetup(input, owner, 100_000)).toThrow('digest')
    input.learning.reviewAuthorityDigest = growthObjectDigest(input.reviews)
    input.adoption.reviewAuthorityDigest = '0'.repeat(64)
    expect(() => validateRsiMemoryLearningSetup(input, owner, 100_000)).toThrow('digest')
    input.adoption.reviewAuthorityDigest = growthObjectDigest(input.reviews)
    input.learning.adoptionGrantDigest = growthObjectDigest(input.adoption)
    input.learning.expiresAt = 300_001
    expect(() => validateRsiMemoryLearningSetup(input, owner, 100_000)).toThrow('expiry')
    input.learning.expiresAt = 200_000
    expect(() => validateRsiMemoryLearningSetup(input, owner, 200_000)).toThrow('expiry')
    input.limits.extractions = 4
    expect(() => validateRsiMemoryLearningSetup(input, owner, 100_000)).toThrow('limits')
    input.limits.extractions = 3; input.limits.scans = Infinity
    expect(() => validateRsiMemoryLearningSetup(input, owner, 100_000)).toThrow('limits')
  })

  test('rejects hidden limits fields, getters, and a run cost greater than the finite period limit', () => {
    const hidden = setup()
    Object.defineProperty(hidden.limits, 'hidden', { value: 1, enumerable: false })
    expect(() => validateRsiMemoryLearningSetup(hidden, owner, 100_000)).toThrow('limits')
    const accessor = setup()
    Object.defineProperty(accessor.limits, 'extractions', { enumerable: true, get: () => { throw new Error('getter executed') } })
    expect(() => validateRsiMemoryLearningSetup(accessor, owner, 100_000)).toThrow('limits')
    const symbol = setup()
    Object.defineProperty(symbol.limits, Symbol('hidden'), { value: 1, enumerable: true })
    expect(() => validateRsiMemoryLearningSetup(symbol, owner, 100_000)).toThrow('limits')
    const extract = setup(); extract.learning.budgetAmount = extract.limits.extractions + 1
    expect(() => validateRsiMemoryLearningSetup(extract, owner, 100_000)).toThrow('limits')
    const scan = setup(); scan.learning.scanBudgetAmount = scan.limits.scans + 1
    expect(() => validateRsiMemoryLearningSetup(scan, owner, 100_000)).toThrow('limits')
  })
})
