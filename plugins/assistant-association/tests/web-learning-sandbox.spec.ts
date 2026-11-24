import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  buildWebLearningSubprocessPlan,
  buildWebLearningSubprocessRequest,
  createSandboxedWebLearningRunner,
  createSubprocessWebLearningRunner,
  normalizeAssociationDreamingConfig,
  normalizeAssociationIntakeSignalConfig,
  normalizeAssociationWebLearningConfig,
  normalizeConfig,
  type WebLearningWorkerInput,
} from '../src/index.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeNonTmpDir(prefix: string): Promise<string> {
  const resolvedTmp = await realpath(tmpdir())
  const runnerTemp = process.env.RUNNER_TEMP ? await realpath(process.env.RUNNER_TEMP) : ''
  const base =
    resolve(resolvedTmp) !== '/tmp'
      ? resolvedTmp
      : runnerTemp && resolve(runnerTemp) !== '/tmp'
        ? runnerTemp
        : dirname(fileURLToPath(import.meta.url))
  const dir = await realpath(await mkdtemp(join(base, prefix)))
  tempDirs.push(dir)
  return dir
}

function makeSampleInput(overrides?: Partial<WebLearningWorkerInput>): WebLearningWorkerInput {
  return {
    runId: 'sandbox-test-run',
    allowedDomains: ['docs.example.com'],
    targets: [],
    budget: {
      maxRequests: 2,
      maxPages: 2,
      maxBytesPerRequest: 4_096,
      maxTotalBytes: 8_192,
      maxDurationMs: 5_000,
      requestTimeoutMs: 2_000,
    },
    ...overrides,
  }
}

function makeMockSpawn(response: {
  readonly code?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly stdout?: string
  readonly stderr?: string
  readonly onSpawn?: (cmd: string, args: readonly string[], options: Record<string, unknown>) => void
}) {
  return ((cmd: string, args: readonly string[], options: Record<string, unknown>) => {
    response.onSpawn?.(cmd, args, options)
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => boolean
    }
    child.pid = 424242
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true

    queueMicrotask(() => {
      if (response.stdout) child.stdout.end(response.stdout)
      else child.stdout.end()
      if (response.stderr) child.stderr.end(response.stderr)
      else child.stderr.end()
      child.emit('close', response.code ?? 0, response.signal ?? null)
    })

    return child as never
  }) as never
}

const HAS_LINUX_BWRAP = process.platform === 'linux' && existsSync('/usr/bin/bwrap')

