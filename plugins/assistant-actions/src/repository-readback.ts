export interface RepositoryReadbackRequirements {
  requiredChecks: readonly { name: string; appId: number }[]
  reviewerIds: readonly number[]
  minApprovals: number
}

export interface RepositoryReadback {
  objectId: string
  headOid: string
  ci: 'passed' | 'pending' | 'failed' | 'unknown'
  review: 'approved' | 'pending' | 'changes-requested' | 'unknown'
  pullRequest: 'open' | 'closed' | 'merged' | 'unknown'
}
export interface RepositoryCommitReadback {
  mode: 'commit'
  objectId: string
  headOid: string
  ci: 'passed' | 'pending' | 'failed' | 'unknown'
  ready: boolean
}

const maximumChecks = 20
const maximumReviews = 30
const maximumText = 256
const repositoryName = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u
const oid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40,128}$/iu.test(value)

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!plain(value)) return undefined
  const names = Object.getOwnPropertyNames(value).sort()
  if (names.length !== keys.length || names.some((key, index) => key !== [...keys].sort()[index])) return undefined
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined
  }
  return value
}

function boundedArray(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0 || value.length > maximum) return undefined
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || names.at(-1) !== 'length') return undefined
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined
  }
  return value
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumText && value.trim() === value && !/\p{Cc}/u.test(value)
}

/** Validates the bounded, explicit CI and reviewer requirements for one repository delivery. */
export function validateRepositoryReadbackRequirements(value: unknown): RepositoryReadbackRequirements {
  const input = exactObject(value, ['requiredChecks', 'reviewerIds', 'minApprovals'])
  const requiredChecks = boundedArray(input?.requiredChecks, maximumChecks)
  const reviewerIds = boundedArray(input?.reviewerIds, maximumReviews)
  if (!input || !requiredChecks || requiredChecks.length === 0 || !reviewerIds || !Number.isSafeInteger(input.minApprovals) || (input.minApprovals as number) < 0 || (input.minApprovals as number) > reviewerIds.length) throw new TypeError('invalid repository readback requirements')
  const checks = requiredChecks.map((value) => {
    const check = exactObject(value, ['name', 'appId'])
    if (!check || !validName(check.name) || !positiveInteger(check.appId)) throw new TypeError('invalid repository readback requirements')
    return Object.freeze({ name: check.name, appId: check.appId })
  })
  if (new Set(checks.map(check => `${check.name}\u0000${check.appId}`)).size !== checks.length) throw new TypeError('invalid repository readback requirements')
  const reviewers = reviewerIds.map((value) => {
    if (!positiveInteger(value)) throw new TypeError('invalid repository readback requirements')
    return value
  })
  if (new Set(reviewers).size !== reviewers.length) throw new TypeError('invalid repository readback requirements')
  return Object.freeze({ requiredChecks: Object.freeze(checks), reviewerIds: Object.freeze(reviewers), minApprovals: input.minApprovals as number })
}

function scopedPullRequest(value: unknown, input: { repository: string; branch: string; baseBranch: string; commitOid: string; pullRequestNumber: number }): Record<string, unknown> | undefined {
  if (!plain(value) || value.number !== input.pullRequestNumber) return undefined
  const head = plain(value.head) ? value.head : undefined
  const base = plain(value.base) ? value.base : undefined
  const headRepository = head && plain(head.repo) ? head.repo : undefined
  const baseRepository = base && plain(base.repo) ? base.repo : undefined
  if (!head || !base || !headRepository || !baseRepository || head.ref !== input.branch || head.sha !== input.commitOid || base.ref !== input.baseBranch) return undefined
  if (headRepository.full_name !== input.repository || baseRepository.full_name !== input.repository) return undefined
  return value
}

function observedList(value: unknown, keys: readonly string[], input: { repository: string; branch: string; baseBranch: string; commitOid: string; pullRequestNumber: number }, maximum: number): { items: unknown[] } | undefined {
  const observed = exactObject(value, keys)
  if (!observed || observed.untrusted !== true || observed.truncated !== false || observed.headOid !== input.commitOid || !scopedPullRequest(observed.pullRequest, input)) return undefined
  const items = boundedArray(observed.items, maximum)
  return items ? { items } : undefined
}

