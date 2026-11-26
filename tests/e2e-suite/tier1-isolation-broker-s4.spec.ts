import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { expectNoSecretLeak, getExportFn, sha256Hex } from './helpers/assertions.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantActions,
  loadAssistantActionsBroker,
  loadAssistantActionsHttpGuard,
  loadAssistantAssociation,
  loadAssistantIsolation,
  loadAssistantIsolationConfig,
  loadAssistantPolicy,
  loadPackageModule,
  loadRepoAutonomyFixture,
  loadRepoAutonomyObserver,
  loadRepoExternalDeliveryFixture,
  loadRepoLiveInput,
} from './helpers/packages.ts'
import { createWorkspaceTracker, repoRoot } from './helpers/workspace.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

async function buildLinuxRuntimeFixture(root: string) {
  const { hashLinuxRuntimeTree } = (await loadPackageModule('assistant-isolation/linux-runtime')) as {
    hashLinuxRuntimeTree: (dir: string) => Promise<string>
  }
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot, { recursive: true, mode: 0o755 })
  const writeAsset = async (rel: string, content: string, mode = 0o444) => {
    const dest = join(runtimeRoot, rel)
    await mkdir(dirname(dest), { recursive: true, mode: 0o755 })
    await writeFile(dest, content, { mode })
  }
  await mkdir(join(runtimeRoot, 'bin'), { recursive: true, mode: 0o755 })
  const hostNode = process.execPath
  await copyFile(hostNode, join(runtimeRoot, 'bin/node'))
  await chmod(join(runtimeRoot, 'bin/node'), 0o555)
  await writeAsset('pnpm/bin/pnpm.mjs', 'console.log("11.7.0")\n')
  await writeAsset('pnpm-native/pnpm', '#!/bin/sh\nprintf "11.7.0\\n"\n', 0o555)
  await copyFile(hostNode, join(runtimeRoot, 'pnpm-native/node'))
  await chmod(join(runtimeRoot, 'pnpm-native/node'), 0o555)
  await writeAsset('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await writeAsset('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  for (const [name, version] of Object.entries({
    typescript: '6.0.3',
    '@deepseek-ai/cordis': '4.0.5',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
    '@deepseek-ai/dsh-system-prompt': '0.2.1-rc.2',
  })) {
    await writeAsset(`node_modules/${name}/package.json`, JSON.stringify({ version }))
  }
  for (const dirName of ['store', 'cache']) {
    await mkdir(join(runtimeRoot, dirName), { recursive: true, mode: 0o755 })
  }
  await chmod(runtimeRoot, 0o755)
  const info = await stat(runtimeRoot)
  const uid = process.getuid?.() ?? 1000
  const runtime = {
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
    versions: {
      node: 'v22.23.2',
      pnpm: '11.7.0',
      typescript: '6.0.3',
      cordis: '4.0.5',
      tools: '0.2.1-rc.2',
      systemPrompt: '0.2.1-rc.2',
    },
  }
  const cgroupRoots = {
    mode: 'v1' as const,
    cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`,
    pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}`,
  }
  return { runtime, cgroupRoots }
}

function makeStubIsolationAgent(sessionId: string, cwd: string) {
  return {
    id: sessionId,
    options: {},
    session: {
      id: sessionId,
      header: { id: sessionId, cwd, agentPreset: 'primary' },
    },
    ctx: {
      tools: {
        restrict: () => () => {},
      },
    },
    status: 'idle',
  }
}

