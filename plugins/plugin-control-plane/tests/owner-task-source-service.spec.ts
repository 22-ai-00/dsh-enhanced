import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ControlPlaneStore } from '../src/store.ts'
import { Ed25519SourceReleaseAuthorizationAuthority, sourceReleaseAuthorizationSigningPayload } from '../src/release.ts'
import * as adoptionRunner from '../src/source-adoption-runner.ts'
import * as releaseRunner from '../src/source-release-runner.ts'
import * as releaseClient from '../src/source-release-client.ts'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, test, vi } from 'vitest'
import { PluginControlPlaneService } from '../src/service.ts'
import * as workspace from '../src/source-workspace.ts'
import * as build from '../src/source-build.ts'
import * as versioning from '../src/source-versioning.ts'
import { approvalSigningPayload } from '../src/approval.ts'
import * as approvalClient from '../src/source-approval-client.ts'
import * as trust from '../src/trust.ts'

// Host integration: real CP persistence, scripted Delivery/Evaluation and build
// ports. Native canonical fences have separate owner-task-gaps.spec coverage.
vi.mock('../src/source-workspace.ts', async original => ({ ...await original<typeof workspace>(),
  createIsolatedWorktree: vi.fn(), writeScopedPluginFiles: vi.fn(), runLocalCommand: vi.fn(), verifyPreparedSourceWorktree: vi.fn() }))
vi.mock('../src/source-build.ts', async original => ({ ...await original<typeof build>(), runDockerPreparedChecks: vi.fn() }))
vi.mock('../src/source-versioning.ts', async original => ({ ...await original<typeof versioning>(), managedPatchVersionFiles: vi.fn(), verifyManagedPatchVersion: vi.fn() }))
vi.mock('../src/trust.ts', async original => ({ ...await original<typeof trust>(), loadTrustConfig: vi.fn(), inheritedEnvironment: vi.fn(() => ({})) }))
vi.mock('../src/source-approval-client.ts', async original => ({ ...await original<typeof approvalClient>(), requestSourceApproval: vi.fn() }))
vi.mock('../src/source-release-client.ts', async original => ({ ...await original<typeof releaseClient>(), requestSourceReleaseAuthorization: vi.fn() }))
vi.mock('../src/source-release-runner.ts', async original => ({ ...await original<typeof releaseRunner>(), advanceSourceRelease: vi.fn() }))
vi.mock('../src/source-adoption-runner.ts', async original => ({ ...await original<typeof adoptionRunner>(), adoptSourceRelease: vi.fn() }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.resetAllMocks() })

