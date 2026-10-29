import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Ed25519ApprovalAuthority } from '../src/approval.ts'
import { authorizePreparedSource, sourceAuthorityValidatePrepared, validateSourceApprovalAuthorityConfig, type SourceApprovalAuthorityConfig } from '../src/source-approval-authority.ts'
import { PREPARED_SOURCE_BUILD_SCRIPT } from '../src/source-build.ts'
import { checkedSourceSnapshot } from '../src/source-workspace.ts'
import { managedPatchVersionFiles } from '../src/source-versioning.ts'
import { controlPlaneDigest, ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../src/store.ts'
import type { SourceJobIntent, SourceJobRecord } from '../src/source-job-types.ts'
import type { OwnerTaskFailureReference } from '../src/owner-task-gap-types.ts'
import type { LinuxSourcePreparedEvidence, SourcePreparedEvidence } from '../src/types.ts'
import { linuxSourceConfig } from './helpers/linux-source-build-fixture.ts'

const execFile = promisify(execFileCallback)
const roots: string[] = []
const stores: ControlPlaneStore[] = []
const environment = { PATH: process.env.PATH!, LANG: 'C', LC_ALL: 'C' }
const hex = (character: string) => character.repeat(64)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile('/usr/bin/git', args, { cwd, env: environment })).stdout
}

function owner(suffix: string): OwnerTaskFailureReference {
  return { schemaVersion: 1, owner: { receiptVersion: 2, authorityId: 'owner-authority', authorityHash: hex('a'),
    principalId: `owner-${suffix}`, principalRecordId: `record-${suffix}`, principalVersion: 1, workspace: '/owner/workspace',
    agentPreset: 'default', bindingVersion: 1, generation: 1 }, outcomeId: `outcome-${suffix}`,
  projection: { subjectKind: 'foreground-turn', subjectRef: `turn-${suffix}`, version: 1, digest: hex('b'), disposition: 'upsert' }, sourceDigest: hex('c') }
}

const LINUX_PREPARED_CHECKS = ['source-archive-integrity', 'frozen-offline-install', 'repository-pnpm-check', 'source-input-recheck', 'package-integrity'] as const

function linuxEvidence(now: number, version: string): LinuxSourcePreparedEvidence {
  // Same durable evidence shape emitted by runLinuxPreparedChecks. The native
  // receipt binding was already verified by the prepare runner; the authority
  // only revalidates the immutable check sequence and frozen environment.
  return { schemaVersion: 3, kind: 'dsh-source-prepared-evidence', boundary: 'linux-native-repository-v1',
    runtimeDigest: digest('linux-runtime'), executionContractDigest: digest('linux-execution-contract'), buildScriptSha256: digest('linux-build-script'),
    archive: { sizeBytes: 10240, sha256: digest('linux-archive') },
    receipt: { requestDigest: digest('linux-request'), nativeNonce: 'b'.repeat(32), nativeResourceId: 'linux-11111111-1111-4111-8111-111111111111',
      intentDigest: digest('linux-intent'), resourcesDigest: digest('linux-resources'), receiptDigest: digest('linux-receipt') },
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v22.23.2', pnpmVersion: '11.7.0' },
    checks: [...LINUX_PREPARED_CHECKS],
    pack: { name: 'health-helper.tgz', version, sizeBytes: 1, sha256: digest('linux-pack') },
    logDigest: digest('linux-log'), durationMs: 1, preparedAt: now }
}

