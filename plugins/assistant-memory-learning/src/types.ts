import type { MemoryLearningOwner, MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import type { OwnerForegroundTaskSourceCursor } from '@dsh-enhanced/assistant-delivery'

export interface LearningModel { provider: string; model: string; reasoningEffort?: string }
export interface LearningConfig {
  databasePath: string
  authorityId: string
  owner: MemoryLearningOwner
  expiresAt: number
  maxExtractions: number
  maxPending: number
  lookbackMs: number
  policy: string
  maxInputBytes: number
  maxOutputTokens: number
  timeoutMs: number
  budgetId: string
  budgetAmount: number
  scanBudgetId: string
  scanBudgetAmount: number
  reviewAuthorityId: string
  reviewAuthorityDigest: string
  adoptionAuthorityId: string
  adoptionGrantDigest: string
  workItemExperiences?: boolean
  model?: LearningModel
}
export type LearningCursor = OwnerForegroundTaskSourceCursor | Readonly<{ scopeKey: string; watermark: number }>
/** Feed metadata only. Source text/model are frozen later, once reply is readable. */
interface LearningIntentBase {
  configDigest: string
  owner: MemoryLearningOwner
  kind: 'fact' | 'experience'
  subject: string
  expectedSourceDigest?: string
  canonical?: { outcomeId: string; version: number; digest: string; objectiveStatus: 'achieved' | 'not-achieved' }
  createdAt: number
  expiresAt: number
}
export type LearningIntent = LearningIntentBase & (
  { sourceKind?: never; inboxId: string; itemId?: never } |
  { sourceKind: 'work-item'; itemId: string; inboxId?: never; kind: 'experience'; canonical: NonNullable<LearningIntentBase['canonical']> }
)
interface LearningSnapshotBase {
  model: LearningModel
  targets: readonly Readonly<{ id: string; version: number; kind: 'fact' | 'experience'; content: string;
    knowledge?: import('@dsh-enhanced/assistant-growth-contract').MemoryLearningEntry['knowledge'] }>[]
}
export type WorkItemPresentationFlags = Readonly<Record<'brief' | 'report' | 'feedback', Readonly<{ truncated: boolean; redacted: boolean }>>>
export type LearningSnapshot = LearningSnapshotBase & (
  { source: Extract<MemoryLearningReviewRequest, { protocol: 'memory-learning-review/v1' }>['source']; sourceKind?: never; ownerStatement: string; assistantReply: string; ownerFeedback?: string; taskBrief?: never; workerReport?: never } |
  { presentationFlags: WorkItemPresentationFlags; source: Extract<MemoryLearningReviewRequest, { protocol: 'memory-learning-review/v2' }>['source']; sourceKind: 'work-item'; taskBrief: string; workerReport: string; ownerFeedback: string; ownerStatement?: never; assistantReply?: never }
)
export type LearningState = 'pending' | 'queued' | 'running' | 'unknown' | 'adopted' | 'rejected' | 'noop' | 'failed' | 'superseded'
export interface LearningJob {
  id: string
  intent: LearningIntent
  digest: string
  state: LearningState
  snapshot: LearningSnapshot | null
  definitionHash: string | null
  occurrenceId: string | null
  request: MemoryLearningReviewRequest | null
  resultDigest: string | null
  reason: string | null
}
