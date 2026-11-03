import type { TrustedTaskLearningProjectionReceipt } from '@dsh-enhanced/assistant-evaluation'
import type { OwnerForegroundTaskSourceContent, OwnerForegroundTaskSourceScope, OwnerRouteValidationReceipt } from './types.js'
import type { OwnerForegroundLearningTask } from './service.js'
import type { WorkItemReplySource } from './work-item-replies.js'
import type { ObjectiveCommand, ObjectiveFeedbackStatus } from './feedback-command.js'

export type WorkItemFeedbackSelection = Readonly<{kind:'natural';value:ObjectiveFeedbackStatus|'withdraw'}> | Readonly<{kind:'explicit';command:ObjectiveCommand}>
export interface WorkItemFeedbackSource {
  readonly protocol:'assistant-delivery/work-item-feedback/v1'
  readonly inboxId:string
  readonly envelopeHash:string
  readonly inputText:string
  readonly inputSha256:string
  readonly admissionCursor:WorkItemReplySource['admissionCursor']
  readonly occurredAt:number
  readonly owner:WorkItemReplySource['owner']
  readonly principalId:string
  readonly binding:WorkItemReplySource['binding']
  readonly scope:WorkItemReplySource['scope']
  readonly target:WorkItemReplySource['target']
  readonly selection:WorkItemFeedbackSelection
  readonly operationId:string
}
export interface WorkItemFeedbackIntent {
  readonly source:WorkItemFeedbackSource
  readonly sourceDigest:string
  readonly state:'pending'|'frozen'|'recorded'|'conflict'|'cancelled'
  readonly command?:ObjectiveCommand
  readonly proofDigest?:string
  readonly canonical?:Readonly<{version:number;objectiveStatus:ObjectiveFeedbackStatus|'unknown';outcomeId?:string}>
}
/** Structural public identity keeps older optional Evaluation type exports loadable while disabled. */
export interface WorkItemFeedbackProofIdentity {
  readonly protocol:'assistant-work-items/owner-report-feedback/v1'
  readonly itemId:string
  readonly reportRevision:number
  readonly reportDigest:string
  readonly sourceId:string
  readonly itemKind:string
  readonly scope:Readonly<{workspace:string;preset:string}>
  readonly owner:Readonly<{ownerRouteId:string;principalId:string;principalRecordId:string;principalVersion:number}>
  readonly originBindingId:string
  readonly production:Readonly<{automationId:string;occurrenceId:string;runId:string;definitionHash:string;definitionVersion:number;
    executionStatus:'succeeded'|'failed'|'timed-out'|'cancelled';completedAt:number;quiescent:true;budgetSettlementState:'finalized'}>
  readonly supplier:Readonly<{provider:string;model:string;reasoningEffort?:string}>
  readonly planDigest:string
  readonly proofDigest:string
}
/** Full proof text is verified privately. This identity's proofDigest binds that original text, never its presentation. */
export interface OwnerWorkItemLearningTask {
  readonly protocol:'assistant-delivery/owner-work-item-learning/v1'
  readonly owner:Readonly<OwnerRouteValidationReceipt>
  readonly canonical:TrustedTaskLearningProjectionReceipt
  readonly judgement:'owner-feedback'
  readonly ownerRevision:Readonly<{version:number;action:'initial'|'correct';operationId:string}>
  readonly proofIdentity:Readonly<WorkItemFeedbackProofIdentity>
  readonly sourceDigest:string
  readonly presentation:Readonly<{
    brief:Readonly<{text:string;truncated:boolean;redacted:boolean}>
    report:Readonly<{text:string;truncated:boolean;redacted:boolean}>
    feedback:Readonly<{inboxId:string;text:string;truncated:boolean;redacted:boolean}>
  }>
  readonly presentationDigest:string
}

/** Exact immutable expectations; foreground v1 identities remain unchanged. */
export type OwnerWorkItemLearningSourceExpectation = Readonly<{
  kind:'work-item';itemId:string;outcomeId:string;expectedSourceDigest:string;expectedContentDigest:string
  canonical:Readonly<{version:number;digest:string;objectiveStatus:'achieved'|'not-achieved'}>
}>
export type OwnerLearningSourceExpectation = Readonly<{kind:'foreground';inboxId:string;expectedSourceDigest:string}> | OwnerWorkItemLearningSourceExpectation
export type OwnerLearningSourceSnapshot = Readonly<{kind:'foreground';inboxId:string;content?:Readonly<OwnerForegroundTaskSourceContent>|undefined;
  currentCanonical?:TrustedTaskLearningProjectionReceipt|undefined;task?:Readonly<OwnerForegroundLearningTask>|undefined;
  ownerRevision?:Readonly<{outcomeId:string;version:number;action:'initial'|'correct'|'withdraw';objectiveStatus:string;operationId?:string}>|undefined}> |
  Readonly<{kind:'work-item';itemId:string;task?:Readonly<OwnerWorkItemLearningTask>|undefined;currentCanonical?:TrustedTaskLearningProjectionReceipt|undefined;
  ownerRevision?:Readonly<{outcomeId:string;version:number;action:'initial'|'correct'|'withdraw';objectiveStatus:string;operationId?:string}>|undefined}>
export type OwnerWorkItemLearningTaskFenceInput = OwnerForegroundTaskSourceScope & Omit<OwnerWorkItemLearningSourceExpectation,'kind'>
