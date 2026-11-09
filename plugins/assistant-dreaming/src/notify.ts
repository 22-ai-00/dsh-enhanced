import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'

/**
 * L1 dreaming notification: one bounded, owner-facing text summary of a
 * private idea ledger. The notification never grants adoption, asks for
 * scoring or exposes raw transcripts; it only presents count and a few
 * idea summaries. All delivery goes through the Host's authenticated
 * owner-notification channel, so this module never invokes a model.
 */

export interface DreamNotificationOwner {
  ownerRouteId: string
  principalId: string
  workspace: string
  preset: string
}

export interface DreamNotificationPorts {
  validateOwnerRoute(input: DreamNotificationOwner): {
    principalRecordId: string
    principalVersion: number
  }
  resolveOwnerRoute(ownerRouteId: string): { binding: { sessionId: string } }
  enqueueOwnerNotification(input: {
    sourceId: string
    ownerRouteId: string
    scope: { principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string }
    sessionId: string
    idempotencyKey: string
    text: string
    expiresAt: number
    attention: { purpose: 'result' }
  }): unknown
}

export interface DreamNotificationInput {
  owner: DreamNotificationOwner
  runId: string
  summaries: readonly { summary: string; detail: string }[]
  dayKey: string
  now: number
  expiresAt: number
  maxSummaryLength?: number
}

export const DREAM_NOTIFICATION_SOURCE_ID = 'assistant-dreaming-idea-summary/v1'

const MAX_SUMMARIES = 3
const MAX_SUMMARY_CHARS = 200

export function buildDreamNotificationText(input: DreamNotificationInput): string {
  const maxLength = input.maxSummaryLength ?? MAX_SUMMARY_CHARS
  const lines = [
    '做梦回顾：',
    `本次产生 ${input.summaries.length} 条私有想法。`,
    '',
    ...input.summaries.slice(0, MAX_SUMMARIES).map((idea, index) => {
      const summary = idea.summary.length > maxLength ? `${idea.summary.slice(0, maxLength)}…` : idea.summary
      return `${index + 1}. ${summary}`
    }),
    '',
    '想法仅记录在私有账本，需要你确认后才会进入后续流程；沉默不算认可。',
  ]
  return lines.join('\n')
}

/**
 * Host-only enqueue: validates the live route first so a revoked owner never
 * receives a notification; idempotency is keyed on the wake run and day so a
 * retried wake cannot produce duplicate notices. Returns false when the route
 * is unavailable rather than throwing into the dream wake.
 */
export function enqueueDreamNotification(ports: DreamNotificationPorts, input: DreamNotificationInput): boolean {
  if (input.summaries.length === 0) return false
  try {
    const receipt = ports.validateOwnerRoute(input.owner)
    const { sessionId } = ports.resolveOwnerRoute(input.owner.ownerRouteId).binding
    const text = buildDreamNotificationText(input)
    if (text.length > 16_384) throw new Error('dream notification text exceeds the delivery bound')
    ports.enqueueOwnerNotification({
      sourceId: DREAM_NOTIFICATION_SOURCE_ID,
      ownerRouteId: input.owner.ownerRouteId,
      scope: { principalId: input.owner.principalId, principalRecordId: receipt.principalRecordId,
        principalVersion: receipt.principalVersion, workspace: input.owner.workspace, preset: input.owner.preset },
      sessionId,
      idempotencyKey: acceptanceDigest({ protocol: 'dream-notification', runId: input.runId, dayKey: input.dayKey }),
      text,
      expiresAt: input.expiresAt,
      attention: { purpose: 'result' as const },
    })
    return true
  } catch { return false }
}
