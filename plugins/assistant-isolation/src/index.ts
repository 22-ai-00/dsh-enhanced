import type { Context } from '@deepseek-ai/cordis'
import { version } from './version.js'
import { AssistantIsolationService, Config } from './service.js'

export const name = 'dsh-enhanced-assistant-isolation'
export { version, AssistantIsolationService, Config }
export { IsolatedVerifierRunner, type IsolatedVerifierRunnerConfig } from './verifier-runner.js'
export { inspectIsolationGrant, type IsolationGrantDiagnostic, type IsolationGrantDiagnosticReason } from './diagnostics.js'
export { probeIsolationRuntime } from './probe.js'
export * from './audit-archive.js'
export { isolationPrincipalDigest } from './service.js'
export type * from './types.js'

export function apply(ctx: Context, config: Config = {}): void { new AssistantIsolationService(ctx, config) }
// Loader unwraps the default export; preserve the trusted plugin identity there.
export default { name, Config, apply }
