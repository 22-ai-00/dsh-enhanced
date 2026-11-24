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

export {
  AssistantDreamingService,
  type AcknowledgeIdeaInput,
  type DreamIdeaTransition,
  type DreamIdeaTransitionResult,
  type DreamingHealth,
  type TransitionIdeaInput,
} from './runtime.js'
export { Config, hasCompleteDreamingPrerequisites, normalizeConfig, type DreamingConfig, type DreamingScopeConfig, type NormalizedDreamingConfig } from './config.js'
export {
  decideTrigger,
  evaluateDraw,
  isIdle,
  isWithinActiveHours,
  localDayKey,
  slotOccurrence,
  type LotterySubjectKind,
  type TriggerDecision,
} from './trigger.js'
export { DreamStore, type DreamIdea, type DreamRunRecord, type IdeaEvent, type IdeaState } from './store.js'
export { buildDreamMaterial, type DreamMaterial, type DreamEvidenceItem, type DreamPersonalMemoryPort } from './projection.js'
export { runDreamAgent, type DreamAgentResult, type DreamAgentModel, type SubmittedIdea } from './dream-agent.js'
export { version }

export function apply(ctx: Context, config: DreamingConfig): void {
  new AssistantDreamingService(ctx, config)
}

export default AssistantDreamingService
