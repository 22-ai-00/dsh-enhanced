import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as release from '../src/release.ts'
import { advanceSourceRelease } from '../src/source-release-runner.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST, controlPlaneDigest } from '../src/store.ts'
import type { SourceJobIntent } from '../src/source-job-types.ts'
import { cleanupReleaseFixtures, fixture as releaseFixture } from './helpers/source-release-runner.ts'
import { sourceBaselineRelease } from './helpers/source-baseline.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
const roots: string[] = []
afterEach(async () => {
  await cleanupReleaseFixtures()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const hex = (value: string) => createHash('sha256').update(value).digest('hex')

async function completeRelease() {
  const target = await releaseFixture(true)
  expect((await advanceSourceRelease(target.options)).status).toBe('awaiting-review')
  await target.decide()
  expect((await advanceSourceRelease(target.options)).status).toBe('release-complete')
  return target
}

describe('durable source baseline history', () => {
  it('retains two independently signed sequential releases in one Store history', async () => {
    const first = await sourceBaselineRelease({ repository: '/repository', baseCommit: 'a'.repeat(40), mergeCommit: '5'.repeat(40) })
    const second = await first.completeNext({ baseCommit: '5'.repeat(40), mergeCommit: '6'.repeat(40), managed: true })
    expect(first.store.getSourceBaselineHistory('/repository').map(({ plan, operation }) => ({
      planId: plan.id, base: plan.baseCommit, merged: operation.receipt?.evidence.kind === 'merge' ? operation.receipt.evidence.mergeCommit : undefined,
    }))).toEqual([{ planId: first.plan.id, base: 'a'.repeat(40), merged: '5'.repeat(40) },
      { planId: second.plan.id, base: '5'.repeat(40), merged: '6'.repeat(40) }])
    expect(first.trust.releaseKeys).toHaveLength(8)
  })

  it('does not start an unlinked release while a managed job owns the repository', async () => {
    const repository = '/repository'
    const first = await sourceBaselineRelease({ repository, baseCommit: 'a'.repeat(40), mergeCommit: '5'.repeat(40) })
    const id = `source-job-${'a'.repeat(64)}`
    first.store.enqueueSourceJob({ id, automationId: id, idempotencyKey: 'managed-after-release',
      intent: managedIntent(repository, 'a') })
    await expect(first.next({ baseCommit: '5'.repeat(40), mergeCommit: '6'.repeat(40) })).rejects.toThrow(/managed source job owns/u)
    expect(first.store.getSourceBaselineHistory(repository)).toHaveLength(1)
  })

  it('rejects a managed release based on the old commit after a completed merge', async () => {
    const first = await sourceBaselineRelease({ repository: '/repository', baseCommit: 'a'.repeat(40), mergeCommit: '5'.repeat(40) })
    await expect(first.next({ baseCommit: 'a'.repeat(40), mergeCommit: '6'.repeat(40), managed: true })).rejects.toThrow(/base commit is stale/u)
    expect(first.store.getSourceBaselineHistory('/repository')).toHaveLength(1)
  })

  it('returns exactly the applied, bound merge after completion even after receipt expiry', async () => {
    const target = await completeRelease()
    const original = target.store.getSourceBaselineHistory(target.root)
    expect(original).toHaveLength(1)
    expect(original[0]!.plan.id).toBe(target.plan.id)
    expect(original[0]!.operation).toMatchObject({ phase: 'merge', status: 'applied', receipt: { outcome: 'passed', evidence: { kind: 'merge' } } })
    const reopened = new ControlPlaneStore({ path: join(target.root, 'control.sqlite'), now: () => Date.now() + 86_400_000 })
    try { expect(reopened.getSourceBaselineHistory(target.root)).toEqual(original) } finally { reopened.close() }
  })

  it('rejects an in-flight release and a completed plan without its applied merge', async () => {
    const pending = await releaseFixture(true)
    expect(() => pending.store.getSourceBaselineHistory(pending.root)).toThrow(/unfinished release/u)
    const target = await completeRelease()
    const db = new DatabaseSync(join(target.root, 'control.sqlite'))
    try { db.prepare("UPDATE source_release_operations SET status = 'completed', applied_at = NULL WHERE plan_id = ? AND phase = 'merge'").run(target.plan.id) }
    finally { db.close() }
    expect(() => target.store.getSourceBaselineHistory(target.root)).toThrow(/lacks one applied merge/u)
  })

  it('rejects forged merge binding and a failed release with applied remote advancement', async () => {
    const target = await completeRelease()
    const path = join(target.root, 'control.sqlite')
    const db = new DatabaseSync(path)
    try {
      const saved = db.prepare("SELECT receipt_digest FROM source_release_operations WHERE plan_id = ? AND phase = 'merge'")
        .get(target.plan.id) as { receipt_digest: string }
      db.prepare("UPDATE source_release_operations SET receipt_digest = ? WHERE plan_id = ? AND phase = 'merge'").run(hex('forged'), target.plan.id)
      expect(() => target.store.getSourceBaselineHistory(target.root)).toThrow(/not bound|corrupt/u)
      db.prepare("UPDATE source_release_operations SET receipt_digest = ? WHERE plan_id = ? AND phase = 'merge'").run(saved.receipt_digest, target.plan.id)
      db.prepare("UPDATE source_plans SET status = 'release-failed' WHERE id = ?").run(target.plan.id)
    } finally { db.close() }
    expect(() => target.store.getSourceBaselineHistory(target.root)).toThrow(/unresolved applied remote merge/u)
  })
})

function managedIntent(repository: string, id: string, baseline = true): SourceJobIntent {
  const owner = { receiptVersion: 2 as const, authorityId: 'owner-authority', authorityHash: hex('owner'), principalId: 'owner',
    principalRecordId: 'principal-record', principalVersion: 1, workspace: 'workspace', agentPreset: 'preset', bindingVersion: 1, generation: 1 }
  return { authority: { id: 'authority-a', digest: hex('authority-a'), expiresAt: 1_900_000_000_000, maxSubmissions: 20 },
    owner, ownerDigest: controlPlaneDigest(owner), trustDigest: hex('trust'), repository, name: 'health-helper',
    gapId: 'gap-placeholder', gapRevision: 1, gapDigest: hex('gap'), baseCommit: 'a'.repeat(40),
    files: [{ path: 'src/index.ts', content: 'export {}\n' }], ttlMs: 60_000,
    build: { dockerPath: '/usr/bin/docker', image: `example@sha256:${'b'.repeat(64)}`, timeoutMs: 60_000, memoryMiB: 128,
      cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
    worktree: join(repository, `worktree-job-${id.repeat(64)}`), containerName: `dsh-source-job-${id.repeat(64)}`,
    ...(baseline ? { baseline: { ref: 'refs/dsh-source/health-helper', remote: join(repository, 'remote.git'),
      targetBranch: 'repairs', initialCommit: 'a'.repeat(40) } } : {}) }
}

describe('managed source job serialization', () => {
  it('keeps exact replay before the gate while blocking a second same-repository job; legacy jobs retain existing admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-baseline-store-')); roots.push(root)
    const store = new ControlPlaneStore({ path: join(root, 'control.sqlite') })
    try {
      const enqueue = (id: string, key: string, baseline = true) => store.enqueueSourceJob({ id: `source-job-${id.repeat(64)}`,
        automationId: `source-job-${id.repeat(64)}`, idempotencyKey: key, intent: managedIntent(root, id, baseline) })
      const first = enqueue('a', 'job-one')
      expect(enqueue('a', 'job-one')).toEqual(first)
      expect(() => enqueue('b', 'job-two')).toThrow(/already active/u)
      store.settleSourceJob({ id: first.id, revision: first.revision, status: 'failed', failureCode: 'rejected' })
      const legacy = enqueue('c', 'legacy', false)
      expect(legacy.status).toBe('queued')
      store.settleSourceJob({ id: legacy.id, revision: legacy.revision, status: 'failed', failureCode: 'rejected' })
      expect(enqueue('b', 'job-two')).toMatchObject({ status: 'queued' })
    } finally { store.close() }
  })

  it('keeps a prepared job exclusive until its real source plan reaches a terminal state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-baseline-prepared-')); roots.push(root)
    const store = new ControlPlaneStore({ path: join(root, 'control.sqlite') })
    try {
      const gap = store.recordGap({ idempotencyKey: 'baseline-gap', capability: 'health', context: 'repair',
        expectedValue: 10, frequency: 2, estimatedCost: 1, risk: 0 })
      const intent = { ...managedIntent(root, 'a'), gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap) }
      const id = `source-job-${'a'.repeat(64)}`
      const queued = store.enqueueSourceJob({ id, automationId: id, idempotencyKey: 'prepared-one', intent })
      const bound = store.bindSourceJobDefinition({ id, revision: queued.revision, definitionHash: hex('definition') })
      const running = store.claimSourceJob({ id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })
      const plan = store.createSourcePlan({ gapId: gap.id, repository: root, worktree: intent.worktree, baseCommit: intent.baseCommit,
        name: intent.name, generatorDigest: MODIFY_GENERATOR_DIGEST, scope: ['plugins/health-helper'], mode: 'modify',
        ttlMs: intent.ttlMs, idempotencyKey: 'prepared-plan', sourceJob: { jobId: id, jobRevision: running.revision, occurrenceId: 'occurrence-1' },
        prepared: { treeDigest: hex('tree'), patchDigest: hex('patch'), checkedAt: Date.now(),
          evidence: { schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
            environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'test', pnpmVersion: 'test' },
            commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 1, logDigest: hex('check') }],
            pack: { name: 'health-helper-0.1.0.tgz', version: '0.1.0', sizeBytes: 1, sha256: hex('pack') }, preparedAt: Date.now() } } }).result
      expect(store.getSourceJob(id)).toMatchObject({ status: 'prepared', planId: plan.id })
      const nextId = `source-job-${'b'.repeat(64)}`
      expect(() => store.enqueueSourceJob({ id: nextId, automationId: nextId, idempotencyKey: 'prepared-two',
        intent: managedIntent(root, 'b') })).toThrow(/awaiting a terminal source release/u)
      const db = new DatabaseSync(join(root, 'control.sqlite'))
      try { db.prepare("UPDATE source_plans SET status = 'expired' WHERE id = ?").run(plan.id) } finally { db.close() }
      expect(store.enqueueSourceJob({ id: nextId, automationId: nextId, idempotencyKey: 'prepared-two',
        intent: managedIntent(root, 'b') }).status).toBe('queued')
    } finally { store.close() }
  })
})
