// Real Git, SQLite, signing and job admission. External release adapters and
// native automation scheduling are fixtures; no production release is claimed.
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SystemAutomationReconcileInput } from '@dsh-enhanced/assistant-automations'
import { afterEach, expect, it, vi } from 'vitest'
import * as release from '../src/release.ts'
import { resolveSourceBaseline } from '../src/source-baseline.ts'
import { inspectSourceContext } from '../src/source-context.ts'
import { SourceJobRuntime } from '../src/source-jobs.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import { sourceBaselineRelease } from './helpers/source-baseline.ts'
import { cleanupReleaseFixtures } from './helpers/source-release-runner.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
const roots: string[] = []
afterEach(async () => {
  await cleanupReleaseFixtures()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('continues through two signed durable releases and queues from the recovered final Git baseline', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-baseline-integration-'))); roots.push(root)
  const repository = join(root, 'source'), remote = join(root, 'release.git')
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(root, 'init', '-q', '-b', 'main', repository)
  git(repository, 'config', 'user.email', 'fixture@example.invalid'); git(repository, 'config', 'user.name', 'Fixture')
  const file = join(repository, 'plugins/health-helper/src/index.ts')
  await mkdir(join(repository, 'plugins/health-helper/src'), { recursive: true })
  const commits: string[] = []
  for (let n = 0; n < 3; n++) {
    await writeFile(file, `export const version = ${n}\n`)
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', `version ${n}`)
    commits.push(git(repository, 'rev-parse', 'HEAD'))
  }
  const [initial, firstMerge, secondMerge] = commits as [string, string, string]
  git(root, 'clone', '--bare', repository, remote); await chmod(remote, 0o700)
  git(repository, 'checkout', '--detach', initial)
  await writeFile(file, '// unfinished user edit\n')
  const first = await sourceBaselineRelease({ repository, baseCommit: initial, mergeCommit: firstMerge })
  git(remote, 'update-ref', 'refs/heads/repairs', firstMerge)
  const config = { ref: 'refs/dsh-source/repairs', remote, targetBranch: 'repairs', initialCommit: initial }
  const signal = new AbortController().signal, assertCurrent = async () => {}
  const input = { repository, config, signal, assertCurrent, environment: process.env, trust: first.trust,
    readHistory: () => first.store.getSourceBaselineHistory(repository) }
  expect(await resolveSourceBaseline(input)).toBe(firstMerge)
  await first.completeNext({ baseCommit: firstMerge, mergeCommit: secondMerge, managed: true })
  git(remote, 'update-ref', 'refs/heads/repairs', secondMerge, firstMerge)
  expect(first.store.getSourceBaselineHistory(repository)).toHaveLength(2)

  const reopened = new ControlPlaneStore({ path: first.trust.ledger.path })
  let runtime: SourceJobRuntime | undefined
  try {
    expect(await resolveSourceBaseline({ ...input, readHistory: () => reopened.getSourceBaselineHistory(repository) })).toBe(secondMerge)
    const inspection = await inspectSourceContext({ repository, name: 'health-helper', paths: ['src/index.ts'],
      baselineCommit: secondMerge, baseCommit: secondMerge, signal, assertCurrent, environment: process.env })
    expect(inspection.baseCommit).toBe(secondMerge)
    const owner = { ownerRouteId: 'route', principalId: 'owner', principalRecordId: 'record', principalVersion: 1,
      workspace: root, preset: 'primary' }
    const receipt = { receiptVersion: 2 as const, authorityId: owner.ownerRouteId, authorityHash: 'a'.repeat(64),
      principalId: owner.principalId, principalRecordId: owner.principalRecordId, principalVersion: 1,
      workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
    const activations = new Map<string, { definitionHash: string; activationNonce: string; ownerRouteId: string }>()
    const automations = {
      registerHostExecutor: () => () => {},
      reconcileSystem: (request: SystemAutomationReconcileInput) => {
        if (!request.definition.execution) throw new Error('Host execution expected')
        activations.set(request.automationId, { definitionHash: controlPlaneDigest(request.definition),
          activationNonce: request.definition.execution.activationNonce, ownerRouteId: request.definition.execution.ownerRouteId })
        return {}
      },
      inspectSystemOwnedActivation: (request: { automationId: string }) => activations.get(request.automationId),
      inspectSystemOwned: () => ({ latestTerminalRuns: {} }),
    }
    const trust = { ...first.trust, dshHome: root, executor: { environmentAllowlist: [] } } as unknown as PluginControlTrustConfig
    runtime = new SourceJobRuntime({ config: { authorityId: 'baseline-jobs', expiresAt: Date.now() + 600_000,
      maxSubmissions: 3, repository, baseline: config, ownerRouteId: 'route', principalId: 'owner', workspace: root,
      preset: 'primary', budgetId: 'source', budgetAmount: 1 },
      build: { dockerPath: '/usr/bin/docker', image: `fixture@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
        memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
      statePath: first.root, store: reopened, ports: { automations: automations as never, delivery: { validateOwnerRoute: () => receipt } },
      trust: async () => trust, prepare: async () => { throw new Error('admission test must not execute a build') } })
    runtime.start()
    const gap = reopened.recordGap({ idempotencyKey: 'next-gap', capability: 'health', context: 'new ordinary task',
      expectedValue: 2, frequency: 1, estimatedCost: 1, risk: 0 })
    const jobInput = { repository, gapId: gap.id, name: 'health-helper', owner, signal, assertCurrent,
      files: [{ path: 'src/index.ts', content: 'export const version = 3\n' }], ttlMs: 900_000, idempotencyKey: 'next-job' }
    await expect(runtime.enqueue({ ...jobInput, expectedBaseCommit: firstMerge })).rejects.toThrow(/stale/u)
    const job = await runtime.enqueue({ ...jobInput, expectedBaseCommit: secondMerge })
    expect(reopened.getSourceJob(job.id)?.intent).toMatchObject({ baseCommit: secondMerge, baseline: config })
    expect(job.status).toBe('queued')
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(initial)
    expect(await readFile(file, 'utf8')).toBe('// unfinished user edit\n')
  } finally { await runtime?.close(); reopened.close() }
}, 30_000)
