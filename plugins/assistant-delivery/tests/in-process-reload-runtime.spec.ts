import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import * as assistantDeliveryPlugin from '../src/index.js'
import {
  IN_PROCESS_RELOAD_DENYLIST,
  computeInProcessArtifactDigest,
  computeInProcessPatchDigest,
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

async function writeBundlePackage(dir: string, options: {
  name: string
  version: string
  body: string
  extraFiles?: Record<string, string>
}): Promise<string> {
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: options.name,
    version: options.version,
    type: 'module',
    exports: { '.': './lib/index.js' },
  }, null, 2))
  await writeFile(join(dir, 'lib', 'index.js'), options.body, 'utf8')
  for (const [relPath, content] of Object.entries(options.extraFiles ?? {})) {
    const dest = join(dir, relPath)
    await mkdir(join(dest, '..'), { recursive: true })
    await writeFile(dest, content, 'utf8')
  }
  return computeInProcessArtifactDigest({ sourceDir: dir })
}

async function artifactFixture(options: { throwDisposer?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-in-process-artifact-')))
  const profileDir = join(root, 'profile')
  const stagingDir = join(root, 'staged')
  const v1Dir = join(root, 'bundles', 'demo-v1')
  const siblingDir = join(root, 'bundles', 'sibling')
  const profileFile = join(profileDir, 'cordis.yml')
  await mkdir(profileDir, { recursive: true })

  const demoEvents: string[] = []
  const siblingEvents: string[] = []
  const globalHooks = globalThis as Record<string, unknown>
  const hookKey = `__dshHotTest_${Math.random().toString(16).slice(2)}`
  globalHooks[hookKey] = { demoEvents, siblingEvents, handlesClosed: 0 }

  await writeBundlePackage(siblingDir, {
    name: '@dsh-ray/sibling-stable',
    version: '0.1.0',
    body: `
export const name = 'sibling-stable'
export function apply(ctx, config) {
  const hooks = globalThis[${JSON.stringify(hookKey)}]
  hooks.siblingEvents.push('sibling:apply:' + String(config?.tag ?? 'default'))
  ctx.provide('siblingPing', () => 'alive:' + String(config?.tag ?? 'default'))
  ctx.effect(() => () => { hooks.siblingEvents.push('sibling:dispose') })
}
`,
  })

  const v1Digest = await writeBundlePackage(v1Dir, {
    name: '@dsh-ray/demo-hot',
    version: '0.1.0',
    body: `
export const name = 'demo-hot'
export const versionTag = 'v1'
export function apply(ctx, config) {
  const hooks = globalThis[${JSON.stringify(hookKey)}]
  hooks.demoEvents.push('v1:apply:' + String(config?.greeting ?? 'init'))
  const timer = setInterval(() => {}, 60_000)
  ctx.provide('demoService', {
    version: () => '0.1.0-' + String(config?.greeting ?? 'init'),
  })
  ctx.effect(() => () => {
    clearInterval(timer)
    hooks.handlesClosed += 1
    hooks.demoEvents.push('v1:dispose')
    ${options.throwDisposer ? "throw new Error('v1 disposer exploded')" : ''}
  })
}
`,
  })

  await writeFile(profileFile, [
    '- id: candidate',
    '  name: ../bundles/demo-v1/lib/index.js',
    '  config:',
    '    greeting: hello-v1',
    '- id: sibling',
    '  name: ../bundles/sibling/lib/index.js',
    '  config:',
    '    tag: steady',
    '',
  ].join('\n'), 'utf8')

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: { path: pathToFileURL(profileFile).href },
  } as unknown as Parameters<typeof ctx.loader.create>[0])
  await ctx.loader.await()
  fixtures.push({ ctx, root })

  const cleanupHook = () => { delete globalHooks[hookKey] }
  let hostGeneration = 3
  const runtime = createInProcessReloadRuntime(ctx, {
    profilePath: profileDir,
    entryId: 'candidate',
    package: '@dsh-ray/demo-hot',
    stagingDir,
    hostGeneration: () => hostGeneration,
  })

  return {
    ctx,
    root,
    profileDir,
    profileFile,
    stagingDir,
    v1Dir,
    v1Digest,
    runtime,
    demoEvents,
    siblingEvents,
    hooks: globalHooks[hookKey] as { demoEvents: string[]; siblingEvents: string[]; handlesClosed: number },
    cleanupHook,
    resolve: (id: string) => ctx.loader.resolve(id),
    bumpHostGeneration: () => { hostGeneration += 1 },
  }
}

