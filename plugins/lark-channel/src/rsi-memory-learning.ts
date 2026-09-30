import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { growthObjectDigest, validateMemoryLearningOwner, type MemoryLearningOwner } from '@dsh-enhanced/assistant-growth-contract'
import type { LearningConfig } from '@dsh-enhanced/assistant-memory-learning'
import type { MemoryReviewConfig } from '@dsh-enhanced/assistant-verifier'
import type { MemoryLearningAdoptionGrant } from '@dsh-enhanced/personal-memory'

export interface RsiMemoryLearningSetup {
  learning: LearningConfig
  reviews: MemoryReviewConfig
  adoption: MemoryLearningAdoptionGrant
  limits: { extractions: number; scans: number }
}

function fail(message: string): never { throw new Error(`rsi memory learning: ${message}`) }
const requirePeer = createRequire(import.meta.url)
function installedPeer<T>(name: string): T {
  try { requirePeer.resolve(name) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
      || (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      fail(`opted-in memory learning requires installed peer ${name}`)
    }
    throw error
  }
  // Resolution above separates a missing direct peer from failures inside it.
  return requirePeer(name) as T
}

/** Resolve optional public validators only inside the opted-in memory setup path. */
export function getRsiMemoryLearningValidators(): {
  validateLearningConfig: typeof import('@dsh-enhanced/assistant-memory-learning').validateLearningConfig
  validateMemoryReviewConfig: typeof import('@dsh-enhanced/assistant-verifier').validateMemoryReviewConfig
  validateMemoryLearningAdoptionGrant: typeof import('@dsh-enhanced/personal-memory').validateMemoryLearningAdoptionGrant
} {
  const learning = installedPeer<typeof import('@dsh-enhanced/assistant-memory-learning')>('@dsh-enhanced/assistant-memory-learning')
  const verifier = installedPeer<typeof import('@dsh-enhanced/assistant-verifier')>('@dsh-enhanced/assistant-verifier')
  const memory = installedPeer<typeof import('@dsh-enhanced/personal-memory')>('@dsh-enhanced/personal-memory')
  if (typeof learning.validateLearningConfig !== 'function' || typeof verifier.validateMemoryReviewConfig !== 'function'
    || typeof memory.validateMemoryLearningAdoptionGrant !== 'function') fail('installed memory validators are unavailable')
  return { validateLearningConfig: learning.validateLearningConfig,
    validateMemoryReviewConfig: verifier.validateMemoryReviewConfig,
    validateMemoryLearningAdoptionGrant: memory.validateMemoryLearningAdoptionGrant }
}
function exactFields(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === fields.length && keys.every(key => typeof key === 'string' && fields.includes(key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => field.enumerable && 'value' in field)
}

/** Validate one owner-bound, finite learning chain before any profile row is enabled. */
export function validateRsiMemoryLearningSetup(input: unknown, expectedOwner: MemoryLearningOwner,
  now = Date.now()): RsiMemoryLearningSetup {
  if (!Number.isSafeInteger(now) || now < 0) fail('invalid validation time')
  const owner = validateMemoryLearningOwner(expectedOwner)
  if (!exactFields(input, ['adoption', 'learning', 'limits', 'reviews'])) fail('invalid setup fields')
  const group = input as RsiMemoryLearningSetup
  const { validateLearningConfig, validateMemoryReviewConfig, validateMemoryLearningAdoptionGrant } = getRsiMemoryLearningValidators()
  const learning = validateLearningConfig(group.learning)
  const reviews = validateMemoryReviewConfig(group.reviews)
  const adoption = validateMemoryLearningAdoptionGrant(group.adoption)
  for (const [label, candidate] of [['learning', learning.owner], ['reviews', reviews.owner], ['adoption', adoption.owner]] as const) {
    if (!isDeepStrictEqual(candidate, owner)) fail(`${label} owner differs from current owner route`)
  }
  const authorities = [learning.authorityId, reviews.authorityId, adoption.authorityId]
  if (authorities.includes(owner.authorityId) || new Set(authorities).size !== 3) fail('learning authorities must be independent')
  if (learning.expiresAt <= now || reviews.expiresAt <= now || adoption.expiresAt <= now
    || learning.expiresAt > reviews.expiresAt || learning.expiresAt > adoption.expiresAt) fail('learning authority expiry is invalid')
  const reviewDigest = growthObjectDigest(reviews)
  if (learning.reviewAuthorityId !== reviews.authorityId || learning.reviewAuthorityDigest !== reviewDigest
    || adoption.reviewAuthorityId !== reviews.authorityId || adoption.reviewAuthorityDigest !== reviewDigest
    || learning.adoptionAuthorityId !== adoption.authorityId || learning.adoptionGrantDigest !== growthObjectDigest(adoption)) {
    fail('learning authority digest binding differs')
  }
  const limits = group.limits
  if (!exactFields(limits, ['extractions', 'scans'])
    || !Number.isSafeInteger(limits.extractions) || limits.extractions < 1 || limits.extractions > learning.maxExtractions
    || !Number.isSafeInteger(limits.scans) || limits.scans < 1 || limits.scans > 10_000
    || learning.budgetAmount > limits.extractions || learning.scanBudgetAmount > limits.scans) fail('invalid finite automation limits')
  return { learning, reviews, adoption, limits: { extractions: limits.extractions, scans: limits.scans } }
}
