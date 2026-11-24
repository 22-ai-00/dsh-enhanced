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

export type OwnerSelfIterationAction =
  | 'enableSelfIteration'
  | 'disableSelfIteration'
  | 'upgradeAssistantAndRecover'

export interface ParsedOwnerSelfIterationCommand {
  readonly action: OwnerSelfIterationAction
  readonly sourceText: string
}

const ownerSelfIterationExactPhrases: Readonly<Record<string, OwnerSelfIterationAction>> = Object.freeze({
  开启自迭代: 'enableSelfIteration',
  打开自迭代: 'enableSelfIteration',
  启用自迭代: 'enableSelfIteration',
  开启助手自迭代: 'enableSelfIteration',
  打开助手自迭代: 'enableSelfIteration',
  启用助手自迭代: 'enableSelfIteration',
  开启整体自迭代: 'enableSelfIteration',
  启用整体自迭代: 'enableSelfIteration',
  'enable self-iteration': 'enableSelfIteration',
  'enable self iteration': 'enableSelfIteration',
  'enable autonomy': 'enableSelfIteration',
  关闭自迭代: 'disableSelfIteration',
  停用自迭代: 'disableSelfIteration',
  暂停自迭代: 'disableSelfIteration',
  关闭助手自迭代: 'disableSelfIteration',
  停用助手自迭代: 'disableSelfIteration',
  暂停助手自迭代: 'disableSelfIteration',
  关闭整体自迭代: 'disableSelfIteration',
  停用整体自迭代: 'disableSelfIteration',
  'disable self-iteration': 'disableSelfIteration',
  'disable self iteration': 'disableSelfIteration',
  'disable autonomy': 'disableSelfIteration',
  升级整体助手: 'upgradeAssistantAndRecover',
  升级助手: 'upgradeAssistantAndRecover',
  升级并恢复助手: 'upgradeAssistantAndRecover',
  升级并恢复整体助手: 'upgradeAssistantAndRecover',
  整体升级助手: 'upgradeAssistantAndRecover',
  'upgrade assistant': 'upgradeAssistantAndRecover',
  'upgrade autonomy': 'upgradeAssistantAndRecover',
})

const ownerSelfIterationSlashActions: Readonly<Record<string, OwnerSelfIterationAction>> = Object.freeze({
  enable: 'enableSelfIteration',
  disable: 'disableSelfIteration',
  upgrade: 'upgradeAssistantAndRecover',
})

/**
 * Deterministic closed-set parser for owner self-iteration control intents.
 * Rejects questions, multi-clause prose, and conversational mentions of "自迭代"/"升级".
 */
export function parseOwnerSelfIterationCommand(
  text: string,
): ParsedOwnerSelfIterationCommand | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined

  const slashMatch = /^\/autonomy[\t ]+([a-z]+)$/iu.exec(trimmed)
  if (slashMatch !== null) {
    const action = ownerSelfIterationSlashActions[slashMatch[1]!.toLowerCase()]
    return action === undefined ? undefined : Object.freeze({ action, sourceText: text })
  }

  if (/[?？]$/u.test(trimmed)) return undefined
  const normalized = trimmed.replace(/[。.!！]$/u, '').trim().replace(/[\t ]+/gu, ' ').toLowerCase()
  const action = ownerSelfIterationExactPhrases[normalized]
  return action === undefined ? undefined : Object.freeze({ action, sourceText: text })
}

export type OwnerVersionQueryKind = 'version' | 'autonomy-version' | 'natural-language'

export interface ParsedOwnerVersionQuery {
  readonly action: 'versionInfo'
  readonly kind: OwnerVersionQueryKind
  readonly sourceText: string
}

const ownerVersionQueryExactPhrases: ReadonlySet<string> = new Set([
  '查看版本',
  '版本信息',
  '当前版本',
  '助手版本',
  '查看当前版本',
  '查看助手版本',
  '现在什么版本',
  '目前什么版本',
  '当前什么版本',
  '查看自迭代次数',
  '自迭代次数',
  '自己迭代了多少次',
  '自迭代了多少次',
  '迭代了多少次',
  '进化了多少次',
  '查看迭代次数',
  '查看进化次数',
  '进化次数',
  'assistant version',
  'self-iteration count',
  'self iteration count',
  'version info',
  'current version',
])

/**
 * Deterministic closed-set parser for read-only assistant version and
 * self-iteration-count queries (`/version`, `/autonomy version`, and concise NL).
 */
export function parseOwnerVersionQuery(text: string): ParsedOwnerVersionQuery | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined

  if (/^\/version$/u.test(trimmed)) {
    return Object.freeze({ action: 'versionInfo', kind: 'version', sourceText: text })
  }
  if (/^\/autonomy[\t ]+version$/iu.test(trimmed)) {
    return Object.freeze({ action: 'versionInfo', kind: 'autonomy-version', sourceText: text })
  }

  const normalized = trimmed
    .replace(/[?？。.!！]$/u, '')
    .trim()
    .replace(/[\t ]+/gu, ' ')
    .toLowerCase()
  if (!ownerVersionQueryExactPhrases.has(normalized)) return undefined
  return Object.freeze({ action: 'versionInfo', kind: 'natural-language', sourceText: text })
}
