import type { Context } from '@deepseek-ai/cordis'
import { AssistantDreamingService } from './runtime.js'
import type { DreamingConfig } from './config.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-dreaming'

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantDreaming: AssistantDreamingService
  }
}

export { AssistantDreamingService } from './runtime.js'
export { Config, normalizeConfig, type DreamingConfig, type DreamingScopeConfig, type NormalizedDreamingConfig } from './config.js'
export { decideTrigger, evaluateDraw, isIdle, isWithinActiveHours, localDayKey, slotOccurrence, type TriggerDecision } from './trigger.js'
export { DreamStore, type DreamIdea, type DreamRunRecord, type IdeaState } from './store.js'
export { buildDreamMaterial, type DreamMaterial, type DreamEvidenceItem } from './projection.js'
export { runDreamAgent, type DreamAgentResult, type DreamAgentModel, type SubmittedIdea } from './dream-agent.js'
export { version }

export function apply(ctx: Context, config: DreamingConfig): void {
  new AssistantDreamingService(ctx, config)
}

export default AssistantDreamingService
