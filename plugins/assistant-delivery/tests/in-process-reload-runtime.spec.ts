import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createInProcessReloadRuntime,
  type InProcessReloadRuntimeTarget,
} from '../src/in-process-reload-runtime.js'

/**
 * Exercised against the real pinned Loader + Include in a temporary profile, so
 * the probe assertions run on the actual `Entry`/`Fiber`/`EntryTree` surface the
 * Host uses. Anything the pinned Loader cannot do in-process (re-import changed
 * plugin code) is deliberately out of scope here and is refused by the control
 * plane's artifact-digest check.
 */

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  delete (globalThis as { __dshInProcessReloadTrace?: unknown }).__dshInProcessReloadTrace
})

const digest = (fill: string) => fill.repeat(64)

const profileYaml = (option: number) => `- id: candidate\n  name: reload-fixture\n  config:\n    option: ${option}\n`

const target = (overrides: Partial<InProcessReloadRuntimeTarget> = {}): InProcessReloadRuntimeTarget => ({
  package: 'reload-fixture',
  version: '1.0.0',
  artifactDigest: digest('a'),
  patchDigest: digest('b'),
  changesProcessSubtree: false,
  holdsUnprovenProcessAuthority: false,
  ...overrides,
})

type Trace = string[]
const traceOf = () => (globalThis as { __dshInProcessReloadTrace?: Trace }).__dshInProcessReloadTrace ?? []

interface FixtureOptions {
  package?: string
  withLoader?: boolean
  withInclude?: boolean
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-ipr-'))
  const profile = join(root, 'profile')
  const packageDir = join(profile, 'node_modules', 'reload-fixture')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'reload-fixture', type: 'module', exports: './index.js' }))
  // The fixture plugin records its own lifecycle through a Cordis effect so the
  // test can prove the old config's disposer completed before the probe observed
  // the new mount. A config-only reload restarts the same fiber in place: Cordis
  // disposes the effects, then re-runs `apply`, without emitting `dispose`.
  await writeFile(join(packageDir, 'index.js'), [
    'export default {',
    "  name: 'reload-fixture',",
    '  apply(ctx, config) {',
    '    globalThis.__dshInProcessReloadTrace ??= []',
    "    globalThis.__dshInProcessReloadTrace.push(`apply:${config.option}`)",
    '    ctx.effect(() => () => {',
    "      globalThis.__dshInProcessReloadTrace.push(`dispose:${config.option}`)",
    '    })',
    '  },',
    '}',
  ].join('\n'))
  const profileFile = join(profile, 'cordis.yml')
  await writeFile(profileFile, profileYaml(1))
  const ctx = new Context()
  fixtures.push({ ctx, root })
  if (options.withLoader !== false) {
    const loaderFiber = ctx.plugin(Loader)
    await loaderFiber
    if (options.withInclude !== false) {
      // The DSH Host installs `loader.internal.import` so profile entries resolve
      // bare package names from the profile directory. The pinned Loader alone
      // resolves bare specifiers from its own install location, which cannot see
      // a temporary profile, so the harness supplies the same Host seam.
      ;(ctx.loader as unknown as { internal?: unknown }).internal = {
        import: (name: string, baseUrl: string) => import(new URL(`./node_modules/${name}/index.js`, baseUrl).href),
      }
      ctx.loader.builtins.include = Include
      // The pinned Loader types `create()` without an explicit `id` (the runtime
      // assigns one when omitted), but the include id is part of the entry's
      // identity; the harness passes it the way the Host profile does.
      await ctx.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(profileFile).href } } as unknown as Parameters<typeof ctx.loader.create>[0])
      await ctx.loader.await()
    }
  }
  let hostGeneration = 3
  const writeProfile = (option: number) => writeFile(profileFile, profileYaml(option))
  const runtime = createInProcessReloadRuntime(ctx, {
    profilePath: profile,
    entryId: 'include:candidate',
    package: options.package ?? 'reload-fixture',
    hostGeneration: () => hostGeneration,
    apply: () => writeProfile(2),
  })
  return {
    ctx, root, profile, profileFile, runtime,
    writeProfile,
    trace: traceOf,
    bumpHostGeneration: () => { hostGeneration += 1 },
    resolve: (id: string) => ctx.loader.resolve(id),
    activation: (overrides: Partial<Parameters<typeof runtime.activate>[0]> = {}) => ({
      warrantDigest: digest('c'), target: target(), previousHostGeneration: 3, previousInProcessGeneration: 1, ...overrides,
    }),
  }
}

