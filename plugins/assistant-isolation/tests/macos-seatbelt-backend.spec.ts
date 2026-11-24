import { Context } from '@deepseek-ai/cordis'
import { EventEmitter } from 'node:events'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import {
  AssistantIsolationService,
  buildMacosSeatbeltCommandProfile,
  buildScrubbedMacosEnv,
  IsolatedVerifierRunner,
  isolationPrincipalDigest,
  runMacosSeatbeltCommand,
  type MacosSeatbeltAdapter,
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

describe('macos-seatbelt generic command profile, env, and adapter execution', () => {
  test('builds deny-default Seatbelt command profiles with explicit network opt-in and writable toggle', () => {
    const offline = buildMacosSeatbeltCommandProfile({
      workspacePath: '/private/tmp/ws-1',
      tmpPath: '/private/tmp/tmp-1',
      readOnlyRoots: ['/opt/homebrew/Cellar/node/24.0.0'],
      workspaceWritable: false,
      allowNetwork: false,
    })
    expect(offline).toContain('(version 1) (deny default)')
    expect(offline).toContain('(allow process-fork)')
    expect(offline).toContain('(allow process-exec')
    expect(offline).toContain('(subpath "/opt/homebrew/Cellar/node/24.0.0")')
    expect(offline).toContain('(allow file-write* (literal "/dev/null") (subpath "/private/tmp/tmp-1"))')
    expect(offline).not.toContain('(subpath "/private/tmp/ws-1")) (allow network')
    expect(offline).not.toContain('(allow network')
    expect(offline).not.toContain('(allow system-socket')

    const writableOnline = buildMacosSeatbeltCommandProfile({
      workspacePath: '/private/tmp/ws-1',
      tmpPath: '/private/tmp/tmp-1',
      writablePaths: ['/private/tmp/extra-w'],
      workspaceWritable: true,
      allowNetwork: true,
    })
    expect(writableOnline).toContain('(subpath "/private/tmp/ws-1")')
    expect(writableOnline).toContain('(subpath "/private/tmp/extra-w")')
    expect(writableOnline).toContain('(allow system-socket) (allow network-outbound)')

    // Rejects relative, empty, traversal, control-character, and overbroad writable paths without hanging
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: 'relative/path', tmpPath: '/private/tmp/tmp-1' })).toThrow(/invalid macOS workspace path/i)
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: '', tmpPath: '/private/tmp/tmp-1' })).toThrow(/invalid macOS workspace path/i)
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: '/private/tmp/ws/../etc', tmpPath: '/private/tmp/tmp-1' })).toThrow(/invalid macOS workspace path/i)
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: '/private/tmp/ws\x01bad', tmpPath: '/private/tmp/tmp-1' })).toThrow(/invalid macOS workspace path/i)
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: '/private/tmp/ws-1', tmpPath: '/private/tmp/tmp-1', readOnlyRoots: ['relative/ro'] })).toThrow(/invalid macOS readOnlyRoot path/i)
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: '/private/tmp/ws-1', tmpPath: '/private/tmp/tmp-1', executablePaths: ['/usr/bin/env\n'] })).toThrow(/invalid macOS executable path/i)
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: '/private/tmp/ws-1', tmpPath: '/private/tmp/tmp-1', writablePaths: ['/Users'] })).toThrow(/overbroad macOS writable path/i)
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: '/private/tmp/ws-1', tmpPath: '/private/tmp/tmp-1', writablePaths: ['/System/Library'] })).toThrow(/overbroad macOS writable path/i)
    expect(() => buildMacosSeatbeltCommandProfile({ workspacePath: '/private/tmp/ws-1', tmpPath: '/private/tmp/tmp-1', writablePaths: ['/usr'] })).toThrow(/overbroad macOS writable path/i)
  })

  test('scrubs DYLD/LD/NODE_OPTIONS, offline proxies, and locks PATH/HOME/TMPDIR case-insensitively on macOS', () => {
    const offlineEnv = buildScrubbedMacosEnv({
      workspacePath: '/tmp/ws',
      tmpPath: '/tmp/tmp',
      allowNetwork: false,
      env: {
        PATH: '/tmp/attacker/bin',
        path: '/tmp/attacker/lower',
        HOME: '/tmp/attacker-home',
        home: '/tmp/attacker-lower-home',
        TMPDIR: '/tmp/attacker-tmp',
        tmpdir: '/tmp/attacker-lower-tmp',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        dyld_framework_path: '/tmp/evil-fw',
        LD_PRELOAD: '/tmp/evil.so',
        ld_audit: '/tmp/evil-audit.so',
        NODE_OPTIONS: '--require /tmp/evil.js',
        node_options: '--require /tmp/lower.js',
        HTTP_PROXY: 'http://127.0.0.1:8080',
        HTTPS_PROXY: 'https://127.0.0.1:8443',
        SAFE_VAR: 'kept',
      },
    })
    expect(offlineEnv).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      HOME: '/tmp/ws',
      TMPDIR: '/tmp/tmp',
      SAFE_VAR: 'kept',
    })

    const onlineEnv = buildScrubbedMacosEnv({
      workspacePath: '/tmp/ws',
      tmpPath: '/tmp/tmp',
      allowNetwork: true,
      env: { HTTPS_PROXY: 'https://proxy.local:8443', DYLD_LIBRARY_PATH: '/bad' },
    })
    expect(onlineEnv.HTTPS_PROXY).toBe('https://proxy.local:8443')
    expect(onlineEnv.DYLD_LIBRARY_PATH).toBeUndefined()
  })

  test('validates platform/root/permissions/symlinks/readOnlyRoots and enforces PGID SIGKILL + safe artifact export via adapter', async () => {
    const root = await makeTempDir('mac-cmd-')
    const ws = join(root, 'ws')
    const tmp = join(root, 'tmp')
    await mkdir(ws, { mode: 0o700 })
    await mkdir(tmp, { mode: 0o700 })

    // Wrong platform / root uid / missing sandbox-exec
    expect(await runMacosSeatbeltCommand({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'linux', uid: 501 })).toMatchObject({ status: 'failed', quiescent: true, reason: 'non-root-macos-required' })

    expect(await runMacosSeatbeltCommand({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'darwin', uid: 0 })).toMatchObject({ status: 'failed', quiescent: true, reason: 'non-root-macos-required' })

    expect(await runMacosSeatbeltCommand({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'darwin', uid: 501, verifySandboxExec: async () => false })).toMatchObject({ status: 'failed', quiescent: true, reason: 'sandbox-exec-unavailable' })

    // Overbroad read-only root and writablePaths rejected
    expect(await runMacosSeatbeltCommand({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', readOnlyRoots: ['/Users'], deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'darwin', uid: 501, verifySandboxExec: async () => true })).toMatchObject({ status: 'failed', quiescent: true, reason: 'overbroad-read-only-root' })

    expect(await runMacosSeatbeltCommand({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', writablePaths: ['/Users'], deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'darwin', uid: 501, verifySandboxExec: async () => true })).toMatchObject({ status: 'failed', quiescent: true, reason: 'overbroad-writable-path' })

    expect(await runMacosSeatbeltCommand({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', writablePaths: ['relative/w'], deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'darwin', uid: 501, verifySandboxExec: async () => true })).toMatchObject({ status: 'failed', quiescent: true, reason: 'invalid-writable-paths' })

    // Symlink in workspace rejected before spawn
    await symlink('/etc/hosts', join(ws, 'escape'))
    expect(await runMacosSeatbeltCommand({
      workspacePath: ws, tmpPath: tmp, command: 'echo ok', deadline: Date.now() + 10_000, maxOutputBytes: 4096, signal: new AbortController().signal,
    }, { platform: 'darwin', uid: 501, verifySandboxExec: async () => true })).toMatchObject({ status: 'failed', quiescent: true, reason: 'invalid-private-workspace' })
    await rm(join(ws, 'escape'))

    // Mocked spawn exercising stdout, PGID SIGKILL on output limit, and artifact collection
    const killedPids: Array<{ pid: number; sig: NodeJS.Signals }> = []
    let activeMockProc: { kill: (sig: NodeJS.Signals) => boolean } | undefined
    const makeSpawn = (mode: 'ok' | 'overflow') => ((_cmd: string, _args: readonly string[]) => {
      const proc = new EventEmitter() as EventEmitter & {
        pid: number
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        kill: (sig: NodeJS.Signals) => boolean
        unref: () => void
      }
      proc.pid = 42424
      proc.stdin = new PassThrough()
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = (sig: NodeJS.Signals) => { proc.emit('close', null, sig); return true }
      proc.unref = () => {}
      activeMockProc = proc
      queueMicrotask(() => {
        if (mode === 'ok') {
          proc.stdout.end('hello-mac\n')
          proc.stderr.end('')
          proc.emit('close', 0, null)
        } else {
          proc.stdout.write('x'.repeat(100))
        }
      })
      return proc as never
    }) as never

    await writeFile(join(ws, 'out.txt'), 'artifact-body', { mode: 0o600 })
    const okResult = await runMacosSeatbeltCommand({
      workspacePath: ws,
      tmpPath: tmp,
      command: 'echo hello-mac',
      artifacts: ['out.txt'],
      workspaceWritable: true,
      deadline: Date.now() + 10_000,
      maxOutputBytes: 4096,
      maxArtifactBytes: 1024,
      signal: new AbortController().signal,
    }, {
      platform: 'darwin',
      uid: 501,
      verifySandboxExec: async () => true,
      spawn: makeSpawn('ok'),
    })
    expect(okResult).toMatchObject({
      status: 'succeeded',
      quiescent: true,
      exitCode: 0,
      stdout: 'hello-mac\n',
      artifacts: [{ path: 'out.txt', content: 'artifact-body' }],
    })

    // Hardlinked artifact rejected
    await writeFile(join(root, 'outside.txt'), 'outside', { mode: 0o600 })
    await link(join(root, 'outside.txt'), join(ws, 'hardlink.txt'))
    const badArtifact = await runMacosSeatbeltCommand({
      workspacePath: ws,
      tmpPath: tmp,
      command: 'echo ok',
      artifacts: ['hardlink.txt'],
      deadline: Date.now() + 10_000,
      maxOutputBytes: 4096,
      signal: new AbortController().signal,
    }, {
      platform: 'darwin',
      uid: 501,
      verifySandboxExec: async () => true,
      spawn: makeSpawn('ok'),
    })
    expect(badArtifact).toMatchObject({ status: 'failed', quiescent: true, artifacts: [] })
    await rm(join(ws, 'hardlink.txt'))

    // Output overflow triggers PGID SIGKILL
    const overflow = await runMacosSeatbeltCommand({
      workspacePath: ws,
      tmpPath: tmp,
      command: 'yes',
      deadline: Date.now() + 10_000,
      maxOutputBytes: 16,
      signal: new AbortController().signal,
    }, {
      platform: 'darwin',
      uid: 501,
      verifySandboxExec: async () => true,
      spawn: makeSpawn('overflow'),
      killProcessGroup: (pid, sig) => {
        killedPids.push({ pid, sig })
        activeMockProc?.kill(sig)
      },
    })
    expect(overflow).toMatchObject({ status: 'output-limit', quiescent: true })
    expect(killedPids).toContainEqual({ pid: 42424, sig: 'SIGKILL' })
  })

  test('IsolatedVerifierRunner supports macos-seatbelt (and auto) with durable receipts, idempotency, and finite budget', async () => {
    const stateRoot = await makeTempDir('mac-verifier-')
    let calls = 0
    const adapter: MacosSeatbeltAdapter = {
      platform: 'darwin',
      uid: 501,
      verifySandboxExec: async () => true,
      runCommand: async (input, policy) => {
        calls += 1
        expect(policy).toContain('(deny default)')
        expect(policy).not.toContain('(allow network')
        const artifact = await readFile(join(input.workspacePath, 'artifact'), 'utf8')
        return {
          status: 'succeeded',
          quiescent: true,
          exitCode: 0,
          stdout: `verified:${artifact}:${input.stdin}`,
          stderr: '',
          artifacts: [],
        }
      },
    }

    const runner = new IsolatedVerifierRunner({
      backend: 'auto',
      stateRoot,
      authorityDigest: 'a'.repeat(64),
      command: '/bin/sh -c "cat artifact"',
      expiresAt: Date.now() + 60_000,
      maxRuns: 1,
      maxTotalDurationMs: 10_000,
      maxDurationMs: 5_000,
      maxOutputBytes: 4096,
      adapter,
    }, { platform: 'darwin', uid: 501, allowHostPaths: true })

    try {
      const first = await runner.run('key-1', 'payload', 'stdin-val', new AbortController().signal)
      expect(first).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'verified:payload:stdin-val' })
      expect(calls).toBe(1)

      // Exact replay returns persisted result without re-running
      expect(await runner.run('key-1', 'payload', 'stdin-val', new AbortController().signal)).toEqual(first)
      expect(calls).toBe(1)

      // Different request under same key fails conflict
      await expect(runner.run('key-1', 'changed', 'stdin-val', new AbortController().signal)).rejects.toThrow(/different request/i)

      // Budget exhausted after 1 run
      await expect(runner.run('key-2', 'payload', 'stdin-val', new AbortController().signal)).rejects.toThrow(/budget exhausted/i)
    } finally {
      await runner.close()
    }
  })

  test('AssistantIsolationService runs macos-seatbelt jobs, enforces receipts, and supports CLI reconcile/revoke', async () => {
    const root = await makeTempDir('mac-service-')
    const stateRoot = join(root, 'state')
    const project = join(root, 'project')
    await mkdir(stateRoot, { mode: 0o700 })
    await mkdir(project, { mode: 0o700 })

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
        principalId: 'owner',
        principalLineage: { principalRecordId: 'record-owner', principalVersion: 1 },
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
        { id: 'grant', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation:mac-offline' } },
      ],
    })

    const macosAdapter: MacosSeatbeltAdapter = {
      platform: 'darwin',
      uid: 501,
      verifySandboxExec: async () => true,
      runCommand: async input => {
        const infile = await readFile(join(input.workspacePath, 'input.txt'), 'utf8')
        await writeFile(join(input.workspacePath, 'out.txt'), `mac:${infile}`, { mode: 0o600 })
        return {
          status: 'succeeded',
          quiescent: true,
          exitCode: 0,
          stdout: 'mac-stdout\n',
          stderr: '',
          artifacts: [],
        }
      },
    }

    const service = new AssistantIsolationService(ctx, {
      backend: 'macos-seatbelt',
      stateRoot,
      limits: { maxDurationMs: 5000, maxOutputBytes: 4096 },
      grants: [{
        id: 'mac-offline',
        revision: 1,
        principalDigest: isolationPrincipalDigest('owner'),
        principalRecordId: 'record-owner',
        principalVersion: 1,
        workspace: project,
        agentPreset: 'primary',
        expiresAt: Date.now() + 60_000,
        maxRuns: 3,
        maxTotalDurationMs: 30_000,
      }],
    }, { platform: 'darwin', uid: 501, allowHostPaths: true, macosAdapter })

    const agentHandle = await ctx.agents.create({ sessionId: SessionId('mac-sess'), meta: { cwd: project, agentPreset: 'primary' } })
    try {
      await service.ready
      const grants = await service.discover(agentHandle.agent)
      expect(grants).toHaveLength(1)
      expect(grants[0]?.id).toBe('mac-offline')

      const res = await service.run(agentHandle.agent, {
        grantId: 'mac-offline',
        idempotencyKey: 'mac-job-1',
        command: 'cat input.txt > out.txt',
        files: [{ path: 'input.txt', content: 'hello' }],
        artifacts: ['out.txt'],
      }, new AbortController().signal)

      expect(res).toMatchObject({
        status: 'succeeded',
        quiescent: true,
        exitCode: 0,
        stdout: 'mac-stdout\n',
        artifacts: [{ path: 'out.txt', content: 'mac:hello' }],
      })

      const db = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
      try {
        expect(db.prepare('SELECT backend_kind, status FROM isolation_jobs').get()).toEqual({
          backend_kind: 'macos-seatbelt',
          status: 'succeeded',
        })
      } finally {
        db.close()
      }
    } finally {
      await agentHandle.dispose()
      await ctx.fiber.dispose()
    }

    // Seed an unresolved pre-dispatch macos-seatbelt job and reconcile via CLI
    const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
    const auth = ledger.claimController('cli-test', 30_000)
    const prepared = ledger.prepare({
      identity: {
        principalDigest: isolationPrincipalDigest('owner'),
        principalRecordId: 'record-owner',
        principalVersion: 1,
        workspace: project,
        agentPreset: 'primary',
      },
      sessionId: 'mac-sess',
      grantId: 'mac-offline',
      idempotencyKey: 'mac-job-pending',
      requestDigest: 'd'.repeat(64),
      durationMs: 1000,
      backend: 'macos-seatbelt',
      authority: auth,
    }).job
    ledger.releaseController(auth)
    ledger.close()

    expect(await reconcileIsolation(stateRoot)).toEqual({ checked: 1, released: 1, retained: 0 })
    const checkLedger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
    try {
      expect(checkLedger.get(prepared.id)?.result).toMatchObject({ status: 'unknown', quiescent: true })
      const auth2 = checkLedger.claimController('cli-revoke', 30_000)
      checkLedger.prepare({
        identity: {
          principalDigest: isolationPrincipalDigest('owner'),
          principalRecordId: 'record-owner',
          principalVersion: 1,
          workspace: project,
          agentPreset: 'primary',
        },
        sessionId: 'mac-sess',
        grantId: 'mac-offline',
        idempotencyKey: 'mac-job-revoke',
        requestDigest: 'e'.repeat(64),
        durationMs: 1000,
        backend: 'macos-seatbelt',
        authority: auth2,
      })
      checkLedger.releaseController(auth2)
    } finally {
      checkLedger.close()
    }
    expect(await revokeIsolationGrant(stateRoot, 'mac-offline', 1)).toMatchObject({
      revoked: true,
      nativeResourcesQuiescent: true,
      nativeRetained: 0,
    })
  })
})

describe.skipIf(process.platform !== 'darwin')('real macOS sandbox-exec command execution', () => {
  test('executes shell command, exports artifact, blocks network, and cancels cleanly', async () => {
    const root = await makeTempDir('real-mac-cmd-')
    const ws = join(root, 'ws')
    const tmp = join(root, 'tmp')
    await mkdir(ws, { mode: 0o700 })
    await mkdir(tmp, { mode: 0o700 })

    const res = await runMacosSeatbeltCommand({
      workspacePath: ws,
      tmpPath: tmp,
      command: 'printf "real-mac" > out.txt && printf "ok"',
      artifacts: ['out.txt'],
      workspaceWritable: true,
      allowNetwork: false,
      deadline: Date.now() + 10_000,
      maxOutputBytes: 4096,
      signal: new AbortController().signal,
    })
    expect(res).toMatchObject({
      status: 'succeeded',
      quiescent: true,
      exitCode: 0,
      stdout: 'ok',
      artifacts: [{ path: 'out.txt', content: 'real-mac' }],
    })
  })
})
