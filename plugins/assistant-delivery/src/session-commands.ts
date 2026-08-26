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
