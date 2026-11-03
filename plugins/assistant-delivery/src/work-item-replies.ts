import { createHash } from 'node:crypto'
import type { DeliveryAdmissionCursor, DeliveryOwnerLineage } from './types.js'

export interface WorkItemReportTarget {
  readonly protocol: 'assistant-delivery/work-item-report/v1'
  readonly itemId: string
  readonly reportRevision: number
  readonly streamId: string
  readonly reportDigest: string
  readonly sourceId: string
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly owner: Readonly<DeliveryOwnerLineage>
}
export interface WorkItemReplySource {
  readonly protocol: 'assistant-delivery/work-item-reply/v1'
  readonly id: string
  readonly sourceDigest: string
  readonly admissionCursor: Readonly<DeliveryAdmissionCursor>
  readonly inputText: string
  readonly inputSha256: string
  readonly inputBytes: number
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly principalId: string
  readonly owner: Readonly<DeliveryOwnerLineage>
  readonly binding: Readonly<{ id: string; version: number; generation: number }>
  readonly target: Readonly<{ outboxId: string; providerMessageId: string; itemId: string; reportRevision: number; reportDigest: string; streamId: string }>
  readonly executionParentItemId?: string
  readonly child?: Readonly<{ itemId: string; planDigest: string }>
  readonly state: 'pending' | 'routed' | 'cancelled'
}
export interface WorkItemReplyConsumerRegistration {
  readonly protocol: 1
  readonly sourceId: string
  readonly continuationAutomationId: string
  readonly inspectReport: (input: { itemId: string; reportRevision: number; bindingId: string; idempotencyKey: string; text: string; format: 'plain' | 'markdown' }) => WorkItemReportTarget | undefined
  readonly inspectChild: (input: { replyId: string; sourceDigest: string; parentItemId: string; childItemId: string; childPlanDigest: string }) => boolean
  readonly onPending: () => void
  readonly onCancelled: (childItemIds: readonly string[]) => void
}
export interface WorkItemReplyReadInput { readonly id: string; readonly expectedSourceDigest: string }
export interface WorkItemReplyListInput {
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly owner: Readonly<DeliveryOwnerLineage>
  readonly afterSequence?: number
  readonly limit: number
}
export function workItemReplyCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(workItemReplyCanonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${workItemReplyCanonical(record[key])}`).join(',')}}`
}
export const workItemReplyDigest = (value: unknown): string => createHash('sha256').update(workItemReplyCanonical(value)).digest('hex')

export class WorkItemReplyCancelledError extends Error {
  readonly code = 'work-item-reply-cancelled' as const
  constructor() { super('work item reply was durably cancelled'); this.name = 'WorkItemReplyCancelledError' }
}
