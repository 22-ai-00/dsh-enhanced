export type LearningCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'status' }
  | { readonly kind: 'explain' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'rollback-confirm'; readonly preferenceKey: DeliveryT1PreferenceKey }
  | { readonly kind: 'forget-confirm' }
  | { readonly kind: 'forget-prompt' }
  | { readonly kind: 'invalid' }

export const learningCommandUsage = [
  '学习控制命令：',
  '- /learning status：查看当前工作区与 preset 的学习状态。',
  '- /learning explain：查看当前 owner 的 T1 偏好键、值、状态、版本与证据计数。',
  '- /learning pause：暂停收集、激活和注入偏好；已有记录保留。',
  '- /learning resume：恢复学习，并重新使用已有的有效偏好。',
  '- /learning rollback <T1-key> confirm：回滚该键当前激活的偏好。',
  '- /learning forget confirm：永久删除当前工作区与 preset 的偏好学习记录。',
  '',
  '删除不可撤销；必须完整输入 forget confirm，单独输入 forget 不会删除。',
].join('\n')

/** Closed Host catalog subset that owner rollback is allowed to address. */
export const deliveryT1PreferenceKeys = Object.freeze([
  'response.verbosity',
  'response.structure',
  'response.language',
  'response.explanation_depth',
  'suggestion.frequency',
  'recommendation.ranking',
] as const)

export type DeliveryT1PreferenceKey = typeof deliveryT1PreferenceKeys[number]

/** Parse a deliberately closed, case-sensitive owner control grammar. */
export function parseLearningCommand(rawInput: string): LearningCommand {
  // `rawInput` is the exact suffix after `/learning`. Keep the irreversible
  // confirmation byte-exact: one ASCII space separates every token and no
  // surrounding or Unicode whitespace is normalized into authority.
  if (rawInput === '' || rawInput === ' help') return { kind: 'help' }
  if (rawInput === ' status') return { kind: 'status' }
  if (rawInput === ' explain') return { kind: 'explain' }
  if (rawInput === ' pause') return { kind: 'pause' }
  if (rawInput === ' resume') return { kind: 'resume' }
  for (const preferenceKey of deliveryT1PreferenceKeys) {
    if (rawInput === ` rollback ${preferenceKey} confirm`) {
      return { kind: 'rollback-confirm', preferenceKey }
    }
  }
  if (rawInput === ' forget') return { kind: 'forget-prompt' }
  if (rawInput === ' forget confirm') return { kind: 'forget-confirm' }
  return { kind: 'invalid' }
}
