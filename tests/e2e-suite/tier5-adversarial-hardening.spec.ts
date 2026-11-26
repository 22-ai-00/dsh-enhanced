import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { sha256Hex } from './helpers/assertions.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantActions,
  loadAssistantActionsBroker,
  loadAssistantActionsHttpGuard,
  loadAssistantDelivery,
  loadAssistantDreaming,
  loadAssistantGrowthDriver,
  loadAssistantPolicy,
  loadDshRayUpgrade,
  loadPackageModule,
} from './helpers/packages.ts'
import { createWorkspaceTracker } from './helpers/workspace.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

describe('Tier 5 — Adversarial Hardening Regressions (Gaps 1 & 3–9)', () => {
  test('T5-GAP1-01: AssistantDeliveryService immediate dispose with schedulerEnabled=true produces 0 unhandled rejections', async () => {
    const ws = await workspaces.create('t5-gap1-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantDeliveryService } = await loadAssistantDelivery()

    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      for (let i = 0; i < 4; i += 1) {
        const ctx = harness.createContext()
        await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
          databasePath: ws.sqlitePath(`policy-${i}`),
          proposalMaintenanceIntervalMs: 0,
        })
        await harness.mountService(ctx, AssistantDeliveryService, 'assistantDelivery', {
          databasePath: ws.sqlitePath(`delivery-${i}`),
          spoolPath: join(ws.stateDir, `spool-${i}`),
          schedulerEnabled: true,
          tickIntervalMs: 100,
          defaultWorkspace: ws.workspace,
          defaultAgentPreset: 'standard',
        })
        await ctx.fiber.dispose()
      }
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 15_000)

  test('T5-GAP3-01: AssistantPolicyService.authorize enforces cumulative monetaryCostCapMicros without double-charging replays', async () => {
    const ws = await workspaces.create('t5-gap3-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const policyDb = ws.sqlitePath('policy-cost-cap')
    const rules = [{
      id: 'cost-cap-e2e',
      effect: 'allow' as const,
      actions: ['execute'],
      resource: { kind: 'network' as const, id: 'paid-endpoint' },
      monetaryCostCapMicros: 1_000,
    }]
    const makeReq = (estimatedCostMicros: number) => ({
      subject: { kind: 'agent' as const, id: 'worker-1', workspace: ws.workspace, principal: 'owner-1' },
      action: 'execute',
      resource: { kind: 'network' as const, id: 'paid-endpoint' },
      context: { initiator: 'foreground' as const },
      estimatedCostMicros,
    })

    const ctx1 = harness.createContext()
    const p1 = await harness.mountService<{
      authorize: (req: unknown, opts?: { idempotencyKey?: string }) => { effect: string; reasonCode: string; ruleId?: string }
    }>(ctx1, AssistantPolicyService, 'assistantPolicy', {
      databasePath: policyDb,
      proposalMaintenanceIntervalMs: 0,
      rules,
    })

    expect(p1.authorize(makeReq(600), { idempotencyKey: 't5-cost-1' })).toMatchObject({ effect: 'allow', ruleId: 'cost-cap-e2e' })
    // Replay of t5-cost-1 must succeed without double-charging
    expect(p1.authorize(makeReq(600), { idempotencyKey: 't5-cost-1' })).toMatchObject({ effect: 'allow', ruleId: 'cost-cap-e2e' })
    // Second distinct key exceeding 1000 must fail closed with monetary-cost-exceeded
    expect(p1.authorize(makeReq(600), { idempotencyKey: 't5-cost-2' })).toEqual({
      effect: 'deny',
      reasonCode: 'monetary-cost-exceeded',
      ruleId: 'cost-cap-e2e',
    })
    // Remaining 400 succeeds
    expect(p1.authorize(makeReq(400), { idempotencyKey: 't5-cost-3' })).toMatchObject({ effect: 'allow', ruleId: 'cost-cap-e2e' })
    await harness.disposeAll()

    // Persisted cumulative spend survives restart
    const ctx2 = harness.createContext()
    const p2 = await harness.mountService<{
      authorize: (req: unknown, opts?: { idempotencyKey?: string }) => { effect: string; reasonCode: string; ruleId?: string }
    }>(ctx2, AssistantPolicyService, 'assistantPolicy', {
      databasePath: policyDb,
      proposalMaintenanceIntervalMs: 0,
      rules,
    })
    expect(p2.authorize(makeReq(1), { idempotencyKey: 't5-cost-4' })).toEqual({
      effect: 'deny',
      reasonCode: 'monetary-cost-exceeded',
      ruleId: 'cost-cap-e2e',
    })
    expect(p2.authorize(makeReq(600), { idempotencyKey: 't5-cost-1' })).toMatchObject({ effect: 'allow', ruleId: 'cost-cap-e2e' })
  }, 15_000)

  test('T5-GAP4-01: http-guard blocks IPv4-compatible, NAT64, 6to4, Teredo, benchmarking & discard IPv6 SSRF while allowing public IPv6', async () => {
    const httpGuard = await loadAssistantActionsHttpGuard()

    for (const blocked of [
      '::127.0.0.1',
      '0:0:0:0:0:0:7f00:1',
      '::169.254.169.254',
      '64:ff9b::169.254.169.254',
      '64:ff9b::127.0.0.1',
      '64:ff9b:1::127.0.0.1',
      '2002:7f00:0001::',
      '2001::1',
      '2001:2::1',
      '100::1',
    ]) {
      expect(httpGuard.isBlockedIpAddress(blocked, false), `expected ${blocked} to be blocked`).toBe(true)
    }

    for (const allowedPublic of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
      expect(httpGuard.isBlockedIpAddress(allowedPublic, false), `expected ${allowedPublic} to be allowed`).toBe(false)
    }

    const grantDest = {
      classification: 'http-endpoint' as const,
      allowedSchemes: ['https'] as const,
      allowedHosts: ['ssrf-v6.example.test'],
      allowedMethods: ['GET'] as const,
      allowedPathPrefixes: ['/'],
      allowRedirects: false as const,
      allowPrivateNetwork: false as const,
      maxResponseBytes: 1_024,
    }
    const reqDest = { classification: 'http-endpoint' as const, scheme: 'https' as const, host: 'ssrf-v6.example.test', path: '/meta' }
    for (const pinned of ['64:ff9b::169.254.169.254', '::127.0.0.1']) {
      await expect(httpGuard.executeHttpGuardedAction({
        grantDestination: grantDest,
        requestDestination: reqDest,
        payload: { method: 'GET', url: 'https://ssrf-v6.example.test/meta' },
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        deps: { lookup: async () => [{ address: pinned, family: 6 }] },
      })).rejects.toThrow(/blocked address/i)
    }
  }, 15_000)

  test('T5-GAP5-01 & T5-GAP6-01: shell-guard rejects symlink executable, case-variant env keys, and pre-spawn abort without ReferenceError', async () => {
    const ws = await workspaces.create('t5-gap56-')
    const shellGuard = (await loadPackageModule('assistant-actions/guards/shell-guard')) as {
      validateShellAgainstGrant: (g: unknown, r: unknown, p: unknown, deps?: unknown) => Promise<unknown>
      executeShellGuardedAction: (input: Record<string, unknown>) => Promise<unknown>
    }

    const symExec = join(ws.root, 'fake-node')
    await symlink(process.execPath, symExec)

    const symGrant = {
      classification: 'shell-command',
      allowedCwds: [ws.workspace],
      allowedCommands: [{ executable: symExec, maxArgs: 2 }],
      allowedEnvKeys: ['SAFE_KEY', 'node_options', 'ld_preload', 'Path'],
      maxTimeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      allowNetwork: false,
    }
    await expect(shellGuard.validateShellAgainstGrant(
      symGrant,
      { classification: 'shell-command', executable: symExec, cwd: ws.workspace },
      { executable: symExec, args: ['-v'], cwd: ws.workspace, timeoutMs: 1_000 },
    )).rejects.toThrow(/non-symlink file/i)

    const realGrant = {
      ...symGrant,
      allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 2 }],
    }
    for (const env of [
      { node_options: '--require=/tmp/evil.js' },
      { ld_preload: '/tmp/evil.so' },
      { Path: '/tmp/evil' },
    ]) {
      await expect(shellGuard.validateShellAgainstGrant(
        realGrant,
        { classification: 'shell-command', executable: process.execPath, cwd: ws.workspace },
        { executable: process.execPath, args: ['-e', 'console.log(1)'], cwd: ws.workspace, env, timeoutMs: 1_000 },
      )).rejects.toThrow(/forbidden environment variable|PATH override/i)
    }

    const ac = new AbortController()
    let spawned = false
    await expect(shellGuard.executeShellGuardedAction({
      grantDestination: realGrant,
      requestDestination: { classification: 'shell-command', executable: process.execPath, cwd: ws.workspace },
      payload: { executable: process.execPath, args: ['-e', 'console.log(1)'], cwd: ws.workspace, timeoutMs: 1_000 },
      remainingLeaseMs: 1_000,
      signal: ac.signal,
      deps: {
        realpath: async (p: string) => {
          ac.abort()
          return p
        },
        lstat: async (p: string) => ({
          isDirectory: () => p === ws.workspace,
          isFile: () => p === process.execPath,
          isSymbolicLink: () => false,
        }),
        spawnImpl: () => {
          spawned = true
          throw new Error('must not spawn when aborted')
        },
      },
    })).rejects.toMatchObject({ name: 'ShellGuardError', code: 'aborted' })
    expect(spawned).toBe(false)
  }, 15_000)

  test('T5-GAP7-01: AssistantActionsService.executeAction replays identical idempotencyKey on maxUses=1 without lease-exhausted', async () => {
    const ws = await workspaces.create('t5-gap7-')
    const { AssistantActionsService } = await loadAssistantActions()
    const brokerMod = await loadAssistantActionsBroker()

    let hits = 0
    const server = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const owner = {
        principalDigest: sha256Hex('owner-t5-gap7'),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: ws.workspace,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }
      const now = Date.now()
      const createProjection = brokerMod.createActionGrantProjection as (input: Record<string, unknown>) => unknown
      const grant = createProjection({
        protocol: brokerMod.ACTION_GRANT_PROTOCOL,
        id: 'http-once-t5',
        revision: 1,
        domain: 'http',
        clientKeyId: 'host-1',
        owner,
        sessionId: 'sess-t5-gap7',
        expiresAt: now + 60_000,
        maxActions: 5,
        maxTotalBytes: 4_096,
        maxCostUnits: 5,
        client: { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 },
        source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['http'],
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [port],
          allowedMethods: ['GET'],
          allowedPathPrefixes: ['/ping', '/other'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 1_024,
        },
        allowedOperations: ['http.request'],
        credentialId: 'none',
        lease: { leaseId: 'lease-once-t5', expiresAtMs: now + 60_000, maxUses: 1 },
        policyEpoch: 1,
        emergencyEpoch: 0,
      })

      const agent = {
        id: 'agent-t5-gap7',
        session: { id: 'sess-t5-gap7', header: { cwd: ws.workspace, agentPreset: 'primary' } },
      }
      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'assistantDelivery', {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-t5-gap7',
          sessionId: 'sess-t5-gap7',
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
          scope: { workspace: ws.workspace, preset: 'primary' },
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
        }),
      })
      harness.provideMockService(ctx, 'assistantPolicy', {
        evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
        authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      })
      harness.provideMockService(ctx, 'agents', {
        get: (id: string) => (id === 'agent-t5-gap7' ? agent : undefined),
      })

      const svc = await harness.mountService<{
        executeAction: (a: unknown, input: Record<string, unknown>, sig: AbortSignal) => Promise<Record<string, unknown>>
      }>(ctx, AssistantActionsService, 'assistantActions', {
        stateRoot: join(ws.stateDir, 'actions'),
        actionGrants: [grant as never],
      })

      const req = {
        grantId: 'http-once-t5',
        idempotencyKey: 't5-idem-replay-1',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/ping' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/ping` },
      }
      const r1 = await svc.executeAction(agent, req, new AbortController().signal)
      expect(r1.status).toBe('succeeded')
      expect(hits).toBe(1)

      const r2 = await svc.executeAction(agent, req, new AbortController().signal)
      expect(r2).toEqual(r1)
      expect(hits).toBe(1)

      await expect(svc.executeAction(agent, {
        ...req,
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/other' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/other` },
      }, new AbortController().signal)).rejects.toThrow(/idempotency conflict/i)

      await expect(svc.executeAction(agent, {
        ...req,
        idempotencyKey: 't5-idem-other-2',
      }, new AbortController().signal)).rejects.toThrow(/WP08 policy rejected \(lease-exhausted\)/u)
      expect(hits).toBe(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 15_000)

  test('T5-GAP8-01 & T5-GAP9-01: assistant-growth-driver rejects whitespace scope/budgetId & dsh-ray runUpgrade rejects symlink dshHome', async () => {
    const ws = await workspaces.create('t5-gap89-')
    const gdMod = await loadAssistantGrowthDriver()
    const upgMod = await loadDshRayUpgrade()

    expect(() => gdMod.Config({
      scope: { workspace: '   ', preset: 'p', principalId: 'u', ownerRouteId: 'r' },
    } as never)).toThrow()
    expect(() => gdMod.Config({
      scope: { workspace: ws.workspace, preset: '   ', principalId: '   ', ownerRouteId: '   ' },
    } as never)).toThrow()
    expect(() => gdMod.Config({ budgetId: '   ', budgetAmount: 1 } as never)).toThrow()
    expect(() => gdMod.normalizeConfig({ budgetId: '   ', budgetAmount: 1 } as never)).toThrow()
    expect(() => gdMod.Config({
      scope: { workspace: '/tmp/ws\n', preset: 'primary', principalId: 'u', ownerRouteId: 'r' },
    } as never)).toThrow()
    expect(() => gdMod.normalizeConfig({
      scope: { workspace: '/tmp/ws\n', preset: 'primary', principalId: 'u', ownerRouteId: 'r' },
    } as never)).toThrow()
    expect(() => gdMod.Config({
      scope: { workspace: ws.workspace, preset: ' primary ', principalId: 'u', ownerRouteId: 'r' },
    } as never)).toThrow()
    expect(() => gdMod.normalizeConfig({
      scope: { workspace: ws.workspace, preset: ' primary ', principalId: 'u', ownerRouteId: 'r' },
    } as never)).toThrow()
    expect(() => gdMod.Config({ budgetId: 'b\x00id', budgetAmount: 1 } as never)).toThrow()
    expect(() => gdMod.normalizeConfig({ budgetId: 'b\x00id', budgetAmount: 1 } as never)).toThrow()

    const realHome = join(ws.root, 'real-home')
    const symHome = join(ws.root, 'sym-home')
    await mkdir(join(realHome, 'profiles', 'web'), { recursive: true, mode: 0o700 })
    await symlink(realHome, symHome)

    const res = await upgMod.runUpgrade({
      dshHome: symHome,
      action: 'check',
      osHome: ws.root,
      platform: 'linux',
    }, {
      fetch: async () => new Response('{}', { status: 404 }),
      scanProcesses: async () => ({ processes: [] }),
    })
    expect(res.exitCode).toBe(1)
    expect(res.report.ok).toBe(false)
    expect(res.report.ready).toBe(false)
    expect(res.report.dshHome).toBe(symHome)
    expect(res.report.readiness.blockedReasons.join('\n')).toContain('symlink')
  }, 15_000)

  test('T5-WP08-01: AssistantPolicyService + AssistantActionsService.executeAction enforces monetaryCostCapMicros, destinations, and maxSensitivity end-to-end without charging on pre-dispatch local grant failure', async () => {
    const ws = await workspaces.create('t5-wp08-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantActionsService } = await loadAssistantActions()
    const brokerMod = await loadAssistantActionsBroker()

    let hits = 0
    const server = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const owner = {
        principalDigest: sha256Hex('owner-t5-wp08'),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: ws.workspace,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }
      const now = Date.now()
      const createProjection = brokerMod.createActionGrantProjection as (input: Record<string, unknown>) => unknown
      const grant = createProjection({
        protocol: brokerMod.ACTION_GRANT_PROTOCOL,
        id: 'http-wp08-e2e',
        revision: 1,
        domain: 'http',
        clientKeyId: 'host-1',
        owner,
        sessionId: 'sess-t5-wp08',
        expiresAt: now + 60_000,
        maxActions: 10,
        maxTotalBytes: 4_096,
        maxCostUnits: 10,
        client: { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 },
        source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['http'],
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [port],
          allowedMethods: ['GET'],
          allowedPathPrefixes: ['/v1/'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 1_024,
        },
        allowedOperations: ['http.request'],
        credentialId: 'none',
        policyEpoch: 1,
        emergencyEpoch: 0,
      })

      const agent = {
        id: 'agent-t5-wp08',
        session: { id: 'sess-t5-wp08', header: { cwd: ws.workspace, agentPreset: 'primary' } },
      }
      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'assistantDelivery', {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-t5-wp08',
          sessionId: 'sess-t5-wp08',
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
          scope: { workspace: ws.workspace, preset: 'primary' },
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
        }),
      })
      harness.provideMockService(ctx, 'agents', {
        get: (id: string) => (id === 'agent-t5-wp08' ? agent : undefined),
      })

      const policy = await harness.mountService<{
        authorizeAgent: (a: unknown, act: string, res: unknown, opts?: Record<string, unknown>) => { effect: string; reasonCode: string; ruleId?: string }
        getLeaseState: (leaseId: string) => { uses: number } | undefined
      }>(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy-wp08-e2e'),
        proposalMaintenanceIntervalMs: 0,
        rules: [{
          id: 'e2e-wp08-http',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:http:http-wp08-e2e' },
          lease: { leaseId: 'e2e-wp08-lease', expiresAtMs: now + 60_000, maxUses: 2 },
          destinations: [`http://127.0.0.1:${port}/v1/ok*`],
          maxSensitivity: 'internal',
          monetaryCostCapMicros: 1_000,
        }],
      })
      const actions = await harness.mountService<{
        executeAction: (a: unknown, input: Record<string, unknown>, sig: AbortSignal) => Promise<Record<string, unknown>>
      }>(ctx, AssistantActionsService, 'assistantActions', {
        stateRoot: join(ws.stateDir, 'actions'),
        actionGrants: [grant as never],
      })

      // Direct authorizeAgent forwards WP08 constraints properly
      expect(policy.authorizeAgent(agent, 'execute', { kind: 'tool', id: 'action:http:http-wp08-e2e' }, {
        idempotencyKey: 'direct-allow-1',
        destination: `http://127.0.0.1:${port}/v1/ok`,
        sensitivity: 'internal',
        estimatedCostMicros: 300,
      })).toMatchObject({ effect: 'allow', ruleId: 'e2e-wp08-http' })
      expect(policy.getLeaseState('e2e-wp08-lease')?.uses).toBe(1)

      // Pre-dispatch local grant validation failure must NOT charge policy lease or cost (remaining: 1 use, 700 micros)
      await expect(actions.executeAction(agent, {
        grantId: 'http-wp08-e2e',
        idempotencyKey: 'e2e-local-bad-path',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/admin/nope' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/admin/nope` },
        estimatedCostMicros: 700,
      }, new AbortController().signal)).rejects.toThrow(/HTTP path not permitted by grant/i)
      expect(policy.getLeaseState('e2e-wp08-lease')?.uses).toBe(1)

      // Policy denials on destination mismatch, sensitivity exceeded, and monetary cap exceeded
      await expect(actions.executeAction(agent, {
        grantId: 'http-wp08-e2e',
        idempotencyKey: 'e2e-wp08-bad-dest',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/other' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/other` },
        estimatedCostMicros: 700,
      }, new AbortController().signal)).rejects.toThrow(/external action policy denied/i)
      await expect(actions.executeAction(agent, {
        grantId: 'http-wp08-e2e',
        idempotencyKey: 'e2e-wp08-bad-sens',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/ok' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/ok` },
        sensitivity: 'restricted',
        estimatedCostMicros: 700,
      }, new AbortController().signal)).rejects.toThrow(/external action policy denied/i)
      await expect(actions.executeAction(agent, {
        grantId: 'http-wp08-e2e',
        idempotencyKey: 'e2e-wp08-bad-cost',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/ok' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/ok` },
        estimatedCostMicros: 701,
      }, new AbortController().signal)).rejects.toThrow(/external action policy denied/i)
      expect(policy.getLeaseState('e2e-wp08-lease')?.uses).toBe(1)
      expect(hits).toBe(0)

      // Compliant request within remaining 700 micros and 1 lease use succeeds
      const okRes = await actions.executeAction(agent, {
        grantId: 'http-wp08-e2e',
        idempotencyKey: 'e2e-wp08-ok',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/ok' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/ok` },
        estimatedCostMicros: 700,
      }, new AbortController().signal)
      expect(okRes.status).toBe('succeeded')
      expect(hits).toBe(1)
      expect(policy.getLeaseState('e2e-wp08-lease')?.uses).toBe(2)

      // Exhausted lease denies further calls
      await expect(actions.executeAction(agent, {
        grantId: 'http-wp08-e2e',
        idempotencyKey: 'e2e-wp08-exhausted',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/ok' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/ok` },
        estimatedCostMicros: 0,
      }, new AbortController().signal)).rejects.toThrow(/external action policy denied/i)
      expect(hits).toBe(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 15_000)

  test('T5-WP08-02: external-v2 local grant rejections & !dispatched failures roll back WP08 policy lease/cost while postDispatchUnknown/dispatched preserve charges, and embedded-compat DNS failure preserves lease/cost', async () => {
    const ws = await workspaces.create('t5-wp08-rb-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantActionsService } = await loadAssistantActions()
    const brokerMod = await loadAssistantActionsBroker()
    const brokerClientMod = await loadPackageModule('assistant-actions/broker-client') as {
      BrokerClientError: new (code: string, kind: 'not-dispatched' | 'post-dispatch-unknown', message: string) => Error
      BrokerPostDispatchUnknownError: new (code: string, message: string) => Error
    }
    const brokerProtoMod = await loadPackageModule('assistant-actions/broker-protocol') as {
      ACTION_BROKER_PROTOCOL: string
    }

    const keyDir = join(ws.root, 'keys')
    const sockDir = join(ws.root, 'sock')
    await Promise.all([
      mkdir(keyDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
    ])
    const serverKeys = generateKeyPairSync('ed25519')
    const clientKeys = generateKeyPairSync('ed25519')
    const brokerPubPath = join(keyDir, 'broker.pub')
    const clientPrivPath = join(keyDir, 'client.key')
    await Promise.all([
      writeFile(brokerPubPath, serverKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(clientPrivPath, clientKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
    ])

    let httpHits = 0
    const server = createServer((_req, res) => {
      httpHits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      const uid = process.getuid?.() ?? 0
      const gid = process.getgid?.() ?? 0
      const now = Date.now()
      const owner = {
        principalDigest: sha256Hex('owner-t5-wp08-rb'),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: ws.workspace,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }
      const createProjection = brokerMod.createActionGrantProjection as (input: Record<string, unknown>) => unknown
      const makeHttpGrant = (id: string, leaseId: string, hosts: readonly string[]) => createProjection({
        protocol: brokerMod.ACTION_GRANT_PROTOCOL,
        id,
        revision: 1,
        domain: 'http',
        clientKeyId: 'client-v2',
        owner,
        sessionId: 'sess-t5-wp08-rb',
        expiresAt: now + 60_000,
        maxActions: 10,
        maxTotalBytes: 8_192,
        maxCostUnits: 10,
        client: { kind: 'assistant-actions-host', instanceId: 'host-v2', generation: 1 },
        source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['https', 'http'],
          allowedHosts: [...hosts],
          allowedMethods: ['GET'],
          allowedPathPrefixes: ['/v1/allowed/'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 1_024,
        },
        allowedOperations: ['http.request'],
        credentialId: 'none',
        lease: { leaseId, expiresAtMs: now + 60_000, maxUses: 1 },
        monetaryCostCapMicros: 1_000,
        policyEpoch: 1,
        emergencyEpoch: 0,
      })

      const extGrant1 = makeHttpGrant('ext-rb-1', 'lease-ext-1', ['127.0.0.1'])
      const extGrant2 = createProjection({
        protocol: brokerMod.ACTION_GRANT_PROTOCOL,
        id: 'ext-rb-2',
        revision: 1,
        domain: 'http',
        clientKeyId: 'client-v2',
        owner,
        sessionId: 'sess-t5-wp08-rb',
        expiresAt: now + 60_000,
        maxActions: 10,
        maxTotalBytes: 8_192,
        maxCostUnits: 10,
        client: { kind: 'assistant-actions-host', instanceId: 'host-v2', generation: 1 },
        source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['https', 'http'],
          allowedHosts: ['127.0.0.1'],
          allowedMethods: ['GET'],
          allowedPathPrefixes: ['/v1/allowed/'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 1_024,
        },
        allowedOperations: ['http.request'],
        credentialId: 'none',
        lease: { leaseId: 'lease-ext-2', expiresAtMs: now + 60_000, maxUses: 5 },
        monetaryCostCapMicros: 5_000,
        policyEpoch: 1,
        emergencyEpoch: 0,
      })
      const embGrant = makeHttpGrant('emb-rb-1', 'lease-emb-1', ['nonexistent-ssrf-test.invalid', '127.0.0.1'])

      const agent = {
        id: 'agent-t5-wp08-rb',
        session: { id: 'sess-t5-wp08-rb', header: { cwd: ws.workspace, agentPreset: 'primary' } },
      }

      const policyCtx = harness.createContext()
      harness.provideMockService(policyCtx, 'assistantDelivery', {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-t5-wp08-rb',
          sessionId: 'sess-t5-wp08-rb',
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
          scope: { workspace: ws.workspace, preset: 'primary' },
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
        }),
      })
      harness.provideMockService(policyCtx, 'agents', {
        get: (id: string) => (id === 'agent-t5-wp08-rb' ? agent : undefined),
      })

      const policy = await harness.mountService<{
        getLeaseState: (leaseId: string) => { uses: number } | undefined
      }>(policyCtx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy-wp08-rb'),
        proposalMaintenanceIntervalMs: 0,
        rules: [
          {
            id: 'rule-ext-1',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'action:http:ext-rb-1' },
            lease: { leaseId: 'lease-ext-1', expiresAtMs: now + 60_000, maxUses: 1 },
            destinations: [`http://127.0.0.1:${port}/v1/allowed/*`],
            monetaryCostCapMicros: 1_000,
          },
          {
            id: 'rule-ext-2',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'action:http:ext-rb-2' },
            lease: { leaseId: 'lease-ext-2', expiresAtMs: now + 60_000, maxUses: 1 },
            destinations: [`http://127.0.0.1:${port}/v1/allowed/*`],
            monetaryCostCapMicros: 1_000,
          },
          {
            id: 'rule-emb-1',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
            actions: ['execute'],
            resource: { kind: 'tool', id: 'action:http:emb-rb-1' },
            lease: { leaseId: 'lease-emb-1', expiresAtMs: now + 60_000, maxUses: 1 },
            monetaryCostCapMicros: 1_000,
          },
        ],
      })

      let externalCalls = 0
      let mode: 'client-pre' | 'broker-pre' | 'unknown' | 'succeed' = 'succeed'
      let extActions!: {
        executeAction: (a: unknown, input: Record<string, unknown>, sig: AbortSignal) => Promise<Record<string, unknown>>
      }
      const ActionsCtor = AssistantActionsService as new (...args: unknown[]) => typeof extActions
      const extPlugin = await policyCtx.plugin({
        name: 't5-ext-actions-rb',
        apply(runtime) {
          extActions = new ActionsCtor(
            runtime,
            {
              stateRoot: join(ws.stateDir, 'ext-actions'),
              externalActionGrants: [extGrant1, extGrant2],
              broker: {
                mode: 'external-v2',
                actionSocketPath: join(sockDir, 'action.sock'),
                brokerId: 'broker-v2',
                brokerPublicKeyPath: brokerPubPath,
                clientKeyId: 'client-v2',
                clientSigningKeyPath: clientPrivPath,
                clientInstanceId: 'host-v2',
                clientGeneration: 1,
                expectedSocketUid: uid,
                expectedSocketGid: gid,
                expectedBrokerPeerUid: uid,
                expectedBrokerPeerGid: gid,
                platform: 'linux',
                transport: 'posix-uds',
              },
            },
            undefined,
            undefined,
            undefined,
            undefined,
            async (_opts: unknown, intent: { actionId: string }) => {
              externalCalls += 1
              if (mode === 'client-pre') {
                throw new brokerClientMod.BrokerClientError('socket-invalid', 'not-dispatched', 'missing socket')
              }
              if (mode === 'unknown') {
                throw new brokerClientMod.BrokerPostDispatchUnknownError('disconnected', 'eof')
              }
              const failed = mode === 'broker-pre'
              return {
                protocol: brokerProtoMod.ACTION_BROKER_PROTOCOL,
                type: 'server-response',
                requestId: `req-${intent.actionId}`,
                actionId: intent.actionId,
                instanceId: 'broker-v2',
                generation: 1,
                challenge: Buffer.alloc(32).toString('base64url'),
                requestDigest: 'e'.repeat(64),
                status: failed ? 'failed' : 'succeeded',
                dispatched: !failed,
                result: failed
                  ? null
                  : {
                      domain: 'http',
                      operation: 'http.request',
                      statusCode: 200,
                      responseHeaders: {},
                      body: 'ok',
                      bodySha256: 'd'.repeat(64),
                      truncated: false,
                      untrusted: true,
                    },
                error: failed ? { code: 'transport-failed' } : null,
                completedAt: Date.now(),
                signature: Buffer.alloc(64).toString('base64url'),
              }
            },
          )
        },
      })

      const embCtx = harness.createContext()
      harness.provideMockService(embCtx, 'assistantDelivery', {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-t5-wp08-rb',
          sessionId: 'sess-t5-wp08-rb',
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
          scope: { workspace: ws.workspace, preset: 'primary' },
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
        }),
      })
      harness.provideMockService(embCtx, 'agents', {
        get: (id: string) => (id === 'agent-t5-wp08-rb' ? agent : undefined),
      })
      harness.provideMockService(embCtx, 'assistantPolicy', policy)
      harness.provideMockService(embCtx, 'credentialsKeychain', {})
      const embActions = await harness.mountService<{
        executeAction: (a: unknown, input: Record<string, unknown>, sig: AbortSignal) => Promise<Record<string, unknown>>
      }>(embCtx, AssistantActionsService, 'assistantActions', {
        stateRoot: join(ws.stateDir, 'emb-actions'),
        broker: { mode: 'embedded-compat' },
        actionGrants: [embGrant as never],
      })

      try {
        // (a) external-v2 local grant violation fails pre-dispatch without broker calls or policy charges
        await expect(extActions.executeAction(agent, {
          grantId: 'ext-rb-1',
          idempotencyKey: 't5-ext-forbidden',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/forbidden' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/forbidden` },
          estimatedCostMicros: 900,
        }, new AbortController().signal)).rejects.toThrow(/HTTP path not permitted by grant/i)
        expect(externalCalls).toBe(0)
        expect(policy.getLeaseState('lease-ext-1')?.uses ?? 0).toBe(0)

        // (b) external-v2 BrokerClientError(not-dispatched) & dispatched:false roll back policy lease & cost
        const compliantReq = {
          grantId: 'ext-rb-1',
          idempotencyKey: 't5-ext-ok-1',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/allowed/ok' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/allowed/ok` },
          estimatedCostMicros: 900,
        }
        mode = 'client-pre'
        await expect(extActions.executeAction(agent, compliantReq, new AbortController().signal))
          .rejects.toMatchObject({ postDispatchUnknown: false })
        expect(policy.getLeaseState('lease-ext-1')?.uses ?? 0).toBe(0)

        mode = 'broker-pre'
        const preFailRes = await extActions.executeAction(agent, compliantReq, new AbortController().signal)
        expect(preFailRes.status).toBe('failed')
        expect(policy.getLeaseState('lease-ext-1')?.uses ?? 0).toBe(0)

        mode = 'succeed'
        const okRes = await extActions.executeAction(agent, compliantReq, new AbortController().signal)
        expect(okRes.status).toBe('succeeded')
        expect(policy.getLeaseState('lease-ext-1')?.uses).toBe(1)

        // postDispatchUnknown: true does NOT roll back
        mode = 'unknown'
        await expect(extActions.executeAction(agent, {
          ...compliantReq,
          grantId: 'ext-rb-2',
          idempotencyKey: 't5-ext-unknown',
        }, new AbortController().signal)).rejects.toMatchObject({ postDispatchUnknown: true })
        expect(policy.getLeaseState('lease-ext-2')?.uses).toBe(1)
        mode = 'succeed'
        await expect(extActions.executeAction(agent, {
          ...compliantReq,
          grantId: 'ext-rb-2',
          idempotencyKey: 't5-ext-unknown-2',
        }, new AbortController().signal)).rejects.toThrow(/external action policy denied/i)

        // (c) embedded-compat DNS pre-dispatch failure preserves policy lease & monetaryCostCapMicros for retry
        await expect(embActions.executeAction(agent, {
          grantId: 'emb-rb-1',
          idempotencyKey: 't5-emb-dns-fail',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'https', host: 'nonexistent-ssrf-test.invalid', path: '/v1/allowed/ok' },
          payload: { method: 'GET', url: 'https://nonexistent-ssrf-test.invalid/v1/allowed/ok' },
          estimatedCostMicros: 900,
        }, new AbortController().signal)).rejects.toThrow(/DNS resolution failed/i)
        expect(policy.getLeaseState('lease-emb-1')?.uses ?? 0).toBe(0)

        const embOk = await embActions.executeAction(agent, {
          grantId: 'emb-rb-1',
          idempotencyKey: 't5-emb-ok',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/allowed/ok' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/allowed/ok` },
          estimatedCostMicros: 900,
        }, new AbortController().signal)
        expect(embOk.status).toBe('succeeded')
        expect(httpHits).toBe(1)
        expect(policy.getLeaseState('lease-emb-1')?.uses).toBe(1)
      } finally {
        await extPlugin.dispose()
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 15_000)

  test('T5-GAP10-01: assistant-dreaming Config and normalizeConfig reject control chars and outer whitespace across all bounded text fields', async () => {
    const ws = await workspaces.create('t5-gap10-')
    const dreamingMod = await loadAssistantDreaming()

    const valid = {
      scope: { workspace: ws.workspace, preset: 'standard', principalId: 'owner-1', ownerRouteId: 'route-1' },
      databasePath: ws.sqlitePath('dream'),
      provider: 'openai',
      model: 'gpt-4o',
      reasoningEffort: 'medium',
      budgetId: 'budget-1',
      budgetAmount: 1,
      activeHours: { timezone: 'UTC', startMinute: 60, endMinute: 120 },
    }
    expect(dreamingMod.normalizeConfig(valid).enabled).toBe(true)

    const badValues = ['\n', 'bad\nval', 'bad\x00val', 'bad\x7fval', ' primary ', '\u00a0gpt-4o\u00a0']
    const mutators: Array<(bad: string) => Record<string, unknown>> = [
      bad => ({ ...valid, scope: { ...valid.scope, workspace: `${ws.workspace}${bad}` } }),
      bad => ({ ...valid, scope: { ...valid.scope, preset: bad } }),
      bad => ({ ...valid, scope: { ...valid.scope, principalId: bad } }),
      bad => ({ ...valid, scope: { ...valid.scope, ownerRouteId: bad } }),
      bad => ({ ...valid, databasePath: `${valid.databasePath}${bad}` }),
      bad => ({ ...valid, budgetId: bad }),
      bad => ({ ...valid, provider: bad }),
      bad => ({ ...valid, model: bad }),
      bad => ({ ...valid, reasoningEffort: bad }),
      bad => ({ ...valid, activeHours: { ...valid.activeHours, timezone: bad } }),
    ]
    for (const leading of [` ${ws.workspace}`, `\u00a0${valid.databasePath}`]) {
      for (const candidate of [
        { ...valid, scope: { ...valid.scope, workspace: leading } },
        { ...valid, databasePath: leading },
      ]) {
        expect(() => dreamingMod.Config(candidate as never)).toThrow()
        expect(() => dreamingMod.normalizeConfig(candidate as never)).toThrow()
      }
    }
    for (const mutate of mutators) {
      for (const bad of badValues) {
        const candidate = mutate(bad)
        expect(() => dreamingMod.Config(candidate as never)).toThrow()
        expect(() => dreamingMod.normalizeConfig(candidate as never)).toThrow()
        expect(() => dreamingMod.normalizeConfig({ ...candidate, enabled: true } as never)).toThrow()
      }
    }
  }, 15_000)

  test('T5-WP08-03: embedded-compat shell executeAction coalesces concurrent identical-key calls (grant.lease & policy.lease maxUses=1) and rolls back policy lease on concurrent pre-dispatch ShellGuardError', async () => {
    const ws = await workspaces.create('t5-wp08-shell-race-')
    const { AssistantPolicyService } = await loadAssistantPolicy()
    const { AssistantActionsService } = await loadAssistantActions()
    const brokerMod = await loadAssistantActionsBroker()

    const now = Date.now()
    const owner = {
      principalDigest: sha256Hex('owner-t5-shell-race'),
      principalRecordId: 'owner-sr',
      principalVersion: 1,
      workspace: ws.workspace,
      preset: 'primary',
      bindingId: 'binding-sr',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const createProjection = brokerMod.createActionGrantProjection as (input: Record<string, unknown>) => unknown
    const baseGrant = {
      protocol: brokerMod.ACTION_GRANT_PROTOCOL,
      revision: 1,
      domain: 'shell',
      clientKeyId: 'host-1',
      owner,
      sessionId: 'sess-t5-shell-race',
      expiresAt: now + 60_000,
      maxActions: 10,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 10,
      client: { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 },
      source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
      destination: {
        classification: 'shell-command',
        allowedCwds: [ws.workspace],
        allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 3 }],
        allowedEnvKeys: [],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 2_048,
        maxStderrBytes: 2_048,
        allowNetwork: false,
      },
      allowedOperations: ['shell.exec'],
      credentialId: 'none',
      policyEpoch: 1,
      emergencyEpoch: 0,
    }

    const grantWithLease = createProjection({
      ...baseGrant,
      id: 't5-shell-grant-lease',
      lease: { leaseId: 'lease-t5-shell-grant', expiresAtMs: now + 60_000, maxUses: 1 },
    })
    const grantPolicyOnly = createProjection({
      ...baseGrant,
      id: 't5-shell-policy-lease',
    })
    const grantPreFail = createProjection({
      ...baseGrant,
      id: 't5-shell-prefail',
    })

    const agent = {
      id: 'agent-t5-shell-race',
      session: { id: 'sess-t5-shell-race', header: { cwd: ws.workspace, agentPreset: 'primary' } },
    }
    const ctx = harness.createContext()
    harness.provideMockService(ctx, 'assistantDelivery', {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-t5-shell-race',
        sessionId: 'sess-t5-shell-race',
        bindingId: 'binding-sr',
        bindingVersion: 1,
        bindingGeneration: 1,
        scope: { workspace: ws.workspace, preset: 'primary' },
        principalLineage: { principalRecordId: 'owner-sr', principalVersion: 1 },
      }),
    })
    harness.provideMockService(ctx, 'agents', {
      get: (id: string) => (id === 'agent-t5-shell-race' ? agent : undefined),
    })
    harness.provideMockService(ctx, 'credentialsKeychain', {})

    const policy = await harness.mountService<{
      getLeaseState: (leaseId: string) => { uses: number } | undefined
    }>(ctx, AssistantPolicyService, 'assistantPolicy', {
      databasePath: ws.sqlitePath('policy-shell-race'),
      proposalMaintenanceIntervalMs: 0,
      rules: [
        {
          id: 'rule-t5-shell-grant',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:t5-shell-grant-lease' },
          lease: { leaseId: 'lease-t5-shell-grant', expiresAtMs: now + 60_000, maxUses: 1 },
        },
        {
          id: 'rule-t5-shell-policy',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:t5-shell-policy-lease' },
          lease: { leaseId: 'lease-t5-shell-policy', expiresAtMs: now + 60_000, maxUses: 1 },
        },
        {
          id: 'rule-t5-shell-prefail',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: ws.workspace },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:t5-shell-prefail' },
          lease: { leaseId: 'lease-t5-shell-prefail', expiresAtMs: now + 60_000, maxUses: 1 },
        },
      ],
    })
    const actions = await harness.mountService<{
      executeAction: (a: unknown, input: Record<string, unknown>, sig: AbortSignal) => Promise<Record<string, unknown>>
    }>(ctx, AssistantActionsService, 'assistantActions', {
      stateRoot: join(ws.stateDir, 'actions'),
      broker: { mode: 'embedded-compat' },
      actionGrants: [grantWithLease as never, grantPolicyOnly as never, grantPreFail as never],
    })

    const countExecs = async (logName: string): Promise<number> => {
      try {
        const raw = await readFile(join(ws.workspace, logName), 'utf8')
        return raw.split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    }
    const makeShellReq = (grantId: string, idempotencyKey: string, logName: string, extraArg?: string) => ({
      grantId,
      idempotencyKey,
      domain: 'shell',
      operation: 'shell.exec',
      destination: { classification: 'shell-command', executable: process.execPath, cwd: ws.workspace },
      payload: {
        executable: process.execPath,
        args: [
          '-e',
          `require("node:fs").appendFileSync(${JSON.stringify(logName)},"1\\n");process.stdout.write("e2e-race-ok")`,
          ...(extraArg === undefined ? [] : [extraArg]),
        ],
        cwd: ws.workspace,
        timeoutMs: 3_000,
      },
    })

    // 1a. grant.lease.maxUses = 1: concurrent identical-key shell calls coalesce cleanly
    const grantReq = makeShellReq('t5-shell-grant-lease', 'e2e-idem-grant-1', 'e2e-grant.log')
    const [g1, g2] = await Promise.all([
      actions.executeAction(agent, grantReq, new AbortController().signal),
      actions.executeAction(agent, grantReq, new AbortController().signal),
    ])
    expect(g1.status).toBe('succeeded')
    expect(g2).toEqual(g1)
    expect(await countExecs('e2e-grant.log')).toBe(1)
    expect(policy.getLeaseState('lease-t5-shell-grant')?.uses).toBe(1)

    // 1b. policy.lease.maxUses = 1 (without grant.lease): concurrent identical-key shell calls execute once
    const policyReq = makeShellReq('t5-shell-policy-lease', 'e2e-idem-policy-1', 'e2e-policy.log')
    const [p1, p2] = await Promise.all([
      actions.executeAction(agent, policyReq, new AbortController().signal),
      actions.executeAction(agent, policyReq, new AbortController().signal),
    ])
    expect(p1.status).toBe('succeeded')
    expect(p2).toEqual(p1)
    expect(await countExecs('e2e-policy.log')).toBe(1)
    expect(policy.getLeaseState('lease-t5-shell-policy')?.uses).toBe(1)

    // 2. Concurrent identical-key pre-dispatch ShellGuardError failures roll back policy lease cleanly
    const failReq = makeShellReq('t5-shell-prefail', 'e2e-idem-prefail-1', 'e2e-prefail.log', 'ghp_12345678901234567890')
    const failRace = await Promise.allSettled([
      actions.executeAction(agent, failReq, new AbortController().signal),
      actions.executeAction(agent, failReq, new AbortController().signal),
    ])
    expect(failRace[0].status).toBe('rejected')
    expect(failRace[1].status).toBe('rejected')
    expect((failRace[0] as PromiseRejectedResult).reason).toMatchObject({ name: 'ShellGuardError', dispatched: false })
    expect((failRace[1] as PromiseRejectedResult).reason).toMatchObject({ name: 'ShellGuardError', dispatched: false })
    expect(await countExecs('e2e-prefail.log')).toBe(0)
    expect(policy.getLeaseState('lease-t5-shell-prefail')?.uses ?? 0).toBe(0)

    const retryOk = await actions.executeAction(
      agent,
      makeShellReq('t5-shell-prefail', 'e2e-idem-prefail-2', 'e2e-prefail.log'),
      new AbortController().signal,
    )
    expect(retryOk.status).toBe('succeeded')
    expect(await countExecs('e2e-prefail.log')).toBe(1)
    expect(policy.getLeaseState('lease-t5-shell-prefail')?.uses).toBe(1)
  }, 15_000)
})
