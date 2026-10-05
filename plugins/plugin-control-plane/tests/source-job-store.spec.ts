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

/** Rebuild the temporary fixture as an actual v28 table, preserving its rows. */
function downgradeSourcePlansToV28(path: string, invalidMode = false): void {
  const database = new DatabaseSync(path)
  try {
    const current = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'source_plans'").get() as { sql: string }
    const indexes = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'source_plans' AND sql IS NOT NULL").all() as Array<{ sql: string }>
    const columns = (database.prepare('PRAGMA table_info(source_plans)').all() as Array<{ name: string }>).map(row => row.name)
      .filter(name => name !== 'creation_json' && name !== 'revision_json').map(name => `"${name}"`).join(',')
    const old = current.sql
      .replace(/\s*revision_json TEXT CHECK\(revision_json IS NULL OR \(json_valid\(revision_json\) AND json_type\(revision_json\)='object'\)\),/u, '')
      .replace(/\s*CHECK\(\(mode = 'prepared-revise' AND revision_json IS NOT NULL\) OR \(mode IN \('create', 'modify', 'prepared-create'\) AND revision_json IS NULL\)\),/u, '')
      .replaceAll(", 'prepared-revise'", '')
      .replace(/^CREATE TABLE\s+"?source_plans"?/u, 'CREATE TABLE source_plans_v28')
      .replace("mode IN ('create', 'modify', 'prepared-create')", invalidMode
        ? "mode IN ('create', 'modify', 'unexpected')" : "mode IN ('create', 'modify')")
      .replace(/\s*creation_json TEXT CHECK\(creation_json IS NULL OR \(json_valid\(creation_json\) AND json_type\(creation_json\) = 'object'\)\),/u, '')
      .replace("mode IN ('modify', 'prepared-create') AND prepared_evidence_json IS NOT NULL", "mode = 'modify' AND prepared_evidence_json IS NOT NULL")
      .replace(/\s*CHECK\(\(mode = 'prepared-create' AND creation_json IS NOT NULL\) OR \(mode IN \('create', 'modify'\) AND creation_json IS NULL\)\),/u, '')
    if (old.includes('creation_json') || old.includes('revision_json') || !old.includes('CREATE TABLE source_plans_v28')) throw new Error('v28 fixture schema was not reconstructed')
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
    try {
      database.exec(`${old}; INSERT INTO source_plans_v28 (${columns}) SELECT ${columns} FROM source_plans;
        DROP TABLE source_plans; ALTER TABLE source_plans_v28 RENAME TO source_plans;
        DROP TABLE source_revision_sources; DROP TABLE source_revision_verifications; DROP TABLE source_revision_grants;
        DROP TABLE source_prepared_artifact_refs; DROP TABLE source_prepared_artifacts; DROP TABLE source_creation_grants;`)
      for (const index of indexes) database.exec(index.sql)
      if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('v28 fixture has invalid foreign keys')
      database.exec('PRAGMA user_version = 28; COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
    finally { database.exec('PRAGMA foreign_keys = ON') }
  } finally { database.close() }
}

describe('durable source job ledger', () => {
  it('upgrades a v31 ledger to a strict independent creation verification table', async () => {
    const target = await fixture()
    const gap = target.store.recordGap({ idempotencyKey: 'gap:v31', capability: 'health', context: 'migration',
      expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    target.store.close()
    const before = new DatabaseSync(target.path)
    try { before.exec('DROP TABLE source_creation_verifications; PRAGMA user_version = 31') }
    finally { before.close() }
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
    try {
      expect(reopened.getGap(gap.id)).toEqual(gap)
      expect(reopened.getCreationVerificationStatus('absent-plan')).toBeUndefined()
      const database = new DatabaseSync(target.path)
      try {
        expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: controlPlaneSchemaVersion })
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='source_creation_verifications'").get() as { sql: string }
        expect(schema.sql).toContain("status IN ('claimed','verified','unknown','rejected')")
        expect(() => database.prepare(`INSERT INTO source_creation_verifications
          (plan_id,status,certificate_json,certificate_digest,reason,created_at,updated_at)
          VALUES (?,'verified',NULL,NULL,NULL,?,?)`).run('absent-plan', target.now(), target.now())).toThrow()
      } finally { database.close() }
    } finally { reopened.close() }
  })

  it('migrates a v28 source row with its original digest and dependent receipts intact', async () => {
    const target = await fixture()
    const gap = target.store.recordGap({ idempotencyKey: 'gap:v28', capability: 'health', context: 'migration', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    const request = { gapId: gap.id, repository: '/repository', worktree: '/worktree', baseCommit: 'a'.repeat(40), name: 'health-helper',
      generatorDigest: hex('legacy-generator'), scope: ['plugins/README.md', 'plugins/health-helper'], ttlMs: 60_000,
      idempotencyKey: 'plan:v28' }
    const original = target.store.createSourcePlan(request)
    target.store.close()
    downgradeSourcePlansToV28(target.path)
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
    try {
      expect(reopened.getSourcePlan(original.result.id)).toEqual(original.result)
      expect(reopened.createSourcePlan(request)).toEqual(original)
      const database = new DatabaseSync(target.path)
      try {
        expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: controlPlaneSchemaVersion })
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        expect(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='source_creation_grants'").get()).toEqual({ name: 'source_creation_grants' })
      } finally { database.close() }
    } finally { reopened.close() }
  })

  it('rejects an unknown v28 mode constraint without partial migration', async () => {
    const target = await fixture()
    target.store.close()
    downgradeSourcePlansToV28(target.path, true)
    expect(() => openControlPlaneDatabase(target.path)).toThrow(/unknown v28 source plan schema/)
    const database = new DatabaseSync(target.path)
    try {
      expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 28 })
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='source_creation_grants'").get()).toBeUndefined()
    } finally { database.close() }
  })
  it('charges every accepted create attempt to one immutable grant across failure, restart and authority changes', async () => {
    const target = await fixture()
    const grant = { id: 'owner-create-grant', expiresAt: target.now() + 60_000, maxCreates: 1, namePrefix: 'new-' }
    const binding = { grant, generatorDigest: hex('fixed-generator') }
    const create = (character: string, authority = intent().authority, creation = binding) => ({
      id: jobId(character), automationId: jobId(character), idempotencyKey: `create:${character}`,
      intent: intent({ name: `new-${character}`, mode: 'create', creation, authority }, character),
    })
    try {
      const first = target.store.enqueueSourceJob(create('d'))
      expect(first.intent.creation).toEqual(binding)
      expect(target.store.enqueueSourceJob(create('d'))).toEqual(first)
      target.store.settleSourceJob({ id: first.id, revision: first.revision, status: 'failed', failureCode: 'failed-build' })
      expect(() => target.store.enqueueSourceJob(create('e'))).toThrow(/creation grant quota/)
      expect(() => target.store.enqueueSourceJob(create('e', { ...intent().authority, id: 'other-authority', digest: hex('other-authority') }))).toThrow(/creation grant quota/)
      expect(() => target.store.enqueueSourceJob(create('e', { ...intent().authority, id: 'other-authority', digest: hex('other-authority') },
        { ...binding, grant: { ...grant, maxCreates: 2 } }))).toThrow(/immutable/)
      target.store.close()
      const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
      try {
        expect(reopened.getSourceJob(first.id)?.intent.creation).toEqual(binding)
        expect(() => reopened.enqueueSourceJob(create('e'))).toThrow(/creation grant quota/)
        expect(() => reopened.enqueueSourceJob(create('e', { ...intent().authority, id: 'other-authority', digest: hex('other-authority') },
          { ...binding, grant: { ...grant, maxCreates: 2 } }))).toThrow(/immutable/)
        target.setNow(grant.expiresAt + 1)
        expect(reopened.getSourceJob(first.id)?.intent.creation).toEqual(binding)
      } finally { reopened.close() }
    } finally { try { target.store.close() } catch {} }
  })

  it('keeps an unknown create attempt charged until explicit reconciliation without automatic replay', async () => {
    const target = await fixture()
    try {
      const grant = { id: 'owner-create-unknown', expiresAt: target.now() + 60_000, maxCreates: 1, namePrefix: 'new-' }
      const source = intent({ mode: 'create', creation: { grant, generatorDigest: hex('generator') }, name: 'new-helper' })
      const queued = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'create:unknown', intent: source })
      const bound = target.store.bindSourceJobDefinition({ id: queued.id, revision: queued.revision, definitionHash: hex('definition') })
      target.store.claimSourceJob({ id: queued.id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })
      expect(target.store.interruptSourceJobs()).toBe(1)
      expect(target.store.getSourceJob(queued.id)).toMatchObject({ status: 'unknown', failureCode: 'interrupted' })
      expect(target.store.listPreparedSourcePlans()).toHaveLength(0)
      expect(() => target.store.expirePreparedSourcePlan({ planId: queued.id, expectedRevision: 1, now: target.now() + 60_001 })).toThrow()
      expect(() => target.store.enqueueSourceJob({ id: jobId('e'), automationId: jobId('e'), idempotencyKey: 'create:second',
        intent: intent({ mode: 'create', creation: source.creation!, name: 'new-other' }, 'e') })).toThrow()
      target.store.close()
      const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
      try {
        expect(reopened.interruptSourceJobs()).toBe(0)
        expect(reopened.getSourceJob(queued.id)?.status).toBe('unknown')
        const unknown = reopened.getSourceJob(queued.id)!
        reopened.settleSourceJob({ id: unknown.id, revision: unknown.revision, status: 'failed', failureCode: 'reconciled' })
        expect(() => reopened.enqueueSourceJob({ id: jobId('e'), automationId: jobId('e'), idempotencyKey: 'create:second',
          intent: intent({ mode: 'create', creation: source.creation!, name: 'new-other' }, 'e') })).toThrow(/creation grant quota/)
      } finally { reopened.close() }
    } finally { try { target.store.close() } catch {} }
  })

  it('refuses a queued create claim exactly at grant expiry and keeps its accepted charge', async () => {
    const target = await fixture()
    try {
      const grant = { id: 'owner-create-short', expiresAt: target.now() + 1, maxCreates: 1, namePrefix: 'new-' }
      const source = intent({ mode: 'create', creation: { grant, generatorDigest: hex('generator') }, name: 'new-helper' })
      const queued = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'create:short', intent: source })
      const bound = target.store.bindSourceJobDefinition({ id: queued.id, revision: queued.revision, definitionHash: hex('definition') })
      target.setNow(grant.expiresAt)
      expect(() => target.store.claimSourceJob({ id: queued.id, revision: bound.revision,
        definitionHash: hex('definition'), occurrenceId: 'late-occurrence' })).toThrow(/CAS/)
      expect(target.store.getSourceJob(queued.id)).toMatchObject({ status: 'queued', revision: bound.revision })
      target.store.settleSourceJob({ id: queued.id, revision: bound.revision, status: 'failed', failureCode: 'grant-expired' })
      const database = new DatabaseSync(target.path)
      try { expect(database.prepare('SELECT creates FROM source_creation_grants WHERE grant_id = ?').get(grant.id)).toEqual({ creates: 1 }) }
      finally { database.close() }
    } finally { target.store.close() }
  })

  it('commits a prepared create only with its running intent, exact scope and frozen evidence', async () => {
    const target = await fixture()
    try {
      const gap = target.store.recordGap({ idempotencyKey: 'gap:prepared-create', capability: 'new-capability', context: 'job', expectedValue: 10, frequency: 2, estimatedCost: 1, risk: 0 })
      const creation = { grant: { id: 'owner-create-grant', expiresAt: target.now() + 60_000, maxCreates: 1, namePrefix: 'new-' }, generatorDigest: hex('generator') }
      const source = intent({ mode: 'create', creation, name: 'new-helper', gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap) })
      const queued = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'create:prepared', intent: source })
      const bound = target.store.bindSourceJobDefinition({ id: queued.id, revision: queued.revision, definitionHash: hex('definition') })
      const running = target.store.claimSourceJob({ id: queued.id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })
      const request = { gapId: gap.id, repository: source.repository, worktree: source.worktree, baseCommit: source.baseCommit,
        name: source.name, generatorDigest: creation.generatorDigest, scope: ['plugins/new-helper', 'plugins/README.md', 'pnpm-lock.yaml'],
        mode: 'prepared-create' as const, creation, ttlMs: source.ttlMs, idempotencyKey: 'create:plan',
        sourceJob: { jobId: queued.id, jobRevision: running.revision, occurrenceId: 'occurrence-1' },
        prepared: { treeDigest: hex('tree'), patchDigest: hex('patch'), checkedAt: target.now() + 1, evidence: evidence() } }
      expect(() => target.store.createSourcePlan({ ...request, scope: ['plugins/new-helper', 'plugins/README.md'] })).toThrow(/scope/)
      expect(() => target.store.createSourcePlan({ ...request, creation: { ...creation, generatorDigest: hex('other') } })).toThrow(/binding/)
      expect(() => target.store.createSourcePlan({ ...request, sourceJob: undefined as never })).toThrow(/running source job/)
      expect(sourcePlanCount(target.path)).toBe(0)
      const receipt = target.store.createSourcePlan(request)
      expect(receipt.result).toMatchObject({ mode: 'prepared-create', status: 'pending-approval', creation, sourceCheck: { treeDigest: hex('tree') } })
      expect(target.store.getSourceJob(queued.id)).toMatchObject({ status: 'prepared', planId: receipt.result.id })
      expect(target.store.createSourcePlan(request)).toEqual(receipt)
      expect(target.store.listPreparedSourceApprovalJobs()).toHaveLength(0)
      const selectors = () => target.store.listPreparedSourceApprovalJobs(false, false, false, false, true).map(job => job.id)
      const verification = new DatabaseSync(target.path)
      try {
        // The selector requires the owner sidecar; this fixture exercises only its SQL state filter.
        verification.prepare('INSERT INTO owner_task_failure_gaps (gap_id,reference_json,reference_digest) VALUES (?, ?, ?)')
          .run(gap.id, '{}', hex('owner-reference'))
        verification.prepare(`INSERT INTO source_creation_verifications
          (plan_id,status,certificate_json,certificate_digest,reason,created_at,updated_at)
          VALUES (?,'claimed',NULL,NULL,NULL,?,?)`).run(receipt.result.id, target.now(), target.now())
        expect(selectors()).toEqual([])
        verification.prepare("UPDATE source_creation_verifications SET status='unknown',reason='unsettled' WHERE plan_id=?").run(receipt.result.id)
        expect(selectors()).toEqual([])
        verification.prepare("UPDATE source_creation_verifications SET status='rejected',reason='case-mismatch' WHERE plan_id=?").run(receipt.result.id)
        expect(selectors()).toEqual([])
        verification.prepare(`UPDATE source_creation_verifications SET status='verified',reason=NULL,certificate_json='{}',certificate_digest=?
          WHERE plan_id=?`).run(hex('certificate'), receipt.result.id)
        expect(selectors()).toEqual([queued.id])
        expect(target.store.listPreparedSourceApprovalJobs()).toEqual([])
        expect(target.store.listPreparedSourceApprovalJobs(false, false, false, true).map(job => job.id)).toEqual([])
      } finally { verification.close() }
      await expect(target.store.approveSource({ planId: receipt.result.id, expectedRevision: 1, receipt: {} as never,
        resolveAuthority: () => { throw new Error('must not call modify authority') }, idempotencyKey: 'create:approve' })).rejects.toThrow(/own owner creation authority/)
      expect(target.store.getSourcePlan(receipt.result.id).status).toBe('pending-approval')
      const database = new DatabaseSync(target.path)
      try { database.prepare('UPDATE source_plans SET creation_json = ? WHERE id = ?').run(JSON.stringify({ ...creation, unknown: true }), receipt.result.id) }
      finally { database.close() }
      expect(() => target.store.getSourcePlan(receipt.result.id)).toThrow(/creation binding is corrupt/)
    } finally { target.store.close() }
  })
  it('retires an expired prepared create and reopens its gap without refunding create quota', async () => {
    const target = await fixture()
    try {
      const gap = target.store.recordGap({ idempotencyKey: 'gap:create-expiry', capability: 'new-capability', context: 'expiry', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
      const creation = { grant: { id: 'owner-create-expiry', expiresAt: target.now() + 180_000, maxCreates: 1, namePrefix: 'new-' }, generatorDigest: hex('generator') }
      const source = intent({ mode: 'create', creation, name: 'new-helper', gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap) })
      const queued = target.store.enqueueSourceJob({ id: jobId(), automationId: jobId(), idempotencyKey: 'create:expiry', intent: source })
      const bound = target.store.bindSourceJobDefinition({ id: queued.id, revision: queued.revision, definitionHash: hex('definition') })
      const running = target.store.claimSourceJob({ id: queued.id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence-1' })
      const plan = target.store.createSourcePlan({ gapId: gap.id, repository: source.repository, worktree: source.worktree,
        baseCommit: source.baseCommit, name: source.name, generatorDigest: creation.generatorDigest,
        scope: ['plugins/README.md', 'plugins/new-helper', 'pnpm-lock.yaml'], mode: 'prepared-create', creation,
        ttlMs: source.ttlMs, idempotencyKey: 'create:expiry-plan',
        sourceJob: { jobId: queued.id, jobRevision: running.revision, occurrenceId: 'occurrence-1' },
        prepared: { treeDigest: hex('tree'), patchDigest: hex('patch'), checkedAt: target.now() + 1, evidence: evidence() } }).result
      expect(target.store.listModifySourcePlans()).toHaveLength(0)
      expect(target.store.listPreparedSourcePlans()).toMatchObject([{ id: plan.id }])
      target.setNow(plan.expiresAt + 1)
      expect(target.store.listPreparedSourcePlans({ expiredBefore: target.now() })).toMatchObject([{ id: plan.id }])
      const expired = target.store.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision, now: target.now() })
      expect(expired).toMatchObject({ mode: 'prepared-create', status: 'expired', revision: plan.revision + 1, digest: plan.digest })
      expect(target.store.getGap(gap.id).status).toBe('open')
      expect(target.store.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision, now: target.now() })).toEqual(expired)
      const secondAuthority = { ...source.authority, id: 'authority-after-expiry', digest: hex('authority-after-expiry'), expiresAt: target.now() + 60_000 }
      expect(() => target.store.enqueueSourceJob({ id: jobId('e'), automationId: jobId('e'), idempotencyKey: 'create:after-expiry',
        intent: intent({ mode: 'create', creation, name: 'new-other', authority: secondAuthority }, 'e') })).toThrow(/creation grant quota/)
      target.store.close()
      const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
      try {
        expect(reopened.getSourcePlan(plan.id)).toEqual(expired)
        expect(reopened.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision, now: target.now() })).toEqual(expired)
        expect(reopened.listPreparedSourcePlans({ expiredBefore: target.now() })).toMatchObject([{ id: plan.id, status: 'expired' }])
      } finally { reopened.close() }
    } finally { try { target.store.close() } catch {} }
  })

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
      const selectorDatabase = new DatabaseSync(target.path)
      try { selectorDatabase.prepare('INSERT INTO owner_task_failure_gaps (gap_id,reference_json,reference_digest) VALUES (?, ?, ?)')
        .run(gap.id, '{}', hex('owner-reference')) }
      finally { selectorDatabase.close() }
      expect(target.store.listPreparedSourceApprovalJobs().map(job => job.id)).toEqual([queued.id])
      expect(target.store.listPreparedSourceApprovalJobs(false, false, false, false, true).map(job => job.id)).toEqual([queued.id])
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
      old.exec(`DROP INDEX source_jobs_created; DROP INDEX source_jobs_single_active; DROP TABLE source_jobs;
        DROP TABLE source_job_authorities; DROP TABLE source_prepared_artifact_refs; DROP TABLE source_prepared_artifacts;
        PRAGMA user_version = 13;`)
    } finally { old.close() }
    const migrated = openControlPlaneDatabase(target.path)
    try {
      expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_jobs'").get()).toEqual({ name: 'source_jobs' })
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { migrated.close() }
  })
})
