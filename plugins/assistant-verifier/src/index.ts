import type { Context } from '@deepseek-ai/cordis'
import { AssistantVerifierService, Config } from './service.js'
import type { AcceptanceObjectivesSelection, AcceptanceProfileInspection, AcceptanceProfileSelection } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-verifier'
export { AssistantVerifierService, Config, version }
export type { AcceptanceObjectivesSelection, AcceptanceProfileInspection, AcceptanceProfileSelection }
export * from './drivers.js'
export * from './host.js'
export * from './config.js'
export { validateSourceReviewConfig } from './source-review.js'
export type { SourceReviewConfig, SourceReviewInput, SourceReviewRequest, SourceReviewResult, SourceReviewModelSelection, SourceReviewSelection } from './source-review.js'
export { validateMemoryReviewConfig } from './memory-review.js'
export type { MemoryReviewConfig, MemoryReviewReceipt, MemoryReviewAvailability } from './memory-review.js'
export type { PluginBehaviorOperation, PluginBehaviorObservation, PluginBehaviorRunnerInput } from './plugin-behavior-runner.js'
export { compileCreationReviewConfig, validateCreationReviewConfig } from './creation-review.js'
export type { CreationReviewConfig, CreationReviewAuthorityInspection } from './creation-review.js'
export { compileRevisionReviewConfig, validateRevisionReviewConfig } from './revision-review.js'
export type { RevisionReviewConfig, RevisionReviewAuthorityInspection } from './revision-review.js'
export { compileRevisionRegressionReviewConfig, validateRevisionRegressionReviewConfig } from './revision-regression-review.js'
export type { RevisionRegressionReviewConfig, RevisionRegressionReviewAuthorityInspection } from './revision-regression-review.js'

export function apply(ctx: Context, config: Config): void {
  new AssistantVerifierService(ctx, config)
}

export default AssistantVerifierService