describe('in-process reload runtime on the pinned Loader', () => {
  test('reloads a changed profile patch and proves effect disposal ordering', async () => {
    const f = await fixture()
    const before = f.resolve('include:candidate')
    const result = await f.runtime.activate(f.activation())

    expect(result).toMatchObject({
      previousHostGeneration: 3, currentHostGeneration: 3,
      previousInProcessGeneration: 1, currentInProcessGeneration: 2,
    })
    expect(result.probe.failures).toBe(0)
    expect(result.probe.failedChecks).toEqual([])
    expect(result.probe.reloaded).toBe(true)
    // A config-only reload restarts the fiber in place: no fiber is disposed.
    expect(result.probe.fibersDisposed).toBe(0)
    expect(result.probe.checks).toBeGreaterThanOrEqual(9)
    expect(result.probe.probeDigest).toMatch(/^[a-f0-9]{64}$/u)

    // The process generation is the Host's and did not move; only the adapter's
    // own in-process generation advanced.
    expect(f.runtime.snapshot()).toEqual({ hostGeneration: 3, inProcessGeneration: 2 })

    const after = f.resolve('include:candidate')
    // The same fiber is restarted, not replaced; its store is rebuilt.
    expect(after.fiber).toBe(before.fiber)
    expect(after.fiber!.uid).toBe(before.fiber!.uid)
    expect(after.fiber!.state).toBe(2)
    // Effects of the old config were disposed before `apply` ran with the new one.
    expect(f.trace()).toEqual(['apply:1', 'dispose:1', 'apply:2'])
  })

  test('never claims a reload when the profile patch did not change', async () => {
    const f = await fixture()
    const runtime = createInProcessReloadRuntime(f.ctx, {
      profilePath: f.profile, entryId: 'candidate', package: 'reload-fixture',
      hostGeneration: () => 3, apply: () => undefined,
    })
    const before = f.resolve('include:candidate')
    const result = await runtime.activate(f.activation())

    // Include.refresh() returns early on unchanged content, so nothing restarted:
    // the honest outcome is a failed probe, which the control plane maps to
    // rollback-pending. The attempt still consumes an in-process generation.
    expect(result.probe.reloaded).toBe(false)
    expect(result.probe.failures).toBeGreaterThan(0)
    expect(result.probe.failedChecks).toContain('profile-changed')
    expect(result.probe.fibersDisposed).toBe(0)
    expect(result.currentInProcessGeneration).toBe(2)
    expect(f.resolve('include:candidate').fiber!.uid).toBe(before.fiber!.uid)
    expect(f.trace()).toEqual(['apply:1'])
  })

  test('refuses out-of-scope targets and invalid warrants without touching the tree', async () => {
    const f = await fixture()
    const before = f.resolve('include:candidate')
    await expect(f.runtime.activate(f.activation({ warrantDigest: 'not-a-digest' })))
      .rejects.toThrow('warrant digest is invalid')
    await expect(f.runtime.activate(f.activation({ target: target({ package: 'other-package' }) })))
      .rejects.toThrow('is not the mounted package')
    await expect(f.runtime.activate(f.activation({ target: target({ changesProcessSubtree: true }) })))
      .rejects.toThrow('requires a process restart')
    await expect(f.runtime.activate(f.activation({ target: target({ holdsUnprovenProcessAuthority: true }) })))
      .rejects.toThrow('requires a process restart')
    expect(f.resolve('include:candidate').fiber!.uid).toBe(before.fiber!.uid)
    expect(f.runtime.snapshot().inProcessGeneration).toBe(1)
  })

  test('refuses a warrant bound to another Host process generation', async () => {
    const f = await fixture()
    await expect(f.runtime.activate(f.activation({ previousHostGeneration: 2 })))
      .rejects.toThrow('bound to another Host generation')
    f.bumpHostGeneration()
    expect(f.runtime.snapshot().hostGeneration).toBe(4)
    await expect(f.runtime.activate(f.activation())).rejects.toThrow('bound to another Host generation')
  })

  test('requires both the Loader service and the profile include root', async () => {
    const withoutLoader = await fixture({ withLoader: false })
    await expect(withoutLoader.runtime.activate(withoutLoader.activation()))
      .rejects.toThrow('Loader service is not available')

    const withoutInclude = await fixture({ withInclude: false })
    await expect(withoutInclude.runtime.activate(withoutInclude.activation()))
      .rejects.toThrow('include root is not mounted')
  })

  test('rolls back only after the caller proves a restored profile', async () => {
    const f = await fixture()
    await f.runtime.activate(f.activation())
    const rollback = createInProcessReloadRuntime(f.ctx, {
      profilePath: f.profile, entryId: 'include:candidate', package: 'reload-fixture',
      hostGeneration: () => 3,
      restore: () => f.writeProfile(1),
    })
    const result = await rollback.rollback({ warrantDigest: digest('c'), target: target(), reloadedInProcessGeneration: 2 })
    expect(result).toMatchObject({
      hostGeneration: 3, inProcessGeneration: 2, profileRestored: true, restored: true,
    })
    expect(result.probe.failures).toBe(0)
    expect(result.probe.reloaded).toBe(true)
    expect(f.trace()).toEqual(['apply:1', 'dispose:1', 'apply:2', 'dispose:2', 'apply:1'])
  })

  test('reports rollback-pending when no restore hook proves the profile', async () => {
    const f = await fixture()
    await f.runtime.activate(f.activation())
    const rollback = createInProcessReloadRuntime(f.ctx, {
      profilePath: f.profile, entryId: 'include:candidate', package: 'reload-fixture',
      hostGeneration: () => 3,
    })
    const result = await rollback.rollback({ warrantDigest: digest('c'), target: target(), reloadedInProcessGeneration: 2 })
    expect(result.profileRestored).toBe(false)
    expect(result.restored).toBe(false)
    expect(result.probe.reloaded).toBe(false)
    expect(result.inProcessGeneration).toBe(2)
  })
})
