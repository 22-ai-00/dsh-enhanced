// 工程层、非真实供应商证据：本文件用 PATH 注入的假 pnpm 壳与临时 git 仓库
// fixture 验证隔离 worktree 编排、frozen 构建闸、modify source plan 服务入口、
// owner CLI 复验与 GC。所有构建证据都来自工程层假壳，不代表任何真实 pnpm/供应商构建。
import { generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstatSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AssistantAutomationsService, HostAutomationExecutor } from '@dsh-enhanced/assistant-automations'
import { afterAll, afterEach, beforeEach, describe as baseDescribe, expect, it, vi } from 'vitest'
import { approvalSigningPayload } from '../src/approval.ts'
import { runPluginControl } from '../src/cli.ts'
import { ControlPlaneCliError } from '../src/errors.ts'
import {
  checkedSourceSnapshot,
  createIsolatedWorktree,
  linkedWorktrees,
  PROTECTED_PLUGIN_DENYLIST,
  writeScopedPluginFiles,
} from '../src/source-workspace.ts'
import { PluginControlPlaneService } from '../src/service.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../src/store.ts'
import type { SourceBuildConfig } from '../src/source-build.ts'
import type { ApprovalReceipt, PluginSourcePlan } from '../src/types.ts'

const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const ledgerId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01'
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

const roots: string[] = []
const contexts: Context[] = []
let cachedInterpreter: { path: string; sha256: string } | undefined
let cachedInterpreterRoot: string | undefined

