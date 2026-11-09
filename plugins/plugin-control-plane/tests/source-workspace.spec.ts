// 工程层、非真实供应商证据：本文件用 PATH 注入的假 pnpm 壳与临时 git 仓库
// fixture 验证隔离 worktree 编排、frozen 构建闸、modify source plan 服务入口、
// owner CLI 复验与 GC。所有构建证据都来自工程层假壳，不代表任何真实 pnpm/供应商构建。
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { lstatSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import { automationDefinitionDigest, type AssistantAutomationsService, type HostAutomationExecutor } from '@dsh-enhanced/assistant-automations'
import { afterAll, afterEach, beforeEach, describe as baseDescribe, expect, it, vi } from 'vitest'
import { ControlPlaneCliError } from '../src/errors.ts'
import {
  createIsolatedWorktree,
  gcPreparedModifyWorktrees,
  linkedWorktrees,
  OWNER_REPAIR_PROTECTED_PLUGIN_DENYLIST,
  preparedWorktreeIsGarbage,
  PROTECTED_PLUGIN_DENYLIST,
  writeScopedPluginFiles,
} from '../src/source-workspace.ts'
import { PluginControlPlaneService } from '../src/service.ts'
import { linuxSourceConfig } from './helpers/linux-source-build-fixture.ts'
import { ControlPlaneStore } from '../src/store.ts'
import type { SourceBuildConfig } from '../src/source-build.ts'
import type { SourceJobsConfig } from '../src/source-job-types.ts'
import type { PluginSourcePlan } from '../src/types.ts'

const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const ledgerId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01'

const roots: string[] = []
const contexts: Context[] = []
let cachedInterpreter: { path: string; sha256: string } | undefined
let cachedInterpreterRoot: string | undefined

async function fixtureInterpreter(): Promise<{ path: string; sha256: string }> {
  if (cachedInterpreter !== undefined) return cachedInterpreter
  const sourcePath = await realpath(process.execPath)
  const root = await mkdtemp(join(await realpath(tmpdir()), 'plugin-control-node-')); await chmod(root, 0o700)
  const path = join(root, 'node')
  await copyFile(sourcePath, path); await chmod(path, 0o700)
  cachedInterpreterRoot = root
  const { createHash } = await import('node:crypto')
  cachedInterpreter = { path: await realpath(path), sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
  return cachedInterpreter
}

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8'); await chmod(path, 0o700)
}

// Schema-v2 owner trust fixture, modeled on tests/cli.spec.ts: the allowlist is
// narrowed to the keys the engineering-layer pnpm shell and frozen-build checks
// need (NPM_CONFIG_FOO deliberately proves exogenous npm_config_* stripping).
async function trustFixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'plugin-control-workspace-')); roots.push(root)
  const dshHome = join(root, 'dsh')
  const profile = join(dshHome, 'profiles', 'web')
  const control = join(dshHome, 'plugin-control')
  const statePath = join(control, 'plans')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await mkdir(statePath, { recursive: true, mode: 0o700 })
  await chmod(control, 0o700)
  const state = join(statePath, 'control.sqlite')

  const executor = join(root, 'dsh-executor')
  await executable(executor, `#!/usr/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '%s\\n' '0.1.0-rc.8'; exit 0; fi
exit 0
`)
  const keys = generateKeyPairSync('ed25519')
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

  const attestorDirectory = join(root, 'host-attestor-state'); await mkdir(attestorDirectory, { mode: 0o700 })
  await writeFile(join(attestorDirectory, 'private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const now = Date.now()
  await writeFile(join(attestorDirectory, 'observations.json'), JSON.stringify({
    reload: { service: 'fixture-host' }, readiness: { checks: 1, failures: 0 },
    effectBlockedReplay: { deliveryAttempts: 1, deliveryBlocked: 1, toolExecutionAttempts: 1, toolExecutionBlocked: 1, externalEffects: 0 },
    shadow: { samples: 1, mismatches: 0, externalEffects: 0 }, canary: { samples: 1, failures: 0 },
    soak: { windowStartedAt: now - 2_000, windowEndedAt: now - 1_000, samples: 1, failures: 0 },
    health: { checks: 1, failures: 0 },
  }), { mode: 0o600 })
  const interpreter = await fixtureInterpreter()
  const attestor = join(root, 'host-attestor')
  await executable(attestor, (await readFile(new URL('./fixtures/host-attestor.mjs', import.meta.url), 'utf8'))
    .replace('#!/usr/bin/env node', `#!${interpreter.path}`))

  const { createHash } = await import('node:crypto')
  const executorSha = createHash('sha256').update(await readFile(executor)).digest('hex')
  const attestorSha = createHash('sha256').update(await readFile(attestor)).digest('hex')
  const trustPath = join(control, 'trust.json')
  const trust = {
    schemaVersion: 2, installationId, dshHome, ledger: { id: ledgerId, path: state },
    executor: { id: 'test-dsh', version: '0.1.0-rc.8', path: executor, sha256: executorSha,
      environmentAllowlist: ['PATH', 'DSH_HOME', 'DSH_TEST_PNPM_LOG', 'DSH_TEST_PNPM_FAIL', 'NPM_CONFIG_FOO'] },
    hostPolicy: { readinessMinimumChecks: 1, effectBlockedMinimumDeliveryAttempts: 1,
      effectBlockedMinimumToolExecutionAttempts: 1, shadowMinimumSamples: 1, shadowMaximumMismatches: 0,
      canaryMinimumSamples: 1, canaryMaximumFailures: 0, soakMinimumWindowMs: 1,
      soakMinimumSamples: 1, soakMaximumFailureRate: 0, healthMinimumChecks: 1, healthMaximumFailures: 0, receiptTtlMs: 30_000 },
    hostAttestor: { id: 'fixture-host-attestor', version: 'fixture-host-attestor-1', path: attestor, sha256: attestorSha,
      interpreter, environmentAllowlist: ['HOST_ATTESTOR_FIXTURE_DIR'],
      authority: 'host-runtime', keyId: 'host-key-1', timeoutMs: 10_000 },
    approvalKeys: [{ authority: 'owner-policy', keyId: 'owner-key-1', publicKeyPem }],
    hostAttestationKeys: [{ authority: 'host-runtime', keyId: 'host-key-1', publicKeyPem }],
  }
  await writeFile(trustPath, `${JSON.stringify(trust)}\n`, { mode: 0o600 }); await chmod(trustPath, 0o600)
  return { root, dshHome, control, statePath, state, trustPath, privateKey: keys.privateKey, trust }
}

type TrustFixture = Awaited<ReturnType<typeof trustFixture>>

// Engineering-layer fake pnpm shell (NOT vendor evidence): a regular 0700 bash
// script injected through PATH. It answers --version, succeeds install/check,
// emits a pure-file-name tarball for pack, records argv plus the npm_config_*
// environment for frozen-build assertions, and can force any phase to fail via
// DSH_TEST_PNPM_FAIL.
const FAKE_PNPM = `#!/usr/bin/bash
log="\${DSH_TEST_PNPM_LOG:-}"
record_call() {
  if [[ -n "$log" ]]; then
    {
      printf 'ARGS:%s\\n' "$*"
      env | sort | grep -i '^npm_config_' | sed 's/^/ENV:/' || true
    } >> "$log"
  fi
}
case "\${1:-}" in
  --version)
    printf '%s\\n' '9.0.0-fixture'
    exit 0
    ;;
  install|check)
    record_call "$@"
    if [[ "\${DSH_TEST_PNPM_FAIL:-}" == "$1" ]]; then
      printf 'engineering-layer forced %s failure\\n' "$1" >&2
      exit 29
    fi
    exit 0
    ;;
  pack)
    record_call "$@"
    if [[ "\${DSH_TEST_PNPM_FAIL:-}" == 'pack' ]]; then
      printf 'engineering-layer forced pack failure\\n' >&2
      exit 29
    fi
    dest="$3"
    mkdir -p "$dest"
    printf 'fake-tarball\\n' > "$dest/health-helper-0.1.0.tgz"
    printf '%s\\n' 'health-helper-0.1.0.tgz'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`

// Engineering-only Docker fixture. It consumes the archive from stdin and
// emits the runner's fixed evidence marker; it never executes fixture source.
const FAKE_DOCKER = `#!/usr/bin/bash
if [[ "\${1:-}" == 'container' && "\${2:-}" == 'inspect' ]]; then exit 1; fi
if [[ "\${1:-}" == 'run' ]]; then
  cat >/dev/null
  if [[ -n "\${DSH_TEST_PNPM_FAIL:-}" ]]; then exit 29; fi
  printf 'DSH_PREPARED_PACK\\thealth-helper-0.1.0.tgz\\t13\\t%s\\tv22.0.0\\t11.0.0\\n' "$(printf 'd%.0s' {1..64})"
fi
exit 0
`

async function installFakePnpm(root: string): Promise<{ binDir: string; logPath: string }> {
  // The shell's parent directory is this 0700 fixture dir, which passes the
  // owner/non-symlink/non-writable parent checks of resolveLocalExecutable.
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  await executable(join(binDir, 'pnpm'), FAKE_PNPM)
  await executable(join(binDir, 'docker'), FAKE_DOCKER)
  const logPath = join(root, 'pnpm-calls.log')
  return { binDir, logPath }
}

// Temporary git repository holding an existing plugins/health-helper plugin.
async function modifyRepositoryFixture(root: string): Promise<{ repository: string; head: string }> {
  const repository = join(root, 'repository')
  await mkdir(join(repository, 'plugins', 'health-helper', 'src'), { recursive: true, mode: 0o700 })
  await writeFile(join(repository, 'package.json'), `${JSON.stringify({ name: 'modify-fixture', private: true }, null, 2)}\n`)
  await writeFile(join(repository, '.gitignore'), 'node_modules/\npnpm-lock.yaml\n')
  await writeFile(join(repository, 'plugins', 'health-helper', 'package.json'),
    `${JSON.stringify({ name: '@dsh-enhanced/health-helper', version: '0.1.0' }, null, 2)}\n`)
  await writeFile(join(repository, 'plugins', 'health-helper', 'src', 'index.ts'), '// original health helper\n')
  execFileSync('/usr/bin/git', ['init', repository])
  execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Test'])
  execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('/usr/bin/git', ['-C', repository, 'add', '.'])
  execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-m', 'fixture'])
  const head = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return { repository: await realpath(repository), head }
}

// The create-plan CLI cross-check needs the generator/template assets and a
// pre-created linked worktree, exactly like tests/cli.spec.ts.

class ToolsStub extends Service {
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(): void { /* the control-plane tool registrar only calls ctx.tools.register */ }
}

function makeService(value: TrustFixture, sourceBuild: Partial<SourceBuildConfig> = {}, sourceJobs?: SourceJobsConfig): PluginControlPlaneService {
  const ctx = new Context(); contexts.push(ctx)
  new ToolsStub(ctx)
  return new PluginControlPlaneService(ctx, {
    catalogPath: join(value.control, 'catalog.json'),
    statePath: value.statePath,
    trustPath: value.trustPath,
    sourceBuild: { ...linuxSourceConfig(), stateRoot: join(value.root, 'native-state'), expiresAt: Date.now() + 600_000,
      maxTotalDurationMs: 1_800_000, timeoutMs: 180_000, outputBytes: 65_536, ...sourceBuild } as SourceBuildConfig,
    sourceJobs: sourceJobs ?? { authorityId: 'source-jobs-fixture', expiresAt: Date.now() + 600_000, maxSubmissions: 2,
      repository: value.root, ownerRouteId: 'route-1', principalId: 'owner-1', workspace: value.root,
      preset: 'primary', budgetId: 'source-runs', budgetAmount: 1 } as SourceJobsConfig,
  })
}

async function withEnvironment<T>(environment: Record<string, string>, action: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment)
  try { return await action() } finally {
    for (const [key, given] of previous) { if (given === undefined) delete process.env[key]; else process.env[key] = given }
  }
}

