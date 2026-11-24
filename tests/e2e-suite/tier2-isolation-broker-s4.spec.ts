import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
import { createWorkspaceTracker } from './helpers/workspace.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

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

describe('Tier 2 — F08–F11: Isolation, Broker, S4 Web Learning & Sandbox Repo Boundaries', () => {
  describe('F08: WP09 cross-platform isolation negative & boundary contracts', () => {
    test('T2-F08-01: invalid isolation backends and unsupported platforms fail closed', async () => {
      const ws = await workspaces.create('f08-bad-backend-')
      const cfgMod = await loadAssistantIsolationConfig()
      const isoMod = await loadAssistantIsolation()

      expect(() => isoMod.resolveIsolationBackend('docker' as never)).toThrow(/unsupported isolation backend/i)
      expect(() => isoMod.resolveIsolationBackend('' as never)).toThrow(/unsupported isolation backend/i)
      expect(() => isoMod.resolveIsolationBackend('auto', 'freebsd' as never)).toThrow(/unsupported platform/i)

      expect(() => cfgMod.validateConfig({
        backend: 'podman',
        stateRoot: join(ws.stateDir, 'iso'),
      } as never)).toThrow(/unsupported isolation backend|expected "auto"/i)

      expect(() => isoMod.Config({
        backend: 'docker',
        stateRoot: join(ws.stateDir, 'iso'),
      } as never)).toThrow()
    }, 15_000)

    test('T2-F08-02: platform mismatch and root uid=0 are rejected across linux-native, macos-seatbelt & windows-job', async () => {
      const ws = await workspaces.create('f08-plat-mismatch-')
      const cfgMod = await loadAssistantIsolationConfig()

      expect(() => cfgMod.validateConfig({
        backend: 'macos-seatbelt',
        stateRoot: join(ws.stateDir, 'mac-iso'),
        macos: { readOnlyRoots: ['/opt/homebrew'], sandboxExecPath: '/usr/bin/sandbox-exec' },
      } as never, { platform: 'linux', uid: 1000 })).toThrow(/macos-seatbelt backend requires non-root macOS/i)

      expect(() => cfgMod.validateConfig({
        backend: 'macos-seatbelt',
        stateRoot: join(ws.stateDir, 'mac-root'),
        macos: { readOnlyRoots: ['/opt/homebrew'], sandboxExecPath: '/usr/bin/sandbox-exec' },
      } as never, { platform: 'darwin', uid: 0, allowHostPaths: true })).toThrow(/non-root macOS/i)

      expect(() => cfgMod.validateConfig({
        backend: 'windows-job',
        stateRoot: 'C:\\Users\\alice\\.dsh\\win-iso',
      } as never, { platform: 'linux', uid: 1000 })).toThrow(/windows-job backend requires Windows/i)

      expect(() => cfgMod.validateConfig({
        backend: 'linux-native',
        stateRoot: join(ws.stateDir, 'lin-on-mac'),
      } as never, { platform: 'darwin', uid: 501, allowHostPaths: true })).toThrow(/Linux native runtime/i)
    })

    test('T2-F08-03: relative/unsafe stateRoot and overbroad or overlapping macOS readOnlyRoots are rejected', async () => {
      const ws = await workspaces.create('f08-paths-')
      const cfgMod = await loadAssistantIsolationConfig()

      expect(() => cfgMod.validateConfig({
        backend: 'macos-seatbelt',
        stateRoot: 'relative/iso',
      } as never, { platform: 'darwin', uid: 501, allowHostPaths: true })).toThrow(/canonical absolute state root/i)

      expect(() => cfgMod.validateConfig({
        backend: 'macos-seatbelt',
        stateRoot: join(ws.stateDir, 'bad,comma'),
      } as never, { platform: 'darwin', uid: 501, allowHostPaths: true })).toThrow(/canonical absolute state root/i)

      for (const badRoot of ['/', '/Users', homedir(), join(ws.stateDir, 'mac-iso')]) {
        expect(() => cfgMod.validateConfig({
          backend: 'macos-seatbelt',
          stateRoot: join(ws.stateDir, 'mac-iso'),
          macos: { readOnlyRoots: [badRoot], sandboxExecPath: '/usr/bin/sandbox-exec' },
        } as never, { platform: 'darwin', uid: 501, allowHostPaths: true })).toThrow(/canonical macOS read-only root|overbroad macOS read-only root|overlap/i)
      }
    })

    test('T2-F08-04: workspace path traversal, limit overflow, and unsafe subprocess env/cwd/network are rejected', async () => {
      const ws = await workspaces.create('f08-escape-')
      const isoMod = await loadAssistantIsolation()
      const isoWsMod = await loadPackageModule('assistant-isolation/workspace')
      const normalizeRequest = getExportFn<(req: Record<string, unknown>, limits?: Record<string, unknown>) => unknown>(
        isoWsMod,
        'normalizeRequest',
      )
      const runIsolatedSubprocess = getExportFn<(req: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>>(
        isoMod,
        'runIsolatedSubprocess',
      )

      const limits = {
        maxDurationMs: 5_000,
        maxInputBytes: 64,
        maxOutputBytes: 4_096,
        maxArtifacts: 4,
        maxArtifactBytes: 1_024,
      }

      expect(() => normalizeRequest({
        grantId: 'g1',
        idempotencyKey: 'k1',
        command: 'echo hi',
        files: [{ path: '../escape.txt', content: 'x' }],
      }, limits)).toThrow()

      expect(() => normalizeRequest({
        grantId: 'g1',
        idempotencyKey: 'k2',
        command: 'echo hi',
        files: [{ path: '/etc/passwd', content: 'x' }],
      }, limits)).toThrow()

      expect(() => normalizeRequest({
        grantId: 'g1',
        idempotencyKey: 'k3',
        command: 'echo hi',
        artifacts: ['../../secret.txt'],
      }, limits)).toThrow()

      expect(() => normalizeRequest({
        grantId: 'g1',
        idempotencyKey: 'k4',
        command: 'echo hi',
        files: [{ path: 'big.txt', content: 'x'.repeat(128) }],
      }, limits)).toThrow()

      expect(() => normalizeRequest({
        grantId: 'g1',
        idempotencyKey: 'k5',
        command: 'echo hi',
        timeoutMs: 0,
      }, limits)).toThrow()

      await expect(runIsolatedSubprocess({
        command: process.execPath,
        args: ['-e', 'console.log(1)'],
        cwd: 'relative/cwd',
        timeoutMs: 1_000,
        network: 'none',
      })).rejects.toThrow(/cwd/i)

      await expect(runIsolatedSubprocess({
        command: process.execPath,
        args: ['-e', 'console.log(1)'],
        cwd: ws.workspace,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        timeoutMs: 1_000,
        network: 'full',
      })).rejects.toThrow(/network/i)

      await expect(runIsolatedSubprocess({
        command: process.execPath,
        args: ['-e', 'console.log(1)'],
        cwd: ws.workspace,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        timeoutMs: 0,
        network: 'none',
      })).rejects.toThrow(/timeout/i)

      // Dangerous env variables are scrubbed from isolated subprocess.
      const envProbe = (await runIsolatedSubprocess({
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify({ ld: process.env.LD_PRELOAD ?? null, opts: process.env.NODE_OPTIONS ?? null, proxy: process.env.HTTP_PROXY ?? null }))'],
        cwd: ws.workspace,
        env: {
          PATH: '/usr/bin:/bin',
          LD_PRELOAD: '/tmp/evil.so',
          NODE_OPTIONS: '--require=/tmp/evil.js',
          HTTP_PROXY: 'http://127.0.0.1:9999',
        },
        timeoutMs: 5_000,
        network: 'none',
      })) as { stdout: string }
      expect(JSON.parse(envProbe.stdout.trim())).toEqual({ ld: null, opts: null, proxy: null })
    })

    test('T2-F08-05: expired grant, maxRuns exhaustion, and policy-denied grant fail closed on AssistantIsolationService.run', async () => {
      const ws = await workspaces.create('f08-grant-cap-')
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
      const agent = makeStubIsolationAgent('sess-f08-bva', ws.workspace)
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
            id: 'allow-one',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'isolation:grant-one' },
            context: { initiators: ['foreground'] },
          },
          {
            id: 'allow-exp',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'isolation:grant-expired' },
            context: { initiators: ['foreground'] },
          },
        ],
      })

      const principalDigest = isoMod.isolationPrincipalDigest('web/a/t/u')
      const svc = new AssistantIsolationService(ctx, {
        backend: 'auto',
        stateRoot: join(ws.stateDir, 'iso-cap'),
        limits: { maxDurationMs: 5_000, maxOutputBytes: 4_096 },
        grants: [
          {
            id: 'grant-one',
            revision: 1,
            principalDigest,
            principalRecordId: 'rec-1',
            principalVersion: 1,
            workspace: ws.workspace,
            agentPreset: 'primary',
            expiresAt: Date.now() + 60_000,
            maxRuns: 1,
            maxTotalDurationMs: 30_000,
          },
          {
            id: 'grant-expired',
            revision: 1,
            principalDigest,
            principalRecordId: 'rec-1',
            principalVersion: 1,
            workspace: ws.workspace,
            agentPreset: 'primary',
            expiresAt: Date.now() - 1_000,
            maxRuns: 5,
            maxTotalDurationMs: 30_000,
          },
          {
            id: 'grant-no-policy',
            revision: 1,
            principalDigest,
            principalRecordId: 'rec-1',
            principalVersion: 1,
            workspace: ws.workspace,
            agentPreset: 'primary',
            expiresAt: Date.now() + 60_000,
            maxRuns: 5,
            maxTotalDurationMs: 30_000,
          },
        ],
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
            stdout: 'ok\n',
            stderr: '',
            artifacts: [],
          }),
        },
      })
      await svc.ready

      await expect(svc.run(agent, { grantId: 'grant-expired', idempotencyKey: 'k-exp', command: 'true' }, new AbortController().signal)).rejects.toThrow()
      await expect(svc.run(agent, { grantId: 'grant-no-policy', idempotencyKey: 'k-pol', command: 'true' }, new AbortController().signal)).rejects.toThrow()

      const first = await svc.run(agent, { grantId: 'grant-one', idempotencyKey: 'k-1', command: 'true' }, new AbortController().signal)
      expect(first.status).toBe('succeeded')
      await expect(svc.run(agent, { grantId: 'grant-one', idempotencyKey: 'k-2', command: 'true' }, new AbortController().signal)).rejects.toThrow()
    })
  })

  describe('F09: WP09 S4 Web Learning sandbox escape, SSRF, env leak & tool surface boundaries', () => {
    test('T2-F09-01: validateWhitelistedWebUrl rejects non-HTTPS, credentials, custom ports, IP literals, forbidden & unlisted hosts', async () => {
      const assoc = await loadAssistantAssociation()
      const validateUrl = getExportFn<(url: string, opts: { allowedDomains: readonly string[]; allowSubdomains?: boolean }) => unknown>(
        assoc,
        'validateWhitelistedWebUrl',
      )

      expect(() => validateUrl('https://docs.example.test/a', { allowedDomains: [] })).toThrow(/whitelist/i)
      expect(() => validateUrl('http://docs.example.test/a', { allowedDomains: ['docs.example.test'] })).toThrow(/HTTPS/i)
      expect(() => validateUrl('file:///etc/passwd', { allowedDomains: ['docs.example.test'] })).toThrow(/HTTPS/i)
      expect(() => validateUrl('javascript:alert(1)', { allowedDomains: ['docs.example.test'] })).toThrow(/HTTPS/i)
      expect(() => validateUrl('https://user:pass@docs.example.test/a', { allowedDomains: ['docs.example.test'] })).toThrow(/credentials/i)
      expect(() => validateUrl('https://docs.example.test:8443/a', { allowedDomains: ['docs.example.test'] })).toThrow(/443/i)
      expect(() => validateUrl('https://127.0.0.1/a', { allowedDomains: ['docs.example.test'] })).toThrow(/IP literal/i)
      expect(() => validateUrl('https://[::1]/a', { allowedDomains: ['docs.example.test'] })).toThrow(/IP literal/i)
      expect(() => validateUrl('https://localhost/a', { allowedDomains: ['docs.example.test'] })).toThrow(/forbidden/i)
      expect(() => validateUrl('https://box.internal/a', { allowedDomains: ['docs.example.test'] })).toThrow(/forbidden/i)
      expect(() => validateUrl('https://sub.docs.example.test/a', { allowedDomains: ['docs.example.test'], allowSubdomains: false })).toThrow(/whitelist/i)
      expect(() => validateUrl(`https://docs.example.test/${'a'.repeat(2050)}`, { allowedDomains: ['docs.example.test'] })).toThrow(/length|invalid/i)
    })

    test('T2-F09-02: isGlobalPublicIp and fetchWebPageReadOnly block metadata/private/CGNAT/loopback IPs and disallowed redirects', async () => {
      const assoc = await loadAssistantAssociation()
      const isGlobal = getExportFn<(ip: string) => boolean>(assoc, 'isGlobalPublicIp')
      const fetchWebPage = getExportFn<(input: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<unknown>>(
        assoc,
        'fetchWebPageReadOnly',
      )

      for (const blocked of [
        '127.0.0.1',
        '10.0.0.1',
        '172.16.0.1',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '::1',
        'fe80::1',
        'fc00::1',
        '::ffff:127.0.0.1',
      ]) {
        expect(isGlobal(blocked), `Expected ${blocked} to be non-public`).toBe(false)
      }
      expect(isGlobal('93.184.216.34')).toBe(true)

      await expect(fetchWebPage({
        url: 'https://docs.example.test/meta',
        allowedDomains: ['docs.example.test'],
        maxBytes: 8_192,
        maxRedirects: 1,
        requestTimeoutMs: 2_000,
      }, {
        lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      })).rejects.toThrow(/non-public|private|SSRF|unsafe/i)

      await expect(fetchWebPage({
        url: 'https://docs.example.test/redirect',
        allowedDomains: ['docs.example.test'],
        maxBytes: 8_192,
        maxRedirects: 1,
        requestTimeoutMs: 2_000,
      }, {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
      })).rejects.toThrow(/whitelist|redirect/i)
    })

    test('T2-F09-03: sanitizeWebLearningEnv strips secrets/preloaders and assertReadOnlyWebToolSurface rejects write tools', async () => {
      const assoc = await loadAssistantAssociation()
      const secrets = ['sk-deepseek-leak-1', 'ghp_github_leak_2', 'aws-secret-leak-3', 'feishu-secret-4']
      const sanitized = assoc.sanitizeWebLearningEnv({
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        DEEPSEEK_API_KEY: secrets[0],
        GITHUB_TOKEN: secrets[1],
        AWS_SECRET_ACCESS_KEY: secrets[2],
        FEISHU_APP_SECRET: secrets[3],
        NODE_OPTIONS: '--require=/tmp/hook.js',
        LD_PRELOAD: '/tmp/hook.so',
      })
      expectNoSecretLeak(JSON.stringify(sanitized), [...secrets, 'NODE_OPTIONS', 'LD_PRELOAD'])
      expect(sanitized.PATH).toBe('/usr/bin')

      for (const badTool of [
        'bash',
        'exec_command',
        'write_file',
        'memory_write',
        'action_http_request',
        { name: 'custom_reader', readOnly: false },
      ]) {
        expect(() => assoc.assertReadOnlyWebToolSurface([badTool as never])).toThrow()
      }
    })

    test('T2-F09-04: createSubprocessWebLearningRunner rejects aborted signal, stdin limit overflow, nonzero exit & timeout', async () => {
      const ws = await workspaces.create('f09-subproc-')
      const assoc = await loadAssistantAssociation()
      const createSubprocRunner = getExportFn<(opts?: Record<string, unknown>) => {
        run: (req: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>
      }>(assoc, 'createSubprocessWebLearningRunner')

      const sampleTargets = [{ url: 'https://docs.example.test/a', interestKey: 'k' }]
      const aborted = new AbortController()
      aborted.abort()
      const abortRunner = createSubprocRunner()
      await expect(abortRunner.run({
        runId: 'r-abort',
        allowedDomains: ['docs.example.test'],
        targets: sampleTargets,
        budget: { maxRequests: 1, maxPages: 1, maxBytesPerRequest: 1024, maxTotalBytes: 1024, maxDurationMs: 1000, requestTimeoutMs: 500 },
      }, aborted.signal)).rejects.toThrow(/abort/i)

      const stdinRunner = createSubprocRunner({ maxStdinBytes: 64 })
      await expect(stdinRunner.run({
        runId: 'r-stdin',
        allowedDomains: ['docs.example.test'],
        targets: sampleTargets,
        budget: { maxRequests: 1, maxPages: 1, maxBytesPerRequest: 1024, maxTotalBytes: 1024, maxDurationMs: 1000, requestTimeoutMs: 500 },
      })).rejects.toThrow(/exceeds 64 bytes/i)

      const exitRunner = createSubprocRunner({
        tempBaseDir: ws.stateDir,
        isolatedRunner: async () => ({
          backend: 'linux-native',
          status: 'failed',
          sandboxed: true,
          exitCode: 3,
          processSignal: null,
          stdout: '',
          stderr: 'worker boom',
          durationMs: 10,
        }),
      })
      await expect(exitRunner.run({
        runId: 'r-exit',
        allowedDomains: ['docs.example.test'],
        targets: sampleTargets,
        budget: { maxRequests: 1, maxPages: 1, maxBytesPerRequest: 1024, maxTotalBytes: 1024, maxDurationMs: 1000, requestTimeoutMs: 500 },
      })).rejects.toThrow(/exited abnormally.*code=3/i)

      const timeoutRunner = createSubprocRunner({
        tempBaseDir: ws.stateDir,
        isolatedRunner: async () => ({
          backend: 'linux-native',
          status: 'timed-out',
          sandboxed: true,
          exitCode: null,
          processSignal: 'SIGKILL',
          stdout: '',
          stderr: '',
          durationMs: 100,
        }),
      })
      await expect(timeoutRunner.run({
        runId: 'r-timeout',
        allowedDomains: ['docs.example.test'],
        targets: sampleTargets,
        budget: { maxRequests: 1, maxPages: 1, maxBytesPerRequest: 1024, maxTotalBytes: 1024, maxDurationMs: 80, requestTimeoutMs: 50 },
      })).rejects.toThrow(/timed out after 80ms/i)
    })

    test('T2-F09-05: normalizeAssociationConfig honors explicit false S3/S4 overrides and rejects inverted budget bounds', async () => {
      const ws = await workspaces.create('f09-cfg-')
      const assoc = await loadAssistantAssociation()

      const disabled = assoc.normalizeAssociationConfig({
        databasePath: ws.sqlitePath('assoc'),
        enabled: true,
        dreaming: { enabled: false },
        intakeSignal: { enabled: false },
        webLearning: { enabled: false },
      })
      expect(disabled.dreaming.enabled).toBe(false)
      expect(disabled.intakeSignal.enabled).toBe(false)
      expect(disabled.webLearning.enabled).toBe(false)

      expect(() => assoc.normalizeAssociationConfig({
        databasePath: ws.sqlitePath('assoc-bad-1'),
        webLearning: { enabled: true, maxRequestsPerRun: 2, maxPagesPerRun: 5 },
      })).toThrow()

      expect(() => assoc.normalizeAssociationConfig({
        databasePath: ws.sqlitePath('assoc-bad-2'),
        webLearning: { enabled: true, requestTimeoutMs: 5_000, maxDurationMs: 1_000 },
      })).toThrow()
    })

    test('T2-F09-06: createSandboxedWebLearningRunner rejects non-sandboxed escape results, cancelled runs & invalid worker JSON stdout', async () => {
      const ws = await workspaces.create('f09-sandboxed-')
      const assoc = await loadAssistantAssociation()
      const createSandboxed = getExportFn<(opts?: Record<string, unknown>) => {
        run: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>
      }>(assoc, 'createSandboxedWebLearningRunner')

      const req = {
        runId: 'r-sandbox-escape',
        allowedDomains: ['docs.example.test'],
        targets: [{ url: 'https://docs.example.test/a', interestKey: 'k' }],
        toolSurface: ['web_fetch_readonly'],
        budget: { maxRequests: 1, maxPages: 1, maxBytesPerRequest: 1024, maxTotalBytes: 1024, maxDurationMs: 1000, requestTimeoutMs: 500 },
      }
      const fakeOutput = {
        runId: 'r-sandbox-escape',
        startedAt: 1,
        finishedAt: 2,
        status: 'completed',
        reason: 'completed',
        requestsUsed: 0,
        pagesFetched: 0,
        bytesFetched: 0,
        pages: [],
        attempts: [],
      }

      const escapeRunner = createSandboxed({
        tempBaseDir: ws.stateDir,
        isolatedRunner: async () => ({
          backend: 'linux-native',
          status: 'succeeded',
          sandboxed: false,
          reason: 'bwrap-unavailable',
          exitCode: 0,
          processSignal: null,
          stdout: JSON.stringify(fakeOutput),
          stderr: '',
          durationMs: 5,
        }),
      })
      await expect(escapeRunner.run(req)).rejects.toThrow(/OS sandbox unavailable.*bwrap-unavailable/i)

      const corruptStdoutRunner = createSandboxed({
        tempBaseDir: ws.stateDir,
        isolatedRunner: async () => ({
          backend: 'linux-native',
          status: 'succeeded',
          sandboxed: true,
          exitCode: 0,
          processSignal: null,
          stdout: '{not-valid-json',
          stderr: '',
          durationMs: 5,
        }),
      })
      await expect(corruptStdoutRunner.run(req)).rejects.toThrow(/invalid JSON stdout/i)

      const cancelledRunner = createSandboxed({
        tempBaseDir: ws.stateDir,
        isolatedRunner: async () => ({
          backend: 'linux-native',
          status: 'cancelled',
          sandboxed: true,
          exitCode: null,
          processSignal: 'SIGTERM',
          stdout: '',
          stderr: '',
          durationMs: 5,
        }),
      })
      await expect(cancelledRunner.run(req)).rejects.toThrow(/aborted/i)

      const sandboxedOkRunner = createSandboxed({
        tempBaseDir: ws.stateDir,
        isolatedRunner: async () => ({
          backend: 'linux-native',
          status: 'succeeded',
          sandboxed: true,
          exitCode: 0,
          processSignal: null,
          stdout: JSON.stringify(fakeOutput),
          stderr: '',
          durationMs: 5,
        }),
      })
      await expect(sandboxedOkRunner.run(req)).resolves.toMatchObject({ runId: 'r-sandbox-escape', status: 'completed' })
    })
  })

  describe('F10: WP09 external action Broker validation, peer-cred & guard boundaries', () => {
    test('T2-F10-01: validateBrokerActionRequest rejects unsupported kinds, secret-shaped strings, and malformed HTTP/Lark/Calendar/Shell envelopes', async () => {
      const ws = await workspaces.create('f10-envelope-')
      const brokerMod = await loadAssistantActionsBroker()
      const validateReq = getExportFn<(req: unknown) => Record<string, unknown>>(brokerMod, 'validateBrokerActionRequest')

      expect(() => validateReq({ kind: 'ssh', host: 'example.com' })).toThrow(/invalid/i)
      expect(() => validateReq({
        kind: 'http',
        operation: 'fetch',
        destination: 'https://api.example.com/ok',
        method: 'GET',
        headers: { authorization: 'Bearer secret-token-123' },
        grantId: 'g1',
        idempotencyKey: 'k1',
      })).toThrow(/credential-shaped/i)
      expect(() => validateReq({
        kind: 'lark',
        operation: 'send-message',
        chatId: 'oc_1',
        text: 'ghp_1234567890abcdef1234567890abcdef1234',
        grantId: 'g1',
        idempotencyKey: 'k2',
      })).toThrow(/credential-shaped/i)
      expect(() => validateReq({
        kind: 'http',
        operation: 'fetch',
        destination: 'https://user:pass@api.example.com/a',
        method: 'GET',
        grantId: 'g1',
        idempotencyKey: 'k3',
      })).toThrow()
      expect(() => validateReq({
        kind: 'lark',
        operation: 'send-message',
        chatId: '../oc_escape',
        text: 'hello',
        grantId: 'g1',
        idempotencyKey: 'k4',
      })).toThrow()
      expect(() => validateReq({
        kind: 'calendar',
        operation: 'list-events',
        calendarId: 'cal-1',
        startTime: 2_000,
        endTime: 1_000,
        grantId: 'g1',
        idempotencyKey: 'k5',
      })).toThrow()
      expect(() => validateReq({
        kind: 'shell',
        operation: 'exec',
        command: ['echo', 'hi'],
        cwd: ws.workspace,
        grantId: 'g1',
        idempotencyKey: 'k6',
      })).toThrow()
      expect(() => validateReq({
        kind: 'shell',
        operation: 'exec',
        command: ['/bin/echo', 'hi'],
        cwd: 'relative/dir',
        grantId: 'g1',
        idempotencyKey: 'k7',
      })).toThrow()
    })

    test('T2-F10-02: verifyActionBrokerClientRequest rejects expired hello, expired deadline, challenge mismatch, keyId mismatch & bad Ed25519 signature', async () => {
      const ws = await workspaces.create('f10-crypto-')
      const brokerMod = await loadAssistantActionsBroker()
      const serverKeys = generateKeyPairSync('ed25519')
      const clientKeys = generateKeyPairSync('ed25519')
      const wrongKeys = generateKeyPairSync('ed25519')

      const createHello = getExportFn<(input: Record<string, unknown>, key: unknown) => Record<string, unknown>>(
        brokerMod,
        'createActionBrokerServerHello',
      )
      const createClientReq = getExportFn<(
        intent: Record<string, unknown>,
        hello: Record<string, unknown>,
        source: Record<string, unknown>,
        keyId: string,
        key: unknown,
      ) => Record<string, unknown>>(brokerMod, 'createActionBrokerClientRequest')
      const verifyClientReq = getExportFn<(
        value: unknown,
        hello: Record<string, unknown>,
        pubKey: unknown,
        opts?: Record<string, unknown>,
      ) => unknown>(brokerMod, 'verifyActionBrokerClientRequest')

      const now = 1_700_000_000_000
      const hello = createHello({
        instanceId: 'broker-1',
        generation: 1,
        policyEpoch: 1,
        emergencyEpoch: 0,
        expiresAt: now + 30_000,
      }, serverKeys.privateKey)

      const signed = createClientReq({
        actionId: 'act-1',
        grantId: 'grant-1',
        grantRevision: 1,
        grantDigest: sha256Hex('grant-1'),
        domain: 'http',
        owner: {
          principalDigest: sha256Hex('web/a/t/u'),
          principalRecordId: 'rec-1',
          principalVersion: 1,
          workspace: ws.workspace,
          preset: 'primary',
          bindingId: 'bind-1',
          bindingVersion: 1,
          bindingGeneration: 1,
        },
        sessionId: 'sess-1',
        agentId: 'agent-1',
        rootCallId: 'root-1',
        callId: 'call-1',
        operation: 'http.request',
        source: { classification: 'public', provenanceDigest: sha256Hex('api.example.test') },
        destination: { classification: 'http-endpoint', scheme: 'https', host: 'api.example.test', path: '/ok' },
        payload: { method: 'GET', url: 'https://api.example.test/ok' },
        deadline: now + 10_000,
        budget: { reservationId: 'res-1', actions: 1, bytes: 1024, costMetric: 'http-requests', maxCostUnits: 1 },
      }, hello, { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 }, 'client-key-1', clientKeys.privateKey)

      expect(() => verifyClientReq(signed, hello, clientKeys.publicKey, { now: now + 30_000, expectedClientKeyId: 'client-key-1' })).toThrow(/expired/i)
      expect(() => verifyClientReq(signed, hello, clientKeys.publicKey, { now: now + 10_000, expectedClientKeyId: 'client-key-1' })).toThrow(/expired/i)
      expect(() => verifyClientReq({ ...signed, challenge: 'x'.repeat(43) }, hello, clientKeys.publicKey, { now, expectedClientKeyId: 'client-key-1' })).toThrow(/challenge|hello/i)
      expect(() => verifyClientReq(signed, hello, clientKeys.publicKey, { now, expectedClientKeyId: 'other-key' })).toThrow(/identity/i)
      expect(() => verifyClientReq(signed, hello, wrongKeys.publicKey, { now, expectedClientKeyId: 'client-key-1' })).toThrow(/signature/i)
    })

    test('T2-F10-03: live GitHubBrokerServer rejects mismatched peer UID/GID and malformed/non-framed client input', async () => {
      const ws = await workspaces.create('f10-server-')
      const { GitHubBrokerServer } = (await loadPackageModule('assistant-actions/broker-server')) as {
        GitHubBrokerServer: {
          start: (opts: Record<string, unknown>) => Promise<{ stop: (reason?: string) => Promise<void> }>
        }
      }
      const serverKeys = generateKeyPairSync('ed25519')
      const clientKeys = generateKeyPairSync('ed25519')
      const adminKeys = generateKeyPairSync('ed25519')
      const uid = process.getuid?.() ?? 1000
      const gid = process.getgid?.() ?? 1000

      const sockDir = join(ws.stateDir, 'socks')
      await mkdir(sockDir, { recursive: true, mode: 0o700 })
      const actionSocketPath = join(sockDir, 'action.sock')
      const adminSocketPath = join(sockDir, 'admin.sock')

      let peerUidToReturn = uid + 1
      const server = await GitHubBrokerServer.start({
        actionSocketPath,
        adminSocketPath,
        instanceId: 'broker-test-1',
        generation: 1,
        protocolMode: 'action-v2',
        serverPrivateKey: serverKeys.privateKey,
        clientPublicKey: clientKeys.publicKey,
        clientKeyId: 'client-1',
        adminPublicKey: adminKeys.publicKey,
        adminKeyId: 'admin-1',
        inspectPeerCredentials: () => ({ uid: peerUidToReturn, gid }),
        expectedClientPeerUid: uid,
        expectedClientPeerGid: gid,
        expectedAdminPeerUid: uid,
        expectedAdminPeerGid: gid,
        expectedActionSocketUid: uid,
        expectedActionSocketGid: gid,
        expectedActionParentMode: 0o700,
        expectedActionSocketMode: 0o600,
        expectedAdminSocketUid: uid,
        expectedAdminSocketGid: gid,
        expectedAdminParentMode: 0o700,
        expectedAdminSocketMode: 0o600,
        firstByteTimeoutMs: 500,
        frameTimeoutMs: 500,
        core: {
          snapshot: () => ({ generation: 1, policyEpoch: 0, emergencyEpoch: 0 }),
          execute: async () => ({ status: 'succeeded', dispatched: false, result: null, completedAt: Date.now() }),
          admin: async () => ({ status: 'succeeded', state: {}, completedAt: Date.now() }),
          beginDrain: () => {},
          drain: async () => {},
          close: () => {},
        },
      })

      try {
        // Wrong UID -> closed before receiving hello
        const badPeerReceived = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = []
          const sock = connect(actionSocketPath)
          sock.on('data', d => chunks.push(d))
          sock.on('close', () => resolve(Buffer.concat(chunks)))
          sock.on('error', err => reject(err))
        })
        expect(badPeerReceived.length).toBe(0)

        // Matching UID receives hello, then sending malformed frame closes socket cleanly without executing core
        peerUidToReturn = uid
        const malformedClosed = await new Promise<boolean>((resolve, reject) => {
          const sock = connect(actionSocketPath)
          let sawHello = false
          sock.on('data', () => {
            if (!sawHello) {
              sawHello = true
              sock.write(Buffer.from('not-a-valid-length-prefixed-json-frame'))
            }
          })
          sock.on('close', () => resolve(sawHello))
          sock.on('error', err => reject(err))
        })
        expect(malformedClosed).toBe(true)
      } finally {
        await server.stop('lifecycle')
      }
    })

    test('T2-F10-04: http-guard rejects encoded traversal, forbidden headers, and cloud metadata 169.254.169.254 even under allowPrivateNetwork', async () => {
      const httpGuard = await loadAssistantActionsHttpGuard()
      const validateStrictHttpUrl = getExportFn<(url: string) => URL>(httpGuard, 'validateStrictHttpUrl')
      const isBlockedIpAddress = getExportFn<(ip: string, allowPrivate?: boolean) => boolean>(httpGuard, 'isBlockedIpAddress')
      const validateHttpAgainstGrant = getExportFn<(g: Record<string, unknown>, r: Record<string, unknown>, p: Record<string, unknown>) => unknown>(
        httpGuard,
        'validateHttpAgainstGrant',
      )

      expect(() => validateStrictHttpUrl('https://api.example.com/v1/%2e%2e/secret')).toThrow()
      expect(() => validateStrictHttpUrl('https://api.example.com/v1/%5cadmin')).toThrow()
      expect(() => validateStrictHttpUrl('https://api.example.com/v1/../admin')).toThrow()

      expect(isBlockedIpAddress('169.254.169.254', true)).toBe(true)
      expect(isBlockedIpAddress('127.0.0.1', false)).toBe(true)

      expect(() => validateHttpAgainstGrant(
        {
          classification: 'http-endpoint',
          allowedSchemes: ['https'],
          allowedHosts: ['api.example.com'],
          allowedMethods: ['GET'],
          allowedPathPrefixes: ['/v1'],
          allowRedirects: false,
          maxResponseBytes: 4_096,
        },
        { classification: 'http-endpoint', scheme: 'https', host: 'api.example.com', path: '/v1/data' },
        { method: 'GET', url: 'https://api.example.com/v1/data', headers: { authorization: 'Bearer bad' } },
      )).toThrow(/forbidden header|authorization/i)
    })

    test('T2-F10-05: shell-guard rejects disallowed cwd, forbidden env keys, arg count overflow & executable SHA-256 mismatch', async () => {
      const ws = await workspaces.create('f10-shell-guard-')
      const shellGuard = (await loadPackageModule('assistant-actions/guards/shell-guard')) as {
        validateShellAgainstGrant: (g: unknown, r: unknown, p: unknown, deps?: unknown) => Promise<unknown>
      }
      const fakeBin = join(ws.workspace, 'tool.sh')
      await writeFile(fakeBin, '#!/bin/sh\necho ok\n', { mode: 0o700 })
      const binHash = sha256Hex('#!/bin/sh\necho ok\n')
      const grant = {
        classification: 'shell-scope',
        allowedCwds: [ws.workspace],
        allowedEnvKeys: ['LANG'],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
        allowedCommands: [{ executable: fakeBin, executableSha256: binHash, maxArgs: 1 }],
      }

      await expect(shellGuard.validateShellAgainstGrant(
        grant,
        { classification: 'shell-scope', executable: fakeBin, cwd: ws.root },
        { executable: fakeBin, cwd: ws.root, args: [], timeoutMs: 1_000 },
      )).rejects.toThrow(/cwd/i)

      await expect(shellGuard.validateShellAgainstGrant(
        grant,
        { classification: 'shell-scope', executable: fakeBin, cwd: ws.workspace },
        { executable: fakeBin, cwd: ws.workspace, args: [], env: { LD_PRELOAD: '/tmp/evil.so' }, timeoutMs: 1_000 },
      )).rejects.toThrow(/forbidden environment/i)

      await expect(shellGuard.validateShellAgainstGrant(
        grant,
        { classification: 'shell-scope', executable: fakeBin, cwd: ws.workspace },
        { executable: fakeBin, cwd: ws.workspace, args: ['a', 'b'], timeoutMs: 1_000 },
      )).rejects.toThrow(/maxArgs/i)

      await expect(shellGuard.validateShellAgainstGrant(
        { ...grant, allowedCommands: [{ executable: fakeBin, executableSha256: sha256Hex('different'), maxArgs: 1 }] },
        { classification: 'shell-scope', executable: fakeBin, cwd: ws.workspace },
        { executable: fakeBin, cwd: ws.workspace, args: [], timeoutMs: 1_000 },
      )).rejects.toThrow(/SHA-256|digest/i)
    })

    test('T2-F10-06: lark-guard & calendar-guard reject tenant/chat mismatch, oversized payload, missing replyToMessageId, bad window & external attendees', async () => {
      const larkGuard = (await loadPackageModule('assistant-actions/guards/lark-guard')) as {
        validateLarkAgainstGrant: (op: string, g: unknown, r: unknown, p: unknown) => unknown
      }
      const calGuard = (await loadPackageModule('assistant-actions/guards/calendar-guard')) as {
        validateCalendarAgainstGrant: (op: string, g: unknown, r: unknown, p: unknown, now?: number) => unknown
      }

      const larkGrant = {
        classification: 'lark-workspace',
        tenantKey: 't-1',
        apiBaseUrl: 'https://open.feishu.cn',
        allowedChatIds: ['oc_allowed'],
        allowedMsgTypes: ['text'],
        maxTextBytes: 16,
      }
      const larkReqDest = { classification: 'lark-workspace', tenantKey: 't-1', receiveIdType: 'chat_id', receiveId: 'oc_allowed' }

      expect(() => larkGuard.validateLarkAgainstGrant(
        'lark.send-message',
        larkGrant,
        { ...larkReqDest, tenantKey: 't-other' },
        { receiveIdType: 'chat_id', receiveId: 'oc_allowed', msgType: 'text', content: 'hi', uuid: 'u1' },
      )).toThrow(/tenantKey/i)

      expect(() => larkGuard.validateLarkAgainstGrant(
        'lark.send-message',
        larkGrant,
        larkReqDest,
        { receiveIdType: 'chat_id', receiveId: 'oc_allowed', msgType: 'text', content: 'x'.repeat(64), uuid: 'u2' },
      )).toThrow(/maxTextBytes/i)

      expect(() => larkGuard.validateLarkAgainstGrant(
        'lark.reply-message',
        larkGrant,
        larkReqDest,
        { receiveIdType: 'chat_id', receiveId: 'oc_allowed', msgType: 'text', content: 'hi', uuid: 'u3' },
      )).toThrow(/replyToMessageId/i)

      const now = 1_700_000_000_000
      const calGrant = {
        classification: 'calendar-scope',
        provider: 'lark-calendar',
        apiBaseUrl: 'https://open.feishu.cn',
        allowedCalendarIds: ['cal-1'],
        allowMutations: true,
        maxWindowSpanMs: 3_600_000,
        rollingWindowMs: 7_200_000,
        allowedAttendeeDomains: ['corp.example'],
      }
      const calReqDest = { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-1' }

      expect(() => calGuard.validateCalendarAgainstGrant(
        'calendar.list-events',
        calGrant,
        calReqDest,
        { calendarId: 'cal-1', startTimeMs: now + 1000, endTimeMs: now + 1000 },
        now,
      )).toThrow(/startTimeMs must precede endTimeMs/i)

      expect(() => calGuard.validateCalendarAgainstGrant(
        'calendar.list-events',
        calGrant,
        calReqDest,
        { calendarId: 'cal-1', startTimeMs: now, endTimeMs: now + 3_600_001 },
        now,
      )).toThrow(/maxWindowSpanMs/i)

      expect(() => calGuard.validateCalendarAgainstGrant(
        'calendar.create-event',
        calGrant,
        calReqDest,
        { calendarId: 'cal-1', startTimeMs: now, endTimeMs: now + 1_000, summary: 'Sync', attendees: ['intruder@evil.com'] },
        now,
      )).toThrow(/attendee/i)
    })
  })

  describe('F11: WP18 standalone sandbox repo negative, timeout & dirty-repo boundaries', () => {
    test('T2-F11-01: loadLiveRepositoryInput rejects relative paths, insecure mode, same-branch, short lease & malformed JSON', async () => {
      const ws = await workspaces.create('f11-bad-input-')
      const { loadLiveRepositoryInput } = (await loadRepoLiveInput()) as {
        loadLiveRepositoryInput: (path: string, now?: number) => Promise<unknown>
      }

      await expect(loadLiveRepositoryInput('relative/live.json')).rejects.toThrow(/absolute/i)

      const secretFile = join(ws.stateDir, 'secret.txt')
      await writeFile(secretFile, 'ghp_test', { mode: 0o600 })
      const now = Date.now()
      const validPayload = {
        version: 2,
        repository: 'org/repo',
        baseBranch: 'main',
        temporaryBranch: 'automation/fix',
        paths: ['summarize.mjs'],
        credentialHandle: 'h1',
        credential: {
          id: 'h1',
          provider: 'linux-protected-file',
          consumers: ['dsh-enhanced-assistant-actions', 'dsh-enhanced-event-triggers'],
          purposes: ['github.commit', 'github.observe'],
          maxLeaseMs: 60_000,
          reference: { path: secretFile },
        },
        expiresAt: now + 450_000,
        maxActions: 20,
        maxTotalBytes: 65_536,
        requiredChecks: [{ name: 'tests', appId: 7 }],
        reviewerIds: [1],
        minApprovals: 1,
        event: { maxPolls: 10, maxFires: 2, pollIntervalMs: 1_000, requestTimeoutMs: 10_000 },
      }

      const looseModePath = join(ws.stateDir, 'loose.json')
      await writeFile(looseModePath, JSON.stringify(validPayload), { mode: 0o644 })
      await chmod(looseModePath, 0o644)
      await expect(loadLiveRepositoryInput(looseModePath, now)).rejects.toThrow(/private regular file/i)

      const sameBranchPath = join(ws.stateDir, 'same-branch.json')
      await writeFile(sameBranchPath, JSON.stringify({ ...validPayload, temporaryBranch: 'main' }), { mode: 0o600 })
      await expect(loadLiveRepositoryInput(sameBranchPath, now)).rejects.toThrow(/schema is invalid/i)

      const shortLeasePath = join(ws.stateDir, 'short-lease.json')
      await writeFile(shortLeasePath, JSON.stringify({
        ...validPayload,
        credential: { ...validPayload.credential, maxLeaseMs: 20_000 },
        event: { ...validPayload.event, requestTimeoutMs: 30_000 },
      }), { mode: 0o600 })
      await expect(loadLiveRepositoryInput(shortLeasePath, now)).rejects.toThrow(/lease is shorter|schema is invalid/i)

      const malformedPath = join(ws.stateDir, 'bad.json')
      await writeFile(malformedPath, '{not json', { mode: 0o600 })
      await expect(loadLiveRepositoryInput(malformedPath, now)).rejects.toThrow(/JSON/i)
    })

    test('T2-F11-02: repo-verified-delivery-fixture rejects head mismatch, duplicate commit, and PR before commit', async () => {
      const ws = await workspaces.create('f11-fix-err-')
      const { AssistantActionsService } = await loadAssistantActions()
      const fixtureMod = (await loadRepoAutonomyFixture()) as { apply: (ctx: unknown) => void }

      const logPath = join(ws.stateDir, 'gh-fix.jsonl')
      const statePath = join(ws.stateDir, 'gh-state.json')
      await writeFile(statePath, '{"ready":false}', { mode: 0o600 })

      const prevLog = process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
      const prevState = process.env.DSH_REPO_EVENT_STATE
      const prevMode = process.env.DSH_REPO_DELIVERY_MODE
      process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = logPath
      process.env.DSH_REPO_EVENT_STATE = statePath
      delete process.env.DSH_REPO_DELIVERY_MODE

      try {
        const ctx = harness.createContext()
        const actions = await harness.mountService<{
          commit: (input: Record<string, unknown>) => Promise<{ commitOid: string }>
          workflow: { pullRequest: (input: Record<string, unknown>) => Promise<unknown> }
        }>(ctx, AssistantActionsService, 'assistantActions', { stateRoot: join(ws.stateDir, 'actions') })
        await harness.mountPlugin(ctx, fixtureMod)
        const signal = new AbortController().signal

        await expect(actions.workflow.pullRequest({
          actionId: 'pr-before-commit',
          signal,
          expectedHeadOid: '1'.repeat(40),
        })).rejects.toThrow(/head or duplicate/i)

        await expect(actions.commit({
          actionId: 'bad-head-commit',
          signal,
          request: {
            expectedHeadOid: '2'.repeat(40),
            files: [{ path: 'summarize.mjs', content: 'console.log(1)' }],
          },
        })).rejects.toThrow(/head or duplicate/i)

        const good = await actions.commit({
          actionId: 'good-commit',
          signal,
          request: {
            expectedHeadOid: '1'.repeat(40),
            files: [{ path: 'summarize.mjs', content: 'console.log(1)' }],
          },
        })
        await expect(actions.commit({
          actionId: 'dup-commit',
          signal,
          request: {
            expectedHeadOid: good.commitOid,
            files: [{ path: 'summarize.mjs', content: 'console.log(2)' }],
          },
        })).rejects.toThrow(/head or duplicate/i)
      } finally {
        if (prevLog === undefined) delete process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
        else process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = prevLog
        if (prevState === undefined) delete process.env.DSH_REPO_EVENT_STATE
        else process.env.DSH_REPO_EVENT_STATE = prevState
        if (prevMode === undefined) delete process.env.DSH_REPO_DELIVERY_MODE
        else process.env.DSH_REPO_DELIVERY_MODE = prevMode
      }
    })

    test('T2-F11-03: runIsolatedSubprocess captures malformed-JSON nonzero exit, timeout, and output-limit breaches', async () => {
      const ws = await workspaces.create('f11-subproc-fail-')
      const isoMod = await loadAssistantIsolation()
      const runIsolatedSubprocess = getExportFn<(req: Record<string, unknown>) => Promise<{
        sandboxed: boolean
        status: string
        exitCode: number | null
      }>>(isoMod, 'runIsolatedSubprocess')

      const scriptPath = join(ws.workspace, 'summarize.mjs')
      await writeFile(scriptPath, `
        let raw = ''
        process.stdin.on('data', d => { raw += d })
        process.stdin.on('end', () => { JSON.parse(raw); console.log('ok') })
      `, 'utf8')

      const badJsonRes = await runIsolatedSubprocess({
        command: process.execPath,
        args: [scriptPath],
        cwd: ws.workspace,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdin: '{broken json',
        timeoutMs: 3_000,
        network: 'none',
      })
      expect(badJsonRes.sandboxed).toBe(true)
      expect(badJsonRes.status).toBe('failed')
      expect(badJsonRes.exitCode).not.toBe(0)

      const timeoutRes = await runIsolatedSubprocess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 500)'],
        cwd: ws.workspace,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        timeoutMs: 150,
        network: 'none',
      })
      expect(timeoutRes.sandboxed).toBe(true)
      expect(timeoutRes.status).toBe('timed-out')

      const outLimitRes = await runIsolatedSubprocess({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(4096))'],
        cwd: ws.workspace,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        timeoutMs: 3_000,
        maxStdoutBytes: 64,
        network: 'none',
      })
      expect(outLimitRes.sandboxed).toBe(true)
      expect(outLimitRes.status).toBe('output-limit')
    })

    test('T2-F11-04: repo-autonomy-observer rejects missing log / invalid finite limits and aborts on maxCalls overflow', async () => {
      const ws = await workspaces.create('f11-obs-limit-')
      const observerMod = (await loadRepoAutonomyObserver()) as { name: string; apply: (ctx: unknown) => void }
      const observerLog = join(ws.stateDir, 'obs-limit.jsonl')

      const prevLog = process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
      const prevMax = process.env.DSH_REPO_AUTONOMY_MAX_CALLS
      const prevDur = process.env.DSH_REPO_AUTONOMY_DURATION_MS
      const prevNoModel = process.env.DSH_REPO_AUTONOMY_NO_MODEL
      delete process.env.DSH_REPO_AUTONOMY_NO_MODEL

      try {
        delete process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
        const ctxMissingLog = harness.createContext()
        harness.provideMockService(ctxMissingLog, 'agents', {})
        let missingLogErr: unknown
        try {
          await harness.mountPlugin(ctxMissingLog, observerMod)
        } catch (err) {
          missingLogErr = err
        }
        expect((missingLogErr as Error | undefined)?.message).toMatch(/observer log is required/i)

        process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG = observerLog
        process.env.DSH_REPO_AUTONOMY_MAX_CALLS = '0'
        process.env.DSH_REPO_AUTONOMY_DURATION_MS = '500'
        const ctxBadLim = harness.createContext()
        harness.provideMockService(ctxBadLim, 'agents', {})
        let badLimErr: unknown
        try {
          await harness.mountPlugin(ctxBadLim, observerMod)
        } catch (err) {
          badLimErr = err
        }
        expect((badLimErr as Error | undefined)?.message).toMatch(/finite limits/i)

        process.env.DSH_REPO_AUTONOMY_MAX_CALLS = '1'
        process.env.DSH_REPO_AUTONOMY_DURATION_MS = '60000'
        let cancelled = false
        let cancelledReason: string | undefined
        const ctxCap = harness.createContext()
        harness.provideMockService(ctxCap, 'agents', {
          currentInitiator: () => ({
            sessionId: 's1',
            agentId: 'a1',
            cancel: (opts?: { reason?: string }) => {
              cancelled = true
              cancelledReason = opts?.reason
            },
          }),
          cancel: () => { cancelled = true },
        })
        await harness.mountPlugin(ctxCap, observerMod)

        const wf = ctxCap as unknown as {
          waterfall: (thisArg: unknown, event: string, options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
        }
        const firstGen = wf.waterfall(ctxCap, 'llm/stream', { system: '', messages: [], tools: [] }, async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })
        for await (const _chunk of firstGen) {
          // consumed call #1
        }
        const secondGen = wf.waterfall(ctxCap, 'llm/stream', { system: '', messages: [], tools: [] }, async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })
        await expect((async () => {
          for await (const _chunk of secondGen) {
            // unreachable
          }
        })()).rejects.toThrow(/finite experiment limit/i)
        expect(cancelled).toBe(true)
        expect(cancelledReason).toBe('repo-autonomy-real-observer-limit')
        const logged = await readFile(observerLog, 'utf8')
        expect(logged).toContain('"call":1')
        expect(logged).not.toContain('"call":2')
      } finally {
        if (prevLog === undefined) delete process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG
        else process.env.DSH_REPO_AUTONOMY_OBSERVER_LOG = prevLog
        if (prevMax === undefined) delete process.env.DSH_REPO_AUTONOMY_MAX_CALLS
        else process.env.DSH_REPO_AUTONOMY_MAX_CALLS = prevMax
        if (prevDur === undefined) delete process.env.DSH_REPO_AUTONOMY_DURATION_MS
        else process.env.DSH_REPO_AUTONOMY_DURATION_MS = prevDur
        if (prevNoModel === undefined) delete process.env.DSH_REPO_AUTONOMY_NO_MODEL
        else process.env.DSH_REPO_AUTONOMY_NO_MODEL = prevNoModel
      }
    })

    test('T2-F11-05: WP18 live-input, verified-delivery fixture & external-delivery fixture reject mismatched head, out-of-order PR, non-private creds & missing fixture mode', async () => {
      const ws = await workspaces.create('f11-wp18-neg-')
      const { loadLiveRepositoryInput, mergeLiveCredentialHandles } = (await loadRepoLiveInput()) as {
        loadLiveRepositoryInput: (path: string, now?: number) => Promise<{
          credential: { id: string }
          repositoryDelivery: Record<string, unknown>
        }>
        mergeLiveCredentialHandles: (current: readonly unknown[], live: { credential: { id: string } }) => unknown[]
      }

      // 1. WP18 repo-live-input negative boundaries (non-private cred, same branch, invalid expiry, duplicate handle)
      const secretFile = join(ws.stateDir, 'gh-token')
      await writeFile(secretFile, 'ghp_fixture_only', { mode: 0o600 })
      const now = Date.now()
      const validDescriptor = {
        version: 2,
        repository: 'org/orders-repo',
        baseBranch: 'main',
        temporaryBranch: 'automation/fix-summarize',
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
        maxActions: 80,
        maxTotalBytes: 1_048_576,
        requiredChecks: [{ name: 'tests', appId: 7 }],
        reviewerIds: [42],
        minApprovals: 1,
        event: { maxPolls: 20, maxFires: 4, pollIntervalMs: 2_000, requestTimeoutMs: 10_000 },
      }

      const publicDescriptorPath = join(ws.stateDir, 'public-desc.json')
      await writeFile(publicDescriptorPath, JSON.stringify(validDescriptor), { mode: 0o644 })
      await expect(loadLiveRepositoryInput(publicDescriptorPath, now)).rejects.toThrow(/private regular file/i)

      const sameBranchPath = join(ws.stateDir, 'same-branch.json')
      await writeFile(sameBranchPath, JSON.stringify({ ...validDescriptor, temporaryBranch: 'main' }), { mode: 0o600 })
      await expect(loadLiveRepositoryInput(sameBranchPath, now)).rejects.toThrow(/schema is invalid/i)

      const expiredDescPath = join(ws.stateDir, 'expired-desc.json')
      await writeFile(expiredDescPath, JSON.stringify({ ...validDescriptor, expiresAt: now + 10_000 }), { mode: 0o600 })
      await expect(loadLiveRepositoryInput(expiredDescPath, now)).rejects.toThrow(/schema is invalid/i)

      const validDescPath = join(ws.stateDir, 'valid-desc.json')
      await writeFile(validDescPath, JSON.stringify(validDescriptor), { mode: 0o600 })
      const loaded = await loadLiveRepositoryInput(validDescPath, now)
      expect(() => mergeLiveCredentialHandles([{ id: 'live-gh-handle' }], loaded)).toThrow(/conflicts/i)

      // 2. WP18 repo-verified-delivery-fixture mounted on AssistantActionsService rejects out-of-order PR & mismatched head without mutating snapshot
      const { AssistantActionsService } = await loadAssistantActions()
      const fixtureMod = (await loadRepoAutonomyFixture()) as {
        apply: (ctx: unknown) => void
        repositoryFixtureSnapshot: () => {
          headOid: string
          pullRequest: { number: number } | null
        }
      }
      const logPath = join(ws.stateDir, 'github-fixture-neg.jsonl')
      const eventStatePath = join(ws.stateDir, 'repo-event-neg.json')
      await writeFile(eventStatePath, '{"ready":false}', { mode: 0o600 })

      const prevDelivery = process.env.DSH_REPO_VERIFIED_DELIVERY
      const prevLog = process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
      const prevState = process.env.DSH_REPO_EVENT_STATE
      const prevMode = process.env.DSH_REPO_DELIVERY_MODE
      delete process.env.DSH_REPO_VERIFIED_DELIVERY
      process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = logPath
      process.env.DSH_REPO_EVENT_STATE = eventStatePath
      delete process.env.DSH_REPO_DELIVERY_MODE

      try {
        const extMod = (await loadRepoExternalDeliveryFixture()) as {
          prepareExternalRepositoryFixture: (home: string, patchPath: string, env: Record<string, string>, opts: Record<string, unknown>) => Promise<unknown>
        }
        await expect(extMod.prepareExternalRepositoryFixture(ws.dshHome, join(ws.dshHome, 'patch.yml'), {}, {
          sessionId: 's-1',
          workspace: ws.workspace,
          objective: 'fix',
          source: 'console.log(1)',
        })).rejects.toThrow(/requires fixture delivery/i)

        const ctx = harness.createContext()
        const actions = await harness.mountService<{
          commit: (input: Record<string, unknown>) => Promise<{ status: string; commitOid: string }>
          workflow: {
            pullRequest: (input: Record<string, unknown>) => Promise<{ status: string; pullRequestNumber: number }>
          }
        }>(ctx, AssistantActionsService, 'assistantActions', {
          stateRoot: join(ws.stateDir, 'actions'),
        })
        await harness.mountPlugin(ctx, fixtureMod)

        const signal = new AbortController().signal
        const initialOid = '1'.repeat(40)

        // PR before commit must fail closed
        await expect(actions.workflow.pullRequest({
          actionId: 'act-pr-early',
          signal,
          expectedHeadOid: initialOid,
        })).rejects.toThrow(/PR head or duplicate/i)
        expect(fixtureMod.repositoryFixtureSnapshot().headOid).toBe(initialOid)
        expect(fixtureMod.repositoryFixtureSnapshot().pullRequest).toBeNull()

        // Commit with wrong expectedHeadOid must fail closed without advancing headOid
        await expect(actions.commit({
          actionId: 'act-bad-head',
          signal,
          request: {
            expectedHeadOid: '2'.repeat(40),
            files: [{ path: 'summarize.mjs', content: 'console.log("{}")' }],
          },
        })).rejects.toThrow(/expected head or duplicate/i)
        expect(fixtureMod.repositoryFixtureSnapshot().headOid).toBe(initialOid)

        // One valid commit advances headOid; duplicate commit or mismatched-head PR must fail closed
        const okCommit = await actions.commit({
          actionId: 'act-ok-commit',
          signal,
          request: {
            expectedHeadOid: initialOid,
            files: [{ path: 'summarize.mjs', content: 'console.log("{}")' }],
          },
        })
        expect(okCommit.status).toBe('succeeded')

        await expect(actions.commit({
          actionId: 'act-dup-commit',
          signal,
          request: {
            expectedHeadOid: initialOid,
            files: [{ path: 'summarize.mjs', content: 'console.log("dup")' }],
          },
        })).rejects.toThrow(/expected head or duplicate/i)

        await expect(actions.workflow.pullRequest({
          actionId: 'act-pr-bad-head',
          signal,
          expectedHeadOid: '0'.repeat(40),
        })).rejects.toThrow(/PR head or duplicate/i)
        expect(fixtureMod.repositoryFixtureSnapshot().headOid).toBe(okCommit.commitOid)
        expect(fixtureMod.repositoryFixtureSnapshot().pullRequest).toBeNull()
        const rows = (await readFile(logPath, 'utf8')).trim().split('\n')
        expect(rows).toHaveLength(1)
      } finally {
        if (prevDelivery === undefined) delete process.env.DSH_REPO_VERIFIED_DELIVERY
        else process.env.DSH_REPO_VERIFIED_DELIVERY = prevDelivery
        if (prevLog === undefined) delete process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
        else process.env.DSH_REPO_DELIVERY_FIXTURE_LOG = prevLog
        if (prevState === undefined) delete process.env.DSH_REPO_EVENT_STATE
        else process.env.DSH_REPO_EVENT_STATE = prevState
        if (prevMode === undefined) delete process.env.DSH_REPO_DELIVERY_MODE
        else process.env.DSH_REPO_DELIVERY_MODE = prevMode
      }
    })
  })
})