describe('WP09 S4 OS-level sandbox & R3 S3/S4 defaults', () => {
  test.skipIf(!HAS_LINUX_BWRAP)(
    'real Linux bwrap execution enforces 0o700 canonical cwd, scrubbed env, host FS isolation, network:none, and SIGKILL timeout',
    async () => {
      const root = await makeNonTmpDir('assoc-s4-bwrap-')
      const scriptsDir = join(root, 'scripts')
      const scratchBase = join(root, 'scratch')
      const hostSecretDir = join(root, 'host-secret')
      await mkdir(scriptsDir, { recursive: true })
      await mkdir(scratchBase, { recursive: true })
      await mkdir(hostSecretDir, { recursive: true })

      const hostSecretFile = join(hostSecretDir, 'secret.txt')
      await writeFile(hostSecretFile, 'TOP_SECRET_HOST_DATA', 'utf8')

      const probeWorker = join(scriptsDir, 'bwrap-probe.mjs')
      await writeFile(
        probeWorker,
        [
          "import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'",
          "import { createConnection } from 'node:net'",
          "let raw = ''",
          "for await (const chunk of process.stdin) raw += chunk",
          'const input = JSON.parse(raw)',
          'const cwd = process.cwd()',
          'const mode = statSync(cwd).mode & 0o777',
          'const entries = readdirSync(cwd)',
          `const secretReadable = existsSync(${JSON.stringify(hostSecretFile)})`,
          'let outsideWriteBlocked = false',
          `try { writeFileSync(${JSON.stringify(join(scriptsDir, 'escape.txt'))}, 'x') } catch { outsideWriteBlocked = true }`,
          'let netConnectError = null',
          'await new Promise((resolve) => {',
          '  const sock = createConnection({ host: "127.0.0.1", port: 9, timeout: 250 })',
          '  sock.once("error", (err) => { netConnectError = err.code ?? err.message; sock.destroy(); resolve() })',
          '  sock.once("timeout", () => { netConnectError = "TIMEOUT"; sock.destroy(); resolve() })',
          '  sock.once("connect", () => { netConnectError = "CONNECTED"; sock.destroy(); resolve() })',
          '})',
          'const leaked = ["DEEPSEEK_API_KEY","GITHUB_TOKEN","OPENAI_API_KEY","DSH_HOME","COOKIE","NODE_OPTIONS"].filter(k => k in process.env)',
          'process.stdout.write(JSON.stringify({',
          '  runId: input.runId,',
          '  status: mode === 0o700 && entries.length === 0 && !secretReadable && outsideWriteBlocked && leaked.length === 0 && process.env.HOME === cwd && process.env.TMPDIR === cwd ? "completed" : "rejected",',
          '  reason: JSON.stringify({ mode, entries, secretReadable, outsideWriteBlocked, netConnectError, leaked, homeEqCwd: process.env.HOME === cwd, tmpdirEqCwd: process.env.TMPDIR === cwd }),',
          '  startedAt: Date.now(),',
          '  finishedAt: Date.now(),',
          '  requestsUsed: 0, pagesFetched: 0, bytesFetched: 0, pages: [], attempts: [],',
          '  environmentProof: { pid: process.pid, cwd, envKeys: Object.keys(process.env).sort() },',
          '}))',
        ].join('\n'),
        'utf8',
      )

      const runner = createSandboxedWebLearningRunner({
        workerEntryPath: probeWorker,
        tempBaseDir: scratchBase,
        backend: 'linux-native',
        network: 'none',
        sourceEnv: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: '/home/host-secret-user',
          TMPDIR: '/tmp/host-tmp',
          DEEPSEEK_API_KEY: 'sk-leak',
          GITHUB_TOKEN: 'ghp-leak',
          OPENAI_API_KEY: 'sk-openai-leak',
          DSH_HOME: '/data00/dsh-secret',
          COOKIE: 'session=abc',
          NODE_OPTIONS: '--require /tmp/evil.js',
        },
      })

      const out = await runner.run(makeSampleInput({ runId: 'bwrap-probe-1' }))
      expect(out.status).toBe('completed')
      const details = JSON.parse(out.reason) as Record<string, unknown>
      expect(details).toMatchObject({
        mode: 0o700,
        entries: [],
        secretReadable: false,
        outsideWriteBlocked: true,
        leaked: [],
        homeEqCwd: true,
        tmpdirEqCwd: true,
      })
      // With network: 'none' (--unshare-net), loopback/external socket connect fails immediately with ENETUNREACH/ECONNREFUSED
      expect(typeof details.netConnectError).toBe('string')
      expect(details.netConnectError).not.toBe('CONNECTED')
      expect(existsSync(out.environmentProof.cwd)).toBe(false)
      expect(readdirSync(scratchBase)).toEqual([])
      expect(readFileSync(hostSecretFile, 'utf8')).toBe('TOP_SECRET_HOST_DATA')
    },
  )

  test('builds cross-platform sandbox plans for linux-native, macos-seatbelt, and windows-job with safe bounds and path filtering', () => {
    const input = makeSampleInput({
      budget: {
        maxRequests: 2,
        maxPages: 2,
        maxBytesPerRequest: 4_096,
        maxTotalBytes: 8_192,
        maxDurationMs: 500_000, // exceeds 300_000 cross-platform cap
        requestTimeoutMs: 5_000,
      },
    })

    // 1. Linux plan: outbound-https omits --unshare-net; none passes --unshare-net; bounds enforced
    const linuxReq = buildWebLearningSubprocessRequest(input, {
      cwd: '/var/lib/dsh/scratch/dsh-web-learn-1',
      command: '/opt/node/bin/node',
      workerEntryPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-worker.js',
      selfPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-runner.js',
      homeDir: '/home/alice',
      platform: 'linux',
      backend: 'linux-native',
      maxStdoutBytes: 8 * 1024 * 1024, // capped so stdout + stderr <= 4 MiB
      readOnlyPaths: [
        '/',
        '/usr',
        '/home',
        '/home/alice',
        '/var/lib/dsh/scratch',
        '/var/lib/dsh/scratch/dsh-web-learn-1',
        '/opt/extra-ro',
        ...Array.from({ length: 40 }, (_, i) => `/opt/extra/p-${i}`),
      ],
    })
    expect(linuxReq.timeoutMs).toBe(300_000)
    expect(linuxReq.maxStdoutBytes! + linuxReq.maxStderrBytes!).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(linuxReq.readOnlyPaths!.length).toBeLessThanOrEqual(32)
    expect(linuxReq.readOnlyPaths).toContain('/opt/node/bin')
    expect(linuxReq.readOnlyPaths).toContain('/opt/dsh/plugins/assistant-association/lib')
    expect(linuxReq.readOnlyPaths).toContain('/opt/dsh/plugins/assistant-association')
    expect(linuxReq.readOnlyPaths).not.toContain('/')
    expect(linuxReq.readOnlyPaths).not.toContain('/usr')
    expect(linuxReq.readOnlyPaths).not.toContain('/home')
    expect(linuxReq.readOnlyPaths).not.toContain('/home/alice')
    expect(linuxReq.readOnlyPaths).not.toContain('/var/lib/dsh/scratch')
    expect(linuxReq.readOnlyPaths).not.toContain('/var/lib/dsh/scratch/dsh-web-learn-1')

    const linuxPlanHttps = buildWebLearningSubprocessPlan(input, {
      cwd: '/var/lib/dsh/scratch/dsh-web-learn-1',
      command: '/opt/node/bin/node',
      workerEntryPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-worker.js',
      selfPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-runner.js',
      homeDir: '/home/alice',
      platform: 'linux',
      backend: 'linux-native',
      network: 'outbound-https',
    })
    expect(linuxPlanHttps.backend).toBe('linux-native')
    expect(linuxPlanHttps.network).toBe('outbound-https')
    expect(linuxPlanHttps.args).not.toContain('--unshare-net')

    const linuxPlanNone = buildWebLearningSubprocessPlan(input, {
      cwd: '/var/lib/dsh/scratch/dsh-web-learn-1',
      command: '/opt/node/bin/node',
      workerEntryPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-worker.js',
      selfPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-runner.js',
      homeDir: '/home/alice',
      platform: 'linux',
      backend: 'linux-native',
      network: 'none',
    })
    expect(linuxPlanNone.args).toContain('--unshare-net')

    // 2. macOS Seatbelt plan: filters /Users, /private, /System, /usr, $HOME & ancestors, scratch ancestors
    const macPlanHttps = buildWebLearningSubprocessPlan(input, {
      cwd: '/private/var/folders/xx/dsh-web-learn-1',
      command: '/opt/homebrew/bin/node',
      workerEntryPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-worker.js',
      selfPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-runner.js',
      homeDir: '/Users/alice',
      platform: 'darwin',
      backend: 'macos-seatbelt',
      network: 'outbound-https',
      readOnlyPaths: ['/Users', '/Users/alice', '/private', '/System', '/usr', '/private/var/folders/xx'],
    })
    expect(macPlanHttps.backend).toBe('macos-seatbelt')
    expect(macPlanHttps.network).toBe('outbound-https')
    expect(macPlanHttps.executable).toBe('/usr/bin/sandbox-exec')
    expect(macPlanHttps.seatbeltProfile).toContain('(allow network-outbound')
    expect(macPlanHttps.readOnlyPaths).not.toContain('/Users')
    expect(macPlanHttps.readOnlyPaths).not.toContain('/Users/alice')
    expect(macPlanHttps.readOnlyPaths).not.toContain('/private')
    expect(macPlanHttps.readOnlyPaths).not.toContain('/private/var/folders/xx')

    const macPlanNone = buildWebLearningSubprocessPlan(input, {
      cwd: '/private/var/folders/xx/dsh-web-learn-1',
      command: '/opt/homebrew/bin/node',
      workerEntryPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-worker.js',
      selfPath: '/opt/dsh/plugins/assistant-association/lib/web-learning-runner.js',
      homeDir: '/Users/alice',
      platform: 'darwin',
      backend: 'macos-seatbelt',
      network: 'none',
    })
    expect(macPlanNone.seatbeltProfile).toContain('(deny default)')
    expect(macPlanNone.seatbeltProfile).not.toContain('network-outbound')

    // 3. Windows Job Object plan
    const winPlanHttps = buildWebLearningSubprocessPlan(input, {
      cwd: 'C:\\Users\\alice\\AppData\\Local\\Temp\\dsh-web-learn-1',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      workerEntryPath: 'C:\\dsh\\plugins\\assistant-association\\lib\\web-learning-worker.js',
      selfPath: 'C:\\dsh\\plugins\\assistant-association\\lib\\web-learning-runner.js',
      homeDir: 'C:\\Users\\alice',
      platform: 'win32',
      backend: 'windows-job',
      network: 'outbound-https',
    })
    expect(winPlanHttps.backend).toBe('windows-job')
    expect(winPlanHttps.network).toBe('outbound-https')
    expect(winPlanHttps.windowsJobLimits?.memoryLimitBytes).toBe(256 * 1024 * 1024)
    expect(winPlanHttps.windowsJobLimits?.activeProcessLimit).toBe(32)
  })

  test('executes cleanly via mocked macos-seatbelt and windows-job isolationAdapters and fails closed when primitives are unavailable', async () => {
    const root = await makeNonTmpDir('assoc-s4-cross-')
    const scratchBase = join(root, 'scratch')
    const scriptsDir = join(root, 'scripts')
    await mkdir(scratchBase, { recursive: true })
    await mkdir(scriptsDir, { recursive: true })

    const fakeWorker = join(scriptsDir, 'fake-worker.mjs')
    await writeFile(fakeWorker, '// mock', 'utf8')

    const successPayload = JSON.stringify({
      runId: 'mock-cross-1',
      status: 'completed',
      reason: 'ok',
      startedAt: 1000,
      finishedAt: 1001,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      pages: [],
      attempts: [],
      environmentProof: { pid: 1, cwd: scratchBase, envKeys: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'] },
    })

    // Mocked macOS Seatbelt execution
    let macObservedExec = ''
    let macObservedNetwork = false
    const macRunner = createSubprocessWebLearningRunner({
      workerEntryPath: fakeWorker,
      tempBaseDir: scratchBase,
      backend: 'macos-seatbelt',
      isolationAdapter: {
        platform: 'darwin',
        uid: 501,
        macos: {
          platform: 'darwin',
          uid: 501,
          sandboxExecPath: '/usr/bin/sandbox-exec',
          verifySandboxExec: async () => true,
          spawn: makeMockSpawn({
            stdout: successPayload,
            onSpawn: (cmd, args) => {
              macObservedExec = cmd
              macObservedNetwork = args.some((a) => a.includes('(allow network-outbound'))
            },
          }),
        },
      },
    })
    const macOut = await macRunner.run(makeSampleInput({ runId: 'mock-cross-1' }))
    expect(macOut.status).toBe('completed')
    expect(macObservedExec).toBe('/usr/bin/sandbox-exec')
    expect(macObservedNetwork).toBe(true)
    expect(readdirSync(scratchBase)).toEqual([])

    // Mocked Windows Job execution
    let winObservedNetworkMode = ''
    let winObservedMemoryLimit = 0
    const winRunner = createSubprocessWebLearningRunner({
      workerEntryPath: fakeWorker,
      tempBaseDir: scratchBase,
      backend: 'windows-job',
      isolationAdapter: {
        platform: 'win32',
        windows: {
          platform: 'win32',
          verifyRunner: async () => true,
          runJob: async (spec) => {
            winObservedNetworkMode = spec.networkMode
            winObservedMemoryLimit = spec.limits.memoryLimitBytes
            return {
              status: 'succeeded',
              quiescent: true,
              exitCode: 0,
              stdout: successPayload,
              stderr: '',
              artifacts: [],
            }
          },
        },
      },
    })
    const winOut = await winRunner.run(makeSampleInput({ runId: 'mock-cross-1' }))
    expect(winOut.status).toBe('completed')
    expect(winObservedNetworkMode).toBe('outbound-https')
    expect(winObservedMemoryLimit).toBe(256 * 1024 * 1024)
    expect(readdirSync(scratchBase)).toEqual([])

    // Fail-closed when Linux bwrap is missing (must throw, never fall back to unsandboxed spawn)
    let fallbackSpawnCalled = false
    const bwrapMissingRunner = createSubprocessWebLearningRunner({
      workerEntryPath: fakeWorker,
      tempBaseDir: scratchBase,
      backend: 'linux-native',
      isolationAdapter: {
        platform: 'linux',
        verifyExecutable: () => false,
        spawn: makeMockSpawn({
          stdout: successPayload,
          onSpawn: () => {
            fallbackSpawnCalled = true
          },
        }),
      },
    })
    await expect(bwrapMissingRunner.run(makeSampleInput())).rejects.toThrowError(
      /OS sandbox unavailable.*sandbox-unavailable:bwrap/i,
    )
    expect(fallbackSpawnCalled).toBe(false)
    expect(readdirSync(scratchBase)).toEqual([])

    // Fail-closed when macOS sandbox-exec is unavailable
    const macUnavailableRunner = createSubprocessWebLearningRunner({
      workerEntryPath: fakeWorker,
      tempBaseDir: scratchBase,
      backend: 'macos-seatbelt',
      isolationAdapter: {
        platform: 'darwin',
        uid: 501,
        macos: {
          platform: 'darwin',
          uid: 501,
          verifySandboxExec: async () => false,
          spawn: makeMockSpawn({
            stdout: successPayload,
            onSpawn: () => {
              fallbackSpawnCalled = true
            },
          }),
        },
      },
    })
    await expect(macUnavailableRunner.run(makeSampleInput())).rejects.toThrowError(
      /OS sandbox unavailable.*sandbox-exec-unavailable/i,
    )
    expect(fallbackSpawnCalled).toBe(false)
    expect(readdirSync(scratchBase)).toEqual([])

    // Fail-closed when Windows Job runner is unavailable
    const winUnavailableRunner = createSubprocessWebLearningRunner({
      workerEntryPath: fakeWorker,
      tempBaseDir: scratchBase,
      backend: 'windows-job',
      isolationAdapter: {
        platform: 'win32',
        windows: {
          platform: 'win32',
          verifyRunner: async () => false,
          spawn: makeMockSpawn({
            stdout: successPayload,
            onSpawn: () => {
              fallbackSpawnCalled = true
            },
          }),
        },
      },
    })
    await expect(winUnavailableRunner.run(makeSampleInput())).rejects.toThrowError(
      /OS sandbox unavailable.*windows-job-runner-unavailable/i,
    )
    expect(fallbackSpawnCalled).toBe(false)
    expect(readdirSync(scratchBase)).toEqual([])

    // Fail-closed on injected isolatedRunner returning sandboxed: false or output-limit
    const unsandboxedResultRunner = createSandboxedWebLearningRunner({
      workerEntryPath: fakeWorker,
      tempBaseDir: scratchBase,
      isolatedRunner: async () => ({
        backend: 'linux-native',
        sandboxed: false,
        status: 'failed',
        exitCode: null,
        processSignal: null,
        stdout: '',
        stderr: '',
        reason: 'mock-sandbox-failed',
      }),
    })
    await expect(unsandboxedResultRunner.run(makeSampleInput())).rejects.toThrowError(
      /OS sandbox unavailable.*mock-sandbox-failed/i,
    )
    expect(readdirSync(scratchBase)).toEqual([])

    const outputLimitRunner = createSandboxedWebLearningRunner({
      workerEntryPath: fakeWorker,
      tempBaseDir: scratchBase,
      maxStdoutBytes: 1024,
      isolatedRunner: async () => ({
        backend: 'linux-native',
        sandboxed: true,
        status: 'output-limit',
        exitCode: null,
        processSignal: 'SIGKILL',
        stdout: '',
        stderr: '',
        reason: 'stdout-limit',
      }),
    })
    await expect(outputLimitRunner.run(makeSampleInput())).rejects.toThrowError(
      /stdout exceeded 1024 bytes/i,
    )
    expect(readdirSync(scratchBase)).toEqual([])

    // Timeout escalation to SIGKILL when sandbox process ignores SIGTERM
    let mockProc: (EventEmitter & { emit: (ev: string, ...args: unknown[]) => boolean }) | undefined
    const sigkillRunner = createSandboxedWebLearningRunner({
      workerEntryPath: fakeWorker,
      tempBaseDir: scratchBase,
      killGraceMs: 40,
      runnerTimeoutBufferMs: 0,
      backend: 'linux-native',
      isolationAdapter: {
        platform: 'linux',
        verifyExecutable: () => true,
        killProcessGroup: (_pid, sig) => {
          if (sig === 'SIGKILL') {
            mockProc?.emit('close', null, 'SIGKILL')
          }
        },
        spawn: (() => {
          const proc = new EventEmitter() as EventEmitter & {
            pid: number
            stdin: PassThrough
            stdout: PassThrough
            stderr: PassThrough
            kill: () => boolean
          }
          proc.pid = 515152
          proc.stdin = new PassThrough()
          proc.stdout = new PassThrough()
          proc.stderr = new PassThrough()
          proc.kill = () => true
          mockProc = proc
          return proc as never
        }) as never,
      },
    })
    await expect(
      sigkillRunner.run(
        makeSampleInput({
          budget: {
            maxRequests: 1,
            maxPages: 1,
            maxBytesPerRequest: 1_024,
            maxTotalBytes: 1_024,
            maxDurationMs: 60,
            requestTimeoutMs: 60,
          },
        }),
      ),
    ).rejects.toThrowError(/timed out.*SIGKILL/i)
    expect(readdirSync(scratchBase)).toEqual([])
  })

  test('enforces R3 default-on S3/S4 config, explicit enabled:false opt-out, and cordis.patch.yml alignment', () => {
    const defaults = normalizeConfig({ databasePath: ':memory:' })
    expect(defaults.dreaming.enabled).toBe(true)
    expect(defaults.intakeSignal.enabled).toBe(true)
    expect(defaults.webLearning.enabled).toBe(true)
    expect(defaults.webLearning.allowedDomains).toEqual([])

    expect(normalizeAssociationDreamingConfig().enabled).toBe(true)
    expect(normalizeAssociationDreamingConfig({ enabled: false }).enabled).toBe(false)
    expect(normalizeAssociationIntakeSignalConfig().enabled).toBe(true)
    expect(normalizeAssociationIntakeSignalConfig({ enabled: false }).enabled).toBe(false)
    expect(normalizeAssociationWebLearningConfig().enabled).toBe(true)
    expect(normalizeAssociationWebLearningConfig({ enabled: false }).enabled).toBe(false)

    const optedOut = normalizeConfig({
      databasePath: ':memory:',
      dreaming: { enabled: false },
      intakeSignal: { enabled: false },
      webLearning: { enabled: false },
    })
    expect(optedOut.dreaming.enabled).toBe(false)
    expect(optedOut.intakeSignal.enabled).toBe(false)
    expect(optedOut.webLearning.enabled).toBe(false)

    // Verify cordis.patch.yml keeps inject: [assistantPolicy] and flips S3/S4 defaults to true
    const patchRaw = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patchRaw).toMatch(/inject:\s*\n\s*-\s*assistantPolicy\b/u)
    expect(patchRaw).not.toContain('assistantIsolation')
    expect(patchRaw).toMatch(/dreaming:\s*\n\s*enabled:\s*true\b/u)
    expect(patchRaw).toMatch(/intakeSignal:\s*\n\s*enabled:\s*true\b/u)
    expect(patchRaw).toMatch(/webLearning:\s*\n\s*enabled:\s*true\b/u)
  })
})
