import type { OpportunityScope } from './types.js'

export type ProactiveGoalLifecycleReason = 'completed' | 'cancelled' | 'expired' | 'retired'

export interface ProactiveGoalSourceLink {
  readonly scope: OpportunityScope
  readonly goalId: string
  readonly waitId?: string
  readonly sourceId: string
  readonly sourceDigest?: string
  readonly definitionDigest?: string
  readonly nativeGoalId?: string
  readonly nativeRevision?: number
}

export interface ProactiveGoalUnsubscribeEvent extends ProactiveGoalSourceLink {
  readonly reason: ProactiveGoalLifecycleReason
  readonly decidedAt: number
}

export type ProactiveGoalUnsubscribeHook = (event: Readonly<ProactiveGoalUnsubscribeEvent>) => void

export interface ProactiveGoalRetireInput {
  readonly scope: OpportunityScope
  readonly goalId: string
  readonly reason: ProactiveGoalLifecycleReason
  readonly waitId?: string
  readonly sourceId?: string
}

export interface ProactiveGoalUnsubscribeResult {
  readonly scope: OpportunityScope
  readonly goalId: string
  readonly sourceId: string
  readonly reason: ProactiveGoalLifecycleReason
  readonly detachedTriggers: readonly string[]
  readonly hooksNotified: number
}

/** Structural mirror of EventTriggers' unsubscribe cleanup port (optional peer). */
export interface EventTriggersUnsubscribePort {
  unsubscribeGoalSources?(input: {
    scope: OpportunityScope
    goalId: string
    reason: ProactiveGoalLifecycleReason
    sourceId?: string
    sourceDigest?: string
    definitionDigest?: string
  }): readonly string[]
}

/** Structural mirror of assistant-goals' read-only lifecycle check (optional peer). */
export interface GoalLifecycleInspectPort {
  inspectGoalLifecycle?(input: { scope: OpportunityScope; goalId: string }): Readonly<{
    scope: OpportunityScope
    id: string
    native: { sessionId: string; goalId: string; revision: number; phase: string }
  }> | undefined
}

export interface TerminalGoalChangeSignal {
  readonly reason: 'completed' | 'cancelled'
  readonly nativeGoalId?: string
  readonly sessionId?: string
  readonly workspace?: string
  readonly preset?: string
}

/** Parses a DSH `goal/changed` payload only for terminal completion or clear operations. */
export function parseTerminalGoalChanged(payload: unknown): TerminalGoalChangeSignal | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as {
    agent?: { session?: { id?: unknown; header?: { cwd?: unknown; agentPreset?: unknown } } }
    change?: { operation?: unknown; ref?: { id?: unknown }; goal?: { id?: unknown; phase?: unknown } }
  }
  const operation = record.change?.operation
  const phase = record.change?.goal?.phase
  let reason: 'completed' | 'cancelled' | undefined
  if (operation === 'complete' || phase === 'complete') reason = 'completed'
  else if (operation === 'clear' || phase === 'cleared') reason = 'cancelled'
  if (reason === undefined) return undefined
  const rawGoalId = record.change?.ref?.id ?? record.change?.goal?.id
  const rawSessionId = record.agent?.session?.id
  const rawWorkspace = record.agent?.session?.header?.cwd
  const rawPreset = record.agent?.session?.header?.agentPreset
  return Object.freeze({
    reason,
    ...(typeof rawGoalId === 'string' && rawGoalId.length > 0 ? { nativeGoalId: rawGoalId } : {}),
    ...(typeof rawSessionId === 'string' && rawSessionId.length > 0 ? { sessionId: rawSessionId } : {}),
    ...(typeof rawWorkspace === 'string' && rawWorkspace.length > 0 ? { workspace: rawWorkspace } : {}),
    ...(typeof rawPreset === 'string' && rawPreset.length > 0 ? { preset: rawPreset } : {}),
  })
}
