import type { Context } from '@deepseek-ai/cordis'
import { AssistantSkillsService, Config } from './service.js'
import { version } from './version.js'
export const name = 'dsh-enhanced-assistant-skills'
export { version, AssistantSkillsService, Config }
export type * from './definition.js'
export type { SkillComparisonProfile } from './comparison.js'
export type { SealedSkillHoldoutProvider } from './sealed-holdout.js'
export type { ExternalHoldoutProfile } from './external-holdout.js'
export type { SkillComparison, SkillComparisonIdentity, SkillCandidate, SkillDeployment, SkillRun, SkillWatch, SkillWatchCanonicalRevision, SkillWatchCanonicalState, SkillWatchObservation, SkillWatchObservationBinding, SkillWatchObservationResult, StoredSkillDefinition } from './store.js'
export function apply(ctx: Context, config: Config = {}): void { new AssistantSkillsService(ctx, config) }
export default { name, Config, apply }

export type { RepairContinuationProfile } from './repair-profile.js'
export type { RepairExecutionAuthority, RepairExecutionContext, StageFailureCandidateInput } from './service.js'
