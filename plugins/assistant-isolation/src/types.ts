/** Owner identity is attested by the Host, never supplied in a model tool call. */
export interface IsolationIdentity {
  principalDigest: string
  principalRecordId: string
  principalVersion: number
  workspace: string
  agentPreset: string
}

/** A finite, operator-configured grant for offline code execution. */
export interface IsolationGrant extends IsolationIdentity {
  id: string
  revision: number
  expiresAt: number
  maxRuns: number
  maxTotalDurationMs: number
}

export interface IsolationFile { path: string; content: string }
export interface IsolationRequest {
  grantId: string
  idempotencyKey: string
  command: string
  files?: IsolationFile[]
  artifacts?: string[]
  timeoutMs?: number
}

export interface IsolationLimits {
  maxDurationMs: number
  maxInputBytes: number
  maxOutputBytes: number
  maxArtifactBytes: number
  maxFiles: number
  memoryMiB: number
  pidsLimit: number
  cpus: number
}

export type IsolationStatus = 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'unknown'
export interface IsolationResult {
  jobId: string
  status: Exclude<IsolationStatus, 'prepared' | 'running'>
  quiescent: boolean
  exitCode?: number
  stdout: string
  stderr: string
  artifacts: IsolationFile[]
  reason?: string
}

export interface IsolationJob {
  id: string
  grantId: string
  grantRevision: number
  identity: IsolationIdentity
  sessionId: string
  idempotencyKey: string
  requestDigest: string
  containerName: string
  deadline: number
  reservedDurationMs: number
  status: IsolationStatus
  version: number
  createdAt: number
  updatedAt: number
  result?: IsolationResult
}

export interface IsolationRunInput {
  jobId: string
  containerName: string
  image: string
  dockerPath: string
  workspacePath: string
  command: string
  deadline: number
  limits: IsolationLimits
  signal: AbortSignal
  /** Last Host authorization/CAS, after create and immediately before start. */
  authorizeStart(): boolean | Promise<boolean>
}

export interface IsolationProcessResult {
  status: IsolationResult['status']
  quiescent: boolean
  exitCode?: number
  stdout: string
  stderr: string
  reason?: string
}
