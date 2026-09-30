import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import type { OwnerTaskFailureReference } from '../src/owner-task-gap-types.ts'
import { controlPlaneSchemaVersion } from '../src/sqlite.ts'
import { gcPreparedModifyWorktrees } from '../src/source-workspace.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import type { CreateSourcePlanInput } from '../src/store.ts'
import type { SourceJobIntent } from '../src/source-job-types.ts'
import { sourceGrowthRunFixture } from './helpers/source-growth-run-fixture.ts'

const roots: string[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const NOW = 1_800_000_000_000
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function reference(): OwnerTaskFailureReference {
  return { schemaVersion: 1, owner: { receiptVersion: 2, authorityId: 'owner-authority', authorityHash: sha('owner-authority'),
    principalId: 'lark/bot/tenant/owner', principalRecordId: 'principal-record', principalVersion: 1,
    workspace: '/workspace', agentPreset: 'primary', bindingVersion: 1, generation: 1 },
  outcomeId: 'outcome-created-artifact', projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox-created-artifact',
    version: 1, digest: sha('projection'), disposition: 'upsert', evidenceOutcomeId: 'evidence-outcome' }, sourceDigest: sha('source') }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-source-artifact-')); roots.push(root)
  const path = join(root, 'state.sqlite')
  let clock = NOW
  const store = new ControlPlaneStore({ path, now: () => clock })
  return { root, path, store, now: () => clock, setNow: (value: number) => { clock = value } }
}

