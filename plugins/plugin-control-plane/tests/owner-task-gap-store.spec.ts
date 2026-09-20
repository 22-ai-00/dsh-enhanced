import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { exampleIntegrityPinnedCatalog } from '../src/catalog.ts'
import type { OwnerTaskFailureReference } from '../src/owner-task-gap-types.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { ControlPlaneStore, ControlPlaneStoreError, controlPlaneDigest } from '../src/store.ts'
import type { SourceJobIntent } from '../src/source-job-types.ts'

const roots: string[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const candidate = exampleIntegrityPinnedCatalog.entries.find(entry => entry.id === 'assistant-health')!

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-owner-task-gap-')); roots.push(root)
  const path = join(root, 'state.sqlite')
  return { root, path, store: new ControlPlaneStore({ path, now: () => 1_800_000_000_000 }) }
}

function reference(overrides: Partial<OwnerTaskFailureReference> = {}): OwnerTaskFailureReference {
  const owner = { receiptVersion: 2 as const, authorityId: 'owner-authority', authorityHash: digest('owner-authority'),
    principalId: 'lark/bot/tenant/owner', principalRecordId: 'principal-record', principalVersion: 1,
    workspace: '/workspace', agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  return { schemaVersion: 1, owner, outcomeId: 'outcome-foreground', projection: { subjectKind: 'foreground-turn',
    subjectRef: 'inbox-foreground', version: 1, digest: digest('projection'), disposition: 'upsert', evidenceOutcomeId: 'evidence-outcome' },
  sourceDigest: digest('source'), ...overrides }
}

function sourceIntent(gapId: string, gapRevision: number, gapDigest: string): SourceJobIntent {
  const owner = reference().owner
  return { authority: { id: 'source-authority', digest: digest('source-authority'), expiresAt: 1_800_000_060_000, maxSubmissions: 1 },
    owner, ownerDigest: controlPlaneDigest(owner), trustDigest: digest('trust'), repository: '/repository', name: 'owner-repair',
    gapId, gapRevision, gapDigest, baseCommit: 'a'.repeat(40), files: [{ path: 'src/index.ts', content: 'export {}\n' }], ttlMs: 60_000,
    build: { dockerPath: '/usr/bin/docker', image: `example@sha256:${'b'.repeat(64)}`, timeoutMs: 60_000, memoryMiB: 128,
      cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
    worktree: `/worktree/worktree-job-${'d'.repeat(64)}`, containerName: `dsh-source-job-${'d'.repeat(64)}` }
}

function sourcePlanInput(gapId: string) {
  return { gapId, repository: '/repository', worktree: '/worktree', baseCommit: 'a'.repeat(40), name: 'owner-repair',
    generatorDigest: digest('generator'), scope: ['plugins/README.md', 'plugins/owner-repair'], ttlMs: 60_000, idempotencyKey: 'owner-task-source-plan' }
}

describe('owner task failure gaps', () => {
  it('does not downgrade a missing or swapped private sidecar to a legacy gap', async () => {
    const target = await fixture()
    try {
      const first = target.store.recordOwnerTaskFailureGap(reference())
      const second = target.store.recordOwnerTaskFailureGap(reference({ outcomeId: 'other-outcome' }))
      const db = new DatabaseSync(target.path)
      try {
        db.prepare('UPDATE owner_task_failure_gaps SET reference_json = (SELECT reference_json FROM owner_task_failure_gaps WHERE gap_id = ?), reference_digest = (SELECT reference_digest FROM owner_task_failure_gaps WHERE gap_id = ?) WHERE gap_id = ?').run(second.id, second.id, first.id)
        expect(() => target.store.getOwnerTaskFailureReference(first.id)).toThrow('identity is corrupt')
        db.prepare('DELETE FROM owner_task_failure_gaps WHERE gap_id = ?').run(first.id)
        expect(() => target.store.getOwnerTaskFailureReference(first.id)).toThrow('sidecar is missing')
        expect(() => target.store.createSourcePlan(sourcePlanInput(first.id))).toThrow('sidecar is missing')
        expect(target.store.listGaps()).toEqual([])
      } finally { db.close() }
    } finally { target.store.close() }
  })

  it('atomically stores a private owner reference, is idempotent across restart, and excludes it globally', async () => {
    const target = await fixture()
    const legacy = target.store.recordGap({ idempotencyKey: 'gap:legacy', capability: 'legacy', context: 'legacy', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    const value = reference()
    const first = target.store.recordOwnerTaskFailureGap(value)
    expect(target.store.recordOwnerTaskFailureGap(value)).toEqual(first)
    expect(first).toMatchObject({ capability: 'foreground-task-repair', expectedValue: 0, frequency: 1, estimatedCost: 1, risk: 1, roi: 0 })
    expect(target.store.listGaps()).toEqual([legacy])
    expect(target.store.getOwnerTaskFailureReference(first.id)).toEqual(value)
    target.store.close()
    const reopened = new ControlPlaneStore({ path: target.path, now: () => 1_800_000_000_000 })
    try {
      expect(reopened.recordOwnerTaskFailureGap(value)).toEqual(first)
      expect(reopened.getOwnerTaskFailureReference(first.id)).toEqual(value)
    } finally { reopened.close() }
  })

  it('rejects reserved generic keys and malformed private source references', async () => {
    const target = await fixture()
    try {
      expect(() => target.store.recordGap({ idempotencyKey: `owner-task-failure:${digest('forged')}`, capability: 'x', context: 'x', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 }))
        .toThrow(ControlPlaneStoreError)
      expect(() => target.store.recordOwnerTaskFailureGap({ ...reference(), projection: { ...reference().projection, disposition: 'retract' } } as never))
        .toThrow(ControlPlaneStoreError)
      expect(() => target.store.recordOwnerTaskFailureGap({ ...reference(), owner: { ...reference().owner, generation: 0 } } as never))
        .toThrow(ControlPlaneStoreError)
      expect(() => target.store.recordOwnerTaskFailureGap({ ...reference(), sourceDigest: 'not-a-digest' })).toThrow(ControlPlaneStoreError)
    } finally { target.store.close() }
  })

  it('requires a synchronous Host admission before a typed gap can create plans or source jobs', async () => {
    const target = await fixture()
    try {
      const gap = target.store.recordOwnerTaskFailureGap(reference())
      const source = sourcePlanInput(gap.id)
      const sourceJob = sourceIntent(gap.id, gap.revision, controlPlaneDigest(gap))
      const activation = { candidate, catalog: { digest: controlPlaneDigest(exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' as const },
        matchedCapabilities: candidate.capabilities, profile: 'web', target: { dshHome: target.root, profile: 'web', profilePath: join(target.root, 'profiles', 'web') },
        installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00', ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(target.root, 'ledger.sqlite') },
        executor: { id: 'dsh', version: '1', path: join(target.root, 'dsh'), sha256: 'c'.repeat(64) }, ttlMs: 60_000, gapId: gap.id, idempotencyKey: 'owner-task-activation' }
      expect(() => target.store.createSourcePlan(source)).toThrow(/admission/)
      expect(() => target.store.enqueueSourceJob({ id: `source-job-${'d'.repeat(64)}`, automationId: `source-job-${'d'.repeat(64)}`, idempotencyKey: 'owner-task-job', intent: sourceJob })).toThrow(/admission/)
      expect(() => target.store.createPlan(activation)).toThrow(/admission/)
      const created = target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.createSourcePlan(source))
      expect(created.result.gapId).toBe(gap.id)
      expect(() => target.store.createSourcePlan(source)).toThrow(/admission/)
      expect(() => target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.withOwnerTaskFailureGapAdmission(gap.id, () => undefined))).toThrow(/already active/)
      expect(() => target.store.withOwnerTaskFailureGapAdmission(gap.id, () => { throw new Error('fixture failure') })).toThrow('fixture failure')
      expect(() => target.store.withOwnerTaskFailureGapAdmission(gap.id, async () => undefined)).toThrow(/synchronous/)
      expect(() => target.store.withOwnerTaskFailureGapAdmission(gap.id, () => Promise.resolve())).toThrow(/synchronous/)
    } finally { target.store.close() }
  })

  it('migrates a genuine v15 ledger with foreign keys intact', async () => {
    const target = await fixture()
    const retained = target.store.recordGap({ idempotencyKey: 'gap:v15-retained', capability: 'legacy', context: 'retained', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    target.store.close()
    const legacy = new DatabaseSync(target.path)
    try { legacy.exec('DROP TABLE owner_task_failure_gaps; PRAGMA user_version = 15;') } finally { legacy.close() }
    const migrated = openControlPlaneDatabase(target.path)
    try {
      expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owner_task_failure_gaps'").get()).toEqual({ name: 'owner_task_failure_gaps' })
      expect(migrated.prepare('SELECT id, capability FROM capability_gaps WHERE id = ?').get(retained.id)).toEqual({ id: retained.id, capability: 'legacy' })
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { migrated.close() }
  })
})