async function fixture(approvals = false, managedVersion = false, releases = false, execution = false, review = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-task-source-service-'))), ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { receiptVersion: 2 as const, authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const source: OwnerForegroundLearningTask = { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner,
    canonical: { scope: { workspace: root, preset: 'primary' }, scopeKey: 'scope', scopeWatermark: 1,
      triggerOutcomeId: 'outcome', situation: 'foreground:task',
      objective: { outcomeId: 'outcome', status: 'not-achieved', source: { kind: 'evaluator', id: 'assistant-verifier' },
        evaluator: { id: 'assistant-verifier', version: '1' }, evidence: [], occurredAt: Date.now() },
      projection: { subjectKind: 'foreground-turn', subjectRef: 'task', version: 1, digest: 'b'.repeat(64), disposition: 'upsert' } },
    judgement: 'independent-verifier', source: { sessionId: 'session', inboxId: 'task', objective: 'private task',
      quiescent: true, truncated: false, modelSelectionState: review ? 'frozen' : 'missing',
      ...(review ? { modelSelection: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } } : {}) } }
  const fence = vi.fn((_input: unknown, callback: () => unknown) => ({ matched: true, value: callback() }))
  ctx.provide('assistantDelivery' as never, { inspectOwnerForegroundLearningTask: () => structuredClone(source) })
  ctx.provide('assistantEvaluation' as never, { canonicalHostScope: (input: unknown) => input, withTrustedCanonicalTaskWriterFence: fence })
  const statePath = join(root, 'state'), catalogPath = join(root, 'catalog.json'), trustPath = join(root, 'trust.json')
  vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ledger: { path: join(statePath, 'control.sqlite') }, catalog: { path: catalogPath } } as Awaited<ReturnType<typeof trust.loadTrustConfig>>)
  const remove = vi.fn(async () => {}), worktree = join(root, 'worktree')
  vi.mocked(workspace.createIsolatedWorktree).mockResolvedValue({ worktree, remove } as Awaited<ReturnType<typeof workspace.createIsolatedWorktree>>)
  vi.mocked(workspace.runLocalCommand).mockResolvedValue('c'.repeat(40))
  const evidence = { schemaVersion: 1 as const, kind: 'dsh-source-prepared-evidence' as const,
    environment: { npmConfigIgnoreScripts: true as const, frozenLockfile: true as const, offline: true, nodeVersion: 'test', pnpmVersion: 'test' },
    commands: [{ command: 'pnpm', args: ['check'], exitCode: 0 as const, durationMs: 1, logDigest: 'e'.repeat(64) }],
    pack: { name: 'helper', version: managedVersion ? '1.0.1' : '1.0.0', sizeBytes: 1, sha256: 'd'.repeat(64) }, preparedAt: Date.now() }
  const checked = { treeDigest: 'd'.repeat(64), patchDigest: 'e'.repeat(64), checkedAt: Date.now(), evidence }
  vi.mocked(build.runDockerPreparedChecks).mockResolvedValue(checked)
  vi.mocked(workspace.verifyPreparedSourceWorktree).mockResolvedValue({ checkedTreeDigest: checked.treeDigest, checkedPatchDigest: checked.patchDigest })
  vi.mocked(versioning.managedPatchVersionFiles).mockResolvedValue({ baseVersion: '1.0.0', version: '1.0.1', files: [
    { path: 'package.json', content: '{"version":"1.0.1"}\n' }, { path: 'src/version.ts', content: "export const version = '1.0.1'\n" }] })
  vi.mocked(versioning.verifyManagedPatchVersion).mockResolvedValue({ baseVersion: '1.0.0', version: '1.0.1' })
  const service = new PluginControlPlaneService(ctx, { statePath, catalogPath, trustPath,
    ...(approvals ? { sourceApprovals: { executable: { path: join(root, "authority.js"), sha256: "f".repeat(64) }, configPath: join(root, "authority.json"), timeoutMs: 1000 } } : {}),
    ...(releases ? { sourceReleases: { executable: { path: join(root, 'release-authority.js'), sha256: 'a'.repeat(64) }, configPath: join(root, 'release-authority.json'), timeoutMs: 1000 } } : {}),
    ...(execution ? { sourceReleaseExecution: { reviewDecisionRoot: root, timeoutMs: 30_000, ...(review ? { independentReview: true } : {}) } } : {}),
    ...(execution ? { sourceAdoptions: { profile: 'assistant', planTtlMs: 60_000, timeoutMs: 60_000, authority: { executable: { path: join(root, 'adoption.js'), sha256: 'a'.repeat(64) }, configPath: join(root, 'adoption.json'), timeoutMs: 1000 } } } : {}),
    sourceBuild: { dockerPath: '/usr/bin/docker', image: `example@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
      ...(managedVersion ? { versioning: 'patch' as const } : {}),
      memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 } })
  const gap = service.recordOwnerTaskFailureGap(structuredClone(source))
  const caller = { ownerRouteId: owner.authorityId, principalId: owner.principalId, principalRecordId: owner.principalRecordId,
    principalVersion: owner.principalVersion, workspace: root, preset: owner.agentPreset }
  const request = { gapId: gap.id, owner: caller, name: 'health-helper', repository: root,
    files: [{ path: 'src/index.ts', content: 'export {}' }], idempotencyKey: 'prepare-task-fix' }
  const count = () => { const db = new DatabaseSync(join(statePath, 'control.sqlite')); try {
    return (db.prepare('SELECT count(*) AS count FROM source_plans').get() as { count: number }).count
  } finally { db.close() } }
  return { service, source, owner, fence, remove, checked, request, count, ctx, root, databasePath: join(statePath, 'control.sqlite') }
}

test('commits a checked task-bound proposal through the Host fence', async () => {
  const f = await fixture()
  expect((await f.service.prepareModifySourcePlan(f.request)).status).toBe('pending-approval')
  expect(f.count()).toBe(1)
  expect(f.remove).not.toHaveBeenCalled()
})

test('prepares the Host version before isolated checks and retains it in the owner-bound plan', async () => {
  const f = await fixture(false, true), written = new Map<string, string>()
  vi.mocked(workspace.writeScopedPluginFiles).mockImplementation(async input => { for (const file of input.files) written.set(file.path, file.content) })
  vi.mocked(build.runDockerPreparedChecks).mockImplementation(async () => {
    expect(written.get('src/index.ts')).toBe('export {}')
    expect(JSON.parse(written.get('package.json')!).version).toBe('1.0.1')
    expect(written.get('src/version.ts')).toBe("export const version = '1.0.1'\n")
    return f.checked
  })
  const plan = await f.service.prepareModifySourcePlan(f.request)
  expect(plan).toMatchObject({ status: 'pending-approval', preparedEvidence: { pack: { version: '1.0.1' } } })
  expect(f.count()).toBe(1)
})

test.each(['package.json', 'src/version.ts'])('caller cannot supply Host-managed %s', async path => {
  const f = await fixture(false, true)
  await expect(f.service.prepareModifySourcePlan({ ...f.request, files: [{ path, content: 'caller data' }] })).rejects.toThrow()
  expect(workspace.createIsolatedWorktree).not.toHaveBeenCalled()
  expect(f.count()).toBe(0)
})

test.each(['artifact', 'files'] as const)('discards the prepared plan when managed version %s drift during checks', async drift => {
  const f = await fixture(false, true)
  if (drift === 'artifact') f.checked.evidence.pack.version = '1.0.0'
  else vi.mocked(versioning.verifyManagedPatchVersion).mockResolvedValueOnce({ baseVersion: '1.0.0', version: '1.0.1' })
    .mockRejectedValueOnce(new Error('version changed during build'))
  await expect(f.service.prepareModifySourcePlan(f.request)).rejects.toThrow(/version/u)
  expect(f.count()).toBe(0); expect(f.remove).toHaveBeenCalledOnce()
})

test('rejects a guessed task gap without caller ownership before acquiring a worktree', async () => {
  const f = await fixture()
  const { owner: _owner, ...request } = f.request
  await expect(f.service.prepareModifySourcePlan(request)).rejects.toThrow('caller')
  expect(workspace.createIsolatedWorktree).not.toHaveBeenCalled()
  expect(f.count()).toBe(0)
})

test('a source owner change during build removes the worktree without a plan', async () => {
  const f = await fixture()
  vi.mocked(build.runDockerPreparedChecks).mockImplementationOnce(async () => { f.owner.generation += 1; return f.checked })
  await expect(f.service.prepareModifySourcePlan(f.request)).rejects.toThrow('changed')
  expect(f.count()).toBe(0)
  expect(f.remove).toHaveBeenCalledOnce()
})

test('a final commit fence conflict removes the worktree and leaves no plan', async () => {
  const f = await fixture()
  vi.mocked(build.runDockerPreparedChecks).mockImplementationOnce(async () => {
    // The first fence checks post-build freshness; the second is the commit.
    let checks = 0
    f.fence.mockImplementation((_input, callback) => ++checks === 1
      ? { matched: true, value: callback() } : { matched: false, value: undefined })
    return f.checked
  })
  await expect(f.service.prepareModifySourcePlan(f.request)).rejects.toThrow('fence changed')
  expect(f.count()).toBe(0)
  expect(f.remove).toHaveBeenCalledOnce()
})

async function signedApprovalFixture(releases = false, execution = false, review = false) {
  const f = await fixture(true, releases, releases, execution, review), plan = await f.service.prepareModifySourcePlan(f.request)
  const keys = generateKeyPairSync('ed25519')
  const bound = await trust.loadTrustConfig('ignored')
  vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ...bound, approvalKeys: [{ authority: 'authority', keyId: 'key',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] } as Awaited<ReturnType<typeof trust.loadTrustConfig>>)
  const unsigned = { schemaVersion: 1 as const, approvalId: 'approval', authority: 'authority', keyId: 'key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const receipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  vi.mocked(approvalClient.requestSourceApproval).mockResolvedValue(receipt)
  return { ...f, plan, receipt }
}

test('Host uses the finite authority receipt and current source fence, with idempotent completion', async () => {
  const f = await signedApprovalFixture()
  const approved = await f.service.requestOwnerSourceApproval({ planId: f.plan.id })
  expect(approved).toMatchObject({ status: 'approved', revision: 2 })
  expect(await f.service.requestOwnerSourceApproval({ planId: f.plan.id })).toEqual(approved)
  expect(approvalClient.requestSourceApproval).toHaveBeenCalledTimes(1)
  f.owner.generation += 1
  await expect(f.service.requestOwnerSourceApproval({ planId: f.plan.id })).rejects.toThrow('changed')
})

test.each(['source', 'cancel', 'trust'] as const)('rejects %s changes while authority is signing', async changed => {
  const f = await signedApprovalFixture(), abort = new AbortController()
  vi.mocked(approvalClient.requestSourceApproval).mockImplementationOnce(async () => {
    if (changed === 'source') f.owner.generation += 1
    if (changed === 'cancel') abort.abort()
    if (changed === 'trust') vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ...await trust.loadTrustConfig('ignored'), installationId: 'changed' })
    return f.receipt
  })
  await expect(f.service.requestOwnerSourceApproval({ planId: f.plan.id, signal: abort.signal })).rejects.toThrow()
  expect(f.count()).toBe(1)
})

test('Host disposal waits for the helper flight and suppresses its late signed response', async () => {
  const f = await signedApprovalFixture()
  let finish!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(approvalClient.requestSourceApproval).mockImplementationOnce(async () => {
    entered(); await new Promise<void>(resolve => { finish = resolve }); return f.receipt
  })
  const flight = f.service.requestOwnerSourceApproval({ planId: f.plan.id })
  const rejected = expect(flight).rejects.toThrow()
  await ready
  let disposed = false
  const disposal = f.ctx.fiber.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  finish()
  await Promise.all([disposal, rejected])
})


test('durable approval rejects a changed frozen job trust before invoking the helper', async () => {
  const f = await signedApprovalFixture()
  await expect(f.service.requestOwnerSourceApproval({ planId: f.plan.id, expectedTrustDigest: '0'.repeat(64) })).rejects.toThrow('source job approval trust changed')
  expect(approvalClient.requestSourceApproval).not.toHaveBeenCalled()
})


async function signedReleaseFixture(execution = false, review = false) {
  const f = await signedApprovalFixture(true, execution, review)
  await f.service.requestOwnerSourceApproval({ planId: f.plan.id })
  const keys = generateKeyPairSync('ed25519'), bound = await trust.loadTrustConfig('ignored')
  const registry = { id: 'local-registry', locator: pathToFileURL(join(f.root, 'registry')).href, caPins: [], tokenEnvironment: null }
  vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ...bound, schemaVersion: 4, releaseRegistry: registry,
    catalog: { ...bound.catalog, id: 'local-catalog' }, releaseAuthorizationKeys: [{ authority: 'release-authority', keyId: 'release-key',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] } as Awaited<ReturnType<typeof trust.loadTrustConfig>>)
  const unsigned = { schemaVersion: 1 as const, kind: 'dsh-source-release-authorization' as const, authorizationId: 'finite-release',
    authority: 'release-authority', keyId: 'release-key', planId: f.plan.id, planDigest: f.plan.digest, baseCommit: f.plan.baseCommit,
    checkedTreeDigest: f.plan.sourceCheck!.treeDigest, checkedPatchDigest: f.plan.sourceCheck!.patchDigest, scope: f.plan.scope,
    releasePolicy: { targetBranch: 'candidate', candidateId: f.plan.name, packageName: `@dsh-enhanced/${f.plan.name}`, packageVersion: '1.0.1',
      packagePath: `plugins/${f.plan.name}`, dshBaseline: '0.1.5', capabilities: ['helper'], authorities: ['filesystem'], requires: [],
      registryId: registry.id, registryLocator: registry.locator, registryReference: `${registry.locator}/packages/helper/1.0.1/package.tgz`,
      catalogId: 'local-catalog', catalogPath: bound.catalog.path, minimumReproducibleBuilds: 2 }, authorizedAt: Date.now(), expiresAt: f.plan.expiresAt }
  const authorization = { ...unsigned, signature: sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  vi.mocked(releaseClient.requestSourceReleaseAuthorization).mockResolvedValue(authorization)
  const status = () => { const store = new ControlPlaneStore({ path: f.databasePath }); try { return store.getSourcePlan(f.plan.id).status } finally { store.close() } }
  return { ...f, authorization, status }
}

test('automatically rechecks approved owner source and starts the existing release once under its separate grant', async () => {
  const f = await signedReleaseFixture()
  const started = await f.service.requestOwnerSourceRelease({ planId: f.plan.id })
  expect(started).toMatchObject({ status: 'awaiting-pr', revision: 4, release: { fence: 1 } })
  expect(workspace.verifyPreparedSourceWorktree).toHaveBeenCalledOnce()
  expect(await f.service.requestOwnerSourceRelease({ planId: f.plan.id })).toEqual(started)
  expect(releaseClient.requestSourceReleaseAuthorization).toHaveBeenCalledOnce()
  // The durable Store replay cannot be used to bypass Host source admission.
  const store = new ControlPlaneStore({ path: f.databasePath })
  try { await expect(store.startSourceRelease({ planId: f.plan.id, expectedRevision: 3, authorization: f.authorization,
    resolveAuthority: () => { throw new Error('replay must not verify again') },
    idempotencyKey: 'source-release-authorization:finite-release' })).rejects.toThrow('Host admission') } finally { store.close() }
  f.owner.generation += 1
  await expect(f.service.requestOwnerSourceRelease({ planId: f.plan.id })).rejects.toThrow('changed')
})

test.each(['source', 'cancel', 'trust', 'policy'] as const)('does not start release when %s changes while the authority signs', async changed => {
  const f = await signedReleaseFixture(), abort = new AbortController()
  vi.mocked(releaseClient.requestSourceReleaseAuthorization).mockImplementationOnce(async () => {
    if (changed === 'source') f.owner.generation += 1
    if (changed === 'cancel') abort.abort()
    if (changed === 'trust') vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ...await trust.loadTrustConfig('ignored'), installationId: 'changed' })
    return changed === 'policy' ? { ...f.authorization, releasePolicy: { ...f.authorization.releasePolicy, catalogId: 'different' } } : f.authorization
  })
  await expect(f.service.requestOwnerSourceRelease({ planId: f.plan.id, signal: abort.signal })).rejects.toThrow()
  expect(f.status()).toBe('ready-for-human-review')
})

test('late source changes after signature verification still prevent the release commit', async () => {
  const f = await signedReleaseFixture()
  const verify = Ed25519SourceReleaseAuthorizationAuthority.prototype.verify
  const spy = vi.spyOn(Ed25519SourceReleaseAuthorizationAuthority.prototype, 'verify').mockImplementationOnce(async function (this: Ed25519SourceReleaseAuthorizationAuthority, ...args) {
    const result = await verify.apply(this, args)
    f.owner.generation += 1
    return result
  })
  try { await expect(f.service.requestOwnerSourceRelease({ planId: f.plan.id })).rejects.toThrow('changed') }
  finally { spy.mockRestore() }
  expect(f.status()).toBe('ready-for-human-review')
})

test('release verification rejects source drift and frozen trust changes before asking for authorization', async () => {
  const f = await signedReleaseFixture()
  await expect(f.service.requestOwnerSourceRelease({ planId: f.plan.id, expectedTrustDigest: '0'.repeat(64) })).rejects.toThrow('trust changed')
  vi.mocked(workspace.verifyPreparedSourceWorktree).mockRejectedValueOnce(new Error('prepared source changed'))
  await expect(f.service.requestOwnerSourceRelease({ planId: f.plan.id })).rejects.toThrow('source changed')
  expect(f.status()).toBe('approved')
  expect(releaseClient.requestSourceReleaseAuthorization).not.toHaveBeenCalled()
  const store = new ControlPlaneStore({ path: f.databasePath })
  try { expect(() => store.verifyPreparedSourcePlan({ planId: f.plan.id, expectedRevision: 2,
    recheckedTreeDigest: f.plan.sourceCheck!.treeDigest, recheckedPatchDigest: f.plan.sourceCheck!.patchDigest })).toThrow('Host admission') }
  finally { store.close() }
})

test('release helper late response is drained and discarded when the Host unloads', async () => {
  const f = await signedReleaseFixture()
  let finish!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(releaseClient.requestSourceReleaseAuthorization).mockImplementationOnce(async () => {
    entered(); await new Promise<void>(resolve => { finish = resolve }); return f.authorization
  })
  const flight = f.service.requestOwnerSourceRelease({ planId: f.plan.id }), rejected = expect(flight).rejects.toThrow()
  await ready
  let disposed = false
  const disposal = f.ctx.fiber.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve)); expect(disposed).toBe(false)
  finish(); await Promise.all([disposal, rejected])
})


test('Host release execution stops on frozen trust or owner changes, including after async work', async () => {
  const f = await signedReleaseFixture(true)
  const started = await f.service.requestOwnerSourceRelease({ planId: f.plan.id })
  vi.mocked(releaseRunner.advanceSourceRelease).mockImplementation(async options => { await options.assertCurrent(); return started })
  await expect(f.service.advanceOwnerSourceRelease({ planId: f.plan.id, expectedTrustDigest: 'a'.repeat(64) })).rejects.toThrow('trust changed')
  expect(releaseRunner.advanceSourceRelease).not.toHaveBeenCalled()
  expect(await f.service.advanceOwnerSourceRelease({ planId: f.plan.id })).toEqual(started)
  vi.mocked(releaseRunner.advanceSourceRelease).mockImplementationOnce(async options => {
    f.owner.generation += 1; await options.assertCurrent(); return started
  })
  await expect(f.service.advanceOwnerSourceRelease({ planId: f.plan.id })).rejects.toThrow('changed')
})

test('Host unload aborts and drains a single release continuation', async () => {
  const f = await signedReleaseFixture(true)
  const started = await f.service.requestOwnerSourceRelease({ planId: f.plan.id })
  let entered!: () => void, finish!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), stopped = new Promise<void>(resolve => { finish = resolve })
  vi.mocked(releaseRunner.advanceSourceRelease).mockImplementationOnce(async options => {
    entered(); await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
    await stopped; await options.assertCurrent(); return started
  })
  const first = f.service.advanceOwnerSourceRelease({ planId: f.plan.id }), rejected = expect(first).rejects.toThrow()
  await ready
  await expect(f.service.advanceOwnerSourceRelease({ planId: f.plan.id })).rejects.toThrow('already running')
  let disposed = false
  const disposal = f.ctx.fiber.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve)); expect(disposed).toBe(false)
  finish(); await rejected; await disposal
})


test('independent review waits before PR until its exact root and inherited model are available', async () => {
  const f = await signedReleaseFixture(true, true)
  const started = await f.service.requestOwnerSourceRelease({ planId: f.plan.id })
  expect(await f.service.advanceOwnerSourceRelease({ planId: f.plan.id })).toEqual(started)
  expect(releaseRunner.advanceSourceRelease).not.toHaveBeenCalled()
  const canReviewSourceRepair = vi.fn(() => false), reviewSourceRepair = vi.fn()
  f.ctx.provide('assistantVerifier' as never, { canReviewSourceRepair, reviewSourceRepair })
  expect(await f.service.advanceOwnerSourceRelease({ planId: f.plan.id })).toEqual(started)
  expect(canReviewSourceRepair).toHaveBeenCalledWith({ decisionRoot: f.root, owner: f.owner, name: 'health-helper', modelSelection: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } })
  expect(releaseRunner.advanceSourceRelease).not.toHaveBeenCalled()
  canReviewSourceRepair.mockReturnValue(true)
  vi.mocked(releaseRunner.advanceSourceRelease).mockImplementation(async options => {
    const request = { phase: 'review' as const, operationId: 'review-operation', plan: { id: started.id, digest: started.digest, revision: started.revision },
      release: started.release!, authorization: f.authorization,
      input: { prId: 'pr', baseCommit: started.baseCommit, headCommit: 'f'.repeat(40), prEvidenceDigest: 'e'.repeat(64) } }
    await options.review!(request as unknown as Parameters<NonNullable<typeof options.review>>[0], started)
    return started
  })
  expect(await f.service.advanceOwnerSourceRelease({ planId: f.plan.id })).toEqual(started)
  expect(reviewSourceRepair).toHaveBeenCalledTimes(1)
  expect(reviewSourceRepair.mock.calls[0]![0]).toMatchObject({ request: { protocol: 'dsh-source-review/v1', planId: started.id,
    source: { owner: f.owner, objective: 'private task', modelSelection: f.source.source.modelSelection },
    checkedTreeDigest: f.authorization.checkedTreeDigest, checkedPatchDigest: f.authorization.checkedPatchDigest } })
})


// The runner owns exact release/activation validation (real signed integration in
// source-adoption-store.spec); these tests isolate Host connection and lifetime.
test.each(['source', 'unload'] as const)('adoption owns and drains its dedicated connection when %s ends authority', async boundary => {
  const f = await signedReleaseFixture(true)
  await f.service.requestOwnerSourceRelease({ planId: f.plan.id })
  const raw = new DatabaseSync(f.databasePath)
  try { raw.prepare("UPDATE source_plans SET status = 'release-complete' WHERE id = ?").run(f.plan.id) } finally { raw.close() }
  let finish!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let dedicated: ControlPlaneStore | undefined
  vi.mocked(adoptionRunner.adoptSourceRelease).mockImplementationOnce(async input => {
    dedicated = input.store
    await input.assertCurrent()
    input.withSourceFence(() => expect(input.store.getSourcePlan(f.plan.id).status).toBe('release-complete'))
    entered(); await new Promise<void>(resolve => { finish = resolve })
    // The connection remains open until this worker settles, even on unload.
    expect(input.store.getSourcePlan(f.plan.id).id).toBe(f.plan.id)
    await input.assertCurrent()
    throw new Error('fixture must reject before forward deployment')
  })
  const flight = f.service.adoptOwnerSourceRelease({ sourcePlanId: f.plan.id }), rejected = expect(flight).rejects.toThrow()
  await ready
  await expect(f.service.adoptOwnerSourceRelease({ sourcePlanId: f.plan.id })).rejects.toThrow('already running')
  let disposed: Promise<void> | undefined
  if (boundary === 'source') f.owner.generation += 1
  else disposed = Promise.resolve(f.ctx.fiber.dispose())
  finish(); await rejected; await disposed
  expect(() => dedicated!.getSourcePlan(f.plan.id)).toThrow()
})
