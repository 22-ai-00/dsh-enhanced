import { Context } from '@deepseek-ai/cordis'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import {
  archiveIsolationAudit,
  AssistantIsolationService,
  buildScrubbedWindowsEnv,
  buildWindowsJobSpec,
  computeWindowsJobLimits,
  inspectIsolationGrant,
  IsolatedVerifierRunner,
  isolationPrincipalDigest,
  quoteWindowsArg,
  runWindowsJobProcess,
  verifyIsolationAuditArchive,
  WINDOWS_JOB_LIMIT_FLAGS,
  WINDOWS_JOB_RUNNER_SCRIPT,
  WINDOWS_JOB_UI_RESTRICTIONS_FLAGS,
  type WindowsJobAdapter,
} from '../src/index.js'
import { reconcileIsolation, revokeIsolationGrant } from '../src/cli.js'
import { IsolationLedger } from '../src/ledger.js'

const roots: string[] = []
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  await chmod(dir, 0o700)
  roots.push(dir)
  return dir
}

describe('windows-job isolation policy, PowerShell P/Invoke runner, schema-10 ledger, and adapters', () => {
  test('runtime/windows-job-runner.ps1 contains required Win32 Job Object P/Invoke enforcement and zero breakaway flags', async () => {
    const ps1 = await readFile(WINDOWS_JOB_RUNNER_SCRIPT, 'utf8')
    expect(ps1).toContain('CreateJobObjectW')
    expect(ps1).toContain('SetInformationJobObject')
    expect(ps1).toContain('QueryInformationJobObject')
    expect(ps1).toContain('CreateProcessW')
    expect(ps1).toContain('AssignProcessToJobObject')
    expect(ps1).toContain('ResumeThread')
    expect(ps1).toContain('TerminateJobObject')
    expect(ps1).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(ps1).toContain('JOB_OBJECT_LIMIT_ACTIVE_PROCESS')
    expect(ps1).toContain('JOB_OBJECT_LIMIT_PROCESS_MEMORY')
    expect(ps1).toContain('JOB_OBJECT_LIMIT_JOB_MEMORY')
    expect(ps1).toContain('JobObjectBasicUIRestrictions')
    expect(ps1).toContain('JobObjectCpuRateControlInformation')
    expect(ps1).not.toContain('BREAKAWAY_OK')
    expect(ps1).toContain('Task writeStdin = Task.Run')
    expect(ps1).toContain('QueryActiveProcesses(hJob) > 0')
    expect(ps1).toContain('System.StringComparer]::OrdinalIgnoreCase')
    expect(ps1).toContain('MaxJsonLength = [int]::MaxValue')
    expect(ps1.indexOf('Task readOut')).toBeLessThan(ps1.indexOf('Task writeStdin'))
    expect(ps1.indexOf('Task readErr')).toBeLessThan(ps1.indexOf('Task writeStdin'))
  })

  test('builds Win32 Job limits, command quoting, and scrubbed offline/online environments', () => {
    expect(quoteWindowsArg('simple')).toBe('simple')
    expect(quoteWindowsArg('with spaces "and" quotes')).toBe('"with spaces \\"and\\" quotes"')

    const limits = computeWindowsJobLimits({
      timeoutMs: 5_000,
      memoryMiB: 256,
      pidsLimit: 16,
      cpus: 0.5,
      cpuCount: 4,
    })
    expect(limits.killOnJobClose).toBe(true)
    expect(limits.breakawayAllowed).toBe(false)
    expect(limits.activeProcessLimit).toBe(16)
    expect(limits.memoryLimitBytes).toBe(256 * 1024 * 1024)
    expect(limits.perJobUserTimeLimit100Ns).toBe(50_000_000)
    expect(limits.cpuRate).toBe(1250)
    expect(limits.uiRestrictionsFlags).toBe(WINDOWS_JOB_UI_RESTRICTIONS_FLAGS)
    expect(limits.limitFlags & WINDOWS_JOB_LIMIT_FLAGS.KILL_ON_JOB_CLOSE).toBeTruthy()
    expect(limits.limitFlags & WINDOWS_JOB_LIMIT_FLAGS.ACTIVE_PROCESS).toBeTruthy()

    const offlineEnv = buildScrubbedWindowsEnv({
      workspacePath: 'C:\\Users\\alice\\ws',
      tmpPath: 'C:\\Users\\alice\\tmp',
      networkMode: 'none',
      env: {
        HTTP_PROXY: 'http://127.0.0.1:8080',
        HTTPS_PROXY: 'https://127.0.0.1:8443',
        ALL_PROXY: 'socks5://127.0.0.1:1080',
        NODE_OPTIONS: '--require evil.js',
        node_options: '--require lower-evil.js',
        PATH: 'C:\\evil\\bin',
        path: 'C:\\evil\\lower',
        PATHEXT: '.JS;.VBS',
        pathext: '.VBE',
        ComSpec: 'C:\\evil\\cmd.exe',
        SystemRoot: 'C:\\evil-win',
        windir: 'C:\\evil-win',
        temp: 'C:\\evil-tmp',
        tmp: 'C:\\evil-tmp',
        userprofile: 'C:\\evil-profile',
        home: 'C:\\evil-home',
        CustomCase: 'first',
        customcase: 'second',
        SAFE_TOKEN: 'ok',
      },
    })
    expect(offlineEnv.HTTP_PROXY).toBeUndefined()
    expect(offlineEnv.HTTPS_PROXY).toBeUndefined()
    expect(offlineEnv.ALL_PROXY).toBeUndefined()
    expect(offlineEnv.NODE_OPTIONS).toBeUndefined()
    expect(offlineEnv.node_options).toBeUndefined()
    expect(offlineEnv.PATH).toBe('C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
    expect(offlineEnv.path).toBeUndefined()
    expect(offlineEnv.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD')
    expect(offlineEnv.pathext).toBeUndefined()
    expect(offlineEnv.COMSPEC).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(offlineEnv.ComSpec).toBeUndefined()
    expect(offlineEnv.SystemRoot).toBe('C:\\Windows')
    expect(offlineEnv.WINDIR).toBe('C:\\Windows')
    expect(offlineEnv.windir).toBeUndefined()
    expect(offlineEnv.TEMP).toBe('C:\\Users\\alice\\tmp')
    expect(offlineEnv.temp).toBeUndefined()
    expect(offlineEnv.TMP).toBe('C:\\Users\\alice\\tmp')
    expect(offlineEnv.tmp).toBeUndefined()
    expect(offlineEnv.USERPROFILE).toBe('C:\\Users\\alice\\ws')
    expect(offlineEnv.userprofile).toBeUndefined()
    expect(offlineEnv.HOME).toBe('C:\\Users\\alice\\ws')
    expect(offlineEnv.home).toBeUndefined()
    expect(offlineEnv.CustomCase).toBeUndefined()
    expect(offlineEnv.customcase).toBe('second')
    const upperKeys = Object.keys(offlineEnv).map(k => k.toUpperCase())
    expect(new Set(upperKeys).size).toBe(upperKeys.length)
    expect(offlineEnv.SAFE_TOKEN).toBe('ok')

    const onlineEnv = buildScrubbedWindowsEnv({
      workspacePath: 'C:\\Users\\alice\\ws',
      tmpPath: 'C:\\Users\\alice\\tmp',
      networkMode: 'outbound-https',
      env: { HTTPS_PROXY: 'https://proxy.corp:8443' },
    })
    expect(onlineEnv.HTTPS_PROXY).toBe('https://proxy.corp:8443')

    const spec = buildWindowsJobSpec({
      workspacePath: 'C:\\Users\\alice\\ws',
      tmpPath: 'C:\\Users\\alice\\tmp',
      command: 'echo hello',
      shell: 'cmd',
      networkMode: 'none',
      stdin: 'in-data',
      deadline: Date.now() + 10_000,
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      cpuCount: 4,
    })
    expect(spec.commandLine).toBe('C:\\Windows\\System32\\cmd.exe /d /s /c "echo hello"')
    expect(Buffer.from(spec.stdinBase64, 'base64').toString('utf8')).toBe('in-data')
    expect(spec.limits.breakawayAllowed).toBe(false)
  })

  test('runWindowsJobProcess validates platform, symlinks, runner availability, and handles mocked PowerShell spawn + artifacts', async () => {
    const root = await makeTempDir('win-proc-')
    const ws = join(root, 'ws')
    const tmp = join(root, 'tmp')
    await mkdir(ws, { mode: 0o700 })
    await mkdir(tmp, { mode: 0o700 })

    // Wrong platform
    expect(await runWindowsJobProcess({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'linux' })).toMatchObject({ status: 'failed', quiescent: true, reason: 'windows-required' })

    // Missing PowerShell runner
    expect(await runWindowsJobProcess({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'win32', verifyRunner: async () => false })).toMatchObject({ status: 'failed', quiescent: true, reason: 'windows-job-runner-unavailable' })

    // Symlink in workspace rejected
    await symlink('/etc/hosts', join(ws, 'escape'))
    expect(await runWindowsJobProcess({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'win32', verifyRunner: async () => true })).toMatchObject({ status: 'failed', quiescent: true, reason: 'invalid-private-workspace' })
    await rm(join(ws, 'escape'))

    // Mocked PowerShell spawn returning JSON envelope and verifying cancel signal forwarding
    await writeFile(join(ws, 'result.txt'), 'win-artifact', { mode: 0o600 })
    let sawSpecFile = false
    const okSpawn = ((_cmd: string, args: readonly string[]) => {
      const specIndex = args.indexOf('-SpecPath')
      sawSpecFile = specIndex >= 0 && typeof args[specIndex + 1] === 'string'
      const proc = new EventEmitter() as EventEmitter & {
        stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean
      }
      proc.stdin = new PassThrough()
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = () => true
      queueMicrotask(() => {
        const payload = {
          schemaVersion: 1,
          status: 'succeeded',
          quiescent: true,
          exitCode: 0,
          stdoutBase64: Buffer.from('win-stdout\n', 'utf8').toString('base64'),
          stderrBase64: Buffer.from('', 'utf8').toString('base64'),
          pid: 9001,
          activeProcessesRemaining: 0,
          reason: '',
        }
        proc.stdout.end(`${JSON.stringify(payload)}\n`)
        proc.emit('close', 0, null)
      })
      return proc as never
    }) as never

    const ok = await runWindowsJobProcess({
      workspacePath: ws,
      tmpPath: tmp,
      command: 'echo win-stdout',
      artifacts: ['result.txt'],
      deadline: Date.now() + 10_000,
      maxOutputBytes: 4096,
      maxArtifactBytes: 1024,
      signal: new AbortController().signal,
    }, {
      platform: 'win32',
      verifyRunner: async () => true,
      spawn: okSpawn,
    })
    expect(sawSpecFile).toBe(true)
    expect(ok).toMatchObject({
      status: 'succeeded',
      quiescent: true,
      exitCode: 0,
      stdout: 'win-stdout\n',
      pid: 9001,
      artifacts: [{ path: 'result.txt', content: 'win-artifact' }],
    })

    // Cancellation creates cancelFilePath and spawns powershell with ignored stdin
    let sawIgnoreStdin = false
    let sawCancelFile = false
    let sawControlOnStdinFalse = false
    const abortController = new AbortController()
    const cancelSpawn = ((_cmd: string, args: readonly string[], options?: { stdio?: unknown[] }) => {
      sawIgnoreStdin = Array.isArray(options?.stdio) && options.stdio[0] === 'ignore'
      const specIndex = args.indexOf('-SpecPath')
      const specPath = specIndex >= 0 ? String(args[specIndex + 1]) : ''
      const parsedSpec = JSON.parse(readFileSync(specPath, 'utf8')) as {
        controlOnStdin?: boolean
        cancelFilePath?: string
      }
      sawControlOnStdinFalse = parsedSpec.controlOnStdin === false
      const cancelFilePath = parsedSpec.cancelFilePath ?? ''
      const proc = new EventEmitter() as EventEmitter & {
        stdin: null; stdout: PassThrough; stderr: PassThrough; kill: () => boolean
      }
      proc.stdin = null
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = () => true
      const timer = setInterval(() => {
        if (cancelFilePath && existsSync(cancelFilePath)) {
          clearInterval(timer)
          sawCancelFile = true
          const payload = {
            schemaVersion: 1,
            status: 'cancelled',
            quiescent: true,
            exitCode: 1,
            stdoutBase64: '',
            stderrBase64: '',
            pid: 9002,
            activeProcessesRemaining: 0,
            reason: 'cancelled',
          }
          proc.stdout.end(`${JSON.stringify(payload)}\n`)
          proc.emit('close', 1, null)
        }
      }, 10)
      proc.once('close', () => clearInterval(timer))
      setTimeout(() => abortController.abort(), 20)
      return proc as never
    }) as never

    const cancelled = await runWindowsJobProcess({
      workspacePath: ws,
      tmpPath: tmp,
      command: 'ping -n 30 127.0.0.1',
      deadline: Date.now() + 10_000,
      maxOutputBytes: 4096,
      signal: abortController.signal,
    }, {
      platform: 'win32',
      verifyRunner: async () => true,
      spawn: cancelSpawn,
    })
    expect(sawIgnoreStdin).toBe(true)
    expect(sawControlOnStdinFalse).toBe(true)
    expect(sawCancelFile).toBe(true)
    expect(cancelled).toMatchObject({ status: 'cancelled', quiescent: true })

    // Read-only (0o500) parent directory for workspacePath does not EACCES when writing spec file
    const roParent = join(root, 'ro-parent')
    const roWs = join(roParent, 'ws')
    await mkdir(roWs, { recursive: true, mode: 0o700 })
    await chmod(roWs, 0o700)
    await chmod(roParent, 0o500)
    let capturedSpecDir = ''
    try {
      const roResult = await runWindowsJobProcess({
        workspacePath: roWs,
        tmpPath: tmp,
        command: 'echo ok',
        deadline: Date.now() + 10_000,
        maxOutputBytes: 4096,
        signal: new AbortController().signal,
      }, {
        platform: 'win32',
        verifyRunner: async () => true,
        spawn: ((_cmd: string, args: readonly string[]) => {
          const specIdx = args.indexOf('-SpecPath')
          capturedSpecDir = specIdx >= 0 ? String(args[specIdx + 1]) : ''
          const proc = new EventEmitter() as EventEmitter & {
            stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean
          }
          proc.stdin = new PassThrough()
          proc.stdout = new PassThrough()
          proc.stderr = new PassThrough()
          proc.kill = () => true
          queueMicrotask(() => {
            proc.stdout.end(`${JSON.stringify({
              schemaVersion: 1,
              status: 'succeeded',
              quiescent: true,
              exitCode: 0,
              stdoutBase64: Buffer.from('ro-ok', 'utf8').toString('base64'),
              stderrBase64: '',
              pid: 9003,
              activeProcessesRemaining: 0,
              reason: '',
            })}\n`)
            proc.emit('close', 0, null)
          })
          return proc as never
        }) as never,
      })
      expect(roResult).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'ro-ok' })
      expect(capturedSpecDir).not.toContain(roParent)
    } finally {
      await chmod(roParent, 0o700).catch(() => {})
    }
  })

  test('IsolationLedger keeps schema 9 by default, lazily upgrades 9 -> 10 for windows-job, and diagnostics + audit-archive accept schema 10', async () => {
    const root = await makeTempDir('win-schema10-')
    const stateRoot = join(root, 'state')
    const archiveDir = join(root, 'archive')
    await mkdir(stateRoot, { mode: 0o700 })
    await mkdir(archiveDir, { mode: 0o700 })
    const dbPath = join(stateRoot, 'ledger.sqlite')

    const ledger = new IsolationLedger(dbPath, { now: () => 10_000 })
    const dbCheck9 = new DatabaseSync(dbPath, { readOnly: true })
    expect(dbCheck9.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
    dbCheck9.close()

    const identity = {
      principalDigest: 'a'.repeat(64),
      principalRecordId: 'owner',
      principalVersion: 1,
      workspace: stateRoot,
      agentPreset: 'primary',
    }
    const grant = {
      ...identity,
      id: 'win-grant',
      revision: 1,
      expiresAt: 100_000,
      maxRuns: 5,
      maxTotalDurationMs: 10_000,
    }
    const auth = ledger.claimController('host', 30_000)
    ledger.syncGrants([grant], auth)

    // Preparing windows-job triggers atomic 9 -> 10 upgrade
    const prepared = ledger.prepare({
      identity,
      sessionId: 'sess-1',
      grantId: 'win-grant',
      idempotencyKey: 'win-k1',
      requestDigest: 'b'.repeat(64),
      durationMs: 1000,
      backend: 'windows-job',
      resourceReservation: {
        memoryMiB: 256,
        workspaceInodes: 0,
        maxMemoryMiB: 2048,
        maxWorkspaceInodes: 32_768,
      },
      storageBudget: {
        maxStateBytes: 256 * 1024 * 1024,
        maxJobRecords: 10_000,
        reservedBytes: 1024 * 1024,
        observation: { bytes: 0, observedAt: 10_000 },
      },
      authority: auth,
    }).job
    expect(prepared.backend).toBe('windows-job')
    expect(prepared.reservedMemoryMiB).toBe(256)
    expect(prepared.reservedWorkspaceInodes).toBe(0)

    const dispatched = ledger.markDispatched(prepared.id, prepared.version, auth)
    const started = ledger.start(dispatched.id, dispatched.version, auth)
    const settled = ledger.settleNativeReceipt(started.id, started.version, {
      requestDigest: started.requestDigest,
      nonce: started.nativeNonce!,
      nativeResourceId: started.nativeResourceId!,
    }, {
      jobId: started.id,
      status: 'succeeded',
      quiescent: true,
      exitCode: 0,
      stdout: 'win-ok',
      stderr: '',
      artifacts: [],
    }, auth)
    expect(settled.status).toBe('succeeded')
    ledger.releaseController(auth)
    ledger.close()

    const dbCheck10 = new DatabaseSync(dbPath, { readOnly: true })
    expect(dbCheck10.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    expect(dbCheck10.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get()).toEqual({ value: '10' })
    dbCheck10.close()

    // Diagnostics & audit-archive accept schema 10
    expect(inspectIsolationGrant({ stateRoot, grant, now: 10_000 })).toMatchObject({
      status: 'available',
      runsUsed: 1,
      remainingRuns: 4,
    })
    const archived = archiveIsolationAudit({ stateRoot, archiveDirectory: archiveDir })
    expect(archived.verification.valid).toBe(true)
    expect(verifyIsolationAuditArchive(archiveDir).recordCount).toBe(archived.verification.recordCount)
  })

  test('IsolatedVerifierRunner & AssistantIsolationService run windows-job end-to-end with crash recovery and CLI reconcile', async () => {
    const root = await makeTempDir('win-e2e-')
    const verifierState = join(root, 'verifier-state')
    const serviceState = join(root, 'service-state')
    const project = join(root, 'project')
    await mkdir(verifierState, { mode: 0o700 })
    await mkdir(serviceState, { mode: 0o700 })
    await mkdir(project, { mode: 0o700 })

    // 1. IsolatedVerifierRunner with backend: 'windows-job'
    let verifierRuns = 0
    const verifierAdapter: WindowsJobAdapter = {
      platform: 'win32',
      verifyRunner: async () => true,
      runJob: async spec => {
        verifierRuns += 1
        expect(spec.limits.killOnJobClose).toBe(true)
        expect(spec.limits.breakawayAllowed).toBe(false)
        const artifact = await readFile(join(spec.cwd, 'artifact'), 'utf8')
        return {
          status: 'succeeded',
          quiescent: true,
          exitCode: 0,
          stdout: `win-verify:${artifact}`,
          stderr: '',
          artifacts: [],
        }
      },
    }

    const runner = new IsolatedVerifierRunner({
      backend: 'windows-job',
      stateRoot: verifierState,
      authorityDigest: 'c'.repeat(64),
      command: 'type artifact',
      expiresAt: Date.now() + 60_000,
      maxRuns: 2,
      maxTotalDurationMs: 20_000,
      maxDurationMs: 5_000,
      maxOutputBytes: 4096,
      adapter: verifierAdapter,
    }, { platform: 'win32', allowHostPaths: true })

    try {
      const res1 = await runner.run('v-1', 'artifact-content', 'stdin-content', new AbortController().signal)
      expect(res1).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'win-verify:artifact-content' })
      expect(await runner.run('v-1', 'artifact-content', 'stdin-content', new AbortController().signal)).toEqual(res1)
      expect(verifierRuns).toBe(1)
    } finally {
      await runner.close()
    }

    // 2. AssistantIsolationService with backend: 'windows-job'
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: (agent: Agent) => ({
        principalId: 'win-owner',
        principalLineage: { principalRecordId: 'record-win-owner', principalVersion: 1 },
        scope: { workspace: project, preset: 'primary' },
        sessionId: String(agent.session.id),
      }),
    } as never)

    new AssistantPolicyService(ctx, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'deny',
      rules: [
        { id: 'run', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation_run' } },
        { id: 'discover', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation_grants' } },
        { id: 'grant', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation:win-offline' } },
      ],
    })

    const serviceAdapter: WindowsJobAdapter = {
      platform: 'win32',
      verifyRunner: async () => true,
      runJob: async spec => {
        const inputText = await readFile(join(spec.cwd, 'input.txt'), 'utf8')
        await writeFile(join(spec.cwd, 'exported.txt'), `win:${inputText}`, { mode: 0o600 })
        return {
          status: 'succeeded',
          quiescent: true,
          exitCode: 0,
          stdout: 'win-service-ok',
          stderr: '',
          artifacts: [],
        }
      },
    }

    const service = new AssistantIsolationService(ctx, {
      backend: 'windows-job',
      stateRoot: serviceState,
      limits: { maxDurationMs: 5000, maxOutputBytes: 4096 },
      grants: [{
        id: 'win-offline',
        revision: 1,
        principalDigest: isolationPrincipalDigest('win-owner'),
        principalRecordId: 'record-win-owner',
        principalVersion: 1,
        workspace: project,
        agentPreset: 'primary',
        expiresAt: Date.now() + 60_000,
        maxRuns: 3,
        maxTotalDurationMs: 30_000,
      }],
    }, { platform: 'win32', allowHostPaths: true, windowsAdapter: serviceAdapter })

    const agentHandle = await ctx.agents.create({ sessionId: SessionId('win-sess'), meta: { cwd: project, agentPreset: 'primary' } })
    try {
      await service.ready
      const runRes = await service.run(agentHandle.agent, {
        grantId: 'win-offline',
        idempotencyKey: 'win-svc-1',
        command: 'type input.txt > exported.txt',
        files: [{ path: 'input.txt', content: 'data' }],
        artifacts: ['exported.txt'],
      }, new AbortController().signal)

      expect(runRes).toMatchObject({
        status: 'succeeded',
        quiescent: true,
        stdout: 'win-service-ok',
        artifacts: [{ path: 'exported.txt', content: 'win:data' }],
      })
    } finally {
      await agentHandle.dispose()
      await ctx.fiber.dispose()
    }

    // Seed an unresolved dispatched windows-job with no receipt (should settle unknown/non-quiescent and retain)
    const ledger = new IsolationLedger(join(serviceState, 'ledger.sqlite'), { schemaVersion: 10 })
    const auth = ledger.claimController('recover-test', 30_000)
    const lost = ledger.prepare({
      identity: {
        principalDigest: isolationPrincipalDigest('win-owner'),
        principalRecordId: 'record-win-owner',
        principalVersion: 1,
        workspace: project,
        agentPreset: 'primary',
      },
      sessionId: 'win-sess',
      grantId: 'win-offline',
      idempotencyKey: 'win-lost',
      requestDigest: 'e'.repeat(64),
      durationMs: 1000,
      backend: 'windows-job',
      authority: auth,
    }).job
    ledger.markDispatched(lost.id, lost.version, auth)
    ledger.releaseController(auth)
    ledger.close()

    expect(await reconcileIsolation(serviceState)).toEqual({ checked: 1, released: 0, retained: 1 })
    expect(await revokeIsolationGrant(serviceState, 'win-offline', 1)).toMatchObject({
      revoked: true,
      nativeResourcesQuiescent: false,
      nativeRetained: 1,
    })
  })
})

describe.skipIf(process.platform !== 'win32')('real Windows Job Object execution', () => {
  test('executes cmd/powershell inside real Win32 Job Object and exports artifacts', async () => {
    const root = await makeTempDir('real-win-job-')
    const ws = join(root, 'ws')
    const tmp = join(root, 'tmp')
    await mkdir(ws, { mode: 0o700 })
    await mkdir(tmp, { mode: 0o700 })

    const result = await runWindowsJobProcess({
      workspacePath: ws,
      tmpPath: tmp,
      command: '(echo real-win)> out.txt && echo ok',
      shell: 'cmd',
      networkMode: 'none',
      artifacts: ['out.txt'],
      deadline: Date.now() + 90_000,
      maxOutputBytes: 4096,
      maxArtifactBytes: 1024,
      limits: { memoryMiB: 256, pidsLimit: 16, cpus: 1 },
      signal: new AbortController().signal,
    })
    expect(result, `reason=${result.reason ?? ''} stderr=${result.stderr}`).toMatchObject({
      status: 'succeeded',
      quiescent: true,
      exitCode: 0,
      artifacts: [{ path: 'out.txt', content: 'real-win\r\n' }],
    })
  }, 110_000)
})
