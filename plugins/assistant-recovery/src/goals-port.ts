/**
 * Minimal read-only seam for the required assistant-goals service. Recovery
 * resolves that optional peer through Cordis; importing its declarations here
 * would make an independently installable bundle require Goals build output.
 */
export interface GoalsAdviceScope {
  principalId: string
  principalRecordId: string
  principalVersion: number
  workspace: string
  preset: string
}

export interface GoalsAdviceDefinitionSummary {
  situation: string
  goalInstances: number
  adviceRuns: number
  distinctRequests: number
}

export interface AssistantGoalsAdvicePort {
  hostSummarizeAdviceByDefinition(scope: GoalsAdviceScope): readonly GoalsAdviceDefinitionSummary[]
}
