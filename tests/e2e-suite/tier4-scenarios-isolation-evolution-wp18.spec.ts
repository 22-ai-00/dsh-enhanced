import { Include } from '@deepseek-ai/cordis-plugin-include'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { expectNoSecretLeak, getExportFn, sha256Hex } from './helpers/assertions.ts'
import { runCommandProcess } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAdoptionCoordinator,
  loadAssistantActions,
  loadAssistantAssociation,
  loadAssistantDelivery,
  loadAssistantEvaluation,
  loadAssistantEvolution,
  loadAssistantGrowthDriver,
  loadAssistantIsolation,
  loadAssistantIsolationConfig,
  loadAssistantPolicy,
  loadAssistantSkills,
  loadAssistantVerifier,
  loadAssistantWorkItems,
  loadNativeBehaviorArtifact,
  loadNativeBehaviorWorker,
  loadPackageModule,
  loadPluginBehaviorRunner,
  loadPluginControlPlane,
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
    nonce: 'b'.repeat(64),
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

describe('Tier 4 Real-World Scenarios — S4–S7: S4 Isolation, WP16 Reload & Rollback, WP18 Sandbox Repo', () => {
  test('T4-S04 (F08, F09, F14): S4 web learning inside OS isolation -> low-trust provenance -> S3 dreaming & association intake', async () => {
    const ws = await workspaces.create('t4-s04-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const assoc = await loadAssistantAssociation()
    const isoMod = await loadAssistantIsolation()
    const wiMod = await loadAssistantWorkItems()
    const assocIntakeMod = await loadPackageModule('assistant-growth-driver/association-intake')

    // 1. Default-on R3 association flags
    const normalizedCfg = assoc.normalizeAssociationConfig({ databasePath: ws.sqlitePath('assoc-def') })
    expect(normalizedCfg.enabled).toBe(true)
    expect(normalizedCfg.dreaming.enabled).toBe(true)
    expect(normalizedCfg.intakeSignal.enabled).toBe(true)
    expect(normalizedCfg.webLearning.enabled).toBe(true)

    let requestsReceived = 0
    const server = createServer((_req, res) => {
      requestsReceived += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><title>Cordis Sandbox Guide</title><body>CordisLifecycle disposes child fibers cleanly.</body></html>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const loopbackUrl = `http://127.0.0.1:${port}/guide`

    try {
      const secrets = ['sk-s4-secret', 'feishu-s4-secret', 'ghp-s4-secret']
      const sourceEnv = {
        PATH: '/usr/bin:/bin',
        DEEPSEEK_API_KEY: secrets[0]!,
        FEISHU_APP_SECRET: secrets[1]!,
        GITHUB_TOKEN: secrets[2]!,
      }

      // Negative contrast: write tools fail closed
      expect(() => assoc.assertReadOnlyWebToolSurface(['write_file'])).toThrow()
      expect(() => assoc.assertReadOnlyWebToolSurface(['bash'])).toThrow()

      const inProc = assoc.createInProcessWebLearningRunner({
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetcher: async (_url, init) => fetch(loopbackUrl, { signal: init.signal }),
      })

      // Negative contrast: direct loopback IP target blocked by SSRF guard
      const ssrfBlocked = await inProc.run({
        runId: 's4-ssrf-blocked',
        allowedDomains: ['docs.example.test'],
        targets: [{ url: loopbackUrl, interestKey: 'CordisLifecycle' }],
        budget: { maxRequests: 2, maxPages: 2, maxBytesPerRequest: 8_192, maxTotalBytes: 16_384, maxDurationMs: 5_000, requestTimeoutMs: 2_000 },
        toolSurface: ['web_fetch_readonly'],
      })
      expect(ssrfBlocked.pagesFetched).toBe(0)
      expect(requestsReceived).toBe(0)

      // 2. Wrap S4 runner through real assistant-isolation runIsolatedSubprocess probe & strict tempBaseDir
      const runIsolatedSubprocess = getExportFn<(req: Record<string, unknown>) => Promise<{
        backend: string
        sandboxed: boolean
        status: string
        stdout: string
      }>>(isoMod, 'runIsolatedSubprocess')
      const createSandboxed = getExportFn<(opts?: Record<string, unknown>) => {
        run: (input: unknown) => Promise<Record<string, unknown>>
      }>(assoc, 'createSandboxedWebLearningRunner')

      let isolationExecuted = false
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
          isolationExecuted = true
          expect(req.network).toBe('outbound-https')
          expect(req.args.some(a => a.endsWith('web-learning-worker.ts') || a.endsWith('web-learning-worker.js'))).toBe(true)
          expect(Array.isArray(req.writablePaths) && req.writablePaths.length === 1).toBe(true)
          expectNoSecretLeak(JSON.stringify(req.env), secrets)

          const isoProbe = await runIsolatedSubprocess({
            command: process.execPath,
            args: ['-e', 'process.stdout.write("s4-os-sandbox-ok")'],
            cwd: ws.workspace,
            env: { PATH: '/usr/bin:/bin', LANG: 'C' },
            stdin: '',
            timeoutMs: 5_000,
            network: 'none',
          })
          expect(isoProbe.sandboxed).toBe(true)
          expect(isoProbe.status).toBe('succeeded')
          expect(isoProbe.stdout).toBe('s4-os-sandbox-ok')

          const workerOutput = await inProc.run(JSON.parse(req.stdin) as never)
          return {
            backend: isoProbe.backend,
            sandboxed: true,
            status: 'succeeded',
            exitCode: 0,
            processSignal: null,
            stdout: JSON.stringify(workerOutput),
            stderr: '',
            truncated: false,
            durationMs: 1,
          }
        },
      })

      // 3. Mount Association + Policy + WorkItems and drive S4 -> low-trust provenance -> S3 -> WorkItems & Growth
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
        ] as never,
      })
      harness.provideMockService(ctx, 'assistantDelivery', {
        validateOwnerRoute: () => ({
          receiptVersion: 2,
          authorityId: 'route-s4',
          authorityHash: sha256Hex('route-s4'),
          principalId: 'web/a/t/u',
          principalRecordId: 'owner-s4',
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

      const assocDb = ws.sqlitePath('assoc')
      const assocSvc = await harness.mountService<{
        store: { upsertBatch: (batch: unknown) => unknown }
        runWebLearningNow: (scope: Record<string, unknown>, opts: Record<string, unknown>) => Promise<{
          ran: boolean
          nodesWritten: number
          writtenNodeIds: readonly string[]
        }>
        runDreamingNow: (scope: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ ran: boolean }>
        emitIntakeSignalNow: (input: Record<string, unknown>) => { emitted: boolean; outcome: string }
        listWebLearningFetches: (ownerScopeKey: string) => readonly { canonicalUrl: string; fetchedAt: number }[]
        listIntakeSignals: (ownerScopeKey: string) => readonly unknown[]
      }>(ctx, assoc.AssistantAssociationService, 'assistantAssociation', {
        databasePath: assocDb,
        enabled: true,
        allowLowTrust: true,
        dreaming: { enabled: true, intervalMs: 1_000, idleMinMs: 0, maxPairsPerRun: 8 },
        intakeSignal: { enabled: true, minScore: 0.5 },
        webLearning: {
          enabled: true,
          allowedDomains: ['docs.example.test'],
          seedUrls: ['https://docs.example.test/guide'],
          idleMinMs: 0,
        },
      })

      const principalDigest = assoc.computePrincipalDigest('web/a/t/u')
      const ownerScopeKey = assoc.computeOwnerScopeKey({
        mode: 'delivery',
        principalDigest,
        principalRecordId: 'owner-s4',
        principalVersion: 1,
        workspace: ws.workspace,
        agentPreset: 'primary',
      })
      const scope = {
        mode: 'delivery' as const,
        ownerScopeKey,
        principalId: 'web/a/t/u',
        principalDigest,
        principalRecordId: 'owner-s4',
        principalVersion: 1,
        workspace: ws.workspace,
        agentPreset: 'primary',
        authorityId: 'route-s4',
      }
      const nowMs = 1_700_000_000_000
      assocSvc.store.upsertBatch({
        nodes: [{
          id: 'a:g-s4',
          kind: 'goal',
          sourcePlugin: 'assistant-goals',
          sourceRef: 'goal:s4',
          sourceVersion: 1,
          ownerScopeKey,
          ownerMode: 'delivery',
          principalDigest,
          principalRecordId: 'owner-s4',
          principalVersion: 1,
          scopeMode: 'workspace',
          workspace: ws.workspace,
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'CordisLifecycle',
          body: 'Verify CordisLifecycle disposal ordering across fibers.',
          entities: ['CordisLifecycle'],
          tokens: ['cordis', 'lifecycle', 'disposal'],
          status: 'active',
          createdAt: nowMs - 3_600_000,
          updatedAt: nowMs - 3_600_000,
        }],
        edges: [],
        derivedRefs: [],
      })

      const webRes = await assocSvc.runWebLearningNow(scope, {
        nowMs,
        ignoreIdle: true,
        runner: sandboxedRunner,
      })
      expect(isolationExecuted).toBe(true)
      expect(requestsReceived).toBe(1)
      expect(webRes.ran).toBe(true)
      expect(webRes.nodesWritten).toBeGreaterThanOrEqual(1)

      const fetches = assocSvc.listWebLearningFetches(ownerScopeKey)
      expect(fetches[0]?.canonicalUrl).toBe('https://docs.example.test/guide')
      expect(fetches[0]?.fetchedAt).toBe(nowMs)

      // Verify low-trust provenance stored in SQLite
      const assocSqlite = new DatabaseSync(assocDb, { readOnly: true })
      try {
        const webRow = assocSqlite.prepare(
          'SELECT trust, metadata_json FROM assoc_nodes WHERE id = ?',
        ).get(webRes.writtenNodeIds[0]!) as { trust: string; metadata_json: string } | undefined
        expect(webRow?.trust).toBe('low')
        const metadata = JSON.parse(webRow?.metadata_json ?? '{}') as { sourceUrl?: string; fetchedAt?: number }
        expect(metadata.sourceUrl).toBe('https://docs.example.test/guide')
        expect(metadata.fetchedAt).toBe(nowMs)
      } finally {
        assocSqlite.close()
      }

      const dreamRes = await assocSvc.runDreamingNow(scope, { nowMs, lastActivityAt: nowMs - 3_600_000, hasRunningAgent: false })
      expect(dreamRes.ran).toBe(true)

      // Holdout signal blocked vs non-holdout signal admitted
      const holdoutBlocked = assocSvc.emitIntakeSignalNow({
        scope,
        goalNode: { id: 'a:g-s4', kind: 'goal', title: 'CordisLifecycle', ownerScopeKey, sensitivity: 'private', status: 'active' },
        targetNode: { id: webRes.writtenNodeIds[0]!, kind: 'web', title: 'Cordis Sandbox Guide', ownerScopeKey, sensitivity: 'private', status: 'active' },
        score: 0.9,
        reason: 'holdout-check',
        inHoldout: true,
        nowMs,
      })
      expect(holdoutBlocked.emitted).toBe(false)
      expect(holdoutBlocked.outcome).toBe('holdout-blocked')

      const sigRes = assocSvc.emitIntakeSignalNow({
        scope,
        goalNode: { id: 'a:g-s4', kind: 'goal', title: 'CordisLifecycle', ownerScopeKey, sensitivity: 'private', status: 'active' },
        targetNode: { id: webRes.writtenNodeIds[0]!, kind: 'web', title: 'Cordis Sandbox Guide', ownerScopeKey, sensitivity: 'private', status: 'active' },
        score: 0.9,
        reason: 's4-sandbox-match',
        inHoldout: false,
        nowMs: nowMs + 1_000,
      })
      expect(sigRes.emitted).toBe(true)
      expect(assocSvc.listIntakeSignals(ownerScopeKey).length).toBeGreaterThanOrEqual(1)
      expect(wi.inspectIntakeQueue().intakeCounts.stored).toBeGreaterThanOrEqual(1)

      const readCandidates = getExportFn<(
        ctx: unknown,
        authority: { scope: Record<string, unknown>; assertCurrent: () => void },
        maxCandidates: number,
      ) => { candidates: readonly unknown[]; summary: { enabled: boolean } }>(assocIntakeMod, 'readAssociationCandidates')
      const growthIntake = readCandidates(
        ctx,
        {
          scope: { principalId: 'web/a/t/u', principalRecordId: 'owner-s4', principalVersion: 1, workspace: ws.workspace, preset: 'primary' },
          assertCurrent: () => {},
        },
        5,
      )
      expect(growthIntake.summary.enabled).toBe(true)
      expect(Array.isArray(growthIntake.candidates)).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 15_000)

  test('T4-S05 (F12, F13, F14): Autonomous failure -> growth-driver R3 -> service plugin revision -> verifier -> live inProcessReload swap preserving sibling', async () => {
    const ws = await workspaces.create('t4-s05-')
    const { normalizeConfig } = await loadAssistantGrowthDriver()
    const sc = await loadSourceCreation()
    const sr = await loadSourceRevision()
    const runnerMod = await loadPluginBehaviorRunner()
    const delivery = await loadAssistantDelivery()
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const pcpMod = await loadPluginControlPlane()
    const coord = await loadAdoptionCoordinator()

    // 1. R3 growth-driver default-on check (workItemFailures + pluginSourceProposals)
    const growthCfg = normalizeConfig({}) as unknown as Record<string, unknown>
    expect(growthCfg.enabled).toBe(true)
    expect((growthCfg.pluginSourceProposals as Record<string, unknown>).enabled).toBe(true)
    expect((growthCfg.pluginSourceProposals as Record<string, unknown>).allowCreation).toBe(true)
    expect((growthCfg.pluginSourceProposals as Record<string, unknown>).allowRevision).toBe(true)
    expect((growthCfg.usageLearning as Record<string, unknown>).workItemFailures).toBe(true)

    // 2. Validate candidate 'service' plugin source creation/revision & run NativeBehaviorWorker discover + invoke
    const validateFiles = getExportFn<(files: readonly { path: string; content: string }[]) => void>(sc, 'validateSourceCreationFiles')
    const extractKind = getExportFn<(files: readonly { path: string; content: string }[]) => string>(sc, 'extractCandidatePluginKindFromFiles')
    expect(sr.validateSourceRevisionBinding).toBeTypeOf('function')
    expect(runnerMod.isPluginKind('service')).toBe(true)

    const v2SourceFiles = [
      {
        path: 'src/index.ts',
        content: `
          import { Service } from '@deepseek-ai/cordis'
          export class GreeterService extends Service {
            constructor(ctx) { super(ctx, 'greeter') }
            health() { return { ready: true } }
            greet(input) { return { hello: String(input?.who ?? 'tier4') } }
          }
          export default GreeterService
        `,
      },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: '@dsh-enhanced/evolved-greeter',
          version: '0.2.0',
          main: './lib/index.js',
          dsh: { pluginKind: 'service', bundle: { patch: './cordis.patch.yml' } },
        }),
      },
      {
        path: 'cordis.patch.yml',
        content: '- insert:\n  - id: dsh-enhanced-evolved-greeter\n    name: "@dsh-enhanced/evolved-greeter"\n    config: {}\n',
      },
    ]
    expect(() => validateFiles(v2SourceFiles)).not.toThrow()
    expect(extractKind(v2SourceFiles)).toBe('service')

    const v2Tgz = packPluginEntries({
      'package/package.json': JSON.stringify({ name: '@dsh-enhanced/evolved-greeter', version: '0.2.0', type: 'module', main: './lib/index.js' }),
      'package/cordis.patch.yml': '- insert:\n  - id: evolved-greeter\n    name: "@dsh-enhanced/evolved-greeter"\n',
      'package/lib/index.js': `
        import { Service } from '@deepseek-ai/cordis'
        class GreeterService extends Service {
          constructor(ctx) { super(ctx, 'greeter') }
          health() { return { ready: true } }
          greet(input) { return { hello: String(input?.who ?? 'tier4') } }
        }
        export default GreeterService
      `,
    })
    const disc = await runBehaviorWorkerOnTgz(ws.workspace, v2Tgz, { kind: 'discover' }, 'service')
    expect(disc.status).toBe('result')
    expect(disc.pluginKind).toBe('service')

    const inv = await runBehaviorWorkerOnTgz(
      ws.workspace,
      v2Tgz,
      {
        kind: 'invoke',
        schemaDigest: String(disc.schemaDigest),
        calls: [{ id: 'c1', toolName: 'service_method_probe', arguments: { service: 'greeter', method: 'greet', input: { who: 'tier4' } } }],
      },
      'service',
    )
    expect((inv.calls as Array<{ result: { value: unknown } }>)[0]?.result.value).toMatchObject({
      kind: 'service',
      service: 'greeter',
      method: 'greet',
      result: { hello: 'tier4' },
    })

    // 3. Live Cordis Loader/Include + ControlPlaneStore + coordinateAdoptionHandoff -> pcp.reloadInProcess swap
    const profileDir = join(ws.dshHome, 'profiles', 'web')
    const profileFile = join(profileDir, 'cordis.yml')
    const v1Dir = join(ws.root, 'bundles', 'greeter-v1')
    const v2Dir = join(ws.root, 'bundles', 'greeter-v2')
    const siblingDir = join(ws.root, 'bundles', 'sibling')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })

    const hookKey = `__dshT4S05_${Math.random().toString(16).slice(2)}`
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
        name: '@dsh-enhanced/evolved-greeter',
        version: '0.1.0',
        body: `
export const name = 'evolved-greeter'
export function apply(ctx) {
  ctx.provide('greeter', { version: () => 'v1', greet: who => 'v1:' + who })
}
`,
      })
      await writeBundlePackage(v2Dir, {
        name: '@dsh-enhanced/evolved-greeter',
        version: '0.2.0',
        body: `
export const name = 'evolved-greeter'
export function apply(ctx) {
  ctx.provide('greeter', { version: () => 'v2', greet: who => 'v2:' + who })
}
`,
      })
      await writeFile(
        profileFile,
        [
          '- id: cand-svc',
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
      await ctx.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(profileFile).href } } as never)
      await ctx.loader.await()

      const beforeSiblingFiber = ctx.loader.resolve('include:sibling').fiber
      expect((ctx.get('greeter' as never) as { version: () => string }).version()).toBe('v1')

      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
      await harness.mountService(ctx, delivery.AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery'),
        spoolPath: join(ws.stateDir, 'spool'),
        schedulerEnabled: false,
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'standard',
        inProcessReload: { profilePath: profileFile, entryId: 'cand-svc', hostGeneration: 1 },
      })
      const ownerKeys = generateKeyPairSync('ed25519')
      const catalogPath = join(ws.stateDir, 'catalog.json')
      const trustPath = join(ws.stateDir, 'trust.json')
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
      expect(pcp.canInProcessReload()).toBe(true)

      const now = Date.now()
      const cpDbPath = ws.sqlitePath('cp-s5')
      let planId = ''
      const cpStore = new pcpMod.ControlPlaneStore({ path: cpDbPath, now: () => now })
      try {
        const approvalAuthority = new pcpMod.Ed25519ApprovalAuthority(
          ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }),
          'owner',
          'owner-1',
        )
        const cand = pcpMod.exampleIntegrityPinnedCatalog.entries[0]!
        const gap = cpStore.recordGap({
          idempotencyKey: 'gap-s5',
          capability: cand.capabilities[0]!,
          context: 's5-service-reload',
          expectedValue: 100,
          frequency: 10,
          estimatedCost: 50,
          risk: 0.2,
        })
        let plan = cpStore.createPlan({
          candidate: cand,
          catalog: { digest: pcpMod.controlPlaneDigest(pcpMod.exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
          matchedCapabilities: [cand.capabilities[0]!],
          profile: 'web',
          target: { dshHome: ws.dshHome, profile: 'web', profilePath: profileDir },
          installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f10',
          ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f11', path: cpDbPath },
          executor: { id: 'dsh', version: '0.1.84', path: join(ws.root, 'dsh'), sha256: sha256Hex('dsh-bin') },
          ttlMs: 120_000,
          gapId: gap.id,
          idempotencyKey: 'plan-s5',
        }).result
        planId = plan.id
        const appBody = {
          schemaVersion: 1 as const,
          approvalId: 'approval-s5',
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
          idempotencyKey: 'approve-s5',
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

        const v1Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: v1Dir })
        const v2Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: v2Dir })
        const v2PatchDigest = delivery.computeInProcessPatchDigest({ config: {} })

        const coordinate = getExportFn<(input: Record<string, unknown>) => Promise<{ status: string }>>(coord, 'coordinateAdoptionHandoff')
        const handoffRes = await coordinate({
          store: {
            getPlan: (id: string) => cpStore.getPlan(id),
            assertAdoptionHandoff: () => {},
            getAdoptionHandoff: (id: string) => {
              const p = cpStore.getPlan(id)
              return { planId: p.id, planDigest: p.digest, coordinatorId: 'coord-s5', createdAt: now, expiresAt: now + 60_000 }
            },
            getLiveQualificationDeadline: () => undefined,
            requestActivationRollback: (input: { planId: string; expectedRevision: number; fence: number; failureCode: string }) =>
              cpStore.requestActivationRollback(input),
          },
          trust: {},
          planId: plan.id,
          inProcessReload: {
            canHandle: (p: { id: string; status: string }) => p.id === plan.id && p.status === 'awaiting-reload',
            execute: async (p: { id: string; digest: string; revision: number; activation: { id: string; fence: number } }) => {
              const reloadRes = await pcp.reloadInProcess({
                now,
                snapshot: {
                  planId: p.id,
                  planDigest: p.digest,
                  status: 'awaiting-reload',
                  activation: { id: p.activation.id, fence: p.activation.fence },
                  hostGeneration: 1,
                  inProcessGeneration: 1,
                  running: { artifactDigest: v1Digest, patchDigest: v2PatchDigest },
                  mode: 'artifact-replace',
                  target: {
                    package: '@dsh-enhanced/evolved-greeter',
                    version: '0.2.0',
                    artifactDigest: v2Digest,
                    patchDigest: v2PatchDigest,
                    changesProcessSubtree: false,
                    holdsUnprovenProcessAuthority: false,
                    artifact: { sourceDir: v2Dir, config: {} },
                  },
                },
              })
              expect(reloadRes.status).toBe('reloaded')
              return { status: 'reloaded', plan: { ...p, status: 'commit-pending', revision: p.revision + 1 } }
            },
          },
        })
        expect(handoffRes.status).toBe('commit-pending')
      } finally {
        cpStore.close()
      }

      // Live service updated to v2; sibling untouched; SQLite store persisted
      const liveGreeter = ctx.get('greeter' as never) as { version: () => string; greet: (who: string) => string }
      expect(liveGreeter.version()).toBe('v2')
      expect(liveGreeter.greet('tier4')).toBe('v2:tier4')
      expect(ctx.loader.resolve('include:sibling').fiber).toBe(beforeSiblingFiber)
      expect((globalHooks[hookKey] as { siblingDisposed: boolean }).siblingDisposed).toBe(false)
      expect((ctx.get('siblingPing' as never) as () => string)()).toBe('steady')

      const reopened = new pcpMod.ControlPlaneStore({ path: cpDbPath, now: () => now })
      try {
        expect(reopened.getPlan(planId).status).toBe('awaiting-reload')
      } finally {
        reopened.close()
      }
    } finally {
      delete globalHooks[hookKey]
    }
  }, 15_000)

  test('T4-S06 (F12, F13, F14): Bad evolved plugin triggers automatic verification failure & rollback recovery while opt-out rejects & core denylist holds', async () => {
    const ws = await workspaces.create('t4-s06-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const delivery = await loadAssistantDelivery()
    const { AssistantEvaluationService } = await loadAssistantEvaluation()
    const verifierMod = await loadAssistantVerifier()
    const { AssistantEvolutionService } = await loadAssistantEvolution()
    const pcpMod = await loadPluginControlPlane()
    const coord = await loadAdoptionCoordinator()

    expect(delivery.IN_PROCESS_RELOAD_DENYLIST).toContain('@dsh-enhanced/plugin-control-plane')
    expect(delivery.IN_PROCESS_RELOAD_DENYLIST).toContain('@dsh-enhanced/assistant-delivery')

    const evoDefaults = AssistantEvolutionService.Config({ databasePath: ws.sqlitePath('evo') })
    const verifierDefaults = verifierMod.Config({ databasePath: ws.sqlitePath('ver') })
    expect(evoDefaults.autonomousRollback).toBe(true)
    expect(verifierDefaults.requireAcceptance).toBe(true)

    const profileDir = join(ws.dshHome, 'profiles', 'web')
    const profileFile = join(profileDir, 'cordis.yml')
    const v1Dir = join(ws.root, 'bundles', 'cand-v1')
    const v2CrashDir = join(ws.root, 'bundles', 'cand-v2-crash')
    const siblingDir = join(ws.root, 'bundles', 'sibling-s6')
    await mkdir(profileDir, { recursive: true, mode: 0o700 })

    await writeBundlePackage(siblingDir, {
      name: '@dsh-enhanced/sibling-s6',
      version: '0.1.0',
      body: "export const name = 'sibling-s6'\nexport function apply(ctx) { ctx.provide('siblingS6', () => 'intact') }\n",
    })
    await writeBundlePackage(v1Dir, {
      name: '@dsh-enhanced/cand-svc',
      version: '0.1.0',
      body: "export const name = 'cand-svc'\nexport function apply(ctx) { ctx.provide('candService', () => 'v1-healthy') }\n",
    })
    await writeBundlePackage(v2CrashDir, {
      name: '@dsh-enhanced/cand-svc',
      version: '0.1.84',
      body: "export const name = 'cand-svc'\nexport function apply() { throw new Error('evolved-plugin-crash') }\n",
    })
    await writeFile(
      profileFile,
      [
        '- id: cand-svc',
        `  name: ${join(v1Dir, 'lib/index.js')}`,
        '  config: {}',
        '- id: sibling-s6',
        `  name: ${join(siblingDir, 'lib/index.js')}`,
        '  config: {}',
        '',
      ].join('\n'),
      'utf8',
    )

    const ctx = harness.createContext()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(profileFile).href } } as never)
    await ctx.loader.await()
    expect((ctx.get('candService' as never) as () => string)()).toBe('v1-healthy')

    await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', { databasePath: ws.sqlitePath('policy') })
    await harness.mountService(ctx, AssistantEvaluationService, 'assistantEvaluation', { databasePath: ws.sqlitePath('eval'), projectionIntervalMs: 0 })
    await harness.mountService(ctx, AssistantEvolutionService, 'assistantEvolution', evoDefaults)
    const verifier = await harness.mountService<{
      health: () => { evaluationConnected: boolean; requireAcceptance: boolean }
    }>(ctx, verifierMod.AssistantVerifierService, 'assistantVerifier', verifierDefaults)
    expect(verifier.health().evaluationConnected).toBe(true)
    expect(verifier.health().requireAcceptance).toBe(true)

    await harness.mountService(ctx, delivery.AssistantDeliveryService, 'assistantDelivery', {
      databasePath: ws.sqlitePath('delivery'),
      spoolPath: join(ws.stateDir, 'spool'),
      schedulerEnabled: false,
      defaultWorkspace: ws.workspace,
      defaultAgentPreset: 'standard',
      inProcessReload: { profilePath: profileFile, entryId: 'cand-svc', hostGeneration: 1 },
    })

    const ownerKeys = generateKeyPairSync('ed25519')
    const catalogPath = join(ws.stateDir, 'catalog.json')
    const trustPath = join(ws.stateDir, 'trust.json')
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

    const v1Digest = await delivery.computeInProcessArtifactDigest({ sourceDir: v1Dir })
    const badDigest = await delivery.computeInProcessArtifactDigest({ sourceDir: v2CrashDir })
    const badPatchDigest = delivery.computeInProcessPatchDigest({ config: {} })
    const now = Date.now()

    const cpDbPath = ws.sqlitePath('coord-cp-s6')
    let planId = ''
    const cpStore = new pcpMod.ControlPlaneStore({ path: cpDbPath, now: () => now })
    try {
      const approvalAuthority = new pcpMod.Ed25519ApprovalAuthority(
        ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }),
        'owner',
        'owner-1',
      )
      const cand = pcpMod.exampleIntegrityPinnedCatalog.entries[0]!
      const gap = cpStore.recordGap({
        idempotencyKey: 'gap-s6',
        capability: cand.capabilities[0]!,
        context: 's6-crash-rollback',
        expectedValue: 100,
        frequency: 10,
        estimatedCost: 50,
        risk: 0.2,
      })
      let plan = cpStore.createPlan({
        candidate: cand,
        catalog: { digest: pcpMod.controlPlaneDigest(pcpMod.exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
        matchedCapabilities: [cand.capabilities[0]!],
        profile: 'web',
        target: { dshHome: ws.dshHome, profile: 'web', profilePath: profileDir },
        installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f10',
        ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f11', path: cpDbPath },
        executor: { id: 'dsh', version: '0.1.84', path: join(ws.root, 'dsh'), sha256: sha256Hex('dsh-bin') },
        ttlMs: 120_000,
        gapId: gap.id,
        idempotencyKey: 'plan-s6',
      }).result
      planId = plan.id
      const appBody = {
        schemaVersion: 1 as const,
        approvalId: 'approval-s6',
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
        idempotencyKey: 'approve-s6',
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
      const coordRes = await coordinate({
        store: {
          getPlan: (id: string) => cpStore.getPlan(id),
          assertAdoptionHandoff: () => {},
          getAdoptionHandoff: (id: string) => {
            const p = cpStore.getPlan(id)
            return { planId: p.id, planDigest: p.digest, coordinatorId: 'coord-s6', createdAt: now, expiresAt: now + 60_000 }
          },
          getLiveQualificationDeadline: () => undefined,
          requestActivationRollback: (input: { planId: string; expectedRevision: number; fence: number; failureCode: string }) =>
            cpStore.requestActivationRollback(input),
        },
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
                running: { artifactDigest: v1Digest, patchDigest: badPatchDigest },
                mode: 'artifact-replace',
                target: {
                  package: '@dsh-enhanced/cand-svc',
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
            const rolled = cpStore.requestActivationRollback({
              planId: p.id,
              expectedRevision: p.revision,
              fence: p.activation.fence,
              failureCode: 'in-process-reload-rolled-back',
            })
            return { status: 'rolled-back', plan: rolled, failureCode: 'in-process-reload-rolled-back' }
          },
        },
      })
      expect(coordRes.status).toBe('rollback-pending')
      expect(coordRes.activation?.failureCode).toBe('in-process-reload-rolled-back')
    } finally {
      cpStore.close()
    }

    // Healthy v1 restored live; sibling intact; rollback persisted on disk
    expect((ctx.get('candService' as never) as () => string)()).toBe('v1-healthy')
    expect((ctx.get('siblingS6' as never) as () => string)()).toBe('intact')
    const reopened = new pcpMod.ControlPlaneStore({ path: cpDbPath, now: () => now })
    try {
      const persisted = reopened.getPlan(planId)
      expect(persisted.status).toBe('rollback-pending')
      expect(persisted.activation?.failureCode).toBe('in-process-reload-rolled-back')
    } finally {
      reopened.close()
    }

    // Opted-out inProcessReload rejects cleanly
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
        planId: 'plan:s6-optout',
        planDigest: sha256Hex('plan-s6-optout'),
        status: 'awaiting-reload',
        activation: { id: 'act:s6-optout', fence: 1 },
        hostGeneration: 1,
        inProcessGeneration: 1,
        running: { artifactDigest: badDigest, patchDigest: badPatchDigest },
        target: {
          package: '@dsh-enhanced/cand-svc',
          version: '0.1.84',
          artifactDigest: badDigest,
          patchDigest: badPatchDigest,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
        },
      },
    })).rejects.toThrow(/inProcessReload Host runtime is not registered/u)
  })

  test('T4-S07 (F08, F10, F11): WP18 standalone sandbox repo bugfix (summarize.mjs) -> linux-native verify -> commit & SHA readback + skill capture', async () => {
    const ws = await workspaces.create('t4-s07-')
    const isoMod = await loadAssistantIsolation()
    const isoCfgMod = await loadAssistantIsolationConfig()
    const { AssistantActionsService } = await loadAssistantActions()
    const skillsMod = await loadAssistantSkills()
    const fixtureMod = (await loadRepoAutonomyFixture()) as {
      apply: (ctx: unknown) => void
      prepareRepositoryFixture: (home: string, patchPath: string, env: Record<string, string>) => Promise<{ credentialHandle: string }>
      repositoryFixtureSnapshot: () => { ready: boolean; pullRequest: { number: number } | null; checks: readonly { status: string; conclusion: string | null }[]; reviews: readonly { state: string }[] }
    }
    const observerMod = (await loadRepoAutonomyObserver()) as { name: string; apply: (ctx: unknown) => void }
    const { loadLiveRepositoryInput } = (await loadRepoLiveInput()) as {
      loadLiveRepositoryInput: (inputPath: string, now?: number) => Promise<{
        repositoryDelivery: { openPullRequest: boolean; paths: readonly string[] }
      }>
    }

    // 1. Real bare git repo + working clone with buggy summarize.mjs
    const bareDir = join(ws.root, 'bare-orders.git')
    const repoDir = join(ws.workspace, 'orders-repo')
    await mkdir(bareDir, { recursive: true, mode: 0o700 })
    await mkdir(repoDir, { recursive: true, mode: 0o700 })
    expect((await runCommandProcess('git', ['init', '--bare', bareDir])).exitCode).toBe(0)
    expect((await runCommandProcess('git', ['init'], { cwd: repoDir })).exitCode).toBe(0)
    expect((await runCommandProcess('git', ['config', 'user.email', 'e2e@example.test'], { cwd: repoDir })).exitCode).toBe(0)
    expect((await runCommandProcess('git', ['config', 'user.name', 'E2E Runner'], { cwd: repoDir })).exitCode).toBe(0)

    const buggyScript = [
      "let raw = ''",
      "process.stdin.on('data', chunk => { raw += chunk })",
      "process.stdin.on('end', () => {",
      "  const items = JSON.parse(raw || '[]')",
      '  const sums = {}',
      '  for (const item of items) { sums[item.currency] = (sums[item.currency] ?? 0) + item.amountCents }',
      '  console.log(JSON.stringify(sums))',
      '})',
    ].join('\n')
    const scriptPath = join(repoDir, 'summarize.mjs')
    await writeFile(scriptPath, buggyScript, 'utf8')
    expect((await runCommandProcess('git', ['add', 'summarize.mjs'], { cwd: repoDir })).exitCode).toBe(0)
    expect((await runCommandProcess('git', ['commit', '-m', 'initial buggy summarize'], { cwd: repoDir })).exitCode).toBe(0)
    expect((await runCommandProcess('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir })).exitCode).toBe(0)

    const runIsolatedSubprocess = getExportFn<(req: Record<string, unknown>) => Promise<{
      backend: string
      sandboxed: boolean
      status: string
      exitCode: number | null
      stdout: string
    }>>(isoMod, 'runIsolatedSubprocess')

    const vectorStdin = '[{"currency":"USD","amountCents":100},{"currency":"USD","amountCents":50,"status":"cancelled"},{"currency":"EUR","amountCents":25}]\n'
    const buggyRun = await runIsolatedSubprocess({
      command: process.execPath,
      args: [scriptPath],
      cwd: repoDir,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdin: vectorStdin,
      timeoutMs: 5_000,
      network: 'none',
    })
    expect(buggyRun.sandboxed).toBe(true)
    expect(buggyRun.stdout.trim()).not.toBe('{"EUR":25,"USD":100}')

    // Negative exit-code verification in OS sandbox
    const failRun = await runIsolatedSubprocess({
      command: process.execPath,
      args: ['-e', 'process.exit(19)'],
      cwd: repoDir,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdin: '',
      timeoutMs: 5_000,
      network: 'none',
    })
    expect(failRun.sandboxed).toBe(true)
    expect(failRun.status).toBe('failed')
    expect(failRun.exitCode).toBe(19)

    // 2. Apply bugfix to summarize.mjs and verify inside linux-native OS isolation
    const fixedScript = [
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
    await writeFile(scriptPath, fixedScript, 'utf8')
    const fixedRun = await runIsolatedSubprocess({
      command: process.execPath,
      args: [scriptPath],
      cwd: repoDir,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdin: vectorStdin,
      timeoutMs: 5_000,
      network: 'none',
    })
    expect(fixedRun.sandboxed).toBe(true)
    expect(fixedRun.status).toBe('succeeded')
    expect(fixedRun.exitCode).toBe(0)
    expect(fixedRun.stdout.trim()).toBe('{"EUR":25,"USD":100}')

    // Validate cross-platform isolation config readiness alongside Linux run
    expect(isoCfgMod.validateConfig({
      backend: 'macos-seatbelt',
      stateRoot: join(ws.stateDir, 'mac'),
      macos: { readOnlyRoots: ['/opt/homebrew/Cellar/node/24.0.0'], sandboxExecPath: '/usr/bin/sandbox-exec' },
    } as never, { platform: 'darwin', uid: 501, allowHostPaths: true }).backend).toBe('macos-seatbelt')

    // 3. Provision WP18 repo-verified-delivery-fixture + AssistantActionsService commit -> PR -> inspect + observer gating
    const patchPath = join(ws.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(dirname(patchPath), { recursive: true, mode: 0o700 })
    await writeFile(patchPath, `- id: dsh-enhanced-assistant-isolation\n  name: "@dsh-enhanced/assistant-isolation"\n  config:\n    grants:\n      - id: repo\n        expiresAt: ${Date.now() + 600_000}\n`, { mode: 0o600 })

    const prevEventSource = process.env.DSH_REPO_EVENT_SOURCE
    const prevLog = process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
    const prevState = process.env.DSH_REPO_EVENT_STATE
    const prevMode = process.env.DSH_REPO_DELIVERY_MODE
    const prevObsLog = process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
    const prevNoModel = process.env.DSH_REPO_AUTONOMY_NO_MODEL
    const fixtureEnv: Record<string, string> = {}
    const observerLog = join(ws.stateDir, 'observer.jsonl')
    process.env.DSH_REPO_EVENT_SOURCE = 'fixture'
    process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG = observerLog
    process.env.DSH_REPO_AUTONOMY_NO_MODEL = '1'

    try {
      const provisioned = await fixtureMod.prepareRepositoryFixture(ws.dshHome, patchPath, fixtureEnv)
      expect(provisioned.credentialHandle).toBe('repo-fixture')
      expect((await stat(join(ws.dshHome, 'repo-fixture-secrets', 'github'))).mode & 0o077).toBe(0)

      process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = fixtureEnv.DSH_REPO_DELIVERY_FIXTURE_LOG
      process.env.DSH_REPO_EVENT_STATE = fixtureEnv.DSH_REPO_EVENT_STATE
      delete process.env.DSH_REPO_DELIVERY_MODE

      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'agents', { currentInitiator: () => undefined })
      const actions = await harness.mountService<{
        commit: (input: Record<string, unknown>) => Promise<{ status: string; commitOid: string }>
        workflow: {
          pullRequest: (input: Record<string, unknown>) => Promise<{ pullRequestNumber: number }>
          inspect: (input: Record<string, unknown>) => Promise<{ observed: unknown }>
        }
      }>(ctx, AssistantActionsService, 'assistantActions', { stateRoot: join(ws.stateDir, 'actions') })
      await harness.mountPlugin(ctx, fixtureMod)
      await harness.mountPlugin(ctx, observerMod)

      // Observer gates llm/stream under DSH_REPO_AUTONOMY_NO_MODEL=1
      const blockedStream = (ctx as unknown as {
        waterfall: (thisArg: unknown, event: string, options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
      }).waterfall(ctx, 'llm/stream', { system: '', messages: [], tools: [] }, async function* () {})
      await expect((async () => {
        for await (const _chunk of blockedStream) {
          // unreachable
        }
      })()).rejects.toThrow(/model requests are forbidden/u)
      expect(await readFile(observerLog, 'utf8')).toContain('"event":"model-blocked"')

      const secretFile = join(ws.stateDir, 'live-gh-secret')
      await writeFile(secretFile, 'fixture-token-placeholder\n', { mode: 0o600 })
      const commitDescriptorPath = join(ws.stateDir, 'live-commit.json')
      const now = Date.now()
      await writeFile(commitDescriptorPath, JSON.stringify({
        version: 3,
        deliveryMode: 'commit',
        repository: 'fixture/orders',
        baseBranch: 'main',
        temporaryBranch: 'automation/fix-commit',
        paths: ['summarize.mjs'],
        credentialHandle: 'live-gh-handle',
        credential: {
          id: 'live-gh-handle',
          provider: 'linux-protected-file',
          consumers: ['dsh-enhanced-assistant-actions', 'dsh-enhanced-event-triggers'],
          purposes: ['github.commit', 'github.observe'],
          maxLeaseMs: 60_000,
          reference: { path: secretFile },
        },
        expiresAt: now + 450_000,
        maxActions: 40,
        maxTotalBytes: 1_048_576,
        requiredChecks: [{ name: 'tests', appId: 7 }],
        event: { maxPolls: 20, maxFires: 4, pollIntervalMs: 2_000, requestTimeoutMs: 10_000 },
      }), { mode: 0o600 })
      const liveDesc = await loadLiveRepositoryInput(commitDescriptorPath, now)
      expect(liveDesc.repositoryDelivery.openPullRequest).toBe(false)
      expect(liveDesc.repositoryDelivery.paths).toEqual(['summarize.mjs'])

      const signal = new AbortController().signal
      const commitRes = await actions.commit({
        actionId: 'act-s7-commit',
        signal,
        request: { expectedHeadOid: '1'.repeat(40), files: [{ path: 'summarize.mjs', content: fixedScript }] },
      })
      expect(commitRes.status).toBe('succeeded')
      expect(commitRes.commitOid).toMatch(/^[a-f0-9]{40}$/u)

      const prRes = await actions.workflow.pullRequest({ actionId: 'act-s7-pr', signal, expectedHeadOid: commitRes.commitOid })
      expect(prRes.pullRequestNumber).toBe(17)
      expect(fixtureMod.repositoryFixtureSnapshot().ready).toBe(false)
      expect(fixtureMod.repositoryFixtureSnapshot().checks[0]?.status).toBe('in_progress')

      await writeFile(fixtureEnv.DSH_REPO_EVENT_STATE!, '{"ready":true}', { mode: 0o600 })
      const inspected = await actions.workflow.inspect({ signal, kind: 'pull-request', grant: { repository: 'fixture/orders', branch: 'automation/fix' } })
      expect(inspected.observed).toMatchObject({ number: 17, state: 'open' })
      expect(fixtureMod.repositoryFixtureSnapshot().checks[0]?.conclusion).toBe('success')
      expect(fixtureMod.repositoryFixtureSnapshot().reviews[0]?.state).toBe('APPROVED')

      const logContent = await readFile(fixtureEnv.DSH_REPO_DELIVERY_FIXTURE_LOG!, 'utf8')
      expectNoSecretLeak(logContent, ['ghp_', 'sk-', 'non-production-github-fixture'])
      expect(logContent.trim().split('\n').map(l => (JSON.parse(l) as { kind: string }).kind)).toEqual(['commit', 'pr'])

      // Capture verified bugfix as a workflow skill definition via buildWorkflowSourceForTemplate + buildWorkflowSkillDefinition
      const buildSource = getExportFn<(
        tpl: string,
        scope: Record<string, unknown>,
      ) => Record<string, unknown>>(skillsMod, 'buildWorkflowSourceForTemplate')
      const buildDef = getExportFn<(
        tpl: string,
        source: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => { name: string; workflowFamily: string; compensation: string }>(skillsMod, 'buildWorkflowSkillDefinition')
      const verifiedSource = buildSource('repo-ci-fix', {
        principalId: 'owner-s7',
        principalRecordId: 'owner-rec-s7',
        principalVersion: 1,
        workspace: repoDir,
        preset: 'primary',
      })
      const capturedSkill = buildDef('repo-ci-fix', verifiedSource, { name: 'summarize-bugfix-ci' })
      expect(capturedSkill.workflowFamily).toBe('repo-ci-fix')
      expect(capturedSkill.compensation).not.toBe('stop-and-report')
    } finally {
      if (prevEventSource === undefined) delete process.env.DSH_REPO_EVENT_SOURCE
      else process.env.DSH_REPO_EVENT_SOURCE = prevEventSource
      if (prevLog === undefined) delete process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
      else process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = prevLog
      if (prevState === undefined) delete process.env.DSH_REPO_EVENT_STATE
      else process.env.DSH_REPO_EVENT_STATE = prevState
      if (prevMode === undefined) delete process.env.DSH_REPO_DELIVERY_MODE
      else process.env.DSH_REPO_DELIVERY_MODE = prevMode
      if (prevObsLog === undefined) delete process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
      else process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG = prevObsLog
      if (prevNoModel === undefined) delete process.env.DSH_REPO_AUTONOMY_NO_MODEL
      else process.env.DSH_REPO_AUTONOMY_NO_MODEL = prevNoModel
    }
  })
})
