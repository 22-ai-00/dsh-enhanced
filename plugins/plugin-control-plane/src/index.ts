import type { Context } from '@deepseek-ai/cordis'
import { PluginControlPlaneService, normalizeControlPlaneConfig, type Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-plugin-control-plane'
export { PluginControlPlaneService, normalizeControlPlaneConfig, version }
export { Config } from './service.js'
export type { NormalizedControlPlaneConfig } from './service.js'
export * from './catalog.js'
export * from './errors.js'
export * from './source-workspace.js'
export * from './approval.js'
export type { SourceApprovalClientConfig } from './source-approval-client.js'
export { validateSourceApprovalAuthorityConfig } from './source-approval-authority.js'
export type { SourceApprovalAuthorityConfig, SourceApprovalRequest } from './source-approval-authority.js'
export type { SourceAdoptionConfig } from './source-adoption-runner.js'
export { validateSourceAdoptionAuthorityConfig } from './source-adoption-authority.js'
export type { SourceAdoptionAuthorityConfig } from './source-adoption-authority.js'
export * from './attestation.js'
export * from './host-attestor.js'
export * from './runtime-observer.js'
export type { ForegroundDeploymentConfig } from './foreground-deployment-runtime.js'
export type * from './task-observation-types.js'
export { validateTaskObservationAuthorityConfig } from './task-observation-authority.js'
export type { TaskObservationAuthorityConfig } from './task-observation-authority.js'
export type { ForegroundDeploymentRecord } from './foreground-deployment.js'
export * from './effect-blocked-replay.js'
export * from './replay-endpoint.js'
export * from './lockfile.js'
export * from './release.js'
export { validateSourceReleaseAuthorityConfig } from './source-release-authority.js'
export type { SourceReleaseAuthorityConfig } from './source-release-authority.js'
export * from './service.js'
export * from './sqlite.js'
export * from './store.js'
export * from './types.js'
export * from './trust.js'
export type * from './source-job-types.js'
export type { EnqueueSourceJobInput, SourceJobCaller } from './source-jobs.js'

export function apply(ctx: Context, config: Config): void {
  new PluginControlPlaneService(ctx, config)
}

export default PluginControlPlaneService

export type { AdoptionHandoffTerms, AdoptionHandoffRecord } from './adoption-handoff.js'
export type { AdoptionCoordinatorConfig } from './adoption-coordinator.js'
