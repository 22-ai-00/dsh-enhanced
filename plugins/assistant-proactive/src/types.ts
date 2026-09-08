export interface OpportunityScope {
  principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string
}
/** Operator estimates in utility units; neither probabilities nor money are independently verified. */
export interface OpportunityProfile {
  id: string
  mode: 'prepare' | 'remind' | 'execute'
  expectedBenefit: number; successPpm: number; executionCost: number; interruptionCost: number; possibleLoss: number; minimumUtility: number
  mergeWindowMs: number; cooldownMs: number; rejectionCooldownMs: number
  quietHours?: { timezone: string; startMinute: number; endMinute: number }
  maxDecisionsPerGoal: number; maxExecutionsPerGoal: number; maxRemindersPerGoal: number
}
/** Supplied by the live Goals service from an already owner-authorized wait; never by an event body. */
export interface OpportunityInput {
  waitId: string; profileId: string; scope: OpportunityScope; goalId: string; sessionId: string
  definitionDigest: string; objective: string; nativeGoalId: string; nativeRevision: number; ownerRouteId: string
  sourceDigest: string; sourceId: string
  event: { id: string; sequence: number; digest: string; occurredAt: number }
  expiresAt: number
}
export type OpportunityReason = 'cancelled' | 'coalescing' | 'quiet-hours' | 'cooldown' | 'rejected-cooldown' | 'below-threshold' | 'budget' | 'expired' | 'prepared' | 'reminder' | 'execution'
export interface OpportunityDecision {
  id: string; waitId: string; profileId: string; scope: OpportunityScope; goalId: string; sessionId: string; ownerRouteId: string
  sourceId: string; eventId: string; eventSequence: number; eventDigest: string; sourceDigest: string
  objective: string; definitionDigest: string; nativeGoalId: string; nativeRevision: number
  mode: 'prepare' | 'remind' | 'execute' | 'suppress'
  state: 'pending' | 'decided' | 'closed'; reason: OpportunityReason; utility: number
  firstObservedAt: number; updatedAt: number; eligibleAt: number; expiresAt: number; observations: number
  feedback?: 'accepted' | 'rejected'
}
export interface OpportunityEvaluation {
  /** consume advances this wait's source cursor; execute still goes through the original GoalWake authority. */
  disposition: 'defer' | 'consume' | 'execute'
  decision: Readonly<OpportunityDecision>
}
