export interface ActionIdentity {
  principalDigest: string
  principalRecordId: string
  principalVersion: number
  workspace: string
  agentPreset: string
}
export interface ActionGrant extends ActionIdentity {
  id: string
  revision: number
  repository: string
  branch: string
  paths: string[]
  credentialHandle: string
  expiresAt: number
  maxActions: number
  maxTotalBytes: number
  repoWorkflow?: { baseBranch: string; allowBranchCreate: boolean; allowPullRequest: boolean }
  verifiedDelivery?: { ownerRouteId: string; budgetId: string; acceptance?: 'goal-outcome' | 'goal-step' }
}
export interface VerifiedDeliveryRequest {
  grantId: string
  idempotencyKey: string
  expectedHeadOid: string
  headline: string
  paths: string[]
  pullRequest?: { title: string; body: string }
}
export interface CommitRequest {
  grantId: string
  idempotencyKey: string
  expectedHeadOid: string
  headline: string
  files: Array<{ path: string; content: string }>
}
export interface ActionResult {
  actionId: string
  status: 'succeeded' | 'failed' | 'unknown'
  commitOid?: string
  reason?: string
  branch?: string
  pullRequestNumber?: number
}
export interface BranchRequest { grantId: string; idempotencyKey: string; baseHeadOid: string }
export interface PullRequestRequest { grantId: string; idempotencyKey: string; expectedHeadOid: string; title: string; body: string }
export interface InspectRequest { grantId: string; kind: 'repository' | 'branch' | 'file' | 'pull-request' | 'checks' | 'reviews'; path?: string; pullRequestNumber?: number }
export interface InspectOperation extends InspectRequest { operation: 'inspect'; idempotencyKey: string }
export type WorkflowRequest = CommitRequest | BranchRequest | PullRequestRequest | InspectOperation
export type ActionKind = 'commit' | 'branch' | 'pull-request' | 'inspect'
export interface ActionRecord {
  kind: ActionKind
  id: string
  identity: ActionIdentity
  sessionId: string
  grantId: string
  grantRevision: number
  requestDigest: string
  bytes: number
  expiresAt: number
  status: 'prepared' | 'dispatched' | ActionResult['status']
  version: number
  result?: ActionResult
}
export interface ActionAuthority { ownerId: string; fence: number }
