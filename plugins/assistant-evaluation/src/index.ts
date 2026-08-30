import type { Context } from '@deepseek-ai/cordis'
import { ASSISTANT_EVALUATION_SKILL, AssistantEvaluationService, Config } from './service.js'
import type { Config as ConfigType } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-evaluation'
export { ASSISTANT_EVALUATION_SKILL, AssistantEvaluationService, Config, version }
export type { ConfigType as AssistantEvaluationConfig }
export { AssistantEvaluationError } from './service.js'
export { EvaluationStore, EvaluationStoreError, canonicalEvaluationScope } from './store.js'
export { EvaluationDatabaseError, evaluationSchemaVersion } from './sqlite.js'
export * from './types.js'

export function apply(ctx: Context, config: ConfigType): void {
  new AssistantEvaluationService(ctx, config)
}

export default AssistantEvaluationService
