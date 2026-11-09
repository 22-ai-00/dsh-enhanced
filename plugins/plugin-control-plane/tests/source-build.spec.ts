// Host admission and native backend configuration. Docker-backed builds were
// removed; these tests pin the synchronous Config checks and the Linux
// repository dispatch contract that shared creation proof relies on.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { validateNativeMacRuntime } from '@dsh-enhanced/assistant-isolation'
import { validateSourceBuildConfig, verifySourcePreparation, type SourceBuildConfig } from '../src/source-build.ts'
import { inspectSourceCreationContext, prepareCreatedPluginWorkspace, type SourceCreationGrant } from '../src/source-creation.ts'
import { createIsolatedWorktree } from '../src/source-workspace.ts'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.ts'

import { runLinuxPreparedChecks } from '../src/linux-source-build.js'
import { linuxSourceConfig, linuxMockRunner } from './helpers/linux-source-build-fixture.js'

vi.mock('@dsh-enhanced/assistant-isolation', async importOriginal => {
  const actual = await importOriginal<typeof import('@dsh-enhanced/assistant-isolation')>()
  return { ...actual, verifyLinuxRuntime: vi.fn(async value => value) }
})

const indices = vi.hoisted(() => [] as string[])
const indexHook = vi.hoisted(() => ({ run: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: async (prefix: string) => {
    const path = await actual.mkdtemp(prefix)
    if (prefix.includes('dsh-source-build-index-')) { indices.push(path); await indexHook.run?.() }
    return path
  } }
})

const roots: string[] = []
const worktrees: Array<{ remove: () => Promise<void> }> = []
afterEach(async () => { indexHook.run = undefined; indices.length = 0; for (const worktree of worktrees.splice(0).reverse()) await worktree.remove(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('keeps synchronous native Config validation strict and aligned with the executor shape check', () => {
  const runtime = { schemaVersion: 1 as const, platform: `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64',
    nodePath: '/approved/node/bin/node', nodeSha256: 'a'.repeat(64), modulesPath: '/approved/modules',
    roots: [{ path: '/approved/node', dev: 1, ino: 2, sha256: 'b'.repeat(64) },
      { path: '/approved/modules', dev: 3, ino: 4, sha256: 'c'.repeat(64) }],
    versions: { node: 'v24.22.0', typescript: '6.0.3', cordis: '1', tools: '1', systemPrompt: '1' } }
  const config = { backend: 'macos-seatbelt' as const, runtime, stateRoot: '/approved/state',
    authorityDigest: 'd'.repeat(64), expiresAt: Date.now() + 60_000, maxRuns: 2,
    maxTotalDurationMs: 120_000, timeoutMs: 60_000, outputBytes: 1_048_576 }
  expect(() => validateNativeMacRuntime(runtime)).not.toThrow()
  expect(() => validateSourceBuildConfig(config)).not.toThrow()
  const malformed: unknown[] = [
    { ...runtime, unexpected: true },
    { ...runtime, platform: 'linux-arm64' },
    { ...runtime, nodePath: '/other/node' },
    { ...runtime, modulesPath: '/other/modules' },
    { ...runtime, nodeSha256: 'A'.repeat(64) },
    { ...runtime, roots: [{ ...runtime.roots[0], dev: -1 }, runtime.roots[1]] },
    { ...runtime, roots: [{ ...runtime.roots[0], ino: 1.5 }, runtime.roots[1]] },
    { ...runtime, roots: [runtime.roots[0], runtime.roots[0]] },
    { ...runtime, roots: [{ ...runtime.roots[0], path: '/approved/../node' }, runtime.roots[1]] },
    { ...runtime, versions: { ...runtime.versions, unexpected: '1' } },
  ]
  for (const candidate of malformed) {
    expect(() => validateNativeMacRuntime(candidate)).toThrow('invalid native runtime')
    expect(() => validateSourceBuildConfig({ ...config, runtime: candidate } as SourceBuildConfig))
      .toThrow('native source runtime configuration is invalid')
  }
})

it('rejects the removed Docker build configuration synchronously', () => {
  const legacy = { dockerPath: '/usr/bin/docker', image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 512, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 4_096 }
  expect(() => validateSourceBuildConfig(legacy as unknown as SourceBuildConfig))
    .toThrow(/requires a native backend|native source build configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...legacy, backend: 'docker' } as unknown as SourceBuildConfig))
    .toThrow(/requires a native backend|native source build configuration is invalid/)
})

async function creationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-builder-create-'))); roots.push(root)
  const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
  const { repository, baseCommit } = await createSourceCreationFixture(sourceRoot, join(root, 'repository'))
  const environment = { ...process.env, HOME: root }
  const isolated = await createIsolatedWorktree({ stateRoot: join(root, 'state'), repository, baseCommit, environment })
  worktrees.push(isolated)
  const signal = new AbortController().signal
  const name = 'rsi-build-proof'
  const grant: SourceCreationGrant = { id: 'owner-build-proof', expiresAt: Date.now() + 120_000,
    maxCreates: 1, namePrefix: 'rsi-build-' }
  const view = await inspectSourceCreationContext({ repository, name, paths: ['src/index.ts'], baseCommit,
    environment, signal, assertCurrent: () => undefined, grant })
  const creation = { grant, generatorDigest: view.generatorDigest }
  const prepared = await prepareCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
    files: [{ path: 'README.md', content: '# Created build proof\n' }], environment, signal,
    assertCurrent: () => undefined, creation })
  return { root, repository, worktree: isolated.worktree, name, baseCommit, scope: prepared.scope,
    creation, input: { worktree: isolated.worktree, baseCommit, name, scope: prepared.scope,
      environment, signal, assertCurrent: async () => {}, preparedAt: Date.now(), creation } }
}

// Each case copies the public generator inputs, commits a real Git baseline,
// creates an isolated worktree and runs the frozen Node plugin generator.
const creationProofTestTimeoutMs = 60_000

it('preserves real creation proof and trusted baseline in Linux repository dispatch', async () => {
  const f = await creationFixture(), config = linuxSourceConfig()
  const { runner, run } = linuxMockRunner(config, request => {
    expect(request.argv).toContain('DSH_SOURCE_TRUST_LOCKFILE=true')
    expect(request.argv).toContain(`DSH_SOURCE_BASE_LOCK_SHA256=${createHash('sha256').update(
      execFileSync('/usr/bin/git', ['show', `${f.baseCommit}:pnpm-lock.yaml`], { cwd: f.repository })).digest('hex')}`)
  })
  const input = { ...f.input, config, runner, sourceJob: { id: 'source-job-' + '1'.repeat(64) } }
  // The real creation proof and exact scope are portable Host contracts.
  await verifySourcePreparation(input)
  await expect(verifySourcePreparation({ ...input, scope: [`plugins/${f.name}`] })).rejects.toThrow(/scope differs/u)
  if (process.platform !== 'linux') {
    await expect(runLinuxPreparedChecks(input)).rejects.toThrow('Linux source build durable authority is invalid')
    expect(run).not.toHaveBeenCalled()
    return
  }
  const result = await runLinuxPreparedChecks(input)
  expect(result.evidence.schemaVersion).toBe(3)
  expect(result.evidence.pack.version).toBe('0.1.0')
  expect(run).toHaveBeenCalledOnce()
  await expect(runLinuxPreparedChecks({ ...input, scope: [`plugins/${f.name}`] })).rejects.toThrow(/scope differs/u)
}, creationProofTestTimeoutMs)
