import { createHash } from 'node:crypto'

const DIGEST = /^[0-9a-f]{64}$/u
const OID = /^[0-9a-f]{40,128}$/u
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`assistant-actions: invalid repository event ${label}`)
  return value
}
function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value || /[\p{Cc}]/u.test(value)) throw new Error(`assistant-actions: invalid repository event ${label}`)
  return value
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`assistant-actions: invalid repository event ${label}`)
  return value
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

export interface RepositoryEventObservationInput {
  version: 1
  triggerId: string
  grantId: string
  grantRevision: number
  grantDigest: string
  repository: string
  branch: string
  baseBranch: string
  owner: { workspace: string; preset: string; principalId: string; principalRecordId: string; principalVersion: number; ownerRouteId: string; expiresAt: number; budgetId: string }
  goal?: { id: string; sessionId: string; nativeGoalId: string; definitionVersion: number; definitionDigest: string }
}

export interface NormalizedRepositoryEventObservationInput extends RepositoryEventObservationInput {
  readonly owner: Readonly<RepositoryEventObservationInput['owner']>
  readonly goal?: Readonly<NonNullable<RepositoryEventObservationInput['goal']>>
}

/** Copies the small Host-only capability before any await or service lookup. */
export function normalizeRepositoryEventObservationInput(value: unknown): NormalizedRepositoryEventObservationInput {
  const input = exact(value, ['version', 'triggerId', 'grantId', 'grantRevision', 'grantDigest', 'repository', 'branch', 'baseBranch', 'owner', ...(plain(value) && Object.hasOwn(value, 'goal') ? ['goal'] : [])], 'input')
  if (input.version !== 1) throw new Error('assistant-actions: invalid repository event version')
  const owner = exact(input.owner, ['workspace', 'preset', 'principalId', 'principalRecordId', 'principalVersion', 'ownerRouteId', 'expiresAt', 'budgetId'], 'owner')
  const base = {
    version: 1 as const, triggerId: text(input.triggerId, 'triggerId'), grantId: text(input.grantId, 'grantId'), grantRevision: integer(input.grantRevision, 'grantRevision'),
    grantDigest: text(input.grantDigest, 'grantDigest', 80), repository: text(input.repository, 'repository', 256), branch: text(input.branch, 'branch'), baseBranch: text(input.baseBranch, 'baseBranch'),
    owner: Object.freeze({ workspace: text(owner.workspace, 'owner.workspace', 1024), preset: text(owner.preset, 'owner.preset'), principalId: text(owner.principalId, 'owner.principalId'), principalRecordId: text(owner.principalRecordId, 'owner.principalRecordId'), principalVersion: integer(owner.principalVersion, 'owner.principalVersion'), ownerRouteId: text(owner.ownerRouteId, 'owner.ownerRouteId'), expiresAt: integer(owner.expiresAt, 'owner.expiresAt'), budgetId: text(owner.budgetId, 'owner.budgetId') }),
  }
  if (!DIGEST.test(base.grantDigest) || !REPOSITORY.test(base.repository) || base.branch === base.baseBranch) throw new Error('assistant-actions: invalid repository event scope')
  if (input.goal === undefined) return Object.freeze(base)
  const goal = exact(input.goal, ['id', 'sessionId', 'nativeGoalId', 'definitionVersion', 'definitionDigest'], 'goal')
  const normalizedGoal = Object.freeze({ id: text(goal.id, 'goal.id'), sessionId: text(goal.sessionId, 'goal.sessionId'), nativeGoalId: text(goal.nativeGoalId, 'goal.nativeGoalId'), definitionVersion: integer(goal.definitionVersion, 'goal.definitionVersion'), definitionDigest: text(goal.definitionDigest, 'goal.definitionDigest', 80) })
  if (!DIGEST.test(normalizedGoal.definitionDigest)) throw new Error('assistant-actions: invalid repository event goal')
  return Object.freeze({ ...base, goal: normalizedGoal })
}

export function repositoryEventFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

export function repositoryEventBranchHead(value: unknown, branch: string): string | undefined {
  if (!plain(value) || value.name !== branch || !plain(value.commit) || typeof value.commit.sha !== 'string' || !OID.test(value.commit.sha) || value.untrusted !== true) return undefined
  return value.commit.sha
}

/** A settled delivery with no usable PR remains a stable non-event observation. */
export function repositoryEventPendingFingerprint(input: NormalizedRepositoryEventObservationInput, headOid: string): string {
  return repositoryEventFingerprint({ protocol: 'assistant-actions/repository-event/v1', repository: input.repository, branch: input.branch, headOid, state: 'pending' })
}

