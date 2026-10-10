import { createPublicKey, verify } from 'node:crypto'
import { canonicalGrowthJson } from './canonical.js'
import { validatePluginRevisionParentBinding, type PluginRevisionParentBinding,
  type PluginRevisionVerificationCertificate } from './revision-verification.js'

/** Independent owner policy for testing retained parent behavior before any version switch. */
export interface RevisionRegressionAcceptanceAuthorityRef {
  protocol: 'assistant-growth/revision-regression-acceptance-authority/v1'
  authorityId: string
  keyId: string
  authorityDigest: string
  namePrefix: string
  expiresAt: number
}

export interface PluginRevisionRegressionCertificate {
  protocol: 'assistant-growth/revision-regression/v1'
  verificationId: string
  authority: RevisionRegressionAcceptanceAuthorityRef
  plan: PluginRevisionVerificationCertificate['plan']
  parent: PluginRevisionParentBinding
  source: PluginRevisionVerificationCertificate['source']
  /** Digest of the actual retained, independent parent cases; consumers check it against the parent certificate. */
  contractDigest: string
  schemaDigest: string
  environment: PluginRevisionVerificationCertificate['environment']
  model: PluginRevisionVerificationCertificate['model']
  candidateVerificationDigest: string
  sourceDigest: string
  schemaCompatibilityDigest: string
  budget: { maxCases: number; maxDurationMs: number; maxRuns: number }
  observations: readonly {
    caseId: string
    parent: { jobId: string; operationDigest: string; observationDigest: string }
    candidate: { jobId: string; operationDigest: string; observationDigest: string }
  }[]
  verifiedAt: number
  expiresAt: number
  signature: string
}

export interface PluginRevisionRegressionRequest {
  protocol: 'assistant-growth/revision-regression-request/v1'
  planId: string
}

export type PluginRevisionRegressionResult =
  | { status: 'verified'; certificate: PluginRevisionRegressionCertificate }
  | { status: 'rejected' | 'unknown'; reason: string }

const domain = 'assistant-growth/revision-regression/v1\0'
const digest = /^[a-f0-9]{64}$/u
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const keys = ['protocol', 'verificationId', 'authority', 'plan', 'parent', 'source', 'contractDigest',
  'schemaDigest', 'environment', 'model', 'candidateVerificationDigest', 'sourceDigest',
  'schemaCompatibilityDigest', 'budget', 'observations', 'verifiedAt', 'expiresAt'] as const

function fail(label: string): never { throw new Error(`invalid plugin revision regression ${label}`) }
function record(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length
    || !Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
    || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail(label)
  return value as Record<string, unknown>
}
function id(value: unknown, label: string): void {
  if (typeof value !== 'string' || !identifier.test(value) || value.normalize('NFC') !== value) fail(label)
}
function sha(value: unknown, label: string): void {
  if (typeof value !== 'string' || !digest.test(value)) fail(label)
}
function integer(value: unknown, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(label)
}
function text(value: unknown, label: string, maximum = 500): void {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.normalize('NFC').trim() !== value
    || Buffer.byteLength(value) > maximum || /[\p{Cc}]/u.test(value)) fail(label)
}
function rows(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8
    || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length
    || Object.getOwnPropertyNames(value).length !== value.length + 1
    || !Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, entry]) => key === 'length'
      || /^(0|[1-9][0-9]*)$/u.test(key) && entry.enumerable && 'value' in entry)
    || !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)) fail('observation array')
  return value
}

export function validateRevisionRegressionAcceptanceAuthorityRef(value: unknown): asserts value is RevisionRegressionAcceptanceAuthorityRef {
  const ref = record(value, ['protocol', 'authorityId', 'keyId', 'authorityDigest', 'namePrefix', 'expiresAt'], 'authority')
  if (ref.protocol !== 'assistant-growth/revision-regression-acceptance-authority/v1') fail('authority protocol')
  id(ref.authorityId, 'authorityId'); id(ref.keyId, 'keyId'); sha(ref.authorityDigest, 'authorityDigest')
  if (typeof ref.namePrefix !== 'string' || ref.namePrefix.length < 2 || ref.namePrefix.length > 48
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u.test(ref.namePrefix)) fail('namePrefix')
  integer(ref.expiresAt, 'authority expiry', 1, 8_640_000_000_000_000)
}

export function validatePluginRevisionRegressionRequest(value: unknown): asserts value is PluginRevisionRegressionRequest {
  const request = record(value, ['protocol', 'planId'], 'request')
  if (request.protocol !== 'assistant-growth/revision-regression-request/v1') fail('request protocol')
  id(request.planId, 'request planId')
}

