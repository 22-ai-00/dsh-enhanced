import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'

/** Frozen at repair arm time; it never grants a new notification window. */
export interface RepairFeedbackAuthority {
  sessionId: string
  expiresAt: number
  routeReceipt: unknown
}

export interface RepairFeedbackScope {
  principalId: string
  principalRecordId: string
  principalVersion: number
  workspace: string
  preset: string
}

export interface RepairFeedbackRecord {
  id: string
  scope: RepairFeedbackScope
  authorization: { ownerRouteId: string }
  routeReceipt: unknown
  feedbackAuthority: RepairFeedbackAuthority
}

/**
 * Callers provide only durable repair facts.  Text deliberately excludes
 * source prompts, model output, paths, and identifiers from the repair work.
 */
export type RepairFeedbackMilestone =
  | 'independent-acceptance'
  | 'candidate-staged'
  | 'finite-canary'
  | 'iteration-success'
  | 'final-success'
  | 'successor-failed'
  | 'interrupted'
  | 'budget-exhausted'

export interface RepairIterationOutcome {
  iteration: number
  maxIterations: number
  state: string
  milestone: RepairFeedbackMilestone
  candidateId?: string
  deploymentId?: string
  goalId?: string
}

export interface RepairFeedbackDelivery {
  validateOwnerRoute(input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }): unknown
  enqueueOwnerNotification(input: {
    sourceId: string
    ownerRouteId: string
    scope: RepairFeedbackScope
    sessionId: string
    idempotencyKey: string
    text: string
    expiresAt: number
  }): unknown
}

export type RepairFeedbackResult =
  | { outcome: 'queued'; idempotencyKey: string; text: string }
  | { outcome: 'not-queued'; reason: 'expired' | 'route-not-current' | 'delivery-rejected' }

const sourceId = 'dsh-enhanced-assistant-skills'
const milestones: Readonly<Record<RepairFeedbackMilestone, string>> = {
  'independent-acceptance': 'The repair result received independent acceptance.',
  'candidate-staged': 'An independently accepted repair candidate was staged.',
  'finite-canary': 'The staged candidate entered its finite canary evaluation.',
  'iteration-success': 'The repair iteration completed its independently accepted finite-canary path.',
  'final-success': 'The finite repair sequence ended with an independently accepted successor after its finite canary path.',
  'successor-failed': 'The proposed successor did not pass the finite repair sequence.',
  interrupted: 'The repair sequence stopped after an interruption; its result is unknown.',
  'budget-exhausted': 'The finite repair budget ended without another authorized successor.',
}

function validText(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validScope(scope: RepairFeedbackScope): boolean {
  return validText(scope.principalId, 1_024) && validText(scope.principalRecordId, 1_024)
    && validPositive(scope.principalVersion) && validText(scope.workspace, 4_096) && validText(scope.preset, 200)
}

function validRecord(record: RepairFeedbackRecord): boolean {
  return validText(record.id, 512) && validText(record.authorization.ownerRouteId, 512) && validScope(record.scope)
    && validText(record.feedbackAuthority.sessionId, 512) && Number.isSafeInteger(record.feedbackAuthority.expiresAt)
    && record.feedbackAuthority.routeReceipt !== undefined && record.routeReceipt !== undefined
}

function validOutcome(outcome: RepairIterationOutcome): boolean {
  return validPositive(outcome.iteration) && validPositive(outcome.maxIterations) && outcome.iteration <= outcome.maxIterations
    && validText(outcome.state, 128) && Object.hasOwn(milestones, outcome.milestone)
}

/** Deterministic, private status text. It never says the original goal is complete or that a person read it. */
export function renderRepairFeedback(outcome: RepairIterationOutcome): string {
  if (!validOutcome(outcome)) throw new Error('assistant-skills: invalid repair feedback outcome')
  const round = `Repair iteration ${outcome.iteration} of ${outcome.maxIterations}.`
  const terminal = outcome.milestone === 'final-success' || outcome.milestone === 'successor-failed'
    || outcome.milestone === 'interrupted' || outcome.milestone === 'budget-exhausted'
  return `${round} ${milestones[outcome.milestone]}${terminal ? ' This update reports the bounded repair sequence only; it does not establish that the original objective is complete or that this notice was read.' : ''}`
}

export function repairFeedbackIdempotencyKey(record: Pick<RepairFeedbackRecord, 'id'>, outcome: Pick<RepairIterationOutcome, 'iteration' | 'milestone'>): string {
  if (!validText(record.id, 512) || !validPositive(outcome.iteration) || !Object.hasOwn(milestones, outcome.milestone)) throw new Error('assistant-skills: invalid repair feedback idempotency input')
  return `repair-feedback:${record.id}:${outcome.iteration}:${outcome.milestone}`
}

/**
 * Queue one already-authorized owner notice. Delivery owns the final send-Policy
 * check; route, lineage, receipt, session, and expiry are fenced before queueing.
 */
export function enqueueRepairFeedback(delivery: RepairFeedbackDelivery, record: RepairFeedbackRecord, outcome: RepairIterationOutcome): RepairFeedbackResult {
  if (!validRecord(record) || !validOutcome(outcome)) throw new Error('assistant-skills: invalid repair feedback input')
  if (Date.now() >= record.feedbackAuthority.expiresAt) return { outcome: 'not-queued', reason: 'expired' }
  // The arm-time receipt and the record receipt must describe the same exact route.
  if (acceptanceDigest(record.routeReceipt) !== acceptanceDigest(record.feedbackAuthority.routeReceipt)) return { outcome: 'not-queued', reason: 'route-not-current' }
  let receipt: unknown
  try {
    receipt = delivery.validateOwnerRoute({ authorityId: record.authorization.ownerRouteId, principalId: record.scope.principalId,
      workspace: record.scope.workspace, agentPreset: record.scope.preset })
  } catch { return { outcome: 'not-queued', reason: 'route-not-current' } }
  if (acceptanceDigest(receipt) !== acceptanceDigest(record.routeReceipt)) return { outcome: 'not-queued', reason: 'route-not-current' }
  const idempotencyKey = repairFeedbackIdempotencyKey(record, outcome)
  const text = renderRepairFeedback(outcome)
  try {
    delivery.enqueueOwnerNotification({ sourceId, ownerRouteId: record.authorization.ownerRouteId, scope: record.scope,
      sessionId: record.feedbackAuthority.sessionId, idempotencyKey, text, expiresAt: record.feedbackAuthority.expiresAt })
  } catch { return { outcome: 'not-queued', reason: 'delivery-rejected' } }
  return { outcome: 'queued', idempotencyKey, text }
}
