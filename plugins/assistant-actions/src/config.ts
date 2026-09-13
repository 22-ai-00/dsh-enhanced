import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { normalizeBrokerGrantProjection } from './broker-protocol.js'
import type { ActionGrant, CommitRequest, CompensationRequest, ExternalActionGrantMirror, VerifiedDeliveryRequest } from './types.js'

export interface EmbeddedBrokerConfig { mode: 'embedded-compat' }
export interface ExternalUnixBrokerConfig {
  mode: 'external-unix-v1'
  actionSocketPath: string
  brokerId: string
  brokerPublicKeyPath: string
  clientKeyId: string
  clientSigningKeyPath: string
  clientInstanceId: string
  clientGeneration: number
  requestTimeoutMs?: number
  helloTtlMs?: number
  expectedSocketUid: number
  expectedSocketGid: number
  expectedSocketMode?: number
  expectedSocketParentUid?: number
  expectedSocketParentGid?: number
  expectedSocketParentMode?: number
  expectedBrokerPeerUid: number
  expectedBrokerPeerGid: number
  minimumBrokerGeneration?: number
}
export type BrokerConfig = EmbeddedBrokerConfig | ExternalUnixBrokerConfig
export interface Config { stateRoot?: string; grants?: ActionGrant[]; externalGrants?: readonly ExternalActionGrantMirror[]; broker?: BrokerConfig }
type ValidatedExternalUnixBrokerConfig = Required<ExternalUnixBrokerConfig>
export type ValidatedConfig =
  | { stateRoot: string; grants: ActionGrant[]; externalGrants: []; broker: EmbeddedBrokerConfig }
  | { stateRoot: string; grants: []; externalGrants: ExternalActionGrantMirror[]; broker: ValidatedExternalUnixBrokerConfig }
const positive = (max: number) => Schema.number().step(1).min(1).max(max)
const externalGrantSchema = Schema.object({
  id: Schema.string().required(), revision: positive(Number.MAX_SAFE_INTEGER).required(), grantDigest: Schema.string().required(),
  owner: Schema.object({ principalDigest: Schema.string().required(), principalRecordId: Schema.string().required(), principalVersion: positive(Number.MAX_SAFE_INTEGER).required(),
    workspace: Schema.string().required(), preset: Schema.string().required(), bindingId: Schema.string().required(), bindingVersion: positive(Number.MAX_SAFE_INTEGER).required(), bindingGeneration: positive(Number.MAX_SAFE_INTEGER).required() }).required(),
  sessionId: Schema.string().required(),
  destination: Schema.object({ classification: Schema.const('github-repository').required(), repository: Schema.string().required(), branch: Schema.string().required(), baseBranch: Schema.string(), paths: Schema.array(Schema.string()).required() }).required(),
  expiresAt: positive(Number.MAX_SAFE_INTEGER).required(), maxActions: positive(10_000).required(), maxTotalBytes: positive(64 * 1024 * 1024).required(),
  source: Schema.object({ classification: Schema.union(['public', 'internal', 'confidential', 'restricted'] as const).required(), provenanceDigest: Schema.string().required() }).required(),
  maxCostUnits: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).required(),
  allowedOperations: Schema.array(Schema.union(['commit', 'inspect', 'pull-request'] as const)).required(),
  allowedInspectKinds: Schema.array(Schema.union(['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews', 'commit-checks'] as const)).required(),
  verifiedDelivery: Schema.object({ ownerRouteId: Schema.string().required(), budgetId: Schema.string().required(), acceptance: Schema.union(['goal-outcome', 'goal-step'] as const) }),
}) as Schema<ExternalActionGrantMirror>
export const Config: Schema<Config> = Schema.object({
  stateRoot: Schema.string().default(join(homedir(), '.dsh', 'assistant-actions')),
  grants: Schema.array(Schema.object({
    id: Schema.string().required(), revision: positive(Number.MAX_SAFE_INTEGER).required(),
    principalDigest: Schema.string().required(), principalRecordId: Schema.string().required(), principalVersion: positive(Number.MAX_SAFE_INTEGER).required(),
    workspace: Schema.string().required(), agentPreset: Schema.string().required(), repository: Schema.string().required(), branch: Schema.string().required(),
    paths: Schema.array(Schema.string()).required(), credentialHandle: Schema.string().required(), expiresAt: positive(Number.MAX_SAFE_INTEGER).required(),
    maxActions: positive(10_000).required(), maxTotalBytes: positive(64 * 1024 * 1024).required(),
    repoWorkflow: Schema.union([Schema.object({ baseBranch: Schema.string().required(), allowBranchCreate: Schema.boolean().required(), allowPullRequest: Schema.boolean().required() })]),
    verifiedDelivery: Schema.union([Schema.object({ ownerRouteId: Schema.string().required(), budgetId: Schema.string().required(), acceptance: Schema.union(['goal-outcome', 'goal-step']) })]),
    rollback: Schema.union([Schema.object({ allowRollback: Schema.const(true).required(), budgetId: Schema.string().required(),
      maxActions: positive(10_000).required(), maxTotalBytes: positive(64 * 1024 * 1024).required() })]),
  })).default([]),
  externalGrants: Schema.array(externalGrantSchema).default([]) as Schema<readonly ExternalActionGrantMirror[]>,
  broker: Schema.union([
    Schema.object({ mode: Schema.const('embedded-compat').required() }),
    Schema.object({
      mode: Schema.const('external-unix-v1').required(), actionSocketPath: Schema.string().required(), brokerId: Schema.string().required(),
      brokerPublicKeyPath: Schema.string().required(), clientKeyId: Schema.string().required(), clientSigningKeyPath: Schema.string().required(),
      clientInstanceId: Schema.string().required(), clientGeneration: positive(Number.MAX_SAFE_INTEGER).required(),
      requestTimeoutMs: positive(300_000).default(30_000), helloTtlMs: positive(300_000).default(30_000),
      expectedSocketUid: Schema.number().step(1).min(0).max(0x7fffffff).required(), expectedSocketGid: Schema.number().step(1).min(0).max(0x7fffffff).required(),
      expectedSocketMode: Schema.number().step(1).min(0).max(0o777).default(0o600),
      expectedSocketParentUid: Schema.number().step(1).min(0).max(0x7fffffff), expectedSocketParentGid: Schema.number().step(1).min(0).max(0x7fffffff),
      expectedSocketParentMode: Schema.number().step(1).min(0).max(0o777).default(0o700),
      expectedBrokerPeerUid: Schema.number().step(1).min(0).max(0x7fffffff).required(), expectedBrokerPeerGid: Schema.number().step(1).min(0).max(0x7fffffff).required(),
      minimumBrokerGeneration: positive(Number.MAX_SAFE_INTEGER).default(1),
    }),
  ]).default({ mode: 'embedded-compat' }),
})
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value)
export function validPath(value: unknown): value is string {
  return text(value, 1024) && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}
