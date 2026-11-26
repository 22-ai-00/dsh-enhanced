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
    nonce: 'b'.repeat(64),
    artifactSha256,
    entry: staged.entry,
    modulesPath,
    operation: { kind: 'discover' },
    pluginKind,
  })
  const res = await runCommandProcess(process.execPath, [workerPath], { cwd: workRoot, stdin })
  expect(res.exitCode).toBe(0)
  return JSON.parse(res.stdout.trim()) as Record<string, unknown>
}

describe('Tier 2 — F12–F14: inProcessReload, Evolution & R3 Defaults Boundary Cases', () => {
  describe('F12: WP16 inProcessReload negative, fence/generation & rollback boundaries', () => {
    test('T2-F12-01: disabled inProcessReload suppresses service registration and denied/relative delivery config throws', async () => {
      const ws = await workspaces.create('f12-disabled-')
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
        inProcessReload: { enabled: false },
      })
      expect(ctx.get('inProcessReload' as never)).toBeUndefined()

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
      expect(pcp.canInProcessReload()).toBe(false)

      const ctxBad = harness.createContext()
      await harness.mountService(ctxBad, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy-bad') })
      await expect(harness.mountService(ctxBad, AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery-bad'),
        spoolPath: join(ws.stateDir, 'spool-bad'),
        schedulerEnabled: false,
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'standard',
        inProcessReload: {
          enabled: true,
          profilePath: join(ws.dshHome, 'profiles', 'web'),
          stagingDir: join(ws.stateDir, 'staging'),
          entryId: 'delivery',
          package: '@dsh-ray/assistant-delivery',
        },
      })).rejects.toThrow(/denied/i)

      const ctxRel = harness.createContext()
      await harness.mountService(ctxRel, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy-rel') })
      await expect(harness.mountService(ctxRel, AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery-rel'),
        spoolPath: join(ws.stateDir, 'spool-rel'),
        schedulerEnabled: false,
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'standard',
        inProcessReload: {
          enabled: true,
          profilePath: 'relative/profile',
          stagingDir: join(ws.stateDir, 'staging'),
          entryId: 'cand',
          package: '@dsh-ray/custom-cand',
        },
      })).rejects.toThrow(/absolute/i)
    }, 15_000)

    test('T2-F12-02: createInProcessReloadRuntime rejects denylisted targets, invalid digests, and process-subtree/unproven authority flags', async () => {
      const ws = await workspaces.create('f12-guards-')
      const delivery = await loadAssistantDelivery()
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })

      const ctx = harness.createContext()
      expect(() => delivery.createInProcessReloadRuntime(ctx, {
        profilePath: profileDir,
        entryId: 'pcp',
        package: '@dsh-ray/plugin-control-plane',
        stagingDir: join(ws.stateDir, 'staging'),
        hostGeneration: () => 1,
      })).toThrow(/denied|process restart/i)

      const validDigest = sha256Hex('valid')

      const runtime = delivery.createInProcessReloadRuntime(ctx, {
        profilePath: profileDir,
        entryId: 'cand-1',
        package: '@dsh-ray/cand-1',
        stagingDir: join(ws.stateDir, 'staging'),
        hostGeneration: () => 1,
      })

      await expect(runtime.activate({
        warrantDigest: 'not-64-hex',
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        mode: 'config-only',
        target: {
          package: '@dsh-ray/cand-1',
          version: '0.1.0',
          artifactDigest: validDigest,
          patchDigest: validDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
        },
      })).rejects.toThrow(/warrant digest/i)

      await expect(runtime.activate({
        warrantDigest: validDigest,
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        mode: 'config-only',
        target: {
          package: '@dsh-ray/cand-1',
          version: '0.1.0',
          artifactDigest: validDigest,
          patchDigest: validDigest,
          changesProcessSubtree: true,
          holdsUnprovenProcessAuthority: false,
        },
      })).rejects.toThrow(/process restart/i)

      await expect(runtime.activate({
        warrantDigest: validDigest,
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        mode: 'artifact-replace',
        target: {
          package: '@dsh-ray/cand-1',
          version: '0.1.0',
          artifactDigest: validDigest,
          patchDigest: validDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: true,
        },
      })).rejects.toThrow(/process restart/i)
    })

    test('T2-F12-03: hostGeneration mismatch, artifact/patch digest mismatch & unmounted entryId fail closed', async () => {
      const ws = await workspaces.create('f12-mismatch-')
      const delivery = await loadAssistantDelivery()
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      const profileFile = join(profileDir, 'cordis.yml')
      const v1Dir = join(ws.root, 'bundles', 'v1')
      const v2Dir = join(ws.root, 'bundles', 'v2')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      await writeBundlePackage(v1Dir, {
        name: '@dsh-ray/m-1',
        version: '0.1.0',
        body: 'export const name = "m-1"; export function apply() {}',
      })
      await writeBundlePackage(v2Dir, {
        name: '@dsh-ray/m-1',
        version: '0.2.0',
        body: 'export const name = "m-1"; export function apply() {}',
      })
      await writeFile(profileFile, `- id: m-1\n  name: ${join(v1Dir, 'lib/index.js')}\n  config: {}\n`, 'utf8')

      const ctx = harness.createContext()
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      await ctx.loader.create({
        id: 'include',
        name: 'cordis:include',
        config: { path: pathToFileURL(profileFile).href },
      } as never)
      await ctx.loader.await()

      const runtime = delivery.createInProcessReloadRuntime(ctx, {
        profilePath: profileDir,
        entryId: 'm-1',
        package: '@dsh-ray/m-1',
        stagingDir: join(ws.stateDir, 'staging'),
        hostGeneration: () => 2,
      })

      const v2Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: v2Dir })
      const v2PatchDigest = delivery.computeInProcessPatchDigest({ config: {} })

      await expect(runtime.activate({
        warrantDigest: sha256Hex('w'),
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        mode: 'artifact-replace',
        target: {
          package: '@dsh-ray/m-1',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: v2PatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: {} },
        },
      })).rejects.toThrow(/generation/i)

      await expect(runtime.activate({
        warrantDigest: sha256Hex('w'),
        previousHostGeneration: 2,
        previousInProcessGeneration: 1,
        mode: 'artifact-replace',
        target: {
          package: '@dsh-ray/m-1',
          version: '0.2.0',
          artifactDigest: sha256Hex('wrong-artifact-digest'),
          patchDigest: v2PatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: {} },
        },
      })).rejects.toThrow(/digest/i)

      await expect(runtime.activate({
        warrantDigest: sha256Hex('w'),
        previousHostGeneration: 2,
        previousInProcessGeneration: 1,
        mode: 'artifact-replace',
        target: {
          package: '@dsh-ray/m-1',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: sha256Hex('wrong-patch-digest'),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: {} },
        },
      })).rejects.toThrow(/patch digest/i)

      const unmountedRuntime = delivery.createInProcessReloadRuntime(ctx, {
        profilePath: profileDir,
        entryId: 'nonexistent-entry',
        package: '@dsh-ray/m-1',
        stagingDir: join(ws.stateDir, 'staging'),
        hostGeneration: () => 2,
      })
      await expect(unmountedRuntime.activate({
        warrantDigest: sha256Hex('w'),
        previousHostGeneration: 2,
        previousInProcessGeneration: 1,
        mode: 'config-only',
        target: {
          package: '@dsh-ray/m-1',
          version: '0.1.0',
          artifactDigest: v2Digest,
          patchDigest: v2PatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
        },
      })).rejects.toThrow(/not mounted/i)
    })

    test('T2-F12-04: missing injection in candidate v2 triggers automatic rollback leaving v1 service live', async () => {
      const ws = await workspaces.create('f12-inject-rb-')
      const delivery = await loadAssistantDelivery()
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      const profileFile = join(profileDir, 'cordis.yml')
      const v1Dir = join(ws.root, 'bundles', 'inj-v1')
      const v2BadInjDir = join(ws.root, 'bundles', 'inj-v2')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })

      await writeBundlePackage(v1Dir, {
        name: '@dsh-ray/inj-cand',
        version: '0.1.0',
        body: 'export const name = "inj-cand"; export function apply(ctx) { ctx.provide("injSvc", () => "v1-ok") }',
      })
      await writeBundlePackage(v2BadInjDir, {
        name: '@dsh-ray/inj-cand',
        version: '0.2.0',
        body: 'export const name = "inj-cand"; export const inject = ["missingPeerService"]; export function apply(ctx) { ctx.provide("injSvc", () => "v2-never") }',
      })
      await writeFile(profileFile, `- id: inj-cand\n  name: ${join(v1Dir, 'lib/index.js')}\n  config: {}\n`, 'utf8')

      const ctx = harness.createContext()
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      await ctx.loader.create({
        id: 'include',
        name: 'cordis:include',
        config: { path: pathToFileURL(profileFile).href },
      } as never)
      await ctx.loader.await()
      expect((ctx.get('injSvc' as never) as () => string)()).toBe('v1-ok')

      const runtime = delivery.createInProcessReloadRuntime(ctx, {
        profilePath: profileDir,
        entryId: 'inj-cand',
        package: '@dsh-ray/inj-cand',
        stagingDir: join(ws.stateDir, 'staging'),
        hostGeneration: () => 1,
      })
      const v2Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: v2BadInjDir })
      const v2PatchDigest = delivery.computeInProcessPatchDigest({ config: {} })

      const res = await runtime.activate({
        warrantDigest: sha256Hex('w-inj'),
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        mode: 'artifact-replace',
        target: {
          package: '@dsh-ray/inj-cand',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: v2PatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2BadInjDir, config: {} },
        },
      })
      expect(res.probe.reloaded).toBe(false)
      expect(res.probe.rolledBack).toBe(true)
      expect(res.probe.rollbackProbe?.failures).toBe(0)
      expect((ctx.get('injSvc' as never) as () => string)()).toBe('v1-ok')
    })

    test('T2-F12-05: disposed reload runtime and invalid AdoptionCoordinatorConfig bounds are rejected', async () => {
      const ws = await workspaces.create('f12-disposed-')
      const delivery = await loadAssistantDelivery()
      const coord = await loadAdoptionCoordinator()
      const validateCoordCfg = getExportFn<(cfg: unknown) => void>(coord, 'validateAdoptionCoordinatorConfig')

      const ctx = harness.createContext()
      const runtime = delivery.createInProcessReloadRuntime(ctx, {
        profilePath: join(ws.dshHome, 'profiles', 'web'),
        entryId: 'cand-1',
        package: '@dsh-ray/cand-1',
        stagingDir: join(ws.stateDir, 'staging'),
        hostGeneration: () => 1,
        isActive: () => false,
      })
      await expect(runtime.activate({
        warrantDigest: sha256Hex('w'),
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        mode: 'config-only',
        target: {
          package: '@dsh-ray/cand-1',
          version: '0.1.0',
          artifactDigest: sha256Hex('a'),
          patchDigest: sha256Hex('p'),
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
        },
      })).rejects.toThrow(/disposed/i)

      const validCfg = {
        coordinatorId: 'coord-1',
        scope: { workspace: ws.workspace, preset: 'primary', principalId: 'web/a/t/u', ownerRouteId: 'r1' },
        timeoutMs: 5_000,
        budgetId: 'b1',
        budgetAmount: 1,
      }
      expect(() => validateCoordCfg(validCfg)).not.toThrow()
      expect(() => validateCoordCfg({ ...validCfg, timeoutMs: 999 })).toThrow()
      expect(() => validateCoordCfg({ ...validCfg, timeoutMs: 300_001 })).toThrow()
      expect(() => validateCoordCfg({ ...validCfg, budgetAmount: 0 })).toThrow()
      expect(() => validateCoordCfg({ ...validCfg, scope: { ...validCfg.scope, workspace: 'relative/path' } })).toThrow()
    })

    test('T2-F12-06: coordinateAdoptionHandoff handles execute throw & stale revision fence conflict cleanly', async () => {
      const ws = await workspaces.create('f12-coord-throw-')
      const coord = await loadAdoptionCoordinator()
      const coordinate = getExportFn<(input: Record<string, unknown>) => Promise<{
        status: string
        activation?: { failureCode?: string }
      }>>(coord, 'coordinateAdoptionHandoff')

      const now = Date.now()
      let plan: Record<string, unknown> = {
        id: 'plan:throw-rb',
        digest: sha256Hex('plan-throw'),
        status: 'awaiting-reload',
        revision: 4,
        activation: { id: 'act:1', fence: 2 },
        dossier: { handoff: { schemaVersion: 1, coordinatorId: 'coord-1', maximumWindowMs: 60_000, commit: 'target-host' } },
        target: { dshHome: ws.dshHome, profile: 'web', profilePath: join(ws.dshHome, 'profiles', 'web') },
        installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f10',
        ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f11', path: join(ws.stateDir, 'coord.sqlite') },
      }

      const store = {
        getPlan: () => plan,
        assertAdoptionHandoff: () => {},
        getAdoptionHandoff: () => ({
          planId: plan.id,
          planDigest: plan.digest,
          coordinatorId: 'coord-1',
          createdAt: now,
          expiresAt: now + 60_000,
        }),
        getLiveQualificationDeadline: () => undefined,
        requestActivationRollback: (input: { expectedRevision: number; fence: number; failureCode: string }) => {
          if (input.expectedRevision !== plan.revision) throw new Error('revision fence mismatch')
          plan = {
            ...plan,
            status: 'rollback-pending',
            revision: Number(plan.revision) + 1,
            activation: { ...(plan.activation as Record<string, unknown>), failureCode: input.failureCode },
          }
          return plan
        },
      }

      const res = await coordinate({
        store,
        trust: {},
        planId: plan.id,
        inProcessReload: {
          canHandle: () => true,
          execute: async () => {
            throw new Error('reload transport failed')
          },
          rollback: async (p: Record<string, unknown>, failureCode: string) => ({
            status: 'rolled-back',
            plan: {
              ...p,
              status: 'rolled-back',
              activation: { ...(p.activation as Record<string, unknown>), failureCode },
            },
          }),
        },
      })
      expect(res.status).toBe('rolled-back')
      expect(res.activation?.failureCode).toBe('in-process-reload-error')

      // Stale revision/fence mismatch inside store propagates fail-closed.
      await expect(coordinate({
        store: {
          ...store,
          getPlan: () => ({ ...plan, status: 'awaiting-reload', revision: 4 }),
          requestActivationRollback: () => {
            throw new Error('stale revision conflict')
          },
        },
        trust: {},
        planId: 'plan:throw-rb',
        inProcessReload: {
          canHandle: () => true,
          execute: async () => { throw new Error('boom') },
        },
      })).rejects.toThrow(/stale revision conflict/i)
    })
  })

  describe('F13: WP16 source-creation/revision boundaries & plugin-behavior-runner failure/rollback', () => {
    test('T2-F13-01: validateSourceCreationFiles rejects bad package.json, non-catalog deps, invalid pluginKind & immutable files', async () => {
      const sc = await loadSourceCreation()
      const validateFiles = getExportFn<(files: readonly { path: string; content: string }[]) => void>(
        sc,
        'validateSourceCreationFiles',
      )

      const validPatch = '- insert:\n  - id: dsh-ray-demo-1\n    name: "@dsh-ray/demo-1"\n    config: {}\n'
      const validSrc = 'export const name = "demo-1"; export function apply() {}'

      expect(() => validateFiles([
        { path: 'src/index.ts', content: validSrc },
        { path: 'package.json', content: '{not json' },
        { path: 'cordis.patch.yml', content: validPatch },
      ])).toThrow(/invalid JSON/i)

      expect(() => validateFiles([
        { path: 'src/index.ts', content: validSrc },
        {
          path: 'package.json',
          content: JSON.stringify({
            name: '@dsh-ray/demo-1',
            version: '0.1.0',
            main: './lib/index.js',
            dependencies: { lodash: '^4.17.21' },
            dsh: { pluginKind: 'service', bundle: { patch: './cordis.patch.yml' } },
          }),
        },
        { path: 'cordis.patch.yml', content: validPatch },
      ])).toThrow(/catalog:/i)

      expect(() => validateFiles([
        { path: 'src/index.ts', content: validSrc },
        {
          path: 'package.json',
          content: JSON.stringify({
            name: '@dsh-ray/demo-1',
            version: '0.1.0',
            main: './lib/index.js',
            dsh: { pluginKind: 'kernel', bundle: { patch: './cordis.patch.yml' } },
          }),
        },
        { path: 'cordis.patch.yml', content: validPatch },
      ])).toThrow()

      expect(() => validateFiles([
        { path: 'src/index.ts', content: validSrc },
        { path: 'src/version.ts', content: 'export const version = "0.1.0"' },
        {
          path: 'package.json',
          content: JSON.stringify({
            name: '@dsh-ray/demo-1',
            version: '0.1.0',
            main: './lib/index.js',
            dsh: { pluginKind: 'service', bundle: { patch: './cordis.patch.yml' } },
          }),
        },
        { path: 'cordis.patch.yml', content: validPatch },
      ])).toThrow()
    })

    test('T2-F13-02: validateCandidateCordisPatch rejects tabs, YAML anchors/tags, disallowed keys, multi-insert & >32 inject entries', async () => {
      const sc = await loadSourceCreation()
      const validatePatch = getExportFn<(name: string, base: string, cand: string) => void>(
        sc,
        'validateCandidateCordisPatch',
      )

      const base = '- insert:\n  - id: dsh-ray-cand-x\n    name: "@dsh-ray/cand-x"\n    config: {}\n'
      expect(() => validatePatch('cand-x', base, '')).toThrow()
      expect(() => validatePatch('cand-x', base, '- insert:\n\t- id: dsh-ray-cand-x\n')).toThrow()
      expect(() => validatePatch('cand-x', base, '---\n- insert:\n  - id: dsh-ray-cand-x\n')).toThrow()
      expect(() => validatePatch('cand-x', base, '- insert:\n  - id: dsh-ray-cand-x\n    name: !!js/function "() => {}"\n')).toThrow()
      expect(() => validatePatch('cand-x', base, '- insert:\n  - id: dsh-ray-cand-x\n    name: "@dsh-ray/cand-x"\n    autoload: true\n')).toThrow()
      expect(() => validatePatch('cand-x', base, '- insert:\n  - id: dsh-ray-other\n    name: "@dsh-ray/cand-x"\n')).toThrow()

      const thirtyThreeInject = Array.from({ length: 33 }, (_, idx) => `svc_${idx}`).join(', ')
      expect(() => validatePatch(
        'cand-x',
        base,
        `- insert:\n  - id: dsh-ray-cand-x\n    name: "@dsh-ray/cand-x"\n    inject: [${thirtyThreeInject}]\n`,
      )).toThrow()
    })

    test('T2-F13-03: source-revision rejects invalid maxRevisions, malformed namePrefix, expired grant & mismatched growthRun', async () => {
      const sr = await loadSourceRevision()
      const validateGrant = getExportFn<(g: unknown) => void>(sr, 'validateSourceRevisionGrant')
      const validateBinding = getExportFn<(input: Record<string, unknown>) => void>(sr, 'validateSourceRevisionBinding')

      const validGrant = {
        id: 'grant-rev-1',
        namePrefix: 'evolved-',
        maxRevisions: 5,
        expiresAt: Date.now() + 60_000,
      }

      expect(() => validateGrant({ ...validGrant, maxRevisions: 0 })).toThrow()
      expect(() => validateGrant({ ...validGrant, maxRevisions: 1001 })).toThrow()
      expect(() => validateGrant({ ...validGrant, namePrefix: 'no-trailing-dash' })).toThrow()
      expect(() => validateGrant({ ...validGrant, expiresAt: 0 })).toThrow()

      expect(() => validateBinding({
        grant: validGrant,
        packageName: '@dsh-ray/evolved-alpha',
        allowWithoutGrowthRun: false,
      })).toThrow()

      expect(() => validateBinding({
        grant: validGrant,
        packageName: '@dsh-ray/evolved-alpha',
        growthRun: {
          runId: 'gr-1',
          revisionAcceptance: { namePrefix: 'other-' },
        },
      })).toThrow()
    })

    test('T2-F13-04: native-behavior-worker fails closed on unapproved bare import, unhealthy service, channel without send & ui without client', async () => {
      const ws = await workspaces.create('f13-worker-fail-')
      const d1 = join(ws.workspace, 'bad-import')
      const d2 = join(ws.workspace, 'bad-svc')
      const d3 = join(ws.workspace, 'bad-chan')
      const d4 = join(ws.workspace, 'bad-ui')
      await Promise.all([
        mkdir(d1, { recursive: true }),
        mkdir(d2, { recursive: true }),
        mkdir(d3, { recursive: true }),
        mkdir(d4, { recursive: true }),
      ])

      const badImportTgz = packPluginEntries({
        'package/package.json': JSON.stringify({ name: 'bad-imp', version: '1.0.0', type: 'module', main: './lib/index.js' }),
        'package/lib/index.js': 'import "totally-nonexistent-external-pkg"\nexport function apply() {}\n',
      })
      const impRes = await runBehaviorWorkerOnTgz(d1, badImportTgz, 'service')
      expect(impRes.status).toBe('unknown')
      expect(impRes.reason).toBe('candidate-bare-import-not-approved')

      const unhealthySvcTgz = packPluginEntries({
        'package/package.json': JSON.stringify({ name: 'bad-svc', version: '1.0.0', type: 'module', main: './lib/index.js' }),
        'package/lib/index.js': `
          import { Service } from '@deepseek-ai/cordis'
          class BadSvc extends Service {
            constructor(ctx) { super(ctx, 'badSvc') }
            health() { return { ready: false } }
          }
          export default BadSvc
        `,
      })
      const svcRes = await runBehaviorWorkerOnTgz(d2, unhealthySvcTgz, 'service')
      expect(svcRes.status).toBe('unknown')
      expect(svcRes.reason).toBe('service-health-failed')

      const badChanTgz = packPluginEntries({
        'package/package.json': JSON.stringify({ name: 'bad-chan', version: '1.0.0', type: 'module', main: './lib/index.js' }),
        'package/lib/index.js': 'export const inject = ["assistantDelivery"]; export function apply() {}\n',
      })
      const chanRes = await runBehaviorWorkerOnTgz(d3, badChanTgz, 'channel')
      expect(chanRes.status).toBe('unknown')
      expect(chanRes.reason).toBe('invalid-channel-plugin')

      const badUiTgz = packPluginEntries({
        'package/package.json': JSON.stringify({ name: 'bad-ui', version: '1.0.0', type: 'module', main: './lib/index.js' }),
        'package/lib/index.js': 'export const inject = ["typert"]; export function apply() {}\n',
      })
      const uiRes = await runBehaviorWorkerOnTgz(d4, badUiTgz, 'ui')
      expect(uiRes.status).toBe('unknown')
      expect(uiRes.reason).toBe('invalid-ui-plugin')
    })

    test('T2-F13-05: PluginBehaviorRunner rejects empty/oversized artifacts and coordinator rolls back on rollback-pending execute', async () => {
      const ws = await workspaces.create('f13-runner-bounds-')
      const { PluginBehaviorRunner } = await loadPluginBehaviorRunner()
      const coord = await loadAdoptionCoordinator()
      const coordinate = getExportFn<(input: Record<string, unknown>) => Promise<{
        status: string
        activation?: { failureCode?: string }
      }>>(coord, 'coordinateAdoptionHandoff')

      const linuxRuntimeRoot = join(ws.stateDir, 'linux-beh-runtime')
      const linuxObserver = {
        schemaVersion: 1,
        sourceSha256: sha256Hex('obs-source'),
        workerSha256: sha256Hex('obs-worker'),
        candidateSha256: sha256Hex('obs-cand'),
        launcherSha256: sha256Hex('obs-launch'),
        parentProtectSha256: sha256Hex('obs-pprot'),
        childProtectSha256: sha256Hex('obs-cprot'),
      }
      const runner = new (PluginBehaviorRunner as new (opts: Record<string, unknown>) => {
        run: (input: Record<string, unknown>) => Promise<{ status: string; quiescent: boolean; reason: string }>
      })({
        stateRoot: join(ws.stateDir, 'beh-state'),
        authorityDigest: sha256Hex('beh-auth'),
        expiresAt: Date.now() + 60_000,
        maxRuns: 10,
        maxTotalDurationMs: 60_000,
        maxDurationMs: 10_000,
        maxOutputBytes: 65_536,
        backend: 'linux-native',
        cgroupRoots: { mode: 'v2', unified: '/sys/fs/cgroup/dsh-native/uid-1000' },
        runtime: {
          schemaVersion: 1,
          observer: linuxObserver,
          runtime: {
            schemaVersion: 1,
            backend: 'linux-native',
            platform: `linux-${process.arch}`,
            sourceCommit: 'a'.repeat(40),
            lockSha256: sha256Hex('lock'),
            root: { path: linuxRuntimeRoot, dev: 1, ino: 1, sha256: sha256Hex('root') },
            nodePath: `${linuxRuntimeRoot}/bin/node`,
            nodeSha256: sha256Hex('node'),
            pnpmPath: `${linuxRuntimeRoot}/pnpm/bin/pnpm.mjs`,
            nativePnpmPath: `${linuxRuntimeRoot}/pnpm-native/pnpm`,
            nativePnpmRoot: `${linuxRuntimeRoot}/pnpm-native`,
            modulesPath: `${linuxRuntimeRoot}/node_modules`,
            storePath: `${linuxRuntimeRoot}/store`,
            cachePath: `${linuxRuntimeRoot}/cache`,
            versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '5.8.0', cordis: '4.14.0', tools: '1.0.0', systemPrompt: '1.0.0' },
          },
        },
      })

      const emptyRes = await runner.run({
        key: 'k-empty',
        artifact: Buffer.alloc(0),
        operation: { kind: 'discover' },
        signal: new AbortController().signal,
      })
      expect(emptyRes.status).toBe('unknown')
      expect(emptyRes.quiescent).toBe(true)
      expect(emptyRes.reason).toBe('plugin-artifact-out-of-bound')

      const hugeRes = await runner.run({
        key: 'k-huge',
        artifact: Buffer.alloc(512 * 1024 + 1),
        operation: { kind: 'discover' },
        signal: new AbortController().signal,
      })
      expect(hugeRes.status).toBe('unknown')
      expect(hugeRes.quiescent).toBe(true)
      expect(hugeRes.reason).toBe('plugin-artifact-out-of-bound')

      const now = Date.now()
      let plan: Record<string, unknown> = {
        id: 'plan:rb-pending',
        digest: sha256Hex('plan-rbp'),
        status: 'awaiting-reload',
        revision: 1,
        activation: { id: 'act:rbp', fence: 1 },
        dossier: { handoff: { schemaVersion: 1, coordinatorId: 'coord-1', maximumWindowMs: 60_000, commit: 'target-host' } },
        target: { dshHome: ws.dshHome, profile: 'web', profilePath: join(ws.dshHome, 'profiles', 'web') },
        installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f20',
        ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f21', path: join(ws.stateDir, 'coord.sqlite') },
      }
      let rollbackHookCalled = 0
      const res = await coordinate({
        store: {
          getPlan: () => plan,
          assertAdoptionHandoff: () => {},
          getAdoptionHandoff: () => ({ planId: plan.id, planDigest: plan.digest, coordinatorId: 'coord-1', createdAt: now, expiresAt: now + 60_000 }),
          getLiveQualificationDeadline: () => undefined,
          requestActivationRollback: (input: { failureCode: string }) => {
            plan = {
              ...plan,
              status: 'rollback-pending',
              revision: Number(plan.revision) + 1,
              activation: { ...(plan.activation as Record<string, unknown>), failureCode: input.failureCode },
            }
            return plan
          },
        },
        trust: {},
        planId: plan.id,
        inProcessReload: {
          canHandle: () => true,
          execute: async (p: Record<string, unknown>) => {
            plan = { ...p, status: 'awaiting-readiness', revision: Number(p.revision) + 1 }
            return { status: 'reloaded', plan }
          },
          rollback: async (p: Record<string, unknown>, failureCode: string) => {
            rollbackHookCalled += 1
            plan = { ...p, status: 'rolled-back', activation: { ...(p.activation as Record<string, unknown>), failureCode } }
            return { status: 'rolled-back', plan }
          },
        },
      })
      expect(res.status).toBe('rolled-back')
      expect(res.activation?.failureCode).toBe('in-process-readiness-failed')
      expect(rollbackHookCalled).toBe(1)
    })
  })

  describe('F14: R3 explicit false overrides, cross-field & Standard-Schema boundaries', () => {
    test('T2-F14-01: explicit false overrides remain false across evolution, verifier, memory-learning, personal-memory, preference-learning & dreaming', async () => {
      const ws = await workspaces.create('f14-false-')
      const { AssistantEvolutionService } = await loadAssistantEvolution()
      const verifierMod = await loadAssistantVerifier()
      const memLearn = await loadAssistantMemoryLearning()
      const pm = await loadPersonalMemory()
      const pref = await loadPreferenceLearning()
      const dreaming = await loadAssistantDreaming()

      expect(AssistantEvolutionService.Config({ databasePath: ws.sqlitePath('evo'), autonomousRollback: false }).autonomousRollback).toBe(false)
      expect(verifierMod.Config({ databasePath: ws.sqlitePath('ver'), requireAcceptance: false }).requireAcceptance).toBe(false)
      expect(memLearn.Config({ enabled: false, workItemExperiences: false } as never)).toMatchObject({ enabled: false, workItemExperiences: false })
      expect((pm as { Config: (c: unknown) => { automaticLearning: boolean } }).Config({ databasePath: ':memory:', automaticLearning: false }).automaticLearning).toBe(false)
      expect(pref.Config({ databasePath: ws.sqlitePath('pref'), enabled: false, autonomousT1Enabled: false })).toMatchObject({
        enabled: false,
        autonomousT1Enabled: false,
      })
      expect(dreaming.normalizeConfig({ databasePath: ws.sqlitePath('dream'), enabled: false } as never).enabled).toBe(false)
    })

    test('T2-F14-02: assistant-growth-driver cascades enabled: false and rejects missing scope, non-offline source & unknown keys', async () => {
      const { normalizeConfig } = await loadAssistantGrowthDriver()

      const off = normalizeConfig({ enabled: false }) as unknown as Record<string, unknown>
      expect(off.enabled).toBe(false)
      expect((off.pluginSourceProposals as Record<string, unknown>).enabled).toBe(false)
      expect((off.usageLearning as Record<string, unknown>).enabled).toBe(false)
      expect((off.dreamingIdeas as Record<string, unknown>).enabled).toBe(false)
      expect((off.associationCandidates as Record<string, unknown>).enabled).toBe(false)

      const partialOff = normalizeConfig({ usageLearning: { workItemFailures: false } }) as unknown as Record<string, unknown>
      expect(partialOff.enabled).toBe(true)
      expect((partialOff.usageLearning as Record<string, unknown>).workItemFailures).toBeUndefined()

      expect(() => normalizeConfig({ enabled: true })).toThrow(/scope/i)
      expect(() => normalizeConfig({
        enabled: true,
        scope: { workspace: '/work/a', preset: 'primary', principalId: 'web/a/t/u', ownerRouteId: 'r1' },
        pluginSourceProposals: { enabled: true, offline: false },
      } as never)).toThrow(/offline/i)
      expect(() => normalizeConfig({ unknownField: 1 } as never)).toThrow()
    })

    test('T2-F14-03: assistant-delivery honors explicit false attention/routing/feedback flags and rejects invalid bounds', async () => {
      const ws = await workspaces.create('f14-del-bounds-')
      const { Config } = await loadAssistantDelivery()

      const off = Config({
        databasePath: ws.sqlitePath('del'),
        spoolPath: join(ws.stateDir, 'spool'),
        attentionEnforce: false,
        attentionAttachOverCap: false,
        ownerReportRouting: { orderAcrossLanes: false },
        naturalFeedback: { coverage: false, mixedIntent: false },
      })
      expect(off.attentionEnforce).toBe(false)
      expect(off.attentionAttachOverCap).toBe(false)
      expect(off.ownerReportRouting?.orderAcrossLanes).toBe(false)
      expect(off.naturalFeedback?.coverage).toBe(false)
      expect(off.naturalFeedback?.mixedIntent).toBe(false)

      expect(() => Config({
        databasePath: ws.sqlitePath('del'),
        spoolPath: join(ws.stateDir, 'spool'),
        tickIntervalMs: 99,
      })).toThrow()
      expect(() => Config({
        databasePath: ws.sqlitePath('del'),
        spoolPath: join(ws.stateDir, 'spool'),
        agentMaxAutoContinuationTurns: 9,
      })).toThrow()
      expect(() => Config({
        databasePath: ws.sqlitePath('del'),
        spoolPath: join(ws.stateDir, 'spool'),
        attentionAttachOverCap: 'yes' as never,
      })).toThrow()
    })

    test('T2-F14-04: dreaming, preference-learning, verifier & memory-learning reject boundary violations in Standard-Schema/validators', async () => {
      const ws = await workspaces.create('f14-schema-')
      const dreaming = await loadAssistantDreaming()
      const pref = await loadPreferenceLearning()
      const verifierMod = await loadAssistantVerifier()
      const memLearn = await loadAssistantMemoryLearning()

      const dreamScope = { workspace: ws.workspace, preset: 'primary', principalId: 'web/a/t/u', ownerRouteId: 'r1' }
      expect(() => dreaming.normalizeConfig({ retired: true, enabled: false } as never)).toThrow()
      expect(() => dreaming.normalizeConfig({
        databasePath: ws.sqlitePath('dream'),
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        budgetId: 'b1',
        budgetAmount: 100,
        scope: dreamScope,
        activeHours: { timezone: 'UTC', startMinute: 600, endMinute: 600 },
      } as never)).toThrow(/startMinute/i)
      expect(() => dreaming.normalizeConfig({
        databasePath: ws.sqlitePath('dream'),
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        budgetId: 'b1',
        budgetAmount: 100,
        scope: dreamScope,
        maxDreamsPerDay: 2,
        maxNotificationsPerDay: 3,
      } as never)).toThrow()

      expect(() => pref.Config({ databasePath: ws.sqlitePath('pref'), minConfidenceBps: 5999 })).toThrow()
      expect(() => pref.Config({ databasePath: ws.sqlitePath('pref'), maxContradictionBps: 4001 })).toThrow()
      expect(() => pref.Config({ databasePath: ws.sqlitePath('pref'), maxOverlayBytes: 255 })).toThrow()

      expect(() => verifierMod.Config({ databasePath: ws.sqlitePath('ver'), tickIntervalMs: -1 })).toThrow()
      expect(() => memLearn.Config({ enabled: true, workItemExperiences: 'yes' } as never)).toThrow()
    })

    test('T2-F14-05: AssistantDeliveryService mounts cleanly with attentionEnforce=false and attentionAttachOverCap=false', async () => {
      const ws = await workspaces.create('f14-del-mount-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantDeliveryService } = await loadAssistantDelivery()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      const del = await harness.mountService<{ ready?: Promise<void> }>(ctx, AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('del'),
        spoolPath: join(ws.stateDir, 'spool'),
        schedulerEnabled: false,
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'standard',
        attentionEnforce: false,
        attentionAttachOverCap: false,
      })
      expect(del).toBeDefined()
    })
  })
})