function openDatabase(state: string): DatabaseSync {
  return new DatabaseSync(state)
}

// Minimal structurally-valid prepared evidence for rows the GC tests insert
// directly (their worktrees are never built, so evidence content is irrelevant
// to collection decisions).
function minimalPreparedEvidence(packSha: string, now: number) {
  return { schemaVersion: 1 as const, kind: 'dsh-source-prepared-evidence' as const,
    environment: { npmConfigIgnoreScripts: true as const, frozenLockfile: true as const, offline: true,
      nodeVersion: process.versions.node, pnpmVersion: '9.0.0-fixture' },
    commands: [{ command: 'pnpm', args: ['check'], exitCode: 0 as const, durationMs: 1,
      logDigest: '0'.repeat(64) }],
    pack: { name: 'health-helper-0.1.0.tgz', version: '0.1.0', sizeBytes: 1, sha256: packSha },
    preparedAt: now }
}

async function recordGap(service: PluginControlPlaneService, suffix: string) {
  return service.recordGap({ idempotencyKey: `gap:workspace:${suffix}`, capability: 'health',
    context: `engineering-layer gap ${suffix}`, expectedValue: 100, frequency: 10, estimatedCost: 50, risk: 0.2 })
}



const rootOwnsSystemDirs = process.platform === 'linux' && lstatSync('/usr/bin', { bigint: true }).uid === 0n
const describe = rootOwnsSystemDirs ? baseDescribe : baseDescribe.skip

