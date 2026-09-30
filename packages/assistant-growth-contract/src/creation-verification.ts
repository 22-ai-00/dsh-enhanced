import { createPublicKey, verify } from 'node:crypto'
import { canonicalGrowthJson } from './canonical.js'

/** Owner policy reference frozen before a Growth Agent can write a candidate. */
export interface CreationAcceptanceAuthorityRef {
  protocol: 'assistant-growth/creation-acceptance-authority/v1'
  authorityId: string
  keyId: string
  authorityDigest: string
  namePrefix: string
  expiresAt: number
}

/** Independent checks of a task-derived contract, never a task-success rating. */
export interface PluginCreationVerificationCertificate {
  protocol: 'assistant-growth/creation-verification/v1'
  verificationId: string
  authority: CreationAcceptanceAuthorityRef
  plan: {
    id: string
    digest: string
    name: string
    sourceTreeDigest: string
    sourcePatchDigest: string
    artifactSha256: string
    artifactBytes: number
    generatorDigest: string
  }
  source: { referenceDigest: string; ownerDigest: string; growthRunDigest: string }
  contractDigest: string
  schemaDigest: string
  environment: { node: string; cordis: string; tools: string; systemPrompt: string }
  model: { provider: string; model: string; reasoningEffort?: string }
  budget: { modelCalls: 2; maxOutputTokens: number; maxDurationMs: number; maxCases: number }
  sessions: { contract: string; sourceReview: string }
  observations: readonly { caseId: string; jobId: string; operationDigest: string; observationDigest: string }[]
  reviewDigest: string
  verifiedAt: number
  expiresAt: number
  signature: string
}

/** Host-only request; the producer rereads every source and artifact binding. */
export interface PluginCreationVerificationRequest {
  protocol: 'assistant-growth/creation-verification-request/v1'
  planId: string
}

export type PluginCreationVerificationResult =
  | { status: 'verified'; certificate: PluginCreationVerificationCertificate }
  | { status: 'rejected' | 'unknown'; reason: string }

const digest = /^[a-f0-9]{64}$/u
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
function fail(label: string): never { throw new Error(`invalid plugin creation verification ${label}`) }
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length
    || !Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(label)
  return value as Record<string, unknown>
}
function id(value: unknown, label: string): void {
  if (typeof value !== 'string' || !identifier.test(value) || value.normalize('NFC') !== value) fail(label)
}
function text(value: unknown, label: string, maximum = 500): void {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.normalize('NFC').trim() !== value
    || Buffer.byteLength(value) > maximum || /[\p{Cc}]/u.test(value)) fail(label)
}
function sha(value: unknown, label: string): void { if (typeof value !== 'string' || !digest.test(value)) fail(label) }
function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(label)
}

export function validateCreationAcceptanceAuthorityRef(value: unknown): asserts value is CreationAcceptanceAuthorityRef {
  const ref = record(value, ['protocol', 'authorityId', 'keyId', 'authorityDigest', 'namePrefix', 'expiresAt'], 'authority')
  if (ref.protocol !== 'assistant-growth/creation-acceptance-authority/v1') fail('authority protocol')
  id(ref.authorityId, 'authorityId'); id(ref.keyId, 'keyId'); sha(ref.authorityDigest, 'authorityDigest')
  if (typeof ref.namePrefix !== 'string' || ref.namePrefix.length < 2 || ref.namePrefix.length > 48
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u.test(ref.namePrefix)) fail('namePrefix')
  integer(ref.expiresAt, 'authority expiry', 1, 8_640_000_000_000_000)
}

