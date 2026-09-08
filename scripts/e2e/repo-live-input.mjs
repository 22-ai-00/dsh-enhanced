import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
const observationHandle = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,199}$/u.test(value)
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\p{Cc}]/u.test(value)
const branch = value => text(value) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) && !value.includes('..') && !value.startsWith('refs/')
const repository = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
const path = value => text(value, 1024) && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max

function fail(message) { throw new Error(`repo live input: ${message}`) }
export function mergeLiveCredentialHandles(current, live) {
  if (!Array.isArray(current) || current.some(handle => handle?.id === live.credential.id)) fail('credential handle conflicts with the temporary profile')
  return [...current, live.credential]
}
function exact(value, required) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key))
}

async function privateRegularFile(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value) fail(`${label} must be an absolute canonical path`)
  let stat
  try { stat = await lstat(value) } catch { fail(`${label} is unavailable`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail(`${label} must be a private regular file`)
}

async function credentialHandle(value, handleId) {
  if (!exact(value, ['id', 'provider', 'consumers', 'purposes', 'maxLeaseMs', 'reference'])) fail('credential handle is invalid')
  if (value.id !== handleId || !identifier(value.id) || !Array.isArray(value.consumers) || !Array.isArray(value.purposes)
    || !value.consumers.every(identifier) || !value.purposes.every(identifier) || new Set(value.consumers).size !== value.consumers.length
    || new Set(value.purposes).size !== value.purposes.length || !integer(value.maxLeaseMs, 30_000, 86_400_000)
    || !value.consumers.includes('dsh-enhanced-assistant-actions') || !value.consumers.includes('dsh-enhanced-event-triggers')
    || !value.purposes.includes('github.commit') || !value.purposes.includes('github.observe')) fail('credential handle is not authorized for live delivery and observation')
  let reference
  if (value.provider === 'environment') {
    if (!exact(value.reference, ['environmentName']) || typeof value.reference.environmentName !== 'string' || !/^[A-Z_][A-Z0-9_]*$/u.test(value.reference.environmentName)) fail('environment credential reference is invalid')
    reference = { environmentName: value.reference.environmentName }
  } else if (value.provider === 'linux-secret-service' || value.provider === 'macos-keychain') {
    if (!exact(value.reference, ['service', 'account']) || !identifier(value.reference.service) || !identifier(value.reference.account)) fail('OS keychain credential reference is invalid')
    reference = { service: value.reference.service, account: value.reference.account }
  } else if (value.provider === 'linux-protected-file' || value.provider === 'windows-dpapi') {
    if (!exact(value.reference, ['path']) || typeof value.reference.path !== 'string') fail('file credential reference is invalid')
    await privateRegularFile(value.reference.path, 'credential reference path')
    reference = { path: value.reference.path }
  } else fail('credential provider is unsupported')
  return Object.freeze({ id: value.id, provider: value.provider, consumers: Object.freeze([...value.consumers]),
    purposes: Object.freeze([...value.purposes]), maxLeaseMs: value.maxLeaseMs, ...reference })
}

/**
 * Reads a non-secret live GitHub E2E descriptor. The handle is copied into the
 * temporary profile as an existing provider reference; no credential value is
 * read, copied, or exposed to the model.
 */
export async function loadLiveRepositoryInput(inputPath, now = Date.now()) {
  if (!isAbsolute(inputPath) || resolve(inputPath) !== inputPath) fail('path must be absolute')
  const stat = await lstat(inputPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('path must be a private regular file')
  let value
  try { value = JSON.parse(await readFile(inputPath, 'utf8')) } catch { fail('must contain JSON') }
  const keys = ['version', 'repository', 'baseBranch', 'temporaryBranch', 'paths', 'credentialHandle', 'credential', 'expiresAt', 'maxActions', 'maxTotalBytes', 'requiredChecks', 'reviewerIds', 'minApprovals', 'event']
  if (!exact(value, keys) || value.version !== 2 || !repository(value.repository) || !branch(value.baseBranch)
    || !branch(value.temporaryBranch) || value.temporaryBranch === value.baseBranch || !observationHandle(value.credentialHandle)
    // The real scenario installs a ten-minute isolation grant. Keep the
    // external deadline inside that finite grant and leave setup's six-minute
    // execution-and-wake window intact.
    || !integer(value.expiresAt, now + 360_000, now + 600_000) || !integer(value.maxActions, 75, 10_000)
    || !integer(value.maxTotalBytes, 1, 64 * 1024 * 1024) || !Array.isArray(value.paths) || value.paths.length !== 1 || value.paths[0] !== 'summarize.mjs'
    || !value.paths.every(path) || new Set(value.paths).size !== value.paths.length || !Array.isArray(value.requiredChecks)
    || value.requiredChecks.length < 1 || value.requiredChecks.length > 20 || !Array.isArray(value.reviewerIds)
    || value.reviewerIds.length < 1 || value.reviewerIds.length > 30 || !integer(value.minApprovals, 1, value.reviewerIds.length)
    || new Set(value.reviewerIds).size !== value.reviewerIds.length || !value.reviewerIds.every(id => integer(id, 1, Number.MAX_SAFE_INTEGER))
    || !exact(value.event, ['maxPolls', 'maxFires', 'pollIntervalMs', 'requestTimeoutMs'])
    || !integer(value.event.maxPolls, 2, 1_000) || !integer(value.event.maxFires, 1, 100) || value.event.maxPolls <= value.event.maxFires
    || !integer(value.event.pollIntervalMs, 1_000, 3_600_000) || !integer(value.event.requestTimeoutMs, 100, 30_000)) fail('schema is invalid')
  const credential = await credentialHandle(value.credential, value.credentialHandle)
  if (credential.maxLeaseMs < value.event.requestTimeoutMs) fail('credential handle lease is shorter than the observation timeout')
  const checks = value.requiredChecks.map(check => {
    if (!exact(check, ['name', 'appId']) || !text(check.name) || !integer(check.appId, 1, Number.MAX_SAFE_INTEGER)) fail('requiredChecks is invalid')
    return Object.freeze({ name: check.name, appId: check.appId })
  })
  if (new Set(checks.map(check => `${check.name}\0${check.appId}`)).size !== checks.length) fail('requiredChecks is duplicated')
  const repositoryDelivery = Object.freeze({ repository: value.repository, baseBranch: value.baseBranch, branch: value.temporaryBranch,
    paths: Object.freeze([...value.paths]), credentialHandle: value.credentialHandle, expiresAt: value.expiresAt,
    maxActions: value.maxActions, maxTotalBytes: value.maxTotalBytes, openPullRequest: true, acceptance: 'goal-step',
    outcome: Object.freeze({ requiredChecks: Object.freeze(checks), reviewerIds: Object.freeze([...value.reviewerIds]),
      minApprovals: value.minApprovals, timeoutMs: value.event.requestTimeoutMs, freshnessMs: Math.min(60_000, value.event.requestTimeoutMs * 2) }),
    events: Object.freeze({ credentialHandle: value.credentialHandle, maxPolls: value.event.maxPolls, maxFires: value.event.maxFires,
      pollIntervalMs: value.event.pollIntervalMs, requestTimeoutMs: value.event.requestTimeoutMs }) })
  return Object.freeze({ credential, repositoryDelivery })
}
