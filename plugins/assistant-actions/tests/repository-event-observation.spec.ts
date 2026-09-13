import { describe, expect, it } from 'vitest'
import { normalizeRepositoryEventObservationInput, repositoryEventBranchHead, repositoryEventPendingFingerprint, repositoryEventSemanticFingerprint } from '../src/repository-event-observation.ts'

const input = () => ({ version: 1 as const, triggerId: 'trigger-1', grantId: 'grant-1', grantRevision: 2, grantDigest: 'a'.repeat(64),
  repository: 'owner/repository', branch: 'work', baseBranch: 'main', owner: { workspace: '/workspace', preset: 'default', principalId: 'principal', principalRecordId: 'record', principalVersion: 3, ownerRouteId: 'route', expiresAt: 4_000_000_000_000, budgetId: 'events' } })
const oid = 'a'.repeat(40)
const branch = () => ({ name: 'work', commit: { sha: oid }, untrusted: true })
const pullRequest = () => ({ number: 7, state: 'open', merged: false, head: { ref: 'work', sha: oid, repo: { full_name: 'owner/repository' } }, base: { ref: 'main', repo: { full_name: 'owner/repository' } }, untrusted: true })
const scopedPullRequest = () => { const { untrusted: _untrusted, ...value } = pullRequest(); return value }
const checks = () => ({ pullRequest: scopedPullRequest(), headOid: oid, items: [{ id: 2, status: 'completed', conclusion: 'success', head_sha: oid, app: { id: 9 }, name: 'ci' }], truncated: false, untrusted: true })
const reviews = () => ({ pullRequest: scopedPullRequest(), headOid: oid, items: [{ id: 3, state: 'APPROVED', commit_id: oid, user: { id: 4 } }], truncated: false, untrusted: true })

describe('repository event observation normalizer', () => {
  it('keeps a branch baseline stable before the first goal claim', () => {
    const normalized = normalizeRepositoryEventObservationInput(input())
    expect(repositoryEventBranchHead(branch(), normalized.branch)).toBe(oid)
    expect(repositoryEventPendingFingerprint(normalized, oid)).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('hashes only scoped semantic signed-observation fields', () => {
    const normalized = normalizeRepositoryEventObservationInput({ ...input(), goal: { id: 'goal', sessionId: 'session', nativeGoalId: 'native', definitionVersion: 1, definitionDigest: 'b'.repeat(64) } })
    const first = repositoryEventSemanticFingerprint(normalized, oid, 7, pullRequest(), checks(), reviews())
    const reordered = repositoryEventSemanticFingerprint(normalized, oid, 7, pullRequest(), { ...checks(), items: [...checks().items].reverse() }, reviews())
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(reordered).toBe(first)
    expect(repositoryEventSemanticFingerprint(normalized, oid, 7, { ...pullRequest(), html_url: 'ignored' }, { ...checks(), remote_debug: { body: 'ignored' } }, { ...reviews(), remote_debug: true })).toBe(first)
  })

  it('rejects malformed owner or goal drift before it can reach a broker', () => {
    expect(() => normalizeRepositoryEventObservationInput({ ...input(), owner: { ...input().owner, principalVersion: 0 } })).toThrow(/invalid repository event/i)
    expect(() => normalizeRepositoryEventObservationInput({ ...input(), goal: { id: 'goal', sessionId: 'session', nativeGoalId: 'native', definitionVersion: 1, definitionDigest: 'BAD' } })).toThrow(/invalid repository event/i)
  })

  it('fails closed on truncated, mixed-head, or duplicate remote observations', () => {
    const normalized = normalizeRepositoryEventObservationInput(input())
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 7, pullRequest(), { ...checks(), truncated: true }, reviews())).toThrow(/scope changed/i)
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 7, pullRequest(), { ...checks(), headOid: 'b'.repeat(40) }, reviews())).toThrow(/scope changed/i)
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 7, pullRequest(), { ...checks(), items: [...checks().items, checks().items[0]] }, reviews())).toThrow(/mixed/i)
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 8, pullRequest(), checks(), reviews())).toThrow(/scope changed/i)
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 7, { ...pullRequest(), head: { ...pullRequest().head, repo: { full_name: 'other/repository' } } }, checks(), reviews())).toThrow(/scope changed/i)
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 7, pullRequest(), { ...checks(), items: [{ ...checks().items[0]!, status: 'made-up' }] }, reviews())).toThrow(/checks malformed/i)
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 7, { ...pullRequest(), state: ['open'] }, checks(), reviews())).toThrow(/scope changed/i)
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 7, pullRequest(), { ...checks(), items: [{ ...checks().items[0]!, conclusion: ['success'] }] }, reviews())).toThrow(/checks malformed/i)
    expect(() => repositoryEventSemanticFingerprint(normalized, oid, 7, pullRequest(), checks(), { ...reviews(), items: [{ ...reviews().items[0]!, commit_id: [oid] }] })).toThrow(/reviews malformed/i)
  })
})
