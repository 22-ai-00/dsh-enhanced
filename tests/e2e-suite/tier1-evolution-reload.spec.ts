import { Include } from '@deepseek-ai/cordis-plugin-include'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { getExportFn, sha256Hex } from './helpers/assertions.ts'
import { runCommandProcess } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAdoptionCoordinator,
  loadAssistantDelivery,
  loadAssistantDreaming,
  loadAssistantEvolution,
  loadAssistantGrowthDriver,
  loadAssistantMemoryLearning,
  loadAssistantPolicy,
  loadAssistantVerifier,
  loadNativeBehaviorArtifact,
  loadNativeBehaviorWorker,
  loadPersonalMemory,
  loadPluginBehaviorRunner,
  loadPluginControlPlane,
  loadPreferenceLearning,
  loadSourceCreation,
  loadSourceRevision,
} from './helpers/packages.ts'
import { createWorkspaceTracker, repoRoot } from './helpers/workspace.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

async function writeBundlePackage(
  dir: string,
  opts: { name: string; version: string; body: string },
) {
  await mkdir(join(dir, 'lib'), { recursive: true, mode: 0o700 })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: opts.name, version: opts.version, type: 'module', main: './lib/index.js' }),
    'utf8',
  )
  await writeFile(join(dir, 'lib', 'index.js'), opts.body, 'utf8')
}

function packPluginEntries(entries: Record<string, string>): Buffer {
  const records: Buffer[] = []
  for (const [name, content] of Object.entries(entries)) {
    const bytes = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write(`${header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0')}\0 `, 148)
    records.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]))
}

async function runBehaviorWorkerOnTgz(
  workRoot: string,
  tgz: Buffer,
  operation: { kind: 'discover' } | { kind: 'invoke'; schemaDigest: string; calls: { id: string; toolName: string; arguments: unknown }[] },
  pluginKind: 'service' | 'channel' | 'ui',
): Promise<Record<string, unknown>> {
  const { nativeBehaviorFiles } = (await loadNativeBehaviorArtifact()) as {
    nativeBehaviorFiles: (buf: Buffer) => { entry: string; files: { path: string; content: string }[] }
  }
  const { NATIVE_BEHAVIOR_SOURCE } = (await loadNativeBehaviorWorker()) as { NATIVE_BEHAVIOR_SOURCE: string }

  const staged = nativeBehaviorFiles(tgz)
  for (const file of staged.files) {
    const dest = join(workRoot, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.content, 'utf8')
  }
  const workerPath = join(workRoot, 'worker.mjs')
  await writeFile(workerPath, NATIVE_BEHAVIOR_SOURCE, 'utf8')

  const modulesPath = join(repoRoot, 'plugins', 'assistant-verifier', 'node_modules')
  const artifactSha256 = createHash('sha256').update(tgz).digest('hex')
  const stdin = JSON.stringify({
    schemaVersion: 1,
    nonce: 'a'.repeat(64),
    artifactSha256,
    entry: staged.entry,
    modulesPath,
    operation,
    pluginKind,
  })
  const res = await runCommandProcess(process.execPath, [workerPath], { cwd: workRoot, stdin })
  expect(res.exitCode).toBe(0)
  return JSON.parse(res.stdout.trim()) as Record<string, unknown>
}