export function repositoryEventSemanticFingerprint(input: NormalizedRepositoryEventObservationInput, headOid: string, expectedPullRequestNumber: number, pullRequest: unknown, checks: unknown, reviews: unknown): string {
  if (!OID.test(headOid) || !Number.isSafeInteger(expectedPullRequestNumber) || expectedPullRequestNumber < 1) throw new Error('assistant-actions: repository event observation malformed')
  const scope = (value: unknown, topLevel: boolean): Record<string, unknown> => {
    if (!plain(value) || !plain(value.head) || !plain(value.base) || !plain(value.head.repo) || !plain(value.base.repo)) throw new Error('assistant-actions: repository event pull request malformed')
    const pr = value, head = value.head as Record<string, unknown>, base = value.base as Record<string, unknown>, headRepo = head.repo as Record<string, unknown>, baseRepo = base.repo as Record<string, unknown>
    if (pr.number !== expectedPullRequestNumber || typeof pr.state !== 'string' || !['open', 'closed'].includes(pr.state) || typeof pr.merged !== 'boolean'
      || head.ref !== input.branch || typeof head.sha !== 'string' || head.sha !== headOid || base.ref !== input.baseBranch || headRepo.full_name !== input.repository || baseRepo.full_name !== input.repository
      || !OID.test(head.sha) || topLevel && pr.untrusted !== true) throw new Error('assistant-actions: repository event observation scope changed')
    return pr
  }
  const pr = scope(pullRequest, true)
  const list = (value: unknown, label: 'checks' | 'reviews'): readonly Record<string, unknown>[] => {
    if (!plain(value)) throw new Error(`assistant-actions: repository event ${label} malformed`)
    const observed = value
    scope(observed.pullRequest, false)
    if (observed.headOid !== headOid || observed.truncated !== false || observed.untrusted !== true || !Array.isArray(observed.items) || observed.items.length > (label === 'checks' ? 20 : 30)) throw new Error('assistant-actions: repository event observation scope changed')
    const rows = observed.items.map((item) => {
      if (!plain(item)) throw new Error(`assistant-actions: repository event ${label} malformed`)
      const row = item
      if (!Number.isSafeInteger(row.id) || (row.id as number) < 1) throw new Error(`assistant-actions: repository event ${label} malformed`)
      if (label === 'checks') {
        if (!plain(row.app)) throw new Error('assistant-actions: repository event checks malformed')
        const app = row.app
        if (typeof row.name !== 'string' || typeof row.status !== 'string' || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(row.status)
          || row.conclusion !== null && (typeof row.conclusion !== 'string' || !['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(row.conclusion))
          || row.head_sha !== headOid || typeof row.head_sha !== 'string' || !OID.test(row.head_sha) || !Number.isSafeInteger(app.id) || (app.id as number) < 1) throw new Error('assistant-actions: repository event checks malformed')
      } else {
        if (!plain(row.user)) throw new Error('assistant-actions: repository event reviews malformed')
        const user = row.user
        if (typeof row.state !== 'string' || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(row.state) || typeof row.commit_id !== 'string' || !OID.test(row.commit_id) || !Number.isSafeInteger(user.id) || (user.id as number) < 1
          || row.submitted_at !== undefined && (typeof row.submitted_at !== 'string' || Number.isNaN(Date.parse(row.submitted_at)))) throw new Error('assistant-actions: repository event reviews malformed')
      }
      return row
    })
    const ids = rows.map(row => row.id as number)
    if (new Set(ids).size !== ids.length) throw new Error(`assistant-actions: repository event ${label} mixed`)
    return rows.sort((left, right) => (left.id as number) - (right.id as number))
  }
  const semanticChecks = list(checks, 'checks').map(item => ({ id: item.id as number, state: item.status as string, conclusion: item.conclusion as string | null, headOid: item.head_sha as string, appId: (item.app as Record<string, unknown>).id as number }))
  const semanticReviews = list(reviews, 'reviews').map(item => ({ id: item.id as number, state: item.state as string, commitOid: item.commit_id as string, reviewer: (item.user as Record<string, unknown>).id as number }))
  return repositoryEventFingerprint({ protocol: 'assistant-actions/repository-event/v1', repository: input.repository, branch: input.branch, headOid,
    pullRequest: { number: pr.number, state: pr.state, merged: pr.merged }, checks: semanticChecks, reviews: semanticReviews })
}