const identifier = (value: unknown): value is string => text(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
const canonicalAbsolute = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && value !== '/' && !value.includes('\0')
function validateExternalGrant(grant: ExternalActionGrantMirror): void {
  try {
    normalizeBrokerGrantProjection(grant)
  } catch { throw new Error('assistant-actions: invalid external grant projection') }
}
export function validateConfig(input: Config): ValidatedConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['stateRoot', 'grants', 'externalGrants', 'broker'].includes(key))) throw new Error('assistant-actions: invalid config')
  const stateRoot = input.stateRoot ?? join(homedir(), '.dsh', 'assistant-actions')
  if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || stateRoot === '/') throw new Error('assistant-actions: canonical private state root required')
  const grants = structuredClone(input.grants ?? [])
  if (!Array.isArray(grants) || grants.length > 1000 || new Set(grants.map(grant => grant.id)).size !== grants.length) throw new Error('assistant-actions: invalid grants')
  for (const grant of grants) {
    if (!grant || ![14, 15, 16, 17].includes(Object.keys(grant).length)
      || Object.keys(grant).some(key => !['id', 'revision', 'principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset', 'repository', 'branch', 'paths', 'credentialHandle', 'expiresAt', 'maxActions', 'maxTotalBytes', 'repoWorkflow', 'verifiedDelivery', 'rollback'].includes(key))
      || grant.verifiedDelivery !== undefined && (!grant.verifiedDelivery || ![2, 3].includes(Object.keys(grant.verifiedDelivery).length) || Object.keys(grant.verifiedDelivery).some(key => !['ownerRouteId', 'budgetId', 'acceptance'].includes(key)) || grant.verifiedDelivery.acceptance !== undefined && !['goal-outcome', 'goal-step'].includes(grant.verifiedDelivery.acceptance) || !text(grant.verifiedDelivery.ownerRouteId, 200) || !text(grant.verifiedDelivery.budgetId, 200))
      || grant.rollback !== undefined && (!grant.rollback || Object.keys(grant.rollback).length !== 4
        || Object.keys(grant.rollback).some(key => !['allowRollback', 'budgetId', 'maxActions', 'maxTotalBytes'].includes(key))
        || grant.rollback.allowRollback !== true || !text(grant.rollback.budgetId, 200)
        || !Number.isSafeInteger(grant.rollback.maxActions) || grant.rollback.maxActions < 1 || grant.rollback.maxActions > 10_000
        || !Number.isSafeInteger(grant.rollback.maxTotalBytes) || grant.rollback.maxTotalBytes < 1 || grant.rollback.maxTotalBytes > 64 * 1024 * 1024)
      || !text(grant.id) || !Number.isSafeInteger(grant.revision) || grant.revision < 1
      || !/^[0-9a-f]{64}$/.test(grant.principalDigest) || !text(grant.principalRecordId) || !Number.isSafeInteger(grant.principalVersion) || grant.principalVersion < 1
      || !isAbsolute(grant.workspace) || resolve(grant.workspace) !== grant.workspace || !text(grant.agentPreset)
      || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(grant.repository) || grant.repository.length > 256
      || !text(grant.branch) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(grant.branch) || grant.branch.includes('..') || grant.branch.startsWith('refs/')
      || grant.branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
      || !Array.isArray(grant.paths) || grant.paths.length < 1 || grant.paths.length > 128 || !grant.paths.every(validPath) || new Set(grant.paths).size !== grant.paths.length
      || !text(grant.credentialHandle) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < 1
      || !Number.isSafeInteger(grant.maxActions) || grant.maxActions < 1 || grant.maxActions > 10_000
      || !Number.isSafeInteger(grant.maxTotalBytes) || grant.maxTotalBytes < 1 || grant.maxTotalBytes > 64 * 1024 * 1024
      || (grant.repoWorkflow !== undefined && (!grant.repoWorkflow || Object.keys(grant.repoWorkflow).length !== 3 || !text(grant.repoWorkflow.baseBranch)
        || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(grant.repoWorkflow.baseBranch) || grant.repoWorkflow.baseBranch.includes('..') || grant.repoWorkflow.baseBranch.startsWith('refs/')
        || grant.repoWorkflow.baseBranch === grant.branch || grant.repoWorkflow.baseBranch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
        || typeof grant.repoWorkflow.allowBranchCreate !== 'boolean' || typeof grant.repoWorkflow.allowPullRequest !== 'boolean'))) throw new Error('assistant-actions: invalid grant')
  }
  const rawBroker: BrokerConfig = input.broker === undefined ? { mode: 'embedded-compat' } : structuredClone(input.broker)
  const externalGrants = structuredClone(input.externalGrants ?? [])
  if (!rawBroker || typeof rawBroker !== 'object' || Array.isArray(rawBroker) || !('mode' in rawBroker)) throw new Error('assistant-actions: invalid broker config')
  if (rawBroker.mode === 'embedded-compat') {
    if (Object.keys(rawBroker).length !== 1 || externalGrants.length !== 0) throw new Error('assistant-actions: external grants require external broker mode')
    return { stateRoot, grants, externalGrants: [], broker: rawBroker }
  }
  if (rawBroker.mode !== 'external-unix-v1'
    || Object.keys(rawBroker).some(key => !['mode', 'actionSocketPath', 'brokerId', 'brokerPublicKeyPath', 'clientKeyId', 'clientSigningKeyPath', 'clientInstanceId', 'clientGeneration', 'requestTimeoutMs', 'helloTtlMs', 'expectedSocketUid', 'expectedSocketGid', 'expectedSocketMode', 'expectedSocketParentUid', 'expectedSocketParentGid', 'expectedSocketParentMode', 'expectedBrokerPeerUid', 'expectedBrokerPeerGid', 'minimumBrokerGeneration'].includes(key))) throw new Error('assistant-actions: invalid external broker config')
  const broker: ValidatedExternalUnixBrokerConfig = { ...rawBroker, requestTimeoutMs: rawBroker.requestTimeoutMs ?? 30_000, helloTtlMs: rawBroker.helloTtlMs ?? 30_000, expectedSocketMode: rawBroker.expectedSocketMode ?? 0o600,
    expectedSocketParentUid: rawBroker.expectedSocketParentUid ?? rawBroker.expectedSocketUid, expectedSocketParentGid: rawBroker.expectedSocketParentGid ?? rawBroker.expectedSocketGid, expectedSocketParentMode: rawBroker.expectedSocketParentMode ?? 0o700, minimumBrokerGeneration: rawBroker.minimumBrokerGeneration ?? 1 }
  if (grants.length !== 0 || !Array.isArray(externalGrants) || externalGrants.length > 1000 || new Set(externalGrants.map(grant => grant.id)).size !== externalGrants.length
    || !canonicalAbsolute(broker.actionSocketPath) || Buffer.byteLength(broker.actionSocketPath) > 100 || !identifier(broker.brokerId)
    || !canonicalAbsolute(broker.brokerPublicKeyPath) || !canonicalAbsolute(broker.clientSigningKeyPath) || broker.brokerPublicKeyPath === broker.clientSigningKeyPath
    || !identifier(broker.clientKeyId) || !identifier(broker.clientInstanceId) || !Number.isSafeInteger(broker.clientGeneration) || broker.clientGeneration < 1
    || !Number.isSafeInteger(broker.requestTimeoutMs) || broker.requestTimeoutMs < 1 || broker.requestTimeoutMs > 300_000
    || !Number.isSafeInteger(broker.helloTtlMs) || broker.helloTtlMs < 1 || broker.helloTtlMs > 300_000
    || !Number.isSafeInteger(broker.expectedSocketUid) || broker.expectedSocketUid < 0 || broker.expectedSocketUid > 0x7fffffff
    || !Number.isSafeInteger(broker.expectedSocketGid) || broker.expectedSocketGid < 0 || broker.expectedSocketGid > 0x7fffffff
    || !Number.isSafeInteger(broker.expectedSocketMode) || broker.expectedSocketMode < 0 || broker.expectedSocketMode > 0o777
    || !Number.isSafeInteger(broker.expectedSocketParentUid) || broker.expectedSocketParentUid < 0 || broker.expectedSocketParentUid > 0x7fffffff
    || !Number.isSafeInteger(broker.expectedSocketParentGid) || broker.expectedSocketParentGid < 0 || broker.expectedSocketParentGid > 0x7fffffff
    || !Number.isSafeInteger(broker.expectedSocketParentMode) || broker.expectedSocketParentMode < 0 || broker.expectedSocketParentMode > 0o777
    || !Number.isSafeInteger(broker.expectedBrokerPeerUid) || broker.expectedBrokerPeerUid < 0 || broker.expectedBrokerPeerUid > 0x7fffffff
    || !Number.isSafeInteger(broker.expectedBrokerPeerGid) || broker.expectedBrokerPeerGid < 0 || broker.expectedBrokerPeerGid > 0x7fffffff
    || !Number.isSafeInteger(broker.minimumBrokerGeneration) || broker.minimumBrokerGeneration < 1) throw new Error('assistant-actions: invalid external broker config')
  const normalizedExternalGrants = externalGrants.map(grant => { validateExternalGrant(grant); return normalizeBrokerGrantProjection(grant) })
  return { stateRoot, grants: [], externalGrants: normalizedExternalGrants, broker }
}
export function normalizeCommit(value: CommitRequest): CommitRequest {
  if (!value || Object.keys(value).length !== 5 || !text(value.grantId) || !text(value.idempotencyKey)
    || !/^[0-9a-f]{40}$/.test(value.expectedHeadOid) || !text(value.headline, 200)
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 32
    || !value.files.every(file => file && Object.keys(file).length === 2 && validPath(file.path) && typeof file.content === 'string'
      && Buffer.byteLength(file.content) <= 1_048_576 && Buffer.from(file.content).toString('utf8') === file.content)
    || new Set(value.files.map(file => file.path)).size !== value.files.length || commitBytes(value) > 1_048_576) throw new Error('assistant-actions: invalid commit request')
  return structuredClone(value)
}
export const commitBytes = (request: CommitRequest): number => Buffer.byteLength(request.headline) + request.files.reduce((sum, file) => sum + Buffer.byteLength(file.path) + Buffer.byteLength(file.content), 0)

