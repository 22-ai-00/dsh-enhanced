import type { OpportunityDecision, OpportunityProfile } from './types.js'

/** Plain text only. The event supplies identifiers, never new instructions or authority. */
export function reminderText(decision: Readonly<OpportunityDecision>, profile: Readonly<OpportunityProfile>): string {
  const objective = decision.objective.length > 500 ? `${decision.objective.slice(0, 500)}…` : decision.objective
  return `主动提醒：目标有新的相关事件\n\n目标：${objective}\n来源：${decision.sourceId}\n事件：${decision.eventId}\n\n配置估值：预期收益 ${profile.expectedBenefit}，成功系数 ${profile.successPpm / 10_000}%，执行成本 ${profile.executionCost}，打扰成本 ${profile.interruptionCost}，潜在损失 ${profile.possibleLoss}；净收益分值 ${decision.utility}。这些是配置估计，未经实际效果验证。\n\n目标仍在等待。本次仅提醒，未执行目标任务。可查看 proactive_status，并用 proactive_feedback 接受或拒绝这条机会。\n机会：${decision.id}`
}

/** A queued reminder expires at the next quiet interval; it cannot arrive during a later silent period. */
export function reminderExpiresAt(decision: Readonly<OpportunityDecision>, profile: Readonly<OpportunityProfile>): number {
  const quiet = profile.quietHours
  if (!quiet) return decision.expiresAt
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: quiet.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const isQuiet = (at: number): boolean => {
    const parts = formatter.formatToParts(new Date(at))
    const minute = Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value)
    return quiet.startMinute < quiet.endMinute ? minute >= quiet.startMinute && minute < quiet.endMinute : minute >= quiet.startMinute || minute < quiet.endMinute
  }
  const start = decision.updatedAt
  if (isQuiet(start)) return start
  // Minute boundaries match the configured granularity; include the extra DST hour.
  const bound = Math.min(decision.expiresAt, start + 26 * 3_600_000)
  for (let at = Math.floor(start / 60_000) * 60_000 + 60_000; at < bound; at += 60_000) if (isQuiet(at)) return at
  return bound
}