export function validatePluginCreationVerificationCertificate(value: unknown): asserts value is PluginCreationVerificationCertificate {
  const item = record(value, ['protocol', 'verificationId', 'authority', 'plan', 'source', 'contractDigest', 'schemaDigest',
    'environment', 'model', 'budget', 'sessions', 'observations', 'reviewDigest', 'verifiedAt', 'expiresAt', 'signature'], 'certificate')
  if (item.protocol !== 'assistant-growth/creation-verification/v1') fail('protocol')
  id(item.verificationId, 'verificationId'); validateCreationAcceptanceAuthorityRef(item.authority)
  const plan = record(item.plan, ['id', 'digest', 'name', 'sourceTreeDigest', 'sourcePatchDigest', 'artifactSha256',
    'artifactBytes', 'generatorDigest'], 'plan')
  id(plan.id, 'plan id')
  if (typeof plan.name !== 'string' || plan.name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(plan.name)
    || !plan.name.startsWith(item.authority.namePrefix)) fail('plan name')
  for (const key of ['digest', 'sourceTreeDigest', 'sourcePatchDigest', 'artifactSha256', 'generatorDigest']) sha(plan[key], key)
  integer(plan.artifactBytes, 'artifact bytes', 1, 512 * 1024)
  const source = record(item.source, ['referenceDigest', 'ownerDigest', 'growthRunDigest'], 'source')
  for (const key of ['referenceDigest', 'ownerDigest', 'growthRunDigest']) sha(source[key], key)
  for (const key of ['contractDigest', 'schemaDigest', 'reviewDigest']) sha(item[key], key)
  const env = record(item.environment, ['node', 'cordis', 'tools', 'systemPrompt'], 'environment')
  for (const key of ['node', 'cordis', 'tools', 'systemPrompt']) {
    if (typeof env[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(env[key] as string)) fail(key)
  }
  const selected = record(item.model, ['provider', 'model',
    ...(item.model && typeof item.model === 'object' && Object.hasOwn(item.model, 'reasoningEffort') ? ['reasoningEffort'] : [])], 'model')
  text(selected.provider, 'provider'); text(selected.model, 'model')
  if (Object.hasOwn(selected, 'reasoningEffort')) text(selected.reasoningEffort, 'reasoningEffort')
  const budget = record(item.budget, ['modelCalls', 'maxOutputTokens', 'maxDurationMs', 'maxCases'], 'budget')
  if (budget.modelCalls !== 2) fail('model calls')
  integer(budget.maxOutputTokens, 'output tokens', 1, 32_768)
  integer(budget.maxDurationMs, 'duration', 1_000, 1_800_000)
  integer(budget.maxCases, 'cases', 2, 8)
  const sessions = record(item.sessions, ['contract', 'sourceReview'], 'sessions')
  id(sessions.contract, 'contract session'); id(sessions.sourceReview, 'review session')
  if (sessions.contract === sessions.sourceReview) fail('fresh review sessions')
  if (!Array.isArray(item.observations) || item.observations.length < 2 || item.observations.length > Number(budget.maxCases)) fail('observations')
  if (Object.getPrototypeOf(item.observations) !== Array.prototype || Object.getOwnPropertySymbols(item.observations).length
    || Object.getOwnPropertyNames(item.observations).length !== item.observations.length + 1
    || !Object.entries(Object.getOwnPropertyDescriptors(item.observations)).every(([key, value]) => key === 'length'
      || /^(0|[1-9][0-9]*)$/u.test(key) && value.enumerable && 'value' in value)
    || !Array.from({ length: item.observations.length }, (_, index) => Object.hasOwn(item.observations!, index)).every(Boolean)) fail('observation array')
  const seen = new Set<string>(), jobs = new Set<string>()
  for (const entry of item.observations) {
    const row = record(entry, ['caseId', 'jobId', 'operationDigest', 'observationDigest'], 'observation')
    id(row.caseId, 'caseId'); id(row.jobId, 'jobId'); sha(row.operationDigest, 'operationDigest'); sha(row.observationDigest, 'observationDigest')
    if (seen.has(String(row.caseId)) || jobs.has(String(row.jobId))) fail('duplicate case or observation job')
    seen.add(String(row.caseId)); jobs.add(String(row.jobId))
  }
  integer(item.verifiedAt, 'verifiedAt', 1, 8_640_000_000_000_000)
  integer(item.expiresAt, 'expiresAt', 1, 8_640_000_000_000_000)
  if (Number(item.expiresAt) <= Number(item.verifiedAt) || Number(item.expiresAt) > item.authority.expiresAt) fail('certificate expiry')
  if (typeof item.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(item.signature)
    || Buffer.from(item.signature, 'base64url').length !== 64
    || Buffer.from(item.signature, 'base64url').toString('base64url') !== item.signature) fail('signature')
  if (Buffer.byteLength(canonicalGrowthJson(item)) > 65_536) fail('certificate bytes')
}

export function pluginCreationVerificationSigningPayload(value: Omit<PluginCreationVerificationCertificate, 'signature'>): string {
  return canonicalGrowthJson(value)
}

/** Signature and authority equality only; consumers must also recheck provenance. */
export function verifyPluginCreationVerificationCertificate(value: unknown,
  authority: CreationAcceptanceAuthorityRef, publicKey: string, now = Date.now()): value is PluginCreationVerificationCertificate {
  try {
    validateCreationAcceptanceAuthorityRef(authority); validatePluginCreationVerificationCertificate(value)
    if (!Number.isSafeInteger(now) || value.verifiedAt > now || value.expiresAt <= now
      || canonicalGrowthJson(value.authority) !== canonicalGrowthJson(authority)) return false
    const { signature, ...body } = value
    const key = createPublicKey(publicKey)
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(pluginCreationVerificationSigningPayload(body)), key, Buffer.from(signature, 'base64url'))
  } catch { return false }
}