export function normalizeCompensation(value: CompensationRequest): CompensationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 6
    || Object.keys(value).some(key => !['grantId', 'idempotencyKey', 'forwardActionId', 'forwardActionVersion', 'forwardRequestDigest', 'forwardCommitOid'].includes(key))
    || !text(value.grantId) || !text(value.idempotencyKey) || !text(value.forwardActionId)
    || !Number.isSafeInteger(value.forwardActionVersion) || value.forwardActionVersion < 1
    || !/^[0-9a-f]{64}$/.test(value.forwardRequestDigest)
    || !/^[0-9a-f]{40,128}$/.test(value.forwardCommitOid)) throw new Error('assistant-actions: invalid compensation request')
  return structuredClone(value)
}

export function normalizeVerifiedDelivery(input: VerifiedDeliveryRequest): VerifiedDeliveryRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['grantId', 'idempotencyKey', 'expectedHeadOid', 'headline', 'paths', 'pullRequest'].includes(key))
    || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 32 || !input.paths.every(validPath)
    || new Set(input.paths).size !== input.paths.length) throw new Error('assistant-actions: invalid verified delivery')
  normalizeCommit({ grantId: input.grantId, idempotencyKey: input.idempotencyKey, expectedHeadOid: input.expectedHeadOid, headline: input.headline, files: input.paths.map(path => ({ path, content: '' })) })
  if (input.pullRequest !== undefined && (!input.pullRequest || Object.keys(input.pullRequest).length !== 2
    || !text(input.pullRequest.title, 200) || typeof input.pullRequest.body !== 'string' || Buffer.byteLength(input.pullRequest.body) > 65536)) throw new Error('assistant-actions: invalid verified pull request')
  return structuredClone(input)
}