describe('Tier 1 — F12–F14: inProcessReload, Broader Plugin Evolution & R3 Defaults', () => {
  describe('F12: WP16 inProcessReload adoption chain', () => {
    test('T1-F12-01: AssistantDeliveryService registers inProcessReload Cordis service by default', async () => {
      const ws = await workspaces.create('f12-default-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantDeliveryService } = await loadAssistantDelivery()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      await harness.mountService(ctx, AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery'),
        spoolPath: join(ws.stateDir, 'spool'),
        schedulerEnabled: false,
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'standard',
      })

      const reloadSvc = ctx.get('inProcessReload' as never) as Record<string, unknown> | undefined
      expect(reloadSvc).toBeDefined()
      expect(typeof reloadSvc?.activate).toBe('function')
      expect(typeof reloadSvc?.rollback).toBe('function')
    }, 15_000)

    test('T1-F12-02: PluginControlPlaneService wires ctx.get(inProcessReload) into AdoptionCoordinatorRuntime', async () => {
      const ws = await workspaces.create('f12-wire-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantDeliveryService } = await loadAssistantDelivery()
      const { PluginControlPlaneService } = await loadPluginControlPlane()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      await harness.mountService(ctx, AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery'),
        spoolPath: join(ws.stateDir, 'spool'),
        schedulerEnabled: false,
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'standard',
      })
      const pcp = await harness.mountService<{ canInProcessReload: () => boolean }>(
        ctx,
        PluginControlPlaneService,
        'pluginControlPlane',
        {
          catalogPath: join(ws.stateDir, 'catalog.json'),
          statePath: join(ws.stateDir, 'state.json'),
          trustPath: join(ws.stateDir, 'trust.json'),
        },
      )

      expect(pcp.canInProcessReload()).toBe(true)
    }, 15_000)

    test('T1-F12-03: createInProcessReloadRuntime replaces target artifact without disturbing sibling plugins', async () => {
      const ws = await workspaces.create('f12-replace-')
      const delivery = await loadAssistantDelivery()
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      const profileFile = join(profileDir, 'cordis.yml')
      const v1Dir = join(ws.root, 'bundles', 'demo-v1')
      const v2Dir = join(ws.root, 'bundles', 'demo-v2')
      const siblingDir = join(ws.root, 'bundles', 'sibling')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })

      const hookKey = `__dshE2eReload_${Math.random().toString(16).slice(2)}`
      const globalHooks = globalThis as Record<string, unknown>
      globalHooks[hookKey] = { siblingDisposed: false }

      try {
        await writeBundlePackage(siblingDir, {
          name: '@dsh-enhanced/sibling-stable',
          version: '0.1.0',
          body: `
export const name = 'sibling-stable'
export function apply(ctx) {
  ctx.provide('siblingPing', () => 'steady')
  ctx.effect(() => () => { globalThis[${JSON.stringify(hookKey)}].siblingDisposed = true })
}
`,
        })
        await writeBundlePackage(v1Dir, {
          name: '@dsh-enhanced/sample-plugin',
          version: '0.1.0',
          body: `
export const name = 'sample-plugin'
export function apply(ctx) {
  ctx.provide('demoService', () => 'v1')
}
`,
        })
        await writeBundlePackage(v2Dir, {
          name: '@dsh-enhanced/sample-plugin',
          version: '0.2.0',
          body: `
export const name = 'sample-plugin'
export function apply(ctx, config) {
  ctx.provide('demoService', () => 'v2:' + String(config?.tag ?? ''))
}
`,
        })

        await writeFile(
          profileFile,
          [
            '- id: candidate',
            `  name: ${join(v1Dir, 'lib/index.js')}`,
            '  config: {}',
            '- id: sibling',
            `  name: ${join(siblingDir, 'lib/index.js')}`,
            '  config: {}',
            '',
          ].join('\n'),
          'utf8',
        )

        const ctx = harness.createContext()
        await ctx.plugin(Loader)
        ctx.loader.builtins.include = Include
        await ctx.loader.create({
          id: 'include',
          name: 'cordis:include',
          config: { path: pathToFileURL(profileFile).href },
        } as never)
        await ctx.loader.await()

        const beforeCandidate = ctx.loader.resolve('include:candidate')
        const beforeCandidateFiber = beforeCandidate.fiber
        const beforeSiblingFiber = ctx.loader.resolve('include:sibling').fiber
        expect((ctx.get('demoService' as never) as () => string)()).toBe('v1')
        expect((ctx.get('siblingPing' as never) as () => string)()).toBe('steady')

        const runtime = delivery.createInProcessReloadRuntime(ctx, {
          profilePath: profileDir,
          entryId: 'candidate',
          package: '@dsh-enhanced/sample-plugin',
          stagingDir: join(ws.stateDir, 'staging'),
          hostGeneration: () => 1,
        })

        const v2Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: v2Dir })
        const v2PatchDigest = delivery.computeInProcessPatchDigest({ config: { tag: 'live' } })
        const res = await runtime.activate({
          warrantDigest: sha256Hex('warrant-1'),
          previousHostGeneration: 1,
          previousInProcessGeneration: 1,
          mode: 'artifact-replace',
          target: {
            package: '@dsh-enhanced/sample-plugin',
            version: '0.2.0',
            artifactDigest: v2Digest,
            patchDigest: v2PatchDigest,
            changesProcessSubtree: false,
            holdsUnprovenProcessAuthority: false,
            artifact: { sourceDir: v2Dir, config: { tag: 'live' } },
          },
        })

        expect(res.probe.reloaded).toBe(true)
        expect(res.probe.failures).toBe(0)
        expect((ctx.get('demoService' as never) as () => string)()).toBe('v2:live')
        expect(ctx.loader.resolve('include:candidate').fiber).not.toBe(beforeCandidateFiber)

        // Sibling plugin remained completely undisturbed.
        expect(ctx.loader.resolve('include:sibling').fiber).toBe(beforeSiblingFiber)
        expect((globalHooks[hookKey] as { siblingDisposed: boolean }).siblingDisposed).toBe(false)
        expect((ctx.get('siblingPing' as never) as () => string)()).toBe('steady')
      } finally {
        delete globalHooks[hookKey]
      }
    })

    test('T1-F12-04: inProcessReload automatically rolls back if post-reload activation fails', async () => {
      const ws = await workspaces.create('f12-rollback-')
      const delivery = await loadAssistantDelivery()
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      const profileFile = join(profileDir, 'cordis.yml')
      const v1Dir = join(ws.root, 'bundles', 'cand-v1')
      const v2CrashDir = join(ws.root, 'bundles', 'cand-v2-crash')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })

      await writeBundlePackage(v1Dir, {
        name: '@dsh-enhanced/cand-1',
        version: '0.1.0',
        body: `
export const name = 'cand-1'
export function apply(ctx) {
  ctx.provide('candService', () => 'v1-healthy')
}
`,
      })
      await writeBundlePackage(v2CrashDir, {
        name: '@dsh-enhanced/cand-1',
        version: '0.1.84',
        body: `
export const name = 'cand-1'
export function apply() {
  throw new Error('boom')
}
`,
      })

      await writeFile(
        profileFile,
        ['- id: cand-1', `  name: ${join(v1Dir, 'lib/index.js')}`, '  config: {}', ''].join('\n'),
        'utf8',
      )

      const ctx = harness.createContext()
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      await ctx.loader.create({
        id: 'include',
        name: 'cordis:include',
        config: { path: pathToFileURL(profileFile).href },
      } as never)
      await ctx.loader.await()

      expect((ctx.get('candService' as never) as () => string)()).toBe('v1-healthy')

      const runtime = delivery.createInProcessReloadRuntime(ctx, {
        profilePath: profileDir,
        entryId: 'cand-1',
        package: '@dsh-enhanced/cand-1',
        stagingDir: join(ws.stateDir, 'staging'),
        hostGeneration: () => 1,
      })

      const badDigest = await delivery.computeInProcessArtifactDigest({ sourceDir: v2CrashDir })
      const badPatchDigest = delivery.computeInProcessPatchDigest({ config: {} })
      const res = await runtime.activate({
        warrantDigest: sha256Hex('warrant-rb'),
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        mode: 'artifact-replace',
        target: {
          package: '@dsh-enhanced/cand-1',
          version: '0.1.84',
          artifactDigest: badDigest,
          patchDigest: badPatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2CrashDir, config: {} },
        },
      })

      expect(res.probe.reloaded).toBe(false)
      expect(res.probe.rolledBack).toBe(true)
      expect(res.probe.rollbackProbe?.failures).toBe(0)
      expect((ctx.get('candService' as never) as () => string)()).toBe('v1-healthy')
    })

    test('T1-F12-05: IN_PROCESS_RELOAD_DENYLIST retains core host safety while permitting evolved plugins', async () => {
      const delivery = await loadAssistantDelivery()
      expect(delivery.IN_PROCESS_RELOAD_DENYLIST).toContain('@dsh-enhanced/plugin-control-plane')
      expect(delivery.IN_PROCESS_RELOAD_DENYLIST).toContain('@dsh-enhanced/assistant-delivery')
      expect(delivery.IN_PROCESS_RELOAD_DENYLIST).not.toContain('@dsh-enhanced/evolved-custom-service')
    })
  })

  describe('F13: WP16 broader plugin evolution (service, channel, ui + rollback fallback)', () => {
    test('T1-F13-01: source creation validates service plugin with controlled package.json and cordis.patch.yml', async () => {
      const sc = await loadSourceCreation()
      const validateFiles = getExportFn<(files: readonly { path: string; content: string }[]) => void>(
        sc,
        'validateSourceCreationFiles',
      )
      const extractKind = getExportFn<(files: readonly { path: string; content: string }[]) => string>(
        sc,
        'extractCandidatePluginKindFromFiles',
      )

      const files = [
        { path: 'src/index.ts', content: 'export const name = "svc-1"; export function apply() {}' },
        {
          path: 'package.json',
          content: JSON.stringify({
            name: '@dsh-enhanced/svc-1',
            version: '0.1.0',
            main: './lib/index.js',
            dsh: { pluginKind: 'service', bundle: { patch: './cordis.patch.yml' } },
          }),
        },
        {
          path: 'cordis.patch.yml',
          content: '- insert:\n  - id: dsh-enhanced-svc-1\n    name: "@dsh-enhanced/svc-1"\n    config: {}\n',
        },
        { path: 'README.md', content: '# svc-1' },
      ]

      expect(() => validateFiles(files)).not.toThrow()
      expect(extractKind(files)).toBe('service')
    })

    test('T1-F13-02: source creation and revision accept channel and ui plugin kinds', async () => {
      const sc = await loadSourceCreation()
      const sr = await loadSourceRevision()
      const validateFiles = getExportFn<(files: readonly { path: string; content: string }[]) => void>(
        sc,
        'validateSourceCreationFiles',
      )
      const extractKind = getExportFn<(files: readonly { path: string; content: string }[]) => string>(
        sc,
        'extractCandidatePluginKindFromFiles',
      )
      const validatePatch = getExportFn<(name: string, base: string, cand: string) => void>(
        sc,
        'validateCandidateCordisPatch',
      )

      const channelFiles = [
        { path: 'src/index.ts', content: 'export const kind = "channel"; export function apply() {}' },
        {
          path: 'package.json',
          content: JSON.stringify({
            name: '@dsh-enhanced/ch-1',
            version: '0.1.0',
            main: './lib/index.js',
            dsh: { pluginKind: 'channel', bundle: { patch: './cordis.patch.yml' } },
          }),
        },
        {
          path: 'cordis.patch.yml',
          content: '- insert:\n  - id: dsh-enhanced-ch-1\n    name: "@dsh-enhanced/ch-1"\n    config: {}\n',
        },
      ]
      const uiFiles = [
        { path: 'src/index.ts', content: 'export const kind = "ui"; export function apply() {}' },
        {
          path: 'package.json',
          content: JSON.stringify({
            name: '@dsh-enhanced/ui-1',
            version: '0.1.0',
            main: './lib/index.js',
            dsh: { pluginKind: 'ui', bundle: { patch: './cordis.patch.yml' } },
          }),
        },
        {
          path: 'cordis.patch.yml',
          content: '- insert:\n  - id: dsh-enhanced-ui-1\n    name: "@dsh-enhanced/ui-1"\n    config: {}\n',
        },
      ]

      expect(() => validateFiles(channelFiles)).not.toThrow()
      expect(extractKind(channelFiles)).toBe('channel')
      expect(() => validateFiles(uiFiles)).not.toThrow()
      expect(extractKind(uiFiles)).toBe('ui')
      expect(() => validatePatch('ui-1', uiFiles[2]!.content, uiFiles[2]!.content)).not.toThrow()
      expect(sr.validateSourceRevisionGrant).toBeTypeOf('function')
      expect(sr.validateSourceRevisionBinding).toBeTypeOf('function')
    })

    test('T1-F13-03: plugin-behavior-runner supports verifying service plugin kind', async () => {
      const ws = await workspaces.create('f13-svc-verify-')
      const runnerMod = await loadPluginBehaviorRunner()
      const verifier = await loadAssistantVerifier()
      expect(runnerMod.isPluginKind('service')).toBe(true)
      expect(runnerMod.PluginBehaviorRunner).toBeTypeOf('function')
      expect(verifier.AssistantVerifierService).toBeDefined()

      const svcTgz = packPluginEntries({
        'package/package.json': JSON.stringify({ name: 'test-svc', version: '1.0.0', type: 'module', main: './lib/index.js' }),
        'package/cordis.patch.yml': '- insert:\n  - id: test-svc\n    name: test-svc\n',
        'package/lib/index.js': `
          import { Service } from '@deepseek-ai/cordis'
          class Greeter extends Service {
            constructor(ctx) { super(ctx, 'greeter') }
            health() { return { ready: true } }
            greet(input) { return { hello: input?.who ?? 'world' } }
          }
          export default Greeter
        `,
      })

      const disc = await runBehaviorWorkerOnTgz(ws.workspace, svcTgz, { kind: 'discover' }, 'service')
      expect(disc.status).toBe('result')
      expect(disc.pluginKind).toBe('service')

      const inv = await runBehaviorWorkerOnTgz(
        ws.workspace,
        svcTgz,
        {
          kind: 'invoke',
          schemaDigest: String(disc.schemaDigest),
          calls: [{ id: 'c1', toolName: 'service_method_probe', arguments: { service: 'greeter', method: 'greet', input: { who: 'e2e' } } }],
        },
        'service',
      )
      expect(inv.status).toBe('result')
      expect((inv.calls as Array<{ result: { value: unknown } }>)[0]?.result.value).toMatchObject({
        kind: 'service',
        service: 'greeter',
        method: 'greet',
        result: { hello: 'e2e' },
      })
    })

    test('T1-F13-04: plugin-behavior-runner supports verifying channel and ui plugin kinds', async () => {
      const ws = await workspaces.create('f13-ch-ui-verify-')
      const runnerMod = await loadPluginBehaviorRunner()
      expect(runnerMod.isPluginKind('channel')).toBe(true)
      expect(runnerMod.isPluginKind('ui')).toBe(true)

      const chanDir = join(ws.workspace, 'chan')
      const uiDir = join(ws.workspace, 'ui')
      await mkdir(chanDir, { recursive: true })
      await mkdir(uiDir, { recursive: true })

      const chanTgz = packPluginEntries({
        'package/package.json': JSON.stringify({ name: 'test-chan', version: '1.0.0', type: 'module', main: './lib/index.js' }),
        'package/cordis.patch.yml': '- insert:\n  - id: test-chan\n    name: test-chan\n    inject: [assistantDelivery]\n',
        'package/lib/index.js': `
          export const inject = ['assistantDelivery']
          export function apply(ctx) {
            ctx.effect(() => ctx.get('assistantDelivery').registerAdapter({
              channel: 'demo-chat',
              account: 'bot-1',
              capabilities: { text: true },
              start: async () => {},
              send: async () => ({ delivered: true }),
            }))
          }
        `,
      })
      const chanDisc = await runBehaviorWorkerOnTgz(chanDir, chanTgz, { kind: 'discover' }, 'channel')
      expect(chanDisc.status).toBe('result')
      expect(chanDisc.pluginKind).toBe('channel')

      const uiTgz = packPluginEntries({
        'package/package.json': JSON.stringify({
          name: 'test-ui',
          version: '1.0.0',
          type: 'module',
          main: './lib/index.js',
          exports: { '.': './lib/index.js', './client': './lib/client.js' },
          dsh: { client: { platform: 'web' } },
        }),
        'package/lib/client.js': 'export default function Panel() { return null }',
        'package/lib/index.js': `
          export const inject = ['typert']
          export const routes = ['/console/demo']
          export function apply(ctx) {
            ctx.typert.register({
              package: 'test-ui',
              face: 'web',
              schemas: { summary: { type: 'object' } },
              model: { services: [], events: [], objects: [] },
              invocations: {},
            })
          }
        `,
      })
      const uiDisc = await runBehaviorWorkerOnTgz(uiDir, uiTgz, { kind: 'discover' }, 'ui')
      expect(uiDisc.status).toBe('result')
      expect(uiDisc.pluginKind).toBe('ui')
    })

    test('T1-F13-05: coordinator rolls back automatically when evolved service reload/probe fails', async () => {
      const ws = await workspaces.create('f13-coord-rb-')
      const coord = await loadAdoptionCoordinator()
      const coordinate = getExportFn<(input: Record<string, unknown>) => Promise<{
        status: string
        activation?: { failureCode?: string }
      }>>(coord, 'coordinateAdoptionHandoff')

      const now = Date.now()
      let coordState: Record<string, unknown> = {
        id: 'plan:coord-e2e-rb',
        digest: sha256Hex('plan-coord'),
        status: 'awaiting-reload',
        revision: 3,
        activation: { id: 'activation:1', fence: 1 },
        dossier: { handoff: { schemaVersion: 1, coordinatorId: 'coord-1', maximumWindowMs: 60_000, commit: 'target-host' } },
        target: { dshHome: ws.dshHome, profile: 'web', profilePath: join(ws.dshHome, 'profiles', 'web') },
        installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
        ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(ws.stateDir, 'coord.sqlite') },
      }

      let storeRollbackCalls = 0
      const coordStore = {
        getPlan: () => coordState,
        assertAdoptionHandoff: () => {},
        getAdoptionHandoff: () => ({
          planId: coordState.id,
          planDigest: coordState.digest,
          coordinatorId: 'coord-1',
          createdAt: now,
          expiresAt: now + 60_000,
        }),
        getLiveQualificationDeadline: () => undefined,
        requestActivationRollback: (input: { failureCode: string }) => {
          storeRollbackCalls += 1
          coordState = {
            ...coordState,
            status: 'rollback-pending',
            revision: Number(coordState.revision) + 1,
            activation: { ...(coordState.activation as Record<string, unknown>), failureCode: input.failureCode },
          }
          return coordState
        },
      }

      let executeCalled = 0
      let rollbackHookCalls = 0
      const res = await coordinate({
        store: coordStore,
        trust: {},
        planId: coordState.id,
        inProcessReload: {
          canHandle: (p: { id: string }) => p.id === coordState.id,
          execute: async () => {
            executeCalled += 1
            const awaitingReadinessPlan = {
              ...coordState,
              status: 'awaiting-readiness',
              revision: Number(coordState.revision) + 1,
            }
            coordState = awaitingReadinessPlan
            return {
              status: 'reloaded',
              plan: awaitingReadinessPlan,
            }
          },
          rollback: async (plan: Record<string, unknown>, failureCode: string) => {
            rollbackHookCalls += 1
            const rolledBackPlan = {
              ...plan,
              status: 'rolled-back',
              revision: Number(plan.revision) + 1,
              activation: {
                ...(plan.activation as Record<string, unknown>),
                failureCode,
              },
            }
            coordState = rolledBackPlan
            return {
              status: 'rolled-back',
              plan: rolledBackPlan,
            }
          },
        },
      })
      expect(executeCalled).toBe(1)
      expect(storeRollbackCalls).toBe(1)
      expect(rollbackHookCalls).toBe(1)
      expect(res.status).toBe('rolled-back')
      expect(res.activation?.failureCode).toBe('in-process-readiness-failed')
    })
  })

  describe('F14: R3 self-iteration defaults across Growth, Evolution, Verifier, Delivery, Memory & Dreaming', () => {
    test('T1-F14-01: assistant-evolution and assistant-verifier default R3 safety & acceptance flags to true', async () => {
      const ws = await workspaces.create('f14-ev-')
      const { AssistantEvolutionService } = await loadAssistantEvolution()
      const verifierMod = await loadAssistantVerifier()

      const evoCfg = AssistantEvolutionService.Config({ databasePath: ws.sqlitePath('evo') })
      const verifierCfg = verifierMod.Config({ databasePath: ws.sqlitePath('verifier') })
      expect(evoCfg.autonomousRollback).toBe(true)
      expect(verifierCfg.requireAcceptance).toBe(true)
    })

    test('T1-F14-02: assistant-delivery default config enables attentionEnforce, attentionAttachOverCap & orderAcrossLanes', async () => {
      const ws = await workspaces.create('f14-del-')
      const { Config } = await loadAssistantDelivery()
      const parsed = Config({
        databasePath: ws.sqlitePath('del'),
        spoolPath: join(ws.stateDir, 'spool'),
      })
      expect(parsed.attentionEnforce).toBe(true)
      expect(parsed.attentionAttachOverCap).toBe(true)
      expect(parsed.ownerReportRouting?.orderAcrossLanes).toBe(true)
      expect(parsed.naturalFeedback?.coverage).toBe(true)
      expect(parsed.naturalFeedback?.mixedIntent).toBe(true)
    })

    test('T1-F14-03: assistant-growth-driver normalizeConfig enables proposals, failure learning, workflow & association', async () => {
      const { normalizeConfig } = await loadAssistantGrowthDriver()
      const cfg = normalizeConfig({}) as unknown as Record<string, unknown>
      expect(cfg.enabled).toBe(true)
      expect((cfg.workflowOwnerAnchored as Record<string, unknown> | undefined)?.enabled).toBe(true)
      expect((cfg.pluginSourceProposals as Record<string, unknown> | undefined)?.enabled).toBe(true)
      expect((cfg.pluginSourceProposals as Record<string, unknown> | undefined)?.allowCreation).toBe(true)
      expect((cfg.pluginSourceProposals as Record<string, unknown> | undefined)?.allowRevision).toBe(true)
      expect((cfg.dreamingIdeas as Record<string, unknown> | undefined)?.enabled).toBe(true)
      expect((cfg.associationCandidates as Record<string, unknown> | undefined)?.enabled).toBe(true)
      expect((cfg.usageLearning as Record<string, unknown> | undefined)?.enabled).toBe(true)
      expect((cfg.usageLearning as Record<string, unknown> | undefined)?.workItemFailures).toBe(true)
    })

    test('T1-F14-04: assistant-memory-learning, personal-memory & preference-learning enable R3 learning defaults', async () => {
      const ws = await workspaces.create('f14-mem-')
      const memLearn = await loadAssistantMemoryLearning()
      const pref = await loadPreferenceLearning()
      const pm = await loadPersonalMemory()

      const dormantMemLearn = memLearn.Config(undefined) as unknown as Record<string, unknown>
      expect(dormantMemLearn.enabled).toBe(true)
      expect(dormantMemLearn.workItemExperiences).toBe(true)

      const parsedMemLearn = memLearn.validateLearningConfig({
        databasePath: ws.sqlitePath('mem-learn'),
        authorityId: 'extraction-grant',
        owner: {
          authorityId: 'delivery-owner',
          authorityHash: sha256Hex('owner'),
          principalId: 'web/a/t/u',
          principalRecordId: 'principal-1',
          principalVersion: 1,
          workspace: ws.workspace,
          agentPreset: 'primary',
        },
        expiresAt: Date.now() + 60_000,
        budgetId: 'learning',
        scanBudgetId: 'scan',
        reviewAuthorityId: 'review',
        reviewAuthorityDigest: sha256Hex('review'),
        adoptionAuthorityId: 'adopt',
        adoptionGrantDigest: sha256Hex('adopt'),
      } as never) as unknown as Record<string, unknown>
      expect(parsedMemLearn.workItemExperiences).toBe(true)

      const prefCfg = pref.Config({ databasePath: ws.sqlitePath('pref') })
      expect(prefCfg.enabled).toBe(true)
      expect(prefCfg.autonomousT1Enabled).toBe(true)

      const pmMod = pm as Record<string, unknown>
      const pmSchema = pmMod.Config as ((input: Record<string, unknown>) => Record<string, unknown>) | undefined
      expect(pmSchema).toBeTypeOf('function')
      const pmCfg = pmSchema!({ databasePath: ':memory:' })
      expect(pmCfg.automaticLearning).toBe(true)
    })

    test('T1-F14-05: assistant-dreaming normalizeConfig enables dreaming by default when owner prerequisites are complete', async () => {
      const ws = await workspaces.create('f14-dream-')
      const { normalizeConfig, hasCompleteDreamingPrerequisites } = await loadAssistantDreaming()
      const databasePath = ws.sqlitePath('dream')

      // Incomplete prerequisites remain fail-closed dormant.
      expect(hasCompleteDreamingPrerequisites({ databasePath })).toBe(false)
      expect(normalizeConfig({ databasePath }).enabled).toBe(false)

      // Complete owner prerequisites with omitted `enabled` default to `enabled: true`.
      const completeConfig = {
        databasePath,
        scope: {
          workspace: ws.workspace,
          preset: 'primary',
          principalId: 'web/a/t/u',
          ownerRouteId: 'route-1',
        },
        provider: 'deepseek',
        model: 'deepseek-chat',
        budgetId: 'dream-budget',
        budgetAmount: 1,
      }
      expect(hasCompleteDreamingPrerequisites(completeConfig)).toBe(true)
      const cfg = normalizeConfig(completeConfig)
      expect(cfg.enabled).toBe(true)
    })
  })
})
