import { createHash } from 'node:crypto'
import type { OpportunityDecision, OpportunityProfile } from './types.js'

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })
const objectiveLimit = 200

function excerpt(value: string): string {
  const parts: string[] = []
  for (const part of graphemes.segment(value.replace(/\s+/gu, ' ').trim())) {
    if (parts.length === objectiveLimit) return `${parts.join('')}…`
    parts.push(part.segment)
  }
  return parts.join('')
}

/**
 * Owner-facing plain text. It carries only the owner's own objective plus fixed wording: no operator
 * estimates, utility, source/event/decision identifiers or event content. Those stay in `proactive_status`.
 */
export function reminderText(decision: Readonly<Pick<OpportunityDecision, 'objective'>>): string {
  return `主动提醒：目标有新的相关事件\n\n目标：${excerpt(decision.objective)}\n\n目标仍在等待。本次仅提醒，未执行目标任务。如需反馈，可在对话中让助手查看主动提醒，再接受或拒绝。`
}

/**
 * Durable dedupe key for one goal source. It changes only when the text the owner would see, the goal
 * revision/definition or the configured source changes; a new event on an unchanged source does not.
 */
export function reminderContentDigest(decision: Readonly<Pick<OpportunityDecision, 'objective' | 'definitionDigest' | 'nativeGoalId' | 'nativeRevision' | 'sourceId' | 'sourceDigest'>>): string {
  return createHash('sha256').update(JSON.stringify(['assistant-proactive/reminder/v1', decision.sourceId, decision.sourceDigest,
    decision.nativeGoalId, decision.nativeRevision, decision.definitionDigest, reminderText(decision)])).digest('hex')
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
