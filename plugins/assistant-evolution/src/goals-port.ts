/**
 * Read-only optional-peer seam for assistant-goals strategy advice.
 *
 * This intentionally models only the values evolution consumes. The live
 * service is discovered through Cordis at runtime, so importing its package
 * declarations here would create a clean-build dependency cycle between two
 * independently installable bundles.
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
