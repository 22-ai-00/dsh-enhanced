import type { Context } from '@deepseek-ai/cordis'
import {
  Config,
  DEFAULT_ASSOCIATION_WEB_LEARNING_CONFIG,
  normalizeAssociationConfig,
  normalizeAssociationWebLearningConfig,
  normalizeConfig,
  type AssociationConfig,
  type NormalizedAssociationConfig,
} from './config.js'
import { AssistantAssociationService } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-association'
export {
  AssistantAssociationService,
  Config,
  DEFAULT_ASSOCIATION_WEB_LEARNING_CONFIG,
  normalizeAssociationConfig,
  normalizeAssociationWebLearningConfig,
  normalizeConfig,
  version,
}
export type { AssociationConfig, NormalizedAssociationConfig }

export * from './types.js'
export * from './sqlite.js'
export * from './write-queue.js'
export * from './tokenize.js'
export * from './entities.js'
export * from './aho-corasick.js'
export * from './bm25.js'
export * from './index-memory.js'
export * from './hot-path.js'
export * from './holdout.js'
export * from './cues.js'
export * from './hysteresis.js'
export * from './tools.js'
export * from './sources.js'
export * from './hebbian.js'
export * from './param-tuning.js'
export * from './dreaming.js'
export * from './intake-signal.js'
export * from './clustering.js'
export * from './eval-pool.js'
export * from './web-fetch.js'
export * from './web-learning-worker.js'
export * from './web-learning-runner.js'
export * from './web-learning-interests.js'
export * from './web-learning.js'
export * from './service.js'

export const inject = ['assistantPolicy'] as const

export function apply(ctx: Context, config: AssociationConfig = {}): void {
  new AssistantAssociationService(ctx, config)
}

export default AssistantAssociationService
