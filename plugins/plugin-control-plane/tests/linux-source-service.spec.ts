// Service orchestration/lifecycle tests. The Linux runner and build transport
// are fixtures; these tests do not establish kernel isolation or repository builds.
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { linuxRuntimeFixture, spendLinuxRepositoryRun } from './helpers/linux-source-preflight-runtime-fixture.ts'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { linuxRuntimeDigest, type LinuxRuntime, type LinuxRepositoryRunner } from '@dsh-enhanced/assistant-isolation'
import type { LinuxRepositoryRunnerConfig } from '@dsh-enhanced/assistant-isolation'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginControlPlaneService, type Config } from '../src/service.ts'
import { ControlPlaneStore } from '../src/store.ts'
import * as builds from '../src/source-build.ts'
import * as linuxBuild from '../src/linux-source-build.ts'
import * as macBuild from '../src/native-source-build.ts'
import * as trust from '../src/trust.ts'
import * as workspace from '../src/source-workspace.ts'
import type { LinuxSourcePreparedEvidence } from '../src/types.ts'
import { linuxSourceConfig } from './helpers/linux-source-build-fixture.ts'

const transport = vi.hoisted(() => ({ realConfig: undefined as LinuxRepositoryRunnerConfig | undefined, realConstruct: undefined as ((config: LinuxRepositoryRunnerConfig) => LinuxRepositoryRunner) | undefined, construct: vi.fn(), macConstruct: vi.fn(), instances: [] as Array<{
  config: LinuxRepositoryRunnerConfig; close: ReturnType<typeof vi.fn>; inspectQuiescence: ReturnType<typeof vi.fn>
}> }))
vi.mock('@dsh-enhanced/assistant-isolation', async original => ({ ...await original<typeof import('@dsh-enhanced/assistant-isolation')>(),
  verifyLinuxRuntime: vi.fn(async (runtime: LinuxRuntime) => runtime),
  LinuxRepositoryRunner: class {
    readonly runtimeDigest!: string
    close = vi.fn(async () => undefined)
    inspectQuiescence = vi.fn(async () => 'unknown')
    constructor(readonly config: LinuxRepositoryRunnerConfig) {
      if (transport.realConstruct) return transport.realConstruct(config) as unknown as this
      this.runtimeDigest = linuxRuntimeDigest(config.runtime); transport.construct(config); transport.instances.push(this) }
  },
  NativeMacVerifierRunner: class { constructor() { transport.macConstruct(); throw new Error('Mac runner must not be constructed') } },
}))
vi.mock('../src/source-build.ts', async original => ({ ...await original<typeof builds>(), runDockerPreparedChecks: vi.fn() }))
vi.mock('../src/native-source-build.ts', async original => ({ ...await original<typeof macBuild>(), runNativePreparedChecks: vi.fn() }))
vi.mock('../src/linux-source-build.ts', async original => ({ ...await original<typeof linuxBuild>(), runLinuxPreparedChecks: vi.fn() }))
vi.mock('../src/trust.ts', async original => ({ ...await original<typeof trust>(), loadTrustConfig: vi.fn() }))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.resetAllMocks(); transport.instances.splice(0); transport.realConstruct = undefined; transport.realConfig = undefined })
const digest = 'a'.repeat(64)
const checked = (): builds.SourceBuildResult<LinuxSourcePreparedEvidence> => ({ treeDigest: 'b'.repeat(64), patchDigest: 'c'.repeat(64), checkedAt: Date.now(),
  evidence: { schemaVersion: 3, kind: 'dsh-source-prepared-evidence', boundary: 'linux-native-repository-v1', runtimeDigest: digest,
    executionContractDigest: digest, buildScriptSha256: digest, archive: { sizeBytes: 10240, sha256: digest },
    receipt: { requestDigest: digest, nativeNonce: 'a'.repeat(32), nativeResourceId: 'linux-11111111-1111-4111-8111-111111111111',
      intentDigest: digest, resourcesDigest: digest, receiptDigest: digest },
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v22.23.2', pnpmVersion: '11.7.0' },
    checks: ['source-archive-integrity', 'frozen-offline-install', 'repository-pnpm-check', 'source-input-recheck', 'package-integrity'],
    pack: { name: 'health-helper.tgz', version: '1.0.0', sizeBytes: 1, sha256: digest }, logDigest: digest, durationMs: 1, preparedAt: Date.now() } })

