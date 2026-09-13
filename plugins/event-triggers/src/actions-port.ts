/**
 * Deliberately structural: importing assistant-actions here would form the
 * Actions -> Goals -> Events -> Actions type cycle.
 */
export interface RepositoryEventObservationPort {
  readRepositoryEventObservation(input: Readonly<{
    version: 1
    triggerId: string
    grantId: string
    grantRevision: number
    grantDigest: string
    repository: string
    branch: string
    baseBranch: string
    owner: Readonly<{ workspace: string; preset: string; principalId: string; principalRecordId: string; principalVersion: number; ownerRouteId: string; expiresAt: number; budgetId: string }>
    goal?: Readonly<{ id: string; sessionId: string; nativeGoalId: string; definitionVersion: number; definitionDigest: string }>
  }>, signal: AbortSignal): Promise<Readonly<{ protocol: 'assistant-actions/repository-event/v1'; fingerprint: string; truthy: true }>>
}
