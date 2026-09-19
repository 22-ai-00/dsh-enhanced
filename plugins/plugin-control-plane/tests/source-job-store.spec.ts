import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlaneStore, ControlPlaneStoreError, MODIFY_GENERATOR_DIGEST, controlPlaneDigest } from '../src/store.ts'
import type { SourceJobIntent } from '../src/source-job-types.ts'
import type { SourcePreparedEvidence } from '../src/types.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const hex = (value: string) => createHash('sha256').update(value).digest('hex')

async function fixture(now = 1_800_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-source-job-')); roots.push(root)
  let clock = now; const path = join(root, 'state.sqlite'); const store = new ControlPlaneStore({ path, now: () => clock })
  return { path, store, now: () => clock, setNow: (value: number) => { clock = value } }
}

function intent(overrides: Partial<SourceJobIntent> = {}, id = 'd'): SourceJobIntent {
  const authority = { id: 'authority-a', digest: hex('authority-a'), expiresAt: 1_800_000_060_000, maxSubmissions: 2 }
  const owner = { receiptVersion: 2 as const, authorityId: 'owner-authority', authorityHash: hex('owner'), principalId: 'owner',
    principalRecordId: 'principal-record', principalVersion: 1, workspace: 'workspace', agentPreset: 'preset', bindingVersion: 1, generation: 1 }
  return { authority, owner, ownerDigest: controlPlaneDigest(owner), trustDigest: hex('trust'), repository: '/repository', name: 'health-helper',
    gapId: 'gap-placeholder', gapRevision: 1, gapDigest: hex('gap'), baseCommit: 'a'.repeat(40),
    files: [{ path: 'src/index.ts', content: 'export {}\n' }], ttlMs: 60_000,
    build: { dockerPath: '/usr/bin/docker', image: `example@sha256:${'b'.repeat(64)}`, timeoutMs: 60_000, memoryMiB: 128,
      cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
    worktree: `/worktree/worktree-job-${id.repeat(64)}`, containerName: `dsh-source-job-${id.repeat(64)}`, ...overrides }
}

function jobId(character = 'd') { return `source-job-${character.repeat(64)}` }

function evidence(): SourcePreparedEvidence {
  return { schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v22.0.0', pnpmVersion: '9.0.0' },
    commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 1, logDigest: hex('check') }],
    pack: { name: 'health-helper-0.1.0.tgz', version: '0.1.0', sizeBytes: 1, sha256: hex('pack') }, preparedAt: 1_800_000_000_001 }
}

function completionInput(gapId: string, job: { id: string; revision: number }, source: SourceJobIntent, overrides: Record<string, unknown> = {}) {
  return { gapId, repository: source.repository, worktree: source.worktree, baseCommit: source.baseCommit, name: source.name,
    generatorDigest: MODIFY_GENERATOR_DIGEST, scope: ['plugins/health-helper'], mode: 'modify' as const, ttlMs: source.ttlMs,
    idempotencyKey: `source-job-plan:${job.id}`, prepared: { treeDigest: hex('tree'), patchDigest: hex('patch'), checkedAt: 1_800_000_000_001, evidence: evidence() },
    sourceJob: { jobId: job.id, jobRevision: job.revision, occurrenceId: 'occurrence-1' }, ...overrides }
}

function sourcePlanCount(path: string): number {
  const database = new DatabaseSync(path)
  try { return Number((database.prepare('SELECT count(*) AS count FROM source_plans').get() as { count: number }).count) }
  finally { database.close() }
}

