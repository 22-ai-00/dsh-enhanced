import { describe, expect, it } from 'vitest'
import { normalizeTokenUsage, tokenUsageCost, tokenUsageReserveCost, type TokenUsageRates } from '../../src/benchmark/usage.js'

const rates = (): TokenUsageRates => ({
  inputUsdMicrosPerMillionTokens: 1_000_000,
  outputUsdMicrosPerMillionTokens: 4_000_000,
  cacheReadUsdMicrosPerMillionTokens: 250_000,
  cacheWriteUsdMicrosPerMillionTokens: 500_000,
})

describe('native benchmark token usage', () => {
  it('normalizes the real Codex Responses shape without double-counting reasoning', () => {
    // coding-subscription-provider maps input_tokens=12, cached=4, write=2 to this DSH shape.
    const usage = { inputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 2, outputTokens: 5, reasoningTokens: 3, totalTokens: 17 }
    expect(normalizeTokenUsage(usage)).toEqual({
      inputTokens: 12, uncachedInputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 2,
      outputTokens: 5, reasoningTokens: 3, totalTokens: 17,
    })
    expect(tokenUsageCost(usage, rates())).toBe(28)
  })

  it('keeps zero-cache callers compatible with the original input and output rates', () => {
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    expect(tokenUsageCost(usage, { inputUsdMicrosPerMillionTokens: 1_000_000, outputUsdMicrosPerMillionTokens: 2_000_000 })).toBe(8)
  })

  it('returns null instead of inventing a cached-input tariff', () => {
    const usage = { inputTokens: 2, cacheReadTokens: 1, outputTokens: 3, totalTokens: 6 }
    expect(tokenUsageCost(usage, { inputUsdMicrosPerMillionTokens: 1, outputUsdMicrosPerMillionTokens: 1 })).toBeNull()
    expect(tokenUsageCost(usage, { ...rates(), cacheReadUsdMicrosPerMillionTokens: null })).toBeNull()
  })

  it('reserves input at the most expensive known input-class rate', () => {
    expect(tokenUsageReserveCost(10, 2, rates())).toBe(18)
    expect(tokenUsageReserveCost(10, 2, {
      inputUsdMicrosPerMillionTokens: 1_000_000,
      outputUsdMicrosPerMillionTokens: 2_000_000,
    })).toBe(14)
    expect(tokenUsageReserveCost(1, 1, { inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null })).toBeNull()
  })

  it.each([
    { inputTokens: -1, outputTokens: 0 },
    { inputTokens: Number.NaN, outputTokens: 0 },
    { inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1, outputTokens: 0 },
    { inputTokens: 1, outputTokens: 1, reasoningTokens: 2 },
    { inputTokens: 1, cacheReadTokens: 1, outputTokens: 1, totalTokens: 2 },
  ])('rejects invalid or inconsistent usage: %#', usage => {
    expect(() => normalizeTokenUsage(usage)).toThrow()
  })
})