beforeEach(() => { vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write) })
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
afterAll(async () => { if (cachedInterpreterRoot !== undefined) await rm(cachedInterpreterRoot, { recursive: true, force: true }) })

describe('protected plugin boundaries', () => {
  it('the owner-repair denylist stays a strict subset of the growth-proposal denylist', () => {
    for (const name of OWNER_REPAIR_PROTECTED_PLUGIN_DENYLIST) {
      expect(PROTECTED_PLUGIN_DENYLIST.has(name), name).toBe(true)
    }
    expect(PROTECTED_PLUGIN_DENYLIST.size).toBeGreaterThan(OWNER_REPAIR_PROTECTED_PLUGIN_DENYLIST.size)
  })

  it('keeps growth machinery out of model-authored proposals but available to owner repair', () => {
    expect(PROTECTED_PLUGIN_DENYLIST.has('assistant-growth-driver')).toBe(true)
    expect(PROTECTED_PLUGIN_DENYLIST.has('assistant-recovery')).toBe(true)
    expect(OWNER_REPAIR_PROTECTED_PLUGIN_DENYLIST.has('assistant-growth-driver')).toBe(false)
    expect(OWNER_REPAIR_PROTECTED_PLUGIN_DENYLIST.has('assistant-recovery')).toBe(false)
  })
})

