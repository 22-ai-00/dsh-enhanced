import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { assertApprovalReviewerSessionEventReady } from './session-event-registration.js'

export const APPROVAL_REVIEWERS = ['user', 'auto-review', 'none'] as const

export type ApprovalReviewer = typeof APPROVAL_REVIEWERS[number]

type ApprovalPolicy = 'ask' | 'never'
type SandboxMode = 'workspace-write' | 'danger-full-access'

export interface ApprovalPermissionState {
  approvalPolicy?: ApprovalPolicy
  approvalPolicyEvent: boolean
  reviewer?: ApprovalReviewer
  reviewerEvent: boolean
  sandboxMode?: SandboxMode
  sandboxModeEvent: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable reviewer selection; log-only and never projected into model history. */
    'assistant-policy/approval-reviewer': {
      reviewer: ApprovalReviewer
    }
  }
}

function isApprovalReviewer(value: unknown): value is ApprovalReviewer {
  return typeof value === 'string' && (APPROVAL_REVIEWERS as readonly string[]).includes(value)
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

function lastPermissionEvent(
  events: readonly SessionEvent[],
  type: string,
): { present: boolean; data?: Readonly<Record<string, unknown>>; event?: SessionEvent } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (String(event.type) !== type) continue
    const data = asRecord(event.data)
    return data === undefined ? { present: true, event } : { present: true, data, event }
  }
  return { present: false }
}

/** Fold the three durable permission dimensions without inventing missing values. */
export function approvalPermissionStateOf(events: readonly SessionEvent[]): ApprovalPermissionState {
  const approval = lastPermissionEvent(events, 'approval/policy')
  const reviewer = lastPermissionEvent(events, 'assistant-policy/approval-reviewer')
  const sandbox = lastPermissionEvent(events, 'sandbox/mode')
  const approvalPolicy = approval.data?.policy
  const reviewerValue = reviewer.data?.reviewer
  const sandboxMode = sandbox.data?.mode
  return {
    approvalPolicyEvent: approval.present,
    ...(approvalPolicy === 'ask' || approvalPolicy === 'never' ? { approvalPolicy } : {}),
    reviewerEvent: reviewer.present,
    ...(isApprovalReviewer(reviewerValue) ? { reviewer: reviewerValue } : {}),
    sandboxModeEvent: sandbox.present,
    ...(sandboxMode === 'workspace-write' || sandboxMode === 'danger-full-access' ? { sandboxMode } : {}),
  }
}

/** Stable exact-state fingerprint used to close asynchronous reviewer races. */
export function approvalPermissionFingerprint(events: readonly SessionEvent[]): string {
  return JSON.stringify([
    'permission/preset',
    'sandbox/mode',
    'approval/policy',
    'assistant-policy/approval-reviewer',
  ].map((type) => {
    const current = lastPermissionEvent(events, type).event
    return current === undefined ? null : [current.seq, String(current.type), current.data]
  }))
}

export function hasCoherentFullAccess(events: readonly SessionEvent[]): boolean {
  const state = approvalPermissionStateOf(events)
  return state.approvalPolicyEvent && state.approvalPolicy === 'never'
    && reviewerIntentOf(events) === 'none'
    && state.sandboxModeEvent && state.sandboxMode === 'danger-full-access'
}

export function hasCoherentAutoReview(events: readonly SessionEvent[]): boolean {
  const state = approvalPermissionStateOf(events)
  return state.approvalPolicyEvent && state.approvalPolicy === 'ask'
    && reviewerIntentOf(events) === 'auto-review'
    && state.sandboxModeEvent && state.sandboxMode === 'workspace-write'
}

/**
 * Resolve reviewer intent from the latest durable selector event. The official
 * three-level bundle uses stable preset ids; every other preset is treated as
 * human-reviewed unless a later legacy reviewer event explicitly says
 * otherwise. That default is intentionally fail-closed and lets old logs and
 * third-party one-workspace-preset bundles keep using the compatibility event.
 */
function reviewerIntentOf(events: readonly SessionEvent[]): ApprovalReviewer {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'assistant-policy/approval-reviewer') {
      return isApprovalReviewer(event.data.reviewer) ? event.data.reviewer : 'user'
    }
    if (event.type !== 'permission/preset') continue
    const preset = event.data.preset
    if (preset === 'auto') return 'auto-review'
    if (preset === 'danger-full-access') return 'none'
    return 'user'
  }
  return 'user'
}

/** Return the last valid reviewer event, without applying approval-policy compatibility. */
export function foldApprovalReviewer(events: readonly SessionEvent[]): ApprovalReviewer | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'assistant-policy/approval-reviewer') continue
    return isApprovalReviewer(event.data.reviewer) ? event.data.reviewer : undefined
  }
  return undefined
}

/**
 * Resolve a reviewer conservatively against the standard approval policy.
 * Inconsistent intermediate event order never widens authority.
 */
export function approvalReviewerOf(events: readonly SessionEvent[]): ApprovalReviewer {
  if (hasCoherentFullAccess(events)) return 'none'
  return hasCoherentAutoReview(events) ? 'auto-review' : 'user'
}

export function getApprovalReviewer(session: Pick<Session, 'events'>): ApprovalReviewer {
  return approvalReviewerOf(session.events)
}

/** Append a validated reviewer transition only when it changes the durable selection. */
export function setApprovalReviewer(session: Session, reviewer: ApprovalReviewer): boolean {
  if (!isApprovalReviewer(reviewer)) {
    throw new TypeError('approval reviewer must be one of "user", "auto-review", or "none"')
  }
  if (reviewerIntentOf(session.events) === reviewer) return false
  assertApprovalReviewerSessionEventReady(session)
  session.append('assistant-policy/approval-reviewer', { reviewer })
  return true
}