function repositoryIdentity(): Required<Pick<builds.LinuxSourceBuildConfig, 'userNamespace' | 'systemSnapshot'>> {
  const ownerUid = process.getuid!(), ownerGid = process.getgid!()
  return { userNamespace: { schemaVersion: 1, ownerUid, ownerGid, candidateUid: ownerUid + 65536, candidateGid: ownerGid + 65536,
    hostNamespace: { dev: 1, ino: 7 }, helpers: { uid: { path: '/usr/bin/newuidmap', sha256: '1'.repeat(64) },
      gid: { path: '/usr/bin/newgidmap', sha256: '2'.repeat(64) } } },
    systemSnapshot: { schemaVersion: 1, root: { path: '/approved/system', dev: 1, ino: 3, sha256: '3'.repeat(64) },
      manifestSha256: '4'.repeat(64), bytes: 4096, entries: 16 } }
}

async function fixture(options: { constructorFailure?: boolean; registrationFailure?: boolean; timeoutMs?: number; dualIdentity?: boolean; preflightFailure?: boolean; oversizedArchive?: boolean; realAdmission?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'linux-source-service-')))
  const repository = join(root, 'repository'), statePath = join(root, 'control')
  await mkdir(join(repository, 'plugins/health-helper/src'), { recursive: true })
  await writeFile(join(repository, 'plugins/health-helper/src/index.ts'), 'export const original = true\n')
  if (options.oversizedArchive || options.realAdmission) {
    await writeFile(join(repository, 'plugins/health-helper/package.json'), JSON.stringify({ name: 'health-helper', version: '1.0.0' }))
    if (options.oversizedArchive) await writeFile(join(repository, 'plugins/health-helper/large.bin'), Buffer.alloc(64 * 1024 ** 2 + 1))
  }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '--quiet', '--initial-branch=fixture'); git('add', '--all')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'source')
  const head = git('rev-parse', 'HEAD'), ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const owner = { receiptVersion: 2 as const, authorityId: 'route', authorityHash: digest, principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const mountDelivery = () => ctx.plugin({ name: 'linux-source-delivery-fixture', apply(c: Context) {
    c.provide('assistantDelivery' as never, { validateOwnerRoute: () => structuredClone(owner) })
  } })
  const delivery = mountDelivery()
  const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'source-budget', metric: 'automation-runs', limit: 4, periodMs: 600_000, scope: 'global' }], rules: [
      { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: root, principal: 'owner' },
        actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: 'owner' },
        actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const register = vi.spyOn(automations, 'registerHostExecutor')
  if (options.registrationFailure) register.mockImplementationOnce(() => { throw new Error('fixture executor registration failure') })
  if (options.constructorFailure) transport.construct.mockImplementationOnce(() => { throw new Error('fixture runner constructor failure') })
  vi.mocked(trust.loadTrustConfig).mockResolvedValue({ schemaVersion: 4, installationId: '00000000-0000-4000-8000-000000000001',
    dshHome: root, ledger: { id: 'ledger', path: join(statePath, 'control.sqlite') }, catalog: { id: 'catalog', path: join(root, 'catalog.json') },
    executor: { id: 'executor', version: '1', path: '/bin/true', sha256: digest, environmentAllowlist: [] },
    hostPolicy: trust.defaultHostAttestationPolicy, releaseReceiptTtlMs: 30_000, approvalKeys: [], hostAttestationKeys: [], releaseKeys: [], releaseAuthorizationKeys: [] })
  const realRuntime = options.realAdmission ? await linuxRuntimeFixture(root) : undefined
  if (realRuntime) {
    const actual = await vi.importActual<typeof import('@dsh-enhanced/assistant-isolation')>('@dsh-enhanced/assistant-isolation')
    transport.realConstruct = config => { transport.realConfig = config; return new actual.LinuxRepositoryRunner(config) }
  }
  const sourceBuild: builds.LinuxSourceBuildConfig = { ...linuxSourceConfig(), timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.dualIdentity ? repositoryIdentity() : {}), ...(options.preflightFailure ? { versioning: 'patch' as const } : {}),
    ...(realRuntime ? { ...realRuntime, stateRoot: join(root, 'native'), maxRuns: 1 } : {}) }
  const config: Config = { statePath, catalogPath: join(root, 'catalog.json'), trustPath: join(root, 'trust.json'),
    sourceBuild, sourceJobs: { authorityId: 'source-grant', expiresAt: now + 600_000, maxSubmissions: 4,
      allowedModes: ['modify'], repository, ownerRouteId: 'route', principalId: 'owner', workspace: root, preset: 'primary', budgetId: 'source-budget', budgetAmount: 1 } }
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementation(async () => checked())
  const service = new PluginControlPlaneService(ctx, config)
  if (!options.constructorFailure && !options.registrationFailure) await vi.waitFor(() => expect(service.canEnqueueSource()).toBe(true))
  const store = new ControlPlaneStore({ path: join(statePath, 'control.sqlite') })
  cleanup.push(async () => store.close())
  const gap = service.recordGap({ idempotencyKey: 'linux:gap', capability: 'health', context: 'service orchestration fixture', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  const caller = { ownerRouteId: 'route', principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  const request = { repository, gapId: gap.id, name: 'health-helper', owner: caller, files: [{ path: 'src/index.ts', content: 'export const modified = true\n' }],
    expectedBaseCommit: head, ttlMs: 900_000, idempotencyKey: 'linux:source-job', signal: new AbortController().signal, assertCurrent: () => undefined }
  const tick = async () => { now += 1_100; await automations.tick(); await automations.whenIdle() }
  return { root, ctx, config, sourceBuild, service, store, automations, policy, register, delivery, mountDelivery, request, tick }
}

it('dispatches a durable modify job exclusively through its owned Linux runner and bounded build config', async () => {
  const f = await fixture(), runner = transport.instances[0]!
  const job = await f.service.enqueueSourceJob(f.request)
  expect(f.store.getSourceJob(job.id)?.intent).toMatchObject({ nativeResource: { backend: 'linux-native', key: job.id } })
  expect(runner.config).toMatchObject({ backend: 'linux-native', runtime: f.sourceBuild.runtime,
    limits: { maxDurationMs: 60_000, maxArtifactBytes: 32 * 1024 ** 2, memoryMiB: 512, workspaceInodes: 4096 } })
  await f.tick()
  const prepared = f.store.getSourceJob(job.id)!
  expect(prepared.status).toBe('prepared')
  expect(f.store.getSourcePlan(prepared.planId!).preparedEvidence?.schemaVersion).toBe(3)
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runner, sourceJob: { id: job.id },
    config: expect.objectContaining({ backend: 'linux-native', timeoutMs: 60_000 }), name: 'health-helper' }))
  expect(builds.runDockerPreparedChecks).not.toHaveBeenCalled()
  expect(macBuild.runNativePreparedChecks).not.toHaveBeenCalled()
  expect(transport.macConstruct).not.toHaveBeenCalled()
  expect(runner.config).not.toHaveProperty('userNamespace')
  expect(runner.config).not.toHaveProperty('systemSnapshot')
})

