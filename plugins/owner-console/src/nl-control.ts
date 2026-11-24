/**
 * Pure browser-safe natural-language parser for owner overall self-iteration controls.
 * Shared across Host tools/services and the browser chat surface (zero node:* imports).
 */

export type OwnerSelfIterationAction =
  | 'enableSelfIteration'
  | 'disableSelfIteration'
  | 'upgradeAssistantAndRecover'

export interface ParsedOwnerSelfIterationCommand {
  readonly action: OwnerSelfIterationAction
  readonly sourceText: string
}

const ENABLE_PATTERN = /^(?:开启自迭代|打开自迭代|启用自迭代|恢复自迭代|enable\s+autonomy|enable\s+self[-\s]+iteration|\/autonomy\s+enable)$/iu
const DISABLE_PATTERN = /^(?:关闭自迭代|停用自迭代|暂停自迭代|disable\s+autonomy|disable\s+self[-\s]+iteration|\/autonomy\s+disable)$/iu
const UPGRADE_PATTERN = /^(?:升级整体助手|升级助手|upgrade\s+assistant|upgrade\s+autonomy|\/autonomy\s+upgrade)$/iu

/** Parse concise Chinese/English owner self-iteration control intents; returns undefined for ordinary chat. */
export function parseOwnerSelfIterationCommand(
  text: string,
): ParsedOwnerSelfIterationCommand | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (/[?？]$/u.test(trimmed)) return undefined
  const normalized = trimmed.replace(/[。！!.]+$/u, '').trim()
  if (normalized === '') return undefined

  if (ENABLE_PATTERN.test(normalized)) {
    return { action: 'enableSelfIteration', sourceText: trimmed }
  }
  if (DISABLE_PATTERN.test(normalized)) {
    return { action: 'disableSelfIteration', sourceText: trimmed }
  }
  if (UPGRADE_PATTERN.test(normalized)) {
    return { action: 'upgradeAssistantAndRecover', sourceText: trimmed }
  }
  return undefined
}