describe('Tier 1 — F08–F11: Isolation, Broker, S4 Web Learning & Sandbox Repo E2E', () => {
  describe('F08: WP09 cross-platform isolation (auto, linux-native, macos-seatbelt, windows-job)', () => {
    test('T1-F08-01: Config accepts backend auto and resolves current OS backend', async () => {
      const ws = await workspaces.create('f08-auto-')
      const cfgMod = await loadAssistantIsolationConfig()
      const { runtime, cgroupRoots } = await buildLinuxRuntimeFixture(ws.root)
      const validated = cfgMod.validateConfig({
        backend: 'auto',
        stateRoot: join(ws.stateDir, 'isolation'),
        linux: { runtime, cgroupRoots },
      } as never)

      if (process.platform === 'linux') {
        expect(validated.backend).toBe('linux-native')
      } else {
        expect(['macos-seatbelt', 'windows-job', 'linux-native']).toContain(validated.backend)
      }
    })

    test('T1-F08-02: Config and runtime support backend macos-seatbelt', async () => {
      const ws = await workspaces.create('f08-mac-')
      const cfgMod = await loadAssistantIsolationConfig()
      const isoMod = await loadAssistantIsolation()

      const validated = cfgMod.validateConfig({
        backend: 'macos-seatbelt',
        stateRoot: join(ws.stateDir, 'mac-iso'),
        macos: {
          readOnlyRoots: ['/opt/homebrew/Cellar/node/24.0.0'],
          sandboxExecPath: '/usr/bin/sandbox-exec',
        },
      } as never, { platform: 'darwin', uid: 501, allowHostPaths: true })

      expect(validated.backend).toBe('macos-seatbelt')
      expect(isoMod.NativeMacVerifierRunner).toBeDefined()
      expect(isoMod.runMacosSeatbeltCommand).toBeTypeOf('function')
      expect(isoMod.buildMacosSeatbeltCommandProfile).toBeTypeOf('function')
    })

    test('T1-F08-03: Config and Windows Job exports support backend windows-job', async () => {
      const ws = await workspaces.create('f08-win-')
      const cfgMod = await loadAssistantIsolationConfig()
      const isoMod = await loadAssistantIsolation()

      const validated = cfgMod.validateConfig({
        backend: 'windows-job',
        stateRoot: 'C:\\Users\\alice\\.dsh\\win-iso',
        windows: {
          powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          shell: 'powershell',
        },
      } as never, { platform: 'win32' })

      expect(validated.backend).toBe('windows-job')
      expect(isoMod.runWindowsJobProcess).toBeTypeOf('function')
      expect(isoMod.buildWindowsJobSpec).toBeTypeOf('function')
      expect(isoMod.IsolatedVerifierRunner).toBeTypeOf('function')
      expect(ws.stateDir).toBeTruthy()
    })

    test('T1-F08-04: AssistantIsolationService executes job under backend auto with grant', async () => {
      const ws = await workspaces.create('f08-run-')
      const isoMod = await loadAssistantIsolation()
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const AssistantIsolationService = getExportFn<new (
        ctx: unknown,
        cfg: unknown,
        options?: Record<string, unknown>,
      ) => {
        ready: Promise<void>
        run: (agent: unknown, req: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>
      }>(isoMod, 'AssistantIsolationService')

      const ctx = harness.createContext()
      const agent = makeStubIsolationAgent('sess-f08-run', ws.workspace)
      harness.provideMockService(ctx, 'agents', {
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
        rules: [
          {
            id: 'allow-iso',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'isolation:grant-1' },
            context: { initiators: ['foreground'] },
          },
        ],
      })

      const svc = new AssistantIsolationService(ctx, {
        backend: 'auto',
        stateRoot: join(ws.stateDir, 'iso-run'),
        limits: { maxDurationMs: 5_000, maxOutputBytes: 4_096 },
        grants: [{
          id: 'grant-1',
          revision: 1,
          principalDigest: isoMod.isolationPrincipalDigest('web/a/t/u'),
          principalRecordId: 'rec-1',
          principalVersion: 1,
          workspace: ws.workspace,
          agentPreset: 'primary',
          expiresAt: Date.now() + 60_000,
          maxRuns: 3,
          maxTotalDurationMs: 30_000,
        }],
      }, {
        platform: 'darwin',
        uid: 501,
        allowHostPaths: true,
        macosAdapter: {
          platform: 'darwin',
          uid: 501,
          verifySandboxExec: async () => true,
          runCommand: async () => ({
            status: 'succeeded',
            quiescent: true,
            exitCode: 0,
            stdout: 'isolated-ok\n',
            stderr: '',
            artifacts: [],
          }),
        },
      })
      await svc.ready

      const res = await svc.run(agent, {
        grantId: 'grant-1',
        idempotencyKey: 'idem-1',
        command: 'echo isolated-ok',
      }, new AbortController().signal)
      expect(res.status).toBe('succeeded')
      expect(res.quiescent).toBe(true)
      expect(String(res.stdout ?? '')).toContain('isolated-ok')
    })

    test('T1-F08-05: replay idempotency returns same jobId without consuming grant.maxRuns', async () => {
      const ws = await workspaces.create('f08-replay-')
      const isoMod = await loadAssistantIsolation()
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const AssistantIsolationService = getExportFn<new (
        ctx: unknown,
        cfg: unknown,
        options?: Record<string, unknown>,
      ) => {
        ready: Promise<void>
        run: (agent: unknown, req: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>
      }>(isoMod, 'AssistantIsolationService')

      const ctx = harness.createContext()
      const agent = makeStubIsolationAgent('sess-f08-replay', ws.workspace)
      harness.provideMockService(ctx, 'agents', {
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
        rules: [
          {
            id: 'allow-iso',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'isolation:grant-1' },
            context: { initiators: ['foreground'] },
          },
        ],
      })

      let invocations = 0
      const svc = new AssistantIsolationService(ctx, {
        backend: 'auto',
        stateRoot: join(ws.stateDir, 'iso-replay'),
        limits: { maxDurationMs: 5_000, maxOutputBytes: 4_096 },
        grants: [{
          id: 'grant-1',
          revision: 1,
          principalDigest: isoMod.isolationPrincipalDigest('web/a/t/u'),
          principalRecordId: 'rec-1',
          principalVersion: 1,
          workspace: ws.workspace,
          agentPreset: 'primary',
          expiresAt: Date.now() + 60_000,
          maxRuns: 1,
          maxTotalDurationMs: 30_000,
        }],
      }, {
        platform: 'darwin',
        uid: 501,
        allowHostPaths: true,
        macosAdapter: {
          platform: 'darwin',
          uid: 501,
          verifySandboxExec: async () => true,
          runCommand: async () => {
            invocations += 1
            return { status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'once\n', stderr: '', artifacts: [] }
          },
        },
      })
      await svc.ready

      const req = { grantId: 'grant-1', idempotencyKey: 'same-key', command: 'true' }
      const first = await svc.run(agent, req, new AbortController().signal)
      const second = await svc.run(agent, req, new AbortController().signal)
      expect(first.jobId).toBeDefined()
      expect(second.jobId).toBe(first.jobId)
      expect(invocations).toBe(1)
    })
  })

  describe('F09: WP09 S4 Web Learning OS sandbox & S3/S4 default-on', () => {
    test('T1-F09-01: assistant-association normalizeAssociationConfig enables S3 dreaming/intakeSignal and S4 webLearning by default', async () => {
      const ws = await workspaces.create('f09-defaults-')
      const assoc = await loadAssistantAssociation()
      const normalized = assoc.normalizeAssociationConfig({ databasePath: ws.sqlitePath('assoc') })
      expect(normalized.enabled).toBe(true)
      expect(normalized.dreaming.enabled).toBe(true)
      expect(normalized.intakeSignal.enabled).toBe(true)
      expect(normalized.webLearning.enabled).toBe(true)
    })

    test('T1-F09-02: S4 web-learning runner routes execution through OS-level isolation sandbox', async () => {
      const ws = await workspaces.create('f09-sandbox-')
      const assoc = await loadAssistantAssociation()
      const createSandboxed = getExportFn<(opts?: {
        tempBaseDir?: string
        sourceEnv?: NodeJS.ProcessEnv
        isolatedRunner?: (req: {
          args: readonly string[]
          env: Readonly<Record<string, string | undefined>>
          network: string
          writablePaths?: readonly string[]
          stdin: string
        }) => Promise<{
          backend: string
          sandboxed: boolean
          status: string
          exitCode: number | null
          processSignal: NodeJS.Signals | null
          stdout: string
          stderr: string
          truncated?: boolean
          durationMs?: number
        }>
      }) => {
        run: (input: unknown) => Promise<{
          runId: string
          status: string
          pagesFetched: number
          pages: readonly { title?: string }[]
          environmentProof?: { cwd?: string }
        }>
      }>(assoc, 'createSandboxedWebLearningRunner')

      const expectedOutput = {
        runId: 't1-f09-02',
        status: 'completed',
        reason: 'ok',
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_000_010,
        requestsUsed: 1,
        pagesFetched: 1,
        bytesFetched: 128,
        pages: [{
          sourceUrl: 'https://docs.example.test/guide',
          finalUrl: 'https://docs.example.test/guide',
          fetchedAt: 1_700_000_000_005,
          title: 'Cordis Guide',
          text: 'Cordis plugin lifecycle guide.',
          contentType: 'text/html',
          contentDigest: sha256Hex('cordis-guide'),
          bytesFetched: 128,
          interestKey: 'cordis',
          originNodeIds: [],
          links: [],
        }],
        attempts: [{
          url: 'https://docs.example.test/guide',
          finalUrl: 'https://docs.example.test/guide',
          interestKey: 'cordis',
          ok: true,
          status: 200,
          bytesFetched: 128,
          requestsUsed: 1,
          fetchedAt: 1_700_000_000_005,
        }],
        environmentProof: { pid: process.pid, cwd: ws.workspace, envKeys: ['PATH'] },
      }

      let isolationCalled = false
      const runner = createSandboxed({
        tempBaseDir: ws.stateDir,
        sourceEnv: { PATH: '/usr/bin', DEEPSEEK_API_KEY: 'sk-t1-f09-secret' },
        isolatedRunner: async req => {
          isolationCalled = true
          expect(req.network).toBe('outbound-https')
          expect(req.args.some(a => a.endsWith('web-learning-worker.ts') || a.endsWith('web-learning-worker.js'))).toBe(true)
          expect(Array.isArray(req.writablePaths) && req.writablePaths.length === 1).toBe(true)
          expectNoSecretLeak(JSON.stringify(req.env), ['sk-t1-f09-secret'])
          const parsedStdin = JSON.parse(req.stdin) as { runId: string; toolSurface?: readonly string[] }
          expect(parsedStdin.runId).toBe('t1-f09-02')
          expect(parsedStdin.toolSurface).toEqual(['web_fetch_readonly'])
          return {
            backend: 'linux-native',
            sandboxed: true,
            status: 'succeeded',
            exitCode: 0,
            processSignal: null,
            stdout: JSON.stringify(expectedOutput),
            stderr: '',
            truncated: false,
            durationMs: 1,
          }
        },
      })

      const res = await runner.run({
        runId: 't1-f09-02',
        allowedDomains: ['docs.example.test'],
        targets: [{ url: 'https://docs.example.test/guide', interestKey: 'cordis' }],
        budget: {
          maxRequests: 1,
          maxPages: 1,
          maxBytesPerRequest: 8_192,
          maxTotalBytes: 8_192,
          maxDurationMs: 5_000,
          requestTimeoutMs: 2_000,
        },
        toolSurface: ['web_fetch_readonly'],
      })
      expect(isolationCalled).toBe(true)
      expect(res.runId).toBe('t1-f09-02')
      expect(res.status).toBe('completed')
      expect(res.pagesFetched).toBe(1)
      expect(res.pages[0]?.title).toBe('Cordis Guide')
      expect(res.environmentProof?.cwd).toBe(ws.workspace)
    })

    test('T1-F09-03: S4 runner executes validated fetch against loopback server while stripping secrets & blocking SSRF/write tools', async () => {
      const assoc = await loadAssistantAssociation()
      let requestsReceived = 0
      const server = createServer((req, res) => {
        requestsReceived += 1
        expect(req.method).toBe('GET')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><title>Test Note</title><body>Public documentation note on Cordis.</body></html>')
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const addr = server.address() as { port: number }
      const loopbackUrl = `http://127.0.0.1:${addr.port}/note`

      try {
        const sanitized = assoc.sanitizeWebLearningEnv({
          PATH: '/usr/bin',
          DEEPSEEK_API_KEY: 'sk-secret-must-strip',
          FEISHU_APP_SECRET: 'feishu-secret-must-strip',
          GITHUB_TOKEN: 'ghp-secret-must-strip',
        })
        expectNoSecretLeak(JSON.stringify(sanitized), ['sk-secret-must-strip', 'feishu-secret-must-strip', 'ghp-secret-must-strip'])

        expect(() => assoc.assertReadOnlyWebToolSurface([
          { name: 'fs_write', readOnly: false } as never,
        ])).toThrow()

        const runner = assoc.createInProcessWebLearningRunner({
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          fetcher: async (_url, init) => fetch(loopbackUrl, { signal: init.signal }),
        })
        const output = await runner.run({
          runId: 'run-loopback-f09-03',
          allowedDomains: ['docs.example.test'],
          targets: [{ url: 'https://docs.example.test/note', interestKey: 'cordis' }],
          budget: {
            maxRequests: 2,
            maxPages: 2,
            maxBytesPerRequest: 8_192,
            maxTotalBytes: 16_384,
            maxDurationMs: 5_000,
            requestTimeoutMs: 2_000,
          },
          toolSurface: ['web_fetch_readonly'],
        })
        expect(requestsReceived).toBe(1)
        expect(output.pagesFetched).toBe(1)
        expect(output.pages[0]?.title).toBe('Test Note')

        // Direct unvalidated loopback IP URL must still be rejected fail-closed by SSRF checks.
        const blocked = await runner.run({
          runId: 'run-ssrf-block',
          allowedDomains: ['docs.example.test'],
          targets: [{ url: loopbackUrl, interestKey: 'cordis' }],
          budget: {
            maxRequests: 2,
            maxPages: 2,
            maxBytesPerRequest: 8_192,
            maxTotalBytes: 16_384,
            maxDurationMs: 5_000,
            requestTimeoutMs: 2_000,
          },
        })
        expect(blocked.pagesFetched).toBe(0)
        expect(requestsReceived).toBe(1)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    test('T1-F09-04: S4 learned web nodes carry low trust plus sourceUrl and fetchedAt provenance', async () => {
      const ws = await workspaces.create('f09-prov-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const assoc = await loadAssistantAssociation()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        rules: [
          {
            id: 'allow-web-learn',
            effect: 'allow',
            subject: {
              kind: 'background',
              id: 'assistant-association:web-learning',
              workspace: ws.workspace,
              principal: 'web/a/t/u',
            },
            actions: ['web.learn'],
            resource: { kind: 'network', id: 'assistant-association:web-learning' },
            context: { initiators: ['background'] },
          },
          {
            id: 'allow-agent',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['*'],
            resource: { kind: '*', id: '*' },
            context: { initiators: ['foreground'] },
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

      harness.provideMockService(ctx, 'assistantWorkItems', {
        recordIntake: (input: { source: string; sourceEventId: string }) => ({
          replayed: false,
          record: { decision: 'stored', source: input.source, sourceEventId: input.sourceEventId },
        }),
      })

      const svc = await harness.mountService<{
        store: { upsertBatch: (batch: unknown) => unknown }
        runWebLearningNow: (scope: Record<string, unknown>, opts: Record<string, unknown>) => Promise<{
          ran: boolean
          nodesWritten: number
          writtenNodeIds: readonly string[]
        }>
        listWebLearningFetches: (ownerScopeKey: string) => readonly Record<string, unknown>[]
        readById: (exec: unknown, id: string) => Record<string, unknown> | undefined
      }>(ctx, assoc.AssistantAssociationService, 'assistantAssociation', {
        databasePath: ws.sqlitePath('assoc'),
        enabled: true,
        allowLowTrust: true,
        webLearning: {
          enabled: true,
          allowedDomains: ['docs.example.test'],
          seedUrls: ['https://docs.example.test/cordis?q={query}'],
          idleMinMs: 0,
        },
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
          id: 'a:g-prov-1',
          kind: 'goal',
          sourcePlugin: 'assistant-goals',
          sourceRef: 'goal:prov-1',
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
          body: 'Investigate CordisLifecycle disposal guarantees.',
          entities: ['CordisLifecycle'],
          tokens: ['cordis', 'lifecycle', 'disposal'],
          status: 'active',
          createdAt: nowMs - 3_600_000,
          updatedAt: nowMs - 3_600_000,
        }],
        edges: [],
        derivedRefs: [],
      })

      const res = await svc.runWebLearningNow(scope, {
        nowMs,
        ignoreIdle: true,
        runner: {
          run: async () => ({
            runId: 'run-prov-1',
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
              text: 'CordisLifecycle effects clean up deterministically on fiber disposal.',
              contentType: 'text/html',
              contentDigest: sha256Hex('cordis-lifecycle'),
              bytesFetched: 128,
              interestKey: 'CordisLifecycle',
              originNodeIds: ['a:g-prov-1'],
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
      expect(res.ran).toBe(true)
      expect(res.nodesWritten).toBeGreaterThanOrEqual(1)

      const fetches = svc.listWebLearningFetches(ownerScopeKey)
      expect(fetches.length).toBeGreaterThanOrEqual(1)
      expect(fetches[0]?.canonicalUrl).toBe('https://docs.example.test/cordis')
      expect(fetches[0]?.fetchedAt).toBe(nowMs)
    })

    test('T1-F09-05: S3 dreaming & intakeSignal execute and persist runs under default-on association config', async () => {
      const ws = await workspaces.create('f09-s3-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const assoc = await loadAssistantAssociation()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        rules: [
          {
            id: 'allow-dream',
            effect: 'allow',
            subject: {
              kind: 'background',
              id: 'assistant-association:dreaming',
              workspace: ws.workspace,
              principal: 'owner-s3',
            },
            actions: ['dream.build'],
            resource: { kind: 'evolution', id: 'assistant-association:dreaming' },
            context: { initiators: ['background'] },
          },
          {
            id: 'allow-intake-signal',
            effect: 'allow',
            subject: {
              kind: 'background',
              id: 'assistant-association',
              workspace: ws.workspace,
              principal: 'owner-s3',
            },
            actions: ['intake-observe'],
            resource: { kind: 'automation', id: 'assistant-association:intake-signal' },
            context: { initiators: ['background'] },
          },
        ],
      })

      harness.provideMockService(ctx, 'assistantWorkItems', {
        recordIntake: (input: { source: string; sourceEventId: string }) => ({
          replayed: false,
          record: { decision: 'stored', source: input.source, sourceEventId: input.sourceEventId },
        }),
      })

      const svc = await harness.mountService<{
        store: { upsertBatch: (batch: unknown) => unknown }
        runDreamingNow: (scope: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ ran: boolean; runId: string | null }>
        listDreamRuns: (ownerScopeKey: string) => readonly unknown[]
        emitIntakeSignalNow: (input: Record<string, unknown>) => { emitted: boolean }
        listIntakeSignals: (ownerScopeKey: string) => readonly Record<string, unknown>[]
      }>(ctx, assoc.AssistantAssociationService, 'assistantAssociation', {
        databasePath: ws.sqlitePath('assoc'),
        enabled: true,
        allowHeadlessScope: true,
        allowLowTrust: true,
        dreaming: { enabled: true, intervalMs: 1_000, idleMinMs: 10_000, maxPairsPerRun: 8 },
        intakeSignal: { enabled: true, minScore: 0.5 },
      })

      const principalDigest = assoc.computePrincipalDigest('owner-s3')
      const ownerScopeKey = assoc.computeOwnerScopeKey({
        mode: 'headless',
        principalDigest,
        principalRecordId: null,
        principalVersion: null,
        workspace: ws.workspace,
        agentPreset: 'primary',
      })
      const scope = {
        mode: 'headless' as const,
        ownerScopeKey,
        principalId: 'owner-s3',
        principalDigest,
        principalRecordId: null,
        principalVersion: null,
        workspace: ws.workspace,
        agentPreset: 'primary',
      }
      const nowMs = 1_700_000_000_000
      const baseNode = {
        sourcePlugin: 'personal-memory',
        ownerScopeKey,
        ownerMode: 'headless',
        principalDigest,
        principalRecordId: null,
        principalVersion: null,
        scopeMode: 'workspace',
        workspace: ws.workspace,
        agentPreset: 'primary',
        trust: 'trusted',
        sensitivity: 'private',
        entities: ['PostgresReplica', 'VacuumTuning'],
        tokens: ['postgres', 'replica', 'vacuum', 'tuning'],
        status: 'active',
        createdAt: nowMs - 7_200_000,
        updatedAt: nowMs - 7_200_000,
      }
      svc.store.upsertBatch({
        nodes: [
          { ...baseNode, id: 'm:s3-1', kind: 'memory', sourceRef: 'mem:1', sourceVersion: 1, title: 'PostgresReplica lag', body: 'PostgresReplica lag correlates with VacuumTuning.' },
          { ...baseNode, id: 'm:s3-2', kind: 'memory', sourceRef: 'mem:2', sourceVersion: 1, title: 'VacuumTuning guide', body: 'VacuumTuning reduces PostgresReplica bloat.' },
        ],
        edges: [],
        derivedRefs: [],
      })

      const dreamRes = await svc.runDreamingNow(scope, {
        nowMs,
        lastActivityAt: nowMs - 3_600_000,
        hasRunningAgent: false,
      })
      expect(dreamRes.ran).toBe(true)
      expect(svc.listDreamRuns(ownerScopeKey).length).toBeGreaterThanOrEqual(1)

      const signalRes = svc.emitIntakeSignalNow({
        scope,
        goalNode: {
          id: 'g:s3-1',
          kind: 'goal',
          title: 'Investigate replica lag',
          ownerScopeKey,
          sensitivity: 'private',
          status: 'active',
        },
        targetNode: {
          id: 'm:s3-1',
          kind: 'memory',
          title: 'PostgresReplica lag',
          ownerScopeKey,
          sensitivity: 'private',
          status: 'active',
        },
        score: 0.9,
        reason: 'strong-entity-match',
        inHoldout: false,
        nowMs,
      })
      expect(signalRes.emitted).toBe(true)
      expect(svc.listIntakeSignals(ownerScopeKey).length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('F10: WP09 external action Broker expansion (HTTP, Lark, Calendar, Shell + macOS/Windows)', () => {
    test('T1-F10-01: broker validates and executes HTTP action envelope against local test server', async () => {
      const ws = await workspaces.create('f10-http-')
      const brokerMod = await loadAssistantActionsBroker()
      const httpGuard = await loadAssistantActionsHttpGuard()
      let requestsReceived = 0
      const server = createServer((req, res) => {
        requestsReceived += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }))
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const addr = server.address() as { port: number }

      try {
        const validateReq = getExportFn<(req: unknown) => Record<string, unknown>>(brokerMod, 'validateBrokerActionRequest')
        const req = validateReq({
          kind: 'http',
          operation: 'fetch',
          destination: `http://127.0.0.1:${addr.port}/api/health`,
          method: 'GET',
          grantId: 'grant-http-1',
          idempotencyKey: 'http-idem-1',
          workspace: ws.workspace,
        })
        expect(req.kind).toBe('http')

        const execHttp = getExportFn<(input: Record<string, unknown>) => Promise<{
          statusCode: number
          body: string
          untrusted: boolean
        }>>(httpGuard, 'executeHttpGuardedAction')
        const result = await execHttp({
          grantDestination: {
            classification: 'http-endpoint',
            allowedSchemes: ['http'],
            allowedHosts: ['127.0.0.1'],
            allowedPorts: [addr.port],
            allowedMethods: ['GET'],
            allowedPathPrefixes: ['/api'],
            allowRedirects: false,
            allowPrivateNetwork: true,
            maxResponseBytes: 4_096,
          },
          requestDestination: {
            classification: 'http-endpoint',
            scheme: 'http',
            host: '127.0.0.1',
            port: addr.port,
            path: '/api/health',
          },
          payload: {
            method: 'GET',
            url: `http://127.0.0.1:${addr.port}/api/health`,
          },
          timeoutMs: 2_000,
          signal: new AbortController().signal,
        })
        expect(requestsReceived).toBe(1)
        expect(result.statusCode).toBe(200)
        expect(JSON.parse(result.body)).toEqual({ ok: true, method: 'GET', path: '/api/health' })
        expect(result.untrusted).toBe(true)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    test('T1-F10-02: broker supports lark action envelope and validates structure', async () => {
      const brokerMod = await loadAssistantActionsBroker()
      const validateReq = getExportFn<(req: unknown) => Record<string, unknown>>(brokerMod, 'validateBrokerActionRequest')
      const req = validateReq({
        kind: 'lark',
        operation: 'send-message',
        chatId: 'oc_123456',
        text: 'Build succeeded',
        grantId: 'grant-lark-1',
        idempotencyKey: 'lark-idem-1',
      })
      expect(req.kind).toBe('lark')
      expect(req.operation).toBe('send-message')
    })

    test('T1-F10-03: broker supports calendar action envelope', async () => {
      const brokerMod = await loadAssistantActionsBroker()
      const validateReq = getExportFn<(req: unknown) => Record<string, unknown>>(brokerMod, 'validateBrokerActionRequest')
      const req = validateReq({
        kind: 'calendar',
        operation: 'list-events',
        calendarId: 'cal-primary',
        startTime: 1_700_000_000,
        endTime: 1_700_086_400,
        grantId: 'grant-cal-1',
        idempotencyKey: 'cal-idem-1',
      })
      expect(req.kind).toBe('calendar')
      expect(req.calendarId).toBe('cal-primary')
    })

    test('T1-F10-04: broker supports shell action envelope under workspace allowlist', async () => {
      const ws = await workspaces.create('f10-shell-')
      const brokerMod = await loadAssistantActionsBroker()
      const validateReq = getExportFn<(req: unknown) => Record<string, unknown>>(brokerMod, 'validateBrokerActionRequest')
      const req = validateReq({
        kind: 'shell',
        operation: 'exec',
        command: ['/bin/echo', 'hello'],
        cwd: ws.workspace,
        grantId: 'grant-shell-1',
        idempotencyKey: 'shell-idem-1',
      })
      expect(req.kind).toBe('shell')
      expect(req.cwd).toBe(ws.workspace)
    })

    test('T1-F10-05: BrokerConfig accepts macOS LOCAL_PEERCRED and Windows named-pipe transports', async () => {
      const ws = await workspaces.create('f10-xplat-')
      const actionsMod = await loadAssistantActions()

      const macCfg = actionsMod.validateActionConfig({
        stateRoot: join(ws.stateDir, 'mac-actions'),
        broker: {
          mode: 'external-macos-v1',
          actionSocketPath: join(ws.stateDir, 'broker.sock'),
          brokerId: 'broker-mac',
          brokerPublicKeyPath: join(ws.stateDir, 'broker.pub'),
          clientKeyId: 'client-1',
          clientSigningKeyPath: join(ws.stateDir, 'client.key'),
          clientInstanceId: 'inst-1',
          clientGeneration: 1,
          expectedBrokerPeerUid: 501,
          expectedBrokerPeerGid: 20,
        },
      } as never)

      const winCfg = actionsMod.validateActionConfig({
        stateRoot: join(ws.stateDir, 'win-actions'),
        broker: {
          mode: 'external-windows-v1',
          pipeName: '\\\\.\\pipe\\dsh-broker-test',
          brokerId: 'broker-win',
          brokerPublicKeyPath: join(ws.stateDir, 'broker.pub'),
          clientKeyId: 'client-1',
          clientSigningKeyPath: join(ws.stateDir, 'client.key'),
          clientInstanceId: 'inst-1',
          clientGeneration: 1,
          expectedUserSid: 'S-1-5-21-1000',
        },
      } as never)

      expect(macCfg.broker.mode).toBe('external-macos-v1')
      expect(winCfg.broker.mode).toBe('external-windows-v1')
    })
  })

  describe('F11: WP18 standalone sandbox repo E2E loop', () => {
    test('T1-F11-01: WP18 loadLiveRepositoryInput & mergeLiveCredentialHandles validate v2 PR and v3 commit descriptors', async () => {
      const ws = await workspaces.create('f11-live-input-')
      const { loadLiveRepositoryInput, mergeLiveCredentialHandles } = (await loadRepoLiveInput()) as {
        loadLiveRepositoryInput: (path: string, now?: number) => Promise<{
          credential: Record<string, unknown>
          repositoryDelivery: Record<string, unknown>
        }>
        mergeLiveCredentialHandles: (current: readonly unknown[], live: { credential: { id: string } }) => unknown[]
      }

      const secretFile = join(ws.stateDir, 'gh-token')
      await writeFile(secretFile, 'ghp_fixture_only', { mode: 0o600 })
      const now = Date.now()
      const prDescriptorPath = join(ws.stateDir, 'live-pr.json')
      await writeFile(prDescriptorPath, JSON.stringify({
        version: 2,
        repository: 'org/orders-repo',
        baseBranch: 'main',
        temporaryBranch: 'automation/fix-summarize',
        paths: ['summarize.mjs'],
        credentialHandle: 'live-gh-handle',
        credential: {
          id: 'live-gh-handle',
          provider: 'linux-protected-file',
          consumers: ['dsh-ray-assistant-actions', 'dsh-ray-event-triggers'],
          purposes: ['github.commit', 'github.observe'],
          maxLeaseMs: 60_000,
          reference: { path: secretFile },
        },
        expiresAt: now + 450_000,
        maxActions: 80,
        maxTotalBytes: 1_048_576,
        requiredChecks: [{ name: 'tests', appId: 7 }],
        reviewerIds: [42],
        minApprovals: 1,
        event: { maxPolls: 20, maxFires: 4, pollIntervalMs: 2_000, requestTimeoutMs: 10_000 },
      }), { mode: 0o600 })

      const loadedPr = await loadLiveRepositoryInput(prDescriptorPath, now)
      expect(loadedPr.repositoryDelivery).toMatchObject({
        repository: 'org/orders-repo',
        baseBranch: 'main',
        branch: 'automation/fix-summarize',
        paths: ['summarize.mjs'],
        openPullRequest: true,
      })
      const merged = mergeLiveCredentialHandles([{ id: 'existing-handle' }], loadedPr)
      expect(merged.map(h => (h as { id: string }).id)).toEqual(['existing-handle', 'live-gh-handle'])
      expect(() => mergeLiveCredentialHandles([{ id: 'live-gh-handle' }], loadedPr)).toThrow(/conflicts/)

      const commitDescriptorPath = join(ws.stateDir, 'live-commit.json')
      await writeFile(commitDescriptorPath, JSON.stringify({
        version: 3,
        deliveryMode: 'commit',
        repository: 'org/orders-repo',
        baseBranch: 'main',
        temporaryBranch: 'automation/fix-commit',
        paths: ['summarize.mjs'],
        credentialHandle: 'live-gh-handle',
        credential: {
          id: 'live-gh-handle',
          provider: 'linux-protected-file',
          consumers: ['dsh-ray-assistant-actions', 'dsh-ray-event-triggers'],
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
      const loadedCommit = await loadLiveRepositoryInput(commitDescriptorPath, now)
      expect(loadedCommit.repositoryDelivery).toMatchObject({ openPullRequest: false })
    })

    test('T1-F11-02: WP18 prepareRepositoryFixture provisions private credential handle, patch row, and outcome config', async () => {
      const ws = await workspaces.create('f11-prepare-')
      const { prepareRepositoryFixture } = (await loadRepoAutonomyFixture()) as {
        prepareRepositoryFixture: (home: string, patchPath: string, env: Record<string, string>) => Promise<Record<string, unknown>>
      }

      const patchPath = join(ws.dshHome, 'profiles', 'web', 'cordis.patch.yml')
      await mkdir(dirname(patchPath), { recursive: true, mode: 0o700 })
      const expiresAt = Date.now() + 600_000
      await writeFile(patchPath, [
        '- id: dsh-ray-assistant-isolation',
        '  name: "@dsh-ray/assistant-isolation"',
        '  config:',
        '    grants:',
        '      - id: repo',
        `        expiresAt: ${expiresAt}`,
      ].join('\n'), { mode: 0o600 })

      const env: Record<string, string> = {}
      const prevEventSource = process.env.DSH_REPO_EVENT_SOURCE
      process.env.DSH_REPO_EVENT_SOURCE = 'fixture'
      try {
        const delivery = await prepareRepositoryFixture(ws.dshHome, patchPath, env)
        expect(delivery).toMatchObject({
          repository: 'fixture/orders',
          baseBranch: 'main',
          branch: 'automation/fix',
          paths: ['summarize.mjs'],
          credentialHandle: 'repo-fixture',
          openPullRequest: true,
        })
        expect(env.DSH_REPO_DELIVERY_FIXTURE_LOG).toBe(join(ws.dshHome, 'github-fixture.jsonl'))
        expect(env.DSH_REPO_EVENT_STATE).toBe(join(ws.dshHome, 'repository-event-fixture.json'))

        const secretStat = await stat(join(ws.dshHome, 'repo-fixture-secrets', 'github'))
        expect(secretStat.mode & 0o077).toBe(0)
        const updatedPatch = await readFile(patchPath, 'utf8')
        expect(updatedPatch).toContain('repo-fixture')
        expect(updatedPatch).toContain('dsh-ray-credentials-keychain')
      } finally {
        if (prevEventSource === undefined) delete process.env.DSH_REPO_EVENT_SOURCE
        else process.env.DSH_REPO_EVENT_SOURCE = prevEventSource
      }
    })

    test('T1-F11-03: WP18 repo-verified-delivery-fixture mounts onto AssistantActionsService and drives commit + PR + checks snapshot', async () => {
      const ws = await workspaces.create('f11-transport-')
      const { AssistantActionsService } = await loadAssistantActions()
      const fixtureMod = (await loadRepoAutonomyFixture()) as {
        apply: (ctx: unknown) => void
        inject: readonly string[]
        repositoryFixtureSnapshot: () => {
          ready: boolean
          headOid: string
          pullRequest: { number: number; state: string } | null
          checks: readonly { status: string; conclusion: string | null }[]
          reviews: readonly { state: string }[]
        }
      }

      const logPath = join(ws.stateDir, 'github-fixture.jsonl')
      const eventStatePath = join(ws.stateDir, 'repository-event-fixture.json')
      await writeFile(eventStatePath, '{"ready":false}', { mode: 0o600 })

      const prevLog = process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
      const prevState = process.env.DSH_REPO_EVENT_STATE
      const prevMode = process.env.DSH_REPO_DELIVERY_MODE
      process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = logPath
      process.env.DSH_REPO_EVENT_STATE = eventStatePath
      delete process.env.DSH_REPO_DELIVERY_MODE

      try {
        const ctx = harness.createContext()
        const actions = await harness.mountService<{
          commit: (input: Record<string, unknown>) => Promise<{ status: string; commitOid: string }>
          workflow: {
            pullRequest: (input: Record<string, unknown>) => Promise<{ status: string; pullRequestNumber: number }>
            inspect: (input: Record<string, unknown>) => Promise<{ observed: unknown }>
          }
        }>(ctx, AssistantActionsService, 'assistantActions', {
          stateRoot: join(ws.stateDir, 'actions'),
        })
        await harness.mountPlugin(ctx, fixtureMod)

        const signal = new AbortController().signal
        const initialOid = '1'.repeat(40)
        const commitRes = await actions.commit({
          actionId: 'act-commit-1',
          signal,
          request: {
            expectedHeadOid: initialOid,
            files: [{ path: 'summarize.mjs', content: 'console.log("{}")' }],
          },
        })
        expect(commitRes.status).toBe('succeeded')
        expect(commitRes.commitOid).toMatch(/^[a-f0-9]{40}$/u)

        const prRes = await actions.workflow.pullRequest({
          actionId: 'act-pr-1',
          signal,
          expectedHeadOid: commitRes.commitOid,
        })
        expect(prRes.pullRequestNumber).toBe(17)

        const pendingSnap = fixtureMod.repositoryFixtureSnapshot()
        expect(pendingSnap.ready).toBe(false)
        expect(pendingSnap.pullRequest?.number).toBe(17)
        expect(pendingSnap.checks[0]?.status).toBe('in_progress')

        await writeFile(eventStatePath, '{"ready":true}', { mode: 0o600 })
        const inspected = await actions.workflow.inspect({
          signal,
          kind: 'pull-request',
          grant: { repository: 'fixture/orders', branch: 'automation/fix' },
        })
        expect(inspected.observed).toMatchObject({ number: 17, state: 'open' })

        const readySnap = fixtureMod.repositoryFixtureSnapshot()
        expect(readySnap.ready).toBe(true)
        expect(readySnap.checks[0]?.conclusion).toBe('success')
        expect(readySnap.reviews[0]?.state).toBe('APPROVED')

        const jsonlLines = (await readFile(logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { kind: string })
        expect(jsonlLines.map(r => r.kind)).toEqual(['commit', 'pr'])
      } finally {
        if (prevLog === undefined) delete process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
        else process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = prevLog
        if (prevState === undefined) delete process.env.DSH_REPO_EVENT_STATE
        else process.env.DSH_REPO_EVENT_STATE = prevState
        if (prevMode === undefined) delete process.env.DSH_REPO_DELIVERY_MODE
        else process.env.DSH_REPO_DELIVERY_MODE = prevMode
      }
    })

    test('T1-F11-04: WP18 assistant-isolation subprocess sandbox verifies positive and negative summarize.mjs behaviors', async () => {
      const ws = await workspaces.create('f11-iso-verify-')
      const isoMod = await loadAssistantIsolation()
      const runIsolatedSubprocess = getExportFn<(
        req: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => Promise<{
        backend: string
        sandboxed: boolean
        status: string
        exitCode: number | null
        stdout: string
      }>>(isoMod, 'runIsolatedSubprocess')

      const scriptPath = join(ws.workspace, 'summarize.mjs')
      await writeFile(scriptPath, [
        "let raw = ''",
        "process.stdin.on('data', chunk => { raw += chunk })",
        "process.stdin.on('end', () => {",
        "  const items = JSON.parse(raw || '[]')",
        '  const sums = {}',
        '  for (const item of items) {',
        "    if (item.status === 'cancelled') continue",
        '    sums[item.currency] = (sums[item.currency] ?? 0) + item.amountCents',
        '  }',
        '  const ordered = Object.fromEntries(Object.keys(sums).sort().map(k => [k, sums[k]]))',
        '  console.log(JSON.stringify(ordered))',
        '})',
      ].join('\n'), 'utf8')

      const positive = await runIsolatedSubprocess({
        command: process.execPath,
        args: [scriptPath],
        cwd: ws.workspace,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdin: '[{"currency":"USD","amountCents":100},{"currency":"USD","amountCents":50,"status":"cancelled"},{"currency":"EUR","amountCents":25}]\n',
        timeoutMs: 5_000,
        network: 'none',
      })
      expect(positive.sandboxed).toBe(true)
      expect(positive.status).toBe('succeeded')
      expect(positive.exitCode).toBe(0)
      expect(positive.stdout.trim()).toBe('{"EUR":25,"USD":100}')

      const negative = await runIsolatedSubprocess({
        command: process.execPath,
        args: ['-e', 'process.exit(19)'],
        cwd: ws.workspace,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdin: '',
        timeoutMs: 5_000,
        network: 'none',
      })
      expect(negative.sandboxed).toBe(true)
      expect(negative.status).toBe('failed')
      expect(negative.exitCode).toBe(19)
      expect(isoMod.IsolatedVerifierRunner).toBeTypeOf('function')
    })

    test('T1-F11-05: WP18 repo-autonomy-observer and external delivery fixture enforce finite limits and setup-only gating', async () => {
      const ws = await workspaces.create('f11-observer-')
      const observerMod = (await loadRepoAutonomyObserver()) as {
        name: string
        apply: (ctx: unknown) => void
      }
      const extMod = (await loadRepoExternalDeliveryFixture()) as {
        prepareExternalRepositoryFixture: (...args: unknown[]) => Promise<unknown>
      }
      expect(typeof extMod.prepareExternalRepositoryFixture).toBe('function')

      const observerLog = join(ws.stateDir, 'observer.jsonl')
      const prevLog = process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
      const prevNoModel = process.env.DSH_REPO_AUTONOMY_NO_MODEL
      process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG = observerLog
      process.env.DSH_REPO_AUTONOMY_NO_MODEL = '1'

      try {
        const ctx = harness.createContext()
        harness.provideMockService(ctx, 'agents', {
          currentInitiator: () => undefined,
        })
        await harness.mountPlugin(ctx, observerMod)

        // With DSH_REPO_AUTONOMY_NO_MODEL=1, llm/stream hook must block model dispatch and record model-blocked.
        const streamGen = (ctx as unknown as {
          waterfall: (thisArg: unknown, event: string, options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
        }).waterfall(ctx, 'llm/stream', { system: '', messages: [], tools: [] }, async function* () {})
        await expect((async () => {
          for await (const _chunk of streamGen) {
            // unreachable
          }
        })()).rejects.toThrow(/model requests are forbidden/)

        const logText = await readFile(observerLog, 'utf8')
        expect(logText).toContain('"event":"model-blocked"')
      } finally {
        if (prevLog === undefined) delete process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
        else process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG = prevLog
        if (prevNoModel === undefined) delete process.env.DSH_REPO_AUTONOMY_NO_MODEL
        else process.env.DSH_REPO_AUTONOMY_NO_MODEL = prevNoModel
      }

      const specSource = await readFile(join(repoRoot, 'scripts/e2e/repo-autonomy-real.spec.mjs'), 'utf8')
      expect(specSource).toContain('DSH_REPO_REQUIRE_PREAUTHORIZED')
      expect(specSource).toContain('IsolatedVerifierRunner')
    })
  })
})