it.skipIf(process.platform !== 'linux' || !process.getuid?.())('passes paired immutable repository metadata to the runner and the full Linux build path', async () => {
  const f = await fixture({ dualIdentity: true }), runner = transport.instances[0]!
  expect(runner.config.userNamespace).toEqual(f.sourceBuild.userNamespace)
  expect(runner.config.systemSnapshot).toEqual(f.sourceBuild.systemSnapshot)
  expect(runner.config.userNamespace?.ownerUid).toBe(process.getuid!())
  expect(runner.config.userNamespace?.ownerGid).toBe(process.getgid!())
  expect(runner.config).not.toHaveProperty('implementationDigest')
  const job = await f.service.enqueueSourceJob(f.request)
  await f.tick()
  expect(f.store.getSourceJob(job.id)?.status).toBe('prepared')
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runner,
    sourceJob: { id: job.id }, config: expect.objectContaining({ userNamespace: f.sourceBuild.userNamespace,
      systemSnapshot: f.sourceBuild.systemSnapshot, timeoutMs: 60_000 }) }))
  expect(builds.runDockerPreparedChecks).not.toHaveBeenCalled()
  expect(macBuild.runNativePreparedChecks).not.toHaveBeenCalled()
})

// Fault injection changes only the returned Host handoff, leaving the real
// persisted claim intact. Public enqueue normally freezes these values together.
it.each([[60_000, 120_000], [120_000, 60_000]])('clamps Linux request timeout %s against configured maximum %s', async (requested, maximum) => {
  const f = await fixture({ timeoutMs: maximum }), claim = ControlPlaneStore.prototype.claimSourceJob
  vi.spyOn(ControlPlaneStore.prototype, 'claimSourceJob').mockImplementationOnce(function (this: ControlPlaneStore, input) {
    const job = claim.call(this, input)
    return { ...job, intent: { ...job.intent, build: { ...job.intent.build, timeoutMs: requested } } }
  })
  const job = await f.service.enqueueSourceJob(f.request)
  await f.tick()
  expect(f.store.getSourceJob(job.id)?.status).toBe('prepared')
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ timeoutMs: Math.min(requested, maximum) }) }))
})

