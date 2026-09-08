import { describe, expect, it } from 'vitest'
import { normalizeRepositoryReadback, validateRepositoryReadbackRequirements } from '../src/repository-readback.ts'

const repository = 'owner/repository'
const branch = 'delivery/goal-1'
const baseBranch = 'main'
const commitOid = 'a'.repeat(40)
const oldOid = 'b'.repeat(40)
const requirements = { requiredChecks: [{ name: 'CI', appId: 7 }], reviewerIds: [42], minApprovals: 1 }

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 99, number: 12, state: 'open', merged: false, head: { ref: branch, sha: commitOid, repo: { full_name: repository } }, base: { ref: baseBranch, repo: { full_name: repository } }, ...overrides }
}
function observed(items: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pullRequest: pullRequest(), headOid: commitOid, items, truncated: false, untrusted: true, ...overrides }
}
function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, name: 'CI', app: { id: 7 }, head_sha: commitOid, status: 'completed', conclusion: 'success', ...overrides }
}
function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, user: { id: 42 }, commit_id: commitOid, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z', ...overrides }
}
function normalize(overrides: Partial<Parameters<typeof normalizeRepositoryReadback>[0]> = {}) {
  return normalizeRepositoryReadback({ repository, branch, baseBranch, commitOid, pullRequestNumber: 12, requirements, checks: observed([check()]), reviews: observed([review()]), pullRequest: pullRequest(), branchSnapshot: { name: branch, commit: { sha: commitOid } }, ...overrides })
}

describe('repository readback normalization', () => {
  it('accepts exact green checks, a current-head approval, and an open pull request', () => {
    expect(normalize()).toEqual({ objectId: `${repository}:${branch}`, headOid: commitOid, ci: 'passed', review: 'approved', pullRequest: 'open' })
  })

  it('does not accept a required check from another app or an old head', () => {
    expect(normalize({ checks: observed([check({ app: { id: 8 } })]) }).ci).toBe('pending')
    expect(normalize({ checks: observed([check({ head_sha: oldOid })]) }).ci).toBe('unknown')
  })

  it('requires checks for every explicitly required identity and keeps absent checks pending', () => {
    const twoChecks = { ...requirements, requiredChecks: [...requirements.requiredChecks, { name: 'lint', appId: 8 }] }
    expect(normalize({ requirements: twoChecks }).ci).toBe('pending')
  })

  it('uses chronological review order, so a later revocation defeats an earlier approval even with a lower id', () => {
    expect(normalize({ reviews: observed([review({ id: 9 }), review({ id: 2, state: 'DISMISSED', submitted_at: '2025-01-02T00:00:00Z' })]) }).review).toBe('pending')
  })

  it('keeps a latest changes request from an old head blocking after new code', () => {
    expect(normalize({ reviews: observed([review({ id: 1 }), review({ id: 2, state: 'CHANGES_REQUESTED', commit_id: oldOid, submitted_at: '2025-01-02T00:00:00Z' })]) }).review).toBe('changes-requested')
  })

  it('does not count approvals for an old head and rejects truncated, oversized, nonplain, or malformed observations', () => {
    expect(normalize({ reviews: observed([review({ commit_id: oldOid })]) }).review).toBe('pending')
    expect(normalize({ checks: observed([check()], { truncated: true }) }).ci).toBe('unknown')
    expect(normalize({ checks: observed(Array.from({ length: 21 }, (_, id) => check({ id: id + 1 }))) }).ci).toBe('unknown')
    expect(normalize({ checks: Object.create(null) }).ci).toBe('unknown')
    expect(normalize({ reviews: observed([{ id: 1, user: { id: 42 }, state: 'APPROVED' }]) }).review).toBe('unknown')
  })

  it('rejects a pull request whose repository, branches, head, or number differs from the fixed delivery target', () => {
    expect(normalize({ pullRequest: pullRequest({ number: 13 }) }).pullRequest).toBe('unknown')
    expect(normalize({ pullRequest: pullRequest({ head: { ref: 'other', sha: commitOid, repo: { full_name: repository } } }) }).pullRequest).toBe('unknown')
    expect(normalize({ pullRequest: pullRequest({ base: { ref: 'other', repo: { full_name: repository } } }) }).pullRequest).toBe('unknown')
    expect(normalize({ pullRequest: pullRequest({ head: { ref: branch, sha: commitOid, repo: { full_name: 'other/repository' } } }) }).pullRequest).toBe('unknown')
  })

  it('allows zero explicitly required approvals without inventing a review', () => {
    expect(normalize({ requirements: { requiredChecks: requirements.requiredChecks, reviewerIds: [], minApprovals: 0 }, reviews: observed([]) }).review).toBe('approved')
  })

  it('returns the actual non-passing pull-request state for a closed PR', () => {
    expect(normalize({ pullRequest: pullRequest({ state: 'closed', merged: false }) }).pullRequest).toBe('closed')
    expect(normalize({ pullRequest: pullRequest({ state: 'closed', merged: true }) }).pullRequest).toBe('merged')
  })
})

describe('repository readback requirements', () => {
  it('freezes a bounded validated requirements object', () => {
    const value = validateRepositoryReadbackRequirements(requirements)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.requiredChecks)).toBe(true)
    expect(Object.isFrozen(value.reviewerIds)).toBe(true)
    expect(() => validateRepositoryReadbackRequirements({ ...requirements, extra: true })).toThrow('invalid repository readback requirements')
    expect(() => validateRepositoryReadbackRequirements({ ...requirements, minApprovals: 2 })).toThrow('invalid repository readback requirements')
    expect(() => validateRepositoryReadbackRequirements({ ...requirements, requiredChecks: [] })).toThrow('invalid repository readback requirements')
    expect(validateRepositoryReadbackRequirements({ ...requirements, requiredChecks: [{ name: 'x'.repeat(256), appId: 7 }] }).requiredChecks[0]!.name).toHaveLength(256)
  })
})
