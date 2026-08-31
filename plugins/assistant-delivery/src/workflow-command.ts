export type WorkflowCommand =
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'retract' }>
  | Readonly<{ kind: 'save'; name: string; cron: string; timezone: string }>
  | Readonly<{ kind: 'invalid' }>

export const workflowCommandUsage = [
  '把一条已完成任务保存为可审批的自动化：',
  '1. 直接回复那条任务结果消息；',
  '2. 发送 `/workflow save name="每日摘要" cron="0 9 * * *" timezone="UTC"`。',
  '',
  '撤回同一条任务的学习证据：回复原结果并发送 `/workflow retract`。',
  '保存只会生成候选与审批，不会直接启用自动化。未经证明脱敏的提示词只保存在 owner 私有账本，并在审批中明确披露。',
].join('\n')

function decodeJsonString(input: string): string | undefined {
  try {
    const value = JSON.parse(input) as unknown
    if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || value === '') return undefined
    return value
  } catch {
    return undefined
  }
}

/** Closed, copy/paste friendly grammar; unknown or duplicate fields fail closed. */
export function parseWorkflowCommand(rawInput: string): WorkflowCommand {
  if (rawInput === '' || rawInput === ' help') return Object.freeze({ kind: 'help' })
  if (rawInput === ' retract') return Object.freeze({ kind: 'retract' })
  if (!rawInput.startsWith(' save ')) return Object.freeze({ kind: 'invalid' })
  const input = rawInput.slice(' save '.length)
  const fields = new Map<string, string>()
  const field = /(?:^| )([a-z]+)=("(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")/gu
  let cursor = 0
  for (const match of input.matchAll(field)) {
    if (match.index !== cursor || match[1] === undefined || match[2] === undefined
      || !['name', 'cron', 'timezone'].includes(match[1]) || fields.has(match[1])) {
      return Object.freeze({ kind: 'invalid' })
    }
    const value = decodeJsonString(match[2])
    if (value === undefined) return Object.freeze({ kind: 'invalid' })
    fields.set(match[1], value)
    cursor = match.index + match[0].length
  }
  if (cursor !== input.length || fields.size !== 3) return Object.freeze({ kind: 'invalid' })
  return Object.freeze({
    kind: 'save',
    name: fields.get('name')!,
    cron: fields.get('cron')!,
    timezone: fields.get('timezone')!,
  })
}
