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
  rollback?: { allowRollback: true; budgetId: string; maxActions: number; maxTotalBytes: number }
  repoWorkflow?: { baseBranch: string; allowBranchCreate: boolean; allowPullRequest: boolean }
  verifiedDelivery?: { ownerRouteId: string; budgetId: string; acceptance?: 'goal-outcome' | 'goal-step' }
}

/**
 * Read-only Host projection of a grant whose authority and durable state live
 * in the external broker.  It deliberately contains no credential locator or
 * local rollback/delivery authority.  `grantDigest` is issued with the broker
 * grant and is rechecked by the broker on every request.
 */
export type ExternalActionGrantMirror = import('./broker-protocol.js').BrokerGrantProjection
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
export interface InspectRequest { grantId: string; kind: 'repository' | 'branch' | 'file' | 'pull-request' | 'checks' | 'reviews' | 'commit-checks'; path?: string; pullRequestNumber?: number; commitOid?: string }
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
  /** Present for schema-v3 commit rows; legacy commits cannot be compensated. */
  paths?: readonly string[]
  result?: ActionResult
}
export interface ActionAuthority { ownerId: string; fence: number }

/** Owner request binding an exact succeeded forward commit. Preimages are Host-captured. */
export interface CompensationRequest {
  grantId: string
  idempotencyKey: string
  forwardActionId: string
  forwardActionVersion: number
  forwardRequestDigest: string
  forwardCommitOid: string
}
export type CompensationPreimageFile =
  | Readonly<{ path: string; state: 'present'; blobOid: string; content: string; size: number }>
  | Readonly<{ path: string; state: 'absent' }>
export interface CompensationPreimage { repository: string; branch: string; commitOid: string; files: readonly CompensationPreimageFile[] }
export interface CompensationResult {
  actionId: string
  status: 'succeeded' | 'failed' | 'unknown'
  repository: string
  branch: string
  parentOid: string
  actionMarker: string
  resultOid?: string
  reason?: string
}

export interface CompensationRecord {
  id: string
  forwardActionId: string
  forwardActionVersion: number
  forwardGrantRevision: number
  identity: ActionIdentity
  sessionId: string
  grantId: string
  grantRevision: number
  repository: string
  branch: string
  paths: readonly string[]
  parentOid: string
  forwardRequestDigest: string
  forwardCommitOid: string
  requestDigest: string
  bytes: number
  expiresAt: number
  status: 'capturing' | 'prepared' | 'dispatched' | CompensationResult['status']
  version: number
  preimageDigest?: string
  preimage?: CompensationPreimage
  result?: CompensationResult
}