describe('durable source job ledger', () => {
  it('replays exact authority-scoped submissions and persists its quota', async () => {
    const target = await fixture()
    try {
      const first = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'source-job:one', intent: intent() })
      expect(target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'source-job:one', intent: intent() })).toEqual(first)
      expect(() => target.store.enqueueSourceJob({ id: jobId('e'), automationId: jobId('e'), idempotencyKey: 'source-job:one',
        intent: intent({ name: 'other-helper' }, 'e') })).toThrow(ControlPlaneStoreError)
      target.store.settleSourceJob({ id: first.id, revision: first.revision, status: 'failed', failureCode: 'rejected' })
      const second = target.store.enqueueSourceJob({ id: jobId('e'), automationId: jobId('e'), idempotencyKey: 'source-job:two', intent: intent({}, 'e') })
      target.store.settleSourceJob({ id: second.id, revision: second.revision, status: 'failed', failureCode: 'rejected' })
      expect(() => target.store.enqueueSourceJob({ id: jobId('f'), automationId: jobId('f'), idempotencyKey: 'source-job:three', intent: intent({}, 'f') })).toThrow(/quota/)
      target.store.close()
      const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
      try { expect(() => reopened.enqueueSourceJob({ id: jobId('f'), automationId: jobId('f'), idempotencyKey: 'source-job:three', intent: intent({}, 'f') })).toThrow(/quota/) }
      finally { reopened.close() }
    } finally { try { target.store.close() } catch {} }
  })

  it('binds, claims, interrupts and retains unknown restart work ahead of history', async () => {
    const target = await fixture()
    try {
      const queued = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'source-job:one', intent: intent() })
      const bound = target.store.bindSourceJobDefinition({ id: queued.id, revision: queued.revision, definitionHash: hex('definition') })
      const running = target.store.claimSourceJob({ id: queued.id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })
      expect(target.store.interruptSourceJobs()).toBe(1)
      const unknown = target.store.getSourceJob(queued.id)!
      expect(unknown).toMatchObject({ status: 'unknown', revision: running.revision + 1, failureCode: 'interrupted' })
      expect(() => target.store.claimSourceJob({ id: queued.id, revision: unknown.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-2' })).toThrow(/CAS/)
      const failed = target.store.settleSourceJob({ id: queued.id, revision: unknown.revision, status: 'failed', failureCode: 'reconciled' })
      expect(failed.status).toBe('failed')
    } finally { target.store.close() }
  })

  it('atomically turns a running job into a prepared source plan and rejects intent drift', async () => {
    const target = await fixture()
    try {
      const gap = target.store.recordGap({ idempotencyKey: 'gap:job', capability: 'health', context: 'job', expectedValue: 10, frequency: 2, estimatedCost: 1, risk: 0 })
      const sourceIntent = intent({ gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap) })
      const queued = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'source-job:one', intent: sourceIntent })
      const bound = target.store.bindSourceJobDefinition({ id: queued.id, revision: queued.revision, definitionHash: hex('definition') })
      const running = target.store.claimSourceJob({ id: queued.id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })
      expect(() => target.store.createSourcePlan(completionInput(gap.id, running, sourceIntent, { repository: '/different' }))).toThrow(/immutable running binding/)
      expect(sourcePlanCount(target.path)).toBe(0)
      expect(target.store.getGap(gap.id).status).toBe('open')
      expect(target.store.getSourceJob(queued.id)).toMatchObject({ status: 'running', revision: running.revision })
      const receipt = target.store.createSourcePlan(completionInput(gap.id, running, sourceIntent))
      expect(target.store.getSourceJob(queued.id)).toMatchObject({ status: 'prepared', planId: receipt.result.id })
      expect(receipt.result).toMatchObject({ mode: 'modify', sourceCheck: { treeDigest: hex('tree'), patchDigest: hex('patch') } })
      expect(target.store.getGap(gap.id).status).toBe('matched')
    } finally { target.store.close() }
  })

  it('rejects create completion, ttl drift, stale hash/CAS, with no plan claim or job settlement', async () => {
    const target = await fixture()
    try {
      const gap = target.store.recordGap({ idempotencyKey: 'gap:completion-errors', capability: 'health', context: 'job', expectedValue: 10, frequency: 2, estimatedCost: 1, risk: 0 })
      const source = intent({ gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap) })
      const queued = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'source-job:errors', intent: source })
      expect(() => target.store.claimSourceJob({ id: queued.id, revision: queued.revision, definitionHash: hex('wrong'), occurrenceId: 'occurrence-1' })).toThrow(/CAS/)
      const bound = target.store.bindSourceJobDefinition({ id: queued.id, revision: queued.revision, definitionHash: hex('definition') })
      expect(() => target.store.claimSourceJob({ id: queued.id, revision: bound.revision - 1, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })).toThrow(/CAS/)
      const running = target.store.claimSourceJob({ id: queued.id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })
      const base = completionInput(gap.id, running, source)
      expect(() => target.store.createSourcePlan({ ...base, mode: 'create' as const })).toThrow(/only complete checked modify/)
      expect(() => target.store.createSourcePlan({ ...base, ttlMs: source.ttlMs + 1 })).toThrow(/immutable running binding/)
      expect(sourcePlanCount(target.path)).toBe(0)
      expect(target.store.getGap(gap.id).status).toBe('open')
      expect(target.store.getSourceJob(queued.id)).toMatchObject({ status: 'running', revision: running.revision })
    } finally { target.store.close() }
  })

  it('keeps unknown as the global outstanding slot and rejects authority mutation or quota writes atomically', async () => {
    const target = await fixture()
    try {
      const first = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'source-job:one', intent: intent() })
      const bound = target.store.bindSourceJobDefinition({ id: first.id, revision: first.revision, definitionHash: hex('definition') })
      target.store.claimSourceJob({ id: first.id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })
      target.store.interruptSourceJobs()
      const otherAuthority = { ...intent().authority, digest: hex('other-authority'), maxSubmissions: 1 }
      expect(() => target.store.enqueueSourceJob({ id: jobId('e'), automationId: jobId('e'), idempotencyKey: 'source-job:other', intent: intent({ authority: otherAuthority }, 'e') })).toThrow()
      const unknown = target.store.getSourceJob(first.id)!
      target.store.settleSourceJob({ id: first.id, revision: unknown.revision, status: 'failed', failureCode: 'reconciled' })
      expect(() => target.store.enqueueSourceJob({ id: jobId('e'), automationId: jobId('e'), idempotencyKey: 'source-job:mutation',
        intent: intent({ authority: { ...intent().authority, digest: hex('changed') } }, 'e') })).toThrow(/immutable/)

      const quotaAuthority = { ...intent().authority, id: 'authority-quota', digest: hex('quota'), maxSubmissions: 1 }
      const quota = target.store.enqueueSourceJob({ id: jobId('e'), automationId: jobId('e'), idempotencyKey: 'source-job:quota-one', intent: intent({ authority: quotaAuthority }, 'e') })
      target.store.settleSourceJob({ id: quota.id, revision: quota.revision, status: 'failed', failureCode: 'rejected' })
      expect(() => target.store.enqueueSourceJob({ id: jobId('f'), automationId: jobId('f'), idempotencyKey: 'source-job:quota-two', intent: intent({ authority: quotaAuthority }, 'f') })).toThrow(/quota/)
      expect(target.store.getSourceJobByAutomation(jobId('f'))).toBeUndefined()
      expect(target.store.listSourceJobs(100).filter(job => job.intent.authority.id === quotaAuthority.id)).toHaveLength(1)
    } finally { target.store.close() }
  })

  it('rejects authority work exactly at its expiry boundary without changing the queued job', async () => {
    const target = await fixture()
    try {
      const expiry = target.now() + 1
      const source = intent({ authority: { ...intent().authority, expiresAt: expiry } })
      const queued = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'source-job:expiry', intent: source })
      target.setNow(expiry)
      expect(() => target.store.bindSourceJobDefinition({ id: queued.id, revision: queued.revision, definitionHash: hex('definition') })).toThrow(/CAS/)
      expect(target.store.getSourceJob(queued.id)).toMatchObject({ status: 'queued', revision: queued.revision })
    } finally { target.store.close() }
  })

  it('migrates a genuine v13 database to the v14 source-job ledger', async () => {
    const target = await fixture()
    target.store.close()
    const old = new DatabaseSync(target.path)
    try {
      old.exec(`DROP INDEX source_jobs_created; DROP INDEX source_jobs_single_active; DROP TABLE source_jobs; DROP TABLE source_job_authorities; PRAGMA user_version = 13;`)
    } finally { old.close() }
    const migrated = openControlPlaneDatabase(target.path)
    try {
      expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_jobs'").get()).toEqual({ name: 'source_jobs' })
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { migrated.close() }
  })
})
