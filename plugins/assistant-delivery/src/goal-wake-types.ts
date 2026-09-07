import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DeliveryPreferencePrincipalAttestation } from './types.js'

/**
 * Content-free, exact identity fence for one durable Goal wake.
 *
 * Delivery does not accept a message or a human-turn proof here. The host
 * validates this attestation before entering the runtime; the runtime still
 * validates its temporal and structural boundaries before it resumes an Agent.
 */
export interface DeliveryGoalWakeInput {
  readonly attestation: Readonly<DeliveryPreferencePrincipalAttestation>
  readonly native: Readonly<{ goalId: string; revision: number }>
  readonly deadlineAt: number
  readonly signal: AbortSignal
  /** Re-read the host-owned goal/owner fence at each execution boundary. */
  assertCurrent(agent: Agent, phase: 'before-resume' | 'running' | 'terminal'): void
  /** Persist the caller's exact wake-dispatch CAS immediately before native resume. */
  beforeResume(agent: Agent): void
  /** Finish this Agent's admitted step/goal verification before disposal. */
  settle(agent: Agent, signal: AbortSignal): Promise<void>
}

/** Wake execution reached a bounded terminal state; it says nothing about business completion. */
export interface DeliveryGoalWakeResult {
  readonly outcome: 'succeeded' | 'busy' | 'unknown' | 'denied'
  readonly dispatched: boolean
  readonly quiescent: boolean
}

/** Validate the allowed absolute deadline window. */
export function isDeliveryGoalWakeDeadline(deadlineAt: number, now: number): boolean {
  return Number.isSafeInteger(deadlineAt) && Number.isSafeInteger(now)
    && deadlineAt > now && deadlineAt - now <= 300_000
}