function branchHead(value: unknown, input: { branch: string; commitOid: string }): string | undefined {
  if (!plain(value) || value.name !== input.branch) return undefined
  const commit = plain(value.commit) ? value.commit : undefined
  return commit?.sha === input.commitOid && oid(commit.sha) ? commit.sha : undefined
}

function ciStatus(value: unknown, input: Readonly<{ repository: string; branch: string; baseBranch: string; commitOid: string; pullRequestNumber: number; requirements: RepositoryReadbackRequirements }>): RepositoryReadback['ci'] {
  const observed = observedList(value, ['pullRequest', 'headOid', 'items', 'truncated', 'untrusted'], input, maximumChecks)
  if (!observed) return 'unknown'
  let pending = false
  for (const requirement of input.requirements.requiredChecks) {
    const matches: Record<string, unknown>[] = []
    for (const item of observed.items) {
      if (!plain(item) || !positiveInteger(item.id) || !validName(item.name) || !plain(item.app) || !positiveInteger(item.app.id) || !oid(item.head_sha) || typeof item.status !== 'string' || (item.conclusion !== null && typeof item.conclusion !== 'string')) return 'unknown'
      if (item.name === requirement.name && item.app.id === requirement.appId) matches.push(item)
    }
    if (matches.length === 0) { pending = true; continue }
    if (matches.length !== 1) return 'unknown'
    const check = matches[0]!
    if (check.head_sha !== input.commitOid) return 'unknown'
    if (check.status !== 'completed') { pending = true; continue }
    if (check.conclusion === 'success') continue
    if (check.conclusion === null) return 'unknown'
    return 'failed'
  }
  return pending ? 'pending' : 'passed'
}

function commitCiStatus(value: unknown, input: Readonly<{ repository: string; branch: string; commitOid: string; requirements: Pick<RepositoryReadbackRequirements, 'requiredChecks'> }>): RepositoryCommitReadback['ci'] {
  const observed = exactObject(value, ['repository', 'headOid', 'items', 'truncated', 'untrusted'])
  if (!observed || observed.repository !== input.repository || observed.headOid !== input.commitOid || observed.truncated !== false || observed.untrusted !== true) return 'unknown'
  const items = boundedArray(observed.items, maximumChecks)
  if (!items) return 'unknown'
  let pending = false
  for (const requirement of input.requirements.requiredChecks) {
    const matches: Record<string, unknown>[] = []
    for (const item of items) {
      if (!plain(item) || !positiveInteger(item.id) || !validName(item.name) || !plain(item.app) || !positiveInteger(item.app.id) || !oid(item.head_sha) || typeof item.status !== 'string' || (item.conclusion !== null && typeof item.conclusion !== 'string')) return 'unknown'
      if (item.name === requirement.name && item.app.id === requirement.appId) matches.push(item)
    }
    if (matches.length === 0) { pending = true; continue }
    if (matches.length !== 1) return 'unknown'
    const check = matches[0]!
    if (check.head_sha !== input.commitOid) return 'unknown'
    if (check.status !== 'completed') { pending = true; continue }
    if (check.conclusion === 'success') continue
    if (check.conclusion === null) return 'unknown'
    return 'failed'
  }
  return pending ? 'pending' : 'passed'
}

function reviewStatus(value: unknown, input: Readonly<{ repository: string; branch: string; baseBranch: string; commitOid: string; pullRequestNumber: number; requirements: RepositoryReadbackRequirements }>): RepositoryReadback['review'] {
  const observed = observedList(value, ['pullRequest', 'headOid', 'items', 'truncated', 'untrusted'], input, maximumReviews)
  if (!observed) return 'unknown'
  const latest = new Map<number, Record<string, unknown>>()
  const reviewIds = new Set<number>()
  let lastSubmittedAt = -Infinity
  for (const item of observed.items) {
    if (!plain(item) || !positiveInteger(item.id) || reviewIds.has(item.id) || !oid(item.commit_id) || !plain(item.user) || !positiveInteger(item.user.id) || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(String(item.state))) return 'unknown'
    reviewIds.add(item.id)
    if (item.submitted_at !== undefined) {
      if (typeof item.submitted_at !== 'string' || Number.isNaN(Date.parse(item.submitted_at))) return 'unknown'
      const submittedAt = Date.parse(item.submitted_at)
      if (submittedAt < lastSubmittedAt) return 'unknown'
      lastSubmittedAt = submittedAt
    }
    // GitHub returns reviews chronologically. The last item for a reviewer is
    // their current state; review IDs are identifiers, not ordering evidence.
    latest.set(item.user.id as number, item)
  }
  let approvals = 0
  for (const reviewerId of input.requirements.reviewerIds) {
    const review = latest.get(reviewerId)
    if (review?.state === 'CHANGES_REQUESTED') return 'changes-requested'
    if (review?.state === 'APPROVED' && review.commit_id === input.commitOid) approvals++
  }
  return approvals >= input.requirements.minApprovals ? 'approved' : 'pending'
}

