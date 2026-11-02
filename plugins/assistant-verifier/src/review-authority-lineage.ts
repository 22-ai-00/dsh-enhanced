import { createHash, createPublicKey } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { canonicalGrowthJson, validateCreationAcceptanceAuthorityRef, validateRevisionAcceptanceAuthorityRef, validateRevisionRegressionAcceptanceAuthorityRef, type CreationAcceptanceAuthorityRef, type RevisionAcceptanceAuthorityRef, type RevisionRegressionAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'

export const lineageHash = (value: unknown): string => createHash('sha256').update(canonicalGrowthJson(value)).digest('hex')
const SHA = /^[a-f0-9]{64}$/u, ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
export function lineageFail(message: string): never { throw new Error(`review lineage: ${message}`) }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).sort().join(',') !== keys.sort().join(',')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !d.enumerable || !('value' in d))) lineageFail('invalid structure')
}
function integer(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) lineageFail('invalid limit')
}
export interface ReviewPublicIdentity {
  authority: CreationAcceptanceAuthorityRef | RevisionAcceptanceAuthorityRef | RevisionRegressionAcceptanceAuthorityRef
  publicKey: string
  keyFingerprint: string
  owner: { authorityId: string; authorityHash: string; principalId: string; principalRecordId: string;
    principalVersion: number; workspace: string; agentPreset: string }
  maximum: number
  runner: { logicalStateRoot: string; maxRuns: number; maxTotalDurationMs: number; maxDurationMs: number; maxOutputBytes: number; expiresAt: number }
  budget: { maxDurationMs: number; maxCases: number; receiptTtlMs: number } | { policy: string; maxInputBytes: number; maxOutputTokens: number; maxDurationMs: number; maxCases: number; receiptTtlMs: number }
}
export interface ConfigurationEvidence { configurationDigest: string; sourceDigest: string; verificationDigest: string }
export interface LineageScope {
  transactionId: string; installationId: string; profileId: string
  lane: 'creation-reviews' | 'revision-reviews' | 'revision-regressions'
  logicalDatabaseScope: string
  oldIdentity: ReviewPublicIdentity; newIdentity: ReviewPublicIdentity
  configurationEvidence: { old: ConfigurationEvidence; current: ConfigurationEvidence }
  previousHeadDigest: string | null
}
export interface RowSeal { planId: string; rowDigest: string; certificateDigest: string }
export interface FileIdentity { dev: number; ino: number }
export interface TrustedHistoryRequest {
  headDigest: string; currentIdentity: ReviewPublicIdentity; currentFileIdentity: FileIdentity
  installationId: string; profileId: string; lane: LineageScope['lane']; logicalDatabaseScope: string
  planId: string; now: number
}
export function validateIdentity(identity: ReviewPublicIdentity): void {
  exact(identity, ['authority', 'publicKey', 'keyFingerprint', 'owner', 'maximum', 'budget', 'runner'])
  if (identity.authority.protocol === 'assistant-growth/creation-acceptance-authority/v1') validateCreationAcceptanceAuthorityRef(identity.authority)
  else if (identity.authority.protocol === 'assistant-growth/revision-acceptance-authority/v1') validateRevisionAcceptanceAuthorityRef(identity.authority)
  else validateRevisionRegressionAcceptanceAuthorityRef(identity.authority)
  if (typeof identity.publicKey !== 'string' || identity.publicKey.length > 8192 || !identity.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')) lineageFail('public key required')
  const key = createPublicKey(identity.publicKey)
  if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'pem', type: 'spki' }).toString() !== identity.publicKey
    || createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex') !== identity.keyFingerprint) lineageFail('public key mismatch')
  exact(identity.owner, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  for (const k of ['authorityId', 'principalId', 'principalRecordId', 'agentPreset'] as const) if (typeof identity.owner[k] !== 'string' || !ID.test(identity.owner[k])) lineageFail('owner id')
  if (typeof identity.owner.authorityHash !== 'string' || !SHA.test(identity.owner.authorityHash) || typeof identity.owner.workspace !== 'string' || !isAbsolute(identity.owner.workspace)
    || resolve(identity.owner.workspace) !== identity.owner.workspace || identity.owner.workspace.includes('\0')) lineageFail('owner binding')
  integer(identity.owner.principalVersion, 1, Number.MAX_SAFE_INTEGER); integer(identity.maximum, 1, 1000)
  const noModel = identity.authority.protocol === 'assistant-growth/revision-regression-acceptance-authority/v1'
  exact(identity.budget, noModel ? ['maxDurationMs', 'maxCases', 'receiptTtlMs'] : ['policy', 'maxInputBytes', 'maxOutputTokens', 'maxDurationMs', 'maxCases', 'receiptTtlMs'])
  const b = identity.budget
  if (!noModel) {
    if (!('policy' in b) || typeof b.policy !== 'string' || !b.policy.trim() || b.policy.includes('\0') || !b.policy.isWellFormed() || Buffer.byteLength(b.policy) > 8192) lineageFail('policy')
    integer(b.maxInputBytes, 4096, 262144); integer(b.maxOutputTokens, 2, 32768)
  }
  integer(b.maxDurationMs, 1000, 1800000); integer(b.maxCases, 2, 8); integer(b.receiptTtlMs, 1000, 86400000)
  exact(identity.runner, ['logicalStateRoot', 'maxRuns', 'maxTotalDurationMs', 'maxDurationMs', 'maxOutputBytes', 'expiresAt'])
  const r = identity.runner
  if (typeof r.logicalStateRoot !== 'string' || !isAbsolute(r.logicalStateRoot) || resolve(r.logicalStateRoot) !== r.logicalStateRoot || r.logicalStateRoot.includes('\0') || r.logicalStateRoot === '/') lineageFail('runner logical root')
  integer(r.maxRuns, 1, 10000); integer(r.maxTotalDurationMs, 1, 86400000); integer(r.maxDurationMs, 1, 300000)
  integer(r.maxOutputBytes, 65536, 262144); integer(r.expiresAt, 1, 8640000000000000)
  if (r.maxDurationMs > r.maxTotalDurationMs || r.expiresAt < identity.authority.expiresAt
    || r.maxRuns < identity.maximum * (noModel ? 2 + 2 * b.maxCases : 1 + b.maxCases)) lineageFail('runner cannot cover review')
}
export function stableIdentity(identity: ReviewPublicIdentity): unknown {
  const { authorityDigest: _, ...authority } = identity.authority
  return { ...identity, authority }
}
export function validateLane(identity: ReviewPublicIdentity, lane: LineageScope['lane']): void {
  const protocol = lane === 'creation-reviews' ? 'assistant-growth/creation-acceptance-authority/v1'
    : lane === 'revision-reviews' ? 'assistant-growth/revision-acceptance-authority/v1' : 'assistant-growth/revision-regression-acceptance-authority/v1'
  if (identity.authority.protocol !== protocol) lineageFail('authority lane mismatch')
}
export function validateScope(scope: LineageScope): void {
  exact(scope, ['transactionId', 'installationId', 'profileId', 'lane', 'logicalDatabaseScope', 'oldIdentity', 'newIdentity', 'configurationEvidence', 'previousHeadDigest'])
  for (const value of [scope.transactionId, scope.installationId, scope.profileId, scope.logicalDatabaseScope]) if (typeof value !== 'string' || !ID.test(value)) lineageFail('scope')
  if (!['creation-reviews', 'revision-reviews', 'revision-regressions'].includes(scope.lane)
    || scope.previousHeadDigest !== null && (typeof scope.previousHeadDigest !== 'string' || !SHA.test(scope.previousHeadDigest))) lineageFail('scope')
  validateIdentity(scope.oldIdentity); validateIdentity(scope.newIdentity)
  validateLane(scope.oldIdentity, scope.lane); validateLane(scope.newIdentity, scope.lane)
  if (canonicalGrowthJson(stableIdentity(scope.oldIdentity)) !== canonicalGrowthJson(stableIdentity(scope.newIdentity))
    || scope.oldIdentity.authority.authorityDigest === scope.newIdentity.authority.authorityDigest) lineageFail('stable identity changed')
  exact(scope.configurationEvidence, ['old', 'current'])
  for (const evidence of [scope.configurationEvidence.old, scope.configurationEvidence.current]) {
    exact(evidence, ['configurationDigest', 'sourceDigest', 'verificationDigest'])
    if (Object.values(evidence).some(v => typeof v !== 'string' || !SHA.test(v))) lineageFail('configuration evidence')
  }
}
export function validateRequest(request: TrustedHistoryRequest): void {
  exact(request, ['headDigest', 'currentIdentity', 'currentFileIdentity', 'installationId', 'profileId', 'lane', 'logicalDatabaseScope', 'planId', 'now'])
  if (typeof request.headDigest !== 'string' || !SHA.test(request.headDigest) || [request.installationId, request.profileId, request.logicalDatabaseScope, request.planId].some(v => typeof v !== 'string' || !ID.test(v))
    || !['creation-reviews', 'revision-reviews', 'revision-regressions'].includes(request.lane)) lineageFail('trusted head required')
  validateIdentity(request.currentIdentity); validateLane(request.currentIdentity, request.lane); exact(request.currentFileIdentity, ['dev', 'ino'])
  integer(request.currentFileIdentity.dev, 0, Number.MAX_SAFE_INTEGER); integer(request.currentFileIdentity.ino, 1, Number.MAX_SAFE_INTEGER)
  integer(request.now, 1, 8640000000000000)
  if (request.currentIdentity.authority.expiresAt <= request.now) lineageFail('current authority expired')
}
export function same(value: unknown, other: unknown): boolean { return canonicalGrowthJson(value) === canonicalGrowthJson(other) }