async function fixtureInterpreter(): Promise<{ path: string; sha256: string }> {
  if (cachedInterpreter !== undefined) return cachedInterpreter
  const sourcePath = await realpath(process.execPath)
  const root = await mkdtemp(join(tmpdir(), 'plugin-control-node-')); await chmod(root, 0o700)
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
  const root = await mkdtemp(join(tmpdir(), 'plugin-control-workspace-')); roots.push(root)
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
async function createRepositoryFixture(root: string): Promise<{ repository: string; worktree: string }> {
  const repository = join(root, 'create-repository')
  const worktree = join(root, 'create-worktree')
  await mkdir(join(repository, 'scripts'), { recursive: true })
  await mkdir(join(repository, 'plugins'), { recursive: true })
  await cp(join(repositoryRoot, 'scripts', 'create-plugin.mjs'), join(repository, 'scripts', 'create-plugin.mjs'))
  await cp(join(repositoryRoot, 'templates', 'plugin'), join(repository, 'templates', 'plugin'), { recursive: true })
  await cp(join(repositoryRoot, 'LICENSE'), join(repository, 'LICENSE'))
  await writeFile(join(repository, 'plugins', 'README.md'), '# Plugin catalog\n\n<!-- plugin-catalog:end -->\n')
  await writeFile(join(repository, '.gitignore'), 'node_modules/\npnpm-lock.yaml\n')
  await writeFile(join(repository, 'package.json'), `${JSON.stringify({ name: 'create-scaffold-fixture', private: true, type: 'module',
    scripts: { 'create:plugin': 'node ./scripts/create-plugin.mjs', check: 'node ./scripts/check-fixture.mjs' } }, null, 2)}\n`)
  await writeFile(join(repository, 'scripts', 'check-fixture.mjs'), `import { readdir } from 'node:fs/promises'
const entries = (await readdir('plugins', { withFileTypes: true })).filter(entry => entry.isDirectory())
if (entries.length !== 1) throw new Error('expected exactly one generated plugin')
`)
  execFileSync('/usr/bin/git', ['init', repository])
  execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Test'])
  execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('/usr/bin/git', ['-C', repository, 'add', '.'])
  execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-m', 'fixture'])
  execFileSync('/usr/bin/git', ['-C', repository, 'worktree', 'add', '-b', 'scaffold', worktree])
  return { repository: await realpath(repository), worktree: await realpath(worktree) }
}

class ToolsStub extends Service {
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(): void { /* the control-plane tool registrar only calls ctx.tools.register */ }
}

function makeService(value: TrustFixture, sourceBuild: Partial<SourceBuildConfig> = {}): PluginControlPlaneService {
  const ctx = new Context(); contexts.push(ctx)
  new ToolsStub(ctx)
  return new PluginControlPlaneService(ctx, {
    catalogPath: join(value.control, 'catalog.json'),
    statePath: value.statePath,
    trustPath: value.trustPath,
    sourceBuild: { dockerPath: join(value.root, 'bin', 'docker'), image: 'fixture/source-build@sha256:' + 'a'.repeat(64),
      timeoutMs: 180_000, memoryMiB: 256, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 65_536, ...sourceBuild },
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

async function prepareOkModifyPlan(value: TrustFixture, service: PluginControlPlaneService,
  repository: string, shell: { binDir: string; logPath: string }, suffix: string, ttlMs = 900_000): Promise<PluginSourcePlan> {
  const gap = await recordGap(service, suffix)
  return withEnvironment({
    DSH_HOME: value.dshHome,
    PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}`,
    DSH_TEST_PNPM_LOG: shell.logPath,
    NPM_CONFIG_FOO: 'bar',
  }, () => service.prepareModifySourcePlan({
    gapId: gap.id, name: 'health-helper', repository,
    files: [{ path: 'src/index.ts', content: '// engineering-layer patched\n' }],
    idempotencyKey: `source:modify:${suffix}`, ttlMs,
  }))
}

async function approvePlanViaCli(value: TrustFixture, shell: { binDir: string }, plan: PluginSourcePlan): Promise<void> {
  const now = Date.now()
  const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1,
    approvalId: `workspace-approval-${plan.id.slice(-8)}`, authority: 'owner-policy', keyId: 'owner-key-1',
    planId: plan.id, planDigest: plan.digest, decision: 'approved', principal: 'owner@test',
    decidedAt: now, expiresAt: now + 30_000 }
  const receipt: ApprovalReceipt = { ...unsigned,
    signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), value.privateKey).toString('base64') }
  const receiptPath = join(value.control, `workspace-approval-${plan.id.slice(-8)}.json`)
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
  await withEnvironment({
    DSH_HOME: value.dshHome,
    PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}`,
  }, () => runPluginControl(['approve', '--kind', 'source', '--plan-id', plan.id,
    '--expected-revision', String(plan.revision), '--approval-receipt', receiptPath]))
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

describe.sequential('prepared modify source workspaces (engineering-layer, not vendor evidence)', () => {
  it('late-binds durable source jobs through the default Cordis service and drains an old peer executor', async () => {
    const value = await trustFixture()
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const ctx = new Context(); contexts.push(ctx)
    new ToolsStub(ctx)
    const config = {
      catalogPath: join(value.control, 'catalog.json'), statePath: value.statePath, trustPath: value.trustPath,
      sourceBuild: { dockerPath: join(shell.binDir, 'docker'), image: 'fixture/source-build@sha256:' + 'a'.repeat(64), timeoutMs: 180_000, memoryMiB: 256, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 65_536 },
      sourceJobs: { authorityId: 'source-jobs-fixture', expiresAt: Date.now() + 60_000, maxSubmissions: 2, repository: source.repository,
        ownerRouteId: 'route-1', principalId: 'owner-1', workspace: value.root, preset: 'primary', budgetId: 'source-runs', budgetAmount: 1 },
    }
    const mounted = ctx.plugin(PluginControlPlaneService, config)
    await mounted
    const service = ctx.get('pluginControlPlane') as PluginControlPlaneService
    expect(service.canEnqueueSource()).toBe(false)

    let executor: HostAutomationExecutor | undefined
    let activation: { definitionHash: string; activationNonce: string; ownerRouteId: string } | undefined
    const automations = {
      registerHostExecutor(value: HostAutomationExecutor): () => void { executor = value; return () => { executor = undefined } },
      reconcileSystem(input: Parameters<AssistantAutomationsService['reconcileSystem']>[0]): ReturnType<AssistantAutomationsService['reconcileSystem']> {
        if (input.desiredStatus === 'paused') activation = { definitionHash: 'a'.repeat(64), activationNonce: input.definition.execution!.activationNonce, ownerRouteId: input.definition.execution!.ownerRouteId }
        return {} as ReturnType<AssistantAutomationsService['reconcileSystem']>
      },
      inspectSystemOwnedActivation(): ReturnType<AssistantAutomationsService['inspectSystemOwnedActivation']> { return activation },
      inspectSystemOwned(): ReturnType<AssistantAutomationsService['inspectSystemOwned']> {
        return { latestTerminalRuns: {} } as ReturnType<AssistantAutomationsService['inspectSystemOwned']>
      },
    } satisfies Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'inspectSystemOwnedActivation' | 'inspectSystemOwned'>
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

  it('prepares a pending modify plan with Docker-contained build evidence and independently matching digests', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const plan = await prepareOkModifyPlan(value, service, source.repository, shell, 'ok')

    expect(plan).toMatchObject({
      mode: 'modify', status: 'pending-approval', revision: 1,
      name: 'health-helper', scope: ['plugins/health-helper'], generatorDigest: MODIFY_GENERATOR_DIGEST,
      baseCommit: source.head,
    })
    expect(plan.sourceCheck?.treeDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(plan.sourceCheck?.patchDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(plan.approval).toBeUndefined()
    expect(plan.releaseAuthorization).toBeUndefined()
    expect(plan.release).toBeUndefined()
    const evidence = plan.preparedEvidence!
    expect(evidence.commands.map(command => command.command)).toEqual(['docker'])
    expect(evidence.commands.every(command => command.exitCode === 0)).toBe(true)
    expect(evidence.environment).toMatchObject({ npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true })
    expect(evidence.pack).toMatchObject({ name: 'health-helper-0.1.0.tgz', version: '0.1.0',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })

    // The prepared worktree survives success and recomputes to identical digests.
    const metadata = await lstat(plan.worktree)
    expect(metadata.isDirectory()).toBe(true)
    const recomputed = await checkedSourceSnapshot(plan.worktree, plan.baseCommit, plan.scope, process.env)
    expect(recomputed).toEqual({ checkedTreeDigest: plan.sourceCheck!.treeDigest, checkedPatchDigest: plan.sourceCheck!.patchDigest })

    const database = openDatabase(value.state)
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM source_plans').get() as { count: number }).toMatchObject({ count: 1 })
      const gap = database.prepare('SELECT status, candidate_id FROM capability_gaps WHERE id = ?').get(plan.gapId) as
        { status: string; candidate_id: string | null }
      // Gap reservation for source plans is recorded through gap_plan_claims;
      // the activation-only candidate_id column stays NULL for source plans.
      expect(gap).toEqual({ status: 'matched', candidate_id: null })
      const claim = database.prepare('SELECT plan_id, plan_kind FROM gap_plan_claims WHERE gap_id = ?').get(plan.gapId) as
        { plan_id: string; plan_kind: string }
      expect(claim).toEqual({ plan_id: plan.id, plan_kind: 'source' })
    } finally { database.close() }

    // The fake Docker fixture receives only the archive stream; no host pnpm
    // executable is invoked by the control plane.
    await expect(readFile(shell.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it.each(['install', 'check', 'pack'] as const)('destroys the worktree and writes no plan when frozen %s fails', async phase => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const gap = await recordGap(service, `fail-${phase}`)
    // Replace the owner-configured Docker executable itself. The runner passes
    // no proposal/process environment into the container client.
    await executable(join(shell.binDir, 'docker'), '#!/usr/bin/bash\nif [[ "${1:-}" == "container" ]]; then exit 1; fi\ncat >/dev/null\nexit 29\n')
    await expect(withEnvironment({
      DSH_HOME: value.dshHome,
      PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}`,
      DSH_TEST_PNPM_LOG: shell.logPath,
      DSH_TEST_PNPM_FAIL: phase,
    }, () => service.prepareModifySourcePlan({
      gapId: gap.id, name: 'health-helper', repository: source.repository,
      files: [{ path: 'src/index.ts', content: '// boom\n' }],
      idempotencyKey: `source:modify:fail-${phase}`,
    }))).rejects.toMatchObject({ code: 'EXECUTOR_FAILED' } as Partial<ControlPlaneCliError>)

    // The isolated worktree (and its transient pack dir) is fully removed.
    const remaining = await readdir(join(value.statePath, 'source-worktrees')).catch(() => [])
    expect(remaining.some(name => name.startsWith('worktree-') || name.startsWith('pack-'))).toBe(false)
    const database = openDatabase(value.state)
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM source_plans').get() as { count: number }).toMatchObject({ count: 0 })
      const row = database.prepare('SELECT status, candidate_id FROM capability_gaps WHERE id = ?').get(gap.id) as
        { status: string; candidate_id: string | null }
      expect(row).toEqual({ status: 'open', candidate_id: null })
    } finally { database.close() }
  }, 30_000)

  it('fails closed when Docker cannot prove the named container is absent', async () => {
    const value = await trustFixture(); const service = makeService(value); const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root); const gap = await recordGap(service, 'cleanup-daemon')
    await executable(join(shell.binDir, 'docker'), `#!/usr/bin/bash
if [[ "\${1:-}" == 'container' && "\${2:-}" == 'ls' ]]; then exit 1; fi
if [[ "\${1:-}" == 'run' ]]; then cat >/dev/null; printf 'DSH_PREPARED_PACK\\thealth-helper-0.1.0.tgz\\t13\\t%s\\tv22.0.0\\t11.0.0\\n' "$(printf 'd%.0s' {1..64})"; fi
exit 0
`)
    await expect(service.prepareModifySourcePlan({ gapId: gap.id, name: 'health-helper', repository: source.repository,
      files: [{ path: 'src/index.ts', content: '// cleanup\n' }], idempotencyKey: 'source:modify:cleanup-daemon' }))
      .rejects.toMatchObject({ code: 'EXECUTOR_FAILED' } as Partial<ControlPlaneCliError>)
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
    await expect(service.prepareModifySourcePlan({ ...base, timeoutMs: 240_001 }))
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

  it('persists full Docker evidence for an owner-selected repository build and enforces its caller ceiling', async () => {
    const value = await trustFixture()
    const service = makeService(value, { profile: 'repository', timeoutMs: 1_800_000 })
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const gap = await recordGap(service, 'repository-budget')
    const input = { gapId: gap.id, name: 'health-helper', repository: source.repository,
      files: [{ path: 'src/index.ts', content: '// owner repository build\n' }], idempotencyKey: 'source:repository-budget' }
    await expect(service.prepareModifySourcePlan({ ...input, timeoutMs: 1_800_001 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const plan = await withEnvironment({ DSH_HOME: value.dshHome, PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}` },
      () => service.prepareModifySourcePlan({ ...input, timeoutMs: 1_800_000 }))
    expect(plan.status).toBe('pending-approval')
    const args = plan.preparedEvidence!.commands[0]!.args
    expect(args.length).toBeGreaterThan(32)
    expect(args).toContain('CI=true')
    expect(args.some(arg => arg.startsWith('dsh.source.tree='))).toBe(true)
    expect(args.at(-1)).toContain('checked check pnpm check')
    const store = new ControlPlaneStore({ path: value.state })
    try { expect(store.getSourcePlan(plan.id).preparedEvidence).toEqual(plan.preparedEvidence) } finally { store.close() }
  }, 30_000)

  it('advances a clean matching approved modify plan to ready via owner CLI verify-prepared', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const plan = await prepareOkModifyPlan(value, service, source.repository, shell, 'cli-verify-ok')
    await approvePlanViaCli(value, shell, plan)

    const output = await withEnvironment({ DSH_HOME: value.dshHome, PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}` },
      () => runPluginControl(['source', 'verify-prepared', '--plan-id', plan.id, '--expected-revision', '2']))
    expect(output).toBeUndefined()
    // The approve call also wrote a receipt to the mocked stdout above; the
    // last operation line in this test is the verify-prepared receipt.
    const receiptLine = (vi.mocked(process.stdout.write).mock.calls.map(call => String(call[0]))
      .filter(line => line.includes('"operation"')).at(-1) ?? '').trim()
    const receipt = JSON.parse(receiptLine) as { operation: string; result: PluginSourcePlan }
    expect(receipt.operation).toBe('source-verify-prepared')
    expect(receipt.result).toMatchObject({ status: 'ready-for-human-review', revision: 3 })
    const database = openDatabase(value.state)
    try {
      const row = database.prepare('SELECT status, revision FROM source_plans WHERE id = ?').get(plan.id) as
        { status: string; revision: number }
      expect(row).toEqual({ status: 'ready-for-human-review', revision: 3 })
    } finally { database.close() }
  }, 30_000)

  it.each([
    ['HEAD drift', async (worktree: string) => {
      execFileSync('/usr/bin/git', ['-C', worktree, 'commit', '--allow-empty', '-m', 'drift'])
    }],
    ['a file outside the plugin scope', async (worktree: string) => {
      await writeFile(join(worktree, 'plugins', 'EVIL.md'), 'outside\n')
    }],
    ['changed patch content', async (worktree: string) => {
      await writeFile(join(worktree, 'plugins', 'health-helper', 'src', 'index.ts'), '// drifted content\n')
    }],
    ['a removed worktree', async (worktree: string) => {
      await rm(worktree, { recursive: true, force: true })
    }],
  ] as const)('rejects verify-prepared on %s without changing the approved revision', async (_label, damage) => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const plan = await prepareOkModifyPlan(value, service, source.repository, shell, `cli-drift-${_label.replaceAll(' ', '-')}`)
    const worktree = plan.worktree
    await approvePlanViaCli(value, shell, plan)
    await damage(worktree)
    await expect(withEnvironment({ DSH_HOME: value.dshHome, PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}` },
      () => runPluginControl(['source', 'verify-prepared', '--plan-id', plan.id, '--expected-revision', '2']))).rejects.toThrow()
    if (_label !== 'a removed worktree') {
      const database = openDatabase(value.state)
      try {
        const row = database.prepare('SELECT status, revision FROM source_plans WHERE id = ?').get(plan.id) as
          { status: string; revision: number }
        expect(row).toEqual({ status: 'approved', revision: 2 })
      } finally { database.close() }
    }
  }, 30_000)

  it('cross-rejects scaffold for modify and verify-prepared for create plans', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const modifySource = await modifyRepositoryFixture(value.root)
    const modifyPlan = await prepareOkModifyPlan(value, service, modifySource.repository, shell, 'cross-modify')
    await approvePlanViaCli(value, shell, modifyPlan)
    await expect(withEnvironment({ DSH_HOME: value.dshHome, PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}` },
      () => runPluginControl(['scaffold', '--plan-id', modifyPlan.id, '--expected-revision', '2'])))
      .rejects.toThrow('modify plans are verified')

    // A create plan approved through the owner CLI must be locally scaffolded,
    // never verify-prepared.
    const createSource = await createRepositoryFixture(value.root)
    const createGap = await recordGap(service, 'cross-create')
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['source-plan', '--gap-id', createGap.id,
      '--repository', createSource.repository, '--worktree', createSource.worktree,
      '--name', 'health-helper', '--idempotency-key', 'scaffold-plan:cross-create']))
    const database = openDatabase(value.state)
    let createId: string
    try {
      createId = (database.prepare('SELECT id FROM source_plans WHERE gap_id = ?').get(createGap.id) as { id: string }).id
    } finally { database.close() }
    const inspect = new ControlPlaneStore({ path: value.state })
    const createPlan = inspect.getSourcePlan(createId); inspect.close()
    await approvePlanViaCli(value, shell, createPlan)
    await expect(withEnvironment({ DSH_HOME: value.dshHome, PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}` },
      () => runPluginControl(['source', 'verify-prepared', '--plan-id', createId, '--expected-revision', '2'])))
      .rejects.toThrow('only serves modify source plans')
  }, 30_000)

  it('garbage-collects only expired linked worktrees inside the state root, retaining ready plans', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const stateWorktreeRoot = join(value.statePath, 'source-worktrees')

    // Unexpired pending plan: retained even under a far-future GC sweep.
    const fresh = await prepareOkModifyPlan(value, service, source.repository, shell, 'gc-fresh', 86_400_000)
    expect((await service.gcPreparedSourceWorktrees(Date.now())).removed).toEqual([])
    expect((await lstat(fresh.worktree)).isDirectory()).toBe(true)

    // Expired pending plan: removed and unregistered.
    const expired = await prepareOkModifyPlan(value, service, source.repository, shell, 'gc-expired', 900_000)
    let removed = await service.gcPreparedSourceWorktrees(expired.expiresAt + 1)
    expect(removed.removed).toContain(resolve(expired.worktree))
    expect(service.gaps(50).find(gap => gap.id === expired.gapId)?.status).toBe('open')
    const expiredStore = new ControlPlaneStore({ path: value.state })
    try { expect(expiredStore.getSourcePlan(expired.id)).toMatchObject({ status: 'expired', revision: 2 }) }
    finally { expiredStore.close() }
    await expect(lstat(expired.worktree)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await linkedWorktrees(source.repository, process.env)).includes(resolve(expired.worktree))).toBe(false)
    // Idempotent.
    removed = await service.gcPreparedSourceWorktrees(expired.expiresAt + 1)
    expect(removed.removed).toEqual([])

    // Expired approved plan: also collected.
    const approvedExpired = await prepareOkModifyPlan(value, service, source.repository, shell, 'gc-approved', 900_000)
    await approvePlanViaCli(value, shell, approvedExpired)
    expect((await service.gcPreparedSourceWorktrees(approvedExpired.expiresAt + 1)).removed)
      .toContain(resolve(approvedExpired.worktree))

    // Ready plan, however far past its TTL: retained for the owner release flow.
    const ready = await prepareOkModifyPlan(value, service, source.repository, shell, 'gc-ready', 900_000)
    await approvePlanViaCli(value, shell, ready)
    await withEnvironment({ DSH_HOME: value.dshHome, PATH: `${shell.binDir}${delimiter}${process.env.PATH ?? ''}` },
      () => runPluginControl(['source', 'verify-prepared', '--plan-id', ready.id, '--expected-revision', '2']))
    expect((await service.gcPreparedSourceWorktrees(ready.expiresAt + 10_000_000)).removed).toEqual([])
    expect((await lstat(ready.worktree)).isDirectory()).toBe(true)

    // A plan row whose worktree points outside the state root is never touched.
    const rogueStore = new ControlPlaneStore({ path: value.state })
    const rogueGap = rogueStore.recordGap({ idempotencyKey: 'gap:workspace:gc-rogue', capability: 'health',
      context: 'rogue', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    rogueStore.createSourcePlan({ gapId: rogueGap.id, repository: source.repository,
      worktree: join(value.root, 'outside-state', 'worktree-rogue'), baseCommit: source.head,
      name: 'health-helper', generatorDigest: MODIFY_GENERATOR_DIGEST, scope: ['plugins/health-helper'],
      mode: 'modify', ttlMs: 900_000, idempotencyKey: 'source:modify:gc-rogue',
      prepared: { treeDigest: 'a'.repeat(64), patchDigest: 'b'.repeat(64), checkedAt: Date.now(),
        evidence: minimalPreparedEvidence('c'.repeat(64), Date.now()) } })
    rogueStore.close()
    expect((await service.gcPreparedSourceWorktrees(Date.now() + 10_000_000)).removed).toEqual([])

    // A path inside the state root that is not a linked worktree is retained too.
    const ghost = join(stateWorktreeRoot, 'worktree-ghost')
    await mkdir(ghost, { recursive: true, mode: 0o700 })
    const ghostStore = new ControlPlaneStore({ path: value.state })
    const ghostGap = ghostStore.recordGap({ idempotencyKey: 'gap:workspace:gc-ghost', capability: 'health',
      context: 'ghost', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    ghostStore.createSourcePlan({ gapId: ghostGap.id, repository: source.repository, worktree: ghost,
      baseCommit: source.head, name: 'health-helper', generatorDigest: MODIFY_GENERATOR_DIGEST,
      scope: ['plugins/health-helper'], mode: 'modify', ttlMs: 900_000, idempotencyKey: 'source:modify:gc-ghost',
      prepared: { treeDigest: 'd'.repeat(64), patchDigest: 'e'.repeat(64), checkedAt: Date.now(),
        evidence: minimalPreparedEvidence('f'.repeat(64), Date.now()) } })
    ghostStore.close()
    expect((await service.gcPreparedSourceWorktrees(Date.now() + 10_000_000)).removed).toEqual([])
    expect((await lstat(ghost)).isDirectory()).toBe(true)

    // The fresh plan from above is still present and linked throughout.
    expect((await service.gcPreparedSourceWorktrees(Date.now() + 10_000_000)).removed).toEqual([])
    expect((await lstat(fresh.worktree)).isDirectory()).toBe(true)
  }, 60_000)

  it('binds source inspection to preparation and rejects stale HEAD before creating a worktree', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const inspection = await service.inspectSource({ repository: source.repository, name: 'health-helper', paths: ['src/index.ts'] })
    const gap = await recordGap(service, 'inspected')
    const input = { gapId: gap.id, name: 'health-helper', repository: source.repository,
      expectedBaseCommit: inspection.baseCommit, files: [{ path: 'src/index.ts', content: '// replacement\n' }], idempotencyKey: 'source:inspected' }
    execFileSync('/usr/bin/git', ['-C', source.repository, 'commit', '--allow-empty', '-m', 'new head'])
    await expect(service.prepareModifySourcePlan(input)).rejects.toThrow('stale')
    expect(await linkedWorktrees(source.repository, process.env)).toEqual([source.repository])
    expect(service.gaps(50).find(row => row.id === gap.id)?.candidateId).toBeUndefined()
    const fresh = await service.inspectSource({ repository: source.repository, name: 'health-helper', paths: ['src/index.ts'] })
    const plan = await service.prepareModifySourcePlan({ ...input, expectedBaseCommit: fresh.baseCommit })
    expect(plan.baseCommit).toBe(fresh.baseCommit)
    expect(plan.status).toBe('pending-approval')
    expect(execFileSync('/usr/bin/git', ['-C', plan.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(fresh.baseCommit)
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

  it('rejects concurrent preparations and drains worktree cleanup before Fiber disposal completes', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const ctx = contexts.pop()!
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const gap = await recordGap(service, 'dispose')
    await executable(join(shell.binDir, 'docker'), `#!/bin/sh
if [ "$1" = run ]; then
  cat >/dev/null
  : > "$0.started"
  exec /bin/sleep 60
fi
exit 0
`)
    const input = { gapId: gap.id, name: 'health-helper', repository: source.repository,
      files: [{ path: 'src/index.ts', content: '// pending\n' }], idempotencyKey: 'source:modify:dispose' }
    const preparation = service.prepareModifySourcePlan(input)
    const settled = preparation.then(() => undefined, error => error)
    try {
      await vi.waitFor(async () => { expect((await lstat(join(shell.binDir, 'docker.started'))).isFile()).toBe(true) })
      await expect(service.prepareModifySourcePlan({ ...input, idempotencyKey: 'source:modify:overlap' })).rejects.toThrow(/still draining/)
    } finally { await ctx.fiber.dispose() }
    expect(await settled).toBeInstanceOf(Error)
    expect(await readdir(join(value.statePath, 'source-worktrees'))).toEqual([])
    expect(await linkedWorktrees(source.repository, process.env)).toEqual([source.repository])
    const db = openDatabase(value.state)
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM source_plans').get()).toMatchObject({ count: 0 }) }
    finally { db.close() }
  })

  it('exposes owner CLI source gc as thin JSON wrapper', async () => {
    const value = await trustFixture()
    const service = makeService(value)
    const shell = await installFakePnpm(value.root)
    const source = await modifyRepositoryFixture(value.root)
    const plan = await prepareOkModifyPlan(value, service, source.repository, shell, 'cli-gc', 900_000)
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['source', 'gc']))
    const before = (vi.mocked(process.stdout.write).mock.calls.map(call => String(call[0]))
      .find(line => line.includes('"removed"')) ?? '').trim()
    expect(JSON.parse(before)).toEqual({ removed: [] })

    const output = await withEnvironment({ DSH_HOME: value.dshHome },
      () => runPluginControl(['source', 'gc']))
    expect(output).toBeUndefined()
    // After expiry the same owner command reaps the worktree.
    const gc = await service.gcPreparedSourceWorktrees(plan.expiresAt + 1)
    expect(gc.removed).toContain(resolve(plan.worktree))
  }, 30_000)
})