function evidence(now: number, backend: 'docker' | 'linux-native' = 'docker', version = '0.1.0'): SourcePreparedEvidence {
  if (backend === 'linux-native') return linuxEvidence(now, version)
  return { schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v24.0.0', pnpmVersion: '11.0.0' },
    // Same durable evidence shape emitted by runDockerPreparedChecks. This is
    // deliberately a fixture: the authority does not run a candidate Docker build.
    commands: [{ command: 'docker', args: ['run', '-i', '--pull', 'never', '--name', 'dsh-source-prepare-test', '--network', 'none',
      '--read-only', '--cap-drop', 'ALL', '--user', '65534:65534', '--env', 'PLUGIN_ROOT=plugins/health-helper',
      '--entrypoint', '/bin/sh', 'sha256:image', '-ceu', PREPARED_SOURCE_BUILD_SCRIPT], exitCode: 0, durationMs: 1, logDigest: hex('1') }],
    pack: { name: 'health-helper.tgz', version, sizeBytes: 1, sha256: hex('4') }, preparedAt: now }
}

async function fixture(beforePlan?: { path: string; content: string }, managedVersion = false, packagedVersion?: string,
  backend: 'docker' | 'linux-native' = 'docker') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'source-approval-authority-')); roots.push(root)
  const repository = join(root, 'repository'); await mkdir(join(repository, 'plugins', 'health-helper', 'src'), { recursive: true, mode: 0o700 })
  await git(repository, 'init', '-q'); await git(repository, 'config', 'user.email', 'tests@example.invalid'); await git(repository, 'config', 'user.name', 'Tests')
  await writeFile(join(repository, 'plugins', 'health-helper', 'src', 'tool.ts'), 'export const value = 1\n', { encoding: 'utf8', mode: 0o600 })
  await writeFile(join(repository, 'plugins', 'health-helper', 'package.json'), `${JSON.stringify({ name: '@dsh-enhanced/health-helper', version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: { build: 'tsc' } }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(repository, 'plugins', 'health-helper', 'src', 'version.ts'), "export const version = '0.1.0'\n", { mode: 0o600 })
  await git(repository, 'add', '.'); await git(repository, 'commit', '-qm', 'base')
  const baseCommit = (await git(repository, 'rev-parse', 'HEAD')).trim()
  // Native jobs pin the worktree basename to worktree-job-<job-id-digest>;
  // claimRunningJob derives the same token from suffix 'one' below.
  const worktreeRoot = join(root, 'worktrees')
  const worktreeToken = createHash('sha256').update('one').digest('hex')
  const worktree = join(worktreeRoot, backend === 'linux-native' ? `worktree-job-${worktreeToken}` : 'prepared')
  await mkdir(worktreeRoot, { mode: 0o700 }); await git(repository, 'worktree', 'add', '--detach', worktree, baseCommit)
  await chmod(worktree, 0o700)
  if (managedVersion) {
    const managed = await managedPatchVersionFiles({ worktree, baseCommit, name: 'health-helper', environment })
    for (const file of managed.files) await writeFile(join(worktree, 'plugins', 'health-helper', file.path), file.content, { mode: 0o600 })
  }
  const source = join(worktree, 'plugins', 'health-helper', 'src', 'tool.ts')
  await writeFile(source, 'export const value = 2\n', { encoding: 'utf8', mode: 0o600 })
  if (beforePlan !== undefined) await writeFile(join(worktree, beforePlan.path), beforePlan.content, { encoding: 'utf8', mode: 0o600 })
  const now = Date.now(); const databasePath = join(root, 'control.sqlite'); const store = new ControlPlaneStore({ path: databasePath, now: () => now }); stores.push(store)
  const key = generateKeyPairSync('ed25519'); const keyPath = join(root, 'authority.key')
  await writeFile(keyPath, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); await chmod(keyPath, 0o600)
  const reference = owner('one'); const gap = store.recordOwnerTaskFailureGap(reference)
  const snapshot = await checkedSourceSnapshot(worktree, baseCommit, ['plugins/health-helper'], environment)
  const packVersion = packagedVersion ?? (managedVersion ? '0.1.1' : '0.1.0')
  const checkedEvidence = evidence(now, backend, packVersion)
  // linux-native prepared plans must be bound to a running modify source job
  // whose immutable intent matches the plan exactly.
  const claimRunningJob = (targetGap: typeof gap, suffix: string): SourceJobRecord | undefined => {
    if (backend !== 'linux-native') return undefined
    const jobId = `source-job-${createHash('sha256').update(suffix).digest('hex')}`
    const intent: SourceJobIntent = {
      authority: { id: 'source-grant', digest: digest('source-grant'), expiresAt: now + 600_000, maxSubmissions: 2 },
      owner: { receiptVersion: 2, authorityId: reference.owner.authorityId, authorityHash: reference.owner.authorityHash,
        principalId: reference.owner.principalId, principalRecordId: reference.owner.principalRecordId,
        principalVersion: reference.owner.principalVersion, workspace: reference.owner.workspace,
        agentPreset: reference.owner.agentPreset, bindingVersion: reference.owner.bindingVersion, generation: reference.owner.generation },
      ownerDigest: controlPlaneDigest(reference.owner), trustDigest: digest('source-trust'),
      repository, name: 'health-helper', gapId: targetGap.id, gapRevision: targetGap.revision, gapDigest: controlPlaneDigest(targetGap),
      baseCommit, files: [{ path: 'plugins/health-helper/src/tool.ts', content: 'export const value = 2\n' }],
      ttlMs: 120_000, build: { ...linuxSourceConfig(), expiresAt: now + 600_000 },
      worktree, nativeResource: { backend: 'linux-native', key: jobId } }
    let running: SourceJobRecord | undefined
    store.withOwnerTaskFailureGapAdmission(targetGap.id, () => {
      const queued = store.enqueueSourceJob({ id: jobId, automationId: jobId, idempotencyKey: `linux-job-${suffix}`, intent })
      const bound = store.bindSourceJobDefinition({ id: jobId, revision: queued.revision, definitionHash: digest('definition') })
      running = store.claimSourceJob({ id: jobId, revision: bound.revision, definitionHash: digest('definition'), occurrenceId: 'occurrence' })
    })
    return running
  }
  const makePlan = (suffix: string, sourceReference = reference) => {
    const source = suffix === 'one' ? sourceReference : { ...sourceReference, outcomeId: `outcome-${suffix}`,
      projection: { ...sourceReference.projection, subjectRef: `turn-${suffix}` } }
    const targetGap = suffix === 'one' ? gap : store.recordOwnerTaskFailureGap(source)
    const runningJob = claimRunningJob(targetGap, suffix)
    const plan = store.withOwnerTaskFailureGapAdmission(targetGap.id, () => store.createSourcePlan({ gapId: targetGap.id, repository, worktree,
      baseCommit, name: 'health-helper', generatorDigest: MODIFY_GENERATOR_DIGEST, scope: ['plugins/health-helper'], mode: 'modify', ttlMs: 120_000,
      idempotencyKey: `source-authority-${suffix}`,
      ...(runningJob ? { sourceJob: { jobId: runningJob.id, jobRevision: runningJob.revision, occurrenceId: runningJob.occurrenceId! } } : {}),
      prepared: { treeDigest: snapshot.checkedTreeDigest, patchDigest: snapshot.checkedPatchDigest, checkedAt: now, evidence: checkedEvidence } }).result)
    return { plan, source }
  }
  const initial = makePlan('one'); const plan = initial.plan
  const config = (overrides: Partial<SourceApprovalAuthorityConfig['grant']> = {}): SourceApprovalAuthorityConfig => ({ schemaVersion: 1,
    authority: 'source-authority', keyId: 'source-key', keyPath, statePath: join(root, 'authority.sqlite'), controlDatabasePath: databasePath,
    grant: { id: 'grant-one', expiresAt: now + 60_000, maxApprovals: 2, repository, worktreeRoot,
      owner: { authorityId: reference.owner.authorityId, authorityHash: reference.owner.authorityHash, principalId: reference.owner.principalId,
        principalRecordId: reference.owner.principalRecordId, principalVersion: reference.owner.principalVersion,
        workspace: reference.owner.workspace, agentPreset: reference.owner.agentPreset }, plugins: ['health-helper'],
      maxChangedFiles: 8, maxChangedBytes: 4096, receiptTtlMs: 30_000, ...(managedVersion ? { versioning: 'patch' as const } : {}), ...overrides } })
  const request = { protocol: 'dsh-source-approval/v1' as const, planId: plan.id, planDigest: plan.digest, sourceReferenceDigest: controlPlaneDigest(initial.source) }
  return { root, worktree, source, store, key, reference, plan, makePlan, config, request, now }
}

describe.runIf(process.platform === 'linux')('finite source approval authority', { timeout: 20_000 }, () => {
  it('independently approves only an opted-in Host version delta and matching checked artifact', async () => {
    const value = await fixture(undefined, true)
    const legacy = value.config(); delete legacy.grant.versioning
    await expect(authorizePreparedSource(legacy, value.request)).rejects.toThrow('refused')
    const receipt = await authorizePreparedSource(value.config(), value.request)
    expect(receipt.planDigest).toBe(value.plan.digest)
    expect(value.plan.preparedEvidence?.pack.version).toBe('0.1.1')
    const mismatch = await fixture(undefined, true, '0.1.2')
    await expect(authorizePreparedSource(mismatch.config(), mismatch.request)).rejects.toThrow('refused')
    const unstamped = await fixture()
    await expect(authorizePreparedSource(unstamped.config({ versioning: 'patch' }), unstamped.request)).rejects.toThrow('refused')
  })

  it.each(['scripts', 'name', 'dependencies', 'runtime'] as const)('rejects a checked but unauthorized %s change beside the version bump', async field => {
    const manifest = { name: '@dsh-enhanced/health-helper', version: '0.1.1', dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: { build: 'tsc' } }
    const value = await fixture(field === 'runtime' ? { path: 'plugins/health-helper/src/version.ts', content: "export const version = '0.1.1'\nconsole.log('candidate code')\n" }
      : { path: 'plugins/health-helper/package.json', content: `${JSON.stringify({ ...manifest,
        ...(field === 'scripts' ? { scripts: { build: 'candidate-command' } } : field === 'name' ? { name: '@dsh-enhanced/other' } : { dependencies: { other: '1.0.0' } }) })}\n` }, true)
    await expect(authorizePreparedSource(value.config(), value.request)).rejects.toThrow('refused')
  })

  it('signs a freshly checked owner-bound plan once, replays across restart, and has a standard-verifiable receipt', async () => {
    const value = await fixture(); const config = value.config()
    const first = await authorizePreparedSource(config, value.request)
    const replay = await authorizePreparedSource(config, value.request)
    expect(replay).toEqual(first)
    const verifier = new Ed25519ApprovalAuthority(value.key.publicKey.export({ format: 'pem', type: 'spki' }), 'source-authority', 'source-key')
    await expect(verifier.verify(first, value.plan)).resolves.toMatchObject({ planId: value.plan.id, decision: 'approved' })
  })

  it('uses a durable finite quota and refuses a request or config conflict', async () => {
    const value = await fixture(); const config = value.config({ maxApprovals: 1 })
    await authorizePreparedSource(config, value.request)
    const second = value.makePlan('two')
    const secondRequest = { ...value.request, planId: second.plan.id, planDigest: second.plan.digest, sourceReferenceDigest: controlPlaneDigest(second.source) }
    const secondGrant = value.config({ id: 'grant-two', maxApprovals: 1 })
    await expect(authorizePreparedSource(secondGrant, secondRequest)).resolves.toMatchObject({ planId: second.plan.id })
    const third = value.makePlan('three')
    await expect(authorizePreparedSource(config, { ...value.request, planId: third.plan.id, planDigest: third.plan.digest,
      sourceReferenceDigest: controlPlaneDigest(third.source) })).rejects.toThrow('refused')
    await expect(authorizePreparedSource(value.config({ maxApprovals: 2 }), value.request)).rejects.toThrow('refused')
    await expect(authorizePreparedSource(config, { ...value.request, planDigest: hex('f') })).rejects.toThrow('refused')
  })

  it('approves linux-native repository preparation from a running bound source job without any Docker evidence', async () => {
    const value = await fixture(undefined, true, undefined, 'linux-native')
    expect(value.plan.preparedEvidence).toMatchObject({ schemaVersion: 3, boundary: 'linux-native-repository-v1' })
    const receipt = await authorizePreparedSource(value.config(), value.request)
    expect(receipt.planDigest).toBe(value.plan.digest)
    expect(value.plan.preparedEvidence?.pack.version).toBe('0.1.1')
    const verifier = new Ed25519ApprovalAuthority(value.key.publicKey.export({ format: 'pem', type: 'spki' }), 'source-authority', 'source-key')
    await expect(verifier.verify(receipt, value.plan)).resolves.toMatchObject({ planId: value.plan.id, decision: 'approved' })
  })

  it('rejects macOS schema2 and tampered linux-native schema3 prepared evidence', async () => {
    const value = await fixture(undefined, true, undefined, 'linux-native')
    const valid = value.plan.preparedEvidence as LinuxSourcePreparedEvidence
    const validate = (prepared: SourcePreparedEvidence) => sourceAuthorityValidatePrepared(
      { ...value.plan, preparedEvidence: prepared }, value.now)
    expect(() => validate(valid)).not.toThrow()
    const tamper = (change: (evidence: LinuxSourcePreparedEvidence) => unknown) =>
      expect(() => validate(change(structuredClone(valid)) as SourcePreparedEvidence)).toThrow()
    tamper(evidence => ({ ...evidence, boundary: 'linux-native-process-seccomp-v1' as never }))
    tamper(evidence => ({ ...evidence, environment: { ...evidence.environment, offline: false } }))
    tamper(evidence => ({ ...evidence, environment: { ...evidence.environment, frozenLockfile: false } }))
    tamper(evidence => ({ ...evidence, checks: [...evidence.checks].reverse() }))
    tamper(evidence => ({ ...evidence, checks: evidence.checks.slice(0, 4) }))
    // The macOS single-process schema can never back a full-repository modify plan.
    expect(() => sourceAuthorityValidatePrepared({ ...value.plan,
      preparedEvidence: { schemaVersion: 2, kind: valid.kind, boundary: 'macos-seatbelt-single-process-v1',
        runtimeDigest: hex('r'), fixedCompilerSha256: hex('f'),
        checks: ['semantic-typecheck', 'js-declaration-emit', 'host-safe-pack'], pack: valid.pack, preparedAt: value.now } }, value.now)).toThrow()
  })

  it('refuses scope metadata, protected plugin, owner drift, byte drift, and expired grants', async () => {
    const cases = [
      async () => { const value = await fixture(); await writeFile(join(value.worktree, 'plugins', 'health-helper', 'package.json'), '{}\n'); await expect(authorizePreparedSource(value.config(), value.request)).rejects.toThrow('refused') },
      async () => { const value = await fixture({ path: 'plugins/health-helper/src/tool.spec.ts', content: 'export {}\n' }); await expect(authorizePreparedSource(value.config(), value.request)).rejects.toThrow('refused') },
      async () => { const value = await fixture(); expect(() => validateSourceApprovalAuthorityConfig(value.config({ plugins: ['plugin-control-plane'] }))).toThrow('refused') },
      async () => { const value = await fixture(); await expect(authorizePreparedSource(value.config({ owner: { ...value.config().grant.owner, principalVersion: 2 } }), value.request)).rejects.toThrow('refused') },
      async () => { const value = await fixture(); await expect(authorizePreparedSource(value.config({ maxChangedBytes: 1 }), value.request)).rejects.toThrow('refused') },
      async () => { const value = await fixture(); await expect(authorizePreparedSource(value.config({ expiresAt: value.now - 1 }), value.request)).rejects.toThrow('refused') },
    ]
    for (const run of cases) await run()
  })
})