it.each(['backend', 'key'] as const)('rejects a corrupted Host %s binding before calling the Linux transport', async corrupt => {
  const f = await fixture(), claim = ControlPlaneStore.prototype.claimSourceJob
  vi.spyOn(ControlPlaneStore.prototype, 'claimSourceJob').mockImplementationOnce(function (this: ControlPlaneStore, input) {
    const job = claim.call(this, input)
    return { ...job, intent: { ...job.intent, nativeResource: { backend: corrupt === 'backend' ? 'macos-seatbelt' : 'linux-native',
      key: corrupt === 'key' ? `source-job-${'e'.repeat(64)}` : job.id } } }
  })
  const job = await f.service.enqueueSourceJob(f.request)
  await f.tick()
  expect(f.store.getSourceJob(job.id)?.status).toBe('unknown')
  expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
  expect(builds.runDockerPreparedChecks).not.toHaveBeenCalled()
  expect(macBuild.runNativePreparedChecks).not.toHaveBeenCalled()
})

it('rejects standalone Linux preparation without a durable source job before reaching a transport', async () => {
  const f = await fixture()
  await expect(f.service.prepareModifySourcePlan({ ...f.request, timeoutMs: 60_000 })).rejects.toThrow(/bound durable source job/)
  expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
  expect(builds.runDockerPreparedChecks).not.toHaveBeenCalled()
  expect(macBuild.runNativePreparedChecks).not.toHaveBeenCalled()
  expect(f.store.getGap(f.request.gapId).status).toBe('open')
})

it.each(['context', 'required-peer'] as const)('aborts and drains the Linux build before closing its runner on %s disposal', async removal => {
  const f = await fixture(), runner = transport.instances[0]!, events: string[] = []
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), drained = new Promise<void>(resolve => { finish = resolve })
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementationOnce(async input => {
    entered()
    await new Promise<void>(resolve => { input.signal.addEventListener('abort', () => { events.push('aborted'); resolve() }, { once: true }) })
    await drained
    events.push('drained'); input.signal.throwIfAborted(); return checked()
  })
  runner.close.mockImplementation(async () => { events.push('runner-closed') })
  const job = await f.service.enqueueSourceJob(f.request), ticking = f.tick()
  await started
  const disposing = removal === 'context' ? f.ctx.fiber.dispose() : f.delivery.dispose()
  await vi.waitFor(() => expect(events).toContain('aborted'))
  expect(runner.close).not.toHaveBeenCalled()
  expect(f.service.canEnqueueSource()).toBe(false)
  finish(); await disposing; await ticking
  expect(events).toEqual(['aborted', 'drained', 'runner-closed'])
  expect(runner.close).toHaveBeenCalledOnce()
  expect(f.store.getSourceJob(job.id)?.status).toBe('unknown')
})

it('waits for the old runner cleanup before starting a replacement, then ignores the old disposer', async () => {
  const f = await fixture(), first = transport.instances[0]!
  let releaseOld!: () => void
  const oldDrained = new Promise<void>(resolve => { releaseOld = resolve })
  first.close.mockImplementationOnce(async () => oldDrained)
  const disposingOld = f.delivery.dispose()
  await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce())
  expect(f.service.canEnqueueSource()).toBe(false)
  const replacement = f.mountDelivery()
  try {
    await replacement
    expect(f.service.canEnqueueSource()).toBe(false)
    expect(transport.instances).toHaveLength(1)
  } finally { releaseOld() }
  await disposingOld
  await vi.waitFor(() => expect(f.service.canEnqueueSource()).toBe(true))
  const second = transport.instances[1]!
  expect(second).toBeDefined(); expect(second.close).not.toHaveBeenCalled()
  expect(f.service.canEnqueueSource()).toBe(true)
  await f.delivery.dispose()
  expect(second.close).not.toHaveBeenCalled()
  await f.service.enqueueSourceJob(f.request); await f.tick()
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledWith(expect.objectContaining({ runner: second }))
  await replacement.dispose()
  expect(second.close).toHaveBeenCalledOnce()
})

