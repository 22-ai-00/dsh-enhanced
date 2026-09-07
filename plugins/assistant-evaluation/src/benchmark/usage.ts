import type { TokenUsage } from '@deepseek-ai/dsh-llm'

export interface NormalizedTokenUsage {
  /** Complete billed input: uncached input plus both cache classes. */
  inputTokens: number
  /** The disjoint, non-cached input component reported by DSH. */
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Included in outputTokens, so never added to totals or cost separately. */
  reasoningTokens: number
  totalTokens: number
}

/** Per-million-token rates in USD micros for the disjoint DSH usage classes. */
export interface TokenUsageRates {
  inputUsdMicrosPerMillionTokens: number | null
  outputUsdMicrosPerMillionTokens: number | null
  cacheReadUsdMicrosPerMillionTokens?: number | null
  cacheWriteUsdMicrosPerMillionTokens?: number | null
}

const MAX = Number.MAX_SAFE_INTEGER
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const checkedSum = (...values: readonly number[]): number => {
  let total = 0
  for (const value of values) {
    if (total > MAX - value) throw new Error('token usage total overflow')
    total += value
  }
  return total
}

/**
 * Makes DSH's disjoint usage fields explicit for benchmark metering.
 * `totalTokens`, when supplied, must be the provider's aggregate prompt plus output total.
 */
export function normalizeTokenUsage(usage: TokenUsage): Readonly<NormalizedTokenUsage> {
  const uncachedInputTokens = usage.inputTokens
  const outputTokens = usage.outputTokens
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const reasoningTokens = usage.reasoningTokens ?? 0
  const reportedTotal = usage.totalTokens
  if (![uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens].every(integer)
    || (reportedTotal !== undefined && !integer(reportedTotal))) throw new Error('invalid token usage')
  if (reasoningTokens > outputTokens) throw new Error('reasoning tokens exceed output tokens')
  const inputTokens = checkedSum(uncachedInputTokens, cacheReadTokens, cacheWriteTokens)
  const totalTokens = checkedSum(inputTokens, outputTokens)
  if (reportedTotal !== undefined && reportedTotal !== totalTokens) throw new Error('token usage total is inconsistent')
  return Object.freeze({ inputTokens, uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens })
}

const rate = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  if (!integer(value)) throw new Error('invalid token rate')
  return value
}

/**
 * Returns null when an observed billed class lacks an exact tariff. Costs round up once,
 * after all priced classes are summed, to whole USD micros.
 */
export function tokenUsageCost(usage: TokenUsage | Readonly<NormalizedTokenUsage>, rates: Readonly<TokenUsageRates>): number | null {
  const normalized = 'uncachedInputTokens' in usage ? usage : normalizeTokenUsage(usage)
  const inputRate = rate(rates.inputUsdMicrosPerMillionTokens)
  const outputRate = rate(rates.outputUsdMicrosPerMillionTokens)
  const cacheReadRate = rate(rates.cacheReadUsdMicrosPerMillionTokens)
  const cacheWriteRate = rate(rates.cacheWriteUsdMicrosPerMillionTokens)
  if (inputRate === null || outputRate === null
    || (normalized.cacheReadTokens !== 0 && cacheReadRate === null)
    || (normalized.cacheWriteTokens !== 0 && cacheWriteRate === null)) return null
  const amount = BigInt(normalized.uncachedInputTokens) * BigInt(inputRate)
    + BigInt(normalized.cacheReadTokens) * BigInt(cacheReadRate ?? 0)
    + BigInt(normalized.cacheWriteTokens) * BigInt(cacheWriteRate ?? 0)
    + BigInt(normalized.outputTokens) * BigInt(outputRate)
  const rounded = (amount + 999_999n) / 1_000_000n
  if (rounded > BigInt(MAX)) throw new Error('token usage cost overflow')
  return Number(rounded)
}

/**
 * Conservative preflight cost for an input upper bound and output cap. Known cache rates
 * participate in the worst-case input rate; absent cache rates do not invent a tariff.
 */
export function tokenUsageReserveCost(inputUpperBound: number, maxOutputTokens: number, rates: Readonly<TokenUsageRates>): number | null {
  if (!integer(inputUpperBound) || !integer(maxOutputTokens)) throw new Error('invalid token reservation')
  const inputRate = rate(rates.inputUsdMicrosPerMillionTokens)
  const outputRate = rate(rates.outputUsdMicrosPerMillionTokens)
  const cacheReadRate = rate(rates.cacheReadUsdMicrosPerMillionTokens)
  const cacheWriteRate = rate(rates.cacheWriteUsdMicrosPerMillionTokens)
  if (inputRate === null || outputRate === null) return null
  const maximumInputRate = Math.max(inputRate, cacheReadRate ?? 0, cacheWriteRate ?? 0)
  const amount = BigInt(inputUpperBound) * BigInt(maximumInputRate) + BigInt(maxOutputTokens) * BigInt(outputRate)
  const rounded = (amount + 999_999n) / 1_000_000n
  if (rounded > BigInt(MAX)) throw new Error('token usage cost overflow')
  return Number(rounded)
}
