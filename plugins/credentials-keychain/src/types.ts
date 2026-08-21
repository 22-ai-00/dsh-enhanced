export interface CredentialHandleBase {
  id: string
  consumers: readonly string[]
  purposes: readonly string[]
  maxLeaseMs: number
}

export interface EnvironmentCredentialHandle extends CredentialHandleBase {
  provider: 'environment'
  environmentName: string
}

export interface KeychainCredentialHandle extends CredentialHandleBase {
  provider: 'linux-secret-service' | 'macos-keychain'
  service: string
  account: string
}

export interface WindowsDpapiCredentialHandle extends CredentialHandleBase {
  provider: 'windows-dpapi'
  /** Absolute path to a per-user DPAPI-encrypted PSCredential export. */
  path: string
}

export type CredentialHandle = EnvironmentCredentialHandle | KeychainCredentialHandle | WindowsDpapiCredentialHandle

export interface CredentialCommandInput {
  executable: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  timeoutMs: number
  maxOutputBytes: number
}

export interface CredentialCommandResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export type CredentialCommandRunner = (input: CredentialCommandInput) => Promise<CredentialCommandResult>

export type CredentialProviderErrorCode = 'invalid-value' | 'not-found' | 'oversize' | 'provider-failed' | 'timeout'

export interface CredentialLeaseRequest {
  handleId: string
  purpose: string
  ttlMs?: number
  idempotencyKey: string
}

export type CredentialLeaseStatus = 'active' | 'completed' | 'expired' | 'failed' | 'revoked'

export interface CredentialLeaseRecord {
  id: string
  handleId: string
  consumer: string
  purpose: string
  idempotencyKey: string
  status: CredentialLeaseStatus
  issuedAt: number
  expiresAt: number
  settledAt?: number
  failureCode?: string
  version: number
}

export type CredentialLeaseMetadata = Omit<CredentialLeaseRecord, 'idempotencyKey'>
