import { createHmac } from 'node:crypto'
import type { DreamingActiveHours } from './config.js'

/**
 * Deterministic dreaming trigger. Randomness is an auditable HMAC draw keyed
 * by an owner seed and a stable occurrence identity, so the same inputs always
 * produce the same decision in tests and after restart. The module never calls
 * Math.random and never schedules anything itself.
 */

export const MILLION = 1_000_000
const MINUTES_PER_DAY = 1_440

export interface DrawInput {
  seedDigest: string
  lane: string
  /** Stable monotonic occurrence number of the scheduler slot. */
  occurrence: number
  /** Probability of dreaming, in parts per million (0..1_000_000). */
  probabilityPpm: number
}

export interface DrawResult {
  drawDigest: string
  /** Uniform value in [0, 1_000_000) derived from the HMAC. */
  value: number
  selected: boolean
}

/**
 * Returns the auditable draw for one slot. Determinism makes the decision
 * replayable; the digest alone is persisted, never the seed.
 */
export function evaluateDraw(input: DrawInput): DrawResult {
  if (!Number.isSafeInteger(input.occurrence) || input.occurrence < 0) {
    throw new Error('dream trigger: occurrence must be a non-negative safe integer')
  }
  if (!Number.isInteger(input.probabilityPpm) || input.probabilityPpm < 0 || input.probabilityPpm > MILLION) {
    throw new Error('dream trigger: probabilityPpm must be an integer in 0..1_000_000')
  }
  const drawDigest = createHmac('sha256', input.seedDigest)
    .update(`assistant-dreaming/v1\0${input.lane}\0${input.occurrence}`)
    .digest('hex')
  const value = Number.parseInt(drawDigest.slice(0, 8), 16) % MILLION
  return { drawDigest, value, selected: value < input.probabilityPpm }
}

/**
 * Local-day key in UTC minutes. The scheduler uses this for per-day caps; a
 * timezone-aware activeHours check happens separately.
 */
export function localDayKey(now: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const parts = formatter.formatToParts(new Date(now))
  const year = parts.find(part => part.type === 'year')?.value
  const month = parts.find(part => part.type === 'month')?.value
  const day = parts.find(part => part.type === 'day')?.value
  if (!year || !month || !day) throw new Error('dream trigger: cannot resolve local day')
  return `${year}-${month}-${day}`
}

function localMinutes(now: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = formatter.formatToParts(new Date(now))
  const hour = Number(parts.find(part => part.type === 'hour')?.value)
  const minute = Number(parts.find(part => part.type === 'minute')?.value)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error('dream trigger: cannot resolve local time')
  return hour * 60 + minute
}

export function isWithinActiveHours(now: number, activeHours: DreamingActiveHours | null): boolean {
  if (activeHours === null) return true
  const minute = localMinutes(now, activeHours.timezone)
  return minute >= activeHours.startMinute && minute < activeHours.endMinute
}

/**
 * Conservative idle gate based on the latest trusted activity timestamp. The
 * caller supplies activity measured through Host projections (never model
 * prose); a missing marker means "not idle" so the first run fails closed.
 */
export function isIdle(now: number, latestActivityAt: number | null, idleMinMs: number): boolean {
  if (latestActivityAt === null || !Number.isFinite(latestActivityAt)) return false
  return now - latestActivityAt >= idleMinMs
}

export type SkipReason =
  | 'outside-active-hours'
  | 'not-idle'
  | 'daily-cap'
  | 'draw-not-selected'

export interface TriggerInput {
  now: number
  occurrence: number
  lane: string
  seedDigest: string
  probabilityPpm: number
  activeHours: DreamingActiveHours | null
  latestActivityAt: number | null
  idleMinMs: number
  dreamsToday: number
  maxDreamsPerDay: number
}

export type TriggerDecision =
  | { fire: true; drawDigest: string; drawValue: number; dayKey: string }
  | { fire: false; reason: SkipReason; dayKey: string }

/**
 * Pure decision combining every gate in fail-closed order: active window,
 * idle window, daily cap, deterministic draw. No side effects.
 */
export function decideTrigger(input: TriggerInput): TriggerDecision {
  const timezone = input.activeHours?.timezone ?? 'UTC'
  const dayKey = localDayKey(input.now, timezone)
  if (!isWithinActiveHours(input.now, input.activeHours)) {
    return { fire: false, reason: 'outside-active-hours', dayKey }
  }
  if (!isIdle(input.now, input.latestActivityAt, input.idleMinMs)) {
    return { fire: false, reason: 'not-idle', dayKey }
  }
  if (input.dreamsToday >= input.maxDreamsPerDay) {
    return { fire: false, reason: 'daily-cap', dayKey }
  }
  const draw = evaluateDraw({
    seedDigest: input.seedDigest, lane: input.lane, occurrence: input.occurrence,
    probabilityPpm: input.probabilityPpm,
  })
  if (!draw.selected) return { fire: false, reason: 'draw-not-selected', dayKey }
  return { fire: true, drawDigest: draw.drawDigest, drawValue: draw.value, dayKey }
}