describe.sequential('prepared modify source workspaces (engineering-layer, not vendor evidence)', () => {
  it('late-binds durable source jobs through the default Cordis service and drains an old peer executor', async () => {
    const value = await trustFixture()
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const ctx = new Context(); contexts.push(ctx)
    new ToolsStub(ctx)
    const config = {
      catalogPath: join(value.control, 'catalog.json'), statePath: value.statePath, trustPath: value.trustPath,
      sourceBuild: { ...linuxSourceConfig(), stateRoot: join(value.root, 'late-binding-state'), expiresAt: Date.now() + 600_000,
        maxTotalDurationMs: 1_800_000, timeoutMs: 180_000, outputBytes: 65_536 },
      sourceJobs: { authorityId: 'source-jobs-fixture', expiresAt: Date.now() + 60_000, maxSubmissions: 2, repository: source.repository,
        ownerRouteId: 'route-1', principalId: 'owner-1', workspace: value.root, preset: 'primary', budgetId: 'source-runs', budgetAmount: 1 },
    }
    const mounted = ctx.plugin(PluginControlPlaneService, config)
    await mounted
    const service = ctx.get('pluginControlPlane') as PluginControlPlaneService
    expect(service.canEnqueueSource()).toBe(false)

    let executor: HostAutomationExecutor | undefined
    let activation: { definitionHash: string; activationNonce: string; ownerRouteId: string } | undefined
    let automationStatus: 'active' | 'paused' = 'paused'
    let definitionVersion = 0
    const automations = {
      registerHostExecutor(value: HostAutomationExecutor): () => void { executor = value; return () => { executor = undefined } },
      reconcileSystem(input: Parameters<AssistantAutomationsService['reconcileSystem']>[0]): ReturnType<AssistantAutomationsService['reconcileSystem']> {
        const definitionHash = automationDefinitionDigest(input.definition)
        const desiredStatus = input.desiredStatus ?? 'active'
        if (activation?.definitionHash !== definitionHash || automationStatus !== desiredStatus) definitionVersion += 1
        activation = { definitionHash, activationNonce: input.definition.execution!.activationNonce, ownerRouteId: input.definition.execution!.ownerRouteId }
        automationStatus = desiredStatus
        return {} as ReturnType<AssistantAutomationsService['reconcileSystem']>
      },
      reconcileSystemExact(): never { throw new Error('modify lifecycle fixture must not rearm task-created plugins') },
      pauseSystemOwned(): never { throw new Error('modify lifecycle fixture must not revoke a Growth producer') },
      inspectSystemOwnedActivation(): ReturnType<AssistantAutomationsService['inspectSystemOwnedActivation']> { return activation },
      inspectSystemOwned(): ReturnType<AssistantAutomationsService['inspectSystemOwned']> {
        return { latestTerminalRuns: {}, definitionHash: activation?.definitionHash,
          definitionVersion, automationStatus } as ReturnType<AssistantAutomationsService['inspectSystemOwned']>
      },
    } satisfies Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'reconcileSystemExact' | 'pauseSystemOwned' | 'inspectSystemOwnedActivation' | 'inspectSystemOwned'>
    const delivery = { validateOwnerRoute: () => ({ receiptVersion: 2 as const, authorityId: 'route-1', authorityHash: 'b'.repeat(64), principalId: 'owner-1',
      principalRecordId: 'record-1', principalVersion: 1, workspace: value.root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }) }
    const peer = ctx.plugin({ name: 'source-jobs-peers', apply(peerCtx) {
      peerCtx.provide('assistantAutomations' as never, automations as never)
      peerCtx.provide('assistantDelivery' as never, delivery as never)
    } })
    await peer
    await vi.waitFor(() => expect(service.canEnqueueSource()).toBe(true))
    const gap = await recordGap(service, 'durable-late-bind')
    const job = await service.enqueueSourceJob({ gapId: gap.id, name: 'health-helper', repository: source.repository,
      files: [{ path: 'src/index.ts', content: '// queued only\n' }], idempotencyKey: 'durable:late-bind', expectedBaseCommit: source.head, ttlMs: 900_000,
      owner: { ownerRouteId: 'route-1', principalId: 'owner-1', principalRecordId: 'record-1', principalVersion: 1, workspace: value.root, preset: 'primary' },
      signal: new AbortController().signal, assertCurrent: () => undefined })
    expect(job.status).toBe('queued')
    expect(executor).toBeDefined()
    expect(await readFile(shell.logPath, 'utf8').catch(() => '')).toBe('')
    const captured = executor!
    await peer.dispose()
    expect(service.canEnqueueSource()).toBe(false)
    const result = await captured.execute({ occurrenceId: 'old-peer', automationId: job.id, definitionHash: activation!.definitionHash,
      executionMode: 'production', targetScope: { workspace: value.root, preset: 'primary' }, principal: 'owner-1', ownerRouteId: 'route-1',
      activationNonce: activation!.activationNonce, catalogDigest: captured.descriptor.catalogDigest, signal: new AbortController().signal })
    expect(result.outcome).toBe('failed')
    await ctx.fiber.dispose()
  })

  it('rejects scoped file paths that escape, duplicate or exceed the bounds', async () => {
    const value = await trustFixture()
    const source = await modifyRepositoryFixture(value.root)
    const isolated = await createIsolatedWorktree({ stateRoot: join(value.root, 'unit-state'),
      repository: source.repository, baseCommit: source.head, environment: process.env })
    try {
      const rejects: Array<[string, Parameters<typeof writeScopedPluginFiles>[0]['files']]> = [
        ['a parent traversal', [{ path: '../evil.ts', content: 'x' }]],
        ['an absolute path', [{ path: '/etc/evil.ts', content: 'x' }]],
        ['a backslash path', [{ path: 'src\\evil.ts', content: 'x' }]],
        ['an empty path segment', [{ path: 'src//evil.ts', content: 'x' }]],
        ['a dot segment', [{ path: 'src/./evil.ts', content: 'x' }]],
        ['an empty file set', []],
        ['too many files', Array.from({ length: 65 }, (_, index) => ({ path: `f-${index}.ts`, content: 'x' }))],
        ['a file past the 64KiB bound', [{ path: 'src/index.ts', content: 'x'.repeat(65_537) }]],
        ['a set past the 256KiB total bound', Array.from({ length: 5 }, (_, index) =>
          ({ path: `big-${index}.ts`, content: 'x'.repeat(60_000) }))],
        ['a parent directory that does not exist', [{ path: 'src/missing/evil.ts', content: 'x' }]],
      ]
      for (const [, files] of rejects) {
        await expect(writeScopedPluginFiles({ worktree: isolated.worktree, name: 'health-helper', files }))
          .rejects.toMatchObject({ message: expect.stringContaining('plugin-control-plane[') })
      }
      await expect(writeScopedPluginFiles({ worktree: isolated.worktree, name: 'health-helper',
        files: [{ path: 'src/index.ts', content: 'a' }, { path: 'src/index.ts', content: 'b' }] }))
        .rejects.toThrow('duplicate prepared file path')
      await expect(writeScopedPluginFiles({ worktree: isolated.worktree, name: 'missing-plugin',
        files: [{ path: 'index.ts', content: 'x' }] })).rejects.toThrow('root must already exist')

      // A symlinked target is refused even though it sits inside the plugin tree.
      const linkPath = join(isolated.worktree, 'plugins', 'health-helper', 'link.ts')
      await symlink(join(isolated.worktree, 'plugins', 'health-helper', 'src', 'index.ts'), linkPath)
      await expect(writeScopedPluginFiles({ worktree: isolated.worktree, name: 'health-helper',
        files: [{ path: 'link.ts', content: 'x' }] })).rejects.toThrow('symlinked source path is forbidden')

      // A legitimate bounded write lands on disk through O_NOFOLLOW.
      await writeScopedPluginFiles({ worktree: isolated.worktree, name: 'health-helper',
        files: [{ path: 'src/index.ts', content: '// engineered\n' }] })
      expect(await readFile(join(isolated.worktree, 'plugins', 'health-helper', 'src', 'index.ts'), 'utf8'))
        .toBe('// engineered\n')
    } finally { await isolated.remove() }
  }, 30_000)

  it('fails closed on standalone native preparation without a durable source job', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const gap = await recordGap(service, 'standalone-native')
    await expect(withEnvironment({ DSH_HOME: value.dshHome, PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}` },
      () => service.prepareModifySourcePlan({ gapId: gap.id, name: 'health-helper', repository: source.repository,
        files: [{ path: 'src/index.ts', content: '// standalone\n' }], idempotencyKey: 'source:modify:standalone' })))
      .rejects.toThrow(/bound durable source job/)
    expect(openDatabase(value.state).prepare('SELECT count(*) AS n FROM source_plans').get()).toEqual({ n: 0 })
  }, 30_000)

  it('refuses protected safety-root plugin names, invalid names, bad bounds and non-open gaps', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)

    for (const name of PROTECTED_PLUGIN_DENYLIST) {
      const gap = await recordGap(service, `deny-${name}`)
      await expect(withEnvironment({ DSH_HOME: value.dshHome, PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}` },
        () => service.prepareModifySourcePlan({ gapId: gap.id, name, repository: source.repository,
          files: [{ path: 'src/index.ts', content: 'x' }], idempotencyKey: `source:modify:deny:${name}` })))
        .rejects.toMatchObject({ code: 'SOURCE_BOUNDARY' } as Partial<ControlPlaneCliError>)
    }

    const badNameGap = await recordGap(service, 'bad-name')
    await expect(service.prepareModifySourcePlan({ gapId: badNameGap.id, name: 'Bad-Name',
      repository: source.repository, files: [{ path: 'src/index.ts', content: 'x' }],
      idempotencyKey: 'source:modify:bad-name' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' } as Partial<ControlPlaneCliError>)

    const boundGap = await recordGap(service, 'bounds')
    const base = { gapId: boundGap.id, name: 'health-helper', repository: source.repository,
      files: [{ path: 'src/index.ts', content: 'x' }] as const, idempotencyKey: 'source:modify:bounds' }
    await expect(service.prepareModifySourcePlan({ ...base, ttlMs: 899_999 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' } as Partial<ControlPlaneCliError>)
    await expect(service.prepareModifySourcePlan({ ...base, ttlMs: 86_400_001 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' } as Partial<ControlPlaneCliError>)
    await expect(service.prepareModifySourcePlan({ ...base, timeoutMs: 59_999 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' } as Partial<ControlPlaneCliError>)
    await expect(service.prepareModifySourcePlan({ ...base, timeoutMs: 1_800_001 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' } as Partial<ControlPlaneCliError>)

    // A closed gap cannot receive a proposal. The store only closes gaps
    // through activation bookkeeping, so flip the row directly.
    const closedGap = await recordGap(service, 'closed')
    const database = openDatabase(value.state)
    try {
      database.prepare("UPDATE capability_gaps SET status = 'closed' WHERE id = ?").run(closedGap.id)
    } finally { database.close() }
    await expect(service.prepareModifySourcePlan({ gapId: closedGap.id, name: 'health-helper',
      repository: source.repository, files: [{ path: 'src/index.ts', content: 'x' }],
      idempotencyKey: 'source:modify:closed' })).rejects.toMatchObject({ code: 'SOURCE_BOUNDARY' } as Partial<ControlPlaneCliError>)
  }, 60_000)

  it('collects only registered, expired prepared-create worktrees with exact frozen scope', async () => {
    const value = await trustFixture()
    const source = await modifyRepositoryFixture(value.root)
    const stateRoot = join(value.statePath, 'source-worktrees')
    const durable = await createIsolatedWorktree({ stateRoot, repository: source.repository,
      baseCommit: source.head, environment: process.env, worktreeName: `worktree-job-${'a'.repeat(64)}` })
    const now = Date.now()
    const name = 'owner-created-tool'
    const plan = {
      id: 'prepared-create-gc', revision: 1, mode: 'prepared-create', status: 'pending-approval',
      repository: source.repository, worktree: durable.worktree, baseCommit: source.head, name,
      expiresAt: now - 1, scope: [`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml'],
      generatorDigest: 'b'.repeat(64), creation: { generatorDigest: 'b'.repeat(64),
        grant: { id: 'owner-create-1', expiresAt: now + 100_000, maxCreates: 1, namePrefix: 'owner-created-' } },
      sourceCheck: { treeDigest: 'c'.repeat(64), patchDigest: 'd'.repeat(64), checkedAt: now - 2 },
      preparedEvidence: minimalPreparedEvidence('e'.repeat(64), now - 2),
    } as unknown as PluginSourcePlan
    const expired: string[] = []
    const collectArtifacts = vi.fn((time: number) => {
      expect(time).toBe(now)
      expect(expired).toEqual([plan.id])
      expect(() => lstatSync(durable.worktree)).toThrow()
      return 1
    })
    const store = { listPreparedSourcePlans: () => [plan], expirePreparedSourcePlan: ({ planId }: { planId: string }) => {
      expired.push(planId); return plan
    }, deleteExpiredPreparedSourceArtifacts: collectArtifacts } as unknown as ControlPlaneStore
    expect(preparedWorktreeIsGarbage(plan, now)).toBe(true)
    expect(await gcPreparedModifyWorktrees({ store, statePath: value.statePath, environment: process.env, now }))
      .toEqual({ removed: [durable.worktree] })
    expect(expired).toEqual([plan.id])
    expect(collectArtifacts).toHaveBeenCalledOnce()
    await expect(lstat(durable.worktree)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await linkedWorktrees(source.repository, process.env)).not.toContain(durable.worktree)

    const ghost = join(stateRoot, `worktree-job-${'f'.repeat(64)}`)
    await mkdir(ghost, { mode: 0o700 })
    const ghostPlan = { ...plan, id: 'unregistered', worktree: ghost } as PluginSourcePlan
    const ghostStore = { listPreparedSourcePlans: () => [ghostPlan], expirePreparedSourcePlan: () => {
      throw new Error('unregistered worktree must not expire')
    }, deleteExpiredPreparedSourceArtifacts: vi.fn(() => 0) } as unknown as ControlPlaneStore
    expect(await gcPreparedModifyWorktrees({ store: ghostStore, statePath: value.statePath, environment: process.env, now }))
      .toEqual({ removed: [] })
    expect((await lstat(ghost)).isDirectory()).toBe(true)

    for (const changed of [
      { scope: [`plugins/${name}`, 'plugins/README.md'] },
      { creation: { ...plan.creation!, generatorDigest: 'f'.repeat(64) } },
      { status: 'ready-for-human-review' as const },
    ]) expect(preparedWorktreeIsGarbage({ ...plan, ...changed }, now)).toBe(false)
    const { sourceCheck: _missingEvidence, ...withoutCheck } = plan
    expect(preparedWorktreeIsGarbage(withoutCheck, now)).toBe(false)
  }, 30_000)

  it('owns target inspection through cancellation and Fiber teardown', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const source = await modifyRepositoryFixture(value.root)
    expect(await service.inspectSourceTargets({ repository: source.repository })).toEqual({
      baseCommit: source.head, plugins: [{ name: 'health-helper' }],
    })
    const ctx = contexts.pop()!
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const input = { repository: source.repository, assertCurrent: () => paused }
    const inspecting = service.inspectSourceTargets(input).catch(error => error)
    await expect(service.inspectSourceTargets(input)).rejects.toThrow('still draining')
    let disposed = false
    const disposing = ctx.fiber.dispose().then(() => { disposed = true })
    await disposing
    expect(disposed).toBe(true)
    release()
    expect(await inspecting).toBeInstanceOf(Error)
    await expect(service.inspectSourceTargets(input)).rejects.toThrow()
  })

  it('starts the inspection deadline before awaiting a stalled authority fence', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      expect(ms).toBe(15_000)
      return deadline.signal
    })
    const inspection = service.inspectSource({ repository: value.root, name: 'health-helper', paths: [],
      assertCurrent: () => new Promise<void>(() => {}) }).catch(error => error)
    expect(timeout).toHaveBeenCalledOnce()
    await new Promise(resolve => setImmediate(resolve))
    deadline.abort(new Error('inspection deadline'))
    expect((await inspection).message).toBe('inspection deadline')
    await contexts.pop()!.fiber.dispose()
  })

  it('tracks inspection from admission through async Fiber teardown', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const ctx = contexts.pop()!
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const input = { repository: value.root, name: 'health-helper', paths: [], assertCurrent: () => paused }
    const inspecting = service.inspectSource(input).catch(error => error)
    await expect(service.inspectSource(input)).rejects.toThrow('still draining')
    let disposed = false
    const disposing = ctx.fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    await disposing
    expect(disposed).toBe(true)
    release()
    expect(await inspecting).toBeInstanceOf(Error)
    await expect(service.inspectSource(input)).rejects.toThrow()
  })


})
