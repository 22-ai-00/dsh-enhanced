import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Ed25519ApprovalAuthority } from '../src/approval.ts'
import { authorizePreparedSource, validateSourceApprovalAuthorityConfig, type SourceApprovalAuthorityConfig } from '../src/source-approval-authority.ts'
import { PREPARED_SOURCE_BUILD_SCRIPT } from '../src/source-build.ts'
import { checkedSourceSnapshot } from '../src/source-workspace.ts'
import { managedPatchVersionFiles } from '../src/source-versioning.ts'
import { controlPlaneDigest, ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../src/store.ts'
import type { OwnerTaskFailureReference } from '../src/owner-task-gap-types.ts'
import type { SourcePreparedEvidence } from '../src/types.ts'

const execFile = promisify(execFileCallback)
const roots: string[] = []
const stores: ControlPlaneStore[] = []
const environment = { PATH: process.env.PATH!, LANG: 'C', LC_ALL: 'C' }
const hex = (character: string) => character.repeat(64)

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

function evidence(now: number): SourcePreparedEvidence {
  return { schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v24.0.0', pnpmVersion: '11.0.0' },
    // Same durable evidence shape emitted by runDockerPreparedChecks. This is
    // deliberately a fixture: the authority does not run a candidate Docker build.
    commands: [{ command: 'docker', args: ['run', '-i', '--pull', 'never', '--name', 'dsh-source-prepare-test', '--network', 'none',
      '--read-only', '--cap-drop', 'ALL', '--user', '65534:65534', '--env', 'PLUGIN_ROOT=plugins/health-helper',
      '--entrypoint', '/bin/sh', 'sha256:image', '-ceu', PREPARED_SOURCE_BUILD_SCRIPT], exitCode: 0, durationMs: 1, logDigest: hex('1') }],
    pack: { name: 'health-helper.tgz', version: '0.1.0', sizeBytes: 1, sha256: hex('4') }, preparedAt: now }
}

async function fixture(beforePlan?: { path: string; content: string }, managedVersion = false, packagedVersion?: string) {
  const root = await mkdtemp(join(tmpdir(), 'source-approval-authority-')); roots.push(root)
  const repository = join(root, 'repository'); await mkdir(join(repository, 'plugins', 'health-helper', 'src'), { recursive: true, mode: 0o700 })
  await git(repository, 'init', '-q'); await git(repository, 'config', 'user.email', 'tests@example.invalid'); await git(repository, 'config', 'user.name', 'Tests')
  await writeFile(join(repository, 'plugins', 'health-helper', 'src', 'tool.ts'), 'export const value = 1\n', { encoding: 'utf8', mode: 0o600 })
  await writeFile(join(repository, 'plugins', 'health-helper', 'package.json'), `${JSON.stringify({ name: '@dsh-enhanced/health-helper', version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: { build: 'tsc' } }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(repository, 'plugins', 'health-helper', 'src', 'version.ts'), "export const version = '0.1.0'\n", { mode: 0o600 })
  await git(repository, 'add', '.'); await git(repository, 'commit', '-qm', 'base')
  const baseCommit = (await git(repository, 'rev-parse', 'HEAD')).trim()
  const worktreeRoot = join(root, 'worktrees'); const worktree = join(worktreeRoot, 'prepared')
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
  const checkedEvidence = evidence(now)
  checkedEvidence.pack.version = packagedVersion ?? (managedVersion ? '0.1.1' : '0.1.0')
  const makePlan = (suffix: string, sourceReference = reference) => {
    const source = suffix === 'one' ? sourceReference : { ...sourceReference, outcomeId: `outcome-${suffix}`,
      projection: { ...sourceReference.projection, subjectRef: `turn-${suffix}` } }
    const targetGap = suffix === 'one' ? gap : store.recordOwnerTaskFailureGap(source)
    const plan = store.withOwnerTaskFailureGapAdmission(targetGap.id, () => store.createSourcePlan({ gapId: targetGap.id, repository, worktree,
      baseCommit, name: 'health-helper', generatorDigest: MODIFY_GENERATOR_DIGEST, scope: ['plugins/health-helper'], mode: 'modify', ttlMs: 120_000,
      idempotencyKey: `source-authority-${suffix}`, prepared: { treeDigest: snapshot.checkedTreeDigest, patchDigest: snapshot.checkedPatchDigest, checkedAt: now, evidence: checkedEvidence } }).result)
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
