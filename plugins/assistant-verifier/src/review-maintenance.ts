/** Offline review-lane maintenance surface for installers (package subpath `./review-maintenance`).
 * Kept apart from the plugin entry so creation-review → store → lineage imports stay acyclic and the
 * service entry does not export store internals. */
import { createHash, createPublicKey } from 'node:crypto'
import { compileCreationReviewConfig, type CreationReviewConfig } from './creation-review.js'
import { compileRevisionReviewConfig, type RevisionReviewConfig } from './revision-review.js'
import { compileRevisionRegressionReviewConfig, type RevisionRegressionReviewConfig } from './revision-regression-review.js'
import { validateIdentity, validateLane, type LineageScope, type ReviewPublicIdentity } from './review-authority-lineage.js'

export { CreationReviewStore } from './creation-review-store.js'
export type { ReviewLineagePlan, ReviewLineageProof } from './creation-review-store.js'
export { lineageHash } from './review-authority-lineage.js'
export type { ConfigurationEvidence, LineageScope, ReviewPublicIdentity } from './review-authority-lineage.js'

export type ReviewLaneConfig = CreationReviewConfig | RevisionReviewConfig | RevisionRegressionReviewConfig

/** The public, backend-neutral identity a review lane's grant hands off between authorities.
 * Compiling reads the lane's private signing key (to derive the public key), so `config.keyPath`
 * must point at the key the caller intends to bind, e.g. inside a stopped staged Home. */
export function reviewPublicIdentity(lane: 'creation-reviews', config: CreationReviewConfig): ReviewPublicIdentity
export function reviewPublicIdentity(lane: 'revision-reviews', config: RevisionReviewConfig): ReviewPublicIdentity
export function reviewPublicIdentity(lane: 'revision-regressions', config: RevisionRegressionReviewConfig): ReviewPublicIdentity
export function reviewPublicIdentity(lane: LineageScope['lane'], config: ReviewLaneConfig): ReviewPublicIdentity
export function reviewPublicIdentity(lane: LineageScope['lane'], config: ReviewLaneConfig): ReviewPublicIdentity {
  const compiled = lane === 'creation-reviews' ? compileCreationReviewConfig(config as CreationReviewConfig)
    : lane === 'revision-reviews' ? compileRevisionReviewConfig(config as RevisionReviewConfig)
      : lane === 'revision-regressions' ? compileRevisionRegressionReviewConfig(config as RevisionRegressionReviewConfig)
        : undefined
  if (!compiled) throw new Error('review public identity: unknown lane')
  const c = compiled.config, runner = c.runner
  const key = createPublicKey(compiled.publicKey)
  const identity: ReviewPublicIdentity = {
    authority: { ...compiled.authority },
    publicKey: compiled.publicKey,
    keyFingerprint: createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex'),
    owner: { ...c.owner },
    maximum: c.maxVerifications,
    // Only backend-neutral runner bounds; backend-specific fields stay inside authorityDigest.
    runner: { logicalStateRoot: runner.stateRoot, maxRuns: runner.maxRuns, maxTotalDurationMs: runner.maxTotalDurationMs,
      maxDurationMs: runner.maxDurationMs, maxOutputBytes: runner.maxOutputBytes, expiresAt: runner.expiresAt },
    budget: lane === 'revision-regressions'
      ? { maxDurationMs: c.maxDurationMs, maxCases: c.maxCases, receiptTtlMs: c.receiptTtlMs }
      : { policy: (c as CreationReviewConfig).policy, maxInputBytes: (c as CreationReviewConfig).maxInputBytes,
        maxOutputTokens: (c as CreationReviewConfig).maxOutputTokens, maxDurationMs: c.maxDurationMs,
        maxCases: c.maxCases, receiptTtlMs: c.receiptTtlMs },
  }
  validateIdentity(identity); validateLane(identity, lane)
  return identity
}