describe('immutable digest-verified artifact replacement and auto-rollback', () => {
  test('dynamically reloads immutable code artifacts across multiple rounds with disposer cleanup and sibling stability', async () => {
    const f = await artifactFixture()
    try {
      const beforeEntry = f.resolve('include:candidate')
      const beforeFiber = beforeEntry.fiber!
      const beforeSibling = f.resolve('include:sibling')
      const beforeSiblingFiber = beforeSibling.fiber!
      const pidBefore = process.pid

      expect((f.ctx.get('demoService' as never) as unknown as { version(): string }).version()).toBe('0.1.0-hello-v1')
      expect((f.ctx.get('siblingPing' as never) as unknown as () => string)()).toBe('alive:steady')

      const v2Dir = join(f.root, 'bundles', 'demo-v2')
      const v2Digest = await writeBundlePackage(v2Dir, {
        name: '@dsh-ray/demo-hot',
        version: '0.2.0',
        body: `
export const name = 'demo-hot'
export const versionTag = 'v2'
export function apply(ctx, config) {
  const gKey = Object.keys(globalThis).find(k => k.startsWith('__dshHotTest_'))
  globalThis[gKey].demoEvents.push('v2:apply:' + String(config?.greeting ?? 'init'))
  ctx.provide('demoService', {
    version: () => '0.2.0-' + String(config?.greeting ?? 'init'),
  })
  ctx.effect(() => () => { globalThis[gKey].demoEvents.push('v2:dispose') })
}
`,
      })
      const v2Config = { greeting: 'hi-v2' }
      const v2PatchDigest = computeInProcessPatchDigest({ config: v2Config })

      const res1 = await f.runtime.activate({
        warrantDigest: digest('c'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 1,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: v2PatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: v2Config },
        },
      })

      expect(res1.probe.reloaded).toBe(true)
      expect(res1.probe.failures).toBe(0)
      expect(res1.probe.failedChecks).toEqual([])
      expect(res1.probe.fibersDisposed).toBeGreaterThanOrEqual(1)
      expect(res1.previousHostGeneration).toBe(3)
      expect(res1.currentHostGeneration).toBe(3)
      expect(res1.currentInProcessGeneration).toBe(2)
      expect(process.pid).toBe(pidBefore)

      expect(beforeFiber.state).toBe(4)
      expect(beforeFiber.uid).toBeNull()
      expect(f.hooks.handlesClosed).toBe(1)

      const afterEntry = f.resolve('include:candidate')
      expect(afterEntry).not.toBe(beforeEntry)
      expect(afterEntry.fiber).not.toBe(beforeFiber)
      expect(afterEntry.fiber!.uid).not.toBe(beforeFiber.uid)
      expect(afterEntry.fiber!.state).toBe(2)
      expect(afterEntry.fiber!.committed).toBeTruthy()
      expect(afterEntry.fiber!.committed).not.toBe(beforeFiber.committed)
      expect(afterEntry.moduleNamespace).not.toBe(beforeEntry.moduleNamespace)
      expect((f.ctx.get('demoService' as never) as unknown as { version(): string }).version()).toBe('0.2.0-hi-v2')

      // Sibling plugin remained completely undisturbed.
      const afterSibling = f.resolve('include:sibling')
      expect(afterSibling.fiber).toBe(beforeSiblingFiber)
      expect(afterSibling.fiber!.uid).toBe(beforeSiblingFiber.uid)
      expect(afterSibling.fiber!.state).toBe(2)
      expect(f.siblingEvents).toEqual(['sibling:apply:steady'])
      expect(f.demoEvents).toEqual(['v1:apply:hello-v1', 'v1:dispose', 'v2:apply:hi-v2'])

      // Reload a second time WITH THE SAME VERSION STRING ('0.2.0') but distinct code digest:
      // immutable `<version>-<artifactDigest>` staging prevents any ESM cache collision.
      const v2bDir = join(f.root, 'bundles', 'demo-v2b')
      const v2bDigest = await writeBundlePackage(v2bDir, {
        name: '@dsh-ray/demo-hot',
        version: '0.2.0',
        body: `
export const name = 'demo-hot'
export const versionTag = 'v2b'
export function apply(ctx, config) {
  const gKey = Object.keys(globalThis).find(k => k.startsWith('__dshHotTest_'))
  globalThis[gKey].demoEvents.push('v2b:apply:' + String(config?.greeting ?? 'init'))
  ctx.provide('demoService', {
    version: () => '0.2.0b-' + String(config?.greeting ?? 'init'),
  })
}
`,
      })
      const patchText = 'config:\n  greeting: hi-v2b\n'
      const res2 = await f.runtime.activate({
        warrantDigest: digest('d'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 2,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: v2bDigest,
          patchDigest: computeInProcessPatchDigest(patchText),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2bDir, config: { greeting: 'hi-v2b' }, patchContent: patchText },
        },
      })
      expect(res2.probe.reloaded).toBe(true)
      expect(res2.probe.fibersDisposed).toBeGreaterThanOrEqual(1)
      expect((f.ctx.get('demoService' as never) as unknown as { version(): string }).version()).toBe('0.2.0b-hi-v2b')
      expect(f.demoEvents).toEqual(['v1:apply:hello-v1', 'v1:dispose', 'v2:apply:hi-v2', 'v2:dispose', 'v2b:apply:hi-v2b'])
    } finally {
      f.cleanupHook()
    }
  })

  test('refuses tampered digests, symlinks, node_modules, and denylisted packages before tree.refresh()', async () => {
    const f = await artifactFixture()
    try {
      const beforeFiber = f.resolve('include:candidate').fiber!
      const v2Dir = join(f.root, 'bundles', 'demo-bad')
      const validDigest = await writeBundlePackage(v2Dir, {
        name: '@dsh-ray/demo-hot',
        version: '0.2.0',
        body: 'export function apply() {}\n',
      })

      // Tampered artifactDigest
      await expect(f.runtime.activate({
        warrantDigest: digest('c'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 1,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: digest('e'),
          patchDigest: computeInProcessPatchDigest({ config: { greeting: 'x' } }),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: { greeting: 'x' } },
        },
      })).rejects.toThrow('digest mismatch')

      // Tampered patchDigest
      await expect(f.runtime.activate({
        warrantDigest: digest('c'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 1,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: validDigest,
          patchDigest: digest('9'),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: { greeting: 'x' } },
        },
      })).rejects.toThrow('patch digest mismatch')

      // Nested node_modules subtree rejected
      const nmDir = join(f.root, 'bundles', 'demo-nm')
      await mkdir(join(nmDir, 'lib'), { recursive: true })
      await mkdir(join(nmDir, 'node_modules', 'evil'), { recursive: true })
      await writeFile(join(nmDir, 'package.json'), JSON.stringify({ name: '@dsh-ray/demo-hot', version: '0.2.0', exports: { '.': './lib/index.js' } }))
      await writeFile(join(nmDir, 'lib', 'index.js'), 'export function apply() {}\n', 'utf8')
      await writeFile(join(nmDir, 'node_modules', 'evil', 'index.js'), 'export default 1\n', 'utf8')
      expect(() => computeInProcessArtifactDigest({ sourceDir: nmDir })).toThrow('node_modules')
      await expect(f.runtime.activate({
        warrantDigest: digest('c'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 1,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: digest('1'),
          patchDigest: digest('2'),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: nmDir },
        },
      })).rejects.toThrow('node_modules')

      // Symlink inside artifact source rejected
      const symDir = join(f.root, 'bundles', 'demo-sym')
      await writeBundlePackage(symDir, {
        name: '@dsh-ray/demo-hot',
        version: '0.2.0',
        body: 'export function apply() {}\n',
      })
      await symlink(v2Dir, join(symDir, 'lib', 'link'))
      expect(() => computeInProcessArtifactDigest({ sourceDir: symDir })).toThrow('symlinks')
      await expect(f.runtime.activate({
        warrantDigest: digest('c'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 1,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: digest('1'),
          patchDigest: digest('2'),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: symDir },
        },
      })).rejects.toThrow('symlinks')

      // All 4 denylisted packages strictly refused
      const openRuntime = createInProcessReloadRuntime(f.ctx, {
        profilePath: f.profileDir,
        entryId: 'candidate',
        hostGeneration: () => 3,
      })
      for (const deniedPkg of IN_PROCESS_RELOAD_DENYLIST) {
        await expect(openRuntime.activate({
          warrantDigest: digest('c'),
          previousHostGeneration: 3,
          previousInProcessGeneration: 1,
          target: {
            package: deniedPkg,
            version: '0.2.0',
            artifactDigest: validDigest,
            patchDigest: digest('2'),
            changesProcessSubtree: false,
            holdsUnprovenProcessAuthority: false,
            artifact: { sourceDir: v2Dir },
          },
        })).rejects.toThrow('denied')
      }

      // Live v1 fiber was never disturbed by any refusal.
      expect(f.resolve('include:candidate').fiber).toBe(beforeFiber)
      expect(beforeFiber.state).toBe(2)
      expect(f.runtime.snapshot().inProcessGeneration).toBe(1)
    } finally {
      f.cleanupHook()
    }
  })

  test('automatically rolls back to prior immutable artifact on missing injection and retains non-target plugins', async () => {
    const f = await artifactFixture()
    try {
      const beforeEntry = f.resolve('include:candidate')
      const beforeSiblingFiber = f.resolve('include:sibling').fiber!

      const v2MissingInjectDir = join(f.root, 'bundles', 'demo-v2-missing-inject')
      const v2Digest = await writeBundlePackage(v2MissingInjectDir, {
        name: '@dsh-ray/demo-hot',
        version: '0.2.0',
        body: `
export const inject = ['nonExistentHostCapability']
export function apply() {
  throw new Error('should not execute with missing injection')
}
`,
      })
      const patchContent = JSON.stringify({ config: { greeting: 'v2' } })
      const activation = await f.runtime.activate({
        warrantDigest: digest('c'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 1,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: computeInProcessPatchDigest(patchContent),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2MissingInjectDir, config: { greeting: 'v2' }, patchContent },
        },
      })

      expect(activation.probe.reloaded).toBe(false)
      expect(activation.probe.failures).toBeGreaterThan(0)
      expect(activation.probe.failedChecks).toContain('injections-satisfied')
      expect(activation.probe.rolledBack).toBe(true)
      expect(activation.probe.rollbackProbe?.failures).toBe(0)
      expect(activation.currentInProcessGeneration).toBe(2)

      // Restored serving v1 artifact must be ACTIVE with v1's moduleNamespace & service.
      const restoredEntry = f.resolve('include:candidate')
      expect(restoredEntry.fiber?.state).toBe(2)
      expect(restoredEntry.moduleNamespace).toBe(beforeEntry.moduleNamespace)
      expect((f.ctx.get('demoService' as never) as unknown as { version(): string }).version()).toBe('0.1.0-hello-v1')

      // Sibling plugin untouched.
      expect(f.resolve('include:sibling').fiber).toBe(beforeSiblingFiber)
      expect(f.siblingEvents).toEqual(['sibling:apply:steady'])

      // Explicit rollback confirmation reports restored: true and failure-free probe.
      const confirmed = await f.runtime.rollback({
        warrantDigest: digest('c'),
        reloadedInProcessGeneration: activation.currentInProcessGeneration,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: computeInProcessPatchDigest(patchContent),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2MissingInjectDir, config: { greeting: 'v2' }, patchContent },
        },
      })
      expect(confirmed.restored).toBe(true)
      expect(confirmed.profileRestored).toBe(true)
      expect(confirmed.probe.failures).toBe(0)
      expect(confirmed.probe.reloaded).toBe(true)
    } finally {
      f.cleanupHook()
    }
  })

  test('automatically rolls back on startup throw and on throwing effect disposers', async () => {
    // 1. Startup throw in candidate apply()
    const f1 = await artifactFixture()
    try {
      const beforeNs = f1.resolve('include:candidate').moduleNamespace
      const siblingFiber = f1.resolve('include:sibling').fiber!
      const crashDir = join(f1.root, 'bundles', 'demo-v2-crash')
      const crashDigest = await writeBundlePackage(crashDir, {
        name: '@dsh-ray/demo-hot',
        version: '0.2.0',
        body: `
export function apply() {
  throw new Error('startup boom')
}
`,
      })
      const patchContent = 'crash-v2'
      const crashResult = await f1.runtime.activate({
        warrantDigest: digest('c'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 1,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: crashDigest,
          patchDigest: computeInProcessPatchDigest(patchContent),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: crashDir, patchContent },
        },
      })
      expect(crashResult.probe.reloaded).toBe(false)
      expect(crashResult.probe.failures).toBeGreaterThan(0)
      expect(crashResult.probe.rolledBack).toBe(true)
      expect(f1.resolve('include:candidate').fiber?.state).toBe(2)
      expect(f1.resolve('include:candidate').moduleNamespace).toBe(beforeNs)
      expect((f1.ctx.get('demoService' as never) as unknown as { version(): string }).version()).toBe('0.1.0-hello-v1')
      expect(f1.resolve('include:sibling').fiber).toBe(siblingFiber)
    } finally {
      f1.cleanupHook()
    }

    // 2. Disposer throw during v1 unload
    const f2 = await artifactFixture({ throwDisposer: true })
    try {
      const beforeNs = f2.resolve('include:candidate').moduleNamespace
      const okDir = join(f2.root, 'bundles', 'demo-v2-ok')
      const okDigest = await writeBundlePackage(okDir, {
        name: '@dsh-ray/demo-hot',
        version: '0.2.0',
        body: 'export function apply() {}\n',
      })
      const patchContent = 'disposer-fail-test'
      const res = await f2.runtime.activate({
        warrantDigest: digest('c'),
        previousHostGeneration: 3,
        previousInProcessGeneration: 1,
        target: {
          package: '@dsh-ray/demo-hot',
          version: '0.2.0',
          artifactDigest: okDigest,
          patchDigest: computeInProcessPatchDigest(patchContent),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: okDir, patchContent },
        },
      })
      expect(res.probe.reloaded).toBe(false)
      expect(res.probe.failedChecks).toContain('disposer-clean')
      expect(res.probe.rolledBack).toBe(true)
      expect(f2.resolve('include:candidate').fiber?.state).toBe(2)
      expect(f2.resolve('include:candidate').moduleNamespace).toBe(beforeNs)
      expect((f2.ctx.get('demoService' as never) as unknown as { version(): string }).version()).toBe('0.1.0-hello-v1')
    } finally {
      f2.cleanupHook()
    }
  })

  test('registers inProcessReload by default with dynamic Include discovery, respects enabled: false opt-out, and fences disposal', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-delivery-default-on-')))
    const baseInput = {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      defaultWorkspace: root,
    }

    const dumped = assistantDeliveryPlugin.Config(baseInput)
    expect(dumped.inProcessReload).toEqual({ enabled: true })

    // Default config (omitting inProcessReload & profilePath) registers `inProcessReload`,
    // resolves profileFile dynamically from the mounted Include root, and runs artifact-replace.
    const profileDir = join(root, 'profile')
    const v1Dir = join(root, 'bundles', 'dyn-v1')
    const v2Dir = join(root, 'bundles', 'dyn-v2')
    await mkdir(profileDir, { recursive: true })
    await mkdir(join(v1Dir, 'lib'), { recursive: true })
    await mkdir(join(v2Dir, 'lib'), { recursive: true })
    await writeFile(join(v1Dir, 'package.json'), JSON.stringify({
      name: '@dsh-ray/dyn-hot',
      version: '0.1.0',
      type: 'module',
      exports: { '.': './lib/index.js' },
    }))
    await writeFile(join(v1Dir, 'lib', 'index.js'), `
export const name = 'dyn-hot'
export function apply(ctx) {
  ctx.provide('dynService', { tag: () => 'v1' })
}
`, 'utf8')
    await writeFile(join(v2Dir, 'package.json'), JSON.stringify({
      name: '@dsh-ray/dyn-hot',
      version: '0.2.0',
      type: 'module',
      exports: { '.': './lib/index.js' },
    }))
    await writeFile(join(v2Dir, 'lib', 'index.js'), `
export const name = 'dyn-hot'
export function apply(ctx) {
  ctx.provide('dynService', { tag: () => 'v2' })
}
`, 'utf8')
    const v2Digest = computeInProcessArtifactDigest({ sourceDir: v2Dir })
    const profileFile = join(profileDir, 'cordis.yml')
    await writeFile(profileFile, `- id: dyn\n  name: ../bundles/dyn-v1/lib/index.js\n`, 'utf8')

    const ctxDefault = new Context()
    await ctxDefault.plugin(Loader)
    ctxDefault.loader.builtins.include = Include
    await ctxDefault.loader.create({
      id: 'include',
      name: 'cordis:include',
      config: { path: pathToFileURL(profileFile).href },
    } as unknown as Parameters<typeof ctxDefault.loader.create>[0])
    await ctxDefault.loader.await()
    await ctxDefault.plugin(AssistantPolicyService, { databasePath: join(root, 'policy1.sqlite') })
    await ctxDefault.plugin(ctx => { assistantDeliveryPlugin.apply(ctx, { ...baseInput, schedulerEnabled: false }) })

    const defaultRuntime = ctxDefault.get('inProcessReload')
    expect(defaultRuntime).toBeDefined()
    expect(defaultRuntime?.snapshot()).toEqual({ hostGeneration: 1, inProcessGeneration: 1 })
    expect((ctxDefault.get('dynService' as never) as unknown as { tag(): string }).tag()).toBe('v1')

    const patchContent = 'config:\n  tag: v2\n'
    const reloadRes = await defaultRuntime!.activate({
      warrantDigest: digest('f'),
      previousHostGeneration: 1,
      previousInProcessGeneration: 1,
      target: {
        package: '@dsh-ray/dyn-hot',
        version: '0.2.0',
        artifactDigest: v2Digest,
        patchDigest: computeInProcessPatchDigest(patchContent),
        changesProcessSubtree: false,
        holdsUnprovenProcessAuthority: false,
        entryId: 'dyn',
        artifact: { sourceDir: v2Dir, config: { tag: 'v2' }, patchContent },
      },
    })
    expect(reloadRes.probe.reloaded).toBe(true)
    expect((ctxDefault.get('dynService' as never) as unknown as { tag(): string }).tag()).toBe('v2')

    await ctxDefault.fiber.dispose()
    expect(ctxDefault.get('inProcessReload')).toBeUndefined()
    await expect(defaultRuntime!.activate({
      warrantDigest: digest('f'),
      previousHostGeneration: 1,
      previousInProcessGeneration: 2,
      target: {
        package: '@dsh-ray/dyn-hot',
        version: '0.2.0',
        artifactDigest: v2Digest,
        patchDigest: computeInProcessPatchDigest(patchContent),
        changesProcessSubtree: false,
        holdsUnprovenProcessAuthority: false,
      },
    })).rejects.toThrow('disposed')

    // Explicit opt-out: inProcessReload: { enabled: false } does NOT register the service,
    // while invalid relative paths still fail config validation.
    const ctxOptOut = new Context()
    await ctxOptOut.plugin(AssistantPolicyService, { databasePath: join(root, 'policy2.sqlite') })
    await ctxOptOut.plugin(ctx => {
      assistantDeliveryPlugin.apply(ctx, {
        ...baseInput,
        schedulerEnabled: false,
        databasePath: join(root, 'delivery2.sqlite'),
        spoolPath: join(root, 'spool2'),
        inProcessReload: { enabled: false },
      })
    })
    expect(ctxOptOut.get('inProcessReload')).toBeUndefined()
    await ctxOptOut.fiber.dispose()

    const ctxInvalid = new Context()
    await ctxInvalid.plugin(AssistantPolicyService, { databasePath: join(root, 'policy3.sqlite') })
    expect(() => assistantDeliveryPlugin.apply(ctxInvalid, {
      ...baseInput,
      schedulerEnabled: false,
      databasePath: join(root, 'delivery3.sqlite'),
      spoolPath: join(root, 'spool3'),
      inProcessReload: { enabled: false, profilePath: 'relative/path' },
    })).toThrow(/absolute/i)
    await ctxInvalid.fiber.dispose()

    await rm(root, { recursive: true, force: true })
  })

  test('allows lark-channel, assistant-isolation, and changesProcessSubtree in artifact-replace mode with rollback fallback', async () => {
    expect(IN_PROCESS_RELOAD_DENYLIST).toEqual([
      '@dsh-ray/plugin-control-plane',
      '@dsh-ray/assistant-delivery',
    ])

    for (const pkg of ['@dsh-ray/lark-channel', '@dsh-ray/assistant-isolation']) {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ipr-relaxed-')))
      const profileDir = join(root, 'profile')
      const v1Dir = join(root, 'bundles', 'pkg-v1')
      const v2Dir = join(root, 'bundles', 'pkg-v2')
      const badDir = join(root, 'bundles', 'pkg-bad')
      await mkdir(profileDir, { recursive: true })
      await mkdir(join(v1Dir, 'lib'), { recursive: true })
      await mkdir(join(v2Dir, 'lib'), { recursive: true })
      await mkdir(join(badDir, 'lib'), { recursive: true })

      const writePkg = async (dir: string, version: string, body: string) => {
        await writeFile(join(dir, 'package.json'), JSON.stringify({
          name: pkg,
          version,
          type: 'module',
          exports: { '.': './lib/index.js' },
        }))
        await writeFile(join(dir, 'lib', 'index.js'), body, 'utf8')
        return computeInProcessArtifactDigest({ sourceDir: dir })
      }
      await writePkg(v1Dir, '0.1.0', `
export const name = '${pkg}'
export function apply(ctx) {
  ctx.provide('relaxedTestSvc', { ver: () => 'v1' })
}
`)
      const v2Digest = await writePkg(v2Dir, '0.2.0', `
export const inject = ['hostPeerSvc']
export const name = '${pkg}'
export function apply(ctx) {
  ctx.provide('relaxedTestSvc', { ver: () => 'v2:' + ctx.get('hostPeerSvc').ping() })
}
`)
      const badDigest = await writePkg(badDir, '0.3.0', `
export const inject = ['missingPeerSvc']
export const name = '${pkg}'
export function apply() { throw new Error('missing inject should keep this blocked') }
`)

      const profileFile = join(profileDir, 'cordis.yml')
      await writeFile(profileFile, `- id: target\n  name: ../bundles/pkg-v1/lib/index.js\n`, 'utf8')

      const ctx = new Context()
      fixtures.push({ ctx, root })
      ctx.provide('hostPeerSvc' as never, { ping: () => 'ok' } as never)
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      await ctx.loader.create({
        id: 'include',
        name: 'cordis:include',
        config: { path: pathToFileURL(profileFile).href },
      } as unknown as Parameters<typeof ctx.loader.create>[0])
      await ctx.loader.await()

      const runtime = createInProcessReloadRuntime(ctx, {
        hostGeneration: () => 1,
        entryId: 'target',
      })

      // Satisfied subtree change succeeds in artifact-replace mode.
      const v2Patch = JSON.stringify({ config: { step: 2 } })
      const ok = await runtime.activate({
        warrantDigest: digest('a'),
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        target: {
          package: pkg,
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: computeInProcessPatchDigest(v2Patch),
          changesProcessSubtree: true,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: { step: 2 }, patchContent: v2Patch },
        },
      })
      expect(ok.probe.reloaded).toBe(true)
      expect((ctx.get('relaxedTestSvc' as never) as unknown as { ver(): string }).ver()).toBe('v2:ok')

      // Unsatisfied subtree change rolls back cleanly to v2!
      const badPatch = JSON.stringify({ config: { step: 3 } })
      const failed = await runtime.activate({
        warrantDigest: digest('b'),
        previousHostGeneration: 1,
        previousInProcessGeneration: ok.currentInProcessGeneration,
        target: {
          package: pkg,
          version: '0.3.0',
          artifactDigest: badDigest,
          patchDigest: computeInProcessPatchDigest(badPatch),
          changesProcessSubtree: true,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: badDir, config: { step: 3 }, patchContent: badPatch },
        },
      })
      expect(failed.probe.reloaded).toBe(false)
      expect(failed.probe.failedChecks).toContain('injections-satisfied')
      expect(failed.probe.rolledBack).toBe(true)
      expect((ctx.get('relaxedTestSvc' as never) as unknown as { ver(): string }).ver()).toBe('v2:ok')
    }
  })
})