function pullRequestStatus(value: unknown, input: { repository: string; branch: string; baseBranch: string; commitOid: string; pullRequestNumber: number }): RepositoryReadback['pullRequest'] {
  const pullRequest = scopedPullRequest(value, input)
  if (!pullRequest || typeof pullRequest.state !== 'string' || (pullRequest.merged !== undefined && typeof pullRequest.merged !== 'boolean')) return 'unknown'
  if (pullRequest.merged === true) return 'merged'
  return pullRequest.state === 'open' ? 'open' : pullRequest.state === 'closed' ? 'closed' : 'unknown'
}

/**
 * Reduces bounded, untrusted GitHub inspect observations. Any incomplete or
 * conflicting evidence becomes unknown instead of an affirmative conclusion.
 */
export function normalizeRepositoryReadback(input: { repository: string; branch: string; baseBranch: string; commitOid: string; pullRequestNumber: number; requirements: RepositoryReadbackRequirements; checks: unknown; reviews: unknown; pullRequest: unknown; branchSnapshot: unknown }): RepositoryReadback {
  const empty: RepositoryReadback = { objectId: '', headOid: '', ci: 'unknown', review: 'unknown', pullRequest: 'unknown' }
  if (!validName(input.repository) || !repositoryName.test(input.repository) || !validName(input.branch) || !validName(input.baseBranch) || input.branch === input.baseBranch || `${input.repository}:${input.branch}`.length > maximumText || !oid(input.commitOid) || !positiveInteger(input.pullRequestNumber)) return empty
  let requirements: RepositoryReadbackRequirements
  try { requirements = validateRepositoryReadbackRequirements(input.requirements) } catch { return empty }
  const scoped = { repository: input.repository, branch: input.branch, baseBranch: input.baseBranch, commitOid: input.commitOid, pullRequestNumber: input.pullRequestNumber, requirements }
  const headOid = branchHead(input.branchSnapshot, scoped)
  const objectId = `${input.repository}:${input.branch}`
  return Object.freeze({
    objectId,
    headOid: headOid ?? '',
    ci: ciStatus(input.checks, scoped),
    review: reviewStatus(input.reviews, scoped),
    pullRequest: pullRequestStatus(input.pullRequest, scoped),
  })
}

/** Reduces a branch-fixed direct commit receipt and its exact-commit checks. */
export function normalizeRepositoryCommitReadback(input: { repository: string; branch: string; commitOid: string; requirements: Pick<RepositoryReadbackRequirements, 'requiredChecks'>; checks: unknown; branchSnapshot: unknown }): RepositoryCommitReadback {
  const empty: RepositoryCommitReadback = { mode: 'commit', objectId: '', headOid: '', ci: 'unknown', ready: false }
  if (!validName(input.repository) || !repositoryName.test(input.repository) || !validName(input.branch) || `${input.repository}:${input.branch}`.length > maximumText || !oid(input.commitOid)) return empty
  let requirements: RepositoryReadbackRequirements
  try { requirements = validateRepositoryReadbackRequirements({ requiredChecks: input.requirements.requiredChecks, reviewerIds: [], minApprovals: 0 }) } catch { return empty }
  const headOid = branchHead(input.branchSnapshot, { branch: input.branch, commitOid: input.commitOid }) ?? ''
  const ci = headOid === input.commitOid ? commitCiStatus(input.checks, { repository: input.repository, branch: input.branch, commitOid: input.commitOid, requirements }) : 'unknown'
  return Object.freeze({ mode: 'commit', objectId: `${input.repository}:${input.branch}`, headOid, ci, ready: headOid === input.commitOid && ci === 'passed' })
}