/** Current slot occurrence derived from the base interval since epoch. */
export function slotOccurrence(now: number, baseIntervalMs: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || baseIntervalMs <= 0) {
    throw new Error('dream trigger: invalid slot input')
  }
  return Math.floor(now / baseIntervalMs)
}

/**
 * Per-subject lottery tickets ("无事找事"): every recallable thing — a task,
 * a goal, a skill, or a previously recorded idea — holds one ticket with a
 * stable ticket value. Each wake slot rolls one bounded random number from the
 * HMAC seed; a subject whose ticket value lands inside the rolling window is
 * recalled for focused thought. This is code-driven (the draw and match run
 * without any model call) — the model is invoked only after a hit.
 *
 * Values live in a widened range rather than [0,1) so a configurable window
 * can be made wider without touching the deterministic draw.
 */

export const TICKET_MODULUS = 1_000_000
/** Default rolling window around the draw value in each direction. */
export const DEFAULT_TICKET_WINDOW = 5_000

export type LotterySubjectKind = 'task-projection' | 'goal' | 'skill' | 'recorded-idea'

export interface LotterySubject {
  kind: LotterySubjectKind
  /** Stable subject key (inbox id, goal id, skill name, or idea id). */
  key: string
}

export interface Ticket {
  subject: LotterySubject
  /** Stable value in [0, TICKET_MODULUS) derived from the ticket seed. */
  value: number
  digest: string
}

/** One subject's stable ticket. The seed is only used as HMAC material. */
export function assignTicket(input: { seedDigest: string; lane: string; subject: LotterySubject }): Ticket {
  const digest = createHmac('sha256', input.seedDigest)
    .update(`assistant-dreaming/ticket/v1\0${input.lane}\0${input.subject.kind}\0${input.subject.key}`)
    .digest('hex')
  const value = Number.parseInt(digest.slice(0, 8), 16) % TICKET_MODULUS
  return { subject: input.subject, value, digest }
}

export interface LotteryDrawInput {
  seedDigest: string
  lane: string
  occurrence: number
}

export interface LotteryDraw {
  drawDigest: string
  /** Rolled value in [0, TICKET_MODULUS). */
  value: number
}

/** The wake's single rolling number, derived deterministically from the seed. */
export function rollLottery(input: LotteryDrawInput): LotteryDraw {
  if (!Number.isSafeInteger(input.occurrence) || input.occurrence < 0) {
    throw new Error('dream trigger: lottery occurrence must be a non-negative safe integer')
  }
  const drawDigest = createHmac('sha256', input.seedDigest)
    .update(`assistant-dreaming/lottery/v1\0${input.lane}\0${input.occurrence}`)
    .digest('hex')
  const value = Number.parseInt(drawDigest.slice(0, 8), 16) % TICKET_MODULUS
  return { drawDigest, value }
}

export interface LotteryMatchInput {
  draw: LotteryDraw
  tickets: readonly Ticket[]
  /** Half-width of the circular window; default keeps roughly 1% of tickets. */
  window?: number
}

export interface LotteryHit {
  subject: LotterySubject
  ticketDigest: string
  ticketValue: number
  distance: number
}

/**
 * Returns the tickets whose value is within `window` of the draw on the
 * circular modulus. Deterministic and side-effect free; an empty result means
 * nothing is recalled this slot, which is the normal "no thought" outcome.
 */
export function matchTickets(input: LotteryMatchInput): readonly LotteryHit[] {
  const window = input.window ?? DEFAULT_TICKET_WINDOW
  if (!Number.isSafeInteger(window) || window < 0) throw new Error('dream trigger: ticket window must be a non-negative integer')
  const hits: LotteryHit[] = []
  for (const ticket of input.tickets) {
    const direct = Math.abs(ticket.value - input.draw.value)
    const circular = TICKET_MODULUS - direct
    const distance = Math.min(direct, circular)
    if (distance <= window) {
      hits.push({ subject: ticket.subject, ticketDigest: ticket.digest, ticketValue: ticket.value, distance })
    }
  }
  return hits.sort((a, b) => a.distance - b.distance || a.subject.key.localeCompare(b.subject.key))
}

export { MINUTES_PER_DAY }