export function validatePluginRevisionRegressionCertificate(value: unknown): asserts value is PluginRevisionRegressionCertificate {
  const item = record(value, [...keys, 'signature'], 'certificate')
  if (item.protocol !== 'assistant-growth/revision-regression/v1') fail('protocol')
  id(item.verificationId, 'verificationId')
  validateRevisionRegressionAcceptanceAuthorityRef(item.authority)
  const authority = item.authority
  const plan = record(item.plan, ['id', 'digest', 'name', 'sourceTreeDigest', 'sourcePatchDigest', 'artifactSha256',
    'artifactBytes', 'generatorDigest'], 'plan')
  id(plan.id, 'plan id')
  if (typeof plan.name !== 'string' || plan.name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(plan.name)
    || !plan.name.startsWith(authority.namePrefix)) fail('plan name')
  for (const key of ['digest', 'sourceTreeDigest', 'sourcePatchDigest', 'artifactSha256', 'generatorDigest']) sha(plan[key], key)
  integer(plan.artifactBytes, 'artifact bytes', 1, 512 * 1024)
  validatePluginRevisionParentBinding(item.parent)
  const source = record(item.source, ['referenceDigest', 'ownerDigest', 'growthRunDigest'], 'source')
  for (const key of ['referenceDigest', 'ownerDigest', 'growthRunDigest']) sha(source[key], key)
  for (const key of ['contractDigest', 'schemaDigest', 'candidateVerificationDigest', 'sourceDigest',
    'schemaCompatibilityDigest']) sha(item[key], key)
  const environment = record(item.environment, ['node', 'cordis', 'tools', 'systemPrompt'], 'environment')
  for (const key of ['node', 'cordis', 'tools', 'systemPrompt']) {
    if (typeof environment[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(environment[key] as string)) fail(key)
  }
  const model = record(item.model, ['provider', 'model',
    ...(item.model && typeof item.model === 'object' && Object.hasOwn(item.model, 'reasoningEffort') ? ['reasoningEffort'] : [])], 'model')
  text(model.provider, 'provider'); text(model.model, 'model')
  if (Object.hasOwn(model, 'reasoningEffort')) text(model.reasoningEffort, 'reasoningEffort')
  const budget = record(item.budget, ['maxCases', 'maxDurationMs', 'maxRuns'], 'budget')
  integer(budget.maxCases, 'cases', 2, 8)
  integer(budget.maxDurationMs, 'duration', 1_000, 1_800_000)
  integer(budget.maxRuns, 'runs', 2 + 2 * Number(budget.maxCases), 64)
  const observations = rows(item.observations)
  if (observations.length > Number(budget.maxCases)) fail('observations exceed budget')
  const cases = new Set<string>(), jobs = new Set<string>()
  for (const entry of observations) {
    const observation = record(entry, ['caseId', 'parent', 'candidate'], 'observation')
    id(observation.caseId, 'caseId')
    if (cases.has(String(observation.caseId))) fail('duplicate case')
    cases.add(String(observation.caseId))
    for (const side of ['parent', 'candidate']) {
      const result = record(observation[side], ['jobId', 'operationDigest', 'observationDigest'], `${side} observation`)
      id(result.jobId, `${side} jobId`); sha(result.operationDigest, `${side} operationDigest`)
      sha(result.observationDigest, `${side} observationDigest`)
      if (jobs.has(String(result.jobId))) fail('duplicate observation job')
      jobs.add(String(result.jobId))
    }
  }
  integer(item.verifiedAt, 'verifiedAt', 1, 8_640_000_000_000_000)
  integer(item.expiresAt, 'expiresAt', 1, 8_640_000_000_000_000)
  if (Number(item.expiresAt) <= Number(item.verifiedAt) || Number(item.expiresAt) > authority.expiresAt) fail('certificate expiry')
  if (typeof item.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(item.signature)
    || Buffer.from(item.signature, 'base64url').length !== 64
    || Buffer.from(item.signature, 'base64url').toString('base64url') !== item.signature) fail('signature')
  if (Buffer.byteLength(canonicalGrowthJson(item)) > 65_536) fail('certificate bytes')
}

export function pluginRevisionRegressionSigningPayload(value: Omit<PluginRevisionRegressionCertificate, 'signature'>): string {
  const body = record(value, keys, 'signing body')
  validatePluginRevisionRegressionCertificate({ ...body, signature: 'A'.repeat(86) })
  return domain + canonicalGrowthJson(body)
}

/** Signature and authority equality only; consumers must recheck parent certificate bindings, provenance and source currency. */
export function verifyPluginRevisionRegressionCertificate(value: unknown,
  authority: RevisionRegressionAcceptanceAuthorityRef, publicKey: string, now = Date.now()): value is PluginRevisionRegressionCertificate {
  try {
    validateRevisionRegressionAcceptanceAuthorityRef(authority)
    validatePluginRevisionRegressionCertificate(value)
    if (!Number.isSafeInteger(now) || value.verifiedAt > now || value.expiresAt <= now
      || canonicalGrowthJson(value.authority) !== canonicalGrowthJson(authority)) return false
    const { signature, ...body } = value
    const key = createPublicKey(publicKey)
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(pluginRevisionRegressionSigningPayload(body)), key, Buffer.from(signature, 'base64url'))
  } catch { return false }
}