it.each(['constructor', 'registration'] as const)('cleans failed %s startup before a replacement provider can register', async failure => {
  const f = await fixture(failure === 'constructor' ? { constructorFailure: true } : { registrationFailure: true })
  await vi.waitFor(() => expect(transport.construct).toHaveBeenCalledOnce())
  if (failure === 'constructor') expect(f.register).not.toHaveBeenCalled()
  else await vi.waitFor(() => expect(transport.instances[0]!.close).toHaveBeenCalledOnce())
  expect(f.service.canEnqueueSource()).toBe(false)
  await f.delivery.dispose()
  const replacement = f.mountDelivery()
  await replacement
  await vi.waitFor(() => expect(f.service.canEnqueueSource()).toBe(true))
  const job = await f.service.enqueueSourceJob(f.request)
  await f.tick()
  expect(f.store.getSourceJob(job.id)?.status).toBe('prepared')
  expect(transport.macConstruct).not.toHaveBeenCalled()
})


it('settles an observed pre-admission Host failure only after worktree cleanup, without refund or replay', async () => {
  const f = await fixture({ preflightFailure: true })
  const reserve = vi.spyOn(f.policy, 'reserve'), finalize = vi.spyOn(f.policy, 'finalize'), release = vi.spyOn(f.policy, 'release')
  const job = await f.service.enqueueSourceJob(f.request)
  const worktree = f.store.getSourceJob(job.id)!.intent.worktree
  await f.tick()
  expect(f.store.getSourceJob(job.id)).toMatchObject({ status: 'failed', failureCode: 'source-job-preparation-not-started' })
  await expect(realpath(worktree)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
  expect(reserve).toHaveBeenCalledOnce()
  expect(finalize).toHaveBeenCalledWith(expect.any(String), 1)
  expect(release).not.toHaveBeenCalled()
  await f.delivery.dispose()
  const replacement = f.mountDelivery(); await replacement
  await vi.waitFor(() => expect(f.service.canEnqueueSource()).toBe(true))
  await f.tick()
  expect(f.store.getSourceJob(job.id)?.status).toBe('failed')
  expect(reserve).toHaveBeenCalledOnce()
  expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
})

it('keeps a pre-admission failure unknown when owned worktree cleanup fails', async () => {
  const f = await fixture({ preflightFailure: true }), original = workspace.createIsolatedWorktree
  vi.spyOn(workspace, 'createIsolatedWorktree').mockImplementationOnce(async input => {
    const isolated = await original(input)
    return { ...isolated, remove: async () => { throw new Error('worktree cleanup lost acknowledgement') } }
  })
  const job = await f.service.enqueueSourceJob(f.request)
  await f.tick()
  expect(f.store.getSourceJob(job.id)?.status).toBe('unknown')
  expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
})

it.each([new Error('native preflight rejection'), Object.assign(new Error('Linux source preparation failed before execution admission'),
  { code: 'source-job-preparation-not-started', quiescent: true, notStarted: true })])('does not accept a runner mock or structurally forged negative outcome', async error => {
  const f = await fixture()
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockRejectedValueOnce(error)
  const job = await f.service.enqueueSourceJob(f.request)
  await f.tick()
  expect(f.store.getSourceJob(job.id)?.status).toBe('unknown')
})


it.skipIf(process.platform !== 'linux' || !process.getuid?.())('cleans and fails a real Git archive exceeding 64MiB before the runner is called', async () => {
  const actual = await vi.importActual<typeof linuxBuild>('../src/linux-source-build.ts')
  const f = await fixture({ oversizedArchive: true })
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementationOnce(actual.runLinuxPreparedChecks)
  const job = await f.service.enqueueSourceJob(f.request)
  const worktree = f.store.getSourceJob(job.id)!.intent.worktree
  await f.tick()
  expect(f.store.getSourceJob(job.id)).toMatchObject({ status: 'failed', failureCode: 'source-job-preparation-not-started' })
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
  // This fixture runner has no run method: reaching admission would have been an unbranded error.
  await expect(realpath(worktree)).rejects.toMatchObject({ code: 'ENOENT' })
}, 30_000)


it.skipIf(process.platform !== 'linux' || !process.getuid?.()).each(['unchanged', 'fence', 'database', 'new-call'] as const)('rechecks native refusal authority after blocked worktree cleanup: %s', async kind => {
  const actual = await vi.importActual<typeof linuxBuild>('../src/linux-source-build.ts')
  const f = await fixture({ realAdmission: true })
  const native = (f.service as unknown as { nativeSourceRunner: { runner: LinuxRepositoryRunner } }).nativeSourceRunner.runner
  await native.inspectQuiescence('ready')
  // Force a real runtime admission rejection without opening candidate setup.
  await chmod(f.sourceBuild.runtime.pnpmPath, 0o644)
  await writeFile(f.sourceBuild.runtime.pnpmPath, 'unapproved runtime bytes')
  const run = vi.spyOn(native, 'run')
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementationOnce(actual.runLinuxPreparedChecks)
  let entered!: () => void, release!: () => void
  const cleaning = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const original = workspace.createIsolatedWorktree
  vi.spyOn(workspace, 'createIsolatedWorktree').mockImplementationOnce(async input => {
    const isolated = await original(input)
    return { ...isolated, remove: async () => { entered(); await gate; await isolated.remove() } }
  })
  const job = await f.service.enqueueSourceJob(f.request), ticking = f.tick()
  await cleaning
  const dbPath = join(f.sourceBuild.stateRoot, 'ledger.sqlite')
  try {
    expect(run).toHaveBeenCalledOnce()
    if (kind === 'database') { await rename(dbPath, dbPath + '.original'); await writeFile(dbPath, '', { mode: 0o600 }) }
    if (kind === 'fence') {
      const db = new DatabaseSync(dbPath)
      try { db.prepare('UPDATE isolation_controller SET fence=fence+1').run() } finally { db.close() }
    }
    if (kind === 'new-call') {
      await native.run(job.id, run.mock.calls[0]![1], async () => { throw new Error('archive must never load') }, new AbortController().signal).catch(() => {})
      expect(run).toHaveBeenCalledTimes(2)
    }
  } finally { release() }
  try {
    await ticking
    expect(f.store.getSourceJob(job.id)?.status).toBe(kind === 'unchanged' ? 'failed' : 'unknown')
    await expect(realpath(f.store.getSourceJob(job.id)!.intent.worktree)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (kind === 'database') { await rm(dbPath); await rename(dbPath + '.original', dbPath) }
  }
}, 30_000)


it('fails the current claim when an independent source operation is already draining before admission', async () => {
  const f = await fixture(), original = workspace.createIsolatedWorktree
  const job = await f.service.enqueueSourceJob(f.request)
  let entered!: () => void, release!: () => void
  const creating = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(workspace, 'createIsolatedWorktree').mockImplementationOnce(async input => { entered(); await gate; return original(input) })
  const draining = f.service.prepareModifySourcePlan({ ...f.request, idempotencyKey: 'independent-draining' }).catch(error => error)
  await creating
  try {
    await f.tick()
    expect(f.store.getSourceJob(job.id)).toMatchObject({ status: 'failed', failureCode: 'source-job-preparation-not-started' })
    expect(workspace.createIsolatedWorktree).toHaveBeenCalledOnce()
    expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
  } finally { release(); await draining }
})


it.skipIf(process.platform !== 'linux' || !process.getuid?.())('settles a genuine rolled-back native budget rejection after cleanup and retains the charged Policy occurrence', async () => {
  const actual = await vi.importActual<typeof linuxBuild>('../src/linux-source-build.ts')
  const f = await fixture({ realAdmission: true })
  const native = (f.service as unknown as { nativeSourceRunner: { runner: LinuxRepositoryRunner } }).nativeSourceRunner.runner
  await native.inspectQuiescence('ready')
  spendLinuxRepositoryRun(transport.realConfig!)
  const run = vi.spyOn(native, 'run'), reserve = vi.spyOn(f.policy, 'reserve'), finalize = vi.spyOn(f.policy, 'finalize'), release = vi.spyOn(f.policy, 'release')
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementationOnce(actual.runLinuxPreparedChecks)
  const job = await f.service.enqueueSourceJob(f.request)
  await f.tick()
  expect(f.store.getSourceJob(job.id)).toMatchObject({ status: 'failed', failureCode: 'source-job-preparation-not-started' })
  expect(run).toHaveBeenCalledOnce()
  expect(reserve).toHaveBeenCalledOnce()
  expect(finalize).toHaveBeenCalledWith(expect.any(String), 1)
  expect(release).not.toHaveBeenCalled()
  await expect(realpath(f.store.getSourceJob(job.id)!.intent.worktree)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await native.inspectQuiescence(job.id)).toBe('unknown')
  const db = new DatabaseSync(join(f.sourceBuild.stateRoot, 'ledger.sqlite'))
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1) } finally { db.close() }
  await f.tick()
  expect(run).toHaveBeenCalledOnce()
}, 30_000)
