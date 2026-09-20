import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import { Ed25519ApprovalAuthority } from '../src/approval.ts'
import { Ed25519SourceReleaseAuthorizationAuthority } from '../src/release.ts'
import { authorizePreparedSource, type SourceApprovalAuthorityConfig } from '../src/source-approval-authority.ts'
import { authorizePreparedSourceRelease, type SourceReleaseAuthorityConfig } from '../src/source-release-authority.ts'
import { requestSourceReleaseAuthorization } from '../src/source-release-client.ts'
import { PREPARED_SOURCE_BUILD_SCRIPT } from '../src/source-build.ts'
import { managedPatchVersionFiles } from '../src/source-versioning.ts'
import { checkedSourceSnapshot } from '../src/source-workspace.ts'
import { controlPlaneDigest, ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../src/store.ts'
import type { OwnerTaskFailureReference } from '../src/owner-task-gap-types.ts'
import type { SourcePreparedEvidence } from '../src/types.ts'

const roots: string[] = []; const stores: ControlPlaneStore[] = []; const env = { PATH: process.env.PATH!, LANG: 'C', LC_ALL: 'C' }; const hex = (c: string) => c.repeat(64)
const localTest = process.platform === 'linux' ? test : test.skip
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function owner(): OwnerTaskFailureReference { return { schemaVersion: 1, owner: { receiptVersion: 2, authorityId: 'owner', authorityHash: hex('a'), principalId: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', agentPreset: 'default', bindingVersion: 1, generation: 1 }, outcomeId: 'outcome', projection: { subjectKind: 'foreground-turn', subjectRef: 'turn', version: 1, digest: hex('b'), disposition: 'upsert' }, sourceDigest: hex('c') } }

async function fixture(ready = true) {
  const root = await mkdtemp(join(tmpdir(), 'source-release-authority-')); roots.push(root); const repository = join(root, 'repo'); const plugin = join(repository, 'plugins', 'health-helper'); const worktreeRoot = join(root, 'worktrees'); const worktree = join(worktreeRoot, 'prepared')
  await mkdir(join(plugin, 'src'), { recursive: true, mode: 0o700 }); const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, env, encoding: 'utf8' }).trim()
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/health-helper', version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: { build: 'tsc' } }, null, 2) + '\n', { mode: 0o600 }); await writeFile(join(plugin, 'src/version.ts'), "export const version = '0.1.0'\n", { mode: 0o600 }); await writeFile(join(plugin, 'src/tool.ts'), 'export const value = 1\n', { mode: 0o600 })
  git('init', '-q'); git('config', 'user.email', 'tests@example.invalid'); git('config', 'user.name', 'Tests'); git('add', '.'); git('commit', '-qm', 'base'); const baseCommit = git('rev-parse', 'HEAD'); await mkdir(worktreeRoot, { mode: 0o700 }); git('worktree', 'add', '--detach', worktree, baseCommit); await chmod(worktree, 0o700)
  const version = await managedPatchVersionFiles({ worktree, baseCommit, name: 'health-helper', environment: env }); for (const file of version.files) await writeFile(join(worktree, 'plugins/health-helper', file.path), file.content, { mode: 0o600 }); await writeFile(join(worktree, 'plugins/health-helper/src/tool.ts'), 'export const value = 2\n', { mode: 0o600 })
  const now = Date.now(); const controlDatabasePath = join(root, 'control.sqlite'); const store = new ControlPlaneStore({ path: controlDatabasePath, now: () => now }); stores.push(store); const key = generateKeyPairSync('ed25519'); const keyPath = join(root, 'key.pem'); await writeFile(keyPath, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); await chmod(keyPath, 0o600)
  const source = owner(); const gap = store.recordOwnerTaskFailureGap(source); const snapshot = await checkedSourceSnapshot(worktree, baseCommit, ['plugins/health-helper'], env)
  const prepared: SourcePreparedEvidence = { schemaVersion: 1, kind: 'dsh-source-prepared-evidence', environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v24', pnpmVersion: '11' }, commands: [{ command: 'docker', args: ['run', '-i', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', '65534:65534', '--env', 'PLUGIN_ROOT=plugins/health-helper', '--entrypoint', '/bin/sh', 'sha256:image', '-ceu', PREPARED_SOURCE_BUILD_SCRIPT], exitCode: 0, durationMs: 1, logDigest: hex('d') }], pack: { name: 'health-helper.tgz', version: version.version, sizeBytes: 1, sha256: hex('e') }, preparedAt: now }
  const plan = store.withOwnerTaskFailureGapAdmission(gap.id, () => store.createSourcePlan({ gapId: gap.id, repository, worktree, baseCommit, name: 'health-helper', generatorDigest: MODIFY_GENERATOR_DIGEST, scope: ['plugins/health-helper'], mode: 'modify', ttlMs: 120_000, idempotencyKey: 'release-authority', prepared: { treeDigest: snapshot.checkedTreeDigest, patchDigest: snapshot.checkedPatchDigest, checkedAt: now, evidence: prepared } }).result)
  const common = { id: 'grant', expiresAt: now + 60_000, repository, worktreeRoot, owner: { authorityId: source.owner.authorityId, authorityHash: source.owner.authorityHash, principalId: source.owner.principalId, principalRecordId: source.owner.principalRecordId, principalVersion: source.owner.principalVersion, workspace: source.owner.workspace, agentPreset: source.owner.agentPreset }, plugins: ['health-helper'], maxChangedFiles: 8, maxChangedBytes: 4096, receiptTtlMs: 30_000, versioning: 'patch' as const }
  const approval: SourceApprovalAuthorityConfig = { schemaVersion: 1, authority: 'approval', keyId: 'key', keyPath, statePath: join(root, 'approval.sqlite'), controlDatabasePath, grant: { ...common, maxApprovals: 2 } }
  const approvalRequest = { protocol: 'dsh-source-approval/v1' as const, planId: plan.id, planDigest: plan.digest, sourceReferenceDigest: controlPlaneDigest(source) }
  const signedApproval = await authorizePreparedSource(approval, approvalRequest); const authority = new Ed25519ApprovalAuthority(key.publicKey.export({ format: 'pem', type: 'spki' }), 'approval', 'key', () => now)
  const approved = (await store.approveSource({ planId: plan.id, expectedRevision: plan.revision, receipt: signedApproval,
    resolveAuthority: () => authority, idempotencyKey: 'approval', withSourceFence: callback => store.withOwnerTaskFailureGapAdmission(gap.id, callback) })).result
  const reviewed = ready ? store.verifyPreparedSourcePlan({ planId: approved.id, expectedRevision: approved.revision, recheckedTreeDigest: snapshot.checkedTreeDigest,
    recheckedPatchDigest: snapshot.checkedPatchDigest, withSourceFence: callback => store.withOwnerTaskFailureGapAdmission(gap.id, callback) }).result : approved
  const registry = join(root, 'registry'); await mkdir(registry, { mode: 0o700 }); const catalogPath = join(root, 'catalog.json'); await writeFile(catalogPath, '{}\n', { mode: 0o600 })
  const release: SourceReleaseAuthorityConfig = { schemaVersion: 1, authority: 'release', keyId: 'key', keyPath, statePath: join(root, 'release.sqlite'), controlDatabasePath, grant: { ...common, maxReleases: 1, policies: [{ targetBranch: 'dev', candidateId: 'health-helper', packageName: '@dsh-enhanced/health-helper', packagePath: 'plugins/health-helper', dshBaseline: '0.1.0', capabilities: ['health'], authorities: ['network'], requires: [], registryId: 'local', registryLocator: pathToFileURL(registry).href, catalogId: 'catalog', catalogPath, minimumReproducibleBuilds: 2 }] } }
  const request = { protocol: 'dsh-source-release-authorization/v1' as const, planId: plan.id, planDigest: plan.digest, sourceReferenceDigest: controlPlaneDigest(source) }
  const second = async () => {
    const secondSource = { ...source, outcomeId: 'outcome-two', projection: { ...source.projection, subjectRef: 'turn-two' } }
    const secondGap = store.recordOwnerTaskFailureGap(secondSource)
    const candidate = store.withOwnerTaskFailureGapAdmission(secondGap.id, () => store.createSourcePlan({ gapId: secondGap.id, repository, worktree, baseCommit,
      name: 'health-helper', generatorDigest: MODIFY_GENERATOR_DIGEST, scope: ['plugins/health-helper'], mode: 'modify', ttlMs: 120_000,
      idempotencyKey: 'release-authority-two', prepared: { treeDigest: snapshot.checkedTreeDigest, patchDigest: snapshot.checkedPatchDigest, checkedAt: now, evidence: prepared } }).result)
    const request = { protocol: 'dsh-source-approval/v1' as const, planId: candidate.id, planDigest: candidate.digest, sourceReferenceDigest: controlPlaneDigest(secondSource) }
    const signed = await authorizePreparedSource(approval, request)
    const approved = (await store.approveSource({ planId: candidate.id, expectedRevision: candidate.revision, receipt: signed, resolveAuthority: () => authority,
      idempotencyKey: 'approval-two', withSourceFence: callback => store.withOwnerTaskFailureGapAdmission(secondGap.id, callback) })).result
    const reviewed = store.verifyPreparedSourcePlan({ planId: approved.id, expectedRevision: approved.revision, recheckedTreeDigest: snapshot.checkedTreeDigest,
      recheckedPatchDigest: snapshot.checkedPatchDigest, withSourceFence: callback => store.withOwnerTaskFailureGapAdmission(secondGap.id, callback) }).result
    return { plan: reviewed, request: { protocol: 'dsh-source-release-authorization/v1' as const, planId: reviewed.id, planDigest: reviewed.digest, sourceReferenceDigest: controlPlaneDigest(secondSource) } }
  }
  return { root, store, key, source, plan: reviewed, request, release, version, second }
}

