import { Include } from '@deepseek-ai/cordis-plugin-include'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { expectNoSecretLeak, getExportFn, sha256Hex } from './helpers/assertions.ts'
import { runCommandProcess } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAdoptionCoordinator,
  loadAssistantActions,
  loadAssistantActionsBroker,
  loadAssistantAssociation,
  loadAssistantDelivery,
  loadAssistantDreaming,
  loadAssistantEvaluation,
  loadAssistantEvolution,
  loadAssistantGrowthDriver,
  loadAssistantIsolation,
  loadAssistantIsolationConfig,
  loadAssistantMemoryLearning,
  loadAssistantPolicy,
  loadAssistantRecovery,
  loadAssistantVerifier,
  loadAssistantWorkItems,
  loadNativeBehaviorArtifact,
  loadNativeBehaviorWorker,
  loadPackageModule,
  loadPersonalMemory,
  loadPluginBehaviorRunner,
  loadPluginControlPlane,
  loadPreferenceLearning,
  loadRepoAutonomyFixture,
  loadRepoAutonomyObserver,
  loadRepoLiveInput,
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

describe('Tier 3 Pairwise — F08–F14, F02 & F16: Evolution, Reload, Isolation, S4 & Multi-Target Broker', () => {
  test('T3-ER-01 (F12+F13): Broader plugin evolution (service kind) -> assistant-verifier -> inProcessReload live Cordis swap preserving siblings', async () => {
    const ws = await workspaces.create('t3-er01-')
    const sc = await loadSourceCreation()
    const runnerMod = await loadPluginBehaviorRunner()
    const delivery = await loadAssistantDelivery()
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { PluginControlPlaneService } = await loadPluginControlPlane()

    const validateFiles = getExportFn<(files: readonly { path: string; content: string }[]) => void>(sc, 'validateSourceCreationFiles')
    const extractKind = getExportFn<(files: readonly { path: string; content: string }[]) => string>(sc, 'extractCandidatePluginKindFromFiles')

    const v2SourceFiles = [
      {
        path: 'src/index.ts',
        content: `
          import { Service } from '@deepseek-ai/cordis'
          export class DemoService extends Service {
            constructor(ctx) { super(ctx, 'demoService') }
            health() { return { ready: true } }
            echo(input) { return { tag: input?.tag ?? 'v2:evolved' } }
          }
          export default DemoService
        `,
      },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: '@dsh-ray/demo-svc',
          version: '0.2.0',
          main: './lib/index.js',
          dsh: { pluginKind: 'service', bundle: { patch: './cordis.patch.yml' } },
        }),
      },
      {
        path: 'cordis.patch.yml',
        content: '- insert:\n  - id: dsh-ray-demo-svc\n    name: "@dsh-ray/demo-svc"\n    config: {}\n',
      },
    ]
    expect(() => validateFiles(v2SourceFiles)).not.toThrow()
    expect(extractKind(v2SourceFiles)).toBe('service')
    expect(runnerMod.isPluginKind('service')).toBe(true)

    const svcTgz = packPluginEntries({
      'package/package.json': JSON.stringify({ name: '@dsh-ray/demo-svc', version: '0.2.0', type: 'module', main: './lib/index.js' }),
      'package/cordis.patch.yml': '- insert:\n  - id: demo-svc\n    name: "@dsh-ray/demo-svc"\n',
      'package/lib/index.js': `
        import { Service } from '@deepseek-ai/cordis'
        class DemoService extends Service {
          constructor(ctx) { super(ctx, 'demoService') }
          health() { return { ready: true } }
          echo(input) { return { tag: 'v2:' + String(input?.who ?? 'evolved') } }
        }
        export default DemoService
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
        calls: [{ id: 'c1', toolName: 'service_method_probe', arguments: { service: 'demoService', method: 'echo', input: { who: 'evolved' } } }],
      },
      'service',
    )
    expect((inv.calls as Array<{ result: { value: unknown } }>)[0]?.result.value).toMatchObject({
      kind: 'service',
      service: 'demoService',
      method: 'echo',
      result: { tag: 'v2:evolved' },
    })

    // Live Cordis profile with sibling + v1 -> inProcessReload swap to v2
    const profileDir = join(ws.dshHome, 'profiles', 'web')
    const profileFile = join(profileDir, 'cordis.yml')
    const v1Dir = join(ws.root, 'bundles', 'demo-v1')
    const v2Dir = join(ws.root, 'bundles', 'demo-v2')
    const siblingDir = join(ws.root, 'bundles', 'sibling')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })

    const hookKey = `__dshT3Er01_${Math.random().toString(16).slice(2)}`
    const globalHooks = globalThis as Record<string, unknown>
    globalHooks[hookKey] = { siblingDisposed: false }

    try {
      await writeBundlePackage(siblingDir, {
        name: '@dsh-ray/sibling-stable',
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
        name: '@dsh-ray/demo-svc',
        version: '0.1.0',
        body: `
export const name = 'demo-svc'
export function apply(ctx) {
  ctx.provide('demoService', () => 'v1')
}
`,
      })
      await writeBundlePackage(v2Dir, {
        name: '@dsh-ray/demo-svc',
        version: '0.2.0',
        body: `
export const name = 'demo-svc'
export function apply(ctx) {
  ctx.provide('demoService', () => 'v2:evolved')
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
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      await harness.mountService(ctx, delivery.AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery'),
        spoolPath: join(ws.stateDir, 'spool'),
        schedulerEnabled: false,
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'standard',
      })
      const pcp = await harness.mountService<{ canInProcessReload: () => boolean }>(ctx, PluginControlPlaneService, 'pluginControlPlane', {
        catalogPath: join(ws.stateDir, 'catalog.json'),
        statePath: join(ws.stateDir, 'state.json'),
        trustPath: join(ws.stateDir, 'trust.json'),
      })
      expect(pcp.canInProcessReload()).toBe(true)

      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      await ctx.loader.create({
        id: 'include',
        name: 'cordis:include',
        config: { path: pathToFileURL(profileFile).href },
      } as never)
      await ctx.loader.await()

      const beforeSiblingFiber = ctx.loader.resolve('include:sibling').fiber
      expect((ctx.get('demoService' as never) as () => string)()).toBe('v1')

      const runtime = delivery.createInProcessReloadRuntime(ctx, {
        profilePath: profileDir,
        entryId: 'candidate',
        package: '@dsh-ray/demo-svc',
        stagingDir: join(ws.stateDir, 'staging'),
        hostGeneration: () => 1,
      })

      const v2Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: v2Dir })
      const v2PatchDigest = delivery.computeInProcessPatchDigest({ config: {} })
      const res = await runtime.activate({
        warrantDigest: sha256Hex('warrant-er01'),
        previousHostGeneration: 1,
        previousInProcessGeneration: 1,
        mode: 'artifact-replace',
        target: {
          package: '@dsh-ray/demo-svc',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: v2PatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: {} },
        },
      })

      expect(res.probe.reloaded).toBe(true)
      expect(res.probe.failures).toBe(0)
      expect((ctx.get('demoService' as never) as () => string)()).toBe('v2:evolved')
      expect(ctx.loader.resolve('include:sibling').fiber).toBe(beforeSiblingFiber)
      expect((globalHooks[hookKey] as { siblingDisposed: boolean }).siblingDisposed).toBe(false)
    } finally {
      delete globalHooks[hookKey]
    }
  }, 15_000)

  test('T3-ER-02 (F12+F13+F14): R3 default-on autonomousRollback + requireAcceptance + PluginControlPlaneService/inProcessReload rolls back crashing evolved plugin', async () => {
    const ws = await workspaces.create('t3-er02-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const delivery = await loadAssistantDelivery()
    const { AssistantEvaluationService } = await loadAssistantEvaluation()
    const verifierMod = await loadAssistantVerifier()
    const { AssistantEvolutionService } = await loadAssistantEvolution()
    const pcpMod = await loadPluginControlPlane()
    const coord = await loadAdoptionCoordinator()

    const evoDefaults = AssistantEvolutionService.Config({ databasePath: ws.sqlitePath('evo') })
    const verifierDefaults = verifierMod.Config({ databasePath: ws.sqlitePath('verifier') })
    expect(evoDefaults.autonomousRollback).toBe(true)
    expect(verifierDefaults.requireAcceptance).toBe(true)

    const profileDir = join(ws.dshHome, 'profiles', 'web')
    const profileFile = join(profileDir, 'cordis.yml')
    const v1Dir = join(ws.root, 'bundles', 'cand-v1')
    const v2CrashDir = join(ws.root, 'bundles', 'cand-v2-crash')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })

    await writeBundlePackage(v1Dir, {
      name: '@dsh-ray/cand-svc',
      version: '0.1.0',
      body: `
export const name = 'cand-svc'
export function apply(ctx) {
  ctx.provide('candService', () => 'v1-healthy')
}
`,
    })
    await writeBundlePackage(v2CrashDir, {
      name: '@dsh-ray/cand-svc',
      version: '0.1.84',
      body: `
export const name = 'cand-svc'
export function apply() {
  throw new Error('boom-during-evolved-apply')
}
`,
    })
    await writeFile(
      profileFile,
      ['- id: cand-svc', `  name: ${join(v1Dir, 'lib/index.js')}`, '  config: {}', ''].join('\n'),
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

    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
    await harness.mountService(ctx, AssistantEvaluationService, 'assistantEvaluation', {
      databasePath: ws.sqlitePath('eval'),
      projectionIntervalMs: 0,
    })
    const evo = await harness.mountService<{
      health: () => { autonomousRollbacks: number }
    }>(ctx, AssistantEvolutionService, 'assistantEvolution', evoDefaults)
    const verifier = await harness.mountService<{
      health: () => { evaluationConnected: boolean; requireAcceptance: boolean }
    }>(ctx, verifierMod.AssistantVerifierService, 'assistantVerifier', verifierDefaults)
    await harness.mountService(ctx, delivery.AssistantDeliveryService, 'assistantDelivery', {
      databasePath: ws.sqlitePath('delivery'),
      spoolPath: join(ws.stateDir, 'spool'),
      schedulerEnabled: false,
      defaultWorkspace: ws.workspace,
      defaultAgentPreset: 'standard',
      inProcessReload: { profilePath: profileFile, entryId: 'cand-svc', hostGeneration: 1 },
    })

    const catalogPath = join(ws.stateDir, 'catalog.json')
    const trustPath = join(ws.stateDir, 'trust.json')
    const ownerKeys = generateKeyPairSync('ed25519')
    await writeFile(catalogPath, JSON.stringify(pcpMod.exampleIntegrityPinnedCatalog), 'utf8')
    await writeFile(trustPath, JSON.stringify({
      schemaVersion: 1,
      installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f10',
      ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f11', path: ws.sqlitePath('cp-trust') },
      dsh: { binaryPath: join(ws.root, 'dsh'), expectedVersion: '0.1.84' },
      approvalKeys: [{ authority: 'owner', keyId: 'owner-1', publicKeyPem: ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }) }],
      hostAttestationKeys: [],
    }), 'utf8')

    const pcp = await harness.mountService<{
      canInProcessReload: () => boolean
      reloadInProcess: (input: Record<string, unknown>) => Promise<{ status: string }>
    }>(ctx, pcpMod.PluginControlPlaneService, 'pluginControlPlane', {
      catalogPath,
      statePath: join(ws.stateDir, 'pcp-state'),
      trustPath,
    })

    // Cross-service wiring checks: Delivery provides inProcessReload to PluginControlPlaneService; Evaluation connects to Verifier
    expect(pcp.canInProcessReload()).toBe(true)
    expect(ctx.get('inProcessReload' as never)).toBeDefined()
    expect(verifier.health().evaluationConnected).toBe(true)
    expect(verifier.health().requireAcceptance).toBe(true)
    expect(evo.health().autonomousRollbacks).toBe(0)

    const badDigest = await delivery.computeInProcessArtifactDigest({ sourceDir: v2CrashDir })
    const badPatchDigest = delivery.computeInProcessPatchDigest({ config: {} })
    const now = Date.now()

    // Drive real PluginControlPlaneService.reloadInProcess -> ctx.get('inProcessReload') -> crash -> automatic rollback
    const directReload = await pcp.reloadInProcess({
      now,
      snapshot: {
        planId: 'plan:er02-direct',
        planDigest: sha256Hex('plan-er02-direct'),
        status: 'awaiting-reload',
        activation: { id: 'activation:er02-direct', fence: 1 },
        hostGeneration: 1,
        inProcessGeneration: 1,
        running: { artifactDigest: await delivery.computeInProcessArtifactDigest({ sourceDir: v1Dir }), patchDigest: badPatchDigest },
        mode: 'artifact-replace',
        target: {
          package: '@dsh-ray/cand-svc',
          version: '0.1.84',
          artifactDigest: badDigest,
          patchDigest: badPatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2CrashDir, config: {} },
        },
      },
    })
    expect(directReload.status).toBe('rolled-back')
    expect((ctx.get('candService' as never) as () => string)()).toBe('v1-healthy')

    // Exercise real SQLite ControlPlaneStore + coordinateAdoptionHandoff delegating to pcp.reloadInProcess
    const cpDbPath = ws.sqlitePath('coord-cp')
    const cpStore = new pcpMod.ControlPlaneStore({ path: cpDbPath, now: () => now })
    try {
      const approvalAuthority = new pcpMod.Ed25519ApprovalAuthority(
        ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }),
        'owner',
        'owner-1',
      )
      const catalogCandidate = pcpMod.exampleIntegrityPinnedCatalog.entries[0]!
      const gap = cpStore.recordGap({
        idempotencyKey: 'gap-er02',
        capability: catalogCandidate.capabilities[0]!,
        context: 'er02-crash-rollback',
        expectedValue: 100,
        frequency: 10,
        estimatedCost: 50,
        risk: 0.2,
      })
      let plan = cpStore.createPlan({
        candidate: catalogCandidate,
        catalog: { digest: pcpMod.controlPlaneDigest(pcpMod.exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
        matchedCapabilities: [catalogCandidate.capabilities[0]!],
        profile: 'web',
        target: { dshHome: ws.dshHome, profile: 'web', profilePath: profileDir },
        installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f10',
        ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f11', path: cpDbPath },
        executor: { id: 'dsh', version: '0.1.84', path: join(ws.root, 'dsh'), sha256: sha256Hex('dsh-bin') },
        ttlMs: 120_000,
        gapId: gap.id,
        idempotencyKey: 'plan-er02-coord',
      }).result
      const appBody = {
        schemaVersion: 1 as const,
        approvalId: 'approval-er02',
        authority: 'owner',
        keyId: 'owner-1',
        planId: plan.id,
        planDigest: plan.digest,
        decision: 'approved' as const,
        principal: 'owner',
        decidedAt: now,
        expiresAt: now + 60_000,
      }
      plan = (await cpStore.approve({
        planId: plan.id,
        expectedRevision: plan.revision,
        receipt: { ...appBody, signature: sign(null, Buffer.from(pcpMod.approvalSigningPayload(appBody)), ownerKeys.privateKey).toString('base64') },
        resolveAuthority: () => approvalAuthority,
        idempotencyKey: 'approve-er02',
      })).result
      plan = await cpStore.claimActivation({
        planId: plan.id,
        expectedRevision: plan.revision,
        leaseMs: 30_000,
        resolveApprovalAuthority: () => approvalAuthority,
      })
      plan = cpStore.advanceActivation({
        planId: plan.id,
        expectedRevision: plan.revision,
        fence: plan.activation!.fence,
        from: 'staging',
        to: 'awaiting-reload',
      })

      const coordinate = getExportFn<(input: Record<string, unknown>) => Promise<{
        status: string
        activation?: { failureCode?: string }
      }>>(coord, 'coordinateAdoptionHandoff')

      const storeAdapter = {
        getPlan: (id: string) => cpStore.getPlan(id),
        assertAdoptionHandoff: () => {},
        getAdoptionHandoff: (id: string) => {
          const p = cpStore.getPlan(id)
          return { planId: p.id, planDigest: p.digest, coordinatorId: 'coord-er02', createdAt: now, expiresAt: now + 60_000 }
        },
        getLiveQualificationDeadline: () => undefined,
        requestActivationRollback: (input: { planId: string; expectedRevision: number; fence: number; failureCode: string }) =>
          cpStore.requestActivationRollback(input),
      }

      const coordRes = await coordinate({
        store: storeAdapter,
        trust: {},
        planId: plan.id,
        inProcessReload: {
          canHandle: (p: { id: string; status: string }) => p.id === plan.id && p.status === 'awaiting-reload',
          execute: async (p: { id: string; digest: string; revision: number; activation: { id: string; fence: number } }) => {
            const reloadOutcome = await pcp.reloadInProcess({
              now,
              snapshot: {
                planId: p.id,
                planDigest: p.digest,
                status: 'awaiting-reload',
                activation: { id: p.activation.id, fence: p.activation.fence },
                hostGeneration: 1,
                inProcessGeneration: 1,
                running: { artifactDigest: await delivery.computeInProcessArtifactDigest({ sourceDir: v1Dir }), patchDigest: badPatchDigest },
                mode: 'artifact-replace',
                target: {
                  package: '@dsh-ray/cand-svc',
                  version: '0.1.84',
                  artifactDigest: badDigest,
                  patchDigest: badPatchDigest,
                  changesProcessSubtree: false,
                  holdsUnprovenProcessAuthority: false,
                  artifact: { sourceDir: v2CrashDir, config: {} },
                },
              },
            })
            expect(reloadOutcome.status).toBe('rolled-back')
            const rolledPlan = cpStore.requestActivationRollback({
              planId: p.id,
              expectedRevision: p.revision,
              fence: p.activation.fence,
              failureCode: 'in-process-reload-rolled-back',
            })
            return { status: 'rolled-back', plan: rolledPlan, failureCode: 'in-process-reload-rolled-back' }
          },
        },
      })

      expect(coordRes.status).toBe('rollback-pending')
      expect(coordRes.activation?.failureCode).toBe('in-process-reload-rolled-back')
      const persistedPlan = cpStore.getPlan(plan.id)
      expect(persistedPlan.status).toBe('rollback-pending')
      expect(persistedPlan.activation?.failureCode).toBe('in-process-reload-rolled-back')
      expect((ctx.get('candService' as never) as () => string)()).toBe('v1-healthy')
    } finally {
      cpStore.close()
    }

    // Opted-out inProcessReload leaves PluginControlPlaneService unable to hot-reload
    const ctxOptOut = harness.createContext()
    await harness.mountService(ctxOptOut, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy-optout') })
    await harness.mountService(ctxOptOut, delivery.AssistantDeliveryService, 'assistantDelivery', {
      databasePath: ws.sqlitePath('delivery-optout'),
      spoolPath: join(ws.stateDir, 'spool-optout'),
      schedulerEnabled: false,
      defaultWorkspace: ws.workspace,
      defaultAgentPreset: 'standard',
      inProcessReload: { enabled: false },
    })
    const pcpOptOut = await harness.mountService<{
      canInProcessReload: () => boolean
      reloadInProcess: (input: Record<string, unknown>) => Promise<unknown>
    }>(ctxOptOut, pcpMod.PluginControlPlaneService, 'pluginControlPlane', {
      catalogPath,
      statePath: join(ws.stateDir, 'pcp-state-optout'),
      trustPath,
    })
    expect(pcpOptOut.canInProcessReload()).toBe(false)
    await expect(pcpOptOut.reloadInProcess({
      now,
      snapshot: {
        planId: 'plan:er02-optout',
        planDigest: sha256Hex('plan-er02-optout'),
        status: 'awaiting-reload',
        activation: { id: 'activation:er02-optout', fence: 1 },
        hostGeneration: 1,
        inProcessGeneration: 1,
        running: { artifactDigest: badDigest, patchDigest: badPatchDigest },
        target: {
          package: '@dsh-ray/cand-svc',
          version: '0.1.84',
          artifactDigest: badDigest,
          patchDigest: badPatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
        },
      },
    })).rejects.toThrow(/inProcessReload Host runtime is not registered/u)
  })

  test('T3-ER-03 (F13+F14): assistant-growth-driver R3 defaults <-> plugin-control-plane source validation & protected denylist', async () => {
    const { normalizeConfig } = await loadAssistantGrowthDriver()
    const sourcePort = await loadPackageModule('assistant-growth-driver/source-port')
    const sc = await loadSourceCreation()
    const sr = await loadSourceRevision()

    const cfg = normalizeConfig({}) as unknown as Record<string, unknown>
    expect(cfg.enabled).toBe(true)
    expect((cfg.workflowOwnerAnchored as Record<string, unknown>).enabled).toBe(true)
    expect((cfg.pluginSourceProposals as Record<string, unknown>).enabled).toBe(true)
    expect((cfg.pluginSourceProposals as Record<string, unknown>).allowCreation).toBe(true)
    expect((cfg.pluginSourceProposals as Record<string, unknown>).allowRevision).toBe(true)
    expect((cfg.associationCandidates as Record<string, unknown>).enabled).toBe(true)
    expect((cfg.dreamingIdeas as Record<string, unknown>).enabled).toBe(true)
    expect((cfg.usageLearning as Record<string, unknown>).workItemFailures).toBe(true)

    const assertConsistent = getExportFn<() => void>(sourcePort, 'assertGrowthProtectedSetsConsistent')
    expect(() => assertConsistent()).not.toThrow()
    const denylist = sourcePort.GROWTH_PROTECTED_PLUGIN_DENYLIST as ReadonlySet<string> | readonly string[]
    const protectedList = Array.isArray(denylist) ? denylist : [...(denylist as Iterable<string>)]
    expect(protectedList.some(item => item.includes('assistant-policy'))).toBe(true)

    const validateFiles = getExportFn<(files: readonly { path: string; content: string }[]) => void>(sc, 'validateSourceCreationFiles')
    const extractKind = getExportFn<(files: readonly { path: string; content: string }[]) => string>(sc, 'extractCandidatePluginKindFromFiles')
    const validatePatch = getExportFn<(name: string, base: string, cand: string) => void>(sc, 'validateCandidateCordisPatch')

    const channelFiles = [
      { path: 'src/index.ts', content: 'export const kind = "channel"; export function apply() {}' },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: '@dsh-ray/ch-er03',
          version: '0.1.0',
          main: './lib/index.js',
          dsh: { pluginKind: 'channel', bundle: { patch: './cordis.patch.yml' } },
        }),
      },
      {
        path: 'cordis.patch.yml',
        content: '- insert:\n  - id: dsh-ray-ch-er03\n    name: "@dsh-ray/ch-er03"\n    config: {}\n',
      },
    ]
    const uiFiles = [
      { path: 'src/index.ts', content: 'export const kind = "ui"; export function apply() {}' },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: '@dsh-ray/ui-er03',
          version: '0.1.0',
          main: './lib/index.js',
          dsh: { pluginKind: 'ui', bundle: { patch: './cordis.patch.yml' } },
        }),
      },
      {
        path: 'cordis.patch.yml',
        content: '- insert:\n  - id: dsh-ray-ui-er03\n    name: "@dsh-ray/ui-er03"\n    config: {}\n',
      },
    ]
    expect(() => validateFiles(channelFiles)).not.toThrow()
    expect(extractKind(channelFiles)).toBe('channel')
    expect(() => validateFiles(uiFiles)).not.toThrow()
    expect(extractKind(uiFiles)).toBe('ui')
    expect(() => validatePatch('ui-er03', uiFiles[2]!.content, uiFiles[2]!.content)).not.toThrow()

    // Protected plugin target is rejected by source-revision binding check
    const validateBinding = getExportFn<(input: Record<string, unknown>) => unknown>(sr, 'validateSourceRevisionBinding')
    expect(() => validateBinding({
      pluginName: '@dsh-ray/assistant-policy',
      baseCommit: 'a'.repeat(40),
      parentSourceDigest: sha256Hex('p'),
    })).toThrow()
  })

  test('T3-ER-04 (F08+F09): assistant-association S4 Web Learning executes inside assistant-isolation OS sandbox with secret stripping & SSRF block', async () => {
    const ws = await workspaces.create('t3-er04-')
    const assoc = await loadAssistantAssociation()
    const isoMod = await loadAssistantIsolation()
    const isoCfgMod = await loadAssistantIsolationConfig()

    const { hashLinuxRuntimeTree } = (await loadPackageModule('assistant-isolation/linux-runtime')) as {
      hashLinuxRuntimeTree: (dir: string) => Promise<string>
    }
    const { copyFile, chmod, stat } = await import('node:fs/promises')
    const runtimeRoot = join(ws.root, 'runtime')
    await mkdir(join(runtimeRoot, 'bin'), { recursive: true, mode: 0o755 })
    await copyFile(process.execPath, join(runtimeRoot, 'bin/node'))
    await chmod(join(runtimeRoot, 'bin/node'), 0o555)
    await mkdir(join(runtimeRoot, 'pnpm/bin'), { recursive: true, mode: 0o755 })
    await writeFile(join(runtimeRoot, 'pnpm/bin/pnpm.mjs'), 'console.log("11.7.0")\n', { mode: 0o444 })
    await mkdir(join(runtimeRoot, 'pnpm-native'), { recursive: true, mode: 0o755 })
    await writeFile(join(runtimeRoot, 'pnpm-native/pnpm'), '#!/bin/sh\nprintf "11.7.0\\n"\n', { mode: 0o555 })
    await copyFile(process.execPath, join(runtimeRoot, 'pnpm-native/node'))
    await chmod(join(runtimeRoot, 'pnpm-native/node'), 0o555)
    await writeFile(join(runtimeRoot, 'pnpm-native/package.json'), '{"name":"@pnpm/exe","version":"11.7.0"}', { mode: 0o444 })
    await writeFile(join(runtimeRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", { mode: 0o444 })
    for (const [name, ver] of Object.entries({
      typescript: '6.0.3',
      '@deepseek-ai/cordis': '4.0.5',
      '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
      '@deepseek-ai/dsh-system-prompt': '0.2.1-rc.2',
    })) {
      const modDir = join(runtimeRoot, 'node_modules', name)
      await mkdir(modDir, { recursive: true, mode: 0o755 })
      await writeFile(join(modDir, 'package.json'), JSON.stringify({ version: ver }), { mode: 0o444 })
    }
    await mkdir(join(runtimeRoot, 'store'), { recursive: true, mode: 0o755 })
    await mkdir(join(runtimeRoot, 'cache'), { recursive: true, mode: 0o755 })
    const info = await stat(runtimeRoot)
    const uid = process.getuid?.() ?? 1000
    const validatedIso = isoCfgMod.validateConfig({
      backend: 'auto',
      stateRoot: join(ws.stateDir, 'isolation'),
      linux: {
        runtime: {
          schemaVersion: 1,
          backend: 'linux-native',
          platform: `linux-${process.arch}`,
          sourceCommit: '1'.repeat(40),
          lockSha256: createHash('sha256').update(await readFile(join(runtimeRoot, 'pnpm-lock.yaml'))).digest('hex'),
          root: { path: runtimeRoot, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(runtimeRoot) },
          nodePath: join(runtimeRoot, 'bin/node'),
          nodeSha256: createHash('sha256').update(await readFile(join(runtimeRoot, 'bin/node'))).digest('hex'),
          pnpmPath: join(runtimeRoot, 'pnpm/bin/pnpm.mjs'),
          nativePnpmRoot: join(runtimeRoot, 'pnpm-native'),
          nativePnpmPath: join(runtimeRoot, 'pnpm-native/pnpm'),
          modulesPath: join(runtimeRoot, 'node_modules'),
          storePath: join(runtimeRoot, 'store'),
          cachePath: join(runtimeRoot, 'cache'),
          versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' },
        },
        cgroupRoots: {
          mode: 'v1',
          cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
          memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`,
          pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
          freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}`,
        },
      },
    } as never)
    expect(validatedIso.backend).toBe(process.platform === 'linux' ? 'linux-native' : validatedIso.backend)

    // Verify OS sandbox runner export (S4 default-on flag asserted after sandboxed execution)
    const assocCfg = assoc.normalizeAssociationConfig({ databasePath: ws.sqlitePath('assoc') })
    const createSandboxed = getExportFn<(opts?: Record<string, unknown>) => {
      run: (input: unknown) => Promise<{ pagesFetched: number; pages: readonly { title?: string }[] }>
    }>(assoc, 'createSandboxedWebLearningRunner')

    let requestsReceived = 0
    const server = createServer((_req, res) => {
      requestsReceived += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><title>Cordis Sandbox Note</title><body>Isolated web note.</body></html>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    const loopbackUrl = `http://127.0.0.1:${addr.port}/note`

    try {
      const sourceEnv = {
        PATH: '/usr/bin',
        DEEPSEEK_API_KEY: 'sk-er04-secret',
        FEISHU_APP_SECRET: 'feishu-er04-secret',
        GITHUB_TOKEN: 'ghp-er04-secret',
      }
      const sanitizedEnv = assoc.sanitizeWebLearningEnv(sourceEnv)
      expectNoSecretLeak(JSON.stringify(sanitizedEnv), ['sk-er04-secret', 'feishu-er04-secret', 'ghp-er04-secret'])

      const inProc = assoc.createInProcessWebLearningRunner({
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetcher: async (_url, init) => fetch(loopbackUrl, { signal: init.signal }),
      })

      const runIsolatedSubprocess = getExportFn<(req: Record<string, unknown>) => Promise<{
        backend: string
        sandboxed: boolean
        status: string
        stdout: string
      }>>(
        isoMod,
        'runIsolatedSubprocess',
      )

      let isolationInvoked = false
      const sandboxedRunner = createSandboxed({
        tempBaseDir: ws.stateDir,
        sourceEnv,
        isolatedRunner: async (req: {
          args: readonly string[]
          env: Readonly<Record<string, string | undefined>>
          network: string
          writablePaths?: readonly string[]
          stdin: string
        }) => {
          isolationInvoked = true
          expectNoSecretLeak(JSON.stringify(req.env), ['sk-er04-secret', 'feishu-er04-secret', 'ghp-er04-secret'])
          expect(req.network).toBe('outbound-https')
          expect(req.args.some(a => a.endsWith('web-learning-worker.ts'))).toBe(true)
          expect(Array.isArray(req.writablePaths) && req.writablePaths.length === 1).toBe(true)

          const probeIso = await runIsolatedSubprocess({
            command: process.execPath,
            args: ['-e', 'process.stdout.write("isolated-s4-ok")'],
            cwd: ws.workspace,
            env: { PATH: '/usr/bin:/bin', LANG: 'C' },
            stdin: '',
            timeoutMs: 5_000,
            network: 'none',
          })
          expect(probeIso.sandboxed).toBe(true)
          expect(probeIso.status).toBe('succeeded')
          expect(probeIso.stdout).toBe('isolated-s4-ok')

          const parsedInput = JSON.parse(req.stdin) as Record<string, unknown>
          const workerOutput = await inProc.run(parsedInput as never)
          return {
            status: 'succeeded',
            sandboxed: true,
            backend: probeIso.backend,
            exitCode: 0,
            processSignal: null,
            stdout: JSON.stringify(workerOutput),
            stderr: '',
            truncated: false,
            durationMs: 1,
          }
        },
      })

      const allowedOut = await sandboxedRunner.run({
        runId: 'run-er04-ok',
        allowedDomains: ['docs.example.test'],
        targets: [{ url: 'https://docs.example.test/note', interestKey: 'cordis' }],
        budget: { maxRequests: 2, maxPages: 2, maxBytesPerRequest: 8_192, maxTotalBytes: 16_384, maxDurationMs: 5_000, requestTimeoutMs: 2_000 },
        toolSurface: ['web_fetch_readonly'],
      })
      expect(isolationInvoked).toBe(true)
      expect(allowedOut.pagesFetched).toBe(1)
      expect(allowedOut.pages[0]?.title).toBe('Cordis Sandbox Note')
      expect(requestsReceived).toBe(1)

      const blockedOut = await inProc.run({
        runId: 'run-er04-ssrf',
        allowedDomains: ['docs.example.test'],
        targets: [{ url: loopbackUrl, interestKey: 'cordis' }],
        budget: { maxRequests: 2, maxPages: 2, maxBytesPerRequest: 8_192, maxTotalBytes: 16_384, maxDurationMs: 5_000, requestTimeoutMs: 2_000 },
      })
      expect(blockedOut.pagesFetched).toBe(0)
      expect(requestsReceived).toBe(1)
      expect(assocCfg.webLearning.enabled).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('T3-ER-05 (F09+F14): assistant-association S4 low-trust web provenance -> S3 intakeSignal -> WorkItems & growth-driver association intake', async () => {
    const ws = await workspaces.create('t3-er05-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const assoc = await loadAssistantAssociation()
    const wiMod = await loadAssistantWorkItems()
    const assocIntakeMod = await loadPackageModule('assistant-growth-driver/association-intake')

    const ctx = harness.createContext()
    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy'),
      rules: [
        {
          id: 'allow-web-learn',
          effect: 'allow',
          subject: { kind: 'background', id: 'assistant-association:web-learning', workspace: ws.workspace, principal: 'web/a/t/u' },
          actions: ['web.learn'],
          resource: { kind: 'network', id: 'assistant-association:web-learning' },
          context: { initiators: ['background'] },
        },
        {
          id: 'allow-dream',
          effect: 'allow',
          subject: { kind: 'background', id: 'assistant-association:dreaming', workspace: ws.workspace, principal: 'web/a/t/u' },
          actions: ['dream.build'],
          resource: { kind: 'evolution', id: 'assistant-association:dreaming' },
          context: { initiators: ['background'] },
        },
        {
          id: 'allow-intake-signal',
          effect: 'allow',
          subject: { kind: 'background', id: 'assistant-association', workspace: ws.workspace, principal: 'web/a/t/u' },
          actions: ['intake-observe'],
          resource: { kind: 'automation', id: 'assistant-association:intake-signal' },
          context: { initiators: ['background'] },
        },
      ],
    })
    harness.provideMockService(ctx, 'assistantDelivery', {
      validateOwnerRoute: () => ({
        receiptVersion: 2,
        authorityId: 'route-1',
        authorityHash: sha256Hex('route-1'),
        principalId: 'web/a/t/u',
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: ws.workspace,
        agentPreset: 'primary',
        bindingVersion: 1,
        generation: 1,
      }),
    })

    const wiDb = ws.sqlitePath('wi')
    const wi = await harness.mountService<{
      inspectIntakeQueue: () => { intakeCounts: { stored: number } }
    }>(ctx, wiMod.AssistantWorkItemsService, 'assistantWorkItems', {
      enabled: true,
      mode: 'observe',
      databasePath: wiDb,
      workRoot: ws.workspace,
      intakeLedger: { enabled: true },
    })

    const svc = await harness.mountService<{
      store: { upsertBatch: (batch: unknown) => unknown }
      runWebLearningNow: (scope: Record<string, unknown>, opts: Record<string, unknown>) => Promise<{ ran: boolean; nodesWritten: number }>
      runDreamingNow: (scope: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ ran: boolean }>
      emitIntakeSignalNow: (input: Record<string, unknown>) => { emitted: boolean }
      listWebLearningFetches: (ownerScopeKey: string) => readonly Record<string, unknown>[]
      listIntakeSignals: (ownerScopeKey: string) => readonly Record<string, unknown>[]
    }>(ctx, assoc.AssistantAssociationService, 'assistantAssociation', {
      databasePath: ws.sqlitePath('assoc'),
      enabled: true,
      allowLowTrust: true,
      dreaming: { enabled: true, intervalMs: 1_000, idleMinMs: 0, maxPairsPerRun: 8 },
      intakeSignal: { enabled: true, minScore: 0.5 },
      webLearning: { enabled: true, allowedDomains: ['docs.example.test'], seedUrls: ['https://docs.example.test/q={query}'], idleMinMs: 0 },
    })

    const principalDigest = assoc.computePrincipalDigest('web/a/t/u')
    const ownerScopeKey = assoc.computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest,
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: ws.workspace,
      agentPreset: 'primary',
    })
    const scope = {
      mode: 'delivery' as const,
      ownerScopeKey,
      principalId: 'web/a/t/u',
      principalDigest,
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: ws.workspace,
      agentPreset: 'primary',
      authorityId: 'route-1',
    }
    const nowMs = 1_700_000_000_000
    svc.store.upsertBatch({
      nodes: [{
        id: 'a:g-er05',
        kind: 'goal',
        sourcePlugin: 'assistant-goals',
        sourceRef: 'goal:er05',
        sourceVersion: 1,
        ownerScopeKey,
        ownerMode: 'delivery',
        principalDigest,
        principalRecordId: 'owner-1',
        principalVersion: 1,
        scopeMode: 'workspace',
        workspace: ws.workspace,
        agentPreset: 'primary',
        trust: 'trusted',
        sensitivity: 'private',
        title: 'CordisLifecycle',
        body: 'Verify CordisLifecycle disposal ordering.',
        entities: ['CordisLifecycle'],
        tokens: ['cordis', 'lifecycle', 'disposal'],
        status: 'active',
        createdAt: nowMs - 3_600_000,
        updatedAt: nowMs - 3_600_000,
      }],
      edges: [],
      derivedRefs: [],
    })

    const webRes = await svc.runWebLearningNow(scope, {
      nowMs,
      ignoreIdle: true,
      runner: {
        run: async () => ({
          runId: 'run-er05-web',
          status: 'completed',
          reason: 'ok',
          startedAt: nowMs - 5,
          finishedAt: nowMs,
          requestsUsed: 1,
          pagesFetched: 1,
          bytesFetched: 128,
          pages: [{
            sourceUrl: 'https://docs.example.test/cordis',
            finalUrl: 'https://docs.example.test/cordis',
            fetchedAt: nowMs,
            title: 'Cordis Lifecycle',
            text: 'CordisLifecycle effects dispose deterministically.',
            contentType: 'text/html',
            contentDigest: sha256Hex('cordis-er05'),
            bytesFetched: 128,
            interestKey: 'CordisLifecycle',
            originNodeIds: ['a:g-er05'],
            links: [],
          }],
          attempts: [{
            url: 'https://docs.example.test/cordis',
            finalUrl: 'https://docs.example.test/cordis',
            interestKey: 'CordisLifecycle',
            ok: true,
            status: 200,
            bytesFetched: 128,
            requestsUsed: 1,
            fetchedAt: nowMs,
          }],
          environmentProof: { pid: process.pid, cwd: ws.workspace, envKeys: ['PATH'] },
        }),
      },
    })
    expect(webRes.ran).toBe(true)
    expect(svc.listWebLearningFetches(ownerScopeKey)[0]?.canonicalUrl).toBe('https://docs.example.test/cordis')

    const dreamRes = await svc.runDreamingNow(scope, { nowMs, lastActivityAt: nowMs - 3_600_000, hasRunningAgent: false })
    expect(dreamRes.ran).toBe(true)

    const sigRes = svc.emitIntakeSignalNow({
      scope,
      goalNode: { id: 'a:g-er05', kind: 'goal', title: 'CordisLifecycle', ownerScopeKey, sensitivity: 'private', status: 'active' },
      targetNode: { id: 'm:er05', kind: 'memory', title: 'Cordis Lifecycle note', ownerScopeKey, sensitivity: 'private', status: 'active' },
      score: 0.9,
      reason: 'web-provenance-match',
      inHoldout: false,
      nowMs,
    })
    expect(sigRes.emitted).toBe(true)
    expect(svc.listIntakeSignals(ownerScopeKey).length).toBeGreaterThanOrEqual(1)
    expect(wi.inspectIntakeQueue().intakeCounts.stored).toBeGreaterThanOrEqual(1)
    const wiCheckDb = new DatabaseSync(wiDb, { readOnly: true })
    try {
      const row = wiCheckDb.prepare('SELECT source FROM work_item_intake WHERE source = ?').get('assistant-association') as { source: string } | undefined
      expect(row?.source).toBe('assistant-association')
    } finally {
      wiCheckDb.close()
    }

    const readCandidates = getExportFn<(
      ctx: unknown,
      authority: { scope: Record<string, unknown>; assertCurrent: () => void },
      maxCandidates: number,
    ) => { candidates: readonly unknown[]; summary: { enabled: boolean } }>(assocIntakeMod, 'readAssociationCandidates')
    const intakeOut = readCandidates(
      ctx,
      {
        scope: { principalId: 'web/a/t/u', principalRecordId: 'owner-1', principalVersion: 1, workspace: ws.workspace, preset: 'primary' },
        assertCurrent: () => {},
      },
      5,
    )
    expect(intakeOut.summary.enabled).toBe(true)
    expect(Array.isArray(intakeOut.candidates)).toBe(true)
  })

  test('T3-ER-06 (F02+F10): WP08 PolicyRule constraints enforced by AssistantActionsService across multi-target Broker (http/lark/calendar/shell)', async () => {
    const ws = await workspaces.create('t3-er06-')
    const { AssistantActionsService } = await loadAssistantActions()
    const brokerMod = await loadAssistantActionsBroker()

    let requestsReceived = 0
    const server = createServer((_req, res) => {
      requestsReceived += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const now = Date.now()
      const expectedDigest = sha256Hex('wp08-commit-v1')
      const owner = {
        principalDigest: sha256Hex('owner-er06'),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: ws.workspace,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }
      const createProj = getExportFn<(grant: Record<string, unknown>) => Record<string, unknown>>(brokerMod, 'createActionGrantProjection')
      const httpProjection = createProj({
        protocol: brokerMod.ACTION_GRANT_PROTOCOL,
        id: 'http-wp08-1',
        revision: 1,
        domain: 'http',
        clientKeyId: 'host-1',
        owner,
        sessionId: 'sess-er06',
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['http'],
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [port],
          allowedMethods: ['GET'],
          allowedPathPrefixes: ['/v1/'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 4_096,
        },
        credentialId: 'none',
        expiresAt: now + 60_000,
        maxActions: 5,
        maxTotalBytes: 1_048_576,
        maxCostUnits: 5,
        allowedOperations: ['http.request'],
        client: { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 },
        source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
        policyEpoch: 1,
        emergencyEpoch: 0,
        lease: { leaseId: 'lease-er06', expiresAtMs: now + 60_000, maxUses: 1 },
        destinations: [`http://127.0.0.1:${port}/v1/ok`],
        maxSensitivity: 'internal',
        monetaryCostCapMicros: 10_000,
        commitDigest: expectedDigest,
      })

      const agent = { id: 'agent-er06', session: { id: 'sess-er06', header: { cwd: ws.workspace, agentPreset: 'primary' } } }
      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'tools', { register: () => () => {} })
      harness.provideMockService(ctx, 'agents', { get: (id: string) => (id === agent.id ? agent : undefined) })
      harness.provideMockService(ctx, 'assistantDelivery', {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-er06',
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
          sessionId: 'sess-er06',
          scope: { workspace: ws.workspace, preset: 'primary' },
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
        }),
      })
      harness.provideMockService(ctx, 'assistantPolicy', {
        evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
        authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      })

      const svc = await harness.mountService<{
        executeAction: (agent: unknown, input: Record<string, unknown>, signal: AbortSignal) => Promise<{ status: string }>
      }>(ctx, AssistantActionsService, 'assistantActions', {
        stateRoot: join(ws.stateDir, 'actions'),
        actionGrants: [httpProjection as never],
      })

      const baseInput = {
        grantId: 'http-wp08-1',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/ok' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/ok` },
        estimatedCostMicros: 5_000,
        commitDigest: expectedDigest,
      }

      // Violating calls BEFORE consuming the 1 lease use must reject fail-closed without hitting loopback server
      await expect(svc.executeAction(agent, { ...baseInput, idempotencyKey: 'bad-cost', estimatedCostMicros: 25_000 }, new AbortController().signal))
        .rejects.toThrow(/WP08 policy rejected \(cost-cap-exceeded\)/u)
      await expect(svc.executeAction(agent, {
        ...baseInput,
        idempotencyKey: 'bad-dest',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/other' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/other` },
      }, new AbortController().signal)).rejects.toThrow(/WP08 policy rejected \(destination-mismatch\)/u)
      await expect(svc.executeAction(agent, { ...baseInput, idempotencyKey: 'bad-digest', commitDigest: sha256Hex('wrong') }, new AbortController().signal))
        .rejects.toThrow(/WP08 policy rejected \(commit-digest-mismatch\)/u)
      expect(requestsReceived).toBe(0)

      // Compliant call succeeds once and reaches server
      const okRes = await svc.executeAction(agent, { ...baseInput, idempotencyKey: 'ok-1' }, new AbortController().signal)
      expect(okRes.status).toBe('succeeded')
      expect(requestsReceived).toBe(1)

      // Second compliant call is rejected because lease maxUses=1 is now exhausted
      await expect(svc.executeAction(agent, { ...baseInput, idempotencyKey: 'ok-2' }, new AbortController().signal))
        .rejects.toThrow(/WP08 policy rejected \(lease-exhausted\)/u)
      expect(requestsReceived).toBe(1)

      // Also validate lark, calendar, and shell broker action envelopes
      const validateReq = getExportFn<(req: unknown) => { kind: string }>(brokerMod, 'validateBrokerActionRequest')
      expect(validateReq({ kind: 'lark', operation: 'send-message', chatId: 'oc_1', text: 'hi', grantId: 'g-l', idempotencyKey: 'k-l' }).kind).toBe('lark')
      expect(validateReq({ kind: 'calendar', operation: 'list-events', calendarId: 'cal-1', startTime: 1000, endTime: 2000, grantId: 'g-c', idempotencyKey: 'k-c' }).kind).toBe('calendar')
      expect(validateReq({ kind: 'shell', operation: 'exec', command: ['/bin/echo', 'ok'], cwd: ws.workspace, grantId: 'g-s', idempotencyKey: 'k-s' }).kind).toBe('shell')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('T3-ER-07 (F10+F16): AssistantActionsService multi-target Broker forward action <-> assistant-recovery CompensationRegistry idempotent undo', async () => {
    const ws = await workspaces.create('t3-er07-')
    const { AssistantActionsService } = await loadAssistantActions()
    const brokerMod = await loadAssistantActionsBroker()
    const recMod = await loadAssistantRecovery()

    let postCalls = 0
    let deleteCalls = 0
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/items') {
        postCalls += 1
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'item-1' }))
        return
      }
      if (req.method === 'DELETE' && req.url === '/v1/items/item-1') {
        deleteCalls += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ deleted: true }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const now = Date.now()
      const owner = {
        principalDigest: sha256Hex('owner-er07'),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: ws.workspace,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }
      const createProj = getExportFn<(grant: Record<string, unknown>) => Record<string, unknown>>(brokerMod, 'createActionGrantProjection')
      const httpProjection = createProj({
        protocol: brokerMod.ACTION_GRANT_PROTOCOL,
        id: 'http-er07',
        revision: 1,
        domain: 'http',
        clientKeyId: 'host-1',
        owner,
        sessionId: 'sess-er07',
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['http'],
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [port],
          allowedMethods: ['POST'],
          allowedPathPrefixes: ['/v1/'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 4_096,
        },
        credentialId: 'none',
        expiresAt: now + 60_000,
        maxActions: 5,
        maxTotalBytes: 1_048_576,
        maxCostUnits: 5,
        allowedOperations: ['http.request'],
        client: { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 },
        source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
        policyEpoch: 1,
        emergencyEpoch: 0,
      })

      const agent = { id: 'agent-er07', session: { id: 'sess-er07', header: { cwd: ws.workspace, agentPreset: 'primary' } } }
      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'tools', { register: () => () => {} })
      harness.provideMockService(ctx, 'agents', { get: (id: string) => (id === agent.id ? agent : undefined) })
      harness.provideMockService(ctx, 'assistantDelivery', {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-er07',
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
          sessionId: 'sess-er07',
          scope: { workspace: ws.workspace, preset: 'primary' },
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
        }),
      })
      harness.provideMockService(ctx, 'assistantPolicy', {
        evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
        authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      })

      const actions = await harness.mountService<{
        executeAction: (agent: unknown, input: Record<string, unknown>, signal: AbortSignal) => Promise<{ status: string; actionId?: string }>
      }>(ctx, AssistantActionsService, 'assistantActions', {
        stateRoot: join(ws.stateDir, 'actions'),
        actionGrants: [httpProjection as never],
      })
      const comp = await harness.mountService<{
        registerCompensator: (h: {
          kind: string
          category: string
          compensate: (input: { record: { target: { externalRef: string } } }) => Promise<{ status: string; resultCode: string }>
        }) => () => void
        executeCompensation: (rec: Record<string, unknown>) => Promise<{
          id: string
          status: string
          replayed: boolean
          preimageDigest?: string
        }>
        listCompensationAudit: (id: string) => readonly unknown[]
      }>(ctx, recMod.AssistantCompensationService, 'assistantCompensation', {
        databasePath: ws.sqlitePath('comp'),
      })

      comp.registerCompensator({
        kind: 'http.delete-resource',
        category: 'delete',
        compensate: async ({ record }) => {
          const resp = await fetch(record.target.externalRef, { method: 'DELETE' })
          return { status: resp.ok ? 'succeeded' : 'failed', resultCode: `http-${resp.status}` }
        },
      })

      const fwd = await actions.executeAction(agent, {
        grantId: 'http-er07',
        idempotencyKey: 'fwd-post-1',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/items' },
        payload: { method: 'POST', url: `http://127.0.0.1:${port}/v1/items`, body: '{"name":"er07"}' },
      }, new AbortController().signal)
      expect(fwd.status).toBe('succeeded')
      expect(postCalls).toBe(1)

      const compInput = {
        forwardActionId: fwd.actionId ?? 'fwd-post-1',
        idempotencyKey: 'comp-http-er07-1',
        kind: 'http.delete-resource',
        target: { externalRef: `http://127.0.0.1:${port}/v1/items/item-1` },
        preimage: { status: 'created' },
      }
      const undo1 = await comp.executeCompensation(compInput)
      expect(undo1.status).toBe('succeeded')
      expect(undo1.preimageDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(deleteCalls).toBe(1)
      expect(comp.listCompensationAudit(undo1.id).length).toBeGreaterThanOrEqual(1)

      const undo2 = await comp.executeCompensation(compInput)
      expect(undo2.status).toBe('succeeded')
      expect(undo2.replayed).toBe(true)
      expect(deleteCalls).toBe(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('T3-ER-08 (F08+F10+F11): WP18 standalone sandbox repo (summarize.mjs) <-> assistant-isolation verification <-> Broker GitHub commit/PR/readback', async () => {
    const ws = await workspaces.create('t3-er08-')
    const isoMod = await loadAssistantIsolation()
    const { AssistantActionsService } = await loadAssistantActions()
    const fixtureMod = (await loadRepoAutonomyFixture()) as {
      apply: (ctx: unknown) => void
      prepareRepositoryFixture: (home: string, patchPath: string, env: Record<string, string>) => Promise<Record<string, unknown>>
      repositoryFixtureSnapshot: () => { ready: boolean; pullRequest: { number: number } | null; checks: readonly { conclusion: string | null }[] }
    }
    const { loadLiveRepositoryInput } = (await loadRepoLiveInput()) as { loadLiveRepositoryInput: unknown }
    expect(loadLiveRepositoryInput).toBeTypeOf('function')

    const scriptPath = join(ws.workspace, 'summarize.mjs')
    const scriptContent = [
      "let raw = ''",
      "process.stdin.on('data', chunk => { raw += chunk })",
      "process.stdin.on('end', () => {",
      "  const items = JSON.parse(raw || '[]')",
      '  const sums = {}',
      '  for (const item of items) {',
      "    if (item.status === 'cancelled') continue",
      '    sums[item.currency] = (sums[item.currency] ?? 0) + item.amountCents',
      '  }',
      '  console.log(JSON.stringify(Object.fromEntries(Object.keys(sums).sort().map(k => [k, sums[k]]))))',
      '})',
    ].join('\n')
    await writeFile(scriptPath, scriptContent, 'utf8')

    const runIsolatedSubprocess = getExportFn<(req: Record<string, unknown>) => Promise<{
      sandboxed: boolean
      status: string
      exitCode: number | null
      stdout: string
    }>>(isoMod, 'runIsolatedSubprocess')

    const pos = await runIsolatedSubprocess({
      command: process.execPath,
      args: [scriptPath],
      cwd: ws.workspace,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdin: '[{"currency":"USD","amountCents":100},{"currency":"USD","amountCents":50,"status":"cancelled"},{"currency":"EUR","amountCents":25}]\n',
      timeoutMs: 5_000,
      network: 'none',
    })
    expect(pos.sandboxed).toBe(true)
    expect(pos.status).toBe('succeeded')
    expect(pos.stdout.trim()).toBe('{"EUR":25,"USD":100}')

    const patchPath = join(ws.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(dirname(patchPath), { recursive: true, mode: 0o700 })
    await writeFile(patchPath, `- id: dsh-ray-assistant-isolation\n  name: "@dsh-ray/assistant-isolation"\n  config:\n    grants:\n      - id: repo\n        expiresAt: ${Date.now() + 600_000}\n`, { mode: 0o600 })

    const prevEventSource = process.env.DSH_REPO_EVENT_SOURCE
    const prevLog = process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
    const prevState = process.env.DSH_REPO_EVENT_STATE
    const prevMode = process.env.DSH_REPO_DELIVERY_MODE
    const fixtureEnv: Record<string, string> = {}
    process.env.DSH_REPO_EVENT_SOURCE = 'fixture'
    try {
      await fixtureMod.prepareRepositoryFixture(ws.dshHome, patchPath, fixtureEnv)
      process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = fixtureEnv.DSH_REPO_DELIVERY_FIXTURE_LOG
      process.env.DSH_REPO_EVENT_STATE = fixtureEnv.DSH_REPO_EVENT_STATE
      delete process.env.DSH_REPO_DELIVERY_MODE

      const ctx = harness.createContext()
      const actions = await harness.mountService<{
        commit: (input: Record<string, unknown>) => Promise<{ status: string; commitOid: string }>
        workflow: {
          pullRequest: (input: Record<string, unknown>) => Promise<{ pullRequestNumber: number }>
          inspect: (input: Record<string, unknown>) => Promise<{ observed: unknown }>
        }
      }>(ctx, AssistantActionsService, 'assistantActions', { stateRoot: join(ws.stateDir, 'actions') })
      await harness.mountPlugin(ctx, fixtureMod)

      const signal = new AbortController().signal
      const commitRes = await actions.commit({
        actionId: 'act-er08-commit',
        signal,
        request: { expectedHeadOid: '1'.repeat(40), files: [{ path: 'summarize.mjs', content: scriptContent }] },
      })
      expect(commitRes.status).toBe('succeeded')
      expect(commitRes.commitOid).toMatch(/^[a-f0-9]{40}$/u)

      const prRes = await actions.workflow.pullRequest({ actionId: 'act-er08-pr', signal, expectedHeadOid: commitRes.commitOid })
      expect(prRes.pullRequestNumber).toBe(17)

      await writeFile(fixtureEnv.DSH_REPO_EVENT_STATE!, '{"ready":true}', { mode: 0o600 })
      const inspected = await actions.workflow.inspect({ signal, kind: 'pull-request', grant: { repository: 'fixture/orders', branch: 'automation/fix' } })
      expect(inspected.observed).toMatchObject({ number: 17, state: 'open' })
      expect(fixtureMod.repositoryFixtureSnapshot().checks[0]?.conclusion).toBe('success')

      const logContent = await readFile(fixtureEnv.DSH_REPO_DELIVERY_FIXTURE_LOG!, 'utf8')
      expectNoSecretLeak(logContent, ['ghp_', 'sk-'])
      expect(logContent.trim().split('\n').map(l => (JSON.parse(l) as { kind: string }).kind)).toEqual(['commit', 'pr'])
    } finally {
      if (prevEventSource === undefined) delete process.env.DSH_REPO_EVENT_SOURCE
      else process.env.DSH_REPO_EVENT_SOURCE = prevEventSource
      if (prevLog === undefined) delete process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
      else process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = prevLog
      if (prevState === undefined) delete process.env.DSH_REPO_EVENT_STATE
      else process.env.DSH_REPO_EVENT_STATE = prevState
      if (prevMode === undefined) delete process.env.DSH_REPO_DELIVERY_MODE
      else process.env.DSH_REPO_DELIVERY_MODE = prevMode
    }
  })

  test('T3-ER-09 (F08+F11): WP18 repo-autonomy-observer model-gating <-> assistant-isolation cross-platform backend selection & execution', async () => {
    const ws = await workspaces.create('t3-er09-')
    const observerMod = (await loadRepoAutonomyObserver()) as { name: string; apply: (ctx: unknown) => void }
    const isoMod = await loadAssistantIsolation()
    const isoCfgMod = await loadAssistantIsolationConfig()
    const { AssistantPolicyService } = await loadAssistantPolicy()

    expect(isoCfgMod.validateConfig({
      backend: 'macos-seatbelt',
      stateRoot: join(ws.stateDir, 'mac'),
      macos: { readOnlyRoots: ['/opt/homebrew/Cellar/node/24.0.0'], sandboxExecPath: '/usr/bin/sandbox-exec' },
    } as never, { platform: 'darwin', uid: 501, allowHostPaths: true }).backend).toBe('macos-seatbelt')

    expect(isoCfgMod.validateConfig({
      backend: 'windows-job',
      stateRoot: 'C:\\Users\\alice\\.dsh\\win',
      windows: { powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', shell: 'powershell' },
    } as never, { platform: 'win32' }).backend).toBe('windows-job')

    const observerLog = join(ws.stateDir, 'observer.jsonl')
    const prevLog = process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
    const prevNoModel = process.env.DSH_REPO_AUTONOMY_NO_MODEL
    process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG = observerLog
    process.env.DSH_REPO_AUTONOMY_NO_MODEL = '1'

    try {
      const ctx = harness.createContext()
      const agent = {
        id: 'sess-er09',
        options: {},
        session: { id: 'sess-er09', header: { id: 'sess-er09', cwd: ws.workspace, agentPreset: 'primary' } },
        ctx: { tools: { restrict: () => () => {} } },
        status: 'idle',
      }
      harness.provideMockService(ctx, 'agents', {
        currentInitiator: () => undefined,
        list: () => [agent],
        get: (id: string) => (id === agent.id ? agent : undefined),
      })
      harness.provideMockService(ctx, 'assistantDelivery', {
        preferencePrincipalForAgent: () => ({
          principalId: 'web/a/t/u',
          principalLineage: { principalRecordId: 'rec-1', principalVersion: 1 },
          scope: { workspace: ws.workspace, preset: 'primary' },
        }),
      })
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        rules: [{
          id: 'allow-iso',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'isolation:grant-er09' },
          context: { initiators: ['foreground'] },
        }],
      })
      await harness.mountPlugin(ctx, observerMod)

      const streamGen = (ctx as unknown as {
        waterfall: (thisArg: unknown, event: string, options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
      }).waterfall(ctx, 'llm/stream', { system: '', messages: [], tools: [] }, async function* () {})
      await expect((async () => {
        for await (const _chunk of streamGen) {
          // unreachable
        }
      })()).rejects.toThrow(/model requests are forbidden/u)

      const AssistantIsolationService = getExportFn<new (
        ctx: unknown,
        cfg: unknown,
        opts?: Record<string, unknown>,
      ) => { ready: Promise<void>; run: (agent: unknown, req: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>> }>(
        isoMod,
        'AssistantIsolationService',
      )
      const isoSvc = new AssistantIsolationService(ctx, {
        backend: 'auto',
        stateRoot: join(ws.stateDir, 'iso'),
        limits: { maxDurationMs: 5_000, maxOutputBytes: 4_096 },
        grants: [{
          id: 'grant-er09',
          revision: 1,
          principalDigest: isoMod.isolationPrincipalDigest('web/a/t/u'),
          principalRecordId: 'rec-1',
          principalVersion: 1,
          workspace: ws.workspace,
          agentPreset: 'primary',
          expiresAt: Date.now() + 60_000,
          maxRuns: 2,
          maxTotalDurationMs: 20_000,
        }],
      }, {
        platform: 'darwin',
        uid: 501,
        allowHostPaths: true,
        macosAdapter: {
          platform: 'darwin',
          uid: 501,
          verifySandboxExec: async () => true,
          runCommand: async () => ({ status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'no-model-ok\n', stderr: '', artifacts: [] }),
        },
      })
      await isoSvc.ready
      const runRes = await isoSvc.run(agent, { grantId: 'grant-er09', idempotencyKey: 'k-er09', command: 'echo ok' }, new AbortController().signal)
      expect(runRes.status).toBe('succeeded')
      expect(runRes.quiescent).toBe(true)
      expect(await readFile(observerLog, 'utf8')).toContain('"event":"model-blocked"')
    } finally {
      if (prevLog === undefined) delete process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
      else process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG = prevLog
      if (prevNoModel === undefined) delete process.env.DSH_REPO_AUTONOMY_NO_MODEL
      else process.env.DSH_REPO_AUTONOMY_NO_MODEL = prevNoModel
    }
  })

  test('T3-ER-10 (F12+F14): Full R3 default-on self-iteration Cordis cluster lifecycle, attention enforcement, inProcessReload & clean disposal', async () => {
    const ws = await workspaces.create('t3-er10-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const delivery = await loadAssistantDelivery()
    const { PluginControlPlaneService } = await loadPluginControlPlane()
    const { AssistantEvaluationService } = await loadAssistantEvaluation()
    const verifierMod = await loadAssistantVerifier()
    const { AssistantEvolutionService } = await loadAssistantEvolution()
    const assocMod = await loadAssistantAssociation()
    const prefMod = await loadPreferenceLearning()
    const dreamMod = await loadAssistantDreaming()
    const memLearnMod = await loadAssistantMemoryLearning()
    const pmMod = await loadPersonalMemory()
    const growthMod = await loadAssistantGrowthDriver()

    const dreamDb = ws.sqlitePath('dream')
    expect(dreamMod.hasCompleteDreamingPrerequisites({ databasePath: dreamDb })).toBe(false)
    expect(dreamMod.normalizeConfig({ databasePath: dreamDb }).enabled).toBe(false)

    const dreamCfg = dreamMod.normalizeConfig({
      databasePath: dreamDb,
      scope: {
        workspace: ws.workspace,
        preset: 'primary',
        principalId: 'owner-er10',
        ownerRouteId: 'route-1',
      },
      provider: 'deepseek',
      model: 'deepseek-chat',
      budgetId: 'dream-budget',
      budgetAmount: 1,
    })
    expect(dreamCfg.enabled).toBe(true)

    const delCfg = delivery.Config({ databasePath: ws.sqlitePath('del'), spoolPath: join(ws.stateDir, 'spool') })
    expect(delCfg.attentionEnforce).toBe(true)
    expect(delCfg.attentionAttachOverCap).toBe(true)
    expect(delCfg.ownerReportRouting?.orderAcrossLanes).toBe(true)

    const memLearnDefaults = memLearnMod.Config(undefined) as unknown as Record<string, unknown>
    expect(memLearnDefaults.enabled).toBe(true)
    expect(memLearnDefaults.workItemExperiences).toBe(true)

    const pmSchema = (pmMod as Record<string, unknown>).Config as (input: Record<string, unknown>) => Record<string, unknown>
    expect(pmSchema({ databasePath: ':memory:' }).automaticLearning).toBe(true)

    const growthCfg = growthMod.normalizeConfig({}) as unknown as Record<string, unknown>
    expect(growthCfg.enabled).toBe(true)

    // Prepare a real R3 plugin bundle (v1 -> v2) inside a Cordis Loader/Include profile for live F12 reload
    const profileDir = join(ws.dshHome, 'profiles', 'web')
    const profileFile = join(profileDir, 'cordis.yml')
    const r3V1Dir = join(ws.root, 'bundles', 'r3-v1')
    const r3V2Dir = join(ws.root, 'bundles', 'r3-v2')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    await writeBundlePackage(r3V1Dir, {
      name: '@dsh-ray/r3-demo-svc',
      version: '0.1.0',
      body: "export const name = 'r3-svc'\nexport function apply(ctx) { ctx.provide('demoR3Svc', () => 'r3-v1') }\n",
    })
    await writeBundlePackage(r3V2Dir, {
      name: '@dsh-ray/r3-demo-svc',
      version: '0.2.0',
      body: "export const name = 'r3-svc'\nexport function apply(ctx) { ctx.provide('demoR3Svc', () => 'r3-v2') }\n",
    })
    await writeFile(profileFile, ['- id: r3-svc', `  name: ${join(r3V1Dir, 'lib/index.js')}`, '  config: {}', ''].join('\n'), 'utf8')

    const ctx = harness.createContext()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(profileFile).href } } as never)
    await ctx.loader.await()
    expect((ctx.get('demoR3Svc' as never) as () => string)()).toBe('r3-v1')

    harness.provideMockService(ctx, 'systemPrompt', { register: () => () => {}, context: () => () => {} })
    harness.provideMockService(ctx, 'tools', { register: () => () => {} })
    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy'),
      rules: [
        {
          id: 'allow-r3-assoc-intake',
          effect: 'allow',
          subject: { kind: 'background', id: 'assistant-association', workspace: ws.workspace, principal: 'owner-er10' },
          actions: ['intake-observe'],
          resource: { kind: 'automation', id: 'assistant-association:intake-signal' },
          context: { initiators: ['background'] },
        },
      ] as never,
    })
    await harness.mountService(ctx, AssistantEvaluationService, 'assistantEvaluation', {
      databasePath: ws.sqlitePath('eval'),
      projectionIntervalMs: 0,
    })
    await harness.mountService(ctx, delivery.AssistantDeliveryService, 'assistantDelivery', {
      databasePath: ws.sqlitePath('del'),
      spoolPath: join(ws.stateDir, 'spool'),
      schedulerEnabled: false,
      defaultWorkspace: ws.workspace,
      defaultAgentPreset: 'standard',
      inProcessReload: { profilePath: profileFile, entryId: 'r3-svc', hostGeneration: 1 },
    })
    const pcp = await harness.mountService<{
      canInProcessReload: () => boolean
      reloadInProcess: (input: Record<string, unknown>) => Promise<{ status: string }>
    }>(ctx, PluginControlPlaneService, 'pluginControlPlane', {
      catalogPath: join(ws.stateDir, 'catalog.json'),
      statePath: join(ws.stateDir, 'state'),
      trustPath: join(ws.stateDir, 'trust.json'),
    })
    const evo = await harness.mountService<{
      health: () => { autonomousRollbacks: number }
    }>(ctx, AssistantEvolutionService, 'assistantEvolution', AssistantEvolutionService.Config({ databasePath: ws.sqlitePath('evo') }))
    const verifier = await harness.mountService<{
      health: () => { evaluationConnected: boolean; requireAcceptance: boolean }
    }>(ctx, verifierMod.AssistantVerifierService, 'assistantVerifier', verifierMod.Config({ databasePath: ws.sqlitePath('verifier') }))
    const assoc = await harness.mountService<{
      emitIntakeSignalNow: (input: Record<string, unknown>) => { emitted: boolean }
    }>(ctx, assocMod.AssistantAssociationService, 'assistantAssociation', {
      databasePath: ws.sqlitePath('assoc'),
      enabled: true,
      allowHeadlessScope: true,
      intakeSignal: { enabled: true, minScore: 0.5 },
    })
    await harness.mountService(ctx, prefMod.PreferenceLearningService, 'assistantPreferenceLearning', prefMod.Config({ databasePath: ws.sqlitePath('pref') }))
    const wiMod = await loadAssistantWorkItems()
    const wi = await harness.mountService<{
      enabled: boolean
      health: () => { enabled: boolean; evaluation: { enabled: boolean; connected: boolean } }
      inspectIntakeQueue: () => { enabled: boolean; intakeCounts: { stored: number } }
    }>(ctx, wiMod.AssistantWorkItemsService, 'assistantWorkItems', {
      databasePath: ws.sqlitePath('wi'),
      workRoot: ws.workspace,
      intakeLedger: { enabled: true },
    })

    // Cross-service F14 wiring: Verifier <-> Evaluation, Evolution <-> Delivery, Association -> WorkItems
    expect(verifier.health().evaluationConnected).toBe(true)
    expect(verifier.health().requireAcceptance).toBe(true)
    expect(evo.health().autonomousRollbacks).toBe(0)
    expect(wi.enabled).toBe(true)

    const principalDigest = assocMod.computePrincipalDigest('owner-er10')
    const ownerScopeKey = assocMod.computeOwnerScopeKey({
      mode: 'headless',
      principalDigest,
      principalRecordId: null,
      principalVersion: null,
      workspace: ws.workspace,
      agentPreset: 'primary',
    })
    const sigRes = assoc.emitIntakeSignalNow({
      scope: {
        mode: 'headless',
        ownerScopeKey,
        principalId: 'owner-er10',
        principalDigest,
        principalRecordId: null,
        principalVersion: null,
        workspace: ws.workspace,
        agentPreset: 'primary',
      },
      goalNode: { id: 'g:er10', kind: 'goal', title: 'Track R3 cluster readiness', ownerScopeKey, sensitivity: 'private', status: 'active' },
      targetNode: { id: 'm:er10', kind: 'memory', title: 'Cluster note', ownerScopeKey, sensitivity: 'private', status: 'active' },
      score: 0.9,
      reason: 'r3-cluster-check',
      inHoldout: false,
      nowMs: Date.now(),
    })
    expect(sigRes.emitted).toBe(true)
    expect(wi.inspectIntakeQueue().intakeCounts.stored).toBe(1)

    // Cross-service F12 wiring: PluginControlPlaneService drives AssistantDeliveryService's inProcessReload
    expect(pcp.canInProcessReload()).toBe(true)
    const v1Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: r3V1Dir })
    const v2Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: r3V2Dir })
    const v2PatchDigest = delivery.computeInProcessPatchDigest({ config: {} })
    const reloadRes = await pcp.reloadInProcess({
      now: Date.now(),
      snapshot: {
        planId: 'plan:er10-r3',
        planDigest: sha256Hex('plan-er10-r3'),
        status: 'awaiting-reload',
        activation: { id: 'activation:er10', fence: 1 },
        hostGeneration: 1,
        inProcessGeneration: 1,
        running: { artifactDigest: v1Digest, patchDigest: v2PatchDigest },
        mode: 'artifact-replace',
        target: {
          package: '@dsh-ray/r3-demo-svc',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: v2PatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: r3V2Dir, config: {} },
        },
      },
    })
    expect(reloadRes.status).toBe('reloaded')
    expect((ctx.get('demoR3Svc' as never) as () => string)()).toBe('r3-v2')

    // Verify Delivery WP19 attention assessment & over-cap attachment conversion
    const emptyLedger = {
      questionAsked: () => false,
      questionAnswered: () => false,
      openQuestions: () => [],
      questionWorkItem: () => undefined,
    }
    const invalidAssessment = delivery.assessAttention({
      text: 'Status update',
      envelope: { purpose: 'attention', workItemId: '' },
      ledger: emptyLedger,
    })
    expect(invalidAssessment.reasons).toContain('attention-missing-work-item')

    const longText = Array.from({ length: 450 }, (_, i) => `word${i}`).join(' ')
    const converted = delivery.convertOverCapAttention({
      text: longText,
      format: 'markdown',
      digest: text => sha256Hex(text),
    })
    expect(converted.format).toBe('plain')
    expect(converted.attachment.sha256).toBe(sha256Hex(longText))

    await harness.disposeAll()
  })
})