function sourceIntent(gap: ReturnType<ControlPlaneStore['recordOwnerTaskFailureGap']>, ownerReference: OwnerTaskFailureReference, suffix = 'd',
  git?: { repository: string; worktree: string; baseCommit: string }): SourceJobIntent {
  const id = `source-job-${suffix.repeat(64)}`
  const owner = ownerReference.owner
  // Store-level artifact fixture: this frozen run is synthetic, not proof of a native Growth producer.
  const creation = { grant: { id: 'artifact-grant', expiresAt: NOW + 180_000, maxCreates: 10, namePrefix: 'new-' },
    generatorDigest: sha('generator'), growthRun: sourceGrowthRunFixture(ownerReference, NOW) }
  return { mode: 'create', creation, authority: { id: 'artifact-authority', digest: sha('authority'),
    expiresAt: NOW + 180_000, maxSubmissions: 10 }, owner, ownerDigest: controlPlaneDigest(owner), trustDigest: sha('trust'),
  repository: git?.repository ?? '/repository', name: 'new-helper', gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap),
  baseCommit: git?.baseCommit ?? 'a'.repeat(40), files: [{ path: 'src/index.ts', content: 'export {}\n' }], ttlMs: 60_000,
  build: { dockerPath: '/usr/bin/docker', image: `example@sha256:${'b'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
  worktree: git?.worktree ?? `/worktree/worktree-job-${suffix.repeat(64)}`, containerName: `dsh-${id}` }
}

function preparedInput(source: SourceJobIntent, jobId: string, revision: number, bytes: Buffer): CreateSourcePlanInput {
  return { gapId: source.gapId, repository: source.repository, worktree: source.worktree, baseCommit: source.baseCommit,
    name: source.name, generatorDigest: source.creation!.generatorDigest, mode: 'prepared-create', creation: source.creation!,
    scope: ['plugins/README.md', 'plugins/new-helper', 'pnpm-lock.yaml'], ttlMs: source.ttlMs, idempotencyKey: 'artifact-plan',
    sourceJob: { jobId, jobRevision: revision, occurrenceId: 'occurrence-1' }, preparedArtifact: bytes,
    prepared: { treeDigest: sha('tree'), patchDigest: sha('patch'), checkedAt: NOW + 1,
      evidence: { schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
        environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v22', pnpmVersion: '11.7.0' },
        commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 1, logDigest: sha('log') }],
        pack: { name: 'new-helper-0.1.0.tgz', version: '0.1.0', sizeBytes: bytes.length, sha256: sha(bytes) }, preparedAt: NOW + 1 } } }
}

function queueRunning(store: ControlPlaneStore, suffix = 'd', git?: { repository: string; worktree: string; baseCommit: string },
  outcomeId = reference().outcomeId) {
  const ownerReference = { ...reference(), outcomeId }
  const gap = store.recordOwnerTaskFailureGap(ownerReference)
  const source = sourceIntent(gap, ownerReference, suffix, git)
  const id = `source-job-${suffix.repeat(64)}`
  return store.withOwnerTaskFailureGapAdmission(gap.id, () => {
    const queued = store.enqueueSourceJob({ id, automationId: id, idempotencyKey: `artifact:${suffix}`, intent: source })
    const bound = store.bindSourceJobDefinition({ id, revision: queued.revision, definitionHash: sha('definition') })
    const running = store.claimSourceJob({ id, revision: bound.revision, definitionHash: sha('definition'), occurrenceId: 'occurrence-1' })
    return { gap, source, running }
  })
}

test('persists exact package bytes and frozen job across connections, with Host admission and corruption rejection', async () => {
  const target = await fixture()
  try {
    const { gap, source, running } = queueRunning(target.store)
    const bytes = Buffer.from('checked-created-package')
    const input = preparedInput(source, running.id, running.revision, bytes)
    expect(() => target.store.createSourcePlan(input)).toThrow(/admission/)
    const receipt = target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.createSourcePlan(input))
    const planId = receipt.result.id
    expect(() => target.store.getPreparedSourceJob(planId)).toThrow(/admission/)
    expect(() => target.store.readPreparedSourceArtifact(planId)).toThrow(/admission/)
    expect(target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.getPreparedSourceJob(planId)))
      .toMatchObject({ status: 'prepared', intent: { mode: 'create', creation: source.creation }, planId })
    const received = target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.readPreparedSourceArtifact(planId))
    expect(received).toEqual(bytes)
    received.fill(0)
    expect(target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.readPreparedSourceArtifact(planId))).toEqual(bytes)
    const other = target.store.recordOwnerTaskFailureGap({ ...reference(), outcomeId: 'other-outcome' })
    expect(() => target.store.withOwnerTaskFailureGapAdmission(other.id, () => target.store.readPreparedSourceArtifact(planId)))
      .toThrow(/admission/)
    expect(target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.createSourcePlan(input))).toEqual(receipt)
    target.store.close()
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
    try {
      expect(reopened.withOwnerTaskFailureGapAdmission(gap.id, () => reopened.readPreparedSourceArtifact(planId))).toEqual(bytes)
      const db = new DatabaseSync(target.path)
      try {
        const previous = db.prepare('SELECT intent_json, intent_digest FROM source_jobs WHERE plan_id = ?').get(planId) as {
          intent_json: string; intent_digest: string
        }
        const changed = { ...(JSON.parse(previous.intent_json) as SourceJobIntent), name: 'new-other' }
        db.prepare('UPDATE source_jobs SET intent_json = ?, intent_digest = ? WHERE plan_id = ?')
          .run(JSON.stringify(changed), controlPlaneDigest(changed), planId)
        expect(() => reopened.withOwnerTaskFailureGapAdmission(gap.id, () => reopened.getPreparedSourceJob(planId))).toThrow(/binding/)
        db.prepare('UPDATE source_jobs SET intent_json = ?, intent_digest = ? WHERE plan_id = ?')
          .run(previous.intent_json, previous.intent_digest, planId)
        db.prepare('UPDATE source_prepared_artifacts SET bytes = ? WHERE pack_sha256 = ?').run(Buffer.alloc(bytes.length), sha(bytes))
      }
      finally { db.close() }
      expect(() => reopened.withOwnerTaskFailureGapAdmission(gap.id, () => reopened.readPreparedSourceArtifact(planId))).toThrow(/corrupt/)
      expect(() => reopened.withOwnerTaskFailureGapAdmission(gap.id, () => reopened.createSourcePlan(input))).toThrow(/corrupt/)
    } finally { reopened.close() }
  } finally { try { target.store.close() } catch {} }
})

test('rejects wrong bytes and exhausted count quota atomically before plan or job settlement', async () => {
  const target = await fixture()
  try {
    const { gap, source, running } = queueRunning(target.store)
    const bytes = Buffer.from('checked-created-package')
    const input = preparedInput(source, running.id, running.revision, bytes)
    const wrong = Buffer.from(bytes); wrong[0] = wrong[0]! ^ 1
    expect(() => target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.createSourcePlan({ ...input, preparedArtifact: wrong })))
      .toThrow(/differs/)
    const db = new DatabaseSync(target.path)
    try {
      const insert = db.prepare('INSERT INTO source_prepared_artifacts (pack_sha256, size_bytes, bytes, created_at) VALUES (?, 1, ?, ?)')
      for (let index = 0; index < 256; index++) insert.run(sha(`prior-${index}`), Buffer.from([index % 256]), NOW)
    } finally { db.close() }
    expect(() => target.store.withOwnerTaskFailureGapAdmission(gap.id, () => target.store.createSourcePlan(input))).toThrow(/quota/)
    const inspect = new DatabaseSync(target.path)
    try {
      expect(inspect.prepare('SELECT count(*) AS count FROM source_plans').get()).toEqual({ count: 0 })
      expect(inspect.prepare('SELECT count(*) AS count FROM source_prepared_artifacts').get()).toEqual({ count: 256 })
    } finally { inspect.close() }
    expect(target.store.getSourceJob(running.id)).toMatchObject({ status: 'running', revision: running.revision })
    expect(target.store.getGap(gap.id).status).toBe('open')
  } finally { target.store.close() }
})

test('does not grant a historical uncaptured plan access to another plan with the same package SHA', async () => {
  const target = await fixture()
  try {
    const bytes = Buffer.from('same-checked-package')
    const first = queueRunning(target.store)
    const oldInput = preparedInput(first.source, first.running.id, first.running.revision, bytes)
    delete oldInput.preparedArtifact
    const oldPlan = target.store.withOwnerTaskFailureGapAdmission(first.gap.id, () =>
      target.store.createSourcePlan(oldInput)).result
    const second = queueRunning(target.store, 'e', undefined, 'other-outcome')
    const newPlan = target.store.withOwnerTaskFailureGapAdmission(second.gap.id, () =>
      target.store.createSourcePlan({ ...preparedInput(second.source, second.running.id, second.running.revision, bytes),
        idempotencyKey: 'artifact-plan-second' })).result
    expect(target.store.withOwnerTaskFailureGapAdmission(second.gap.id, () => target.store.readPreparedSourceArtifact(newPlan.id)))
      .toEqual(bytes)
    expect(() => target.store.withOwnerTaskFailureGapAdmission(first.gap.id, () => target.store.readPreparedSourceArtifact(oldPlan.id)))
      .toThrow(/reference is missing/)
    const db = new DatabaseSync(target.path)
    try {
      expect(db.prepare('SELECT plan_id, pack_sha256 FROM source_prepared_artifact_refs').all())
        .toEqual([{ plan_id: newPlan.id, pack_sha256: sha(bytes) }])
    } finally { db.close() }
  } finally { target.store.close() }
})

test('enforces the aggregate 128 MiB cap inside the same plan transaction', async () => {
  const target = await fixture()
  try {
    const { gap, source, running } = queueRunning(target.store)
    const bytes = Buffer.from('checked-created-package')
    const db = new DatabaseSync(target.path)
    try {
      const insert = db.prepare(`INSERT INTO source_prepared_artifacts (pack_sha256, size_bytes, bytes, created_at)
        VALUES (?, 33554432, zeroblob(33554432), ?)`)
      for (let index = 0; index < 4; index++) insert.run(sha(`full-${index}`), NOW)
    } finally { db.close() }
    expect(() => target.store.withOwnerTaskFailureGapAdmission(gap.id, () =>
      target.store.createSourcePlan(preparedInput(source, running.id, running.revision, bytes)))).toThrow(/quota/)
    expect(target.store.getSourceJob(running.id)).toMatchObject({ status: 'running', revision: running.revision })
    expect(target.store.getGap(gap.id).status).toBe('open')
    const inspect = new DatabaseSync(target.path)
    try {
      expect(inspect.prepare('SELECT count(*) AS count, sum(size_bytes) AS total FROM source_prepared_artifacts').get())
        .toEqual({ count: 4, total: 128 * 1024 * 1024 })
      expect(inspect.prepare('SELECT count(*) AS count FROM source_plans').get()).toEqual({ count: 0 })
    } finally { inspect.close() }
  } finally { target.store.close() }
})

test('migrates a v29 ledger without changing old receipts and keeps expired package cleanup bounded', async () => {
  const target = await fixture()
  const oldGap = target.store.recordGap({ idempotencyKey: 'old-gap', capability: 'legacy', context: 'legacy',
    expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  const oldReceipt = target.store.createSourcePlan({ gapId: oldGap.id, repository: '/repository', worktree: '/worktree',
    baseCommit: 'a'.repeat(40), name: 'legacy-helper', generatorDigest: sha('legacy'),
    scope: ['plugins/README.md', 'plugins/legacy-helper'], ttlMs: 60_000, idempotencyKey: 'old-source-plan' })
  target.store.close()
  const old = new DatabaseSync(target.path)
  try { old.exec('DROP TABLE source_prepared_artifact_refs; DROP TABLE source_prepared_artifacts; PRAGMA user_version = 29') }
  finally { old.close() }
  const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
  try {
    expect(reopened.getSourcePlan(oldReceipt.result.id)).toEqual(oldReceipt.result)
    expect(reopened.createSourcePlan({ gapId: oldGap.id, repository: '/repository', worktree: '/worktree',
      baseCommit: 'a'.repeat(40), name: 'legacy-helper', generatorDigest: sha('legacy'),
      scope: ['plugins/README.md', 'plugins/legacy-helper'], ttlMs: 60_000, idempotencyKey: 'old-source-plan' })).toEqual(oldReceipt)
    const db = new DatabaseSync(target.path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: controlPlaneSchemaVersion })
      expect(db.prepare('PRAGMA table_list').all()).toContainEqual(expect.objectContaining({ name: 'source_prepared_artifacts', strict: 1 }))
      expect(db.prepare('PRAGMA table_list').all()).toContainEqual(expect.objectContaining({ name: 'source_prepared_artifact_refs', strict: 1 }))
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { db.close() }
    const repository = join(target.root, 'repository')
    const statePath = join(target.root, 'state')
    const worktree = join(statePath, 'source-worktrees', `worktree-job-${'d'.repeat(64)}`)
    await mkdir(repository)
    await mkdir(join(statePath, 'source-worktrees'), { recursive: true, mode: 0o700 })
    execFileSync('git', ['init', '-q', repository])
    await writeFile(join(repository, 'README.md'), 'fixture\n')
    execFileSync('git', ['-C', repository, 'add', 'README.md'])
    execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'])
    const baseCommit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['-C', repository, 'worktree', 'add', '--detach', worktree, baseCommit])
    const { gap, source, running } = queueRunning(reopened, 'd', { repository, worktree, baseCommit })
    const bytes = Buffer.from('checked-created-package')
    const plan = reopened.withOwnerTaskFailureGapAdmission(gap.id, () => reopened.createSourcePlan(preparedInput(source, running.id, running.revision, bytes))).result
    expect(reopened.deleteExpiredPreparedSourceArtifacts(target.now())).toBe(0)
    target.setNow(plan.expiresAt + 1)
    expect(await gcPreparedModifyWorktrees({ store: reopened, statePath, environment: process.env, now: target.now() }))
      .toEqual({ removed: [worktree] })
    const artifactDatabase = new DatabaseSync(target.path)
    try {
      expect(artifactDatabase.prepare('SELECT count(*) AS count FROM source_prepared_artifacts').get()).toEqual({ count: 0 })
      expect(artifactDatabase.prepare('SELECT count(*) AS count FROM source_prepared_artifact_refs').get()).toEqual({ count: 0 })
    }
    finally { artifactDatabase.close() }
    expect(reopened.deleteExpiredPreparedSourceArtifacts(target.now())).toBe(0)
    expect(() => reopened.withOwnerTaskFailureGapAdmission(gap.id, () => reopened.readPreparedSourceArtifact(plan.id))).toThrow()
    expect(reopened.getSourcePlan(plan.id).status).toBe('expired')
  } finally { reopened.close() }
})

test('rejects a v29 ledger with an unexpected preexisting artifact schema', async () => {
  const target = await fixture()
  target.store.close()
  const db = new DatabaseSync(target.path)
  try {
    db.exec(`DROP TABLE source_prepared_artifact_refs; DROP TABLE source_prepared_artifacts;
      CREATE TABLE source_prepared_artifacts (pack_sha256 TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 29`)
  } finally { db.close() }
  expect(() => new ControlPlaneStore({ path: target.path, now: target.now })).toThrow(/unknown v29 prepared artifact schema/)
  const inspect = new DatabaseSync(target.path)
  try { expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: 29 }) }
  finally { inspect.close() }
})

test('accepts exact current artifact tables retained by a synthetic v29 downgrade', async () => {
  const target = await fixture()
  const gap = target.store.recordGap({ idempotencyKey: 'retained-schema-gap', capability: 'legacy', context: 'migration',
    expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  target.store.close()
  const db = new DatabaseSync(target.path)
  try { db.exec('PRAGMA user_version = 29') } finally { db.close() }
  const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
  try {
    expect(reopened.getGap(gap.id)).toEqual(gap)
    const inspect = new DatabaseSync(target.path)
    try {
      expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: controlPlaneSchemaVersion })
      expect(inspect.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { inspect.close() }
  } finally { reopened.close() }
})

test('rejects a retained artifact reference table with a changed foreign key', async () => {
  const target = await fixture()
  target.store.close()
  const db = new DatabaseSync(target.path)
  try {
    db.exec(`DROP TABLE source_prepared_artifact_refs;
      CREATE TABLE source_prepared_artifact_refs (
        plan_id TEXT PRIMARY KEY REFERENCES source_plans(id) ON DELETE RESTRICT,
        pack_sha256 TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      PRAGMA user_version = 29`)
  } finally { db.close() }
  expect(() => new ControlPlaneStore({ path: target.path, now: target.now })).toThrow(/unknown v29 prepared artifact schema/)
})