localTest('signs exactly one ready owner source release and replays the immutable authorization', async () => {
  const f = await fixture(); const authorization = await authorizePreparedSourceRelease(f.release, f.request); const replay = await authorizePreparedSourceRelease(f.release, f.request)
  expect(replay).toEqual(authorization); expect(authorization.releasePolicy).toMatchObject({ packageVersion: '0.1.1', packageName: '@dsh-enhanced/health-helper', registryReference: expect.stringContaining('/packages/%2540dsh-enhanced%252Fhealth-helper/0.1.1/package.tgz') })
  const verifier = new Ed25519SourceReleaseAuthorizationAuthority(f.key.publicKey.export({ format: 'pem', type: 'spki' }), 'release', 'key', () => Date.now())
  await expect(verifier.verify(authorization, f.plan)).resolves.toMatchObject({ planId: f.plan.id })
})

localTest('refuses unready status, owner/digest drift, source drift, and invalid local release policy', async () => {
  const unready = await fixture(false); await expect(authorizePreparedSourceRelease(unready.release, unready.request)).rejects.toThrow('refused')
  const f = await fixture(); await expect(authorizePreparedSourceRelease(f.release, { ...f.request, sourceReferenceDigest: hex('f') })).rejects.toThrow('refused')
  await expect(authorizePreparedSourceRelease({ ...f.release, grant: { ...f.release.grant, owner: { ...f.release.grant.owner, principalRecordId: 'other-record' } } }, f.request)).rejects.toThrow('refused')
  await writeFile(join(f.root, 'worktrees/prepared/plugins/health-helper/src/tool.ts'), 'export const value = 99\n', { mode: 0o600 })
  await expect(authorizePreparedSourceRelease(f.release, f.request)).rejects.toThrow('refused')
  const policy = await fixture(); await expect(authorizePreparedSourceRelease({ ...policy.release, grant: { ...policy.release.grant,
    policies: [{ ...policy.release.grant.policies[0]!, registryLocator: 'https://registry.example/' }] } }, policy.request)).rejects.toThrow('refused')
  await expect(authorizePreparedSourceRelease({ ...policy.release, grant: { ...policy.release.grant, expiresAt: Date.now() - 1 } }, policy.request)).rejects.toThrow('refused')
})

