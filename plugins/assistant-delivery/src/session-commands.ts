import type { InboundEnvelope } from './types.js'

export interface ParsedDeliveryCommand {
  name: string
  rawInput: string
}

export type PermissionDispatchRecovery = 'cancelled' | 'commit' | 'failure-notice'

const permissionDispatchRecoveryCodes = Object.freeze({
  cancelled: 'permission-cancelled-recovery',
  commit: 'permission-dispatch-recovery',
  'failure-notice': 'permission-failure-notice-recovery',
} satisfies Record<PermissionDispatchRecovery, string>)

/**
 * Parse the same conservative slash grammar used by DSH's command plane.
 * The command must start at byte zero and names stay lowercase so a channel
 * never normalizes an unknown prompt into a privileged control operation.
 */
export function parseDeliveryCommand(
  envelope: Readonly<Pick<InboundEnvelope, 'kind' | 'text'>>,
): ParsedDeliveryCommand | undefined {
  if (envelope.kind !== 'command') return undefined
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(envelope.text)
  if (match === null) return undefined
  const name = match[1]!
  return { name, rawInput: envelope.text.slice(name.length + 1) }
}

export function isExactDeliveryCommand(
  command: ParsedDeliveryCommand | undefined,
  ...names: readonly string[]
): boolean {
  return command !== undefined && command.rawInput.trim() === '' && names.includes(command.name)
}

export function isPermissionDeliveryCommand(
  envelope: Readonly<Pick<InboundEnvelope, 'kind' | 'text'>>,
): boolean {
  const command = parseDeliveryCommand(envelope)
  return command?.name === 'permission' || command?.name === 'permissions'
}

/** Typed feedback dispatches only replay-safe idempotent Host ledger writes. */
export function isFeedbackDeliveryCommand(
  envelope: Readonly<Pick<InboundEnvelope, 'kind' | 'text'>>,
): boolean {
  return parseDeliveryCommand(envelope)?.name === 'feedback'
}

/** Workflow commands commit only idempotent owner-ledger revisions. */
export function isWorkflowDeliveryCommand(
  envelope: Readonly<Pick<InboundEnvelope, 'kind' | 'text'>>,
): boolean {
  return parseDeliveryCommand(envelope)?.name === 'workflow'
}

/** Learning controls commit only idempotent owner-scoped Preference mutations. */
export function isLearningDeliveryCommand(
  envelope: Readonly<Pick<InboundEnvelope, 'kind' | 'text'>>,
): boolean {
  return parseDeliveryCommand(envelope)?.name === 'learning'
}

export const feedbackDispatchRecoveryCode = 'feedback-dispatch-recovery' as const
export const workflowDispatchRecoveryCode = 'workflow-dispatch-recovery' as const
export const learningDispatchRecoveryCode = 'learning-dispatch-recovery' as const

export function isLearningDispatchRecoveryCode(value: string | undefined): boolean {
  return value === learningDispatchRecoveryCode
}

export function isWorkflowDispatchRecoveryCode(value: string | undefined): boolean {
  return value === workflowDispatchRecoveryCode
}

export function isFeedbackDispatchRecoveryCode(value: string | undefined): boolean {
  return value === feedbackDispatchRecoveryCode
}

export function isFeedbackRetryableFailureCode(value: string | undefined): boolean {
  return value === 'preference-feedback-state-unknown' || value === 'objective-feedback-state-unknown'
}

export function isLearningRetryableFailureCode(value: string | undefined): boolean {
  return value === 'learning-control-state-unknown'
}

export function permissionDispatchRecoveryCode(recovery: PermissionDispatchRecovery): string {
  return permissionDispatchRecoveryCodes[recovery]
}

export function permissionDispatchRecoveryFromFailureCode(
  failureCode: string | undefined,
): PermissionDispatchRecovery | undefined {
  if (failureCode === permissionDispatchRecoveryCodes.cancelled) return 'cancelled'
  if (failureCode === permissionDispatchRecoveryCodes.commit) return 'commit'
  if (failureCode === permissionDispatchRecoveryCodes['failure-notice']) return 'failure-notice'
  return undefined
}
