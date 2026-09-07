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
}
export interface ActionRecord {
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