localTest('binds a grant to immutable configuration after its first authorization', async () => {
  const f = await fixture(); await authorizePreparedSourceRelease(f.release, f.request)
  await expect(authorizePreparedSourceRelease({ ...f.release, grant: { ...f.release.grant, maxChangedBytes: f.release.grant.maxChangedBytes - 1 } }, f.request)).rejects.toThrow('refused')
})

localTest('spends one finite release grant on one real ready plan and rejects a second plan', async () => {
  const f = await fixture(); await authorizePreparedSourceRelease(f.release, f.request)
  const second = await f.second()
  await expect(authorizePreparedSourceRelease(f.release, second.request)).rejects.toThrow('refused')
})

localTest('never extends an expired stored release authorization on replay', async () => {
  const f = await fixture(); const short = { ...f.release, grant: { ...f.release.grant, receiptTtlMs: 1_000 } }
  await authorizePreparedSourceRelease(short, f.request)
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_100))
  await expect(authorizePreparedSourceRelease(short, f.request)).rejects.toThrow('refused')
})

test.runIf(process.platform === 'linux')('uses the compiled descriptor-pinned wrapper and replays its SQLite authorization', async () => {
  const f = await fixture(); const configPath = join(f.root, 'release-config.json'); await writeFile(configPath, JSON.stringify(f.release), { mode: 0o600 }); await chmod(configPath, 0o600)
  const wrapper = join(process.cwd(), 'bin/dsh-source-release-authority.js'); const node = join(f.root, 'node'); await copyFile(process.execPath, node); await chmod(node, 0o700)
  const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
  const transport = { executable: { path: wrapper, sha256: await digest(wrapper) }, interpreter: { path: node, sha256: await digest(node) }, configPath, timeoutMs: 10_000 }
  const first = await requestSourceReleaseAuthorization(transport, f.request); const replay = await requestSourceReleaseAuthorization(transport, f.request)
  expect(replay).toEqual(first)
})
