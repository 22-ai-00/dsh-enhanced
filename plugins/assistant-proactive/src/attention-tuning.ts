import type { OpportunityProfile } from './types.js'

/** Evaluation cohort for proactive reminders (WP22 slice 2). */
export const proactiveAttentionCohort = Object.freeze({ lane: 'owner-notification', sourceId: 'assistant-proactive/v1' })

/** A verified, tighten-only overlay published by assistant-evaluation. */
export interface AttentionOverlay {
  version: number
  digest: string
  parameters: { interruptionCostDelta: number; minimumUtilityDelta: number; quietExtensionMinutes: number; muted: boolean }
}

const bounded = (value: unknown, max: number, step: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max && (value as number) % step === 0

/**
 * Accepts only a well-formed, non-default overlay inside the fixed bounds.
 * Anything else (missing service, version 0, malformed) means no overlay, which
 * is byte-for-byte the untuned behavior.
 */
export function attentionOverlay(value: unknown): AttentionOverlay | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<AttentionOverlay>
  const parameters = input.parameters as Partial<AttentionOverlay['parameters']> | undefined
  if (!Number.isSafeInteger(input.version) || (input.version as number) < 1 || typeof input.digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(input.digest) || !parameters || typeof parameters !== 'object'
    || !bounded(parameters.interruptionCostDelta, 100, 10) || !bounded(parameters.minimumUtilityDelta, 100, 10)
    || !bounded(parameters.quietExtensionMinutes, 120, 30) || typeof parameters.muted !== 'boolean') return undefined
  return Object.freeze({ version: input.version as number, digest: input.digest, parameters: Object.freeze({
    interruptionCostDelta: parameters.interruptionCostDelta, minimumUtilityDelta: parameters.minimumUtilityDelta,
    quietExtensionMinutes: parameters.quietExtensionMinutes, muted: parameters.muted }) })
}

/**
 * Applies an overlay to a reminder profile. Every effect only makes a reminder
 * less likely or later: higher interruption cost, higher utility threshold,
 * a quiet window widened on both sides (capped below a full day), or muting.
 * Non-remind profiles and profiles without quiet hours keep those fields.
 */
export function tuneProfile(profile: Readonly<OpportunityProfile>, overlay: AttentionOverlay | undefined): Readonly<OpportunityProfile> {
  if (!overlay || profile.mode !== 'remind') return profile
  const { interruptionCostDelta, minimumUtilityDelta, quietExtensionMinutes } = overlay.parameters
  let quietHours = profile.quietHours
  if (quietHours && quietExtensionMinutes > 0) {
    const length = (quietHours.endMinute - quietHours.startMinute + 1440) % 1440
    const room = Math.max(0, 1439 - length)
    const before = Math.min(quietExtensionMinutes, Math.floor(room / 2))
    const after = Math.min(quietExtensionMinutes, room - before)
    quietHours = { timezone: quietHours.timezone, startMinute: (quietHours.startMinute - before + 1440) % 1440, endMinute: (quietHours.endMinute + after) % 1440 }
  }
  return Object.freeze({ ...profile, interruptionCost: profile.interruptionCost + interruptionCostDelta,
    minimumUtility: profile.minimumUtility + minimumUtilityDelta, ...(quietHours ? { quietHours: Object.freeze(quietHours) } : {}) })
}
