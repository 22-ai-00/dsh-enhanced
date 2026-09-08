import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { ActionGrant, CommitRequest, VerifiedDeliveryRequest } from './types.js'

export interface Config { stateRoot?: string; grants?: ActionGrant[] }
const positive = (max: number) => Schema.number().step(1).min(1).max(max)
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
  })).default([]),
})
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value)
export function validPath(value: unknown): value is string {
  return text(value, 1024) && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}
export function validateConfig(input: Config): Required<Config> {
  const stateRoot = input.stateRoot ?? join(homedir(), '.dsh', 'assistant-actions')
  if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || stateRoot === '/') throw new Error('assistant-actions: canonical private state root required')
  const grants = structuredClone(input.grants ?? [])
  if (!Array.isArray(grants) || grants.length > 1000 || new Set(grants.map(grant => grant.id)).size !== grants.length) throw new Error('assistant-actions: invalid grants')
  for (const grant of grants) {
    if (!grant || ![14, 15, 16].includes(Object.keys(grant).length)
      || Object.keys(grant).some(key => !['id', 'revision', 'principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset', 'repository', 'branch', 'paths', 'credentialHandle', 'expiresAt', 'maxActions', 'maxTotalBytes', 'repoWorkflow', 'verifiedDelivery'].includes(key))
      || grant.verifiedDelivery !== undefined && (!grant.verifiedDelivery || ![2, 3].includes(Object.keys(grant.verifiedDelivery).length) || Object.keys(grant.verifiedDelivery).some(key => !['ownerRouteId', 'budgetId', 'acceptance'].includes(key)) || grant.verifiedDelivery.acceptance !== undefined && !['goal-outcome', 'goal-step'].includes(grant.verifiedDelivery.acceptance) || !text(grant.verifiedDelivery.ownerRouteId, 200) || !text(grant.verifiedDelivery.budgetId, 200))
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
  return { stateRoot, grants }
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
