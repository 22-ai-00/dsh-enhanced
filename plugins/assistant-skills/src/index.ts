import type { Context } from '@deepseek-ai/cordis'
import { AssistantSkillsService, Config } from './service.js'
import { version } from './version.js'
export const name = 'dsh-ray-assistant-skills'
export { version, AssistantSkillsService, Config }
export type * from './definition.js'
export {
  SUPPORTED_SKILL_PRECONDITIONS,
  WORKFLOW_FAMILY_IDS,
  preconditionDirective,
  evaluatePreconditionPlan,
  evaluatePreconditions,
  assertDefinitionProtocol,
  assertDefinitionProtocolFamilies,
  compensationDirective,
  createDefinition,
  instantiate,
  validateStepGraph,
} from './definition.js'
export * from './workflows.js'
export type { SkillComparisonProfile } from './comparison.js'
export type { SealedSkillHoldoutProvider } from './sealed-holdout.js'
export type { ExternalHoldoutProfile } from './external-holdout.js'
export type {
  AssistantRecoveryCompensationPort,
  CapturedPreimage,
  RecoveryCompensationExecutionRequest,
  RecoveryCompensationExecutionResult,
  SkillCompensationHandler,
} from './compensation.js'
export type { SkillComparison, SkillComparisonIdentity, SkillCandidate, SkillCompensationRecord, SkillCompensationStatus, SkillDeployment, SkillRun, SkillWatch, SkillWatchCanonicalRevision, SkillWatchCanonicalState, SkillWatchObservation, SkillWatchObservationBinding, SkillWatchObservationResult, StoredSkillDefinition } from './store.js'
export function apply(ctx: Context, config: Config = {}): void { new AssistantSkillsService(ctx, config) }
export default { name, Config, apply }

export type { RepairContinuationProfile } from './repair-profile.js'
export type { RepairExecutionAuthority, RepairExecutionContext, StageFailureCandidateInput, OwnerSuccessCandidateAuthority, StageSuccessCandidateInput } from './service.js'

export { validateRepairProfiles } from './repair-profile.js'
export { validateExternalHoldoutProfiles } from './external-holdout.js'
export { openHoldoutProcess } from './external-holdout.js'
export { verifyProspectiveBenchmarkManifest } from './holdout-authority.js'
export { verifyProspectiveCertificate } from './prospective-holdout.js'
export { verifyHoldoutReceipt } from './holdout-qualification.js'
export type { BeginResult, ProspectiveBenchmarkManifest, ProspectiveBenchmarkManifestCase, ProspectiveBenchmarkManifestCell, QualificationBinding } from './holdout-authority.js'
export type { ProspectiveHoldoutCertificate } from './prospective-holdout.js'
export type { IssuedHoldoutCells } from './holdout-qualification.js'

export type { BenchmarkArmSelection, BenchmarkArmSnapshot, BenchmarkArmCapability, BenchmarkArmMount } from './delegated-arm.js'
export type { SkillDelegatedArmBinding } from './store.js'
